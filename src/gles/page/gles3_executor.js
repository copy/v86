// GLES 3.x's draws on the page (docs/gles3-plan.md L3): what a context of
// api 3 does on the GPU, as methods of the GLES executor (gles_executor.js
// installs them). Its programs are glslang's (the CPU side links them and
// sends the link, PROGRAM_LINK): each stage's SPIR-V becomes WGSL through
// vx_naga (vx/naga, the Venus executor's translator) with GL's clip space
// depth and the translator's Y flip, so the orientation is GLES 2.0's
// (framebuffer row 0 is GL's bottom row).
//
// - Buffers live on the GPU (a GPUBuffer each, made at first use) with
//   their bytes on the CPU side too (the shadow's `bytes`): the guest's
//   writes go to the bytes and reach the GPU buffer before a draw needs it
//   (`dirty`); a buffer the GPU wrote (`gpu_newer`, transform feedback,
//   copies) takes the guest's writes directly.
// - Vertex arrays in buffers are the draw's vertex buffers where WebGPU has
//   their format and alignment; the others (client arrays, packed and
//   three-component types, divisors past 1) are assembled on the CPU, the
//   indices then too (from the vertex range's first). Fans and loops become
//   lists; a fixed restart index ends a list's primitive or restarts a strip.
// - Textures have their sized format's WebGPU format (gles_formats3.js), all
//   levels of one GPU texture from the lowest level given; 3D and array
//   textures, sampler objects, base and max levels, depth comparison;
//   integer textures are fetched (vx_naga's intsample.rs, with the sampler's
//   wraps). An incomplete texture samples as (0, 0, 0, 1).
// - The draw framebuffer's draw buffers are the pass's color attachments (of
//   their own formats), multisampled renderbuffers 4 samples.

import { COMPRESSED_FORMATS, format_info } from "../gles_formats3.js";
import { GL3 } from "../gles3_state.js";
import { BINDING, gl_type } from "../glsl_program.js";
import { DRAWN_DEPTH, RENDERABLE, TEXEL_BYTES, from_half, to_texels, unpack_image } from "./gles3_pixels.js";
import { decode_etc1 } from "./gles_textures.js";
import { B, COLOR_FORMAT, COMPARE, STENCIL_OPS, U, WRAPS, align4, blend_component } from "./gles_gpu_tables.js";

const SCRIPT = typeof document !== "undefined" && document.currentScript ? document.currentScript.src : null;
/** vx_naga.wasm: next to the page's WebGPU bundle (tools/build_glbridge.mjs) */
const NAGA_URL = SCRIPT ? new URL("vx_naga.wasm", SCRIPT).href : "vx_naga.wasm";
/** vx_naga's translation flags (vx_executor.js's TRANSLATE): the fragment depth dropped, GL's clip space depth */
const NO_DEPTH = 2, GL_DEPTH = 8;
/** WGSL's bindings of SPIR-V's: 2b (2b + 1 a combined sampler's sampler), element e > 0 of an array ELEMENTS + 2 (16b + e) */
const ELEMENTS = 300, ELEMENTS_END = 960;

const NEAREST = 0x2600, LINEAR = 0x2601, NEAREST_MIPMAP_NEAREST = 0x2700;
const RESTART = 0x8D69, CULL_FACE = 0x0B44, BLEND = 0x0BE2, DEPTH_TEST = 0x0B71, STENCIL_TEST = 0x0B90, SCISSOR_TEST = 0x0C11;
const POLYGON_OFFSET_FILL = 0x8037;
const COMPARE_REF_TO_TEXTURE = 0x884E;
const TOPOLOGY = ["point-list", "line-list", "line-list", "line-strip", "triangle-list", "triangle-strip", "triangle-list"];
const INDEX_BYTES = { 0x1401: 1, 0x1403: 2, 0x1405: 4 };
const STRIP_END = 0xFFFFFFFF;

/** The texture slot (gles3_state.js's SLOT) of a sampler type, and each slot's target */
const SAMPLER_SLOT = new Map([[0x8B5E, 0], [0x8B62, 0], [0x8DCA, 0], [0x8DD2, 0], [0x8B60, 1], [0x8DC5, 1], [0x8DCC, 1], [0x8DD4, 1],
    [0x8D66, 2], [0x8B5F, 3], [0x8DCB, 3], [0x8DD3, 3], [0x8DC1, 4], [0x8DC4, 4], [0x8DCF, 4], [0x8DD7, 4]]);
const SLOT_TARGET = [GL3.TEXTURE_2D, GL3.TEXTURE_CUBE_MAP, GL3.TEXTURE_EXTERNAL_OES, GL3.TEXTURE_3D, GL3.TEXTURE_2D_ARRAY];
/** What a texture unit samples with nothing bound */
const NO_SAMPLER = { min_filter: NEAREST, mag_filter: NEAREST, wrap_s: 0x812F, wrap_t: 0x812F, wrap_r: 0x812F, compare_func: 0x0203 };
/** Vulkan's address modes (vx_naga's int_wraps): repeat 0, mirrored repeat 1, clamp to edge 2 */
const VK_WRAP = { 0x2901: 0, 0x8370: 1, 0x812F: 2 };

/** The renderbuffer formats that are no sized texture format */
const RENDERBUFFER_WEBGPU = { 0x8D48: "stencil8", 0x81A7: "depth32float" };

/** Vertex attribute types: their bytes */
const TYPE_BYTES = { 0x1400: 1, 0x1401: 1, 0x1402: 2, 0x1403: 2, 0x1404: 4, 0x1405: 4, 0x1406: 4, 0x140C: 4, 0x140B: 2, 0x8D61: 2, 0x8D9F: 4,
    0x8368: 4 };
const INT_2_10_10_10_REV = 0x8D9F, UNSIGNED_INT_2_10_10_10_REV = 0x8368;
const packed_attribute = type => type === INT_2_10_10_10_REV || type === UNSIGNED_INT_2_10_10_10_REV;
/** The vertex formats of CPU-assembled attributes, by the shader's input kind */
const CPU_FORMAT = { f: "float32", i: "sint32", u: "uint32" };

/** @return {?Uint8Array} a buffer's bytes on the page (GLES 3.0's `bytes`, GLES 2.0's `data`) */
const cpu_bytes = buffer => buffer.bytes || buffer.data || null;

/**
 * The WebGPU vertex format that reads an attribute's array as the shader's
 * input wants it, or null for one assembled on the CPU
 * @param {!Object} a the attribute's state
 * @param {string} kind the input's: "f", "i", "u"
 */
function direct_format(a, kind)
{
    const n = a.size, t = a.type;
    if(kind === "f")
    {
        if(a.integer) return null;
        if(t === 0x1406) return n === 1 ? "float32" : "float32x" + n;
        if(t === 0x140B || t === 0x8D61) return n === 2 || n === 4 ? "float16x" + n : null;
        if(!a.normalized) return null;
        const name = { 0x1401: "unorm8", 0x1400: "snorm8", 0x1403: "unorm16", 0x1402: "snorm16" }[t];
        return name && (n === 2 || n === 4) ? name + "x" + n : null;
    }
    if(!a.integer) return null;
    const signed = t === 0x1400 || t === 0x1402 || t === 0x1404;
    if(signed !== (kind === "i")) return null;
    const prefix = signed ? "sint" : "uint";
    if(t === 0x1404 || t === 0x1405) return n === 1 ? prefix + "32" : prefix + "32x" + n;
    return n === 2 || n === 4 ? prefix + (t === 0x1400 || t === 0x1401 ? "8x" : "16x") + n : null;
}

/** One component of a vertex array as GLES 3.0 reads it (2.9.1: normalized ones by equation 2.2) */
function read_component(view, p, type, normalized)
{
    switch(type)
    {
        case 0x1406: return view.getFloat32(p, true);
        case 0x140C: return view.getInt32(p, true) / 65536;
        case 0x140B: case 0x8D61: return from_half(view.getUint16(p, true));
        case 0x1401: return normalized ? view.getUint8(p) / 255 : view.getUint8(p);
        case 0x1400: return normalized ? Math.max(-1, view.getInt8(p) / 127) : view.getInt8(p);
        case 0x1403: return normalized ? view.getUint16(p, true) / 65535 : view.getUint16(p, true);
        case 0x1402: return normalized ? Math.max(-1, view.getInt16(p, true) / 32767) : view.getInt16(p, true);
        case 0x1405: return normalized ? view.getUint32(p, true) / 4294967295 : view.getUint32(p, true);
        case 0x1404: return normalized ? Math.max(-1, view.getInt32(p, true) / 2147483647) : view.getInt32(p, true);
    }
    return 0;
}

/** The four components of a packed 2_10_10_10 vertex */
function read_packed(view, p, type, normalized)
{
    const v = view.getUint32(p, true);
    const parts = [v & 1023, v >>> 10 & 1023, v >>> 20 & 1023, v >>> 30];
    if(type === UNSIGNED_INT_2_10_10_10_REV) return normalized ? parts.map((x, i) => x / (i === 3 ? 3 : 1023)) : parts;
    const signed = parts.map((x, i) => i === 3 ? (x >= 2 ? x - 4 : x) : x >= 512 ? x - 1024 : x);
    return normalized ? signed.map((x, i) => Math.max(-1, x / (i === 3 ? 1 : 511))) : signed;
}

/** A WGSL texture type's dimension and sample kind */
function texture_type(type)
{
    const m = /^texture_(depth_)?(multisampled_)?(1d|2d_array|2d|3d|cube_array|cube)(?:<(\w+)>)?/.exec(type || "");
    if(!m) return { dimension: "2d", sample: "float", multisampled: false };
    return { dimension: m[3].replace("_", "-"), multisampled: !!m[2], sample: m[1] ? "depth" : m[4] === "i32" ? "sint" : m[4] === "u32" ? "uint" : "float" };
}

/** The resource variables of naga's WGSL: binding to type */
function wgsl_declarations(wgsl)
{
    const declarations = new Map();
    for(const m of wgsl.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<[^>]*>)?\s+\w+\s*:\s*([^;]+);/g))
    {
        if(+m[1] === 0) declarations.set(+m[2], m[3].trim());
    }
    return declarations;
}

/** A fragment entry point's color outputs: location to WGSL type */
function fragment_outputs(wgsl)
{
    const outputs = new Map();
    const at = wgsl.indexOf("@fragment");
    const signature = at < 0 ? null : /->\s*([^{]+)\{/.exec(wgsl.slice(at));
    if(!signature) return outputs;
    const result = signature[1].trim();
    const single = /^@location\((\d+)\)\s*(?:@\w+(?:\([^)]*\))?\s*)*([\w<>]+)/.exec(result);
    if(single)
    {
        outputs.set(+single[1], single[2]);
        return outputs;
    }
    const body = new RegExp("struct\\s+" + result + "\\s*\\{([^}]*)\\}").exec(wgsl);
    for(const m of body ? body[1].matchAll(/@location\((\d+)\)\s*(?:@\w+(?:\([^)]*\))?\s*)*\w+\s*:\s*([\w<>]+)/g) : [])
    {
        outputs.set(+m[1], m[2]);
    }
    return outputs;
}

