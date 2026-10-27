import { CPU } from "./cpu.js";
import { A64CPU } from "./arm/cpu.js";
import { save_state, restore_state, save_state_stream, restore_state_stream } from "./state.js";
import { export_raw } from "./image/export.js";
import { export_qcow2 } from "./image/qcow2_export.js";
import { release_disk_holds, drop_disk_holds, check_no_disk_holds } from "./block_backend.js";
import { disks_to_prepare, prepare_disks } from "./disk_writeback.js";
import { PluginDevice } from "./device_plugin.js";
export { V86 } from "./browser/starter.js";

/**
 * @constructor
 * @param {Object=} wasm
 */
export function v86(bus, wasm)
{
    /** @type {boolean} */
    this.running = false;

    /** @type {boolean} */
    this.stopping = false;

    /** @type {boolean} */
    this.idle = true;

    this.tick_counter = 0;
    this.worker = null;

    // the CPU of the core's family (docs/arm64-virt-android16-plan.md P1.2):
    // the ARM core exports the ISA marker isa_aarch64
    const stop_idling = () => { this.running && this.idle && this.next_tick(0); };
    /** @type {CPU} */
    this.cpu = wasm.exports["isa_aarch64"] ? /** @type {?} */ (new A64CPU(bus, wasm, stop_idling)) : new CPU(bus, wasm, stop_idling);
    // (a disk request failed with disk_error "stop": src/block_backend.js)
    this.cpu.stop_machine = () => this.stop();

    this.bus = bus;

    this.register_yield();
}

v86.prototype.run = function()
{
    if(this.state_busy) { this.state_busy.resume = true; return; }
    if(this.cpu.parallel?.failure) return;   // a vCPU failed: the machine cannot go on
    this.stopping = false;
    this.cpu.clock.resume();

    if(this.cpu.powered_off())
    {
        // The guest turned the machine off (ACPI S5/S4): power it on again
        this.cpu.reboot_internal("power-on");
    }

    if(!this.running)
    {
        this.running = true;
        this.bus.send("emulator-started");
    }

    // the disk requests held after an I/O error (disk_error "stop") are
    // retried, in their order (src/block_backend.js)
    release_disk_holds(this.cpu);

    this.next_tick(0);
};

v86.prototype.do_tick = function()
{
    if(this.stopping || !this.running)
    {
        // (the cores in vCPU workers stop too; run_cores lets them go on)
        this.cpu.parallel?.request_stop();
        this.cpu.clock.pause();
        this.stopping = this.running = false;
        this.bus.send("emulator-stopped");
        return;
    }

    this.idle = false;
    const t = this.cpu.clock.to_host_ms(this.cpu.run_cores());

    const failure = this.cpu.parallel?.failure;
    if(failure)
    {
        // a vCPU worker failed (src/parallel/machine.js)
        this.cpu.clock.pause();
        this.stopping = this.running = false;
        this.bus.send("emulator-stopped");
        this.bus.send("emulator-error", failure);
        return;
    }

    if(this.cpu.powered_off())
    {
        // The guest turned the machine off; stop at the end of this slice
        this.stopping = true;
        this.next_tick(0);
        return;
    }

    this.next_tick(t);
};

v86.prototype.next_tick = function(t)
{
    const tick = ++this.tick_counter;
    this.idle = true;
    this.yield(t, tick);
};

v86.prototype.yield_callback = function(tick)
{
    if(tick === this.tick_counter)
    {
        this.do_tick();
    }
};

v86.prototype.stop = function()
{
    if(this.state_busy) { this.state_busy.resume = false; return; }
    if(this.running)
    {
        this.stopping = true;
    }
};

v86.prototype.destroy = function()
{
    // (the disk requests held after an I/O error are dropped, as by a power loss)
    drop_disk_holds(this.cpu);
    this.cpu.parallel?.destroy();
    // (a device plugin's hook: src/device_plugin.js)
    this.cpu.devices.net instanceof PluginDevice && this.cpu.devices.net.destroy();
    this.cpu.devices.audio && this.cpu.devices.audio.destroy();
    this.cpu.devices.usb && this.cpu.devices.usb.destroy();
    this.cpu.devices.tpm && this.cpu.devices.tpm.destroy();
    this.cpu.clock.pause();
    this.unregister_yield();
};

/** @param {string=} reason "power-on" after the guest turned the machine off */
v86.prototype.restart = function(reason)
{
    if(this.state_busy) throw new Error("Snapshot transaction is in progress");
    this.cpu.reboot_internal(reason === "power-on" ? "power-on" : "restart");
};

v86.prototype.init = function(settings)
{
    this.cpu.init(settings, this.bus);
    this.cpu.clock.pause();
    this.bus.send("emulator-ready");
};

