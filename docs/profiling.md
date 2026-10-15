v86 has a built-in profiler, which instruments generated code to count certain
events and types of instructions. It can be used by building with `make
debug-with-profiler` and opening debug.html?cpu_worker=0 (the CPU in the page).

For debugging networking, packet logging is available in the UI in both debug
and release builds. The resulting `traffic.hex` file can be loaded in Wireshark
using file -> import from hex -> tick direction indication, timestamp %s.%f.

## Units: retired instructions and the step share s

Every instruction count in measurements and gates is a count of **retired
instructions** (docs/jit-unification-plan.md, cross-phase rule 3): the
growth of `core_statistics_get(core, 0)`, where a REP instruction counts once
and a faulting one not at all. `instruction_counter` is only a budget
counter: steps and REP elements move it differently, and the x64
page tier adds whole blocks at their entry (`x64_block_count`, on by
default), an upper bound when a block is left early. Count long-mode work
with the mode ledger or with `x64_block_count=0` (compiled in: set it before
the code is compiled). MIPS is retired instructions per wall-clock
microsecond.

**The step share s** is the share of retired instructions that compiled code
left to the interpreter one at a time, from the mode ledger (below):

    s = (tier0_step + page_step + page_retry) / (sum of all ways)

over one mode (s of Long64, of Compat32, ...) or over all of them (s_total),
always named with its scope and measured, never estimated. Instructions the
interpreter runs outside compiled code (cold code, pages not compiled yet)
are not steps. A step costs the host far more than a compiled instruction,
so s understates the host time steps take; host time is measured with
profiles (`WIN_CPU_PROFILE`, `--profile-from`).

## The step profile: what compiled code leaves to the interpreter

The x64 page tier (and IR Tier-0 until P7.5) interprets some instructions one at a time
inside their page functions ("steps"): forms without a template, accesses
refused by the fast path, faults. The step profile counts them in one store
([`src/rust/step_profile.rs`](../src/rust/step_profile.rs)), keyed by
StepKey v1, a u32 whose fields are the opcode and its map, VEX's pp and L,
the F2/F3, 66 and REX.W prefixes, ModRM.reg for opcodes it extends (groups,
x87), a retry bit (the x64 page tier refused an access), the mode (real,
virtual-8086, 16- and 32-bit protected, 16- and 32-bit compatibility,
64-bit), the stepping tier, and an ISA field (x86 is 0; A64 is to use it).
The source file has the exact layout.

It is off by default: on, every step decodes its instruction into a hash
table. Turn it on with the JIT switch `step_profile` (`JIT_SWITCHES=step_profile=1`,
the V86 option `jit_switches`, or `set_jit_switches` from
[`src/jit_switches.js`](../src/jit_switches.js)) and read it with
`step_profile()` from [`tools/step_profile.mjs`](../tools/step_profile.mjs),
which also names keys (`"prot32 tier0 0F A2"`). The exports:
`step_profile_snapshot()` sorts it and returns the number of keys,
`step_profile_key(i)` and `step_profile_count(i)` read entry `i`,
`step_profile_get(key)` one key, `step_profile_reset()` empties it.
For each key it also keeps a sample, the last stepped instruction's
linear address and first 8 bytes (`step_profile_sample(i, 0)`, and its
bytes in words 1 and 2): what a key's steps were, such as a template's
refused access or a page function entered in another state, which
`step_profile()` adds to its rows as `sample`.

- `tests/bench/run.mjs --fallbacks` turns it on for one more round of each
  benchmark, which is not timed, and prints the most stepped keys.
- `JIT_STATS=1` records (tools/bench/jit_stats.mjs) carry the 40 most
  stepped keys while it is on.
- The x64 page tier's earlier interface reads the same store:
  `x64_page_profile(1)` turns it on, `x64_page_profile_get(key)` sums it by
  the old key (bits 0-17 of StepKey), as `WIN_STEP_PROFILE` and
  `X64_STEP_PROFILE` in the Windows and Linux harnesses print it.
- `x64_page_steps(pair)` counts the steps and retries since
  `x64_page_steps_reset()` (which turns the profile on) by their first two
  bytes, little-endian, prefixes included, which tests read (IR Tier-0's
  `ir_t0_steps` before P7.5).

### Events

While it is on, the store also counts events that are not steps, under the
stepper `event` (StepKey bits 28-29 = 2): bits 0-7 are the event, 8-15 its
detail, 25-27 the mode, the rest 0 (`step_profile::event` lists them,
`tools/step_profile.mjs` names them, as in `"long64 event exit retry"`).

