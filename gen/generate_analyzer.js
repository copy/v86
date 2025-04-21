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
    analyzer: gen_all || table_arg === "analyzer",
    analyzer0f: gen_all || table_arg === "analyzer0f",
};

assert(
    Object.keys(to_generate).some(k => to_generate[k]),
    "Pass --table [analyzer|analyzer0f] or --all to pick which tables to generate"
);

gen_table();

function gen_read_imm_call(op, size_variant)
{
    let size = (op.os || op.opcode % 2 === 1) ? size_variant : 8;

    if(op.imm8 || op.imm8s || op.imm16 || op.imm1632 || op.imm32 || op.immaddr)
    {
        if(op.imm8)
        {
            return "cpu.read_imm8()";
        }
        else if(op.imm8s)
        {
            return "cpu.read_imm8s()";
        }
        else
        {
            if(op.immaddr)
            {
                // immaddr: depends on address size
                return "cpu.read_moffs()";
            }
            else
            {
                assert(op.imm1632 || op.imm16 || op.imm32);

                if(op.imm1632 && size === 16 || op.imm16)
                {
                    return "cpu.read_imm16()";
                }
                else
                {
                    assert(op.imm1632 && size === 32 || op.imm32);
                    return "cpu.read_imm32()";
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

    assert(first_prefix === "" || first_prefix === "0F" || first_prefix === "F2" || first_prefix === "F3");
    assert(second_prefix === "" || second_prefix === "66" || second_prefix === "F2" || second_prefix === "F3");

    return `instr${suffix}_${second_prefix}${first_prefix}${opcode_hex}${fixed_g_suffix}`;
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
        code.push("let modrm_byte = cpu.read_imm8();");
    }

    if(has_66.length || has_F2.length || has_F3.length)
    {
        const if_blocks = [];

        if(has_66.length) {
            const body = gen_instruction_body_after_prefix(has_66, size);
            if_blocks.push({ condition: "cpu.prefixes & prefix::PREFIX_66 != 0", body, });
        }
        if(has_F2.length) {
            const body = gen_instruction_body_after_prefix(has_F2, size);
            if_blocks.push({ condition: "cpu.prefixes & prefix::PREFIX_F2 != 0", body, });
        }
        if(has_F3.length) {
            const body = gen_instruction_body_after_prefix(has_F3, size);
            if_blocks.push({ condition: "cpu.prefixes & prefix::PREFIX_F3 != 0", body, });
        }

        const else_block = {
            body: gen_instruction_body_after_prefix(no_prefix, size),
        };

        return [].concat(
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
                    body: [
                        "analysis.ty = analysis::AnalysisType::BlockBoundary;",
                        "analysis.no_next_instruction = true;",
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
    const imm_read = gen_read_imm_call(encoding, size);
    const instruction_postfix = [];

    if(encoding.custom_sti) {
        instruction_postfix.push("analysis.ty = analysis::AnalysisType::STI;");
    }
    else if(
        encoding.block_boundary &&
        // jump_offset_imm: Is a block boundary, but gets a different type (Jump) below
        !encoding.jump_offset_imm || (!encoding.custom && encoding.e))
    {
        instruction_postfix.push("analysis.ty = analysis::AnalysisType::BlockBoundary;");
    }

    if(encoding.no_next_instruction)
    {
        instruction_postfix.push("analysis.no_next_instruction = true;");
    }
    if(encoding.absolute_jump)
    {
        instruction_postfix.push("analysis.absolute_jump = true;");
    }

    if(encoding.prefix)
    {
        const instruction_name = "analysis::" + make_instruction_name(encoding, size) + "_analyze";
        const args = ["cpu", "analysis"];

        assert(!imm_read);

        return [].concat(
            gen_call(instruction_name, args),
            instruction_postfix
        );
    }
    else if(encoding.e)
    {
        // instruction with modrm byte where the middle 3 bits encode a register

        const reg_postfix = [];
        const mem_postfix = [];

        if(encoding.mem_ud)
        {
            mem_postfix.push(
                "analysis.ty = analysis::AnalysisType::BlockBoundary;"
            );
        }

        if(encoding.reg_ud)
        {
            reg_postfix.push(
                "analysis.ty = analysis::AnalysisType::BlockBoundary;"
            );
        }

        if(encoding.ignore_mod)
        {
            assert(!imm_read, "Unexpected instruction (ignore mod with immediate value)");

            // Has modrm byte, but the 2 mod bits are ignored and both
            // operands are always registers (0f20-0f24)

            return instruction_postfix;
        }
        else
        {
            return [].concat(
                {
                    type: "if-else",
                    if_blocks: [{
                        condition: "modrm_byte < 0xC0",
                        body: [].concat(
                            gen_call("analysis::modrm_analyze", ["cpu", "modrm_byte"]),
                            mem_postfix,
                        ),
                    }],
                    else_block: {
                        body: reg_postfix,
                    },
                },
                imm_read ? [imm_read + ";"] : [],
                instruction_postfix
            );
        }
    }
    else
    {
        // instruction without modrm byte or prefix

        const body = [];

        if(imm_read)
        {
            if(encoding.jump_offset_imm)
            {
                body.push("let jump_offset = " + imm_read + ";");

                if(encoding.conditional_jump)
                {
                    assert(
                        (encoding.opcode & ~0xF) === 0x70 ||
                        (encoding.opcode & ~0xF) === 0x0F80 ||
                        (encoding.opcode & ~0x3) === 0xE0
                    );
                    const condition_index = encoding.opcode & 0xFF;
                    body.push(`analysis.ty = analysis::AnalysisType::Jump { offset: jump_offset as i32, condition: Some(0x${hex(condition_index, 2)}), is_32: cpu.osize_32() };`);
                }
                else
                {
                    body.push(`analysis.ty = analysis::AnalysisType::Jump { offset: jump_offset as i32, condition: None, is_32: cpu.osize_32() };`);
                }
            }
            else
            {
                body.push(imm_read + ";");
            }
        }

        if(encoding.extra_imm16)
        {
            assert(imm_read);
            body.push(gen_call("cpu.read_imm16"));
        }
        else if(encoding.extra_imm8)
        {
            assert(imm_read);
            body.push(gen_call("cpu.read_imm8"));
        }

        return [].concat(
            body,
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
            body: ["dbg_assert!(false);"]
        },
    };

    if(to_generate.analyzer)
    {
        const code = [
            "#[cfg_attr(rustfmt, rustfmt_skip)]",
            "use crate::analysis;",
            "use crate::prefix;",
            "use crate::cpu_context;",
            "pub fn analyzer(opcode: u32, cpu: &mut cpu_context::CpuContext, analysis: &mut analysis::Analysis) {",
            table,
            "}",
        ];

        finalize_table_rust(
            OUT_DIR,
            "analyzer.rs",
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
            body: ["dbg_assert!(false);"]
        },
    };

    if(to_generate.analyzer0f)
    {
        const code = [
            "#![allow(unused)]",
            "#[cfg_attr(rustfmt, rustfmt_skip)]",
            "use crate::analysis;",
            "use crate::prefix;",
            "use crate::cpu_context;",
            "pub fn analyzer(opcode: u32, cpu: &mut cpu_context::CpuContext, analysis: &mut analysis::Analysis) {",
            table0f,
            "}"
        ];

        finalize_table_rust(
            OUT_DIR,
            "analyzer0f.rs",
            rust_ast.print_syntax_tree([].concat(code)).join("\n") + "\n"
        );
    }
}
