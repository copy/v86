// Guest device/session state, independent of WebGPU allocation and wire decoding.
// Immutable identity matrices and register limits are supplied by the executor;
// mutable maps, registers, frames and uniform storage belong to one owner.
(function(global) {
    "use strict";
    function createDeviceState(handle, constants) {
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
            material: null,          // explicit material; defaults are resolved by FFP
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

    function createSessionState(key) {
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
            uniformRingChunks: [],
            uniformStaging: [],
            uniformRingIndex: 0,
            uniformRingCursor: 0,
            featureBits: 0,
        };
    }


    const SESSION_FIELDS = Object.freeze([
        "devices", "resources", "frame", "activeOcclusion", "presentingDevice", "lastSwapTexture",
        "backBufferTexture", "backBufferView", "backBufferSrgbView", "backBufferTextureWidth",
        "backBufferTextureHeight", "palettes", "ddPaletteBuffers", "ddPaletteSerials", "windowState",
        "cursor", "lastDraws", "uniformRingChunks", "uniformStaging", "uniformRingIndex", "uniformRingCursor",
    ]);
    function captureSession(state, executor) {
        for (const field of SESSION_FIELDS) state[field] = executor[field];
    }
    function activateSession(executor, state) {
        for (const field of SESSION_FIELDS) executor[field] = state[field];
    }
    const api = { createDeviceState, createSessionState, captureSession, activateSession, SESSION_FIELDS };
    global.D9WGState = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
