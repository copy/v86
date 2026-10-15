#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { setImmediate as set_immediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { smp_modes, with_smp_mode, compiled_hits, published } from "../lib/smp_modes.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
fs.mkdirSync(root + "build/smp", { recursive: true });
const kernel = root + "build/smp/atomic_boundaries.bin";
const assembled = spawnSync("nasm", ["-f", "bin", "-o", kernel, root + "tests/smp/atomic_boundaries.asm"], { encoding: "utf8" });
assert.equal(assembled.status, 0, assembled.stderr);
const modes = smp_modes();
const CONTROL = 0x380000;
const RESULT = 0x382000;
const RAM = 0x3A0000;
const MMIO = 0x10000000;
const VIRTUAL = 0x40000000;
const INITIAL = Uint8Array.of(0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88);
const names = ["LOCK INC16", "LOCK INC32", "XCHG16", "XCHG32", "LOCK XADD32", "LOCK CMPXCHG32 success", "LOCK CMPXCHG32 failure", "LOCK CMPXCHG8B success", "LOCK CMPXCHG8B failure"];
const cases = [];
for(let op = 0; op < names.length; op++)
{
    const width = [2, 4, 2, 4, 4, 4, 4, 8, 8][op];
    cases.push({ op, width, permission: 3, first: RAM, second: RAM + 4096, offset: 256, warm: true, label: names[op] + " warm" });
    if(op >= 7)
    {
        cases.push({ op, width, permission: 3, first: MMIO, second: MMIO + 4096,
            offset: 256, high_bit: true, label: names[op] + " aligned MMIO low-dword bit31" });
    }
    for(const space of ["ram", "mmio", "mixed"])
    {
        for(const permission of [3, 0, 1])
        {
            cases.push({ op, width, permission, first: space === "ram" ? RAM : MMIO,
                second: space === "mmio" ? MMIO + 4096 : RAM + 4096,
                offset: 4096 - (width === 2 ? 1 : 3),
                label: `${names[op]} ${space} second-page=${permission === 3 ? "writable" : permission === 0 ? "absent" : "read-only"}` });
        }
    }
}

for(let op = 9; op <= 16; op++)
{
    for(const permission of [3, 0, 1])
    {
        cases.push({ op, width: 8, permission, first: MMIO, second: MMIO + 4096,
            offset: 4093, invalid: true, label: `illegal LOCK form ${op - 9}, second PTE=${permission}` });
    }
}

function initial_bytes(test)
{
    const bytes = INITIAL.slice(0, test.width);
    if(test.high_bit) bytes[3] |= 0x80;
    return bytes;
}

function initial_eax(test)
{
    if(test.op === 2 || test.op === 3) return 0xA1B2C3D4;
    if(test.op === 4) return 1;
    if(test.op === 6 || test.op === 8) return 0;
    return test.high_bit ? 0xC4332211 : 0x44332211;
}

function expected(test)
{
    const bytes = initial_bytes(test);
    const view = new DataView(bytes.buffer);
    const registers = [initial_eax(test), 0x88776655, 0x10203040, 0x50607080];
    if(test.permission !== 3 || test.invalid) return { bytes, registers };
    switch(test.op)
    {
        case 0: view.setUint16(0, 0x2212, true); break;
        case 1: view.setUint32(0, 0x44332212, true); break;
        case 2: view.setUint16(0, 0xC3D4, true); registers[0] = 0xA1B22211; break;
        case 3: view.setUint32(0, 0xA1B2C3D4, true); registers[0] = 0x44332211; break;
        case 4: view.setUint32(0, 0x44332212, true); registers[0] = 0x44332211; break;
        case 5: view.setUint32(0, 0x10203040, true); break;
        case 6: registers[0] = 0x44332211; break;
        case 7:
            view.setUint32(0, 0x10203040, true);
            view.setUint32(4, 0x50607080, true);
            break;
        case 8: registers[0] = test.high_bit ? 0xC4332211 : 0x44332211; break;
    }
    return { bytes, registers };
}

