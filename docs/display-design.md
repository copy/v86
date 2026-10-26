# Display design

Display devices and presenters (`src/browser/screen.js`, a terminal, nothing
in node) meet at an explicit interface. The display devices are the adapter
plugins that `graphics_adapter` selects (`src/graphics_adapter.js`,
`src/graphics_adapters/`): the Bochs VGA (`bochs_vga`), VMware SVGA II
(`vmware_svga`) and virtio-gpu as virtio-vga (`virtio_gpu`). All three are
built on the VGA core `src/graphics_adapters/vga_core.js` (`VGAScreen`); see
[gpu-devices.md](gpu-devices.md) for SVGA II and virtio-gpu. With
`graphics_adapter: "none"` there is no display device. The whole screen is one
canvas: the guest desktop (the adapter's picture) is the scanout at the bottom,
and the D3D/GL output of v86gl is composited on top of it as window layers
placed in guest desktop coordinates.
The v86gl rendering protocols (D9WG/GLWG/VGL2) and the v86gl device
(`src/browser/glbridge/v86gl_device.js`) are not part of this structure: the
device only transports commands. It has no frame
buffer and no display mode, so it is not a display device.

## Architecture

```text
=== guest ==============================================================
   desktop / GDI / DirectShow                 game (War3 ...)
            │                                     │ D3D8/9, GL, DDraw calls
            ▼                                     ▼
   display driver                             proxy DLL  [1]
   (Bochs VBE, vm3d / vmwgfx,                     │ D9WG/GLWG commands
    viogpudo / virtio_gpu)                        │ + window rect + visible region
            │ ports / VRAM /                      ▼
            │ FIFO / virtqueues               v86gl.sys
            │                                     │ arena + SUBMIT
=== CPU thread / worker ================================================
            ▼                                     ▼
   display adapter plugin  [2]                v86gl device  (transport only)
   bochs_vga | vmware_svga |                      │
   virtio_gpu  (+ VGA core)                       │
            │ DisplaySource                       │
            ▼                                     │
   DisplayHub  [3]                                │
     - one source: the adapter                    │
     - vblank <- MachineClock                     │
            │ DisplaySink calls                   │ command batches
            │ (batched across the worker          │
            │  boundary: DisplaySinkRecorder)     │
=== main thread ========================================================
            ▼                                     ▼
   screen.js  [4]                             bridge + D3D9/GL executors  [5]
     text   -> guest VGA font                   render into a layer texture
     pixels -> backend.put_pixels               (a virtual canvas per layer)
            │ scanout texture                     │ WindowLayer: texture
            │                                     │   + desktop rect + visible region
            └──────────────────┬──────────────────┘
                               ▼
                      Compositor  [6]
                      (the only canvas context)
                               │
                               ▼
                         one <canvas>
```

1. **proxy DLL**: besides rendering commands, it reports the device window's
   rectangle and visible region (see "Occlusion" below). This is the only thing
   the compositor clips window layers by.
2. **DisplaySource** (`src/display.js`): a real display device with a scanout,
   that is the configured display adapter. The plugin registers its device
   with the handle's `display.add_source`, and v86 wraps it in
   `PluginDisplaySource` (`src/graphics_adapter.js`). Its interface is
   `vblank_period()`, `on_vblank()`, `render()` (send the changed pixels to the
   sink) and `invalidate()` (redraw everything next time). The Bochs VGA's
   source is its VGA core. SVGA II and virtio-gpu create their VGA core with
   `display_source: false` and are the source themselves.
3. **DisplayHub** (`src/display.js`) runs in the CPU thread (or the CPU worker)
   and knows nothing about particular devices.
   - It shows one source: the first one registered, which is the machine's
     display adapter. The hub never switches sources. An adapter that embeds
     the VGA core switches inside itself between the core's picture and its
     own:
     - **VMware SVGA II** shows its own picture (the register-defined mode or
       its screen objects) while `SVGA_REG_ENABLE` has ENABLE set and HIDE
       clear, and the core's otherwise.
     - **virtio-gpu** shows its scanouts, side by side, from the driver's
       first control command until a device reset, and the core's before and
       after.

     When the core gets the screen back, it sends its mode and picture again
     (`redisplay`).
   - It hangs off `CPU.run_hardware_timers` and signals vblank on the
     MachineClock. The VGA core computes the refresh period from its CRTC
     registers and dot clock (about 70 Hz for text mode and 13h, about 60 Hz for
     640×480). SVGA II and virtio-gpu refresh at a fixed 60 Hz while their own
     picture is shown.
   - It also runs device timers registered with `add_timer`; Venus polls its
     rings this way.
   - Devices call only the hub. The hub forwards each call to the sink
     synchronously and sends the `screen-set-size` / `screen-put-char` bus
     events.
   - The VGA core sends a text cell only when a write changes its byte, and
     sends the whole text screen again (after a palette, font, geometry or
     start address change) once per vblank, however many registers the guest
     programmed: the VGA BIOS's mode set alone used to send it about 200
     times.
4. **DisplaySink and the presenters**: `DisplaySink` is an explicit interface
   (JSDoc `@interface`). `DummyScreenAdapter` is the base class,
   `ANSIScreenAdapter` extends it, and the FLAG constants are shared from
   `src/display.js`. With the CPU in a worker, `DisplaySinkRecorder` on the
   worker side sends the calls of one microtask as a batch, and the main thread
   replays them with `DISPLAY_SINK_REPLAY`. Both sides use one method table, and
   Closure checks that the recorder implements every method of the interface.
   The worker does not send `screen-put-char`: the main thread sends it for
   each replayed `put_char`, once its presenter has the character. Before any
   other bus event the worker sends the batch so far, so the page sees the
   screen as it was when the event happened.
   Each presenter keeps its own text model, which `get_text_screen` reads.

   `screen.js` draws text and graphics on the same canvas. Text is rasterized
   to RGBA in JavaScript with the guest's own VGA font (plane 2); graphics come
   from the device as a `{ data, width, height }` pixel view. Both go into a
   backend (`resize` / `put_pixels` / `clear` / `present` / `screenshot`): a
   Canvas2D backend without v86gl, the compositor's scanout texture with it.
5. **executors**: their code does not know about the compositor. Each window
   layer gives an executor a "virtual canvas", whose `getContext("webgpu")`
   returns a context that hands out the layer's texture, and a host view that
   shares the compositor's device. GL, D3D8 and D3D9 have one window layer each,
   and so does every additional D3D9 swap chain. The bridge places window layers
   by guest desktop coordinates only (`placeLayer` / `placeOwner` /
   `placeLayers` / `hideLayers`) and no longer touches the DOM.
6. **Compositor** (`src/browser/glbridge/webgpu_compositor.js`,
   `V86WebGPUCompositor`) takes over the device of `webgpu_host.js`, holds the
   only canvas context and composes the layers every frame. Scaling, aspect
   ratio and mouse coordinates all use the same transform. A screenshot composes
   synchronously and reads the canvas in the same task. Its device is the only
   one of the v86gl stack, but not the only one on the page: the 3D renderer
   of SVGA II and virtio-gpu (`V86SVGARenderer`,
   `src/browser/glbridge/svga_renderer.js`) also runs on the main thread, with
   or without a CPU worker. Its D3D9 executor gets a WebGPU device of its own
   from `webgpu_host.js` (one host per canvas) for a 1×1 OffscreenCanvas, and
   its GX and VX executors use that device too. It draws nothing on the page:
   results go back to the adapter as readbacks (see "Architecture" in
   [gpu-devices.md](gpu-devices.md)).

### Composition order

Each frame is drawn bottom to top:

| Layer | Content | Clipping |
| --- | --- | --- |
| 0 scanout | The whole guest desktop: the display adapter's picture (VGA text/graphics, VBE, VMware SVGA II screens, virtio-gpu scanouts side by side), including what SVGA II or virtio-gpu 3D rendered, read back into that picture | None |
| 1..n windows | One layer per D3D/GL swap chain, its texture mapped to a rectangle in guest desktop coordinates | The visible region the proxy reports: one scissored draw per exposed rectangle |

Window layers and the scanout share one coordinate system (guest desktop
pixels), so they line up by construction, with no DOM geometry involved. The
D3D device cursor is drawn by the d3d9 executor into its own window layer's
texture; there is no separate cursor layer.

The hardware cursors of SVGA II and virtio-gpu, and the SVGA II video overlay,
are drawn by the device over its picture. Each render sends them as small extra
layers through `update_buffer`, after the picture (`SoftwareCursor` in
`svga_cursor.js`, `VideoOverlay` in `svga_video.js`, both in
`src/graphics_adapters/vmware_svga/`); guest memory is never written. The
compositor has no cursor plane and receives no GPU textures from the display
adapters.

## Design decisions

- **vblank comes from the machine clock; the host's rAF only draws the latest
  frame.** Device timing therefore does not depend on the host: programs that
  wait for retrace run in node and with the Dummy adapter, the guest does not
  stall when the tab goes to the background, and deterministic mode stays
  reproducible. Bit 3 of port 0x3DA is timed by the machine clock, and every
  retrace can be read at least once. The register returns only bits 0 and 3.
- **One canvas, so with v86gl the scanout goes through WebGPU too.** A canvas
  hands out only one kind of context, and the executors need `"webgpu"`. When
  WebGPU fails to start, or the configuration has no `graphics_proxy`, the
  screen uses the Canvas2D backend; then there is no proxy and no window layer.
  The 3D levels of `vmware_svga` and `virtio_gpu` do not need the compositor:
  their pictures reach the screen through the device (readback), so they work
  on the Canvas2D backend too.
- **A canvas keeps the first kind of context it hands out.** Two emulators
  created one after the other in the same container may want WebGPU and 2D
  respectively. `claim_canvas` in `screen.js` checks before taking a context:
  if the canvas already gave out the other kind, it is replaced by a copy that
  keeps its attributes, in the same place. It is replaced only when needed,
  because listeners the page attached to the old element do not move with it.
- **Mode switches resynchronize.** Going from text back to graphics, the
  device sends the size again and redraws everything, since the canvas lost the
  graphics while it showed text. Going from graphics back to text, the font is
  sent again as changed, since graphics modes write plane 2.
- **No frame message between devices and presenters.** The hub forwards calls
  synchronously. Only the worker boundary needs batching, and
  `DisplaySinkRecorder` already does it there.
- **Headless presenters bypass the compositor.** Dummy and ANSI sit directly
  behind the hub.
- **Threads.** The hub runs in the CPU thread (or the CPU worker); the
  compositor, the executors and the display adapters' 3D renderer run on the
  main thread. An OffscreenCanvas could later move the compositor and the
  executors into a worker together.
- **Device memory is a table of movable regions.** `src/rust/cpu/mmio_ram.rs`
  provides up to 4 device memory regions. Each has its own memory in the wasm
  heap, a dirty bitmap by 4 KiB page and an optional RGBA conversion buffer. A
  region can be mapped at any guest physical address and follows its PCI memory
  BAR when the device provides `on_move`. The slow read/write paths, the
  `rep movs` fast path and the x64 page tier's direct frame buffer translations
  all look regions up in this table; moving a region drops those translations.
  A device can also take a region's written pages (`mmio_ram_take_dirty`). The
  regions in use:
  - **VRAM**, the VGA core's linear frame buffer, on every adapter: BAR0 of
    `bochs_vga` and `virtio_gpu`, BAR1 of `vmware_svga`. Its RGBA buffer holds
    the VGA core's graphics picture, and SVGA II's register-defined mode while
    that is shown. SeaBIOS places the Bochs VGA's BAR0 at 0xFE000000 (as QEMU
    does), and the 0xE0000000 saved in old snapshots still works after a
    restore.
  - **The SVGA II command FIFO** (BAR2, 2 MiB), without an RGBA buffer.
  - **virtio-gpu's host visible memory** (BAR4, 64 MiB; 128 MiB at level
    `venus`), only at levels `virgl43-hostmem` and `venus`, without an RGBA
    buffer. virtio-gpu takes the pages the guest wrote and uploads them into
    the mapped blobs before each submission.

  virtio-gpu's 2D resources are host-side copies, filled by
  `TRANSFER_TO_HOST_2D` from their backing: guest RAM, or BAR0, which viogpudo
  uses as its frame buffer. A guest blob on a scanout (`SET_SCANOUT_BLOB`) is
  read from guest memory directly.

