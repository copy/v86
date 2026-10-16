# The virt machine

> Status: A3 of [arm64-virt-android16-plan.md](arm64-virt-android16-plan.md)
> (virtio-mmio) and A5's PCIe host (P5.6–P5.8, P5.10). The board's layout copies QEMU's
> `virt-9.2` (the fixed reference, [aarch64.md](aarch64.md)). This document
> records what the reference does and what v86 deliberately does differently.

## Status

| | |
| --- | --- |
| Option | the board of `cpu_type: "arm64"` (`machine_type: "virt"`, its default) |
| Devices | GICv3 (no ITS), PL011, PL031, the architected timer, PSCI over HVC, the generic PCIe host bridge (high ECAM, INTx), virtio-blk, -net, -rng, -console, -input (keyboard, tablet, multi-touch) and -gpu (no VGA) on virtio-mmio or virtio-pci |
| Options | `virtio_disks: [{url or buffer, async, size, id, readonly}]` (or `hda`, `hdb`), `net_device: {type: "virtio"}`, `virtio_rng: true`, `virtio_console: true`, `virtio_input: true` (a keyboard and a tablet) or a list of `"keyboard"`, `"tablet"`, `"multitouch"`, `graphics_adapter: "virtio_gpu"`, `virtio_transport: "mmio"` (the default) or `"pci"` |

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
| `0x1_0000_0000` | `extended_memory_size` | extended RAM (v86 only, see below) |
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
virtio-pci (or, with `virtio_transport: "pci"`, the same devices on the PCIe
host, below):

