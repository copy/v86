# v86 IR: design, architecture, and comparison with the legacy JIT

This is the consolidated description of the IR, written against the current
source. **The IR is now the only JIT**; the legacy JIT's analyzer and code
generator have been removed. 32-bit protected-mode and compatibility-mode
code is compiled by the x64 page tier ([x86-64.md](x86-64.md),
[jit-unification-plan.md](jit-unification-plan.md) P7.3), which replaced IR
Tier-0 (deleted in P7.5; `ir_tier0`, the option's name, now turns the page
tier's 32-bit code on and off). Code that is not compiled,
or cannot be compiled safely, still runs in the interpreter. The earlier design,
instruction-topic, implementation-progress, and review documents have been
merged into this one; the coverage catalogue and raw measurement data are kept.

## 1. Design approach

### Two compilation paths for startup speed and optimization

- **Tier-0 page compilation** (until P7.5; the x64 page tier compiles that
  code now): accumulated interpreter execution heat per code page, discovered
  basic blocks from observed entry points, and emitted Wasm directly from
  templates, without SSA or the region optimization pipeline.
- **Tier-1/2 region compilation**: lifts x86 instructions into an explicit
  intermediate representation, then optimizes it and lowers it to Wasm. Tier-1
  uses cheap canonicalization and state pruning; Tier-2 adds cross-block value
  reuse, constant propagation, loop optimizations, and guarded memory-access
  optimizations.
- **Interpreter fallback**: cold code, missing entries, and paths that do not
  meet the compilation conditions keep running in the interpreter. Instructions
  without a native template run through a single-step helper, and the
  returned status decides whether to continue or exit.

By default, the x64 page tier does most of the work; 16-bit code, and entries
that it cannot run (a 16-bit stack, a CS base other than 0), go to the region
compiler. Set `ir_tier0: false` to use the region pipeline for 32-bit code
too. **There is no automatic page tier → Tier-1 → Tier-2 tier-up chain**; the
region pipeline keeps its own Tier-1 → Tier-2 tier-up. (The rest of this
document still describes IR Tier-0 where it names it: the code as it was
before P7.5.)

### Semantics, optimization, and machine code generation stay separate

The region pipeline's core representations are:

- **HIR (high-level IR)**: expresses computation with typed SSA values, block
  parameters, and a CFG. It handles register aliases such as AL/AH/AX, FLAGS
  sources, and XMM values explicitly. Pure computation is kept apart from
  operations with side effects, which makes it easy to tell which values can be
  folded, reused, or deleted.
- **Effects and StateMaps**: Effects order operations such as memory accesses,
  helper calls, and I/O. A StateMap records the registers, FLAGS, EIP, and
  instruction-commit progress to restore at an observation point, fault point,
  or exit. Values needed at recovery points take part in liveness analysis, so
  optimization cannot delete them by mistake.
- **MIR (machine IR)**: a self-contained representation that owns its value
  expressions, typed locals, edge copies, control flow, memory accesses, helper
  calls, and state materialization plans. The HIR can be freed once lowering
  finishes; the Wasm backend consumes MIR without looking back at x86
  instructions or calling the old code generator.

Tier-0 uses a different, cheaper state model: GPRs, XMM registers, and part of
the x87 state are cached in Wasm locals, and FLAGS are computed and written
back lazily. The cached state is synchronized before an exit or a slow path that
may observe CPU state. Both pipelines share the decoding rules, the CPU semantic
helpers, and the runtime publication machinery.

### Every fast path has explicit exit conditions

1. **Compilation performs no guest operations.** The frontend reads an
   immutable code snapshot and distinguishes the logical EIP, the linear
   address, and the physical pages the code depends on. Missing code, an
   exhausted budget, or an unsupported form ends that compilation; compiling
   never triggers guest MMIO or delivers an exception.
2. **Exceptions and commits are precise.** Memory/RMW, stack, and REP
   operations preserve fault order and partial-completion progress. Helpers
   declare which state they read and write, what they return, and who owns any
   exception. After a normal return, state is reloaded as the contract
   specifies; after a control transfer, the CPU state is authoritative, so an
   exception is never delivered twice and stale state is never restored.
3. **Memory optimizations need proof.** The RAM fast path checks the TLB,
   permissions, the mapping, and code-page conditions; page-crossing accesses,
   MMIO, code writes, and anything else that fails a guard take a slow path or
   go to the interpreter. Load reuse, store-to-load forwarding, and loop
   caching hold only within what has been proven. Interrupts arrive only at
   instruction boundaries: Tier-0 leaves accesses to devices that can
   interrupt (the APIC, the IOAPIC, PCI memory BARs) to the single-step
   helper, and holds delivery during its other slow-path accesses and single
   steps until the next boundary, where the activation leaves
   (`cpu::execution::hold_irqs`).
4. **Compilation and execution are both budgeted.** Region size, optimization
   work, compile timing, and execution batches are all bounded. Safepoints hand
   control back to the CPU main loop so that interrupts, devices, and pauses
   still get handled. The HIR/MIR verifiers check types, dominance, edge
   arguments, state recovery, and machine-plan constraints.
5. **Code validity belongs to the runtime.** Publication and execution check
   the entry mode, address mapping, code dependencies, and owner/generation.
   Code writes, mapping changes, and reset/restore invalidate the affected
   artifacts, and table slots are reclaimed once no execution frame is active,
   so stale code never runs.

These constraints exist to preserve the existing CPU semantics. A coverage
catalogue with no Pending entries does not mean that every x86 behavior beyond
the baseline is implemented, nor that every combination of prefixes, modes,
faults, and devices has been exhausted.

## 2. Current architecture

```text
                         Guest x86 code / CPU state
                                      |
                      +---------------v----------------+
                      | CPU dispatch + interpreter     |
                      | execution heat / observed PCs  |
                      +---------------+----------------+
                                      |
                      +---------------v----------------+
                      | Scheduler + immutable snapshot |
                      | mode key / code dependencies   |
                      +---------------+----------------+
                                      |
                            Shared x86 decoder
                                      |
                 +--------------------+--------------------+
                 |                                         |
   +-------------v----------------+       +----------------v-----------------+
   | Tier-0: page / multi-page    |       | Tier-1 / Tier-2: region compiler |
   | CFG discovery + templates    |       | CFG -> typed SSA HIR             |
   | integer, x87, SSE, MMX, REP  |       | effects + StateMaps + helpers    |
   | local state cache            |       +----------------+-----------------+
   | br_table / structured loops  |                        |
   +-------------+----------------+       +----------------v-----------------+
                 |                        | Bounded HIR passes               |
                 |                        | lower -> owned MIR -> optimize   |
                 |                        | locals / control / state plans   |
                 |                        +----------------+-----------------+
                 |                                         |
                 +--------------------+--------------------+
                                      |
                      +---------------v----------------+
                      | x86tpl: x86 leaves + templates |
                      | shared with the x64 page tier  |
                      +---------------+----------------+
                                      |
                      +---------------v----------------+
                      | Wasm emission / WasmBuilder    |
                      +---------------+----------------+
                                      |
                      +---------------v----------------+
                      | Host instantiate + publication |
                      | shared table / cache / owners  |
                      +---------------+----------------+
                                      |
                      +---------------v----------------+
                      | Admission + compiled execution |
                      | page / region linking          |
                      +---------------+----------------+
                                      |
                       +--------------+---------------+
                       |                              |
                valid next entry              exit / slow path
                       |                              |
                 compiled code              CPU helpers / interpreter
                                              / main-loop safepoint
```

Tier-0, the region backend and the x64 page tier generate the x86 forms they
share from one place, `src/rust/x86tpl` ([jit-unification-plan.md](jit-unification-plan.md)
P2): leaf emitters that need only a `WasmBuilder` (`vec`, `mmx`, `x87`,
`native_fp`), and templates over an engine's operands (`ops::VecOperands`: how
the engine reads and writes registers and memory, retries, and runs a refused
instruction exactly). x86tpl names none of the engines;
`tools/check_x86tpl_imports.mjs` checks that in `make jit-gate`, and golden
digests pin the leaves' output (`make jit-leaf-tests`).