/** SPIR-V's binding and element of a WGSL binding (vx/naga's wgsl_binding, backwards) */
function spirv_binding(binding)
{
    if(binding >= ELEMENTS && binding < ELEMENTS_END) return { b: binding - ELEMENTS >> 5, e: binding - ELEMENTS >> 1 & 15 };
    return { b: binding >> 1, e: 0 };
}

/** A WebGPU format's kind for shader outputs and blending */
function format_kind(format)
{
    if(format.startsWith("depth") || format.startsWith("stencil")) return "depth";
    return format.includes("uint") ? "u" : format.includes("sint") ? "i" : "f";
}

/** @return {boolean} whether WebGPU blends into the format (no integer, no 32-bit float formats) */
const blendable = format => format_kind(format) === "f" && !format.includes("32float");

/**
 * A draw's indices as WebGPU draws them: fans as triangle lists, loops as
 * line lists, each piece between restart indices on its own (a strip's
 * restarted, a list's last primitive ended), from the lowest vertex
 * @param {!ArrayLike<number>} indices
 * @param {number} restart the restart index, -1 for none
 * @return {?{list: !Uint32Array, low: number, high: number, topology: string, strip: boolean}}
 */
function index_list(indices, mode, restart)
{
    let low = Infinity, high = -1;
    for(const v of indices) if(v !== restart) { if(v < low) low = v; if(v > high) high = v; }
    if(high < 0) return null;
    const strip = mode === 3 || mode === 5;
    const out = [];
    const piece = (from, to) =>
    {
        const n = to - from;
        const at = i => indices[from + i] - low;
        switch(mode)
        {
            case 0: case 1: case 4:
            {
                const per = mode === 0 ? 1 : mode === 1 ? 2 : 3;
                for(let i = 0; i < n - n % per; i++) out.push(at(i));
                break;
            }
            case 3: case 5:
                if(n < (mode === 3 ? 2 : 3)) break;
                if(out.length) out.push(STRIP_END);
                for(let i = 0; i < n; i++) out.push(at(i));
                break;
            case 2:
                if(n < 2) break;
                for(let i = 0; i < n; i++) out.push(at(i), at((i + 1) % n));
                break;
            case 6:
                for(let i = 1; i + 1 < n; i++) out.push(at(0), at(i), at(i + 1));
                break;
        }
    };
    let start = 0;
    for(let i = 0; i <= indices.length; i++)
    {
        if(i === indices.length || indices[i] === restart)
        {
            piece(start, i);
            start = i + 1;
        }
    }
    return { list: new Uint32Array(out), low, high, topology: TOPOLOGY[mode], strip };
}

