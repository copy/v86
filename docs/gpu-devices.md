# GPU devices: VMware SVGA II and virtio-gpu

v86 emulates two 3D display adapters besides the Bochs VGA: **VMware SVGA II**
(`graphics_adapter: "vmware_svga"`) and **virtio-gpu** as virtio-vga
(`graphics_adapter: "virtio_gpu"`). Their 3D work runs on WebGPU, in the
page. This document describes the devices and their drivers as built. The
deviations from real hardware are listed in [gpu-deviations.md](gpu-deviations.md);
setting up a Windows 8.1 guest for them (driver packages, test signing,
timeouts, 3DMark06 states) is in [windows-nt.md, section
5.4](windows-nt.md#54-windows-81-x64-with-vmware-svga-ii-or-virtio-gpu); how
to measure is in [profiling.md](profiling.md).

| Guest | Device | Driver | What works |
| --- | --- | --- | --- |
| Windows 8.1 x64 | SVGA II | VMware Tools 13.1.5 ("VMware SVGA 3D", WDDM) | D3D9 (3DMark06 runs to the end), D3D10/10.1/11 up to FL11_0 with 8x MSAA, DWM composition |
| Windows 8.1 x64 | virtio-gpu | viogpudo (virtio-win 0.1.240, w8.1, test signed) | 2D, EDID, cursor, live resolution changes |
| Linux x86_64 (Alpine) | SVGA II | vmwgfx + Mesa svga | OpenGL 4.3 core (SM5), GLES 3.1, KMS |
| Linux x86_64 (Alpine) | virtio-gpu | virtio_gpu + Mesa virgl (Mesa 25.2) | OpenGL 4.3 core/compat, GLES 3.1, persistent buffer mappings; without virgl (`2d-blob`), scanouts from guest blobs |
| Linux x86_64 (Alpine) | virtio-gpu (level `venus`) | virtio_gpu + Mesa venus (Mesa 26.1) | Vulkan 1.1: vulkaninfo, transfers, synchronization, mapped memory, graphics, compute, queries, dynamic rendering (`vktest`: same results as lavapipe), vkcube on weston, snapshots |

## Configuration

Three options are public:

```js
new V86({
    graphics_adapter: "vmware_svga",   // required: "bochs_vga" | "vmware_svga" | "virtio_gpu" | "none"
    vram_size: 64 << 20,               // optional, a power of two up to 256 MiB; the adapter's default otherwise
    graphics_adapter_path: "lib/v86-vmware-svga.js", // optional: the plugin file
});
```

- **`graphics_adapter`** has no default. `"bochs_vga"` is the display v86
  always had; `"none"` is a machine without a display ([Adapter
  plugins](#adapter-plugins)). Whichever adapter is configured takes the VGA's
  PCI slot, so the other devices keep their PCI addresses. A machine has one
  display adapter or none.
- **`vram_size`** is the size of the adapter's VRAM BAR, the VGA core's linear
  frame buffer, at most 256 MiB (all the VGA core backs). With `"none"` it is
  ignored, with a warning. `vmware_svga` refuses a snapshot whose `vram_size`
  differs from the machine's. A larger one does not help 3D: both devices
  take 3D data from guest memory (GMRs and GB objects; resource backing and
  virtio-gpu's host-visible BAR), not from the VRAM.
- **`graphics_adapter_path`** is the path or URL of the plugin file, for pages
  that do not put it beside the libv86 bundle ([Loading](#adapter-plugins)).
- **`graphics_proxy`** ([glbridge.md](glbridge.md)) is a separate option and
  works with any adapter.

| Adapter | VRAM BAR | Default `vram_size` | Minimum |
| --- | --- | --- | --- |
| `bochs_vga` | BAR0 | 8 MiB (the size v86 always had) | |
| `vmware_svga` | BAR1 | 32 MiB | 4 MiB |
| `virtio_gpu` | BAR0, also viogpudo's frame buffer | 32 MiB | 16 MiB: viogpudo uses BAR0 as its frame buffer only from 16 MiB |

**Errors.** `new V86()` throws when `graphics_adapter` is missing or unknown
(the message lists the supported values), when it is a function (the old
`installV86GLGraphicsAdapter` hook; use `graphics_proxy: true`), when
`vga_memory_size` is given (renamed to `vram_size`), or when `vram_size` is not
a power of two or is above 256 MiB. A plugin file that cannot be loaded is an `emulator-error`
that names the URL it tried and suggests `graphics_adapter_path`. A size below
the adapter's minimum, an unknown level or a 3D level without a renderer
throw when the device is made. `tests/devices/graphics_adapter.js` checks the
option errors.

**Demo page.** `index.html` has a *Graphics adapter* selector (Bochs VGA, the
default; VMware SVGA II; virtio-gpu; None, serial console only) and takes
`?graphics_adapter=<name>`. The *Video Memory size* field or `?vram=<MiB>` sets
`vram_size`, rounded up to a power of two and at most 256; virtio-gpu needs 16
or more there. `?displays=N` gives virtio-gpu
N displays, at most 4 ([virtio-gpu](#virtio-gpu)). `debug.html` has the same
selector without virtio-gpu. The page's OS profiles use `"bochs_vga"` unless
`?graphics_adapter=` names another.

**Levels.** What a device declares to the guest (capability bits, devcaps,
virtio features, capsets) is fixed by a *level*. Drivers read these once at
boot, and one snapshot must not show a different device in a different
browser, so the level is chosen at power-on and stored in the snapshot, and a
level's ABI is frozen: a new capability always comes with a new level. What
each level declares is listed under [VMware SVGA II](#vmware-svga-ii) and
[virtio-gpu](#virtio-gpu).

| Adapter | Levels, lowest first | Need a renderer | Default |
| --- | --- | --- | --- |
| `vmware_svga` | `2d`, `2d-full`, `vgpu9`, `gb9`, `dx10`, `dx10.1`, `dx11`, `dx11-full` | `vgpu9` and up | `dx11-full` with a renderer, `2d-full` without |
| `virtio_gpu` | `2d`, `2d-blob`, `virgl`, `virgl43`, `virgl43-blob`, `virgl43-hostmem`, `venus` | `virgl` and up | `virgl43-hostmem` with a renderer, `2d-blob` without; `venus` only when pinned |

- **The renderer.** The page has one when it has loaded
  `build/glbridge/libv86-webgpu.js` (which defines `V86SVGARenderer`) before
  `new V86()` and `navigator.gpu.requestAdapter()` returns an adapter. Nothing
  else about WebGPU is checked ([WebGPU features](#architecture)). Without a
  renderer the device takes its 2D default, with no console message (a debug
  log only when `requestAdapter` throws). Whether the screen is drawn with
  Canvas2D or the WebGPU compositor does not matter. In node there is a
  renderer only when a test brings one.
- **Pinning.** `graphics_adapter_test` (internal, not in `v86.d.ts`) takes
  `level` (pin the level), `scanouts` (virtio-gpu's number of displays, 1 to
  16; the demo page's `?displays=N` sets it) and `renderer` (a renderer channel
  the test brings: `tests/x64/gpu_remote_renderer.mjs` runs the renderer in a
  headless Chrome, `tests/x64/gpu_trace.mjs` records the batches and answers
  at once). `level` and `scanouts` also reach a CPU worker.
- **Restore.** `vmware_svga` takes the level from the snapshot; `virtio_gpu`
  must already have it ([Snapshots](#snapshots)).

## Adapter plugins

Each display adapter is a plugin. v86's side, `src/graphics_adapter.js`, keeps
the VGA PCI slot, the PCI bus, the port and memory maps, device memory
(`mmio_ram`), the display hub and the adapter's place in a snapshot; the plugin
owns the device.

| Adapter | Plugin file | Entry module | PCI ID |
| --- | --- | --- | --- |
| `bochs_vga` | `build/v86-bochs-vga.js` | `src/graphics_adapters/bochs_vga/plugin.js` | `1234:1111` |
| `vmware_svga` | `build/v86-vmware-svga.js` | `src/graphics_adapters/vmware_svga/plugin.js` | `15AD:0405` |
| `virtio_gpu` | `build/v86-virtio-gpu.js` | `src/graphics_adapters/virtio_gpu/plugin.js` | `1AF4:1050` |

- **Descriptor.** A plugin file calls `register_graphics_adapter(descriptor)`
  (`src/graphics_adapters/machine.js`), which stores it under its name in the
  global `V86GraphicsAdapters`. The descriptor is `{ name, pci_vendor,
  pci_device, create(handle, options) }`; v86 checks these fields after
  loading. `options` is `{ vram_size, test, renderer }`: `test` is
  `graphics_adapter_test`, `renderer` the page's renderer channel or null.
- **Device.** `create` returns the device, an object with these members:

| Member | Required | Use |
| --- | --- | --- |
| `get_state`, `set_state` | yes | The device's part of `state[52]` |
| `vga` | no | Its VGA core; v86 also exposes it as `cpu.devices.vga` for tests and debugging |
| `reset` | no | A machine reset (PCIRST#) |
| `has_host_state`, `prepare_save` | no | Whether the device keeps state on the GPU; if it does, `save_state` and `save_state_stream` first await `prepare_save` (a promise), which fetches that state |
| `svga_capabilities` | no | `{ capabilities, hardware_version }` for the VMware backdoor's `GET_SVGA_CAPABILITIES` (`src/vmware.js`) |

- **The machine handle** (`GraphicsAdapter.prototype.create_handle`) is what
  the plugin works with. `GraphicsMachine` in `machine.js` wraps it in a typed
  class, so that device code reads like any v86 device, and converts what
  crosses the boundary (port handlers, display layers, the PCI description).

| Group | Members |
| --- | --- |
| Ports and MMIO | `register_read`, `register_write`, `register_write_consecutive`, `mmap_register`; `allocate_io`: a free I/O window aligned to its size in 0xD000–0xDFFF (below the `virtio_devices` pool), the same for the same configuration so that snapshots line up |
| Device memory | `mmio_ram_allocate`, `_backing`, `_map`, `_unmap`, `_read8`, `_write8`, `_mark_dirty`, `_take_dirty`, `_allocate_pixels`, `_fill_pixels`; `dirty_min_offset`, `dirty_max_offset` |
| PCI and IRQ | `register_pci` (BARs with `on_move`, the ROM BAR), `create_virtio` (virtio-vga, below), `raise_irq`, `lower_irq` |
| Guest memory | `read_physical`, `write_physical` (`CPU.read_blob_physical`/`write_blob_physical`), 16- and 32-bit `read*_physical`/`write*_physical`, `validate_physical_range` |
| Machine | `name`, `now` (the machine clock), `on_host_display_size` (`V86.set_display_size`: width, height, display index), `in_vm86`, `wasm_memory`, `qemu_compatible` |
| Display hub | `display`: `set_mode`, the text, cursor and font calls, `update_buffer` (layers), `time_since_vblank`, `add_source` (the device as a display source), `add_timer` |

- **virtio-vga.** virtio-gpu is an adapter plugin, not a `virtio_devices`
  entry: it needs the VGA core, a VRAM BAR, the VGA BIOS as its expansion ROM
  and the VGA slot, while a `virtio_devices` entry is an I/O-port virtio
  device. It still uses the core's virtio transport. The handle's
  `create_virtio` calls `create_adapter_virtio_device`
  (`src/virtio_devices.js`) with the `virtio_devices` descriptor fields plus
  `class_code` and `revision`; the adapter's memory BARs, `bars` (`{ bar, size,
  address, prefetchable, on_move }`, so that BAR0 can be the VGA core's frame
  buffer and follow it when the firmware moves it); `capability_bar`, the one
  memory BAR that holds all four virtio capabilities at 0x000, 0x100, 0x200
  and 0x300 (viogpudo maps no I/O BARs); `shared_memory` regions (`{ id, bar,
  offset, length }`, written as `VIRTIO_PCI_CAP_SHARED_MEMORY_CFG`
  capabilities: the host visible memory); the VGA BIOS as ROM (`pci_rom_size`,
  `pci_rom_address`); and `qemu_compatible` (QEMU's vector registers and ISR
  bits, which viogpudo needs). The transport's state is part of the adapter's
  snapshot entry (the virtio handle's `transport` and `set_transport`), not of
  `state[92]`.
- **Quoted names.** Plugins are compiled on their own with Closure SIMPLE
  (`make graphics-adapters`, a prerequisite of every libv86 bundle and of
  `build/cpu-worker.js`): `GRAPHICS_ADAPTER_COMMON` (the VGA core,
  `machine.js`, `renderer_protocol.js` and the core modules they import) plus
  the adapter's own files. `v86_all.js` is ADVANCED-compiled and renames
  properties, so everything that crosses the boundary (descriptor, handle,
  device) uses quoted names, and any plugin works with any bundle. There is no
  externs file; type checking inside a plugin comes from `GraphicsMachine`.
- **Loading.** v86 first looks in `globalThis.V86GraphicsAdapters`, so a page
  may load the plugin itself (`<script>` or `require`). Otherwise:
  - From the source tree (`src/main.js`) without `graphics_adapter_path`, it
    imports `src/graphics_adapters/<name>/plugin.js`.
  - A bundle loads `graphics_adapter_path` if given; else `v86-<name>.js`
    (underscores become hyphens: `v86-vmware-svga.js`) beside itself when it
    knows where it is (`document.currentScript` for a classic script in a
    page, `import.meta.url` for `libv86.mjs`, `__dirname` for CommonJS in
    node); else `build/v86-<name>.js` relative to the page. In node a relative
    path is relative to the working directory.
  - With a CPU worker the page resolves the path to an absolute URL and the
    worker loads the plugin with `importScripts`, so the page needs no device
    code. In parallel mode the device exists only on the machine thread; the
    vCPU workers never load it.

  The plugin is fetched while the disk images load. A file that cannot be
  loaded, that registers no such adapter or whose descriptor is invalid is an
  error naming the adapter.
- **VGA BIOS IDs.** One `bios/vgabios.bin` serves every adapter. SeaBIOS runs
  a PCI option ROM only when its PCI header names the device's vendor and
  device, so v86 rewrites those IDs, and the checksum, when it loads the VGA
  BIOS (`patch_vga_bios_ids`, from the descriptor's `pci_vendor` and
  `pci_device`). The ROM's code needs no change: SeaVGABIOS's Bochs driver
  (`vgasrc/bochsvga.c`) takes the frame buffer from BAR1 when the vendor is
  VMware's (`15AD`) and from BAR0 otherwise, which is where SVGA II, virtio-vga
  and the Bochs VGA have their VRAM; per-device builds differ only in the
  header. A VGA BIOS that is not a SeaBIOS build is left alone, with a
  warning.
- **Snapshot format.** `state[52]` is `["graphics_adapter", 1, name, device
  state]`, and absent with `"none"`. A snapshot from before plugins, whose
  `state[52]` is the Bochs VGA's own state, restores into `bochs_vga`.
  Restoring into a machine with another adapter, or with `"none"`, fails
  before anything is restored (`CPU.validate_state`), and the error names
  both adapters. Each device checks its own level and settings
  ([Levels](#configuration)).
- **`"none"`.** No plugin is loaded, nothing decodes the VGA ports, no VGA
  BIOS is loaded (a debug warning if one is configured) and `vram_size` is
  ignored. SeaBIOS boots without a display; the guest has the serial console.
  `wait_until_vga_screen_contains` throws.
- **Upgrading.** An embedder coming from a v86 without adapter plugins adds
  `graphics_adapter` to every configuration (`"bochs_vga"` for the old
  display), renames `vga_memory_size` to `vram_size`, and deploys
  `build/v86-<adapter>.js` beside its libv86 bundle or names it with
  `graphics_adapter_path`; the npm package's `files` include `build/v86-*.js`.
  There is no VGA BIOS per adapter to ship. Old snapshots restore into
  `bochs_vga`, and `cpu.devices.vga` is still the VGA core.

## Architecture

```text
=== guest ======================================================================
 Win 8.1: vm3dum*.dll + vm3dmp.sys          Linux: Mesa virgl or venus
 Linux: Mesa svga + vmwgfx                         + virtio_gpu
        │ registers, FIFO, command buffers           │ virtqueues, BAR4
=== CPU thread (or CPU worker) =================================================
 v86-vmware-svga.js                         v86-virtio-gpu.js
  registers, FIFO, command buffers, IRQ      control and cursor queues, EDID
  GMR / MOB / OTable / COTable walks         resources, backing, blobs, BAR4
  2D in VRAM                                 2D resources
  legacy 3D (SVGA3D) → D9WG batches          virgl → SVGA DX → GX batches
  DX (VGPU10) → GX batches                   TGSI → VGPU10 tokens
                                             Venus: Vulkan → VX batches
        └────────────────┬───────────────────────────┘
                         │ renderer channel: submit (d9wg, gx, vx), reset ↓
                         │                   write, done, lost ↑
=== page (WebGPU) ==============================================================
 svga_renderer.js, one GPUDevice:
   D9WG executor        GX executor (SVGA DX, virgl)     VX executor (Venus)
   (legacy 3D)          shader IR: VGPU10 → WGSL         SPIR-V → WGSL (naga)
```

- **The CPU side** (the plugin) does everything that touches guest memory:
  register semantics, command parsing, page table walks, 2D. A 3D command is
  validated, the guest data it references is read, and both go into a
  self-contained batch. Without a renderer ([Levels](#configuration)) the
  devices offer only their 2D levels and stay fully usable.
- **Guest memory.** SVGA's DMA (GMR and MOB pages, page tables, command
  buffers) goes through the handle's `read_physical`/`write_physical`, which
  are `CPU.read_blob_physical`/`write_blob_physical`. virtio-gpu reads backing
  in its own VRAM BAR directly (viogpudo's frame buffer) and everything else
  through its transport's `read_memory`/`write_memory`, which take only guest
  RAM. Both work page by page and reach RAM above 4 GiB, extended memory
  included. Guest page numbers and addresses (GMR2 with
  `SVGA_REMAP_GMR2_PPN64`, `PT64` MOB page tables, virtio's 64-bit addresses)
  are kept whole (JS numbers, exact to 2^53).
- **The renderer** (`src/browser/glbridge/svga_renderer.js`) runs batches on
  the GPU and never reads guest memory. It runs a D9WG executor (the D3D9
  proxy's `D3D9WebGPUExecutor`), GX and VX on one `GPUDevice`, which
  `webgpu_host.js` makes for the renderer's own offscreen canvas. In CPU
  worker mode the device is in the worker and the renderer stays on the page;
  the channel is the same.
- **The renderer channel** is one `{ post, listen }` pair per device. On one
  thread it is `create_local_channel` in `src/browser/starter.js` (a message
  is handled before `post` returns); with a CPU worker it is the worker's
  `graphics_adapter_renderer` device channel; a test may bring its own. The
  answers go into a response region, the last 4 MiB of a 16 MiB arena as in
  the D3D9 proxy's protocol (`renderer_protocol.js`): 16-byte query slots in
  its first 16 KiB (request id, a 64-bit value, status), then readbacks, each
  a 16-byte header (request id, byte count, reserved, status) and the bytes.

| Direction | Message | Meaning |
| --- | --- | --- |
| device → renderer | `submit { seq, bytes, stream }` | A self-contained batch. `stream` is `"d9wg"` (the default: legacy 3D), `"gx"` (SVGA DX and virgl) or `"vx"` (Venus). All streams share one sequence, and the renderer runs batches in the order sent |
| device → renderer | `reset {}` | A machine or device reset: the renderer forgets every object and drops answers to older batches |
| renderer → device | `write { offset, bytes }` | An answer at `offset` in the response region, matched to the device's pending request by its id |
| renderer → device | `done { seq }` | The batch has run and its writes were sent |
| renderer → device | `lost { reason }` | The renderer cannot go on |

- **Batching.** The channel has no limit on batches in flight (the D3D9
  proxy's limit across a worker boundary, [glbridge.md](glbridge.md), does not
  apply). The device sends the batch it is writing when something has to wait
  for it (a fence, a command buffer, a readback, a query: `after_work`), when
  it switches streams (D9WG and GX on SVGA, GX and VX on virtio-gpu), so that
  their order is kept, and when a batch grows past 8 MiB
  (`BATCH_FLUSH_BYTES`).
- **Completion order.** Fences (SVGA FIFO fences, MOB fences, command buffer
  status, virtio fenced responses) complete only after every batch sent before
  them is `done`, so a driver that waits for a fence sees the readbacks and
  query results. The device queues what a batch's completion triggers (fence
  values, command buffer status, IRQs) by sequence number (`after_work`);
  batches carry no completion lists.
- **Renderer loss.** If the renderer cannot go on (the GX or VX executor
  throws, or the D3D9 executor fails and has no device), it sends `lost` once;
  later batches are not run but still answered with `done`. The device then
  lets nothing wait: pending readbacks and queries are answered empty and every
  queued completion runs, so the guest does not hang. VMware SVGA also raises
  `SVGA_IRQFLAG_ERROR`. virtio-gpu sends no error responses; its later 3D
  commands draw nothing.
- **WebGPU features.** No level requires a WebGPU feature: a 3D level needs a
  renderer, and what it declares never depends on the GPU. `webgpu_host.js`
  requests every feature of `DEFAULT_FEATURES` that the adapter offers
  (`texture-compression-bc`, `texture-compression-bc-sliced-3d`,
  `float32-filterable`, `float32-blendable`, `depth-clip-control`,
  `clip-distances`, `depth32float-stencil8`, `dual-source-blending`,
  `rg11b10ufloat-renderable`, `indirect-first-instance`, `bgra8unorm-storage`,
  `timestamp-query`) and raises the limits in `RAISED_LIMITS` to the
  adapter's. GX adapts to some missing features: without `float32-filterable`
  32-bit float textures are bound as unfilterable, without `float32-blendable`
  they do not blend, depth clamping needs `depth-clip-control`, clip distances
  need `clip-distances` (warned otherwise), and typed UAVs of `bgra8unorm` need
  `bgra8unorm-storage`. BC formats, BC volumes, `depth32float-stencil8`,
  dual-source blending and `indirect-first-instance` are used without a check.
  The DX levels always declare the BC formats, so on a GPU without
  `texture-compression-bc` (typically mobile) GX cannot create those textures;
  BC volumes also need `texture-compression-bc-sliced-3d`.
- **Scanout.** 3D results reach the screen by readback into the device's
  picture (Screen Objects, Screen Targets, virtio scanouts), which the display
  hub shows like any 2D picture; there is no scanout message. On SVGA,
  `PRESENT`, `BLIT_SURFACE_TO_SCREEN` and Screen Target updates read the
  source rows back. The CPU converts them (8888, 565, 1555 and 10-10-10-2
  formats), scales them (nearest) and clips them into the Screen Objects'
  pictures, or, without Screen Objects, into the register mode's frame buffer
  at 32 bpp. A Screen Target image the GPU has not changed is read straight
  from its MOB. Cursors, screenshots, snapshots and `BLIT_SCREEN_TO_GMRFB`
  therefore work the same at every level, at the cost of one readback per
  present (G-31 in [gpu-deviations.md](gpu-deviations.md)).
- **One picture.** The device's picture is one rectangle. SVGA Screen Objects
  (and the Screen Targets shown through them) sit where the guest places them
  on its virtual desktop, and the bounding box of all screens is the canvas
  size (`ScreenObjects.bounds`). virtio-gpu places its enabled scanouts side by
  side, left to right in scanout order, and `GET_DISPLAY_INFO` reports those
  positions. Cursor and overlay are drawn over the picture in desktop
  coordinates.

## VMware SVGA II

The sources are in `src/graphics_adapters/vmware_svga/`. The device is
`svga_device.js`; its `LEVELS` say what each level declares (the tables at
the end of this section).

- **PCI**: `15AD:0405`, subsystem `15AD:0405`, revision 0, class `0300`,
  interrupt pin A. There is no capability list, so no MSI. The subsystem and
  revision are fixed because the Windows 8.1 section of `vm3d.inf`
  (`VMware.NTamd64.6.3`) matches only
  `PCI\VEN_15AD&DEV_0405&SUBSYS_040515AD&REV_00`; any other subsystem or
  revision leaves the device without a driver.
- **BAR0**: 16 I/O ports: `INDEX` at +0, `VALUE` at +1, `BIOS` at +2 (reads
  0, writes ignored), `IRQSTATUS` at +8.
- **BAR1**: the VRAM, 32-bit prefetchable memory, 32 MiB unless `vram_size`
  says otherwise (at least 4 MiB). It is the VGA core's LFB, so VBE's linear
  frame buffer is the same memory and moves with the BAR.
- **BAR2**: the FIFO, 2 MiB of device memory (an `mmio_ram` region the guest
  writes at memory speed) holding the FIFO registers, the legacy 3D caps
  record and the command ring.

What the device does, by level:

- **Registers and FIFO**: `SVGA_ID_2`, modes up to 2560×1600 at 8, 15, 16,
  24 or 32 bits per pixel. The device runs the FIFO when the driver writes
  `SVGA_REG_SYNC`, when it reads `SVGA_REG_BUSY` (which then always reads 0)
  and at every vblank. `SVGA_FIFO_STOP` moves past each command as it is
  parsed and `SVGA_FIFO_BUSY` is cleared without waiting for the renderer, so
  FIFO space is free at once; only fences, MOB fences and command buffer
  status wait for the GPU (see [Architecture](#architecture), completion
  order). An unknown command raises `SVGA_IRQFLAG_ERROR`, and the FIFO is
  skipped up to `NEXT_CMD`, since the command's length is unknown.
- **2D at `2d`**: the registers, the FIFO with `RESERVE`, `UPDATE`,
  `RECT_COPY` (within VRAM, overlapping rectangles handled), FIFO fences and
  interrupts (`IRQMASK`). There is no hardware cursor (the guest draws its
  own), no GMR and no Screen Object. The ROP commands (`RECT_ROP_COPY`,
  `FRONT_ROP_FILL`) are neither declared nor implemented.
- **2D at `2d-full`**, the whole 2D device: cursors (mono, color, alpha,
  positioned through the FIFO with `CURSOR_BYPASS_3`; drawn over the device's
  picture, never into guest memory: `svga_cursor.js`), 8-bit emulation,
  `MULTIMON` and the display topology (4 displays reported), GMR1 through
  registers and GMR2 through FIFO commands (64 ids, up to 1 GiB of pages:
  `svga_gmr.js`), Screen Objects (`svga_screens.js`: with a backing store in
  a GMR or VRAM, or, with Screen Object 2, without one, filled with
  `BLIT_GMRFB_TO_SCREEN` and read with `BLIT_SCREEN_TO_GMRFB`), `ESCAPE`, and
  command buffers.
- **Command buffers** run when `COMMAND_LOW` is written and complete (status
  written, interrupt raised) after the GPU work before them. The device
  context's queue commands (start, stop, preempt, empty) are accepted and do
  nothing, because queues run as they are submitted.
- **Video overlay** (`dx11-full`, `svga_video.js`): 32 overlay units set and
  shown through `SVGA_CMD_ESCAPE`; YV12, YUY2 and UYVY frames from a GMR or
  VRAM, scaled into their destination rectangle, with the color key. Like the
  cursor, the overlay is drawn over the device's picture, not into guest
  memory. The only known user is the X.org vmware driver's XVideo; Mesa,
  vmwgfx and the Windows 8.1 WDDM driver do not use it.

The 3D levels declare VMware's 3D commands in three generations: the legacy
commands (`vgpu9`: surfaces, contexts, render states, D3D9 shaders), the same
commands with their objects kept in guest memory (`gb9`), both run by the
D9WG executor, and from `dx10` on the D3D10/11-style state objects and SM4/5
shaders, run by [GX](#gx).

- **Legacy 3D** (`vgpu9`, `svga3d.js`, `svga3d_d9wg.js`): the SVGA3D commands
  1040–1082 become D9WG commands for the D3D9 executor the D3D9 proxy uses,
  except `PRESENT_READBACK` and `SCREEN_DMA`, which are not implemented.
- **Contexts**: each SVGA3D context, legacy or GB, is a D9WG device of its
  own. The executor already keeps the whole D3D9 state per device, so
  switching contexts needs no state shadow on the CPU side, and
  `CONTEXT_DEFINE` always takes a new device, so a context starts from D3D9's
  default state. Surfaces, shaders and vertex declarations are resources
  every device can use; work that belongs to no context (copies, readbacks,
  resource creation) goes to a utility device.
- **Buffer surfaces** (`SVGA3D_BUFFER`) get a D9WG vertex buffer, 16-bit
  index buffer or 32-bit index buffer the first time a draw uses them that
  way; all three may exist. Their bytes also stay on the CPU side, because
  legacy buffers change only through `SURFACE_DMA` and copies: a new role
  starts filled, every update goes to each role, and a `SURFACE_DMA` back to
  the guest is answered without the GPU.
- **Legacy devcaps** (`VGPU9_DEVCAPS`): every 3D level writes them into the
  FIFO's 3D caps record (`SVGA_FIFO_3D_CAPS`), with the 3D hardware version
  `SVGA3D_HWVERSION_WS8_B1` in `SVGA_FIFO_3D_HWVERSION` and `_REVISED`; from
  `gb9` on they can also be read through `SVGA_REG_DEV_CAP`. They declare what
  the D3D9 executor implements, including what 3DMark06 checks: VS/PS 3.0,
  4 simultaneous render targets, fp16 color targets that blend and filter,
  and depth textures (`Z_D24S8`, `Z_D24X8`, `Z_DF16`, `Z_DF24`, and
  `Z_D24S8_INT` as INTZ). The float color targets are `ARGB`, `R` and `RG` in
  `S10E5` (fp16) and `S23E8` (fp32). Besides: vertex textures (4) of the
  8888 formats and the one- and four-channel float formats, D16, D24S8 and
  D24X8 depth buffers, DXT1–5, ATI1/2, the bump formats, YUY2 and UYVY,
  occlusion queries only, 8 lights, 8 fixed-function and 16 shader textures,
  6 clip planes, 8192-texel textures, anisotropy 16, every texture combiner,
  256 context ids and 32768 surface ids. The format operations keep to the
  rules by which Windows' `d3d9.dll` accepts a driver's format list (see
  [Guest drivers](#guest-drivers)).
- **GB objects** (`gb9`, `svga_gb.js`): MOBs with every page table format (up
  to 256 MiB each; the device suggests 1 GiB of guest memory for GB objects),
  object tables the device writes as objects are defined (a driver that sets
  a table up again after a reset, with valid entries, gets those objects
  back), GB surfaces whose authoritative copy moves between MOB and GPU
  (`UPDATE`/`READBACK`/`INVALIDATE`), GB contexts and shaders, Screen Targets
  (up to 2560×1600), the cursor in a MOB (up to 256×256), MOB fences. The
  objects are those of `vgpu9` and still draw through D9WG; what changes is
  where their contents live between uses.
- **DX** (`dx10` and up, `svga3d_dx.js` → GX): DX contexts, whose state the
  device keeps in the context MOB format; COTables in guest memory; all view
  and state objects, shaders, stream output, queries, UAVs, compute and
  tessellation. The device takes every DX command from `dx10` on; what a
  guest driver uses follows the shader model the level declares: SM4.0 at
  `dx10`, SM4.1 at `dx10.1`, SM5 (compute, UAVs, tessellation) at `dx11`.
  Predication is accepted and kept with the context but not applied:
  predicated draws and copies always run (see
  [gpu-deviations.md](gpu-deviations.md#not-done)). D3D9 applications on
  Windows still use the legacy commands; surfaces move between D9WG and GX on
  the GPU (`SURFACE_IMPORT`/`EXPORT`), so DWM composites D3D9 windows without
  readbacks.
- **Devcaps and formats**: each level's devcaps are a list in
  `svga3d_tables.js` (`VGPU9_DEVCAPS`, `DX10_DEVCAPS`, `DX10_1_DEVCAPS`,
  `DX11_DEVCAPS`, `DX11_FULL_DEVCAPS`), each made from the one below; a devcap
  a list does not have reads 0. Their `DXFMT_*` entries are derived from
  `svga_dx_formats.js` (`DX_FORMATS`: per format the WebGPU texture format,
  what it can do as letters, and the WebGPU vertex format). GX uses the same
  table: `tools/svga_gx_formats.mjs` builds the renderer's copy and
  `tools/build_glbridge.mjs` puts it into the bundle as `V86SVGADXFormats`, so
  the device cannot declare a format GX does not handle. Two more tables
  describe formats: `svga_formats.js`, generated from
  `third_party/vmware-svga/svga3d_surfacedefs.h` (per format its block
  description, block size and bytes per block, which give the layout of
  surfaces in MOBs and GMRs), and `FORMATS` in `svga3d_tables.js`, the legacy
  formats as D3D9 formats for the D3D9 executor, which converts what WebGPU
  lacks (YUY2 and UYVY to RGBA, for example). VMware's Windows user-mode
  driver opens a feature level only when the devcaps meet its table for that
  level (in `vm3dum64_10.dll`), so the lists follow that table.
- **Backdoor**: the VMware backdoor (`src/vmware.js`, port 0x5658, also the
  absolute mouse) answers what the SVGA drivers and VMware Tools ask. It
  answers at every privilege level, as VMware's does, because VMware's tools
  and user-mode 3D driver use it from user mode.
  `GETVERSION` (10) gives the product type
  `VMX_TYPE_WORKSTATION`, because the Tools installer refuses unknown
  products. `GETHWVERSION` (17) gives virtual hardware version 13 (Workstation
  12.5, the first with SVGA 3D for Windows 8.1 guests through WDDM 1.3).
  `GET_SVGA_CAPABILITIES` (75), asked before the driver owns the device,
  gives the SVGA capabilities for subcommand 0 and the 3D hardware version for
  subcommand 2 (`SVGA3D_HWVERSION_WS8_B1`, 0x20001, at the 3D levels, else 0).
  Windows' `vm3dmp.sys` loads as a full WDDM driver only if subcommand 0 shows
  `SVGA_CAP_3D` and either `SVGA_CAP_GBOBJECTS` or a hardware version of at
  least 0x20000; otherwise it loads as a display-only driver. The RPCI
  message channel (`MESSAGE`, 30) passes `log` requests (the drivers' logs)
  on as the `vmware-log` bus event, answers `info-get guestinfo.<key>` from a
  map the host fills (`cpu.devices.vmware.guestinfo`, empty by default: a
  missing key answers "0 No value found"), and acknowledges
  `tools.capability.*` and `tools.set.version`. Every request except `log`
  is also sent as `vmware-rpci`.

**What each level declares.** A level declares everything the level below it
declares, and adds:

| Level | Adds | What it gives the guest |
| --- | --- | --- |
| `2d` | caps `RECT_COPY`, `EXTENDED_FIFO`, `PITCHLOCK`, `IRQMASK`, `TRACES`; FIFO caps `FENCE`, `PITCHLOCK`, `RESERVE` | Modes through the registers, the FIFO with `UPDATE`, `RECT_COPY` and `FENCE`, interrupts |
| `2d-full` | caps `CURSOR`, `CURSOR_BYPASS`, `CURSOR_BYPASS_2`, `ALPHA_CURSOR`, `8BIT_EMULATION`, `MULTIMON`, `DISPLAY_TOPOLOGY`, `GMR`, `GMR2`, `SCREEN_OBJECT_2`, `COMMAND_BUFFERS`, `CMD_BUFFERS_2`, `HP_CMD_QUEUE`; FIFO caps `CURSOR_BYPASS_3`, `ESCAPE`, `SCREEN_OBJECT`, `SCREEN_OBJECT_2`, `GMR2` | The whole 2D device. The default without a renderer |
| `vgpu9` | cap `3D`; 3D hardware version `WS8_B1` (FIFO and backdoor); the FIFO 3D caps record (`VGPU9_DEVCAPS`) | Legacy 3D, shader model 3.0. The lowest level that needs a renderer |
| `gb9` | caps `GBOBJECTS`, `CAP2_REGISTER`; cap2 `GROW_OTABLE`, `OTABLE_PTDEPTH_2`, `GB_MEMSIZE_2`, `CURSOR_MOB`, `SCREENDMA_REG` (the register reports screen DMA as not present); devcaps through `SVGA_REG_DEV_CAP` | MOBs, object tables, Screen Targets, the cursor in a MOB |
| `dx10` | cap `DX`; `DX10_DEVCAPS` | DX contexts, shader model 4.0. Windows 8.1 needs this level for its desktop (see [Guest drivers](#guest-drivers)) |
| `dx10.1` | cap2 `DX2`; `DX10_1_DEVCAPS` | Shader model 4.1 and feature level 10_1. Linux's vmwgfx wants `CAP2_DX2` with the `SM41` devcap, and Mesa then multisamples |
| `dx11` | cap2 `DX3`; `DX11_DEVCAPS` | Shader model 5: feature level 11_0, GL 4.3. `CAP2_DX3` with the `SM5` devcap is what both VMware's Windows driver and vmwgfx look for |
| `dx11-full` | FIFO cap `VIDEO`; `DX11_FULL_DEVCAPS` | The video overlay and GL's last provoking vertex. The default with a renderer |

What the devcap lists add or change, each over the one above:

| List | Adds or changes |
| --- | --- |
| `VGPU9_DEVCAPS` (`vgpu9`, `gb9`) | Shader model 3.0 and the D3D9 formats (see legacy devcaps above) |
| `DX10_DEVCAPS` | `DXCONTEXT` 1, `DX_MAX_VERTEXBUFFERS` 16, `DX_MAX_CONSTANT_BUFFERS` 14, `DX_PROVOKING_VERTEX` 0 (WebGPU's first vertex provokes), `MULTISAMPLE_2X` 0, `MULTISAMPLE_4X` 1, `MS_FULL_QUALITY` 0, `SM41` 0, `SM5` 0; the `DXFMT_*` of each format in `svga_dx_formats.js` except those added after `dx10` was declared (`AFTER_DX10`: `R10G10B10_XR_BIAS_A2_UNORM` surfaces, `B8G8R8X8_UNORM` vertices). Only the formats marked `m` multisample |
| `DX10_1_DEVCAPS` | `SM41` 1; 4x multisampling of every color and depth target format (GX supersamples); the `AFTER_DX10` formats; `DXFMT_YUY2` and `DXFMT_NV12` as supported (GX keeps such surfaces in guest memory only: they are made and copied, never sampled or drawn into). This is what VMware's D3D10 user-mode driver asks for before it offers feature level 10_1 (its table in `vm3dum64_10.dll`); NV12, YUY2, XR_BIAS surfaces and B8G8R8X8 vertices are on its Direct3D 11.1 list |
| `DX11_DEVCAPS` | `SM5` 1, `MULTISAMPLE_8X` 1 (supersampled 4×2), `MAX_FORCED_SAMPLE_COUNT` 8 and `GL43` 1 (what vmwgfx and Mesa want for GL 4.3; Mesa needs a forced sample count of at least 4 for draws without targets), `MAX_TEXTURE_WIDTH`, `_HEIGHT` and `_REPEAT` 16384 |
| `DX11_FULL_DEVCAPS` | `DX_PROVOKING_VERTEX` 1 (GX reorders the vertices of flat-shaded draws) |

A level's declarations never change once released: `dx10`'s devcaps stay as
first declared, and `tests/devices/vmware_svga_gb.js` checks that `dx10.1`
only adds bits to `dx10`. No level declares FIFO cap `ACCELFRONT`, the ROP
commands, or `CAP2_EXTRA_REGS` (so there are no `CURSOR4_*`, `FENCE_GOAL` or
`IRQ_STATUS` registers; interrupts are acknowledged through the `IRQSTATUS`
port).

## virtio-gpu

virtio-gpu is a single virtio-vga function: `1AF4:1050`, subsystem
`1AF4:1100`, revision 1, class `0300` (VGA controller), the only identity
viogpudo's INF matches ([Guest drivers](#windows-81-viogpudo)). Because the device is the VGA
function itself, not a non-VGA virtio function next to a VGA card, Windows
treats it as the boot display and viogpudo replaces the Basic Display driver
on the same device, so no second adapter appears. As a separate function it
would be a second monitor. Like SVGA II it interrupts through INTx (pin A);
there is no MSI or MSI-X.

| BAR | Contents |
| --- | --- |
| BAR0 | VRAM: the VGA core's LFB, also viogpudo's frame buffer (`vram_size`: 32 MiB by default, at least 16 MiB; see [Configuration](#configuration)) |
| BAR2 | The four virtio capabilities in one 128 KiB memory BAR at 0x000, 0x100, 0x200 and 0x300, as on QEMU's virtio-vga (viogpudo maps only memory BARs) |
| BAR4 | From `virgl43-hostmem`: the host visible memory, 64 MiB (128 MiB at `venus`), described by a shared memory capability (shmid 1). It is a 32-bit prefetchable BAR: v86's device memory regions (`mmio_ram`) have 32-bit bases and are decoded only below 4 GiB, so the firmware places BAR4 in the PCI memory window under 4 GiB |

The device shows its VGA core (BIOS, boot loaders, VBE) until the driver
sends its first control command. After a device reset, by the driver or the
machine, the VGA core is on screen again and redraws its mode and picture.

On the arm64 virt machine ([virt.md](virt.md); docs/arm64-virt-android16-plan.md
P7.1) the same plugin makes a virtio-gpu without VGA (the handle's
`has_vga` is false): class `0380`, no BAR0, no ROM, no ports; the screen is
blank until the driver's first command. On the PCIe host the capabilities are
in BAR 4 and the host visible memory in BAR 2, both 64-bit and prefetchable,
as QEMU's virtio-gpu-pci; Linux puts them in the 64-bit window above 512 GiB.
On virtio-mmio there is no BAR: the host visible memory is at the top of the
64-bit window and the SHM registers say where. The host visible memory is the
ARM core's device memory, which the cores read and write as RAM and whose
written pages the device takes as from `mmio_ram`.
While the driver's scanouts are shown, vblank is 60 Hz.

**What each level declares.** Levels from `virgl` up need the WebGPU
renderer. `RING_INDIRECT_DESC` is the virtio transport's feature; the others
are virtio-gpu's.

| Level | Features | Capsets | BAR4 | What the guest gets |
| --- | --- | --- | --- | --- |
| `2d` | `EDID`, `RESOURCE_UUID`, `RING_INDIRECT_DESC` | none | none | KMS and 2D |
| `2d-blob` | `2d`'s and `RESOURCE_BLOB` | none | none | KMS and 2D on guest blobs |
| `virgl` | `VIRGL`, `EDID`, `RESOURCE_UUID`, `RING_INDIRECT_DESC` | VIRGL (1), VIRGL2 (2) for GLSL 330 | none | OpenGL 3.3 core/compat, GLES 3.0 |
| `virgl43` | as `virgl` | VIRGL, VIRGL2 for GLSL 430 | none | OpenGL 4.3 core/compat, GLES 3.1 |
| `virgl43-blob` | `virgl43`'s, `RESOURCE_BLOB` and `CONTEXT_INIT` | as `virgl43` | none | as `virgl43`, with guest blobs |
| `virgl43-hostmem` | as `virgl43-blob` | `virgl43`'s and `VIRGL_CAP_ARB_BUFFER_STORAGE` | 64 MiB | as `virgl43`, and `ARB_buffer_storage` |
| `venus` | as `virgl43-blob` | `virgl43-hostmem`'s and VENUS (4) | 128 MiB | as `virgl43-hostmem`, and Vulkan 1.1 ([Venus](#venus-vulkan)) |

As on SVGA, a level's features and capsets never change: OpenGL 4.3 came as
the new level `virgl43`, and `virgl` still declares GLSL 330.

- **2D**: display info and EDID, resources with scattered backing,
  transfers, scanouts, the cursor queue, display events and fences. 2D
  resources live in host memory, at most 256 MiB in all (as QEMU's
  `max_hostmem`). A fenced response carries the request's context and ring
  index back.
- **Displays**: one scanout unless the test option
  `graphics_adapter_test: { scanouts: N }` asks for more (at most 16).
  Enabled displays sit side by side in the page's picture, and display info
  gives each its position. `V86.set_display_size(width, height, display)`
  makes that size (clamped to 320×200 to 8192×8192) the display's preferred
  mode in display info and EDID, and sends a display event; a size of 0
  turns off any display but display 0.
  The demo page reports its window's size, and `?displays=N` (1 to 4) gives
  each display an equal share of the window's width.
- **Following the preferred mode** is guest policy. Linux's fbcon and weston
  do not switch to a new preferred mode by themselves; a KMS client sees it
  and can set it (`modetest -s` in the `resize` scenario of
  `tests/x64/linux_gpu.mjs`). For Windows see [Guest drivers](#guest-drivers).
- **Blobs**: `RESOURCE_BLOB` (`2d-blob`, and `virgl43-blob` up) brings
  `BLOB_MEM_GUEST` resources, whose storage is guest memory with no copy on
  the host: they are scanned out straight from guest memory
  (`SET_SCANOUT_BLOB`), and cursors can come from them. `CONTEXT_INIT`
  (`virgl43-blob` up, not `2d-blob`) creates contexts of a given capset:
  virgl's two, and Venus's at `venus`; any other capset is refused.
- **virgl** (`virgl` up): the translation is on the device side, the way
  Mesa's svga driver works: gallium state becomes SVGA DX commands for GX
  (`virgl_context.js`), TGSI text becomes VGPU10 tokens (`tgsi.js`,
  `tgsi_vgpu10.js`), so GX has one front end. Each virgl sub-context is a GX
  context; virgl handles are DX object ids; rasterizer states and shaders get
  variants per draw (the next stage's inputs, Y flip and depth range, view
  swizzles, flat shading, alpha test, tessellation phases).
- **Host visible memory** (`virgl43-hostmem` up): `PIPE_RESOURCE_CREATE`
  templates, `BLOB_MEM_HOST3D` resources and `MAP_BLOB` into BAR4 give Mesa
  `ARB_buffer_storage`. Only buffers can be mapped; the guest's kernel picks
  the offset in BAR4. BAR4 is an `mmio_ram` region: the guest reads and
  writes it at memory speed, and the pages it writes are uploaded into their
  blobs before each `SUBMIT_3D` (`mmio_ram_take_dirty`); mapped buffers the
  GPU wrote are read back before the submit's fence completes.

**virgl capsets** (`virgl_caps.js`): VIRGL (1, `struct virgl_caps_v1`) and
VIRGL2 (2, `virgl_caps_v2`), filled field by field. The renderer name is
`v86 GX on WebGPU`, so Mesa reports `virgl (v86 GX on WebGPU)`. The format
bitmasks come from GX's format table (`svga_dx_formats.js`), so only
formats GX backs are declared. L8, A8, I8, L8A8 and L16 are R8, R8G8 and
R16 surfaces read through a swizzle: they can be sampled but are never
render targets, since a swizzle cannot apply on write. The stencil of a
depth-stencil resource is sampled through X24S8 and X32_S8X24 (a G8 UINT
view). Every virgl level declares at most 4 samples (positions at the centres of
a 2×2 block, as GX supersamples), 8 render targets, and points and lines
of 1 pixel only (WebGPU draws no others). `fragment_coord_conventions` is
not declared: D3D's fragment position is GL's upper-left origin, and Mesa
converts the other conventions itself.

| Capset field | `virgl` | `virgl43` and up |
| --- | --- | --- |
| GLSL level | 330 | 430 |
| Uniform blocks | 14: the default block and 13 UBOs, a D3D11 stage's 14 constant buffers | 15: GL 4.3 wants 14 UBOs per stage, slots 0 to 14 |
| Viewports | 1 | 16 |
| 2D and cube textures | 8192 texels | 16384 texels |
| Texture gather | none | 4 components, offsets −32 to 31 |
| Shader storage buffers, images | none | 8 each, in fragment and compute shaders only (D3D11 has UAVs only in those two stages) |
| Feature bits | independent blending, conditional render, primitive restart, separate blend equations, instancing and instance divisors, seamless cube maps, occlusion and timer queries, multisample textures, depth clip disable, UBOs | `virgl`'s, and cube map arrays, start instance, stream output pause/resume, texture query LOD, doubles (`has_fp64`, computed as f32: see [gpu-deviations.md](gpu-deviations.md)), tessellation shaders, indirect draws, sample shading, inverted conditional render, derivative control |
| Capability bits | `TGSI_INVARIANT`, `SRGB_WRITE_CONTROL`, `FBO_MIXED_COLOR_FORMATS`, `CLIP_HALFZ` | `virgl`'s, and `TEXTURE_VIEW`, `COPY_IMAGE`, `TXQS`, `MEMORY_BARRIER`, `COMPUTE_SHADER`, `FB_NO_ATTACH`, `ROBUST_BUFFER_ACCESS` |
| Primitives | points, lines, line strips, triangles, triangle strips and the adjacency ones; Mesa converts the rest | `virgl`'s, and patches (without them in the mask, Mesa's primitive converter takes patches and recurses until the stack overflows) |
| Mesa reports | OpenGL 3.3 core/compat, GLES 3.0 | OpenGL 4.3 core/compat, GLES 3.1 (GLES 3.2 needs ASTC, advanced blending and more) |

## Venus (Vulkan)

Level `venus` adds Venus contexts (capset 4) to `virgl43-hostmem`, for Mesa's
venus driver, and makes BAR4 128 MiB. It is not chosen by default; pin it
with `graphics_adapter_test: { level: "venus" }`. Venus is Vulkan's API
serialized: the guest driver encodes each command, the device decodes it,
keeps the Vulkan objects and answers.

- **What the driver needs**: Mesa's venus driver needs the kernel's
  virtio-gpu parameters `3D_FEATURES`, `CAPSET_QUERY_FIX`, `RESOURCE_BLOB`,
  `CONTEXT_INIT` and `HOST_VISIBLE`. Apart from `CAPSET_QUERY_FIX`, which is
  the kernel's own, these are the features `VIRGL`, `RESOURCE_BLOB` and
  `CONTEXT_INIT` and the host visible memory region, which is why `venus`
  builds on `virgl43-hostmem`. The driver creates its contexts with
  `CONTEXT_INIT` on capset 4. The capset (`venus_capset()` in `venus.js`)
  announces the protocol of `venus_protocol.js` (the wire format and vk.xml
  versions, the versions of `VK_EXT_command_serialization` and
  `VK_MESA_venus_protocol`), `supports_blob_id_0`, every extension of the
  protocol (the extension mask's bit 0 clear), `allow_vk_wait_syncs` and
  `supports_multiple_timelines`, and not `use_guest_vram`.
- **Wire format**: `venus_protocol.js` is generated by
  `tools/venus_protocol_gen.mjs` from the C Mesa generates for its driver
  (`src/virtio/venus-protocol`, `vn_protocol_driver_*.h`): its encoders
  become the device's request decoders (`d_*`), its reply decoders the
  device's reply encoders (`e_*`), listed in a `COMMANDS` table, with
  `tools/venus_protocol_runtime.js` (the stream reader and writer) copied in.
  The tool translates that C statement by statement and stops at a shape it
  does not know. It also writes the driver's side
  (`tests/devices/venus_guest_protocol.js`) for device tests. Both are
  checked byte for byte against Mesa's own C: `tools/venus_oracle/oracle.c`
  runs Mesa's request encoders and reply decoders, its output is kept in
  `tests/devices/venus_protocol_vectors.txt`, and
  `tests/devices/venus_protocol.js` checks both sides against it. To regenerate, with the source of Mesa
  26.1.6 (the version the capset announces; not in the repository, download
  it):

  ```sh
  node tools/venus_protocol_gen.mjs <mesa>/src/virtio/venus-protocol third_party/vulkan/vulkan_core.h \
      src/graphics_adapters/virtio_gpu/venus_protocol.js --guest tests/devices/venus_guest_protocol.js
  ```

  `third_party/vulkan/` holds the Vulkan headers Mesa 26.1.6 ships.
- **Transport** (`venus.js`): the driver's shared memory is `HOST3D` blobs of
  blob id 0 mapped into BAR4. Command rings live there; the device reads them
  whenever the machine's timers run (no idle rings, no notifications needed),
  keeps the `ALIVE` status bit up for the driver's watchdog, writes replies
  into the reply stream the driver names, and runs `vkExecuteCommandStreamsMESA`
  streams. A submission (`SUBMIT_3D`) that waits holds the control queue,
  as virglrenderer's in-order processing does.
- **Vulkan model** (`venus_vk.js` and `venus_vk_*.js`): instance and physical
  device queries from `venus_device_info.js`. The device reports Vulkan 1.1,
  the lowest renderer version Mesa's venus driver accepts
  (`VN_MIN_RENDERER_VERSION`), and declares only what WebGPU's guaranteed
  limits and formats back. The model keeps devices, queues, memory, buffers,
  images, views, samplers, command pools and buffers, fences, semaphores
  (binary and timeline), events, queries, shaders, pipelines, descriptor sets
  and render passes. Command buffers keep their commands (a secondary one is
  replayed by `vkCmdExecuteCommands`), including indirect draws and
  dispatches and blits (which make mipmaps); a submission becomes one VX batch when
  its timeline waits are met. One renderer queue runs everything in order,
  so binary semaphores need no wait.
- **Memory**: three memory types: device local (heap 0, 1 GiB), host visible
  and coherent, and host visible, coherent and cached (both in heap 1).
  Heap 1 is 112 MiB: the 128 MiB BAR4 less 16 MiB kept for the driver's
  rings and reply streams. A `VkDeviceMemory` is a GPU buffer; host visible
  memory is also exported as a blob the guest maps into BAR4. The pages the
  guest writes are uploaded before each submission; the byte ranges the GPU
  writes (copies, fills, image to buffer copies, storage buffers) are read
  back into the mapping before the submission's fence and semaphores signal.
  A range the GPU has written but not yet returned is never overwritten by an
  upload.
- **VX** (`src/browser/glbridge/vx/vx_executor.js`) runs VX batches on WebGPU:
  memory, textures, views, samplers, copies (row by row when the pitch is not
  WebGPU's), fills, clears, blits and resolves as render passes, and the
  graphics and compute commands. SPIR-V becomes WGSL with naga
  (`src/browser/glbridge/vx/naga`, built by `make glbridge` to
  `build/glbridge/vx_naga.wasm`): combined image samplers are split first,
  Vulkan's binding b is WGSL's 2b (2b + 1 for the sampler half), push
  constants become a storage buffer, so do uniform buffers whose layout
  WGSL's uniform rules refuse, and Y is flipped. Pipelines use WebGPU's
  automatic layouts; bind groups are made per pipeline from the bound sets'
  contents.
- **Queries**: a pool's results are a VX memory. Occlusion queries are
  WebGPU's (the render pass names the pool it uses: the model looks ahead
  for the first one begun in it), resolved into that memory when the pass
  ends; timestamps are the time the device makes the batch. The results of
  a submission's queries come back before its fence;
  `vkCmdCopyQueryPoolResults` copies them on the GPU.
- **Dynamic rendering** (`VK_KHR_dynamic_rendering`): `vkCmdBeginRendering`
  is a render pass of the views it names; pipelines take their formats from
  `VkPipelineRenderingCreateInfo`.
- **WSI**: Venus offers `VK_KHR_swapchain` when the device imports sync
  files into semaphores (`VK_KHR_external_semaphore_fd`, `_fence_fd`). The
  driver makes the sync files itself (a `SUBMIT_3D` on the queue's timeline)
  and tells the device what they did with `vkImportSemaphoreResourceMESA`,
  `vkWaitSemaphoreResourceMESA` and `vkResetFenceResourceMESA`: a pending
  signal that went into a sync file no longer lands on its semaphore or
  fence. Without dma-buf, Mesa's WSI is its software one: each present
  copies the swapchain image into a host visible buffer (read back before
  the present's fence) and from there into the compositor's `wl_shm` buffer.
  vkcube on weston runs at about 60 frames per second.
- **Snapshots**: the model keeps the VX command that made each renderer
  object (memory, image, view, sampler, shader, pipeline, query pool). Before
  a save the rings run until the device's requests are answered, the GPU
  finishes, and every memory's and image's contents are read back. A
  snapshot holds the contexts (rings, reply streams, the model's objects as
  JSON), the blobs with their mappings, the creation commands and the
  contents; a restore makes the renderer's objects again and fills them.
  A command that waited is read again from where its ring stopped.

## GX

GX (`src/browser/glbridge/gx/gx_executor.js`) is the WebGPU backend of the DX
commands, shared by SVGA DX and virgl. It takes the SVGA DX commands nearly
as they are (`GX.DX` carries the context and the command), plus a few
operations of its own: surface definition, uploads, readbacks, copies and
stretches, query ends, integer clears, and the import and export of surfaces
the D3D9 executor shares.

- **Surfaces** are WebGPU buffers or textures (1D textures as 2D, cubes as 2D
  arrays). A buffer keeps a CPU copy, because D3D lets the guest update any
  byte range and WebGPU writes whole dwords. Formats WebGPU lacks are stored
  wider and converted on upload and readback; the format table is the
  device's (`svga_dx_formats.js`). A TYPELESS surface is one texture of one
  format; a view of another format of the same texel layout gets an *alias*
  texture of that format, and the contents follow the format used last
  (copied raw through a buffer).
- **Order**: uploads and copies are recorded in the command encoder between
  the render passes, so each draw sees the contents the guest gave before it.
- **Pipelines** are cached by shaders, state objects, target formats,
  topology and vertex layout; consecutive draws share a render pass.
- **Draws**: viewports WebGPU would refuse (outside the target) are clamped,
  and the vertex shader moves the position to make up for it. Draws with flat
  varyings get their vertices reordered when the rasterizer state asks for
  GL's last provoking vertex. Triangle fans, which D3D10 does not have but
  Mesa's svga sends, are drawn as lists.
- **Multisampling is supersampling**: a 4x surface is a 2W×2H texture, 8x is
  4W×2H. Feature level 10_1, and Mesa's MSAA, need 4x multisampling of formats
  WebGPU cannot multisample (the RGBA32 and RG32 float and integer formats,
  and the 16-bit normalized formats GX stores as float). A supersampled
  surface is an ordinary single-sample texture, so every format can be
  multisampled and no render pass mixes sample counts.
- **Emulated stages** run as compute: geometry shaders (records, then a draw
  of what they emitted), stream output (with `DrawAuto` and statistics),
  tessellation (hull shader per patch, the D3D11 reference tessellator ported
  to WGSL, domain shader per point, an indirect draw), and vertex fetch.
  Vertices WebGPU's vertex fetch cannot take are pulled: a vertex format
  WebGPU lacks (the `pull:` entries in `svga_dx_formats.js`), an instance step
  rate above 1, an offset not aligned to min(4, element size), or a stride
  that is not a multiple of 4, is shorter than the elements or exceeds 2048.
  The vertex shader then runs as compute, fetching its own inputs, and the
  records it writes are drawn (`tests/glbridge/svga_pull_browser_test.html`).
  Indirect draws and triangle fans of such vertices are not drawn, and with
  stream output only the stream output pass pulls. The geometry shader and
  tessellation paths always run the vertex shader this way.
- **Shaders**: `shader_ir/dxbc_frontend.js` decodes VGPU10 tokens (SM4.0–5.0
  plus VMware's opcodes) and `shader_ir/wgsl_emitter.js` writes WGSL for an
  interface (the pipeline's vertex inputs, varyings, targets, sampler kinds).
  virgl's TGSI is first turned into VGPU10 tokens (`tgsi_vgpu10.js`), so
  there is one front end. The translation is v86's own JavaScript, like its
  D3D9 and GL translators; DXVK or vkd3d with naga compiled to wasm were not
  used for it. naga only checks the generated WGSL in the tests
  (`tests/glbridge/dxbc_wgsl_test.js`), and turns SPIR-V into WGSL for Venus
  (`build/glbridge/vx_naga.wasm`).

## Guest drivers

The devices are built for existing guest drivers; v86 adds no guest code.
This section lists what those drivers check before they use a feature, and
the behaviour of theirs that the devices follow. Installing them (driver
packages, test signing, TDR values, preinstalled images) is in
[windows-nt.md, section 5.4](windows-nt.md#54-windows-81-x64-with-vmware-svga-ii-or-virtio-gpu); where the
devices differ from the hardware is in [gpu-deviations.md](gpu-deviations.md).

What the drivers make of the levels (observed in guest runs):

| `vmware_svga` level | Linux: vmwgfx and Mesa's svga | Windows 8.1: VMware SVGA 3D |
| --- | --- | --- |
| `vgpu9` | Legacy 3D (kmscube) | Full WDDM driver, but no D3D11: no desktop |
| `gb9` | The same, with GB objects and Screen Targets | The same, with GB surfaces and the cursor MOB |
| `dx10` | Shader model 4.0, OpenGL 3.3 | FL10_0; DWM composites on the GPU; D3D9 programs (3DMark06) |
| `dx10.1` | `SM4_1`, OpenGL 3.3 with five more extensions, MSAA | FL10_1 with 4x MSAA |
| `dx11`, `dx11-full` | `SM_5_1X`, OpenGL 4.3 core with compute, tessellation, SSBOs and images | FL11_0 with 8x MSAA |

| `virtio_gpu` level | Linux: virtio_gpu and Mesa |
| --- | --- |
| `2d`, `2d-blob` | KMS and fbcon; at `2d-blob` dumb buffers are guest blobs |
| `virgl` | OpenGL 3.3 core/compat, GLES 3.0 (Mesa's virgl) |
| `virgl43`, `virgl43-blob` | OpenGL 4.3 core/compat, GLES 3.1 |
| `virgl43-hostmem` | The same with `ARB_buffer_storage` |
| `venus` | The same, and Vulkan 1.1 (Mesa's venus) |

Windows 8.1's viogpudo is 2D only and was run at `2d` and `2d-blob`.

### Windows 8.1: VMware SVGA 3D

VMware Tools ships "VMware SVGA 3D", a complete WDDM driver signed by VMware:
the kernel-mode `vm3dmp.sys`, the user-mode drivers for D3D9 (`vm3dum64.dll`)
and D3D10/11 (`vm3dum64_10.dll`), both loaded through `vm3dum64_loader.dll`
(`vm3dum.dll`, `vm3dum_10.dll` and `vm3dum_loader.dll` for 32-bit programs),
and an OpenGL ICD. It needs no test signing. v86 implements only the device:
registers, FIFO and command buffers, GMR and MOB guest memory, and the
translation of SVGA3D commands to WebGPU. With the driver, DWM composites on
the GPU instead of with WARP on the emulated CPU. The release used is Tools
13.1.5 (driver 9.17.09.0007); 11.3.5 served for comparison.

**Windows 8.1 needs `dx10` or higher.** At `vgpu9` and `gb9`, vm3d (Tools
13.1.5 and 11.3.5) loads as a full WDDM driver: its log says "SVGA WDDM Full
Display driver" and "WDDM 3D is on", at `gb9` also "Guest backed surface is
on", and at `gb9` it uses GB surfaces, the cursor MOB and the GART commands.
But it offers no D3D11, and DWM cannot start without a D3D11 device:

- `D3DKMTQueryAdapterInfo(DRIVERVERSION)` reports WDDM 1.0.
- `D3D11CreateDevice(D3D_DRIVER_TYPE_HARDWARE)` returns
  `DXGI_ERROR_UNSUPPORTED` at every feature level.
- DWM exits every few seconds with 0x8898008d; the screen stays black and no
  3D context is ever created on the device.

The user-mode driver itself works. Opened directly the way the D3D9 runtime
opens it, `vm3dum64_loader.dll`'s `OpenAdapter` succeeds with VS/PS 3.0 and 41
formats. Its D3D10/11 entry `OpenAdapter10_2` also succeeds, but reports no
supported DDI versions and an empty list of 3D pipeline levels, so the D3D11
runtime declares the adapter unsupported instead of falling back to 10level9
over the D3D9 DDI. From `dx10` the devcaps satisfy the driver's feature-level
lists and it offers DDI versions. `vgpu9` and `gb9` therefore serve Linux
guests (found 2026-10-01).

**What `vm3dmp.sys` checks.** The conditions were found in the driver package
of Tools 13.1.5: the INF, and a disassembly of the kernel driver's capability
check. The device's side of each is in `svga_device.js` (`LEVELS`),
`svga3d.js`, `svga3d_tables.js` and `src/vmware.js`.

| Condition | What the device declares |
| --- | --- |
| A PCI identity its INF names: `vm3d.inf`'s Windows 8.1 section (`NTamd64.6.3`) matches only `PCI\VEN_15AD&DEV_0405&SUBSYS_040515AD&REV_00` | Subsystem `15AD:0405`, revision 0 |
| The Tools installer: a product it knows, from the backdoor's `GETVERSION` | `VMX_TYPE_WORKSTATION` |
| A full WDDM driver rather than a display-only one: before it owns the device, the backdoor's `GET_SVGA_CAPABILITIES` (75) shows `SVGA_CAP_3D` (subcommand 0) and either `SVGA_CAP_GBOBJECTS` or a 3D hardware version of at least 0x20000 (`SVGA3D_HWVERSION_WS65_B1`, subcommand 2) | The level's caps; `SVGA3D_HWVERSION_WS8_B1` (0x20001) at the 3D levels, 0 below |
| The base features: `SVGA_CAP_GMR`, `SVGA_CAP_GMR2`, both `SVGA_CAP_COMMAND_BUFFERS` and `SVGA_CAP_CMD_BUFFERS_2`, FIFO caps `SCREEN_OBJECT` and `SCREEN_OBJECT_2` | From `2d-full` |
| Guest-backed mode: also `SVGA_CAP_GBOBJECTS` | From `gb9` |
| Legacy (non-GB) 3D: `SVGA_CAP_3D`, `SVGA_CAP_GMR2` and `SVGA_CAP_EXTENDED_FIFO`; a FIFO register area larger than 0x480 bytes that holds an `SVGA3D_FIFO_CAPS_RECORD_DEVCAPS` (0x100) record; `SVGA_FIFO_3D_HWVERSION` (`_REVISED` when `SVGA_FIFO_CAP_3D_HWVERSION_REVISED` is set) of at least `SVGA3D_HWVERSION_WS8_B1`; devcap `3D` non-zero, `VERTEX_SHADER_VERSION` at least 5 (VS 2.0), `FRAGMENT_SHADER_VERSION` at least 11 (PS 2.0) | From `vgpu9`: 0x123 register dwords (`SVGA_FIFO_NUM_REGS`, read through `SVGA_REG_MEM_REGS`); `SVGA3D.write_fifo_caps` writes `WS8_B1` into both version registers and one DEVCAPS record of `VGPU9_DEVCAPS` with VS/PS 3.0 (7 and 13, what 3DMark06 needs); `_REVISED` is not declared |
| Legacy 3D, also: `SVGA_REG_MEMORY_SIZE` large enough; the threshold depends on the number of screens and is at most 64 MB (otherwise its log says "host memory size") | 1 GiB (`GMR_MAX_PAGES` × 4096) with `SVGA_CAP_GMR2`, from `2d-full`; 0 below |
| Devcaps: in GB mode one at a time through `SVGA_REG_DEV_CAP` (indices 0–261, `SVGA3D_DEVCAP_MAX` = 0x106), otherwise from the FIFO record | `SVGA_REG_DEV_CAP` from `gb9`, answered from the level's table (`VGPU9_DEVCAPS` at `gb9`, then `DX10_DEVCAPS` to `DX11_FULL_DEVCAPS`); the FIFO record always holds `VGPU9_DEVCAPS` |
| DX contexts: `SVGA_CAP_DX` (bit 28, 0x10000000) | From `dx10` |
| Feature level 10_1: `SVGA_CAP2_DX2` (its option `svga.wddm.enable10_1FeatureLevel` is on by default) | From `dx10.1` |
| Feature level 11: `SVGA_CAP2_DX3` and the devcaps `SM5` and `MULTISAMPLE_8X` | From `dx11` |

The kernel driver tells its D3D10/11 user-mode driver which feature levels it
allows in the private adapter info that
`D3DKMTQueryAdapterInfo(UMDRIVERPRIVATE)` returns: a flags word at 0x10 (0x100
allows 10_1, 0x400 allows 11_0), `SVGA_REG_CAPABILITIES` at 4, CAP2 at 8, and
the devcaps as it read them from 0x64. `tools/windows/kmtinfo.c` prints that
block.

**The D3D10/11 user-mode driver.** `vm3dum64_10.dll` offers a feature level
only when the devcaps satisfy that level's list. The lists are found through a
table of {list pointer, entry count, feature level} records; the FL10_1 list
of Tools 13.1.5 is at 0x180060a20. The device's devcap tables
(`svga3d_tables.js`, see [VMware SVGA II](#vmware-svga-ii)) follow these lists
exactly:

- FL10_1 asks 4x MSAA for nearly every render target format, including the
  RGBA32 and RG32 float and integer formats WebGPU cannot multisample and the
  16-bit UNORM/SNORM formats GX stores as 32-bit float (GX supersamples, so
  every format can be multisampled). From Direct3D 11.1 on it also asks NV12,
  YUY2 and R10G10B10_XR_BIAS surfaces and B8G8R8X8 vertices.
- The driver offers no multisampling at all at FL10_0; MSAA comes with 10_1
  (`dx10.1` and up).
- `dx11`'s devcaps satisfy the FL11_0 and FL11_1 lists.
- At feature level 11 the driver no longer reads results back with a copy
  followed by `READBACK_GB_SURFACE`. It sends `DX_PRED_STAGING_COPY`,
  `DX_PRED_STAGING_COPY_REGION` or another staging copy or convert command
  with a readback byte, and the device then writes the destination (or the
  given subresource) back to its MOB (`staging_copy` in `svga3d_dx.js`).
  Without that, every readback at FL11 is black.

**D3D9.** D3D9 programs use the legacy 3D commands at every level, through
`vm3dum64.dll`. Windows' `d3d9.dll` checks the format list a D3D9 driver
reports and, if any of its rules fails, discards the whole list: there is no
HAL (`GetDeviceCaps` and `CheckDeviceType` return `D3DERR_NOTAVAILABLE`)
although the driver loaded. The rules:

- `3DACCELERATION` only on display-mode formats without alpha;
- R5G6B5 and X1R5G5B5 not both display modes;
- `MEMBEROFGROUP_ARGB` only on the 8-bit and 16-bit RGB formats,
  A2R10G10B10, A16B16G16R16 and their float versions;
- paired depth formats (such as D24S8 and S8D24) never both listed.

VMware's driver passes the device's format operations
(`SVGA3D_DEVCAP_SURFACEFMT_*`) through, so `VGPU9_DEVCAPS`, part of every 3D
level's devcaps, keeps these rules: only X8R8G8B8 and R5G6B5 are display
modes, and the ARGB group is only on the permitted formats.

VMware's D3D9 driver rejects a ps_2_0 shader whose `dcl` of a t or v register
carries a usage (a ps_3_0 form). VMware's own products do the same, so such a
failure is not the emulation's (seen with a hand-written sample shader).

**Settings and logs.** VMware's WDDM driver reads its settings,
`guestinfo.svga.wddm.*` (for example `enableGBObjects`, `enableDX10`), and its
log levels over the backdoor's RPCI channel (see [VMware SVGA
II](#vmware-svga-ii)). The device's `guestinfo` map is empty by default, so the
driver keeps its defaults; a missing key does not keep it from loading. The
drivers' `log` lines (vm3d's release log, and vmwgfx's on Linux) become
`vmware-log` bus events, which `tests/x64/windows_boot.mjs` prints as
`guest-log`. Its `WIN_GUESTINFO=key=value;...` fills the map, for example
`loglevel.vm3d.all=10` or `svga.wddm.miniportLogging=TRUE`.

**Hardware versions.** In VMware's products, D3D10.1 needs virtual hardware
version 16 and D3D11 version 18, with guest OpenGL up to 4.3 (VMware
Workstation 16 and 17 documentation, "Prepare a Virtual Machine to Use
Accelerated 3D Graphics"). Above the minimum 3D hardware version, the drivers
decide by capabilities and devcaps, not by version numbers. So the FIFO's
`3D_HWVERSION` registers hold `SVGA3D_HWVERSION_WS8_B1` at the 3D levels and the
backdoor's `GETHWVERSION` answers 13 (Workstation 12.5, the first with SVGA 3D
for Windows 8.1 through WDDM 1.3), while `dx10.1` and `dx11` declare what those
versions give: FL10_1 and FL11_0 on Windows, OpenGL 4.3 on Linux.

**Redoing the analysis.** For another Tools release: unpack the installer on
the host (the SVGA driver is in the embedded MSI's `VmVideo.cab`), read the
hardware IDs in `vm3d.inf`, and read `vm3dmp.sys` and `vm3dum64*.dll` with
mingw-w64's `objdump`: imports, strings, the comparisons against
`SVGA_REG_CAPABILITIES`, CAP2 and the devcaps, and the per-feature-level devcap
tables of `vm3dum64_10.dll`. At run time `tools/windows/kmtinfo.c` shows the
flags, caps and devcaps the kernel driver hands its user-mode drivers, and
`tools/windows/d3dprobe.c` what DXGI, D3DKMT, D3D11 and D3D9 make of the
adapter (see [Tests](#tests)).

### Windows 8.1: viogpudo

viogpudo from virtio-win 0.1.240 (its w8.1 build, test signed) is a display-only
driver (DOD): 2D with EDID, the cursor and live resolution changes, no 3D
(virtio-gpu 3D on Windows is deferred: [Not done and
deferred](#not-done-and-deferred)). What the device follows:

- **Identity.** Its INF matches only
  `PCI\VEN_1AF4&DEV_1050&SUBSYS_11001AF4&REV_01`, hence subsystem `1AF4:1100`
  and revision 1.
- **BARs.** It maps only memory BARs (`CPciResources::Init` ignores I/O
  resources), so the four virtio capabilities sit in memory BAR2.
- **Frame buffer.** It uses BAR0 as its frame buffer only when BAR0 is at least
  16 MiB, and otherwise allocates one in guest RAM; hence `virtio_gpu`'s
  minimum `vram_size`.
- **QEMU's virtio-pci registers.** viogpudo interrupts through INTx but depends
  on two behaviours of QEMU's transport. The MSI-X vector registers
  (`msix_config`, each queue's `msix_vector`) keep what the driver writes
  although there is no MSI-X: viogpudo always asks for configuration vector 0
  and gives up when it reads back `NO_VECTOR` (0xFFFF). And a configuration
  change sets both ISR bits (3), because its INTx handler acts only on 1 and 3.
  virtio-gpu always turns on the transport's `qemu_compatible`
  (`src/virtio.js`), whatever the machine's `qemu_compatible` option says.
- **Blobs.** It does not negotiate `RESOURCE_BLOB`: it keeps using 2D
  resources and displays normally at `2d-blob`.
- **Cursor.** With its default `HWCursor` = 0, Windows draws the pointer into
  the picture and the cursor queue stays unused. With `HWCursor` = 1 one
  `UPDATE_CURSOR` defines a 64×64 cursor and every mouse move sends a
  `MOVE_CURSOR`; the device draws it over its picture.
- **EDID.** The monitor is manufacturer "VEM", product 0x1050, named "v86
  virtio" (`edid.js`); Windows lists it as `DISPLAY\VEM1050`.
- **Escape.** Its `DxgkDdiEscape` only sets custom resolutions; following the
  page's size takes viogpuap in the guest (see
  [windows-nt.md](windows-nt.md#54-windows-81-x64-with-vmware-svga-ii-or-virtio-gpu)).

### Linux: what each driver needs and does

The guest is Alpine 3.24 x86_64 from the official virt ISO. Its kernel builds
`vmwgfx` and `virtio_gpu` as modules, which the tests load with `modprobe`.

- **vmwgfx** picks its display unit by what the device declares: the legacy
  display unit at `2d`, Screen Objects from `2d-full`, Screen Targets from
  `gb9`. Alpine 3.24's vmwgfx draws no cursor on a device without MOBs: below
  `gb9` it logs "Unknown Cursor Type!", although `2d-full` declares the cursor
  caps, so a hardware cursor on Linux needs `gb9` or higher
  (`SVGA_CAP2_CURSOR_MOB`; observed 2026-10-01). It turns 3D on with
  `SVGA_CAP_3D`, and DX contexts with `SVGA_CAP_DX` and the `DXCONTEXT`
  devcap. It makes SM4.1 contexts only with `SVGA_CAP2_DX2` and the `SM41`
  devcap (dmesg: "shader model: SM4_1"), and SM5 contexts with
  `SVGA_CAP2_DX3` and the `SM5` devcap ("shader model: SM_5_1X").
- **Mesa's svga** reports OpenGL 3.3 on DX contexts and OpenGL 4.x only with
  SM5. With SM4.1 it stays at OpenGL 3.3 but adds
  `ARB_texture_cube_map_array`, `ARB_texture_gather`, `ARB_draw_buffers_blend`,
  `ARB_sample_shading` and `ARB_texture_query_lod`, and it multisamples only
  from SM4.1 on. OpenGL 4.3 core (GLSL 4.30) also needs the `GL43` devcap and
  a forced sample count (`MAX_FORCED_SAMPLE_COUNT`) of at least 4, which it
  uses for draws without targets; it then offers compute, tessellation, SSBOs,
  image load/store and `ARB_gpu_shader5`. The `sm41` and `sm5` scenarios of
  `tests/x64/linux_gpu.mjs` check these. Below `dx11-full` there is no
  `DX_PROVOKING_VERTEX`, and Mesa converts flat-shaded index orders itself
  (see the known issues in [gpu-deviations.md](gpu-deviations.md)).
- **virtio_gpu** loads with `+edid` (the preferred mode follows
  `V86.set_display_size`) and, at the blob levels, `+resource_blob`. It uses
  guest blobs and `SET_SCANOUT_BLOB` for its dumb buffers (fbcon, modetest,
  kmscube on llvmpipe) only when there is no virgl; with virgl
  (`virgl43-blob` and up) it keeps using 3D resources for them. It adds
  `+context_init` from `virgl43-blob` and maps host visible memory (BAR4) at
  `virgl43-hostmem`.
- **Mesa's virgl.** Alpine 3.24's Mesa (26.1) is built without virgl, so the
  tests install Alpine 3.23's Mesa 25.2 (`tools/alpine_repo.mjs`). It
  reports OpenGL 3.3 core/compat and GLES 3.0 at `virgl`, OpenGL 4.3
  core/compat and GLES 3.1 from `virgl43`, and offers `ARB_buffer_storage`
  (persistent, coherent mappings) when the capset has
  `VIRGL_CAP_ARB_BUFFER_STORAGE`, at `virgl43-hostmem`.
- **Mesa's venus** (Mesa 26.1, Alpine 3.24's) at level `venus`: see [Venus
  (Vulkan)](#venus-vulkan).

## Snapshots

The devices save device-level checkpoints, not command journals. The graphics
proxy (v86gl) saves a command history and replays it on restore, so its save
grows with everything drawn ([glbridge.md](glbridge.md#7-save-and-restore-graphics-state)).
A composited desktop (DWM, weston) draws all the time, and such a journal
would grow without bound. Instead, `save_state` stops the machine and waits for
the adapter's `prepare_save`: the batches sent so far run, the GPU finishes,
and what only the GPU has is read back into the device's state. At the 2D
levels there is nothing to fetch (`has_host_state` is false).

**Restore checks.** Before anything is restored, `CPU.validate_state` checks
that the snapshot comes from the configured adapter (see [Adapter
plugins](#adapter-plugins)). Then:

- **SVGA** takes the snapshot's level and exactly the capabilities it
  declared (caps, FIFO caps, CAP2, devcaps; stored since its state version 5),
  whatever this machine would pick. It fails if that level has 3D and the page
  has no renderer, or if `vram_size` differs.
- **virtio-gpu** does not adopt the snapshot's level: the machine must have
  picked the same level and the same number of displays (pin them with
  `graphics_adapter_test: { level, scanouts }`), otherwise the restore fails.
  So a snapshot taken at the 3D default does not restore on a page without a
  renderer, and a `venus` snapshot needs a machine pinned to `venus`.

Each device reads every older version of its own state (SVGA 1–6, virtio-gpu
1–3).

**SVGA.**

- **Guest-backed objects** (`gb9` and up) live in guest memory already: MOBs,
  object tables and COTables are in the snapshot with the RAM. A GB surface
  whose newest contents are on the GPU is written back to its MOB before the
  save; after a restore it is made on the GPU again when a command first uses
  it, filled from its MOB. GB shaders keep their bytecode, since the MOB it
  came from may have changed since.
- **DX contexts** are saved in the guest's own `SVGADXContextMobFormat`; a
  restore reloads their objects from the COTables and sets that state again.
- **Legacy contexts and GB contexts** (the legacy commands, also at `gb9` and
  up) keep their state in their D9WG device: a GB context's MOB is only
  remembered, and `READBACK_GB_CONTEXT` and `INVALIDATE_GB_CONTEXT` do nothing.
  For each such context the snapshot keeps its shader definitions and the last
  command for each piece of state (each render state, texture stage state,
  transform, shader constant register and so on).
- **Legacy surfaces** (`SURFACE_DEFINE`, the only kind at `vgpu9`) have no
  guest backing; their color contents are read back into the snapshot. A
  restore defines them again in a fresh D9WG executor, uploads the contents and
  replays each context's commands.
- **Depth and multisampled surfaces** are not read back at any level. A legacy
  one comes back cleared, a GB one with what its MOB last held.

**virtio-gpu.**

- **2D resources** are saved with their host copy (what the last
  `TRANSFER_TO_HOST_2D` put there), not read again from their backing, which
  the guest may have changed since. Guest-memory blobs keep only their backing
  list; blob scanouts keep their format, size, stride and offset.
- **3D resources** are read back from GX, each level's image per layer or
  slice. GX reads back neither multisampled textures nor depth other than
  16-bit and 32-bit float depth, so such resources come back empty.
- **virgl contexts** are saved per sub-context as the commands that made their
  live objects (shaders as their TGSI text) plus gallium's bound state, with
  the blob templates of `PIPE_RESOURCE_CREATE`. A restore makes the resources
  and contexts again in GX and uploads the contents.
- **Host visible memory**: the guest's newest writes are uploaded into their
  blobs first; each mapped blob is saved with its flags, its offset in BAR4 and
  the mapping's bytes.
- **Venus contexts**: see [Venus (Vulkan)](#venus-vulkan).

## Sources and generated code

**Third-party headers.** `third_party/` holds the device interface headers;
nothing there is compiled into v86. Origins, versions and dates are in
[third_party/README.md](../third_party/README.md). Update a directory as a
whole; after `vmware-svga/`, rerun its generators.

| Directory | Contents | From | License |
| --- | --- | --- | --- |
| `vmware-svga/` | SVGA II and SVGA3D, including `VGPU10ShaderTokens.h` | Mesa, `src/gallium/drivers/svga/include/` | GPL-2.0 OR MIT, used under MIT |
| `virgl/` | `virgl_protocol.h`, `virgl_hw.h` | virglrenderer | MIT |
| `virtio/` | `virtio_gpu.h` | Linux, `include/uapi/linux/` | BSD-3-Clause |
| `vulkan/` | Khronos Vulkan-Headers as Mesa 26.1.6 ships them, for `tests/x64/vktest.c` | Mesa, `include/vulkan/` | Apache-2.0 |

**Other sources.**

- GX's tessellator is a port of Microsoft's D3D11 reference tessellator
  (`CHWTessellator` in `tessellator.cpp`, MIT, as Mesa carries it in
  `src/gallium/auxiliary/tessellator`): `src/browser/glbridge/gx/tessellator.js`
  in JavaScript, the reference the tests compare with, and
  `tessellator_wgsl.js`, the same function by function in WGSL with three
  entry points (count, scan with the indirect arguments, generate).
- VX translates SPIR-V with the naga crate (version 30, MIT OR Apache-2.0),
  built from `src/browser/glbridge/vx/naga` to `build/glbridge/vx_naga.wasm`
  by `make glbridge` (with cargo, offline first). If cargo fails, the bundle
  is still built, without `vx_naga.wasm`, and Venus cannot make shaders.
- D9WG is the D3D9 proxy's protocol (`d3d9_protocol.h` 1.7 in the glbridge
  driver sources, [glbridge.md](glbridge.md)).
- The guest drivers are not in the repository: VMware Tools 13.1.5 (x64) and
  virtio-win 0.1.240 are downloaded by the user
  ([windows-nt.md](windows-nt.md#54-windows-81-x64-with-vmware-svga-ii-or-virtio-gpu)).

**Generated code.** SVGA's numbers and Venus's wire format are generated, not
copied. Generated files say so in their first line and are not edited by
hand.

| Generator | Writes | From |
| --- | --- | --- |
| `tools/gen_svga_constants.js` | `src/graphics_adapters/vmware_svga/svga_constants.js`: every numeric `#define` and enumerator | `third_party/vmware-svga` |
| `tools/gen_svga_formats.js` | `src/graphics_adapters/vmware_svga/svga_formats.js`: block layout of each `SVGA3dSurfaceFormat` | `svga3d_surfacedefs.h` and `svga_constants.js` |
| `tools/svga_gx_formats.mjs` | GX's format table, put into `libv86-webgpu.js` as `V86SVGADXFormats` by `make glbridge` | `svga_dx_formats.js`, `svga_formats.js` |
| `tools/venus_protocol_gen.mjs` | `src/graphics_adapters/virtio_gpu/venus_protocol.js`, and with `--guest` `tests/devices/venus_guest_protocol.js` ([Venus](#venus-vulkan)) | Mesa's `src/virtio/venus-protocol` (a Mesa checkout, not in the repository) and `vulkan_core.h` |

`tools/build_glbridge.mjs` (`make glbridge`) also embeds Venus's format table
(`venus_device_info.js`) as `V86VenusFormats` and fails when `vx_executor.js`'s
opcodes differ from `renderer_protocol.js`'s. GX's opcode table in
`gx_executor.js` is kept in step with `renderer_protocol.js` by hand. virgl and
virtio-gpu numbers are written by hand from `third_party/virgl` and
`third_party/virtio/virtio_gpu.h` (`virgl_context.js`, `virgl_caps.js`,
`virtio_gpu_device.js`).

**Source layout.**

| Where | Files |
| --- | --- |
| Core, `src/` | `graphics_adapter.js` (option checks, plugin loader, the machine handle, VGA BIOS patch, `state[52]`); `virtio_devices.js` (`create_adapter_virtio_device`) and `virtio.js` (the virtio transport) |
| `src/graphics_adapters/` | `machine.js` (`register_graphics_adapter`, `GraphicsMachine`), `vga_core.js` (VGA, Bochs VBE, the frame buffer), `renderer_protocol.js` (GX and VX opcodes, `GXWriter`, the response region) |
| `bochs_vga/` | `plugin.js`: the VGA core alone |
| `vmware_svga/` | `svga_device.js` (registers, FIFO, command buffers, IRQ, levels, snapshots), `svga_gmr.js` (GMRs), `svga_gb.js` (MOBs, object tables), `svga_screens.js` (Screen Objects), `svga_cursor.js`, `svga_video.js` (video overlay), `svga3d.js` (legacy and GB 3D, presents), `svga3d_d9wg.js` (D9WG writer), `svga3d_tables.js` (SVGA3D in D3D9 terms, devcaps), `svga3d_dx.js` (DX contexts to GX), `svga_dx_formats.js` (formats and their devcaps), `svga_constants.js` and `svga_formats.js` (generated) |
| `virtio_gpu/` | `virtio_gpu_device.js` (virtio-gpu, 2D, blobs, host visible memory, levels, snapshots), `edid.js`, `virgl.js` (3D resources, transfers, batches), `virgl_context.js` (virgl commands to SVGA DX), `virgl_caps.js` (capsets, formats), `tgsi.js` and `tgsi_vgpu10.js` (TGSI to VGPU10), `venus.js` (Venus transport), `venus_protocol.js` (generated), `venus_vk.js` with `venus_vk_resources.js`, `venus_vk_commands.js` and `venus_vk_pipeline.js` (the Vulkan model), `venus_device_info.js`, `venus_state.js` (snapshots) |
| Renderer, `src/browser/glbridge/` | `svga_renderer.js`, `gx/gx_executor.js`, `gx/tessellator.js` (reference), `gx/tessellator_wgsl.js`, `shader_ir/dxbc_frontend.js`, `shader_ir/wgsl_emitter.js`, `vx/vx_executor.js`, `vx/naga/`; from the D3D9 proxy: `webgpu_host.js` and the D3D9 executor (`d3d9-webgpu/`) |
| Built | `build/v86-bochs-vga.js`, `build/v86-vmware-svga.js`, `build/v86-virtio-gpu.js` (`make graphics-adapters`; the virtio-gpu plugin also contains `svga_cursor.js`, `svga_constants.js` and `svga_dx_formats.js`); `build/glbridge/libv86-webgpu.js` and `build/glbridge/vx_naga.wasm` (`make glbridge`) |

## Tests

Device behavior is brought up on Linux guests first: their drivers (vmwgfx
and Mesa's svga, virtio_gpu and Mesa's virgl and venus) are open source and
can be read when something fails. VMware's Windows driver is closed source,
so Windows runs serve as acceptance tests.

| Layer | Where | Run by |
| --- | --- | --- |
| Plugin framework: option checks (`graphics_adapter` required, `vram_size` a power of two), a plugin loaded only when named (a missing file is reported with its path), `"none"`, snapshots naming their adapter and refusing another, snapshots from before the plugins, the VGA BIOS's PCI IDs | `tests/devices/graphics_adapter.js` | `make devices-test` |
| Device units: registers, FIFO, GMR/MOB, command buffers, video overlay, backdoor RPCI, virtqueues, EDID, blobs, host visible memory, the Venus transport (with sync files and a snapshot), snapshots | `tests/devices/vmware_svga*.js`, `tests/devices/virtio_gpu*.js`, `tests/devices/vmware_backdoor.js`, `tests/devices/mmio_ram.js` | `make devices-test` |
| Venus wire format, against Mesa's C | `tests/devices/venus_protocol.js` | `make devices-test` |
| virgl shaders: TGSI to VGPU10 to WGSL | `tests/devices/virgl_tgsi.js` on the corpus `tests/gpu/shaders/tgsi/` | `make devices-test` |
| VGPU10 decoding and WGSL (up to SM5); the tessellator's JavaScript port | `tests/glbridge/dxbc_wgsl_test.js`, `tests/glbridge/tessellator_test.js` | `make test-glbridge` |
| The SVGA renderer and GX on a real GPU | `tests/glbridge/svga_*_browser_test.html`, `tests/glbridge/tessellator_browser_test.html` | `make display-browser-tests` |
| The renderer channel across a CPU worker | `tests/glbridge/cpu_worker_svga_browser_test.html` | `make cpu-worker-tests` |
| VX on WebGPU | `tests/glbridge/vx_transfer_browser_test.html` | the browser runner (no make target) |
| Linux guests | `tests/x64/linux_gpu.mjs` | by hand |
| Windows 8.1 guest | `tests/x64/windows_boot.mjs`, `tools/windows/` | by hand |

CI (`.github/workflows/ci.yml`) runs `make devices-test` and
`make test-glbridge`. The browser tests need a GPU and Chrome, the guest runs
need images; they are run by hand.

### Shader tests

- **`dxbc_wgsl_test.js`** assembles VGPU10 programs in the test, decodes them
  with `dxbc_frontend.js` and checks the WGSL `wgsl_emitter.js` writes.
- **`virgl_tgsi.js`** takes the TGSI corpus (as Mesa's virgl driver sent it
  in guest runs) through `tgsi.js`, `tgsi_vgpu10.js`, GX's decoder and the
  WGSL emitter.
- **naga**: both validate the WGSL with naga when it is installed
  (`cargo install naga-cli`, or `D9_NAGA=<path>`); without it, as in CI, they
  check only its shape.
- Shaders are not executed to compare numbers; gltest's data cases check
  results in the guest. There is no DXBC corpus in the repository
  (`linux_gpu.mjs` writes a run's DX shaders to `<GPU_OUT>/dxbc/`).

### Browser tests on a real GPU

`node tests/glbridge/gl_multipass_browser_runner.js <page>` runs a page of
`tests/glbridge/` in a headless Chrome with WebGPU. `GL_CHROME` selects the
browser, `GL_TIMEOUT_MS` the time a page has (60 s by default); files a page
saves land in `build/browser-test-output/`. No guest system boots: each page
drives the device's 3D layer or the renderer directly (the CPU worker test
through a small guest program) and checks the pixels it reads back.

- **Legacy 3D**: `svga_renderer` (SVGA3D commands through `svga3d.js`, D9WG
  batches through `svga_renderer.js` and the D3D9 executor: a triangle
  presented on a Screen Object, a texture uploaded with `SURFACE_DMA` and read
  back into guest memory); `svga_fixed_function` (what VMware's D3D9 driver
  sends for a textured quad of pre-transformed vertices, with a GB texture at
  level `dx10`).
- **DX and GX**: `svga_dx` (GB surfaces in MOBs, a DX context, VGPU10 shaders
  through `svga3d_dx.js` and GX, the picture back in its MOB); `svga_share`
  (a D3D9 application's surface and DWM's DX surface, moved between D9WG and
  GX on the GPU with `SURFACE_IMPORT`/`SURFACE_EXPORT`); `svga_gs`;
  `svga_so` (stream output and `DrawAuto`, also after a geometry shader);
  `svga_pull` (vertex pulling for a layout WebGPU's vertex fetch cannot
  take); `svga_depth_upload` (a D24S8 upload drawn in, its stencil copied);
  `svga_msaa` (4x and 8x supersampling, an RGBA32F multisampled target,
  per-sample shading, a one-sample mask); `svga_cube_array`; `svga_compute`
  (a typed UAV, an append buffer and its counter, atomics, a UAV clear, a
  pixel shader writing a UAV without targets); `svga_tess` (a quad patch
  through hull shader, tessellator and domain shader).
- **Tessellator**: `tessellator_browser_test.html` compares the WGSL
  tessellator with the JavaScript port on random patches of every domain,
  partitioning and output primitive. `tessellator_test.js` checks the port
  in node against point and index checksums of Microsoft's reference
  (CHWTessellator) built natively.
- **CPU worker**: `cpu_worker_svga_browser_test.html` runs the SVGA device in
  the CPU worker and its renderer on the page. A guest program finds the card
  on PCI, defines a GMR by registers and submits a command buffer that
  defines a surface, clears it and DMAs it into the GMR. The readback must
  reach guest RAM before the buffer completes, and again after
  `save_state`/`restore_state`.
- **VX**: `vx_transfer_browser_test.html` runs VX batches through the page's
  renderer: memory writes, copies, fills and updates, buffer-image copies of
  WebGPU's pitch and of others, clears, blits, resolves and readbacks.

### Linux guests

Prepare once:

```sh
X64_LINUX_PREPARE_ONLY=1 node tests/x64/linux_boot.mjs
node tools/alpine_repo.mjs
```

- **The guest** is Alpine 3.24 x86_64 from the official virt ISO.
  `linux_boot.mjs` downloads `alpine-virt-3.24.0-x86_64.iso` and unpacks its
  `linux-virt` kernel and initramfs into `build/x64-linux/`. The DRM drivers
  `bochs`, `vmwgfx` and `virtio_gpu` are modules of that kernel.
- **The test disk** `build/x64-linux/gpu-repo.tar` is a local Alpine
  repository that `alpine_repo.mjs` fills with the dependency closure of
  Mesa, kmscube, mesa-demos, mesa-utils, libdrm-tests, weston (DRM backend,
  desktop shell, terminal, clients), seatd, vulkan-tools, and Mesa's Venus
  (`mesa-vulkan-virtio`) and lavapipe (`mesa-vulkan-swrast`) Vulkan drivers.
  It keeps Alpine's signed APKINDEX, so the guest installs offline
  (`apk add --no-network`).
- **Mesa with virgl**: Alpine 3.24's Mesa (26.1) has the svga and Venus
  drivers but no virgl driver. The repository's `v3.23/` holds Alpine 3.23's
  Mesa 25.2, which has it. The `gltest` and `virgl` scenarios install Mesa's
  packages and `llvm21-libs` from there, pinned with the `@v323` tag so that
  nothing else comes from it.
- Both tools need `bsdtar` and the network. OpenGL workloads are kmscube,
  weston's clients, `es2gears_wayland` and gltest; glmark2 is not packaged for
  Alpine 3.24.

`tests/x64/linux_gpu.mjs` boots the unmodified ISO with the repository as
`/dev/sda`, installs what the scenario needs, loads the adapter's DRM driver
with `modprobe`, runs the scenario's steps on the serial console and saves
screenshots. The x86 harness has no make target.

**arm64** (`tests/a64/linux_gpu.mjs`, `GPU_ARCH=aarch64`;
`make a64-gpu-guest-tests`): the same scenarios on the virt machine's
virtio-gpu without VGA, from `build/a64-linux/` (`node tools/alpine_repo.mjs
--arch aarch64`), the ISO, the repository and the test programs on
virtio-blk disks found by their serials (`$REPO`, `$TESTS` in the steps),
1.5 GiB of RAM (the aarch64 packages need more root file system), the page
tier, the GPU on the PCIe host (`GPU_TRANSPORT=mmio`: virtio-mmio). The
guest's programs start about three times slower than on x86, so the steps'
sleeps, timeouts and screenshot delays are three times as long. Two more
scenarios use the virt machine's virtio-input and KMS:

```sh
GPU_ADAPTER=vmware_svga GPU_LEVEL=dx11-full GPU_RENDERER=chrome GPU_SCENARIO=gltest node tests/x64/linux_gpu.mjs
```

| Variable | Meaning |
| --- | --- |
| `GPU_ADAPTER` | `bochs_vga` (default), `vmware_svga`, `virtio_gpu` |
| `GPU_SCENARIO` | the steps (below); `drm` by default |
| `GPU_LEVEL` | pins the level (`graphics_adapter_test`). Without it the adapter has no renderer and runs at its 2D default |
| `GPU_RENDERER=chrome` | at a 3D level: the renderer in a headless Chrome. Without it the batches are recorded as a trace and answered with zeros |
| `GPU_OUT` | the output directory; `build/x64-linux/gpu-<adapter>[-<level>]/` by default |
| `LINUX_GPU_MEMORY` | guest RAM in MiB: 1024, or 1536 for the `virgl` and `vkcube` scenarios and on arm64 |
| `LINUX_GPU_TIMEOUT` | in ms; 900000 by default (arm64: 2700000) |
| `GPU_SCREENSHOT_AFTER` | ms from a step's command to its screenshot, for every step |
| `SHOW_LOGS=1` | echoes the serial console |
| `VRAM_SIZE` | the adapter's `vram_size` in bytes |
| `TEST_RELEASE_BUILD=1` | runs `build/libv86.mjs` instead of the source tree |

| Scenario | Steps |
| --- | --- |
| `drm` | modes (`modetest -c`), the driver's messages, kmscube |
| `gl` | eglinfo, a textured kmscube, weston on DRM with `weston-simple-egl` and `weston-simple-shm`, a host-side `set_display_size` |
| `sm41` | `vmware_svga` at `dx10.1`: "shader model: SM4_1" in dmesg, OpenGL 3.3 with the five SM4.1 extensions, kmscube with 4x MSAA |
| `sm5` | `vmware_svga` at `dx11`: "shader model: SM_5_1X", OpenGL 4.3 core with `ARB_compute_shader`, `ARB_tessellation_shader`, `ARB_shader_storage_buffer_object`, `ARB_shader_image_load_store` and `ARB_gpu_shader5`, kmscube with 8x MSAA |
| `gltest` | `tests/x64/gltest.c` on the adapter's 3D driver |
| `virgl` | `virtio_gpu`'s capsets and features, the GL 3.0 and GLES 3.0 prerequisites Mesa does not offer, eglinfo, gltest, kmscube, a snapshot while kmscube draws, gltest again, weston with `weston-simple-egl` and `es2gears_wayland` |
| `venus` | vulkaninfo on lavapipe and on Venus, then `tests/x64/vktest.c` on both |
| `vkcube` | weston (pixman) and vkcube on Venus: the WSI extensions, the surface's formats and modes, a timed run, a snapshot while it draws |
| `resize` | `virtio_gpu` loads with `+edid` with 1024x768 preferred. After the host's `set_display_size(1280, 800)`, a KMS probe (`modetest -c`) lists 1280x800 as preferred and `modetest -s` sets it (sysfs `modes` lists only what fbdev's probe kept). Then a snapshot saved and restored in place, and kmscube on llvmpipe |
| `kms` | (arm64, at `virgl43-hostmem`) what Android needs of KMS: the planes (primary and cursor), an atomic commit of the mode and the primary plane, the cursor, `EGL_ANDROID_native_fence_sync` and dma-buf import and export, weston-simple-dmabuf-egl through linux-dmabuf with and without explicit synchronization |
| `input` | (arm64, virtio-input) weston with its input devices: text typed into weston-terminal (which runs it), the pointer moved and clicked, two touches read from the multi-touch screen's evdev node. The live system has eudev's libudev but no udevd, so the step writes the udev database entries libinput needs (`ID_INPUT_*`); keys are typed 400 ms apart, as faster ones overflow evdev's buffer while weston renders in software (SYN_DROPPED) |
| `custom` | the steps in the JSON file `GPU_STEPS`, for debugging |

- **gltest** (GLES 3.0, plus GL 3.3 and 4.3 cases when the driver has them)
  draws each case into a 64×64 framebuffer object, first with llvmpipe
  (`LIBGL_ALWAYS_SOFTWARE=1 gltest ref`), then with the driver under test
  (`gltest cmp`), and compares them in the guest. A failing case sends both
  pictures to the host, which saves them as PNG; a case that compares numbers
  prints the first differing word with both values.
- **vktest** has 27 cases: transfers, clears, blits and resolves, fences,
  timeline semaphores and events, mapped memory, draws, depth, blending with
  MSAA, textures, compute, queries, secondary command buffers, indirect draws,
  mipmaps, storage images and dynamic rendering. Each checks its results
  against what they must be; lavapipe runs them first, as the reference. On
  arm64, Alpine 3.24's lavapipe crashes (SIGSEGV) in the 12 cases that build a
  graphics pipeline, QEMU's guest too; there it runs a case a process
  (`vktest list` names them) and Venus must pass all 27.
- **Building them**: `linux_gpu.mjs` builds gltest and vktest on the host
  without C library headers: clang (`--target=x86_64-unknown-linux-musl`, or aarch64;
  `CLANG` overrides) and rust-lld from the Rust toolchain (`LD_LLD`
  overrides), linked against musl's loader and Mesa's `libEGL` (vktest: the
  Vulkan loader) from the repository's packages, and handed to the guest as a
  tar disk on `/dev/sdb`. vktest's shaders (`tests/x64/vktest_shaders/`) are
  compiled by naga (`NAGA` overrides); vkcube's are taken from the guest's
  vulkan-tools package.
- **Debugging**: the harness saves each shader the guest sends once: virgl's
  TGSI text into `<GPU_OUT>/tgsi/`, `vmware_svga`'s DX shaders (VGPU10
  tokens) into `<GPU_OUT>/dxbc/`; the TGSI corpus came from such runs.
  `VENUS_TRACE=1` logs Venus commands (2: all of them, and the model's
  messages), `GPU_DEBUG_VIRGL=1` virgl's, `GPU_DEBUG_BLITS=<n>` the first n
  `BLIT_SURFACE_TO_SCREEN` commands; `VKTEST_ONLY` picks vktest cases.

### Windows guests

`tests/x64/windows_boot.mjs` runs on a Windows 8.1 x64 image the user
supplies (`WIN_IMAGE`; not in the repository). The image is opened read-only:
every guest write stays in a RAM overlay, and at the end the harness checks
that the image's modification time has not changed. Lines written to
`<out>/command.txt` drive the guest (keys, text, the Run dialog, snapshots).
The guest's setup (driver packages, test signing, TDR values, preinstalled
drivers, services, 3DMark06 states) is in [windows-nt.md, section
5.4](windows-nt.md#54-windows-81-x64-with-vmware-svga-ii-or-virtio-gpu).

| Variable or command | Meaning |
| --- | --- |
| `WIN_GRAPHICS_ADAPTER` | `bochs_vga` (default), `vmware_svga` or `virtio_gpu` |
| `WIN_SVGA_LEVEL` | pins `vmware_svga`'s level |
| `WIN_GPU_RENDERER=chrome` | the renderer in a headless Chrome; the device then takes its default 3D level, `dx11-full` |
| `WIN_CDROM=<iso>` | a CD-ROM: drivers, test programs |
| `WIN_HDB=<image>` | a second disk, read-only like the first (3DMark06 is on one) |
| `WIN_OVERLAY_SAVE=<file>`, `WIN_OVERLAY_LOAD=<file>` | after a full shutdown, what the guest wrote (the drivers it installed) is saved; a later boot starts with it |
| `WIN_LAUNCHER=<guest path of LAUNCH.EXE>` | starts the launcher from the Run dialog once the desktop shows; `WIN_LAUNCHER_ADMIN=1` elevates it through UAC once |
| `WIN_NO_PROBE=1` | no qualification probe, whose Run dialog takes the focus from full-screen programs such as 3DMark06; no signing in again unless a password box shows |
| `svgalog on`/`off`, `svgashaders` | commands: the SVGA3D commands other than DX and the frequent GB ones as `svga3d-command` events; the GB shaders' bytecode as `svga3d-shader` events |
| `savestate <file>`, `WIN_STATE_LOAD`, `WIN_RATES`, `WIN_CPU_PROFILE` | measuring from a saved state: [profiling.md](profiling.md) |

**The launcher.** Typing into the Run dialog loses keys while the guest is
busy. Programs are therefore started by `tools/windows/launch.c`
(`LAUNCH.EXE`), started once as the signed-in user. It asks for
`guestinfo.v86.run` through the VMware backdoor once a second; a line
`launch <command line>` in `<out>/command.txt` sets that value, and the
launcher runs the command line with `cmd /c` in its session.

**Diagnostic tools** in `tools/windows/` are built with mingw-w64 (the
command is in each file's header). They report through the VMware backdoor as
RPCI log lines, which the harness prints; v86 lets user mode use the backdoor
port, as VMware does.

| Tool | What it does |
| --- | --- |
| `d3d11cmp.c` | 15 D3D11 cases at FL10_0, 10_1 and 11_0, drawn by the hardware driver (GX) and by WARP and compared; HLSL compiled in the guest by `d3dcompiler_47` |
| `d3d9step.c` | a D3D9 application that logs each call, its features turned on one at a time, so a hang shows which call it was in |
| `d3dprobe.c` | the DXGI adapters, D3DKMT queries, a D3D11 hardware device, a D3D9 HAL device with its caps; also opens the user-mode driver directly (`OpenAdapter`, `OpenAdapter10_2`) |
| `kmtinfo.c` | what `vm3dmp.sys` hands its D3D10/11 user-mode driver: the feature-level flags, caps, CAP2 and the devcaps as the kernel driver read them |
| `dbwin.c` | what programs in its session write with `OutputDebugString` (D3D9's validators say there why a call failed) |
| `rpcilog.c` | a text file's lines |
| `runs1.c` | starts a program in the console session, where the logon screen and DWM run, from the agent in session 0 |
| `agent/INSTALL.CMD`, `agent/AGENT.CMD` | a SYSTEM task at every start. Every 90 s it sends the task list, the System and Application event logs and the logs of VMware's user-mode driver (written to `C:\vm3dum_log`), and runs `AGENT\EXTRA.CMD` from a disc for one-off diagnostics |

In a session whose DWM had failed, `runs1` could not start programs
(0xC0000142). DWM's, DXGI's and D3D11's Event Tracing channels, read from
.etl files, were of little use: their events had no descriptions.

### Traces and the remote renderer

- **Remote renderer** (`tests/x64/gpu_remote_renderer.mjs`): gives a guest
  running in node a real GPU. The renderer (`svga_renderer.js`, on the page
  `tests/glbridge/svga_remote_renderer.html`) runs in a headless Chrome with
  WebGPU and talks to the device over a WebSocket: submits of D9WG, GX and VX
  batches, reset, write, done, lost, ready and log lines. The node harnesses
  keep their automation (screenshots of the device's picture, keys,
  overlays). `GPU_RENDERER=chrome` selects it in `linux_gpu.mjs`,
  `WIN_GPU_RENDERER=chrome` in `windows_boot.mjs`; `GL_CHROME` selects the
  browser.
- **Traces** (`tests/x64/gpu_trace.mjs`): at a 3D `GPU_LEVEL` without
  `GPU_RENDERER=chrome`, `linux_gpu.mjs` gives the device a renderer that
  records every batch into `<GPU_OUT>/trace.bin` and answers at once,
  readbacks with zeros and queries with 0, so the guest runs as if its frames
  were black. Batches are self-contained, so a trace is just their sequence.
  The file is `V86GTRC1`, then records of (u32 type, u32 length, bytes): type
  2 a JSON note (adapter, level, scenario), type 1 a batch. The recorder and
  the replayer treat every batch as D9WG, so traces serve `vgpu9` and `gb9`.
- **Replay** runs a trace through the SVGA renderer on a real GPU without the
  guest, to fix the renderer without booting:

  ```sh
  GL_TIMEOUT_MS=600000 node tests/glbridge/gl_multipass_browser_runner.js \
      'svga_trace_replay_browser_test.html?trace=build/x64-linux/gpu-vmware_svga-vgpu9/trace.bin'
  ```

  It fails on commands the executor could not run and saves the last picture
  of each read-back texture as `build/browser-test-output/trace-<texture>.png`.
  Traces stay under `build/`; none are in the repository.

### Reference pictures

No reference images are kept in the repository; each test makes its
reference when it runs. gltest draws every case with llvmpipe in the same
guest first, vktest checks against computed values, `d3d11cmp` compares with
WARP in the same guest, and the browser tests check the pixels they read
back. 3DMark06 runs are not compared with reference pictures; the harness
saves screenshots (`WIN_SHOT_MS`).

## Performance

Every guest driver runs on the emulated CPU: on Windows, VMware's user-mode
driver (which turns D3D9 and D3D11 into SVGA3D), dxgkrnl's scheduling and the
kernel driver; on Linux, Mesa's drivers and the DRM drivers. The device and
the renderer add little, so frame rates are bound by CPU emulation, not by
WebGPU. How to measure a Windows guest from a saved state is in
[profiling.md](profiling.md).

### 3DMark06 on Windows 8.1

Measured 2026-10-02: `vmware_svga` at `dx11-full`, the release build
(`TEST_RELEASE_BUILD=1`), 1 core and 2048 MB (the harness's defaults),
3DMark06 on a second disk (`WIN_HDB`), the renderer in headless Chrome
(`WIN_GPU_RENDERER=chrome`). 3DMark06 at its default settings (1280×1024) was saved 90 s into
its run (`savestate`), and every run started from that state
(`WIN_STATE_LOAD`), so all comparisons cover the same stretch of the scene.
Frames are screen target updates and MIPS the guest's retired instructions
(`WIN_RATES`); host shares come from `WIN_CPU_PROFILE`.

**Where the time goes.**

- **The GPU side is not the bottleneck.** The guest never halts (0% halted),
  fences are almost never pending, the renderer's latency is 2–20 ms and its
  backlog about 0. In GT2 the device sends about 100 MB/s of batch data,
  nearly all of it `UPDATE_GB_IMAGE` uploads the guest driver asks for (10–22
  a frame, 30–60 MB a frame).
- **Where the host's time goes**, by call stack (a runtime helper counts for
  the guest code that called it; device work a port write starts counts for
  the device), in GT2 (Firefly Forest, about 2000 draws a frame), three runs:
  3DMark06's own code (the exe, D3DX, its C runtime) 21–22%; the D3D9
  runtime, VMware's D3D9 driver and the graphics kernel (`dxgkrnl`,
  `dxgmms1`, `vm3dmp.sys`) 16%; the Windows kernel and WOW64 14%; background
  services 2–3%; the emulator's dispatchers and its runtime outside compiled
  code 16%; the SVGA device's JavaScript (parsing SVGA3D, reading guest
  memory, writing D9WG batches) 10% and the renderer channel 5% (a WebSocket
  in node); host GC, the harness and idle time the rest. For comparison,
  with the D3D9 proxy on Windows XP ([glbridge.md](glbridge.md); the 3DMark06
  demo, measured 2026-09-27) 3DMark06's own code took about 58% of the host
  and the proxy 6–9%: per unit of 3DMark06's work, Windows 8.1 with the real
  driver stack costs the host about 2.8 times as much.
- **System overhead slows the guest.** In the game tests the guest runs at
  100–300 MIPS, in the CPU tests (PhysX, pure computation) at 900–1100 MIPS.
  The difference is kernel and WOW64 transitions and address translation, not
  3DMark06's own code. 3DMark06, d3d9 and VMware's user-mode driver are 32-bit
  code running under WOW64 in compatibility mode.
- **A frame is about 100 million guest instructions.** GT1 (Return to
  Proxycon) makes 1100–1500 draws and 4400–4900 shader constant updates a
  frame, GT2 (Firefly Forest) 1500–2300 draws and 1700–3600 updates, each
  through 3DMark06, d3d9, VMware's user-mode driver and the WDDM kernel. DWM and background
  services add to that: `sppsvc`, `sysmain` and `cbscore` together take 3–4%
  of the host.

**What was fixed.** In IA-32e mode, 32-bit (WOW64) code filled the 32-bit
TLB, but only compiled code read it: the dispatchers, the interpreter and the
runtime's memory accesses took the full x64 translation every time, about 19%
of the host under 3DMark06. Since commit 8b07a790 compatibility mode uses the
32-bit TLB everywhere ([x86-64.md](x86-64.md), "Compatibility-mode code goes
through the 32-bit JIT"; the `x64_page_stat` counters in
[profiling.md](profiling.md) show the refills).

Same state, same stretches of rendering:

| Version | GT1 (Return to Proxycon): fps (MIPS) | GT2 (Firefly Forest): fps (MIPS) |
| --- | --- | --- |
| Before (4 runs) | 1.35–1.66, mean 1.48 (about 219) | 1.70–1.99, mean 1.86 (about 160) |
| After (3 runs) | 1.37–1.74 (179–254) | 2.30–2.58, mean 2.43 (204–231) |

GT2 renders about 30% faster; GT1's change is within the noise.

**The ceiling.** 30 fps in 3DMark06 is out of reach. At about 100 million
instructions a frame, 30 fps needs 3000 MIPS, and the emulator reaches about
1000 MIPS even on pure computation. With all of the game tests' system
overhead gone, at the CPU tests' speed, the game tests would still get only
about 10 fps.

**What could still help**, by estimated gain:

1. **Multiple cores**: DWM, kernel work and background services on another
   host thread, estimated 10–30%. With 2 cores and vCPU workers
   (`WIN_CORES=2 WIN_PARALLEL=1`) Windows booted, but the launcher never
   reported ready, so nothing was measured; the cause is not known.
2. **The dispatchers** `execute_inner` (page tier, `src/rust/x64/pages.rs`)
   and `t0_execute` (32-bit Tier-0, `src/rust/ir/runtime/cache.rs`) take
   5–12% together: their chaining rate and the cost of entering page
   functions.
3. **The generated code** (40–50% of the host): the code quality of x64 page
   functions and of compatibility-mode Tier-0 ([x86-64.md](x86-64.md));
   long-term work.
4. **The guest's background services** (SPP, SysMain, Windows Update): turning
   them off is estimated at 3–5%. That is the image's configuration
   ([windows-nt.md, section 5.4](windows-nt.md#54-windows-81-x64-with-vmware-svga-ii-or-virtio-gpu)); the harness never writes the
   image.

Runs in node also pay for the harness's own work, which a page in the
browser does not do ([profiling.md](profiling.md)).

### Linux guests: frame rates

kmscube on Alpine 3.24 (measured 2026-10-01 and 02; the 3D levels on a real
GPU through `GPU_RENDERER=chrome`):

| Adapter and level | Rendering | kmscube |
| --- | --- | --- |
| `bochs_vga` | llvmpipe in the guest | about 15.6 fps (login after about 27 s) |
| `vmware_svga` `2d` | llvmpipe, on vmwgfx's legacy display unit | about 9 fps |
| `vmware_svga` `vgpu9` | Mesa's svga ("SVGA3D; build: RELEASE; LLVM;"), the same picture as llvmpipe's | about 43 fps |
| `vmware_svga` `gb9` | Mesa's svga, GB objects and Screen Targets | about 43 fps |
| `vmware_svga` `dx10` | Mesa's svga, DX path (SM4) | about 56 fps |
| `vmware_svga` `dx10.1`, `dx11` | Mesa's svga with 4x and 8x MSAA (`sm41`, `sm5`) | about 40 fps |

On virtio-gpu:

- **Fences wait for the GPU.** A virgl `SUBMIT_3D` is answered, and its
  fence completes, only after the renderer has run everything sent before it.
  Control queue answers stay in order, so the answers to later requests wait
  too: every fence the guest waits for is a round trip through the renderer
  channel.
- **Host visible memory** helps only buffers made with `glBufferStorage`
  (persistent mappings). Mesa's streaming uploader does not ask for
  persistent mappings, so ordinary uploads still go through transfers, and
  kmscube runs at `virgl43-hostmem` at the same frame rate as at
  `virgl43-blob` (measured 2026-10-02).

## Not done and deferred

Larger items that were left out or put off, with what is known about doing
them. Smaller gaps are listed in [gpu-deviations.md](gpu-deviations.md#not-done).

- **virtio-gpu 3D on Windows** is deferred. Windows guests get 3D from VMware
  SVGA II; on virtio-gpu, viogpudo is a 2D driver. Two routes are known:
  - *Through the v86gl graphics proxy* ([glbridge.md](glbridge.md)), with
    virtio-gpu left at 2D. `v86gl.sys` is a WDM driver built today with
    32-bit MinGW for XP. It would need an x64 build (MinGW compiles WDM
    drivers), WOW64 thunking of its IOCTL structures for 32-bit callers
    (`IoIs32bitProcess`), and test signing (`bcdedit /set testsigning on` in
    the guest, `osslsigncode` on the host). The 32-bit `d3d9.dll`,
    `d3d8.dll`, `ddraw.dll` and `opengl32.dll` proxies would keep working
    under WOW64, which suits 3DMark06, a 32-bit program.
  - *A native WDDM 3D driver for virtio-gpu*: a WDDM 1.3 kernel driver plus
    D3D9 and D3D10/11 user-mode drivers emitting virgl or D9WG commands.
    MinGW-w64 has no WDDM headers (declare them by hand, or build with the
    WDK and MSVC on Windows), and VidMm, paging and preemption in a full WDDM
    driver are very hard to debug. The only upstream attempt, viogpu3d
    (kvm-guest-drivers-windows PR #943: Windows 10 and newer, a D3D10
    user-mode driver built from Mesa, with a patched virglrenderer on the
    host), was submitted in 2023, never merged, and does not cover Windows
    8.1.
- **Scanout from the GPU.** Every 3D present is read back into the device's
  picture (G-31), and the device draws cursors and the SVGA video overlay over
  that picture. Showing a 3D scanout straight from its GPU texture in the
  page's compositor, with a separate cursor plane, is not done; it would save
  the readback per present.
- **Levels and the WebGPU adapter.** A level is chosen by whether a renderer
  exists, not by what the WebGPU adapter offers, and GX adapts to a missing
  feature only in a few places ([Architecture](#architecture), WebGPU
  features). The known remedy: a minimum set of WebGPU features and limits per
  level, and a level the adapter cannot meet is not offered.
- **Not declared, with reasons.**
  - VMware SVGA3 (PCI `15AD:0406`): Windows 8.1 has no use for it; VMware's
    ARM guests need it. It could be added as an interface layer in front of
    SVGA II's command handling.
  - virtio-gpu declares the capsets VIRGL (1), VIRGL2 (2) and, at level
    `venus`, VENUS (4). GFXSTREAM_VULKAN (3), CROSS_DOMAIN (5) and DRM (6,
    native contexts) are not declared: they need Android's gfxstream on the
    host, Wayland passthrough to a host compositor, and a host kernel GPU
    driver, none of which a browser has.
- **Not tried in a guest.**
  - VMware's Windows OpenGL ICD, from the same "VMware SVGA 3D" package.
    Windows acceptance covers D3D9 (3DMark06), D3D10/11 (`d3d11cmp.c`,
    compared with WARP) and DWM.
  - Windows XP with VMware Tools 10.0.x, whose XPDM driver supports SVGA II;
    how much 3D it offers is unknown. 3D on XP goes through the v86gl proxies
    ([glbridge.md](glbridge.md)), which work with any `graphics_adapter`.
  - glmark2 (Alpine 3.24 has no package; it needs its own download), Unigine
    Heaven and 3DMark 11 (D3D11 workloads, separate downloads).
