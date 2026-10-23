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

## On the stream

What travels in the buffer is gfxstream's encoder output: commands of a
32-bit opcode and a 32-bit size, then their arguments. The composer's
connection carries renderControl (`rc*`, opcodes from 10000); the Vulkan
driver's carries the Vulkan encoder's commands (`OP_vk*`, from 20000),
generated from vk.xml by gfxstream's codegen. The commands that actually
occur from boot to the desktop are G0's trace (not recorded yet: the plan's
reference host) and G2-G3's scope.
