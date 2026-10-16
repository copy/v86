# Multicore

With `cpu_cores: N` (1–8), the guest gets a single-socket processor with N cores
and one thread per core. Every core has its own architectural state, its own
local APIC, its own TLB and its own startup and interrupt handling, and all
cores share memory coherently. The emulator can run the cores in two ways:

- **cooperative** (the default): all cores take turns on one host thread;
- **parallel**: the application processors (APs) run at the same time, each in
  its own vCPU Worker.

This document is about the x86 cores. The arm64 core (`cpu_type: "arm64"`)
runs its cores the same two ways, with `build/v86-arm64-parallel.wasm` and
PSCI's CPU_ON instead of INIT/SIPI: see [aarch64.md](aarch64.md#cores-in-workers).

| | |
| --- | --- |
| Options | `cpu_cores: N` together with `acpi: true`; `experimental_smp_jit: true` to compile code on more than one core; internal option `parallel: "auto"` |
| Verified guests | Linux 4.16 i386 on 1/2/3/4/8 cores; Alpine 3.24 x86_64 on 1/2/4 cores; Windows 8.1 x64 on 1/2/4 cores (reports 1 package × N cores × 1 thread and runs threads pinned to each core) |
| Parallel mode | Litmus tests on 2/4/8 cores, an OS stress matrix (30/30 runs), 20 S3 + 20 S4 cycles on 4 cores, x86_64 Linux on 2/4 cores, headless Chrome, and a 90-minute soak test. Windows 8.1 x64 on 2 cores: 1 passing run after the last locking fix. |
| Speed-up | Parallel, 4 cores against 1 core: compute 1.59×, memory 2.52×, I/O 1.99× (Apple M1 Pro). Workloads that contend for one lock do not scale. |

## Design

**Correct first, then parallel.** The work had two milestones. The first was
correct guest multiprocessing with the cores taking turns on one thread
(cooperative). The second was running them truly in parallel on host threads.
Cooperative mode is the reference implementation and remains the fallback and
debugging path. Its test results show correctness only; they say nothing about
speed.

**Each piece of state belongs either to one core or to the machine.**

```text
V86 / machine
  +- platform description, firmware (fw_cfg), guest physical memory
  +- shared devices: PCI, PIC, IOAPIC, ACPI, PIT, RTC, disks, network, DMA
  +- machine clock, event queue, scheduler, code page generations
  +- cores[0..N)
       +- GPRs, RIP, flags, segments, CR/DR, MSRs, FPU/XMM
       +- local APIC (+ ApicAux), BSP/AP startup state, pending IRQ/NMI, HLT
       +- TLB, paging context, fault and REP continuations
       +- JIT activations and statistics
```

[`gen/state_layout.js`](../gen/state_layout.js) declares an owner for every
field of the state block: `core`, `cache`, `scratch`, `machine` or `debug`.
`make state-layout-check` also scans `src/rust` and fails if any Rust `static`
has not been assigned an owner, so no hidden global state can go unnoticed.

**Cooperative mode swaps state blocks and keeps compiled code.** The compiled
code already reads the running core's state from fixed addresses. Each core has
a save area. At a safe point, v86 switches cores. A safe point is between two
slices, when no JIT or helper frame is active and no REP or fault continuation
is pending. `save_core_state()` writes the x87 shadow back and copies the
per-core ranges out of the fixed block (1936 bytes today, as `node gen/state_layout.js --check` reports).
`load_core_state()` copies the next core's state in and discards everything
derived from it: the EIP translation cache, `state_flags` and the x87 shadow.
Compiled code stays valid for every core, because it checks the TLB and the CPU
mode when it is entered. Each core has its own sparse TLB, saved and restored on
every switch instead of flushed. That way a guest that forgets a TLB shootdown
still sees stale translations, just as on hardware.

**The scheduler bounds every slice.** JS `run_cores()` chooses the next core and
calls Rust `run_cpu_slice(budget)`:

- A slice lasts at most `cpu_quantum` dispatches (32768 by default with the
  JIT, 4096 interpreted or with the deterministic clock).
  `cpu_schedule_seed` fixes the order of cores, so a run can be reproduced.
- PAUSE ends the slice, so a core that spins on a lock gives the others a turn.
- A long REP instruction yields every 256 elements.
- A LOCKed instruction or an XCHG with memory is never split between slices.
- HLT stops only its own core. When every core is halted, the machine waits for
  the next device deadline instead of spinning.
- The devices are clocked once per machine round, never once per core.

