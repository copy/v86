// S3 acceptance against a private kernel and copy of the restore ramdisk.
import assert from "node:assert/strict";
import fs from "node:fs";
import { crc32 } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { V86 } from "../../src/main.js";

const [kernel, dt, disk, mode, nand, system, ...extra] = process.argv.slice(2);
if(!disk || extra.length || (mode && !["--gles", "--frame", "--native-frame", "--nand", "--scratch"].includes(mode)) ||
    (mode === "--nand" ? !nand || !system : mode === "--scratch" ? !nand || system : nand || system))
    throw new Error("usage: recovery.mjs kernel device-tree debug-ramdisk [--gles|--frame|--native-frame|--nand flash.img system.hfs|--scratch disposable.img]");
const graphics = mode === "--gles" || mode === "--frame" || mode === "--native-frame";
const file = name => ({ url: path.resolve(name) });
const renderer = mode === "--frame" || mode === "--native-frame" ? await (await import("../gles/chrome_renderer.mjs")).chrome_renderer() : null;
const emulator = new V86({
    machine_type: "s5l8930", graphics_adapter: "none", log_level: 0, autostart: false,
    gles_backdoor: graphics,
    graphics_adapter_renderer_channel: renderer || (graphics ? { post() {}, listen() {} } : null),
    wasm_path: fileURLToPath(new URL("../../build/v86-arm64.wasm", import.meta.url)),
    ios: { kernelcache: file(kernel), devicetree: file(dt), ramdisk: file(disk),
        nand: nand ? { url: path.resolve(nand), size: fs.statSync(nand).size } : undefined, boot_args: "-v serial=3 rd=md0" },
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
    const until = async (offset, text) => {
        const deadline = performance.now() + (nand ? 600000 : 120000);
        while(!serial.includes(text, offset) && !serial.includes("panic(cpu") && performance.now() < deadline)
        {
            for(let i = 0; i < 32; i++) cpu.run_cores();
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.ok(!serial.includes("panic(cpu") && serial.includes(text, offset), serial.slice(-3000));
    };
    await until(0, "N90 recovery shell");
    await until(serial.indexOf("N90 recovery shell"), "# ");
    const command = async text => {
        const start = serial.length;
        emulator.serial0_send(text + "\n");
        await until(start, "# ");
        return serial.slice(start);
    };
    assert.match(await command("uname -a"), /Darwin 13\.0\.0 [\s\S]*RELEASE_ARM_S5L8930X iPhone3,1/);
    const hardware = await command("sysctl hw");
    assert.match(hardware, /hw\.machine = iPhone3,1/);
    assert.match(hardware, /hw\.ncpu = 1/);
    assert.match(hardware, /hw\.physmem = [1-9]\d+/);
    if(graphics) assert.match(await command("gles display"), /GLES display 640x960 326 dpi/);
    if(nand) await until(0, "LwVM::_partitionsFromConfig - loaded configuration for 2 partitions");
    if(mode === "--scratch")
    {
        assert.match(await command("nand roundtrip"), /NAND scratch 4 MiB roundtrip passed/);
        console.log("PASS: native iOS raw writes, close, reopen and byte-for-byte readback on disposable NAND");
    }
    if(mode === "--nand")
    {
        const raw = await command("nand crc");
        const expected = [], block = Buffer.alloc(4 * 1024 * 1024), fd = fs.openSync(system, "r");
        try
        {
            let crc = 0;
            for(let i = 0; i < 8; i++)
            {
                assert.equal(fs.readSync(fd, block), block.length);
                crc = crc32(block, crc);
                expected.push(crc.toString(16).padStart(8, "0"));
            }
        }
        finally { fs.closeSync(fd); }
        assert.deepEqual(Array.from(raw.matchAll(/NAND CRC ([0-9a-f]{8})/g), m => m[1]), expected, raw);
        console.log("PASS: 32 MiB read through the guest raw NAND device matches the supplied HFS volume");
    }
    if(renderer)
    {
        const frame = await command("gles frame");
        assert.match(frame, /GLES frame matched 64 pixels/);
        if(mode === "--native-frame") assert.match(frame, /Native OpenGLES driver callbacks completed/);
        const panel = cpu.devices.apple_clcd;
        const deadline = performance.now() + 10000;
        while(!renderer.stats.frames && performance.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(renderer.stats.frames > 0, "WebGPU did not return the posted frame");
        panel.render();
        for(let y = 0; y < 960; y++)
            for(let x = 0; x < 640; x++)
                assert.equal(panel.shown[y * 640 + x], y >= 958 && x < 2 ? 0xff0000 : 0x00ff00);
        const expected = panel.shown.slice();
        const snapshot = await emulator.save_state();
        cpu.write_blob_physical(new Uint8Array(expected.byteLength), panel.regs[0x4044 >>> 2]);
        panel.render();
        assert.ok(panel.shown.every(pixel => pixel === 0));
        await emulator.restore_state(snapshot);
        panel.render();
        assert.deepEqual(panel.shown, expected);
        console.log("PASS: WebGPU returned the guest frame to all 640x960 pixels of the CLCD window and the frame survived snapshot restore");
    }
    console.log(serial.slice(serial.indexOf("N90 recovery shell")));
}
finally
{
    try { await emulator.destroy(); }
    finally { renderer?.close(); }
}
