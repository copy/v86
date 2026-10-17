#!/usr/bin/env node
// The CPU features of docs/simd-xsave-plan.md (src/cpu_features.js, setting
// cpu_features): CPUID reports exactly the requested features (not given:
// every released one for x86_64, the owner's decision of 2026-10-17, none for
// x86; [] none), a preset names a set, cpuid_level leaves out what it cannot report together with what
// requires it, and an unknown feature, one the profile cannot have or one
// without its requirements fails. Every milestone is released (M1
// x86-64-v2, M2 XSAVE, M3 AVX, M4 x86-64-v3, M5 the XSAVE family): no feature
// is listed as unreleased (that would warn unless cpu_features_unreleased).
import assert from "node:assert/strict";
import url from "node:url";
import {assemble, actual} from "./guest_runner.mjs";

const root = url.fileURLToPath(new URL("../../", import.meta.url));
const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const {unreleased_cpu_features} = await import("../../src/cpu.js");

const directory = assemble("cpu-features", `bits 32
org 0x100000
header:
dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)
dd header,header,image_end,image_end,start
start:
xor eax,eax
cpuid
mov [0x300004],eax
mov eax,1
cpuid
mov [0x300008],ecx
mov eax,7
xor ecx,ecx
cpuid
mov [0x30000C],ebx
mov eax,0x80000001
cpuid
mov [0x300010],ecx
mov eax,0xD
mov ecx,1
cpuid
mov [0x300014],eax
mov dword [0x300000],0xC064C064
hlt
jmp $
image_end:
`);

// CPUID bits of the plan's features: leaf 1 ECX, leaf 7 EBX, 80000001h ECX,
// leaf 0Dh subleaf 1 EAX
const LEAF1 = {SSSE3: 9, FMA: 12, "SSE4.1": 19, "SSE4.2": 20, MOVBE: 22, XSAVE: 26, AVX: 28, F16C: 29};
const LEAF7 = {BMI1: 3, AVX2: 5, BMI2: 8};
const EXT1 = {LZCNT: 5};
const LEAFD1 = {XSAVEOPT: 0, XSAVEC: 1, XGETBV1: 2, XSAVES: 3};
const mask = (table, names) => names.filter(n => n in table).reduce((m, n) => m | 1 << table[n], 0);
const all = table => mask(table, Object.keys(table));
const V2 = ["SSSE3", "SSE4.1", "SSE4.2"];
const V3 = [...V2, "XSAVE", "AVX", "AVX2", "FMA", "F16C", "BMI1", "BMI2", "LZCNT", "MOVBE"];
// (the 32-bit profile: x86-64-v3's features but LZCNT, plan Q7)
const LEGACY_V3 = V3.filter(name => name !== "LZCNT");
const XSAVE_FAMILY = ["XSAVE", "XSAVEOPT", "XSAVEC", "XGETBV1", "XSAVES"];

for(const [options, expected, level] of [
    [{}, []],
    [{cpu_type: "x86_64"}, [...V3, ...XSAVE_FAMILY.slice(1)]],
    [{cpu_type: "x86_64", cpu_features: []}, []],
    [{cpu_features: [...V2, "BMI1", "BMI2", "MOVBE"], cpu_features_unreleased: true}, [...V2, "BMI1", "BMI2", "MOVBE"]],
    [{cpu_features: "x86-64-v2"}, V2],
    [{cpu_features: ["XSAVE"]}, ["XSAVE"]],
    [{cpu_type: "x86_64", cpu_features: [...V2, "XSAVE", "AVX"]}, [...V2, "XSAVE", "AVX"]],
    [{cpu_type: "x86_64", cpu_features: "x86-64-v3"}, V3],
    [{cpu_type: "x86_64", cpu_features: "x86-64-v3", cpu_features_unreleased: true}, V3],
    [{cpu_features: LEGACY_V3}, LEGACY_V3],
    [{cpu_features: XSAVE_FAMILY}, XSAVE_FAMILY],
    [{cpu_type: "x86_64", cpu_features: [...V3, ...XSAVE_FAMILY.slice(1)]}, [...V3, ...XSAVE_FAMILY.slice(1)]],
    // leaf 0xD is out of reach: XSAVE goes, and AVX, AVX2, FMA, F16C and the
    // XSAVE family with it
    [{cpu_type: "x86_64", cpu_features: [...V3, ...XSAVE_FAMILY.slice(1)], cpuid_level: 7}, [...V2, "BMI1", "BMI2", "LZCNT", "MOVBE"], 7],
    // the Windows NT setting: neither leaf 7 nor leaf 0xD
    [{cpu_features: [...V2, "BMI1", "MOVBE"], cpu_features_unreleased: true, cpuid_level: 2}, [...V2, "MOVBE"], 2],
])
{
    const result = await actual(directory, {length: 24, options});
    const name = JSON.stringify(options);
    const [leaf0, leaf1, leaf7, ext1, leafd1] = [4, 8, 12, 16, 20].map(at => result.readUInt32LE(at));
    assert.equal(leaf1 & all(LEAF1), mask(LEAF1, expected), `${name}: CPUID.1:ECX ${leaf1.toString(16)}`);
    assert.equal(leaf7 & all(LEAF7), mask(LEAF7, expected), `${name}: CPUID.7.0:EBX ${leaf7.toString(16)}`);
    assert.equal(ext1 & all(EXT1), mask(EXT1, expected), `${name}: CPUID.80000001h:ECX ${ext1.toString(16)}`);
    // (leaf 0xD's subleaf 1 only where leaf 0xD is reported)
    if(expected.includes("XSAVE")) assert.equal(leafd1 & all(LEAFD1), mask(LEAFD1, expected), `${name}: CPUID.0Dh.1:EAX ${leafd1.toString(16)}`);
    if(level !== undefined) assert.equal(leaf0, level, `${name}: maximum basic leaf`);
    console.log(`PASS ${name} -> ${expected.join(" ") || "no plan features"}`);
}

