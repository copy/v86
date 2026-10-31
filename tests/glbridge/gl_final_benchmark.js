// Paired whole-VM measurements from the same saved application state. The
// baseline is the F6 release asset, not reconstructed or simulated timings.
"use strict";
(function(global) {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const load = url => new Promise((resolve, reject) => {
        const script = document.createElement("script");script.src = url;script.onload = resolve;script.onerror = reject;document.head.append(script);
    });
    const summary = values => {
        const sorted = values.slice().sort((a, b) => a - b);return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * .95)], samples: values };
    };
    async function sample(vm) {
        const gpu = vm.graphics_proxy.bridge.glExecutor, previous = gpu.options.onSurface, submit = gpu.submit, swap = gpu.swapWindow;
        let cpu = 0, last = performance.now(), finish, fail, enabled = true;
        const wall = [], costs = [], done = new Promise((a, b) => { finish = a;fail = b; });
        gpu.submit = function(...args) { const start = performance.now();try { return submit.apply(this, args); } finally { cpu += performance.now() - start; } };
        gpu.swapWindow = function(...args) { const start = performance.now();try { return swap.apply(this, args); } finally { cpu += performance.now() - start; } };
        gpu.options.onSurface = (surface, reason) => {
            if (previous) previous(surface, reason);
            if (enabled && reason === "swap") { const now = performance.now();wall.push(now - last);costs.push(cpu);cpu = 0;last = now;if (wall.length >= 85) finish(); }
        };
        const timer = setTimeout(() => fail(new Error("application stopped before benchmark frames completed")), 180000);
        try { await vm.run();await done; }
        finally { enabled = false;clearTimeout(timer);await vm.stop();gpu.submit = submit;gpu.swapWindow = swap;gpu.options.onSurface = previous; }
        if (gpu.hostErrors.length || gpu.stats.refusals || gpu.stats.pipelinesRejected || gpu.stats.framesRejected) throw new Error("benchmark renderer failed");
        return { frameMs: summary(wall.slice(21)), executorCpuMs: summary(costs.slice(21)), stats: { ...gpu.stats } };
    }
    async function compare(snapshot, create, log) {
        const results = [];
        const begin = await fetch("/__timing_begin", { method: "POST" });
        if (!begin.ok) throw new Error("cannot isolate paired timing");
        try {
        for (const backend of ["candidate", "baseline", "baseline", "candidate"]) {
            log("paired timing: " + backend);await global.vm.destroy();
            await load(backend === "baseline" ? "/build/gl-final/baseline/libv86-webgpu.js" : "/build/glbridge/libv86-webgpu.js");
            await create();await global.vm.restore_state_stream(snapshot);await global.vm.stop();
            results.push({ backend, revision: global.V86GL_BUILD_REVISION, ...await sample(global.vm) });
        }
        // Leave the original candidate timeline installed for the following
        // second-program/session teardown check.
        await global.vm.restore_state_stream(snapshot);await global.vm.stop();global.vm.screen_adapter.screen_fill_buffer(true);await delay(100);
        return { baseline: "retro-gaming-site e0b52c0 (F6, before G presentation checkpoint fix)", warmupFrames: 21, measuredFrames: 64, order: results.map(r => r.backend), results };
        } finally { await fetch("/__timing_end", { method: "POST" }); }
    }
    global.GLFinalBenchmark = { compare };
})(globalThis);
