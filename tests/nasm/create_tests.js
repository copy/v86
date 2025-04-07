#!/usr/bin/env node

import fs from "node:fs";
import fse from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import util from "node:util";
import url from "node:url";
import { execFile as execFileAsync } from "node:child_process";

import encodings from "../../gen/x86_table.js";
import Rand from "./rand.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

// number of tests per instruction
const NUMBER_TESTS = 5;
// arithmetic tests
const NUMBER_ARITH_TESTS = 100;

const MAX_PARALLEL_PROCS = +process.env.MAX_PARALLEL_PROCS || 32;

const FLAGS_IGNORE = 0xFFFF3200;
const CF = 1 << 0;
const PF = 1 << 2;
const AF = 1 << 4;
const ZF = 1 << 6;
const SF = 1 << 7;
const OF = 1 << 11;

const BUILD_DIR = __dirname + "/build/";
const LOG_VERBOSE = false;

const execFile = util.promisify(execFileAsync);

const header = fs.readFileSync(path.join(__dirname, "header.inc"));
const footer = fs.readFileSync(path.join(__dirname, "footer.inc"));

main();

async function main()
{
    try
    {
        fs.mkdirSync(BUILD_DIR);
    }
    catch(e)
    {
        if(e.code !== "EEXIST")
        {
            throw e;
        }
    }

    const tests = create_tests().reverse();

    const workers = [];
    for(let i = 0; i < MAX_PARALLEL_PROCS; i++)
    {
        workers.push(worker(make_test, tests));
    }

    await Promise.all(workers);
}

async function worker(f, work)
{
    while(work.length)
    {
        await f(work.pop());
    }
}

async function make_test(test)
{
    LOG_VERBOSE && console.log("Start", test.name || test.file);
    let asm_file;
    let img_file;
    let tmp_file;

    assert((test.asm && test.name) || test.file);
    if(test.asm)
    {
        asm_file = BUILD_DIR + test.name + ".asm";
        img_file = BUILD_DIR + test.name + ".img";
        tmp_file = "/tmp/" + test.name + ".o";

        let old_code = undefined;

        try
        {
            old_code = await fse.readFile(asm_file, { encoding: "ascii" });
        }
        catch(e)
        {
        }

        if(old_code === test.asm)
        {
            LOG_VERBOSE && console.log("Skip", test.name || test.file);
            return;
        }

        await fse.writeFile(asm_file, test.asm);
    }
    else
    {
        asm_file = path.join(__dirname, test.file);
        img_file = BUILD_DIR + test.file.replace(/\.asm$/, ".img");
        tmp_file = "/tmp/" + test.file + ".o";

        try
        {
            if((await fse.stat(asm_file)).mtime < (await fse.stat(img_file)).mtime)
            {
                return;
            }
        }
        catch(e)
        {
            if(e.code !== "ENOENT") throw e;
        }
    }

    const options = {
        cwd: __dirname,
    };

    LOG_VERBOSE && console.log("nasm", ["-w+error", "-felf32", "-o", tmp_file, asm_file].join(" "));
    await execFile("nasm", ["-w+error", "-felf32", "-o", tmp_file, asm_file], options);
    LOG_VERBOSE && console.log("ld", ["-g", tmp_file, "-m", "elf_i386", "--section-start=.bss=0x100000", "--section-start=.text=0x80000", "--section-start=.multiboot=0x20000", "-o", img_file].join(" "));
    await execFile("ld", ["-g", tmp_file, "-m", "elf_i386", "--section-start=.bss=0x100000", "--section-start=.text=0x80000", "--section-start=.multiboot=0x20000", "-o", img_file], options);
    await fse.unlink(tmp_file);

    console.log(test.name || test.file);
}

