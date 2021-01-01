#!/usr/bin/env node
"use strict";

// number of tests per instruction
const NO_TESTS = 1;

const assert = require("assert").strict;
const fs = require("fs");
const encodings = require("../../gen/x86_table.js");
const Prand = require("./prand.js");

generate_tests();

function generate_tests()
{
    const build_folder = __dirname + "/build/";

    try
    {
        fs.mkdirSync(build_folder);
    }
    catch(e)
    {
        if(e.code !== "EEXIST")
        {
            throw e;
        }
    }

    for(const op of encodings)
    {
        const configurations = [
            { mem: 0, size: 16, },
            { mem: 0, size: 32, },
            { mem: 1, size: 16, },
            { mem: 1, size: 32, },
        ];

        let i = 0;

        for(const config of configurations)
        {
            for(let nth_test = 0; nth_test < NO_TESTS; nth_test++)
            {
                if(nth_test > 0 && op.opcode === 0x8D)
                {
                    // is already tested exhaustively in first run
                    continue;
                }

                for(const code of create_nasm(op, config, nth_test))
                {
                    const filename = "gen_" + format_opcode(op.opcode) + "_" + (op.fixed_g || 0) + "_" + i + ".asm";
                    const dirname = build_folder + filename;

                    let old_code = undefined;

                    try
                    {
                        old_code = fs.readFileSync(dirname, { encoding: "ascii" });
                    }
                    catch(e)
                    {
                    }

                    if(old_code !== code)
                    {
                        console.log("Creating %s", filename);
                        fs.writeFileSync(dirname, code);
                    }

                    i++;
                }
            }
        }
    }
}

function format_opcode(n)
{
    let x = n.toString(16);
    return (x.length === 1 || x.length === 3) ? "0" + x : x;
}

function create_nasm_modrm_combinations_16()
{
    let result = [];

    for(let modrm = 0; modrm < 0xC0; modrm++)
    {
        let mod = modrm >> 6;
        let rm = modrm & 7;

        let has_imm8 = mod === 1;
        let has_imm16 = mod === 2 || rm === 6 && mod === 0;

        assert(!has_imm8 || !has_imm16);

        let line = ["db " + modrm];
        if(has_imm8) line.push("db 9ah");
        if(has_imm16) line.push("dw 9a1fh");
        result.push(line);
    }

    return result;
}

function create_nasm_modrm_combinations_32()
{
    let result = [];

    let sample_sib_bytes = [0x05, 0x65, 0xAD, 0xCD, 0x20, 0xFF];
    let exhaustive_sib_bytes = [];
    for(let sib = 0; sib < 0x100; sib++) exhaustive_sib_bytes.push(sib);

    for(let modrm = 0; modrm < 0xC0; modrm++)
    {
        let mod = modrm >> 6;
        let reg = modrm >> 3 & 7;
        let rm = modrm & 7;

        let has_imm8 = mod === 1;
        let has_imm32 = mod === 2 || rm === 5 && mod === 0;
        let has_sib = rm === 4;

        assert(!has_imm8 || !has_imm32);

        if(has_sib)
        {
            // avoid generating an excessive number of tests
            let sib_bytes = reg === 0 ? exhaustive_sib_bytes : sample_sib_bytes;

            for(let sib of sib_bytes)
            {
                let line = ["db " + modrm, "db " + sib];
                if(has_imm8) line.push("db 9ah");
                if(has_imm32 || mod === 0 && (sib & 7) === 5) line.push("dd 9a1fbcdeh");
                result.push(line);
            }
        }
        else
        {
            let line = ["db " + modrm];
            if(has_imm8) line.push("db 9ah");
            if(has_imm32) line.push("dd 9a1fbcdeh");
            result.push(line);
        }
    }

    return result;
}