| Event | Detail | Counted |
| --- | --- | --- |
| `miss` | `disabled`, `no-code`, `cold`, `compiling`, `compile`, `recompile`, `unserved`, `shadow`, `trap-flags`, `breakpoints`, `events`, `halt` | each time the x64 page tier did not run a function at RIP (`compile`, `recompile`: it compiled instead; `unserved`: it ran one entered at an offset it does not serve; `shadow` ... `halt`: what it may not run code in: an interrupt shadow, TF or RF, DR7 breakpoints, core events or an NMI or SMI pending, HLT; `disabled`: the tier or the JIT off) |
| `exit` | `retry`, `unknown`, `step`, `budget`, `leave` | why a page function of the x64 page tier returned |
| `step-exit` | `halt`, `yield`, `shadow`, `core-event`, `code-write`, `irq`, `nmi`, `barrier`, `chainable` | why a step ended its activation (`x64_page_step`); `chainable`: only the CPL, CS, CR3, the epoch, IF, IOPL or AC changed, after which P4.3's STEP_CHAIN may continue; `barrier`: the mode, CR0, CR4, EFER, DR7, TF, VM or RF changed |
| `step-context` | `cpl` ... `epoch` | each part of the context such a step changed |
| `starved` | | a long-mode frame while IR Tier-0 had pages ready to compile (WOW64's code waits for a compatibility-mode slice; P4.6) |
| `frame` | | each CPU frame (`main_loop`), `starved`'s denominator (none since M11, which deleted the region scheduler's `begin_cpu_frame`) |
| `#NM`, `CLTS`, `CR0.TS` | | #NM delivered, CLTS, a MOV to CR0 (or LMSW) that changed TS: lazy FPU switching |
| `fxstate` | `FXSAVE`, `FXRSTOR`, `XSAVE`, `XRSTOR` | the instructions (XSAVE: XSAVE, XSAVEOPT, XSAVEC, XSAVES; XRSTOR: XRSTOR, XRSTORS) |
| `hpet-read` | | reads of the HPET's registers (one per 32-bit access, a byte read each byte) |
| `pm-timer-read` | | reads of the ACPI PM timer (offset 8 of the PM block) |

The instruction and device events count in every tier (the interpreter's
code counts them); `miss`, `exit`, `step-exit` and `step-context` are the
x64 page tier's. `tests/x64/step_events.mjs` checks them on
`tests/x64/system_bench.mjs`'s guests. The Windows probe prints
QueryPerformanceFrequency (`qpf` in `X64_WIN_BEGIN`; the harness's report
names the source: 14318180 Hz the HPET, 3579545 Hz the PM timer, else the TSC).

### What one event costs: tests/x64/system_bench.mjs

`system_bench.mjs` times a long-mode loop of one event against the same loop
with a NOP, by the guest's RDTSC (v86's TSC counts host nanoseconds; the
loop's page is compiled in a first, untimed pass): steps that continue
(CPUID, POPFQ), a step that ends its activation (POPFQ toggling AC: less
POPFQ, what the exit adds), a retry (a load crossing a page), IRETQ,
SYSCALL with SYSRETQ, IN from port 80h, an HPET read, FXSAVE with FXRSTOR,
MOV CR3, MOV CR0 setting TS with CLTS, lazy FPU switching (TS, #NM, CLTS,
IRETQ), RDTSC; and per instruction, code outside compiled code:
interpreted with the x64 page tier off, and cold (every instruction a miss).
With `--events` it prints each guest's StepKeys and events per iteration
instead. Release build, 2026-10-10, Apple M1 Pro, ns per event (runs differ
by up to about 15%):

| CPUID | POPFQ | POPFQ, AC toggled | retry | IRETQ | SYSCALL+SYSRETQ | IN | HPET read | FXSAVE+FXRSTOR | MOV CR3 | CR0.TS+CLTS | #NM round trip | RDTSC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 66 | 86 | 147 | 149 | 206 | 362 | 174 | 325 | 3892 | 180 | 219 | 880 | 52 |

Per instruction: interpreted 52 ns, cold (a miss each) 70 ns. These are the
costs before M4 (P4.1 ranked with them); with P4.5's switches (on since) a cold
instruction costs about 58 ns and an STI window (`sti`: STI, NOP in its shadow,
CLI) 8 ns instead of 96.
`tools/bench/step_rank.mjs` ranks a workload's classes with these costs
(docs/jit-unification-plan.md P4.1).

