#!/usr/bin/env node
"use strict";

const fs = require("fs");
const encodings = require("./x86_table");
const c_ast = require("./c_ast");
const { hex } = require("./util");

const APPEND_NONFAULTING_FLAG = "flags |= JIT_INSTR_NONFAULTING_FLAG;";

gen_table();


function gen_read_imm_call(op, size_variant)
{
    let size = (op.os || op.opcode % 2 === 1) ? size_variant : 8;

    if(op.imm8 || op.imm8s || op.imm16 || op.imm1632 || op.imm32 || op.immaddr)
    {
        if(op.imm8)
        {
            return "read_imm8()";
        }
        else if(op.imm8s)
        {
            return "read_imm8s()";
        }
        else
        {
            if(op.immaddr)
            {
                // immaddr: depends on address size
                return "read_moffs()";
            }
            else
            {
                console.assert(op.imm1632 || op.imm16 || op.imm32);

                if(op.imm1632 && size === 16 || op.imm16)
                {
                    return "read_imm16()";
                }
                else
                {
                    console.assert(op.imm1632 && size === 32 || op.imm32);
                    return "read_imm32s()";
                }
            }
        }
    }
    else
    {
        return undefined;
    }
}

function gen_call(name, args)
{
    args = args || [];
    return `${name}(${args.join(", ")});`;
}

function gen_codegen_call(name, args)
{
    args = args || [];
    const args_count = args.length;
    args = [].concat([`"${name}"`, name.length], args);
    return gen_call(`gen_fn${args_count}`, args);
}

function gen_codegen_call_modrm(name, args, is_cb)
{
    args = (args || []).slice();
    const args_count = args.length - 1; // minus 1 for the modrm_byte
    args = [].concat([`"${name}"`, name.length], args);
    return gen_call(`gen_modrm${is_cb ? "_cb" : ""}_fn${args_count}`, args);
}

function gen_modrm_mem_reg_split(name, mem_prefix_call, mem_args, reg_args, encoding)
{
    let cb = false;

    if(mem_args[mem_args.length-1].endsWith("()"))
    {
        cb = true;
        mem_args = mem_args.slice();
        mem_args[mem_args.length-1] = mem_args[mem_args.length-1].replace("()", "");
    }

    const lea_special_case = encoding.opcode === 0x8D;
    const mem_postfix = (encoding.nonfaulting && lea_special_case) ? [APPEND_NONFAULTING_FLAG] : [];
    const reg_postfix = (encoding.nonfaulting && !lea_special_case) ? [APPEND_NONFAULTING_FLAG] : [];

    return {
        type: "if-else",
        if_blocks: [{
            condition: "modrm_byte < 0xC0",
            body: (mem_prefix_call ? [mem_prefix_call] : [])
                .concat([gen_codegen_call_modrm(`${name}_mem`, mem_args, cb)])
                .concat(mem_postfix),
        }],
        else_block: {
            body: [
                gen_codegen_call(`${name}_reg`, reg_args)
            ].concat(reg_postfix),
        },
    };
}

/*
 * Current naming scheme:
 * instr(16|32|)_((66|F2|F3)?0F)?[0-9a-f]{2}(_[0-7])?(_mem|_reg|)
 */

function make_instruction_name(encoding, size, prefix_variant)
{
    const suffix = encoding.os ? String(size) : "";
    const opcode_hex = hex(encoding.opcode & 0xFF, 2);
    const prefix_0f = (encoding.opcode & 0xFF00) === 0x0F00 ? "0F" : "";
    const prefix = prefix_variant === undefined ? "" : hex(prefix_variant, 2);
    const fixed_g_suffix = encoding.fixed_g === undefined ? "" : `_${encoding.fixed_g}`;

    return `instr${suffix}_${prefix}${prefix_0f}${opcode_hex}${fixed_g_suffix}`;
}