if(typeof process !== "undefined")
{
    v86.prototype.yield = function(t, tick)
    {
        /* global global */
        if(t < 1)
        {
            global.setImmediate(tick => this.yield_callback(tick), tick);
        }
        else
        {
            setTimeout(tick => this.yield_callback(tick), t, tick);
        }
    };

    v86.prototype.register_yield = function() {};
    v86.prototype.unregister_yield = function() {};
}
else if(globalThis["scheduler"] && typeof globalThis["scheduler"]["postTask"] === "function" && location.href.includes("use-scheduling-api"))
{
    v86.prototype.yield = function(t, tick)
    {
        t = Math.max(0, t);
        globalThis["scheduler"]["postTask"](() => this.yield_callback(tick), { delay: t });
    };

    v86.prototype.register_yield = function() {};
    v86.prototype.unregister_yield = function() {};
}
else if(typeof window === "undefined" && typeof MessageChannel !== "undefined")
{
    // The CPU is already in a dedicated worker. A local task queue yields to
    // input/GPU replies without a second worker and without timer clamping.
    v86.prototype.register_yield = function()
    {
        this.tick_channel = new globalThis.MessageChannel();
        this.tick_channel.port1.onmessage = e => this.yield_callback(e.data);
    };
    v86.prototype.yield = function(t, tick)
    {
        if(t < 1) this.tick_channel.port2.postMessage(tick);
        else this.tick_timeout = setTimeout(() => this.yield_callback(tick), t);
    };
    v86.prototype.unregister_yield = function()
    {
        clearTimeout(this.tick_timeout);
        this.tick_channel.port1.close();
        this.tick_channel.port2.close();
    };
}
else if(typeof Worker !== "undefined")
{
    // XXX: This has a slightly lower throughput compared to window.postMessage

    function the_worker()
    {
        let timeout;
        globalThis.onmessage = function(e)
        {
            const t = e.data.t;
            timeout = timeout && clearTimeout(timeout);
            if(t < 1) postMessage(e.data.tick);
            else timeout = setTimeout(() => postMessage(e.data.tick), t);
        };
    }

    v86.prototype.register_yield = function()
    {
        const url = URL.createObjectURL(new Blob(["(" + the_worker.toString() + ")()"], { type: "text/javascript" }));
        this.worker = new Worker(url);
        this.worker.onmessage = e => this.yield_callback(e.data);
        URL.revokeObjectURL(url);
    };

    v86.prototype.yield = function(t, tick)
    {
        this.worker.postMessage({ t, tick });
    };

    v86.prototype.unregister_yield = function()
    {
        this.worker && this.worker.terminate();
        this.worker = null;
    };
}
//else if(typeof window !== "undefined" && typeof postMessage !== "undefined")
//{
//    // setImmediate shim for the browser.
//    // TODO: Make this deactivatable, for other applications
//    //       using postMessage
//
//    const MAGIC_POST_MESSAGE = 0xAA55;
//
//    v86.prototype.yield = function(t)
//    {
//        // XXX: Use t
//        window.postMessage(MAGIC_POST_MESSAGE, "*");
//    };
//
//    let tick;
//
//    v86.prototype.register_yield = function()
//    {
//        tick = e =>
//        {
//            if(e.source === window && e.data === MAGIC_POST_MESSAGE)
//            {
//                this.do_tick();
//            }
//        };
//
//        window.addEventListener("message", tick, false);
//    };
//
//    v86.prototype.unregister_yield = function()
//    {
//        window.removeEventListener("message", tick);
//        tick = null;
//    };
//}
else
{
    v86.prototype.yield = function(t)
    {
        setTimeout(() => { this.do_tick(); }, t);
    };

    v86.prototype.register_yield = function() {};
    v86.prototype.unregister_yield = function() {};
}

// Async snapshots keep the scheduler stopped for the entire writer/read cycle,
// including backpressure. External input cannot start new DMA while draining.
v86.prototype.state_transaction = function(operation, resume_on_error)
{
    const previous = this.state_operation || Promise.resolve();
    const next = previous.then(async () => {
        const transaction = { resume: this.running && !this.stopping };
        this.state_busy = transaction;
        ++this.tick_counter;
        this.running = this.stopping = false;
        this.idle = true;
        this.cpu.clock.pause();
        this.bus.send("emulator-stopped");
        const input = this.bus.pair, pending = [];
        const send = input && input.send;
        if(input) input.send = (...args) => { pending.push(args); };
        let success = false;
        try
        {
            const deadline = Date.now() + 30000;
            while(this.cpu["snapshot_io_pending"])
            {
                if(Date.now() >= deadline) throw new Error("Snapshot timed out waiting for device I/O");
                await new Promise(resolve => setTimeout(resolve, 1));
            }
            const result = await operation();
            success = true;
            return result;
        }
        finally
        {
            this.state_busy = null;
            if(input)
            {
                input.send = send;
                for(const args of pending) send.apply(input, args);
            }
            if(transaction.resume && (success || resume_on_error)) this.run();
        }
    });
    this.state_operation = next.then(() => {}, () => {});
    return next;
};

