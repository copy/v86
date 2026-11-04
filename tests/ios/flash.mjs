// Exercise AppleARM7M and the 10B329 IOP against the N90 FMI command
// windows. This is a geometry/probe test, before an FTL volume is mounted.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { V86 } from "../../src/main.js";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { NAND_PAGE } from "../../src/apple/nand.js";

const dir = process.argv[2];
if(!dir) throw new Error("usage: flash.mjs extracted-10B329-directory");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "v86-n90-page-"));
const disk = path.join(temporary, "test.img"), pageFile = path.join(temporary, "page.bin");
const partition = process.argv.includes("--partition");
let emulator;
try
{
    const page = Buffer.alloc(NAND_PAGE, 0xFF);
    page.write("4N90");
    fs.writeFileSync(pageFile, page);
    execFileSync(process.execPath, [fileURLToPath(new URL("../../tools/ios/nand_build.mjs", import.meta.url)),
        ...(partition ? ["bootstrap", disk] : ["blank", disk, "0:0:0:" + pageFile])]);
    emulator = new V86({ machine_type: "s5l8930", graphics_adapter: "none", autostart: false, log_level: 0,
        wasm_path: fileURLToPath(new URL("../../build/v86-arm64.wasm", import.meta.url)),
        ios: { kernelcache: { url: path.resolve(dir, "kernelcache.n90.macho") },
            devicetree: { url: path.resolve(dir, "DeviceTree.n90ap.bin") }, nand: { url: disk, size: fs.statSync(disk).size } } });
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    let read = false, serial = "";
    emulator.add_listener("serial0-output-byte", b => { serial += String.fromCharCode(b); });
    const cpu = emulator.v86.cpu, iop = cpu.devices.apple_iop;
    for(const fmi of [cpu.devices.apple_fmi0, cpu.devices.apple_fmi1])
    {
        const original = fmi.write.bind(fmi);
        fmi.write = (offset, value) => {
            if(offset === 0x1014 && value === 0x3000 && cpu.wm.exports.a64_current_core() === 1) read = true;
            original(offset, value);
        };
    }
    const end = performance.now() + 120000;
    cpu.clock.resume();
    // IOFlashStorage prints the rejected fourcc most significant byte
    // first, proving the IOP, H2FMI, CDMA and AP partition parser agree.
    const marker = partition ? "VFL Init            [OK]" : "bad magic - 09N4";
    while(!serial.includes(marker) && !serial.includes("panic(cpu") && performance.now() < end)
    {
        for(let i = 0; i < 24; i++) cpu.run_cores();
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(iop.running && read && serial.includes(marker) && !serial.includes("panic(cpu"), serial.slice(-2000));
    assert.equal(iop.regs[0x114 >>> 2], 0x40000);
    assert.equal(cpu.wm.exports.a64_current_core(), 0);
    if(process.argv.includes("--snapshot"))
    {
        const snapshot = await emulator.save_state();
        const fmi = cpu.devices.apple_fmi0;
        const before = fmi.get_state(), regs = before[0].slice();
        fmi.reset();
        await emulator.restore_state(snapshot);
        assert.deepEqual(fmi.regs, regs);
        assert.deepEqual(fmi.page, before[3]);
        assert.equal(fmi.column, before[4]);
    }
    if(partition)
    {
        assert.ok(serial.includes("read valid partition table") && serial.includes("published partition 4") &&
            serial.includes("VSVFL Register  [OK]") && serial.includes("AppleNANDLegacyFTL located at physical nand block offset 15"), serial.slice(-2500));
        console.log("PASS: 10B329 accepted the physical partition map and LegacyFTL initialized VSVFL from the factory records");
    }
    else console.log("PASS: 10B329 IOP read the image and CDMA delivered its page marker to the guest partition parser");
}
finally
{
    await emulator?.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
}
