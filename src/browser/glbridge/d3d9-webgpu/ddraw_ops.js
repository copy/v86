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
    const UNIFORM_BYTES = 128;                  // eight vec4s, see WGSL below

    // The blit uniform block, built once per op.
    //   0  source_rect  u, v, du, dv  (du/dv negative when mirrored)
    //  16  source_size   level width, level height
    //  32  key_low       r, g, b (or the palette index in .x)
    //  48  key_high
    //  64  fill          float fill colour
    //  80  fill_index    index fill
    //  96  destination key low
    // 112  destination key high
    function packUniforms(op) {
        const buffer = new ArrayBuffer(UNIFORM_BYTES);
        const floats = new Float32Array(buffer);
        const uints = new Uint32Array(buffer);
        floats[0] = op.sourceRect[0];
        floats[1] = op.sourceRect[1];
        floats[2] = op.sourceRect[2];
        floats[3] = op.sourceRect[3];
        floats[4] = op.sourceSize ? op.sourceSize[0] : 1;
        floats[5] = op.sourceSize ? op.sourceSize[1] : 1;
        const key = op.colorKey;
        uints[8] = key ? (key.low >>> 16) & 0xff : 0;
        uints[9] = key ? (key.low >>> 8) & 0xff : 0;
        uints[10] = key ? key.low & 0xff : 0;
        uints[11] = key ? key.low & 0xff : 0;
        uints[12] = key ? (key.high >>> 16) & 0xff : 0;
        uints[13] = key ? (key.high >>> 8) & 0xff : 0;
        uints[14] = key ? key.high & 0xff : 0;
        uints[15] = key ? key.high & 0xff : 0;
        // An indexed source compares the index itself, which the guest put in
        // the low byte of both ends.
        if (op.sourceKind === "index" && key) {
            uints[8] = key.low & 0xff;
            uints[12] = key.high & 0xff;
        }
        const fill = op.fill || [0, 0, 0, 0];
        floats[16] = fill[0];
        floats[17] = fill[1];
        floats[18] = fill[2];
        floats[19] = fill[3];
        uints[20] = op.fillIndex >>> 0;
        const destinationKey = op.destinationColorKey;
        uints[24] = destinationKey
            ? (destinationKey.low >>> 16) & 0xff : 0;
        uints[25] = destinationKey
            ? (destinationKey.low >>> 8) & 0xff : 0;
        uints[26] = destinationKey ? destinationKey.low & 0xff : 0;
        uints[27] = destinationKey ? destinationKey.low & 0xff : 0;
        uints[28] = destinationKey
            ? (destinationKey.high >>> 16) & 0xff : 0;
        uints[29] = destinationKey
            ? (destinationKey.high >>> 8) & 0xff : 0;
        uints[30] = destinationKey ? destinationKey.high & 0xff : 0;
        uints[31] = destinationKey ? destinationKey.high & 0xff : 0;
        if (op.destinationKind === "index" && destinationKey) {
            uints[24] = destinationKey.low & 0xff;
            uints[28] = destinationKey.high & 0xff;
        }
        return new Uint8Array(buffer);
    }

    function ddBlitShaderSource(variant) {
        const indexedSource = variant.sourceKind === "index";
        const noSource = variant.sourceKind === "none";
        const indexedDestination = variant.destinationKind === "index";
        const outputType = indexedDestination ? "vec4<u32>" : "vec4<f32>";
        const lines = [];
        lines.push(`struct D9DDBlitUniforms {
    source_rect: vec4<f32>,
    source_size: vec4<f32>,
    key_low: vec4<u32>,
    key_high: vec4<u32>,
    fill: vec4<f32>,
    fill_index: vec4<u32>,
    destination_key_low: vec4<u32>,
    destination_key_high: vec4<u32>,
};
@group(0) @binding(0) var<uniform> blit: D9DDBlitUniforms;`);
        if (!noSource) {
            lines.push(indexedSource
                ? "@group(0) @binding(1) var d9dd_source: texture_2d<u32>;"
                : "@group(0) @binding(1) var d9dd_source: texture_2d<f32>;");
            if (!indexedSource)
                lines.push("@group(0) @binding(2) var d9dd_sampler: sampler;");
        }
        if (variant.paletteResolve) {
            lines.push(`struct D9DDPalette {
    entries: array<vec4<f32>, ${PALETTE_ENTRIES}>,
};
@group(0) @binding(3) var<uniform> d9dd_palette: D9DDPalette;`);
        }
        if (variant.destinationKey) {
            lines.push(variant.destinationKind === "index"
                ? "@group(0) @binding(4) var d9dd_destination_key: texture_2d<u32>;"
                : "@group(0) @binding(4) var d9dd_destination_key: texture_2d<f32>;");
        }
        lines.push(`
struct D9DDBlitOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn d9dd_vs_main(@builtin(vertex_index) index: u32) -> D9DDBlitOutput {
    // Two triangles over the whole viewport; setViewport restricts the output
    // to the destination rectangle, so no destination maths belongs here.
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
    let corner = corners[index];
    var result: D9DDBlitOutput;
    result.position = vec4<f32>(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0,
        0.0, 1.0);
    // Mirroring is a negative extent in source_rect rather than a shader
    // variant of its own: DDBLTFX_MIRRORLEFTRIGHT/UPDOWN are exactly a
    // reversed traversal of the source rectangle.
    result.uv = blit.source_rect.xy + corner * blit.source_rect.zw;
    return result;
}`);
        const body = [];
        if (variant.destinationKey) {
            body.push("    let destination_texel = vec2<i32>(stage_in.position.xy);");
            if (indexedDestination) {
                body.push(`    let destination_index = textureLoad(
        d9dd_destination_key, destination_texel, 0).r;
    if (destination_index < blit.destination_key_low.x ||
            destination_index > blit.destination_key_high.x) {
        discard;
    }`);
            } else {
                body.push(`    let destination_color = textureLoad(
        d9dd_destination_key, destination_texel, 0);
    let destination_quantised = vec3<u32>(round(destination_color.rgb * 255.0));
    if (any(destination_quantised < blit.destination_key_low.rgb) ||
            any(destination_quantised > blit.destination_key_high.rgb)) {
        discard;
    }`);
            }
        }
        if (noSource) {
            body.push(indexedDestination
                ? "    return vec4<u32>(blit.fill_index.x, 0u, 0u, 0u);"
                : "    return blit.fill;");
        } else if (indexedSource) {
            body.push(`    let texel = vec2<i32>(clamp(
        floor(stage_in.uv * blit.source_size.xy), vec2<f32>(0.0, 0.0),
        max(blit.source_size.xy - vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0))));
    let index = textureLoad(d9dd_source, texel, 0).r;`);
            if (variant.colorKey)
                body.push(`    if (index >= blit.key_low.x && index <= blit.key_high.x) {
        discard;
    }`);
            if (indexedDestination)
                body.push("    return vec4<u32>(index, 0u, 0u, 0u);");
            else if (variant.paletteResolve)
                body.push("    return d9dd_palette.entries[index];");
            else
                // No palette bound: the indices are all the host has, and
                // inventing colours for them would be a picture the app never
                // asked for. Grey ramp, and the guest is told through the
                // ddPaletteMissing counter.
                body.push("    let level = f32(index) / 255.0;\n" +
                    "    return vec4<f32>(level, level, level, 1.0);");
        } else {
            body.push("    let color = textureSample(d9dd_source, " +
                "d9dd_sampler, stage_in.uv);");
            if (variant.colorKey)
                // Quantised back to the 8-bit-per-channel domain the key lives
                // in. Both ends of the key were widened from the surface
                // format by the same truncating 255/max scale in the guest
                // (ddraw_expand_channel), and the upload widened the texels the
                // same way, so this comparison is exact rather than nearly so.
                body.push(`    let quantised = vec3<u32>(round(color.rgb * 255.0));
    if (all(quantised >= blit.key_low.rgb) &&
            all(quantised <= blit.key_high.rgb)) {
        discard;
    }`);
            body.push(indexedDestination
                ? "    return vec4<u32>(u32(round(color.r * 255.0)), 0u, 0u, 0u);"
                : "    return color;");
        }
        lines.push(`
@fragment
fn d9dd_ps_main(stage_in: D9DDBlitOutput) -> @location(0) ${outputType} {
${body.join("\n")}
}
`);
        return lines.join("\n");
    }

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

        /* Build a disposable scanout image instead of drawing overlays into
         * the retained D3D back buffer. Hiding or moving one therefore exposes
         * the untouched primary immediately, and readback never sees scanout-
         * only overlay pixels. */
        replayDDOverlays(encoder, state, sourceTexture, width, height, frame) {
            if (!state || !state.ddOverlays) return null;
            const overlays = [...state.ddOverlays.values()]
                .filter(entry => entry.visible)
                .sort((a, b) => a.zOrder - b.zOrder);
            if (!overlays.length) return null;
            const composite = this.device.createTexture({
                label: "DirectDraw overlay composite",
                size: { width, height, depthOrArrayLayers: 1 },
                format: this.format,
                mipLevelCount: 1,
                usage: TEXTURE_USAGE_COPY_SRC | TEXTURE_USAGE_COPY_DST |
                    TEXTURE_USAGE_TEXTURE_BINDING |
                    TEXTURE_USAGE_RENDER_ATTACHMENT,
            });
            encoder.copyTextureToTexture({ texture: sourceTexture },
                { texture: composite },
                { width, height, depthOrArrayLayers: 1 });
            const compositeView = composite.createView();

            for (const overlay of overlays) {
                const source = this.resources.get(overlay.surfaceHandle);
                if (!source || !source.gpuTexture) continue;
                const sourceWidth = source.width;
                const sourceHeight = source.height;
                const sourceRect = {
                    left: overlay.sourceRect[0], top: overlay.sourceRect[1],
                    right: overlay.sourceRect[2], bottom: overlay.sourceRect[3],
                };
                const destinationRect = {
                    left: overlay.destinationRect[0],
                    top: overlay.destinationRect[1],
                    right: overlay.destinationRect[2],
                    bottom: overlay.destinationRect[3],
                };
                const clipped = clipRects(sourceRect, destinationRect,
                    width, height);
                if (!clipped) continue;
                const sourceIndexed = !!source.ddIndexed;
                const sourceColorKey = (overlay.flags & DDOVER_KEY_SOURCE)
                    ? overlay.sourceColorKey : null;
                const destinationColorKey =
                    (overlay.flags & DDOVER_KEY_DESTINATION)
                        ? overlay.destinationColorKey : null;
                if ((overlay.flags & DDOVER_KEY_SOURCE) && !sourceColorKey)
                    continue;
                if ((overlay.flags & DDOVER_KEY_DESTINATION) &&
                        !destinationColorKey)
                    continue;
                let paletteBuffer = null;
                if (sourceIndexed) paletteBuffer = this.ddPaletteBufferFor(source);
                const src = clipped.source;
                const sourceU = src.left / sourceWidth;
                const sourceV = src.top / sourceHeight;
                const sourceDU = (src.right - src.left) / sourceWidth;
                const sourceDV = (src.bottom - src.top) / sourceHeight;
                const transient = this.replayDDBlit(encoder, {
                    sourceKind: sourceIndexed ? "index" : "float",
                    destinationKind: "float",
                    sourceView: this.blitSourceView(source, 0, 0),
                    destinationView: compositeView,
                    destinationFormat: this.format,
                    sourceFormat: source.gpuFormat || "rgba8unorm",
                    sourceRect: [
                        (overlay.flags & DDOVER_MIRROR_X)
                            ? sourceU + sourceDU : sourceU,
                        (overlay.flags & DDOVER_MIRROR_Y)
                            ? sourceV + sourceDV : sourceV,
                        (overlay.flags & DDOVER_MIRROR_X)
                            ? -sourceDU : sourceDU,
                        (overlay.flags & DDOVER_MIRROR_Y)
                            ? -sourceDV : sourceDV,
                    ],
                    sourceSize: [sourceWidth, sourceHeight],
                    viewport: clipped.viewport,
                    colorKey: sourceColorKey,
                    destinationColorKey,
                    destinationTexture: sourceTexture,
                    destinationLevel: 0,
                    destinationFace: 0,
                    destinationSize: [width, height],
                    paletteBuffer,
                    paletteResolve: !!paletteBuffer,
                    filterPoint: sourceIndexed,
                }, compositeView, composite);
                if (transient) frame.transientBuffers.push(transient);
                this.stats.ddOverlayComposites =
                    (this.stats.ddOverlayComposites || 0) + 1;
            }
            return composite;
        },

        // ---- helpers ---------------------------------------------------
        ddRefuse(key, message, details) {
            this.stats.ddBlitsSkipped = (this.stats.ddBlitsSkipped || 0) + 1;
            this.warnOnce("ddraw-" + key, message, details || {});
        },

        // The GPU copy of the palette a surface samples through, or null when
        // the guest has not sent one yet.
        ddPaletteBufferFor(resource) {
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
                this.device.queue.writeBuffer(entry.buffer, 0, floats);
                entry.serial = serial;
                this.stats.ddPaletteUploads =
                    (this.stats.ddPaletteUploads || 0) + 1;
            }
            return entry.buffer;
        },

        // DirectDraw keeps P8 surfaces as r8uint so blits and readback preserve
        // the application's indices.  Fixed-function D3D sampling, however,
        // needs filterable colours. Build a companion RGBA texture from the
        // CPU index shadows and the palette attached to this *surface* (not the
        // device-global D3D9 palette). A keyed companion sets alpha to zero by
        // comparing the original index, so duplicate palette colours cannot
        // make an unrelated texel transparent.
        ddIndexedSampleViewFor(resource, colorKey) {
            if (!resource || !resource.ddIndexed) return null;
            const paletteIndex = resource.ddPaletteIndex;
            const paletteKey = paletteIndex === undefined ? null
                : (resource.deviceHandle || 0) + ":" + paletteIndex;
            const palette = paletteKey && this.palettes
                ? this.palettes.get(paletteKey) : null;
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
            const texture = this.device.createTexture({
                label: "DirectDraw indexed D3D sample view",
                size: { width: resource.width, height: resource.height,
                    depthOrArrayLayers: layers },
                format: "rgba8unorm",
                mipLevelCount: Math.max(1, resource.levelCount || 1),
                usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
            });
            for (const shadow of resource.textureShadows
                    ? resource.textureShadows.values() : []) {
                const rgba = new Uint8Array(shadow.width * shadow.height * 4);
                for (let pixel = 0; pixel < shadow.width * shadow.height;
                        ++pixel) {
                    const index = shadow.data[pixel];
                    const at = pixel * 4;
                    if (palette) {
                        rgba[at] = palette[index * 4];
                        rgba[at + 1] = palette[index * 4 + 1];
                        rgba[at + 2] = palette[index * 4 + 2];
                        rgba[at + 3] = palette[index * 4 + 3];
                    } else {
                        rgba[at] = rgba[at + 1] = rgba[at + 2] = index;
                        rgba[at + 3] = 0xff;
                    }
                    if (colorKey && index >= keyLow && index <= keyHigh)
                        rgba[at + 3] = 0;
                }
                this.device.queue.writeTexture({ texture,
                    mipLevel: shadow.level,
                    origin: { x: 0, y: 0, z: shadow.layer || 0 } }, rgba,
                    { bytesPerRow: shadow.width * 4,
                        rowsPerImage: shadow.height },
                    { width: shadow.width, height: shadow.height,
                        depthOrArrayLayers: 1 });
            }
            const entry = { texture, serial, view: texture.createView({
                dimension: resource.textureType === "cube" ? "cube" : "2d",
            }) };
            resource.ddSampleViews.set(variant, entry);
            if (old) this.retireGPUObject(old.texture);
            this.stats.ddIndexedSampleResolves =
                (this.stats.ddIndexedSampleResolves || 0) + 1;
            return entry.view;
        },

        ddBlitPipelineFor(variant) {
            const key = [variant.destinationFormat, variant.sourceKind,
                variant.destinationKind, variant.colorKey ? "key" : "-",
                variant.destinationKey ? "dest-key" : "-",
                variant.paletteResolve ? "pal" : "-",
                variant.filterPoint ? "point" : "linear"].join("|");
            if (!this.ddBlitPipelines) this.ddBlitPipelines = new Map();
            let entry = this.ddBlitPipelines.get(key);
            if (entry) return entry;
            const module = this.moduleFor(ddBlitShaderSource(variant),
                "ddraw blit " + key);
            const entries = [
                { binding: 0, visibility: SHADER_STAGE_VERTEX |
                    SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
            ];
            if (variant.sourceKind === "index")
                entries.push({ binding: 1, visibility: SHADER_STAGE_FRAGMENT,
                    texture: { sampleType: "uint" } });
            else if (variant.sourceKind === "float") {
                entries.push({ binding: 1, visibility: SHADER_STAGE_FRAGMENT,
                    texture: { sampleType: "float" } });
                entries.push({ binding: 2, visibility: SHADER_STAGE_FRAGMENT,
                    sampler: { type: "filtering" } });
            }
            if (variant.paletteResolve)
                entries.push({ binding: 3, visibility: SHADER_STAGE_FRAGMENT,
                    buffer: { type: "uniform" } });
            if (variant.destinationKey)
                entries.push({ binding: 4, visibility: SHADER_STAGE_FRAGMENT,
                    texture: { sampleType: variant.destinationKind === "index"
                        ? "uint" : "float" } });
            const bindGroupLayout =
                this.device.createBindGroupLayout({ entries });
            const pipeline = this.device.createRenderPipeline({
                label: "DirectDraw blit " + key,
                layout: this.device.createPipelineLayout(
                    { bindGroupLayouts: [bindGroupLayout] }),
                vertex: { module, entryPoint: "d9dd_vs_main" },
                fragment: { module, entryPoint: "d9dd_ps_main",
                    targets: [{ format: variant.destinationFormat }] },
                primitive: { topology: "triangle-list" },
            });
            const sampler = variant.sourceKind === "float"
                ? this.device.createSampler({
                    magFilter: variant.filterPoint ? "nearest" : "linear",
                    minFilter: variant.filterPoint ? "nearest" : "linear",
                    addressModeU: "clamp-to-edge",
                    addressModeV: "clamp-to-edge",
                })
                : null;
            entry = { pipeline, bindGroupLayout, sampler };
            this.ddBlitPipelines.set(key, entry);
            return entry;
        },

        // Runs a recorded DirectDraw blit inside finishFrame, where the swap
        // chain view exists.
        replayDDBlit(encoder, op, swapView, swapTexture) {
            const destinationView = op.destinationView || swapView;
            if (!destinationView) return null;
            // A swap-chain source is whatever the canvas format is, never an
            // index texture, and the variant has to say so or the pipeline
            // declares a texture_2d<u32> for a float view.
            const swapchainSource = op.sourceKind !== "none" && !op.sourceView;
            const variant = {
                // The swap-chain image is whatever the canvas format is and is
                // never an index texture, so a blit that reads it is a float
                // blit no matter what the recorded kind said.
                sourceKind: swapchainSource ? "float" : op.sourceKind,
                destinationKind: op.destinationView
                    ? op.destinationKind : "float",
                destinationFormat: op.destinationView
                    ? op.destinationFormat : this.format,
                colorKey: !!op.colorKey,
                destinationKey: !!op.destinationColorKey,
                paletteResolve: !!op.paletteBuffer,
                filterPoint: !!op.filterPoint,
            };
            let snapshotTexture = null;
            let snapshotView = null;
            let destinationKeyView = null;
            if (variant.destinationKey || op.sourceSnapshot) {
                const snapshotSource = variant.destinationKey
                    ? (op.destinationTexture || swapTexture)
                    : op.sourceTexture;
                const size = variant.destinationKey
                    ? (op.destinationSize || [1, 1])
                    : (op.sourceSize || [1, 1]);
                if (!snapshotSource || !size[0] || !size[1]) return null;
                snapshotTexture = this.device.createTexture({
                    label: variant.destinationKey
                        ? "DirectDraw destination colour-key snapshot"
                        : "DirectDraw self-blit snapshot",
                    size: { width: size[0], height: size[1],
                        depthOrArrayLayers: 1 },
                    format: variant.destinationKey
                        ? variant.destinationFormat : op.sourceFormat,
                    mipLevelCount: 1,
                    usage: TEXTURE_USAGE_COPY_DST |
                        TEXTURE_USAGE_TEXTURE_BINDING,
                });
                encoder.copyTextureToTexture({ texture: snapshotSource,
                    mipLevel: variant.destinationKey
                        ? (op.destinationLevel || 0) : (op.sourceLevel || 0),
                    origin: { x: 0, y: 0,
                        z: variant.destinationKey
                            ? (op.destinationFace || 0) : (op.sourceFace || 0) } },
                    { texture: snapshotTexture },
                    { width: size[0], height: size[1],
                        depthOrArrayLayers: 1 });
                snapshotView = snapshotTexture.createView();
                if (variant.destinationKey) destinationKeyView = snapshotView;
            }
            const sourceView = op.sourceKind === "none" ? null
                : (op.sourceSnapshot ? snapshotView : (op.sourceView || swapView));
            if (op.sourceKind !== "none" && !sourceView) return null;
            const entry = this.ddBlitPipelineFor(variant);
            const uniform = this.device.createBuffer({
                size: UNIFORM_BYTES,
                usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
            });
            this.device.queue.writeBuffer(uniform, 0, packUniforms(op));
            const entries = [{ binding: 0, resource: { buffer: uniform } }];
            if (variant.sourceKind !== "none") {
                entries.push({ binding: 1, resource: sourceView });
                if (variant.sourceKind === "float")
                    entries.push({ binding: 2, resource: entry.sampler });
            }
            if (variant.paletteResolve)
                entries.push({ binding: 3,
                    resource: { buffer: op.paletteBuffer } });
            if (variant.destinationKey)
                entries.push({ binding: 4, resource: destinationKeyView });
            const bindGroup = this.device.createBindGroup({
                layout: entry.bindGroupLayout, entries });
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view: destinationView,
                    loadOp: "load", storeOp: "store" }],
            });
            ++this.stats.renderPasses;
            pass.setPipeline(entry.pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.setViewport(op.viewport[0], op.viewport[1], op.viewport[2],
                op.viewport[3], 0, 1);
            pass.draw(6);
            pass.end();
            if (!snapshotTexture) return uniform;
            return { destroy() {
                uniform.destroy();
                snapshotTexture.destroy();
            } };
        },
    };

    // A destination rectangle is clipped to the surface; the source rectangle
    // follows it proportionally, which is what makes a sprite that runs off the
    // edge of the screen show its left half rather than its whole self squeezed
    // into the space that was left.
    function clipRects(source, destination, width, height) {
        const destinationWidth = destination.right - destination.left;
        const destinationHeight = destination.bottom - destination.top;
        const sourceWidth = source.right - source.left;
        const sourceHeight = source.bottom - source.top;
        if (destinationWidth <= 0 || destinationHeight <= 0 ||
                sourceWidth <= 0 || sourceHeight <= 0)
            return null;
        const scaleX = sourceWidth / destinationWidth;
        const scaleY = sourceHeight / destinationHeight;
        const left = Math.max(0, destination.left);
        const top = Math.max(0, destination.top);
        const right = Math.min(width, destination.right);
        const bottom = Math.min(height, destination.bottom);
        if (right <= left || bottom <= top) return null;
        return {
            viewport: [left, top, right - left, bottom - top],
            source: {
                left: source.left + Math.round((left - destination.left) * scaleX),
                top: source.top + Math.round((top - destination.top) * scaleY),
                right: source.right -
                    Math.round((destination.right - right) * scaleX),
                bottom: source.bottom -
                    Math.round((destination.bottom - bottom) * scaleY),
            },
        };
    }

    function clipDestination(destination, width, height) {
        const left = Math.max(0, destination.left);
        const top = Math.max(0, destination.top);
        const right = Math.min(width, destination.right);
        const bottom = Math.min(height, destination.bottom);
        if (right <= left || bottom <= top) return null;
        return { viewport: [left, top, right - left, bottom - top],
            source: { left: 0, top: 0, right: 0, bottom: 0 } };
    }

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
