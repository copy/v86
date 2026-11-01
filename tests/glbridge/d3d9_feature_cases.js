// Independent, specification-derived pixel tables. No executor helpers are used.
// References: Microsoft D3DFORMAT, D3DTEXTUREOP and Fog Formulas (Direct3D 9);
// Wine 66caeb46 dlls/wined3d/utils.c format swizzles, dlls/d3d9/tests/visual.c.
"use strict";
(function(global) {
    const suite = global.D3D9Conformance, P = global.D9WGProtocol;
    const { cmd, draw, quad, rs, tss, drawXYZ, fullXYZ, f, cat, element, pixelShader, vertexShader, asm } = suite.builders;
    // Resolve command payload names through the protocol's generated metadata.
    const opcodes = {};
    for (const [op, entry] of Object.entries(P.COMMANDS)) opcodes[Array.isArray(entry) ? entry[0] : entry] = P.OP[op];
    const wire = (name, values, blobs = []) => {
        for (const key of Object.keys(values)) if (!(key in P.F[name])) throw new Error("Unknown fixture field " + name + "." + key);
        return cmd(opcodes[name], P.encode(name, values), blobs);
    };
    const blob = (name, field, data) => ({ offsetField: field, data });
    const fourcc = text => [...text].reduce((n, c, i) => n + c.charCodeAt(0) * 2 ** (i * 8), 0) >>> 0;
    const le16 = (...values) => { const data = new Uint8Array(values.length * 2);values.forEach((v, i) => new DataView(data.buffer).setUint16(i * 2, v, true));return [...data]; };
    const le32 = (...values) => { const data = new Uint8Array(values.length * 4);values.forEach((v, i) => new DataView(data.buffer).setUint32(i * 4, v, true));return [...data]; };
    const floats = (...values) => le32(...values.map(f));
    const clamp = x => Math.round(Math.min(1, Math.max(0, x)) * 255);
    const groups = {}, add = (group, item, known) => {
        item.group = group;(groups[group] ||= []).push(item);suite.CASES.push(item);
        if (known) suite.KNOWN_FAILURES[item.name] = known;
    };
    // Each 4x4 texture is constant, so addressing/filtering cannot affect the
    // format oracle. Sample all RGBA channels, including undefined-channel 1s.
    const formats = [
        ["R8G8B8", 20, [0x33, 0x66, 0x99], [153, 102, 51, 255]],
        ["A8R8G8B8", 21, [0x33, 0x66, 0x99, 0x80], [153, 102, 51, 128]],
        ["X8R8G8B8", 22, [0x33, 0x66, 0x99, 0], [153, 102, 51, 255]],
        ["R5G6B5", 23, le16(0xf800), [255, 0, 0, 255]],
        ["X1R5G5B5", 24, le16(0x7c00), [255, 0, 0, 255]],
        ["A1R5G5B5", 25, le16(0xfc00), [255, 0, 0, 255]],
        ["A4R4G4B4", 26, le16(0x8f00), [255, 0, 0, 136]],
        ["R3G3B2", 27, [0xe0], [255, 0, 0, 255]],
        ["A8", 28, [128], [0, 0, 0, 128]],
        ["A8R3G3B2", 29, [0xe0, 128], [255, 0, 0, 128]],
        ["X4R4G4B4", 30, le16(0x0f00), [255, 0, 0, 255]],
        ["A2B10G10R10", 31, le32(0xc00003ff), [255, 0, 0, 255]],
        ["A8B8G8R8", 32, [153, 102, 51, 128], [153, 102, 51, 128]],
        ["X8B8G8R8", 33, [153, 102, 51, 0], [153, 102, 51, 255]],
        ["G16R16", 34, le16(65535, 0), [255, 0, 255, 255]],
        ["A2R10G10B10", 35, le32(0xfff00000), [255, 0, 0, 255]],
        ["A16B16G16R16", 36, le16(65535, 0, 0, 65535), [255, 0, 0, 255]],
        ["A8P8", 40, [1, 128], [153, 102, 51, 128]],
        ["P8", 41, [1], [153, 102, 51, 255]],
        ["L8", 50, [128], [128, 128, 128, 255]],
        ["A8L8", 51, [128, 64], [128, 128, 128, 64]],
        ["A4L4", 52, [0x48], [136, 136, 136, 68]],
        ["V8U8", 60, [127, 0], [255, 0, 255, 255]],
        ["L6V5U5", 61, le16(0xfc0f), [255, 0, 255, 255]],
        ["X8L8V8U8", 62, [127, 0, 128, 0], [255, 0, 128, 255]],
        ["Q8W8V8U8", 63, [127, 0, 0, 127], [255, 0, 0, 255]],
        ["V16U16", 64, le16(32767, 0), [255, 0, 255, 255]],
        ["A2W10V10U10", 67, le32(0xc00001ff), [255, 0, 0, 255]],
        ["L16", 81, le16(32896), [128, 128, 128, 255]],
        ["Q16W16V16U16", 110, le16(32767, 0, 0, 32767), [255, 0, 0, 255]],
        ["R16F", 111, le16(0x3800), [128, 255, 255, 255]],
        ["G16R16F", 112, le16(0x3800, 0x3400), [128, 64, 255, 255]],
        ["A16B16G16R16F", 113, le16(0x3800, 0x3400, 0, 0x3c00), [128, 64, 0, 255]],
        ["R32F", 114, floats(0.5), [128, 255, 255, 255]],
        ["G32R32F", 115, floats(0.5, 0.25), [128, 64, 255, 255]],
        ["A32B32G32R32F", 116, floats(0.5, 0.25, 0, 1), [128, 64, 0, 255]],
        ["CxV8U8", 117, [0, 0], [0, 0, 255, 255]],
        ["UYVY", fourcc("UYVY"), [128, 16, 128, 16], [0, 0, 0, 255], "pair"],
        ["YUY2", fourcc("YUY2"), [16, 128, 16, 128], [0, 0, 0, 255], "pair"],
        ["R8G8_B8G8", fourcc("RGBG"), [153, 102, 51, 102], [153, 102, 51, 255], "pair"],
        ["G8R8_G8B8", fourcc("GRGB"), [102, 153, 102, 51], [153, 102, 51, 255], "pair"],
    ];
    const redBlock = [0, 248, 0, 0, 0, 0, 0, 0];
    formats.push(["DXT1", fourcc("DXT1"), redBlock, [255, 0, 0, 255], "block"]);
    for (const name of ["DXT2", "DXT3", "DXT4", "DXT5"]) formats.push([name, fourcc(name),
        [...(name === "DXT2" || name === "DXT3" ? new Array(8).fill(255) : [255, 0, 0, 0, 0, 0, 0, 0]), ...redBlock], [255, 0, 0, 255], "block"]);
    // Wine's D3D swizzles: ATI1N XXXX, ATI2N YX11. The asymmetric blocks
    // distinguish the legacy ATI2N channel order from modern BC5's XY order.
    formats.push(["ATI1N", fourcc("ATI1"), [128, 0, 0, 0, 0, 0, 0, 0], [128, 128, 128, 128], "block"],
        ["ATI2N", fourcc("ATI2"), [255, 0, 0, 0, 0, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0], [64, 255, 255, 255], "block"]);

    function texture(dev, handle, spec) {
        const [, format, pattern, , layout] = spec, repeat = layout === "block" ? 1 : layout === "pair" ? 8 : 16;
        const data = Uint8Array.from(new Array(repeat).fill(pattern).flat()), pitch = layout === "block" ? pattern.length : data.length / 4;
        const commands = [wire("CreateTexture2D", { device_handle: dev, resource_handle: handle, width: 4, height: 4, level_count: 1, format })];
        if (format === 40 || format === 41) {
            const palette = new Uint8Array(1024);new DataView(palette.buffer).setUint32(4, 0xff996633, true);
            commands.push(wire("SetPalette", { device_handle: dev, entry_count: 256 }, [blob("SetPalette", "data_offset", palette)]),
                wire("SetCurrentTexturePalette", { device_handle: dev }));
        }
        commands.push(wire("UpdateTexture", { resource_handle: handle, width: 4, height: 4, depth: 1, row_pitch: pitch, slice_pitch: data.length, data_bytes: data.length }, [blob("UpdateTexture", "data_offset", data)]),
            wire("SetTexture", { device_handle: dev, texture_handle: handle }),
            tss(dev, 0, 1, 2), tss(dev, 0, 2, 2), tss(dev, 0, 4, 2), tss(dev, 0, 5, 2));
        return commands;
    }
    function texturedQuad(dev, uv = 0.5) {
        const list = quad(0, 0, 64, 64, 0.5, 0xffffffff), data = new Uint8Array(list.length * 32), view = new DataView(data.buffer);
        list.forEach((v, i) => {
            [v[0], v[1], v[2], 1].forEach((x, j) => view.setFloat32(i * 32 + j * 4, x, true));
            view.setUint32(i * 32 + 16, 0xffffffff, true);view.setFloat32(i * 32 + 24, uv, true);view.setFloat32(i * 32 + 28, uv, true);
        });
        return [cmd(P.OP.SET_FVF, cat([P.encode("SetFVF", { device_handle: dev, fvf: 0x1c4, element_count: 4 }),
            element(0, 3, 9), element(16, 4, 10), element(20, 4, 10, 1), element(24, 1, 5)])),
        wire("DrawPrimitiveUP", { device_handle: dev, primitive_type: 4, primitive_count: 2, stride: 32, vertex_count: 6, vertex_bytes: data.length }, [blob("DrawPrimitiveUP", "vertex_data_offset", data)])];
    }
    for (const spec of formats) add("formats", { name: "format " + spec[0] + " sampled RGBA", formatName: spec[0], format: spec[1],
        body: dev => [...texture(dev, dev + 0x500000, spec), ...texturedQuad(dev)],
        probes: [{ at: [32, 32], expect: spec[3], tolerance: 1 }] });

    for (const [name, format, value, rgba] of [
        ["R5G6B5", 23, (4 << 11) | (16 << 5) | 4, [33, 65, 33, 255]],
        ["X1R5G5B5", 24, (4 << 10) | (8 << 5) | 16, [33, 66, 132, 255]],
        ["A1R5G5B5", 25, 0x8000 | (4 << 10) | (8 << 5) | 16, [33, 66, 132, 255]],
    ]) add("formats", { name: "format " + name + " mid-range bit replication", body: dev => [
        ...texture(dev, dev + 0x500000, [name, format, le16(value), rgba]), ...texturedQuad(dev)],
        probes: [{ at: [32, 32], expect: rgba, tolerance: 0 }] });

    const { OP: S, REG: R, ins, dst, src, def } = asm;
    const samplePS = [0xffff0300,
        ins(S.DCL, 2), 0x80000005, dst(R.INPUT, 0),
        ins(S.DCL, 2), 0x90000000, dst(R.SAMPLER, 0),
        ins(S.TEX, 3), dst(R.TEMP, 0), src(R.INPUT, 0), src(R.SAMPLER, 0),
        ins(S.MOV, 2), dst(R.COLOROUT, 0), src(R.TEMP, 0), 0xffff];
    const sampleVS = [0xfffe0300,
        ins(S.DCL, 2), 0x80000000, dst(R.INPUT, 0),
        ins(S.DCL, 2), 0x80000000, dst(R.OUTPUT, 0),
        ins(S.DCL, 2), 0x8000000a, dst(R.OUTPUT, 1),
        ins(S.DCL, 2), 0x90000000, dst(R.SAMPLER, 0), ...def(0, 0.5, 0.5, 0, 0),
        ins(S.TEXLDL, 3), dst(R.TEMP, 0), src(R.CONST, 0), src(R.SAMPLER, 0),
        ins(S.MOV, 2), dst(R.OUTPUT, 0), src(R.INPUT, 0),
        ins(S.MOV, 2), dst(R.OUTPUT, 1), src(R.TEMP, 0), 0xffff];
    const bindPS = (dev, handle) => cmd(P.OP.SET_PIXEL_SHADER, P.encode("SetShader", { device_handle: dev, shader_handle: handle }));
    for (const spec of formats.filter(s => [111, 112, 114, 115, fourcc("ATI1"), fourcc("ATI2")].includes(s[1]))) {
        add("formats", { name: "programmable pixel sample " + spec[0] + " RGBA", body: dev => [
            ...texture(dev, dev + 0x500000, spec), pixelShader(dev, dev + 0x600000, samplePS), bindPS(dev, dev + 0x600000),
            ...texturedQuad(dev)], probes: [{ at: [32, 32], expect: spec[3], tolerance: 1 }] });
        if (spec[1] < 1000) add("formats", { name: "vertex texture sample " + spec[0] + " RGBA", body: dev => [
            ...texture(dev, dev + 0x500000, spec),
            cmd(P.OP.SET_TEXTURE, P.encode("SetTexture", { device_handle: dev, stage: 257, texture_handle: dev + 0x500000 })),
            vertexShader(dev, dev + 0x600000, sampleVS),
            cmd(P.OP.SET_VERTEX_SHADER, P.encode("SetShader", { device_handle: dev, shader_handle: dev + 0x600000 })),
            tss(dev, 0, 2, 0), tss(dev, 0, 5, 0), ...drawXYZ(dev, fullXYZ(0.5, 0xffffffff))],
            probes: [{ at: [32, 32], expect: spec[3], tolerance: 1 }] });
    }
    add("formats", { name: "pixel sampler swizzle follows R16F to G16R16F and back", body: dev => {
        const r = formats.find(s => s[1] === 111), rg = formats.find(s => s[1] === 112), a = dev + 0x500000, b = a + 1;
        return [...texture(dev, a, r), pixelShader(dev, dev + 0x600000, samplePS), bindPS(dev, dev + 0x600000), ...texturedQuad(dev),
            ...texture(dev, b, rg), rs(dev, 174, 1), wire("SetScissorRect", { device_handle: dev, left: 32, right: 64, bottom: 64 }), ...texturedQuad(dev),
            cmd(P.OP.SET_TEXTURE, P.encode("SetTexture", { device_handle: dev, stage: 0, texture_handle: a })),
            wire("SetScissorRect", { device_handle: dev, right: 16, bottom: 16 }), ...texturedQuad(dev)];
    }, probes: [{ at: [8, 8], expect: [128, 255, 255, 255], tolerance: 1 },
        { at: [8, 48], expect: [128, 255, 255, 255], tolerance: 1 }, { at: [48, 32], expect: [128, 64, 255, 255], tolerance: 1 }] });

    add("resources", { name: "render-target texture upload stays between two sampling draws", body: dev => {
        const handle = dev + 0x500000;
        const setup = texture(dev, handle, ["A8R8G8B8", 21, [0, 0, 255, 255]]);
        setup[0] = wire("CreateTexture2D", { device_handle: dev, resource_handle: handle, width: 4, height: 4, level_count: 1, format: 21, usage: 1 });
        return [...setup, rs(dev, 174, 1), wire("SetScissorRect", { device_handle: dev, right: 32, bottom: 64 }), ...texturedQuad(dev),
            texture(dev, handle, ["A8R8G8B8", 21, [0, 255, 0, 255]])[1],
            wire("SetScissorRect", { device_handle: dev, left: 32, right: 64, bottom: 64 }), ...texturedQuad(dev)];
    }, probes: [{ at: [16, 32], expect: [255, 0, 0, 255] }, { at: [48, 32], expect: [0, 255, 0, 255] }] });

    for (const [name, flags] of [["plain", 0], ["DISCARD", 0x2000]]) add("resources", {
        name: "vertex buffer " + name + " uploads stay between draws", body: dev => {
            const handle = dev + 0x700000, a = draw(dev, quad(0, 0, 64, 64, 0.5, 0xffff0000)).blobs[0].data;
            const b = draw(dev, quad(0, 0, 64, 64, 0.5, 0xff00ff00)).blobs[0].data;
            const upload = data => wire("UpdateBuffer", { resource_handle: handle, byte_count: data.length, lock_flags: flags }, [blob("UpdateBuffer", "data_offset", data)]);
            const render = () => wire("DrawPrimitive", { device_handle: dev, primitive_type: 4, primitive_count: 2 });
            return [wire("CreateBuffer", { device_handle: dev, resource_handle: handle, resource_kind: 1, byte_count: a.length }),
                wire("SetStreamSource", { device_handle: dev, buffer_handle: handle, stride: 24 }),
                tss(dev, 0, 1, 2), tss(dev, 0, 2, 0), tss(dev, 0, 4, 2), tss(dev, 0, 5, 0), rs(dev, 174, 1),
                upload(a), wire("SetScissorRect", { device_handle: dev, right: 32, bottom: 64 }), render(),
                upload(b), wire("SetScissorRect", { device_handle: dev, left: 32, right: 64, bottom: 64 }), render()];
        }, probes: [{ at: [16, 32], expect: [255, 0, 0, 255] }, { at: [48, 32], expect: [0, 255, 0, 255] }] });

    // Arg1=DIFFUSE, Arg2=TFACTOR, Arg0=SPECULAR; formula inputs are bytes
    // converted to [0,1]. Alpha is explicit, independent of the unbound bug.
    const a = [64, 128, 192].map(v => v / 255), b = [128, 64, 32].map(v => v / 255), alpha = 64 / 255;
    const operations = [
        [2, "SELECTARG1", (x) => x], [3, "SELECTARG2", (x, y) => y],
        [4, "MODULATE", (x, y) => x * y], [5, "MODULATE2X", (x, y) => 2 * x * y], [6, "MODULATE4X", (x, y) => 4 * x * y],
        [7, "ADD", (x, y) => x + y], [8, "ADDSIGNED", (x, y) => x + y - 0.5], [9, "ADDSIGNED2X", (x, y) => 2 * (x + y - 0.5)],
        [10, "SUBTRACT", (x, y) => x - y], [11, "ADDSMOOTH", (x, y) => x + y - x * y],
        [12, "BLENDDIFFUSEALPHA", (x, y) => x * alpha + y * (1 - alpha)],
        [14, "BLENDFACTORALPHA", (x, y) => x * (128 / 255) + y * (127 / 255)],
        [16, "BLENDCURRENTALPHA", (x, y) => x * alpha + y * (1 - alpha)],
        [18, "MODULATEALPHA_ADDCOLOR", (x, y) => x + alpha * y],
        [19, "MODULATECOLOR_ADDALPHA", (x, y) => x * y + alpha],
        [20, "MODULATEINVALPHA_ADDCOLOR", (x, y) => x + (1 - alpha) * y],
        [21, "MODULATEINVCOLOR_ADDALPHA", (x, y) => (1 - x) * y + alpha],
        [24, "DOTPRODUCT3", () => a.reduce((sum, x, i) => sum + (2 * x - 1) * (2 * b[i] - 1), 0)],
        [25, "MULTIPLYADD", (x, y) => 0.25 + x * y], [26, "LERP", (x, y) => 0.25 * x + 0.75 * y],
    ];
    for (const [op, name, formula] of operations) add("texture-ops", { name: "texture op " + name, textureOp: op,
        body: dev => [rs(dev, 60, 0x80804020), tss(dev, 0, 1, op), tss(dev, 0, 2, 0), tss(dev, 0, 3, 3),
            tss(dev, 0, 26, 4), tss(dev, 0, 4, 2), tss(dev, 0, 5, 0), draw(dev, quad(0, 0, 64, 64, 0.5, 0x404080c0, 0x40404040))],
        probes: [{ at: [32, 32], expect: a.map((x, i) => clamp(formula(x, b[i]))), tolerance: 2 }] });
    // Exact 64/255 rather than 0.25 for SPECULAR's Arg0.
    for (const c of groups["texture-ops"].filter(c => /MULTIPLYADD|LERP/.test(c.name))) {
        const op = c.name.endsWith("LERP") ? (x, y) => alpha * x + (1 - alpha) * y : (x, y) => alpha + x * y;
        c.probes[0].expect = a.map((x, i) => clamp(op(x, b[i])));
    }
    for (const [mode, label, factor] of [[1, "EXP", Math.exp(-0.5)], [2, "EXP2", Math.exp(-0.25)], [3, "LINEAR", 0.5]]) {
        for (const table of [false, true]) add("fog", { name: (table ? "table" : "vertex") + " fog " + label,
            body: dev => [rs(dev, 28, 1), rs(dev, 34, 0x0000ff00), rs(dev, 35, table ? mode : 0), rs(dev, 140, table ? 0 : mode),
                rs(dev, 36, f(0)), rs(dev, 37, f(1)), rs(dev, 38, f(1)), ...drawXYZ(dev, fullXYZ(0.5, 0xffff0000))],
            probes: [{ at: [32, 32], expect: [clamp(factor), clamp(1 - factor), 0], tolerance: 2 }] });
    }
    add("srgb", { name: "sRGB texture read decodes 128 to linear 55", body: dev => [
        ...texture(dev, dev + 0x500000, ["A8R8G8B8", 21, [128, 128, 128, 255]]),
        wire("SetSamplerState", { device_handle: dev, state: 11, value: 1 }), ...texturedQuad(dev)],
    probes: [{ at: [32, 32], expect: [55, 55, 55, 255], tolerance: 1 }] });
    add("srgb", { name: "sRGB render target write encodes linear 128 to 188", body: dev => [rs(dev, 194, 1), draw(dev, quad(0, 0, 64, 64, 0.5, 0xff808080))],
        probes: [{ at: [32, 32], expect: [188, 188, 188], tolerance: 1 }] });

    add("texture-ops", { name: "DOTPRODUCT3 colour overrides separate alpha operation", textureOp: 24, body: dev => [rs(dev, 60, 0x80804020),
        tss(dev, 0, 1, 24), tss(dev, 0, 2, 0), tss(dev, 0, 3, 3), tss(dev, 0, 4, 2), tss(dev, 0, 5, 0),
        draw(dev, quad(0, 0, 64, 64, 0.5, 0x404080c0))], probes: [{ at: [32, 32], expect: [0, 0, 0, 0] }] });
    add("texture-ops", { name: "DISABLE stage zero keeps diffuse", textureOp: 1, body: dev => [tss(dev, 0, 1, 1), draw(dev, quad(0, 0, 64, 64, 0.5, 0x404080c0))],
        probes: [{ at: [32, 32], expect: [64, 128, 192, 64] }] });
    for (const [op, name, formula] of [[13, "BLENDTEXTUREALPHA", (x, y) => x * (128 / 255) + y * (127 / 255)],
        [15, "BLENDTEXTUREALPHAPM", (x, y) => x + y * (127 / 255)]]) add("texture-ops", { name: "texture op " + name, textureOp: op,
        body: dev => [...texture(dev, dev + 0x500000, ["A8R8G8B8", 21, [255, 255, 255, 128]]),
            rs(dev, 60, 0x80804020), tss(dev, 0, 1, op), tss(dev, 0, 2, 0), tss(dev, 0, 3, 3), tss(dev, 0, 4, 2), tss(dev, 0, 5, 0),
            draw(dev, quad(0, 0, 64, 64, 0.5, 0x404080c0))],
        probes: [{ at: [32, 32], expect: a.map((x, i) => clamp(formula(x, b[i]))), tolerance: 2 }] });

    function litQuad(dev, diffuse = 0xff00ff00, colour = true) {
        const stride = colour ? 28 : 24, list = fullXYZ(0.5, diffuse), data = new Uint8Array(list.length * stride), view = new DataView(data.buffer);
        list.forEach((v, i) => {
            [v[0], v[1], v[2], 0, 0, -1].forEach((x, j) => view.setFloat32(i * stride + j * 4, x, true));
            if (colour) view.setUint32(i * stride + 24, diffuse, true);
        });
        return [cmd(P.OP.SET_FVF, cat([P.encode("SetFVF", { device_handle: dev, fvf: colour ? 0x52 : 0x12, element_count: colour ? 3 : 2 }),
            element(0, 2, 0), element(12, 2, 3), ...(colour ? [element(24, 4, 10)] : [])])),
        wire("DrawPrimitiveUP", { device_handle: dev, primitive_type: 4, primitive_count: 2, stride, vertex_count: 6, vertex_bytes: data.length }, [blob("DrawPrimitiveUP", "vertex_data_offset", data)])];
    }
    const material = (dev, values) => wire("SetMaterial", { device_handle: dev, diffuse: [0, 0, 0, 1], ambient: [0, 0, 0, 1], specular: [0, 0, 0, 1], emissive: [0, 0, 0, 1], ...values });
    add("lighting", { name: "lighting emissive material is independent of ambient and diffuse", body: dev => [rs(dev, 137, 1), rs(dev, 141, 0),
        material(dev, { emissive: [0.25, 0.5, 0.75, 1] }), ...litQuad(dev)], probes: [{ at: [32, 32], expect: [64, 128, 191], tolerance: 1 }] });
    for (const colorVertex of [0, 1]) add("lighting", { name: "ambient material source COLOR1 with COLORVERTEX " + colorVertex,
        body: dev => [rs(dev, 137, 1), rs(dev, 139, 0xffffffff), rs(dev, 141, colorVertex), rs(dev, 147, 1),
            material(dev, { ambient: [1, 0, 0, 1] }), ...litQuad(dev)],
        probes: [{ at: [32, 32], expect: colorVertex ? [0, 255, 0] : [255, 0, 0] }] });
    for (const type of [1, 2, 3]) add("lighting", { name: ["", "point", "spot", "directional"][type] + " light diffuse material",
        body: dev => [rs(dev, 137, 1), rs(dev, 141, 0), material(dev, { diffuse: [1, 0, 0, 1] }),
            wire("SetLight", { device_handle: dev, type, diffuse: [1, 1, 1, 1], position: [0, 0, -1], direction: [0, 0, 1], range: 100, falloff: 1,
                attenuation: [1, 0, 0], theta: Math.PI / 2, phi: Math.PI }), wire("LightEnable", { device_handle: dev, enable: 1 }), ...litQuad(dev)],
        // The central sample interpolates vertex lighting. All quad corners
        // have equal distance/angle; directional is exactly one, point/spot
        // use N.L = 1.5 / sqrt(1+1+1.5^2).
        probes: [{ at: [32, 32], expect: [type === 3 ? 255 : clamp(1.5 / Math.sqrt(4.25)), 0, 0], tolerance: 2 }] });

    add("lighting", { name: "missing vertex COLOR1 falls back to diffuse material", body: dev => [rs(dev, 137, 1), rs(dev, 141, 1), rs(dev, 145, 1),
        material(dev, { diffuse: [1, 0, 0, 1] }), wire("SetLight", { device_handle: dev, type: 3, diffuse: [1, 1, 1, 1], direction: [0, 0, 1] }),
        wire("LightEnable", { device_handle: dev, enable: 1 }), ...litQuad(dev, 0, false)], probes: [{ at: [32, 32], expect: [255, 0, 0] }] });

    const blit = (dev, source, destination, flags, more = {}) => wire("DDBlt", { device_handle: dev, source_handle: source, source_rect: [0, 0, 64, 64],
        destination_handle: destination, destination_rect: [0, 0, 64, 64], flags, ...more });
    const indexedPalette = (dev, red, green) => {
        const data = new Uint8Array(1024), view = new DataView(data.buffer);
        view.setUint32(4, red, true);view.setUint32(8, green, true);
        return wire("SetPalette", { device_handle: dev, entry_count: 256 }, [blob("SetPalette", "data_offset", data)]);
    };
    const indexedSource = (dev, handle, pattern = new Array(16).fill(1), sameRgb = false) => [
        wire("CreateTexture2D", { device_handle: dev, resource_handle: handle, width: 4, height: 4, level_count: 1, format: 41, usage: P.C.D9WG_USAGE_DDRAW_INDEXED }),
        wire("UpdateTexture", { resource_handle: handle, width: 4, height: 4, depth: 1, row_pitch: 4, slice_pitch: 16, data_bytes: 16 }, [blob("UpdateTexture", "data_offset", Uint8Array.from(pattern))]),
        indexedPalette(dev, 0xffff0000, sameRgb ? 0xffff0000 : 0xff00ff00),
        wire("DDSetSurfacePalette", { surface_handle: handle, flags: 1 }),
    ];
    const sampleIndexed = (dev, handle) => [wire("SetTexture", { device_handle: dev, texture_handle: handle }),
        tss(dev, 0, 1, 2), tss(dev, 0, 2, 2), tss(dev, 0, 4, 2), tss(dev, 0, 5, 2)];
    add("ddraw", { name: "indexed D3D sampling sees a preceding GPU fill", body: dev => {
        const handle = dev + 0x500000;
        return [...indexedSource(dev, handle), ...sampleIndexed(dev, handle), rs(dev, 174, 1),
            wire("SetScissorRect", { device_handle: dev, right: 32, bottom: 64 }), ...texturedQuad(dev),
            blit(dev, 0, handle, P.C.D9WG_DDBLT_COLOR_FILL, { destination_rect: [0, 0, 4, 4], fill_color: 2 }),
            wire("SetScissorRect", { device_handle: dev, left: 32, right: 64, bottom: 64 }), ...texturedQuad(dev)];
    }, probes: [{ at: [16, 32], expect: [255, 0, 0, 255] }, { at: [48, 32], expect: [0, 255, 0, 255] }] });
    add("ddraw", { name: "indexed blit palette changes stay between blits", body: (dev, rt) => {
        const handle = dev + 0x500000;
        return [...indexedSource(dev, handle),
            blit(dev, handle, rt, 0, { source_rect: [0, 0, 4, 4], destination_rect: [0, 0, 32, 64] }),
            indexedPalette(dev, 0xff00ff00, 0xff00ff00),
            blit(dev, handle, rt, 0, { source_rect: [0, 0, 4, 4], destination_rect: [32, 0, 64, 64] })];
    }, probes: [{ at: [16, 32], expect: [255, 0, 0, 255] }, { at: [48, 32], expect: [0, 255, 0, 255] }] });
    add("ddraw", { name: "indexed D3D key resolves alpha by index with duplicate RGB", body: dev => {
        const handle = dev + 0x500000;
        return [...indexedSource(dev, handle, new Array(4).fill([1, 1, 2, 2]).flat(), true), ...sampleIndexed(dev, handle),
            wire("DDSetColorKey", { surface_handle: handle, key_kind: 0, color_low: 1, color_high: 1, present: 1 }),
            rs(dev, 41, 1), rs(dev, 174, 1), wire("SetScissorRect", { device_handle: dev, right: 32, bottom: 64 }), ...texturedQuad(dev, 0.125),
            wire("SetScissorRect", { device_handle: dev, left: 32, right: 64, bottom: 64 }), ...texturedQuad(dev, 0.875)];
    }, probes: [{ at: [16, 32], expect: [0, 0, 0, 255] }, { at: [48, 32], expect: [255, 0, 0, 255] }] });

    for (const [name, format, fill, expected] of [["A8R8G8B8", 21, 0xff996633, [153, 102, 51, 255]],
        ["X8R8G8B8", 22, 0x00996633, [153, 102, 51, 255]], ["R5G6B5", 23, 0xf800, [255, 0, 0, 255]],
        ["R5G6B5 midrange", 23, 0x2204, [33, 65, 33, 255]], ["X1R5G5B5", 24, 0x7c00, [255, 0, 0, 255]],
        ["A1R5G5B5 transparent", 25, 0x7c00, [255, 0, 0, 0]], ["A4R4G4B4", 26, 0x89ab, [153, 170, 187, 136]],
        ["R8G8B8", 20, 0x996633, [153, 102, 51, 255]], ["X8B8G8R8", 33, 0x00336699, [153, 102, 51, 255]]]) add("ddraw", {
        name: "DirectDraw native " + name + " fill", targetFormat: format,
        body: (dev, rt) => [blit(dev, 0, rt, P.C.D9WG_DDBLT_COLOR_FILL, { fill_color: fill })], probes: [{ at: [32, 32], expect: expected }] });
    add("resources", { name: "D3D9 ColorFill takes D3DCOLOR and forces opaque X8 alpha", targetFormat: 22,
        body: (dev, rt) => [wire("ColorFill", { device_handle: dev, texture_handle: rt, color: 0x00996633, right: 64, bottom: 64 })],
        probes: [{ at: [32, 32], expect: [153, 102, 51, 255] }] });
    for (const destination of [false, true]) for (const key of [0x336699, 0x33669a, 0x33669b]) add("ddraw", {
        name: "DirectDraw " + (destination ? "destination" : "source") + " inclusive key " + key.toString(16),
        body: (dev, rt) => {
            const source = rt + 1;
            return [wire("CreateTexture2D", { device_handle: dev, resource_handle: source, width: 64, height: 64, level_count: 1, format: 21 }),
                wire("ColorFill", { device_handle: dev, texture_handle: source, color: (destination ? 0xff00ff00 : 0xff000000 | key) >>> 0, right: 64, bottom: 64 }),
                ...(destination ? [wire("ColorFill", { device_handle: dev, texture_handle: rt, color: (0xff000000 | key) >>> 0, right: 64, bottom: 64 })] : []),
                wire("DDSetColorKey", { surface_handle: destination ? rt : source, key_kind: destination ? 1 : 0, color_low: 0x336699, color_high: 0x33669a, present: 1 }),
                blit(dev, source, rt, destination ? P.C.D9WG_DDBLT_KEY_DESTINATION : P.C.D9WG_DDBLT_KEY_SOURCE)];
        }, probes: [{ at: [32, 32], expect: destination ? (key <= 0x33669a ? [0, 255, 0] : [51, 102, 155]) : (key <= 0x33669a ? [0, 0, 0] : [51, 102, 155]) }] });
    for (const luminance of [false, true]) add("texture-ops", { name: "texture op BUMPENVMAP" + (luminance ? "LUMINANCE" : "") + " offsets next-stage coordinates", textureOp: luminance ? 23 : 22,
        body: dev => {
            const normal = dev + 0x500000, colour = normal + 1, data = new Uint8Array(64);
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) data.set(x < 2 ? [0, 255, 0, 255] : [0, 0, 255, 255], (y * 4 + x) * 4);
            return [...texture(dev, normal, luminance ? ["L6V5U5", 61, le16(0x800f)] : ["V8U8", 60, [127, 0]]),
                ...texture(dev, colour, ["A8R8G8B8", 21, [0, 0, 0, 255]]),
                wire("UpdateTexture", { resource_handle: colour, width: 4, height: 4, depth: 1, row_pitch: 16, slice_pitch: 64, data_bytes: 64 }, [blob("UpdateTexture", "data_offset", data)]),
                wire("SetTexture", { device_handle: dev, texture_handle: normal }), wire("SetTexture", { device_handle: dev, stage: 1, texture_handle: colour }),
                tss(dev, 0, 1, luminance ? 23 : 22), tss(dev, 0, 7, f(0.5)), tss(dev, 0, 8, 0), tss(dev, 0, 9, 0), tss(dev, 0, 10, 0),
                tss(dev, 0, 22, f(1)), tss(dev, 0, 23, 0), tss(dev, 1, 11, 0), tss(dev, 1, 1, 2), tss(dev, 1, 2, 2), tss(dev, 1, 4, 2), tss(dev, 1, 5, 0),
                ...texturedQuad(dev, 0.125)];
        }, probes: [{ at: [32, 32], expect: [luminance ? clamp(32 / 63) : 255, 0, 0], tolerance: 2 }] });
    for (const mirror of [false, true]) add("ddraw", { name: "DirectDraw " + (mirror ? "mirrored" : "ordinary") + " source blit",
        body: (dev, rt) => [wire("CreateTexture2D", { device_handle: dev, resource_handle: rt + 1, width: 64, height: 64, level_count: 1, format: 21 }),
            wire("ColorFill", { device_handle: dev, texture_handle: rt + 1, color: 0xffff0000, right: 32, bottom: 64 }),
            wire("ColorFill", { device_handle: dev, texture_handle: rt + 1, color: 0xff0000ff, left: 32, right: 64, bottom: 64 }),
            blit(dev, rt + 1, rt, mirror ? P.C.D9WG_DDBLT_MIRROR_X : 0)],
        probes: [{ at: [16, 32], expect: mirror ? [0, 0, 255] : [255, 0, 0] }, { at: [48, 32], expect: mirror ? [255, 0, 0] : [0, 0, 255] }] });
    add("fog", { name: "perspective projection selects W table fog", body: dev => [
        rs(dev, 28, 1), rs(dev, 34, 0x0000ff00), rs(dev, 35, 3), rs(dev, 36, f(0)), rs(dev, 37, f(4)),
        wire("SetTransform", { device_handle: dev, state: 3, matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0.5, 1, 0, 0, 0, 0] }),
        ...drawXYZ(dev, fullXYZ(2, 0xffff0000))], probes: [{ at: [32, 32], expect: [128, 128, 0], tolerance: 1 }] });
    add("rasterization", { name: "XYZRHW preserves reciprocal W for perspective colour interpolation", body: dev => [
        draw(dev, [[0, 0, 0.5, 0xffff0000, 0, 1], [64, 0, 0.5, 0xff0000ff, 0, 0.25], [0, 64, 0.5, 0xffff0000, 0, 1]])],
        probes: [{ at: [16, 16], expect: [235, 0, 20, 255], tolerance: 1 }] });
    add("texture-ops", { name: "unused texture arguments cannot activate a stale source colour key", body: dev => [
        ...texture(dev, dev + 0x500000, ["A8R8G8B8", 21, [0, 0, 255, 255]]),
        wire("DDSetColorKey", { surface_handle: dev + 0x500000, present: 1, color_low: 0xff0000, color_high: 0xff0000 }),
        rs(dev, 41, 1), tss(dev, 0, 1, 3), tss(dev, 0, 2, 2), tss(dev, 0, 3, 0),
        tss(dev, 0, 4, 2), tss(dev, 0, 5, 0), tss(dev, 0, 6, 2), draw(dev, quad(0, 0, 64, 64, 0.5, 0xff00ff00))],
        probes: [{ at: [32, 32], expect: [0, 255, 0, 255] }] });
    add("lighting", { name: "default D3D9 material is entirely zero", body: dev => [rs(dev, 137, 1), rs(dev, 141, 0), rs(dev, 139, 0x00ffffff),
        wire("SetLight", { device_handle: dev, type: 3, diffuse: [1, 1, 1, 1], direction: [0, 0, 1] }),
        wire("LightEnable", { device_handle: dev, enable: 1 }), ...litQuad(dev, 0, false)],
        probes: [{ at: [32, 32], expect: [0, 0, 0, 0] }] });
    function coordinateQuad(dev, dimensions, coords, z = 0.5) {
        const list = fullXYZ(z, 0xffffffff), stride = 12 + dimensions * 4;
        const data = new Uint8Array(list.length * stride), view = new DataView(data.buffer);
        list.forEach((v, i) => [...v.slice(0, 3), ...coords].forEach((x, j) => view.setFloat32(i * stride + j * 4, x, true)));
        return [cmd(P.OP.SET_FVF, cat([P.encode("SetFVF", { device_handle: dev, fvf: 0x102, element_count: 2 }),
            element(0, 2, 0), element(12, dimensions - 1, 5)])),
        wire("DrawPrimitiveUP", { device_handle: dev, primitive_type: 4, primitive_count: 2, stride, vertex_count: 6, vertex_bytes: data.length },
            [blob("DrawPrimitiveUP", "vertex_data_offset", data)])];
    }
    function coordinateTexture(dev) {
        const handle = dev + 0x500000, data = new Uint8Array(64);
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) data.set(x < 2 ? [0, 0, 255, 255] : [255, 0, 0, 255], (y * 4 + x) * 4);
        return [...texture(dev, handle, ["A8R8G8B8", 21, [0, 0, 0, 255]]),
            wire("UpdateTexture", { resource_handle: handle, width: 4, height: 4, depth: 1, row_pitch: 16, slice_pitch: 64, data_bytes: 64 },
                [blob("UpdateTexture", "data_offset", data)])];
    }
    for (const [dimensions, count, matrix, expected] of [
        [1, 4, [1, 0, 0, 0, 0.5, 1, 0, 0, 0.5, 0, 1, 0, 0.25, 0, 0, 1], [0, 0, 255, 255]],
        [2, 3, [1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1, 0, 0.25, 0, 0, 1], [0, 0, 255, 255]],
        [2, 4, [1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1, 0, 0.25, 0, 0, 1], [0, 0, 255, 255]],
        [3, 2, [1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1, 0, 0.25, 0, 0, 1], [255, 0, 0, 255]],
    ]) add("texture-coordinates", { name: "FLOAT" + dimensions + " texture input padding is independent of COUNT" + count, body: dev => [
        ...coordinateTexture(dev), tss(dev, 0, 24, count), wire("SetTransform", { device_handle: dev, state: 16, matrix }),
        ...coordinateQuad(dev, dimensions, [0.125, 0, 0].slice(0, dimensions))], probes: [{ at: [32, 32], expect: expected }] });
    add("texture-coordinates", { name: "camera position COUNT2 retains generated Z", body: dev => [
        ...coordinateTexture(dev), tss(dev, 0, 11, 0x20000), tss(dev, 0, 24, 2),
        wire("SetTransform", { device_handle: dev, state: 16, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1] }),
        ...coordinateQuad(dev, 2, [0.125, 0], 0.25)], probes: [{ at: [32, 32], expect: [0, 0, 255, 255] }] });
    add("texture-coordinates", { name: "XYZRHW bypasses texture matrix transformation", body: dev => [
        ...coordinateTexture(dev), tss(dev, 0, 24, 2), wire("SetTransform", { device_handle: dev, state: 16,
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1] }), ...texturedQuad(dev, 0.125)],
        probes: [{ at: [32, 32], expect: [255, 0, 0, 255] }] });
    for (const major of [1, 2, 3]) for (const mode of ["vertex", "table", "perspective"]) add("fog", {
        name: "ps_" + major + " " + mode + " post-shader fog", body: dev => {
            const handle = dev + 0x600000;
            const tokens = [0xffff0000 | major << 8 | (major === 1 ? 1 : 0),
                major === 1 ? S.DEF : ins(S.DEF, 5), dst(R.CONST, 0), f(1), f(0), f(0), f(0.25),
                major === 1 ? S.MOV : ins(S.MOV, 2), dst(major === 1 ? R.TEMP : R.COLOROUT, 0), src(R.CONST, 0), 0xffff];
            return [pixelShader(dev, handle, tokens), bindPS(dev, handle),
                rs(dev, 28, 1), rs(dev, 34, 0x0000ff00), rs(dev, 35, mode === "vertex" ? 0 : 3), rs(dev, 140, 3),
                rs(dev, 36, f(0)), rs(dev, 37, f(mode === "perspective" ? 4 : 1)),
                ...(mode === "perspective" ? [wire("SetTransform", { device_handle: dev, state: 3,
                    matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0.5, 1, 0, 0, 0, 0] }), ...drawXYZ(dev, fullXYZ(2, 0xffffffff))]
                    : [draw(dev, quad(0, 0, 64, 64, 0.5, 0xffffffff, 0x80000000))])];
        }, probes: [{ at: [32, 32], expect: major === 3 ? [255, 0, 0, 64] : [128, mode === "vertex" ? 127 : 128, 0, 64], tolerance: 1 }] });
    add("fog", { name: "ps_2 vertex fog consumes programmable VS oFog", body: dev => {
        const ps = dev + 0x600000, vs = ps + 1;
        return [pixelShader(dev, ps, [0xffff0200, ...def(0, 1, 0, 0, 0.25), ins(S.MOV, 2), dst(R.COLOROUT, 0), src(R.CONST, 0), 0xffff]),
            vertexShader(dev, vs, [0xfffe0200, ins(S.DCL, 2), 0x80000000, dst(R.INPUT, 0), ...def(0, 0.25, 0, 0, 0),
                ins(S.MOV, 2), dst(R.RASTOUT, 0), src(R.INPUT, 0), ins(S.MOV, 2), dst(R.RASTOUT, 1, 1), src(R.CONST, 0, 0), 0xffff]),
            bindPS(dev, ps), cmd(P.OP.SET_VERTEX_SHADER, P.encode("SetShader", { device_handle: dev, shader_handle: vs })),
            rs(dev, 28, 1), rs(dev, 34, 0x0000ff00), rs(dev, 140, 3), ...drawXYZ(dev, fullXYZ(0.5, 0xffffffff))];
    }, probes: [{ at: [32, 32], expect: [64, 191, 0, 64], tolerance: 1 }] });
    add("blending", { name: "blend constant changes preserve recorded draws with one pipeline state", body: dev => [
        rs(dev, 27, 1), rs(dev, 19, 14), rs(dev, 20, 1), rs(dev, 193, 0xffff0000),
        draw(dev, quad(0, 0, 32, 64, 0.5, 0xffffffff)), rs(dev, 193, 0xff00ff00),
        draw(dev, quad(32, 0, 64, 64, 0.5, 0xffffffff))], probes: [{ at: [16, 32], expect: [255, 0, 0, 255] }, { at: [48, 32], expect: [0, 255, 0, 255] }] });
    add("stencil", { name: "stencil reference changes preserve both writes and later equal tests", body: dev => [
        rs(dev, 52, 1), rs(dev, 56, 8), rs(dev, 55, 3), rs(dev, 57, 1), draw(dev, quad(0, 0, 32, 64, 0.5, 0xffff0000)),
        rs(dev, 57, 2), draw(dev, quad(32, 0, 64, 64, 0.5, 0xffff0000)), rs(dev, 55, 1), rs(dev, 56, 3),
        rs(dev, 57, 1), draw(dev, quad(0, 0, 64, 64, 0.5, 0xff00ff00)), rs(dev, 57, 2), draw(dev, quad(0, 0, 64, 64, 0.5, 0xff0000ff))],
        probes: [{ at: [16, 32], expect: [0, 255, 0, 255] }, { at: [48, 32], expect: [0, 0, 255, 255] }] });
    suite.FEATURE_GROUPS = groups;suite.FORMAT_CASES = formats;
})(typeof globalThis !== "undefined" ? globalThis : this);
