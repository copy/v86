Use the corresponding `make` target in the root directory to run a test. The
following list is roughtly sorted from most interesting/useful to least.

- [nasm](nasm/): Small unit tests written in assembly, which are run using gdb
  on the host.
- [qemu](qemu/): Based on tests from qemu. Builds a Linux binary, which tests
  many CPU features, which are then compared to a run on qemu.
- [kvm-unit-test](kvm-unit-tests/): Based on tests from the KVM project, tests
  various CPU features.
- [full](full/): Starts several OSes and checks if they boot correctly.
- [jit-paging](jit-paging/): Tests jit and paging interaction.
- [api](api/): Tests for several API functions of v86.
- [devices](devices/): Device tests.
- [rust](rust/): Rust unit test helpers.
- [smp](smp/): Cooperative multicore building blocks. `make smp-tests` checks
  state switching against independent single-core runs. `make multicore-boot-tests`
  checks bounded interpreter scheduling, APIC routing, guest INIT/SIPI trampolines
  on 2/4/8 cores and real SeaBIOS POST/floppy boot on 2/3/4/8 cores. The
  `multicore-boot-tests-release` target runs the same gate with release JS/Wasm.
  Multicore JIT, OS topology and multicore snapshots remain separate plan gates.

The following environmental variables are respected by most tests if applicable:

- `TEST_RELEASE_BUILD=1`: Test the release build (libv86.js, v86.wasm) instead of the
  debug build (source files with v86-debug.wasm)
- `MAX_PARALLEL_TESTS=n`: Maximum number of tests to run in parallel. Defaults
  to the number of cores in your system or less.
- `TEST_NAME="…"`: Run only the specified test (only full, nasm)

## JIT tests

The JIT is the x64 page tier ([JIT design](../docs/ir-design.md)); its local
gates are `make jit-gate` before each commit and `make jit-gate-full` before a
default changes ([jit-unification-plan.md](../docs/jit-unification-plan.md)
P0.9). The targets they run:

- `make x64-page-tier-tests`: long-mode and compatibility-mode code in the page
  tier ([x86-64.md](../docs/x86-64.md)).
- `make x64-legacy32-tests`: 32-bit and 16-bit code in the page tier against
  the interpreter: random programs (`ir/differential/tier0_fuzz.mjs` for 32-bit
  code, `ir/differential/prot16_fuzz.mjs` for 16-bit protected-mode, real-mode
  and virtual-8086 code, `FUZZ_KIND` and `FUZZ_MODE` select the forms), faults,
  interrupts, self-modifying code, multi-page functions, far transfers between
  modes, the step profile and the mode ledger. (The `tier0_` names are IR
  Tier-0's, which the page tier replaced.)
- `make jit-core-tests`: the Rust unit tests, the Wasm builder's output, and:
  - `make decode-tests`: the decoder catalogue over every encoding/ModRM/SIB
    form, instruction boundaries against NDISASM, and the interpreter's staged
    ModRM resolver against a pinned one (`decode/`);
  - `make rep-engine-tests`: the interpreter's REP engine in bounded batches
    against the pinned pre-refactor string body;
  - `make verr-flags-tests`: VERR/VERW's computed ZF against the raw flag;
  - `make decode-rules-tests`: mandatory prefixes, F2/F3 order and #UD for
    unlisted prefixes in the interpreter and the page tier, VEX by mode.
- `make jit-switch-tests`, `make jit-leaf-tests`, `make jit-disabled-tests`:
  the switch registry, the x86 leaf templates' golden digests, and the JIT
  turned off and on at run time.

The ISA suites (`make sse3-tests`, `ssse3-tests`, `sse4-tests`, `sse-fp-tests`,
`sse-fault-tests`, `avx-tests`, `bmi-tests`, `fma-tests`, `xsave-tests`, ...)
compare the interpreter and the page tier with SDM models and QEMU.

The IR region pipeline's tests (`make ir-*-tests`, `tests/expect`,
`tests/ir/semantics`, `tests/ir/wasm` and most of `tests/ir/differential`)
went with the region pipeline in M11 of the plan.
