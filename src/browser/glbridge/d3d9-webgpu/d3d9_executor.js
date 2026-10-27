// D9WG high-level Direct3D 9 command executor -- M1 skeleton.
//
// The guest DLL (glbridge/d3d9proxy/d3d9_proxy.c) keeps COM objects, shadow
// state, Lock/Unlock memory and batching inside Windows XP. This host owns
// only WebGPU resources and immutable cache objects, mirroring the D3D8
// path's division of responsibility (see ../d3d8-webgpu/d3d8_executor.js)
// but as an independent protocol/implementation: D9WG has its own opcode
// numbering, resource handle namespace and payload shapes (d3d9_protocol.h).
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

    const D9WG_MAGIC = 0x47573944; // "D9WG"
    const D9WG_VERSION_MAJOR = 1;
    const D9WG_VERSION_MINOR = 7;
    // The oldest guest proxy this host still decodes. 1.3 payloads are simply
    // shorter than 1.4 ones; see the version check in executeBatch().
    const D9WG_VERSION_MIN_MINOR = 3;
    const D9WG_DMA_BYTES = 16 * 1024 * 1024;
    const D9WG_RESPONSE_REGION_BYTES = 4 * 1024 * 1024;
    const D9WG_RESPONSE_REGION_OFFSET =
        D9WG_DMA_BYTES - D9WG_RESPONSE_REGION_BYTES;
    const D9WG_QUERY_REGION_BYTES = 16 * 1024;
    // Liveness counter the guest watches while it spins on a readback; see the
    // comment on D9WG_HEARTBEAT_OFFSET in d3d9_protocol.h.
    const D9WG_HEARTBEAT_BYTES = 16;
    const D9WG_HEARTBEAT_OFFSET =
        D9WG_RESPONSE_REGION_BYTES - D9WG_HEARTBEAT_BYTES;
    const D9WG_RESPONSE_OK = 1;
    const D9WG_RESPONSE_FAILED = 2;
    const D9WG_BATCH_HEADER_BYTES = 32;
    const D9WG_COMMAND_HEADER_BYTES = 16;
    const D9WG_BATCH_FLAG_PRESENT = 1 << 0;
    const D9WG_FEATURE_SHADER_MODEL_2 = 1 << 0;
    const D9WG_FEATURE_SHADER_MODEL_3 = 1 << 1;

    const OP_HELLO = 1;
    const OP_CREATE_DEVICE = 2;
    const OP_RESET = 3;
    const OP_PRESENT = 4;
    const OP_CLEAR = 5;
    const OP_BEGIN_SCENE = 6;
    const OP_END_SCENE = 7;
    const OP_CREATE_BUFFER = 0x100;
    const OP_UPDATE_BUFFER = 0x101;
    const OP_DESTROY_RESOURCE = 0x103;
    const OP_STRETCH_RECT = 8;
    const OP_COLOR_FILL = 9;
    const OP_UPDATE_SURFACE = 10;
    const OP_GUEST_LOG = 11;
    const OP_READBACK_SURFACE = 12;
    const OP_SESSION_END = 13;
    const GUEST_LOG_SEVERITY_INFO = 0;
    const GUEST_LOG_SEVERITY_FAILED = 2;
    const OP_CREATE_TEXTURE_2D = 0x110;
    const OP_CREATE_TEXTURE_CUBE = 0x111;
    const OP_CREATE_TEXTURE_VOLUME = 0x112;
    const OP_UPDATE_TEXTURE = 0x113;
    const OP_SET_SCISSOR_RECT = 0x205;
    const OP_SET_RENDER_TARGET = 0x20F;
    const OP_SET_DEPTH_STENCIL_SURFACE_LEVEL = 0x21E;
    const OP_SET_PALETTE = 0x21F;
    const OP_SET_CURRENT_TEXTURE_PALETTE = 0x220;
    const OP_GENERATE_MIPS = 0x221;
    const OP_SET_TEXTURE_LOD = 0x222;
    const OP_SET_GAMMA_RAMP = 0x223;
    const OP_CREATE_SWAP_CHAIN = 0x224;
    const OP_DESTROY_SWAP_CHAIN = 0x225;
    const OP_PRESENT_SWAP_CHAIN = 0x226;
    // D9WGSetDepthStencilSurface.depth_texture_handle sentinel: the device's own
    // auto depth-stencil surface. It needs a value distinct from 0 because
    // SetDepthStencilSurface(NULL) -- which really does turn depth testing off
    // -- also has no texture handle, and an app that renders to a texture and
    // then restores the back buffer's depth surface must be able to say which
    // of the two it means.
    const D9WG_AUTO_DEPTH_STENCIL_HANDLE = 0xFFFFFFFF;
    const OP_CREATE_VERTEX_DECLARATION = 0x120;
    const OP_CREATE_VERTEX_SHADER = 0x121;
    const OP_CREATE_PIXEL_SHADER = 0x122;
    const OP_CREATE_QUERY = 0x123;
    const OP_SET_RENDER_STATE = 0x200;
    const OP_SET_SAMPLER_STATE = 0x201;
    const OP_SET_TEXTURE_STAGE_STATE = 0x202;
    const OP_SET_TEXTURE = 0x203;
    const OP_SET_VIEWPORT = 0x204;
    const OP_SET_TRANSFORM = 0x206;
    const OP_SET_MATERIAL = 0x207;
    const OP_SET_LIGHT = 0x208;
    const OP_LIGHT_ENABLE = 0x209;
    const OP_SET_STREAM_SOURCE = 0x20A;
    const OP_SET_STREAM_SOURCE_FREQ = 0x20B;
    const OP_SET_INDICES = 0x20C;
    const OP_SET_VERTEX_DECLARATION = 0x20D;
    const OP_SET_FVF = 0x20E;
    const OP_SET_CURSOR_PROPERTIES = 0x21A;
    const OP_SET_CURSOR_POSITION = 0x21B;
    const OP_SHOW_CURSOR = 0x21C;
    const OP_WINDOW_STATE = 0x21D;
    const D9WG_WINDOW_IS_WINDOW = 1 << 0;
    const D9WG_WINDOW_VISIBLE = 1 << 1;
    const D9WG_WINDOW_ICONIC = 1 << 2;
    const D9WG_WINDOW_FOREGROUND = 1 << 3;
    const D9WG_WINDOW_FULLSCREEN = 1 << 4;
    const D9WG_WINDOW_NO_SURFACE = 1 << 5;
    // Other windows cover all of it (d3d9_protocol.h): hidden as far as the
    // picture goes, though the window is up
    const D9WG_WINDOW_OCCLUDED = 1 << 6;
    // Other windows cover part of it: the parts that show follow the record
    // (D9WGWindowRegion in d3d9_protocol.h)
    const D9WG_WINDOW_REGION = 1 << 7;
    const D9WG_WINDOW_STATE_BYTES = 40;
    const D9WG_WINDOW_REGION_MAX_RECTS = 32;
    const OP_SET_VERTEX_SHADER = 0x211;
    const OP_SET_PIXEL_SHADER = 0x212;
    const OP_SET_VERTEX_SHADER_CONSTANT_F = 0x213;
    const OP_SET_VERTEX_SHADER_CONSTANT_I = 0x214;
    const OP_SET_VERTEX_SHADER_CONSTANT_B = 0x215;
    const OP_SET_PIXEL_SHADER_CONSTANT_F = 0x216;
    const OP_SET_PIXEL_SHADER_CONSTANT_I = 0x217;
    const OP_SET_PIXEL_SHADER_CONSTANT_B = 0x218;
    const OP_SET_CLIP_PLANE = 0x219;
    const OP_DRAW_PRIMITIVE = 0x300;
    const OP_DRAW_INDEXED_PRIMITIVE = 0x301;
    const OP_DRAW_PRIMITIVE_UP = 0x302;

    const D3DSTREAMSOURCE_INDEXEDDATA = 0x40000000;
    const D3DSTREAMSOURCE_INSTANCEDATA = 0x80000000;
    const D3DSTREAMSOURCE_FREQUENCY_MASK = 0x3fffffff;
    const OP_DRAW_INDEXED_PRIMITIVE_UP = 0x303;
    const OP_BEGIN_QUERY = 0x400;
    const OP_END_QUERY = 0x401;

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

    const D3DFMT_R8G8B8 = 20;
    const D3DFMT_A8R8G8B8 = 21;
    const D3DFMT_X8R8G8B8 = 22;
    const D3DFMT_R5G6B5 = 23;
    const D3DFMT_X1R5G5B5 = 24;
    const D3DFMT_A1R5G5B5 = 25;
    const D3DFMT_A4R4G4B4 = 26;
    const D3DFMT_R3G3B2 = 27;
    const D3DFMT_A8 = 28;
    const D3DFMT_A8R3G3B2 = 29;
    const D3DFMT_X4R4G4B4 = 30;
    const D3DFMT_A2B10G10R10 = 31;
    const D3DFMT_A8B8G8R8 = 32;
    const D3DFMT_X8B8G8R8 = 33;
    const D3DFMT_G16R16 = 34;
    const D3DFMT_A2R10G10B10 = 35;
    const D3DFMT_A16B16G16R16 = 36;
    const D3DFMT_L8 = 50;
    const D3DFMT_A8L8 = 51;
    const D3DFMT_A4L4 = 52;
    const D3DFMT_V8U8 = 60;
    const D3DFMT_L6V5U5 = 61;
    const D3DFMT_X8L8V8U8 = 62;
    const D3DFMT_Q8W8V8U8 = 63;
    const D3DFMT_V16U16 = 64;
    const D3DFMT_W11V11U10 = 65;
    const D3DFMT_A2W10V10U10 = 67;
    const D3DFMT_L16 = 81;
    const D3DFMT_R16F = 111;
    const D3DFMT_G16R16F = 112;
    const D3DFMT_A16B16G16R16F = 113;
    const D3DFMT_R32F = 114;
    const D3DFMT_G32R32F = 115;
    const D3DFMT_A32B32G32R32F = 116;
    const D3DFMT_CxV8U8 = 117;
    const D3DFMT_P8 = 41;
    const D3DFMT_A8P8 = 40;
    const D3DFMT_Q16W16V16U16 = 110;
    // Packed 4:2:2. One 32-bit block carries two pixels which share their
    // chroma; only the luma (or green) differs between them.
    const D3DFMT_UYVY = 0x59565955;      // 'UYVY'
    const D3DFMT_YUY2 = 0x32595559;      // 'YUY2'
    const D3DFMT_R8G8_B8G8 = 0x47424752; // 'RGBG'
    const D3DFMT_G8R8_G8B8 = 0x42475247; // 'GRGB'
    // ATI's depth-as-texture FOURCCs. Unlike a D24X8 texture, which a D3D9
    // driver samples as a hardware shadow-map comparison, these return the
    // stored depth itself -- an app picks one precisely because it wants the
    // raw value to do its own filtering with.
    const D3DFMT_DF16 = 0x36314644;      // 'DF16'
    const D3DFMT_DF24 = 0x34324644;      // 'DF24'
    const D3DFMT_INTZ = 0x5A544E49;      // 'INTZ'
    // ATI's 3Dc pair, which are BC4 and BC5 under their pre-DX10 names. A
    // normal map keeping only X and Y and reconstructing Z in the shader beats
    // DXT5 for normals by enough that 2005-2007 titles ship art in it. WebGPU
    // exposes exactly these two under texture-compression-bc, so this is a
    // rename rather than a translation.
    const D3DFMT_ATI1N = 0x31495441;     // 'ATI1'
    const D3DFMT_ATI2N = 0x32495441;     // 'ATI2'
    // A render target whose contents nothing ever reads, so a depth-only pass
    // does not have to allocate a colour buffer it will not use.
    const D3DFMT_NULL = 0x4C4C554E;      // 'NULL'
    const D3DFMT_DXT1 = 0x31545844;
    const D3DFMT_DXT2 = 0x32545844;
    const D3DFMT_DXT3 = 0x33545844;
    const D3DFMT_DXT4 = 0x34545844;
    const D3DFMT_DXT5 = 0x35545844;
    const D3DFMT_INDEX16 = 101;
    const D3DFMT_INDEX32 = 102;

    const D3DUSAGE_RENDERTARGET = 0x1;
    const D3DUSAGE_DEPTHSTENCIL = 0x2;
    const D3DUSAGE_AUTOGENMIPMAP = 0x400;
    // Protocol 1.7, and not a D3DUSAGE bit -- see D9WG_USAGE_DDRAW_INDEXED in
    // d3d9_protocol.h. A P8 texture carrying it is stored as r8uint indices
    // resolved through a palette, rather than expanded to RGBA on the CPU,
    // because DirectDraw blits P8 into P8 and a later palette change must
    // still change those pixels' colour.
    const D9WG_USAGE_DDRAW_INDEXED = 0x80000000;
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
    const D3DVBF_0WEIGHTS = 256;
    // D3D9's fixed function blends at most four matrices per vertex, which is
    // what fill_caps() reports as MaxVertexBlendMatrices.
    const MAX_BLEND_MATRICES = 4;

    // D3DLIGHTTYPE
    const D3DLIGHT_POINT = 1, D3DLIGHT_SPOT = 2, D3DLIGHT_DIRECTIONAL = 3;
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

    // D3DSAMP_MIPMAPLODBIAS, also float bits in a DWORD.
    //
    // WebGPU samplers have no LOD bias at all, so the only place to apply one
    // is the sample call -- textureSampleBias -- which means the value lands in
    // the shader rather than in the sampler. Baking it as a literal (rather
    // than reading it from a uniform) keeps it out of the per-draw uniform
    // writers on both the fixed-function and translated paths, at the price of
    // one pipeline variant per distinct bias.
    //
    // Quantising to 1/16 of a mip level is what bounds that price: a title that
    // animates the bias continuously would otherwise mint a pipeline per frame,
    // and 1/16 is far finer than the difference is visible at. The range clamp
    // matches D3D9's own, which no hardware exceeded.
    const LOD_BIAS_STEPS = 16;
    const LOD_BIAS_LIMIT = 16;
    function lodBiasFor(dword) {
        const bias = floatFromDWORD(dword);
        if (!Number.isFinite(bias) || bias === 0) return 0;
        return Math.round(Math.max(-LOD_BIAS_LIMIT,
            Math.min(LOD_BIAS_LIMIT, bias)) * LOD_BIAS_STEPS) / LOD_BIAS_STEPS;
    }

    // The "-srgb" sibling of a GPU format, or null when there is none. A view
    // can only use a format listed in the texture's viewFormats at creation, so
    // this has to be known up front rather than at bind time.
    function srgbSiblingOf(gpuFormat) {
        return {
            "bgra8unorm": "bgra8unorm-srgb",
            "rgba8unorm": "rgba8unorm-srgb",
            "bc1-rgba-unorm": "bc1-rgba-unorm-srgb",
            "bc2-rgba-unorm": "bc2-rgba-unorm-srgb",
            "bc3-rgba-unorm": "bc3-rgba-unorm-srgb",
        }[gpuFormat] || null;
    }

    function isCompressedFormat(format) {
        return format === D3DFMT_DXT1 || format === D3DFMT_DXT2 ||
            format === D3DFMT_DXT3 || format === D3DFMT_DXT4 ||
            format === D3DFMT_DXT5 ||
            format === D3DFMT_ATI1N || format === D3DFMT_ATI2N;
    }

    // Bytes per 4x4 block for the block-compressed formats. BC1 and BC4 carry
    // one 8-byte block; everything else here carries two.
    function compressedBlockBytes(format) {
        return (format === D3DFMT_DXT1 || format === D3DFMT_ATI1N) ? 8 : 16;
    }

    // WebGPU measures a block-compressed copy in whole texel blocks: copySize
    // must be a multiple of the BCn 4x4 block, and a mip level's *physical*
    // extent is its logical size rounded up to that grid. So the tail of a DXT
    // mip chain has to be written as a full 4x4 block even though its logical
    // size is 2x2 or 1x1. Passing the logical size makes writeTexture fail
    // validation, and because that failure surfaces as an uncaptured device
    // error rather than an exception, the level silently keeps whatever the
    // texture was created with -- hundreds of "copySize.width (1) is not a
    // multiple of compressed texture format block width (4)" errors while Kart
    // Rider loaded its UI atlases, with no other symptom than the smallest mips
    // sampling as garbage.
    //
    // Callers pass a block-aligned origin, which WebGPU requires independently,
    // so rounding the extent up cannot run past the physical mip extent.
    function blockAlignedCopyExtent(size, compressed) {
        return compressed ? Math.ceil(size / 4) * 4 : size;
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

    // The FOURCC depth formats. They live in a D3D9 texture like any other
    // format, but their storage is the depth buffer's, so they take the depth
    // path rather than formatToGPU.
    function isFourCCDepthFormat(format) {
        return format === D3DFMT_DF16 || format === D3DFMT_DF24 ||
            format === D3DFMT_INTZ;
    }

    function isPalettizedFormat(format) {
        return format === D3DFMT_P8 || format === D3DFMT_A8P8;
    }

    // Two pixels per 32-bit block, sharing chroma.
    function isPackedPairFormat(format) {
        return format === D3DFMT_UYVY || format === D3DFMT_YUY2 ||
            format === D3DFMT_R8G8_B8G8 || format === D3DFMT_G8R8_G8B8;
    }

    function isHalfFloatExpansionFormat(format) {
        return format === D3DFMT_Q16W16V16U16 ||
            format === D3DFMT_L6V5U5 || format === D3DFMT_X8L8V8U8 ||
            format === D3DFMT_V16U16 || format === D3DFMT_W11V11U10 ||
            format === D3DFMT_A2W10V10U10 ||
            format === D3DFMT_L16 || format === D3DFMT_CxV8U8 ||
            format === D3DFMT_A2B10G10R10 || format === D3DFMT_G16R16 ||
            format === D3DFMT_A2R10G10B10 ||
            format === D3DFMT_A16B16G16R16 || format === D3DFMT_R16F ||
            format === D3DFMT_G16R16F ||
            format === D3DFMT_A16B16G16R16F;
    }

    function gpuBytesPerTexel(format) {
        if (isHalfFloatExpansionFormat(format)) return 8;
        if (format === D3DFMT_G32R32F) return 8;
        if (format === D3DFMT_A32B32G32R32F) return 16;
        return 4;
    }

    // A command whose payload contradicts the batch framing -- a blob that
    // reaches past the end of the record, a length field larger than the bytes
    // behind it. Unlike a command that merely fails, this means the producer
    // and the consumer disagree about the byte layout, so nothing else in the
    // batch can be trusted either and the whole thing is abandoned. Everything
    // that is not one of these is contained to its own command; see the
    // dispatch loop in executeBatch().
    class D9WGStreamError extends Error {}

    // WebGPU wants the level count; D3D9 texture sizes are not always powers of
    // two, and the chain runs until both dimensions reach one.
    function fullMipLevelCount(width, height) {
        let levels = 1;
        let w = width, h = height;
        while (w > 1 || h > 1) {
            if (w > 1) w >>= 1;
            if (h > 1) h >>= 1;
            ++levels;
        }
        return levels;
    }

    function isRenderableGPUFormat(format) {
        return format === "rgba8unorm" || format === "rgba16float" ||
            format === "r32float" || format === "rg32float" ||
            format === "rgba32float" ||
            // The NULL FOURCC target's stand-in. It is renderable by
            // definition -- being a render target nothing reads is its whole
            // purpose -- and r8unorm is the cheapest format that can be one.
            format === "r8unorm" ||
            // Protocol 1.7: the storage a DirectDraw palettised surface uses.
            // It has to be an attachment because a 2D title's whole frame is
            // built by blitting P8 sprites into a P8 back buffer.
            format === "r8uint";
    }

    function isFloat32GPUFormat(format) {
        return format === "r32float" || format === "rg32float" ||
            format === "rgba32float";
    }

    function isBlendableGPUFormat(format, features) {
        return !isFloat32GPUFormat(format) ||
            !!(features && features.float32Blendable);
    }

    function formatToGPU(format) {
        switch (format) {
        case D3DFMT_R8G8B8:
        case D3DFMT_A8R8G8B8:
        case D3DFMT_X8R8G8B8:
        case D3DFMT_X1R5G5B5:
        case D3DFMT_A1R5G5B5:
        case D3DFMT_A4R4G4B4:
        case D3DFMT_R3G3B2:
        case D3DFMT_A8R3G3B2:
        case D3DFMT_X4R4G4B4:
        case D3DFMT_A8B8G8R8:
        case D3DFMT_X8B8G8R8:
        case D3DFMT_R5G6B5:
        case D3DFMT_L8:
        case D3DFMT_A8:
        case D3DFMT_A8L8:
        case D3DFMT_A4L4:
        case D3DFMT_P8:
        case D3DFMT_A8P8:
        case D3DFMT_UYVY:
        case D3DFMT_YUY2:
        case D3DFMT_R8G8_B8G8:
        case D3DFMT_G8R8_G8B8:
        case D3DFMT_INDEX16:
        case D3DFMT_INDEX32:
            // All of these are CPU-expanded to tightly-packed RGBA8 on
            // upload (see expandRowToGPU), matching the D3D8 path's
            // approach: WebGPU has no native 16-bit BGR/BGRA formats.
            return "rgba8unorm";
        case D3DFMT_V8U8:
        case D3DFMT_Q8W8V8U8:
            return "rgba8snorm";
        case D3DFMT_L6V5U5:
        case D3DFMT_X8L8V8U8:
        case D3DFMT_V16U16:
        case D3DFMT_W11V11U10:
        case D3DFMT_A2W10V10U10:
        case D3DFMT_L16:
        case D3DFMT_CxV8U8:
        case D3DFMT_A2B10G10R10:
        case D3DFMT_G16R16:
        case D3DFMT_A2R10G10B10:
        case D3DFMT_A16B16G16R16:
        case D3DFMT_Q16W16V16U16:
        case D3DFMT_R16F:
        case D3DFMT_G16R16F:
        case D3DFMT_A16B16G16R16F:
            // Mixed signed/unsigned bump formats, CxV8U8's reconstructed
            // component, and high-precision L16 cannot be represented by one
            // normalized 8-bit WebGPU format without losing their semantics.
            // Half-float preserves the sampled values closely.
            return "rgba16float";
        case D3DFMT_R32F:
            return "r32float";
        case D3DFMT_G32R32F:
            return "rg32float";
        case D3DFMT_A32B32G32R32F:
            return "rgba32float";
        case D3DFMT_DXT1:
            return "bc1-rgba-unorm";
        case D3DFMT_DXT2:
        case D3DFMT_DXT3:
            return "bc2-rgba-unorm";
        case D3DFMT_DXT4:
        case D3DFMT_DXT5:
            return "bc3-rgba-unorm";
        case D3DFMT_ATI1N:
            return "bc4-r-unorm";
        case D3DFMT_ATI2N:
            return "bc5-rg-unorm";
        case D3DFMT_NULL:
            // Nothing reads it, so the cheapest renderable format is the right
            // one: the size still has to match the depth attachment the pass
            // is really aiming at, but the per-texel cost does not.
            return "r8unorm";
        default:
            return null;
        }
    }

    const HALF_BITS_BUFFER = new ArrayBuffer(4);
    const HALF_BITS_F32 = new Float32Array(HALF_BITS_BUFFER);
    const HALF_BITS_U32 = new Uint32Array(HALF_BITS_BUFFER);

    function floatToHalfBits(value) {
        HALF_BITS_F32[0] = value;
        const bits = HALF_BITS_U32[0];
        const sign = (bits >>> 16) & 0x8000;
        let exponent = (bits >>> 23) & 0xff;
        let mantissa = bits & 0x7fffff;
        if (exponent === 0xff)
            return sign | (mantissa ? 0x7e00 : 0x7c00);
        exponent = exponent - 127 + 15;
        if (exponent >= 31) return sign | 0x7c00;
        if (exponent <= 0) {
            if (exponent < -10) return sign;
            const normalized = mantissa | 0x800000;
            const shift = 14 - exponent;
            let halfMantissa = normalized >>> shift;
            const remainderMask = (1 << shift) - 1;
            const remainder = normalized & remainderMask;
            const halfway = 1 << (shift - 1);
            if (remainder > halfway ||
                    (remainder === halfway && (halfMantissa & 1)))
                ++halfMantissa;
            return sign | halfMantissa;
        }
        let halfMantissa = mantissa >>> 13;
        const remainder = mantissa & 0x1fff;
        if (remainder > 0x1000 ||
                (remainder === 0x1000 && (halfMantissa & 1))) {
            ++halfMantissa;
            if (halfMantissa === 0x400) {
                halfMantissa = 0;
                if (++exponent >= 31) return sign | 0x7c00;
            }
        }
        return sign | (exponent << 10) | halfMantissa;
    }

    function writeHalf(dest, offset, value) {
        const bits = floatToHalfBits(value);
        dest[offset] = bits & 0xff;
        dest[offset + 1] = bits >>> 8;
    }

    function halfBitsToFloat(bits) {
        const sign = (bits & 0x8000) ? -1 : 1;
        const exponent = (bits >>> 10) & 0x1f;
        const mantissa = bits & 0x3ff;
        if (!exponent)
            return mantissa ? sign * Math.pow(2, -14) * mantissa / 1024
                : sign === -1 ? -0 : 0;
        if (exponent === 0x1f)
            return mantissa ? NaN : sign * Infinity;
        return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
    }

    function d3dBytesPerTexel(format) {
        switch (format) {
        case D3DFMT_R5G6B5:
        case D3DFMT_X1R5G5B5:
        case D3DFMT_A1R5G5B5:
        case D3DFMT_A4R4G4B4:
        case D3DFMT_R16F:
            return 2;
        case D3DFMT_A8R8G8B8:
        case D3DFMT_X8R8G8B8:
        case D3DFMT_A2B10G10R10:
        case D3DFMT_A2R10G10B10:
        case D3DFMT_G16R16F:
        case D3DFMT_R32F:
            return 4;
        case D3DFMT_A16B16G16R16F:
        case D3DFMT_G32R32F:
            return 8;
        case D3DFMT_A32B32G32R32F:
            return 16;
        default:
            return 0;
        }
    }

    function packGPUReadbackRow(format, gpuFormat, source, sourceOffset,
            width, destination, destinationOffset) {
        const sourceView = new DataView(source.buffer,
            source.byteOffset, source.byteLength);
        const destinationView = new DataView(destination.buffer,
            destination.byteOffset, destination.byteLength);
        const sourceBpp = gpuFormat === "rgba16float" ? 8
            : gpuFormat === "rg32float" ? 8
            : gpuFormat === "rgba32float" ? 16 : 4;
        const destinationBpp = d3dBytesPerTexel(format);
        const clamp = value => Math.max(0, Math.min(1,
            Number.isFinite(value) ? value : 0));
        const unorm = (value, maximum) =>
            Math.round(clamp(value) * maximum);
        for (let x = 0; x < width; ++x) {
            const sourceAt = sourceOffset + x * sourceBpp;
            const destinationAt = destinationOffset + x * destinationBpp;
            let r, g, b, a;
            if (gpuFormat === "rgba16float") {
                r = halfBitsToFloat(sourceView.getUint16(sourceAt, true));
                g = halfBitsToFloat(sourceView.getUint16(sourceAt + 2, true));
                b = halfBitsToFloat(sourceView.getUint16(sourceAt + 4, true));
                a = halfBitsToFloat(sourceView.getUint16(sourceAt + 6, true));
            } else if (gpuFormat === "r32float") {
                r = sourceView.getFloat32(sourceAt, true); g = b = 0; a = 1;
            } else if (gpuFormat === "rg32float") {
                r = sourceView.getFloat32(sourceAt, true);
                g = sourceView.getFloat32(sourceAt + 4, true); b = 0; a = 1;
            } else if (gpuFormat === "rgba32float") {
                r = sourceView.getFloat32(sourceAt, true);
                g = sourceView.getFloat32(sourceAt + 4, true);
                b = sourceView.getFloat32(sourceAt + 8, true);
                a = sourceView.getFloat32(sourceAt + 12, true);
            } else if (gpuFormat === "bgra8unorm" ||
                    gpuFormat === "bgra8unorm-srgb") {
                b = source[sourceAt] / 255; g = source[sourceAt + 1] / 255;
                r = source[sourceAt + 2] / 255; a = source[sourceAt + 3] / 255;
            } else {
                r = source[sourceAt] / 255; g = source[sourceAt + 1] / 255;
                b = source[sourceAt + 2] / 255; a = source[sourceAt + 3] / 255;
            }
            switch (format) {
            case D3DFMT_A8R8G8B8:
            case D3DFMT_X8R8G8B8:
                destination[destinationAt] = unorm(b, 255);
                destination[destinationAt + 1] = unorm(g, 255);
                destination[destinationAt + 2] = unorm(r, 255);
                destination[destinationAt + 3] = format === D3DFMT_A8R8G8B8
                    ? unorm(a, 255) : 0xff;
                break;
            case D3DFMT_R5G6B5:
                destinationView.setUint16(destinationAt,
                    (unorm(r, 31) << 11) | (unorm(g, 63) << 5) |
                    unorm(b, 31), true);
                break;
            case D3DFMT_X1R5G5B5:
            case D3DFMT_A1R5G5B5:
                destinationView.setUint16(destinationAt,
                    ((format === D3DFMT_X1R5G5B5 ? 1 : unorm(a, 1)) << 15) |
                    (unorm(r, 31) << 10) | (unorm(g, 31) << 5) |
                    unorm(b, 31), true);
                break;
            case D3DFMT_A4R4G4B4:
                destinationView.setUint16(destinationAt,
                    (unorm(a, 15) << 12) | (unorm(r, 15) << 8) |
                    (unorm(g, 15) << 4) | unorm(b, 15), true);
                break;
            case D3DFMT_A2B10G10R10:
                destinationView.setUint32(destinationAt,
                    (unorm(r, 1023) | (unorm(g, 1023) << 10) |
                    (unorm(b, 1023) << 20) | (unorm(a, 3) << 30)) >>> 0,
                    true);
                break;
            case D3DFMT_A2R10G10B10:
                destinationView.setUint32(destinationAt,
                    (unorm(b, 1023) | (unorm(g, 1023) << 10) |
                    (unorm(r, 1023) << 20) | (unorm(a, 3) << 30)) >>> 0,
                    true);
                break;
            case D3DFMT_R16F:
                destinationView.setUint16(destinationAt,
                    floatToHalfBits(r), true);
                break;
            case D3DFMT_G16R16F:
                destinationView.setUint16(destinationAt,
                    floatToHalfBits(r), true);
                destinationView.setUint16(destinationAt + 2,
                    floatToHalfBits(g), true);
                break;
            case D3DFMT_A16B16G16R16F:
                destinationView.setUint16(destinationAt,
                    floatToHalfBits(r), true);
                destinationView.setUint16(destinationAt + 2,
                    floatToHalfBits(g), true);
                destinationView.setUint16(destinationAt + 4,
                    floatToHalfBits(b), true);
                destinationView.setUint16(destinationAt + 6,
                    floatToHalfBits(a), true);
                break;
            case D3DFMT_R32F:
                destinationView.setFloat32(destinationAt, r, true);
                break;
            case D3DFMT_G32R32F:
                destinationView.setFloat32(destinationAt, r, true);
                destinationView.setFloat32(destinationAt + 4, g, true);
                break;
            case D3DFMT_A32B32G32R32F:
                destinationView.setFloat32(destinationAt, r, true);
                destinationView.setFloat32(destinationAt + 4, g, true);
                destinationView.setFloat32(destinationAt + 8, b, true);
                destinationView.setFloat32(destinationAt + 12, a, true);
                break;
            default:
                throw new Error("unsupported render-target readback format " +
                    format);
            }
        }
    }

    function signedNormalized(value, bitCount) {
        const signBit = 1 << (bitCount - 1);
        const fullRange = 1 << bitCount;
        const signed = value & signBit ? value - fullRange : value;
        return signed === -signBit ? -1 : signed / (signBit - 1);
    }

    // Expands one source row to the WebGPU format returned by formatToGPU().
    // Ordinary colour/luminance formats become RGBA8 UNORM, signed bump maps
    // become RGBA8 SNORM, and mixed/high-precision formats become RGBA16F.
    // BCn formats bypass this routine and stay block-compressed end-to-end.
    // BT.601 studio-swing YCbCr, which is what D3D9's 4:2:2 formats carry --
    // they exist for video frames, and a video decoder writes 16..235 luma.
    // Treating it as full range washes blacks out to dark grey, which is
    // exactly the kind of "close enough to look intentional" error that never
    // gets noticed.
    function yuvToRGB(y, u, v, out) {
        const c = y - 16, d = u - 128, e = v - 128;
        out[0] = Math.min(255, Math.max(0, (298 * c + 409 * e + 128) >> 8));
        out[1] = Math.min(255, Math.max(0,
            (298 * c - 100 * d - 208 * e + 128) >> 8));
        out[2] = Math.min(255, Math.max(0, (298 * c + 516 * d + 128) >> 8));
    }

    const YUV_SCRATCH = new Int32Array(3);

    // The 4:2:2 and RGBG/GRGB formats describe two pixels per 32-bit block, so
    // they cannot be expanded one texel at a time from an index alone: texel i
    // needs the block containing i and its position within it. `palette` is the
    // 256-entry Uint8Array (RGBA) a palettized format indexes into, or null.
    function expandPairedRowToGPU(format, source, sourceOffset, count, dest,
            destOffset) {
        for (let i = 0; i < count; ++i) {
            const block = sourceOffset + (i >> 1) * 4;
            const second = (i & 1) !== 0;
            const out = destOffset + i * 4;
            let r, g, b;
            switch (format) {
            case D3DFMT_YUY2: { // Y0 U Y1 V
                yuvToRGB(source[block + (second ? 2 : 0)], source[block + 1],
                    source[block + 3], YUV_SCRATCH);
                r = YUV_SCRATCH[0]; g = YUV_SCRATCH[1]; b = YUV_SCRATCH[2];
                break;
            }
            case D3DFMT_UYVY: { // U Y0 V Y1
                yuvToRGB(source[block + (second ? 3 : 1)], source[block],
                    source[block + 2], YUV_SCRATCH);
                r = YUV_SCRATCH[0]; g = YUV_SCRATCH[1]; b = YUV_SCRATCH[2];
                break;
            }
            case D3DFMT_R8G8_B8G8: // R G0 B G1: the pair shares R and B
                r = source[block];
                g = source[block + (second ? 3 : 1)];
                b = source[block + 2];
                break;
            default:               // D3DFMT_G8R8_G8B8 -- G0 R G1 B
                r = source[block + 1];
                g = source[block + (second ? 2 : 0)];
                b = source[block + 3];
                break;
            }
            dest[out] = r; dest[out + 1] = g; dest[out + 2] = b;
            dest[out + 3] = 0xff;
        }
    }

    function expandRowToGPU(format, source, sourceOffset, count, dest,
            destOffset, palette) {
        if (format === D3DFMT_R32F || format === D3DFMT_G32R32F ||
                format === D3DFMT_A32B32G32R32F) {
            const bytes = count * gpuBytesPerTexel(format);
            dest.set(source.subarray(sourceOffset, sourceOffset + bytes), destOffset);
            return;
        }
        if (isPackedPairFormat(format)) {
            expandPairedRowToGPU(format, source, sourceOffset, count, dest,
                destOffset);
            return;
        }
        if (isPalettizedFormat(format)) {
            const stride = format === D3DFMT_A8P8 ? 2 : 1;
            for (let i = 0; i < count; ++i) {
                const at = sourceOffset + i * stride;
                // D3DFMT_A8P8 is little-endian [index, alpha]; the palette's
                // own alpha is overridden by the per-texel one.
                const entry = (palette ? source[at] : 0) * 4;
                const out = destOffset + i * 4;
                if (palette) {
                    dest[out] = palette[entry];
                    dest[out + 1] = palette[entry + 1];
                    dest[out + 2] = palette[entry + 2];
                    dest[out + 3] = stride === 2
                        ? source[at + 1] : palette[entry + 3];
                } else {
                    // No palette has been set yet. Opaque white keeps the draw
                    // neutral instead of painting the scene with whatever the
                    // uninitialised entries happened to be.
                    dest[out] = dest[out + 1] = dest[out + 2] = 0xff;
                    dest[out + 3] = stride === 2 ? source[at + 1] : 0xff;
                }
            }
            return;
        }
        for (let i = 0; i < count; ++i) {
            let r, g, b, a;
            if (isHalfFloatExpansionFormat(format)) {
                let u, v, w, q;
                if (format === D3DFMT_CxV8U8) {
                    const at = sourceOffset + i * 2;
                    u = signedNormalized(source[at], 8);
                    v = signedNormalized(source[at + 1], 8);
                    w = Math.sqrt(Math.max(0, 1 - u * u - v * v));
                    q = 1;
                } else if (format === D3DFMT_L16) {
                    const at = sourceOffset + i * 2;
                    const luminance = (source[at] |
                        (source[at + 1] << 8)) / 65535;
                    u = v = w = luminance;
                    q = 1;
                } else if (format === D3DFMT_R16F) {
                    const at = sourceOffset + i * 2;
                    const out = destOffset + i * 8;
                    dest[out] = source[at];
                    dest[out + 1] = source[at + 1];
                    writeHalf(dest, out + 2, 0);
                    writeHalf(dest, out + 4, 0);
                    writeHalf(dest, out + 6, 1);
                    continue;
                } else if (format === D3DFMT_G16R16F) {
                    const at = sourceOffset + i * 4;
                    const out = destOffset + i * 8;
                    dest[out] = source[at];
                    dest[out + 1] = source[at + 1];
                    dest[out + 2] = source[at + 2];
                    dest[out + 3] = source[at + 3];
                    writeHalf(dest, out + 4, 0);
                    writeHalf(dest, out + 6, 1);
                    continue;
                } else if (format === D3DFMT_A16B16G16R16F) {
                    const at = sourceOffset + i * 8;
                    const out = destOffset + i * 8;
                    dest.set(source.subarray(at, at + 8), out);
                    continue;
                } else if (format === D3DFMT_G16R16 ||
                        format === D3DFMT_A16B16G16R16) {
                    const at = sourceOffset + i *
                        (format === D3DFMT_G16R16 ? 4 : 8);
                    const readUNorm16 = offset =>
                        (source[offset] | (source[offset + 1] << 8)) / 65535;
                    u = readUNorm16(at);
                    v = readUNorm16(at + 2);
                    w = format === D3DFMT_A16B16G16R16 ?
                        readUNorm16(at + 4) : 0;
                    q = format === D3DFMT_A16B16G16R16 ?
                        readUNorm16(at + 6) : 1;
                } else if (format === D3DFMT_A2B10G10R10 ||
                        format === D3DFMT_A2R10G10B10) {
                    const at = sourceOffset + i * 4;
                    const value = (source[at] | (source[at + 1] << 8) |
                        (source[at + 2] << 16) |
                        (source[at + 3] << 24)) >>> 0;
                    const c0 = (value & 0x3ff) / 1023;
                    const c1 = ((value >>> 10) & 0x3ff) / 1023;
                    const c2 = ((value >>> 20) & 0x3ff) / 1023;
                    u = format === D3DFMT_A2B10G10R10 ? c0 : c2;
                    v = c1;
                    w = format === D3DFMT_A2B10G10R10 ? c2 : c0;
                    q = (value >>> 30) / 3;
                } else if (format === D3DFMT_L6V5U5) {
                    const value = source[sourceOffset + i * 2] |
                        (source[sourceOffset + i * 2 + 1] << 8);
                    u = signedNormalized(value & 0x1f, 5);
                    v = signedNormalized((value >>> 5) & 0x1f, 5);
                    w = ((value >>> 10) & 0x3f) / 63;
                    q = 1;
                } else if (format === D3DFMT_X8L8V8U8) {
                    const at = sourceOffset + i * 4;
                    u = signedNormalized(source[at], 8);
                    v = signedNormalized(source[at + 1], 8);
                    w = source[at + 2] / 255;
                    q = 1;
                } else if (format === D3DFMT_V16U16) {
                    const at = sourceOffset + i * 4;
                    const rawU = source[at] | (source[at + 1] << 8);
                    const rawV = source[at + 2] | (source[at + 3] << 8);
                    u = signedNormalized(rawU, 16);
                    v = signedNormalized(rawV, 16);
                    w = q = 1;
                } else if (format === D3DFMT_Q16W16V16U16) {
                    const at = sourceOffset + i * 8;
                    const read = offset => signedNormalized(
                        source[offset] | (source[offset + 1] << 8), 16);
                    u = read(at);
                    v = read(at + 2);
                    w = read(at + 4);
                    q = read(at + 6);
                } else if (format === D3DFMT_W11V11U10) {
                    // The one D3D8 bump format whose channels are not a whole
                    // number of bits alike: U is 10 bits at 0-9, V is 11 at
                    // 10-20, W is 11 at 21-31, and all three are signed.
                    const at = sourceOffset + i * 4;
                    const value = (source[at] | (source[at + 1] << 8) |
                        (source[at + 2] << 16) |
                        (source[at + 3] << 24)) >>> 0;
                    u = signedNormalized(value & 0x3ff, 10);
                    v = signedNormalized((value >>> 10) & 0x7ff, 11);
                    w = signedNormalized((value >>> 21) & 0x7ff, 11);
                    q = 1;
                } else {
                    const at = sourceOffset + i * 4;
                    const value = (source[at] | (source[at + 1] << 8) |
                        (source[at + 2] << 16) |
                        (source[at + 3] << 24)) >>> 0;
                    u = signedNormalized(value & 0x3ff, 10);
                    v = signedNormalized((value >>> 10) & 0x3ff, 10);
                    w = signedNormalized((value >>> 20) & 0x3ff, 10);
                    q = (value >>> 30) / 3;
                }
                const out = destOffset + i * 8;
                writeHalf(dest, out, u);
                writeHalf(dest, out + 2, v);
                writeHalf(dest, out + 4, w);
                writeHalf(dest, out + 6, q);
                continue;
            }
            switch (format) {
            case D3DFMT_R8G8B8: {
                const at = sourceOffset + i * 3;
                b = source[at]; g = source[at + 1]; r = source[at + 2];
                a = 0xff;
                break;
            }
            case D3DFMT_A8R8G8B8:
            case D3DFMT_X8R8G8B8: {
                const value = source[sourceOffset + i * 4] |
                    (source[sourceOffset + i * 4 + 1] << 8) |
                    (source[sourceOffset + i * 4 + 2] << 16) |
                    (source[sourceOffset + i * 4 + 3] << 24);
                b = value & 0xff; g = (value >>> 8) & 0xff;
                r = (value >>> 16) & 0xff;
                a = format === D3DFMT_A8R8G8B8 ? (value >>> 24) & 0xff : 0xff;
                break;
            }
            case D3DFMT_R5G6B5: {
                const value = source[sourceOffset + i * 2] |
                    (source[sourceOffset + i * 2 + 1] << 8);
                r = ((value >>> 11) & 0x1f) * 255 / 31;
                g = ((value >>> 5) & 0x3f) * 255 / 63;
                b = (value & 0x1f) * 255 / 31;
                a = 0xff;
                break;
            }
            case D3DFMT_X1R5G5B5:
            case D3DFMT_A1R5G5B5: {
                const value = source[sourceOffset + i * 2] |
                    (source[sourceOffset + i * 2 + 1] << 8);
                r = ((value >>> 10) & 0x1f) * 255 / 31;
                g = ((value >>> 5) & 0x1f) * 255 / 31;
                b = (value & 0x1f) * 255 / 31;
                a = format === D3DFMT_A1R5G5B5 ?
                    ((value >>> 15) & 0x1) * 255 : 0xff;
                break;
            }
            case D3DFMT_A4R4G4B4: {
                const value = source[sourceOffset + i * 2] |
                    (source[sourceOffset + i * 2 + 1] << 8);
                r = ((value >>> 8) & 0xf) * 255 / 15;
                g = ((value >>> 4) & 0xf) * 255 / 15;
                b = (value & 0xf) * 255 / 15;
                a = ((value >>> 12) & 0xf) * 255 / 15;
                break;
            }
            case D3DFMT_R3G3B2: {
                const value = source[sourceOffset + i];
                r = ((value >>> 5) & 0x7) * 255 / 7;
                g = ((value >>> 2) & 0x7) * 255 / 7;
                b = (value & 0x3) * 255 / 3;
                a = 0xff;
                break;
            }
            case D3DFMT_A8R3G3B2: {
                const at = sourceOffset + i * 2;
                const value = source[at];
                r = ((value >>> 5) & 0x7) * 255 / 7;
                g = ((value >>> 2) & 0x7) * 255 / 7;
                b = (value & 0x3) * 255 / 3;
                a = source[at + 1];
                break;
            }
            case D3DFMT_X4R4G4B4: {
                const value = source[sourceOffset + i * 2] |
                    (source[sourceOffset + i * 2 + 1] << 8);
                r = ((value >>> 8) & 0xf) * 17;
                g = ((value >>> 4) & 0xf) * 17;
                b = (value & 0xf) * 17;
                a = 0xff;
                break;
            }
            case D3DFMT_A8B8G8R8:
            case D3DFMT_X8B8G8R8: {
                const at = sourceOffset + i * 4;
                r = source[at]; g = source[at + 1]; b = source[at + 2];
                a = format === D3DFMT_A8B8G8R8 ? source[at + 3] : 0xff;
                break;
            }
            case D3DFMT_L8:
                r = g = b = source[sourceOffset + i];
                a = 0xff;
                break;
            case D3DFMT_A8:
                // A8 is the sole D3D9 format whose missing colour channels
                // default to zero rather than one.
                r = g = b = 0;
                a = source[sourceOffset + i];
                break;
            case D3DFMT_A8L8: {
                const at = sourceOffset + i * 2;
                r = g = b = source[at]; a = source[at + 1];
                break;
            }
            case D3DFMT_A4L4: {
                const value = source[sourceOffset + i];
                r = g = b = (value & 0xf) * 17;
                a = (value >>> 4) * 17;
                break;
            }
            case D3DFMT_V8U8: {
                const at = sourceOffset + i * 2;
                r = source[at]; g = source[at + 1]; b = a = 0x7f;
                break;
            }
            case D3DFMT_Q8W8V8U8: {
                const at = sourceOffset + i * 4;
                r = source[at]; g = source[at + 1];
                b = source[at + 2]; a = source[at + 3];
                break;
            }
            case D3DFMT_INDEX16: {
                /*
                 * INDEX16/32 are buffer formats, not standard D3D colour
                 * formats, but old capability scanners also try them as
                 * textures. Preserve the little-endian index bytes in RGBA
                 * instead of inventing a lossy colour conversion: shaders can
                 * reconstruct the exact value after multiplying by 255.
                 */
                const at = sourceOffset + i * 2;
                r = source[at]; g = source[at + 1]; b = 0; a = 0xff;
                break;
            }
            case D3DFMT_INDEX32: {
                const at = sourceOffset + i * 4;
                r = source[at]; g = source[at + 1];
                b = source[at + 2]; a = source[at + 3];
                break;
            }
            default:
                r = g = b = a = 0;
                break;
            }
            dest[destOffset + i * 4] = r | 0;
            dest[destOffset + i * 4 + 1] = g | 0;
            dest[destOffset + i * 4 + 2] = b | 0;
            dest[destOffset + i * 4 + 3] = a | 0;
        }
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

    // What D3D9 lights with when the app never called SetMaterial. Not all
    // zeroes: a zero diffuse would render the mesh black, which looks like a
    // bug in the lighting rather than like missing state.
    const DEFAULT_MATERIAL = {
        diffuse: [1, 1, 1, 1], ambient: [1, 1, 1, 1],
        specular: [0, 0, 0, 0], emissive: [0, 0, 0, 0], power: 0,
    };

    // The inter-stage contract shared with translated shaders. Both stages
    // always agree on it, whichever of the four VS/PS combinations a draw
    // uses (see the file header).
    const VARYING_COUNT = shaderPipeline.VARYING_COUNT;
    const VARYING_COLOR0 = shaderPipeline.VARYING_COLOR0;
    // D3DRS_SHADEMODE. D3DSHADE_FLAT takes the colour of the primitive's first
    // vertex instead of interpolating, which is exactly WGSL's
    // @interpolate(flat) -- whose default sampling is `first`, the same
    // provoking vertex D3D9 uses.
    //
    // It applies to the two colour varyings only. Texture coordinates and fog
    // keep interpolating under flat shading in D3D9, and a title that flat
    // shades a textured surface expects the texture to still follow the
    // surface. D3DSHADE_PHONG is in the enum but no D3D9 device ever
    // implemented it; D3D9 treats it as GOURAUD, and so does this.
    const D3DSHADE_FLAT = 1, D3DSHADE_GOURAUD = 2;
    function varyingDeclaration(slot, flatShading) {
        const flat = flatShading &&
            (slot === VARYING_COLOR0 || slot === shaderPipeline.VARYING_COLOR1);
        return "    @location(" + slot + ")" +
            (flat ? " @interpolate(flat)" : "") +
            " varying" + slot + ": vec4<f32>,";
    }
    const VARYING_TEXCOORD0 = shaderPipeline.VARYING_TEXCOORD0;

    // Vertex attribute locations the fixed-function vertex stage consumes.
    // These are assigned by *semantic*, not by the element's position in the
    // declaration array. M1 assigned them by iteration order and hardcoded
    // position/colour/texcoord as locations 0/1/2 in the WGSL, which agreed
    // only for declarations that happened to list the elements in that
    // order; a declaration with TEXCOORD before COLOR silently fed the
    // texcoord bytes into the colour attribute.
    // M3 widened this from three locations to twelve: fixed-function lighting
    // reads NORMAL, the specular material source can read COLOR1, and a
    // multi-stage cascade can reference all eight coordinate sets rather than
    // only TEXCOORD0.
    const FF_LOCATION_POSITION = 0;
    const FF_LOCATION_COLOR0 = 1;
    const FF_LOCATION_COLOR1 = 2;
    const FF_LOCATION_NORMAL = 3;
    const FF_LOCATION_TEXCOORD0 = 4; // .. 11 for TEXCOORD0..7
    const FF_LOCATION_PSIZE = 12;
    // M7 added two more: fixed-function vertex blending reads the skinning
    // usages the declaration validator has always accepted.
    const FF_LOCATION_BLENDWEIGHT = 13;
    const FF_LOCATION_BLENDINDICES = 14;

    // D3D9's alpha test has no fixed-function equivalent in WebGPU: it has to
    // become a `discard` in the fragment shader, which means the comparison
    // and the reference value are baked into the shader and therefore into
    // the pipeline key. Returns "" when no test is needed.
    //
    // This matters far beyond a subtle shading difference. UI atlases and
    // billboarded foliage lean on alpha test to cut fully transparent texels;
    // without it those texels are drawn opaque, which reads as wrong or
    // missing texture on exactly the panels and edges that should be cut out.
    //
    // D3DCMPFUNC values are 1..8; the expression below is the *discard*
    // condition, i.e. the negation of "the fragment passes".
    function alphaTestDiscard(alphaTest, alphaExpression) {
        if (!alphaTest || !alphaTest.enabled) return "";
        const reference = (alphaTest.reference / 255).toFixed(6);
        const condition = {
            1: "true",                                        // NEVER
            2: "!(" + alphaExpression + " < " + reference + ")",   // LESS
            3: "!(" + alphaExpression + " == " + reference + ")",  // EQUAL
            4: "!(" + alphaExpression + " <= " + reference + ")",  // LESSEQUAL
            5: "!(" + alphaExpression + " > " + reference + ")",   // GREATER
            6: "!(" + alphaExpression + " != " + reference + ")",  // NOTEQUAL
            7: "!(" + alphaExpression + " >= " + reference + ")",  // GREATEREQUAL
        }[alphaTest.func];
        if (!condition) return ""; // ALWAYS (8) and anything unknown: no test
        return "    if (" + condition + ") { discard; }\n";
    }

    // `blend` is the signature's resolved vertexBlend (null when the draw is
    // not blended); it decides whether the skinning attributes are consumed.
    function fixedFunctionLocationFor(element, blend) {
        if (element.usage === DECLUSAGE_POSITION ||
                element.usage === DECLUSAGE_POSITIONT)
            return element.usageIndex === 0 ? FF_LOCATION_POSITION : -1;
        if (element.usage === DECLUSAGE_COLOR)
            return element.usageIndex === 0 ? FF_LOCATION_COLOR0
                : (element.usageIndex === 1 ? FF_LOCATION_COLOR1 : -1);
        if (element.usage === DECLUSAGE_NORMAL)
            return element.usageIndex === 0 ? FF_LOCATION_NORMAL : -1;
        if (element.usage === DECLUSAGE_TEXCOORD &&
                element.usageIndex < MAX_TEXCOORD_SETS)
            return FF_LOCATION_TEXCOORD0 + element.usageIndex;
        if (element.usage === DECLUSAGE_PSIZE)
            return element.usageIndex === 0 ? FF_LOCATION_PSIZE : -1;
        // The skinning usages are read only while vertex blending is actually
        // on. Reporting them unconditionally would put an attribute in the
        // vertex layout that the generated WGSL never declares, for every
        // declaration that carries blend data with D3DRS_VERTEXBLEND disabled
        // -- which is most of them, since engines share one declaration
        // between their skinned and unskinned passes.
        if (element.usage === DECLUSAGE_BLENDWEIGHT)
            return blend && blend.weightCount && element.usageIndex === 0
                ? FF_LOCATION_BLENDWEIGHT : -1;
        if (element.usage === DECLUSAGE_BLENDINDICES)
            return blend && blend.indexed && element.usageIndex === 0
                ? FF_LOCATION_BLENDINDICES : -1;
        return -1;
    }

    // The WGSL declaration for a vertex attribute is always vec4<f32>: WebGPU
    // fills the components a narrower vertex format does not supply with
    // (_, 0, 0, 1), which is exactly D3D9's rule for a FLOAT3 POSITION or a
    // FLOAT2 texcoord. One declared type per location also keeps a shader
    // module independent of which declaration is bound with it.
    // The one exception is an integer vertex format: WebGPU requires the WGSL
    // input's base type to match the format's, so a UBYTE4 BLENDINDICES has to
    // be declared vec4<u32>. `scalar` names that base type; it defaults to the
    // f32 every other fixed-function attribute uses.
    function vertexInputDeclaration(location, scalar) {
        return "@location(" + location + ") in" + location +
            ": vec4<" + (scalar || "f32") + ">";
    }

    // D3DDECLTYPE -> the WGSL base type its WebGPU format must be read as.
    // Only the integer formats need an entry; everything else is f32. UDEC3
    // (13) and DEC3N (14) arrive as a single packed uint32 rather than a
    // four-component vector, so they have no vec4 reading at all and return
    // null -- callers fall back rather than emit WGSL that will not compile.
    function declTypeInputScalar(type) {
        if (type === 13 || type === 14) return null;
        if (type === 5) return "u32";           // UBYTE4  -> uint8x4
        if (type === 6 || type === 7) return "i32"; // SHORT2/4 -> sint16x2/x4
        return "f32";
    }

    // ---- fixed-function uniform blocks ----
    //
    // Both fixed-function stages get a uniform block whose *shape follows the
    // signature*: an unlit untextured draw uploads 80 bytes, one with eight
    // lights and three texture-coordinate transforms uploads over a kilobyte.
    // The shape has to vary because a uniform buffer is built and written per
    // draw (see constantBufferFor), so paying the worst case on every draw
    // would multiply a War3 session's ~100k draws by an order of magnitude of
    // upload traffic for state most of them do not use.
    //
    // One field table drives both the WGSL struct text and the JS writer, so
    // the two cannot drift. That matters more than the usual DRY argument: a
    // mismatched offset here produces a garbage matrix or a black light, not a
    // compile error, which is the class of bug that costs a day to locate.
    //
    // Every field is a vec4, a mat4x4 or an array of a 16-multiple struct, so
    // all of them align to 16 in WGSL's uniform address space and offsets
    // accumulate by plain size with no padding rules to apply. assertAligned
    // holds us to that.
    function uniformBlockLayout(fields) {
        let offset = 0;
        const entries = [];
        for (const field of fields) {
            if (!field) continue;
            if (field.bytes % 16 !== 0 || offset % 16 !== 0)
                throw new Error("fixed-function uniform field " + field.name +
                    " is not 16-byte aligned; WGSL uniform layout would " +
                    "silently disagree with the writer");
            entries.push({ name: field.name, type: field.type,
                bytes: field.bytes, offset, source: field.source });
            offset += field.bytes;
        }
        return { entries, byteLength: Math.max(16, offset),
            byName: new Map(entries.map(entry => [entry.name, entry])) };
    }

    function uniformBlockStruct(structName, layout) {
        // A zero-field block still has to be a legal struct, and every
        // signature that produces one also produces a shader that reads
        // nothing from it, so a dummy vec4 costs one binding slot and no
        // correctness.
        const body = layout.entries.length
            ? layout.entries.map(entry =>
                "    " + entry.name + ": " + entry.type + ",").join("\n")
            : "    _unused: vec4<f32>,";
        return "struct " + structName + " {\n" + body + "\n};";
    }

    // The vertex block. `source` names what fills the field; writeFixedVertex-
    // Uniforms below is the single place that knows how.
    // D3D9 rasterises with the sample point at a pixel's integer corner; WebGPU,
    // like D3D10 and everything after it, samples at the pixel centre -- half a
    // pixel further along both axes. A D3D9 title blitting UI 1:1 has already
    // subtracted that half pixel itself (the "Directly Mapping Texels to Pixels"
    // adjustment every 2000s-era engine carries), so replaying its geometry
    // unchanged puts every sample exactly on a texel boundary and bilinear
    // filtering returns the mean of two texels. 3D art does not care -- nothing
    // in it is pixel-aligned to begin with -- but 12px CJK glyphs turn to mush,
    // which is exactly the split Kart Rider showed: a clean track and an
    // unreadable shop.
    //
    // Adding the half pixel back in clip space, scaled by w so it stays half a
    // pixel at any depth, is what wined3d's posFixup and DXVK's half-pixel
    // offset both do. Screen y grows downward while NDC y grows upward, hence
    // the sign flip on the second component.
    const HALF_PIXEL_OFFSET_BODY =
        "    result.position = vec4<f32>(\n" +
        "        result.position.x + result.position.w / uniforms.viewport.x,\n" +
        "        result.position.y - result.position.w / uniforms.viewport.y,\n" +
        "        result.position.zw);";

    function fixedVertexUniformLayout(signature) {
        // A blended draw cannot pre-multiply the world matrix into anything,
        // because which world matrix applies is a per-vertex question. So the
        // chain splits: the shader poses the vertex into world space from the
        // matrix array, and these carry only what comes after that.
        const blend = signature.vertexBlend;
        const fields = [
            { name: blend ? "view_projection" : "world_view_projection",
                type: "mat4x4<f32>", bytes: 64 },
            { name: "viewport", type: "vec4<f32>", bytes: 16 },
        ];
        if (blend)
            fields.push({ name: "blend_worlds",
                type: "array<mat4x4<f32>, " + blend.matrixSlots + ">",
                bytes: 64 * blend.matrixSlots });
        // D3D9 fixed-function clip-plane equations are in world space. The
        // ordinary position path only needs a pre-multiplied WVP matrix, so
        // retain the world matrix separately when clipping needs that space.
        if (signature.clipPlaneCount && !blend &&
                signature.positionType !== "screen")
            fields.push({ name: "world_matrix",
                type: "mat4x4<f32>", bytes: 64 });
        if (signature.needsViewSpace) {
            fields.push({ name: blend ? "view_matrix" : "world_view",
                type: "mat4x4<f32>", bytes: 64 });
            // Inverse-transpose of the preceding matrix's upper 3x3, widened to
            // a mat4 so it obeys the same 16-byte rule as everything else here.
            fields.push({ name: "normal_matrix", type: "mat4x4<f32>", bytes: 64 });
        }
        if (signature.fogMode)
            fields.push({ name: "fog_params", type: "vec4<f32>", bytes: 16 });
        for (const stage of signature.coordStages) {
            if (stage.transformCount)
                fields.push({ name: "texture_transform" + stage.index,
                    type: "mat4x4<f32>", bytes: 64, source: stage.index });
        }
        if (signature.lighting) {
            fields.push(
                { name: "material_diffuse", type: "vec4<f32>", bytes: 16 },
                { name: "material_ambient", type: "vec4<f32>", bytes: 16 },
                { name: "material_specular", type: "vec4<f32>", bytes: 16 },
                { name: "material_emissive", type: "vec4<f32>", bytes: 16 },
                // xyz = D3DRS_AMBIENT, w = the material's specular power.
                { name: "ambient_power", type: "vec4<f32>", bytes: 16 });
            if (signature.lighting.lights.length)
                fields.push({ name: "lights",
                    type: "array<D9Light, " + signature.lighting.lights.length + ">",
                    bytes: 112 * signature.lighting.lights.length });
        }
        if (signature.clipPlaneCount)
            fields.push({ name: "clip_planes",
                type: "array<vec4<f32>, " + signature.clipPlaneCount + ">",
                bytes: 16 * signature.clipPlaneCount });
        if (signature.pointExpansion) {
            fields.push(
                { name: "point_viewport", type: "vec4<f32>", bytes: 16 },
                // x=size, y=min, z=max, w reserved.
                { name: "point_params", type: "vec4<f32>", bytes: 16 });
            if (signature.pointScale)
                fields.push({ name: "point_scale", type: "vec4<f32>", bytes: 16 });
        }
        return uniformBlockLayout(fields);
    }

    // The pixel block: only what the texture cascade and the fog blend read.
    function fixedPixelUniformLayout(signature) {
        const fields = [];
        if (signature.fogMode)
            fields.push({ name: "fog_color", type: "vec4<f32>", bytes: 16 });
        if (signature.tableFog)
            fields.push({ name: "fog_params", type: "vec4<f32>", bytes: 16 });
        if (signature.usesTextureFactor)
            fields.push({ name: "texture_factor", type: "vec4<f32>", bytes: 16 });
        for (const stage of signature.stages) {
            if (stage.usesConstant)
                fields.push({ name: "stage_constant" + stage.index,
                    type: "vec4<f32>", bytes: 16, source: stage.index });
            // The bump matrix and luminance terms belong to the stage that
            // declared BUMPENVMAP, not to the stage that samples with them.
            if (stage.isBumpSource) {
                fields.push({ name: "stage_bump" + stage.index,
                    type: "vec4<f32>", bytes: 16, bumpSource: stage.index });
                if (stage.colorOp === D3DTOP_BUMPENVMAPLUMINANCE)
                    fields.push({ name: "stage_bump_lum" + stage.index,
                        type: "vec4<f32>", bytes: 16,
                        bumpLuminanceSource: stage.index });
            }
        }
        return uniformBlockLayout(fields);
    }

    function fixedFogFactorExpression(mode, distance) {
        return {
            [D3DFOG_LINEAR]: "clamp((uniforms.fog_params.y - " + distance + ") / " +
                "max(uniforms.fog_params.y - uniforms.fog_params.x, 1e-6), 0.0, 1.0)",
            [D3DFOG_EXP]: "clamp(exp(-(uniforms.fog_params.z * " + distance + ")), " +
                "0.0, 1.0)",
            [D3DFOG_EXP2]: "clamp(exp(-((uniforms.fog_params.z * " + distance + ") * " +
                "(uniforms.fog_params.z * " + distance + "))), 0.0, 1.0)",
        }[mode] || null;
    }

    // ---- D3DTEXTUREOP -> WGSL ----
    //
    // D3D9's texture cascade runs the colour and alpha channels through
    // *separate* operations with separate arguments, so each operation is
    // emitted twice: once over vec3 and once over f32. `blend` names the alpha
    // an op blends with (diffuse/texture/factor/current), which the caller
    // supplies as an already-built scalar expression.
    //
    // Only the operations fill_caps() lists in TextureOpCaps appear here.
    // Returning null makes the caller count the draw and fall back to
    // SELECTARG1 rather than inventing an approximation.
    function textureOpExpression(op, type, args, blend) {
        const one = type === "vec3<f32>" ? "vec3<f32>(1.0)" : "1.0";
        const half = type === "vec3<f32>" ? "vec3<f32>(0.5)" : "0.5";
        const a0 = args[0], a1 = args[1], a2 = args[2];
        switch (op) {
        case D3DTOP_SELECTARG1: return a1;
        case D3DTOP_SELECTARG2: return a2;
        case D3DTOP_MODULATE: return "(" + a1 + " * " + a2 + ")";
        case D3DTOP_MODULATE2X: return "((" + a1 + " * " + a2 + ") * 2.0)";
        case D3DTOP_MODULATE4X: return "((" + a1 + " * " + a2 + ") * 4.0)";
        case D3DTOP_ADD: return "(" + a1 + " + " + a2 + ")";
        case D3DTOP_ADDSIGNED:
            return "(" + a1 + " + " + a2 + " - " + half + ")";
        case D3DTOP_ADDSIGNED2X:
            return "((" + a1 + " + " + a2 + " - " + half + ") * 2.0)";
        case D3DTOP_SUBTRACT: return "(" + a1 + " - " + a2 + ")";
        case D3DTOP_ADDSMOOTH:
            return "(" + a1 + " + " + a2 + " * (" + one + " - " + a1 + "))";
        case D3DTOP_BLENDDIFFUSEALPHA:
        case D3DTOP_BLENDTEXTUREALPHA:
        case D3DTOP_BLENDFACTORALPHA:
        case D3DTOP_BLENDCURRENTALPHA:
            return "mix(" + a2 + ", " + a1 + ", " + blend + ")";
        case D3DTOP_BLENDTEXTUREALPHAPM:
            // Pre-multiplied: arg1 already carries the alpha it was scaled by.
            return "(" + a1 + " + " + a2 + " * (1.0 - " + blend + "))";
        case D3DTOP_DOTPRODUCT3: {
            // Signed-scaled dot product replicated to every channel including
            // alpha, which is why the alpha form is the same expression.
            const dot = "(4.0 * dot(" + args.rgb1 + " - vec3<f32>(0.5), " +
                args.rgb2 + " - vec3<f32>(0.5)))";
            return type === "vec3<f32>" ? "vec3<f32>(" + dot + ")" : dot;
        }
        case D3DTOP_BUMPENVMAP:
        case D3DTOP_BUMPENVMAPLUMINANCE:
            // A bump stage produces no colour of its own: its whole effect is
            // the coordinate perturbation the *next* stage samples with (see
            // the bump handling in buildFixedFunctionPixelShader). D3D leaves
            // the running result untouched, which is arg2 -- D3DTA_CURRENT by
            // default.
            return a2;
        // The four "modulate one channel set, add the other" forms. Each
        // reaches for arg1's alpha alongside arg1's colour, which is why the
        // caller supplies `args.alpha1` separately -- `a1` here is already
        // reduced to the channel being computed. D3D9 defines all four for
        // D3DTSS_COLOROP only, so the f32 form falls through to the null
        // default and is counted rather than invented.
        case D3DTOP_MODULATEALPHA_ADDCOLOR:
            if (type !== "vec3<f32>") return null;
            return "(" + args.rgb1 + " + " + args.alpha1 + " * " + args.rgb2 + ")";
        case D3DTOP_MODULATECOLOR_ADDALPHA:
            if (type !== "vec3<f32>") return null;
            return "(" + args.rgb1 + " * " + args.rgb2 + " + " +
                "vec3<f32>(" + args.alpha1 + "))";
        case D3DTOP_MODULATEINVALPHA_ADDCOLOR:
            if (type !== "vec3<f32>") return null;
            return "((1.0 - " + args.alpha1 + ") * " + args.rgb2 + " + " +
                args.rgb1 + ")";
        case D3DTOP_MODULATEINVCOLOR_ADDALPHA:
            if (type !== "vec3<f32>") return null;
            return "((vec3<f32>(1.0) - " + args.rgb1 + ") * " + args.rgb2 +
                " + vec3<f32>(" + args.alpha1 + "))";
        case D3DTOP_MULTIPLYADD:
            return "(" + a0 + " + " + a1 + " * " + a2 + ")";
        case D3DTOP_LERP:
            return "mix(" + a2 + ", " + a1 + ", " + a0 + ")";
        default:
            return null;
        }
    }

    // Fixed-function vertex stage: position transform, optional lighting,
    // per-stage texture coordinate generation/transform and fog, all written
    // into the shared varying set. `signature` comes from
    // fixedFunctionVertexSignature() plus the state-derived fields
    // programFor() adds.
    function buildFixedFunctionVertexShader(signature) {
        const layout = fixedVertexUniformLayout(signature);
        const lighting = signature.lighting;
        const position = "in" + FF_LOCATION_POSITION;

        const parameters = [vertexInputDeclaration(FF_LOCATION_POSITION)];
        if (signature.hasColor)
            parameters.push(vertexInputDeclaration(FF_LOCATION_COLOR0));
        if (signature.hasColor1)
            parameters.push(vertexInputDeclaration(FF_LOCATION_COLOR1));
        if (signature.hasNormal)
            parameters.push(vertexInputDeclaration(FF_LOCATION_NORMAL));
        if (signature.hasPointSize)
            parameters.push(vertexInputDeclaration(FF_LOCATION_PSIZE));
        const blend = signature.vertexBlend;
        if (blend && blend.weightCount)
            parameters.push(vertexInputDeclaration(FF_LOCATION_BLENDWEIGHT));
        if (blend && blend.indexed)
            parameters.push(vertexInputDeclaration(FF_LOCATION_BLENDINDICES,
                blend.indexScalar));
        for (const set of signature.texCoordSets)
            parameters.push(vertexInputDeclaration(FF_LOCATION_TEXCOORD0 + set));
        if (signature.pointExpansion)
            parameters.push("@builtin(vertex_index) d9_vertex_index: u32");

        const varyings = [];
        for (let slot = 0; slot < VARYING_COUNT; ++slot)
            varyings.push(varyingDeclaration(slot, signature.flatShading));
        const clipVaryings = [];
        let clipBody = "";
        if (signature.clipPlaneCount) {
            const clipPosition = blend ? "d9_blend_position"
                : signature.positionType === "screen" ? position
                : "uniforms.world_matrix * " + position;
            clipBody += "    let d9_clip_position = " + clipPosition + ";\n";
        }
        for (let group = 0; group < Math.ceil(
                (signature.clipPlaneCount || 0) / 4); ++group) {
            clipVaryings.push("    @location(" + (VARYING_COUNT + group) +
                ") clip" + group + ": vec4<f32>,");
            clipBody += "    result.clip" + group +
                " = vec4<f32>(1.0);\n";
        }
        for (let plane = 0; plane < (signature.clipPlaneCount || 0); ++plane)
            clipBody += "    result.clip" + Math.floor(plane / 4) + "." +
                "xyzw"[plane & 3] + " = dot(d9_clip_position, " +
                "uniforms.clip_planes[" + plane + "]);\n";

        // ---- fixed-function vertex blending (D3DRS_VERTEXBLEND) ----
        //
        // D3D9 poses a vertex as sum(w_i * (v * WORLDMATRIX(i))) and applies
        // view and projection only to the result, so a blended draw cannot
        // fold the world matrix into world_view_projection the way every
        // other draw does -- which world matrix applies is a per-vertex
        // question. BLENDWEIGHT carries one fewer weight than there are
        // matrices because D3D9 defines the last as 1 - sum(the rest); that is
        // what keeps the weights a partition of unity even when the exported
        // ones do not quite sum to 1.
        //
        // Normals ride the same blend through the same matrices, with no
        // per-matrix inverse transpose. That is D3D9's behaviour rather than an
        // approximation of it: a blend of two rotations is shorter than either,
        // which is the whole reason D3DRS_NORMALIZENORMALS exists, and it is
        // honoured below where an unblended draw honours it.
        const blendedPosition = blend ? "d9_blend_position" : position;
        let blendBody = "";
        if (blend) {
            const slots = blend.matrixCount;
            const weights = [];
            for (let slot = 0; slot < slots - 1; ++slot)
                weights.push("in" + FF_LOCATION_BLENDWEIGHT + "." + "xyzw"[slot]);
            blendBody = "    var d9_blend_position = vec4<f32>(0.0);\n";
            if (signature.hasNormal)
                blendBody += "    var d9_blend_normal = vec3<f32>(0.0);\n";
            if (weights.length)
                blendBody += "    let d9_blend_last = 1.0 - (" +
                    weights.join(" + ") + ");\n";
            if (blend.indexed) {
                // A palette index out of range is the app's bug, but WGSL gives
                // no defined value for an out-of-bounds uniform read, so clamp:
                // one wrong bone beats an indeterminate matrix.
                const raw = "in" + FF_LOCATION_BLENDINDICES;
                let unsigned;
                if (blend.indexScalar === "u32")
                    unsigned = raw;
                else if (blend.indexScalar === "i32")
                    unsigned = "vec4<u32>(max(" + raw + ", vec4<i32>(0)))";
                else if (blend.indexNormalized)
                    // Rounded, not truncated: 2/255 * 255 does not land exactly
                    // on 2 in f32, and truncating it would select bone 1.
                    unsigned = "vec4<u32>(round(" + raw + " * 255.0))";
                else
                    unsigned = "vec4<u32>(max(" + raw + ", vec4<f32>(0.0)))";
                blendBody += "    let d9_blend_index = min(" + unsigned +
                    ",\n        vec4<u32>(" + (blend.matrixSlots - 1) + "u));\n";
            }
            for (let slot = 0; slot < slots; ++slot) {
                const weight = slot < slots - 1 ? weights[slot]
                    : (weights.length ? "d9_blend_last" : "1.0");
                const index = blend.indexed
                    ? "d9_blend_index." + "xyzw"[slot] : slot + "u";
                blendBody += "    {\n" +
                    "        let d9_bone = uniforms.blend_worlds[" + index + "];\n" +
                    "        let d9_weight = " + weight + ";\n" +
                    "        d9_blend_position = d9_blend_position +\n" +
                    "            (d9_bone * " + position + ") * d9_weight;\n";
                if (signature.hasNormal)
                    blendBody +=
                    "        d9_blend_normal = d9_blend_normal +\n" +
                    "            (d9_bone * vec4<f32>(in" + FF_LOCATION_NORMAL +
                        ".xyz, 0.0)).xyz * d9_weight;\n";
                blendBody += "    }\n";
            }
        }


        // XYZRHW ("screen") vertices arrive already in viewport pixel space and
        // bypass the world/view/projection chain entirely. D3D9 also treats
        // them as already lit, which is why lighting is forced off for them.
        // XYZRHW ("screen") coordinates are absolute render-target pixels, not
        // pixels relative to the viewport -- so the viewport's origin has to
        // come off before normalising, because setViewport puts it back when it
        // maps NDC into the viewport rect. Omitting it made the two cancel only
        // for a viewport at 0,0, which is every full-screen UI pass and hid the
        // bug completely. Kart Rider draws its shop item previews through
        // 110x109 viewports at x=368..636, and pre-transformed geometry there
        // landed several viewport-widths outside the box and was clipped away:
        // the panels whose contents are entirely pre-transformed came out
        // empty, while the one item drawn from world-space geometry rendered
        // perfectly. Same fix as wined3d's transformed-position projection
        // matrix, which carries the -2x/w term for exactly this reason.
        const positionBody = blendBody + (signature.positionType === "screen"
            ? `    let viewport = uniforms.viewport;
    let ndc_x = ((${position}.x - viewport.z) / viewport.x) * 2.0 - 1.0;
    let ndc_y = 1.0 - ((${position}.y - viewport.w) / viewport.y) * 2.0;
    result.position = vec4<f32>(ndc_x, ndc_y, ${position}.z, 1.0);`
            : "    result.position = uniforms." +
                (blend ? "view_projection" : "world_view_projection") +
                " * " + blendedPosition + ";")
            + "\n" + HALF_PIXEL_OFFSET_BODY;

        // View space is where D3D9 lights live and where the camera-space
        // coordinate generation modes are defined, so one block serves both.
        // The light positions/directions themselves arrive already multiplied by
        // the view matrix (see writeFixedVertexUniforms) rather than as a second
        // matrix in the shader.
        let viewSpaceBody = "";
        if (signature.needsViewSpace) {
            // With blending, world_view/normal_matrix hold the view half only
            // -- the world half already happened, per vertex, above.
            viewSpaceBody = "    let position_view = uniforms." +
                (blend ? "view_matrix" : "world_view") + " * " +
                blendedPosition + ";\n";
            if (signature.hasNormal) {
                const normalSource = blend ? "d9_blend_normal"
                    : "in" + FF_LOCATION_NORMAL + ".xyz";
                viewSpaceBody += "    var normal_view = (uniforms.normal_matrix" +
                    " * vec4<f32>(" + normalSource + ", 0.0)).xyz;\n";
                // D3DRS_NORMALIZENORMALS is honoured rather than always
                // normalising: D3D9 genuinely does not renormalise unless asked,
                // so a scaled world matrix produces over- or under-bright
                // lighting, and silently fixing that would make this renderer
                // disagree with the reference for content tuned against it.
                if (signature.normalizeNormals)
                    viewSpaceBody += "    normal_view = normalize(normal_view);\n";
            } else {
                // A declaration with no normal cannot receive directional
                // diffuse/specular light; D3D9 uses (0,0,0), which zeroes every
                // N.L term while leaving ambient + emissive.
                viewSpaceBody += "    let normal_view = vec3<f32>(0.0);\n";
            }
        }

        // Vertex colours, before any material-source selection.
        const vertexDiffuse = signature.hasColor
            ? "in" + FF_LOCATION_COLOR0 + (signature.colorIsBGRA ? ".bgra" : "")
            : "vec4<f32>(1.0, 1.0, 1.0, 1.0)";
        const vertexSpecular = signature.hasColor1
            ? "in" + FF_LOCATION_COLOR1 + (signature.color1IsBGRA ? ".bgra" : "")
            : "vec4<f32>(0.0, 0.0, 0.0, 0.0)";

        let colorBody = "    let vertex_diffuse = " + vertexDiffuse + ";\n" +
            "    let vertex_specular = " + vertexSpecular + ";\n";
        if (lighting) {
            // D3DRS_COLORVERTEX off forces every channel to the material;
            // otherwise D3DRS_*MATERIALSOURCE picks between the material and
            // the two vertex colours. The D3D9 defaults are COLOR1 for diffuse
            // and COLOR2 for specular, which is why a lit mesh with per-vertex
            // colours is tinted by them rather than by the material alone.
            const sourceExpression = (source, materialField) => {
                if (!lighting.colorVertex) return "uniforms." + materialField;
                if (source === D3DMCS_COLOR1) return "vertex_diffuse";
                if (source === D3DMCS_COLOR2) return "vertex_specular";
                return "uniforms." + materialField;
            };
            colorBody +=
                "    let material_diffuse = " +
                    sourceExpression(lighting.diffuseSource, "material_diffuse") + ";\n" +
                "    let material_ambient = " +
                    sourceExpression(lighting.ambientSource, "material_ambient") + ";\n" +
                "    let material_specular = " +
                    sourceExpression(lighting.specularSource, "material_specular") + ";\n" +
                "    let material_emissive = " +
                    sourceExpression(lighting.emissiveSource, "material_emissive") + ";\n" +
                "    var total_diffuse = vec3<f32>(0.0);\n" +
                "    var total_ambient = uniforms.ambient_power.xyz;\n" +
                "    var total_specular = vec3<f32>(0.0);\n" +
                // Without D3DRS_LOCALVIEWER the eye vector is the constant
                // (0,0,-1) of D3D9's left-handed view space, which is the
                // cheaper approximation engines of this era normally leave on.
                "    let eye_direction = " + (lighting.localViewer
                    ? "normalize(-position_view.xyz)"
                    : "vec3<f32>(0.0, 0.0, -1.0)") + ";\n";
            lighting.lights.forEach((light, index) => {
                colorBody += "    {\n" +
                    "        let light = uniforms.lights[" + index + "];\n";
                if (light.type === D3DLIGHT_DIRECTIONAL) {
                    colorBody +=
                        "        let light_direction = -light.direction.xyz;\n" +
                        "        let attenuation = 1.0;\n";
                } else {
                    colorBody +=
                        "        let to_light = light.position.xyz - position_view.xyz;\n" +
                        "        let light_distance = length(to_light);\n" +
                        "        let light_direction = select(vec3<f32>(0.0, 0.0, 1.0),\n" +
                        "            to_light / max(light_distance, 1e-6), light_distance > 0.0);\n" +
                        // D3D9 attenuates by 1/(a0 + a1*d + a2*d^2) and drops
                        // the light entirely past its range.
                        "        var range_attenuation = 1.0 / max(light.attenuation.x +\n" +
                        "            light.attenuation.y * light_distance +\n" +
                        "            light.attenuation.z * light_distance * light_distance, 1e-6);\n" +
                        "        range_attenuation = min(range_attenuation, 1.0);\n" +
                        "        if (light_distance > light.range_falloff.x) {\n" +
                        "            range_attenuation = 0.0;\n" +
                        "        }\n";
                    if (light.type === D3DLIGHT_SPOT) {
                        // range_falloff = (range, falloff, cos(theta/2), cos(phi/2)).
                        colorBody +=
                            "        let rho = dot(light.direction.xyz, -light_direction);\n" +
                            "        var spot = 0.0;\n" +
                            "        if (rho > light.range_falloff.z) {\n" +
                            "            spot = 1.0;\n" +
                            "        } else if (rho > light.range_falloff.w) {\n" +
                            "            spot = pow(max((rho - light.range_falloff.w) /\n" +
                            "                max(light.range_falloff.z - light.range_falloff.w, 1e-6),\n" +
                            "                0.0), max(light.range_falloff.y, 1e-4));\n" +
                            "        }\n" +
                            "        let attenuation = range_attenuation * spot;\n";
                    } else {
                        colorBody += "        let attenuation = range_attenuation;\n";
                    }
                }
                colorBody +=
                    "        let n_dot_l = max(dot(normal_view, light_direction), 0.0);\n" +
                    "        total_diffuse = total_diffuse + light.diffuse.xyz *\n" +
                    "            (n_dot_l * attenuation);\n" +
                    "        total_ambient = total_ambient + light.ambient.xyz * attenuation;\n";
                if (lighting.specularEnable) {
                    colorBody +=
                        "        let half_vector = normalize(light_direction + eye_direction);\n" +
                        "        let n_dot_h = max(dot(normal_view, half_vector), 0.0);\n" +
                        // Back faces contribute no highlight, and pow(0, p) is
                        // only well-defined for p > 0, hence both guards.
                        "        let highlight = select(0.0,\n" +
                        "            pow(n_dot_h, max(uniforms.ambient_power.w, 1e-4)),\n" +
                        "            n_dot_l > 0.0);\n" +
                        "        total_specular = total_specular + light.specular.xyz *\n" +
                        "            (highlight * attenuation);\n";
                }
                colorBody += "    }\n";
            });
            colorBody +=
                "    let lit_rgb = clamp(total_ambient * material_ambient.xyz +\n" +
                "        total_diffuse * material_diffuse.xyz + material_emissive.xyz,\n" +
                "        vec3<f32>(0.0), vec3<f32>(1.0));\n" +
                // D3D9 takes the lit vertex's alpha from the diffuse material
                // channel only -- lighting never affects alpha.
                "    let out_diffuse = vec4<f32>(lit_rgb, clamp(material_diffuse.a, 0.0, 1.0));\n" +
                "    let out_specular = vec4<f32>(clamp(total_specular *\n" +
                "        material_specular.xyz, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0);\n";
        } else {
            colorBody += "    let out_diffuse = vertex_diffuse;\n" +
                "    let out_specular = vertex_specular;\n";
        }

        // Fog distance is the clip-space w, which for a standard projection is
        // the eye-space depth -- exactly D3DPRASTERCAPS_WFOG, which the guest
        // advertises. D3DRS_RANGEFOGENABLE asks for true radial distance
        // instead, which removes the "fog thins towards the screen edges"
        // artefact of depth-based fog.
        const fogDistance = signature.fogRange && signature.needsViewSpace
            ? "length(position_view.xyz)" : "abs(result.position.w)";
        const fogFactor = fixedFogFactorExpression(signature.fogMode,
            "fog_distance");
        const fogBody = fogFactor
            ? "    let fog_distance = " + fogDistance + ";\n" +
              "    result.varying" + shaderPipeline.VARYING_FOG +
              " = vec4<f32>(" + fogFactor + ", 0.0, 0.0, 0.0);\n"
            : "";

        // One texture-coordinate varying per *stage*, not per declared
        // coordinate set: D3DTSS_TEXCOORDINDEX chooses which set (or which
        // generated vector) feeds a stage, and D3DTS_TEXTURE0+n transforms it,
        // so the varying a pixel stage reads for stage n is already the final
        // coordinate. That is also what D3D9 hands a real pixel shader, whose
        // texcoord input n corresponds to texture stage n.
        let coordBody = "";
        for (const stage of signature.coordStages) {
            let raw;
            // XYZRHW vertices have already passed the object/view transform
            // and carry neither an eye-space position nor a normal. A few
            // D3D8 applications leave camera-space TCI bits behind when they
            // switch to a pre-transformed overlay. Native D3D treats the
            // generated value there as undefined; referring to the absent
            // position_view/normal_view locals is worse because it makes the
            // whole WGSL module invalid and poisons the command buffer. Keep a
            // declared coordinate when one exists, otherwise use the same
            // benign (0,0,0,1) value as a missing passthrough coordinate.
            if (signature.positionType === "screen" &&
                    stage.tciMode !== D3DTSS_TCI_PASSTHRU) {
                raw = signature.texCoordSets.includes(stage.texCoordIndex)
                    ? "in" + (FF_LOCATION_TEXCOORD0 + stage.texCoordIndex)
                    : "vec4<f32>(0.0, 0.0, 0.0, 1.0)";
            } else switch (stage.tciMode) {
            case D3DTSS_TCI_CAMERASPACENORMAL:
                raw = "vec4<f32>(normal_view, 1.0)";
                break;
            case D3DTSS_TCI_CAMERASPACEPOSITION:
                raw = "vec4<f32>(position_view.xyz, 1.0)";
                break;
            case D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR:
                raw = "vec4<f32>(reflect(normalize(position_view.xyz), " +
                    "normalize(normal_view)), 1.0)";
                break;
            case D3DTSS_TCI_SPHEREMAP:
                // The classic sphere-map projection of the eye-space
                // reflection vector: the same formula OpenGL's GL_SPHERE_MAP
                // and wined3d use, which is what titles authored their
                // sphere-map art against. m is twice the length of
                // (R.x, R.y, R.z + 1), and the +0.5 recentres the result into
                // the [0,1] texture domain.
                raw = "(func_sphere_map(reflect(normalize(position_view.xyz), " +
                    "normalize(normal_view))))";
                break;
            default:
                raw = signature.texCoordSets.includes(stage.texCoordIndex)
                    ? "in" + (FF_LOCATION_TEXCOORD0 + stage.texCoordIndex)
                    : "vec4<f32>(0.0, 0.0, 0.0, 1.0)";
                break;
            }
            let expression = raw;
            if (stage.transformCount) {
                // The coordinate enters the matrix as a *row* vector padded
                // with ones, which is why a scrolling animation puts its offset
                // in row 3 (_31/_32) for the two-component form. The matrix is
                // uploaded untransposed for the same reason the WVP is: D3D's
                // row-major bytes read back as the transpose in WGSL, and that
                // transpose is exactly the column-vector form of D3D's
                // row-vector multiply.
                const padded = {
                    1: "vec4<f32>(" + raw + ".x, 1.0, 1.0, 1.0)",
                    2: "vec4<f32>(" + raw + ".xy, 1.0, 1.0)",
                    3: "vec4<f32>(" + raw + ".xyz, 1.0)",
                    4: raw,
                }[stage.transformCount] || raw;
                expression = "(uniforms.texture_transform" + stage.index +
                    " * " + padded + ")";
            }
            coordBody += "    result.varying" +
                (VARYING_TEXCOORD0 + stage.index) + " = " + expression + ";\n";
        }

        let pointBody = "";
        if (signature.pointExpansion) {
            const baseSize = signature.hasPointSize
                ? "in" + FF_LOCATION_PSIZE + ".x" : "uniforms.point_params.x";
            pointBody +=
                "    let d9_point_uvs = array<vec2<f32>, 6>(\n" +
                "        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0),\n" +
                "        vec2<f32>(0.0, 1.0), vec2<f32>(0.0, 1.0),\n" +
                "        vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));\n" +
                "    let d9_point_uv = d9_point_uvs[d9_vertex_index % 6u];\n" +
                "    var d9_point_size = " + baseSize + ";\n";
            if (signature.pointScale) {
                pointBody +=
                    "    let d9_point_distance = length(position_view.xyz);\n" +
                    "    let d9_point_denom = max(uniforms.point_scale.x +\n" +
                    "        uniforms.point_scale.y * d9_point_distance +\n" +
                    "        uniforms.point_scale.z * d9_point_distance * d9_point_distance, 1e-6);\n" +
                    "    d9_point_size = d9_point_size * uniforms.point_viewport.y *\n" +
                    "        inverseSqrt(d9_point_denom);\n";
            }
            pointBody +=
                "    d9_point_size = clamp(d9_point_size, uniforms.point_params.y,\n" +
                "        max(uniforms.point_params.y, uniforms.point_params.z));\n" +
                "    let d9_point_ndc = vec2<f32>(\n" +
                "        (d9_point_uv.x * 2.0 - 1.0) * d9_point_size / uniforms.point_viewport.x,\n" +
                "        (1.0 - d9_point_uv.y * 2.0) * d9_point_size / uniforms.point_viewport.y);\n" +
                "    result.position = vec4<f32>(result.position.xy +\n" +
                "        d9_point_ndc * result.position.w, result.position.zw);\n";
            if (signature.pointSprite) {
                for (let stage = 0; stage < MAX_TEXCOORD_SETS; ++stage) {
                    pointBody += "    result.varying" +
                        (VARYING_TEXCOORD0 + stage) +
                        " = vec4<f32>(d9_point_uv, 0.0, 1.0);\n";
                }
            }
        }

        const lightStruct = lighting && lighting.lights.length ? `struct D9Light {
    diffuse: vec4<f32>,
    specular: vec4<f32>,
    ambient: vec4<f32>,
    position: vec4<f32>,
    direction: vec4<f32>,
    range_falloff: vec4<f32>,
    attenuation: vec4<f32>,
};
` : "";

        // Emitted only when a stage asks for it, so the ordinary vertex stage
        // is unchanged.
        const sphereMapHelper = signature.coordStages.some(stage =>
            stage.tciMode === D3DTSS_TCI_SPHEREMAP) ? `
fn func_sphere_map(r: vec3<f32>) -> vec4<f32> {
    // m = 2 * |(R.x, R.y, R.z + 1)|. The guard keeps the division finite for
    // the one reflection vector that degenerates it, R = (0, 0, -1), which is
    // the direction looking straight down the reflected axis.
    let m = 2.0 * sqrt(r.x * r.x + r.y * r.y + (r.z + 1.0) * (r.z + 1.0));
    return vec4<f32>(r.x / max(m, 1e-6) + 0.5, r.y / max(m, 1e-6) + 0.5,
        0.0, 1.0);
}
` : "";

        return `${lightStruct}${uniformBlockStruct("D9FixedUniforms", layout)}
@group(0) @binding(0) var<uniform> uniforms: D9FixedUniforms;
${sphereMapHelper}

struct D9VertexOutput {
    @builtin(position) position: vec4<f32>,
${varyings.join("\n")}
${clipVaryings.join("\n")}
};

@vertex
fn d9_vs_main(${parameters.join(", ")}) -> D9VertexOutput {
    var result: D9VertexOutput;
${positionBody}
${varyings.map((_, slot) =>
        "    result.varying" + slot + " = vec4<f32>(0.0);").join("\n")}
${viewSpaceBody}${colorBody}    result.varying${VARYING_COLOR0} = out_diffuse;
    result.varying${shaderPipeline.VARYING_COLOR1} = out_specular;
${coordBody}${fogBody}${clipBody}${pointBody}    return result;
}
`;
    }

    // Fixed-function pixel stage: D3D9's texture blending cascade.
    //
    // M1/M2 hardcoded one stage of MODULATE(texture, diffuse). This walks the
    // real cascade instead: stages 0..N-1 (N ends at the first D3DTOP_DISABLE),
    // each with its own colour and alpha operation over arguments drawn from
    // diffuse, the running result, the stage's texture, D3DRS_TEXTUREFACTOR,
    // the specular colour, a scratch register and the stage's own constant --
    // which is what terrain splatting, detail texturing and light mapping are
    // actually built from. Every stage saturates its result, as D3D9 does.
    //
    // debugMode (null in normal operation) replaces the output with something
    // unambiguous, so "the screen is black" can be attributed to a specific
    // input rather than guessed at:
    //   "solid"   flat green  -- proves geometry coverage and that fragments land
    //   "color"   vertex colour only, textures ignored
    //   "texture" stage 0's texture sample only, vertex colour ignored
    //   "uv"      stage 0's texcoords as red/green -- shows whether UVs are sane
    //   "missing" flat magenta -- set per draw by debug.highlightMissingTexture
    //             to mark the draws sampling a stage with no live texture
    function buildFixedFunctionPixelShader(signature, debugMode) {
        const layout = fixedPixelUniformLayout(signature);
        const diffuse = "stage_in.varying" + VARYING_COLOR0;
        const specular = "stage_in.varying" + shaderPipeline.VARYING_COLOR1;

        // Per-stage texture declarations. Cube and volume textures reach the
        // fixed-function cascade too (environment mapping, volume fog), so the
        // WGSL texture type and the coordinate arity both come from whatever is
        // actually bound.
        const declarations = [];
        const samples = [];
        for (const stage of signature.stages) {
            if (!stage.samplesTexture) continue;
            const wgslType = { cube: "texture_cube<f32>", "3d": "texture_3d<f32>" }[
                stage.textureType] || "texture_2d<f32>";
            declarations.push("@group(0) @binding(" + (2 + stage.index * 2) +
                ") var d9_tex" + stage.index + ": " + wgslType + ";");
            declarations.push("@group(0) @binding(" + (3 + stage.index * 2) +
                ") var d9_smp" + stage.index + ": sampler;");
            const coord = "stage_in.varying" +
                (VARYING_TEXCOORD0 + stage.coordVarying);
            const components = stage.textureType === "2d" ? 2 : 3;
            let coordExpression = coord +
                (components === 2 ? ".xy" : ".xyz");
            if (stage.projected) {
                // D3DTTFF_PROJECTED divides by the last component of the
                // transformed coordinate, so the divisor follows the transform's
                // component count, not the texture's dimensionality.
                const divisor = coord + "." +
                    ["x", "x", "y", "z", "w"][stage.transformCount || 4];
                // Preserve the sign of q. Clamping a negative divisor with
                // max(q, epsilon) turns every behind-projector coordinate into
                // an enormous positive UV; Warcraft III's projected tree
                // shadows then sample the opaque edge texel over whole terrain
                // triangles, producing the characteristic black wedges.
                const safeDivisor = "select(-max(abs(" + divisor +
                    "), 1e-6), max(abs(" + divisor + "), 1e-6), " +
                    divisor + " >= 0.0)";
                coordExpression = "(" + coordExpression + " / (" +
                    safeDivisor + "))";
            }
            // D3DTOP_BUMPENVMAP: the previous stage sampled a (du, dv) pair,
            // and this stage's coordinate is displaced by it through that
            // stage's 2x2 bump matrix. The bump formats decode signed (see
            // signedNormalized in the upload path), so du/dv are used as
            // sampled rather than being rescaled from unorm here.
            if (stage.bumpFrom !== undefined && stage.textureType === "2d") {
                const bump = "uniforms.stage_bump" + stage.bumpFrom;
                const source = "tex" + stage.bumpFrom;
                coordExpression = "((" + coordExpression + ") + vec2<f32>(" +
                    bump + ".x * " + source + ".r + " + bump + ".z * " +
                    source + ".g, " + bump + ".y * " + source + ".r + " +
                    bump + ".w * " + source + ".g))";
            }
            // D3DTADDRESS_MIRRORONCE: mirror about zero, then clamp. The
            // sampler is already clamp-to-edge for such an axis (see
            // ADDRESS_MODES), so taking the absolute value of the coordinate
            // here completes the mode exactly rather than approximating it --
            // abs() folds the [-1,0] half onto [0,1] and the clamp handles
            // everything beyond. Cube addressing ignores address modes, so it
            // is excluded.
            const mirrorOnceAxes = stage.textureType === "cube" ? [] :
                (stage.textureType === "3d"
                    ? [[stage.addressU, "x"], [stage.addressV, "y"],
                       [stage.addressW, "z"]]
                    : [[stage.addressU, "x"], [stage.addressV, "y"]])
                .filter(axis => axis[0] === 5).map(axis => axis[1]);
            if (mirrorOnceAxes.length) {
                const axes = stage.textureType === "3d"
                    ? ["x", "y", "z"] : ["x", "y"];
                const vector = stage.textureType === "3d"
                    ? "vec3<f32>" : "vec2<f32>";
                coordExpression = vector + "(" + axes.map(axis =>
                    (mirrorOnceAxes.includes(axis)
                        ? "abs((" + coordExpression + ")." + axis + ")"
                        : "(" + coordExpression + ")." + axis)).join(", ") + ")";
            }
            const sampled = stage.lodBias
                ? "textureSampleBias(d9_tex" + stage.index + ", d9_smp" +
                    stage.index + ", " + coordExpression + ", " +
                    stage.lodBias.toFixed(6) + ")"
                : "textureSample(d9_tex" + stage.index +
                    ", d9_smp" + stage.index + ", " + coordExpression + ")";
            const borderAxes = stage.textureType === "cube" ? [] :
                (stage.textureType === "3d"
                    ? [[stage.addressU, "x"], [stage.addressV, "y"],
                       [stage.addressW, "z"]]
                    : [[stage.addressU, "x"], [stage.addressV, "y"]])
                .filter(axis => axis[0] === 4).map(axis => axis[1]);
            let colorKeyInside = null;
            if (borderAxes.length) {
                // WebGPU has no border-colour sampler.  Clamp for the physical
                // sample, then replace every coordinate outside the D3D unit
                // domain on an axis whose addressing mode is BORDER.  This is
                // especially important after projected division: sampling an
                // opaque edge texel outside a shadow/fog projector turns whole
                // terrain triangles into black masks.
                const inside = borderAxes.map(axis => "(" + coordExpression +
                    ")." + axis + " >= 0.0 && (" + coordExpression + ")." +
                    axis + " <= 1.0").join(" && ");
                colorKeyInside = inside;
                const color = stage.borderColor === undefined
                    ? 0 : stage.borderColor >>> 0;
                const component = shift =>
                    (((color >>> shift) & 0xff) / 255).toFixed(8);
                const border = "vec4<f32>(" + component(16) + ", " +
                    component(8) + ", " + component(0) + ", " +
                    component(24) + ")";
                samples.push("    let tex" + stage.index + " = select(" +
                    border + ", " + sampled + ", " + inside + ");");
            } else {
                samples.push("    let tex" + stage.index + " = " + sampled + ";");
            }
            if (stage.colorKey && !stage.colorKey.indexed) {
                const low = stage.colorKey.low >>> 0;
                const high = stage.colorKey.high >>> 0;
                const rgb = value => "vec3<u32>(" +
                    ((value >>> 16) & 0xff) + "u, " +
                    ((value >>> 8) & 0xff) + "u, " +
                    (value & 0xff) + "u)";
                const withinTexture = colorKeyInside
                    ? "(" + colorKeyInside + ") && " : "";
                samples.push("    let d9_key_rgb" + stage.index +
                    " = vec3<u32>(round(clamp(tex" + stage.index +
                    ".rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0));\n" +
                    "    if (" + withinTexture + "all(d9_key_rgb" +
                    stage.index + " >= " + rgb(low) + ") && all(d9_key_rgb" +
                    stage.index + " <= " + rgb(high) + ")) { discard; }");
            } else if (stage.colorKey && stage.colorKey.indexed) {
                // The indexed companion view was resolved from the original
                // indices and writes alpha zero only for indices in the key
                // range. Comparing palette RGB here would be wrong when two
                // entries contain the same colour.
                samples.push("    if (tex" + stage.index +
                    ".a <= 0.0) { discard; }");
            }
            // D3DTOP_BUMPENVMAPLUMINANCE additionally modulates this stage's
            // colour by the bump texture's luminance channel, scaled and
            // biased by BUMPENVLSCALE/BUMPENVLOFFSET and clamped to [0,1].
            if (stage.bumpLuminanceFrom !== undefined) {
                const lum = "uniforms.stage_bump_lum" + stage.bumpLuminanceFrom;
                const source = "tex" + stage.bumpLuminanceFrom;
                samples.push("    let tex" + stage.index + "_lit = vec4<f32>(" +
                    "tex" + stage.index + ".rgb * clamp(" + lum + ".x * " +
                    source + ".b + " + lum + ".y, 0.0, 1.0), tex" +
                    stage.index + ".a);");
            }
        }

        const luminanceScaledStages = new Set(signature.stages
            .filter(stage => stage.bumpLuminanceFrom !== undefined)
            .map(stage => stage.index));

        // The argument pool. `current` and `temp` are the two mutable registers
        // the cascade threads through, so they are read from variables the
        // stage loop below reassigns.
        function argumentExpression(argument, stageIndex, channel) {
            const selector = argument & D3DTA_SELECTMASK;
            let value;
            switch (selector) {
            case D3DTA_DIFFUSE: value = diffuse; break;
            case D3DTA_CURRENT: value = "current"; break;
            case D3DTA_TEXTURE:
                // A stage sampled under BUMPENVMAPLUMINANCE reads the
                // luminance-modulated copy, which is what the luminance form
                // exists to produce.
                value = "tex" + stageIndex +
                    (luminanceScaledStages.has(stageIndex) ? "_lit" : "");
                break;
            case D3DTA_TFACTOR: value = "uniforms.texture_factor"; break;
            case D3DTA_SPECULAR: value = specular; break;
            case D3DTA_TEMP: value = "temp"; break;
            case D3DTA_CONSTANT: value = "uniforms.stage_constant" + stageIndex; break;
            default: value = diffuse; break;
            }
            // D3DTA_ALPHAREPLICATE broadcasts the argument's alpha over the
            // colour channels; D3DTA_COMPLEMENT inverts whatever came out.
            let expression;
            if (channel === "rgb")
                expression = (argument & D3DTA_ALPHAREPLICATE)
                    ? "vec3<f32>(" + value + ".a)" : value + ".rgb";
            else
                expression = value + ".a";
            if (argument & D3DTA_COMPLEMENT) {
                expression = channel === "rgb"
                    ? "(vec3<f32>(1.0) - " + expression + ")"
                    : "(1.0 - " + expression + ")";
            }
            return expression;
        }

        let cascadeBody = "    var current = " + diffuse + ";\n" +
            // D3D9 leaves the scratch register undefined until written; zero is
            // the one starting value that cannot make an unwritten read look
            // like meaningful data.
            "    var temp = vec4<f32>(0.0);\n";
        for (const stage of signature.stages) {
            const rgb = argument => argumentExpression(argument, stage.index, "rgb");
            const alpha = argument => argumentExpression(argument, stage.index, "a");
            const blendAlpha = {
                [D3DTOP_BLENDDIFFUSEALPHA]: diffuse + ".a",
                [D3DTOP_BLENDTEXTUREALPHA]: "tex" + stage.index + ".a",
                [D3DTOP_BLENDTEXTUREALPHAPM]: "tex" + stage.index + ".a",
                [D3DTOP_BLENDFACTORALPHA]: "uniforms.texture_factor.a",
                [D3DTOP_BLENDCURRENTALPHA]: "current.a",
            };
            const colorArgs = [rgb(stage.colorArg0), rgb(stage.colorArg1),
                rgb(stage.colorArg2)];
            colorArgs.rgb1 = rgb(stage.colorArg1);
            colorArgs.rgb2 = rgb(stage.colorArg2);
            // The MODULATE*_ADD* family reads arg1's alpha while computing the
            // colour channel, so it needs the alpha reduction of the *colour*
            // argument rather than of D3DTSS_ALPHAARG1.
            colorArgs.alpha1 = alpha(stage.colorArg1);
            const alphaArgs = [alpha(stage.alphaArg0), alpha(stage.alphaArg1),
                alpha(stage.alphaArg2)];
            alphaArgs.rgb1 = rgb(stage.colorArg1);
            alphaArgs.rgb2 = rgb(stage.colorArg2);
            alphaArgs.alpha1 = alpha(stage.colorArg1);
            const colorExpression = textureOpExpression(stage.colorOp,
                "vec3<f32>", colorArgs, blendAlpha[stage.colorOp] || "0.0");
            const alphaExpression = stage.alphaOp === D3DTOP_DISABLE ? null
                : textureOpExpression(stage.alphaOp, "f32", alphaArgs,
                    blendAlpha[stage.alphaOp] || "0.0");
            const destination = stage.resultArg === D3DTA_TEMP ? "temp" : "current";
            cascadeBody += "    {\n" +
                "        let stage_rgb = clamp(" +
                    (colorExpression || rgb(stage.colorArg1)) +
                    ", vec3<f32>(0.0), vec3<f32>(1.0));\n" +
                "        let stage_a = clamp(" +
                    (alphaExpression || destination + ".a") + ", 0.0, 1.0);\n" +
                "        " + destination + " = vec4<f32>(stage_rgb, stage_a);\n" +
                "    }\n";
        }

        let value = "current";
        if (debugMode === "solid") value = "vec4<f32>(0.0, 1.0, 0.0, 1.0)";
        else if (debugMode === "missing") value = "vec4<f32>(1.0, 0.0, 1.0, 1.0)";
        else if (debugMode === "orphan") value = "vec4<f32>(0.0, 1.0, 1.0, 1.0)";
        else if (debugMode === "color")
            value = "vec4<f32>(" + diffuse + ".rgb, 1.0)";
        else if (debugMode === "uv")
            value = signature.stages.length
                ? "vec4<f32>(stage_in.varying" +
                    (VARYING_TEXCOORD0 + signature.stages[0].coordVarying) +
                    ".xy, 0.0, 1.0)"
                : "vec4<f32>(0.0, 0.0, 1.0, 1.0)";
        else if (debugMode === "texture")
            value = signature.stages.some(stage => stage.samplesTexture)
                ? "vec4<f32>(tex" + signature.stages.find(
                    stage => stage.samplesTexture).index + ".rgb, 1.0)"
                : "vec4<f32>(1.0, 0.0, 0.0, 1.0)";

        // D3D9 adds the specular colour after the texture cascade, before fog.
        const specularBody = signature.specularEnable && !debugMode
            ? "    result = vec4<f32>(clamp(result.rgb + " + specular +
              ".rgb, vec3<f32>(0.0), vec3<f32>(1.0)), result.a);\n"
            : "";
        let fogBody = "";
        if (signature.fogMode) {
            // Table fog is pixel fog. The device advertises WFOG (and not
            // ZFOG), while fragment position.w is reciprocal clip-space W in
            // WGSL, so recover W here and evaluate the D3D fog equation per
            // fragment. Vertex fog alone consumes the interpolated oFog value.
            const tableFactor = fixedFogFactorExpression(signature.fogMode,
                "fog_distance");
            const factor = signature.tableFog && tableFactor
                ? tableFactor
                : "clamp(stage_in.varying" + shaderPipeline.VARYING_FOG +
                  ".x, 0.0, 1.0)";
            const tableDistance = signature.tableFog && tableFactor
                ? "    let fog_distance = 1.0 / " +
                  "max(abs(stage_in.position.w), 1e-6);\n"
                : "";
            fogBody = tableDistance +
                "    result = vec4<f32>(mix(uniforms.fog_color.rgb, result.rgb,\n" +
                "        " + factor + "), result.a);\n";
        }
        const varyings = [];
        for (let slot = 0; slot < VARYING_COUNT; ++slot)
            varyings.push(varyingDeclaration(slot, signature.flatShading));
        const clipVaryings = [];
        let clipDiscard = "";
        for (let group = 0; group < Math.ceil(
                (signature.clipPlaneCount || 0) / 4); ++group)
            clipVaryings.push("    @location(" + (VARYING_COUNT + group) +
                ") clip" + group + ": vec4<f32>,");
        for (let plane = 0; plane < (signature.clipPlaneCount || 0); ++plane)
            clipDiscard += "    if (stage_in.clip" +
                Math.floor(plane / 4) + "." + "xyzw"[plane & 3] +
                " < 0.0) { discard; }\n";

        return `${layout.entries.length
            ? uniformBlockStruct("D9FixedPixelUniforms", layout) +
              "\n@group(0) @binding(1) var<uniform> uniforms: D9FixedPixelUniforms;"
            : ""}
${declarations.join("\n")}

struct D9PixelInput {
    @builtin(position) position: vec4<f32>,
${varyings.join("\n")}
${clipVaryings.join("\n")}
};

@fragment
fn d9_ps_main(stage_in: D9PixelInput) -> @location(0) vec4<f32> {
${clipDiscard}
${samples.join("\n")}
${cascadeBody}    var result = ${value};
${specularBody}${alphaTestDiscard(signature.alphaTest, "result.a")}${fogBody}    return result;
}
`;
    }

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
            this.frame = null;             // { ops, transientBuffers, serial }
            this.frameSerial = 0;
            this.readyPromise = null;
            this.pendingReadbacks = new Set();
            this.work = Promise.resolve();
            this.failed = null;
            // Console-togglable diagnostics, e.g.
            //   v86gl.d3d9Executor.debug.forceClearColor = {r:1,g:0,b:1,a:1}
            // These exist to split "the canvas is not on screen" from "the
            // canvas is on screen but the drawn content is black", which the
            // stats alone cannot distinguish.
            this.debug = {
                forceClearColor: null,  // {r,g,b,a} overrides every Clear
                disableCull: false,     // force cullMode "none"
                disableDepthTest: false,// force depthCompare "always"
                shaderMode: null,       // "solid"|"color"|"texture"|"uv"
                // Replaces *both* fixed-function and translated pixel shaders
                // with an opaque green output. It also disables blend, alpha,
                // depth/stencil rejection and forces RGBA writes, leaving only
                // vertex fetch/transform, viewport and scissor able to hide a
                // draw. This is the definitive geometry-vs-shading probe.
                forceSolidAllDraws: false,
                // Clamps every sampler to the top mip level. If a texture
                // looks wrong because levels below 0 were never uploaded,
                // this makes it correct immediately -- which is the cheapest
                // way to confirm or rule out that cause.
                forceMipLevel0: false,
                // Suspicious-but-valid D3D9 state is counted in getStats()
                // unconditionally. Detailed per-state console warnings are
                // opt-in: real games deliberately reuse declarations and
                // fixed-function state in ways that trip these heuristics,
                // so they are debugging evidence rather than runtime errors.
                warnOnSuspiciousDraws: false,
                // Paints magenta over any fixed-function draw whose cascade
                // samples a stage with no live texture -- the draws that get
                // the 1x1 white fallback. A counter says how many there are;
                // this says *which*, which is the question a flat silhouette
                // actually poses: is the model I am looking at one of them?
                // Everything else keeps rendering normally, so the answer is
                // one screenshot rather than a bisection.
                highlightMissingTexture: false,
                // The same question for the other cause of a flat model:
                // paints cyan over any draw whose stage reads a coordinate
                // set its declaration does not carry. Magenta and cyan
                // together answer "which of the two is this model" in one
                // screenshot, which is the whole difficulty -- both render as
                // one flat colour and neither fails.
                highlightMissingCoordSet: false,
                // Drops every draw that has a translated shader bound on
                // either stage. shaderMode only rewrites the fixed-function
                // pixel cascade, so a model rendered through the programmable
                // path looks *identical* under every debug mode -- which reads
                // as "the debug mode did nothing" rather than as "you are
                // looking at the wrong pipeline". Making those draws vanish
                // answers which path a model is on in one screenshot.
                skipProgrammableDraws: false,
                // Routes fixed-function texture stage n to varying TEXCOORD n
                // (D3D9's rule when a vertex shader is bound) instead of to
                // the varying D3DTSS_TEXCOORDINDEX names. See coordStagePlan
                // for why the two disagree and which one D3D9 documents.
                texcoordFromStageIndex: true,
            };
            this.debug.dumpSmallTextures = o => this.dumpSmallTextures(o);
            this.debug.dumpShaders = o => this.dumpShaders(o);
            this.debug.clearShaderCache = () => this.clearShaderCache();
            this.debug.dumpPipelineStates = () => this.dumpPipelineStates();
            this.debug.blackScreenReport = () => this.blackScreenReport();
            this.lastDraws = { fixed: null, programmable: null };
            this.stats = {
                batches: 0, commands: 0, presents: 0, queueSubmits: 0,
                drawCalls: 0, indexedDrawCalls: 0, upDrawCalls: 0,
                pipelineCreations: 0, pipelineHits: 0,
                bindGroupCreations: 0, bindGroupHits: 0,
                bindGroupCacheEvictions: 0,
                uniformSlotReuses: 0, uniformRingOverflows: 0,
                uniformRingChunksAllocated: 0, uniformRingChunksUsed: 0,
                backBufferAllocations: 0, backBufferPresents: 0,
                redundantStateSkipped: 0, uniformStagingUploads: 0,
                readbackRequests: 0,
                frameFlushes: 0,
                unsupportedCommands: 0, malformedBatches: 0,
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
                // Dynamic buffers renamed because a draw already recorded in
                // the same frame reads their previous contents (see
                // applyBufferUpdate). Zero means the deferred-draw path never
                // had a write-after-record hazard to begin with.
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
                this.uniformRingChunks = [];
                this.uniformStaging = [];
                this.uniformRingIndex = 0;
                this.uniformRingCursor = 0;
                this.watchForDeviceLoss();
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
                    this.failed = error;
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
            for (const key of this.sessionStates.keys()) {
                this.switchSession(key);
                this.releaseActiveSession("state-restore");
            }
            this.sessionStates.clear();
            this.sessionKey = null;
            this.pipelineCache.clear();
            this.bindGroupCache.clear();
            this.moduleCache.clear();
            this.samplerCache.clear();
            this.failed = null;
        }

        // ---- batch decode ----

        async executeBatch(bytes, metadata) {
            const timing = this["performanceTiming"];
            let segmentStart = timing ? timing["now"]() : 0;
            try {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            if (bytes.byteLength < D9WG_BATCH_HEADER_BYTES) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG batch shorter than its header");
            }
            const magic = view.getUint32(0, true);
            const versionMajor = view.getUint16(4, true);
            const versionMinor = view.getUint16(6, true);
            const commandCount = view.getUint32(16, true);
            const commandBytes = view.getUint32(20, true);
            if (magic !== D9WG_MAGIC) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG batch has the wrong magic");
            }
            // Minor versions are accepted as a range, not an exact match. The
            // guest DLL and this file are deployed separately -- the proxy has
            // to be copied into the VM image, the page reloads on its own -- so
            // insisting they agree exactly turns any protocol addition into a
            // window where nothing renders at all and the only symptom is
            // "unsupported D9WG version".
            //
            // What makes the range safe is that every field added since
            // D9WG_VERSION_MIN_MINOR is length-gated at its decode site: an
            // older payload is short, the field reads as its default, and the
            // default is what that version meant. Adding a field that changes
            // the meaning of existing bytes would need the major version, which
            // is still an exact match.
            if (versionMajor !== D9WG_VERSION_MAJOR ||
                    versionMinor < D9WG_VERSION_MIN_MINOR ||
                    versionMinor > D9WG_VERSION_MINOR) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError(`unsupported D9WG version ${versionMajor}.${versionMinor}`);
            }
            if (commandBytes > bytes.byteLength - D9WG_BATCH_HEADER_BYTES) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError(
                    "D9WG batch command_bytes overruns the record");
            }
            const sessionLow = view.getUint32(24, true);
            const sessionHigh = view.getUint32(28, true);
            const sessionKey = sessionHigh.toString(16).padStart(8, "0") +
                sessionLow.toString(16).padStart(8, "0");
            this.switchSession(sessionKey);
            ++this.stats.batches;

            let offset = D9WG_BATCH_HEADER_BYTES;
            const end = D9WG_BATCH_HEADER_BYTES + commandBytes;
            let decoded = 0;
            while (offset + D9WG_COMMAND_HEADER_BYTES <= end) {
                const opcode = view.getUint16(offset, true);
                const size = view.getUint32(offset + 4, true);
                if (size < D9WG_COMMAND_HEADER_BYTES || offset + size > end) {
                    ++this.stats.malformedBatches;
                    throw new D9WGStreamError("D9WG command size is invalid");
                }
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
                    const pending = this.dispatchCommand(opcode, bytes, view,
                        payloadOffset, payloadBytes, metadata);
                    if (pending && typeof pending.then === "function") {
                        if (timing) timing["sync"](timing["now"]() - segmentStart);
                        try { await pending; }
                        finally { if (timing) segmentStart = timing["now"](); }
                    }
                } catch (error) {
                    if (error instanceof D9WGStreamError) throw error;
                    ++this.stats.commandsFailed;
                    this.warnOnce("command-failed-" + opcode,
                        "a command threw and was skipped; the rest of the " +
                        "batch still executes, so this draw or state change " +
                        "is lost but nothing behind it is", {
                            opcode, message: String(error && error.message
                                ? error.message : error) });
                }
                // Any command other than a draw may have moved something the
                // constant block is built from. Draws are excluded because they
                // are the thing being deduplicated; opcodes 0x300..0x303 are the
                // four draw entry points.
                if (opcode < OP_DRAW_PRIMITIVE ||
                        opcode > OP_DRAW_INDEXED_PRIMITIVE_UP)
                    ++this.commandSerial;
                offset += size;
                ++decoded;
                ++this.stats.commands;
                // Mid-batch, because one PCI batch can carry a whole 16 MiB
                // arena's worth of draws -- checking only at the batch boundary
                // would let ~80000 of them pile up first.
                if (this.frame && this.frame.ops.length >= this.flushThreshold)
                    this.finishFrame(false);
            }
            if (decoded !== commandCount) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG command_count does not match the decoded stream");
            }

            const present = (view.getUint32(12, true) & D9WG_BATCH_FLAG_PRESENT) !== 0;
            if (present) this.finishFrame(true);
            else if (this.flushRequested) this.finishFrame(false);
            this.flushRequested = false;
            this.beat(metadata);
            if (this.shaderCacheDirty) this.schedulePersistentShaderCacheSave();
            this.saveActiveSessionState();
            } finally {
                if (timing) timing["sync"](timing["now"]() - segmentStart);
            }
        }

        dispatchCommand(opcode, bytes, view, offset, length, metadata) {
            const handler = this.handlers[opcode];
            if (!handler) {
                // Per plan section 6.8: an unrecognized opcode is skipped by
                // its size (already advanced by the caller), never treated
                // as "executed" -- it simply never produces GPU state.
                ++this.stats.unsupportedCommands;
                return;
            }
            return handler.call(this, bytes, view, offset, length, metadata);
        }

        // ---- device/resource state ----

        deviceState(handle) {
            let state = this.devices.get(handle);
            if (!state) {
                state = this.createDeviceState(handle);
                this.devices.set(handle, state);
            }
            return state;
        }

        createDeviceState(handle) {
            return {
                handle,
                // Where the guest's window is on the guest desktop, resent on
                // every Present so the page can place the overlay canvas.
                // Deliberately NOT the back buffer's size: emit_present_and_flush
                // fills width/height from GetClientRect, and a windowed game's
                // client area is smaller than the back buffer it hosts.
                surface: { hwnd: 0, x: 0, y: 0, width: 0, height: 0,
                    visible: true, noSurface: false, sessionKey: null },
                // What the guest asked for at CreateDevice/Reset, and therefore
                // the real size of the swap-chain colour attachment and of the
                // auto depth target created beside it.
                backBufferWidth: 0,
                backBufferHeight: 0,
                multisampleType: D3DMULTISAMPLE_NONE,
                multisampleQuality: 0,
                sampleCount: 1,
                // WebGPU swap-chain textures are always single-sampled.  A
                // multisampled D3D back buffer therefore renders into this
                // private attachment and resolves into getCurrentTexture() at
                // the end of every render pass.
                backBufferMsaaTexture: null,
                backBufferMsaaView: null,
                backBufferMsaaSrgbView: null,
                viewport: { x: 0, y: 0, width: 1, height: 1,
                    minZ: 0, maxZ: 1 },
                transforms: new Map([
                    [D3DTS_VIEW, IDENTITY4x4], [D3DTS_PROJECTION, IDENTITY4x4],
                    [D3DTS_WORLD, IDENTITY4x4],
                ]),
                // Highest n the guest has ever passed as D3DTS_WORLDMATRIX(n).
                // Indexed vertex blending sizes its palette from this rather
                // than from the 256 D3D9 allows, so an app using eight bones
                // uploads eight matrices per draw and not 256.
                maxWorldMatrixIndex: 0,
                renderStates: new Map(),
                // Auto depth-stencil surface, created on CREATE_DEVICE/RESET
                // when the guest asked for one. hasDepth drives both the
                // render pass attachment and whether pipelines declare a
                // depthStencil block.
                hasDepth: false,
                depthTexture: null,
                // CreateAdditionalSwapChain results, keyed by chain handle.
                // The implicit chain is not in here: it is the canvas.
                swapChains: new Map(),
                depthView: null,
                samplerStates: new Map(), // sampler*64+state -> value, read by samplerFor()
                textureStageStates: new Map(),
                vertexShaderHandle: 0,
                pixelShaderHandle: 0,
                // The D3D9 constant register file. Device state, not shader
                // state: it survives SetVertexShader and Reset, so it lives
                // here and is packed into a uniform buffer per draw by
                // constantBufferFor(). Kept as flat typed arrays because the
                // packing step is a straight subarray copy.
                vsConstF: new Float32Array(MAX_VS_CONST_F * 4),
                vsConstI: new Int32Array(MAX_CONST_I * 4),
                vsConstB: new Uint32Array(MAX_CONST_B),
                psConstF: new Float32Array(MAX_PS_CONST_F * 4),
                psConstI: new Int32Array(MAX_CONST_I * 4),
                psConstB: new Uint32Array(MAX_CONST_B),
                material: null,          // set by SET_MATERIAL; not yet consumed (M2/M3 lighting)
                lights: new Map(),       // light index -> D3DLIGHT9-shaped object; not yet consumed
                lightEnabled: new Map(), // light index -> bool
                // frequency is the raw SetStreamSourceFreq value. D3D9 starts
                // every stream at 1; an absent entry is treated identically.
                streams: new Map(),      // stream -> { handle, stride, offset, frequency }
                indexBufferHandle: 0,
                vertexDeclarationHandle: 0, // also used for the SET_FVF synthesized layout
                fvfLayout: null,         // set by SET_FVF, cleared by SET_VERTEX_DECLARATION
                textures: new Map(),     // stage -> resource handle
                // Explicitly bound colour targets. A slot holding 0 (and slot 0
                // by default) means the swap chain's back buffer, which is the
                // only target whose view cannot be taken until Present.
                renderTargets: [0, 0, 0, 0],
                renderTargetLevels: [0, 0, 0, 0],
                // Which cube face each slot names; 0 for a 2D target.
                renderTargetFaces: [0, 0, 0, 0],
                // D3DFMT_P8/A8P8 sample through this palette; null until
                // SetCurrentTexturePalette names one.
                currentPalette: null,
                // 0 = the device's auto depth-stencil; depthUnbound is
                // SetDepthStencilSurface(NULL), which is not the same thing --
                // it turns depth testing off for the draws that follow.
                depthTargetHandle: 0,
                depthTargetLevel: 0,
                depthUnbound: false,
                scissorRect: null,
                clipPlanes: Array.from({ length: 6 }, () => [0, 0, 0, 1]),
                inScene: false,
            };
        }

        createSessionState(key) {
            return {
                key,
                devices: new Map(),
                resources: new Map(),
                frame: null,
                activeOcclusion: null,
                presentingDevice: null,
                lastSwapTexture: null,
                backBufferTexture: null,
                backBufferView: null,
                backBufferSrgbView: null,
                backBufferTextureWidth: 0,
                backBufferTextureHeight: 0,
                palettes: new Map(),
                ddPaletteBuffers: new Map(),
                ddPaletteSerials: new Map(),
                windowState: null,
                cursor: { texture: null, view: null, width: 0, height: 0,
                    hotspotX: 0, hotspotY: 0, x: 0, y: 0, visible: false,
                    pipeline: null, sampler: null, uniform: null },
                lastDraws: { fixed: null, programmable: null },
                featureBits: 0,
            };
        }

        saveActiveSessionState() {
            if (this.sessionKey === null) return;
            const state = this.sessionStates.get(this.sessionKey);
            if (!state) return;
            state.devices = this.devices;
            state.resources = this.resources;
            state.frame = this.frame;
            state.activeOcclusion = this.activeOcclusion || null;
            state.presentingDevice = this.presentingDevice || null;
            state.lastSwapTexture = this.lastSwapTexture || null;
            state.backBufferTexture = this.backBufferTexture || null;
            state.backBufferView = this.backBufferView || null;
            state.backBufferSrgbView = this.backBufferSrgbView || null;
            state.backBufferTextureWidth = this.backBufferTextureWidth || 0;
            state.backBufferTextureHeight = this.backBufferTextureHeight || 0;
            state.palettes = this.palettes;
            state.ddPaletteBuffers = this.ddPaletteBuffers;
            state.ddPaletteSerials = this.ddPaletteSerials;
            state.windowState = this.windowState || null;
            state.cursor = this.cursor;
            state.lastDraws = this.lastDraws;
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
            this.devices = state.devices;
            this.resources = state.resources;
            this.frame = state.frame;
            this.activeOcclusion = state.activeOcclusion;
            this.presentingDevice = state.presentingDevice;
            this.lastSwapTexture = state.lastSwapTexture;
            this.backBufferTexture = state.backBufferTexture;
            this.backBufferView = state.backBufferView;
            this.backBufferSrgbView = state.backBufferSrgbView;
            this.backBufferTextureWidth = state.backBufferTextureWidth;
            this.backBufferTextureHeight = state.backBufferTextureHeight;
            this.palettes = state.palettes;
            this.ddPaletteBuffers = state.ddPaletteBuffers;
            this.ddPaletteSerials = state.ddPaletteSerials;
            this.windowState = state.windowState;
            this.cursor = state.cursor;
            this.lastDraws = state.lastDraws;
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
                        !previous.ddPaletteBuffers.size)
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
                [OP_UPDATE_SURFACE]: this.onUpdateSurface,
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
            return this._handlers;
        }

        onHello(bytes, view, offset) {
            void view.getUint32(offset, true); // guest_pointer_bits
            const featureBits = view.getUint32(offset + 4, true);
            const sessionLow = view.getUint32(offset + 8, true);
            const sessionHigh = view.getUint32(offset + 12, true);
            // Keyed as a string, not `high * 2**32 + low`: a 64-bit id does not
            // survive a float64 above 2**53, and the low bits are exactly the
            // ones that distinguish two processes. The old arithmetic key made
            // the log self-contradictory (created "...576bff", replaced
            // "...576c00" -- the same session, printed exact then rounded) and
            // let two distinct sessions round together into one key, which
            // would keep a dead process's handles alive against a live one.
            const sessionKey = sessionHigh.toString(16).padStart(8, "0") +
                sessionLow.toString(16).padStart(8, "0");
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
            this.stats.guestFeatureBits = featureBits;
            // Record the active caps profile so diagnostics can distinguish a
            // fixed-function/SM2 run from a default SM3 run directly.
            this.stats.guestShaderModel2 =
                (featureBits & D9WG_FEATURE_SHADER_MODEL_2) !== 0;
            this.stats.guestShaderModel3 =
                (featureBits & D9WG_FEATURE_SHADER_MODEL_3) !== 0;
        }

        retireResourceState(resource) {
            if (!resource) return;
            this.retireGPUObject(resource.gpuBuffer);
            this.retireGPUObject(resource.gpuTexture);
            this.retireGPUObject(resource.msaaTexture);
            // Installed by ddraw_ops.js on palettised sample resources. A
            // SESSION_END bypasses per-resource opcodes, so its companion
            // textures have to participate in the process-wide teardown too.
            if (resource.ddSampleViews) {
                for (const entry of resource.ddSampleViews.values())
                    this.retireGPUObject(entry && entry.texture);
                resource.ddSampleViews.clear();
            }
            resource.destroyed = true;
        }

        retirePaletteCachesForDevice(handle) {
            const prefix = (handle >>> 0) + ":";
            for (const [key, entry] of this.ddPaletteBuffers) {
                if (!key.startsWith(prefix)) continue;
                this.retireGPUObject(entry && entry.buffer);
                this.ddPaletteBuffers.delete(key);
            }
            for (const key of this.ddPaletteSerials.keys())
                if (key.startsWith(prefix)) this.ddPaletteSerials.delete(key);
            for (const key of this.palettes.keys())
                if (key.startsWith(prefix)) this.palettes.delete(key);
        }

        retireDeviceState(state, reason) {
            if (!state) return;
            state.surface = { ...state.surface, visible: false };
            if (typeof this.options.onDestroy === "function")
                this.options.onDestroy(state.surface, reason || "device");
            if (state.swapChains) {
                for (const chain of state.swapChains.values()) {
                    if (chain.context &&
                            typeof chain.context.unconfigure === "function")
                        chain.context.unconfigure();
                    this.notifySwapChainSurface(
                        { ...chain.surface, visible: false }, "destroy");
                }
                state.swapChains.clear();
            }
            this.retireGPUObject(state.depthTexture);
            this.retireGPUObject(state.backBufferMsaaTexture);
            this.retireGPUObject(state.gammaRampTexture);
            this.retirePaletteCachesForDevice(state.handle);
        }

        retireActiveSessionBackBuffer() {
            this.retireGPUObject(this.backBufferTexture);
            this.backBufferTexture = null;
            this.backBufferView = null;
            this.backBufferSrgbView = null;
            this.backBufferTextureWidth = 0;
            this.backBufferTextureHeight = 0;
            this.lastSwapTexture = null;
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
            this.retireGPUObject(this.cursor && this.cursor.texture);
            this.retireGPUObject(this.cursor && this.cursor.uniform);
            this.cursor = { texture: null, view: null, width: 0, height: 0,
                hotspotX: 0, hotspotY: 0, x: 0, y: 0, visible: false,
                pipeline: null, sampler: null, uniform: null };
            this.activeOcclusion = null;
            this.presentingDevice = null;
            this.windowState = null;
            this.lastDraws = { fixed: null, programmable: null };
        }

        onSessionEnd(bytes, view, offset, length) {
            if (length < 8) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG SESSION_END payload is truncated");
            }
            const sessionLow = view.getUint32(offset, true);
            const sessionHigh = view.getUint32(offset + 4, true);
            const sessionKey = sessionHigh.toString(16).padStart(8, "0") +
                sessionLow.toString(16).padStart(8, "0");
            if (this.sessionKey !== sessionKey) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError(
                    "D9WG SESSION_END session does not match its batch");
            }
            const endedKey = this.sessionKey;
            this.releaseActiveSession("session-end");
            this.sessionStates.delete(endedKey);
            // SESSION_END is required to be the final command from a process.
            // Clearing the active key also makes a corrupt trailing command
            // unable to save freshly-created state back under the dead id.
            this.sessionKey = null;
            ++this.stats.sessionsEnded;
        }

        onCreateDevice(bytes, view, offset, length) {
            if (length < 52) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG CREATE_DEVICE payload is not protocol 1.3");
            }
            const handle = view.getUint32(offset, true);
            const hwnd = view.getUint32(offset + 4, true);
            const x = view.getInt32(offset + 8, true);
            const y = view.getInt32(offset + 12, true);
            const width = view.getUint32(offset + 16, true);
            const height = view.getUint32(offset + 20, true);
            const enableAutoDepth = view.getUint32(offset + 36, true);
            const multisampleType = view.getUint32(offset + 44, true);
            const multisampleQuality = view.getUint32(offset + 48, true);
            // A frame left un-presented by a previous device -- typically a
            // process that exited mid-frame -- must not bleed into this one.
            // Its recorded ops reference that device's depth target and
            // back-buffer size, which WebGPU rejects as soon as the sizes
            // differ ("depth stencil attachment size does not match ...").
            this.discardFrame();
            const state = this.deviceState(handle);
            state.viewport = { x: 0, y: 0, width, height, minZ: 0, maxZ: 1 };
            state.surface = { hwnd, x, y, width, height, visible: true,
                noSurface: false, sessionKey: this.sessionKey };
            state.backBufferWidth = width;
            state.backBufferHeight = height;
            this.configureBackBufferMSAA(state, width, height,
                multisampleType, multisampleQuality);
            this.ensureDepthTarget(state, width, height, enableAutoDepth !== 0);
            this.notifySurface(state, "create");
        }

        onReset(bytes, view, offset, length) {
            if (length < 56) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG RESET payload is not protocol 1.3");
            }
            const oldHandle = view.getUint32(offset, true);
            const newHandle = view.getUint32(offset + 4, true);
            const hwnd = view.getUint32(offset + 8, true);
            const x = view.getInt32(offset + 12, true);
            const y = view.getInt32(offset + 16, true);
            const width = view.getUint32(offset + 20, true);
            const height = view.getUint32(offset + 24, true);
            const enableAutoDepth = view.getUint32(offset + 40, true);
            const multisampleType = view.getUint32(offset + 48, true);
            const multisampleQuality = view.getUint32(offset + 52, true);
            const oldState = this.devices.get(oldHandle);
            if (oldState) {
                this.retireGPUObject(oldState.depthTexture);
                this.retireGPUObject(oldState.backBufferMsaaTexture);
            }
            // A D3D9 Reset leaves the back buffer's contents undefined, so the
            // owned texture is dropped rather than carried across; the next
            // frame recreates it, zero-filled, at whatever size Reset asked for.
            this.retireGPUObject(this.backBufferTexture);
            this.backBufferTexture = null;
            this.backBufferView = null;
            this.backBufferSrgbView = null;
            this.backBufferTextureWidth = 0;
            this.backBufferTextureHeight = 0;
            this.devices.delete(oldHandle);
            const state = this.deviceState(newHandle);
            state.viewport = { x: 0, y: 0, width, height, minZ: 0, maxZ: 1 };
            state.surface = { hwnd, x, y, width, height, visible: true,
                noSurface: false, sessionKey: this.sessionKey };
            state.backBufferWidth = width;
            state.backBufferHeight = height;
            this.configureBackBufferMSAA(state, width, height,
                multisampleType, multisampleQuality);
            this.ensureDepthTarget(state, width, height, enableAutoDepth !== 0);
            this.notifySurface(state, "reset");
        }

        resizeCanvasIfNeeded(width, height) {
            if (this.canvas.width !== width) this.canvas.width = width;
            if (this.canvas.height !== height) this.canvas.height = height;
        }

        // The swap-chain colour attachment is context.getCurrentTexture(). The
        // shared canvas is resized only at Present, after that process has won
        // ownership; CREATE/RESET from a helper session must not clear the
        // currently visible owner's canvas.
        // Reading state.surface here instead was a real defect: Present rewrites
        // state.surface with the window's client rect every frame, so a windowed
        // game reported a back buffer 13 rows shorter than the auto depth target
        // created with it (Kart Rider: 800x587 against 800x600). The pass then
        // looked mismatched and dropped depth, which turns off depth testing for
        // the entire game rather than for anything the app actually did.
        /*
         * D3D9 draws into a back buffer that survives Present; WebGPU hands out
         * a different canvas texture every frame, valid only for the task that
         * acquired it. Owning the back buffer resolves both at once.
         *
         * The lifetime is what matters most. A D3D9 frame does not arrive in
         * one task -- d3d9_proxy.c flushes a partial batch whenever the DMA
         * arena fills, and each PCI record is a separate macrotask -- so
         * acquiring the swap-chain texture early and holding it across the
         * frame is the pattern that goes stale ("Destroyed texture ... used in
         * a submit"). Recording into an owned texture instead means nothing
         * before Present touches the swap chain at all, which is what lets
         * finishFrame(false) submit a partial frame (see flushThreshold).
         *
         * It is also less work than the copy pair it replaces: the previous
         * shape copied the retained image *into* the canvas texture at the
         * start of every frame (so loadOp:"load" saw last frame's pixels) and
         * copied it back *out* before Present (so GetRenderTargetData had
         * something to read). Owning it makes the retained image and the render
         * target the same object, leaving one copy at Present.
         */
        ensureBackBufferTexture(width, height) {
            width = Math.max(1, width >>> 0);
            height = Math.max(1, height >>> 0);
            if (this.backBufferTexture &&
                    this.backBufferTextureWidth === width &&
                    this.backBufferTextureHeight === height)
                return this.backBufferTexture;
            // A resize discards the contents, which is what D3D9 does too: the
            // back buffer is undefined across a Reset that changes its size.
            this.retireGPUObject(this.backBufferTexture);
            this.backBufferTexture = this.device.createTexture({
                label: "D3D9 back buffer",
                size: { width, height, depthOrArrayLayers: 1 },
                format: this.format,
                ...(this.swapchainSrgbFormat
                    ? { viewFormats: [this.swapchainSrgbFormat] } : {}),
                mipLevelCount: 1,
                // RENDER_ATTACHMENT to draw into, COPY_SRC to reach the swap
                // chain and GetRenderTargetData, COPY_DST + TEXTURE_BINDING
                // because StretchRect uses the back buffer as both ends of a
                // full-screen post-processing round trip.
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC |
                    TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
            });
            this.backBufferView = this.backBufferTexture.createView();
            this.backBufferSrgbView = this.swapchainSrgbFormat
                ? this.backBufferTexture.createView(
                    { format: this.swapchainSrgbFormat })
                : this.backBufferView;
            this.backBufferTextureWidth = width;
            this.backBufferTextureHeight = height;
            ++this.stats.backBufferAllocations;
            return this.backBufferTexture;
        }

        backBufferWidthOf(state) {
            return state.backBufferWidth || this.canvas.width ||
                state.surface.width || 1;
        }

        backBufferHeightOf(state) {
            return state.backBufferHeight || this.canvas.height ||
                state.surface.height || 1;
        }

        configureBackBufferMSAA(state, width, height, type, quality) {
            this.retireGPUObject(state.backBufferMsaaTexture);
            state.backBufferMsaaTexture = null;
            state.backBufferMsaaView = null;
            state.backBufferMsaaSrgbView = null;
            const sampleCount = sampleCountForD3D(type, quality);
            if (!sampleCount) {
                this.warnOnce("invalid-backbuffer-msaa-" + type + "-" + quality,
                    "the guest requested an unsupported D3D9 multisample " +
                    "configuration; the host falls back to a single-sampled " +
                    "back buffer instead of creating an invalid WebGPU texture",
                    { type, quality });
            }
            state.multisampleType = sampleCount ? (type >>> 0)
                : D3DMULTISAMPLE_NONE;
            state.multisampleQuality = sampleCount ? (quality >>> 0) : 0;
            state.sampleCount = sampleCount || 1;
            if (state.sampleCount === 1 || !width || !height) return;
            const descriptor = {
                label: "D3D9 multisampled back buffer",
                size: { width, height, depthOrArrayLayers: 1 },
                format: this.format,
                ...(this.swapchainSrgbFormat
                    ? { viewFormats: [this.swapchainSrgbFormat] } : {}),
                mipLevelCount: 1,
                sampleCount: state.sampleCount,
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT,
            };
            state.backBufferMsaaTexture = this.device.createTexture(descriptor);
            state.backBufferMsaaView = state.backBufferMsaaTexture.createView();
            state.backBufferMsaaSrgbView = this.swapchainSrgbFormat
                ? state.backBufferMsaaTexture.createView(
                    { format: this.swapchainSrgbFormat })
                : state.backBufferMsaaView;
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
            // Everything below was created by the lost device and cannot be
            // destroyed or reused; dropping the references is all that is
            // possible and all that is needed.
            this.discardFrame();
            this.sessionStates.clear();
            this.devices = new Map();
            this.resources = new Map();
            this.palettes = new Map();
            this.ddPaletteBuffers = new Map();
            this.ddPaletteSerials = new Map();
            this.pipelineCache.clear();
            this.bindGroupCache.clear();
            this.moduleCache.clear();
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
            this.uniformRingChunks = [];
            this.uniformStaging = [];
            this.uniformRingIndex = 0;
            this.uniformRingCursor = 0;
            this.objectIds = new WeakMap();
            this.nextObjectId = 1;
            this.device = null;
            this.context = null;
            this.readyPromise = null;
            this.failed = null;
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

        notifySurface(state, reason) {
            if (typeof this.options.onSurface === "function")
                this.options.onSurface(state.surface, reason);
        }

        onPresent(bytes, view, offset) {
            // The actual GPU submit happens in finishFrame(), called once
            // per executeBatch() when the outer D9WGBatchHeader carries
            // D9WG_BATCH_FLAG_PRESENT -- see the end of executeBatch(). The
            // guest recomputes the window's current screen position on
            // every Present (d3d9_proxy.c has no window-move subclassing in
            // M1), so this is the live source of truth for canvas placement
            // rather than a separate UPDATE_SURFACE event.
            const handle = view.getUint32(offset, true);
            const state = this.deviceState(handle);
            const hwnd = view.getUint32(offset + 4, true);
            const x = view.getInt32(offset + 8, true);
            const y = view.getInt32(offset + 12, true);
            let width = view.getUint32(offset + 16, true);
            let height = view.getUint32(offset + 20, true);
            // The guest recomputes the client rect on every Present, and
            // GetClientRect is known to return an empty rect in fullscreen
            // (recorded as an open issue at M1). Letting a 0x0 report through
            // makes the host repeatedly resize/reposition the overlay canvas
            // between the real size and nothing, which reads on screen as
            // flicker. The last non-empty size is the better answer: a window
            // that genuinely has no client area has nothing to show anyway.
            if (!width || !height) {
                ++this.stats.emptySurfaceReports;
                width = state.surface.width || width;
                height = state.surface.height || height;
            }
            const changed = state.surface.hwnd !== hwnd || state.surface.x !== x ||
                state.surface.y !== y || state.surface.width !== width ||
                state.surface.height !== height;
            state.surface = { ...state.surface, hwnd, x, y, width, height,
                visible: true, noSurface: false };
            if (changed) {
                ++this.stats.surfaceChanges;
                this.notifySurface(state, "present");
            }
            this.presentingDevice = state;
        }

        onBeginScene(bytes, view, offset) {
            const handle = view.getUint32(offset, true);
            this.deviceState(handle).inScene = true;
        }

        onEndScene(bytes, view, offset) {
            const handle = view.getUint32(offset, true);
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
            if (length < 16) return;
            const handle = view.getUint32(offset + 4, true);
            const type = view.getUint32(offset + 8, true);
            const responseOffset = view.getUint32(offset + 12, true);
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
            if (length < 16) return;
            const query = this.resources.get(view.getUint32(offset + 4, true));
            if (!query || query.kind !== RESOURCE_QUERY) return;
            const responseOffset = view.getUint32(offset + 8, true);
            const requestId = view.getUint32(offset + 12, true);
            if (responseOffset !== query.responseOffset) return;
            query.active = true;
            query.requestId = requestId;
            query.metadata = metadata || {};
            const frame = this.ensureFrame();
            frame.ops.push({ kind: "query-begin", query, requestId,
                metadata: query.metadata });
            ++this.stats.queryBegins;
        }

        onEndQuery(bytes, view, offset, length, metadata) {
            if (length < 16) return;
            const query = this.resources.get(view.getUint32(offset + 4, true));
            if (!query || query.kind !== RESOURCE_QUERY) return;
            const responseOffset = view.getUint32(offset + 8, true);
            const requestId = view.getUint32(offset + 12, true);
            if (responseOffset !== query.responseOffset) return;
            query.requestId = requestId;
            const resultMetadata = metadata || query.metadata || {};
            const frame = this.ensureFrame();
            frame.ops.push({ kind: "query-end", query, requestId,
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
        beat(metadata) {
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
            if (length < 48) {
                // Same reasoning as above: the guest blocks on the answer, so
                // a malformed request has to be answered, not dropped.
                ++this.stats.renderTargetReadbackFailures;
                this.warnOnce("readback-short-payload",
                    "a readback command was too short to decode; the guest is " +
                    "told it failed rather than left waiting", { length });
                try {
                    this.writeReadbackResponse(
                        view.getUint32(offset + 40, true),
                        view.getUint32(offset + 44, true), null,
                        D9WG_RESPONSE_FAILED, metadata);
                } catch (_) { ++this.stats.responseWriteFailures; }
                return;
            }
            const deviceHandle = view.getUint32(offset, true);
            const textureHandle = view.getUint32(offset + 4, true);
            const level = view.getUint32(offset + 8, true);
            const format = view.getUint32(offset + 12, true);
            const width = view.getUint32(offset + 16, true);
            const height = view.getUint32(offset + 20, true);
            const firstRow = view.getUint32(offset + 24, true);
            const rowCount = view.getUint32(offset + 28, true);
            const destinationPitch = view.getUint32(offset + 32, true);
            const destinationBytes = view.getUint32(offset + 36, true);
            const responseOffset = view.getUint32(offset + 40, true);
            const requestId = view.getUint32(offset + 44, true);
            const face = length >= 52 ? view.getUint32(offset + 48, true) : 0;
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
                    sourceTexture = this.backBufferTexture ||
                        this.lastSwapTexture || this.context.getCurrentTexture();
                const gpuFormat = resource ? resource.gpuFormat : this.format;
                if (!sourceTexture || !gpuFormat)
                    throw new Error("readback source is unavailable");
                const sourceWidth = resource
                    ? Math.max(1, resource.width >> level) : width;
                const sourceHeight = resource
                    ? Math.max(1, resource.height >> level) : height;
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

        // A "frame" here is pure JS bookkeeping -- a list of pending clear/
        // draw operations -- with no WebGPU objects created yet. This is
        // deliberate: a canvas's context.getCurrentTexture() is only valid
        // for the task that acquired it; once control returns to the
        // browser's event loop, that texture is liable to be presented and
        // invalidated out from under you ("Destroyed texture ... used in a
        // submit"). A single D3D9 frame's Clear/Draw/Present calls do not
        // reliably arrive in one task: d3d9_proxy.c flushes a partial batch
        // over PCI whenever the DMA ring fills up (reserve_command_locked's
        // intermediate submit_batch_locked(FALSE)), and each such PCI record
        // is delivered to this executor as a separate worker postMessage --
        // a separate macrotask. Acquiring the swapchain texture eagerly on
        // the first Clear of a frame and holding it until a much-later
        // Present-carrying submit is exactly the pattern that goes stale.
        // Recording lightweight ops now and only turning them into real
        // WebGPU calls inside finishFrame() -- acquired, recorded, and
        // submitted in one synchronous stretch -- avoids that regardless of
        // how many separate PCI submits contributed to the frame.
        ensureFrame() {
            if (this.frame) return this.frame;
            // `serial` identifies this frame for the write-after-record check in
            // applyBufferUpdate(); it must be unique per frame, never reused.
            // Chunks are retained, only the write position rewinds: WebGPU
            // orders queue.writeBuffer against already-submitted work, so
            // rewinding after the previous frame's Present cannot overwrite
            // bytes a queued draw still has to read.
            this.uniformRingIndex = 0;
            this.uniformRingCursor = 0;
            this.frame = { ops: [], transientBuffers: [],
                serial: ++this.frameSerial,
                statStart: {
                    pipelineCreations: this.stats.pipelineCreations,
                    bindGroupCreations: this.stats.bindGroupCreations,
                    queueSubmits: this.stats.queueSubmits,
                    renderPasses: this.stats.renderPasses,
                } };
            return this.frame;
        }

        // If a command throws partway through a batch (see submit()'s catch
        // handler), this.frame may be left holding recorded-but-unreplayed
        // ops. Since no WebGPU render pass/encoder exists yet at this point
        // (those are only created in finishFrame(), at Present time), there
        // is nothing to end -- just drop the ops and free any transient
        // buffers already created for them so the next frame starts clean.
        discardFrame() {
            const frame = this.frame;
            // A discarded/reset device cannot legally carry an open query
            // into the replacement command stream.
            this.activeOcclusion = null;
            if (!frame) return;
            this.frame = null;
            if (frame.transientBuffers && frame.transientBuffers.length) {
                for (const buffer of frame.transientBuffers) buffer.destroy();
            }
        }

        onClear(bytes, view, offset, length) {
            const deviceHandle = view.getUint32(offset, true);
            const flags = view.getUint32(offset + 4, true);
            const color = view.getUint32(offset + 8, true);
            const depth = view.getFloat32(offset + 12, true);
            const stencil = view.getUint32(offset + 16, true);
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
            const rectCount = view.getUint32(offset + 20, true);
            if (rectCount) {
                if (24 + rectCount * 16 > length) {
                    ++this.stats.malformedBatches;
                    throw new D9WGStreamError("D9WG Clear rectangles overrun the command");
                }
                const rects = [];
                for (let index = 0; index < rectCount; ++index) {
                    const base = offset + 24 + index * 16;
                    const left = Math.max(0, Math.min(targets.width,
                        view.getInt32(base, true)));
                    const top = Math.max(0, Math.min(targets.height,
                        view.getInt32(base + 4, true)));
                    const right = Math.max(left, Math.min(targets.width,
                        view.getInt32(base + 8, true)));
                    const bottom = Math.max(top, Math.min(targets.height,
                        view.getInt32(base + 12, true)));
                    if (right > left && bottom > top)
                        rects.push({ left, top, right, bottom });
                }
                if (rects.length) {
                    frame.ops.push({ kind: "rect-clear", targets, clearsColor,
                        clearsDepth, clearsStencil, color: { r, g, b, a },
                        depth, stencil, rects });
                    ++this.stats.partialClears;
                }
                return;
            }
            frame.ops.push({
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
        finishFrame(present = true) {
            /*
             * A Present with no frame at all still has work to do. An earlier
             * flush can consume every recorded op, and onPresent() records
             * nothing itself, so `this.frame` is legitimately null here -- but
             * the canvas hands out a fresh, undefined texture each frame, so
             * without the copy below everything already submitted would stay in
             * the owned back buffer and the screen would hold whatever the
             * uninitialised canvas texture contains.
             */
            const frame = this.frame || (present ? this.ensureFrame() : null);
            if (!frame) return;
            this.frame = null;
            // Counted only for a real Present: a partial flush is a fragment
            // of a frame, and "this frame never cleared" is a statement about
            // whole frames.
            if (present) {
                if (!frame.ops.length) ++this.stats.framesWithNoOps;
                else if (!frame.ops.some(op =>
                        op.kind === "clear" && op.clearsColor))
                    ++this.stats.framesWithoutColorClear;
            } else if (frame.ops.length) {
                ++this.stats.frameFlushes;
            }
            /*
             * `|| present` matters once a frame can be flushed early: the last
             * flush may consume every remaining op, leaving a Present with
             * nothing to replay -- and the canvas texture is a *new*, undefined
             * texture each frame, so skipping the work would leave everything
             * already submitted stuck in the owned back buffer, never reaching
             * the screen. A Present always copies, even with no ops of its own.
             */
            if (frame.ops.length || present) {
                const encoder = this.device.createCommandEncoder();
                const carriedOcclusion = this.activeOcclusion || null;
                this.activeOcclusion = null;
                const hasOcclusion = !!carriedOcclusion || frame.ops.some(op =>
                    op.kind === "query-begin" && op.query.type ===
                        D3DQUERYTYPE_OCCLUSION);
                /* Any op can force a render-pass boundary through a target
                 * switch. One slot per recorded op is therefore a safe upper
                 * bound on the number of query segments. */
                const occlusionBudget = hasOcclusion
                    ? Math.min(8192, Math.max(1, frame.ops.length)) : 0;
                const timestampBudget = this.deviceFeatures.timestampQuery
                    ? frame.ops.filter(op => op.kind === "query-end" &&
                        op.query.type === D3DQUERYTYPE_TIMESTAMP).length : 0;
                const occlusionQuerySet = occlusionBudget &&
                        typeof this.device.createQuerySet === "function"
                    ? this.device.createQuerySet({ type: "occlusion",
                        count: Math.max(1, occlusionBudget) }) : null;
                const timestampQuerySet = timestampBudget &&
                        typeof this.device.createQuerySet === "function"
                    ? this.device.createQuerySet({ type: "timestamp",
                        count: Math.max(1, timestampBudget) }) : null;
                let occlusionSlot = 0;
                let timestampSlot = 0;
                let activeOcclusion = carriedOcclusion;
                let activeOcclusionSlots = [];
                let activeOcclusionSlot = -1;
                const occlusionCompletions = [];
                const timestampCompletions = [];
                const fenceCompletions = [];
                // Ops recorded against the implicit back buffer land in the
                // owned texture, so this whole replay is independent of the
                // swap chain; getCurrentTexture() is acquired further down and
                // only when this finish actually presents.
                const backState = this.presentingDevice ||
                    this.devices.values().next().value || null;
                const backWidth = backState
                    ? this.backBufferWidthOf(backState)
                    : (this.backBufferTextureWidth || this.canvas.width || 1);
                const backHeight = backState
                    ? this.backBufferHeightOf(backState)
                    : (this.backBufferTextureHeight || this.canvas.height || 1);
                const backTexture = this.ensureBackBufferTexture(
                    backWidth, backHeight);
                const swapView = this.backBufferView;
                const swapSrgbView = this.backBufferSrgbView;
                // GetRenderTargetData on the implicit back buffer reads the
                // owned texture, which -- unlike a canvas texture -- is still
                // valid in whatever later task the request arrives in.
                this.lastSwapTexture = backTexture;
                // No restore copy: a D3D9 back buffer is routinely reused by
                // applications that redraw only the changing rectangles between
                // Presents (3DMark06's loading renderer does exactly that on
                // 3342 of its first 3343 frames), and the owned texture simply
                // still holds last frame's pixels, so loadOp:"load" is honest.
                // Every op carries the target set it was recorded against (see
                // renderTargetsFor). A pass covers the longest run of ops that
                // share a target set; a Clear always starts a new one, because
                // WebGPU expresses a clear only as a pass's loadOp.
                let pass = null;
                let openKey = null;
                /*
                 * Everything below is *pass* state in WebGPU: a setX persists
                 * until it is changed or the pass ends, so re-issuing an
                 * identical value is a no-op that still costs a full JS->Dawn
                 * crossing. Nine of them were issued per draw regardless of
                 * whether anything moved, which is invisible at the few hundred
                 * draws a scene makes and dominant at the hundred thousand
                 * 3DMark06's batch-size test makes -- there, consecutive draws
                 * differ only in their index range, so eight of the nine calls
                 * are pure overhead.
                 *
                 * `bound` shadows what this pass has actually been told. It is
                 * reset in beginPass() and nowhere else, because beginning a
                 * pass is exactly when WebGPU forgets all of it.
                 */
                let bound = null;
                const resetBoundState = () => {
                    bound = {
                        pipeline: null, bindGroup: null, dynamicOffsets: null,
                        blendR: NaN, blendG: NaN, blendB: NaN, blendA: NaN,
                        stencilReference: -1,
                        vpX: NaN, vpY: NaN, vpW: NaN, vpH: NaN,
                        vpMinZ: NaN, vpMaxZ: NaN,
                        scX: NaN, scY: NaN, scW: NaN, scH: NaN,
                        clipScissor: undefined, clip: null,
                        vertexBuffers: [],
                        indexBuffer: null, indexFormat: null, indexOffset: -1,
                    };
                };
                const sameOffsets = (a, b) => {
                    if (a === b) return true;
                    if (!a || !b || a.length !== b.length) return false;
                    for (let i = 0; i < a.length; ++i)
                        if (a[i] !== b[i]) return false;
                    return true;
                };
                const endOcclusionSegment = () => {
                    if (!pass || activeOcclusionSlot < 0) return;
                    pass.endOcclusionQuery();
                    activeOcclusionSlots.push(activeOcclusionSlot);
                    activeOcclusionSlot = -1;
                };
                const closePass = () => {
                    if (!pass) return;
                    endOcclusionSegment();
                    pass.end();
                    pass = null;
                    openKey = null;
                };
                const beginPass = (targets, clearColor, clearDepthStencil) => {
                    const descriptor = {
                        colorAttachments: targets.colors.map(color => ({
                            view: color.swapchain
                                ? (color.format === this.swapchainSrgbFormat
                                    ? swapSrgbView : swapView)
                                : color.view,
                            loadOp: clearColor ? "clear" : "load",
                            storeOp: "store",
                            ...(clearColor ? { clearValue: clearColor } : {}),
                        })),
                    };
                    if (occlusionQuerySet)
                        descriptor.occlusionQuerySet = occlusionQuerySet;
                    if (targets.depthView) {
                        const clearsDepth = clearDepthStencil &&
                            clearDepthStencil.depth !== undefined;
                        const clearsStencil = clearDepthStencil &&
                            clearDepthStencil.stencil !== undefined;
                        descriptor.depthStencilAttachment = {
                            view: targets.depthView,
                            depthLoadOp: clearsDepth ? "clear" : "load",
                            depthStoreOp: "store",
                            stencilLoadOp: clearsStencil ? "clear" : "load",
                            stencilStoreOp: "store",
                            ...(clearsDepth ? {
                                depthClearValue: clearDepthStencil.depth } : {}),
                            ...(clearsStencil ? {
                                stencilClearValue: clearDepthStencil.stencil } : {}),
                        };
                    }
                    ++this.stats.renderPasses;
                    const created = encoder.beginRenderPass(descriptor);
                    resetBoundState();
                    if (activeOcclusion && occlusionQuerySet &&
                            occlusionSlot < occlusionBudget) {
                        activeOcclusionSlot = occlusionSlot++;
                        created.beginOcclusionQuery(activeOcclusionSlot);
                    }
                    return created;
                };
                // The back buffer and the auto depth-stencil must agree on size
                // or WebGPU rejects the whole command buffer -- and with it
                // every later frame, not just this one.
                // A blit op carries its own attachment views rather than a
                // target set, so it is not part of this check.
                const backBufferOps = frame.ops.filter(op => op.targets &&
                    op.targets.colors.some(color => color.swapchain));
                const mismatched = backBufferOps.find(op => op.targets.depthView &&
                    (op.targets.width !== backWidth ||
                     op.targets.height !== backHeight));
                if (mismatched) {
                    this.warnOnce("depth-size-mismatch",
                        "dropping a frame whose depth target " +
                        mismatched.targets.width + "x" + mismatched.targets.height +
                        " does not match the back buffer " +
                        backWidth + "x" + backHeight);
                    frame.ops.length = 0;
                }
                for (const op of frame.ops) {
                    if (op.kind === "query-begin") {
                        if (op.query.type === D3DQUERYTYPE_OCCLUSION) {
                            closePass();
                            activeOcclusion = { query: op.query,
                                requestId: op.requestId,
                                metadata: op.metadata, value: 0n,
                                failed: false, pending: Promise.resolve() };
                            activeOcclusionSlots = [];
                        }
                        continue;
                    }
                    if (op.kind === "query-end") {
                        if (op.query.type === D3DQUERYTYPE_OCCLUSION) {
                            endOcclusionSegment();
                            const record = activeOcclusion || {
                                query: op.query, requestId: op.requestId,
                                metadata: op.metadata, value: 0n,
                                failed: false, pending: Promise.resolve() };
                            record.requestId = op.requestId;
                            record.metadata = op.metadata;
                            occlusionCompletions.push({ record,
                                query: record.query,
                                requestId: op.requestId,
                                metadata: op.metadata,
                                slots: activeOcclusionSlots.slice(),
                                final: true });
                            activeOcclusion = null;
                            activeOcclusionSlots = [];
                        } else if (op.query.type === D3DQUERYTYPE_TIMESTAMP &&
                                timestampQuerySet &&
                                typeof encoder.writeTimestamp === "function") {
                            closePass();
                            const slot = timestampSlot++;
                            encoder.writeTimestamp(timestampQuerySet, slot);
                            timestampCompletions.push({ ...op, slot });
                        } else {
                            fenceCompletions.push(op);
                        }
                        continue;
                    }
                    if (op.kind === "copy") {
                        closePass();
                        encoder.copyTextureToTexture(op.source, op.destination,
                            op.size);
                        continue;
                    }
                    if (op.kind === "blit") {
                        // A blit is its own pass against its own attachment.
                        closePass();
                        const transient = this.replayBlit(encoder, op, swapView);
                        if (transient) frame.transientBuffers.push(transient);
                        continue;
                    }
                    if (op.kind === "ddblit") {
                        // The DirectDraw blit: the same shape, plus colour
                        // keying, mirroring and index/palette storage, so it is
                        // replayed by ddraw_ops.js.
                        closePass();
                        const transient = this.replayDDBlit(encoder, op,
                            swapView, backTexture);
                        if (transient) frame.transientBuffers.push(transient);
                        continue;
                    }
                    if (op.kind === "present-swap-chain") {
                        // An additional chain's canvas is acquired here, in
                        // the same synchronous stretch as the submit that
                        // consumes it -- the rule getCurrentTexture() imposes
                        // applies per canvas, not just to the implicit one.
                        closePass();
                        let target = null;
                        try {
                            target = op.chain.context.getCurrentTexture();
                        } catch (error) {
                            ++this.stats.swapChainPresentsDropped;
                            this.warnOnce("swap-chain-acquire",
                                "an additional swap chain's canvas could not " +
                                "be acquired; its frame is dropped",
                                { message: String(error) });
                        }
                        if (target) {
                            const width = Math.min(target.width, op.width);
                            const height = Math.min(target.height, op.height);
                            // A blit rather than copyTextureToTexture: the
                            // chain's back buffer is an ordinary D3D texture,
                            // so its format is whatever the guest asked for,
                            // while the canvas is the preferred canvas format.
                            // A copy requires those to be identical and they
                            // routinely are not.
                            if (width && height) {
                                const transient = this.replayBlit(encoder, {
                                    sourceView: op.sourceView,
                                    destinationView: null,
                                    destinationFormat: this.format,
                                    sourceFormat: op.sourceFormat,
                                    sourceRect: [0, 0, 1, 1],
                                    viewport: [0, 0, width, height],
                                    filterPoint: false,
                                }, target.createView());
                                if (transient)
                                    frame.transientBuffers.push(transient);
                            }
                        }
                        continue;
                    }
                    if (op.kind === "generate-mips") {
                        closePass();
                        for (const transient of
                                this.replayGenerateMips(encoder, op))
                            frame.transientBuffers.push(transient);
                        continue;
                    }
                    if (op.kind === "rect-clear") {
                        closePass();
                        const transient = this.replayRectClear(encoder, op,
                            swapView, swapSrgbView);
                        if (transient) frame.transientBuffers.push(transient);
                        continue;
                    }
                    if (op.kind === "color-fill") {
                        closePass();
                        const transient = this.replayColorFill(encoder, op);
                        if (transient) frame.transientBuffers.push(transient);
                        continue;
                    }
                    if (op.kind === "clear") {
                        closePass();
                        // A Clear that only touches depth still has to keep the
                        // colour already drawn this frame, and vice versa --
                        // hence the two independent load ops.
                        pass = beginPass(op.targets,
                            op.clearsColor ? op.color : null,
                            (op.clearsDepth || op.clearsStencil) ? {
                                ...(op.clearsDepth ? { depth: op.depth } : {}),
                                ...(op.clearsStencil ? { stencil: op.stencil } : {}),
                            } : null);
                        openKey = op.targets.key;
                        continue;
                    }
                    if (!pass || openKey !== op.targets.key) {
                        closePass();
                        pass = beginPass(op.targets, null, null);
                        openKey = op.targets.key;
                    }
                    if (bound.pipeline !== op.pipeline) {
                        pass.setPipeline(op.pipeline);
                        bound.pipeline = op.pipeline;
                    } else ++this.stats.redundantStateSkipped;
                    const offsets = op.dynamicOffsets || EMPTY_OFFSETS;
                    if (bound.bindGroup !== op.bindGroup ||
                            !sameOffsets(bound.dynamicOffsets, offsets)) {
                        pass.setBindGroup(0, op.bindGroup, offsets);
                        bound.bindGroup = op.bindGroup;
                        bound.dynamicOffsets = offsets;
                    } else ++this.stats.redundantStateSkipped;
                    const blend = op.blendConstant;
                    if (bound.blendR !== blend.r || bound.blendG !== blend.g ||
                            bound.blendB !== blend.b || bound.blendA !== blend.a) {
                        pass.setBlendConstant(blend);
                        bound.blendR = blend.r; bound.blendG = blend.g;
                        bound.blendB = blend.b; bound.blendA = blend.a;
                    } else ++this.stats.redundantStateSkipped;
                    if (bound.stencilReference !== op.stencilReference) {
                        pass.setStencilReference(op.stencilReference);
                        bound.stencilReference = op.stencilReference;
                    } else ++this.stats.redundantStateSkipped;
                    const vp = op.viewport;
                    const viewportMoved = bound.vpX !== vp.x ||
                        bound.vpY !== vp.y || bound.vpW !== vp.width ||
                        bound.vpH !== vp.height || bound.vpMinZ !== vp.minZ ||
                        bound.vpMaxZ !== vp.maxZ;
                    if (viewportMoved) {
                        pass.setViewport(vp.x, vp.y, vp.width, vp.height,
                                vp.minZ, vp.maxZ);
                        bound.vpX = vp.x; bound.vpY = vp.y;
                        bound.vpW = vp.width; bound.vpH = vp.height;
                        bound.vpMinZ = vp.minZ; bound.vpMaxZ = vp.maxZ;
                    } else ++this.stats.redundantStateSkipped;
                    // A D3D9 viewport clips; a WebGPU one only maps NDC to
                    // pixels. Without a matching scissor, geometry an app
                    // expected the viewport to cut off is drawn across the whole
                    // target instead -- which is why the clip rect is the
                    // viewport intersected with D3DRS_SCISSORTESTENABLE's rect
                    // (D3D9 applies both), not just the latter.
                    //
                    // The intersection is memoised as well as skipped, because
                    // recomputing it allocates a rect per draw. Keyed on the
                    // viewport having *moved* rather than on op.viewport's
                    // identity: every op carries its own copy of the viewport,
                    // so an identity check would miss on every single draw. The
                    // scissor is compared by identity because it is null --
                    // literally the same null -- whenever D3DRS_SCISSORTESTENABLE
                    // is off, which is the case this is here to make fast.
                    let clip = bound.clip;
                    if (!clip || viewportMoved || bound.clipScissor !== op.scissor) {
                        clip = intersectRects(vp, op.scissor,
                                op.targets.width, op.targets.height);
                        bound.clip = clip;
                        bound.clipScissor = op.scissor;
                    }
                    if (bound.scX !== clip.x || bound.scY !== clip.y ||
                            bound.scW !== clip.width || bound.scH !== clip.height) {
                        pass.setScissorRect(clip.x, clip.y, clip.width, clip.height);
                        bound.scX = clip.x; bound.scY = clip.y;
                        bound.scW = clip.width; bound.scH = clip.height;
                    } else ++this.stats.redundantStateSkipped;
                    for (let slot = 0; slot < op.vertexBuffers.length; ++slot) {
                        const binding = op.vertexBuffers[slot];
                        const previous = bound.vertexBuffers[slot];
                        if (previous && previous.buffer === binding.buffer &&
                                previous.offset === binding.offset) {
                            ++this.stats.redundantStateSkipped;
                            continue;
                        }
                        pass.setVertexBuffer(slot, binding.buffer, binding.offset);
                        bound.vertexBuffers[slot] = binding;
                    }
                    if (op.indexInfo) {
                        if (bound.indexBuffer !== op.indexInfo.buffer ||
                                bound.indexFormat !== op.indexInfo.format ||
                                bound.indexOffset !== op.indexInfo.offset) {
                            pass.setIndexBuffer(op.indexInfo.buffer,
                                    op.indexInfo.format, op.indexInfo.offset);
                            bound.indexBuffer = op.indexInfo.buffer;
                            bound.indexFormat = op.indexInfo.format;
                            bound.indexOffset = op.indexInfo.offset;
                        } else ++this.stats.redundantStateSkipped;
                        pass.drawIndexed(op.indexInfo.count, op.instanceCount || 1,
                                op.indexInfo.firstIndex, op.indexInfo.baseVertex);
                    } else {
                        // StartVertex is already folded into each stream's
                        // setVertexBuffer offset (see boundStreams), so
                        // firstVertex stays 0 here.
                        if ((op.instanceCount || 1) === 1)
                            pass.draw(op.vertexCount || 0);
                        else
                            pass.draw(op.vertexCount || 0, op.instanceCount);
                    }
                }
                closePass();
                // D3D9 permits an occlusion query to cross Present. Resolve
                // this frame's segments now, retain the accumulator, and open
                // a fresh WebGPU segment when the next frame starts.
                if (activeOcclusion) {
                    if (activeOcclusionSlots.length)
                        occlusionCompletions.push({ record: activeOcclusion,
                            query: activeOcclusion.query,
                            requestId: activeOcclusion.requestId,
                            metadata: activeOcclusion.metadata,
                            slots: activeOcclusionSlots.slice(),
                            final: false });
                    this.activeOcclusion = activeOcclusion;
                }
                const queryReadbacks = [];
                const encodeQueryReadback = (querySet, count, completions,
                        kind) => {
                    if (!querySet || !count || !completions.length) return;
                    const byteCount = alignUp(count * 8, 256);
                    const resolve = this.device.createBuffer({
                        label: "D3D9 " + kind + " query resolve",
                        size: byteCount,
                        usage: BUFFER_USAGE_QUERY_RESOLVE |
                            BUFFER_USAGE_COPY_SRC,
                    });
                    const read = this.device.createBuffer({
                        label: "D3D9 " + kind + " query readback",
                        size: byteCount,
                        usage: BUFFER_USAGE_COPY_DST | BUFFER_USAGE_MAP_READ,
                    });
                    encoder.resolveQuerySet(querySet, 0, count, resolve, 0);
                    encoder.copyBufferToBuffer(resolve, 0, read, 0,
                        count * 8);
                    queryReadbacks.push({ kind, count, completions, querySet,
                        resolve, read });
                };
                encodeQueryReadback(occlusionQuerySet, occlusionSlot,
                    occlusionCompletions.filter(item => item.slots.length),
                    "occlusion");
                encodeQueryReadback(timestampQuerySet, timestampSlot,
                    timestampCompletions, "timestamp");
                /* A query enclosing no draws still has a real answer: zero
                 * visible samples. It needs only the queue fence, not a query
                 * buffer mapping. */
                for (const completion of occlusionCompletions) {
                    if (!completion.slots.length && completion.final)
                        fenceCompletions.push({ ...completion,
                            query: completion.query, requestId: completion.requestId,
                            metadata: completion.metadata, zeroOcclusion: true });
                }
                // The one place the swap chain is touched, and it happens in
                // the same synchronous stretch as the submit that consumes it,
                // which is the whole rule getCurrentTexture() imposes.
                if (present) {
                    // Canvas width/height are global even though the retained
                    // image is per session. Defer this destructive resize until
                    // the session actually presents, so a capability helper's
                    // CREATE_DEVICE cannot blank the visible process.
                    this.resizeCanvasIfNeeded(this.backBufferTextureWidth,
                        this.backBufferTextureHeight);
                    const swapTexture = this.context.getCurrentTexture();
                    // A canvas resize between recording and here would leave
                    // the two sizes disagreeing; copying the overlap keeps the
                    // submit valid instead of failing the whole command buffer.
                    const copyWidth = Math.min(swapTexture.width,
                        this.backBufferTextureWidth);
                    const copyHeight = Math.min(swapTexture.height,
                        this.backBufferTextureHeight);
                    if (copyWidth && copyHeight) {
                        let presentSource = backTexture;
                        if (typeof this.replayDDOverlays === "function") {
                            const composite = this.replayDDOverlays(encoder,
                                this.presentingDevice, backTexture,
                                copyWidth, copyHeight, frame);
                            if (composite) {
                                presentSource = composite;
                                frame.transientBuffers.push(composite);
                            }
                        }
                        // A gamma ramp is applied here, at the one point every
                        // finished pixel passes through on its way to the
                        // canvas -- which is where the hardware applies it too.
                        // The plain copy stays the path for the overwhelmingly
                        // common identity case, because a lookup pass costs a
                        // full-screen draw the copy does not.
                        const gammaView = this.presentGammaView();
                        if (gammaView) {
                            // The configured canvas format, not
                            // swapTexture.format: the context was configured
                            // with the former and a pipeline target has to
                            // match what the pass writes.
                            const entry = this.gammaBlitPipelineFor(this.format);
                            const pass = encoder.beginRenderPass({
                                colorAttachments: [{
                                    view: swapTexture.createView(),
                                    loadOp: "clear",
                                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                                    storeOp: "store" }],
                            });
                            ++this.stats.renderPasses;
                            pass.setPipeline(entry.pipeline);
                            pass.setBindGroup(0, this.device.createBindGroup({
                                    layout: entry.bindGroupLayout,
                                    entries: [
                                    { binding: 0,
                                      resource: presentSource.createView() },
                                    { binding: 1, resource: entry.sampler },
                                    { binding: 2, resource: gammaView },
                                ],
                            }));
                            pass.setViewport(0, 0, copyWidth, copyHeight, 0, 1);
                            pass.draw(6);
                            pass.end();
                            ++this.stats.gammaPresents;
                        } else {
                            encoder.copyTextureToTexture(
                                { texture: presentSource },
                                { texture: swapTexture },
                                { width: copyWidth, height: copyHeight,
                                    depthOrArrayLayers: 1 });
                        }
                        ++this.stats.backBufferPresents;
                    }
                    // Drawn onto the canvas copy rather than the back buffer,
                    // so the cursor never accumulates into the image the next
                    // frame loads or GetRenderTargetData reads.
                    this.drawCursor(encoder, swapTexture.createView(),
                        swapTexture.width, swapTexture.height);
                }
                this.uploadUniformStaging();
                this.device.queue.submit([encoder.finish()]);
                ++this.stats.queueSubmits;

                for (const pending of queryReadbacks) {
                    const mapping = pending.read.mapAsync(MAP_MODE_READ).then(() => {
                        const mapped = pending.read.getMappedRange();
                        const source = new DataView(mapped);
                        const values = new Map();
                        for (const completion of pending.completions) {
                            let value = 0n;
                            if (pending.kind === "occlusion") {
                                for (const slot of completion.slots)
                                    value += source.getBigUint64(slot * 8, true);
                            } else {
                                value = source.getBigUint64(completion.slot * 8,
                                    true);
                            }
                            values.set(completion, value);
                        }
                        pending.read.unmap();
                        pending.read.destroy();
                        pending.resolve.destroy();
                        if (typeof pending.querySet.destroy === "function")
                            pending.querySet.destroy();
                        return { values };
                    }).catch(error => {
                        ++this.stats.queryFailures;
                        pending.read.destroy();
                        pending.resolve.destroy();
                        if (typeof pending.querySet.destroy === "function")
                            pending.querySet.destroy();
                        this.warnOnce("query-map-" + pending.kind,
                            "GPU query readback failed", {
                                message: String(error) });
                        return { error };
                    });
                    if (pending.kind === "occlusion") {
                        for (const completion of pending.completions) {
                            const record = completion.record;
                            record.pending = this.trackReadback(record.pending.then(() => mapping)
                                .then(result => {
                                    if (result.error) record.failed = true;
                                    else record.value += result.values.get(completion);
                                    if (!completion.final) return;
                                    ++this.stats.occlusionQueriesResolved;
                                    this.writeQueryResponse(record.query,
                                        completion.requestId, record.value,
                                        record.failed ? D9WG_RESPONSE_FAILED
                                            : D9WG_RESPONSE_OK,
                                        completion.metadata);
                                }));
                        }
                    } else {
                        this.trackReadback(mapping.then(result => {
                            for (const completion of pending.completions) {
                                if (result.error) {
                                    this.writeQueryResponse(completion.query,
                                        completion.requestId, 0,
                                        D9WG_RESPONSE_FAILED,
                                        completion.metadata);
                                    continue;
                                }
                                ++this.stats.timestampQueriesResolved;
                                this.writeQueryResponse(completion.query,
                                    completion.requestId,
                                    result.values.get(completion),
                                    D9WG_RESPONSE_OK, completion.metadata);
                            }
                        }));
                    }
                }
                const fence = this.device.queue &&
                        typeof this.device.queue.onSubmittedWorkDone === "function"
                    ? this.device.queue.onSubmittedWorkDone() : Promise.resolve();
                if (fenceCompletions.length) this.trackReadback(fence.then(() => {
                    for (const completion of fenceCompletions) {
                        if (completion.zeroOcclusion) {
                            const record = completion.record;
                            record.pending = this.trackReadback(record.pending.then(() => {
                                ++this.stats.occlusionQueriesResolved;
                                this.writeQueryResponse(record.query,
                                    completion.requestId, record.value,
                                    record.failed ? D9WG_RESPONSE_FAILED
                                        : D9WG_RESPONSE_OK,
                                    completion.metadata);
                            }));
                            continue;
                        }
                        let value = 0n;
                        switch (completion.query.type) {
                        case D3DQUERYTYPE_EVENT:
                            value = 1n;
                            ++this.stats.eventQueriesResolved;
                            break;
                        case D3DQUERYTYPE_TIMESTAMP:
                            value = BigInt(Math.floor((global.performance &&
                                global.performance.now ?
                                global.performance.now() : Date.now()) * 1000000));
                            ++this.stats.timestampQueriesResolved;
                            break;
                        case D3DQUERYTYPE_TIMESTAMPFREQ:
                            value = 1000000000n;
                            break;
                        case D3DQUERYTYPE_TIMESTAMPDISJOINT:
                        default:
                            value = 0n;
                            break;
                        }
                        this.writeQueryResponse(completion.query,
                            completion.requestId, value, D9WG_RESPONSE_OK,
                            completion.metadata);
                    }
                }, () => {
                    for (const completion of fenceCompletions) {
                        if (completion.zeroOcclusion) {
                            const record = completion.record;
                            record.pending = this.trackReadback(record.pending.then(() => {
                                record.failed = true;
                                ++this.stats.occlusionQueriesResolved;
                                this.writeQueryResponse(record.query,
                                    completion.requestId, record.value,
                                    D9WG_RESPONSE_FAILED,
                                    completion.metadata);
                            }));
                        } else {
                            this.writeQueryResponse(completion.query,
                                completion.requestId, 0,
                                D9WG_RESPONSE_FAILED, completion.metadata);
                        }
                    }
                }));
            }
            if (present) ++this.stats.presents;
            const start = frame.statStart || {};
            this.lastFrameStats = {
                pipelineCreations: this.stats.pipelineCreations -
                    (start.pipelineCreations || 0),
                bindGroupCreations: this.stats.bindGroupCreations -
                    (start.bindGroupCreations || 0),
                queueSubmits: this.stats.queueSubmits -
                    (start.queueSubmits || 0),
                renderPasses: this.stats.renderPasses -
                    (start.renderPasses || 0),
            };
            const transientBuffers = frame.transientBuffers;
            if (transientBuffers && transientBuffers.length) {
                const destroy = () => { for (const b of transientBuffers) b.destroy(); };
                if (this.device.queue && typeof this.device.queue.onSubmittedWorkDone === "function")
                    this.device.queue.onSubmittedWorkDone().then(destroy, destroy);
                else
                    destroy();
            }
            if (present && this.presentingDevice &&
                    typeof this.options.onPresent === "function")
                this.options.onPresent(this.presentingDevice.surface, this.getStats());
            if (present) this.presentingDevice = null;
        }

        // v86gl.d3d9Executor.debug.dumpSmallTextures() -> data: URLs that can
        // be opened straight from the console. Only uncompressed top-level
        // images up to 64x64 are retained (see onUpdateTexture).
        dumpSmallTextures(options) {
            const settings = options || {};
            const out = [];
            for (const [handle, resource] of this.resources) {
                if (!resource.preview) continue;
                if (settings.handle !== undefined && handle !== settings.handle)
                    continue;
                const { width, height, rgba } = resource.preview;
                let url = null;
                let error = null;
                try {
                    // A plain <canvas>, not OffscreenCanvas: only the former
                    // has toDataURL. OffscreenCanvas offers convertToBlob,
                    // which is async and cannot be returned from here -- that
                    // mismatch is why the first version of this helper
                    // reported url: null for every texture.
                    if (typeof document === "undefined")
                        throw new Error("no document to render into");
                    const canvas = document.createElement("canvas");
                    canvas.width = width;
                    canvas.height = height;
                    const context = canvas.getContext("2d");
                    const image = context.createImageData(width, height);
                    image.data.set(rgba.subarray(0, width * height * 4));
                    context.putImageData(image, 0, 0);
                    url = canvas.toDataURL();
                } catch (failure) {
                    error = failure && failure.message ? failure.message
                        : String(failure);
                }
                const entry = { handle, format: resource.format,
                    formatName: TEXTURE_FORMAT_NAMES[resource.format] ||
                        ("0x" + (resource.format >>> 0).toString(16)),
                    size: width + "x" + height,
                    declaredLevels: resource.levelCount,
                    uploadedLevels: resource.uploadedLevels
                        ? [...resource.uploadedLevels].sort((a, b) => a - b) : null,
                    url, error };
                out.push(entry);
                // Rendering them inline is the point of the helper: a data URL
                // in a console row is unreadable, an actual picture answers
                // "is the texture data wrong?" at a glance.
                if (settings.log !== false && url) {
                    const scale = Math.max(1, Math.round(64 / Math.max(width, height)));
                    console.log("%c ", "font-size:0;padding:" +
                        (height * scale / 2) + "px " + (width * scale / 2) +
                        "px;background:url(" + url +
                        ") no-repeat center/contain;image-rendering:pixelated",
                        handle, entry.formatName, entry.size);
                }
            }
            return out;
        }

        // Every distinct pipeline state actually in use, with the raw D3D9
        // render-state values behind it. Reading the real mix beats guessing
        // which blend/depth/cull combination a scene is built from.
        // Prints every translated shader the session has created: its
        // reflection (which declaration semantics it reads, which varyings it
        // writes) and, optionally, the generated WGSL. Reading the shader is
        // the only way to settle questions the pipeline cannot answer -- a
        // varying that is written but written with a constant looks exactly
        // like one that is routed correctly, from the outside.
        // Drops every translated shader, in memory and in storage, so the next
        // draw retranslates from the guest's bytecode. The revision guard in
        // D3D9ShaderCache makes this unnecessary going forward, but a cache
        // written before that guard existed carries no revision to reject it
        // by, and there is no way to age it out other than to throw it away.
        async clearShaderCache() {
            this.shaderCache = new shaderPipeline.D3D9ShaderCache();
            this.moduleCache.clear();
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

        dumpShaders(options) {
            options = options || {};
            const rows = [];
            for (const [handle, resource] of this.resources) {
                if (resource.kind !== RESOURCE_VERTEX_SHADER &&
                        resource.kind !== RESOURCE_PIXEL_SHADER) continue;
                const kind = resource.kind === RESOURCE_VERTEX_SHADER
                    ? "vertex" : "pixel";
                const translated = resource.translated;
                const reflection = translated && translated.reflection;
                rows.push({
                    handle, kind,
                    hash: [resource.hashHigh, resource.hashLow]
                        .map(value => (value >>> 0).toString(16)
                            .padStart(8, "0")).join(""),
                    ok: !!(translated && translated.ok),
                    error: translated && translated.error,
                    version: reflection ? reflection.version.major + "." +
                        reflection.version.minor : null,
                    // usage*16+usageIndex is how programFor matches a
                    // declaration element to a shader input, so print the
                    // semantics rather than the raw register numbers.
                    inputs: reflection ? reflection.inputs.map(input =>
                        "v" + input.register + "=usage" + input.usage +
                        "[" + input.usageIndex + "]") : null,
                    writtenVaryings: reflection ? reflection.writtenVaryings : null,
                    samplers: reflection
                        ? reflection.samplers.map(s => s.index) : null,
                    warnings: reflection ? reflection.warnings : null,
                });
            }
            if (options.log !== false) {
                for (const row of rows) console.log("[d3d9-shader]", row);
            }
            if (options.wgsl) {
                for (const [handle, resource] of this.resources) {
                    if (resource.kind !== RESOURCE_VERTEX_SHADER &&
                            resource.kind !== RESOURCE_PIXEL_SHADER) continue;
                    if (options.handle && handle !== options.handle) continue;
                    if (!resource.translated || !resource.translated.ok) continue;
                    console.log("[d3d9-shader] handle " + handle + " WGSL:\n" +
                        resource.translated.wgsl);
                }
            }
            return rows;
        }

        dumpPipelineStates() {
            const out = [];
            for (const [key, pipeline] of this.pipelineCache) {
                const diagnostic = pipeline._d9wgDiagnostic;
                if (diagnostic) {
                    out.push({
                        ...diagnostic,
                        vertexBuffers: diagnostic.vertexBuffers.map(layout => ({
                            ...layout,
                            attributes: layout.attributes.map(attribute =>
                                ({ ...attribute })),
                        })),
                        samplers: diagnostic.samplers.slice(),
                        state: JSON.parse(JSON.stringify(diagnostic.state)),
                        draws: pipeline._d9wgDrawCount || 0,
                    });
                    continue;
                }
                // Compatibility for a pipeline created before structured
                // diagnostics existed. Do not try to split the key: a
                // fixed-function fragment signature legitimately contains
                // "|", so its fields cannot be recovered unambiguously.
                out.push({ key, state: null,
                    draws: pipeline._d9wgDrawCount || 0 });
            }
            return out;
        }

        textureDiagnostic(handle) {
            const resource = handle ? this.resources.get(handle) : null;
            if (!resource) return { handle: handle || 0, live: false };
            const byteSummary = data => {
                const step = Math.max(1, Math.ceil(data.length / 65536));
                let sampled = 0, nonZero = 0, minimum = 255, maximum = 0;
                let hash = 2166136261 >>> 0;
                for (let index = 0; index < data.length; index += step) {
                    const value = data[index];
                    ++sampled;
                    if (value) ++nonZero;
                    minimum = Math.min(minimum, value);
                    maximum = Math.max(maximum, value);
                    hash = Math.imul(hash ^ value, 16777619) >>> 0;
                }
                return { bytes: data.length, sampled, nonZero,
                    minimum: sampled ? minimum : null,
                    maximum: sampled ? maximum : null,
                    hash: "0x" + hash.toString(16).padStart(8, "0") };
            };
            const shadowLevels = [];
            if (resource.textureShadows) {
                for (const [level, shadow] of resource.textureShadows) {
                    shadowLevels.push({ level, width: shadow.width,
                        height: shadow.height, depth: shadow.depth,
                        compressed: !!shadow.compressed,
                        data: byteSummary(shadow.data) });
                }
            }
            return {
                handle, live: true, kind: resource.kind,
                type: resource.textureType || "2d",
                format: resource.format,
                formatName: TEXTURE_FORMAT_NAMES[resource.format] || null,
                gpuFormat: resource.gpuFormat || null,
                width: resource.width, height: resource.height,
                depth: resource.depth || 1,
                levels: resource.levelCount,
                uploadedLevels: resource.uploadedLevels
                    ? [...resource.uploadedLevels].sort((a, b) => a - b) : null,
                shadowLevels,
            };
        }

        drawDiagnostic(reference, path) {
            if (!reference) return null;
            const { which, state, elements, geometry, program, pipelineState,
                targets, pipeline } = reference;
            const viewport = { ...state.viewport };
            const scissorEnabled =
                (state.renderStates.get(D3DRS_SCISSORTESTENABLE) || 0) !== 0 &&
                !!state.scissorRect;
            const scissor = scissorEnabled ? { ...state.scissorRect } : null;
            const clip = intersectRects(viewport, scissor,
                targets.width, targets.height);
            const streams = [];
            for (const [index, binding] of geometry.streams) {
                const resource = binding.resource || null;
                const shadow = resource && resource.shadow;
                const start = Math.max(0, binding.offset || 0);
                const preview = shadow
                    ? shadow.subarray(start,
                        Math.min(shadow.length, start + 64)) : null;
                streams.push({ index, stride: binding.stride || 0,
                    offset: binding.offset || 0,
                    frequency: binding.frequency === undefined
                        ? 1 : binding.frequency,
                    resourceBytes: resource ? resource.byteCount : null,
                    shadowBytes: shadow ? shadow.length : null,
                    availableVertices: shadow && binding.stride
                        ? Math.max(0, Math.floor((shadow.length - start) /
                            binding.stride)) : null,
                    firstBytes: preview ? [...preview].map(value =>
                        value.toString(16).padStart(2, "0")).join("") : null,
                });
            }
            let index = null;
            if (geometry.indexInfo) {
                const info = geometry.indexInfo;
                const resource = geometry.indexResource ||
                    this.resources.get(state.indexBufferHandle);
                const shadow = resource && resource.shadow;
                const bytesPerIndex = info.format === "uint32" ? 4 : 2;
                const scanCount = Math.min(info.count || 0, 4096);
                const samples = [];
                let minimum = Infinity, maximum = -Infinity, scanned = 0;
                if (shadow) {
                    const view = new DataView(shadow.buffer,
                        shadow.byteOffset, shadow.byteLength);
                    for (let item = 0; item < scanCount; ++item) {
                        const byteOffset = (info.offset || 0) +
                            ((info.firstIndex || 0) + item) * bytesPerIndex;
                        if (byteOffset + bytesPerIndex > shadow.length) break;
                        const value = bytesPerIndex === 4
                            ? view.getUint32(byteOffset, true)
                            : view.getUint16(byteOffset, true);
                        ++scanned;
                        if (samples.length < 24) samples.push(value);
                        minimum = Math.min(minimum, value);
                        maximum = Math.max(maximum, value);
                    }
                }
                index = { format: info.format, count: info.count,
                    firstIndex: info.firstIndex, baseVertex: info.baseVertex,
                    bufferOffset: info.offset || 0,
                    resourceBytes: resource ? resource.byteCount : null,
                    scanned,
                    minimum: Number.isFinite(minimum) ? minimum : null,
                    maximum: Number.isFinite(maximum) ? maximum : null,
                    samples };
            }
            const textureHandles = [...new Set(program.samplerIndices.map(
                sampler => state.textures.get(sampler) || 0))];
            return {
                path, which,
                shaders: { vertex: state.vertexShaderHandle || 0,
                    pixel: state.pixelShaderHandle || 0 },
                program: { vertex: program.vertexKey,
                    fragment: program.fragmentKey,
                    fixedPosition: program.fixedFunctionSignature
                        ? program.fixedFunctionSignature.positionType : null,
                    fixedTexCoordSets: program.fixedFunctionSignature
                        ? program.fixedFunctionSignature.texCoordSets.slice() : null,
                    samplers: program.samplerIndices.slice() },
                viewport, scissor, effectiveClip: clip,
                target: { width: targets.width, height: targets.height,
                    formats: targets.formats.slice(),
                    hasDepth: targets.hasDepth },
                pipelineState: JSON.parse(JSON.stringify(pipelineState)),
                pipelineDraws: pipeline._d9wgDrawCount || 0,
                elements: elements.map(element => ({ ...element })),
                streams, index,
                textures: textureHandles.map(handle =>
                    this.textureDiagnostic(handle)),
            };
        }

        blackScreenReport() {
            const device = this.presentingDevice ||
                this.devices.values().next().value || null;
            const report = {
                stats: this.getStats(),
                debug: {
                    forceSolidAllDraws: !!this.debug.forceSolidAllDraws,
                    shaderMode: this.debug.shaderMode,
                    skipProgrammableDraws:
                        !!this.debug.skipProgrammableDraws,
                    disableCull: !!this.debug.disableCull,
                    disableDepthTest: !!this.debug.disableDepthTest,
                },
                device: device ? {
                    handle: device.handle,
                    viewport: { ...device.viewport },
                    scissorRect: device.scissorRect
                        ? { ...device.scissorRect } : null,
                    shaders: { vertex: device.vertexShaderHandle || 0,
                        pixel: device.pixelShaderHandle || 0 },
                    renderStates: Object.fromEntries(device.renderStates),
                    streams: Array.from(device.streams,
                        ([index, stream]) => ({ index, ...stream })),
                    indexBufferHandle: device.indexBufferHandle,
                } : null,
                pipelines: this.dumpPipelineStates(),
                draws: {
                    fixed: this.drawDiagnostic(this.lastDraws.fixed, "fixed"),
                    programmable: this.drawDiagnostic(
                        this.lastDraws.programmable, "programmable"),
                },
                shaders: this.dumpShaders({ log: false }),
                guestReports: (this.guestReports || []).slice(),
            };
            console.log("[d3d9-webgpu] black-screen report", report);
            return report;
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
                    // null means the game never set it and the D3D9 default
                    // (start 0, end 1) applies -- which fogs everything past
                    // one unit completely, so a null here with LINEAR mode is
                    // itself the explanation for a uniformly washed-out frame.
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

        // ---- resources ----

        onCreateBuffer(bytes, view, offset) {
            const handle = view.getUint32(offset + 4, true);
            const kind = view.getUint32(offset + 8, true);
            const byteCount = view.getUint32(offset + 12, true);
            const format = view.getUint32(offset + 20, true); // index format, for INDEX kind
            const usage = kind === RESOURCE_BUFFER_INDEX
                ? BUFFER_USAGE_INDEX | BUFFER_USAGE_COPY_DST
                : BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST;
            const alignedSize = Math.max(4, alignUp(byteCount, 4));
            const gpuBuffer = this.device.createBuffer({
                size: alignedSize,
                usage,
            });
            this.resources.set(handle, {
                kind, gpuBuffer, byteCount,
                // CPU mirror of the buffer's full (aligned) content. D3D9's
                // Lock/Unlock byte ranges can start and end anywhere, but
                // WebGPU's writeBuffer requires both the destination offset
                // and the size to be a multiple of 4 -- a 16-bit index
                // buffer partially updated starting at an odd index is a
                // routine, common example that is neither. Applying the
                // update to this plain byte array first (no alignment
                // concerns) and re-uploading only the small 4-byte-aligned
                // super-range that covers it keeps every write legal without
                // ever guessing at or corrupting the untouched bytes on
                // either edge (see applyBufferUpdate()).
                shadow: new Uint8Array(alignedSize),
                indexFormat: format === D3DFMT_INDEX32 ? "uint32" : "uint16",
            });
        }

        onUpdateBuffer(bytes, view, offset, length) {
            const handle = view.getUint32(offset, true);
            const destinationOffset = view.getUint32(offset + 4, true);
            const byteCount = view.getUint32(offset + 8, true);
            const dataOffset = view.getUint32(offset + 12, true);
            const lockFlags = view.getUint32(offset + 16, true);
            const resource = this.resources.get(handle);
            if (!resource || !byteCount) return;
            this.applyBufferUpdate(resource, destinationOffset, bytes, dataOffset,
                byteCount, lockFlags);
        }

        applyBufferUpdate(resource, destinationOffset, bytes, sourceOffset,
                byteCount, lockFlags) {
            lockFlags = lockFlags || 0;
            const shadow = resource.shadow;
            if (destinationOffset >= shadow.length) return;
            if (destinationOffset + byteCount > shadow.length)
                byteCount = shadow.length - destinationOffset;
            if (!byteCount) return;
            const source = new Uint8Array(bytes.buffer, bytes.byteOffset + sourceOffset, byteCount);
            shadow.set(source, destinationOffset);

            // Renaming (below) is what keeps deferred draws honest.
            //
            // Draws are not encoded when they arrive: they are recorded and
            // replayed at Present, because a swapchain texture is only valid
            // inside the task that acquired it (see ensureFrame). Buffer
            // writes, by contrast, take effect in queue order -- so every
            // writeBuffer issued during a frame lands *before* that frame's
            // single submit, and therefore before every draw in it.
            //
            // For the single most common dynamic-geometry idiom that is
            // catastrophic:
            //
            //     Lock(DISCARD); write batch A; DrawPrimitive
            //     Lock(DISCARD); write batch B; DrawPrimitive
            //     Present
            //
            // Both draws end up reading batch B. The first renders real
            // indices against the wrong vertices, which on screen is stray
            // geometry stretching across the frame, different every frame,
            // while static/managed resources look perfect.
            //
            // A real D3D9 driver answers this by *renaming*: DISCARD means
            // "I no longer care about the old contents", and the driver hands
            // back fresh storage while in-flight commands keep the old
            // allocation. Do the same here -- but only when this buffer has
            // actually been read by a draw already recorded in this frame, so
            // the ordinary "upload once, draw many" path allocates nothing.
            //
            // The lock flags decide *which* answer is needed, and getting this
            // distinction right is what keeps the cost sane. War3 renamed ~277
            // times per frame when every mid-frame write was treated the same:
            //
            //   NOOVERWRITE  the application has promised it is only writing
            //                bytes no issued draw reads -- that is precisely
            //                the guarantee this hazard needs, and it is how a
            //                game appends batch after batch into one buffer.
            //                Write in place; renaming here is pure waste.
            //   DISCARD      the old contents are dead, so the replacement
            //                only needs the bytes being written now. The rest
            //                is garbage the application has promised not to
            //                read, so there is nothing to copy forward.
            //   neither      a plain lock keeps the old contents readable, so
            //                the replacement has to carry the whole shadow.
            //                Rare, and the only case that costs a full upload.
            const D3DLOCK_NOOVERWRITE = 0x1000;
            const D3DLOCK_DISCARD = 0x2000;
            if (this.frame && resource.frameReferenced === this.frame.serial &&
                    !(lockFlags & D3DLOCK_NOOVERWRITE)) {
                const replacement = this.device.createBuffer({
                    label: "D3D9 renamed buffer",
                    size: resource.gpuBuffer.size,
                    usage: resource.kind === RESOURCE_BUFFER_INDEX
                        ? BUFFER_USAGE_INDEX | BUFFER_USAGE_COPY_DST
                        : BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
                });
                if (lockFlags & D3DLOCK_DISCARD) {
                    const start = destinationOffset & ~3;
                    const end = Math.min(shadow.length,
                        alignUp(destinationOffset + byteCount, 4));
                    if (end > start)
                        this.device.queue.writeBuffer(replacement, start,
                            shadow.buffer, shadow.byteOffset + start, end - start);
                } else {
                    this.device.queue.writeBuffer(replacement, 0, shadow.buffer,
                        shadow.byteOffset, shadow.length);
                    ++this.stats.bufferFullCopyRenames;
                }
                this.retireGPUObject(resource.gpuBuffer);
                resource.gpuBuffer = replacement;
                resource.frameReferenced = 0;
                ++this.stats.bufferRenames;
                return;
            }
            if (this.frame && resource.frameReferenced === this.frame.serial)
                ++this.stats.bufferNoOverwriteWrites;

            const alignedStart = destinationOffset & ~3;
            const alignedEnd = Math.min(shadow.length,
                alignUp(destinationOffset + byteCount, 4));
            if (alignedEnd <= alignedStart) return;
            this.device.queue.writeBuffer(resource.gpuBuffer, alignedStart,
                shadow.buffer, shadow.byteOffset + alignedStart, alignedEnd - alignedStart);
        }

        // WebGPU requires writeBuffer's size (and destination offset) to be a
        // multiple of 4 bytes; D3D9's Lock/Unlock byte ranges carry no such
        // guarantee (a 16-bit index buffer update is a common example that
        // is not). D9WG command records are always padded to an 8-byte
        // boundary (D9WG_ALIGN8 in d3d9_proxy.c), so up to 3 extra
        // zero-padding bytes past `byteCount` are always safely readable
        // from the same batch -- this rounds the write size up into that
        // slack rather than crashing the whole batch on an unaligned
        // Direct3D-legal update.
        writeBufferAligned(gpuBuffer, dstOffset, bytes, sourceOffset, byteCount) {
            if (!byteCount) return;
            if (dstOffset % 4 !== 0) {
                console.warn("[d3d9-webgpu] dropping a buffer update at a " +
                    "non-4-byte-aligned destination offset", { dstOffset, byteCount });
                return;
            }
            let writeCount = alignUp(byteCount, 4);
            const available = gpuBuffer.size - dstOffset;
            if (writeCount > available) writeCount = available - (available % 4);
            if (writeCount <= 0) return;
            this.device.queue.writeBuffer(gpuBuffer, dstOffset,
                new Uint8Array(bytes.buffer, bytes.byteOffset + sourceOffset, writeCount));
        }

        onDestroyResource(bytes, view, offset) {
            const handle = view.getUint32(offset, true);
            const kind = view.getUint32(offset + 4, true);
            if (kind === 0) {
                // Matches the D3D8 guest convention: DESTROY_RESOURCE with
                // resource_kind 0 targets the device handle itself, emitted
                // once from device_release() when the app's last reference
                // drops (see d3d9_proxy.c).
                const state = this.devices.get(handle);
                if (state) {
                    const lastDevice = this.devices.size === 1;
                    if (lastDevice) this.discardFrame();
                    this.retireDeviceState(state, "device");
                    this.devices.delete(handle);
                    if (this.presentingDevice === state)
                        this.presentingDevice = null;
                    if (lastDevice) {
                        this.retireActiveSessionBackBuffer();
                        this.retireGPUObject(this.cursor && this.cursor.texture);
                        this.retireGPUObject(this.cursor && this.cursor.uniform);
                        this.cursor = { texture: null, view: null, width: 0,
                            height: 0, hotspotX: 0, hotspotY: 0, x: 0, y: 0,
                            visible: false, pipeline: null, sampler: null,
                            uniform: null };
                    }
                }
                return;
            }
            const resource = this.resources.get(handle);
            if (!resource) return;
            // Never destroy inline. A frame being recorded may already hold a
            // bind group referencing this texture's view or a pending draw
            // referencing this buffer, and none of it is submitted until
            // Present -- destroying now makes WebGPU reject the whole command
            // buffer ("Destroyed texture ... used in a submit"). Releasing a
            // texture in the same frame it was last drawn with is ordinary
            // application behaviour, not an edge case.
            this.retireResourceState(resource);
            this.resources.delete(handle);
        }

        onCreateTexture2D(bytes, view, offset, length) {
            const handle = view.getUint32(offset + 4, true);
            const width = view.getUint32(offset + 8, true);
            const height = view.getUint32(offset + 12, true);
            let levelCount = view.getUint32(offset + 16, true);
            const format = view.getUint32(offset + 20, true);
            const usage = view.getUint32(offset + 24, true);
            const multisampleType = length >= 40
                ? view.getUint32(offset + 32, true) : D3DMULTISAMPLE_NONE;
            const multisampleQuality = length >= 40
                ? view.getUint32(offset + 36, true) : 0;
            // A render target or depth surface arrives as a CREATE_TEXTURE_2D
            // carrying the usage (see d3d9_protocol.h): the host needs a GPU
            // texture either way, and D3D9 reaches a texture's render target
            // through GetSurfaceLevel as often as through CreateRenderTarget, so
            // one opcode covers both without two host paths for one object.
            // A FOURCC depth format is a depth resource whether or not the
            // app spelled out D3DUSAGE_DEPTHSTENCIL: INTZ in particular is
            // routinely created with usage 0 and then bound as the depth
            // surface, which is exactly the trick it exists for.
            const isDepth = (usage & D3DUSAGE_DEPTHSTENCIL) !== 0 ||
                isFourCCDepthFormat(format);
            const isTarget = (usage & D3DUSAGE_RENDERTARGET) !== 0;
            const ddIndexed = (usage & D9WG_USAGE_DDRAW_INDEXED) !== 0 &&
                isPalettizedFormat(format) && !isDepth;
            const sampleCount = sampleCountForD3D(multisampleType,
                multisampleQuality);
            if (!sampleCount) {
                ++this.stats.texturesRejected;
                this.warnOnce("invalid-texture-msaa-" + multisampleType + "-" +
                        multisampleQuality,
                    "a texture requested an unsupported D3D9 multisample " +
                    "configuration and is rejected instead of silently " +
                    "creating a resource with different sampling semantics",
                    { multisampleType, multisampleQuality });
                return;
            }
            if (sampleCount > 1 && (!isTarget && !isDepth)) {
                ++this.stats.texturesRejected;
                this.warnOnce("msaa-non-attachment-texture",
                    "a multisampled D3D9 texture must be a render target or " +
                    "depth-stencil attachment", { usage, sampleCount });
                return;
            }
            if (sampleCount > 1 && levelCount > 1) {
                ++this.stats.texturesRejected;
                this.warnOnce("msaa-mip-chain",
                    "a multisampled D3D9 texture cannot have multiple mip " +
                    "levels; the resource is rejected", { levelCount,
                        sampleCount });
                return;
            }
            // Every D3D9 depth format collapses onto one real depth target: the
            // guest cannot read any of them back, so only "a depth buffer
            // exists" is observable (same argument as ensureDepthTarget).
            // D3DUSAGE_AUTOGENMIPMAP means the app owns level 0 and the driver
            // owns everything under it. The guest therefore reports one level
            // -- which is what D3D9's GetLevelCount says for such a texture --
            // and the full chain is allocated here, where it is filled.
            const autoGenerateMips = (usage & D3DUSAGE_AUTOGENMIPMAP) !== 0 &&
                !isDepth;
            if (autoGenerateMips)
                levelCount = fullMipLevelCount(width, height);
            const gpuFormat = isDepth ? DEPTH_FORMAT
                : (ddIndexed ? "r8uint" : formatToGPU(format));
            if (!gpuFormat) {
                console.warn("[d3d9-webgpu] unsupported texture format", format);
                return;
            }
            if (isTarget && !isDepth && !isRenderableGPUFormat(gpuFormat)) {
                ++this.stats.texturesRejected;
                this.warnOnce("non-renderable-d3d9-target-" + format,
                    "a texture was marked as a D3D9 render target but its " +
                    "WebGPU storage format cannot be a render attachment; " +
                    "the resource is rejected instead of creating an invalid " +
                    "GPU descriptor", { format, gpuFormat });
                return;
            }
            const srgbFormat = isDepth ? null : srgbSiblingOf(gpuFormat);
            const textureDescriptor = {
                label: isDepth ? "D3D9 depth surface"
                    : (isTarget ? "D3D9 render target" : undefined),
                size: { width, height, depthOrArrayLayers: 1 },
                format: gpuFormat,
                ...(srgbFormat ? { viewFormats: [srgbFormat] } : {}),
                mipLevelCount: Math.max(1, levelCount),
                ...(isDepth && sampleCount > 1 ? { sampleCount } : {}),
                usage: (isDepth
                        ? TEXTURE_USAGE_RENDER_ATTACHMENT |
                          // A D3D9 depth *texture* is the standard hardware
                          // shadow map: rendered into as a depth attachment,
                          // then bound to a sampler so the lighting pass can
                          // compare against it. Leaving the binding usage off
                          // made that second half impossible -- see the
                          // `view` field below.
                          (sampleCount > 1 ? 0 : TEXTURE_USAGE_TEXTURE_BINDING)
                        : TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_COPY_SRC |
                          TEXTURE_USAGE_TEXTURE_BINDING) |
                    // A blit writes through a render pass, so anything that can
                    // be a StretchRect destination needs the attachment usage.
                    // BCn cannot be an attachment at all, which is also why a
                    // StretchRect into a compressed texture stays unsupported.
                    ((!isDepth && isRenderableGPUFormat(gpuFormat) &&
                        (isTarget || autoGenerateMips ||
                            !isCompressedFormat(format)))
                        ? TEXTURE_USAGE_RENDER_ATTACHMENT : 0),
            };
            const gpuTexture = this.createTextureOrNull(textureDescriptor, format);
            if (!gpuTexture) return;
            // WebGPU multisampled colour textures cannot be sampled or copied.
            // Keep the ordinary texture as D3D9's resolved surface and render
            // through a transiently persistent multisampled attachment which
            // resolves into it at every pass boundary. Depth has no resolve in
            // either API, so its primary texture itself is multisampled.
            let msaaTexture = null;
            if (sampleCount > 1 && isTarget && !isDepth) {
                const msaaDescriptor = {
                    label: "D3D9 multisampled render target",
                    size: { width, height, depthOrArrayLayers: 1 },
                    format: gpuFormat,
                    ...(srgbFormat ? { viewFormats: [srgbFormat] } : {}),
                    mipLevelCount: 1,
                    sampleCount,
                    usage: TEXTURE_USAGE_RENDER_ATTACHMENT,
                };
                msaaTexture = this.createTextureOrNull(msaaDescriptor, format);
                if (!msaaTexture) {
                    if (typeof gpuTexture.destroy === "function")
                        gpuTexture.destroy();
                    return;
                }
            }
            ++this.stats.texturesCreated;
            if (isTarget) ++this.stats.renderTargetsCreated;
            // No sampler is attached to the texture: since M2, sampling
            // parameters come from the device's per-stage sampler state
            // through samplerFor(), so the same texture bound to two stages
            // with different filtering behaves the way D3D9 says it should.
            this.resources.set(handle, {
                kind: RESOURCE_TEXTURE_2D, textureType: "2d",
                deviceHandle: view.getUint32(offset, true),
                gpuTexture, msaaTexture, gpuFormat, srgbFormat, format, usage,
                width, height, sampleCount,
                multisampleType, multisampleQuality,
                gpuBytesPerTexel: ddIndexed ? 1 : gpuBytesPerTexel(format),
                ddIndexed,
                textureDescriptor,
                levelCount: Math.max(1, levelCount),
                // A subresource the guest never initializes has undefined
                // contents.  Initialization can arrive either as a CPU upload
                // or as a GPU write such as DirectDraw Blt/StretchRect.
                // Sampling one is not "slightly blurry" -- it is whatever was
                // in that memory, which reads as a completely wrong texture.
                // M1 could not hit this the same way because it sampled with
                // one hardcoded sampler; M2 honours D3DSAMP_MIPFILTER, so a
                // game asking for mip filtering now reaches levels that were
                // never written.
                // A render target's or depth surface's levels are written by
                // the GPU, never uploaded, so tracking them would make the
                // incomplete-mip-chain warning fire on every draw that samples
                // a perfectly valid target.
                // A generated chain is written by the GPU, never uploaded, so
                // tracking it would make the incomplete-mip warning fire on
                // every draw that samples a perfectly valid texture.
                uploadedLevels: (isTarget || isDepth || autoGenerateMips)
                    ? null : new Set(),
                autoGenerateMips,
                isDepth,
                // D3D9 has two ways to read a depth texture and they are not
                // interchangeable. A D16/D24X8/D32 texture bound to a sampler
                // is a hardware shadow map: the driver compares and returns
                // filtered visibility. A DF16/DF24/INTZ texture returns the
                // stored depth itself, which is precisely why an app picks one.
                // Sampling either as though it were the other produces an
                // image that looks deliberate and is wrong.
                depthReadsRaw: isDepth && isFourCCDepthFormat(format),
                // A null view here used to be the modelling assumption that a
                // depth surface is only ever an attachment -- nothing can read
                // its pixels back, so "a depth buffer exists" looked like the
                // whole of its observable behaviour. Shadow mapping is the
                // counter-example, and the failure was not a wrong image: the
                // null reached createBindGroup as a binding resource and threw
                // a TypeError out of the batch, taking every command after it
                // in that batch with it.
                //
                // depth24plus-stencil8 can only be sampled one aspect at a
                // time, and the stencil aspect would need its own uint layout
                // entry that no D3D9 shader can ask for.
                view: !isDepth ? gpuTexture.createView()
                    : (sampleCount > 1 ? null
                        : gpuTexture.createView({ aspect: "depth-only" })),
            });
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

        textureShadowFor(resource, level, layer, compressed) {
            if (!resource.textureShadows) resource.textureShadows = new Map();
            const key = level + ":" + (resource.textureType === "3d" ? 0 : layer);
            let shadow = resource.textureShadows.get(key);
            if (shadow) return shadow;
            const width = Math.max(1, resource.width >> level);
            const height = Math.max(1, resource.height >> level);
            const depth = resource.textureType === "3d"
                ? Math.max(1, resource.depth >> level) : 1;
            let bytesPerRow;
            let rowsPerImage;
            if (compressed) {
                const blockBytes = compressedBlockBytes(resource.format);
                bytesPerRow = Math.ceil(width / 4) * blockBytes;
                rowsPerImage = Math.ceil(height / 4);
            } else {
                bytesPerRow = width * resource.gpuBytesPerTexel;
                rowsPerImage = height;
            }
            shadow = { level, layer: resource.textureType === "3d" ? 0 : layer,
                width, height, depth, bytesPerRow, rowsPerImage,
                compressed, data: new Uint8Array(bytesPerRow * rowsPerImage * depth) };
            resource.textureShadows.set(key, shadow);
            return shadow;
        }

        updateTextureShadow(resource, level, layer, x, y, width, height,
                payload, sourceBytesPerRow, compressed, depth = 1,
                sourceSlicePitch = 0) {
            const shadow = this.textureShadowFor(resource, level, layer,
                compressed);
            const blockBytes = compressed
                ? compressedBlockBytes(resource.format)
                : resource.gpuBytesPerTexel;
            const destinationX = compressed ? Math.floor(x / 4) : x;
            const destinationY = compressed ? Math.floor(y / 4) : y;
            const rowBytes = compressed
                ? Math.ceil(width / 4) * blockBytes
                : width * resource.gpuBytesPerTexel;
            const rowCount = compressed ? Math.ceil(height / 4) : height;
            const sourceSlice = sourceSlicePitch || sourceBytesPerRow * rowCount;
            for (let slice = 0; slice < depth; ++slice) {
                for (let row = 0; row < rowCount; ++row) {
                    const destinationOffset = resource.textureType === "3d"
                        ? (layer + slice) * shadow.bytesPerRow *
                            shadow.rowsPerImage +
                            (destinationY + row) * shadow.bytesPerRow +
                            destinationX * blockBytes
                        : (destinationY + row) * shadow.bytesPerRow +
                            destinationX * blockBytes;
                    const sourceOffset = slice * sourceSlice +
                        row * sourceBytesPerRow;
                    const available = Math.max(0,
                        Math.min(rowBytes, shadow.data.length - destinationOffset,
                            payload.length - sourceOffset));
                    if (available)
                        shadow.data.set(payload.subarray(sourceOffset,
                            sourceOffset + available), destinationOffset);
                }
            }
        }

        renameTextureForUpdate(resource) {
            if (!resource.textureDescriptor ||
                    (resource.usage & (D3DUSAGE_RENDERTARGET |
                        D3DUSAGE_DEPTHSTENCIL)) !== 0)
                return false;
            let replacement;
            try {
                replacement = this.device.createTexture({
                    ...resource.textureDescriptor,
                    label: "D3D9 renamed texture",
                });
            } catch (error) {
                this.warnOnce("texture-rename-failed",
                    "a texture updated after an earlier draw could not be " +
                    "renamed; that earlier draw may see the newer pixels", {
                        format: resource.format,
                        size: resource.width + "x" + resource.height,
                        message: error && error.message,
                    });
                return false;
            }
            if (resource.textureShadows) {
                for (const shadow of resource.textureShadows.values()) {
                    this.device.queue.writeTexture({ texture: replacement,
                        mipLevel: shadow.level,
                        origin: { x: 0, y: 0, z: shadow.layer } }, shadow.data,
                        { bytesPerRow: shadow.bytesPerRow,
                            rowsPerImage: shadow.rowsPerImage },
                        { width: blockAlignedCopyExtent(shadow.width,
                                shadow.compressed),
                            height: blockAlignedCopyExtent(shadow.height,
                                shadow.compressed),
                            depthOrArrayLayers: shadow.depth || 1 });
                    this.stats.textureFullCopyRenameBytes += shadow.data.length;
                }
            }
            const oldTexture = resource.gpuTexture;
            resource.gpuTexture = replacement;
            resource.view = replacement.createView({ dimension:
                resource.textureType === "cube" ? "cube"
                    : resource.textureType === "3d" ? "3d" : "2d" });
            resource.srgbView = null;
            resource.blitViews = null;
            resource.targetViews = null;
            resource.frameReferenced = 0;
            this.retireGPUObject(oldTexture);
            ++this.stats.textureRenames;
            return true;
        }

        onUpdateTexture(bytes, view, offset) {
            const handle = view.getUint32(offset, true);
            const level = view.getUint32(offset + 4, true);
            const x = view.getUint32(offset + 8, true);
            const y = view.getUint32(offset + 12, true);
            // D9WGUpdateTexture.z is the cube face for a cube texture and the
            // slice for a volume texture; both land on the same WebGPU array
            // layer, which is why one field and one opcode serve both.
            const z = view.getUint32(offset + 16, true);
            const width = view.getUint32(offset + 20, true);
            const height = view.getUint32(offset + 24, true);
            const depth = Math.max(1, view.getUint32(offset + 28, true));
            const rowPitch = view.getUint32(offset + 32, true);
            const slicePitch = view.getUint32(offset + 36, true) ||
                rowPitch * height;
            const dataBytes = view.getUint32(offset + 40, true);
            const dataOffset = view.getUint32(offset + 44, true);
            const resource = this.resources.get(handle);
            if (!resource || !resource.gpuTexture) return;
            const source = new Uint8Array(bytes.buffer, bytes.byteOffset + dataOffset, dataBytes);
            const compressed = isCompressedFormat(resource.format);
            // Bind groups are built eagerly and retain the old view. Renaming
            // here therefore preserves pixels for draws already recorded in
            // this frame while later draws bind the replacement texture.
            if (this.frame && resource.frameReferenced === this.frame.serial) {
                ++this.stats.textureUpdateHazards;
                this.renameTextureForUpdate(resource);
            }
            let payload = source;
            let bytesPerRow = rowPitch;
            if (resource.ddIndexed) {
                // An indexed DirectDraw surface stores what the app wrote: the
                // bytes are the texels, and nothing about them changes when the
                // palette does. Only the row padding comes off, because
                // writeTexture wants the rows tightly packed.
                const packed = new Uint8Array(width * height * depth);
                for (let slice = 0; slice < depth; ++slice) {
                    for (let row = 0; row < height; ++row) {
                        const from = slice * slicePitch + row * rowPitch;
                        packed.set(source.subarray(from, from + width),
                            slice * width * height + row * width);
                    }
                }
                this.updateTextureShadow(resource, level, z, x, y, width,
                    height, packed, width, false, depth, width * height);
                ++this.stats.textureUploads;
                this.stats.textureBytesUploaded += packed.length;
                resource.ddContentSerial = (resource.ddContentSerial || 0) + 1;
                this.markTextureSubresourceWritten(resource, level, z);
                // Keep the primary r8uint texture current for indexed-to-
                // indexed DirectDraw blits.  The RGBA sampling companion is
                // derived lazily from the same shadow by ddIndexedSampleViewFor.
                this.device.queue.writeTexture(
                    { texture: resource.gpuTexture, mipLevel: level,
                        origin: { x, y, z } }, packed,
                    { bytesPerRow: width, rowsPerImage: height },
                    { width, height, depthOrArrayLayers: depth });
                return;
            }
            if (isPalettizedFormat(resource.format)) {
                // The indices, not the colours, are what the app uploaded. A
                // palette swap has to repaint this texture without any new
                // traffic -- that is the whole point of a palettized format --
                // so the source bytes are kept and re-expanded on demand.
                this.rememberPalettizedUpload(resource, {
                    level, z, x, y, width, height, depth, rowPitch, slicePitch,
                    source: source.slice(),
                });
            }
            if (!compressed) {
                const gpuBpp = resource.gpuBytesPerTexel;
                // Expand to the tightly packed WebGPU representation chosen
                // by formatToGPU(): RGBA8 UNORM/SNORM or RGBA16F.
                const expandedSlicePitch = width * height * gpuBpp;
                const expanded = new Uint8Array(expandedSlicePitch * depth);
                const palette = isPalettizedFormat(resource.format)
                    ? this.currentPaletteFor(handle) : null;
                for (let slice = 0; slice < depth; ++slice) {
                    for (let row = 0; row < height; ++row) {
                        expandRowToGPU(resource.format, source,
                            slice * slicePitch + row * rowPitch, width,
                            expanded, slice * expandedSlicePitch +
                                row * width * gpuBpp, palette);
                    }
                }
                payload = expanded;
                bytesPerRow = width * gpuBpp;
            }
            this.updateTextureShadow(resource, level, z, x, y, width, height,
                payload, bytesPerRow, compressed, depth,
                bytesPerRow * (compressed ? Math.ceil(height / 4) : height));
            ++this.stats.textureUploads;
            this.stats.textureBytesUploaded += payload.length;
            // Only level 0 is the app's on an autogen texture, so only level 0
            // can invalidate what the driver generated from it.
            this.markTextureSubresourceWritten(resource, level, z);
            // Retain a CPU copy of small top-level images. This is the one
            // piece of evidence that separates "the texture data we uploaded
            // is wrong" from "the data is right but we sample it wrong", and
            // guessing between those two has already cost several rounds.
            // Bounded to sprite-sized textures so it cannot grow without
            // limit -- cursors and UI glyphs are exactly this size.
            // 64x64 was too small a net: a game's cursor and UI glyphs
            // usually live in a larger atlas, so the one texture worth looking
            // at was the one never captured. 256x256 covers those at a bounded
            // total cost (previewBudget below).
            if (!compressed && resource.gpuFormat === "rgba8unorm" &&
                    resource.textureType !== "3d" && depth === 1 &&
                    level === 0 && z === 0 && width <= 256 &&
                    height <= 256 && x === 0 && y === 0) {
                const previewBytes = width * height * 4;
                if (!resource.preview) {
                    if (this.previewBudget === undefined)
                        this.previewBudget = 16 * 1024 * 1024;
                    if (this.previewBudget >= previewBytes) {
                        this.previewBudget -= previewBytes;
                        resource.preview = {
                            width, height, rgba: payload.slice()
                        };
                    } else {
                        // The preview is diagnostics only. Returning here used
                        // to drop the real queue.writeTexture below once War3
                        // had loaded 16 MiB of menu atlases. Textures first
                        // touched in battle (fog/minimap/command icons/software
                        // cursor) consequently stayed black or transparent.
                        ++this.stats.texturePreviewsSkipped;
                    }
                } else {
                    resource.preview = { width, height, rgba: payload.slice() };
                }
            }
            // rowsPerImage counts *block* rows for a block-compressed format,
            // not pixel rows -- BCn blocks are 4x4, so a DXT upload that
            // passes the pixel height describes an image four times taller
            // than the data actually is.
            this.device.queue.writeTexture(
                { texture: resource.gpuTexture, mipLevel: level, origin: { x, y, z } },
                payload,
                { bytesPerRow, rowsPerImage: compressed ? Math.ceil(height / 4) : height },
                { width: blockAlignedCopyExtent(width, compressed),
                    height: blockAlignedCopyExtent(height, compressed),
                    depthOrArrayLayers: depth });
        }

        // ---- render targets, cube textures and blits (M3/M4) ----

        // A cube texture is a six-layer 2D WebGPU texture viewed as "cube".
        // Both views are kept: bind groups need the cube view, and a blit or an
        // upload addresses a single face, which only the layered 2D form can do.
        onCreateTextureCube(bytes, view, offset) {
            const handle = view.getUint32(offset + 4, true);
            const edge = view.getUint32(offset + 8, true);
            const levelCount = Math.max(1, view.getUint32(offset + 12, true));
            const format = view.getUint32(offset + 16, true);
            const usage = view.getUint32(offset + 20, true);
            const ddIndexed = (usage & D9WG_USAGE_DDRAW_INDEXED) !== 0 &&
                isPalettizedFormat(format);
            const gpuFormat = ddIndexed ? "r8uint" : formatToGPU(format);
            if (!gpuFormat) {
                console.warn("[d3d9-webgpu] unsupported cube texture format", format);
                return;
            }
            const autoGenerateMips = (usage & D3DUSAGE_AUTOGENMIPMAP) !== 0;
            const srgbFormat = srgbSiblingOf(gpuFormat);
            const textureDescriptor = {
                label: "D3D9 cube " + edge,
                size: { width: edge, height: edge, depthOrArrayLayers: 6 },
                format: gpuFormat,
                ...(srgbFormat ? { viewFormats: [srgbFormat] } : {}),
                mipLevelCount: autoGenerateMips
                    ? fullMipLevelCount(edge, edge) : levelCount,
                usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_COPY_SRC |
                    TEXTURE_USAGE_TEXTURE_BINDING |
                    // A dynamic environment map is a cube render target: the
                    // app renders the scene six times, once per face, through
                    // the surfaces GetCubeMapSurface hands out.
                    ((((usage & D3DUSAGE_RENDERTARGET) || autoGenerateMips) &&
                        isRenderableGPUFormat(gpuFormat))
                        ? TEXTURE_USAGE_RENDER_ATTACHMENT : 0),
            };
            const gpuTexture = this.createTextureOrNull(textureDescriptor, format);
            if (!gpuTexture) return;
            ++this.stats.texturesCreated;
            ++this.stats.cubeTexturesCreated;
            this.resources.set(handle, {
                kind: RESOURCE_TEXTURE_CUBE, textureType: "cube",
                deviceHandle: view.getUint32(offset, true),
                gpuTexture, gpuFormat, srgbFormat,
                format, usage, width: edge, height: edge, layerCount: 6,
                gpuBytesPerTexel: ddIndexed ? 1 : gpuBytesPerTexel(format),
                ddIndexed,
                textureDescriptor,
                levelCount: textureDescriptor.mipLevelCount,
                // Keyed by level*6+face, so the incomplete-mip warning counts a
                // cube's faces independently -- a game that fills face 0's whole
                // chain and leaves face 5 empty is a real bug this would hide if
                // the levels were tracked per-level only.
                uploadedLevels: autoGenerateMips ? null : new Set(),
                autoGenerateMips,
                view: gpuTexture.createView({ dimension: "cube" }),
            });
        }

        onCreateTextureVolume(bytes, view, offset, length) {
            if (length < 40) return;
            const handle = view.getUint32(offset + 4, true);
            const width = view.getUint32(offset + 8, true);
            const height = view.getUint32(offset + 12, true);
            const depth = view.getUint32(offset + 16, true);
            const levelCount = Math.max(1, view.getUint32(offset + 20, true));
            const format = view.getUint32(offset + 24, true);
            const usage = view.getUint32(offset + 28, true);
            const gpuFormat = formatToGPU(format);
            if (!gpuFormat || isCompressedFormat(format) ||
                    (isRenderableGPUFormat(gpuFormat) &&
                        (usage & D3DUSAGE_RENDERTARGET))) {
                ++this.stats.texturesRejected;
                return;
            }
            const textureDescriptor = {
                label: "D3D9 volume texture",
                size: { width, height, depthOrArrayLayers: depth },
                dimension: "3d",
                format: gpuFormat,
                mipLevelCount: levelCount,
                usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_COPY_SRC |
                    TEXTURE_USAGE_TEXTURE_BINDING,
            };
            const gpuTexture = this.createTextureOrNull(textureDescriptor,
                format);
            if (!gpuTexture) return;
            ++this.stats.texturesCreated;
            ++this.stats.volumeTexturesCreated;
            this.resources.set(handle, {
                kind: RESOURCE_TEXTURE_VOLUME, textureType: "3d",
                deviceHandle: view.getUint32(offset, true),
                gpuTexture, gpuFormat, format, usage,
                width, height, depth,
                gpuBytesPerTexel: gpuBytesPerTexel(format),
                textureDescriptor, levelCount,
                uploadedLevels: new Set(),
                view: gpuTexture.createView({ dimension: "3d" }),
            });
        }

        // createTexture throws for a format the device does not support, and an
        // exception here propagates out of the batch and discards the whole
        // frame -- one unsupported texture would blank the screen instead of
        // costing one texture. Contained, counted, and named once instead: the
        // draws that bind it fall back to the 1x1 white stand-in, which is
        // visibly wrong in a way that points at the right place.
        createTextureOrNull(descriptor, d3dFormat) {
            try {
                return this.device.createTexture(descriptor);
            } catch (error) {
                ++this.stats.texturesRejected;
                this.warnOnce("createtexture-" + descriptor.format,
                    "the WebGPU device refused a texture format the D3D9 " +
                    "format table claims to support; every draw sampling it " +
                    "gets the 1x1 white fallback instead", {
                        d3dFormat, gpuFormat: descriptor.format,
                        size: descriptor.size,
                        bcSupported: this.deviceFeatures &&
                            this.deviceFeatures.bc,
                        message: error && error.message,
                    });
                return null;
            }
        }

        onSetScissorRect(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            const left = view.getInt32(offset + 4, true);
            const top = view.getInt32(offset + 8, true);
            const right = view.getInt32(offset + 12, true);
            const bottom = view.getInt32(offset + 16, true);
            state.scissorRect = { x: Math.max(0, left), y: Math.max(0, top),
                width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
        }

        onSetRenderTarget(bytes, view, offset, length) {
            const state = this.deviceState(view.getUint32(offset, true));
            const index = view.getUint32(offset + 4, true);
            if (index >= MAX_RENDER_TARGETS) return;
            state.renderTargets[index] = view.getUint32(offset + 8, true);
            state.renderTargetLevels[index] = view.getUint32(offset + 12, true);
            // Protocol 1.4 added the cube face. Length-gated so a 1.3 payload
            // still decodes as "face 0", which is what a 2D target always is.
            state.renderTargetFaces[index] = length >= 20
                ? view.getUint32(offset + 16, true) : 0;
            ++this.stats.renderTargetBinds;
        }

        // ---- texture palettes ----
        //
        // A D3D9 palette is device state consulted when a texel is sampled,
        // not a property baked into the texture: the same P8 surface takes on
        // different colours as the app switches palettes, with no upload in
        // between. WebGPU has no palettized format, so the expansion happens on
        // the CPU -- which means the indices have to be kept and replayed
        // whenever the table or the selection changes.

        paletteFor(deviceHandle, index) {
            if (!this.palettes) this.palettes = new Map();
            return this.palettes.get(deviceHandle + ":" + index) || null;
        }

        currentPaletteFor(resourceHandle) {
            const resource = this.resources.get(resourceHandle);
            const deviceHandle = resource ? resource.deviceHandle : 0;
            const state = this.devices.get(deviceHandle);
            if (!state || state.currentPalette === null ||
                    state.currentPalette === undefined)
                return null;
            return this.paletteFor(deviceHandle, state.currentPalette);
        }

        rememberPalettizedUpload(resource, upload) {
            if (!resource.palettizedUploads) resource.palettizedUploads = [];
            // Keyed by subresource *and* sub-rectangle: a partial LockRect
            // update of one region must not discard the rest of the level.
            const key = upload.level + ":" + upload.z + ":" + upload.x + ":" +
                upload.y + ":" + upload.width + ":" + upload.height;
            const existing = resource.palettizedUploads
                .findIndex(item => item.key === key);
            upload.key = key;
            if (existing >= 0) resource.palettizedUploads[existing] = upload;
            else resource.palettizedUploads.push(upload);
        }

        // Re-expands every palettized texture on the device through the palette
        // now in force. Cheap in the way that matters: palettized content is
        // one byte per texel by definition, and a palette swap is rare.
        repaintPalettizedTextures(deviceHandle) {
            let repainted = 0;
            for (const [handle, resource] of this.resources) {
                if (!resource || resource.deviceHandle !== deviceHandle) continue;
                if (!isPalettizedFormat(resource.format)) continue;
                if (!resource.palettizedUploads) continue;
                const palette = this.currentPaletteFor(handle);
                for (const upload of resource.palettizedUploads) {
                    this.uploadPalettizedRegion(resource, upload, palette);
                    ++repainted;
                }
            }
            this.stats.palettizedRepaints += repainted;
        }

        uploadPalettizedRegion(resource, upload, palette) {
            const gpuBpp = resource.gpuBytesPerTexel;
            const { level, z, x, y, width, height, depth, rowPitch,
                slicePitch, source } = upload;
            const expandedSlicePitch = width * height * gpuBpp;
            const expanded = new Uint8Array(expandedSlicePitch * depth);
            for (let slice = 0; slice < depth; ++slice) {
                for (let row = 0; row < height; ++row) {
                    expandRowToGPU(resource.format, source,
                        slice * slicePitch + row * rowPitch, width,
                        expanded,
                        slice * expandedSlicePitch + row * width * gpuBpp,
                        palette);
                }
            }
            const bytesPerRow = width * gpuBpp;
            // A repaint rewrites pixels a bind group recorded earlier in this
            // frame may still be reading, so it takes the same rename hazard
            // path an ordinary mid-frame update does.
            if (this.frame && resource.frameReferenced === this.frame.serial) {
                ++this.stats.textureUpdateHazards;
                this.renameTextureForUpdate(resource);
            }
            this.updateTextureShadow(resource, level, z, x, y, width, height,
                expanded, bytesPerRow, false, depth, bytesPerRow * height);
            this.device.queue.writeTexture(
                { texture: resource.gpuTexture, mipLevel: level,
                    origin: { x, y, z } },
                expanded, { bytesPerRow, rowsPerImage: height },
                { width, height, depthOrArrayLayers: depth });
        }

        // ---- automatic mip generation ----
        //
        // D3DUSAGE_AUTOGENMIPMAP hands the driver everything below level 0 and
        // asks it to keep the chain current. D3D9 regenerates whenever the top
        // level changes; the host is the side that can see when that actually
        // happened -- an upload landed, or a render pass had level 0 as its
        // attachment -- so the trigger lives here rather than being guessed at
        // by the guest. GenerateMipSubLevels() arrives as its own opcode for
        // the case where the app asks explicitly.

        // Remember every subresource write, irrespective of whether its pixels
        // came over the wire or were produced on the GPU.  uploadedLevels keeps
        // its historical name because it is also exposed in diagnostic state,
        // but semantically it is the set of initialized levels/faces.
        markTextureSubresourceWritten(resource, level, layer = 0) {
            if (!resource) return;
            if (resource.uploadedLevels) {
                if (resource.textureType === "3d") {
                    resource.uploadedLevels.add(level);
                } else {
                    const layerCount = Math.max(1, resource.layerCount || 1);
                    const safeLayer = Math.max(0,
                        Math.min(layer >>> 0, layerCount - 1));
                    // Six slots per level preserve the existing cube-map key
                    // layout while a 2D texture naturally occupies slot zero.
                    resource.uploadedLevels.add(level * 6 + safeLayer);
                }
            }
            if (level === 0) this.markMipsDirty(resource);
        }

        markMipsDirty(resource) {
            if (!resource || !resource.autoGenerateMips) return;
            resource.mipsDirty = true;
        }

        // Queued before whatever is about to read the texture, not executed
        // now: the chain is filled by render passes, and record time is inside
        // whatever pass is already open.
        flushGeneratedMips(resource) {
            if (!resource || !resource.autoGenerateMips || !resource.mipsDirty)
                return;
            if (!resource.gpuTexture || resource.levelCount < 2) {
                resource.mipsDirty = false;
                return;
            }
            resource.mipsDirty = false;
            const frame = this.ensureFrame();
            frame.ops.push({ kind: "generate-mips", resource });
            resource.frameReferenced = frame.serial;
            ++this.stats.mipChainsGenerated;
        }

        // One blit per level, each reading the level above with linear
        // filtering: the box downsample D3D9's default D3DTEXF_LINEAR describes.
        replayGenerateMips(encoder, op) {
            const resource = op.resource;
            const layers = resource.layerCount || 1;
            const format = resource.gpuFormat || formatToGPU(resource.format);
            const buffers = [];
            for (let layer = 0; layer < layers; ++layer) {
                for (let level = 1; level < resource.levelCount; ++level) {
                    const width = Math.max(1, resource.width >> level);
                    const height = Math.max(1, resource.height >> level);
                    const blit = {
                        kind: "blit",
                        sourceView: this.blitSourceView(resource, level - 1,
                            layer),
                        destinationView: this.targetViewFor(resource, level,
                            false, layer),
                        destinationFormat: format,
                        sourceFormat: format,
                        // The whole of the parent level, into the whole of this
                        // one.
                        sourceRect: [0, 0, 1, 1],
                        viewport: [0, 0, width, height],
                        filterPoint: false,
                    };
                    const transient = this.replayBlit(encoder, blit, null);
                    if (transient) buffers.push(transient);
                    ++this.stats.mipLevelsGenerated;
                }
            }
            return buffers;
        }

        onGenerateMips(bytes, view, offset) {
            const resource = this.resources.get(
                view.getUint32(offset + 4, true));
            if (!resource || !resource.autoGenerateMips) return;
            // An explicit call regenerates whether or not the host noticed a
            // write: the app may know something the write tracking cannot.
            resource.mipsDirty = true;
            this.flushGeneratedMips(resource);
            ++this.stats.explicitMipGenerations;
        }

        onSetTextureLOD(bytes, view, offset) {
            const resource = this.resources.get(
                view.getUint32(offset + 4, true));
            if (!resource) return;
            // Clamped against the chain that actually exists rather than
            // trusted: the guest clamps too, but a texture recreated at a
            // different level count between the two would otherwise leave a
            // lodMinClamp above lodMaxClamp, which WebGPU rejects outright.
            const levels = Math.max(1, resource.levelCount || 1);
            resource.lod = Math.min(view.getUint32(offset + 8, true) >>> 0,
                levels - 1);
        }

        // IDirect3DDevice9::SetGammaRamp. D3D9 applies this at scanout, after
        // everything the renderer did, so it is applied here in the step that
        // moves the finished back buffer onto the canvas -- see the present
        // path in finishFrame(), which swaps its plain copy for a lookup pass
        // whenever a non-identity ramp is set.
        //
        // Held as a 256x1 rgba32float lookup rather than as a curve fit: a
        // D3D9 ramp is an arbitrary table, and titles do use it for effects
        // (fades, damage flashes) that no gamma exponent can express.
        // ---- additional swap chains ----
        //
        // An additional chain targets a *different* HWND, so it needs its own
        // drawing surface: the implicit chain's canvas is the one the page
        // composites over the device window and nothing else.
        //
        // The chain's back buffer arrives as an ordinary render-target texture
        // handle, which is what keeps every other path unchanged -- draws,
        // StretchRect and readback all treat it as a texture. It becomes
        // special only here, in the step that moves the finished image onto
        // its canvas.
        //
        // The canvas itself has to come from the embedder, because only the
        // page knows where a second overlay may live in the document. Without
        // that hook the chain is refused and named rather than quietly
        // rendering nowhere.
        onCreateSwapChain(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            if (!state) return;
            const handle = view.getUint32(offset + 4, true);
            const backBufferHandle = view.getUint32(offset + 8, true);
            const surface = {
                hwnd: view.getUint32(offset + 12, true),
                x: view.getInt32(offset + 16, true),
                y: view.getInt32(offset + 20, true),
                width: view.getUint32(offset + 24, true),
                height: view.getUint32(offset + 28, true),
                swapChain: handle,
                sessionKey: state.surface ? state.surface.sessionKey : null,
                visible: true,
            };
            const create = this.options.createSwapChainCanvas;
            if (typeof create !== "function") {
                ++this.stats.swapChainsRefused;
                this.warnOnce("additional-swap-chain",
                    "the guest created an additional swap chain, but this " +
                    "embedder supplies no createSwapChainCanvas hook, so " +
                    "there is no second surface to present it on; its frames " +
                    "are counted and dropped");
                state.swapChains.set(handle, { handle, backBufferHandle,
                    surface, canvas: null, context: null });
                return;
            }
            let canvas = null;
            try {
                canvas = create(surface);
            } catch (error) {
                this.warnOnce("additional-swap-chain-canvas",
                    "createSwapChainCanvas threw; the chain has no surface to " +
                    "present on", { message: String(error) });
            }
            let context = null;
            if (canvas) {
                canvas.width = Math.max(1, surface.width);
                canvas.height = Math.max(1, surface.height);
                context = canvas.getContext("webgpu");
                if (context) {
                    context.configure({
                        device: this.device, format: this.format,
                        alphaMode: "opaque",
                        usage: TEXTURE_USAGE_RENDER_ATTACHMENT |
                            TEXTURE_USAGE_COPY_DST,
                    });
                }
            }
            state.swapChains.set(handle,
                { handle, backBufferHandle, surface, canvas, context });
            ++this.stats.swapChainsCreated;
            this.notifySwapChainSurface(surface, "create");
        }

        onDestroySwapChain(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            if (!state) return;
            const handle = view.getUint32(offset + 4, true);
            const chain = state.swapChains.get(handle);
            if (!chain) return;
            state.swapChains.delete(handle);
            if (chain.context && typeof chain.context.unconfigure === "function")
                chain.context.unconfigure();
            this.notifySwapChainSurface(
                { ...chain.surface, visible: false }, "destroy");
            ++this.stats.swapChainsDestroyed;
        }

        onPresentSwapChain(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            if (!state) return;
            const handle = view.getUint32(offset + 4, true);
            const chain = state.swapChains.get(handle);
            if (!chain) {
                ++this.stats.swapChainPresentsDropped;
                return;
            }
            const width = view.getUint32(offset + 16, true);
            const height = view.getUint32(offset + 20, true);
            chain.surface = {
                ...chain.surface,
                hwnd: view.getUint32(offset + 8, true),
                x: view.getInt32(offset + 12, true),
                // An empty client rect means the guest could not find the
                // window; the last non-empty size is the better answer, for
                // the same reason the implicit chain keeps its own.
                width: width || chain.surface.width,
                height: height || chain.surface.height,
                visible: true,
            };
            this.notifySwapChainSurface(chain.surface, "present");
            if (!chain.context) {
                ++this.stats.swapChainPresentsDropped;
                return;
            }
            const texture = this.resources.get(chain.backBufferHandle);
            if (!texture || !texture.gpuTexture) {
                ++this.stats.swapChainPresentsDropped;
                return;
            }
            if (chain.canvas) {
                if (chain.canvas.width !== texture.width)
                    chain.canvas.width = texture.width;
                if (chain.canvas.height !== texture.height)
                    chain.canvas.height = texture.height;
            }
            // Queued into the frame op list rather than run here, for the same
            // reason draws are: the chain's current texture is only valid
            // inside the task that acquires it, and a guest frame arrives
            // across several PCI submits.
            const frame = this.ensureFrame();
            frame.ops.push({
                kind: "present-swap-chain",
                chain,
                sourceView: this.blitSourceView(texture, 0, 0),
                sourceFormat: texture.gpuFormat ||
                    formatToGPU(texture.format),
                width: texture.width,
                height: texture.height,
            });
            texture.frameReferenced = frame.serial;
            ++this.stats.swapChainPresents;
        }

        notifySwapChainSurface(surface, reason) {
            if (typeof this.options.onSwapChainSurface === "function")
                this.options.onSwapChainSurface(surface, reason);
        }

        onSetGammaRamp(bytes, view, offset, length) {
            const state = this.deviceState(view.getUint32(offset, true));
            if (!state) return;
            if (length < 16 + 768 * 2) {
                ++this.stats.malformedCommands;
                return;
            }
            const values = new Float32Array(256 * 4);
            let identity = true;
            for (let index = 0; index < 256; ++index) {
                for (let channel = 0; channel < 3; ++channel) {
                    const raw = view.getUint16(
                        offset + 16 + (channel * 256 + index) * 2, true);
                    values[index * 4 + channel] = raw / 65535;
                    // The identity ramp is entry = index * 257 (0x0000, 0x0101,
                    // ... 0xffff). Recognising it matters: a title that sets the
                    // identity ramp on startup would otherwise pay for a lookup
                    // pass on every frame for no visible difference.
                    if (raw !== index * 257) identity = false;
                }
                values[index * 4 + 3] = 1;
            }
            state.gammaRampIdentity = identity;
            // Counted for every accepted ramp, identity included: "the title
            // never called SetGammaRamp" and "the title set the identity ramp"
            // are different facts, and a counter that only moved for the second
            // kind could not tell them apart.
            ++this.stats.gammaRampUpdates;
            if (identity) {
                this.retireGPUObject(state.gammaRampTexture);
                state.gammaRampTexture = null;
                state.gammaRampView = null;
                return;
            }
            if (!state.gammaRampTexture) {
                state.gammaRampTexture = this.device.createTexture({
                    label: "D3D9 gamma ramp",
                    size: { width: 256, height: 1, depthOrArrayLayers: 1 },
                    format: "rgba32float",
                    usage: TEXTURE_USAGE_TEXTURE_BINDING |
                        TEXTURE_USAGE_COPY_DST,
                });
                state.gammaRampView = state.gammaRampTexture.createView();
            }
            this.device.queue.writeTexture({ texture: state.gammaRampTexture },
                values, { bytesPerRow: 256 * 16 },
                { width: 256, height: 1, depthOrArrayLayers: 1 });
        }

        // Which device's ramp the canvas should show. A page runs one D3D9
        // device at a time in practice, but the state table is keyed by handle
        // and nothing guarantees a single entry, so this picks the first device
        // that actually has a non-identity ramp rather than assuming there is
        // exactly one.
        presentGammaView() {
            for (const state of this.devices.values()) {
                if (state && state.gammaRampView) return state.gammaRampView;
            }
            return null;
        }

        // The present-time lookup pass. Separate from blitPipelineFor() because
        // it binds a third resource the ordinary blit has no slot for, and
        // because textureLoad -- not textureSample -- is what makes the lookup
        // exact: a ramp entry is chosen by index, never interpolated between
        // two neighbours.
        gammaBlitPipelineFor(format) {
            if (!this.gammaBlitPipelines) this.gammaBlitPipelines = new Map();
            let entry = this.gammaBlitPipelines.get(format);
            if (entry) return entry;
            const module = this.moduleFor(`@group(0) @binding(0) var d9_gamma_source: texture_2d<f32>;
@group(0) @binding(1) var d9_gamma_sampler: sampler;
@group(0) @binding(2) var d9_gamma_ramp: texture_2d<f32>;

struct D9GammaOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn d9_vs_main(@builtin(vertex_index) index: u32) -> D9GammaOutput {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
    let corner = corners[index];
    var result: D9GammaOutput;
    result.position = vec4<f32>(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0,
        0.0, 1.0);
    result.uv = corner;
    return result;
}

@fragment
fn d9_ps_main(stage_in: D9GammaOutput) -> @location(0) vec4<f32> {
    let source = textureSample(d9_gamma_source, d9_gamma_sampler, stage_in.uv);
    // Each channel indexes the table independently -- D3D9's ramp is three
    // separate curves, and titles do set them apart (a red damage flash is
    // exactly that).
    let index = vec3<i32>(clamp(source.rgb, vec3<f32>(0.0), vec3<f32>(1.0))
        * 255.0 + vec3<f32>(0.5));
    return vec4<f32>(
        textureLoad(d9_gamma_ramp, vec2<i32>(index.r, 0), 0).r,
        textureLoad(d9_gamma_ramp, vec2<i32>(index.g, 0), 0).g,
        textureLoad(d9_gamma_ramp, vec2<i32>(index.b, 0), 0).b,
        source.a);
}
`, "d3d9 gamma blit " + format);
            const bindGroupLayout = this.device.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: SHADER_STAGE_FRAGMENT,
                      texture: { sampleType: "float" } },
                    { binding: 1, visibility: SHADER_STAGE_FRAGMENT,
                      sampler: { type: "filtering" } },
                    // The ramp is read with textureLoad, which is defined for
                    // an unfilterable-float binding and needs no sampler.
                    { binding: 2, visibility: SHADER_STAGE_FRAGMENT,
                      texture: { sampleType: "unfilterable-float" } },
                ],
            });
            entry = {
                pipeline: this.device.createRenderPipeline({
                    label: "D3D9 gamma blit " + format,
                    layout: this.device.createPipelineLayout(
                        { bindGroupLayouts: [bindGroupLayout] }),
                    vertex: { module, entryPoint: "d9_vs_main" },
                    fragment: { module, entryPoint: "d9_ps_main",
                        targets: [{ format }] },
                    primitive: { topology: "triangle-list" },
                }),
                bindGroupLayout,
                sampler: this.device.createSampler({
                    magFilter: "nearest", minFilter: "nearest",
                    addressModeU: "clamp-to-edge",
                    addressModeV: "clamp-to-edge",
                }),
            };
            this.gammaBlitPipelines.set(format, entry);
            return entry;
        }

        onSetPalette(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const index = view.getUint32(offset + 4, true);
            const entryCount = view.getUint32(offset + 8, true);
            const dataOffset = view.getUint32(offset + 12, true);
            if (entryCount !== 256) return;
            const source = new Uint8Array(bytes.buffer,
                bytes.byteOffset + dataOffset, 256 * 4);
            // The wire carries D3DCOLOR (A8R8G8B8, little-endian BGRA bytes);
            // the expansion wants RGBA in memory order.
            const rgba = new Uint8Array(256 * 4);
            for (let entry = 0; entry < 256; ++entry) {
                const at = entry * 4;
                rgba[at] = source[at + 2];
                rgba[at + 1] = source[at + 1];
                rgba[at + 2] = source[at];
                rgba[at + 3] = source[at + 3];
            }
            if (!this.palettes) this.palettes = new Map();
            this.palettes.set(deviceHandle + ":" + index, rgba);
            ++this.stats.palettesSet;
            const state = this.devices.get(deviceHandle);
            if (state && state.currentPalette === index)
                this.repaintPalettizedTextures(deviceHandle);
        }

        onSetCurrentTexturePalette(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const index = view.getUint32(offset + 4, true);
            const state = this.deviceState(deviceHandle);
            if (state.currentPalette === index) return;
            state.currentPalette = index;
            ++this.stats.paletteSelections;
            this.repaintPalettizedTextures(deviceHandle);
        }

        onSetDepthStencilSurfaceLevel(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            const handle = view.getUint32(offset + 4, true);
            const level = view.getUint32(offset + 8, true);
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
                        colors.push({ view: null, format,
                            swapchain: true,
                            sampleCount: state.sampleCount || 1 });
                        width = this.backBufferWidthOf(state);
                        height = this.backBufferHeightOf(state);
                        key += "bb" + (format === this.format ? "" : "s") + ";";
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
                colors.push({ view: targetView,
                    format: srgb ? resource.srgbFormat : resourceFormat,
                    swapchain: false,
                    sampleCount: resource.sampleCount || 1,
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
            if (!colors.length) return null;

            // Depth: an explicitly bound surface wins, then the device's auto
            // depth-stencil, and SetDepthStencilSurface(NULL) means neither.
            let depthView = null;
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
            // drawing into it -- to agree on the sample count, so slot 0 sets
            // it and a disagreeing slot is named rather than left to fail
            // pipeline creation with nothing pointing at the cause.
            const sampleCount = colors[0].sampleCount || 1;
            for (let index = 1; index < colors.length; ++index) {
                if ((colors[index].sampleCount || 1) === sampleCount) continue;
                this.warnOnce("mrt-sample-count",
                    "the render target slots disagree about multisampling; " +
                    "WebGPU needs one sample count for the whole pass, so " +
                    "slot 0's is used", {
                        slot0: sampleCount,
                        slot: index,
                        slotSampleCount: colors[index].sampleCount || 1,
                    });
                break;
            }
            return { key: key + "x" + sampleCount, colors, depthView, width,
                height, substituteDepth,
                hasDepth: !!depthView, sampleCount,
                formats: colors.map(color => color.format) };
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
            const state = this.deviceState(view.getUint32(offset, true));
            const sourceHandle = view.getUint32(offset + 4, true);
            const sourceLevel = view.getUint32(offset + 8, true);
            const sourceRect = {
                left: view.getInt32(offset + 12, true),
                top: view.getInt32(offset + 16, true),
                right: view.getInt32(offset + 20, true),
                bottom: view.getInt32(offset + 24, true),
            };
            const destinationHandle = view.getUint32(offset + 28, true);
            const destinationLevel = view.getUint32(offset + 32, true);
            const destinationRect = {
                left: view.getInt32(offset + 36, true),
                top: view.getInt32(offset + 40, true),
                right: view.getInt32(offset + 44, true),
                bottom: view.getInt32(offset + 48, true),
            };
            const filterPoint = view.getUint32(offset + 52, true) !== 0;
            // Protocol 1.4. Length-gated: a 1.3 payload has no faces, and a
            // 2D surface is always face 0 anyway.
            const sourceFace = length >= 64
                ? view.getUint32(offset + 56, true) : 0;
            const destinationFace = length >= 64
                ? view.getUint32(offset + 60, true) : 0;

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
                frame.ops.push({ kind: "copy",
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
                sourceView: source
                    ? this.blitSourceView(source, sourceLevel, sourceFace) : null,
                destinationView: destination
                    ? this.targetViewFor(destination, destinationLevel, false,
                        destinationFace) : null,
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
            frame.ops.push(op);
            if (source) source.frameReferenced = frame.serial;
            if (destination) destination.frameReferenced = frame.serial;
            this.markTextureSubresourceWritten(destination, destinationLevel,
                destinationFace);
            ++this.stats.blits;
            if (swapchainInvolved) ++this.stats.blitsThroughBackBuffer;
        }

        // A sampled view of one mip level, cached on the resource.
        blitSourceView(resource, level, face) {
            if (!resource.blitViews) resource.blitViews = new Map();
            const baseArrayLayer = face || 0;
            const key = level + ":" + baseArrayLayer;
            let cached = resource.blitViews.get(key);
            if (!cached) {
                cached = resource.gpuTexture.createView({
                    dimension: "2d", baseMipLevel: level, mipLevelCount: 1,
                    baseArrayLayer, arrayLayerCount: 1,
                });
                resource.blitViews.set(key, cached);
            }
            return cached;
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

        // One attachment view per (level, face, srgb). A cube map is a
        // six-layer 2D texture here, so rendering into one face is exactly
        // selecting one array layer -- which is why the layer has to reach this
        // far rather than being resolved at bind time: an attachment view names
        // a single subresource, and "the cube" is not one.
        targetViewFor(resource, level, srgb, layer) {
            if (!resource.targetViews) resource.targetViews = new Map();
            const baseArrayLayer = layer || 0;
            const key = level + ":" + baseArrayLayer + (srgb ? "s" : "");
            let cached = resource.targetViews.get(key);
            if (!cached) {
                cached = resource.gpuTexture.createView({
                    baseMipLevel: level, mipLevelCount: 1, dimension: "2d",
                    baseArrayLayer, arrayLayerCount: 1,
                    ...(srgb ? { format: resource.srgbFormat } : {}),
                });
                resource.targetViews.set(key, cached);
            }
            return cached;
        }

        // One pipeline per destination format. The quad is generated from the
        // vertex index, so a blit needs no vertex buffer at all.
        blitPipelineFor(format, filterPoint, sourceFormat) {
            // WebGPU exposes filtering and blending for 32-bit float formats
            // as independent optional features.  A D3D point blit remains
            // legal without float32-filterable, but its binding layout and
            // sampler must explicitly be non-filtering.
            const unfilterable = isFloat32GPUFormat(sourceFormat) &&
                !this.deviceFeatures.float32Filterable;
            const point = filterPoint || unfilterable;
            const key = format + "|" + (point ? "point" : "linear") + "|" +
                (unfilterable ? "unfilterable" : "filterable");
            if (!this.blitPipelines) this.blitPipelines = new Map();
            let entry = this.blitPipelines.get(key);
            if (entry) return entry;
            const module = this.moduleFor(`struct D9BlitUniforms {
    source_rect: vec4<f32>,
};
@group(0) @binding(0) var<uniform> blit: D9BlitUniforms;
@group(0) @binding(1) var d9_blit_source: texture_2d<f32>;
@group(0) @binding(2) var d9_blit_sampler: sampler;

struct D9BlitOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn d9_vs_main(@builtin(vertex_index) index: u32) -> D9BlitOutput {
    // Two triangles covering the whole viewport; setViewport restricts the
    // output to the destination rect, so no destination maths is needed here.
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
    let corner = corners[index];
    var result: D9BlitOutput;
    result.position = vec4<f32>(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0,
        0.0, 1.0);
    result.uv = blit.source_rect.xy + corner * blit.source_rect.zw;
    return result;
}

@fragment
fn d9_ps_main(stage_in: D9BlitOutput) -> @location(0) vec4<f32> {
    return textureSample(d9_blit_source, d9_blit_sampler, stage_in.uv);
}
`, "d3d9 blit " + key);
            const bindGroupLayout = this.device.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: SHADER_STAGE_VERTEX,
                      buffer: { type: "uniform" } },
                    { binding: 1, visibility: SHADER_STAGE_FRAGMENT,
                      texture: { sampleType: unfilterable
                          ? "unfilterable-float" : "float" } },
                    { binding: 2, visibility: SHADER_STAGE_FRAGMENT,
                      sampler: { type: unfilterable
                          ? "non-filtering" : "filtering" } },
                ],
            });
            const pipeline = this.device.createRenderPipeline({
                label: "D3D9 blit " + key,
                layout: this.device.createPipelineLayout(
                    { bindGroupLayouts: [bindGroupLayout] }),
                vertex: { module, entryPoint: "d9_vs_main" },
                fragment: { module, entryPoint: "d9_ps_main",
                    targets: [{ format }] },
                primitive: { topology: "triangle-list" },
            });
            const sampler = this.device.createSampler({
                magFilter: point ? "nearest" : "linear",
                minFilter: point ? "nearest" : "linear",
                addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
            });
            entry = { pipeline, bindGroupLayout, sampler };
            this.blitPipelines.set(key, entry);
            return entry;
        }

        // Runs a recorded blit op inside finishFrame, where the swap chain view
        // exists. `swapView` substitutes for a null source/destination view.
        replayBlit(encoder, op, swapView) {
            const sourceView = op.sourceView || swapView;
            const destinationView = op.destinationView || swapView;
            if (!sourceView || !destinationView) return null;
            const entry = this.blitPipelineFor(op.destinationFormat,
                op.filterPoint, op.sourceFormat);
            const uniform = this.device.createBuffer({
                size: 16,
                usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
            });
            this.device.queue.writeBuffer(uniform, 0,
                new Float32Array(op.sourceRect));
            const bindGroup = this.device.createBindGroup({
                layout: entry.bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: uniform } },
                    { binding: 1, resource: sourceView },
                    { binding: 2, resource: entry.sampler },
                ],
            });
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
            return uniform;
        }

        rectClearPipelineFor(targets, clearsColor, clearsDepth, clearsStencil) {
            // The key has to describe the *pass* this pipeline will be used
            // in, not just what the clear writes. WebGPU requires a pipeline's
            // attachment state -- colour formats, whether there is a
            // depth-stencil attachment, and the sample count -- to match the
            // pass exactly. Keying on the clear flags alone let a pipeline
            // built for a depth-less pass be reused in a pass that has depth,
            // which fails validation at setPipeline and invalidates the whole
            // command buffer, so the frame draws nothing. 3DMark 2001 hits
            // this the moment one pass drops depth (an undersized depth
            // surface does that) and the next one has it.
            const key = [targets.formats.join(","), clearsColor ? "c" : "-",
                clearsDepth ? "d" : "-", clearsStencil ? "s" : "-",
                targets.hasDepth ? "z" : "-",
                targets.sampleCount || 1].join("|");
            if (!this.rectClearPipelines) this.rectClearPipelines = new Map();
            let entry = this.rectClearPipelines.get(key);
            if (entry) return entry;
            const colorFields = targets.formats.map((_, index) =>
                "    @location(" + index + ") color" + index + ": vec4<f32>,");
            const colorWrites = targets.formats.map((_, index) =>
                "    result.color" + index + " = clear.color;");
            const depthField = clearsDepth
                ? "    @builtin(frag_depth) depth: f32," : "";
            const depthWrite = clearsDepth
                ? "    result.depth = clear.depth.x;" : "";
            const module = this.moduleFor(`struct D9RectClearUniforms {
    color: vec4<f32>,
    depth: vec4<f32>,
};
@group(0) @binding(0) var<uniform> clear: D9RectClearUniforms;

struct D9RectClearOutput {
${colorFields.join("\n")}
${depthField}
};

@vertex
fn d9_vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    return vec4<f32>(positions[index], 0.0, 1.0);
}

@fragment
fn d9_ps_main() -> D9RectClearOutput {
    var result: D9RectClearOutput;
${colorWrites.join("\n")}
${depthWrite}
    return result;
}
`, "d3d9 rectangle clear " + key);
            const bindGroupLayout = this.device.createBindGroupLayout({
                entries: [{ binding: 0, visibility: SHADER_STAGE_FRAGMENT,
                    buffer: { type: "uniform" } }],
            });
            const descriptor = {
                label: "D3D9 rectangle clear " + key,
                layout: this.device.createPipelineLayout(
                    { bindGroupLayouts: [bindGroupLayout] }),
                vertex: { module, entryPoint: "d9_vs_main" },
                fragment: { module, entryPoint: "d9_ps_main",
                    targets: targets.formats.map(format => ({ format,
                        writeMask: clearsColor ? 0xF : 0 })) },
                primitive: { topology: "triangle-list" },
            };
            if (targets.hasDepth) {
                const stencil = clearsStencil ? { compare: "always",
                    failOp: "keep", depthFailOp: "keep", passOp: "replace" } : {};
                descriptor.depthStencil = { format: DEPTH_FORMAT,
                    depthWriteEnabled: clearsDepth, depthCompare: "always",
                    stencilFront: stencil, stencilBack: stencil,
                    stencilReadMask: clearsStencil ? 0xff : 0,
                    stencilWriteMask: clearsStencil ? 0xff : 0 };
            }
            if ((targets.sampleCount || 1) > 1)
                descriptor.multisample = { count: targets.sampleCount };
            entry = { pipeline: this.device.createRenderPipeline(descriptor),
                bindGroupLayout };
            this.rectClearPipelines.set(key, entry);
            return entry;
        }

        replayRectClear(encoder, op, swapView, swapSrgbView) {
            const entry = this.rectClearPipelineFor(op.targets, op.clearsColor,
                op.clearsDepth, op.clearsStencil);
            const uniform = this.device.createBuffer({ size: 32,
                usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST });
            this.device.queue.writeBuffer(uniform, 0, new Float32Array([
                op.color.r, op.color.g, op.color.b, op.color.a,
                op.depth, 0, 0, 0,
            ]));
            const bindGroup = this.device.createBindGroup({
                layout: entry.bindGroupLayout,
                entries: [{ binding: 0, resource: { buffer: uniform } }],
            });
            const descriptor = {
                colorAttachments: op.targets.colors.map(color => ({
                    view: color.swapchain
                        ? (color.format === this.swapchainSrgbFormat
                            ? swapSrgbView : swapView)
                        : color.view,
                    loadOp: "load", storeOp: "store",
                })),
            };
            if (op.targets.depthView) descriptor.depthStencilAttachment = {
                view: op.targets.depthView,
                depthLoadOp: "load", depthStoreOp: "store",
                stencilLoadOp: "load", stencilStoreOp: "store",
            };
            const pass = encoder.beginRenderPass(descriptor);
            ++this.stats.renderPasses;
            pass.setPipeline(entry.pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.setStencilReference(op.stencil & 0xff);
            for (const rect of op.rects) {
                pass.setViewport(rect.left, rect.top, rect.right - rect.left,
                    rect.bottom - rect.top, 0, 1);
                pass.draw(3);
            }
            pass.end();
            return uniform;
        }

        colorFillPipelineFor(format) {
            if (!this.colorFillPipelines) this.colorFillPipelines = new Map();
            let entry = this.colorFillPipelines.get(format);
            if (entry) return entry;
            const module = this.moduleFor(`struct D9ColorFillUniforms {
    color: vec4<f32>,
};
@group(0) @binding(0) var<uniform> fill: D9ColorFillUniforms;

@vertex
fn d9_vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    return vec4<f32>(positions[index], 0.0, 1.0);
}

@fragment
fn d9_ps_main() -> @location(0) vec4<f32> {
    return fill.color;
}
`, "d3d9 ColorFill " + format);
            const bindGroupLayout = this.device.createBindGroupLayout({
                entries: [{ binding: 0, visibility: SHADER_STAGE_FRAGMENT,
                    buffer: { type: "uniform" } }],
            });
            const pipeline = this.device.createRenderPipeline({
                label: "D3D9 ColorFill " + format,
                layout: this.device.createPipelineLayout(
                    { bindGroupLayouts: [bindGroupLayout] }),
                vertex: { module, entryPoint: "d9_vs_main" },
                fragment: { module, entryPoint: "d9_ps_main",
                    targets: [{ format }] },
                primitive: { topology: "triangle-list" },
            });
            entry = { pipeline, bindGroupLayout };
            this.colorFillPipelines.set(format, entry);
            return entry;
        }

        replayColorFill(encoder, op) {
            const pass = encoder.beginRenderPass({ colorAttachments: [{
                view: op.targetView, loadOp: op.isFull ? "clear" : "load",
                storeOp: "store", ...(op.isFull ? { clearValue: {
                    r: op.rgba[0], g: op.rgba[1], b: op.rgba[2], a: op.rgba[3],
                } } : {}),
            }] });
            ++this.stats.renderPasses;
            let transient = null;
            if (!op.isFull) {
                const entry = this.colorFillPipelineFor(op.format);
                transient = this.device.createBuffer({ size: 16,
                    usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST });
                this.device.queue.writeBuffer(transient, 0,
                    new Float32Array(op.rgba));
                const bindGroup = this.device.createBindGroup({
                    layout: entry.bindGroupLayout,
                    entries: [{ binding: 0, resource: { buffer: transient } }],
                });
                pass.setPipeline(entry.pipeline);
                pass.setBindGroup(0, bindGroup);
                pass.setViewport(op.left, op.top, op.right - op.left,
                    op.bottom - op.top, 0, 1);
                pass.draw(3);
            }
            pass.end();
            return transient;
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
            const severity = view.getUint32(offset, true);
            const textBytes = view.getUint32(offset + 4, true);
            if (8 + textBytes > length) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG guest log text overruns the command");
            }
            let text = "";
            for (let index = 0; index < textBytes; ++index)
                text += String.fromCharCode(bytes[offset + 8 + index]);
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
            const resource = this.resources.get(view.getUint32(offset + 4, true));
            const level = view.getUint32(offset + 8, true);
            const color = view.getUint32(offset + 12, true);
            const face = length >= 40 ? view.getUint32(offset + 32, true) : 0;
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
            const left = view.getInt32(offset + 16, true);
            const top = view.getInt32(offset + 20, true);
            const right = view.getInt32(offset + 24, true);
            const bottom = view.getInt32(offset + 28, true);
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
                ((color >>> 24) & 0xff) / 255];
            const isFull = clippedLeft === 0 && clippedTop === 0 &&
                clippedRight === fullWidth && clippedBottom === fullHeight;
            const frame = this.ensureFrame();
            frame.ops.push({ kind: "color-fill", targetView,
                format: formatToGPU(resource.format), rgba, isFull,
                left: clippedLeft, top: clippedTop,
                right: clippedRight, bottom: clippedBottom });
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
            const texCoordSets = [];
            for (const element of elements) {
                if (element.usage === DECLUSAGE_BLENDWEIGHT &&
                        element.usageIndex === 0)
                    blendWeightType = element.type;
                else if (element.usage === DECLUSAGE_BLENDINDICES &&
                        element.usageIndex === 0)
                    blendIndicesType = element.type;
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
                        !texCoordSets.includes(element.usageIndex))
                    texCoordSets.push(element.usageIndex);
            }
            if (!positionType) return null;
            texCoordSets.sort((a, b) => a - b);
            // The blend element *types* travel with the signature because the
            // WGSL input for BLENDINDICES has to be declared with the base type
            // of whatever WebGPU format the declaration's D3DDECLTYPE maps to;
            // whether they are read at all is a render-state question that
            // vertexBlendPlan() answers once the state is in hand.
            return { positionType, hasColor, colorIsBGRA, hasColor1,
                color1IsBGRA, hasNormal, hasPointSize, texCoordSets,
                blendWeightType, blendIndicesType,
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
                // Vertex tweening interpolates two *streams* by
                // D3DRS_TWEENFACTOR rather than blending matrices; nothing here
                // implements it, and fill_caps() does not claim
                // D3DVTXPCAPS_TWEENING.
                this.warnOnce("ff-vertex-tweening",
                    "D3DVBF_TWEENING is not implemented; the draw is posed by " +
                    "world matrix 0 alone");
                return null;
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
                    lodBias: lodBiasFor(samplerState(index,
                        D3DSAMP_MIPMAPLODBIAS, 0)),
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
                const readsArg0 = op =>
                    op === D3DTOP_MULTIPLYADD || op === D3DTOP_LERP;
                const argumentsUsed = [stage.colorArg1, stage.colorArg2];
                if (stage.alphaOp !== D3DTOP_DISABLE)
                    argumentsUsed.push(stage.alphaArg1, stage.alphaArg2);
                if (readsArg0(stage.colorOp)) argumentsUsed.push(stage.colorArg0);
                if (readsArg0(stage.alphaOp)) argumentsUsed.push(stage.alphaArg0);
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
                if (stage.samplesTexture) {
                    const texture = this.resources.get(state.textures.get(index));
                    // A depth texture counts as nothing bound here. The fixed
                    // function cascade has no comparison reference to offer, so
                    // it takes the white fallback and viewForStage() reports
                    // why -- rather than reaching a float layout entry with a
                    // depth view, which is invalid rather than merely wrong.
                    const usable = texture && !texture.isDepth;
                    stage.textureType = usable ? (texture.textureType || "2d") : "2d";
                    stage.hasTextureBound = !!usable;
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
                if (!stream || !stream.stride) continue;
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

        onCreateVertexDeclaration(bytes, view, offset, length) {
            const handle = view.getUint32(offset + 4, true);
            const count = view.getUint32(offset + 8, true);
            const elements = this.decodeVertexElements(bytes, view, offset + 16, count);
            this.resources.set(handle,
                { kind: RESOURCE_VERTEX_DECLARATION, elements });
        }

        onSetVertexDeclaration(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const declarationHandle = view.getUint32(offset + 4, true);
            const state = this.deviceState(deviceHandle);
            state.vertexDeclarationHandle = declarationHandle;
            state.fvfElements = null;
        }

        onSetFVF(bytes, view, offset, length) {
            const deviceHandle = view.getUint32(offset, true);
            const count = view.getUint32(offset + 8, true);
            const state = this.deviceState(deviceHandle);
            state.fvfElements = this.decodeVertexElements(bytes, view, offset + 16, count);
            // Kept only so a diagnostic can say which FVF produced a
            // declaration; nothing in the render path reads it, because the
            // guest already expanded it into the element shape above.
            state.fvf = view.getUint32(offset + 4, true);
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
            const deviceHandle = view.getUint32(offset, true);
            const stateId = view.getUint32(offset + 4, true);
            const value = view.getUint32(offset + 8, true);
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
            const deviceHandle = view.getUint32(offset, true);
            const stage = view.getUint32(offset + 4, true);
            const stateId = view.getUint32(offset + 8, true);
            const value = view.getUint32(offset + 12, true);
            this.deviceState(deviceHandle).textureStageStates.set(stage * 64 + stateId, value);
        }

        onSetTexture(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const stage = view.getUint32(offset + 4, true);
            const textureHandle = view.getUint32(offset + 8, true);
            this.deviceState(deviceHandle).textures.set(stage, textureHandle);
        }

        // Stored to keep host state honest with the guest's D9WGSetSamplerState/
        // D9WGSetMaterial/D9WGSetLight/D9WGLightEnable emitters (d3d9_proxy.c),
        // but not yet read anywhere in pipelineFor()/recordDraw() -- M1's fixed
        // shader always uses one hardcoded default sampler and never applies
        // lighting math. Real consumption is M2 (sampler variants, 4.4/12) and
        // M2/M3 (lighting) work.
        onSetSamplerState(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const sampler = view.getUint32(offset + 4, true);
            const stateId = view.getUint32(offset + 8, true);
            this.noteUnreadState("samplerState", CONSUMED_SAMPLER_STATES, stateId);
            const value = view.getUint32(offset + 12, true);
            this.deviceState(deviceHandle).samplerStates.set(sampler * 64 + stateId, value);
        }

        onSetMaterial(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const readVec4 = base => [
                view.getFloat32(base, true), view.getFloat32(base + 4, true),
                view.getFloat32(base + 8, true), view.getFloat32(base + 12, true),
            ];
            this.deviceState(deviceHandle).material = {
                diffuse: readVec4(offset + 4), ambient: readVec4(offset + 20),
                specular: readVec4(offset + 36), emissive: readVec4(offset + 52),
                power: view.getFloat32(offset + 68, true),
            };
        }

        onSetLight(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const index = view.getUint32(offset + 4, true);
            const readVec = (base, count) => {
                const out = [];
                for (let i = 0; i < count; ++i) out.push(view.getFloat32(base + i * 4, true));
                return out;
            };
            this.deviceState(deviceHandle).lights.set(index, {
                type: view.getUint32(offset + 8, true),
                diffuse: readVec(offset + 12, 4), specular: readVec(offset + 28, 4),
                ambient: readVec(offset + 44, 4), position: readVec(offset + 60, 3),
                direction: readVec(offset + 72, 3), range: view.getFloat32(offset + 84, true),
                falloff: view.getFloat32(offset + 88, true),
                attenuation: readVec(offset + 92, 3),
                theta: view.getFloat32(offset + 104, true), phi: view.getFloat32(offset + 108, true),
            });
        }

        onLightEnable(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const index = view.getUint32(offset + 4, true);
            const enable = view.getUint32(offset + 8, true) !== 0;
            this.deviceState(deviceHandle).lightEnabled.set(index, enable);
        }

        onSetViewport(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const state = this.deviceState(deviceHandle);
            // MinZ/MaxZ have been on the wire since M1 (D9WGSetViewport) and
            // used to be dropped here, with recordDraw hardcoding 0..1 into
            // setViewport. D3D9's viewport depth range is not decoration: an app
            // that composites a 3D object into a 2D panel routinely restricts it
            // so the object cannot collide in depth with the interface around
            // it, and discarding that puts the object at its natural depth --
            // where whatever the app expected to be in front of it no longer is.
            const minZ = view.getFloat32(offset + 20, true);
            const maxZ = view.getFloat32(offset + 24, true);
            state.viewport = {
                x: view.getUint32(offset + 4, true),
                y: view.getUint32(offset + 8, true),
                width: view.getUint32(offset + 12, true),
                height: view.getUint32(offset + 16, true),
                // A device that never calls SetViewport, and any guest that
                // sends zeros, still has to mean the D3D9 default range.
                minZ: Number.isFinite(minZ) ? minZ : 0,
                maxZ: Number.isFinite(maxZ) && maxZ !== 0 ? maxZ : 1,
            };
        }

        onSetTransform(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const transformState = view.getUint32(offset + 4, true);
            const matrix = new Float32Array(16);
            for (let i = 0; i < 16; ++i) matrix[i] = view.getFloat32(offset + 8 + i * 4, true);
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
            if (length < 24) return;
            const state = this.deviceState(view.getUint32(offset, true));
            const index = view.getUint32(offset + 4, true);
            if (index >= 6) return;
            state.clipPlanes[index] = [
                view.getFloat32(offset + 8, true),
                view.getFloat32(offset + 12, true),
                view.getFloat32(offset + 16, true),
                view.getFloat32(offset + 20, true),
            ];
        }

        onSetStreamSource(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const stream = view.getUint32(offset + 4, true);
            const bufferHandle = view.getUint32(offset + 8, true);
            const stride = view.getUint32(offset + 12, true);
            const offsetInBytes = view.getUint32(offset + 16, true);
            const state = this.deviceState(deviceHandle);
            const previous = state.streams.get(stream);
            state.streams.set(stream, { bufferHandle, stride, offsetInBytes,
                frequency: previous ? (previous.frequency ?? 1) : 1 });
        }

        onSetStreamSourceFreq(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const stream = view.getUint32(offset + 4, true);
            const frequency = view.getUint32(offset + 8, true);
            const state = this.deviceState(deviceHandle);
            const previous = state.streams.get(stream) || {
                bufferHandle: 0, stride: 0, offsetInBytes: 0,
            };
            state.streams.set(stream, { ...previous, frequency });
        }

        onSetIndices(bytes, view, offset) {
            const deviceHandle = view.getUint32(offset, true);
            const bufferHandle = view.getUint32(offset + 4, true);
            this.deviceState(deviceHandle).indexBufferHandle = bufferHandle;
        }

        // ---- programmable shaders (M2) ----

        // Translation happens here, at CREATE time, and never on a draw path
        // (plan 4.2): a shader first used mid-frame would otherwise produce an
        // unattributable latency spike. A shader this build cannot translate
        // is stored with its error rather than dropped -- recordDraw() then
        // skips draws that bind it and counts them, which is the difference
        // between "this shader is unsupported" and "the game stopped drawing".
        async onCreateShader(bytes, view, offset, kind) {
            const handle = view.getUint32(offset + 4, true);
            const tokenCount = view.getUint32(offset + 8, true);
            const codeOffset = view.getUint32(offset + 12, true);
            const suppliedHashLow = view.getUint32(offset + 16, true);
            const suppliedHashHigh = view.getUint32(offset + 20, true);
            if (codeOffset + tokenCount * 4 > bytes.byteLength) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG shader bytecode overruns the batch");
            }
            // The DMA blob is not 4-byte aligned within `bytes` in general,
            // so copy rather than aliasing a Uint32Array onto it.
            const tokens = new Uint32Array(tokenCount);
            for (let i = 0; i < tokenCount; ++i)
                tokens[i] = view.getUint32(codeOffset + i * 4, true);
            // Hashes are a cache hint carried by an untrusted guest. Verify
            // them from the bytecode so an old or buggy proxy cannot alias
            // every shader to the same cached translation (the original D3D8
            // proxy sent zero for both fields).
            const verifiedHash = shaderPipeline.hashTokens(tokens);
            const hashLow = verifiedHash.low;
            const hashHigh = verifiedHash.high;
            if (hashLow !== suppliedHashLow || hashHigh !== suppliedHashHigh) {
                this.warnOnce("shader-hash-mismatch-" + kind,
                    "guest shader bytecode hash did not match its token " +
                    "stream; using the verified hash to prevent distinct " +
                    "shaders from aliasing in the translation cache", {
                        kind: kind === RESOURCE_VERTEX_SHADER
                            ? "vertex" : "pixel",
                        suppliedHashLow,
                        suppliedHashHigh,
                        verifiedHashLow: hashLow,
                        verifiedHashHigh: hashHigh,
                    });
            }
            const compilesBefore = this.shaderCache.stats.compiles;
            let translated = this.shaderCache.get(hashLow, hashHigh);
            if (!translated) {
                const started = typeof performance !== "undefined" && performance.now
                    ? performance.now() : Date.now();
                const workerCompile = this.compileShaderInWorker(tokens);
                if (workerCompile) {
                    try {
                        translated = await workerCompile;
                        if (!translated || typeof translated.ok !== "boolean")
                            throw new Error("shader worker returned an invalid result");
                        ++this.stats.shaderWorkerCompiles;
                        const ended = typeof performance !== "undefined" && performance.now
                            ? performance.now() : Date.now();
                        translated = this.shaderCache.store(hashLow, hashHigh,
                            translated, ended - started);
                    } catch (error) {
                        ++this.stats.shaderWorkerFallbacks;
                        this.warnOnce("shader-worker-runtime",
                            "shader compile Worker failed; falling back to the " +
                            "executor thread", { message: String(error) });
                        translated = this.shaderCache.compile(tokens,
                            hashLow, hashHigh);
                    }
                } else {
                    translated = this.shaderCache.compile(tokens,
                        hashLow, hashHigh);
                }
            }
            if (this.shaderCache.stats.compiles !== compilesBefore)
                this.shaderCacheDirty = true;
            if (translated.ok) ++this.stats.shadersTranslated;
            else {
                ++this.stats.shaderTranslationFailures;
                this.warnOnce("shader-translate-" + hashHigh + "-" + hashLow,
                    "cannot translate a " + (kind === RESOURCE_VERTEX_SHADER
                        ? "vertex" : "pixel") + " shader; draws that bind it " +
                    "will be skipped: " + translated.error);
            }
            this.resources.set(handle, {
                kind, tokens, hashLow, hashHigh,
                translated,
                // Variant key -> {translated, module}. A vertex shader needs
                // one variant per set of D3DCOLOR input locations; in practice
                // that is a single entry, because a given shader is used with
                // one vertex format.
                variants: new Map(),
            });
        }

        onCreateVertexShader(bytes, view, offset) {
            return this.onCreateShader(bytes, view, offset, RESOURCE_VERTEX_SHADER);
        }

        onCreatePixelShader(bytes, view, offset) {
            return this.onCreateShader(bytes, view, offset, RESOURCE_PIXEL_SHADER);
        }

        onSetVertexShader(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            state.vertexShaderHandle = view.getUint32(offset + 4, true);
        }

        onSetPixelShader(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            state.pixelShaderHandle = view.getUint32(offset + 4, true);
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
            const state = this.deviceState(view.getUint32(offset, true));
            this.applyConstants(bytes, view, offset, state.vsConstF, 4,
                at => view.getFloat32(at, true));
        }

        onSetPixelShaderConstantF(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            this.applyConstants(bytes, view, offset, state.psConstF, 4,
                at => view.getFloat32(at, true));
        }

        onSetVertexShaderConstantI(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            this.applyConstants(bytes, view, offset, state.vsConstI, 4,
                at => view.getInt32(at, true));
        }

        onSetPixelShaderConstantI(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            this.applyConstants(bytes, view, offset, state.psConstI, 4,
                at => view.getInt32(at, true));
        }

        onSetVertexShaderConstantB(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            this.applyConstants(bytes, view, offset, state.vsConstB, 1,
                at => view.getUint32(at, true));
        }

        onSetPixelShaderConstantB(bytes, view, offset) {
            const state = this.deviceState(view.getUint32(offset, true));
            this.applyConstants(bytes, view, offset, state.psConstB, 1,
                at => view.getUint32(at, true));
        }

        // ---- D3D9 hardware cursor ----
        //
        // A fullscreen D3D9 game draws its pointer through SetCursorProperties
        // rather than GDI, so it never reaches the VGA framebuffer the page
        // composites under this canvas -- and the page hides the browser
        // cursor. Without this the pointer is invisible even though input
        // still works, which makes the game effectively unplayable.
        onSetCursorProperties(bytes, view, offset) {
            const width = view.getUint32(offset + 12, true);
            const height = view.getUint32(offset + 16, true);
            const dataBytes = view.getUint32(offset + 20, true);
            const dataOffset = view.getUint32(offset + 24, true);
            if (!width || !height) return;
            if (dataOffset + dataBytes > bytes.byteLength) {
                ++this.stats.malformedBatches;
                throw new D9WGStreamError("D9WG cursor bitmap overruns the batch");
            }
            this.cursor.hotspotX = view.getUint32(offset + 4, true);
            this.cursor.hotspotY = view.getUint32(offset + 8, true);
            if (this.cursor.width !== width || this.cursor.height !== height ||
                    !this.cursor.texture) {
                this.retireGPUObject(this.cursor.texture);
                this.cursor.texture = this.device.createTexture({
                    label: "D3D9 hardware cursor",
                    size: { width, height, depthOrArrayLayers: 1 },
                    format: "rgba8unorm",
                    usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
                });
                this.cursor.view = this.cursor.texture.createView();
                this.cursor.width = width;
                this.cursor.height = height;
            }
            // The guest sends A8R8G8B8 at a tight width*4 stride; the same
            // BGRA-to-RGBA reorder every other texture upload does.
            const source = new Uint8Array(bytes.buffer,
                bytes.byteOffset + dataOffset, dataBytes);
            const rgba = new Uint8Array(width * height * 4);
            for (let row = 0; row < height; ++row)
                expandRowToGPU(D3DFMT_A8R8G8B8, source, row * width * 4,
                    width, rgba, row * width * 4);
            this.device.queue.writeTexture({ texture: this.cursor.texture },
                rgba, { bytesPerRow: width * 4, rowsPerImage: height },
                { width, height, depthOrArrayLayers: 1 });
            ++this.stats.cursorUploads;
        }

        onSetCursorPosition(bytes, view, offset) {
            this.cursor.x = view.getInt32(offset + 4, true);
            this.cursor.y = view.getInt32(offset + 8, true);
        }

        onShowCursor(bytes, view, offset) {
            this.cursor.visible = view.getUint32(offset + 4, true) !== 0;
        }

        // Moves the overlay to match a WINDOW_STATE report.
        //
        // Deliberately conservative about what counts as a real move. The
        // report also arrives for foreground changes and other events that say
        // nothing about geometry, and a 0x0 client area is the same
        // fullscreen GetClientRect artefact onPresent() already guards
        // against -- letting either through makes the canvas flicker between
        // the real size and nothing.
        //
        // Covered windows are not hidden ones. Other windows lying over all
        // or part of the device window (occluded, visibleRegion) is state the
        // surface keeps until the next report changes it -- a Present in
        // between does not uncover anything -- and the embedder shows the
        // picture only where the guest's screen shows the window.
        applyWindowStateGeometry(deviceHandle, report) {
            if (!deviceHandle) return;
            const state = this.devices.get(deviceHandle);
            if (!state) return;
            const hidden = !report.isWindow || report.iconic || !report.visible;
            if (hidden) {
                // Visibility is tracked per device; the canvas is one shared
                // thing. Those disagree the moment anything else puts the
                // canvas back on screen -- a CreateDevice for the same
                // session does exactly that -- and this device's own flag
                // still reads false from an earlier report. Skipping the
                // notification as redundant then drops the one message that
                // would have taken the canvas down.
                //
                // A no-surface report is a teardown signal rather than a
                // geometry update, so it is never redundant: it is the last
                // thing an exiting process says, and if it is dropped its
                // final frame stays composited over the guest's desktop with
                // nothing left running to remove it.
                if (state.surface.visible === false && !report.noSurface)
                    return;
                if (report.noSurface) {
                    state.ddScreenWriteRect = null;
                    state.surface = { ...state.surface, clipRect: null };
                }
                state.surface = { ...state.surface, visible: false,
                    noSurface: !!report.noSurface };
                ++this.stats.surfaceChanges;
                this.notifySurface(state, "window-state");
                return;
            }
            const width = report.clientWidth || state.surface.width;
            const height = report.clientHeight || state.surface.height;
            if (!width || !height) {
                ++this.stats.emptySurfaceReports;
                return;
            }
            const occluded = !!report.occluded;
            const visibleRegion = report.visibleRegion || null;
            const changed = state.surface.hwnd !== report.hwnd ||
                state.surface.x !== report.windowX ||
                state.surface.y !== report.windowY ||
                state.surface.width !== width ||
                state.surface.height !== height ||
                state.surface.visible === false ||
                !!state.surface.occluded !== occluded ||
                !sameVisibleRegion(state.surface.visibleRegion || null, visibleRegion);
            if (!changed) return;
            state.surface = { ...state.surface, hwnd: report.hwnd,
                x: report.windowX, y: report.windowY, width, height,
                visible: true, noSurface: false, occluded, visibleRegion };
            ++this.stats.surfaceChanges;
            this.notifySurface(state, "window-state");
        }

        // Two jobs. The diagnostic one is why the opcode exists: see
        // D9WG_OP_WINDOW_STATE in d3d9_protocol.h for why the guest's
        // window-manager view has to be reported rather than inferred.
        //
        // The second is placement, and it exists for the D3D8 frontend. A
        // D3D9 title presents continuously, so onPresent() is a fine source of
        // truth for where the overlay goes. A D3D8 title need not: one that
        // draws a single frame and then only pumps messages still has to have
        // the overlay follow its window, and there is no further Present to
        // carry the geometry. d3d8_proxy.c sends this record on move/size/show
        // for exactly that reason.
        onWindowState(bytes, view, offset, length) {
            const flags = view.getUint32(offset + 12, true);
            const deviceHandle = view.getUint32(offset, true);
            const state = {
                hwnd: view.getUint32(offset + 4, true),
                foregroundHwnd: view.getUint32(offset + 8, true),
                isWindow: (flags & D9WG_WINDOW_IS_WINDOW) !== 0,
                visible: (flags & D9WG_WINDOW_VISIBLE) !== 0,
                iconic: (flags & D9WG_WINDOW_ICONIC) !== 0,
                foreground: (flags & D9WG_WINDOW_FOREGROUND) !== 0,
                fullscreen: (flags & D9WG_WINDOW_FULLSCREEN) !== 0,
                windowX: view.getInt32(offset + 16, true),
                windowY: view.getInt32(offset + 20, true),
                windowWidth: view.getUint32(offset + 24, true),
                windowHeight: view.getUint32(offset + 28, true),
                clientWidth: view.getUint32(offset + 32, true),
                clientHeight: view.getUint32(offset + 36, true),
                // "I have nothing to show", which is not the same claim as
                // "my window is gone": the window may be up and taking input.
                noSurface: (flags & D9WG_WINDOW_NO_SURFACE) !== 0,
                occluded: (flags & D9WG_WINDOW_OCCLUDED) !== 0,
                visibleRegion: null,
            };
            if (flags & D9WG_WINDOW_REGION) {
                state.visibleRegion = readVisibleRegion(view, offset + D9WG_WINDOW_STATE_BYTES,
                    (length === undefined ? D9WG_WINDOW_STATE_BYTES : length) - D9WG_WINDOW_STATE_BYTES,
                    state.clientWidth, state.clientHeight, state.windowX, state.windowY);
                if (state.visibleRegion) ++this.stats.windowRegionReports;
            }
            this.windowState = state;
            ++this.stats.windowStateChanges;
            this.applyWindowStateGeometry(deviceHandle, state);
            // A device that says it has nothing to present is not describing a
            // window problem, and the two diagnostics below are about window
            // problems: they would report broken input for a title that is
            // simply done drawing.
            if (state.noSurface) return;
            // Covered by another of the guest's windows, which then rightly
            // has the foreground and the input: not a window problem either
            if (state.occluded) {
                ++this.stats.windowOccludedReports;
                return;
            }
            if (!state.foreground) {
                ++this.stats.windowNotForegroundReports;
                // The guest re-takes the foreground for a fullscreen device
                // (maintain_fullscreen_foreground in d3d9_proxy.c), so a single
                // report of this at startup is normal and self-healing. Repeated
                // reports mean the claim is being refused, which is worth saying
                // out loud: the picture looks perfect either way and every click
                // goes somewhere else, so there is nothing on screen to notice.
                if (this.stats.windowNotForegroundReports > 1)
                    this.warnOnce("window-not-foreground",
                        "the game's window keeps losing the guest's foreground " +
                        "even though the guest re-claims it, so clicks go to " +
                        "whatever is on top -- the overlay still shows this " +
                        "game's frames either way. Check getStats().window",
                        state);
            }
            if (state.iconic || !state.visible)
                this.warnOnce("window-not-visible",
                    "the game's window is minimised or hidden in the guest; " +
                    "input will not reach it", state);
        }

        // A self-contained screen-space quad, built once. It deliberately does
        // not go through programFor()/pipelineFor(): the cursor is host-owned
        // compositing, not a guest draw, and giving it its own trivial
        // pipeline keeps it out of the caches keyed on guest state.
        ensureCursorPipeline() {
            if (this.cursor.pipeline) return this.cursor.pipeline;
            const module = this.device.createShaderModule({
                label: "D3D9 cursor",
                code: `
struct CursorRect { origin: vec2<f32>, size: vec2<f32> };
@group(0) @binding(0) var<uniform> rect: CursorRect;
@group(0) @binding(1) var cursor_texture: texture_2d<f32>;
@group(0) @binding(2) var cursor_sampler: sampler;

struct VSOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VSOut {
    // Two triangles covering the cursor's rectangle, in normalised
    // back-buffer space supplied by the uniform.
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
    let corner = corners[index];
    let position = rect.origin + corner * rect.size;
    var out: VSOut;
    out.position = vec4<f32>(position.x * 2.0 - 1.0,
        1.0 - position.y * 2.0, 0.0, 1.0);
    out.uv = corner;
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    return textureSample(cursor_texture, cursor_sampler, in.uv);
}
`,
            });
            const bindGroupLayout = this.device.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: "uniform" } },
                    { binding: 1, visibility: SHADER_STAGE_FRAGMENT, texture: {} },
                    { binding: 2, visibility: SHADER_STAGE_FRAGMENT, sampler: {} },
                ],
            });
            this.cursor.bindGroupLayout = bindGroupLayout;
            this.cursor.sampler = this.device.createSampler({
                magFilter: "nearest", minFilter: "nearest",
                addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
            });
            this.cursor.uniform = this.device.createBuffer({
                label: "D3D9 cursor rect", size: 16,
                usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
            });
            this.cursor.pipeline = this.device.createRenderPipeline({
                layout: this.device.createPipelineLayout(
                    { bindGroupLayouts: [bindGroupLayout] }),
                vertex: { module, entryPoint: "vs_main" },
                fragment: { module, entryPoint: "fs_main", targets: [{
                    format: this.format,
                    // Straight alpha: a cursor bitmap's transparent texels
                    // must not paint over the frame.
                    blend: {
                        color: { srcFactor: "src-alpha",
                                 dstFactor: "one-minus-src-alpha", operation: "add" },
                        alpha: { srcFactor: "one",
                                 dstFactor: "one-minus-src-alpha", operation: "add" },
                    },
                }] },
                primitive: { topology: "triangle-list" },
            });
            return this.cursor.pipeline;
        }

        // Drawn last, in its own depth-less pass, so it sits on top of the
        // frame regardless of what the game left in the depth buffer.
        drawCursor(encoder, targetView, width, height) {
            const cursor = this.cursor;
            if (!cursor.visible || !cursor.view || !width || !height) return;
            const pipeline = this.ensureCursorPipeline();
            const originX = (cursor.x - cursor.hotspotX) / width;
            const originY = (cursor.y - cursor.hotspotY) / height;
            this.device.queue.writeBuffer(cursor.uniform, 0, new Float32Array([
                originX, originY, cursor.width / width, cursor.height / height,
            ]));
            const bindGroup = this.device.createBindGroup({
                layout: cursor.bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: cursor.uniform } },
                    { binding: 1, resource: cursor.view },
                    { binding: 2, resource: cursor.sampler },
                ],
            });
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view: targetView, loadOp: "load", storeOp: "store" }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(6);
            pass.end();
            ++this.stats.cursorDraws;
        }

        // GPUShaderModules are content-addressed by their WGSL text, so two
        // shaders that translate identically (or the same shader re-created
        // after a Reset) share one module. Compilation diagnostics are checked
        // asynchronously -- createShaderModule() never throws on bad WGSL, and
        // plan 9.6 requires the getCompilationInfo() check rather than
        // assuming successful translation implies valid output.
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

        // ---- draw pipeline ----

        // Distils the render states a WebGPU render pipeline is allowed to
        // depend on into a small plain object. WebGPU bakes depth/blend/cull
        // into the immutable pipeline (unlike D3D9, where they are free-
        // floating device state), so this is also exactly the set that has
        // to participate in the pipeline cache key.
        pipelineStateFor(state, targets) {
            const rs = state.renderStates;
            const hasDepth = targets ? targets.hasDepth : !!state.hasDepth;
            const forceSolid = !!this.debug.forceSolidAllDraws;
            const get = (id, fallback) => {
                const value = rs.get(id);
                return value === undefined ? fallback : value;
            };

            // D3DRS_ZENABLE defaults to on whenever a depth buffer exists;
            // with no depth attachment there is nothing to test against.
            const depthEnabled = !forceSolid && hasDepth
                && get(D3DRS_ZENABLE, 1) !== D3DZB_FALSE;
            const depthWrite = !forceSolid &&
                get(D3DRS_ZWRITEENABLE, 1) !== 0;
            const depthCompare = (forceSolid || this.debug.disableDepthTest)
                ? "always"
                : (COMPARE_FUNCS[get(D3DRS_ZFUNC, 4)] || "less-equal");

            const blendEnabled = !forceSolid &&
                get(D3DRS_ALPHABLENDENABLE, 0) !== 0;
            const resolveBlend = (rawSrc, rawDst) => {
                // The legacy BOTH* source values override both halves of the
                // pair. D3D9 exposes them as one enum; WebGPU exposes the two
                // factors separately, so the mapping is exact once resolved.
                if (rawSrc === 12)
                    return { src: "src-alpha", dst: "one-minus-src-alpha",
                        valid: true };
                if (rawSrc === 13)
                    return { src: "one-minus-src-alpha", dst: "src-alpha",
                        valid: true };
                return { src: BLEND_FACTORS[rawSrc], dst: BLEND_FACTORS[rawDst],
                    valid: !!BLEND_FACTORS[rawSrc] && !!BLEND_FACTORS[rawDst] };
            };
            // D3D9 starts at ONE/ZERO.  Using SRCALPHA/INVSRCALPHA here was
            // mostly hidden while blending stayed disabled, but it changes an
            // app that enables blending before choosing new factors from an
            // overwrite into a translucent UI/overlay pass.
            const rawColorSrc = get(D3DRS_SRCBLEND, 2);
            const rawColorDst = get(D3DRS_DESTBLEND, 1);
            const rawColorOp = get(D3DRS_BLENDOP, 1);
            const colorBlend = resolveBlend(rawColorSrc, rawColorDst);
            const separateAlpha =
                get(D3DRS_SEPARATEALPHABLENDENABLE, 0) !== 0;
            const rawAlphaSrc = separateAlpha
                ? get(D3DRS_SRCBLENDALPHA, 2) : rawColorSrc;
            const rawAlphaDst = separateAlpha
                ? get(D3DRS_DESTBLENDALPHA, 1) : rawColorDst;
            const rawAlphaOp = separateAlpha
                ? get(D3DRS_BLENDOPALPHA, 1) : rawColorOp;
            const alphaBlend = separateAlpha
                ? resolveBlend(rawAlphaSrc, rawAlphaDst) : colorBlend;
            const srcFactor = colorBlend.src || "src-alpha";
            const dstFactor = colorBlend.dst || "one-minus-src-alpha";
            const blendOp = BLEND_OPS[rawColorOp] || "add";
            const alphaSrcFactor = alphaBlend.src || "one";
            const alphaDstFactor = alphaBlend.dst || "zero";
            const alphaBlendOp = BLEND_OPS[rawAlphaOp] || "add";
            if (blendEnabled && (!colorBlend.valid || !alphaBlend.valid ||
                    !BLEND_OPS[rawColorOp] || !BLEND_OPS[rawAlphaOp])) {
                ++this.stats.drawsWithUnmappedBlend;
                this.warnOnce("unmapped-blend-" + [rawColorSrc, rawColorDst,
                    rawColorOp, rawAlphaSrc, rawAlphaDst, rawAlphaOp].join("-"),
                    "a draw asks for a blend mode with no WebGPU equivalent; " +
                    "it silently falls back to src-alpha/inv-src-alpha, which " +
                    "renders as plausible-but-wrong compositing", {
                        D3DRS_SRCBLEND: rawColorSrc, mappedSrc: colorBlend.src,
                        D3DRS_DESTBLEND: rawColorDst, mappedDst: colorBlend.dst,
                        D3DRS_BLENDOP: rawColorOp, mappedOp: BLEND_OPS[rawColorOp],
                    });
            }
            const blendColor = get(D3DRS_BLENDFACTOR, 0xffffffff) >>> 0;
            const blendConstant = {
                r: ((blendColor >>> 16) & 0xff) / 255,
                g: ((blendColor >>> 8) & 0xff) / 255,
                b: (blendColor & 0xff) / 255,
                a: ((blendColor >>> 24) & 0xff) / 255,
            };

            // D3D9 stores both bias states as float bit patterns in DWORDs.
            // Its constant bias is in normalised depth units; depth24 WebGPU
            // expresses the same offset in one-ULP integer steps.
            const rawDepthBias = floatFromDWORD(get(D3DRS_DEPTHBIAS, 0));
            const scaledDepthBias = Number.isFinite(rawDepthBias)
                ? Math.round(rawDepthBias * 0x1000000) : 0;
            const depthBias = Math.max(-0x80000000,
                Math.min(0x7fffffff, scaledDepthBias));
            const rawSlopeBias = floatFromDWORD(
                get(D3DRS_SLOPESCALEDEPTHBIAS, 0));
            const depthBiasSlopeScale = Number.isFinite(rawSlopeBias)
                ? rawSlopeBias : 0;

            const stencilEnabled = !forceSolid && hasDepth &&
                get(D3DRS_STENCILENABLE, 0) !== 0;
            const stencilFace = (failId, depthFailId, passId, funcId) => ({
                compare: COMPARE_FUNCS[get(funcId, 8)] || "always",
                failOp: STENCIL_OPS[get(failId, 1)] || "keep",
                depthFailOp: STENCIL_OPS[get(depthFailId, 1)] || "keep",
                passOp: STENCIL_OPS[get(passId, 1)] || "keep",
            });
            const stencilFront = stencilFace(D3DRS_STENCILFAIL,
                D3DRS_STENCILZFAIL, D3DRS_STENCILPASS, D3DRS_STENCILFUNC);
            const stencilBack = get(D3DRS_TWOSIDEDSTENCILMODE, 0) !== 0
                ? stencilFace(D3DRS_CCW_STENCILFAIL, D3DRS_CCW_STENCILZFAIL,
                    D3DRS_CCW_STENCILPASS, D3DRS_CCW_STENCILFUNC)
                : stencilFront;

            // D3D9's front face is clockwise, so D3DCULL_CW means "cull the
            // front" and D3DCULL_CCW (its default) means "cull the back".
            const cullValue = get(D3DRS_CULLMODE, D3DCULL_CCW);
            let cullMode = "none";
            if (!forceSolid && !this.debug.disableCull) {
                if (cullValue === D3DCULL_CW) cullMode = "front";
                else if (cullValue === D3DCULL_CCW) cullMode = "back";
            }

            // D3DCOLORWRITEENABLE's RED/GREEN/BLUE/ALPHA bits happen to be
            // 1/2/4/8, matching GPUColorWrite exactly.
            const writeMask = forceSolid ? 0xF
                : get(D3DRS_COLORWRITEENABLE, 0xF) & 0xF;
            const extraWriteMasks = forceSolid ? [0xF, 0xF, 0xF] : [
                    get(D3DRS_COLORWRITEENABLE1, 0xF) & 0xF,
                    get(D3DRS_COLORWRITEENABLE2, 0xF) & 0xF,
                    get(D3DRS_COLORWRITEENABLE3, 0xF) & 0xF,
                ];

            // Alpha test is a shader construct here, not pipeline state, so
            // it travels with the rest of the immutable state and lands in
            // the fragment key rather than in the GPURenderPipeline itself.
            const alphaTest = {
                enabled: !forceSolid &&
                    get(D3DRS_ALPHATESTENABLE, 0) !== 0,
                func: get(D3DRS_ALPHAFUNC, 8) & 0xF,
                reference: get(D3DRS_ALPHAREF, 0) & 0xFF,
            };

            const sampleCount = (targets && targets.sampleCount) || 1;
            return { depthEnabled, depthWrite, depthCompare, depthBias,
                depthBiasSlopeScale, blendEnabled, srcFactor, dstFactor,
                blendOp, alphaSrcFactor, alphaDstFactor, alphaBlendOp,
                blendConstant, cullMode, writeMask, alphaTest, hasDepth,
                stencilEnabled, stencilFront, stencilBack,
                stencilReadMask: get(D3DRS_STENCILMASK, 0xffffffff) >>> 0,
                stencilWriteMask: get(D3DRS_STENCILWRITEMASK, 0xffffffff) >>> 0,
                stencilReference: get(D3DRS_STENCILREF, 0) >>> 0,
                extraWriteMasks,
                // Every colour attachment of the pass this pipeline runs in has
                // to appear in its fragment targets, in order -- WebGPU matches
                // them positionally, so an MRT pass needs the whole list baked
                // into the pipeline and therefore into its cache key.
                colorFormats: targets ? targets.formats : [this.format],
                // WebGPU takes the sample count on the pipeline as well as on
                // the attachments, and the two must agree; without this the
                // pipeline defaulted to 1 and every draw into a multisampled
                // target failed validation.
                sampleCount,
                // D3DRS_MULTISAMPLEMASK maps straight onto WebGPU's
                // multisample mask. D3DRS_MULTISAMPLEANTIALIAS turning
                // antialiasing off for one draw has no WebGPU equivalent --
                // the sample count is fixed for the whole pass -- so it is
                // approximated by writing sample 0 only, which is what
                // "no antialiasing" means for the pixels this draw covers.
                sampleMask: sampleCount > 1
                    ? (get(D3DRS_MULTISAMPLEANTIALIAS, 1) !== 0
                        ? (get(D3DRS_MULTISAMPLEMASK, 0xffffffff) >>> 0)
                        : 1)
                    : 0xffffffff,
                // Only meaningful on a multisampled target -- with one sample
                // there is no coverage to spread an alpha value over, and
                // WebGPU rejects the combination outright.
                alphaToCoverage: sampleCount > 1 &&
                    (get(D3DRS_ADAPTIVETESS_Y, 0) >>> 0) === D3DFOURCC_ATOC };
        }

        // ---- independent sampler state (plan 4.4/12) ----
        //
        // D3D9 splits sampling parameters out of texture-stage state into
        // SetSamplerState, which maps almost one-to-one onto an immutable
        // GPUSampler. M1 recorded these values but sampled every texture with
        // one hardcoded linear/repeat sampler created alongside the texture;
        // they now drive a cache keyed by the parameter tuple, so a stage's
        // sampler follows the app's state rather than the texture it happens
        // to be bound to.
        samplerFor(state, stage, unfilterable, texture) {
            const get = (id, fallback) => {
                const value = state.samplerStates.get(stage * 64 + id);
                return value === undefined ? fallback : value;
            };
            // D3D9 defaults: WRAP addressing, POINT min/mag, no mip filtering.
            const addressU = get(D3DSAMP_ADDRESSU, 1);
            const addressV = get(D3DSAMP_ADDRESSV, 1);
            const addressW = get(D3DSAMP_ADDRESSW, 1);
            const requestedMipFilter = get(D3DSAMP_MIPFILTER, 0);
            const magFilter = unfilterable ? 1 : get(D3DSAMP_MAGFILTER, 1);
            const minFilter = unfilterable ? 1 : get(D3DSAMP_MINFILTER, 1);
            const mipFilter = unfilterable && requestedMipFilter !== 0
                ? 1 : requestedMipFilter;
            let maxAnisotropy = get(D3DSAMP_MAXANISOTROPY, 1) | 0;
            if (unfilterable) maxAnisotropy = 1;
            // Two independent floors on the mip chain, and D3D9 applies the
            // more restrictive: D3DSAMP_MAXMIPLEVEL is sampler state and
            // applies to whatever is bound here, while SetLOD travels with the
            // texture. Both are level indices; WebGPU spells the same thing as
            // a LOD clamp. Clamped against the chain that exists so a stale
            // value cannot produce lodMinClamp > lodMaxClamp, which WebGPU
            // rejects outright.
            const levels = Math.max(1, (texture && texture.levelCount) || 1);
            const lodFloor = Math.min(levels - 1,
                Math.max(get(D3DSAMP_MAXMIPLEVEL, 0) >>> 0,
                    (texture && texture.lod) || 0));
            const key = [addressU, addressV, addressW, magFilter, minFilter,
                mipFilter, maxAnisotropy, lodFloor,
                this.debug.forceMipLevel0 ? "top" : "",
                unfilterable ? "non-filtering" : "filtering"].join(",");
            const cached = this.samplerCache.get(key);
            if (cached) { ++this.stats.samplerHits; return cached; }

            const descriptor = {
                addressModeU: ADDRESS_MODES[addressU] || "repeat",
                addressModeV: ADDRESS_MODES[addressV] || "repeat",
                addressModeW: ADDRESS_MODES[addressW] || "repeat",
                magFilter: FILTER_MODES[magFilter] || "nearest",
                minFilter: FILTER_MODES[minFilter] || "nearest",
                // D3DTEXF_NONE means "use only the top mip level", which is
                // what clamping the LOD range to 0 expresses in WebGPU.
                mipmapFilter: mipFilter === 2 ? "linear" : "nearest",
            };
            if (this.debug.forceMipLevel0) {
                descriptor.lodMinClamp = 0;
                descriptor.lodMaxClamp = 0;
            } else if (mipFilter === 0) {
                // D3DTEXF_NONE means "sample one level and do not blend
                // between levels". That level is the most detailed one still
                // allowed, which is the floor -- not level 0, once
                // D3DSAMP_MAXMIPLEVEL or SetLOD has raised it.
                descriptor.lodMinClamp = lodFloor;
                descriptor.lodMaxClamp = lodFloor;
            } else if (lodFloor > 0) {
                descriptor.lodMinClamp = lodFloor;
            }
            // WebGPU only accepts maxAnisotropy > 1 when all three filters are
            // linear, so anisotropy is dropped rather than forcing filters the
            // app did not ask for.
            if (!unfilterable && maxAnisotropy > 1 &&
                    descriptor.magFilter === "linear" &&
                    descriptor.minFilter === "linear" &&
                    descriptor.mipmapFilter === "linear" && mipFilter !== 0)
                descriptor.maxAnisotropy = Math.min(16, maxAnisotropy);
            if (addressU === 4 || addressV === 4 || addressW === 4)
                this.warnOnce("address-border", "D3DTADDRESS_BORDER has no " +
                    "native WebGPU sampler mode; the physical sample clamps " +
                    "to edge and the fixed-function fragment shader replaces " +
                    "out-of-domain coordinates with D3DSAMP_BORDERCOLOR");
            const sampler = this.device.createSampler(descriptor);
            ++this.stats.samplersCreated;
            this.samplerCache.set(key, sampler);
            return sampler;
        }

        // ---- program resolution ----

        // Resolves the two stages into GPUShaderModules plus everything the
        // pipeline and bind group need. Returns {error} instead of throwing
        // for anything the caller should turn into a counted skipped draw.
        programFor(state, elements, pipelineState, drawOptions) {
            drawOptions = drawOptions || {};
            const alphaTest = pipelineState.alphaTest;
            const alphaTestKey = alphaTest.enabled
                ? "_a" + alphaTest.func + "_" + alphaTest.reference : "";
            const rs = state.renderStates;
            const clipMask = (rs.get(D3DRS_CLIPPLANEENABLE) || 0) & 0x3f;
            const clipPlaneCount = clipMask
                ? 32 - Math.clz32(clipMask) : 0;
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
            const pretransformed = elements.some(element =>
                element.usage === DECLUSAGE_POSITIONT && element.usageIndex === 0);
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

            // Table fog (D3DRS_FOGTABLEMODE) takes precedence over vertex fog
            // when both are set, which is what D3D9 does. Screen-space XYZRHW
            // geometry is excluded: it has no eye-space depth to fog against.
            let fogMode = 0;
            let tableFog = false;
            if ((rs.get(D3DRS_FOGENABLE) || 0) !== 0 &&
                    (!fixedVertexSignature ||
                     fixedVertexSignature.positionType !== "screen")) {
                const table = rs.get(D3DRS_FOGTABLEMODE) || D3DFOG_NONE;
                tableFog = table !== D3DFOG_NONE;
                fogMode = tableFog ? table
                    : (rs.get(D3DRS_FOGVERTEXMODE) || D3DFOG_NONE);
            }

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
                if (variant.reflection.version.major === 1) {
                    for (const sampler of variant.reflection.samplers) {
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
                // D3DSAMP_MIPMAPLODBIAS is sampler state, but WebGPU has no
                // sampler field for it, so it can only be applied at the sample
                // call -- which puts it in the WGSL and therefore in the variant
                // key. Only the samplers this shader actually declares are
                // considered, so an unrelated stage's stale bias cannot mint a
                // variant.
                const samplerLodBias = {};
                let lodBiasKey = "";
                // D3DTADDRESS_MIRRORONCE is finished in the shader too: the
                // sampler clamps, and abs() on the coordinate supplies the
                // mirror. Same variant-key treatment as the bias.
                const samplerMirrorOnce = {};
                let mirrorOnceKey = "";
                for (const sampler of psResource.translated.reflection.samplers) {
                    const bias = lodBiasFor(state.samplerStates.get(
                        sampler.index * 64 + D3DSAMP_MIPMAPLODBIAS) || 0);
                    if (bias) {
                        samplerLodBias[sampler.index] = bias;
                        lodBiasKey += "_b" + sampler.index + ":" + bias;
                    }
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
                const pixelVariantKey = alphaTestKey + clipKey + depthKey +
                    lodBiasKey + mirrorOnceKey + legacySamplerKey +
                    (flatShading ? "_flat" : "");
                if (alphaTest.enabled || clipPlaneCount || depthSamplers.length
                        || lodBiasKey || mirrorOnceKey || legacySamplerKey ||
                        flatShading) {
                    variant = psResource.variants.get(pixelVariantKey);
                    if (!variant) {
                        variant = shaderPipeline.compileShader(psResource.tokens, {
                            alphaTestDiscard: alphaTestDiscard(alphaTest,
                                "result.color0.a"),
                            clipPlaneCount,
                            depthSamplers,
                            depthFetchSamplers,
                            samplerLodBias,
                            samplerMirrorOnce,
                            legacySamplerTypes,
                            flatShading,
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
                if (fogMode) {
                    ++this.stats.drawsWithUnappliedFog;
                    this.warnOnce("fog-programmable",
                        "fog is enabled on a draw with a translated pixel " +
                        "shader; the fixed-function fog blend is not applied " +
                        "there, so the fragment keeps its untinted colour");
                }
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
                    fogMode, tableFog, alphaTest, clipPlaneCount,
                    // D3D9 adds the specular colour after the cascade whenever
                    // D3DRS_SPECULARENABLE is set, whether it came from lighting
                    // or straight off the vertex.
                    specularEnable: (rs.get(D3DRS_SPECULARENABLE) || 0) !== 0,
                    flatShading,
                };
                fragmentKey = "ffps" + cascade.stages.map(stage =>
                    [stage.index, stage.colorOp, stage.colorArg0, stage.colorArg1,
                     stage.colorArg2, stage.alphaOp, stage.alphaArg0,
                     stage.alphaArg1, stage.alphaArg2, stage.resultArg,
                     stage.samplesTexture ? stage.textureType : "-",
                     stage.coordVarying, stage.projected ? "p" + stage.transformCount : "",
                     stage.samplesTexture
                         ? [stage.addressU, stage.addressV, stage.addressW,
                            stage.borderColor >>> 0].join("b") : "",
                     stage.colorKey
                         ? "k" + (stage.colorKey.indexed ? "i" : "r") +
                            (stage.colorKey.low >>> 0) + ":" +
                            (stage.colorKey.high >>> 0) : "",
                     // Baked into the WGSL as a literal (WebGPU samplers have
                     // no bias field), so two stages differing only in bias are
                     // different shaders and must not share a cache entry.
                     stage.lodBias ? "l" + stage.lodBias : ""
                    ].join(".")).join("|") +
                    (pixelSignature.usesTextureFactor ? "_tf" : "") +
                    (pixelSignature.specularEnable ? "_s" : "") +
                    (flatShading ? "_flat" : "") +
                    alphaTestKey + (fogMode
                        ? (tableFog ? "_ft" : "_fv") + fogMode : "") +
                    clipKey + (debugMode ? "_" + debugMode : "");
                fragmentModule = this.moduleFor(
                    buildFixedFunctionPixelShader(pixelSignature, debugMode),
                    "d3d9 " + fragmentKey);
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
                    const location = inputLocations.get(
                        element.usage * 16 + element.usageIndex);
                    if (location !== undefined && element.type === DECLTYPE_D3DCOLOR)
                        bgra.push(location);
                    if (location === undefined) continue;
                    const conversion = {
                        5: "ubyte4", 6: "short2", 7: "short4",
                        13: "udec3", 14: "dec3n",
                    }[element.type];
                    if (conversion) inputConversions[location] = conversion;
                }
                bgra.sort((a, b) => a - b);
                const conversionKey = Object.keys(inputConversions)
                    .map(Number).sort((a, b) => a - b)
                    .map(location => location + ":" + inputConversions[location])
                    .join(",");
                const pointKey = drawOptions.pointExpansion
                    ? "|p:" + (drawOptions.pointSprite ? "s" : "q") : "";
                const variantKey = "b:" + bgra.join(",") + "|c:" +
                    conversionKey + pointKey + clipKey +
                    (flatShading ? "|flat" : "");
                const needsVariant = bgra.length || conversionKey.length ||
                    !!drawOptions.pointExpansion || !!clipPlaneCount ||
                    flatShading;
                let variant = vsResource.variants.get(variantKey);
                if (!variant) {
                    variant = needsVariant
                        ? shaderPipeline.compileShader(vsResource.tokens,
                            { bgraInputLocations: bgra, inputConversions,
                              pointExpansion: !!drawOptions.pointExpansion,
                              pointSprite: !!drawOptions.pointSprite,
                              clipPlaneCount, flatShading })
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
                signature.coordStages = this.coordStagePlan(state, coordStageCount);
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
                    (signature.fogRange && !!signature.fogMode) ||
                    signature.coordStages.some(stage =>
                        stage.tciMode !== D3DTSS_TCI_PASSTHRU));
                signature.flatShading = flatShading;
                vertexKey = "ffvs_" + signature.positionType +
                    (flatShading ? "_flat" : "") +
                    (signature.hasColor ? (signature.colorIsBGRA ? "_cb" : "_c") : "") +
                    (signature.hasColor1 ? (signature.color1IsBGRA ? "_sb" : "_s") : "") +
                    (signature.hasNormal ? "_n" : "") +
                    (signature.hasPointSize ? "_ps" : "") +
                    (signature.vertexBlend ? "_vb" +
                        signature.vertexBlend.matrixCount +
                        (signature.vertexBlend.indexed
                            ? "i" + signature.vertexBlend.indexScalar +
                              (signature.vertexBlend.indexNormalized ? "n" : "") +
                              "." + signature.vertexBlend.matrixSlots
                            : "") : "") +
                    "_t" + signature.texCoordSets.join(".") +
                    "_x" + signature.coordStages.map(stage =>
                        [stage.index, stage.texCoordIndex, stage.tciMode,
                         stage.transformCount].join(".")).join(",") +
                    (signature.needsViewSpace ? "_v" : "") +
                    (signature.normalizeNormals ? "_nn" : "") +
                    (signature.lighting ? "_l" + signature.lighting.lights
                        .map(light => light.type).join(".") +
                        (signature.lighting.colorVertex ? "cv" : "") +
                        (signature.lighting.specularEnable ? "sp" : "") +
                        (signature.lighting.localViewer ? "lv" : "") +
                        "m" + [signature.lighting.diffuseSource,
                            signature.lighting.ambientSource,
                            signature.lighting.specularSource,
                            signature.lighting.emissiveSource].join("") : "") +
                    (signature.fogMode ? "_f" + signature.fogMode +
                        (signature.fogRange ? "r" : "") : "") +
                    (signature.pointExpansion ? "_point" +
                        (signature.pointSprite ? "s" : "") +
                        (signature.pointScale ? "a" : "") : "");
                vertexModule = this.moduleFor(
                    buildFixedFunctionVertexShader(signature), "d3d9 " + vertexKey);
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
                const diagnostic = {
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
                };
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
            if (vertexReflection && vertexReflection.inputs) {
                const supplied = new Set();
                for (const layout of vertexBuffers)
                    for (const attribute of layout.attributes) supplied.add(attribute.shaderLocation);
                const missing = vertexReflection.inputs.map(input => input.location)
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
            if (!vertexBuffers.length)
                return { error: "no vertex stream supplies any attribute the " +
                    "vertex stage reads" };
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
                    const stage = 256 + sampler.index;
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
        coordStagePlan(state, stageCount) {
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
                    transformCount: flags & 0xFF,
                    projected: (flags & D3DTTFF_PROJECTED) !== 0 });
            }
            return stages;
        }

        pipelineFor(program, pipelineState, topology, stripIndexFormat) {
            const key = program.vertexKey + "|" + program.fragmentKey + "|" +
                JSON.stringify(program.vertexBuffers) + "|" +
                topology + "|" + (stripIndexFormat || "") + "|" +
                JSON.stringify(pipelineState) + "|" +
                program.samplerIndices.map(index => index + ":" +
                    ((program.samplerDimensions &&
                      program.samplerDimensions[index]) || "2d") + ":" +
                    ((program.samplerBindingTypes &&
                      program.samplerBindingTypes[index]) || "filterable"))
                    .join(",") + "|vs:" + (program.vertexSamplers || [])
                    .map(sampler => sampler.index + ":" + sampler.type + ":" +
                        sampler.bindingType).join(",");
            let pipeline = this.pipelineCache.get(key);
            if (pipeline) { ++this.stats.pipelineHits; return pipeline; }

            // Binding 0 is the vertex stage's constant buffer (or the
            // fixed-function transform block, which occupies the same slot),
            // binding 1 the pixel stage's; samplers take 2+2n / 3+2n, the
            // numbering d3d9_shader_pipeline.js emits.
            const bindGroupEntries = [
                { binding: 0, visibility: SHADER_STAGE_VERTEX,
                  buffer: { type: "uniform", hasDynamicOffset: true } },
            ];
            if (program.pixelUniformBytes)
                bindGroupEntries.push({ binding: 1, visibility: SHADER_STAGE_FRAGMENT,
                    buffer: { type: "uniform", hasDynamicOffset: true } });
            for (const index of program.samplerIndices) {
                // The view dimension has to be declared here, not left to
                // default to "2d": WebGPU checks the layout against what the
                // shader declares, so a texture_cube<f32> binding paired with a
                // default 2D layout entry fails pipeline creation outright. naga
                // cannot catch that -- it validates one module, not the pairing.
                const dimension = (program.samplerDimensions &&
                    program.samplerDimensions[index]) || "2d";
                const bindingType = program.samplerBindingTypes &&
                    program.samplerBindingTypes[index];
                const unfilterable = bindingType === "unfilterable";
                const compare = bindingType === "depth-compare";
                const fetch = bindingType === "depth-fetch";
                const depth = compare || fetch;
                // Both depth modes are sampleType "depth"; only the comparison
                // one takes a comparison sampler. A raw fetch reads the stored
                // value through an ordinary non-filtering sampler, because
                // WebGPU will not filter a depth texture without comparing.
                bindGroupEntries.push(
                    { binding: 2 + index * 2, visibility: SHADER_STAGE_FRAGMENT,
                      texture: { viewDimension: depth ? "2d" : dimension,
                          sampleType: depth ? "depth"
                              : (unfilterable ? "unfilterable-float" : "float") } },
                    { binding: 3 + index * 2, visibility: SHADER_STAGE_FRAGMENT,
                      sampler: { type: compare ? "comparison"
                          : ((fetch || unfilterable) ? "non-filtering"
                              : "filtering") } });
            }
            for (const sampler of program.vertexSamplers || []) {
                const unfilterable = sampler.bindingType === "unfilterable";
                bindGroupEntries.push(
                    { binding: sampler.textureBinding,
                      visibility: SHADER_STAGE_VERTEX,
                      texture: { viewDimension: sampler.type,
                          sampleType: unfilterable
                              ? "unfilterable-float" : "float" } },
                    { binding: sampler.samplerBinding,
                      visibility: SHADER_STAGE_VERTEX,
                      sampler: { type: unfilterable
                          ? "non-filtering" : "filtering" } });
            }
            const bindGroupLayout = this.device.createBindGroupLayout(
                { entries: bindGroupEntries });

            // D3DRS_COLORWRITEENABLE1/2/3 mask the extra MRT attachments; slot
            // 0 uses D3DRS_COLORWRITEENABLE. An attachment the fragment shader
            // does not write still needs an entry, or WebGPU rejects the
            // pipeline against the pass.
            const colorTargets = (pipelineState.colorFormats || [this.format])
                .map((format, index) => {
                    const target = { format, writeMask: index === 0
                        ? pipelineState.writeMask
                        : (pipelineState.extraWriteMasks
                            ? pipelineState.extraWriteMasks[index - 1] : 0xF) };
                    if (pipelineState.blendEnabled &&
                            isBlendableGPUFormat(format, this.deviceFeatures)) {
                        target.blend = {
                            color: { srcFactor: pipelineState.srcFactor,
                                     dstFactor: pipelineState.dstFactor,
                                     operation: pipelineState.blendOp },
                            alpha: { srcFactor: pipelineState.alphaSrcFactor,
                                     dstFactor: pipelineState.alphaDstFactor,
                                     operation: pipelineState.alphaBlendOp },
                        };
                    } else if (pipelineState.blendEnabled &&
                            !isBlendableGPUFormat(format, this.deviceFeatures)) {
                        this.warnOnce("float32-blend-disabled-" + format,
                            "D3D blending was requested for a 32-bit float " +
                            "render target, but this WebGPU device does not " +
                            "expose float32-blendable; the draw is emitted " +
                            "without blending instead of creating an invalid " +
                            "render pipeline", { format });
                    }
                    return target;
                });
            const primitive = { topology,
                cullMode: program.pointExpansion ? "none" : pipelineState.cullMode,
                frontFace: "cw" };
            // WebGPU needs to know the restart-index width up front for an
            // indexed strip draw; it must be absent for every other topology.
            if (stripIndexFormat) primitive.stripIndexFormat = stripIndexFormat;
            const descriptor = {
                layout: this.device.createPipelineLayout(
                    { bindGroupLayouts: [bindGroupLayout] }),
                vertex: {
                    module: program.vertexModule, entryPoint: "d9_vs_main",
                    buffers: program.vertexBuffers.map(layout =>
                        ({ arrayStride: layout.arrayStride,
                           stepMode: layout.stepMode || "vertex",
                           attributes: layout.attributes })),
                },
                fragment: { module: program.fragmentModule, entryPoint: "d9_ps_main",
                    targets: colorTargets },
                primitive,
            };
            if (pipelineState.sampleCount > 1) {
                descriptor.multisample = {
                    count: pipelineState.sampleCount,
                    mask: pipelineState.sampleMask,
                    alphaToCoverageEnabled: pipelineState.alphaToCoverage,
                };
            }
            // The pipeline must declare a depthStencil state whenever the
            // pass it runs in has a depth attachment, even for a draw that
            // does no depth testing -- hence depthCompare "always" plus
            // depthWriteEnabled false rather than omitting the block.
            if (pipelineState.hasDepth) {
                descriptor.depthStencil = {
                    format: DEPTH_FORMAT,
                    depthWriteEnabled: pipelineState.depthEnabled
                        ? pipelineState.depthWrite : false,
                    depthCompare: pipelineState.depthEnabled
                        ? pipelineState.depthCompare : "always",
                    depthBias: pipelineState.depthBias,
                    depthBiasSlopeScale: pipelineState.depthBiasSlopeScale,
                    stencilFront: pipelineState.stencilEnabled
                        ? pipelineState.stencilFront : {},
                    stencilBack: pipelineState.stencilEnabled
                        ? pipelineState.stencilBack : {},
                    stencilReadMask: pipelineState.stencilEnabled
                        ? pipelineState.stencilReadMask : 0,
                    stencilWriteMask: pipelineState.stencilEnabled
                        ? pipelineState.stencilWriteMask : 0,
                };
            }
            pipeline = this.device.createRenderPipeline(descriptor);
            pipeline._bindGroupLayout = bindGroupLayout;
            pipeline._d9wgId = this.objectId(pipeline);
            // Keep structured diagnostic data beside the cached object. The
            // old dumpPipelineStates() attempted to recover it by splitting
            // the cache key on "|", but fixed-function fragment keys use the
            // same character between texture stages, shifting every field and
            // producing a null/misattributed state exactly when multi-texture
            // debugging mattered most.
            pipeline._d9wgDiagnostic = {
                vertex: program.vertexKey,
                fragment: program.fragmentKey,
                topology,
                stripIndexFormat: stripIndexFormat || null,
                vertexBuffers: program.vertexBuffers.map(layout => ({
                    stream: layout.stream,
                    arrayStride: layout.arrayStride,
                    stepMode: layout.stepMode || "vertex",
                    attributes: layout.attributes.map(attribute =>
                        ({ ...attribute })),
                })),
                samplers: program.samplerIndices.slice(),
                state: JSON.parse(JSON.stringify(pipelineState)),
            };
            pipeline._d9wgDrawCount = 0;
            ++this.stats.pipelineCreations;
            this.pipelineCache.set(key, pipeline);
            return pipeline;
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

        allocateUniformSlot(byteCount) {
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
            this.retireAfterSubmit(buffer);
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
         * that is decided by commandSerial rather than by hashing the assembled
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
             * through a command, and any non-draw command bumps the serial.
             *
             * The module keys cover the program. programFor() rebuilds its
             * return object per draw, so the object cannot be compared by
             * identity, but vertexKey/fragmentKey are the keys its WGSL modules
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
            if (cached && cached.serial === this.commandSerial &&
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
                    state.psConstB);
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
            state.lastConstants = { serial: this.commandSerial,
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
                const base = at("blend_worlds");
                for (let slot = 0; slot < blend.matrixSlots; ++slot) {
                    floats.set(state.transforms.get(D3DTS_WORLD + slot) ||
                        IDENTITY4x4, base + slot * 16);
                }
            } else {
                floats.set(screenSpace ? IDENTITY4x4 : this.wvp(state),
                    at("world_view_projection"));
                if (layout.byName.has("world_matrix"))
                    floats.set(state.transforms.get(D3DTS_WORLD) || IDENTITY4x4,
                        at("world_matrix"));
            }
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
                if (!stage.transformCount) continue;
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
                const position = transformPoint(view, light.position);
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
                if (entry.name === "fog_color") {
                    // D3DRS_FOGCOLOR's alpha byte is defined as unused.
                    writeColor(entry.offset / 4,
                        state.renderStates.get(D3DRS_FOGCOLOR) || 0, 1);
                } else if (entry.name === "fog_params") {
                    // Table fog evaluates the equation per fragment, so its
                    // start/end/density values belong to the pixel block.
                    const asFloat = (id, fallback) => {
                        const raw = state.renderStates.get(id);
                        if (raw === undefined) return fallback;
                        FLOAT_BITS_U32[0] = raw >>> 0;
                        return FLOAT_BITS_F32[0];
                    };
                    const base = entry.offset / 4;
                    floats[base] = asFloat(D3DRS_FOGSTART, 0);
                    floats[base + 1] = asFloat(D3DRS_FOGEND, 1);
                    floats[base + 2] = asFloat(D3DRS_FOGDENSITY, 1);
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
                    // stage_constant<N>; D3DTSS_CONSTANT defaults to opaque
                    // black, unlike D3DRS_TEXTUREFACTOR's opaque white.
                    writeColor(entry.offset / 4,
                        state.textureStageStates.get(
                            entry.source * 64 + D3DTSS_CONSTANT) || 0xff000000);
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
            const linear = (get(D3DSAMP_MAGFILTER, 1) !== 0) &&
                (get(D3DSAMP_MINFILTER, 1) !== 0);
            const key = "cmp," + addressU + "," + addressV + "," +
                (linear ? "linear" : "nearest");
            const cached = this.samplerCache.get(key);
            if (cached) { ++this.stats.samplerHits; return cached; }
            const sampler = this.device.createSampler({
                addressModeU: ADDRESS_MODES[addressU] || "repeat",
                addressModeV: ADDRESS_MODES[addressV] || "repeat",
                magFilter: linear ? "linear" : "nearest",
                minFilter: linear ? "linear" : "nearest",
                compare: "less-equal",
            });
            ++this.stats.samplersCreated;
            ++this.stats.comparisonSamplersCreated;
            this.samplerCache.set(key, sampler);
            return sampler;
        }

        sampledViewFor(texture, wantsSRGB) {
            if (!wantsSRGB) return texture.view;
            if (!texture.srgbFormat) {
                ++this.stats.srgbTextureUnavailable;
                this.warnOnce("srgb-no-sibling",
                    "a stage asks for sRGB decoding on a texture whose format " +
                    "has no -srgb equivalent in WebGPU, so it is sampled as " +
                    "linear and comes out too bright", { format: texture.format,
                        gpuFormat: texture.gpuFormat });
                return texture.view;
            }
            if (!texture.srgbView) {
                texture.srgbView = texture.gpuTexture.createView({
                    format: texture.srgbFormat,
                    dimension: texture.textureType === "cube" ? "cube" : "2d",
                });
                ++this.stats.srgbViewsCreated;
            }
            ++this.stats.srgbTextureSamples;
            return texture.srgbView;
        }

        // A 1x1 opaque white stand-in per view dimension, for a stage the
        // shader samples but the app left unbound. "depth" is not a view
        // dimension but is threaded through the same cache because it plays
        // the same role: the stand-in a depth slot reads when nothing usable
        // is bound.
        fallbackViewFor(dimension, unfilterable) {
            if (dimension === "depth") return this.fallbackDepthView();
            if ((dimension === "2d" || !dimension) && !unfilterable)
                return this.fallbackView;
            if (!this.fallbackViews) this.fallbackViews = new Map();
            const key = (dimension || "2d") + (unfilterable ? "|f32" : "|u8");
            let view = this.fallbackViews.get(key);
            if (view) return view;
            const layers = dimension === "cube" ? 6 : 1;
            const texture = this.device.createTexture({
                label: "D3D9 fallback white " + key,
                size: { width: 1, height: 1, depthOrArrayLayers: layers },
                format: unfilterable ? "rgba32float" : "rgba8unorm",
                dimension: dimension === "3d" ? "3d" : "2d",
                usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
            });
            for (let layer = 0; layer < layers; ++layer) {
                this.device.queue.writeTexture(
                    { texture, origin: { x: 0, y: 0, z: layer } },
                    unfilterable
                        ? new Float32Array([1, 1, 1, 1])
                        : new Uint8Array([255, 255, 255, 255]),
                    { bytesPerRow: unfilterable ? 16 : 4, rowsPerImage: 1 },
                    { width: 1, height: 1, depthOrArrayLayers: 1 });
            }
            view = texture.createView({ dimension: dimension || "2d" });
            this.fallbackViews.set(key, view);
            return view;
        }

        // The depth counterpart of the 1x1 white texture. It has to read as
        // "nothing occludes this fragment", and for a less-equal comparison
        // that means the far plane. A fresh WebGPU texture zero-initialises,
        // which is the near plane and would come out fully shadowed, so it is
        // cleared through an empty render pass -- depth formats cannot be
        // written with writeTexture.
        fallbackDepthView() {
            if (this.fallbackDepth) return this.fallbackDepth;
            const texture = this.device.createTexture({
                label: "D3D9 fallback depth (far plane)",
                size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                format: DEPTH_FORMAT,
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT |
                    TEXTURE_USAGE_TEXTURE_BINDING,
            });
            const encoder = this.device.createCommandEncoder(
                { label: "D3D9 fallback depth clear" });
            encoder.beginRenderPass({
                colorAttachments: [],
                depthStencilAttachment: {
                    view: texture.createView(),
                    depthClearValue: 1.0,
                    depthLoadOp: "clear",
                    depthStoreOp: "store",
                    stencilClearValue: 0,
                    stencilLoadOp: "clear",
                    stencilStoreOp: "store",
                },
            }).end();
            this.device.queue.submit([encoder.finish()]);
            this.fallbackDepth = texture.createView({ aspect: "depth-only" });
            return this.fallbackDepth;
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
            const group = this.device.createBindGroup(
                { layout: pipeline._bindGroupLayout, entries });
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

        // Builds the pipeline/uniform buffer/bind group eagerly (none of
        // those are tied to the swapchain's current texture, so there is no
        // staleness concern in creating them now) but only *records* the
        // draw as a pending op -- see the comment on ensureFrame() for why
        // the actual pass.draw()/drawIndexed() call must wait until
        // finishFrame() replays it against a freshly-acquired texture.
        //
        // The stride each stream contributes is the one the application bound
        // via SetStreamSource (or that a Draw*UP command carried). It must
        // never be inferred from the vertex declaration: a declaration's
        // consumed elements are only part of the vertex, so a computed stride
        // is too small whenever the format carries anything the shader skips
        // (NORMAL, extra texcoords, padding) and every vertex after the first
        // would then be fetched from the wrong offset.
        recordDraw(state, elements, which, geometry) {
            const targets = this.renderTargetsFor(state);
            if (!targets) {
                this.noteDroppedDraw(which, state,
                    ["no usable colour render target is bound"]);
                return;
            }
            // D3DRS_FILLMODE. WebGPU has no polygon mode, so wireframe is
            // reached by rewriting the topology and the indices instead: every
            // triangle becomes its three edges as a line list. Done here, at
            // the single funnel every draw path reaches, rather than at the
            // four Draw* entry points -- and after the fan conversion above it,
            // so a fan is already an ordinary triangle list by the time it
            // arrives.
            geometry = this.applyFillMode(state, geometry) || geometry;
            // A draw against a stand-in depth attachment that nothing cleared
            // is the one case where standing in changed the image; anything
            // else has no earlier contents to have lost.
            if (targets.substituteDepth &&
                    (state.renderStates.get(D3DRS_ZENABLE) || 0) !== 0)
                this.noteSubstituteDepthUse(targets, false);
            const pipelineState = this.pipelineStateFor(state, targets);
            // A point-list that came from D3DFILL_POINT is not a point
            // sprite: sprite expansion is what D3DRS_POINTSPRITEENABLE asks
            // for, and a wireframe-mode triangle mesh asked for neither.
            const pointExpansion = geometry.topology === "point-list" &&
                !geometry.indexInfo && !geometry.fromFillMode;
            const instanceCount = this.drawInstanceCount(state);
            const hasInstanceStream = Array.from(state.streams.values()).some(stream =>
                (((stream.frequency ?? 1) >>> 0) &
                    D3DSTREAMSOURCE_INSTANCEDATA) !== 0);
            if (instanceCount > 1 && !geometry.indexInfo && !pointExpansion) {
                this.noteDroppedDraw(which, state,
                    ["D3D9 indexed instancing requires an indexed draw"]);
                return;
            }
            if (pointExpansion && (instanceCount !== 1 || hasInstanceStream)) {
                this.noteDroppedDraw(which, state,
                    ["point expansion cannot share WebGPU instance slots with D3D9 instancing"]);
                return;
            }
            const pointSprite = pointExpansion &&
                (state.renderStates.get(D3DRS_POINTSPRITEENABLE) || 0) !== 0;
            const program = this.programFor(state, elements, pipelineState,
                { pointExpansion, pointSprite });
            if (program.error) {
                if (program.shaderError) ++this.stats.drawsSkippedForBadShader;
                this.noteDroppedDraw(which, state, [program.error]);
                return;
            }
            const pipeline = this.pipelineFor(program, pipelineState,
                pointExpansion ? "triangle-list" : geometry.topology,
                pointExpansion ? undefined : geometry.stripIndexFormat);
            // The bind group captures concrete GPUTextureView objects. Create
            // the frame first so bindGroupFor can mark those textures as read;
            // a later UPDATE_TEXTURE can then rename instead of retroactively
            // changing this already-recorded draw. A draw without a preceding
            // Clear is legal and used by War3's UI passes, so relying on Clear
            // to create the frame misses exactly those textures.
            const frame = this.ensureFrame();
            const constants = this.constantBufferFor(state, program);
            const binding = this.bindGroupFor(state, pipeline, program, constants);
            const prepared = this.prepareInstanceStreams(
                geometry.streams, instanceCount);
            if (prepared.error) {
                this.noteDroppedDraw(which, state, [prepared.error]);
                return;
            }
            geometry = { ...geometry, streams: prepared.streams };
            // Bind each stream the pipeline declared a layout for, in the same
            // order, so slot N in the pipeline is slot N here.
            const vertexBuffers = [];
            for (const layout of program.vertexBuffers) {
                if (layout.stream === DEFAULT_ATTRIBUTE_STREAM) {
                    vertexBuffers.push({ buffer: this.defaultAttributeBuffer(), offset: 0 });
                    continue;
                }
                const binding = geometry.streams.get(layout.stream);
                if (!binding) {
                    this.noteDroppedDraw(which, state,
                        ["stream " + layout.stream + " is referenced by the " +
                         "declaration but not bound"]);
                    return;
                }
                vertexBuffers.push({ buffer: binding.buffer, offset: binding.offset });
            }
            // Mark every buffer this draw reads as "observed at this frame's
            // contents". applyBufferUpdate() uses that to notice a write that
            // would retroactively change what an already-recorded draw sees.
            for (const layout of program.vertexBuffers) {
                const binding = geometry.streams.get(layout.stream);
                if (binding && binding.resource)
                    binding.resource.frameReferenced = frame.serial;
            }
            if (geometry.indexResource)
                geometry.indexResource.frameReferenced = frame.serial;
            // D3DRS_SCISSORTESTENABLE gates the rect; without it D3D9 ignores
            // whatever SetScissorRect last set.
            const scissorEnabled =
                (state.renderStates.get(D3DRS_SCISSORTESTENABLE) || 0) !== 0 &&
                !!state.scissorRect;
            if (scissorEnabled) ++this.stats.drawsWithScissor;
            const attachmentCount = Math.max(1, Math.min(4,
                (targets.colors && targets.colors.length) || 1));
            ++this.mrtAttachmentDraws[attachmentCount];
            pipeline._d9wgDrawCount = (pipeline._d9wgDrawCount || 0) + 1;
            const drawPath = (state.vertexShaderHandle ||
                state.pixelShaderHandle) ? "programmable" : "fixed";
            // References are retained, not expanded, on the hot draw path.
            // blackScreenReport() serialises the two most recent paths only
            // when explicitly requested, avoiding per-draw diagnostic copies
            // during a real benchmark run.
            this.lastDraws[drawPath] = {
                which, state, elements, geometry, program, pipelineState,
                targets, pipeline,
            };
            frame.ops.push({
                kind: "draw", pipeline, bindGroup: binding.group,
                dynamicOffsets: binding.dynamicOffsets, targets,
                viewport: { ...state.viewport },
                scissor: scissorEnabled ? { ...state.scissorRect } : null,
                blendConstant: pipelineState.blendConstant,
                stencilReference: pipelineState.stencilReference,
                vertexBuffers, indexInfo: geometry.indexInfo,
                vertexCount: pointExpansion ? 6 : geometry.vertexCount,
                instanceCount: pointExpansion ? geometry.vertexCount : instanceCount,
            });
            if (pointExpansion) {
                ++this.stats.pointSpriteDraws;
                this.stats.pointSpriteInstances += geometry.vertexCount || 0;
            }
            if (!pointExpansion && instanceCount > 1) {
                ++this.stats.instancedDraws;
                this.stats.instancesDrawn += instanceCount;
            }
            // The pointer is almost always the final thing a frame draws, so
            // the texture bound by the last draw is the quickest way to name
            // the cursor's texture without hunting through the whole atlas set.
            if (program.samplerIndices.length)
                this.stats.lastDrawTexture =
                    state.textures.get(program.samplerIndices[0]) || 0;
            if (state.vertexShaderHandle || state.pixelShaderHandle)
                ++this.stats.programmableDraws;
            if (geometry.indexInfo) ++this.stats.indexedDrawCalls;
            else ++this.stats.drawCalls;
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
                if (divisor === 1) continue;
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
            const deviceHandle = view.getUint32(offset, true);
            const primitiveType = view.getUint32(offset + 4, true);
            const startVertex = view.getUint32(offset + 8, true);
            const primitiveCount = view.getUint32(offset + 12, true);
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
            const deviceHandle = view.getUint32(offset, true);
            const primitiveType = view.getUint32(offset + 4, true);
            const baseVertexIndex = view.getInt32(offset + 8, true);
            const startIndex = view.getUint32(offset + 20, true);
            const primitiveCount = view.getUint32(offset + 24, true);
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
            const deviceHandle = view.getUint32(offset, true);
            const primitiveType = view.getUint32(offset + 4, true);
            const primitiveCount = view.getUint32(offset + 8, true);
            const stride = view.getUint32(offset + 12, true);
            const vertexBytes = view.getUint32(offset + 20, true);
            const dataOffset = view.getUint32(offset + 24, true);
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
            const deviceHandle = view.getUint32(offset, true);
            const primitiveType = view.getUint32(offset + 4, true);
            const primitiveCount = view.getUint32(offset + 16, true);
            const indexFormatValue = view.getUint32(offset + 20, true);
            // M1 never read `stride` out of this payload but referenced it
            // when recording the draw, so every DrawIndexedPrimitiveUP threw
            // a ReferenceError and took the whole batch down with it (the
            // batch's catch handler discarded the frame). War3's main menu
            // happens not to use this entry point, which is why it stayed
            // hidden.
            const stride = view.getUint32(offset + 24, true);
            const indexBytes = view.getUint32(offset + 32, true);
            const vertexBytes = view.getUint32(offset + 36, true);
            const indexDataOffset = view.getUint32(offset + 40, true);
            const vertexDataOffset = view.getUint32(offset + 44, true);
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

        // Draw*UP carries its own stride rather than having one bound through
        // SetStreamSource, so vertexBufferLayoutsFor() -- which reads
        // state.streams -- needs stream 0 temporarily standing in for it.
        recordDrawWithStride(state, elements, which, geometry, stride) {
            const saved = state.streams.get(0);
            state.streams.set(0, { bufferHandle: 0, stride, offsetInBytes: 0,
                frequency: 1 });
            try {
                this.recordDraw(state, elements, which, geometry);
            } finally {
                if (saved) state.streams.set(0, saved);
                else state.streams.delete(0);
            }
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
