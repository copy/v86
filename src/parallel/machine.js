// Host-parallel machine (docs/multicore.md): the
// bootstrap processor and every device run on this thread, in the machine
// instance of v86-parallel.wasm (base 0); each application processor runs in
// a vCPU worker (src/parallel/vcpu.js) with its own relocated instance in the
// same shared memory.
//
// This side serves the workers' port and device-MMIO accesses, keeps the
// control block's clock offset current and stops all cores (parks them at a
// safe point) around snapshots, resets, sleep states and pauses.

import { dbg_log } from "../log.js";
import { LOG_CPU } from "../const.js";
import { CORE_STATE_RANGES } from "../state_layout.js";
import { image_size, PAGE_SIZE } from "./relocate.js";
import * as C from "./control.js";

/* global __dirname, V86_BUNDLE */

const NODE = typeof process !== "undefined" && process.versions && process.versions.node;

export class ParallelMachine
{
    /**
     * @param {Object} cpu the machine's CPU (instance at base 0)
     * @param {{bytes: Uint8Array, settings: Object, worker_url: (string|URL)}} options
     */
    constructor(cpu, options)
    {
        this.cpu = cpu;
        this.exports = cpu.wm.exports;
        // (the x86 CPU keeps an array of its cores, the ARM CPU their number)
        this.cores = typeof cpu.cores === "number" ? cpu.cores : cpu.cores.length;
        /** the ranges of a core's state block that save_core_state copies */
        this.state_ranges = cpu.core_state_ranges || CORE_STATE_RANGES;
        this.bytes = options.bytes;
        this.settings = options.settings;
        this.worker_url = options.worker_url;
        this.control = new SharedArrayBuffer(C.CONTROL_BYTES);
        this.ctrl = new Int32Array(this.control);
        this.clock_offset = new Float64Array(this.control, C.CONTROL_WORDS * 4 + 8 * C.SLOT_CLOCK_OFFSET, 1);
        this.ctrl[C.PM_BASE] = -1;
        // the workers read the PM timer themselves (src/acpi.js)
        cpu.devices.acpi?.share_timer(this.ctrl.subarray(C.PM_BASE, C.PM_BASE + 1),
            new Float64Array(this.control, C.CONTROL_WORDS * 4 + 8 * C.SLOT_PM_TIMER_OFFSET, 1),
            new BigInt64Array(this.control, C.CONTROL_WORDS * 4 + 8 * C.SLOT_PM_TIMER_LAST, 1));
        this.workers = [];
        /** each vCPU worker instance's base in the shared memory (its statics are there + their address in this instance) */
        this.instance_bases = [0];
        this.epoch = 0;
        this.stopping_epoch = 0;
        this.command = C.COMMAND_NONE;
        this.failure = null;
        this.failed_core = 0;
        /** @type {?{reason: (string|undefined), keep_memory: (boolean|undefined)}} a reset waiting for the workers to park */
        this.pending_reset = null;
        this.destroyed = false;
        this.served = 0;
        this.sync_clock();
    }

    sync_clock()
    {
        this.clock_offset[0] = performance.timeOrigin + performance.now() - this.cpu.clock.now();
    }

    /** Start the application processors; they wait for INIT/SIPI */
    async start()
    {
        const memory = this.cpu.wasm_memory;
        const pages = Math.ceil(image_size(this.bytes) / PAGE_SIZE);
        this.exports["parallel_set_active"](true);
        const ready = [];
        for(let core = 1; core < this.cores; core++)
        {
            // fresh (so zeroed) pages for the worker's static data and stack
            const base = memory.grow(pages) * PAGE_SIZE;
            this.instance_bases[core] = base;
            const worker = await create_worker(this.worker_url, "v86 vCPU " + core);
            this.workers[core] = worker;
            ready.push(new Promise((resolve, reject) => {
                const fail = error => {
                    this.fail(core, error);
                    reject(this.failure);
                };
                worker.on_message(message => {
                    if(message["type"] === "ready") resolve();
                    else if(message["type"] === "error") fail(new Error("vCPU " + core + " failed: " + message["message"]));
                });
                worker.on_error(error => fail(error));
                // (Node: a worker that ends without an error message, e.g. process.exit)
                worker.on_exit(code => {
                    if(!this.destroyed && Atomics.load(this.ctrl, C.core_word(core, C.STATUS)) !== C.STATUS_EXITED)
                    {
                        fail(new Error("vCPU " + core + " worker exited (code " + code + ")"));
                    }
                });
            }));
            worker.post({
                "bytes": this.bytes, "memory": memory, "control": this.control,
                "base": base, "core": core, "cores": this.cores,
                "mem8": this.cpu.mem8.byteOffset, "memory_size": this.cpu.memory_size[0],
                "settings": this.settings, "log": false, "cpu_type": this.cpu.cpu_type || "x86",
                "extended": this.cpu.extended_store ? this.cpu.extended_store.transfer() : null,
            });
        }
        await Promise.all(ready);
        this.watch();
        dbg_log("parallel machine: " + (this.cores - 1) + " vCPU workers", LOG_CPU);
    }

