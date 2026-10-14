#!/usr/bin/env node
// Warm both cores' legacy translations/JIT code, relocate RAM, then prove the
// low physical hole cannot alias its backing and removing the window restores
// ordinary RAM. Core 1 executes code above the hole to test the fast-limit gap.
import assert from "node:assert/strict";
import { setImmediate as set_immediate } from "node:timers";
import { smp_modes, with_smp_mode, mode_hits } from "../lib/smp_modes.mjs";
const { V86 } = await import(process.env.V86_LIB_PATH || (+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js"));
const u32 = value => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24];
const modes = smp_modes();
const target = 0x200000, high = 2 ** 32, value = 0x12345678, relocated = 0x87654321;
const ips = [0x10000, 0x300000];
const code = new Uint8Array([
    0x31, 0xC9,                           // xor ecx, ecx
    0xC7, 0x05, ...u32(target), ...u32(value), // mov [target], value
    0xA1, ...u32(target),                  // mov eax, [target]
    0x41,                                 // inc ecx
    0x81, 0xF9, ...u32(4096),             // cmp ecx, 4096
    0x75, 0xE8,                           // jne loop (-24)
    0xF4,
]);
for(const mode of modes)
{
    const emulator = new V86(with_smp_mode({ graphics_adapter: "bochs_vga", wasm_path: process.env.WASM_PATH, memory_size: 16 << 20,
        acpi: true, cpu_cores: 2, disable_jit: mode === "interpreter", experimental_smp_jit: true, ir_sync_publication: true,
        ir_region_budget: { hot_threshold: 2, promotion_threshold: 8 },
        autostart: false, log_level: 0, net_device: { type: "none" } }, mode));
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    try
    {
        const cpu = emulator.v86.cpu, e = cpu.wm.exports;
        if(mode !== "interpreter")
        {
            assert.equal(e.ir_auto_set_idle_mode(0, 1), 1);
            assert.equal(e.ir_auto_set_page_threshold(2), 1);
            if(mode === "region") assert.equal(e.ir_auto_set_page_mode(0), 1);
        }
        for(let core = 0; core < 2; core++)
        {
            cpu.switch_core(core);
            cpu.write_blob(code, ips[core]);
            cpu.reg32.fill(0);
            cpu.reg32[4] = 0x400000 + core * 4096;
            cpu.flags[0] = 2;
            cpu.cr[0] = 0x11;
            cpu.cr[3] = cpu.cr[4] = 0;
            cpu.protected_mode[0] = cpu.is_32[0] = cpu.stack_size_32[0] = 1;
            cpu.segment_offsets.fill(0, 0, 6);
            cpu.segment_limits.fill(-1, 0, 6);
            cpu.segment_is_null.fill(0, 0, 6);
            cpu.sreg.set([16, 8, 16, 16, 16, 16]);
            cpu.segment_access_bytes.set([0x93, 0x9B, 0x93, 0x93, 0x93, 0x93]);
            cpu.update_state_flags();
            cpu.full_clear_tlb();
            cpu.cores[core].running = true;
        }
        const hits = () => mode_hits(e, mode);
        const run = async (phase, expected) => {
            const counts = [];
            for(let core = 0; core < 2; core++)
            {
                cpu.switch_core(core);
                cpu.instruction_pointer[0] = cpu.previous_ip[0] = ips[core];
                cpu.in_hlt[0] = 0;
                const before = hits(), deadline = performance.now() + 10000;
                let rounds = 0;
                while(!cpu.in_hlt[0])
                {
                    assert.ok(performance.now() < deadline, `${mode}/${phase}/${core}: timeout`);
                    e.begin_cpu_frame(cpu.clock.now());
                    cpu.run_cpu_slice(257);
                    if(++rounds % 16 === 0) await new Promise(resolve => set_immediate(resolve));
                }
                counts.push((hits() - before) >>> 0);
                assert.equal(cpu.reg32[0] >>> 0, expected, `${mode}/${phase}/${core}: guest load result`);
                assert.equal(cpu.reg32[1], 4096, "guest completed all loop iterations");
                if(mode !== "interpreter") assert.ok(counts[core] > 0, `${mode}/${phase}/${core}: actual compiled execution`);
            }
            return counts;
        };
        cpu.clock.resume();
        const before = await run("before", value);
        assert.equal(e.x64_phys_set_window(0, 0, 1, target, 4096, 1), 1);
        assert.equal(!!cpu.in_mapped_range(target), true);
        assert.equal(!!cpu.in_mapped_range(ips[1]), false, "RAM beyond hole stays executable");
        cpu.write32_physical(high, relocated);
        const mapped = await run("mapped", 0xFFFFFFFF);
        assert.equal(cpu.read32_physical(high), relocated, "neither core's legacy store changed high RAM");
        assert.equal(e.x64_phys_set_window(0, 0, 0, 0, 0, 0), 1);
        assert.equal(!!cpu.in_mapped_range(target), false);
        const removed = await run("removed", value);
        assert.equal(cpu.read32_physical(target), value);
        cpu.clock.pause();
        console.log(`PASS legacy low hole ${mode}: before=${before} mapped=${mapped} removed=${removed}`);
    }
    finally { await emulator.destroy(); }
}
