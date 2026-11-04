// Local owner-supplied 10B329 files. No firmware is checked into this test.
// node tests/ios/boot.mjs build/ios/10B329 [--wait-root]
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { V86 } from "../../src/main.js";

const directory = process.argv[2];
if(!directory) throw new Error("provide the directory with the extracted N90 kernel and device tree");
const bootlogo = process.argv.includes("--logo") ? { url: path.resolve(directory, "AppleLogo.ibootim") } : undefined;
const waitRoot = process.argv.includes("--wait-root");
const image = name => ({ url: path.resolve(directory, name) });
const emulator = new V86({
    machine_type: "s5l8930", apple_model: "iPhone3,1", graphics_adapter: "none",
    wasm_path: fileURLToPath(new URL("../../build/v86-arm64.wasm", import.meta.url)),
    ios: { bootlogo, kernelcache: image("kernelcache.n90.macho"), devicetree: image("DeviceTree.n90ap.bin") },
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
    if(bootlogo)
    {
        const frame = cpu.devices.apple_clcd.shown;
        assert.ok(frame.some(pixel => pixel !== 0), "iBootIm drawn before XNU starts");
        assert.equal(frame[0], 0);
    }
    if(process.argv.includes("--iop"))
    {
        // A tiny private ARM firmware increments its own local word. The
        // application CPU sees the alias in DRAM and retains its own PC.
        const base = 0x41000000, offset = cpu.ram_offset(base, 4096);
        const saved = cpu.mem8.slice(offset, offset + 4096), pc = cpu.read_pc();
        const program = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset + offset, 4096);
        [0xE3A00080, 0xE5901000, 0xE2811001, 0xE5801000, 0xEAFFFFFB]
            .forEach((word, i) => program.setUint32(i * 4, word, true));
        program.setUint32(128, 0, true);
        const iop = cpu.devices.apple_iop;
        iop.write(0x110, base);
        iop.write(0x114, 4096);
        iop.write(0x100, 1);
        iop.run();
        const first = program.getUint32(128, true);
        assert.ok(first > 0);
        assert.equal(cpu.read_pc(), pc);
        const state = iop.get_state();
        iop.run();
        const next = program.getUint32(128, true);
        assert.ok(next > first);
        iop.set_state(state);
        program.setUint32(128, first, true);
        iop.run();
        assert.equal(program.getUint32(128, true), next);
        assert.equal(cpu.read_pc(), pc);
        iop.reset();
        cpu.write_blob_physical(saved, base);
    }
    const marker = waitRoot ? /Waiting on [^\n]*IOMedia[^\n]*Apple_HFS|still waiting for root device/i : /corecrypto\.kext FIPS POST passed!/;
    const deadline = performance.now() + (waitRoot ? 600000 : 60000);
    cpu.clock.resume();
    const display = process.argv.includes("--display");
    const panel = /ApplePinotLCD: _lcdPanelID: 0x(?!00000000)[0-9a-f]+ _lcdPanelClass: [12]/i;
    const pipeline = /AppleCLCD::start_hardware[^\n]*clcdDitherCfg/;
    while((!marker.test(serial) || display && (!panel.test(serial) || !pipeline.test(serial))) && !/panic\(cpu/.test(serial) && performance.now() < deadline)
    {
        cpu.run_cores();
    }
    process.stdout.write(serial);
    if(display)
    {
        assert.match(serial, panel);
        assert.match(serial, pipeline);
    }
    assert.match(serial, marker, "stopped at " + cpu.read_pc());
    assert.doesNotMatch(serial, /panic\(cpu/);
    if(process.argv.includes("--display"))
    {
        const fb = cpu.devices.apple_clcd;
        fb.render();
        const first = fb.shown.slice();
        assert.ok(first.some(p => (p & 0xFFFFFF) !== 0), "guest wrote visible pixels");
        assert.ok(first.some(p => (p & 0xFFFFFF) === 0), "guest background");
        const snapshot = await emulator.save_state();
        const addr = fb.regs[0x4044 >>> 2];
        cpu.write_blob_physical(new Uint8Array(first.byteLength), addr);
        fb.render();
        assert.ok(fb.shown.every(p => p === 0));
        await emulator.restore_state(snapshot);
        fb.render();
        assert.deepEqual(fb.shown, first);
        console.log("PASS: guest boot text and framebuffer snapshot");
    }
}
finally
{
    await emulator.destroy();
}