```sh
TEST_RELEASE_BUILD=1 node tests/x64/system_bench.mjs [iterations] [rounds] [event...]
TEST_RELEASE_BUILD=1 node tests/x64/system_bench.mjs --events [iterations] [event...]
```

## The mode ledger: retired instructions by mode and engine

The JIT switch `mode_ledger` (off by default) counts retired instructions
(the definition of `core_statistics_get(core, 0)`: a REP instruction once, a
faulting one not at all) by mode (`x64::state::ExecutionMode`: real,
virtual-8086, 16- and 32-bit protected, 16- and 32-bit compatibility,
64-bit), by whether 32-bit code ran with flat segments, and by how they ran:
`interpreted` (outside compiled code), `tier0_native` and `tier0_step` (IR
Tier-0's, none since P7.5), `region_native` (the IR regions', none since M11),
`page_native`, `page_step` and `page_retry`. While it is on,
its sum grows exactly as the retired count does
(`tests/ir/differential/tier0_mode_ledger.mjs`, `tests/x64/mode_ledger.mjs`).
Each count goes to the mode its run started in: an interpreted run of
instructions, an activation of compiled code (which leaves when the mode
changes: with the ledger on, a far transfer to code of another mode leaves
instead of chaining to it, M11) or one step.

`mode_ledger(exports)` in [`tools/bench/jit_stats.mjs`](../tools/bench/jit_stats.mjs)
reads it as `{ mode: { way: retired } }`, flat 32-bit code under
`"<mode>.flat"`; `JIT_STATS=1` records carry it while it is on, and
`mode_ledger_reset()` empties it. The count is per Wasm instance: with cores
in workers, each worker has its own.

## The template-kind profile (until P7.5)

