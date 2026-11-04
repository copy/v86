// Exercise AppleARM7M and the 10B329 IOP against the N90 FMI command
// windows. This is a geometry/probe test, before an FTL volume is mounted.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { V86 } from "../../src/main.js";
import { dt_find, dt_parse, dt_set, dt_serialize } from "../../src/apple/devicetree.js";

const dir = process.argv[2];
if(!dir) throw new Error("usage: flash.mjs extracted-10B329-directory");
const root = dt_parse(fs.readFileSync(path.join(dir, "DeviceTree.n90ap.bin")));
const flash = dt_find(root, "/arm-io/flash-controller0/disk");
const ids = new Uint8Array(256);
for(let bus = 0; bus < 2; bus++)
    for(let ce = 0; ce < 2; ce++) ids.set([0xEC, 0xD7, 0x94, 0x72], 8 * (16 * bus + ce));
dt_set(flash, "dbg-chipids", ids);
const geometry = { "#ce": 4, "#databus": 2, "ce-bitmap": 0x30003, "#ce-blocks": 0x1038,
    "#block-pages": 128, "#page-bytes": 8192, "#spare-bytes": 436, "#die-ce": 1,
    "logical-page-size": 4096, "meta-per-logical-page": 12, "valid-meta-per-logical-page": 12,
    "ecc-correctable": 8, "ecc-threshold": 8, "block-bits": 13, "page-bits": 7,
    "bbt-format": 8, "vendor-type": 0x10001, "max-transaction-size": 65536 };
for(const [name, value] of Object.entries(geometry))
{
    const cell = Buffer.alloc(4);
    cell.writeUInt32LE(value);
    dt_set(flash, name, cell);
}
const clocks = Buffer.alloc(256);
clocks.writeUInt32LE(100000000, 4 * 0x21);
dt_set(dt_find(root, "/arm-io"), "clock-frequencies", clocks);
const emulator = new V86({ machine_type: "s5l8930", graphics_adapter: "none", autostart: false, log_level: 0,
    wasm_path: fileURLToPath(new URL("../../build/v86-arm64.wasm", import.meta.url)),
    ios: { kernelcache: { url: path.resolve(dir, "kernelcache.n90.macho") }, devicetree: { buffer: dt_serialize(root).buffer } } });
try
{
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
    while(!read && !serial.includes("panic(cpu") && performance.now() < end) cpu.run_cores();
    assert.ok(iop.running && read, serial.slice(-2000));
    assert.equal(iop.regs[0x114 >>> 2], 0x40000);
    assert.equal(cpu.wm.exports.a64_current_core(), 0);
    console.log("PASS: 10B329 IOP firmware issued NAND READ from its own CPU and 256 KiB remap");
}
finally { await emulator.destroy(); }
