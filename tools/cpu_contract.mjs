#!/usr/bin/env node
// CPU identity contract (docs/x86-64.md): the virtual CPU's identity as
// the guest sees it, per profile: CPUID for a fixed list of leaves and which
// MSRs RDMSR reads (and their reset values) instead of raising #GP. A
// multiboot guest runs the instructions on the bootstrap processor, so this is
// the observed contract, not a copy of the source. In a profile with long
// mode the MSRs are read with EFER.LME set, as a 64-bit OS reads them.
//
//   node tools/cpu_contract.mjs          write tests/platform/cpu-contract.json
//   node tools/cpu_contract.mjs --check  fail if the emulator differs from that file
//
// The AArch64 profiles a64-1 and a64-4 (docs/arm64-virt-android16-plan.md
// P0.3) hold the ID registers that tests/a64/id_registers.c reads at EL1,
// expected from tests/platform/a64-profile.json, not observed: --check
// compares them with that file and runs the reader on v86's ARM core (P3.1;
// a64-4 on its cooperative cores, P3.9).
//
//   node tools/cpu_contract.mjs --a64-only       rewrite only a64-1 and a64-4
//   node tools/cpu_contract.mjs --a64-reference  read the QEMU reference's
//       registers (1 and 4 cores) and fail on a difference from the profile
//       that its allowed-differences list does not name
//   node tools/cpu_contract.mjs --a64-v86  only the reader on v86's ARM core,
//       which must match the profile with no difference at all
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { assemble, actual } from "../tests/x64/guest_runner.mjs";
import * as a64_runner from "../tests/a64/guest_runner.mjs";

// the release build: the debug build asserts on an unknown MSR in the legacy
// profile, which (upstream's policy) reads it as 0 rather than raising #GP
process.env.TEST_RELEASE_BUILD = "1";

const root = fileURLToPath(new URL("../", import.meta.url));
const contract_path = root + "tests/platform/cpu-contract.json";
const a64_profile_path = root + "tests/platform/a64-profile.json";

