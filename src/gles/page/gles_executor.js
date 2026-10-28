// The GLES executor (docs/gles-proxy-plan.md "执行器", E3): GLES batches
// (src/gles/gles_batch.js) on WebGPU, on the page. It runs the same state
// machine as the CPU side (src/gles/gles_shadow.js) over the commands it
// receives, so names, bindings, uniforms and locations agree, and keeps the
// GPU's part beside the shadow's objects: a texture's GPU texture, a
// buffer's bytes, a renderbuffer's attachment, a program's WGSL (the
// translator's ES mode, linked by the shadow).
//
// Orientation: GL's rendering keeps the translator's flip (framebuffer row
// 0 is GL's bottom row: viewport, scissor, readback and render-to-texture
// need no conversion). Color buffers hold Android's memory order (row 0 the
// top, as gralloc's CPU writes and SurfaceFlinger's texture transform
// expect), so a window surface draws into a texture of its own (gfxstream's
// pbuffer) which rcFlushWindowColorBuffer copies into its color buffer,
// flipped; reads and writes of color buffers are then plain copies.
//
// Each draw assembles its vertices on the CPU (client arrays come with the
// draw; buffers' bytes are kept here), converted to f32 where WebGPU has no
// format, with its indices as u32 (fans and loops expanded). Uploads go
// through staging buffers copied in the command encoder, in order with the
// draws. A post (rcFBPost) shows the color buffer: in the compositor's layer
// when there is one, otherwise read back and handed to the CPU side
// ("frame"). Points are WebGPU's, one pixel each.

import { GLESShadow } from "../gles_shadow.js";
import { read_gles_batch } from "../gles_batch.js";
import { GL, RENDERBUFFER_FORMATS } from "../gles_formats.js";
import { CONFIGS, CONFIG_ATTRIBUTES, EGL } from "../gles_caps.js";
import { decode_etc1, pack_rgba8, to_rgba8 } from "./gles_textures.js";
import { ff_inputs, ff_signature, ff_snapshot, unit_texture } from "./gles1_draw.js";
import { UNITS } from "../gles1_state.js";
import { SHADOW_CLASSES } from "../gles_shadow.js";
import { pack, shadow_skip, unpack } from "../gles_snapshot.js";
import { unpack_program } from "../glsl_program.js";
import { B, COLOR_FORMAT, COMPARE, STENCIL_OPS, U, WRAPS, align4, blend_component } from "./gles_gpu_tables.js";
import { GLES3 } from "./gles3_executor.js";

const TEXTURE_USAGE = U.TEXTURE_BINDING | U.COPY_DST | U.COPY_SRC | U.RENDER_ATTACHMENT;
const READBACK_HEADER = 16;

const DEPTH_FORMATS = {
    [GL.DEPTH_COMPONENT16]: "depth16unorm", [GL.DEPTH_COMPONENT24_OES]: "depth24plus", [GL.STENCIL_INDEX8]: "stencil8",
    [GL.DEPTH24_STENCIL8_OES]: "depth24plus-stencil8",
};
/** The vertex types: their bytes and how they read */
const TYPE_BYTES = { [GL.BYTE]: 1, [GL.UNSIGNED_BYTE]: 1, [GL.SHORT]: 2, [GL.UNSIGNED_SHORT]: 2, [GL.FLOAT]: 4, [GL.FIXED]: 4, [GL.HALF_FLOAT_OES]: 2 };

/** IEEE half to a float */
function half_to_float(h)
{
    const s = h & 0x8000 ? -1 : 1, e = h >> 10 & 31, m = h & 1023;
    if(e === 0) return s * m * 2 ** -24;
    if(e === 31) return m ? NaN : s * Infinity;
    return s * (1 + m / 1024) * 2 ** (e - 15);
}

/**
 * The WGSL bindings an entry point reaches ("group:binding"): an "auto"
 * layout has only those (gl_executor.js's collectReachableWgslBindings, the
 * same walk: the entry point's body, then the functions it calls)
 * @param {string} source
 * @param {string} entry
 * @param {!Set<string>} result
 */
function reachable_bindings(source, entry, result)
{
    const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
    const bindings = new Map();
    for(const m of text.matchAll(/@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)\s*var(?:\s*<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/g))
    {
        bindings.set(m[3], m[1] + ":" + m[2]);
    }
    const functions = new Map();
    const pattern = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    for(let m; (m = pattern.exec(text));)
    {
        const open = text.indexOf("{", pattern.lastIndex);
        if(open < 0) break;
        let depth = 1, end = open + 1;
        while(end < text.length && depth)
        {
            if(text[end] === "{") depth++;
            else if(text[end] === "}") depth--;
            end++;
        }
        functions.set(m[1], text.slice(open + 1, end - 1));
        pattern.lastIndex = end;
    }
    const pending = [entry], visited = new Set();
    while(pending.length)
    {
        const name = pending.pop();
        if(visited.has(name)) continue;
        visited.add(name);
        const body = functions.get(name);
        if(body === undefined) continue;
        for(const [variable, key] of bindings) if(new RegExp("\\b" + variable + "\\b").test(body)) result.add(key);
        for(const call of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) if(functions.has(call[1]) && !visited.has(call[1])) pending.push(call[1]);
    }
}

/**
 * @constructor
 * @param {{device: !GPUDevice, layer: ?Object, features: (Object|undefined)}} options
 */
export function GLESExecutor(options)
{
    this.device = options.device;
    this.layer = options.layer || null;
    this.reset();
}

GLESExecutor.prototype.reset = function()
{
    // what the shadow state asks of renderControl: images and color buffers
    this.rc = { images: new Map(), color_buffers: new Map() };
    this.shadow = new GLESShadow(this.rc);
    // (GLES 3.0's buffers keep their bytes here too: the GPU buffers' source, gles3_executor.js)
    this.shadow.keep_bytes = true;
    // (names the CPU side made with glGen*, which it keeps to itself, are made here)
    this.shadow.trusted = true;
    /** @type {!Map<number, {context: number, draw: number, read: number}>} */
    this.conns = new Map();
    /** @type {!Map<number, {config: number, width: number, height: number, color_buffer: number, texture: ?GPUTexture, depth: ?GPUTexture, depth_format: string}>} */
    this.surfaces = new Map();
    this.shaders = new Map();
    this.pipelines = new Map();
    this.samplers = new Map();
    this.fallback = null;
    this.blit = null;
    /** the frame to show, a read of it in flight */
    this.posted = 0;
    this.stats = { batches: 0, records: 0, draws: 0, refused: 0, pipelines: 0, uploads: 0, posts: 0, errors: [] };
    this.pass = null;
    this.pass_target = null;
};

// ---- batches

/**
 * Run a batch
 * @param {!Uint8Array} bytes
 * @param {{writeResponse: function(number, !Uint8Array), frame: (function(!Uint8Array, number, number)|undefined)}} sink
 *     the answers to reads (the readback header, then the pixels), and the
 *     posted frames when there is no layer (RGBA, rows from the top)
 */
GLESExecutor.prototype.submit = async function(bytes, sink)
{
    const records = read_gles_batch(bytes, true);
    this.stats.batches++;
    // (glslang's programs draw through vx_naga: loaded before the batch with the first link, or the first after a restore)
    if(!this.naga && (records.some(r => r.name === "PROGRAM_LINK") || [...this.shadow.contexts.values()].some(c => c.glslang)))
    {
        try
        {
            await this.load_naga();
        }
        catch(error)
        {
            if(this.stats.errors.length < 20) this.stats.errors.push("vx_naga: " + (error && error.message || error));
        }
    }
    this.encoder = this.device.createCommandEncoder({ label: "GLES batch" });
    this.reads = [];
    this.staging = [];
    for(const record of records)
    {
        this.stats.records++;
        try
        {
            this.run(record);
        }
        catch(error)
        {
            // (one command's failure is reported; the batch goes on)
            if(this.stats.errors.length < 20) this.stats.errors.push((record.command ? record.command.name : record.name) + ": " + (error && error.message || error));
        }
    }
    this.batch_end3();
    this.end_pass();
    this.device.queue.submit([this.encoder.finish()]);
    this.encoder = null;
    // (what the batch used and dropped goes only now: its commands were recorded with it)
    for(const object of this.staging) object.destroy();
    this.staging = [];
    const reads = this.reads;
    this.reads = [];
    for(const read of reads)
    {
        // (an answer with nothing to read: a failed read, an empty rectangle)
        if(!read.buffer)
        {
            read.done(null, sink);
            continue;
        }
        await read.buffer.mapAsync(globalThis.GPUMapMode ? globalThis.GPUMapMode.READ : 1);
        const mapped = new Uint8Array(read.buffer.getMappedRange());
        // (rows of texels, or a buffer's bytes as they are: `bytes`)
        const row = read.bytes || read.width * (read.texel || 4);
        const rows = new Uint8Array(row * (read.bytes ? 1 : read.height));
        if(read.bytes) rows.set(mapped.subarray(read.skip || 0, (read.skip || 0) + read.bytes));
        else for(let y = 0; y < read.height; y++)
        {
            const from = read.flip ? read.height - 1 - y : y;
            rows.set(mapped.subarray(from * read.stride, from * read.stride + row), y * row);
        }
        read.buffer.unmap();
        read.buffer.destroy();
        read.done(rows, sink);
    }
};

