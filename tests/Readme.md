- [nasm](nasm/): Small unit tests written in assembly, which are run using gdb
  on the host.
- [qemu](qemu/): Builds a Linux binary, which tests many CPU features, which
  are then compared to a run on the host.
- [kvm-unit-test](kvm-unit-test/): Based on tests from the KVM project, tests
  various CPU features.
- [full](full/): Starts several OSes and checks if they boot correctly.
- [perf-irhydra](perf-irhydra/): Manual performance test. Probably not
  interesting for you.
