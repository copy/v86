// A vCPU worker of the ARM core (docs/arm64-virt-android16-plan.md P8.2;
// the x86 one is src/parallel/vcpu.js): one core of a virt machine whose
// core 0 and devices run on another thread (src/parallel/machine.js).
//
// The worker relocates its own instance of v86-arm64-parallel.wasm into the
// shared memory and attaches it to the machine: guest RAM, the GIC, PSCI's
// power states, the exclusive monitor and the machine's map are the
// machine's (src/rust/aarch64/isa_hooks.rs); the core's state block, TLB, page
// tier and Rust heap are this instance's. The core is off until PSCI CPU_ON
// (another core's call) turns it on; device register accesses go to the
// machine through the control block while the worker waits. Its loop never
// returns to the event loop: generated code is compiled synchronously and
// all coordination goes through shared memory.

import { A64CPU } from "../arm/cpu.js";
import { MachineClock } from "../machine_clock.js";
import { WASM_TABLE_OFFSET, WASM_TABLE_SIZE } from "../const.js";
import { relocate } from "./relocate.js";
import { ExtendedStore } from "../extended_memory.js";
import * as C from "./control.js";
import { set_jit_switches } from "../jit_switches.js";

/**
 * @param {Object} init from ParallelMachine.start
 * @param {function(Object)} post message to the machine
 * @param {{exports: Object}} handle receives the instance's exports (for the failure path)
 */