/** @param {!Object} record */
GLESExecutor.prototype.run = function(record)
{
    switch(record.name)
    {
        case "COMMAND": return this.command(record);
        case "CONTEXT_CREATE": return this.shadow.create_context(record.context, record.api, record.share);
        case "CONTEXT_DESTROY": return this.shadow.destroy_context(record.context);
        case "SURFACE_CREATE":
            this.surfaces.set(record.surface, { config: record.config, width: record.width, height: record.height, color_buffer: 0,
                texture: null, depth: null, depth_format: "" });
            return undefined;
        case "SURFACE_DESTROY":
        {
            const s = this.surfaces.get(record.surface);
            if(s && s.texture) this.staging.push(s.texture);
            if(s && s.depth) this.staging.push(s.depth);
            this.surfaces.delete(record.surface);
            return undefined;
        }
        case "SURFACE_COLOR_BUFFER":
        {
            const s = this.surfaces.get(record.surface);
            if(s) s.color_buffer = record.color_buffer;
            return undefined;
        }
        case "MAKE_CURRENT":
        {
            this.conns.set(record.conn, { context: record.context, draw: record.draw, read: record.read });
            const s = this.surfaces.get(record.draw);
            this.shadow.make_current(record.context, s ? { width: s.width, height: s.height, config: CONFIGS[s.config] } : null);
            return undefined;
        }
        case "CONNECTION_CLOSE": this.conns.delete(record.conn); return undefined;
        case "PROGRAM_LINK":
        {
            // (glslang's link of a program, for the glLinkProgram after it: the page has no glslang)
            const conn = this.conns.get(record.conn);
            const c = conn && this.shadow.context(conn.context);
            const program = c && c.group.objects.get(record.program);
            if(program && program.kind === "program") program.provided = unpack_program(record.bytes);
            // (glCreateShaderProgramv's: its program is made by the command after, which takes it)
            else if(c) (this.shadow.pending_links = this.shadow.pending_links || new Map()).set(record.program, unpack_program(record.bytes));
            return undefined;
        }
        case "COLOR_BUFFER_CREATE":
        {
            const texture = this.device.createTexture({ label: "color buffer " + record.color_buffer, size: [record.width, record.height],
                format: COLOR_FORMAT, usage: TEXTURE_USAGE });
            this.rc.color_buffers.set(record.color_buffer, { width: record.width, height: record.height, format: record.format, texture });
            // (an RGB buffer reads as opaque until written)
            if(record.format === GL.RGB) this.clear_texture(texture, [0, 0, 0, 1]);
            return undefined;
        }
        case "COLOR_BUFFER_DESTROY":
        {
            const cb = this.rc.color_buffers.get(record.color_buffer);
            if(cb) this.staging.push(cb.texture);
            this.rc.color_buffers.delete(record.color_buffer);
            return undefined;
        }
        case "COLOR_BUFFER_UPDATE":
        {
            const cb = this.rc.color_buffers.get(record.color_buffer);
            if(!cb || !record.width || !record.height) return undefined;
            const rgba = to_rgba8(record.format, record.type, record.width, record.height, 1, record.bytes);
            this.upload(cb.texture, 0, 0, record.x, record.y, record.width, record.height, rgba);
            return undefined;
        }
        case "COLOR_BUFFER_READ":
        {
            const cb = this.rc.color_buffers.get(record.color_buffer);
            if(!cb) return this.answer_failed(record.request);
            return this.read_texture(cb.texture, record.x, record.y, record.width, record.height, false,
                (rgba, sink) => this.answer(sink, record.request, rgba));
        }
        case "COLOR_BUFFER_BIND":
        {
            const conn = this.conns.get(record.conn);
            if(conn) this.shadow.bind_color_buffer(conn.context, record.color_buffer, !!record.texture);
            return undefined;
        }
        case "IMAGE_CREATE":
            this.rc.images.set(record.image, { context: record.context, target: record.target, buffer: record.buffer });
            return undefined;
        case "IMAGE_DESTROY": this.rc.images.delete(record.image); return undefined;
        case "FLUSH_SURFACE": return this.flush_surface(record.surface);
        case "POST": return this.post(record.color_buffer);
        case "READ_PIXELS": return this.read_pixels(record);
        case "BUFFER_READ": return this.buffer_read3(record);
        case "QUERY_READ": return this.query_read3(record);
    }
    return undefined;
};

// ---- commands

/** A GLES command: the shadow state, then what the GPU does of it */
GLESExecutor.prototype.command = function(record)
{
    const conn = this.conns.get(record.conn);
    const context = conn ? conn.context : 0;
    const c = this.shadow.context(context);
    if(!c) return;
    const name = record.command.name.replace(/OES$/, "");
    const args = record.args;
    // (what a deletion takes away: its GPU objects with it)
    const before = name === "glDeleteTextures" || name === "glDeleteRenderbuffers" || name === "glDeleteBuffers" ?
        new Int32Array(args[1].buffer.slice(args[1].byteOffset, args[1].byteOffset + args[1].length)) : null;
    const objects = name === "glDeleteTextures" ? c.group.textures : name === "glDeleteRenderbuffers" ? c.group.renderbuffers :
        name === "glDeleteBuffers" ? c.group.buffers : null;
    const gone = before ? [...before].map(n => objects.get(n)).filter(Boolean) : [];
    this.shadow.given_name = name === "glCreateShader" || name === "glCreateProgram" || name === "glCreateShaderProgramvAEMU" ? record.ret : 0;
    const { keep } = this.shadow.call(context, record.command, args);
    this.shadow.given_name = 0;
    if(!keep)
    {
        // (what the CPU side took and this shadow refuses: the two disagree)
        this.stats.refused++;
        const by = this.stats.refused_by = this.stats.refused_by || {};
        const key = name + ":0x" + c.error.toString(16);
        if(key in by || Object.keys(by).length < 20) by[key] = (by[key] || 0) + 1;
        return;
    }
    for(const object of gone) if(object.gpu && object.gpu.destroy && ![...objects.values()].includes(object)) this.staging.push(object.gpu);
    // (GLES 3.x's, and GLES 2.0's of a host with glslang: gles3_executor.js)
    if(c.glslang && this.command3(c, name, args)) return undefined;
    switch(name)
    {
        case "glTexImage2D": return this.tex_image(c, args, false);
        case "glTexSubImage2D": return this.tex_image(c, args, true);
        case "glCompressedTexImage2D": return this.compressed_tex_image(c, args);
        case "glCopyTexImage2D": return this.copy_tex_image(c, args, false);
        case "glCopyTexSubImage2D": return this.copy_tex_image(c, args, true);
        case "glGenerateMipmap": return this.generate_mipmap(c, args[0]);
        case "glEGLImageTargetTexture2D": return this.invalidate_texture(c, args[0]);
        case "glBufferData": return this.buffer_data(c, args, false);
        case "glBufferSubData": return this.buffer_data(c, args, true);
        case "glRenderbufferStorage": case "glEGLImageTargetRenderbufferStorage": return this.renderbuffer_storage(c);
        case "glVertexAttribPointerData":
            // (the client array's data, tight, from the draw's first vertex: the encoder's)
            c.attribs[args[0]].data = args[5];
            return undefined;
        case "glVertexAttribPointerOffset":
            c.attribs[args[0]].data = null;
            return undefined;
        case "glClear": return this.clear(c, args[0]);
        case "glDrawArrays": return this.draw(c, args[0], args[1], args[2], null);
        case "glDrawElementsData": return this.draw(c, args[0], 0, args[1], { type: args[2], bytes: args[3] });
        case "glDrawElementsOffset": return this.draw(c, args[0], 0, args[1], { type: args[2], offset: args[3] });
        case "glDrawTexs": case "glDrawTexi": case "glDrawTexf": return this.draw_tex(c, args);
        case "glDrawTexx": return this.draw_tex(c, args.map(v => v / 65536));
        case "glDrawTexsv": return this.draw_tex(c, Array.from(new Int16Array(args[0].slice().buffer)));
        case "glDrawTexiv": return this.draw_tex(c, Array.from(new Int32Array(args[0].slice().buffer)));
        case "glDrawTexfv": return this.draw_tex(c, Array.from(new Float32Array(args[0].slice().buffer)));
        case "glDrawTexxv": return this.draw_tex(c, Array.from(new Int32Array(args[0].slice().buffer), v => v / 65536));
    }
    return undefined;
};

// ---- textures

/** The bound texture of a target (TexImage2D's: 2D or a face) and the face's layer */
function bound(c, target)
{
    const face = target === GL.TEXTURE_2D ? 0 : target - GL.TEXTURE_CUBE_MAP_POSITIVE_X;
    const slot = target === GL.TEXTURE_2D ? 0 : target === GL.TEXTURE_EXTERNAL_OES ? 2 : 1;
    const name = c.textures[c.active_texture][slot];
    const texture = name ? c.group.textures.get(name) : c.defaults && c.defaults.get(slot === 0 ? GL.TEXTURE_2D : slot === 2 ? GL.TEXTURE_EXTERNAL_OES : GL.TEXTURE_CUBE_MAP);
    return { texture, face: face >= 0 && face < 6 ? face : 0 };
}

/**
 * A texture's GPU texture, made (again) to hold its level 0's size with a
 * full mip chain: images come one level at a time, and the levels already
 * sent are copied over when the size stays
 */
GLESExecutor.prototype.gpu_texture = function(texture)
{
    const cube = texture.target === GL.TEXTURE_CUBE_MAP;
    // (a cube map's size from whichever face's level 0 came first: dEQP gives -X before +X)
    const base = cube ? [0, 1, 2, 3, 4, 5].map(face => texture.images.get(face * 32)).find(image => image && image.width) :
        texture.images.get(0);
    if(!base || !base.width || !base.height) return null;
    const levels = Math.floor(Math.log2(Math.max(base.width, base.height))) + 1;
    const gpu = texture.gpu;
    if(gpu && gpu.width === base.width && gpu.height === base.height && gpu.cube === cube) return gpu;
    const created = this.device.createTexture({ label: "GL texture", size: [base.width, base.height, cube ? 6 : 1],
        format: COLOR_FORMAT, usage: TEXTURE_USAGE, mipLevelCount: levels });
    if(gpu && gpu.texture) this.staging.push(gpu.texture);
    texture.gpu = { texture: created, width: base.width, height: base.height, cube, levels, views: new Map(),
        destroy: () => created.destroy() };
    return texture.gpu;
};

/**
 * Where a texture's level is written: a color buffer's texture when level 0
 * is one (rcBindTexture's, an EGL image's: writes go to that color buffer,
 * as gfxstream's do), otherwise the texture's own
 * @return {?{texture: !GPUTexture, levels: number}}
 */
GLESExecutor.prototype.write_target = function(texture, level)
{
    const base = texture.images.get(0);
    if(base && (base.image || base.color_buffer))
    {
        if(level) return null;
        const t = base.image ? this.image_texture(base.image) : this.color_buffer_texture(base.color_buffer);
        return t ? { texture: t.texture, levels: 1 } : null;
    }
    const gpu = this.gpu_texture(texture);
    return gpu ? { texture: gpu.texture, levels: gpu.levels } : null;
};