**All cores share one machine clock.** [`src/machine_clock.js`](../src/machine_clock.js)
feeds the PIT, RTC, PM timer, the LAPIC timers and the TSC. In normal mode it
follows the host's monotonic time, and a host pause adds at most 1000 ms, which
is reported in the diagnostics. In deterministic mode
(`cpu_clock: { mode: "deterministic" }`) it advances with retired instructions,
so the same input and seed always produce the same sequence of interrupts.
Adding a core never makes guest time run faster.

**Each core has a complete interrupt controller.** There is one LAPIC per core,
kept in an array, plus a per-core `ApicAux` holding the hardware-enable bit,
pending ExtINT and queued trigger modes.

- The ICR supports physical and logical destinations (flat and cluster), the
  destination shorthands, and fixed, lowest-priority, NMI, INIT, SIPI and ExtINT
  delivery.
- EOI and remote-IRR handle level-triggered interrupts, and every core has its
  own LAPIC timer.
- The IOAPIC delivers to the cores its redirection entries name; device IRQs are
  no longer sent to the BSP unconditionally.
- The PIC reaches the BSP through LINT0 in virtual-wire (ExtINT) mode.
- An AP starts in the wait-for-SIPI state. SeaBIOS or the OS brings it up with
  INIT-SIPI-SIPI through a real-mode trampoline. The firmware sees the full core
  count, and every AP really runs.

**Every source reports the same topology.** [`src/platform.js`](../src/platform.js)
defines it once: 1 socket, N cores, 1 thread per core, APIC IDs 0 to N−1. The
following are all generated from it:

- CPUID leaf 1: logical processor count, HTT bit, initial APIC ID;
- CPUID leaf 4: a private L1 per core and an L2 shared within the package;
- CPUID leaves 0xB and 0x1F: SMT shift 0, core shift ⌈log2 N⌉ (for 3 cores, the
  shift is 2);
- the MADT LAPIC entries, the DSDT `Processor()` objects, fw_cfg `NB_CPUS` and
  CMOS.

With `cpu_cores: 1`, the CPU keeps the legacy CPUID profile, so guests that
already run on one core see no change.

**Cross-core coherence is a complete protocol.**

- LOCK, implicitly locked XCHG, CMPXCHG8B and CMPXCHG16B are atomic in the
  interpreter and the x64 page tier (and were in IR Tier-0 and the region
  pipeline until [jit-unification-plan.md](jit-unification-plan.md) deleted
  them in P7.5 and M11). This includes operands that cross
  a page or touch MMIO: faults and partial commits follow what the instruction
  specifies.
- Each core has its own TLB. Other cores' TLBs are invalidated only by the
  guest's own IPI shootdowns, never by an implicit "flush every core whenever a
  page table changes".
- A write to code bumps the page's machine-wide generation and retires the
  compiled code on every core.
- An asynchronous compile result is checked against the current execution epoch
  before it is installed.
- IR optimisations never reuse a loaded RAM value across a safe point.

In the library API, more than one core runs interpreted unless the embedding
page sets `experimental_smp_jit: true`. `index.html` turns it on.

**The lifecycle covers the whole machine.** A snapshot contains every core's
state, LAPIC/ApicAux, pending IPIs, REP/HLT continuations, TLBs, the clock and
the scheduler's position. Restoring a snapshot into a machine with a different
core count is rejected before anything in RAM changes. A triple fault on the BSP
resets the machine at a safe point. A shutdown on an AP stops only that core,
and NMI or INIT can revive it. Reset, S3 and S5 coordinate all cores.

**Parallel mode relocates the Wasm module instead of passing a context
pointer.** `make parallel` builds `v86-parallel.wasm` with the Rust feature
`parallel` and `+atomics`, importing a shared memory:

- [`tools/parallel_wasm.mjs`](../tools/parallel_wasm.mjs) records every place
  that holds the address of a static as a relocation.
- [`src/parallel/relocate.js`](../src/parallel/relocate.js) instantiates the same
  module for each vCPU at a fresh base in the same shared memory. Each core gets
  its own statics, stack, heap, JIT and `WebAssembly.Table`, and all cores share
  guest RAM.
- Each core's state block sits in a low slot at `slot × 4096`. On arm64, V8
  encodes only small constant addresses directly in a load or store
  instruction; with the blocks at high addresses, compiled code was 1.4× slower.
- State that belongs to the machine is reached through
  `crate::parallel::machine()`: the LAPICs, the IOAPIC, the INIT/SIPI/NMI
  latches, the physical bus, code page owners and extended RAM.
