// A vCPU worker (docs/multicore.md): one
// application processor of a machine whose bootstrap processor and devices
// run on another thread (src/parallel/machine.js).
//
// The worker relocates its own instance of v86-parallel.wasm into the shared
// memory and attaches it to the machine (crate::parallel): guest RAM, the
// local APICs and the IOAPIC are the machine's; the CPU state, TLB, JIT and
// Rust heap are this instance's. Port and device MMIO accesses go to the
// machine through the control block; the worker blocks meanwhile. Its loop
// never returns to the event loop: generated code is compiled synchronously
// and all coordination goes through shared memory.

import { CPU } from "../cpu.js";
import { MachineClock } from "../machine_clock.js";
import { WASM_TABLE_OFFSET, WASM_TABLE_SIZE } from "../const.js";
import { view } from "../lib.js";
import { CORE_STATE_RANGES, INIT_PRESERVED } from "../state_layout.js";
import { relocate } from "./relocate.js";
import { PM_TIMER_TICKS_PER_MS, pm_timer_shared_max } from "../acpi.js";
import { ExtendedStore } from "../extended_memory.js";
import * as C from "./control.js";
import { set_jit_switches } from "../jit_switches.js";
import { run_vcpu_arm } from "./vcpu_arm.js";

const CORE_EVENT_INIT = 1;
const CORE_EVENT_SIPI = 2;

/**
 * @param {Object} init from ParallelMachine.start
 * @param {function(Object)} post message to the machine
 * @param {{exports: Object}} handle receives the instance's exports (for the failure path)
 */
