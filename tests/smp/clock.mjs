#!/usr/bin/env node

// No Wasm required: exercise the real device models against one injectable
// clock, including the exact deadlines used when all processors are halted.
import assert from "node:assert/strict";
import { MachineClock } from "../../src/machine_clock.js";
import { PIT } from "../../src/pit.js";
import { RTC } from "../../src/rtc.js";
import { ACPI } from "../../src/acpi.js";
import { create_platform } from "../../src/platform.js";
import { set_log_level } from "../../src/log.js";

set_log_level(0);
let passed = 0;
function test(name, run)
{
    run();
    passed++;
    console.log("PASS " + name);
}

function machine(options)
{
    const clock = new MachineClock({ mode: "deterministic", instructions_per_ms: 1000, ...options });
    const interrupts = [];
    const lines = new Map();
    const cpu = {
        clock,
        // (an i440FX machine with ACPI: the PM block's layout)
        platform: create_platform({ acpi: true }, 64 << 20),
        io: { register_read() {}, register_write() {}, unregister_range() {}, ports: [] },
        devices: { pci: { register_device: device => new Int32Array(new Uint8Array(device.pci_space).buffer) } },
        shared_irq_sources: Array.from({ length: 24 }, () => new Set()),
        device_raise_irq: irq => {
            if(!lines.get(irq)) interrupts.push([clock.now(), irq, 1]);
            lines.set(irq, true);
        },
        device_lower_irq: irq => {
            if(lines.get(irq)) interrupts.push([clock.now(), irq, 0]);
            lines.set(irq, false);
        },
        set_shared_irq_level: (irq, source, level) => {
            if(level) cpu.device_raise_irq(irq);
            else cpu.device_lower_irq(irq);
        },
    };
    const bus = { send() {} };
    const pit = new PIT(cpu, bus);
    const rtc = new RTC(cpu);
    const acpi = new ACPI(cpu, bus);
    return { clock, pit, rtc, acpi, interrupts };
}

function write_rtc(rtc, index, value)
{
    rtc.cmos_index = index;
    rtc.cmos_port_write(value);
}

function read_rtc(rtc, index)
{
    rtc.cmos_index = index;
    return rtc.cmos_port_read();
}

function program(m)
{
    m.pit.port43_write(0x34); // counter 0, rate generator, low/high
    m.pit.counter_write(0, 0xA9);
    m.pit.counter_write(0, 4); // 1193 ticks, approximately 1 ms
    write_rtc(m.rtc, 0xB, 0x42); // periodic, 24-hour BCD
    m.acpi.smi_cmd_write(0xF1);
    m.acpi.pm_write(2, 2, 1); // enable timer SCI
}

test("normal clock is monotonic, does not advance on equal reads and bounds host gaps", () => {
    let host = 100;
    const clock = new MachineClock({ now: () => host, wall_epoch_ms: 10000, max_host_delta_ms: 1000 });
    assert.equal(clock.now(), 0);
    assert.equal(clock.now(), 0);
    host += 25;
    assert.equal(clock.now(), 25);
    host -= 5;
    assert.equal(clock.now(), 25);
    host += 15;
    assert.equal(clock.now(), 35);
    host += 5000;
    assert.equal(clock.now(), 1035);
    assert.equal(clock.now(), 1035);
    assert.deepEqual(clock.get_diagnostics(), {
        host_pause_count: 1, discarded_host_ms: 4000, host_backwards_count: 1,
        committed_instructions: 0, idle_ms: 0,
    });
});

test("pause freezes monotonic time and RTC epoch, resume excludes paused host time", () => {
    let host = 0;
    const clock = new MachineClock({ now: () => host, wall_epoch_ms: 10000 });
    host = 20;
    clock.pause();
    host = 100000;
    assert.equal(clock.now(), 20);
    assert.equal(clock.wall_time(), 10020);
    clock.resume();
    host += 8;
    assert.equal(clock.now(), 28);
    assert.equal(clock.get_diagnostics().host_pause_count, 0);
});

test("deterministic clock consumes committed progress once; reads and vCPU count add no time", () => {
    let pending = 0;
    const clock = new MachineClock({ mode: "deterministic", instructions_per_ms: 1000 });
    clock.set_instruction_source(() => { const n = pending; pending = 0; return n; });
    pending = 1234;
    assert.equal(clock.now(), 1.234);
    for(let i = 0; i < 100; i++) assert.equal(clock.now(), 1.234);
    pending = 766;
    assert.equal(clock.wall_time(), 946684800002);
    assert.equal(clock.get_diagnostics().committed_instructions, 2000);

    const other = new MachineClock({ mode: "deterministic", instructions_per_ms: 1000 });
    for(let i = 0; i < 2000; i++) other.advance_instructions(1);
    assert.equal(other.now(), clock.now());
    clock.advance_to(10);
    clock.advance_to(9);
    clock.advance_instructions(500);
    assert.equal(clock.now(), 10.5);
});

test("snapshot restores virtual time and RTC wall epoch independently of host", () => {
    let host = 0;
    const clock = new MachineClock({ now: () => host, wall_epoch_ms: 10000 });
    host = 50;
    const saved = clock.get_state();
    host = 100000;
    const restored = new MachineClock({ now: () => host, wall_epoch_ms: 999999 });
    restored.pause();
    restored.set_state(saved);
    host += 999999;
    assert.equal(restored.now(), 50);
    assert.equal(restored.wall_time(), 10050);
    restored.resume();
    host += 2;
    assert.equal(restored.wall_time(), 10052);
});

