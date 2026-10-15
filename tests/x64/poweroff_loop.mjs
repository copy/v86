#!/usr/bin/env node
// Repeated boot -> poweroff -> S5 -> power-on of x86_64 Linux (Alpine virt,
// as tests/x64/linux_boot.mjs prepares it) on several cores, to catch the
// intermittent poweroff that once ended with every core idle and no ACPI S5
// (docs/x86-64.md, known limits). A cycle without S5
// within 120 s of "poweroff" writes build/x64-linux/poweroff-loop-<cycle>-late.json
// (diagnostics, serial tail) and waits POWEROFF_LATE_S (900) more seconds: a
// late S5 is counted as slow, none at all fails with the scheduler's view of
// every core and the serial console's interrupt state in poweroff-loop-<cycle>.json.
//
// POWEROFF_CYCLES (20), X64_CORES (4), X64_JIT (1), POWEROFF_PARALLEL=1.
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { ROOT as root, IMAGES, directory_of } from "../lib/alpine_image.mjs";

// (the pinned ISO and its unpacked files: tests/lib/alpine_image.mjs)
const directory = directory_of("x86_64");
const kernel = directory + "boot/vmlinuz-virt", initrd = directory + "boot/initramfs-virt";
const iso = directory + IMAGES["x86_64-virt"].name;
for(const file of [kernel, initrd, iso]) assert.ok(fs.existsSync(file), file + " (run tests/x64/linux_boot.mjs once)");
const cycles = +(process.env.POWEROFF_CYCLES || 20), cores = +(process.env.X64_CORES || 4);
const jit = process.env.X64_JIT !== "0";
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: root + "bios/seabios.bin" }, vga_bios: { url: root + "bios/vgabios.bin" },
    bzimage: { url: kernel }, initrd: { url: initrd }, cdrom: { url: iso },
    cmdline: "console=ttyS0,115200 loglevel=7 nokaslr panic=-1 modules=loop,squashfs,sd-mod,usb-storage",
    memory_size: 512 << 20, cpu_cores: cores, acpi: true, autostart: false, cpu_type: "x86_64",
    disable_jit: !jit, experimental_smp_jit: jit, ir_sync_publication: true, log_level: 0,
    ...(+process.env.POWEROFF_PARALLEL ? { parallel: true, wasm_path: root + "build/v86-parallel.wasm" } : {}),
});
let serial = "";
emulator.add_listener("serial0-output-byte", byte => { serial += String.fromCharCode(byte); if(serial.length > 1 << 20) serial = serial.slice(-(1 << 19)); });
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
const cpu = emulator.v86.cpu;
// every byte of the serial console, for a failure report (a panic reboots: panic=-1)
let serial_log = "";
emulator.add_listener("serial0-output-byte", byte => { serial_log += String.fromCharCode(byte); });
let cycle_now = 0;
const wait_for = async (pattern, from, what, ms) => {
    const limit = performance.now() + ms;
    while(!pattern.test(serial.slice(from)))
    {
        if(performance.now() > limit)
        {
            fs.writeFileSync(directory + `poweroff-loop-${cycle_now}-error.json`, JSON.stringify({ what,
                diagnostics: cpu.get_diagnostics(), last_reset: cpu.last_reset || null }, null, 1));
            fs.writeFileSync(directory + `poweroff-loop-${cycle_now}-error.serial`, serial_log);
            throw new Error(`${what}: timed out (serial in poweroff-loop-${cycle_now}-error.serial); tail ${JSON.stringify(serial.slice(-2000))}`);
        }
        await delay(20);
    }
};
const started = performance.now();
const late = [];
for(let cycle = 1; cycle <= cycles; cycle++)
{
    cycle_now = cycle;
    let mark = serial.length;
    const t0 = performance.now();
    emulator.run();
    await wait_for(/localhost login:/, mark, `cycle ${cycle}: login prompt`, 900000);
    mark = serial.length;
    emulator.serial0_send("root\n");
    await wait_for(/localhost:~#/, mark, `cycle ${cycle}: shell`, 120000);
    mark = serial.length;
    emulator.serial0_send(`cat /sys/devices/system/cpu/online; echo READY_${cycle}\n`);
    await wait_for(new RegExp(`\\nREADY_${cycle}\\r?\\n`), mark, `cycle ${cycle}: command`, 120000);
    assert.match(serial.slice(mark), new RegExp(`\\n0-${cores - 1}\\r?\\n`), "every CPU online");
    const off = new Promise(resolve => emulator.add_listener("acpi-power-off", resolve));
    const poweroff_at = serial.length;
    const poweroff_time = performance.now();
    emulator.serial0_send("poweroff\n");
    let state = await Promise.race([off, delay(120000).then(() => null)]);
    if(state !== "S5")
    {
        // slow or stuck: the machine state now, then up to POWEROFF_LATE_S
        // more seconds for a late S5 (a loaded host may need them)
        const late_limit = +(process.env.POWEROFF_LATE_S || 900) * 1000;
        const late_report = { cycle, diagnostics: cpu.get_diagnostics(), serial: serial.slice(poweroff_at) };
        state = await Promise.race([off, delay(late_limit).then(() => null)]);
        if(state === "S5")
        {
            late.push({ cycle, seconds: Math.round((performance.now() - poweroff_time) / 1000) });
            fs.writeFileSync(directory + `poweroff-loop-${cycle}-late.json`, JSON.stringify(late_report, null, 1));
            console.log(`cycle ${cycle}: S5 only after ${late.at(-1).seconds} s`);
        }
    }
    if(state !== "S5")
    {
        // why a core does not run: the scheduler's view of every core, before
        // and after a few more rounds
        const { STATE_OFFSETS, CORE_STATE_RANGES } = await import("../../src/state_layout.js");
        const field = (core, offset, size) => {
            if(core === cpu.active_core)
            {
                const view = new DataView(cpu.wasm_memory.buffer, cpu.state_base + offset, size);
                return size === 1 ? view.getUint8(0) : view.getInt32(0, true);
            }
            const index = CORE_STATE_RANGES.findIndex(([start, end]) => offset >= start && offset + size <= end);
            const bytes = cpu.cores[core].saved[index];
            const view = new DataView(bytes.buffer, bytes.byteOffset + offset - CORE_STATE_RANGES[index][0], size);
            return size === 1 ? view.getUint8(0) : view.getInt32(0, true);
        };
        const scheduler = () => cpu.cores.map((state, core) => ({ core, running: state.running,
            runnable: cpu.core_runnable(core), in_hlt: field(core, STATE_OFFSETS.in_hlt, 1),
            interrupt_shadow: field(core, STATE_OFFSETS.interrupt_shadow, 1), flags: field(core, STATE_OFFSETS.flags, 4) >>> 0,
            interrupt_pending: !!cpu.apic_core_interrupt_pending(core), nmi_pending: !!cpu.apic_core_nmi_pending(core),
            events: cpu.apic_peek_core_events(core), shutdown: cpu.wm.exports.exception_shutdown(core),
            retired: cpu.wm.exports.core_statistics_get(core, 0) }));
        const before = scheduler();
        // the serial console's interrupt: the UART's pending conditions and the
        // IOAPIC input 4 (redirection entry, IRR and line level)
        const uart = cpu.devices.uart0;
        const ioapic = new Uint32Array(cpu.wasm_memory.buffer, cpu.get_ioapic_addr(), 52);
        const irq_state = () => ({ uart: { ier: uart.ier, iir: uart.iir, ints: uart.ints, lsr: uart.lsr, lcr: uart.line_control,
            mcr: uart.modem_control, input: uart.input.length },
            ioapic4: { config: ioapic[4] >>> 0, destination: ioapic[24 + 4] >>> 0, irr: ioapic[50] >>> 0 & 16, line: ioapic[51] >>> 0 & 16 } });
        const irq_before = irq_state();
        await delay(2000);
        const report = { cycle, diagnostics: cpu.get_diagnostics(), last_reset: cpu.last_reset || null,
            scheduler: { before, after_2s: scheduler() }, irq: { before: irq_before, after_2s: irq_state() },
            serial: serial.slice(poweroff_at) };
        fs.writeFileSync(directory + `poweroff-loop-${cycle}.json`, JSON.stringify(report, null, 1));
        throw new Error(`cycle ${cycle}: no ACPI S5 within 120 s of poweroff: ` +
            JSON.stringify(report.diagnostics.cores.map(core => [core.state, core.linear_ip, core.halted, core.interrupts_enabled])));
    }
    await delay(100);
    assert.ok(!emulator.is_running(), "stopped in S5");
    console.log(`cycle ${cycle}: boot and poweroff in ${((performance.now() - t0) / 1000).toFixed(0)} s, S5`);
}
await emulator.destroy();
console.log(`X64_POWEROFF_LOOP_PASS ${cycles} cycles on ${cores} cores in ${((performance.now() - started) / 60000).toFixed(1)} min` +
    (late.length ? `; S5 later than 120 s in ${late.length}: ${JSON.stringify(late)}` : ""));
