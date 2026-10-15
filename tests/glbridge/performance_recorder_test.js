"use strict";
const assert = require("node:assert/strict");
(async () => {
    const { PerformanceRecorder } = await import("../../src/browser/performance_recorder.js");
    let time = 0, instructions = 0, counterEnabled = false;
    let counters = [0, 0, 0];
    const reads = [], publicationCalls = [];
    let resolvePublish;
    const buffer = { get(offset, length, callback) {
        if (offset === 0) callback(new Uint8Array(length));
        else if (offset === 999) throw new Error("disk failed");
        else reads.push(() => callback(new Uint8Array(length)));
    } };
    const cpu = {
        get_jit_info: () => ({ backend: "ir" }),
        devices: { ide: { primary: { master: { buffer } } } },
        disk_devices() { return [["hda", { buffer }]]; },
        wm: { exports: {
            performance_recording_enable(value) { counterEnabled = !!value; if (value) counters = [0, 0, 0]; },
            performance_recording_get(index) { return counters[index]; },
        }, wasm_table: { get() { return null; } } },
        main_loop() { time += 4; instructions = instructions + 100 >>> 0; counters[0] += 25; counters[1] += 75; return 0; },
        jit_publish(client, id, slot, pointer, length) {
            publicationCalls.push([id, slot, pointer, length]);
            return new Promise(resolve => { resolvePublish = resolve; });
        },
        jit_clear_func() {},
    };
    const runtime = { cpu, restore_state() {}, restart() {}, destroy() {} };
    const emulator = { v86: runtime, is_running: () => true, get_instruction_counter: () => instructions };
    const recorder = new PerformanceRecorder(emulator, { now: () => time });
    const originalLoop = cpu.main_loop, originalGet = buffer.get;
    recorder.start();
    assert.equal(counterEnabled, true);
    buffer.get(0, 512, () => {});
    buffer.get(512, 8192, () => {});
    time = 5;
    buffer.get(8704, 4096, () => {});
    time = 15; reads.shift()();
    time = 20; reads.shift()();
    cpu.main_loop();
    const published = cpu.jit_publish(0, 1n, 1, 0x1000, 200);
    time += 10;
    resolvePublish(true);
    assert.equal(await published, true, "the wrapper forwards the publication result");
    recorder.mark("scene_ready");
    const report = recorder.stop();
    assert.equal(report.metadata.jit_backend, "ir", "report records the actual selected backend");
    assert.equal(report.jit.start.backend, "ir");
    assert.equal(report.jit.end.backend, "ir");
    assert.equal(report.disks[0].callback_latency_ms, 30, "overlapping read latencies are summed separately");
    assert.equal(report.samples.at(-1).disk_any_request_pending_ms, 20, "union of outstanding reads does not double count overlap");
    assert.equal(report.disks[0].synchronous_completions, 1);
    assert.equal(report.summary.main_loop_wall_ms, 4);
    assert.equal(report.summary.jit_compile_publish_latency_ms, 10);
    assert.deepEqual(report.execution, { interpreted_steps: 25, jit_steps: 75 });
    assert.equal(cpu.main_loop, originalLoop);
    assert.equal(buffer.get, originalGet);
    assert.equal(counterEnabled, false);
    assert.equal(recorder.timer, null);

    recorder.start();
    const late = cpu.jit_publish(0, 2n, 1, 0x2000, 100), resolveLate = resolvePublish;
    const failed = cpu.jit_publish(0, 3n, 2, 0x3000, 100), resolveFailed = resolvePublish;
    assert.equal(recorder.pending_jit.size, 2);
    resolveFailed(false);
    assert.equal(await failed, false);
    assert.equal(recorder.pending_jit.size, 1, "a failed publication is no longer pending");
    const second = recorder.stop();
    assert.equal(second.summary.jit_requests, 2);
    assert.equal(second.summary.jit_finished, 0, "a failed publication is not a finished one");
    assert.deepEqual(publicationCalls.slice(-2), [[2n, 1, 0x2000, 100], [3n, 2, 0x3000, 100]], "the wrapper forwards the publication arguments");

    recorder.start();
    resolveLate(true);
    assert.equal(await late, true);
    assert.equal(recorder.stats.jit_finished, 0, "a completion from an earlier recording is not counted");
    const abort = new AbortController();
    buffer.get(512, 4096, () => {}, { signal: abort.signal });
    abort.abort();
    assert.equal(recorder.pending_reads.size, 0);
    assert.throws(() => buffer.get(999, 512, () => {}), /disk failed/);
    assert.equal(recorder.stop().disks[0].errors, 1);
    recorder.start();
    reads.shift()(); // Old callback still reaches the device, but cannot pollute a new recording.
    assert.equal(recorder.disks[0].completed, 0);
    assert.equal(report.disks[0].completed, 3, "previous report is stable across subsequent runs");
    runtime.restore_state(new ArrayBuffer(0));
    assert.equal(recorder.active, false);
    assert.equal(recorder.report.reason, "state_restore");
    assert.equal(buffer.get, originalGet);

    instructions = 0xfffffff0;
    recorder.start();
    instructions = 16;
    assert.equal(recorder.stop().samples.at(-1).instruction_steps, 32, "instruction counter wrap is accounted for");
    recorder.start();
    let delivered = false;
    buffer.get(0, 512, () => { delivered = true; }, { signal: abort.signal });
    const preAborted = recorder.stop();
    assert.equal(delivered, true, "already-aborted request preserves underlying callback behavior");
    assert.equal(preAborted.disks[0].aborted, 1);
    assert.equal(preAborted.disks[0].completed, 0);
    assert.equal(preAborted.pending_reads_at_stop, 0);
    delete cpu.wm.exports.performance_recording_enable;
    recorder.start();
    assert.equal(recorder.stop().execution, null, "old Wasm reports unavailable counters, not false zeros");

    cpu.wm.exports.performance_recording_enable = value => { counterEnabled = !!value; if (value) counters = new Array(8).fill(0); };
    cpu.wm.exports.performance_recording_version = () => 2;
    cpu.instruction_pointer = new Int32Array([0x401123]);
    cpu.cr = new Int32Array([0, 0, 0, 0x1000]);
    cpu.cpl = new Uint8Array([3]);
    cpu.in_hlt = new Uint8Array([0]);
    cpu.main_loop = () => { time += 4; counters[5]++; counters[6] = 1; counters[7]++; };
    recorder.start();
    cpu.main_loop();
    time += 20;
    cpu.cr[3] = 0x2000;
    cpu.main_loop();
    const v2 = recorder.stop();
    assert.equal(v2.counter_version, 2);
    assert.equal(v2.execution.sync_codegen_ms, 2);
    assert.equal(v2.samples.at(-1).main_loop_without_codegen_ms, 6);
    assert.equal(v2.hotspots.length, 2, "same virtual page in two address spaces is kept separate");
    assert.equal(v2.hotspots[0].linear_page, 0x401000);
    assert.equal(v2.hotspots[0].sampled_codegen_ms, 1);
    assert.equal(v2.hotspots[0].sampled_main_loop_ms, 4);
    recorder.start();
    cpu.in_hlt[0] = 1;
    cpu.main_loop();
    assert.equal(recorder.hotspots.size, 0, "halted entry is not a CPU hotspot sample");
    cpu.in_hlt[0] = 0;
    for (let i = 0; i < 2050; i++) {
        time += 20;
        cpu.instruction_pointer[0] = i * 4096;
        cpu.main_loop();
    }
    const bounded = recorder.stop();
    assert.equal(bounded.hotspots.length, 2048);
    assert.equal(bounded.hotspots_dropped_samples, 2);
    assert.equal(v2.hotspots.length, 2, "past hotspot reports remain stable");
    assert.equal(v2.execution_hotspots, null, "v2 Wasm cannot supply execution samples");
    assert.equal(v2.execution.execution_batch_ms, undefined, "missing v3 counters are not false zero values");

    cpu.wm.exports.performance_recording_enable = value => { if (value) counters = new Array(23).fill(0); };
    cpu.wm.exports.performance_recording_version = () => 3;
    const executionRows = [[0x1000, 0x401000, 3, 1, 5, 12, 100, 10, 20, 0x401234],
        [0x2000, 0x401000, 3, 0, 2, 3, 10, 11, 21, 0x401567]];
    cpu.wm.exports.performance_recording_hotspot_count = () => executionRows.length;
    cpu.wm.exports.performance_recording_hotspot_get = (row, field) => executionRows[row][field];
    recorder.start();
    counters[8] = 25; counters[9] = 4; counters[18] = 12; counters[19] = 3;
    counters[20] = 5; counters[21] = 2; counters[22] = 7;
    const v3 = recorder.stop();
    assert.equal(v3.version, 6);
    assert.equal(v3.execution.execution_batch_ms, 25);
    assert.equal(v3.execution.hardware_irq_ms, 4);
    assert.equal(v3.execution.sampled_jit_ms, 12);
    assert.equal(v3.execution.sampled_interpreted_ms, 3);
    assert.equal(v3.execution.execution_hotspots_dropped_samples, 7);
    assert.equal(v3.execution_chunk_sample_probability, 1 / 256);
    assert.equal(v3.execution_hotspots[0].last_linear_eip, 0x401234);
    assert.equal(v3.execution_hotspots[1].jit, 0);
    recorder.start();
    executionRows[0][4] = 0;
    const fresh = recorder.stop();
    assert.equal(fresh.execution.execution_batch_ms, 0);
    assert.equal(v3.execution_hotspots[0].samples, 5, "exported execution rows are independent of later runs");
    cpu.wm.exports.performance_recording_version = () => 4;
    cpu.wm.exports.performance_recording_enable = value => { if (value) counters = new Array(24).fill(0); };
    executionRows.splice(0, executionRows.length,
        [0x1000, 0x401000, 3, 1, 1, 0, 5, 20, 20, 0x401200],
        [0x1000, 0x401000, 3, 1, 1, 0, 7, 10, 10, 0x401100]);
    recorder.start();
    counters[22] = 100; counters[23] = 8;
    const v4 = recorder.stop();
    assert.equal(v4.counter_version, 4);
    assert.equal(v4.execution_chunk_sample_probability, null);
    assert.equal(v4.execution_sample_interval_ms, 10);
    assert.equal(v4.execution.sampled_jit_ms, null);
    assert.equal(v4.execution.sampled_interpreted_ms, null);
    assert.equal(v4.execution.execution_samples_not_retained, 100);
    assert.equal(v4.execution.execution_sample_missed_batches, 8);
    assert.equal(v4.execution_hotspots.length, 1);
    assert.deepEqual(v4.execution_hotspots[0], { cr3: 0x1000, linear_page: 0x401000, cpl: 3, jit: 1,
        samples: 2, sampled_execution_ms: null, sampled_steps: 12,
        first_ms: 10, last_ms: 20, last_linear_eip: 0x401200 });
    assert.equal(v4.x87_counters_available, false);
    assert.equal(v4.x87, null);
    let x87Enabled = false, x87Counts = new Map(), precision = 80, rounding = 0;
    cpu.wm.exports.performance_recording_x87_enable = value => {
        x87Enabled = !!value;
        if (value) x87Counts = new Map();
    };
    cpu.wm.exports.performance_recording_x87_get = (...key) => x87Counts.get(key.join(":")) || 0;
    cpu.wm.exports.performance_recording_x87_state = index => index ? rounding : precision;
    recorder.start();
    assert.equal(x87Enabled, true);
    x87Counts.set("0:0:2:0", 3);
    x87Counts.set("0:1:2:0", 7);
    x87Counts.set("2:1:1:2", 4);
    time += 50;
    recorder.sample();
    x87Counts.set("0:1:2:0", 17);
    precision = 64; rounding = 2;
    const x87Report = JSON.parse(JSON.stringify(recorder.stop()));
    assert.equal(x87Enabled, false);
    assert.equal(x87Report.x87_counters_available, true);
    assert.equal(x87Report.x87.initial_state.significand_bits, 64);
    assert.equal(x87Report.x87.current_state.significand_bits, 53);
    assert.equal(x87Report.x87.current_state.rounding, "down");
    assert.equal(x87Report.x87.operations.add.total, 20);
    assert.equal(x87Report.x87.operations.add.fast_path_ratio, 0.15);
    assert.equal(x87Report.x87.operations.add.softfloat_fallback_ratio, 0.85);
    assert.equal(x87Report.x87.operations.sub.fast_path_ratio, null);
    assert.equal(x87Report.x87.operations.mul.modes[0].rounding, "down");
    assert.equal(x87Report.samples.at(-2).x87.operations.add.total, 10);
    recorder.start();
    assert.equal(recorder.x87_counters().operations.add.total, 0);
    runtime.restore_state(new ArrayBuffer(0));
    assert.equal(x87Enabled, false, "state restore stops x87 recording too");
    assert.equal(x87Report.x87.operations.add.total, 20, "previous reports stay independent");
    cpu.wm.exports.performance_recording_x87_version = () => 2;
    cpu.wm.exports.performance_recording_x87_state = index => [64, 0, 1][index];
    recorder.start();
    x87Counts.set("0:0:1:0", 2);
    x87Counts.set("0:2:1:0", 18);
    x87Counts.set("3:2:1:0", 5);
    const native = recorder.stop();
    assert.equal(native.x87.version, 2);
    assert.equal(native.x87.initial_state.arithmetic_mode, "fast_f64");
    assert.equal(native.x87.operations.add.fast_path, 20);
    assert.equal(native.x87.operations.add.compatible_fast_path, 2);
    assert.equal(native.x87.operations.add.approximate_f64, 18);
    assert.equal(native.x87.operations.add.approximate_f64_ratio, 0.9);
    assert.equal(native.x87.operations.div.total, 5);
    assert.equal(native.x87.operations.div.softfloat_fallback, 0);
    assert.equal(native.samples.at(-1).x87.operations.div.approximate_f64, 5);
    cpu.wm.exports.performance_recording_x87_version = () => 3;
    cpu.wm.exports.get_x87_jit_cache = () => true;
    const cacheCounts = [10, 2, 60, 30, 20, 140];
    cpu.wm.exports.performance_recording_x87_cache_get = i => cacheCounts[i];
    recorder.start();
    const cached = recorder.stop();
    assert.equal(cached.x87.version, 3);
    assert.equal(cached.x87.current_state.jit_cache_enabled, true);
    assert.deepEqual(cached.x87.jit_cache, { accepted_regions: 10, rejected_regions: 2,
        arithmetic_ops: 60, initial_conversions: 30, writebacks: 20, local_reads: 140 });
    assert.deepEqual(cached.samples.at(-1).x87.jit_cache, cached.x87.jit_cache);
    assert.equal(native.x87.jit_cache, null, "v2 has no cache instrumentation");
    cpu.wm.exports.performance_recording_x87_version = () => 4;
    cpu.wm.exports.performance_recording_x87_cache_get = i => [10,2,60,30,20,160,10,10][i];
    recorder.start();
    const comparisons = recorder.stop();
    assert.equal(comparisons.x87.jit_cache.comparison_ops, 10);
    assert.equal(comparisons.x87.jit_cache.comparison_regions, 10);
    assert.equal(cached.x87.jit_cache.comparison_ops, undefined, "v3 comparison count is unavailable");

    cpu.wm.exports.performance_recording_x87_version = () => 5;
    cpu.wm.exports.performance_recording_x87_cache_get = i => [10,2,60,3,2,160,10,10,90,50][i];
    recorder.start();
    const persistent = recorder.stop();
    assert.equal(persistent.x87.jit_cache.persistent_hits, 90);
    assert.equal(persistent.x87.jit_cache.cached_writes, 50);
    assert.equal(persistent.x87.jit_cache.writebacks, 2);
    assert.deepEqual(persistent.samples.at(-1).x87.jit_cache, persistent.x87.jit_cache);
    assert.equal(comparisons.x87.jit_cache.persistent_hits, undefined);

    console.log("performance_recorder_test: recording lifecycle, older Wasm cores and x87 reports passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
