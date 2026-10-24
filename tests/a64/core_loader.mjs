#!/usr/bin/env node
// The loader picks the core of the CPU's family and refuses the other
// (docs/arm64-virt-android16-plan.md P1.3): the ARM core with cpu_type x86 or
// the x86 core with cpu_type arm64 is an error at startup, never a machine
// that runs the wrong instruction set.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

async function start(options)
{
    const emulator = new V86({ autostart: false, log_level: 0, ...options });
    try
    {
        return await new Promise((resolve, reject) => {
            emulator.add_listener("emulator-loaded", () => resolve(emulator.v86.cpu.cpu_type || "x86"));
            emulator.add_listener("emulator-error", reject);
        });
    }
    finally
    {
        await emulator.destroy();
    }
}

assert.equal(await start({ cpu_type: "arm64", graphics_adapter: "none", memory_size: 16 << 20, wasm_path: root + "build/v86-arm64.wasm" }), "arm64");
console.log("PASS cpu_type arm64 with the ARM core");
await assert.rejects(start({ cpu_type: "arm64", graphics_adapter: "none", memory_size: 16 << 20, wasm_path: root + "build/v86.wasm" }),
    /The Wasm core is the x86 core \(v86.wasm\), cpu_type is "arm64"/);
console.log("PASS the x86 core with cpu_type arm64 is refused");
await assert.rejects(start({ graphics_adapter: "none", memory_size: 16 << 20, wasm_path: root + "build/v86-arm64.wasm",
    bios: { url: root + "bios/seabios.bin" } }), /The Wasm core is the ARM core \(v86-arm64.wasm\), cpu_type is "x86"/);
console.log("PASS the ARM core with cpu_type x86 is refused");
assert.equal(await start({ cpu_type: "arm32", graphics_adapter: "none", memory_size: 16 << 20, wasm_path: root + "build/v86-arm64.wasm" }), "arm32");
console.log("PASS cpu_type arm32 with the ARM core");
await assert.rejects(start({ cpu_type: "arm32", graphics_adapter: "none", memory_size: 16 << 20, wasm_path: root + "build/v86.wasm" }),
    /The Wasm core is the x86 core \(v86.wasm\), cpu_type is "arm32"/);
console.log("PASS the x86 core with cpu_type arm32 is refused");