GLESExecutor.prototype.invalidate_texture = function(c, target)
{
    const { texture } = bound(c, target);
    if(texture && texture.gpu && texture.gpu.texture) this.staging.push(texture.gpu.texture);
    if(texture) texture.gpu = null;
};

GLESExecutor.prototype.tex_image = function(c, args, sub)
{
    const [target, level] = args;
    const { texture, face } = bound(c, target);
    if(!texture) return;
    const image = texture.images.get(face * 32 + level);
    let x = 0, y = 0, width, height, format, type, pixels;
    if(sub) [, , x, y, width, height, format, type, pixels] = args;
    else [, , , width, height, , format, type, pixels] = args;
    if(!width || !height) return;
    const target_texture = this.write_target(texture, level);
    if(!target_texture || level >= target_texture.levels || (target_texture.texture.width >> level || 1) < x + width) return;
    void image;
    const rgba = to_rgba8(format, type, width, height, c.unpack_alignment, pixels);
    this.upload(target_texture.texture, level, face, x, y, width, height, rgba);
};

GLESExecutor.prototype.compressed_tex_image = function(c, args)
{
    const [target, level, , width, height, , , data] = args;
    const { texture, face } = bound(c, target);
    const t = texture && this.write_target(texture, level);
    if(!t || level >= t.levels) return;
    this.upload(t.texture, level, face, 0, 0, width, height, decode_etc1(width, height, data));
};

/** glCopyTex(Sub)Image2D: from what is read (the read framebuffer's color) into a level */
GLESExecutor.prototype.copy_tex_image = function(c, args, sub)
{
    const [target, level] = args;
    let xoffset = 0, yoffset = 0, x, y, width, height;
    if(sub) [, , xoffset, yoffset, x, y, width, height] = args;
    else [, , , x, y, width, height] = args;
    const { texture, face } = bound(c, target);
    const gpu = texture && this.write_target(texture, level);
    const source = this.target_of(c);
    if(!gpu || !source || !source.color || level >= gpu.levels || gpu.texture === source.color) return;
    // (the part inside the source: the rest stays undefined, as GL says)
    const sx = Math.max(0, x), sy = Math.max(0, y);
    const w = Math.min(width - (sx - x), source.width - sx), h = Math.min(height - (sy - y), source.height - sy);
    if(w <= 0 || h <= 0) return;
    this.end_pass();
    this.encoder.copyTextureToTexture({ texture: source.color, origin: [sx, sy, 0] },
        { texture: gpu.texture, mipLevel: level, origin: [xoffset + sx - x, yoffset + sy - y, face] }, [w, h, 1]);
};

GLESExecutor.prototype.generate_mipmap = function(c, target)
{
    const { texture } = bound(c, target === GL.TEXTURE_2D ? GL.TEXTURE_2D : GL.TEXTURE_CUBE_MAP);
    const gpu = texture && this.gpu_texture(texture);
    if(!gpu) return;
    this.end_pass();
    for(let face = 0; face < (gpu.cube ? 6 : 1); face++)
    {
        for(let level = 1; level < gpu.levels; level++)
        {
            const view = l => gpu.texture.createView({ dimension: "2d", baseMipLevel: l, mipLevelCount: 1, baseArrayLayer: face, arrayLayerCount: 1 });
            this.blit_into(view(level - 1), view(level), false, true);
        }
    }
};

/**
 * Pixels into a texture's level and layer, in order with the draws: a
 * staging buffer copied in the encoder
 */
GLESExecutor.prototype.upload = function(texture, level, layer, x, y, width, height, rgba)
{
    this.end_pass();
    const stride = Math.ceil(width * 4 / 256) * 256;
    const staging = this.device.createBuffer({ label: "GLES upload", size: stride * height, usage: B.COPY_SRC, mappedAtCreation: true });
    const mapped = new Uint8Array(staging.getMappedRange());
    for(let row = 0; row < height; row++) mapped.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), row * stride);
    staging.unmap();
    this.encoder.copyBufferToTexture({ buffer: staging, bytesPerRow: stride, rowsPerImage: height },
        { texture, mipLevel: level, origin: [x, y, layer] }, [width, height, 1]);
    this.staging.push(staging);
    this.stats.uploads++;
};

GLESExecutor.prototype.clear_texture = function(texture, rgba)
{
    this.end_pass();
    const pass = this.encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: "clear",
        clearValue: { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] }, storeOp: "store" }] });
    pass.end();
};

// ---- buffers and renderbuffers

GLESExecutor.prototype.buffer_data = function(c, args, sub)
{
    const target = args[0];
    const name = target === GL.ARRAY_BUFFER ? c.array_buffer : c.element_array_buffer;
    const buffer = c.group.buffers.get(name);
    if(!buffer) return;
    if(!sub)
    {
        const [, size, data] = args;
        buffer.data = new Uint8Array(size);
        if(data) buffer.data.set(data.subarray(0, size));
        return;
    }
    const [, offset, size, data] = args;
    if(!buffer.data) buffer.data = new Uint8Array(buffer.size);
    if(data) buffer.data.set(data.subarray(0, size), offset);
};

GLESExecutor.prototype.renderbuffer_storage = function(c)
{
    const rb = c.group.renderbuffers.get(c.renderbuffer);
    if(!rb) return;
    if(rb.gpu) this.staging.push(rb.gpu);
    rb.gpu = null;
    if(!rb.width || !rb.height) return;
    const format = DEPTH_FORMATS[rb.format] || COLOR_FORMAT;
    const texture = this.device.createTexture({ label: "GL renderbuffer", size: [rb.width, rb.height], format,
        usage: U.RENDER_ATTACHMENT | U.COPY_SRC | U.COPY_DST | (format === COLOR_FORMAT ? U.TEXTURE_BINDING : 0) });
    rb.gpu = { texture, format, destroy: () => texture.destroy() };
};

// ---- what is drawn to

/**
 * The context's framebuffer as WebGPU attachments: color, depth-stencil,
 * size; null when there is nothing to draw to
 * @return {?{color: ?GPUTexture, color_view: ?GPUTextureView, depth: ?GPUTextureView, depth_format: string, width: number, height: number, key: string, alpha: boolean}}
 */
GLESExecutor.prototype.target_of = function(c)
{
    if(!c.framebuffer) return this.surface_target(c);
    const fbo = c.framebuffers.get(c.framebuffer);
    const view_of = a =>
    {
        if(!a) return null;
        if(a.type === GL.RENDERBUFFER)
        {
            const rb = c.group.renderbuffers.get(a.name);
            if(rb && rb.image) return this.image_texture(rb.image);
            return rb && rb.gpu ? { texture: rb.gpu.texture, format: rb.gpu.format, layer: 0, level: 0 } : null;
        }
        const texture = c.group.textures.get(a.name);
        const image = texture && texture.images.get(a.face * 32 + a.level);
        if(image && image.image) return this.image_texture(image.image);
        if(image && image.color_buffer) return this.color_buffer_texture(image.color_buffer);
        const gpu = texture && this.gpu_texture(texture);
        return gpu ? { texture: gpu.texture, format: COLOR_FORMAT, layer: a.face, level: a.level } : null;
    };
    const color = view_of(fbo.attachments.get(GL.COLOR_ATTACHMENT0));
    const depth = view_of(fbo.attachments.get(GL.DEPTH_ATTACHMENT)) || view_of(fbo.attachments.get(GL.STENCIL_ATTACHMENT));
    const any = color || depth;
    if(!any) return null;
    const view = t => t.texture.createView({ dimension: "2d", baseMipLevel: t.level, mipLevelCount: 1, baseArrayLayer: t.layer, arrayLayerCount: 1 });
    const width = Math.max(1, any.texture.width >> any.level), height = Math.max(1, any.texture.height >> any.level);
    return { color: color ? color.texture : null, color_view: color ? view(color) : null, depth: depth ? view(depth) : null,
        depth_format: depth ? depth.format : "", width, height, alpha: true,
        key: "f" + (color ? this.id_of(color.texture) + ":" + color.level + ":" + color.layer : "-") + "/" + (depth ? this.id_of(depth.texture) : "-") };
};

/** The context's window surface as a target_of's */
GLESExecutor.prototype.surface_target = function(c)
{
    const surface = c.surface && [...this.surfaces.values()].find(s => s.width === c.surface.width && s.height === c.surface.height &&
        CONFIGS[s.config] === c.surface.config && this.current_surface_of(c) === s);
    const s = surface || this.current_surface_of(c);
    if(!s) return null;
    this.surface_textures(s);
    return { color: s.texture, color_view: s.view, depth: s.depth_view, depth_format: s.depth_format, depth_texture: s.depth, width: s.width,
        height: s.height, key: "s" + s.id, alpha: CONFIGS[s.config][CONFIG_ATTRIBUTES.indexOf(EGL.ALPHA_SIZE)] > 0 };
};

/** A stable id of a GPU object (pass and bind group keys) */
GLESExecutor.prototype.id_of = function(object)
{
    this.ids = this.ids || new WeakMap();
    let id = this.ids.get(object);
    if(!id) this.ids.set(object, id = (this.next_id = (this.next_id || 0) + 1));
    return id;
};

/** The window surface a context draws to: the one its connection made current */
GLESExecutor.prototype.current_surface_of = function(c)
{
    for(const conn of this.conns.values())
    {
        if(this.shadow.context(conn.context) === c) return this.surfaces.get(conn.draw) || null;
    }
    return null;
};

/** A window surface's own color and depth textures (made at first use) */
GLESExecutor.prototype.surface_textures = function(s)
{
    if(s.texture) return;
    const config = CONFIGS[s.config];
    s.id = s.id || this.id_of(s);
    s.texture = this.device.createTexture({ label: "window surface", size: [s.width, s.height], format: COLOR_FORMAT, usage: TEXTURE_USAGE });
    s.view = s.texture.createView();
    const depth = config[CONFIG_ATTRIBUTES.indexOf(EGL.DEPTH_SIZE)], stencil = config[CONFIG_ATTRIBUTES.indexOf(EGL.STENCIL_SIZE)];
    s.depth_format = stencil ? "depth24plus-stencil8" : depth ? "depth24plus" : "";
    if(s.depth_format)
    {
        s.depth = this.device.createTexture({ label: "window depth", size: [s.width, s.height], format: s.depth_format, usage: U.RENDER_ATTACHMENT });
        s.depth_view = s.depth.createView();
    }
    // (no alpha bits: alpha reads 1)
    this.clear_texture(s.texture, [0, 0, 0, config[CONFIG_ATTRIBUTES.indexOf(EGL.ALPHA_SIZE)] ? 0 : 1]);
};

