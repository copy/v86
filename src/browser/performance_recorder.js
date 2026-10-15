import { WASM_TABLE_SIZE, WASM_TABLE_OFFSET } from "../const.js";
import { GraphicsPerformance } from "./graphics_performance.js";

const READ_LATENCY_LIMITS = [1, 2, 5, 10, 25, 50, 100];

// No request payloads, disk filenames, URLs or guest RAM are collected.
// Hooks exist only while recording; retained data is bounded by duration and
// a fixed number of slow-event samples, not by the number of guest reads.
export class PerformanceRecorder
{
    constructor(emulator, options = {})
    {
        this.emulator = emulator;
        this.now = options.now || (() => performance.now());
        this.max_ms = options.max_ms || 10 * 60 * 1000;
        this.on_stop = options.on_stop || (() => {});
        this.metadata = options.metadata || {};
        this.timer = null;
        this.active = false;
        this.started = 0;
        this.cleanup = [];
        this.pending_reads = new Map();
        this.pending_jit = new Map();
        this.next_read = 0;
        this.pending_since = 0;
        this.read_pending_ms = 0;
        this.total_instructions = 0;
        this.last_instructions = 0;
        this.samples = [];
        this.markers = [];
        this.slow_reads = [];
        this.slow_jit = [];
        this.disks = [];
        this.stats = {};
        this.has_counters = false;
        this.counter_version = 0;
        this.has_x87_counters = false;
        this.x87_counter_version = 0;
        this.x87_initial_state = null;
        this.hotspots = new Map();
        this.hotspots_dropped = 0;
        this.next_hotspot = 0;
        this.report = null;
        this.jit_start = null;
        this.graphics = null;
        this.metadata["wasm_sha256"] = null;
        const source = emulator.wasm_source;
        if(source?.byteLength && globalThis.crypto?.subtle)
        {
            globalThis.crypto.subtle.digest("SHA-256", source).then(hash => {
                this.metadata["wasm_sha256"] = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
            }).catch(() => {});
        }
    }

