// Local owner-supplied 10B329 files. No firmware is checked into this test.
// node tests/ios/boot.mjs build/ios/10B329 [--wait-root]
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { V86 } from "../../src/main.js";

const directory = process.argv[2];
if(!directory) throw new Error("provide the directory with the extracted N90 kernel and device tree");
const waitRoot = process.argv.includes("--wait-root");
const image = name => ({ url: path.resolve(directory, name) });
const emulator = new V86({
    machine_type: "s5l8930", apple_model: "iPhone3,1", graphics_adapter: "none",
    wasm_path: fileURLToPath(new URL("../../build/v86-arm64.wasm", import.meta.url)),
    ios: { kernelcache: image("kernelcache.n90.macho"), devicetree: image("DeviceTree.n90ap.bin") },
    autostart: false, log_level: 0,
});
let serial = "";
emulator.add_listener("serial0-output-byte", byte => { serial += String.fromCharCode(byte); });
try
{
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    const cpu = emulator.v86.cpu;
    assert.equal(cpu.profile, "cortex-a8");
    assert.equal(cpu.boot_entry, 0x40086084);
    const marker = waitRoot ? /waiting for root device/i : /corecrypto\.kext FIPS POST passed!/;
    const deadline = performance.now() + (waitRoot ? 600000 : 60000);
    cpu.clock.resume();
    while(!marker.test(serial) && !/panic\(cpu/.test(serial) && performance.now() < deadline)
    {
        cpu.run_cores();
    }
    process.stdout.write(serial);
    assert.match(serial, marker, "stopped at " + cpu.read_pc());
    assert.doesNotMatch(serial, /panic\(cpu/);
}
finally
{
    await emulator.destroy();
}
