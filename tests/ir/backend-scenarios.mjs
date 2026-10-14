// Shared Node/main-thread/real Worker checks, exclusively through public V86 APIs.
export async function backend_scenarios(V86, options, log = console.log)
{
    const check = (value, message) => { if(!value) throw new Error(message); };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (test, message) => {
        const deadline = performance.now() + 15000;
        while(!await test()) { check(performance.now() < deadline, message); await sleep(5); }
    };
    const bytes = value => Uint8Array.of(value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24);
    const word = async (vm, address) => {
        const data = await vm.read_memory(address, 4);
        return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
    };
    const budget = { hot_threshold: 2, promotion_threshold: 4, max_source_bytes: 96, execution_budget: 128, rep_iterations: 8 };
    let vm, ir_snapshot;
    // The scenarios exercise the region tiers with small budgets, so Tier-0
    // (on by default) is off unless a scenario asks for the defaults.
    const create = async (extra = {}, expected_error) => {
        vm = new V86({ graphics_adapter: "bochs_vga", memory_size: 32 << 20, disable_keyboard: true, disable_mouse: true,
            disable_speaker: true, net_device: { type: "none" }, ir_tier0: false, ...options, autostart: false, ...extra });
        let loaded = false, failure;
        vm.add_listener("emulator-loaded", () => { loaded = true; });
        vm.add_listener("emulator-error", error => { failure = String(error?.message || error); });
        await until(() => loaded || failure, "backend initialization settled");
        if(expected_error)
        {
            check(!loaded && failure.includes(expected_error), "initialization must reject: " + expected_error + "; actual " + failure);
            check(!vm.is_running(), "rejected backend did not start guest");
        }
        else check(!failure, failure);
        return vm;
    };
    const destroy = async () => { if(vm) { await vm.destroy(); vm = null; } };
    const boot = async () => { await vm.run(); await until(async () => await word(vm, 0x500) === 0xCAFE, "protected-mode BIOS boot"); };
    const info = () => vm.get_jit_info();
    const assert_ir = async () => {
        const i = await info();
        check(i.backend === "ir" && i.ir_available && i.ir.enabled === 1, "IR backend is active");
        check(JSON.stringify(i.ir_region_budget) === JSON.stringify(budget), "all region limits reached CPU");
        return i;
    };
    try
    {
        await create({ jit_backend: "ir", ir_region_budget: budget });
        check(!options.cpu_worker || !vm.v86, "Worker owns the CPU");
        const copied = await info(); copied.ir_region_budget.hot_threshold = 999;
        await assert_ir();
        await boot();
        const pc = 0x1200000;
        await vm.write_memory(Uint8Array.of(0x40, 0xEB, 0xFD), pc);
        const before = await info();
        await vm.write_memory(bytes(pc), 0x600);
        await until(async () => {
            const i = await info(); return i.ir.tier2_published > before.ir.tier2_published && i.ir.cache_hits > before.ir.cache_hits;
        }, "IR Tier 1/2 publish and execute through normal CPU scheduling");
        await vm.stop(); await assert_ir();
        check(await vm.configure_ir_diagnostics(1), "enable public diagnostics");
        check((await info()).ir.cache_entries === 0, "diagnostic policy invalidates prior modules");
        await vm.run();
        await until(async () => (await info()).ir.diagnostics.totals.ir_activations > 100, "diagnostic IR activations");
        await vm.stop();
        const diagnostic = (await info()).ir.diagnostics;
        check(diagnostic.enabled && diagnostic.totals.instrumentation_errors === 0, "diagnostic timers balanced");
        check(diagnostic.exits.budget.count > 0 && diagnostic.timings.state_write.sampled_calls > 0, "generated exit/timing instrumentation");
        diagnostic.exits.budget.count = -1;
        check((await info()).ir.diagnostics.exits.budget.count > 0, "diagnostic result copied across RPC");
        check(await vm.configure_ir_diagnostics(0), "disable diagnostics");
        check(!(await info()).ir.diagnostics.enabled, "off policy reached CPU");
        log("PASS: opt-in IR timing/exits, copied diagnostics, cache-safe enable/disable");
        const snapshot = await vm.save_state();
        ir_snapshot = snapshot.slice(0);
        const saved = await info();
        await vm.restore_state(snapshot);
        check((await info()).ir.cache_entries === 0, "snapshot restore invalidated generated code");
        await assert_ir(); await vm.run();
        await until(async () => (await info()).ir.tier2_published > saved.ir.tier2_published, "restore recompiles and promotes IR");
        // End the hot loop with a memory write and RET. The host write must
        // invalidate both tiers before the mailbox function returns.
        await vm.write_memory(Uint8Array.of(0x90, 0xE9, 10, 0, 0, 0, ...Array(10).fill(0x90), 0xA3, 0, 7, 0, 0, 0xC3), pc);
        await until(async () => await word(vm, 0x600) === 0, "self-modified IR loop returned");
        const arithmetic = await word(vm, 0x700);
        check(arithmetic > pc, "IR loop performed guest arithmetic: " + arithmetic);
        // x87 is intentionally not lowered yet: the IR-selected VM must execute
        // it through the interpreter and continue to the independently checked store.
        await vm.write_memory(Uint8Array.of(0xD9, 0xEE, 0xDD, 0xD8, 0xC7, 5, 4, 7, 0, 0, 0x78, 0x56, 0x34, 0x12, 0xC3), pc);
        await vm.write_memory(bytes(pc), 0x600);
        await until(async () => await word(vm, 0x704) === 0x12345678 && await word(vm, 0x600) === 0, "unsupported IR instruction executes through interpreter");
        await vm.stop(); await assert_ir();
        await vm.write_memory(bytes(0), 0x500);
        await vm.restart(); await boot(); await vm.stop(); await assert_ir();
        log("PASS: public IR backend, bounded policy, copied stats, Tier 1/2, SMC, x87 fallback, save/restore/restart, zero legacy requests");
        await destroy();

        for(const dump of ["off", "hir", "mir", "wasm", "all"]) {
            const verify = dump === "off" ? "off" : "every_pass";
            const stats = dump === "hir" ? "sampled" : dump === "all" ? "debug" : "off";
            await create({jit_backend:"ir", ir_region_budget:budget, ir_verify:verify, ir_dump:dump, ir_stats:stats});
            check((await info()).ir_stats === stats && (await info()).ir.diagnostics.sample_period === (stats === "off" ? 0 : stats === "sampled" ? 128 : 1), "named statistics reach CPU");
            check((await info()).ir_verify === verify && (await info()).ir_dump === dump, "debug policy reaches CPU");
            await boot();
            await vm.write_memory(Uint8Array.of(0x40, 0xEB, 0xFD), pc);
            await vm.write_memory(bytes(pc), 0x600);
            await until(async () => (await info()).ir.tier2_published > 0 && (await info()).ir.cache_hits > 0, "verified compilation publishes");
            await vm.stop();
            const records = await vm.get_ir_dumps();
            check(records.length <= 16 && (dump === "off" ? !records.length : records.length > 0), "bounded opt-in dump ring");
            for(const r of records) {
                check(!!r.hir === ["hir", "all"].includes(dump) && !!r.mir === ["mir", "all"].includes(dump)
                    && !!r.wasm.length === ["wasm", "all"].includes(dump), "selected stages only");
                check(r.hir.length <= 65536 && r.mir.length <= 65536 && r.wasm.length <= 262144, "bounded artifacts");
                if(r.wasm.length && !(r.truncated & 4)) check(WebAssembly.validate(r.wasm), "copied executable Wasm dump");
                r.hir = "mutated"; r.wasm.fill(0);
            }
            const copy = await vm.get_ir_dumps(true);
            if(copy.length) check(copy[0].hir !== "mutated" && (!copy[0].wasm.length || copy[0].wasm[1] === 97), "dump copies isolated");
            check(!(await vm.get_ir_dumps()).length, "clear dump ring");
            const snapshot = await vm.save_state(); await vm.restore_state(snapshot);
            check((await info()).ir_verify === verify && (await info()).ir_dump === dump, "debug policy survives restore");
            await destroy();
        }
        log("PASS: public dump/verify, each stage, bounded copied Wasm, clear, restore, verified Tier 1/2");

        for(const level of [0, 1, 2]) {
            const disabled_passes = level === 2 ? ["licm", "mir_fold", "allocation", "ram_forward", "budget_batch"] : [];
            await create({jit_backend:"ir", ir_region_budget:budget, ir_opt_level:level, ir_passes_disabled:disabled_passes});
            const policy = await info();
            check(policy.ir_opt_level === level && JSON.stringify(policy.ir_passes_disabled) === JSON.stringify(disabled_passes), "optimization policy reached CPU");
            policy.ir_passes_disabled.push("gvn");
            check((await info()).ir_passes_disabled.length === disabled_passes.length, "pass list is copied");
            await vm.configure_ir_diagnostics(1); await boot();
            await vm.write_memory(Uint8Array.of(0x40,0xEB,0xFD),pc);
            const before_policy = await info(); await vm.write_memory(bytes(pc),0x600);
            await until(async () => (await info()).ir.tier2_published > before_policy.ir.tier2_published, "configured optimizer publishes Tier 2");
            await vm.stop();
            const compiled = await info(), phases = compiled.ir.diagnostics.compiler;
            check(phases.lower.calls > 0 && compiled.ir.cache_hits > 0, "configured pipeline executed IR");
            for(const phase of ["machine_fold", "machine_allocation", "machine_forward"])
                check(phases[phase].calls === 0, "disabled optimization was not invoked: " + phase);
            if(level === 2) check(phases.machine_stack.calls > 0, "independent enabled pass still runs");
            const snapshot = await vm.save_state(); await vm.restore_state(snapshot); await vm.restart();
            check((await info()).ir_opt_level === level && JSON.stringify((await info()).ir_passes_disabled) === JSON.stringify(disabled_passes), "restore/restart preserve destination optimizer policy");
            await destroy();
        }
        log("PASS: optimization levels 0/1/2 and individual pass controls execute, copy and survive restore/restart");

        await create({ jit_backend: "ir", ir_region_budget: budget, disable_jit: true });
        await boot(); await vm.stop();
        const disabled = await info();
        check(!disabled.ir.enabled && !disabled.ir.tier1_attempts, "disable_jit disables IR compilation");
        await destroy();
        await create({ ir_tier0: undefined }); await boot();
        await vm.write_memory(Uint8Array.of(0x40, 0xEB, 0xFD), 0x1200000);
        await vm.write_memory(bytes(0x1200000), 0x600);
        // (32-bit code in the x64 page tier since Legacy32's flip; Tier-0 stays
        // enabled for what the page tier cannot run)
        await until(async () => (await info()).ir.page_tier.native_instructions > 0, "default page tier runs 32-bit code");
        await vm.stop();
        const defaults = await info();
        check(defaults.backend === "ir" && defaults.ir.enabled && defaults.ir.tier0.enabled && defaults.ir.page_tier.legacy32
            && defaults.ir.page_tier.functions > 0, "default is IR with the page tier and Tier-0");
        await destroy();
        log("PASS: explicit disable_jit and the default IR + page tier backend");

        await create({ jit_backend: "ir", ir_region_budget: budget, initial_state: { buffer: ir_snapshot } });
        await assert_ir();
        check(!(await info()).ir.cache_entries, "IR snapshot contains no compiled cache");
        await vm.run();
        await until(async () => (await info()).ir.tier2_published > 0, "IR recompiles the restored guest");
        await vm.stop(); await assert_ir(); await destroy();
        log("PASS: snapshots restore without compiled code and recompile under the destination policy");

        for(const [extra, error] of [
            [{ jit_backend: "unknown" }, "jit_backend must"],
            [{ jit_backend: null }, "jit_backend must"],
            [{ jit_backend: "legacy" }, "legacy backend was removed"],
            [{ jit_backend: "ir", ir_stats: "full" }, "ir_stats must"],
            [{ jit_backend: "ir", ir_verify: "always" }, "ir_verify must"],
            [{ jit_backend: "ir", ir_dump: null }, "ir_dump must"],
            [{ ir_tier0: 1 }, "ir_tier0 must"],
            [{ jit_backend: "ir", ir_opt_level: null }, "ir_opt_level must"],
            [{ jit_backend: "ir", ir_opt_level: 3 }, "ir_opt_level must"],
            [{ jit_backend: "ir", ir_opt_level: 1.5 }, "ir_opt_level must"],
            [{ jit_backend: "ir", ir_passes_disabled: "gvn" }, "ir_passes_disabled must"],
            [{ jit_backend: "ir", ir_passes_disabled: ["typo"] }, "ir_passes_disabled must"],
            [{ jit_backend: "ir", ir_passes_disabled: ["gvn", "gvn"] }, "ir_passes_disabled must"],
            [{ jit_backend: "ir", ir_region_budget: { execution_budget: 0 } }, "execution_budget"],
            [{ jit_backend: "ir", ir_region_budget: { hot_threshold: 1.5 } }, "hot_threshold"],
            [{ jit_backend: "ir", ir_region_budget: { promotion_threshold: NaN } }, "promotion_threshold"],
            [{ jit_backend: "ir", ir_region_budget: { max_source_bytes: 4294967296 } }, "max_source_bytes"],
            [{ jit_backend: "ir", ir_region_budget: { rep_iterations: null } }, "rep_iterations"],
            [{ jit_backend: "ir", ir_region_budget: { typo: 1 } }, "Unknown ir_region_budget"],
            [{ ir_region_budget: [] }, "ir_region_budget must"],
        ]) { await create({ ...extra, autostart: true }, error); await destroy(); }
        log("PASS: invalid backend and budgets report emulator-error before autostart");
        if(!options.cpu_worker)
        {
            for(const wasm_fn of [
                () => { throw new Error("synchronous core load failure"); },
                () => Promise.reject(new Error("asynchronous core load failure")),
            ]) { await create({ wasm_fn, autostart: true }, "core load failure"); await destroy(); }
            log("PASS: synchronous and asynchronous custom core failures report emulator-error");
        }
    }
    finally { await destroy(); }
}