export async function run_vcpu_arm(init, post, handle)
{
    const core = init.core;
    const memory = init.memory;
    const ctrl = new Int32Array(init.control);
    const clock_offset = new Float64Array(init.control, C.CONTROL_WORDS * 4 + 8 * C.SLOT_CLOCK_OFFSET, 1);
    const word = w => C.core_word(core, w);
    const table = new WebAssembly.Table({ "element": "anyfunc", "initial": WASM_TABLE_SIZE + WASM_TABLE_OFFSET });

    let cpu = null, exports = null;
    const extended = init.extended ? new ExtendedStore(init.extended["pages"], init.extended["chunks"], init.extended["touched"]) : null;
    const host_now = () => performance.timeOrigin + performance.now();
    const now = () => host_now() - clock_offset[0];

    // A posted request (an MMIO write) not waited for yet: the next request,
    // and a park, wait for it first, so this core's device accesses stay in
    // order and a stopped machine has done them all
    let posted = false;
    function settle()
    {
        if(!posted) return;
        posted = false;
        while(Atomics.load(ctrl, word(C.IO_STATE)) === C.IO_REQUEST)
        {
            Atomics.wait(ctrl, word(C.IO_STATE), C.IO_REQUEST, 1000);
            if(Atomics.load(ctrl, C.SHUTDOWN)) throw new Error("machine shut down during I/O");
        }
        Atomics.store(ctrl, word(C.IO_STATE), C.IO_IDLE);
    }
    // a request the machine performs on the devices' thread: the result's low
    // 32 bits (IO_RESULT_HI the high); `post`: the result is not needed, the
    // core goes on (MMIO writes are posted, as PCIe's)
    function request(op, addr, v0 = 0, v1 = 0, v2 = 0, v3 = 0, post = false)
    {
        settle();
        ctrl[word(C.IO_OP)] = op;
        ctrl[word(C.IO_ADDR)] = addr;
        ctrl[word(C.IO_V0)] = v0;
        ctrl[word(C.IO_V1)] = v1;
        ctrl[word(C.IO_V2)] = v2;
        ctrl[word(C.IO_V3)] = v3;
        Atomics.store(ctrl, word(C.IO_STATE), C.IO_REQUEST);
        Atomics.add(ctrl, C.DOORBELL, 1);
        Atomics.notify(ctrl, C.DOORBELL);
        // the machine's core leaves its slice to serve it
        exports["parallel_kick"](0);
        if(post)
        {
            posted = true;
            return 0;
        }
        while(Atomics.load(ctrl, word(C.IO_STATE)) === C.IO_REQUEST)
        {
            Atomics.wait(ctrl, word(C.IO_STATE), C.IO_REQUEST, 1000);
            if(Atomics.load(ctrl, C.SHUTDOWN)) throw new Error("machine shut down during I/O");
        }
        const result = ctrl[word(C.IO_RESULT)];
        Atomics.store(ctrl, word(C.IO_STATE), C.IO_IDLE);
        return result;
    }
    const halves = value => {
        const v = BigInt.asUintN(64, BigInt(value));
        return [Number(v & 0xFFFFFFFFn) | 0, Number(v >> 32n) | 0];
    };

    const env = {
        "memory": memory,
        "__indirect_function_table": table,
        "microtick": () => cpu ? cpu.clock.now() : now(),
        // a device register of the virt machine (src/virt/io.js), on the machine's thread
        "a64_mmio_read": (owner, offset, width) => {
            const [low, high] = halves(offset);
            const result = request(C.OP_A64_MMIO_READ, owner | width << 24, low, high);
            return BigInt(result >>> 0) | BigInt(ctrl[word(C.IO_RESULT_HI)] >>> 0) << 32n;
        },
        "a64_mmio_write": (owner, offset, width, value) => {
            const [low, high] = halves(offset);
            const [value_low, value_high] = halves(value);
            request(C.OP_A64_MMIO_WRITE, owner | width << 24, low, high, value_low, value_high, true);
        },
        "jit_publish": (client, id, slot, pointer, length) => cpu.jit_publish(client, id, slot, pointer, length),
        "jit_clear_func": index => cpu.jit_clear_func(index),
        // (the GLES backdoor needs the calling core's page tables: the cores
        // are cooperative where it is used; here its UDF stays undefined)
        "a32_backdoor": () => -0x80000000,
        "parallel_notify": address => { Atomics.notify(new Int32Array(memory.buffer), address >>> 2); },
        // the machine's extended RAM store (src/extended_memory.js)
        "extended_load": (page, pointer) => { extended.load(page, memory, pointer); },
        "extended_store": (page, pointer) => { extended.store(page, memory, pointer); },
        "console_log_from_wasm": (offset, length) => {
            const bytes = new Uint8Array(memory.buffer, offset >>> 0, length >>> 0).slice();
            console.error("[vCPU " + core + "] " + new TextDecoder().decode(bytes));
        },
    };

    const { instance } = await WebAssembly.instantiate(relocate(new Uint8Array(init.bytes), init.base, core), { "env": env });
    exports = handle.exports = instance.exports;
    exports["rust_init"]();
    exports["parallel_attach"](init.base, core);

    cpu = new A64CPU({ send() {}, register() {}, pair: null }, { exports, wasm_table: table }, () => {});
    cpu.clock = new MachineClock({ now });
    // no event loop in this worker: install generated code synchronously
    cpu.ir_sync_publication = true;
    const settings = init.settings;
    // the machine's JIT switches (src/browser/starter.js)
    set_jit_switches(exports, memory, settings["jit_switches"], "jit_switches (from the machine)");
    exports["parallel_set_active"](true);
    exports["parallel_idle"](true);

    ctrl[word(C.STATE_BASE)] = cpu.state_base;
    Atomics.store(ctrl, word(C.STATUS), C.STATUS_WAIT_SIPI);
    post({ "type": "ready", "core": core, "state_base": cpu.state_base });

    const publish_counters = () => {
        const retired = exports["core_statistics_get"](core, 0);
        ctrl[word(C.STEPS)] = retired % 0x100000000 | 0;
        ctrl[word(C.STEPS_HI)] = Math.floor(retired / 0x100000000) | 0;
        // (the instructions its page tier retired, cumulative while no reset clears them; installations given up)
        ctrl[word(C.JIT_ENTRIES)] = exports["jit_stat"](1, 2) % 0x100000000 | 0;
        ctrl[word(C.REFUSED)] = exports["parallel_code_stat"](0);
        // (diagnostics: TLB maintenance posted, DSBs that waited, entries taken; runs a kick ended)
        for(let i = 0; i < 3; i++) ctrl[word(C.RING_STATS + i)] = exports["a64_tlb_ring_stat"](i);
        ctrl[word(C.KICKED)] = exports["a64_kicked"]();
    };

    // a safe point: the machine stops every core for a snapshot, a reset or a pause
    function park(epoch)
    {
        settle();
        publish_counters();
        Atomics.store(ctrl, word(C.STATUS), C.STATUS_PARKED);
        exports["parallel_idle"](true);
        Atomics.store(ctrl, word(C.ACK), epoch);
        Atomics.add(ctrl, C.DOORBELL, 1);
        Atomics.notify(ctrl, C.DOORBELL);
        for(;;)
        {
            const resumed = Atomics.load(ctrl, C.RESUME);
            if(resumed >= epoch || Atomics.load(ctrl, C.SHUTDOWN)) break;
            Atomics.wait(ctrl, C.RESUME, resumed, 1000);
        }
        if(Atomics.load(ctrl, C.SHUTDOWN)) return;
        // (the machine's clock as resume() synchronized it: after a restore
        // into a new machine this core's own clock, which only goes on by
        // at most a second per reading, would stay behind it for good)
        cpu.clock.set_time(now());
        const command = Atomics.load(ctrl, C.COMMAND);
        if(command === C.COMMAND_RESET || command === C.COMMAND_RELOAD)
        {
            // (a reset: the core is off until CPU_ON again, a64_boot set that;
            // a restore: the machine wrote this core's state block)
            exports["jit_clear_cache_js"]();
            exports["a64_worker_restored"]();
        }
        exports["parallel_sync"]();
        exports["parallel_idle"](false);
    }

    const wake = new Int32Array(memory.buffer);
    const wake_index = exports["parallel_wake_addr"](core) >>> 2;
    const quantum = settings.cpu_quantum || 20000;
    // test hook (tests/parallel/lifecycle.mjs): this core fails after some slices
    const fault = settings["parallel_fault"];
    const faulty = fault && fault["core"] === core;
    let acked = Atomics.load(ctrl, C.STOP);

    for(;;)
    {
        if(Atomics.load(ctrl, C.SHUTDOWN)) break;
        const stop = Atomics.load(ctrl, C.STOP);
        if(stop !== acked)
        {
            park(stop);
            acked = stop;
            continue;
        }
        const seen = Atomics.load(wake, wake_index);
        // (its code writes, publications and TLB maintenance first, then up to `quantum` instructions)
        const ms = exports["a64_worker_slice"](quantum);
        ctrl[word(C.SLICES)]++;
        if((ctrl[word(C.SLICES)] & 63) === 0) publish_counters();
        Atomics.store(ctrl, word(C.RUNNING), ms >= 0 ? 1 : 0);
        if(faulty && ctrl[word(C.SLICES)] >= fault["after_slices"])
        {
            if(fault["kind"] === "trap") exports["parallel_test_fault"]();
            if(fault["kind"] === "exit") typeof process !== "undefined" ? process.exit(3) : globalThis.close();
            throw new Error("injected fault");
        }
        if(ms !== 0)
        {
            // off (until CPU_ON), or waiting (WFI, WFE) until its timers or a kick
            Atomics.store(ctrl, word(C.STATUS), ms < 0 ? C.STATUS_WAIT_SIPI : C.STATUS_HALTED);
            ctrl[word(C.WAITS)]++;
            exports["parallel_idle"](true);
            Atomics.wait(wake, wake_index, seen, ms < 0 ? 100 : Math.min(ms, 50));
            exports["parallel_idle"](false);
        }
        Atomics.store(ctrl, word(C.STATUS), C.STATUS_RUNNING);
    }
    Atomics.store(ctrl, word(C.STATUS), C.STATUS_EXITED);
    post({ "type": "exited", "core": core });
}
