// D9WG protocol 1.7: the DirectDraw opcode group (0x500), decoded on behalf of
// glbridge/ddrawproxy/ddraw.dll.
//
// This is a mixin over D3D9WebGPUExecutor rather than a second executor, for
// the same reason DirectDraw does not get a protocol of its own: a Direct3D 7
// device renders into a DirectDraw surface, and that surface is then blitted by
// DirectDraw and sampled as a texture by Direct3D, sometimes within one frame.
// Two resource tables would turn every one of those interactions into a
// cross-table copy that exists only because of how the host was factored.
//
// So surfaces are ordinary D9WG textures created by the 0x1xx opcodes, and only
// five things here are genuinely new:
//
//   * a blit that tests a colour key, mirrors, or fills;
//   * palettised surfaces kept as r8uint indices rather than expanded to RGBA;
//   * a palette that belongs to a surface rather than to the device;
//   * the display mode an exclusive-fullscreen title asked for.
//   * persistent overlay state composited non-destructively at present time.
//
// Flipping and clip lists are deliberately absent: a flip is a guest-side
// rotation followed by a blit into the swap-chain image, and a clip list is
// resolved guest-side into per-rectangle blits.

(function(global) {
    "use strict";
    const surfaceFactory = global.D9WGSurfaceOps ||
        (typeof require === "function" ? require("./d9wg_surface_ops.js") : null);
    if (!surfaceFactory) throw new Error("ddraw_ops.js requires d9wg_surface_ops.js");
    const { ddBlitShaderSource, clipRects, clipDestination } = surfaceFactory;

    const D9WG = global.D9WGProtocol ||
        (typeof require === "function" ? require("./d9wg_protocol.js") : null);
    const OP_DD_BLT = D9WG.OP.DD_BLT;
    const OP_DD_SET_COLOR_KEY = D9WG.OP.DD_SET_COLOR_KEY;
    const OP_DD_SET_SURFACE_PALETTE = D9WG.OP.DD_SET_SURFACE_PALETTE;
    const OP_DD_SET_DISPLAY_MODE = D9WG.OP.DD_SET_DISPLAY_MODE;
    const OP_DD_UPDATE_OVERLAY = D9WG.OP.DD_UPDATE_OVERLAY;

    const DDBLT_KEY_SOURCE = 1 << 0;
    const DDBLT_KEY_DESTINATION = 1 << 1;
    const DDBLT_MIRROR_X = 1 << 2;
    const DDBLT_MIRROR_Y = 1 << 3;
    const DDBLT_COLOR_FILL = 1 << 4;
    const DDBLT_DEPTH_FILL = 1 << 5;
    const DDBLT_FILTER_LINEAR = 1 << 6;

    const DDCKEY_SOURCE_BLT = 0;
    const DDCKEY_DESTINATION_BLT = 1;
    const DDCKEY_SOURCE_OVERLAY = 2;
    const DDCKEY_DESTINATION_OVERLAY = 3;

    const DDOVER_SHOW = 1 << 0;
    const DDOVER_HIDE = 1 << 1;
    const DDOVER_KEY_SOURCE = 1 << 2;
    const DDOVER_KEY_DESTINATION = 1 << 3;
    const DDOVER_MIRROR_X = 1 << 4;
    const DDOVER_MIRROR_Y = 1 << 5;
    const DDOVER_KEY_SOURCE_OVERRIDE = 1 << 6;
    const DDOVER_KEY_DESTINATION_OVERRIDE = 1 << 7;

    const DDSCL_NORMAL = 1 << 0;
    const DDSCL_EXCLUSIVE = 1 << 1;
    const DDSCL_FULLSCREEN = 1 << 2;

    const BUFFER_USAGE_UNIFORM = 0x40;
    const BUFFER_USAGE_COPY_DST = 0x8;
    const TEXTURE_USAGE_COPY_SRC = 0x01;
    const TEXTURE_USAGE_COPY_DST = 0x02;
    const TEXTURE_USAGE_TEXTURE_BINDING = 0x04;
    const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
    const SHADER_STAGE_VERTEX = 0x1;
    const SHADER_STAGE_FRAGMENT = 0x2;

    const PALETTE_ENTRIES = 256;
    const PALETTE_BYTES = PALETTE_ENTRIES * 16; // array<vec4<f32>, 256>

    const ddrawOps = {
        // ---- 0x500 DD_BLT ----------------------------------------------
        onDDBlt(bytes, view, offset, length) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.DDBlt.device_handle, true));
            const sourceHandle = view.getUint32(offset + D9WG.F.DDBlt.source_handle, true);
            const sourceLevel = view.getUint32(offset + D9WG.F.DDBlt.source_level, true);
            const sourceFace = view.getUint32(offset + D9WG.F.DDBlt.source_face, true);
            const sourceRect = {
                left: view.getInt32(offset + D9WG.F.DDBlt.source_rect, true),
                top: view.getInt32(offset + D9WG.F.DDBlt.source_rect + 4, true),
                right: view.getInt32(offset + D9WG.F.DDBlt.source_rect + 8, true),
                bottom: view.getInt32(offset + D9WG.F.DDBlt.source_rect + 12, true),
            };
            const destinationHandle = view.getUint32(offset + D9WG.F.DDBlt.destination_handle, true);
            const destinationLevel = view.getUint32(offset + D9WG.F.DDBlt.destination_level, true);
            const destinationFace = view.getUint32(offset + D9WG.F.DDBlt.destination_face, true);
            const flags = view.getUint32(offset + D9WG.F.DDBlt.flags, true);
            const destinationRect = {
                left: view.getInt32(offset + D9WG.F.DDBlt.destination_rect, true),
                top: view.getInt32(offset + D9WG.F.DDBlt.destination_rect + 4, true),
                right: view.getInt32(offset + D9WG.F.DDBlt.destination_rect + 8, true),
                bottom: view.getInt32(offset + D9WG.F.DDBlt.destination_rect + 12, true),
            };
            const fillColor = view.getUint32(offset + D9WG.F.DDBlt.fill_color, true);
            const fillDepth = view.getFloat32(offset + D9WG.F.DDBlt.fill_depth, true);

            this.stats.ddBlits = (this.stats.ddBlits || 0) + 1;

            const destination = destinationHandle
                ? this.resources.get(destinationHandle) : null;
            if (destinationHandle && (!destination || !destination.gpuTexture)) {
                this.ddRefuse("unknown-destination",
                    "a DirectDraw blit names a destination the host does not " +
                    "know; it is skipped rather than writing unrelated memory",
                    { destinationHandle });
                return;
            }
            const destinationWidth = destination
                ? Math.max(1, destination.width >> destinationLevel)
                : this.backBufferWidthOf(state);
            const destinationHeight = destination
                ? Math.max(1, destination.height >> destinationLevel)
                : this.backBufferHeightOf(state);
            const destinationColorKey =
                (flags & DDBLT_KEY_DESTINATION) && destination
                    ? (destination.ddColorKey &&
                        destination.ddColorKey[DDCKEY_DESTINATION_BLT])
                    : null;
            if ((flags & DDBLT_KEY_DESTINATION) && !destinationColorKey) {
                this.ddRefuse("key-destination-missing",
                    "a blit asked for the destination colour key but the " +
                    "destination surface has none attached",
                    { destinationHandle });
                return;
            }
            // A fill has no source rectangle at all, so it clips against the
            // destination alone; anything else has to move both rectangles
            // together or a partly off-screen sprite stretches instead of
            // being cut off.
            const isFill = (flags & (DDBLT_COLOR_FILL | DDBLT_DEPTH_FILL)) !== 0;
            const clipped = isFill
                ? clipDestination(destinationRect, destinationWidth,
                    destinationHeight)
                : clipRects(sourceRect, destinationRect, destinationWidth,
                    destinationHeight);
            if (!clipped) return;

            // A DDSCL_NORMAL primary is the guest desktop, but the WebGPU
            // canvas is a separate layer above v86's GDI canvas.  Remember
            // which part DirectDraw actually changed so the page can clip the
            // overlay to that region instead of covering the rest of the
            // desktop with the retained back buffer.  Splash screens such as
            // 3DMark 99/2000 update only their centred 420x170 rectangle.
            const noteWindowedScreenWrite = () => {
                if (destinationHandle || !state.ddClipPrimaryToWrites) return;
                const viewport = clipped.viewport;
                const next = {
                    left: viewport[0], top: viewport[1],
                    right: viewport[0] + viewport[2],
                    bottom: viewport[1] + viewport[3],
                    baseWidth: destinationWidth,
                    baseHeight: destinationHeight,
                };
                const old = state.ddScreenWriteRect;
                if (old) {
                    next.left = Math.min(next.left, old.left);
                    next.top = Math.min(next.top, old.top);
                    next.right = Math.max(next.right, old.right);
                    next.bottom = Math.max(next.bottom, old.bottom);
                }
                state.ddScreenWriteRect = next;
                const coversScreen = next.left <= 0 && next.top <= 0 &&
                    next.right >= destinationWidth &&
                    next.bottom >= destinationHeight;
                state.surface = { ...state.surface,
                    clipRect: coversScreen ? null : next };
            };

            if (flags & DDBLT_DEPTH_FILL) {
                if (!destination || !destination.isDepth ||
                        destinationLevel >= (destination.levelCount || 1)) {
                    this.ddRefuse("depth-fill-target",
                        "DDBLT_DEPTHFILL needs a valid depth-surface level; " +
                        "the request is skipped rather than clearing a " +
                        "colour target", { destinationHandle,
                            destinationLevel });
                    return;
                }
                const frame = this.ensureFrame();
                const viewport = clipped.viewport;
                frame.ops.push({
                    kind: "rect-clear",
                    targets: {
                        key: "dd-depth:" + destinationHandle + ":" +
                            destinationLevel + ":" + destinationFace,
                        colors: [], formats: [],
                        depthView: this.targetViewFor(destination,
                            destinationLevel, false, destinationFace),
                        width: destinationWidth, height: destinationHeight,
                        hasDepth: true,
                        sampleCount: destination.sampleCount || 1,
                    },
                    clearsColor: false, clearsDepth: true,
                    clearsStencil: false,
                    color: { r: 0, g: 0, b: 0, a: 0 },
                    depth: Math.max(0, Math.min(1, fillDepth)), stencil: 0,
                    rects: [{ left: viewport[0], top: viewport[1],
                        right: viewport[0] + viewport[2],
                        bottom: viewport[1] + viewport[3] }],
                });
                destination.frameReferenced = frame.serial;
                this.stats.ddDepthFills = (this.stats.ddDepthFills || 0) + 1;
                return;
            }

            const destinationIndexed = !!(destination && destination.ddIndexed);
            const destinationFormat = destination
                ? (destination.gpuFormat || "rgba8unorm") : this.format;
            const destinationView = destination
                ? this.targetViewFor(destination, destinationLevel, false,
                    Math.min(destinationFace,
                        (destination.layerCount || 1) - 1))
                : (this.deviceBackBuffer(state), state.backBufferView);

            if (flags & DDBLT_COLOR_FILL) {
                noteWindowedScreenWrite();
                const frame = this.ensureFrame();
                frame.ops.push({
                    kind: "ddblit",
                    sourceKind: "none",
                    destinationKind: destinationIndexed ? "index" : "float",
                    destinationView, destinationFormat,
                    sourceRect: [0, 0, 1, 1],
                    viewport: clipped.viewport,
                    // A DirectDraw fill colour is in the destination surface's
                    // own format. The guest converts an RGB destination's fill
                    // to D3DCOLOR; an indexed one carries the raw index.
                    fill: destinationIndexed ? null : [
                        ((fillColor >>> 16) & 0xff) / 255,
                        ((fillColor >>> 8) & 0xff) / 255,
                        (fillColor & 0xff) / 255,
                        ((fillColor >>> 24) & 0xff) / 255,
                    ],
                    fillIndex: destinationIndexed ? (fillColor & 0xff) : 0,
                    destinationColorKey,
                    destinationTexture: destination
                        ? destination.gpuTexture : this.deviceBackBuffer(state),
                    destinationLevel,
                    destinationFace,
                    destinationSize: [destinationWidth, destinationHeight],
                });
                if (destination) destination.frameReferenced = frame.serial;
                this.markTextureSubresourceWritten(destination,
                    destinationLevel, destinationFace);
                this.stats.ddFills = (this.stats.ddFills || 0) + 1;
                if (destinationColorKey)
                    this.stats.ddBlitsDestinationKeyed =
                        (this.stats.ddBlitsDestinationKeyed || 0) + 1;
                return;
            }

            const source = sourceHandle ? this.resources.get(sourceHandle) : null;
            if (sourceHandle && (!source || !source.gpuTexture)) {
                this.ddRefuse("unknown-source",
                    "a DirectDraw blit names a source the host does not know; " +
                    "it is skipped rather than sampling unrelated memory",
                    { sourceHandle });
                return;
            }
            const sourceWidth = source
                ? Math.max(1, source.width >> sourceLevel)
                : this.backBufferWidthOf(state);
            const sourceHeight = source
                ? Math.max(1, source.height >> sourceLevel)
                : this.backBufferHeightOf(state);
            const sourceIndexed = !!(source && source.ddIndexed);
            const sourceFormat = source
                ? (source.gpuFormat || "rgba8unorm") : this.format;

            if (!sourceIndexed && destinationIndexed) {
                // Colour matching an RGB image into someone else's palette is
                // a different picture, not a slower one. Real DirectDraw
                // drivers refused this too.
                this.ddRefuse("rgb-into-indexed",
                    "a blit from a true-colour surface into a palettised one " +
                    "would have to choose palette indices for colours the " +
                    "palette may not contain; it is refused rather than " +
                    "approximated");
                return;
            }

            const colorKey = (flags & DDBLT_KEY_SOURCE) && source
                ? (source.ddColorKey && source.ddColorKey[DDCKEY_SOURCE_BLT])
                : null;
            if ((flags & DDBLT_KEY_SOURCE) && !colorKey) {
                // DDBLT_KEYSRC with no key attached is an app error DirectDraw
                // answers with DDERR_NOCOLORKEY. Blitting opaquely instead
                // would paint a rectangle over the background.
                this.ddRefuse("key-source-missing",
                    "a blit asked for the source colour key but the surface " +
                    "has none attached", { sourceHandle });
                return;
            }

            const mirrorX = (flags & DDBLT_MIRROR_X) !== 0;
            const mirrorY = (flags & DDBLT_MIRROR_Y) !== 0;
            const src = clipped.source;
            if (src.left < 0 || src.top < 0 || src.right > sourceWidth ||
                    src.bottom > sourceHeight) {
                this.ddRefuse("source-out-of-bounds",
                    "a DirectDraw blit reads outside its source surface, " +
                    "which DirectDraw answers with DDERR_INVALIDRECT",
                    { sourceHandle, sourceWidth, sourceHeight });
                return;
            }
            const width = src.right - src.left;
            const height = src.bottom - src.top;
            const selfBlt = !!(source && destination &&
                source.gpuTexture === destination.gpuTexture &&
                sourceLevel === destinationLevel &&
                sourceFace === destinationFace);

            // The straight copy: nothing to key, nothing to mirror, no scale,
            // no format change, and two real textures. copyTextureToTexture is
            // both cheaper and exact, and it works for r8uint where a render
            // pass would need a pipeline.
            const scaled = width !== clipped.viewport[2] ||
                height !== clipped.viewport[3];
            if (!colorKey && !destinationColorKey && !mirrorX && !mirrorY &&
                    !scaled && source && !selfBlt &&
                    destination && sourceFormat === destinationFormat) {
                const frame = this.ensureFrame();
                frame.ops.push({ kind: "copy",
                    source: { texture: source.gpuTexture,
                        mipLevel: sourceLevel,
                        origin: { x: src.left, y: src.top, z: sourceFace } },
                    destination: { texture: destination.gpuTexture,
                        mipLevel: destinationLevel,
                        origin: { x: clipped.viewport[0],
                            y: clipped.viewport[1], z: destinationFace } },
                    size: { width, height, depthOrArrayLayers: 1 } });
                source.frameReferenced = frame.serial;
                destination.frameReferenced = frame.serial;
                this.markTextureSubresourceWritten(destination,
                    destinationLevel, destinationFace);
                this.stats.ddBlitsCopied = (this.stats.ddBlitsCopied || 0) + 1;
                return;
            }

            let paletteBuffer = null;
            if (sourceIndexed && !destinationIndexed) {
                paletteBuffer = this.ddPaletteBufferFor(source);
                if (!paletteBuffer)
                    this.stats.ddPaletteMissing =
                        (this.stats.ddPaletteMissing || 0) + 1;
            }

            const u0 = src.left / sourceWidth;
            const v0 = src.top / sourceHeight;
            const du = width / sourceWidth;
            const dv = height / sourceHeight;
            const frame = this.ensureFrame();
            noteWindowedScreenWrite();
            frame.ops.push({
                kind: "ddblit",
                sourceKind: sourceIndexed ? "index" : "float",
                destinationKind: destinationIndexed ? "index" : "float",
                sourceView: source
                    ? this.blitSourceView(source, sourceLevel, sourceFace)
                    : (this.deviceBackBuffer(state), state.backBufferView),
                sourceTexture: source ? source.gpuTexture : this.deviceBackBuffer(state),
                sourceLevel,
                sourceFace,
                sourceSnapshot: selfBlt,
                destinationView, destinationFormat, sourceFormat,
                sourceRect: [
                    mirrorX ? u0 + du : u0, mirrorY ? v0 + dv : v0,
                    mirrorX ? -du : du, mirrorY ? -dv : dv,
                ],
                sourceSize: [sourceWidth, sourceHeight],
                viewport: clipped.viewport,
                colorKey: colorKey || null,
                destinationColorKey,
                destinationTexture: destination
                    ? destination.gpuTexture : this.deviceBackBuffer(state),
                destinationLevel,
                destinationFace,
                destinationSize: [destinationWidth, destinationHeight],
                paletteBuffer,
                paletteResolve: !!paletteBuffer,
                filterPoint: !(flags & DDBLT_FILTER_LINEAR) || sourceIndexed,
            });
            if (source) source.frameReferenced = frame.serial;
            if (destination) destination.frameReferenced = frame.serial;
            this.markTextureSubresourceWritten(destination, destinationLevel,
                destinationFace);
            if (colorKey)
                this.stats.ddBlitsColorKeyed =
                    (this.stats.ddBlitsColorKeyed || 0) + 1;
            if (destinationColorKey)
                this.stats.ddBlitsDestinationKeyed =
                    (this.stats.ddBlitsDestinationKeyed || 0) + 1;
            if (mirrorX || mirrorY)
                this.stats.ddBlitsMirrored =
                    (this.stats.ddBlitsMirrored || 0) + 1;
        },

        // ---- 0x501 DD_SET_COLOR_KEY ------------------------------------
        onDDSetColorKey(bytes, view, offset) {
            const handle = view.getUint32(offset + D9WG.F.DDSetColorKey.surface_handle, true);
            const kind = view.getUint32(offset + D9WG.F.DDSetColorKey.key_kind, true);
            const low = view.getUint32(offset + D9WG.F.DDSetColorKey.color_low, true);
            const high = view.getUint32(offset + D9WG.F.DDSetColorKey.color_high, true);
            const present = view.getUint32(offset + D9WG.F.DDSetColorKey.present, true) !== 0;
            const resource = this.resources.get(handle);
            if (!resource) return;
            if (!resource.ddColorKey) resource.ddColorKey = {};
            if (present) resource.ddColorKey[kind] = { low, high };
            else delete resource.ddColorKey[kind];
            this.stats.ddColorKeysSet = (this.stats.ddColorKeysSet || 0) + 1;
        },

        // ---- 0x502 DD_SET_SURFACE_PALETTE ------------------------------
        onDDSetSurfacePalette(bytes, view, offset) {
            const handle = view.getUint32(offset + D9WG.F.DDSetSurfacePalette.surface_handle, true);
            const paletteIndex = view.getUint32(offset + D9WG.F.DDSetSurfacePalette.palette_index, true);
            const resource = this.resources.get(handle);
            if (!resource) return;
            resource.ddPaletteIndex = paletteIndex;
            // The bound palette may already have data; drop any GPU copy built
            // from the previous binding.
            resource.ddPaletteSerial = -1;
            this.stats.ddSurfacePalettes =
                (this.stats.ddSurfacePalettes || 0) + 1;
        },

        // ---- 0x503 DD_SET_DISPLAY_MODE ---------------------------------
        onDDSetDisplayMode(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.DDSetDisplayMode.device_handle, true));
            const width = view.getUint32(offset + D9WG.F.DDSetDisplayMode.width, true);
            const height = view.getUint32(offset + D9WG.F.DDSetDisplayMode.height, true);
            const bitsPerPixel = view.getUint32(offset + D9WG.F.DDSetDisplayMode.bits_per_pixel, true);
            const refreshRate = view.getUint32(offset + D9WG.F.DDSetDisplayMode.refresh_rate, true);
            const cooperativeFlags = view.getUint32(offset + D9WG.F.DDSetDisplayMode.cooperative_flags, true);
            const guestModeChanged = view.getUint32(offset + D9WG.F.DDSetDisplayMode.guest_mode_changed, true) !== 0;
            state.ddDisplayMode = { width, height, bitsPerPixel, refreshRate,
                cooperativeFlags, guestModeChanged };
            const exclusiveFullscreen =
                (cooperativeFlags & DDSCL_EXCLUSIVE) !== 0 &&
                (cooperativeFlags & DDSCL_FULLSCREEN) !== 0;
            state.ddClipPrimaryToWrites =
                (cooperativeFlags & DDSCL_NORMAL) !== 0 &&
                !exclusiveFullscreen;
            state.ddScreenWriteRect = null;
            if (width && height) {
                const backBufferSizeChanged =
                    state.backBufferWidth !== width ||
                    state.backBufferHeight !== height;
                if (backBufferSizeChanged) {
                    // DirectDraw creates the executor device as soon as the
                    // cooperative level is set, while the window can still
                    // have a transient client size (dxdiag: 106x2).  The real
                    // primary/flip-chain size arrives only here.  Leaving the
                    // implicit target at the creation size makes a 640x480
                    // SCREEN_BLT clip to the top-left 106x2 -- a black strip
                    // which the page then stretches over the whole overlay.
                    //
                    // A mode switch invalidates the old primary contents.  Do
                    // not let recorded ops or a retained texture with the old
                    // dimensions survive into the first Present of this mode.
                    this.finishFrame(false);
                    this.retireDeviceBackBuffer(state);
                    state.backBufferWidth = width;
                    state.backBufferHeight = height;
                    if ((state.sampleCount || 1) > 1) {
                        this.configureBackBufferMSAA(state, width, height,
                            state.multisampleType, state.multisampleQuality);
                    }
                }
                state.surface = { ...state.surface, width, height,
                    // A DDSCL_NORMAL primary is the desktop, not the HWND's
                    // client area. Present will still report that client's
                    // rectangle, so retain the desktop geometry separately for
                    // the page compositor and use the client-independent dirty
                    // rectangle only as a visibility mask.
                    ddDesktopPrimary: state.ddClipPrimaryToWrites,
                    displayWidth: state.ddClipPrimaryToWrites ? width : 0,
                    displayHeight: state.ddClipPrimaryToWrites ? height : 0,
                    clipRect: null,
                    // Only a mode the guest really switched to puts the window
                    // at the origin covering the emulated screen. When
                    // ChangeDisplaySettings failed the guest keeps a window of
                    // this size instead, and the overlay has to stay where that
                    // window is or the pointer stops matching the picture.
                    ...(exclusiveFullscreen && guestModeChanged
                        ? { x: 0, y: 0 } : {}),
                    fullscreen: exclusiveFullscreen };
                this.notifySurface(state, "display-mode");
            }
            this.stats.ddDisplayModes = (this.stats.ddDisplayModes || 0) + 1;
        },

        // ---- 0x504 DD_UPDATE_OVERLAY ----------------------------------
        onDDUpdateOverlay(bytes, view, offset, length) {
            const surfaceHandle = view.getUint32(offset + D9WG.F.DDUpdateOverlay.surface_handle, true);
            const overlayId = view.getUint32(offset + D9WG.F.DDUpdateOverlay.overlay_id, true);
            const resource = this.resources.get(surfaceHandle);
            if (!resource) return;
            const state = this.deviceState(resource.deviceHandle || 0);
            if (!state.ddOverlays) state.ddOverlays = new Map();
            const flags = view.getUint32(offset + D9WG.F.DDUpdateOverlay.flags, true);
            const destinationHandle = view.getUint32(offset + D9WG.F.DDUpdateOverlay.destination_handle, true);
            const old = state.ddOverlays.get(overlayId) || {};
            if (flags & DDOVER_HIDE) {
                state.ddOverlays.delete(overlayId);
                this.stats.ddOverlayUpdates =
                    (this.stats.ddOverlayUpdates || 0) + 1;
                return;
            }
            const sourceKey = resource.ddColorKey &&
                resource.ddColorKey[DDCKEY_SOURCE_OVERLAY];
            const destination = destinationHandle
                ? this.resources.get(destinationHandle) : null;
            const destinationKey = destination && destination.ddColorKey &&
                destination.ddColorKey[DDCKEY_DESTINATION_OVERLAY];
            const entry = {
                ...old,
                overlayId,
                surfaceHandle,
                destinationHandle,
                sourceRect: [
                    view.getInt32(offset + D9WG.F.DDUpdateOverlay.source_rect, true),
                    view.getInt32(offset + D9WG.F.DDUpdateOverlay.source_rect + 4, true),
                    view.getInt32(offset + D9WG.F.DDUpdateOverlay.source_rect + 8, true),
                    view.getInt32(offset + D9WG.F.DDUpdateOverlay.source_rect + 12, true),
                ],
                destinationRect: [
                    view.getInt32(offset + D9WG.F.DDUpdateOverlay.destination_rect, true),
                    view.getInt32(offset + D9WG.F.DDUpdateOverlay.destination_rect + 4, true),
                    view.getInt32(offset + D9WG.F.DDUpdateOverlay.destination_rect + 8, true),
                    view.getInt32(offset + D9WG.F.DDUpdateOverlay.destination_rect + 12, true),
                ],
                flags,
                zOrder: view.getUint32(offset + D9WG.F.DDUpdateOverlay.z_order, true),
                visible: (flags & DDOVER_SHOW) ? true : !!old.visible,
                // Snapshot the key at UpdateOverlay time. DuplicateSurface
                // aliases share one texture handle but have independent COM
                // key state; the guest deliberately rebinds the right alias
                // immediately before this command.
                sourceColorKey: (flags & DDOVER_KEY_SOURCE) && sourceKey
                    ? { ...sourceKey } : null,
                destinationColorKey:
                    (flags & DDOVER_KEY_DESTINATION) && destinationKey
                        ? { ...destinationKey } : null,
            };
            state.ddOverlays.set(overlayId, entry);
            this.stats.ddOverlayUpdates =
                (this.stats.ddOverlayUpdates || 0) + 1;
        },

        // ---- helpers ---------------------------------------------------
        ddRefuse(key, message, details) {
            this.stats.ddBlitsSkipped = (this.stats.ddBlitsSkipped || 0) + 1;
            this.warnOnce("ddraw-" + key, message, details || {});
        },

        // The GPU copy of the palette a surface samples through, or null when
        // the guest has not sent one yet.
        ddPaletteBufferFor(resource, encoder) {
            const index = resource.ddPaletteIndex;
            if (index === undefined) return null;
            const key = (resource.deviceHandle || 0) + ":" + index;
            const rgba = this.palettes && this.palettes.get(key);
            if (!rgba) return null;
            if (!this.ddPaletteBuffers) this.ddPaletteBuffers = new Map();
            let entry = this.ddPaletteBuffers.get(key);
            if (!entry) {
                entry = {
                    buffer: this.device.createBuffer({
                        label: "DirectDraw palette " + key,
                        size: PALETTE_BYTES,
                        usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
                    }),
                    serial: -1,
                };
                this.ddPaletteBuffers.set(key, entry);
            }
            const serial = (this.ddPaletteSerials &&
                this.ddPaletteSerials.get(key)) || 0;
            if (entry.serial !== serial) {
                const floats = new Float32Array(PALETTE_ENTRIES * 4);
                for (let i = 0; i < PALETTE_ENTRIES; ++i) {
                    floats[i * 4] = rgba[i * 4] / 255;
                    floats[i * 4 + 1] = rgba[i * 4 + 1] / 255;
                    floats[i * 4 + 2] = rgba[i * 4 + 2] / 255;
                    floats[i * 4 + 3] = rgba[i * 4 + 3] / 255;
                }
                const bytes = new Uint8Array(floats.buffer);
                if (encoder) this.encodeBufferUpload(encoder, entry.buffer, bytes);
                else this.stageBufferUpload(entry.buffer, 0, bytes);
                entry.serial = serial;
                this.stats.ddPaletteUploads =
                    (this.stats.ddPaletteUploads || 0) + 1;
            }
            return entry.buffer;
        },

        // DirectDraw keeps P8 surfaces as r8uint so blits and readback preserve
        // the application's indices.  Fixed-function D3D sampling, however,
        // needs filterable colours. Build a companion RGBA texture from the
        // GPU index image and the palette attached to this *surface* (not the
        // device-global D3D9 palette). A keyed companion sets alpha to zero by
        // comparing the original index, so duplicate palette colours cannot
        // make an unrelated texel transparent.
        ddIndexedSampleViewFor(resource, colorKey) {
            if (!resource || !resource.ddIndexed) return null;
            const paletteIndex = resource.ddPaletteIndex;
            const paletteKey = paletteIndex === undefined ? null
                : (resource.deviceHandle || 0) + ":" + paletteIndex;
            const paletteSerial = paletteKey && this.ddPaletteSerials
                ? (this.ddPaletteSerials.get(paletteKey) || 0) : 0;
            const keyLow = colorKey ? colorKey.low & 0xff : -1;
            const keyHigh = colorKey ? colorKey.high & 0xff : -1;
            const variant = colorKey ? "keyed" : "plain";
            const serial = [resource.ddContentSerial || 0, paletteKey || "-",
                paletteSerial, keyLow, keyHigh].join(":");
            if (!resource.ddSampleViews) resource.ddSampleViews = new Map();
            const old = resource.ddSampleViews.get(variant);
            if (old && old.serial === serial) return old.view;

            const layers = resource.layerCount || 1;
            const texture = old ? old.texture : this.device.createTexture({
                label: "DirectDraw indexed D3D sample view",
                size: { width: resource.width, height: resource.height, depthOrArrayLayers: layers },
                format: "rgba8unorm", mipLevelCount: Math.max(1, resource.levelCount || 1),
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_TEXTURE_BINDING,
            });
            const entry = old || { texture, view: texture.createView({
                dimension: resource.textureType === "cube" ? "cube" : "2d",
            }) };
            entry.serial = serial;
            resource.ddSampleViews.set(variant, entry);
            const paletteBuffer = this.ddPaletteBufferFor(resource);
            const frame = this.ensureFrame();
            for (let level = 0; level < Math.max(1, resource.levelCount || 1); ++level) {
                const width = Math.max(1, resource.width >> level), height = Math.max(1, resource.height >> level);
                for (let layer = 0; layer < layers; ++layer) {
                    frame.ops.push({ kind: "ddblit", sourceKind: "index", destinationKind: "float",
                        sourceView: this.blitSourceView(resource, level, layer),
                        destinationView: texture.createView({ dimension: "2d", baseMipLevel: level, mipLevelCount: 1,
                            baseArrayLayer: layer, arrayLayerCount: 1 }),
                        destinationFormat: "rgba8unorm", sourceRect: [0, 0, 1, 1], sourceSize: [width, height],
                        viewport: [0, 0, width, height], paletteBuffer, filterPoint: true,
                        colorKey: colorKey || null, keyToAlpha: !!colorKey });
                }
            }
            resource.frameReferenced = frame.serial;
            this.stats.ddIndexedSampleResolves =
                (this.stats.ddIndexedSampleResolves || 0) + 1;
            return entry.view;
        },

    };

    // A destination rectangle is clipped to the surface; the source rectangle
    // follows it proportionally, which is what makes a sprite that runs off the
    // edge of the screen show its left half rather than its whole self squeezed
    // into the space that was left.


    function installDDrawOps(ExecutorClass) {
        if (!ExecutorClass || ExecutorClass._ddrawOpsInstalled) return;
        Object.assign(ExecutorClass.prototype, ddrawOps);

        // A palette slot's contents change under SET_PALETTE, which belongs to
        // the D3D9 command set. Wrapping it here keeps that file free of
        // DirectDraw concerns while still invalidating the GPU copies built
        // from it -- palette animation is per-frame in this era, so a stale
        // copy is not an edge case.
        const previousSetPalette = ExecutorClass.prototype.onSetPalette;
        ExecutorClass.prototype.onSetPalette = function(bytes, view, offset,
                length, metadata) {
            const result = previousSetPalette.call(this, bytes, view, offset,
                length, metadata);
            const key = view.getUint32(offset, true) + ":" +
                view.getUint32(offset + 4, true);
            if (!this.ddPaletteSerials) this.ddPaletteSerials = new Map();
            this.ddPaletteSerials.set(key,
                (this.ddPaletteSerials.get(key) || 0) + 1);
            return result;
        };

        const previousDestroyResource = ExecutorClass.prototype.onDestroyResource;
        ExecutorClass.prototype.onDestroyResource = function(bytes, view,
                offset, length, metadata) {
            const destroyedHandle = view.getUint32(offset, true);
            const resource = this.resources && this.resources.get(
                destroyedHandle);
            if (resource && resource.ddSampleViews) {
                for (const entry of resource.ddSampleViews.values())
                    this.retireGPUObject(entry.texture);
                resource.ddSampleViews.clear();
            }
            if (this.devices) {
                for (const state of this.devices.values()) {
                    if (!state.ddOverlays) continue;
                    for (const [handle, overlay] of state.ddOverlays) {
                        if (overlay.surfaceHandle === destroyedHandle ||
                                overlay.destinationHandle === destroyedHandle)
                            state.ddOverlays.delete(handle);
                    }
                }
            }
            return previousDestroyResource.call(this, bytes, view, offset,
                length, metadata);
        };

        ExecutorClass.extensionHandlers = Object.assign(
            ExecutorClass.extensionHandlers || {}, {
                [OP_DD_BLT]: ddrawOps.onDDBlt,
                [OP_DD_SET_COLOR_KEY]: ddrawOps.onDDSetColorKey,
                [OP_DD_SET_SURFACE_PALETTE]: ddrawOps.onDDSetSurfacePalette,
                [OP_DD_SET_DISPLAY_MODE]: ddrawOps.onDDSetDisplayMode,
                [OP_DD_UPDATE_OVERLAY]: ddrawOps.onDDUpdateOverlay,
            });
        ExecutorClass._ddrawOpsInstalled = true;
    }

    global.installDDrawOps = installDDrawOps;
    if (global.D3D9WebGPUExecutor) installDDrawOps(global.D3D9WebGPUExecutor);

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            installDDrawOps, ddBlitShaderSource, clipRects, clipDestination,
            OP_DD_BLT, OP_DD_SET_COLOR_KEY, OP_DD_SET_SURFACE_PALETTE,
            OP_DD_SET_DISPLAY_MODE, OP_DD_UPDATE_OVERLAY,
            DDBLT_KEY_SOURCE, DDBLT_KEY_DESTINATION, DDBLT_MIRROR_X,
            DDBLT_MIRROR_Y, DDBLT_COLOR_FILL, DDBLT_DEPTH_FILL,
            DDBLT_FILTER_LINEAR,
            DDOVER_SHOW, DDOVER_HIDE, DDOVER_KEY_SOURCE,
            DDOVER_KEY_DESTINATION, DDOVER_MIRROR_X, DDOVER_MIRROR_Y,
            DDOVER_KEY_SOURCE_OVERRIDE, DDOVER_KEY_DESTINATION_OVERRIDE,
        };
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