function gen_instruction_body(encodings, size)
{
    const encoding = encodings[0];

    let has_66 = false;
    let has_F2 = false;
    let has_F3 = false;

    for(let e of encodings)
    {
        if((e.opcode >>> 16) === 0x66) has_66 = true;
        if((e.opcode >>> 16) === 0xF2) has_F2 = true;
        if((e.opcode >>> 16) === 0xF3) has_F3 = true;
    }

    if(has_66 || has_F2 || has_F3)
    {
        console.assert((encoding.opcode & 0xFF00) === 0x0F00);
        // Leaving unsupported because:
        // 1. Instructions that use these prefixes are usually faulting
        // 2. It would need a refactor to allow us to pass the correct prefixed encoding object to
        // where the nonfaulting flags are set
        console.assert(
            !encodings.some(e => e.nonfaulting),
            "Unsupported: instruction with 66/f2/f3 prefix marked as nonfaulting. Opcode: 0x" + hex(encoding.opcode)
        );
    }

    const instruction_postfix = encoding.jump ? ["flags |= JIT_INSTR_JUMP_FLAG;"] : [];

    if(encoding.fixed_g !== undefined)
    {
        // instruction with modrm byte where the middle 3 bits encode the instruction

        // group by opcode without prefix plus middle bits of modrm byte
        let cases = encodings.reduce((cases_by_opcode, case_) => {
            console.assert(typeof case_.fixed_g === "number");
            cases_by_opcode[case_.opcode & 0xFFFF | case_.fixed_g << 16] = case_;
            return cases_by_opcode;
        }, Object.create(null));
        cases = Object.values(cases).sort((e1, e2) => e1.fixed_g - e2.fixed_g);

        return [
            "int32_t modrm_byte = read_imm8();",
            {
                type: "switch",
                condition: "modrm_byte >> 3 & 7",
                cases: cases.map(case_ => {
                    const fixed_g = case_.fixed_g;
                    const instruction_name = make_instruction_name(case_, size, undefined);
                    const instruction_postfix = case_.jump ? ["flags |=  JIT_INSTR_JUMP_FLAG;"] : [];

                    let modrm_resolve_prefix = undefined;

                    if(case_.requires_prefix_call)
                    {
                        modrm_resolve_prefix = gen_codegen_call(instruction_name + "_mem_pre");
                    }

                    const mem_args = ["modrm_byte"];
                    const reg_args = ["modrm_byte & 7"];

                    const imm_read = gen_read_imm_call(case_, size);
                    if(imm_read)
                    {
                        mem_args.push(imm_read);
                        reg_args.push(imm_read);
                    }

                    if(has_66 || has_F2 || has_F3)
                    {
                        const if_blocks = [];

                        if(has_66) {
                            const name = make_instruction_name(case_, size, 0x66);
                            const body = [gen_modrm_mem_reg_split(name, modrm_resolve_prefix, mem_args, reg_args, case_)];
                            if_blocks.push({ condition: "prefixes_ & PREFIX_66", body, });
                        }
                        if(has_F2) {
                            const name = make_instruction_name(case_, size, 0xF2);
                            const body = [gen_modrm_mem_reg_split(name, modrm_resolve_prefix, mem_args, reg_args, case_)];
                            if_blocks.push({ condition: "prefixes_ & PREFIX_F2", body, });
                        }
                        if(has_F3) {
                            const name = make_instruction_name(case_, size, 0xF3);
                            const body = [gen_modrm_mem_reg_split(name, modrm_resolve_prefix, mem_args, reg_args, case_)];
                            if_blocks.push({ condition: "prefixes_ & PREFIX_F3", body, });
                        }

                        const else_block = {
                            body: [gen_modrm_mem_reg_split(instruction_name, modrm_resolve_prefix, mem_args, reg_args, case_)],
                        };

                        return {
                            conditions: [fixed_g],
                            body: [
                                "int32_t prefixes_ = *prefixes;",
                                {
                                    type: "if-else",
                                    if_blocks,
                                    else_block,
                                },
                            ].concat(instruction_postfix),
                        };
                    }
                    else
                    {
                        const body = [
                            gen_modrm_mem_reg_split(instruction_name, modrm_resolve_prefix, mem_args, reg_args, case_)
                        ].concat(instruction_postfix);

                        return {
                            conditions: [fixed_g],
                            body,
                        };
                    }
                }),

                default_case: {
                    body: [
                        "assert(false);",
                        "trigger_ud();",
                    ],
                }
            },
        ].concat(instruction_postfix);
    }
    else if(has_66 || has_F2 || has_F3)
    {
        // instruction without modrm byte but with prefix

        console.assert(encoding.e);
        console.assert(!encoding.ignore_mod);
        console.assert(!encoding.requires_prefix_call, "Unexpected instruction (66/f2/f3 with prefix call)");

        const imm_read = gen_read_imm_call(encoding, size);
        const modrm_resolve_prefix = undefined;

        const mem_args = ["modrm_byte", "modrm_byte >> 3 & 7"];
        const reg_args = ["modrm_byte & 7", "modrm_byte >> 3 & 7"];

        if(imm_read)
        {
            mem_args.push(imm_read);
            reg_args.push(imm_read);
        }

        const if_blocks = [];

        if(has_66) {
            const name = make_instruction_name(encoding, size, 0x66);
            const body = [gen_modrm_mem_reg_split(name, modrm_resolve_prefix, mem_args, reg_args, encoding)];
            if_blocks.push({ condition: "prefixes_ & PREFIX_66", body, });
        }
        if(has_F2) {
            const name = make_instruction_name(encoding, size, 0xF2);
            const body = [gen_modrm_mem_reg_split(name, modrm_resolve_prefix, mem_args, reg_args, encoding)];
            if_blocks.push({ condition: "prefixes_ & PREFIX_F2", body, });
        }
        if(has_F3) {
            const name = make_instruction_name(encoding, size, 0xF3);
            const body = [gen_modrm_mem_reg_split(name, modrm_resolve_prefix, mem_args, reg_args, encoding)];
            if_blocks.push({ condition: "prefixes_ & PREFIX_F3", body, });
        }

        const else_block = {
            body: [gen_modrm_mem_reg_split(make_instruction_name(encoding, size), modrm_resolve_prefix, mem_args, reg_args, encoding)],
        };

        return [
            "int32_t modrm_byte = read_imm8();",
            "int32_t prefixes_ = *prefixes;",
            {
                type: "if-else",
                if_blocks,
                else_block,
            }
        ].concat(instruction_postfix);
    }
    else if(encoding.fixed_g === undefined && encoding.e)
    {
        // instruction with modrm byte where the middle 3 bits encode a register

        console.assert(encodings.length === 1);

        const instruction_name = make_instruction_name(encoding, size);
        const imm_read = gen_read_imm_call(encoding, size);

        if(encoding.ignore_mod)
        {
            console.assert(!imm_read, "Unexpected instruction (ignore mod with immediate value)");
            console.assert(!encoding.requires_prefix_call);

            // Has modrm byte, but the 2 mod bits are ignored and both
            // operands are always registers (0f20-0f24)

            return [
                "int32_t modrm_byte = read_imm8();",
                gen_codegen_call(instruction_name, ["modrm_byte & 7", "modrm_byte >> 3 & 7"]),
                encoding.nonfaulting ? APPEND_NONFAULTING_FLAG : "",
            ].concat(instruction_postfix);
        }
        else
        {
            let modrm_resolve_prefix = undefined;

            if(encoding.requires_prefix_call)
            {
                modrm_resolve_prefix = gen_codegen_call(instruction_name + "_mem_pre");
            }

            const mem_args = ["modrm_byte", "modrm_byte >> 3 & 7"];
            const reg_args = ["modrm_byte & 7", "modrm_byte >> 3 & 7"];

            if(imm_read)
            {
                mem_args.push(imm_read);
                reg_args.push(imm_read);
            }

            return [
                "int32_t modrm_byte = read_imm8();",
                gen_modrm_mem_reg_split(instruction_name, modrm_resolve_prefix, mem_args, reg_args, encoding),
            ].concat(instruction_postfix);
        }
    }
    else if(encoding.prefix || encoding.custom)
    {
        console.assert(!encoding.nonfaulting, "Prefix/custom instructions cannot be marked as nonfaulting.");

        const instruction_name = make_instruction_name(encoding, size) + "_jit";
        const imm_read = gen_read_imm_call(encoding, size);
        const args = [];

        if(imm_read)
        {
            args.push(imm_read);
        }

        const call_prefix = encoding.prefix ? "flags |= " : "";
        // Prefix calls can add to the return flags
        return [call_prefix + gen_call(instruction_name, args)].concat(instruction_postfix);
    }
    else
    {
        // instruction without modrm byte or prefix

        const imm_read = gen_read_imm_call(encoding, size);
        const instruction_name = make_instruction_name(encoding, size);

        const args = [];

        if(imm_read)
        {
            args.push(imm_read);
        }

        if(encoding.extra_imm16)
        {
            console.assert(imm_read);
            args.push("read_imm16()");
        }
        else if(encoding.extra_imm8)
        {
            console.assert(imm_read);
            args.push("read_imm8()");
        }

        if(encoding.nonfaulting)
        {
            instruction_postfix.push(APPEND_NONFAULTING_FLAG);
        }

        return [gen_codegen_call(instruction_name, args)].concat(instruction_postfix);
    }
}

