# v86 CPU benchmark suite

A SPEC CPU 2017-style suite for comparing IR cores (a build against a baseline
build) on identical guest work. Every benchmark is a freestanding 32-bit program that
runs under a small benchmark BIOS (flat protected mode, 4 KiB paging over
64 MiB, x87/SSE enabled, interrupts off). Nothing else runs in the guest, so
the timings measure CPU emulation only.

## Running

```sh
make bench-build                      # build/bench/*.exe (needs nasm, i686-w64-mingw32-gcc)
make bench                            # full run: 5 warm runs, 3 cold samples per arm
make bench-quick                      # half-size work, 3 warm runs, 1 cold sample
node tests/bench/run.mjs --filter 'x87|sse' --runs 7
node tests/bench/run.mjs --baseline build/older-ir.wasm   # reference arm: another core
node tests/bench/run.mjs --xp windowsxp.img --xp-runs 3   # add the XP boot benchmark
node tests/bench/run.mjs --ir-setup ir_auto_set_page_threshold=2  # call IR exports after boot, on every arm
node tests/bench/report.mjs build/bench/results-new.json build/bench/results-old.json
node tests/bench/run.mjs --fallbacks                       # the instructions the JITs step (one more round, not timed)
node tests/bench/run.mjs --switches-a ir_fusion=1 --switches-b ir_fusion=0   # two JIT configurations of one core
node tests/bench/compare.mjs --switches-a x64_outline=0 --sessions 3 --level R  # sessions, then the gate
node tests/bench/gate.mjs --level R --retest retest.json session1.json session2.json session3.json  # --retest may repeat
JIT_STATS=1 node tests/bench/run.mjs --filter 708   # add a JIT statistics record per benchmark and arm
```

`BENCH_ARGS` passes options through the make targets. Results are written to
`build/bench/results-<date>.json` (or `--out`), including the host load, the
git revision and every raw sample.

## Method

For each benchmark and arm (the core under test, `ir`, and the optional
`--baseline` core; both in the default IR configuration, Tier-0 on):

- **cold**: the first run in a fresh VM. This includes JIT discovery,
  compilation and early interpretation, so it reflects short-lived code.
- **warm**: the median of timed runs after warm-up. Warm-up repeats the run
  until two consecutive timings of every arm agree within 5%.
- Arms are interleaved (ABBA order) to spread host-load drift evenly.
- Writable sections are restored and the CPU/FPU state is reset before every
  run, so every run executes the same instructions. All arms must report the
  same checksum and the same retired-instruction count; any difference is an
  error, not a timing.

The ratio is `baseline time / arm time`: above 1 means faster than the
baseline core. Without `--baseline` only MIPS are reported. The suite score is
the geometric mean of the ratios, reported overall and per category, for warm
and cold runs separately. Result files recorded before IR became the only
backend carry a `legacy` arm instead; `report.mjs` uses it as their reference. MIPS are retired guest
instructions per second (a REP string instruction counts once).

## Gates and comparisons

The gates of [jit-unification-plan.md](jit-unification-plan.md) (cross-phase
rule 2) judge the medians of several sessions, never one session: a quick
session moves single benchmarks by 5–15% even between identical cores.

- `tests/bench/gate.mjs --level R|F|S|D session.json...` takes each
  benchmark's median warm ratio over the sessions and applies the level's
  thresholds (R: suite geometric mean ≥ 0.99, each ≥ 0.97; F: each `--target`
  ≥ 1.05, suite ≥ 1.00; S: the same-source members ≥ 1.00, each ≥ 0.85; D:
  suite ≥ 1.00, each ≥ 0.95). For R it prints the `--runs 7` retest of the
  benchmarks below 0.97, with `--scale 4` when their runs last under 40 ms
  (a millisecond is 5–10% of a quick run of the shortest ones);
  `--retest file.json` puts the retest's ratios in their place (repeated,
  the last file with a benchmark counts). `--aa` reports the noise of
  sessions that ran one core against itself.
- `tests/bench/compare.mjs` runs `--sessions` sessions of two JIT switch
  configurations (`--switches-a`, `--switches-b`) of one core and gates them;
  `--aa` measures the noise first.
- JIT switches (`src/rust/jit_switches.rs`) are set by name: the runner's
  `--switches-a/--switches-b`, the environment's `JIT_SWITCHES=name=value,...`
  for every arm, and the V86 option `jit_switches`. `JIT_DEFAULTS=... make`
  builds a core with other defaults.
- `JIT_STATS=1` adds a record of `tools/bench/jit_stats.mjs` to each
  benchmark's arm: the switches, the retired instructions (the counter of
  `core_statistics_get`), the x64 page tier's and IR's counters. The XP boot
  script prints the same record as a `JIT_STATS` line.

## Benchmarks