## Occlusion: the guest reports each window's visible region

The compositor must know which part of a D3D/GL window is actually visible in
the guest. War3's cinematics are the typical case: Game.dll creates a
full-screen, topmost `BlizPlay` popup and has DirectShow draw the video into it,
that is into the VGA frame buffer, without going through D3D at all. War3's D3D
window is still "visible" in the guest, only covered by the popup. Judged by the
window state alone, the D3D layer would stay on top of the video: a black
picture with sound.

The host cannot infer occlusion on its own (for example, by treating writes to
the VRAM below a D3D window as the window being covered): repainting the
window's background writes that VRAM too, and frame buffer dirty tracking
works in 4 KiB pages, which cannot tell regions apart. So the proxies report it:

- **Fully covered**: `D9WG_WINDOW_OCCLUDED` (`d3d9_protocol.h`).
- **Partly covered**: `D9WG_WINDOW_REGION`, followed by the exposed rectangles
  of the client area (at most 32, in client coordinates), taken from the window
  DC's system region `GetRandomRgn(SYSRGN)`; the shared code is in
  `retro-gaming-site/glbridge/window_region.h`. Windows 9x and systems with
  desktop composition can only report "all visible" or "all covered", and too
  many rectangles count as "all visible". Old hosts read fixed-size records and
  ignore the region that follows.