- The default `v86.wasm` is built without any of this, so single-threaded
  performance is unchanged.

**The parallel runtime.** The machine thread runs the BSP and every device. Each
AP runs in a vCPU Worker ([`src/parallel/`](../src/parallel/)).

- *Control block* (a SharedArrayBuffer): STOP/RESUME/ACK epochs implement
  stop-the-world for pause, snapshot, reset, S3, power-on and destroy. Each core
  has a request slot through which its port and MMIO accesses reach the machine
  thread. Two kinds of port access are handled inside the worker instead: PM
  timer reads, computed from the shared clock, and writes to port 0x80.
- *Memory model*: each aligned access to guest RAM is a sequentially consistent
  Wasm atomic, which gives x86 TSO even on weakly ordered hosts. Unaligned
  accesses add fences. A LOCKed read-modify-write commits with compare-exchange
  and runs the instruction again after a conflict. Some locked operations cannot
  be done with one host atomic: unaligned ones, those crossing a page, and
  CMPXCHG16B. These run in *exclusive* mode, while aligned CAS commits run in
  *shared* mode, so the two kinds never interleave. A/D bits are set with an
  atomic OR.
- *JIT*: all three tiers use atomic load and store templates. In the x64
  page tier, a LOCKed read-modify-write or XCHG with memory on an aligned
  operand is a compare-exchange loop that commits through the same shared
  mode as the interpreter's (`x64_page_lock_commit`); unaligned ones go to
  the interpreter. Unaligned plain accesses do not leave compiled code: reads
  are copied with plain loads and a fence, stores are plain stores after a
  fence. Compiled code leaves its function when another core kicks this one
  (an IPI, a code publication), so interrupts wait at most one block. The
  other tiers leave LOCKed instructions to the interpreter.
- *Code coherence*: every backing page has an OWNERS byte, one bit per core.
  Before a core installs compiled code, it announces the page on a publish ring
  and waits until the other cores acknowledge, bounded by a count. Writes to a
  page that another core owns go to an invalidation ring. Cores `poll` these
  rings on each dispatch and on CPUID, IRET and interrupt delivery; a
  publication retires only the access cache's write entries of that page.
- *Faults*: a failing worker releases every lock it holds (IOAPIC, split lock,
  extended RAM). The machine stops and emits `emulator-error`.

**The backend is chosen automatically.** `parallel: "auto"` runs cores in
workers only when all of these hold:

- SharedArrayBuffer and Atomics are available;
- a shared `WebAssembly.Memory` can be created;
- Workers are available;
- in a browser, the page is `crossOriginIsolated`;
- `navigator.hardwareConcurrency` is at least the number of cores;
- the clock is not deterministic;
- `v86-parallel.wasm` loads.

Otherwise the same N cores run cooperatively, and `get_diagnostics().execution`
gives the reason. The guest never gets fewer cores because of the host.
`parallel: true` forces parallel mode and is meant for tests.

## Architecture

### Cooperative (one Wasm instance, one host thread)

```text
+------------------------------ machine: v86.wasm -------------------------------+
|  guest RAM | devices (PIT RTC ACPI IDE NIC VGA ...) | PIC | IOAPIC              |
|  machine clock | code page generations | scheduler run_cores()                 |
|                                                                                |
|        fixed-address CPU state block  (what compiled code reads)               |
|            ^  load_core_state()              |  save_core_state()              |
|            |                                 v                                 |
|   +---------------+ +---------------+ +---------------+ +---------------+      |
|   | core 0 (BSP)  | | core 1        | | core 2        | | core 3        |      |
|   | save area     | | save area     | | save area     | | save area     |      |
|   | LAPIC 0, TLB  | | LAPIC 1, TLB  | | LAPIC 2, TLB  | | LAPIC 3, TLB  |      |
|   +---------------+ +---------------+ +---------------+ +---------------+      |
+--------------------------------------------------------------------------------+

host thread: | core0 <=4096 | core1 <=4096 | core2 <=4096 | core3 <=4096 | devices | core0 ...
               (a slice ends early on PAUSE, HLT, or 256 REP elements)
```

### Parallel (one Wasm module, N instances, N host threads)

