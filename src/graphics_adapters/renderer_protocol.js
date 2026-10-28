// What the display adapters' devices and their renderer
// (src/browser/glbridge/svga_renderer.js) share: GX batches (the GX writer
// and opcodes; gx/gx_executor.js runs them) and the response region the
// renderer writes answers into (query results, readbacks). vmware_svga and
// virtio_gpu both write GX; the GLES host (ranchu_gpu "host") writes GLES
// batches with the same writer.

/** Where the executor writes answers: offsets into a 16 MiB arena whose last
 * 4 MiB are the response region (query slots first, then readbacks) */
export const RESPONSE_REGION_OFFSET = 12 << 20;
export const RESPONSE_REGION_BYTES = 4 << 20;
export const QUERY_SLOT_BYTES = 16;
export const QUERY_REGION_BYTES = 16 * 1024;
export const READBACK_HEADER_BYTES = 16;
/** The largest readback payload one request may carry */
export const READBACK_MAX_BYTES = RESPONSE_REGION_BYTES - QUERY_REGION_BYTES - READBACK_HEADER_BYTES - 16;
export const RESPONSE_OK = 1;
export const RESPONSE_FAILED = 2;

/** GX batch header magic: "GX10" */
export const GX_MAGIC = 0x30315847;

/** GX opcodes (gx_executor.js has the same) */
export const GX = {
    SURFACE_DEFINE: 1,      // sid, format, flags (64 bits), width, height, depth, mips, layers, samples, cube
    SURFACE_DESTROY: 2,     // sid
    SURFACE_UPLOAD: 3,      // sid, layer, mip, x, y, z, w, h, d, row pitch, slice pitch, then the bytes
    SURFACE_READBACK: 4,    // sid, layer, mip, x, y, z, w, h, d, request id
    CONTEXT_DEFINE: 5,      // cid
    CONTEXT_DESTROY: 6,     // cid
    SHADER_CODE: 7,         // cid, shid, type, then the tokens
    DX: 8,                  // cid, SVGA_3D_CMD_DX_*, then the command's body
    SURFACE_COPY: 9,        // src sid, layer, mip, x, y, z, dst sid, layer, mip, x, y, z, w, h, d
    QUERY_END: 10,          // cid, qid, type, request id
    COTABLE_RESET: 11,      // cid, SVGACOTableType: forget the objects of a type
    SURFACE_STRETCH: 12,    // src sid, layer, mip, l, t, r, b, dst sid, layer, mip, l, t, r, b, linear
    // a surface both GX and D9WG have (D3D9 apps' and DWM's): every image of
    // the D9WG resource into GX's surface, or back
    SURFACE_IMPORT: 13,     // sid, D9WG handle
    SURFACE_EXPORT: 14,     // sid, D9WG handle
    CLEAR_RTV_INTEGER: 15,  // cid, render target view, signed, 4 values (DX's clear has floats)
    // a scanout shown without a readback (docs/gfxstream-plan.md G4): the
    // surface's rectangle copied on the GPU into the page's screen, at (dx, dy)
    // of a screen of width x height; sid 0 hides it again
    SURFACE_PRESENT: 16,    // sid, x, y, w, h, dx, dy, width, height
};

/** VX batch header magic: "VX10" (Venus's Vulkan, on WebGPU: vx/vx_executor.js) */
export const VX_MAGIC = 0x30315856;

/**
 * VX opcodes (vx_executor.js has the same). Objects are the renderer's ids
 * the device gives them; 64-bit values are two dwords (low, high). A
 * VkDeviceMemory is a GPU buffer, a VkImage a texture; buffers are ranges
 * of memory, named by (memory, offset) in each command.
 */
