Use the corresponding `make` target in the root directory to run a test. The
following list is roughtly sorted from most interesting/useful to least.

- [nasm](nasm/): Small unit tests written in assembly, which are run using gdb
  on the host.
- [qemu](qemu/): Based on tests from qemu. Builds a Linux binary, which tests
  many CPU features, which are then compared to a run on qemu.
- [kvm-unit-test](kvm-unit-test/): Based on tests from the KVM project, tests
  various CPU features.
- [full](full/): Starts several OSes and checks if they boot correctly.
- [jit-paging](jit-paging/): Tests jit and paging interaction.
- [api](api/): Tests for several API functions of v86.
- [devices](devices/): Device tests.
- [rust](rust/): Rust unit test helpers.
- [expect](expect/): Expect tests for the jit output. Contains a set of
  asm+wasm files, where the jit is expected to produce the wasm file given the
  asm file.