    /** Run the machine's loop whenever a worker kicks core 0 (I/O, parking, IPIs) */
    watch()
    {
        const wake = new Int32Array(this.cpu.wasm_memory.buffer);
        const index = this.exports["parallel_wake_addr"](0) >>> 2;
        const loop = () => {
            if(this.destroyed) return;
            const value = Atomics.load(wake, index);
            const waiter = typeof Atomics.waitAsync === "function" ? Atomics.waitAsync(wake, index, value, 100) : null;
            const next = () => { if(!this.destroyed) { this.cpu.stop_idling(); loop(); } };
            if(waiter && waiter.async) waiter.value.then(next);
            else setTimeout(next, waiter ? 0 : 1);
        };
        loop();
    }

    /** Perform the workers' pending port and MMIO accesses; returns how many */
    service()
    {
        const ctrl = this.ctrl, cpu = this.cpu;
        let count = 0;
        for(let core = 1; core < this.cores; core++)
        {
            const at = w => C.core_word(core, w);
            if(Atomics.load(ctrl, at(C.IO_STATE)) !== C.IO_REQUEST) continue;
            const op = ctrl[at(C.IO_OP)], addr = ctrl[at(C.IO_ADDR)];
            const v0 = ctrl[at(C.IO_V0)], v1 = ctrl[at(C.IO_V1)], v2 = ctrl[at(C.IO_V2)], v3 = ctrl[at(C.IO_V3)];
            let result = 0;
            // (e.g. an SMI from the APM control port goes to this core)
            cpu.io_core = core;
            switch(op)
            {
                case C.OP_IN8: result = this.exports["machine_io_read8"](addr); break;
                case C.OP_IN16: result = cpu.io.port_read16(addr); break;
                case C.OP_IN32: result = cpu.io.port_read32(addr); break;
                case C.OP_OUT8: this.exports["machine_io_write8"](addr, v0); break;
                case C.OP_OUT16: cpu.io.port_write16(addr, v0 & 0xFFFF); break;
                case C.OP_OUT32: cpu.io.port_write32(addr, v0); break;
                case C.OP_MMIO_READ8: result = cpu.mmap_read8(addr >>> 0); break;
                case C.OP_MMIO_READ32: result = cpu.mmap_read32(addr >>> 0); break;
                case C.OP_MMIO_WRITE8: cpu.mmap_write8(addr >>> 0, v0 & 0xFF); break;
                case C.OP_MMIO_WRITE16: cpu.mmap_write16(addr >>> 0, v0 & 0xFFFF); break;
                case C.OP_MMIO_WRITE32: cpu.mmap_write32(addr >>> 0, v0); break;
                case C.OP_MMIO_WRITE64: cpu.mmap_write64(addr >>> 0, v0, v1); break;
                case C.OP_MMIO_WRITE128: cpu.mmap_write128(addr >>> 0, v0, v1, v2, v3); break;
                case C.OP_A64_MMIO_READ:
                {
                    const value = /** @type {bigint} */ (cpu.io.mmio_read(addr & 0xFFFFFF, BigInt(v1 >>> 0) << 32n | BigInt(v0 >>> 0), addr >>> 24));
                    result = Number(value & 0xFFFFFFFFn) | 0;
                    ctrl[at(C.IO_RESULT_HI)] = Number(value >> 32n) | 0;
                    break;
                }
                case C.OP_A64_MMIO_WRITE:
                    cpu.io.mmio_write(addr & 0xFFFFFF, BigInt(v1 >>> 0) << 32n | BigInt(v0 >>> 0), addr >>> 24,
                        BigInt(v3 >>> 0) << 32n | BigInt(v2 >>> 0));
                    break;
                default: dbg_log("vCPU " + core + ": unknown request " + op, LOG_CPU);
            }
            cpu.io_core = -1;
            ctrl[at(C.IO_RESULT)] = result;
            ctrl[at(C.IO_COUNT)]++;
            Atomics.store(ctrl, at(C.IO_STATE), C.IO_DONE);
            Atomics.notify(ctrl, at(C.IO_STATE));
            count++;
        }
        this.served += count;
        return count;
    }