/** An EGL image's texture: its color buffer's */
GLESExecutor.prototype.image_texture = function(image)
{
    const object = this.rc.images.get(image);
    return object ? this.color_buffer_texture(object.buffer) : null;
};

GLESExecutor.prototype.color_buffer_texture = function(handle)
{
    const cb = this.rc.color_buffers.get(handle);
    return cb ? { texture: cb.texture, format: COLOR_FORMAT, layer: 0, level: 0 } : null;
};

/** The render pass on the context's target (the one open, if it is the same) */
GLESExecutor.prototype.begin_pass = function(target, clear)
{
    if(this.pass && this.pass_target === target.key && !clear) return this.pass;
    this.end_pass();
    const color = target.color_view ? [{ view: target.color_view, loadOp: clear && clear.color ? "clear" : "load", storeOp: "store",
        clearValue: clear && clear.color ? { r: clear.color[0], g: clear.color[1], b: clear.color[2], a: clear.color[3] } : undefined }] : [];
    const descriptor = { label: "GLES pass", colorAttachments: color };
    if(target.depth)
    {
        const has_depth = target.depth_format !== "stencil8", has_stencil = target.depth_format.includes("stencil");
        descriptor.depthStencilAttachment = Object.assign({ view: target.depth },
            has_depth ? { depthLoadOp: clear && clear.depth !== undefined ? "clear" : "load", depthStoreOp: "store", depthClearValue: clear ? clear.depth : 1 } : {},
            has_stencil ? { stencilLoadOp: clear && clear.stencil !== undefined ? "clear" : "load", stencilStoreOp: "store", stencilClearValue: clear ? clear.stencil : 0 } : {});
    }
    this.pass = this.encoder.beginRenderPass(descriptor);
    this.pass_target = target.key;
    return this.pass;
};

GLESExecutor.prototype.end_pass = function()
{
    if(!this.pass) return;
    this.pass.end();
    this.pass = null;
    this.pass_target = null;
};

// ---- clears

GLESExecutor.prototype.clear = function(c, mask)
{
    const target = this.target_of(c);
    if(!target) return;
    const scissor = c.enabled.has(0x0C11) && !(c.scissor[0] <= 0 && c.scissor[1] <= 0 && c.scissor[0] + c.scissor[2] >= target.width &&
        c.scissor[1] + c.scissor[3] >= target.height);
    const full_color = c.color_mask.every(Boolean) && (target.alpha || true);
    const want = { color: mask & 0x4000 && target.color_view, depth: mask & 0x0100 && target.depth && target.depth_format !== "stencil8",
        stencil: mask & 0x0400 && target.depth && target.depth_format.includes("stencil") };
    // (the whole target, all channels: the pass's clear)
    const simple = !scissor && (!want.color || full_color) && (!want.depth || c.depth_mask) && (!want.stencil || (c.stencil_writemask[0] & 0xFF) === 0xFF);
    if(simple)
    {
        const color = c.clear_color.slice();
        if(!target.alpha) color[3] = 1;
        this.begin_pass(target, { color: want.color ? color : null, depth: want.depth ? c.clear_depth : undefined, stencil: want.stencil ? c.clear_stencil & 0xFF : undefined });
        return;
    }
    this.clear_quad(c, target, want);
};

/** A clear that is a quad: the scissor and the masks apply */
GLESExecutor.prototype.clear_quad = function(c, target, want)
{
    const key = ["clear", target.color_view ? COLOR_FORMAT : "-", target.depth_format, want.color ? c.color_mask.join("") : "0000",
        want.depth ? 1 : 0, want.stencil ? c.stencil_writemask[0] & 0xFF : 0].join("|");
    let pipeline = this.pipelines.get(key);
    if(!pipeline)
    {
        const module = this.device.createShaderModule({ code: `
            @group(0) @binding(0) var<uniform> u : vec4<f32>;
            @group(0) @binding(1) var<uniform> d : vec4<f32>;
            @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
                let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
                return vec4<f32>(p[i], d.x, 1.0);
            }
            @fragment fn fs() -> @location(0) vec4<f32> { return u; }` });
        const descriptor = {
            label: "GLES clear", layout: "auto",
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: target.color_view ? [{ format: COLOR_FORMAT,
                writeMask: want.color ? (c.color_mask[0] ? 1 : 0) | (c.color_mask[1] ? 2 : 0) | (c.color_mask[2] ? 4 : 0) | (c.color_mask[3] ? 8 : 0) : 0 }] : [] },
            primitive: { topology: "triangle-list" },
        };
        if(target.depth)
        {
            const stencil = target.depth_format.includes("stencil");
            descriptor.depthStencil = Object.assign({ format: target.depth_format },
                target.depth_format !== "stencil8" ? { depthWriteEnabled: !!want.depth, depthCompare: "always" } : {},
                stencil ? { stencilFront: { compare: "always", passOp: "replace" }, stencilBack: { compare: "always", passOp: "replace" },
                    stencilWriteMask: want.stencil ? c.stencil_writemask[0] & 0xFF : 0 } : {});
        }
        pipeline = this.device.createRenderPipeline(descriptor);
        this.pipelines.set(key, pipeline);
    }
    const pass = this.begin_pass(target, null);
    const uniforms = new Float32Array([...c.clear_color, c.clear_depth * 2 - 1, 0, 0, 0]);
    if(!target.alpha) uniforms[3] = 1;
    const buffer = this.device.createBuffer({ size: 256 + 16, usage: B.UNIFORM, mappedAtCreation: true });
    const mapped = new Float32Array(buffer.getMappedRange());
    mapped.set(uniforms.subarray(0, 4), 0);
    mapped.set(uniforms.subarray(4, 8), 64);
    buffer.unmap();
    this.staging.push(buffer);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer, offset: 0, size: 16 } }, { binding: 1, resource: { buffer, offset: 256, size: 16 } }] }));
    this.apply_scissor(pass, c, target);
    pass.setViewport(0, 0, target.width, target.height, 0, 1);
    if(want.stencil) pass.setStencilReference(c.clear_stencil & 0xFF);
    pass.draw(3);
};

GLESExecutor.prototype.apply_scissor = function(pass, c, target)
{
    let [x, y, w, h] = c.enabled.has(0x0C11) ? c.scissor : [0, 0, target.width, target.height];
    const x0 = Math.max(0, Math.min(target.width, x)), y0 = Math.max(0, Math.min(target.height, y));
    const x1 = Math.max(x0, Math.min(target.width, x + w)), y1 = Math.max(y0, Math.min(target.height, y + h));
    pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
    return x1 > x0 && y1 > y0;
};

// ---- draws

/**
 * A draw: vertices assembled on the CPU, the program's pipeline for the
 * state, its uniforms and textures
 * @param {?{type: number, bytes: (Uint8Array|undefined), offset: (number|undefined)}} elements
 */
GLESExecutor.prototype.draw = function(c, mode, first, count, elements)
{
    if(!count) return;
    const program = c.api === 1 ? null : c.group.objects.get(c.program);
    if(c.api !== 1 && (!program || !program.info || !program.info.ok)) return;
    if(c.enabled.has(0x0B44) && c.cull_face === 0x0408 && mode >= GL.TRIANGLES) return;
    const target = this.target_of(c);
    if(!target) return;
    // the indices (u32, from 0 for the vertices assembled) and the vertex range
    let indices = null, low = first, high = first + count - 1;
    if(elements)
    {
        const source = elements.bytes || (c.group.buffers.get(c.element_array_buffer) || {}).data;
        if(!source) return;
        const size = elements.type === GL.UNSIGNED_BYTE ? 1 : elements.type === GL.UNSIGNED_SHORT ? 2 : 4;
        const offset = elements.bytes ? 0 : elements.offset;
        if(offset + count * size > source.length) return;
        const view = new DataView(source.buffer, source.byteOffset + offset, count * size);
        indices = new Uint32Array(count);
        low = Infinity; high = 0;
        for(let i = 0; i < count; i++)
        {
            const v = size === 1 ? view.getUint8(i) : size === 2 ? view.getUint16(2 * i, true) : view.getUint32(4 * i, true);
            indices[i] = v;
            if(v < low) low = v;
            if(v > high) high = v;
        }
    }
    const vertices = high - low + 1;
    if(vertices <= 0 || vertices > 1 << 24) return;
    // (fans and loops as lists and strips; strips with indices keep u32, which never restarts)
    // (points: WebGPU's, one pixel each; gl_PointSize and glPointSize are not applied, gpu-deviations.md)
    let topology = { [GL.POINTS]: "point-list", [GL.LINES]: "line-list", [GL.LINE_STRIP]: "line-strip", [GL.LINE_LOOP]: "line-strip", [GL.TRIANGLES]: "triangle-list",
        [GL.TRIANGLE_STRIP]: "triangle-strip", [GL.TRIANGLE_FAN]: "triangle-list" }[mode];
    let list = indices ? Array.from(indices, v => v - low) : null;
    if(mode === GL.TRIANGLE_FAN || mode === GL.LINE_LOOP)
    {
        const order = list || Array.from({ length: count }, (_, i) => i);
        if(mode === GL.TRIANGLE_FAN)
        {
            list = [];
            for(let i = 1; i + 1 < order.length; i++) list.push(order[0], order[i], order[i + 1]);
        }
        else list = [...order, order[0]];
    }
    const index_count = list ? list.length : count;
    if(!index_count) return;
    // (GLES 1.1: the fixed function's shaders for the state; GLES 2.0: the program's)
    const ff = c.api === 1 ? this.ff_shaders(c, mode === GL.POINTS) : null;
    const shaders = ff ? ff.shaders : this.program_shaders(program);
    if(!shaders) return;
    const layout = ff ? this.ff_layout(c, ff.generated, low, vertices) : this.vertex_layout(c, program, low, vertices);
    if(!layout) return;
    const [vx, vy, vw, vh] = c.viewport;
    if(vw <= 0 || vh <= 0) return;
    let index_buffer = null;
    if(list)
    {
        const data = new Uint32Array(list);
        index_buffer = this.device.createBuffer({ size: align4(data.byteLength), usage: B.INDEX, mappedAtCreation: true });
        new Uint32Array(index_buffer.getMappedRange()).set(data);
        index_buffer.unmap();
        this.staging.push(index_buffer);
    }
    for(const face of this.stencil_faces(c, target, mode))
    {
        const pipeline = this.pipeline(c, program, shaders, layout, topology, target, !!list, face);
        if(!pipeline) return;
        const pass = this.begin_pass(target, null);
        pass.setPipeline(pipeline);
        const groups = ff ? this.ff_bind_groups(c, ff, pipeline, target, c.viewport) : this.bind_groups(c, program, shaders, pipeline, target);
        for(const [index, group] of groups) pass.setBindGroup(index, group);
        layout.buffers.forEach((buffer, slot) => pass.setVertexBuffer(slot, buffer));
        pass.setViewport(vx, vy, vw, vh, Math.min(c.depth_range[0], c.depth_range[1]), Math.max(c.depth_range[0], c.depth_range[1]));
        if(!this.apply_scissor(pass, c, target)) return;
        pass.setBlendConstant(c.blend_func.some(f => f === 0x8003 || f === 0x8004) ?
            { r: c.blend_color[3], g: c.blend_color[3], b: c.blend_color[3], a: c.blend_color[3] } :
            { r: c.blend_color[0], g: c.blend_color[1], b: c.blend_color[2], a: c.blend_color[3] });
        if(c.enabled.has(0x0B90)) pass.setStencilReference(c.stencil_func[face === undefined ? 0 : face][1] & 0xFF);
        if(index_buffer)
        {
            pass.setIndexBuffer(index_buffer, "uint32");
            pass.drawIndexed(index_count);
        }
        else pass.draw(count);
    }
    this.stats.draws++;
};

