# The virt machine

> Status: A3 of [arm64-virt-android16-plan.md](arm64-virt-android16-plan.md)
> (virtio-mmio; PCIe comes with A5). The board's layout copies QEMU's
> `virt-9.2` (the fixed reference, [aarch64.md](aarch64.md)). This document
> records what the reference does and what v86 deliberately does differently.

## Status

| | |
| --- | --- |
| Option | the board of `cpu_type: "arm64"` (`machine_type: "virt"`, its default) |
| Devices | GICv3 (no ITS), PL011, PL031, the architected timer, PSCI over HVC, virtio-mmio with virtio-blk, -net, -rng and -console; PCIe with high ECAM *(pending: A5)* |
| Options | `virtio_disks: [{url or buffer, async, size, id, readonly}]` (or `hda`, `hdb`), `net_device: {type: "virtio"}`, `virtio_rng: true`, `virtio_console: true` |

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

## virtio-mmio

32 transports of version 2 (`src/virtio_mmio.js`) at `0x0a00_0000 + 0x200 n`,
each with an edge-triggered SPI 16 + n (INTID 48 + n). The devices take the
slots from the last one down, in this order: the `virtio_disks` (or `hda`,
`hdb`), then virtio-net, virtio-rng and virtio-console. QEMU fills the slots
in the order of its `-device` options the same way, so a reference run with
the devices in that order has the same slots, interrupts and `/sys` paths
(`tests/a64/linux_boot.mjs`'s live stage). An empty slot reads as the
reference's: magic, version 2, device ID 0, vendor "QEMU".

The devices are src/virtio.js's core with this transport instead of
virtio-pci:

- virtio-blk (`src/virtio_blk.js`): reads, writes, FLUSH, read-only disks,
  SEG_MAX, BLK_SIZE, GET_ID (a disk's `id`: `/dev/disk/by-id/virtio-<id>`).
  Writes stay in the image buffer, an in-memory overlay, for the session.
  The disk I/O is `src/block_backend.js`, shared with the PC's IDE and AHCI.
- virtio-net, virtio-console (hvc0, four ports): the PC's devices.
- virtio-rng (`src/virtio_rng.js`): `crypto.getRandomValues`.

Snapshots record each device with its slot and kind, and a machine with
other devices refuses them. A writable disk's contents are in the snapshot,
as the IDE's are; a read-only disk's are not, only its size and SHA-256,
which the restore checks.

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

| What | Command |
| --- | --- |
| The address space, the loader, the DTB, the PL011 against QEMU, virtio-blk I/O across resets and snapshots | `make a64-virt-device-tests` |
| Alpine from the ISO on virtio-blk to a login, the probe from its disk, virtio-net, -rng, hvc0; snapshots at the probe's markers | `A64_STAGE=live [A64_LINUX_SNAPSHOT=1] node tests/a64/linux_boot.mjs` |

The release level R-a64-virt runs them (`tools/release_gate.mjs`).