export const VX = {
    MEMORY_CREATE: 1,       // id, size (64)
    DESTROY: 2,             // id
    MEMORY_WRITE: 3,        // id, offset (64), length, then the bytes
    MEMORY_READ: 4,         // id, offset (64), length, request id: answered by a "read" message
    TEXTURE_CREATE: 5,      // id, VkFormat, VkImageType, width, height, depth, mips, layers, samples, VkImageUsageFlags, VkImageCreateFlags
    VIEW_CREATE: 6,         // id, texture, VkImageViewType, VkFormat, aspect, base mip, mips, base layer, layers, swizzle r g b a
    SAMPLER_CREATE: 7,      // id, mag, min, mipmap, u, v, w, lod bias (f32), anisotropy (f32), compare, compare op, min lod (f32), max lod (f32)
    BEGIN: 8,               // (a command buffer's commands follow, into one encoder)
    END: 9,                 // (submitted)
    COPY_BUFFER: 10,        // src, src offset (64), dst, dst offset (64), size (64)
    FILL_BUFFER: 11,        // dst, offset (64), size (64), data
    UPDATE_BUFFER: 12,      // dst, offset (64), length, then the bytes
    COPY_BUFFER_IMAGE: 13,  // to image (1) or from it (0), memory, offset (64), row length, image height,
                            // texture, aspect, mip, base layer, layers, x, y, z, width, height, depth
    COPY_IMAGE: 14,         // src texture, aspect, mip, base layer, x, y, z, dst texture, aspect, mip, base layer, x, y, z, width, height, depth, layers
    BLIT_IMAGE: 15,         // src texture, mip, layer, x0, y0, z0, x1, y1, z1, dst texture, mip, layer, x0, y0, z0, x1, y1, z1, layers, linear
    CLEAR_IMAGE: 16,        // texture, aspect, base mip, mips, base layer, layers, 4 values (color bits; or depth f32, stencil)
    RESOLVE_IMAGE: 17,      // src texture, mip, layer, x, y, dst texture, mip, layer, x, y, width, height, layers
    SHADER_CREATE: 18,      // id, byte length, then the SPIR-V
    PIPELINE_CREATE: 19,    // id, then the pipeline's state as JSON (UTF-8)
    BEGIN_PASS: 20,         // then the pass as JSON: colors [{view, load, store, clear, resolve}], depth {...}, width, height
    END_PASS: 21,
    BIND_PIPELINE: 22,      // pipeline
    SET_BIND_GROUP: 23,     // group, count, then per descriptor: binding, element, VkDescriptorType, view or memory, sampler,
                            // offset (64), size
    SET_VERTEX_BUFFER: 24,  // slot, memory, offset (64), size (64)
    SET_INDEX_BUFFER: 25,   // memory, offset (64), size (64), VkIndexType
    SET_PUSH_CONSTANTS: 26, // offset, length, then the bytes
    SET_VIEWPORT: 27,       // x, y, width, height, min depth, max depth (f32)
    SET_SCISSOR: 28,        // x, y, width, height
    SET_BLEND_CONSTANTS: 29, // 4 f32
    SET_STENCIL_REFERENCE: 30, // faces, reference
    DRAW: 31,               // vertices, instances, first vertex, first instance
    DRAW_INDEXED: 32,       // indices, instances, first index, vertex offset, first instance
    DRAW_INDIRECT: 33,      // memory, offset (64), draws, stride, indexed
    DISPATCH: 34,           // x, y, z
    DISPATCH_INDIRECT: 35,  // memory, offset (64)
    CLEAR_ATTACHMENTS: 36,  // then JSON: attachments [{aspect, index, clear}], rects [{x, y, width, height}]
    QUERY_POOL_CREATE: 37,  // id, VkQueryType, count (occlusion queries: a query set)
    BEGIN_QUERY: 38,        // pool, query (in a render pass begun with the pool as its occlusion queries)
    END_QUERY: 39,          // pool, query, memory: the result (u64) into the memory at query * 8 when the pass ends
    COPY_QUERY_RESULTS: 40, // results memory, first, count, dst memory, dst offset (64), stride, VkQueryResultFlags
    TEXTURE_READ: 41,       // texture, aspect, mip, layer or slice, request id: answered with the image's texels, rows packed
    TEXTURE_WRITE: 42,      // texture, aspect, mip, layer or slice, length, then the texels (rows packed): a snapshot's contents
    TEXTURE_IMPORT: 43,     // texture, virtio-gpu resource id: the image becomes the texture of that resource's GX surface
                            // (a gralloc buffer imported by Venus: VkImportMemoryResourceInfoMESA), which GX keeps owning
    // transform feedback (VK_EXT_transform_feedback): a draw in an active one
    // runs its vertex shader as a compute shader first (vx/naga/src/xfb.rs)
    XFB_BIND: 44,           // buffer, memory, offset (64), size (64)
    XFB_BEGIN: 45,          // first counter, count, then per counter buffer: memory (0: none), offset (64)
    XFB_END: 46,            // as XFB_BEGIN: the bytes captured into each buffer go to its counter (u32)
    // the dynamic stencil masks (VK_DYNAMIC_STATE_STENCIL_COMPARE_MASK,
    // _WRITE_MASK): WebGPU's are the pipeline's, so a variant per pair
    SET_STENCIL_COMPARE_MASK: 47, // faces, mask
    SET_STENCIL_WRITE_MASK: 48, // faces, mask
    // the dynamic depth bias (VK_DYNAMIC_STATE_DEPTH_BIAS: GL's glPolygonOffset): a variant per bias
    SET_DEPTH_BIAS: 49,     // constant factor, clamp, slope factor (f32)
};

/** GLES batch header magic: "GE10" (the GLES host's, src/gles/, docs/gles-proxy-plan.md) */
export const GLES_MAGIC = 0x30314547;

/**
 * GLES records (the GLES executor has the same). A command is the guest's
 * GLESv1 or GLESv2 command as it encoded it (opcode, size, parameters: its
 * data travels with it), for the connection's current context, with the
 * answer the CPU side gave (glCreateShader's and glCreateProgram's names);
 * only calls the shadow state accepted, no queries. renderControl's objects
 * come as records of their own: what a color buffer, a surface or a
 * context is, not the guest's reference counting. A read is answered by a
 * "write" message: the readback header (request id, length, 0, status),
 * then the pixels, rows packed.
 */