function create_tests()
{
    const tests = [];

    const asm_files = fs.readdirSync(__dirname).filter(f => f.endsWith(".asm"));
    tests.push.apply(tests, asm_files.map(file => ({ file })));

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
            for(let nth_test = 0; nth_test < NUMBER_TESTS; nth_test++)
            {
                if(nth_test > 0 && op.opcode === 0x8D)
                {
                    // is already tested exhaustively in first run
                    continue;
                }

                for(const asm of create_instruction_test(op, config, nth_test))
                {
                    tests.push({
                        name: "gen_" + format_opcode(op.opcode) + "_" + (op.fixed_g || 0) + "_" + i,
                        asm,
                    });

                    i++;
                }
            }
        }
    }

    for(let i = 0; i < NUMBER_ARITH_TESTS; i++)
    {
        tests.push(create_arith_test(i));
    }

    return tests;
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

function rand_reg_but_not_esp(rng)
{
    let r = rng.int32() & 7;
    return r === 4 ? rand_reg_but_not_esp(rng) : r;
}

function interesting_immediate(rng)
{
    if(rng.int32() & 1)
    {
        return rng.int32();
    }
    else
    {
        return rng.int32() << (rng.int32() & 31) >> (rng.int32() & 31);
    }
}

function create_instruction_test(op, config, nth_test)
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

    const rng = new Rand(1283698341 ^ op.opcode + nth_test * 0x10000);

    const size = (op.os || op.opcode % 2 === 1) ? config.size : 8;
    const is_modrm = op.e || op.fixed_g !== undefined;

    const codes = [];

    for(let reg of ["eax", "ecx", "edx", "ebx", "ebp", "esi", "edi"])
    {
        let rand = rng.int32();
        codes.push("mov " + reg + ", " + rand);
    }

    if(!op.is_fpu) // generate random mmx registers
    {
        codes.push("sub esp, 8");
        for(let i = 0; i < 8; i++)
        {
            codes.push("mov dword [esp], " + rng.int32());
            codes.push("mov dword [esp + 4], " + rng.int32());
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
            codes.push("mov dword [esp], " + rng.int32());
            codes.push("mov dword [esp + 4], " + rng.int32());
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
            codes.push("mov dword [esp], " + rng.int32());
            codes.push("mov dword [esp + 4], " + rng.int32());
            codes.push("mov dword [esp + 8], " + rng.int32());
            codes.push("mov dword [esp + 12], " + rng.int32());
            codes.push("movdqu xmm" + i + ", [esp]");
        }
        codes.push("add esp, 16");
    }

    if(true) // generate random stack memory
    {
        for(let i = 0; i < 8; i++)
        {
            codes.push("sub esp, 4");
            codes.push("mov dword [esp], " + rng.int32());
        }
    }

    codes.push("push dword " + (rng.int32() & ~(1 << 8 | 1 << 9)));
    codes.push("popf");

    if(rng.int32() & 1)
    {
        // generate random flags using arithmetic instruction
        // not well-distributed, but can trigger bugs in lazy flag calculation
        if(rng.int32() & 1)
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
        codes.push("mov edi, (102000h-16)");
        codes.push("mov esi, (102000h-20)");
    }

    if(size === 16)
    {
        codes.push("db 66h ; 16 bit");
    }

    let opcode = op.opcode;

    if([0x0FA5, 0x0FAD].includes(op.opcode) && size === 16)
    {
        // shld/shrd: immediates larger than opsize are undefined behaviour,
        // but it's anded with 31 automatically, so only bit 4 needs to be cleared
        codes.push("and cl, ~16");
    }

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
            let g = rand_reg_but_not_esp(rng);

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
                const es =
                    op.is_fpu ? [0, 1, 2, 3, 4, 5, 6, 7] : [
                        rand_reg_but_not_esp(rng)
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
            if([0x0FA4, 0x0FAC].includes(op.opcode))
            {
                // shld/shrd: immediates larger than opsize are undefined behaviour
                codes.push("db " + (rng.int32() & (size === 16 ? 15 : 31)));
            }
            else
            {
                codes.push("db " + (rng.int32() & 0xFF));
            }
        }
        else
        {
            if(op.immaddr)
            {
                // immaddr: depends on address size
                // generate valid pointer into bss section
                codes.push("dd (102000h-16)");
            }
            else
            {
                assert(op.imm1632 || op.imm16 || op.imm32);

                if(op.imm1632 && size === 16 || op.imm16)
                {
                    codes.push("dw " + (rng.int32() & 0xFFFF));
                }
                else
                {
                    assert(op.imm1632 && size === 32 || op.imm32);
                    codes.push("dd " + rng.int32());
                }
            }
        }
    }

    if(op.mask_flags)
    {
        codes.push(
            "pushf",
            "and dword [esp], ~" + (op.mask_flags | FLAGS_IGNORE),
            "popf",
            "mov dword [esp-4], 0",
        );
    }

    if(op.opcode === 0x06 || op.opcode === 0x0E || op.opcode === 0x16 || op.opcode === 0x1E ||
        op.opcode === 0x0FA0 || op.opcode === 0x0FA8)
    {
        // push sreg: mask result
        if(size === 16)
        {
            codes.push("mov word [esp], 0");
        }
        else
        {
            // NOTE: upper word is undefined behaviour (unchanged on Intel, zero on AMD)
            codes.push("mov dword [esp], 0");
        }
    }

    return all_combinations(codes).map(c => {
        return header + c.join("\n") + "\n" + footer;
    });
}