- **OpenGL**: the control record `V86GL_CTRL_WINDOW_STATE` (0xFFF3), with the
  same flag bits as D9WG.
- **Reports do not depend on Present.** Besides every frame, the window
  procedure (move, resize) and a `SetWinEventHook` on the rendering thread
  report too, because a game playing a video may not be presenting at all.
  DDraw reports with every present and every WinEvent while it has a primary
  surface.
- **On the host**, being covered is a persistent state of the surface: later
  Presents do not bring it back until the guest reports it uncovered. The
  visible region becomes the window layer's `setVisibleRegion`. The D3D9
  proxy's `window_x/window_y` is the client-area origin, as for Present.

The same reports handle partial occlusion by message boxes, IME candidate
windows and Alt+Tab.

## Costs and known limits

- **There is no DOM text mode.** Browser text selection, copying and screen
  readers do not work. If needed, a transparent DOM text layer could be built
  from the text model; it is not a canvas, so there would still be one canvas.
- **A D3D frame reaches the screen at the next composition, at most one frame
  later.**
- **Recovery after a lost device is untested.** When the host recreates the
  device, the compositor rebuilds its resources and asks for a full redraw, but
  a real device loss is hard to provoke in a browser.
- **Occlusion reports have not been tried with War3 in an XP guest.** All four
  proxies (D3D9, D3D8, DDraw, OpenGL) implement them and build with
  `-Wall -Wextra -Werror`.

