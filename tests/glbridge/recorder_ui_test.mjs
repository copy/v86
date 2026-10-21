// The performance recorder through the VM manager's console (index.html,
// docs/vm-manager-plan.md U4: Tools, "Record performance"): a library machine
// whose BIOS is an x87 loop, the CPU in its Worker (cpu_worker_ui_browser_test)
// or in the page (performance_recorder_ui_browser_test), the x87 policies of
// the page's address (x87_fast_math, x87_jit_cache) in its configuration.
// Until U7 these tests drove the old page (legacy.html, its ADVANCED build).

import { VMStore } from "../../src/app/vm_store.js";
import { new_config } from "../../src/app/vm_config.js";

/**
 * @param {boolean} worker
 * @return {Promise<{status: string, checks?: string[], error?: string}>}
 */
export async function run(worker)
{
    const query = new URLSearchParams(location.search);
    const fast_math = query.get("x87_fast_math") !== "0";
    const jit_cache_on = query.get("x87_jit_cache") !== "0";
    const checks = [];
    const check = (ok, label) => { if(!ok) throw new Error(label); checks.push(label); };
    const wait_for = async (predicate, timeout = 20000) =>
    {
        const deadline = performance.now() + timeout;
        while(!predicate())
        {
            if(performance.now() > deadline) throw new Error("UI readiness timeout");
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    };

    // fninit; loop: fld1; fld1; fmul; fadd; fsub; fcom; fstp; fstp; jmp loop
    const bios = new Uint8Array(65536).fill(0xf4);
    bios.set([0xea, 0x00, 0x01, 0x00, 0xf0], 0xfff0);
    bios.set([0xdb,0xe3,0xd9,0xe8,0xd9,0xe8,0xd8,0xc9,0xd8,0xc1,0xd8,0xe1,0xd8,0xd1,0xdd,0xd8,0xdd,0xd8,0xeb,0xee], 0x100);
    const config = new_config({ name: "x87 loop" });
    config.memory.mb = 32;
    config.machine.bios = { kind: "url", url: URL.createObjectURL(new Blob([bios])) };
    config.sound.device = "none";
    config.network = [{ device: "none", backend: "none", relay_url: "", mtu: 1500, mac_address_translation: false }];
    config.advanced.cpu_worker = worker;
    config.advanced.x87_fast_math = fast_math;
    config.advanced.x87_jit_cache = jit_cache_on;
    const store = await VMStore.open();
    const stored = await store.put(config);
    store.close();

    const frame = document.getElementById("app");
    frame.style.width = "1000px";
    frame.style.height = "700px";
    frame.src = "../../index.html?vm=" + stored.id;
    await new Promise(resolve => frame.onload = resolve);
    const win = frame.contentWindow;
    const $ = selector => win.document.querySelector(selector);
    const menu_item = async id =>
    {
        $("#menu_tools").click();
        await wait_for(() => $("#" + id));
        return $("#" + id);
    };
    const close_menu = () => { if($("#menu_tools").getAttribute("aria-expanded") === "true") $("#menu_tools").click(); };
    await wait_for(() => win.v86_console && $("#menu_tools"));
    if(worker)
    {
        $("#drawer_terminal").click();
        await wait_for(() => typeof win.Terminal === "function" && $(".console-drawer .terminal .xterm"));
        check(true, "serial terminal asset loads and initializes");
        const icon = new win.Image();
        await new Promise((resolve, reject) =>
        {
            icon.onload = resolve;
            icon.onerror = () => reject(new Error("application icon failed to load"));
            icon.src = win.document.querySelector('link[rel="apple-touch-icon"]').href;
        });
        check(icon.naturalWidth === 192 && icon.naturalHeight === 192, "application icon is a valid 192px image");
    }
    check((await menu_item("tools_export_report")).disabled && (await menu_item("tools_record")).textContent.includes("Record performance"),
        "recording controls initially idle");
    close_menu();
    (await menu_item("tools_record")).click();
    await wait_for(() => /Recording performance/.test($(".console-status").textContent));
    check((await menu_item("tools_record")).textContent.includes("Stop recording") && (await menu_item("tools_export_report")).disabled,
        "the VM manager starts the recorder from its Tools menu");
    close_menu();
    await new Promise(resolve => setTimeout(resolve, 600));
    (await menu_item("tools_record")).click();
    await wait_for(() => /Recorded/.test($(".console-status").textContent));
    check((await menu_item("tools_record")).textContent.includes("Record performance") && !(await menu_item("tools_export_report")).disabled,
        "stop enables JSON export");
    close_menu();

    // (the download's Blob, without Chrome's download flow)
    let exported;
    const create_url = win.URL.createObjectURL;
    win.URL.createObjectURL = blob => { exported = blob; return create_url.call(win.URL, blob); };
    win.HTMLAnchorElement.prototype.click = function() {};
    (await menu_item("tools_export_report")).click();
    check(!!exported, "download produces a Blob");
    const report = JSON.parse(await exported.text());
    if(worker) check(report.metadata.cpu_thread === "dedicated-worker", "the VM manager runs the CPU in its Worker");
    check(report.format === "v86-performance" && report.execution_counters_available,
        "export contains release Wasm counters through the VM manager");
    check(report.version === 6 && report.graphics.host.raf_available &&
        report.graphics.streams.some(row => row.api === "browser-raf" && row.events > 0),
        "the VM manager exports host frame timing in format v6");
    const mul = report.x87.operations.mul;
    if(worker)
    {
        // The counters cover x87 arithmetic in the interpreter's helpers. Native
        // x87 in compiled IR code is not counted: a loop compiled before recording
        // began can report zero, and interpreted instructions can still add counts
        // between the last sample and the stop.
        check(report.x87_counters_available && report.x87.version === 5 &&
            Number.isInteger(mul.total) && (mul.total === 0 || mul.fast_path_ratio === 1) &&
            report.samples.at(-1).x87.operations.mul.total <= mul.total,
            "worker report transport preserves actual x87 counters and snapshots");
    }
    else
    {
        check(report.x87_counters_available && report.x87.version === 5 &&
            mul.total > 0 && mul.fast_path_ratio === 1 && report.samples.at(-1).x87.operations.mul.total === mul.total,
            "the VM manager exports actual x87 counts, ratios and sample snapshots");
    }
    check(report.x87.current_state.arithmetic_mode === (fast_math ? "fast_f64" : "compatible") &&
        mul.approximate_f64 === (fast_math ? mul.total : 0),
        "the arithmetic policy of the configuration reaches the helpers and the report");
    if(worker)
    {
        check(report.x87.current_state.jit_cache_enabled === jit_cache_on, "Worker report preserves the selected cache policy");
        check(typeof report.x87.jit_cache.persistent_hits === "number" && typeof report.x87.jit_cache.cached_writes === "number" &&
            report.samples.at(-1).x87.jit_cache.cached_writes <= report.x87.jit_cache.cached_writes,
            "persistent cache metrics survive report export and sample transport");
    }
    else
    {
        check(report.x87.current_state.jit_cache_enabled === jit_cache_on &&
            (fast_math && jit_cache_on ? report.x87.jit_cache.accepted_regions > 0 && report.x87.jit_cache.comparison_ops > 0 : report.x87.jit_cache.accepted_regions === 0),
            "URL cache policy reaches native regions and exported cache counters");
        check(typeof report.x87.jit_cache.persistent_hits === "number" &&
            report.samples.at(-1).x87.jit_cache.cached_writes === report.x87.jit_cache.cached_writes &&
            (!(fast_math && jit_cache_on) || report.x87.jit_cache.cached_writes > 0),
            "persistent cache metrics survive report export and sample transport");
    }
    check(report.graphics.available === false, "disabled graphics is reported unavailable, not zero GPU cost");
    check(report.execution.jit_steps > 0 && report.summary.main_loop_calls > 0, "the library's CPU hooks are in the report");
    check(report.counter_version === 4 && report.execution.sync_codegen_ms >= 0, "the VM manager exports versioned code-generation timing");
    check(report.hotspots.length > 0, "the VM manager exports entry hotspots");
    check(report.execution.execution_batch_ms > 0 && report.execution.sampled_jit_chunks > 0 &&
        report.execution_hotspots.some(row => row.jit === 1 && row.samples > 0),
        "the VM manager preserves v3 execution timing and exported Wasm hotspot accessors");
    check(/^[a-f0-9]{64}$/.test(report.metadata.wasm_sha256), "export identifies actual Wasm bytes by SHA-256");
    check(report.duration_ms >= 600 && report.reason === "user", "export covers the interval between start and stop");

    (await menu_item("tools_record")).click();
    await wait_for(() => /Recording performance/.test($(".console-status").textContent));
    (await menu_item("tools_record")).click();
    await wait_for(() => /Recorded/.test($(".console-status").textContent));
    (await menu_item("tools_export_report")).click();
    const next = JSON.parse(await exported.text());
    check(next.markers.length === 1, "next recording starts with fresh markers");
    frame.remove();
    return { status: "PASS", checks };
}