```text
 main thread or CPU worker (machine thread)        vCPU workers (one per AP)
+-------------------------------------------+     +-----------------------------+
| v86-parallel.wasm instance at base 0      |     | same module, relocated      |
| core 0 (BSP), state slot 0                |     | core k, state slot k        |
| every device, IOAPIC, LAPICs, clock       |     | own statics, stack, heap,   |
| run_parallel(): serves I/O requests,      |     | JIT, WebAssembly.Table      |
| stop-the-world                            |     | PM timer, port 0x80 local   |
+---------------------+---------------------+     +--------------+--------------+
                      |                                          |
     +----------------+------ shared WebAssembly.Memory ---------+--------------+
     | guest RAM (seq-cst atomics) | machine state | per-instance regions       |
     +--------------------------------------------------------------------------+
     +------------------- control block (SharedArrayBuffer) --------------------+
     | STOP / RESUME / ACK epochs | I/O request slot per core | statistics      |
     +--------------------------------------------------------------------------+
     +------------------- code coherence (in machine state) --------------------+
     | OWNERS bits per backing page | publish ring | invalidation ring          |
     +--------------------------------------------------------------------------+
```

### AP startup

```text
BSP (SeaBIOS, then the OS)          LAPIC of AP k              AP k
--------------------------          -------------              ----
                                                               wait-for-SIPI
write ICR: INIT (dest k)  --------> INIT --------------------> reset core state
write ICR: SIPI vector vv --------> SIPI --------------------> CS:IP = vv00:0000, real mode
(a second SIPI is ignored)                                      trampoline:
                                                                 protected mode
                                                                 (long mode: PAE, LME, PG)
wait for "online" flag   <------------ shared memory / IPI ---- sets its flag,
                                                                enables its LAPIC, idles in HLT
```

## Example

**Cooperative**, in the style of `retro-gaming-site/app.js`: Windows 8.1 x64 on
4 cores.

```js
emulator = new V86({
    graphics_adapter: "bochs_vga",
    wasm_path: "v86.wasm",
    memory_size: 2 * 1024 * 1024 * 1024,
    vram_size: 16 * 1024 * 1024,
    bios: { url: "bios/seabios.bin" },
    vga_bios: { url: "bios/vgabios.bin" },
    screen_container: document.getElementById("screen_container"),
    hda: { url: "windows8/windows8.img", async: true, size: WINDOWS8_IMAGE_BYTES },
    acpi: true,                    // required for cpu_cores > 1 (it turns on the local APICs)
    cpu_cores: 4,                  // 1 socket x 4 cores x 1 thread
    cpu_type: "x86_64",
    experimental_smp_jit: true,    // compile on every core; without it, N > 1 is interpreted
    net_device: { type: "ne2k", relay_url: "wss://relay.widgetry.org/" },
    autostart: true,
});
```

**Parallel where the host allows it**, falling back to cooperative mode:

```js
emulator = new V86({
    graphics_adapter: "bochs_vga",
    wasm_path: "v86.wasm",                       // cooperative build, used as the fallback
    parallel: "auto",                            // internal option: APs in vCPU workers
    parallel_wasm_path: "v86-parallel.wasm",     // from `make parallel` (build/)
    vcpu_worker_url: "vcpu-worker.js",           // from `make parallel` (build/)
    acpi: true,
    cpu_cores: 4,
    experimental_smp_jit: true,
    // ... bios, vga_bios, disks, screen_container, net_device as above
    autostart: true,
});

emulator.add_listener("emulator-ready", async () => {
    const { execution } = await emulator.get_diagnostics();
    // { mode: "parallel", fallback: null }  or
    // { mode: "cooperative", fallback: "not cross-origin isolated" }
    updateStatus("4 cores, " + execution.mode + (execution.fallback ? " (" + execution.fallback + ")" : ""));
});
```