    start()
    {
        if(this.active) throw new Error("Performance recording is already active");
        const cpu = this.emulator.v86.cpu;
        const exports = cpu.wm.exports;
        this.jit_start = cpu.get_jit_info?.() || null;
        this.metadata["jit_backend"] = this.jit_start?.["backend"] || "ir";
        this.active = true;
        this.started = this.now();
        this.cleanup = [];
        this.pending_reads = new Map();
        this.pending_jit = new Map();
        this.next_read = 0;
        this.pending_since = 0;
        this.read_pending_ms = 0;
        this.total_instructions = 0;
        this.last_instructions = this.emulator.get_instruction_counter() >>> 0;
        this.samples = [];
        this.markers = [];
        this.slow_reads = [];
        this.slow_jit = [];
        this.disks = [];
        this.hotspots = new Map();
        this.hotspots_dropped = 0;
        this.next_hotspot = this.started;
        this.stats = {
            "main_loop_calls": 0, "main_loop_wall_ms": 0, "main_loop_max_ms": 0,
            "jit_requests": 0, "jit_finished": 0, "jit_wasm_bytes": 0,
            "jit_compile_publish_latency_ms": 0, "jit_compile_publish_max_ms": 0,
            "jit_single_clear_calls": 0,
        };
        const run = this.stats;
        const live = () => this.active && this.stats === run;
        this.has_counters = !!exports["performance_recording_enable"] && !!exports["performance_recording_get"];
        this.counter_version = this.has_counters ? exports["performance_recording_version"]?.() || 1 : 0;
        if(this.has_counters) exports["performance_recording_enable"](1);
        this.has_x87_counters = !!exports["performance_recording_x87_enable"] &&
            !!exports["performance_recording_x87_get"] && !!exports["performance_recording_x87_state"];
        this.x87_counter_version = this.has_x87_counters ? exports["performance_recording_x87_version"]?.() || 1 : 0;
        this.x87_initial_state = this.has_x87_counters ? this.x87_state() : null;
        if(this.has_x87_counters) exports["performance_recording_x87_enable"](1);

        const main_loop = cpu.main_loop;
        const timed_loop = () => {
            const start = this.now();
            let hotspot = null;
            if(start >= this.next_hotspot && cpu.instruction_pointer && cpu.cr && cpu.cpl && cpu.in_hlt)
            {
                this.next_hotspot = start + 10;
                if(!cpu.in_hlt[0])
                {
                    hotspot = { eip: cpu.instruction_pointer[0] >>> 0, cr3: cpu.cr[3] >>> 0,
                        cpl: cpu.cpl[0], start,
                        codegen: this.counter_version >= 2 ? exports["performance_recording_get"](5) : null };
                }
            }
            try { return main_loop.call(cpu); }
            finally {
                if(live())
                {
                    const ms = this.now() - start;
                    run["main_loop_calls"]++;
                    run["main_loop_wall_ms"] += ms;
                    run["main_loop_max_ms"] = Math.max(run["main_loop_max_ms"], ms);
                    if(hotspot) this.record_hotspot(hotspot, ms);
                }
            }
        };
        cpu.main_loop = timed_loop;
        this.cleanup.push(() => { if(cpu.main_loop === timed_loop) cpu.main_loop = main_loop; });

        // Page functions are published through x64_page_publish, which
        // resolves to whether the function was installed. Each call has its
        // own token, so a completion after stop/restart never reaches a later
        // recording.
        const publish = cpu.x64_page_publish;
        const timed_publish = (id, slot, pointer, length) => {
            if(!live()) return publish.call(cpu, id, slot, pointer, length);
            const token = {}, start = this.now(), bytes = length >>> 0;
            run["jit_requests"]++;
            run["jit_wasm_bytes"] += bytes;
            this.pending_jit.set(token, start);
            return publish.call(cpu, id, slot, pointer, length).then(success => {
                if(this.pending_jit.delete(token) && success)
                {
                    const ms = this.now() - start;
                    run["jit_finished"]++;
                    run["jit_compile_publish_latency_ms"] += ms;
                    run["jit_compile_publish_max_ms"] = Math.max(run["jit_compile_publish_max_ms"], ms);
                    this.keep_slowest(this.slow_jit, { "start_ms": start - this.started,
                        "duration_ms": ms, "slot": slot, "wasm_bytes": bytes });
                }
                return success;
            });
        };
        cpu.x64_page_publish = timed_publish;
        this.cleanup.push(() => { if(cpu.x64_page_publish === timed_publish) cpu.x64_page_publish = publish; });
        const clear_one = cpu.jit_clear_func;
        const count_one = index => { if(live()) run["jit_single_clear_calls"]++; return clear_one.call(cpu, index); };
        cpu.jit_clear_func = count_one;
        this.cleanup.push(() => { if(cpu.jit_clear_func === count_one) cpu.jit_clear_func = clear_one; });

        const seen = new Set();
        for(const [name, disk] of cpu.disk_devices())
        {
            const buffer = disk && disk.buffer;
            if(!buffer || seen.has(buffer)) continue;
            seen.add(buffer);
            const stats = { "device": name, "requests": 0, "completed": 0, "aborted": 0, "errors": 0,
                "requested_bytes": 0, "returned_bytes": 0, "synchronous_completions": 0,
                "callback_latency_ms": 0, "max_callback_latency_ms": 0, "small_reads_le_4k": 0,
                "latency_histogram": new Array(8).fill(0) };
            this.disks.push(stats);
            const original = buffer.get;
            const measured_get = (offset, length, callback, options) => {
                if(!live()) return original.call(buffer, offset, length, callback, options);
                const id = ++this.next_read, start = this.now();
                let synchronous = true, ended = false;
                stats["requests"]++;
                stats["requested_bytes"] += length;
                if(length <= 4096) stats["small_reads_le_4k"]++;
                if(!this.pending_reads.size) this.pending_since = start;
                const signal = options && options.signal;
                const finish = kind => {
                    if(ended) return;
                    ended = true;
                    if(signal) signal.removeEventListener("abort", abort);
                    if(!live()) return;
                    this.pending_reads.delete(id);
                    if(!this.pending_reads.size) this.read_pending_ms += this.now() - this.pending_since;
                    if(kind) stats[kind]++;
                };
                const abort = () => finish("aborted");
                this.pending_reads.set(id, { start, detach: () => { if(signal) signal.removeEventListener("abort", abort); } });
                if(signal)
                {
                    signal.addEventListener("abort", abort, { once: true });
                    if(signal.aborted) abort();
                }
                try {
                    return original.call(buffer, offset, length, data => {
                        if(live() && !ended)
                        {
                            const ms = this.now() - start;
                            stats["completed"]++;
                            stats["returned_bytes"] += data.byteLength;
                            stats["callback_latency_ms"] += ms;
                            stats["max_callback_latency_ms"] = Math.max(stats["max_callback_latency_ms"], ms);
                            if(synchronous) stats["synchronous_completions"]++;
                            let bin = 0;
                            while(bin < READ_LATENCY_LIMITS.length && ms >= READ_LATENCY_LIMITS[bin]) bin++;
                            stats["latency_histogram"][bin]++;
                            if(ms >= 5) this.keep_slowest(this.slow_reads, { "device": name,
                                "offset": offset, "bytes": length, "start_ms": start - this.started, "duration_ms": ms });
                        }
                        finish(null);
                        callback(data);
                    }, options);
                } catch(error) { finish("errors"); throw error; }
                finally { synchronous = false; }
            };
            buffer.get = measured_get;
            this.cleanup.push(() => { if(buffer.get === measured_get) buffer.get = original; });
        }

        // State changes invalidate the measurement timeline. Stop before they
        // can reset instruction counters, disks, or the active Wasm table.
        const runtime = this.emulator.v86;
        const restore = runtime.restore_state;
        const stop_restore = state => { this.stop("state_restore"); return restore.call(runtime, state); };
        runtime.restore_state = stop_restore;
        this.cleanup.push(() => { if(runtime.restore_state === stop_restore) runtime.restore_state = restore; });
        const restart = runtime.restart;
        const stop_restart = () => { this.stop("restart"); return restart.call(runtime); };
        runtime.restart = stop_restart;
        this.cleanup.push(() => { if(runtime.restart === stop_restart) runtime.restart = restart; });
        const destroy = runtime.destroy;
        const stop_destroy = () => { this.stop("destroy"); return destroy.call(runtime); };
        runtime.destroy = stop_destroy;
        this.cleanup.push(() => { if(runtime.destroy === stop_destroy) runtime.destroy = destroy; });

        this.graphics = new GraphicsPerformance(this.emulator, { now: this.now, start_ms: this.started,
            cpu_time: () => run["main_loop_wall_ms"] });
        this.mark("start");
        this.sample();
        this.timer = setInterval(() => {
            this.sample();
            if(this.now() - this.started >= this.max_ms) this.stop("time_limit");
        }, 500);
    }

