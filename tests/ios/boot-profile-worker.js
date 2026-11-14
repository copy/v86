// Test-only CPU Worker. Keep timing out of production hot paths.
import { start_cpu_worker } from "../../src/browser/cpu_worker_runtime.js";
import { A64CPU } from "../../src/arm/cpu.js";
import { AppleIOP } from "../../src/apple/iop.js";
import { AppleCDMA } from "../../src/apple/cdma.js";
import { AppleNAND } from "../../src/apple/nand.js";
import { AppleCLCD } from "../../src/apple/clcd.js";

const timings = {};
const delays = { runnable: 0, sleeping: 0, requested_ms: 0 };
function measure(type, name, label = name)
{
    const original = type.prototype[name];
    type.prototype[name] = function(...args)
    {
        const start = performance.now();
        try { return original.apply(this, args); }
        finally
        {
            const elapsed = performance.now() - start;
            const entry = timings[label] ||= { calls: 0, ms: 0, max_ms: 0 };
            entry.calls++; entry.ms += elapsed; entry.max_ms = Math.max(entry.max_ms, elapsed);
        }
    };
}
const run_machine = A64CPU.prototype.run_machine_core;
A64CPU.prototype.run_machine_core = function()
{
    const next = run_machine.call(this);
    if(next > 0) { delays.sleeping++; delays.requested_ms += next; }
    else delays.runnable++;
    return next;
};
measure(A64CPU, "run_machine_core");
measure(A64CPU, "run_hardware_timers");
measure(AppleIOP, "run", "iop");
measure(AppleCDMA, "run_aes_pair");
measure(AppleCDMA, "transfer", "dma_transfer");
measure(AppleNAND, "read_page", "nand_read_submit");
measure(AppleCLCD, "render", "lcd_render");
const diagnostics = A64CPU.prototype.get_diagnostics;
A64CPU.prototype.get_diagnostics = function()
{
    const lcd = this.devices.apple_clcd;
    const iop = this.devices.apple_iop;
    let iop_pc;
    if(iop?.running && !iop.pending_reset)
    {
        iop.core.a32_iop_select(true);
        try { iop_pc = this.read_pc(); }
        finally { iop.core.a32_iop_select(false); }
    }
    return { ...diagnostics.call(this), profile: structuredClone(timings), steps: this.step_stats(15),
        delays: { ...delays }, iop: iop ? { pc: iop_pc, irq: iop.irq, fiq: iop.fiq, polling: iop.polling?.size || 0 } : null,
        lcd: lcd ? { panel_on: lcd.panel_on, backlight: lcd.backlight, base: lcd.regs[0x4044 >>> 2] } : null };
};
start_cpu_worker();
