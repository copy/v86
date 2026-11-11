// Guest device/session state, independent of WebGPU allocation and wire decoding.
// Immutable identity matrices and register limits are supplied by the executor;
// mutable maps, registers, frames and uniform storage belong to one owner.
(function(global) {
    "use strict";
    // [state, D3D8, D3D9]. null means absent in that API; contextual values
    // resolve at creation/reset. This table also generates the guest C header.
    // Wine stateblock tests and DirectX 8.1/9 SDK defaults are independent test references.
    const RENDER_DEFAULT_ROWS = Object.freeze([
        [7, "autoDepth", "autoDepth"], // D3DRS_ZENABLE
        [8, 3, 3], // D3DRS_FILLMODE
        [9, 2, 2], // D3DRS_SHADEMODE
        [14, 1, 1], // D3DRS_ZWRITEENABLE
        [15, 0, 0], // D3DRS_ALPHATESTENABLE
        [16, 1, 1], // D3DRS_LASTPIXEL
        [19, 2, 2], // D3DRS_SRCBLEND
        [20, 1, 1], // D3DRS_DESTBLEND
        [22, 3, 3], // D3DRS_CULLMODE
        [23, 4, 4], // D3DRS_ZFUNC
        [24, 0, 0], // D3DRS_ALPHAREF
        [25, 8, 8], // D3DRS_ALPHAFUNC
        [26, 0, 0], // D3DRS_DITHERENABLE
        [27, 0, 0], // D3DRS_ALPHABLENDENABLE
        [28, 0, 0], // D3DRS_FOGENABLE
        [29, 0, 0], // D3DRS_SPECULARENABLE
        [34, 0, 0], // D3DRS_FOGCOLOR
        [35, 0, 0], // D3DRS_FOGTABLEMODE
        [36, 0, 0], // D3DRS_FOGSTART
        [37, 0x3F800000, 0x3F800000], // D3DRS_FOGEND
        [38, 0x3F800000, 0x3F800000], // D3DRS_FOGDENSITY
        [47, 0, null], // D3D8RS_ZBIAS
        [48, 0, 0], // D3DRS_RANGEFOGENABLE
        [52, 0, 0], // D3DRS_STENCILENABLE
        [53, 1, 1], // D3DRS_STENCILFAIL
        [54, 1, 1], // D3DRS_STENCILZFAIL
        [55, 1, 1], // D3DRS_STENCILPASS
        [56, 8, 8], // D3DRS_STENCILFUNC
        [57, 0, 0], // D3DRS_STENCILREF
        [58, 0xFFFFFFFF, 0xFFFFFFFF], // D3DRS_STENCILMASK
        [59, 0xFFFFFFFF, 0xFFFFFFFF], // D3DRS_STENCILWRITEMASK
        [60, 0xFFFFFFFF, 0xFFFFFFFF], // D3DRS_TEXTUREFACTOR
        [128, 0, 0], // D3DRS_WRAP0
        [129, 0, 0], // D3DRS_WRAP1
        [130, 0, 0], // D3DRS_WRAP2
        [131, 0, 0], // D3DRS_WRAP3
        [132, 0, 0], // D3DRS_WRAP4
        [133, 0, 0], // D3DRS_WRAP5
        [134, 0, 0], // D3DRS_WRAP6
        [135, 0, 0], // D3DRS_WRAP7
        [136, 1, 1], // D3DRS_CLIPPING
        [137, 1, 1], // D3DRS_LIGHTING
        [139, 0, 0], // D3DRS_AMBIENT
        [140, 0, 0], // D3DRS_FOGVERTEXMODE
        [141, 1, 1], // D3DRS_COLORVERTEX
        [142, 1, 1], // D3DRS_LOCALVIEWER
        [143, 0, 0], // D3DRS_NORMALIZENORMALS
        [145, 1, 1], // D3DRS_DIFFUSEMATERIALSOURCE
        [146, 2, 2], // D3DRS_SPECULARMATERIALSOURCE
        [147, 0, 0], // D3DRS_AMBIENTMATERIALSOURCE
        [148, 0, 0], // D3DRS_EMISSIVEMATERIALSOURCE
        [151, 0, 0], // D3DRS_VERTEXBLEND
        [152, 0, 0], // D3DRS_CLIPPLANEENABLE
        [154, 0x3F800000, 0x3F800000], // D3DRS_POINTSIZE
        [155, 0, 0x3F800000], // D3DRS_POINTSIZE_MIN
        [156, 0, 0], // D3DRS_POINTSPRITEENABLE
        [157, 0, 0], // D3DRS_POINTSCALEENABLE
        [158, 0x3F800000, 0x3F800000], // D3DRS_POINTSCALE_A
        [159, 0, 0], // D3DRS_POINTSCALE_B
        [160, 0, 0], // D3DRS_POINTSCALE_C
        [161, 1, 1], // D3DRS_MULTISAMPLEANTIALIAS
        [162, 0xFFFFFFFF, 0xFFFFFFFF], // D3DRS_MULTISAMPLEMASK
        [163, 0, 0], // D3DRS_PATCHEDGESTYLE
        [166, "pointMax", "pointMax"], // D3DRS_POINTSIZE_MAX
        [167, 0, 0], // D3DRS_INDEXEDVERTEXBLENDENABLE
        [168, 15, 15], // D3DRS_COLORWRITEENABLE
        [170, 0, 0], // D3DRS_TWEENFACTOR
        [171, 1, 1], // D3DRS_BLENDOP
        [172, 3, 3], // D3DRS_POSITIONDEGREE
        [173, 1, 1], // D3DRS_NORMALDEGREE
        [174, null, 0], // D3DRS_SCISSORTESTENABLE
        [175, null, 0], // D3DRS_SLOPESCALEDEPTHBIAS
        [176, null, 0], // D3DRS_ANTIALIASEDLINEENABLE
        [178, null, 0x3F800000], // D3DRS_MINTESSELLATIONLEVEL
        [179, null, 0x3F800000], // D3DRS_MAXTESSELLATIONLEVEL
        [180, null, 0], // D3DRS_ADAPTIVETESS_X
        [181, null, 0], // D3DRS_ADAPTIVETESS_Y
        [182, null, 0x3F800000], // D3DRS_ADAPTIVETESS_Z
        [183, null, 0], // D3DRS_ADAPTIVETESS_W
        [184, null, 0], // D3DRS_ENABLEADAPTIVETESSELLATION
        [185, null, 0], // D3DRS_TWOSIDEDSTENCILMODE
        [186, null, 1], // D3DRS_CCW_STENCILFAIL
        [187, null, 1], // D3DRS_CCW_STENCILZFAIL
        [188, null, 1], // D3DRS_CCW_STENCILPASS
        [189, null, 8], // D3DRS_CCW_STENCILFUNC
        [190, null, 15], // D3DRS_COLORWRITEENABLE1
        [191, null, 15], // D3DRS_COLORWRITEENABLE2
        [192, null, 15], // D3DRS_COLORWRITEENABLE3
        [193, null, 0xFFFFFFFF], // D3DRS_BLENDFACTOR
        [194, null, 0], // D3DRS_SRGBWRITEENABLE
        [195, null, 0], // D3DRS_DEPTHBIAS
        [198, null, 0], // D3DRS_WRAP8
        [199, null, 0], // D3DRS_WRAP9
        [200, null, 0], // D3DRS_WRAP10
        [201, null, 0], // D3DRS_WRAP11
        [202, null, 0], // D3DRS_WRAP12
        [203, null, 0], // D3DRS_WRAP13
        [204, null, 0], // D3DRS_WRAP14
        [205, null, 0], // D3DRS_WRAP15
        [206, null, 0], // D3DRS_SEPARATEALPHABLENDENABLE
        [207, null, 2], // D3DRS_SRCBLENDALPHA
        [208, null, 1], // D3DRS_DESTBLENDALPHA
        [209, null, 1], // D3DRS_BLENDOPALPHA
    ].map(Object.freeze));
    function renderDefaults(api = 9, autoDepth = true, pointMax = 256) {
        const result = new Map();
        for (const [state, d8, d9] of RENDER_DEFAULT_ROWS) {
            const value = api === 8 ? d8 : d9;
            if (value === null) continue;
            let word = value;
            if (value === "autoDepth") word = autoDepth ? 1 : 0;
            if (value === "pointMax") {
                const floats = new Float32Array([pointMax > 1 ? pointMax : 64]);
                word = new Uint32Array(floats.buffer)[0];
            }
            result.set(state, word);
        }
        return result;
    }

    // Common texture cascade defaults. Sampler rows also name the legacy
    // D3D8 texture-stage ID, so both shadows use the same sampling defaults.
    const TEXTURE_DEFAULT_ROWS = Object.freeze([
        [1, "colorOp"], [2, 2], [3, 1], [4, "alphaOp"], [5, 2], [6, 1],
        [7, 0], [8, 0], [9, 0], [10, 0], [11, "stage"],
        [22, 0], [23, 0], [24, 0], [26, 1], [27, 1], [28, 1], [32, 0],
    ].map(Object.freeze));
    const SAMPLER_DEFAULT_ROWS = Object.freeze([
        [1, 1, 13], [2, 1, 14], [3, 1, 25], [4, 0, 15],
        [5, 1, 16], [6, 1, 17], [7, 0, 18], [8, 0, 19],
        [9, 0, 20], [10, 1, 21], [11, 0, null], [12, 0, null], [13, 0, null],
    ].map(Object.freeze));
    const SAMPLER_INDICES = Object.freeze([...Array(16).keys(), 257, 258, 259, 260]);
    function textureDefaults(api = 9) {
        const result = new Map();
        for (let stage = 0; stage < 8; ++stage) {
            for (const [id, value] of TEXTURE_DEFAULT_ROWS) {
                if (api === 8 && id === 32) continue;
                const word = value === "colorOp" ? (stage ? 1 : 4) :
                    value === "alphaOp" ? (stage ? 1 : 2) : value === "stage" ? stage : value;
                result.set(stage*64 + id, word);
            }
            if (api === 8) for (const [, value, legacy] of SAMPLER_DEFAULT_ROWS)
                if (legacy !== null) result.set(stage*64 + legacy, value);
        }
        return result;
    }
    function samplerDefaults() {
        const result = new Map();
        for (const sampler of SAMPLER_INDICES)
            for (const [id, value] of SAMPLER_DEFAULT_ROWS) result.set(sampler*64 + id, value);
        return result;
    }

    // D3D7 RGB is measured separately; D3D8 and D3D9 differ in the SDK.
    // Flattened SDK order: diffuse, ambient, specular, emissive, power.
    const MATERIAL_DEFAULTS = Object.freeze({
        7: Object.freeze(Array(17).fill(0)),
        8: Object.freeze([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        9: Object.freeze(Array(17).fill(0)),
    });
    function materialDefaults(api = 9) {
        const values = MATERIAL_DEFAULTS[api];
        return { diffuse: values.slice(0, 4), ambient: values.slice(4, 8),
            specular: values.slice(8, 12), emissive: values.slice(12, 16), power: values[16] };
    }

    function createDeviceState(handle, constants, autoDepth = true) {
        const { D3DMULTISAMPLE_NONE, D3DTS_VIEW, D3DTS_PROJECTION, D3DTS_WORLD, IDENTITY4x4,
            MAX_VS_CONST_F, MAX_PS_CONST_F, MAX_CONST_I, MAX_CONST_B } = constants;
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
            backBufferTexture: null,
            backBufferView: null,
            backBufferSrgbView: null,
            backBufferTextureWidth: 0,
            backBufferTextureHeight: 0,
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
            renderStates: renderDefaults(9, autoDepth),
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
            samplerStates: samplerDefaults(), // sampler*64+state -> value, read by samplerFor()
            textureStageStates: textureDefaults(),
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
            material: materialDefaults(),
            lights: new Map(),       // light index -> D3DLIGHT9-shaped object
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
            currentPalette: 0,
            // 0 = the device's auto depth-stencil; depthUnbound is
            // SetDepthStencilSurface(NULL), which is not the same thing --
            // it turns depth testing off for the draws that follow.
            depthTargetHandle: 0,
            depthTargetLevel: 0,
            depthUnbound: false,
            scissorRect: null,
            clipPlanes: Array.from({ length: 6 }, () => [0, 0, 0, 0]),
            // Acquire the full clipping layout on first use; later enable-mask
            // changes only update neutral/active plane uniforms.
            clipPlaneCapacity: 0,
            inScene: false,
        };
    }

    function createSessionState(key) {
        return {
            key,
            devices: new Map(),
            resources: new Map(),
            frame: null,
            activeOcclusion: null, recordingOcclusion: null,
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
            lastDraws: null,
            uploads: null,
            uniformRingChunks: [],
            uniformStaging: [],
            uniformRingIndex: 0,
            uniformRingCursor: 0,
            featureBits: 0,
        };
    }


    const SESSION_FIELDS = Object.freeze([
        "devices", "resources", "frame", "activeOcclusion", "recordingOcclusion", "presentingDevice", "lastSwapTexture",
        "backBufferTexture", "backBufferView", "backBufferSrgbView", "backBufferTextureWidth",
        "backBufferTextureHeight", "palettes", "ddPaletteBuffers", "ddPaletteSerials", "windowState",
        "cursor", "lastDraws", "uploads", "uniformRingChunks", "uniformStaging", "uniformRingIndex", "uniformRingCursor",
    ]);
    function captureSession(state, executor) {
        for (const field of SESSION_FIELDS) state[field] = executor[field];
    }
    function activateSession(executor, state) {
        for (const field of SESSION_FIELDS) executor[field] = state[field];
    }
    const api = { MATERIAL_DEFAULTS, materialDefaults, RENDER_DEFAULT_ROWS, TEXTURE_DEFAULT_ROWS, SAMPLER_DEFAULT_ROWS, SAMPLER_INDICES, renderDefaults, textureDefaults, samplerDefaults, createDeviceState, createSessionState, captureSession, activateSession, SESSION_FIELDS };
    global.D9WGState = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