Tier-0 transfers within a page or cluster stay inside the generated function;
for targets outside the cluster, a runtime linking loop looks up the next
function. Page functions can also be packed in batches into a shared Wasm
instance, which reduces cross-instance calls. The region backend uses structured
control flow and keeps a dispatcher path for CFGs that cannot be structured.
Both compilation paths share the same publication, invalidation, and table-slot
management.

Key code locations:

| Responsibility | Location |
|---|---|
| Encoding catalogue and shared decoder | [gen/x86_table.js](../gen/x86_table.js), [frontend](../src/rust/ir/frontend/) |
| The page tier's analysis, templates, and multi-page functions (IR Tier-0's until P7.5) | [x64](../src/rust/x64/): pagegen.rs, pages.rs, loops.rs |
| x86 leaf templates every engine shares: packed operations, SSE arithmetic, conversions and their exact admission, MMX, the inlined x87 | [x86tpl](../src/rust/x86tpl/), with the ISA-neutral v128 leaves in [wasmgen/leaves.rs](../src/rust/wasmgen/leaves.rs) |
| HIR, state, and optimization | [hir.rs](../src/rust/ir/hir.rs), [state.rs](../src/rust/ir/state.rs), [passes](../src/rust/ir/passes/) |
| Lowering, MIR, and the Wasm backend | [lowering.rs](../src/rust/ir/lowering.rs), [mir.rs](../src/rust/ir/mir.rs), [backend/wasm](../src/rust/ir/backend/wasm/) |
| Heat, compilation, admission, and caching | [schedule.rs](../src/rust/ir/runtime/schedule.rs), [compile.rs](../src/rust/ir/runtime/compile.rs), [cache.rs](../src/rust/ir/runtime/cache.rs) |
| CPU dispatch, slots, and the host bridge | [cpu.rs](../src/rust/cpu/cpu.rs), [jit.rs](../src/rust/jit.rs), [cpu.js](../src/cpu.js) |

