# AArch64

> Status: A0 of [arm64-virt-android16-plan.md](arm64-virt-android16-plan.md).
> There is no ARM core yet. This document holds what is fixed so far: the CPU
> profile, the QEMU reference and the tests that run on it. Sections marked
> *(pending)* are filled in as the milestones land.

With `cpu_type: "arm64"` (from A1), v86 runs a separate core,
`build/v86-arm64.wasm`: an Armv8.0-A CPU at EL0 and EL1 only, on the `virt`
board ([virt.md](virt.md)). The x86 core, `build/v86.wasm`, is unchanged and
does not contain the ARM code (the plan's "Wasm core" section).

| | |
| --- | --- |
| Option | `cpu_type: "arm64"` (machine_type "virt", its default) *(the core runs from A1)* |
| Profile | `v86-aarch64-v1`, [tests/platform/a64-profile.json](../tests/platform/a64-profile.json) |
| Verified guests | none yet; Alpine 3.24 aarch64 passes its probe on the QEMU reference on 1/2/4 cores |
| Boot time | *(pending: A3 interpreted, A4 with the JIT)* |

## CPU profile

`v86-aarch64-v1` is Armv8.0-A as Alpine 3.24 needs it, plus the AES, PMULL,
SHA1, SHA2 and CRC32 extensions. Every ID register, its fields and the reason
for each value are in the profile JSON, checked against the Arm Architecture
Reference Manual, DDI 0487 issue L.b.

| Advertised | Not advertised |
| --- | --- |
| AArch64 at EL0 and EL1; FP and Advanced SIMD (no FP16); AES with 64-bit PMULL, SHA1, SHA-256, CRC32; GICv3 system registers; 2 breakpoints, 2 watchpoints; CSV2 and CSV3; 40-bit physical addresses, 16-bit ASIDs, the 4 KiB granule | EL2, EL3, AArch32; LSE, RDM, SHA512, SHA3, SM3/SM4, DotProd, FP16; PAuth, BTI, MTE, SVE, SME; PMU; hardware AF/DBM, PAN, VHE; the 16 and 64 KiB granules (v1.1) |

HWCAP is `0x8ff`: `fp asimd evtstrm aes pmull sha1 sha2 crc32 cpuid`.

The differences allowed against the QEMU `cortex-a35` reference are listed in
the profile JSON (`allowed_differences`). `node tools/cpu_contract.mjs
--a64-reference` reads the reference's ID registers at EL1 with a bare-metal
program and fails on any other difference.

## The QEMU reference

QEMU 9.2.0 built from its release tarball (`tools/a64_qemu/build.sh`; SHA-256
checked) into `build/a64-ref/qemu-9.2.0-install`:

```
-machine virt-9.2,gic-version=3,its=off,highmem-ecam=on,highmem-mmio=on,highmem-redists=on,virtualization=off,secure=off,acpi=off,dtb-randomness=off
-cpu cortex-a35,pmu=off,cntfrq=1000000000
-global virtio-mmio.force-legacy=false
```

One local patch, `tools/a64_qemu/0001-tb_phys_invalidate-jit-write.patch`:
on a macOS host the first watchpoint hit hangs the vCPU thread. The JIT
region is write-protected, so `qemu_spin_lock()` on the TB never succeeds.

Only `aarch64-softmmu` is built. QEMU's linux-user targets do not build on
macOS.

## Testing

| What | Command | Machine |
| --- | --- | --- |
| Alpine 3.24 aarch64 initramfs and live stages, the probe (`tests/a64/linux_probe.c`), 1/2/4 cores | `A64_LINUX_QEMU=1 A64_STAGE=initramfs\|live A64_CORES=N node tests/a64/linux_boot.mjs` | QEMU (v86: A2) |
| Bare-metal guests (`tests/a64/guest_runner.mjs`, runtime in `tests/a64/baremetal/`) | `node tests/a64/float_ref.mjs`, `node tests/a64/platform_probe.mjs` | `A64_TARGET=qemu` (v86: A1) |
| Decode oracle (llvm-mc with the profile's `-mattr`) | `node tests/a64/oracle/decode.mjs --self-test` | — |
| kvm-unit-tests arm64, 4k/16k/64k | `make a64-kvm-unit-tests-qemu` | QEMU (v86: A2) |
| ID registers | `node tools/cpu_contract.mjs --a64-reference` | QEMU (v86: P3.1) |
| Host capabilities | `tests/a64/browser_caps.html`, `node tests/a64/browser_caps.mjs` | browsers, Node |
| ISA corpus (Alpine's ELFs against v1) | `node tools/a64_isa_scan.mjs` | — |

`make a64-gate` runs before each commit and `make a64-gate-full` at a
milestone's exit (`tools/a64_gate.mjs`). The release levels `R-a64-*` are in
`tools/release_gate.mjs`. Their targets without tests yet print `A64_PENDING`.

### Measurements

The definitions (`tests/a64/linux_boot.mjs`, `build/a64-linux/result-<tag>.json`):

- `boot_to_login_ms`: from the start until `localhost login:` appears on the serial console (live stage).
- `probe_done_ms`: until the probe's `A64_PROBE_XC` line.
- Retired instructions and MIPS. On QEMU these come from the insn plugin with
  `-icount shift=0` (`A64_QEMU_PLUGINS=1`), and the instruction classes come
  from howvec. On v86 they will come from `jit_stats` (from A2).

| QEMU 9.2.0, cortex-a35, 1 core | instructions | wall time without plugins |
| --- | --- | --- |
| initramfs stage through the probe | 1.01 × 10⁹ | 1.7 s |
| live stage to login and through the probe | 6.36 × 10⁹ | 11.7 s to login, 12.0 s probe done |