function create_nasm(op, config, nth_test)
{
    if(op.prefix || op.skip)
    {
        return [];
    }

    if(config.mem ? op.skip_mem : op.skip_reg)
    {
        // Not supported by test
        return [];
    }

    if(!op.e)
    {
        if(config.mem)
        {
            // doesn't use memory, don't test both
            return [];
        }
    }

    if(!op.os)
    {
        if(config.size === 16)
        {
            // equivalent to 32-bit version, don't test both
            return [];
        }
    }

    const op_rand = new Prand(op.opcode + nth_test * 0x10000);

    const size = (op.os || op.opcode % 2 === 1) ? config.size : 8;
    const is_modrm = op.e || op.fixed_g !== undefined;

    const codes = [];

    for(let reg of ["eax", "ecx", "edx", "ebx", "ebp", "esi", "edi"])
    {
        let rand = op_rand.next();
        codes.push("mov " + reg + ", " + rand);
    }

    if(!op.is_fpu) // generate random mmx registers
    {
        codes.push("sub esp, 8");
        for(let i = 0; i < 8; i++)
        {
            codes.push("mov dword [esp], " + op_rand.next());
            codes.push("mov dword [esp + 4], " + op_rand.next());
            codes.push("movq mm" + i + ", [esp]");
        }
        codes.push("add esp, 8");
    }
    else // generate random fpu registers
    {
        codes.push("finit");
        codes.push("sub esp, 8");

        for(let i = 0; i < 8; i++)
        {
            codes.push("mov dword [esp], " + op_rand.next());
            codes.push("mov dword [esp + 4], " + op_rand.next());
            codes.push("fld qword [esp]");
        }

        for(let i = 0; i < 4; i++) // half full stack
        {
            codes.push("fstp qword [esp]");
        }

        codes.push("add esp, 8");
    }

    if(true) // generate random xmm registers
    {
        codes.push("sub esp, 16");
        for(let i = 0; i < 8; i++)
        {
            codes.push("mov dword [esp], " + op_rand.next());
            codes.push("mov dword [esp + 4], " + op_rand.next());
            codes.push("mov dword [esp + 8], " + op_rand.next());
            codes.push("mov dword [esp + 12], " + op_rand.next());
            codes.push("movdqu xmm" + i + ", [esp]");
        }
        codes.push("add esp, 16");
    }

    if(true) // generate random stack memory
    {
        for(let i = 0; i < 8; i++)
        {
            codes.push("sub esp, 4");
            codes.push("mov dword [esp], " + op_rand.next());
        }
    }

    codes.push("push dword " + (op_rand.next() & ~(1 << 8 | 1 << 9)));
    codes.push("popf");

    if(true)
    {
        // generate random flags using arithmatic instruction
        // not well-distributed, but can trigger bugs in lazy flag calculation
        if(true)
        {
            // rarely sets zero flag, other flags mostly well-distributed
            codes.push("add al, ah");
        }
        else
        {
            // always sets zero flag
            codes.push("sub al, al");
        }
    }

    if(op.is_string)
    {
        codes.push("mov ecx, 3");
        codes.push("mov edi, (120000h-16)");
        codes.push("mov esi, (120000h-20)");
    }

    if(size === 16)
    {
        codes.push("db 66h ; 16 bit");
    }

    let opcode = op.opcode;

    if(opcode === 0x8D)
    {
        // special case: lea: generate 16-bit addressing and all modrm combinations
        assert(is_modrm);

        codes.push([].concat(
            create_nasm_modrm_combinations_16().map(lines => ["db 67h", "db 8dh"].concat(lines).join("\n")),
            create_nasm_modrm_combinations_32().map(lines => ["db 8dh"].concat(lines).join("\n"))
        ));
    }
    else
    {
        assert(opcode < 0x1000000);
        if(opcode >= 0x10000)
        {
            let c = opcode >> 16;
            assert(c === 0x66 || c === 0xF3 || c === 0xF2);
            codes.push("db " + c);
            opcode &= ~0xFF0000;
        }
        if(opcode >= 0x100)
        {
            let c = opcode >> 8;
            assert(c === 0x0F || c === 0xF2 || c === 0xF3, "Expected 0F, F2, or F3 prefix, got " + c.toString(16));
            codes.push("db " + c);
            opcode &= ~0xFF00;
        }
        codes.push("db " + opcode);

        if(is_modrm)
        {
            let g = 7; // edi / di / bh

            if(op.fixed_g !== undefined)
            {
                g = op.fixed_g;
            }

            if(config.mem)
            {
                const e = 0x04; // [esp]
                const sib = 0x24;

                codes.push("db " + (e | g << 3));
                codes.push("db " + sib);
            }
            else
            {
                const es = op.is_fpu ? [0, 1, 2, 3, 4, 5, 6, 7] : [
                    2 // edx
                ];
                const modrm_bytes = es.map(e => "db " + (0xC0 | g << 3 | e));
                codes.push(modrm_bytes);
            }
        }
    }

    if(op.opcode === 0xC8) // special case: enter
    {
        codes.push("dw 8h");
        codes.push("db 0h");
    }
    else if(op.imm8 || op.imm8s || op.imm16 || op.imm1632 || op.imm32 || op.immaddr)
    {
        if(op.imm8 || op.imm8s)
        {
            codes.push("db 12h");
        }
        else
        {
            if(op.immaddr)
            {
                // immaddr: depends on address size
                // generate valid pointer into bss section
                codes.push("dd (120000h-16)");
            }
            else
            {
                assert(op.imm1632 || op.imm16 || op.imm32);

                if(op.imm1632 && size === 16 || op.imm16)
                {
                    codes.push("dw 34cdh");
                }
                else
                {
                    assert(op.imm1632 && size === 32 || op.imm32);
                    codes.push("dd 1234abcdh");
                }
            }
        }
    }

    if(op.mask_flags)
    {
        codes.push(
            "pushf",
            "and dword [esp], ~" + op.mask_flags,
            "popf"
        );
    }

    return all_combinations(codes).map(c => {
        return (
            "global _start\n" +
            '%include "header.inc"\n\n' +
            c.join("\n") + "\n" +
            '%include "footer.inc"\n'
        );
    });
}

function all_combinations(xs)
{
    let result = [xs];

    for(let i = 0; i < xs.length; i++)
    {
        let x = xs[i];

        if(x instanceof Array)
        {
            let new_result = [];

            for(let r of result)
            {
                for(let x_ of x)
                {
                    r = r.slice();
                    r[i] = x_;
                    new_result.push(r);
                }
            }

            result = new_result;
        }
    }

    return result;
}
