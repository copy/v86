// Acceptance uses the owner's 10B329 boot files and a disposable probe NAND.
// A formatted native result is required; embedded format strings cannot pass.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { V86 } from "../../src/main.js";
import { process_list } from "./process-list.mjs";

const [firmware, probe, ...extra] = process.argv.slice(2);
if(!probe || extra.length) throw new Error("usage: installation.mjs firmware-directory disposable-probe-directory");
const renderer = process.env.IPA_HEADLESS ? null : await (await import("../gles/chrome_renderer.mjs")).chrome_renderer();
const nand = path.resolve(probe, "flash.img"), kernel = path.resolve(probe, "kernel.macho");
const emulator = new V86({ machine_type: "s5l8930", graphics_adapter: "none", log_level: 0, autostart: false,
    gles_backdoor: true, graphics_adapter_renderer_channel: renderer || { post() {}, listen() {} }, wasm_path: "build/v86-arm64.wasm",
    ios: { kernelcache: { url: kernel }, devicetree: { url: path.resolve(firmware, "DeviceTree.n90ap.bin") },
        nand: { url: nand, size: fs.statSync(nand).size }, boot_args: "-v serial=3 rd=disk0s1s1" } });
let serial = "";
emulator.add_listener("serial0-output-byte", byte => { serial += String.fromCharCode(byte); });
try
{
    await new Promise((ok, no) => { emulator.add_listener("emulator-loaded", ok); emulator.add_listener("emulator-error", no); });
    const cpu = emulator.v86.cpu, started = performance.now();
    let next = 0, result = null, unlock = -1, touchAt = 0, dumped = 0;
    cpu.clock.resume();
    while(!result && !(process.env.IPA_MIS_PROBE && serial.includes("V86 MIS diagnostic complete")) &&
        !serial.includes("panic(cpu") && performance.now() - started < 1200000 && !fs.existsSync(path.join(probe, "STOP")))
    {
        for(let i = 0; i < 24; i++) cpu.run_cores();
        const panel = cpu.devices.apple_clcd;
        if(renderer && unlock < 0 && renderer.stats.frames && panel.panel_on)
        {
            const colors = new Set();
            for(let i = 0; i < panel.rgba.length; i += 388) colors.add(panel.rgba[i] << 16 | panel.rgba[i + 1] << 8 | panel.rgba[i + 2]);
            if(colors.size >= 300) { unlock = 0; touchAt = cpu.clock.now(); console.log("Sliding the original iOS lock screen"); }
        }
        if(unlock >= 0 && unlock <= 20 && cpu.clock.now() >= touchAt)
        {
            emulator.bus.send("touch", { width: 640, height: 960, touches: unlock === 20 ? [] : [[1, 80 + unlock * 25, 870]] });
            unlock++; touchAt = cpu.clock.now() + 50;
        }
        if(performance.now() >= next)
        {
            next = performance.now() + 5000;
            fs.writeFileSync(path.join(probe, "serial.log"), serial);
            const ram = Buffer.from(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
            const expression = /V86 install result: (-?\d+) callback_failed=(\d+) user_apps=(-?\d+)/;
            result = expression.exec(serial);
            let at = 0;
            while(!result && (at = ram.indexOf("V86 install result:", at)) >= 0)
            {
                result = expression.exec(ram.toString("latin1", at, at + 160));
                at++;
            }
            console.log(Math.round((performance.now() - started) / 1000) + "s: " + process_list(cpu).map(p => p.name).join(", ") +
                (renderer ? " frames=" + renderer.stats.frames : ""));
            if(process.env.IPA_DUMP_RAM && performance.now() >= dumped)
            { dumped = performance.now() + 30000; fs.writeFileSync(path.join(probe, "ram.bin"), ram); }
        }
        await new Promise(ok => setImmediate(ok));
    }
    fs.writeFileSync(path.join(probe, "serial.log"), serial);
    assert.ok(!serial.includes("panic(cpu"), serial.slice(-4000));
    if(process.env.IPA_MIS_PROBE)
    {
        assert.ok(serial.includes("V86 MIS diagnostic complete"), "Native MIS diagnostics did not complete");
        console.log("Completed native signature diagnostics; see serial.log");
    }
    else
    {
    assert.ok(result, "Native installation helper produced no result; see the probe's serial.log");
    console.log(result[0]);
    assert.equal(Number(result[1]), 0, "MobileInstallationInstall failed");
    assert.equal(Number(result[2]), 0, "Native installation callback reported an error");
    assert.ok(Number(result[3]) > 0, "MobileInstallationLookup returned no installed user application");
    console.log("PASS: native iOS installation and application lookup");
    }
}
finally { try { await emulator.destroy(); } finally { renderer?.close(); } }