for(const [options, message] of [
    [{cpu_features: ["LZCNT"]}, /LZCNT needs cpu_type: "x86_64"/],
    [{cpu_features: "x86-64-v3"}, /LZCNT needs cpu_type: "x86_64"/],
    [{cpu_features: ["SSE4.1"]}, /SSE4\.1 requires SSSE3/],
    [{cpu_type: "x86_64", cpu_features: ["AVX", "SSSE3", "SSE4.1", "SSE4.2"]}, /AVX requires XSAVE/],
    [{cpu_features: ["AVX512F"]}, /unknown feature "AVX512F"/],
    [{cpu_features: "x86-64-v4"}, /unknown preset "x86-64-v4"/],
])
{
    const emulator = new V86({graphics_adapter: "bochs_vga", bios: {url: root + "bios/seabios.bin"}, vga_bios: {url: root + "bios/vgabios.bin"},
        autostart: false, log_level: 0, ...options});
    const error = await new Promise(resolve => {
        emulator.add_listener("emulator-loaded", () => resolve(null));
        emulator.add_listener("emulator-error", resolve);
    });
    assert.match(String(error), message, JSON.stringify(options));
    await emulator.destroy();
    console.log(`PASS ${JSON.stringify(options)} is refused`);
}

// a snapshot keeps the CPU its guest saw: a machine whose features were not
// chosen takes the snapshot's, one given cpu_features refuses other ones
{
    const machine = async options => {
        const emulator = new V86({graphics_adapter: "bochs_vga", bios: {url: root + "bios/seabios.bin"}, vga_bios: {url: root + "bios/vgabios.bin"},
            autostart: false, log_level: 0, cpu_type: "x86_64", ...options});
        await new Promise((resolve, reject) => {
            emulator.add_listener("emulator-loaded", resolve);
            emulator.add_listener("emulator-error", reject);
        });
        return emulator;
    };
    const baseline = await machine({cpu_features: []});
    const state = await baseline.save_state();
    await baseline.destroy();
    const defaulted = await machine({});
    assert.notEqual(defaulted.v86.cpu.cpu_features, 0, "x86_64's default features");
    await defaulted.restore_state(state);
    assert.equal(defaulted.v86.cpu.cpu_features, 0, "the restored machine has the snapshot's features");
    assert.equal(defaulted.v86.cpu.wm.exports["get_cpu_features"](), 0, "and so has the core");
    await defaulted.destroy();
    const chosen = await machine({cpu_features: "x86-64-v3"});
    await assert.rejects(chosen.restore_state(state), /The snapshot is from a machine with the CPU features none/);
    await chosen.destroy();
    console.log("PASS a snapshot's CPU features: taken by a machine with the default, refused by one with cpu_features");
}

for(const requested of [undefined, "x86-64-v2", "x86-64-v3", ["SSSE3", "XSAVE"], LEGACY_V3, [...V3, ...XSAVE_FAMILY]])
{
    assert.deepEqual(unreleased_cpu_features(requested), [], JSON.stringify(requested));
}
console.log("PASS every feature of M1-M5 (x86-64-v2, XSAVE, AVX, x86-64-v3, the XSAVE family) is released");