    keep_slowest(list, item)
    {
        if(list.length < 64) { list.push(item); return; }
        let smallest = 0;
        for(let i = 1; i < list.length; i++) if(list[i]["duration_ms"] < list[smallest]["duration_ms"]) smallest = i;
        if(item["duration_ms"] > list[smallest]["duration_ms"]) list[smallest] = item;
    }

    record_hotspot(sample, ms)
    {
        const page = (sample.eip & ~4095) >>> 0;
        const key = sample.cr3 + ":" + sample.cpl + ":" + page;
        let row = this.hotspots.get(key);
        if(!row)
        {
            if(this.hotspots.size >= 2048) { this.hotspots_dropped++; return; }
            row = { "cr3": sample.cr3, "cpl": sample.cpl, "linear_page": page,
                "samples": 0, "sampled_main_loop_ms": 0,
                "sampled_codegen_ms": sample.codegen === null ? null : 0,
                "first_ms": sample.start - this.started, "last_ms": 0, "last_linear_eip": 0 };
            this.hotspots.set(key, row);
        }
        row["samples"]++;
        row["sampled_main_loop_ms"] += ms;
        if(sample.codegen !== null)
            row["sampled_codegen_ms"] += this.emulator.v86.cpu.wm.exports["performance_recording_get"](5) - sample.codegen;
        row["last_ms"] = sample.start - this.started;
        row["last_linear_eip"] = sample.eip;
    }

