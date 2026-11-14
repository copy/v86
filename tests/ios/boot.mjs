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
    jit_switches: process.argv.includes("--iop-jit") ? { a64_page: 1 } : undefined,
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
    if(process.argv.includes("--iop") || process.argv.includes("--iop-jit"))
    {
        // A tiny private ARM firmware increments its own local word. The
        // application CPU sees the alias in DRAM and retains its own PC.
        const base = 0x41000000, offset = cpu.ram_offset(base, 8192);
        const saved = cpu.mem8.slice(offset, offset + 16384), pc = cpu.read_pc();
        const program = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset + offset, 16384);
        [0xE3A00A01, 0xE5901000, 0xE2811001, 0xE5801000, 0xEAFFFFFB]
            .forEach((word, i) => program.setUint32(i * 4, word, true));
        program.setUint32(4096, 0, true);
        const iop = cpu.devices.apple_iop;
        iop.write(0x110, base);
        iop.write(0x114, 8192);
        iop.write(0x100, 1);
        iop.run();
        const firstSlice = program.getUint32(4096, true);
        if(process.argv.includes("--iop-jit"))
        {
            for(let n = 0; n < 50; n++) { iop.run(); await new Promise(resolve => setImmediate(resolve)); }
            assert.ok(cpu.wm.exports.a32_iop_native() > 0, "IOP executed compiled firmware");
        }
        const first = program.getUint32(4096, true);
        assert.ok(first > 0);
        assert.equal(cpu.read_pc(), pc);
        const state = iop.get_state();
        iop.run();
        const next = program.getUint32(4096, true);
        assert.ok(next > first);
        iop.set_state(state);
        program.setUint32(4096, first, true);
        iop.run();
        assert.equal(program.getUint32(4096, true), next);
        assert.equal(cpu.read_pc(), pc);
        if(process.argv.includes("--iop-jit"))
        {
            // The loop has filled the RAM access cache. Reuse its LDR
            // with an unaligned address: a cache hit must still abort.
            const bank = new DataView(cpu.wasm_memory.buffer, cpu.state_base, 4096);
            const setLoad = address => {
                cpu.wm.exports.a32_iop_select(true);
                bank.setBigUint64(64, BigInt(address), true);
                bank.setBigUint64(320, 4n, true);
                cpu.wm.exports.a32_iop_select(false);
            };
            setLoad(4097);
            cpu.wm.exports.a32_iop_slice(1, false, false);
            cpu.wm.exports.a32_iop_select(true);
            assert.equal(bank.getBigUint64(320, true), 0x10n, "unaligned cached IOP load takes Data Abort");
            assert.equal(bank.getUint32(332, true) & 31, 0x17);
            cpu.wm.exports.a32_iop_select(false);
            iop.set_state(state);
            setLoad(0x86300100);
            cpu.wm.exports.a32_iop_slice(1, false, false);
            cpu.wm.exports.a32_iop_select(true);
            assert.equal(bank.getUint32(72, true), 1, "MMIO still reads the ARM7M device, not cached RAM");
            cpu.wm.exports.a32_iop_select(false);
            iop.set_state(state);
            // Reusing VA zero with a different physical firmware must
            // select its own code and RAM instead of the old cached aliases.
            [0xE3A00A01, 0xE5901000, 0xE2811002, 0xE5801000, 0xEAFFFFFB]
                .forEach((word, i) => program.setUint32(8192 + i * 4, word, true));
            program.setUint32(12288, 0, true);
            const previousCount = program.getUint32(4096, true);
            iop.write(0x110, base + 8192);
            iop.write(0x100, 1);
            iop.run();
            assert.equal(program.getUint32(12288, true), firstSlice * 2, "remapped firmware uses new code and data backing");
            assert.equal(program.getUint32(4096, true), previousCount);
        }
        iop.reset();
        cpu.write_blob_physical(saved, base);
    }
    const marker = waitRoot ? /Waiting on [^\n]*IOMedia[^\n]*Apple_HFS|still waiting for root device/i : /corecrypto\.kext FIPS POST passed!/;
    const deadline = performance.now() + (waitRoot ? 600000 : 60000);
    cpu.clock.resume();
    const display = process.argv.includes("--display");
    const panel = /ApplePinotLCD: _lcdPanelID: 0x(?!00000000)[0-9a-f]+ _lcdPanelClass: [12]/i;
    const pipeline = /AppleCLCD::start_hardware[^\n]*clcdDitherCfg/;
    // Read the original driver's adopted boot-window geometry, not just
    // the emulator's fixed scanout dimensions. 10B329 logs its instance.
    const memory = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
    const kernelTTBR = new Uint32Array(cpu.wasm_memory.buffer, cpu.state_base + 944, 1);
    function kernelWord(address)
    {
        const physicalWord = physical => {
            const at = cpu.ram_offset(physical, 4);
            return at < 0 ? 0 : memory.getUint32(at, true);
        };
        const first = physicalWord((kernelTTBR[0] & 0xffffc000) + (address >>> 20) * 4);
        if((first & 3) === 2) return physicalWord(((first & 0xfff00000) + (address & 0xfffff)) >>> 0);
        if((first & 3) !== 1) return 0;
        const page = physicalWord(((first & 0xfffffc00) + ((address >>> 12) & 255) * 4) >>> 0);
        return page & 2 ? physicalWord(((page & 0xfffff000) + (address & 4095)) >>> 0) : 0;
    }
    function adoptedWindow()
    {
        const match = serial.match(/AppleCLCD\(0x([0-9a-f]+)\)::start_hardware/i);
        if(!match) return false;
        const instance = Number.parseInt(match[1], 16);
        return kernelWord(instance + 0x64) === 640 && kernelWord(instance + 0x68) === 960;
    }
    function displayTransport()
    {
        const fb = cpu.devices.apple_clcd, base = fb.regs[0x4044 >>> 2];
        return fb.regs[0x1048 >>> 2] > 0 && base < 0x10000000 && cpu.devices.apple_dart2.translate(base, 0) >= 0;
    }
    while((!marker.test(serial) || display && (!panel.test(serial) || !pipeline.test(serial) || !adoptedWindow() || !displayTransport())) && !/panic\(cpu/.test(serial) && performance.now() < deadline)
    {
        cpu.run_cores();
    }
    process.stdout.write(serial);
    if(display)
    {
        assert.match(serial, panel);
        assert.match(serial, pipeline);
        assert.ok(adoptedWindow(), "original display driver adopted a 640x960 boot window");
        console.log("PASS: original display driver adopted the enabled 640x960 boot window");
    }
    assert.match(serial, marker, "stopped at " + cpu.read_pc());
    assert.doesNotMatch(serial, /panic\(cpu/);
    if(process.argv.includes("--display"))
    {
        const fb = cpu.devices.apple_clcd;
        assert.ok(fb.regs[0x1048 >>> 2] > 0, "original driver completed a tagged LCD command batch");
        const base = fb.regs[0x4044 >>> 2];
        assert.ok(base < 0x10000000, "original driver switched scanout to a DART address");
        assert.ok(cpu.devices.apple_dart2.translate(base, 0) >= 0, "original driver installed the LCD page table");
        fb.render();
        const first = fb.shown.slice();
        assert.ok(first.some(p => (p & 0xFFFFFF) !== 0), "guest wrote visible pixels");
        assert.ok(first.some(p => (p & 0xFFFFFF) === 0), "guest background");
        const snapshot = await emulator.save_state();
        const addr = fb.regs[0x4044 >>> 2];
        const pages = fb.surface_pages(addr, first.byteLength);
        assert.ok(pages);
        for(const [physical, length] of pages) cpu.write_blob_physical(new Uint8Array(length), physical);
        fb.render();
        assert.ok(fb.shown.every(p => p === 0));
        await emulator.restore_state(snapshot);
        fb.render();
        assert.deepEqual(fb.shown, first);
        console.log("PASS: original tagged LCD commands, DART scanout pixels and framebuffer snapshot");
    }
}
finally
{
    await emulator.destroy();
}
