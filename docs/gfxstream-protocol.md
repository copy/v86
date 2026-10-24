# gfxstream over virtio-gpu: the protocol v64 implements

The guest side of the official Android images' GPU path, as read from the
sources of the pinned build (docs/gfxstream-plan.md G0). v64's host side
(the plan's G1-G5) implements this; the guest is not changed.

## Pinned sources

Cuttlefish `aosp_cf_arm64_only_phone-userdebug` 15581820 (BP4A.251205.006,
`android16-qpr2-release`), from its `manifest_15581820.xml`:

| Project | Revision | What is there |
| --- | --- | --- |
| `device/google/cuttlefish` | `4d368849922b04124e66b1aad48f93b3209f3c8d` | the launcher: GPU modes, bootconfig, the VMM's device |
| `platform/external/mesa3d` | `d4b6f1eba289310b16ee77bedb3c1cf467b6b6fd` | the guest's gfxstream Vulkan driver and transport (`src/gfxstream/guest`), the virtio-gpu protocol header (`src/virtio/virtio-gpu/virtgpu_gfxstream_protocol.h`) |
| `platform/hardware/google/gfxstream` | `7e9d595b097b23f5fa5c114088245c819e29a9af` | the host (`host/`), the guest's GLES encoders and renderControl (`guest/`) |
| `platform/external/angle` | `ff25cbdfe963e149e1a1ef4689e502270dfe6214` | ANGLE, the guest's GLES on Vulkan |
| `platform/external/minigbm` | `b7c93249f685222a524c51403719493cc114ff5d` | the guest's gralloc |

## The guest's pieces

In the image (read from a booted guest, build/a64-android/rootfs.tar):

- `vulkan.ranchu.so` in the `com.google.cf.vulkan` APEX: gfxstream's Vulkan
  driver (mesa), beside `vulkan.pastel.so` (SwiftShader).
- ANGLE in system (`libEGL_angle.so`, `libGLESv2_angle.so`): with
  `gfxstream_guest_angle` GLES runs on the guest's Vulkan, there is no host
  GLES. (`libEGL_emulation.so`, gfxstream's own GLES encoders, are unused.)
- `android.hardware.graphics.composer3-service.ranchu` in the composer APEX,
  with `lib_renderControl_enc.so` and `libOpenglSystemCommon.so`: the HWC
  speaks renderControl to the host (the composer capset), and scans out
  through DRM.
- minigbm's allocator and mapper.

## The launcher's choices

`gpu_mode=gfxstream_guest_angle` (host/libs/vm_manager/qemu_manager.cpp,
`ConfigureGraphics`) puts into bootconfig:

```
androidboot.cpuvulkan.version=0
androidboot.hardware.gralloc=minigbm
androidboot.hardware.hwcomposer=ranchu
androidboot.hardware.hwcomposer.display_finder_mode=drm
androidboot.hardware.hwcomposer.display_framebuffer_format=rgba
androidboot.hardware.egl=angle
androidboot.hardware.vulkan=ranchu
androidboot.hardware.gltransport=virtio-gpu-asg
androidboot.opengles.version=196609
```

and gives QEMU `virtio-gpu-rutabaga,gfxstream-vulkan=on,x-gfxstream-composer=on,hostmem=256M`
(plain `gfxstream` adds `x-gfxstream-gles=on` and sets `egl=emulation`).
On macOS hosts the launcher offers no gfxstream mode (graphics_flags.cc:
`guest_swiftshader` or `drm_virgl` only). v64's device model has the mode as
`gpu_modes.gfxstream` (src/android/devices.js).

## virtio-gpu

Capsets (`VirtGpuCapset`): `3` gfxstream Vulkan, `8` gfxstream GLES, `9`
gfxstream composer (`4` is Venus, `5` cross-domain). Each guest connection
is a virtio-gpu context created with its capset (context init). The capsets'
contents, 32-bit little-endian fields:

| Capset | Fields in order |
| --- | --- |
| Vulkan (3) | `protocolVersion`, `ringSize`, `bufferSize`, `colorBufferMemoryIndex`, `deferredMapping`, `blobAlignment`, `noRenderControlEnc`, `alwaysBlob`, `externalSync`, `virglSupportedFormats[16]`, `vulkanBatchedDescriptorSetUpdate`, `hasTraceAsyncCommand` |
| GLES (8), composer (9), magma (7) | `protocolVersion`, `ringSize`, `bufferSize`, `blobAlignment` |

gfxstream's own host fills them (host/VirtioGpuFrontend.cpp `fillCaps`):
every capset `protocolVersion` 1, `ringSize` 12288 (the ring storage's three
pages), `bufferSize` 1 MiB, `blobAlignment` the host's page size; Vulkan's also
`noRenderControlEnc` 1, `deferredMapping` 1 and `colorBufferMemoryIndex` the
guest memory type of color buffers when it emulates Vulkan,
`vulkanBatchedDescriptorSetUpdate` per its feature, `hasTraceAsyncCommand` 1,
`virglSupportedFormats` a bitmask of the virgl formats it can sample and
render (B5G6R5, B8G8R8A8/X8, NV12, P010, R10G10B10A2, R16, R16G16B16A16F, R8,
R8G8, R8G8B8, R8G8B8A8/X8, YV12, Z16, Z24S8, Z24X8, Z32FS8X24, Z32F), and
`alwaysBlob`, `externalSync` 0 unless built with the unstable flags.

Execbuffer commands (`virtgpu_gfxstream_protocol.h`), each starting with a
32-bit `opCode`:

| Opcode | Command | Then |
| --- | --- | --- |
| `0x1001` | `CONTEXT_CREATE` | `resourceId`: the blob that holds the context's ASG ring |
| `0x1002` | `CONTEXT_PING` | `resourceId`: new data on the ring |
| `0x1003` | `CONTEXT_PING_WITH_RESPONSE` | `resourceId` |
| `0x9000` / `0x9001` | `CREATE_EXPORT_SYNC` / `CREATE_IMPORT_SYNC` | `syncHandleLo`, `syncHandleHi` |
| `0xa000` / `0xa001` | `CREATE_EXPORT_SYNC_VK` / `CREATE_IMPORT_SYNC_VK` | `deviceHandleLo/Hi`, `fenceHandleLo/Hi` |
| `0xa002` | `CREATE_QSRI_EXPORT_VK` | `imageHandleLo/Hi` |
| `0xa003` | `RESOURCE_CREATE_3D` | `target`, `format`, `bind`, `width`, `height`, `depth`, `arraySize`, `lastLevel`, `nrSamples`, `flags`, `pad`, then 64-bit `blobId` |
| `0xa004` | `ACQUIRE_SYNC` | `padding`, 64-bit `syncId` |
| `0xf002` | `PLACEHOLDER_COMMAND_VK` | `pad`, `padding` |

## A connection: the ASG ring in a blob

`createVirtioGpuAddressSpaceStream` (mesa `src/gfxstream/guest/GoldfishAddressSpace/VirtioGpuAddressSpaceStream.cpp`):

1. `ringSize`, `bufferSize` and `blobAlignment` from the context's capset.
2. A blob: `blobMem` host3d, mappable, `blobId` 0, size
   `ALIGN(ringSize + bufferSize, blobAlignment)`.
3. Execbuffer `CONTEXT_CREATE { resourceId: the blob }`, then a wait on the
   blob (the global timeline).
4. The blob mapped: the ring storage at its start, the auxiliary buffer of
   `bufferSize` bytes after `sizeof(asg_ring_storage)`; the guest sets
   `transfer_mode = 1`, `host_consumed_pos = 0`, `guest_write_pos = 0`.
5. Writes go into the buffer; each flush is announced on the to-host ring and
   followed by `CONTEXT_PING`.

`asg_ring_storage` (address_space_graphics_types.h): three 4 KiB pages,
`to_host` (a `ring_buffer`), `to_host_large_xfer`, `from_host_large_xfer`
(rings whose views cover the auxiliary buffer). `ring_buffer`
(aemu ring_buffer.h), byte offsets:

| Offset | Field |
| --- | --- |
| 0, 4 | `host_version`, `guest_version` |
| 8 | `write_pos` (the producer's) |
| 64 | `read_pos` (the consumer's), then `read_live_count`, `read_yield_count`, `read_sleep_us_count` |
| 128 | `buf[2048]` |
| 2176 | `state` (`asg_host_state`, shared) |
| 2180 | `config[32]`: `asg_ring_config` |

`asg_ring_config`, 32-bit fields from offset 2180 of the to-host page:
`buffer_size`, `flush_interval` (the guest's write step), `host_consumed_pos`,
`guest_write_pos`, `transfer_mode`, `transfer_size`, `in_error`. Transfer
mode 1: the to-host ring carries `asg_type1_xfer { offset, size }` (8 bytes
each) naming flushed ranges of the buffer; mode 3: one large transfer of
`transfer_size` bytes through the large-transfer rings. The host sets
`host_consumed_pos` as it consumes and `in_error` on failure.

### Writing, waking the host, reading replies

From mesa's `AddressSpaceStream.cpp`:

- The guest fills the buffer in steps of `flush_interval` bytes; a flush
  pushes an 8-byte `asg_type1_xfer { offset, size }` onto the to-host
  ring (at most `buffer_size / flush_interval - 1` outstanding).
- It pings (`CONTEXT_PING`) when the shared `host_state` is neither
  `CAN_CONSUME` (1) nor `RENDERING` (4), and again after its write unless the
  host is rendering. `host_state`: `NEED_NOTIFY` 0, `CAN_CONSUME` 1, `EXIT` 2,
  `ERROR` 3, `RENDERING` 4. A host that stays at `NEED_NOTIFY` while idle is
  pinged for every flush (v64's choice: the device runs between the CPU's
  slices, not as a thread reading the ring).
- Before it reads, the guest waits (busy, with backoff) until the to-host
  ring is empty (`ensureType1Finished`) and any large transfer done.
- Replies come through `from_host_large_xfer`: the host writes them into its
  view over the auxiliary buffer and moves that ring's `write_pos`; the guest
  reads what is available (`speculativeRead`). `in_error = 1` fails the
  guest's reads and writes.

What gfxstream's host does with it (host/RingStream.cpp): for each
transfer on the to-host ring, copy `buffer[offset, offset + size)` into its
decoder's input, advance the ring's `read_pos` by 8 and add `size` to
`host_consumed_pos`; `host_state` is `CAN_CONSUME` while it reads, `RENDERING`
while it decodes, `NEED_NOTIFY` when it waits for the guest. Replies are
written into `from_host_large_xfer`'s view (the auxiliary buffer, its size a
power of two) at that ring's `write_pos`, which then advances.
`ring_buffer` positions are free-running 32-bit counters: what is readable is
`write_pos - read_pos`, a byte's place `pos & (size - 1)` (2048 for a ring's
own `buf`, the view's size for a view).

## A context's rings

One virtio-gpu context is one guest process (its `VirtGpuDevice`); each
thread's connection is a ring of its own, a blob of its own named by its own
`CONTEXT_CREATE`. gfxstream's host keeps them by the blob's resource id
(`VirtioGpuContext`'s `mAddressSpaceHandles`), and `CONTEXT_PING` carries the
resource id of the ring to read.

## On the stream

What travels in the buffer is gfxstream's encoder output: commands of a
32-bit opcode and a 32-bit size, then their arguments. The composer's
connection carries renderControl (`rc*`, opcodes from 10000); the Vulkan
driver's carries the Vulkan encoder's commands (`OP_vk*`, from 20000),
generated from vk.xml by gfxstream's codegen. The commands that actually
occur from boot to the desktop are G0's trace (not recorded yet: the plan's
reference host) and G2-G3's scope.

## The Vulkan stream

What `VkEncoder.cpp` writes, with the stream features a virtio-gpu guest
sets (`ResourceTracker::setupCaps`: null optional strings, ignored handles,
float16/int8, queue submit with commands; the generator folds them as
constants):

- A command: `opcode` (u32), `size` (u32, the whole command), then
  (QUEUE_SUBMIT_WITH_COMMANDS) a sequence number (u32), then the parameters.
  The host runs a process's commands in the order of their numbers, whatever
  ring they come on: it waits until `seqno - last == 1` and counts on when
  the command is done (gfxstream's `VkDecoder.cpp`, the process's
  `ProcessResources`). Numbers start at 1.
- Commands a command buffer records (the `vkCmd*`, and
  `vkBegin/End/ResetCommandBufferAsyncGOOGLE`, `vkCommandBufferHostSyncGOOGLE`)
  are written to the command buffer's own stream, without a number and
  without the command buffer's handle (`packetSize -= 8`), and reach the
  host inside `vkQueueFlushCommandsGOOGLE(queue, commandBuffer, dataSize,
  pData)` before the submit (`vkQueueSubmitAsyncGOOGLE`, no reply).
- Parameters and structs (cereal's reserved marshaling): each value in its C
  size, little endian, no padding; handles 8 bytes (the host's: it creates
  them and returns them in replies); an optional pointer is an 8-byte big
  endian presence word (the guest's pointer) and then what it points to; a
  `size_t` is 8 bytes big endian; a string is a big endian u32 length and its
  bytes; a string array a big endian u32 count and its strings; `pNext` is
  a big endian u32 size (the struct's `sizeof`, 0 for none), the sType, then
  the struct again from its own sType. Some sTypes of gfxstream's
  (VkImportColorBufferGOOGLE, VkCreateBlobGOOGLE, VkImportBufferGOOGLE as
  older guests numbered them) are told apart by the chain's root.
- With ignored handles, a descriptor write's pointers of the other
  descriptor types are written (their presence) but not what they point to;
  a graphics pipeline's state structs come with `hasRasterization` and
  `hasTessellation` flags (big endian u32) first.
- A reply: what the command's outputs are (handles, structs, counts behind
  their presence words), then its `VkResult`. Asynchronous commands have
  none.
- Host visible memory (deferredMapping): `vkAllocateMemory` carries
  `VkCreateBlobGOOGLE { blobMem: HOST3D, blobId }` (the guest's own counter),
  and when the guest maps it, `vkGetBlobGOOGLE(device, memory)` and then
  `RESOURCE_CREATE_BLOB` with that blob id, mappable.

v64's decoder and encoder are generated from these sources
(`tools/gfxstream_protocol_gen.mjs`) and checked against the guest's own
code (`tools/gfxstream_oracle`, `tests/devices/gfxstream_protocol.js`):

```
node tools/gfxstream_protocol_gen.mjs <mesa>/src/gfxstream/guest/vulkan_enc <mesa>/include/vulkan \
    src/graphics_adapters/virtio_gpu/gfxstream_protocol.js --guest tests/devices/gfxstream_guest_protocol.js
tools/gfxstream_oracle/build.sh <mesa>/src/gfxstream <mesa>/include
node tests/devices/gfxstream_protocol.js --oracle build/gfxstream-oracle/oracle
```
