# Graphics proxy quick start

## 1. What is the graphics proxy?

A custom virtio device (`v86gl`) receives the graphics commands of the Windows
guest's driver and passes them to a renderer in the browser, which uses WebGPU.
Neither is part of v86 itself: both are in the graphics bundle
`build/glbridge/libv86-webgpu.js` (`make glbridge`), and v86 hosts the device
through its `virtio_devices` API
(see [custom-virtio-devices.md](custom-virtio-devices.md)).

- [`src/browser/glbridge/v86gl_device.js`](../src/browser/glbridge/v86gl_device.js):
  the device, next to the CPU (the page, or the CPU worker)
- [`src/browser/glbridge/graphics_proxy.js`](../src/browser/glbridge/graphics_proxy.js):
  the renderer's side, with the hooks v86 calls around saves and restores

Load the bundle after `libv86.js` and turn the proxy on:

```html
<script src="libv86.js"></script>
<script src="libv86-webgpu.js"></script>
```

```js
new V86({
    screen_container: document.getElementById("screen_container"),
    graphics_adapter: "bochs_vga",   // the display hardware; required
    graphics_proxy: true,            // or options, e.g. { onError }
    // ...
});
```

In `index.html` or `debug.html`, enable **Enable graphics proxy (WebGPU)**.

With `cpu_worker: true` the device runs in the CPU worker, which loads it from
`v86gl-device.js` beside `libv86-webgpu.js` (`make glbridge` builds both;
deploy them together, or pass `graphics_proxy: { workerScript }`). Across the
worker boundary at most 8 batches (32 MiB) are in flight; the guest waits for
the renderer beyond that.

Desktop GL's state, validation, errors, object identities, display lists,
selection/feedback and shader compiler/link metadata belong to `GLShadow`
beside the CPU. They do not require a synchronous page-renderer answer. The
page owns GPU resources and rendering; pixel reads, visibility and backend
shader validation complete through bounded asynchronous replies. Both CPU
modes use the same 257-record protocol. The GLSL 1.10/1.20 checker is
`glslang.wasm`; deploy it beside both graphics bundles together with the
manifest's workers and `vx_naga.wasm`.

The guest DLL owns WGL/thread/context rules, client pointers and encoding.
Large uploads are split into bounded chunks. It does not synthesize a successful
query after transport failure or replay an ambiguously accepted command.

The private virtio feature bit 1 (`D3D_OWNER_ARENAS`) gives DirectX processes
independent 16 MiB arenas. With that feature negotiated, the last word of the
24-byte REGISTER/SUBMIT/UNREGISTER request is a stable nonzero owner token.
Each positive owner accepts one D9WG envelope per submission. Physical ranges
must not overlap. Owner zero keeps the existing OpenGL-compatible arena and
request layout; drivers negotiating only bit 0 continue to work unchanged.
Repeated registration of the same positive owner/range is idempotent.

A write-back generation belongs to a physical arena lease, separately from the
stable owner token. Queue reset revokes all write leases while retaining logical
owners and GPU sessions. UNREGISTER still retires an owner after such a reset,
even if it has not registered again. Device snapshot v4 saves both the active
arenas and logical owners, regenerates write leases on restore, and reads the
older v2/v3 single-arena states. Malformed/overlapping restored arenas are
rejected before replacing live leases.

## 2. Get the driver and DLLs