    counters()
    {
        if(!this.has_counters) return null;
        const get = this.emulator.v86.cpu.wm.exports["performance_recording_get"];
        // Counters 2..4 (legacy table capacity events) are no longer reported.
        const result = { "interpreted_steps": get(0), "jit_steps": get(1) };
        if(this.counter_version >= 2)
        {
            result["sync_codegen_ms"] = get(5);
            result["sync_codegen_max_ms"] = get(6);
            result["sync_codegen_calls"] = get(7);
        }
        if(this.counter_version >= 3)
        {
            const fields = ["execution_batch_ms", "hardware_irq_ms", "execution_batch_calls",
                "hardware_irq_calls", "halted_entry_calls", "zero_delay_returns", "positive_delay_returns",
                "halted_returns", "jit_chunks", "interpreted_chunks", "sampled_jit_ms",
                "sampled_interpreted_ms", "sampled_jit_chunks", "sampled_interpreted_chunks",
                "execution_hotspots_dropped_samples"];
            fields.forEach((field, index) => { result[field] = get(index + 8); });
        }
        if(this.counter_version >= 4)
        {
            result["sampled_jit_ms"] = null;
            result["sampled_interpreted_ms"] = null;
            result["execution_hotspots_dropped_samples"] = null;
            result["execution_samples_not_retained"] = get(22);
            result["execution_sample_missed_batches"] = get(23);
        }
        return result;
    }

    x87_state()
    {
        const get = this.emulator.v86.cpu.wm.exports["performance_recording_x87_state"];
        const precision = get(0), rounding = get(1);
        return { "arithmetic_mode": this.x87_counter_version >= 2 ? (get(2) ? "fast_f64" : "compatible") : "compatible",
            "jit_cache_enabled": !!this.emulator.v86.cpu.wm.exports["get_x87_jit_cache"]?.(),
            "softfloat_precision": precision,
            "significand_bits": ({ 32: 24, 64: 53, 80: 64 })[precision] || null,
            "rounding": ["nearest_even", "toward_zero", "down", "up"][rounding] || "unknown" };
    }

    x87_counters()
    {
        if(!this.has_x87_counters) return null;
        const get = this.emulator.v86.cpu.wm.exports["performance_recording_x87_get"];
        const operations = {};
        const names = this.x87_counter_version >= 2 ? ["add", "sub", "mul", "div"] : ["add", "sub", "mul"];
        for(const [op, name] of names.entries())
        {
            let fast = 0, fallback = 0, approximate = 0;
            const modes = [];
            for(let precision = 0; precision < 3; precision++) for(let rounding = 0; rounding < 4; rounding++)
            {
                const hits = get(op, 0, precision, rounding), misses = get(op, 1, precision, rounding);
                const native = this.x87_counter_version >= 2 ? get(op, 2, precision, rounding) : 0;
                fast += hits + native;
                fallback += misses;
                approximate += native;
                if(hits + misses + native) modes.push({ "softfloat_precision": [32, 64, 80][precision],
                    "significand_bits": [24, 53, 64][precision],
                    "rounding": ["nearest_even", "toward_zero", "down", "up"][rounding],
                    "total": hits + misses + native, "fast_path": hits + native,
                    "compatible_fast_path": hits, "approximate_f64": native, "softfloat_fallback": misses });
            }
            const total = fast + fallback;
            operations[name] = { "total": total, "fast_path": fast, "softfloat_fallback": fallback,
                "compatible_fast_path": fast - approximate, "approximate_f64": approximate,
                "approximate_f64_ratio": total ? approximate / total : null,
                "fast_path_ratio": total ? fast / total : null,
                "softfloat_fallback_ratio": total ? fallback / total : null, "modes": modes };
        }
        let cache = null;
        if(this.x87_counter_version >= 3)
        {
            const get_cache = this.emulator.v86.cpu.wm.exports["performance_recording_x87_cache_get"];
            cache = {};
            ["accepted_regions", "rejected_regions", "arithmetic_ops", "initial_conversions", "writebacks", "local_reads"]
                .forEach((field, index) => { cache[field] = get_cache(index); });
            if(this.x87_counter_version >= 4)
            {
                cache["comparison_ops"] = get_cache(6);
                cache["comparison_regions"] = get_cache(7);
                if(this.x87_counter_version >= 5) {
                    cache["persistent_hits"] = get_cache(8);
                    cache["cached_writes"] = get_cache(9);
                }
            }
        }
        return { "version": this.x87_counter_version, "jit_cache": cache, "initial_state": this.x87_initial_state,
            "current_state": this.x87_state(), "operations": operations };
    }