/**
 * The faces a draw is made of for the stencil test: WebGPU has one
 * reference and one pair of masks for both faces, GL each face its own;
 * when they differ, a draw of triangles goes twice, culled to each face,
 * with that face's (undefined: one draw, the front face's, as for points
 * and lines, which are front-facing)
 * @return {!Array<(number|undefined)>} 0 the front faces, 1 the back faces
 */
GLESExecutor.prototype.stencil_faces = function(c, target, mode)
{
    if(!c.enabled.has(0x0B90) || !target.depth || !target.depth_format.includes("stencil") || mode < GL.TRIANGLES) return [undefined];
    const same = c.stencil_func[0][1] === c.stencil_func[1][1] && c.stencil_func[0][2] === c.stencil_func[1][2] &&
        c.stencil_writemask[0] === c.stencil_writemask[1];
    if(same) return [undefined];
    // (culling leaves one face: its own state)
    if(c.enabled.has(0x0B44)) return c.cull_face === 0x0404 ? [1] : [0];
    return [0, 1];
};

/**
 * GLES 1.1: gl-webgpu's fixed-function shaders for the context's state (and
 * the draw_texture rectangle's: no lighting, fog or matrices), cached by
 * their signature
 */
GLESExecutor.prototype.ff_shaders = function(c, rectangle)
{
    const textures = Array.from({ length: UNITS }, (_, i) => unit_texture(c, i));
    const signature = ff_signature(c, false, textures);
    if(rectangle)
    {
        signature.lighting = { enabled: false, lights: [] };
        signature.fog = { enabled: false };
        signature.attributes.normal = false;
        signature.attributes.position = { components: 4 };
        signature.clipPlaneCount = 0;
        signature.texture.forEach(t => { if(t.enabled) t.matrix = false; });
    }
    const FF = globalThis["GLFixedFunction"];
    const key = FF.signatureKey(signature);
    this.ff_cache = this.ff_cache || new Map();
    let entry = this.ff_cache.get(key);
    if(!entry)
    {
        const generated = FF.generate(signature);
        const module = code =>
        {
            let m = this.shaders.get(code);
            if(!m) this.shaders.set(code, m = this.device.createShaderModule({ label: "GLES 1.1 fixed function", code }));
            return m;
        };
        const bindings = new Set();
        reachable_bindings(generated.wgslVertex, "vs_main", bindings);
        reachable_bindings(generated.wgslFragment, "fs_main", bindings);
        entry = { generated, shaders: { vertex: module(generated.wgslVertex), fragment: module(generated.wgslFragment), bindings } };
        this.ff_cache.set(key, entry);
    }
    return { generated: entry.generated, shaders: entry.shaders, textures };
};

/** A fixed-function draw's vertex buffers: each input from its client array or its current value */
GLESExecutor.prototype.ff_layout = function(c, generated, low, vertices)
{
    const buffers = [], formats = [];
    for(const input of ff_inputs(c, generated.attributes))
    {
        const a = input.array;
        let values;
        if(a.enabled) values = this.attribute_values(c, Object.assign({}, a, { normalized: input.normalized && a.type !== GL.FLOAT && a.type !== GL.FIXED }),
            low, vertices, input.components);
        else values = new Float32Array([...input.current, 0, 0, 0, 1].slice(0, input.components).map((v, i) => i < input.current.length ? v : i === 3 ? 1 : 0));
        if(!values) return null;
        const buffer = this.device.createBuffer({ size: align4(Math.max(4, values.byteLength)), usage: B.VERTEX, mappedAtCreation: true });
        new Float32Array(buffer.getMappedRange()).set(values);
        buffer.unmap();
        this.staging.push(buffer);
        buffers.push(buffer);
        formats.push({ location: input.location, components: input.components, stride: a.enabled ? input.components * 4 : 0 });
    }
    return { buffers, formats, key: "ff:" + formats.map(f => f.location + ":" + f.components + ":" + f.stride).join(",") };
};

/** A fixed-function draw's bind groups: the GL state block (group 1), the units' textures (group 2) */
GLESExecutor.prototype.ff_bind_groups = function(c, ff, pipeline, target, viewport, snapshot)
{
    const groups = [];
    const generated = ff.generated;
    if(ff.shaders.bindings.has("1:0"))
    {
        const layout = globalThis["GLStateLayout"].buildLayout(generated.stateFields);
        const floats = new Float32Array(Math.max(4, layout.floats));
        globalThis["GLStateLayout"].writeLayout(layout, snapshot || ff_snapshot(c, viewport), floats, 0);
        groups.push([1, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: { buffer: this.uniform_buffer(floats.buffer) } }] })]);
    }
    const entries = [];
    for(const t of generated.textures)
    {
        const texture = ff.textures[t.unit];
        if(ff.shaders.bindings.has("2:" + t.textureBinding)) entries.push({ binding: t.textureBinding, resource: this.texture_view(texture, false, target.color) });
        if(ff.shaders.bindings.has("2:" + t.samplerBinding)) entries.push({ binding: t.samplerBinding, resource: this.sampler(texture) });
    }
    if(entries.length) groups.push([2, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(2), entries })]);
    return groups;
};

/**
 * glDrawTex*OES: a rectangle at window coordinates (x, y) of width by
 * height, at depth z (0 to 1, in the depth range), each enabled unit's
 * texture by its crop rectangle, the current color; no lighting, fog,
 * matrices or viewport
 */
GLESExecutor.prototype.draw_tex = function(c, [x, y, z, w, h])
{
    if(c.api !== 1 || !(w > 0) || !(h > 0)) return;
    const target = this.target_of(c);
    if(!target) return;
    const ff = this.ff_shaders(c, true);
    const W = target.width, H = target.height;
    const zw = c.depth_range[0] + Math.min(1, Math.max(0, z)) * (c.depth_range[1] - c.depth_range[0]);
    const ndc_z = zw * 2 - 1;
    const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y], [x + w, y + h], [x, y + h]];
    const values = new Map();
    for(const a of ff.generated.attributes)
    {
        if(a.name === "position") values.set(a.location, corners.flatMap(([px, py]) => [px / W * 2 - 1, py / H * 2 - 1, ndc_z, 1]));
        else if(a.name === "color") values.set(a.location, corners.flatMap(() => c.ff.color));
        else if(a.name.startsWith("texCoord"))
        {
            const texture = ff.textures[+a.name.slice(8)];
            const base = texture && texture.images.get(0);
            const [u, v, cw, ch] = texture ? texture.crop : [0, 0, 1, 1];
            const tw = base ? base.width : 1, th = base ? base.height : 1;
            values.set(a.location, corners.flatMap(([px, py]) => [(u + (px - x) / w * cw) / tw, (v + (py - y) / h * ch) / th, 0, 1].slice(0, a.components)));
        }
        else values.set(a.location, corners.flatMap(() => new Array(a.components).fill(0)));
    }
    const buffers = [], formats = [];
    for(const a of ff.generated.attributes)
    {
        const data = new Float32Array(values.get(a.location));
        const buffer = this.device.createBuffer({ size: align4(data.byteLength), usage: B.VERTEX, mappedAtCreation: true });
        new Float32Array(buffer.getMappedRange()).set(data);
        buffer.unmap();
        this.staging.push(buffer);
        buffers.push(buffer);
        formats.push({ location: a.location, components: a.components, stride: a.components * 4 });
    }
    const layout = { buffers, formats, key: "tex:" + formats.map(f => f.location + ":" + f.components).join(",") };
    const pipeline = this.pipeline(c, null, ff.shaders, layout, "triangle-list", target, false);
    if(!pipeline) return;
    const pass = this.begin_pass(target, null);
    pass.setPipeline(pipeline);
    const snapshot = ff_snapshot(c, [0, 0, W, H]);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    Object.assign(snapshot.matrices, { modelview: identity, projection: identity, mvp: identity });
    snapshot.depthRange = { near: 0, far: 1 };
    for(const [index, group] of this.ff_bind_groups(c, ff, pipeline, target, [0, 0, W, H], snapshot)) pass.setBindGroup(index, group);
    buffers.forEach((buffer, slot) => pass.setVertexBuffer(slot, buffer));
    pass.setViewport(0, 0, W, H, 0, 1);
    if(!this.apply_scissor(pass, c, target)) return;
    if(c.enabled.has(0x0B90)) pass.setStencilReference(c.stencil_func[0][1] & 0xFF);
    pass.draw(6);
    this.stats.draws++;
};

