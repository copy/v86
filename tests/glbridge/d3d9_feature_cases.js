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
    // Bump operations only alter the following texture lookup. Neither result
    // register is written, regardless of RESULTARG or the otherwise active args.
    for (const operation of [22, 23]) for (const destination of [1, 5])
        for (const observed of [1, 5]) for (const alphaOperation of [2, 7])
            add("bump-registers", {name: `bump op ${operation} result ${destination} preserves register ${observed}, alpha op ${alphaOperation}`, body: dev => {
                const bump = dev + 0x500000;
                return [wire("CreateTexture2D", {device_handle: dev, resource_handle: bump, width: 1, height: 1, level_count: 1, format: 60}),
                    wire("UpdateTexture", {resource_handle: bump, width: 1, height: 1, depth: 1, row_pitch: 2, slice_pitch: 2, data_bytes: 2},
                        [blob("UpdateTexture", "data_offset", Uint8Array.from([0x40, 0x20]))]),
                    ...[0, 1].flatMap(stage => [tss(dev, stage, 1, 2), tss(dev, stage, 2, 6), tss(dev, stage, 4, 2), tss(dev, stage, 5, 6),
                        tss(dev, stage, 28, stage ? 5 : 1), tss(dev, stage, 32, stage ? 0x89abcdef : 0xff234567)]),
                    wire("SetTexture", {device_handle: dev, stage: 2, texture_handle: bump}),
                    tss(dev, 2, 1, operation), tss(dev, 2, 2, 0), tss(dev, 2, 3, 0), tss(dev, 2, 4, alphaOperation), tss(dev, 2, 5, 0), tss(dev, 2, 6, 0),
                    tss(dev, 2, 28, destination), tss(dev, 2, 11, 0), tss(dev, 2, 22, f(1)),
                    tss(dev, 3, 1, 2), tss(dev, 3, 2, observed), tss(dev, 3, 4, 2), tss(dev, 3, 5, observed), tss(dev, 4, 1, 1),
                    ...drawXYZ(dev, fullXYZ(.5, 0x80ffff02))];
            }, probes: [{at: [32, 32], expect: observed === 5 ? [0xab, 0xcd, 0xef, 0x89] : [0x23, 0x45, 0x67, 255], tolerance: 1}]});
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

    function texture(dev, handle, spec, usage = 0) {
        const [, format, pattern, , layout] = spec, repeat = layout === "block" ? 1 : layout === "pair" ? 8 : 16;
        const data = Uint8Array.from(new Array(repeat).fill(pattern).flat()), pitch = layout === "block" ? pattern.length : data.length / 4;
        const commands = [wire("CreateTexture2D", { device_handle: dev, resource_handle: handle, width: 4, height: 4, level_count: 1, format, usage })];
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

    for (const name of ["YUY2", "UYVY"]) for (const [pair, samples] of [
        [[16,128,235,128], [[0,0,0,255],[255,255,255,255]]],
        [[81,90,41,240], [[255,0,0,255],[208,0,0,255]]],
    ]) for (const phase of [0,1]) add("formats", {
        name: name + " distinct pair luma/chroma " + pair.join(",") + " phase " + phase,
        body: dev => {
            const packed = name === "YUY2" ? pair : [pair[1],pair[0],pair[3],pair[2]];
            return [...texture(dev,dev+0x500000,[name,fourcc(name),packed,[],"pair"]),...texturedQuad(dev,phase ? .375 : .125)];
        }, probes:[{at:[32,32],expect:samples[phase],tolerance:1}],
    });

    for (const [name, format, value, rgba] of [
        ["R5G6B5", 23, (4 << 11) | (16 << 5) | 4, [33, 65, 33, 255]],
        ["X1R5G5B5", 24, (4 << 10) | (8 << 5) | 16, [33, 66, 132, 255]],
        ["A1R5G5B5", 25, 0x8000 | (4 << 10) | (8 << 5) | 16, [33, 66, 132, 255]],
    ]) add("formats", { name: "format " + name + " mid-range bit replication", body: dev => [
        ...texture(dev, dev + 0x500000, [name, format, le16(value), rgba]), ...texturedQuad(dev)],
        probes: [{ at: [32, 32], expect: rgba, tolerance: 0 }] });

    const { OP: S, REG: R, ins, dst, src, def } = asm;
    // Prove every color format before granting a vertex-texture format query.
    // The same independent channel facts used for PS sampling now pass through
    // a VS3 texldl and color output, with no pixel texture sampling involved.
    for (const spec of formats) add("vertex-texture-formats", {
        name: "vertex texture format " + spec[0] + " sampled RGBA",
        body: dev => {
            const handle = dev + 0x500000, vs = dev + 0x600000, ps = vs + 1;
            return [...texture(dev, handle, spec), wire("SetTexture", {device_handle: dev, stage: 0, texture_handle: 0}),
                wire("SetTexture", {device_handle: dev, stage: 257, texture_handle: handle}),
                vertexShader(dev, vs, [0xfffe0300, ins(S.DCL, 2), 0x80000000, dst(R.INPUT, 0),
                    ins(S.DCL, 2), 0x80000000, dst(R.OUTPUT, 0), ins(S.DCL, 2), 0x8000000a, dst(R.OUTPUT, 1),
                    ins(S.DCL, 2), 0x90000000, dst(R.SAMPLER, 0), ...def(0, .5, .5, 0, 0),
                    ins(S.TEXLDL, 3), dst(R.TEMP, 0), src(R.CONST, 0), src(R.SAMPLER, 0),
                    ins(S.MOV, 2), dst(R.OUTPUT, 0), src(R.INPUT, 0), ins(S.MOV, 2), dst(R.OUTPUT, 1), src(R.TEMP, 0), 0xffff]),
                cmd(P.OP.SET_VERTEX_SHADER, P.encode("SetShader", {device_handle: dev, shader_handle: vs})),
                pixelShader(dev, ps, [0xffff0300, ins(S.DCL, 2), 0x8000000a, dst(R.INPUT, 0),
                    ins(S.MOV, 2), dst(R.COLOROUT, 0), src(R.INPUT, 0), 0xffff]),
                cmd(P.OP.SET_PIXEL_SHADER, P.encode("SetShader", {device_handle: dev, shader_handle: ps})),
                ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))];
        }, probes: [{at: [32, 32], expect: spec[3], tolerance: 1}],
    });
    const floatFilterFormats = [["R16F", 111, 1, 2], ["G16R16F", 112, 2, 2], ["A16B16G16R16F", 113, 4, 2],
        ["R32F", 114, 1, 4], ["G32R32F", 115, 2, 4], ["A32B32G32R32F", 116, 4, 4]];
    for (const [name, format, channels, bytes] of floatFilterFormats) add("format-filter-capabilities", {
        name: "linear filter capability " + name + " interpolates two texels", body: dev => {
            const handle = dev + 0x500000, data = new Uint8Array(4 * 4 * channels * bytes), view = new DataView(data.buffer);
            const left = [.25, .125, .25, .5], right = [.75, .625, .5, 1], half = new Map([[.125, 0x3000], [.25, 0x3400], [.5, 0x3800], [.625, 0x3900], [.75, 0x3a00], [1, 0x3c00]]);
            for (let y = 0; y < 4; ++y) for (let x = 0; x < 4; ++x) for (let channel = 0; channel < channels; ++channel) {
                const value = (x < 2 ? left : right)[channel], offset = ((y * 4 + x) * channels + channel) * bytes;
                if (bytes === 4) view.setFloat32(offset, value, true); else view.setUint16(offset, half.get(value), true);
            }
            return [wire("CreateTexture2D", {device_handle: dev, resource_handle: handle, width: 4, height: 4, level_count: 1, format}),
                wire("UpdateTexture", {resource_handle: handle, width: 4, height: 4, depth: 1, row_pitch: 4 * channels * bytes, slice_pitch: data.length, data_bytes: data.length}, [blob("UpdateTexture", "data_offset", data)]),
                wire("SetTexture", {device_handle: dev, texture_handle: handle}), tss(dev, 0, 1, 2), tss(dev, 0, 2, 2), tss(dev, 0, 4, 2), tss(dev, 0, 5, 2),
                wire("SetSamplerState", {device_handle: dev, state: 5, value: 2}), wire("SetSamplerState", {device_handle: dev, state: 6, value: 2}), ...texturedQuad(dev)];
        }, probes: [{at: [32, 32], expect: channels === 1 ? [128, 255, 255, 255] : channels === 2 ? [128, 96, 255, 255] : [128, 96, 96, 191],
            feature: bytes === 4 ? "float32-filterable" : undefined, unsupportedExpect: channels === 1 ? [191, 255, 255, 255] : channels === 2 ? [191, 159, 255, 255] : [191, 159, 128, 255], tolerance: 1}],
    });
    const srgbDecode = value => Math.round(255 * (value / 255 <= .04045 ? value / 255 / 12.92 : Math.pow((value / 255 + .055) / 1.055, 2.4)));
    const mid565 = le16(0x8410), midBlock = [...mid565, 0, 0, 0, 0, 0, 0];
    const srgbSpecs = [
        ["R8G8B8", 20, [128, 128, 128], [128, 128, 128, 255]], ["A8R8G8B8", 21, [128, 128, 128, 128], [128, 128, 128, 128]],
        ["X8R8G8B8", 22, [128, 128, 128, 0], [128, 128, 128, 255]], ["R5G6B5", 23, mid565, [132, 130, 132, 255]],
        ["X1R5G5B5", 24, le16(0x4210), [132, 132, 132, 255]], ["A1R5G5B5", 25, le16(0xc210), [132, 132, 132, 255]],
        ["A4R4G4B4", 26, le16(0x8888), [136, 136, 136, 136]], ["R3G3B2", 27, [0x92], [146, 146, 170, 255]],
        ["A8", 28, [128], [0, 0, 0, 128]], ["A8R3G3B2", 29, [0x92, 128], [146, 146, 170, 128]],
        ["X4R4G4B4", 30, le16(0x0888), [136, 136, 136, 255]], ["A8B8G8R8", 32, [128, 128, 128, 128], [128, 128, 128, 128]],
        ["X8B8G8R8", 33, [128, 128, 128, 0], [128, 128, 128, 255]], ["A8P8", 40, [1, 128], [153, 102, 51, 128]], ["P8", 41, [1], [153, 102, 51, 255]],
        ["L8", 50, [128], [128, 128, 128, 255]], ["A8L8", 51, [128, 128], [128, 128, 128, 128]], ["A4L4", 52, [0x88], [136, 136, 136, 136]],
        ["UYVY", fourcc("UYVY"), [128, 126, 128, 126], [128, 128, 128, 255], "pair"], ["YUY2", fourcc("YUY2"), [126, 128, 126, 128], [128, 128, 128, 255], "pair"],
        ["RGBG", fourcc("RGBG"), [128, 128, 128, 128], [128, 128, 128, 255], "pair"], ["GRGB", fourcc("GRGB"), [128, 128, 128, 128], [128, 128, 128, 255], "pair"],
        ["DXT1", fourcc("DXT1"), midBlock, [132, 130, 132, 255], "block"],
    ];
    for (const name of ["DXT2", "DXT3", "DXT4", "DXT5"]) srgbSpecs.push([name, fourcc(name), [...(name === "DXT2" || name === "DXT3" ? Array(8).fill(255) : [255, 0, 0, 0, 0, 0, 0, 0]), ...midBlock], [132, 130, 132, 255], "block"]);
    for (const spec of srgbSpecs) add("format-srgb-capabilities", {name: "sRGB read capability " + spec[0], body: dev => [
        ...texture(dev, dev + 0x500000, spec), wire("SetSamplerState", {device_handle: dev, state: 11, value: 1}), ...texturedQuad(dev)],
        probes: [{at: [32, 32], expect: spec[3].map((value, channel) => channel < 3 ? srgbDecode(value) : value), tolerance: 1}]});
    for (const format of [21, 22, 23, 24, 25, 26]) add("format-srgb-capabilities", {name: "sRGB write capability mapped target " + format, targetFormat: format,
        body: dev => [rs(dev, 194, 1), draw(dev, quad(0, 0, 64, 64, .5, 0xff808080))], probes: [{at: [32, 32], expect: [188, 188, 188], tolerance: 1}]});
    // Native BC sRGB storage must decode before linear interpolation, and
    // copies must stay between the uploads/draws that consume each version.
    const bcColorBlock = color => [...le16(color), 0, 0, 0, 0, 0, 0];
    const bcRGBA = color => [((color >> 11) << 3) | (color >> 13), (((color >> 5) & 63) << 2) | ((color >> 9) & 3), ((color & 31) << 3) | ((color & 31) >> 2), 255];
    const bcUpload = (handle, level, face, size, data) => wire("UpdateTexture", {resource_handle: handle, level, z: face, width: size, height: size, depth: 1, row_pitch: data.length, slice_pitch: data.length, data_bytes: data.length}, [blob("UpdateTexture", "data_offset", Uint8Array.from(data))]);
    for (const name of ["DXT1", "DXT2", "DXT3", "DXT4", "DXT5"]) add("bc-srgb", {
        name: name + " sRGB decode precedes linear filtering across blocks", body: dev => {
            const handle = dev + 0x500000, alpha = name === "DXT1" ? [] : name === "DXT2" || name === "DXT3" ? Array(8).fill(255) : [255, 0, 0, 0, 0, 0, 0, 0];
            const data = Uint8Array.from([...alpha, ...bcColorBlock(0x4208), ...alpha, ...bcColorBlock(0xc618)]);
            return [wire("CreateTexture2D", {device_handle: dev, resource_handle: handle, width: 8, height: 4, level_count: 1, format: fourcc(name)}),
                wire("UpdateTexture", {resource_handle: handle, width: 8, height: 4, depth: 1, row_pitch: data.length, slice_pitch: data.length, data_bytes: data.length}, [blob("UpdateTexture", "data_offset", data)]),
                wire("SetTexture", {device_handle: dev, texture_handle: handle}), tss(dev, 0, 1, 2), tss(dev, 0, 2, 2), tss(dev, 0, 4, 2), tss(dev, 0, 5, 2),
                wire("SetSamplerState", {device_handle: dev, state: 11, value: 1}), wire("SetSamplerState", {device_handle: dev, state: 5, value: 2}), wire("SetSamplerState", {device_handle: dev, state: 6, value: 2}), ...texturedQuad(dev)];
        }, probes: [{at: [32, 32], expect: bcRGBA(0x4208).map((value, channel) => channel === 3 ? 255 : Math.round((srgbDecode(value) + srgbDecode(bcRGBA(0xc618)[channel])) / 2)), tolerance: 1}],
    });
    add("bc-srgb", {name: "BC sRGB ordered upload and alternating linear sampling", body: dev => {
        const handle = dev + 0x500000, commands = [...texture(dev, handle, srgbSpecs.find(s => s[0] === "DXT1")), rs(dev, 174, 1)];
        for (let column = 0; column < 4; ++column) {
            if (column === 2) commands.push(bcUpload(handle, 0, 0, 4, bcColorBlock(0x4208)));
            commands.push(wire("SetScissorRect", {device_handle: dev, left: column * 16, right: column * 16 + 16, bottom: 64}),
                wire("SetSamplerState", {device_handle: dev, state: 11, value: column === 1 || column === 2 ? 1 : 0}), ...texturedQuad(dev));
        }
        return commands;
    }, probes: [0, 1, 2, 3].map(column => ({at: [column * 16 + 8, 32], expect: bcRGBA(column < 2 ? 0x8410 : 0x4208).map((value, channel) => channel < 3 && (column === 1 || column === 2) ? srgbDecode(value) : value), tolerance: 1}))});
    for (const cube of [false, true]) {
        const colors = [0x8410, 0x4208, 0xc618, 0xf800, 0x07e0, 0x001f], axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
        add("bc-srgb", {name: "BC sRGB " + (cube ? "all six cube faces" : "2D") + " includes 2x2 and 1x1 mip tails", body: dev => {
            const handle = dev + 0x500000, ps = dev + 0x600000;
            const commands = [wire(cube ? "CreateTextureCube" : "CreateTexture2D", {device_handle: dev, resource_handle: handle, ...(cube ? {edge_length: 4} : {width: 4, height: 4}), level_count: 3, format: fourcc("DXT1")})];
            for (let level = 0; level < 3; ++level) for (let face = 0; face < (cube ? 6 : 1); ++face)
                commands.push(bcUpload(handle, level, face, 4 >> level, bcColorBlock(colors[(face + level) % 6])));
            commands.push(wire("SetTexture", {device_handle: dev, texture_handle: handle}), wire("SetSamplerState", {device_handle: dev, state: 11, value: 1}), wire("SetSamplerState", {device_handle: dev, state: 7, value: 1}), rs(dev, 174, 1),
                pixelShader(dev, ps, [0xffff0300, ins(S.DCL, 2), cube ? 0x98000000 : 0x90000000, dst(R.SAMPLER, 0),
                    ins(S.TEXLDL, 3), dst(R.TEMP, 0), src(R.CONST, 0), src(R.SAMPLER, 0), ins(S.MOV, 2), dst(R.COLOROUT, 0), src(R.TEMP, 0), 0xffff]),
                cmd(P.OP.SET_PIXEL_SHADER, P.encode("SetShader", {device_handle: dev, shader_handle: ps})));
            for (let level = 0; level < 3; ++level) for (let face = 0; face < (cube ? 6 : 1); ++face) commands.push(
                cmd(P.OP.SET_PIXEL_SHADER_CONSTANT_F, P.encode("SetShaderConstantF", {device_handle: dev, vector_count: 1}), [blob("SetShaderConstantF", "data_offset", Uint8Array.from(floats(...(cube ? axes[face] : [.5, .5, 0]), level)))]),
                wire("SetScissorRect", {device_handle: dev, left: cube ? face * 10 : 0, right: cube ? face * 10 + 10 : 64, top: level * 20, bottom: level * 20 + 20}), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff)));
            return commands;
        }, probes: Array.from({length: cube ? 18 : 3}, (_, i) => {const level = cube ? Math.floor(i / 6) : i, face = cube ? i % 6 : 0;return {at: [cube ? face * 10 + 5 : 32, level * 20 + 10], expect: bcRGBA(colors[(face + level) % 6]).map((value, channel) => channel < 3 ? srgbDecode(value) : value), tolerance: 1};})});
    }
    for (const format of [21, 22, 23, 24, 25, 26, 31, 35, 111, 112, 113, 114, 115, 116]) add("format-blend-capabilities", {
        name: "post-pixel blending capability mapped target " + format, targetFormat: format, clear: 0xff0000ff,
        body: (dev, rt, runtime) => {
            void rt;
            // Exercise the same canonical query policy before attempting an
            // optional blend. Expected pixels depend only on real device caps.
            if (!global.D9WGFormats.formatQuerySupported(3, 0x80000, format, runtime.hostFeatures || 0, 3, true)) return [];
            return [rs(dev, 7, 0), rs(dev, 27, 1), rs(dev, 19, 5), rs(dev, 20, 6), draw(dev, quad(0, 0, 64, 64, .5, 0x80ff0000))];
        }, probes: [{at: [32, 32], expect: [128], feature: format >= 114 ? "float32-blendable" : undefined, unsupportedExpect: [0], tolerance: 1}],
    });

    const autoGenFormats = [[21, 4, 1, true], [22, 4, 1, true], [111, 1, 2], [112, 2, 2], [113, 4, 2], [114, 1, 4], [115, 2, 4], [116, 4, 4]];
    const autoPairs = [[.25, .75], [.125, .625], [0, .5], [.5, 1], [.25, 1], [0, .25]], cubeAxes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const autoHalf = new Map([[0, 0], [.125, 0x3000], [.25, 0x3400], [.5, 0x3800], [.625, 0x3900], [.75, 0x3a00], [1, 0x3c00]]);
    function autoData(format, channels, bytes, bgra, face) {
        const data = new Uint8Array(16 * channels * bytes), view = new DataView(data.buffer), pair = autoPairs[face];
        for (let y = 0; y < 4; ++y) for (let x = 0; x < 4; ++x) for (let channel = 0; channel < channels; ++channel) {
            const red = bytes === 1 && bgra ? 2 : 0, value = channel === red ? pair[x & 1] : channel === 3 ? 1 : 0, offset = ((y * 4 + x) * channels + channel) * bytes;
            if (bytes === 1) data[offset] = Math.round(value * 255); else if (bytes === 2) view.setUint16(offset, autoHalf.get(value), true); else view.setFloat32(offset, value, true);
        }
        void format;
        return data;
    }
    function autoShader(dev, ps, cube) {
        return [pixelShader(dev, ps, [0xffff0300, ins(S.DCL, 2), cube ? 0x98000000 : 0x90000000, dst(R.SAMPLER, 0), ins(S.TEXLDL, 3), dst(R.TEMP, 0), src(R.CONST, 0), src(R.SAMPLER, 0), ins(S.MOV, 2), dst(R.COLOROUT, 0), src(R.TEMP, 0), 0xffff]),
            cmd(P.OP.SET_PIXEL_SHADER, P.encode("SetShader", {device_handle: dev, shader_handle: ps})), wire("SetSamplerState", {device_handle: dev, state: 7, value: 1}), rs(dev, 174, 1)];
    }
    const autoCoordinates = (dev, coordinates) => cmd(P.OP.SET_PIXEL_SHADER_CONSTANT_F, P.encode("SetShaderConstantF", {device_handle: dev, vector_count: 1}), [blob("SetShaderConstantF", "data_offset", Uint8Array.from(floats(...coordinates)))]);
    for (const channels of [1, 2]) for (const cube of [false, true]) for (const edge of [1, 3, 7]) {
        const height = cube ? edge : edge === 7 ? 5 : edge;
        const levels = edge === 1 ? 1 : edge === 3 ? 2 : 3;
        const value = (level,face,block) => 40 + level * 30 + face * 9 + block * 8;
        add("ati-edges", {name: `ATI${channels} odd ${cube ? "cube" : "2D"} ${edge} mip chain`,
            body: dev => {
                const handle=dev+0x500000,ps=dev+0x600000,format=fourcc("ATI"+channels);
                const commands=[wire(cube?"CreateTextureCube":"CreateTexture2D",{device_handle:dev,resource_handle:handle,
                    ...(cube?{edge_length:edge}:{width:edge,height}),level_count:levels,format})];
                for(let level=0;level<levels;level++)for(let face=0;face<(cube?6:1);face++) {
                    const w=Math.max(1,edge>>level),h=Math.max(1,height>>level),columns=Math.ceil(w/4),rows=Math.ceil(h/4),pitch=columns*channels*8;
                    const data=new Uint8Array(pitch*rows);
                    for(let block=0;block<columns*rows;block++)for(let c=0;c<channels;c++)
                        data[block*channels*8+c*8]=value(level,face,cube?0:block)+c*20;
                    commands.push(wire("UpdateTexture",{resource_handle:handle,level,z:face,width:w,height:h,depth:1,
                        row_pitch:pitch,slice_pitch:data.length,data_bytes:data.length},[blob("UpdateTexture","data_offset",data)]));
                }
                commands.push(wire("SetTexture",{device_handle:dev,texture_handle:handle}),...autoShader(dev,ps,cube));
                for(let level=0;level<levels;level++)for(let face=0;face<(cube?6:1);face++)commands.push(
                    autoCoordinates(dev,[...(cube?cubeAxes[face]:[.9,.9,0]),level]),
                    wire("SetScissorRect",{device_handle:dev,left:cube?face*10:0,right:cube?face*10+10:64,top:level*20,bottom:level*20+20}),
                    ...drawXYZ(dev,fullXYZ(.5,0xffffffff)));
                return commands;
            }, probes:Array.from({length:levels*(cube?6:1)},(_,i)=>{
                const level=cube?Math.floor(i/6):i,face=cube?i%6:0,w=Math.max(1,edge>>level),h=Math.max(1,height>>level);
                const block=cube?0:Math.floor(Math.floor(h*.9)/4)*Math.ceil(w/4)+Math.floor(Math.floor(w*.9)/4),v=value(level,face,block);
                return {at:[cube?face*10+5:32,level*20+10],expect:channels===1?[v,v,v,v]:[v+20,v,255,255],tolerance:1};
            })});
    }
    for(const dxt of [1,2,3,4,5])for(const cube of [false,true])for(const edge of [1,3,7]) {
        const levels=edge===1?1:edge===3?2:3,colors=[0xf800,0x07e0,0x001f];
        add("bc-edges",{name:`DXT${dxt} odd ${cube?"cube":"2D"} ${edge} mip chain`,body:dev=>{
            const handle=dev+0x500000,ps=dev+0x600000,commands=[wire(cube?"CreateTextureCube":"CreateTexture2D",{
                device_handle:dev,resource_handle:handle,...(cube?{edge_length:edge}:{width:edge,height:edge}),level_count:levels,format:fourcc("DXT"+dxt)})];
            for(let level=0;level<levels;level++)for(let face=0;face<(cube?6:1);face++) {
                const w=Math.max(1,edge>>level),color=bcColorBlock(colors[(level+face)%3]);
                const block=Uint8Array.from(dxt===1?color:[...(dxt<=3?new Array(8).fill(255):[255,0,0,0,0,0,0,0]),...color]);
                const pitch=Math.ceil(w/4)*block.length,data=new Uint8Array(pitch*Math.ceil(w/4));
                for(let at=0;at<data.length;at+=block.length)data.set(block,at);
                commands.push(wire("UpdateTexture",{resource_handle:handle,level,z:face,width:w,height:w,depth:1,row_pitch:pitch,slice_pitch:data.length,data_bytes:data.length},[blob("UpdateTexture","data_offset",data)]));
            }
            commands.push(wire("SetTexture",{device_handle:dev,texture_handle:handle}),...autoShader(dev,ps,cube));
            for(let level=0;level<levels;level++)for(let face=0;face<(cube?6:1);face++)commands.push(
                autoCoordinates(dev,[...(cube?cubeAxes[face]:[.9,.9,0]),level]),wire("SetScissorRect",{device_handle:dev,left:cube?face*10:0,right:cube?face*10+10:64,top:level*20,bottom:level*20+20}),...drawXYZ(dev,fullXYZ(.5,0xffffffff)));
            return commands;
        },probes:Array.from({length:levels*(cube?6:1)},(_,i)=>{
            const level=cube?Math.floor(i/6):i,face=cube?i%6:0;
            return{at:[cube?face*10+5:32,level*20+10],expect:bcRGBA(colors[(level+face)%3]),tolerance:1};
        })});
    }
    for (const [format, channels, bytes, bgra] of autoGenFormats) for (const cube of [false, true]) for (const filter of [0, 1, 2, 3]) add("autogen", {
        name: "autogen format " + format + (cube ? " cube" : " 2D") + " filter " + filter + " reaches both generated levels", body: (dev, rt, runtime) => {
            void rt;
            const handle = dev + 0x500000, ps = dev + 0x600000, selected = format >= 114 && !(runtime.hostFeatures & 1) ? 1 : filter;
            const commands = [wire(cube ? "CreateTextureCube" : "CreateTexture2D", {device_handle: dev, resource_handle: handle, ...(cube ? {edge_length: 4} : {width: 4, height: 4}), level_count: 1, format, usage: 0x400})];
            for (let face = 0; face < (cube ? 6 : 1); ++face) {
                const data = autoData(format, channels, bytes, bgra, face);
                commands.push(wire("UpdateTexture", {resource_handle: handle, z: face, width: 4, height: 4, depth: 1, row_pitch: 4 * channels * bytes, slice_pitch: data.length, data_bytes: data.length}, [blob("UpdateTexture", "data_offset", data)]));
            }
            commands.push(wire("GenerateMips", {device_handle: dev, resource_handle: handle, filter_type: selected, defer_generation: 1}), wire("SetTexture", {device_handle: dev, texture_handle: handle}), ...autoShader(dev, ps, cube));
            for (let level = 1; level <= 2; ++level) for (let face = 0; face < (cube ? 6 : 1); ++face) commands.push(autoCoordinates(dev, [...(cube ? cubeAxes[face] : [.5, .5, 0]), level]),
                wire("SetScissorRect", {device_handle: dev, left: cube ? face * 10 : 0, right: cube ? face * 10 + 10 : 64, top: (level - 1) * 32, bottom: level * 32}), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff)));
            return commands;
        }, probes: Array.from({length: cube ? 12 : 2}, (_, i) => {const face = cube ? i % 6 : 0, level = cube ? Math.floor(i / 6) : i, pair = autoPairs[face], encode = value => Math.round(value * 255);
            const expected = filter === 1 ? encode(pair[1]) : bytes === 1 ? Math.round((encode(pair[0]) + encode(pair[1])) / 2) : encode((pair[0] + pair[1]) / 2);
            return {at: [cube ? face * 10 + 5 : 32, level * 32 + 16], expect: [expected], feature: format >= 114 ? "float32-filterable" : undefined, unsupportedExpect: [encode(pair[1])], tolerance: 1};}),
    });
    for (const spec of formats.filter(spec => [60, 63, ...["DXT1", "DXT2", "DXT3", "DXT4", "DXT5", "ATI1", "ATI2"].map(fourcc)].includes(spec[1]))) add("autogen-fallback", {
        name: "autogen unsupported storage " + spec[0] + " remains a valid single-level texture", body: dev => [...texture(dev, dev + 0x500000, spec, 0x400), wire("GenerateMips", {device_handle: dev, resource_handle: dev + 0x500000}), ...texturedQuad(dev)], probes: [{at: [32, 32], expect: spec[3], tolerance: 1}],
    });
    add("autogen", {name: "autogen deferred filters and legacy generation preserve draw order", body: dev => {
        const handle = dev + 0x500000, ps = dev + 0x600000, data = autoData(21, 4, 1, true, 0);
        const commands = [wire("CreateTexture2D", {device_handle: dev, resource_handle: handle, width: 4, height: 4, level_count: 1, format: 21, usage: 0x400}),
            wire("UpdateTexture", {resource_handle: handle, width: 4, height: 4, depth: 1, row_pitch: 16, slice_pitch: data.length, data_bytes: data.length}, [blob("UpdateTexture", "data_offset", data)]), wire("SetTexture", {device_handle: dev, texture_handle: handle}), ...autoShader(dev, ps, false), autoCoordinates(dev, [.5, .5, 0, 2])];
        for (const [column, filter] of [[0, 2], [1, 1], [2, 2]]) {
            commands.push(wire("GenerateMips", {device_handle: dev, resource_handle: handle, filter_type: filter, defer_generation: 1}));
            if (column === 1) commands.push(cmd(P.OP.GENERATE_MIPS, P.encode("GenerateMips", {device_handle: dev, resource_handle: handle}).subarray(0, 8)));
            commands.push(wire("SetScissorRect", {device_handle: dev, left: column * 21, right: column * 21 + 21, bottom: 64}), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff)));
        }
        return commands;
    }, probes: [{at: [10, 32], expect: [128]}, {at: [32, 32], expect: [191]}, {at: [53, 32], expect: [128]}]});
    add("autogen", {name: "autogen observes GPU writes to level zero", body: dev => {
        const handle = dev + 0x500000, ps = dev + 0x600000, commands = [wire("CreateTexture2D", {device_handle: dev, resource_handle: handle, width: 4, height: 4, level_count: 1, format: 21, usage: 0x401})];
        for (let x = 0; x < 4; ++x) commands.push(wire("ColorFill", {device_handle: dev, texture_handle: handle, color: x & 1 ? 0xffff0000 : 0xff000000, left: x, top: 0, right: x + 1, bottom: 4}));
        commands.push(wire("SetTexture", {device_handle: dev, texture_handle: handle}), ...autoShader(dev, ps, false), autoCoordinates(dev, [.5, .5, 0, 2]), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff)));
        return commands;
    }, probes: [{at: [32, 32], expect: [128]}]});

    // Explicit zero is a valid D3DCOLOR, including its transparent alpha.
    // This does not use the disputed undocumented initial CONSTANT value.
    for (const stage of [0, 3]) add("default-consumers", {
        name: "stage " + stage + " constant keeps explicit transparent zero between colors",
        body: dev => {
            const commands = [];
            for (let i = 0; i <= stage; ++i) commands.push(tss(dev, i, 1, 2), tss(dev, i, 2, i === stage ? 6 : 1), tss(dev, i, 4, 2), tss(dev, i, 5, i === stage ? 6 : 1));
            for (const [left, right, color] of [[0, 21, 0xa0102030], [21, 43, 0], [43, 64, 0x40806020]])
                commands.push(tss(dev, stage, 32, color), draw(dev, quad(left, 0, right, 64, .5, 0xffffffff)));
            return commands;
        },
        probes: [{ at: [8, 32], expect: [16, 32, 48, 160] }, { at: [32, 32], expect: [0, 0, 0, 0] }, { at: [56, 32], expect: [128, 96, 32, 64] }],
    });
    // Half of a 64x64 depth map fails ref=.5, the other half passes. At
    // u=32.25/64 POINT returns 1; linear PCF weights the passing texel .75.
    // UV derivatives independently select magnification or minification.
    for (const scale of [.25, 4]) for (const filters of [null, [1, 1], [1, 2], [2, 1], [2, 2]]) {
        const magnifying = scale < 1, active = filters ? filters[magnifying ? 0 : 1] : 1;
        const expected = active === 1 ? 255 : 191;
        add("default-consumers", {
            name: "shadow " + (magnifying ? "magnification" : "minification") + " filters " + (filters ? filters.join("/") : "default POINT"),
            ref: "D3DTEXTUREFILTERTYPE POINT=1, LINEAR=2; independent MAG/MIN states",
            body: dev => {
                const depth = dev + 0x500000, ps = dev + 0x600000;
                const commands = [
                    wire("CreateTexture2D", { device_handle: dev, resource_handle: depth, width: 64, height: 64, level_count: 1, format: 75, usage: 2 }),
                    wire("SetDepthStencilSurfaceLevel", { device_handle: dev, depth_texture_handle: depth, width: 64, height: 64 }),
                    wire("Clear", { device_handle: dev, clear_flags: 2, depth: 1 }),
                    cmd(P.OP.CLEAR, cat([P.encode("Clear", { device_handle: dev, clear_flags: 2, depth: 0, rect_count: 1 }), P.encode("Rect", { left: 0, top: 0, right: 32, bottom: 64 })])),
                    wire("SetDepthStencilSurfaceLevel", { device_handle: dev }), rs(dev, 7, 0),
                    wire("SetTexture", { device_handle: dev, stage: 0, texture_handle: depth }),
                    wire("SetSamplerState", { device_handle: dev, state: 1, value: 3 }), wire("SetSamplerState", { device_handle: dev, state: 2, value: 3 }),
                    pixelShader(dev, ps, [0xffff0200, ins(S.DCL, 2), 0x80000005, dst(R.ADDR, 0),
                        ins(S.DCL, 2), 0x90000000, dst(R.SAMPLER, 0), ins(S.TEX, 3), dst(R.TEMP, 0), src(R.ADDR, 0), src(R.SAMPLER, 0),
                        ins(S.MOV, 2), dst(R.COLOROUT, 0), src(R.TEMP, 0), 0xffff]),
                    cmd(P.OP.SET_PIXEL_SHADER, P.encode("SetShader", { device_handle: dev, shader_handle: ps })),
                ];
                if (filters) commands.push(wire("SetSamplerState", { device_handle: dev, state: 5, value: filters[0] }), wire("SetSamplerState", { device_handle: dev, state: 6, value: filters[1] }));
                const list = quad(0, 0, 64, 64, .5, 0), data = new Uint8Array(list.length * 28), view = new DataView(data.buffer);
                list.forEach((v, i) => [v[0], v[1], .5, 1, 32.25 / 64 + (v[0] / 64 - .5) * scale, .5, .5].forEach((n, j) => view.setFloat32(i * 28 + j * 4, n, true)));
                commands.push(cmd(P.OP.SET_FVF, cat([P.encode("SetFVF", { device_handle: dev, fvf: 0x10104, element_count: 2 }), element(0, 3, 9), element(16, 2, 5)])),
                    wire("DrawPrimitiveUP", { device_handle: dev, primitive_type: 4, primitive_count: 2, stride: 28, vertex_count: 6, vertex_bytes: data.length }, [blob("DrawPrimitiveUP", "vertex_data_offset", data)]));
                return commands;
            }, probes: [{ at: [32, 32], expect: [expected, expected, expected, expected], tolerance: 1 }],
        });
    }
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
    for (const format of [21,22,23,34,36,111,112,113,114,115,116]) for (const implicit of [false,true]) {
        if (implicit && format !== 22) continue;
        add("surface-fill", {name: "ColorFill " + (implicit ? "implicit backbuffer" : "format " + format) + " preserves outside partial fill",
            body: (dev,rt) => {
                const target=implicit?0:rt+1;
                return [...(implicit?[]:[wire("CreateTexture2D",{device_handle:dev,resource_handle:target,width:64,height:64,level_count:1,format})]),
                    wire("ColorFill",{device_handle:dev,texture_handle:target,color:0xff0000ff,right:64,bottom:64}),
                    wire("ColorFill",{device_handle:dev,texture_handle:target,color:0xffadbeef,left:16,top:16,right:48,bottom:48}),
                    ...(implicit ? [wire("StretchRect",{device_handle:dev,source_texture_handle:target,destination_texture_handle:rt,source_right:64,source_bottom:64,destination_right:64,destination_bottom:64,filter_point:1})] : [
                        wire("SetTexture",{device_handle:dev,texture_handle:target}),tss(dev,0,1,2),tss(dev,0,2,2),tss(dev,0,4,2),tss(dev,0,5,2),
                        rs(dev,174,1),wire("SetScissorRect",{device_handle:dev,right:16,bottom:64}),...texturedQuad(dev,.125),
                        wire("SetScissorRect",{device_handle:dev,left:16,right:64,bottom:64}),...texturedQuad(dev,.5)])];
            },probes:[{at:[8,8],expect:[0,format===111||format===114?255:0,255,255]},
                {at:[32,32],expect:[173,format===111||format===114?255:190,[34,111,112,114,115].includes(format)?255:239,255],tolerance:2}]});
    }
    for (const format of [21,22]) add("surface-fill",{name:"implicit ColorFill alpha format "+format,backBufferFormat:format,
        body:(dev,rt)=>[wire("ColorFill",{device_handle:dev,texture_handle:0,color:0x80402010,right:64,bottom:64}),
            wire("StretchRect",{device_handle:dev,source_texture_handle:0,destination_texture_handle:rt,source_right:64,source_bottom:64,destination_right:64,destination_bottom:64,filter_point:1})],
        probes:[{at:[32,32],expect:[64,32,16,format===21?128:255]}]});
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
    // Four flat triangles separate Z/W inputs so the fog oracle does not
    // depend on perspective interpolation or the implementation's matrices.
    for (const table of [0,3,1,2]) for (const vertex of [0,3,1,2]) for (const mode of [0,1,2,3]) for (const ortho of [false,true]) {
        const zs=[.2,.2,.5,.5],ws=[.5,.9,.5,.9],spec=[192/255,64/255,64/255,64/255];
        const fogAt=i=>{
            if(!table) {
                if(mode===3)return .8;
                if(mode===2)return .96;
                if(mode===0||!vertex)return 1-spec[i];
            }
            const distance=!table?zs[i]*3:!ortho?(mode===0?1/ws[i]:mode===1?2.02:ws[i]):(mode===0?zs[i]:mode===1?zs[i]*3:zs[i]);
            const fn=table||vertex;
            return fn===3?distance/10:fn===1?1-Math.exp(-distance):1-Math.exp(-distance*distance);
        };
        add("fog-coordinate-modes",{name:`fog table=${table} vertex=${vertex} mode=${mode} ortho=${ortho}`,targetFormat:116,
            body:dev=>{
                const v=[[-2,0],[0,2],[0,0],[0,0],[0,2],[2,0],[0,-2],[-2,0],[0,0],[0,-2],[0,0],[2,0]],data=new Uint8Array(12*24),dv=new DataView(data.buffer);
                v.forEach(([x,y],i)=>{const q=Math.floor(i/3),values=mode===0?[(x+1)*32,(1-y)*32,zs[q],ws[q]]:[x,y,zs[q],ws[q]];
                    values.forEach((n,c)=>dv.setFloat32(i*24+c*4,n,true));dv.setUint32(i*24+16,0xff0000ff,true);dv.setUint32(i*24+20,(Math.round(spec[q]*255)<<24)>>>0,true);});
                const projection=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,ortho?1:1.01],view=[1,0,0,0,0,1,0,0,0,0,3,0,0,0,0,2];
                const shader=mode<2?[]:[vertexShader(dev,dev+0x700000,[0xfffe0101,...def(0,.2,0,0,.04),
                    ins(S.DCL,0),0x80000000,dst(R.INPUT,0),ins(S.DCL,0),0x8000000a,dst(R.INPUT,1),
                    ins(S.MOV,0),dst(R.RASTOUT,0),src(R.INPUT,0),ins(S.MOV,0),dst(R.ATTROUT,0),src(R.INPUT,1),
                    ins(S.MOV,0),dst(R.ATTROUT,1),src(R.CONST,0,0xff),...(mode===3?[ins(S.MOV,0),dst(R.RASTOUT,1),src(R.CONST,0,0)]:[]),0xffff]),
                    cmd(P.OP.SET_VERTEX_SHADER,P.encode("SetShader",{device_handle:dev,shader_handle:dev+0x700000}))];
                return [rs(dev,28,1),rs(dev,34,0xff00ffff),rs(dev,35,table),rs(dev,140,vertex),rs(dev,36,f(0)),rs(dev,37,f(10)),rs(dev,38,f(1)),rs(dev,195,f(.1)),
                    wire("SetTransform",{device_handle:dev,state:3,matrix:projection}),wire("SetTransform",{device_handle:dev,state:2,matrix:view}),
                    cmd(P.OP.SET_FVF,cat([P.encode("SetFVF",{device_handle:dev,fvf:mode===0?0xc4:0x40c2,element_count:3}),element(0,3,mode===0?9:0),element(16,4,10),element(20,4,10,1)])),...shader,
                    wire("DrawPrimitiveUP",{device_handle:dev,primitive_type:4,primitive_count:4,stride:24,vertex_count:12,vertex_bytes:data.length},[blob("DrawPrimitiveUP","vertex_data_offset",data)])];
            },probes:[[30,30],[34,30],[30,34],[34,34]].map((at,i)=>({at,expect:[0,clamp(fogAt(i)),255,255],tolerance:1}))});
    }
    for(const inputW of [.25,.5,2])for(const translation of [0,1]) add("fixed-position-w",{
        name:`FFP POSITION float4 W=${inputW} world translation=${translation}`,clear:0xffff0000,
        body:dev=>{
            const list=[[-.5,-.5],[-.5,.5],[.5,-.5],[.5,-.5],[-.5,.5],[.5,.5]],data=new Uint8Array(6*20),dv=new DataView(data.buffer);
            list.forEach(([x,y],i)=>{[x,y,.5,inputW].forEach((v,j)=>dv.setFloat32(i*20+j*4,v,true));dv.setUint32(i*20+16,0xff0000ff,true);});
            return [wire("SetTransform",{device_handle:dev,state:256,matrix:[1,0,0,0,0,1,0,0,0,0,1,0,translation,0,0,1]}),
                cmd(P.OP.SET_FVF,cat([P.encode("SetFVF",{device_handle:dev,fvf:0x4002,element_count:2}),element(0,3,0),element(16,4,10)])),
                wire("DrawPrimitiveUP",{device_handle:dev,primitive_type:4,primitive_count:2,stride:20,vertex_count:6,vertex_bytes:data.length},[blob("DrawPrimitiveUP","vertex_data_offset",data)])];
        },probes:translation?[{at:[47,32],expect:[255,0,0]},{at:[49,32],expect:[0,0,255]}]:[{at:[15,32],expect:[255,0,0]},{at:[17,32],expect:[0,0,255]},{at:[47,32],expect:[0,0,255]},{at:[49,32],expect:[255,0,0]}]});
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
    for (const major of [0, 1, 2, 3]) for (let func = 1; func <= 8; func++) for (const delta of [-1, 0, 1]) {
        const pass = (alpha, reference) => [false, alpha < reference, alpha === reference, alpha <= reference,
            alpha > reference, alpha !== reference, alpha >= reference, true][func - 1];
        const alpha = reference => Math.max(0, Math.min(255, reference + delta));
        add("alpha-test", { name: (major ? "ps_" + major : "FFP") + " alpha function " + func + " delta " + delta + " across all 256 references", body: dev => {
            const commands = [rs(dev, 15, 1), rs(dev, 25, func)];
            if (major) {
                const tokens = [0xffff0000 | major << 8 | (major === 1 ? 1 : 0), major === 1 ? S.MOV : ins(S.MOV, 2),
                    dst(major === 1 ? R.TEMP : R.COLOROUT, 0), src(R.CONST, 0), 0xffff];
                commands.push(pixelShader(dev, dev + 0x600000, tokens), bindPS(dev, dev + 0x600000));
            }
            for (let reference = 0; reference < 256; reference++) {
                const x = (reference & 15) * 4, y = (reference >> 4) * 4;
                commands.push(rs(dev, 24, reference));
                if (major) commands.push(cmd(P.OP.SET_PIXEL_SHADER_CONSTANT_F, P.encode("SetShaderConstantF", { device_handle: dev, vector_count: 1 }),
                    [blob("SetShaderConstantF", "data_offset", Uint8Array.from(floats(0, 1, 0, alpha(reference) / 255)))]));
                commands.push(draw(dev, quad(x, y, x + 4, y + 4, 0.5, (alpha(reference) << 24 | 0x00ff00) >>> 0)));
            }
            return commands;
        }, probes: Array.from({ length: 256 }, (_, reference) => ({ at: [(reference & 15) * 4 + 1, (reference >> 4) * 4 + 1],
            expect: pass(alpha(reference), reference) ? [0, 255, 0] : [0, 0, 0], tolerance: 0 })) });
    }
    function mipSource(dev) {
        const handle = dev + 0x500000, commands = [wire("CreateTexture2D", { device_handle: dev, resource_handle: handle, width: 128, height: 128, level_count: 8, format: 21 })];
        const colours = [[0, 0, 255, 255], [0, 255, 0, 255], [255, 0, 0, 255], [255, 255, 255, 255]];
        for (let level = 0; level < 8; level++) {
            const size = 128 >> level, data = new Uint8Array(size * size * 4), colour = colours[Math.min(3, level)];
            for (let i = 0; i < size * size; i++) data.set(colour, i * 4);
            commands.push(wire("UpdateTexture", { resource_handle: handle, level, width: size, height: size, depth: 1,
                row_pitch: size * 4, slice_pitch: data.length, data_bytes: data.length }, [blob("UpdateTexture", "data_offset", data)]));
        }
        return [...commands, wire("SetTexture", { device_handle: dev, texture_handle: handle }), tss(dev, 0, 1, 2), tss(dev, 0, 2, 2),
            wire("SetSamplerState", { device_handle: dev, state: 7, value: 1 })];
    }
    function gradientQuad(dev) {
        const list = quad(0, 0, 64, 64, 0.5, 0xffffffff), data = new Uint8Array(list.length * 32), view = new DataView(data.buffer);
        list.forEach((v, i) => {
            [v[0], v[1], v[2], 1].forEach((value, j) => view.setFloat32(i * 32 + j * 4, value, true));
            view.setUint32(i * 32 + 16, 0xffffffff, true);view.setFloat32(i * 32 + 24, v[0] / 64, true);view.setFloat32(i * 32 + 28, v[1] / 64, true);
        });
        return [cmd(P.OP.SET_FVF, cat([P.encode("SetFVF", { device_handle: dev, fvf: 0x1c4, element_count: 4 }),
            element(0, 3, 9), element(16, 4, 10), element(20, 4, 10, 1), element(24, 1, 5)])),
        wire("DrawPrimitiveUP", { device_handle: dev, primitive_type: 4, primitive_count: 2, stride: 32, vertex_count: 6, vertex_bytes: data.length },
            [blob("DrawPrimitiveUP", "vertex_data_offset", data)])];
    }
    for (const major of [0, 1, 2, 3]) for (const fractional of [false, true]) add("mipmaps", {
        name: (major ? "ps_" + major : "FFP") + (fractional ? " fractional LOD bias selects adjacent mips" : " LOD bias changes and restores mip selection"),
        body: dev => {
            const commands = mipSource(dev), handle = dev + 0x600000;
            if (major) {
                const tokens = major === 1 ? [0xffff0101, S.TEX, dst(R.TEXTURE, 0), S.MOV, dst(R.TEMP, 0), src(R.TEXTURE, 0), 0xffff]
                    : [0xffff0000 | major << 8, ins(S.DCL, 2), 0x80000005, dst(major === 3 ? R.INPUT : R.ADDR, 0),
                        ins(S.DCL, 2), 0x90000000, dst(R.SAMPLER, 0), ins(S.TEX, 3), dst(R.TEMP, 0), src(major === 3 ? R.INPUT : R.ADDR, 0), src(R.SAMPLER, 0),
                        ins(S.MOV, 2), dst(R.COLOROUT, 0), src(R.TEMP, 0), 0xffff];
                commands.push(pixelShader(dev, handle, tokens), bindPS(dev, handle));
            }
            commands.push(rs(dev, 174, 1));
            for (const [left, right, bias] of fractional ? [[0, 32, 0.25], [32, 64, 0.75]] : [[0, 16, -1], [16, 32, 0], [32, 48, 1], [48, 64, 0]])
                commands.push(wire("SetSamplerState", { device_handle: dev, state: 8, value: f(bias) }),
                    wire("SetScissorRect", { device_handle: dev, left, right, bottom: 64 }), ...gradientQuad(dev));
            return commands;
        }, probes: fractional ? [{ at: [16, 32], expect: [0, 255, 0, 255] }, { at: [48, 32], expect: [0, 0, 255, 255] }]
            : [{ at: [8, 32], expect: [255, 0, 0, 255] }, { at: [24, 32], expect: [0, 255, 0, 255] },
                { at: [40, 32], expect: [0, 0, 255, 255] }, { at: [56, 32], expect: [0, 255, 0, 255] }] });
    for (const path of [0, 1, 2, 3, "vs2ps2"]) for (let rejected = 0; rejected < 6; rejected++) add("clipping", {
        name: (path === "vs2ps2" ? "VS2/PS2" : path ? "ps_" + path : "FFP") + " all 64 enable masks select clip plane " + rejected,
        clear: 0xff0000ff, body: dev => {
            const commands = [], ps = dev + 0x600000, vs = ps + 1, major = path === "vs2ps2" ? 2 : path;
            for (let index = 0; index < 6; index++) commands.push(wire("SetClipPlane", { device_handle: dev, index, plane: [0, 0, 0, index === rejected ? -1 : 1] }));
            if (major) commands.push(pixelShader(dev, ps, [0xffff0000 | major << 8 | (major === 1 ? 1 : 0),
                major === 1 ? S.DEF : ins(S.DEF, 5), dst(R.CONST, 0), f(1), f(0), f(0), f(1),
                major === 1 ? S.MOV : ins(S.MOV, 2), dst(major === 1 ? R.TEMP : R.COLOROUT, 0), src(R.CONST, 0), 0xffff]), bindPS(dev, ps));
            if (path === "vs2ps2") commands.push(vertexShader(dev, vs, [0xfffe0200, ins(S.DCL, 2), 0x80000000, dst(R.INPUT, 0),
                ins(S.MOV, 2), dst(R.RASTOUT, 0), src(R.INPUT, 0), 0xffff]),
            cmd(P.OP.SET_VERTEX_SHADER, P.encode("SetShader", { device_handle: dev, shader_handle: vs })));
            // Warm clipping once, then restore the blue target. All following
            // enable-mask changes, including zero, use this same shader shape.
            commands.push(rs(dev, 152, 1), ...drawXYZ(dev, fullXYZ(0.5, 0xffff0000)),
                wire("Clear", { device_handle: dev, clear_flags: 1, color: 0xff0000ff, depth: 1 }), rs(dev, 174, 1));
            for (let mask = 0; mask < 64; mask++) {
                const x = (mask & 7) * 8, y = (mask >> 3) * 8;
                commands.push(rs(dev, 152, mask), wire("SetScissorRect", { device_handle: dev, left: x, top: y, right: x + 8, bottom: y + 8 }),
                    ...drawXYZ(dev, fullXYZ(0.5, 0xffff0000)));
            }
            return commands;
        }, probes: Array.from({ length: 64 }, (_, mask) => ({ at: [(mask & 7) * 8 + 3, (mask >> 3) * 8 + 3],
            expect: mask & 1 << rejected ? [0, 0, 255, 255] : [255, 0, 0, 255], tolerance: 0 })) });
    // XYZRHW z is already the depth-buffer value, including any viewport
    // transform applied by ProcessVertices. Ordinary XYZ still needs MinZ/MaxZ.
    for (const [minZ, maxZ] of [[.25, .75], [.5, .5], [0, 0], [1, 1], [.8, 1]])
        for (const [z, clearDepth, compare] of [[.1, .2, 2], [.9, .8, 5]])
            add("processed-depth", {
                name: `screen depth ${z} bypasses viewport ${minZ}..${maxZ}`,
                body: dev => [wire("SetViewport", { device_handle: dev, width: 64, height: 64, min_z: minZ, max_z: maxZ }),
                    wire("Clear", { device_handle: dev, clear_flags: 3, color: 0xff000000, depth: clearDepth }),
                    rs(dev, 23, compare), draw(dev, quad(0, 0, 64, 64, z, 0xff00ff00))],
                probes: [{ at: [32, 32], expect: [0, 255, 0, 255] }],
            });
    add("processed-depth", {
        name: "screen and ordinary draws switch depth ranges within one frame",
        body: dev => [wire("SetViewport", { device_handle: dev, width: 64, height: 64, min_z: .25, max_z: .75 }),
            rs(dev, 23, 2), draw(dev, quad(0, 0, 32, 64, .2, 0xff00ff00)),
            ...drawXYZ(dev, fullXYZ(.1, 0xffff0000)),
            cmd(P.OP.SET_FVF, cat([P.encode("SetFVF", { device_handle: dev, fvf: 0xc4, element_count: 3 }),
                element(0, 3, 9), element(16, 4, 10), element(20, 4, 10, 1)])),
            draw(dev, quad(32, 0, 64, 64, .2, 0xff0000ff))],
        probes: [{ at: [16, 32], expect: [0, 255, 0, 255] }, { at: [48, 32], expect: [0, 0, 255, 255] }],
    });
    // Wine visual.c test_color_clamping and fog source tests. Expectations
    // below are independent scalar arithmetic, not generated shader text.
    const legacyShader = (kind, major, instructions) => [
        (kind === "vertex" ? 0xfffe0000 : 0xffff0000) | major << 8 | (major === 1 ? 1 : 0),
        ...instructions.flatMap(([op, ...args]) => [major === 1 ? op : ins(op, args.length), ...args]), 0xffff];
    const outputVS = (major, mode, fog) => {
        const body = major === 1 ? [] : [[S.DCL, 0x80000000, dst(R.INPUT, 0)]];
        if (major === 3) body.push([S.DCL, 0x80000000, dst(R.OUTPUT, 0)],
            [S.DCL, 0x8000000a, dst(R.OUTPUT, 1)], [S.DCL, 0x8001000a, dst(R.OUTPUT, 2)]);
        const color = index => dst(major === 3 ? R.OUTPUT : R.ATTROUT, major === 3 ? index + 1 : index);
        body.push([S.MOV, dst(major === 3 ? R.OUTPUT : R.RASTOUT, 0), src(R.INPUT, 0)]);
        if (mode === "interpolated") {
            body.push([S.DEF, dst(R.CONST, 0), f(.5), f(.5), f(.5), f(.5)],
                [S.ADD, color(0), src(R.INPUT, 0, 0), src(R.CONST, 0)]);
        } else {
            const diffuse = mode === "fog" ? [1, 0, 0, .25] : [-.5, 2, .25, .5];
            const specular = mode === "fog" ? [0, 0, 0, .25] : [.75, -.5, 2, 1.5];
            body.push([S.DEF, dst(R.CONST, 0), ...diffuse.map(f)], [S.DEF, dst(R.CONST, 1), ...specular.map(f)]);
            if (mode !== "missing") body.push([S.MOV, color(0), src(R.CONST, 0)]);
            body.push([S.MOV, color(1), src(R.CONST, 1)]);
        }
        if (fog === "explicit") body.push([S.DEF, dst(R.CONST, 2), f(.75), 0, 0, 0],
            [S.MOV, dst(R.RASTOUT, 1, 1), src(R.CONST, 2, 0)]);
        return legacyShader("vertex", major, body);
    };
    const outputPS = (major, mode) => {
        const body = [];
        if (major >= 2) body.push([S.DCL, major === 3 ? 0x8000000a : 0x80000000, dst(R.INPUT, 0)]);
        if (mode === "sum" && major >= 2) body.push([S.DCL, major === 3 ? 0x8001000a : 0x80000000, dst(R.INPUT, 1)]);
        const result = dst(major === 1 ? R.TEMP : R.COLOROUT, 0);
        if (mode === "sum") body.push([S.DEF, dst(R.CONST, 0), f(.25), f(.25), f(.25), f(.25)],
            [S.ADD, dst(R.TEMP, 0), src(R.INPUT, 0), src(R.INPUT, 1)], [S.MUL, result, src(R.TEMP, 0), src(R.CONST, 0)]);
        else body.push([S.MOV, result, src(R.INPUT, 0)]);
        return legacyShader("pixel", major, body);
    };
    const outputBindings = (dev, vm, pm, mode, fog) => {
        const vs = dev + 0x600000, ps = vs + 1;
        return [vertexShader(dev, vs, outputVS(vm, mode, fog)),
            cmd(P.OP.SET_VERTEX_SHADER, P.encode("SetShader", {device_handle: dev, shader_handle: vs})),
            ...(pm ? [pixelShader(dev, ps, outputPS(pm, mode === "colors" ? "sum" : "copy")), bindPS(dev, ps)] : []),
            tss(dev, 0, 1, 2), tss(dev, 0, 2, 0), tss(dev, 0, 4, 2), tss(dev, 0, 5, 0), rs(dev, 137, 0)];
    };
    for (const vm of [1, 2, 3]) for (const pm of [0, 1, 2, 3]) add("shader-legacy-outputs", {
        name: "vs" + vm + " ps" + pm + " saturates colors before rasterization", body: dev => [
            ...outputBindings(dev, vm, pm, "colors"), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))],
        probes: [{at: [32, 32], expect: (pm ? vm === 3 && pm === 3 ? [.0625, .375, .5625, .5] : [.1875, .25, .3125, .375] : [0, 1, .25, .5]).map(clamp), tolerance: 1}],
    });
    for (const vm of [1, 2]) for (const pm of [0, 1, 2, 3]) {
        add("shader-legacy-outputs", { name: "vs" + vm + " ps" + pm + " unwritten diffuse is white", body: dev => [
            ...outputBindings(dev, vm, pm, "missing"), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))],
            probes: [{at: [32, 32], expect: [255, 255, 255, 255]}] });
        add("shader-legacy-outputs", { name: "vs" + vm + " ps" + pm + " color saturation precedes interpolation", body: dev => [
            ...outputBindings(dev, vm, pm, "interpolated"), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))],
            probes: [{at: [16, 32], expect: [64, 64, 64, 64], tolerance: 1}, {at: [48, 32], expect: [191, 191, 191, 191], tolerance: 1}] });
        for (const fog of ["specular", "explicit", "table"]) for (const vertexMode of [0, 1, 2, 3]) add("shader-legacy-outputs", {
            name: "vs" + vm + " ps" + pm + " fog=" + fog + " vertexmode=" + vertexMode,
            body: dev => [...outputBindings(dev, vm, pm, "fog", fog), rs(dev, 28, 1), rs(dev, 34, 0x0000ff00),
                rs(dev, 35, fog === "table" ? 3 : 0), rs(dev, 140, vertexMode), rs(dev, 36, f(0)), rs(dev, 37, f(1)),
                ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))],
            probes: [{at: [32, 32], expect: pm === 3 ? [255, 0, 0, 64] : fog === "explicit" ? [191, 64, 0, 64] : fog === "table" ? [128, 128, 0, 64] : [64, 191, 0, 64], tolerance: 1}],
        });
    }
    add("shader-legacy-outputs", { name: "VS3 switches legacy color saturation with its pixel partner", body: dev => {
        const ps3 = dev + 0x600001, ps2 = ps3 + 1;
        const commands = [...outputBindings(dev, 3, 3, "colors"), pixelShader(dev, ps2, outputPS(2, "sum")), rs(dev, 174, 1)];
        for (const [left, right, ps] of [[0, 21, ps2], [21, 43, ps3], [43, 64, ps2]])
            commands.push(bindPS(dev, ps), wire("SetScissorRect", {device_handle: dev, left, top: 0, right, bottom: 64}),
                ...drawXYZ(dev, fullXYZ(.5, 0xffffffff)));
        return commands;
    }, probes: [{at: [10, 32], expect: [48, 64, 80, 96], tolerance: 1},
        {at: [32, 32], expect: [16, 96, 143, 128], tolerance: 1}, {at: [54, 32], expect: [48, 64, 80, 96], tolerance: 1}] });
    for (const pm of [0, 1, 2, 3]) add("shader-legacy-outputs", { name: "vs3 ps" + pm + " color interpolation partner rule",
        body: dev => [...outputBindings(dev, 3, pm, "interpolated"), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))],
        probes: [{at: [16, 32], expect: Array(4).fill(pm === 3 ? 0 : 64), tolerance: 1},
            {at: [48, 32], expect: Array(4).fill(pm === 3 ? 255 : 191), tolerance: 1}] });
    // SM3 links by semantic/mask, never by register number or a small fixed
    // semantic whitelist. All expected colours below come from constants.
    const semanticDcl = (usage, index, type, register, mask = 15) =>
        [S.DCL, (0x80000000 | index << 16 | usage) >>> 0, dst(type, register, mask)];
    const semanticVS = declarations => legacyShader("vertex", 3, [
        semanticDcl(0, 0, R.INPUT, 0), semanticDcl(0, 0, R.OUTPUT, 11),
        ...declarations.map(item => semanticDcl(item.usage, item.index, R.OUTPUT, item.register, item.mask)),
        [S.MOV, dst(R.OUTPUT, 11), src(R.INPUT, 0)],
        ...declarations.flatMap((item, i) => [[S.DEF, dst(R.CONST, i), ...item.value.map(f)],
            [S.MOV, dst(R.OUTPUT, item.register, item.mask), src(R.CONST, i)]])]);
    const semanticPS = (declarations, instructions) => legacyShader("pixel", 3, [
        ...declarations.map(item => semanticDcl(item.usage, item.index, R.INPUT, item.register, item.mask)),
        ...instructions]);
    const bindSemanticPair = (dev, vsTokens, psTokens) => {
        const vs = dev + 0x600000, ps = vs + 1;
        return [vertexShader(dev, vs, vsTokens), pixelShader(dev, ps, psTokens),
            cmd(P.OP.SET_VERTEX_SHADER, P.encode("SetShader", {device_handle: dev, shader_handle: vs})), bindPS(dev, ps), rs(dev, 137, 0)];
    };
    const bindSemanticVS = (dev, handle) => cmd(P.OP.SET_VERTEX_SHADER,
        P.encode("SetShader", {device_handle: dev, shader_handle: handle}));
    const semanticCases = [[3, 0], [3, 7], [6, 0], [7, 0], [5, 8], [5, 9], [5, 15],
        [10, 2], [10, 7], [10, 15], [0, 1], [11, 1], [1, 3], [2, 4]];
    for (const [usage, index] of semanticCases) for (const [output, input] of [[0, 9], [7, 0], [3, 4]])
        for (const mask of usage === 0 ? [15] : [15, 5, 10]) add("shader-semantics", {
            name: "SM3 semantic " + usage + ":" + index + " o" + output + " to v" + input + " mask " + mask,
            body: dev => {
                const value = [.2, .4, .6, .8], item = {usage, index, mask, value};
                const commands = bindSemanticPair(dev, semanticVS([{...item, register: output}]),
                    semanticPS([{...item, register: input}], [
                        [S.DEF, dst(R.CONST, 0), f(.1), f(.1), f(.1), f(1)],
                        [S.MOV, dst(R.COLOROUT, 0), src(R.CONST, 0)],
                        [S.MOV, dst(R.COLOROUT, 0, mask), src(R.INPUT, input)]]));
                return [...commands, ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))];
            }, probes: [{at: [32, 32], expect: [.2, .4, .6, .8].map((v, i) => clamp(mask & 1 << i ? v : i === 3 ? 1 : .1)), tolerance: 1}],
        });
    for (const flat of [false, true]) add("shader-semantics", {
        name: "SM3 four packed semantics preserve separate components flat=" + flat,
        body: dev => {
            const values = [.2, .4, .6, .8];
            const declarations = [[3, 0], [5, 8], [10, 0], [7, 0]].map(([usage, index], i) =>
                ({usage, index, register: 3, mask: 1 << i, value: values}));
            const commands = bindSemanticPair(dev, semanticVS(declarations), semanticPS(
                declarations.map(item => ({...item, register: 7})), [[S.MOV, dst(R.COLOROUT, 0), src(R.INPUT, 7)]]));
            return [...commands, rs(dev, 9, flat ? 1 : 2), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))];
        }, probes: [{at: [32, 32], expect: [51, 102, 153, 204], tolerance: 1}],
    });
    for (const flat of [false, true]) add("shader-semantics", {
        name: "SM3 forty consumed components with mixed flat and smooth packing flat=" + flat,
        body: dev => {
            const declarations = [];
            for (let i = 0; i < 10; ++i) {
                const item = {usage: 3, index: i, register: i, mask: i ? 15 : 14, value: [i / 10, .25, .5, .75]};
                declarations.push(item);
                if (!i) declarations.push({...item, usage: 10, index: 0, mask: 1});
            }
            const body = [[S.MOV, dst(R.TEMP, 0), src(R.INPUT, 9)]];
            for (let i = 0; i < 9; ++i) body.push([S.ADD, dst(R.TEMP, 0), src(R.TEMP, 0), src(R.INPUT, i)]);
            body.push([S.DEF, dst(R.CONST, 0), f(.1), f(.1), f(.1), f(.1)],
                [S.MUL, dst(R.COLOROUT, 0), src(R.TEMP, 0), src(R.CONST, 0)]);
            const commands = bindSemanticPair(dev, semanticVS(declarations), semanticPS(
                declarations.map(item => ({...item, register: 9 - item.register})), body));
            return [...commands, rs(dev, 9, flat ? 1 : 2), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))];
        }, probes: [{at: [32, 32], expect: [.45, .25, .5, .75].map(clamp), tolerance: 1}],
    });
    add("shader-semantics", {name: "SM3 vertex wrapper follows pixel partner on repeated same-frame switches", body: dev => {
        const vs = dev + 0x600000, psA = vs + 1, psB = vs + 2;
        const declarations = [{usage: 3, index: 0, register: 2, mask: 15, value: [1, 0, 0, 1]},
            {usage: 10, index: 2, register: 7, mask: 15, value: [0, 0, 1, 1]}];
        const commands = [vertexShader(dev, vs, semanticVS(declarations)), bindSemanticVS(dev, vs), rs(dev, 174, 1)];
        for (const [i, ps] of [[0, psA], [1, psB]]) commands.push(pixelShader(dev, ps,
            semanticPS([{...declarations[i], register: 4}], [[S.MOV, dst(R.COLOROUT, 0), src(R.INPUT, 4)]])));
        for (const [left, right, ps] of [[0, 21, psA], [21, 43, psB], [43, 64, psA]])
            commands.push(bindPS(dev, ps), wire("SetScissorRect", {device_handle: dev, left, top: 0, right, bottom: 64}),
                ...drawXYZ(dev, fullXYZ(.5, 0xffffffff)));
        return commands;
    }, probes: [{at: [10, 32], expect: [255, 0, 0, 255]}, {at: [32, 32], expect: [0, 0, 255, 255]},
        {at: [54, 32], expect: [255, 0, 0, 255]}]});

    for (const flat of [false, true]) add("shader-semantics", {
        name: "SM3 packed color stays flat while neighbouring normal interpolates flat=" + flat,
        body: dev => {
            const declarations = [{usage: 10, index: 0, register: 3, mask: 1},
                {usage: 3, index: 0, register: 3, mask: 2}];
            const vs = legacyShader("vertex", 3, [semanticDcl(0, 0, R.INPUT, 0), semanticDcl(0, 0, R.OUTPUT, 11),
                ...declarations.map(item => semanticDcl(item.usage, item.index, R.OUTPUT, item.register, item.mask)),
                [S.DEF, dst(R.CONST, 0), f(.5), f(.5), f(.5), f(.5)],
                [S.MOV, dst(R.OUTPUT, 11), src(R.INPUT, 0)],
                [S.MAD, dst(R.OUTPUT, 3, 3), src(R.INPUT, 0, 0), src(R.CONST, 0), src(R.CONST, 0)]]);
            const ps = semanticPS(declarations, [[S.DEF, dst(R.CONST, 0), 0, 0, 0, f(1)],
                [S.MOV, dst(R.COLOROUT, 0), src(R.CONST, 0)], [S.MOV, dst(R.COLOROUT, 0, 3), src(R.INPUT, 3)]]);
            return [...bindSemanticPair(dev, vs, ps), rs(dev, 9, flat ? 1 : 2), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))];
        }, probes: [{at: [16, 16], expect: [flat ? 0 : 64, 64, 0, 255], tolerance: 1},
            {at: [48, 48], expect: [flat ? 255 : 191, 191, 0, 255], tolerance: 1}],
    });

    // SM3 indexed registers: independent colour constants, real vertex input
    // conversion, and loops visiting every legal input/output register.
    const relativeToken = token => (token | 0x2000) >>> 0;
    const loopDef = (register, count, start, step) => [S.DEFI, dst(R.CONSTINT, register), count, start, step, 0];
    const loopBegin = register => [S.LOOP, src(R.LOOP, 0), src(R.CONSTINT, register)];
    const relativePS = semanticPS([{usage: 5, index: 0, register: 0, mask: 15}],
        [[S.MOV, dst(R.COLOROUT, 0), src(R.INPUT, 0)]]);
    for (let input = 0; input < 16; ++input) for (const component of [0, 1, 2, 3, "loop"]) {
        add("shader-addressing", {name: "VS3 relative input v" + input + " via " + component, body: dev => {
            const position = input === 0 ? 1 : 0, offset = input === 0 ? 1 : 0, index = input - offset;
            const instructions = [semanticDcl(0, 0, R.INPUT, position), semanticDcl(10, 0, R.INPUT, input),
                semanticDcl(0, 0, R.OUTPUT, 0), semanticDcl(5, 0, R.OUTPUT, 2),
                [S.MOV, dst(R.OUTPUT, 0), src(R.INPUT, position)]];
            if (component === "loop") instructions.push(loopDef(0, 1, index, 1), loopBegin(0));
            else instructions.push([S.DEF, dst(R.CONST, 0), ...[0, 1, 2, 3].map(c => f(c === component ? index : 13))],
                [S.MOVA, dst(R.ADDR, 0), src(R.CONST, 0)]);
            instructions.push([S.MOV, dst(R.OUTPUT, 2), relativeToken(src(R.INPUT, offset)),
                src(component === "loop" ? R.LOOP : R.ADDR, 0, component === "loop" ? 0xe4 : component * 0x55)]);
            if (component === "loop") instructions.push([S.ENDLOOP]);
            return [...bindSemanticPair(dev, legacyShader("vertex", 3, instructions), relativePS),
                ...drawXYZ(dev, fullXYZ(.5, 0xcc336699))];
        }, probes: [{at: [32, 32], expect: [51, 102, 153, 204], tolerance: 1}]});
    }
    const indexedValues = Array.from({length: 10}, (_, i) => [(i + 1) / 16, (10 - i) / 16, .25, .75]);
    const indexedDeclarations = indexedValues.map((value, i) => ({usage: 5, index: i, register: i, mask: 15, value}));
    for (let input = 0; input < 10; ++input) for (const offset of [0, input + 1]) {
        add("shader-addressing", {name: "PS3 relative input v" + input + " offset " + offset, body: dev => {
            const ps = semanticPS(indexedDeclarations, [loopDef(0, 1, input - offset, 1), loopBegin(0),
                [S.MOV, dst(R.COLOROUT, 0), relativeToken(src(R.INPUT, offset)), src(R.LOOP, 0)], [S.ENDLOOP]]);
            return [...bindSemanticPair(dev, semanticVS(indexedDeclarations), ps), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))];
        }, probes: [{at: [32, 32], expect: indexedValues[input].map(clamp), tolerance: 1}]});
    }
    for (let output = 2; output < 12; ++output) for (const offset of [0, output, output + 1]) for (const mask of [15, 5, 10]) {
        add("shader-addressing", {name: "VS3 relative output o" + output + " offset " + offset + " mask " + mask, body: dev => {
            const instructions = [semanticDcl(0, 0, R.INPUT, 0), semanticDcl(0, 0, R.OUTPUT, 0),
                ...indexedDeclarations.map(item => semanticDcl(item.usage, item.index, R.OUTPUT, item.register + 2)),
                [S.DEF, dst(R.CONST, 0), f(.1), f(.1), f(.1), f(1)],
                [S.DEF, dst(R.CONST, 1), f(.2), f(.4), f(.6), f(.8)],
                [S.MOV, dst(R.OUTPUT, 0), src(R.INPUT, 0)],
                ...indexedDeclarations.map(item => [S.MOV, dst(R.OUTPUT, item.register + 2), src(R.CONST, 0)]),
                loopDef(0, 1, output - offset, 1), loopBegin(0),
                [S.MOV, relativeToken(dst(R.OUTPUT, offset, mask)), src(R.LOOP, 0), src(R.CONST, 1)], [S.ENDLOOP]];
            const ps = semanticPS([{usage: 5, index: output - 2, register: 0, mask: 15}],
                [[S.MOV, dst(R.COLOROUT, 0), src(R.INPUT, 0)]]);
            return [...bindSemanticPair(dev, legacyShader("vertex", 3, instructions), ps), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))];
        }, probes: [{at: [32, 32], expect: [.2, .4, .6, .8].map((v, c) => clamp(mask & 1 << c ? v : c === 3 ? 1 : .1)), tolerance: 1}]});
    }
    for (const reverse of [false, true]) for (const nested of [false, true]) {
        add("shader-addressing", {name: "PS3 indexed fold reverse=" + reverse + " nested=" + nested, body: dev => {
            const instructions = [[S.DEF, dst(R.CONST, 0), 0, 0, 0, 0],
                [S.DEF, dst(R.CONST, 1), f(.5), f(.5), f(.5), f(.5)],
                [S.MOV, dst(R.TEMP, 0), src(R.CONST, 0)], loopDef(0, 10, reverse ? 9 : 0, reverse ? -1 : 1),
                loopDef(1, 2, 7, -3), loopBegin(0)];
            if (nested) instructions.push(loopBegin(1), [S.MOV, dst(R.TEMP, 1), relativeToken(src(R.INPUT, 0)), src(R.LOOP, 0)], [S.ENDLOOP]);
            instructions.push([S.MUL, dst(R.TEMP, 0), src(R.TEMP, 0), src(R.CONST, 1)],
                [S.ADD, dst(R.TEMP, 0), src(R.TEMP, 0), relativeToken(src(R.INPUT, 0)), src(R.LOOP, 0)],
                [S.ENDLOOP], [S.MUL, dst(R.COLOROUT, 0), src(R.TEMP, 0), src(R.CONST, 1)]);
            return [...bindSemanticPair(dev, semanticVS(indexedDeclarations), semanticPS(indexedDeclarations, instructions)),
                ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))];
        }, probes: [{at: [32, 32], expect: (reverse ? [...indexedValues].reverse() : indexedValues)
            .reduce((sum, value) => sum.map((x, c) => x * .5 + value[c]), [0, 0, 0, 0]).map(x => clamp(x * .5)), tolerance: 1}]});
    }

    for (const reverse of [false, true]) for (const nested of [false, true]) {
        add("shader-addressing", {name: "VS3 indexed output sweep reverse=" + reverse + " nested=" + nested, body: dev => {
            const instructions = [semanticDcl(0, 0, R.INPUT, 0), semanticDcl(0, 0, R.OUTPUT, 0),
                ...indexedDeclarations.map(item => semanticDcl(item.usage, item.index, R.OUTPUT, item.register + 2)),
                ...indexedValues.map((value, i) => [S.DEF, dst(R.CONST, i + 2), ...value.map(f)]),
                [S.MOV, dst(R.OUTPUT, 0), src(R.INPUT, 0)], loopDef(0, 10, reverse ? 11 : 2, reverse ? -1 : 1),
                loopDef(1, 2, 3, 2), loopBegin(0)];
            if (nested) instructions.push(loopBegin(1), [S.MOV, dst(R.TEMP, 1), relativeToken(src(R.CONST, 0)), src(R.LOOP, 0)], [S.ENDLOOP]);
            instructions.push([S.MOV, relativeToken(dst(R.OUTPUT, 0)), src(R.LOOP, 0), relativeToken(src(R.CONST, 0)), src(R.LOOP, 0)], [S.ENDLOOP]);
            const psBody = [[S.DEF, dst(R.CONST, 0), 0, 0, 0, 0], [S.DEF, dst(R.CONST, 1), f(.5), f(.5), f(.5), f(.5)],
                [S.MOV, dst(R.TEMP, 0), src(R.CONST, 0)], loopDef(0, 10, 0, 1), loopBegin(0),
                [S.MAD, dst(R.TEMP, 0), src(R.TEMP, 0), src(R.CONST, 1), relativeToken(src(R.INPUT, 0)), src(R.LOOP, 0)],
                [S.ENDLOOP], [S.MUL, dst(R.COLOROUT, 0), src(R.TEMP, 0), src(R.CONST, 1)]];
            return [...bindSemanticPair(dev, legacyShader("vertex", 3, instructions), semanticPS(indexedDeclarations, psBody)),
                ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))];
        }, probes: [{at: [32, 32], expect: indexedValues.reduce((sum, value) => sum.map((x, c) => x * .5 + value[c]), [0, 0, 0, 0])
            .map(x => clamp(x * .5)), tolerance: 1}]});
    }
    for (const mask of [15, 5, 10]) for (const swizzle of [0xe4, 0x1b]) {
        add("shader-addressing", {name: "VS3 predicated relative output mask=" + mask + " swizzle=" + swizzle, body: dev => {
            const vs = legacyShader("vertex", 3, [semanticDcl(0, 0, R.INPUT, 0), semanticDcl(0, 0, R.OUTPUT, 0),
                semanticDcl(5, 0, R.OUTPUT, 2), [S.MOV, dst(R.OUTPUT, 0), src(R.INPUT, 0)],
                [S.DEF, dst(R.CONST, 0), f(.2), f(.7), f(.4), f(.9)],
                [S.DEF, dst(R.CONST, 1), f(.5), f(.5), f(.5), f(.5)],
                [S.DEF, dst(R.CONST, 2), f(.1), f(.1), f(.1), f(1)],
                [S.MOV, dst(R.OUTPUT, 2), src(R.CONST, 2)], loopDef(0, 1, 2, 1)]).slice(0, -1);
            vs.push(ins(S.SETP, 3, {control: 1}), dst(R.PREDICATE, 0), src(R.CONST, 0), src(R.CONST, 1),
                ins(S.LOOP, 2), src(R.LOOP, 0), src(R.CONSTINT, 0),
                ins(S.MOV, 4, {predicated: true}), relativeToken(dst(R.OUTPUT, 0, mask)), src(R.LOOP, 0),
                src(R.PREDICATE, 0, swizzle), src(R.CONST, 0), ins(S.ENDLOOP, 0), 0xffff);
            return [...bindSemanticPair(dev, vs, relativePS), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))];
        }, probes: [{at: [32, 32], expect: [.2, .7, .4, .9].map((v, c) =>
            clamp((mask & 1 << c) && (((swizzle >> (c * 2)) & 3) % 2) ? v : c === 3 ? 1 : .1)), tolerance: 1}]});
    }

    const ps1 = (minor, body) => { const tokens = legacyShader("pixel", 1, body);tokens[0] = 0xffff0100 | minor;return tokens; };
    function legacyCoordinates(dev, coordinates, z = .5) {
        const stride = 20 + coordinates.length * 16, list = quad(0, 0, 64, 64, z, 0xffffffff);
        const data = new Uint8Array(list.length * stride), view = new DataView(data.buffer);
        list.forEach((v, i) => {
            [v[0], v[1], v[2], 1].forEach((value, j) => view.setFloat32(i * stride + j * 4, value, true));
            view.setUint32(i * stride + 16, 0xffffffff, true);
            coordinates.forEach((value, n) => value.forEach((x, c) => view.setFloat32(i * stride + 20 + n * 16 + c * 4, x, true)));
        });
        return [bindSemanticVS(dev, 0),
            cmd(P.OP.SET_FVF, cat([P.encode("SetFVF", {device_handle: dev, fvf: 0x44 | coordinates.length << 8,
                element_count: 2 + coordinates.length}), element(0, 3, 9), element(16, 4, 10),
            ...coordinates.map((_, i) => element(20 + i * 16, 3, 5, i))])),
            wire("DrawPrimitiveUP", {device_handle: dev, primitive_type: 4, primitive_count: 2, stride, vertex_count: 6, vertex_bytes: data.length},
                [blob("DrawPrimitiveUP", "vertex_data_offset", data)])];
    }
    const bindLegacyPS = (dev, tokens) => [pixelShader(dev, dev + 0x600000, tokens), bindPS(dev, dev + 0x600000)];
    const clearDepth = (dev, depth) => wire("Clear", {device_handle: dev, clear_flags: 3, color: 0xff000000, depth});
    for (const kind of ["texdepth", "texm3x2depth"]) for (const [n, d] of [[.25, 1], [.75, 1], [0, 0], [.5, 0], [-.25, -1], [.125, .5]])
        for (const msaa of [0, 4]) for (const write of [false, true]) {
            const value = d === 0 ? 1 : n / d;
            add("shader-legacy-sampling", {name: kind + " " + n + "/" + d + " msaa=" + msaa + " write=" + write, msaa, body: dev => {
                const body = kind === "texdepth" ? [[S.TEXCOORD, dst(R.TEMP, 5, 7), src(R.TEXTURE, 0)], [S.PHASE], [S.TEXDEPTH, dst(R.TEMP, 5)]]
                    : [[S.TEXCOORD, dst(R.TEXTURE, 0)], [S.TEXM3x2PAD, dst(R.TEXTURE, 1), src(R.TEXTURE, 0)],
                        [S.TEXM3x2DEPTH, dst(R.TEXTURE, 2), src(R.TEXTURE, 0)]];
                body.push([S.DEF, dst(R.CONST, 0), f(1), 0, 0, f(1)], [S.MOV, dst(R.TEMP, 0), src(R.CONST, 0)]);
                const coordinates = kind === "texdepth" ? [[n, d, .8, 1]] : [[1, 0, 0, 1], [n, .8, .5, 1], [d, .4, .7, 1]];
                const commands = [clearDepth(dev, write ? 1 : .5), rs(dev, 7, 1), rs(dev, 14, 1), rs(dev, 23, write ? 8 : 2),
                    ...bindLegacyPS(dev, ps1(kind === "texdepth" ? 4 : 3, body)), ...legacyCoordinates(dev, coordinates, .6)];
                if (write) commands.push(bindPS(dev, 0), rs(dev, 23, 2), ...drawXYZ(dev, fullXYZ(.5, 0xff00ff00)));
                return commands;
            }, probes: [{at: [32, 32], expect: write ? value < .5 ? [255, 0, 0, 255] : [0, 255, 0, 255]
                : value < .5 ? [255, 0, 0, 255] : [0, 0, 0, 255]}]});
        }
    for (const minor of [2, 3]) for (const modifier of [0, 4]) for (const vector of [[.2, .4, .6, .8], [.8, .1, .3, .2]]) {
        const rows = [[.5, .25, .125, .9], [.125, .5, .25, .8], [.25, .125, .5, .7]];
        const value = vector.slice(0, 3).map(x => modifier ? 2 * x - 1 : x);
        add("shader-legacy-sampling", {name: "ps1." + minor + " texm3x3 arithmetic modifier=" + modifier + " vector=" + vector, body: dev => [
            ...bindLegacyPS(dev, ps1(minor, [[S.TEXCOORD, dst(R.TEXTURE, 0)],
                [S.TEXM3x3PAD, dst(R.TEXTURE, 1), (src(R.TEXTURE, 0) | modifier << 24) >>> 0],
                [S.TEXM3x3PAD, dst(R.TEXTURE, 2), (src(R.TEXTURE, 0) | modifier << 24) >>> 0],
                [S.TEXM3x3, dst(R.TEXTURE, 3), (src(R.TEXTURE, 0) | modifier << 24) >>> 0],
                [S.MOV, dst(R.TEMP, 0), src(R.TEXTURE, 3)]])), ...legacyCoordinates(dev, [vector, ...rows])],
        probes: [{at: [32, 32], expect: [...rows.map(row => clamp(value.reduce((sum, x, c) => sum + row[c] * x, 0))), 255], tolerance: 1}]});
    }
    function legacyPattern(dev, handle, type = "2d", stage = 0) {
        const commands = [wire(type === "cube" ? "CreateTextureCube" : type === "3d" ? "CreateTextureVolume" : "CreateTexture2D",
            {device_handle: dev, resource_handle: handle, ...(type === "cube" ? {edge_length: 4} : {width: 4, height: 4, ...(type === "3d" ? {depth: 4} : {})}), level_count: 1, format: 21})];
        for (let layer = 0; layer < (type === "cube" ? 6 : type === "3d" ? 4 : 1); ++layer) {
            const data = Uint8Array.from(Array.from({length: 16}, (_, i) => type === "cube" ? [0, 0, (layer + 1) * 32, 255]
                : [type === "3d" ? (layer + 1) * 48 : 32, (Math.floor(i / 4) + 1) * 48, (i % 4 + 1) * 48, 255]).flat());
            commands.push(wire("UpdateTexture", {resource_handle: handle, z: layer, width: 4, height: 4, depth: 1,
                row_pitch: 16, slice_pitch: 64, data_bytes: 64}, [blob("UpdateTexture", "data_offset", data)]));
        }
        commands.push(wire("SetTexture", {device_handle: dev, stage, texture_handle: handle}));
        for (const state of [1, 2, 3]) commands.push(wire("SetSamplerState", {device_handle: dev, sampler: stage, state, value: 3}));
        return commands;
    }
    for (const minor of [1, 2, 3, 4]) for (const count of [2, 3, 4]) for (const sign of [1, -1]) {
        const coord = [.75 * sign, .625 * sign, .25 * sign, 2 * sign];coord[count - 1] = 2 * sign;
        const uv = minor === 4 ? coord : coord.map(x => x / coord[count - 1]);
        add("shader-legacy-sampling", {name: "ps1." + minor + " projected count=" + count + " sign=" + sign, body: dev => [
            ...legacyPattern(dev, dev + 0x500000), tss(dev, 0, 24, 0x100 | count),
            ...bindLegacyPS(dev, ps1(minor, minor === 4 ? [[S.TEX, dst(R.TEMP, 0), src(R.TEXTURE, 0)]]
                : [[S.TEX, dst(R.TEXTURE, 0)], [S.MOV, dst(R.TEMP, 0), src(R.TEXTURE, 0)]])), ...legacyCoordinates(dev, [coord])],
        probes: [{at: [32, 32], expect: [...uv.slice(0, 2).map(x => (Math.min(3, Math.max(0, Math.floor(x * 4))) + 1) * 48), 32, 255]}]});
    }
    // Wine test_default_attribute_components: legacy colour outputs hold 8-bit values rounded to even,
    // so 0.3 (76.5 as fp32) stores 76 where round-half-up would store 77.
    for (const major of [1, 2]) add("shader-semantics", {name: `vs_${major}_${major === 1 ? 1 : 0} oD0 quantises to 8 bits with round-to-even`, body: dev => {
        const vs = dev + 0x700000, value = [.3, .2, .3, .2];
        const tokens = major === 1 ? [0xfffe0101, ...asm.def(0, ...value), ins(S.DCL, 0), 0x80000000, dst(R.INPUT, 0), ins(S.MOV, 0), dst(R.RASTOUT, 0), src(R.INPUT, 0), ins(S.MOV, 0), dst(R.ATTROUT, 0), src(R.CONST, 0), 0xffff]
            : [0xfffe0200, ins(S.DCL, 2), 0x80000000, dst(R.INPUT, 0), ...asm.def(0, ...value), ins(S.MOV, 2), dst(R.RASTOUT, 0), src(R.INPUT, 0), ins(S.MOV, 2), dst(R.ATTROUT, 0), src(R.CONST, 0), 0xffff];
        return [vertexShader(dev, vs, tokens), bindSemanticVS(dev, vs), ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))];
    }, probes: [{at: [32, 32], expect: [76, 51, 76, 51], tolerance: 0}]});
    // Wine test_mismatched_sample_types: a sampler whose declared dimension differs from the bound texture
    // samples that texture instead of dropping the draw.
    for (const [name, declared, bound, mask, expect, tolerance] of [
        ["2d sampler with a volume bound (xyz coordinate)", 0x90000000, "3d", 0x90070000, [48, 48, 48, 48], 2],
        ["2d sampler with a volume bound (xy coordinate)", 0x90000000, "3d", 0x90030000, [48, 48, 48, 48], 17],
        ["volume sampler with a 2d texture bound", 0xa0000000, "2d", 0x90070000, [112, 112, 112, 112], 1],
        ["cube sampler with a 2d texture bound", 0x98000000, "2d", 0x90070000, [112, 112, 112, 112], 1]])
        add("shader-legacy-sampling", {name: "ps_3_0 mismatched " + name, clear: 0x80808080, body: dev => {
            const handle = dev + 0x500000, commands = bound === "3d"
                ? [wire("CreateTextureVolume", {device_handle: dev, resource_handle: handle, width: 2, height: 2, depth: 2, level_count: 1, format: 21}),
                    ...[0x20, 0x40].map((value, layer) => wire("UpdateTexture", {resource_handle: handle, z: layer, width: 2, height: 2, depth: 1, row_pitch: 8, slice_pitch: 16, data_bytes: 16},
                        [blob("UpdateTexture", "data_offset", new Uint8Array(16).fill(value))]))]
                : [wire("CreateTexture2D", {device_handle: dev, resource_handle: handle, width: 2, height: 2, level_count: 1, format: 21}),
                    wire("UpdateTexture", {resource_handle: handle, width: 2, height: 2, depth: 1, row_pitch: 8, slice_pitch: 16, data_bytes: 16}, [blob("UpdateTexture", "data_offset", new Uint8Array(16).fill(0x70))])];
            return [...commands, wire("SetTexture", {device_handle: dev, texture_handle: handle}),
                ...[1, 2, 3].map(state => wire("SetSamplerState", {device_handle: dev, state, value: 3})), wire("SetSamplerState", {device_handle: dev, state: 5, value: 2}),
                ...bindLegacyPS(dev, [0xffff0300, 0x05000051, 0xa00f0000, 0x3f333333, 0x3f4ccccd, 0x3f666666, 0,
                    0x0200001f, 0x80000005, mask, 0x0200001f, declared, 0xa00f0800,
                    0x03000042, 0x800f0001, 0x90e40000, 0xa0e40800, 0x02020029, 0x80ff0001, 0xa0ff0000, 0x02000001, 0x800f0001, 0xa0e40000, 0x0000002b,
                    0x02000001, 0x800f0800, 0x80e40001, 0x0000ffff]), ...legacyCoordinates(dev, [[.5, .5, .5, 1]])];
        }, probes: [{at: [32, 32], expect, tolerance}]});
    // Wine test_uninitialized_varyings: an SM3 pixel input the vertex shader never writes still draws, reading zero.
    for (const [name, semantic] of [["COLOR1", [0x8001000a, 1]], ["TEXCOORD0", [0x80000005, 0]]]) for (const written of [false, true])
        add("shader-legacy-sampling", {name: `vs_3_0/ps_3_0 ${name} input ${written ? "written" : "never written"} by the vertex shader`, clear: 0xff00ff00, body: dev => {
            const vs = dev + 0x700000, positionTokens = [0xfffe0300, 0x0200001f, 0x80000000, 0x900f0000, 0x0200001f, 0x80000000, 0xe00f0000,
                ...(written ? [0x0200001f, semantic[0], 0xe00f0001, 0x05000051, 0xa00f0000, f(.5), f(.5), f(.5), f(.5), 0x02000001, 0xe00f0001, 0xa0e40000] : []),
                0x02000001, 0xe00f0000, 0x90e40000, 0x0000ffff];
            return [vertexShader(dev, vs, positionTokens), bindSemanticVS(dev, vs),
                ...bindLegacyPS(dev, [0xffff0300, 0x0200001f, semantic[0], 0x900f0000 | semantic[1], 0x02000001, 0x800f0800, 0x90e40000 | semantic[1], 0x0000ffff]),
                ...drawXYZ(dev, fullXYZ(.5, 0xffffffff))];
        }, probes: [{at: [32, 32], expect: written ? [128, 128, 128] : [0, 0, 0], tolerance: 1}]});
    // Wine volume_srgb_test: D3DSAMP_SRGBTEXTURE decodes volume textures too, and toggles per draw.
    add("srgb", {name: "volume texture sRGB read toggles on and off", body: dev => {
        const volume = dev + 0x500000, commands = [wire("CreateTextureVolume", {device_handle: dev, resource_handle: volume, width: 1, height: 1, depth: 1, level_count: 1, format: 21}),
            wire("UpdateTexture", {resource_handle: volume, width: 1, height: 1, depth: 1, row_pitch: 4, slice_pitch: 4, data_bytes: 4},
                [blob("UpdateTexture", "data_offset", Uint8Array.from([0x7f, 0x7f, 0x7f, 0x7f]))]),
            wire("SetTexture", {device_handle: dev, texture_handle: volume}), tss(dev, 0, 1, 2), tss(dev, 0, 2, 2), tss(dev, 0, 4, 2), tss(dev, 0, 5, 2), rs(dev, 174, 1)];
        [false, true, false].forEach((srgb, i) => commands.push(wire("SetSamplerState", {device_handle: dev, state: 11, value: srgb ? 1 : 0}),
            wire("SetScissorRect", {device_handle: dev, left: i * 20, top: 0, right: i * 20 + 20, bottom: 64}), ...coordinateQuad(dev, 3, [0, 0, 0])));
        return commands;
    }, probes: [{at: [10, 32], expect: [127, 127, 127, 127], tolerance: 2}, {at: [30, 32], expect: [54, 54, 54, 127], tolerance: 2}, {at: [50, 32], expect: [127, 127, 127, 127], tolerance: 2}]});
    // Wine unbound_sampler_test: a translated shader samples an unbound stage as opaque black.
    for (const [type, declaration] of [["2d", 0x90000000], ["cube", 0x98000000], ["volume", 0xa0000000]]) for (const major of [2, 3])
        add("shader-legacy-sampling", {name: `ps_${major}_0 unbound ${type} sampler reads opaque black`, clear: 0x56ffffff, body: dev => [
            ...bindLegacyPS(dev, [0xffff0000 | major << 8, 0x0200001f, declaration, 0xa00f0800, 0x0200001f, major === 3 ? 0x80000005 : 0x80000000, major === 3 ? 0x900f0000 : 0xb00f0000,
                0x03000042, 0x800f0000, major === 3 ? 0x90e40000 : 0xb0e40000, 0xa0e40800, 0x02000001, 0x800f0800, 0x80e40000, 0x0000ffff]),
            ...legacyCoordinates(dev, [[.5, .5, .5, 1]])], probes: [{at: [32, 32], expect: [0, 0, 0, 255]}]});
    // texbem displaces the stage's own coordinate after D3DTTFF_PROJECTED has divided it (Wine texbem_test).
    for (const [name, flags, scale] of [["plain", 0, 1], ["projected q=2", 0x104, 2], ["projected q=-1", 0x104, -1], ["projected q=.5", 0x104, .5]])
        add("shader-legacy-sampling", {name: "ps1.1 texbem " + name, body: dev => {
            const bumpMap = dev + 0x500001, uv = [.625, .375];
            return [...legacyPattern(dev, dev + 0x500000, "2d", 1),
                wire("CreateTexture2D", {device_handle: dev, resource_handle: bumpMap, width: 4, height: 4, level_count: 1, format: 60}),
                wire("UpdateTexture", {resource_handle: bumpMap, width: 4, height: 4, depth: 1, row_pitch: 8, slice_pitch: 32, data_bytes: 32},
                    [blob("UpdateTexture", "data_offset", Uint8Array.from(Array.from({length: 16}, () => [64, 0]).flat()))]),
                wire("SetTexture", {device_handle: dev, stage: 0, texture_handle: bumpMap}),
                ...[1, 2, 3].map(state => wire("SetSamplerState", {device_handle: dev, sampler: 0, state, value: 3})),
                tss(dev, 1, 7, f(0)), tss(dev, 1, 8, f(.5)), tss(dev, 1, 9, f(-.5)), tss(dev, 1, 10, f(0)), tss(dev, 1, 24, flags),
                ...bindLegacyPS(dev, ps1(1, [[S.TEX, dst(R.TEXTURE, 0)], [S.TEXBEM, dst(R.TEXTURE, 1), src(R.TEXTURE, 0)], [S.MOV, dst(R.TEMP, 0), src(R.TEXTURE, 1)]])),
                ...legacyCoordinates(dev, [[0, 0, 0, 1], [uv[0] * scale, uv[1] * scale, 0, scale]])];
        }, probes: [{at: [32, 32], expect: (() => {
            const du = 64 / 127, col = Math.floor(.625 * 4), row = Math.floor((.375 + .5 * du) * 4);
            return [(col + 1) * 48, (row + 1) * 48, 32, 255];
        })(), tolerance: 1}]});
    for (const kind of ["texreg2rgb", "texm3x3tex", "texm3x3spec", "texm3x3vspec"]) for (const type of ["2d", "cube", "3d"]) {
        const vector = [.625, .375, .875, 1], rows = [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1]];
        let coord = vector.slice(0, 3);
        if (kind.endsWith("spec")) {const dot = coord.reduce((a, x) => a + x, 0), norm = coord.reduce((a, x) => a + x * x, 0);coord = coord.map(x => 2 * x * dot / norm - 1);}
        const axis = coord.map(Math.abs).indexOf(Math.max(...coord.map(Math.abs))), face = axis * 2 + Number(coord[axis] < 0);
        const expected = type === "cube" ? [(face + 1) * 32, 0, 0, 255]
            : [...coord.slice(0, 2).map(x => (Math.min(3, Math.max(0, Math.floor(x * 4))) + 1) * 48),
                type === "3d" ? (Math.min(3, Math.max(0, Math.floor(coord[2] * 4))) + 1) * 48 : 32, 255];
        add("shader-legacy-sampling", {name: kind + " bound " + type, body: dev => {
            const stage = kind === "texreg2rgb" ? 1 : 3;
            const body = [[S.TEXCOORD, dst(R.TEXTURE, 0)]];
            if (stage === 3) body.push([S.TEXM3x3PAD, dst(R.TEXTURE, 1), src(R.TEXTURE, 0)], [S.TEXM3x3PAD, dst(R.TEXTURE, 2), src(R.TEXTURE, 0)]);
            if (kind === "texm3x3spec") body.unshift([S.DEF, dst(R.CONST, 0), f(1), f(1), f(1), f(1)]);
            body.push([S[{texreg2rgb: "TEXREG2RGB", texm3x3tex: "TEXM3x3TEX", texm3x3spec: "TEXM3x3SPEC", texm3x3vspec: "TEXM3x3VSPEC"}[kind]],
                dst(R.TEXTURE, stage), src(R.TEXTURE, 0), ...(kind === "texm3x3spec" ? [src(R.CONST, 0)] : [])],
            [S.MOV, dst(R.TEMP, 0), src(R.TEXTURE, stage)]);
            return [...legacyPattern(dev, dev + 0x500000, type, stage), ...bindLegacyPS(dev, ps1(3, body)), ...legacyCoordinates(dev, [vector, ...rows])];
        }, probes: [{at: [32, 32], expect: expected, tolerance: 1}]});
    }
    for (const format of [75, fourcc("INTZ"), fourcc("DF24")]) for (const minor of [1, 3, 4])
        for (const projected of [false, true]) for (const reference of [.25, .75]) {
            const raw = format !== 75, projectionApplies = projected && minor < 4, coord = [.5, .5, reference * 2, 2];
            const expected = raw ? 128 : (projectionApplies ? reference : reference * 2) <= .5 ? 255 : 0;
            add("shader-legacy-sampling", {name: "ps1." + minor + " depth format=" + format + " projected=" + projected + " reference=" + reference, body: dev => {
                const depth = dev + 0x500000;
                return [wire("CreateTexture2D", {device_handle: dev, resource_handle: depth, width: 64, height: 64, level_count: 1, format, usage: 2}),
                    wire("SetDepthStencilSurfaceLevel", {device_handle: dev, depth_texture_handle: depth, width: 64, height: 64}), clearDepth(dev, .5),
                    wire("SetDepthStencilSurfaceLevel", {device_handle: dev, depth_texture_handle: 0, width: 64, height: 64}), rs(dev, 7, 0),
                    wire("SetTexture", {device_handle: dev, texture_handle: depth}), tss(dev, 0, 24, projected ? 0x104 : 0),
                    ...bindLegacyPS(dev, ps1(minor, minor === 4 ? [[S.TEX, dst(R.TEMP, 0), src(R.TEXTURE, 0)]]
                        : [[S.TEX, dst(R.TEXTURE, 0)], [S.MOV, dst(R.TEMP, 0), src(R.TEXTURE, 0)]])), ...legacyCoordinates(dev, [coord])];
            }, probes: [{at: [32, 32], expect: [expected, expected, expected, expected], tolerance: 1}]});
        }

    add("shader-legacy-sampling", {name: "ps1 projected state switches within one frame", body: dev => {
        const commands = [...legacyPattern(dev, dev + 0x500000), ...bindLegacyPS(dev, ps1(1,
            [[S.TEX, dst(R.TEXTURE, 0)], [S.MOV, dst(R.TEMP, 0), src(R.TEXTURE, 0)]])), rs(dev, 174, 1)];
        for (const [left, right, flags] of [[0, 21, 0], [21, 43, 0x104], [43, 64, 0]]) commands.push(
            tss(dev, 0, 24, flags), wire("SetScissorRect", {device_handle: dev, left, top: 0, right, bottom: 64}),
            ...legacyCoordinates(dev, [[.75, .625, .25, 2]]));
        return commands;
    }, probes: [{at: [10, 32], expect: [192, 144, 32, 255]}, {at: [32, 32], expect: [96, 96, 32, 255]},
        {at: [54, 32], expect: [192, 144, 32, 255]}]});
    add("shader-legacy-sampling", {name: "ps1 dependent lookup changes sampler dimension within one frame", body: dev => {
        const commands = [...bindLegacyPS(dev, ps1(3, [[S.TEXCOORD, dst(R.TEXTURE, 0)],
            [S.TEXREG2RGB, dst(R.TEXTURE, 1), src(R.TEXTURE, 0)], [S.MOV, dst(R.TEMP, 0), src(R.TEXTURE, 1)]])), rs(dev, 174, 1)];
        for (const [i, type] of ["2d", "cube", "3d", "2d"].entries()) commands.push(
            ...legacyPattern(dev, dev + 0x500000 + i, type, 1),
            wire("SetScissorRect", {device_handle: dev, left: i * 16, top: 0, right: (i + 1) * 16, bottom: 64}),
            ...legacyCoordinates(dev, [[.625, .375, .875, 1]]));
        return commands;
    }, probes: [{at: [8, 32], expect: [144, 96, 32, 255]}, {at: [24, 32], expect: [160, 0, 0, 255]},
        {at: [40, 32], expect: [144, 96, 192, 255]}, {at: [56, 32], expect: [144, 96, 32, 255]}]});

    // The oracle applies the affine depth transform first, then clamps each
    // fragment. Clamping viewport endpoints would fail the -1..2 and 0..2 cases.
    for (const programmable of [false,true]) for (const screen of [false,true])
        for (const [low,high,z,limit] of [[-1,2,.25,.125],[0,2,.375,.5],[2,3,.1,.125],[-3,-2,.5,.125],[.2,.7,.1,.2]]) {
            const mapped=screen?z:Math.min(1,Math.max(0,low+(high-low)*z));
            add("viewport-range",{name:"viewport affine clamp "+[programmable,screen,low,high,z,limit],body:dev=>[
                clearDepth(dev,limit),rs(dev,7,1),rs(dev,23,2),rs(dev,22,1),
                wire("SetViewport",{device_handle:dev,x:0,y:0,width:64,height:64,min_z:low,max_z:high}),
                ...(programmable?[...bindLegacyPS(dev,[0xffff0200,...asm.def(0,0,1,0,1),asm.ins(S.MOV,2),dst(R.COLOROUT,0),src(R.CONST,0),0x0000ffff])]:[]),
                ...(screen?[draw(dev,quad(0,0,64,64,z,0xff00ff00))]:drawXYZ(dev,fullXYZ(z,0xff00ff00)))],
                probes:[{at:[32,32],expect:mapped<limit?[0,255,0,255]:[0,0,0,255]}]});
        }
    // D3DRS_DEPTHBIAS adds to the normalised depth value itself, independent of the
    // primitive's depth magnitude (Wine test_depthbias).
    for (const z of [.05,.3,.6,.9]) for (const bias of [-.4,-.2,0,.2,.4]) {
        const biased=z+bias;
        if (Math.abs(biased-.5)<.02) continue;
        add("depth-bias",{name:`constant depth bias z=${z} bias=${bias}`,body:dev=>[
            clearDepth(dev,.5),rs(dev,7,1),rs(dev,14,0),rs(dev,23,2),rs(dev,22,1),rs(dev,195,f(bias)),
            ...drawXYZ(dev,fullXYZ(z,0xff00ff00))],
            probes:[{at:[32,32],expect:biased<.5?[0,255,0,255]:[0,0,0,255]}]});
    }
    for (const slope of [0,16]) for (const bias of [0,.05]) {
        add("depth-bias",{name:`slope depth bias ${slope} constant ${bias}`,body:dev=>[
            clearDepth(dev,.65),rs(dev,7,1),rs(dev,14,0),rs(dev,23,2),rs(dev,22,1),
            rs(dev,175,f(slope)),rs(dev,195,f(bias)),
            ...drawXYZ(dev,fullXYZ(0,0xff00ff00).map(v=>[v[0],v[1],v[0] < 0 ? .2 : .8,v[3]]))],
            probes:[{at:[32,32],expect:slope ? [0,0,0,255] : [0,255,0,255]}]});
    }
    add("viewport-range",{name:"explicit pixel depth overrides extended viewport depth",body:dev=>[
        clearDepth(dev,.125),rs(dev,7,1),rs(dev,23,2),rs(dev,22,1),
        wire("SetViewport",{device_handle:dev,x:0,y:0,width:64,height:64,min_z:2,max_z:3}),
        ...bindLegacyPS(dev,[0xffff0200,...asm.def(0,0,1,0,1),...asm.def(1,.1,.1,.1,.1),
            asm.ins(S.MOV,2),dst(R.COLOROUT,0),src(R.CONST,0),
            asm.ins(S.MOV,2),dst(R.DEPTHOUT,0,1),src(R.CONST,1,0),0x0000ffff]),
        ...drawXYZ(dev,fullXYZ(.5,0xff00ff00))],probes:[{at:[32,32],expect:[0,255,0,255]}]});
    add("viewport-range",{name:"viewport larger than attachment clips to target without rescaling",body:dev=>[
        rs(dev,7,0),rs(dev,22,1),wire("SetViewport",{device_handle:dev,x:16,y:8,width:8192,height:8192,min_z:0,max_z:1}),
        ...drawXYZ(dev,fullXYZ(.5,0xff00ff00))],probes:[{at:[8,32],expect:[0,0,0,255]},
            {at:[32,4],expect:[0,0,0,255]},{at:[32,32],expect:[0,255,0,255]}]});

    for (const msaa of [0,4]) add("viewport-range",{name:"interpolated depth clamps after affine mapping msaa="+msaa,msaa,body:dev=>[
        clearDepth(dev,.125),rs(dev,7,1),rs(dev,23,2),rs(dev,22,1),
        wire("SetViewport",{device_handle:dev,x:0,y:0,width:64,height:64,min_z:-1,max_z:2}),
        ...drawXYZ(dev,[[-1,1,0,0xff00ff00],[1,1,1,0xff00ff00],[-1,-1,0,0xff00ff00],
            [1,1,1,0xff00ff00],[1,-1,1,0xff00ff00],[-1,-1,0,0xff00ff00]])],
        probes:[{at:[8,32],expect:[0,255,0,255]},{at:[32,32],expect:[0,0,0,255]},
            {at:[56,32],expect:[0,0,0,255]}]});

    // Native Wine D3D8 visual.c: screen vertices skip Z clipping when depth
    // testing is disabled; regular XYZ still passes through homogeneous clip.
    const depthSpan = (rhw = false) => quad(0,0,64,64,0,0xff00ff00)
        .map(v => [v[0],v[1],v[0] === 0 ? -.5 : 1.5,v[3],0xff000000,rhw && v[0] !== 0 ? 2 : 1]);
    const diffusePS = dev => bindLegacyPS(dev,[0xffff0101,1,0x800f0000,0x90e40000,0x0000ffff]);
    for (const programmable of [false,true]) for (const enabled of [false,true]) for (const rhw of [false,true])
        add("legacy-raster",{name:"screen Z clipping enabled="+enabled+" ps="+programmable+" varying RHW="+rhw,body:dev=>[
            rs(dev,7,+enabled),rs(dev,23,8),rs(dev,22,1),...(programmable?diffusePS(dev):[]),draw(dev,depthSpan(rhw))],
            probes:[{at:[8,32],expect:enabled?[0,0,0,255]:[0,255,0,255]},
                {at:[32,32],expect:[0,255,0,255]},{at:[56,32],expect:enabled?[0,0,0,255]:[0,255,0,255]}]});
    for (const programmable of [false,true]) for (const rhw of [false,true])
        add("legacy-raster",{name:"unclipped screen depth remains available to table fog ps="+programmable+" varying RHW="+rhw,body:dev=>[
            rs(dev,7,0),rs(dev,22,1),rs(dev,28,1),rs(dev,34,0xffff0000),rs(dev,35,3),rs(dev,36,f(0)),rs(dev,37,f(1)),
            ...(programmable?diffusePS(dev):[]),draw(dev,depthSpan(rhw))],
            probes:[{at:[8,32],expect:[0,255,0,255]}, {at:[32,32],expect:[128,128,0,255],tolerance:3},
                {at:[56,32],expect:[255,0,0,255]}]});
    for (const programmable of [false,true]) for (const table of [false,true])
        add("legacy-raster",{name:"equal fog endpoints "+(table?"table":"vertex")+" ps="+programmable,body:dev=>[
            rs(dev,7,0),rs(dev,22,1),rs(dev,28,1),rs(dev,34,0xffff0000),rs(dev,35,table?3:0),rs(dev,140,table?0:3),
            rs(dev,36,f(.5)),rs(dev,37,f(.5)),...(programmable?diffusePS(dev):[]),
            ...drawXYZ(dev,[[-1,1,0,0xff00ff00],[1,1,1,0xff00ff00],[-1,-1,0,0xff00ff00],
                [1,1,1,0xff00ff00],[1,-1,1,0xff00ff00],[-1,-1,0,0xff00ff00]])],
            probes:[{at:[24,32],expect:table?[0,255,0,255]:[255,0,0,255]}, {at:[40,32],expect:[255,0,0,255]}]});
    for (const enabled of [false,true]) add("legacy-raster",{name:"XYZ retains homogeneous clipping with Z enabled="+enabled,body:dev=>[
        rs(dev,7,+enabled),rs(dev,23,8),rs(dev,22,1),...drawXYZ(dev,[[-1,1,-.5,0xff00ff00],[1,1,1.5,0xff00ff00],[-1,-1,-.5,0xff00ff00],
            [1,1,1.5,0xff00ff00],[1,-1,1.5,0xff00ff00],[-1,-1,-.5,0xff00ff00]])],
        probes:[{at:[8,32],expect:[0,0,0,255]},{at:[32,32],expect:[0,255,0,255]},{at:[56,32],expect:[0,0,0,255]}]});
    const normalTransforms = [
        {name:"affine",matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],point:v=>[v[0],v[1],0],blue:255},
        {name:"projective",matrix:[1,0,0,0,0,1,0,0,0,0,1,-1,10,10,10,0],point:v=>[v[0]*10-10,v[1]*10-10,-10],blue:0},
        {name:"affine scaled normal",matrix:[1,0,0,0,0,1,0,0,0,0,2,0,0,0,0,1],point:v=>[v[0],v[1],0],blue:128},
    ];
    for (const row of normalTransforms) add("legacy-raster",{name:"normal inverse transpose "+row.name,body:dev=>{
        const list=fullXYZ(0,0xff0000ff),data=new Uint8Array(list.length*28),view=new DataView(data.buffer);
        list.forEach((v,i)=>{[...row.point(v),0,0,-1].forEach((x,j)=>view.setFloat32(i*28+j*4,x,true));view.setUint32(i*28+24,0xff0000ff,true);});
        return [rs(dev,7,0),rs(dev,22,1),rs(dev,137,1),rs(dev,141,1),rs(dev,145,1),rs(dev,143,0),
            material(dev,{}),wire("SetTransform",{device_handle:dev,state:256,matrix:row.matrix}),
            wire("SetLight",{device_handle:dev,type:3,diffuse:[1,1,1,1],direction:[0,0,1]}),wire("LightEnable",{device_handle:dev,enable:1}),
            cmd(P.OP.SET_FVF,cat([P.encode("SetFVF",{device_handle:dev,fvf:0x52,element_count:3}),element(0,2,0),element(12,2,3),element(24,4,10)])),
            wire("DrawPrimitiveUP",{device_handle:dev,primitive_type:4,primitive_count:2,stride:28,vertex_count:6,vertex_bytes:data.length},[blob("DrawPrimitiveUP","vertex_data_offset",data)])];
        },probes:[{at:[32,32],expect:[0,0,row.blue,255],tolerance:1}]});

    // D3D has no primitive restart in these strip draws: 65535 is a vertex.
    function maxIndexVertices(base=0,line=false) {
        const data=new Uint8Array((65537+Math.max(0,base))*16),v=new DataView(data.buffer);
        const put=(i,x,y,color)=>{v.setFloat32(i*16,x,true);v.setFloat32(i*16+4,y,true);v.setFloat32(i*16+8,.5,true);v.setUint32(i*16+12,color,true);};
        const points=line?[[-.75,.75],[.75,.75],[.75,-.75],[-.75,-.75]]:[[-1,1],[1,1],[-1,-1],[1,-1]];
        [1,2,3,65535].forEach((i,j)=>put(i+base,...points[j],0xff00ff00));
        return {data,put};
    }
    const maxIndexDecl=dev=>cmd(P.OP.SET_FVF,cat([P.encode("SetFVF",{device_handle:dev,fvf:0x42,element_count:2}),element(0,2,0),element(12,4,10)]));
    function maxIndexBuffers(dev,data,indices,wide) {
        const vb=dev+0x600000,ib=dev+0x600001;
        return [wire("CreateBuffer",{device_handle:dev,resource_handle:vb,resource_kind:1,byte_count:data.length}),
            wire("UpdateBuffer",{resource_handle:vb,byte_count:data.length},[blob("UpdateBuffer","data_offset",data)]),
            wire("CreateBuffer",{device_handle:dev,resource_handle:ib,resource_kind:2,byte_count:indices.length,fvf:wide?102:101}),
            wire("UpdateBuffer",{resource_handle:ib,byte_count:indices.length},[blob("UpdateBuffer","data_offset",indices)]),
            wire("SetStreamSource",{device_handle:dev,buffer_handle:vb,stride:16}),wire("SetIndices",{device_handle:dev,buffer_handle:ib})];
    }
    for(const up of [false,true])for(const line of [false,true])for(const wide of [false,true])for(const base of (up?[0]:[-1,1]))
        add("max-index",{name:`valid index65535 up=${up} line=${line} wide=${wide} base=${base}`,body:dev=>{
            const {data}=maxIndexVertices(base,line),indices=Uint8Array.from((wide?le32:le16)(...(up?[]:[99]),1,2,3,65535));
            return [rs(dev,7,0),rs(dev,22,1),maxIndexDecl(dev),...(up?[
                wire("DrawIndexedPrimitiveUP",{device_handle:dev,primitive_type:line?3:5,primitive_count:line?3:2,stride:16,vertex_count:65536,vertex_bytes:data.length,index_format:wide?102:101,index_bytes:indices.length},
                    [blob("DrawIndexedPrimitiveUP","vertex_data_offset",data),blob("DrawIndexedPrimitiveUP","index_data_offset",indices)])
            ]:[...maxIndexBuffers(dev,data,indices,wide),wire("DrawIndexedPrimitive",{device_handle:dev,primitive_type:line?3:5,primitive_count:line?3:2,base_vertex_index:base,start_index:1})])];
        },probes:(line?[[32,8],[56,32],[32,56]]:[[8,8],[32,32],[56,56]]).map(at=>({at,expect:[0,255,0,255]}))});
    add("max-index",{name:"cached strip partial unaligned update preserves earlier draw",body:dev=>{
        const {data,put}=maxIndexVertices();[[257,-1,1],[258,1,1],[259,-1,-1],[0xfeff,1,-1]].forEach(v=>put(...v,0xffff0000));
        const indices=Uint8Array.from(le16(99,1,2,3,65535)),ib=dev+0x600001;
        const dip=wire("DrawIndexedPrimitive",{device_handle:dev,primitive_type:5,primitive_count:2,start_index:1});
        return [rs(dev,7,0),rs(dev,22,1),maxIndexDecl(dev),...maxIndexBuffers(dev,data,indices,false),rs(dev,174,1),
            wire("SetScissorRect",{device_handle:dev,left:0,top:0,right:32,bottom:64}),dip,
            wire("UpdateBuffer",{resource_handle:ib,destination_offset:3,byte_count:7},[blob("UpdateBuffer","data_offset",Uint8Array.from([1,2,1,3,1,255,254]))]),
            wire("SetScissorRect",{device_handle:dev,left:32,top:0,right:64,bottom:64}),dip];
        },probes:[{at:[16,32],expect:[0,255,0,255]},{at:[48,32],expect:[255,0,0,255]}]});

    const extentTarget=(dev,handle,size,samples=0,format=21)=>wire("CreateTexture2D",{device_handle:dev,resource_handle:handle,width:size,height:size,level_count:1,format,usage:1,multisample_type:samples});
    const extentBind=(dev,handle,size,extra={})=>[wire("SetRenderTarget",{device_handle:dev,color_texture_handle:handle,...extra}),wire("SetViewport",{device_handle:dev,width:size,height:size,min_z:0,max_z:1})];
    const extentClear=(dev,flags,color=0,depth=1,stencil=0)=>wire("Clear",{device_handle:dev,clear_flags:flags,color,depth,stencil});
    const extentDepth=(dev,handle,size,samples=0)=>[wire("CreateTexture2D",{device_handle:dev,resource_handle:handle,width:size,height:size,level_count:1,format:75,usage:2,multisample_type:samples}),wire("SetDepthStencilSurfaceLevel",{device_handle:dev,depth_texture_handle:handle,width:size,height:size})];
    const extentStretch=(dev,from,to,size,extra={})=>wire("StretchRect",{device_handle:dev,source_texture_handle:from,source_right:size,source_bottom:size,destination_texture_handle:to,destination_right:64,destination_bottom:64,filter_point:1,...extra});
    for(const msaa of [0,4])for(const auto of [false,true])for(const backBuffer of [false,true]){
        const probes=[];for(let y=8;y<64;y+=16)for(let x=8;x<64;x+=16)probes.push({at:[x,y],expect:x<32&&y<32?[0,0,255,255]:x<48&&y<48?[0,255,0,255]:[255,0,0,255]});
        add("shared-depth",{name:`shared depth across 32/48/64 targets msaa=${msaa} auto=${auto} bb=${backBuffer}`,msaa,backBuffer,body:(dev,rt)=>{
            const small=dev+0x700000,mid=dev+0x700001,depth=dev+0x700002;
            return [...(auto?[]:extentDepth(dev,depth,64,msaa)),extentTarget(dev,small,32,msaa),extentTarget(dev,mid,48,msaa),
                rs(dev,7,1),rs(dev,14,1),rs(dev,23,4),rs(dev,22,1),extentClear(dev,3,0xff0000ff,1),
                ...extentBind(dev,small,32),extentClear(dev,3,0xffffffff,0),...extentBind(dev,mid,48),...drawXYZ(dev,fullXYZ(.5,0xff000000)),
                ...extentBind(dev,backBuffer?0:rt,64),rs(dev,14,0),...drawXYZ(dev,fullXYZ(.33,0xff00ff00)),...drawXYZ(dev,fullXYZ(.66,0xffff0000))];
        },probes});
    }
    for(const msaa of [0,4])add("shared-depth",{name:"shared stencil preserves regions and increments msaa="+msaa,msaa,body:(dev,rt)=>{
        const small=dev+0x700000,mid=dev+0x700001;
        return [extentTarget(dev,small,32,msaa),extentTarget(dev,mid,48,msaa),rs(dev,7,0),rs(dev,22,1),extentClear(dev,5,0xff0000ff,1,0),
            ...extentBind(dev,small,32),extentClear(dev,4,0,1,1),...extentBind(dev,mid,48),rs(dev,52,1),rs(dev,56,8),rs(dev,55,4),rs(dev,59,255),rs(dev,168,0),...drawXYZ(dev,fullXYZ(.5,0xffffffff)),
            ...extentBind(dev,rt,64),rs(dev,168,15),rs(dev,55,1),rs(dev,56,3),rs(dev,57,2),...drawXYZ(dev,fullXYZ(.5,0xff00ff00)),rs(dev,57,1),...drawXYZ(dev,fullXYZ(.5,0xffff0000))];
        },probes:[{at:[16,16],expect:[0,255,0,255]},{at:[40,16],expect:[255,0,0,255]},{at:[16,40],expect:[255,0,0,255]},{at:[56,56],expect:[0,0,255,255]}]});
    for(const msaa of [0,4])for(const format of [21,113])for(const srgb of (format===21?[false,true]:[false]))add("shared-depth",{name:`promoted color load/store retains untouched pixels msaa=${msaa} format=${format} srgb=${srgb}`,msaa,body:(dev,rt)=>{
        const small=dev+0x700000;
        return [extentTarget(dev,small,32,msaa,format),wire("ColorFill",{device_handle:dev,texture_handle:small,color:0xff804020,right:32,bottom:32}),
            rs(dev,194,+srgb),...extentBind(dev,small,32),extentClear(dev,2),rs(dev,7,0),rs(dev,22,1),rs(dev,174,1),wire("SetScissorRect",{device_handle:dev,right:16,bottom:32}),...drawXYZ(dev,fullXYZ(.5,0xff00ff00)),
            rs(dev,174,0),...extentBind(dev,rt,64),extentStretch(dev,small,rt,32)];
        },probes:[{at:[16,32],expect:[0,255,0,255]},{at:[48,32],expect:[128,64,32,255]}]});
    for(const format of [21,113])add("shared-depth",{name:"multisample color adapter preserves distinct sample values format="+format,msaa:4,body:(dev,rt)=>{
        const small=dev+0x700000,depth=dev+0x700002;
        return [extentTarget(dev,small,32,4,format),wire("SetDepthStencilSurfaceLevel",{device_handle:dev}),...extentBind(dev,small,32),extentClear(dev,1,0xff000000),
            rs(dev,7,0),rs(dev,22,1),rs(dev,161,1),rs(dev,162,1),...drawXYZ(dev,fullXYZ(.5,0xffff0000)),
            ...extentDepth(dev,depth,64,4),extentClear(dev,2),rs(dev,162,2),...drawXYZ(dev,fullXYZ(.5,0xff00ff00)),
            rs(dev,162,0xffffffff),...extentBind(dev,rt,64),extentStretch(dev,small,rt,32)];
        },probes:[{at:[32,32],expect:[64,64,0,255],tolerance:1}]});
    add("shared-depth",{name:"cube face and mip color adapter restores selected subresource",body:(dev,rt)=>{
        const cube=dev+0x700000;
        return [wire("CreateTextureCube",{device_handle:dev,resource_handle:cube,edge_length:64,level_count:2,format:21,usage:1}),
            wire("ColorFill",{device_handle:dev,texture_handle:cube,level:1,face:3,color:0xffff0000,right:32,bottom:32}),
            ...extentBind(dev,cube,32,{color_level:1,color_face:3}),extentClear(dev,2),rs(dev,7,0),rs(dev,22,1),rs(dev,174,1),wire("SetScissorRect",{device_handle:dev,right:16,bottom:32}),...drawXYZ(dev,fullXYZ(.5,0xff00ff00)),
            rs(dev,174,0),...extentBind(dev,rt,64),extentStretch(dev,cube,rt,32,{source_level:1,source_face:3})];
        },probes:[{at:[16,32],expect:[0,255,0,255]},{at:[48,32],expect:[255,0,0,255]}]});

    for(const size of [32,128])add("shared-depth",{name:"MRT extent adapter preserves slot identity and pixels outside target0 size="+size,mrt:true,body:(dev,rt)=>{
        const other=dev+0x700000;
        return [extentTarget(dev,other,size),wire("ColorFill",{device_handle:dev,texture_handle:other,color:0xff0000ff,right:size,bottom:size}),
            wire("SetRenderTarget",{device_handle:dev,target_index:1,color_texture_handle:other}),extentClear(dev,1,0xff00ff00),rs(dev,7,0),draw(dev,quad(0,0,64,64,.5,0xffff0000)),
            wire("SetRenderTarget",{device_handle:dev,target_index:1}),extentStretch(dev,other,rt+1,size)];
        },probes:[{at:[16,16],expect:[255,0,0,255]},{at:[16,16],target:1,expect:[0,255,0,255]},{at:[48,48],target:1,expect:size===32?[0,255,0,255]:[0,0,255,255]}]});

    for(const msaa of [0,4])add("shared-depth",{name:"implicit back buffer restores promoted color before present msaa="+msaa,msaa,backBuffer:true,body:dev=>[
        extentClear(dev,1,0xffff0000),...extentDepth(dev,dev+0x700000,128,msaa),extentClear(dev,2),rs(dev,7,1),rs(dev,22,1),rs(dev,174,1),
        wire("SetScissorRect",{device_handle:dev,right:32,bottom:64}),...drawXYZ(dev,fullXYZ(.5,0xff00ff00))],
        probes:[{at:[16,32],expect:[0,255,0,255]},{at:[48,32],expect:[255,0,0,255]}]});

    add("shared-depth",{name:"large viewport clears each differently sized color and depth attachment",mrt:true,body:(dev,rt)=>{
        const tiny=dev+0x700000,other=dev+0x700001,depth=dev+0x700002,color=dev+0x700003;
        return [extentTarget(dev,tiny,1),
            wire("CreateTexture2D",{device_handle:dev,resource_handle:other,width:1,height:2,level_count:1,format:21,usage:1}),
            extentTarget(dev,color,4),extentTarget(dev,rt+2,64),...extentDepth(dev,depth,4),
            ...extentBind(dev,tiny,640),wire("SetRenderTarget",{device_handle:dev,target_index:1,color_texture_handle:other}),
            extentClear(dev,3,0xffff0000,.5),wire("SetRenderTarget",{device_handle:dev,target_index:1}),
            extentStretch(dev,tiny,rt,1),extentStretch(dev,other,rt+1,1,{source_bottom:2}),
            ...extentBind(dev,color,4),rs(dev,7,1),rs(dev,14,0),rs(dev,23,4),rs(dev,22,1),
            ...drawXYZ(dev,fullXYZ(.4,0xff00ff00)),...drawXYZ(dev,fullXYZ(.6,0xffff0000)),
            extentStretch(dev,color,rt+2,4),...extentBind(dev,rt,64),wire("SetDepthStencilSurfaceLevel",{device_handle:dev})];
        },probes:[0,1,2].flatMap(target=>[[8,8],[48,8],[8,48],[48,48]].map(at=>({at,target,expect:target===2?[0,255,0,255]:[255,0,0,255]})))});

    // Original Wine pretransformed_varying_test semantics, scaled to 64x64.
    // The 152-byte declaration deliberately includes non-FFP usages together.
    const transformedFields=[[0,3,9,0],[16,3,1,0],[32,3,2,0],[48,3,3,0],[64,3,11,0],
        [80,3,5,0],[96,3,6,0],[112,3,7,0],[128,3,12,0],[144,4,10,0],[148,4,10,1]];
    const transformedData=()=>{
        const data=new Uint8Array(4*152),view=new DataView(data.buffer);
        [[0,0],[64,0],[0,64],[64,64]].forEach(([x,y],i)=>{
            const values=[x,y,.1,1,...Array(4).fill(.1),...Array(4).fill(.2),...Array(4).fill(.3),...Array(4).fill(.4),
                .5,.55,.55,.55,.6,.6,.6,.7,.7,.7,.7,.6,...Array(4).fill(.8)];
            values.forEach((v,k)=>view.setFloat32(i*152+k*4,v,true));
            view.setUint32(i*152+144,0xe6e6e6e6,true);view.setUint32(i*152+148,0x224488ff,true);
        });return data;
    };
    const transformedDraw=(dev,fields=transformedFields,data=transformedData())=>[
        cmd(P.OP.SET_FVF,cat([P.encode("SetFVF",{device_handle:dev,fvf:4,element_count:fields.length}),...fields.map(([offset,type,usage,index])=>element(offset,type,usage,index))])),
        wire("DrawPrimitiveUP",{device_handle:dev,primitive_type:5,primitive_count:2,stride:152,vertex_count:4,vertex_bytes:data.length},[blob("DrawPrimitiveUP","vertex_data_offset",data)])];
    for(const [usage,index,expected] of [[1,0,[26,26,26,26]],[2,0,[51,51,51,51]],[3,0,[77,77,77,77]],
        [11,0,[102,102,102,102]],[5,0,[128,140,140,140]],[6,0,[153,153,153,179]],[7,0,[179,179,179,153]],
        [12,0,[204,204,204,204]],[10,0,[230,230,230,230]],[10,1,[68,136,255,34]],[5,1,[0,0,0,0]],
        [8,0,[204,204,204,204]],[13,0,[204,204,204,204]]])add("transformed-semantics",{
        name:`POSITIONT to ps3 semantic ${usage}:${index}`,body:dev=>{
            const ps=dev+0x600001,fields=transformedFields.map(row=>row.slice());
            if(usage===8||usage===13)fields[8][2]=usage;
            return [pixelShader(dev,ps,semanticPS([{usage,index,register:7,mask:15}],[[S.MOV,dst(R.COLOROUT,0),src(R.INPUT,7)]])),bindPS(dev,ps),rs(dev,22,1),
                ...transformedDraw(dev,fields)];
        },probes:[{at:[36,24],expect:expected,tolerance:1}]});
    add("transformed-semantics",{name:"POSITIONT ps3 packed partial masks keep distinct semantic components",body:dev=>{
        const ps=dev+0x600001;
        return [pixelShader(dev,ps,semanticPS([{usage:1,index:0,register:3,mask:5},{usage:12,index:0,register:3,mask:10}],
            [[S.MOV,dst(R.COLOROUT,0),src(R.INPUT,3)]])),bindPS(dev,ps),rs(dev,22,1),...transformedDraw(dev)];
        },probes:[{at:[36,24],expect:[26,204,26,204],tolerance:1}]});

    for(const flat of [false,true])for(const rhw of [false,true])add("transformed-semantics",{
        name:`POSITIONT ps3 separates flat color and perspective normal flat=${flat} rhw=${rhw}`,body:dev=>{
            const ps=dev+0x600001,data=transformedData(),view=new DataView(data.buffer);
            for(let i=0;i<4;i++){
                const right=i%2;view.setFloat32(i*152+12,rhw&&right?2:1,true);
                view.setFloat32(i*152+52,right,true);view.setUint32(i*152+144,right?0xffff0000:0xff000000,true);
            }
            return [pixelShader(dev,ps,semanticPS([{usage:10,index:0,register:3,mask:1},{usage:3,index:0,register:3,mask:2}],
                [[S.DEF,dst(R.CONST,0),0,0,0,f(1)],[S.MOV,dst(R.COLOROUT,0),src(R.CONST,0)],
                [S.MOV,dst(R.COLOROUT,0,3),src(R.INPUT,3)]])),bindPS(dev,ps),rs(dev,9,flat?1:2),rs(dev,22,1),
                ...transformedDraw(dev,transformedFields,data)];
        },probes:[16,48].map(x=>{const value=rhw?2*x/(64+x):x/64;return {at:[x,x],expect:[flat?(x===16?0:255):clamp(value),clamp(value),0,255],tolerance:1};})});
    for(const flat of [false,true])add("transformed-semantics",{name:"POSITIONT ps3 forty consumed components flat="+flat,body:dev=>{
        const ps=dev+0x600001,declarations=transformedFields.slice(1).map(([,type,usage,index],register)=>({usage,index,register,mask:15}));
        return [pixelShader(dev,ps,semanticPS(declarations,[[S.DEF,dst(R.CONST,0),f(.1),f(.1),f(.1),f(.1)],
            [S.MOV,dst(R.TEMP,0),src(R.INPUT,0)],...Array.from({length:9},(_,i)=>[S.ADD,dst(R.TEMP,0),src(R.TEMP,0),src(R.INPUT,i+1)]),
            [S.MUL,dst(R.COLOROUT,0),src(R.TEMP,0),src(R.CONST,0)]])),bindPS(dev,ps),rs(dev,9,flat?1:2),rs(dev,22,1),...transformedDraw(dev)];
        },probes:[{at:[36,24],expect:[122,130,142,120],tolerance:1}]});
    add("transformed-semantics",{name:"POSITIONT ps3 normalized SHORT2 input expands absent components",body:dev=>{
        const ps=dev+0x600001,data=transformedData(),view=new DataView(data.buffer),fields=transformedFields.map(r=>r.slice());
        fields[3][1]=9;
        for(let i=0;i<4;i++){view.setInt16(i*152+48,16384,true);view.setInt16(i*152+50,8192,true);}
        return [pixelShader(dev,ps,semanticPS([{usage:3,index:0,register:8,mask:15}],[[S.MOV,dst(R.COLOROUT,0),src(R.INPUT,8)]])),bindPS(dev,ps),rs(dev,22,1),...transformedDraw(dev,fields,data)];
        },probes:[{at:[36,24],expect:[128,64,0,255],tolerance:1}]});
    add("transformed-semantics",{name:"POSITIONT ps3 missing diffuse defaults to white",body:dev=>{
        const ps=dev+0x600001;
        return [pixelShader(dev,ps,semanticPS([{usage:10,index:0,register:8,mask:15}],[[S.MOV,dst(R.COLOROUT,0),src(R.INPUT,8)]])),bindPS(dev,ps),rs(dev,22,1),...transformedDraw(dev,transformedFields.filter(row=>row[2]!==10))];
        },probes:[{at:[36,24],expect:[255,255,255,255]}]});
    add("transformed-semantics",{name:"POSITIONT ps3 generated point coordinates and declaration point size",body:dev=>{
        const ps=dev+0x600001,data=new Uint8Array(20),view=new DataView(data.buffer);
        [32,32,.1,1,32].forEach((v,i)=>view.setFloat32(i*4,v,true));
        return [pixelShader(dev,ps,semanticPS([{usage:5,index:3,register:8,mask:15}],[[S.MOV,dst(R.COLOROUT,0),src(R.INPUT,8)]])),bindPS(dev,ps),rs(dev,156,1),rs(dev,22,1),
            cmd(P.OP.SET_FVF,cat([P.encode("SetFVF",{device_handle:dev,fvf:4,element_count:2}),element(0,3,9),element(16,0,4)])),
            wire("DrawPrimitiveUP",{device_handle:dev,primitive_type:1,primitive_count:1,stride:20,vertex_count:1,vertex_bytes:20},[blob("DrawPrimitiveUP","vertex_data_offset",data)])];
        },probes:[{at:[24,24],expect:[64,64,0,255],tolerance:5},{at:[40,40],expect:[191,191,0,255],tolerance:5}]});

    for(const format of [70,75,80])for(const linear of [false,true])for(const auto of (format===75?[0,1,2]:[0]))add("depth-copy",{name:`whole depth copy preserves draw depth format=${format} linear=${linear} auto=${auto}`,body:dev=>{
        const from=auto===1?0xffffffff:dev+0x700000,to=auto===2?0xffffffff:dev+0x700001;
        const depth=handle=>handle===0xffffffff?[]:[wire("CreateTexture2D",{device_handle:dev,resource_handle:handle,width:64,height:64,level_count:1,format,usage:2})];
        const bind=handle=>wire("SetDepthStencilSurfaceLevel",{device_handle:dev,depth_texture_handle:handle,width:64,height:64});
        const vp=size=>wire("SetViewport",{device_handle:dev,width:size,height:size,min_z:0,max_z:1});
        return [...depth(from),...depth(to),bind(from),extentClear(dev,2,0,0),vp(48),extentClear(dev,2,0,.5),vp(32),extentClear(dev,2,0,1),vp(64),
            wire("StretchRect",{device_handle:dev,source_texture_handle:from,source_right:64,source_bottom:64,destination_texture_handle:to,destination_right:64,destination_bottom:64,filter_point:+!linear}),
            bind(to),extentClear(dev,1,0xffff0000),rs(dev,7,1),rs(dev,14,0),rs(dev,23,4),rs(dev,22,1),
            ...drawXYZ(dev,fullXYZ(.33,0xff00ff00)),...drawXYZ(dev,fullXYZ(.66,0xff0000ff))];
        },probes:[8,24,40,56].flatMap(y=>[8,24,40,56].map(x=>({at:[x,y],expect:x<32&&y<32?[0,0,255,255]:x<48&&y<48?[0,255,0,255]:[255,0,0,255]})))});
    add("depth-copy",{name:"whole D24S8 copy preserves stencil aspect",body:dev=>{
        const from=dev+0x700000,to=dev+0x700001;
        return [...extentDepth(dev,from,64),extentClear(dev,4,0,1,5),...extentDepth(dev,to,64),extentClear(dev,4,0,1,0),
            wire("StretchRect",{device_handle:dev,source_texture_handle:from,source_right:64,source_bottom:64,destination_texture_handle:to,destination_right:64,destination_bottom:64,filter_point:1}),
            extentClear(dev,1,0xffff0000),rs(dev,7,0),rs(dev,22,1),rs(dev,52,1),rs(dev,56,3),rs(dev,57,5),...drawXYZ(dev,fullXYZ(.5,0xff00ff00))];
        },probes:[{at:[32,32],expect:[0,255,0,255]}]});

    for(const screen of [false,true])for(const programmable of [false,true])
    for(const [low,high] of [[0,0],[.5,0],[.5,.5002],[.5,.5],[1,1],[-.001,-.001]])for(const side of [-1,1]){
        const z=.5,mapped=screen?z:Math.min(1,Math.max(0,low+(Math.max(high,Math.fround(low+.001))-low)*z));
        const limit=mapped+side*.0001;
        if(limit<0||limit>1)continue;
        add("viewport-minimum",{name:`minimum native viewport span ${low}:${high} screen=${screen} ps=${programmable} side=${side}`,body:dev=>[
            clearDepth(dev,limit),rs(dev,7,1),rs(dev,23,side<0?5:2),rs(dev,22,1),
            wire("SetViewport",{device_handle:dev,width:64,height:64,min_z:low,max_z:high}),
            ...(programmable?bindLegacyPS(dev,[0xffff0200,...asm.def(0,0,1,0,1),asm.ins(S.MOV,2),dst(R.COLOROUT,0),src(R.CONST,0),0xffff]):[]),
            ...(screen?[draw(dev,quad(0,0,64,64,z,0xff00ff00))]:drawXYZ(dev,fullXYZ(z,0xff00ff00)))],probes:[{at:[32,32],expect:[0,255,0,255]}]});
    }
    const streamOrder={position:[0,1,2],color:[1,0,2],unused:[1,2,3]};
    for(const [order,streams] of Object.entries(streamOrder))for(const divisor of [0,1,2])for(const indexed of [false,true])
    for(const count of [0,4])add("stream-frequency",{name:`stream zero owns instance count ${order} divisor=${divisor} indexed=${indexed} count=${count}`,body:dev=>{
        const vs=dev+0x600000,ib=dev+0x600001;
        const tokens=legacyShader("vertex",2,[semanticDcl(0,0,R.INPUT,0),semanticDcl(10,0,R.INPUT,1),semanticDcl(5,0,R.INPUT,2),
            [S.ADD,dst(R.RASTOUT,0),src(R.INPUT,0),src(R.INPUT,2)],[S.MOV,dst(R.ATTROUT,0),src(R.INPUT,1)]]);
        const arrays=[[-.25,.25,0,1,.25,.25,0,1,-.25,-.25,0,1,.25,-.25,0,1],Array(4).fill([1,0,0,1]).flat(),[-.5,.5,0,0,.5,.5,0,0,-.5,-.5,0,0,.5,-.5,0,0]];
        const commands=[vertexShader(dev,vs,tokens),bindSemanticVS(dev,vs),rs(dev,7,0),rs(dev,22,1),
            cmd(P.OP.SET_FVF,cat([P.encode("SetFVF",{device_handle:dev,element_count:3}),...[0,10,5].map((usage,i)=>P.encode("VertexElement",{stream:streams[i],offset:0,type:3,usage,usage_index:0}))]))];
        for(let i=0;i<3;i++){
            const data=Uint8Array.from(floats(...arrays[i])),handle=dev+0x700000+i;
            commands.push(wire("CreateBuffer",{device_handle:dev,resource_handle:handle,resource_kind:1,byte_count:data.length}),
                wire("UpdateBuffer",{resource_handle:handle,byte_count:data.length},[blob("UpdateBuffer","data_offset",data)]),
                wire("SetStreamSource",{device_handle:dev,buffer_handle:handle,stream:streams[i],stride:16}),
                wire("SetStreamSourceFreq",{device_handle:dev,stream:streams[i],divider:i===2?(0x80000000|divisor)>>>0:0x40000007}));
        }
        commands.push(wire("SetStreamSourceFreq",{device_handle:dev,stream:0,divider:0x40000000|count}));
        if(indexed){const data=Uint8Array.from(le16(0,1,2,3));commands.push(wire("CreateBuffer",{device_handle:dev,resource_handle:ib,resource_kind:2,byte_count:8,fvf:101}),
            wire("UpdateBuffer",{resource_handle:ib,byte_count:8},[blob("UpdateBuffer","data_offset",data)]),wire("SetIndices",{device_handle:dev,buffer_handle:ib}),
            wire("DrawIndexedPrimitive",{device_handle:dev,primitive_type:5,primitive_count:2}));}
        else commands.push(wire("DrawPrimitive",{device_handle:dev,primitive_type:5,primitive_count:2}));
        return commands;
        },probes:[[16,16],[48,16],[16,48],[48,48]].map((at,i)=>({at,expect:(indexed?(count>0&&(divisor===0?i===0:i<Math.ceil(count/divisor))):i===0)?[255,0,0,255]:[0,0,0,255]}))});

    // Software/mixed VS register banks: direct banked addressing, relative
    // addressing beyond uniform limits, local DEF precedence and draw ordering.
    const swConstant = (dev, kind, start, values) => {
        const schema = "SetShaderConstantF";
        return cmd(P.OP["SET_VERTEX_SHADER_CONSTANT_" + kind], P.encode(schema, {
            device_handle: dev, start_register: start, vector_count: values.length / (kind === "B" ? 1 : 4)
        }), [blob(schema, "data_offset", Uint8Array.from(kind === "F" ? floats(...values) : le32(...values)))]);
    };
    const bankedConst = index => [index < 2048 ? R.CONST : index < 4096 ? R.CONST2 : index < 6144 ? R.CONST3 : R.CONST4, index & 2047];
    for (const behaviorFlags of [0x20, 0x80]) for (const index of [255,256,2047,2048,4095,4096,6143,6144,8191])
    for (const relative of [false,true]) for (const local of [false,true]) add("software-constants", {
        name:`extended VS flags=${behaviorFlags} c${index} relative=${relative} local=${local}`, behaviorFlags,
        body: dev => {
            const reg=bankedConst(index),vs=dev+0x600000;
            const instructions=[semanticDcl(0,0,R.INPUT,0),[S.MOV,dst(R.RASTOUT,0),src(R.INPUT,0)]];
            if(local) instructions.push([S.DEF,dst(...reg),f(0),f(1),f(0),f(1)]);
            if(relative) instructions.push([S.MOVA,dst(R.ADDR,0,1),src(R.CONST,0,0)],
                [S.MOV,dst(R.ATTROUT,0),relativeToken(src(R.CONST,0)),src(R.ADDR,0,0)]);
            else instructions.push([S.MOV,dst(R.ATTROUT,0),src(...reg)]);
            return [vertexShader(dev,vs,legacyShader("vertex",2,instructions)),bindSemanticVS(dev,vs),rs(dev,7,0),rs(dev,22,1),
                swConstant(dev,"F",0,[index,0,0,0]),swConstant(dev,"F",index,[1,0,0,1]),
                ...drawXYZ(dev,fullXYZ(.5,0xffffffff).map(v=>[v[0]*.5-.5,...v.slice(1)])),
                swConstant(dev,"F",index,[0,0,1,1]),
                ...drawXYZ(dev,fullXYZ(.5,0xffffffff).map(v=>[v[0]*.5+.5,...v.slice(1)]))];
        },probes:[{at:[16,32],expect:local?[0,255,0,255]:[255,0,0,255]},
            {at:[48,32],expect:local?[0,255,0,255]:[0,0,255,255]}]});
    for (const behaviorFlags of [0x20,0x80]) for (const index of [15,16,2047]) for(const enabled of [false,true])
    add("software-constants",{name:`extended integer/boolean flags=${behaviorFlags} i${index} b${index} enabled=${enabled}`,behaviorFlags,
        body:dev=>{const vs=dev+0x600000;return [vertexShader(dev,vs,legacyShader("vertex",2,[semanticDcl(0,0,R.INPUT,0),
            [S.DEF,dst(R.CONST,0),f(1),f(0),f(0),f(1)],[S.MOV,dst(R.RASTOUT,0),src(R.INPUT,0)],
            [S.MOV,dst(R.ATTROUT,0),src(R.CONST,0)],[S.IF,src(R.CONSTBOOL,index)],
            [S.MOV,dst(R.ATTROUT,0),src(R.CONSTINT,index)],[S.ENDIF]])),bindSemanticVS(dev,vs),rs(dev,7,0),rs(dev,22,1),
            swConstant(dev,"I",index,[0,1,0,1]),swConstant(dev,"B",index,[enabled?1:0]),...drawXYZ(dev,fullXYZ(.5,0xffffffff))];},
        probes:[{at:[32,32],expect:enabled?[0,255,0,255]:[255,0,0,255]}]});

    // Independent native table from Wine test_texture_transform_flags: four
    // input widths, fixed/screen/generated/programmed VS and four pixel paths.
    const transformFlags=[0,1,2,3,4,0x100,0x101,0x102,0x103,0x104,0xfffffeff,0xffffffff,0xffffff03];
    for(const width of [1,2,3,4])for(const vertex of ["screen","fixed","normal","shader"])
    for(const pixel of ["fixed","ps1","ps2","coords"])for(const flags of transformFlags){
        const projected=!!(flags&0x100),count=(flags&~0x100)>>>0,transforms=count>=2&&count<=4;
        if(projected&&vertex==="screen"&&(pixel==="fixed"||pixel==="ps1"))continue; // Native driver-dependent cases are excluded upstream.
        const source=(vertex==="normal"?[.1,.3,.6]:[.8,.2,.4,.5].slice(0,width)).map(Math.fround),coord=[0,0,0,0];
        if(vertex==="fixed"||vertex==="normal"){
            if(transforms){const attrib=[...source];if(attrib.length<4)attrib.push(1);while(attrib.length<4)attrib.push(0);
                for(let k=0;k<count;k++)coord[k]=attrib[3-k];if(projected&&count<4)coord[3]=coord[count-1];}
            else{source.forEach((v,i)=>coord[i]=v);if(projected)coord[3]=source.at(-1);}
        }else{coord[3]=1;source.forEach((v,i)=>coord[i]=v);}
        const uv=coord.slice(0,2).map(v=>projected&&pixel!=="ps2"?(coord[3]?Math.fround(v/coord[3]):0):v);
        const expected=pixel==="coords"?coord.map(clamp):[...uv.map(v=>Math.round(Math.floor((v-Math.floor(v))*64)*255/64)),0,0];
        add("texture-transform-flags",{name:`texture transform width=${width} vs=${vertex} ps=${pixel} flags=${flags.toString(16)}`,body:dev=>{
            const tex=dev+0x500000,vs=dev+0x600000,ps=vs+1;
            const data=Uint8Array.from(Array.from({length:4096},(_,i)=>[0,Math.round(Math.floor(i/64)*255/64),Math.round((i%64)*255/64),0]).flat());
            const commands=[wire("CreateTexture2D",{device_handle:dev,resource_handle:tex,width:64,height:64,level_count:1,format:21}),
                wire("UpdateTexture",{resource_handle:tex,width:64,height:64,depth:1,row_pitch:256,slice_pitch:data.length,data_bytes:data.length},[blob("UpdateTexture","data_offset",data)]),
                wire("SetTexture",{device_handle:dev,texture_handle:tex}),rs(dev,7,0),rs(dev,22,1),rs(dev,137,0),tss(dev,0,1,2),tss(dev,0,2,2),tss(dev,0,4,2),tss(dev,0,5,2),
                tss(dev,0,24,flags),tss(dev,0,11,vertex==="normal"?0x10000:0),
                wire("SetTransform",{device_handle:dev,state:16,matrix:[0,0,0,1,0,0,1,0,0,1,0,0,1,0,0,0]})];
            if(vertex==="shader")commands.push(vertexShader(dev,vs,legacyShader("vertex",2,[semanticDcl(0,0,R.INPUT,0),semanticDcl(5,0,R.INPUT,1),
                [S.MOV,dst(R.RASTOUT,0),src(R.INPUT,0)],[S.MOV,dst(R.OUTPUT,0),src(R.INPUT,1)]])),bindSemanticVS(dev,vs));
            if(pixel!=="fixed"){
                const tokens=pixel==="ps1"?ps1(1,[[S.TEX,dst(R.TEXTURE,0)],[S.MOV,dst(R.TEMP,0),src(R.TEXTURE,0)]])
                    :legacyShader("pixel",2,[[S.DCL,0x80000000,dst(R.TEXTURE,0)],...(pixel==="coords"?[[S.MOV,dst(R.COLOROUT,0),src(R.TEXTURE,0)]]:
                        [[S.DCL,0x90000000,dst(R.SAMPLER,0)],[S.TEX,dst(R.TEMP,0),src(R.TEXTURE,0),src(R.SAMPLER,0)],[S.MOV,dst(R.COLOROUT,0),src(R.TEMP,0)]])]);
                commands.push(pixelShader(dev,ps,tokens),bindPS(dev,ps));
            }
            const screen=vertex==="screen",stride=screen?32:40,vertices=new Uint8Array(stride*6),view=new DataView(vertices.buffer);
            const positions=screen?quad(0,0,64,64,.5,0):fullXYZ(.5,0);
            positions.forEach((p,i)=>{const row=screen?[...p.slice(0,3),1,.8,.2,.4,.5]:[...p.slice(0,3),.1,.3,.6,.8,.2,.4,.5];row.forEach((v,j)=>view.setFloat32(i*stride+j*4,v,true));});
            commands.push(cmd(P.OP.SET_FVF,cat([P.encode("SetFVF",{device_handle:dev,element_count:screen?2:3}),element(0,screen?3:2,screen?9:0),
                ...(!screen?[element(12,2,3)]:[]),element(screen?16:24,width-1,5)])),
                wire("DrawPrimitiveUP",{device_handle:dev,primitive_type:4,primitive_count:2,stride,vertex_count:6,vertex_bytes:vertices.length},[blob("DrawPrimitiveUP","vertex_data_offset",vertices)]));
            return commands;
        },probes:[{at:[32,32],expect:expected,tolerance:pixel==="coords"?1:4}]});
    }

    for(const stage of ["vertex","pixel"])for(const major of [2,3])for(const mask of [7,15])for(const swizzle of [0xe4,0x39])
    for(const value of [[2,0,0,.5],[1,1,1,1],[0,0,0,0],[1,1,0,2],[-2,0,0,.5],[.1,.3,.6,.5]]){
        const input=Array.from({length:4},(_,i)=>value[swizzle>>(i*2)&3]),length=Math.hypot(...input.slice(0,3));
        const expected=input.map((v,i)=>i===3&&mask===7?.4:length?v/length:0).map(clamp);
        add("shader-normalize",{name:`NRM ${stage}${major} mask=${mask} swizzle=${swizzle} value=${value}`,body:dev=>{
            const handle=dev+0x600000,body=[[S.DEF,dst(R.CONST,0),...value.map(f)],[S.DEF,dst(R.CONST,1),f(.1),f(.2),f(.3),f(.4)],
                [S.MOV,dst(R.TEMP,0),src(R.CONST,1)],[S.NRM,dst(R.TEMP,0,mask),src(R.CONST,0,swizzle)]];
            let tokens;
            if(stage==="pixel")tokens=legacyShader("pixel",major,[...body,[S.MOV,dst(R.COLOROUT,0),src(R.TEMP,0)]]);
            else tokens=legacyShader("vertex",major,[semanticDcl(0,0,R.INPUT,0),...(major===3?[semanticDcl(0,0,R.OUTPUT,11),semanticDcl(10,0,R.OUTPUT,0)]:[]),
                ...body,[S.MOV,dst(major===3?R.OUTPUT:R.RASTOUT,major===3?11:0),src(R.INPUT,0)],
                [S.MOV,dst(major===3?R.OUTPUT:R.ATTROUT,0),src(R.TEMP,0)]]);
            return [stage==="pixel"?pixelShader(dev,handle,tokens):vertexShader(dev,handle,tokens),stage==="pixel"?bindPS(dev,handle):bindSemanticVS(dev,handle),
                rs(dev,7,0),rs(dev,22,1),tss(dev,0,1,2),tss(dev,0,2,0),tss(dev,0,4,2),tss(dev,0,5,0),...drawXYZ(dev,fullXYZ(.5,0xffffffff))];
        },probes:[{at:[32,32],expect:expected,tolerance:1}]});
    }

    // Wine test_null_format: a NULL-format target has no storage; its draws and clears extend over
    // the viewport and are bounded only by the depth surface.
    {
        const NULL = fourcc("NULL"), partial = z => [[-1, .5, z, 0xff0000ff], [.5, .5, z, 0xff0000ff], [-1, -1, z, 0xff0000ff],
            [.5, .5, z, 0xff0000ff], [.5, -1, z, 0xff0000ff], [-1, -1, z, 0xff0000ff]];
        const depthState = dev => [rs(dev, 7, 1), rs(dev, 14, 1), rs(dev, 23, 4)];
        for (const [name, format, expect] of [["NULL", NULL, [0, 0, 0, 255]], ["ordinary", 21, [0, 255, 0, 255]]])
            add("null-target", { name: `${name} 32x32 target: depth writes ${format === NULL ? "reach" : "stay inside"} the viewport beyond the target`, body: (dev, rt) => {
                const small = dev + 0x700000;
                return [extentTarget(dev, small, 32, 0, format), ...depthState(dev), ...extentBind(dev, small, 64), extentClear(dev, 2, 0, 1),
                    ...drawXYZ(dev, fullXYZ(.5, 0xffff0000)), ...extentBind(dev, rt, 64), ...drawXYZ(dev, fullXYZ(.75, 0xff00ff00))];
            }, probes: [{ at: [16, 16], expect: [0, 0, 0, 255] }, { at: [48, 48], expect }, { at: [48, 16], expect }] });
        add("null-target", { name: "NULL target larger than the depth surface still depth-tests and writes inside it", body: (dev, rt) => {
            const target = dev + 0x700000;
            return [extentTarget(dev, target, 128, 0, NULL), ...depthState(dev), ...extentBind(dev, target, 128), extentClear(dev, 2, 0, .6),
                wire("SetViewport", { device_handle: dev, width: 64, height: 64, min_z: 0, max_z: 1 }), ...drawXYZ(dev, partial(.1)),
                ...extentBind(dev, rt, 64), extentClear(dev, 1, 0xff000000), ...drawXYZ(dev, fullXYZ(.5, 0xffff0000))];
        }, probes: [{ at: [24, 40], expect: [0, 0, 0, 255] }, { at: [56, 8], expect: [255, 0, 0, 255] },
            { at: [56, 40], expect: [255, 0, 0, 255] }, { at: [24, 8], expect: [255, 0, 0, 255] }] });
    }
    // AMD Fetch4 (Wine test_fetch4): D3DSAMP_MIPMAPLODBIAS = 'GET4' on a one-channel 2D
    // texture returns the 2x2 footprint starting at floor(coord * size) as (top-right,
    // bottom-left, bottom-right, top-left); every LOD form reads level zero.
    {
        const GET4 = 0x34544547, GET1 = 0x31544547, rows = [[0x13,0x12,0x11,0x10],[0x02,0xf2,0xf1,0x01],[0x04,0xf4,0xf3,0x03],[0x23,0x22,0x21,0x20]];
        const half = x => { if (!x) return 0;const e = Math.floor(Math.log2(x));return ((e + 15) << 10) + Math.round((x / 2 ** e - 1) * 1024); };
        // 8-value BC4 block (a0 > a1) whose indices walk the palette.
        const bc4Index = i => (i * 5 + 1) % 8, bc4Palette = [255, 0, ...[2, 3, 4, 5, 6, 7].map(k => Math.round((8 - k) * 255 / 7))];
        const bc4 = new Uint8Array(8);bc4[0] = 255;
        for (let i = 0; i < 16; i++) for (let bit = 0; bit < 3; bit++) if (bc4Index(i) >> bit & 1) bc4[2 + ((i * 3 + bit) >> 3)] |= 1 << ((i * 3 + bit) & 7);
        const flat = rows.flat();
        const f4formats = [
            { name: "L8", format: 50, vals: flat, data: Uint8Array.from(flat), pitch: 4, plain: v => [v, v, v, 255] },
            { name: "A8", format: 28, vals: flat, data: Uint8Array.from(flat), pitch: 4, plain: v => [0, 0, 0, v] },
            { name: "L16", format: 81, vals: flat, data: Uint8Array.from(le16(...flat.map(v => v * 257))), pitch: 8, plain: v => [v, v, v, 255] },
            { name: "R16F", format: 111, vals: flat, data: Uint8Array.from(le16(...flat.map(v => half(v / 255)))), pitch: 8, plain: v => [v, 255, 255, 255] },
            { name: "R32F", format: 114, vals: flat, data: Uint8Array.from(le32(...flat.map(v => f(v / 255)))), pitch: 16, plain: v => [v, 255, 255, 255] },
        ];
        const ati1n = { name: "ATI1N", format: fourcc("ATI1"), vals: flat.map((_, i) => bc4Palette[bc4Index(i)]), data: bc4, pitch: 8, plain: v => [v, v, v, v] };
        const vsTokens = [0xfffe0300, 0x0200001f, 0x80000000, 0x900f0000, 0x0200001f, 0x80000005, 0x900f0001, 0x0200001f, 0x80000000, 0xe00f0000,
            0x0200001f, 0x80000005, 0xe00f0001, 0x02000001, 0xe00f0000, 0x90e40000, 0x02000001, 0xe00f0001, 0x90e40001, 0x0000ffff];
        const psHead = [0xffff0300, 0x0200001f, 0x80000005, 0x900f0000, 0x0200001f, 0x90000000, 0xa00f0800], psTail = [0x02000001, 0x800f0800, 0x80e40000, 0x0000ffff];
        const programs = {
            texld: { p: 1, tokens: [...psHead, 0x03000042, 0x800f0000, 0x90e40000, 0xa0e40800, ...psTail] },
            texldp: { p: 2, tokens: [...psHead, 0x05000051, 0xa00f0000, 0, 0, 0x40800000, 0x40000000, 0x02000001, 0x80030000, 0x90f40000,
                0x02000001, 0x800c0000, 0xa0e00000, 0x03010042, 0x800f0000, 0x80e40000, 0xa0e40800, ...psTail] },
            texld_yzwx: { p: 1, rotate: true, tokens: [...psHead, 0x03000042, 0x800f0000, 0x90e40000, 0xa0390800, ...psTail] },
            texldd: { p: 1, tokens: [...psHead, 0x05000051, 0xa00f0000, 0x3f000000, 0x3f000000, 0x3f000000, 0x3f000000,
                0x05000051, 0xa00f0001, 0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000, 0x02000001, 0x800f0002, 0xa0e40000,
                0x0500005d, 0x800f0000, 0x90e40000, 0xa0e40800, 0xa0e40000, 0x80e40002, ...psTail] },
            texldb: { p: 1, tokens: [...psHead, 0x05000051, 0xa00f0000, 0, 0, 0x40a00000, 0x40a00000, 0x03000002, 0x800f0000, 0x90e40000, 0xa0e40000,
                0x03020042, 0x800f0000, 0x80e40000, 0xa0e40800, ...psTail] },
            texldl: { p: 1, tokens: [...psHead, 0x05000051, 0xa00f0000, 0, 0, 0x3f000000, 0x3f000000, 0x03000002, 0x800f0000, 0x90e40000, 0xa0e40000,
                0x0300005f, 0x800f0000, 0x80e40000, 0xa0e40800, ...psTail] },
            FFP: { p: 1 },
            FFP_proj: { p: 2, flags: 0x100 },
            FFP_proj3: { p: 4, flags: 0x103 },
        };
        const fetch4Quad = dev => {
            const data = new Uint8Array(6 * 28), view = new DataView(data.buffer);
            fullXYZ(.5, 0).forEach((v, i) => [v[0], v[1], v[2], (v[0] + 1) / 2, (1 - v[1]) / 2, 4, 2].forEach((x, j) => view.setFloat32(i * 28 + j * 4, x, true)));
            return [cmd(P.OP.SET_FVF, cat([P.encode("SetFVF", { device_handle: dev, fvf: 0x20102, element_count: 2 }), element(0, 2, 0), element(12, 3, 5)])),
                wire("DrawPrimitiveUP", { device_handle: dev, primitive_type: 4, primitive_count: 2, stride: 28, vertex_count: 6, vertex_bytes: data.length },
                    [blob("DrawPrimitiveUP", "vertex_data_offset", data)])];
        };
        const samplerSetup = (dev, bias) => [[1, 3], [2, 3], [5, 1], [6, 1], [7, 1], [8, bias]].map(([state, value]) => wire("SetSamplerState", { device_handle: dev, state, value }));
        const bindProgram = (dev, name) => {
            const program = programs[name];
            if (!program.tokens) return [tss(dev, 0, 24, program.flags || 0)];
            return [vertexShader(dev, dev + 0x700000, vsTokens), bindSemanticVS(dev, dev + 0x700000),
                pixelShader(dev, dev + 0x600000, program.tokens), bindPS(dev, dev + 0x600000)];
        };
        const points = [0, 1, 2, 3].flatMap(cy => [0, 1, 2, 3].map(cx => [cx, cy]));
        const footprint = (vals, cx, cy, p) => {
            const at = (x, y) => vals[Math.min(3, y) * 4 + Math.min(3, x)], bx = Math.floor((cx + .28125) / p), by = Math.floor((cy + .28125) / p);
            return [at(bx + 1, by), at(bx, by + 1), at(bx + 1, by + 1), at(bx, by)];
        };
        const plainAt = (spec, cx, cy, p) => spec.plain(spec.vals[Math.min(3, Math.floor((cy + .28125) / p)) * 4 + Math.min(3, Math.floor((cx + .28125) / p))]);
        const texture4 = (dev, spec) => [wire("CreateTexture2D", { device_handle: dev, resource_handle: dev + 0x500000, width: 4, height: 4, level_count: 1, format: spec.format }),
            wire("UpdateTexture", { resource_handle: dev + 0x500000, width: 4, height: 4, depth: 1, row_pitch: spec.pitch, slice_pitch: spec.data.length, data_bytes: spec.data.length },
                [blob("UpdateTexture", "data_offset", spec.data)]),
            wire("SetTexture", { device_handle: dev, texture_handle: dev + 0x500000 }), tss(dev, 0, 1, 2), tss(dev, 0, 2, 2), tss(dev, 0, 4, 2), tss(dev, 0, 5, 2)];
        const probesFor = (spec, p, rotate, fetch) => points.map(([cx, cy]) => {
            let expect = fetch ? footprint(spec.vals, cx, cy, p) : plainAt(spec, cx, cy, p);
            if (rotate) expect = [expect[1], expect[2], expect[3], expect[0]];
            return { at: [16 * cx + 4, 16 * cy + 4], expect, tolerance: 1 };
        });
        for (const spec of f4formats) for (const name of ["FFP", "texld", "texldp"]) {
            add("fetch4", { name: `Fetch4 ${name} on ${spec.name} gathers the 2x2 footprint`, body: dev => [
                ...texture4(dev, spec), ...samplerSetup(dev, GET4), ...bindProgram(dev, name), ...fetch4Quad(dev)],
                probes: probesFor(spec, programs[name].p, false, true) });
        }
        for (const name of Object.keys(programs)) if (name !== "FFP" && name !== "texld" && name !== "texldp") add("fetch4", { name: `Fetch4 ${name} on L8`, body: dev => [
            ...texture4(dev, f4formats[0]), ...samplerSetup(dev, GET4), ...bindProgram(dev, name), ...fetch4Quad(dev)],
            probes: probesFor(f4formats[0], programs[name].p, !!programs[name].rotate, true) });
        for (const spec of [f4formats[0], f4formats[1], f4formats[3]]) for (const name of ["FFP", "texld"]) add("fetch4", { name: `GET1 leaves ${spec.name} ${name} sampling normal`, body: dev => [
            ...texture4(dev, spec), ...samplerSetup(dev, GET1), ...bindProgram(dev, name), ...fetch4Quad(dev)],
            probes: probesFor(spec, 1, false, false) });
        for (const name of ["FFP", "texld"]) add("fetch4", { name: `Fetch4 leaves compressed ATI1N ${name} sampling normal`, body: dev => [
            ...texture4(dev, ati1n), ...samplerSetup(dev, GET4), ...bindProgram(dev, name), ...fetch4Quad(dev)],
            probes: probesFor(ati1n, 1, false, false) });
        const argb = flat.flatMap(v => [0x40, 255 - v, v, 255]);
        for (const name of ["FFP", "texld"]) add("fetch4", { name: `Fetch4 ignores multi-channel A8R8G8B8 ${name}`, body: dev => [
            ...texture4(dev, { format: 21, data: Uint8Array.from(argb), pitch: 16 }), ...samplerSetup(dev, GET4), ...bindProgram(dev, name), ...fetch4Quad(dev)],
            probes: points.map(([cx, cy]) => ({ at: [16 * cx + 4, 16 * cy + 4], expect: [rows[cy][cx], 255 - rows[cy][cx], 0x40, 255], tolerance: 1 })) });
        // Raw depth formats gather depth values the same way; compare-mode depth ignores the state.
        for (const format of [fourcc("DF16"), fourcc("DF24"), fourcc("INTZ")]) {
            const depthAt = x => .2 + .6 * (Math.min(63, x) + .5) / 64;
            add("fetch4", { name: `Fetch4 gathers raw depth format ${format.toString(16)}`, body: dev => {
                const depth = dev + 0x500000, tilted = fullXYZ(0, 0).map(v => [v[0], v[1], v[0] < 0 ? .2 : .8, 0]);
                return [wire("CreateTexture2D", { device_handle: dev, resource_handle: depth, width: 64, height: 64, level_count: 1, format, usage: 2 }),
                    wire("SetDepthStencilSurfaceLevel", { device_handle: dev, depth_texture_handle: depth, width: 64, height: 64 }), clearDepth(dev, 1),
                    rs(dev, 7, 1), rs(dev, 23, 8), rs(dev, 14, 1), rs(dev, 168, 0), ...drawXYZ(dev, tilted),
                    wire("SetDepthStencilSurfaceLevel", { device_handle: dev, depth_texture_handle: 0, width: 64, height: 64 }), rs(dev, 7, 0), rs(dev, 168, 15),
                    wire("SetTexture", { device_handle: dev, texture_handle: depth }), ...samplerSetup(dev, GET4), ...bindProgram(dev, "texld"), ...fetch4Quad(dev)];
            }, probes: [4, 20, 36, 52, 63].map(px => ({ at: [px, 32], expect: [depthAt(px + 1), depthAt(px), depthAt(px + 1), depthAt(px)].map(clamp), tolerance: 2 })) });
        }
    }

    // Wine shadow_test: a depth texture bound to the fixed-function pipeline is a hardware
    // shadow map. The result of `reference <= stored depth` fills all four channels.
    for (const format of [70, 71, 73, 75, 77, 79, 80]) for (const projected of [false, true]) {
        add("shadow-ffp", { name: `fixed-function shadow map format ${format}${projected ? " projected" : ""}`, body: dev => {
            const depth = dev + 0x500000, gradient = fullXYZ(0, 0).map(v => [v[0], v[1], v[0] < 0 ? 0 : 1, 0]);
            const vertices = new Uint8Array(6 * 28), view = new DataView(vertices.buffer), scale = projected ? 2 : 1;
            fullXYZ(.5, 0).forEach((v, i) => [v[0], v[1], v[2], (v[0] + 1) / 2 * scale, (v[1] + 1) / 2 * scale, (v[1] + 1) / 2 * scale, scale]
                .forEach((x, j) => view.setFloat32(i * 28 + j * 4, x, true)));
            return [wire("CreateTexture2D", { device_handle: dev, resource_handle: depth, width: 64, height: 64, level_count: 1, format, usage: 2 }),
                wire("SetDepthStencilSurfaceLevel", { device_handle: dev, depth_texture_handle: depth, width: 64, height: 64 }), clearDepth(dev, 0),
                rs(dev, 7, 1), rs(dev, 23, 8), rs(dev, 14, 1), rs(dev, 168, 0), ...drawXYZ(dev, gradient),
                wire("SetDepthStencilSurfaceLevel", { device_handle: dev, depth_texture_handle: 0, width: 64, height: 64 }), rs(dev, 7, 0), rs(dev, 168, 15),
                wire("SetTexture", { device_handle: dev, texture_handle: depth }), tss(dev, 0, 1, 2), tss(dev, 0, 2, 2), tss(dev, 0, 4, 2), tss(dev, 0, 5, 2),
                tss(dev, 0, 24, projected ? 0x100 : 0),
                ...[[1, 3], [2, 3], [5, 1], [6, 1], [7, 1]].map(([state, value]) => wire("SetSamplerState", { device_handle: dev, state, value })),
                cmd(P.OP.SET_FVF, cat([P.encode("SetFVF", { device_handle: dev, fvf: 0x20102, element_count: 2 }), element(0, 2, 0), element(12, 3, 5)])),
                wire("DrawPrimitiveUP", { device_handle: dev, primitive_type: 4, primitive_count: 2, stride: 28, vertex_count: 6, vertex_bytes: vertices.length },
                    [blob("DrawPrimitiveUP", "vertex_data_offset", vertices)])];
        }, probes: [[10, 6], [50, 6], [10, 30], [50, 30], [10, 58], [50, 58], [30, 6], [30, 58]].map(([px, py]) => {
            const s = (px + .5) / 64, p = 1 - (py + .5) / 64, lit = p <= s;
            return { at: [px, py], expect: lit ? [255, 255, 255, 255] : [0, 0, 0, 0] };
        }) });
    }
    // A swizzle on the sampler register of texld selects components of the fetched texel.
    for (const [name, swizzle, expected] of [["yzwx", 0x39, [20, 30, 40, 10]], ["wzyx", 0x1b, [40, 30, 20, 10]], ["xxxx", 0x00, [10, 10, 10, 10]], ["zzyw", 0xda, [30, 30, 20, 40]]])
        add("sampler-swizzle", { name: "texld sampler register swizzle ." + name, body: dev => [
            ...texture(dev, dev + 0x500000, ["A8R8G8B8", 21, [30, 20, 10, 40]]),
            pixelShader(dev, dev + 0x600000, [0xffff0300, ins(S.DCL, 2), 0x80000005, dst(R.INPUT, 0), ins(S.DCL, 2), 0x90000000, dst(R.SAMPLER, 0),
                ins(S.TEX, 3), dst(R.TEMP, 0), src(R.INPUT, 0), src(R.SAMPLER, 0, swizzle), ins(S.MOV, 2), dst(R.COLOROUT, 0), src(R.TEMP, 0), 0xffff]),
            bindPS(dev, dev + 0x600000), ...texturedQuad(dev)], probes: [{ at: [32, 32], expect: expected }] });

    // D3D's sphere map uses r.z - 1, with the camera-space normal left at its
    // declared length unless NORMALIZENORMALS is enabled. Compute vertices and
    // screen barycentrics independently from the generated shader.
    for (const normal of [[.8,0,.7],[.3,.6,.8],[-.6,.4,.5]]) for (const normalize of [false,true]) for (const shift of [0,.4]) {
        const xy=[[2,-2],[-2,-2],[0,2]],positions=xy.map(([x,y])=>[x+shift,y+shift,.1]);
        const norm=normalize?normal.map(v=>v/Math.hypot(...normal)):normal;
        const coords=positions.map(p=>{
            const incident=p.map(v=>v/Math.hypot(...p)),dot=incident.reduce((s,v,i)=>s+v*norm[i],0),reflected=incident.map((v,i)=>v-2*dot*norm[i]);
            const den=2*Math.hypot(reflected[0],reflected[1],reflected[2]-1);
            return [reflected[0]/den+.5,reflected[1]/den+.5,0,1];
        });
        const expected=(px,py)=>{
            const [a,b,c]=positions,p=[px/32-1,1-py/32],area=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
            const w0=((b[1]-c[1])*(p[0]-c[0])+(c[0]-b[0])*(p[1]-c[1]))/area,w1=((c[1]-a[1])*(p[0]-c[0])+(a[0]-c[0])*(p[1]-c[1]))/area;
            return [0,1,2].map(j=>clamp(coords[0][j]*w0+coords[1][j]*w1+coords[2][j]*(1-w0-w1))).concat(0);
        };
        add("sphere-map",{name:`sphere map N=${normal} normalize=${normalize} shift=${shift}`,
            body:dev=>{
                const data=new Uint8Array(72),dv=new DataView(data.buffer);
                xy.forEach(([x,y],i)=>[x,y,.1,...normal].forEach((v,j)=>dv.setFloat32(i*24+j*4,v,true)));
                return [rs(dev,7,0),rs(dev,143,normalize?1:0),wire("SetTransform",{device_handle:dev,state:256,matrix:[1,0,0,0,0,1,0,0,0,0,1,0,shift,shift,0,1]}),
                    tss(dev,0,11,0x40000),pixelShader(dev,dev+0x600000,[0xffff0101,S.TEXCOORD,dst(R.TEXTURE,0),S.MOV,dst(R.TEMP,0),src(R.TEXTURE,0),0xffff]),bindPS(dev,dev+0x600000),
                    cmd(P.OP.SET_FVF,cat([P.encode("SetFVF",{device_handle:dev,fvf:0x12,element_count:2}),element(0,2,0),element(12,2,3)])),
                    wire("DrawPrimitiveUP",{device_handle:dev,primitive_type:4,primitive_count:1,stride:24,vertex_count:3,vertex_bytes:72},[blob("DrawPrimitiveUP","vertex_data_offset",data)])];
            },probes:[[32,32],[24,36],[40,40]].map(at=>({at,expect:expected(...at),tolerance:1}))});
    }
    for (const format of [70,71,73,75,77,79,80]) for(const dynamic of [false,true]) add("sampled-depth-storage",{
        name:`depth format ${format} upload and comparison without attachment usage dynamic=${dynamic}`,body:dev=>{
            const depth=dev+0x500000,bpp=[70,73,80].includes(format)?2:4,pitch=64*bpp+8,data=new Uint8Array(pitch*64).fill(0xa5),v=new DataView(data.buffer);
            for(let y=0;y<64;y++)for(let x=0;x<64;x++){
                const d=x<32?.25:.75,at=y*pitch+x*bpp;
                if(format===73)v.setUint16(at,Math.round(d*32767)*2+1,true);
                else if(bpp===2)v.setUint16(at,Math.round(d*65535),true);
                else v.setUint32(at,format===71?Math.round(d*4294967295):(Math.round(d*16777215)*256+0xa5)>>>0,true);
            }
            const vertices=new Uint8Array(6*24),vv=new DataView(vertices.buffer);
            fullXYZ(.5,0).forEach((p,i)=>[...p.slice(0,3),(p[0]+1)/2,(1-p[1])/2,.5].forEach((n,j)=>vv.setFloat32(i*24+j*4,n,true)));
            return [wire("CreateTexture2D",{device_handle:dev,resource_handle:depth,width:64,height:64,level_count:1,format,usage:dynamic?0x200:0}),
                wire("UpdateTexture",{resource_handle:depth,width:64,height:64,depth:1,row_pitch:pitch,slice_pitch:data.length,data_bytes:data.length},[blob("UpdateTexture","data_offset",data)]),
                rs(dev,7,0),wire("SetTexture",{device_handle:dev,texture_handle:depth}),tss(dev,0,1,2),tss(dev,0,2,2),tss(dev,0,4,2),tss(dev,0,5,2),
                cmd(P.OP.SET_FVF,cat([P.encode("SetFVF",{device_handle:dev,fvf:0x10102,element_count:2}),element(0,2,0),element(12,2,5)])),
                wire("DrawPrimitiveUP",{device_handle:dev,primitive_type:4,primitive_count:2,stride:24,vertex_count:6,vertex_bytes:vertices.length},[blob("DrawPrimitiveUP","vertex_data_offset",vertices)])];
        },probes:[{at:[16,32],expect:[0,0,0,0]},{at:[48,32],expect:[255,255,255,255]}]});
    suite.FEATURE_GROUPS = groups;suite.FORMAT_CASES = formats;
})(typeof globalThis !== "undefined" ? globalThis : this);
