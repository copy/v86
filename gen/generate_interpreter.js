#!/usr/bin/env node


import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import x86_table from "./x86_table.js";
import * as rust_ast from "./rust_ast.js";
import { hex, get_switch_value, get_switch_exist, finalize_table_rust } from "./util.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "src/rust/gen/");

fs.mkdirSync(OUT_DIR, { recursive: true });

const table_arg = get_switch_value("--table");
const gen_all = get_switch_exist("--all");
const to_generate = {
    interpreter: gen_all || table_arg === "interpreter",
    interpreter0f: gen_all || table_arg === "interpreter0f",
};

assert(
    Object.keys(to_generate).some(k => to_generate[k]),
    "Pass --table [interpreter|interpreter0f] or --all to pick which tables to generate"
);

gen_table();

function wrap_imm_call(imm)
{
    return `match ${imm} { Ok(o) => o, Err(()) => return }`;
}

function gen_read_imm_call(op, size_variant)
{
    let size = (op.os || op.opcode % 2 === 1) ? size_variant : 8;

    if(op.imm8 || op.imm8s || op.imm16 || op.imm1632 || op.imm32 || op.immaddr)
    {
        if(op.imm8)
        {
            return wrap_imm_call("read_imm8()");
        }
        else if(op.imm8s)
        {
            return wrap_imm_call("read_imm8s()");
        }
        else
        {
            if(op.immaddr)
            {
                // immaddr: depends on address size
                return wrap_imm_call("read_moffs()");
            }
            else
            {
                assert(op.imm1632 || op.imm16 || op.imm32);

                if(op.imm1632 && size === 16 || op.imm16)
                {
                    return wrap_imm_call("read_imm16()");
                }
                else
                {
                    assert(op.imm1632 && size === 32 || op.imm32);
                    return wrap_imm_call("read_imm32s()");
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

/*
 * Current naming scheme:
 * instr(16|32|)_(66|F2|F3)?0F?[0-9a-f]{2}(_[0-7])?(_mem|_reg|)
 */
function make_instruction_name(encoding, size)
{
    const suffix = encoding.os ? String(size) : "";
    const opcode_hex = hex(encoding.opcode & 0xFF, 2);
    const first_prefix = (encoding.opcode & 0xFF00) === 0 ? "" : hex(encoding.opcode >> 8 & 0xFF, 2);
    const second_prefix = (encoding.opcode & 0xFF0000) === 0 ? "" : hex(encoding.opcode >> 16 & 0xFF, 2);
    const fixed_g_suffix = encoding.fixed_g === undefined ? "" : `_${encoding.fixed_g}`;
    const module = first_prefix === "0F" || second_prefix === "0F" ? "instructions_0f" : "instructions";

    assert(first_prefix === "" || first_prefix === "0F" || first_prefix === "F2" || first_prefix === "F3");
    assert(second_prefix === "" || second_prefix === "66" || second_prefix === "F2" || second_prefix === "F3");

    return `${module}::instr${suffix}_${second_prefix}${first_prefix}${opcode_hex}${fixed_g_suffix}`;
}

function gen_instruction_body(encodings, size)
{
    const encoding = encodings[0];

    let has_66 = [];
    let has_F2 = [];
    let has_F3 = [];
    let no_prefix = [];

    for(let e of encodings)
    {
        if((e.opcode >>> 16) === 0x66) has_66.push(e);
        else if((e.opcode >>> 8 & 0xFF) === 0xF2 || (e.opcode >>> 16) === 0xF2) has_F2.push(e);
        else if((e.opcode >>> 8 & 0xFF) === 0xF3 || (e.opcode >>> 16) === 0xF3) has_F3.push(e);
        else no_prefix.push(e);
    }

    if(has_F2.length || has_F3.length)
    {
        assert((encoding.opcode & 0xFF0000) === 0 || (encoding.opcode & 0xFF00) === 0x0F00);
    }

    if(has_66.length)
    {
        assert((encoding.opcode & 0xFF00) === 0x0F00);
    }

    const code = [];

    if(encoding.e)
    {
        code.push(`let modrm_byte = ${wrap_imm_call("read_imm8()")};`);
    }

    if(has_66.length || has_F2.length || has_F3.length)
    {
        const if_blocks = [];

        if(has_66.length) {
            const body = gen_instruction_body_after_prefix(has_66, size);
            if_blocks.push({ condition: "prefixes_ & prefix::PREFIX_66 != 0", body, });
        }
        if(has_F2.length) {
            const body = gen_instruction_body_after_prefix(has_F2, size);
            if_blocks.push({ condition: "prefixes_ & prefix::PREFIX_F2 != 0", body, });
        }
        if(has_F3.length) {
            const body = gen_instruction_body_after_prefix(has_F3, size);
            if_blocks.push({ condition: "prefixes_ & prefix::PREFIX_F3 != 0", body, });
        }

        const check_prefixes = encoding.sse ? "(prefix::PREFIX_66 | prefix::PREFIX_F2 | prefix::PREFIX_F3)" : "(prefix::PREFIX_F2 | prefix::PREFIX_F3)";

        const else_block = {
            body: [].concat(
                "dbg_assert!((prefixes_ & " + check_prefixes + ") == 0);",
                gen_instruction_body_after_prefix(no_prefix, size)
            )
        };

        return [].concat(
            "let prefixes_ = *prefixes;",
            code,
            {
                type: "if-else",
                if_blocks,
                else_block,
            }
        );
    }
    else {
        return [].concat(
            code,
            gen_instruction_body_after_prefix(encodings, size)
        );
    }
}

function gen_instruction_body_after_prefix(encodings, size)
{
    const encoding = encodings[0];

    if(encoding.fixed_g !== undefined)
    {
        assert(encoding.e);

        // instruction with modrm byte where the middle 3 bits encode the instruction

        // group by opcode without prefix plus middle bits of modrm byte
        let cases = encodings.reduce((cases_by_opcode, case_) => {
            assert(typeof case_.fixed_g === "number");
            cases_by_opcode[case_.opcode & 0xFFFF | case_.fixed_g << 16] = case_;
            return cases_by_opcode;
        }, Object.create(null));
        cases = Object.values(cases).sort((e1, e2) => e1.fixed_g - e2.fixed_g);

        return [
            {
                type: "switch",
                condition: "modrm_byte >> 3 & 7",
                cases: cases.map(case_ => {
                    const fixed_g = case_.fixed_g;
                    const body = gen_instruction_body_after_fixed_g(case_, size);

                    return {
                        conditions: [fixed_g],
                        body,
                    };
                }),

                default_case: {
                    varname: "x",
                    body: [
                        `dbg_log!("#ud ${encoding.opcode.toString(16).toUpperCase()}/{} at {:x}", x, *instruction_pointer);`,
                        "trigger_ud();",
                    ],
                }
            },
        ];
    }
    else {
        assert(encodings.length === 1);
        return gen_instruction_body_after_fixed_g(encodings[0], size);
    }
}

function gen_instruction_body_after_fixed_g(encoding, size)
{
    const instruction_prefix = [];
    const instruction_postfix =
        (encoding.block_boundary && !encoding.no_block_boundary_in_interpreted) ||
        (!encoding.custom && encoding.e) ?
        ["after_block_boundary();"] : [];

    if(encoding.task_switch_test || encoding.sse)
    {
        instruction_prefix.push(
            {
                type: "if-else",
                if_blocks: [
                    {
                        condition: encoding.sse ? "!task_switch_test_mmx()" : "!task_switch_test()",
                        body: ["return;"],
                    }
                ],
            });
    }

    const imm_read = gen_read_imm_call(encoding, size);
    const instruction_name = make_instruction_name(encoding, size);

    if(encoding.e)
    {
        // instruction with modrm byte

        const imm_read = gen_read_imm_call(encoding, size);

        if(encoding.ignore_mod)
        {
            assert(!imm_read, "Unexpected instruction (ignore mod with immediate value)");

            // Has modrm byte, but the 2 mod bits are ignored and both
            // operands are always registers (0f20-0f24)

            return [].concat(
                instruction_prefix,
                gen_call(instruction_name, ["modrm_byte & 7", "modrm_byte >> 3 & 7"]),
                instruction_postfix
            );
        }
        else
        {
            let mem_args;

            if(encoding.custom_modrm_resolve)
            {
                // requires special handling around modrm_resolve
                mem_args = ["modrm_byte"];
            }
            else
            {
                mem_args = ["match modrm_resolve(modrm_byte) { Ok(a) => a, Err(()) => return }"];
            }

            const reg_args = ["modrm_byte & 7"];

            if(encoding.fixed_g === undefined)
            {
                mem_args.push("modrm_byte >> 3 & 7");
                reg_args.push("modrm_byte >> 3 & 7");
            }

            if(imm_read)
            {
                mem_args.push(imm_read);
                reg_args.push(imm_read);
            }

            return [].concat(
                instruction_prefix,
                {
                    type: "if-else",
                    if_blocks: [
                        {
                            condition: "modrm_byte < 0xC0",
                            body: [].concat(
                                gen_call(`${instruction_name}_mem`, mem_args)
                            ),
                        }
                    ],
                    else_block: {
                        body: [gen_call(`${instruction_name}_reg`, reg_args)],
                    },
                },
                instruction_postfix
            );
        }
    }
    else
    {
        const args = [];

        if(imm_read)
        {
            args.push(imm_read);
        }

        if(encoding.extra_imm16)
        {
            assert(imm_read);
            args.push(wrap_imm_call("read_imm16()"));
        }
        else if(encoding.extra_imm8)
        {
            assert(imm_read);
            args.push(wrap_imm_call("read_imm8()"));
        }

        return [].concat(
            instruction_prefix,
            gen_call(instruction_name, args),
            instruction_postfix
        );
    }
}

function gen_table()
{
    let by_opcode = Object.create(null);
    let by_opcode0f = Object.create(null);

    for(let o of x86_table)
    {
        let opcode = o.opcode;

        if((opcode & 0xFF00) === 0x0F00)
        {
            opcode &= 0xFF;
            by_opcode0f[opcode] = by_opcode0f[opcode] || [];
            by_opcode0f[opcode].push(o);
        }
        else
        {
            opcode &= 0xFF;
            by_opcode[opcode] = by_opcode[opcode] || [];
            by_opcode[opcode].push(o);
        }
    }

    let cases = [];
    for(let opcode = 0; opcode < 0x100; opcode++)
    {
        let encoding = by_opcode[opcode];
        assert(encoding && encoding.length);

        let opcode_hex = hex(opcode, 2);
        let opcode_high_hex = hex(opcode | 0x100, 2);

        if(encoding[0].os)
        {
            cases.push({
                conditions: [`0x${opcode_hex}`],
                body: gen_instruction_body(encoding, 16),
            });
            cases.push({
                conditions: [`0x${opcode_high_hex}`],
                body: gen_instruction_body(encoding, 32),
            });
        }
        else
        {
            cases.push({
                conditions: [`0x${opcode_hex}`, `0x${opcode_high_hex}`],
                body: gen_instruction_body(encoding, undefined),
            });
        }
    }
    const table = {
        type: "switch",
        condition: "opcode",
        cases,
        default_case: {
            body: ["assert!(false);"]
        },
    };
    if(to_generate.interpreter)
    {
        const code = [
            "#![cfg_attr(rustfmt, rustfmt_skip)]",

            "use crate::cpu::cpu::{after_block_boundary, modrm_resolve};",
            "use crate::cpu::cpu::{read_imm8, read_imm8s, read_imm16, read_imm32s, read_moffs};",
            "use crate::cpu::cpu::{task_switch_test, trigger_ud};",
            "use crate::cpu::instructions;",
            "use crate::cpu::global_pointers::{instruction_pointer, prefixes};",
            "use crate::prefix;",

            "pub unsafe fn run(opcode: u32) {",
            table,
            "}",
        ];

        finalize_table_rust(
            OUT_DIR,
            "interpreter.rs",
            rust_ast.print_syntax_tree([].concat(code)).join("\n") + "\n"
        );
    }

    const cases0f = [];
    for(let opcode = 0; opcode < 0x100; opcode++)
    {
        let encoding = by_opcode0f[opcode];

        assert(encoding && encoding.length);

        let opcode_hex = hex(opcode, 2);
        let opcode_high_hex = hex(opcode | 0x100, 2);

        if(encoding[0].os)
        {
            cases0f.push({
                conditions: [`0x${opcode_hex}`],
                body: gen_instruction_body(encoding, 16),
            });
            cases0f.push({
                conditions: [`0x${opcode_high_hex}`],
                body: gen_instruction_body(encoding, 32),
            });
        }
        else
        {
            let block = {
                conditions: [`0x${opcode_hex}`, `0x${opcode_high_hex}`],
                body: gen_instruction_body(encoding, undefined),
            };
            cases0f.push(block);
        }
    }

    const table0f = {
        type: "switch",
        condition: "opcode",
        cases: cases0f,
        default_case: {
            body: ["assert!(false);"]
        },
    };

    if(to_generate.interpreter0f)
    {
        const code = [
            "#![cfg_attr(rustfmt, rustfmt_skip)]",

            "use crate::cpu::cpu::{after_block_boundary, modrm_resolve};",
            "use crate::cpu::cpu::{read_imm8, read_imm16, read_imm32s};",
            "use crate::cpu::cpu::{task_switch_test, task_switch_test_mmx, trigger_ud};",
            "use crate::cpu::instructions_0f;",
            "use crate::cpu::global_pointers::{instruction_pointer, prefixes};",
            "use crate::prefix;",

            "pub unsafe fn run(opcode: u32) {",
            table0f,
            "}",
        ];

        finalize_table_rust(
            OUT_DIR,
            "interpreter0f.rs",
            rust_ast.print_syntax_tree([].concat(code)).join("\n") + "\n"
        );
    }
}