IR Tier-0 counted what its code executed, by template kind, with the JIT
switch `t0_kind_profile` (P3.0a's measure for ranking its template changes);
it went with Tier-0 in [jit-unification-plan.md](jit-unification-plan.md)
P7.5. The step profile above and the mode ledger below cover the page tier.

## The code of a page function: tools/page_code.mjs

What a page function costs is easiest to see in the host code V8 makes of
it. [`tools/page_code.mjs`](../tools/page_code.mjs) runs a benchmark on the
test core (`build/v86-ir-test-release.wasm`, ir-test-hooks), records what the
x64 page tier compiles (`--isa i686` its legacy-mode code, IR Tier-0's until P7.5), takes the last record
whose page holds the given instruction bytes and replays it at
`tools/replay_check.mjs`' fixed pseudo addresses:

    node tools/page_code.mjs 560.hash "c1 c8 06" --switches x64_i32_ops=1 --machine

prints the ARM64 (or x64) code of TurboFan (`node --no-liftoff
--print-wasm-code`); without `--machine` it prints the module's Wasm, and
`--save` keeps the module. M5's code quality steps (jit-unification-plan.md
P4.20–P4.23) came from comparing this for the page tier and Tier-0 on the
same-source benchmarks.

Where the time goes inside such a function, per host instruction:
[`tools/page_profile.mjs`](../tools/page_profile.mjs) runs the benchmark the
same way under V8's sampling profiler (`node --prof`, a tick every 50 µs),
saves the last module whose page holds the bytes, prints that module's
TurboFan code and the ticks that fell in the optimized function of the same
size (the replayed module is the one that ran when the sizes agree):

    node tools/page_profile.mjs 557.lz "0f b6 9c 28 00 50 45 00" --isa compat32 --min 50

Samples land on the instruction that waits (a load's consumer, a spill
reload), a few instructions after a mispredicted branch. With `--isa i686`
the same for the page's legacy-mode function. Two experiments with it decided
M6's lookups (jit-unification-plan.md appendix C): a throwaway build whose
host address is mem8 plus the linear address (the benchmarks' identity
mapping only) gives the cost of everything but the lookups, on each engine.

What the code costs V8 to compile matters as much while Windows boots: a
page function first runs as Liftoff code, and only the ones V8 finds hot are
compiled again by TurboFan, on background threads. When that work grows,
functions stay longer in Liftoff code, and the guest runs slower although
each function is better code. [`tools/compile_cost.mjs`](../tools/compile_cost.mjs)
measures it per JIT switch: the records of real compilations
(`tools/replay_record.mjs` for the benchmarks; for a Windows boot
`WIN_RECORD=<file>` of `tests/x64/windows_boot.mjs` with
`WASM_PATH=build/v86-ir-test-release.wasm`) are replayed with each switch's
bits set, and each configuration's modules are compiled on one thread with
Liftoff and with TurboFan:

    node tools/compile_cost.mjs build/bench/win.x6r --stride 8

The V8 flag `--trace-wasm-compilation-times` (one line per compiled
function, both tiers) shows the same in a running boot.

## A/B arms: one core per setting

`tests/bench/run.mjs` compares two settings of one core in one process
(`--switches-a`, `--switches-b`). The whole-machine measurements take one
setting per process, so an A/B there compares two cores: build the second
with the setting as its build-time default (`JIT_DEFAULTS`, the switch
registry's defaults) next to the others in `build/bench/arms`,

    make jit-arm ARM=no-legacy32 JIT_DEFAULTS="x64_page_legacy32=0"

(its own cargo target directory, so `build/v86.wasm` stays as it is), and
give both to the runner: `tools/owner_perf.mjs --arms
build/v86.wasm,build/bench/arms/t0-kinds.wasm` (XP, Windows 8.1, CPULOAD32,
Windows 98 states and boot, sessions alternating the arms),
`tests/x64/windows_boot.mjs` with `WASM_PATH`, or `tests/bench/run.mjs
--wasm ... --baseline ...`. `tests/bench/gate.mjs` judges the results by
the levels of the plan's cross-phase rule 2.

## Windows guests in node (tests/x64/windows_boot.mjs)

The Windows harness can measure a running program from a saved state, so a
scene is profiled again and again without booting:

- `savestate <file>` (a line in `<out>/command.txt`) streams the machine to
  `<file>.state` (with a 3D renderer the GPU's contents are in it; such a state
  passes 4 GiB, so it is written with `save_state_stream`), the disk overlays to
  `<file>.hda.ovl` and `<file>.hdb.ovl`, and the harness's own state to
  `<file>.json`. `WIN_STATE_LOAD=<file>` starts from there instead of booting
  (with the same `WIN_*` machine settings).
- `WIN_RATES=<s>`: every `<s>` seconds an `svga3d-rates` event with the SVGA3D
  commands per second, the frames (screen target updates) per second, the
  guest's MIPS (all cores), how often core 0 was halted, and the renderer's
  backlog. The remote renderer page logs `renderer-stats` (batches, bytes,
  latency from arrival to done) every 10 s.
- `WIN_CPU_PROFILE=<s>`: host CPU profiles, one per window; after each, an
  `X64_WIN_PROFILE_MODULES` line gives the generated code's share by guest
  module (page functions are named by linear page: `x64_page_<page>`; IR
  Tier-0's compatibility-mode ones were `t0_<page>` until P7.5).
- `x64_page_stat` counters (in `X64_WIN_PROGRESS`): control register writes
  by register and full flushes, page walks, and the 32-bit TLB fills of
  compatibility mode and refills of pages it had already. A high refill count
  means some path translates although the TLB could answer.
- `WIN_SHOT_MS`: the screenshot interval (a 1280x1024 PNG every 2 s costs the
  host a few per cent).
- JIT statistics records (`JIT_STATS=1`, tools/bench/jit_stats.mjs): one at the
  desktop and one at the end (`phase` "desktop", "end"), and one for each
  `jitstats <phase>` line in `command.txt`; `JIT_STATS_STEPS=<n>` keeps n step
  profile rows. Each carries the cores' host runtime (`runtime_ms`).
  `tools/bench/step_rank.mjs <counts log> <time log>` ranks what 64-bit code
  leaves compiled code for from two runs of one workload, the step profile on
  in the first (`--counts-window`/`--time-window t120,t210`: the difference of
  two records; docs/jit-unification-plan.md P4.1).

Use the release build (`TEST_RELEASE_BUILD=1`): the source tree runs the debug
wasm. Runs from one state differ by about 10% in frames per second; compare
several of each.

The harness itself costs the host about 5–8%: screenshots, logs, and the
WebSocket channel to the renderer page in headless Chrome
([`tests/x64/gpu_remote_renderer.mjs`](../tests/x64/gpu_remote_renderer.mjs);
3DMark06 on Windows 8.1, 2026-10-02). A browser page has none of it, so node
runs understate what a page reaches by about that much.