/** The program's WGSL as shader modules (linked by the shadow state) */
GLESExecutor.prototype.program_shaders = function(program)
{
    const info = program.info;
    if(info.gpu) return info.gpu;
    if(!info.wgsl) return null;
    const module = code =>
    {
        let m = this.shaders.get(code);
        if(!m) this.shaders.set(code, m = this.device.createShaderModule({ label: "GLES program", code }));
        return m;
    };
    const bindings = new Set();
    reachable_bindings(info.wgsl.vertex, "vs_main", bindings);
    reachable_bindings(info.wgsl.fragment, "fs_main", bindings);
    info.gpu = { vertex: module(info.wgsl.vertex), fragment: module(info.wgsl.fragment), bindings };
    return info.gpu;
};

/**
 * The draw's vertex buffers: each active attribute's values for the vertex
 * range, from its array (client data or a buffer) or its current value,
 * as f32 (or the format WebGPU reads directly)
 * @return {?{buffers: !Array<!GPUBuffer>, formats: !Array<!Object>, key: string}}
 */
GLESExecutor.prototype.vertex_layout = function(c, program, low, vertices)
{
    const buffers = [], formats = [];
    for(const attribute of program.info.reflection.attributes)
    {
        for(let slot = 0; slot < attribute.slots; slot++)
        {
            const location = attribute.location + slot;
            const a = c.attribs[location];
            const components = attribute.slots > 1 ? attribute.components / attribute.slots : attribute.components;
            let values;
            if(a.enabled)
            {
                values = this.attribute_values(c, a, low, vertices, components);
                if(!values) return null;
            }
            else values = new Float32Array(a.current.slice(0, components));
            const buffer = this.device.createBuffer({ size: align4(Math.max(4, values.byteLength)), usage: B.VERTEX, mappedAtCreation: true });
            new Float32Array(buffer.getMappedRange()).set(values);
            buffer.unmap();
            this.staging.push(buffer);
            buffers.push(buffer);
            formats.push({ location, components, stride: a.enabled ? components * 4 : 0 });
        }
    }
    return { buffers, formats, key: formats.map(f => f.location + ":" + f.components + ":" + f.stride).join(",") };
};

/** An enabled attribute's values for the vertex range, as f32 (`components` each: missing ones 0, w 1) */
GLESExecutor.prototype.attribute_values = function(c, a, low, vertices, components)
{
    const type_bytes = TYPE_BYTES[a.type];
    const element = a.size * type_bytes;
    let source, base, stride;
    if(a.data)
    {
        // (client data: tight, element 0 the draw's first: low is 0 for those draws)
        source = a.data;
        stride = element;
        base = low * element;
    }
    else
    {
        const buffer = c.group.buffers.get(a.buffer);
        if(!buffer || !buffer.data) return null;
        source = buffer.data;
        stride = a.stride || element;
        base = a.offset + low * stride;
    }
    const out = new Float32Array(vertices * components);
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    const normalized = a.normalized;
    for(let v = 0; v < vertices; v++)
    {
        const at = base + v * stride;
        for(let i = 0; i < components; i++)
        {
            let value = i === 3 ? 1 : 0;
            if(i < a.size && at + (i + 1) * type_bytes <= source.length)
            {
                const p = at + i * type_bytes;
                switch(a.type)
                {
                    case GL.FLOAT: value = view.getFloat32(p, true); break;
                    case GL.FIXED: value = view.getInt32(p, true) / 65536; break;
                    case GL.HALF_FLOAT_OES: value = half_to_float(view.getUint16(p, true)); break;
                    case GL.UNSIGNED_BYTE: value = view.getUint8(p); if(normalized) value /= 255; break;
                    case GL.BYTE: value = view.getInt8(p); if(normalized) value = Math.max(-1, value / 127); break;
                    case GL.UNSIGNED_SHORT: value = view.getUint16(p, true); if(normalized) value /= 65535; break;
                    case GL.SHORT: value = view.getInt16(p, true); if(normalized) value = Math.max(-1, value / 32767); break;
                }
            }
            out[v * components + i] = value;
        }
    }
    return out;
};

/** The pipeline for the program, the vertex layout, the state and the target */
GLESExecutor.prototype.pipeline = function(c, program, shaders, layout, topology, target, indexed, face)
{
    const blend = c.enabled.has(0x0BE2);
    const depth_test = c.enabled.has(0x0B71), stencil_test = c.enabled.has(0x0B90);
    // (one face's draw, stencil_faces: the other culled, that face's masks)
    const cull = face === 0 ? "back" : face === 1 ? "front" : c.enabled.has(0x0B44) ? (c.cull_face === 0x0404 ? "front" : "back") : "none";
    const masks = face === undefined ? 0 : face;
    const key = [this.id_of(shaders.vertex), this.id_of(shaders.fragment), layout.key, topology, indexed ? 1 : 0, c.front_face, cull, masks,
        target.color_view ? (target.alpha ? "a" : "x") : "-", target.depth_format,
        blend ? c.blend_func.join(",") + "/" + c.blend_equation.join(",") : "-", c.color_mask.join(""),
        depth_test ? c.depth_func + ":" + c.depth_mask : "-",
        stencil_test ? JSON.stringify([c.stencil_func, c.stencil_op, c.stencil_writemask]) : "-",
        c.enabled.has(0x8037) ? c.polygon_offset.join(",") : "-"].join("|");
    let pipeline = this.pipelines.get(key);
    if(pipeline) return pipeline;
    const write_mask = (c.color_mask[0] ? 1 : 0) | (c.color_mask[1] ? 2 : 0) | (c.color_mask[2] ? 4 : 0) | (c.color_mask[3] && target.alpha ? 8 : 0);
    const descriptor = {
        label: "GLES pipeline", layout: "auto",
        vertex: { module: shaders.vertex, entryPoint: "vs_main", buffers: layout.formats.map(f => ({
            arrayStride: f.stride, stepMode: "vertex",
            attributes: [{ shaderLocation: f.location, offset: 0, format: f.components === 1 ? "float32" : "float32x" + f.components }],
        })) },
        fragment: { module: shaders.fragment, entryPoint: "fs_main", targets: target.color_view ? [{ format: COLOR_FORMAT, writeMask: write_mask,
            blend: blend ? {
                color: blend_component(c.blend_equation[0], c.blend_func[0], c.blend_func[1]),
                alpha: blend_component(c.blend_equation[1], c.blend_func[2], c.blend_func[3]),
            } : undefined }] : [] },
        // (the translator's Y flip reverses the winding: GL's CCW is WebGPU's CW)
        primitive: { topology, frontFace: c.front_face === 0x0901 ? "cw" : "ccw", cullMode: cull,
            ...(indexed && topology.endsWith("strip") ? { stripIndexFormat: "uint32" } : {}) },
    };
    if(target.depth)
    {
        const stencil = target.depth_format.includes("stencil");
        const face_state = i => ({ compare: COMPARE[c.stencil_func[i][0]], failOp: STENCIL_OPS[c.stencil_op[i][0]],
            depthFailOp: STENCIL_OPS[c.stencil_op[i][1]], passOp: STENCIL_OPS[c.stencil_op[i][2]] });
        descriptor.depthStencil = Object.assign({ format: target.depth_format },
            target.depth_format !== "stencil8" ? { depthWriteEnabled: depth_test && !!c.depth_mask, depthCompare: depth_test ? COMPARE[c.depth_func] : "always" } : {},
            stencil && stencil_test ? { stencilFront: face_state(0), stencilBack: face_state(1), stencilReadMask: c.stencil_func[masks][2] & 0xFF,
                stencilWriteMask: c.stencil_writemask[masks] & 0xFF } : {},
            c.enabled.has(0x8037) && target.depth_format !== "stencil8" ? { depthBias: Math.round(c.polygon_offset[1]), depthBiasSlopeScale: c.polygon_offset[0] } : {});
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
};

/** The draw's bind groups: the GL state block and the uniforms (group 1), the textures (group 2) */
GLESExecutor.prototype.bind_groups = function(c, program, shaders, pipeline, target)
{
    const reflection = program.info.reflection;
    const groups = [];
    const active = shaders.bindings;
    const group1 = [];
    if(active.has("1:0"))
    {
        const layout = globalThis["GLStateLayout"].buildLayout(reflection.stateFields);
        const floats = new Float32Array(Math.max(4, layout.floats));
        globalThis["GLStateLayout"].writeLayout(layout, { depthRange: { near: c.depth_range[0], far: c.depth_range[1] },
            viewport: { x: c.viewport[0], y: c.viewport[1], width: c.viewport[2], height: c.viewport[3] },
            point: { size: 1, sizeMin: 1, sizeMax: 256, fadeThreshold: 1, attenuation: [1, 0, 0] } }, floats, 0);
        group1.push({ binding: 0, resource: { buffer: this.uniform_buffer(floats.buffer) } });
    }
    if(active.has("1:1"))
    {
        group1.push({ binding: 1, resource: { buffer: this.uniform_buffer(this.uniform_block(program)) } });
    }
    if(group1.length) groups.push([1, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: group1 })]);
    const textures = [];
    for(const sampler of reflection.samplers)
    {
        const count = Math.max(1, sampler.arraySize);
        for(let i = 0; i < count; i++)
        {
            const values = program.values.get(sampler.location + i);
            const unit = Math.max(0, Math.min(31, values ? values[0] : 0));
            const slot = sampler.external ? 2 : sampler.dim === "Cube" ? 1 : 0;
            const name = c.textures[unit][slot];
            const texture = name ? c.group.textures.get(name) : null;
            // (a texture drawn to while it is sampled: GL's feedback loop is undefined, WebGPU refuses it; it samples as black)
            const view = this.texture_view(texture, sampler.dim === "Cube", target.color);
            if(active.has("2:" + (sampler.binding + i * 2))) textures.push({ binding: sampler.binding + i * 2, resource: view });
            if(active.has("2:" + (sampler.binding + i * 2 + 1))) textures.push({ binding: sampler.binding + i * 2 + 1, resource: this.sampler(texture) });
        }
    }
    if(textures.length) groups.push([2, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(2), entries: textures })]);
    return groups;
};