function create_arith_test(i)
{
    const rng = new Rand(916237867 ^ i);

    const registers_by_size = {
        8: ["al", "ah", "cl", "ch", "dl", "dh", "bl", "bh"],
        16: ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"],
        32: ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"],
    };
    const mask_by_size = {
        8: 0xFF,
        16: 0xFFFF,
        32: -1,
    };
    const word_by_size = {
        8: "byte",
        16: "word",
        32: "dword",
    };
    const two_operand_instructions = ["add", "sub", "adc", "sbb", "and", "or", "xor", "cmp", "test"];
    const one_operand_instructions = [
        "inc", "dec", "neg",
        "mul", //"idiv", "div", // technically also eax:edx, but are implied by assembler
        "imul", // handled specifically below to also generate 2-/3-operand form
    ];
    const shift_instructions = ["shl", "shr", "sar", "rol", "ror", "rcl", "rcr"];
    // TODO: cmpxchg, xadd, bsf, bsr, shrd/shld, popcnt, bt*
    const instructions = [two_operand_instructions, one_operand_instructions, shift_instructions].flat();
    const conditions = [
        // suffix flag
        ["o", OF],
        ["c", CF],
        ["z", ZF],
        ["p", PF],
        ["s", SF],
        ["be", CF | ZF],
        ["l", SF | OF],
        ["le", SF | OF | ZF],
    ];

    let c = [];
    let address = 0x100000;

    for(let reg of registers_by_size[32])
    {
        if(reg !== "esp")
        {
            c.push(`mov ${reg}, ${interesting_immediate(rng)}`);
        }
    }

    let undefined_flags = 0;

    for(let i = 0; i < 2000; i++)
    {
        const ins = instructions[rng.uint32() % instructions.length];
        const size = [8, 16, 32][rng.uint32() % 3];
        const size_word = word_by_size[size];
        const dst_is_mem = rng.int32() & 1;
        const dst = dst_is_mem ?
            `${size_word} [${nasm_hex(address)}]` :
            registers_by_size[size][rand_reg_but_not_esp(rng)];
        let src_is_mem = false;
        if(ins === "imul" && (rng.int32() & 1)) // other encodings handled in one_operand_instructions
        {
            // dst must be reg, no 8-bit
            const size_imul = [16, 32][rng.int32() & 1];
            const dst_imul = registers_by_size[size_imul][rand_reg_but_not_esp(rng)];
            const src1 = dst_is_mem ?
                `${word_by_size[size_imul]} [${nasm_hex(address)}]` :
                registers_by_size[size_imul][rand_reg_but_not_esp(rng)];
            if(rng.int32() & 1)
            {
                c.push(`${ins} ${dst_imul}, ${src1}`);
            }
            else
            {
                const src2 = nasm_hex(interesting_immediate(rng) & mask_by_size[size_imul]);
                c.push(`${ins} ${dst_imul}, ${src1}, ${src2}`);
            }
        }
        else if(one_operand_instructions.includes(ins))
        {
            c.push(`${ins} ${dst}`);
        }
        else if(two_operand_instructions.includes(ins))
        {
            src_is_mem = !dst_is_mem && (rng.int32() & 1);
            const src = src_is_mem ?
                `${size_word} [${nasm_hex(address)}]` :
                (rng.int32() & 1) ?
                registers_by_size[size][rand_reg_but_not_esp(rng)] :
                nasm_hex(interesting_immediate(rng) & mask_by_size[size]);
            c.push(`${ins} ${dst}, ${src}`);
        }
        else if(shift_instructions.includes(ins))
        {
            if(rng.int32() & 1)
            {
                // unknown CL
                undefined_flags |= AF | OF;
                c.push(`${ins} ${dst}, cl`);
            }
            else
            {
                const shift = interesting_immediate(rng) & 0xFF;
                // TODO: shift mod {8,9,16,17,32,33} depending on bitsize/rotate/with-carry, shifts can clear undefined_flags if shift is not zero
                undefined_flags |= shift === 1 ? AF : AF | OF;
                if(rng.int32() & 1)
                {
                    // known CL
                    c.push(`mov cl, ${nasm_hex(shift)}`);
                    c.push(`${ins} ${dst}, cl`);
                }
                else
                {
                    // immediate
                    c.push(`${ins} ${dst}, ${nasm_hex(shift)}`);
                }
            }
        }

        if(dst_is_mem || src_is_mem)
        {
            if(rng.int32() & 1)
            {
                address += size / 8;
                // initialise next word
                c.push(`mov dword [${nasm_hex(address)}], ${nasm_hex(interesting_immediate(rng) & 0xFF)}`);
            }
        }

        if(ins === "imul" || ins === "mul" || ins === "idiv" || ins === "div")
        {
            undefined_flags = SF | ZF | AF | PF;
        }
        else if(!shift_instructions.includes(ins))
        {
            // adc/sbb/inc/dec read CF, but CF is never undefined
            undefined_flags = 0;
        }

        if(rng.int32() & 1)
        {
            // setcc
            const cond = random_pick(conditions.filter(([_, flag]) => 0 === (flag & undefined_flags)).map(([suffix]) => suffix), rng);
            assert(cond);
            const invert = (rng.int32() & 1) ? "n" : "";
            const ins2 = `set${invert}${cond}`;
            const dst2 = (rng.int32() & 1) ? `byte [${nasm_hex(address++)}]` : registers_by_size[8][rng.int32() & 7];
            c.push(`${ins2} ${dst2}`);
        }
        else if(rng.int32() & 1)
        {
            // cmovcc
            const cond = random_pick(conditions.filter(([_, flag]) => 0 === (flag & undefined_flags)).map(([suffix]) => suffix), rng);
            assert(cond);
            const invert = (rng.int32() & 1) ? "n" : "";
            const ins2 = `cmov${invert}${cond}`;
            const size = (rng.int32() & 1) ? 16 : 32;
            const src2 = registers_by_size[size][rng.int32() & 7];
            const dst2 = registers_by_size[size][rand_reg_but_not_esp(rng)];
            c.push(`${ins2} ${dst2}, ${src2}`);
        }
        else if(rng.int32() & 1)
        {
            c.push("pushf");
            c.push("and dword [esp], ~" + nasm_hex(FLAGS_IGNORE | undefined_flags));
            c.push(`pop ${registers_by_size[32][rand_reg_but_not_esp(rng)]}`);
        }
        else
        {
            // intentionally left blank
        }

        // TODO:
        // cmovcc
        // other random instructions (mov, etc.)
    }

    c.push("pushf");
    c.push("and dword [esp], ~" + nasm_hex(FLAGS_IGNORE | undefined_flags));
    c.push("popf");

    assert(address < 0x102000);

    const name = `arith_${i}`;
    const asm = header + c.join("\n") + "\n" + footer;

    return { name, asm };
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

function nasm_hex(x)
{
    return `0${(x >>> 0).toString(16).toUpperCase()}h`;
}

function random_pick(xs, rng)
{
    return xs[rng.uint32() % xs.length];
}
