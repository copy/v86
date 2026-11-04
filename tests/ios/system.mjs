// Direct NAND boot, with no recovery disk. The kernel must pick the BSD
// root device from the system partition published by LwVM.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { process_list } from "./process-list.mjs";
import { V86 } from "../../src/main.js";

const [firmware, image, ...args] = process.argv.slice(2);
if(!firmware || !image) throw new Error("usage: system.mjs firmware-directory flash.img [--debug-kernel kernel] [--mounts|--processes]");
let debugKernel;
if(args[0] === "--debug-kernel")
{
    args.shift();
    debugKernel = args.shift();
    if(!debugKernel || debugKernel.startsWith("--")) throw new Error("expected a local debug kernel");
}
const gate = args.shift();
if(args.length || (gate && !["--mounts", "--processes"].includes(gate))) throw new Error("unknown system boot gate");
const file = name => ({ url: path.resolve(firmware, name) });
const emulator = new V86({
    machine_type: "s5l8930", graphics_adapter: "none", log_level: 0, autostart: false,
    wasm_path: fileURLToPath(new URL("../../build/v86-arm64.wasm", import.meta.url)),
    ios: { kernelcache: debugKernel ? { url: path.resolve(debugKernel) } : file("kernelcache.n90.macho"), devicetree: file("DeviceTree.n90ap.bin"),
        nand: { url: path.resolve(image), size: fs.statSync(image).size } },
});
try
{
    let serial = "";
    emulator.add_listener("serial0-output-byte", byte => { serial += String.fromCharCode(byte); });
    await new Promise((ok, fail) => {
        emulator.add_listener("emulator-loaded", ok);
        emulator.add_listener("emulator-error", fail);
    });
    const root = "BSD root: disk0s1s1, major ";
    const end = performance.now() + (debugKernel || gate ? 600000 : 180000);
    const launchd = "launchd[1] has started up";
    const marker = gate ? "/dev/disk0s1s2 on /private/var (hfs, local, nodev, nosuid" : debugKernel ? launchd : root;
    const cpu = emulator.v86.cpu;
    const required = ["lockdownd", "configd", "mediaserverd"];
    let names = [], processesReady = gate !== "--processes", nextSample = 0;
    cpu.clock.resume();
    while((!serial.includes(marker) || !processesReady) && !serial.includes("Userspace shutdown begun") && !serial.includes("panic(cpu") && performance.now() < end)
    {
        for(let i = 0; i < 24; i++) cpu.run_cores();
        if(!processesReady && serial.includes(marker) && performance.now() >= nextSample)
        {
            nextSample = performance.now() + 100;
            names = process_list(cpu);
            processesReady = names.some(p => p.pid === 1 && p.name === "launchd") &&
                required.every(name => names.some(p => p.name === name));
        }
        await new Promise(ok => setImmediate(ok));
    }
    assert.ok(serial.includes("FTL_Open            [OK]") &&
        serial.includes("loaded configuration for 2 partitions") && serial.includes(root) && serial.includes(marker) &&
        processesReady && !serial.includes("panic(cpu"), serial.slice(-2600));
    if(gate)
    {
        assert.ok(serial.includes(launchd) && serial.includes("/dev/disk0s1s1 on / (hfs, local, read-only"));
        assert.ok(serial.includes("** /dev/rdisk0s1s1") && serial.includes("** /dev/rdisk0s1s2"));
        if(gate === "--processes")
        {
            for(const p of names.filter(p => p.pid === 1 || required.includes(p.name)))
                console.log(p.pid + " " + p.name);
        }
        console.log("PASS: launchd checked the LwVM slices and mounted the read-only system and writable data volumes");
    }
    else console.log(debugKernel ? "PASS: the local debug kernel ran the system volume’s launchd as PID 1 from NAND" :
        "PASS: the original kernel reads LwVM from NAND and selects disk0s1s1 as BSD root");
}
finally { await emulator.destroy(); }
