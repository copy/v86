// Original YAFTL dirty recovery on fresh media built from owner-supplied HFS volumes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { V86 } from "../../src/main.js";

const [directory, system, data, ...extra] = process.argv.slice(2);
if(!directory || !system || !data || extra.length)
    throw new Error("usage: nand-reboot.mjs firmware-directory system.hfs data.hfs");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "n90-nand-reboot-"));
const image = path.join(temporary, "flash.img"), firmware = path.resolve(directory);

async function boot(round)
{
    console.log("Starting NAND boot " + round);
    const emulator = new V86({
        machine_type: "s5l8930", graphics_adapter: "none", autostart: false, log_level: 0,
        wasm_path: fileURLToPath(new URL("../../build/v86-arm64.wasm", import.meta.url)),
        ios: { kernelcache: { url: path.join(firmware, "kernelcache.n90.macho") },
            devicetree: { url: path.join(firmware, "DeviceTree.n90ap.bin") },
            nand: { url: image, size: fs.statSync(image).size } },
    });
    let serial = "";
    emulator.add_listener("serial0-output-byte", byte => { serial += String.fromCharCode(byte); });
    try
    {
        await new Promise((resolve, reject) => {
            emulator.add_listener("emulator-loaded", resolve);
            emulator.add_listener("emulator-error", reject);
        });
        // Dirty recovery also runs the original filesystem checker. Give that
        // CPU-intensive scan a larger bound than the initial clean mount.
        const cpu = emulator.v86.cpu, deadline = performance.now() + (round === 2 ? 1800000 : 300000);
        const mounted = "/dev/disk0s1s2 on /private/var (hfs, local, nodev, nosuid";
        cpu.clock.resume();
        let loops = 0;
        while(!serial.includes(mounted) && !serial.includes("panic(cpu") && performance.now() < deadline)
        {
            for(let i = 0; i < 24; i++) cpu.run_cores();
            loops += 24;
            if(loops % 480000 === 0) console.log("NAND boot " + round + ": " + loops + " CPU slices");
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.ok(serial.includes("FTL_Open            [OK]") && serial.includes(mounted),
            "NAND boot " + round + ": " + serial.slice(-4000));
        console.log("NAND boot " + round + ": original FTL and both HFS mounts ready");
        // Allow the mounted filesystem's initial metadata writes to finish.
        for(let i = 0; i < 24000; i++)
        {
            cpu.run_cores();
            if(i % 24 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        assert.match(serial, /\[effaceable:INIT\] found current generation/, "The physical key lockers must remain readable");
        assert.doesNotMatch(serial, /panic\(cpu|same weaveSeq|\[effaceable:ERR\]/, serial.slice(-4000));
        if(round === 2) assert.match(serial, /Performing full NAND R\/O restore/,
            "the second boot must exercise dirty YAFTL recovery");
        return cpu.devices.apple_nand.buffer.get_state();
    }
    finally { await emulator.destroy(); }
}

try
{
    execFileSync(process.execPath,
        [fileURLToPath(new URL("../../tools/ios/nand_build.mjs", import.meta.url)),
            "volumes", image, path.resolve(system), path.resolve(data)], { stdio: "inherit" });
    const state = await boot(1), indices = state[1], chunks = state[2];
    assert.ok(indices.length > 0, "native boot must program NAND before the power cycle");
    // The disk overlay uses 256-byte blocks, packed in 65536-block chunks.
    // Materialize those bytes, then start a new CPU without a VM snapshot.
    const fd = fs.openSync(image, "r+");
    try
    {
        for(let i = 0; i < indices.length;)
        {
            const chunk = i >>> 16, offset = (i & 65535) * 256;
            let end = i + 1;
            while(end < indices.length && (end >>> 16) === chunk && indices[end] === indices[i] + end - i) end++;
            const length = (end - i) * 256;
            assert.equal(fs.writeSync(fd, chunks[chunk], offset, length, indices[i] * 256), length);
            i = end;
        }
        fs.fsyncSync(fd);
    }
    finally { fs.closeSync(fd); }
    await boot(2);
    console.log("PASS: original YAFTL recovers persisted native NAND writes and mounts both HFS volumes after a cold restart");
}
finally { fs.rmSync(temporary, { recursive: true, force: true }); }
