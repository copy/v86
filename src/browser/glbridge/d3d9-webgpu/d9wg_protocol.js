// The D9WG protocol, once (docs/d3d-webgpu-review.md stage 2): the opcodes,
// the constants and every payload's layout that d3d9.dll, d3d8.dll and
// ddraw.dll write and d3d9_executor.js reads. The guest's d3d9_protocol.h is
// generated from this file (tools/gen_d9wg_header.mjs), with an assert for
// every struct's size and every field's offset; the executor reads payloads
// through the field offsets below rather than numbers of its own. A protocol
// change is made here, and both sides follow.
//
// ITEMS is the header in order -- its comments, constants, opcodes and
// structs (packed, as `#pragma pack(1)` makes them) -- so the generated header
// keeps the documentation it always had.
(function(global) {
    "use strict";

    const ITEMS = [
    { raw: [
        "#ifndef D9WG_PROTOCOL_H",
        "#define D9WG_PROTOCOL_H",
        "",
        "#include <stdint.h>",
        "",
    ] },
    { comment: [
        "/*",
        " * D9WG is an independent protocol from D8WG: it",
        " * does not share opcode numbering, resource handle namespace, or payload",
        " * shapes with the D3D8 path, even though both ride the same VGL2 DMA",
        " * transport (v86gl.sys, 16 MiB ring, PCI BAR) via a different outer record",
        " * type. Current D3D frontends share the process runtime and owner.",
        " * Version 1.8 adds optional mip filter/deferred-generation fields.",
        " *",
        " * Version 1.7 adds the DirectDraw group (0x500) for ../ddrawproxy/ddraw.dll.",
        " * It is additive only -- no existing structure changes -- so d3d8.dll and",
        " * d3d9.dll do not need rebuilding for it.",
        " *",
        " * Version 1.3 deliberately breaks the old layout: it adds multisample fields,",
        " * volume textures, instancing, clip planes, GPU queries, and an asynchronous",
        " * host-to-guest response tail for queries and render-target readback. The",
        " * guest DLL and page executor are updated as one unit, so no compatibility",
        " * decoder for pre-1.3 batches is retained.",
        " */",
    ] },
    { define: "V86GL_CTRL_D3D9_BATCH", c: "0xFFE1u", text: ["#define V86GL_CTRL_D3D9_BATCH 0xFFE1u"] },
    { raw: [
        "",
    ] },
    { define: "D9WG_MAGIC", c: "0x47573944u", text: ["#define D9WG_MAGIC 0x47573944u /* \"D9WG\" */"] },
    { define: "D9WG_VERSION_MAJOR", c: "1u", text: ["#define D9WG_VERSION_MAJOR 1u"] },
    { define: "D9WG_VERSION_MINOR", c: "8u", text: ["#define D9WG_VERSION_MINOR 8u"] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* The last four MiB of v86gl.sys's mapped DMA allocation are never used for",
        " * command batches.  The browser writes asynchronous query/readback results",
        " * back into this region by adding these offsets to the submitted descriptor's",
        " * physical base address. */",
    ] },
    { define: "D9WG_RESPONSE_REGION_BYTES", c: "(4u * 1024u * 1024u)", text: ["#define D9WG_RESPONSE_REGION_BYTES (4u * 1024u * 1024u)"] },
    { define: "D9WG_QUERY_SLOT_BYTES", c: "16u", text: ["#define D9WG_QUERY_SLOT_BYTES 16u"] },
    { define: "D9WG_QUERY_SLOT_COUNT", c: "1024u", text: ["#define D9WG_QUERY_SLOT_COUNT 1024u"] },
    { define: "D9WG_QUERY_REGION_BYTES", c: "(D9WG_QUERY_SLOT_BYTES * D9WG_QUERY_SLOT_COUNT)", text: [
        "#define D9WG_QUERY_REGION_BYTES \\",
        "    (D9WG_QUERY_SLOT_BYTES * D9WG_QUERY_SLOT_COUNT)",
    ] },
    { define: "D9WG_READBACK_REGION_OFFSET", c: "D9WG_QUERY_REGION_BYTES", text: ["#define D9WG_READBACK_REGION_OFFSET D9WG_QUERY_REGION_BYTES"] },
    { raw: [
        "",
    ] },
    { comment: [
        "/*",
        " * A liveness counter the host bumps once per batch it finishes, in the last",
        " * bytes of the response region.",
        " *",
        " * It exists because a readback is a *synchronous* request -- the guest spins",
        " * until the host answers -- while batch submission has no backpressure at all:",
        " * the PCI write returns immediately and the host works through a queue. A host",
        " * that has fallen thousands of batches behind (3DMark06's Image Quality test",
        " * renders ~3.7M draws before asking for its frame dump) answers correctly, just",
        " * far later than any wall-clock deadline the guest could pick. Timing out on",
        " * elapsed time therefore reports \"readback failed\" for a host that is merely",
        " * busy, which is a different fault with a different fix.",
        " *",
        " * Watching this instead makes the deadline mean what it should: give up only",
        " * when the host has stopped making progress at all.",
        " */",
    ] },
    { define: "D9WG_HEARTBEAT_BYTES", c: "16u", text: ["#define D9WG_HEARTBEAT_BYTES 16u"] },
    { define: "D9WG_HEARTBEAT_OFFSET", c: "(D9WG_RESPONSE_REGION_BYTES - D9WG_HEARTBEAT_BYTES)", text: [
        "#define D9WG_HEARTBEAT_OFFSET \\",
        "    (D9WG_RESPONSE_REGION_BYTES - D9WG_HEARTBEAT_BYTES)",
    ] },
    { raw: [
        "",
    ] },
    {"comment": ["/* HELLO replies use the remaining twelve bytes of the existing liveness", " * tail. The heartbeat counter is unchanged. Host magic is published last;", " * missing/old replies imply no optional host features, never all features. */"]},
    {"define": "D9WG_HOST_CAPS_OFFSET", "c": "(D9WG_HEARTBEAT_OFFSET + 4u)", "text": ["#define D9WG_HOST_CAPS_OFFSET (D9WG_HEARTBEAT_OFFSET + 4u)"]},
    {"define": "D9WG_HOST_CAPS_MAGIC", "c": "0x50414348u", "text": ["#define D9WG_HOST_CAPS_MAGIC 0x50414348u"]},
    {"define": "D9WG_HOST_CAPS_VERSION", "c": "1u", "text": ["#define D9WG_HOST_CAPS_VERSION 1u"]},
    {"define": "D9WG_HOST_FEATURE_FLOAT32_FILTERABLE", "c": "(1u << 0)", "text": ["#define D9WG_HOST_FEATURE_FLOAT32_FILTERABLE (1u << 0)"]},
    {"define": "D9WG_HOST_FEATURE_FLOAT32_BLENDABLE", "c": "(1u << 1)", "text": ["#define D9WG_HOST_FEATURE_FLOAT32_BLENDABLE (1u << 1)"]},
    {"define": "D9WG_HOST_FEATURE_TEXTURE_COMPRESSION_BC", "c": "(1u << 2)", "text": ["#define D9WG_HOST_FEATURE_TEXTURE_COMPRESSION_BC (1u << 2)"]},
    {"define": "D9WG_HOST_FEATURE_TIMESTAMP_QUERY", "c": "(1u << 3)", "text": ["#define D9WG_HOST_FEATURE_TIMESTAMP_QUERY (1u << 3)"]},
    {"define": "D9WG_HOST_FEATURE_MASK", "c": "0xFu", "text": ["#define D9WG_HOST_FEATURE_MASK 0xFu"]},
    { define: "D9WG_RESPONSE_PENDING", c: "0u", text: ["#define D9WG_RESPONSE_PENDING 0u"] },
    { define: "D9WG_RESPONSE_OK", c: "1u", text: ["#define D9WG_RESPONSE_OK 1u"] },
    { define: "D9WG_RESPONSE_FAILED", c: "2u", text: ["#define D9WG_RESPONSE_FAILED 2u"] },
    { raw: [
        "",
    ] },
    { define: "D9WG_BATCH_FLAG_PRESENT", c: "(1u << 0)", text: ["#define D9WG_BATCH_FLAG_PRESENT (1u << 0)"] },
    { comment: [
        "/* Internal CreateDevice.behavior_flags bit, never a public D3DCREATE flag.",
        " * DDraw's pre-D3D7 fixed pipeline lights in world space with normalized",
        " * world-matrix basis rows. Old senders leave it clear; D3D8/9 keep their",
        " * existing view-space inverse-transpose lighting. Payloads are unchanged. */",
    ] },
    { define: "D9WG_DEVICE_LEGACY_LIGHTING", c: "(1u << 31)", text: ["#define D9WG_DEVICE_LEGACY_LIGHTING (1u << 31)"] },
    { raw: [
        "",
    ] },
    { comment: [
        "/*",
        " * D9WGHello.feature_bits. The host does not gate anything on these; they let",
        " * diagnostics report whether the active DLL selected the FFP, SM2, or default",
        " * SM3 caps profile without guessing from rendered behaviour.",
        " */",
    ] },
    { define: "D9WG_FEATURE_SHADER_MODEL_2", c: "(1u << 0)", text: ["#define D9WG_FEATURE_SHADER_MODEL_2 (1u << 0)"] },
    { define: "D9WG_FEATURE_SHADER_MODEL_3", c: "(1u << 1)", text: ["#define D9WG_FEATURE_SHADER_MODEL_3 (1u << 1)"] },
    { raw: [
        "",
    ] },
    { opcodes: [
        ["HELLO", 1],
        ["CREATE_DEVICE", 2],
        ["RESET", 3],
        ["PRESENT", 4],
        ["CLEAR", 5],
        ["BEGIN_SCENE", 6],
        ["END_SCENE", 7],
        ["STRETCH_RECT", 8, "M3"],
        ["COLOR_FILL", 9, "M3"],
        ["UPDATE_SURFACE", 10],
        { comment: [
            "    /*",
            "     * Guest -> host diagnostics. The only direction this protocol ever carried",
            "     * was commands, so a call the guest DLL refused was invisible everywhere",
            "     * the developer can actually look: the browser console sees a clean stream",
            "     * of valid commands, and the guest's own trace file lives inside a VM whose",
            "     * filesystem is not reachable from the page. That gap repeatedly turned",
            "     * \"the picture is wrong\" into guesswork, because the one fact that would",
            "     * have ended it -- the app asked for something and was told no -- was",
            "     * written nowhere the developer could read.",
            "     *",
            "     * Deliberately not a general logging channel: only refusals and failures",
            "     * are sent, deduplicated in the guest so a per-frame failure costs one",
            "     * message rather than one per frame.",
            "     */",
        ] },
        ["GUEST_LOG", 11],
        ["READBACK_SURFACE", 12],
        { comment: [
            "    /*",
            "     * The process owning the batch session is going away.  Device destruction",
            "     * is still sent at the normal COM lifetime boundary; this is the fallback",
            "     * that releases anything retained when a process exits abnormally or",
            "     * unloads the proxy with live objects.",
            "     */",
        ] },
        ["SESSION_END", 13],
        { blank: true },
        ["CREATE_BUFFER", 0x100],
        ["UPDATE_BUFFER", 0x101],
        ["DESTROY_RESOURCE", 0x103],
        ["CREATE_TEXTURE_2D", 0x110],
        ["CREATE_TEXTURE_CUBE", 0x111, "M3"],
        ["CREATE_TEXTURE_VOLUME", 0x112],
        ["UPDATE_TEXTURE", 0x113, "M1; z = cube face / volume slice"],
        ["CREATE_VERTEX_DECLARATION", 0x120],
        ["CREATE_VERTEX_SHADER", 0x121, "M2"],
        ["CREATE_PIXEL_SHADER", 0x122, "M2"],
        ["CREATE_QUERY", 0x123],
        ["CREATE_STATE_BLOCK", 0x124, "unused: state blocks are guest-side"],
        { blank: true },
        ["SET_RENDER_STATE", 0x200],
        ["SET_SAMPLER_STATE", 0x201, "M2"],
        ["SET_TEXTURE_STAGE_STATE", 0x202],
        ["SET_TEXTURE", 0x203],
        ["SET_VIEWPORT", 0x204],
        ["SET_SCISSOR_RECT", 0x205, "M3"],
        ["SET_TRANSFORM", 0x206],
        ["SET_MATERIAL", 0x207, "M1 wire, consumed since M3"],
        ["SET_LIGHT", 0x208, "M1 wire, consumed since M3"],
        ["LIGHT_ENABLE", 0x209, "M1 wire, consumed since M3"],
        ["SET_STREAM_SOURCE", 0x20A],
        ["SET_STREAM_SOURCE_FREQ", 0x20B, "indexed instancing"],
        ["SET_INDICES", 0x20C],
        ["SET_VERTEX_DECLARATION", 0x20D],
        ["SET_FVF", 0x20E, "兼容路径"],
        ["SET_RENDER_TARGET", 0x20F, "M3, up to four MRT slots"],
        { comment: [
            "    /* Retired v1.0 opcode. Protocol 1.3 executors do not decode it. */",
        ] },
        ["RESERVED_SET_DEPTH_STENCIL_SURFACE_V1_0", 0x210],
        ["SET_VERTEX_SHADER", 0x211, "M2"],
        ["SET_PIXEL_SHADER", 0x212, "M2"],
        ["SET_VERTEX_SHADER_CONSTANT_F", 0x213, "M2"],
        ["SET_VERTEX_SHADER_CONSTANT_I", 0x214, "M2"],
        ["SET_VERTEX_SHADER_CONSTANT_B", 0x215, "M2"],
        ["SET_PIXEL_SHADER_CONSTANT_F", 0x216, "M2"],
        ["SET_PIXEL_SHADER_CONSTANT_I", 0x217, "M2"],
        ["SET_PIXEL_SHADER_CONSTANT_B", 0x218, "M2"],
        ["SET_CLIP_PLANE", 0x219],
        { comment: [
            "    /* M2: the D3D9 hardware cursor. A fullscreen game draws its pointer",
            "     * through these rather than through GDI, so with them unimplemented the",
            "     * pointer is simply invisible -- the guest's GDI cursor never reaches the",
            "     * VGA framebuffer the site composites underneath, and the site hides the",
            "     * browser cursor (`cursor: none`) on the assumption the guest draws it. */",
        ] },
        ["SET_CURSOR_PROPERTIES", 0x21A],
        ["SET_CURSOR_POSITION", 0x21B],
        ["SHOW_CURSOR", 0x21C],
        { comment: [
            "    /* Diagnostic only: reports what the guest's window manager thinks of the",
            "     * device window. The host draws its overlay unconditionally on top, so a",
            "     * game whose window is minimised, hidden or simply not in the foreground",
            "     * still *looks* perfectly rendered while every click goes somewhere else",
            "     * entirely. Nothing about that is visible in the picture, which is why it",
            "     * has to be reported rather than inferred. */",
        ] },
        ["WINDOW_STATE", 0x21D],
        { comment: [
            "    /* Carries the GetSurfaceLevel subresource as well as the texture handle. */",
        ] },
        ["SET_DEPTH_STENCIL_SURFACE_LEVEL", 0x21E],
        { blank: true },
        { comment: [
            "    /* Protocol 1.4. D3D9 palettes are device state applied at sample time, not",
            "     * baked into the texture, so both the table and which table is current have",
            "     * to reach the host: the same P8 texture must change appearance when the",
            "     * app swaps palettes without re-uploading a byte. */",
        ] },
        ["SET_PALETTE", 0x21F],
        ["SET_CURRENT_TEXTURE_PALETTE", 0x220],
        { blank: true },
        { comment: [
            "    /* IDirect3DBaseTexture9::GenerateMipSubLevels. The *implicit* regeneration",
            "     * D3DUSAGE_AUTOGENMIPMAP asks for needs no opcode: the host sees level 0",
            "     * being written, by upload or by a render pass, and knows more precisely",
            "     * than the guest does when the chain went stale. This carries only the",
            "     * explicit call. */",
        ] },
        ["GENERATE_MIPS", 0x221],
        { blank: true },
        { comment: [
            "    /* Protocol 1.5. IDirect3DBaseTexture9::SetLOD, the per-texture floor on",
            "     * which mip level may be sampled. It is deliberately not folded into",
            "     * D3DSAMP_MAXMIPLEVEL: that one is sampler state and applies to whatever",
            "     * texture is bound to the stage, while this one travels with the texture",
            "     * and outlives any particular binding. The host takes the more restrictive",
            "     * of the two, which is what D3D9 does. */",
        ] },
        ["SET_TEXTURE_LOD", 0x222],
        { blank: true },
        { comment: [
            "    /* Protocol 1.5. IDirect3DDevice9::SetGammaRamp.",
            "     *",
            "     * D3D9 applies this at scanout, after everything else, which is why it is",
            "     * carried as its own command rather than folded into any render state: it",
            "     * has to survive being set once at startup and never mentioned again, and",
            "     * it applies to frames drawn long afterwards. The host applies it in the",
            "     * present blit -- the last place a pixel passes through -- as a 256-entry",
            "     * lookup, which is what the hardware does.",
            "     *",
            "     * Real D3D9 honours the ramp only on a fullscreen device, and silently",
            "     * ignores it windowed. That distinction does not survive here: every frame",
            "     * reaches the page through the same blit, so the ramp is always applied,",
            "     * and a windowed title's brightness slider works where on hardware it",
            "     * would not. */",
        ] },
        ["SET_GAMMA_RAMP", 0x223],
        { blank: true },
        { comment: [
            "    /*",
            "     * Protocol 1.6. IDirect3DDevice9::CreateAdditionalSwapChain and the",
            "     * per-chain Present.",
            "     *",
            "     * An additional swap chain targets a *different* HWND, so the host needs a",
            "     * second drawing surface for it -- the implicit chain's canvas is the one",
            "     * the page composites over the device window and nothing else.",
            "     *",
            "     * The back buffer is deliberately an ordinary render-target texture with an",
            "     * ordinary resource handle, not a second \"handle zero\" special case. That",
            "     * makes every other path work unchanged: SetRenderTarget, StretchRect,",
            "     * GetRenderTargetData and the whole render-pass builder already know how to",
            "     * treat a texture as a target, and the chain only becomes special in the",
            "     * one step that moves the finished image onto its canvas.",
            "     */",
        ] },
        ["CREATE_SWAP_CHAIN", 0x224],
        ["DESTROY_SWAP_CHAIN", 0x225],
        ["PRESENT_SWAP_CHAIN", 0x226],
        { blank: true },
        ["DRAW_PRIMITIVE", 0x300],
        ["DRAW_INDEXED_PRIMITIVE", 0x301],
        ["DRAW_PRIMITIVE_UP", 0x302],
        ["DRAW_INDEXED_PRIMITIVE_UP", 0x303],
        { blank: true },
        ["BEGIN_QUERY", 0x400],
        ["END_QUERY", 0x401],
        ["GET_QUERY_DATA", 0x402],
        { blank: true },
        { comment: [
            "    /*",
            "     * Protocol 1.7. The DirectDraw group, emitted by ../ddrawproxy/ddraw.dll.",
            "     *",
            "     * DirectDraw surfaces are ordinary D9WG textures -- they are created,",
            "     * updated and destroyed by the 0x1xx opcodes like everything else -- and a",
            "     * Direct3D 7 device renders straight into one of them, which is exactly",
            "     * why DirectDraw does not get a protocol of its own. These five carry the",
            "     * semantics D3D9 has no equivalent for: a blit that tests a colour key, a",
            "     * palette that belongs to a surface rather than to the device, and the",
            "     * display mode an exclusive-fullscreen title asked for.",
            "     *",
            "     * Flipping is deliberately absent. A flip chain is rotated guest-side and",
            "     * the new front buffer is blitted into the swap-chain image before",
            "     * PRESENT, which costs one full-screen copy per frame and saves the host",
            "     * an entire lifecycle concept. Clip lists are likewise resolved guest-side",
            "     * into per-rectangle blits.",
            "     */",
        ] },
        ["DD_BLT", 0x500],
        ["DD_SET_COLOR_KEY", 0x501],
        ["DD_SET_SURFACE_PALETTE", 0x502],
        ["DD_SET_DISPLAY_MODE", 0x503],
        ["DD_UPDATE_OVERLAY", 0x504],
    ] },
    { raw: [
        "",
    ] },
    { define: "D9WG_RESOURCE_BUFFER_VERTEX", c: "1u", text: ["#define D9WG_RESOURCE_BUFFER_VERTEX      1u"] },
    { define: "D9WG_RESOURCE_BUFFER_INDEX", c: "2u", text: ["#define D9WG_RESOURCE_BUFFER_INDEX       2u"] },
    { define: "D9WG_RESOURCE_TEXTURE_2D", c: "3u", text: ["#define D9WG_RESOURCE_TEXTURE_2D         3u"] },
    { define: "D9WG_RESOURCE_TEXTURE_CUBE", c: "4u", text: ["#define D9WG_RESOURCE_TEXTURE_CUBE       4u"] },
    { define: "D9WG_RESOURCE_TEXTURE_VOLUME", c: "5u", text: ["#define D9WG_RESOURCE_TEXTURE_VOLUME     5u"] },
    { define: "D9WG_RESOURCE_VERTEX_DECLARATION", c: "6u", text: ["#define D9WG_RESOURCE_VERTEX_DECLARATION 6u"] },
    { define: "D9WG_RESOURCE_VERTEX_SHADER", c: "7u", text: ["#define D9WG_RESOURCE_VERTEX_SHADER      7u"] },
    { define: "D9WG_RESOURCE_PIXEL_SHADER", c: "8u", text: ["#define D9WG_RESOURCE_PIXEL_SHADER       8u"] },
    { define: "D9WG_RESOURCE_QUERY", c: "9u", text: ["#define D9WG_RESOURCE_QUERY              9u"] },
    { define: "D9WG_RESOURCE_STATE_BLOCK", c: "10u", text: ["#define D9WG_RESOURCE_STATE_BLOCK        10u"] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* Shader handles (once M2 starts allocating them) live in a namespace",
        " * disjoint from allocate_handle()'s buffer/texture/declaration counter, with",
        " * bit 0 always set, purely so a host-side resource table keyed by a single",
        " * flat handle space can never collide a shader handle with a buffer/texture/",
        " * declaration handle. Unlike D3D8, D3D9's SetVertexShader/SetFVF/",
        " * SetVertexDeclaration are three distinct COM methods with distinct",
        " * parameter types, so the guest never needs to disambiguate a shader handle",
        " * from an FVF token on the wire -- each has its own opcode. */",
    ] },
    { define: "D9WG_SHADER_HANDLE_BASE", c: "0x40000001u", text: ["#define D9WG_SHADER_HANDLE_BASE 0x40000001u"] },
    { raw: [
        "",
    ] },
    { comment: [
        "/*",
        " * Protocol 1.7, D9WGCreateTexture2D.usage. Not a D3DUSAGE bit: D3DUSAGE never",
        " * defines bit 31, and this is a storage decision rather than anything the app",
        " * asked for.",
        " *",
        " * A P8 texture created with it is kept as an r8uint index texture resolved",
        " * through its palette at sample and present time, instead of the CPU-expanded",
        " * RGBA copy the D3D9 path uses. DirectDraw needs the indexed form for",
        " * correctness, not speed: a 2D title blits P8 into P8 all frame long, and a",
        " * surface holds indices, so a later palette change has to change the colour of",
        " * pixels that were blitted earlier. An RGBA copy cannot be re-indexed, so a",
        " * CPU-expanded destination freezes at whatever palette was current when the",
        " * sprite landed. Colour keying on such a surface compares indices too.",
        " */",
    ] },
    { define: "D9WG_USAGE_DDRAW_INDEXED", c: "0x80000000u", text: ["#define D9WG_USAGE_DDRAW_INDEXED 0x80000000u"] },
    { raw: [
        "",
        "#pragma pack(push, 1)",
    ] },
    { struct: "BatchHeader", note: "32 bytes", fields: [
        ["uint32_t", "magic"],
        ["uint16_t", "version_major"],
        ["uint16_t", "version_minor"],
        ["uint32_t", "frame_id"],
        ["uint32_t", "flags"],
        ["uint32_t", "command_count"],
        ["uint32_t", "command_bytes"],
        ["uint32_t", "session_id_low"],
        ["uint32_t", "session_id_high"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "CommandHeader", note: "16 bytes", fields: [
        ["uint16_t", "opcode"],
        ["uint16_t", "flags"],
        ["uint32_t", "size"],
        ["uint32_t", "sequence"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "HostCapabilities", fields: [
        ["uint32_t", "feature_bits"],
        ["uint32_t", "version"],
        ["volatile uint32_t", "magic"],
    ] },
    { raw: ["",] },
    { struct: "Hello", fields: [
        ["uint32_t", "guest_pointer_bits"],
        ["uint32_t", "feature_bits"],
        ["uint32_t", "session_id_low"],
        ["uint32_t", "session_id_high"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SessionEnd", fields: [
        ["uint32_t", "session_id_low"],
        ["uint32_t", "session_id_high"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "CreateDevice", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "hwnd"],
        ["int32_t", "x"],
        ["int32_t", "y"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
        ["uint32_t", "backbuffer_format"],
        ["uint32_t", "windowed"],
        ["uint32_t", "behavior_flags"],
        ["uint32_t", "enable_auto_depth_stencil"],
        ["uint32_t", "auto_depth_stencil_format"],
        ["uint32_t", "multisample_type"],
        ["uint32_t", "multisample_quality"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "ResetDevice", fields: [
        ["uint32_t", "old_device_handle"],
        ["uint32_t", "new_device_handle"],
        ["uint32_t", "hwnd"],
        ["int32_t", "x"],
        ["int32_t", "y"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
        ["uint32_t", "backbuffer_format"],
        ["uint32_t", "windowed"],
        ["uint32_t", "behavior_flags"],
        ["uint32_t", "enable_auto_depth_stencil"],
        ["uint32_t", "auto_depth_stencil_format"],
        ["uint32_t", "multisample_type"],
        ["uint32_t", "multisample_quality"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "Present", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "hwnd"],
        ["int32_t", "x"],
        ["int32_t", "y"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "Clear", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "clear_flags"],
        ["uint32_t", "color"],
        ["float", "depth"],
        ["uint32_t", "stencil"],
        ["uint32_t", "rect_count"],
    ] },
    { struct: "Rect", note: "16 bytes; inline Clear rectangle", fields: [
        ["int32_t", "left"], ["int32_t", "top"],
        ["int32_t", "right"], ["int32_t", "bottom"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "DeviceOnly", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "CreateBuffer", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "resource_handle"],
        ["uint32_t", "resource_kind"],
        ["uint32_t", "byte_count"],
        ["uint32_t", "usage"],
        ["uint32_t", "fvf", [], "index buffers store D3DFORMAT (INDEX16/INDEX32) here"],
        ["uint32_t", "pool"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "UpdateBuffer", fields: [
        ["uint32_t", "resource_handle"],
        ["uint32_t", "destination_offset"],
        ["uint32_t", "byte_count"],
        ["uint32_t", "data_offset"],
        ["uint32_t", "lock_flags"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "CreateTexture2D", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "resource_handle"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
        ["uint32_t", "level_count"],
        ["uint32_t", "format"],
        ["uint32_t", "usage"],
        ["uint32_t", "pool"],
        ["uint32_t", "multisample_type"],
        ["uint32_t", "multisample_quality"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* depth/slice_pitch are always 1/0 for a 2D texture; the fields exist now so",
        " * D9WG_OP_CREATE_TEXTURE_VOLUME's UpdateTexture traffic (M3) does not need a",
        " * new opcode. */",
    ] },
    { struct: "UpdateTexture", fields: [
        ["uint32_t", "resource_handle"],
        ["uint32_t", "level"],
        ["uint32_t", "x"],
        ["uint32_t", "y"],
        ["uint32_t", "z"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
        ["uint32_t", "depth"],
        ["uint32_t", "row_pitch"],
        ["uint32_t", "slice_pitch"],
        ["uint32_t", "data_bytes"],
        ["uint32_t", "data_offset"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "DestroyResource", fields: [
        ["uint32_t", "resource_handle"],
        ["uint32_t", "resource_kind"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetRenderState", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "state"],
        ["uint32_t", "value"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetSamplerState", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "sampler"],
        ["uint32_t", "state"],
        ["uint32_t", "value"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetTextureStageState", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "stage"],
        ["uint32_t", "state"],
        ["uint32_t", "value"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetTexture", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "stage"],
        ["uint32_t", "texture_handle"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetViewport", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "x"],
        ["uint32_t", "y"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
        ["float", "min_z"],
        ["float", "max_z"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetTransform", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "state", [], "raw D3DTRANSFORMSTATETYPE value, not remapped"],
        ["float", "matrix", [16]],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetMaterial", fields: [
        ["uint32_t", "device_handle"],
        ["float", "diffuse", [4]],
        ["float", "ambient", [4]],
        ["float", "specular", [4]],
        ["float", "emissive", [4]],
        ["float", "power"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetLight", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "index"],
        ["uint32_t", "type"],
        ["float", "diffuse", [4]],
        ["float", "specular", [4]],
        ["float", "ambient", [4]],
        ["float", "position", [3]],
        ["float", "direction", [3]],
        ["float", "range"],
        ["float", "falloff"],
        ["float", "attenuation", [3]],
        ["float", "theta"],
        ["float", "phi"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "LightEnable", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "index"],
        ["uint32_t", "enable"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* offset_in_bytes is D3D9's SetStreamSource OffsetInBytes: the byte offset",
        " * of this binding's first vertex within the buffer. Packing several meshes",
        " * into one large vertex buffer and binding each at its own offset is a very",
        " * common engine pattern, so this is carried on the wire rather than",
        " * restricted to zero. */",
    ] },
    { struct: "SetStreamSource", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "stream"],
        ["uint32_t", "buffer_handle"],
        ["uint32_t", "stride"],
        ["uint32_t", "offset_in_bytes"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* Raw D3D9 SetStreamSourceFreq value. Stream 0 carries",
        " * D3DSTREAMSOURCE_INDEXEDDATA|instance_count; instance streams carry",
        " * D3DSTREAMSOURCE_INSTANCEDATA|step_rate. */",
    ] },
    { struct: "SetStreamSourceFreq", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "stream"],
        ["uint32_t", "divider"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* D3D9's IDirect3DDevice9::SetIndices, unlike D3D8's, carries no base vertex",
        " * index -- that moved to a per-draw parameter (see D9WGDrawIndexedPrimitive).",
        " */",
    ] },
    { struct: "SetIndices", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "buffer_handle"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* Per plan section 4.3, the host never decodes raw FVF bits: the guest",
        " * expands SetFVF(fvf) into the equivalent D3DVERTEXELEMENT9 array (see",
        " * fvf_to_declaration() in d3d9_proxy.c) and sends it here in the same shape",
        " * CREATE_VERTEX_DECLARATION uses, so the host has exactly one vertex-layout",
        " * code path regardless of which legacy/modern API produced it. `fvf` is",
        " * carried only for host-side logging/diagnostics, never interpreted. */",
    ] },
    { struct: "SetFVF", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "fvf"],
        ["uint32_t", "element_count"],
        ["uint32_t", "reserved"],
        { comment: [
            "    /* element_count 个 D9WGVertexElement 紧随其后 */",
        ] },
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetVertexDeclaration", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "declaration_handle"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* D3DVERTEXELEMENT9 has the identical 8-byte shape (Stream/Offset/Type/",
        " * Method/Usage/UsageIndex as WORD/WORD/BYTE/BYTE/BYTE/BYTE), so the guest",
        " * copies the app's array into this type without reinterpreting fields. */",
    ] },
    { struct: "VertexElement", note: "8 bytes", fields: [
        ["uint16_t", "stream"],
        ["uint16_t", "offset"],
        ["uint8_t", "type"],
        ["uint8_t", "method"],
        ["uint8_t", "usage"],
        ["uint8_t", "usage_index"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "CreateVertexDeclaration", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "resource_handle"],
        ["uint32_t", "element_count"],
        ["uint32_t", "reserved"],
        { comment: [
            "    /* element_count 个 D9WGVertexElement 紧随其后, 不含 D3DDECL_END() 哨兵 */",
        ] },
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* M2: CREATE_VERTEX_SHADER / CREATE_PIXEL_SHADER. bytecode_hash lets host",
        " * dedupe compiled WGSL across CreateXShader calls with identical bytecode. */",
    ] },
    { struct: "CreateVertexShader", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "resource_handle"],
        ["uint32_t", "instruction_token_count"],
        ["uint32_t", "code_offset"],
        ["uint32_t", "bytecode_hash_low"],
        ["uint32_t", "bytecode_hash_high"],
    ] },
    { comment: [
        "/* D9WGCreatePixelShader is byte-for-byte identical. */",
    ] },
    { raw: [
        "typedef D9WGCreateVertexShader D9WGCreatePixelShader;",
        "",
    ] },
    { struct: "SetShader", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "shader_handle", [], "0 = unbind (fixed function)"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetShaderConstantF", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "start_register"],
        ["uint32_t", "vector_count", [], "float4 count"],
        ["uint32_t", "data_offset", [], "vector_count*16 bytes, relative to batch base"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetRenderTarget", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "target_index", [], "0..3, MRT (M4)"],
        ["uint32_t", "color_texture_handle", [], "0 = 解除绑定该槽位"],
        ["uint32_t", "color_level"],
        { comment: [
            "    /* D3DCUBEMAP_FACES for a cube map face, 0 for a 2D surface. A cube render",
            "     * target is bound one face at a time -- SetRenderTarget takes the surface",
            "     * GetCubeMapSurface(face, level) returned -- so without this the host can",
            "     * only ever address layer 0 and every face of a dynamic environment map",
            "     * lands on top of the first one. */",
        ] },
        ["uint32_t", "color_face"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* 256 D3DCOLOR (A8R8G8B8) entries follow at data_offset. Always the full",
        " * table: D3D9's SetPaletteEntries replaces all 256 at once. */",
    ] },
    { struct: "SetPalette", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "palette_index"],
        ["uint32_t", "entry_count"],
        ["uint32_t", "data_offset"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetCurrentTexturePalette", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "palette_index"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "GenerateMips", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "resource_handle"],
        ["uint32_t", "filter_type", [], "1.8: 0 keeps the current filter; 1 POINT, 2 LINEAR, 3 ANISOTROPIC"],
        ["uint32_t", "defer_generation", [], "1.8: 1 dirties the chain without generating yet; 0 generates now"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetTextureLOD", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "resource_handle"],
        ["uint32_t", "lod"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "CreateSwapChain", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "swap_chain_handle"],
        { comment: [
            "    /* The render-target texture the chain draws into, created through the",
            "     * ordinary CREATE_TEXTURE_2D path before this arrives. */",
        ] },
        ["uint32_t", "back_buffer_handle"],
        ["uint32_t", "hwnd"],
        ["int32_t", "x"],
        ["int32_t", "y"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "DestroySwapChain", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "swap_chain_handle"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* The window rect is re-sent on every present for the same reason the implicit",
        " * chain's is: the guest has no window-move subclassing, so Present is the live",
        " * source of truth for where the canvas belongs. */",
    ] },
    { struct: "PresentSwapChain", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "swap_chain_handle"],
        ["uint32_t", "hwnd"],
        ["int32_t", "x"],
        ["int32_t", "y"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* 256 entries of red, then 256 green, then 256 blue -- the memory order of",
        " * D3DGAMMARAMP itself, so the guest copies it in one go. */",
    ] },
    { struct: "SetGammaRamp", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "swap_chain"],
        ["uint32_t", "flags"],
        ["uint32_t", "reserved"],
        ["uint16_t", "ramp", [768]],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetScissorRect", fields: [
        ["uint32_t", "device_handle"],
        ["int32_t", "left"],
        ["int32_t", "top"],
        ["int32_t", "right"],
        ["int32_t", "bottom"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* The cursor bitmap, always expanded to A8R8G8B8 by the guest (D3D9 requires",
        " * that format for a cursor surface anyway), followed by width*height*4 bytes",
        " * at data_offset. */",
    ] },
    { struct: "SetCursorProperties", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "hotspot_x"],
        ["uint32_t", "hotspot_y"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
        ["uint32_t", "data_bytes"],
        ["uint32_t", "data_offset"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* Client-relative pixel coordinates, i.e. already in back-buffer space. D3D9's",
        " * hardware cursor tracks the OS pointer on its own once ShowCursor(TRUE) is",
        " * set -- SetCursorPosition only warps it -- so the guest re-sends the live",
        " * position on every Present rather than only when the app calls that method. */",
    ] },
    { struct: "SetCursorPosition", fields: [
        ["uint32_t", "device_handle"],
        ["int32_t", "x"],
        ["int32_t", "y"],
        ["uint32_t", "flags"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "ShowCursor", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "show"],
    ] },
    { raw: [
        "",
    ] },
    { define: "D9WG_WINDOW_IS_WINDOW", c: "(1u << 0)", text: ["#define D9WG_WINDOW_IS_WINDOW    (1u << 0)"] },
    { define: "D9WG_WINDOW_VISIBLE", c: "(1u << 1)", text: ["#define D9WG_WINDOW_VISIBLE      (1u << 1)"] },
    { define: "D9WG_WINDOW_ICONIC", c: "(1u << 2)", text: ["#define D9WG_WINDOW_ICONIC       (1u << 2)"] },
    { define: "D9WG_WINDOW_FOREGROUND", c: "(1u << 3)", text: ["#define D9WG_WINDOW_FOREGROUND   (1u << 3)"] },
    { define: "D9WG_WINDOW_FULLSCREEN", c: "(1u << 4)", text: ["#define D9WG_WINDOW_FULLSCREEN   (1u << 4)"] },
    { comment: [
        "/*",
        " * The guest has nothing to present for this device -- a DirectDraw title that",
        " * released its primary surface, say. The host takes the overlay down for it",
        " * exactly as it does for a hidden window, but the window itself may be up and",
        " * taking input normally, so the reports about visibility and foreground do not",
        " * apply and are not made. Reported alongside the real window state, never",
        " * instead of it.",
        " */",
    ] },
    { define: "D9WG_WINDOW_NO_SURFACE", c: "(1u << 5)", text: ["#define D9WG_WINDOW_NO_SURFACE   (1u << 5)"] },
    { comment: [
        "/*",
        " * Other windows cover all of the device window's client area, so none of its",
        " * frame is on the guest's screen: Warcraft III plays its cinematics in a",
        " * topmost popup over its own D3D window, and the host would otherwise keep",
        " * compositing the last D3D frame over the video. The host hides the device's",
        " * picture exactly as for a hidden window; the window is still up.",
        " */",
    ] },
    { define: "D9WG_WINDOW_OCCLUDED", c: "(1u << 6)", text: ["#define D9WG_WINDOW_OCCLUDED     (1u << 6)"] },
    { comment: [
        "/*",
        " * Other windows cover part of the client area -- a message box, an IME",
        " * candidate list, the Alt+Tab switcher -- and a D9WGWindowRegion follows the",
        " * record: the parts that show, in client coordinates. The host draws the",
        " * device's picture only there, so the guest's windows on top stay visible.",
        " * Without this bit all of the client area shows. A host that predates it",
        " * reads the fixed-size record and ignores what follows.",
        " *",
        " * The region is the window DC's system region (GetRandomRgn SYSRGN), which",
        " * describes this only without a desktop compositor; see glbridge/window_region.h.",
        " */",
    ] },
    { define: "D9WG_WINDOW_REGION", c: "(1u << 7)", text: ["#define D9WG_WINDOW_REGION       (1u << 7)"] },
    { define: "D9WG_WINDOW_REGION_MAX_RECTS", c: "32u", text: ["#define D9WG_WINDOW_REGION_MAX_RECTS 32u"] },
    { raw: [
        "",
    ] },
    { comment: [
        "/*",
        " * window_x/window_y are where the client area's top-left corner is on the",
        " * guest's screen: the host places the device's picture there, exactly as it",
        " * does from D9WGPresent. window_width/window_height are the whole window's",
        " * size, frame included (diagnostic only).",
        " */",
    ] },
    { struct: "WindowState", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "hwnd"],
        ["uint32_t", "foreground_hwnd"],
        ["uint32_t", "flags"],
        ["int32_t", "window_x"],
        ["int32_t", "window_y"],
        ["uint32_t", "window_width"],
        ["uint32_t", "window_height"],
        ["uint32_t", "client_width"],
        ["uint32_t", "client_height"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* Follows D9WGWindowState when D9WG_WINDOW_REGION is set, with rect_count",
        " * rectangles (left, top, right, bottom) of which only those are sent */",
    ] },
    { struct: "WindowRegion", fields: [
        ["uint32_t", "rect_count"],
        ["int32_t", "rects", ["D9WG_WINDOW_REGION_MAX_RECTS", 4]],
    ] },
    { raw: [
        "",
    ] },
    { struct: "WindowStateWithRegion", fields: [
        ["WindowState", "state"],
        ["WindowRegion", "region"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* Bytes of a D9WGWindowStateWithRegion to send */",
    ] },
    { raw: [
        "#define D9WG_WINDOW_STATE_BYTES(with_region) \\",
        "    (sizeof(D9WGWindowState) + ((with_region)->state.flags & D9WG_WINDOW_REGION ? \\",
        "        sizeof(uint32_t) + (with_region)->region.rect_count * 4u * sizeof(int32_t) : 0u))",
        "",
    ] },
    { struct: "CreateQuery", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "resource_handle"],
        ["uint32_t", "query_type"],
        ["uint32_t", "response_offset", [], "from the start of the DMA response region"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* Written host->guest.  Status is deliberately last: emulator.write_memory()",
        " * copies bytes in increasing order, so observing OK also observes the value. */",
    ] },
    { struct: "QueryResponse", fields: [
        ["uint32_t", "request_id"],
        ["uint32_t", "value_low"],
        ["uint32_t", "value_high"],
        ["volatile uint32_t", "status"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "QueryIssue", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "resource_handle"],
        ["uint32_t", "response_offset"],
        ["uint32_t", "request_id"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "ReadbackSurface", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "texture_handle", [], "zero names the current/back-buffer target"],
        ["uint32_t", "level"],
        ["uint32_t", "format"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
        ["uint32_t", "first_row"],
        ["uint32_t", "row_count"],
        ["uint32_t", "destination_pitch"],
        ["uint32_t", "destination_bytes"],
        ["uint32_t", "response_offset"],
        ["uint32_t", "request_id"],
        { comment: [
            "    /* Protocol 1.7 extension. Zero for 2D; 0..5 selects a cube array layer.",
            "     * Appended so older 48-byte senders continue to read face zero. */",
        ] },
        ["uint32_t", "face"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "ReadbackResponse", fields: [
        ["uint32_t", "request_id"],
        ["uint32_t", "byte_count"],
        ["uint32_t", "reserved"],
        ["volatile uint32_t", "status"],
        { comment: [
            "    /* byte_count bytes follow */",
        ] },
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* M3. A cube texture is six square faces at each mip level; the host maps it",
        " * onto a WebGPU 2D texture with six array layers, which is what a",
        " * texture_cube<f32> view is built over. UpdateTexture reaches a face through",
        " * D9WGUpdateTexture.z (0..5, D3DCUBEMAP_FACE_*) -- the same field a volume",
        " * texture uses for its slice, because in both cases it selects the layer/depth",
        " * the upload lands in and neither needs a second opcode. */",
    ] },
    { struct: "CreateTextureCube", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "resource_handle"],
        ["uint32_t", "edge_length"],
        ["uint32_t", "level_count"],
        ["uint32_t", "format"],
        ["uint32_t", "usage"],
        ["uint32_t", "pool"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "CreateTextureVolume", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "resource_handle"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
        ["uint32_t", "depth"],
        ["uint32_t", "level_count"],
        ["uint32_t", "format"],
        ["uint32_t", "usage"],
        ["uint32_t", "pool"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* M3. WebGPU/WGSL has no clip-distance facility, so a user clip plane becomes a",
        " * per-plane distance the vertex stage writes and the fragment stage discards",
        " * on (plan 9.11). D3D9 defines the plane in world space for fixed-function",
        " * vertex processing and in clip space when a vertex shader is bound; the guest",
        " * sends the app's coefficients unchanged and the host applies the space rule,",
        " * because only the host knows which vertex stage a given draw resolved to. */",
    ] },
    { struct: "SetClipPlane", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "index", [], "0..5"],
        ["float", "plane", [4]],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* M4 (implemented ahead of schedule -- a 2005-era D3D9 game renders most of its",
        " * frame into textures). The bound surface is always identified by the host",
        " * texture it is a level of, so a standalone CreateRenderTarget surface is sent",
        " * as a CREATE_TEXTURE_2D with D3DUSAGE_RENDERTARGET rather than needing its own",
        " * resource kind.",
        " *",
        " * depth_texture_handle needs three distinguishable values, not two: a real",
        " * surface, \"no depth at all\" (SetDepthStencilSurface(NULL), which D3D9 permits",
        " * and which disables depth testing for the following draws), and \"the device's",
        " * own implicit auto depth-stencil\". The third exists because the standard",
        " * render-to-texture sequence is Get the current depth surface, bind a different",
        " * one, then put the original back -- and the original has no texture handle of",
        " * its own, so without a sentinel it would be indistinguishable from unbinding. */",
    ] },
    { define: "D9WG_AUTO_DEPTH_STENCIL_HANDLE", c: "0xFFFFFFFFu", text: ["#define D9WG_AUTO_DEPTH_STENCIL_HANDLE 0xFFFFFFFFu"] },
    { struct: "SetDepthStencilSurface", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "depth_texture_handle"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "SetDepthStencilSurfaceLevel", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "depth_texture_handle"],
        { comment: [
            "    /* The mip selected by IDirect3DTexture9::GetSurfaceLevel.  Unlike the",
            "     * implicit auto depth-stencil, an explicit depth texture can expose any",
            "     * of its levels as a surface, so the subresource is part of the binding. */",
        ] },
        ["uint32_t", "depth_level"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* StretchRect between two surfaces the host owns. A zero *_texture_handle names",
        " * the current render target (D3D9 apps routinely stretch the back buffer into a",
        " * texture and back), and level selects the mip. filter_point is",
        " * D3DTEXF_POINT vs anything else, which is the only distinction WebGPU's blit",
        " * path can honour. */",
    ] },
    { struct: "StretchRect", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "source_texture_handle"],
        ["uint32_t", "source_level"],
        ["int32_t", "source_left"],
        ["int32_t", "source_top"],
        ["int32_t", "source_right"],
        ["int32_t", "source_bottom"],
        ["uint32_t", "destination_texture_handle"],
        ["uint32_t", "destination_level"],
        ["int32_t", "destination_left"],
        ["int32_t", "destination_top"],
        ["int32_t", "destination_right"],
        ["int32_t", "destination_bottom"],
        ["uint32_t", "filter_point"],
        { comment: [
            "    /* Cube faces, 0 for 2D surfaces. Present for the same reason as",
            "     * D9WGSetRenderTarget::color_face: without them a blit that names one face",
            "     * of an environment map silently lands on face 0, which is a wrong-pixels",
            "     * bug rather than an error anything reports. */",
        ] },
        ["uint32_t", "source_face"],
        ["uint32_t", "destination_face"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "ColorFill", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "texture_handle"],
        ["uint32_t", "level"],
        ["uint32_t", "color"],
        ["int32_t", "left"],
        ["int32_t", "top"],
        ["int32_t", "right"],
        ["int32_t", "bottom"],
        ["uint32_t", "face", [], "cube face, 0 for a 2D surface"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/*",
        " * D9WG_OP_GUEST_LOG. `text_bytes` ASCII characters follow the header, not",
        " * NUL-terminated. Severity is advisory: the host picks console.warn or",
        " * console.error from it, nothing is gated on it.",
        " */",
    ] },
    { define: "D9WG_LOG_SEVERITY_INFO", c: "0u", text: ["#define D9WG_LOG_SEVERITY_INFO    0u  /* identification, not a problem */"] },
    { define: "D9WG_LOG_SEVERITY_REFUSED", c: "1u", text: ["#define D9WG_LOG_SEVERITY_REFUSED 1u  /* a call the guest DLL turned down */"] },
    { define: "D9WG_LOG_SEVERITY_FAILED", c: "2u", text: ["#define D9WG_LOG_SEVERITY_FAILED  2u  /* a call that should have worked but did not */"] },
    { define: "D9WG_LOG_MAX_TEXT", c: "240u", text: ["#define D9WG_LOG_MAX_TEXT 240u"] },
    { raw: [
        "",
    ] },
    { struct: "GuestLog", fields: [
        ["uint32_t", "severity"],
        ["uint32_t", "text_bytes"],
        { comment: [
            "    /* text_bytes of ASCII follow immediately. */",
        ] },
    ] },
    { raw: [
        "",
    ] },
    { struct: "DrawPrimitive", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "primitive_type"],
        ["uint32_t", "start_vertex"],
        ["uint32_t", "primitive_count"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* base_vertex_index is a per-draw parameter in D3D9 (see D9WGSetIndices). */",
    ] },
    { struct: "DrawIndexedPrimitive", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "primitive_type"],
        ["int32_t", "base_vertex_index"],
        ["uint32_t", "min_vertex_index"],
        ["uint32_t", "vertex_count"],
        ["uint32_t", "start_index"],
        ["uint32_t", "primitive_count"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "DrawPrimitiveUP", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "primitive_type"],
        ["uint32_t", "primitive_count"],
        ["uint32_t", "stride"],
        ["uint32_t", "vertex_count"],
        ["uint32_t", "vertex_bytes"],
        ["uint32_t", "vertex_data_offset"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { struct: "DrawIndexedPrimitiveUP", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "primitive_type"],
        ["uint32_t", "min_vertex_index"],
        ["uint32_t", "vertex_count"],
        ["uint32_t", "primitive_count"],
        ["uint32_t", "index_format"],
        ["uint32_t", "stride"],
        ["uint32_t", "index_count"],
        ["uint32_t", "index_bytes"],
        ["uint32_t", "vertex_bytes"],
        ["uint32_t", "index_data_offset"],
        ["uint32_t", "vertex_data_offset"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/* ------------------------------------------------------------------ *",
        " * Protocol 1.7: the DirectDraw group",
        " * ------------------------------------------------------------------ */",
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/*",
        " * Blt/BltFast/Load, and the flip-chain rotation the guest turns into a blit",
        " * into the swap-chain image. Handle 0 is the swap-chain image on either side.",
        " *",
        " * A blit with no colour key, no mirror, matching formats and matching extents",
        " * is a straight texture-to-texture copy; anything else is a draw through the",
        " * blit pipeline cache, keyed by (source format, destination format, flags).",
        " */",
    ] },
    { struct: "DDBlt", note: "80 bytes", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "source_handle"],
        ["uint32_t", "source_level"],
        ["uint32_t", "source_face"],
        ["int32_t", "source_rect", [4], "left, top, right, bottom"],
        ["uint32_t", "destination_handle"],
        ["uint32_t", "destination_level"],
        ["uint32_t", "destination_face"],
        ["uint32_t", "flags"],
        ["int32_t", "destination_rect", [4]],
        ["uint32_t", "fill_color", [], "COLOR_FILL: the destination format's own value"],
        ["float", "fill_depth"],
        ["uint32_t", "fill_stencil"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { define: "D9WG_DDBLT_KEY_SOURCE", c: "(1u << 0)", text: ["#define D9WG_DDBLT_KEY_SOURCE (1u << 0)"] },
    { define: "D9WG_DDBLT_KEY_DESTINATION", c: "(1u << 1)", text: ["#define D9WG_DDBLT_KEY_DESTINATION (1u << 1)"] },
    { define: "D9WG_DDBLT_MIRROR_X", c: "(1u << 2)", text: ["#define D9WG_DDBLT_MIRROR_X (1u << 2)"] },
    { define: "D9WG_DDBLT_MIRROR_Y", c: "(1u << 3)", text: ["#define D9WG_DDBLT_MIRROR_Y (1u << 3)"] },
    { define: "D9WG_DDBLT_COLOR_FILL", c: "(1u << 4)", text: ["#define D9WG_DDBLT_COLOR_FILL (1u << 4)"] },
    { define: "D9WG_DDBLT_DEPTH_FILL", c: "(1u << 5)", text: ["#define D9WG_DDBLT_DEPTH_FILL (1u << 5)"] },
    { define: "D9WG_DDBLT_FILTER_LINEAR", c: "(1u << 6)", text: ["#define D9WG_DDBLT_FILTER_LINEAR (1u << 6)"] },
    { raw: [
        "",
    ] },
    { comment: [
        "/*",
        " * A colour key is surface state, not a blit parameter: DDBLT_KEYSRC means",
        " * \"use the key attached to the source surface\". DDBLT_KEYSRCOVERRIDE, which",
        " * carries its own key, is resolved guest-side into a temporary key set around",
        " * the blit rather than two more fields here.",
        " *",
        " * color_low/color_high are already in the comparison domain the host uses:",
        " * 8-bit-per-channel values expanded from the surface format by truncating a",
        " * value*255/max scale, or the raw index for a palettised surface. The guest",
        " * and the host",
        " * must expand by the same rule or sprite edges keep a rim of pixels that",
        " * should have been transparent -- see ../ddrawproxy/ddraw_protocol.h.",
        " */",
    ] },
    { struct: "DDSetColorKey", note: "24 bytes", fields: [
        ["uint32_t", "surface_handle"],
        ["uint32_t", "key_kind", [], "D9WG_DDCKEY_*"],
        ["uint32_t", "color_low"],
        ["uint32_t", "color_high"],
        ["uint32_t", "present", [], "0 clears the key"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { define: "D9WG_DDCKEY_SOURCE_BLT", c: "0u", text: ["#define D9WG_DDCKEY_SOURCE_BLT 0u"] },
    { define: "D9WG_DDCKEY_DESTINATION_BLT", c: "1u", text: ["#define D9WG_DDCKEY_DESTINATION_BLT 1u"] },
    { define: "D9WG_DDCKEY_SOURCE_OVERLAY", c: "2u", text: ["#define D9WG_DDCKEY_SOURCE_OVERLAY 2u"] },
    { define: "D9WG_DDCKEY_DESTINATION_OVERLAY", c: "3u", text: ["#define D9WG_DDCKEY_DESTINATION_OVERLAY 3u"] },
    { raw: [
        "",
    ] },
    { comment: [
        "/*",
        " * Binds a surface to one of the palette slots D9WG_OP_SET_PALETTE fills. D3D9",
        " * palettes are device state and a texture samples through whichever one is",
        " * current; DirectDraw attaches a palette to each surface, and two P8 surfaces",
        " * with different palettes are routine. A surface with no binding falls back to",
        " * the device's current palette.",
        " */",
    ] },
    { struct: "DDSetSurfacePalette", note: "16 bytes", fields: [
        ["uint32_t", "surface_handle"],
        ["uint32_t", "palette_index"],
        ["uint32_t", "flags"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { comment: [
        "/*",
        " * SetDisplayMode plus the cooperative level it was set under.",
        " *",
        " * guest_mode_changed reports whether ChangeDisplaySettings actually moved the",
        " * guest desktop to that mode. Only the guest knows, and the answer decides",
        " * whether the overlay covers the whole emulated screen or just the window",
        " * rectangle -- it cannot be inferred from the rendered image.",
        " */",
    ] },
    { struct: "DDSetDisplayMode", note: "32 bytes", fields: [
        ["uint32_t", "device_handle"],
        ["uint32_t", "width"],
        ["uint32_t", "height"],
        ["uint32_t", "bits_per_pixel"],
        ["uint32_t", "refresh_rate"],
        ["uint32_t", "cooperative_flags", [], "D9WG_DDSCL_*"],
        ["uint32_t", "guest_mode_changed"],
        ["uint32_t", "reserved"],
    ] },
    { raw: [
        "",
    ] },
    { define: "D9WG_DDSCL_NORMAL", c: "(1u << 0)", text: ["#define D9WG_DDSCL_NORMAL (1u << 0)"] },
    { define: "D9WG_DDSCL_EXCLUSIVE", c: "(1u << 1)", text: ["#define D9WG_DDSCL_EXCLUSIVE (1u << 1)"] },
    { define: "D9WG_DDSCL_FULLSCREEN", c: "(1u << 2)", text: ["#define D9WG_DDSCL_FULLSCREEN (1u << 2)"] },
    { raw: [
        "",
    ] },
    { comment: [
        "/*",
        " * UpdateOverlay. Approximated as a present-time composite: the overlay surface",
        " * is drawn over the swap-chain image in z_order, honouring its colour key.",
        " * Real hardware overlays are composited at scanout, independent of the flip",
        " * chain and of GDI, and that part does not survive here.",
        " */",
    ] },
    { struct: "DDUpdateOverlay", note: "52 bytes", fields: [
        ["uint32_t", "surface_handle"],
        ["uint32_t", "overlay_id", [], "COM-surface identity; aliases share only pixels"],
        ["int32_t", "source_rect", [4]],
        ["int32_t", "destination_rect", [4]],
        ["uint32_t", "flags", [], "D9WG_DDOVER_*"],
        ["uint32_t", "z_order"],
        ["uint32_t", "destination_handle", [], "key state lives on the primary surface"],
    ] },
    { raw: [
        "",
    ] },
    { define: "D9WG_DDOVER_SHOW", c: "(1u << 0)", text: ["#define D9WG_DDOVER_SHOW (1u << 0)"] },
    { define: "D9WG_DDOVER_HIDE", c: "(1u << 1)", text: ["#define D9WG_DDOVER_HIDE (1u << 1)"] },
    { define: "D9WG_DDOVER_KEY_SOURCE", c: "(1u << 2)", text: ["#define D9WG_DDOVER_KEY_SOURCE (1u << 2)"] },
    { define: "D9WG_DDOVER_KEY_DESTINATION", c: "(1u << 3)", text: ["#define D9WG_DDOVER_KEY_DESTINATION (1u << 3)"] },
    { define: "D9WG_DDOVER_MIRROR_X", c: "(1u << 4)", text: ["#define D9WG_DDOVER_MIRROR_X (1u << 4)"] },
    { define: "D9WG_DDOVER_MIRROR_Y", c: "(1u << 5)", text: ["#define D9WG_DDOVER_MIRROR_Y (1u << 5)"] },
    { define: "D9WG_DDOVER_KEY_SOURCE_OVERRIDE", c: "(1u << 6)", text: ["#define D9WG_DDOVER_KEY_SOURCE_OVERRIDE (1u << 6)"] },
    { define: "D9WG_DDOVER_KEY_DESTINATION_OVERRIDE", c: "(1u << 7)", text: ["#define D9WG_DDOVER_KEY_DESTINATION_OVERRIDE (1u << 7)"] },
    { raw: [
        "",
        "#pragma pack(pop)",
        "",
        "#define D9WG_ALIGN8(value) (((uint32_t)(value) + 7u) & ~7u)",
        "",
        "",
        "#endif",
        "",
    ] },
    ];

    // Each opcode's payload struct; `trailing`: what follows it in the command
    // (the decoder's business, not the struct's)
    const COMMANDS = {
        HELLO: "Hello", CREATE_DEVICE: "CreateDevice", RESET: "ResetDevice", PRESENT: "Present",
        CLEAR: ["Clear", "rect_count rectangles of 4 int32"], BEGIN_SCENE: "DeviceOnly", END_SCENE: "DeviceOnly",
        STRETCH_RECT: "StretchRect", COLOR_FILL: "ColorFill", GUEST_LOG: ["GuestLog", "the text"],
        READBACK_SURFACE: "ReadbackSurface", SESSION_END: "SessionEnd",
        CREATE_BUFFER: "CreateBuffer", UPDATE_BUFFER: ["UpdateBuffer", "the bytes, at data_offset"],
        DESTROY_RESOURCE: "DestroyResource", CREATE_TEXTURE_2D: "CreateTexture2D",
        CREATE_TEXTURE_CUBE: "CreateTextureCube", CREATE_TEXTURE_VOLUME: "CreateTextureVolume",
        UPDATE_TEXTURE: ["UpdateTexture", "the texels, at data_offset"],
        CREATE_VERTEX_DECLARATION: ["CreateVertexDeclaration", "element_count VertexElement"],
        CREATE_VERTEX_SHADER: ["CreateVertexShader", "the token stream, at code_offset"],
        CREATE_PIXEL_SHADER: ["CreateVertexShader", "the token stream, at code_offset"],
        CREATE_QUERY: "CreateQuery", SET_RENDER_STATE: "SetRenderState", SET_SAMPLER_STATE: "SetSamplerState",
        SET_TEXTURE_STAGE_STATE: "SetTextureStageState", SET_TEXTURE: "SetTexture", SET_VIEWPORT: "SetViewport",
        SET_SCISSOR_RECT: "SetScissorRect", SET_TRANSFORM: "SetTransform", SET_MATERIAL: "SetMaterial",
        SET_LIGHT: "SetLight", LIGHT_ENABLE: "LightEnable", SET_STREAM_SOURCE: "SetStreamSource",
        SET_STREAM_SOURCE_FREQ: "SetStreamSourceFreq", SET_INDICES: "SetIndices",
        SET_VERTEX_DECLARATION: "SetVertexDeclaration", SET_FVF: ["SetFVF", "element_count VertexElement"],
        SET_RENDER_TARGET: "SetRenderTarget", SET_VERTEX_SHADER: "SetShader", SET_PIXEL_SHADER: "SetShader",
        SET_VERTEX_SHADER_CONSTANT_F: ["SetShaderConstantF", "the registers, at data_offset"],
        SET_VERTEX_SHADER_CONSTANT_I: ["SetShaderConstantF", "the registers, at data_offset"],
        SET_VERTEX_SHADER_CONSTANT_B: ["SetShaderConstantF", "the registers, at data_offset"],
        SET_PIXEL_SHADER_CONSTANT_F: ["SetShaderConstantF", "the registers, at data_offset"],
        SET_PIXEL_SHADER_CONSTANT_I: ["SetShaderConstantF", "the registers, at data_offset"],
        SET_PIXEL_SHADER_CONSTANT_B: ["SetShaderConstantF", "the registers, at data_offset"],
        SET_CLIP_PLANE: "SetClipPlane", SET_CURSOR_PROPERTIES: ["SetCursorProperties", "the image"],
        SET_CURSOR_POSITION: "SetCursorPosition", SHOW_CURSOR: "ShowCursor",
        WINDOW_STATE: ["WindowState", "its WindowRegion, when flags has D9WG_WINDOW_REGION"],
        SET_DEPTH_STENCIL_SURFACE_LEVEL: "SetDepthStencilSurfaceLevel",
        SET_PALETTE: ["SetPalette", "the entries, at data_offset"], SET_CURRENT_TEXTURE_PALETTE: "SetCurrentTexturePalette",
        GENERATE_MIPS: "GenerateMips", SET_TEXTURE_LOD: "SetTextureLOD", SET_GAMMA_RAMP: "SetGammaRamp",
        CREATE_SWAP_CHAIN: "CreateSwapChain", DESTROY_SWAP_CHAIN: "DestroySwapChain",
        PRESENT_SWAP_CHAIN: "PresentSwapChain", DRAW_PRIMITIVE: "DrawPrimitive",
        DRAW_INDEXED_PRIMITIVE: "DrawIndexedPrimitive", DRAW_PRIMITIVE_UP: ["DrawPrimitiveUP", "the vertices"],
        DRAW_INDEXED_PRIMITIVE_UP: ["DrawIndexedPrimitiveUP", "the indices, then the vertices"],
        BEGIN_QUERY: "QueryIssue", END_QUERY: "QueryIssue", DD_BLT: "DDBlt", DD_SET_COLOR_KEY: "DDSetColorKey",
        DD_SET_SURFACE_PALETTE: "DDSetSurfacePalette", DD_SET_DISPLAY_MODE: "DDSetDisplayMode",
        DD_UPDATE_OVERLAY: "DDUpdateOverlay",
    };

    /*
     * The fields protocol minors after the oldest the host still decodes
     * (1.3) appended to a payload: a payload from an older guest is shorter
     * by them, and they read as 0 -- which is what that guest meant. Every
     * other field is required: a payload shorter than its struct without
     * them is the guest and host disagreeing about the layout.
     */
    const MIN_MINOR = 3;
    const ADDED_FIELDS = {
        GenerateMips: ["filter_type", "defer_generation"],  // 1.8: old 8-byte payload generates with its existing filter
        SetRenderTarget: ["color_face"],                    // 1.4: cube faces
        StretchRect: ["source_face", "destination_face"],   // 1.4
        ColorFill: ["face", "reserved"],                    // 1.4
        ReadbackSurface: ["face"],                          // 1.4
    };

    const SCALAR_BYTES = { uint8_t: 1, uint16_t: 2, uint32_t: 4, int32_t: 4, float: 4 };

    // The constants, evaluated from their C (unsigned 32-bit)
    const C = {};
    for (const item of ITEMS) {
        if (!item.define) continue;
        const js = item.c.replace(/\b(0x[0-9a-fA-F]+|\d+)[uU]\b/g, "$1")
            .replace(/\b(?:D9WG|V86GL)_\w+\b/g, name => {
                if (!(name in C)) throw new Error("D9WG: " + item.define + " uses " + name + " before it is defined");
                return String(C[name]);
            });
        C[item.define] = Function("return (" + js + ") >>> 0")();
    }

    const OP = {};
    const OP_NAME = {};
    for (const item of ITEMS) {
        if (!item.opcodes) continue;
        for (const entry of item.opcodes) {
            if (!Array.isArray(entry)) continue;
            OP[entry[0]] = entry[1];
            OP_NAME[entry[1]] = entry[0];
        }
    }

    // STRUCTS.SetViewport = { size, fields: { min_z: { offset, type, count, bytes } } };
    // F.SetViewport.min_z is the field's offset in the payload
    const STRUCTS = {};
    const F = {};
    for (const item of ITEMS) {
        if (!item.struct) continue;
        let offset = 0;
        const fields = {};
        for (const field of item.fields) {
            if (!Array.isArray(field)) continue;
            const [type, name, dims = []] = field;
            const base = type.replace(/^volatile /, "");
            const unit = SCALAR_BYTES[base] || STRUCTS[base].size;
            const count = dims.reduce((n, d) => n * (typeof d === "number" ? d : C[d]), 1);
            fields[name] = { offset, type: base, count, bytes: unit * count };
            offset += unit * count;
        }
        STRUCTS[item.struct] = { size: offset, fields };
        F[item.struct] = Object.fromEntries(Object.entries(fields).map(([name, f]) => [name, f.offset]));
    }

    const READ = {
        uint8_t: (view, at) => view.getUint8(at),
        uint16_t: (view, at) => view.getUint16(at, true),
        uint32_t: (view, at) => view.getUint32(at, true),
        int32_t: (view, at) => view.getInt32(at, true),
        float: (view, at) => view.getFloat32(at, true),
    };
    const WRITE = {
        uint8_t: (view, at, v) => view.setUint8(at, v),
        uint16_t: (view, at, v) => view.setUint16(at, v, true),
        uint32_t: (view, at, v) => view.setUint32(at, v >>> 0, true),
        int32_t: (view, at, v) => view.setInt32(at, v, true),
        float: (view, at, v) => view.setFloat32(at, v, true),
    };

    /*
     * A payload as an object, scalars and arrays (flattened) by field name.
     * Fields past `length` -- a payload of an older protocol minor, shorter
     * by the fields added since -- read as 0, which is what they meant.
     * (The executor's hot paths read single fields through F instead.)
     */
    function decode(struct, view, offset, length = STRUCTS[struct].size) {
        const out = {};
        for (const [name, field] of Object.entries(STRUCTS[struct].fields)) {
            const unit = field.bytes / field.count;
            const read = READ[field.type];
            const value = i => field.offset + (i + 1) * unit <= length && read ? read(view, offset + field.offset + i * unit) : 0;
            out[name] = field.count === 1 ? value(0) : Array.from({ length: field.count }, (_, i) => value(i));
        }
        return out;
    }

    // A payload from an object (absent fields 0), for tests and the SVGA encoder
    function encode(struct, values) {
        for (const name of Object.keys(values))
            if (!(name in STRUCTS[struct].fields)) throw new Error("D9WG: unknown field " + struct + "." + name);
        const bytes = new Uint8Array(STRUCTS[struct].size);
        const view = new DataView(bytes.buffer);
        for (const [name, field] of Object.entries(STRUCTS[struct].fields)) {
            const value = values[name];
            if (value === undefined) continue;
            const unit = field.bytes / field.count;
            const list = field.count === 1 ? [value] : value;
            if (!list || list.length !== field.count) throw new Error("D9WG: array size " + struct + "." + name);
            if (!WRITE[field.type]) throw new Error("D9WG: " + struct + "." + name + " is not a scalar field");
            list.forEach((v, i) => WRITE[field.type](view, field.offset + i * unit, v));
        }
        return bytes;
    }

    // Self-contained packets for tests/recorders. Payloads may be raw bytes
    // for deliberately malformed/old-version tests; ordinary clients use
    // named objects. Blob offsets are named fields, never literal positions.
    function encodeBatch(commands, header = {}) {
        const batchHeader = STRUCTS.BatchHeader.size, commandHeader = STRUCTS.CommandHeader.size;
        let total = batchHeader;
        const items = commands.map(command => {
            const struct = commandStruct(command.opcode);
            const payload = command.payload instanceof Uint8Array ? command.payload : encode(struct, command.payload || {});
            const blobs = command.blobs || [];
            const size = Math.ceil((commandHeader + payload.length + blobs.reduce((n, blob) => n + blob.data.length, 0)) / 8) * 8;
            const at = total;total += size;
            return { command, struct, payload, blobs, size, at };
        });
        const bytes = new Uint8Array(total), view = new DataView(bytes.buffer);
        bytes.set(encode("BatchHeader", { magic: C.D9WG_MAGIC, version_major: C.D9WG_VERSION_MAJOR,
            version_minor: C.D9WG_VERSION_MINOR, ...header, command_count: items.length, command_bytes: total - batchHeader }));
        items.forEach(({ command, struct, payload, blobs, size, at }, index) => {
            bytes.set(encode("CommandHeader", { opcode: command.opcode, flags: command.flags || 0, size,
                sequence: command.sequence === undefined ? index + 1 : command.sequence }), at);
            const start = at + commandHeader;bytes.set(payload, start);
            let dataAt = start + payload.length;
            for (const blob of blobs) {
                const field = STRUCTS[struct]?.fields[blob.field];
                if (!field || field.type !== "uint32_t" || field.count !== 1 || field.offset + 4 > payload.length)
                    throw new Error("D9WG: invalid blob field " + struct + "." + blob.field);
                view.setUint32(start + field.offset, dataAt, true);
                bytes.set(blob.data, dataAt);dataAt += blob.data.length;
            }
        });
        return bytes;
    }

    // The shortest payload of `struct` a supported guest sends
    function minBytes(struct) {
        const added = ADDED_FIELDS[struct];
        return added ? Math.min(...added.map(name => F[struct][name])) : STRUCTS[struct].size;
    }

    // Whether a payload of `length` bytes carries `field` (one ADDED_FIELDS added)
    function has(length, struct, field) {
        const layout = STRUCTS[struct].fields[field];
        return length >= layout.offset + layout.bytes;
    }

    // The struct of an opcode's payload
    function commandStruct(opcode) {
        const entry = COMMANDS[OP_NAME[opcode]];
        return entry ? (Array.isArray(entry) ? entry[0] : entry) : null;
    }

    const api = { ITEMS, COMMANDS, C, OP, OP_NAME, STRUCTS, F, MIN_MINOR, ADDED_FIELDS, decode, encode, encodeBatch, commandStruct,
        minBytes, has,
        VERSION_MAJOR: C.D9WG_VERSION_MAJOR, VERSION_MINOR: C.D9WG_VERSION_MINOR };
    global.D9WGProtocol = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