    execution_hotspots()
    {
        if(this.counter_version < 3) return null;
        const exports = this.emulator.v86.cpu.wm.exports;
        const count = Math.min(this.counter_version >= 4 ? 8192 : 2048, exports["performance_recording_hotspot_count"]());
        const fields = ["cr3", "linear_page", "cpl", "jit", "samples", "sampled_execution_ms",
            "sampled_steps", "first_ms", "last_ms", "last_linear_eip"];
        const rows = Array.from({ length: count }, (_, row) => {
            const result = {};
            fields.forEach((field, index) => { result[field] = exports["performance_recording_hotspot_get"](row, index); });
            return result;
        });
        if(this.counter_version < 4)
            return rows.sort((a, b) => b["sampled_execution_ms"] - a["sampled_execution_ms"]);
        const groups = new Map();
        for(const row of rows)
        {
            row["sampled_execution_ms"] = null;
            const key = row["cr3"] + ":" + row["linear_page"] + ":" + row["cpl"] + ":" + row["jit"];
            const group = groups.get(key);
            if(!group) { groups.set(key, row); continue; }
            group["samples"] += row["samples"];
            group["sampled_steps"] += row["sampled_steps"];
            group["first_ms"] = Math.min(group["first_ms"], row["first_ms"]);
            if(row["last_ms"] >= group["last_ms"])
            {
                group["last_ms"] = row["last_ms"];
                group["last_linear_eip"] = row["last_linear_eip"];
            }
        }
        return Array.from(groups.values()).sort((a, b) => b["samples"] - a["samples"]);
    }

    sample()
    {
        if(!this.active) return;
        const cpu = this.emulator.v86.cpu, now = this.now();
        const instructions = this.emulator.get_instruction_counter() >>> 0;
        this.total_instructions += (instructions - this.last_instructions) >>> 0;
        this.last_instructions = instructions;
        let slots = 0;
        const table = cpu.wm.wasm_table;
        for(let i = 0; i < WASM_TABLE_SIZE; i++) if(table.get(i + WASM_TABLE_OFFSET)) slots++;
        const journal = this.emulator["graphics_proxy"]?.["bridge"]?.["graphicsJournal"];
        const execution = this.counters();
        this.samples.push({ "elapsed_ms": now - this.started, "running": this.emulator.is_running(),
            "instruction_steps": this.total_instructions, ...this.stats, "execution": execution,
            "x87": this.x87_counters(),
            "graphics": this.graphics ? this.graphics.snapshot() : null,
            "main_loop_without_codegen_ms": this.counter_version >= 2 ?
                Math.max(0, this.stats["main_loop_wall_ms"] - execution["sync_codegen_ms"]) : null,
            "jit_slots_occupied": slots, "jit_pending": this.pending_jit.size,
            "disk_requests": this.disks.reduce((n, d) => n + d["requests"], 0),
            "disk_completed_bytes": this.disks.reduce((n, d) => n + d["returned_bytes"], 0),
            "disk_callback_latency_ms": this.disks.reduce((n, d) => n + d["callback_latency_ms"], 0),
            "disk_pending": this.pending_reads.size,
            "disk_any_request_pending_ms": this.read_pending_ms + (this.pending_reads.size ? now - this.pending_since : 0),
            "journal_raw_bytes": journal ? journal["rawBytes"] : null,
            "journal_compressed_resident_bytes": journal ? journal["residentBytes"] : null });
    }

    mark(label)
    {
        if(this.active && this.markers.length < 100)
            this.markers.push({ "elapsed_ms": this.now() - this.started, "label": String(label).slice(0, 120) });
    }