export const GLES3 = {
    // ---- vx_naga

    /** vx_naga.wasm, fetched once (a batch with a program link waits for it) */
    async load_naga()
    {
        if(this.naga) return this.naga;
        this.naga_loading = this.naga_loading || (async () =>
        {
            const response = await fetch(this.naga_url || globalThis["V86VenusNagaUrl"] || NAGA_URL);
            if(!response.ok) throw new Error("vx_naga.wasm: " + response.status);
            const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
            this.naga = instance.exports;
        })();
        await this.naga_loading;
        return this.naga;
    },

    /** SPIR-V words as vx_naga's answer: {wgsl, entries, intsamples} or {error} */
    translate_spirv(words, flags, wraps)
    {
        const naga = this.naga;
        const bytes = new Uint8Array(words.buffer, words.byteOffset, words.byteLength);
        const input = naga.vx_alloc(bytes.length);
        new Uint8Array(naga.memory.buffer, input, bytes.length).set(bytes);
        const list = wraps.length ? naga.vx_alloc(wraps.length * 8) : 0;
        if(list) new Uint32Array(naga.memory.buffer, list, wraps.length * 2).set(wraps.flat());
        let out;
        try
        {
            out = naga.vx_translate(input, bytes.length, 1, 0, flags, 0, 0, list, wraps.length);
        }
        finally
        {
            naga.vx_free(input, bytes.length);
            if(list) naga.vx_free(list, wraps.length * 8);
        }
        const length = new DataView(naga.memory.buffer).getUint32(out, true);
        const json = new TextDecoder().decode(new Uint8Array(naga.memory.buffer, out + 4, length));
        naga.vx_free(out, length + 4);
        return JSON.parse(json);
    },

    /** A note of what a draw could not do (the stats' `gles3`: each kind counted) */
    note3(what)
    {
        const notes = this.stats.gles3 = this.stats.gles3 || {};
        notes[what] = (notes[what] || 0) + 1;
        return null;
    },

    /** The program's GPU side (its `gpu`, which snapshots leave out): made again after each link */
    program_gpu(program)
    {
        if(!program.gpu || program.gpu.info !== program.info)
        {
            program.gpu = { info: program.info, translations: new Map(), shaders: new Map(), inputs: null, uniforms: null };
        }
        return program.gpu;
    },

    translation3(program, index, flags, wraps)
    {
        const gpu = this.program_gpu(program);
        const key = index + ":" + flags + ":" + wraps.flat().join(",");
        let t = gpu.translations.get(key);
        if(!t)
        {
            t = this.translate_spirv(program.info.spirv[index].words, flags, wraps);
            gpu.translations.set(key, t);
        }
        return t;
    },

    /**
     * A program's shader modules for a draw: its fragment depth output kept
     * only with a depth attachment, its integer textures' fetches by their
     * samplers' wraps
     * @return {?{vertex: !Object, fragment: !Object, bindings: !Array<!Object>, outputs: !Map<number, string>, id: string}}
     */
    program3(c, program, target)
    {
        if(!this.naga) return this.note3("vx_naga not loaded");
        const spirv = program.info.spirv;
        const v = spirv.findIndex(m => m.stage === "vertex"), f = spirv.findIndex(m => m.stage === "fragment");
        if(v < 0 || f < 0) return this.note3("a program without a vertex or fragment shader");
        const fragment_flags = target.depth ? 0 : NO_DEPTH;
        let ts = [this.translation3(program, v, GL_DEPTH, []), this.translation3(program, f, fragment_flags, [])];
        const failed = ts.find(t => t.error);
        if(failed) return this.note3("vx_naga: " + failed.error.slice(0, 160));
        const fetched = [...new Set([...ts[0].intsamples || [], ...ts[1].intsamples || []])];
        const wraps = fetched.length ? this.int_wraps3(c, program, fetched) : [];
        const gpu = this.program_gpu(program);
        const key = fragment_flags + ":" + wraps.flat().join(",");
        let shaders = gpu.shaders.get(key);
        if(shaders) return shaders;
        if(wraps.length) ts = [this.translation3(program, v, GL_DEPTH, wraps), this.translation3(program, f, fragment_flags, wraps)];
        if(ts.some(t => t.error)) return this.note3("vx_naga: " + ts.find(t => t.error).error.slice(0, 160));
        const module = code =>
        {
            let m = this.shaders.get(code);
            if(!m) this.shaders.set(code, m = this.device.createShaderModule({ label: "GLES 3 program", code }));
            return m;
        };
        // the bindings both stages use, with their WGSL types and which stages see them
        const bindings = new Map();
        ts.forEach((t, stage) =>
        {
            const declarations = wgsl_declarations(t.wgsl);
            for(const [group, binding, kind, size] of t.entries[0].bindings)
            {
                if(group !== 0) continue;
                const b = bindings.get(binding) || { binding, kind, size: 0, visibility: 0, type: declarations.get(binding) };
                b.size = Math.max(b.size, size);
                b.visibility |= stage === 0 ? 1 : 2;
                bindings.set(binding, b);
            }
        });
        shaders = {
            vertex: { module: module(ts[0].wgsl), entry: ts[0].entries[0].name },
            fragment: { module: module(ts[1].wgsl), entry: ts[1].entries[0].name },
            bindings: [...bindings.values()].sort((a, b) => a.binding - b.binding),
            outputs: fragment_outputs(ts[1].wgsl),
        };
        shaders.id = this.id_of(shaders.vertex.module) + ":" + this.id_of(shaders.fragment.module);
        gpu.shaders.set(key, shaders);
        return shaders;
    },

    /** The vertex shader's inputs: location, kind ("f", "i", "u") and components, matrices by column */
    inputs3(program)
    {
        const gpu = this.program_gpu(program);
        if(gpu.inputs) return gpu.inputs;
        const inputs = [];
        for(const a of program.info.attributes)
        {
            if(a.location < 0) continue;
            const t = gl_type(a.type);
            const kind = t.base === "int" ? "i" : t.base === "uint" ? "u" : "f";
            const columns = t.columns || 1, components = t.columns ? t.rows : t.components;
            for(let e = 0; e < a.size; e++)
            {
                for(let k = 0; k < columns; k++) inputs.push({ location: a.location + e * columns + k, kind, components });
            }
        }
        return gpu.inputs = inputs;
    },

    // ---- buffers

    /** A GL buffer's GPU buffer, the CPU side's changes copied in first */
    gpu_buffer(buffer)
    {
        const size = Math.max(16, Math.ceil(buffer.size / 16) * 16);
        let gpu = buffer.gpu;
        if(!gpu || gpu.size < size)
        {
            const created = this.device.createBuffer({ label: "GL buffer", size,
                usage: B.VERTEX | B.INDEX | B.UNIFORM | B.STORAGE | B.COPY_SRC | B.COPY_DST | B.INDIRECT });
            if(gpu)
            {
                if(buffer.gpu_newer)
                {
                    this.end_pass();
                    this.encoder.copyBufferToBuffer(gpu.buffer, 0, created, 0, gpu.size);
                }
                this.staging.push(gpu.buffer);
            }
            buffer.gpu = gpu = { buffer: created, size, destroy: () => created.destroy() };
            if(!buffer.gpu_newer) buffer.dirty = [0, buffer.size];
        }
        if(buffer.dirty)
        {
            const [low, high] = buffer.dirty;
            buffer.dirty = null;
            const bytes = cpu_bytes(buffer);
            if(bytes && high > low) this.write_gpu_buffer(gpu.buffer, low, high - low, bytes, low);
        }
        return gpu;
    },

    /**
     * Bytes into a GPU buffer, in order with the draws (a staging buffer
     * copied in the encoder); the range widened to whole words from `source`
     * @param {!Uint8Array} source holds the bytes, `at` the first's index
     */
    write_gpu_buffer(target, offset, length, source, at)
    {
        const low = offset & ~3, high = align4(offset + length);
        if(at - (offset - low) < 0 || at + length + (high - offset - length) > source.length) return this.note3("an unaligned buffer write");
        this.end_pass();
        const staging = this.device.createBuffer({ label: "GLES buffer upload", size: Math.max(4, high - low), usage: B.COPY_SRC, mappedAtCreation: true });
        new Uint8Array(staging.getMappedRange()).set(source.subarray(at - (offset - low), at - (offset - low) + high - low));
        staging.unmap();
        this.encoder.copyBufferToBuffer(staging, 0, target, low, high - low);
        this.staging.push(staging);
        return undefined;
    },

    /**
     * The guest wrote `length` bytes of a buffer at `offset` (`data`: them):
     * the CPU side's copy has them, the GPU buffer gets them before its next
     * use, or now if the GPU's copy is the newer one
     */
    buffer_written(buffer, offset, length, data)
    {
        if(!buffer || length <= 0) return;
        if(buffer.gpu_newer)
        {
            const gpu = this.gpu_buffer(buffer);
            if(data) this.write_gpu_buffer(gpu.buffer, offset, length, data, 0);
            return;
        }
        if(!buffer.gpu) return;
        buffer.dirty = buffer.dirty ? [Math.min(buffer.dirty[0], offset), Math.max(buffer.dirty[1], offset + length)] : [offset, offset + length];
    },

    /** The buffer bound to a target (GLES 3.0's targets) */
    buffer_of3(c, target)
    {
        const which = { 0x8892: "array", 0x8893: "element", 0x8F36: "copy_read", 0x8F37: "copy_write", 0x88EB: "pixel_pack", 0x88EC: "pixel_unpack",
            0x8C8E: "transform_feedback", 0x8A11: "uniform" }[target];
        const name = which === "array" ? c.array_buffer : which === "element" ? c.element_array_buffer : which ? c.buffers[which] : 0;
        return name ? c.group.buffers.get(name) || null : null;
    },

    /** A zero buffer of at least `size` bytes (what an unbound uniform block reads) */
    zeros3(size)
    {
        size = Math.max(256, Math.ceil(size / 256) * 256);
        if(!this.zero_buffer || this.zero_buffer.size < size)
        {
            if(this.zero_buffer) this.staging.push(this.zero_buffer);
            this.zero_buffer = this.device.createBuffer({ label: "GLES zeros", size, usage: B.UNIFORM | B.STORAGE | B.VERTEX });
        }
        return this.zero_buffer;
    },

    // ---- textures

    /**
     * A texture's GPU texture: its format's, as large as the lowest level
     * given (GPU level 0 is that GL level, `first`) with a full chain (an
     * immutable texture's levels); made again when those change, the levels
     * that still fit copied over
     */
    gpu_texture3(texture)
    {
        const cube = texture.target === GL3.TEXTURE_CUBE_MAP, three = texture.target === GL3.TEXTURE_3D;
        const array = texture.target === GL3.TEXTURE_2D_ARRAY;
        let first = -1, base = null;
        for(let level = 0; level < 32 && !base; level++)
        {
            for(let face = 0; face < (cube ? 6 : 1) && !base; face++)
            {
                const image = texture.images.get(face * 32 + level);
                if(image && image.width && image.height) { first = level; base = image; }
            }
        }
        if(!base) return null;
        const internal = base.internal || base.format;
        const compressed = COMPRESSED_FORMATS.get(internal);
        const info = format_info(internal);
        const native = compressed && this.device.features && this.device.features.has("texture-compression-etc2");
        const format = compressed ? (native ? compressed.webgpu : COLOR_FORMAT) : info ? info.webgpu : COLOR_FORMAT;
        const width = base.width, height = base.height;
        const depth = three || array ? Math.max(1, base.depth || 1) : cube ? 6 : 1;
        const largest = Math.max(width, height, three ? depth : 1);
        const levels = texture.immutable ? Math.max(1, texture.immutable_levels - first) : Math.floor(Math.log2(largest)) + 1;
        const old = texture.gpu;
        if(old && old.es3 && old.format === format && old.width === width && old.height === height && old.depth === depth && old.first === first &&
            old.levels >= levels)
        {
            return old;
        }
        const usage = U.TEXTURE_BINDING | U.COPY_DST | U.COPY_SRC | (RENDERABLE.has(format) ? U.RENDER_ATTACHMENT : 0);
        const created = this.device.createTexture({ label: "GL texture", size: [width, height, depth], dimension: three ? "3d" : "2d", format,
            mipLevelCount: levels, usage });
        const gpu = { es3: true, texture: created, format, width, height, depth, first, levels, three, cube, array, views: new Map(),
            block: native ? 4 : 1, block_bytes: native ? compressed.block_bytes : 0, destroy: () => created.destroy() };
        if(old && old.texture)
        {
            // (the levels that keep their size: a level given below the others, a chain made longer)
            if(old.es3 && old.format === format && !DRAWN_DEPTH.has(format) && format !== "stencil8")
            {
                this.end_pass();
                for(let mip = 0; mip < old.levels; mip++)
                {
                    const to = mip + old.first - first;
                    const w = Math.max(1, old.width >> mip), h = Math.max(1, old.height >> mip);
                    if(to < 0 || to >= levels || Math.max(1, width >> to) !== w || Math.max(1, height >> to) !== h) continue;
                    const d = old.three ? Math.max(1, old.depth >> mip) : old.depth;
                    if(d !== (three ? Math.max(1, depth >> to) : depth)) continue;
                    if(gpu.block > 1 && (w % 4 || h % 4)) continue;
                    this.encoder.copyTextureToTexture({ texture: old.texture, mipLevel: mip }, { texture: created, mipLevel: to }, [w, h, d]);
                }
            }
            this.staging.push(old.texture);
        }
        texture.gpu = gpu;
        return gpu;
    },

    /**
     * Texels into a level of a GPU texture, in order with the draws:
     * `origin` and `size` in texels (x, y, and the layer, face or slice)
     * @return {boolean} whether the level is there to write
     */
    upload3(gpu, level, origin, size, texels)
    {
        const mip = level - gpu.first;
        if(mip < 0 || mip >= gpu.levels) return false;
        const mip_width = Math.max(1, gpu.width >> mip), mip_height = Math.max(1, gpu.height >> mip);
        const mip_depth = gpu.three ? Math.max(1, gpu.depth >> mip) : gpu.depth;
        const [x, y, z] = origin, [w, h, d] = size;
        if(x + w > mip_width || y + h > mip_height || z + d > mip_depth || !w || !h || !d) return false;
        const block = gpu.block;
        const texel = block > 1 ? gpu.block_bytes : TEXEL_BYTES[gpu.format];
        const columns = Math.ceil(w / block), rows = Math.ceil(h / block);
        const row = columns * texel, stride = Math.ceil(row / 256) * 256;
        this.end_pass();
        const staging = this.device.createBuffer({ label: "GLES upload", size: Math.max(4, stride * rows * d), usage: B.COPY_SRC, mappedAtCreation: true });
        const mapped = new Uint8Array(staging.getMappedRange());
        for(let k = 0; k < rows * d; k++)
        {
            const from = k * row;
            if(from >= texels.length) break;
            mapped.set(texels.subarray(from, Math.min(texels.length, from + row)), k * stride);
        }
        staging.unmap();
        this.encoder.copyBufferToTexture({ buffer: staging, bytesPerRow: stride, rowsPerImage: rows },
            { texture: gpu.texture, mipLevel: mip, origin: [x, y, z] }, [columns * block, rows * block, d]);
        this.staging.push(staging);
        this.stats.uploads++;
        return true;
    },

    /** The texture bound to a target of the active unit, the face of a cube face's target */
    bound3(c, target)
    {
        const face = target >= 0x8515 && target <= 0x851A ? target - 0x8515 : 0;
        const slot_target = face || target === 0x8515 ? GL3.TEXTURE_CUBE_MAP : target;
        const slot = SLOT_TARGET.indexOf(slot_target);
        if(slot < 0) return { texture: null, face };
        const name = c.textures[c.active_texture][slot];
        return { texture: name ? c.group.textures.get(name) : c.defaults && c.defaults.get(slot_target), face };
    },

    /** glTexImage2D/3D, glTexSubImage2D/3D and their Offset forms (the data from the pixel unpack buffer) */
    tex_image3(c, name, args)
    {
        const three = name.includes("3D"), sub = name.includes("Sub");
        let target, level, x = 0, y = 0, z = 0, width, height, depth = 1, format, type, data;
        if(sub && three) [target, level, x, y, z, width, height, depth, format, type, data] = args;
        else if(sub) [target, level, x, y, width, height, format, type, data] = args;
        else if(three) [target, level, , width, height, depth, , format, type, data] = args;
        else [target, level, , width, height, , format, type, data] = args;
        const { texture, face } = this.bound3(c, target);
        if(!texture || !width || !height || !depth) return;
        const image = texture.images.get((three ? 0 : face) * 32 + level);
        if(!image) return;
        const base = texture.images.get(0);
        if(!three && base && (base.image || base.color_buffer))
        {
            // (an EGL image's: the writes go to its color buffer, GLES 2.0's way)
            if(typeof data !== "number") this.tex_image(c, args, sub);
            return;
        }
        const gpu = this.gpu_texture3(texture);
        if(!gpu) return;
        if(typeof data === "number")
        {
            const pbo = c.group.buffers.get(c.buffers.pixel_unpack);
            if(!pbo || pbo.gpu_newer) return void this.note3("an unpack buffer the GPU wrote");
            data = cpu_bytes(pbo) && cpu_bytes(pbo).subarray(data);
        }
        if(!data) return;
        const info = format_info(image.internal || image.format);
        if(!info) return;
        const store = { alignment: c.unpack_alignment, row_length: c.unpack.row_length, image_height: c.unpack.image_height,
            skip_pixels: c.unpack.skip_pixels, skip_rows: c.unpack.skip_rows, skip_images: c.unpack.skip_images };
        const tight = unpack_image(data, width, height, depth, format, type, store, three);
        const texels = to_texels(tight, width * height * depth, format, type, info);
        if(!texels) return void this.note3("depth images with data (drawn): not yet");
        if(!this.upload3(gpu, level, [x, y, three ? z : face], [width, height, depth], texels)) this.note3("an image of a level the texture lacks");
    },

    /** glCompressedTexImage2D/3D, glCompressedTexSubImage2D/3D (and Offset forms) */
    compressed_image3(c, name, args)
    {
        const three = name.includes("3D"), sub = name.includes("Sub");
        let target, level, x = 0, y = 0, z = 0, width, height, depth = 1, data;
        if(sub && three) [target, level, x, y, z, width, height, depth, , , data] = args;
        else if(sub) [target, level, x, y, width, height, , , data] = args;
        else if(three) [target, level, , width, height, depth, , , data] = args;
        else [target, level, , width, height, , , data] = args;
        const { texture, face } = this.bound3(c, target);
        const gpu = texture && this.gpu_texture3(texture);
        if(!gpu) return;
        if(typeof data === "number")
        {
            const pbo = c.group.buffers.get(c.buffers.pixel_unpack);
            data = pbo && !pbo.gpu_newer && cpu_bytes(pbo) ? cpu_bytes(pbo).subarray(data) : null;
        }
        if(!data) return;
        const image = texture.images.get((three ? 0 : face) * 32 + level);
        const internal = image ? image.internal : 0;
        const layer = three ? z : face;
        if(gpu.block > 1)
        {
            this.upload3(gpu, level, [x, y, layer], [width, height, depth], data);
            return;
        }
        // (without WebGPU's ETC2: ETC1's blocks decoded; the others' not yet)
        if(internal !== 0x8D64 && internal !== 0x9274) return void this.note3("ETC2/EAC without texture-compression-etc2: not yet");
        const blocks = Math.ceil(width / 4) * Math.ceil(height / 4) * 8;
        for(let k = 0; k < depth; k++)
        {
            this.upload3(gpu, level, [x, y, layer + k], [width, height, 1], decode_etc1(width, height, data.subarray(k * blocks, (k + 1) * blocks)));
        }
    },

    /** glCopyTexImage2D, glCopyTexSubImage2D/3D: from the read framebuffer's read buffer, of the same format */
    copy_tex_image3(c, name, args)
    {
        let target, level, xoffset = 0, yoffset = 0, zoffset = 0, x, y, width, height;
        if(name === "glCopyTexImage2D") [target, level, , x, y, width, height] = args;
        else if(name === "glCopyTexSubImage2D") [target, level, xoffset, yoffset, x, y, width, height] = args;
        else [target, level, xoffset, yoffset, zoffset, x, y, width, height] = args;
        const { texture, face } = this.bound3(c, target);
        const gpu = texture && this.gpu_texture3(texture);
        const source = this.read_target3(c);
        if(!gpu || !source || source.texture === gpu.texture) return;
        const mip = level - gpu.first;
        if(mip < 0 || mip >= gpu.levels) return;
        if(source.format.replace("-srgb", "") !== gpu.format.replace("-srgb", "") || source.samples > 1) return void this.note3("a copy into a texture of another format: not yet");
        const sx = Math.max(0, x), sy = Math.max(0, y);
        const w = Math.min(width - (sx - x), source.width - sx), h = Math.min(height - (sy - y), source.height - sy);
        if(w <= 0 || h <= 0) return;
        this.end_pass();
        this.encoder.copyTextureToTexture({ texture: source.texture, mipLevel: source.mip, origin: [sx, sy, source.layer] },
            { texture: gpu.texture, mipLevel: mip, origin: [xoffset + sx - x, yoffset + sy - y, gpu.three || gpu.array ? zoffset : face] }, [w, h, 1]);
    },

    /** glGenerateMipmap: each level drawn from the one before (2D, cube and array textures) */
    generate_mipmap3(c, target)
    {
        const { texture } = this.bound3(c, target);
        const gpu = texture && this.gpu_texture3(texture);
        if(!gpu) return;
        if(gpu.three) return void this.note3("glGenerateMipmap of 3D textures: not yet");
        if(!RENDERABLE.has(gpu.format) || format_kind(gpu.format) !== "f" || gpu.format.includes("32float")) return void this.note3("glGenerateMipmap of that format");
        const base = Math.max(0, (texture.base_level || 0) - gpu.first);
        for(let layer = 0; layer < gpu.depth; layer++)
        {
            for(let mip = base + 1; mip < gpu.levels; mip++)
            {
                const view = m => gpu.texture.createView({ dimension: "2d", baseMipLevel: m, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
                this.blit3(view(mip - 1), view(mip), gpu.format);
            }
        }
    },

    /** A full-size draw of one view into another of the format (filtered linearly) */
    blit3(source, target, format)
    {
        this.blits3 = this.blits3 || new Map();
        let blit = this.blits3.get(format);
        if(!blit)
        {
            const module = this.device.createShaderModule({ code: `
                struct VOut { @builtin(position) p : vec4<f32>, @location(0) uv : vec2<f32> };
                @group(0) @binding(0) var t : texture_2d<f32>;
                @group(0) @binding(1) var s : sampler;
                @vertex fn vs(@builtin(vertex_index) i : u32) -> VOut {
                    let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
                    var o : VOut;
                    o.p = vec4<f32>(p[i], 0.0, 1.0);
                    o.uv = vec2<f32>(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
                    return o;
                }
                @fragment fn fs(i : VOut) -> @location(0) vec4<f32> { return textureSampleLevel(t, s, i.uv, 0.0); }` });
            blit = { pipeline: this.device.createRenderPipeline({ label: "GLES 3 blit", layout: "auto", vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-list" } }),
            sampler: this.device.createSampler({ magFilter: "linear", minFilter: "linear" }) };
            this.blits3.set(format, blit);
        }
        this.end_pass();
        const pass = this.encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
        pass.setPipeline(blit.pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: blit.pipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: source }, { binding: 1, resource: blit.sampler }] }));
        pass.draw(3);
        pass.end();
    },

    /** glRenderbufferStorage(Multisample): a texture of the format (4 samples for any multisampled one) */
    renderbuffer_storage3(c)
    {
        const rb = c.group.renderbuffers.get(c.renderbuffer);
        if(!rb) return;
        if(rb.gpu) this.staging.push(rb.gpu);
        rb.gpu = null;
        if(!rb.width || !rb.height || rb.image) return;
        const info = format_info(rb.format);
        const format = info ? info.webgpu : RENDERBUFFER_WEBGPU[rb.format] || COLOR_FORMAT;
        if(!RENDERABLE.has(format)) return void this.note3("a renderbuffer of a format WebGPU draws no " + format);
        const samples = rb.samples > 1 ? 4 : 1;
        const texture = this.device.createTexture({ label: "GL renderbuffer", size: [rb.width, rb.height], format, sampleCount: samples,
            usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | (samples === 1 ? U.COPY_SRC | U.COPY_DST : 0) });
        rb.gpu = { texture, format, samples, view: texture.createView(), destroy: () => texture.destroy() };
    },

    // ---- what is drawn to and read from

    /** An attachment as a pass's: texture, view, format, level and layer, size, samples */
    attachment3(c, a)
    {
        if(!a) return null;
        const color_buffer = t => t && { texture: t.texture, view: t.texture.createView(), format: COLOR_FORMAT, mip: 0, layer: 0, samples: 1,
            width: t.texture.width, height: t.texture.height };
        if(a.type === GL3.RENDERBUFFER)
        {
            const rb = c.group.renderbuffers.get(a.name);
            if(rb && rb.image) return color_buffer(this.image_texture(rb.image));
            if(!rb || !rb.gpu) return null;
            return { texture: rb.gpu.texture, view: rb.gpu.view, format: rb.gpu.format, mip: 0, layer: 0, samples: rb.gpu.samples, width: rb.width,
                height: rb.height };
        }
        const texture = c.group.textures.get(a.name);
        const image = texture && texture.images.get(a.face * 32 + a.level);
        if(image && image.image) return color_buffer(this.image_texture(image.image));
        if(image && image.color_buffer) return color_buffer(this.color_buffer_texture(image.color_buffer));
        const gpu = texture && this.gpu_texture3(texture);
        if(!gpu || !RENDERABLE.has(gpu.format)) return null;
        const mip = a.level - gpu.first;
        if(mip < 0 || mip >= gpu.levels) return null;
        const layer = gpu.cube ? a.face : gpu.three || gpu.array ? a.layer || 0 : 0;
        const key = "attachment" + mip + ":" + (gpu.three ? 0 : layer);
        let view = gpu.views.get(key);
        if(!view)
        {
            view = gpu.three ? gpu.texture.createView({ dimension: "3d", baseMipLevel: mip, mipLevelCount: 1 }) :
                gpu.texture.createView({ dimension: "2d", baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
            gpu.views.set(key, view);
        }
        return { texture: gpu.texture, view, format: gpu.format, mip, layer, depth_slice: gpu.three ? layer : undefined, samples: 1,
            width: Math.max(1, gpu.width >> mip), height: Math.max(1, gpu.height >> mip) };
    },

    /**
     * The draw framebuffer as a pass's attachments: a color attachment each
     * draw buffer (null for none), the depth-stencil one; null when there is
     * nothing to draw to or WebGPU cannot (sizes or samples differ)
     */
    target3(c)
    {
        if(!c.framebuffer)
        {
            const t = this.surface_target(c);
            if(!t) return null;
            const color = c.default_draw_buffer === GL3.NONE ? null :
                { texture: t.color, view: t.color_view, format: COLOR_FORMAT, mip: 0, layer: 0, samples: 1, width: t.width, height: t.height };
            return { colors: color ? [color] : [], depth: t.depth ? { view: t.depth, format: t.depth_format, texture: null } : null, width: t.width,
                height: t.height, samples: 1, alpha: t.alpha, key: t.key + (color ? "" : "n"), textures: new Set([t.color]) };
        }
        const fbo = c.framebuffers.get(c.framebuffer);
        if(!fbo) return null;
        const colors = (fbo.draw_buffers || [GL3.COLOR_ATTACHMENT0]).map(b => b === GL3.NONE ? null : this.attachment3(c, fbo.attachments.get(b)));
        while(colors.length && !colors[colors.length - 1]) colors.pop();
        const depth = this.attachment3(c, fbo.attachments.get(GL3.DEPTH_ATTACHMENT)) || this.attachment3(c, fbo.attachments.get(GL3.STENCIL_ATTACHMENT));
        const all = [...colors.filter(Boolean), ...depth ? [depth] : []];
        if(!all.length) return null;
        const { width, height, samples } = all[0];
        if(all.some(a => a.width !== width || a.height !== height)) return this.note3("attachments of different sizes");
        if(all.some(a => a.samples !== samples)) return this.note3("attachments of different samples");
        const key = "3:" + colors.map(a => a ? this.id_of(a.texture) + "." + a.mip + "." + a.layer : "-").join(",") + "/" +
            (depth ? this.id_of(depth.texture) + "." + depth.mip + "." + depth.layer : "-");
        return { colors, depth, width, height, samples, alpha: true, key, textures: new Set(all.map(a => a.texture)) };
    },

    /** What glReadPixels and the copies read: the read framebuffer's read buffer, or null */
    read_target3(c)
    {
        if(!c.read_framebuffer)
        {
            if(c.default_read_buffer === GL3.NONE) return null;
            const t = this.surface_target(c);
            return t && t.color ? { texture: t.color, format: COLOR_FORMAT, mip: 0, layer: 0, samples: 1, width: t.width, height: t.height } : null;
        }
        const fbo = c.framebuffers.get(c.read_framebuffer);
        if(!fbo || fbo.read_buffer === GL3.NONE) return null;
        return this.attachment3(c, fbo.attachments.get(fbo.read_buffer));
    },

    /** The render pass on a target (the open one if it is the same); `clear`: {colors (values by draw buffer), depth, stencil} */
    begin_pass3(target, clear)
    {
        if(this.pass && this.pass_target === target.key && !clear) return this.pass;
        this.end_pass();
        const colors = target.colors.map((a, i) =>
        {
            if(!a) return null;
            const value = clear && clear.colors && clear.colors[i];
            return Object.assign({ view: a.view, storeOp: "store", loadOp: value ? "clear" : "load" },
                value ? { clearValue: { r: value[0], g: value[1], b: value[2], a: value[3] } } : {},
                a.depth_slice !== undefined ? { depthSlice: a.depth_slice } : {});
        });
        const descriptor = { label: "GLES 3 pass", colorAttachments: colors };
        if(target.depth)
        {
            const format = target.depth.format;
            const has_depth = format !== "stencil8", has_stencil = format.includes("stencil");
            descriptor.depthStencilAttachment = Object.assign({ view: target.depth.view },
                has_depth ? { depthLoadOp: clear && clear.depth !== undefined ? "clear" : "load", depthStoreOp: "store",
                    depthClearValue: clear && clear.depth !== undefined ? clear.depth : 1 } : {},
                has_stencil ? { stencilLoadOp: clear && clear.stencil !== undefined ? "clear" : "load", stencilStoreOp: "store",
                    stencilClearValue: clear && clear.stencil !== undefined ? clear.stencil : 0 } : {});
        }
        this.pass = this.encoder.beginRenderPass(descriptor);
        this.pass_target = target.key;
        return this.pass;
    },

    // ---- clears

    /** glClear: every draw buffer, the depth and stencil buffers */
    clear3(c, mask)
    {
        const target = this.target3(c);
        if(!target) return;
        const color = c.clear_color.slice();
        this.clear_target3(c, target, { colors: mask & 0x4000 ? target.colors.map(a => a ? color : null) : [],
            depth: mask & 0x0100 ? c.clear_depth : undefined, stencil: mask & 0x0400 ? c.clear_stencil : undefined });
    },

    /** glClearBuffer{iv,uiv,fv,fi} */
    clear_buffer3(c, name, args)
    {
        const target = this.target3(c);
        if(!target) return;
        const [buffer, drawbuffer, value] = args;
        const bytes = value instanceof Uint8Array ? value.slice() : null;
        const words = bytes ? bytes.buffer : null;
        if(buffer === 0x1800)
        {
            if(!words || words.byteLength < 16 || !target.colors[drawbuffer]) return;
            const values = Array.from(name === "glClearBufferfv" ? new Float32Array(words, 0, 4) : name === "glClearBufferuiv" ? new Uint32Array(words, 0, 4) :
                new Int32Array(words, 0, 4));
            const colors = [];
            colors[drawbuffer] = values;
            this.clear_target3(c, target, { colors, typed: true });
        }
        else if(buffer === 0x1801 && words) this.clear_target3(c, target, { colors: [], depth: new Float32Array(words, 0, 1)[0] });
        else if(buffer === 0x1802 && words) this.clear_target3(c, target, { colors: [], stencil: new Int32Array(words, 0, 1)[0] });
        else if(buffer === 0x84F9) this.clear_target3(c, target, { colors: [], depth: args[2], stencil: args[3] });
    },

    /**
     * Clear what `want` says (colors by draw buffer, depth, stencil) by the
     * masks and the scissor: the pass's clears when nothing limits them,
     * else a quad
     */
    clear_target3(c, target, want)
    {
        const has = format => target.depth && (format === "depth" ? target.depth.format !== "stencil8" : target.depth.format.includes("stencil"));
        const depth = want.depth !== undefined && c.depth_mask && has("depth") ? Math.min(1, Math.max(0, want.depth)) : undefined;
        const stencil = want.stencil !== undefined && has("stencil") ? want.stencil & 0xFF : undefined;
        const colors = want.colors.map((v, i) => v && target.colors[i] ? (target.alpha ? v : [v[0], v[1], v[2], 1]) : null);
        const any_color = colors.some(Boolean);
        if(!any_color && depth === undefined && stencil === undefined) return;
        const scissor = c.enabled.has(SCISSOR_TEST) && !(c.scissor[0] <= 0 && c.scissor[1] <= 0 && c.scissor[0] + c.scissor[2] >= target.width &&
            c.scissor[1] + c.scissor[3] >= target.height);
        const simple = !scissor && (!any_color || c.color_mask.every(Boolean)) && (stencil === undefined || (c.stencil_writemask[0] & 0xFF) === 0xFF);
        if(simple)
        {
            this.begin_pass3(target, { colors, depth, stencil });
            return;
        }
        this.clear_quad3(c, target, colors, depth, stencil);
    },

    clear_quad3(c, target, colors, depth, stencil)
    {
        const types = target.colors.map(a => a ? { f: "f32", i: "i32", u: "u32" }[format_kind(a.format)] : null);
        const mask = (c.color_mask[0] ? 1 : 0) | (c.color_mask[1] ? 2 : 0) | (c.color_mask[2] ? 4 : 0) | (c.color_mask[3] && target.alpha ? 8 : 0);
        const key = ["clear3", target.colors.map((a, i) => a ? a.format + (colors[i] ? mask : 0) : "-").join(","), target.depth ? target.depth.format : "",
            depth !== undefined ? 1 : 0, stencil !== undefined ? c.stencil_writemask[0] & 0xFF : 0, target.samples].join("|");
        let pipeline = this.pipelines.get(key);
        if(!pipeline)
        {
            const outputs = types.map((t, i) => t ? `@location(${i}) c${i} : vec4<${t}>,` : "").join("\n");
            const writes = types.map((t, i) => t ? `o.c${i} = bitcast<vec4<${t}>>(u[${i}]);` : "").join("\n");
            const code = `
                struct Out { ${outputs || "@location(0) unused : vec4<f32>,"} };
                @group(0) @binding(0) var<uniform> u : array<vec4<u32>, 5>;
                @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
                    let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
                    return vec4<f32>(p[i], bitcast<f32>(u[4].x), 1.0);
                }
                @fragment fn fs() -> Out { var o : Out; ${writes} return o; }`;
            const module = this.device.createShaderModule({ label: "GLES 3 clear", code });
            const descriptor = {
                label: "GLES 3 clear", layout: "auto", vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: target.colors.map((a, i) => a ? { format: a.format, writeMask: colors[i] ? mask : 0 } : null) },
                primitive: { topology: "triangle-list" }, multisample: { count: target.samples },
            };
            if(target.depth)
            {
                const format = target.depth.format;
                descriptor.depthStencil = Object.assign({ format },
                    format !== "stencil8" ? { depthWriteEnabled: depth !== undefined, depthCompare: "always" } : {},
                    format.includes("stencil") ? { stencilFront: { compare: "always", passOp: "replace" }, stencilBack: { compare: "always", passOp: "replace" },
                        stencilWriteMask: stencil !== undefined ? c.stencil_writemask[0] & 0xFF : 0 } : {});
            }
            pipeline = this.device.createRenderPipeline(descriptor);
            this.pipelines.set(key, pipeline);
        }
        const values = new ArrayBuffer(80);
        target.colors.forEach((a, i) =>
        {
            if(!a || !colors[i]) return;
            const kind = format_kind(a.format);
            (kind === "f" ? new Float32Array(values, i * 16, 4) : kind === "u" ? new Uint32Array(values, i * 16, 4) : new Int32Array(values, i * 16, 4)).set(colors[i]);
        });
        new Float32Array(values, 64, 1)[0] = depth === undefined ? 0 : depth;
        const pass = this.begin_pass3(target, null);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: this.uniform_buffer(values) } }] }));
        this.apply_scissor(pass, c, target);
        pass.setViewport(0, 0, target.width, target.height, 0, 1);
        if(stencil !== undefined) pass.setStencilReference(stencil);
        pass.draw(3);
    },

    // ---- draws

    /**
     * A draw of a GLES 3.x context
     * @param {?{type: number, bytes: (Uint8Array|undefined), offset: (number|undefined)}} elements
     */
    draw3(c, mode, first, count, elements, instances)
    {
        if(count <= 0 || instances <= 0) return;
        // (rasterizer discard: transform feedback's alone, L3's second part)
        if(c.enabled.has(GL3.RASTERIZER_DISCARD)) return;
        const program = c.group.objects.get(c.program);
        if(!program || !program.info || !program.info.ok || !program.info.spirv) return;
        if(c.enabled.has(CULL_FACE) && c.cull_face === 0x0408 && mode >= 4) return;
        const target = this.target3(c);
        if(!target) return;
        const shaders = this.program3(c, program, target);
        if(!shaders) return;
        const plan = this.vertex_plan3(c, this.inputs3(program), instances);
        if(!plan) return;
        // the indices: the element buffer's as they are where they can be, else a list from the vertex range's first
        let list = null, low = 0, high = -1, rebase = false, topology = TOPOLOGY[mode], strip = mode === 3 || mode === 5, direct = null;
        const fan_or_loop = mode === 2 || mode === 6;
        if(elements)
        {
            const size = INDEX_BYTES[elements.type];
            const buffer = elements.bytes ? null : c.group.buffers.get(c.element_array_buffer);
            if(!size || !elements.bytes && !buffer) return;
            if(buffer && !fan_or_loop && !plan.cpu_vertex && size > 1 && elements.offset % size === 0)
            {
                direct = { buffer: this.gpu_buffer(buffer).buffer, format: size === 2 ? "uint16" : "uint32", offset: elements.offset };
            }
            else
            {
                const source = elements.bytes || (buffer.gpu_newer ? null : cpu_bytes(buffer));
                if(!source) return void this.note3("indices the GPU wrote, converted");
                const offset = elements.bytes ? 0 : elements.offset;
                if(offset + count * size > source.length) return;
                const view = new DataView(source.buffer, source.byteOffset + offset, count * size);
                const indices = new Uint32Array(count);
                for(let i = 0; i < count; i++) indices[i] = size === 1 ? view.getUint8(i) : size === 2 ? view.getUint16(2 * i, true) : view.getUint32(4 * i, true);
                const r = index_list(indices, mode, c.enabled.has(RESTART) ? (size === 1 ? 0xFF : size === 2 ? 0xFFFF : 0xFFFFFFFF) : -1);
                if(!r || !r.list.length) return;
                ({ list, low, high, topology, strip } = r);
                rebase = true;
            }
        }
        else if(fan_or_loop)
        {
            const r = index_list(Uint32Array.from({ length: count }, (_, i) => first + i), mode, -1);
            if(!r || !r.list.length) return;
            ({ list, low, high, topology, strip } = r);
            rebase = true;
        }
        else if(plan.cpu_vertex)
        {
            low = first;
            high = first + count - 1;
            rebase = true;
        }
        if(rebase && high - low >= 1 << 24) return void this.note3("a vertex range past 2^24");
        const vertex = this.vertex_buffers3(c, plan, { low, high, rebase, instances, indexed: !!(list || direct), first, count });
        if(!vertex) return;
        const group = this.bind_group3(c, program, shaders, target);
        if(!group) return;
        const [vx, vy, vw, vh] = c.viewport;
        if(vw <= 0 || vh <= 0) return;
        let index_buffer = null;
        if(list)
        {
            index_buffer = this.device.createBuffer({ label: "GLES indices", size: align4(Math.max(4, list.byteLength)), usage: B.INDEX, mappedAtCreation: true });
            new Uint32Array(index_buffer.getMappedRange()).set(list);
            index_buffer.unmap();
            this.staging.push(index_buffer);
        }
        const strip_format = strip && (list || direct) ? (direct ? direct.format : "uint32") : undefined;
        for(const face of this.stencil_faces3(c, target, mode))
        {
            const pipeline = this.pipeline3(c, shaders, vertex, group, topology, strip_format, target, face);
            if(!pipeline) return;
            const pass = this.begin_pass3(target, null);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.device.createBindGroup({ layout: group.layout, entries: group.resources }));
            vertex.slots.forEach((s, i) => pass.setVertexBuffer(i, s.gpu, s.offset));
            pass.setViewport(vx, vy, vw, vh, Math.min(c.depth_range[0], c.depth_range[1]), Math.max(c.depth_range[0], c.depth_range[1]));
            if(!this.apply_scissor(pass, c, target)) return;
            pass.setBlendConstant({ r: c.blend_color[0], g: c.blend_color[1], b: c.blend_color[2], a: c.blend_color[3] });
            if(c.enabled.has(STENCIL_TEST)) pass.setStencilReference(c.stencil_func[face === undefined ? 0 : face][1] & 0xFF);
            if(index_buffer)
            {
                pass.setIndexBuffer(index_buffer, "uint32");
                pass.drawIndexed(list.length, instances);
            }
            else if(direct)
            {
                pass.setIndexBuffer(direct.buffer, direct.format, direct.offset);
                pass.drawIndexed(count, instances);
            }
            else pass.draw(count, instances, rebase ? 0 : first, 0);
        }
        this.stats.draws++;
    },

    /** The stencil faces a draw is made of (gles_executor.js's stencil_faces, with the target's depth format) */
    stencil_faces3(c, target, mode)
    {
        const format = target.depth ? target.depth.format : "";
        return this.stencil_faces(c, { depth: !!target.depth, depth_format: format }, mode);
    },

    /**
     * How each vertex input is read: from its buffer directly, assembled on
     * the CPU, or its current value
     * @return {?{direct: !Array<!Object>, cpu: !Array<!Object>, constants: !Array<!Object>, cpu_vertex: boolean}}
     */
    vertex_plan3(c, inputs, instances)
    {
        const direct = [], cpu = [], constants = [];
        for(const input of inputs)
        {
            const a = c.attribs[input.location];
            if(!a) return this.note3("an input past the attributes");
            if(!a.enabled)
            {
                constants.push({ input, a });
                continue;
            }
            const step = a.divisor ? "instance" : "vertex";
            const buffer = !a.data && a.buffer ? c.group.buffers.get(a.buffer) : null;
            const format = buffer && buffer.size && !(a.divisor > 1 && instances > 1) ? direct_format(a, input.kind) : null;
            if(format)
            {
                const component = packed_attribute(a.type) ? 4 : TYPE_BYTES[a.type];
                const element = packed_attribute(a.type) ? 4 : a.size * component;
                const stride = a.stride || element;
                if(stride % 4 === 0 && stride <= 2048 && a.offset % Math.min(4, component) === 0 && (a.offset & 3) + element <= stride)
                {
                    direct.push({ input, a, buffer, format, stride, step, element });
                    continue;
                }
            }
            if(buffer && buffer.gpu_newer) return this.note3("a vertex array the GPU wrote, converted");
            cpu.push({ input, a, step });
        }
        return { direct, cpu, constants, cpu_vertex: cpu.some(x => x.step === "vertex") };
    },

    /**
     * The draw's vertex buffers by the plan: direct arrays sharing a slot
     * where their buffer, stride and step agree and their offsets fit in one
     * vertex; the CPU's in one buffer a step; the current values in one
     * @param {{low: number, high: number, rebase: boolean, instances: number, indexed: boolean, first: number, count: number}} range
     * @return {?{slots: !Array<!Object>, key: string}}
     */
    vertex_buffers3(c, plan, range)
    {
        const slots = [];
        const groups = new Map();
        for(const d of plan.direct)
        {
            const key = d.a.buffer + ":" + d.stride + ":" + d.step;
            if(!groups.has(key)) groups.set(key, []);
            groups.get(key).push(d);
        }
        for(const list of groups.values())
        {
            list.sort((x, y) => x.a.offset - y.a.offset);
            let slot = null;
            for(const d of list)
            {
                if(!slot || d.a.offset - slot.base + d.element > d.stride)
                {
                    slot = { buffer: d.buffer, base: d.a.offset & ~3, stride: d.stride, step: d.step, attributes: [], end: 0 };
                    slots.push(slot);
                }
                slot.attributes.push({ shaderLocation: d.input.location, offset: d.a.offset - slot.base, format: d.format });
                slot.end = Math.max(slot.end, d.a.offset - slot.base + d.element);
            }
        }
        for(const slot of slots)
        {
            const gpu = this.gpu_buffer(slot.buffer);
            slot.gpu = gpu.buffer;
            slot.offset = slot.base + (slot.step === "vertex" && range.rebase ? range.low * slot.stride : 0);
            // (what WebGPU checks of a draw's vertex and instance ranges: GL leaves reads past a buffer undefined)
            const last = slot.step === "instance" ? range.instances - 1 : range.indexed ? -1 : range.rebase ? range.count - 1 : range.first + range.count - 1;
            if(slot.offset > slot.buffer.size || last >= 0 && slot.offset + last * slot.stride + slot.end > slot.buffer.size)
            {
                return this.note3("a vertex array past its buffer");
            }
        }
        for(const step of ["vertex", "instance"])
        {
            const list = plan.cpu.filter(x => x.step === step);
            if(!list.length) continue;
            const n = step === "vertex" ? range.high - range.low + 1 : range.instances;
            if(n <= 0) return null;
            const stride = list.reduce((s, x) => s + x.input.components * 4, 0);
            const words = new Uint32Array(n * stride / 4);
            const attributes = [];
            let offset = 0;
            for(const x of list)
            {
                const components = x.input.components;
                const values = this.values3(c, x.a, step === "vertex" ? range.low : 0, n, components, x.input.kind,
                    step === "vertex" ? 0 : Math.max(1, x.a.divisor));
                if(!values) return this.note3("a vertex array with no data");
                const raw = new Uint32Array(values.buffer);
                for(let v = 0; v < n; v++) for(let k = 0; k < components; k++) words[(v * stride + offset) / 4 + k] = raw[v * components + k];
                attributes.push({ shaderLocation: x.input.location, offset, format: CPU_FORMAT[x.input.kind] + (components > 1 ? "x" + components : "") });
                offset += components * 4;
            }
            slots.push({ gpu: this.vertex_data3(words), offset: 0, stride, step, attributes });
        }
        if(plan.constants.length)
        {
            const values = new ArrayBuffer(plan.constants.length * 16);
            const attributes = plan.constants.map(({ input, a }, i) =>
            {
                const current = [0, 1, 2, 3].map(k => a.current[k] === undefined ? (k === 3 ? 1 : 0) : a.current[k]);
                (input.kind === "f" ? new Float32Array(values, 16 * i, 4) : input.kind === "u" ? new Uint32Array(values, 16 * i, 4) :
                    new Int32Array(values, 16 * i, 4)).set(current);
                return { shaderLocation: input.location, offset: 16 * i, format: CPU_FORMAT[input.kind] + (input.components > 1 ? "x" + input.components : "") };
            });
            slots.push({ gpu: this.vertex_data3(new Uint32Array(values)), offset: 0, stride: 0, step: "instance", attributes });
        }
        if(slots.length > (this.device.limits ? this.device.limits.maxVertexBuffers : 8)) return this.note3("more vertex buffers than WebGPU binds");
        const key = slots.map(s => s.stride + s.step[0] + s.attributes.map(x => x.shaderLocation + "@" + x.offset + x.format).join(".")).join("/");
        return { slots, key };
    },

    /** A vertex buffer holding the words */
    vertex_data3(words)
    {
        const buffer = this.device.createBuffer({ label: "GLES vertices", size: Math.max(16, words.byteLength), usage: B.VERTEX, mappedAtCreation: true });
        new Uint32Array(buffer.getMappedRange(), 0, words.length).set(words);
        buffer.unmap();
        this.staging.push(buffer);
        return buffer;
    },

    /**
     * An enabled array's values, `components` each (missing ones 0, w 1) as
     * the input's kind: vertices from `first` (absolute; a client array's
     * element 0 is vertex 0), or instances by the divisor
     * @return {?(Float32Array|Int32Array|Uint32Array)}
     */
    values3(c, a, first, n, components, kind, divisor)
    {
        const packed = packed_attribute(a.type);
        const type_bytes = TYPE_BYTES[a.type] || 4;
        const element = packed ? 4 : a.size * type_bytes;
        let source, base, stride;
        if(a.data)
        {
            source = a.data;
            stride = element;
            base = 0;
        }
        else
        {
            const buffer = c.group.buffers.get(a.buffer);
            source = buffer && cpu_bytes(buffer);
            if(!source) return null;
            stride = a.stride || element;
            base = a.offset;
        }
        const out = kind === "f" ? new Float32Array(n * components) : kind === "i" ? new Int32Array(n * components) : new Uint32Array(n * components);
        const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
        const convert = kind === "f" ? v => v : v => Math.trunc(v);
        for(let k = 0; k < n; k++)
        {
            const at = base + (divisor ? Math.floor(k / divisor) : first + k) * stride;
            const fits = at + element <= source.length;
            const parts = fits && packed ? read_packed(view, at, a.type, a.normalized) : null;
            for(let i = 0; i < components; i++)
            {
                let value = i === 3 ? 1 : 0;
                if(fits && i < (packed ? 4 : a.size)) value = packed ? parts[i] : read_component(view, at + i * type_bytes, a.type, a.normalized && !a.integer);
                out[k * components + i] = convert(value);
            }
        }
        return out;
    },

    // ---- bind groups

    /** The texture unit a sampler's element samples: the texture bound to its type's target, the sampler state */
    texture_unit3(c, program, b, e)
    {
        const binding = program.info.bindings.find(x => x.binding === b && x.kind === "sampler");
        const values = binding && binding.location >= 0 ? program.values.get(binding.location + e) : null;
        const unit = Math.max(0, Math.min(31, values ? values[0] : 0));
        const slot = binding && SAMPLER_SLOT.has(binding.type) ? SAMPLER_SLOT.get(binding.type) : 0;
        const name = c.textures[unit][slot];
        const texture = name ? c.group.textures.get(name) : c.defaults ? c.defaults.get(SLOT_TARGET[slot]) : null;
        const sampler = c.samplers && c.samplers[unit] ? c.group.samplers.get(c.samplers[unit]) : null;
        return { texture: texture || null, state: sampler || texture || NO_SAMPLER };
    },

    /** The wraps of the samplers of a program's integer textures (vx_naga's int_wraps: [group << 16 | binding, modes]) */
    int_wraps3(c, program, fetched)
    {
        const wraps = [];
        for(const key of fetched)
        {
            const { b, e } = spirv_binding(key & 0xFFFF);
            const { state } = this.texture_unit3(c, program, b, e);
            const mode = w => w in VK_WRAP ? VK_WRAP[w] : 0;
            const modes = mode(state.wrap_s) | mode(state.wrap_t) << 4 | mode(state.wrap_r || 0x2901) << 8;
            if(modes !== 0x222) wraps.push([key, modes]);
        }
        return wraps.sort((x, y) => x[0] - y[0]);
    },

    /**
     * The draw's bind group 0: the default uniform block, the samplers'
     * textures and samplers, the uniform blocks
     * @return {?{layout: !GPUBindGroupLayout, resources: !Array<!Object>, key: string}}
     */
    bind_group3(c, program, shaders, target)
    {
        const entries = [], resources = [];
        const samplings = new Map();
        const declarations = new Map(shaders.bindings.map(b => [b.binding, b.type]));
        for(const b of shaders.bindings)
        {
            const { binding, kind, visibility } = b;
            const buffer_type = kind === "uniform" ? "uniform" : kind === "storage" ? "read-only-storage" : "storage";
            if(binding === 0)
            {
                entries.push({ binding, visibility, buffer: { type: buffer_type } });
                resources.push({ binding, resource: { buffer: this.default_block3(program, b.size) } });
                continue;
            }
            const { b: spirv, e } = spirv_binding(binding);
            if(spirv >= BINDING.SAMPLERS && spirv < BINDING.UNIFORM_BLOCKS)
            {
                const key = spirv + ":" + e;
                let sampling = samplings.get(key);
                if(!sampling)
                {
                    const unit = this.texture_unit3(c, program, spirv, e);
                    const tex = texture_type(declarations.get(binding & ~1));
                    sampling = Object.assign(this.texture_view3(unit.texture, unit.state, tex, target), { state: unit.state, tex });
                    samplings.set(key, sampling);
                }
                if(kind.startsWith("texture"))
                {
                    entries.push({ binding, visibility, texture: { sampleType: sampling.sample_type, viewDimension: sampling.tex.dimension,
                        multisampled: sampling.tex.multisampled } });
                    resources.push({ binding, resource: sampling.view });
                }
                else
                {
                    const comparison = kind === "sampler-comparison";
                    entries.push({ binding, visibility, sampler: { type: comparison ? "comparison" : sampling.filtering ? "filtering" : "non-filtering" } });
                    resources.push({ binding, resource: this.sampler3(sampling.state, sampling.filtering, comparison) });
                }
                continue;
            }
            if(spirv >= BINDING.UNIFORM_BLOCKS && spirv < BINDING.STORAGE_BLOCKS && kind !== "storage-rw")
            {
                entries.push({ binding, visibility, buffer: { type: buffer_type } });
                resources.push({ binding, resource: this.block3(c, program, spirv - BINDING.UNIFORM_BLOCKS + e, b.size) });
                continue;
            }
            return this.note3("a binding of " + kind + " (L5)");
        }
        const key = JSON.stringify(entries);
        this.layouts3 = this.layouts3 || new Map();
        let layout = this.layouts3.get(key);
        if(!layout)
        {
            const group = this.device.createBindGroupLayout({ label: "GLES 3 resources", entries });
            layout = { group, pipeline: this.device.createPipelineLayout({ bindGroupLayouts: [group] }), id: this.layouts3.size + 1 };
            this.layouts3.set(key, layout);
        }
        return { layout: layout.group, pipeline_layout: layout.pipeline, resources, key: String(layout.id) };
    },

    /** The default uniform block's buffer: the program's values by their offsets (made again when they change) */
    default_block3(program, size)
    {
        const gpu = this.program_gpu(program);
        const version = program.values_version || 0;
        if(gpu.uniforms && gpu.uniforms.version === version && gpu.uniforms.size >= size) return gpu.uniforms.buffer;
        const info = program.info;
        const bytes = new ArrayBuffer(Math.ceil(Math.max(16, size, info.default_block_size || 0) / 16) * 16);
        const view = new DataView(bytes);
        for(const u of info.uniforms)
        {
            if(u.block_index >= 0 || u.opaque || u.location < 0 || u.offset < 0) continue;
            for(let e = 0; e < u.size; e++)
            {
                const values = program.values.get(u.location + e);
                if(!values) continue;
                const base = u.offset + e * (u.array_stride || 0);
                if(u.columns)
                {
                    for(let col = 0; col < u.columns; col++)
                    {
                        for(let row = 0; row < u.rows; row++)
                        {
                            const at = base + (u.row_major ? row * u.matrix_stride + col * 4 : col * u.matrix_stride + row * 4);
                            if(at + 4 <= bytes.byteLength) view.setFloat32(at, values[col * u.rows + row] || 0, true);
                        }
                    }
                    continue;
                }
                for(let i = 0; i < u.components && base + 4 * i + 4 <= bytes.byteLength; i++)
                {
                    const v = values[i] || 0;
                    if(!u.int) view.setFloat32(base + 4 * i, v, true);
                    else if(u.uint || u.bool) view.setUint32(base + 4 * i, v >>> 0, true);
                    else view.setInt32(base + 4 * i, v | 0, true);
                }
            }
        }
        const buffer = this.device.createBuffer({ label: "GLES default uniforms", size: bytes.byteLength, usage: B.UNIFORM | B.STORAGE, mappedAtCreation: true });
        new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(bytes));
        buffer.unmap();
        if(gpu.uniforms) this.staging.push(gpu.uniforms.buffer);
        gpu.uniforms = { version, size: bytes.byteLength, buffer };
        return buffer;
    },

    /** A uniform block's buffer range: what its binding point holds (zeros for nothing, or too little) */
    block3(c, program, index, size)
    {
        const block = program.info.blocks[index];
        const point = program.block_bindings ? program.block_bindings[index] : block ? block.binding : 0;
        const b = c.uniform_bindings[point];
        const buffer = b && b.buffer ? c.group.buffers.get(b.buffer) : null;
        const zeros = () => ({ buffer: this.zeros3(size), offset: 0, size: Math.max(16, align4(size)) });
        if(!buffer || !buffer.size) return zeros();
        const gpu = this.gpu_buffer(buffer);
        const offset = b.offset;
        let length = b.size ? Math.min(b.size, buffer.size - offset) : buffer.size - offset;
        length = Math.max(length, size);
        if(offset % 256 || offset + length > gpu.size) return zeros();
        return { buffer: gpu.buffer, offset, size: Math.min(align4(length), gpu.size - offset) };
    },

    /**
     * A texture's view as a sampler of the WGSL type samples it, by GLES
     * 3.0's completeness (3.8.13: levels base to max, cube faces, filters of
     * formats that filter no texels), or the fallback's
     * @return {{view: !GPUTextureView, sample_type: string, filtering: boolean}}
     */
    texture_view3(texture, state, tex, target)
    {
        const fallback = () => this.fallback3(tex);
        if(!texture) return fallback();
        const level0 = texture.images.get(0);
        if(level0 && (level0.image || level0.color_buffer))
        {
            const t = level0.image ? this.image_texture(level0.image) : this.color_buffer_texture(level0.color_buffer);
            if(!t || tex.sample !== "float" || tex.dimension !== "2d" || target.textures.has(t.texture)) return fallback();
            return { view: t.texture.createView(), sample_type: "float", filtering: true };
        }
        const gpu = this.gpu_texture3(texture);
        if(!gpu || target.textures.has(gpu.texture)) return fallback();
        const three = gpu.three, cube = gpu.cube;
        let base = texture.base_level || 0;
        if(texture.immutable) base = Math.min(base, texture.immutable_levels - 1);
        const first = texture.images.get(base);
        if(!first || !first.width || !first.height) return fallback();
        const internal = first.internal || first.format;
        const info = format_info(internal);
        const kind = info ? info.kind : "unorm";
        const depth = kind === "depth" || kind === "depth_stencil";
        const mipmapped = state.min_filter !== NEAREST && state.min_filter !== LINEAR;
        const max_level = texture.max_level === undefined ? 1000 : texture.max_level;
        const chain = base + Math.floor(Math.log2(Math.max(first.width, first.height, three ? first.depth || 1 : 1)));
        const top = !mipmapped ? base : Math.min(max_level, texture.immutable ? texture.immutable_levels - 1 : chain);
        if(top < base) return fallback();
        if(cube && first.width !== first.height) return fallback();
        for(let level = base; level <= top; level++)
        {
            const w = Math.max(1, first.width >> level - base), h = Math.max(1, first.height >> level - base);
            const d = three ? Math.max(1, (first.depth || 1) >> level - base) : first.depth || 1;
            for(let face = 0; face < (cube ? 6 : 1); face++)
            {
                const image = texture.images.get(face * 32 + level);
                if(!image || image.width !== w || image.height !== h || (image.depth || 1) !== d || (image.internal || image.format) !== internal) return fallback();
            }
        }
        const compare = depth && state.compare_mode === COMPARE_REF_TO_TEXTURE;
        const filterable = !info || info.filterable || compare;
        const linear = state.mag_filter !== NEAREST || state.min_filter !== NEAREST && state.min_filter !== NEAREST_MIPMAP_NEAREST;
        if(!filterable && linear) return fallback();
        let sample_type;
        if(tex.sample === "depth") sample_type = depth ? "depth" : null;
        else if(tex.sample === "sint") sample_type = kind === "int" ? "sint" : null;
        else if(tex.sample === "uint") sample_type = kind === "uint" ? "uint" : null;
        else sample_type = kind === "int" || kind === "uint" ? null : depth || !filterable || info && !info.filterable ? "unfilterable-float" : "float";
        if(!sample_type) return fallback();
        const mip = base - gpu.first, count = top - base + 1;
        if(mip < 0 || mip + count > gpu.levels) return fallback();
        const aspect = gpu.format.includes("stencil") && gpu.format !== "stencil8" ? "depth-only" : "all";
        const dimension = tex.dimension;
        if((dimension === "3d") !== three || dimension === "cube" && !cube) return fallback();
        const key = dimension + ":" + mip + ":" + count + ":" + aspect;
        let view = gpu.views.get(key);
        if(!view)
        {
            view = gpu.texture.createView({ dimension, baseMipLevel: mip, mipLevelCount: count, aspect,
                ...(dimension === "2d" ? { arrayLayerCount: 1 } : {}) });
            gpu.views.set(key, view);
        }
        return { view, sample_type, filtering: sample_type === "float" };
    },

    /** What an incomplete texture samples as, of the WGSL type's dimension and kind: (0, 0, 0, 1) */
    fallback3(tex)
    {
        const key = tex.dimension + ":" + tex.sample;
        this.fallbacks3 = this.fallbacks3 || new Map();
        let fallback = this.fallbacks3.get(key);
        if(fallback) return fallback;
        const format = tex.sample === "depth" ? "depth16unorm" : tex.sample === "sint" ? "rgba8sint" : tex.sample === "uint" ? "rgba8uint" : COLOR_FORMAT;
        const layers = tex.dimension === "cube" ? 6 : 1;
        const texture = this.device.createTexture({ label: "GLES incomplete texture", size: [1, 1, layers], dimension: tex.dimension === "3d" ? "3d" : "2d",
            format, usage: U.TEXTURE_BINDING | U.COPY_DST });
        const texel = format === "depth16unorm" ? [0, 0] : format === COLOR_FORMAT ? [0, 0, 0, 255] : [0, 0, 0, 1];
        const data = new Uint8Array(texel.length * layers);
        for(let i = 0; i < layers; i++) data.set(texel, i * texel.length);
        this.device.queue.writeTexture({ texture }, data, { bytesPerRow: texel.length, rowsPerImage: 1 }, [1, 1, layers]);
        fallback = { view: texture.createView({ dimension: tex.dimension }), sample_type: tex.sample === "float" ? "float" : tex.sample,
            filtering: tex.sample === "float" };
        this.fallbacks3.set(key, fallback);
        return fallback;
    },

    /** A sampler of a sampler object's (or texture's) state; nearest only for a texture that filters no texels */
    sampler3(state, filtering, comparison)
    {
        const min = state.min_filter, mag = state.mag_filter;
        const lod_min = Math.min(32, Math.max(0, state.min_lod === undefined ? -1000 : state.min_lod));
        const lod_max = Math.min(32, Math.max(lod_min, state.max_lod === undefined ? 1000 : state.max_lod));
        const compare = comparison ? COMPARE[state.compare_func || 0x0203] : undefined;
        const key = [min, mag, state.wrap_s, state.wrap_t, state.wrap_r, lod_min, lod_max, filtering, compare].join("|");
        let sampler = this.samplers.get(key);
        if(!sampler)
        {
            const linear = f => filtering && (f === LINEAR || f === 0x2701 || f === 0x2703);
            sampler = this.device.createSampler(Object.assign({
                addressModeU: WRAPS[state.wrap_s] || "repeat", addressModeV: WRAPS[state.wrap_t] || "repeat", addressModeW: WRAPS[state.wrap_r] || "repeat",
                magFilter: filtering && mag === LINEAR ? "linear" : "nearest", minFilter: linear(min) ? "linear" : "nearest",
                mipmapFilter: filtering && (min === 0x2702 || min === 0x2703) ? "linear" : "nearest", lodMinClamp: lod_min, lodMaxClamp: lod_max,
            }, compare ? { compare } : {}));
            this.samplers.set(key, sampler);
        }
        return sampler;
    },

    /** The pipeline for the program, the vertex buffers, the resources, the state and the target */
    pipeline3(c, shaders, vertex, group, topology, strip_format, target, face)
    {
        const blend = c.enabled.has(BLEND);
        const depth_test = c.enabled.has(DEPTH_TEST), stencil_test = c.enabled.has(STENCIL_TEST);
        const cull = face === 0 ? "back" : face === 1 ? "front" : c.enabled.has(CULL_FACE) ? (c.cull_face === 0x0404 ? "front" : "back") : "none";
        const masks = face === undefined ? 0 : face;
        const depth_format = target.depth ? target.depth.format : "";
        const key = ["3", shaders.id, vertex.key, group.key, topology, strip_format || "", c.front_face, cull, masks,
            target.colors.map(a => a ? a.format : "-").join(","), target.alpha ? "a" : "x", depth_format, target.samples,
            blend ? c.blend_func.join(",") + "/" + c.blend_equation.join(",") : "-", c.color_mask.join(""),
            depth_test ? c.depth_func + ":" + c.depth_mask : "-",
            stencil_test ? JSON.stringify([c.stencil_func, c.stencil_op, c.stencil_writemask]) : "-",
            c.enabled.has(POLYGON_OFFSET_FILL) ? c.polygon_offset.join(",") : "-"].join("|");
        let pipeline = this.pipelines.get(key);
        if(pipeline) return pipeline;
        const write_mask = (c.color_mask[0] ? 1 : 0) | (c.color_mask[1] ? 2 : 0) | (c.color_mask[2] ? 4 : 0) | (c.color_mask[3] && target.alpha ? 8 : 0);
        const targets = target.colors.map((a, i) =>
        {
            if(!a) return null;
            // (an output the shader lacks or of another kind: nothing written, GL leaves it undefined)
            const output = shaders.outputs.get(i);
            const kind = format_kind(a.format);
            const fits = output && (kind === "f" ? !/[iu]32/.test(output) : output.includes(kind === "i" ? "i32" : "u32"));
            return { format: a.format, writeMask: fits ? write_mask : 0, blend: blend && fits && blendable(a.format) ? {
                color: blend_component(c.blend_equation[0], c.blend_func[0], c.blend_func[1]),
                alpha: blend_component(c.blend_equation[1], c.blend_func[2], c.blend_func[3]),
            } : undefined };
        });
        const descriptor = {
            label: "GLES 3 pipeline", layout: group.pipeline_layout,
            vertex: { module: shaders.vertex.module, entryPoint: shaders.vertex.entry,
                buffers: vertex.slots.map(s => ({ arrayStride: s.stride, stepMode: s.step, attributes: s.attributes })) },
            fragment: { module: shaders.fragment.module, entryPoint: shaders.fragment.entry, targets },
            // (the Y flip reverses the winding: GL's CCW is WebGPU's CW)
            primitive: { topology, frontFace: c.front_face === 0x0901 ? "cw" : "ccw", cullMode: cull, ...(strip_format ? { stripIndexFormat: strip_format } : {}) },
            multisample: { count: target.samples },
        };
        if(target.depth)
        {
            const stencil = depth_format.includes("stencil");
            const face_state = i => ({ compare: COMPARE[c.stencil_func[i][0]], failOp: STENCIL_OPS[c.stencil_op[i][0]],
                depthFailOp: STENCIL_OPS[c.stencil_op[i][1]], passOp: STENCIL_OPS[c.stencil_op[i][2]] });
            descriptor.depthStencil = Object.assign({ format: depth_format },
                depth_format !== "stencil8" ? { depthWriteEnabled: depth_test && !!c.depth_mask, depthCompare: depth_test ? COMPARE[c.depth_func] : "always" } : {},
                stencil && stencil_test ? { stencilFront: face_state(0), stencilBack: face_state(1), stencilReadMask: c.stencil_func[masks][2] & 0xFF,
                    stencilWriteMask: c.stencil_writemask[masks] & 0xFF } : {},
                c.enabled.has(POLYGON_OFFSET_FILL) && depth_format !== "stencil8" ? { depthBias: Math.round(c.polygon_offset[1]),
                    depthBiasSlopeScale: c.polygon_offset[0] } : {});
        }
        try
        {
            pipeline = this.device.createRenderPipeline(descriptor);
        }
        catch(error)
        {
            if(this.stats.errors.length < 20) this.stats.errors.push("pipeline: " + error.message);
            return null;
        }
        this.stats.pipelines++;
        this.pipelines.set(key, pipeline);
        return pipeline;
    },

    // ---- commands

    /**
     * A command of a GLES 3.x context after the shadow took it: what the GPU
     * does of it
     * @return {boolean} whether it was this one's (else GLES 2.0's handles it)
     */
    command3(c, name, args)
    {
        switch(name)
        {
            case "glTexImage2D": case "glTexImage2DOffsetAEMU": case "glTexImage3D": case "glTexImage3DOffsetAEMU":
            case "glTexSubImage2D": case "glTexSubImage2DOffsetAEMU": case "glTexSubImage3D": case "glTexSubImage3DOffsetAEMU":
                this.tex_image3(c, name, args);
                return true;
            case "glTexStorage2D": case "glTexStorage3D":
            {
                const { texture } = this.bound3(c, args[0]);
                if(texture) this.gpu_texture3(texture);
                return true;
            }
            case "glCompressedTexImage2D": case "glCompressedTexImage2DOffsetAEMU": case "glCompressedTexImage3D": case "glCompressedTexImage3DOffsetAEMU":
            case "glCompressedTexSubImage2D": case "glCompressedTexSubImage2DOffsetAEMU": case "glCompressedTexSubImage3D":
            case "glCompressedTexSubImage3DOffsetAEMU":
                this.compressed_image3(c, name, args);
                return true;
            case "glCopyTexImage2D": case "glCopyTexSubImage2D": case "glCopyTexSubImage3D":
                this.copy_tex_image3(c, name, args);
                return true;
            case "glGenerateMipmap": this.generate_mipmap3(c, args[0]); return true;
            case "glBufferData":
            {
                const buffer = this.buffer_of3(c, args[0]);
                if(buffer) buffer.dirty = [0, buffer.size];
                return true;
            }
            case "glBufferSubData":
                this.buffer_written(this.buffer_of3(c, args[0]), args[1], args[2], args[3]);
                return true;
            case "glUnmapBufferAEMU":
            {
                const [target, offset, length, access, data] = args;
                if(access & GL3.MAP_WRITE_BIT && !(access & GL3.MAP_FLUSH_EXPLICIT_BIT)) this.buffer_written(this.buffer_of3(c, target), offset, length, data);
                return true;
            }
            case "glFlushMappedBufferRangeAEMU":
            {
                const buffer = this.buffer_of3(c, args[0]);
                if(buffer && buffer.mapped) this.buffer_written(buffer, buffer.mapped.offset + args[1], args[2], args[4]);
                return true;
            }
            case "glCopyBufferSubData":
            {
                const [read_target, write_target, read_offset, write_offset, size] = args;
                const from = this.buffer_of3(c, read_target), to = this.buffer_of3(c, write_target);
                if(!from || !to || size <= 0) return true;
                if(!from.gpu_newer)
                {
                    const bytes = cpu_bytes(to);
                    this.buffer_written(to, write_offset, size, bytes && bytes.subarray(write_offset, write_offset + size));
                    return true;
                }
                if(read_offset % 4 || write_offset % 4 || size % 4)
                {
                    this.note3("an unaligned copy of a buffer the GPU wrote");
                    return true;
                }
                const a = this.gpu_buffer(from), b = this.gpu_buffer(to);
                this.end_pass();
                this.encoder.copyBufferToBuffer(a.buffer, read_offset, b.buffer, write_offset, size);
                return true;
            }
            case "glRenderbufferStorage": case "glRenderbufferStorageMultisample": this.renderbuffer_storage3(c); return true;
            case "glEGLImageTargetRenderbufferStorage":
            {
                const rb = c.group.renderbuffers.get(c.renderbuffer);
                if(rb && rb.gpu) this.staging.push(rb.gpu);
                if(rb) rb.gpu = null;
                return true;
            }
            case "glVertexAttribPointerData": c.attribs[args[0]].data = args[5]; return true;
            case "glVertexAttribIPointerDataAEMU": c.attribs[args[0]].data = args[4]; return true;
            case "glVertexAttribPointerOffset": case "glVertexAttribIPointerOffsetAEMU": c.attribs[args[0]].data = null; return true;
            case "glClear": this.clear3(c, args[0]); return true;
            case "glClearBufferiv": case "glClearBufferuiv": case "glClearBufferfv": case "glClearBufferfi": this.clear_buffer3(c, name, args); return true;
            case "glDrawArrays": this.draw3(c, args[0], args[1], args[2], null, 1); return true;
            case "glDrawArraysInstanced": this.draw3(c, args[0], args[1], args[2], null, args[3]); return true;
            case "glDrawElementsData": this.draw3(c, args[0], 0, args[1], { type: args[2], bytes: args[3] }, 1); return true;
            case "glDrawElementsOffset": this.draw3(c, args[0], 0, args[1], { type: args[2], offset: args[3] }, 1); return true;
            case "glDrawElementsInstancedDataAEMU": this.draw3(c, args[0], 0, args[1], { type: args[2], bytes: args[3] }, args[4]); return true;
            case "glDrawElementsInstancedOffsetAEMU": this.draw3(c, args[0], 0, args[1], { type: args[2], offset: args[3] }, args[4]); return true;
            case "glDrawRangeElementsDataAEMU": this.draw3(c, args[0], 0, args[3], { type: args[4], bytes: args[5] }, 1); return true;
            case "glDrawRangeElementsOffsetAEMU": this.draw3(c, args[0], 0, args[3], { type: args[4], offset: args[5] }, 1); return true;
        }
        if(/^glUniform(?!BlockBinding)/.test(name))
        {
            const program = c.group.objects.get(c.program);
            if(program) program.values_version = (program.values_version || 0) + 1;
            return true;
        }
        return false;
    },
};