/** A uniform buffer holding the bytes */
GLESExecutor.prototype.uniform_buffer = function(bytes)
{
    const size = Math.max(16, align4(bytes.byteLength));
    const buffer = this.device.createBuffer({ size: Math.ceil(size / 16) * 16, usage: B.UNIFORM, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(bytes));
    buffer.unmap();
    this.staging.push(buffer);
    return buffer;
};

/** The program's uniform block from the shadow's values (the reflection's offsets and strides) */
GLESExecutor.prototype.uniform_block = function(program)
{
    const reflection = program.info.reflection;
    const block = new ArrayBuffer(Math.max(16, reflection.uniformBlockBytes));
    const floats = new Float32Array(block), ints = new Int32Array(block);
    for(const u of reflection.uniforms)
    {
        const count = Math.max(1, u.arraySize);
        const stride = u.arraySize ? u.arrayStrideBytes : 0;
        for(let e = 0; e < count; e++)
        {
            const values = program.values.get(u.location + e);
            if(!values) continue;
            const base = u.offsetBytes + e * stride;
            if(u.kind === "matrix")
            {
                const column_stride = u.matrixColumnStrideBytes || (u.rows === 2 ? 8 : 16);
                for(let col = 0; col < u.columns; col++)
                {
                    for(let row = 0; row < u.rows; row++) floats[(base + col * column_stride) / 4 + row] = values[col * u.rows + row];
                }
                continue;
            }
            for(let i = 0; i < u.components; i++)
            {
                if(u.baseType === "float") floats[base / 4 + i] = values[i];
                else ints[base / 4 + i] = values[i];
            }
        }
    }
    return block;
};

/** A texture's view, or the fallback's (an incomplete texture samples as (0, 0, 0, 1)) */
GLESExecutor.prototype.texture_view = function(texture, cube, drawn_to)
{
    const fallback = () =>
    {
        if(!this.fallback)
        {
            this.fallback = this.device.createTexture({ size: [1, 1, 6], format: COLOR_FORMAT, usage: U.TEXTURE_BINDING | U.COPY_DST });
            this.device.queue.writeTexture({ texture: this.fallback }, new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
                { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 6]);
            this.fallback_views = { "2d": this.fallback.createView({ dimension: "2d", arrayLayerCount: 1 }), cube: this.fallback.createView({ dimension: "cube" }) };
        }
        return this.fallback_views[cube ? "cube" : "2d"];
    };
    if(!texture) return fallback();
    const base = texture.images.get(0);
    // (an EGL image's or a bound color buffer's: that color buffer's texture)
    if(base && (base.image || base.color_buffer))
    {
        const t = base.image ? this.image_texture(base.image) : this.color_buffer_texture(base.color_buffer);
        return t && t.texture !== drawn_to ? t.texture.createView() : fallback();
    }
    const gpu = this.gpu_texture(texture);
    if(!gpu || gpu.texture === drawn_to) return fallback();
    // (cube complete: six square faces of one size and format at level 0)
    const first = [0, 1, 2, 3, 4, 5].map(face => texture.images.get(face * 32)).find(Boolean);
    if(gpu.cube && (gpu.width !== gpu.height || [0, 1, 2, 3, 4, 5].some(face =>
    {
        const i = texture.images.get(face * 32);
        return !i || i.width !== gpu.width || i.height !== gpu.height || i.format !== first.format;
    })))
    {
        return fallback();
    }
    // completeness: a mipmapped filter needs every level
    const mipmapped = texture.min_filter !== GL.NEAREST && texture.min_filter !== GL.LINEAR;
    let levels = 1;
    if(mipmapped)
    {
        for(levels = 1; levels < gpu.levels; levels++)
        {
            const w = Math.max(1, gpu.width >> levels), h = Math.max(1, gpu.height >> levels);
            for(let face = 0; face < (gpu.cube ? 6 : 1); face++)
            {
                const image = texture.images.get(face * 32 + levels);
                // (every level of the same format as level 0's)
                if(!image || image.width !== w || image.height !== h || image.format !== first.format) return fallback();
            }
        }
    }
    const key = (cube ? "cube" : "2d") + levels;
    let view = gpu.views.get(key);
    if(!view) gpu.views.set(key, view = gpu.texture.createView({ dimension: cube ? "cube" : "2d", mipLevelCount: levels,
        ...(cube ? {} : { arrayLayerCount: 1 }) }));
    return view;
};

GLESExecutor.prototype.sampler = function(texture)
{
    const t = texture || { min_filter: GL.NEAREST, mag_filter: GL.NEAREST, wrap_s: GL.CLAMP_TO_EDGE, wrap_t: GL.CLAMP_TO_EDGE };
    const key = [t.min_filter, t.mag_filter, t.wrap_s, t.wrap_t].join("|");
    let sampler = this.samplers.get(key);
    if(!sampler)
    {
        const min_linear = t.min_filter === GL.LINEAR || t.min_filter === GL.LINEAR_MIPMAP_NEAREST || t.min_filter === GL.LINEAR_MIPMAP_LINEAR;
        const mip_linear = t.min_filter === GL.NEAREST_MIPMAP_LINEAR || t.min_filter === GL.LINEAR_MIPMAP_LINEAR;
        const mipmapped = t.min_filter !== GL.NEAREST && t.min_filter !== GL.LINEAR;
        sampler = this.device.createSampler({
            addressModeU: WRAPS[t.wrap_s] || "repeat", addressModeV: WRAPS[t.wrap_t] || "repeat",
            magFilter: t.mag_filter === GL.LINEAR ? "linear" : "nearest", minFilter: min_linear ? "linear" : "nearest",
            mipmapFilter: mip_linear ? "linear" : "nearest", lodMaxClamp: mipmapped ? 32 : 0,
        });
        this.samplers.set(key, sampler);
    }
    return sampler;
};

Object.assign(GLESExecutor.prototype, GLES3);

// ---- surfaces, posts, reads

/** A window surface's frame into its color buffer (flipped: memory order) */
GLESExecutor.prototype.flush_surface = function(id)
{
    const s = this.surfaces.get(id);
    const cb = s && this.rc.color_buffers.get(s.color_buffer);
    if(!s || !cb || !s.texture)
    {
        this.stats.flush_skipped = this.stats.flush_skipped || {};
        const why = !s ? "no surface" : !cb ? "no color buffer " + s.color_buffer : "nothing drawn";
        this.stats.flush_skipped[why] = (this.stats.flush_skipped[why] || 0) + 1;
        return;
    }
    this.stats.flushes = (this.stats.flushes || 0) + 1;
    this.end_pass();
    this.blit_into(s.view, cb.texture.createView(), true, true);
};

/**
 * A full-size copy of one view into another, drawn (sizes may differ),
 * flipped vertically or not
 */
GLESExecutor.prototype.blit_into = function(source, target, flip, linear)
{
    if(!this.blit)
    {
        const module = this.device.createShaderModule({ code: `
            struct VOut { @builtin(position) p : vec4<f32>, @location(0) uv : vec2<f32> };
            @group(0) @binding(0) var t : texture_2d<f32>;
            @group(0) @binding(1) var s : sampler;
            @group(0) @binding(2) var<uniform> flip : vec4<f32>;
            @vertex fn vs(@builtin(vertex_index) i : u32) -> VOut {
                let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
                var o : VOut;
                o.p = vec4<f32>(p[i], 0.0, 1.0);
                let uv = vec2<f32>(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
                o.uv = vec2<f32>(uv.x, select(uv.y, 1.0 - uv.y, flip.x > 0.5));
                return o;
            }
            @fragment fn fs(i : VOut) -> @location(0) vec4<f32> { return textureSampleLevel(t, s, i.uv, 0.0); }` });
        this.blit = { module, pipeline: this.device.createRenderPipeline({ label: "GLES blit", layout: "auto",
            vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: COLOR_FORMAT }] },
            primitive: { topology: "triangle-list" } }),
            linear: this.device.createSampler({ magFilter: "linear", minFilter: "linear" }), nearest: this.device.createSampler({}) };
        this.blit.flip = [0, 1].map(f =>
        {
            const buffer = this.device.createBuffer({ size: 16, usage: B.UNIFORM, mappedAtCreation: true });
            new Float32Array(buffer.getMappedRange()).set([f, 0, 0, 0]);
            buffer.unmap();
            return buffer;
        });
    }
    this.end_pass();
    const pass = this.encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }] });
    pass.setPipeline(this.blit.pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: this.blit.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: source }, { binding: 1, resource: linear ? this.blit.linear : this.blit.nearest },
        { binding: 2, resource: { buffer: this.blit.flip[flip ? 1 : 0] } }] }));
    pass.draw(3);
    pass.end();
};

/** rcFBPost: the color buffer is the screen */
GLESExecutor.prototype.post = function(handle)
{
    const cb = this.rc.color_buffers.get(handle);
    if(!cb) return;
    this.stats.posts++;
    if(this.layer)
    {
        this.end_pass();
        const layer = this.layer;
        const configuration = layer.context.getConfiguration && layer.context.getConfiguration();
        if(!configuration || configuration.format !== COLOR_FORMAT) layer.context.configure({ device: this.device, format: COLOR_FORMAT });
        layer.canvas.width = cb.width;
        layer.canvas.height = cb.height;
        this.encoder.copyTextureToTexture({ texture: cb.texture }, { texture: layer.context.getCurrentTexture() }, [cb.width, cb.height, 1]);
        layer.place(0, 0, cb.width, cb.height, true);
        return;
    }
    // (read back: the newest post wins, one read at a time)
    if(this.post_pending)
    {
        this.post_next = handle;
        return;
    }
    this.post_pending = true;
    this.read_texture(cb.texture, 0, 0, cb.width, cb.height, false, (rgba, sink) =>
    {
        this.post_pending = false;
        if(sink.frame) sink.frame(rgba, cb.width, cb.height);
    });
};

