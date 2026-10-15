#!/usr/bin/env node
// Embedder options for 64-bit guests:
// - memory_size above the wasm32 limit is reduced to 2 GiB - 128 KiB instead
//   of wrapping (8 GiB used to become 0 bytes, then the BIOS load failed);
// - cpu_type: "x86_64" presents the x86-64 CPU profile: CPUID.80000001h:EDX
//   long mode (bit 29), NX (20) and SYSCALL (11) only when it is set; an
//   unknown cpu_type, or the removed experimental_x64, fails in the
//   constructor (and so does arm64 with a PC display).
import assert from "node:assert/strict";
import url from "node:url";
import {assemble, actual} from "./guest_runner.mjs";

const root = url.fileURLToPath(new URL("../../", import.meta.url));
const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const MAX = 2 ** 31 - 128 * 1024;

for(const gib of [4, 6, 8])
{
    const emulator = new V86({graphics_adapter: "bochs_vga", bios: {url: root + "bios/seabios.bin"}, vga_bios: {url: root + "bios/vgabios.bin"},
        memory_size: gib * 2 ** 30, autostart: false, log_level: 0});
    const error = await new Promise(resolve => {
        emulator.add_listener("emulator-loaded", () => resolve(null));
        emulator.add_listener("emulator-error", resolve);
    });
    assert.equal(error, null, `${gib} GiB: ${error}`);
    assert.equal(emulator.v86.cpu.memory_size[0] >>> 0, MAX, `${gib} GiB is reduced to the maximum`);
    await emulator.destroy();
    console.log(`PASS memory_size ${gib} GiB loads with ${MAX / 2 ** 20} MiB`);
}

const directory = assemble("profile-options", `bits 32
org 0x100000
header:
dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)
dd header,header,image_end,image_end,start
start:
mov eax,0x80000001
cpuid
mov [0x300004],edx
mov dword [0x300000],0xC064C064
hlt
jmp $
image_end:
`);
const X64_EDX = 1 << 29 | 1 << 20 | 1 << 11;
for(const [options, expected] of [
    [{}, 0],
    [{cpu_type: "x86"}, 0],
    [{cpu_type: "x86_64"}, X64_EDX],
])
{
    const result = await actual(directory, {length: 8, options});
    const edx = result.readUInt32LE(4);
    const name = JSON.stringify(options);
    assert.equal(edx & X64_EDX, expected >>> 0, `${name}, EDX ${edx.toString(16)}`);
    console.log(`PASS ${name} -> CPUID.80000001h:EDX ${edx.toString(16)}`);
}

for(const cpu_type of ["aarch64", "x86-64", ""])
{
    assert.throws(() => new V86({graphics_adapter: "bochs_vga", cpu_type, autostart: false}),
        /Unknown cpu_type .*supported: "x86", "x86_64", "arm64"/, `cpu_type ${JSON.stringify(cpu_type)} is refused`);
    console.log(`PASS cpu_type ${JSON.stringify(cpu_type)} is refused`);
}
// (arm64 runs on machine_type "virt", which has no VGA: tests/api/arm64-options.js)
assert.throws(() => new V86({graphics_adapter: "bochs_vga", cpu_type: "arm64", autostart: false}), /is not on machine_type "virt"/);
console.log("PASS cpu_type \"arm64\" with a PC display is refused");
for(const experimental_x64 of [true, false])
{
    assert.throws(() => new V86({graphics_adapter: "bochs_vga", experimental_x64, autostart: false}),
        /experimental_x64 was replaced by cpu_type: "x86_64"/, `experimental_x64: ${experimental_x64} is refused`);
    console.log(`PASS experimental_x64: ${experimental_x64} is refused`);
}