For parallel mode, copy `build/v86-parallel.wasm` and `build/vcpu-worker.js`
next to `libv86.js`, and serve the page cross-origin isolated:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp        (or: credentialless)
```

Under `require-corp`, every cross-origin subresource (images, disks from a CDN)
must allow it with CORP or CORS headers. WebSocket relays are not affected.
In `index.html`, a guest with more than one core uses `parallel: "auto"` unless
the "Run cores in parallel" checkbox or `?parallel=0` turns it off.

**Reproducible runs** (tests and debugging only): add
`cpu_clock: { mode: "deterministic" }`, `cpu_quantum: 257` and
`cpu_schedule_seed: 7`. Deterministic mode runs interpreted and never runs
cores in parallel.

## Performance

The benchmark gives every configuration the same fixed total amount of guest
work, and every round's result is checked against a reference checksum
(`make multicore-parallel-bench`, [`tests/parallel/bench.mjs`](../tests/parallel/bench.mjs)).
Host: Apple M1 Pro (8 performance + 2 efficiency cores), Node 25, JIT on.
Times are the best of 3 warm rounds.

| Workload | 1 core | 2 coop | 2 parallel | 4 coop | 4 parallel | 8 parallel |
| --- | --- | --- | --- | --- | --- | --- |
| compute | 1.48 s | 12.46 s | **1.09 s** | 9.55 s | **0.93 s** | 1.35 s |
| memory | 0.69 s | 19.73 s | **0.47 s** | 15.32 s | **0.27 s** | 0.62 s |
| I/O (PM timer, port 0x80) | 0.21 s | 0.28 s | **0.20 s** | 0.29 s | **0.11 s** | 0.11 s |
| lock (XCHG spinlock) | 1.26 s | 6.39 s | 1.94 s | 5.47 s | 3.78 s | 8.34 s |

- Cooperative mode gives correct multiprocessing but no speed-up: every 4096
  dispatches it swaps state blocks. Use it for compatibility, not for speed.
- Parallel mode is 6–70× faster than cooperative mode at the same core count.
  At 8 cores it stops scaling, because this host has only 8 performance cores.
- Workloads that contend for one lock do not scale, because LOCKed instructions
  and XCHG with memory run in the interpreter's CAS path.
- On one core, the parallel build is about 15% slower on memory-heavy work,
  because every guest access is atomic. Compute-bound work runs at the same
  speed. That is why the default build is still `v86.wasm`.

## Testing

| Target | What it checks |
| --- | --- |
| `make smp-tests` | The state layout, and two contexts alternating on one machine without affecting each other (registers, x87, SSE, TLB) |
| `make multicore-boot-tests` | INIT/SIPI, APIC routing (physical, flat, cluster), NMI, IOAPIC level re-delivery, slice budgets, real SeaBIOS on 2/3/4/8 cores, kvm-unit-tests `apic`/`ioapic`/`smptest` |
| `make multicore-clock-tests` | Deterministic IRQ sequences, pause and host-gap limits, clock state in snapshots |
| `make multicore-topology-tests`, `make multicore-linux-tests` | CPUID/MADT/AML/fw_cfg/CMOS agree for 1–8 cores; Linux `lscpu` and sysfs show 1 socket; pinned processes make progress on every core |
| `make multicore-coherence-tests` | Scenarios per build: interpreter and page tier (Tier-0 and the region pipeline until P7.5 and M11) × seeds 1–10 × quantum 17/257/4096; atomics, shared loads, SMC through an alias, DMA, IPI shootdown. Mutated builds (flush on every switch, no INVLPG) must fail. |
| `make multicore-atomic-tests`, `make multicore-memory-order-tests` | 107 atomic boundary cases per backend (crossing pages, MMIO, faults); 96 lock-free publication and queue cases |
| `make multicore-state-tests`, `make multicore-os-stress-tests` | Snapshots taken with pending IPIs or in the middle of REP/HLT; Linux fork/signal/migration/IDE/NE2K stress on the interpreter and the page tier, reboot, S5 |
| `make x64-multicore-tests` | Long mode on 4 cores: state and TLB isolation, CX16, fixed IPIs and NMIs to cores in HLT, broadcast IPIs, snapshot replay |
| `make multicore-parallel-tests` (and `-release`, `-browser-tests`) | Litmus tests (counters, message passing, store buffering, SMC, an IPI wake-up ring, A/D races, locks of different widths on the same bytes), worker lifecycle and injected faults, relocation, Linux boot, headless Chrome with COOP/COEP |
| `node tests/parallel/soak.mjs` | 4 cores in parallel with JIT for 90 minutes: 775 rounds, 2325 stop/run cycles, 775 snapshots restored in place, 155 S3/RTC wake-ups; no oops, soft lockups or RCU stalls |

These make up release levels `R-SMP32` and `R-parallel` of
`make platform-release-gate`.

**Known limits:**

- Windows 8.1 x64 in parallel mode has one clean 2-core run since the fix for
  locks of different widths. An earlier run crashed in a `lock bts`. No 4-core
  parallel Windows run has been done yet.
- Extended RAM ([x86-64.md](x86-64.md)) always takes the slow path in parallel
  mode.
- Parallel mode has been recorded only in Node and headless Chrome, not in
  Firefox or Safari.
- Some embedded browser panes do not allow a worker to create another worker
  from a URL. There, `parallel` combined with `cpu_worker` fails.
- The Windows XP image of retro-gaming-site uses the uniprocessor Standard PC
  HAL. It needs a fresh ACPI install before it can use more than one core.
- There is no SMBIOS type 4 table. The topology comes from CPUID and the MADT.
