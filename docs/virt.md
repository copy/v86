# The virt machine

> Status: A0 of [arm64-virt-android16-plan.md](arm64-virt-android16-plan.md).
> The board does not exist yet in v86. Its layout copies QEMU's `virt-9.2`
> (the fixed reference, [aarch64.md](aarch64.md)). This document records what
> the reference does and what v86 deliberately does differently.

## Status

| | |
| --- | --- |
| Option | the board of `cpu_type: "aarch64"` *(pending: A2)* |
| Devices | GICv3 (no ITS), PL011, PL031, the architected timer, PSCI over HVC, virtio-mmio (A3), PCIe with high ECAM (A5) |

## Physical address map

The same as QEMU `virt-9.2` with `highmem-ecam`, `highmem-mmio` and
`highmem-redists` on:

| Base | Size | Device |
| --- | --- | --- |
| `0x0800_0000` | 64 KiB | GICv3 distributor |
| `0x080a_0000` | 15.4 MiB | GICv3 redistributors (123 cores) |
| `0x0900_0000` | 4 KiB | PL011 |
| `0x0901_0000` | 4 KiB | PL031 |
| `0x0a00_0000` | 32 × `0x200` | virtio-mmio transports |
| `0x1000_0000` | 751 MiB | PCIe MMIO, 32-bit window |
| `0x3eff_0000` | 64 KiB | PCIe I/O window |
| `0x4000_0000` | RAM size | RAM |
| `0x40_1000_0000` | 256 MiB | PCIe ECAM (high) |
| `0x80_0000_0000` | 512 GiB | PCIe MMIO, 64-bit window |

(From the reference's DTB, `dumpdtb` with 4 cores.)

## Platform behaviour fixed by the reference

`tests/a64/platform_probe.c` (bare metal) records these on the QEMU reference.
`tests/a64/platform_probe.expected` holds the results, and v86's board must
give the same:

- PSCI is version 1.1 over HVC. HVC #1 behaves as HVC #0.
- Unknown PSCI and SMCCC function IDs return NOT_SUPPORTED (-1), and so does
  SMCCC_VERSION.
- SMC is UNDEF (ESR `0x02000000`).
- A load from an unmapped physical address is a synchronous external abort
  (ESR `0x96000010`, FAR = the address). An address beyond the 40-bit PA range
  with the MMU off gets an address size fault at level 0 (ESR `0x96000000`).
- Loads from the 64-bit PCIe window with no device read all ones.

## Differences from QEMU

From the profile's DTB list (`tests/platform/a64-profile.json`):

- `/chosen/rng-seed` is written (the reference runs with `dtb-randomness=off`).
- There are no `flash@0`, `fw-cfg`, `pl061`, `gpio-keys` or `platform-bus` nodes.
- With extended RAM, there are two memory ranges: one from `0x4000_0000` and one from 4 GiB.

## Testing

*(pending: A1 address space, A2 DTB, PL011/PL031 and timers, A3 device reset;
see the release level R-a64-virt)*