- virtio-blk (`src/virtio_blk.js`): reads, writes, FLUSH, read-only disks,
  SEG_MAX, BLK_SIZE, GET_ID (a disk's `id`: `/dev/disk/by-id/virtio-<id>`).
  Writes stay in the image buffer, an in-memory overlay, for the session.
  The disk I/O is `src/block_backend.js`, shared with the PC's IDE and AHCI.
- virtio-net, virtio-console (hvc0, four ports): the PC's devices.
- virtio-rng (`src/virtio_rng.js`): `crypto.getRandomValues`.
- virtio-input (`src/virtio_input.js`, `virtio_input`): a keyboard (the
  bus's PS/2 set-1 scancodes as evdev keys), a tablet (the pointer's
  absolute position, 0–0x7FFF, its buttons and the wheel) and a multi-touch
  screen (the page's touches, the bus's `touch`, as the slots of the MT
  protocol: 11 slots, tracking ID = slot, BTN_TOUCH), with QEMU's
  virtio-keyboard, virtio-tablet and virtio-multitouch configuration: names,
  IDs, properties, event bits and axes.
- virtio-gpu (`graphics_adapter: "virtio_gpu"`, the plugin of the PC's
  virtio-vga, `src/graphics_adapters/virtio_gpu/`): without VGA, so no frame
  buffer BAR, no VGA BIOS and no ports; class 0380 on the PCIe host. Until
  the driver's first command the screen is blank. It takes the next slot
  after the virtio devices. Its host visible memory (the levels with
  `hostmem`) is device memory of the core (below): BAR 2, 64 bits wide, on
  the PCIe host; on virtio-mmio, at the top of the 64-bit window, where the
  SHM registers say.

Snapshots record each device with its slot and kind, and a machine with
other devices refuses them. A writable disk's contents are in the snapshot,
as the IDE's are; a read-only disk's are not, only its size and SHA-256,
which the restore checks.

## PCIe

The generic host bridge (`src/pci.js` with `generic`, the DTB's
`pcie@10000000`, as the reference's node): configuration through the ECAM
at `0x40_1000_0000` only (no 0xCF8/0xCFC, no i440FX), buses 0–255;
00:00.0 is QEMU's host bridge (1B36:0008). The windows are the 32- and
64-bit memory ranges of the address map; a memory BAR there is decoded
while its function's memory space is enabled, elsewhere in a window reads
are all ones. BARs may be 64 bits wide (the next register their upper half),
placed above or below 4 GiB; the windows are regions of the core's address
space that the host bridge decodes, so moving a BAR does not change the map
(but for device memory, below). No I/O BARs (the I/O window is described,
nothing decodes it: an access is an external abort), no MSI (the GIC has no ITS):
pin p (0–3) of slot s is SPI 3 + (p + s) % 4, level-triggered, shared. A
reset gives every function its power-on configuration.

With `virtio_transport: "pci"` the virtio devices are functions 00:01.0 on,
in the order of the virtio-mmio slots, laid out as QEMU's non-transitional
`virtio-*-pci` without MSI-X: the capabilities in BAR 4 (64-bit,
prefetchable, 16 KiB: common, ISR, device and notification configuration
at 4 KiB steps), QEMU's class codes and subsystem (1AF4:1100), INTA.
Linux puts BAR 4 in the 64-bit window, from `0x80_0000_0000`.

## Device memory

With a display adapter, guest memory has 128 MiB of device memory after
RAM (RAM and it together below 2 GiB). A region of it (virtio-gpu's host
visible memory) is mapped where its BAR is, as a region of the core's
address space that the cores read and write as RAM; the pages they write
are marked for the device (`a64_device_take_dirty`), and compiled code
writes it through the interpreter's path, which marks them. The PCIe
windows are split around it (`A64CPU.update_windows`): moving such a BAR
changes the map.

## Extended RAM

RAM beyond what fits in the 32-bit Wasm memory (`extended_memory_size`, a
multiple of 2 MiB) starts at 4 GiB, as a second memory range of the device
tree, and can reach 256 GiB, where the reference's RAM ends. Its pages are
kept in host ArrayBuffers ([`src/extended_memory.js`](../src/extended_memory.js))
and cached in `extended_memory_cache` bytes of frames in the Wasm heap (512 MiB
by default), with the engine the x86 core uses
([`src/rust/extended.rs`](../src/rust/extended.rs); the ARM core's part is
[`src/rust/aarch64/extended.rs`](../src/rust/aarch64/extended.rs)):

- The range is a region of the core's address space (`Kind::Extended`). The
  interpreter's accesses, the table walks and instruction fetches go through
  the frames a page at a time. The page tier's access cache is not filled for
  extended RAM, so compiled code reaches it through the same path.
- The page tier compiles code in extended RAM under the extended page's own
  code key. The function outlives its frame's eviction. The page's next write
  (a core's, DMA's) retires it. With cores in workers (P8.2), code in
  extended RAM is interpreted.
- The exclusive monitors track its granules by keys above every guest-memory
  offset. A core's or a device's write clears the other observers' reservations.
- Devices reach it through the DMA facade a page at a time (`dma_classify`
  gives -1: RAM, but not one backing). A pinned frame stays resident for the copy.
- Power-on clears it. `save_state()` refuses when it holds data; a
  `save_state_stream` snapshot holds it.

`index.html` puts up to 1792 MB of the Memory size in `memory_size` and the
rest in `extended_memory_size`. Linux takes the second range as normal memory
(`node 0: [mem 0x0000000100000000-...]`).

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
- The PCIe functions' configuration: no MSI-X capability (the reference runs
  with `vectors=0`) and no option ROM (`romfile=` for virtio-net); the
  capabilities list differs, the BARs are the same.
- With extended RAM, there are two memory ranges: one from `0x4000_0000` and one from 4 GiB.

## Testing

| What | Command |
| --- | --- |
| The address space, the loader, the DTB, the PL011 against QEMU, virtio-blk I/O across resets and snapshots | `make a64-virt-device-tests` |
| Alpine from the ISO on virtio-blk to a login, the probe from its disk, virtio-net, -rng, hvc0, the keyboard's and tablet's events; the PCI functions against the reference's; snapshots at the probe's markers | `A64_STAGE=live [A64_TRANSPORT=pci] [A64_LINUX_SNAPSHOT=1] node tests/a64/linux_boot.mjs` |
| The PCIe host: ECAM, a 64-bit BAR above and below 4 GiB, decode, reset | `node tests/a64/address_space.mjs` |
| Alpine on virtio-gpu: the scenarios of `tests/x64/linux_gpu.mjs` (drm, gl, resize, input, gltest, virgl, venus, vkcube) | `GPU_SCENARIO=drm node tests/a64/linux_gpu.mjs` (packages: `node tools/alpine_repo.mjs --arch aarch64`) |

The release level R-a64-virt runs them (`tools/release_gate.mjs`).
