// Direct NAND boot, with no recovery disk. The kernel must pick the BSD
// root device from the system partition published by LwVM.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { V86 } from "../../src/main.js";

const [firmware, image, option, debugKernel] = process.argv.slice(2);
if(option && (option !== "--debug-kernel" || !debugKernel)) throw new Error("expected --debug-kernel local-kernel.macho");
if(!firmware || !image) throw new Error("usage: system.mjs extracted-10B329-directory flash.img [--debug-kernel local-kernel.macho]");
const file = name => ({ url: path.resolve(firmware, name) });
const emulator = new V86({
    machine_type: "s5l8930", graphics_adapter: "none", log_level: 0, autostart: false,
    wasm_path: fileURLToPath(new URL("../../build/v86-arm64.wasm", import.meta.url)),
    ios: { kernelcache: debugKernel ? { url: path.resolve(debugKernel) } : file("kernelcache.n90.macho"), devicetree: file("DeviceTree.n90ap.bin"),
        nand: { url: path.resolve(image), size: fs.statSync(image).size } },
});
try
{
    let serial = "";
    emulator.add_listener("serial0-output-byte", byte => { serial += String.fromCharCode(byte); });
    await new Promise((ok, fail) => {
        emulator.add_listener("emulator-loaded", ok);
        emulator.add_listener("emulator-error", fail);
    });
    const root = "BSD root: disk0s1s1, major ";
    const end = performance.now() + (debugKernel ? 600000 : 180000);
    const marker = debugKernel ? "launchd[1] has started up" : root;
    const cpu = emulator.v86.cpu;
    cpu.clock.resume();
    while(!serial.includes(marker) && !serial.includes("panic(cpu") && performance.now() < end)
    {
        for(let i = 0; i < 24; i++) cpu.run_cores();
        await new Promise(ok => setImmediate(ok));
    }
    assert.ok(serial.includes("FTL_Open            [OK]") &&
        serial.includes("loaded configuration for 2 partitions") && serial.includes(root) && serial.includes(marker) &&
        !serial.includes("panic(cpu"), serial.slice(-2600));
    console.log(debugKernel ? "PASS: the local debug kernel ran the system volume’s launchd as PID 1 from NAND" :
        "PASS: the original kernel reads LwVM from NAND and selects disk0s1s1 as BSD root");
}
finally { await emulator.destroy(); }
