// Original board plus a tiny private firmware; no patched guest clock.
// Verify compiled scalar PMGR reads, rollover, pause/restore and LDM fallback.
import assert from "node:assert/strict";
import path from "node:path";
import { V86 } from "../../src/main.js";
const directory = process.argv[2];
if(!directory) throw Error("usage: iop-counter.mjs owner-provided-10B329-directory");
const emulator = new V86({ machine_type: "s5l8930", graphics_adapter: "none", autostart: false, log_level: 0,
    wasm_path: path.resolve("build/v86-arm64.wasm"), jit_switches: { a64_page: 1 },
    ios: { kernelcache: { url: path.resolve(directory, "kernelcache.n90.macho") },
        devicetree: { url: path.resolve(directory, "DeviceTree.n90ap.bin") } } });
try
{
    await new Promise((resolve,reject) => { emulator.add_listener("emulator-loaded",resolve); emulator.add_listener("emulator-error",reject); });
    const cpu = emulator.v86.cpu, iop = cpu.devices.apple_iop, timer = cpu.devices.apple_timer;
    const base = 0x41000000, words = new Uint32Array([
        0xE3020000, 0xE34B0F10, 0xE3A02A01, 0xE5901000,
        0xE5821000, 0xE5903004, 0xE5823004, 0xEAFFFFFA,
    ]);
    cpu.write_blob_physical(new Uint8Array(words.buffer), base);
    iop.write(0x110,base); iop.write(0x114,8192); iop.write(0x100,1);
    const offset = cpu.ram_offset(base,8192), data = new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset+offset,8192);
    let reads = 0;
    const read = timer.read.bind(timer);
    timer.read = offset => { if(offset===0x2000 || offset===0x2004) reads++; return read(offset); };
    for(let n=0;n<60;n++) { iop.run(); await new Promise(resolve=>setImmediate(resolve)); }
    assert.ok(cpu.wm.exports.a32_iop_native()>0);
    for(const time of [0,1.25,2**32/24000+1000])
    {
        cpu.clock.set_time(time); reads=0;
        iop.run();
        const expected=timer.ticks();
        assert.equal(data.getUint32(4096,true),expected>>>0);
        assert.equal(data.getUint32(4100,true),Math.floor(expected/2**32));
        assert.equal(reads,0,"compiled scalar reads need no interpreter MMIO callback");
    }
    const saved=cpu.clock.get_state();
    cpu.clock.set_time(1); iop.run(); cpu.clock.set_state(saved); iop.run();
    assert.equal(data.getUint32(4096,true),timer.ticks()>>>0,"restored clock is read afresh");

    // A multi-register read must use the device for both words. It cannot
    // treat a single scalar bounce value as a contiguous device mapping.
    cpu.write_blob_physical(new Uint8Array(new Uint32Array([0xE890000A]).buffer),base+12);
    for(let n=0;n<60;n++) { iop.run(); await new Promise(resolve=>setImmediate(resolve)); }
    reads=0; iop.run();
    assert.ok(reads>0,"LDM keeps its original MMIO path");
    assert.equal(data.getUint32(4096,true),timer.ticks()>>>0);
    assert.equal(data.getUint32(4100,true),Math.floor(timer.ticks()/2**32));
    console.log("PASS: compiled scalar PMGR reads match the board clock across rollover and restore; LDM stays uncached");
}
finally { await emulator.destroy(); }