function gen_table()
{
    let by_opcode = Object.create(null);
    let by_opcode0f = Object.create(null);

    for(let o of encodings)
    {
        let opcode = o.opcode;

        if(opcode >= 0x100)
        {
            if((opcode & 0xFF00) === 0x0F00)
            {
                opcode &= 0xFF;
                by_opcode0f[opcode] = by_opcode0f[opcode] || [];
                by_opcode0f[opcode].push(o);
            }
        }
        else
        {
            by_opcode[opcode] = by_opcode[opcode] || [];
            by_opcode[opcode].push(o);
        }
    }

    let cases = [];
    for(let opcode = 0; opcode < 0x100; opcode++)
    {
        let encoding = by_opcode[opcode];
        console.assert(encoding && encoding.length);

        let opcode_hex = hex(opcode, 2);

        if(encoding[0].os)
        {
            cases.push({
                conditions: [`0x${opcode_hex}`],
                body: gen_instruction_body(encoding, 16),
            });
            cases.push({
                conditions: [`0x${opcode_hex}|0x100`],
                body: gen_instruction_body(encoding, 32),
            });
        }
        else
        {
            cases.push({
                conditions: [`0x${opcode_hex}`, `0x${opcode_hex}|0x100`],
                body: gen_instruction_body(encoding, undefined),
            });
        }
    }
    const table = {
        type: "switch",
        condition: "opcode",
        cases,
        default_case: {
            body: ["assert(false);"]
        },
    };
    fs.writeFileSync("/tmp/jit", c_ast.print_syntax_tree([table]).join("\n") + "\n");

    const cases0f_16 = [];
    const cases0f_32 = [];
    for(let opcode = 0; opcode < 0x100; opcode++)
    {
        let encoding = by_opcode0f[opcode];

        if(!encoding)
        {
            encoding = [
                {
                    opcode: 0x0F00 | opcode,
                },
            ];
        }

        console.assert(encoding && encoding.length);

        let opcode_hex = hex(opcode, 2);

        if(encoding[0].os)
        {
            cases0f_16.push({
                conditions: [`0x${opcode_hex}`],
                body: gen_instruction_body(encoding, 16),
            });
            cases0f_32.push({
                conditions: [`0x${opcode_hex}`],
                body: gen_instruction_body(encoding, 32),
            });
        }
        else
        {
            let block = {
                conditions: [`0x${opcode_hex}`],
                body: gen_instruction_body(encoding, undefined),
            };
            cases0f_16.push(block);
            cases0f_32.push(block);
        }
    }

    const table0f_16 = {
        type: "switch",
        condition: "opcode",
        cases: cases0f_16,
        default_case: {
            body: ["assert(false);"]
        },
    };
    const table0f_32 = {
        type: "switch",
        condition: "opcode",
        cases: cases0f_32,
        default_case: {
            body: ["assert(false);"]
        },
    };
    fs.writeFileSync("/tmp/jit0f_16", c_ast.print_syntax_tree([table0f_16]).join("\n") + "\n");
    fs.writeFileSync("/tmp/jit0f_32", c_ast.print_syntax_tree([table0f_32]).join("\n") + "\n");
}