test("identical inputs produce identical PIT/RTC/PM interrupt sequences and PM readings", () => {
    const run = () => {
        const m = machine();
        program(m);
        const reads = [];
        // Include PM bit-23 rollover, exercising a slow deadline alongside IRQ0/8.
        for(const count of [0, 250, 727, 23, 9000, 1000000, 1333346, 2343346])
        {
            m.clock.advance_instructions(count);
            m.pit.timer(m.clock.now(), false);
            m.rtc.timer(m.clock.now(), false);
            m.acpi.timer(m.clock.now());
            reads.push([m.acpi.pm_read(8, 4), read_rtc(m.rtc, 0), read_rtc(m.rtc, 0xC)]);
            const before = m.clock.now();
            assert.equal(m.acpi.pm_read(8, 4), m.acpi.pm_read(8, 4));
            assert.equal(m.clock.now(), before);
        }
        assert.ok(m.interrupts.some(e => e[1] === 0));
        assert.ok(m.interrupts.some(e => e[1] === 8));
        assert.ok(m.interrupts.some(e => e[1] === 9));
        return [m.interrupts, reads];
    };
    assert.deepEqual(run(), run());
});

test("halt deadline jumps wake PIT and RTC at exact deadlines and leave future deadlines", () => {
    const m = machine();
    program(m);
    const rtc_deadline = m.rtc.timer(m.clock.now(), false);
    m.clock.advance_to(rtc_deadline);
    assert.ok(m.rtc.timer(m.clock.now(), false) > 0);
    assert.ok(m.interrupts.some(e => e[1] === 8));

    const pit_deadline = m.pit.timer(m.clock.now(), false);
    m.clock.advance_to(m.clock.now() + pit_deadline);
    assert.ok(m.pit.timer(m.clock.now(), false) > 0);
    assert.ok(m.interrupts.some(e => e[1] === 0));
});

test("device snapshots preserve PIT/RTC/PM phase and calendar with the machine clock", () => {
    const m = machine();
    program(m);
    m.clock.advance_instructions(1234567);
    m.pit.timer(m.clock.now(), false);
    m.rtc.timer(m.clock.now(), false);
    m.acpi.timer(m.clock.now());
    const clock_state = m.clock.get_state();
    const pit_state = m.pit.get_state().map(x => ArrayBuffer.isView(x) ? x.slice() : x);
    const rtc_state = m.rtc.get_state().map(x => ArrayBuffer.isView(x) ? x.slice() : x);
    const acpi_state = m.acpi.get_state().map(x => ArrayBuffer.isView(x) ? x.slice() : x);
    const restored = machine({ wall_epoch_ms: 1893456000000 });
    restored.clock.set_state(clock_state);
    restored.pit.set_state(pit_state);
    restored.rtc.set_state(rtc_state);
    restored.acpi.set_state(acpi_state);
    const sample = x => [x.pit.get_counter_value(0, x.clock.now()),
        x.rtc.timer(x.clock.now(), false), x.acpi.pm_read(8, 4),
        read_rtc(x.rtc, 0), read_rtc(x.rtc, 9), x.clock.wall_time()];
    assert.deepEqual(sample(m), sample(restored));
    m.clock.advance_instructions(12345);
    restored.clock.advance_instructions(12345);
    assert.deepEqual(sample(m), sample(restored));
});

test("PIT exact deadline delivery remains stable over 40000 halts and fractional ticks", () => {
    for(const reload of [1, 17, 1193, 65535])
    {
        const m = machine();
        m.pit.port43_write(0x34);
        m.pit.counter_write(0, reload & 255);
        m.pit.counter_write(0, reload >> 8);
        for(let i = 0; i < 10000; i++)
        {
            const delta = m.pit.timer(m.clock.now(), false);
            assert.ok(delta > 0);
            m.clock.advance_to(m.clock.now() + delta);
            const before = m.interrupts.length;
            assert.ok(m.pit.timer(m.clock.now(), false) > 0);
            assert.ok(m.interrupts.length > before);
            assert.deepEqual(m.interrupts.at(-1), [m.clock.now(), 0, 1]);
        }
    }
});

test("RTC periodic events do not starve simultaneous update or alarm events", () => {
    const m = machine();
    write_rtc(m.rtc, 1, 1); // alarm second 1
    write_rtc(m.rtc, 3, 0);
    write_rtc(m.rtc, 5, 0);
    write_rtc(m.rtc, 0xB, 0x72);
    m.clock.advance_to(1000);
    m.rtc.timer(m.clock.now(), false);
    assert.equal(read_rtc(m.rtc, 0xC) & 0xF0, 0xF0);
});

test("legacy RTC snapshots rebase host UTC deadlines without changing saved calendar", () => {
    const m = machine();
    write_rtc(m.rtc, 0xB, 0x42);
    const state = m.rtc.get_state();
    state.length = 15;
    state[3] = 1600000000000;
    state[4] = state[3] + 50;
    m.clock.advance_to(123);
    m.rtc.set_state(state);
    assert.equal(m.rtc.last_update, 123);
    assert.equal(m.rtc.timer(m.clock.now(), false), 50);
    assert.equal(m.rtc.rtc_time, state[2]);
});

test("invalid clock rates, committed counts and deadlines are rejected", () => {
    assert.throws(() => new MachineClock({ instructions_per_ms: 0 }));
    assert.throws(() => new MachineClock({ mode: "unknown" }));
    const clock = new MachineClock({ mode: "deterministic" });
    assert.throws(() => clock.advance_instructions(-1));
    assert.throws(() => clock.advance_instructions(0.5));
    assert.throws(() => clock.advance_to(Infinity));
});

console.log(JSON.stringify({ suite: "machine-clock-devices", passed }));
