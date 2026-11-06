// D9WG high-level Direct3D 9 command executor -- M1 skeleton.
//
// The guest DLL (glbridge/d3d9proxy/d3d9_proxy.c) keeps COM objects, shadow
// state, Lock/Unlock memory and batching inside Windows XP. This host owns
// only WebGPU resources and immutable cache objects. D9WG has its own opcode
// numbering, resource handle namespace and payload shapes (d3d9_protocol.h);
// d3d8.dll and ddraw.dll translate onto it.
//
// M1 scope: batch decode, a resource table for vertex/index buffers, 2D
// textures and vertex declarations, WebGPU device lifecycle, and the
// fixed-function XYZ/XYZRHW draw path with no programmable shaders.
//
// M2 adds shader model 2.0: CREATE/SET_{VERTEX,PIXEL}_SHADER translated to
// WGSL by d3d9_shader_pipeline.js, the float/int/bool constant register file
// packed into a uniform buffer (plan 9.7), independent sampler state driving
// a GPUSampler cache (plan 4.4/12), and multi-stream vertex declarations.
//
// M3 finishes the fixed-function pipeline, which until then stored a great deal
// of state it never acted on: vertex lighting (SetLight/SetMaterial/
// LightEnable, computed in view space as D3D9 does), the whole D3DTOP_*
// texture-blending cascade across up to eight stages, per-stage coordinate
// selection/generation/transform, cube textures, and the scissor rect. It also
// brings render targets, depth surfaces and MRT forward from M4 -- a 2005-era
// D3D9 game renders most of its frame into textures, so without them it has no
// picture at all -- plus per-process session isolation and device-loss
// recovery, both M1 leftovers.
//
// The fixed-function and programmable paths are one path, not two. Both
// stages are always separate GPUShaderModules meeting over a fixed
// inter-stage varying contract (COLOR0/COLOR1 at locations 0-1, TEXCOORD0..7
// at 2-9, FOG at 10 -- see VARYING_* in d3d9_shader_pipeline.js), with the
// fixed-function stage synthesised into a module that obeys the same
// contract. That is what makes the mixed configurations D3D9 allows work at
// all: fixed-function T&L feeding a real pixel shader, or a vertex shader
// feeding the fixed-function texture pipeline, are both routine in games of
// this era and neither would link if each path had its own varying layout.
//
// Every other D9WG opcode already has a number reserved in d3d9_protocol.h
// for a later milestone, but the guest never emits it yet, so this executor
// does not need a handler for it -- unknown/future opcodes are skipped by
// their `size` field (see decodeCommand) rather than treated as an error,
// matching the parser-safety rule in the implementation plan's section 6.8.
//
// Protocol 1.3's batch header carries a 64-bit process session id. The
// executor switches among per-session device/resource/frame contexts at batch
// boundaries, so launchers and capability helpers may run concurrently with a
// game even though every process starts allocating the same numeric handles.

(function(global) {
    "use strict";

    const shaderPipeline = global.D3D9ShaderPipeline ||
        (typeof require === "function" ? require("./d3d9_shader_pipeline.js") : null);
    // The protocol's opcodes, constants and payload layouts (d9wg_protocol.js)
    const D9WG = global.D9WGProtocol ||
        (typeof require === "function" ? require("./d9wg_protocol.js") : null);
    const wire = global.D9WGWire ||
        (typeof require === "function" ? require("./d9wg_wire.js") : null);
    if (!wire) throw new Error("d3d9_executor.js requires d9wg_wire.js to be loaded first");
    const { D9WGStreamError } = wire;
    const OPAQUE_COLOR_FORMATS = new Set([20, 22, 23, 24, 27, 30, 33]);
    const formats = global.D9WGFormats ||
        (typeof require === "function" ? require("./d9wg_formats.js") : null);
    if (!formats) throw new Error("d3d9_executor.js requires d9wg_formats.js to be loaded first");
    const {
        D3DFMT_A8R8G8B8, D3DFMT_INDEX32, srgbSiblingOf, isCompressedFormat, compressedBlockBytes,
        blockAlignedCopyExtent, bcNeedsExpansion, expandBCBlocks, isFourCCDepthFormat, isPalettizedFormat, gpuBytesPerTexel, fullMipLevelCount, autoGenMipsSupported, autoGenDefaultFilter,
        isRenderableGPUFormat, isFloat32GPUFormat, isBlendableGPUFormat, formatToGPU, d3dBytesPerTexel,
        packGPUReadbackRow, expandRowToGPU, samplingSwizzle
    } = formats;
    const Uploads = global.D9WGUploads ||
        (typeof require === "function" ? require("./d9wg_uploads.js") : null);
    if (!Uploads) throw new Error("d3d9_executor.js requires d9wg_uploads.js to be loaded first");
    const surfaceFactory = global.D9WGSurfaceOps ||
        (typeof require === "function" ? require("./d9wg_surface_ops.js") : null);
    if (!surfaceFactory) throw new Error("d3d9_executor.js requires d9wg_surface_ops.js to be loaded first");
    const resourceFactory = global.D9WGResources ||
        (typeof require === "function" ? require("./d9wg_resources.js") : null);
    if (!resourceFactory) throw new Error("d3d9_executor.js requires d9wg_resources.js to be loaded first");
    const stateFactory = global.D9WGState ||
        (typeof require === "function" ? require("./d9wg_state.js") : null);
    if (!stateFactory) throw new Error("d3d9_executor.js requires d9wg_state.js to be loaded first");
    if (!shaderPipeline)
        throw new Error("d3d9_executor.js requires d3d9_shader_pipeline.js to " +
            "be loaded first");

    /*
     * The device and the canvas configuration belong to webgpu_host.js, not to
     * this file. A GPUCanvasContext belongs to whichever device last configured
     * it, and getCurrentTexture() then hands out a texture only that device may
     * use -- so when this executor requested its own device and configured the
     * canvas with it, the OpenGL executor's present pass got a swap-chain
     * texture from the wrong device and every frame died in validation. The
     * page loads all three backends whether or not the guest uses them, and
     * DDraw drives the desktop through this one, so the collision was the
     * normal case rather than an edge.
     */
    /*
     * Resolved when an executor is constructed, not when this file is
     * evaluated: the page's script order is not this module's to depend on,
     * and reading global.V86GPUHost at load time silently yields null when
     * webgpu_host.js happens to come later -- which reads downstream as
     * "WebGPU is unavailable" rather than as the load-order mistake it is.
     */
    function resolveGPUHost() {
        if (global.V86GPUHost) return global.V86GPUHost;
        try {
            return typeof require === "function" ?
                require("../webgpu_host.js") : null;
        } catch (error) {
            return null;
        }
    }

    const DEFAULT_SHADER_WORKER_URL = (() => {
        try {
            if (typeof document === "undefined" || !document.currentScript ||
                    !document.currentScript.src)
                return null;
            const executorURL = new URL(document.currentScript.src);
            const workerURL = new URL("d3d9_shader_worker.js", executorURL);
            workerURL.search = global.V86GL_BUILD_REVISION ?
                "?v=" + encodeURIComponent(global.V86GL_BUILD_REVISION) : executorURL.search;
            return workerURL.href;
        } catch (error) { return null; }
    })();

    const DEFAULT_DIAGNOSTICS_URL = DEFAULT_SHADER_WORKER_URL &&
        new URL("d9wg_diagnostics.js" + new URL(DEFAULT_SHADER_WORKER_URL).search,
            DEFAULT_SHADER_WORKER_URL).href;
    const DIAGNOSTIC_REPORTS = ["dumpSmallTextures","dumpShaders","dumpPipelineStates","blackScreenReport"];
    let diagnosticsLoad = null;

    const D9WG_MIN_PAYLOAD = wire.MIN_PAYLOAD;
    const D9WG_DMA_BYTES = 16 * 1024 * 1024;
    const D9WG_RESPONSE_REGION_BYTES = D9WG.C.D9WG_RESPONSE_REGION_BYTES;
    const D9WG_RESPONSE_REGION_OFFSET =
        D9WG_DMA_BYTES - D9WG_RESPONSE_REGION_BYTES;
    const D9WG_QUERY_REGION_BYTES = D9WG.C.D9WG_QUERY_REGION_BYTES;
    // Liveness counter the guest watches while it spins on a readback; see the
    // comment on D9WG_HEARTBEAT_OFFSET in d3d9_protocol.h.
    const D9WG_HEARTBEAT_BYTES = D9WG.C.D9WG_HEARTBEAT_BYTES;
    const D9WG_HEARTBEAT_OFFSET = D9WG.C.D9WG_HEARTBEAT_OFFSET;
    const D9WG_RESPONSE_OK = D9WG.C.D9WG_RESPONSE_OK;
    const D9WG_RESPONSE_FAILED = D9WG.C.D9WG_RESPONSE_FAILED;
    const D9WG_BATCH_HEADER_BYTES = D9WG.STRUCTS.BatchHeader.size;
    const D9WG_COMMAND_HEADER_BYTES = D9WG.STRUCTS.CommandHeader.size;
    const D9WG_BATCH_FLAG_PRESENT = D9WG.C.D9WG_BATCH_FLAG_PRESENT;
    const D9WG_FEATURE_SHADER_MODEL_2 = D9WG.C.D9WG_FEATURE_SHADER_MODEL_2;
    const D9WG_FEATURE_SHADER_MODEL_3 = D9WG.C.D9WG_FEATURE_SHADER_MODEL_3;

    const OP_HELLO = D9WG.OP.HELLO;
    const OP_CREATE_DEVICE = D9WG.OP.CREATE_DEVICE;
    const OP_RESET = D9WG.OP.RESET;
    const OP_PRESENT = D9WG.OP.PRESENT;
    const OP_CLEAR = D9WG.OP.CLEAR;
    const OP_BEGIN_SCENE = D9WG.OP.BEGIN_SCENE;
    const OP_END_SCENE = D9WG.OP.END_SCENE;
    const OP_CREATE_BUFFER = D9WG.OP.CREATE_BUFFER;
    const OP_UPDATE_BUFFER = D9WG.OP.UPDATE_BUFFER;
    const OP_DESTROY_RESOURCE = D9WG.OP.DESTROY_RESOURCE;
    const OP_STRETCH_RECT = D9WG.OP.STRETCH_RECT;
    const OP_COLOR_FILL = D9WG.OP.COLOR_FILL;
    const OP_GUEST_LOG = D9WG.OP.GUEST_LOG;
    const OP_READBACK_SURFACE = D9WG.OP.READBACK_SURFACE;
    const OP_SESSION_END = D9WG.OP.SESSION_END;
    const GUEST_LOG_SEVERITY_INFO = 0;
    const GUEST_LOG_SEVERITY_FAILED = 2;
    const OP_CREATE_TEXTURE_2D = D9WG.OP.CREATE_TEXTURE_2D;
    const OP_CREATE_TEXTURE_CUBE = D9WG.OP.CREATE_TEXTURE_CUBE;
    const OP_CREATE_TEXTURE_VOLUME = D9WG.OP.CREATE_TEXTURE_VOLUME;
    const OP_UPDATE_TEXTURE = D9WG.OP.UPDATE_TEXTURE;
    const OP_SET_SCISSOR_RECT = D9WG.OP.SET_SCISSOR_RECT;
    const OP_SET_RENDER_TARGET = D9WG.OP.SET_RENDER_TARGET;
    const OP_SET_DEPTH_STENCIL_SURFACE_LEVEL = D9WG.OP.SET_DEPTH_STENCIL_SURFACE_LEVEL;
    const OP_SET_PALETTE = D9WG.OP.SET_PALETTE;
    const OP_SET_CURRENT_TEXTURE_PALETTE = D9WG.OP.SET_CURRENT_TEXTURE_PALETTE;
    const OP_GENERATE_MIPS = D9WG.OP.GENERATE_MIPS;
    const OP_SET_TEXTURE_LOD = D9WG.OP.SET_TEXTURE_LOD;
    const OP_SET_GAMMA_RAMP = D9WG.OP.SET_GAMMA_RAMP;
    const OP_CREATE_SWAP_CHAIN = D9WG.OP.CREATE_SWAP_CHAIN;
    const OP_DESTROY_SWAP_CHAIN = D9WG.OP.DESTROY_SWAP_CHAIN;
    const OP_PRESENT_SWAP_CHAIN = D9WG.OP.PRESENT_SWAP_CHAIN;
    // D9WGSetDepthStencilSurface.depth_texture_handle sentinel: the device's own
    // auto depth-stencil surface. It needs a value distinct from 0 because
    // SetDepthStencilSurface(NULL) -- which really does turn depth testing off
    // -- also has no texture handle, and an app that renders to a texture and
    // then restores the back buffer's depth surface must be able to say which
    // of the two it means.
    const D9WG_AUTO_DEPTH_STENCIL_HANDLE = D9WG.C.D9WG_AUTO_DEPTH_STENCIL_HANDLE;
    const OP_CREATE_VERTEX_DECLARATION = D9WG.OP.CREATE_VERTEX_DECLARATION;
    const OP_CREATE_VERTEX_SHADER = D9WG.OP.CREATE_VERTEX_SHADER;
    const OP_CREATE_PIXEL_SHADER = D9WG.OP.CREATE_PIXEL_SHADER;
    const OP_CREATE_QUERY = D9WG.OP.CREATE_QUERY;
    const OP_SET_RENDER_STATE = D9WG.OP.SET_RENDER_STATE;
    const OP_SET_SAMPLER_STATE = D9WG.OP.SET_SAMPLER_STATE;
    const OP_SET_TEXTURE_STAGE_STATE = D9WG.OP.SET_TEXTURE_STAGE_STATE;
    const OP_SET_TEXTURE = D9WG.OP.SET_TEXTURE;
    const OP_SET_VIEWPORT = D9WG.OP.SET_VIEWPORT;
    const OP_SET_TRANSFORM = D9WG.OP.SET_TRANSFORM;
    const OP_SET_MATERIAL = D9WG.OP.SET_MATERIAL;
    const OP_SET_LIGHT = D9WG.OP.SET_LIGHT;
    const OP_LIGHT_ENABLE = D9WG.OP.LIGHT_ENABLE;
    const OP_SET_STREAM_SOURCE = D9WG.OP.SET_STREAM_SOURCE;
    const OP_SET_STREAM_SOURCE_FREQ = D9WG.OP.SET_STREAM_SOURCE_FREQ;
    const OP_SET_INDICES = D9WG.OP.SET_INDICES;
    const OP_SET_VERTEX_DECLARATION = D9WG.OP.SET_VERTEX_DECLARATION;
    const OP_SET_FVF = D9WG.OP.SET_FVF;
    const OP_SET_CURSOR_PROPERTIES = D9WG.OP.SET_CURSOR_PROPERTIES;
    const OP_SET_CURSOR_POSITION = D9WG.OP.SET_CURSOR_POSITION;
    const OP_SHOW_CURSOR = D9WG.OP.SHOW_CURSOR;
    const OP_WINDOW_STATE = D9WG.OP.WINDOW_STATE;
    const D9WG_WINDOW_IS_WINDOW = D9WG.C.D9WG_WINDOW_IS_WINDOW;
    const D9WG_WINDOW_VISIBLE = D9WG.C.D9WG_WINDOW_VISIBLE;
    const D9WG_WINDOW_ICONIC = D9WG.C.D9WG_WINDOW_ICONIC;
    const D9WG_WINDOW_FOREGROUND = D9WG.C.D9WG_WINDOW_FOREGROUND;
    const D9WG_WINDOW_FULLSCREEN = D9WG.C.D9WG_WINDOW_FULLSCREEN;
    const D9WG_WINDOW_NO_SURFACE = D9WG.C.D9WG_WINDOW_NO_SURFACE;
    // Other windows cover all of it (d3d9_protocol.h): hidden as far as the
    // picture goes, though the window is up
    const D9WG_WINDOW_OCCLUDED = D9WG.C.D9WG_WINDOW_OCCLUDED;
    // Other windows cover part of it: the parts that show follow the record
    // (D9WGWindowRegion in d3d9_protocol.h)
    const D9WG_WINDOW_REGION = D9WG.C.D9WG_WINDOW_REGION;
    const D9WG_WINDOW_STATE_BYTES = D9WG.STRUCTS.WindowState.size;
    const D9WG_WINDOW_REGION_MAX_RECTS = D9WG.C.D9WG_WINDOW_REGION_MAX_RECTS;
    const OP_SET_VERTEX_SHADER = D9WG.OP.SET_VERTEX_SHADER;
    const OP_SET_PIXEL_SHADER = D9WG.OP.SET_PIXEL_SHADER;
    const OP_SET_VERTEX_SHADER_CONSTANT_F = D9WG.OP.SET_VERTEX_SHADER_CONSTANT_F;
    const OP_SET_VERTEX_SHADER_CONSTANT_I = D9WG.OP.SET_VERTEX_SHADER_CONSTANT_I;
    const OP_SET_VERTEX_SHADER_CONSTANT_B = D9WG.OP.SET_VERTEX_SHADER_CONSTANT_B;
    const OP_SET_PIXEL_SHADER_CONSTANT_F = D9WG.OP.SET_PIXEL_SHADER_CONSTANT_F;
    const OP_SET_PIXEL_SHADER_CONSTANT_I = D9WG.OP.SET_PIXEL_SHADER_CONSTANT_I;
    const OP_SET_PIXEL_SHADER_CONSTANT_B = D9WG.OP.SET_PIXEL_SHADER_CONSTANT_B;
    const OP_SET_CLIP_PLANE = D9WG.OP.SET_CLIP_PLANE;
    const OP_DRAW_PRIMITIVE = D9WG.OP.DRAW_PRIMITIVE;
    const OP_DRAW_INDEXED_PRIMITIVE = D9WG.OP.DRAW_INDEXED_PRIMITIVE;
    const OP_DRAW_PRIMITIVE_UP = D9WG.OP.DRAW_PRIMITIVE_UP;

    const D3DSTREAMSOURCE_INDEXEDDATA = 0x40000000;
    const D3DSTREAMSOURCE_INSTANCEDATA = 0x80000000;
    const D3DSTREAMSOURCE_FREQUENCY_MASK = 0x3fffffff;
    const OP_DRAW_INDEXED_PRIMITIVE_UP = D9WG.OP.DRAW_INDEXED_PRIMITIVE_UP;
    const OP_BEGIN_QUERY = D9WG.OP.BEGIN_QUERY;
    const OP_END_QUERY = D9WG.OP.END_QUERY;

    const RESOURCE_BUFFER_VERTEX = 1;
    const RESOURCE_BUFFER_INDEX = 2;
    const RESOURCE_TEXTURE_2D = 3;
    const RESOURCE_TEXTURE_CUBE = 4;
    const RESOURCE_TEXTURE_VOLUME = 5;
    const RESOURCE_VERTEX_DECLARATION = 6;
    const RESOURCE_VERTEX_SHADER = 7;
    const RESOURCE_PIXEL_SHADER = 8;
    const RESOURCE_QUERY = 9;

    const D3DQUERYTYPE_EVENT = 8;
    const D3DQUERYTYPE_OCCLUSION = 9;
    const D3DQUERYTYPE_TIMESTAMP = 10;
    const D3DQUERYTYPE_TIMESTAMPDISJOINT = 11;
    const D3DQUERYTYPE_TIMESTAMPFREQ = 12;

    // Constant register file sizes, matching D9_MAX_* in d3d9_proxy.c.
    const MAX_VS_CONST_F = 256;
    const MAX_PS_CONST_F = 224;
    const MAX_CONST_I = 16;
    const MAX_CONST_B = 16;
    const MAX_SAMPLERS = 16;
    // fill_caps() reports MaxStreams = 16, D3D9's architectural maximum, and
    // the guest keeps 16 binding slots. This is the different, WebGPU-imposed
    // number: how many vertex buffers one *draw* may bind. WebGPU guarantees
    // maxVertexBuffers >= 8 on every implementation, and a layout is built only
    // for the streams a declaration actually references, so the two limits meet
    // only for a declaration that spreads its attributes over more than eight
    // streams -- which is refused and counted rather than silently truncated.
    const MAX_STREAMS = 16;
    const MAX_VERTEX_BUFFERS_PER_DRAW = 8;
    // The pseudo-stream of a layout whose attributes read defaultAttributeBuffer()
    const DEFAULT_ATTRIBUTE_STREAM = -1;
    // fill_caps() reports NumSimultaneousRTs = 4.
    const MAX_RENDER_TARGETS = 4;
    // WebGPU's minUniformBufferOffsetAlignment default. The vertex and pixel
    // constant regions share one buffer, so the pixel region starts here.
    const UNIFORM_OFFSET_ALIGNMENT = 256;
    // Shared so an offset-less bind group does not allocate an array per draw.
    const EMPTY_OFFSETS = Object.freeze([]);
    // M6 keeps per-draw constants in one persistent buffer. 16 MiB covers
    // tens of thousands of ordinary UI/particle draws while remaining small
    // compared with the texture working set of the target games. A frame that
    // exceeds it falls back to a retired one-off buffer rather than wrapping
    // over constants that have already been recorded.
    const UNIFORM_RING_BYTES = 16 * 1024 * 1024;

    const D3DUSAGE_RENDERTARGET = 0x1;
    const D3DUSAGE_DEPTHSTENCIL = 0x2;
    const D3DUSAGE_AUTOGENMIPMAP = 0x400;
    // Protocol 1.7, and not a D3DUSAGE bit -- see D9WG_USAGE_DDRAW_INDEXED in
    // d3d9_protocol.h. A P8 texture carrying it is stored as r8uint indices
    // resolved through a palette, rather than expanded to RGBA on the CPU,
    // because DirectDraw blits P8 into P8 and a later palette change must
    // still change those pixels' colour.
    const D9WG_USAGE_DDRAW_INDEXED = D9WG.C.D9WG_USAGE_DDRAW_INDEXED;
    const D3DMULTISAMPLE_NONE = 0;
    const D3DMULTISAMPLE_4_SAMPLES = 4;

    // The protocol carries D3DMULTISAMPLE_TYPE verbatim.  WebGPU only accepts
    // literal sample counts, and its portable guaranteed multisample count is
    // four.  Quality levels are implementation-specific in D3D9 but do not
    // exist in WebGPU, so the guest advertises exactly quality level zero.
    function sampleCountForD3D(type, quality) {
        if ((quality >>> 0) !== 0) return 0;
        if ((type >>> 0) === D3DMULTISAMPLE_NONE) return 1;
        if ((type >>> 0) === D3DMULTISAMPLE_4_SAMPLES) return 4;
        return 0;
    }

    const D3DCLEAR_TARGET = 0x1;
    const D3DCLEAR_ZBUFFER = 0x2;
    const D3DCLEAR_STENCIL = 0x4;

    // D3DRENDERSTATETYPE values the M1 fixed-function pipeline now honours.
    // Everything else the guest sends is still recorded in the device's
    // renderStates map but has no effect yet.
    const D3DRS_ZENABLE = 7;
    const D3DRS_ZWRITEENABLE = 14;
    const D3DRS_ALPHATESTENABLE = 15;
    const D3DRS_ALPHAREF = 24;
    const D3DRS_ALPHAFUNC = 25;
    const D3DRS_SRCBLEND = 19;
    const D3DRS_DESTBLEND = 20;
    const D3DRS_CULLMODE = 22;
    const D3DRS_ZFUNC = 23;
    const D3DRS_ALPHABLENDENABLE = 27;
    const D3DRS_STENCILENABLE = 52;
    const D3DRS_STENCILFAIL = 53;
    const D3DRS_STENCILZFAIL = 54;
    const D3DRS_STENCILPASS = 55;
    const D3DRS_STENCILFUNC = 56;
    const D3DRS_STENCILREF = 57;
    const D3DRS_STENCILMASK = 58;
    const D3DRS_STENCILWRITEMASK = 59;
    const D3DRS_COLORWRITEENABLE = 168;
    const D3DRS_SLOPESCALEDEPTHBIAS = 175;
    const D3DRS_SCISSORTESTENABLE = 174;
    const D3DRS_TWOSIDEDSTENCILMODE = 185;
    const D3DRS_CCW_STENCILFAIL = 186;
    const D3DRS_CCW_STENCILZFAIL = 187;
    const D3DRS_CCW_STENCILPASS = 188;
    const D3DRS_CCW_STENCILFUNC = 189;
    const D3DRS_SRGBWRITEENABLE = 194;
    const D3DRS_COLORWRITEENABLE1 = 190;
    const D3DRS_COLORWRITEENABLE2 = 191;
    const D3DRS_COLORWRITEENABLE3 = 192;
    const D3DRS_BLENDOP = 171;
    const D3DRS_BLENDFACTOR = 193;
    const D3DRS_DEPTHBIAS = 195;
    const D3DRS_SEPARATEALPHABLENDENABLE = 206;
    const D3DRS_SRCBLENDALPHA = 207;
    const D3DRS_DESTBLENDALPHA = 208;
    const D3DRS_BLENDOPALPHA = 209;
    // Fixed-function fog. fill_caps() in d3d9_proxy.c advertises
    // D3DPRASTERCAPS_FOGVERTEX/FOGTABLE/WFOG, so a game is entitled to expect
    // these to work; ignoring them left Warcraft III's fogged scenery drawn at
    // full texture colour with none of the atmospheric tint.
    const D3DRS_FOGENABLE = 28;
    const D3DRS_FOGCOLOR = 34;
    const D3DRS_FOGTABLEMODE = 35;
    const D3DRS_FOGSTART = 36;
    const D3DRS_FOGEND = 37;
    const D3DRS_FOGDENSITY = 38;
    // Direct3D 7-only texture colour-key states.  The D3D7 guest deliberately
    // sends their legacy numeric ids through SET_RENDER_STATE; D3D9 leaves
    // both holes unused, so they cannot collide with native D3D9 state.
    const D3DRS_COLORKEYENABLE = 41;
    const D3DRS_FOGVERTEXMODE = 140;
    const D3DRS_COLORKEYBLENDENABLE = 144;
    const D3DRS_RANGEFOGENABLE = 48;
    const D3DRS_LIGHTING = 137;
    const D3DRS_AMBIENT = 139;
    // D3DFOGMODE
    const D3DFOG_NONE = 0, D3DFOG_EXP = 1, D3DFOG_EXP2 = 2, D3DFOG_LINEAR = 3;

    // Fixed-function lighting and the texture-blending cascade (M3). The guest
    // has emitted all of these since M1 -- SetMaterial/SetLight/LightEnable and
    // every texture stage state -- and the host recorded them without acting on
    // any, which is why a lit scene came out flat white and every stage past 0
    // was ignored. fill_caps() in d3d9_proxy.c has meanwhile been advertising
    // MaxTextureBlendStages = 8, D3DVTXPCAPS_DIRECTIONALLIGHTS/POSITIONALLIGHTS
    // and a large TextureOpCaps set, so those were caps promises the renderer
    // did not keep; this section is what makes them true.
    const D3DRS_FILLMODE = 8;
    // D3DRS_WRAP0..7 are contiguous at 128..135; WRAP8..15 live at 198..205.
    const D3DRS_WRAP0 = 128, D3DRS_WRAP7 = 135;
    const D3DRS_MULTISAMPLEANTIALIAS = 161;
    // Alpha-to-coverage, which every D3D9 vendor exposed by smuggling a FOURCC
    // through a render state that meant something else -- there was no
    // D3DRS_ALPHATOCOVERAGE to set. ATI wrote 'ATOC' into ADAPTIVETESS_Y;
    // NVIDIA used the same slot with 'ATOC' too (its 'SSAA' spelling asked for
    // supersampling instead, which is not this). Foliage and chain-link fences
    // are what it exists for: alpha-tested edges that alias horribly without it.
    //
    // WebGPU has it natively as multisample.alphaToCoverageEnabled, so unlike
    // most of this family it is an exact mapping rather than a hack.
    const D3DRS_ADAPTIVETESS_Y = 181;
    const D3DFOURCC_ATOC = 0x434F5441; // 'ATOC'
    const D3DRS_MULTISAMPLEMASK = 162;
    const D3DFILL_POINT = 1, D3DFILL_WIREFRAME = 2, D3DFILL_SOLID = 3;
    const D3DRS_SHADEMODE = 9;
    const D3DRS_SPECULARENABLE = 29;
    const D3DRS_TEXTUREFACTOR = 60;
    const D3DRS_COLORVERTEX = 141;
    const D3DRS_LOCALVIEWER = 142;
    const D3DRS_NORMALIZENORMALS = 143;
    const D3DRS_DIFFUSEMATERIALSOURCE = 145;
    const D3DRS_SPECULARMATERIALSOURCE = 146;
    const D3DRS_AMBIENTMATERIALSOURCE = 147;
    const D3DRS_EMISSIVEMATERIALSOURCE = 148;
    // Point primitives/point sprites. WebGPU only exposes one-pixel points,
    // so M6 expands every D3D point to a six-vertex quad in the vertex stage.
    const D3DRS_POINTSIZE = 154;
    const D3DRS_POINTSIZE_MIN = 155;
    const D3DRS_POINTSPRITEENABLE = 156;
    const D3DRS_POINTSCALEENABLE = 157;
    const D3DRS_POINTSCALE_A = 158;
    const D3DRS_POINTSCALE_B = 159;
    const D3DRS_POINTSCALE_C = 160;
    const D3DRS_POINTSIZE_MAX = 166;

    // Fixed-function vertex blending. D3DRS_VERTEXBLEND says how many world
    // matrices pose each vertex; D3DRS_INDEXEDVERTEXBLENDENABLE says whether
    // BLENDINDICES picks them out of the world-matrix palette instead of
    // taking them in order from D3DTS_WORLDMATRIX(0).
    const D3DRS_VERTEXBLEND = 151;
    const D3DRS_CLIPPLANEENABLE = 152;
    const D3DRS_INDEXEDVERTEXBLENDENABLE = 167;
    // D3DVERTEXBLENDFLAGS. The 1/2/3WEIGHTS names count *weights*, and the
    // matrix count is one higher: the last matrix's weight is whatever the
    // others leave over, 1 - sum(the rest). 0WEIGHTS is the indexed-only case
    // of one matrix per vertex chosen by BLENDINDICES.x with weight 1.
    const D3DVBF_DISABLE = 0;
    const D3DVBF_TWEENING = 255;
    const D3DRS_TWEENFACTOR = 170;
    const D3DVBF_0WEIGHTS = 256;
    // D3D9's fixed function blends at most four matrices per vertex, which is
    // what fill_caps() reports as MaxVertexBlendMatrices.
    const MAX_BLEND_MATRICES = 4;

    // D3DLIGHTTYPE
    const D3DLIGHT_POINT = 1, D3DLIGHT_SPOT = 2, D3DLIGHT_DIRECTIONAL = 3, D3DLIGHT_PARALLELPOINT = 4;
    // D3DMATERIALCOLORSOURCE
    const D3DMCS_MATERIAL = 0, D3DMCS_COLOR1 = 1, D3DMCS_COLOR2 = 2;
    // fill_caps() reports MaxActiveLights = 8.
    const MAX_LIGHTS = 8;

    // D3DTEXTURESTAGESTATETYPE
    const D3DTSS_COLOROP = 1, D3DTSS_COLORARG1 = 2, D3DTSS_COLORARG2 = 3;
    const D3DTSS_ALPHAOP = 4, D3DTSS_ALPHAARG1 = 5, D3DTSS_ALPHAARG2 = 6;
    const D3DTSS_TEXCOORDINDEX = 11;
    // The 2x2 matrix D3DTOP_BUMPENVMAP applies to the (du, dv) it samples,
    // and the luminance scale/offset BUMPENVMAPLUMINANCE adds on top. All six
    // are D3DTSS values holding raw float bits.
    const D3DTSS_BUMPENVMAT00 = 7, D3DTSS_BUMPENVMAT01 = 8;
    const D3DTSS_BUMPENVMAT10 = 9, D3DTSS_BUMPENVMAT11 = 10;
    const D3DTSS_BUMPENVLSCALE = 22, D3DTSS_BUMPENVLOFFSET = 23;
    const D3DTSS_TEXTURETRANSFORMFLAGS = 24;
    const D3DTSS_COLORARG0 = 26, D3DTSS_ALPHAARG0 = 27, D3DTSS_RESULTARG = 28;
    const D3DTSS_CONSTANT = 32;

    // D3DTEXTUREOP. Only the operations fill_caps() advertises in TextureOpCaps
    // are implemented below; a stage asking for one that is absent is counted
    // rather than approximated (an approximated blend renders as
    // wrong-but-plausible shading, which is the failure mode hardest to
    // attribute). D3DTOP_PREMODULATE is the one remaining hole: it modulates
    // this stage's result with the *next* stage's texture, and nothing in the
    // cascade carries a value backwards.
    const D3DTOP_DISABLE = 1, D3DTOP_SELECTARG1 = 2, D3DTOP_SELECTARG2 = 3;
    const D3DTOP_MODULATE = 4, D3DTOP_MODULATE2X = 5, D3DTOP_MODULATE4X = 6;
    const D3DTOP_ADD = 7, D3DTOP_ADDSIGNED = 8, D3DTOP_ADDSIGNED2X = 9;
    const D3DTOP_SUBTRACT = 10, D3DTOP_ADDSMOOTH = 11;
    const D3DTOP_BLENDDIFFUSEALPHA = 12, D3DTOP_BLENDTEXTUREALPHA = 13;
    const D3DTOP_BLENDFACTORALPHA = 14, D3DTOP_BLENDTEXTUREALPHAPM = 15;
    const D3DTOP_BLENDCURRENTALPHA = 16;
    const D3DTOP_PREMODULATE = 17;
    // The four "modulate one channel set, add the other" operations. D3D9
    // documents all four as valid for D3DTSS_COLOROP only -- each one mixes
    // arg1's colour with arg1's *alpha*, which has no scalar analogue -- so the
    // alpha form below returns null and is counted like any other refusal.
    const D3DTOP_MODULATEALPHA_ADDCOLOR = 18;
    const D3DTOP_MODULATECOLOR_ADDALPHA = 19;
    const D3DTOP_MODULATEINVALPHA_ADDCOLOR = 20;
    const D3DTOP_MODULATEINVCOLOR_ADDALPHA = 21;
    const D3DTOP_BUMPENVMAP = 22, D3DTOP_BUMPENVMAPLUMINANCE = 23;
    const D3DTOP_DOTPRODUCT3 = 24, D3DTOP_MULTIPLYADD = 25, D3DTOP_LERP = 26;

    // D3DTA_* argument selectors and their two modifier bits.
    const D3DTA_SELECTMASK = 0x0000000f;
    const D3DTA_COMPLEMENT = 0x00000010;
    const D3DTA_ALPHAREPLICATE = 0x00000020;
    const D3DTA_DIFFUSE = 0, D3DTA_CURRENT = 1, D3DTA_TEXTURE = 2;
    const D3DTA_TFACTOR = 3, D3DTA_SPECULAR = 4, D3DTA_TEMP = 5;
    const D3DTA_CONSTANT = 6;

    // D3DTSS_TEXCOORDINDEX's high bits: automatic coordinate generation.
    const D3DTSS_TCI_MASK = 0xffff0000;
    const D3DTSS_TCI_PASSTHRU = 0x00000000;
    const D3DTSS_TCI_CAMERASPACENORMAL = 0x00010000;
    const D3DTSS_TCI_CAMERASPACEPOSITION = 0x00020000;
    const D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR = 0x00030000;
    const D3DTSS_TCI_SPHEREMAP = 0x00040000;

    // D3DTSS_TEXTURETRANSFORMFLAGS
    const D3DTTFF_PROJECTED = 0x100;

    // D3DTSS_RESULTARG picks where a stage writes: the cascade register
    // (D3DTA_CURRENT) or the scratch register (D3DTA_TEMP), which a later stage
    // can read back as an argument.
    const MAX_TEXTURE_STAGES = 8;
    // TEXCOORD0..7 are the only coordinate sets D3D9 has, so this bounds both
    // the vertex attributes and the varyings the cascade can reference.
    const MAX_TEXCOORD_SETS = 8;

    const D3DZB_FALSE = 0;
    const D3DCULL_NONE = 1;
    const D3DCULL_CW = 2;
    const D3DCULL_CCW = 3;

    // D3DCMPFUNC -> GPUCompareFunction
    const COMPARE_FUNCS = [
        undefined, "never", "less", "equal", "less-equal",
        "greater", "not-equal", "greater-equal", "always",
    ];

    // D3DBLEND -> GPUBlendFactor. The BOTH* values are resolved as a source /
    // destination pair in pipelineStateFor(); BLENDFACTOR maps to WebGPU's
    // dynamic blend constant and is installed before each draw.
    const BLEND_FACTORS = [
        undefined,
        "zero",                 // D3DBLEND_ZERO = 1
        "one",                  // D3DBLEND_ONE
        "src",                  // D3DBLEND_SRCCOLOR
        "one-minus-src",        // D3DBLEND_INVSRCCOLOR
        "src-alpha",            // D3DBLEND_SRCALPHA
        "one-minus-src-alpha",  // D3DBLEND_INVSRCALPHA
        "dst-alpha",            // D3DBLEND_DESTALPHA
        "one-minus-dst-alpha",  // D3DBLEND_INVDESTALPHA
        "dst",                  // D3DBLEND_DESTCOLOR
        "one-minus-dst",        // D3DBLEND_INVDESTCOLOR
        "src-alpha-saturated",  // D3DBLEND_SRCALPHASAT
        undefined,              // D3DBLEND_BOTHSRCALPHA (pair alias)
        undefined,              // D3DBLEND_BOTHINVSRCALPHA (pair alias)
        "constant",             // D3DBLEND_BLENDFACTOR
        "one-minus-constant",   // D3DBLEND_INVBLENDFACTOR
    ];

    // D3DBLENDOP -> GPUBlendOperation
    const BLEND_OPS = [
        undefined, "add", "subtract", "reverse-subtract", "min", "max",
    ];

    // D3DSTENCILOP -> GPUStencilOperation.
    const STENCIL_OPS = [
        undefined, "keep", "zero", "replace", "increment-clamp",
        "decrement-clamp", "invert", "increment-wrap", "decrement-wrap",
    ];

    // WebGPU's depth format for the auto depth-stencil surface. D3D9 apps ask
    // for D16/D24S8/D24X8/etc; all of them are satisfied with one real
    // depth24plus-stencil8 target rather than trying to match bit layouts the
    // guest can never observe (it cannot read the depth buffer back in M1).
    const DEPTH_FORMAT = "depth24plus-stencil8";
    const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

    // D3DDECLUSAGE / D3DDECLTYPE, the subset d3d9_proxy.c's
    // declaration_element_supported() lets through.
    const DECLUSAGE_POSITION = 0;
    const DECLUSAGE_BLENDWEIGHT = 1;
    const DECLUSAGE_BLENDINDICES = 2;
    const DECLUSAGE_NORMAL = 3;
    const DECLUSAGE_PSIZE = 4;
    const DECLUSAGE_TEXCOORD = 5;
    const DECLUSAGE_POSITIONT = 9;
    const DECLUSAGE_COLOR = 10;
    const DECLTYPE_FLOAT1 = 0;
    const DECLTYPE_FLOAT2 = 1;
    const DECLTYPE_FLOAT3 = 2;
    const DECLTYPE_FLOAT4 = 3;
    const DECLTYPE_D3DCOLOR = 4;

    // D3DDECLTYPE -> [GPUVertexFormat, byte size]. D3DCOLOR is read as raw
    // little-endian BGRA bytes by unorm8x4, so anything consuming it has to
    // swizzle; both shader generators below do that at the point where the
    // attribute is copied into its register, never with a CPU pass over the
    // vertex data.
    const DECLTYPE_FORMATS = {
        [DECLTYPE_FLOAT1]: ["float32", 4],
        [DECLTYPE_FLOAT2]: ["float32x2", 8],
        [DECLTYPE_FLOAT3]: ["float32x3", 12],
        [DECLTYPE_FLOAT4]: ["float32x4", 16],
        [DECLTYPE_D3DCOLOR]: ["unorm8x4", 4],
        5: ["uint8x4", 4],     // D3DDECLTYPE_UBYTE4
        6: ["sint16x2", 4],    // D3DDECLTYPE_SHORT2
        7: ["sint16x4", 8],    // D3DDECLTYPE_SHORT4
        8: ["unorm8x4", 4],    // D3DDECLTYPE_UBYTE4N
        9: ["snorm16x2", 4],   // D3DDECLTYPE_SHORT2N
        10: ["snorm16x4", 8],  // D3DDECLTYPE_SHORT4N
        11: ["unorm16x2", 4],  // D3DDECLTYPE_USHORT2N
        12: ["unorm16x4", 8],  // D3DDECLTYPE_USHORT4N
        13: ["uint32", 4],     // D3DDECLTYPE_UDEC3 (unpacked in WGSL)
        14: ["uint32", 4],     // D3DDECLTYPE_DEC3N (unpacked in WGSL)
        15: ["float16x2", 4],  // D3DDECLTYPE_FLOAT16_2
        16: ["float16x4", 8],  // D3DDECLTYPE_FLOAT16_4
    };

    // D3DSAMPLERSTATETYPE, and the enums its values come from.
    const D3DSAMP_ADDRESSU = 1;
    const D3DSAMP_ADDRESSV = 2;
    const D3DSAMP_ADDRESSW = 3;
    const D3DSAMP_BORDERCOLOR = 4;
    const D3DSAMP_MAGFILTER = 5;
    const D3DSAMP_MINFILTER = 6;
    const D3DSAMP_MIPFILTER = 7;
    // Float bits in a DWORD. WebGPU samplers carry no LOD bias, so this one is
    // applied at the sample call instead -- see lodBiasFor().
    const D3DSAMP_MIPMAPLODBIAS = 8;
    // The floor on which mip level may be sampled, as a level index. WebGPU
    // spells the same restriction as a LOD clamp, so both this and the
    // per-texture SetLOD become lodMinClamp -- see samplerFor().
    const D3DSAMP_MAXMIPLEVEL = 9;
    const D3DSAMP_MAXANISOTROPY = 10;
    // D3D9 decodes an sRGB-tagged texture to linear *on read*. WebGPU has no
    // sampler-level equivalent -- it is a property of the texture format -- so
    // this is honoured by sampling through an "-srgb" view of the same texture
    // rather than by anything in the sampler.
    const D3DSAMP_SRGBTEXTURE = 11;

    // D3DTEXTUREADDRESS -> GPUAddressMode. WebGPU has no BORDER mode and no
    // MIRRORONCE; both fall back to clamp-to-edge, which is the closest
    // available behaviour and is noted once per occurrence rather than
    // silently substituted.
    const ADDRESS_MODES = [
        undefined, "repeat", "mirror-repeat", "clamp-to-edge",
        "clamp-to-edge", "clamp-to-edge",
    ];
    // D3DTEXTUREFILTERTYPE -> GPUFilterMode. ANISOTROPIC becomes linear plus
    // a maxAnisotropy value; PYRAMIDALQUAD/GAUSSIANQUAD have no equivalent.
    const FILTER_MODES = [
        "nearest", "nearest", "linear", "linear",
        "linear", "linear", "linear",
    ];

    // Which states the renderer actually consumes. Kept next to the constants
    // rather than derived from them, because "we read this" is a statement about
    // the code below, not about the enum.
    const CONSUMED_SAMPLER_STATES = new Set([
        D3DSAMP_ADDRESSU, D3DSAMP_ADDRESSV, D3DSAMP_ADDRESSW,
        D3DSAMP_BORDERCOLOR,
        D3DSAMP_MAGFILTER, D3DSAMP_MINFILTER, D3DSAMP_MIPFILTER,
        D3DSAMP_MAXANISOTROPY, D3DSAMP_SRGBTEXTURE,
    ]);

    const CONSUMED_RENDER_STATES = new Set([
        D3DRS_ZENABLE, D3DRS_ZWRITEENABLE, D3DRS_ALPHATESTENABLE, D3DRS_ALPHAREF,
        D3DRS_ALPHAFUNC, D3DRS_SRCBLEND, D3DRS_DESTBLEND, D3DRS_CULLMODE,
        D3DRS_ZFUNC, D3DRS_ALPHABLENDENABLE, D3DRS_COLORWRITEENABLE,
        D3DRS_COLORWRITEENABLE1, D3DRS_COLORWRITEENABLE2, D3DRS_COLORWRITEENABLE3,
        D3DRS_BLENDOP, D3DRS_BLENDFACTOR, D3DRS_SEPARATEALPHABLENDENABLE,
        D3DRS_SRCBLENDALPHA, D3DRS_DESTBLENDALPHA, D3DRS_BLENDOPALPHA,
        D3DRS_STENCILENABLE, D3DRS_STENCILFAIL, D3DRS_STENCILZFAIL,
        D3DRS_STENCILPASS, D3DRS_STENCILFUNC, D3DRS_STENCILREF,
        D3DRS_STENCILMASK, D3DRS_STENCILWRITEMASK,
        D3DRS_TWOSIDEDSTENCILMODE, D3DRS_CCW_STENCILFAIL,
        D3DRS_CCW_STENCILZFAIL, D3DRS_CCW_STENCILPASS,
        D3DRS_CCW_STENCILFUNC, D3DRS_DEPTHBIAS, D3DRS_SLOPESCALEDEPTHBIAS,
        D3DRS_FOGENABLE, D3DRS_FOGCOLOR, D3DRS_FOGTABLEMODE,
        D3DRS_FOGSTART, D3DRS_FOGEND, D3DRS_FOGDENSITY, D3DRS_FOGVERTEXMODE,
        D3DRS_COLORKEYENABLE, D3DRS_COLORKEYBLENDENABLE,
        D3DRS_RANGEFOGENABLE, D3DRS_LIGHTING, D3DRS_AMBIENT,
        D3DRS_SPECULARENABLE, D3DRS_TEXTUREFACTOR, D3DRS_COLORVERTEX,
        D3DRS_LOCALVIEWER, D3DRS_NORMALIZENORMALS, D3DRS_DIFFUSEMATERIALSOURCE,
        D3DRS_SPECULARMATERIALSOURCE, D3DRS_AMBIENTMATERIALSOURCE,
        D3DRS_EMISSIVEMATERIALSOURCE, D3DRS_SCISSORTESTENABLE,
        D3DRS_SRGBWRITEENABLE, D3DRS_POINTSIZE, D3DRS_POINTSIZE_MIN,
        D3DRS_POINTSPRITEENABLE, D3DRS_POINTSCALEENABLE,
        D3DRS_POINTSCALE_A, D3DRS_POINTSCALE_B, D3DRS_POINTSCALE_C,
        D3DRS_POINTSIZE_MAX, D3DRS_VERTEXBLEND,
        D3DRS_INDEXEDVERTEXBLENDENABLE, D3DRS_CLIPPLANEENABLE,
    ]);

    const D3DTS_VIEW = 2;
    const D3DTS_PROJECTION = 3;
    const D3DTS_WORLD = 256;
    // D3DTS_WORLDMATRIX(n) is D3DTS_WORLD + n, and indexed vertex blending can
    // address all 256 of them. The palette actually uploaded per draw is sized
    // from what the guest has set (see maxWorldMatrixIndex), not from this.
    const MAX_WORLD_MATRICES = 256;
    const D3DTS_TEXTURE0 = 16;

    // How many world matrices an indexed blend uploads. Sizing this to exactly
    // the highest index the guest has set would put the count in the shader
    // cache key and mint a fresh module and pipeline every time an engine adds
    // a bone, so it is rounded up through a handful of buckets instead: the
    // key changes a few times per session rather than a few times per frame.
    // The cost of the slack is upload bandwidth on blended draws only.
    function blendPaletteSize(highestIndexSet) {
        const needed = Math.max(1, Math.min(MAX_WORLD_MATRICES,
            (highestIndexSet | 0) + 1));
        let size = 4;
        while (size < needed) size *= 2;
        return size;
    }

    // D3DPRIMITIVETYPE -> WebGPU topology, and element-count helpers mirror
    // d3d9_proxy.c's primitive_element_count() so guest/host agree on how
    // many vertices/indices a given primitive_count consumes. Only list/strip
    // forms map onto a single WebGPU draw call directly; FAN is converted to
    // a triangle list index buffer on upload, same discipline as the D3D8
    // path.
    const D3DPT_POINTLIST = 1;
    const D3DPT_LINELIST = 2;
    const D3DPT_LINESTRIP = 3;
    const D3DPT_TRIANGLELIST = 4;
    const D3DPT_TRIANGLESTRIP = 5;
    const D3DPT_TRIANGLEFAN = 6;

    const BUFFER_USAGE_VERTEX = 0x20;
    const BUFFER_USAGE_INDEX = 0x10;
    const BUFFER_USAGE_UNIFORM = 0x40;
    const BUFFER_USAGE_COPY_SRC = 0x4;
    const BUFFER_USAGE_COPY_DST = 0x8;
    const BUFFER_USAGE_MAP_READ = 0x1;
    const BUFFER_USAGE_QUERY_RESOLVE = 0x200;
    const MAP_MODE_READ = 0x1;
    // SetTexture/SetSamplerState stage of vertex texture sampler s0 (s1..s3 follow)
    const D3DVERTEXTEXTURESAMPLER0 = 257;
    // GPUQuerySet count limit (WebGPU spec, not an adapter limit)
    const MAX_QUERY_SET_COUNT = 4096;
    const TEXTURE_USAGE_COPY_SRC = 0x1;
    const TEXTURE_USAGE_COPY_DST = 0x2;
    const SHADER_STAGE_VERTEX = 0x1;
    const SHADER_STAGE_FRAGMENT = 0x2;
    const TEXTURE_USAGE_TEXTURE_BINDING = 0x4;

    const TEXTURE_FORMAT_NAMES = {
        20: "R8G8B8", 21: "A8R8G8B8", 22: "X8R8G8B8", 23: "R5G6B5",
        24: "X1R5G5B5", 25: "A1R5G5B5", 26: "A4R4G4B4",
        27: "R3G3B2", 28: "A8", 29: "A8R3G3B2", 30: "X4R4G4B4",
        31: "A2B10G10R10", 32: "A8B8G8R8", 33: "X8B8G8R8",
        34: "G16R16", 35: "A2R10G10B10", 36: "A16B16G16R16",
        50: "L8", 51: "A8L8",
        52: "A4L4", 60: "V8U8", 61: "L6V5U5", 62: "X8L8V8U8",
        63: "Q8W8V8U8", 64: "V16U16", 65: "W11V11U10",
        67: "A2W10V10U10", 81: "L16",
        111: "R16F", 112: "G16R16F", 113: "A16B16G16R16F",
        117: "CxV8U8",
        0x31545844: "DXT1", 0x32545844: "DXT2",
        0x33545844: "DXT3", 0x34545844: "DXT4",
        0x35545844: "DXT5",
    };

    // D3D9 stores FOGSTART/FOGEND/FOGDENSITY as float bits inside a DWORD.
    const FLOAT_BITS_BUFFER = new ArrayBuffer(4);
    const FLOAT_BITS_U32 = new Uint32Array(FLOAT_BITS_BUFFER);
    const FLOAT_BITS_F32 = new Float32Array(FLOAT_BITS_BUFFER);

    /*
     * The D9WGWindowRegion after a WINDOW_STATE record: the parts of the
     * client area other guest windows leave showing, as client-area pixels of
     * a client area baseWidth x baseHeight whose top-left corner is at
     * (originX, originY) on the guest's screen. Null when it does not fit the
     * record or says nothing usable.
     */
    function readVisibleRegion(view, offset, bytes, baseWidth, baseHeight, originX, originY) {
        if (bytes < 4 || !baseWidth || !baseHeight) return null;
        const count = view.getUint32(offset, true);
        if (count > D9WG_WINDOW_REGION_MAX_RECTS || bytes < 4 + count * 16) return null;
        const rects = [];
        for (let i = 0; i < count; ++i) {
            const at = offset + 4 + i * 16;
            const left = view.getInt32(at, true), top = view.getInt32(at + 4, true);
            const right = view.getInt32(at + 8, true), bottom = view.getInt32(at + 12, true);
            if (right > left && bottom > top) rects.push({ left, top, right, bottom });
        }
        return { rects, baseWidth, baseHeight, originX, originY };
    }

    function sameVisibleRegion(a, b) {
        if (a === b) return true;
        if (!a || !b || a.rects.length !== b.rects.length || a.baseWidth !== b.baseWidth ||
                a.baseHeight !== b.baseHeight || a.originX !== b.originX || a.originY !== b.originY)
            return false;
        return a.rects.every((r, i) => r.left === b.rects[i].left && r.top === b.rects[i].top &&
            r.right === b.rects[i].right && r.bottom === b.rects[i].bottom);
    }

    function alignUp(value, alignment) {
        return (value + alignment - 1) & ~(alignment - 1);
    }

    function floatFromDWORD(value) {
        FLOAT_BITS_U32[0] = value >>> 0;
        return FLOAT_BITS_F32[0];
    }

    // Mipmap bias is a per-draw float uniform, clamped to the supported
    // sampling range. It no longer needs quantization to bound shader variants.
    const LOD_BIAS_LIMIT = 16;
    function lodBiasFor(dword) {
        const bias = floatFromDWORD(dword);
        if (!Number.isFinite(bias) || bias === 0) return 0;
        return Math.max(-LOD_BIAS_LIMIT, Math.min(LOD_BIAS_LIMIT, bias));
    }

    // The pixel rect a draw may touch: the D3D9 viewport (which clips, unlike
    // WebGPU's) intersected with the scissor rect when D3DRS_SCISSORTESTENABLE
    // is on, then clamped into the attachment -- WebGPU rejects a scissor that
    // leaves the render target, and an app is free to set a viewport that does.
    // An empty intersection stays empty (zero width or height), which draws
    // nothing, exactly as D3D9 would.
    function intersectRects(viewport, scissor, targetWidth, targetHeight) {
        let left = viewport.x;
        let top = viewport.y;
        let right = viewport.x + viewport.width;
        let bottom = viewport.y + viewport.height;
        if (scissor) {
            left = Math.max(left, scissor.x);
            top = Math.max(top, scissor.y);
            right = Math.min(right, scissor.x + scissor.width);
            bottom = Math.min(bottom, scissor.y + scissor.height);
        }
        left = Math.max(0, Math.min(left, targetWidth));
        top = Math.max(0, Math.min(top, targetHeight));
        right = Math.max(left, Math.min(right, targetWidth));
        bottom = Math.max(top, Math.min(bottom, targetHeight));
        return { x: left, y: top, width: right - left, height: bottom - top };
    }

    // Row-major multiply: out[row][col] = sum_k a[row][k] * b[k][col]. This is
    // D3D's own convention, so multiply4x4(W, V) chains the way a row vector
    // would travel through them (v * W * V). See uniformBufferFor for why no
    // transpose is needed when handing the result to WGSL.
    function multiply4x4(a, b) {
        const out = new Float32Array(16);
        for (let row = 0; row < 4; ++row) {
            for (let col = 0; col < 4; ++col) {
                let sum = 0;
                for (let k = 0; k < 4; ++k)
                    sum += a[row * 4 + k] * b[k * 4 + col];
                out[row * 4 + col] = sum;
            }
        }
        return out;
    }

    const IDENTITY4x4 = new Float32Array([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);

    // The normal matrix for row-vector maths. A normal n must satisfy
    // n' = n * (M^-1)^T for the transformed geometry to keep its perpendicular
    // relationship, and for a 3x3 that expression reduces to the cofactor
    // matrix divided by the determinant -- no explicit inverse or transpose
    // needed. Only the upper 3x3 participates: a normal has w = 0, so the
    // translation row can never reach it.
    //
    // A singular matrix (a degenerate scale, which engines do produce for
    // collapsed geometry) has no inverse; falling back to identity keeps the
    // draw legal and unlit rather than filling the buffer with NaN, which would
    // propagate into the position and make the whole mesh vanish.
    function inverseTranspose3x3(m) {
        const a = m[0], b = m[1], c = m[2];
        const d = m[4], e = m[5], f = m[6];
        const g = m[8], h = m[9], i = m[10];
        const c00 = e * i - f * h, c01 = f * g - d * i, c02 = d * h - e * g;
        const determinant = a * c00 + b * c01 + c * c02;
        const out = new Float32Array(16);
        out[15] = 1;
        if (!determinant || !isFinite(determinant)) {
            out[0] = out[5] = out[10] = 1;
            return out;
        }
        const scale = 1 / determinant;
        out[0] = c00 * scale;
        out[1] = c01 * scale;
        out[2] = c02 * scale;
        out[4] = (c * h - b * i) * scale;
        out[5] = (a * i - c * g) * scale;
        out[6] = (b * g - a * h) * scale;
        out[8] = (b * f - c * e) * scale;
        out[9] = (c * d - a * f) * scale;
        out[10] = (a * e - b * d) * scale;
        return out;
    }

    // Row-vector transforms, matching multiply4x4's convention: v' = v * M.
    function transformPoint(m, v) {
        return [
            v[0] * m[0] + v[1] * m[4] + v[2] * m[8] + m[12],
            v[0] * m[1] + v[1] * m[5] + v[2] * m[9] + m[13],
            v[0] * m[2] + v[1] * m[6] + v[2] * m[10] + m[14],
        ];
    }

    function transformDirection(m, v) {
        return [
            v[0] * m[0] + v[1] * m[4] + v[2] * m[8],
            v[0] * m[1] + v[1] * m[5] + v[2] * m[9],
            v[0] * m[2] + v[1] * m[6] + v[2] * m[10],
        ];
    }

    function normalize3(v) {
        const length = Math.hypot(v[0], v[1], v[2]);
        return length > 0 ? [v[0] / length, v[1] / length, v[2] / length]
            : [0, 0, 1];
    }

    // Retail D3D9 initializes every material component to zero.
    const DEFAULT_MATERIAL = stateFactory.materialDefaults();

    const presentFactory = global.D9WGPresent ||
        (typeof require === "function" ? require("./d9wg_present.js") : null);
    if (!presentFactory) throw new Error("d3d9_executor.js requires d9wg_present.js");

    const recorderFactory = global.D9WGDrawRecorder ||
        (typeof require === "function" ? require("./d9wg_draw_recorder.js") : null);
    const replayFactory = global.D9WGFrameReplayer ||
        (typeof require === "function" ? require("./d9wg_frame_replayer.js") : null);
    if (!recorderFactory || !replayFactory) throw new Error("d3d9_executor.js requires the draw recorder and frame replayer");

    const pipelineFactory = global.D9WGPipelineState ||
        (typeof require === "function" ? require("./d9wg_pipeline_state.js") : null);
    if (!pipelineFactory) throw new Error("d3d9_executor.js requires d9wg_pipeline_state.js");

    const ffpFactory = global.D9WGFFP ||
        (typeof require === "function" ? require("./d9wg_ffp.js") : null);
    if (!ffpFactory) throw new Error("d3d9_executor.js requires d9wg_ffp.js");
    const ffp = ffpFactory.createGenerator({ shaderPipeline, DECLUSAGE_POSITION, DECLUSAGE_POSITIONT, DECLUSAGE_COLOR, DECLUSAGE_NORMAL, DECLUSAGE_TEXCOORD, MAX_TEXCOORD_SETS, DECLUSAGE_PSIZE, DECLUSAGE_BLENDWEIGHT, DECLUSAGE_BLENDINDICES, D3DTOP_BUMPENVMAPLUMINANCE, D3DFOG_LINEAR, D3DFOG_EXP, D3DFOG_EXP2, D3DTOP_SELECTARG1, D3DTOP_SELECTARG2, D3DTOP_MODULATE, D3DTOP_MODULATE2X, D3DTOP_MODULATE4X, D3DTOP_ADD, D3DTOP_ADDSIGNED, D3DTOP_ADDSIGNED2X, D3DTOP_SUBTRACT, D3DTOP_ADDSMOOTH, D3DTOP_BLENDDIFFUSEALPHA, D3DTOP_BLENDTEXTUREALPHA, D3DTOP_BLENDFACTORALPHA, D3DTOP_BLENDCURRENTALPHA, D3DTOP_BLENDTEXTUREALPHAPM, D3DTOP_DOTPRODUCT3, D3DTOP_BUMPENVMAP, D3DTOP_MODULATEALPHA_ADDCOLOR, D3DTOP_MODULATECOLOR_ADDALPHA, D3DTOP_MODULATEINVALPHA_ADDCOLOR, D3DTOP_MODULATEINVCOLOR_ADDALPHA, D3DTOP_MULTIPLYADD, D3DTOP_LERP, D3DMCS_COLOR1, D3DMCS_COLOR2, D3DLIGHT_DIRECTIONAL, D3DLIGHT_PARALLELPOINT, D3DLIGHT_SPOT, D3DTSS_TCI_PASSTHRU, D3DTSS_TCI_CAMERASPACENORMAL, D3DTSS_TCI_CAMERASPACEPOSITION, D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR, D3DTSS_TCI_SPHEREMAP, D3DTA_SELECTMASK, D3DTA_DIFFUSE, D3DTA_CURRENT, D3DTA_TEXTURE, D3DTA_TFACTOR, D3DTA_SPECULAR, D3DTA_TEMP, D3DTA_CONSTANT, D3DTA_ALPHAREPLICATE, D3DTA_COMPLEMENT, D3DTOP_DISABLE });
    const { VARYING_COUNT, VARYING_COLOR0, D3DSHADE_FLAT, D3DSHADE_GOURAUD, varyingDeclaration, VARYING_TEXCOORD0, FF_LOCATION_POSITION, FF_LOCATION_COLOR0, FF_LOCATION_COLOR1, FF_LOCATION_NORMAL, FF_LOCATION_TEXCOORD0, FF_LOCATION_PSIZE, FF_LOCATION_BLENDWEIGHT, FF_LOCATION_BLENDINDICES, alphaTestDiscard, fixedFunctionLocationFor, vertexInputDeclaration, declTypeInputScalar, uniformBlockLayout, uniformBlockStruct, HALF_PIXEL_OFFSET_BODY, fixedVertexUniformLayout, fixedPixelUniformLayout, fixedFogFactorExpression, textureOpExpression, buildFixedFunctionVertexShader, buildFixedFunctionPixelShader } = ffp;

    // A fragment stage that deliberately depends on no varying, constant or
    // texture.  It is used only by the live black-screen probe below.  Keeping
    // it independent of the translated/fixed-function shader is important:
    // "solid" used to rewrite only the fixed-function cascade, so a scene
    // made entirely of programmable draws stayed black and the diagnostic
    // falsely implicated geometry.  This module can be paired with either
    // vertex path while the original program still supplies the bind-group
    // layout expected by the rest of the draw machinery.
    const DIAGNOSTIC_SOLID_PIXEL_SHADER = `
@fragment
fn d9_ps_main() -> @location(0) vec4<f32> {
    return vec4<f32>(0.0, 1.0, 0.0, 1.0);
}
`;

    function createIndexedDBShaderCacheStorage(indexedDB) {
        const databaseName = "d9wg-shader-cache";
        const storeName = "snapshots";
        const open = () => new Promise((resolve, reject) => {
            const request = indexedDB.open(databaseName, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(storeName))
                    db.createObjectStore(storeName);
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ||
                new Error("could not open the shader-cache database"));
            request.onblocked = () => reject(new Error(
                "shader-cache database upgrade is blocked by another page"));
        });
        return {
            async load(key) {
                const db = await open();
                try {
                    return await new Promise((resolve, reject) => {
                        const request = db.transaction(storeName, "readonly")
                            .objectStore(storeName).get(key);
                        request.onsuccess = () => resolve(request.result || null);
                        request.onerror = () => reject(request.error ||
                            new Error("could not read the shader cache"));
                    });
                } finally {
                    db.close();
                }
            },
            async save(key, payload) {
                const db = await open();
                try {
                    await new Promise((resolve, reject) => {
                        const transaction = db.transaction(storeName, "readwrite");
                        transaction.objectStore(storeName).put(payload, key);
                        transaction.oncomplete = () => resolve();
                        transaction.onerror = () => reject(transaction.error ||
                            new Error("could not write the shader cache"));
                        transaction.onabort = () => reject(transaction.error ||
                            new Error("shader-cache transaction was aborted"));
                    });
                } finally {
                    db.close();
                }
            },
        };
    }

    const PROGRAM_DRAW_COUNTERS = [
        "drawsWithTexture", "drawsWithFallbackTexture", "drawsWithUnsupportedTextureOp",
        "drawsWithCompactVertexInputs", "drawsWithMissingCoordSet", "drawsWithUnappliedVertexBlend",
        "drawsWithUnwrittenCoordVarying", "zeroNormalDrawsWithoutTexture", "zeroNormalDrawsWithMissingTexture",
        "zeroNormalDrawsWithUnboundTexture", "zeroNormalDrawsWithUnknownTexture", "zeroNormalDrawsWithLiveTexture",
        "drawsWithDefaultedInputs", "drawsWithZeroNormalLighting", "blendedDraws",
    ];

    const DEVICE_STATE_CONSTANTS = { D3DMULTISAMPLE_NONE, D3DTS_VIEW, D3DTS_PROJECTION, D3DTS_WORLD, IDENTITY4x4,
        MAX_VS_CONST_F, MAX_PS_CONST_F, MAX_CONST_I, MAX_CONST_B };

    class D3D9WebGPUExecutor {
        constructor(canvas, options) {
            if (!canvas) throw new Error("D3D9 WebGPU canvas is required");
            this.canvas = canvas;
            this.options = options || {};
            this.gpu = this.options.gpu ||
                (global.navigator && global.navigator.gpu);
            this.adapter = this.options.adapter || null;
            this.device = this.options.device || null;
            this.context = this.options.context || null;
            this.format = this.options.format || null;
            // Skipped entirely when a device was supplied -- a caller that
            // brought its own device configures the canvas itself. Otherwise
            // the gpu/adapter/context overrides go to the host, so that a
            // caller injecting a fake WebGPU still gets one device and one
            // canvas configuration rather than two.
            this.host = this.options.host || (this.device ? null :
                ((host => host ? host.acquire(canvas, {
                    gpu: this.gpu,
                    adapter: this.adapter,
                    context: this.context,
                    format: this.format,
                    ...(this.options.hostOptions || {}),
                }) : null)(resolveGPUHost())));
            this.devices = new Map();      // device_handle -> device state
            this.resources = new Map();    // resource_handle -> resource state
            this.pipelineCache = new Map(); // layout signature -> GPURenderPipeline
            this.bindGroupCache = new Map(); // GPU resources -> GPUBindGroup
            this.maxBindGroups = Math.max(256,
                this.options.maxBindGroups || 4096);
            this.uniformRingCapacity = Math.max(64 * 1024,
                this.options.uniformRingBytes || UNIFORM_RING_BYTES);
            // Chunks, not one buffer. A frame's draw count is not bounded by
            // anything -- 3DMark06's batch-size test exists precisely to drive
            // it as high as the driver will go -- and one 16 MiB ring only
            // holds uniformRingCapacity/256 slots, after which the old code
            // fell back to a fresh GPUBuffer *per draw*. Those also defeated
            // the bind-group cache (a transient buffer must not be cached), so
            // past the cliff every draw allocated one buffer plus one bind
            // group and held both until Present. Chunks keep the allocation
            // count proportional to bytes used rather than to draw count, and
            // they are pooled across frames so their object identity -- which
            // is what the bind-group cache keys on -- stays stable.
            // The D3D9 back buffer is an executor-owned texture, not
            // context.getCurrentTexture(). See ensureBackBufferTexture().
            this.backBufferTexture = null;
            this.backBufferView = null;
            this.backBufferSrgbView = null;
            this.backBufferTextureWidth = 0;
            this.backBufferTextureHeight = 0;
            // Palette contents and the DirectDraw GPU palette cache use device
            // handles in their keys. Handles overlap between guest processes,
            // so these are session aliases just like devices/resources and the
            // retained back buffer (see switchSession()).
            this.palettes = new Map();
            this.ddPaletteBuffers = new Map();
            this.ddPaletteSerials = new Map();
            // How many recorded ops may accumulate before the frame is
            // submitted early. A D3D9 frame's cost is otherwise unbounded in
            // its draw count -- 3DMark06's batch-size tests exist to drive that
            // count as high as the driver allows -- and every op is both a live
            // JS object and, at replay, a command in one enormous command
            // buffer. Flushing bounds both. Now that the back buffer is an
            // owned texture (see ensureBackBufferTexture) a partial frame can
            // be submitted without acquiring the swap chain, which is what made
            // this possible at all.
            //
            // Each flush costs one queue.submit(), so the number wants to be
            // large enough that ordinary frames never reach it: a normal scene
            // draws in the hundreds, and even the particle test's 56 draws per
            // frame are three orders of magnitude below this.
            this.flushThreshold = Math.max(1024,
                this.options.flushThreshold || 16384);
            // The guest blocks on a readback, so this is a VM-freeze budget
            // rather than a GPU-latency one.
            this.readbackTimeoutMs = Math.max(250,
                this.options.readbackTimeoutMs || 4000);
            this.heartbeat = 0;
            this.heartbeatBuffer = new Uint8Array(4);
            this.uploads = null;
            this.uniformRingChunks = [];
            // A CPU-side mirror of each chunk. Constants are written here and
            // the whole used prefix goes up in one writeBuffer per submit --
            // see uploadUniformStaging().
            this.uniformStaging = [];
            this.uniformRingMaxChunks = Math.max(1,
                this.options.uniformRingChunks || 4);
            this.uniformRingIndex = 0;
            this.uniformRingCursor = 0;
            /*
             * Bumped by every command that is not a draw. D3D9 constants are
             * device state, not a buffer the app manages, so "did the constants
             * change" is answerable the way a real driver answers it: nothing
             * called SetConstant, therefore nothing changed. That is O(1).
             *
             * It replaces hashing the assembled block per draw, which was the
             * same question asked the expensive way -- a 3DMark06 batch-size run
             * hashed 6.8 GB to find that 7% of draws could share a slot. Being
             * bumped by *any* non-draw command makes it conservative: it can
             * only ever miss a reuse, never claim a stale one.
             */
            this.commandSerial = 1;
            this.programSerial = 1;
            this.uniformSerial = 1;
            this.recordingOpcode = 0;
            this.objectIds = new WeakMap();
            this.nextObjectId = 1;
            // Bytecode hash -> {ok, wgsl, reflection}. Survives device loss:
            // WGSL text is not tied to a GPUDevice (plan 8.5), only the
            // GPUShaderModules in moduleCache are.
            this.shaderCache = new shaderPipeline.D3D9ShaderCache();
            this.shaderCacheStorageKey = "d9wg.shader-cache.sm3-vtf.20260822.v1";
            let indexedDBStorage = null;
            try {
                if (!this.options.shaderCacheStorage && global.window &&
                        global.indexedDB) {
                    indexedDBStorage = createIndexedDBShaderCacheStorage(
                        global.indexedDB);
                }
            } catch (error) { /* persistence is optional for restricted origins */ }
            this.shaderCacheStorage = this.options.shaderCacheStorage ||
                indexedDBStorage;
            this.shaderCacheStorageBackend = this.options.shaderCacheStorage ?
                "injected" : (indexedDBStorage ? "indexeddb" : "memory");
            this.persistentShaderCachePromise = null;
            this.shaderCacheSaveTimer = null;
            this.shaderCacheDirty = false;
            this.shaderWorker = null;
            this.shaderWorkerRequests = new Map();
            this.shaderWorkerSerial = 0;
            this.moduleCache = new Map();  // wgsl -> GPUShaderModule
            this.fixedModuleCache = new Map(); // normalized signature -> GPUShaderModule
            this.samplerCache = new Map(); // sampler-state signature -> GPUSampler
            // D3D9 hardware cursor: bitmap, hotspot, position, visibility.
            this.cursor = { texture: null, view: null, width: 0, height: 0,
                hotspotX: 0, hotspotY: 0, x: 0, y: 0, visible: false,
                pipeline: null, sampler: null, uniform: null };
            this.fallbackTexture = null;
            this.defaultAttributes = null;
            this.fallbackView = null;
            this.fallbackDepth = null;
            this.fallbackViews = null;
            this.substituteDepthViews = null;
            // Every protocol-1.3 batch carries its process session id in the
            // batch header. Futuremark launches several D3D9 probe/helper
            // processes alongside the benchmark, and their numeric handles
            // overlap. Keep an independent live context per process and swap
            // these aliases at batch boundaries; one helper's HELLO must never
            // tear down a benchmark process that is still rendering.
            this.sessionStates = new Map();
            this.sessionKey = null;
            // the sessions submitted since the arena's owner last released it
            this.ownerSessions = new Set();
            this.ownerSessionScopes = new Map();
            this.hostCapabilitiesByOwner = new Map();
            this.batchOwnerToken = 0;
            this.frame = null;             // { ops, transientBuffers, serial }
            this.frameSerial = 0;
            this.frameReplayer = new FrameReplayer(this);
            this.readyPromise = null;
            this.pendingReadbacks = new Set();
            this.work = Promise.resolve();
            // Host exceptions, kept in strict mode for tests to assert on
            this.hostErrors = [];
            // Why the last failed batch failed (diagnostics; nothing reads it)
            this.lastBatchFailure = null;
            // Flags remain cheap and directly console-togglable. Heavy capture
            // and report code is loaded only by enableDiagnostics().
            this.debug = {
                forceClearColor: null, disableCull: false, disableDepthTest: false,
                shaderMode: null, forceSolidAllDraws: false, forceMipLevel0: false,
                warnOnSuspiciousDraws: false, highlightMissingTexture: false,
                highlightMissingCoordSet: false, skipProgrammableDraws: false,
                texcoordFromStageIndex: true,
            };
            for (const name of DIAGNOSTIC_REPORTS)
                this.debug[name] = (...args) => this[name](...args);
            this.debug.clearShaderCache = () => this.clearShaderCache();
            this.diagnosticsEnabled = false;
            this.diagnosticsPromise = null;
            this.lastDraws = null;
            this.stats = {
                batches: 0, commands: 0, presents: 0, queueSubmits: 0,
                drawCalls: 0, indexedDrawCalls: 0, upDrawCalls: 0,
                pipelineCreations: 0, pipelineHits: 0, pipelinesRejected: 0,
                programBuilds: 0, programCacheHits: 0,
                bindGroupCreations: 0, bindGroupHits: 0,
                bindGroupCacheEvictions: 0, framesRejected: 0,
                uniformSlotReuses: 0, uniformRingOverflows: 0,
                uniformRingChunksAllocated: 0, uniformRingChunksUsed: 0,
                backBufferAllocations: 0, backBufferPresents: 0,
                redundantStateSkipped: 0, uniformStagingUploads: 0,
                readbackRequests: 0,
                frameFlushes: 0,
                unsupportedCommands: 0, malformedBatches: 0, batchesFailed: 0,
                protocolViolations: 0, msaaUnresolves: 0,
                malformedCommands: 0, gammaRampUpdates: 0, fillModeDraws: 0,
                swapChainsCreated: 0, swapChainsDestroyed: 0,
                swapChainsRefused: 0, swapChainPresents: 0,
                swapChainPresentsDropped: 0,
                gammaPresents: 0,
                droppedDraws: 0,
                guestReports: 0,
                texturesCreated: 0, textureUploads: 0, textureBytesUploaded: 0,
                texturePreviewsSkipped: 0,
                drawsWithTexture: 0, drawsWithFallbackTexture: 0,
                shadersTranslated: 0, shaderTranslationFailures: 0,
                shaderVariantsTranslated: 0,
                shaderModulesCreated: 0, shaderCompileErrors: 0,
                shaderCachePersistentLoads: 0,
                shaderCachePersistentSaves: 0,
                shaderCachePersistentFailures: 0,
                shaderWorkerCompiles: 0, shaderWorkerFallbacks: 0,
                samplersCreated: 0, samplerHits: 0,
                // Back-buffer persistence diagnostics. WebGPU does not preserve
                // a canvas texture across Present, while D3D9 applications
                // commonly redraw only changing rectangles. Those frames are
                // counted and restored from the owned post-Present snapshot.
                // A frame with no ops remains useful diagnostic evidence that
                // Present itself did not produce new GPU work.
                framesWithoutColorClear: 0, framesWithNoOps: 0,
                // Legacy rename counters stay zero for diagnostics consumers.
                uploadChunksAllocated: 0, uploadStagingUploads: 0,
                bufferRenames: 0, textureUpdateHazards: 0,
                textureRenames: 0, textureFullCopyRenameBytes: 0,
                bufferFullCopyRenames: 0, bufferNoOverwriteWrites: 0,
                emptySurfaceReports: 0, surfaceChanges: 0, sessionChanges: 0,
                sessionsEnded: 0,
                deviceLosses: 0, deviceRecoveries: 0,
                guestFeatureBits: 0, guestShaderModel2: false,
                guestShaderModel3: false,
                windowStateChanges: 0, windowNotForegroundReports: 0, windowOccludedReports: 0,
                windowRegionReports: 0,
                cursorUploads: 0, cursorDraws: 0,
                texturesRejected: 0,
                srgbTextureSamples: 0, srgbViewsCreated: 0,
                srgbCopyTexturesCreated: 0, srgbTextureCopies: 0,
                srgbTextureUnavailable: 0, srgbWriteRequests: 0,
                srgbWriteUnavailable: 0,
                cubeTexturesCreated: 0, volumeTexturesCreated: 0,
                renderTargetsCreated: 0,
                renderTargetBinds: 0, renderPasses: 0,
                depthTargetSizeMismatches: 0,
                depthTargetSubstitutions: 0,
                depthTargetSubstitutionsUncleared: 0,
                blits: 0, blitsSkipped: 0, blitsThroughBackBuffer: 0,
                colorFills: 0,
                partialClears: 0,
                drawsWithScissor: 0,
                drawsWithIncompleteMipChain: 0,
                // Hardware shadow maps: depth textures sampled through a
                // comparison sampler, and the ways a stage can fail to be one.
                comparisonSamplersCreated: 0,
                depthStageWithoutDepthTexture: 0,
                depthAttachmentSampledInPlace: 0,
                cubeFaceTargetBinds: 0,
                mipChainsGenerated: 0, mipLevelsGenerated: 0,
                explicitMipGenerations: 0,
                palettesSet: 0, paletteSelections: 0, palettizedRepaints: 0,
                depthTextureOnNonDepthStage: 0,
                stagesWithoutSampleableView: 0,
                commandsFailed: 0,
                lastDrawTexture: 0,
                drawsWithUnsupportedTextureOp: 0,
                drawsWithTexCoordIndex: 0, drawsWithTextureTransform: 0,
                drawsWithUnmappedBlend: 0, drawsWithUnappliedFog: 0,
                drawsWithUnappliedLighting: 0,
                drawsWithZeroNormalLighting: 0,
                zeroNormalDrawsWithoutTexture: 0,
                zeroNormalDrawsWithMissingTexture: 0,
                // The two halves of "missing", which are different bugs with
                // the same symptom: the guest bound nothing to the stage
                // (handle 0), or it bound a handle this host has no resource
                // for -- a texture whose creation was refused, or one already
                // destroyed. Both end at the 1x1 white fallback, so the
                // picture cannot tell them apart and the counters must.
                zeroNormalDrawsWithUnboundTexture: 0,
                zeroNormalDrawsWithUnknownTexture: 0,
                zeroNormalDrawsWithLiveTexture: 0,
                // Fixed-function pixel stages routed to a varying the bound
                // translated vertex shader never assigned.
                drawsWithUnwrittenCoordVarying: 0,
                drawsWithDefaultedInputs: 0,
                // The same seam one stage earlier, and entirely inside the
                // fixed-function path: a stage whose D3DTSS_TEXCOORDINDEX names
                // a coordinate set the *declaration* does not carry. The vertex
                // stage substitutes a constant for it, so the model samples one
                // texel and comes out a single flat colour.
                drawsWithMissingCoordSet: 0,
                // Draws posed by more than one world matrix, and draws
                // whose declaration carries skinning data that the
                // render state told us to ignore.
                blendedDraws: 0,
                drawsWithUnappliedVertexBlend: 0,
                programmableDraws: 0, drawsSkippedForBadShader: 0,
                drawsWithCompactVertexInputs: 0,
                constantUploadBytes: 0,
                pointSpriteDraws: 0, pointSpriteInstances: 0,
                indexedPointExpansions: 0,
                instancedDraws: 0, instancesDrawn: 0,
                expandedInstanceStreams: 0,
                queriesCreated: 0, queryBegins: 0, queryEnds: 0,
                occlusionQueriesResolved: 0, timestampQueriesResolved: 0,
                eventQueriesResolved: 0, queryFailures: 0,
                responseWriteFailures: 0,
                renderTargetReadbacks: 0, renderTargetReadbackBytes: 0,
                renderTargetReadbackFailures: 0,
            };
            this.mrtAttachmentDraws = [0, 0, 0, 0, 0];
            this.lastFrameStats = {
                pipelineCreations: 0, bindGroupCreations: 0,
                queueSubmits: 0, renderPasses: 0,
            };
            if (this.options.diagnostics && typeof require === "function")
                this.installDiagnostics(require("./d9wg_diagnostics.js"));
        }

        installDiagnostics(factory) {
            if (!this.diagnosticsEnabled) factory.install(this, {
                TEXTURE_FORMAT_NAMES, RESOURCE_VERTEX_SHADER, RESOURCE_PIXEL_SHADER,
                D3DRS_SCISSORTESTENABLE, intersectRects,
            });
            return this.debug;
        }

        enableDiagnostics() {
            if (this.diagnosticsEnabled) return Promise.resolve(this.debug);
            if (this.diagnosticsPromise) return this.diagnosticsPromise;
            if (typeof require === "function") {
                return Promise.resolve(this.installDiagnostics(require("./d9wg_diagnostics.js")));
            }
            if (!diagnosticsLoad) {
                diagnosticsLoad = new Promise((resolve, reject) => {
                    if (global.D9WGDiagnostics) { resolve(global.D9WGDiagnostics); return; }
                    if (typeof document === "undefined") {
                        reject(new Error("D3D diagnostics require a document or CommonJS loader"));return;
                    }
                    const script = document.createElement("script");
                    const url = this.options.diagnosticsUrl || DEFAULT_DIAGNOSTICS_URL;
                    if (!url) { reject(new Error("D3D diagnostics URL is unavailable"));return; }
                    script.src = url;
                    script.onload = () => {
                        script.remove();
                        if (global.D9WGDiagnostics) resolve(global.D9WGDiagnostics);
                        else reject(new Error("D3D diagnostics script did not register its module"));
                    };
                    script.onerror = () => { script.remove();reject(new Error("Could not load D3D diagnostics")); };
                    document.head.appendChild(script);
                }).catch(error => { diagnosticsLoad = null;throw error; });
            }
            this.diagnosticsPromise = diagnosticsLoad.then(factory => this.installDiagnostics(factory))
                .catch(error => { this.diagnosticsPromise = null;throw error; });
            return this.diagnosticsPromise;
        }

        initialize() {
            if (this.readyPromise) return this.readyPromise;
            this.readyPromise = (async () => {
                // Persistent I/O must not delay adapter/device acquisition.
                // The first submitted batch awaits the same promise before it
                // can create a shader, so starting both jobs here preserves
                // cache hits without putting IndexedDB on the startup path.
                this.restorePersistentShaderCache();
                this.initializeShaderWorker();
                if (!this.device) {
                    if (!this.host) throw new Error("WebGPU is unavailable");
                    // The host asks the adapter for the union of what every
                    // backend needs, BCn included. Without those features every
                    // createTexture for a DXT format throws, which kills the
                    // batch and with it the frame -- and DXT1/3/5 are the
                    // formats a 2002-and-later D3D9 game keeps almost all of
                    // its art in, so that is most of the screen.
                    await this.host.initialize();
                    this.adapter = this.host.adapter;
                    this.device = this.host.device;
                    this.deviceFeatures = this.host.deviceFeatures;
                    this.context = this.context || this.host.context;
                    this.format = this.format || this.host.format;
                }
                // A device supplied by the caller (the fake device in tests, or
                // a shared one) reports its own features.
                if (!this.deviceFeatures) {
                    const features = this.device.features;
                    const has = name => !!(features &&
                        typeof features.has === "function" &&
                        features.has(name));
                    this.deviceFeatures = {
                        bc: has("texture-compression-bc"),
                        float32Filterable: has("float32-filterable"),
                        float32Blendable: has("float32-blendable"),
                        timestampQuery: has("timestamp-query"),
                    };
                }
                // The host configured the canvas with the same usage set this
                // file used to: a context defaults to RENDER_ATTACHMENT alone,
                // but StretchRect to and from the back buffer is how a D3D9
                // game does full-screen post-processing, so COPY_SRC/COPY_DST
                // and TEXTURE_BINDING are not optional. Only a caller that
                // supplied its own device still has to configure for itself.
                this.context = this.context ||
                    (this.canvas && typeof this.canvas.getContext === "function" ?
                        this.canvas.getContext("webgpu") : null);
                if (!this.context) throw new Error("could not acquire a WebGPU canvas context");
                this.format = this.format || (this.gpu &&
                    typeof this.gpu.getPreferredCanvasFormat === "function" ?
                    this.gpu.getPreferredCanvasFormat() : "bgra8unorm");
                this.swapchainSrgbFormat = srgbSiblingOf(this.format);
                if (!this.host && typeof this.context.configure === "function") {
                    this.context.configure({
                        device: this.device, format: this.format,
                        ...(this.swapchainSrgbFormat
                            ? { viewFormats: [this.swapchainSrgbFormat] } : {}),
                        alphaMode: "opaque",
                        usage: TEXTURE_USAGE_RENDER_ATTACHMENT |
                            TEXTURE_USAGE_COPY_SRC | TEXTURE_USAGE_COPY_DST |
                            TEXTURE_USAGE_TEXTURE_BINDING,
                    });
                }
                this.fallbackTexture = this.device.createTexture({
                    label: "D3D9 fallback white texture",
                    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                    format: "rgba8unorm",
                    usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
                });
                this.fallbackView = this.fallbackTexture.createView();
                this.device.queue.writeTexture({ texture: this.fallbackTexture },
                    new Uint8Array([255, 255, 255, 255]),
                    { bytesPerRow: 4, rowsPerImage: 1 },
                    { width: 1, height: 1, depthOrArrayLayers: 1 });
                this.uploads = null;
            this.uniformRingChunks = [];
                this.uniformStaging = [];
                this.uniformRingIndex = 0;
                this.uniformRingCursor = 0;
                this.gpuErrors = resolveGPUHost().GPUErrorLog.forDevice(this.device);
                if (this.options.strict) this.gpuErrors.strict = true;
                this.watchForDeviceLoss();
                if (this.options.diagnostics) await this.enableDiagnostics();
                return this;
            })().catch(error => {
                this.failed = error;
                console.error("[d3d9-webgpu] initialization failed", error);
                throw error;
            });
            return this.readyPromise;
        }

        async restorePersistentShaderCache() {
            if (this.persistentShaderCachePromise)
                return this.persistentShaderCachePromise;
            this.persistentShaderCachePromise = (async () => {
                try {
                    let payload = null;
                    const storage = this.shaderCacheStorage;
                    if (storage && typeof storage.load === "function") {
                        payload = await storage.load(this.shaderCacheStorageKey);
                    }
                    if (typeof payload === "string") payload = JSON.parse(payload);
                    const restored = this.shaderCache.importEntries(payload);
                    if (restored) this.stats.shaderCachePersistentLoads += restored;
                } catch (error) {
                    ++this.stats.shaderCachePersistentFailures;
                    this.warnOnce("shader-cache-load",
                        "persistent shader cache could not be restored; using the " +
                        "in-memory cache for this session", { message: String(error) });
                }
            })();
            return this.persistentShaderCachePromise;
        }

        initializeShaderWorker() {
            if (this.options.useShaderWorker === false || this.shaderWorker)
                return;
            const WorkerClass = this.options.Worker || global.Worker;
            const url = this.options.shaderWorkerUrl || DEFAULT_SHADER_WORKER_URL;
            if (typeof WorkerClass !== "function" || !url) return;
            try {
                const worker = new WorkerClass(url);
                worker.onmessage = event => {
                    const message = event.data || {};
                    const pending = this.shaderWorkerRequests.get(message.id);
                    if (!pending) return;
                    this.shaderWorkerRequests.delete(message.id);
                    pending.resolve(message.result);
                };
                worker.onerror = event => {
                    const error = new Error("shader compiler worker failed: " +
                        ((event && event.message) || "unknown worker error"));
                    for (const pending of this.shaderWorkerRequests.values())
                        pending.reject(error);
                    this.shaderWorkerRequests.clear();
                    try { worker.terminate(); } catch (ignored) {}
                    if (this.shaderWorker === worker) this.shaderWorker = null;
                };
                this.shaderWorker = worker;
            } catch (error) {
                ++this.stats.shaderWorkerFallbacks;
                this.warnOnce("shader-worker-create",
                    "shader compile Worker is unavailable; compiling on the " +
                    "executor thread", { message: String(error) });
            }
        }

        compileShaderInWorker(tokens) {
            if (!this.shaderWorker) return null;
            const id = ++this.shaderWorkerSerial;
            return new Promise((resolve, reject) => {
                this.shaderWorkerRequests.set(id, { resolve, reject });
                try {
                    this.shaderWorker.postMessage({ id,
                        tokens: Array.from(tokens) });
                } catch (error) {
                    this.shaderWorkerRequests.delete(id);
                    reject(error);
                }
            });
        }

        schedulePersistentShaderCacheSave() {
            const storage = this.shaderCacheStorage;
            if (!storage || typeof storage.save !== "function") return;
            if (this.shaderCacheSaveTimer !== null)
                global.clearTimeout(this.shaderCacheSaveTimer);
            this.shaderCacheSaveTimer = global.setTimeout(() => {
                this.shaderCacheSaveTimer = null;
                this.flushPersistentShaderCache();
            }, 250);
        }

        async flushPersistentShaderCache() {
            if (!this.shaderCacheDirty) return;
            this.shaderCacheDirty = false;
            try {
                const payload = this.shaderCache.exportEntries(2 * 1024 * 1024);
                const storage = this.shaderCacheStorage;
                if (!storage || typeof storage.save !== "function") return;
                await storage.save(this.shaderCacheStorageKey, payload);
                ++this.stats.shaderCachePersistentSaves;
            } catch (error) {
                this.shaderCacheDirty = true;
                ++this.stats.shaderCachePersistentFailures;
                this.warnOnce("shader-cache-save",
                    "persistent shader cache could not be saved; translated " +
                    "WGSL remains cached in memory", { message: String(error) });
            }
        }

        submit(bytes, metadata) {
            const owned = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes || []);
            this.work = this.work.then(() => this.initialize())
                .then(() => this.restorePersistentShaderCache())
                .then(() => this.executeBatch(owned, metadata || {}))
                .catch(error => {
                    // Only this batch is lost. A stream error is the guest
                    // and host disagreeing about the layout; anything else
                    // is a host bug, which strict mode (tests) keeps.
                    ++this.stats.batchesFailed;
                    this.lastBatchFailure = error;
                    if (!(error instanceof D9WGStreamError) && this.options.strict)
                        this.hostErrors.push(error);
                    console.error("[d3d9-webgpu] batch failed", error, metadata || {});
                    this.discardFrame();
                });
            return this.work;
        }

        trackReadback(operation) {
            this.pendingReadbacks.add(operation);
            operation.then(() => this.pendingReadbacks.delete(operation),
                () => this.pendingReadbacks.delete(operation));
            return operation;
        }

        idle() { return this.work; }

        async checkpointIdle() {
            await this.work;
            while (this.pendingReadbacks.size)
                await Promise.all(Array.from(this.pendingReadbacks));
        }

        flushForCheckpoint() {
            const original = this.sessionKey;
            for (const key of this.sessionStates.keys()) {
                this.switchSession(key);
                this.finishFrame(false);
            }
            if (original !== null) this.switchSession(original);
        }

        async resetForReplay() {
            await this.checkpointIdle();
            for (const reply of this.hostCapabilitiesByOwner.values()) delete reply.publishedBits;
            for (const key of this.sessionStates.keys()) {
                this.switchSession(key);
                this.releaseActiveSession("state-restore");
            }
            this.sessionStates.clear();
            this.ownerSessions.clear();this.ownerSessionScopes.clear();
            this.sessionKey = null;
            this.pipelineCache.clear();
            this.bindGroupCache.clear();
            this.moduleCache.clear();
            this.fixedModuleCache.clear();
            ++this.programSerial;
            ++this.uniformSerial;
            this.samplerCache.clear();
        }

        // ---- batch decode ----

        async executeBatch(bytes, metadata) {
            const timing = this["performanceTiming"];
            let segmentStart = timing ? timing["now"]() : 0;
            try {
            let packet;
            try { packet = wire.readHeader(bytes); }
            catch (error) {
                if (error instanceof D9WGStreamError) ++this.stats.malformedBatches;
                throw error;
            }
            const { view, end, commandCount } = packet;
            const ownerToken = metadata.ownerToken === undefined ? 0 : metadata.ownerToken;
            if (!Number.isInteger(ownerToken) || ownerToken < 0 || ownerToken > 0xffffffff) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG transport owner token is invalid");
            }
            this.batchOwnerToken = ownerToken;
            const sessionKey = this.ownerSessionKey(packet.sessionKey, ownerToken);
            this.switchSession(sessionKey);
            this.ownerSessions.add(sessionKey);
            let scope = this.ownerSessionScopes.get(ownerToken);
            if (!scope) this.ownerSessionScopes.set(ownerToken, scope = new Set());
            scope.add(sessionKey);
            ++this.stats.batches;

            this.checkStream(view, end, commandCount);
            let offset = D9WG_BATCH_HEADER_BYTES;
            let primaryPresent = false, additionalPresent = false;
            while (offset < end) {
                const opcode = view.getUint16(offset + D9WG.F.CommandHeader.opcode, true);
                if (opcode === OP_PRESENT) primaryPresent = true;
                if (opcode === OP_PRESENT_SWAP_CHAIN) additionalPresent = true;
                const size = view.getUint32(offset + D9WG.F.CommandHeader.size, true);
                const payloadOffset = offset + D9WG_COMMAND_HEADER_BYTES;
                const payloadBytes = size - D9WG_COMMAND_HEADER_BYTES;
                // One command's failure must not consume the rest of the
                // batch. A throw used to unwind all the way to submit(), which
                // dropped every command still queued behind it -- render target
                // bindings, resource creations, vertex declarations -- and the
                // guest had no way to know. The frames that followed then drew
                // against state the host had never been told about, and
                // reported it as unknown render targets and missing vertex
                // declarations: symptoms several batches removed from the one
                // command that actually failed.
                //
                // A malformed *stream* still fails the batch: D9WGStreamError
                // is not one bad command but a disagreement about the byte
                // layout, and continuing past it would be executing garbage.
                try {
                    this.recordingOpcode = opcode;
                    const pending = this.dispatchCommand(opcode, bytes, view,
                        payloadOffset, payloadBytes, metadata);
                    if (pending && typeof pending.then === "function") {
                        if (timing) timing["sync"](timing["now"]() - segmentStart);
                        try { await pending; }
                        finally { if (timing) segmentStart = timing["now"](); }
                    }
                } catch (error) {
                    if (error instanceof D9WGStreamError) throw error;
                    // A host bug: this command is lost, the rest of the batch
                    // is not. Each distinct failure is reported (once per
                    // opcode hid the second kind of error behind the first),
                    // and kept for tests in strict mode.
                    ++this.stats.commandsFailed;
                    if (this.options.strict) this.hostErrors.push(error);
                    const message = String(error && error.message ? error.message : error);
                    this.warnOnce("command-failed-" + opcode + "-" + message,
                        "a command threw and was skipped; the rest of the " +
                        "batch still executes", { opcode, message, error });
                } finally { this.recordingOpcode = 0; }
                // Any command other than a draw may have moved something the
                // constant block is built from. Draws are excluded because they
                // are the thing being deduplicated; opcodes 0x300..0x303 are the
                // four draw entry points.
                if (opcode < OP_DRAW_PRIMITIVE ||
                        opcode > OP_DRAW_INDEXED_PRIMITIVE_UP)
                    this.advanceDrawState(opcode, view, payloadOffset);
                offset += size;
                ++this.stats.commands;
                // Mid-batch, because one PCI batch can carry a whole 16 MiB
                // arena's worth of draws -- checking only at the batch boundary
                // would let ~80000 of them pile up first.
                if (this.frame && this.frame.ops.length >= this.flushThreshold)
                    this.finishFrame(false);
            }
            // The batch flag closes either kind of frame. A chain-only Present
            // already records its own canvas blit and must leave primary scanout
            // untouched. Preserve primary presentation for legacy flag-only batches.
            if (packet.present) this.finishFrame(primaryPresent || !additionalPresent);
            else if (this.flushRequested) this.finishFrame(false);
            this.flushRequested = false;
            this.beat(metadata);
            if (this.shaderCacheDirty) this.schedulePersistentShaderCacheSave();
            this.saveActiveSessionState();
            } finally {
                if (timing) timing["sync"](timing["now"]() - segmentStart);
            }
        }

        // The batch's structure, before any of it runs: the command sizes tile
        // command_bytes exactly, the guest numbered the commands consecutively
        // (the header's sequence: a size that points into the middle of a
        // payload lands on a "header" whose sequence is not the next one),
        // and their number is command_count. A batch that fails here runs
        // none of its commands.
        checkStream(view, end, commandCount) {
            try { wire.checkStream(view, end, commandCount); }
            catch (error) {
                if (error instanceof D9WGStreamError) ++this.stats.malformedBatches;
                throw error;
            }
        }

        dispatchCommand(opcode, bytes, view, offset, length, metadata) {
            const handler = this.handlers[opcode];
            if (handler && length < D9WG_MIN_PAYLOAD[opcode]) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG " + D9WG.OP_NAME[opcode] + " payload is " + length +
                    " bytes, its struct needs " + D9WG_MIN_PAYLOAD[opcode]);
            }
            if (!handler) {
                // Skipped by its size (already advanced by the caller), and
                // reported: a guest DLL newer than this host, or protocol drift
                ++this.stats.unsupportedCommands;
                this.protocolViolation("opcode-" + opcode, "unknown D9WG opcode 0x" +
                    opcode.toString(16) + " skipped", { opcode });
                return;
            }
            return handler.call(this, bytes, view, offset, length, metadata);
        }

        uploadFrame(bytes) {
            if (!this.recordingBindings && this.frame && this.uploads && this.uploads.bytesUsed + bytes > (this.options.uploadBudgetBytes || (64 << 20))) this.finishFrame(false);
            const frame = this.ensureFrame();
            if (!this.uploads) this.uploads = new Uploads(this.device, object => this.retireGPUObject(object), this.stats);
            return frame;
        }

        stageBufferUpload(buffer, offset, source) {
            const frame = this.uploadFrame(source.byteLength);
            frame.record(this.uploads.buffer(buffer, offset, source));
        }

        // Present-time utilities may discover a palette after the recorded
        // ops were replayed. Append only fresh staging bytes, then encode its
        // copy directly into the same encoder before the utility pass.
        encodeBufferUpload(encoder, buffer, source) {
            if (!this.uploads) this.uploads = new Uploads(this.device, object => this.retireGPUObject(object), this.stats);
            const op = this.uploads.buffer(buffer, 0, source);
            this.uploads.flush();
            this.uploads.replay(encoder, op);
        }

        stageTextureUpload(destination, source, layout, size, resource) {
            const frame = this.uploadFrame(source.byteLength);
            const op = this.uploads.texture(destination, source, layout, size);
            op.writes = resource && resource.msaaTexture ? resource : null;
            frame.record(op);
        }

        // ---- device/resource state ----

        deviceState(handle) {
            const state = this.devices.get(handle);
            if (!state) throw new Error("D9WG command names an unknown device " + (handle >>> 0));
            return state;
        }

        createDeviceState(handle, autoDepth = true) {
            return stateFactory.createDeviceState(handle, DEVICE_STATE_CONSTANTS, autoDepth);
        }

        createSessionState(key) {
            return stateFactory.createSessionState(key);
        }

        saveActiveSessionState() {
            if (this.sessionKey === null) return;
            const state = this.sessionStates.get(this.sessionKey);
            if (!state) return;
            stateFactory.captureSession(state, this);
        }

        switchSession(key) {
            if (this.sessionKey === key && this.sessionStates.has(key)) return;
            const previousKey = this.sessionKey;
            this.saveActiveSessionState();
            let state = this.sessionStates.get(key);
            if (!state) {
                state = this.createSessionState(key);
                this.sessionStates.set(key, state);
            }
            this.sessionKey = key;
            stateFactory.activateSession(this, state);
            if (this.diagnosticsEnabled && !this.lastDraws)
                this.lastDraws = { fixed: null, programmable: null };
            if (previousKey !== null) {
                ++this.stats.sessionChanges;
                if (this.stats.sessionChanges === 1)
                    console.info("[d3d9-webgpu] multiple guest processes are " +
                        "active; D3D9 handles and in-flight frames are now " +
                        "isolated by the batch session id");
                const previous = this.sessionStates.get(previousKey);
                // Capability-only helper processes own no GPU state. Forget
                // them as soon as they go inactive so repeated benchmark runs
                // cannot grow the session table without bound.
                if (previous && !previous.devices.size &&
                        !previous.resources.size && !previous.frame &&
                        !previous.activeOcclusion && !previous.cursor.texture &&
                        !previous.backBufferTexture &&
                        !previous.ddPaletteBuffers.size && !previous.uniformRingChunks.length)
                    this.sessionStates.delete(previousKey);
            }
        }

        // World * View * Projection in D3D's own row-vector order, so that
        // a vertex would be transformed as v * W * V * P. multiply4x4 is a
        // plain row-major multiply, which is exactly that chaining.
        wvp(state) {
            const world = state.transforms.get(D3DTS_WORLD) || IDENTITY4x4;
            const view_ = state.transforms.get(D3DTS_VIEW) || IDENTITY4x4;
            const projection = state.transforms.get(D3DTS_PROJECTION) || IDENTITY4x4;
            return multiply4x4(multiply4x4(world, view_), projection);
        }

        // ---- opcode handlers ----

        get handlers() {
            if (this._handlers) return this._handlers;
            this._handlers = {
                [OP_HELLO]: this.onHello,
                [OP_CREATE_DEVICE]: this.onCreateDevice,
                [OP_RESET]: this.onReset,
                [OP_PRESENT]: this.onPresent,
                [OP_CLEAR]: this.onClear,
                [OP_BEGIN_SCENE]: this.onBeginScene,
                [OP_END_SCENE]: this.onEndScene,
                [OP_CREATE_BUFFER]: this.onCreateBuffer,
                [OP_UPDATE_BUFFER]: this.onUpdateBuffer,
                [OP_DESTROY_RESOURCE]: this.onDestroyResource,
                [OP_CREATE_TEXTURE_2D]: this.onCreateTexture2D,
                [OP_CREATE_TEXTURE_CUBE]: this.onCreateTextureCube,
                [OP_CREATE_TEXTURE_VOLUME]: this.onCreateTextureVolume,
                [OP_UPDATE_TEXTURE]: this.onUpdateTexture,
                [OP_READBACK_SURFACE]: this.onReadbackSurface,
                [OP_SESSION_END]: this.onSessionEnd,
                [OP_SET_SCISSOR_RECT]: this.onSetScissorRect,
                [OP_SET_RENDER_TARGET]: this.onSetRenderTarget,
                [OP_SET_DEPTH_STENCIL_SURFACE_LEVEL]:
                    this.onSetDepthStencilSurfaceLevel,
                [OP_SET_PALETTE]: this.onSetPalette,
                [OP_SET_CURRENT_TEXTURE_PALETTE]:
                    this.onSetCurrentTexturePalette,
                [OP_GENERATE_MIPS]: this.onGenerateMips,
                [OP_SET_TEXTURE_LOD]: this.onSetTextureLOD,
                [OP_SET_GAMMA_RAMP]: this.onSetGammaRamp,
                [OP_CREATE_SWAP_CHAIN]: this.onCreateSwapChain,
                [OP_DESTROY_SWAP_CHAIN]: this.onDestroySwapChain,
                [OP_PRESENT_SWAP_CHAIN]: this.onPresentSwapChain,
                [OP_STRETCH_RECT]: this.onStretchRect,
                [OP_COLOR_FILL]: this.onColorFill,
                [OP_GUEST_LOG]: this.onGuestLog,
                [OP_CREATE_VERTEX_DECLARATION]: this.onCreateVertexDeclaration,
                [OP_CREATE_VERTEX_SHADER]: this.onCreateVertexShader,
                [OP_CREATE_PIXEL_SHADER]: this.onCreatePixelShader,
                [OP_CREATE_QUERY]: this.onCreateQuery,
                [OP_SET_CURSOR_PROPERTIES]: this.onSetCursorProperties,
                [OP_SET_CURSOR_POSITION]: this.onSetCursorPosition,
                [OP_SHOW_CURSOR]: this.onShowCursor,
                [OP_WINDOW_STATE]: this.onWindowState,
                [OP_SET_VERTEX_SHADER]: this.onSetVertexShader,
                [OP_SET_PIXEL_SHADER]: this.onSetPixelShader,
                [OP_SET_VERTEX_SHADER_CONSTANT_F]: this.onSetVertexShaderConstantF,
                [OP_SET_VERTEX_SHADER_CONSTANT_I]: this.onSetVertexShaderConstantI,
                [OP_SET_VERTEX_SHADER_CONSTANT_B]: this.onSetVertexShaderConstantB,
                [OP_SET_PIXEL_SHADER_CONSTANT_F]: this.onSetPixelShaderConstantF,
                [OP_SET_PIXEL_SHADER_CONSTANT_I]: this.onSetPixelShaderConstantI,
                [OP_SET_PIXEL_SHADER_CONSTANT_B]: this.onSetPixelShaderConstantB,
                [OP_SET_CLIP_PLANE]: this.onSetClipPlane,
                [OP_SET_RENDER_STATE]: this.onSetRenderState,
                [OP_SET_SAMPLER_STATE]: this.onSetSamplerState,
                [OP_SET_TEXTURE_STAGE_STATE]: this.onSetTextureStageState,
                [OP_SET_TEXTURE]: this.onSetTexture,
                [OP_SET_VIEWPORT]: this.onSetViewport,
                [OP_SET_TRANSFORM]: this.onSetTransform,
                [OP_SET_MATERIAL]: this.onSetMaterial,
                [OP_SET_LIGHT]: this.onSetLight,
                [OP_LIGHT_ENABLE]: this.onLightEnable,
                [OP_SET_STREAM_SOURCE]: this.onSetStreamSource,
                [OP_SET_STREAM_SOURCE_FREQ]: this.onSetStreamSourceFreq,
                [OP_SET_INDICES]: this.onSetIndices,
                [OP_SET_VERTEX_DECLARATION]: this.onSetVertexDeclaration,
                [OP_SET_FVF]: this.onSetFVF,
                [OP_DRAW_PRIMITIVE]: this.onDrawPrimitive,
                [OP_DRAW_INDEXED_PRIMITIVE]: this.onDrawIndexedPrimitive,
                [OP_DRAW_PRIMITIVE_UP]: this.onDrawPrimitiveUP,
                [OP_DRAW_INDEXED_PRIMITIVE_UP]: this.onDrawIndexedPrimitiveUP,
                [OP_BEGIN_QUERY]: this.onBeginQuery,
                [OP_END_QUERY]: this.onEndQuery,
            };
            // Opcode groups that live in a sibling module -- currently
            // ddraw_ops.js's 0x500 DirectDraw group. Merged here rather than
            // listed above so this file stays the D3D9 command set, and so a
            // page that never loads the sibling simply has those opcodes count
            // as unsupported instead of failing to construct.
            if (D3D9WebGPUExecutor.extensionHandlers)
                Object.assign(this._handlers,
                    D3D9WebGPUExecutor.extensionHandlers);
            // A name that is not a method (UPDATE_SURFACE pointed at one
            // nobody wrote) used to make its opcode silently "unsupported"
            for (const [opcode, handler] of Object.entries(this._handlers))
                if (typeof handler !== "function")
                    throw new Error("D9WG handler for opcode " + opcode + " is not a function");
            return this._handlers;
        }

        onHello(bytes, view, offset, length, metadata) {
            void view.getUint32(offset + D9WG.F.Hello.guest_pointer_bits, true); // guest_pointer_bits
            const featureBits = view.getUint32(offset + D9WG.F.Hello.feature_bits, true);
            const sessionLow = view.getUint32(offset + D9WG.F.Hello.session_id_low, true);
            const sessionHigh = view.getUint32(offset + D9WG.F.Hello.session_id_high, true);
            // Keyed as a string, not `high * 2**32 + low`: a 64-bit id does not
            // survive a float64 above 2**53, and the low bits are exactly the
            // ones that distinguish two processes. The old arithmetic key made
            // the log self-contradictory (created "...576bff", replaced
            // "...576c00" -- the same session, printed exact then rounded) and
            // let two distinct sessions round together into one key, which
            // would keep a dead process's handles alive against a live one.
            const sessionKey = this.ownerSessionKey(sessionHigh.toString(16).padStart(8, "0") +
                sessionLow.toString(16).padStart(8, "0"), this.batchOwnerToken);
            // HELLO duplicates the batch-header id as a corruption check. The
            // header selected the context before command decoding; changing it
            // here would let one malformed command redirect the rest of its
            // batch into another process's handle namespace.
            if (this.sessionKey !== sessionKey) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG HELLO session does not match its batch");
            }
            const session = this.sessionStates.get(sessionKey);
            if (session) session.featureBits = featureBits;
            let reply = this.hostCapabilitiesByOwner.get(this.batchOwnerToken);
            if (!reply) this.hostCapabilitiesByOwner.set(this.batchOwnerToken, reply = {});
            this.publishHostCapabilities(reply, metadata);
            this.stats.guestFeatureBits = featureBits;
            // Record the active caps profile so diagnostics can distinguish a
            // fixed-function/SM2 run from a default SM3 run directly.
            this.stats.guestShaderModel2 =
                (featureBits & D9WG_FEATURE_SHADER_MODEL_2) !== 0;
            this.stats.guestShaderModel3 =
                (featureBits & D9WG_FEATURE_SHADER_MODEL_3) !== 0;
        }

        retireDeviceState(state, reason) {
            if (!state) return;
            state.surface = { ...state.surface, visible: false };
            if (typeof this.options.onDestroy === "function")
                this.options.onDestroy(state.surface, reason || "device");
            this.retireSwapChains(state);
            this.retireDeviceBackBuffer(state);
            this.retireGPUObject(state.depthTexture);
            this.retireGPUObject(state.backBufferMsaaTexture);
            this.retireGPUObject(state.gammaRampTexture);
            this.retirePaletteCachesForDevice(state.handle);
        }

        releaseActiveSession(reason) {
            // No queued frame from an ending process may be replayed later
            // after another process has reused the same numeric handles.
            this.discardFrame();
            for (const resource of this.resources.values())
                this.retireResourceState(resource);
            this.resources.clear();
            for (const state of this.devices.values())
                this.retireDeviceState(state, reason || "session-end");
            this.devices.clear();
            for (const entry of this.ddPaletteBuffers.values())
                this.retireGPUObject(entry && entry.buffer);
            this.ddPaletteBuffers.clear();
            this.ddPaletteSerials.clear();
            this.palettes.clear();
            this.retireActiveSessionBackBuffer();
            if (this.uploads) this.uploads.release();
            this.uploads = null;
            for (const buffer of this.uniformRingChunks) this.retireGPUObject(buffer);
            this.uniformRingChunks = [];
            this.uniformStaging = [];
            this.uniformRingIndex = 0;
            this.uniformRingCursor = 0;
            this.retireGPUObject(this.cursor && this.cursor.texture);
            this.retireGPUObject(this.cursor && this.cursor.uniform);
            this.cursor = { texture: null, view: null, width: 0, height: 0,
                hotspotX: 0, hotspotY: 0, x: 0, y: 0, visible: false,
                pipeline: null, sampler: null, uniform: null };
            this.activeOcclusion = null;
            this.presentingDevice = null;
            this.windowState = null;
            if (this.diagnosticsEnabled) this.lastDraws = { fixed: null, programmable: null };
        }

        onSessionEnd(bytes, view, offset, length) {
            const sessionLow = view.getUint32(offset + D9WG.F.SessionEnd.session_id_low, true);
            const sessionHigh = view.getUint32(offset + D9WG.F.SessionEnd.session_id_high, true);
            const sessionKey = this.ownerSessionKey(sessionHigh.toString(16).padStart(8, "0") +
                sessionLow.toString(16).padStart(8, "0"), this.batchOwnerToken);
            if (this.sessionKey !== sessionKey) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError(
                    "D9WG SESSION_END session does not match its batch");
            }
            const endedKey = this.sessionKey;
            this.hostCapabilitiesByOwner.delete(this.batchOwnerToken);
            this.releaseActiveSession("session-end");
            this.sessionStates.delete(endedKey);
            // SESSION_END is required to be the final command from a process.
            // Clearing the active key also makes a corrupt trailing command
            // unable to save freshly-created state back under the dead id.
            this.sessionKey = null;
            ++this.stats.sessionsEnded;
        }

        // The process that owned the DMA arena is gone (it unmapped it, or the
        // kernel closed the device for it when it was killed): its sessions
        // end as SESSION_END would have ended them (review S1-10)
        ownerSessionKey(sessionKey, ownerToken) {
            return ownerToken ? "owner" + ownerToken.toString(16) + "/" + sessionKey : sessionKey;
        }

        endOwnerSessions(ownerToken) {
            if (ownerToken === undefined) this.hostCapabilitiesByOwner.clear();
            else this.hostCapabilitiesByOwner.delete(ownerToken);
            const sessions = ownerToken === undefined ? this.ownerSessions : this.ownerSessionScopes.get(ownerToken);
            if (!sessions) return;
            const original = this.sessionKey;
            const restore = original && !sessions.has(original);
            for (const key of sessions) {
                this.ownerSessions.delete(key);
                if (!this.sessionStates.has(key) && this.sessionKey !== key) continue;
                this.switchSession(key);
                this.releaseActiveSession("owner-released");
                this.sessionStates.delete(key);
                this.sessionKey = null;
                ++this.stats.sessionsEnded;
            }
            if (ownerToken === undefined) this.ownerSessionScopes.clear();
            else this.ownerSessionScopes.delete(ownerToken);
            if (restore && this.sessionStates.has(original)) this.switchSession(original);
        }

        onCreateDevice(bytes, view, offset, length) {
            const handle = view.getUint32(offset + D9WG.F.CreateDevice.device_handle, true);
            const hwnd = view.getUint32(offset + D9WG.F.CreateDevice.hwnd, true);
            const x = view.getInt32(offset + D9WG.F.CreateDevice.x, true);
            const y = view.getInt32(offset + D9WG.F.CreateDevice.y, true);
            const width = view.getUint32(offset + D9WG.F.CreateDevice.width, true);
            const height = view.getUint32(offset + D9WG.F.CreateDevice.height, true);
            const enableAutoDepth = view.getUint32(offset + D9WG.F.CreateDevice.enable_auto_depth_stencil, true);
            const multisampleType = view.getUint32(offset + D9WG.F.CreateDevice.multisample_type, true);
            const multisampleQuality = view.getUint32(offset + D9WG.F.CreateDevice.multisample_quality, true);
            // A new device cannot discard pending work from another device
            // in the same session. Reusing a handle first submits the old work
            // so its captured views remain valid until the queue completes.
            const previous = this.devices.get(handle);
            if (previous) {
                this.finishFrame(false);
                this.retireDeviceState(previous, "replace");
            }
            const state = this.createDeviceState(handle, enableAutoDepth !== 0);
            this.devices.set(handle, state);
            state.viewport = { x: 0, y: 0, width, height, minZ: 0, maxZ: 1 };
            state.surface = { hwnd, x, y, width, height, visible: true,
                noSurface: false, sessionKey: this.sessionKey };
            state.backBufferWidth = width;
            state.backBufferHeight = height;
            state.backBufferD3DFormat = view.getUint32(offset + D9WG.F.CreateDevice.backbuffer_format, true);
            this.configureBackBufferMSAA(state, width, height,
                multisampleType, multisampleQuality);
            this.ensureDepthTarget(state, width, height, enableAutoDepth !== 0);
            this.notifySurface(state, "create");
        }

        onReset(bytes, view, offset, length) {
            const oldHandle = view.getUint32(offset + D9WG.F.ResetDevice.old_device_handle, true);
            const newHandle = view.getUint32(offset + D9WG.F.ResetDevice.new_device_handle, true);
            const hwnd = view.getUint32(offset + D9WG.F.ResetDevice.hwnd, true);
            const x = view.getInt32(offset + D9WG.F.ResetDevice.x, true);
            const y = view.getInt32(offset + D9WG.F.ResetDevice.y, true);
            const width = view.getUint32(offset + D9WG.F.ResetDevice.width, true);
            const height = view.getUint32(offset + D9WG.F.ResetDevice.height, true);
            const enableAutoDepth = view.getUint32(offset + D9WG.F.ResetDevice.enable_auto_depth_stencil, true);
            const multisampleType = view.getUint32(offset + D9WG.F.ResetDevice.multisample_type, true);
            const multisampleQuality = view.getUint32(offset + D9WG.F.ResetDevice.multisample_quality, true);
            const oldState = this.deviceState(oldHandle);
            if (newHandle !== oldHandle && this.devices.has(newHandle))
                throw new Error("D9WG RESET target device already exists");
            this.finishFrame(false);
            if (oldState) {
                this.retireSwapChains(oldState);
                this.retireGPUObject(oldState.depthTexture);
                this.retireGPUObject(oldState.backBufferMsaaTexture);
                this.retireDeviceBackBuffer(oldState);
            }
            this.devices.delete(oldHandle);
            // The session's resources and palettes survive the Reset under
            // their handles (the guest no longer creates them again); what
            // names the device moves to its new handle
            for (const resource of this.resources.values())
                if (resource.deviceHandle === oldHandle) resource.deviceHandle = newHandle;
            for (const [key, palette] of Array.from(this.palettes || [])) {
                const [device, index] = key.split(":");
                if (Number(device) !== oldHandle) continue;
                this.palettes.delete(key);
                this.palettes.set(newHandle + ":" + index, palette);
            }
            // Reset changes the generation/defaults of an existing logical
            // device; it cannot introduce a previously unknown device.
            const state = Object.assign(oldState, this.createDeviceState(newHandle, enableAutoDepth !== 0));
            this.devices.set(newHandle, state);
            state.viewport = { x: 0, y: 0, width, height, minZ: 0, maxZ: 1 };
            state.surface = { hwnd, x, y, width, height, visible: true,
                noSurface: false, sessionKey: this.sessionKey };
            state.backBufferWidth = width;
            state.backBufferHeight = height;
            state.backBufferD3DFormat = view.getUint32(offset + D9WG.F.ResetDevice.backbuffer_format, true);
            this.configureBackBufferMSAA(state, width, height,
                multisampleType, multisampleQuality);
            this.ensureDepthTarget(state, width, height, enableAutoDepth !== 0);
            // Surviving P8 indices must follow the reset selector as well.
            this.repaintPalettizedTextures(newHandle);
            this.notifySurface(state, "reset");
        }

        // Creates (or drops) the device's auto depth-stencil target. D3D9
        // reports many depth formats but the guest can never read any of
        // them back in M1, so one depth24plus-stencil8 target satisfies all
        // of them; only whether a depth buffer exists at all is observable.
        ensureDepthTarget(state, width, height, enabled) {
            if (state.depthTexture) {
                // Never destroy it inline: the frame currently being recorded
                // may already have pinned this texture's view (see
                // recordDraw's frame.depthView) and will not submit until
                // Present, so an immediate destroy produces
                // "Destroyed texture ... used in a submit" -- a real crash
                // observed when a device was re-created or Reset mid-frame.
                this.retireGPUObject(state.depthTexture);
                state.depthTexture = null;
                state.depthView = null;
            }
            state.hasDepth = !!enabled;
            if (!enabled || !width || !height) return;
            state.depthTexture = this.device.createTexture({
                label: "D3D9 auto depth-stencil",
                size: { width, height, depthOrArrayLayers: 1 },
                format: DEPTH_FORMAT,
                sampleCount: state.sampleCount || 1,
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT,
            });
            state.depthView = state.depthTexture.createView();
            state.depthWidth = width;
            state.depthHeight = height;
        }

        // One line per distinct condition, so a per-frame problem cannot flood
        // the console while still being reported the first time it happens.
        // The guest sent what its own rules should have refused: a guest bug,
        // reported (and kept for tests in strict mode); the host carries on
        // with the nearest legal value
        protocolViolation(key, message, details) {
            ++this.stats.protocolViolations;
            if (this.options.strict) this.hostErrors.push(new Error(message));
            this.warnOnce("protocol-" + key, "guest protocol violation: " + message, details);
        }

        warnOnce(key, message, details) {
            this.warned = this.warned || new Set();
            if (this.warned.has(key)) return;
            this.warned.add(key);
            console.warn("[d3d9-webgpu] " + message, details || "");
        }

        // Releases a GPU object that the in-flight frame may still reference.
        // If a frame is being recorded, the object rides along with that
        // frame's transient list and is destroyed only once the frame's
        // submit has completed; otherwise it waits on the queue directly.
        retireGPUObject(object) {
            if (!object || typeof object.destroy !== "function") return;
            if (this.frame) {
                this.frame.transientBuffers.push(object);
                return;
            }
            const destroy = () => object.destroy();
            if (this.device.queue
                    && typeof this.device.queue.onSubmittedWorkDone === "function")
                this.device.queue.onSubmittedWorkDone().then(destroy, destroy);
            else
                destroy();
        }

        // WebGPU can take the device away (driver reset, tab backgrounded on
        // some platforms, an unrecoverable validation failure). Before this, the
        // executor logged one error and then failed every subsequent batch
        // forever, which on screen is a frozen canvas with no explanation.
        //
        // What recovery achieves and what it does not, precisely:
        //
        //   It does   bring the host back to a working GPUDevice, canvas context
        //             and cache set, so the page is alive and the next Present
        //             does not throw.
        //   It does   preserve every translation result: WGSL text is not tied
        //             to a GPUDevice (plan 8.5), so the translator does not run
        //             again -- only the GPUShaderModules are rebuilt, lazily.
        //   It does not restore the guest's resources. Their contents live in
        //             the guest's CPU shadows, and the only way to get them back
        //             is for the guest to replay them -- which it does on Reset
        //             (recreate_device_resources in d3d9_proxy.c) but has no
        //             reason to do, because nothing tells it the device was
        //             lost. Until the host->guest notification of plan 6.7
        //             exists, draws after a loss reference handles the new
        //             device never saw and are counted in droppedDraws.
        //
        // So this converts "the page is dead" into "the page is alive and the
        // stats say exactly what happened", which is the honest extent of it.
        watchForDeviceLoss() {
            if (!this.device || !this.device.lost ||
                    typeof this.device.lost.then !== "function")
                return;
            const lostDevice = this.device;
            this.device.lost.then(info => {
                if (this.destroyed || info && info.reason === "destroyed") return;
                if (this.device !== lostDevice) return;
                ++this.stats.deviceLosses;
                console.error("[d3d9-webgpu] WebGPU device lost (" +
                    ((info && info.reason) || "unknown") + "): " +
                    ((info && info.message) || "") +
                    " -- rebuilding; the guest will see D3DERR_DEVICELOST and " +
                    "re-create its resources through its own Reset path");
                this.recoverDevice();
            }, () => {});
        }

        recoverDevice() {

            for (const reply of this.hostCapabilitiesByOwner.values()) delete reply.publishedBits;
            // Everything below was created by the lost device and cannot be
            // destroyed or reused; dropping the references is all that is
            // possible and all that is needed.
            this.discardFrame();
            this.sessionStates.clear();
            this.ownerSessions.clear();this.ownerSessionScopes.clear();
            this.devices = new Map();
            this.resources = new Map();
            this.palettes = new Map();
            this.ddPaletteBuffers = new Map();
            this.ddPaletteSerials = new Map();
            this.pipelineCache.clear();
            this.bindGroupCache.clear();
            this.moduleCache.clear();
            this.fixedModuleCache.clear();
            ++this.programSerial;
            ++this.uniformSerial;
            this.samplerCache.clear();
            this.cursor = { ...this.cursor, texture: null, view: null,
                pipeline: null, sampler: null, uniform: null,
                bindGroupLayout: null, visible: false };
            this.activeOcclusion = null;
            this.presentingDevice = null;
            this.lastSwapTexture = null;
            this.windowState = null;
            this.fallbackTexture = null;
            this.defaultAttributes = null;
            this.fallbackView = null;
            this.fallbackDepth = null;
            this.fallbackViews = null;
            this.substituteDepthViews = null;
            this.backBufferTexture = null;
            this.backBufferView = null;
            this.backBufferSrgbView = null;
            this.backBufferTextureWidth = 0;
            this.backBufferTextureHeight = 0;
            this.uploads = null;
            this.uniformRingChunks = [];
            this.uniformStaging = [];
            this.uniformRingIndex = 0;
            this.uniformRingCursor = 0;
            this.objectIds = new WeakMap();
            this.nextObjectId = 1;
            this.device = null;
            this.context = null;
            this.readyPromise = null;
            this.sessionKey = null;
            if (typeof this.options.onDeviceLost === "function")
                this.options.onDeviceLost();
            // initialize() is idempotent through readyPromise, and submit()
            // already awaits it before every batch, so the next batch after a
            // loss brings the new device up.
            this.work = this.initialize().then(() => {
                ++this.stats.deviceRecoveries;
            }, error => {
                console.error("[d3d9-webgpu] device recovery failed", error);
            });
        }

        onBeginScene(bytes, view, offset) {
            const handle = view.getUint32(offset + D9WG.F.DeviceOnly.device_handle, true);
            this.deviceState(handle).inScene = true;
        }

        onEndScene(bytes, view, offset) {
            const handle = view.getUint32(offset + D9WG.F.DeviceOnly.device_handle, true);
            this.deviceState(handle).inScene = false;
        }

        writeQueryResponse(query, requestId, value, status, metadata) {
            // A released query can have its guest response slot recycled while
            // an older GPU map is still completing. Never let that late map
            // overwrite the new owner's slot.
            if (query.destroyed) return false;
            const writer = metadata && metadata.writeGuestMemory;
            if (typeof writer !== "function") {
                ++this.stats.responseWriteFailures;
                return false;
            }
            try {
                const out = new Uint8Array(16);
                const result = new DataView(out.buffer);
                const numeric = typeof value === "bigint"
                    ? value : BigInt(Math.max(0, Number(value) || 0));
                result.setUint32(0, requestId >>> 0, true);
                result.setUint32(4, Number(numeric & 0xffffffffn), true);
                result.setUint32(8, Number((numeric >> 32n) & 0xffffffffn), true);
                // Last by protocol contract: observing completion means the
                // preceding request/value bytes are visible too.
                result.setUint32(12, status >>> 0, true);
                writer(D9WG_RESPONSE_REGION_OFFSET + query.responseOffset, out);
                return true;
            } catch (error) {
                ++this.stats.responseWriteFailures;
                this.warnOnce("query-response-write",
                    "a completed GPU query could not be written back to guest " +
                    "DMA memory", { message: String(error) });
                return false;
            }
        }

        onCreateQuery(bytes, view, offset, length) {
            const handle = view.getUint32(offset + D9WG.F.CreateQuery.resource_handle, true);
            const type = view.getUint32(offset + D9WG.F.CreateQuery.query_type, true);
            const responseOffset = view.getUint32(offset + D9WG.F.CreateQuery.response_offset, true);
            if (responseOffset + 16 > D9WG_QUERY_REGION_BYTES ||
                    (responseOffset & 15) !== 0) {
                ++this.stats.queryFailures;
                return;
            }
            this.resources.set(handle, { kind: RESOURCE_QUERY, type,
                responseOffset, active: false, requestId: 0 });
            ++this.stats.queriesCreated;
        }

        onBeginQuery(bytes, view, offset, length, metadata) {
            const query = this.resources.get(view.getUint32(offset + D9WG.F.QueryIssue.resource_handle, true));
            if (!query || query.kind !== RESOURCE_QUERY) return;
            const responseOffset = view.getUint32(offset + D9WG.F.QueryIssue.response_offset, true);
            const requestId = view.getUint32(offset + D9WG.F.QueryIssue.request_id, true);
            if (responseOffset !== query.responseOffset) return;
            query.active = true;
            query.requestId = requestId;
            query.metadata = metadata || {};
            const frame = this.ensureFrame();
            frame.record({ kind: "query-begin", query, requestId,
                metadata: query.metadata });
            ++this.stats.queryBegins;
        }

        onEndQuery(bytes, view, offset, length, metadata) {
            const query = this.resources.get(view.getUint32(offset + D9WG.F.QueryIssue.resource_handle, true));
            if (!query || query.kind !== RESOURCE_QUERY) return;
            const responseOffset = view.getUint32(offset + D9WG.F.QueryIssue.response_offset, true);
            const requestId = view.getUint32(offset + D9WG.F.QueryIssue.request_id, true);
            if (responseOffset !== query.responseOffset) return;
            query.requestId = requestId;
            const resultMetadata = metadata || query.metadata || {};
            const frame = this.ensureFrame();
            frame.record({ kind: "query-end", query, requestId,
                metadata: resultMetadata });
            query.active = false;
            ++this.stats.queryEnds;
            /* A GetData call submits the partial guest batch without Present.
             * Ask executeBatch() to submit this frame too so polling can make
             * progress. */
            this.flushRequested = true;
        }

        /*
         * Told to the guest once per finished batch. A readback makes the guest
         * spin until the host answers, and submission has no backpressure, so
         * without this the guest cannot tell a host that is thousands of
         * batches behind from one that has died -- and it gave up on the first,
         * reporting a readback failure for a host that was working correctly.
         */
        hostFeatureBits() {
            // Advertised adapter features are not necessarily enabled on the
            // acquired device. Only that actual device may grant optional caps.
            const features = this.device && this.device.features;
            const has = name => !!(features && typeof features.has === "function" && features.has(name));
            return (has("float32-filterable") ? D9WG.C.D9WG_HOST_FEATURE_FLOAT32_FILTERABLE : 0) |
                (has("float32-blendable") ? D9WG.C.D9WG_HOST_FEATURE_FLOAT32_BLENDABLE : 0) |
                (has("texture-compression-bc") ? D9WG.C.D9WG_HOST_FEATURE_TEXTURE_COMPRESSION_BC : 0) |
                (has("timestamp-query") ? D9WG.C.D9WG_HOST_FEATURE_TIMESTAMP_QUERY : 0);
        }

        publishHostCapabilities(reply, metadata) {
            const writer = metadata && metadata.writeGuestMemory;
            if (typeof writer !== "function") return false;
            const bits = this.hostFeatureBits();
            if (reply.publishedBits === bits) return true;
            const out = D9WG.encode("HostCapabilities", { feature_bits: bits,
                version: D9WG.C.D9WG_HOST_CAPS_VERSION, magic: D9WG.C.D9WG_HOST_CAPS_MAGIC });
            const at = D9WG_RESPONSE_REGION_OFFSET + D9WG.C.D9WG_HOST_CAPS_OFFSET;
            try {
                // Invalidate any earlier publication, write data, then publish
                // completion. These bytes never overlap queries or readbacks.
                writer(at + D9WG.F.HostCapabilities.magic, new Uint8Array(4), false);
                writer(at, out.subarray(0, D9WG.F.HostCapabilities.magic), false);
                writer(at + D9WG.F.HostCapabilities.magic, out.subarray(D9WG.F.HostCapabilities.magic), false);
                reply.publishedBits = bits;
                return true;
            } catch (error) {
                delete reply.publishedBits;
                ++this.stats.responseWriteFailures;
                this.warnOnce("host-capabilities-write", "host capabilities could not be written to the guest", { message: String(error) });
                return false;
            }
        }

        beat(metadata) {
            const reply = this.hostCapabilitiesByOwner.get(this.batchOwnerToken);
            if (reply) this.publishHostCapabilities(reply, metadata);
            const writer = metadata && metadata.writeGuestMemory;
            if (typeof writer !== "function") {
                this.warnOnce("beat-no-writer",
                    "this batch carried no guest-memory writer, so the guest " +
                    "cannot be told the host is alive and will time out any " +
                    "readback it waits on");
                return;
            }
            this.heartbeat = (this.heartbeat + 1) >>> 0;
            const out = this.heartbeatBuffer;
            out[0] = this.heartbeat & 0xff;
            out[1] = (this.heartbeat >>> 8) & 0xff;
            out[2] = (this.heartbeat >>> 16) & 0xff;
            out[3] = (this.heartbeat >>> 24) & 0xff;
            const at = D9WG_RESPONSE_REGION_OFFSET + D9WG_HEARTBEAT_OFFSET;
            try {
                writer(at, out);
            } catch (error) {
                ++this.stats.responseWriteFailures;
                this.warnOnce("beat-write-failed",
                    "the host cannot write into guest memory at all; every " +
                    "readback and query response is being lost the same way", {
                        dmaOffset: at,
                        message: String(error && error.message
                            ? error.message : error),
                    });
            }
        }

        writeReadbackResponse(responseOffset, requestId, payload, status,
                metadata) {
            const writer = metadata && metadata.writeGuestMemory;
            if (typeof writer !== "function") {
                // The guest is *spinning* on this response, so returning
                // quietly is not a no-op -- it is a hang that ends in the
                // guest's own timeout with nothing to explain it.
                ++this.stats.responseWriteFailures;
                this.warnOnce("readback-no-writer",
                    "a readback response could not be delivered: this batch " +
                    "arrived without a guest-memory writer, so the guest will " +
                    "spin until its own timeout", { responseOffset, requestId });
                return false;
            }
            const data = payload || new Uint8Array(0);
            const out = new Uint8Array(16 + data.byteLength);
            const result = new DataView(out.buffer);
            result.setUint32(0, requestId >>> 0, true);
            result.setUint32(4, data.byteLength, true);
            if (data.byteLength) out.set(data, 16);
            result.setUint32(12, status >>> 0, true);
            writer(D9WG_RESPONSE_REGION_OFFSET + responseOffset, out);
            return true;
        }

        async onReadbackSurface(bytes, view, offset, length, metadata) {
            ++this.stats.readbackRequests;
            const deviceHandle = view.getUint32(offset + D9WG.F.ReadbackSurface.device_handle, true);
            const textureHandle = view.getUint32(offset + D9WG.F.ReadbackSurface.texture_handle, true);
            const level = view.getUint32(offset + D9WG.F.ReadbackSurface.level, true);
            const format = view.getUint32(offset + D9WG.F.ReadbackSurface.format, true);
            const width = view.getUint32(offset + D9WG.F.ReadbackSurface.width, true);
            const height = view.getUint32(offset + D9WG.F.ReadbackSurface.height, true);
            const firstRow = view.getUint32(offset + D9WG.F.ReadbackSurface.first_row, true);
            const rowCount = view.getUint32(offset + D9WG.F.ReadbackSurface.row_count, true);
            const destinationPitch = view.getUint32(offset + D9WG.F.ReadbackSurface.destination_pitch, true);
            const destinationBytes = view.getUint32(offset + D9WG.F.ReadbackSurface.destination_bytes, true);
            const responseOffset = view.getUint32(offset + D9WG.F.ReadbackSurface.response_offset, true);
            const requestId = view.getUint32(offset + D9WG.F.ReadbackSurface.request_id, true);
            const face = D9WG.has(length, "ReadbackSurface", "face")
                ? view.getUint32(offset + D9WG.F.ReadbackSurface.face, true) : 0;
            const fail = error => {
                ++this.stats.renderTargetReadbackFailures;
                try {
                    this.writeReadbackResponse(responseOffset, requestId, null,
                        D9WG_RESPONSE_FAILED, metadata);
                } catch (writeError) {
                    ++this.stats.responseWriteFailures;
                    this.warnOnce("readback-response-write-failed",
                        "the failure response could not be written either, so " +
                        "the guest sees silence rather than an error", {
                            message: String(writeError) });
                }
                // Keyed by cause, not just by format: the first failure used
                // to suppress every later one, so a second, different fault in
                // the same session was invisible.
                this.warnOnce("render-target-readback-" + format + "-" +
                        String(error && error.message ? error.message : error),
                    "a GPU render target could not be read back", {
                        format, width, height, message: String(error) });
            };
            let buffer = null;
            let mapped = false;
            try {
                const resource = textureHandle
                    ? this.resources.get(textureHandle) : null;
                const compressed = !!(resource &&
                    isCompressedFormat(format));
                const indexed = !!(resource && resource.ddIndexed);
                const blockBytes = compressed
                    ? compressedBlockBytes(format) : 0;
                const destinationBpp = indexed ? 1 : d3dBytesPerTexel(format);
                const copiedRows = compressed ? Math.ceil(rowCount / 4)
                    : rowCount;
                const minimumPitch = compressed
                    ? Math.ceil(width / 4) * blockBytes
                    : width * destinationBpp;
                if ((!destinationBpp && !compressed) || !width || !height ||
                        !rowCount ||
                        firstRow >= height || rowCount > height - firstRow ||
                        (compressed && (firstRow & 3)) ||
                        destinationPitch < minimumPitch ||
                        destinationBytes !== copiedRows * destinationPitch ||
                        responseOffset < D9WG_QUERY_REGION_BYTES ||
                        responseOffset + 16 + destinationBytes >
                            D9WG_RESPONSE_REGION_BYTES)
                    throw new Error("invalid readback descriptor");

                /* Submit every deferred draw before encoding the copy. Queue
                 * submissions are ordered, so the following copy observes the
                 * resolved render target without a CPU-side GPU wait. */
                if (this.frame) this.finishFrame(false);
                const state = this.devices.get(deviceHandle);
                let sourceTexture = resource && resource.gpuTexture
                    ? resource.gpuTexture : null;
                if (!textureHandle)
                    sourceTexture = state && this.deviceBackBuffer(state);
                const gpuFormat = resource ? resource.gpuFormat : this.format;
                if (!sourceTexture || !gpuFormat)
                    throw new Error("readback source is unavailable");
                const sourceWidth = resource
                    ? Math.max(1, resource.width >> level) : state.backBufferTextureWidth;
                const sourceHeight = resource
                    ? Math.max(1, resource.height >> level) : state.backBufferTextureHeight;
                if (width !== sourceWidth || height !== sourceHeight)
                    throw new Error("readback dimensions do not match source");

                if (compressed && !String(gpuFormat).startsWith("bc"))
                    throw new Error("compressed readback source is not BC storage");
                if (indexed && gpuFormat !== "r8uint")
                    throw new Error("indexed readback source is not index storage");
                const sourceBpp = indexed ? 1
                    : gpuFormat === "rgba16float" ? 8
                    : gpuFormat === "rg32float" ? 8
                    : gpuFormat === "rgba32float" ? 16 : 4;
                const rawRowBytes = compressed
                    ? Math.ceil(width / 4) * blockBytes : width * sourceBpp;
                const gpuRowPitch = alignUp(rawRowBytes, 256);
                buffer = this.device.createBuffer({
                    label: "D3D9 render-target readback",
                    size: gpuRowPitch * copiedRows,
                    usage: BUFFER_USAGE_COPY_DST | BUFFER_USAGE_MAP_READ,
                });
                const encoder = this.device.createCommandEncoder();
                encoder.copyTextureToBuffer({ texture: sourceTexture,
                    mipLevel: level, origin: { x: 0, y: firstRow, z: face } },
                    { buffer, bytesPerRow: gpuRowPitch,
                        rowsPerImage: copiedRows },
                    { width: blockAlignedCopyExtent(width, compressed),
                        height: blockAlignedCopyExtent(rowCount, compressed),
                        depthOrArrayLayers: 1 });
                this.device.queue.submit([encoder.finish()]);
                ++this.stats.queueSubmits;
                /*
                 * Bounded, because the guest is *spinning* on the response --
                 * it cannot make progress until this resolves, so a map that
                 * never completes freezes the whole VM rather than failing.
                 * That is what a lost or errored device looks like from here:
                 * the submit is accepted, the fence never signals, and the only
                 * symptom is a stall. Losing the race is reported as a failure,
                 * which the guest turns into D3DERR_DRIVERINTERNALERROR
                 * immediately instead of thirty seconds later.
                 */
                let mapTimer = null;
                await Promise.race([
                    buffer.mapAsync(MAP_MODE_READ),
                    new Promise((_, reject) => {
                        mapTimer = setTimeout(() => reject(new Error(
                            "readback map did not complete within " +
                            this.readbackTimeoutMs + "ms; the device is " +
                            "probably lost or an earlier submit was rejected")),
                            this.readbackTimeoutMs);
                    }),
                ]).finally(() => { if (mapTimer !== null) clearTimeout(mapTimer); });
                mapped = true;
                const mappedBytes = new Uint8Array(buffer.getMappedRange());
                const packed = new Uint8Array(destinationBytes);
                if (compressed || indexed) {
                    for (let row = 0; row < copiedRows; ++row)
                        packed.set(mappedBytes.subarray(row * gpuRowPitch,
                            row * gpuRowPitch + rawRowBytes),
                            row * destinationPitch);
                } else {
                    for (let row = 0; row < rowCount; ++row)
                        packGPUReadbackRow(format, gpuFormat, mappedBytes,
                            row * gpuRowPitch, width, packed,
                            row * destinationPitch);
                }
                buffer.unmap();
                mapped = false;
                buffer.destroy();
                buffer = null;
                this.writeReadbackResponse(responseOffset, requestId, packed,
                    D9WG_RESPONSE_OK, metadata);
                ++this.stats.renderTargetReadbacks;
                this.stats.renderTargetReadbackBytes += packed.byteLength;
            } catch (error) {
                if (buffer) {
                    if (mapped) {
                        try { buffer.unmap(); } catch (_) {}
                    }
                    try { buffer.destroy(); } catch (_) {}
                }
                fail(error);
            }
        }

        // A guest polling GetData waits for an answer to every query it
        // ended; when the ops that would have produced one are dropped, the
        // answer is FAILED
        failDroppedQueries(ops) {
            for (const op of ops) {
                if (op.kind !== "query-end") continue;
                ++this.stats.queryFailures;
                this.writeQueryResponse(op.query, op.requestId, 0, D9WG_RESPONSE_FAILED, op.metadata);
            }
        }

        onClear(bytes, view, offset, length) {
            const deviceHandle = view.getUint32(offset + D9WG.F.Clear.device_handle, true);
            const flags = view.getUint32(offset + D9WG.F.Clear.clear_flags, true);
            const color = view.getUint32(offset + D9WG.F.Clear.color, true);
            const depth = view.getFloat32(offset + D9WG.F.Clear.depth, true);
            const stencil = view.getUint32(offset + D9WG.F.Clear.stencil, true);
            const state = this.deviceState(deviceHandle);
            const clearsColor = (flags & D3DCLEAR_TARGET) !== 0;
            // A depth/stencil clear is only meaningful if the device
            // actually has an auto depth-stencil surface.
            const targets = this.renderTargetsFor(state);
            if (!targets) return;
            const clearsDepth = (flags & D3DCLEAR_ZBUFFER) !== 0 && targets.hasDepth;
            const clearsStencil = (flags & D3DCLEAR_STENCIL) !== 0 && targets.hasDepth;
            // A depth clear is what makes a substituted attachment equivalent
            // to the oversized one it stands in for, so it has to be recorded
            // even when the clear does nothing else.
            this.noteSubstituteDepthUse(targets, clearsDepth);
            if (!clearsColor && !clearsDepth && !clearsStencil) return;
            const a = ((color >>> 24) & 0xff) / 255;
            const r = ((color >>> 16) & 0xff) / 255;
            const g = ((color >>> 8) & 0xff) / 255;
            const b = (color & 0xff) / 255;
            const frame = this.ensureFrame();
            // D3D9 clears only inside the viewport, and inside the scissor
            // rect while the scissor test is on (Wine's d3d9 clear_test)
            const scissor = (state.renderStates.get(D3DRS_SCISSORTESTENABLE) || 0) !== 0 ?
                state.scissorRect : null;
            const bounds = intersectRects(state.viewport, scissor, targets.width, targets.height);
            const rectCount = view.getUint32(offset + D9WG.F.Clear.rect_count, true);
            if (24 + rectCount * 16 > length) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG Clear rectangles overrun the command");
            }
            const rects = [];
            const clip = (left, top, right, bottom) => {
                left = Math.max(left, bounds.x);
                top = Math.max(top, bounds.y);
                right = Math.min(right, bounds.x + bounds.width);
                bottom = Math.min(bottom, bounds.y + bounds.height);
                if (right > left && bottom > top) rects.push({ left, top, right, bottom });
            };
            if (!rectCount) clip(0, 0, targets.width, targets.height);
            for (let index = 0; index < rectCount; ++index) {
                const base = offset + D9WG.STRUCTS.Clear.size + index * 16;
                clip(view.getInt32(base, true), view.getInt32(base + 4, true),
                    view.getInt32(base + 8, true), view.getInt32(base + 12, true));
            }
            const whole = rects.length === 1 && rects[0].left === 0 && rects[0].top === 0 &&
                rects[0].right === targets.width && rects[0].bottom === targets.height;
            if (!whole) {
                if (rects.length) {
                    frame.record({ kind: "rect-clear", targets, clearsColor,
                        clearsDepth, clearsStencil, color: { r, g, b, a },
                        depth, stencil, rects });
                    ++this.stats.partialClears;
                }
                return;
            }
            frame.record({
                kind: "clear", targets,
                clearsColor: clearsColor || !!this.debug.forceClearColor,
                clearsDepth, clearsStencil,
                color: this.debug.forceClearColor || { r, g, b, a },
                depth, stencil,
            });
        }

        // Replays every recorded clear/draw op against a freshly-acquired
        // swapchain texture, all synchronously, right before submit -- see
        // the comment on ensureFrame() for why acquisition cannot happen any
        // earlier than this. A "clear" op starts a new render pass (WebGPU
        // has no mid-pass re-clear); a "draw" op opens a loadOp:"load" pass
        // first if none is open yet (a draw with no preceding Clear in this
        // frame means "keep whatever the swapchain texture already has").
        finishFrame(present = true) { return this.frameReplayer.finishFrame(present); }

        // Records and submits one frame's ops (finishFrame's body)
        replayFrame(frame, present, frameValid) { return this.frameReplayer.replayFrame(frame, present, frameValid); }

        // Drops every translated shader, in memory and in storage, so the next
        // draw retranslates from the guest's bytecode. The revision guard in
        // D3D9ShaderCache makes this unnecessary going forward, but a cache
        // written before that guard existed carries no revision to reject it
        // by, and there is no way to age it out other than to throw it away.
        async clearShaderCache() {
            this.shaderCache = new shaderPipeline.D3D9ShaderCache();
            this.moduleCache.clear();
            this.fixedModuleCache.clear();
            ++this.programSerial;
            ++this.uniformSerial;
            this.shaderCacheDirty = false;
            const storage = this.shaderCacheStorage;
            if (storage && typeof storage.save === "function") {
                try {
                    await storage.save(this.shaderCacheStorageKey,
                        { version: 1, revision: shaderPipeline.TRANSLATOR_REVISION,
                          entries: [] });
                } catch (error) {
                    return "cleared in memory; storage write failed: " + error;
                }
            }
            return "shader cache cleared -- reload to retranslate";
        }

        getStats() {
            // The live surface rect is included because it is what positions
            // the overlay canvas, and a wrong rect is invisible in the picture
            // itself: the frame still looks correct, it is just drawn where
            // the guest does not think the window is -- so clicks land on
            // whatever the guest really has at that pixel.
            this.saveActiveSessionState();
            let devicesLive = 0;
            let resourcesLive = 0;
            for (const session of this.sessionStates.values()) {
                devicesLive += session.devices.size;
                resourcesLive += session.resources.size;
            }
            const device = this.presentingDevice ||
                this.devices.values().next().value || null;
            // The fog parameters as this executor decoded them. "Everything
            // is washed out towards one colour" and "fog is not applied at
            // all" look nothing alike in these numbers, and guessing between
            // them from a screenshot has already cost a round.
            let fog = null;
            if (device) {
                const rs = device.renderStates;
                const asFloat = id => {
                    const raw = rs.get(id);
                    if (raw === undefined) return null;
                    FLOAT_BITS_U32[0] = raw >>> 0;
                    return FLOAT_BITS_F32[0];
                };
                const color = rs.get(D3DRS_FOGCOLOR) || 0;
                fog = {
                    enabled: (rs.get(D3DRS_FOGENABLE) || 0) !== 0,
                    tableMode: rs.get(D3DRS_FOGTABLEMODE) || 0,
                    vertexMode: rs.get(D3DRS_FOGVERTEXMODE) || 0,
                    color: "#" + (color & 0xffffff).toString(16).padStart(6, "0"),
                    // These are effective values, including the generated
                    // creation/reset defaults when the game has not changed them.
                    start: asFloat(D3DRS_FOGSTART),
                    end: asFloat(D3DRS_FOGEND),
                    density: asFloat(D3DRS_FOGDENSITY),
                };
            }
            const shaderCache = this.shaderCache.snapshot();
            return { ...this.stats, activeSession: this.sessionKey,
                sessionsLive: this.sessionStates.size,
                devicesLive, resourcesLive,
                pipelinesCached: this.pipelineCache.size,
                bindGroupsCached: this.bindGroupCache.size,
                samplersCached: this.samplerCache.size,
                mrtAttachmentDraws: this.mrtAttachmentDraws.slice(1),
                lastFrame: { ...this.lastFrameStats },
                shaderCache,
                shaderCachePersistentBackend: this.shaderCacheStorageBackend,
                shaderCacheHits: shaderCache.hits,
                shaderCacheMisses: shaderCache.misses,
                shadersCached: shaderCache.cached,
                shaderWGSLBytesCached: shaderCache.totalWGSLBytes,
                shaderCompileLatencyMs: { ...shaderCache.compileLatencyMs },
                occlusionQueries: { mode: "webgpu-query-set",
                    active: this.activeOcclusion ? 1 : 0,
                    perFrameCapacity: 8192,
                    resolved: this.stats.occlusionQueriesResolved },
                surface: device ? { ...device.surface } : null,
                window: this.windowState ? { ...this.windowState } : null,
                fog };
        }

        // Whether the texture bound to a stage is a hardware shadow map: a
        // D3D9 depth-format texture this backend can actually sample. The
        // `view` test is what keeps the multisampled case out -- those are
        // attachment-only and would need a `multisampled: true` layout entry
        // no D3D9 shader can express.
        isDepthSampled(handle) {
            const resource = handle && this.resources.get(handle);
            return !!(resource && resource.isDepth && resource.view);
        }

        // "depth-compare" for a hardware shadow map, "depth-fetch" for the ATI
        // FOURCC formats that hand back the stored value. Both are texture_depth
        // in WGSL and neither is a texture_2d<f32>, but they need different
        // sampler types, so the distinction has to survive all the way into the
        // bind group layout.
        depthSampleModeFor(handle) {
            const resource = handle && this.resources.get(handle);
            if (!resource || !resource.isDepth || !resource.view) return null;
            return resource.depthReadsRaw ? "depth-fetch" : "depth-compare";
        }

        onSetScissorRect(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.SetScissorRect.device_handle, true));
            const left = view.getInt32(offset + D9WG.F.SetScissorRect.left, true);
            const top = view.getInt32(offset + D9WG.F.SetScissorRect.top, true);
            const right = view.getInt32(offset + D9WG.F.SetScissorRect.right, true);
            const bottom = view.getInt32(offset + D9WG.F.SetScissorRect.bottom, true);
            state.scissorRect = { x: Math.max(0, left), y: Math.max(0, top),
                width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
        }

        onSetRenderTarget(bytes, view, offset, length) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.SetRenderTarget.device_handle, true));
            const index = view.getUint32(offset + D9WG.F.SetRenderTarget.target_index, true);
            if (index >= MAX_RENDER_TARGETS) return;
            state.renderTargets[index] = view.getUint32(offset + D9WG.F.SetRenderTarget.color_texture_handle, true);
            state.renderTargetLevels[index] = view.getUint32(offset + D9WG.F.SetRenderTarget.color_level, true);
            // Protocol 1.4 added the cube face. Length-gated so a 1.3 payload
            // still decodes as "face 0", which is what a 2D target always is.
            state.renderTargetFaces[index] = D9WG.has(length, "SetRenderTarget", "color_face")
                ? view.getUint32(offset + D9WG.F.SetRenderTarget.color_face, true) : 0;
            ++this.stats.renderTargetBinds;
        }

        onSetDepthStencilSurfaceLevel(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.SetDepthStencilSurfaceLevel.device_handle, true));
            const handle = view.getUint32(offset + D9WG.F.SetDepthStencilSurfaceLevel.depth_texture_handle, true);
            const level = view.getUint32(offset + D9WG.F.SetDepthStencilSurfaceLevel.depth_level, true);
            this.setDepthStencilSurface(state, handle, level);
        }

        setDepthStencilSurface(state, handle, level) {
            if (handle === D9WG_AUTO_DEPTH_STENCIL_HANDLE) {
                state.depthTargetHandle = 0;
                state.depthTargetLevel = 0;
                state.depthUnbound = false;
                return;
            }
            state.depthTargetHandle = handle;
            state.depthTargetLevel = level;
            state.depthUnbound = handle === 0;
        }

        // Everything a render pass and a pipeline need to agree on about where a
        // draw lands. Resolved per draw rather than cached on the device,
        // because the swap chain's own view does not exist until Present -- a
        // null `view` in slot 0 is the marker finishFrame() substitutes it into.
        //
        // `key` is what groups consecutive ops into one pass: two draws with the
        // same key can share a pass, and a change of key has to end it.
        renderTargetsFor(state) {
            const colors = [];
            const wantsSRGB = (state.renderStates.get(D3DRS_SRGBWRITEENABLE) || 0)
                !== 0;
            let width = state.viewport.width || this.backBufferWidthOf(state);
            let height = state.viewport.height || this.backBufferHeightOf(state);
            let key = "";
            for (let index = 0; index < MAX_RENDER_TARGETS; ++index) {
                const handle = state.renderTargets[index];
                if (!handle) {
                    if (index === 0) {
                        const format = wantsSRGB && this.swapchainSrgbFormat
                            ? this.swapchainSrgbFormat : this.format;
                        // with MSAA the pass renders into the device's
                        // multisampled back buffer and resolves into the
                        // owned one (finishFrame's swapView)
                        this.deviceBackBuffer(state);
                        colors.push({ view: wantsSRGB ? state.backBufferSrgbView : state.backBufferView, format,
                            linearView: state.backBufferView,
                            swapchain: true,
                            sampleCount: state.sampleCount || 1,
                            msaaView: format === this.format ? state.backBufferMsaaView
                                : state.backBufferMsaaSrgbView,
                            msaaOwner: state.backBufferMsaaView ? state : null });
                        width = this.backBufferWidthOf(state);
                        height = this.backBufferHeightOf(state);
                        key += "bb" + this.objectId(state.backBufferTexture) + (format === this.format ? "" : "s") + ";";
                    }
                    continue;
                }
                const resource = this.resources.get(handle);
                if (!resource || !resource.gpuTexture) {
                    // A bound-but-unknown target cannot be substituted with the
                    // back buffer: that would draw a render-to-texture pass
                    // straight onto the screen. Report it and drop the slot.
                    this.warnOnce("rt-unknown-" + index,
                        "a render target slot names a resource the host does " +
                        "not know; draws into it are dropped rather than " +
                        "redirected to the back buffer", { index, handle });
                    if (index === 0) return null;
                    // (the slot keeps its place: attachment N is oC#N)
                    colors.push(null);
                    continue;
                }
                const resourceFormat = resource.gpuFormat ||
                    formatToGPU(resource.format);
                if (!isRenderableGPUFormat(resourceFormat)) {
                    this.warnOnce("rt-non-renderable-" + index,
                        "a render target slot names a texture whose WebGPU " +
                        "format cannot be a render attachment; draws into it " +
                        "are dropped rather than submitting an invalid pass",
                        { index, handle, format: resource.format,
                            gpuFormat: resourceFormat });
                    if (index === 0) return null;
                    colors.push(null);
                    continue;
                }
                const level = state.renderTargetLevels[index] || 0;
                const layerCount = resource.layerCount || 1;
                const face = Math.min(state.renderTargetFaces[index] || 0,
                    layerCount - 1);
                const srgb = wantsSRGB && !!resource.srgbFormat;
                if (wantsSRGB && !resource.srgbFormat)
                    ++this.stats.srgbWriteUnavailable;
                const targetView = this.targetViewFor(resource, level, srgb,
                    face);
                if (face) ++this.stats.cubeFaceTargetBinds;
                this.markTextureSubresourceWritten(resource, level, face);
                // A multisampled target renders into its msaaTexture (one
                // level, one layer) and resolves into the texture D3D reads
                const msaaView = resource.msaaTexture ? this.msaaViewFor(resource, srgb) : null;
                colors.push({ view: targetView,
                    format: srgb ? resource.srgbFormat : resourceFormat,
                    swapchain: false,
                    sampleCount: resource.sampleCount || 1,
                    msaaView,
                    msaaOwner: msaaView ? resource : null,
                    resource });
                if (index === 0) {
                    width = Math.max(1, resource.width >> level);
                    height = Math.max(1, resource.height >> level);
                }
                // The face belongs in the pass key: two faces of one cube are
                // different attachments, and merging their draws into one pass
                // would paint every face with the last one's contents.
                key += handle + "." + level + "." + face +
                    (srgb ? "s" : "") + ";";
            }
            while (colors.length && !colors[colors.length - 1]) colors.pop();
            if (!colors.length) return null;

            // Depth: an explicitly bound surface wins, then the device's auto
            // depth-stencil, and SetDepthStencilSurface(NULL) means neither.
            let depthView = null;
            let depthSamples = 1;
            let depthWidth = 0;
            let depthHeight = 0;
            let substituteDepth = null;
            if (state.depthTargetHandle) {
                const resource = this.resources.get(state.depthTargetHandle);
                const level = state.depthTargetLevel || 0;
                if (resource && resource.gpuTexture &&
                        (resource.usage & D3DUSAGE_DEPTHSTENCIL) !== 0 &&
                        level < resource.levelCount) {
                    // A render attachment view must select exactly one mip.
                    // targetViewFor is deliberately shared with colour render
                    // targets so both subresource paths have identical cache
                    // and descriptor semantics.
                    depthView = this.targetViewFor(resource, level, false);
                    depthSamples = resource.sampleCount || 1;
                    depthWidth = Math.max(1, resource.width >> level);
                    depthHeight = Math.max(1, resource.height >> level);
                    key += "d" + state.depthTargetHandle + "." + level;
                } else {
                    this.warnOnce("depth-target-invalid-" +
                            state.depthTargetHandle + "-" + level,
                        "a depth-stencil binding names an unknown, non-depth, " +
                        "or out-of-range texture level; the pass runs without " +
                        "a depth attachment", {
                            handle: state.depthTargetHandle,
                            level,
                            levelCount: resource ? resource.levelCount : 0,
                        });
                    key += "dinvalid";
                }
            } else if (!state.depthUnbound && state.depthView) {
                depthView = state.depthView;
                depthSamples = state.sampleCount || 1;
                depthWidth = state.depthWidth;
                depthHeight = state.depthHeight;
                key += "dauto";
            } else {
                key += "dnone";
            }
            // WebGPU requires the depth attachment to be exactly the colour
            // target's size. D3D9 requires only that it be *at least* as large,
            // and render-to-texture leans on that constantly: an app keeps one
            // full-screen depth surface and renders half-resolution passes --
            // HDR downsamples, shadow projections, reflections -- against it.
            //
            // Dropping depth for those passes is not a small approximation.
            // Nothing is occluded any more, so every alpha-blended draw that
            // should have been hidden behind geometry paints over it: the image
            // washes out and solid objects turn translucent. A substitute depth
            // texture of the right size preserves the depth *test*, which is
            // what the pass was relying on. What it cannot preserve is depth
            // written by an earlier pass, and an app doing this almost always
            // clears depth on entry anyway -- so this trades a fault that
            // ruins the frame for one that is usually invisible.
            if (depthView && (depthWidth !== width || depthHeight !== height)) {
                ++this.stats.depthTargetSizeMismatches;
                if (depthWidth >= width && depthHeight >= height) {
                    substituteDepth = this.substituteDepthFor(
                        state.depthTargetHandle, width, height);
                    depthView = substituteDepth.view;
                    ++this.stats.depthTargetSubstitutions;
                    // Deliberately not warned about here: the substitution
                    // only loses something if the pass depth-tests against
                    // contents an earlier pass wrote, and a pass that clears
                    // depth on entry has none to lose. noteSubstituteDepthUse()
                    // reports the case that actually does.
                    // The substitute is part of the pass identity: two passes
                    // standing in for different depth surfaces must not merge.
                    key += "dsub" + (state.depthTargetHandle || 0) + "." +
                        width + "x" + height;
                } else {
                    // Smaller than the target: the app is asking to depth-test
                    // fragments the depth buffer has no storage for. There is
                    // nothing to substitute that would be more correct.
                    this.warnOnce("rt-depth-undersized",
                        "the bound depth surface is smaller than the render " +
                        "target, so this pass runs without depth testing " +
                        "rather than being rejected wholesale", {
                            target: width + "x" + height,
                            depth: depthWidth + "x" + depthHeight,
                        });
                    depthView = null;
                    key += "!d";
                }
            }
            // WebGPU requires every attachment of a pass -- and the pipeline
            // drawing into it -- to agree on the sample count. D3D9 makes a
            // disagreeing binding the application's error; slot 0 decides,
            // and a disagreeing slot or depth surface is left out of the pass
            // (and named) rather than making it invalid.
            const sampleCount = colors[0].sampleCount || 1;
            for (let index = 1; index < colors.length; ++index) {
                if (!colors[index] || (colors[index].sampleCount || 1) === sampleCount) continue;
                this.warnOnce("mrt-sample-count",
                    "the render target slots disagree about multisampling; " +
                    "slot 0's sample count is used and the slot is left out", {
                        slot0: sampleCount,
                        slot: index,
                        slotSampleCount: colors[index].sampleCount || 1,
                    });
                colors[index] = null;
                key += "!" + index;
            }
            if (depthView && depthSamples !== sampleCount) {
                this.warnOnce("depth-sample-count",
                    "the depth surface's multisample type differs from the " +
                    "render target's; the pass runs without depth", { depthSamples, sampleCount });
                depthView = null;
                key += "!ds";
            }
            return { key: key + "x" + sampleCount, colors, depthView, width,
                height, substituteDepth,
                hasDepth: !!depthView, sampleCount,
                // Packed RGB/XRGB targets use RGBA storage on WebGPU, but
                // their destination alpha is still logically one for blending.
                opaqueTargetMask: colors.reduce((mask, color, index) => mask |
                    (color && OPAQUE_COLOR_FORMATS.has(color.resource
                        ? color.resource.format : state.backBufferD3DFormat) ? 1 << index : 0), 0),
                formats: colors.map(color => color ? color.format : null) };
        }

        // StretchRect between two host-owned surfaces. A same-size, same-format
        // copy is a real GPU copy; anything that scales or changes format goes
        // through a small blit pipeline, because copyTextureToTexture cannot do
        // either. A source or destination naming the back buffer is refused
        // rather than approximated: the swap chain texture only exists inside
        // finishFrame(), and pretending otherwise would silently copy garbage.
        // ---- StretchRect ----
        //
        // Three cases, in increasing cost:
        //
        //   1. Same size, same format, neither side the back buffer -> a real
        //      copyTextureToTexture. No pass, no shader.
        //   2. Anything else -> a blit: one pass drawing a full-viewport quad
        //      that samples the source. This is what covers scaling, format
        //      conversion, and the back buffer -- whose format
        //      (getPreferredCanvasFormat, normally bgra8unorm) differs from the
        //      rgba8unorm every D3D9 texture becomes, so even a same-size
        //      back-buffer copy cannot be a copy.
        //   3. A compressed destination -> still unsupported and counted. BCn
        //      cannot be a render attachment, so there is nothing to draw into.
        //
        // A blit touching the back buffer has to be *deferred* into the frame op
        // list rather than submitted here, for the same reason draws are: the
        // swap chain texture is only valid inside the task that acquired it (see
        // ensureFrame), and a game's frame arrives across several PCI submits.
        // Doing it eagerly is what produced "the host cannot address this
        // surface" -- the back buffer genuinely has no view yet at this point.
        onStretchRect(bytes, view, offset, length) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.StretchRect.device_handle, true));
            const sourceHandle = view.getUint32(offset + D9WG.F.StretchRect.source_texture_handle, true);
            const sourceLevel = view.getUint32(offset + D9WG.F.StretchRect.source_level, true);
            const sourceRect = {
                left: view.getInt32(offset + D9WG.F.StretchRect.source_left, true),
                top: view.getInt32(offset + D9WG.F.StretchRect.source_top, true),
                right: view.getInt32(offset + D9WG.F.StretchRect.source_right, true),
                bottom: view.getInt32(offset + D9WG.F.StretchRect.source_bottom, true),
            };
            const destinationHandle = view.getUint32(offset + D9WG.F.StretchRect.destination_texture_handle, true);
            const destinationLevel = view.getUint32(offset + D9WG.F.StretchRect.destination_level, true);
            const destinationRect = {
                left: view.getInt32(offset + D9WG.F.StretchRect.destination_left, true),
                top: view.getInt32(offset + D9WG.F.StretchRect.destination_top, true),
                right: view.getInt32(offset + D9WG.F.StretchRect.destination_right, true),
                bottom: view.getInt32(offset + D9WG.F.StretchRect.destination_bottom, true),
            };
            const filterPoint = view.getUint32(offset + D9WG.F.StretchRect.filter_point, true) !== 0;
            // Protocol 1.4. Length-gated: a 1.3 payload has no faces, and a
            // 2D surface is always face 0 anyway.
            const sourceFace = D9WG.has(length, "StretchRect", "source_face")
                ? view.getUint32(offset + D9WG.F.StretchRect.source_face, true) : 0;
            const destinationFace = D9WG.has(length, "StretchRect", "destination_face")
                ? view.getUint32(offset + D9WG.F.StretchRect.destination_face, true) : 0;

            const source = sourceHandle ? this.resources.get(sourceHandle) : null;
            const destination = destinationHandle
                ? this.resources.get(destinationHandle) : null;
            // Handle 0 means the back buffer; a non-zero handle the host does not
            // know is a real error, not a back buffer.
            if ((sourceHandle && !source) || (destinationHandle && !destination) ||
                    (source && !source.gpuTexture) ||
                    (destination && !destination.gpuTexture)) {
                ++this.stats.blitsSkipped;
                this.warnOnce("stretchrect-unknown",
                    "StretchRect names a resource the host does not know; it is " +
                    "skipped rather than copying unrelated memory",
                    { sourceHandle, destinationHandle });
                return;
            }
            const width = sourceRect.right - sourceRect.left;
            const height = sourceRect.bottom - sourceRect.top;
            const destinationWidth = destinationRect.right - destinationRect.left;
            const destinationHeight = destinationRect.bottom - destinationRect.top;
            if (width <= 0 || height <= 0 ||
                    destinationWidth <= 0 || destinationHeight <= 0)
                return;
            if (destination && isCompressedFormat(destination.format)) {
                ++this.stats.blitsSkipped;
                this.warnOnce("stretchrect-compressed-destination",
                    "StretchRect into a block-compressed texture is not " +
                    "implemented: BCn cannot be a render attachment, so there " +
                    "is nothing to draw into, and re-compressing on the CPU " +
                    "would be a different image than the app asked for");
                return;
            }

            const sourceFormat = source ? formatToGPU(source.format) : this.format;
            const destinationFormat = destination
                ? formatToGPU(destination.format) : this.format;
            const scaled = width !== destinationWidth ||
                height !== destinationHeight;
            const swapchainInvolved = !source || !destination;
            if (!swapchainInvolved && !scaled && sourceFormat === destinationFormat) {
                const frame = this.ensureFrame();
                // The face is the copy's z origin: a cube map is a six-layer
                // 2D texture, so "face 3" is layer 3 of one subresource range.
                frame.record({ kind: "copy", writes: this.msaaOwnerOf(destination, state),
                    source: { texture: source.gpuTexture, mipLevel: sourceLevel,
                        origin: { x: sourceRect.left, y: sourceRect.top,
                            z: sourceFace } },
                    destination: { texture: destination.gpuTexture,
                        mipLevel: destinationLevel,
                        origin: { x: destinationRect.left,
                            y: destinationRect.top, z: destinationFace } },
                    size: { width, height, depthOrArrayLayers: 1 } });
                source.frameReferenced = frame.serial;
                destination.frameReferenced = frame.serial;
                this.markTextureSubresourceWritten(destination,
                    destinationLevel, destinationFace);
                ++this.stats.blits;
                return;
            }
            if (destination && !isRenderableGPUFormat(destinationFormat)) {
                ++this.stats.blitsSkipped;
                this.warnOnce("stretchrect-non-renderable-destination",
                    "a scaled or format-converting StretchRect targets a " +
                    "texture whose WebGPU format cannot be a render " +
                    "attachment; only a same-size same-format GPU copy is " +
                    "supported", { destinationHandle,
                        format: destination.format, destinationFormat });
                return;
            }

            // Source UVs are normalised against the *level* being read, not the
            // base level, or a StretchRect from mip 2 samples a quarter of the
            // image it asked for.
            const sourceWidth = source
                ? Math.max(1, source.width >> sourceLevel)
                : this.backBufferWidthOf(state);
            const sourceHeight = source
                ? Math.max(1, source.height >> sourceLevel)
                : this.backBufferHeightOf(state);
            const op = {
                kind: "blit",
                writes: this.msaaOwnerOf(destination, state),
                sourceView: source
                    ? this.blitSourceView(source, sourceLevel, sourceFace) : (this.deviceBackBuffer(state), state.backBufferView),
                destinationView: destination
                    ? this.targetViewFor(destination, destinationLevel, false,
                        destinationFace) : (this.deviceBackBuffer(state), state.backBufferView),
                destinationFormat,
                sourceFormat: source ? (source.gpuFormat ||
                    formatToGPU(source.format)) : this.format,
                sourceRect: [
                    sourceRect.left / sourceWidth, sourceRect.top / sourceHeight,
                    width / sourceWidth, height / sourceHeight,
                ],
                viewport: [destinationRect.left, destinationRect.top,
                    destinationWidth, destinationHeight],
                filterPoint,
            };
            const frame = this.ensureFrame();
            frame.record(op);
            if (source) source.frameReferenced = frame.serial;
            if (destination) destination.frameReferenced = frame.serial;
            this.markTextureSubresourceWritten(destination, destinationLevel,
                destinationFace);
            ++this.stats.blits;
            if (swapchainInvolved) ++this.stats.blitsThroughBackBuffer;
        }

        // Shared with renderTargetsFor(): a render-attachment view of one level.
        // Size-matched stand-in depth attachments, one per distinct size. Kept
        // for the device's lifetime rather than per frame: an app that renders
        // half-resolution passes does it every frame, and the sizes it uses are
        // a handful of fixed values.
        // Keyed by the depth surface being stood in for as well as the size.
        // Sharing one texture across every pass of a given size looked
        // economical and is a correctness bug: two render-to-texture passes at
        // the same resolution but against *different* depth surfaces would
        // depth-test against each other's fragments. Which is exactly the
        // hazard this whole path exists to avoid, arrived at from the other
        // direction. Kept for the device's lifetime because the set of
        // (surface, size) pairs an app uses is small and fixed.
        // A pass is about to depth-test against a stand-in. If nothing cleared
        // it this frame, it is being read for contents the real (larger) depth
        // surface holds and this one never received -- the one case where the
        // substitution actually changes the image.
        noteSubstituteDepthUse(targets, clearsDepth) {
            const record = targets && targets.substituteDepth;
            if (!record) return;
            // ensureFrame(), not this.frame: a Clear is often the first thing
            // in a frame, and reading a not-yet-created frame's serial as 0
            // made the clear and the draw that follows it disagree about which
            // frame they were in -- so every cleared substitute looked stale.
            const serial = this.ensureFrame().serial;
            if (clearsDepth) {
                record.clearedInFrame = serial;
                return;
            }
            if (record.clearedInFrame === serial) return;
            ++this.stats.depthTargetSubstitutionsUncleared;
            this.warnOnce("rt-depth-oversized-uncleared",
                "a pass depth-tests against a depth surface larger than its " +
                "render target -- which D3D9 allows and WebGPU does not -- " +
                "without clearing depth first, so it reads a stand-in that " +
                "never received what an earlier pass wrote into the larger " +
                "surface; geometry that should have been occluded is not", {
                    target: targets.width + "x" + targets.height,
                });
        }

        substituteDepthFor(sourceHandle, width, height) {
            if (!this.substituteDepthViews) this.substituteDepthViews = new Map();
            const size = width + "x" + height;
            const key = (sourceHandle || 0) + ":" + size;
            let record = this.substituteDepthViews.get(key);
            if (record) return record;
            const texture = this.device.createTexture({
                label: "D3D9 substitute depth " + size + " for " +
                    (sourceHandle || "auto"),
                size: { width, height, depthOrArrayLayers: 1 },
                format: DEPTH_FORMAT,
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT,
            });
            // clearedInFrame is what separates the harmless case from the
            // real one: a pass that clears depth on entry loses nothing by
            // getting a fresh texture, and that is what render-to-texture does.
            record = { view: texture.createView(), clearedInFrame: -1 };
            this.substituteDepthViews.set(key, record);
            return record;
        }

        // What a write outside a render pass leaves stale: the multisampled
        // texture behind `destination` (null: the back buffer of `state`)
        msaaOwnerOf(destination, state) {
            if (destination) return destination.msaaTexture ? destination : null;
            return state.backBufferMsaaView ? state : null;
        }

        // A full ColorFill is a clear pass; a partial one is a viewport-limited
        // draw. This keeps the pixels outside the requested RECT intact.
        // A refusal or failure the guest DLL is reporting. This is the only
        // guest-to-host traffic in the protocol that is not a command, and it
        // exists because everything the guest turns down used to be invisible
        // from the page: the browser console sees a clean stream of valid
        // commands, and the guest's own trace file is inside a VM whose
        // filesystem is not reachable from here. The guest deduplicates by
        // exact text, so each distinct message arrives once no matter how many
        // frames it repeats on.
        onGuestLog(bytes, view, offset, length, metadata) {
            const severity = view.getUint32(offset + D9WG.F.GuestLog.severity, true);
            const textBytes = view.getUint32(offset + D9WG.F.GuestLog.text_bytes, true);
            if (8 + textBytes > length) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG guest log text overruns the command");
            }
            let text = "";
            for (let index = 0; index < textBytes; ++index)
                text += String.fromCharCode(bytes[offset + D9WG.STRUCTS.GuestLog.size + index]);
            ++this.stats.guestReports;
            (this.guestReports || (this.guestReports = [])).push(text);
            // A state restore replays the graphics journal, and with it every
            // report since the guest started: one "proxy build ... loaded" per
            // process that ever loaded the DLL. They were printed when the
            // guest sent them; the console shows what happens now.
            if (metadata && metadata.replay) return;
            // Severity picks the console channel only. The identification
            // line the guest sends at startup is info: its job is to make a
            // later silence mean "nothing was refused" rather than "the DLL in
            // the disk image is too old to say anything".
            const report = severity === GUEST_LOG_SEVERITY_FAILED
                ? console.error
                : (severity === GUEST_LOG_SEVERITY_INFO
                    ? console.log : console.warn);
            report.call(console, "[d3d9-guest] " + text);
        }

        onColorFill(bytes, view, offset, length) {
            const resource = this.resources.get(view.getUint32(offset + D9WG.F.ColorFill.texture_handle, true));
            const level = view.getUint32(offset + D9WG.F.ColorFill.level, true);
            const color = view.getUint32(offset + D9WG.F.ColorFill.color, true);
            const face = D9WG.has(length, "ColorFill", "face") ? view.getUint32(offset + D9WG.F.ColorFill.face, true) : 0;
            // The question is whether this texture can be an attachment, not
            // whether D3D9 called it a render target. An offscreen plain
            // surface in D3DPOOL_DEFAULT carries no D3DUSAGE_RENDERTARGET and
            // ColorFill is nevertheless defined on it -- that is most of what
            // the call exists for -- and the GPU texture behind it is
            // attachable all the same.
            const attachable = resource && resource.textureDescriptor &&
                (resource.textureDescriptor.usage &
                    TEXTURE_USAGE_RENDER_ATTACHMENT) !== 0;
            if (!resource || !resource.gpuTexture || !attachable) {
                ++this.stats.blitsSkipped;
                this.warnOnce("colorfill-not-attachable",
                    "ColorFill on a surface whose WebGPU texture cannot be a " +
                    "render attachment is skipped: WebGPU can only clear an " +
                    "attachment, and faking it with an upload would need a CPU " +
                    "mirror this path deliberately does not keep for GPU-only " +
                    "content", { format: resource ? resource.format : 0 });
                return;
            }
            // Shares targetViewFor's cache and its single-layer descriptor.
            // Building a view here by hand left the array layers unbounded,
            // which on a cube map is a six-layer view where the pass wants one.
            const targetView = this.targetViewFor(resource, level, false,
                Math.min(face, (resource.layerCount || 1) - 1));
            const left = view.getInt32(offset + D9WG.F.ColorFill.left, true);
            const top = view.getInt32(offset + D9WG.F.ColorFill.top, true);
            const right = view.getInt32(offset + D9WG.F.ColorFill.right, true);
            const bottom = view.getInt32(offset + D9WG.F.ColorFill.bottom, true);
            const fullWidth = Math.max(1, resource.width >> level);
            const fullHeight = Math.max(1, resource.height >> level);
            const clippedLeft = Math.max(0, Math.min(fullWidth, left));
            const clippedTop = Math.max(0, Math.min(fullHeight, top));
            const clippedRight = Math.max(clippedLeft,
                Math.min(fullWidth, right));
            const clippedBottom = Math.max(clippedTop,
                Math.min(fullHeight, bottom));
            if (clippedRight === clippedLeft || clippedBottom === clippedTop)
                return;
            const rgba = [((color >>> 16) & 0xff) / 255,
                ((color >>> 8) & 0xff) / 255, (color & 0xff) / 255,
                resource.format === formats.D3DFMT_X8R8G8B8 || resource.format === formats.D3DFMT_X1R5G5B5 ||
                    resource.format === formats.D3DFMT_X4R4G4B4 || resource.format === formats.D3DFMT_X8B8G8R8 ||
                    resource.format === formats.D3DFMT_R5G6B5 || resource.format === formats.D3DFMT_R8G8B8
                    ? 1 : ((color >>> 24) & 0xff) / 255];
            const isFull = clippedLeft === 0 && clippedTop === 0 &&
                clippedRight === fullWidth && clippedBottom === fullHeight;
            const frame = this.ensureFrame();
            frame.record({ kind: "color-fill", targetView,
                writes: resource.msaaTexture ? resource : null,
                format: formatToGPU(resource.format), rgba, isFull,
                left: clippedLeft, top: clippedTop,
                right: clippedRight, bottom: clippedBottom });
            this.markTextureSubresourceWritten(resource, level, face);
            resource.frameReferenced = frame.serial;
            ++this.stats.colorFills;
        }

        decodeVertexElements(bytes, view, offset, count) {
            const elements = [];
            for (let i = 0; i < count; ++i) {
                const base = offset + i * 8;
                elements.push({
                    stream: view.getUint16(base, true),
                    byteOffset: view.getUint16(base + 2, true),
                    type: view.getUint8(base + 4),
                    method: view.getUint8(base + 5),
                    usage: view.getUint8(base + 6),
                    usageIndex: view.getUint8(base + 7),
                });
            }
            return elements;
        }

        // What the fixed-function vertex stage needs to know about a decoded
        // D9WGVertexElement array. Returns null when the declaration carries
        // no position at all, which is the one thing the fixed-function stage
        // cannot work around.
        fixedFunctionVertexSignature(elements) {
            let positionType = null;
            let hasColor = false;
            let colorIsBGRA = false;
            let hasColor1 = false;
            let color1IsBGRA = false;
            let hasNormal = false;
            let hasPointSize = false;
            let blendWeightType = -1;
            let blendIndicesType = -1;
            let position2Type = -1, normal2Type = -1;
            const texCoordSets = [], texCoordDimensions = {};
            let inputConversions = null;
            for (const element of elements) {
                const location = fixedFunctionLocationFor(element);
                const conversion = shaderPipeline.vertexInputConversion(element.type);
                // COLOR keeps its existing per-color swizzle. Blend inputs have
                // their own palette/index rules and are not mapped without a plan.
                if (location >= 0 && conversion &&
                        !(conversion === "color" && element.usage === DECLUSAGE_COLOR)) {
                    if (!inputConversions) inputConversions = {};
                    inputConversions[location] = conversion;
                }
                if (element.usage === DECLUSAGE_BLENDWEIGHT &&
                        element.usageIndex === 0)
                    blendWeightType = element.type;
                else if (element.usage === DECLUSAGE_BLENDINDICES &&
                        element.usageIndex === 0)
                    blendIndicesType = element.type;
                if (element.usage === DECLUSAGE_POSITION && element.usageIndex === 1)
                    position2Type = element.type;
                if (element.usage === DECLUSAGE_NORMAL && element.usageIndex === 1)
                    normal2Type = element.type;
                if (element.usage === DECLUSAGE_POSITION && element.usageIndex === 0)
                    positionType = "world";
                else if (element.usage === DECLUSAGE_POSITIONT && element.usageIndex === 0)
                    positionType = "screen";
                else if (element.usage === DECLUSAGE_COLOR && element.usageIndex === 0) {
                    hasColor = true;
                    // Only a D3DCOLOR-typed diffuse arrives byte-swapped; a
                    // declaration is free to use FLOAT4 instead, and swizzling
                    // that would rotate the channels for no reason.
                    colorIsBGRA = element.type === DECLTYPE_D3DCOLOR;
                } else if (element.usage === DECLUSAGE_COLOR && element.usageIndex === 1) {
                    hasColor1 = true;
                    color1IsBGRA = element.type === DECLTYPE_D3DCOLOR;
                } else if (element.usage === DECLUSAGE_NORMAL && element.usageIndex === 0)
                    hasNormal = true;
                else if (element.usage === DECLUSAGE_PSIZE && element.usageIndex === 0)
                    hasPointSize = true;
                else if (element.usage === DECLUSAGE_TEXCOORD &&
                        element.usageIndex < MAX_TEXCOORD_SETS &&
                        !texCoordSets.includes(element.usageIndex)) {
                    texCoordSets.push(element.usageIndex);
                    texCoordDimensions[element.usageIndex] = [1, 2, 3, 4, 4, 4, 2, 4, 4, 2, 4, 2, 4, 3, 3, 2, 4][element.type] || 4;
                }
            }
            if (!positionType) return null;
            texCoordSets.sort((a, b) => a - b);
            // The blend element *types* travel with the signature because the
            // WGSL input for BLENDINDICES has to be declared with the base type
            // of whatever WebGPU format the declaration's D3DDECLTYPE maps to;
            // whether they are read at all is a render-state question that
            // vertexBlendPlan() answers once the state is in hand.
            return { positionType, hasColor, colorIsBGRA, hasColor1,
                color1IsBGRA, hasNormal, hasPointSize, texCoordSets, texCoordDimensions,
                blendWeightType, blendIndicesType, position2Type, normal2Type,
                ...(inputConversions ? { inputConversions } : null),
                hasTexCoord: texCoordSets.length > 0 };
        }

        // Resolves D3DRS_VERTEXBLEND plus D3DRS_INDEXEDVERTEXBLENDENABLE
        // against what the declaration actually carries. Returns null when the
        // draw is not blended, which is the overwhelmingly common case -- and
        // is *correct* for a declaration that carries blend data while the
        // render state is DISABLE, since D3D9 ignores the data too and poses
        // every vertex by D3DTS_WORLD alone.
        vertexBlendPlan(state, signature) {
            const rs = state.renderStates;
            const mode = rs.get(D3DRS_VERTEXBLEND) || D3DVBF_DISABLE;
            if (mode === D3DVBF_DISABLE) return null;
            // Pre-transformed vertices skip the whole transform pipeline, so
            // there is nothing for a world matrix to pose.
            if (signature.positionType === "screen") return null;
            if (mode === D3DVBF_TWEENING) {
                const hasPosition2 = signature.position2Type >= 0;
                const hasNormal2 = signature.normal2Type >= 0;
                if (!hasPosition2 && !hasNormal2)
                    throw new Error("D3DVBF_TWEENING requires POSITION1 or NORMAL1");
                const conversions = { ...signature.inputConversions };
                if (hasPosition2) {
                    const conversion = shaderPipeline.vertexInputConversion(signature.position2Type);
                    if (conversion) conversions[FF_LOCATION_BLENDWEIGHT] = conversion;
                }
                if (hasNormal2) {
                    const conversion = shaderPipeline.vertexInputConversion(signature.normal2Type);
                    if (conversion) conversions[FF_LOCATION_BLENDINDICES] = conversion;
                }
                signature.inputConversions = conversions;
                // Tween and weighted matrix blending are mutually exclusive;
                // reuse their two attribute locations and one world matrix.
                return { tween: true, hasPosition2, hasNormal2, matrixCount: 1,
                    matrixSlots: 1, weightCount: 0, indexed: false };
            }
            const indexed = (rs.get(D3DRS_INDEXEDVERTEXBLENDENABLE) || 0) !== 0;
            // 1/2/3WEIGHTS carry that many weights and one more matrix;
            // 0WEIGHTS is one matrix at full weight.
            const matrixCount = mode === D3DVBF_0WEIGHTS ? 1 : mode + 1;
            if (matrixCount < 1 || matrixCount > MAX_BLEND_MATRICES) {
                this.warnOnce("ff-vertex-blend-mode-" + mode,
                    "unsupported D3DRS_VERTEXBLEND value " + mode +
                    "; the draw is posed by world matrix 0 alone");
                return null;
            }
            const weightCount = matrixCount - 1;
            // Without weights there is nothing to distribute, and without
            // indices an indexed blend has no palette entry to look up. Either
            // way the declaration and the render state disagree; D3D9's result
            // would be undefined, so fall back to the unblended path and say so
            // rather than invent one.
            if (weightCount && signature.blendWeightType < 0) {
                this.warnOnce("ff-vertex-blend-no-weights",
                    "D3DRS_VERTEXBLEND asks for " + weightCount + " weight(s) " +
                    "but the declaration has no BLENDWEIGHT; the draw is posed " +
                    "by world matrix 0 alone");
                return null;
            }
            // Weights are read as vec4<f32>, so a BLENDWEIGHT declared with an
            // integer or packed D3DDECLTYPE would put a format the shader
            // cannot receive into the vertex layout -- a pipeline the driver
            // rejects, which costs the whole draw rather than the blend.
            if (weightCount && declTypeInputScalar(signature.blendWeightType)
                    !== "f32") {
                this.warnOnce("ff-blend-weight-type-" + signature.blendWeightType,
                    "BLENDWEIGHT uses D3DDECLTYPE " + signature.blendWeightType +
                    ", which is not a float format; the draw is posed by world " +
                    "matrix 0 alone");
                return null;
            }
            let indexScalar = "u32";
            let indexNormalized = false;
            if (indexed) {
                if (signature.blendIndicesType < 0) {
                    this.warnOnce("ff-vertex-blend-no-indices",
                        "D3DRS_INDEXEDVERTEXBLENDENABLE is set but the " +
                        "declaration has no BLENDINDICES; the draw is posed by " +
                        "world matrix 0 alone");
                    return null;
                }
                indexScalar = declTypeInputScalar(signature.blendIndicesType);
                // D3DCOLOR and UBYTE4N both map to unorm8x4, so the shader
                // receives each index byte divided by 255 rather than the byte.
                // D3DFVF_LASTBETA_D3DCOLOR is the FVF spelling of exactly that,
                // so this is a path real content takes, not a curiosity.
                indexNormalized = signature.blendIndicesType === DECLTYPE_D3DCOLOR
                    || signature.blendIndicesType === 8;
                if (!indexScalar) {
                    this.warnOnce("ff-blend-indices-type-" +
                            signature.blendIndicesType,
                        "BLENDINDICES uses D3DDECLTYPE " +
                        signature.blendIndicesType + ", which packs into a " +
                        "single uint32 rather than four components; the draw " +
                        "is posed by world matrix 0 alone");
                    return null;
                }
            }
            // How many matrices the uniform block carries. A non-indexed blend
            // reads WORLDMATRIX(0..matrixCount-1) in order, so that is all it
            // needs. An indexed one can name any palette entry, and the palette
            // is bucketed rather than sized exactly so that setting one more
            // bone does not mint a new shader and a new pipeline; see
            // blendPaletteSize.
            const matrixSlots = indexed
                ? blendPaletteSize(state.maxWorldMatrixIndex) : matrixCount;
            ++this.stats.blendedDraws;
            return { matrixCount, weightCount, indexed, indexScalar,
                indexNormalized, matrixSlots };
        }

        // ---- fixed-function state signatures (M3) ----
        //
        // Reads the texture-stage state the guest has been sending since M1 and
        // turns it into the shape buildFixedFunctionPixelShader() consumes. Both
        // the WGSL and the pipeline cache key derive from this one object, so a
        // state that changes rendering always changes the key.
        //
        // `coordVaryingFor` maps a stage to the varying that carries its
        // coordinates. With a fixed-function vertex stage that is the stage index
        // itself (the vertex stage already resolved TEXCOORDINDEX and the
        // transform); with a translated vertex shader the varyings are whatever
        // the shader wrote per semantic, so the stage's TEXCOORDINDEX selects
        // among them here instead.
        textureCascadeSignature(state, options) {
            const stageState = (stage, id, fallback) => {
                const value = state.textureStageStates.get(stage * 64 + id);
                return value === undefined ? fallback : value;
            };
            const samplerState = (stage, id, fallback) => {
                const value = state.samplerStates.get(stage * 64 + id);
                return value === undefined ? fallback : value;
            };
            const stages = [];
            const textureColorKeyEnabled =
                (state.renderStates.get(D3DRS_COLORKEYENABLE) || 0) !== 0 ||
                (state.renderStates.get(D3DRS_COLORKEYBLENDENABLE) || 0) !== 0;
            let usesTextureFactor = false;
            let usesSpecular = false;
            const unsupported = [];
            for (let index = 0; index < MAX_TEXTURE_STAGES; ++index) {
                // D3D9 defaults: stage 0 modulates its texture with the running
                // colour (which at stage 0 *is* the diffuse colour), every later
                // stage is disabled. The first disabled stage ends the cascade.
                const colorOp = stageState(index, D3DTSS_COLOROP,
                    index === 0 ? D3DTOP_MODULATE : D3DTOP_DISABLE);
                if (colorOp === D3DTOP_DISABLE) break;
                const alphaOp = stageState(index, D3DTSS_ALPHAOP,
                    index === 0 ? D3DTOP_SELECTARG1 : D3DTOP_DISABLE);
                const stage = {
                    index,
                    colorOp,
                    colorArg0: stageState(index, D3DTSS_COLORARG0, D3DTA_CURRENT),
                    colorArg1: stageState(index, D3DTSS_COLORARG1, D3DTA_TEXTURE),
                    colorArg2: stageState(index, D3DTSS_COLORARG2, D3DTA_CURRENT),
                    alphaOp,
                    alphaArg0: stageState(index, D3DTSS_ALPHAARG0, D3DTA_CURRENT),
                    alphaArg1: stageState(index, D3DTSS_ALPHAARG1, D3DTA_TEXTURE),
                    alphaArg2: stageState(index, D3DTSS_ALPHAARG2, D3DTA_CURRENT),
                    resultArg: stageState(index, D3DTSS_RESULTARG, D3DTA_CURRENT),
                    usesConstant: false,
                    samplesTexture: false,
                    textureType: "2d",
                    transformCount: 0,
                    projected: false,
                    addressU: samplerState(index, D3DSAMP_ADDRESSU, 1),
                    addressV: samplerState(index, D3DSAMP_ADDRESSV, 1),
                    addressW: samplerState(index, D3DSAMP_ADDRESSW, 1),
                    borderColor: samplerState(index, D3DSAMP_BORDERCOLOR, 0),
                };
                // Which arguments a stage reads decides what has to be declared
                // and uploaded for it. Getting this wrong in either direction is
                // a hard failure rather than a shading difference: a texture
                // referenced but not declared is invalid WGSL, and a uniform
                // field referenced but not in the layout reads garbage.
                // Only MULTIPLYADD and LERP read arg0, so including it
                // unconditionally would declare textures and upload constants a
                // stage never touches -- and, worse, would leave the app's stale
                // arg0 deciding what gets bound.
                const texture = this.resources.get(state.textures.get(index));
                const usable = texture && !texture.isDepth;
                for (const channel of ["color", "alpha"]) {
                    const normalized = ffp.normalizeTextureOperation(stage[channel + "Op"],
                        [0, 1, 2].map(argument => stage[channel + "Arg" + argument]), !!usable);
                    stage[channel + "Op"] = normalized.op;
                    normalized.args.forEach((argument, i) => { stage[channel + "Arg" + i] = argument; });
                }
                // DOT3 writes all four channels; a stale alpha operation and
                // its arguments neither sample a texture nor affect the key.
                if (stage.colorOp === D3DTOP_DOTPRODUCT3) {
                    stage.alphaOp = D3DTOP_DISABLE;
                    stage.alphaArg0 = stage.alphaArg1 = stage.alphaArg2 = D3DTA_CURRENT;
                }
                const argumentsUsed = [
                    ...ffp.textureOpArguments(stage.colorOp).map(i => stage["colorArg" + i]),
                    ...ffp.textureOpArguments(stage.alphaOp).map(i => stage["alphaArg" + i]),
                ];
                const opsUsed = [stage.colorOp];
                if (stage.alphaOp !== D3DTOP_DISABLE) opsUsed.push(stage.alphaOp);
                // Support is per *channel*, not per operation: the
                // MODULATE*_ADD* family is colour-only by definition, so
                // probing it as f32 would report every legitimate use as
                // unsupported.
                const opChannels = [{ op: stage.colorOp, type: "vec3<f32>" }];
                if (stage.alphaOp !== D3DTOP_DISABLE)
                    opChannels.push({ op: stage.alphaOp, type: "f32" });
                for (const argument of argumentsUsed) {
                    switch (argument & D3DTA_SELECTMASK) {
                    case D3DTA_TEXTURE: stage.samplesTexture = true; break;
                    case D3DTA_TFACTOR: usesTextureFactor = true; break;
                    case D3DTA_CONSTANT: stage.usesConstant = true; break;
                    case D3DTA_SPECULAR: usesSpecular = true; break;
                    default: break;
                    }
                }
                // These operations read a channel of something the arguments
                // never name, so they pull in their own dependency.
                if (opsUsed.includes(D3DTOP_BLENDTEXTUREALPHA) ||
                        opsUsed.includes(D3DTOP_BLENDTEXTUREALPHAPM) ||
                        stage.colorOp === D3DTOP_DOTPRODUCT3)
                    stage.samplesTexture = stage.samplesTexture ||
                        opsUsed.includes(D3DTOP_BLENDTEXTUREALPHA) ||
                        opsUsed.includes(D3DTOP_BLENDTEXTUREALPHAPM);
                if (opsUsed.includes(D3DTOP_BLENDFACTORALPHA))
                    usesTextureFactor = true;
                stage.samplesTexture ||= ffp.textureOpReadsTexture(stage.colorOp, []) ||
                    ffp.textureOpReadsTexture(stage.alphaOp, []);
                if (stage.samplesTexture) {
                    // A depth texture counts as nothing bound here. The fixed
                    // function cascade has no comparison reference to offer, so
                    // it takes the white fallback and viewForStage() reports
                    // why -- rather than reaching a float layout entry with a
                    // depth view, which is invalid rather than merely wrong.
                    stage.textureType = usable ? (texture.textureType || "2d") : "2d";
                    stage.hasTextureBound = !!usable;
                    stage.sampleSwizzle = usable ? samplingSwizzle(texture.format) : "";
                    // DirectDraw stores four independent key kinds. Texture
                    // rendering uses SRCBLT (kind 0), the same source-domain
                    // key used by a keyed blit.  Keep the widened integer
                    // endpoints in the immutable shader signature so changing
                    // the surface key cannot reuse stale WGSL.
                    const key = usable && textureColorKeyEnabled &&
                        texture.ddColorKey && texture.ddColorKey[0];
                    stage.colorKey = key ? {
                        low: key.low >>> 0,
                        high: key.high >>> 0,
                        indexed: !!texture.ddIndexed,
                    } : null;
                }
                const transformFlags =
                    stageState(index, D3DTSS_TEXTURETRANSFORMFLAGS, 0);
                stage.transformCount = transformFlags & 0xFF;
                stage.projected = (transformFlags & D3DTTFF_PROJECTED) !== 0;
                const coordIndex = stageState(index, D3DTSS_TEXCOORDINDEX, index);
                stage.texCoordIndex = coordIndex & 0xFFFF;
                stage.tciMode = coordIndex & D3DTSS_TCI_MASK;
                for (const { op, type } of opChannels) {
                    if (op === D3DTOP_DISABLE) continue;
                    if (textureOpExpression(op, type, ["0.0", "0.0", "0.0"],
                            "0.0") === null)
                        unsupported.push("stage " + index + " asks for " +
                            "D3DTEXTUREOP " + op + " on the " +
                            (type === "f32" ? "alpha" : "colour") + " channel, " +
                            "which is outside the set fill_caps() advertises " +
                            "in TextureOpCaps");
                }
                stages.push(stage);
            }
            // D3DTOP_BUMPENVMAP couples two adjacent stages: the one that
            // declares it samples the (du, dv) map, and the one after it is
            // what actually gets displaced. Resolving that here keeps the
            // shader builder from having to look at its neighbours.
            for (let index = 0; index + 1 < stages.length; ++index) {
                const producer = stages[index];
                const consumer = stages[index + 1];
                if (producer.colorOp !== D3DTOP_BUMPENVMAP &&
                        producer.colorOp !== D3DTOP_BUMPENVMAPLUMINANCE)
                    continue;
                // The bump stage has to sample its own map for there to be a
                // displacement at all, whatever its arguments named.
                producer.samplesTexture = true;
                producer.isBumpSource = true;
                consumer.bumpFrom = producer.index;
                if (producer.colorOp === D3DTOP_BUMPENVMAPLUMINANCE)
                    consumer.bumpLuminanceFrom = producer.index;
            }
            {
                // A trailing BUMPENVMAP with no stage after it displaces
                // nothing. Say so rather than rendering a silently unbumped
                // frame that looks almost right.
                const last = stages[stages.length - 1];
                if (last && (last.colorOp === D3DTOP_BUMPENVMAP ||
                        last.colorOp === D3DTOP_BUMPENVMAPLUMINANCE))
                    unsupported.push("stage " + last.index + " asks for " +
                        "D3DTOP_BUMPENVMAP but is the last active stage, so " +
                        "no stage samples the perturbed coordinate");
            }
            // With a translated vertex shader the fixed-function coordinate
            // generation and transform never ran, so the stage reads a varying
            // the shader wrote directly, untransformed.
            //
            // *Which* varying is the open question. This reads the one
            // D3DTSS_TEXCOORDINDEX names, but D3D9 documents the opposite:
            // "When rendering using vertex shaders, each texture stage's
            // texture coordinate index must be set to its default value. The
            // default index for each stage is equal to the stage index." --
            // i.e. stage n takes oTn and TEXCOORDINDEX does not participate.
            // An app that leaves a stale non-default index (from an earlier
            // environment-mapped pass, say) therefore sends this code to a
            // varying the shader never wrote, which reads as a constant and
            // samples one texel across the whole model.
            //
            // The documented rule is the default. The diagnostic toggle can
            // still restore the legacy TEXCOORDINDEX routing when comparing a
            // capture against an older executor build.
            if (!options.fixedVertexStage) {
                for (const stage of stages) {
                    stage.coordVarying = this.debug.texcoordFromStageIndex
                        ? Math.min(stage.index, MAX_TEXCOORD_SETS - 1)
                        : Math.min(stage.texCoordIndex, MAX_TEXCOORD_SETS - 1);
                    if (stage.tciMode !== D3DTSS_TCI_PASSTHRU ||
                            stage.transformCount) {
                        unsupported.push("stage " + stage.index + " asks for " +
                            "fixed-function coordinate generation/transform " +
                            "while a vertex shader is bound, which D3D9 does " +
                            "not apply either");
                        stage.transformCount = 0;
                        stage.projected = false;
                    }
                }
            } else {
                for (const stage of stages) stage.coordVarying = stage.index;
            }
            return { stages, usesTextureFactor, usesSpecular, unsupported };
        }

        // Reads D3DRS_LIGHTING and the material/light state into the shape
        // buildFixedFunctionVertexShader() consumes, or null when the draw is
        // not lit. Each enabled light's *type* is baked into the signature so
        // the generated WGSL is a straight-line unroll with no branching and no
        // dynamic light count.
        lightingSignature(state, vertexSignature) {
            const rs = state.renderStates;
            const get = (id, fallback) => {
                const value = rs.get(id);
                return value === undefined ? fallback : value;
            };
            // Pre-transformed (XYZRHW) vertices are already lit by definition,
            // which is why D3D9 ignores lighting for them.
            if (get(D3DRS_LIGHTING, 1) === 0 ||
                    vertexSignature.positionType === "screen")
                return null;
            // D3D9 treats a missing NORMAL as the zero vector. Direct/specular
            // light terms therefore vanish, but global ambient and material
            // emissive still contribute. Do not drop the whole lighting path:
            // GTA San Andreas submits some RenderWare character batches this
            // way with a black vertex colour and a non-zero ambient material.
            // Passing that colour through unchanged makes the character a black
            // silhouette even though the scene's ambient state should light it.
            if (!vertexSignature.hasNormal) {
                ++this.stats.drawsWithZeroNormalLighting;
            }
            const lights = [];
            for (const [index, enabled] of state.lightEnabled) {
                if (!enabled) continue;
                const light = state.lights.get(index);
                if (!light) continue;
                if (lights.length >= MAX_LIGHTS) break;
                lights.push({ index, type: light.type });
            }
            // Sorted so two draws with the same set of enabled lights produce
            // the same key regardless of the order LightEnable arrived in.
            lights.sort((a, b) => a.index - b.index);
            const colorVertex = get(D3DRS_COLORVERTEX, 1) !== 0;
            return {
                lights,
                colorVertex,
                specularEnable: get(D3DRS_SPECULARENABLE, 0) !== 0,
                localViewer: get(D3DRS_LOCALVIEWER, 1) !== 0,
                diffuseSource: get(D3DRS_DIFFUSEMATERIALSOURCE, D3DMCS_COLOR1),
                ambientSource: get(D3DRS_AMBIENTMATERIALSOURCE, D3DMCS_MATERIAL),
                specularSource: get(D3DRS_SPECULARMATERIALSOURCE, D3DMCS_COLOR2),
                emissiveSource: get(D3DRS_EMISSIVEMATERIALSOURCE, D3DMCS_MATERIAL),
            };
        }

        // Turns a declaration plus the currently bound streams into the
        // GPUVertexBufferLayout array a pipeline needs, using `locationFor` to
        // decide which shader input (if any) each element feeds. One function
        // serves both stages: the fixed-function stage passes its semantic
        // table, a translated shader passes a lookup over its own dcl'd
        // inputs. Elements no shader input consumes are simply left out --
        // they still occupy bytes in the vertex, but the stride comes from
        // SetStreamSource, never from summing the elements.
        // (0, 0, 0, 1): what a vertex shader input no stream supplies reads
        defaultAttributeBuffer() {
            if (!this.defaultAttributes) {
                this.defaultAttributes = this.device.createBuffer({ size: 16,
                    usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST });
                this.device.queue.writeBuffer(this.defaultAttributes, 0, new Float32Array([0, 0, 0, 1]));
            }
            return this.defaultAttributes;
        }

        vertexBufferLayoutsFor(elements, state, locationFor, instanceData) {
            const perStream = new Map();
            for (const element of elements) {
                const location = locationFor(element);
                if (location < 0) continue;
                const format = DECLTYPE_FORMATS[element.type];
                if (!format) {
                    this.warnOnce("decltype-" + element.type,
                        "unsupported D3DDECLTYPE " + element.type +
                        "; the attribute is dropped from the vertex layout");
                    continue;
                }
                const stream = state.streams.get(element.stream);
                if (!stream || (!stream.bufferHandle && !stream.userPointer)) continue;
                let entry = perStream.get(element.stream);
                if (!entry) {
                    const frequency = (stream.frequency ?? 1) >>> 0;
                    const instanced =
                        (frequency & D3DSTREAMSOURCE_INSTANCEDATA) !== 0;
                    entry = { stream: element.stream, arrayStride: stream.stride,
                        stepMode: instanceData || instanced ? "instance" : "vertex",
                        attributes: [] };
                    perStream.set(element.stream, entry);
                }
                entry.attributes.push({ shaderLocation: location,
                    offset: element.byteOffset, format: format[0] });
            }
            // Sorted so the slot a buffer binds to is a stable function of the
            // declaration, which keeps the pipeline cache key stable too.
            const layouts = Array.from(perStream.values())
                .sort((a, b) => a.stream - b.stream);
            if (layouts.length > MAX_VERTEX_BUFFERS_PER_DRAW) {
                // Truncating here would drop whole attributes and render
                // wrong-but-plausible geometry, which is the failure mode
                // hardest to attribute. Name it instead.
                this.warnOnce("vertex-buffer-limit",
                    "this declaration spreads its attributes over " +
                    layouts.length + " streams, and WebGPU binds at most " +
                    MAX_VERTEX_BUFFERS_PER_DRAW + " vertex buffers per draw; " +
                    "the draw is skipped rather than drawn with missing " +
                    "attributes");
                return null;
            }
            for (const layout of layouts)
                layout.attributes.sort((a, b) => a.shaderLocation - b.shaderLocation);
            return layouts;
        }

        onSetVertexDeclaration(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.SetVertexDeclaration.device_handle, true);
            const declarationHandle = view.getUint32(offset + D9WG.F.SetVertexDeclaration.declaration_handle, true);
            const state = this.deviceState(deviceHandle);
            state.vertexDeclarationHandle = declarationHandle;
            state.fvfElements = null;
        }

        onSetFVF(bytes, view, offset, length) {
            const deviceHandle = view.getUint32(offset + D9WG.F.SetFVF.device_handle, true);
            const count = view.getUint32(offset + D9WG.F.SetFVF.element_count, true);
            const state = this.deviceState(deviceHandle);
            state.fvfElements = this.decodeVertexElements(bytes, view, offset + D9WG.STRUCTS.SetFVF.size, count);
            // Kept only so a diagnostic can say which FVF produced a
            // declaration; nothing in the render path reads it, because the
            // guest already expanded it into the element shape above.
            state.fvf = view.getUint32(offset + D9WG.F.SetFVF.fvf, true);
            state.vertexDeclarationHandle = 0;
        }

        // The declaration in force, whether it arrived as a real
        // IDirect3DVertexDeclaration9 or as an FVF the guest expanded into the
        // same element shape (plan 4.3 -- the host has exactly one
        // vertex-layout code path).
        currentElements(state) {
            if (state.fvfElements) return state.fvfElements;
            const declaration = this.resources.get(state.vertexDeclarationHandle);
            return declaration ? declaration.elements : null;
        }

        onSetRenderState(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.SetRenderState.device_handle, true);
            const stateId = view.getUint32(offset + D9WG.F.SetRenderState.state, true);
            const value = view.getUint32(offset + D9WG.F.SetRenderState.value, true);
            this.deviceState(deviceHandle).renderStates.set(stateId, value);
            this.noteUnreadState("renderState", CONSUMED_RENDER_STATES, stateId);
            if (stateId === D3DRS_SRGBWRITEENABLE && value !== 0) {
                ++this.stats.srgbWriteRequests;
            }
            // D3DRS_WRAP0..15. Named rather than left in the passive
            // unread-state list because it has a specific, recognisable
            // symptom -- a seam across cylindrically or spherically mapped
            // geometry where the coordinate crosses 0/1 -- and because it is
            // the rare gap with no route inside this host renderer: the wrap
            // decision is made per *triangle*, by comparing its three vertices'
            // coordinates, and WebGPU has no stage that sees a whole primitive.
            // The D3D7 frontend handles this before the wire while it still owns
            // the source vertices; a WRAP state reaching here came through a
            // frontend that cannot do that preprocessing.
            if (stateId >= D3DRS_WRAP0 && stateId <= D3DRS_WRAP7 && value !== 0)
                this.warnOnce("render-state-wrap",
                    "D3DRS_WRAP" + (stateId - D3DRS_WRAP0) + " asks for " +
                    "shortest-path texture coordinate interpolation, which " +
                    "is a per-primitive decision WebGPU has no stage to make; " +
                    "coordinates interpolate linearly and a seam may appear " +
                    "where they cross 0 or 1", { state: stateId, value });
        }

        // Every state the guest sends that nothing here reads. This exists
        // because the expensive failures on this path have all been silent ones:
        // a state the app clearly cares about (it would not call Set otherwise)
        // that the renderer never looks at produces a picture that is wrong in a
        // plausible way, with nothing anywhere saying so. Listing them turns
        // "why does this look wrong" into a finite list to work through.
        //
        // Bounded by construction: it records ids, not occurrences, and there
        // are only a few hundred possible ids.
        noteUnreadState(kind, consumed, stateId) {
            if (consumed.has(stateId)) return;
            const key = kind + "s";
            if (!this.unreadStates) this.unreadStates = {};
            const seen = this.unreadStates[key] || (this.unreadStates[key] = new Set());
            if (seen.has(stateId)) return;
            seen.add(stateId);
            this.stats.unreadStateIds = Object.keys(this.unreadStates)
                .reduce((out, name) => {
                    out[name] = [...this.unreadStates[name]].sort((a, b) => a - b);
                    return out;
                }, {});
        }

        onSetTextureStageState(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.SetTextureStageState.device_handle, true);
            const stage = view.getUint32(offset + D9WG.F.SetTextureStageState.stage, true);
            const stateId = view.getUint32(offset + D9WG.F.SetTextureStageState.state, true);
            const value = view.getUint32(offset + D9WG.F.SetTextureStageState.value, true);
            this.deviceState(deviceHandle).textureStageStates.set(stage * 64 + stateId, value);
        }

        onSetTexture(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.SetTexture.device_handle, true);
            const stage = view.getUint32(offset + D9WG.F.SetTexture.stage, true);
            const textureHandle = view.getUint32(offset + D9WG.F.SetTexture.texture_handle, true);
            this.deviceState(deviceHandle).textures.set(stage, textureHandle);
        }

        // Stored to keep host state honest with the guest's D9WGSetSamplerState/
        // D9WGSetMaterial/D9WGSetLight/D9WGLightEnable emitters (d3d9_proxy.c),
        // but not yet read anywhere in pipelineFor()/recordDraw() -- M1's fixed
        // shader always uses one hardcoded default sampler and never applies
        // lighting math. Real consumption is M2 (sampler variants, 4.4/12) and
        // M2/M3 (lighting) work.
        onSetSamplerState(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.SetSamplerState.device_handle, true);
            const sampler = view.getUint32(offset + D9WG.F.SetSamplerState.sampler, true);
            const stateId = view.getUint32(offset + D9WG.F.SetSamplerState.state, true);
            this.noteUnreadState("samplerState", CONSUMED_SAMPLER_STATES, stateId);
            const value = view.getUint32(offset + D9WG.F.SetSamplerState.value, true);
            this.deviceState(deviceHandle).samplerStates.set(sampler * 64 + stateId, value);
        }

        onSetMaterial(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.SetMaterial.device_handle, true);
            const readVec4 = base => [
                view.getFloat32(base, true), view.getFloat32(base + 4, true),
                view.getFloat32(base + 8, true), view.getFloat32(base + 12, true),
            ];
            this.deviceState(deviceHandle).material = {
                diffuse: readVec4(offset + D9WG.F.SetMaterial.diffuse), ambient: readVec4(offset + D9WG.F.SetMaterial.ambient),
                specular: readVec4(offset + D9WG.F.SetMaterial.specular), emissive: readVec4(offset + D9WG.F.SetMaterial.emissive),
                power: view.getFloat32(offset + D9WG.F.SetMaterial.power, true),
            };
        }

        onSetLight(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.SetLight.device_handle, true);
            const index = view.getUint32(offset + D9WG.F.SetLight.index, true);
            const readVec = (base, count) => {
                const out = [];
                for (let i = 0; i < count; ++i) out.push(view.getFloat32(base + i * 4, true));
                return out;
            };
            this.deviceState(deviceHandle).lights.set(index, {
                type: view.getUint32(offset + D9WG.F.SetLight.type, true),
                diffuse: readVec(offset + D9WG.F.SetLight.diffuse, 4), specular: readVec(offset + D9WG.F.SetLight.specular, 4),
                ambient: readVec(offset + D9WG.F.SetLight.ambient, 4), position: readVec(offset + D9WG.F.SetLight.position, 3),
                direction: readVec(offset + D9WG.F.SetLight.direction, 3), range: view.getFloat32(offset + D9WG.F.SetLight.range, true),
                falloff: view.getFloat32(offset + D9WG.F.SetLight.falloff, true),
                attenuation: readVec(offset + D9WG.F.SetLight.attenuation, 3),
                theta: view.getFloat32(offset + D9WG.F.SetLight.theta, true), phi: view.getFloat32(offset + D9WG.F.SetLight.phi, true),
            });
        }

        onLightEnable(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.LightEnable.device_handle, true);
            const index = view.getUint32(offset + D9WG.F.LightEnable.index, true);
            const enable = view.getUint32(offset + D9WG.F.LightEnable.enable, true) !== 0;
            this.deviceState(deviceHandle).lightEnabled.set(index, enable);
        }

        onSetViewport(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.SetViewport.device_handle, true);
            const state = this.deviceState(deviceHandle);
            // MinZ/MaxZ have been on the wire since M1 (D9WGSetViewport) and
            // used to be dropped here, with recordDraw hardcoding 0..1 into
            // setViewport. D3D9's viewport depth range is not decoration: an app
            // that composites a 3D object into a 2D panel routinely restricts it
            // so the object cannot collide in depth with the interface around
            // it, and discarding that puts the object at its natural depth --
            // where whatever the app expected to be in front of it no longer is.
            // MinZ = MaxZ = 0 is legal ("draw on the near plane", HUDs and
            // first-person weapons); values outside 0 <= MinZ <= MaxZ <= 1
            // are the guest's SetViewport to refuse
            let minZ = view.getFloat32(offset + D9WG.F.SetViewport.min_z, true);
            let maxZ = view.getFloat32(offset + D9WG.F.SetViewport.max_z, true);
            if (!(minZ >= 0 && minZ <= maxZ && maxZ <= 1)) {
                this.protocolViolation("viewport-depth", "SetViewport depth range outside 0 <= MinZ <= MaxZ <= 1",
                    { minZ, maxZ });
                minZ = Math.min(Math.max(minZ || 0, 0), 1);
                maxZ = Math.min(Math.max(maxZ || 0, minZ), 1);
            }
            state.viewport = {
                x: view.getUint32(offset + D9WG.F.SetViewport.x, true),
                y: view.getUint32(offset + D9WG.F.SetViewport.y, true),
                width: view.getUint32(offset + D9WG.F.SetViewport.width, true),
                height: view.getUint32(offset + D9WG.F.SetViewport.height, true),
                minZ, maxZ,
            };
        }

        onSetTransform(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.SetTransform.device_handle, true);
            const transformState = view.getUint32(offset + D9WG.F.SetTransform.state, true);
            const matrix = new Float32Array(16);
            for (let i = 0; i < 16; ++i) matrix[i] = view.getFloat32(offset + D9WG.F.SetTransform.matrix + i * 4, true);
            // Stored exactly as D3D sent it (row-major, row-vector
            // convention). No transpose here -- see uniformBufferFor for why
            // none is needed anywhere on this path.
            const state = this.deviceState(deviceHandle);
            state.transforms.set(transformState, matrix);
            if (transformState > D3DTS_WORLD &&
                    transformState < D3DTS_WORLD + MAX_WORLD_MATRICES) {
                state.maxWorldMatrixIndex = Math.max(state.maxWorldMatrixIndex,
                    transformState - D3DTS_WORLD);
            }
        }

        onSetClipPlane(bytes, view, offset, length) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.SetClipPlane.device_handle, true));
            const index = view.getUint32(offset + D9WG.F.SetClipPlane.index, true);
            if (index >= 6) return;
            state.clipPlanes[index] = [
                view.getFloat32(offset + D9WG.F.SetClipPlane.plane, true),
                view.getFloat32(offset + D9WG.F.SetClipPlane.plane + 4, true),
                view.getFloat32(offset + D9WG.F.SetClipPlane.plane + 8, true),
                view.getFloat32(offset + D9WG.F.SetClipPlane.plane + 12, true),
            ];
        }

        onSetStreamSource(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.SetStreamSource.device_handle, true);
            const stream = view.getUint32(offset + D9WG.F.SetStreamSource.stream, true);
            const bufferHandle = view.getUint32(offset + D9WG.F.SetStreamSource.buffer_handle, true);
            const stride = view.getUint32(offset + D9WG.F.SetStreamSource.stride, true);
            const offsetInBytes = view.getUint32(offset + D9WG.F.SetStreamSource.offset_in_bytes, true);
            const state = this.deviceState(deviceHandle);
            const previous = state.streams.get(stream);
            state.streams.set(stream, { bufferHandle, stride, offsetInBytes,
                frequency: previous ? (previous.frequency ?? 1) : 1 });
        }

        onSetStreamSourceFreq(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.SetStreamSourceFreq.device_handle, true);
            const stream = view.getUint32(offset + D9WG.F.SetStreamSourceFreq.stream, true);
            const frequency = view.getUint32(offset + D9WG.F.SetStreamSourceFreq.divider, true);
            const state = this.deviceState(deviceHandle);
            const previous = state.streams.get(stream) || {
                bufferHandle: 0, stride: 0, offsetInBytes: 0,
            };
            state.streams.set(stream, { ...previous, frequency });
        }

        onSetIndices(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.SetIndices.device_handle, true);
            const bufferHandle = view.getUint32(offset + D9WG.F.SetIndices.buffer_handle, true);
            this.deviceState(deviceHandle).indexBufferHandle = bufferHandle;
        }

        onSetVertexShader(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.SetShader.device_handle, true));
            state.vertexShaderHandle = view.getUint32(offset + D9WG.F.SetShader.shader_handle, true);
        }

        onSetPixelShader(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.SetShader.device_handle, true));
            state.pixelShaderHandle = view.getUint32(offset + D9WG.F.SetShader.shader_handle, true);
        }

        // Shared decode for all six SET_*_SHADER_CONSTANT_* opcodes: they use
        // one payload shape and differ only in the destination array and how
        // wide a register is on the wire (float4/int4 = 16 bytes, bool = 4).
        applyConstants(bytes, view, offset, target, componentsPerRegister, read) {
            const startRegister = view.getUint32(offset + 4, true);
            const vectorCount = view.getUint32(offset + 8, true);
            const dataOffset = view.getUint32(offset + 12, true);
            const stride = componentsPerRegister * 4;
            if (dataOffset + vectorCount * stride > bytes.byteLength) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG shader constant data overruns the batch");
            }
            const capacity = target.length / componentsPerRegister;
            if (startRegister >= capacity) return;
            const count = Math.min(vectorCount, capacity - startRegister);
            for (let i = 0; i < count; ++i) {
                const base = dataOffset + i * stride;
                const destination = (startRegister + i) * componentsPerRegister;
                for (let c = 0; c < componentsPerRegister; ++c)
                    target[destination + c] = read(base + c * 4);
            }
        }

        onSetVertexShaderConstantF(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.SetShaderConstantF.device_handle, true));
            this.applyConstants(bytes, view, offset, state.vsConstF, 4,
                at => view.getFloat32(at, true));
        }

        onSetPixelShaderConstantF(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.SetShaderConstantF.device_handle, true));
            this.applyConstants(bytes, view, offset, state.psConstF, 4,
                at => view.getFloat32(at, true));
        }

        onSetVertexShaderConstantI(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.SetShaderConstantF.device_handle, true));
            this.applyConstants(bytes, view, offset, state.vsConstI, 4,
                at => view.getInt32(at, true));
        }

        onSetPixelShaderConstantI(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.SetShaderConstantF.device_handle, true));
            this.applyConstants(bytes, view, offset, state.psConstI, 4,
                at => view.getInt32(at, true));
        }

        onSetVertexShaderConstantB(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.SetShaderConstantF.device_handle, true));
            this.applyConstants(bytes, view, offset, state.vsConstB, 1,
                at => view.getUint32(at, true));
        }

        onSetPixelShaderConstantB(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset + D9WG.F.SetShaderConstantF.device_handle, true));
            this.applyConstants(bytes, view, offset, state.psConstB, 1,
                at => view.getUint32(at, true));
        }

        // GPUShaderModules are content-addressed by their WGSL text, so two
        // shaders that translate identically (or the same shader re-created
        // after a Reset) share one module. Compilation diagnostics are checked
        // asynchronously -- createShaderModule() never throws on bad WGSL, and
        // plan 9.6 requires the getCompilationInfo() check rather than
        // assuming successful translation implies valid output.
        fixedModuleFor(key, stage, signature, debugMode) {
            let module = this.fixedModuleCache.get(key);
            if (!module) {
                const wgsl = stage === "vertex" ? buildFixedFunctionVertexShader(signature)
                    : buildFixedFunctionPixelShader(signature, debugMode);
                module = this.moduleFor(wgsl, "d3d9 " + key);
                this.fixedModuleCache.set(key, module);
            }
            return module;
        }

        moduleFor(wgsl, label) {
            let module = this.moduleCache.get(wgsl);
            if (module) return module;
            module = this.device.createShaderModule({ label, code: wgsl });
            ++this.stats.shaderModulesCreated;
            this.moduleCache.set(wgsl, module);
            if (typeof module.getCompilationInfo === "function") {
                module.getCompilationInfo().then(info => {
                    const errors = (info.messages || [])
                        .filter(message => message.type === "error");
                    if (!errors.length) return;
                    module._d9wgBroken = true;
                    this.stats.shaderCompileErrors += errors.length;
                    console.error("[d3d9-webgpu] WGSL compilation failed for " +
                        label, errors.map(e => e.lineNum + ":" + e.linePos +
                            " " + e.message), wgsl);
                }, () => {});
            }
            return module;
        }

        // ---- program resolution ----

        // Resolves the two stages into GPUShaderModules plus everything the
        // pipeline and bind group need. Returns {error} instead of throwing
        // for anything the caller should turn into a counted skipped draw.
        // Program reuse is confined to serialized wire draws. Direct callers
        // may mutate a state object without sending a command and retain the
        // uncached builder contract. Unknown commands invalidate conservatively.
        advanceDrawState(opcode, view, offset) {
            ++this.commandSerial;
            let programDirty = true, uniformsDirty = true;
            if (opcode === OP_SET_RENDER_STATE) {
                const id = view.getUint32(offset + D9WG.F.SetRenderState.state, true);
                if (id === D3DRS_CULLMODE || id === D3DRS_STENCILREF ||
                        id === D3DRS_BLENDFACTOR || id === D3DRS_ALPHAREF ||
                        id === D3DRS_TEXTUREFACTOR) programDirty = false;
                if (id === D3DRS_CULLMODE || id === D3DRS_STENCILREF ||
                        id === D3DRS_BLENDFACTOR) uniformsDirty = false;
                else if (id === D3DRS_TEXTUREFACTOR) {
                    const state = this.devices.get(view.getUint32(offset + D9WG.F.SetRenderState.device_handle, true));
                    const cached = state && state.lastProgram;
                    if (cached && cached.serial === this.programSerial &&
                            !(cached.program.pixelSignature && cached.program.pixelSignature.usesTextureFactor))
                        uniformsDirty = false;
                }
            }
            if (programDirty) ++this.programSerial;
            if (uniformsDirty) ++this.uniformSerial;
        }

        programFor(state, elements, pipelineState, drawOptions) {
            const wireDraw = this.recordingOpcode >= OP_DRAW_PRIMITIVE &&
                this.recordingOpcode <= OP_DRAW_INDEXED_PRIMITIVE_UP;
            if (!wireDraw || this.options.cachePrograms === false) {
                ++this.stats.programBuilds;
                return this.buildProgramFor(state, elements, pipelineState, drawOptions);
            }
            const pointExpansion = !!(drawOptions && drawOptions.pointExpansion);
            const pointSprite = !!(drawOptions && drawOptions.pointSprite);
            const stream0 = state.streams.get(0);
            const stride = stream0 ? stream0.stride : 0;
            const frequency = stream0 ? stream0.frequency : undefined;
            const alphaMode = pipelineState.alphaTest.enabled ? pipelineState.alphaTest.func : 0;
            const debug = this.debug, cached = state.lastProgram;
            if (cached && cached.serial === this.programSerial &&
                    cached.elements === elements && cached.stride === stride && cached.frequency === frequency &&
                    cached.pointExpansion === pointExpansion && cached.pointSprite === pointSprite &&
                    cached.alphaMode === alphaMode && cached.shaderMode === debug.shaderMode &&
                    cached.forceSolidAllDraws === debug.forceSolidAllDraws &&
                    cached.skipProgrammableDraws === debug.skipProgrammableDraws &&
                    cached.highlightMissingTexture === debug.highlightMissingTexture &&
                    cached.highlightMissingCoordSet === debug.highlightMissingCoordSet &&
                    cached.warnOnSuspiciousDraws === debug.warnOnSuspiciousDraws &&
                    cached.texcoordFromStageIndex === debug.texcoordFromStageIndex &&
                    !cached.program.vertexModule._d9wgBroken && !cached.program.fragmentModule._d9wgBroken) {
                ++this.stats.programCacheHits;
                for (const [name, count] of cached.program.drawCounters) this.stats[name] += count;
                return cached.program;
            }
            ++this.stats.programBuilds;
            const before = PROGRAM_DRAW_COUNTERS.map(name => this.stats[name]);
            const program = this.buildProgramFor(state, elements, pipelineState, drawOptions);
            if (program.error) { state.lastProgram = null;return program; }
            program.drawCounters = PROGRAM_DRAW_COUNTERS.flatMap((name, index) => {
                const delta = this.stats[name] - before[index];
                return delta ? [[name, delta]] : [];
            });
            state.lastProgram = {
                serial: this.programSerial, elements, stride, frequency, alphaMode, pointExpansion, pointSprite, program,
                shaderMode: debug.shaderMode, forceSolidAllDraws: debug.forceSolidAllDraws,
                skipProgrammableDraws: debug.skipProgrammableDraws,
                highlightMissingTexture: debug.highlightMissingTexture,
                highlightMissingCoordSet: debug.highlightMissingCoordSet,
                warnOnSuspiciousDraws: debug.warnOnSuspiciousDraws,
                texcoordFromStageIndex: debug.texcoordFromStageIndex,
            };
            return program;
        }

        buildProgramFor(state, elements, pipelineState, drawOptions) {
            drawOptions = drawOptions || {};
            const alphaTest = pipelineState.alphaTest;
            const alphaTestKey = alphaTest.enabled
                ? "_a" + alphaTest.func : "";
            const rs = state.renderStates;
            const pretransformed = elements.some(element =>
                element.usage === DECLUSAGE_POSITIONT && element.usageIndex === 0);
            const clipMask = (rs.get(D3DRS_CLIPPLANEENABLE) || 0) & 0x3f;
            if (clipMask) state.clipPlaneCapacity = 6;
            // POSITIONT has already completed vertex processing, including
            // user clipping. Plane capacity remains cached for later XYZ draws.
            const clipPlaneCount = pretransformed ? 0 : state.clipPlaneCapacity || 0;
            const clipKey = "_cl" + clipPlaneCount;
            // D3DRS_SHADEMODE, applied to the two colour varyings in both
            // stages, fixed-function or translated (D3D9 flat-shades COLOR0/1
            // with shaders too, as wined3d's flatshading does). The two
            // stages have to agree: a vertex output and the fragment input at
            // one location with different interpolation make the pipeline,
            // and the frame's command buffer, invalid.
            const flatShading =
                (rs.get(D3DRS_SHADEMODE) || D3DSHADE_GOURAUD) === D3DSHADE_FLAT;
            // Pre-transformed vertices (a POSITIONT element) skip vertex
            // processing even with a vertex shader bound: D3D9 draws them as
            // fixed-function screen-space geometry, as wined3d's use_vs()
            // does. Apps draw HUD quads so without unbinding their shader;
            // matching POSITIONT against the shader's POSITION input instead
            // dropped the draw, or built a pipeline missing attribute 0, which
            // invalidates the whole frame's command buffer.
            const vsHandle = pretransformed ? 0 : state.vertexShaderHandle;
            const psHandle = state.pixelShaderHandle;
            const vsResource = vsHandle ? this.resources.get(vsHandle) : null;
            const psResource = psHandle ? this.resources.get(psHandle) : null;
            if (vsHandle && !vsResource)
                return { error: "bound vertex shader handle is unknown to the host",
                    shaderError: true };
            if (psHandle && !psResource)
                return { error: "bound pixel shader handle is unknown to the host",
                    shaderError: true };
            if (this.debug.skipProgrammableDraws &&
                    !this.debug.forceSolidAllDraws &&
                    (vsResource || psResource))
                return { error: "debug.skipProgrammableDraws is on; this draw " +
                    "has a translated " + (vsResource ? "vertex" : "") +
                    (vsResource && psResource ? "/" : "") +
                    (psResource ? "pixel" : "") + " shader bound" };

            // The declaration decides whether the fixed-function vertex stage
            // can run at all, and it is also what tells the pixel stage which
            // vertex stage is in force -- D3D9 only applies texture-coordinate
            // generation and the texture matrices as part of fixed-function
            // T&L, so the answer changes what the cascade may assume about its
            // input varyings. Hence it is resolved first, before either module.
            const fixedVertexSignature = vsResource ? null
                : this.fixedFunctionVertexSignature(elements);
            if (!vsResource && !fixedVertexSignature)
                return { error: "declaration has no POSITION/POSITIONT element " +
                    "and no vertex shader is bound" };

            // Table fog wins over vertex fog. Transformed vertices supply
            // their vertex factor in specular alpha, irrespective of the mode.
            let fogMode = 0;
            let tableFog = false;
            if ((rs.get(D3DRS_FOGENABLE) || 0) !== 0) {
                const table = rs.get(D3DRS_FOGTABLEMODE) || D3DFOG_NONE;
                tableFog = table !== D3DFOG_NONE;
                fogMode = tableFog ? table : fixedVertexSignature && fixedVertexSignature.positionType === "screen"
                    ? "factor" : (rs.get(D3DRS_FOGVERTEXMODE) || "factor");
            }

            // ps_3_0 owns fog; the legacy post-shader blend is only ps<3.
            if (psResource && psResource.translated.ok && psResource.translated.reflection.version.major >= 3) { fogMode = 0;tableFog = false; }

            const semanticPair = shaderPipeline.linkShaderSemantics(
                vsResource && vsResource.translated.ok ? vsResource.translated.reflection : null,
                psResource && psResource.translated.ok ? psResource.translated.reflection : null);
            if (!semanticPair.ok) return {error: "shader semantic link failed: " + semanticPair.error, shaderError: true};
            const semanticLink = semanticPair.link;
            const semanticKey = semanticPair.key ? "|link:" + semanticPair.key : "";

            // ---- pixel stage ----
            //
            // Resolved before the vertex stage because how many texture
            // coordinate sets the vertex stage has to produce, and with which
            // per-stage transform, depends on what consumes them: the cascade's
            // active stage count for a fixed-function pixel stage, or the
            // texcoord semantics a translated pixel shader declares.
            let fragmentModule, fragmentKey, pixelReflection = null;
            let samplerIndices = [];
            // Sampler slot -> WGSL view dimension ("2d" / "cube" / "3d").
            const samplerDimensions = {};
            let cascade = null;
            let pixelSignature = null;
            let coordStageCount = 0;
            if (psResource) {
                if (!psResource.translated.ok)
                    return { error: "pixel shader translation failed: " +
                        psResource.translated.error, shaderError: true };
                let variant = psResource.translated;
                // SM1 tex/texld have implicit sampler types. A shader can be
                // used with 2D, cube or volume textures on different draws, so
                // specialize its WGSL and cache key from the current bindings.
                // SM2+ dcl_* types remain authoritative and are checked below.
                const legacySamplerTypes = {};
                let legacySamplerKey = "";
                const legacyProjection = {};
                let legacyProjectionKey = "";
                if (variant.reflection.version.major === 1) {
                    for (const sampler of variant.reflection.samplers) {
                        const flags = state.textureStageStates.get(sampler.index * 64 + D3DTSS_TEXTURETRANSFORMFLAGS) || 0;
                        if (variant.reflection.version.minor < 4 && (flags & D3DTTFF_PROJECTED)) {
                            const count = flags & 0xff;
                            legacyProjection[sampler.index] = ["w", "x", "y", "z", "w"][count] || "w";
                            legacyProjectionKey += "_q" + sampler.index + legacyProjection[sampler.index];
                        }
                        const texture = this.resources.get(state.textures.get(sampler.index));
                        const type = texture && (texture.textureType || "2d");
                        if (type && type !== sampler.type) {
                            legacySamplerTypes[sampler.index] = type;
                            legacySamplerKey += "_t" + sampler.index + ":" + type;
                        }
                    }
                }
                // Which stages have a depth texture bound decides the WGSL:
                // a shadow-map stage is texture_depth_2d sampled through a
                // comparison sampler, and there is nothing in the bytecode to
                // say so. The sampler set is a property of the bytecode rather
                // than of any variant, so the base translation's reflection is
                // the right thing to read it from.
                const depthSamplers = [];
                const depthFetchSamplers = [];
                for (const sampler of psResource.translated.reflection.samplers) {
                    const mode = this.depthSampleModeFor(
                        state.textures.get(sampler.index));
                    if (!mode) continue;
                    depthSamplers.push(sampler.index);
                    if (mode === "depth-fetch")
                        depthFetchSamplers.push(sampler.index);
                }
                const depthKey = depthSamplers.length
                    ? "_z" + depthSamplers.join(".") +
                        (depthFetchSamplers.length
                            ? "_r" + depthFetchSamplers.join(".") : "")
                    : "";
                // The sampler set determines one bias uniform layout; values
                // are uploaded per draw and never enter the shader key.
                const samplerSwizzles = {};
                let swizzleKey = "";
                const samplerLodBiasUniform = psResource.translated.reflection.samplers.length > 0;
                const lodBiasKey = samplerLodBiasUniform ? "_lod_uniform" : "";
                // D3DTADDRESS_MIRRORONCE is finished in the shader too: the
                // sampler clamps, and abs() on the coordinate supplies the
                // mirror. Address modes remain part of the variant key.
                const samplerMirrorOnce = {};
                let mirrorOnceKey = "";
                for (const sampler of psResource.translated.reflection.samplers) {
                    const texture = this.resources.get(state.textures.get(sampler.index));
                    const swizzle = texture && samplingSwizzle(texture.format);
                    if (swizzle) { samplerSwizzles[sampler.index] = swizzle;swizzleKey += "_w" + sampler.index + ":" + swizzle; }
                    const axes = [
                        [D3DSAMP_ADDRESSU, "x"], [D3DSAMP_ADDRESSV, "y"],
                        [D3DSAMP_ADDRESSW, "z"],
                    ].filter(([id]) => (state.samplerStates.get(
                        sampler.index * 64 + id) || 1) === 5)
                        .map(([, axis]) => axis).join("");
                    if (axes) {
                        samplerMirrorOnce[sampler.index] = axes;
                        mirrorOnceKey += "_m" + sampler.index + ":" + axes;
                    }
                }
                const fogBlend = ffp.fogBlendSource({ fogMode, tableFog }, "d9c", "result.color0");
                const fogKey = fogBlend ? "_fog" + fogMode + (tableFog ? "t" : "v") : "";
                const pixelVariantKey = semanticKey + fogKey + alphaTestKey + clipKey + depthKey +
                    lodBiasKey + mirrorOnceKey + legacySamplerKey + legacyProjectionKey + swizzleKey +
                    (flatShading ? "_flat" : "");
                if (semanticLink || alphaTest.enabled || clipPlaneCount || depthSamplers.length
                        || lodBiasKey || mirrorOnceKey || legacySamplerKey || legacyProjectionKey || swizzleKey ||
                        flatShading || fogBlend) {
                    variant = psResource.variants.get(pixelVariantKey);
                    if (!variant) {
                        variant = shaderPipeline.specializeShader(psResource.translated, {
                            alphaTestDiscard: alphaTestDiscard(alphaTest,
                                "result.color0.a", "d9c.alpha_test.x"),
                            alphaTestUniform: alphaTest.enabled,
                            clipPlaneCount,
                            depthSamplers,
                            depthFetchSamplers,
                            samplerLodBiasUniform, samplerSwizzles,
                            samplerMirrorOnce,
                            legacySamplerTypes, legacyProjection,
                            flatShading, fogBlend, semanticLink,
                        });
                        psResource.variants.set(pixelVariantKey, variant);
                        if (variant.ok) ++this.stats.shaderVariantsTranslated;
                    }
                    if (!variant.ok)
                        return { error: "pixel shader translation failed: " +
                            variant.error, shaderError: true };
                }
                pixelReflection = variant.reflection;
                // The declared sampler type has to match what is actually bound:
                // a texture_cube binding fed a 2D view is a WebGPU validation
                // error that kills the whole submit, not just this draw.
                for (const sampler of pixelReflection.samplers) {
                    const texture = this.resources.get(
                        state.textures.get(sampler.index));
                    const bound = texture ? (texture.textureType || "2d") : null;
                    if (bound && bound !== sampler.type)
                        return { error: "pixel shader declares sampler " +
                            sampler.index + " as " + sampler.type +
                            " but a " + bound + " texture is bound to that stage",
                            shaderError: true };
                }
                samplerIndices = pixelReflection.samplers.map(s => s.index);
                for (const sampler of pixelReflection.samplers)
                    samplerDimensions[sampler.index] = sampler.type;
                // D3D9 hands a pixel shader the coordinates of texture stage n
                // in its texcoord n, so the vertex stage still has to run
                // generation/transform for every stage the shader reads.
                for (const input of pixelReflection.inputs || []) {
                    if (input.usage === DECLUSAGE_TEXCOORD)
                        coordStageCount = Math.max(coordStageCount,
                            input.usageIndex + 1);
                }
                if (!coordStageCount && pixelReflection.samplers.length)
                    coordStageCount = Math.max(...pixelReflection.samplers
                        .map(sampler => sampler.index)) + 1;
                fragmentKey = "ps" + psResource.hashHigh + "_" + psResource.hashLow +
                    pixelVariantKey;
                fragmentModule = this.moduleFor(variant.wgsl, "d3d9 " + fragmentKey);
            } else {
                cascade = this.textureCascadeSignature(state,
                    { fixedVertexStage: !!fixedVertexSignature });
                coordStageCount = cascade.stages.length;
                for (const stage of cascade.stages) {
                    if (!stage.samplesTexture) continue;
                    if (stage.hasTextureBound) ++this.stats.drawsWithTexture;
                    else ++this.stats.drawsWithFallbackTexture;
                }
                if (cascade.unsupported.length) {
                    ++this.stats.drawsWithUnsupportedTextureOp;
                    this.warnOnce("texture-stage-" + cascade.unsupported[0],
                        "a draw asks for texture-stage behaviour outside what " +
                        "the fixed-function cascade implements; the stage falls " +
                        "back to selecting its first argument, which renders as " +
                        "plausible-but-wrong shading: " +
                        cascade.unsupported.join("; "));
                }
                samplerIndices = cascade.stages
                    .filter(stage => stage.samplesTexture)
                    .map(stage => stage.index);
                // Per-draw, so the highlight marks only the affected draws
                // instead of repainting the frame the way shaderMode does.
                const cascadeMissesTexture = cascade.stages.some(stage =>
                    stage.samplesTexture && !stage.hasTextureBound);
                const cascadeMissesCoordSet = !!fixedVertexSignature &&
                    cascade.stages.some(stage =>
                        stage.samplesTexture &&
                        stage.tciMode === D3DTSS_TCI_PASSTHRU &&
                        !fixedVertexSignature.texCoordSets
                            .includes(stage.texCoordIndex));
                // Missing texture wins the colour when a draw manages both,
                // because it is the coarser fault: there is nothing to sample
                // whatever the coordinates do.
                const debugMode =
                    (this.debug.highlightMissingTexture && cascadeMissesTexture)
                        ? "missing"
                        : ((this.debug.highlightMissingCoordSet &&
                            cascadeMissesCoordSet)
                            ? "orphan" : this.debug.shaderMode);
                for (const stage of cascade.stages) {
                    if (stage.samplesTexture)
                        samplerDimensions[stage.index] = stage.textureType;
                }
                pixelSignature = {
                    stages: cascade.stages,
                    usesTextureFactor: cascade.usesTextureFactor,
                    lodBiasUniforms: cascade.stages.some(stage => stage.samplesTexture),
                    fogMode, tableFog, alphaTest: { enabled: alphaTest.enabled, func: alphaTest.func }, clipPlaneCount,
                    // D3D9 adds the specular colour after the cascade whenever
                    // D3DRS_SPECULARENABLE is set, whether it came from lighting
                    // or straight off the vertex.
                    specularEnable: (rs.get(D3DRS_SPECULARENABLE) || 0) !== 0,
                    flatShading,
                };
                fragmentKey = ffp.signatureKey("pixel", pixelSignature, debugMode);
                fragmentModule = this.fixedModuleFor(fragmentKey, "pixel", pixelSignature, debugMode);
            }
            if (this.debug.forceSolidAllDraws) {
                // Preserve the original key in the diagnostic key. Although
                // every probe draw uses the same tiny fragment module, its
                // original shader still determines the bind-group layout
                // (constant block and sampler bindings), and two such layouts
                // must never collide in the pipeline cache.
                fragmentKey = "debug-solid-all(" + fragmentKey + ")";
                fragmentModule = this.moduleFor(DIAGNOSTIC_SOLID_PIXEL_SHADER,
                    "d3d9 diagnostic solid pixel shader");
            }

            // ---- vertex stage ----
            let vertexModule, vertexKey, vertexReflection = null, locationFor;
            let fixedFunctionSignature = null;
            if (vsResource) {
                const inputLocations = new Map();
                if (!vsResource.translated.ok)
                    return { error: "vertex shader translation failed: " +
                        vsResource.translated.error, shaderError: true };
                for (const input of vsResource.translated.reflection.inputs)
                    inputLocations.set(input.usage * 16 + input.usageIndex, input.location);
                // Only the declaration knows which attributes are D3DCOLOR and
                // therefore arrive byte-swapped; see bgraInputLocations.
                const bgra = [];
                const inputConversions = {};
                for (const element of elements) {
                    const binding = state.streams.get(element.stream);
                    if (!binding || (!binding.bufferHandle && !binding.userPointer)) continue;
                    const location = inputLocations.get(
                        element.usage * 16 + element.usageIndex);
                    if (location !== undefined && element.type === DECLTYPE_D3DCOLOR)
                        bgra.push(location);
                    if (location === undefined) continue;
                    const conversion = element.type === DECLTYPE_D3DCOLOR ? "" :
                        shaderPipeline.vertexInputConversion(element.type);
                    if (conversion) inputConversions[location] = conversion;
                }
                bgra.sort((a, b) => a - b);
                const conversionKey = Object.keys(inputConversions)
                    .map(Number).sort((a, b) => a - b)
                    .map(location => location + ":" + inputConversions[location])
                    .join(",");
                const pointKey = drawOptions.pointExpansion
                    ? "|p:" + (drawOptions.pointSprite ? "s" : "q") : "";
                const vertexSwizzles = {};
                let vertexSwizzleKey = "";
                for (const sampler of vsResource.translated.reflection.samplers) {
                    const texture = this.resources.get(state.textures.get(D3DVERTEXTEXTURESAMPLER0 + sampler.index));
                    const swizzle = texture && samplingSwizzle(texture.format);
                    if (swizzle) { vertexSwizzles[sampler.index] = swizzle;vertexSwizzleKey += "|w" + sampler.index + ":" + swizzle; }
                }
                const legacyColorClamp = vsResource.translated.reflection.version.major >= 3 &&
                    (!pixelReflection || pixelReflection.version.major < 3);
                const variantKey = "b:" + bgra.join(",") + "|c:" +
                    conversionKey + pointKey + clipKey + vertexSwizzleKey + semanticKey +
                    (legacyColorClamp ? "|legacy-color" : "") +
                    (flatShading ? "|flat" : "");
                const needsVariant = bgra.length || conversionKey.length ||
                    !!drawOptions.pointExpansion || !!clipPlaneCount ||
                    !!vertexSwizzleKey || flatShading || legacyColorClamp || !!semanticLink;
                let variant = vsResource.variants.get(variantKey);
                if (!variant) {
                    variant = needsVariant
                        ? shaderPipeline.specializeShader(vsResource.translated,
                            { bgraInputLocations: bgra, inputConversions, samplerSwizzles: vertexSwizzles,
                              pointExpansion: !!drawOptions.pointExpansion,
                              pointSprite: !!drawOptions.pointSprite,
                              clipPlaneCount, flatShading, legacyColorClamp, semanticLink })
                        : vsResource.translated;
                    vsResource.variants.set(variantKey, variant);
                    if (needsVariant && variant.ok)
                        ++this.stats.shaderVariantsTranslated;
                }
                if (!variant.ok)
                    return { error: "vertex shader translation failed: " + variant.error,
                        shaderError: true };
                vertexReflection = variant.reflection;
                vertexKey = "vs" + vsResource.hashHigh + "_" + vsResource.hashLow +
                    "_" + variantKey;
                vertexModule = this.moduleFor(variant.wgsl, "d3d9 " + vertexKey);
                locationFor = element => {
                    const location = inputLocations.get(
                        element.usage * 16 + element.usageIndex);
                    return location === undefined ? -1 : location;
                };
                if (conversionKey.length)
                    ++this.stats.drawsWithCompactVertexInputs;
            } else {
                const signature = fixedVertexSignature;
                signature.pointExpansion = !!drawOptions.pointExpansion;
                signature.pointSprite = signature.pointExpansion &&
                    (rs.get(D3DRS_POINTSPRITEENABLE) || 0) !== 0;
                signature.pointScale = signature.pointExpansion &&
                    signature.positionType !== "screen" &&
                    (rs.get(D3DRS_POINTSCALEENABLE) || 0) !== 0;
                // Table fog is evaluated from per-fragment W in the pixel
                // stage. Only vertex fog belongs in the generated VS/oFog.
                signature.fogMode = tableFog ? D3DFOG_NONE : fogMode;
                signature.fogRange = !tableFog &&
                    (rs.get(D3DRS_RANGEFOGENABLE) || 0) !== 0;
                signature.normalizeNormals =
                    (rs.get(D3DRS_NORMALIZENORMALS) || 0) !== 0;
                signature.lighting = this.lightingSignature(state, signature);
                signature.coordStages = this.coordStagePlan(state, coordStageCount, signature);
                /*
                 * buildFixedFunctionVertexShader() feeds a stage
                 * vec4(0,0,0,1) when texCoordSets does not carry the set
                 * D3DTSS_TEXCOORDINDEX names -- there is no coordinate to
                 * read, and a pipeline that declared the attribute anyway
                 * would be rejected outright. That substitution is silent, and
                 * its result is a constant coordinate: every fragment of the
                 * model samples the same texel and the whole thing renders as
                 * one flat colour. By eye that is indistinguishable from a
                 * missing texture or a lighting bug, and unlike every
                 * neighbouring fallback on this path it had no counter, so the
                 * one shape it produces could not be told apart from the two
                 * others that produce it. Name it here, where the declaration
                 * and the stage state are both in hand.
                 */
                const orphanCoordStages = signature.coordStages.filter(stage =>
                    stage.tciMode === D3DTSS_TCI_PASSTHRU &&
                    !signature.texCoordSets.includes(stage.texCoordIndex));
                if (orphanCoordStages.length) {
                    ++this.stats.drawsWithMissingCoordSet;
                    if (this.debug.warnOnSuspiciousDraws)
                        this.warnOnce("missing-coord-set-" + (elements || [])
                            .map(e => e.usage + "." + e.usageIndex + ":" +
                                e.type + "@" + e.byteOffset).join(","),
                        "a fixed-function texture stage reads a coordinate set " +
                        "the vertex declaration does not carry; its coordinates " +
                        "are a constant, so the whole draw samples one texel", {
                            stages: orphanCoordStages.map(stage => ({
                                stage: stage.index,
                                texCoordIndex: stage.texCoordIndex,
                            })),
                            declaredTexCoordSets: signature.texCoordSets.slice(),
                            // The declaration verbatim, plus where it came
                            // from. "The declaration carries no TEXCOORD" has
                            // two very different causes -- the app really sent
                            // one without, or the guest dropped it on the way
                            // through SetFVF/CreateVertexDeclaration -- and
                            // only the elements themselves tell them apart.
                            declarationSource: state.fvfElements
                                ? "fvf" : "declaration",
                            fvf: state.fvfElements
                                ? "0x" + ((state.fvf || 0) >>> 0).toString(16)
                                : null,
                            elements: (elements || []).map(element => ({
                                stream: element.stream,
                                offset: element.byteOffset,
                                type: element.type,
                                usage: element.usage,
                                usageIndex: element.usageIndex,
                            })),
                            streamStrides: Array.from(state.streams)
                                .map(([index, stream]) =>
                                    index + ":" + (stream.stride || 0)),
                        });
                }
                signature.clipPlaneCount = clipPlaneCount;
                signature.vertexBlend = this.vertexBlendPlan(state, signature);
                // Skinning data in the declaration that no world matrix past 0
                // will act on. This is now usually *correct* -- D3D9 ignores it
                // too whenever D3DRS_VERTEXBLEND is DISABLE, and engines share
                // one declaration between their skinned and unskinned passes --
                // so it is counted rather than warned about. It stays worth
                // counting because "the character is stuck in bind pose" and
                // "the character is missing" look alike from the outside, and a
                // nonzero count next to a zero blendedDraws says which.
                if (!signature.vertexBlend &&
                        (signature.blendWeightType >= 0 ||
                         signature.blendIndicesType >= 0))
                    ++this.stats.drawsWithUnappliedVertexBlend;
                // View space is needed for lighting, for the camera-space
                // coordinate generation modes and for range-based fog.
                signature.needsViewSpace = signature.positionType !== "screen" && (
                    !!signature.lighting ||
                    signature.pointScale ||
                    // (the vertex signature's fogMode is NONE under table fog)
                    !!signature.fogMode ||
                    signature.coordStages.some(stage =>
                        stage.tciMode !== D3DTSS_TCI_PASSTHRU));
                signature.flatShading = flatShading;
                vertexKey = ffp.signatureKey("vertex", signature);
                vertexModule = this.fixedModuleFor(vertexKey, "vertex", signature);
                vertexReflection = null;
                locationFor = element =>
                    fixedFunctionLocationFor(element, signature.vertexBlend);
                fixedFunctionSignature = signature;
            }

            /*
             * A no-NORMAL lit batch used to turn GTA SA's characters black.
             * Keeping ambient/emissive fixed the lighting half, but a white or
             * yellow silhouette means the pixel half is still receiving only
             * that lit colour.  Make the three materially different causes
             * observable here, while all the state needed to distinguish them
             * is still together:
             *
             *   - the pixel program never samples a texture;
             *   - it samples a stage whose resource handle is absent;
             *   - it has a live texture, leaving coordinate routing/data as
             *     the remaining suspect.
             *
             * drawsWithTexture only covers the fixed-function pixel cascade,
             * so it cannot answer this for a ps_1_x batch.  samplerIndices
             * covers both the fixed and programmable pixel paths.
             */
            /*
             * The seam between a translated vertex shader and a fixed-function
             * pixel cascade. The cascade picks a varying to read coordinates
             * from; the shader decides which varyings exist. Nothing checks
             * that those two agree, and when they do not the shader stage does
             * not fail -- the varying is simply a constant, so every fragment
             * samples the same texel and the model comes out one flat colour.
             * That is indistinguishable by eye from a lighting bug, a missing
             * texture or a broken UV attribute, which is exactly why it is
             * worth naming rather than leaving to be guessed at.
             */
            if (vertexReflection && vertexReflection.writtenVaryings && cascade) {
                const written = new Set(vertexReflection.writtenVaryings);
                const orphans = cascade.stages.filter(stage =>
                    stage.samplesTexture &&
                    !written.has(VARYING_TEXCOORD0 + stage.coordVarying));
                if (orphans.length) {
                    ++this.stats.drawsWithUnwrittenCoordVarying;
                    if (this.debug.warnOnSuspiciousDraws)
                        this.warnOnce("unwritten-coord-varying",
                        "a fixed-function texture stage reads its required oTn " +
                        "varying, but the bound vertex shader never writes it; " +
                        "its coordinates are a constant and the whole draw " +
                        "samples one texel", {
                            stages: orphans.map(stage => ({
                                stage: stage.index,
                                texCoordIndex: stage.texCoordIndex,
                                readsVarying: VARYING_TEXCOORD0 + stage.coordVarying,
                            })),
                            shaderWroteVaryings: vertexReflection.writtenVaryings,
                            texcoordFromStageIndex:
                                this.debug.texcoordFromStageIndex,
                        });
                }
            }

            if (fixedFunctionSignature && fixedFunctionSignature.lighting &&
                    !fixedFunctionSignature.hasNormal) {
                const textureBindings = samplerIndices.map(index => {
                    const handle = state.textures.get(index) || 0;
                    const resource = handle ? this.resources.get(handle) : null;
                    return {
                        stage: index,
                        handle,
                        live: !!resource,
                        kind: resource ? resource.kind : null,
                        type: resource ? (resource.textureType || "2d") : null,
                        format: resource ? resource.format : null,
                        size: resource ? resource.width + "x" + resource.height : null,
                        levels: resource ? resource.levelCount : null,
                        uploadedLevels: resource && resource.uploadedLevels
                            ? resource.uploadedLevels.size : null,
                    };
                });
                const missingTexture = textureBindings.some(binding => !binding.live);
                const diagnostic = this.debug.warnOnSuspiciousDraws ? {
                    pixelPath: psResource ? "programmable" : "fixed-function",
                    pixelShader: psResource
                        ? [psResource.hashHigh, psResource.hashLow]
                            .map(value => (value >>> 0).toString(16)
                                .padStart(8, "0")).join("")
                        : null,
                    samplerIndices: samplerIndices.slice(),
                    textureBindings,
                    declaredTexCoordSets: fixedFunctionSignature.texCoordSets.slice(),
                    coordinateStages: fixedFunctionSignature.coordStages.map(stage => ({
                        stage: stage.index,
                        texCoordIndex: stage.texCoordIndex,
                        tciMode: stage.tciMode,
                        transformCount: stage.transformCount,
                        projected: stage.projected,
                    })),
                    materialAmbient: state.material
                        ? state.material.ambient.slice() : null,
                    globalAmbient: (rs.get(D3DRS_AMBIENT) || 0) >>> 0,
                } : null;
                if (!samplerIndices.length) {
                    ++this.stats.zeroNormalDrawsWithoutTexture;
                    if (state.material && this.debug.warnOnSuspiciousDraws) {
                        this.warnOnce("zero-normal-no-texture-sample",
                            "a lit draw with no NORMAL does not sample any texture; " +
                            "ambient/material colour therefore becomes a flat " +
                            "silhouette", diagnostic);
                    }
                } else if (missingTexture) {
                    ++this.stats.zeroNormalDrawsWithMissingTexture;
                    if (textureBindings.some(binding =>
                            !binding.live && !binding.handle))
                        ++this.stats.zeroNormalDrawsWithUnboundTexture;
                    if (textureBindings.some(binding =>
                            !binding.live && binding.handle))
                        ++this.stats.zeroNormalDrawsWithUnknownTexture;
                    if (state.material && this.debug.warnOnSuspiciousDraws) {
                        this.warnOnce("zero-normal-missing-texture",
                            "a lit draw with no NORMAL samples an unbound or unknown " +
                            "texture and receives the 1x1 white fallback; its " +
                            "ambient/material colour therefore becomes a flat " +
                            "silhouette", diagnostic);
                    }
                } else {
                    ++this.stats.zeroNormalDrawsWithLiveTexture;
                    if (state.material && this.debug.warnOnSuspiciousDraws) {
                        this.warnOnce("zero-normal-live-texture",
                            "a lit draw with no NORMAL has a live sampled texture; " +
                            "if it is still a flat silhouette, inspect the reported " +
                            "TEXCOORD routing (debug.shaderMode='uv'/'texture' can " +
                            "separate coordinates from texture data)", diagnostic);
                    }
                }
            }
            if (vertexModule._d9wgBroken || fragmentModule._d9wgBroken)
                return { error: "a stage failed WGSL compilation (see the " +
                    "getCompilationInfo error logged at module creation)",
                    shaderError: true };

            const vertexBuffers = this.vertexBufferLayoutsFor(elements, state,
                locationFor, !!drawOptions.pointExpansion);
            if (vertexBuffers === null)
                return { error: "the declaration needs more vertex buffers " +
                    "than WebGPU binds per draw" };
            // A vertex shader input the declaration does not supply reads
            // (0, 0, 0, 1), as D3D9 hardware does, instead of leaving the
            // pipeline without the attribute (an invalid pipeline invalidates
            // the whole command buffer and with it the frame)
            {
                const inputLocations = vertexReflection && vertexReflection.inputs
                    ? vertexReflection.inputs.map(input => input.location)
                    : elements.map(locationFor);
                const supplied = new Set();
                for (const layout of vertexBuffers)
                    for (const attribute of layout.attributes) supplied.add(attribute.shaderLocation);
                const missing = inputLocations
                    .filter(location => location >= 0 && !supplied.has(location));
                if (missing.length) {
                    if (vertexBuffers.length >= MAX_VERTEX_BUFFERS_PER_DRAW)
                        return { error: "the vertex shader reads inputs the declaration " +
                            "does not supply and no vertex buffer slot is left for them" };
                    ++this.stats.drawsWithDefaultedInputs;
                    vertexBuffers.push({ stream: DEFAULT_ATTRIBUTE_STREAM, arrayStride: 0,
                        stepMode: "vertex", attributes: [...new Set(missing)].sort((a, b) => a - b)
                            .map(location => ({ shaderLocation: location, offset: 0,
                                format: "float32x4" })) });
                }
            }
            const pixelUniformLayout = pixelSignature
                ? fixedPixelUniformLayout(pixelSignature) : null;
            // r32/rg32/rgba32 textures are sampleable on baseline WebGPU, but
            // linear filtering is optional.  Carry the physical format into
            // the immutable pipeline layout so an unsupported filtering
            // request degrades to exact point sampling instead of producing
            // an invalid bind group.
            // A stage the translated shader declared texture_depth_2d for is a
            // depth slot in the layout too, and nowhere else: the module and
            // the bind group layout have to agree exactly or pipeline creation
            // fails. The reflection is the only honest source for that, because
            // the translator declines depth treatment it cannot implement
            // (see isDepthSampler there) and reports what it actually emitted.
            const declaredDepth = new Map((pixelReflection
                ? pixelReflection.samplers : [])
                .filter(sampler => sampler.depth)
                .map(sampler => [sampler.index,
                    sampler.depth === "fetch" ? "depth-fetch"
                        : "depth-compare"]));
            const samplerBindingTypes = {};
            for (const index of samplerIndices) {
                if (declaredDepth.has(index)) {
                    samplerBindingTypes[index] = declaredDepth.get(index);
                    continue;
                }
                const texture = this.resources.get(state.textures.get(index));
                const gpuFormat = texture && (texture.gpuFormat ||
                    formatToGPU(texture.format));
                samplerBindingTypes[index] = isFloat32GPUFormat(gpuFormat) &&
                    !this.deviceFeatures.float32Filterable
                    ? "unfilterable" : "filterable";
            }
            let vertexSamplerError = null;
            const vertexSamplers = vertexReflection
                ? vertexReflection.samplers.map(sampler => {
                    const stage = D3DVERTEXTEXTURESAMPLER0 + sampler.index;
                    const texture = this.resources.get(state.textures.get(stage));
                    const bound = texture ? (texture.textureType || "2d") : null;
                    if (bound && bound !== sampler.type)
                        vertexSamplerError = "vertex shader declares sampler " +
                            sampler.index + " as " + sampler.type +
                            " but a " + bound + " texture is bound";
                    const gpuFormat = texture && (texture.gpuFormat ||
                        formatToGPU(texture.format));
                    return { ...sampler, stage,
                        bindingType: isFloat32GPUFormat(gpuFormat) &&
                            !this.deviceFeatures.float32Filterable
                            ? "unfilterable" : "filterable" };
                }) : [];
            if (vertexSamplerError)
                return { error: vertexSamplerError, shaderError: true };
            return { vertexModule, fragmentModule, vertexKey, fragmentKey,
                vertexReflection, pixelReflection, samplerIndices,
                samplerDimensions, samplerBindingTypes, vertexSamplers,
                vertexBuffers,
                fixedFunctionSignature, pixelSignature, pixelUniformLayout,
                vertexUniformLayout: fixedFunctionSignature
                    ? fixedVertexUniformLayout(fixedFunctionSignature) : null,
                // A translated pixel shader brings its own register file; the
                // fixed-function cascade's block is only as large as the fog
                // colour, texture factor and stage constants it actually reads.
                pixelUniformBytes: pixelReflection ? pixelReflection.uniformBytes
                    : (pixelUniformLayout && pixelUniformLayout.entries.length
                        ? pixelUniformLayout.byteLength : 0),
                fogMode, tableFog, pointExpansion: !!drawOptions.pointExpansion,
                pointSprite: !!drawOptions.pointSprite };
        }

        // The per-stage coordinate plan the fixed-function vertex stage needs:
        // which coordinate set (or generated vector) feeds a stage and which
        // matrix transforms it. D3D9 runs this half of fixed-function T&L
        // whether or not a pixel shader is bound, which is why it is not folded
        // into textureCascadeSignature().
        coordStagePlan(state, stageCount, signature) {
            const stageState = (stage, id, fallback) => {
                const value = state.textureStageStates.get(stage * 64 + id);
                return value === undefined ? fallback : value;
            };
            const stages = [];
            for (let index = 0; index < Math.min(stageCount, MAX_TEXTURE_STAGES);
                    ++index) {
                const flags = stageState(index, D3DTSS_TEXTURETRANSFORMFLAGS, 0);
                // D3DTSS_TEXCOORDINDEX defaults to the stage's own number, so an
                // app that never sets it gets stage n reading TEXCOORD n.
                const coordIndex = stageState(index, D3DTSS_TEXCOORDINDEX, index);
                stages.push({ index,
                    texCoordIndex: coordIndex & 0xFFFF,
                    tciMode: coordIndex & D3DTSS_TCI_MASK,
                    inputDimensions: !signature ? 4 : signature.positionType === "screen" || !(coordIndex & D3DTSS_TCI_MASK)
                        ? signature.texCoordDimensions[coordIndex & 0xFFFF] || 4
                        : (coordIndex & D3DTSS_TCI_MASK) === D3DTSS_TCI_SPHEREMAP ? 2 : 3,
                    transformCount: flags & 0xFF,
                    projected: (flags & D3DTTFF_PROJECTED) !== 0 });
            }
            return stages;
        }

        objectId(value) {
            if ((typeof value !== "object" && typeof value !== "function") ||
                    value === null)
                return String(value);
            let id = this.objectIds.get(value);
            if (!id) {
                id = this.nextObjectId++;
                this.objectIds.set(value, id);
            }
            return id;
        }

        // Chunks are created on first use and kept for the page's lifetime;
        // a run that never needs the second one never pays for it.
        uniformRingChunkAt(index) {
            if (!this.device || index >= this.uniformRingMaxChunks) return null;
            let chunk = this.uniformRingChunks[index];
            if (!chunk) {
                chunk = this.device.createBuffer({
                    label: "D3D9 uniform ring " + index,
                    size: this.uniformRingCapacity,
                    usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
                });
                this.uniformRingChunks[index] = chunk;
                this.uniformStaging[index] =
                    new Uint8Array(this.uniformRingCapacity);
                ++this.stats.uniformRingChunksAllocated;
            }
            if (index + 1 > this.stats.uniformRingChunksUsed)
                this.stats.uniformRingChunksUsed = index + 1;
            return chunk;
        }

        allocateUniformSlot(byteCount, retire = true) {
            const size = alignUp(byteCount, UNIFORM_OFFSET_ALIGNMENT);
            // A block wider than a whole chunk cannot be sub-allocated at all.
            if (size <= this.uniformRingCapacity) {
                while (this.uniformRingIndex < this.uniformRingMaxChunks) {
                    const chunk = this.uniformRingChunkAt(this.uniformRingIndex);
                    if (!chunk) break;
                    const offset = alignUp(this.uniformRingCursor,
                        UNIFORM_OFFSET_ALIGNMENT);
                    if (size <= this.uniformRingCapacity - offset) {
                        this.uniformRingCursor = offset + size;
                        return { buffer: chunk, offset, transient: false,
                            chunkIndex: this.uniformRingIndex };
                    }
                    ++this.uniformRingIndex;
                    this.uniformRingCursor = 0;
                }
            }
            // Last resort, and the shape that used to be the *only* overflow
            // path. It is per-draw and uncacheable, so say so once rather than
            // letting a frame quietly allocate tens of thousands of buffers.
            this.warnOnce("uniform-ring-exhausted",
                "a single frame outran " + this.uniformRingMaxChunks +
                " x " + (this.uniformRingCapacity >> 20) + " MiB of uniform " +
                "storage; the remaining draws each allocate their own buffer " +
                "and bind group, which is slow and memory-hungry. Raise " +
                "uniformRingChunks if this frame is legitimate.", {
                    chunkBytes: this.uniformRingCapacity,
                    maxChunks: this.uniformRingMaxChunks,
                    requestedBytes: size,
                });
            const buffer = this.device.createBuffer({
                label: "D3D9 uniform ring overflow",
                size,
                usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
            });
            ++this.stats.uniformRingOverflows;
            // Replay-time utility passes retire through their active frame;
            // ensureFrame() here would create a new frame and rewind its ring.
            if (retire) this.retireAfterSubmit(buffer);
            return { buffer, offset: 0, transient: true, chunkIndex: -1 };
        }

        /*
         * One writeBuffer per submit instead of one per draw.
         *
         * This is what a real D3D9 driver does with constants: it writes them
         * into a mapped ring with a plain CPU pointer and only rings the
         * doorbell when the buffer fills or a sync point demands it. Calling
         * queue.writeBuffer per draw was the missing piece -- an API call, with
         * its own staging allocation and validation, for every 300-odd bytes.
         *
         * Ordering is what makes it safe to defer: queue.writeBuffer and
         * queue.submit are both queue operations, so a write issued before the
         * submit is visible to every draw in it.
         */
        uploadUniformStaging() {
            for (let index = 0; index <= this.uniformRingIndex; ++index) {
                const chunk = this.uniformRingChunks[index];
                const staging = this.uniformStaging[index];
                if (!chunk || !staging) break;
                // Chunks before the current one were filled to capacity; the
                // current one is filled to the cursor. Both are multiples of
                // UNIFORM_OFFSET_ALIGNMENT, so the 4-byte size rule holds.
                const used = index < this.uniformRingIndex
                    ? this.uniformRingCapacity : this.uniformRingCursor;
                if (!used) continue;
                this.device.queue.writeBuffer(chunk, 0, staging, 0, used);
                ++this.stats.uniformStagingUploads;
                this.stats.constantUploadBytes += used;
            }
        }

        /*
         * Both stages share one uniform ring. Each binding uses the same dynamic
         * base offset, while binding 1's static pixelOffset keeps the two
         * register files separate.
         *
         * A run of draws with no state change between them shares one slot, and
         * that is decided by uniformSerial rather than by hashing the assembled
         * bytes. The frame serial is part of the test because a flush rewinds
         * the ring: a slot from an already-submitted segment has had its bytes
         * handed back out to a later draw.
         */
        constantBufferFor(state, program) {
            const frame = this.ensureFrame();
            /*
             * Two things have to hold for the previous slot to still describe
             * this draw, and between them they cover the programmable and the
             * fixed-function paths without special-casing either.
             *
             * The serial covers device state. Every input the block is built
             * from -- constant registers, `def` defaults, viewport, clip planes,
             * transforms, lights, material, texture stage state -- moves only
             * through a command. Pipeline-only states and an unused texture
             * factor do not invalidate these bytes; all other commands do.
             *
             * The module keys cover the program, including uncached/direct
             * builder calls. vertexKey/fragmentKey are the keys its WGSL modules
             * are cached under: equal keys mean the same generated shader, hence
             * the same uniform layout and, for fixed function, the same
             * signature the values are read through. That is what makes point
             * expansion safe -- it comes from the draw's primitive type rather
             * than from state, and it is part of the key.
             *
             * The frame serial is in the test because a flush rewinds the ring:
             * a slot from an already-submitted segment has had its bytes handed
             * back out to a later draw.
             */
            const cached = state.lastConstants;
            if (cached && cached.serial === this.uniformSerial &&
                    cached.frameSerial === frame.serial &&
                    cached.vertexKey === program.vertexKey &&
                    cached.fragmentKey === program.fragmentKey) {
                ++this.stats.uniformSlotReuses;
                return cached.slot;
            }
            const vertexBytes = program.vertexReflection
                ? program.vertexReflection.uniformBytes
                : program.vertexUniformLayout.byteLength;
            const pixelBytes = program.pixelUniformBytes || 0;
            const pixelOffset = pixelBytes
                ? alignUp(vertexBytes, UNIFORM_OFFSET_ALIGNMENT) : 0;
            const total = Math.max(16, vertexBytes, pixelOffset + pixelBytes);
            const backing = new ArrayBuffer(alignUp(total, 4));

            if (program.vertexReflection) {
                this.writeConstantRegisters(backing, 0, program.vertexReflection,
                    state.vsConstF, state.vsConstI, state.vsConstB, state);
            } else {
                this.writeFixedVertexUniforms(state, program, backing, 0);
            }
            if (program.pixelReflection) {
                this.writeConstantRegisters(backing, pixelOffset,
                    program.pixelReflection, state.psConstF, state.psConstI,
                    state.psConstB, state);
            } else if (pixelBytes) {
                this.writeFixedPixelUniforms(state, program, backing, pixelOffset);
            }

            const slot = this.allocateUniformSlot(backing.byteLength);
            if (slot.chunkIndex >= 0) {
                // Into the mirror; uploadUniformStaging() sends the whole used
                // prefix once, just before this frame's submit.
                this.uniformStaging[slot.chunkIndex].set(
                    new Uint8Array(backing), slot.offset);
            } else {
                // The overflow buffer is its own allocation and is destroyed
                // after this submit, so it has no mirror to write into.
                this.device.queue.writeBuffer(slot.buffer, slot.offset, backing);
                this.stats.constantUploadBytes += backing.byteLength;
            }
            const constants = { buffer: slot.buffer, dynamicOffset: slot.offset,
                vertexBytes, pixelOffset, pixelBytes,
                transient: slot.transient };
            state.lastConstants = { serial: this.uniformSerial,
                frameSerial: frame.serial, vertexKey: program.vertexKey,
                fragmentKey: program.fragmentKey, slot: constants };
            return constants;
        }

        // Fills the fixed-function vertex block. The field list comes from
        // fixedVertexUniformLayout(), the same call the WGSL struct was
        // generated from, so a field that exists in one exists in the other.
        //
        // D3D stores matrices row-major for row-vector maths (v * M); WGSL reads
        // a uniform mat4x4 column-major and applies M * v. Those two conventions
        // cancel: the *same bytes* that describe M to D3D describe M-transpose
        // to WGSL, and M-transpose is exactly the column-vector form of D3D's
        // row-vector M. So every matrix here is uploaded unchanged.
        writeFixedVertexUniforms(state, program, backing, byteOffset) {
            const signature = program.fixedFunctionSignature;
            const layout = program.vertexUniformLayout;
            const rs = state.renderStates;
            const floats = new Float32Array(backing, byteOffset,
                layout.byteLength / 4);
            const at = name => {
                const entry = layout.byName.get(name);
                return entry ? entry.offset / 4 : -1;
            };
            const screenSpace = signature.positionType === "screen";
            const blend = signature.vertexBlend;
            const view = state.transforms.get(D3DTS_VIEW) || IDENTITY4x4;
            // A blended draw's world half is applied per vertex from
            // blend_worlds, so what is pre-multiplied here stops at the view.
            const preVertex = blend ? view : multiply4x4(
                state.transforms.get(D3DTS_WORLD) || IDENTITY4x4, view);

            if (blend) {
                floats.set(multiply4x4(view,
                    state.transforms.get(D3DTS_PROJECTION) || IDENTITY4x4),
                    at("view_projection"));
                const base = at("blend_worlds"), normalBase = at("blend_normals");
                for (let slot = 0; slot < blend.matrixSlots; ++slot) {
                    const world = state.transforms.get(D3DTS_WORLD + slot) || IDENTITY4x4;
                    floats.set(world, base + slot * 16);
                    if (normalBase >= 0) floats.set(inverseTranspose3x3(world), normalBase + slot * 16);
                }
            } else {
                floats.set(screenSpace ? IDENTITY4x4 : this.wvp(state),
                    at("world_view_projection"));
                if (layout.byName.has("world_matrix"))
                    floats.set(state.transforms.get(D3DTS_WORLD) || IDENTITY4x4,
                        at("world_matrix"));
            }
            if (layout.byName.has("tween_params"))
                floats[at("tween_params")] = floatFromDWORD(rs.get(D3DRS_TWEENFACTOR) || 0);
            const viewport = at("viewport");
            floats[viewport] = state.viewport.width || 1;
            floats[viewport + 1] = state.viewport.height || 1;
            // zw carry the viewport's origin, which the XYZRHW path subtracts:
            // D3D9 pre-transformed coordinates are absolute render-target
            // pixels, not viewport-relative ones.
            floats[viewport + 2] = state.viewport.x || 0;
            floats[viewport + 3] = state.viewport.y || 0;
            if (layout.byName.has("clip_planes")) {
                const base = at("clip_planes");
                const mask = (rs.get(D3DRS_CLIPPLANEENABLE) || 0) & 0x3f;
                for (let plane = 0; plane < signature.clipPlaneCount; ++plane)
                    floats.set((mask & (1 << plane))
                        ? state.clipPlanes[plane] : [0, 0, 0, 1],
                        base + plane * 4);
            }

            const viewSpaceField = blend ? "view_matrix" : "world_view";
            if (layout.byName.has(viewSpaceField)) {
                floats.set(preVertex, at(viewSpaceField));
                floats.set(inverseTranspose3x3(preVertex), at("normal_matrix"));
            }
            if (layout.byName.has("fog_params")) {
                // FOGSTART/FOGEND/FOGDENSITY are floats carried inside a DWORD.
                const asFloat = (id, fallback) => {
                    const raw = rs.get(id);
                    if (raw === undefined) return fallback;
                    FLOAT_BITS_U32[0] = raw >>> 0;
                    return FLOAT_BITS_F32[0];
                };
                const base = at("fog_params");
                floats[base] = asFloat(D3DRS_FOGSTART, 0);
                floats[base + 1] = asFloat(D3DRS_FOGEND, 1);
                floats[base + 2] = asFloat(D3DRS_FOGDENSITY, 1);
            }
            for (const stage of signature.coordStages) {
                if (!layout.byName.has("texture_transform" + stage.index)) continue;
                floats.set(state.transforms.get(D3DTS_TEXTURE0 + stage.index) ||
                    IDENTITY4x4, at("texture_transform" + stage.index));
            }
            if (signature.pointExpansion) {
                const pointFloat = (id, fallback) => {
                    const raw = rs.get(id);
                    return raw === undefined ? fallback : floatFromDWORD(raw);
                };
                const pointViewport = at("point_viewport");
                const width = Math.max(1, state.viewport.width || 1);
                const height = Math.max(1, state.viewport.height || 1);
                floats[pointViewport] = width;
                floats[pointViewport + 1] = height;
                floats[pointViewport + 2] = 1 / width;
                floats[pointViewport + 3] = 1 / height;
                const pointParams = at("point_params");
                floats[pointParams] = pointFloat(D3DRS_POINTSIZE, 1);
                floats[pointParams + 1] = Math.max(0,
                    pointFloat(D3DRS_POINTSIZE_MIN, 1));
                floats[pointParams + 2] = Math.max(floats[pointParams + 1],
                    pointFloat(D3DRS_POINTSIZE_MAX, 64));
                if (signature.pointScale) {
                    const pointScale = at("point_scale");
                    floats[pointScale] = pointFloat(D3DRS_POINTSCALE_A, 1);
                    floats[pointScale + 1] = pointFloat(D3DRS_POINTSCALE_B, 0);
                    floats[pointScale + 2] = pointFloat(D3DRS_POINTSCALE_C, 0);
                }
            }
            if (!signature.lighting) return;

            // D3D9's default material is not all zeroes: a device that never
            // calls SetMaterial still lights with white diffuse/ambient. Using
            // zeroes here would make "the app forgot SetMaterial" and "the app
            // asked for black" indistinguishable, and the former renders black.
            const material = state.material || DEFAULT_MATERIAL;
            floats.set(material.diffuse, at("material_diffuse"));
            floats.set(material.ambient, at("material_ambient"));
            floats.set(material.specular, at("material_specular"));
            floats.set(material.emissive, at("material_emissive"));
            const ambientPower = at("ambient_power");
            const ambient = rs.get(D3DRS_AMBIENT) || 0;
            floats[ambientPower] = ((ambient >>> 16) & 0xff) / 255;
            floats[ambientPower + 1] = ((ambient >>> 8) & 0xff) / 255;
            floats[ambientPower + 2] = (ambient & 0xff) / 255;
            floats[ambientPower + 3] = material.power;

            if (!signature.lighting.lights.length) return;
            // Lights arrive in world space and are lit in view space (which is
            // where D3D9's fixed pipeline puts them), so the view transform is
            // applied here rather than carried into the shader as a second
            // matrix: eight lights is at most a few dozen multiplies per draw,
            // against a full mat4 the vertex stage would otherwise re-apply per
            // vertex.
            let base = at("lights");
            for (const entry of signature.lighting.lights) {
                const light = state.lights.get(entry.index);
                floats.set(light.diffuse, base);
                floats.set(light.specular, base + 4);
                floats.set(light.ambient, base + 8);
                // D3D7 parallel-point lights use the normalized view-space
                // position as a direction, with no range or attenuation.
                const transformedPosition = transformPoint(view, light.position);
                const position = light.type === D3DLIGHT_PARALLELPOINT ? normalize3(transformedPosition) : transformedPosition;
                floats[base + 12] = position[0];
                floats[base + 13] = position[1];
                floats[base + 14] = position[2];
                floats[base + 15] = 1;
                const direction = normalize3(transformDirection(view, light.direction));
                floats[base + 16] = direction[0];
                floats[base + 17] = direction[1];
                floats[base + 18] = direction[2];
                floats[base + 19] = 0;
                floats[base + 20] = light.range;
                floats[base + 21] = light.falloff;
                // D3D9's Theta/Phi are the *full* cone angles, so the cosine
                // compared against rho is of the half angle.
                floats[base + 22] = Math.cos(light.theta / 2);
                floats[base + 23] = Math.cos(light.phi / 2);
                floats[base + 24] = light.attenuation[0];
                floats[base + 25] = light.attenuation[1];
                floats[base + 26] = light.attenuation[2];
                floats[base + 27] = light.type;
                base += 28;
            }
        }

        writeSamplerLodBias(state, floats, offset, count) {
            for (let index = 0; index < count; index++)
                floats[offset + index] = lodBiasFor(state.samplerStates.get(index * 64 + D3DSAMP_MIPMAPLODBIAS) || 0);
        }

        writeFogUniforms(state, floats, color, params) {
            const argb = state.renderStates.get(D3DRS_FOGCOLOR) || 0;
            floats[color] = ((argb >>> 16) & 255) / 255;
            floats[color + 1] = ((argb >>> 8) & 255) / 255;
            floats[color + 2] = (argb & 255) / 255;
            floats[color + 3] = 1;
            if (params < 0) return;
            const value = (id, fallback) => state.renderStates.has(id) ? floatFromDWORD(state.renderStates.get(id)) : fallback;
            floats[params] = value(D3DRS_FOGSTART, 0);
            floats[params + 1] = value(D3DRS_FOGEND, 1);
            floats[params + 2] = value(D3DRS_FOGDENSITY, 1);
            const projection = state.transforms.get(D3DTS_PROJECTION) || IDENTITY4x4;
            floats[params + 3] = projection[3] === 0 && projection[7] === 0 && projection[11] === 0 && projection[15] === 1 ? 1 : 0;
        }

        // Fills the fixed-function pixel block: only the fog inputs, texture
        // factor and per-stage constants the cascade actually reads.
        writeFixedPixelUniforms(state, program, backing, byteOffset) {
            const layout = program.pixelUniformLayout;
            const floats = new Float32Array(backing, byteOffset,
                layout.byteLength / 4);
            const writeColor = (index, argb, alpha) => {
                floats[index] = ((argb >>> 16) & 0xff) / 255;
                floats[index + 1] = ((argb >>> 8) & 0xff) / 255;
                floats[index + 2] = (argb & 0xff) / 255;
                floats[index + 3] = alpha === undefined
                    ? ((argb >>> 24) & 0xff) / 255 : alpha;
            };
            for (const entry of layout.entries) {
                if (entry.name === "sampler_lod_bias") {
                    this.writeSamplerLodBias(state, floats, entry.offset / 4, entry.samplerBiasCount);
                } else if (entry.name === "alpha_test") {
                    new Uint32Array(backing, byteOffset + entry.offset, 4)[0] = (state.renderStates.get(D3DRS_ALPHAREF) || 0) & 255;
                } else if (entry.name === "fog_color") {
                    const params = layout.byName.get("fog_params");
                    this.writeFogUniforms(state, floats, entry.offset / 4, params ? params.offset / 4 : -1);
                } else if (entry.name === "fog_params") {
                    // Written together with fog_color above.
                } else if (entry.name === "texture_factor") {
                    writeColor(entry.offset / 4,
                        state.renderStates.get(D3DRS_TEXTUREFACTOR) === undefined
                            ? 0xffffffff
                            : state.renderStates.get(D3DRS_TEXTUREFACTOR));
                } else if (entry.bumpSource !== undefined) {
                    // BUMPENVMAT00/01/10/11 hold raw float bits, like the fog
                    // states above. Packed as (m00, m01, m10, m11).
                    const base = entry.offset / 4;
                    const stageState = id => {
                        const raw = state.textureStageStates.get(
                            entry.bumpSource * 64 + id);
                        if (raw === undefined) return 0;
                        FLOAT_BITS_U32[0] = raw >>> 0;
                        return FLOAT_BITS_F32[0];
                    };
                    floats[base] = stageState(D3DTSS_BUMPENVMAT00);
                    floats[base + 1] = stageState(D3DTSS_BUMPENVMAT01);
                    floats[base + 2] = stageState(D3DTSS_BUMPENVMAT10);
                    floats[base + 3] = stageState(D3DTSS_BUMPENVMAT11);
                } else if (entry.bumpLuminanceSource !== undefined) {
                    const base = entry.offset / 4;
                    const stageState = id => {
                        const raw = state.textureStageStates.get(
                            entry.bumpLuminanceSource * 64 + id);
                        if (raw === undefined) return 0;
                        FLOAT_BITS_U32[0] = raw >>> 0;
                        return FLOAT_BITS_F32[0];
                    };
                    floats[base] = stageState(D3DTSS_BUMPENVLSCALE);
                    floats[base + 1] = stageState(D3DTSS_BUMPENVLOFFSET);
                    floats[base + 2] = 0;
                    floats[base + 3] = 0;
                } else {
                    // stage_constant<N>; zero is a valid RGBA constant and
                    // must keep its transparent alpha when written as zero.
                    writeColor(entry.offset / 4,
                        state.textureStageStates.get(
                            entry.source * 64 + D3DTSS_CONSTANT) ?? 0);
                }
            }
        }

        // Packs one stage's register file into the layout the translated WGSL
        // declares (plan 9.7): float4 c# registers, then int4 i#, then one
        // 32-bit slot per bool b#. `def`/`defi`/`defb` literals are written
        // last because a shader's own constant definitions take effect while
        // it is bound, over whatever the app last set for that register.
        writeConstantRegisters(backing, byteOffset, reflection, constF, constI,
                constB, state) {
            const floats = new Float32Array(backing, byteOffset,
                reflection.floatConstCount * 4);
            floats.set(constF.subarray(0, Math.min(constF.length, floats.length)));
            for (const item of reflection.floatDefaults) {
                if ((item.register + 1) * 4 > floats.length) continue;
                floats.set(item.values, item.register * 4);
            }
            const intOffset = byteOffset + reflection.floatRegionBytes;
            const ints = new Int32Array(backing, intOffset, reflection.intConstCount * 4);
            ints.set(constI.subarray(0, Math.min(constI.length, ints.length)));
            for (const item of reflection.intDefaults) {
                if ((item.register + 1) * 4 > ints.length) continue;
                ints.set(item.values, item.register * 4);
            }
            const boolOffset = intOffset + reflection.intRegionBytes;
            const bools = new Uint32Array(backing, boolOffset,
                reflection.boolVectorCount * 4);
            bools.set(constB.subarray(0, Math.min(constB.length, bools.length)));
            for (const item of reflection.boolDefaults) {
                if (item.register >= bools.length) continue;
                bools[item.register] = item.value ? 1 : 0;
            }
            // Every translated vertex shader reads this for the D3D9 half-pixel
            // offset (see the o_position fixup in d3d9_shader_pipeline.js). The
            // viewport is what maps clip space to pixels, so it -- not the
            // render target extent -- is what a half pixel is measured against.
            if (reflection.viewportOffset >= 0 && state) {
                const values = new Float32Array(backing, byteOffset);
                const slot = reflection.viewportOffset / 4;
                values[slot] = Math.max(1, state.viewport.width || 1);
                values[slot + 1] = Math.max(1, state.viewport.height || 1);
            }
            if (reflection.clipPlanesOffset >= 0 && state) {
                const values = new Float32Array(backing, byteOffset);
                const base = reflection.clipPlanesOffset / 4;
                const mask = (state.renderStates.get(
                    D3DRS_CLIPPLANEENABLE) || 0) & 0x3f;
                for (let plane = 0; plane < reflection.clipPlaneCount; ++plane)
                    values.set((mask & (1 << plane))
                        ? state.clipPlanes[plane] : [0, 0, 0, 1],
                        base + plane * 4);
            }
            if (reflection.samplerLodBiasOffset >= 0 && state) {
                this.writeSamplerLodBias(state, new Float32Array(backing, byteOffset), reflection.samplerLodBiasOffset / 4, reflection.samplerBiasCount);
            }
            if (reflection.alphaTestOffset >= 0 && state) {
                new Uint32Array(backing, byteOffset + reflection.alphaTestOffset, 4)[0] = (state.renderStates.get(D3DRS_ALPHAREF) || 0) & 255;
            }
            if (reflection.fogOffset >= 0 && state) {
                const floats = new Float32Array(backing, byteOffset);
                this.writeFogUniforms(state, floats, reflection.fogOffset / 4, reflection.fogOffset / 4 + 4);
            }
            if (reflection.bumpStageCount && state) {
                // ps_1_x texbem/texbeml read the D3DTSS_BUMPENVMAT* matrix of
                // the sampler they address. That is texture-stage state rather
                // than shader state, so it is written here alongside the
                // register file rather than coming from SetPixelShaderConstant.
                const values = new Float32Array(backing, byteOffset);
                const stageFloat = (stage, id) => {
                    const raw = state.textureStageStates.get(stage * 64 + id);
                    if (raw === undefined) return 0;
                    FLOAT_BITS_U32[0] = raw >>> 0;
                    return FLOAT_BITS_F32[0];
                };
                for (let stage = 0; stage < reflection.bumpStageCount; ++stage) {
                    const base = reflection.bumpOffset / 4 + stage * 4;
                    values[base] = stageFloat(stage, D3DTSS_BUMPENVMAT00);
                    values[base + 1] = stageFloat(stage, D3DTSS_BUMPENVMAT01);
                    values[base + 2] = stageFloat(stage, D3DTSS_BUMPENVMAT10);
                    values[base + 3] = stageFloat(stage, D3DTSS_BUMPENVMAT11);
                    const lum = reflection.bumpLuminanceOffset / 4 + stage * 4;
                    values[lum] = stageFloat(stage, D3DTSS_BUMPENVLSCALE);
                    values[lum + 1] = stageFloat(stage, D3DTSS_BUMPENVLOFFSET);
                    values[lum + 2] = 0;
                    values[lum + 3] = 0;
                }
            }
            if (reflection.pointExpansion && state) {
                const values = new Float32Array(backing, byteOffset);
                const viewport = reflection.pointViewportOffset / 4;
                const width = Math.max(1, state.viewport.width || 1);
                const height = Math.max(1, state.viewport.height || 1);
                values[viewport] = width;
                values[viewport + 1] = height;
                values[viewport + 2] = 1 / width;
                values[viewport + 3] = 1 / height;
                const point = reflection.pointParamsOffset / 4;
                const pointFloat = (id, fallback) => {
                    const raw = state.renderStates.get(id);
                    return raw === undefined ? fallback : floatFromDWORD(raw);
                };
                values[point] = pointFloat(D3DRS_POINTSIZE, 1);
                values[point + 1] = Math.max(0,
                    pointFloat(D3DRS_POINTSIZE_MIN, 1));
                values[point + 2] = Math.max(values[point + 1],
                    pointFloat(D3DRS_POINTSIZE_MAX, 64));
            }
        }

        // The view a stage samples through. D3DSAMP_SRGBTEXTURE asks D3D9 to
        // decode the texture from sRGB to linear on read; ignoring it hands the
        // shader values that are substantially *brighter* than the app intends
        // (sRGB 0.5 is linear 0.21), which on anything additive -- an
        // environment-mapped reflection above all -- reads as blown-out white
        // rather than as a subtle gamma difference.
        // The single point where a sampler stage turns into a bind group
        // resource, and the only one allowed to decide that a bound texture
        // cannot be sampled. Every path out of here returns a real view:
        // createBindGroup rejects null with a TypeError rather than a WebGPU
        // validation error, so it escapes executeBatch and destroys the rest of
        // the batch -- the draw that could not be drawn takes every unrelated
        // command queued behind it along with it. A visibly wrong stage is a
        // far smaller fault than a silently truncated command stream.
        viewForStage(texture, stage, depth, dimension, unfilterable, wantsSRGB,
                isCurrentDepthAttachment) {
            if (!texture)
                return this.fallbackViewFor(depth ? "depth" : dimension,
                    unfilterable);
            // WebGPU forbids a texture being an attachment and a sampled
            // resource in the same pass, and enforces it by failing the submit
            // rather than the draw. The normal shadow-map sequence unbinds the
            // map before reading it, so this is the app doing something D3D9
            // tolerates and WebGPU does not -- one degraded stage is the only
            // outcome that keeps the rest of the frame alive.
            if (isCurrentDepthAttachment) {
                ++this.stats.depthAttachmentSampledInPlace;
                this.warnOnce("depth-attachment-sampled-" + stage,
                    "a depth surface is sampled while it is still bound as " +
                    "this pass's depth attachment; WebGPU cannot read and " +
                    "write one texture in a single pass, so the stage reads " +
                    "the fallback", { stage });
                return this.fallbackViewFor(depth ? "depth" : dimension,
                    unfilterable);
            }
            if (depth) {
                // The layout says texture_depth_2d; only a depth texture can
                // fill it. A colour texture bound to a stage the shader samples
                // as a shadow map means the app changed bindings without the
                // pipeline being rebuilt, which the pipeline key rules out --
                // but the cost of being wrong is the whole submit.
                if (texture.isDepth && texture.view) return texture.view;
                ++this.stats.depthStageWithoutDepthTexture;
                this.warnOnce("depth-stage-not-depth-" + stage,
                    "a stage the pixel shader samples as a hardware shadow " +
                    "map has no sampleable depth texture bound; it reads the " +
                    "1x1 depth fallback, which compares as fully lit", {
                        stage,
                        format: texture.format,
                        isDepth: !!texture.isDepth,
                    });
                return this.fallbackViewFor("depth", false);
            }
            if (texture.isDepth) {
                // Reachable through the fixed-function cascade and through
                // vertex texture fetch, neither of which has a comparison
                // reference to offer. Sampling the raw depth aspect through a
                // float layout entry is not merely wrong, it is invalid.
                ++this.stats.depthTextureOnNonDepthStage;
                this.warnOnce("depth-texture-plain-stage-" + stage,
                    "a depth texture is bound to a stage that is not a " +
                    "translated pixel shader's shadow-map sampler (fixed " +
                    "function, or vertex texture fetch); D3D9 would return a " +
                    "hardware comparison there and this backend has no " +
                    "reference value to compare against, so the stage reads " +
                    "the 1x1 white fallback", { stage, format: texture.format });
                return this.fallbackViewFor(dimension, unfilterable);
            }
            const view = this.sampledViewFor(texture, wantsSRGB);
            if (view) return view;
            ++this.stats.stagesWithoutSampleableView;
            this.warnOnce("stage-no-view-" + stage,
                "a bound texture has no sampleable view; the stage reads the " +
                "1x1 white fallback rather than failing the draw", {
                    stage, format: texture.format,
                    gpuFormat: texture.gpuFormat });
            return this.fallbackViewFor(dimension, unfilterable);
        }

        // D3D9 hardware shadow maps return 1.0 where the reference depth is at
        // or in front of the stored depth, i.e. where the fragment is lit.
        // Filtering is what makes the comparison a PCF tap rather than a hard
        // test, so it follows the stage's own filter state: a shadow map
        // sampled with POINT should not silently acquire soft edges.
        comparisonSamplerFor(state, stage) {
            const get = (id, fallback) => {
                const value = state.samplerStates.get(stage * 64 + id);
                return value === undefined ? fallback : value;
            };
            const addressU = get(D3DSAMP_ADDRESSU, 1);
            const addressV = get(D3DSAMP_ADDRESSV, 1);
            const magFilter = FILTER_MODES[get(D3DSAMP_MAGFILTER, 1)] || "nearest";
            const minFilter = FILTER_MODES[get(D3DSAMP_MINFILTER, 1)] || "nearest";
            const key = "cmp," + addressU + "," + addressV + "," +
                magFilter + "," + minFilter;
            const cached = this.samplerCache.get(key);
            if (cached) { ++this.stats.samplerHits; return cached; }
            const sampler = this.device.createSampler({
                addressModeU: ADDRESS_MODES[addressU] || "repeat",
                addressModeV: ADDRESS_MODES[addressV] || "repeat",
                magFilter,
                minFilter,
                compare: "less-equal",
            });
            ++this.stats.samplersCreated;
            ++this.stats.comparisonSamplersCreated;
            this.samplerCache.set(key, sampler);
            return sampler;
        }

        retireAfterSubmit(buffer) {
            const frame = this.ensureFrame();
            (frame.transientBuffers || (frame.transientBuffers = [])).push(buffer);
        }

        bindGroupFor(state, pipeline, program, constants) {
            const entries = [{ binding: 0, resource: { buffer: constants.buffer,
                offset: 0, size: Math.max(16, constants.vertexBytes) } }];
            const identity = [pipeline._d9wgId || this.objectId(pipeline),
                this.objectId(constants.buffer), constants.vertexBytes,
                constants.pixelOffset, constants.pixelBytes];
            if (program.pixelUniformBytes)
                entries.push({ binding: 1, resource: { buffer: constants.buffer,
                    offset: constants.pixelOffset,
                    size: Math.max(16, constants.pixelBytes) } });
            for (const index of program.samplerIndices) {
                const handle = state.textures.get(index);
                const texture = this.resources.get(handle);
                if (texture && texture.mipsDirty) this.flushGeneratedMips(texture);
                if (texture && this.frame) texture.frameReferenced = this.frame.serial;
                const expectedUploads = texture
                    ? texture.levelCount * (texture.layerCount || 1) : 0;
                // A completely untouched texture is not evidence of a lost
                // upload.  D3D permits a dynamic/scratch texture to be bound
                // before its first write (3DMark 99 does this for the 256x256
                // frame-capture texture), and WebGPU safely zero-initialises
                // the allocation meanwhile.  Only a partially initialised
                // chain proves that the app supplied some subresources while
                // leaving other mip levels or cube faces unavailable.
                const initializedUploads = texture && texture.uploadedLevels
                    ? texture.uploadedLevels.size : 0;
                if (texture && texture.uploadedLevels &&
                        initializedUploads > 0 &&
                        initializedUploads < expectedUploads) {
                    ++this.stats.drawsWithIncompleteMipChain;
                    this.warnOnce("incomplete-mips",
                        "a bound texture has a partially initialized mip or " +
                        "cube-face chain; sampling a missing subresource can " +
                        "show the wrong image. Try " +
                        "v86gl.d3d9Executor.debug.forceMipLevel0 = true to " +
                        "check whether missing mip levels are responsible.", {
                            handle,
                            format: texture.format,
                            size: texture.width + "x" + texture.height,
                            declaredLevels: texture.levelCount,
                            layers: texture.layerCount || 1,
                            uploaded: [...texture.uploadedLevels].sort(
                                (a, b) => a - b).map(key =>
                                    "level " + Math.floor(key / 6) +
                                    " layer " + (key % 6)),
                        });
                }
                // A shader can sample a stage the app left unbound; a 1x1 white
                // texture keeps the draw legal and visually neutral rather than
                // dropping it. It has to match the dimension the layout
                // declares, so there is one per dimension.
                const dimension = (program.samplerDimensions &&
                    program.samplerDimensions[index]) || "2d";
                const bindingType = program.samplerBindingTypes &&
                    program.samplerBindingTypes[index];
                const unfilterable = bindingType === "unfilterable";
                const compare = bindingType === "depth-compare";
                const depth = compare || bindingType === "depth-fetch";
                const wantsSRGB = texture &&
                    (state.samplerStates.get(index * 64 + D3DSAMP_SRGBTEXTURE)
                        || 0) !== 0;
                const fixedStage = program.pixelSignature &&
                    program.pixelSignature.stages.find(stage =>
                        stage.index === index);
                const indexedView = texture && texture.ddIndexed &&
                    typeof this.ddIndexedSampleViewFor === "function"
                    ? this.ddIndexedSampleViewFor(texture,
                        fixedStage ? fixedStage.colorKey : null)
                    : null;
                const view = indexedView || this.viewForStage(texture, index,
                    depth, dimension, unfilterable, wantsSRGB,
                    !!handle && handle === state.depthTargetHandle);
                const sampler = compare
                    ? this.comparisonSamplerFor(state, index)
                    : this.samplerFor(state, index, depth || unfilterable,
                        texture);
                entries.push(
                    { binding: 2 + index * 2,
                      resource: view },
                    { binding: 3 + index * 2,
                      resource: sampler });
                identity.push(index, this.objectId(view), this.objectId(sampler));
            }
            for (const binding of program.vertexSamplers || []) {
                const texture = this.resources.get(
                    state.textures.get(binding.stage));
                if (texture && texture.mipsDirty) this.flushGeneratedMips(texture);
                if (texture && this.frame)
                    texture.frameReferenced = this.frame.serial;
                const unfilterable = binding.bindingType === "unfilterable";
                const wantsSRGB = texture &&
                    (state.samplerStates.get(binding.stage * 64 +
                        D3DSAMP_SRGBTEXTURE) || 0) !== 0;
                const view = this.viewForStage(texture, binding.stage, false,
                    binding.type, unfilterable, wantsSRGB);
                const sampler = this.samplerFor(state, binding.stage,
                    unfilterable, texture);
                entries.push(
                    { binding: binding.textureBinding, resource: view },
                    { binding: binding.samplerBinding, resource: sampler });
                identity.push(binding.stage, this.objectId(view),
                    this.objectId(sampler));
            }
            const dynamicOffsets = program.pixelUniformBytes
                ? [constants.dynamicOffset, constants.dynamicOffset]
                : [constants.dynamicOffset];
            // Overflow buffers are destroyed after this submit, so a group
            // that captures one must not outlive the frame. The persistent
            // ring is the steady-state path and is safe to cache.
            const cacheable = !constants.transient;
            const key = identity.join(":");
            if (cacheable) {
                const cached = this.bindGroupCache.get(key);
                if (cached) {
                    this.bindGroupCache.delete(key);
                    this.bindGroupCache.set(key, cached);
                    ++this.stats.bindGroupHits;
                    return { group: cached, dynamicOffsets };
                }
            }
            const created = this.gpuErrors.scoped("bind group", () => this.device.createBindGroup(
                { layout: pipeline._bindGroupLayout, entries }));
            const group = created.object;
            created.checked.then(error => { if (error) group._d9wgRejected = error; });
            ++this.stats.bindGroupCreations;
            if (cacheable) {
                while (this.bindGroupCache.size >= this.maxBindGroups) {
                    const oldest = this.bindGroupCache.keys().next();
                    if (oldest.done) break;
                    this.bindGroupCache.delete(oldest.value);
                    ++this.stats.bindGroupCacheEvictions;
                }
                this.bindGroupCache.set(key, group);
            }
            return { group, dynamicOffsets };
        }

        // Every draw path below can bail out for several different reasons,
        // and silently dropping them looks identical to "the app never drew"
        // from the outside -- exactly the blind spot that hid a stalled
        // renderer behind healthy-looking batch/present counters. Count every
        // drop and describe the first one in full.
        noteDroppedDraw(which, state, reasons) {
            ++this.stats.droppedDraws;
            const key = which + ":" + reasons.join(";");
            this.droppedDrawReasons = this.droppedDrawReasons || new Set();
            if (this.droppedDrawReasons.has(key)) return;
            this.droppedDrawReasons.add(key);
            const declaration = this.resources.get(state.vertexDeclarationHandle);
            console.warn("[d3d9-webgpu] " + which + " dropped: " +
                reasons.join("; "), {
                    reasons,
                    hasFvfElements: !!state.fvfElements,
                    vertexDeclarationHandle: state.vertexDeclarationHandle,
                    declarationResourceFound: !!declaration,
                    declarationElements: this.currentElements(state),
                    vertexShaderHandle: state.vertexShaderHandle,
                    pixelShaderHandle: state.pixelShaderHandle,
                    stream0: state.streams.get(0) || null,
                    indexBufferHandle: state.indexBufferHandle,
                    resourceCount: this.resources.size,
                });
        }

        // Collects the vertex buffers a draw will bind, keyed by stream. The
        // per-stream byte offset folds in both SetStreamSource's OffsetInBytes
        // and (for a non-indexed draw) StartVertex, because WebGPU takes the
        // first-vertex offset on setVertexBuffer rather than on draw().
        boundStreams(state, extraVertexOffset) {
            const streams = new Map();
            for (const [index, binding] of state.streams) {
                const resource = this.resources.get(binding.bufferHandle);
                if (!resource || !resource.gpuBuffer) continue;
                const frequency = (binding.frequency ?? 1) >>> 0;
                const instanced =
                    (frequency & D3DSTREAMSOURCE_INSTANCEDATA) !== 0;
                streams.set(index, { buffer: resource.gpuBuffer, resource,
                    stride: binding.stride || 0, frequency,
                    offset: (binding.offsetInBytes || 0) +
                        (instanced ? 0 : (extraVertexOffset || 0)) *
                            (binding.stride || 0) });
            }
            return streams;
        }

        drawInstanceCount(state) {
            const stream0 = state.streams.get(0);
            const frequency = (stream0 && (stream0.frequency ?? 1)) >>> 0;
            if ((frequency & D3DSTREAMSOURCE_INDEXEDDATA) === 0) return 1;
            return frequency & D3DSTREAMSOURCE_FREQUENCY_MASK;
        }

        // WebGPU exposes vertex/instance step modes but no D3D9-style
        // instance divisor. A divisor of one binds directly. For larger
        // divisors, expand the CPU mirror into a transient, tightly matching
        // the sequence D3D9 specifies (record 0 repeated divisor times, then
        // record 1, and so on). Dynamic vertex buffers already maintain this
        // mirror for draw-order correctness, so this is exact rather than an
        // approximation.
        prepareInstanceStreams(streams, instanceCount) {
            let result = streams;
            for (const [streamIndex, binding] of streams) {
                const frequency = (binding.frequency ?? 1) >>> 0;
                if ((frequency & D3DSTREAMSOURCE_INSTANCEDATA) === 0) continue;
                const divisor = frequency & D3DSTREAMSOURCE_FREQUENCY_MASK;
                if (!divisor)
                    return { error: "instance stream " + streamIndex +
                        " has a zero step rate" };
                // Zero stride already repeats one record for every instance,
                // independently of its divisor; no expansion is necessary.
                if (divisor === 1 || binding.stride === 0) continue;
                const stride = binding.stride || 0;
                const shadow = binding.resource && binding.resource.shadow;
                if (!stride || !shadow)
                    return { error: "instance stream " + streamIndex +
                        " cannot be expanded without a CPU buffer mirror" };
                const outputBytes = instanceCount * stride;
                if (!Number.isSafeInteger(outputBytes) || outputBytes <= 0)
                    return { error: "instance stream expansion size is invalid" };
                const output = new Uint8Array(alignUp(outputBytes, 4));
                for (let instance = 0; instance < instanceCount; ++instance) {
                    const source = binding.offset +
                        Math.floor(instance / divisor) * stride;
                    if (source < 0 || source + stride > shadow.length)
                        return { error: "instance stream " + streamIndex +
                            " references data outside its vertex buffer" };
                    output.set(shadow.subarray(source, source + stride),
                        instance * stride);
                }
                const buffer = this.device.createBuffer({
                    label: "D3D9 instance divisor expansion",
                    size: Math.max(4, output.byteLength),
                    usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
                });
                this.writeBufferAligned(buffer, 0, output, 0, outputBytes);
                this.retireAfterSubmit(buffer);
                if (result === streams) result = new Map(streams);
                result.set(streamIndex, { buffer, offset: 0, stride,
                    frequency: D3DSTREAMSOURCE_INSTANCEDATA | 1 });
                ++this.stats.expandedInstanceStreams;
            }
            return { streams: result };
        }

        // WebGPU cannot combine an index buffer with instance-rate source
        // attributes to select an arbitrary point for each instance. Indexed
        // point lists are uncommon but legal, so compact the referenced
        // vertices from the guest-maintained CPU shadows into transient,
        // sequential streams before using the same quad-expansion pipeline.
        expandIndexedPointStreams(state, streams, indexResource, firstIndex,
                indexCount, baseVertex) {
            if (!indexResource || !indexResource.shadow) return null;
            const wide = indexResource.indexFormat === "uint32";
            const indices = wide
                ? new Uint32Array(indexResource.shadow.buffer,
                    indexResource.shadow.byteOffset,
                    indexResource.shadow.byteLength >>> 2)
                : new Uint16Array(indexResource.shadow.buffer,
                    indexResource.shadow.byteOffset,
                    indexResource.shadow.byteLength >>> 1);
            if (firstIndex + indexCount > indices.length) return null;
            const result = new Map();
            for (const [streamIndex, binding] of streams) {
                const streamState = state.streams.get(streamIndex);
                const stride = streamState && streamState.stride;
                if (stride === 0) {
                    // Index compaction cannot change a constant attribute.
                    // Retain its resource so later updates still rename it.
                    result.set(streamIndex, binding);continue;
                }
                const shadow = binding.resource && binding.resource.shadow;
                if (!stride || !shadow) return null;
                const outputBytes = indexCount * stride;
                const output = new Uint8Array(alignUp(outputBytes, 4));
                for (let point = 0; point < indexCount; ++point) {
                    const vertex = Number(indices[firstIndex + point]) + baseVertex;
                    if (vertex < 0) return null;
                    const source = binding.offset + vertex * stride;
                    if (source < 0 || source + stride > shadow.length) return null;
                    output.set(shadow.subarray(source, source + stride), point * stride);
                }
                const buffer = this.device.createBuffer({
                    label: "D3D9 indexed point expansion",
                    size: Math.max(4, output.byteLength),
                    usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
                });
                this.writeBufferAligned(buffer, 0, output, 0, outputBytes);
                this.retireAfterSubmit(buffer);
                result.set(streamIndex, { buffer, offset: 0 });
            }
            ++this.stats.indexedPointExpansions;
            return result;
        }

        onDrawPrimitive(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.DrawPrimitive.device_handle, true);
            const primitiveType = view.getUint32(offset + D9WG.F.DrawPrimitive.primitive_type, true);
            const startVertex = view.getUint32(offset + D9WG.F.DrawPrimitive.start_vertex, true);
            const primitiveCount = view.getUint32(offset + D9WG.F.DrawPrimitive.primitive_count, true);
            const state = this.deviceState(deviceHandle);
            const elements = this.currentElements(state);
            if (!elements) {
                this.noteDroppedDraw("DrawPrimitive", state,
                    ["no vertex declaration (SetFVF/SetVertexDeclaration)"]);
                return;
            }
            const vertexCount = primitiveElementCount(primitiveType, primitiveCount);
            if (vertexCount === null) {
                this.noteDroppedDraw("DrawPrimitive", state,
                    ["unsupported primitive type " + primitiveType]);
                return;
            }
            const streams = this.boundStreams(state, startVertex);
            if (primitiveType === D3DPT_TRIANGLEFAN) {
                // WebGPU has no fan topology; synthesise the index buffer that
                // turns one into a triangle list.
                const fan = this.triangleFanIndexBuffer(vertexCount);
                if (!fan) {
                    this.noteDroppedDraw("DrawPrimitive", state,
                        ["triangle fan with too few vertices"]);
                    return;
                }
                this.recordDraw(state, elements, "DrawPrimitive", {
                    topology: "triangle-list", streams,
                    indexInfo: { buffer: fan.buffer, format: "uint32", offset: 0,
                        count: (vertexCount - 2) * 3, firstIndex: 0, baseVertex: 0,
                        cpuIndices: fan.indices },
                });
                return;
            }
            this.recordDraw(state, elements, "DrawPrimitive", {
                topology: topologyFor(primitiveType), streams,
                indexInfo: null, vertexCount,
            });
        }

        onDrawIndexedPrimitive(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.DrawIndexedPrimitive.device_handle, true);
            const primitiveType = view.getUint32(offset + D9WG.F.DrawIndexedPrimitive.primitive_type, true);
            const baseVertexIndex = view.getInt32(offset + D9WG.F.DrawIndexedPrimitive.base_vertex_index, true);
            const startIndex = view.getUint32(offset + D9WG.F.DrawIndexedPrimitive.start_index, true);
            const primitiveCount = view.getUint32(offset + D9WG.F.DrawIndexedPrimitive.primitive_count, true);
            const state = this.deviceState(deviceHandle);
            const elements = this.currentElements(state);
            const ib = this.resources.get(state.indexBufferHandle);
            if (!elements || !ib) {
                const reasons = [];
                if (!elements) reasons.push("no vertex declaration (SetFVF/SetVertexDeclaration)");
                if (!ib) reasons.push("index buffer resource missing");
                this.noteDroppedDraw("DrawIndexedPrimitive", state, reasons);
                return;
            }
            const indexCount = primitiveElementCount(primitiveType, primitiveCount);
            if (indexCount === null) {
                this.noteDroppedDraw("DrawIndexedPrimitive", state,
                    ["unsupported primitive type " + primitiveType]);
                return;
            }
            const streams = this.boundStreams(state, 0);
            if (primitiveType === D3DPT_POINTLIST) {
                const expanded = this.expandIndexedPointStreams(state, streams,
                    ib, startIndex, indexCount, baseVertexIndex);
                if (!expanded) {
                    this.noteDroppedDraw("DrawIndexedPrimitive", state,
                        ["indexed point list could not be compacted from buffer shadows"]);
                    return;
                }
                this.recordDraw(state, elements, "DrawIndexedPrimitive", {
                    topology: "point-list", streams: expanded,
                    indexInfo: null, vertexCount: indexCount,
                });
                return;
            }
            if (primitiveType === D3DPT_TRIANGLEFAN) {
                // Re-index the fan through the buffer's CPU mirror; the GPU
                // copy is write-only from here.
                const converted = this.triangleFanFromIndices(ib, startIndex, indexCount);
                if (!converted) {
                    this.noteDroppedDraw("DrawIndexedPrimitive", state,
                        ["indexed triangle fan could not be converted"]);
                    return;
                }
                this.recordDraw(state, elements, "DrawIndexedPrimitive", {
                    topology: "triangle-list", streams,
                    indexInfo: { buffer: converted.buffer, format: "uint32",
                        offset: 0, count: converted.count, firstIndex: 0,
                        baseVertex: baseVertexIndex,
                        cpuIndices: converted.indices },
                });
                return;
            }
            const topology = topologyFor(primitiveType);
            this.recordDraw(state, elements, "DrawIndexedPrimitive", {
                topology, streams,
                stripIndexFormat: isStripTopology(topology) ? ib.indexFormat : undefined,
                indexResource: ib,
                indexInfo: { buffer: ib.gpuBuffer, format: ib.indexFormat, offset: 0,
                    count: indexCount, firstIndex: startIndex,
                    baseVertex: baseVertexIndex },
            });
        }

        onDrawPrimitiveUP(bytes, view, offset, length) {
            const deviceHandle = view.getUint32(offset + D9WG.F.DrawPrimitiveUP.device_handle, true);
            const primitiveType = view.getUint32(offset + D9WG.F.DrawPrimitiveUP.primitive_type, true);
            const primitiveCount = view.getUint32(offset + D9WG.F.DrawPrimitiveUP.primitive_count, true);
            const stride = view.getUint32(offset + D9WG.F.DrawPrimitiveUP.stride, true);
            const vertexBytes = view.getUint32(offset + D9WG.F.DrawPrimitiveUP.vertex_bytes, true);
            const dataOffset = view.getUint32(offset + D9WG.F.DrawPrimitiveUP.vertex_data_offset, true);
            const state = this.deviceState(deviceHandle);
            const elements = this.currentElements(state);
            if (!elements) {
                this.noteDroppedDraw("DrawPrimitiveUP", state,
                    ["no vertex declaration (SetFVF/SetVertexDeclaration)"]);
                return;
            }
            const elementCount = primitiveElementCount(primitiveType, primitiveCount);
            if (elementCount === null) {
                this.noteDroppedDraw("DrawPrimitiveUP", state,
                    ["unsupported primitive type " + primitiveType]);
                return;
            }
            const buffer = this.device.createBuffer({
                size: Math.max(4, alignUp(vertexBytes, 4)),
                usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
            });
            this.writeBufferAligned(buffer, 0, bytes, dataOffset, vertexBytes);
            this.retireAfterSubmit(buffer);
            // Draw*UP feeds one implicit stream 0 whose stride the command
            // carries, not one bound through SetStreamSource.
            const streams = new Map([[0, { buffer, offset: 0 }]]);
            const geometry = { streams, indexInfo: null, vertexCount: elementCount,
                topology: topologyFor(primitiveType) };
            if (primitiveType === D3DPT_TRIANGLEFAN) {
                const fan = this.triangleFanIndexBuffer(elementCount);
                if (!fan) {
                    this.noteDroppedDraw("DrawPrimitiveUP", state,
                        ["triangle fan with too few vertices"]);
                    return;
                }
                geometry.topology = "triangle-list";
                geometry.indexInfo = { buffer: fan.buffer, format: "uint32",
                    offset: 0, count: (elementCount - 2) * 3, firstIndex: 0,
                    baseVertex: 0, cpuIndices: fan.indices };
            }
            this.recordDrawWithStride(state, elements, "DrawPrimitiveUP",
                geometry, stride);
            ++this.stats.upDrawCalls;
        }

        onDrawIndexedPrimitiveUP(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset + D9WG.F.DrawIndexedPrimitiveUP.device_handle, true);
            const primitiveType = view.getUint32(offset + D9WG.F.DrawIndexedPrimitiveUP.primitive_type, true);
            const primitiveCount = view.getUint32(offset + D9WG.F.DrawIndexedPrimitiveUP.primitive_count, true);
            const indexFormatValue = view.getUint32(offset + D9WG.F.DrawIndexedPrimitiveUP.index_format, true);
            // M1 never read `stride` out of this payload but referenced it
            // when recording the draw, so every DrawIndexedPrimitiveUP threw
            // a ReferenceError and took the whole batch down with it (the
            // batch's catch handler discarded the frame). War3's main menu
            // happens not to use this entry point, which is why it stayed
            // hidden.
            const stride = view.getUint32(offset + D9WG.F.DrawIndexedPrimitiveUP.stride, true);
            const indexBytes = view.getUint32(offset + D9WG.F.DrawIndexedPrimitiveUP.index_bytes, true);
            const vertexBytes = view.getUint32(offset + D9WG.F.DrawIndexedPrimitiveUP.vertex_bytes, true);
            const indexDataOffset = view.getUint32(offset + D9WG.F.DrawIndexedPrimitiveUP.index_data_offset, true);
            const vertexDataOffset = view.getUint32(offset + D9WG.F.DrawIndexedPrimitiveUP.vertex_data_offset, true);
            const state = this.deviceState(deviceHandle);
            const elements = this.currentElements(state);
            if (!elements) {
                this.noteDroppedDraw("DrawIndexedPrimitiveUP", state,
                    ["no vertex declaration (SetFVF/SetVertexDeclaration)"]);
                return;
            }
            const elementCount = primitiveElementCount(primitiveType, primitiveCount);
            if (elementCount === null) {
                this.noteDroppedDraw("DrawIndexedPrimitiveUP", state,
                    ["unsupported primitive type " + primitiveType]);
                return;
            }
            if (primitiveType === D3DPT_POINTLIST) {
                const wide = indexFormatValue === D3DFMT_INDEX32;
                const indexWidth = wide ? 4 : 2;
                if (elementCount * indexWidth > indexBytes) {
                    this.noteDroppedDraw("DrawIndexedPrimitiveUP", state,
                        ["point index payload is shorter than its primitive count"]);
                    return;
                }
                const outputBytes = elementCount * stride;
                const output = new Uint8Array(alignUp(outputBytes, 4));
                for (let point = 0; point < elementCount; ++point) {
                    const indexOffset = indexDataOffset + point * indexWidth;
                    const vertex = wide ? view.getUint32(indexOffset, true)
                        : view.getUint16(indexOffset, true);
                    const source = vertexDataOffset + vertex * stride;
                    if (source < vertexDataOffset ||
                            source + stride > vertexDataOffset + vertexBytes ||
                            source + stride > bytes.byteLength) {
                        this.noteDroppedDraw("DrawIndexedPrimitiveUP", state,
                            ["point index references vertex data outside the payload"]);
                        return;
                    }
                    output.set(bytes.subarray(source, source + stride), point * stride);
                }
                const vertexBuffer = this.device.createBuffer({
                    label: "D3D9 indexed UP point expansion",
                    size: Math.max(4, output.byteLength),
                    usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
                });
                this.writeBufferAligned(vertexBuffer, 0, output, 0, outputBytes);
                this.retireAfterSubmit(vertexBuffer);
                this.recordDrawWithStride(state, elements,
                    "DrawIndexedPrimitiveUP", {
                        topology: "point-list",
                        streams: new Map([[0, { buffer: vertexBuffer, offset: 0 }]]),
                        indexInfo: null, vertexCount: elementCount,
                    }, stride);
                ++this.stats.indexedPointExpansions;
                ++this.stats.upDrawCalls;
                return;
            }
            const vertexBuffer = this.device.createBuffer({
                size: Math.max(4, alignUp(vertexBytes, 4)),
                usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
            });
            const indexBuffer = this.device.createBuffer({
                size: Math.max(4, alignUp(indexBytes, 4)),
                usage: BUFFER_USAGE_INDEX | BUFFER_USAGE_COPY_DST,
            });
            this.writeBufferAligned(vertexBuffer, 0, bytes, vertexDataOffset, vertexBytes);
            this.writeBufferAligned(indexBuffer, 0, bytes, indexDataOffset, indexBytes);
            this.retireAfterSubmit(vertexBuffer);
            this.retireAfterSubmit(indexBuffer);
            const format = indexFormatValue === D3DFMT_INDEX32 ? "uint32" : "uint16";
            const topology = topologyFor(primitiveType);
            if (primitiveType === D3DPT_TRIANGLEFAN) {
                this.noteDroppedDraw("DrawIndexedPrimitiveUP", state,
                    ["indexed triangle fans are not converted on the UP path"]);
                return;
            }
            this.recordDrawWithStride(state, elements, "DrawIndexedPrimitiveUP", {
                topology,
                streams: new Map([[0, { buffer: vertexBuffer, offset: 0 }]]),
                stripIndexFormat: isStripTopology(topology) ? format : undefined,
                indexInfo: { buffer: indexBuffer, format, offset: 0,
                    count: elementCount, firstIndex: 0, baseVertex: 0 },
            }, stride);
            ++this.stats.upDrawCalls;
        }

        // (0,1,2), (0,2,3), (0,3,4)... -- the triangle list a fan of
        // `vertexCount` vertices expands to.
// D3DRS_FILLMODE for a triangle topology. Returns a replacement geometry, or
        // null to leave the draw alone -- which is the common case: solid fill,
        // or a topology that has no interior to fill.
        //
        // WebGPU deliberately omits a polygon mode (Metal and the WebGPU
        // baseline both lack the feature Vulkan calls fillModeNonSolid), so
        // wireframe cannot be a pipeline flag here the way it is in D3D9. What
        // it can be is different geometry: a triangle drawn as its three edges
        // is a line list, and that is an exact rendering of what D3DFILL_
        // WIREFRAME asks for, not an approximation. The cost is an index buffer
        // per draw, which is why nothing happens at all in solid fill.
        applyFillMode(state, geometry) {
            const fill = state.renderStates.get(D3DRS_FILLMODE) || D3DFILL_SOLID;
            if (fill !== D3DFILL_WIREFRAME && fill !== D3DFILL_POINT) return null;
            const topology = geometry.topology;
            if (topology !== "triangle-list" && topology !== "triangle-strip")
                return null;
            if (fill === D3DFILL_POINT) {
                // Every vertex becomes a point. WebGPU points are one pixel and
                // there is no point-size equivalent for this mode, which is the
                // one place D3DFILL_POINT differs from the hardware.
                this.warnOnce("fill-point", "D3DFILL_POINT draws one-pixel " +
                    "points: WebGPU has no point size outside the point-sprite " +
                    "path, so the mode's size is not reproduced");
                ++this.stats.fillModeDraws;
                return Object.assign({}, geometry, {
                    topology: "point-list",
                    stripIndexFormat: undefined,
                    fromFillMode: true,
                });
            }
            const source = this.triangleIndicesFor(geometry);
            if (!source) {
                // Naming it beats drawing the solid form and letting the
                // developer wonder why the wireframe toggle does nothing.
                this.warnOnce("fill-wireframe-indices",
                    "D3DFILL_WIREFRAME needs to read this draw's indices to " +
                    "build its edges, and this index buffer has no CPU mirror; " +
                    "the draw stays solid");
                return null;
            }
            const triangles = Math.floor(source.length / 3);
            if (!triangles) return null;
            const lines = new Uint32Array(triangles * 6);
            for (let i = 0; i < triangles; ++i) {
                const a = source[i * 3], b = source[i * 3 + 1],
                    c = source[i * 3 + 2];
                lines[i * 6] = a; lines[i * 6 + 1] = b;
                lines[i * 6 + 2] = b; lines[i * 6 + 3] = c;
                lines[i * 6 + 4] = c; lines[i * 6 + 5] = a;
            }
            const buffer = this.device.createBuffer({
                size: lines.byteLength,
                usage: BUFFER_USAGE_INDEX | BUFFER_USAGE_COPY_DST,
            });
            this.device.queue.writeBuffer(buffer, 0, lines);
            this.retireAfterSubmit(buffer);
            ++this.stats.fillModeDraws;
            return Object.assign({}, geometry, {
                topology: "line-list",
                stripIndexFormat: undefined,
                indexResource: undefined,
                indexInfo: {
                    buffer, format: "uint32", offset: 0, count: lines.length,
                    firstIndex: 0,
                    baseVertex: geometry.indexInfo
                        ? geometry.indexInfo.baseVertex : 0,
                },
                fromFillMode: true,
            });
        }

        // The triangle-list index sequence behind a draw, as vertex indices, or
        // null when it cannot be recovered. Strips are unrolled here so the
        // edge builder above only ever sees triples.
        triangleIndicesFor(geometry) {
            const strip = geometry.topology === "triangle-strip";
            let source = null;
            if (!geometry.indexInfo) {
                const count = geometry.vertexCount | 0;
                if (count < 3) return null;
                source = new Uint32Array(count);
                for (let i = 0; i < count; ++i) source[i] = i;
            } else if (geometry.indexInfo.cpuIndices) {
                // A fan or a *UP draw already built its indices on the CPU and
                // kept them for exactly this.
                source = geometry.indexInfo.cpuIndices;
            } else if (geometry.indexResource &&
                    geometry.indexResource.shadow) {
                const resource = geometry.indexResource;
                const wide = resource.indexFormat === "uint32";
                const all = wide
                    ? new Uint32Array(resource.shadow.buffer,
                        resource.shadow.byteOffset, resource.shadow.length >> 2)
                    : new Uint16Array(resource.shadow.buffer,
                        resource.shadow.byteOffset, resource.shadow.length >> 1);
                const first = geometry.indexInfo.firstIndex | 0;
                const count = geometry.indexInfo.count | 0;
                if (first + count > all.length) return null;
                source = all.subarray(first, first + count);
            }
            if (!source || source.length < 3) return null;
            if (!strip) return source;
            // A strip of N+2 vertices is N triangles, and every odd triangle
            // has its winding reversed. Winding does not matter for edges, but
            // unrolling in the same order the rasteriser would keeps the edge
            // set identical to the solid form's silhouette.
            const triangles = source.length - 2;
            const out = new Uint32Array(triangles * 3);
            for (let i = 0; i < triangles; ++i) {
                out[i * 3] = source[i];
                out[i * 3 + 1] = source[i + (i & 1 ? 2 : 1)];
                out[i * 3 + 2] = source[i + (i & 1 ? 1 : 2)];
            }
            return out;
        }

        triangleFanIndexBuffer(vertexCount) {
            if (vertexCount < 3) return null;
            const triangles = vertexCount - 2;
            const indices = new Uint32Array(triangles * 3);
            for (let i = 0; i < triangles; ++i) {
                indices[i * 3] = 0;
                indices[i * 3 + 1] = i + 1;
                indices[i * 3 + 2] = i + 2;
            }
            const buffer = this.device.createBuffer({
                size: indices.byteLength,
                usage: BUFFER_USAGE_INDEX | BUFFER_USAGE_COPY_DST,
            });
            this.device.queue.writeBuffer(buffer, 0, indices);
            this.retireAfterSubmit(buffer);
            // The CPU copy travels with the buffer because D3DFILL_WIREFRAME
            // has to read these indices back to build edges, and by then the
            // GPU copy is write-only.
            return { buffer, indices };
        }

        triangleFanFromIndices(indexResource, firstIndex, indexCount) {
            if (indexCount < 3 || !indexResource.shadow) return null;
            const wide = indexResource.indexFormat === "uint32";
            const source = wide
                ? new Uint32Array(indexResource.shadow.buffer,
                    indexResource.shadow.byteOffset, indexResource.shadow.length >> 2)
                : new Uint16Array(indexResource.shadow.buffer,
                    indexResource.shadow.byteOffset, indexResource.shadow.length >> 1);
            if (firstIndex + indexCount > source.length) return null;
            const triangles = indexCount - 2;
            const indices = new Uint32Array(triangles * 3);
            const hub = source[firstIndex];
            for (let i = 0; i < triangles; ++i) {
                indices[i * 3] = hub;
                indices[i * 3 + 1] = source[firstIndex + i + 1];
                indices[i * 3 + 2] = source[firstIndex + i + 2];
            }
            const buffer = this.device.createBuffer({
                size: indices.byteLength,
                usage: BUFFER_USAGE_INDEX | BUFFER_USAGE_COPY_DST,
            });
            this.device.queue.writeBuffer(buffer, 0, indices);
            this.retireAfterSubmit(buffer);
            return { buffer, count: indices.length, indices };
        }
    }

    function primitiveElementCount(type, primitiveCount) {
        switch (type) {
        case D3DPT_POINTLIST: return primitiveCount;
        case D3DPT_LINELIST: return primitiveCount * 2;
        case D3DPT_LINESTRIP: return primitiveCount + 1;
        case D3DPT_TRIANGLELIST: return primitiveCount * 3;
        case D3DPT_TRIANGLESTRIP:
        case D3DPT_TRIANGLEFAN: return primitiveCount + 2;
        default: return null;
        }
    }

    // D3DPRIMITIVETYPE -> GPUPrimitiveTopology. M1 hardcoded "triangle-list"
    // for every draw while still computing strip/fan element counts, so a
    // strip of N triangles was rasterised as floor((N+2)/3) unrelated
    // triangles -- geometry that is wrong rather than missing, and therefore
    // easy to mistake for a transform bug. TRIANGLEFAN has no WebGPU
    // topology at all and is converted to an indexed triangle list by the
    // callers instead.
    function topologyFor(type) {
        switch (type) {
        case D3DPT_POINTLIST: return "point-list";
        case D3DPT_LINELIST: return "line-list";
        case D3DPT_LINESTRIP: return "line-strip";
        case D3DPT_TRIANGLESTRIP: return "triangle-strip";
        default: return "triangle-list";
        }
    }

    function isStripTopology(topology) {
        return topology === "triangle-strip" || topology === "line-strip";
    }

    const presentMethods = presentFactory.createMethods({ TEXTURE_USAGE_RENDER_ATTACHMENT, TEXTURE_USAGE_COPY_SRC, TEXTURE_USAGE_COPY_DST, TEXTURE_USAGE_TEXTURE_BINDING, sampleCountForD3D, D3DMULTISAMPLE_NONE, D9WG, formatToGPU, D9WGStreamError, expandRowToGPU, D3DFMT_A8R8G8B8, sameVisibleRegion, D9WG_WINDOW_IS_WINDOW, D9WG_WINDOW_VISIBLE, D9WG_WINDOW_ICONIC, D9WG_WINDOW_FOREGROUND, D9WG_WINDOW_FULLSCREEN, D9WG_WINDOW_NO_SURFACE, D9WG_WINDOW_OCCLUDED, D9WG_WINDOW_REGION, readVisibleRegion, D9WG_WINDOW_STATE_BYTES });
    for (const [name, value] of Object.entries(presentMethods))
        Object.defineProperty(D3D9WebGPUExecutor.prototype, name, { value, writable: true, configurable: true });

    const FrameReplayer = replayFactory.createClass({ D3DQUERYTYPE_OCCLUSION, MAX_QUERY_SET_COUNT, EMPTY_OFFSETS, intersectRects, alignUp, BUFFER_USAGE_QUERY_RESOLVE, BUFFER_USAGE_COPY_SRC, BUFFER_USAGE_COPY_DST, BUFFER_USAGE_MAP_READ, MAP_MODE_READ, D9WG_RESPONSE_FAILED, D9WG_RESPONSE_OK, D3DQUERYTYPE_EVENT, D3DQUERYTYPE_TIMESTAMP, D3DQUERYTYPE_TIMESTAMPFREQ, D3DQUERYTYPE_TIMESTAMPDISJOINT });
    const recorderMethods = recorderFactory.createMethods({ D3DRS_ZENABLE, D3DSTREAMSOURCE_INSTANCEDATA, D3DRS_POINTSPRITEENABLE, DEFAULT_ATTRIBUTE_STREAM, D3DRS_SCISSORTESTENABLE, D3DQUERYTYPE_OCCLUSION });
    for (const [name, value] of Object.entries(recorderMethods))
        Object.defineProperty(D3D9WebGPUExecutor.prototype, name, { value, writable: true, configurable: true });

    const pipelineMethods = pipelineFactory.createMethods({
        D3DRS_ZENABLE, D3DZB_FALSE, D3DRS_ZWRITEENABLE, COMPARE_FUNCS,
        D3DRS_ZFUNC, D3DRS_ALPHABLENDENABLE, BLEND_FACTORS, D3DRS_SRCBLEND,
        D3DRS_DESTBLEND, D3DRS_BLENDOP, D3DRS_SEPARATEALPHABLENDENABLE, D3DRS_SRCBLENDALPHA,
        D3DRS_DESTBLENDALPHA, D3DRS_BLENDOPALPHA, BLEND_OPS, D3DRS_BLENDFACTOR,
        floatFromDWORD, D3DRS_DEPTHBIAS, D3DRS_SLOPESCALEDEPTHBIAS, D3DRS_STENCILENABLE,
        STENCIL_OPS, D3DRS_STENCILFAIL, D3DRS_STENCILZFAIL, D3DRS_STENCILPASS,
        D3DRS_STENCILFUNC, D3DRS_TWOSIDEDSTENCILMODE, D3DRS_CCW_STENCILFAIL, D3DRS_CCW_STENCILZFAIL,
        D3DRS_CCW_STENCILPASS, D3DRS_CCW_STENCILFUNC, D3DRS_CULLMODE, D3DCULL_CCW,
        D3DCULL_CW, D3DRS_COLORWRITEENABLE, D3DRS_COLORWRITEENABLE1, D3DRS_COLORWRITEENABLE2,
        D3DRS_COLORWRITEENABLE3, D3DRS_ALPHATESTENABLE, D3DRS_ALPHAFUNC, D3DRS_ALPHAREF,
        D3DRS_STENCILMASK, D3DRS_STENCILWRITEMASK, D3DRS_STENCILREF, D3DRS_MULTISAMPLEANTIALIAS,
        D3DRS_MULTISAMPLEMASK, D3DRS_ADAPTIVETESS_Y, D3DFOURCC_ATOC, D3DSAMP_ADDRESSU,
        D3DSAMP_ADDRESSV, D3DSAMP_ADDRESSW, D3DSAMP_MIPFILTER, D3DSAMP_MAGFILTER,
        D3DSAMP_MINFILTER, D3DSAMP_MAXANISOTROPY, D3DSAMP_MAXMIPLEVEL, ADDRESS_MODES,
        FILTER_MODES, SHADER_STAGE_VERTEX, SHADER_STAGE_FRAGMENT, isBlendableGPUFormat,
        DEPTH_FORMAT
    });
    for (const [name, value] of Object.entries(pipelineMethods))
        Object.defineProperty(D3D9WebGPUExecutor.prototype, name, { value, writable: true, configurable: true });

    const resourceMethods = resourceFactory.createMethods({
        D9WG, RESOURCE_BUFFER_INDEX, BUFFER_USAGE_INDEX, BUFFER_USAGE_COPY_DST, BUFFER_USAGE_VERTEX,
        alignUp, D3DFMT_INDEX32, D3DUSAGE_DEPTHSTENCIL, isFourCCDepthFormat, D3DUSAGE_RENDERTARGET,
        D9WG_USAGE_DDRAW_INDEXED, isPalettizedFormat, sampleCountForD3D, D3DUSAGE_AUTOGENMIPMAP, fullMipLevelCount, autoGenMipsSupported, autoGenDefaultFilter,
        DEPTH_FORMAT, formatToGPU, isRenderableGPUFormat, srgbSiblingOf, TEXTURE_USAGE_RENDER_ATTACHMENT,
        TEXTURE_USAGE_TEXTURE_BINDING, TEXTURE_USAGE_COPY_DST, TEXTURE_USAGE_COPY_SRC, isCompressedFormat, RESOURCE_TEXTURE_2D,
        gpuBytesPerTexel, expandRowToGPU, blockAlignedCopyExtent, bcNeedsExpansion, expandBCBlocks, RESOURCE_TEXTURE_CUBE, RESOURCE_TEXTURE_VOLUME,
        RESOURCE_VERTEX_DECLARATION, D9WGStreamError, shaderPipeline, RESOURCE_VERTEX_SHADER, RESOURCE_PIXEL_SHADER,
        BUFFER_USAGE_UNIFORM, PALETTE_ENTRIES: surfaceFactory.PALETTE_ENTRIES, PALETTE_BYTES: surfaceFactory.PALETTE_BYTES
    });
    for (const [name, value] of Object.entries(resourceMethods))
        Object.defineProperty(D3D9WebGPUExecutor.prototype, name, { value, writable: true, configurable: true });

    const surfaceMethods = surfaceFactory.createMethods({
        formatToGPU, SHADER_STAGE_FRAGMENT, isFloat32GPUFormat, SHADER_STAGE_VERTEX,
          DEPTH_FORMAT, TEXTURE_USAGE_COPY_SRC, TEXTURE_USAGE_COPY_DST,
        TEXTURE_USAGE_TEXTURE_BINDING, TEXTURE_USAGE_RENDER_ATTACHMENT, DDOVER_KEY_SOURCE: D9WG.C.D9WG_DDOVER_KEY_SOURCE, DDOVER_KEY_DESTINATION: D9WG.C.D9WG_DDOVER_KEY_DESTINATION,
        DDOVER_MIRROR_X: D9WG.C.D9WG_DDOVER_MIRROR_X, DDOVER_MIRROR_Y: D9WG.C.D9WG_DDOVER_MIRROR_Y
    });
    for (const [name, value] of Object.entries(surfaceMethods))
        Object.defineProperty(D3D9WebGPUExecutor.prototype, name, { value, writable: true, configurable: true });

    for (const name of DIAGNOSTIC_REPORTS)
        Object.defineProperty(D3D9WebGPUExecutor.prototype, name, {
            configurable: true, writable: true,
            value(...args) { return this.enableDiagnostics().then(() => this[name](...args)); },
        });

    D3D9WebGPUExecutor.prototype["performanceTimingVersion"] = 1;
    global.D3D9WebGPUExecutor = D3D9WebGPUExecutor;
    global.installD3D9WebGPUExecutor = function(canvas, options) {
        return new D3D9WebGPUExecutor(canvas, options);
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            D3D9WebGPUExecutor,
            V86GL_CTRL_D3D9_BATCH: 0xFFE1,
            // Exported so the WGSL validation test can run the synthesised
            // fixed-function stages through a real compiler alongside the
            // translated ones -- they meet over the same varying contract and
            // a mistake in either breaks the same pipelines.
            buildFixedFunctionVertexShader,
            buildFixedFunctionPixelShader,
        };
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
