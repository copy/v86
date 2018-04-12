#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const encodings = require("./x86_table");
const c_ast = require("./c_ast");
const { hex, mkdirpSync, get_switch_value, get_switch_exist, finalize_table } = require("./util");

const APPEND_NONFAULTING_FLAG = "analysis.flags |= JIT_INSTR_NONFAULTING_FLAG;";

const OUT_DIR = get_switch_value("--output-dir") || path.join(__dirname, "..", "build");

mkdirpSync(OUT_DIR);

const table_arg = get_switch_value("--table");
const gen_all = get_switch_exist("--all");
const to_generate = {
    analyzer: gen_all || table_arg === "analyzer",
    analyzer0f_16: gen_all || table_arg === "analyzer0f_16",
    analyzer0f_32: gen_all || table_arg === "analyzer0f_32",
};

console.assert(
    Object.keys(to_generate).some(k => to_generate[k]),
    "Pass --table [analyzer|analyzer0f_16|analyzer0f_32] or --all to pick which tables to generate"
);

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

function gen_codegen_call(args)
{
    return args.map(arg => arg + ";");
}

function gen_codegen_call_modrm(args)
{
    args = args.map(arg => arg + ";");
    return [].concat(gen_call("modrm_skip", ["modrm_byte"]), args);
}