export async function run_vcpu(init, post, handle)
{
    const core = init.core;
    const memory = init.memory;
    const ctrl = new Int32Array(init.control);
    const clock_offset = new Float64Array(init.control, C.CONTROL_WORDS * 4 + 8 * C.SLOT_CLOCK_OFFSET, 1);
    const pm_timer_offset = new Float64Array(init.control, C.CONTROL_WORDS * 4 + 8 * C.SLOT_PM_TIMER_OFFSET, 1);
    const pm_timer_last = new BigInt64Array(init.control, C.CONTROL_WORDS * 4 + 8 * C.SLOT_PM_TIMER_LAST, 1);
    const word = w => C.core_word(core, w);
    const table = new WebAssembly.Table({ "element": "anyfunc", "initial": WASM_TABLE_SIZE + WASM_TABLE_OFFSET });

    let cpu = null, exports = null;
    const extended = init.extended ? new ExtendedStore(init.extended["pages"], init.extended["chunks"], init.extended["touched"]) : null;
    const host_now = () => performance.timeOrigin + performance.now();
    const now = () => host_now() - clock_offset[0];

    // a request the machine performs on the devices' thread
    function request(op, addr, v0 = 0, v1 = 0, v2 = 0, v3 = 0)
    {
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
        while(Atomics.load(ctrl, word(C.IO_STATE)) === C.IO_REQUEST)
        {
            Atomics.wait(ctrl, word(C.IO_STATE), C.IO_REQUEST, 1000);
            if(Atomics.load(ctrl, C.SHUTDOWN)) throw new Error("machine shut down during I/O");
        }
        const result = ctrl[word(C.IO_RESULT)];
        Atomics.store(ctrl, word(C.IO_STATE), C.IO_IDLE);
        return result;
    }

    // Ports this worker serves itself: the ACPI PM timer (the same ticks the
    // machine's device computes from the shared clock, see
    // ACPI.prototype.share_timer) and the POST port 0x80, which ignores writes
    function read32(port)
    {
        const pm_base = ctrl[C.PM_BASE];
        if(pm_base >= 0 && port === pm_base + 8)
        {
            const ticks = Math.floor(cpu.clock.now() * PM_TIMER_TICKS_PER_MS) + pm_timer_offset[0];
            return pm_timer_shared_max(pm_timer_last, ticks) & 0xFFFFFF;
        }
        return request(C.OP_IN32, port);
    }

    const env = {
        "memory": memory,
        "__indirect_function_table": table,
        "cpu_exception_hook": () => false,
        "run_hardware_timers": (acpi_enabled, t) => acpi_enabled ? exports["apic_timer"](t) : 100,
        "cpu_event_halt": () => {},
        "abort": () => { throw new Error("abort from vCPU " + core); },
        "microtick": () => cpu ? cpu.clock.now() : now(),
        "get_rand_int": () => Math.random() * 0x100000000 | 0,
        "stop_idling": () => {},
        // (cores built before the wide-native path was removed import it)
        "x64_native_discard": () => {},
        "jit_publish": (client, id, slot, pointer, length) => cpu.jit_publish(client, id, slot, pointer, length),
        "io_port_read8": port => request(C.OP_IN8, port),
        "io_port_read16": port => request(C.OP_IN16, port),
        "io_port_read32": read32,
        "io_port_write8": (port, value) => { if(port !== 0x80) request(C.OP_OUT8, port, value); },
        "io_port_write16": (port, value) => { request(C.OP_OUT16, port, value); },
        "io_port_write32": (port, value) => { request(C.OP_OUT32, port, value); },
        "mmap_read8": addr => request(C.OP_MMIO_READ8, addr),
        "mmap_read32": addr => request(C.OP_MMIO_READ32, addr),
        "mmap_write8": (addr, value) => { request(C.OP_MMIO_WRITE8, addr, value); },
        "mmap_write16": (addr, value) => { request(C.OP_MMIO_WRITE16, addr, value); },
        "mmap_write32": (addr, value) => { request(C.OP_MMIO_WRITE32, addr, value); },
        "mmap_write64": (addr, v0, v1) => { request(C.OP_MMIO_WRITE64, addr, v0, v1); },
        "mmap_write128": (addr, v0, v1, v2, v3) => { request(C.OP_MMIO_WRITE128, addr, v0, v1, v2, v3); },
        "log_from_wasm": (offset, length) => {
            const bytes = new Uint8Array(memory.buffer, offset >>> 0, length >>> 0).slice();
            if(init.log) console.log("[vCPU " + core + "] " + new TextDecoder().decode(bytes));
        },
        "console_log_from_wasm": (offset, length) => {
            const bytes = new Uint8Array(memory.buffer, offset >>> 0, length >>> 0).slice();
            console.error("[vCPU " + core + "] " + new TextDecoder().decode(bytes));
        },
        "dbg_trace_from_wasm": () => {},
        "jit_clear_func": index => cpu.jit_clear_func(index),
        "parallel_notify": address => { Atomics.notify(new Int32Array(memory.buffer), address >>> 2); },
        // the machine's extended RAM store (src/extended_memory.js)
        "extended_load": (page, pointer) => { extended.load(page, memory, pointer); },
        "extended_store": (page, pointer) => { extended.store(page, memory, pointer); },
    };

    const { instance } = await WebAssembly.instantiate(relocate(new Uint8Array(init.bytes), init.base, core), { "env": env });
    exports = handle.exports = instance.exports;
    exports["rust_init"]();
    exports["parallel_attach"](init.base, core);

    const bus = { send() {}, register() {}, pair: null };
    cpu = new CPU(bus, { exports, wasm_table: table }, () => {});
    cpu.clock = new MachineClock({ now });
    const settings = init.settings;
    cpu.configure_jit_backend(settings);
    // no event loop in this worker: install generated code synchronously
    cpu.ir_sync_publication = true;
    // (the CPU profile, CPUID level and x64 capabilities, is the machine's:
    // crate::cpu::cpu::copy_machine_configuration)
    exports["set_x87_fast_math"]?.(settings["x87_fast_math"] !== false);
    exports["set_x87_jit_cache"]?.(settings["x87_jit_cache"] !== false);
    // the machine's JIT switches (src/browser/starter.js), over what
    // configure_jit_backend set; later changes arrive through
    // crate::jit_switches::copy_from_machine
    set_jit_switches(exports, memory, settings["jit_switches"], "jit_switches (from the machine)");
    cpu.mem8 = view(Uint8Array, memory, init.mem8, init.memory_size);
    cpu.mem32s = view(Uint32Array, memory, init.mem8, init.memory_size >> 2);
    exports["parallel_set_active"](true);
    exports["parallel_idle"](true);
    cpu.reset_cpu();
    exports["context_reset"](core);
    const reset_state = cpu.save_core_state();
    let running = false;

    ctrl[word(C.STATE_BASE)] = cpu.state_base;
    Atomics.store(ctrl, word(C.STATUS), C.STATUS_WAIT_SIPI);
    post({ "type": "ready", "core": core, "state_base": cpu.state_base });

    // INIT and start-up IPIs for this core (CPU.prototype.take_core_events)
    function take_core_events()
    {
        const events = exports["apic_take_core_events"](core);
        if(!events) return;
        if(events & CORE_EVENT_INIT)
        {
            if(exports["exception_shutdown"](core) === 2) return;
            exports["apic_init_core"](core);
            exports["context_reset"](core);
            const next = reset_state.map(bytes => bytes.slice());
            const current = cpu.save_core_state();
            for(const [offset, size] of INIT_PRESERVED)
            {
                const index = CORE_STATE_RANGES.findIndex(([start, end]) => offset >= start && offset + size <= end);
                const at = offset - CORE_STATE_RANGES[index][0];
                next[index].set(current[index].subarray(at, at + size), at);
            }
            cpu.load_core_state(next);
            running = false;
        }
        if((events & CORE_EVENT_SIPI) && !running)
        {
            const vector = events >> 8 & 0xFF;
            cpu.sreg[1] = vector << 8;
            cpu.segment_offsets[1] = vector << 12;
            cpu.instruction_pointer[0] = vector << 12;
            cpu.previous_ip[0] = vector << 12;
            cpu.update_state_flags();
            running = true;
        }
        Atomics.store(ctrl, word(C.RUNNING), running ? 1 : 0);
    }

    // a safe point: the machine stops every core for a snapshot, reset or pause
    function park(epoch)
    {
        exports["fpu_cache_barrier"]();
        ctrl[word(C.TSC_OFFSET_LO)] = exports["parallel_tsc_offset"](false);
        ctrl[word(C.TSC_OFFSET_HI)] = exports["parallel_tsc_offset"](true);
        Atomics.store(ctrl, word(C.RUNNING), running ? 1 : 0);
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
        // at most a second per reading, would stay behind it for good; as
        // vcpu_arm.js)
        cpu.clock.set_time(now());
        const command = Atomics.load(ctrl, C.COMMAND);
        if(command === C.COMMAND_RESET)
        {
            // machine reset or power-on: back to waiting for INIT/SIPI
            exports["jit_clear_cache_js"]();
            cpu.reset_cpu();
            exports["context_reset"](core);
            cpu.load_core_state(reset_state.map(bytes => bytes.slice()));
            running = false;
        }
        else if(command === C.COMMAND_RELOAD)
        {
            // the machine replaced this core's state and RAM (snapshot restore)
            exports["jit_clear_cache_js"]();
            exports["context_reset"](core);
            exports["parallel_set_tsc_offset"](ctrl[word(C.TSC_OFFSET_LO)], ctrl[word(C.TSC_OFFSET_HI)]);
            exports["fpu_discard_cache"]();
            cpu.full_clear_tlb();
            cpu.update_state_flags();
            running = Atomics.load(ctrl, word(C.RUNNING)) !== 0;
        }
        else if(command === C.COMMAND_FLUSH)
        {
            exports["context_reset_translations"]?.(core);
            cpu.full_clear_tlb();
        }
        exports["parallel_sync"]();
        exports["parallel_idle"](false);
        Atomics.store(ctrl, word(C.RUNNING), running ? 1 : 0);
        Atomics.store(ctrl, word(C.STATUS), running ? C.STATUS_RUNNING : C.STATUS_WAIT_SIPI);
    }

    const wake = new Int32Array(memory.buffer);
    const wake_index = exports["parallel_wake_addr"](core) >>> 2;
    // (a slice as long as the BSP's main-loop batch, LOOP_COUNTER: kicks end
    // it early, and run_cpu_slice acknowledges other cores' code
    // publications between entries as the BSP's loop does; what this loop
    // does per slice cost a float benchmark 2% at 20000)
    const quantum = settings.cpu_quantum || 100000;
    // test hook (tests/parallel/lifecycle.mjs): this core fails after some slices
    const fault = settings["parallel_fault"];
    const faulty = fault && fault["core"] === core;
    let acked = Atomics.load(ctrl, C.STOP);
    let steps = 0;
    let jit_entries = 0, last_entries = 0;

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
        take_core_events();
        if(!running)
        {
            Atomics.store(ctrl, word(C.STATUS), C.STATUS_WAIT_SIPI);
            exports["parallel_idle"](true);
            Atomics.wait(wake, wake_index, seen, 100);
            exports["parallel_idle"](false);
            continue;
        }
        // compiled code: other cores' publications and code writes
        exports["parallel_poll"]();
        const now = cpu.clock.now();
        const next_timer = exports["apic_timer"](now);
        const retired = cpu.run_cpu_slice(quantum);
        steps = steps + retired | 0;
        ctrl[word(C.STEPS)] = steps;
        ctrl[word(C.SLICES)]++;
        // (cumulative: a reset or restore clears the page tier's own
        // counters; its functions' entries)
        const entries = exports["x64_page_stat"](6) >>> 0;
        jit_entries += entries >= last_entries ? entries - last_entries : entries;
        last_entries = entries;
        ctrl[word(C.JIT_ENTRIES)] = jit_entries;
        ctrl[word(C.REFUSED)] = exports["parallel_code_stat"](0);
        if(faulty && ctrl[word(C.SLICES)] >= fault["after_slices"])
        {
            if(fault["kind"] === "trap") exports["parallel_test_fault"]();
            if(fault["kind"] === "exit") typeof process !== "undefined" ? process.exit(3) : globalThis.close();
            throw new Error("injected fault");
        }
        if(cpu.in_hlt[0])
        {
            exports["handle_irqs"]();
            if(cpu.in_hlt[0] && !exports["apic_peek_core_events"](core))
            {
                Atomics.store(ctrl, word(C.STATUS), C.STATUS_HALTED);
                ctrl[word(C.WAITS)]++;
                exports["parallel_idle"](true);
                Atomics.wait(wake, wake_index, seen, Math.max(0, Math.min(next_timer, 50)));
                exports["parallel_idle"](false);
            }
        }
        Atomics.store(ctrl, word(C.STATUS), C.STATUS_RUNNING);
    }
    Atomics.store(ctrl, word(C.STATUS), C.STATUS_EXITED);
    post({ "type": "exited", "core": core });
}

