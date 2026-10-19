// The control block shared by the machine and its vCPU workers
// (docs/multicore.md): an Int32Array over a
// SharedArrayBuffer of its own. Guest RAM and CPU state live in the Wasm
// memory; this block only carries the host protocol:
//
// - stop-the-world: the machine raises STOP to a new epoch and kicks every
//   core; a core acknowledges at its next safe point (between slices, or
//   while it waits halted) by writing the epoch to its ACK word, then waits
//   for RESUME to reach the same epoch and runs the COMMAND left for it;
// - I/O: a core in a worker posts a port or MMIO access in its slot, rings
//   DOORBELL and waits; the machine performs it on the devices' thread;
// - status words the machine reads for diagnostics and scheduling.

export const MAX_CORES = 8;

// machine words
export const STOP = 0;
export const RESUME = 1;
export const DOORBELL = 2;
export const COMMAND = 3;
export const SHUTDOWN = 4;          // workers exit their loop
export const CLOCK_ORIGIN_LO = 5;   // (unused: clocks use performance.timeOrigin)
export const PM_BASE = 6;           // the ACPI PM block's port, or -1 (ACPI.prototype.share_timer)

// per-core words, at core_word(core, WORD)
const CORE_BASE = 16;
const CORE_STRIDE = 32;
export const ACK = 0;               // last stop epoch this core acknowledged
export const STATUS = 1;            // STATUS_*
export const IO_STATE = 2;          // IO_IDLE, IO_REQUEST, IO_DONE
export const IO_OP = 3;
export const IO_ADDR = 4;
export const IO_V0 = 5;             // values of a write (up to 128 bits)
export const IO_V1 = 6;
export const IO_V2 = 7;
export const IO_V3 = 8;
export const IO_RESULT = 9;
export const TSC_OFFSET_LO = 10;    // published while parked
export const TSC_OFFSET_HI = 11;
export const RUNNING = 12;          // started by a start-up IPI (APs)
export const STATE_BASE = 13;       // address of the core's CPU state block
export const ERROR = 14;            // nonzero after the worker failed
export const SLICES = 15;
export const STEPS = 16;            // retired instructions, low 32 bits
export const WAITS = 17;            // halted waits
export const IO_COUNT = 18;         // requests served by the machine
export const JIT_ENTRIES = 19;      // entries into compiled code (the x64 page tier's functions)
export const REFUSED = 20;          // code installations given up: the other cores had not acknowledged in time
export const IO_RESULT_HI = 21;     // the high 32 bits of a 64-bit result (OP_A64_MMIO_READ)
export const STEPS_HI = 22;         // retired instructions, high bits (the ARM core's workers)
export const RING_STATS = 23;       // (the ARM core's workers, 3 words) TLB maintenance posted, DSBs that waited, entries taken
export const KICKED = 26;           // (the ARM core's workers) runs a kick ended early

export const CONTROL_WORDS = CORE_BASE + CORE_STRIDE * MAX_CORES;

// after the words, 8-byte slots: the clock offset (Float64), the PM timer
// offset (Float64) and the PM timer's shared maximum (BigInt64)
export const SLOT_CLOCK_OFFSET = 0;
export const SLOT_PM_TIMER_OFFSET = 1;
export const SLOT_PM_TIMER_LAST = 2;
export const CONTROL_BYTES = CONTROL_WORDS * 4 + 3 * 8;

export const STATUS_STARTING = 0;
export const STATUS_WAIT_SIPI = 1;
export const STATUS_RUNNING = 2;
export const STATUS_HALTED = 3;
export const STATUS_PARKED = 4;
export const STATUS_FAILED = 5;
export const STATUS_EXITED = 6;

export const IO_IDLE = 0;
export const IO_REQUEST = 1;
export const IO_DONE = 2;

// requests of a core in a worker
export const OP_IN8 = 1, OP_IN16 = 2, OP_IN32 = 3;
export const OP_OUT8 = 4, OP_OUT16 = 5, OP_OUT32 = 6;
export const OP_MMIO_READ8 = 7, OP_MMIO_READ32 = 8;
export const OP_MMIO_WRITE8 = 9, OP_MMIO_WRITE16 = 10, OP_MMIO_WRITE32 = 11, OP_MMIO_WRITE64 = 12, OP_MMIO_WRITE128 = 13;
export const OP_HALTED_FOREVER = 14;   // HLT with interrupts disabled (cpu_event_halt)
export const OP_RESET = 15;            // triple fault of the BSP is handled by the machine; unused by APs
// the ARM core (P8.2): a device register of the virt machine (src/virt/io.js),
// IO_ADDR the owner | width << 24, IO_V0/IO_V1 the offset, IO_V2/IO_V3 the value
export const OP_A64_MMIO_READ = 16, OP_A64_MMIO_WRITE = 17;

// commands for parked cores (the machine writes them before RESUME)
export const COMMAND_NONE = 0;
export const COMMAND_RELOAD = 1;       // state may have changed: drop caches derived from it
export const COMMAND_RESET = 2;        // machine reset: wait for INIT/SIPI again
export const COMMAND_FLUSH = 3;        // translations changed: flush TLBs

export function core_word(core, word)
{
    return CORE_BASE + CORE_STRIDE * core + word;
}