export const GLES = {
    COMMAND: 1,             // connection, answer, byte length, then the command's bytes
    CONTEXT_CREATE: 2,      // context, config, share group (its first context), API (1 or 2)
    CONTEXT_DESTROY: 3,     // context
    SURFACE_CREATE: 4,      // surface, config, width, height
    SURFACE_DESTROY: 5,     // surface
    SURFACE_COLOR_BUFFER: 6, // surface, color buffer (rcSetWindowColorBuffer)
    MAKE_CURRENT: 7,        // connection, context, draw surface, read surface
    COLOR_BUFFER_CREATE: 8, // color buffer, width, height, internal format
    COLOR_BUFFER_DESTROY: 9, // color buffer (its last reference went)
    COLOR_BUFFER_UPDATE: 10, // color buffer, x, y, width, height, format, type, byte length, then the pixels
    COLOR_BUFFER_READ: 11,  // color buffer, x, y, width, height, format, type, request id
    COLOR_BUFFER_BIND: 12,  // connection, color buffer, as a texture (1) or a renderbuffer (0) of its context
    IMAGE_CREATE: 13,       // image, context, target (EGL_GL_TEXTURE_2D_KHR, EGL_NATIVE_BUFFER_ANDROID), texture or color buffer
    IMAGE_DESTROY: 14,      // image
    POST: 15,               // color buffer: the screen (rcFBPost)
    FLUSH_SURFACE: 16,      // surface: what was drawn to it is its color buffer's (rcFlushWindowColorBuffer)
    READ_PIXELS: 17,        // connection, request id, x, y, width, height, format, type (glReadPixels)
    CONNECTION_CLOSE: 18,   // connection (nothing is current on it any more)
    PROGRAM_LINK: 19,       // connection, program, byte length, then the link's result (glsl_program.js's pack_program):
                            // before its glLinkProgram, which the page then links with it (it has no glslang)
    BUFFER_READ: 20,        // connection, request id, buffer, offset, length: a buffer's bytes the GPU wrote (glMapBufferRange's)
    QUERY_READ: 21,         // connection, request id, query: an occlusion query's result (a u32: whether a sample passed)
};

/**
 * A GX (or VX) batch being written: dwords
 * @constructor
 * @param {number=} magic GX_MAGIC unless given
 */
export function GXWriter(magic)
{
    this.magic = magic || GX_MAGIC;
    this.words = new Uint32Array(1 << 14);
    this.length = 4;
    this.count = 0;
    /** @type {?function()} called before each command: the other stream is sent first */
    this.before = null;
    /** @type {?function(number, !IArrayLike<number>, (Uint8Array|undefined))} sees each command (Venus keeps its creations for snapshots) */
    this.listener = null;
}

GXWriter.prototype.empty = function()
{
    return this.count === 0;
};

/** @return {number} bytes so far */
GXWriter.prototype.size = function()
{
    return this.length * 4;
};

GXWriter.prototype.reserve = function(dwords)
{
    if(this.length + dwords <= this.words.length) return;
    let capacity = this.words.length;
    while(capacity < this.length + dwords) capacity *= 2;
    const bigger = new Uint32Array(capacity);
    bigger.set(this.words.subarray(0, this.length));
    this.words = bigger;
};

/**
 * A command: its opcode, its dwords, then maybe bytes (padded to dwords)
 * @param {number} op
 * @param {!IArrayLike<number>} dwords
 * @param {Uint8Array=} bytes
 */
GXWriter.prototype.command = function(op, dwords, bytes)
{
    if(this.before) this.before();
    if(this.listener) this.listener(op, dwords, bytes);
    const byte_count = bytes ? bytes.length : 0;
    const body = dwords.length + (byte_count + 3 >> 2);
    this.reserve(2 + body);
    const w = this.words;
    w[this.length++] = op;
    w[this.length++] = body;
    for(let i = 0; i < dwords.length; i++) w[this.length++] = dwords[i];
    if(bytes)
    {
        const tail = new Uint8Array(w.buffer, this.length * 4, body * 4 - dwords.length * 4);
        tail.fill(0);
        tail.set(bytes);
        this.length += byte_count + 3 >> 2;
    }
    this.count++;
};

/**
 * The batch: header (magic, version, dwords, commands), then the commands
 * @return {!Uint8Array}
 */
GXWriter.prototype.finish = function()
{
    const w = this.words;
    w[0] = this.magic;
    w[1] = 1;
    w[2] = this.length;
    w[3] = this.count;
    const bytes = new Uint8Array(w.buffer.slice(0, this.length * 4));
    this.length = 4;
    this.count = 0;
    return bytes;
};