for(const mode of modes)
{
    const emulator = new V86(with_smp_mode({ graphics_adapter: "bochs_vga", multiboot: { url: kernel }, memory_size: 16 << 20,
        acpi: true, cpu_cores: 2, cpu_quantum: 257, cpu_schedule_seed: 7,
        disable_jit: mode === "interpreter", experimental_smp_jit: true, ir_sync_publication: true,
        autostart: false, log_level: 0 }, mode));
    try
    {
        await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
        const cpu = emulator.v86.cpu;
        const e = cpu.wm.exports;
        const view = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
        const word = address => view().getUint32(address, true);
        const set = (address, value) => view().setUint32(address, value, true);
        set(CONTROL, cases.length);
        cases.forEach((test, i) => {
            const address = 0x381000 + i * 24;
            set(address, test.first | 3);
            set(address + 4, test.second | test.permission);
            set(address + 8, VIRTUAL + test.offset);
            set(address + 12, test.op);
            set(address + 16, initial_eax(test));
            set(address + 20, test.warm ? 2048 : 1);
        });
        const device = new Uint8Array(0x20000);
        const device_view = new DataView(device.buffer);
        let active = null;
        let trace = [];
        let checked = 0;
        const record = (kind, address, bytes) => {
            assert.ok(active, "MMIO only inside a guest operation");
            for(let i = 0; i < bytes.length; i++) trace.push([kind, address + i, bytes[i]]);
        };
        cpu.io.mmap_register(MMIO, device.length,
            address => { const value = device[address - MMIO]; record("read", address, [value]); return value; },
            (address, value) => { record("write", address, [value]); device[address - MMIO] = value; },
            address => { const value = device_view.getInt32(address - MMIO, true); record("read", address, device.slice(address - MMIO, address - MMIO + 4)); return value; },
            (address, value) => { device_view.setInt32(address - MMIO, value, true); record("write", address, device.slice(address - MMIO, address - MMIO + 4)); });
        const physical = (test, i) => test.offset + i < 4096 ? test.first + test.offset + i : test.second + test.offset + i - 4096;
        cpu.io.register_write(0x504, device, undefined, undefined, index => {
            active = cases[index];
            trace = [];
            for(let i = 0; i < active.width; i++)
            {
                const address = physical(active, i);
                if(address >= MMIO) device[address - MMIO] = initial_bytes(active)[i];
                else cpu.mem8[address] = initial_bytes(active)[i];
            }
        });
        cpu.io.register_write(0x508, device, undefined, undefined, index => {
            const test = cases[index];
            const label = `${mode}: ${test.label}`;
            assert.equal(test, active);
            if(test.warm)
            {
                if(mode !== "interpreter") assert.ok(published(e, 0x101000 + test.op * 4096), `${label}: operation published after warm-up`);
                active = null;
                return;
            }
            const want = expected(test);
            const fault = test.permission !== 3 || test.invalid;
            assert.equal(word(RESULT + 40), fault ? 1 : 0, `${label}: exactly the expected exception`);
            if(fault)
            {
                assert.equal(word(RESULT + 48), test.invalid ? 6 : 14, `${label}: exception vector`);
                assert.equal(word(RESULT + 28), 0x101000 + test.op * 4096, `${label}: restart EIP names full instruction including LOCK`);
                if(!test.invalid)
                {
                    assert.equal(word(RESULT + 32), VIRTUAL + 4096, `${label}: CR2 names second page`);
                    assert.equal(word(RESULT + 36), test.permission === 0 ? 2 : 3, `${label}: #PF write/protection bits`);
                }
                assert.equal(word(RESULT + 16) & 0x8D5, 0x8D5, `${label}: arithmetic flags unchanged by fault`);
                assert.deepEqual(trace, [], `${label}: no MMIO read or write before all permissions pass`);
            }
            else
            {
                const arithmetic = [0x5, 0x5, 0x8D5, 0x8D5, 0x4, 0x44, 0x91, 0x8D5, 0x895][test.op];
                assert.equal(word(RESULT + 16) & 0x8D5, arithmetic, `${label}: only committed arithmetic flags change`);
            }
            if(!fault && test.op >= 5)
            {
                assert.equal((word(RESULT + 16) >> 6) & 1, test.op === 6 || test.op === 8 ? 0 : 1, `${label}: comparison ZF`);
            }
            assert.deepEqual([0, 4, 8, 12].map(offset => word(RESULT + offset)), want.registers, `${label}: registers commit together`);
            const actual = Uint8Array.from({ length: test.width }, (_, i) => {
                const address = physical(test, i);
                return address >= MMIO ? device[address - MMIO] : cpu.mem8[address];
            });
            assert.deepEqual(actual, want.bytes, `${label}: operand commits wholly or remains unchanged`);
            if(!fault)
            {
                const mmio = Array.from({ length: test.width }, (_, i) => [physical(test, i), i]).filter(([address]) => address >= MMIO);
                const reads = trace.filter(([kind]) => kind === "read").sort((a, b) => a[1] - b[1]);
                const writes = trace.filter(([kind]) => kind === "write").sort((a, b) => a[1] - b[1]);
                assert.deepEqual(reads, mmio.map(([address, i]) => ["read", address, initial_bytes(test)[i]]), `${label}: each MMIO byte read exactly once`);
                assert.deepEqual(writes, mmio.map(([address, i]) => ["write", address, want.bytes[i]]), `${label}: MMIO writeback occurs even on failed CMPXCHG`);
                const first_write = trace.findIndex(([kind]) => kind === "write");
                if(first_write >= 0) assert.ok(trace.slice(first_write).every(([kind]) => kind === "write"), `${label}: reads precede writes`);
            }
            active = null;
            checked++;
        });
        const deadline = performance.now() + 30000;
        let rounds = 0;
        while(word(CONTROL + 4) !== 0xD0D0)
        {
            assert.equal(word(CONTROL + 8), 0, `${mode}: unexpected guest exception`);
            if(performance.now() >= deadline) throw new Error(`${mode}: guest stalled ${JSON.stringify(cpu.get_diagnostics())}`);
            cpu.run_cores();
            if((++rounds & 1023) === 0) await set_immediate();
        }
        assert.equal(checked, cases.filter(test => !test.warm).length);
        const hits = compiled_hits(e);
        if(mode !== "interpreter") assert.ok(hits > 0, `${mode}: compiled code actually executed`);
        console.log(`${mode}: ${checked} atomic #UD/page-fault/write-protection/MMIO cases passed; compiled activations=${hits}`);
    }
    finally { await emulator.destroy(); }
}