/** Worker entry: the first message starts the core */
export function start_vcpu_worker()
{
    const node = typeof process !== "undefined" && process.versions && process.versions.node;
    const start = async (init, post) => {
        const handle = { exports: null };
        try
        {
            // (the ARM core's workers: P8.2; arm32's too)
            await (init["cpu_type"] === "arm64" || init["cpu_type"] === "arm32" ? run_vcpu_arm : run_vcpu)(init, post, handle);
        }
        catch(error)
        {
            // release the machine's locks this core held before anyone waits for it
            try { handle.exports?.["parallel_fail"](); } catch(e) { /* the instance may be unusable */ }
            const ctrl = new Int32Array(init.control);
            Atomics.store(ctrl, C.core_word(init.core, C.ERROR), 1);
            Atomics.store(ctrl, C.core_word(init.core, C.STATUS), C.STATUS_FAILED);
            Atomics.add(ctrl, C.DOORBELL, 1);
            Atomics.notify(ctrl, C.DOORBELL);
            try { handle.exports?.["parallel_kick"](0); } catch(e) { /* the instance may be unusable */ }
            post({ "type": "error", "core": init.core, "message": String(error && error.stack || error) });
        }
    };
    if(node)
    {
        import("node:" + "worker_threads").then(({ parentPort }) => {
            parentPort.once("message", init => start(init, message => parentPort.postMessage(message)));
        });
    }
    else
    {
        const first = e => {
            globalThis.removeEventListener("message", first);
            start(e.data, message => globalThis.postMessage(message));
        };
        globalThis.addEventListener("message", first);
    }
}
