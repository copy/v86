// S3 acceptance against a private kernel and copy of the restore ramdisk.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { V86 } from "../../src/main.js";

const [kernel, dt, disk] = process.argv.slice(2);
if(!disk) throw new Error("usage: recovery.mjs patched-kernel device-tree debug-ramdisk");
const file = name => ({ url: path.resolve(name) });
const emulator = new V86({
    machine_type: "s5l8930", graphics_adapter: "none", log_level: 0, autostart: false,
    wasm_path: fileURLToPath(new URL("../../build/v86-arm64.wasm", import.meta.url)),
    ios: { kernelcache: file(kernel), devicetree: file(dt), ramdisk: file(disk), boot_args: "-v serial=3 rd=md0" },
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
    cpu.clock.resume();
    const until = (offset, text) => {
        const deadline = performance.now() + 120000;
        while(!serial.includes(text, offset) && !serial.includes("panic(cpu") && performance.now() < deadline) cpu.run_cores();
        assert.ok(!serial.includes("panic(cpu") && serial.includes(text, offset), serial.slice(-3000));
    };
    until(0, "N90 recovery shell");
    until(serial.indexOf("N90 recovery shell"), "# ");
    const command = text => {
        const start = serial.length;
        emulator.serial0_send(text + "\n");
        until(start, "# ");
        return serial.slice(start);
    };
    assert.match(command("uname -a"), /Darwin 13\.0\.0 [\s\S]*RELEASE_ARM_S5L8930X iPhone3,1/);
    const hardware = command("sysctl hw");
    assert.match(hardware, /hw\.machine = iPhone3,1/);
    assert.match(hardware, /hw\.ncpu = 1/);
    assert.match(hardware, /hw\.physmem = [1-9]\d+/);
    console.log(serial.slice(serial.indexOf("N90 recovery shell")));
}
finally { await emulator.destroy(); }