/** glReadPixels: from what the connection's context reads (row 0 GL's bottom: the target's row 0) */
GLESExecutor.prototype.read_pixels = function(record)
{
    const conn = this.conns.get(record.conn);
    const c = conn && this.shadow.context(conn.context);
    if(c && c.glslang) return this.read_pixels3(c, record);
    const target = c && this.target_of(c);
    if(!target || !target.color) return this.answer_failed(record.request);
    const x0 = Math.max(0, record.x), y0 = Math.max(0, record.y);
    const x1 = Math.min(target.width, record.x + record.width), y1 = Math.min(target.height, record.y + record.height);
    const alignment = c.pack_alignment;
    if(x1 <= x0 || y1 <= y0) return this.answer(null, record.request, new Uint8Array(0), true);
    return this.read_texture(target.color, x0, y0, x1 - x0, y1 - y0, false, (rgba, sink) =>
    {
        // (the part outside the framebuffer is left as it was: zeros here)
        const full = new Uint8Array(record.width * record.height * 4);
        const w = x1 - x0;
        for(let y = 0; y < y1 - y0; y++)
        {
            full.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), ((y + y0 - record.y) * record.width + (x0 - record.x)) * 4);
        }
        this.answer(sink, record.request, pack_rgba8(full, record.width, record.height, alignment));
    });
};

/** A rectangle of a texture copied for reading once the batch has run */
GLESExecutor.prototype.read_texture = function(texture, x, y, width, height, flip, done, mip = 0, layer = 0, texel = 4)
{
    this.end_pass();
    const stride = Math.ceil(width * texel / 256) * 256;
    const buffer = this.device.createBuffer({ size: stride * height, usage: B.COPY_DST | B.MAP_READ });
    this.encoder.copyTextureToBuffer({ texture, mipLevel: mip, origin: [x, y, layer] }, { buffer, bytesPerRow: stride, rowsPerImage: height }, [width, height, 1]);
    this.reads.push({ buffer, stride, width, height, flip, done, texel });
};

/** A read's answer: the readback header (id, length, 0, status OK), then the bytes */
GLESExecutor.prototype.answer = function(sink, request, bytes, later)
{
    const answer = new Uint8Array(READBACK_HEADER + bytes.length);
    const view = new DataView(answer.buffer);
    view.setUint32(0, request, true);
    view.setUint32(4, bytes.length, true);
    view.setUint32(12, 1, true);
    answer.set(bytes, READBACK_HEADER);
    if(later || !sink) this.reads.push({ buffer: null, done: (_, s) => s.writeResponse(0, answer), immediate: true });
    else sink.writeResponse(0, answer);
};

GLESExecutor.prototype.answer_failed = function(request)
{
    const answer = new Uint8Array(READBACK_HEADER);
    new DataView(answer.buffer).setUint32(0, request, true);
    new DataView(answer.buffer).setUint32(12, 2, true);
    this.reads.push({ buffer: null, done: (_, sink) => sink.writeResponse(0, answer), immediate: true });
};

// ---- snapshots (E5)

/** Every texture object of the shadow (the share groups' and the contexts' defaults) */
function all_textures(shadow)
{
    const textures = new Set();
    for(const group of shadow.groups.values()) for(const t of group.textures.values()) textures.add(t);
    for(const c of shadow.contexts.values()) for(const t of c.defaults ? c.defaults.values() : []) textures.add(t);
    return textures;
}

/**
 * The page's part of a snapshot (docs/gles-proxy-plan.md E5): the
 * executor's objects, and the GPU's contents read back into them (their
 * `saved`: [level, layer, width, height, RGBA]): the color buffers, the
 * window surfaces' own textures, the textures' levels, the color
 * renderbuffers; the buffers the GPU wrote (their bytes). A depth or
 * stencil buffer's contents are not kept (WebGPU cannot copy depth24plus
 * out); they read as cleared after a restore.
 * @return {!Promise<!Array<*>>} [json, buffers] (gles_snapshot.js)
 */
GLESExecutor.prototype.save = async function()
{
    const reads = [];
    const read = (owner, texture, levels, layers, width, height) =>
    {
        owner.saved = [];
        for(let level = 0; level < levels; level++)
        {
            for(let layer = 0; layer < layers; layer++)
            {
                reads.push({ owner, texture, level, layer, width: Math.max(1, width >> level), height: Math.max(1, height >> level) });
            }
        }
    };
    for(const cb of this.rc.color_buffers.values()) read(cb, cb.texture, 1, 1, cb.width, cb.height);
    for(const s of this.surfaces.values()) if(s.texture) read(s, s.texture, 1, 1, s.width, s.height);
    for(const t of all_textures(this.shadow))
    {
        // (GLES 3.x's textures, and GLES 2.0's through glslang: their own formats, layers and blocks, gles3_executor.js)
        if(t.gpu && t.gpu.es3) this.save_texture3(t, reads);
        else if(t.gpu && t.gpu.texture) read(t, t.gpu.texture, t.gpu.levels, t.gpu.cube ? 6 : 1, t.gpu.width, t.gpu.height);
    }
    for(const group of this.shadow.groups.values())
    {
        for(const rb of group.renderbuffers.values())
        {
            if(rb.gpu && rb.gpu.es3) this.save_renderbuffer3(rb, reads);
            else if(rb.gpu && rb.gpu.format === COLOR_FORMAT) read(rb, rb.gpu.texture, 1, 1, rb.width, rb.height);
        }
    }
    const encoder = this.device.createCommandEncoder({ label: "GLES save" });
    const buffer_reads = this.save_buffers3(encoder);
    for(const r of reads)
    {
        // (rows of texels, 4 bytes unless the read says: `row` bytes a row of blocks, `rows` of them)
        r.row = r.row || r.width * 4;
        r.rows = r.rows || r.height;
        r.stride = Math.ceil(r.row / 256) * 256;
        r.buffer = this.device.createBuffer({ size: r.stride * r.rows, usage: B.COPY_DST | B.MAP_READ });
        encoder.copyTextureToBuffer({ texture: r.texture, mipLevel: r.level, origin: [0, 0, r.layer] },
            { buffer: r.buffer, bytesPerRow: r.stride, rowsPerImage: r.rows }, r.extent || [r.width, r.height, 1]);
    }
    this.device.queue.submit([encoder.finish()]);
    for(const r of reads)
    {
        await r.buffer.mapAsync(globalThis.GPUMapMode ? globalThis.GPUMapMode.READ : 1);
        const mapped = new Uint8Array(r.buffer.getMappedRange());
        const rgba = new Uint8Array(r.row * r.rows);
        for(let y = 0; y < r.rows; y++) rgba.set(mapped.subarray(y * r.stride, y * r.stride + r.row), y * r.row);
        r.buffer.unmap();
        r.buffer.destroy();
        r.owner.saved.push([r.gl_level === undefined ? r.level : r.gl_level, r.layer, r.width, r.height, rgba]);
    }
    await this.saved_buffers3(buffer_reads);
    const state = { shadow: this.shadow.get_state(), rc: this.rc, conns: this.conns, surfaces: this.surfaces, posted: this.posted };
    // (the GPU's objects are left out: instances of no class the packing knows, and the textures' "gpu")
    const packed = pack(state, { classes: SHADOW_CLASSES, skip: shadow_skip });
    for(const r of reads)
    {
        delete r.owner.saved;
        delete r.owner.saved3;
    }
    return packed;
};

/**
 * A snapshot's page state on this executor (after a reset): the objects
 * back, their GPU textures made again with the contents saved
 * @param {!Array<*>} packed save's
 */
GLESExecutor.prototype.restore = function(packed)
{
    this.reset();
    const state = unpack(packed, SHADOW_CLASSES);
    this.rc.images = state.rc.images;
    this.rc.color_buffers = state.rc.color_buffers;
    this.shadow.set_state(state.shadow);
    this.conns = state.conns;
    this.surfaces = state.surfaces;
    this.posted = state.posted;
    this.encoder = this.device.createCommandEncoder({ label: "GLES restore" });
    this.staging = [];
    const put = (owner, texture) =>
    {
        for(const [level, layer, width, height, rgba] of owner.saved || []) this.upload(texture, level, layer, 0, 0, width, height, rgba);
        delete owner.saved;
    };
    for(const [handle, cb] of this.rc.color_buffers)
    {
        cb.texture = this.device.createTexture({ label: "color buffer " + handle, size: [cb.width, cb.height], format: COLOR_FORMAT, usage: TEXTURE_USAGE });
        if(cb.saved) put(cb, cb.texture);
        else if(cb.format === GL.RGB) this.clear_texture(cb.texture, [0, 0, 0, 1]);
    }
    for(const s of this.surfaces.values())
    {
        // (a surface drawn to before had its textures: made again, its picture back)
        if(!s.saved) continue;
        s.texture = null;
        this.surface_textures(s);
        put(s, s.texture);
    }
    for(const t of all_textures(this.shadow))
    {
        if(!t.saved) continue;
        t.gpu = null;
        if(t.saved3) this.restore_texture3(t);
        else
        {
            const gpu = this.gpu_texture(t);
            if(gpu) put(t, gpu.texture);
        }
        delete t.saved;
        delete t.saved3;
    }
    for(const group of this.shadow.groups.values())
    {
        for(const rb of group.renderbuffers.values())
        {
            rb.gpu = null;
            if(!rb.width || !rb.height || rb.image) continue;
            if(rb.saved3)
            {
                this.restore_renderbuffer3(rb);
                continue;
            }
            const format = DEPTH_FORMATS[rb.format] || COLOR_FORMAT;
            const texture = this.device.createTexture({ label: "GL renderbuffer", size: [rb.width, rb.height], format,
                usage: U.RENDER_ATTACHMENT | U.COPY_SRC | U.COPY_DST | (format === COLOR_FORMAT ? U.TEXTURE_BINDING : 0) });
            rb.gpu = { texture, format, destroy: () => texture.destroy() };
            put(rb, texture);
        }
    }
    this.device.queue.submit([this.encoder.finish()]);
    this.encoder = null;
    for(const object of this.staging) object.destroy();
    this.staging = [];
};