/**
 * With cores in vCPU workers, a snapshot waits until each of them is parked
 * at a safe point; run() lets them continue (src/parallel/machine.js).
 */
v86.prototype.parallel_save = async function(save)
{
    await this.cpu.parallel.park();
    this.cpu.parallel_capture();
    return save();
};

v86.prototype.parallel_restore = async function(restore)
{
    await this.cpu.parallel.park();
    const result = await restore();
    this.cpu.parallel_install();
    return result;
};

v86.prototype.save_state_stream = function(write)
{
    // (the disks written back to a disk service: flushed, their generation
    // recorded, with the machine stopped: src/disk_writeback.js)
    const prepare = disks_to_prepare(this.cpu);
    const save = async () =>
    {
        if(prepare.length) { check_no_disk_holds(this.cpu); await prepare_disks(prepare); }
        return this.cpu.parallel ? this.parallel_save(() => save_state_stream(this.cpu, write)) : save_state_stream(this.cpu, write);
    };
    return this.state_transaction(save, true);
};

v86.prototype.restore_state_stream = function(source)
{
    if(this.cpu.parallel) return this.state_transaction(() => this.parallel_restore(() => restore_state_stream(this.cpu, source)), false);
    return this.state_transaction(() => restore_state_stream(this.cpu, source), false);
};

/**
 * Export a disk as the guest sees it, RAW (src/image/export.js) or a new
 * QCOW2 image (src/image/qcow2_export.js): the machine stops and its disk
 * I/O finishes first, so the stream is one view of the disk; it goes on
 * afterwards
 * @param {?} buffer the disk's buffer
 * @param {function(!Uint8Array):(Promise<*>|undefined)} write
 * @param {?=} options format ("raw", "qcow2"), progress, signal
 * @return {!Promise<number>}
 */
v86.prototype.export_disk = function(buffer, write, options)
{
    const format = options && options.format || "raw";
    if(format !== "raw" && format !== "qcow2") return Promise.reject(new Error("Export: unknown format " + JSON.stringify(format) + " (raw, qcow2)"));
    const run = () => format === "qcow2" ? export_qcow2(buffer, write, options) : export_raw(buffer, write, options);
    if(this.cpu.parallel) return this.state_transaction(() => this.parallel_save(run), true);
    return this.state_transaction(run, true);
};

v86.prototype.save_state = function()
{
    // (the disks written back to a disk service: flushed, their generation
    // recorded, with the machine stopped: src/disk_writeback.js)
    const prepare = disks_to_prepare(this.cpu);
    if(prepare.length)
    {
        return this.state_transaction(async () =>
        {
            check_no_disk_holds(this.cpu);
            await prepare_disks(prepare);
            return this.cpu.parallel ? this.parallel_save(() => save_state(this.cpu)) : save_state(this.cpu);
        }, true);
    }
    if(this.cpu.parallel) return this.state_transaction(() => this.parallel_save(() => save_state(this.cpu)), true);
    // (disk I/O in flight: the commands complete first, their devices are
    // then in a state a snapshot can hold)
    if(this.state_busy || this.cpu["snapshot_io_pending"]) return this.state_transaction(() => save_state(this.cpu), true);
    if(this.cpu.in_cpu) return Promise.resolve().then(() => this.save_state());
    const paused = this.cpu.clock.paused;
    this.cpu.clock.pause();
    try { return save_state(this.cpu); }
    finally { if(!paused) this.cpu.clock.resume(); }
};

v86.prototype.restore_state = function(state)
{
    if(this.cpu.parallel) return this.state_transaction(() => this.parallel_restore(() => restore_state(this.cpu, state)), false);
    if(this.state_busy) return this.state_transaction(() => restore_state(this.cpu, state), false);
    if(this.cpu.in_cpu) return Promise.resolve().then(() => this.restore_state(state));
    const paused = this.cpu.clock.paused;
    this.cpu.clock.pause();
    try { return restore_state(this.cpu, state); }
    finally { if(!paused) this.cpu.clock.resume(); }
};

/* global require */
if(typeof performance === "object" && performance.now)
{
    v86.microtick = performance.now.bind(performance);
}
else if(typeof require === "function")
{
    const { performance } = require("perf_hooks");
    v86.microtick = performance.now.bind(performance);
}
else if(typeof process === "object" && process.hrtime)
{
    v86.microtick = function()
    {
        var t = process.hrtime();
        return t[0] * 1000 + t[1] / 1e6;
    };
}
else
{
    v86.microtick = Date.now;
}
