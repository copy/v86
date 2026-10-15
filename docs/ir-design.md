# v86 JIT: design and architecture

v86 has one x86 compiler: the **x64 page tier** (`src/rust/x64/pagegen.rs`
and `pages.rs`). It compiles every mode the CPU runs: 64-bit code,
compatibility-mode code, 32-bit protected-mode code (flat or with a CS base),
16-bit protected-mode code, real-mode code and virtual-8086 code. Code that is
not compiled, or cannot be compiled safely, runs in the interpreter.

How it got here ([jit-unification-plan.md](jit-unification-plan.md)): the
legacy JIT was replaced by the IR, which had a page-granular Tier-0 and an
optimizing region pipeline (Tier-1/2: x86 lifted to a typed SSA HIR,
optimized, lowered to an owned MIR, emitted as Wasm). The x64 page tier, written
for long mode ([x86-64.md](x86-64.md)), then took over compatibility-mode code
(P7.2, default since M9), 32-bit protected-mode code (P7.3, default since M8;
IR Tier-0 was deleted in P7.5), and 16-bit, real-mode and virtual-8086 code
(P7.7, P7.8, default since M10). M11 (P7.9) deleted the region pipeline and its
runtime once the mode ledger showed that no instruction ran in it on any gate
workload. The option `ir_tier0` keeps IR Tier-0's name: it turns the page
tier's 32-bit and 16-bit code on and off (off, that code is interpreted).

## 1. Design approach

### Pages, not regions

The unit of compilation is a guest code page in one execution mode. The
interpreter accumulates execution heat per page and records the entry points
it sees; once a page is hot, the page tier discovers its basic blocks from
those entries and emits one Wasm function for them, directly from templates
(no SSA, no optimization passes). Transfers within the page stay inside the
function (a `br_table` dispatch and structured loops); transfers to another
page continue in that page's function through the shared function table (Wasm
tail calls, `x64_chaining`), also across a mode change after a far CALL, far
JMP or RETF (M11). Pages that call each other often are compiled together into
one multi-page function (spans, `x64_page_clusters`).

Within a function, the guest's registers and part of its x87 and XMM state
live in Wasm locals and EFLAGS are computed lazily, only where something reads
them or a way out of the function could observe them (`x64_exit_flags`).
State is written back before every exit and before every helper that may
observe it.

### Every fast path has explicit exit conditions

1. **Compilation performs no guest operations.** The page tier reads the
   page's bytes and the code it depends on; missing code or an unsupported
   form ends the function at that instruction. Compiling never triggers guest
   MMIO or delivers an exception.
2. **Exceptions and commits are precise.** An instruction without a template
   is *stepped*: the function writes its state back and runs the interpreter's
   implementation of that one instruction, then continues or leaves as its
   result says. Memory accesses that fail a guard (page crossing, MMIO, a code
   page, a TLB miss the inline lookup cannot serve) are *retried* in the
   interpreter from the instruction's start, so a fault is delivered once,
   with the interpreter's state.
3. **Memory fast paths need proof.** Inline lookups in the TLB check the
   permissions, the mapping and code-page conditions; everything else takes a
   slow path. Interrupts arrive only at instruction boundaries: device
   accesses that can interrupt are stepped, and delivery waits for the next
   boundary, where the activation leaves (`cpu::execution::hold_irqs`).
4. **Execution is budgeted.** Activations return to the CPU main loop at loop
   back edges once their budget is used up, so interrupts, devices and pauses
   are still handled.
5. **Code validity belongs to the runtime.** A function is keyed by its
   physical page and mode key, and publication and entry check both. Writes
   to a code page, mapping changes (CR3, INVLPG, CR0/CR4), reset and restore
   invalidate the affected functions, and table slots are reclaimed once no
   activation is running, so stale code never runs.

These constraints preserve the interpreter's semantics; they do not mean that
every combination of prefixes, modes, faults and devices has been exhausted.
Differential tests run the same programs compiled and interpreted (and against
QEMU and SDM models) to check them.

## 2. Architecture