    /**
     * A vCPU failed: the machine cannot go on (its state is lost). Release
     * what the core held, stop the other workers; the machine's loop reports
     * the error ("emulator-error") and stops.
     */
    fail(core, error)
    {
        if(this.failure || this.destroyed) return;
        this.failure = error;
        this.failed_core = core;
        dbg_log("parallel machine: " + error, LOG_CPU);
        Atomics.store(this.ctrl, C.core_word(core, C.STATUS), C.STATUS_FAILED);
        this.exports["parallel_core_failed"](core);
        this.request_stop();
        this.cpu.stop_idling();
    }

    /** @return {Error|null} the failure of a vCPU, if one failed */
    check_failure()
    {
        if(!this.failure)
        {
            for(let core = 1; core < this.cores; core++)
            {
                if(Atomics.load(this.ctrl, C.core_word(core, C.ERROR)))
                {
                    // (its error message follows by postMessage)
                    this.fail(core, new Error("vCPU " + core + " failed"));
                }
            }
        }
        return this.failure;
    }

    /** Whether a stop is in effect (requested and not resumed) */
    stopping()
    {
        return this.stopping_epoch > Atomics.load(this.ctrl, C.RESUME);
    }

    /** Ask every worker to park at its next safe point, without waiting */
    request_stop()
    {
        if(this.stopping()) return;
        this.stopping_epoch = ++this.epoch;
        Atomics.store(this.ctrl, C.STOP, this.stopping_epoch);
        for(let core = 1; core < this.cores; core++) this.exports["parallel_kick"](core);
    }

    /** Whether every worker has parked for the current stop */
    all_parked()
    {
        if(!this.stopping()) return false;
        for(let core = 1; core < this.cores; core++)
        {
            const status = Atomics.load(this.ctrl, C.core_word(core, C.STATUS));
            if(status === C.STATUS_FAILED || status === C.STATUS_EXITED) continue;
            if(Atomics.load(this.ctrl, C.core_word(core, C.ACK)) !== this.stopping_epoch) return false;
        }
        return true;
    }