| id | category | shape |
|---|---|---|
| 500.bytecode | int | perlbench-like switch-dispatched bytecode interpreter |
| 502.codebloat | int | gcc-like: 600 generated functions, large code footprint |
| 505.chase | memory | mcf-like pointer chasing over a 2 MiB permuted list and a tree |
| 520.vcall | control | omnetpp-like event queue with vtable dispatch |
| 523.strings | int | xalancbmk-like tokenizing, hashing, string compares |
| 531.bitboard | int | deepsjeng-like 64-bit bitboards on a 32-bit CPU |
| 541.recursion | control | leela-like recursion: n-queens, fib, ackermann |
| 557.lz | int | xz-like LZ77 compress/decompress round trip |
| 560.hash | int | SHA-256, table CRC-32, Adler-32 |
| 561.sort | int | quicksort through a comparator pointer, merge |
| 562.muldiv | int | 32/64-bit multiply/divide, libgcc 64-bit division |
| 563.memops | memory | REP MOVS/STOS copies and fills, memmove |
| 600/601.matmul | x87 / sse | float 4x4 matrices and vertex transforms (same source) |
| 605/606.nbody | x87 / sse | double n-body with sqrt/div |
| 610/611.mandel | x87 / sse | Mandelbrot escape loop |
| 615.ftol | x87 | float/int conversions (FNSTCW/FLDCW/FISTP, FILD) |
| 616.fcompare | x87 | i586 float branches (FCOMP, FNSTSW AX, SAHF) |
| 617.trig | x87 | FSIN/FCOS/FPATAN/FSQRT/FRNDINT |
| 620.simd.sse | sse | packed float transforms, RSQRTPS |
| 621.simd.int | sse | SSE2 packed integer image processing, PSADBW |
| 625.mmx | mmx | MMX pixel blending with EMMS |
| 700-711 | micro | one dimension each: ALU, branches, CALL/RET, indirect calls, jump tables, stack, loads/stores, RMW, cross-page code, self-modifying code, REP strings, x87 stack |
| 900.xpboot | system | Windows XP boot to desktop, synchronous disk (`--xp`) |

C kernels are compiled by MinGW-w64 GCC with era-appropriate profiles (see
`tests/bench/suite.json`): integer code for i686 without SSE, x87 code with
`-mfpmath=387`, an i586 profile without FCOMI/CMOV, SSE2 and MMX. The micro
benchmarks are nasm sources. Adding a benchmark means adding a source file and
one line in `suite.json`; `iterations` should give a warm run of about
250 ms.

## x86-64 builds and the same-source comparison

With the MinGW-w64 x86-64 toolchain (`x86_64-w64-mingw32-gcc`), the build
also compiles every C benchmark whose profile has an entry in `suite.json`'s
`profiles64` as a PE32+ image linked at 0x400000 (`build/bench/x86_64/`,
`image64` in the manifest): all but `616.fcompare` (i586) and `625.mmx`, and
none of the nasm micro benchmarks. The 64-bit profiles tune for nocona
(pentium4's counterpart); the integer one uses no SSE registers and no
vectorization, as the i686 one. The i686 images do not change.

`tests/bench/lib/long_mode.asm` (`build/bench/long_mode.bin`, a multiboot
kernel) enters 64-bit mode with the first GiB identity mapped by 2 MiB pages
(`long_mode_4k.bin`: the first 64 MiB in 4 KiB pages), enables x87/SSE and,
when CPUID reports them, XSAVE and AVX, installs 64-bit exception stubs and
halts in 64-bit mode; `crt0_64.asm` is the Win64 entry, with the parameter
block of the i686 one (the faulting RIP is the qword at `0x60C`).

```sh
node tests/bench/run.mjs --isa x86_64 --quick              # the x86-64 builds on the x64 page tier
node tests/bench/run.mjs --isa x86_64 --small-pages        # booted with 4 KiB pages
node tests/bench/run.mjs --isa x86_64 --interpreter        # with a reference arm without JIT
node tests/bench/run.mjs --isa compat32 --quick            # the i686 images in compatibility mode (WOW64-like)
make bench-same-source                                      # i686 on Tier-0 against x86-64 on the page tier, then the S gate
```

`--isa compat32` boots `long_mode_compat.bin`, the same long-mode setup that
halts in the 32-bit code segment instead, and runs the i686 images there:
32-bit code under 64-bit paging and a 64-bit IDT, as WOW64 runs it (Tier-0
with `x64_compat_jit`, the default, or the interpreter with
`--switches-b x64_compat_jit=0`).

`--same-source` makes the arm the x86-64 build and the baseline the i686 build
of the same source, alternating as usual, so a ratio above 1 means the page
tier ran the x86-64 code faster than Tier-0 ran the i686 code. Each row also
gets the ratios `gate.mjs --level S` selects its members by, x86-64 over
i686: `instruction_ratio`, the retired instructions (cross-phase rule 3) of
one more round, the x86-64 one in a fresh machine without the page tier's
block counts, which overstate when a block is left early; `data_ratio`, the
writable sections' size (1 when neither has any); and the x86-64 build's
share of stepped instructions. Checksums are compared only between arms of
one ISA: x87 code is strict in 64-bit mode and fast in 32-bit mode.

## Layout

- `tests/bench/lib/boot.asm` benchmark BIOS; `crt0.asm` entry and parameter
  block (`0x600` iterations, `0x604` checksum, `0x608` status, `0x60C` fault
  EIP); `rt.c` freestanding string routines in REP form; `bench.h` helpers;
  `long_mode.asm` and `crt0_64.asm` for the x86-64 builds.
- `tests/bench/src/` benchmark sources; `tests/bench/suite.json` manifest.
- `tools/bench/build.mjs` builds PE images at 0x400000 and `build/bench/manifest.json`.
- `tests/bench/run.mjs` runner; `tests/bench/report.mjs` summaries and comparisons.