    stop(reason = "user")
    {
        if(!this.active) return this.report;
        this.sample();
        const counters = this.counters();
        const x87 = this.x87_counters();
        const execution_hotspots = this.execution_hotspots();
        const graphics = this.graphics ? this.graphics.stop() : null;
        this.graphics = null;
        this.active = false;
        clearInterval(this.timer);
        this.timer = null;
        if(this.has_counters) this.emulator.v86.cpu.wm.exports["performance_recording_enable"](0);
        if(this.has_x87_counters) this.emulator.v86.cpu.wm.exports["performance_recording_x87_enable"](0);
        for(const pending of this.pending_reads.values()) pending.detach();
        for(const cleanup of this.cleanup.reverse()) cleanup();
        this.cleanup = [];
        this.report = { "format": "v86-performance", "version": 6, "reason": reason,
            "recorded_at": new Date().toISOString(), "metadata": { ...this.metadata },
            "jit": { "start": this.jit_start, "end": this.emulator.v86.cpu.get_jit_info?.() || null },
            "duration_ms": this.now() - this.started, "sample_interval_ms": 500,
            "counter_version": this.counter_version,
            "execution_chunk_sample_probability": this.counter_version === 3 ? 1 / 256 : null,
            "execution_sample_interval_ms": this.counter_version >= 4 ? 10 : null,
            "execution_sample_policy": this.counter_version >= 4 ? "rate_limited_batch_position_reservoir" : null,
            "execution_hotspots": execution_hotspots,
            "graphics": graphics,
            "hotspot_interval_ms": 10, "hotspots_dropped_samples": this.hotspots_dropped,
            "hotspots": Array.from(this.hotspots.values()).sort((a, b) => b["sampled_main_loop_ms"] - a["sampled_main_loop_ms"]),
            "execution_counters_available": this.has_counters, "execution": counters,
            "x87_counters_available": this.has_x87_counters, "x87": x87,
            "summary": this.stats, "disks": this.disks, "markers": this.markers,
            "pending_reads_at_stop": this.pending_reads.size, "pending_jit_at_stop": this.pending_jit.size,
            "slowest_reads": this.slow_reads, "slowest_jit": this.slow_jit, "samples": this.samples,
            "definitions": {
                "x87": "Cumulative arithmetic operations: F80 implementation calls plus v3 native cached arithmetic, including internal helper arithmetic and all guest processes; not decoded instruction counts or CPU time. v1 counts add/sub/mul; v2 also counts div and distinguishes compatible_fast_path from approximate_f64. fast_path is their sum; total also includes softfloat_fallback. Fallback counts arithmetic calls only, not operand/result conversions. Ratios are 0..1, or null for no calls. Comparisons are counted separately in v4 jit_cache.comparison_ops; stack operations, sqrt and SSE are not arithmetic counts. Old Wasm reports null, not zero.",
                "x87_precision": "SoftFloat precision codes 32/64/80 mean 24/53/64 significand bits. modes records the guest settings at each call, not the effective precision of approximate arithmetic. initial_state/current_state are boundary snapshots. Counts are not time weights.",
                "x87_fast_math": "fast_f64 uses Wasm f64 add/sub/mul/div (53-bit significand, binary64 exponent range, nearest-even), ignoring guest arithmetic precision/rounding and not synthesizing full arithmetic exception flags. Existing F80 conversions, stack, comparisons, integer conversions and saved guest state are retained; conversions may still call SoftFloat and honor guest rounding. Host policy is not serialized. Default enabled; x87_fast_math=0 selects compatible mode. Other F80 helpers that use these arithmetic operators inherit the policy.",
                "x87_jit_cache": "v3/v4 use bounded register regions; v5 retains authoritative f64 values across regions, branches and module returns. Register arithmetic, ordered/quiet comparisons, FLD/FXCH/FST/FSTP, FLD1/FLDZ, FCHS/FABS, FRNDINT, FFREE and TOP rotation can execute in native regions of 1..32 instructions. Memory loads/stores and selected math helpers share the persistent cache. Legacy F80 observers synchronize required slots; MMX and full-state observers use explicit barriers. Entry guards retain wide-value and stack-fault fallback. initial_conversions counts F80-to-f64 cache fills; v5 writebacks counts actual F80 materializations, persistent_hits counts reused physical slots and cached_writes counts logical f64 slot writes. local_reads counts native operand uses. Arithmetic is included in approximate_f64; comparison_ops and comparison_regions count native comparisons. These are counts, not CPU time. x87_jit_cache=0 disables native regions and persistent helper caching.",
                "x87_observer_overhead": "Only integer counters are updated in arithmetic paths while recording, with no per-operation clocks or logs. Disabled paths retain an enable check. Recording also uses the existing execution sampler, which disables JIT module chaining; recorded speed is not an uninstrumented baseline. Function self time requires a separate host CPU profile.",
                "duration_ms": "Host monotonic elapsed time for the recording window; not guest benchmark time. Per-sample elapsed_ms and cumulative x87 counts allow interval deltas. The recorder does not automatically identify benchmark start/end or read its displayed score.",
                "main_loop_wall_ms": "Synchronous CPU main_loop wall time, including hardware callbacks and code generation; not pure x86 execution time.",
                "disk_callback_latency_ms": "Sum of buffer.get to data-callback latency. Concurrent requests overlap; includes host scheduling. Not CPU stall time.",
                "disk_any_request_pending_ms": "Union of observed outstanding-read intervals; overlaps CPU/GPU work. Not I/O-only time.",
                "synchronous_completions": "Callback happened before get returned; not an exact cache-hit counter.",
                "latency_histogram": "Counts for [0,1), [1,2), [2,5), [5,10), [10,25), [25,50), [50,100), [100,infinity) ms.",
                "jit_compile_publish_latency_ms": "Wasm bytes ready to compilation publication; includes async compile/instantiate and scheduling, excludes x86 analysis/code generation.",
                "sync_codegen_ms": "Synchronous x86 analysis, Wasm byte generation and associated bookkeeping/eviction, before handing bytes to JS for asynchronous compilation. Included in main_loop_wall_ms.",
                "main_loop_without_codegen_ms": "Main-loop wall time minus synchronous code generation. Still includes device callbacks and other emulator work; not pure guest execution time.",
                "execution_batch_ms": "Full do_many_cycles_native wall time, including dispatch, interpreted/JIT execution, synchronous instruction helpers/devices and code generation. Nested within main_loop_wall_ms; not additive with sync_codegen_ms or sampled execution times.",
                "hardware_irq_ms": "Full run_hardware_timers plus handle_irqs wall time at main-loop boundaries, separate from execution batches. Does not include device callbacks made by guest instructions.",
                "sampled_jit_ms": "Available only with counter_version 3; tiny-chunk timing was contaminated by observer cost and clock resolution. v4 reports null and does not time individual chunks. Never scale v3 values into total CPU time.",
                "sampled_interpreted_ms": "Available only with counter_version 3, with the same timing limitations as sampled_jit_ms. v4 reports null.",
                "execution_hotspots": "v4: at most one execution position armed per 10ms, chosen from previous batch length; shorter batches can miss it. Counts are location clues, not unbiased instruction/time percentages. Up to 8192 raw samples retained by reservoir sampling, grouped on stop by CR3/CPL/page/mode; times are batch-start timestamps, durations null. v3: first 2048 groups of per-chunk timing samples, with dropped groups and unreliable tiny-duration timing.",
                "execution_samples_not_retained": "v4 total collected samples minus reservoir size; later samples may replace earlier samples, avoiding permanent exclusion of late pages. Global sampled chunk counts include samples not retained.",
                "zero_delay_returns": "Count of main_loop returns with nonpositive requested delay; positive_delay_returns counts positive delays. halted_entry_calls and halted_returns overlap those categories. These counts do not measure actual host scheduling delay or establish busy polling.",
                "hotspots": "At most one non-halted main-loop ENTRY snapshot per 10ms, grouped by CR3/CPL/4KiB linear page, up to 2048 distinct groups. Sampled loop durations include work after that entry and are not function self time or a game-process CPU percentage. CR3 is an address-space identifier, not a process name; reuse is possible. No guest module names are collected.",
                "execution": "Instruction-counter steps per interpreted/JIT chunk; not CPU-time percentages. Counters are diagnostic, not saved VM state.",
                "graphics": "Present callback/encoding intervals per API and session are separate from browser rAF. Neither proves frames reached the display. Histogram bins have inclusive upper bounds. CPU time in slow intervals can lag when Present occurs inside an unfinished CPU main_loop. Counter deltas and nested timers must not be added together.",
                "graphics_execute": "execute.sync_ms is only the immediate function call (prefix for async D3D9); execute_sync_ms additionally times D3D9 continuations, excluding awaited promises. execute.elapsed_ms includes waits. finish_frame and GPU submit CPU times are nested in execution. Untracked/pending operations are not assumed completed.",
                "graphics_gpu": "Queue.submit sync time is host API time. At most one onSubmittedWorkDone probe per queue per 500ms, with only one pending probe; it is not awaited by rendering. Completion latency includes previous GPU work and main-thread callback scheduling, not pure GPU duration. Shared queues are counted once, not attributed to a single API.",
                "graphics_journal": "append is synchronous page copying. Page queue wait, compressor service, worker wall time and IndexedDB put latency are separate overlapping scopes, not additive CPU times. CompressionStream can do native asynchronous work. Pages queued before recording have no page timings; unfinished pages are reported pending.",
                "limitations": "No guest filenames, per-file decompression times, pure CPU/GPU attribution, or display-confirmed FPS. Present and rAF cadence are separate proxies. Reads/compiles begun before recording are excluded. Timeouts without callbacks remain pending. Compare normal unrecorded release runs for observer overhead."
            } };
        this.pending_reads.clear();
        this.pending_jit.clear();
        this.on_stop(this.report);
        return this.report;
    }
}