    /** Stop every worker at a safe point, serving their I/O until they get there */
    async park()
    {
        if(this.check_failure()) throw this.failure;
        this.request_stop();
        const deadline = Date.now() + 30000;
        while(!this.all_parked())
        {
            this.service();
            if(this.check_failure()) throw this.failure;
            if(Date.now() > deadline) throw new Error("vCPU workers did not stop: " + JSON.stringify(this.status()));
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    /** A command the workers run when they next resume (they must be parked) */
    schedule(command)
    {
        this.command = Math.max(this.command, command);
    }

    /** Let parked workers continue */
    resume()
    {
        if(!this.stopping()) return;
        this.sync_clock();
        Atomics.store(this.ctrl, C.COMMAND, this.command);
        this.command = C.COMMAND_NONE;
        Atomics.store(this.ctrl, C.RESUME, this.stopping_epoch);
        Atomics.notify(this.ctrl, C.RESUME);
    }

    /** The saved state of a parked core, in the layout of CPU.prototype.save_core_state */
    read_core(core)
    {
        const base = this.ctrl[C.core_word(core, C.STATE_BASE)] >>> 0;
        const memory = new Uint8Array(this.cpu.wasm_memory.buffer);
        return this.state_ranges.map(([start, end]) => memory.slice(base + start, base + end));
    }

    write_core(core, saved)
    {
        const base = this.ctrl[C.core_word(core, C.STATE_BASE)] >>> 0;
        const memory = new Uint8Array(this.cpu.wasm_memory.buffer);
        this.state_ranges.forEach(([start], i) => memory.set(saved[i], base + start));
    }

    /** Address of offset 0 of a worker core's state block (live, racy while it runs) */
    state_base(core) { return this.ctrl[C.core_word(core, C.STATE_BASE)] >>> 0; }
    core_running(core) { return Atomics.load(this.ctrl, C.core_word(core, C.RUNNING)) !== 0; }
    set_core_running(core, running) { Atomics.store(this.ctrl, C.core_word(core, C.RUNNING), running ? 1 : 0); }
    core_tsc_offset(core)
    {
        return [this.ctrl[C.core_word(core, C.TSC_OFFSET_LO)] >>> 0, this.ctrl[C.core_word(core, C.TSC_OFFSET_HI)] >>> 0];
    }
    set_core_tsc_offset(core, tsc)
    {
        this.ctrl[C.core_word(core, C.TSC_OFFSET_LO)] = tsc[0];
        this.ctrl[C.core_word(core, C.TSC_OFFSET_HI)] = tsc[1];
    }
    /** The instructions core `core` retired, as its worker last published (the ARM core's workers) */
    core_retired(core)
    {
        return (this.ctrl[C.core_word(core, C.STEPS)] >>> 0) + (this.ctrl[C.core_word(core, C.STEPS_HI)] >>> 0) * 0x100000000;
    }
    core_counters(core)
    {
        const at = w => this.ctrl[C.core_word(core, w)] >>> 0;
        return { slices: at(C.SLICES), steps: at(C.STEPS), waits: at(C.WAITS), io: at(C.IO_COUNT), jit: at(C.JIT_ENTRIES),
            refused: at(C.REFUSED), tlbi_posted: at(C.RING_STATS), dsb_waits: at(C.RING_STATS + 1), tlbi_taken: at(C.RING_STATS + 2),
            kicked: at(C.KICKED) };
    }

    status()
    {
        const names = ["starting", "wait-for-sipi", "running", "halted", "parked", "failed", "exited"];
        const cores = [];
        for(let core = 1; core < this.cores; core++)
        {
            const at = w => this.ctrl[C.core_word(core, w)];
            cores.push(Object.assign({ "core": core, "status": names[at(C.STATUS)], "ack": at(C.ACK),
                "io_state": at(C.IO_STATE) }, this.core_counters(core)));
        }
        return { "epoch": this.epoch, "resume": this.ctrl[C.RESUME], "served": this.served, "cores": cores,
            "failure": this.failure ? String(this.failure.message || this.failure) : null };
    }

    destroy()
    {
        if(this.destroyed) return;
        this.destroyed = true;
        Atomics.store(this.ctrl, C.SHUTDOWN, 1);
        Atomics.notify(this.ctrl, C.RESUME);
        for(let core = 1; core < this.cores; core++)
        {
            this.exports["parallel_kick"](core);
            Atomics.notify(this.ctrl, C.core_word(core, C.IO_STATE));
            this.workers[core]?.terminate();
        }
        this.exports["parallel_set_active"](false);
        const acpi = this.cpu.devices.acpi;
        if(acpi) acpi.shared_base = acpi.shared_offset = acpi.shared_last = null;
    }
}

/**
 * Why this host cannot run vCPU workers ("" if it can): shared memory and
 * Atomics, workers, in browsers cross-origin isolation (the page needs the
 * COOP "same-origin" and COEP "require-corp" or "credentialless" headers),
 * and a host thread for each core (with fewer, the threads would take turns
 * on the host's CPUs, which the cooperative mode does at less cost)
 * @param {number=} cores
 * @return {string}
 */
export function parallel_unsupported_reason(cores)
{
    const threads = typeof navigator !== "undefined" && navigator["hardwareConcurrency"] || 0;
    if(cores && threads && threads < cores) return "only " + threads + " host threads";
    // (a browser hides SharedArrayBuffer from pages that are not isolated)
    if(!NODE && globalThis["crossOriginIsolated"] !== true) return "not cross-origin isolated";
    if(typeof SharedArrayBuffer !== "function" || typeof Atomics !== "object") return "no SharedArrayBuffer";
    if(!NODE && typeof Worker !== "function") return "no Worker";
    try
    {
        new WebAssembly.Memory({ "initial": 1, "maximum": 1, "shared": true });
    }
    catch(e)
    {
        return "no shared WebAssembly.Memory";
    }
    return "";
}

/**
 * The script of the vCPU workers when the embedder doesn't pass one
 * (`vcpu_worker_url`): build/vcpu-worker.js for the bundles (next to
 * libv86.js in Node, like v86.wasm), the ES module entry for the source tree
 * @return {Promise<string|URL>}
 */
export async function default_worker_url()
{
    if(typeof V86_BUNDLE !== "undefined")
    {
        return NODE && typeof __dirname === "string" ? __dirname + "/vcpu-worker.js" : "build/vcpu-worker.js";
    }
    return (await import("./" + "entry_url.js"))["VCPU_WORKER_ENTRY"];
}

async function create_worker(url, name)
{
    if(NODE)
    {
        const { Worker } = await import("node:" + "worker_threads");
        // (a relative path is relative to the working directory, like v86.wasm)
        const target = url instanceof URL || /^[a-z]+:/i.test(url) ? new URL(url) :
            /^\.{0,2}[\\/]/.test(url) ? url : "./" + url;
        const worker = new Worker(target, { "name": name });
        worker["unref"]();
        return {
            post: message => worker.postMessage(message),
            on_message: f => worker.on("message", f),
            on_error: f => worker.on("error", f),
            on_exit: f => worker.on("exit", f),
            terminate: () => worker.terminate(),
        };
    }
    const worker = new Worker(url, { "type": "module", "name": name });
    return {
        post: message => worker.postMessage(message),
        on_message: f => { worker.onmessage = e => f(e.data); },
        on_error: f => { worker.onerror = e => { e.preventDefault(); f(e.error || new Error(e.message)); }; },
        on_exit: () => {},
        terminate: () => worker.terminate(),
    };
}