const LEAVES = [
    [0, 0], [1, 0], [2, 0], [4, 0], [4, 1], [4, 2], [4, 3], [6, 0], [7, 0], [7, 1], [0xA, 0],
    [0xB, 0], [0xB, 1], [0xB, 2], [0xD, 0], [0xD, 1], [0x40000000, 0],
    [0x80000000, 0], [0x80000001, 0], [0x80000002, 0], [0x80000003, 0], [0x80000004, 0],
    [0x80000005, 0], [0x80000006, 0], [0x80000007, 0], [0x80000008, 0], [0x8000000A, 0],
];
const MSRS = [
    0x10, 0x17, 0x1B, 0x3A, 0x3B, 0x48, 0x8B, 0xE7, 0xE8, 0xFE, 0x10A, 0x174, 0x175, 0x176,
    0x179, 0x17A, 0x17B, 0x1A0, 0x1D9, 0x200, 0x201, 0x20E, 0x20F, 0x250, 0x258, 0x259,
    0x268, 0x26F, 0x277, 0x2FF, 0x345, 0x400, 0x401, 0x402, 0x403, 0x40C, 0x40F, 0x6E0,
    0xC0000080, 0xC0000081, 0xC0000082, 0xC0000083, 0xC0000084, 0xC0000100, 0xC0000101,
    0xC0000102, 0xC0000103,
];
// (counters whose values change; only whether they are readable is part of
// the contract)
const VOLATILE = new Set([0x10, 0xE7, 0xE8]);
const PROFILES = {
    "legacy-1": {},
    "legacy-4": { cpu_cores: 4, acpi: true },
    "x64-1": { cpu_type: "x86_64" },
    "x64-4": { cpu_type: "x86_64", cpu_cores: 4, acpi: true },
    // the released features (docs/simd-xsave-plan.md M1-M5)
    "legacy-v2": { cpu_features: "x86-64-v2" },
    "x64-v2": { cpu_type: "x86_64", cpu_features: "x86-64-v2" },
    "legacy-xsave": { cpu_features: ["XSAVE"] },
    "x64-xsave": { cpu_type: "x86_64", cpu_features: ["XSAVE"] },
    "legacy-avx": { cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX"] },
    "x64-avx": { cpu_type: "x86_64", cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX"] },
    // (the 32-bit profile: x86-64-v3's features but LZCNT, plan Q7)
    "legacy-v3": { cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX", "AVX2", "FMA", "F16C", "BMI1", "BMI2", "MOVBE"] },
    "x64-v3": { cpu_type: "x86_64", cpu_features: "x86-64-v3" },
    "legacy-xsaves": { cpu_features: ["XSAVE", "XSAVEOPT", "XSAVEC", "XGETBV1", "XSAVES"] },
    "x64-xsaves": { cpu_type: "x86_64", cpu_features: ["XSAVE", "XSAVEOPT", "XSAVEC", "XGETBV1", "XSAVES"] },
};

const OUT = 0x300000, CPUID_AT = OUT + 16, MSR_AT = CPUID_AT + 16 * LEAVES.length;
const source = `bits 32
org 0x100000
header:
dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)
dd header,header,image_end,image_end,start
start:
cli
; a GDT of its own (exceptions reload CS from it), then an IDT whose #GP
; handler skips the faulting RDMSR (2 bytes) and flags it
lgdt [gdtr]
jmp 8:.flat
.flat:
mov ax, 16
mov ds, ax
mov es, ax
mov ss, ax
mov esp, 0x200000
mov edi, idt
mov ecx, 32
.gate:
mov eax, other
mov [edi], ax
mov word [edi + 2], 8
mov word [edi + 4], 0x8E00
shr eax, 16
mov [edi + 6], ax
add edi, 8
loop .gate
mov eax, gp_handler
mov [idt + 13 * 8], ax
shr eax, 16
mov [idt + 13 * 8 + 6], ax
lidt [idtr]
mov esi, leaves
mov edi, ${CPUID_AT}
.cpuid:
mov eax, [esi]
cmp eax, -1
je .msrs
mov ecx, [esi + 4]
cpuid
mov [edi], eax
mov [edi + 4], ebx
mov [edi + 8], ecx
mov [edi + 12], edx
add esi, 8
add edi, 16
jmp .cpuid
.msrs:
; with long mode (CPUID.80000001h:EDX[29]), as a 64-bit OS sees them: EFER.LME set
mov eax, 0x80000001
cpuid
test edx, 1 << 29
jz .probe
mov ecx, 0xC0000080
rdmsr
or eax, 1 << 8
wrmsr
.probe:
mov esi, msrs
mov edi, ${MSR_AT}
.msr:
mov ecx, [esi]
cmp ecx, -1
je .done
mov dword [faulted], 0
xor eax, eax
xor edx, edx
rdmsr
mov ebx, [faulted]
mov [edi], ebx
mov [edi + 4], eax
mov [edi + 8], edx
add esi, 4
add edi, 12
jmp .msr
.done:
mov dword [${OUT}], 0xC064C064
.halt:
hlt
jmp .halt
gp_handler:
mov dword [faulted], 1
add esp, 4                      ; the error code
add dword [esp], 2              ; past RDMSR
iret
other:
mov dword [${OUT} + 4], 0xBAD
.stop:
hlt
jmp .stop
align 4
faulted: dd 0
leaves:
${LEAVES.map(([leaf, sub]) => `dd ${leaf}, ${sub}`).join("\n")}
dd -1, -1
msrs:
${MSRS.map(msr => `dd ${msr}`).join("\n")}
dd -1
align 8
gdt: dq 0, 0x00CF9A000000FFFF, 0x00CF92000000FFFF
gdtr: dw 3 * 8 - 1
dd gdt
idtr: dw 32 * 8 - 1
dd idt
idt: times 32 dq 0
image_end:
`;

const hex = n => "0x" + (n >>> 0).toString(16).padStart(8, "0");

async function observe_x86()
{
    const directory = assemble("cpu-contract", source);
    const observed = {};
    for(const [name, options] of Object.entries(PROFILES))
    {
        const bytes = await actual(directory, { length: MSR_AT - OUT + 12 * MSRS.length, options });
        assert.notEqual(bytes.readUInt32LE(4), 0xBAD, name + ": unexpected exception");
        const cpuid = {};
        LEAVES.forEach(([leaf, sub], i) => {
            const at = CPUID_AT - OUT + 16 * i;
            cpuid[`${hex(leaf)}.${sub}`] = [0, 4, 8, 12].map(o => hex(bytes.readUInt32LE(at + o)));
        });
        const msrs = {};
        MSRS.forEach((msr, i) => {
            const at = MSR_AT - OUT + 12 * i;
            msrs[hex(msr)] = bytes.readUInt32LE(at) ? "#GP" : VOLATILE.has(msr) ? "readable" :
                hex(bytes.readUInt32LE(at + 8)) + ":" + hex(bytes.readUInt32LE(at + 4)).slice(2);
        });
        observed[name] = { options, cpuid, msrs };
    }
    return observed;
}

// -------- AArch64

const A64_PROFILES = { "a64-1": 1, "a64-4": 4 };
const hex64 = n => "0x" + BigInt(n).toString(16).padStart(16, "0");

/** The registers as tests/a64/id_registers.c prints them, from the profile */
function a64_expected(profile, cores)
{
    const registers = {};
    for(const r of profile.id_space) registers[r.encoding] = r.value;
    const other = Object.fromEntries(profile.other_registers.map(r => [r.name, r]));
    registers["CLIDR_EL1"] = other.CLIDR_EL1.value;
    registers["AIDR_EL1"] = other.AIDR_EL1.value;
    for(let csselr = 0; csselr < 6; csselr++)
    {
        registers[`CCSIDR_EL1.${csselr}`] = other.CCSIDR_EL1.by_csselr[csselr]?.value || hex64(0);
        registers[`CSSELR_EL1.${csselr}`] = hex64(csselr);
    }
    registers["CCSIDR2_EL1"] = other.CCSIDR2_EL1.value;
    for(const name of ["CTR_EL0", "DCZID_EL0", "CNTFRQ_EL0", "FPCR", "FPSR"]) registers[name] = other[name].value;
    const mpidr = Array.from({ length: cores }, (_, core) => hex64(0x80000000 + core));
    registers["S3_0_C0_C0_5"] = mpidr[0];
    return { options: { cpu_type: "aarch64", cpu_cores: cores }, profile: profile.profile, registers, mpidr };
}

/** tests/a64/id_registers.c's output in a64_expected()'s form */
function a64_parse(text, cores)
{
    const registers = {}, mpidr = [];
    for(const line of text.split("\n"))
    {
        let m;
        if((m = line.match(/^A64_ID (\S+) (?:(0x[0-9a-f]+)|UNDEF esr=(0x[0-9a-f]+))$/)))
        {
            // (an UNDEF is EC 0x00 with IL set)
            registers[m[1]] = m[2] || (BigInt(m[3]) === 0x2000000n ? "UNDEF" : "UNDEF esr=" + m[3]);
        }
        else if((m = line.match(/^A64_MPIDR (\d+) (0x[0-9a-f]+)$/))) mpidr[+m[1]] = m[2];
    }
    assert.ok(text.includes("A64_ID_DONE"), "the ID register reader did not finish:\n" + text);
    assert.equal(mpidr.length, cores, `MPIDR of ${mpidr.length} cores, expected ${cores}`);
    return { registers, mpidr };
}

/** Differences of `observed` from the profile that its allowed list does not name */
function a64_compare(profile, expected, observed)
{
    const allowed = new Set(profile.allowed_differences.cpu.flatMap(d => d.registers || []));
    const described = new Map(profile.id_space.filter(r => r.name).map(r => [r.encoding, r]));
    for(const r of profile.other_registers) described.set(r.name, r);
    const problems = [], tolerated = [];
    for(const [key, want] of Object.entries(expected.registers))
    {
        const got = observed.registers[key];
        if(got === want || want === "per core" && got !== undefined) continue;
        const register = described.get(key), name = register?.name || key;
        let fields = [];
        if(Array.isArray(register?.fields) && /^0x/.test(got) && /^0x/.test(want))
        {
            for(const [field, high, low] of register.fields)
            {
                const mask = (1n << BigInt(high - low + 1)) - 1n;
                if((BigInt(got) >> BigInt(low) & mask) !== (BigInt(want) >> BigInt(low) & mask)) fields.push(field);
            }
        }
        const entry = `${name} (${key}): reference ${got}, profile ${want}` + (fields.length ? ` [${fields.join(", ")}]` : "");
        const ok = allowed.has(name) || fields.length && fields.every(field => allowed.has(name + "." + field));
        (ok ? tolerated : problems).push(entry);
    }
    observed.mpidr.forEach((value, core) => {
        if(value !== expected.mpidr[core]) problems.push(`MPIDR_EL1 of core ${core}: reference ${value}, profile ${expected.mpidr[core]}`);
    });
    return { problems, tolerated };
}

const a64_profile = JSON.parse(fs.readFileSync(a64_profile_path, "utf8"));
const a64 = Object.fromEntries(Object.entries(A64_PROFILES).map(([name, cores]) => [name, a64_expected(a64_profile, cores)]));

if(process.argv.includes("--a64-reference"))
{
    const directory = a64_runner.build("id-registers", [root + "tests/a64/id_registers.c"]);
    let failed = false;
    for(const [name, cores] of Object.entries(A64_PROFILES))
    {
        const result = await a64_runner.reference(directory, { cores });
        assert.equal(result.status, "ok", name + ": " + result.text);
        fs.mkdirSync(root + "build/a64-linux", { recursive: true });
        fs.writeFileSync(root + `build/a64-linux/qemu-id_registers-${cores}c.txt`, result.text);
        const { problems, tolerated } = a64_compare(a64_profile, a64[name], a64_parse(result.text, cores));
        console.log(`${name}: QEMU ${a64_profile.reference.cpu} against ${a64_profile.profile}: ` +
            `${tolerated.length} allowed differences, ${problems.length} others`);
        for(const line of tolerated) console.log("  allowed: " + line);
        for(const line of problems) console.log("  NOT ALLOWED: " + line);
        failed ||= problems.length > 0;
    }
    process.exit(failed ? 1 : 0);
}

/**
 * v86's ARM core (P3.1): tests/a64/id_registers.c on v86 must read exactly the
 * profile's values, with no allowed difference (those are the reference's);
 * a64-4 on the cooperative cores (P3.9)
 */
async function a64_v86_check()
{
    const directory = a64_runner.build("id-registers", [root + "tests/a64/id_registers.c"]);
    let failed = false;
    // (v1.1, then v2 and v3: their ID registers differ where the profile's
    // entries say; v2 is the default since 2026-10-21, so v1.1 is asked for)
    const { v2, v3 } = a64_profile;
    for(const [variant, options, changes] of [[a64_profile.profile, { cpu_profile: "generic-arm64-v1.1" }, {}], [v2.profile, { cpu_profile: v2.cpu_profile }, v2.id_space],
        [v3.profile, { cpu_profile: v3.cpu_profile }, v3.id_space]])
    {
        for(const [name, cores] of Object.entries(A64_PROFILES))
        {
            const result = await a64_runner.actual(directory, { cores, options });
            assert.equal(result.status, "ok", name + " on v86: " + result.text);
            const expected = { ...a64[name], registers: { ...a64[name].registers, ...changes } };
            const { problems, tolerated } = a64_compare(a64_profile, expected, a64_parse(result.text, cores));
            const differences = [...problems, ...tolerated];
            console.log(`${name}: v86 against ${variant}: ${differences.length} differences`);
            for(const line of differences) console.log("  " + line.replace("reference", "v86"));
            failed ||= differences.length > 0;
        }
    }
    // v3's AArch32 registers are the reference's but the fields its entry
    // lists (the reference's registers as --a64-reference saved them)
    for(const [name, cores] of Object.entries(A64_PROFILES))
    {
        const saved = root + `build/a64-linux/qemu-id_registers-${cores}c.txt`;
        if(!fs.existsSync(saved))
        {
            console.log(`${name}: no ${saved} (tools/cpu_contract.mjs --a64-reference): v3 not compared with the reference`);
            continue;
        }
        const aarch32 = key => /^S3_0_C0_C[123]_/.test(key) || key === "S3_0_C0_C4_0";
        const expected = { ...a64[name], registers: Object.fromEntries(Object.entries({ ...a64[name].registers, ...v3.id_space }).filter(([key]) => aarch32(key))) };
        const profile = { ...a64_profile, allowed_differences: { cpu: [{ registers: v3.reference_differences.registers }] } };
        const { problems, tolerated } = a64_compare(profile, expected, a64_parse(fs.readFileSync(saved, "utf8"), cores));
        console.log(`${name}: the reference's AArch32 registers against ${v3.profile}: ${tolerated.length} allowed differences, ${problems.length} others`);
        for(const line of problems) console.log("  " + line);
        failed ||= problems.length > 0;
    }
    return !failed;
}
if(process.argv.includes("--a64-v86")) process.exit(await a64_v86_check() ? 0 : 1);

const committed = fs.existsSync(contract_path) ? JSON.parse(fs.readFileSync(contract_path, "utf8")) : null;
const observed = process.argv.includes("--a64-only") ? Object.fromEntries(Object.entries(committed.profiles).filter(([name]) => !A64_PROFILES[name]))
    : await observe_x86();
Object.assign(observed, a64);
const vendor = regs => [regs[1], regs[3], regs[2]].map(r => Buffer.from(Uint32Array.of(parseInt(r, 16)).buffer).toString("latin1")).join("");
const document = {
    about: "Observed CPUID (EAX, EBX, ECX, EDX per leaf.subleaf) and RDMSR (EDX:EAX or #GP) of the bootstrap processor per profile; " +
        "the a64 profiles' ID registers (tests/a64/id_registers.c) are expected from tests/platform/a64-profile.json; " +
        "generated by tools/cpu_contract.mjs, checked by `node tools/cpu_contract.mjs --check`",
    vendor: vendor(observed["x64-1"].cpuid["0x00000000.0"]),
    profiles: observed,
};

if(process.argv.includes("--check"))
{
    assert.deepEqual(document, committed, "the CPU differs from tests/platform/cpu-contract.json " +
        "(update it with `node tools/cpu_contract.mjs` if the change is intended)");
    assert.ok(await a64_v86_check(), "v86's ARM core differs from tests/platform/a64-profile.json");
    console.log(`CPU contract matches (${Object.keys(PROFILES).length} profiles, ${LEAVES.length} CPUID leaves, ${MSRS.length} MSRs; ` +
        `${Object.keys(A64_PROFILES).join(", ")} match a64-profile.json, and v86's ARM core reads them)`);
}
else
{
    fs.mkdirSync(root + "tests/platform", { recursive: true });
    fs.writeFileSync(contract_path, JSON.stringify(document, null, 1) + "\n");
    console.log("wrote " + contract_path);
}