Common controls: `disable_jit: true` runs only the interpreter; `ir_opt_level`
and `ir_passes_disabled` control region optimization; `get_jit_info()` shows
scheduler and cache statistics; `ir_dump` and `get_ir_dumps()` show region
HIR/MIR/Wasm. `jit_backend` accepts only `"ir"`, or can be omitted. The
validation entry points are `make ir-tests`, `make x64-legacy32-tests`, and
`make ir-generated-check`; for targeted tests see the
[tests README](../tests/Readme.md), and for the coverage catalogue see
[ir-coverage.json](../src/rust/ir/frontend/ir-coverage.json).

## 3. Advantages over the legacy JIT

The legacy JIT already had in-page dispatch, registers cached in locals, and
memory-access fast paths. The IR keeps these low-cost execution techniques and
adds clearer compiler layering, a representation that can express stronger
optimizations, and a unified runtime:

| Aspect | Legacy JIT | Current IR |
|---|---|---|
| Compiler structure | Instruction analysis tightly coupled to direct Wasm emission; optimizations scattered through per-instruction code generation | The region pipeline separates decoding, semantics, optimization, lowering, and emission into layers; Tier-0 handles low-cost page compilation on its own |
| Optimization scope | Mainly instruction templates, local specialization, and control-flow layout | Explicit SSA enables cross-block GVN, SCCP, DCE, FLAGS liveness, state-writeback pruning, bounded LICM, and guarded RAM reuse |
| Cold/hot trade-off | Relies mainly on the direct compilation path and its local optimizations | Tier-0 quickly covers observed code; region Tier-1/2 offers a separate optimizing path, so page compilation does not have to build full SSA |
| Floating-point and vector hot spots | Heavy reliance on CPU helpers and state in memory | Native Tier-0 paths for common x87 forms, register-only x87 runs, and Wasm SIMD templates cut calls and state movement; special values and cases that fail a guard fall back |
| Cross-page execution | In-page dispatch and some contiguous multi-page modules | Forms clusters, including non-contiguous pages, from actual transfer heat, and supports page-function linking and shared-instance packing, cutting the cost of frequent returns to the outer dispatcher |
| Correctness and evolution | Semantic, recovery, and emission constraints largely maintained separately by each code-generation path | HIR/MIR, Effects, StateMaps, the helper ABI, and the verifiers make the constraints explicit, which makes differential testing, disabling individual passes, and locating problems easier |

**Historical measurements support the performance gains, but not every workload
is guaranteed to be faster.** The locally saved
`build/bench/results-t0-clusters.json` (2026-09-26, Apple M1 Pro, Node v25.6.0,
historical build `0d508ec2+dirty`) records, for the quick suite relative to the
legacy JIT, a warm geometric mean of about **1.67×** and a cold one of about
**1.35×**; the warm x87, SSE, and MMX categories were about 2.69×, 2.45×, and
1.69×. In the same batch, the control-flow category was only about 0.93× cold,
which shows that cold compilation and the working set still affect the gains.
These are historical samples from 3 warm runs and 1 cold run, and the
performance acceptance run was not repeated for this documentation merge. For
how the numbers are measured, see the [CPU benchmark suite](cpu-benchmarks.md).

Judging real gains means looking at correctness on identical guest work,
cold-start compilation cost, hot-code throughput, and application performance
together. The first `800×600×32` mode switch in the XP test is only a
display-mode milestone; game frame rates also depend on rendering, audio, and
guest throttling, and cannot be attributed directly to the JIT.
