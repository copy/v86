A couple of test cases.

- [full](full/): Starts several OSes and checks if they boot correctly. This is
  the most useful test.
- [qemu](qemu/): Builds a Linux binary, which tests many CPU features. Needs to
  be manually put on a Linux image and run in the emulator. This test is
  contained in the `linux.iso` image and automatically run in the full test.
- [perf-irhydra](perf-irhydra/): Manual performance test. Probably not
  interesting for you.
- [perf](perf/): Very simple performance test. Probably not interesting for you.