```text
              Guest x86 code / CPU state            (ARM core: guest A64 code)
                           |                                    |
           +---------------v----------------+   +---------------v--------------+
           | CPU dispatch + interpreter     |   | A64 interpreter, run_core    |
           | page heat / observed entries   |   | block boundaries             |
           +---------------+----------------+   +---------------+--------------+
                           |                                    |
           +---------------v----------------+   +---------------v--------------+
           | x64 page tier (x64/pages.rs)   |   | A64 page tier                |
           | mode key, spans, invalidation  |   | (aarch64/jit/pages.rs)       |
           +---------------+----------------+   +---------------+--------------+
                           |                                    |
           +---------------v----------------+   +---------------v--------------+
           | x64/pagegen.rs: blocks, x86    |   | aarch64/jit/pagegen.rs:      |
           | templates, lazy flags, the     |   | A64 templates, NEON (neon.rs)|
           | write-back, jac or 32-bit TLB  |   | helper calls                 |
           +---------------+----------------+   +---------------+--------------+
                           |      (PageEmitter hooks)           |
           +---------------v------------------------------------v--------------+
           | pagegen/frame.rs (J1b): the frame, structured loops, dispatch,    |
           | access-cache lookups, chaining lookup and tail call               |
           +---------------+---------------------------------------------------+
                           |
           +---------------v---------------------------------------------------+
           | x86tpl: x86 leaves + templates (x86 only)                         |
           | wasmgen: WasmBuilder, ISA-neutral leaves                          |
           +---------------+---------------------------------------------------+
                           |
           +---------------v---------------------------------------------------+
           | jitrt (J1a, J1b): table slots, watched pages, publication          |
           | (jit_publish), slot budget, heat, page runtime, step (StepOutcome,|
           | StepAbi), access cache (TagLayout, Bus), chaining tables, jit_stat|
           +---------------+---------------------------------------------------+
                           |
            +--------------+---------------+
            |                              |
     next page / chain              exit / step / retry
            |                              |
      compiled code              CPU helpers / interpreter
                                   / main-loop safepoint
```

The x86 core (`v86.wasm`) has only the left column; the ARM core
(`v86-arm64.wasm`, [arm64-virt-android16-plan.md](arm64-virt-android16-plan.md))
only the right one, over the same jitrt and pagegen/frame.rs.

The execution modes, each with its own mode key (a function compiled for one
mode never runs in another):

| Mode | Since | Switch (default on) |
|---|---|---|
| 64-bit | x86-64 | `x64_page` |
| compatibility mode (32-bit code with LMA = 1) | P7.2, M9 | `x64_page_compat32` |
| 32-bit protected mode, flat or with a CS base; on a 16-bit stack (M11) | P7.3, M8 | `x64_page_legacy32` |
| 16-bit protected mode; on a 32-bit stack (M11) | P7.7, M10 | `x64_page_prot16` |
| real mode and virtual-8086 mode | P7.8, M10 | `x64_page_v86` |

All but 64-bit code need `ir_tier0` (default on). 32-bit and 16-bit pages
compile after `x64_legacy_heat` interpreted instructions on them; 16-bit code
in SMM stays interpreted.

The x86 forms every engine needs are generated in one place,
`src/rust/x86tpl` (P2): leaf emitters that need only a `WasmBuilder` (`vec`,
`mmx`, `x87`, `native_fp`) and templates over an engine's operands. x86tpl
names no engine (`tools/check_x86tpl_imports.mjs`, in `make jit-gate`), and
golden digests pin the leaves' output (`make jit-leaf-tests`). The ISA-neutral
leaves are in `wasmgen::leaves`, which the planned A64 engine shares.

Key code locations:

| Responsibility | Location |
|---|---|
| Encoding catalogue and the decoder tables (generated) | [gen/x86_table.js](../gen/x86_table.js), [gen/generate_decoder.js](../gen/generate_decoder.js), [decode](../src/rust/decode/) |
| The ISA-neutral runtime (J1a, J1b): table slots and their owners, watched pages and the write/reset listeners, publication, the slot budget, page heat, the generic page runtime, `jit_stat`; the single step (`StepOutcome`, `StepAbi`, `StepFrontend`), the access cache (`TagLayout`, the `Bus` extension point), the chaining tables | [jitrt](../src/rust/jitrt/); [jit.rs](../src/rust/jit.rs) is the x86 core's composition root, [aarch64/root.rs](../src/rust/aarch64/root.rs) the ARM core's |
| The page functions' neutral skeleton (J1b): frame, structured loops, page dispatch, access-cache lookups, chaining; the ISA module implements `PageEmitter` | [pagegen/frame.rs](../src/rust/pagegen/frame.rs), [pagegen/loops.rs](../src/rust/pagegen/loops.rs) |
| The page tier's runtime: when and how to compile, spans, chaining, invalidation, statistics (the client X86 of jitrt's page runtime) | [pages.rs](../src/rust/x64/pages.rs), [physical.rs](../src/rust/x64/physical.rs) |
| Analysis and emission: blocks, x86 templates, locals, flags | [pagegen.rs](../src/rust/x64/pagegen.rs), [pagegen_vec.rs](../src/rust/x64/pagegen_vec.rs) |
| The A64 page tier (J2): its runtime and code generator, jitrt's second client | [aarch64/jit](../src/rust/aarch64/jit/) |
| Inline memory access and helpers of generated code | [memory.rs](../src/rust/x64/memory.rs), [helpers.rs](../src/rust/x64/helpers.rs) |
| x86 leaf templates every engine shares | [x86tpl](../src/rust/x86tpl/), [wasmgen/leaves.rs](../src/rust/wasmgen/leaves.rs) |
| Recording and replay of compilations (test cores) | [replay.rs](../src/rust/x64/replay.rs), `tools/replay_check.mjs` |
| CPU dispatch, the mode ledger and the host bridge (`jit_publish`) | [cpu.rs](../src/rust/cpu/cpu.rs), [execution.rs](../src/rust/cpu/execution.rs), [cpu.js](../src/cpu.js) |

Common controls: `disable_jit: true` runs only the interpreter (at run time,
the export `jit_set_enabled`); `ir_tier0: false` interprets 32-bit and 16-bit
code; `jit_switches` (and `JIT_SWITCHES` in tests) sets the switches of
`src/rust/jit_switches.rs`, among them `mode_ledger` and `step_profile`
([profiling.md](profiling.md)); `get_jit_info()` shows the page tier's
statistics. `jit_backend` accepts only `"ir"`, or can be omitted. The region
pipeline's options (`ir_region_budget`, `ir_opt_level`, `ir_passes_disabled`,
`ir_verify`, `ir_dump`, `ir_stats`) are deprecated and have no effect. The
validation entry points are `make jit-gate` (before each commit) and
`make jit-gate-full` (before a default flips), which run
`x64-page-tier-tests`, `x64-legacy32-tests` and `jit-core-tests`; see the
[tests README](../tests/Readme.md).

## 3. Against the legacy JIT and the region pipeline

The legacy JIT already had in-page dispatch, registers cached in locals and
memory-access fast paths. The page tier keeps those and adds lazy flags,
structured loops, multi-page functions, chaining through the function table,
native x87, SSE, MMX and AVX templates with exact admission, and one design
for every mode.

The region pipeline offered optimizations across blocks (GVN, SCCP, DCE,
bounded LICM, guarded load reuse) at the cost of a much larger compiler. By
M10 it ran almost nothing on the gate workloads: the page tier compiled the
code first, and the profiles showed the remaining time in instruction classes
without templates rather than in missed optimizations across blocks (the same
reasoning that kept it out of long mode, [x86-64.md](x86-64.md)). Deleting it
removed 47,500 lines of Rust (`src/rust/ir`), more than the page tier,
x86tpl and wasmgen have together (32,400), and every second implementation
of an x86 form.

**Historical measurements.** `build/bench/results-t0-clusters.json`
(2026-09-26, Apple M1 Pro, Node v25.6.0, build `0d508ec2+dirty`) recorded for
the quick suite, relative to the legacy JIT, a warm geometric mean of about
**1.67×** and a cold one of about **1.35×** (warm x87, SSE and MMX about
2.69×, 2.45× and 1.69×; control flow 0.93× cold). The gates of each milestone
since are in the plan's appendix C; for how the numbers are measured see the
[CPU benchmark suite](cpu-benchmarks.md). The first `800×600×32` mode switch
in the XP test is only a display-mode milestone; game frame rates also depend
on rendering, audio and guest throttling.
