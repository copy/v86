// D3D9 pixel conformance on a real GPU: table-driven cases whose expected
// pixels come from the D3D9 rules (Microsoft's documentation, and Wine's
// dlls/d3d9/tests/visual.c where it pins them on Windows), not from what the
// executor happens to produce. d3d9_conformance_browser_test.html runs them.
//
// A case renders into its own 64x64 A8R8G8B8 render target after a clear to
// `clear` (opaque black by default), with lighting off and a pre-transformed
// FVF (XYZRHW | DIFFUSE | SPECULAR); `body` adds the commands under test.
// Every case also asserts that WebGPU accepted everything it was given.
//
// KNOWN_FAILURES names the cases that fail today, each with the review item
// (docs/d3d-webgpu-review.md) that fixes it: a fix deletes its line, and a
// listed case that starts passing fails the run until it is deleted.
"use strict";
(function(global) {

    const P = global.D9WGProtocol;
    const W = 64;
    const u32 = (...values) => {
        const bytes = new Uint8Array(values.length * 4), view = new DataView(bytes.buffer);
        values.forEach((value, i) => view.setUint32(i * 4, value >>> 0, true));
        return bytes;
    };
    const f = value => {
        const view = new DataView(new ArrayBuffer(4));
        view.setFloat32(0, value, true);
        return view.getUint32(0, true);
    };
    const cat = arrays => {
        const out = new Uint8Array(arrays.reduce((n, a) => n + a.byteLength, 0));
        let at = 0;
        for (const a of arrays) { out.set(a, at); at += a.byteLength; }
        return out;
    };
    const element = (offset, type, usage, index = 0) => P.encode("VertexElement", { offset, type, usage, usage_index: index });
    // blobs: [{ offsetField, data }] -- data appended after the payload, its
    // offset in the batch written into the payload at offsetField
    const cmd = (opcode, payload, blobs = []) => ({ opcode, payload, blobs });

    const batch = (session, commands, present) => P.encodeBatch(commands.map(c => ({
        opcode: c.opcode, payload: c.payload, blobs: c.blobs.map(blob => ({ field: blob.offsetField, data: blob.data })),
    })), { session_id_low: session, flags: present ? P.C.D9WG_BATCH_FLAG_PRESENT : 0 });

    const OP = P.OP;
    const RS = { ZENABLE: 7, SHADEMODE: 9, ZFUNC: 23, ALPHATESTENABLE: 15, ALPHAREF: 24, ALPHAFUNC: 25,
        ALPHABLENDENABLE: 27, SRCBLEND: 19, DESTBLEND: 20, CULLMODE: 22, FOGENABLE: 28,
        SPECULARENABLE: 29, FOGCOLOR: 34, FOGTABLEMODE: 35, TEXTUREFACTOR: 60, LIGHTING: 137,
        FOGVERTEXMODE: 140, FOGSTART: 36, FOGEND: 37, MULTISAMPLEANTIALIAS: 161, COLORWRITEENABLE: 168, BLENDOP: 171,
        SCISSORTESTENABLE: 174,
        DEPTHBIAS: 195 };
    const PT = { LINELIST: 2, TRIANGLELIST: 4 };

    // FVF XYZRHW | DIFFUSE | SPECULAR, stride 24
    const FVF = 0xC4, STRIDE = 24;
    const ELEMENTS = [element(0, 3, 9), element(16, 4, 10, 0), element(20, 4, 10, 1)];
    const vertices = list => {
        const bytes = new Uint8Array(list.length * STRIDE), view = new DataView(bytes.buffer);
        list.forEach((v, i) => {
            const o = i * STRIDE;
            view.setFloat32(o, v[0], true);
            view.setFloat32(o + 4, v[1], true);
            view.setFloat32(o + 8, v[2], true);
            view.setFloat32(o + 12, v[5] === undefined ? 1 : v[5], true);
            view.setUint32(o + 16, v[3] >>> 0, true);
            view.setUint32(o + 20, (v[4] === undefined ? 0xFF000000 : v[4]) >>> 0, true);
        });
        return bytes;
    };
    // A clockwise (front-facing in D3D9) quad as a triangle list, in pixels
    const quad = (x0, y0, x1, y1, z, color, specular) => [
        [x0, y0, z, color, specular], [x1, y0, z, color, specular], [x0, y1, z, color, specular],
        [x1, y0, z, color, specular], [x1, y1, z, color, specular], [x0, y1, z, color, specular]];
    const draw = (dev, list, type = PT.TRIANGLELIST) => {
        const data = vertices(list);
        const count = type === PT.LINELIST ? list.length / 2 : list.length / 3;
        return cmd(OP.DRAW_PRIMITIVE_UP, P.encode("DrawPrimitiveUP", { device_handle: dev, primitive_type: type, primitive_count: count, stride: STRIDE, vertex_count: list.length, vertex_bytes: data.byteLength, vertex_data_offset: 0, reserved: 0 }),
            [{ offsetField: "vertex_data_offset", data }]);
    };
    // FVF XYZ | DIFFUSE, stride 16: with the default identity transforms x
    // and y are clip space, and z the camera-space distance fog reads
    const drawXYZ = (dev, list) => {
        const data = new Uint8Array(list.length * 16), view = new DataView(data.buffer);
        list.forEach((v, i) => {
            view.setFloat32(i * 16, v[0], true);
            view.setFloat32(i * 16 + 4, v[1], true);
            view.setFloat32(i * 16 + 8, v[2], true);
            view.setUint32(i * 16 + 12, v[3] >>> 0, true);
        });
        return [cmd(OP.SET_FVF, cat([P.encode("SetFVF", { device_handle: dev, fvf: 0x42, element_count: 2, reserved: 0 }), element(0, 2, 0), element(12, 4, 10)])),
            cmd(OP.DRAW_PRIMITIVE_UP, P.encode("DrawPrimitiveUP", { device_handle: dev, primitive_type: PT.TRIANGLELIST, primitive_count: list.length / 3, stride: 16, vertex_count: list.length, vertex_bytes: data.byteLength, vertex_data_offset: 0, reserved: 0 }),
                [{ offsetField: "vertex_data_offset", data }])];
    };
    const fullXYZ = (z, color) => [[-1, 1, z, color], [1, 1, z, color], [-1, -1, z, color],
        [1, 1, z, color], [1, -1, z, color], [-1, -1, z, color]];
    const rs = (dev, state, value) => cmd(OP.SET_RENDER_STATE, P.encode("SetRenderState", { device_handle: dev, state: state, value: value, reserved: 0 }));
    const tss = (dev, stage, state, value) => cmd(OP.SET_TEXTURE_STAGE_STATE, P.encode("SetTextureStageState", { device_handle: dev, stage: stage, state: state, value: value }));
    const viewport = (dev, x, y, w, h, minZ = 0, maxZ = 1) =>
        cmd(OP.SET_VIEWPORT, P.encode("SetViewport", { device_handle: dev, x: x, y: y, width: w, height: h, min_z: minZ, max_z: maxZ, reserved: 0 }));
    const clear = (dev, flags, color, z = 1, rects = []) =>
        cmd(OP.CLEAR, cat([P.encode("Clear", { device_handle: dev, clear_flags: flags, color: color, depth: z, stencil: 0, rect_count: rects.length }), ...rects.map(([left, top, right, bottom]) => P.encode("Rect", { left, top, right, bottom }))]));
    const shader = opcode => (dev, handle, tokens) => {
        const hash = global.D3D9ShaderPipeline.hashTokens(tokens);
        return cmd(opcode, P.encode("CreateVertexShader", { device_handle: dev, resource_handle: handle, instruction_token_count: tokens.length, bytecode_hash_low: hash.low, bytecode_hash_high: hash.high }),
            [{ offsetField: "code_offset", data: u32(...tokens) }]);
    };
    const pixelShader = shader(OP.CREATE_PIXEL_SHADER);
    const vertexShader = shader(OP.CREATE_VERTEX_SHADER);

    // A little SM2/3 assembler (the translator's own opcode and register numbers)
    const asm = (() => {
        const P = global.D3D9ShaderPipeline;
        const typeBits = type => (((type & 0x7) << 28) | ((type & 0x18) << 8)) >>> 0;
        const ins = (opcode, length, { control = 0, predicated = false } = {}) =>
            ((opcode & 0xffff) | ((control & 0xff) << 16) | ((length & 0xf) << 24) |
                (predicated ? 0x10000000 : 0)) >>> 0;
        const dst = (type, index, mask = 0xf) => (0x80000000 | index | typeBits(type) | (mask << 16)) >>> 0;
        const src = (type, index, swizzle = 0xe4) => (0x80000000 | index | typeBits(type) | (swizzle << 16)) >>> 0;
        const def = (index, x, y, z, w) => [ins(P.OP.DEF, 5), dst(P.REGISTER.CONST, index), f(x), f(y), f(z), f(w)];
        return { OP: P.OP, REG: P.REGISTER, ins, dst, src, def };
    })();

    const T = 0x1, Z = 0x2;   // D3DCLEAR_TARGET, D3DCLEAR_ZBUFFER

    const CASES = [
        { name: "POSITIONT bypasses enabled user clipping planes",
          body: d => [cmd(OP.SET_CLIP_PLANE, P.encode("SetClipPlane", { device_handle: d, index: 0, plane: [0, 0, 0, -1] })),
              rs(d, 152, 1), draw(d, quad(0, 0, 64, 64, .5, 0xFF0000FF))],
          probes: [{ at: [32, 32], expect: [0, 0, 255] }] },
        { name: "untransformed XYZ still applies enabled user clipping planes",
          body: d => [cmd(OP.SET_CLIP_PLANE, P.encode("SetClipPlane", { device_handle: d, index: 0, plane: [0, 0, 0, -1] })),
              rs(d, 152, 1), ...drawXYZ(d, fullXYZ(.5, 0xFFFF0000))],
          probes: [{ at: [32, 32], expect: [0, 0, 0] }] },
        { name: "default D3DCULL_CCW keeps a clockwise triangle and culls a counter-clockwise one",
          body: d => [draw(d, [[0, 0, 0.5, 0xFFFF0000], [64, 0, 0.5, 0xFFFF0000], [0, 64, 0.5, 0xFFFF0000]]),
              draw(d, [[0, 0, 0.4, 0xFF00FF00], [0, 64, 0.4, 0xFF00FF00], [64, 0, 0.4, 0xFF00FF00]])],
          probes: [{ at: [8, 8], expect: [255, 0, 0] }] },
        { name: "D3DCMP_LESS rejects a farther fragment",
          body: d => [rs(d, RS.ZFUNC, 2), draw(d, quad(0, 0, 64, 64, 0.5, 0xFFFF0000)),
              draw(d, quad(0, 0, 64, 64, 0.7, 0xFF00FF00))],
          probes: [{ at: [32, 32], expect: [255, 0, 0] }] },
        { name: "D3DCMP_GREATER accepts a farther fragment",
          body: d => [rs(d, RS.ZFUNC, 8), draw(d, quad(0, 0, 64, 64, 0.5, 0xFFFF0000)), rs(d, RS.ZFUNC, 5),
              draw(d, quad(0, 0, 64, 64, 0.7, 0xFF00FF00))],
          probes: [{ at: [32, 32], expect: [0, 255, 0] }] },
        { name: "SRCALPHA/INVSRCALPHA blends half-transparent red over blue (untextured stage 0 alpha)",
          clear: 0xFF0000FF,
          body: d => [rs(d, RS.ALPHABLENDENABLE, 1), rs(d, RS.SRCBLEND, 5), rs(d, RS.DESTBLEND, 6),
              draw(d, quad(0, 0, 64, 64, 0.5, 0x80FF0000))],
          probes: [{ at: [32, 32], expect: [128, 0, 127], tolerance: 2 }] },
        { name: "SRCALPHA/INVSRCALPHA with ALPHAARG1 = DIFFUSE set explicitly (a quarter red over blue)",
          clear: 0xFF0000FF,
          body: d => [tss(d, 0, 4, 2), tss(d, 0, 5, 0), rs(d, RS.ALPHABLENDENABLE, 1), rs(d, RS.SRCBLEND, 5),
              rs(d, RS.DESTBLEND, 6), draw(d, quad(0, 0, 64, 64, 0.5, 0x40FF0000))],
          probes: [{ at: [32, 32], expect: [64, 0, 191], tolerance: 2 }] },
        { name: "D3DBLENDOP_REVSUBTRACT is dst - src",
          clear: 0xFF808080,
          body: d => [rs(d, RS.ALPHABLENDENABLE, 1), rs(d, RS.SRCBLEND, 2), rs(d, RS.DESTBLEND, 2),
              rs(d, RS.BLENDOP, 3), draw(d, quad(0, 0, 64, 64, 0.5, 0xFF204000))],
          probes: [{ at: [32, 32], expect: [0x60, 0x40, 0x80], tolerance: 2 }] },
        { name: "D3DBLENDOP_MAX ignores the blend factors (default DESTBLEND is ZERO)",
          ref: "S1-5a", clear: 0xFF0000FF,
          body: d => [rs(d, RS.ALPHABLENDENABLE, 1), rs(d, RS.BLENDOP, 5), draw(d, quad(0, 0, 64, 64, 0.5, 0xFFFF0000))],
          probes: [{ at: [32, 32], expect: [255, 0, 255] }] },
        { name: "D3DBLENDOP_MIN ignores the blend factors",
          ref: "S1-5a", clear: 0xFF808080,
          body: d => [rs(d, RS.ALPHABLENDENABLE, 1), rs(d, RS.SRCBLEND, 5), rs(d, RS.DESTBLEND, 1),
              rs(d, RS.BLENDOP, 4), draw(d, quad(0, 0, 64, 64, 0.5, 0xFFFF4000))],
          probes: [{ at: [32, 32], expect: [0x80, 0x40, 0x00], tolerance: 1 }] },
        { name: "a D3DCOLOR vertex colour is 0xAARRGGBB",
          body: d => [draw(d, quad(0, 0, 64, 64, 0.5, 0xFF336699))],
          probes: [{ at: [32, 32], expect: [0x33, 0x66, 0x99], tolerance: 1 }] },
        { name: "D3DTOP_MODULATE2X doubles DIFFUSE * TFACTOR",
          body: d => [rs(d, RS.TEXTUREFACTOR, 0xFF808080), tss(d, 0, 1, 5), tss(d, 0, 2, 0), tss(d, 0, 3, 3),
              tss(d, 0, 4, 2), tss(d, 0, 5, 0), draw(d, quad(0, 0, 64, 64, 0.5, 0xFF808080))],
          probes: [{ at: [32, 32], expect: [129, 129, 129], tolerance: 2 }] },
        { name: "alpha test GREATER 0x80 discards alpha 0x80 and keeps 0x81",
          body: d => [rs(d, RS.ALPHATESTENABLE, 1), rs(d, RS.ALPHAFUNC, 5), rs(d, RS.ALPHAREF, 0x80),
              rs(d, RS.ZENABLE, 0), draw(d, quad(0, 0, 32, 64, 0.5, 0x80FF0000)),
              draw(d, quad(32, 0, 64, 64, 0.5, 0x8100FF00))],
          probes: [{ at: [16, 32], expect: [0, 0, 0] }, { at: [48, 32], expect: [0, 255, 0] }] },
        { name: "pixel centres are at integer coordinates (a [0.5,1.5) quad covers pixel 1,1 only)",
          body: d => [draw(d, quad(0.5, 0.5, 1.5, 1.5, 0.5, 0xFFFFFFFF))],
          probes: [{ at: [1, 1], expect: [255, 255, 255] }, { at: [0, 0], expect: [0, 0, 0] },
              { at: [2, 2], expect: [0, 0, 0] }] },
        { name: "COLORWRITEENABLE = RED leaves green and blue alone",
          clear: 0xFF0000FF,
          body: d => [rs(d, RS.COLORWRITEENABLE, 1), draw(d, quad(0, 0, 64, 64, 0.5, 0xFFFFFFFF))],
          probes: [{ at: [32, 32], expect: [255, 0, 255] }] },
        { name: "vertex fog on pre-transformed vertices takes the factor from specular alpha",
          body: d => [rs(d, RS.FOGENABLE, 1), rs(d, RS.FOGCOLOR, 0x0000FF00), rs(d, RS.FOGTABLEMODE, 0),
              rs(d, RS.FOGVERTEXMODE, 0), draw(d, quad(0, 0, 32, 64, 0.5, 0xFFFF0000, 0x00000000)),
              draw(d, quad(32, 0, 64, 64, 0.5, 0xFFFF0000, 0xFF000000))],
          probes: [{ at: [16, 32], expect: [0, 255, 0], tolerance: 2 }, { at: [48, 32], expect: [255, 0, 0], tolerance: 2 }] },
        { name: "D3DSHADE_FLAT takes the first vertex's colour",
          body: d => [rs(d, RS.SHADEMODE, 1), draw(d, [[0, 0, 0.5, 0xFFFF0000], [64, 0, 0.5, 0xFF00FF00],
              [0, 64, 0.5, 0xFF0000FF]])],
          probes: [{ at: [8, 8], expect: [255, 0, 0] }] },
        { name: "D3DRS_SPECULARENABLE adds the specular colour after the cascade",
          body: d => [rs(d, RS.SPECULARENABLE, 1), draw(d, quad(0, 0, 64, 64, 0.5, 0xFFFF0000, 0x000000FF))],
          probes: [{ at: [32, 32], expect: [255, 0, 255] }] },
        { name: "SPECULARENABLE off ignores the specular colour",
          body: d => [draw(d, quad(0, 0, 64, 64, 0.5, 0xFFFF0000, 0x000000FF))],
          probes: [{ at: [32, 32], expect: [255, 0, 0] }] },
        { name: "lines draw with a depth bias set (WebGPU has no bias on lines)",
          ref: "S1-5b",
          body: d => [rs(d, RS.DEPTHBIAS, f(-0.001)),
              draw(d, [[0, 31, 0.5, 0xFF00FF00], [64, 31, 0.5, 0xFF00FF00], [0, 32, 0.5, 0xFF00FF00],
                  [64, 32, 0.5, 0xFF00FF00], [0, 33, 0.5, 0xFF00FF00], [64, 33, 0.5, 0xFF00FF00]], PT.LINELIST),
              draw(d, quad(0, 48, 64, 64, 0.5, 0xFFFF0000))],
          probes: [{ at: [32, 32], expect: [0, 255, 0] }, { at: [32, 56], expect: [255, 0, 0] }] },
        { name: "a second render target the fixed-function stage does not write keeps its contents",
          ref: "S1-5c", mrt: true,
          body: d => [draw(d, quad(0, 0, 64, 64, 0.5, 0xFFFF0000))],
          probes: [{ at: [32, 32], expect: [255, 0, 0] }, { at: [32, 32], expect: [0, 0, 0], target: 1 }] },
        { name: "Clear is clipped to the viewport",
          ref: "S2-1",
          body: d => [viewport(d, 16, 16, 32, 32), clear(d, T, 0xFF00FF00)],
          probes: [{ at: [32, 32], expect: [0, 255, 0] }, { at: [4, 4], expect: [0, 0, 0] },
              { at: [60, 60], expect: [0, 0, 0] }] },
        { name: "Clear is clipped to the scissor rect while the scissor test is on",
          ref: "S2-1",
          body: d => [cmd(OP.SET_SCISSOR_RECT, P.encode("SetScissorRect", { device_handle: d, left: 0, top: 0, right: 32, bottom: 64 })), rs(d, RS.SCISSORTESTENABLE, 1),
              clear(d, T, 0xFF00FF00)],
          probes: [{ at: [16, 32], expect: [0, 255, 0] }, { at: [48, 32], expect: [0, 0, 0] }] },
        { name: "Clear rectangles are clipped to the viewport too",
          ref: "S2-1",
          body: d => [viewport(d, 0, 0, 32, 64), clear(d, T, 0xFF00FF00, 1, [[16, 16, 48, 48]])],
          probes: [{ at: [24, 32], expect: [0, 255, 0] }, { at: [40, 32], expect: [0, 0, 0] }] },
        { name: "ordinary XYZ with MinZ = MaxZ = 0 draws on the near plane",
          ref: "S2-7",
          body: d => [viewport(d, 0, 0, W, W, 0, 0), ...drawXYZ(d, fullXYZ(0.9, 0xFFFF0000)),
              viewport(d, 0, 0, W, W, 0, 1), rs(d, RS.ZFUNC, 2), ...drawXYZ(d, fullXYZ(0.1, 0xFF00FF00))],
          probes: [{ at: [32, 32], expect: [255, 0, 0] }] },
        { name: "a predicated instruction writes each component its predicate component allows",
          ref: "S2-9",
          body: d => {
              const { OP: O, REG, ins, dst, src, def } = asm;
              const tokens = [0xFFFF0201,   // ps_2_x
                  ...def(0, 1, 0, 1, 0), ...def(1, 0.5, 0.5, 0.5, 0.5), ...def(2, 0, 0, 0, 1), ...def(3, 1, 1, 1, 1),
                  ins(O.SETP, 3, { control: 1 }), dst(REG.PREDICATE, 0), src(REG.CONST, 0), src(REG.CONST, 1),
                  ins(O.MOV, 2), dst(REG.TEMP, 0), src(REG.CONST, 2),
                  ins(O.MOV, 3, { predicated: true }), dst(REG.TEMP, 0, 0x7), src(REG.PREDICATE, 0), src(REG.CONST, 3),
                  ins(O.MOV, 2), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
                  0x0000FFFF];
              return [pixelShader(d, 0x40000001, tokens), cmd(OP.SET_PIXEL_SHADER, P.encode("SetShader", { device_handle: d, shader_handle: 0x40000001 })),
                  draw(d, quad(0, 0, 64, 64, 0.5, 0xFFFFFFFF))];
          },
          probes: [{ at: [32, 32], expect: [255, 0, 255] }] },
        { name: "rcp(0) is the largest float, not 0",
          body: d => {
              const { OP: O, REG, ins, dst, src, def } = asm;
              const tokens = [0xFFFF0200,   // ps_2_0: min(rcp(0), 1) is white
                  ...def(0, 0, 0, 0, 0), ...def(1, 1, 1, 1, 1),
                  ins(O.RCP, 2), dst(REG.TEMP, 0), src(REG.CONST, 0, 0x00),
                  ins(O.MIN, 3), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.CONST, 1),
                  ins(O.MOV, 2), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
                  0x0000FFFF];
              return [pixelShader(d, 0x40000003, tokens), cmd(OP.SET_PIXEL_SHADER, P.encode("SetShader", { device_handle: d, shader_handle: 0x40000003 })),
                  draw(d, quad(0, 0, 64, 64, 0.5, 0xFF000000))];
          },
          probes: [{ at: [32, 32], expect: [255, 255, 255] }] },
        { name: "linear vertex fog: (END - d) / (END - START) of the vertex colour",
          body: d => [rs(d, RS.FOGENABLE, 1), rs(d, RS.FOGCOLOR, 0x0000FF00), rs(d, RS.FOGVERTEXMODE, 3),
              rs(d, RS.FOGSTART, f(0)), rs(d, RS.FOGEND, f(1)), ...drawXYZ(d, fullXYZ(0.25, 0xFFFF0000))],
          probes: [{ at: [32, 32], expect: [191, 64, 0], tolerance: 2 }] },
        { name: "lit: no specular when N.L is not positive",
          body: d => {
              const { OP: O, REG, ins, dst, src, def } = asm;
              const D = 0x80000000;   // dcl_position
              const tokens = [0xFFFE0200,   // vs_2_0: oD0 = lit(N.L -0.5, N.H 0.5, power 1).z
                  ins(O.DCL, 2), D, dst(REG.INPUT, 0),
                  ...def(0, -0.5, 0.5, 0, 1),
                  ins(O.LIT, 2), dst(REG.TEMP, 0), src(REG.CONST, 0),
                  ins(O.MOV, 2), dst(REG.RASTOUT, 0), src(REG.INPUT, 0),
                  ins(O.MOV, 2), dst(REG.ATTROUT, 0), src(REG.TEMP, 0, 0xAA),
                  0x0000FFFF];
              return [vertexShader(d, 0x40000005, tokens), cmd(OP.SET_VERTEX_SHADER, P.encode("SetShader", { device_handle: d, shader_handle: 0x40000005 })),
                  ...drawXYZ(d, fullXYZ(0.5, 0xFFFFFFFF))];
          },
          probes: [{ at: [32, 32], expect: [0, 0, 0] }] },
        { name: "a DirectDraw source colour key keeps the destination where the source is the key colour",
          body: (d, rt) => [
              cmd(OP.CREATE_TEXTURE_2D, P.encode("CreateTexture2D", { device_handle: d, resource_handle: rt + 1, width: W, height: W, level_count: 1, format: 22, usage: 0, pool: 0, multisample_type: 0, multisample_quality: 0 })),
              cmd(OP.COLOR_FILL, P.encode("ColorFill", { device_handle: d, texture_handle: rt + 1, level: 0, color: 0xFF00FF00, left: 0, top: 0, right: 32, bottom: 64, face: 0 }).subarray(0, 36)),
              cmd(OP.COLOR_FILL, P.encode("ColorFill", { device_handle: d, texture_handle: rt + 1, level: 0, color: 0xFF0000FF, left: 32, top: 0, right: 64, bottom: 64, face: 0 }).subarray(0, 36)),
              cmd(OP.DD_SET_COLOR_KEY, P.encode("DDSetColorKey", { surface_handle: rt + 1, key_kind: 0, color_low: 0x0000FF00, color_high: 0x0000FF00, present: 1, reserved: 0 })),
              cmd(OP.DD_BLT, P.encode("DDBlt", { device_handle: d, source_handle: rt + 1, source_level: 0, source_face: 0, source_rect: [0, 0, W, W], destination_handle: rt, destination_level: 0, destination_face: 0, flags: 1, destination_rect: [0, 0, W, W], fill_color: 0, fill_depth: 0, fill_stencil: 0, reserved: 0 }))],
          probes: [{ at: [16, 32], expect: [0, 0, 0] }, { at: [48, 32], expect: [0, 0, 255] }] },
        { name: "4x MSAA back buffer: a draw reaches the screen",
          ref: "S1-6", msaa: 4, backBuffer: true,
          body: d => [draw(d, quad(0, 0, 64, 64, 0.5, 0xFF00FF00))],
          probes: [{ at: [32, 32], expect: [0, 255, 0] }] },
        { name: "4x MSAA: a draw reaches the render target through the resolve",
          ref: "S1-6", msaa: 4,
          body: d => [draw(d, quad(0, 0, 64, 64, 0.5, 0xFFFF0000))],
          probes: [{ at: [32, 32], expect: [255, 0, 0] }] },
        { name: "4x MSAA: pixels on a triangle's edge are partly covered",
          ref: "S1-6", msaa: 4,
          body: d => [draw(d, [[0, 0, 0.5, 0xFFFF0000], [64, 0, 0.5, 0xFFFF0000], [0, 64, 0.5, 0xFFFF0000]])],
          probes: [{ at: [8, 8], expect: [255, 0, 0] }, { at: [60, 60], expect: [0, 0, 0] },
              { row: 32, someRedBetween: [32, 224] }] },
        { name: "4x MSAA with MULTISAMPLEANTIALIAS off still writes the whole pixel",
          ref: "S2-24", msaa: 4,
          body: d => [rs(d, RS.MULTISAMPLEANTIALIAS, 0), draw(d, quad(0, 0, 64, 64, 0.5, 0xFFFF0000))],
          probes: [{ at: [32, 32], expect: [255, 0, 0] }] },
        { name: "4x MSAA: a ColorFill between draws survives the next pass",
          ref: "S1-6", msaa: 4,
          body: (d, rt) => [draw(d, quad(0, 0, 64, 64, 0.5, 0xFFFF0000)),
              cmd(OP.COLOR_FILL, P.encode("ColorFill", { device_handle: d, texture_handle: rt, level: 0, color: 0xFF00FF00, left: 0, top: 0, right: 64, bottom: 64, face: 0 }).subarray(0, 36)),
              draw(d, quad(0, 0, 16, 16, 0.5, 0xFF0000FF))],
          probes: [{ at: [32, 32], expect: [0, 255, 0] }, { at: [8, 8], expect: [0, 0, 255] }] },
    ];

    const KNOWN_FAILURES = {};

    // The setup every case starts from: device `dev`, render target(s), full
    // viewport, a clear, lighting off, the pre-transformed FVF
    function prologue(dev, rt, c) {
        // `msaa`: the device (so its auto depth) and the target multisampled
        const samples = c.msaa || 0;
        // `backBuffer`: draw into the device's implicit back buffer instead
        const commands = [
            cmd(OP.CREATE_DEVICE, P.encode("CreateDevice", { device_handle: dev, hwnd: 0x1234, x: 0, y: 0, width: W, height: W, backbuffer_format: 22, windowed: 1, behavior_flags: 0x20, enable_auto_depth_stencil: 1, auto_depth_stencil_format: 75, multisample_type: samples, multisample_quality: 0 })),
        ];
        if (!c.backBuffer) {
            commands.push(cmd(OP.CREATE_TEXTURE_2D, P.encode("CreateTexture2D", { device_handle: dev, resource_handle: rt, width: W, height: W, level_count: 1, format: c.targetFormat || 21, usage: 1, pool: 0, multisample_type: samples, multisample_quality: 0 })),
                cmd(OP.SET_RENDER_TARGET, P.encode("SetRenderTarget", { device_handle: dev, target_index: 0, color_texture_handle: rt, color_level: 0, color_face: 0 })));
        }
        if (c.mrt) {
            commands.push(cmd(OP.CREATE_TEXTURE_2D, P.encode("CreateTexture2D", { device_handle: dev, resource_handle: rt + 1, width: W, height: W, level_count: 1, format: 21, usage: 1, pool: 0, multisample_type: 0, multisample_quality: 0 })),
                cmd(OP.SET_RENDER_TARGET, P.encode("SetRenderTarget", { device_handle: dev, target_index: 1, color_texture_handle: rt + 1, color_level: 0, color_face: 0 })));
        }
        commands.push(viewport(dev, 0, 0, W, W),
            clear(dev, T | Z, c.clear === undefined ? 0xFF000000 : c.clear),
            cmd(OP.BEGIN_SCENE, P.encode("DeviceOnly", { device_handle: dev }).subarray(0, 4)),
            rs(dev, RS.LIGHTING, 0),
            cmd(OP.SET_FVF, cat([P.encode("SetFVF", { device_handle: dev, fvf: FVF, element_count: ELEMENTS.length, reserved: 0 }), ...ELEMENTS])));
        return commands;
    }

    function caseBatch(index, c) {
        const dev = 0x100002 + index * 0x10, rt = 0x200000 + index * 2;
        return { dev, rt, bytes: batch(index + 1, [...prologue(dev, rt, c), ...c.body(dev, rt),
            cmd(OP.END_SCENE, P.encode("DeviceOnly", { device_handle: dev }).subarray(0, 4)), cmd(OP.PRESENT, P.encode("Present", { device_handle: dev, hwnd: 0x1234, x: 0, y: 0, width: W, height: W }))], true) };
    }

    function readbackBatch(session, dev, texture) {
        const P = global.D9WGProtocol, C = P.C;
        return batch(session, [cmd(P.OP.READBACK_SURFACE, P.encode("ReadbackSurface", {
            device_handle: dev, texture_handle: texture, format: 21, width: W, height: W,
            first_row: 0, row_count: W, destination_pitch: W * 4, destination_bytes: W * W * 4,
            response_offset: C.D9WG_READBACK_REGION_OFFSET, request_id: 1,
        }))], false);
    }

    global.D3D9Conformance = { CASES, KNOWN_FAILURES, caseBatch, readbackBatch, W,
        builders: { cmd, draw, quad, rs, tss, drawXYZ, fullXYZ, f, cat, element, pixelShader, vertexShader, asm } };
})(typeof globalThis !== "undefined" ? globalThis : this);