function gen_modrm_mem_reg_split(mem_args, reg_args, postfixes={})
{
    const { mem_postfix=[], reg_postfix=[] } = postfixes;

    return {
        type: "if-else",
        if_blocks: [{
            condition: "modrm_byte < 0xC0",
            body: []
                .concat(gen_codegen_call_modrm(mem_args))
                .concat(mem_postfix),
        }],
        else_block: {
            body: gen_codegen_call(reg_args).concat(reg_postfix),
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

function get_nonfaulting_mem_reg_postfix(encoding)
{
    const lea_special_case = encoding.opcode === 0x8D;
    const mem_postfix = (encoding.nonfaulting && lea_special_case) ? [APPEND_NONFAULTING_FLAG] : [];
    const reg_postfix = (encoding.nonfaulting && !lea_special_case) ? [APPEND_NONFAULTING_FLAG] : [];

    return {
        mem_postfix,
        reg_postfix,
    };
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
    }

    const instruction_postfix = encoding.block_boundary ? ["analysis.flags |= JIT_INSTR_BLOCK_BOUNDARY_FLAG;"] : [];

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
                    const instruction_postfix = case_.block_boundary ? ["analysis.flags |=  JIT_INSTR_BLOCK_BOUNDARY_FLAG;"] : [];

                    const mem_args = [];
                    const reg_args = [];

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
                            const body = [gen_modrm_mem_reg_split(mem_args, reg_args, {})];
                            if_blocks.push({ condition: "prefixes_ & PREFIX_66", body, });
                        }
                        if(has_F2) {
                            const name = make_instruction_name(case_, size, 0xF2);
                            const body = [gen_modrm_mem_reg_split(mem_args, reg_args, {})];
                            if_blocks.push({ condition: "prefixes_ & PREFIX_F2", body, });
                        }
                        if(has_F3) {
                            const name = make_instruction_name(case_, size, 0xF3);
                            const body = [gen_modrm_mem_reg_split(mem_args, reg_args, {})];
                            if_blocks.push({ condition: "prefixes_ & PREFIX_F3", body, });
                        }

                        const else_block = {
                            body: [
                                gen_modrm_mem_reg_split(
                                    mem_args,
                                    reg_args,
                                    {}
                                )
                            ],
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
                            gen_modrm_mem_reg_split(
                                mem_args,
                                reg_args,
                                get_nonfaulting_mem_reg_postfix(case_)
                            )
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
                        "analysis.flags |= JIT_INSTR_BLOCK_BOUNDARY_FLAG;",
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

        const imm_read = gen_read_imm_call(encoding, size);

        const mem_args = [];
        const reg_args = [];

        if(imm_read)
        {
            mem_args.push(imm_read);
            reg_args.push(imm_read);
        }

        const if_blocks = [];

        if(has_66) {
            const body = [gen_modrm_mem_reg_split(mem_args, reg_args, {})];
            if_blocks.push({ condition: "prefixes_ & PREFIX_66", body, });
        }
        if(has_F2) {
            const body = [gen_modrm_mem_reg_split(mem_args, reg_args, {})];
            if_blocks.push({ condition: "prefixes_ & PREFIX_F2", body, });
        }
        if(has_F3) {
            const body = [gen_modrm_mem_reg_split(mem_args, reg_args, {})];
            if_blocks.push({ condition: "prefixes_ & PREFIX_F3", body, });
        }

        const else_block = {
            body: [
                gen_modrm_mem_reg_split(
                    mem_args,
                    reg_args,
                    {}
                )
            ],
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

        const imm_read = gen_read_imm_call(encoding, size);

        if(encoding.ignore_mod)
        {
            console.assert(!imm_read, "Unexpected instruction (ignore mod with immediate value)");

            // Has modrm byte, but the 2 mod bits are ignored and both
            // operands are always registers (0f20-0f24)

            if(encoding.nonfaulting)
            {
                instruction_postfix.push(APPEND_NONFAULTING_FLAG);
            }

            return ["int32_t modrm_byte = read_imm8();"]
                .concat(gen_codegen_call([]))
                .concat(instruction_postfix);
        }
        else
        {
            const mem_args = [];
            const reg_args = [];

            if(imm_read)
            {
                mem_args.push(imm_read);
                reg_args.push(imm_read);
            }

            return [
                "int32_t modrm_byte = read_imm8();",
                gen_modrm_mem_reg_split(
                    mem_args,
                    reg_args,
                    get_nonfaulting_mem_reg_postfix(encoding)
                ),
            ].concat(instruction_postfix);
        }
    }
    else if(encoding.prefix)
    {
        console.assert(!encoding.nonfaulting, "Prefix/custom instructions cannot be marked as nonfaulting.");

        const instruction_name = make_instruction_name(encoding, size) + "_analyze";
        const imm_read = gen_read_imm_call(encoding, size);
        const args = [];

        if(imm_read)
        {
            args.push(imm_read);
        }

        const call_prefix = encoding.prefix ? "return " : "";
        // Prefix calls can add to the return flags
        return [call_prefix + gen_call(instruction_name, args)].concat(instruction_postfix);
    }
    else
    {
        // instruction without modrm byte or prefix

        const imm_read = gen_read_imm_call(encoding, size);

        const args = [];

        if(imm_read)
        {
            if(encoding.jump_offset_imm)
            {
                args.push("int32_t jump_offset = " + imm_read + ";");
                args.push("analysis.jump_offset = jump_offset;");
                args.push("analysis.flags |= is_osize_32() ? JIT_INSTR_IMM_JUMP32_FLAG : JIT_INSTR_IMM_JUMP16_FLAG;");
            }
            else
            {
                args.push(imm_read + ";");
            }
        }

        if(encoding.extra_imm16)
        {
            console.assert(imm_read);
            args.push(gen_call("read_imm16"));
        }
        else if(encoding.extra_imm8)
        {
            console.assert(imm_read);
            args.push(gen_call("read_imm8"));
        }

        if(encoding.nonfaulting)
        {
            instruction_postfix.push(APPEND_NONFAULTING_FLAG);
        }

        if(encoding.conditional_jump)
        {
            console.assert((encoding.opcode & ~0xF) === 0x70 || (encoding.opcode & ~0xF) === 0x0F80);
            instruction_postfix.push("analysis.condition_index = " + (encoding.opcode & 0xF) + ";");
        }

        return args.concat(instruction_postfix);
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

    if(to_generate.analyzer)
    {
        finalize_table(
            OUT_DIR,
            "analyzer",
            c_ast.print_syntax_tree([table]).join("\n") + "\n"
        );
    }

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

    if(to_generate.analyzer0f_16)
    {
        finalize_table(
            OUT_DIR,
            "analyzer0f_16",
            c_ast.print_syntax_tree([table0f_16]).join("\n") + "\n"
        );
    }

    if(to_generate.analyzer0f_32)
    {
        finalize_table(
            OUT_DIR,
            "analyzer0f_32",
            c_ast.print_syntax_tree([table0f_32]).join("\n") + "\n"
        );
    }
}