## Testing

| Target | What it checks |
| --- | --- |
| `make display-browser-tests` | Text -> 13h -> text -> 13h on one canvas (main thread and worker); every character cell after a FreeDOS boot compared pixel by pixel with its plane 2 glyph and attribute colours; the guest's 13h picture as the scanout with a D3D9 window layer composited on top, full and partial occlusion and regions kept across Presents, and a blanked screen (the screen-off bit; a mode set blanks it the same way) clearing the scanout without a WebGPU validation error; the VGA desktop plus a GL window end to end, including snapshots and old snapshots. It also runs the SVGA renderer and GX browser tests on a real GPU: `svga_renderer`, `svga_dx`, `svga_share`, `svga_fixed_function`, `svga_gs`, `svga_so`, `svga_pull`, `svga_depth_upload`, `svga_msaa`, `svga_cube_array`, `svga_compute`, `tessellator` and `svga_tess` (`tests/glbridge/*_browser_test.html`; see "Tests" in [gpu-devices.md](gpu-devices.md)) |
| `tests/devices/display.js` | DisplaySink recording and replay agree; text-mode snapshots restore with Dummy and ANSI; a boot sector waiting for retrace keeps the right rate in node in three modes, and two runs on the deterministic clock agree |
| `tests/devices/mmio_ram.js` | The BAR SeaBIOS assigns, pixels reaching the screen, moving the BAR, the banked window (0xA0000), snapshots |
| `tests/x64/frame_buffer.mjs` | Page functions write the frame buffer directly, pages are marked dirty again after the screen took them, and old translations are dropped when the BAR moves |
