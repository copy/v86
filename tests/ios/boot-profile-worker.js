// Test-only CPU Worker. Keep timing out of production hot paths.
import { start_cpu_worker } from "../../src/browser/cpu_worker_runtime.js";
import { A64CPU } from "../../src/arm/cpu.js";
import { AppleIOP } from "../../src/apple/iop.js";
import { AppleCDMA } from "../../src/apple/cdma.js";
import { AppleNAND } from "../../src/apple/nand.js";
import { AppleCLCD } from "../../src/apple/clcd.js";

const timings = {};
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
    return { ...diagnostics.call(this), profile: structuredClone(timings), steps: this.step_stats(15),
        lcd: lcd ? { panel_on: lcd.panel_on, backlight: lcd.backlight, base: lcd.regs[0x4044 >>> 2] } : null };
};
start_cpu_worker();