Sources and binaries are in
[retro-gaming-site/glbridge](https://github.com/speedyHKjournalist/retro-gaming-site/tree/main/glbridge):

- `v86gl_driver/v86gl.sys` (`v86gl-virtio.sys` is the identical compatibility name)
- `openglproxy/opengl32.dll`
- `ddrawproxy/ddraw.dll`
- `d3d8proxy/d3d8.dll`
- `d3d9proxy/d3d9.dll`

## 3. Install the driver in Windows 2000/XP

Copy `v86gl.sys` to `C:\WINDOWS\system32\drivers`. When updating, close the game and run
`sc stop v86gl` before replacing the file.

Run these commands as Administrator:

```bat
sc create v86gl type= kernel start= demand binPath= C:\WINDOWS\system32\drivers\v86gl.sys

sc qc v86gl
sc start v86gl
```

The DirectX runtime first requests the optional MAP_D3D_BUFFER IOCTL (0x808),
falling back to the existing MAP_BUFFER only when the driver reports an
unsupported operation. Busy/allocation errors stay visible. The updated driver
shares one DirectX arena per process and gives legacy OpenGL its own owner-zero
arena. File objects hold mapping references; CLEANUP releases the last one and
CLOSE finishes idempotent file-context cleanup. A process-exit notification revokes user
mappings before address-space deletion, including when a duplicated device
handle remains in another process. Foreign cleanup attaches to the original
live process before unmapping.

Driver builds require Clang for the small i686 SEH mapping boundary, plus the
existing MinGW tools. The resulting driver imports only HAL/ntoskrnl, including
XP's `_except_handler3`. A user-mapping allocation exception returns an ordinary
allocation failure; the following map can retry. `d3d_multi_owner_xp.mjs` builds
and loads the current driver/DLLs in RAM sector overlays and tests concurrent
owners, process kill, surviving duplicated handles and foreign final cleanup;
`--map-exception` adds an allocation exception to that same SEH boundary.

The current build scripts target XP; Windows 2000 compatibility is unverified.

## 4. Install the graphics DLLs

Copy the DLLs needed by the game into the same folder as its `.exe`:
`opengl32.dll` for OpenGL, `ddraw.dll` for DirectDraw, `d3d8.dll` for Direct3D 8,
or `d3d9.dll` for Direct3D 9.

Keep Windows' system `opengl32.dll` and its dllcache copy intact. F6's local
deployment verifies their hashes and installs only the driver and application
copies. File size cannot identify this release: the old gl4es Cube DLL and the
new proxy both happen to be 145408 bytes. Use the deployment SHA256 and guest
probe, as recorded in `retro-gaming-site/glbridge/deployments/opengl-webgpu-F6.json`.

## 5. Build the driver and DLLs

Install the 32-bit MinGW-w64 toolchain (`i686-w64-mingw32-gcc`, `objdump`, and
`windres`), including its DDK headers and kernel import libraries.
From the `retro-gaming-site` repository root, run:

```sh
sh glbridge/v86gl_driver/build.sh
sh glbridge/openglproxy/build.sh
sh glbridge/ddrawproxy/build.sh
sh glbridge/d3d8proxy/build.sh
sh glbridge/d3d9proxy/build.sh
```


## 6. Tested games and applications

The following games and applications have been tested with the graphics proxy:

- **OpenGL:** GLView 2.6.0, Warcraft III (OpenGL mode), Cube 2 Sauerbraten,
  Tremulous GPP1 (Quake 3 engine), and the D3D8 textured cube through guest
  WineD3D 1.7.52. The [C–G acceptance record](opengl-webgpu-acceptance.md)
  describes both CPU modes, full-VM cold restore, process switching, paired
  timings, the two GLView shader corrections and the test-only ATCS flare map.
- **DirectDraw:** 3DMark 99 MAX, Diablo II.
- **Direct3D 7:** 3DMark 2000.
- **Direct3D 8:** 3DMark 2001 SE, MapleStory v083.
- **Direct3D 9:** 3DMark06, KartRider, Warcraft III, Grand Theft Auto: San Andreas, Need for Speed: Most Wanted (2005).

## 7. Save and restore graphics state

Use `await emulator.save_state()` and `await emulator.restore_state(state)`.
The graphics checkpoint is stored in the snapshot as the `v86gl` device's
host state. The emulator pauses a running guest while saving or restoring, waits
for accepted GPU work and readbacks, and resumes it after success. Saves and
restores on the same instance are serialized. A failed restore leaves the guest
stopped. `initial_state` also restores graphics before `emulator-loaded`.
Historical graphics surfaces stay hidden during reconstruction; the final
surface is revealed after reconstruction completes. GL loading takes time
proportional to live resources; D3D loading depends on its retained history. Browser audio is paused during the operation. Restoring clears
audio from the discarded timeline and reapplies the saved SB16 sampling rate
before playback resumes.

Checkpoint version 4 stores GL's live renderer graph and GPU contents. Shared
objects and retained bindings keep their identity; typed array views keep their
common storage. GLSL compiler state is rebuilt from the preprocessed sources of
the installed compilation units, while uniform values and locations survive.
Textures include every mip/layer and 3D slice, including GPU-rendered contents.
Window buffers, renderbuffers, accumulation, depth/stencil and individual MSAA
samples are saved as resources. Large transfers use bounded slices. The CPU
shadow's GL state and frozen capabilities travel with the virtio device state.
A retained IOCTL waiting for GPU-derived CPU state must complete before saving.

The last presented image is retained separately from an unfinished back frame.
A cold restore shows that image while preserving the next frame's partial
rendering. `gl_presented_frame_browser_test.html` checks distinct red/blue
images; the XP application matrix destroys the original VM, creates a new one,
restores CPU/RAM/disks/devices/graphics, compares composed pixel hashes while
the CPU is stopped, and then requires 64 further real frames. A stopped VGA
scanout is explicitly refreshed before that composed-pixel comparison.

`save_state_stream(write)` and `restore_state_stream(source)` avoid requiring
one contiguous output buffer. The current chunked stream header version is 9
(the V7 stream family); the acceptance report reads the actual header version.

New GL draws are no longer journaled. Version 4 includes the version 3 paged
Direct3D 8/9 and DirectDraw history, with Present and checkpoint flush boundaries.
The embedded VGS2 journal now writes version 4, using its previously reserved
entry word for a stable transport owner token. Versions 1–3 remain readable.
D3D session and additional swap-chain identities include their transport owner;
a scoped owner-release record retires only that owner, in accepted batch order.
Owner zero retains the legacy GL/D3D namespace. Historical unscoped release
records retain their original all-owner meaning.
Their handles, shaders, render state, palettes, queries and GPU-rendered contents
are reconstructed in order. Historical readbacks never write restored guest RAM.
Older GL histories remain readable and become live resource snapshots on the
next save. Malformed resource graphs are checked before replacing live state;
GPU mapping and validation failures fail the operation.

Commands are copied directly into contiguous pages, avoiding allocations per
batch. In browsers, completed page buffers are transferred to a dedicated
`graphics_journal_worker.js` worker for compression, keeping that work off the
emulation thread. Deploy this file beside `libv86-webgpu.js`; `make glbridge`
generates both. Environments without workers use local compression. There is no 512 MiB raw
history cutoff. `graphics_proxy: { graphicsJournalMemoryBytes }` sets the compressed
RAM cache budget (default 64 MiB); older `maxGraphicsJournalBytes` and
`maxGLJournalBytes` options are aliases for this budget. Excess pages are stored
temporarily in IndexedDB and deleted when the emulator resets or is destroyed.
If disk caching is unavailable or its quota is exhausted, pages stay in RAM;
commands are never discarded to enforce the cache budget. Pending compression
and the current page also use memory outside this cache budget.

Saving packs all pages into a portable checkpoint; loading needs no original
browser database. It decompresses and replays one page at a time. The ArrayBuffer
save API still needs memory for the complete output; use the stream API for
bounded writer backpressure. The D3D history size and restore time grow with its recorded workload. GL
checkpoint size instead depends on live resources. GPU results need the same
supported features.

Snapshots from before `virtio_devices` (the device state of `v86gl_pci.js` in
`state[92]`) still restore: the device recognizes and converts them.

Version 2 checkpoints remain readable. A running session that already exceeded
the old history cutoff must be restarted with the new code: commands discarded
by the old implementation cannot be recovered.

Version 1 checkpoints can restore only their original OpenGL/D3D8 payloads.
They never stored D3D9/DirectDraw resources or GL query lifetimes, so missing
state in those old files cannot be recovered retroactively.

## Display

The guest desktop and the graphics proxy share one canvas. A WebGPU compositor
(`src/browser/glbridge/webgpu_compositor.js`) takes over the screen canvas:
the VGA/SVGA picture is one texture, and each OpenGL, Direct3D 8 and Direct3D 9
output (and each extra D3D9 swap chain) is a window layer placed where the
guest reports its window, clipped to its visible part. A window that is
hidden, minimised, or entirely covered by other windows (`D9WG_WINDOW_OCCLUDED`)
is not drawn, so a video or dialog the game shows in another window is visible;
one covered in part -- a message box, the Alt+Tab switcher -- is drawn only
where it shows (`D9WG_WINDOW_REGION`). Every proxy reports this (OpenGL through
the `WINDOW_STATE` control record), from WinEvent hooks rather than only on
Present, and being covered holds across Presents until the guest reports the
window uncovered.
If WebGPU cannot start, the screen falls back to a 2D canvas without the proxy.
Screenshots (`screen_make_screenshot`) read the composed picture. There is no
separate overlay canvas any more; see `docs/display-design.md`.

A canvas keeps the first kind of context it hands out. When the screen canvas
already went to the other kind -- an earlier emulator in the same container
drew on it in 2D or WebGPU, or WebGPU took it and then failed to start -- the
screen replaces it with a fresh copy (same attributes, same place). Listeners
the page attached to the old element do not move with it.

Regression checks:

```sh
make test-glbridge
node tools/gl_behavior_coverage.cjs
node tools/gen_gl_coverage.cjs
node tests/glbridge/mutations.mjs --audit
make glbridge-gpu-tests
make display-browser-tests
node tests/glbridge/gl_multipass_browser_runner.js graphics_checkpoint_browser_test.html
node tests/glbridge/gl_multipass_browser_runner.js graphics_vga_browser_test.html
node tests/glbridge/gl_multipass_browser_runner.js graphics_journal_perf_test.html
```

The browser test checks actual GPU pixels for all four APIs after restoring in
both the same and a new emulator instance, including unfinished D3D8 drawing.
