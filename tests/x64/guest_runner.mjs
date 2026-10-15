// Shared independent reference runner: both machines execute the same guest bytes.
import assert from "node:assert/strict";
import fs from "node:fs";
import {spawn, spawnSync} from "node:child_process";
import {setImmediate as yield_event, setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";
import { with_jit_switches } from "../lib/jit_switches.mjs";
export const root = fileURLToPath(new URL("../../", import.meta.url));
export function assemble(name, source)
{
    const directory = `${root}build/x64-${name}/`;
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(directory + "guest.asm", source);
    const result = spawnSync("nasm", ["-f", "bin", "-o", directory + "guest.bin", directory + "guest.asm"], {encoding: "utf8"});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.statSync(directory + "guest.bin").size < 0xF0000, "guest overlaps page tables");
    return directory;
}
// A test interrupted by a signal skips `finally`; QEMU would outlive it.
const references = new Set();
process.on("exit", () => { for(const child of references) child.kill("SIGKILL"); });
for(const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]])
{
    process.once(signal, () => process.exit(code));
}
export async function reference(directory, {address = 0x300000, magic = 0xC064C064, length, timeout = 20000})
{
    const child = spawn("qemu-system-x86_64", ["-machine", "pc,accel=tcg", "-cpu", "max,vendor=GenuineIntel,phys-bits=36,-la57,-pdpe1gb", "-m", "32M", "-display", "none", "-serial", "none", "-monitor", "none", "-qmp", "stdio", "-no-reboot", "-no-shutdown", "-kernel", directory + "guest.bin", ...(process.env.X64_QEMU_TRACE ? ["-d", "int", "-D", directory + "qemu.log"] : [])], {stdio: ["pipe", "pipe", "pipe"]});
    references.add(child);
    child.on("exit", () => references.delete(child));
    let input = "", error = "", id = 0;
    const pending = new Map();
    child.stderr.on("data", data => error += data);
    const fail_pending = reason => {
        for(const callback of pending.values()) callback({error: {desc: String(reason)}});
        pending.clear();
    };
    child.on("error", fail_pending);
    child.on("exit", (code, signal) => fail_pending(`QEMU exited (${code}, ${signal}): ${error}`));
    child.stdin.on("error", fail_pending);
    child.stdout.on("data", data => {
        input += data;
        while(input.includes("\n"))
        {
            const end = input.indexOf("\n"), line = input.slice(0, end);
            input = input.slice(end + 1);
            let message;
            try { message = JSON.parse(line); } catch{ continue; }
            if(message.id !== undefined)
            {
                const callback = pending.get(message.id);
                pending.delete(message.id);
                callback?.(message);
            }
        }
    });
    const request = (execute, args = {}) => new Promise((resolve, reject) => {
        const n = id++;
        const timer = setTimeout(() => {
            pending.delete(n);
            reject(new Error(`QEMU monitor timeout for ${execute}: ${error}`));
        }, timeout);
        pending.set(n, message => {
            clearTimeout(timer);
            if(message.error) reject(new Error(JSON.stringify(message.error)));
            else resolve(message.return);
        });
        child.stdin.write(JSON.stringify({execute, arguments: args, id: n}) + "\n");
    });
    try
    {
        await request("qmp_capabilities");
        const deadline = performance.now() + timeout;
        let seen = false;
        while(performance.now() < deadline)
        {
            const value = await request("human-monitor-command", {"command-line": `xp /1wx ${address}`});
            if(value.includes(magic.toString(16))) { seen = true; break; }
            await delay(50);
        }
        if(!seen)
        {
            const registers = await request("human-monitor-command", {"command-line": "info registers"});
            const marker = await request("human-monitor-command", {"command-line": `xp /32gx ${address}`});
            throw new Error("QEMU guest timed out: " + error + "\n" + registers + "\n" + marker);
        }
        await request("stop");
        await request("human-monitor-command", {"command-line": `pmemsave ${address} ${length} "${directory}qemu.bin"`});
        await request("quit");
    }
    // (SIGTERM is only a shutdown request, which -no-shutdown turns into a pause)
    finally { child.kill("SIGKILL"); }
    return fs.readFileSync(directory + "qemu.bin");
}
export async function actual(directory, {address = 0x300000, magic = 0xC064C064, length, timeout = 30000, setup, inspect, options = {}})
{
    const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
    // X64_JIT=1 runs every oracle guest with the JIT (the x64 page tier for
    // long-mode code), X64_IR_TIER0=0 additionally with ir_tier0: false.
    const jit = process.env.X64_JIT ? {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true,
        ...(process.env.X64_IR_TIER0 === "0" ? {ir_tier0: false} : {})} : {};
    // (JIT_SWITCHES too: tests/lib/jit_switches.mjs)
    const emulator = new V86(with_jit_switches({graphics_adapter: "bochs_vga", multiboot: {url: directory + "guest.bin"}, memory_size: 32 << 20, acpi: true,
        cpu_cores: Number(process.env.X64_CORES || 1), disable_jit: true, autostart: false, log_level: 0, ...jit, ...options}));
    try
    {
        await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
        const cpu = emulator.v86.cpu;
        if(setup) await setup(emulator);
        const deadline = performance.now() + timeout;
        let rounds = 0;
        while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(address, true) !== magic)
        {
            try
            {
                if(performance.now() > deadline) throw new Error("Guest timed out");
                cpu.run_cores();
            }
            catch(error)
            {
                fs.writeFileSync(directory + "v86-failure.bin", cpu.mem8.slice(address, address + length));
                console.error("Guest failure", JSON.stringify(cpu.get_diagnostics()));
                console.error("Wide RIP", cpu.wm.exports["memory"].buffer ? Array.from(new Uint32Array(cpu.wasm_memory.buffer, 1584, 2)) : "");
                throw error;
            }
            if((++rounds & (options.disable_jit === false ? 0 : 255)) === 0) await yield_event();
        }
        const result = Buffer.from(cpu.mem8.slice(address, address + length));
        fs.writeFileSync(directory + "v86.bin", result);
        if(inspect) await inspect(emulator);
        return result;
    }
    finally { await emulator.destroy(); }
}
