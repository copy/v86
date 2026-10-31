// Desktop GL rendering on WebGPU. GLShadow beside the emulated device owns
// public GL state, validation, errors, objects and synchronous queries. This
// executor consumes its accepted/resolved records and owns GPU resources,
// shader generation, pipelines and asynchronous readbacks (plan D1).
//
// The vertex stage flips clip-space Y once. Framebuffer row zero remains GL's
// bottom row; winding and presentation account for this conversion.
// Every pipeline-affecting render state must participate in its cache key.

(function(global) {
    "use strict";

    const nodeRequire = (typeof require === "function" &&
        typeof module !== "undefined") ? require : null;
    const protocol = nodeRequire ? nodeRequire("./gl_protocol.js") : global.GLProtocol;
    const glCaps = nodeRequire ? nodeRequire("./gl_caps.js") : global.GLCaps;
    const { CacheKeys } = nodeRequire ? nodeRequire("./gl_cache_keys.js") : global.GLCacheKeys;
    const constants = nodeRequire ? nodeRequire("./gl_constants.js") :
        global.GLWGConstants;
    const stateLayout = nodeRequire ? nodeRequire("./gl_state_layout.js") :
        global.GLStateLayout;
    const translator = nodeRequire ? nodeRequire("./gl_shader_translator.js") :
        global.GLShaderTranslator;
    const fixedFunction = nodeRequire ? nodeRequire("./gl_fixed_function.js") :
        global.GLFixedFunction;
    const arbProgram = nodeRequire ? nodeRequire("./gl_arb_program.js") :
        global.GLARBProgram;
    const gpuHost = nodeRequire ? nodeRequire("../webgpu_host.js") :
        global.V86GPUHost;
    const pixelMaps = nodeRequire ? nodeRequire("./gl_pixel_maps.js") : global.GLPixelMaps;
    const framebufferState = nodeRequire ? nodeRequire("./gl_framebuffer_state.js") : global.GLFramebufferState;
    const textureParameters = nodeRequire ? nodeRequire("./gl_texture_parameters.js") : global.GLTextureParameters;
    const { parseArrayBlocks, parseGenericBlocks, componentBytes, readComponent } = nodeRequire ?
        nodeRequire("./gl_client_arrays.js") : global.GLClientArrays;

    const GL = constants.GL;
    const GLFN = constants.GLFN;
    const CTRL = constants.CTRL;
    const BUFFER_TARGET_FIELDS = new Map([[GL.ARRAY_BUFFER, "arrayBuffer"], [GL.ELEMENT_ARRAY_BUFFER, "elementArrayBuffer"],
        [GL.PIXEL_PACK_BUFFER, "pixelPackBuffer"], [GL.PIXEL_UNPACK_BUFFER, "pixelUnpackBuffer"]]);
    // V86GL_CTRL_WINDOW_STATE flags: D9WGWindowState's (d3d9_protocol.h)
    const WINDOW_IS_WINDOW = 1 << 0;
    const WINDOW_VISIBLE = 1 << 1;
    const WINDOW_ICONIC = 1 << 2;
    const WINDOW_OCCLUDED = 1 << 6;
    const WINDOW_REGION = 1 << 7;
    const WINDOW_REGION_MAX_RECTS = 32;
    const SIGNATURES = protocol.SIGNATURES;

    const EXECUTOR_REVISION = 1;

    const MAX_TEXTURE_UNITS = glCaps.LIMITS.MAX_TEXTURE_UNITS;
    const MAX_TEXTURE_COORDS = glCaps.LIMITS.MAX_TEXTURE_COORDS;
    const MAX_LIGHTS = glCaps.LIMITS.MAX_LIGHTS;
    const MAX_CLIP_PLANES = glCaps.LIMITS.MAX_CLIP_PLANES;

    // glPushAttrib/glPushClientAttrib masks.  Keep these local to the executor:
    // they are state-group selectors rather than wire opcodes, and spelling the
    // groups out here makes it much harder for a newly added state field to be
    // silently restored by the wrong mask.
    const ATTRIB = {
        CURRENT: 0x00000001, POINT: 0x00000002, LINE: 0x00000004,
        POLYGON: 0x00000008, POLYGON_STIPPLE: 0x00000010,
        PIXEL_MODE: 0x00000020, LIGHTING: 0x00000040, FOG: 0x00000080,
        DEPTH_BUFFER: 0x00000100, ACCUM_BUFFER: 0x00000200,
        STENCIL_BUFFER: 0x00000400, VIEWPORT: 0x00000800,
        TRANSFORM: 0x00001000, ENABLE: 0x00002000,
        COLOR_BUFFER: 0x00004000, HINT: 0x00008000,
        EVAL: 0x00010000, LIST: 0x00020000, TEXTURE: 0x00040000,
        SCISSOR: 0x00080000, MULTISAMPLE: 0x20000000,
    };
    const CLIENT_ATTRIB = { PIXEL_STORE: 0x00000001, VERTEX_ARRAY: 0x00000002 };
    const MAX_VERTEX_ATTRIBS = glCaps.LIMITS.MAX_VERTEX_ATTRIBS;
    const MAX_DRAW_BUFFERS = glCaps.LIMITS.MAX_DRAW_BUFFERS;
    const MODELVIEW_STACK_DEPTH = glCaps.LIMITS.MODELVIEW_STACK_DEPTH;
    const OTHER_STACK_DEPTH = glCaps.LIMITS.OTHER_STACK_DEPTH;
    /* A guest process can flush object-deletion records after its final
     * DESTROY_CONTEXT record. destroyContext() has already retired every
     * object in the orphaned share group, so replaying those deletes has no
     * semantic work left and should not look like a rendering warning. */
    const CONTEXT_FREE_TEARDOWN_OPS = new Set([
        GLFN.DELETE_TEXTURES, GLFN.DELETE_BUFFERS, GLFN.DELETE_PROGRAMS_ARB,
        GLFN.DELETE_PROGRAM, GLFN.DELETE_SHADER, GLFN.DELETE_FRAMEBUFFERS,
        GLFN.DELETE_RENDERBUFFERS, GLFN.DELETE_QUERIES,
    ]);

    function isContextFreeTeardownNoop(fn, view, offset, size) {
        if (CONTEXT_FREE_TEARDOWN_OPS.has(fn)) return true;
        /* GLView unbinds both ARB targets after deleting its last HGLRC. The
         * payload is {target, program}; only program zero is harmless. Keep a
         * warning for a non-zero late bind because that can reveal a genuine
         * control/GL stream ordering bug. */
        return fn === GLFN.BIND_PROGRAM_ARB && size >= 8 &&
            view.getUint32(offset + 4, true) === 0;
    }

    const TEXTURE_USAGE_COPY_SRC = 0x01;
    const TEXTURE_USAGE_COPY_DST = 0x02;
    const TEXTURE_USAGE_TEXTURE_BINDING = 0x04;
    const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
    const BUFFER_USAGE_MAP_READ = 0x0001;
    const BUFFER_USAGE_COPY_SRC = 0x0004;
    const BUFFER_USAGE_COPY_DST = 0x0008;
    const BUFFER_USAGE_INDEX = 0x0010;
    const BUFFER_USAGE_VERTEX = 0x0020;
    const BUFFER_USAGE_UNIFORM = 0x0040;
    const BUFFER_USAGE_STORAGE = 0x0080;
    const BUFFER_USAGE_QUERY_RESOLVE = 0x0200;
    /* D-07. Matches V86GL_QUERY_VISIBLE_SAMPLES in the guest, which uses the
     * same value when it has to answer a blocking GL_QUERY_RESULT itself. */
    const OCCLUSION_VISIBLE_SAMPLES = 0x7FFFFFFF;

    /*
     * The first bytes of a record, as 32-bit words and as hex.
     *
     * Words because every payload in this protocol starts with a run of
     * uint32 fields, so a decoded word list can be read straight against the
     * struct in openglproxy/opengl32_proxy.c; hex because the bytes after
     * them usually cannot.
     */
    function hexPreview(bytes, offset, size, limit) {
        // `offset` is relative to the Uint8Array passed to submit(), just like
        // DataView offsets and Uint8Array indices.  The array may itself be a
        // view into guest RAM with a non-zero byteOffset; subtracting that
        // backing-buffer offset a second time reads an unrelated batch.
        const start = offset;
        const count = Math.min(size, limit || 48);
        if (start < 0 || count <= 0) return "";
        const slice = bytes.subarray(start, start + count);
        const words = [];
        const view = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
        for (let i = 0; i + 4 <= slice.byteLength && words.length < 8; i += 4)
            words.push(view.getUint32(i, true));
        let hex = "";
        for (let i = 0; i < slice.byteLength; ++i)
            hex += (i && !(i % 4) ? " " : "") +
                slice[i].toString(16).padStart(2, "0");
        return "words[" + words.join(",") + "] " + hex +
            (size > count ? " …(" + size + " bytes)" : "");
    }

    /* The response region carved out of the tail of v86gl.sys's DMA
     * allocation, mirroring D9WG's layout so both paths look the same to
     * anyone reading guest memory. See plan section 6.2. */
    const GLWG_RESPONSE_REGION_BYTES = protocol.C.V86GL_RESPONSE_REGION_BYTES;
    const GLWG_SLOT_BYTES = 16;
    const GLWG_SLOT_COUNT = 1024;
    const GLWG_QUERY_REGION_BYTES = GLWG_SLOT_BYTES * GLWG_SLOT_COUNT;
    const GLWG_READBACK_REGION_OFFSET = GLWG_QUERY_REGION_BYTES;
    const GLWG_HEARTBEAT_BYTES = protocol.C.V86GL_HEARTBEAT_BYTES;
    const GLWG_HEARTBEAT_OFFSET =
        GLWG_RESPONSE_REGION_BYTES - GLWG_HEARTBEAT_BYTES;
    const GLWG_RESPONSE_PENDING = 0;
    const GLWG_RESPONSE_OK = 1;
    const GLWG_RESPONSE_FAILED = 2;

    const CLIENT_ARRAY_MT_MAGIC = 0x544D4143;   // 'CAMT'
    const CLIENT_ARRAY_MT_SECONDARY_COLOR_BIT = 0x80000000;
    const CLIENT_ARRAY_MT_FOG_COORD_BIT = 0x40000000;

    const UNIFORM_RING_BYTES = 4 * 1024 * 1024;
    const VERTEX_RING_BYTES = 8 * 1024 * 1024;

    /* ================================================================== */
    /* Small helpers                                                      */
    /* ================================================================== */

    function alignUp(value, alignment) {
        return Math.ceil(value / alignment) * alignment;
    }

    function clamp(value, low, high) {
        return value < low ? low : (value > high ? high : value);
    }

    function formatHasStencil(format) {
        return typeof format === "string" && format.indexOf("stencil") >= 0;
    }

    /*
     * An automatic WebGPU pipeline layout contains only bindings statically
     * reachable from the selected entry points.  A declaration referenced by
     * an uncalled helper function is deliberately absent.  GLSL applications
     * commonly leave helpers (and their fixed-state uniforms or samplers) in
     * a compiled shader, so looking for binding declarations alone creates a
     * bind group which is invalid against the pipeline's narrower layout.
     *
     * Generated WGSL has no function pointers or indirect calls.  Walking its
     * small, explicit call graph therefore gives the same binding set as the
     * automatic-layout algorithm without making draw submission asynchronous
     * merely to probe validation error scopes.
     */
    function collectReachableWgslBindings(source, entryPoint, result) {
        const text = String(source || "")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\r\n]*/g, "");
        const bindings = new Map();
        const bindingPattern = /@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)\s*var(?:\s*<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
        for (const match of text.matchAll(bindingPattern))
            bindings.set(match[3], match[1] + ":" + match[2]);

        const functions = new Map();
        const functionPattern = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
        for (let match; (match = functionPattern.exec(text));) {
            const open = text.indexOf("{", functionPattern.lastIndex);
            if (open < 0) break;
            let depth = 1;
            let end = open + 1;
            while (end < text.length && depth) {
                if (text[end] === "{") ++depth;
                else if (text[end] === "}") --depth;
                ++end;
            }
            if (depth) break;
            functions.set(match[1], text.slice(open + 1, end - 1));
            functionPattern.lastIndex = end;
        }

        const pending = [entryPoint];
        const visited = new Set();
        while (pending.length) {
            const name = pending.pop();
            if (visited.has(name)) continue;
            visited.add(name);
            const body = functions.get(name);
            if (body === undefined) continue;

            for (const [variable, key] of bindings) {
                const use = new RegExp("\\b" + variable + "\\b");
                if (use.test(body)) result.add(key);
            }
            const callPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
            for (const call of body.matchAll(callPattern)) {
                if (functions.has(call[1]) && !visited.has(call[1]))
                    pending.push(call[1]);
            }
        }
    }

    function activeShaderBindings(wgslVertex, wgslFragment, vertexEntry = "vs_main") {
        const result = new Set();
        collectReachableWgslBindings(wgslVertex, vertexEntry, result);
        collectReachableWgslBindings(wgslFragment, "fs_main", result);
        return result;
    }

    class GLStreamError extends Error {}

    /* ---- matrices: column-major, the same order GL and WGSL both use ---- */

    const { identity4, multiply4, invert4, transpose4, normalMatrixOf, transformPoint4 } =
        nodeRequire ? nodeRequire("./gl_math.js") : global.GLMath;

    /* ================================================================== */
    /* GL enum translation                                                */
    /* ================================================================== */

    const DEPTH_MODE_FORMATS = { [GL.LUMINANCE]: "LUMINANCE", [GL.INTENSITY]: "INTENSITY",
        [GL.ALPHA]: "ALPHA" };

    const ARB_TEXTURE_TARGETS = { "1D": GL.TEXTURE_1D, "2D": GL.TEXTURE_2D, "3D": GL.TEXTURE_3D,
        Cube: GL.TEXTURE_CUBE_MAP };

    // the draw buffers that include the window's front buffer
    const FRONT_BUFFERS = new Set([GL.FRONT, GL.FRONT_AND_BACK, GL.FRONT_LEFT, GL.LEFT]);

    // the widest aliased line drawn (ALIASED_LINE_WIDTH_RANGE)
    const MAX_LINE_WIDTH = glCaps.LIMITS.MAX_LINE_WIDTH;

    const COMPARE_FUNCTIONS = {
        [GL.NEVER]: "never", [GL.LESS]: "less", [GL.EQUAL]: "equal",
        [GL.LEQUAL]: "less-equal", [GL.GREATER]: "greater",
        [GL.NOTEQUAL]: "not-equal", [GL.GEQUAL]: "greater-equal",
        [GL.ALWAYS]: "always",
    };

    const ALPHA_TEST_NAMES = {
        [GL.NEVER]: "never", [GL.LESS]: "less", [GL.EQUAL]: "equal",
        [GL.LEQUAL]: "lequal", [GL.GREATER]: "greater",
        [GL.NOTEQUAL]: "notequal", [GL.GEQUAL]: "gequal",
        [GL.ALWAYS]: "always",
    };

    const STENCIL_OPERATIONS = {
        [GL.KEEP]: "keep", [GL.ZERO]: "zero", [GL.REPLACE]: "replace",
        [GL.INCR]: "increment-clamp", [GL.DECR]: "decrement-clamp",
        [GL.INVERT]: "invert",
        [GL.INCR_WRAP]: "increment-wrap", [GL.DECR_WRAP]: "decrement-wrap",
    };

    const BLEND_FACTORS = {
        [GL.ZERO]: "zero", [GL.ONE]: "one",
        [GL.SRC_COLOR]: "src", [GL.ONE_MINUS_SRC_COLOR]: "one-minus-src",
        [GL.DST_COLOR]: "dst", [GL.ONE_MINUS_DST_COLOR]: "one-minus-dst",
        [GL.SRC_ALPHA]: "src-alpha", [GL.ONE_MINUS_SRC_ALPHA]: "one-minus-src-alpha",
        [GL.DST_ALPHA]: "dst-alpha", [GL.ONE_MINUS_DST_ALPHA]: "one-minus-dst-alpha",
        [GL.CONSTANT_COLOR]: "constant",
        [GL.ONE_MINUS_CONSTANT_COLOR]: "one-minus-constant",
        // WebGPU has no separate alpha blend constant: one setBlendConstant
        // covers both, so GL_CONSTANT_ALPHA maps to the same factor and the
        // colour factors get the constant's alpha in its RGB (blendConstant).
        // Exact unless the colour factors use both CONSTANT_COLOR and
        // CONSTANT_ALPHA at once.
        [GL.CONSTANT_ALPHA]: "constant",
        [GL.ONE_MINUS_CONSTANT_ALPHA]: "one-minus-constant",
        [GL.SRC_ALPHA_SATURATE]: "src-alpha-saturated",
    };

    const BLEND_EQUATIONS = {
        [GL.FUNC_ADD]: "add",
        [GL.FUNC_SUBTRACT]: "subtract",
        [GL.FUNC_REVERSE_SUBTRACT]: "reverse-subtract",
        [GL.MIN]: "min", [GL.MAX]: "max",
        [GL.MIN_EXT]: "min", [GL.MAX_EXT]: "max",
    };

    /* The selected default pixel format is currently single-sampled, but ARB
     * sample coverage still has observable all-or-nothing coverage there. */
    // GL_SAMPLE_COVERAGE: value times the samples, as a mask of that many
    function sampleCoverageMask(state, samples = 1) {
        if (!state.enabled.has(GL.MULTISAMPLE) ||
                !state.enabled.has(GL.SAMPLE_COVERAGE))
            return 0xffffffff;
        const all = samples >= 32 ? 0xffffffff : (1 << samples) - 1;
        const count = samples === 1 ? (state.sampleCoverage.value > 0 ? 1 : 0) :
            Math.round(clamp(state.sampleCoverage.value, 0, 1) * samples);
        const covered = count >= 32 ? 0xffffffff : (1 << count) - 1;
        return (state.sampleCoverage.invert ? ~covered & all : covered) >>> 0;
    }

    const ADDRESS_MODES = {
        [GL.REPEAT]: "repeat",
        [GL.CLAMP_TO_EDGE]: "clamp-to-edge",
        [GL.MIRRORED_REPEAT]: "mirror-repeat",
        // GL_CLAMP and GL_CLAMP_TO_BORDER sample the border colour outside
        // [0,1]; WebGPU has no border addressing at all, so the sampler clamps
        // and the shader is responsible for the border. Deviation D-03.
        [GL.CLAMP]: "clamp-to-edge",
        [GL.CLAMP_TO_BORDER]: "clamp-to-edge",
    };

    /* GL's ten primitive modes over WebGPU's five. Everything that has no
     * direct topology is expanded through an index buffer (plan 4.6). */
    const PRIMITIVE_TOPOLOGY = {
        [GL.POINTS]: "point-list",
        [GL.LINES]: "line-list",
        [GL.LINE_STRIP]: "line-strip",
        [GL.LINE_LOOP]: "line-strip",
        [GL.TRIANGLES]: "triangle-list",
        [GL.TRIANGLE_STRIP]: "triangle-strip",
        [GL.TRIANGLE_FAN]: "triangle-list",
        [GL.QUADS]: "triangle-list",
        [GL.QUAD_STRIP]: "triangle-list",
        [GL.POLYGON]: "triangle-list",
    };

    /*
     * What a draw of `mode` becomes: WebGPU's topology, and whether its
     * vertices go through an expanded index list -- the modes WebGPU does
     * not have, and under flat shading the ones whose provoking vertex is
     * not the first (GL 2.1 table 2.12: a triangle's is its last, a line's
     * its second; review S2-5), since WGSL's flat interpolation takes the
     * first.
     */
    function drawShape(mode, flat) {
        switch (mode) {
        case GL.TRIANGLE_FAN: case GL.QUADS: case GL.QUAD_STRIP: case GL.POLYGON:
            return { expand: true, topology: "triangle-list" };
        case GL.LINE_LOOP:
            return { expand: true, topology: flat ? "line-list" : "line-strip" };
        case GL.TRIANGLES: case GL.TRIANGLE_STRIP:
            return flat ? { expand: true, topology: "triangle-list" } : { expand: false, topology: PRIMITIVE_TOPOLOGY[mode] };
        case GL.LINES: case GL.LINE_STRIP:
            return flat ? { expand: true, topology: "line-list" } : { expand: false, topology: PRIMITIVE_TOPOLOGY[mode] };
        default:
            return { expand: false, topology: PRIMITIVE_TOPOLOGY[mode] };
        }
    }

    /*
     * Flat shading takes its colour from a primitive-specific vertex, and the
     * table is not "the first one": a triangle fan's triangle uses its last
     * vertex and a quad its fourth. WGSL's @interpolate(flat) takes the
     * first, so expansion puts GL's choice there (rotating, which keeps the
     * winding). Getting this wrong
     * shifts colours by one vertex on flat-shaded models only, which is why
     * gl_flat_shading_test.exe walks the whole table.
     */
    function expandIndices(mode, count, base, flat) {
        const first = base || 0;
        if (flat) {
            const out = expandFlat(mode, count, first);
            if (out) return out;
        }
        switch (mode) {
        case GL.TRIANGLE_FAN: {
            if (count < 3) return new Uint32Array(0);
            const out = new Uint32Array((count - 2) * 3);
            let w = 0;
            for (let i = 0; i < count - 2; ++i) {
                // triangle (0, i+1, i+2); its provoking vertex i+2 leads
                out[w++] = first + i + 2;
                out[w++] = first;
                out[w++] = first + i + 1;
            }
            return out;
        }
        case GL.QUADS: {
            const quads = Math.floor(count / 4);
            const out = new Uint32Array(quads * 6);
            let w = 0;
            for (let q = 0; q < quads; ++q) {
                const b = first + q * 4;
                // provoking vertex is the quad's last, so it leads both halves
                out[w++] = b + 3; out[w++] = b; out[w++] = b + 1;
                out[w++] = b + 3; out[w++] = b + 1; out[w++] = b + 2;
            }
            return out;
        }
        case GL.QUAD_STRIP: {
            if (count < 4) return new Uint32Array(0);
            const quads = Math.floor(count / 2) - 1;
            const out = new Uint32Array(quads * 6);
            let w = 0;
            for (let q = 0; q < quads; ++q) {
                const b = first + q * 2;
                // Quad q is the polygon (b, b+1, b+3, b+2), split on b..b+3
                // with its winding kept (review S2-4: the second half was
                // reversed); GL's provoking vertex for quad-strip quad i is
                // 2i + 2 counting from one, b+3 here, and leads both halves
                out[w++] = b + 3; out[w++] = b; out[w++] = b + 1;
                out[w++] = b + 3; out[w++] = b + 2; out[w++] = b;
            }
            return out;
        }
        case GL.POLYGON: {
            if (count < 3) return new Uint32Array(0);
            const out = new Uint32Array((count - 2) * 3);
            let w = 0;
            for (let i = 0; i < count - 2; ++i) {
                // the whole polygon takes its flat colour from vertex 0
                out[w++] = first;
                out[w++] = first + i + 1;
                out[w++] = first + i + 2;
            }
            return out;
        }
        case GL.LINE_LOOP: {
            if (count < 2) return new Uint32Array(0);
            const out = new Uint32Array(count + 1);
            for (let i = 0; i < count; ++i) out[i] = first + i;
            out[count] = first;
            return out;
        }
        default: {
            const out = new Uint32Array(count);
            for (let i = 0; i < count; ++i) out[i] = first + i;
            return out;
        }
        }
    }

    /*
     * Under flat shading: each primitive with GL's provoking vertex first. A
     * triangle is rotated, which keeps its winding (a strip's odd triangles
     * are (i+1, i, i+2), as GL orders them); a line is reversed.
     */
    function expandFlat(mode, count, first) {
        switch (mode) {
        case GL.TRIANGLES: {
            const out = new Uint32Array(Math.floor(count / 3) * 3);
            for (let w = 0; w < out.length; w += 3) {
                out[w] = first + w + 2; out[w + 1] = first + w; out[w + 2] = first + w + 1;
            }
            return out;
        }
        case GL.TRIANGLE_STRIP: {
            if (count < 3) return new Uint32Array(0);
            const out = new Uint32Array((count - 2) * 3);
            for (let i = 0, w = 0; i < count - 2; ++i) {
                out[w++] = first + i + 2;
                out[w++] = first + (i & 1 ? i + 1 : i);
                out[w++] = first + (i & 1 ? i : i + 1);
            }
            return out;
        }
        case GL.LINES: {
            const out = new Uint32Array(Math.floor(count / 2) * 2);
            for (let w = 0; w < out.length; w += 2) {
                out[w] = first + w + 1; out[w + 1] = first + w;
            }
            return out;
        }
        case GL.LINE_STRIP:
        case GL.LINE_LOOP: {
            if (count < 2) return new Uint32Array(0);
            const segments = mode === GL.LINE_LOOP ? count : count - 1;
            const out = new Uint32Array(segments * 2);
            for (let i = 0; i < count - 1; ++i) {
                out[i * 2] = first + i + 1; out[i * 2 + 1] = first + i;
            }
            // the loop's closing segment takes the first vertex's colour
            if (mode === GL.LINE_LOOP) {
                out[segments * 2 - 2] = first; out[segments * 2 - 1] = first + count - 1;
            }
            return out;
        }
        default:
            return null;
        }
    }

    /* The same expansion applied to an existing index array. */
    function expandIndexArray(mode, indices, flat) {
        const count = indices.length;
        const map = expandIndices(mode, count, 0, flat);
        const out = new Uint32Array(map.length);
        for (let i = 0; i < map.length; ++i) out[i] = indices[map[i]];
        return out;
    }

    function expandedIndexCount(mode, count, flat) {
        if (flat) {
            const flatOut = expandFlat(mode, count, 0);
            if (flatOut) return flatOut.length;
        }
        switch (mode) {
        case GL.TRIANGLE_FAN: return count < 3 ? 0 : (count - 2) * 3;
        case GL.QUADS: return Math.floor(count / 4) * 6;
        case GL.QUAD_STRIP: return count < 4 ? 0 : (Math.floor(count / 2) - 1) * 6;
        case GL.POLYGON: return count < 3 ? 0 : (count - 2) * 3;
        case GL.LINE_LOOP: return count < 2 ? 0 : count + 1;
        default: return count;
        }
    }

    function isLinePrimitive(mode) {
        return mode === GL.LINES || mode === GL.LINE_STRIP || mode === GL.LINE_LOOP;
    }

    /*
     * A line draw's segments as vertex numbers: `a`, `b`, the flat-shading
     * vertex (table 2.12: a segment's second, the loop's closing one its
     * first) and whether the stipple counter restarts (each independent
     * segment; a strip or loop runs on, GL 2.1 section 3.4.3).
     */
    function lineSegments(mode, count, source) {
        const n = source ? source.length : count;
        const at = source ? i => source[i] : i => i;
        const out = [];
        if (mode === GL.LINES) {
            for (let i = 0; i + 1 < n; i += 2)
                out.push({ a: at(i), b: at(i + 1), provoking: at(i + 1), restart: true });
            return out;
        }
        for (let i = 0; i + 1 < n; ++i)
            out.push({ a: at(i), b: at(i + 1), provoking: at(i + 1), restart: i === 0 });
        if (mode === GL.LINE_LOOP && n > 1)
            out.push({ a: at(n - 1), b: at(0), provoking: at(0), restart: false });
        return out;
    }

    function isPolygonPrimitive(mode) {
        return mode === GL.TRIANGLES || mode === GL.TRIANGLE_STRIP ||
            mode === GL.TRIANGLE_FAN || mode === GL.QUADS ||
            mode === GL.QUAD_STRIP || mode === GL.POLYGON;
    }

    /* Produces independent triangles before polygon raster mode is applied.
     * `source` is the application's optional index array; without it the
     * vertices are numbered from zero and drawIndexed's baseVertex preserves
     * glDrawArrays(first). */
    function triangleListIndices(mode, count, source) {
        const input = source || (() => {
            const out = new Uint32Array(count);
            for (let i = 0; i < count; ++i) out[i] = i;
            return out;
        })();
        if (mode === GL.TRIANGLES)
            return input.slice(0, Math.floor(input.length / 3) * 3);
        if (mode === GL.TRIANGLE_STRIP) {
            if (input.length < 3) return new Uint32Array(0);
            const out = new Uint32Array((input.length - 2) * 3);
            let at = 0;
            for (let i = 0; i + 2 < input.length; ++i) {
                if (i & 1) {
                    out[at++] = input[i + 1]; out[at++] = input[i];
                } else {
                    out[at++] = input[i]; out[at++] = input[i + 1];
                }
                out[at++] = input[i + 2];
            }
            return out;
        }
        return expandIndexArray(mode, input);
    }

    /*
     * The polygons a draw is made of (GL 2.1 section 2.6.1), as runs of
     * vertex numbers: `vertices` from `starts[k]` to `starts[k + 1]` is
     * polygon k, `provoking[k]` its flat-shading vertex (table 2.12), and
     * `boundary[i]` whether vertex i starts a boundary edge -- its edge flag
     * for independent triangles, quads and polygons, always for strips and
     * fans (section 2.6.2). `source` is the application's index array.
     */
    function polygonFaces(mode, count, source, flags) {
        const n = source ? source.length : count;
        const at = source ? i => source[i] : i => i;
        const flagged = !!flags && (mode === GL.TRIANGLES || mode === GL.QUADS ||
            mode === GL.POLYGON);
        const vertices = [], boundary = [], starts = [0], provoking = [];
        const face = (list, last) => {
            for (const i of list) {
                vertices.push(at(i));
                boundary.push(flagged ? flags[at(i)] : 1);
            }
            starts.push(vertices.length);
            provoking.push(at(last));
        };
        switch (mode) {
        case GL.TRIANGLES:
            for (let i = 0; i + 2 < n; i += 3) face([i, i + 1, i + 2], i + 2);
            break;
        case GL.TRIANGLE_STRIP:
            for (let i = 0; i + 2 < n; ++i)
                face(i & 1 ? [i + 1, i, i + 2] : [i, i + 1, i + 2], i + 2);
            break;
        case GL.TRIANGLE_FAN:
            for (let i = 0; i + 2 < n; ++i) face([0, i + 1, i + 2], i + 2);
            break;
        case GL.QUADS:
            for (let b = 0; b + 3 < n; b += 4) face([b, b + 1, b + 2, b + 3], b + 3);
            break;
        case GL.QUAD_STRIP:
            for (let b = 0; b + 3 < n; b += 2) face([b, b + 1, b + 3, b + 2], b + 3);
            break;
        case GL.POLYGON:
            if (n >= 3) face(Array.from({ length: n }, (_, i) => i), 0);
            break;
        }
        return { vertices, boundary, starts, provoking };
    }

    /*
     * Whether polygon k faces front: the sign of its window-space area (GL
     * 2.1 section 3.5.1). `clip` holds each vertex's clip coordinates. With
     * every vertex in front of the eye that is the area of the projected
     * polygon (the viewport's positive scale keeps the sign); otherwise the
     * homogeneous determinants, whose sign is the visible part's
     * orientation.
     */
    function facesFront(clip, faces, k, frontFace) {
        const from = faces.starts[k], to = faces.starts[k + 1], v = faces.vertices;
        let area = 0;
        if (v.slice(from, to).every(i => clip[i * 4 + 3] > 0)) {
            for (let i = from; i < to; ++i) {
                const a = v[i] * 4, b = v[i + 1 < to ? i + 1 : from] * 4;
                area += clip[a] / clip[a + 3] * (clip[b + 1] / clip[b + 3]) -
                    clip[b] / clip[b + 3] * (clip[a + 1] / clip[a + 3]);
            }
        } else {
            const o = v[from] * 4;
            for (let i = from + 1; i + 1 < to; ++i) {
                const a = v[i] * 4, b = v[i + 1] * 4;
                area += clip[o] * (clip[a + 1] * clip[b + 3] - clip[a + 3] * clip[b + 1]) -
                    clip[o + 1] * (clip[a] * clip[b + 3] - clip[a + 3] * clip[b]) +
                    clip[o + 3] * (clip[a] * clip[b + 1] - clip[a + 1] * clip[b]);
            }
        }
        return (area >= 0) === (frontFace !== GL.CW);
    }

    /* ================================================================== */
    /* Pixel formats                                                      */
    /* ================================================================== */

    /*
     * GL's texture formats are three loosely coupled parameters: the internal
     * format says what is stored, and (format, type) say how the bytes arriving
     * from the guest are laid out. WebGPU has one format per texture, so both
     * halves are resolved here: incoming rows are converted to the storage
     * format, and the *base* internal format is remembered because the fixed
     * pipeline's texture environment depends on it.
     *
     * The channel expansion is the part worth getting exactly right:
     *   ALPHA           -> (0, 0, 0, a)
     *   LUMINANCE       -> (l, l, l, 1)
     *   LUMINANCE_ALPHA -> (l, l, l, a)
     *   INTENSITY       -> (i, i, i, i)
     *   RGB             -> (r, g, b, 1)
     * Every one of those is a rule from the GL spec's texture-sampling table,
     * and getting one wrong is a colour shift nobody can trace back to here.
     */

    const { BASE_INTERNAL_FORMATS, COMPRESSED_FORMATS, PROXY_TARGETS, storageFormatFor, renderbufferFormatFor } =
        nodeRequire ? nodeRequire("./gl_image_formats.js") : global.GLImageFormats;

    function quantize(pixels, bits) {
        const tables = bits.map(b => {
            const table = new Uint8Array(256);
            const levels = (1 << b) - 1;
            for (let v = 0; v < 256; ++v) table[v] = expandBits(Math.round(v * levels / 255), b);
            return table;
        });
        for (let i = 0; i < pixels.length; i += 4)
            for (let c = 0; c < 4; ++c) pixels[i + c] = tables[c][pixels[i + c]];
    }

    /* Components per texel in the *source* data, by format. */
    const SOURCE_COMPONENTS = {
        [GL.RED]: 1, [GL.GREEN]: 1, [GL.BLUE]: 1, [GL.ALPHA]: 1,
        [GL.LUMINANCE]: 1, [GL.INTENSITY]: 1, [GL.DEPTH_COMPONENT]: 1,
        [GL.COLOR_INDEX]: 1, [GL.STENCIL_INDEX]: 1,
        [GL.LUMINANCE_ALPHA]: 2,
        [GL.RGB]: 3, [GL.BGR]: 3,
        [GL.RGBA]: 4, [GL.BGRA]: 4, [GL.ABGR_EXT]: 4,
    };

    const TYPE_BYTES = {
        [GL.UNSIGNED_BYTE]: 1, [GL.BYTE]: 1,
        [GL.UNSIGNED_SHORT]: 2, [GL.SHORT]: 2,
        [GL.HALF_FLOAT]: 2,
        [GL.UNSIGNED_INT]: 4, [GL.INT]: 4, [GL.FLOAT]: 4,
        [GL.UNSIGNED_BYTE_3_3_2]: 1, [GL.UNSIGNED_BYTE_2_3_3_REV]: 1,
        [GL.UNSIGNED_SHORT_5_6_5]: 2, [GL.UNSIGNED_SHORT_5_6_5_REV]: 2,
        [GL.UNSIGNED_SHORT_4_4_4_4]: 2, [GL.UNSIGNED_SHORT_4_4_4_4_REV]: 2,
        [GL.UNSIGNED_SHORT_5_5_5_1]: 2, [GL.UNSIGNED_SHORT_1_5_5_5_REV]: 2,
        [GL.UNSIGNED_INT_8_8_8_8]: 4, [GL.UNSIGNED_INT_8_8_8_8_REV]: 4,
        [GL.UNSIGNED_INT_10_10_10_2]: 4, [GL.UNSIGNED_INT_2_10_10_10_REV]: 4,
    };

    const PACKED_TYPES = new Set([
        GL.UNSIGNED_BYTE_3_3_2, GL.UNSIGNED_BYTE_2_3_3_REV,
        GL.UNSIGNED_SHORT_5_6_5, GL.UNSIGNED_SHORT_5_6_5_REV,
        GL.UNSIGNED_SHORT_4_4_4_4, GL.UNSIGNED_SHORT_4_4_4_4_REV,
        GL.UNSIGNED_SHORT_5_5_5_1, GL.UNSIGNED_SHORT_1_5_5_5_REV,
        GL.UNSIGNED_INT_8_8_8_8, GL.UNSIGNED_INT_8_8_8_8_REV,
        GL.UNSIGNED_INT_10_10_10_2, GL.UNSIGNED_INT_2_10_10_10_REV,
    ]);

    function sourceTexelBytes(format, type) {
        const typeBytes = TYPE_BYTES[type];
        if (typeBytes === undefined) return 0;
        if (PACKED_TYPES.has(type)) return typeBytes;
        const components = SOURCE_COMPONENTS[format];
        if (components === undefined) return 0;
        return components * typeBytes;
    }

    function expandBits(value, bits) {
        // Replicating the high bits is GL's rule for widening a packed
        // component, and it is why 5-bit 31 becomes 255 and not 248.
        // Each copy goes right below the last one (3-bit 7 was 231 and 1-bit
        // 1 was 129: the copies were all put at the bottom).
        if (bits >= 8) return (value >>> (bits - 8)) & 0xff;
        let out = 0;
        for (let at = 8 - bits; at > -bits; at -= bits)
            out |= at >= 0 ? value << at : value >>> -at;
        return out & 0xff;
    }

    /*
     * Reads one source texel into out[0..3] as 0..255, applying the source
     * format's channel meaning but not the internal format's expansion. A
     * packed type's fields are the format's components in order -- BGRA's
     * first is blue (review S2-22: they were taken as RGBA) -- and `swap`
     * is UNPACK_SWAP_BYTES, which reverses each multi-byte element.
     */
    function readSourceTexel(view, byteOffset, format, type, out, swap) {
        const little = !swap;
        const c = [0, 0, 0, 255];
        let components;
        if (PACKED_TYPES.has(type)) {
            let raw;
            switch (TYPE_BYTES[type]) {
            case 1: raw = view.getUint8(byteOffset); break;
            case 2: raw = view.getUint16(byteOffset, little); break;
            default: raw = view.getUint32(byteOffset, little); break;
            }
            components = 4;
            switch (type) {
            case GL.UNSIGNED_BYTE_3_3_2:
                c[0] = expandBits((raw >> 5) & 7, 3); c[1] = expandBits((raw >> 2) & 7, 3);
                c[2] = expandBits(raw & 3, 2); components = 3; break;
            case GL.UNSIGNED_BYTE_2_3_3_REV:
                c[0] = expandBits(raw & 7, 3); c[1] = expandBits((raw >> 3) & 7, 3);
                c[2] = expandBits((raw >> 6) & 3, 2); components = 3; break;
            case GL.UNSIGNED_SHORT_5_6_5:
                c[0] = expandBits((raw >> 11) & 31, 5); c[1] = expandBits((raw >> 5) & 63, 6);
                c[2] = expandBits(raw & 31, 5); components = 3; break;
            case GL.UNSIGNED_SHORT_5_6_5_REV:
                c[0] = expandBits(raw & 31, 5); c[1] = expandBits((raw >> 5) & 63, 6);
                c[2] = expandBits((raw >> 11) & 31, 5); components = 3; break;
            case GL.UNSIGNED_SHORT_4_4_4_4:
                c[0] = expandBits((raw >> 12) & 15, 4); c[1] = expandBits((raw >> 8) & 15, 4);
                c[2] = expandBits((raw >> 4) & 15, 4); c[3] = expandBits(raw & 15, 4); break;
            case GL.UNSIGNED_SHORT_4_4_4_4_REV:
                c[0] = expandBits(raw & 15, 4); c[1] = expandBits((raw >> 4) & 15, 4);
                c[2] = expandBits((raw >> 8) & 15, 4); c[3] = expandBits((raw >> 12) & 15, 4); break;
            case GL.UNSIGNED_SHORT_5_5_5_1:
                c[0] = expandBits((raw >> 11) & 31, 5); c[1] = expandBits((raw >> 6) & 31, 5);
                c[2] = expandBits((raw >> 1) & 31, 5); c[3] = (raw & 1) ? 255 : 0; break;
            case GL.UNSIGNED_SHORT_1_5_5_5_REV:
                c[0] = expandBits(raw & 31, 5); c[1] = expandBits((raw >> 5) & 31, 5);
                c[2] = expandBits((raw >> 10) & 31, 5); c[3] = (raw & 0x8000) ? 255 : 0; break;
            case GL.UNSIGNED_INT_8_8_8_8:
                c[0] = (raw >>> 24) & 0xff; c[1] = (raw >>> 16) & 0xff;
                c[2] = (raw >>> 8) & 0xff; c[3] = raw & 0xff; break;
            case GL.UNSIGNED_INT_8_8_8_8_REV:
                c[0] = raw & 0xff; c[1] = (raw >>> 8) & 0xff;
                c[2] = (raw >>> 16) & 0xff; c[3] = (raw >>> 24) & 0xff; break;
            case GL.UNSIGNED_INT_10_10_10_2:
                c[0] = expandBits((raw >>> 22) & 1023, 10); c[1] = expandBits((raw >>> 12) & 1023, 10);
                c[2] = expandBits((raw >>> 2) & 1023, 10); c[3] = expandBits(raw & 3, 2); break;
            default:  // UNSIGNED_INT_2_10_10_10_REV
                c[0] = expandBits(raw & 1023, 10); c[1] = expandBits((raw >>> 10) & 1023, 10);
                c[2] = expandBits((raw >>> 20) & 1023, 10); c[3] = expandBits((raw >>> 30) & 3, 2); break;
            }
        } else {
            const typeBytes = TYPE_BYTES[type];
            components = SOURCE_COMPONENTS[format] || 1;
            for (let i = 0; i < components; ++i) {
                const at = byteOffset + i * typeBytes;
                switch (type) {
                case GL.UNSIGNED_BYTE: c[i] = view.getUint8(at); break;
                case GL.BYTE: c[i] = clamp(view.getInt8(at), 0, 127) * 2; break;
                case GL.UNSIGNED_SHORT: c[i] = view.getUint16(at, little) >>> 8; break;
                case GL.SHORT: c[i] = clamp(view.getInt16(at, little), 0, 32767) >>> 7; break;
                case GL.UNSIGNED_INT: c[i] = view.getUint32(at, little) >>> 24; break;
                case GL.INT: c[i] = clamp(view.getInt32(at, little), 0, 0x7fffffff) >>> 23; break;
                case GL.FLOAT: c[i] = clamp(Math.round(view.getFloat32(at, little) * 255), 0, 255); break;
                default: c[i] = 0;
                }
            }
        }

        switch (format) {
        case GL.RED: out[0] = c[0]; out[1] = 0; out[2] = 0; out[3] = 255; return;
        case GL.GREEN: out[0] = 0; out[1] = c[0]; out[2] = 0; out[3] = 255; return;
        case GL.BLUE: out[0] = 0; out[1] = 0; out[2] = c[0]; out[3] = 255; return;
        case GL.ALPHA: out[0] = 0; out[1] = 0; out[2] = 0; out[3] = c[0]; return;
        case GL.LUMINANCE:
        case GL.INTENSITY:
        case GL.DEPTH_COMPONENT:
        case GL.COLOR_INDEX:
        case GL.STENCIL_INDEX:
            out[0] = c[0]; out[1] = c[0]; out[2] = c[0]; out[3] = 255; return;
        case GL.LUMINANCE_ALPHA:
            out[0] = c[0]; out[1] = c[0]; out[2] = c[0]; out[3] = c[1]; return;
        case GL.RGB: out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = 255; return;
        case GL.BGR: out[0] = c[2]; out[1] = c[1]; out[2] = c[0]; out[3] = 255; return;
        case GL.RGBA: out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = c[3]; return;
        case GL.BGRA: out[0] = c[2]; out[1] = c[1]; out[2] = c[0]; out[3] = c[3]; return;
        case GL.ABGR_EXT: out[0] = c[3]; out[1] = c[2]; out[2] = c[1]; out[3] = c[0]; return;
        default: out[0] = c[0]; out[1] = components > 1 ? c[1] : 0; out[2] = components > 2 ? c[2] : 0;
                 out[3] = components > 3 ? c[3] : 255;
        }
    }

    // The pixel store's unpack state as convertPixels takes it
    function unpackState(store) {
        return {
            rowLength: store.unpackRowLength, skipPixels: store.unpackSkipPixels, skipRows: store.unpackSkipRows,
            skipImages: store.unpackSkipImages, imageHeight: store.unpackImageHeight,
            alignment: store.unpackAlignment, swapBytes: !!store.unpackSwapBytes,
        };
    }

    /* Applies the internal base format's expansion, in place. */
    function applyBaseFormat(base, texel) {
        switch (base) {
        case "ALPHA":
            texel[0] = 0; texel[1] = 0; texel[2] = 0;
            return;
        case "LUMINANCE":
            texel[1] = texel[0]; texel[2] = texel[0]; texel[3] = 255;
            return;
        case "LUMINANCE_ALPHA":
            texel[1] = texel[0]; texel[2] = texel[0];
            return;
        case "INTENSITY":
            texel[1] = texel[0]; texel[2] = texel[0]; texel[3] = texel[0];
            return;
        case "RGB":
            texel[3] = 255;
            break;
        default:

        }
    }

    /*
     * Converts a rectangle of guest pixel data into tightly packed RGBA8 rows.
     *
     * The fast path exists because it is the one every game actually uses:
     * GL_RGBA/GL_UNSIGNED_BYTE into an RGBA internal format is a memcpy, and
     * routing a 1024x1024 texture through the per-texel reader instead would
     * be visible as a hitch on every level load.
     */
    function convertPixels(source, byteOffset, width, height, depth,
            format, type, base, unpack) {
        const rowLength = unpack.rowLength || width;
        const skipPixels = unpack.skipPixels || 0;
        const skipRows = unpack.skipRows || 0;
        const skipImages = unpack.skipImages || 0;
        const alignment = unpack.alignment || 4;
        const texelBytes = sourceTexelBytes(format, type);
        if (!texelBytes) return null;
        const srcRowBytes = alignUp(rowLength * texelBytes, alignment);
        const imageHeight = unpack.imageHeight || height;
        const out = new Uint8Array(width * height * depth * 4);
        // The view is relative to `source`, so every offset below is too --
        // mixing in source.byteOffset would double-count it for any subarray.
        const view = new DataView(source.buffer, source.byteOffset,
            source.byteLength);
        const limit = source.byteLength;

        const swap = !!unpack.swapBytes;
        const fastCopy = type === GL.UNSIGNED_BYTE && format === GL.RGBA &&
            base === "RGBA";
        const fastBGRA = type === GL.UNSIGNED_BYTE && format === GL.BGRA &&
            base === "RGBA";
        const fastRGB = type === GL.UNSIGNED_BYTE && format === GL.RGB &&
            (base === "RGB" || base === "RGBA");

        const texel = new Uint8Array(4);
        for (let z = 0; z < depth; ++z) {
            for (let y = 0; y < height; ++y) {
                let src = byteOffset +
                    (skipImages + z) * imageHeight * srcRowBytes +
                    (skipRows + y) * srcRowBytes + skipPixels * texelBytes;
                let dst = ((z * height + y) * width) * 4;
                // A record short of the rows its unpack state says (the last
                // row's alignment padding, which applications often do not
                // allocate) leaves those texels zero rather than losing the
                // image (review S2-22's 3_3_2 case)
                if (src + width * texelBytes > limit) {
                    for (let x = 0; x < width && src + texelBytes <= limit; ++x) {
                        readSourceTexel(view, src, format, type, texel, swap);
                        applyBaseFormat(base, texel);
                        out.set(texel, dst);
                        src += texelBytes; dst += 4;
                    }
                    continue;
                }
                if (fastCopy) {
                    out.set(source.subarray(src, src + width * 4), dst);
                    continue;
                }
                if (fastBGRA) {
                    for (let x = 0; x < width; ++x) {
                        out[dst] = view.getUint8(src + 2);
                        out[dst + 1] = view.getUint8(src + 1);
                        out[dst + 2] = view.getUint8(src);
                        out[dst + 3] = view.getUint8(src + 3);
                        src += 4; dst += 4;
                    }
                    continue;
                }
                if (fastRGB) {
                    for (let x = 0; x < width; ++x) {
                        out[dst] = view.getUint8(src);
                        out[dst + 1] = view.getUint8(src + 1);
                        out[dst + 2] = view.getUint8(src + 2);
                        out[dst + 3] = 255;
                        src += 3; dst += 4;
                    }
                    continue;
                }
                for (let x = 0; x < width; ++x) {
                    readSourceTexel(view, src, format, type, texel, swap);
                    applyBaseFormat(base, texel);
                    out[dst] = texel[0]; out[dst + 1] = texel[1];
                    out[dst + 2] = texel[2]; out[dst + 3] = texel[3];
                    src += texelBytes; dst += 4;
                }
            }
        }
        return out;
    }

    function halfToFloat(value) {
        const sign = (value & 0x8000) ? -1 : 1;
        const exponent = (value >>> 10) & 0x1f;
        const fraction = value & 0x3ff;
        if (!exponent) return sign * Math.pow(2, -14) * (fraction / 1024);
        if (exponent === 31) return fraction ? NaN : sign * Infinity;
        return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
    }

    function floatToHalf(value) {
        if (Number.isNaN(value)) return 0x7e00;
        const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
        const absolute = Math.abs(value);
        if (absolute === Infinity) return sign | 0x7c00;
        if (absolute === 0) return sign;
        let exponent = Math.floor(Math.log2(absolute));
        let mantissa = absolute / Math.pow(2, exponent) - 1;
        if (exponent < -14) {
            const subnormal = Math.round(absolute / Math.pow(2, -24));
            return sign | Math.min(0x3ff, subnormal);
        }
        if (exponent > 15) return sign | 0x7c00;
        let fraction = Math.round(mantissa * 1024);
        if (fraction === 1024) { fraction = 0; ++exponent; }
        if (exponent > 15) return sign | 0x7c00;
        return sign | ((exponent + 15) << 10) | (fraction & 0x3ff);
    }

    function readSourceTexelFloat(view, byteOffset, format, type, out, swap) {
        if (PACKED_TYPES.has(type)) {
            const bytes = new Uint8Array(4);
            readSourceTexel(view, byteOffset, format, type, bytes, swap);
            for (let i = 0; i < 4; ++i) out[i] = bytes[i] / 255;
            return;
        }
        const typeBytes = TYPE_BYTES[type];
        const components = SOURCE_COMPONENTS[format] || 1;
        const read = i => {
            const at = byteOffset + i * typeBytes;
            switch (type) {
            case GL.UNSIGNED_BYTE: return view.getUint8(at) / 255;
            case GL.BYTE: return Math.max(view.getInt8(at) / 127, -1);
            case GL.UNSIGNED_SHORT: return view.getUint16(at, !swap) / 65535;
            case GL.SHORT: return Math.max(view.getInt16(at, !swap) / 32767, -1);
            case GL.UNSIGNED_INT: return view.getUint32(at, !swap) / 4294967295;
            case GL.INT: return Math.max(view.getInt32(at, !swap) / 2147483647, -1);
            case GL.FLOAT: return view.getFloat32(at, !swap);
            case GL.HALF_FLOAT: return halfToFloat(view.getUint16(at, !swap));
            default: return 0;
            }
        };
        const c = [];
        for (let i = 0; i < components; ++i) c.push(read(i));
        out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
        switch (format) {
        case GL.RED: out[0] = c[0]; break;
        case GL.GREEN: out[1] = c[0]; break;
        case GL.BLUE: out[2] = c[0]; break;
        case GL.ALPHA: out[3] = c[0]; break;
        case GL.LUMINANCE: out[0] = out[1] = out[2] = c[0]; break;
        case GL.INTENSITY: out[0] = out[1] = out[2] = out[3] = c[0]; break;
        case GL.DEPTH_COMPONENT:
        case GL.COLOR_INDEX:
        case GL.STENCIL_INDEX: out[0] = out[1] = out[2] = c[0]; break;
        case GL.LUMINANCE_ALPHA:
            out[0] = out[1] = out[2] = c[0]; out[3] = c[1]; break;
        case GL.RGB: out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; break;
        case GL.BGR: out[0] = c[2]; out[1] = c[1]; out[2] = c[0]; break;
        case GL.RGBA: out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = c[3]; break;
        case GL.BGRA: out[0] = c[2]; out[1] = c[1]; out[2] = c[0]; out[3] = c[3]; break;
        case GL.ABGR_EXT:
            out[0] = c[3]; out[1] = c[2]; out[2] = c[1]; out[3] = c[0]; break;
        default:
            for (let i = 0; i < Math.min(4, c.length); ++i) out[i] = c[i];
        }
    }

    function convertPixelsForStorage(source, byteOffset, width, height, depth,
            format, type, storage, unpack) {
        if (!storage.float && !storage.depth && !storage.palettised) {
            const pixels = convertPixels(source, byteOffset, width, height, depth,
                format, type, storage.base, unpack);
            if (pixels && storage.bits) quantize(pixels, storage.bits);
            return pixels ? { pixels, bytesPerTexel: 4, componentType: "u8",
                               componentCount: 4 } : null;
        }
        const texelBytes = sourceTexelBytes(format, type);
        if (!texelBytes) return null;
        const rowLength = unpack.rowLength || width;
        const skipPixels = unpack.skipPixels || 0;
        const skipRows = unpack.skipRows || 0;
        const skipImages = unpack.skipImages || 0;
        const alignment = unpack.alignment || 4;
        const srcRowBytes = alignUp(rowLength * texelBytes, alignment);
        const imageHeight = unpack.imageHeight || height;
        const texels = width * height * depth;
        let bytesPerTexel, componentType, componentCount, result, output;
        if (storage.palettised) {
            bytesPerTexel = 1; componentType = "u8"; componentCount = 1;
            result = new Uint8Array(texels); output = result;
        } else if (storage.gpu === "rgba16float") {
            bytesPerTexel = 8; componentType = "f16"; componentCount = 4;
            result = new Uint8Array(texels * bytesPerTexel);
            output = new Uint16Array(result.buffer);
        } else if (storage.gpu === "rgba32float") {
            bytesPerTexel = 16; componentType = "f32"; componentCount = 4;
            result = new Uint8Array(texels * bytesPerTexel);
            output = new Float32Array(result.buffer);
        } else if (storage.gpu === "depth16unorm") {
            bytesPerTexel = 2; componentType = "u16"; componentCount = 1;
            result = new Uint8Array(texels * bytesPerTexel);
            output = new Uint16Array(result.buffer);
        } else {
            bytesPerTexel = 4; componentType = "f32"; componentCount = 1;
            result = new Uint8Array(texels * bytesPerTexel);
            output = new Float32Array(result.buffer);
        }
        const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
        const texel = new Float32Array(4);
        let dst = 0;
        for (let z = 0; z < depth; ++z) {
            for (let y = 0; y < height; ++y) {
                let src = byteOffset + (skipImages + z) * imageHeight * srcRowBytes +
                    (skipRows + y) * srcRowBytes + skipPixels * texelBytes;
                if (src + width * texelBytes > source.byteLength) return null;
                for (let x = 0; x < width; ++x) {
                    readSourceTexelFloat(view, src, format, type, texel, unpack.swapBytes);
                    if (storage.palettised) {
                        output[dst++] = clamp(Math.round(texel[0] * 255), 0, 255);
                    } else if (componentCount === 1) {
                        const value = clamp(texel[0], 0, 1);
                        output[dst++] = componentType === "u16" ?
                            Math.round(value * 65535) : value;
                    } else {
                        for (let c = 0; c < 4; ++c)
                            output[dst++] = componentType === "f16" ?
                                floatToHalf(texel[c]) : texel[c];
                    }
                    src += texelBytes;
                }
            }
        }
        return { pixels: result, bytesPerTexel, componentType, componentCount };
    }

    /* ---- S3TC decode, used when the adapter has no BC support ---- */

    function decodeDXTColorBlock(src, at, out, outStride, x0, y0, width, height,
            dxt1Alpha) {
        const c0 = src[at] | (src[at + 1] << 8);
        const c1 = src[at + 2] | (src[at + 3] << 8);
        const palette = new Uint8Array(16);
        const unpack565 = (c, i) => {
            palette[i] = expandBits((c >> 11) & 31, 5);
            palette[i + 1] = expandBits((c >> 5) & 63, 6);
            palette[i + 2] = expandBits(c & 31, 5);
            palette[i + 3] = 255;
        };
        unpack565(c0, 0);
        unpack565(c1, 4);
        if (c0 > c1 || !dxt1Alpha) {
            for (let k = 0; k < 3; ++k) {
                palette[8 + k] = (2 * palette[k] + palette[4 + k] + 1) / 3 | 0;
                palette[12 + k] = (palette[k] + 2 * palette[4 + k] + 1) / 3 | 0;
            }
            palette[11] = 255; palette[15] = 255;
        } else {
            for (let k = 0; k < 3; ++k)
                palette[8 + k] = (palette[k] + palette[4 + k]) >> 1;
            palette[11] = 255;
            palette[12] = 0; palette[13] = 0; palette[14] = 0; palette[15] = 0;
        }
        const bits = src[at + 4] | (src[at + 5] << 8) | (src[at + 6] << 16) |
            (src[at + 7] << 24);
        for (let y = 0; y < 4; ++y) {
            for (let x = 0; x < 4; ++x) {
                const px = x0 + x, py = y0 + y;
                if (px >= width || py >= height) continue;
                const index = (bits >>> (2 * (4 * y + x))) & 3;
                const o = py * outStride + px * 4;
                out[o] = palette[index * 4];
                out[o + 1] = palette[index * 4 + 1];
                out[o + 2] = palette[index * 4 + 2];
                out[o + 3] = palette[index * 4 + 3];
            }
        }
    }

    function decodeDXT(dxt, src, width, height) {
        const out = new Uint8Array(width * height * 4);
        const stride = width * 4;
        const blockBytes = dxt === 1 ? 8 : 16;
        const blocksX = Math.ceil(width / 4);
        const blocksY = Math.ceil(height / 4);
        let at = 0;
        for (let by = 0; by < blocksY; ++by) {
            for (let bx = 0; bx < blocksX; ++bx) {
                const x0 = bx * 4, y0 = by * 4;
                if (dxt === 1) {
                    decodeDXTColorBlock(src, at, out, stride, x0, y0,
                        width, height, true);
                } else {
                    decodeDXTColorBlock(src, at + 8, out, stride, x0, y0,
                        width, height, false);
                    if (dxt === 3) {
                        for (let y = 0; y < 4; ++y) {
                            for (let x = 0; x < 4; ++x) {
                                const px = x0 + x, py = y0 + y;
                                if (px >= width || py >= height) continue;
                                const nibble = at + y * 2 + (x >> 1);
                                const value = (x & 1) ? (src[nibble] >> 4) :
                                    (src[nibble] & 15);
                                out[py * stride + px * 4 + 3] = expandBits(value, 4);
                            }
                        }
                    } else {
                        const a0 = src[at], a1 = src[at + 1];
                        const alpha = new Uint8Array(8);
                        alpha[0] = a0; alpha[1] = a1;
                        if (a0 > a1) {
                            for (let k = 1; k < 7; ++k)
                                alpha[k + 1] = ((7 - k) * a0 + k * a1 + 3) / 7 | 0;
                        } else {
                            for (let k = 1; k < 5; ++k)
                                alpha[k + 1] = ((5 - k) * a0 + k * a1 + 2) / 5 | 0;
                            alpha[6] = 0; alpha[7] = 255;
                        }
                        let low = src[at + 2] | (src[at + 3] << 8) |
                            (src[at + 4] << 16);
                        let high = src[at + 5] | (src[at + 6] << 8) |
                            (src[at + 7] << 16);
                        for (let y = 0; y < 4; ++y) {
                            for (let x = 0; x < 4; ++x) {
                                const px = x0 + x, py = y0 + y;
                                if (px >= width || py >= height) continue;
                                const bit = 3 * (4 * y + x);
                                const value = bit < 24 ?
                                    (low >>> bit) & 7 :
                                    (high >>> (bit - 24)) & 7;
                                out[py * stride + px * 4 + 3] = alpha[value];
                            }
                        }
                    }
                }
                at += blockBytes;
            }
        }
        return out;
    }

    /* ================================================================== */
    /* GL context state                                                   */
    /* ================================================================== */

    function cloneStateValue(value) {
        if (value === null || value === undefined || typeof value !== "object")
            return value;
        if (ArrayBuffer.isView(value)) return new value.constructor(value);
        if (value instanceof Set) return new Set(value);
        if (Array.isArray(value)) return value.map(cloneStateValue);
        const copy = Object.create(Object.getPrototypeOf(value) === null ? null :
            Object.prototype);
        for (const key of Object.keys(value)) copy[key] = cloneStateValue(value[key]);
        return copy;
    }

    function snapshotFields(state, fields) {
        const snapshot = Object.create(null);
        for (const field of fields) snapshot[field] = cloneStateValue(state[field]);
        return snapshot;
    }

    function restoreFields(state, snapshot, fields) {
        for (const field of fields)
            if (Object.prototype.hasOwnProperty.call(snapshot, field))
                state[field] = cloneStateValue(snapshot[field]);
    }

    const SERVER_ATTRIB_FIELDS = [
        [ATTRIB.CURRENT, ["current"]],
        [ATTRIB.POINT, ["pointSize", "point"]],
        [ATTRIB.LINE, ["lineWidth", "lineStipple"]],
        [ATTRIB.POLYGON, ["cullFace", "frontFace", "polygonMode", "polygonOffset"]],
        [ATTRIB.POLYGON_STIPPLE, ["polygonStipple"]],
        [ATTRIB.PIXEL_MODE, ["pixelTransfer", "pixelZoom", "pixelMaps", "readBuffer"]],
        [ATTRIB.LIGHTING, ["lightModel", "lights", "material", "colorMaterial",
                           "shadeModel"]],
        [ATTRIB.FOG, ["fog"]],
        [ATTRIB.DEPTH_BUFFER, ["depthFunc", "depthMask", "clearDepth"]],
        [ATTRIB.ACCUM_BUFFER, ["clearAccum"]],
        [ATTRIB.STENCIL_BUFFER, ["stencil", "clearStencil"]],
        [ATTRIB.VIEWPORT, ["viewport", "depthRange"]],
        [ATTRIB.TRANSFORM, ["matrixMode", "clipPlanes"]],
        [ATTRIB.COLOR_BUFFER, ["clearColor", "colorMask", "blend", "alphaFunc",
                              "logicOp", "drawBuffers"]],
        [ATTRIB.TEXTURE, ["activeTexture", "textureUnits"]],
        [ATTRIB.SCISSOR, ["scissor"]],
        [ATTRIB.MULTISAMPLE, ["sampleCoverage"]],
    ];

    function fieldsForServerAttrib(mask) {
        const fields = new Set();
        for (const [bit, names] of SERVER_ATTRIB_FIELDS)
            if (mask & bit) for (const name of names) fields.add(name);
        if (mask & ATTRIB.ENABLE) fields.add("enabled");
        return [...fields];
    }

    function captureEnableState(state) {
        return {
            enabled: new Set(state.enabled),
            textureTargets: state.textureUnits.map(unit => new Set(unit.enabledTargets)),
            texGen: state.textureUnits.map(unit => unit.texGen.map(gen => gen.enabled)),
            lights: state.lights.map(light => light.enabled),
            colorMaterial: state.colorMaterial.enabled,
        };
    }

    function restoreEnableState(state, snapshot) {
        state.enabled = new Set(snapshot.enabled);
        state.textureUnits.forEach((unit, i) => {
            unit.enabledTargets = new Set(snapshot.textureTargets[i]);
            unit.texGen.forEach((gen, j) => { gen.enabled = snapshot.texGen[i][j]; });
        });
        state.lights.forEach((light, i) => { light.enabled = snapshot.lights[i]; });
        state.colorMaterial.enabled = snapshot.colorMaterial;
    }

    /*
     * One of these per wglCreateContext. Everything the GL spec calls "server
     * state" lives here, at its documented default -- and the defaults matter:
     * a game that never calls glDepthFunc expects GL_LESS, and a wrong default
     * shows up as a subtly wrong picture in exactly the titles that touch the
     * least state.
     */
    function createContextState(id, shareGroup) {
        const state = {
            id, shareGroup,

            matrixMode: GL.MODELVIEW,
            stacks: {
                [GL.MODELVIEW]: [identity4()],
                [GL.PROJECTION]: [identity4()],
                [GL.COLOR]: [identity4()],
                ...Object.fromEntries(Array.from({ length: glCaps.LIMITS.MAX_PROGRAM_MATRICES }, (_, i) => [GL.MATRIX0_ARB + i, [identity4()]])),
            },
            textureStacks: Array.from({ length: MAX_TEXTURE_COORDS },
                () => [identity4()]),

            current: {
                color: new Float32Array([1, 1, 1, 1]),
                secondaryColor: new Float32Array([0, 0, 0, 1]),
                normal: new Float32Array([0, 0, 1]),
                fogCoord: 0,
                edgeFlag: true,
                texCoord: Array.from({ length: MAX_TEXTURE_COORDS },
                    () => new Float32Array([0, 0, 0, 1])),
                rasterPos: new Float32Array([0, 0, 0, 1]),
                // the colour when the raster position was set (GL 2.1 2.13)
                rasterColor: new Float32Array([1, 1, 1, 1]),
                rasterSecondaryColor: new Float32Array([0, 0, 0, 1]),
                rasterDistance: 0, rasterFogCoord: 0,
                rasterTexCoord: Array.from({ length: MAX_TEXTURE_COORDS }, () => new Float32Array([0, 0, 0, 1])),
                rasterValid: true,
            },

            enabled: new Set(),

            viewport: { x: 0, y: 0, width: 0, height: 0 },
            depthRange: { near: 0, far: 1 },
            scissor: { x: 0, y: 0, width: 0, height: 0, set: false },

            clearColor: new Float32Array([0, 0, 0, 0]),
            clearDepth: 1,
            clearStencil: 0,
            clearAccum: new Float32Array([0, 0, 0, 0]),

            depthFunc: GL.LESS,
            depthMask: true,
            colorMask: [true, true, true, true],
            stencil: {
                front: { func: GL.ALWAYS, ref: 0, valueMask: 0xffffffff,
                         writeMask: 0xffffffff, fail: GL.KEEP,
                         zfail: GL.KEEP, zpass: GL.KEEP },
                back: { func: GL.ALWAYS, ref: 0, valueMask: 0xffffffff,
                        writeMask: 0xffffffff, fail: GL.KEEP,
                        zfail: GL.KEEP, zpass: GL.KEEP },
            },
            blend: {
                srcRGB: GL.ONE, dstRGB: GL.ZERO,
                srcAlpha: GL.ONE, dstAlpha: GL.ZERO,
                equationRGB: GL.FUNC_ADD, equationAlpha: GL.FUNC_ADD,
                color: new Float32Array([0, 0, 0, 0]),
            },
            alphaFunc: { func: GL.ALWAYS, ref: 0 },
            logicOp: GL.COPY,
            cullFace: GL.BACK,
            frontFace: GL.CCW,
            polygonMode: { front: GL.FILL, back: GL.FILL },
            polygonOffset: { factor: 0, units: 0 },
            shadeModel: GL.SMOOTH,
            lineWidth: 1,
            lineStipple: { pattern: 0xffff, factor: 1 },
            polygonStipple: new Uint8Array(128).fill(0xff),
            pointSize: 1,
            point: {
                size: 1, sizeMin: 0, sizeMax: 64, fadeThreshold: 1,
                attenuation: new Float32Array([1, 0, 0]),
                spriteCoordOrigin: GL.UPPER_LEFT,
            },
            sampleCoverage: { value: 1, invert: false },

            lightModel: {
                ambient: new Float32Array([0.2, 0.2, 0.2, 1]),
                twoSide: false,
                localViewer: false,
                colorControl: GL.SINGLE_COLOR,
            },
            lights: Array.from({ length: MAX_LIGHTS }, (unused, i) => ({
                enabled: false,
                ambient: new Float32Array([0, 0, 0, 1]),
                diffuse: new Float32Array(i === 0 ? [1, 1, 1, 1] : [0, 0, 0, 1]),
                specular: new Float32Array(i === 0 ? [1, 1, 1, 1] : [0, 0, 0, 1]),
                position: new Float32Array([0, 0, 1, 0]),
                spotDirection: new Float32Array([0, 0, -1]),
                spotExponent: 0,
                spotCutoff: 180,
                constantAttenuation: 1,
                linearAttenuation: 0,
                quadraticAttenuation: 0,
                // Eye-space copies, refreshed when the light or the modelview
                // changes: GL specifies that glLight* captures the modelview in
                // force at the time of the call.
                eyePosition: new Float32Array([0, 0, 1, 0]),
                eyeSpotDirection: new Float32Array([0, 0, -1]),
            })),
            material: {
                front: newMaterial(), back: newMaterial(),
            },
            colorMaterial: { enabled: false, face: GL.FRONT_AND_BACK,
                             mode: GL.AMBIENT_AND_DIFFUSE },

            fog: {
                mode: GL.EXP, density: 1, start: 0, end: 1,
                color: new Float32Array([0, 0, 0, 0]),
                coordSource: GL.FRAGMENT_DEPTH,
            },

            clipPlanes: Array.from({ length: MAX_CLIP_PLANES },
                () => new Float32Array([0, 0, 0, 0])),

            activeTexture: 0,
            clientActiveTexture: 0,
            textureUnits: Array.from({ length: MAX_TEXTURE_UNITS }, () => ({
                bindings: Object.create(null),   // target -> texture name
                imageBindings: Object.create(null), // target -> retained object identity
                enabledTargets: new Set(),
                env: newTexEnv(),
                texGen: Array.from({ length: 4 }, (unused, i) => ({
                    enabled: false,
                    mode: GL.EYE_LINEAR,
                    objectPlane: new Float32Array(
                        i === 0 ? [1, 0, 0, 0] : (i === 1 ? [0, 1, 0, 0] : [0, 0, 0, 0])),
                    eyePlane: new Float32Array(
                        i === 0 ? [1, 0, 0, 0] : (i === 1 ? [0, 1, 0, 0] : [0, 0, 0, 0])),
                })),
                lodBias: 0,
            })),

            pixelStore: {
                unpackAlignment: 4, unpackRowLength: 0, unpackSkipPixels: 0,
                unpackSkipRows: 0, unpackSkipImages: 0, unpackImageHeight: 0,
                unpackSwapBytes: false, unpackLsbFirst: false,
                packAlignment: 4, packRowLength: 0, packSkipPixels: 0,
                packSkipRows: 0, packSkipImages: 0, packImageHeight: 0, packSwapBytes: false, packLsbFirst: false,
            },
            pixelTransfer: { redScale: 1, greenScale: 1, blueScale: 1,
                             alphaScale: 1, redBias: 0, greenBias: 0,
                             blueBias: 0, alphaBias: 0, mapColor: false,
                             postColorMatrixScale:
                                new Float32Array([1, 1, 1, 1]),
                             postColorMatrixBias:
                                new Float32Array([0, 0, 0, 0]) },
            pixelZoom: { x: 1, y: 1 },
            pixelMaps: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [GL.PIXEL_MAP_I_TO_I + i, new Float32Array(1)])),

            arrayBuffer: 0,
            elementArrayBuffer: 0,
            pixelPackBuffer: 0,
            pixelUnpackBuffer: 0,
            arrayBufferId: 0, elementArrayBufferId: 0, pixelPackBufferId: 0, pixelUnpackBufferId: 0,
            queryObjects: new Map(), activeQuery: null,
            currentProgram: 0,
            arbVertexProgram: 0,
            arbFragmentProgram: 0,
            arbBindings: new Map(),
            arbDefaults: { [GL.VERTEX_PROGRAM_ARB]: createARBProgram(0, GL.VERTEX_PROGRAM_ARB),
                [GL.FRAGMENT_PROGRAM_ARB]: createARBProgram(0, GL.FRAGMENT_PROGRAM_ARB) },

            drawFramebuffer: 0,
            readFramebuffer: 0,
            privateFramebuffers: new Map(), drawFramebufferObject: null, readFramebufferObject: null,
            renderbuffer: 0,
            drawBuffers: [GL.BACK],
            readBuffer: GL.BACK,
            defaultFramebufferState: framebufferState.initial(GL.BACK),

            activeQueries: Object.create(null),

            // Immediate mode
            immediate: null,
            renderMode: GL.RENDER,

            // Generic vertex attributes (GL 2.0)
            genericAttribs: Array.from({ length: MAX_VERTEX_ATTRIBS }, () => ({
                enabled: false,
                value: new Float32Array([0, 0, 0, 1]),
            })),

            attribStack: [],
            clientAttribStack: [],
        };
        // GL's default enables. Everything else starts off.
        state.enabled.add(GL.DITHER);
        state.enabled.add(GL.MULTISAMPLE);
        return state;
    }

    function newMaterial() {
        return {
            ambient: new Float32Array([0.2, 0.2, 0.2, 1]),
            diffuse: new Float32Array([0.8, 0.8, 0.8, 1]),
            specular: new Float32Array([0, 0, 0, 1]),
            emission: new Float32Array([0, 0, 0, 1]),
            shininess: 0,
        };
    }

    function newTexEnv() {
        return {
            mode: GL.MODULATE,
            color: new Float32Array([0, 0, 0, 0]),
            combineRGB: GL.MODULATE, combineAlpha: GL.MODULATE,
            srcRGB: [GL.TEXTURE, GL.PREVIOUS, GL.CONSTANT],
            srcAlpha: [GL.TEXTURE, GL.PREVIOUS, GL.CONSTANT],
            operandRGB: [GL.SRC_COLOR, GL.SRC_COLOR, GL.SRC_ALPHA],
            operandAlpha: [GL.SRC_ALPHA, GL.SRC_ALPHA, GL.SRC_ALPHA],
            rgbScale: 1, alphaScale: 1,
            lodBias: 0,
            pointSprite: false,
        };
    }

    /* Names the fixed-function generator understands, from GL enums. */
    const TEXENV_MODE_NAMES = {
        [GL.REPLACE]: "REPLACE", [GL.MODULATE]: "MODULATE",
        [GL.DECAL]: "DECAL", [GL.BLEND]: "BLEND", [GL.ADD]: "ADD",
        [GL.COMBINE]: "COMBINE",
    };
    const COMBINE_RGB_NAMES = {
        [GL.REPLACE]: "REPLACE", [GL.MODULATE]: "MODULATE", [GL.ADD]: "ADD",
        [GL.ADD_SIGNED]: "ADD_SIGNED", [GL.INTERPOLATE]: "INTERPOLATE",
        [GL.SUBTRACT]: "SUBTRACT",
        [GL.DOT3_RGB]: "DOT3_RGB", [GL.DOT3_RGBA]: "DOT3_RGBA",
    };
    const COMBINE_SOURCE_NAMES = {
        [GL.TEXTURE]: "TEXTURE", [GL.CONSTANT]: "CONSTANT",
        [GL.PRIMARY_COLOR]: "PRIMARY_COLOR", [GL.PREVIOUS]: "PREVIOUS",
    };
    for (let i = 0; i < MAX_TEXTURE_UNITS; ++i)
        COMBINE_SOURCE_NAMES[GL.TEXTURE0 + i] = "TEXTURE" + i;
    const OPERAND_NAMES = {
        [GL.SRC_COLOR]: "SRC_COLOR",
        [GL.ONE_MINUS_SRC_COLOR]: "ONE_MINUS_SRC_COLOR",
        [GL.SRC_ALPHA]: "SRC_ALPHA",
        [GL.ONE_MINUS_SRC_ALPHA]: "ONE_MINUS_SRC_ALPHA",
    };
    const TEXGEN_MODE_NAMES = {
        [GL.OBJECT_LINEAR]: "OBJECT", [GL.EYE_LINEAR]: "EYE",
        [GL.SPHERE_MAP]: "SPHERE", [GL.REFLECTION_MAP]: "REFLECTION",
        [GL.NORMAL_MAP]: "NORMAL",
    };
    const COLOR_MATERIAL_MODES = {
        [GL.EMISSION]: "EMISSION", [GL.AMBIENT]: "AMBIENT",
        [GL.DIFFUSE]: "DIFFUSE", [GL.SPECULAR]: "SPECULAR",
        [GL.AMBIENT_AND_DIFFUSE]: "AMBIENT_AND_DIFFUSE",
    };
    const FACE_NAMES = {
        [GL.FRONT]: "FRONT", [GL.BACK]: "BACK",
        [GL.FRONT_AND_BACK]: "FRONT_AND_BACK",
    };

    /* The GL_TEXTURE_* target a unit samples, in GL's own priority order:
     * when several targets are enabled on one unit, cube beats 3D beats 2D
     * beats 1D. */
    const TARGET_PRIORITY = [
        [GL.TEXTURE_CUBE_MAP, "Cube"],
        [GL.TEXTURE_3D, "3D"],
        [GL.TEXTURE_2D, "2D"],
        [GL.TEXTURE_1D, "1D"],
    ];

    /* ================================================================== */
    /* Resources                                                          */
    /* ================================================================== */

    /*
     * A share group owns the objects wglShareLists makes common: textures,
     * buffers, display lists, shaders, programs and renderbuffers. Framebuffer
     * objects currently use the core context-local namespace, as do vertex
     * array state and query objects. C3/C6 still needs to encode the creation
     * interface: EXT-created FBOs are shared, unlike core-created FBOs.
     */
    function createShareGroup(id) {
        return {
            id,
            textures: new Map(),
            textureImages: new Map(), renderbufferImages: new Map(), nextImageId: 1,
            buffers: new Map(), bufferObjects: new Map(), nextBufferId: 1,
            shaders: new Map(),
            programs: new Map(),
            renderbuffers: new Map(),
            sharedFramebuffers: new Map(), framebufferReservations: new Map(),
            arbPrograms: new Map(),
            nextName: { texture: 1, buffer: 1, shader: 1, renderbuffer: 1,
                        arbProgram: 1 },
        };
    }

    function createTexture(name) {
        return {
            name,
            target: 0,
            levels: [],            // per level: {width, height, depth, bytes, format}
            gpuTexture: null,
            gpuFormat: "rgba8unorm",
            baseFormat: "RGBA",
            width: 0, height: 0, depth: 1, layers: 1,
            levelCount: 0,
            dirty: true,
            viewCache: new Map(),
            sampler: textureParameters.samplerDefaults(),
            priority: 1,
            generateMipmapHint: false,
            immutableSampleCount: 1,
        };
    }

    function createBuffer(name) {
        return { name, size: 0, usage: GL.STATIC_DRAW, gpuBuffer: null,
                 shadow: null, target: 0, mapped: false };
    }

    function createQuery(name) {
        return { name, target: 0, result: 0, ready: true, active: false, slot: -1, generation: 0 };
    }

    function createProgram(name) {
        return {
            name, shaders: new Set(),
            linked: false, log: "", deleted: false,
            bindAttribLocations: new Map(),
            // the locations the CPU side's shadow gave the guest (adoptLocation)
            adoptedAttribLocations: new Map(),
            ownByLocation: null,
            compiled: { vertex: null, fragment: null },
            link: null,                 // translator link result
            variants: new Map(),        // variant key -> {link, modules}
            uniformData: null,          // Uint8Array mirroring the block
            uniformByName: new Map(),
            uniformByLocation: new Map(),
            samplerUnits: new Map(),    // sampler name -> texture unit
            serial: 1,
            validateLog: "",
        };
    }

    function createARBProgram(name, target) {
        return { name, target, source: "", compiled: null, env: null, local: null, variants: new Map() };
    }

    function createFramebuffer(name) {
        return {
            name,
            created: false, shared: false,
            ...framebufferState.initial(GL.COLOR_ATTACHMENT0),
            color: new Array(MAX_DRAW_BUFFERS).fill(null),
            depth: null, stencil: null,
            width: 0, height: 0,
        };
    }

    function createRenderbuffer(name) {
        return { name, width: 0, height: 0, internalFormat: GL.RGBA,
                 componentBits: [0, 0, 0, 0, 0, 0],
                 samples: 1, gpuTexture: null, gpuFormat: "rgba8unorm" };
    }

    /* ================================================================== */
    /* Executor                                                           */
    /* ================================================================== */

    class GLWebGPUExecutor {
        constructor(canvas, options) {
            this.canvas = canvas;
            this.options = options || {};
            this.host = this.options.host ||
                (gpuHost ? gpuHost.acquire(canvas, this.options.hostOptions) : null);
            // Mirrored for backwards-compatible diagnostics; query paths use
            // the per-HGLRC fields in createContextState.
            this.device = null;
            this.deviceFeatures = { bc: false };
            this.presenterToken = 0;

            this.shareGroups = new Map();
            this.contexts = new Map();
            this.nextContextId = 1;
            this.nextShareGroupId = 1;
            // Uniform locations are opaque GLint handles.  opengl32.dll keeps
            // them in one process-wide lookup table, even across non-shared
            // HGLRCs, so the executor must not expose the translator's
            // per-program 0..N locations directly.
            this.nextUniformLocation = 1;
            this.current = null;

            this.framebuffers = new Map();  // per context id -> Map(name -> fbo)
            this.queries = new Map();

            this.pipelineCache = new Map();
            this.pipelineKeys = new CacheKeys();this.linkKeys = new CacheKeys();this.variantKeys = new CacheKeys();
            this.shaderCodeKeys = new CacheKeys();this.compiledPairKeys = new WeakMap();
            this.pipelineKeyTables = new WeakMap();this.pipelineKeyTables.set(this.pipelineCache, this.pipelineKeys);
            this.bindGroupCache = new Map();
            // keys of bind groups WebGPU rejected; the cache itself is
            // cleared every frame
            this.rejectedBindGroups = new Set();
            this.convertedVertexCache = new Map();
            this.convertedVertexBytes = 0;
            this.uniformValueCache = new Map();
            this.stateUniformLayouts = new WeakMap();
            this.resourceIds = new WeakMap();
            this.nextResourceId = 1;
            this.samplerCache = new Map();
            this.moduleCache = new Map();
            this.shaderCache = new Map();   // link cache key -> link result
            this.indexExpansionCache = new Map();

            this.backBuffer = null;
            this.backBufferView = null;
            this.depthTarget = null;
            this.backBufferWidth = 0;
            this.backBufferHeight = 0;

            this.encoder = null;
            this.pass = null;
            this.passTargets = null;
            this.recordedOps = 0;
            this.pendingVertexBuffers = new WeakSet();
            this.uploadPages = [];
            this.flushThreshold = Math.max(1024, this.options.flushThreshold || 16384);

            this.uniformRing = null;
            this.uniformStaging = null;
            this.uniformCursor = 0;
            this.uniformCapacity = Math.max(64 * 1024,
                this.options.uniformRingBytes || UNIFORM_RING_BYTES);
            this.vertexRing = null;
            this.vertexStaging = null;
            this.vertexCursor = 0;
            this.vertexCapacity = Math.max(256 * 1024,
                this.options.vertexRingBytes || VERTEX_RING_BYTES);

            this.pendingReadbacks = new Set();
            this.pending = [];
            this.busy = false;
            this.heartbeat = 0;
            this.warned = Object.create(null);
            this.stats = {
                batches: 0, commands: 0, draws: 0, immediateBatches: 0,
                pipelines: 0, bindGroups: 0, shaderLinks: 0, shaderCacheHits: 0,
                textureUploads: 0, textureBytes: 0,
                refusals: 0, refusalsByOp: Object.create(null),
                expandedIndices: 0, dxtDecodes: 0,
                nonUniformSamples: 0,
                pipelinesRejected: 0, framesRejected: 0, hostErrors: 0,
            };
            // Host exceptions, kept in strict mode for tests to assert on
            this.hostErrors = [];

            this.surface = { hwnd: 0, x: 0, y: 0, width: 0, height: 0,
                             visible: false };
            this.handlers = buildHandlerTable();
            installResourceHandlers(this.handlers);
            installProgramHandlers(this.handlers);
            installDrawHandlers(this.handlers);
            this.args = new Float64Array(32);
            this.resources = new gpuHost.GPUResourceRegistry();
            const maps = ["pipelineCache", "bindGroupCache", "samplerCache", "moduleCache",
                "uniformValueCache", "convertedVertexCache", "indexExpansionCache", "pixelPipelineCache",
                "accumPipelineCache", "accumClearPipelineCache", "clearPipelineCache", "colorCopyPipelines",
                "mipmapPipelines", "colorBlitPipelines", "valuePipelineCache", "depthColorPipelines",
                "singletonPipelines", "fallbackViews"];
            for (const name of maps) {
                this[name] = this[name] || new Map();
                this.resources.register(name, () => this[name].clear());
            }
            this.resources.fields(this, {
                encoder: null, pass: null, passTargets: null, passTargetKey: 0, pendingClear: null,
                presentPipeline: null, depthReadPipeline: null, depthUploadPipeline: null,
                presentSampler: null, pixelSampler: null, polygonStippleTexture: null,
                backBuffer: null, backBufferView: null, depthTarget: null, depthTargetView: null,
                multisampleTarget: null, multisampleView: null, accumBuffer: null,
                uniformRing: null, vertexRing: null, fallbackTexture: null, fallbackView: null,
                fallbackSampler: null, fallbackComparisonSampler: null, activeOcclusionQuerySet: null,
                logicTargetTextures: () => [], logicTargetViews: () => [], uploadPages: () => [], retired: () => [],
                pendingVertexBuffers: () => new WeakSet(), recordedOps: 0, vertexCursor: 0, uniformCursor: 0,
                convertedVertexBytes: 0, nextQuerySlot: 0, pendingQueries: () => [], passHasOcclusionQuerySet: false,
            });
            this.targetKeys = new CacheKeys();
            this.readbackCancels = new Set();
            this.resources.register("readbacks", () => {
                for (const cancel of this.readbackCancels) cancel();
            });
            this.resources.register("guest objects", () => this.invalidateGuestResources());
            // Default framebuffer storage belongs to the drawable, not the
            // currently selected HGLRC. Contexts on one window share it;
            // switching to another window retains both colour and depth.
            this.drawableFields = ["backBuffer", "backBufferView", "backBufferWidth", "backBufferHeight", "backBufferFormat",
                "depthTarget", "depthTargetView", "depthWidth", "depthHeight", "depthSamples",
                "multisampleTarget", "multisampleView", "multisampleWidth", "multisampleHeight", "multisampleFormat",
                "accumBuffer", "frontDrawn"];
            this.currentDrawable = {};
            this.drawables = new Map();
            for (const name of this.drawableFields) {
                this.currentDrawable[name] = this[name];
                Object.defineProperty(this, name, { enumerable: true, configurable: true,
                    get: () => this.currentDrawable[name], set: value => { this.currentDrawable[name] = value; } });
            }
        }

        /* ---- lifecycle ---- */

        initialize() {
            if (this.readyPromise) return this.readyPromise;
            this.readyPromise = (async () => {
                if (!this.host) throw new Error("no WebGPU host available");
                await this.host.initialize();
                this.device = this.host.device;
                this.deviceFeatures = this.host.deviceFeatures ||
                    { bc: false };
                this.limits = this.host.limits || {};
                this.gpuErrors = gpuHost.GPUErrorLog.forDevice(this.device);
                if (this.options.strict) this.gpuErrors.strict = true;
                // once: recovery runs initialize() again
                if (!this.lossHandler)
                    this.lossHandler = this.host.onDeviceLost(() => this.onDeviceLost());
                this.createDeviceResources();
                return this;
            })().catch(error => {
                this.failed = error;
                console.error("[gl-webgpu] initialization failed", error);
                throw error;
            });
            return this.readyPromise;
        }

        createGPUBuffer(descriptor) { return this.resources.track(this.device.createBuffer(descriptor)); }
        createGPUTexture(descriptor) { return this.resources.track(this.device.createTexture(descriptor)); }
        createGPUQuerySet(descriptor) { return this.resources.track(this.device.createQuerySet(descriptor)); }

        // What every draw needs, on a new device (the tests' fake device too)
        createDeviceResources() {
            this.uniformRing = this.createGPUBuffer({
                label: "GL uniform ring",
                size: this.uniformCapacity,
                usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
            });
            this.uniformStaging = new Uint8Array(this.uniformCapacity);
            this.vertexRing = this.createGPUBuffer({
                label: "GL vertex ring",
                size: this.vertexCapacity,
                usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_INDEX |
                    BUFFER_USAGE_COPY_DST,
            });
            this.vertexStaging = new Uint8Array(this.vertexCapacity);
            this.fallbackTexture = this.createGPUTexture({
                label: "GL incomplete-texture fallback",
                size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                format: "rgba8unorm",
                usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
            });
            // GL samples an incomplete texture as opaque black, not white:
            // the D3D9 path's white fallback would make missing textures
            // invisible instead of obvious.
            this.device.queue.writeTexture({ texture: this.fallbackTexture },
                new Uint8Array([0, 0, 0, 255]),
                { bytesPerRow: 4, rowsPerImage: 1 },
                { width: 1, height: 1, depthOrArrayLayers: 1 });
            this.fallbackView = this.fallbackTexture.createView();
            this.fallbackViews = new Map([["2d", this.fallbackView]]);
            this.fallbackSampler = this.device.createSampler({});
            this.fallbackComparisonSampler = this.device.createSampler({
                compare: "less-equal",
            });
        }

        trackReadback(operation) {
            this.pendingReadbacks.add(operation);
            operation.then(() => this.pendingReadbacks.delete(operation),
                () => this.pendingReadbacks.delete(operation));
            return operation;
        }

        // Bound the GPU operation before attaching any guest-memory writes:
        // a completion after timeout must not turn failure into late success.
        awaitReadback(operation, label, cancel) {
            let timer, lost;
            const cancelled = new Promise((resolve, reject) => {
                lost = () => { if (cancel) cancel(); reject(new Error(label + " device lost")); };
                this.readbackCancels.add(lost);
            });
            const timeout = new Promise((resolve, reject) => {
                timer = setTimeout(() => {
                    if (cancel) cancel();
                    reject(new Error(label + " timed out"));
                }, this.options.readbackTimeoutMs || protocol.C.V86GL_ASYNC_HOST_TIMEOUT_MS);
            });
            return Promise.race([operation, timeout, cancelled]).finally(() => {
                clearTimeout(timer); this.readbackCancels.delete(lost);
            });
        }

        async idle() {
            if (this.readyPromise) await this.readyPromise;
            while (this.pendingReadbacks.size)
                await Promise.all(Array.from(this.pendingReadbacks));
        }

        saveSnapshot() {
            const snapshot = nodeRequire ? nodeRequire("./gl_renderer_snapshot.js") : global.GLRendererSnapshot;
            return snapshot.capture(this);
        }

        restoreSnapshot(bytes) {
            const snapshot = nodeRequire ? nodeRequire("./gl_renderer_snapshot.js") : global.GLRendererSnapshot;
            return snapshot.restore(this, bytes);
        }

        onDeviceLost() {
            // The registry invalidates all device-local caches, slots and in-flight
            // transfers before rebuilding retained guest objects from CPU data.
            this.resources.invalidate();
            this.device = this.host.device;
            this.targetKeys.clearKeys();
            this.rejectedBindGroups.clear();
            if (this.activeQuery) this.activeQuery.slot = -1;
            this.readyPromise = null;
            return this.initialize().then(() => {
                for (const group of this.shareGroups.values()) {
                    for (const buffer of group.bufferObjects.values())
                        if (buffer.shadow) this.replaceBufferStorage(buffer);
                    // (their contents were rendered on the lost device)
                    for (const rb of group.renderbufferImages.values())
                        if (rb.gpuFormat && rb.width && rb.height) this.allocateRenderbuffer(rb);
                }
                if (this.activeQuery) this.ensureOcclusionQuerySet();
            });
        }

        invalidateGuestResources() {
            for (const drawable of this.drawables.values()) {
                for (const name of ["backBuffer", "backBufferView", "depthTarget", "depthTargetView",
                        "multisampleTarget", "multisampleView", "accumBuffer"]) drawable[name] = null;
                drawable.frontDrawn = false;
            }
            for (const group of this.shareGroups.values()) {
                // Include deleted objects retained by another context or FBO.
                for (const texture of group.textureImages.values()) {
                    texture.gpuTexture = null; texture.depthColor = null;
                    texture.viewCache.clear(); texture.dirty = true;
                }
                for (const buffer of group.bufferObjects.values()) buffer.gpuBuffer = null;
                for (const rb of group.renderbufferImages.values()) {
                    rb.gpuTexture = null;
                    if (rb.viewCache) rb.viewCache.clear();
                }
                for (const program of group.programs.values()) program.variants.clear();
            }
            for (const context of this.contexts.values()) {
                for (const query of context.queryObjects.values()) {
                    ++query.generation; query.slot = -1; query.pendingSegments = 0;
                    query.result = query.target === GL.SAMPLES_PASSED ? OCCLUSION_VISIBLE_SAMPLES : 1;
                    if (!query.active) query.ready = true;
                }
            }
        }

        /* ---- diagnostics ---- */

        warnOnce(key, message, details) {
            if (this.warned[key]) return;
            this.warned[key] = true;
            console.warn("[gl-webgpu] " + message, details || {});
        }

        /*
         * A command the host cannot execute is reported once with enough
         * context to find it, counted, and -- where GL defines an error for the
         * situation -- reflected in glGetError. Silently ignoring it is what
         * made the D3D8 and DirectDraw migrations expensive to debug.
         */
        refuse(op, reason, details) {
            ++this.stats.refusals;
            const key = op + ":" + reason;
            this.stats.refusalsByOp[key] = (this.stats.refusalsByOp[key] || 0) + 1;
            if (this.warned[key]) return;
            this.warned[key] = true;
            console.error("[gl-webgpu] refused " + op + ": " + reason,
                details || {});
        }

        // A rejected condition here is a renderer/input invariant failure.
        // GL errors belong exclusively to the CPU shadow.
        invalidState(code) {
            this.refuse("validated command", "unexpected invalid state", { code });
        }

        getStats() {
            return { ...this.stats,
                contexts: this.contexts.size,
                pipelines: this.pipelineCache.size,
                bindGroups: this.bindGroupCache.size,
                shaders: this.shaderCache.size };
        }

        /* ---- context management ---- */

        makeCurrent(payload) {
            const view = new DataView(payload.buffer, payload.byteOffset,
                payload.byteLength);
            const hwnd = payload.byteLength >= 4 ? view.getUint32(0, true) : 0;
            const x = payload.byteLength >= 8 ? view.getInt32(4, true) : 0;
            const y = payload.byteLength >= 12 ? view.getInt32(8, true) : 0;
            const width = payload.byteLength >= 16 ? view.getUint32(12, true) : 0;
            const height = payload.byteLength >= 20 ? view.getUint32(16, true) : 0;
            const protocolId = payload.byteLength >= 24 ? view.getUint32(20, true) : 0;
            const protocolShareGroup = payload.byteLength >= 28 ?
                view.getUint32(24, true) : 0;
            const format = payload.byteLength >= 32 ? view.getUint32(28, true) : 0;
            const contextKey = protocolId ? "context:" + protocolId : "hwnd:" + hwnd;

            let context = this.contexts.get(contextKey);
            if (!context) {
                const groupKey = protocolShareGroup ?
                    "guest:" + protocolShareGroup : "private:" + this.nextShareGroupId;
                let group = this.shareGroups.get(groupKey);
                if (!group) {
                    group = createShareGroup(this.nextShareGroupId++);
                    group.protocolId = protocolShareGroup;
                    this.shareGroups.set(groupKey, group);
                }
                context = createContextState(this.nextContextId++, group);
                // a single-buffered window draws and reads its front buffer
                if (format & protocol.C.V86GL_FORMAT_SINGLE_BUFFER) {
                    context.drawBuffers = [GL.FRONT];
                    context.readBuffer = GL.FRONT;
                    context.defaultFramebufferState = framebufferState.initial(GL.FRONT);
                }
                context.hwnd = hwnd;
                context.protocolId = protocolId;
                context.contextKey = contextKey;
                context.shareGroupKey = groupKey;
                this.contexts.set(contextKey, context);
                this.framebuffers.set(context.id, new Map());
            }
            const drawable = this.drawables.get(hwnd) || { backBufferWidth: 0, backBufferHeight: 0 };
            this.drawables.set(hwnd, drawable);
            if (this.currentDrawable !== drawable) this.endPass();
            this.currentDrawable = drawable;
            context.hwnd = hwnd;
            context.samples = (format & protocol.C.V86GL_FORMAT_SAMPLES_MASK) >>>
                protocol.C.V86GL_FORMAT_SAMPLES_SHIFT;
            if (this.current !== context) {
                this.endPass();
                if (this.current) this.current.activeQuery = this.activeQuery;
            }
            this.current = context;
            framebufferState.sync(context, this.framebuffers.get(context.id));
            this.queries = context.queryObjects;
            this.activeQuery = context.activeQuery;
            if (width && height) {
                if (!context.viewport.width) {
                    context.viewport = { x: 0, y: 0, width, height };
                    context.scissor = { x: 0, y: 0, width, height, set: false };
                }
                this.resizeSurface(width, height);
                if (this.host) this.host.resizeCanvas(width, height);
            }
            // (whether other windows cover it stands until the next report)
            this.surface = { ...this.surface, hwnd, x, y, width, height, visible: true };
            this.notifySurface("current");
        }

        /*
         * V86GL_CTRL_WINDOW_STATE (opengl32_proxy.c): the drawing window as
         * the guest's window manager sees it, sent whenever that changes --
         * WinEvent hooks, not SwapBuffers, so a game that stops drawing while
         * another window covers it is still heard from.
         *
         *   u32 hwnd, u32 flags, i32 x, i32 y (the client area on the guest's
         *   screen), u32 width, u32 height (the client area), then with
         *   WINDOW_REGION: u32 count, count x (i32 left, top, right, bottom)
         *   in client coordinates -- the parts that show.
         *
         * The flags are D9WGWindowState's. A hidden or minimised window takes
         * the picture down; one covered entirely (Warcraft III's cinematic
         * popup) or in part keeps it, shown only where the window shows.
         */
        windowState(view, offset, size) {
            if (size < 24) {
                this.refuse("window-state", "payload too short", { size });
                return;
            }
            const hwnd = view.getUint32(offset, true);
            const flags = view.getUint32(offset + 4, true);
            const x = view.getInt32(offset + 8, true), y = view.getInt32(offset + 12, true);
            const width = view.getUint32(offset + 16, true), height = view.getUint32(offset + 20, true);
            const shown = (flags & WINDOW_IS_WINDOW) !== 0 && (flags & WINDOW_VISIBLE) !== 0 &&
                (flags & WINDOW_ICONIC) === 0;
            let visibleRegion = null;
            if ((flags & WINDOW_REGION) && size >= 28 && width && height) {
                const count = view.getUint32(offset + 24, true);
                if (count <= WINDOW_REGION_MAX_RECTS && size >= 28 + count * 16) {
                    const rects = [];
                    for (let i = 0; i < count; ++i) {
                        const at = offset + 28 + i * 16;
                        const r = { left: view.getInt32(at, true), top: view.getInt32(at + 4, true),
                            right: view.getInt32(at + 8, true), bottom: view.getInt32(at + 12, true) };
                        if (r.right > r.left && r.bottom > r.top) rects.push(r);
                    }
                    visibleRegion = { rects, baseWidth: width, baseHeight: height, originX: x, originY: y };
                }
            }
            this.windowStateReports = (this.windowStateReports || 0) + 1;
            if (!shown) {
                this.surface = { ...this.surface, visible: false };
                this.notifySurface("hide");
                return;
            }
            // (shown again: on screen with the next SwapBuffers)
            this.surface = { ...this.surface, hwnd,
                ...(width && height ? { x, y, width, height } : {}), visible: true,
                occluded: (flags & WINDOW_OCCLUDED) !== 0, visibleRegion };
            this.notifySurface("window-state");
        }

        releaseCurrent() {
            this.finishFrame(false);
            if (this.current) this.current.activeQuery = this.activeQuery;
            this.current = null;
            this.queries = new Map(); this.activeQuery = null;
        }

        destroyContext(payload) {
            this.finishFrame(false);
            let targets;
            if (payload && payload.byteLength >= 4) {
                const id = new DataView(payload.buffer, payload.byteOffset,
                    payload.byteLength).getUint32(0, true);
                const context = this.contexts.get("context:" + id);
                targets = context ? [context] : [];
            } else {
                // A payload-less destroy is process teardown from an older guest.
                targets = [...this.contexts.values()];
            }
            for (const context of targets) {
                this.contexts.delete(context.contextKey || ("hwnd:" + context.hwnd));
                this.framebuffers.delete(context.id);
                for (const query of context.queryObjects.values()) ++query.generation;
                context.queryObjects.clear(); context.activeQuery = null;
                if (this.current === context) { this.current = null; this.queries = new Map(); this.activeQuery = null; }
                for (const program of context.shareGroup.programs.values())
                    this.collectGLProgram(context.shareGroup, program);
            }
            for (const [key, group] of this.shareGroups) {
                const live = [...this.contexts.values()].some(context =>
                    context.shareGroup === group);
                if (!live) {
                    for (const texture of group.textureImages.values())
                        this.retire(texture.gpuTexture);
                    for (const buffer of group.bufferObjects.values()) {
                        this.invalidateVertexConversions(buffer);
                        this.retire(buffer.gpuBuffer);
                    }
                    for (const rb of group.renderbufferImages.values())
                        this.retire(rb.gpuTexture);
                    this.shareGroups.delete(key);
                }
            }
            if (!this.current) {
                this.surface = { ...this.surface, visible: false };
                this.notifySurface("hide");
            }
        }

        // The process that owned the DMA arena is gone (it unmapped it, or the
        // kernel closed the device for it when it was killed): its contexts go
        // as a payload-less DESTROY_CONTEXT would take them, and so do the
        // pipelines cached by its program names (review S1-4)
        endOwnerSessions() {
            this.destroyContext(null);
            this.pipelineCache.clear();
            this.bindGroupCache.clear();
            this.activeQuery = null;
        }

        resetForReplay() {
            this.finishFrame(false);
            this.resources.invalidate(true);
            this.createDeviceResources();
            this.shareGroups.clear(); this.contexts.clear(); this.framebuffers.clear();
            this.queries = new Map(); this.activeQuery = null;
            this.shaderCache.clear();
            if (this.ffCache) this.ffCache.clear();
            this.stateUniformLayouts = new WeakMap();
            this.targetKeys.clearKeys(); this.rejectedBindGroups.clear();
            this.nextContextId = 1; this.nextShareGroupId = 1; this.nextUniformLocation = 1;
            this.current = null;
            this.drawables.clear(); this.currentDrawable = { backBufferWidth: 0, backBufferHeight: 0 };
            this.surface = { hwnd: 0, x: 0, y: 0, width: 0, height: 0,
                             visible: false };
            this.notifySurface("hide");
        }

        notifySurface(reason) {
            const callback = this.options.onSurface;
            if (typeof callback === "function")
                callback({ ...this.surface, sessionKey: "gl" }, reason);
        }

        resizeSurface(width, height) {
            if (width === this.backBufferWidth && height === this.backBufferHeight)
                return;
            this.endPass();
            this.retire(this.backBuffer); this.retire(this.depthTarget);
            this.backBufferWidth = width;
            this.backBufferHeight = height;
            this.backBuffer = null; this.backBufferView = null;
            this.depthTarget = null; this.depthTargetView = null;
            if (this.host) this.host.resizeCanvas(width, height);
        }

        /* ---- batch execution ---- */

        /*
         * Synchronous by construction.
         *
         * The guest is blocked inside DeviceIoControl while its port write runs
         * this code, and it reads the answer to glGetError, glGetIntegerv or
         * glGetUniformLocation straight out of the record as soon as the write
         * returns. Deferring the batch to a microtask would make every one of
         * those read stale memory -- which is why the authoritative GL state
         * lives here and why nothing on this path awaits the GPU (plan 4.8).
         *
         * Before the device exists there is nothing to be synchronous about, so
         * batches queue and replay in order once initialize() resolves. The
         * page creates the executor at load time precisely so that window is
         * empty by the time a guest runs.
         */
        submit(bytes, metadata) {
            if (!this.device) {
                this.pending.push({ bytes: bytes.slice(),
                                    metadata: metadata || {} });
                if (!this.draining) {
                    this.draining = true;
                    this.initialize().then(() => {
                        this.draining = false;
                        const queued = this.pending;
                        this.pending = [];
                        for (const item of queued)
                            this.executeBatch(item.bytes, item.metadata);
                    }).catch(() => {
                        this.draining = false;
                        this.pending.length = 0;
                    });
                }
                return;
            }
            this.executeBatch(bytes, metadata || {});
        }

        executeBatch(bytes, metadata) {
            ++this.stats.batches;
            const view = new DataView(bytes.buffer, bytes.byteOffset,
                bytes.byteLength);
            let offset = 0;
            const end = bytes.byteLength;
            while (offset < end) {
                if (offset + 4 > end) {
                    this.refuse("batch", "truncated record header",
                        { remaining: end - offset });
                    break;
                }
                const fn = view.getUint16(offset, true);
                let size = view.getUint16(offset + 2, true);
                offset += 4;
                if (size === 0xFFFF) {
                    if (offset + 4 > end) {
                        this.refuse("batch", "truncated extended length", { fn });
                        break;
                    }
                    size = view.getUint32(offset, true);
                    offset += 4;
                }
                if (offset + size > end) {
                    this.refuse("batch", "truncated record",
                        { fn, size, remaining: end - offset });
                    break;
                }
                ++this.stats.commands;
                try {
                    this.dispatch(fn, bytes, view, offset, size, metadata);
                    // Non-draw upload users (blits, pixel rectangles) also
                    // retire pages only once their complete GL command is encoded.
                    if (this.retireUploadPages()) this.flushFrame();
                } catch (error) {
                    if (error instanceof GLStreamError) {
                        /*
                         * A malformed record is a wire disagreement between
                         * the guest and this decoder, and "refused op40:
                         * client array blocks are truncated {}" says nothing
                         * about which of the two is wrong. The name and the
                         * first bytes do: the payload header is right there,
                         * and against openglproxy's struct it is usually one
                         * read to see whose offset moved.
                         */
                        this.refuse("op" + fn, error.message, {
                            name: constants.NAME_BY_OPCODE[fn] || "?",
                            size,
                            head: hexPreview(bytes, offset, size),
                        });
                    } else {
                        // A host bug: this command is lost, nothing else is.
                        // Not a GL error -- the application did nothing wrong.
                        ++this.stats.hostErrors;
                        if (this.options.strict) this.hostErrors.push(error);
                        const key = "host:" + fn + ":" + String(error && error.message);
                        if (!this.warned[key]) {
                            this.warned[key] = true;
                            console.error("[gl-webgpu] " + (constants.NAME_BY_OPCODE[fn] || "op" + fn) +
                                " threw; the command is skipped", error);
                        }
                    }
                }
                offset += size;
            }
            this.collectImages();
            this.collectBuffers();
            this.beat(metadata);
        }

        dispatch(fn, bytes, view, offset, size, metadata) {

            if (protocol.isRejected(fn)) {
                // Old checkpoints/unfiltered tests may contain CPU rejection
                // markers. Their arguments and CPU error are not GPU state.
                return;
            }

            if (fn === CTRL.MAKE_CURRENT)
                return this.makeCurrent(bytes.subarray(offset, offset + size));
            if (fn === CTRL.RELEASE_CURRENT) return this.releaseCurrent();
            if (fn === CTRL.DESTROY_CONTEXT)
                return this.destroyContext(bytes.subarray(offset, offset + size));
            if (fn === CTRL.WINDOW_STATE)
                return this.windowState(view, offset, size);

            const handler = this.handlers[fn];
            if (!handler) {
                this.refuse("op" + fn, "no handler",
                    { name: constants.NAME_BY_OPCODE[fn] || "?" });
                return;
            }
            if (!this.current && handler.needsContext !== false) {
                if (!this.contexts.size &&
                        isContextFreeTeardownNoop(fn, view, offset, size))
                    return;
                this.warnOnce("no-context",
                    "a GL command arrived with no current context; it is ignored",
                    { fn, name: constants.NAME_BY_OPCODE[fn] || "?" });
                return;
            }
            if (handler.signature) {
                const count = protocol.decodeArgs(handler.signature, view, offset,
                    size, this.args);
                if (count < 0) {
                    this.refuse("op" + fn, "payload too short for signature",
                        { name: constants.NAME_BY_OPCODE[fn], size });
                    return;
                }
                return handler.call(this, this.args, bytes, view, offset, size,
                    metadata);
            }
            return handler.call(this, null, bytes, view, offset, size, metadata);
        }

        beat(metadata) {
            // The guest's readback timeout watches this counter rather than the
            // clock: a host thousands of batches behind is slow, not broken,
            // and the two need different reactions (plan 6.2).
            this.heartbeat = (this.heartbeat + 1) >>> 0;
            const write = this.options.writeGuestMemory;
            if (typeof write !== "function" || !metadata ||
                    metadata.responseBase === undefined)
                return;
            const bytes = new Uint8Array(4);
            new DataView(bytes.buffer).setUint32(0, this.heartbeat, true);
            try {
                write(metadata.responseBase + GLWG_HEARTBEAT_OFFSET, bytes, metadata, false);
            } catch (error) {
                this.warnOnce("heartbeat", "could not write the heartbeat counter",
                    { message: String(error) });
            }
        }
    }

    /* ================================================================== */
    /* Opcode handlers                                                    */
    /* ================================================================== */

    /*
     * One table, built once. A 217-way switch degenerates into a linear
     * comparison chain in V8, and this runs tens of thousands of times per
     * frame; a table also turns "which opcodes are unimplemented" into an
     * array scan, which is what feeds COVERAGE.md.
     */
    function buildHandlerTable() {
        const table = new Array(256).fill(null);

        const define = (name, handler, options) => {
            const opcode = GLFN[name];
            if (opcode === undefined)
                throw new Error("unknown opcode name " + name);
            const signature = SIGNATURES[name];
            if (signature && signature[1].length) handler.signature = signature[1];
            if (options && options.needsContext === false)
                handler.needsContext = false;
            handler.glName = signature ? signature[0] : name;
            table[opcode] = handler;
        };

        /* ---- framebuffer-wide state ---- */

        define("VIEWPORT", function(a) {
            const s = this.current;
            s.viewport = { x: a[0] | 0, y: a[1] | 0,
                           width: Math.max(0, a[2] | 0),
                           height: Math.max(0, a[3] | 0) };
            // GL's viewport origin is the lower left and so, after the clip
            // space flip, is WebGPU's: no conversion (plan 4.3).
        });

        define("SCISSOR", function(a) {
            const s = this.current;
            s.scissor = { x: a[0] | 0, y: a[1] | 0,
                          width: Math.max(0, a[2] | 0),
                          height: Math.max(0, a[3] | 0), set: true };
        });

        define("DEPTH_RANGE", function(a) {
            this.current.depthRange = { near: clamp(a[0], 0, 1),
                                        far: clamp(a[1], 0, 1) };
        });

        define("CLEAR_COLOR", function(a) {
            this.current.clearColor.set([a[0], a[1], a[2], a[3]]);
        });
        define("CLEAR_DEPTH", function(a) { this.current.clearDepth = clamp(a[0], 0, 1); });
        define("CLEAR_STENCIL", function(a) { this.current.clearStencil = a[0] | 0; });
        define("CLEAR_ACCUM", function(a) {
            this.current.clearAccum.set([a[0], a[1], a[2], a[3]]);
        });
        define("CLEAR", function(a) { this.clearBuffers(a[0] >>> 0); });

        /* ---- matrices ---- */

        define("MATRIX_MODE", function(a) { this.current.matrixMode = a[0] >>> 0; });
        define("LOAD_IDENTITY", function() { identity4(this.topMatrix()); this.matrixChanged(); });
        define("PUSH_MATRIX", function() { this.pushMatrix(); });
        define("POP_MATRIX", function() { this.popMatrix(); });
        define("TRANSLATEF", function(a) {
            const m = identity4(SCRATCH_A);
            m[12] = a[0]; m[13] = a[1]; m[14] = a[2];
            this.multiplyTop(m);
        });
        define("SCALEF", function(a) {
            const m = identity4(SCRATCH_A);
            m[0] = a[0]; m[5] = a[1]; m[10] = a[2];
            this.multiplyTop(m);
        });
        define("ROTATEF", function(a) {
            const angle = a[0] * Math.PI / 180;
            let x = a[1], y = a[2], z = a[3];
            const len = Math.sqrt(x * x + y * y + z * z);
            if (len === 0) return;
            x /= len; y /= len; z /= len;
            const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
            const m = identity4(SCRATCH_A);
            m[0] = t*x*x + c;   m[4] = t*x*y - s*z; m[8]  = t*x*z + s*y;
            m[1] = t*x*y + s*z; m[5] = t*y*y + c;   m[9]  = t*y*z - s*x;
            m[2] = t*x*z - s*y; m[6] = t*y*z + s*x; m[10] = t*z*z + c;
            this.multiplyTop(m);
        });
        define("FRUSTUM", function(a) {
            const [l, r, b, t, n, f] = [a[0], a[1], a[2], a[3], a[4], a[5]];
            const m = identity4(SCRATCH_A);
            m[0] = 2 * n / (r - l); m[5] = 2 * n / (t - b);
            m[8] = (r + l) / (r - l); m[9] = (t + b) / (t - b);
            m[10] = -(f + n) / (f - n); m[11] = -1;
            m[14] = -2 * f * n / (f - n); m[15] = 0;
            m[1] = 0; m[2] = 0; m[3] = 0; m[4] = 0; m[6] = 0; m[7] = 0;
            m[12] = 0; m[13] = 0;
            this.multiplyTop(m);
        });
        define("ORTHO", function(a) {
            const [l, r, b, t, n, f] = [a[0], a[1], a[2], a[3], a[4], a[5]];
            const m = identity4(SCRATCH_A);
            m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
            m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b);
            m[14] = -(f + n) / (f - n);
            this.multiplyTop(m);
        });
        define("LOAD_MATRIXF", function(a, bytes, view, offset, size) {
            if (size < 64) throw new GLStreamError("glLoadMatrixf needs 16 floats");
            const m = this.topMatrix();
            for (let i = 0; i < 16; ++i) m[i] = view.getFloat32(offset + i * 4, true);
            this.matrixChanged();
        });
        define("MULT_MATRIXF", function(a, bytes, view, offset, size) {
            if (size < 64) throw new GLStreamError("glMultMatrixf needs 16 floats");
            const m = SCRATCH_A;
            for (let i = 0; i < 16; ++i) m[i] = view.getFloat32(offset + i * 4, true);
            this.multiplyTop(m);
        });

        /* ---- enables and simple raster state ---- */

        define("ENABLE", function(a) { this.setCapability(a[0] >>> 0, true); });
        define("DISABLE", function(a) { this.setCapability(a[0] >>> 0, false); });
        define("DEPTH_FUNC", function(a) { this.current.depthFunc = a[0] >>> 0; });
        define("DEPTH_MASK", function(a) { this.current.depthMask = a[0] !== 0; });
        define("COLOR_MASK", function(a) {
            this.current.colorMask = [a[0] !== 0, a[1] !== 0, a[2] !== 0, a[3] !== 0];
        });
        define("SHADE_MODEL", function(a) { this.current.shadeModel = a[0] >>> 0; });
        define("CULL_FACE", function(a) { this.current.cullFace = a[0] >>> 0; });
        define("FRONT_FACE", function(a) { this.current.frontFace = a[0] >>> 0; });
        define("LINE_WIDTH", function(a) { this.current.lineWidth = Math.max(0, a[0]); });
        define("POINT_SIZE", function(a) {
            this.current.pointSize = Math.max(0, a[0]);
            this.current.point.size = this.current.pointSize;
        });
        define("POLYGON_MODE", function(a) {
            const face = a[0] >>> 0, mode = a[1] >>> 0;
            const s = this.current;
            if (face === GL.FRONT || face === GL.FRONT_AND_BACK) s.polygonMode.front = mode;
            if (face === GL.BACK || face === GL.FRONT_AND_BACK) s.polygonMode.back = mode;
        });
        define("POLYGON_OFFSET", function(a) {
            this.current.polygonOffset = { factor: a[0], units: a[1] };
        });
        define("LINE_STIPPLE", function(a) {
            this.current.lineStipple = { factor: clamp(a[0] | 0, 1, 256),
                                         pattern: a[1] & 0xffff };
        });
        define("LOGIC_OP", function(a) { this.current.logicOp = a[0] >>> 0; });
        define("HINT", function() { /* hints have no effect here */ });
        define("SAMPLE_COVERAGE", function(a) {
            this.current.sampleCoverage = { value: clamp(a[0], 0, 1),
                                            invert: a[1] !== 0 };
        });

        /* ---- blending, alpha test, stencil ---- */

        define("BLEND_FUNC", function(a) {
            const b = this.current.blend;
            b.srcRGB = b.srcAlpha = a[0] >>> 0;
            b.dstRGB = b.dstAlpha = a[1] >>> 0;
        });
        define("BLEND_FUNC_SEPARATE", function(a) {
            const b = this.current.blend;
            b.srcRGB = a[0] >>> 0; b.dstRGB = a[1] >>> 0;
            b.srcAlpha = a[2] >>> 0; b.dstAlpha = a[3] >>> 0;
        });
        define("BLEND_EQUATION", function(a) {
            const b = this.current.blend;
            b.equationRGB = b.equationAlpha = a[0] >>> 0;
        });
        define("BLEND_EQUATION_SEPARATE", function(a) {
            const b = this.current.blend;
            b.equationRGB = a[0] >>> 0; b.equationAlpha = a[1] >>> 0;
        });
        define("BLEND_COLOR", function(a) {
            this.current.blend.color.set([a[0], a[1], a[2], a[3]]);
        });
        define("ALPHA_FUNC", function(a) {
            this.current.alphaFunc = { func: a[0] >>> 0, ref: clamp(a[1], 0, 1) };
        });
        define("STENCIL_FUNC", function(a) {
            for (const face of ["front", "back"]) {
                const f = this.current.stencil[face];
                f.func = a[0] >>> 0; f.ref = a[1] | 0; f.valueMask = a[2] >>> 0;
            }
        });
        // The CPU resolves EXT's three stencil banks before forwarding.
        define("ACTIVE_STENCIL_FACE", function() {});
        define("STENCIL_FUNC_SEPARATE", function(a) {
            const which = a[0] >>> 0;
            for (const face of facesOf(which)) {
                const f = this.current.stencil[face];
                f.func = a[1] >>> 0; f.ref = a[2] | 0; f.valueMask = a[3] >>> 0;
            }
        });
        define("STENCIL_OP", function(a) {
            for (const face of ["front", "back"]) {
                const f = this.current.stencil[face];
                f.fail = a[0] >>> 0; f.zfail = a[1] >>> 0; f.zpass = a[2] >>> 0;
            }
        });
        define("STENCIL_OP_SEPARATE", function(a) {
            for (const face of facesOf(a[0] >>> 0)) {
                const f = this.current.stencil[face];
                f.fail = a[1] >>> 0; f.zfail = a[2] >>> 0; f.zpass = a[3] >>> 0;
            }
        });
        define("STENCIL_MASK", function(a) {
            this.current.stencil.front.writeMask = a[0] >>> 0;
            this.current.stencil.back.writeMask = a[0] >>> 0;
        });
        define("STENCIL_MASK_SEPARATE", function(a) {
            for (const face of facesOf(a[0] >>> 0))
                this.current.stencil[face].writeMask = a[1] >>> 0;
        });

        /* ---- current vertex attributes and immediate mode ---- */

        define("BEGIN", function(a) { this.beginImmediate(a[0] >>> 0); });
        define("RESOLVED_RASTER_STATE", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.RESOLVED_RASTER_STATE.size) throw new GLStreamError("resolved raster state is short");
            const r = protocol.decodeRecord("RESOLVED_RASTER_STATE", view, offset), current = this.current.current;
            current.rasterValid = !!r.valid; current.rasterPos.set(r.position); current.rasterColor.set(r.color);
        });
        define("END", function() { this.endImmediate(); });
        define("RESOLVED_RASTER_ALL", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.RESOLVED_RASTER_ALL.size) throw new GLStreamError("resolved raster state is short");
            const r = protocol.decodeRecord("RESOLVED_RASTER_ALL", view, offset), current = this.current.current;
            current.rasterValid = !!r.valid; current.rasterPos.set(r.position); current.rasterColor.set(r.color); current.rasterSecondaryColor.set(r.secondary);
            current.rasterDistance = r.distance; current.rasterFogCoord = r.fog;
            current.rasterTexCoord.forEach((coord, i) => coord.set(r.coords.slice(i * 4, i * 4 + 4)));
        });
        define("CAPTURE_VERTICES", function(a, bytes, view, offset, size, metadata) {
            this.captureVertices(bytes, view, offset, size, metadata);
        });
        define("CAPTURE_RASTER_VERTEX", function(a, bytes, view, offset, size, metadata) {
            this.captureVertices(bytes, view, offset, size, metadata, true);
        });
        define("RESOLVED_EVAL_VERTEX", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.RESOLVED_EVAL_VERTEX.size) throw new GLStreamError("evaluated vertex is short");
            const r = protocol.decodeRecord("RESOLVED_EVAL_VERTEX", view, offset), current = this.current.current,
                saved = { color: current.color, normal: current.normal, texcoord: current.texCoord[0] };
            current.color = new Float32Array(r.color); current.normal = new Float32Array(r.normal.slice(0, 3)); current.texCoord[0] = new Float32Array(r.texcoord);
            try { this.immediateVertex(...r.position); }
            finally { current.color = saved.color; current.normal = saved.normal; current.texCoord[0] = saved.texcoord; }
        });
        // Index state remains queryable in an RGBA drawable; it does not
        // participate in that drawable's rendering.
        define("INDEX_STATE", function() {});
        define("COLOR4F", function(a) {
            this.current.current.color.set([a[0], a[1], a[2], a[3]]);
            this.latchColorMaterial();
        });
        define("SECONDARY_COLOR3F", function(a) {
            this.current.current.secondaryColor.set([a[0], a[1], a[2], 1]);
        });
        define("NORMAL3F", function(a) {
            this.current.current.normal.set([a[0], a[1], a[2]]);
        });
        define("FOG_COORDF", function(a) { this.current.current.fogCoord = a[0]; });
        define("EDGE_FLAG", function(a) { this.current.current.edgeFlag = a[0] !== 0; });
        define("TEX_COORD2F", function(a) {
            this.current.current.texCoord[this.current.clientActiveTexture]
                .set([a[0], a[1], 0, 1]);
        });
        define("TEX_COORD4F", function(a) {
            this.current.current.texCoord[this.current.clientActiveTexture]
                .set([a[0], a[1], a[2], a[3]]);
        });
        define("MULTI_TEX_COORD4F", function(a) {
            const unit = (a[0] >>> 0) - GL.TEXTURE0;
            if (unit < 0 || unit >= MAX_TEXTURE_COORDS)
                return this.refuse("glMultiTexCoord", "texture unit out of range",
                    { unit }, GL.INVALID_ENUM);
            this.current.current.texCoord[unit].set([a[1], a[2], a[3], a[4]]);
        });
        define("VERTEX3F", function(a) { this.immediateVertex(a[0], a[1], a[2], 1); });
        define("VERTEX4F", function(a) { this.immediateVertex(a[0], a[1], a[2], a[3]); });
        define("RASTER_POS4F", function(a) { this.setRasterPos(a[0], a[1], a[2], a[3]); });
        define("WINDOW_POS3F", function(a) {
            // glWindowPos bypasses the transform: the value is already in
            // window coordinates and the position is always valid.
            const s = this.current;
            s.current.rasterPos.set([a[0], a[1], s.depthRange.near + clamp(a[2], 0, 1) * (s.depthRange.far - s.depthRange.near), 1]);
            s.current.rasterColor.set(s.current.color);
            s.current.rasterValid = true;
        });
        define("VERTEX_ATTRIB4F", function(a) {
            const index = a[0] >>> 0;
            if (index >= MAX_VERTEX_ATTRIBS)
                return this.refuse("glVertexAttrib4f", "index out of range",
                    { index }, GL.INVALID_VALUE);
            // attribute 0 is the vertex: inside glBegin it issues one (GL 2.1
            // section 2.7)
            if (index === 0 && this.current.immediate)
                return this.immediateVertex(a[1], a[2], a[3], a[4]);
            this.current.genericAttribs[index].value.set([a[1], a[2], a[3], a[4]]);
        });

        /* ---- lighting and material ---- */

        define("LIGHT_MODELF", function(a) { this.setLightModel(a[0] >>> 0, [a[1]]); });
        define("LIGHT_MODELI", function(a) { this.setLightModel(a[0] >>> 0, [a[1]]); });
        define("LIGHT_MODELFV", function(a) {
            this.setLightModel(a[0] >>> 0, [a[2], a[3], a[4], a[5]], a[1] >>> 0);
        });
        define("LIGHT_MODELIV", function(a) {
            this.setLightModel(a[0] >>> 0,
                integerParameters(a[0] >>> 0, [a[2], a[3], a[4], a[5]]), a[1] >>> 0);
        });
        define("LIGHTF", function(a) {
            this.setLight(a[0] >>> 0, a[1] >>> 0, [a[2]]);
        });
        define("LIGHTI", function(a) {
            this.setLight(a[0] >>> 0, a[1] >>> 0, [a[2]]);
        });
        define("LIGHTFV", function(a) {
            this.setLight(a[0] >>> 0, a[1] >>> 0, [a[3], a[4], a[5], a[6]]);
        });
        define("LIGHTIV", function(a) {
            this.setLight(a[0] >>> 0, a[1] >>> 0,
                integerParameters(a[1] >>> 0, [a[3], a[4], a[5], a[6]]));
        });
        define("MATERIALF", function(a) {
            this.setMaterial(a[0] >>> 0, a[1] >>> 0, [a[2]]);
        });
        define("MATERIALI", function(a) {
            this.setMaterial(a[0] >>> 0, a[1] >>> 0, [a[2]]);
        });
        define("MATERIALFV", function(a) {
            this.setMaterial(a[0] >>> 0, a[1] >>> 0, [a[3], a[4], a[5], a[6]]);
        });
        define("MATERIALIV", function(a) {
            this.setMaterial(a[0] >>> 0, a[1] >>> 0,
                integerParameters(a[1] >>> 0, [a[3], a[4], a[5], a[6]]));
        });
        define("COLOR_MATERIAL", function(a) {
            this.current.colorMaterial.face = a[0] >>> 0;
            this.current.colorMaterial.mode = a[1] >>> 0;
            this.latchColorMaterial();
        });

        /* ---- fog ---- */

        define("FOGF", function(a) { this.setFog(a[0] >>> 0, [a[1]]); });
        define("FOGI", function(a) { this.setFog(a[0] >>> 0, [a[1]]); });
        define("FOGFV", function(a) {
            this.setFog(a[0] >>> 0, [a[2], a[3], a[4], a[5]]);
        });

        /* ---- clip planes ---- */

        define("CLIP_PLANE", function(a) {
            const index = (a[0] >>> 0) - GL.CLIP_PLANE0;
            if (index < 0 || index >= MAX_CLIP_PLANES)
                return this.refuse("glClipPlane", "plane index out of range",
                    { index }, GL.INVALID_ENUM);
            // GL specifies the plane in object coordinates and stores it
            // transformed by the inverse modelview at call time, so a later
            // modelview change does not move the plane.
            const s = this.current;
            const inv = invert4(this.topOf(GL.MODELVIEW), SCRATCH_B);
            const t = transpose4(inv, SCRATCH_C);
            const plane = new Float32Array([a[1], a[2], a[3], a[4]]);
            transformPoint4(t, plane, s.clipPlanes[index]);
        });

        /* ---- texture unit selection and environment ---- */

        define("ACTIVE_TEXTURE", function(a) {
            const unit = (a[0] >>> 0) - GL.TEXTURE0;
            if (unit < 0 || unit >= MAX_TEXTURE_UNITS)
                return this.refuse("glActiveTexture", "unit out of range",
                    { unit }, GL.INVALID_ENUM);
            this.current.activeTexture = unit;
        });
        define("CLIENT_ACTIVE_TEXTURE", function(a) {
            const unit = (a[0] >>> 0) - GL.TEXTURE0;
            if (unit < 0 || unit >= MAX_TEXTURE_COORDS)
                return this.refuse("glClientActiveTexture", "unit out of range",
                    { unit }, GL.INVALID_ENUM);
            this.current.clientActiveTexture = unit;
        });
        define("TEX_ENVI", function(a) {
            this.setTexEnv(a[0] >>> 0, a[1] >>> 0, [a[2]]);
        });
        define("TEX_ENVF", function(a) {
            this.setTexEnv(a[0] >>> 0, a[1] >>> 0, [a[2]]);
        });
        define("TEX_ENVIV", function(a) {
            const values = [a[3], a[4], a[5], a[6]];
            this.setTexEnv(a[0] >>> 0, a[1] >>> 0, a[1] === GL.TEXTURE_ENV_COLOR ?
                values.map(v => Math.max(-1, v / 0x7FFFFFFF)) : values);
        });
        define("TEX_ENVFV", function(a) {
            this.setTexEnv(a[0] >>> 0, a[1] >>> 0, [a[3], a[4], a[5], a[6]]);
        });
        define("TEX_GENI", function(a) {
            this.setTexGen(a[0] >>> 0, a[1] >>> 0, [a[2]]);
        });
        define("TEX_GENF", function(a) {
            this.setTexGen(a[0] >>> 0, a[1] >>> 0, [a[2]]);
        });
        define("TEX_GENIV", function(a) {
            this.setTexGen(a[0] >>> 0, a[1] >>> 0, [a[3], a[4], a[5], a[6]]);
        });
        define("TEX_GENFV", function(a) {
            this.setTexGen(a[0] >>> 0, a[1] >>> 0, [a[3], a[4], a[5], a[6]]);
        });

        /* ---- pixel store and transfer ---- */

        define("PIXEL_STOREI", function(a) { this.setPixelStore(a[0] >>> 0, a[1] | 0); });
        define("PIXEL_TRANSFERF", function(a) { this.setPixelTransfer(a[0] >>> 0, a[1]); });
        define("PIXEL_TRANSFERI", function(a) { this.setPixelTransfer(a[0] >>> 0, a[1]); });
        define("PIXEL_ZOOM", function(a) {
            this.current.pixelZoom = { x: a[0], y: a[1] };
        });

        /* ---- point parameters ---- */

        define("POINT_PARAMETERF", function(a) {
            this.setPointParameter(a[0] >>> 0, [a[1]]);
        });
        define("POINT_PARAMETERI", function(a) {
            this.setPointParameter(a[0] >>> 0, [a[1]]);
        });
        define("POINT_PARAMETERFV", function(a) {
            this.setPointParameter(a[0] >>> 0, [a[1], a[2], a[3]]);
        });
        define("POINT_PARAMETERIV", function(a, bytes, view, offset, size) {
            if (size < 8) throw new GLStreamError("glPointParameteriv is too short");
            const pname = view.getUint32(offset, true);
            const values = [];
            for (let i = 4; i + 4 <= size; i += 4)
                values.push(view.getInt32(offset + i, true));
            this.setPointParameter(pname, values);
        });

        /* ---- client array enables ---- */

        define("ENABLE_CLIENT_STATE", function(a) {
            this.setClientState(a[0] >>> 0, true);
        });
        define("DISABLE_CLIENT_STATE", function(a) {
            this.setClientState(a[0] >>> 0, false);
        });
        define("ENABLE_VERTEX_ATTRIB_ARRAY", function(a) {
            const index = a[0] >>> 0;
            if (index < MAX_VERTEX_ATTRIBS) {
                this.current.genericAttribs[index].enabled = true;
                this.arrayState("generic" + index).enabled = true;
            }
        });
        define("DISABLE_VERTEX_ATTRIB_ARRAY", function(a) {
            const index = a[0] >>> 0;
            if (index < MAX_VERTEX_ATTRIBS) {
                this.current.genericAttribs[index].enabled = false;
                this.arrayState("generic" + index).enabled = false;
            }
        });

        /* ---- attribute stacks ---- */
        define("PUSH_ATTRIB", function(a) {
            const s = this.current;
            if (s.attribStack.length >= 16) {
                this.invalidState(GL.STACK_OVERFLOW);
                return;
            }
            const mask = a[0] >>> 0;
            const fields = fieldsForServerAttrib(mask);
            s.attribStack.push({ mask, fields, state: snapshotFields(s, fields),
                textureParameters: mask & ATTRIB.TEXTURE ? this.captureTextureParameters() : null,
                enableState: mask & ATTRIB.ENABLE ? captureEnableState(s) : null });
        });
        define("POP_ATTRIB", function() {
            const s = this.current;
            if (!s.attribStack.length) {
                this.invalidState(GL.STACK_UNDERFLOW);
                return;
            }
            const snapshot = s.attribStack.pop();
            restoreFields(s, snapshot.state, snapshot.fields);
            if (snapshot.textureParameters) for (const item of snapshot.textureParameters) {
                const image = s.shareGroup.textureImages.get(item.id); if (!image) continue;
                image.sampler = cloneStateValue(item.sampler); image.priority = item.priority;
                image.generateMipmapHint = item.generateMipmapHint; image.viewCache.clear();
            }
            const draw = s.drawBuffers.slice(), read = s.readBuffer;
            if (snapshot.state.drawBuffers) framebufferState.draw(s, this.framebuffers.get(s.id), draw);
            if (Object.prototype.hasOwnProperty.call(snapshot.state, "readBuffer")) framebufferState.read(s, this.framebuffers.get(s.id), read);
            if (snapshot.enableState) restoreEnableState(s, snapshot.enableState);
            this.endPass();
            this.invalidateBindGroups();
        });
        define("PUSH_CLIENT_ATTRIB", function(a) {
            const s = this.current;
            if (s.clientAttribStack.length >= 16) {
                this.invalidState(GL.STACK_OVERFLOW);
                return;
            }
            const mask = a[0] >>> 0;
            const fields = [];
            if (mask & CLIENT_ATTRIB.PIXEL_STORE)
                fields.push("pixelStore", "pixelPackBuffer", "pixelUnpackBuffer", "pixelPackBufferId", "pixelUnpackBufferId");
            if (mask & CLIENT_ATTRIB.VERTEX_ARRAY)
                fields.push("clientActiveTexture", "arrays", "arrayBuffer",
                    "elementArrayBuffer", "genericAttribs", "arrayBufferId", "elementArrayBufferId");
            s.clientAttribStack.push({ mask, fields, state: snapshotFields(s, fields) });
        });
        define("POP_CLIENT_ATTRIB", function() {
            const s = this.current;
            if (!s.clientAttribStack.length) {
                this.invalidState(GL.STACK_UNDERFLOW);
                return;
            }
            const snapshot = s.clientAttribStack.pop();
            restoreFields(s, snapshot.state, snapshot.fields);
        });

        /* ---- frame boundaries ---- */

        define("FLUSH", function() { this.flushFront(); });
        define("FINISH", function(a, bytes, view, offset, size, metadata) {
            return this.onFinish(bytes, view, offset, size, metadata);
        });

        return table;
    }

    function facesOf(which) {
        if (which === GL.FRONT) return ["front"];
        if (which === GL.BACK) return ["back"];
        return ["front", "back"];
    }

    const SCRATCH_A = new Float32Array(16);
    const SCRATCH_B = new Float32Array(16);
    const SCRATCH_C = new Float32Array(16);

    /* Shared by the handler-installing functions below. */
    function definer(table) {
        return (name, handler, options) => {
            const opcode = GLFN[name];
            if (opcode === undefined)
                throw new Error("unknown opcode name " + name);
            const signature = SIGNATURES[name];
            if (signature && signature[1].length) handler.signature = signature[1];
            if (options && options.needsContext === false)
                handler.needsContext = false;
            handler.glName = signature ? signature[0] : name;
            table[opcode] = handler;
        };
    }

    /* Reads a name array record: {count u32, names u32[count]}. */
    /*
     * glDepthRange(n, f) with n > f (review S1-2d): WebGPU's viewport wants
     * its depth range in order. n + (f - n)(z + 1)/2 equals f + (n - f)(1 - z)/2,
     * so the viewport gets (f, n) and the vertex stage negates z -- every
     * generator (fixed function, GLSL, ARB) ends with the same conversion
     * line, which the variant rewrites.
     */
    const DEPTH_CONVERSION = "clip.z = (clip.z + clip.w) * 0.5;";
    const PASSING_PLANE = [0, 0, 0, 1];

    /*
     * A shader pair's pipelines are keyed by its code: identical code shares
     * them, and nothing else can (review S1-4: a program name -- the same
     * number in another share group or process, or an ARB program given a
     * new string -- found the first program's pipeline). The length rides
     * along with the hash to make a collision a non-event.
     */
    /*
     * An ARB fragment program's result.color goes to every draw buffer
     * (ARB_draw_buffers without its option, review S1-2f): its one colour
     * output, color0, is copied to the others.
     */
    function broadcastColor(wgsl, targets) {
        if (targets <= 1) return wgsl;
        const field = "    @location(0) color0 : vec4<f32>,\n";
        if (!wgsl.includes(field) || !wgsl.includes("    return out;\n"))
            throw new Error("the fragment stage has no single colour output to broadcast");
        let fields = field, copies = "";
        for (let i = 1; i < targets; ++i) {
            fields += "    @location(" + i + ") color" + i + " : vec4<f32>,\n";
            copies += "    out.color" + i + " = out.color0;\n";
        }
        return wgsl.replace(field, fields).replace("    return out;\n", copies + "    return out;\n");
    }

    // A fragment program's texture bindings, by the targets its instructions name
    function arbProgramTextures(fragment) {
        return fragment.compiled.reflection.textures.map(entry => {
            // SHADOW1D/2D (ARB_fragment_program_shadow): the 1D or 2D
            // texture through a comparison sampler
            const shadow = entry.target.startsWith("SHADOW");
            const target = shadow ? entry.target.slice(6) : entry.target;
            return {
                unit: entry.unit,
                textureBinding: entry.unit * 2,
                samplerBinding: entry.unit * 2 + 1,
                target: target === "CUBE" ? "Cube" : target,
                shadow,
                arbTarget: true,
            };
        });
    }

    // The part of a window rectangle inside a read source
    function clipToSource(source, x, y, width, height) {
        const x0 = Math.max(0, x), y0 = Math.max(0, y);
        const x1 = Math.min(source.width, x + width), y1 = Math.min(source.height, y + height);
        return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
    }

    function reversedDepthRange(s) {
        return s.depthRange.near > s.depthRange.far;
    }

    function flipDepth(wgsl) {
        if (!wgsl.includes(DEPTH_CONVERSION)) throw new Error("the vertex stage has no depth conversion to flip");
        return wgsl.split(DEPTH_CONVERSION).join("clip.z = (clip.w - clip.z) * 0.5;");
    }

    /*
     * glLightiv, glMaterialiv and glLightModeliv: a colour's integers map to
     * [-1, 1] as GL 2.1's table 2.9 says, (2c + 1) / (2^32 - 1); a position,
     * direction, exponent, cutoff, attenuation, shininess or mode is the
     * integer itself (review S2-9: every component was divided).
     */
    const INTEGER_COLORS = new Set([GL.AMBIENT, GL.DIFFUSE, GL.SPECULAR, GL.EMISSION, GL.AMBIENT_AND_DIFFUSE,
        GL.LIGHT_MODEL_AMBIENT]);

    function integerParameters(pname, values) {
        return INTEGER_COLORS.has(pname) ? values.map(c => (2 * c + 1) / 4294967295) : values;
    }

    function readNameArray(view, offset, size) {
        if (size < 4) throw new GLStreamError("name array record is too short");
        const count = view.getUint32(offset, true);
        if (4 + count * 4 > size)
            throw new GLStreamError("name array record is truncated");
        const names = new Uint32Array(count);
        for (let i = 0; i < count; ++i)
            names[i] = view.getUint32(offset + 4 + i * 4, true);
        return names;
    }

    function readCString(bytes, offset, length) {
        let end = offset;
        const limit = offset + length;
        while (end < limit && bytes[end] !== 0) ++end;
        let text = "";
        for (let i = offset; i < end; ++i) text += String.fromCharCode(bytes[i]);
        return text;
    }

    /*
     * Writes `text` NUL-terminated into a guest buffer of `capacity` bytes and
     * returns the character count GL wants reported -- which excludes the
     * terminator, the same convention openglproxy's own copy_gl_string_result
     * uses when it answers one of these queries without the host.
     */
    function installResourceHandlers(table) {
        const define = definer(table);

        /* ---- textures ---- */

        define("GEN_TEXTURES", function(a, bytes, view, offset, size) {
            const names = readNameArray(view, offset, size);
            for (const name of names) {
                if (!name) continue;
                this.namedImage("texture", name);
            }
        });

        define("DELETE_TEXTURES", function(a, bytes, view, offset, size) {
            const names = readNameArray(view, offset, size);
            const group = this.current.shareGroup;
            for (const name of names) {
                const texture = group.textures.get(name);
                if (!texture) continue;
                group.textures.delete(name);
                texture.deleted = true;
                // GL rebinds the default texture on every unit that held it,
                // which is what keeps a later draw from sampling a dead object.
                for (const unit of this.current.textureUnits) {
                    for (const target of Object.keys(unit.bindings))
                        if (unit.imageBindings[target] === texture.imageId) {
                            unit.bindings[target] = 0; delete unit.imageBindings[target];
                        }
                }
                this.detachImage("texture", texture.imageId);
                this.invalidateBindGroups();
            }
        });

        define("BIND_TEXTURE", function(a) {
            const target = a[0] >>> 0, name = a[1] >>> 0;
            const unit = this.current.textureUnits[this.current.activeTexture];
            unit.bindings[target] = name;
            const texture = name ? this.namedImage("texture", name) : this.defaultTexture(target);
            unit.imageBindings[target] = texture.imageId;
            if (!texture.target) texture.target = target;
            this.invalidateBindGroups();
        });

        define("TEX_PARAMETERI", function(a) {
            this.setTexParameter(a[0] >>> 0, a[1] >>> 0, [a[2]], true, true);
        });
        define("TEX_PARAMETERF", function(a) {
            this.setTexParameter(a[0] >>> 0, a[1] >>> 0, [a[2]], false, true);
        });
        define("TEX_PARAMETERIV", function(a) {
            this.setTexParameter(a[0] >>> 0, a[1] >>> 0, a.slice(3, 3 + a[2]), true, false);
        });
        define("TEX_PARAMETERFV", function(a) {
            this.setTexParameter(a[0] >>> 0, a[1] >>> 0, a.slice(3, 3 + a[2]), false, false);
        });
        define("PRIORITIZE_TEXTURES", function(a, bytes, view, offset, size) {
            const count = view.getInt32(offset, true);
            if (count < 0 || 4 + count * 8 > size) throw new GLStreamError("texture priorities are truncated");
            for (let i = 0; i < count; ++i) {
                const image = this.current.shareGroup.textures.get(view.getUint32(offset + 4 + i * 8, true));
                if (image?.target) image.priority = clamp(view.getFloat32(offset + 8 + i * 8, true), 0, 1);
            }
        });

        /*
         * glTexImage*: the 1D, 2D and 3D headers (gl_protocol.js) differ only
         * in the dimensions they have; everything after them is dataSize
         * bytes of pixels, decoded by one function.
         */
        const texImage = dimensions => function(a, bytes, view, offset, size) {
            const name = "TEX_IMAGE_" + dimensions + "D";
            const header = protocol.RECORDS[name].size;
            if (size < header)
                throw new GLStreamError("glTexImage record is too short");
            const r = protocol.decodeRecord(name, view, offset);
            if (PROXY_TARGETS.has(r.target)) return;
            const data = r.data_size ?
                bytes.subarray(offset + header, offset + header + r.data_size) :
                null;
            this.texImage(r.target, r.level, r.internalformat >>> 0, r.width,
                dimensions >= 2 ? r.height : 1, dimensions >= 3 ? r.depth : 1,
                r.format, r.type, data, r.data_size);
        };
        define("TEX_IMAGE_1D", texImage(1));
        define("TEX_IMAGE_2D", texImage(2));
        define("TEX_IMAGE_3D", texImage(3));

        const texSubImage = dimensions => function(a, bytes, view, offset, size) {
            const name = "TEX_SUB_IMAGE_" + dimensions + "D";
            const header = protocol.RECORDS[name].size;
            if (size < header)
                throw new GLStreamError("glTexSubImage record is too short");
            const r = protocol.decodeRecord(name, view, offset);
            const data = r.data_size ?
                bytes.subarray(offset + header, offset + header + r.data_size) :
                null;
            this.texSubImage(r.target, r.level, r.xoffset,
                dimensions >= 2 ? r.yoffset : 0, dimensions >= 3 ? r.zoffset : 0,
                r.width, dimensions >= 2 ? r.height : 1, dimensions >= 3 ? r.depth : 1,
                r.format, r.type, data, r.data_size);
        };
        define("TEX_SUB_IMAGE_1D", texSubImage(1));
        define("TEX_SUB_IMAGE_2D", texSubImage(2));
        define("TEX_SUB_IMAGE_3D", texSubImage(3));

        const compressedTexImage = dimensions => function(a, bytes, view, offset, size) {
            // The guest deliberately uses one fixed wire struct for the 1D,
            // 2D and 3D entry points.  height and depth are therefore present
            // even for a 2D command (where depth is 1).  Parsing a
            // dimension-dependent header used to read the 2D border field as
            // imageSize, turning every real DXT payload into zero bytes.
            if (size < 32)
                throw new GLStreamError("compressed texture record is too short");
            let at = offset;
            const target = view.getUint32(at, true); at += 4;
            if (PROXY_TARGETS.has(target)) return;
            const level = view.getInt32(at, true); at += 4;
            const internalFormat = view.getUint32(at, true); at += 4;
            const width = view.getInt32(at, true); at += 4;
            const wireHeight = view.getInt32(at, true); at += 4;
            const wireDepth = view.getInt32(at, true); at += 4;
            at += 4;                            // border
            const dataSize = view.getUint32(at, true); at += 4;
            if (at - offset + dataSize > size)
                throw new GLStreamError("compressed texture record is truncated");
            const data = bytes.subarray(at, at + dataSize);
            const height = dimensions >= 2 ? wireHeight : 1;
            const depth = dimensions >= 3 ? wireDepth : 1;
            this.compressedTexImage(target, level, internalFormat, width, height,
                depth, data);
        };
        define("COMPRESSED_TEX_IMAGE_1D", compressedTexImage(1));
        define("COMPRESSED_TEX_IMAGE_2D", compressedTexImage(2));
        define("COMPRESSED_TEX_IMAGE_3D", compressedTexImage(3));

        const compressedTexSubImage = dimensions => function(a, bytes, view, offset, size) {
            // A partial update of a compressed level must land on block
            // boundaries; GL requires it and WebGPU enforces it, so a
            // misaligned rectangle is refused rather than silently rounded.
            // As above, the guest payload is the same fixed 40-byte struct for
            // all three dimensionalities.
            if (size < 40)
                throw new GLStreamError("compressed subimage record is too short");
            let at = offset;
            const target = view.getUint32(at, true); at += 4;
            const level = view.getInt32(at, true); at += 4;
            const x = view.getInt32(at, true); at += 4;
            const wireY = view.getInt32(at, true); at += 4;
            const wireZ = view.getInt32(at, true); at += 4;
            const width = view.getInt32(at, true); at += 4;
            const wireHeight = view.getInt32(at, true); at += 4;
            const wireDepth = view.getInt32(at, true); at += 4;
            const format = view.getUint32(at, true); at += 4;
            const dataSize = view.getUint32(at, true); at += 4;
            if (at - offset + dataSize > size)
                throw new GLStreamError("compressed subimage record is truncated");
            const data = bytes.subarray(at, at + dataSize);
            const y = dimensions >= 2 ? wireY : 0;
            const z = dimensions >= 3 ? wireZ : 0;
            const height = dimensions >= 2 ? wireHeight : 1;
            const depth = dimensions >= 3 ? wireDepth : 1;
            this.compressedTexSubImage(target, level, x, y, z, width, height,
                depth, format, data);
        };
        define("COMPRESSED_TEX_SUB_IMAGE_1D", compressedTexSubImage(1));
        define("COMPRESSED_TEX_SUB_IMAGE_2D", compressedTexSubImage(2));
        define("COMPRESSED_TEX_SUB_IMAGE_3D", compressedTexSubImage(3));

        define("GENERATE_MIPMAP", function(a) {
            this.generateMipmap(a[0] >>> 0);
        });

        define("COPY_TEX_IMAGE_2D", function(a) {
            this.copyTexImage(a[0] >>> 0, a[1] | 0, a[2] >>> 0, a[3] | 0, a[4] | 0,
                a[5] | 0, a[6] | 0);
        });
        define("COPY_TEX_IMAGE_1D", function(a) {
            this.copyTexImage(a[0] >>> 0, a[1] | 0, a[2] >>> 0, a[3] | 0, a[4] | 0,
                a[5] | 0, 1);
        });
        define("COPY_TEX_SUB_IMAGE_2D", function(a) {
            this.copyTexSubImage(a[0] >>> 0, a[1] | 0, a[2] | 0, a[3] | 0, 0,
                a[4] | 0, a[5] | 0, a[6] | 0, a[7] | 0);
        });
        define("COPY_TEX_SUB_IMAGE_1D", function(a) {
            this.copyTexSubImage(a[0] >>> 0, a[1] | 0, a[2] | 0, 0, 0,
                a[3] | 0, a[4] | 0, a[5] | 0, 1);
        });
        define("COPY_TEX_SUB_IMAGE_3D", function(a) {
            this.copyTexSubImage(a[0] >>> 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0,
                a[5] | 0, a[6] | 0, a[7] | 0, a[8] | 0);
        });

        /* ---- buffers ---- */

        define("GEN_BUFFERS", function(a, bytes, view, offset, size) {
            const names = readNameArray(view, offset, size);
            for (const name of names) if (name) this.namedBuffer(name);
        });
        define("DELETE_BUFFERS", function(a, bytes, view, offset, size) {
            const names = readNameArray(view, offset, size);
            const group = this.current.shareGroup;
            for (const name of names) {
                const buffer = group.buffers.get(name);
                if (!buffer) continue;
                group.buffers.delete(name); buffer.deleted = true;
                for (const field of BUFFER_TARGET_FIELDS.values()) if (this.current[field + "Id"] === buffer.id) {
                    this.current[field] = 0; this.current[field + "Id"] = 0;
                }
                for (const array of Object.values(this.current.arrays || {})) if (array.bufferId === buffer.id) {
                    array.buffer = 0; array.bufferId = 0;
                }
            }
        });
        define("BIND_BUFFER", function(a) {
            const target = a[0] >>> 0, name = a[1] >>> 0;
            const field = BUFFER_TARGET_FIELDS.get(target);
            if (!field) return this.refuse("glBindBuffer", "unknown buffer target",
                    { target }, GL.INVALID_ENUM);
            const buffer = name ? this.namedBuffer(name) : null;
            this.current[field] = name; this.current[field + "Id"] = buffer?.id || 0;
        });
        /*
         * {target, size, usage, data_size} then the contents. The header is
         * four words: reading the data from 12 shifts every vertex in the
         * buffer by one attribute and draws geometry that is subtly wrong
         * rather than reporting anything.
         */
        define("BUFFER_DATA", function(a, bytes, view, offset, size) {
            if (size < 16) throw new GLStreamError("glBufferData record is short");
            const target = view.getUint32(offset + protocol.F.BUFFER_DATA.target, true);
            const byteCount = view.getUint32(offset + protocol.F.BUFFER_DATA.size, true);
            const usage = view.getUint32(offset + protocol.F.BUFFER_DATA.usage, true);
            const dataSize = Math.min(view.getUint32(offset + protocol.F.BUFFER_DATA.data_size, true), size - 16);
            const data = dataSize ?
                bytes.subarray(offset + 16,
                    offset + 16 + Math.min(dataSize, byteCount)) :
                null;
            this.bufferData(target, byteCount, usage, data);
        });
        /* {target, offset, size, data_size} then the contents. */
        define("BUFFER_SUB_DATA", function(a, bytes, view, offset, size) {
            if (size < 16) throw new GLStreamError("glBufferSubData record is short");
            const target = view.getUint32(offset + protocol.F.BUFFER_SUB_DATA.target, true);
            const dstOffset = view.getUint32(offset + protocol.F.BUFFER_SUB_DATA.offset, true);
            const byteCount = Math.min(view.getUint32(offset + protocol.F.BUFFER_SUB_DATA.size, true), size - 16);
            const data = bytes.subarray(offset + 16,
                offset + 16 + byteCount);
            this.bufferSubData(target, dstOffset, data);
        });

        /* ---- VBO-backed array pointers ---- */

        const pointerVBO = which => function(a, bytes, view, offset, size) {
            const R = protocol.F.VERTEX_POINTER_VBO;
            if (size < protocol.RECORDS.VERTEX_POINTER_VBO.size)
                throw new GLStreamError("VBO pointer record is short");
            const s = this.current;
            const array = {
                buffer: s.arrayBuffer,
                bufferId: this.bufferFor(GL.ARRAY_BUFFER)?.id || 0,
                size: view.getInt32(offset + R.size, true),
                type: view.getUint32(offset + R.type, true),
                stride: view.getInt32(offset + R.stride, true),
                offset: view.getUint32(offset + R.offset, true),
                normalized: which === "color" || which === "secondaryColor" ||
                    which === "normal",
                fromVBO: true,
            };
            this.setArrayPointer(which, array);
        };
        define("VERTEX_POINTER_VBO", pointerVBO("vertex"));
        define("COLOR_POINTER_VBO", pointerVBO("color"));
        define("NORMAL_POINTER_VBO", pointerVBO("normal"));
        define("SECONDARY_COLOR_POINTER_VBO", pointerVBO("secondaryColor"));
        define("FOG_COORD_POINTER_VBO", pointerVBO("fogCoord"));
        define("INDEX_POINTER_VBO", pointerVBO("index"));
        define("EDGE_FLAG_POINTER_VBO", pointerVBO("edgeFlag"));
        define("TEX_COORD_POINTER_VBO", function(a, bytes, view, offset, size) {
            const R = protocol.F.TEX_COORD_POINTER_VBO;
            if (size < protocol.RECORDS.TEX_COORD_POINTER_VBO.size) throw new GLStreamError("VBO pointer record is short");
            const s = this.current;
            this.setArrayPointer("texCoord" + s.clientActiveTexture, {
                buffer: s.arrayBuffer,
                bufferId: this.bufferFor(GL.ARRAY_BUFFER)?.id || 0,
                size: view.getInt32(offset + R.size, true),
                type: view.getUint32(offset + R.type, true),
                stride: view.getInt32(offset + R.stride, true),
                offset: view.getUint32(offset + R.offset, true),
                normalized: false, fromVBO: true,
            });
        });
        define("VERTEX_ATTRIB_POINTER_VBO", function(a, bytes, view, offset, size) {
            if (size < 24) throw new GLStreamError("attrib pointer record is short");
            const index = view.getUint32(offset + protocol.F.VERTEX_ATTRIB_POINTER_VBO.index, true);
            if (index >= MAX_VERTEX_ATTRIBS)
                return this.refuse("glVertexAttribPointer", "index out of range",
                    { index }, GL.INVALID_VALUE);
            this.setArrayPointer("generic" + index, {
                // glVertexAttribPointer changes the array format only.  Its
                // enable is independent state controlled by
                // glEnable/DisableVertexAttribArray; forcing it on here made
                // Cube 2's disabled vcolor array keep reading a stale world
                // VBO instead of the current constant colour used by models.
                enabled: this.current.genericAttribs[index].enabled,
                buffer: this.current.arrayBuffer,
                bufferId: this.bufferFor(GL.ARRAY_BUFFER)?.id || 0,
                size: view.getInt32(offset + protocol.F.VERTEX_ATTRIB_POINTER_VBO.size, true),
                type: view.getUint32(offset + protocol.F.VERTEX_ATTRIB_POINTER_VBO.type, true),
                normalized: view.getUint32(offset + protocol.F.VERTEX_ATTRIB_POINTER_VBO.normalized, true) !== 0,
                stride: view.getInt32(offset + protocol.F.VERTEX_ATTRIB_POINTER_VBO.stride, true),
                offset: view.getUint32(offset + protocol.F.VERTEX_ATTRIB_POINTER_VBO.offset, true),
                fromVBO: true,
            });
        });

        /* ---- framebuffer objects ---- */

        define("GEN_FRAMEBUFFERS", function(a, bytes, view, offset, size) {
            const names = readNameArray(view, offset, size);
            for (const name of names) if (name) this.namedFramebuffer(name);
        });
        define("DELETE_FRAMEBUFFERS", function(a, bytes, view, offset, size) {
            const names = readNameArray(view, offset, size);
            const map = this.framebuffers.get(this.current.id);
            for (const name of names) {
                const object = name && this.findFramebuffer(name); if (!object) continue;
                const s = this.current, g = s.shareGroup; this.endPass();
                if (s.privateFramebuffers.get(name) === object) s.privateFramebuffers.delete(name);
                if (g.sharedFramebuffers.get(name) === object) g.sharedFramebuffers.delete(name);
                if (g.framebufferReservations.get(name) === object) g.framebufferReservations.delete(name);
                for (const c of this.contexts.values()) if (c.shareGroup === g) {
                    const visible = this.framebuffers.get(c.id); if (visible.get(name) === object) visible.delete(name);
                }
                if (s.drawFramebufferObject === object) { s.drawFramebuffer = 0; s.drawFramebufferObject = null; }
                if (s.readFramebufferObject === object) { s.readFramebuffer = 0; s.readFramebufferObject = null; }
            }
            framebufferState.sync(this.current, map);
        });
        for (const kind of ["BIND_FRAMEBUFFER", "BIND_FRAMEBUFFER_EXT"]) define(kind, function(a) {
            const target = a[0] >>> 0, name = a[1] >>> 0;
            const s = this.current, g = s.shareGroup, map = this.framebuffers.get(s.id);
            const object = name ? this.namedFramebuffer(name) : null;
            if (object && !object.created) {
                object.created = true; object.shared = kind === "BIND_FRAMEBUFFER_EXT";
                g.framebufferReservations.delete(name);
                if (object.shared) {
                    g.sharedFramebuffers.set(name, object);
                    for (const c of this.contexts.values()) if (c.shareGroup === g && !c.privateFramebuffers.has(name)) this.framebuffers.get(c.id).set(name, object);
                } else {
                    s.privateFramebuffers.set(name, object);
                    for (const c of this.contexts.values()) if (c !== s && c.shareGroup === g && this.framebuffers.get(c.id).get(name) === object) this.framebuffers.get(c.id).delete(name);
                }
            }
            // Changing the render target ends the pass: WebGPU fixes the
            // attachments when the pass begins.
            this.endPass();
            framebufferState.bind(s, map, target, name, object);
        });
        for (const name of ["FRAMEBUFFER_TEXTURE", "FRAMEBUFFER_TEXTURE_1D", "FRAMEBUFFER_TEXTURE_2D", "FRAMEBUFFER_TEXTURE_3D"]) define(name, function(a) {
            this.framebufferTexture(a[0] >>> 0, a[1] >>> 0, a[2] >>> 0,
                a[3] >>> 0, a[4] | 0, a[5] | 0);
        });
        define("FRAMEBUFFER_RENDERBUFFER", function(a) {
            this.framebufferRenderbuffer(a[0] >>> 0, a[1] >>> 0, a[2] >>> 0,
                a[3] >>> 0);
        });
        define("GEN_RENDERBUFFERS", function(a, bytes, view, offset, size) {
            const names = readNameArray(view, offset, size);
            for (const name of names)
                if (name) this.namedImage("renderbuffer", name);
        });
        define("DELETE_RENDERBUFFERS", function(a, bytes, view, offset, size) {
            const names = readNameArray(view, offset, size);
            const group = this.current.shareGroup;
            for (const name of names) {
                const rb = group.renderbuffers.get(name);
                if (!rb) continue;
                rb.deleted = true;
                group.renderbuffers.delete(name);
                if (this.current.renderbufferImage === rb.imageId) this.current.renderbuffer = this.current.renderbufferImage = 0;
                this.detachImage("renderbuffer", rb.imageId);
            }
        });
        define("BIND_RENDERBUFFER", function(a) {
            const name = a[1] >>> 0;
            this.current.renderbufferImage = name ? this.namedImage("renderbuffer", name).imageId : 0;
            this.current.renderbuffer = name;
        });
        define("RENDERBUFFER_STORAGE", function(a) {
            this.renderbufferStorage(a[1] >>> 0, a[2] | 0, a[3] | 0);
        });
        define("DRAW_BUFFER", function(a) {
            this.endPass();
            framebufferState.draw(this.current, this.framebuffers.get(this.current.id), [a[0] >>> 0]);
        });
        define("READ_BUFFER", function(a) { framebufferState.read(this.current, this.framebuffers.get(this.current.id), a[0] >>> 0); });
        define("DRAW_BUFFERS", function(a, bytes, view, offset, size) {
            const count = size >= 4 ? view.getUint32(offset, true) : 0;
            const buffers = [];
            for (let i = 0; i < count && 4 + i * 4 + 4 <= size; ++i)
                buffers.push(view.getUint32(offset + 4 + i * 4, true));
            this.endPass();
            framebufferState.draw(this.current, this.framebuffers.get(this.current.id), buffers);
        });
        define("BLIT_FRAMEBUFFER", function(a) {
            this.blitFramebuffer(a[0] | 0, a[1] | 0, a[2] | 0, a[3] | 0,
                a[4] | 0, a[5] | 0, a[6] | 0, a[7] | 0, a[8] >>> 0, a[9] >>> 0);
        });

        /* ---- occlusion queries ---- */

        define("GEN_QUERIES", function(a, bytes, view, offset, size) {
            const names = readNameArray(view, offset, size);
            for (const name of names)
                if (name && !this.queries.has(name))
                    this.queries.set(name, createQuery(name));
        });
        define("DELETE_QUERIES", function(a, bytes, view, offset, size) {
            const names = readNameArray(view, offset, size);
            for (const name of names) {
                const query = this.queries.get(name); if (query) ++query.generation;
                this.queries.delete(name);
            }
        });
        define("BEGIN_QUERY", function(a) { this.beginQuery(a[0] >>> 0, a[1] >>> 0); });
        define("END_QUERY", function(a) { this.endQuery(a[0] >>> 0); });
    }

    /* The guest observes these in the record it submitted, so the values are
     * part of the wire contract and not an internal detail. */
    const SYNC_STATUS_PENDING = protocol.C.V86GL_SYNC_QUERY_STATUS_PENDING;
    const SYNC_STATUS_OK = protocol.C.V86GL_SYNC_QUERY_STATUS_OK;
    const SYNC_STATUS_FAILED = protocol.C.V86GL_SYNC_QUERY_STATUS_FAILED;
    const READ_PIXELS_HEADER_SIZE = protocol.RECORDS.READ_PIXELS.size;

    /* openglproxy's V86GL_PROGRAM_PARAMETER_ENV / _LOCAL. */
    const PROGRAM_PARAMETER_ENV = protocol.C.V86GL_PROGRAM_PARAMETER_ENV;
    const PROGRAM_PARAMETER_LOCAL = protocol.C.V86GL_PROGRAM_PARAMETER_LOCAL;

    /*
     * V86GL_LOCATION_KIND_* and V86GL_ACTIVE_KIND_*. Uniform is 1 in both --
     * getting the pair the other way round is invisible until an application
     * asks for a uniform location and is handed an attribute's.
     */
    const LOCATION_KIND_ATTRIB = protocol.C.V86GL_LOCATION_KIND_ATTRIB;

    /*
     * ARB program environment and local parameters are context state that the
     * extension lets an application set before -- or without ever -- handing
     * the target a program that compiles, so the storage is allocated with the
     * program object rather than at the end of a successful assemble.
     */
    function arbParameterStorage(program, kind) {
        if (!program.env) {
            program.env = new Float32Array(
                arbProgram.MAX_PROGRAM_PARAMETERS * 4);
            program.local = new Float32Array(
                arbProgram.MAX_PROGRAM_PARAMETERS * 4);
        }
        return kind === PROGRAM_PARAMETER_LOCAL ? program.local : program.env;
    }

    function installProgramHandlers(table) {
        const define = definer(table);

        define("CREATE_PROGRAM", function(a) {
            const name = a[0] >>> 0;
            const group = this.current.shareGroup;
            if (!group.programs.has(name))
                group.programs.set(name, createProgram(name));
        });
        define("CREATE_SHADER", function(a) {
            const name = a[0] >>> 0, type = a[1] >>> 0;
            const group = this.current.shareGroup;
            group.shaders.set(name, {
                name, type, source: "", compiled: null,
                stage: type === GL.VERTEX_SHADER ? "vertex" : "fragment",
            });
        });
        define("DELETE_PROGRAM", function(a) {
            const group = this.current.shareGroup, program = group.programs.get(a[0] >>> 0);
            if (program) { program.deleted = true; this.collectGLProgram(group, program); }
        });
        define("DELETE_SHADER", function(a) {
            const group = this.current.shareGroup, shader = group.shaders.get(a[0] >>> 0);
            if (shader) { shader.deleted = true; this.collectGLShader(group, shader); }
        });
        define("ATTACH_SHADER", function(a) {
            const program = this.current.shareGroup.programs.get(a[0] >>> 0);
            if (program) program.shaders.add(a[1] >>> 0);
        });
        define("DETACH_SHADER", function(a) {
            const group = this.current.shareGroup, program = group.programs.get(a[0] >>> 0);
            if (program) program.shaders.delete(a[1] >>> 0);
            const shader = group.shaders.get(a[1] >>> 0);
            if (shader) this.collectGLShader(group, shader);
        });
        define("SHADER_SOURCE", function(a, bytes, view, offset, size) {
            if (size < 8) throw new GLStreamError("glShaderSource record is short");
            const name = view.getUint32(offset, true);
            const length = view.getUint32(offset + 4, true);
            if (8 + length > size)
                throw new GLStreamError("glShaderSource record is truncated");
            const shader = this.current.shareGroup.shaders.get(name);
            if (!shader)
                return this.refuse("glShaderSource", "unknown shader",
                    { name }, GL.INVALID_VALUE);
            shader.source = readCString(bytes, offset + 8, length);
        });
        define("COMPILE_SHADER", function(a) {
            const shader = this.current.shareGroup.shaders.get(a[0] >>> 0);
            if (!shader)
                return this.refuse("glCompileShader", "unknown shader",
                    { name: a[0] }, GL.INVALID_VALUE);
            shader.compiled = translator.compileShader(shader.source,
                shader.stage, { ...this.options.translator, library: true });
        });
        define("LINK_PROGRAM", function(a) { this.linkProgram(a[0] >>> 0); });
        define("RESOLVED_PROGRAM_INTERFACE", function(a, bytes, view, offset, size) {
            const r = protocol.decodeProgramInterface(view, offset, size), program = this.current.shareGroup.programs.get(r.program);
            if (!program || !program.linked) return;
            const attributes = new Map(r.entries.filter(entry => entry.location_kind === LOCATION_KIND_ATTRIB).map(entry => [entry.name, entry.location]));
            program.adoptedAttribLocations = attributes;
            program.cpuObjectId = r.object_id; program.cpuLinkGeneration = r.link_generation;
            const link = this.linkVariant(program, {});
            if (!link.ok) throw new GLStreamError("CPU program interface could not be installed: " + link.log);
            program.link = link; program.variants.clear();
            for (const entry of r.entries) if (entry.location_kind === protocol.C.V86GL_LOCATION_KIND_UNIFORM)
                this.adoptLocation(entry.location_kind, r.program, entry.name, entry.location);
        });
        define("PROGRAM_LINK_FAILED", function(a) {
            const program = this.current.shareGroup.programs.get(a[0] >>> 0);
            if (program) {
                program.linked = false;
                program.log = "ERROR: program link rejected by CPU validation\n";
                program.validateLog = "program is not validated";
            }
        });
        define("USE_PROGRAM", function(a) {
            const group = this.current.shareGroup, previous = group.programs.get(this.current.currentProgram);
            this.current.currentProgram = a[0] >>> 0;
            if (previous) this.collectGLProgram(group, previous);
        });
        define("VALIDATE_PROGRAM", function(a) {
            const program = this.current.shareGroup.programs.get(a[0] >>> 0);
            if (program)
                program.validateLog = program.linked ? "" :
                    "program is not linked";
        });
        define("BIND_ATTRIB_LOCATION", function(a, bytes, view, offset, size) {
            if (size < 12) throw new GLStreamError("bind-attrib record is short");
            const programName = view.getUint32(offset, true);
            const location = view.getInt32(offset + 4, true);
            const nameLength = view.getUint32(offset + 8, true);
            const program = this.current.shareGroup.programs.get(programName);
            if (!program) return;
            const attribute = readCString(bytes, offset + 12, nameLength);
            // Takes effect at the next link, exactly as GL specifies.
            program.bindAttribLocations.set(attribute, location);
        });
        define("MAP_UNIFORM_LOCATION", function() { /* answered by QUERY_LOCATION */ });
        define("MAP_ATTRIB_LOCATION", function() { /* answered by QUERY_LOCATION */ });
        define("INVALIDATE_PROGRAM_LOCATIONS", function(a) {
            const program = this.current.shareGroup.programs.get(a[0] >>> 0);
            if (program) ++program.serial;
        });

        define("UNIFORM_FV", function(a, bytes, view, offset, size) {
            this.setUniformVector(view, offset, size, bytes, false);
        });
        define("UNIFORM_IV", function(a, bytes, view, offset, size) {
            this.setUniformVector(view, offset, size, bytes, true);
        });
        define("UNIFORM_MATRIX_FV", function(a, bytes, view, offset, size) {
            if (size < 16) throw new GLStreamError("uniform-matrix record is short");
            const location = view.getInt32(offset, true);
            const dimension = view.getInt32(offset + 4, true);
            const count = view.getInt32(offset + 8, true);
            const transpose = view.getUint32(offset + 12, true) !== 0;
            this.setUniformMatrix(location, dimension, dimension, count,
                transpose, view, offset + 16, size - 16);
        });
        define("UNIFORM_MATRIX_RECT_FV", function(a, bytes, view, offset, size) {
            if (size < 20) throw new GLStreamError("uniform-matrix record is short");
            const location = view.getInt32(offset, true);
            const columns = view.getInt32(offset + 4, true);
            const rows = view.getInt32(offset + 8, true);
            const count = view.getInt32(offset + 12, true);
            const transpose = view.getUint32(offset + 16, true) !== 0;
            this.setUniformMatrix(location, columns, rows, count, transpose,
                view, offset + 20, size - 20);
        });

/* CPU-only queries may remain in accepted streams for compatibility.
         * They never write answers. Only GPU-derived results below use the
         * asynchronous guest-memory response channel. */

        define("QUERY_ERROR", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.QUERY_ERROR.size) throw new GLStreamError("QUERY_ERROR record is short");
            if (view.getUint32(offset + protocol.F.QUERY_ERROR.status, true) === SYNC_STATUS_PENDING)
                this.refuse("CPU query", "unexpected pending QUERY_ERROR", {});
        }, { needsContext: false });

        // CPU-only query: it must never consult the page's state or write a
        // late answer into its copy of guest memory. Old query records keep
        // their existing path while the shadow's state coverage grows.
        define("QUERY_STATE", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.QUERY_STATE.size)
                throw new GLStreamError("query-state record is short");
        }, { needsContext: false });
        define("QUERY_PARAMETER", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.QUERY_PARAMETER.size)
                throw new GLStreamError("query-parameter record is short");
        }, { needsContext: false });
        for (const name of ["QUERY_BUFFER_DATA", "QUERY_BUFFER_MAP", "QUERY_BUFFER_UNMAP", "QUERY_NAMES", "QUERY_LIST", "LIST_COMMAND", "LIST_CALLS", "QUERY_RENDER_MODE", "NAME_COMMAND",
            "MAP_EVALUATOR", "EVALUATOR_GRID", "EVAL_COORD", "EVAL_MESH", "QUERY_EVALUATOR"])
            define(name, function(a, bytes, view, offset, size) {
                if (size < protocol.RECORDS[name].size) throw new GLStreamError(name + " record is short");
            }, { needsContext: false });
        define("QUERY_TEXTURE_IMAGE", function(a, bytes, view, offset, size, metadata) {
            this.queryTextureImage(bytes, view, offset, size, metadata);
        }, { needsContext: false });

        define("QUERY_INTEGER", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.QUERY_INTEGER.size) throw new GLStreamError("QUERY_INTEGER record is short");
            if (view.getUint32(offset + protocol.F.QUERY_INTEGER.status, true) === SYNC_STATUS_PENDING)
                this.refuse("CPU query", "unexpected pending QUERY_INTEGER", {});
        }, { needsContext: false });

        define("QUERY_GL_STRING", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.QUERY_GL_STRING.size) throw new GLStreamError("QUERY_GL_STRING record is short");
            if (view.getUint32(offset + protocol.F.QUERY_GL_STRING.status, true) === SYNC_STATUS_PENDING)
                this.refuse("CPU query", "unexpected pending QUERY_GL_STRING", {});
        }, { needsContext: false });

        define("QUERY_LOCATION", function(a, bytes, view, offset, size) {
            if (size < 32) throw new GLStreamError("query-location record is short");
            const kind = view.getUint32(offset + protocol.F.QUERY_LOCATION.location_kind, true);
            const programName = view.getUint32(offset + protocol.F.QUERY_LOCATION.program, true);
            const nameLength = view.getUint32(offset + protocol.F.QUERY_LOCATION.name_length, true);
            const status = view.getUint32(offset + protocol.F.QUERY_LOCATION.status, true);
            if (status !== SYNC_STATUS_PENDING) {
                // answered on the CPU side: the guest's location is that one
                if (status === SYNC_STATUS_OK && 32 + nameLength <= size)
                    this.adoptLocation(kind, programName, readCString(bytes, offset + 32, nameLength),
                        view.getInt32(offset + protocol.F.QUERY_LOCATION.result, true));
                return;
            }
            this.refuse("CPU query", "unexpected pending location query", { kind, programName });
        });

        define("QUERY_UNIFORM", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.QUERY_UNIFORM.size) throw new GLStreamError("QUERY_UNIFORM record is short");
            if (view.getUint32(offset + protocol.F.QUERY_UNIFORM.status, true) === SYNC_STATUS_PENDING)
                this.refuse("CPU query", "unexpected pending QUERY_UNIFORM", {});
        }, { needsContext: false });

        define("QUERY_OBJECT_IV", function(a, bytes, view, offset, size, metadata) {
            if (size < 24) throw new GLStreamError("query-object record is short");
            // answered on the CPU side already (gl_shadow_glsl.js)
            if (view.getUint32(offset + protocol.F.QUERY_OBJECT_IV.status, true) !== SYNC_STATUS_PENDING) return;
            const kind = view.getUint32(offset + protocol.F.QUERY_OBJECT_IV.object_kind, true);
            const name = view.getUint32(offset + protocol.F.QUERY_OBJECT_IV.name, true);
            const pname = view.getUint32(offset + protocol.F.QUERY_OBJECT_IV.pname, true);
            // a query object's result is this side's: the guest waits for it
            // in guest memory, in either mode
            if (kind === protocol.C.V86GL_OBJECT_KIND_QUERY) {
                const query = this.queries.get(name), generation = query?.generation;
                const answer = (ok, value) => {
                    const data = new Uint8Array(8), out = new DataView(data.buffer);
                    out.setUint32(0, ok ? SYNC_STATUS_OK : SYNC_STATUS_FAILED, true); out.setUint32(4, value >>> 0, true);
                    return this.answerGuest(bytes, metadata, [...(ok ? [[offset + protocol.F.QUERY_OBJECT_IV.value, data.subarray(4)]] : []),
                        [offset + protocol.F.QUERY_OBJECT_IV.status, data.subarray(0, 4)]]);
                };
                if (!query || query.active || ![GL.QUERY_RESULT, GL.QUERY_RESULT_AVAILABLE].includes(pname)) return answer(false, 0);
                // Polling must submit the commands which produce the answer;
                // RESULT waits for their readback, rather than reporting a
                // provisional zero from an unsubmitted command encoder.
                this.flushFrame();
                if (pname === GL.QUERY_RESULT_AVAILABLE) return answer(true, +query.ready);
                if (query.ready) return answer(true, query.result);
                const pending = Promise.all([...this.pendingReadbacks]);
                this.trackReadback(this.awaitReadback(pending, "glGetQueryObject").then(() =>
                    answer(query.generation === generation && query.ready, query.result), () => answer(false, 0)));
                return;
            }
            this.refuse("CPU query", "unexpected pending shader/program query", { kind, name, pname });
        });

        /*
         * {kind, name, buf_size, status, length, data_size} then the text.
         * The header is six words, so the string starts at 24 and not at 20:
         * openglproxy reads it back at sizeof(request), and four bytes of slip
         * here hand glGetShaderInfoLog a log that is missing its first word.
         */
        define("QUERY_OBJECT_LOG", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.QUERY_OBJECT_LOG.size) throw new GLStreamError("QUERY_OBJECT_LOG record is short");
            if (view.getUint32(offset + protocol.F.QUERY_OBJECT_LOG.status, true) === SYNC_STATUS_PENDING)
                this.refuse("CPU query", "unexpected pending QUERY_OBJECT_LOG", {});
        }, { needsContext: false });

        /*
         * {kind, program, index, buf_size, status, length, size, type,
         * data_size, reserved} then the name -- ten words, so the name starts
         * at 40. length comes before size and type, which is the order
         * glGetActiveUniform's own out-parameters are in.
         */
        define("QUERY_ACTIVE", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.QUERY_ACTIVE.size) throw new GLStreamError("QUERY_ACTIVE record is short");
            if (view.getUint32(offset + protocol.F.QUERY_ACTIVE.status, true) === SYNC_STATUS_PENDING)
                this.refuse("CPU query", "unexpected pending QUERY_ACTIVE", {});
        }, { needsContext: false });

        define("CHECK_FRAMEBUFFER_STATUS", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.CHECK_FRAMEBUFFER_STATUS.size) throw new GLStreamError("CHECK_FRAMEBUFFER_STATUS record is short");
            if (view.getUint32(offset + protocol.F.CHECK_FRAMEBUFFER_STATUS.status, true) === SYNC_STATUS_PENDING)
                this.refuse("CPU query", "unexpected pending CHECK_FRAMEBUFFER_STATUS", {});
        }, { needsContext: false });

        /* ---- ARB assembly programs ---- */

        define("GEN_PROGRAMS_ARB", function(a, bytes, view, offset, size) {
            const names = readNameArray(view, offset, size);
            const group = this.current.shareGroup;
            for (const name of names)
                if (name && !group.arbPrograms.has(name))
                    group.arbPrograms.set(name, createARBProgram(name, 0));
        });
        define("DELETE_PROGRAMS_ARB", function(a, bytes, view, offset, size) {
            const names = readNameArray(view, offset, size);
            for (const name of names) {
                if (!name) continue;
                const object = this.current.shareGroup.arbPrograms.get(name);
                this.current.shareGroup.arbPrograms.delete(name);
                for (const [target, binding] of this.current.arbBindings) if (object && binding === object) {
                    this.current.arbBindings.delete(target);
                    if (target === GL.VERTEX_PROGRAM_ARB) this.current.arbVertexProgram = 0;
                    else this.current.arbFragmentProgram = 0;
                }
            }
        });
        define("BIND_PROGRAM_ARB", function(a) {
            const target = a[0] >>> 0, name = a[1] >>> 0;
            const group = this.current.shareGroup;
            if (name && !group.arbPrograms.has(name))
                group.arbPrograms.set(name, createARBProgram(name, target));
            this.current.arbBindings.set(target, name ? group.arbPrograms.get(name) : null);
            if (target === GL.VERTEX_PROGRAM_ARB) this.current.arbVertexProgram = name;
            else this.current.arbFragmentProgram = name;
        });
        define("PROGRAM_STRING_ARB", function(a, bytes, view, offset, size) {
            if (size < 16) throw new GLStreamError("ARB program record is short");
            const target = view.getUint32(offset + protocol.F.PROGRAM_STRING_ARB.target, true);
            const length = view.getInt32(offset + protocol.F.PROGRAM_STRING_ARB.length, true);
            if (length < 0 || 16 + length > size)
                throw new GLStreamError("ARB program record is truncated");
            const source = readCString(bytes, offset + 16, length);
            this.programStringARB(target, source);
        });
        define("PROGRAM_PARAMETER_FV_ARB", function(a, bytes, view, offset, size) {
            this.programParameterARB(view, offset, size, false);
        });
        define("PROGRAM_PARAMETER_DV_ARB", function(a, bytes, view, offset, size) {
            this.programParameterARB(view, offset, size, true);
        });
        define("QUERY_PROGRAM_IV_ARB", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.QUERY_PROGRAM_IV_ARB.size) throw new GLStreamError("QUERY_PROGRAM_IV_ARB record is short");
            if (view.getUint32(offset + protocol.F.QUERY_PROGRAM_IV_ARB.status, true) === SYNC_STATUS_PENDING)
                this.refuse("CPU query", "unexpected pending QUERY_PROGRAM_IV_ARB", {});
        }, { needsContext: false });
        define("QUERY_PROGRAM_PARAMETER_FV_ARB", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.QUERY_PROGRAM_PARAMETER_FV_ARB.size) throw new GLStreamError("QUERY_PROGRAM_PARAMETER_FV_ARB record is short");
            if (view.getUint32(offset + protocol.F.QUERY_PROGRAM_PARAMETER_FV_ARB.status, true) === SYNC_STATUS_PENDING)
                this.refuse("CPU query", "unexpected pending QUERY_PROGRAM_PARAMETER_FV_ARB", {});
        }, { needsContext: false });
        define("QUERY_PROGRAM_PARAMETER_DV_ARB", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.QUERY_PROGRAM_PARAMETER_DV_ARB.size) throw new GLStreamError("QUERY_PROGRAM_PARAMETER_DV_ARB record is short");
            if (view.getUint32(offset + protocol.F.QUERY_PROGRAM_PARAMETER_DV_ARB.status, true) === SYNC_STATUS_PENDING)
                this.refuse("CPU query", "unexpected pending QUERY_PROGRAM_PARAMETER_DV_ARB", {});
        }, { needsContext: false });
        /*
         * {target, pname, status, length, data_size, reserved} then the
         * program text at 24. glGetProgramStringARB has no buffer size of its
         * own -- the caller is expected to have asked GL_PROGRAM_LENGTH_ARB
         * first -- so data_size is what the guest allocated and the text is
         * written without a terminator, exactly as the extension specifies.
         */
        define("QUERY_PROGRAM_STRING_ARB", function(a, bytes, view, offset, size) {
            if (size < protocol.RECORDS.QUERY_PROGRAM_STRING_ARB.size) throw new GLStreamError("QUERY_PROGRAM_STRING_ARB record is short");
            if (view.getUint32(offset + protocol.F.QUERY_PROGRAM_STRING_ARB.status, true) === SYNC_STATUS_PENDING)
                this.refuse("CPU query", "unexpected pending QUERY_PROGRAM_STRING_ARB", {});
        }, { needsContext: false });
    }

    /* ================================================================== */
    /* Draw records                                                       */
    /* ================================================================== */

    /*
     * A client-array block is {enabled, size, type, stride, dataSize} followed
     * by dataSize bytes; a draw record carries thirteen of them in a fixed
     * order -- vertex, colour, normal, eight texture coordinates, secondary
     * colour, fog coordinate -- because the guest packs every enabled array
     * into the same record rather than tracking pointers across calls.
     */
    const ARRAY_BLOCK_NAMES = ["vertex", "color", "normal",
        "texCoord0", "texCoord1", "texCoord2", "texCoord3",
        "texCoord4", "texCoord5", "texCoord6", "texCoord7",
        "secondaryColor", "fogCoord"];


    function installDrawHandlers(table) {
        const define = definer(table);

        const decodePackedDraw = (indexed, gl2) => function(a, bytes, view, offset, size) {
            const end = offset + size;
            const baseName = indexed ? "DRAW_ELEMENTS" : "DRAW_ARRAYS", base = protocol.RECORDS[baseName], R = protocol.F[baseName];
            if (size < base.size) throw new GLStreamError("packed draw header is short");
            const mode = view.getUint32(offset + R.mode, true);
            const count = view.getInt32(offset + R.count, true);
            const indexType = indexed ? view.getUint32(offset + R.type, true) : 0;
            const indexDataSize = indexed ? view.getUint32(offset + R.index_data_size, true) : 0;
            let blocksAt;
            let texUnitCount = 0;
            let hasSecondary = false;
            let hasFog = false;
            let genericCount = 0;
            let arrayCount;
            /*
             * Where the index data starts depends on the layout, which is why
             * it cannot be sliced while reading the fixed header. In the
             * multitexture layout the guest writes its own header -- magic,
             * the encoded array set, the client-active unit, and for the GL2
             * opcodes a generic-attribute count -- *between* the fixed header
             * and the indices. Slicing at the end of the fixed header instead
             * read the magic word as the first two indices: every
             * glDrawElements drew the wrong triangles, and did it quietly,
             * because the block offset below was computed correctly and
             * nothing downstream range-checks an index.
             */
            const magicAt = offset + base.size;
            const magic = magicAt + 4 <= end ? view.getUint32(magicAt, true) : 0;
            let indexAt;
            if (magic === CLIENT_ARRAY_MT_MAGIC) {
                const mtName = "PACKED_" + baseName + (gl2 ? "_GL2_MT" : "_MT"), mt = protocol.RECORDS[mtName], M = protocol.F[mtName];
                if (size < mt.size) throw new GLStreamError("packed multitexture header is short");
                const encoded = view.getUint32(offset + M.tex_unit_count, true);
                hasSecondary = (encoded & CLIENT_ARRAY_MT_SECONDARY_COLOR_BIT) !== 0;
                hasFog = (encoded & CLIENT_ARRAY_MT_FOG_COORD_BIT) !== 0;
                texUnitCount = encoded &
                    ~(CLIENT_ARRAY_MT_SECONDARY_COLOR_BIT | CLIENT_ARRAY_MT_FOG_COORD_BIT);
                if (texUnitCount > MAX_TEXTURE_COORDS)
                    throw new GLStreamError("too many texture-coordinate arrays");
                const headerEnd = offset + mt.size;
                if (gl2) genericCount = view.getUint32(offset + M.generic_attrib_count, true);
                indexAt = headerEnd;
                arrayCount = 3 + texUnitCount + (hasSecondary ? 1 : 0) +
                    (hasFog ? 1 : 0);
            } else {
                // The pre-multitexture layout: four blocks in vertex, colour,
                // texcoord, normal order, with the indices straight after the
                // fixed header. No shipping guest emits it any more, but the
                // state journal may still hold one.
                indexAt = offset + 16;
                arrayCount = 4;
            }

            let indexData = null;
            if (indexed) {
                if (indexAt + indexDataSize > end)
                    throw new GLStreamError("index data is truncated");
                indexData = indexDataSize ?
                    bytes.subarray(indexAt, indexAt + indexDataSize) : null;
            }
            blocksAt = indexed ? indexAt + indexDataSize :
                (magic === CLIENT_ARRAY_MT_MAGIC ? indexAt : offset + 8);

            const parsed = parseArrayBlocks(bytes, view, blocksAt, end, arrayCount);
            if (!parsed) throw new GLStreamError("client array blocks are truncated");
            let generic = null;
            if (genericCount) {
                generic = parseGenericBlocks(bytes, view, parsed.offset, end,
                    genericCount);
                if (!generic) throw new GLStreamError("generic attribute blocks are truncated");
            }

            const arrays = Object.create(null);
            if (magic === CLIENT_ARRAY_MT_MAGIC) {
                const order = ["vertex", "color", "normal"];
                for (let i = 0; i < texUnitCount; ++i) order.push("texCoord" + i);
                if (hasSecondary) order.push("secondaryColor");
                if (hasFog) order.push("fogCoord");
                order.forEach((name, i) => {
                    if (parsed.blocks[i] && parsed.blocks[i].enabled)
                        arrays[name] = parsed.blocks[i];
                });
            } else {
                ["vertex", "color", "texCoord0", "normal"].forEach((name, i) => {
                    if (parsed.blocks[i] && parsed.blocks[i].enabled)
                        arrays[name] = parsed.blocks[i];
                });
            }
            if (generic) {
                for (const block of generic.blocks)
                    if (block.enabled) arrays["generic" + block.index] = block;
            }

            this.drawPacked(mode, count, arrays, indexed ? {
                type: indexType, data: indexData,
            } : null);
        };

        define("DRAW_ARRAYS", decodePackedDraw(false, false));
        define("DRAW_ARRAYS_GL2", decodePackedDraw(false, true));
        define("DRAW_ELEMENTS", decodePackedDraw(true, false));
        define("DRAW_ELEMENTS_GL2", decodePackedDraw(true, true));

        /* The VBO-direct path: every enabled array lives in a buffer object,
         * so nothing but the parameters travels. This is the path M2's VBO
         * promotion makes the common one. */
        define("DRAW_ARRAYS_DIRECT", function(a) {
            this.drawFromBuffers(a[0] >>> 0, a[1] | 0, a[2] | 0, null);
        });
        define("DRAW_ELEMENTS_DIRECT", function(a, bytes, view, offset, size) {
            if (size < 24) throw new GLStreamError("direct draw record is short");
            this.drawFromBuffers(view.getUint32(offset + protocol.F.DRAW_ELEMENTS_DIRECT.mode, true), 0,
                view.getInt32(offset + protocol.F.DRAW_ELEMENTS_DIRECT.count, true), {
                    type: view.getUint32(offset + protocol.F.DRAW_ELEMENTS_DIRECT.type, true),
                    bufferOffset: view.getUint32(offset + protocol.F.DRAW_ELEMENTS_DIRECT.offset, true),
                });
        });
        define("DRAW_RANGE_ELEMENTS_DIRECT", function(a, bytes, view, offset, size) {
            const R = protocol.F.DRAW_RANGE_ELEMENTS_DIRECT;
            if (size < protocol.RECORDS.DRAW_RANGE_ELEMENTS_DIRECT.size) throw new GLStreamError("direct draw record is short");
            this.drawFromBuffers(view.getUint32(offset + R.mode, true), 0,
                view.getInt32(offset + R.count, true), {
                    type: view.getUint32(offset + R.type, true),
                    bufferOffset: view.getUint32(offset + R.offset, true),
                });
        });
        define("MULTI_DRAW_ARRAYS_DIRECT", function(a, bytes, view, offset, size) {
            const R = protocol.F.MULTI_DRAW_ARRAYS_DIRECT, header = protocol.RECORDS.MULTI_DRAW_ARRAYS_DIRECT.size;
            const E = protocol.F.MULTI_DRAW_ARRAYS_ENTRY, entrySize = protocol.RECORDS.MULTI_DRAW_ARRAYS_ENTRY.size;
            if (size < header) throw new GLStreamError("multi-draw record is short");
            const mode = view.getUint32(offset + R.mode, true);
            const primcount = view.getInt32(offset + R.primcount, true);
            if (primcount < 0 || header + primcount * entrySize > size) throw new GLStreamError("multi-draw entries are truncated");
            for (let i = 0; i < primcount; ++i) {
                const at = offset + header + i * entrySize;
                this.drawFromBuffers(mode, view.getInt32(at + E.first, true),
                    view.getInt32(at + E.count, true), null);
            }
        });
        define("MULTI_DRAW_ELEMENTS_DIRECT", function(a, bytes, view, offset, size) {
            const R = protocol.F.MULTI_DRAW_ELEMENTS_DIRECT, header = protocol.RECORDS.MULTI_DRAW_ELEMENTS_DIRECT.size;
            const E = protocol.F.MULTI_DRAW_ELEMENTS_ENTRY, entrySize = protocol.RECORDS.MULTI_DRAW_ELEMENTS_ENTRY.size;
            if (size < header) throw new GLStreamError("multi-draw record is short");
            const mode = view.getUint32(offset + R.mode, true);
            const type = view.getUint32(offset + R.type, true);
            const primcount = view.getInt32(offset + R.primcount, true);
            if (primcount < 0 || header + primcount * entrySize > size) throw new GLStreamError("multi-draw entries are truncated");
            for (let i = 0; i < primcount; ++i) {
                const at = offset + header + i * entrySize;
                this.drawFromBuffers(mode, 0, view.getInt32(at + E.count, true), {
                    type, bufferOffset: view.getUint32(at + E.offset, true),
                });
            }
        });

        /* ---- pixel rectangles ---- */

        define("READ_PIXELS", function(a, bytes, view, offset, size, metadata) {
            try {
                this.readPixels(bytes, view, offset, size, metadata);
            } catch (error) {
                if (size >= READ_PIXELS_HEADER_SIZE) {
                    const status = new Uint8Array(4);
                    new DataView(status.buffer).setUint32(0, SYNC_STATUS_FAILED, true);
                    this.answerGuest(bytes, metadata, [[offset + protocol.F.READ_PIXELS.status, status]]);
                }
                throw error;
            }
        });
        define("DRAW_PIXELS", function(a, bytes, view, offset, size) {
            this.drawPixels(bytes, view, offset, size);
        });
        define("BITMAP", function(a, bytes, view, offset, size) {
            this.drawBitmap(bytes, view, offset, size);
        });
        define("COPY_PIXELS", function(a) {
            this.copyPixels(a[0] | 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] >>> 0);
        });
        define("POLYGON_STIPPLE", function(a, bytes, view, offset, size) {
            const header = protocol.RECORDS.POLYGON_STIPPLE.size;
            if (size < header) throw new GLStreamError("polygon stipple is short");
            this.current.polygonStipple.set(
                bytes.subarray(offset, offset + header));
            this.polygonStippleTexture = null;
        });
        for (const name of ["QUERY_POLYGON_STIPPLE", "POLYGON_STIPPLE_BITMAP"]) define(name, function(a, bytes, view, offset, size) {
            const header = protocol.RECORDS[name].size, fields = protocol.F[name];
            if (size < header) throw new GLStreamError(name + " record is short");
            if (view.getUint32(offset + fields.status, true) !== SYNC_STATUS_OK) return;
            if (name === "QUERY_POLYGON_STIPPLE" &&
                (view.getUint32(offset + fields.mode, true) !== 1 || !view.getUint32(offset + fields.pbo, true))) return;
            if (size < header + 128) throw new GLStreamError(name + " bitmap is short");
            if (!this.current) return;
            this.current.polygonStipple.set(bytes.subarray(offset + header, offset + header + 128));
            this.polygonStippleTexture = null;
        }, { needsContext: false });
        const pixelMap = name => function(a, bytes, view, offset, size) {
            // Pixel maps only affect glDrawPixels/glReadPixels colour transfer,
            // which the executor applies on the CPU; the table is stored so the
            // path stays exact when GL_MAP_COLOR is on.
            if (size < 8) throw new GLStreamError("pixel map record is short");
            const map = view.getUint32(offset, true);
            const count = view.getUint32(offset + 4, true);
            if (count < 1 || count > glCaps.LIMITS.MAX_PIXEL_MAP_TABLE || 8 + count * (name === "PIXEL_MAPUSV" ? 2 : 4) > size)
                throw new GLStreamError("pixel map record is invalid");
            const result = pixelMaps.decode(name, view, offset);
            this.current.pixelMaps[map] = Float64Array.from(result.values);
        };
        define("PIXEL_MAPFV", pixelMap("PIXEL_MAPFV"));
        define("PIXEL_MAPUIV", pixelMap("PIXEL_MAPUIV"));
        define("PIXEL_MAPUSV", pixelMap("PIXEL_MAPUSV"));
        define("ACCUM", function(a) { this.accum(a[0] >>> 0, a[1]); });

        define("QUERY_OBJECT_BATCH", function(a, bytes, view, offset, size, metadata) {
            this.queryObjectBatch(bytes, view, offset, size, metadata);
        });
    }

    /* ================================================================== */
    /* Executor: state                                                    */
    /* ================================================================== */

    Object.assign(GLWebGPUExecutor.prototype, {

        topOf(mode) {
            const stack = this.stackFor(mode);
            return stack[stack.length - 1];
        },

        topMatrix() { return this.topOf(this.current.matrixMode); },

        stackFor(mode) {
            const s = this.current;
            if (mode === GL.TEXTURE) return s.textureStacks[s.activeTexture];
            // Checkpoints predating program matrices have no such stacks.
            if (mode >= GL.MATRIX0_ARB && mode < GL.MATRIX0_ARB + glCaps.LIMITS.MAX_PROGRAM_MATRICES && !s.stacks[mode]) s.stacks[mode] = [identity4()];
            return s.stacks[mode] || s.stacks[GL.MODELVIEW];
        },

        pushMatrix() {
            const stack = this.stackFor(this.current.matrixMode);
            const depth = this.current.matrixMode === GL.MODELVIEW ?
                MODELVIEW_STACK_DEPTH : this.current.matrixMode >= GL.MATRIX0_ARB ? glCaps.LIMITS.PROGRAM_MATRIX_STACK_DEPTH : OTHER_STACK_DEPTH;
            if (stack.length >= depth)
                return this.refuse("glPushMatrix", "matrix stack overflow",
                    { mode: this.current.matrixMode }, GL.STACK_OVERFLOW);
            stack.push(new Float32Array(stack[stack.length - 1]));
        },

        popMatrix() {
            const stack = this.stackFor(this.current.matrixMode);
            if (stack.length <= 1)
                return this.refuse("glPopMatrix", "matrix stack underflow",
                    { mode: this.current.matrixMode }, GL.STACK_UNDERFLOW);
            stack.pop();
            this.matrixChanged();
        },

        multiplyTop(m) {
            const top = this.topMatrix();
            multiply4(top, m, SCRATCH_B);
            top.set(SCRATCH_B);
            this.matrixChanged();
        },

        /* The eye-space copies of every light are captured when glLight* is
         * called, per the GL spec, so a later modelview change must not move
         * them -- but a modelview change *does* change eye-space geometry, so
         * the derived state is rebuilt lazily rather than here. */
        matrixChanged() {
            this.derivedDirty = true;
        },

        setCapability(cap, value) {
            const s = this.current;
            const unit = s.textureUnits[s.activeTexture];
            switch (cap) {
            case GL.TEXTURE_1D: case GL.TEXTURE_2D:
            case GL.TEXTURE_3D: case GL.TEXTURE_CUBE_MAP:
                if (value) unit.enabledTargets.add(cap);
                else unit.enabledTargets.delete(cap);
                return;
            case GL.TEXTURE_GEN_S: case GL.TEXTURE_GEN_T:
            case GL.TEXTURE_GEN_R: case GL.TEXTURE_GEN_Q:
                unit.texGen[cap - GL.TEXTURE_GEN_S].enabled = value;
                return;
            case GL.POINT_SPRITE:
                // the enable is global; COORD_REPLACE is the unit's (glTexEnv)
                if (value) s.enabled.add(cap); else s.enabled.delete(cap);
                return;
            default: break;
            }
            if (cap >= GL.LIGHT0 && cap < GL.LIGHT0 + MAX_LIGHTS) {
                s.lights[cap - GL.LIGHT0].enabled = value;
                return;
            }
            if (cap >= GL.CLIP_PLANE0 && cap < GL.CLIP_PLANE0 + MAX_CLIP_PLANES) {
                if (value) s.enabled.add(cap); else s.enabled.delete(cap);
                return;
            }
            if (cap === GL.COLOR_MATERIAL) {
                s.colorMaterial.enabled = value;
                this.latchColorMaterial();
            }
            if (value) s.enabled.add(cap); else s.enabled.delete(cap);
        },

        isEnabled(cap) { return this.current.enabled.has(cap); },

        setLightModel(pname, values, count) {
            const model = this.current.lightModel;
            switch (pname) {
            case GL.LIGHT_MODEL_AMBIENT:
                model.ambient.set(values.slice(0, 4));
                return;
            case GL.LIGHT_MODEL_TWO_SIDE: model.twoSide = values[0] !== 0; return;
            case GL.LIGHT_MODEL_LOCAL_VIEWER: model.localViewer = values[0] !== 0; return;
            case GL.LIGHT_MODEL_COLOR_CONTROL: model.colorControl = values[0] >>> 0; return;
            default:
                this.refuse("glLightModel", "unknown parameter",
                    { pname, count }, GL.INVALID_ENUM);
            }
        },

        setLight(lightEnum, pname, values) {
            const index = lightEnum - GL.LIGHT0;
            if (index < 0 || index >= MAX_LIGHTS)
                return this.refuse("glLight", "light index out of range",
                    { index }, GL.INVALID_ENUM);
            const light = this.current.lights[index];
            switch (pname) {
            case GL.AMBIENT: light.ambient.set(values.slice(0, 4)); return;
            case GL.DIFFUSE: light.diffuse.set(values.slice(0, 4)); return;
            case GL.SPECULAR: light.specular.set(values.slice(0, 4)); return;
            case GL.POSITION: {
                light.position.set(values.slice(0, 4));
                // GL transforms the position by the modelview in force *now*.
                transformPoint4(this.topOf(GL.MODELVIEW), light.position,
                    light.eyePosition);
                this.derivedDirty = true;
                return;
            }
            case GL.SPOT_DIRECTION: {
                light.spotDirection.set(values.slice(0, 3));
                const dir = new Float32Array([values[0], values[1], values[2], 0]);
                const eye = transformPoint4(this.topOf(GL.MODELVIEW), dir,
                    new Float32Array(4));
                light.eyeSpotDirection.set([eye[0], eye[1], eye[2]]);
                this.derivedDirty = true;
                return;
            }
            case GL.SPOT_EXPONENT: light.spotExponent = clamp(values[0], 0, 128); return;
            case GL.SPOT_CUTOFF: light.spotCutoff = values[0]; return;
            case GL.CONSTANT_ATTENUATION: light.constantAttenuation = values[0]; return;
            case GL.LINEAR_ATTENUATION: light.linearAttenuation = values[0]; return;
            case GL.QUADRATIC_ATTENUATION: light.quadraticAttenuation = values[0]; return;
            default:
                this.refuse("glLight", "unknown parameter", { pname },
                    GL.INVALID_ENUM);
            }
        },

        /*
         * GL 2.1 section 2.14.3: while COLOR_MATERIAL is enabled the
         * parameters it names are the current colour -- set when it is
         * enabled, when glColorMaterial changes them and on every glColor --
         * and they keep the last one when it is disabled (review S2-13: the
         * material never changed, so the colour was lost on disable).
         */
        latchColorMaterial() {
            const s = this.current;
            if (!s.colorMaterial.enabled) return;
            const mode = s.colorMaterial.mode;
            if (mode !== GL.AMBIENT_AND_DIFFUSE && !COLOR_MATERIAL_MODES[mode]) return;
            const face = s.colorMaterial.face;
            const color = s.current.color;
            for (const material of [face !== GL.BACK && s.material.front, face !== GL.FRONT && s.material.back]) {
                if (!material) continue;
                if (mode === GL.AMBIENT_AND_DIFFUSE) {
                    material.ambient.set(color);
                    material.diffuse.set(color);
                } else {
                    material[COLOR_MATERIAL_MODES[mode].toLowerCase()].set(color);
                }
            }
            this.derivedDirty = true;
        },

        setMaterial(face, pname, values) {
            const targets = [];
            if (face === GL.FRONT || face === GL.FRONT_AND_BACK)
                targets.push(this.current.material.front);
            if (face === GL.BACK || face === GL.FRONT_AND_BACK)
                targets.push(this.current.material.back);
            if (!targets.length)
                return this.refuse("glMaterial", "invalid face", { face },
                    GL.INVALID_ENUM);
            for (const material of targets) {
                switch (pname) {
                case GL.AMBIENT: material.ambient.set(values.slice(0, 4)); break;
                case GL.DIFFUSE: material.diffuse.set(values.slice(0, 4)); break;
                case GL.SPECULAR: material.specular.set(values.slice(0, 4)); break;
                case GL.EMISSION: material.emission.set(values.slice(0, 4)); break;
                case GL.SHININESS: material.shininess = clamp(values[0], 0, 128); break;
                // Color-index materials have no effect on this RGBA renderer;
                // their queryable values are retained by the CPU shadow.
                case GL.COLOR_INDEXES: break;
                case GL.AMBIENT_AND_DIFFUSE:
                    material.ambient.set(values.slice(0, 4));
                    material.diffuse.set(values.slice(0, 4));
                    break;
                default:
                    this.refuse("glMaterial", "unknown parameter", { pname },
                        GL.INVALID_ENUM);
                    return;
                }
            }
            this.derivedDirty = true;
        },

        setFog(pname, values) {
            const fog = this.current.fog;
            switch (pname) {
            case GL.FOG_MODE: fog.mode = values[0] >>> 0; return;
            case GL.FOG_DENSITY: fog.density = values[0]; return;
            case GL.FOG_START: fog.start = values[0]; return;
            case GL.FOG_END: fog.end = values[0]; return;
            case GL.FOG_COLOR: fog.color.set(values.slice(0, 4).map(v => clamp(v, 0, 1))); return;
            case GL.FOG_COORD_SRC: fog.coordSource = values[0] >>> 0; return;
            case GL.FOG_INDEX: return;
            default:
                this.refuse("glFog", "unknown parameter", { pname },
                    GL.INVALID_ENUM);
            }
        },

        setTexEnv(target, pname, values) {
            const s = this.current;
            const unit = s.textureUnits[s.activeTexture];
            if (target === GL.POINT_SPRITE) {
                if (pname === GL.COORD_REPLACE) unit.env.pointSprite = values[0] !== 0;
                return;
            }
            if (target === GL.TEXTURE_FILTER_CONTROL) {
                if (pname === GL.TEXTURE_LOD_BIAS) unit.lodBias = values[0];
                return;
            }
            const env = unit.env;
            switch (pname) {
            case GL.TEXTURE_ENV_MODE: env.mode = values[0] >>> 0; return;
            case GL.TEXTURE_ENV_COLOR: env.color.set(values.slice(0, 4).map(v => clamp(v, 0, 1))); return;
            case GL.COMBINE_RGB: env.combineRGB = values[0] >>> 0; return;
            case GL.COMBINE_ALPHA: env.combineAlpha = values[0] >>> 0; return;
            case GL.SRC0_RGB: env.srcRGB[0] = values[0] >>> 0; return;
            case GL.SRC1_RGB: env.srcRGB[1] = values[0] >>> 0; return;
            case GL.SRC2_RGB: env.srcRGB[2] = values[0] >>> 0; return;
            case GL.SRC0_ALPHA: env.srcAlpha[0] = values[0] >>> 0; return;
            case GL.SRC1_ALPHA: env.srcAlpha[1] = values[0] >>> 0; return;
            case GL.SRC2_ALPHA: env.srcAlpha[2] = values[0] >>> 0; return;
            case GL.OPERAND0_RGB: env.operandRGB[0] = values[0] >>> 0; return;
            case GL.OPERAND1_RGB: env.operandRGB[1] = values[0] >>> 0; return;
            case GL.OPERAND2_RGB: env.operandRGB[2] = values[0] >>> 0; return;
            case GL.OPERAND0_ALPHA: env.operandAlpha[0] = values[0] >>> 0; return;
            case GL.OPERAND1_ALPHA: env.operandAlpha[1] = values[0] >>> 0; return;
            case GL.OPERAND2_ALPHA: env.operandAlpha[2] = values[0] >>> 0; return;
            case GL.RGB_SCALE: env.rgbScale = clamp(Math.round(values[0]), 1, 4); return;
            case GL.ALPHA_SCALE: env.alphaScale = clamp(Math.round(values[0]), 1, 4); return;
            default:
                this.refuse("glTexEnv", "unknown parameter", { pname },
                    GL.INVALID_ENUM);
            }
        },

        setTexGen(coord, pname, values) {
            const s = this.current;
            const unit = s.textureUnits[s.activeTexture];
            const index = coord - GL.S;
            if (index < 0 || index > 3)
                return this.refuse("glTexGen", "invalid coordinate", { coord },
                    GL.INVALID_ENUM);
            const gen = unit.texGen[index];
            switch (pname) {
            case GL.TEXTURE_GEN_MODE: gen.mode = values[0] >>> 0; return;
            case GL.OBJECT_PLANE: gen.objectPlane.set(values.slice(0, 4)); return;
            case GL.EYE_PLANE: {
                // Like glClipPlane, the eye plane is stored transformed by the
                // inverse modelview so the shader can dot it with the eye-space
                // position directly.
                const inv = invert4(this.topOf(GL.MODELVIEW), SCRATCH_B);
                const t = transpose4(inv, SCRATCH_C);
                transformPoint4(t, new Float32Array(values.slice(0, 4)),
                    gen.eyePlane);
                return;
            }
            default:
                this.refuse("glTexGen", "unknown parameter", { pname },
                    GL.INVALID_ENUM);
            }
        },

        captureTextureParameters() {
            const images = new Set();
            for (let unit = 0; unit < this.current.textureUnits.length; ++unit)
                for (const target of textureParameters.targets) images.add(this.textureObjectFor(unit, target));
            return [...images].filter(Boolean).map(image => ({ id: image.imageId, sampler: cloneStateValue(image.sampler),
                priority: image.priority, generateMipmapHint: image.generateMipmapHint }));
        },

        setTexParameter(target, pname, values, integer, scalar) {
            if (!textureParameters.targets.includes(target)) return this.invalidState(GL.INVALID_ENUM);
            const result = textureParameters.normalize(pname, values, integer, scalar);
            if (result.error) return this.invalidState(result.error);
            values = result.values;
            const texture = this.boundTexture(target);
            if (!texture)
                return this.refuse("glTexParameter", "no texture bound",
                    { target }, GL.INVALID_OPERATION);
            const sampler = texture.sampler;
            switch (pname) {
            case GL.TEXTURE_MIN_FILTER: sampler.minFilter = values[0] >>> 0; break;
            case GL.TEXTURE_MAG_FILTER: sampler.magFilter = values[0] >>> 0; break;
            case GL.TEXTURE_WRAP_S: sampler.wrapS = values[0] >>> 0; break;
            case GL.TEXTURE_WRAP_T: sampler.wrapT = values[0] >>> 0; break;
            case GL.TEXTURE_WRAP_R: sampler.wrapR = values[0] >>> 0; break;
            case GL.TEXTURE_MIN_LOD: sampler.minLod = values[0]; break;
            case GL.TEXTURE_MAX_LOD: sampler.maxLod = values[0]; break;
            case GL.TEXTURE_BASE_LEVEL: sampler.baseLevel = values[0] | 0; break;
            case GL.TEXTURE_MAX_LEVEL: sampler.maxLevel = values[0] | 0; break;
            case GL.TEXTURE_LOD_BIAS: sampler.lodBias = values[0]; break;
            case GL.TEXTURE_BORDER_COLOR:
                sampler.borderColor.set(values.slice(0, 4));
                break;
            case GL.TEXTURE_MAX_ANISOTROPY_EXT:
                sampler.maxAnisotropy = values[0];
                break;
            case GL.TEXTURE_COMPARE_MODE: sampler.compareMode = values[0] >>> 0; break;
            case GL.TEXTURE_COMPARE_FUNC: sampler.compareFunc = values[0] >>> 0; break;
            case GL.DEPTH_TEXTURE_MODE: sampler.depthTextureMode = values[0] >>> 0; break;
            case GL.GENERATE_MIPMAP: texture.generateMipmapHint = values[0] !== 0; break;
            case GL.TEXTURE_PRIORITY: texture.priority = values[0]; break;
            default:
                return this.refuse("glTexParameter", "unknown parameter",
                    { pname }, GL.INVALID_ENUM);
            }
            texture.viewCache.clear();
            this.invalidateBindGroups();
        },

        setPixelStore(pname, value) {
            const store = this.current.pixelStore;
            switch (pname) {
            case GL.UNPACK_ALIGNMENT: store.unpackAlignment = value; return;
            case GL.UNPACK_ROW_LENGTH: store.unpackRowLength = value; return;
            case GL.UNPACK_SKIP_PIXELS: store.unpackSkipPixels = value; return;
            case GL.UNPACK_SKIP_ROWS: store.unpackSkipRows = value; return;
            case GL.UNPACK_SKIP_IMAGES: store.unpackSkipImages = value; return;
            case GL.UNPACK_IMAGE_HEIGHT: store.unpackImageHeight = value; return;
            case GL.UNPACK_SWAP_BYTES: store.unpackSwapBytes = value !== 0; return;
            case GL.UNPACK_LSB_FIRST: store.unpackLsbFirst = value !== 0; return;
            case GL.PACK_ALIGNMENT: store.packAlignment = value; return;
            case GL.PACK_ROW_LENGTH: store.packRowLength = value; return;
            case GL.PACK_IMAGE_HEIGHT: store.packImageHeight = value; return;
            case GL.PACK_SKIP_IMAGES: store.packSkipImages = value; return;
            case GL.PACK_SKIP_PIXELS: store.packSkipPixels = value; return;
            case GL.PACK_SKIP_ROWS: store.packSkipRows = value; return;
            case GL.PACK_SWAP_BYTES: store.packSwapBytes = value !== 0; return;
            case GL.PACK_LSB_FIRST: store.packLsbFirst = value !== 0; return;
            default:
                this.refuse("glPixelStorei", "unknown parameter", { pname },
                    GL.INVALID_ENUM);
            }
        },

        setPixelTransfer(pname, value) {
            const t = this.current.pixelTransfer;
            switch (pname) {
            case GL.RED_SCALE: t.redScale = value; return;
            case GL.GREEN_SCALE: t.greenScale = value; return;
            case GL.BLUE_SCALE: t.blueScale = value; return;
            case GL.ALPHA_SCALE: t.alphaScale = value; return;
            case GL.RED_BIAS: t.redBias = value; return;
            case GL.GREEN_BIAS: t.greenBias = value; return;
            case GL.BLUE_BIAS: t.blueBias = value; return;
            case GL.ALPHA_BIAS: t.alphaBias = value; return;
            case GL.MAP_COLOR: t.mapColor = value !== 0; return;
            case GL.POST_COLOR_MATRIX_RED_SCALE_SGI:
            case GL.POST_COLOR_MATRIX_GREEN_SCALE_SGI:
            case GL.POST_COLOR_MATRIX_BLUE_SCALE_SGI:
            case GL.POST_COLOR_MATRIX_ALPHA_SCALE_SGI:
                t.postColorMatrixScale[pname -
                    GL.POST_COLOR_MATRIX_RED_SCALE_SGI] = value;
                return;
            case GL.POST_COLOR_MATRIX_RED_BIAS_SGI:
            case GL.POST_COLOR_MATRIX_GREEN_BIAS_SGI:
            case GL.POST_COLOR_MATRIX_BLUE_BIAS_SGI:
            case GL.POST_COLOR_MATRIX_ALPHA_BIAS_SGI:
                t.postColorMatrixBias[pname -
                    GL.POST_COLOR_MATRIX_RED_BIAS_SGI] = value;
                break;
            default:     // depth/stencil scales have no effect here
            }
        },

        setPointParameter(pname, values) {
            const point = this.current.point;
            switch (pname) {
            case GL.POINT_SIZE_MIN: point.sizeMin = values[0]; return;
            case GL.POINT_SIZE_MAX: point.sizeMax = values[0]; return;
            case GL.POINT_FADE_THRESHOLD_SIZE: point.fadeThreshold = values[0]; return;
            case GL.POINT_DISTANCE_ATTENUATION:
                point.attenuation.set([values[0], values[1] || 0, values[2] || 0]);
                return;
            case GL.POINT_SPRITE_COORD_ORIGIN:
                point.spriteCoordOrigin = values[0] >>> 0;
                return;
            default:
                this.refuse("glPointParameter", "unknown parameter", { pname },
                    GL.INVALID_ENUM);
            }
        },

        setClientState(cap, value) {
            const s = this.current;
            const name = {
                [GL.VERTEX_ARRAY]: "vertex",
                [GL.COLOR_ARRAY]: "color",
                [GL.NORMAL_ARRAY]: "normal",
                [GL.SECONDARY_COLOR_ARRAY]: "secondaryColor",
                [GL.FOG_COORD_ARRAY]: "fogCoord",
                [GL.EDGE_FLAG_ARRAY]: "edgeFlag",
                [GL.INDEX_ARRAY]: "index",
            }[cap];
            if (name) {
                this.arrayState(name).enabled = value;
                return;
            }
            if (cap === GL.TEXTURE_COORD_ARRAY) {
                this.arrayState("texCoord" + s.clientActiveTexture).enabled = value;
                return;
            }
            this.refuse("glEnableClientState", "unknown array", { cap },
                GL.INVALID_ENUM);
        },

        arrayState(name) {
            const s = this.current;
            s.arrays = s.arrays || Object.create(null);
            if (!s.arrays[name])
                s.arrays[name] = { enabled: false, buffer: 0, size: 4,
                                   type: GL.FLOAT, stride: 0, offset: 0,
                                   normalized: false, fromVBO: false };
            return s.arrays[name];
        },

        setArrayPointer(name, array) {
            Object.assign(this.arrayState(name), array);
        },

        boundTexture(target) {
            const s = this.current;
            const unit = s.textureUnits[s.activeTexture];
            let key = target;
            // A cube face parameter names the cube map itself.
            if (target >= GL.TEXTURE_CUBE_MAP_POSITIVE_X &&
                    target <= GL.TEXTURE_CUBE_MAP_NEGATIVE_Z)
                key = GL.TEXTURE_CUBE_MAP;
            return this.textureObjectFor(s.activeTexture, key);
        },

        namedImage(kind, name) {
            const group = this.current.shareGroup, textures = kind === "texture";
            const names = textures ? group.textures : group.renderbuffers;
            const pool = textures ? group.textureImages : group.renderbufferImages;
            let image = names.get(name);
            if (!image) {
                image = textures ? createTexture(name) : createRenderbuffer(name);
                image.imageId = group.nextImageId++; pool.set(image.imageId, image); names.set(name, image);
            }
            return image;
        },

        defaultTexture(target) {
            const c = this.current, group = c.shareGroup;
            if (!c.defaultTextures) c.defaultTextures = Object.create(null);
            let id = c.defaultTextures[target];
            if (!id) {
                const texture = createTexture(0); texture.target = target;
                texture.imageId = group.nextImageId++; id = texture.imageId;
                group.textureImages.set(id, texture); c.defaultTextures[target] = id;
            }
            return group.textureImages.get(id);
        },

        imageFor(record) {
            const g = this.current.shareGroup, texture = record.kind === "texture";
            return record.imageId !== undefined ? (texture ? g.textureImages : g.renderbufferImages).get(record.imageId) :
                (texture ? g.textures : g.renderbuffers).get(record.name);
        },

        detachImage(kind, imageId) {
            this.endPass();
            for (const fbo of new Set([this.boundFramebufferObject(GL.DRAW_FRAMEBUFFER), this.boundFramebufferObject(GL.READ_FRAMEBUFFER)])) {
                if (!fbo) continue;
                const stale = r => r && r.kind === kind && r.imageId === imageId;
                fbo.color = fbo.color.map(r => stale(r) ? null : r);
                if (stale(fbo.depth)) fbo.depth = null;
                if (stale(fbo.stencil)) fbo.stencil = null;
            }
        },

        collectImages() {
            for (const group of this.shareGroups.values()) {
                const live = new Set();
                const units = list => { for (const unit of list) for (const id of Object.values(unit.imageBindings || {})) live.add(id); };
                for (const c of this.contexts.values()) if (c.shareGroup === group) {
                    units(c.textureUnits); for (const id of Object.values(c.defaultTextures || {})) live.add(id);
                    live.add(c.renderbufferImage);
                    if (c.textureRead) live.add(c.textureRead.imageId);
                    for (const fbo of this.framebuffers.get(c.id)?.values() || [])
                        for (const r of [...fbo.color, fbo.depth, fbo.stencil]) if (r) live.add(r.imageId);
                    for (const fbo of [c.drawFramebufferObject, c.readFramebufferObject]) if (fbo)
                        for (const r of [...fbo.color, fbo.depth, fbo.stencil]) if (r) live.add(r.imageId);
                    for (const a of c.attribStack) if (a.state.textureUnits) units(a.state.textureUnits);
                }
                for (const fbo of group.sharedFramebuffers.values()) for (const r of [...fbo.color, fbo.depth, fbo.stencil]) if (r) live.add(r.imageId);
                for (const pool of [group.textureImages, group.renderbufferImages])
                    for (const [id, image] of pool) if ((image.deleted || !image.name) && !live.has(id)) {
                        this.retire(image.gpuTexture);
                        if (image.depthColor) this.retire(image.depthColor.texture);
                        pool.delete(id);
                    }
            }
        },

        invalidateBindGroups() {
            this.bindGroupsDirty = true;
        },

        retire(object) {
            if (object && typeof object.destroy === "function") {
                // Destroying inside a recorded frame would invalidate commands
                // already encoded, so the object is released after the frame
                // that may still reference it.
                this.retired = this.retired || [];
                this.retired.push(object);
            }
        },

        releaseRetired() {
            if (!this.retired || !this.retired.length) return;
            for (const object of this.retired) {
                try { object.destroy(); } catch (error) { /* already gone */ }
            }
            this.retired.length = 0;
        },
    });

    /* ================================================================== */
    /* Executor: textures                                                 */
    /* ================================================================== */

    const CUBE_FACE_INDEX = {};
    for (let i = 0; i < 6; ++i)
        CUBE_FACE_INDEX[GL.TEXTURE_CUBE_MAP_POSITIVE_X + i] = i;

    Object.assign(GLWebGPUExecutor.prototype, {

        textureTargetKind(target) {
            if (target === GL.TEXTURE_1D) return "1D";
            if (target === GL.TEXTURE_3D) return "3D";
            if (CUBE_FACE_INDEX[target] !== undefined ||
                    target === GL.TEXTURE_CUBE_MAP) return "Cube";
            return "2D";
        },

        /*
         * Levels are stored on the CPU and the GPU texture is (re)built lazily.
         *
         * GL lets an application define level 3 before level 0 and change a
         * level's size after the fact, neither of which a GPUTexture allows:
         * its size and mip count are fixed at creation. Keeping the authored
         * levels means the texture can be rebuilt whenever the shape changes,
         * which is also what makes device loss recoverable without the guest
         * noticing.
         */
        texImage(target, level, internalFormat, width, height, depth,
                format, type, data) {
            const texture = this.boundTexture(target);
            if (!texture)
                return this.refuse("glTexImage", "no texture bound", { target },
                    GL.INVALID_OPERATION);
            const kind = this.textureTargetKind(target);
            texture.target = kind === "Cube" ? GL.TEXTURE_CUBE_MAP : target;
            let storage = storageFormatFor(internalFormat, this.deviceFeatures);
            if (storage.compressed) {
                // glTexImage* receives ordinary pixels even when the requested
                // internal format is a specific S3TC format; desktop GL then
                // performs the compression.  queue.writeTexture cannot encode
                // RGBA bytes into BC blocks, and these levels are often later
                // filled by CopyTexSubImage while Cube 2 builds environment
                // maps.  Keep the logical base format but use renderable RGBA8
                // storage.  glCompressedTexImage* below still preserves native
                // BC blocks when the application actually supplies them.
                storage = { gpu: "rgba8unorm", compressed: false,
                    base: storage.base };
            }
            const face = CUBE_FACE_INDEX[target] || 0;

            let pixels = null;
            let pixelLayout = {
                bytesPerTexel: storage.palettised ? 1 :
                    (storage.gpu === "rgba16float" ? 8 :
                        (storage.gpu === "rgba32float" ? 16 :
                            (storage.gpu === "depth16unorm" ? 2 : 4))),
                componentType: storage.gpu === "rgba16float" ? "f16" :
                    (storage.gpu === "depth16unorm" ? "u16" :
                        (storage.gpu === "rgba32float" || storage.depth ? "f32" : "u8")),
                componentCount: storage.palettised || storage.depth ? 1 : 4,
            };
            if (data && data.byteLength) {
                const converted = convertPixelsForStorage(data, 0, width, height,
                    depth, format, type, storage, unpackState(this.current.pixelStore));
                if (!converted)
                    return this.refuse("glTexImage", "unsupported pixel format",
                        { format, type, internalFormat }, GL.INVALID_ENUM);
                pixels = converted.pixels;
                pixelLayout = converted;
            }

            this.storeLevel(texture, kind, level, face, {
                width, height, depth,
                gpuFormat: storage.gpu, base: storage.base,
                compressed: false, pixels,
                bytesPerTexel: pixelLayout.bytesPerTexel,
                componentType: pixelLayout.componentType,
                componentCount: pixelLayout.componentCount,
            });
            ++this.stats.textureUploads;
            if (pixels) this.stats.textureBytes += pixels.byteLength;
            if (texture.generateMipmapHint && level === 0)
                this.generateMipmapFor(texture);
        },

        texSubImage(target, level, x, y, z, width, height, depth, format, type,
                data) {
            const texture = this.boundTexture(target);
            if (!texture)
                return this.refuse("glTexSubImage", "no texture bound", { target },
                    GL.INVALID_OPERATION);
            const kind = this.textureTargetKind(target);
            const face = CUBE_FACE_INDEX[target] || 0;
            const slot = this.levelSlot(texture, kind, level, face);
            if (!slot)
                return this.refuse("glTexSubImage", "level has no storage",
                    { level, face }, GL.INVALID_OPERATION);
            if (slot.compressed)
                return this.refuse("glTexSubImage",
                    "uncompressed update of a compressed level", { level },
                    GL.INVALID_OPERATION);
            const storage = { gpu: slot.gpuFormat, base: slot.base,
                float: slot.componentType === "f16" ||
                    (slot.componentType === "f32" && slot.componentCount === 4),
                depth: slot.base === "DEPTH",
                palettised: slot.base === "COLOR_INDEX" };
            const converted = convertPixelsForStorage(data, 0, width, height,
                depth, format, type, storage, unpackState(this.current.pixelStore));
            if (!converted)
                return this.refuse("glTexSubImage", "unsupported pixel format",
                    { format, type }, GL.INVALID_ENUM);
            if (x < 0 || y < 0 || z < 0 || x + width > slot.width || y + height > slot.height ||
                    z + depth > (kind === "3D" ? slot.depth : 1))
                return this.refuse("glTexSubImage", "the rectangle is outside the level",
                    { x, y, z, width, height, depth }, GL.INVALID_VALUE);
            // Patch the CPU copy when the level has one (GL 2.1 allows a
            // TexImage with no data, review S2-20; a level rendered into has
            // none, the GPU's texels being the newer, S2-25), and upload the
            // rectangle alone
            const bytesPerTexel = slot.bytesPerTexel || 4;
            if (slot.pixels) {
                for (let sz = 0; sz < depth; ++sz) {
                    for (let sy = 0; sy < height; ++sy) {
                        const dstRow = (((z + sz) * slot.height + (y + sy)) * slot.width + x) * bytesPerTexel;
                        const srcRow = ((sz * height + sy) * width) * bytesPerTexel;
                        slot.pixels.set(converted.pixels.subarray(srcRow, srcRow + width * bytesPerTexel), dstRow);
                    }
                }
            }
            (texture.regions || (texture.regions = [])).push({ layer: kind === "Cube" ? face : 0, level,
                x, y, z, width, height, depth, pixels: converted.pixels, bytesPerTexel });
            texture.dirty = true;
            ++this.stats.textureUploads;
            // GENERATE_MIPMAP follows every change of the base level (review S2-26)
            if (texture.generateMipmapHint && level === 0) this.generateMipmapFor(texture);
        },

        compressedTexImage(target, level, internalFormat, width, height, depth,
                data) {
            const texture = this.boundTexture(target);
            if (!texture)
                return this.refuse("glCompressedTexImage", "no texture bound",
                    { target }, GL.INVALID_OPERATION);
            const kind = this.textureTargetKind(target);
            texture.target = kind === "Cube" ? GL.TEXTURE_CUBE_MAP : target;
            const storage = storageFormatFor(internalFormat, this.deviceFeatures);
            const face = CUBE_FACE_INDEX[target] || 0;
            if (storage.decodeDXT) {
                // No BC support on this adapter: decode deterministically so
                // the picture is identical and only the memory differs.
                ++this.stats.dxtDecodes;
                const pixels = decodeDXT(storage.decodeDXT, data, width, height);
                this.storeLevel(texture, kind, level, face, {
                    width, height, depth: 1, gpuFormat: "rgba8unorm",
                    base: storage.base, compressed: false, pixels,
                    compressedPixels: data.slice(), compressedFormat: internalFormat,
                    bytesPerTexel: 4, componentType: "u8", componentCount: 4,
                });
                return;
            }
            this.storeLevel(texture, kind, level, face, {
                width, height, depth,
                gpuFormat: storage.gpu, base: storage.base,
                compressed: true, blockBytes: storage.blockBytes,
                pixels: data.slice(), compressedPixels: data.slice(), compressedFormat: internalFormat,
            });
        },

        compressedTexSubImage(target, level, x, y, z, width, height, depth,
                format, data) {
            const texture = this.boundTexture(target);
            if (!texture) return;
            const kind = this.textureTargetKind(target);
            const face = CUBE_FACE_INDEX[target] || 0;
            const slot = this.levelSlot(texture, kind, level, face);
            if (!slot)
                return this.refuse("glCompressedTexSubImage", "level has no storage",
                    { level }, GL.INVALID_OPERATION);
            if (slot.compressedPixels) {
                const blockBytes = storageFormatFor(format, this.deviceFeatures).blockBytes ||
                    (format === GL.COMPRESSED_RGB_S3TC_DXT1_EXT || format === GL.COMPRESSED_RGBA_S3TC_DXT1_EXT ? 8 : 16);
                const sourceStride = Math.ceil(width / 4) * blockBytes, stride = Math.ceil(slot.width / 4) * blockBytes;
                for (let row = 0; row < Math.ceil(height / 4); ++row)
                    slot.compressedPixels.set(data.subarray(row * sourceStride, (row + 1) * sourceStride),
                        (Math.floor(y / 4) + row) * stride + Math.floor(x / 4) * blockBytes);
            }
            if (!slot.compressed) {
                const storage = storageFormatFor(format, this.deviceFeatures);
                if (!storage.decodeDXT) {
                    return this.refuse("glCompressedTexSubImage",
                        "compressed update of an uncompressed level", { level },
                        GL.INVALID_OPERATION);
                }
                ++this.stats.dxtDecodes;
                const pixels = decodeDXT(storage.decodeDXT, data, width, height);
                for (let sy = 0; sy < height; ++sy) {
                    const dst = ((y + sy) * slot.width + x) * 4;
                    const src = sy * width * 4;
                    if (dst < 0 || dst + width * 4 > slot.pixels.length) continue;
                    slot.pixels.set(pixels.subarray(src, src + width * 4), dst);
                }
                this.markLevelUpload(texture, kind === "Cube" ? face : 0, level);
                return;
            }
            if ((x & 3) || (y & 3))
                return this.refuse("glCompressedTexSubImage",
                    "the rectangle is not block aligned", { x, y },
                    GL.INVALID_OPERATION);
            const blocksPerRow = Math.ceil(slot.width / 4);
            const srcBlocksPerRow = Math.ceil(width / 4);
            const blockBytes = slot.blockBytes;
            for (let by = 0; by < Math.ceil(height / 4); ++by) {
                const dst = (((y >> 2) + by) * blocksPerRow + (x >> 2)) * blockBytes;
                const src = by * srcBlocksPerRow * blockBytes;
                if (dst + srcBlocksPerRow * blockBytes > slot.pixels.length) break;
                slot.pixels.set(
                    data.subarray(src, src + srcBlocksPerRow * blockBytes), dst);
            }
            this.markLevelUpload(texture, kind === "Cube" ? face : 0, level);
        },

        levelSlot(texture, kind, level, face) {
            const layer = kind === "Cube" ? face : 0;
            const list = texture.levels[layer];
            return list ? list[level] : null;
        },

        storeLevel(texture, kind, level, face, slot) {
            const layer = kind === "Cube" ? face : 0;
            if (!texture.levels[layer]) texture.levels[layer] = [];
            texture.levels[layer][level] = slot;
            texture.kind = kind;
            texture.baseFormat = slot.base;
            texture.gpuFormat = slot.gpuFormat;
            if (texture.regions)
                texture.regions = texture.regions.filter(r => r.layer !== layer || r.level !== level);
            if (slot.pixels) this.markLevelUpload(texture, layer, level);
            texture.dirty = true;
            texture.viewCache.clear();
            this.invalidateBindGroups();
        },

        // A level whose CPU copy changed is uploaded whole at its next use
        markLevelUpload(texture, layer, level) {
            (texture.fullUploads || (texture.fullUploads = new Set())).add(layer + ":" + level);
            texture.dirty = true;
        },

        /*
         * GL's completeness rules: every mip level from base to max must exist
         * with the right halved size and the same format, or the texture
         * samples as opaque black. Games rely on this to disable a texture by
         * simply not uploading its mips, so it is a behaviour and not a
         * validation nicety.
         */
        textureIsComplete(texture) {
            if (!texture || !texture.levels.length) return false;
            const layers = texture.kind === "Cube" ? 6 : 1;
            const base = texture.levels[0] && texture.levels[0][0];
            if (!base) return false;
            const mipmapped = isMipmapFilter(texture.sampler.minFilter);
            const levelCount = mipmapped ?
                fullMipLevelCount(base.width, base.height, base.depth) : 1;
            for (let layer = 0; layer < layers; ++layer) {
                const list = texture.levels[layer];
                if (!list) return false;
                for (let level = 0; level < levelCount; ++level) {
                    const slot = list[level];
                    if (!slot) return false;
                    if (slot.gpuFormat !== base.gpuFormat) return false;
                    if (slot.width !== Math.max(1, base.width >> level) ||
                            slot.height !== Math.max(1, base.height >> level))
                        return false;
                }
                if (texture.kind === "Cube" &&
                        (base.width !== base.height)) return false;
            }
            return true;
        },

        /* Rebuilds the GPUTexture from the authored levels when anything about
         * the shape changed. */
        ensureTextureUploaded(texture) {
            if (!texture) return null;
            const base = texture.levels[0] && texture.levels[0][0];
            if (!base) return null;
            const layers = texture.kind === "Cube" ? 6 : 1;
            const mipmapped = isMipmapFilter(texture.sampler.minFilter);
            const levelCount = mipmapped ?
                Math.min(fullMipLevelCount(base.width, base.height, base.depth),
                    (texture.levels[0] || []).length) : 1;
            const wanted = {
                width: base.width, height: base.height,
                depth: texture.kind === "3D" ? base.depth : 1,
                layers, levelCount: Math.max(1, levelCount),
                format: base.gpuFormat,
            };
            const shapeChanged = !texture.gpuTexture ||
                texture.gpuWidth !== wanted.width ||
                texture.gpuHeight !== wanted.height ||
                texture.gpuDepth !== wanted.depth ||
                texture.gpuLayers !== wanted.layers ||
                texture.gpuLevels !== wanted.levelCount ||
                texture.allocatedFormat !== wanted.format;
            if (!shapeChanged && !texture.dirty) return texture.gpuTexture;

            if (shapeChanged) {
                const oldTexture = texture.gpuTexture;
                const oldWidth = texture.gpuWidth || 0;
                const oldHeight = texture.gpuHeight || 0;
                const oldDepth = texture.gpuDepth || 1;
                const oldLayers = texture.gpuLayers || 1;
                const oldLevels = texture.gpuLevels || 0;
                const oldFormat = texture.allocatedFormat;
                texture.viewCache.clear();
                const dimension = texture.kind === "3D" ? "3d" : "2d";
                // BC formats are sampled/copied block data; WebGPU does not
                // make them color-renderable.  Giving every GL texture
                // RENDER_ATTACHMENT used to invalidate ordinary DXT textures
                // as soon as Cube 2 sampled them while rendering an envmap.
                // CopyTexImage/FBO paths already reject compressed levels, so
                // only uncompressed textures need the attachment capability.
                const usage = TEXTURE_USAGE_TEXTURE_BINDING |
                    TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_COPY_SRC |
                    (base.compressed ? 0 : TEXTURE_USAGE_RENDER_ATTACHMENT);
                texture.gpuTexture = this.createGPUTexture({
                    label: "GL texture " + texture.name,
                    size: {
                        width: wanted.width, height: wanted.height,
                        depthOrArrayLayers: texture.kind === "3D" ?
                            wanted.depth : wanted.layers,
                    },
                    dimension,
                    mipLevelCount: wanted.levelCount,
                    format: wanted.format,
                    usage,
                });
                texture.gpuWidth = wanted.width;
                texture.gpuHeight = wanted.height;
                texture.gpuDepth = wanted.depth;
                texture.gpuLayers = wanted.layers;
                texture.gpuLevels = wanted.levelCount;
                texture.gpuFormat = wanted.format;
                texture.allocatedFormat = wanted.format;

                // A level produced by CopyTexImage/FBO rendering has no CPU
                // shadow.  Growing the texture to add mip levels must preserve
                // those GPU-authored texels before the old allocation retires.
                if (oldTexture && oldFormat === wanted.format &&
                        oldWidth === wanted.width && oldHeight === wanted.height &&
                        oldDepth === wanted.depth) {
                    this.endPass();
                    const encoder = this.ensureEncoder();
                    const copyLevels = Math.min(oldLevels, wanted.levelCount);
                    const copyLayers = Math.min(oldLayers, wanted.layers);
                    for (let layer = 0; layer < copyLayers; ++layer) {
                        const list = texture.levels[layer] || [];
                        for (let level = 0; level < copyLevels; ++level) {
                            const slot = list[level];
                            if (!slot || slot.pixels) continue;
                            encoder.copyTextureToTexture(
                                { texture: oldTexture, mipLevel: level,
                                  origin: { x: 0, y: 0,
                                    z: texture.kind === "3D" ? 0 : layer } },
                                { texture: texture.gpuTexture, mipLevel: level,
                                  origin: { x: 0, y: 0,
                                    z: texture.kind === "3D" ? 0 : layer } },
                                { width: Math.max(1, wanted.width >> level),
                                  height: Math.max(1, wanted.height >> level),
                                  depthOrArrayLayers: texture.kind === "3D" ?
                                    Math.max(1, wanted.depth >> level) : 1 });
                        }
                    }
                }
                this.retire(oldTexture);
            }

            // A new allocation takes every CPU copy; an existing one only
            // the levels and rectangles that changed, so texels the GPU wrote
            // (rendering, copies, mipmap generation) are not overwritten by
            // an older CPU copy (review S2-25)
            const full = texture.fullUploads || new Set();
            for (let layer = 0; layer < layers; ++layer) {
                const list = texture.levels[layer] || [];
                for (let level = 0; level < wanted.levelCount; ++level) {
                    const slot = list[level];
                    if (!slot || !slot.pixels) continue;
                    if (shapeChanged || full.has(layer + ":" + level))
                        this.writeTextureLevel(texture, slot, level, layer);
                }
            }
            for (const region of texture.regions || []) {
                const slot = (texture.levels[region.layer] || [])[region.level];
                if (!slot || region.level >= wanted.levelCount) continue;
                if (slot.pixels && (shapeChanged || full.has(region.layer + ":" + region.level))) continue;
                if (texture.gpuFormat === "depth32float") {
                    this.writeDepthTexels(texture.gpuTexture, region.level, region.layer, region.x, region.y,
                        region.width, region.height, region.pixels);
                    continue;
                }
                this.device.queue.writeTexture({ texture: texture.gpuTexture, mipLevel: region.level,
                    origin: { x: region.x, y: region.y, z: texture.kind === "3D" ? region.z : region.layer } },
                region.pixels, { offset: 0, bytesPerRow: region.width * region.bytesPerTexel,
                    rowsPerImage: region.height },
                { width: region.width, height: region.height, depthOrArrayLayers: region.depth });
            }
            // (a depth texture's colour copy follows its writes, depthColorView)
            if (shapeChanged || full.size || (texture.regions && texture.regions.length))
                texture.depthGeneration = (texture.depthGeneration || 0) + 1;
            texture.fullUploads = null;
            texture.regions = null;
            texture.dirty = false;
            return texture.gpuTexture;
        },

        writeTextureLevel(texture, slot, level, layer) {
            if (texture.gpuFormat === "depth32float")
                return this.writeDepthTexels(texture.gpuTexture, level, layer, 0, 0,
                    slot.width, slot.height, slot.pixels);
            const bytesPerRow = slot.compressed ?
                Math.ceil(slot.width / 4) * slot.blockBytes :
                slot.width * (slot.bytesPerTexel || 4);
            const rowsPerImage = slot.compressed ?
                Math.ceil(slot.height / 4) : slot.height;
            const origin = texture.kind === "3D" ?
                { x: 0, y: 0, z: 0 } : { x: 0, y: 0, z: layer };
            this.device.queue.writeTexture(
                { texture: texture.gpuTexture, mipLevel: level, origin },
                slot.pixels,
                { offset: 0, bytesPerRow, rowsPerImage },
                {
                    // WebGPU expresses BC copies in complete physical blocks.
                    // The logical 2x2 and 1x1 tail mips still occupy one 4x4
                    // block, so their copy extent must be rounded up even
                    // though the texture's logical mip size remains smaller.
                    width: slot.compressed ? alignUp(slot.width, 4) : slot.width,
                    height: slot.compressed ? alignUp(slot.height, 4) : slot.height,
                    depthOrArrayLayers: texture.kind === "3D" ? slot.depth : 1,
                });
        },

        /*
         * depth32float takes no queue.writeTexture (WebGPU copies out of it
         * only), so its texels -- f32 depths, rows from the bottom -- are
         * drawn: a pass over the rectangle writes frag_depth from them.
         * (Every depth texture with data failed to upload before.)
         */
        writeDepthTexels(gpuTexture, level, layer, x, y, width, height, pixels) {
            const staging = this.createGPUTexture({ label: "GL depth upload",
                size: { width, height, depthOrArrayLayers: 1 }, format: "r32float",
                usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING });
            this.device.queue.writeTexture({ texture: staging }, pixels,
                { offset: 0, bytesPerRow: width * 4, rowsPerImage: height },
                { width, height, depthOrArrayLayers: 1 });
            if (!this.depthUploadPipeline) {
                const module = this.shaderModule(DEPTH_UPLOAD_WGSL);
                this.depthUploadPipeline = this.createPipeline(this.singletonPipelines, "depthUploadPipeline", { label: "GL depth upload", layout: "auto",
                        vertex: { module, entryPoint: "vs_main" },
                        fragment: { module, entryPoint: "fs_main", targets: [] },
                        primitive: { topology: "triangle-list" },
                        depthStencil: { format: "depth32float", depthWriteEnabled: true,
                            depthCompare: "always" } });
            }
            const origin = this.allocateUniform(16);
            if (!origin) return;
            new Int32Array(this.uniformStaging.buffer, origin.offset, 4).set([x, y, 0, 0]);
            this.device.queue.writeBuffer(origin.buffer, origin.offset, this.uniformStaging, origin.offset, 16);
            this.endPass();
            const pass = this.ensureEncoder().beginRenderPass({ label: "GL depth upload", colorAttachments: [],
                depthStencilAttachment: { view: gpuTexture.createView({ dimension: "2d", baseMipLevel: level,
                    mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 }),
                depthLoadOp: "load", depthStoreOp: "store" } });
            pass.setPipeline(this.depthUploadPipeline);
            pass.setBindGroup(0, this.device.createBindGroup({ layout: this.depthUploadPipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: staging.createView() },
                    { binding: 1, resource: { buffer: origin.buffer, offset: origin.offset, size: 16 } }] }));
            pass.setViewport(x, y, width, height, 0, 1);
            pass.setScissorRect(x, y, width, height);
            pass.draw(3);
            pass.end();
            this.retire(staging);
        },

        /*
         * WebGPU has no mipmap generator, so each level is produced by a
         * full-screen draw from the one above. Box filtering by bilinear
         * sampling at the half-texel centres is exactly the 2x2 average the GL
         * spec describes for power-of-two levels.
         */
        generateMipmap(target) {
            const texture = this.boundTexture(target);
            if (!texture)
                return this.refuse("glGenerateMipmap", "no texture bound",
                    { target }, GL.INVALID_OPERATION);
            this.generateMipmapFor(texture);
        },

        generateMipmapFor(texture) {
            const layers = texture.kind === "Cube" ? 6 : 1;
            let needsGPUGeneration = false;
            for (let layer = 0; layer < layers; ++layer) {
                const list = texture.levels[layer];
                if (!list || !list[0]) continue;
                const base = list[0];
                if (base.compressed) {
                    this.refuse("glGenerateMipmap",
                        "a compressed level cannot be downsampled",
                        { name: texture.name }, GL.INVALID_OPERATION);
                    continue;
                }
                const levels = fullMipLevelCount(base.width, base.height, base.depth);
                let source = base;
                for (let level = 1; level < levels; ++level) {
                    const width = Math.max(1, source.width >> 1);
                    const height = Math.max(1, source.height >> 1);
                    const depth = texture.kind === "3D" ?
                        Math.max(1, source.depth >> 1) : 1;
                    const pixels = source.pixels ?
                        downsampleBoxStorage(source, width, height, depth) : null;
                    const slot = {
                        width, height, depth, gpuFormat: base.gpuFormat,
                        base: base.base, compressed: false, pixels,
                        bytesPerTexel: base.bytesPerTexel || 4,
                        componentType: base.componentType || "u8",
                        componentCount: base.componentCount || 4,
                    };
                    list[level] = slot;
                    source = slot;
                    if (pixels) this.markLevelUpload(texture, layer, level);
                    else needsGPUGeneration = true;
                }
                list.length = levels;
            }
            texture.dirty = true;
            texture.viewCache.clear();
            this.invalidateBindGroups();
            if (needsGPUGeneration)
                this.generateTextureMipmapsGPU(texture);
        },
    });

    function isMipmapFilter(filter) {
        return filter === GL.NEAREST_MIPMAP_NEAREST ||
            filter === GL.LINEAR_MIPMAP_NEAREST ||
            filter === GL.NEAREST_MIPMAP_LINEAR ||
            filter === GL.LINEAR_MIPMAP_LINEAR;
    }

    function fullMipLevelCount(width, height, depth) {
        return Math.floor(Math.log2(Math.max(width, height, depth || 1))) + 1;
    }

    function downsampleBox(src, srcW, srcH, srcD, dstW, dstH, dstD) {
        const out = new Uint8Array(dstW * dstH * dstD * 4);
        const xScale = srcW / dstW, yScale = srcH / dstH;
        const zScale = (srcD || 1) / (dstD || 1);
        for (let z = 0; z < dstD; ++z) {
            for (let y = 0; y < dstH; ++y) {
                for (let x = 0; x < dstW; ++x) {
                    const x0 = Math.floor(x * xScale), y0 = Math.floor(y * yScale);
                    const z0 = Math.floor(z * zScale);
                    const x1 = Math.min(srcW - 1, x0 + (xScale > 1 ? 1 : 0));
                    const y1 = Math.min(srcH - 1, y0 + (yScale > 1 ? 1 : 0));
                    const z1 = Math.min((srcD || 1) - 1, z0 + (zScale > 1 ? 1 : 0));
                    const dst = ((z * dstH + y) * dstW + x) * 4;
                    for (let c = 0; c < 4; ++c) {
                        let sum = 0;
                        let n = 0;
                        for (const sz of z0 === z1 ? [z0] : [z0, z1]) {
                            for (const sy of y0 === y1 ? [y0] : [y0, y1]) {
                                for (const sx of x0 === x1 ? [x0] : [x0, x1]) {
                                    sum += src[((sz * srcH + sy) * srcW + sx) * 4 + c];
                                    ++n;
                                }
                            }
                        }
                        out[dst + c] = Math.round(sum / n);
                    }
                }
            }
        }
        return out;
    }

    function downsampleBoxStorage(source, dstW, dstH, dstD) {
        const srcW = source.width, srcH = source.height, srcD = source.depth || 1;
        const componentType = source.componentType || "u8";
        const componentCount = source.componentCount || 4;
        const bytesPerTexel = source.bytesPerTexel || 4;
        if (componentType === "u8" && componentCount === 4)
            return downsampleBox(source.pixels, srcW, srcH, srcD,
                dstW, dstH, dstD);
        const out = new Uint8Array(dstW * dstH * dstD * bytesPerTexel);
        const srcView = new DataView(source.pixels.buffer,
            source.pixels.byteOffset, source.pixels.byteLength);
        const dstView = new DataView(out.buffer);
        const read = (texel, component) => {
            const at = texel * bytesPerTexel;
            if (componentType === "f16")
                return halfToFloat(srcView.getUint16(at + component * 2, true));
            if (componentType === "f32")
                return srcView.getFloat32(at + component * 4, true);
            if (componentType === "u16")
                return srcView.getUint16(at + component * 2, true);
            return srcView.getUint8(at + component);
        };
        const write = (texel, component, value) => {
            const at = texel * bytesPerTexel;
            if (componentType === "f16")
                dstView.setUint16(at + component * 2, floatToHalf(value), true);
            else if (componentType === "f32")
                dstView.setFloat32(at + component * 4, value, true);
            else if (componentType === "u16")
                dstView.setUint16(at + component * 2, Math.round(value), true);
            else dstView.setUint8(at + component, Math.round(value));
        };
        const xScale = srcW / dstW, yScale = srcH / dstH, zScale = srcD / dstD;
        for (let z = 0; z < dstD; ++z) for (let y = 0; y < dstH; ++y)
            for (let x = 0; x < dstW; ++x) {
                const x0 = Math.floor(x * xScale), y0 = Math.floor(y * yScale);
                const z0 = Math.floor(z * zScale);
                const x1 = Math.min(srcW - 1, x0 + (xScale > 1 ? 1 : 0));
                const y1 = Math.min(srcH - 1, y0 + (yScale > 1 ? 1 : 0));
                const z1 = Math.min(srcD - 1, z0 + (zScale > 1 ? 1 : 0));
                const destination = (z * dstH + y) * dstW + x;
                for (let c = 0; c < componentCount; ++c) {
                    let sum = 0, samples = 0;
                    for (const sz of z0 === z1 ? [z0] : [z0, z1])
                        for (const sy of y0 === y1 ? [y0] : [y0, y1])
                            for (const sx of x0 === x1 ? [x0] : [x0, x1]) {
                                sum += read((sz * srcH + sy) * srcW + sx, c);
                                ++samples;
                            }
                    write(destination, c, sum / samples);
                }
            }
        return out;
    }

    /* ================================================================== */
    /* Executor: buffers and programs                                     */
    /* ================================================================== */

    Object.assign(GLWebGPUExecutor.prototype, {

        namedBuffer(name) {
            const group = this.current.shareGroup;
            let buffer = group.buffers.get(name);
            if (!buffer) {
                buffer = createBuffer(name); buffer.id = group.nextBufferId++;
                group.buffers.set(name, buffer); group.bufferObjects.set(buffer.id, buffer);
            }
            return buffer;
        },

        bufferFor(target) {
            const s = this.current, field = BUFFER_TARGET_FIELDS.get(target);
            if (!s || !field || !s[field]) return null;
            return s[field + "Id"] ? s.shareGroup.bufferObjects.get(s[field + "Id"]) || null : s.shareGroup.buffers.get(s[field]) || null;
        },

        arrayBufferObject(array) {
            const group = this.current.shareGroup;
            return array.bufferId ? group.bufferObjects.get(array.bufferId) : group.buffers.get(array.buffer);
        },

        collectBuffers() {
            for (const group of this.shareGroups.values()) {
                const live = new Set([...group.buffers.values()].map(b => b.id));
                const arrays = state => {
                    for (const a of Object.values(state.arrays || {})) if (a.bufferId) live.add(a.bufferId);
                    for (const field of BUFFER_TARGET_FIELDS.values()) if (state[field + "Id"]) live.add(state[field + "Id"]);
                };
                for (const c of this.contexts.values()) if (c.shareGroup === group) {
                    arrays(c); for (const saved of c.clientAttribStack) arrays(saved.state);
                }
                for (const [id, buffer] of group.bufferObjects) if (!live.has(id)) {
                    this.invalidateVertexConversions(buffer); this.retire(buffer.gpuBuffer); group.bufferObjects.delete(id);
                }
            }
        },

        bufferData(target, byteCount, usage, data) {
            const buffer = this.bufferFor(target);
            if (!buffer)
                return this.refuse("glBufferData", "no buffer bound", { target },
                    GL.INVALID_OPERATION);
            buffer.size = byteCount;
            buffer.usage = usage;
            buffer.target = target;
            buffer.shadow = new Uint8Array(byteCount);
            if (data) buffer.shadow.set(data.subarray(0,
                Math.min(data.byteLength, byteCount)));
            this.replaceBufferStorage(buffer);
        },

        replaceBufferStorage(buffer) {
            this.invalidateVertexConversions(buffer);
            this.retire(buffer.gpuBuffer);
            // The same buffer may be bound as vertex data now and as indices
            // later, and GL never says which; asking for both costs nothing.
            const byteCount = buffer.shadow.byteLength;
            const size = alignUp(byteCount, 4);
            buffer.gpuBuffer = byteCount ? this.createGPUBuffer({
                label: "GL buffer " + buffer.name,
                size,
                usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_INDEX |
                    BUFFER_USAGE_COPY_DST | BUFFER_USAGE_COPY_SRC,
            }) : null;
            if (buffer.gpuBuffer) {
                const upload = size === byteCount ? buffer.shadow :
                    new Uint8Array(size);
                if (upload !== buffer.shadow) upload.set(buffer.shadow);
                this.device.queue.writeBuffer(buffer.gpuBuffer, 0, upload, 0, size);
            }
        },

        bufferSubData(target, offset, data) {
            const buffer = this.bufferFor(target);
            if (!buffer || !buffer.shadow)
                return this.refuse("glBufferSubData", "no buffer storage",
                    { target }, GL.INVALID_OPERATION);
            if (offset + data.byteLength > buffer.shadow.byteLength)
                return this.refuse("glBufferSubData", "update is out of range",
                    { offset, size: data.byteLength }, GL.INVALID_VALUE);
            this.invalidateVertexConversions(buffer);
            buffer.shadow.set(data, offset);
            if (buffer.gpuBuffer) {
                // Queue writes execute before a command buffer submitted later,
                // even if its draw was encoded first. Rename live storage so a
                // dynamic model update cannot change already-recorded geometry.
                // No pass/occlusion-query split is needed for this copy-on-write.
                if (this.pendingVertexBuffers.has(buffer.gpuBuffer)) {
                    this.replaceBufferStorage(buffer);
                    return;
                }
                // writeBuffer wants 4-byte alignment at both ends; a ragged
                // update is widened to the enclosing aligned span, which is
                // safe because the shadow copy holds the true contents.
                const start = offset & ~3;
                const end = alignUp(offset + data.byteLength, 4);
                const clampedEnd = Math.min(end, buffer.shadow.byteLength);
                const span = end - start;
                if (span > 0) {
                    if (end <= buffer.shadow.byteLength) {
                        this.device.queue.writeBuffer(buffer.gpuBuffer, start,
                            buffer.shadow, start, span);
                    } else {
                        const upload = new Uint8Array(span);
                        upload.set(buffer.shadow.subarray(start, clampedEnd));
                        this.device.queue.writeBuffer(buffer.gpuBuffer, start,
                            upload, 0, span);
                    }
                }
            }
        },

        /* ---- programs ---- */

        vertexCaptureShaders(raster = false) {
            const program = this.currentProgramObject();
            if (program?.compiled.vertex) {
                const link = translator.linkVertexCapture(program.compiled.vertex, { bindAttribLocations: this.attribBindings(program), vertexCaptureRaster: raster });
                if (!link.ok) throw new Error(link.log);
                return { kind: "program", program, capture: true, key: "capture:" + link.cacheKey, wgslVertex: link.wgslCompute, wgslFragment: "",
                    reflection: link.reflection, stateFields: link.reflection.stateFields, uniformBytes: link.reflection.uniformBlockBytes };
            }
            const vertex = this.current.enabled.has(GL.VERTEX_PROGRAM_ARB) && this.arbProgramFor(GL.VERTEX_PROGRAM_ARB);
            if (!vertex?.compiled?.ok) throw new Error("vertex capture has no installed vertex program");
            const compiled = arbProgram.compileARBProgram(vertex.source, { vertexCapture: true, vertexCaptureRaster: raster });
            if (!compiled.ok) throw new Error(compiled.log);
            return { kind: "arb", capture: true, key: "capture-arb:" + compiled.wgsl, wgslVertex: compiled.wgsl, wgslFragment: "",
                stateFields: compiled.reflection.stateFields, arbVertex: vertex, textures: [] };
        },

        captureVertices(bytes, view, offset, size, metadata, raster = false) {
            const record = raster ? "CAPTURE_RASTER_VERTEX" : "CAPTURE_VERTICES", r = protocol.decodeRecord(record, view, offset), header = protocol.RECORDS[record].size;
            if (raster) Object.assign(r, { first: 0, count: 1, total: 1 });
            const owned = [], notify = result => {
                if (metadata?.isMemoryValid && !metadata.isMemoryValid()) return;
                if (typeof metadata?.onVertexCapture !== "function") throw new Error("vertex capture has no CPU result channel");
                metadata.onVertexCapture({ job: r.job, first: r.first, ...result });
            };
            let read;
            try {
                if (!r.job || !r.count || r.count > 256 || r.first % 256 || r.first + r.count > r.total || size !== header + r.count * 256)
                    throw new GLStreamError("invalid bounded vertex capture record");
                this.flushFrame();
                const shaders = this.vertexCaptureShaders(raster);
                const created = this.gpuErrors.scoped("vertex capture", () => {
                    const buffer = (size, usage) => { const b = this.createGPUBuffer({ size, usage }); owned.push(b); return b; };
                    const input = buffer(r.count * 256, BUFFER_USAGE_STORAGE | BUFFER_USAGE_COPY_DST),
                        output = buffer(r.count * (raster ? translator.VERTEX_CAPTURE.rasterOutputBytes : translator.VERTEX_CAPTURE.outputBytes), BUFFER_USAGE_STORAGE | BUFFER_USAGE_COPY_SRC);
                    read = buffer(output.size, BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST);
                    this.device.queue.writeBuffer(input, 0, bytes.subarray(offset + header, offset + size));
                    const module = this.device.createShaderModule({ code: shaders.wgslVertex }),
                        pipeline = this.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "capture_main" } });
                    pipeline.glActiveBindings = activeShaderBindings(shaders.wgslVertex, "", "capture_main");
                    const groups = this.buildBindGroups(pipeline, shaders);
                    if (!groups) throw new Error("could not bind vertex capture resources");
                    const encoder = this.device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline);
                    for (let index = 0; index < 4; ++index) {
                        const group = groups.find(entry => entry.index === index)?.group || this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(index),
                            entries: index === 3 ? [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }] : [] });
                        pass.setBindGroup(index, group);
                    }
                    pass.dispatchWorkgroups(Math.ceil(r.count / 64)); pass.end();
                    encoder.copyBufferToBuffer(output, 0, read, 0, output.size); this.device.queue.submit([encoder.finish()]);
                }, { job: r.job, first: r.first });
                const done = Promise.all([read.mapAsync(1), created.checked]).then(([, error]) => {
                    if (error) throw new Error(error);
                    return new Float32Array(read.getMappedRange()).slice();
                });
                this.trackReadback(this.awaitReadback(done, "vertex capture", () => read.destroy()).then(values => notify({ values }), error => notify({ error: String(error) }))
                    .finally(() => { for (const object of owned) object.destroy(); }));
            } catch (error) {
                for (const object of owned) object.destroy(); notify({ error: String(error) });
            }
        },

        collectGLShader(group, shader) {
            if (!shader.deleted) return;
            for (const program of group.programs.values()) if (program.shaders.has(shader.name)) return;
            group.shaders.delete(shader.name);
        },

        collectGLProgram(group, program) {
            if (!program.deleted) return;
            for (const context of this.contexts.values())
                if (context.shareGroup === group && context.currentProgram === program.name) return;
            group.programs.delete(program.name);
            for (const name of program.shaders) {
                const shader = group.shaders.get(name);
                if (shader) this.collectGLShader(group, shader);
            }
        },

        linkProgram(name) {
            const program = this.current.shareGroup.programs.get(name);
            if (!program)
                return this.refuse("glLinkProgram", "unknown program", { name },
                    GL.INVALID_VALUE);
            program.linked = false;
            program.log = "";
            program.validateLog = "program is not validated";
            const candidate = createProgram(name);
            candidate.cacheOwner = program;
            candidate.bindAttribLocations = new Map(program.bindAttribLocations);
            const units = { vertex: [], fragment: [] };
            for (const shaderName of program.shaders) {
                const shader = this.current.shareGroup.shaders.get(shaderName);
                if (!shader) continue;
                if (!shader.compiled || !shader.compiled.ok) {
                    program.log = shader.compiled ? shader.compiled.log : "ERROR: a shader is not compiled";
                    return;
                }
                units[shader.stage].push(shader.compiled);
            }
            for (const stage of ["vertex", "fragment"]) if (units[stage].length)
                candidate.compiled[stage] = translator.linkShaderUnits(units[stage], stage, this.options.translator || {});
            if (!candidate.compiled.vertex && !candidate.compiled.fragment) {
                program.log = "ERROR: no shaders attached";
                return;
            }
            // The base link (no pipeline variant) settles the uniform layout
            // and the reflection, which every variant then shares -- so
            // glGetUniformLocation answers the same value no matter which
            // variant a later draw happens to need.
            const link = this.linkVariant(candidate, {});
            if (!link.ok) {
                program.log = link.log;
                return;
            }
            program.compiled = candidate.compiled;
            program.variants.clear();
            program.adoptedAttribLocations.clear();
            program.link = link;
            program.linked = true;
            program.log = link.log;
            this.buildUniformStorage(program, link.reflection);
            ++program.serial;
            program.executableGeneration = (program.executableGeneration || 0) + 1;
        },

        variantKeyFor(variant) {
            return this.variantKeys.key(variant);
        },
        codeKey(vertex, fragment) {
            return this.shaderCodeKeys.key([vertex, fragment]);
        },
        pairKey(first, second, vertex, fragment) {
            let keys = this.compiledPairKeys.get(first);
            if (!keys) this.compiledPairKeys.set(first, keys = new Map());
            let key = keys.get(second);
            if (key === undefined) keys.set(second, key = this.codeKey(vertex, fragment));
            return key;
        },

        // The application's bindings, and over them the locations the guest
        // was told for the attributes it asked about
        attribBindings(program) {
            return new Map([...program.bindAttribLocations, ...program.adoptedAttribLocations]);
        },

        linkVariant(program, variant) {
            const bindings = this.attribBindings(program);
            const options = {
                bindAttribLocations: bindings,
                variant,
                maxColorTargets: variant.colorTargets,
                nonUniformSampleStrategy:
                    this.options.nonUniformSampleStrategy || "grad",
            };
            if (!program.compiled.vertex || !program.compiled.fragment) {
                const signature = this.mixedGLSLSignature(program, variant);
                return fixedFunction.linkGLSL(program.compiled.vertex, program.compiled.fragment, signature, options);
            }
            // (the bindings are part of the key: a relink with others
            // assigns other locations)
            const owner = program.cacheOwner || program;
            const key = this.linkKeys.key([
                this.linkKeys.reference(owner), owner.cpuObjectId || 0, owner.cpuLinkGeneration || 0,
                this.linkKeys.reference(program.compiled.vertex), this.linkKeys.reference(program.compiled.fragment),
                variant, [...bindings].sort((x, y) => x[0] < y[0] ? -1 : 1),
            ]);
            const cached = this.shaderCache.get(key);
            if (cached) {
                ++this.stats.shaderCacheHits;
                return cached;
            }
            const link = translator.linkProgram(program.compiled.vertex,
                program.compiled.fragment, options);
            if (link.ok) {
                ++this.stats.shaderLinks;
                this.stats.nonUniformSamples += link.stats.nonUniformSamples;
                this.shaderCache.set(key, link);
            }
            return link;
        },

        buildUniformStorage(program, reflection) {
            program.uniformData = new Uint8Array(
                Math.max(16, reflection.uniformBlockBytes));
            program.uniformFloats = new Float32Array(program.uniformData.buffer);
            program.uniformInts = new Int32Array(program.uniformData.buffer);
            program.uniformByName.clear();
            program.uniformByLocation = new Map();
            program.ownByLocation = null;
            for (const uniform of reflection.uniforms) {
                const count = Math.max(1, uniform.arraySize);
                const location = this.nextUniformLocation;
                this.nextUniformLocation += count;
                const mapped = Object.assign({}, uniform, { location });
                program.uniformByName.set(mapped.name, mapped);
                for (let i = 0; i < count; ++i)
                    program.uniformByLocation.set(location + i,
                        { uniform: mapped, element: i });
            }
            program.samplerUnits.clear();
            for (const sampler of reflection.samplers) {
                const count = Math.max(1, sampler.arraySize);
                const location = this.nextUniformLocation;
                this.nextUniformLocation += count;
                const mapped = Object.assign({}, sampler, { location });
                program.uniformByName.set(mapped.name, mapped);
                for (let i = 0; i < count; ++i) {
                    program.uniformByLocation.set(location + i,
                        { sampler: mapped, element: i });
                    program.samplerUnits.set(mapped.name +
                        (mapped.arraySize ? "[" + i + "]" : ""), 0);
                }
            }
        },

        currentProgramObject() {
            const s = this.current;
            if (!s.currentProgram) return null;
            const program = s.shareGroup.programs.get(s.currentProgram);
            // A failed relink changes LINK_STATUS, but its installed code,
            // variant inputs and uniform storage remain usable until unbound.
            return program && program.link ? program : null;
        },

        setUniformVector(view, offset, size, bytes, integer) {
            const program = this.currentProgramObject();
            if (!program || !program.linked) return;
            const location = view.getInt32(offset, true);
            const components = view.getInt32(offset + 4, true);
            const count = view.getInt32(offset + 8, true);
            if (components < 1 || components > 4 || count < 0) return;
            const entry = program.uniformByLocation.get(location);
            if (!entry) return;

            if (entry.sampler) {
                // glUniform1i on a sampler names a texture unit; it is a
                // binding change, not a value in the uniform block.
                for (let i = 0; i < count; ++i) {
                    const element = entry.element + i;
                    if (entry.sampler.arraySize && element >= entry.sampler.arraySize) break;
                    const src = offset + 12 + i * 4; if (src + 4 > offset + size) return;
                    const key = entry.sampler.name + (entry.sampler.arraySize ? "[" + element + "]" : "");
                    program.samplerUnits.set(key, view.getInt32(src, true));
                }
                this.invalidateBindGroups();
                return;
            }

            const uniform = entry.uniform;
            const stride = uniform.arraySize ?
                uniform.arrayStrideBytes : 0;
            for (let i = 0; i < count; ++i) {
                const element = entry.element + i;
                if (uniform.arraySize && element >= uniform.arraySize) break;
                const base = uniform.offsetBytes + element * stride;
                for (let c = 0; c < components; ++c) {
                    const src = offset + 12 + (i * components + c) * 4;
                    if (src + 4 > offset + size) return;
                    const at = (base >> 2) + c;
                    if (uniform.baseType === "bool")
                        program.uniformInts[at] = +(!!(integer ? view.getInt32(src, true) : view.getFloat32(src, true)));
                    else if (integer || uniform.baseType !== "float") program.uniformInts[at] = view.getInt32(src, true);
                    else
                        program.uniformFloats[at] = view.getFloat32(src, true);
                }
            }
            ++program.serial;
        },

        setUniformMatrix(location, columns, rows, count, transpose, view, offset,
                size) {
            const program = this.currentProgramObject();
            if (!program || !program.linked) return;
            const entry = program.uniformByLocation.get(location);
            if (!entry || !entry.uniform) return;
            const uniform = entry.uniform;
            const columnStride = uniform.matrixColumnStrideBytes ||
                (rows === 2 ? 8 : 16);
            const stride = uniform.arraySize ? uniform.arrayStrideBytes : 0;
            for (let m = 0; m < count; ++m) {
                const element = entry.element + m;
                if (uniform.arraySize && element >= uniform.arraySize) break;
                const base = uniform.offsetBytes + element * stride;
                for (let c = 0; c < columns; ++c) {
                    for (let r = 0; r < rows; ++r) {
                        // GL's default is column-major; transpose means the
                        // caller handed rows first.
                        const sourceIndex = transpose ?
                            (r * columns + c) : (c * rows + r);
                        const src = offset + (m * columns * rows + sourceIndex) * 4;
                        if (src + 4 > offset + size) return;
                        const at = (base + c * columnStride) / 4 + r;
                        program.uniformFloats[at] = view.getFloat32(src, true);
                    }
                }
            }
            ++program.serial;
        },

        /*
         * The CPU side's shadow answered glGetUniformLocation or
         * glGetAttribLocation (gl_shadow_glsl.js): the guest uses that
         * location from now on, whatever this side assigned. A program's
         * first adopted uniform location retires the ones assigned here
         * (they may collide with the shadow's); an attribute at another
         * location than this side's link gave it relinks the program with
         * it bound there.
         */
        adoptLocation(kind, programName, name, location) {
            const program = this.current.shareGroup.programs.get(programName);
            if (!program || !program.linked || location < 0) return;
            if (kind === LOCATION_KIND_ATTRIB) {
                const attribute = program.link.reflection.attributes.find(a => a.name === name);
                if (!attribute || attribute.location === location) return;
                program.adoptedAttribLocations.set(name, location);
                const link = this.linkVariant(program, {});
                if (!link.ok) {
                    this.warnOnce("adopt-attrib-" + programName + "-" + name,
                        "the program cannot have an attribute where the guest was told it is", { name, location });
                    program.adoptedAttribLocations.delete(name);
                    return;
                }
                program.link = link;
                program.variants.clear();
                ++program.serial;
                return;
            }
            const match = /^(.*)\[(\d+)\]$/.exec(name);
            const mapped = program.uniformByName.get(match ? match[1] : name);
            if (!mapped) return;
            if (!program.ownByLocation) {
                program.ownByLocation = program.uniformByLocation;
                program.uniformByLocation = new Map();
            }
            const element = match ? +match[2] : 0;
            // Asking for any element also establishes base + i for all of
            // the array. Applications need not query each element separately.
            for (let i = 0; i < Math.max(1, mapped.arraySize); ++i) {
                const entry = program.ownByLocation.get(mapped.location + i);
                if (entry) program.uniformByLocation.set(location - element + i, entry);
            }
        },

        /* ---- synchronous query answers ---- */


        /* openglproxy's V86GL_ACTIVE_KIND_UNIFORM is 1 and _ATTRIB is 2. */

    });

    /* ================================================================== */
    /* Executor: vertex assembly and drawing                              */
    /* ================================================================== */

    /* GL vertex types that WebGPU can consume without conversion. Anything
     * else is widened to float32 on the CPU, because the generated shaders
     * declare every attribute as a float vector. */
    const DIRECT_VERTEX_FORMATS = {
        [GL.FLOAT]: { 1: "float32", 2: "float32x2", 3: "float32x3", 4: "float32x4" },
        [GL.HALF_FLOAT]: { 2: "float16x2", 4: "float16x4" },
    };
    const DIRECT_NORMALIZED_FORMATS = {
        [GL.UNSIGNED_BYTE]: { 4: "unorm8x4" },
        [GL.BYTE]: { 4: "snorm8x4" },
        [GL.UNSIGNED_SHORT]: { 2: "unorm16x2", 4: "unorm16x4" },
        [GL.SHORT]: { 2: "snorm16x2", 4: "snorm16x4" },
    };


    Object.assign(GLWebGPUExecutor.prototype, {

        /* ---- immediate mode ---- */

        /*
         * glBegin/glEnd arrives one record per vertex, so the accumulator here
         * is where a Half-Life frame's twenty thousand vertices actually land.
         * Each vertex snapshots GL's *current* colour, normal and texture
         * coordinates, which is the whole semantic of immediate mode.
         */
        beginImmediate(mode) {
            const s = this.current;
            if (s.immediate)
                return this.refuse("glBegin", "glBegin inside glBegin", { mode },
                    GL.INVALID_OPERATION);
            if (PRIMITIVE_TOPOLOGY[mode] === undefined)
                return this.refuse("glBegin", "unknown primitive mode", { mode },
                    GL.INVALID_ENUM);
            s.immediate = {
                mode, count: 0,
                data: this.immediateBuffer || (this.immediateBuffer =
                    new Float32Array(65536)),
                stride: 0,
                used: { color: false, normal: false, secondaryColor: false,
                        fogCoord: false,
                        texCoord: new Array(MAX_TEXTURE_COORDS).fill(false),
                        generic: [] },
                // per vertex, once one is not set (glEdgeFlag)
                edgeFlags: null,
            };
            const used = s.immediate.used;
            const program = this.currentProgramObject();
            const arbVertex = s.enabled.has(GL.VERTEX_PROGRAM_ARB);
            // Immediate vertices must satisfy the active shader interface, not
            // stale client-array enables. Legacy renderers commonly keep a
            // normal array enabled while drawing glBegin/glEnd UI geometry;
            // conversely an ARB vertex program may read vertex.normal with
            // fixed-function lighting disabled. In both cases deriving this
            // layout only from GL_LIGHTING/client-array state leaves
            // @location(2) unbound.
            for (const entry of this.wantedAttributes(program)) {
                let source = entry.source;
                if (source.indexOf("generic") === 0 && entry.alias &&
                        (entry.alias === "vertex" || entry.alias === "normal" ||
                         entry.alias === "color" ||
                         entry.alias === "secondaryColor" ||
                         entry.alias === "fogCoord" ||
                         entry.alias.indexOf("texCoord") === 0))
                    source = entry.alias;
                if (source === "color") used.color = true;
                else if (source === "normal") used.normal = true;
                else if (source === "secondaryColor") used.secondaryColor = true;
                else if (source === "fogCoord") used.fogCoord = true;
                else if (source.indexOf("texCoord") === 0) {
                    const unit = Number(source.substring(8));
                    if (unit >= 0 && unit < MAX_TEXTURE_COORDS)
                        used.texCoord[unit] = true;
                } else if (source.indexOf("generic") === 0) {
                    // attribute 0 aliases the position, which every
                    // immediate vertex carries at its location (review
                    // S1-2h: both were laid out at location 0)
                    const index = Number(source.substring(7));
                    if (index > 0 && index < MAX_VERTEX_ATTRIBS &&
                            !used.generic.some(item =>
                                item.location === entry.location)) {
                        used.generic.push({
                            index, location: entry.location,
                            components: Math.min(4,
                                Math.max(1, entry.components || 4)),
                        });
                    }
                }
            }
            // The fixed pipeline always consumes current colour even when no
            // colour command occurs in the batch. Programmable shaders carry
            // it only when reflection above says they actually read it.
            if (!program && !arbVertex) used.color = true;
        },

        immediateVertex(x, y, z, w) {
            const s = this.current;
            const batch = s.immediate;
            if (!batch)
                return this.refuse("glVertex", "glVertex outside glBegin", {},
                    GL.INVALID_OPERATION);
            const used = batch.used;
            for (let unit = 0; unit < MAX_TEXTURE_COORDS; ++unit)
                if (s.textureUnits[unit].enabledTargets.size)
                    used.texCoord[unit] = true;
            if (s.enabled.has(GL.LIGHTING)) used.normal = true;
            if (s.enabled.has(GL.COLOR_SUM) ||
                    s.lightModel.colorControl === GL.SEPARATE_SPECULAR_COLOR)
                used.secondaryColor = true;
            if (s.enabled.has(GL.FOG) && s.fog.coordSource === GL.FOG_COORD)
                used.fogCoord = true;

            const stride = this.immediateStride(used);
            const need = (batch.count + 1) * stride;
            if (need > batch.data.length) {
                const grown = new Float32Array(Math.max(need * 2,
                    batch.data.length * 2));
                grown.set(batch.data.subarray(0, batch.count * batch.stride));
                batch.data = grown;
                this.immediateBuffer = grown;
            }
            if (stride !== batch.stride && batch.count) {
                // A later vertex enabled an attribute the earlier ones did not
                // carry. Re-laying out the batch keeps one buffer per glEnd,
                // which is worth more than the rare copy.
                this.relayoutImmediate(batch, stride);
            }
            batch.stride = stride;
            let at = batch.count * stride;
            const data = batch.data;
            const current = s.current;
            data[at++] = x; data[at++] = y; data[at++] = z; data[at++] = w;
            if (used.color) {
                data[at++] = current.color[0]; data[at++] = current.color[1];
                data[at++] = current.color[2]; data[at++] = current.color[3];
            }
            if (used.normal) {
                data[at++] = current.normal[0]; data[at++] = current.normal[1];
                data[at++] = current.normal[2];
            }
            if (used.secondaryColor) {
                data[at++] = current.secondaryColor[0];
                data[at++] = current.secondaryColor[1];
                data[at++] = current.secondaryColor[2];
                data[at++] = current.secondaryColor[3];
            }
            if (used.fogCoord) data[at++] = current.fogCoord;
            for (let unit = 0; unit < MAX_TEXTURE_COORDS; ++unit) {
                if (!used.texCoord[unit]) continue;
                const tc = current.texCoord[unit];
                data[at++] = tc[0]; data[at++] = tc[1];
                data[at++] = tc[2]; data[at++] = tc[3];
            }
            for (const item of used.generic) {
                const value = s.genericAttribs[item.index].value;
                for (let c = 0; c < item.components; ++c)
                    data[at++] = value[c];
            }
            if (!current.edgeFlag || batch.edgeFlags) {
                if (!batch.edgeFlags || batch.edgeFlags.length <= batch.count) {
                    const grown = new Uint8Array(Math.max(64, batch.count * 2)).fill(1);
                    if (batch.edgeFlags) grown.set(batch.edgeFlags);
                    batch.edgeFlags = grown;
                }
                batch.edgeFlags[batch.count] = current.edgeFlag ? 1 : 0;
            }
            ++batch.count;
        },

        immediateStride(used) {
            let stride = 4;
            if (used.color) stride += 4;
            if (used.normal) stride += 3;
            if (used.secondaryColor) stride += 4;
            if (used.fogCoord) stride += 1;
            for (let unit = 0; unit < MAX_TEXTURE_COORDS; ++unit)
                if (used.texCoord[unit]) stride += 4;
            for (const item of used.generic) stride += item.components;
            return stride;
        },

        relayoutImmediate(batch, stride) {
            const grown = new Float32Array(
                Math.max(batch.data.length, (batch.count + 1) * stride * 2));
            for (let i = 0; i < batch.count; ++i)
                grown.set(batch.data.subarray(i * batch.stride,
                    i * batch.stride + batch.stride), i * stride);
            batch.data = grown;
            this.immediateBuffer = grown;
        },

        endImmediate() {
            const s = this.current;
            const batch = s.immediate;
            if (!batch || !batch.count) {
                s.immediate = null;
                return;
            }
            ++this.stats.immediateBatches;

            const attributes = [];
            let offset = 0;
            const push = (location, components) => {
                attributes.push({ location, components, offsetFloats: offset });
                offset += components;
            };
            push(translator.COMPAT_ATTRIBUTE_LOCATIONS.gl_Vertex, 4);
            if (batch.used.color)
                push(translator.COMPAT_ATTRIBUTE_LOCATIONS.gl_Color, 4);
            if (batch.used.normal)
                push(translator.COMPAT_ATTRIBUTE_LOCATIONS.gl_Normal, 3);
            if (batch.used.secondaryColor)
                push(translator.COMPAT_ATTRIBUTE_LOCATIONS.gl_SecondaryColor, 4);
            if (batch.used.fogCoord)
                push(translator.COMPAT_ATTRIBUTE_LOCATIONS.gl_FogCoord, 1);
            for (let unit = 0; unit < MAX_TEXTURE_COORDS; ++unit)
                if (batch.used.texCoord[unit])
                    push(translator.COMPAT_ATTRIBUTE_LOCATIONS.gl_MultiTexCoord0 +
                        unit, 4);
            for (const item of batch.used.generic)
                push(item.location, item.components);

            const bytes = new Uint8Array(batch.data.buffer, 0,
                batch.count * batch.stride * 4);
            const slice = this.uploadVertices(bytes);
            if (!slice) {
                s.immediate = null;
                return;
            }
            try {
                this.issueDraw({
                    mode: batch.mode,
                    vertexCount: batch.count,
                    cpu: { data: batch.data, stride: batch.stride, count: batch.count,
                           layout: attributes, edgeFlags: batch.edgeFlags },
                    buffers: [{
                        gpuBuffer: slice.buffer,
                        baseOffset: slice.offset,
                        stride: batch.stride * 4,
                        attributes: attributes.map(a => ({
                            location: a.location,
                            format: "float32" + (a.components > 1 ?
                                "x" + a.components : ""),
                            offset: a.offsetFloats * 4,
                        })),
                    }],
                    index: null,
                });
            } finally {
                s.immediate = null;
            }
        },

        /* ---- packed client arrays ---- */

        drawPacked(mode, count, arrays, indexInfo) {
            if (count <= 0) return;
            if (PRIMITIVE_TOPOLOGY[mode] === undefined)
                return this.refuse("glDrawArrays", "unknown primitive mode",
                    { mode }, GL.INVALID_ENUM);
            const program = this.currentProgramObject();
            const wanted = this.wantedAttributes(program);
            let sourceIndices = null;
            let firstSourceVertex = 0;
            let packedVertexCount = count;
            let drawIndexInfo = indexInfo;
            if (indexInfo && indexInfo.data) {
                const indices = indexInfo.decoded ||
                    readIndices(indexInfo.type, indexInfo.data, count);
                const expandIndexedPoints = mode === GL.POINTS && this.pointsExpand();
                if (expandIndexedPoints) {
                    sourceIndices = indices;
                    packedVertexCount = count;
                    drawIndexInfo = null;
                } else {
                    let min = 0xffffffff, max = 0;
                    for (const value of indices) {
                        min = Math.min(min, value);
                        max = Math.max(max, value);
                    }
                    const rebased = new Uint32Array(indices.length);
                    if (max - min + 1 <= count * 2) {
                        firstSourceVertex = min;
                        packedVertexCount = max - min + 1;
                        for (let i = 0; i < indices.length; ++i)
                            rebased[i] = indices[i] - min;
                    } else {
                        // Sparse draws must not allocate the entire unused
                        // interval between their lowest and highest index.
                        const remap = new Map();
                        sourceIndices = [];
                        for (let i = 0; i < indices.length; ++i) {
                            const value = indices[i];
                            if (!remap.has(value)) {
                                remap.set(value, sourceIndices.length);
                                sourceIndices.push(value);
                            }
                            rebased[i] = remap.get(value);
                        }
                        packedVertexCount = sourceIndices.length;
                    }
                    drawIndexInfo = { type: GL.UNSIGNED_INT,
                        data: new Uint8Array(rebased.buffer), decoded: rebased };
                }
            }

            const arbVertexOn = this.current.enabled.has(GL.VERTEX_PROGRAM_ARB);
            if (!program && !arbVertexOn &&
                    (!arrays.vertex || !arrays.vertex.data))
                return this.refuse("glDrawArrays",
                    "the fixed pipeline needs a vertex array", { mode },
                    GL.INVALID_OPERATION);

            // Every array is widened to float32 and interleaved into one ring
            // slice. Packing costs a pass over the data, but it is the only
            // shape that handles GL's whole type matrix, and the arrays already
            // arrived as a CPU copy from the guest.
            const layout = [];
            let stride = 0;
            for (const entry of wanted) {
                const source = this.resolveAttributeSource(arrays, entry,
                    block => !!(block && block.data));
                const block = arrays[source];
                const constant = (!block || !block.data) ?
                    this.currentAttributeValue(source, entry.location) : null;
                if ((!block || !block.data) && !constant) continue;
                const components = entry.components || (block ?
                    Math.min(4, Math.max(1, block.size || 4)) : constant.length);
                layout.push({ location: entry.location, source,
                              block, constant, components, offsetFloats: stride });
                stride += components;
            }
            if (!layout.length)
                return this.refuse("glDrawArrays", "no vertex array is enabled",
                    { mode }, GL.INVALID_OPERATION);

            const packed = new Float32Array(stride * packedVertexCount);
            for (const item of layout) {
                const block = item.block;
                if (!block || !block.data) {
                    for (let v = 0; v < packedVertexCount; ++v) {
                        const dst = v * stride + item.offsetFloats;
                        for (let c = 0; c < item.components; ++c)
                            packed[dst + c] = c < item.constant.length ?
                                item.constant[c] : (c === 3 ? 1 : 0);
                    }
                    continue;
                }
                const view = new DataView(block.data.buffer,
                    block.data.byteOffset, block.data.byteLength);
                const size = Math.max(1, block.size || item.components);
                const elementBytes = componentBytes(block.type);
                if (!elementBytes) {
                    this.refuse("glDrawArrays", "unsupported array type",
                        { type: block.type }, GL.INVALID_ENUM);
                    return;
                }
                const srcStride = block.stride || size * elementBytes;
                const normalized = this.arrayIsNormalized(item.source, block);
                for (let v = 0; v < packedVertexCount; ++v) {
                    const sourceVertex = sourceIndices ? sourceIndices[v] :
                        firstSourceVertex + v;
                    const src = sourceVertex * srcStride;
                    const dst = v * stride + item.offsetFloats;
                    for (let c = 0; c < item.components; ++c) {
                        if (c < size && src + (c + 1) * elementBytes <=
                                block.data.byteLength) {
                            packed[dst + c] = readComponent(view,
                                src + c * elementBytes, block.type, normalized);
                        } else {
                            packed[dst + c] = c === 3 ? 1 : 0;
                        }
                    }
                }
            }

            const slice = this.uploadVertices(new Uint8Array(packed.buffer));
            if (!slice) return;
            const buffers = [{
                gpuBuffer: slice.buffer,
                baseOffset: slice.offset,
                stride: stride * 4,
                attributes: layout.map(item => ({
                    location: item.location,
                    format: "float32" + (item.components > 1 ?
                        "x" + item.components : ""),
                    offset: item.offsetFloats * 4,
                })),
            }];

            let index = null;
            if (drawIndexInfo && drawIndexInfo.data) {
                index = this.uploadIndices(mode, drawIndexInfo.type, drawIndexInfo.data,
                    count, drawIndexInfo.decoded);
                if (!index) return;
            }
            this.issueDraw({ mode, vertexCount: count, buffers, index,
                cpu: { data: packed, stride, count: packedVertexCount, layout, edgeFlags: null } });
        },

        /* Which of the two aliased slots this attribute's array actually
         * arrived in. `usable` differs between the packed and VBO paths, so
         * the caller decides what counts as present. */
        resolveAttributeSource(arrays, entry, usable) {
            if (!entry.alias || !arrays) return entry.source;
            if (usable(arrays[entry.source])) return entry.source;
            if (usable(arrays[entry.alias])) return entry.alias;
            return entry.source;
        },

        arrayIsNormalized(source, block) {
            if (source.indexOf("generic") === 0) return !!block.normalized;
            return source === "color" || source === "secondaryColor" ||
                source === "normal";
        },

        currentAttributeValue(source, location) {
            const s = this.current;
            if (source === "color") return s.current.color;
            if (source === "secondaryColor") return s.current.secondaryColor;
            if (source === "normal") return s.current.normal;
            if (source === "fogCoord") return [s.current.fogCoord];
            const tex = /^texCoord(\d+)$/.exec(source);
            if (tex) return s.current.texCoord[Number(tex[1])] || null;
            if (source.indexOf("generic") === 0) {
                const index = Number(source.substring(7));
                return s.genericAttribs[index] ? s.genericAttribs[index].value : null;
            }
            if (location >= 0 && location < s.genericAttribs.length)
                return s.genericAttribs[location].value;
            return null;
        },

        /* Which attributes the current pipeline wants, and where each comes
         * from in the packed draw record. */
        wantedAttributes(program) {
            const ATTR = translator.COMPAT_ATTRIBUTE_LOCATIONS;
            if (program && program.link && program.compiled.vertex) {
                return program.link.reflection.attributes.map(a => ({
                    location: a.location,
                    components: a.components,
                    source: attributeSourceName(a.name, a.location),
                }));
            }
            const s = this.current;
            if (s.enabled.has(GL.VERTEX_PROGRAM_ARB)) {
                const arb = this.arbProgramFor(GL.VERTEX_PROGRAM_ARB);
                if (arb && arb.compiled && arb.compiled.ok) {
                    return arb.compiled.reflection.attributes.map(a => {
                        const source = attributeSourceName(a.name || a.field,
                            a.location);
                        // Only the ARB path carries an alias: GL defines the
                        // aliasing for vertex program mode, and a GLSL program
                        // names its own attributes.
                        return { location: a.location,
                                 components: a.components, source,
                                 alias: aliasedAttributeSource(source) };
                    });
                }
            }
            /* Derive the fixed-function input layout from the same signature
             * that generates VSIn. Warcraft keeps several client arrays
             * enabled across unlit UI passes; consulting those enables in the
             * shader but semantic state here made VSIn require location 2
             * while the vertex layout omitted it, invalidating the pipeline.
             * One signature is now authoritative for both sides. */
            const attributes = this.fixedFunctionSignature(
                this.currentVariant(), program?.compiled.fragment).attributes;
            const wanted = [{ location: ATTR.gl_Vertex, components: 4,
                              source: "vertex" }];
            if (attributes.color)
                wanted.push({ location: ATTR.gl_Color, components: 4,
                              source: "color" });
            if (attributes.normal)
                wanted.push({ location: ATTR.gl_Normal, components: 3,
                              source: "normal" });
            if (attributes.secondaryColor)
                wanted.push({ location: ATTR.gl_SecondaryColor, components: 4,
                              source: "secondaryColor" });
            if (attributes.fogCoord)
                wanted.push({ location: ATTR.gl_FogCoord, components: 1,
                              source: "fogCoord" });
            for (let unit = 0; unit < MAX_TEXTURE_COORDS; ++unit) {
                if (!attributes.texCoord[unit]) continue;
                wanted.push({ location: ATTR.gl_MultiTexCoord0 + unit,
                              components: attributes.texCoord[unit].components,
                              source: "texCoord" + unit });
            }
            return wanted;
        },

        /* ---- VBO-resident draws ---- */

        drawFromBuffers(mode, first, count, indexInfo) {
            if (count <= 0) return;
            const s = this.current;
            // wide indexed points gather, polygon modes read the vertices:
            // both from the CPU copy
            if ((indexInfo && mode === GL.POINTS && this.pointsExpand()) ||
                    (isPolygonPrimitive(mode) && !this.polygonsFill()))
                return this.drawFromShadowBuffers(mode, first, count, indexInfo,
                    this.wantedAttributes(this.currentProgramObject()));
            const program = this.currentProgramObject();
            const wanted = this.wantedAttributes(program);
            const buffers = [];
            const byBuffer = new Map();
            const constants = [];

            for (const entry of wanted) {
                const source = this.resolveAttributeSource(s.arrays, entry,
                    a => !!(a && a.enabled && a.buffer));
                const array = s.arrays && s.arrays[source];
                if (!array || !array.enabled || !array.buffer) {
                    const value = this.currentAttributeValue(source,
                        entry.location);
                    if (value) {
                        constants.push({ entry, value });
                        continue;
                    }
                    return this.drawFromShadowBuffers(mode, first, count,
                        indexInfo, wanted);
                }
                const buffer = this.arrayBufferObject(array);
                if (!buffer || !buffer.gpuBuffer) continue;
                const size = Math.max(1, array.size || entry.components);
                const normalized = this.arrayIsNormalized(source, array);
                const format = vertexFormatFor(array.type, size, normalized);
                const stride = array.stride ||
                    size * componentBytes(array.type);
                const shaderComponents = entry.components || size;
                const attributeBytes = size * componentBytes(array.type);
                /*
                 * GL widens a size-2/3 array to the four-component attribute
                 * consumed by an ARB program, supplying (0, 1) for the absent
                 * components. WebGPU vertex formats do not perform that GL
                 * conversion, and their attribute offset must describe one
                 * element inside arrayStride. Pack these legal GL layouts from
                 * the buffer's shadow copy instead of creating a mismatched or
                 * invalid WebGPU vertex layout. The glview 1.5 test uses vec3
                 * positions and vec2 texture coordinates with vec4 ARB inputs.
                 */
                if (!format || stride % 4 !== 0 || array.offset % 4 !== 0 ||
                        (s.enabled.has(GL.VERTEX_PROGRAM_ARB) &&
                            size !== shaderComponents) ||
                        array.offset >= stride ||
                        array.offset + attributeBytes > stride) {
                    const converted = this.convertVertexAttribute(buffer,
                        array, shaderComponents, normalized);
                    if (!converted)
                        return this.drawFromShadowBuffers(mode, first, count,
                            indexInfo, wanted);
                    buffers.push({ gpuBuffer: converted, baseOffset: 0,
                        stride: shaderComponents * 4, attributes: [{
                            location: entry.location, offset: 0,
                            format: "float32" + (shaderComponents > 1 ?
                                "x" + shaderComponents : ""),
                        }] });
                    continue;
                }
                let group = byBuffer.get(buffer.gpuBuffer);
                if (!group) {
                    group = { gpuBuffer: buffer.gpuBuffer, stride,
                              baseOffset: 0, attributes: [] };
                    byBuffer.set(buffer.gpuBuffer, group);
                    buffers.push(group);
                }
                if (group.stride !== stride) {
                    // Two arrays in one buffer with different strides need two
                    // bindings; WebGPU allows eight, which is enough in
                    // practice, and packing covers the rest.
                    const extra = { gpuBuffer: buffer.gpuBuffer, stride,
                                    baseOffset: 0, attributes: [] };
                    buffers.push(extra);
                    extra.attributes.push({ location: entry.location, format,
                                            offset: array.offset });
                    continue;
                }
                group.attributes.push({ location: entry.location, format,
                                        offset: array.offset });
            }

            if (constants.length) {
                let components = 0;
                for (const item of constants)
                    components += item.entry.components || item.value.length;
                const data = new Float32Array(components);
                const attributes = [];
                let at = 0;
                for (const item of constants) {
                    const count = item.entry.components || item.value.length;
                    for (let c = 0; c < count; ++c)
                        data[at + c] = c < item.value.length ? item.value[c] :
                            (c === 3 ? 1 : 0);
                    attributes.push({ location: item.entry.location,
                        format: "float32" + (count > 1 ? "x" + count : ""),
                        offset: at * 4 });
                    at += count;
                }
                const slice = this.uploadVertices(new Uint8Array(data.buffer));
                if (!slice) return;
                // a stride of zero repeats the one value for every vertex and
                // instance (review S2-19: an instance-step buffer advanced
                // per point once wide points made each point an instance)
                buffers.push({ gpuBuffer: slice.buffer,
                    baseOffset: slice.offset, stride: 0, attributes });
            }

            if (!buffers.length)
                return this.drawFromShadowBuffers(mode, first, count, indexInfo,
                    wanted);
            const maxBuffers = (this.limits && this.limits.maxVertexBuffers) || 8;
            if (buffers.length > maxBuffers)
                return this.drawFromShadowBuffers(mode, first, count, indexInfo,
                    wanted);

            let index = null;
            if (indexInfo) {
                const buffer = this.bufferFor(GL.ELEMENT_ARRAY_BUFFER);
                if (!buffer || !buffer.shadow)
                    return this.refuse("glDrawElements",
                        "no element array buffer is bound", {},
                        GL.INVALID_OPERATION);
                const elementBytes = indexInfo.type === GL.UNSIGNED_BYTE ? 1 :
                    (indexInfo.type === GL.UNSIGNED_SHORT ? 2 : 4);
                const data = buffer.shadow.subarray(indexInfo.bufferOffset,
                    indexInfo.bufferOffset + count * elementBytes);
                // Strips use WebGPU's fixed restart index, unlike legacy GL;
                // keep their widening/expansion path. Polygon line/point mode
                // also needs a CPU source index array to build its edges.
                const direct = (mode === GL.TRIANGLES || mode === GL.LINES ||
                    mode === GL.POINTS) && this.polygonsFill() &&
                    (indexInfo.type === GL.UNSIGNED_SHORT ||
                        indexInfo.type === GL.UNSIGNED_INT) &&
                    indexInfo.bufferOffset % elementBytes === 0 &&
                    data.byteLength === count * elementBytes && buffer.gpuBuffer;
                index = direct ? { buffer: buffer.gpuBuffer,
                    offset: indexInfo.bufferOffset, count,
                    format: elementBytes === 2 ? "uint16" : "uint32" } :
                    this.uploadIndices(mode, indexInfo.type, data, count);
                if (!index) return;
            }
            this.issueDraw({ mode, vertexCount: count, firstVertex: first,
                             buffers, index });
        },

        invalidateVertexConversions(buffer) {
            if (!buffer.convertedAttributes) return;
            for (const entry of buffer.convertedAttributes.values()) {
                this.convertedVertexCache.delete(entry);
                this.convertedVertexBytes -= entry.bytes;
                this.retire(entry.gpuBuffer);
            }
            buffer.convertedAttributes.clear();
        },

        convertVertexAttribute(buffer, array, components, normalized) {
            const elementBytes = componentBytes(array.type);
            const size = Math.max(1, array.size || components);
            const stride = array.stride || size * elementBytes;
            if (!elementBytes || !stride || !buffer.shadow) return null;
            const key = [array.type, size, stride, array.offset, components,
                normalized ? 1 : 0].join(":");
            const cache = buffer.convertedAttributes ||
                (buffer.convertedAttributes = new Map());
            let entry = cache.get(key);
            if (entry) return entry.gpuBuffer;
            const count = Math.max(0, 1 + Math.floor((buffer.shadow.byteLength -
                array.offset - size * elementBytes) / stride));
            const bytes = count * components * 4;
            // Bound resident conversion storage, including many layout variants.
            // Oversized objects use the compact per-draw packing path instead.
            const budget = 64 * 1024 * 1024;
            if (!bytes || bytes > budget) return null;
            // Do not evict here: another attribute of the current, not yet
            // encoded draw may already reference an entry. Fall back safely
            // when full; mutation/deletion/context teardown releases entries.
            if (this.convertedVertexBytes + bytes > budget ||
                    this.convertedVertexCache.size >= 256) return null;
            const values = new Float32Array(count * components);
            const view = new DataView(buffer.shadow.buffer,
                buffer.shadow.byteOffset, buffer.shadow.byteLength);
            for (let v = 0; v < count; ++v)
                for (let c = 0; c < components; ++c)
                    values[v * components + c] = c < size ?
                        readComponent(view, array.offset + v * stride +
                            c * elementBytes, array.type, normalized) :
                        (c === 3 ? 1 : 0);
            const gpuBuffer = this.createGPUBuffer({
                label: "GL converted attribute " + buffer.name, size: bytes,
                usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST,
            });
            this.device.queue.writeBuffer(gpuBuffer, 0, values.buffer, 0, bytes);
            entry = { gpuBuffer, bytes };
            cache.set(key, entry);
            this.convertedVertexCache.set(entry, true);
            this.convertedVertexBytes += bytes;
            return gpuBuffer;
        },

        /* The fallback when a VBO's layout is not something WebGPU can bind
         * directly: read it out of the shadow copy and pack, which is exactly
         * what the client-array path does. */
        drawFromShadowBuffers(mode, first, count, indexInfo, wanted) {
            const s = this.current;
            const arrays = Object.create(null);
            let arrayVertexCount = count;
            let indices = null;
            if (indexInfo) {
                const buffer = this.bufferFor(GL.ELEMENT_ARRAY_BUFFER);
                if (buffer && buffer.shadow) {
                    const elementBytes = indexInfo.type === GL.UNSIGNED_BYTE ? 1 :
                        (indexInfo.type === GL.UNSIGNED_SHORT ? 2 : 4);
                    indices = {
                        type: indexInfo.type,
                        data: buffer.shadow.subarray(indexInfo.bufferOffset,
                            indexInfo.bufferOffset + count * elementBytes),
                    };
                    const values = readIndices(indexInfo.type, indices.data, count);
                    indices.decoded = values;
                    arrayVertexCount = values.length ? maximumIndex(values) + 1 : 0;
                }
            }
            for (const entry of wanted) {
                const source = this.resolveAttributeSource(s.arrays, entry,
                    a => !!(a && a.enabled && a.buffer));
                const array = s.arrays && s.arrays[source];
                if (!array || !array.enabled) continue;
                const buffer = array.buffer ?
                    this.arrayBufferObject(array) : null;
                if (!buffer || !buffer.shadow) continue;
                const size = Math.max(1, array.size || entry.components);
                const stride = array.stride || size * componentBytes(array.type);
                const start = array.offset + first * stride;
                arrays[source] = {
                    enabled: true, size, type: array.type, stride,
                    normalized: array.normalized,
                    data: buffer.shadow.subarray(start,
                        Math.min(buffer.shadow.byteLength,
                            start + arrayVertexCount * stride)),
                };
            }
            this.drawPacked(mode, count, arrays, indices);
        },

        /* ---- ring uploads ---- */

        rotateUploadPage(kind) {
            const vertex = kind === "vertex";
            const key = vertex ? "vertexRing" : "uniformRing";
            // A draw may already own slices from this page but not yet be
            // encoded. Neither overwrite nor retire it in an intermediate
            // flush; keep it until the draw/command has been fully recorded.
            this.uploadPages.push(this[key]);
            this[key] = this.createGPUBuffer({
                label: vertex ? "GL vertex ring" : "GL uniform ring",
                size: vertex ? this.vertexCapacity : this.uniformCapacity,
                usage: BUFFER_USAGE_COPY_DST | (vertex ?
                    BUFFER_USAGE_VERTEX | BUFFER_USAGE_INDEX : BUFFER_USAGE_UNIFORM),
            });
            this[vertex ? "vertexCursor" : "uniformCursor"] = 0;
        },

        retireUploadPages() {
            if (!this.uploadPages.length) return false;
            for (const page of this.uploadPages) this.retire(page);
            this.uploadPages.length = 0;
            return true;
        },

        uploadVertices(bytes) {
            const size = alignUp(bytes.byteLength, 4);
            if (size > this.vertexCapacity) {
                this.refuse("draw", "vertex data exceeds the ring capacity",
                    { size, capacity: this.vertexCapacity }, GL.OUT_OF_MEMORY);
                return null;
            }
            if (this.vertexCursor + size > this.vertexCapacity)
                this.rotateUploadPage("vertex");
            const offset = this.vertexCursor;
            this.vertexStaging.set(bytes, offset);
            this.device.queue.writeBuffer(this.vertexRing, offset,
                this.vertexStaging, offset, size);
            this.vertexCursor = offset + size;
            return { buffer: this.vertexRing, offset, size };
        },

        /*
         * Index upload, including the expansion of the primitive modes WebGPU
         * does not have. The expanded index array for a given (mode, count) is
         * cached because a Half-Life frame issues thousands of GL_QUADS draws
         * whose index pattern depends on nothing but the vertex count.
         */
        // How the current state draws `mode` (drawShape)
        drawShape(mode) {
            return drawShape(mode, this.current.shadeModel === GL.FLAT);
        },

        uploadIndices(mode, type, data, count, decoded) {
            const source = decoded || readIndices(type, data, count);
            let indices;
            if (this.drawShape(mode).expand) {
                indices = expandIndexArray(mode, source, this.current.shadeModel === GL.FLAT);
                ++this.stats.expandedIndices;
            } else {
                indices = source;
            }
            if (!indices.length) return null;
            const bytes = new Uint8Array(indices.buffer, indices.byteOffset,
                indices.byteLength);
            const slice = this.uploadVertices(bytes);
            if (!slice) return null;
            return { buffer: slice.buffer, offset: slice.offset, count: indices.length,
                     format: "uint32", cpu: indices, source };
        },

        /* Draw with no index buffer still needs one when the mode expands. */
        expansionIndices(mode, count) {
            const flat = this.current.shadeModel === GL.FLAT;
            const key = mode + ":" + count + (flat ? ":flat" : "");
            let cached = this.indexExpansionCache.get(key);
            if (!cached) {
                cached = expandIndices(mode, count, 0, flat);
                if (this.indexExpansionCache.size > 4096)
                    this.indexExpansionCache.clear();
                this.indexExpansionCache.set(key, cached);
            }
            return cached;
        },
    });

    /*
     * ARB_vertex_program section 2.14.3 aliases the conventional vertex
     * attributes onto generic slots 0-5 and 8-15: glVertexPointer's array and
     * glVertexAttribPointerARB(0, ...) name the same attribute, and a program
     * may spell it either way. The guest sends whichever the application used,
     * so an attribute has to accept its alias -- otherwise a program written
     * against vertex.position and fed generic attribute 0 read the generic
     * attribute's (0, 0, 0, 1) default for every vertex and drew nothing, with
     * no GL error to say why.
     */
    const GENERIC_ATTRIB_ALIAS = {
        vertex: 0, weight: 1, normal: 2, color: 3,
        secondaryColor: 4, fogCoord: 5,
    };
    for (let unit = 0; unit < MAX_TEXTURE_COORDS; ++unit)
        GENERIC_ATTRIB_ALIAS["texCoord" + unit] = 8 + unit;

    const CONVENTIONAL_ATTRIB_ALIAS = {};
    for (const name of Object.keys(GENERIC_ATTRIB_ALIAS))
        CONVENTIONAL_ATTRIB_ALIAS["generic" + GENERIC_ATTRIB_ALIAS[name]] = name;

    function aliasedAttributeSource(source) {
        if (source.indexOf("generic") === 0)
            return CONVENTIONAL_ATTRIB_ALIAS[source] || null;
        const index = GENERIC_ATTRIB_ALIAS[source];
        return index === undefined ? null : "generic" + index;
    }

    function attributeSourceName(name, location) {
        const ATTR_SOURCES = {
            gl_Vertex: "vertex", gl_Normal: "normal", gl_Color: "color",
            gl_SecondaryColor: "secondaryColor", gl_FogCoord: "fogCoord",
        };
        if (ATTR_SOURCES[name]) return ATTR_SOURCES[name];
        const texMatch = /^gl_MultiTexCoord(\d)$/.exec(name);
        if (texMatch) return "texCoord" + texMatch[1];
        // Generic arrays are selected by attribute index, not by the spelling
        // of the shader variable. glBindAttribLocation may assign any user name
        // to a location, while the guest record necessarily carries that index.
        return "generic" + location;
    }

    function vertexFormatFor(type, size, normalized) {
        if (normalized) {
            const table = DIRECT_NORMALIZED_FORMATS[type];
            return table ? table[size] || null : null;
        }
        const table = DIRECT_VERTEX_FORMATS[type];
        return table ? table[size] || null : null;
    }

    function readIndices(type, data, count) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const out = new Uint32Array(count);
        for (let i = 0; i < count; ++i) {
            switch (type) {
            case GL.UNSIGNED_BYTE:
                if (i < data.byteLength) out[i] = view.getUint8(i);
                break;
            case GL.UNSIGNED_SHORT:
                if (i * 2 + 2 <= data.byteLength) out[i] = view.getUint16(i * 2, true);
                break;
            default:
                if (i * 4 + 4 <= data.byteLength) out[i] = view.getUint32(i * 4, true);
                break;
            }
        }
        return out;
    }

    function maximumIndex(indices) {
        let maximum = 0;
        for (let i = 0; i < indices.length; ++i)
            if (indices[i] > maximum) maximum = indices[i];
        return maximum;
    }

    /* ================================================================== */
    /* Executor: pipeline state and the draw itself                       */
    /* ================================================================== */

    Object.assign(GLWebGPUExecutor.prototype, {

        /*
         * GL's front-face convention is inverted here and nowhere else.
         *
         * The vertex shader negates clip-space Y so that framebuffer row 0 is
         * GL's bottom row (plan 4.3); that flip reverses the winding of every
         * triangle, so GL_CCW has to be reported to WebGPU as "cw". Keeping
         * this in one function is deliberate: a second place that flips winding
         * would cancel this one out somewhere and nowhere else.
         */
        gpuFrontFace(state) {
            return state.frontFace === GL.CCW ? "cw" : "ccw";
        },

        gpuCullMode(state) {
            if (!state.enabled.has(GL.CULL_FACE)) return "none";
            if (state.cullFace === GL.FRONT_AND_BACK) return "none";  // see below
            return state.cullFace === GL.FRONT ? "front" : "back";
        },

        /* The set of render targets a draw writes, resolved from the bound
         * framebuffer. */
        currentTargets() {
            const s = this.current;
            if (!s.drawFramebuffer) {
                const view = this.ensureBackBuffer();
                const samples = this.windowSamples();
                const multisampled = samples > 1 ? this.ensureMultisampleTarget(samples) : null;
                // glDrawBuffer(GL_NONE) writes no colour (review S2-28)
                const none = s.drawBuffers.every(buffer => buffer === GL.NONE);
                return {
                    // (readView, texture: the resolved picture, for reads and copies)
                    color: [none ? null : { view: multisampled || view,
                              resolveTarget: multisampled ? view : undefined, readView: view,
                              format: this.backBufferFormat,
                              texture: this.backBuffer, mipLevel: 0,
                              origin: { x: 0, y: 0, z: 0 } }],
                    depth: this.ensureDepthTarget(samples),
                    depthFormat: "depth24plus-stencil8",
                    width: this.backBufferWidth, height: this.backBufferHeight,
                    sampleCount: samples,
                    isDefault: true,
                };
            }
            const fbo = this.boundFramebufferObject(GL.DRAW_FRAMEBUFFER);
            if (!fbo) return null;
            const color = [];
            for (const buffer of s.drawBuffers) {
                if (buffer === GL.NONE) { color.push(null); continue; }
                const index = buffer >= GL.COLOR_ATTACHMENT0 ?
                    buffer - GL.COLOR_ATTACHMENT0 : 0;
                const attachment = fbo.color[index];
                if (!attachment) { color.push(null); continue; }
                const resolved = this.resolveAttachment(attachment);
                color.push(resolved);
            }
            if (!color.length) color.push(null);
            // WebGPU exposes depth and stencil as one render-pass attachment.
            // A stencil-only FBO therefore still needs to supply that view.
            const depthRecord = fbo.depth || fbo.stencil;
            const depth = depthRecord ? this.resolveAttachment(depthRecord) : null;
            return {
                color,
                depth: depth ? depth.view : null,
                depthFormat: depth ? depth.format : null,
                width: fbo.width, height: fbo.height,
                isDefault: false,
            };
        },

        resolveAttachment(attachment) {
            if (attachment.kind === "texture") {
                const texture = this.imageFor(attachment);
                if (!texture) return null;
                const gpuTexture = this.ensureTextureUploaded(texture);
                if (!gpuTexture) return null;
                // what is drawn into it is the level's content from now on
                const slot = this.levelSlot(texture, texture.kind, attachment.level,
                    texture.kind === "Cube" ? attachment.layer : 0);
                if (slot && !slot.compressed) slot.pixels = null;
                texture.depthGeneration = (texture.depthGeneration || 0) + 1;
                return {
                    view: this.attachmentView(texture, gpuTexture, attachment.level, attachment.layer),
                    format: texture.gpuFormat,
                    texture: gpuTexture,
                    mipLevel: attachment.level,
                    origin: { x: 0, y: 0, z: attachment.layer },
                };
            }
            const rb = this.imageFor(attachment);
            if (!rb || !rb.gpuTexture) return null;
            return { view: this.attachmentView(rb, rb.gpuTexture, 0, 0), format: rb.gpuFormat,
                     texture: rb.gpuTexture, mipLevel: 0,
                     origin: { x: 0, y: 0, z: 0 } };
        },

        attachmentView(image, texture, level, layer) {
            const cache = image.viewCache || (image.viewCache = new Map());
            const key = "attachment:" + this.resourceId(texture) + ":" + level + ":" + layer;
            let view = cache.get(key);
            if (!view) {
                view = texture.createView({ dimension: "2d", baseMipLevel: level,
                    mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
                cache.set(key, view);
            }
            return view;
        },

        ensureBackBuffer() {
            const width = Math.max(1, this.backBufferWidth);
            const height = Math.max(1, this.backBufferHeight);
            if (this.backBuffer && this.backBufferView) return this.backBufferView;
            this.retire(this.backBuffer);
            this.backBufferFormat = (this.host && this.host.format) || "bgra8unorm";
            this.backBuffer = this.createGPUTexture({
                label: "GL back buffer",
                size: { width, height, depthOrArrayLayers: 1 },
                format: this.backBufferFormat,
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC |
                    TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
            });
            this.backBufferView = this.backBuffer.createView();
            return this.backBufferView;
        },

        ensureDepthTarget(samples = 1) {
            const width = Math.max(1, this.backBufferWidth);
            const height = Math.max(1, this.backBufferHeight);
            if (this.depthTarget && this.depthWidth === width &&
                    this.depthHeight === height && this.depthSamples === samples)
                return this.depthTargetView;
            this.retire(this.depthTarget);
            this.depthTarget = this.createGPUTexture({
                label: "GL depth-stencil",
                size: { width, height, depthOrArrayLayers: 1 },
                format: "depth24plus-stencil8",
                sampleCount: samples,
                // (read back by glReadPixels: stencil copied, depth sampled)
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT | (samples > 1 ? 0 : TEXTURE_USAGE_COPY_SRC) |
                    TEXTURE_USAGE_TEXTURE_BINDING,
            });
            this.depthTargetView = this.depthTarget.createView();
            this.depthWidth = width;
            this.depthHeight = height;
            this.depthSamples = samples;
            return this.depthTargetView;
        },

        /*
         * A multisampled window (its pixel format, WGL_ARB_multisample;
         * review D-06) draws into this and resolves into the back buffer at
         * the end of every pass, so presenting, reading and copying keep
         * using the back buffer. 4 is the count WebGPU guarantees.
         */
        windowSamples() {
            return this.current && this.current.samples > 1 ? 4 : 1;
        },

        ensureMultisampleTarget(samples) {
            const width = Math.max(1, this.backBufferWidth);
            const height = Math.max(1, this.backBufferHeight);
            if (this.multisampleTarget && this.multisampleWidth === width &&
                    this.multisampleHeight === height && this.multisampleFormat === this.backBufferFormat)
                return this.multisampleView;
            this.retire(this.multisampleTarget);
            this.multisampleTarget = this.createGPUTexture({
                label: "GL multisampled colour",
                size: { width, height, depthOrArrayLayers: 1 },
                format: this.backBufferFormat, sampleCount: samples,
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_TEXTURE_BINDING,
            });
            this.multisampleView = this.multisampleTarget.createView();
            this.multisampleWidth = width;
            this.multisampleHeight = height;
            this.multisampleFormat = this.backBufferFormat;
            return this.multisampleView;
        },

        /* ---- render pass management ----
         *
         * The pass is opened lazily so that a glClear arriving before the first
         * draw becomes a loadOp instead of a full-screen quad. That is the
         * shape of almost every GL frame, so the common case costs nothing.
         */
        ensureEncoder() {
            if (!this.encoder)
                this.encoder = this.device.createCommandEncoder({ label: "GL frame" });
            return this.encoder;
        },

        ensurePass() {
            if (this.activeQuery && this.activeQuery.slot < 0 &&
                    this.nextQuerySlot >= this.occlusionCapacity)
                this.flushFrame();
            const targets = this.currentTargets();
            if (!targets) { this.endPass(); return null; }
            const reference = object => object ? this.targetKeys.reference(object) : 0;
            if (this.targetKeys.buckets && this.targetKeys.buckets.size > 4096) {
                this.endPass(); this.targetKeys.clearKeys();
            }
            const targetKey = this.targetKeys.key([reference(this.current),
                targets.color.map(target => target ? [reference(target.view), reference(target.resolveTarget)] : null),
                reference(targets.depth), targets.width, targets.height, targets.sampleCount || 1,
                reference(this.activeOcclusionQuerySet)]);
            if (this.pass && this.passTargetKey === targetKey) {
                this.beginOcclusionSegment();
                return this.pass;
            }
            this.endPass();
            // drawing into the front buffer shows at the next glFlush (D-08)
            if (targets.isDefault && this.current.drawBuffers.some(b => FRONT_BUFFERS.has(b)))
                this.frontDrawn = true;
            const encoder = this.ensureEncoder();
            const colorAttachments = targets.color.map(target => target ? {
                view: target.view,
                ...(target.resolveTarget ? { resolveTarget: target.resolveTarget } : {}),
                loadOp: this.pendingClear && this.pendingClear.color ?
                    "clear" : "load",
                clearValue: this.pendingClear && this.pendingClear.color ?
                    this.pendingClear.color : undefined,
                storeOp: "store",
            } : null);
            const descriptor = {
                label: "GL pass",
                colorAttachments,
            };
            if (targets.depth) {
                descriptor.depthStencilAttachment = {
                    view: targets.depth,
                    depthLoadOp: this.pendingClear && this.pendingClear.depth !== undefined ?
                        "clear" : "load",
                    depthClearValue: this.pendingClear && this.pendingClear.depth !== undefined ?
                        this.pendingClear.depth : undefined,
                    depthStoreOp: "store",
                    // WebGPU requires stencil operations to be absent when the
                    // attachment format has no stencil aspect.  Cube 2 uses a
                    // depth24 renderbuffer while generating environment maps;
                    // unconditionally adding these fields invalidates the
                    // complete command encoder at finish().
                    ...(formatHasStencil(targets.depthFormat) ? {
                        stencilLoadOp: this.pendingClear &&
                            this.pendingClear.stencil !== undefined ?
                            "clear" : "load",
                        stencilClearValue: this.pendingClear &&
                            this.pendingClear.stencil !== undefined ?
                            this.pendingClear.stencil : undefined,
                        stencilStoreOp: "store",
                    } : {}),
                };
            }
            if (this.activeOcclusionQuerySet)
                descriptor.occlusionQuerySet = this.activeOcclusionQuerySet;
            // A pass can only run occlusion queries if it was *created* with
            // the query set, so beginQuery has to know whether this one was.
            this.passHasOcclusionQuerySet = !!this.activeOcclusionQuerySet;
            this.pass = encoder.beginRenderPass(descriptor);
            this.passTargets = targets;
            this.passTargetKey = targetKey;
            this.pendingClear = null;
            this.passStateApplied = false;
            this.beginOcclusionSegment();
            return this.pass;
        },

        endPass() {
            if (this.pass) {
                this.endOcclusionSegment();
                this.pass.end();
                this.pass = null;
                this.passTargets = null;
                this.passTargetKey = 0;
                this.passHasOcclusionQuerySet = false;
            }
        },

        flushFrame() {
            this.endPass();
            // finishFrame may rewind the rings after this submission.
            this.uniformValueCache.clear();
            this.bindGroupCache.clear();
            const resolved = this.resolvePendingQueries();
            let frameValid = Promise.resolve(true);
            if (this.encoder) {
                // Encoding errors surface at finish(): a frame WebGPU refuses
                // is reported, and its occlusion results are not believed
                this.device.pushErrorScope("validation");
                try {
                    this.device.queue.submit([this.encoder.finish()]);
                } finally {
                    frameValid = this.device.popErrorScope().then(error => {
                        if (error) {
                            ++this.stats.framesRejected;
                            this.gpuErrors.report("frame", error);
                        }
                        return !error;
                    }, () => false);
                }
                this.encoder = null;
                this.recordedOps = 0;
                this.pendingVertexBuffers = new WeakSet();
                this.releaseRetired();
            }
            if (resolved) this.readQueryResults(resolved, frameValid);
        },

        /*
         * Occlusion results only exist after the GPU has run the pass, so they
         * follow glReadPixels' shape: resolve into a buffer alongside the work
         * that produced them, then map it once the submission lands. Until the
         * map completes glGetQueryObjectuiv keeps answering NOT AVAILABLE,
         * which is what the guest's own spin on GL_QUERY_RESULT_AVAILABLE is
         * waiting for -- so a query that is never resolved is not a stale
         * number, it is a guest that spins forever.
         *
         * Every query outstanding at the flush resolves in one pair of buffers.
         * Cube 2 retires two thousand of them at a time, and one resolve of
         * slots [0, high] costs the same as one of slot 3.
         */
        resolvePendingQueries() {
            const pending = this.pendingQueries;
            if (!pending || !pending.length || !this.activeOcclusionQuerySet)
                return null;
            this.pendingQueries = [];
            let high = 0;
            for (const record of pending)
                if (record.slot >= 0 && record.slot + 1 > high)
                    high = record.slot + 1;
            if (!high) return null;
            // resolveQuerySet writes a u64 per slot; a mapped buffer cannot
            // also be a resolve target, hence the copy into staging.
            const byteLength = alignUp(high * 8, 256);
            const resolveBuffer = this.createGPUBuffer({
                label: "GL occlusion resolve",
                size: byteLength,
                usage: BUFFER_USAGE_QUERY_RESOLVE | BUFFER_USAGE_COPY_SRC,
            });
            const staging = this.createGPUBuffer({
                label: "GL occlusion readback",
                size: byteLength,
                usage: BUFFER_USAGE_COPY_DST | BUFFER_USAGE_MAP_READ,
            });
            const encoder = this.ensureEncoder();
            encoder.resolveQuerySet(this.activeOcclusionQuerySet, 0, high,
                resolveBuffer, 0);
            encoder.copyBufferToBuffer(resolveBuffer, 0, staging, 0, byteLength);
            // The slots are free again for the next frame's queries; the
            // results are already on their way out of the set.
            this.nextQuerySlot = 0;
            return { queries: pending, resolveBuffer, staging, count: high };
        },

        readQueryResults(resolved, frameValid) {
            const { queries, resolveBuffer, staging } = resolved;
            const mapped = Promise.all([staging.mapAsync(1 /* GPUMapMode.READ */), frameValid]);
            this.trackReadback(this.awaitReadback(mapped, "occlusion query", () => staging.destroy()).then(([, valid]) => {
                const words = new Uint32Array(staging.getMappedRange().slice(0));
                staging.unmap();
                if (!valid) throw new Error("WebGPU rejected the frame");
                for (const record of queries) {
                    const { query, slot, generation } = record;
                    // Query names are deliberately recycled every couple of
                    // frames by Cube 2. Mapping is asynchronous, so an older
                    // readback may finish after the same object has started a
                    // newer query. Never publish that stale generation into
                    // the new one (which can otherwise cull visible geometry).
                    if (query.generation !== generation) continue;
                    const low = words[slot * 2];
                    const high = words[slot * 2 + 1];
                    // D-07: WebGPU answers "did any sample pass", not how many.
                    // A visible query reports a saturated count rather than 1,
                    // because callers threshold on it far more often than they
                    // compare it to an expected sample total.
                    const visible = !!(low || high);
                    this.completeOcclusionSegment(record,
                        visible ? OCCLUSION_VISIBLE_SAMPLES : 0);
                }
            }).catch(error => {
                this.warnOnce("occlusion", "occlusion query readback failed",
                    { message: String(error) });
                // Never leave the guest spinning on AVAILABLE for a result the
                // GPU will not deliver.  A failed readback contains no evidence
                // of occlusion, so the only rendering-safe fallback is visible.
                for (const record of queries) {
                    const { query, generation } = record;
                    if (query.generation !== generation) continue;
                    this.completeOcclusionSegment(record, OCCLUSION_VISIBLE_SAMPLES);
                }
            }).then(() => {
                try { staging.destroy(); } catch (ignored) { /* already gone */ }
                try { resolveBuffer.destroy(); } catch (ignored) { /* gone */ }
            }));
        },

        finishFrame(present) {
            this.endPass();
            if (present) this.presentToCanvas();
            this.flushFrame();
            this.vertexCursor = 0;
            this.uniformCursor = 0;
        },

        /*
         * glClear. An unrestricted clear becomes the next pass's load
         * operation. Scissor and write masks cannot be represented by loadOp,
         * so those cases use a full-screen triangle with exact colour, depth
         * and stencil write masks.
         */
        clearBuffers(mask) {
            const s = this.current;
            const gpuMask = mask & (GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT |
                GL.STENCIL_BUFFER_BIT);
            const maskedColor = !!(mask & GL.COLOR_BUFFER_BIT) &&
                s.colorMask.some(value => !value);
            const maskedDepth = !!(mask & GL.DEPTH_BUFFER_BIT) && !s.depthMask;
            const maskedStencil = !!(mask & GL.STENCIL_BUFFER_BIT) &&
                (s.stencil.front.writeMask >>> 0) !== 0xffffffff;
            if (gpuMask && ((s.enabled.has(GL.SCISSOR_TEST) && s.scissor.set) ||
                    maskedColor || maskedDepth || maskedStencil)) {
                if (mask & GL.ACCUM_BUFFER_BIT) this.clearAccumBuffer();
                this.clearBuffersWithDraw(gpuMask);
                return;
            }
            const pending = this.pendingClear || {};
            if (mask & GL.COLOR_BUFFER_BIT) {
                pending.color = {
                    r: s.clearColor[0], g: s.clearColor[1],
                    b: s.clearColor[2], a: s.clearColor[3],
                };
            }
            if (mask & GL.DEPTH_BUFFER_BIT) pending.depth = s.clearDepth;
            if (mask & GL.STENCIL_BUFFER_BIT) pending.stencil = s.clearStencil;
            if (mask & GL.ACCUM_BUFFER_BIT) this.clearAccumBuffer();
            if (!(mask & (GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT |
                    GL.STENCIL_BUFFER_BIT)))
                return;
            this.endPass();
            this.pendingClear = pending;
            // Opening the pass immediately makes the clear happen even if no
            // draw follows, which is what a frame that only clears expects.
            this.ensurePass();
        },

        clearBuffersWithDraw(mask) {
            const s = this.current;
            this.endPass();
            const targets = this.currentTargets();
            if (!targets) return;
            const clearColor = !!(mask & GL.COLOR_BUFFER_BIT);
            const clearDepth = !!(mask & GL.DEPTH_BUFFER_BIT) && s.depthMask &&
                !!targets.depth;
            const clearStencil = !!(mask & GL.STENCIL_BUFFER_BIT) &&
                (s.stencil.front.writeMask >>> 0) !== 0 && !!targets.depth &&
                targets.depthFormat && targets.depthFormat.indexOf("stencil") >= 0;
            if (!clearColor && !clearDepth && !clearStencil) return;
            const pipeline = this.clearPipeline(targets, clearColor, clearDepth,
                clearStencil);
            if (!pipeline) return;
            const pass = this.ensureEncoder().beginRenderPass({
                label: "GL masked/scissored clear",
                colorAttachments: targets.color.map(target => target ? {
                    view: target.view, loadOp: "load", storeOp: "store",
                    ...(target.resolveTarget ? { resolveTarget: target.resolveTarget } : {}),
                } : null),
                ...(targets.depth ? { depthStencilAttachment: {
                    view: targets.depth,
                    depthLoadOp: "load", depthStoreOp: "store",
                    ...(formatHasStencil(targets.depthFormat) ? {
                        stencilLoadOp: "load", stencilStoreOp: "store",
                    } : {}),
                } } : {}),
            });
            this.applyAccumScissor(pass, targets);
            if (clearStencil) pass.setStencilReference(s.clearStencil >>> 0);
            pass.setPipeline(pipeline);
            pass.draw(3, 1, 0, 0);
            pass.end();
        },

        clearPipeline(targets, clearColor, clearDepth, clearStencil) {
            const s = this.current;
            this.clearPipelineCache = this.clearPipelineCache || new Map();
            const colorFields = clearColor ? targets.color.map((target, i) =>
                target ? "    @location(" + i + ") color" + i +
                    " : vec4<f32>," : "").join("\n") : "";
            const depthField = clearDepth ?
                "    @builtin(frag_depth) depth : f32," : "";
            const colorWrites = clearColor ? targets.color.map((target, i) =>
                target ? "    out.color" + i + " = vec4<f32>(" +
                    Array.from(s.clearColor).map(v => Number(v).toPrecision(9))
                        .join(", ") + ");" : "").join("\n") : "";
            const depthWrite = clearDepth ? "    out.depth = " +
                Number(s.clearDepth).toPrecision(9) + ";" : "";
            const fragmentCode = colorFields || depthField ? `
struct ClearOut {
${colorFields}
${depthField}
}
@fragment fn fs_main() -> ClearOut {
    var out : ClearOut;
${colorWrites}
${depthWrite}
    return out;
}` : "@fragment fn fs_main() {}";
            const code = `
@vertex fn vs_main(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}
${fragmentCode}`;
            const module = this.shaderModule(code);
            const descriptor = {
                label: "GL clear pipeline",
                layout: "auto",
                vertex: { module, entryPoint: "vs_main" },
                fragment: { module, entryPoint: "fs_main",
                    targets: targets.color.map(target => target ? {
                        format: target.format,
                        writeMask: clearColor ?
                            (s.colorMask[0] ? 1 : 0) |
                            (s.colorMask[1] ? 2 : 0) |
                            (s.colorMask[2] ? 4 : 0) |
                            (s.colorMask[3] ? 8 : 0) : 0,
                    } : null) },
                primitive: { topology: "triangle-list" },
                multisample: { count: targets.sampleCount || 1 },
            };
            if (targets.depthFormat) {
                descriptor.depthStencil = {
                    format: targets.depthFormat,
                    depthWriteEnabled: clearDepth,
                    depthCompare: "always",
                    ...(clearStencil ? {
                        stencilFront: { compare: "always", failOp: "keep",
                            depthFailOp: "keep", passOp: "replace" },
                        stencilBack: { compare: "always", failOp: "keep",
                            depthFailOp: "keep", passOp: "replace" },
                        stencilReadMask: 0xffffffff,
                        stencilWriteMask: s.stencil.front.writeMask >>> 0,
                    } : {}),
                };
            }
            const key = this.renderPipelineKey(this.clearPipelineCache, descriptor);
            const pipeline = this.clearPipelineCache.get(key);
            return pipeline || this.createPipeline(this.clearPipelineCache, key, descriptor);
        },

        clearAccumBuffer() {
            this.endPass();
            const targets = this.currentTargets();
            if (!targets) return;
            const accum = this.ensureAccumBuffer(targets);
            const scissored = this.current.enabled.has(GL.SCISSOR_TEST) &&
                this.current.scissor.set;
            const pass = this.ensureEncoder().beginRenderPass({
                label: "GL accumulation clear",
                colorAttachments: [{
                    view: accum.currentView,
                    loadOp: scissored ? "load" : "clear",
                    clearValue: {
                        r: this.current.clearAccum[0],
                        g: this.current.clearAccum[1],
                        b: this.current.clearAccum[2],
                        a: this.current.clearAccum[3],
                    },
                    storeOp: "store",
                }],
            });
            this.applyAccumScissor(pass, targets);
            if (scissored) {
                const pipeline = this.accumClearPipeline();
                if (pipeline) {
                    pass.setPipeline(pipeline);
                    pass.draw(3, 1, 0, 0);
                }
            }
            pass.end();
        },

        /* ---- the draw ---- */

        /*
         * request: { mode, vertexCount, firstVertex, buffers, index } and,
         * from the immediate and client-array paths, `cpu`: the vertex data
         * the buffer was uploaded from ({ data, stride, count, layout,
         * edgeFlags }, in floats), which glPolygonMode needs.
         */
        issueDraw(request) {
            const s = this.current;
            if (s.renderMode !== GL.RENDER) return;   // GL_SELECT/GL_FEEDBACK
            const polygons = isPolygonPrimitive(request.mode);
            // culling is for polygons; lines and points are drawn
            if (polygons && s.enabled.has(GL.CULL_FACE) && s.cullFace === GL.FRONT_AND_BACK)
                return;
            if (polygons && !request.rasterized && !this.polygonsFill())
                return this.drawPolygonModes(request);
            if (isLinePrimitive(request.mode) && !request.linesExpanded &&
                    (s.lineWidth >= 1.5 || s.enabled.has(GL.LINE_STIPPLE)))
                return this.drawLines(request);
            if (polygons && !request.stencilFace && !request.linesExpanded &&
                    s.enabled.has(GL.STENCIL_TEST) && stencilMasksDiverge(s))
                return this.drawStencilFaces(request);
            let index = request.index;
            this.drawFace = request.face || null;
            let expandedPoints = request.mode === GL.POINTS && this.pointsExpand();
            if (expandedPoints && index) {
                // the draw paths gather wide indexed points; a corner buffer
                // cannot step under an index
                this.warnOnce("indexed-wide-points", "indexed points are drawn one pixel wide", {});
                expandedPoints = false;
            }
            this.drawingExpandedPoints = expandedPoints;
            const shaders = this.resolveShaders();
            if (!shaders) return;
            if (s.enabled.has(GL.COLOR_LOGIC_OP) && s.logicOp !== GL.COPY &&
                    !this.prepareLogicOpTargets()) return;
            if (!this.ensurePass()) {
                this.refuse("draw", "no render target is bound", {},
                    GL.INVALID_FRAMEBUFFER_OPERATION);
                return;
            }

            /* WebGPU only rasterises one-pixel points. GL point size and point
             * sprites are implemented as an instanced six-vertex quad: the
             * application's attributes advance once per point, while this
             * extra corner attribute advances for the six quad vertices. */
            if (expandedPoints) {
                const corners = new Float32Array([
                    -1, -1,  1, -1, -1,  1,
                    -1,  1,  1, -1,  1,  1,
                ]);
                const cornerSlice = this.uploadVertices(
                    new Uint8Array(corners.buffer));
                if (!cornerSlice) return;
                request = {
                    ...request,
                    expandedPoints: true,
                    buffers: request.buffers.map(buffer => ({
                        ...buffer,
                        stepMode: "instance",
                    })).concat([{
                        gpuBuffer: cornerSlice.buffer,
                        baseOffset: cornerSlice.offset,
                        stride: 8,
                        stepMode: "vertex",
                        attributes: [{
                            location: translator.POINT_CORNER_LOCATION,
                            format: "float32x2",
                            offset: 0,
                        }],
                    }]),
                };
            }

            if (!index && this.drawShape(request.mode).expand) {
                const expanded = this.expansionIndices(request.mode,
                    request.vertexCount);
                if (!expanded.length) return;
                const slice = this.uploadVertices(new Uint8Array(expanded.buffer,
                    expanded.byteOffset, expanded.byteLength));
                if (!slice) return;
                index = { buffer: slice.buffer, offset: slice.offset,
                          count: expanded.length,
                          format: "uint32", cpu: expanded };
            }

            const pipeline = this.ensurePipeline(shaders, request, index);
            if (!pipeline) return;
            const bindGroups = this.buildBindGroups(pipeline, shaders);
            if (!bindGroups) return;

            // Texture preparation may have split the pass. Always bind to
            // the current pass after all uploads and resource preparation.
            const pass = this.ensurePass();
            if (!pass) return;
            pass.setPipeline(pipeline);
            this.applyPassState(pass, request.stencilFace || (request.face && request.face.back ? "back" : "front"));
            for (const entry of bindGroups)
                pass.setBindGroup(entry.index, entry.group);
            request.buffers.forEach((buffer, i) => {
                pass.setVertexBuffer(i, buffer.gpuBuffer, buffer.baseOffset);
                this.pendingVertexBuffers.add(buffer.gpuBuffer);
            });
            if (index) {
                pass.setIndexBuffer(index.buffer, index.format, index.offset);
                this.pendingVertexBuffers.add(index.buffer);
                pass.drawIndexed(index.count, 1, 0, request.firstVertex || 0, 0);
            } else if (expandedPoints) {
                pass.draw(6, request.vertexCount, 0, request.firstVertex || 0);
            } else {
                pass.draw(request.vertexCount, 1, request.firstVertex || 0, 0);
            }
            ++this.stats.draws;
            ++this.recordedOps;
            if (this.retireUploadPages() || this.recordedOps >= this.flushThreshold) {
                // A frame's draw count is unbounded; flushing keeps both the
                // command buffer and the ring allocations proportional to work
                // done rather than to the frame's length.
                this.endPass();
                this.flushFrame();
            }
        },

        applyPassState(pass, stencilFace = "front") {
            const s = this.current;
            const targets = this.passTargets;
            const width = targets ? targets.width : this.backBufferWidth;
            const height = targets ? targets.height : this.backBufferHeight;
            // GL's viewport as it is: WebGPU lets one extend past the target
            // (within twice the largest texture size; the target clips the
            // fragments), so a viewport partly outside the window keeps its
            // scale (review S2-7: it was clamped into the target, squashing
            // the picture)
            const vp = s.viewport;
            const limit = (this.limits && this.limits.maxTextureDimension2D) || 8192;
            const vw = clamp(vp.width, 0, limit), vh = clamp(vp.height, 0, limit);
            const x = clamp(vp.x, -2 * limit, 2 * limit - 1 - vw);
            const y = clamp(vp.y, -2 * limit, 2 * limit - 1 - vh);
            // (a reversed range is the pipeline's flipped variant, flipDepth)
            pass.setViewport(x, y, vw, vh,
                Math.min(s.depthRange.near, s.depthRange.far),
                Math.max(s.depthRange.near, s.depthRange.far));
            if (s.enabled.has(GL.SCISSOR_TEST) && s.scissor.set) {
                const sx = clamp(s.scissor.x, 0, width);
                const sy = clamp(s.scissor.y, 0, height);
                pass.setScissorRect(sx, sy,
                    Math.max(0, Math.min(s.scissor.width, width - sx)),
                    Math.max(0, Math.min(s.scissor.height, height - sy)));
            } else {
                pass.setScissorRect(0, 0, width, height);
            }
            if (s.enabled.has(GL.STENCIL_TEST))
                pass.setStencilReference(clamp(s.stencil[stencilFace].ref, 0,
                    this.passTargets && formatHasStencil(this.passTargets.depthFormat) ? 255 : 0));
            if (s.enabled.has(GL.BLEND))
                pass.setBlendConstant(this.blendConstant(s.blend));
        },

        // The one constant WebGPU blends with: a colour factor of
        // CONSTANT_ALPHA reads its RGB, so that is the alpha then (review
        // S2-8). An alpha factor reads its alpha either way.
        blendConstant(blend) {
            const [r, g, b, a] = blend.color;
            const rgb = [blend.srcRGB, blend.dstRGB];
            const usesAlpha = rgb.some(f => f === GL.CONSTANT_ALPHA || f === GL.ONE_MINUS_CONSTANT_ALPHA);
            const usesColor = rgb.some(f => f === GL.CONSTANT_COLOR || f === GL.ONE_MINUS_CONSTANT_COLOR);
            if (usesAlpha && usesColor)
                this.warnOnce("blend-constant", "the colour blend factors use both CONSTANT_COLOR and " +
                    "CONSTANT_ALPHA; WebGPU has one constant, CONSTANT_ALPHA reads its RGB", { rgb });
            return usesAlpha && !usesColor ? { r: a, g: a, b: a, a } : { r, g, b, a };
        },

        prepareLogicOpTargets() {
            // Consume a pending loadOp clear before taking the destination
            // snapshot, then continue in a second pass that samples only the
            // copy. Sampling the live attachment would be a WebGPU feedback
            // loop and is rejected by validation.
            const initialPass = this.ensurePass();
            if (!initialPass) {
                this.refuse("draw", "no render target is bound", {},
                    GL.INVALID_FRAMEBUFFER_OPERATION);
                return false;
            }
            this.endPass();
            const targets = this.currentTargets();
            if (!targets) return false;
            const width = Math.max(1, targets.width);
            const height = Math.max(1, targets.height);
            this.logicTargetTextures = this.logicTargetTextures || [];
            this.logicTargetViews = [];
            const encoder = this.ensureEncoder();
            let fallbackView = null;
            for (let i = 0; i < targets.color.length; ++i) {
                const source = targets.color[i];
                if (!source || !source.texture) {
                    this.logicTargetViews.push(fallbackView || this.fallbackView);
                    continue;
                }
                let copy = this.logicTargetTextures[i];
                const key = source.format + ":" + width + "x" + height;
                if (!copy || copy.glLogicKey !== key) {
                    this.retire(copy);
                    copy = this.createGPUTexture({
                        label: "GL logic-op destination copy " + i,
                        size: { width, height, depthOrArrayLayers: 1 },
                        format: source.format,
                        usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
                    });
                    copy.glLogicKey = key;
                    this.logicTargetTextures[i] = copy;
                }
                encoder.copyTextureToTexture({
                    texture: source.texture,
                    mipLevel: source.mipLevel || 0,
                    origin: source.origin || { x: 0, y: 0, z: 0 },
                }, { texture: copy },
                { width, height, depthOrArrayLayers: 1 });
                const view = copy.createView();
                if (!fallbackView) fallbackView = view;
                this.logicTargetViews.push(view);
            }
            if (fallbackView) {
                for (let i = 0; i < this.logicTargetViews.length; ++i)
                    if (this.logicTargetViews[i] === this.fallbackView)
                        this.logicTargetViews[i] = fallbackView;
            }
            return true;
        },

        /*
         * Whether points are drawn as quads: WebGPU rasterises one-pixel
         * points only, and GL's size comes from POINT_SIZE, the distance
         * attenuation and POINT_SIZE_MIN as well as sprites and a program's
         * gl_PointSize (review S2-18: a size of 1 ignored the rest).
         */
        drawStencilFaces(request) {
            const s = this.current, source = request.index && (request.index.source || request.index.cpu);
            const faces = polygonFaces(request.mode, request.vertexCount, source);
            const culling = s.enabled.has(GL.CULL_FACE);
            for (let k = 0; k < faces.provoking.length; ++k) {
                const from = faces.starts[k], n = faces.starts[k + 1] - from, p = faces.provoking[k];
                const polygon = faces.vertices.slice(from, from + n), start = polygon.indexOf(p), triangles = [];
                for (let i = 1; i + 1 < n; ++i)
                    triangles.push(p, polygon[(start + i) % n], polygon[(start + i + 1) % n]);
                const index = this.uploadIndexList(Uint32Array.from(triangles));
                if (!index) return;
                // Keep front/back adjacent for each original polygon. Grouping
                // all fronts before all backs would reorder stencil/blending.
                for (const side of ["front", "back"]) {
                    if (culling && s.cullFace === (side === "front" ? GL.FRONT : GL.BACK)) continue;
                    this.issueDraw({ ...request, mode: GL.TRIANGLES, vertexCount: triangles.length,
                        index, stencilFace: side });
                }
            }
        },

        pointsExpand() {
            const s = this.current, p = s.point;
            if (s.enabled.has(GL.VERTEX_PROGRAM_ARB)) {
                // the program's vertex stage has no corner input: its points
                // are one pixel (S2-50: refused)
                if (p.size !== 1 || s.enabled.has(GL.POINT_SPRITE))
                    this.warnOnce("arb-wide-points", "points are one pixel under an ARB vertex program", {});
                return false;
            }
            return p.size !== 1 || s.enabled.has(GL.POINT_SPRITE) || p.sizeMin > 1 ||
                p.attenuation[0] !== 1 || p.attenuation[1] !== 0 || p.attenuation[2] !== 0 ||
                (s.enabled.has(GL.VERTEX_PROGRAM_POINT_SIZE) && !!this.currentProgramObject());
        },

        polygonsFill() {
            const mode = this.current.polygonMode;
            return mode.front === GL.FILL && mode.back === GL.FILL;
        },

        /*
         * glPolygonMode LINE or POINT (GL 2.1 section 3.5.4). Each polygon's
         * facing, from its window-space area, picks its mode and decides its
         * culling; then it is drawn as that mode makes it: filled triangles,
         * its boundary edges as lines, or its vertices as points (review
         * S2-14: the triangulation's diagonals were drawn, the front mode
         * served both faces, and lines were never culled -- WebGPU culls
         * triangles only and has no facing for a line). Facing needs the
         * positions, which the fixed pipeline's transform gives on the CPU; a
         * vertex program or shader draws every polygon in the front mode,
         * unculled (warned). Lines and points are gathered into vertex data of
         * their own, which carries POLYGON_OFFSET_LINE/POINT's offset
         * (WebGPU's depth bias is for triangles) and lets wide points expand
         * without an index buffer (review S1-2e).
         */
        drawPolygonModes(request) {
            const s = this.current;
            const cpu = request.cpu;
            const faces = polygonFaces(request.mode, request.vertexCount,
                request.index && request.index.source, cpu && cpu.edgeFlags);
            const front = s.polygonMode.front, back = s.polygonMode.back;
            const culling = s.enabled.has(GL.CULL_FACE);
            const fixedVertex = !this.currentProgramObject() &&
                !s.enabled.has(GL.VERTEX_PROGRAM_ARB);
            const clip = fixedVertex ? this.clipCoordinates(cpu) : null;
            if (!clip && (front !== back || culling))
                this.warnOnce("polygon-mode-facing", "the polygons' facing is " +
                    "not known on the CPU under a vertex program: every polygon " +
                    "is drawn in the front polygon mode, and not culled", { front, back });
            const fill = [], groups = new Map();
            for (let k = 0; k < faces.provoking.length; ++k) {
                const isFront = !clip || facesFront(clip, faces, k, s.frontFace);
                if (clip && culling && (isFront ? s.cullFace === GL.FRONT : s.cullFace === GL.BACK))
                    continue;
                const mode = isFront || !clip ? front : back;
                const from = faces.starts[k], to = faces.starts[k + 1], n = to - from;
                const v = faces.vertices, p = faces.provoking[k];
                if (mode === GL.FILL) {
                    // a fan from the provoking vertex keeps the winding and
                    // leads with it, as expandIndices does
                    let j = from;
                    while (v[j] !== p) ++j;
                    for (let i = 1; i + 1 < n; ++i)
                        fill.push(p, v[from + (j - from + i) % n], v[from + (j - from + i + 1) % n]);
                    continue;
                }
                const key = mode + (isFront ? "f" : "b");
                let group = groups.get(key);
                if (!group) groups.set(key, group = { mode, back: !isFront,
                    vertices: [], provoking: [], offsets: [], offset: false });
                const offset = this.polygonOffsetOf(mode, clip, faces, k);
                if (offset !== null) group.offset = true;
                for (let i = from; i < to; ++i) {
                    if (!faces.boundary[i]) continue;
                    if (mode === GL.LINE) {
                        // a flat-shaded line takes its second vertex's colour
                        const a = v[i], b = v[i + 1 < to ? i + 1 : from];
                        group.vertices.push(...(a === p ? [b, a] : [a, b]));
                        group.provoking.push(p, p);
                        group.offsets.push(offset, offset);
                    } else {
                        group.vertices.push(v[i]);
                        group.provoking.push(p);
                        group.offsets.push(offset);
                    }
                }
            }
            if (fill.length) {
                const index = this.uploadIndexList(Uint32Array.from(fill));
                if (index) this.issueDraw({ ...request, mode: GL.TRIANGLES,
                    vertexCount: fill.length, index, rasterized: true });
            }
            try {
                this.drawGroups(request, groups, cpu, fixedVertex);
            } finally {
                this.drawFace = null;   // the face variants are these draws' only
            }
        },

        drawGroups(request, groups, cpu, fixedVertex) {
            const s = this.current;
            for (const group of groups.values()) {
                if (!group.vertices.length) continue;
                const mode = group.mode === GL.LINE ? GL.LINES : GL.POINTS;
                const face = { back: group.back, depthOffset: group.offset && fixedVertex };
                if (!cpu || request.buffers.length !== 1) {
                    // no vertex data to gather: index the draw's own
                    const index = this.uploadIndexList(Uint32Array.from(group.vertices));
                    if (index) this.issueDraw({ ...request, mode, vertexCount: group.vertices.length,
                        index, rasterized: true, face: { back: group.back } });
                    continue;
                }
                const gathered = this.gatherVertices(cpu, group.vertices,
                    group.provoking, fixedVertex && s.shadeModel === GL.FLAT, face.depthOffset ?
                        { location: fixedFunction.DEPTH_OFFSET_LOCATION, components: 1,
                          value: i => [group.offsets[i] || 0] } : null);
                if (gathered) this.issueDraw({ mode, vertexCount: group.vertices.length,
                    firstVertex: 0, buffers: [gathered.buffer], index: null, rasterized: true, face,
                    cpu: gathered.cpu });
            }
        },

        /*
         * Wide and stippled lines (review D-04, D-16; WebGPU draws one-pixel
         * lines without a pattern). With the fixed pipeline's window
         * positions on the CPU each segment becomes a quad widened along its
         * minor axis, as GL 2.1 section 3.4.2 widens a non-antialiased line,
         * and carries its distance along the major axis for the stipple
         * pattern (section 3.4.3). Under a vertex program lines stay one
         * pixel wide and solid (warned).
         */
        drawLines(request) {
            const s = this.current;
            const cpu = request.cpu;
            const fixedVertex = !this.currentProgramObject() &&
                !s.enabled.has(GL.VERTEX_PROGRAM_ARB);
            const clip = fixedVertex && request.buffers.length === 1 ? this.clipCoordinates(cpu) : null;
            if (!clip) {
                this.warnOnce("wide-lines-program", "wide and stippled lines are drawn one " +
                    "pixel wide and solid under a vertex program", { width: s.lineWidth });
                return this.issueDraw({ ...request, linesExpanded: true });
            }
            const width = clamp(Math.round(s.lineWidth), 1, MAX_LINE_WIDTH);
            const stipple = s.enabled.has(GL.LINE_STIPPLE);
            const vp = s.viewport;
            const vertices = [], provoking = [], attributes = [];
            const push = (v, p, dx, dy, distance) => {
                vertices.push(v); provoking.push(p); attributes.push([dx, dy, distance]);
            };
            let distance = 0;
            for (const segment of lineSegments(request.mode, request.vertexCount,
                    request.index && request.index.source)) {
                if (segment.restart) distance = 0;
                const a = segment.a * 4, b = segment.b * 4;
                const visible = clip[a + 3] > 0 && clip[b + 3] > 0;
                const dx = visible ? (clip[b] / clip[b + 3] - clip[a] / clip[a + 3]) * vp.width / 2 : 0;
                const dy = visible ? (clip[b + 1] / clip[b + 3] - clip[a + 1] / clip[a + 3]) * vp.height / 2 : 0;
                const xMajor = Math.abs(dx) >= Math.abs(dy);
                const start = distance;
                distance += xMajor ? Math.abs(dx) : Math.abs(dy);
                const p = segment.provoking;
                if (width === 1) {
                    push(segment.a, p, 0, 0, start);
                    push(segment.b, p, 0, 0, distance);
                    continue;
                }
                const ox = xMajor ? 0 : width / 2, oy = xMajor ? width / 2 : 0;
                // two triangles, each led under flat shading by its last
                // vertex, the segment's end (expandFlat)
                push(segment.a, p, -ox, -oy, start);
                push(segment.a, p, ox, oy, start);
                push(segment.b, p, -ox, -oy, distance);
                push(segment.a, p, ox, oy, start);
                push(segment.b, p, ox, oy, distance);
                push(segment.b, p, -ox, -oy, distance);
            }
            if (!vertices.length) return;
            const gathered = this.gatherVertices(cpu, vertices, provoking, s.shadeModel === GL.FLAT,
                { location: fixedFunction.LINE_ATTRIBUTE_LOCATION, components: 3, value: i => attributes[i] });
            if (!gathered) return;
            try {
                this.issueDraw({ mode: width > 1 ? GL.TRIANGLES : GL.LINES, vertexCount: vertices.length,
                    firstVertex: 0, buffers: [gathered.buffer], index: null, rasterized: true, linesExpanded: true,
                    face: { ...(request.face || {}), wideLine: width > 1, lineStipple: stipple } });
            } finally {
                this.drawFace = null;
            }
        },

        uploadIndexList(indices) {
            const slice = this.uploadVertices(new Uint8Array(indices.buffer));
            return slice && { buffer: slice.buffer, offset: slice.offset,
                count: indices.length, format: "uint32", cpu: indices };
        },

        // Each vertex's clip coordinates under the fixed pipeline's transform
        clipCoordinates(cpu) {
            const position = cpu && cpu.layout.find(a =>
                a.location === translator.COMPAT_ATTRIBUTE_LOCATIONS.gl_Vertex);
            if (!position) return null;
            const m = multiply4(this.topOf(GL.PROJECTION), this.topOf(GL.MODELVIEW));
            const out = new Float64Array(cpu.count * 4);
            for (let v = 0; v < cpu.count; ++v) {
                const at = v * cpu.stride + position.offsetFloats;
                const p = [0, 0, 0, 1];
                for (let c = 0; c < position.components; ++c) p[c] = cpu.data[at + c];
                for (let r = 0; r < 4; ++r)
                    out[v * 4 + r] = m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3];
            }
            return out;
        },

        /*
         * glPolygonOffset for polygon k drawn as lines or points, in units of
         * the depth range: factor times its window-space depth slope plus
         * units times the depth buffer's resolvable difference (GL 2.1
         * section 3.5.5, m as max(|dz/dx|, |dz/dy|), the approximation
         * WebGPU's depth bias also uses). null when not enabled.
         */
        polygonOffsetOf(mode, clip, faces, k) {
            const s = this.current;
            if (!s.enabled.has(mode === GL.LINE ? GL.POLYGON_OFFSET_LINE : GL.POLYGON_OFFSET_POINT))
                return null;
            if (!clip) {
                this.warnOnce("polygon-offset-program", "POLYGON_OFFSET_LINE/POINT " +
                    "is not applied under a vertex program", {});
                return null;
            }
            const near = s.depthRange.near, far = s.depthRange.far;
            const range = Math.abs(far - near);
            if (!range) return 0;
            const vp = s.viewport;
            const points = [];
            for (let i = faces.starts[k]; i < faces.starts[k + 1]; ++i) {
                const c = faces.vertices[i] * 4, w = clip[c + 3];
                if (!(w > 0)) return null;
                points.push([clip[c] / w * vp.width / 2, clip[c + 1] / w * vp.height / 2,
                    near + (far - near) * (clip[c + 2] / w + 1) / 2]);
            }
            let slope = 0, best = 0;
            for (let i = 1; i + 1 < points.length; ++i) {
                const [a, b, c] = [points[0], points[i], points[i + 1]];
                const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
                if (Math.abs(det) <= best) continue;
                best = Math.abs(det);
                const dzdx = ((b[2] - a[2]) * (c[1] - a[1]) - (c[2] - a[2]) * (b[1] - a[1])) / det;
                const dzdy = ((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / det;
                slope = Math.max(Math.abs(dzdx), Math.abs(dzdy));
            }
            const targets = this.currentTargets();
            const format = (targets && targets.depthFormat) || "depth24plus";
            let r = Math.pow(2, -24);
            if (format === "depth16unorm") r = Math.pow(2, -16);
            else if (format.startsWith("depth32float")) {
                const z = Math.max(...points.map(q => Math.abs(q[2])));
                r = Math.pow(2, (z > 0 ? Math.floor(Math.log2(z)) : -126) - 23);
            }
            return (slope * s.polygonOffset.factor + r * s.polygonOffset.units) / range;
        },

        /*
         * A group's lines or points as vertex data of their own. Under flat
         * shading the fixed pipeline's colours and normal come from the
         * polygon's provoking vertex (lit at each vertex's own position, so
         * exact for directional lights without specular).
         */
        /*
         * `vertices` of the CPU data as vertex data of their own, each with
         * the `extra` attribute's value ({ location, components, value(i) })
         * appended. Returns the buffer and its CPU data (`cpu`'s shape).
         */
        gatherVertices(cpu, vertices, provoking, flat, extra) {
            const added = extra ? extra.components : 0;
            const stride = cpu.stride + added;
            const out = new Float32Array(vertices.length * stride);
            const ATTR = translator.COMPAT_ATTRIBUTE_LOCATIONS;
            const copied = flat ? cpu.layout.filter(a => a.location === ATTR.gl_Color ||
                a.location === ATTR.gl_SecondaryColor || a.location === ATTR.gl_Normal) : [];
            for (let i = 0; i < vertices.length; ++i) {
                const v = vertices[i], at = i * stride;
                out.set(cpu.data.subarray(v * cpu.stride, (v + 1) * cpu.stride), at);
                for (const a of copied) {
                    const from = provoking[i] * cpu.stride + a.offsetFloats;
                    out.set(cpu.data.subarray(from, from + a.components), at + a.offsetFloats);
                }
                if (extra) out.set(extra.value(i), at + cpu.stride);
            }
            const slice = this.uploadVertices(new Uint8Array(out.buffer));
            if (!slice) return null;
            const layout = extra ? cpu.layout.concat([{ location: extra.location,
                components: added, offsetFloats: cpu.stride }]) : cpu.layout;
            return {
                buffer: { gpuBuffer: slice.buffer, baseOffset: slice.offset, stride: stride * 4,
                    attributes: layout.map(a => ({ location: a.location,
                        format: "float32" + (a.components > 1 ? "x" + a.components : ""),
                        offset: a.offsetFloats * 4 })) },
                cpu: { data: out, stride, count: vertices.length, layout, edgeFlags: null },
            };
        },
    });

    /* ================================================================== */
    /* Executor: shader selection, pipelines and bind groups              */
    /* ================================================================== */

    Object.assign(GLWebGPUExecutor.prototype, {

        /* The pipeline variant state GL still applies around a programmable
         * pipeline: alpha test, user clip planes, point sprites, two-sided
         * colour and flat shading all change the generated WGSL. */
        currentVariant() {
            const s = this.current;
            let clipPlaneCount = 0;
            for (let i = 0; i < MAX_CLIP_PLANES; ++i)
                if (s.enabled.has(GL.CLIP_PLANE0 + i)) clipPlaneCount = i + 1;
            return {
                alphaTest: s.enabled.has(GL.ALPHA_TEST) ?
                    (ALPHA_TEST_NAMES[s.alphaFunc.func] || "always") : "always",
                clipPlaneCount,
                pointSprite: !!this.drawingExpandedPoints,
                // gl_PointSize counts only under VERTEX_PROGRAM_POINT_SIZE
                programPointSize: s.enabled.has(GL.VERTEX_PROGRAM_POINT_SIZE),
                pointCoordLowerLeft:
                    s.point.spriteCoordOrigin === GL.LOWER_LEFT,
                polygonStipple: s.enabled.has(GL.POLYGON_STIPPLE),
                logicOp: s.enabled.has(GL.COLOR_LOGIC_OP) ? s.logicOp : 0,
                twoSided: this.currentProgramObject()?.compiled.vertex || s.enabled.has(GL.VERTEX_PROGRAM_ARB) ?
                    s.enabled.has(GL.VERTEX_PROGRAM_TWO_SIDE) : s.lightModel.twoSide,
                flatShading: s.shadeModel === GL.FLAT,
                colorTargets: this.colorTargetCount(),
            };
        },

        colorTargetCount() {
            const s = this.current;
            if (!s.drawFramebuffer) return 1;
            return Math.max(1, s.drawBuffers.length);
        },

        arbShaders() {
            const s = this.current;
            const vertexOn = s.enabled.has(GL.VERTEX_PROGRAM_ARB);
            const fragmentOn = s.enabled.has(GL.FRAGMENT_PROGRAM_ARB);
            if (!vertexOn && !fragmentOn) return null;
            if (s.enabled.has(GL.COLOR_LOGIC_OP)) {
                this.refuse("draw", "colour logic operations cannot be injected " +
                    "into an ARB assembly fragment program", { op: s.logicOp }, 0);
                return null;
            }
            const vertex = vertexOn ? this.arbProgramFor(GL.VERTEX_PROGRAM_ARB) : null;
            const fragment = fragmentOn ?
                this.arbProgramFor(GL.FRAGMENT_PROGRAM_ARB) : null;
            if ((vertexOn && (!vertex || !vertex.compiled || !vertex.compiled.ok)) ||
                    (fragmentOn && (!fragment || !fragment.compiled ||
                        !fragment.compiled.ok))) {
                this.refuse("draw", "an enabled ARB program has not compiled",
                    {}, GL.INVALID_OPERATION);
                return null;
            }
            if (vertexOn && !fragmentOn)
                return this.arbVertexFixedFragmentShaders(vertex);
            if (!vertexOn && fragmentOn)
                return this.arbFragmentFixedVertexShaders(fragment);
            // Both stages read one state block, so each is compiled with the
            // pair's fields, in the one layout (review S2-51: each declared
            // only its own, and the fragment program read the vertex
            // program's fields)
            const stateFields = [...new Set([
                ...vertex.compiled.reflection.stateFields,
                ...fragment.compiled.reflection.stateFields])];
            const compiledVertex = this.arbVariant(vertex, stateFields);
            const compiledFragment = this.arbVariant(fragment, stateFields);
            if (!compiledVertex || !compiledFragment) return null;
            const targets = this.colorTargetCount();
            return {
                kind: "arb",
                key: "arb" + this.pairKey(compiledVertex, compiledFragment, compiledVertex.wgsl,
                    compiledFragment.wgsl) + (targets > 1 ? "x" + targets : ""),
                wgslVertex: compiledVertex.wgsl,
                wgslFragment: broadcastColor(compiledFragment.wgsl, targets),
                stateFields,
                stateFloats: stateLayout.buildLayout(stateFields).floats,
                uniformBytes: arbProgram.MAX_PROGRAM_PARAMETERS * 4 * 4 * 2,
                colorTargets: targets,
                arbVertex: vertex, arbFragment: fragment,
                textures: arbProgramTextures(fragment),
            };
        },

        // A program compiled to declare `stateFields`, its pair's layout
        arbVariant(program, stateFields) {
            const key = "state=" + stateFields.join(",");
            program.variants = program.variants || new Map();
            let compiled = program.variants.get(key);
            if (!compiled) {
                compiled = arbProgram.compileARBProgram(program.source, { forceStateFields: stateFields });
                if (!compiled.ok) {
                    this.refuse("draw", "an ARB program variant failed to compile", { log: compiled.log },
                        GL.INVALID_OPERATION);
                    return null;
                }
                program.variants.set(key, compiled);
            }
            return compiled;
        },

        // The enabled ARB fragment program a fixed vertex stage feeds, or null
        fixedVertexFragmentProgram() {
            const s = this.current;
            if (!s.enabled.has(GL.FRAGMENT_PROGRAM_ARB) || s.enabled.has(GL.VERTEX_PROGRAM_ARB)) return null;
            const fragment = this.arbProgramFor(GL.FRAGMENT_PROGRAM_ARB);
            return fragment && fragment.compiled && fragment.compiled.ok ? fragment : null;
        },

        /*
         * A fixed vertex stage before an ARB fragment program (review D-18:
         * refused, so a WineD3D-style program drew nothing). The fixed stage
         * writes the program's interface (fixedFunctionSignature's
         * arbFragment) and both declare the one state layout.
         */
        arbFragmentFixedVertexShaders(fragment) {
            const signature = this.fixedFunctionSignature(this.currentVariant());
            signature.extraStateFields = fragment.compiled.reflection.stateFields.slice();
            const fixedKey = fixedFunction.signatureKey(signature);
            let fixed = this.ffCache && this.ffCache.get(fixedKey);
            if (!fixed) {
                fixed = fixedFunction.generate(signature);
                this.ffCache = this.ffCache || new Map();
                this.ffCache.set(fixedKey, fixed);
            }
            const compiledFragment = this.arbVariant(fragment, fixed.stateFields);
            if (!compiledFragment) return null;
            const targets = this.colorTargetCount();
            return {
                kind: "arb",
                key: "ff-arb-fp:" + this.pairKey(fixed, compiledFragment, fixed.wgslVertex, compiledFragment.wgsl) +
                    (targets > 1 ? "x" + targets : ""),
                wgslVertex: fixed.wgslVertex,
                wgslFragment: broadcastColor(compiledFragment.wgsl, targets),
                stateFields: fixed.stateFields,
                stateFloats: fixed.stateFloats,
                uniformBytes: arbProgram.MAX_PROGRAM_PARAMETERS * 4 * 4 * 2,
                colorTargets: targets,
                arbVertex: null, arbFragment: fragment,
                textures: arbProgramTextures(fragment),
            };
        },

        arbVertexFixedFragmentShaders(vertex) {
            const variant = this.currentVariant();
            if (variant.clipPlaneCount) {
                // ARB_vertex_program leaves user clipping undefined unless the
                // program is position-invariant; drawn unclipped (review
                // S2-50: the draw was refused)
                this.warnOnce("arb-clip-planes", "user clip planes are not applied under an " +
                    "ARB vertex program", { clipPlaneCount: variant.clipPlaneCount });
                variant.clipPlaneCount = 0;
            }

            const signature = this.fixedFunctionSignature(variant);
            signature.varyingInterface = "arb";
            // The two modules share one compact GLState block. Generate the
            // fixed stage with the ARB stage's fields included so every field
            // retains the same canonical byte offset in both modules.
            signature.extraStateFields =
                vertex.compiled.reflection.stateFields.slice();
            const fixedKey = fixedFunction.signatureKey(signature);
            let fixed = this.ffCache && this.ffCache.get(fixedKey);
            if (!fixed) {
                fixed = fixedFunction.generate(signature);
                this.ffCache = this.ffCache || new Map();
                this.ffCache.set(fixedKey, fixed);
            }

            const forcedTexCoords = fixed.textures.map(entry => entry.unit);
            const variantKey = this.variantKeys.key([fixed.key, forcedTexCoords]);
            vertex.variants = vertex.variants || new Map();
            let compiledVertex = vertex.variants.get(variantKey);
            if (!compiledVertex) {
                compiledVertex = arbProgram.compileARBProgram(vertex.source, {
                    forceStateFields: fixed.stateFields,
                    forceVertexTexCoords: forcedTexCoords,
                    forceFlatVaryings: variant.flatShading ? [0, 1] : [],
                });
                if (!compiledVertex.ok) {
                    this.refuse("draw", "the mixed ARB vertex variant failed " +
                        "to compile", { log: compiledVertex.log },
                        GL.INVALID_OPERATION);
                    return null;
                }
                vertex.variants.set(variantKey, compiledVertex);
            }

            return {
                kind: "arb",
                key: "arb-vp-ff:" + this.pairKey(compiledVertex, fixed, compiledVertex.wgsl, fixed.wgslFragment),
                wgslVertex: compiledVertex.wgsl,
                wgslFragment: fixed.wgslFragment,
                stateFields: fixed.stateFields,
                stateFloats: fixed.stateFloats,
                uniformBytes: arbProgram.MAX_PROGRAM_PARAMETERS * 4 * 4 * 2,
                colorTargets: fixed.colorTargets,
                arbVertex: vertex,
                arbFragment: null,
                textures: fixed.textures,
            };
        },

        resolveShaders() {
            if (this.current.enabled.has(GL.VERTEX_PROGRAM_ARB) ||
                    this.current.enabled.has(GL.FRAGMENT_PROGRAM_ARB))
                return this.arbShaders();
            const program = this.currentProgramObject();
            const variant = this.currentVariant();
            if (program) {
                const mixed = !program.compiled.vertex || !program.compiled.fragment;
                const key = this.variantKeys.key([variant, mixed ? this.mixedGLSLSignature(program, variant) : null]);
                let entry = program.variants.get(key);
                if (!entry) {
                    const link = this.linkVariant(program, variant);
                    if (!link.ok) {
                        this.refuse("draw", "the program variant failed to link",
                            { program: program.name, log: link.log },
                            GL.INVALID_OPERATION);
                        return null;
                    }
                    entry = { link, key };
                    program.variants.set(key, entry);
                }
                if (!entry.codeKey) entry.codeKey = this.codeKey(entry.link.wgslVertex, entry.link.wgslFragment);
                return {
                    kind: "program", key: "p" + entry.codeKey,
                    program,
                    wgslVertex: entry.link.wgslVertex,
                    wgslFragment: entry.link.wgslFragment,
                    reflection: entry.link.reflection,
                    stateFields: entry.link.reflection.stateFields,
                    stateFloats: entry.link.reflection.stateFloats,
                    uniformBytes: entry.link.reflection.uniformBlockBytes,
                    colorTargets: entry.link.reflection.colorTargets,
                    textures: entry.link.fixedTextures,
                };
            }
            const signature = this.fixedFunctionSignature(variant);
            const key = fixedFunction.signatureKey(signature);
            let generated = this.ffCache && this.ffCache.get(key);
            if (!generated) {
                generated = fixedFunction.generate(signature);
                this.ffCache = this.ffCache || new Map();
                this.ffCache.set(key, generated);
            }
            return {
                kind: "ff", key,
                wgslVertex: generated.wgslVertex,
                wgslFragment: generated.wgslFragment,
                stateFields: generated.stateFields,
                stateFloats: generated.stateFloats,
                uniformBytes: 16,
                textures: generated.textures,
                colorTargets: generated.colorTargets,
            };
        },

        // GL 1.4's LOD bias of a unit: its TEXTURE_FILTER_CONTROL bias plus its
        // texture's TEXTURE_LOD_BIAS, within what WGSL's bias takes (review S3)
        textureLodBias(unit, object) {
            const bias = this.current.textureUnits[unit].lodBias + (object ? object.sampler.lodBias : 0);
            return clamp(bias, -16, 15.99);
        },

        mixedGLSLSignature(program, variant) {
            const sig = this.fixedFunctionSignature(variant, program.compiled.fragment);
            if (program.compiled.vertex) {
                sig.lighting.enabled = false;
                sig.twoSidedColors = !!variant.twoSided;
            }
            return sig;
        },

        fixedFunctionSignature(variant, glslFragment) {
            const s = this.current;
            const colorSum = s.enabled.has(GL.COLOR_SUM);
            // before an ARB fragment program the fixed vertex stage feeds the
            // program's inputs: every texture coordinate it reads, whatever
            // the texture enables (review D-18)
            const fragmentProgram = this.fixedVertexFragmentProgram();
            const programCoords = glslFragment ? new Set(Array.from({ length: glslFragment.usage.texCoordDynamic ? MAX_TEXTURE_COORDS :
                glslFragment.usage.texCoordMax + 1 }, (_, i) => i)) : fragmentProgram &&
                new Set(fragmentProgram.compiled.reflection.fragmentTexCoords || []);

            const texture = [];
            for (let unit = 0; unit < MAX_TEXTURE_UNITS; ++unit) {
                const state = s.textureUnits[unit];
                if (programCoords) {
                    texture.push(programCoords.has(unit) ? {
                        enabled: true, target: "3D", shadow: false, format: "RGBA",
                        matrix: !isIdentity(this.textureMatrixOf(unit)), lodBias: false, border: null,
                        texGen: state.texGen.map(gen => gen.enabled ? (TEXGEN_MODE_NAMES[gen.mode] || "EYE") : null),
                        env: { mode: "MODULATE" } } : { enabled: false });
                    continue;
                }
                const target = this.effectiveTarget(state);
                if (!target) { texture.push({ enabled: false }); continue; }
                const object = this.textureObjectFor(unit, target.enumValue);
                const complete = this.textureIsComplete(object);
                // GL 2.1 section 3.8.16: a unit whose texture is incomplete is
                // as if texturing were disabled on it (review S2-21: level 0
                // was sampled under a mipmap filter)
                if (!complete) { texture.push({ enabled: false }); continue; }
                texture.push({
                    enabled: true,
                    target: target.kind,
                    shadow: !!(object && object.sampler.compareMode ===
                        GL.COMPARE_R_TO_TEXTURE),
                    // a depth texture is sampled as DEPTH_TEXTURE_MODE says
                    format: object.baseFormat === "DEPTH" ?
                        DEPTH_MODE_FORMATS[object.sampler.depthTextureMode] || "LUMINANCE" : object.baseFormat,
                    matrix: !isIdentity(this.textureMatrixOf(unit)),
                    lodBias: this.textureLodBias(unit, object) !== 0,
                    border: textureBorder(object, target.kind),
                    texGen: state.texGen.map(gen => gen.enabled ?
                        (TEXGEN_MODE_NAMES[gen.mode] || "EYE") : null),
                    env: this.texEnvSignature(state.env),
                });
            }
            const texGenNeedsNormal = texture.some(unit => unit.enabled &&
                unit.texGen.some(mode => mode === "SPHERE" ||
                    mode === "REFLECTION" || mode === "NORMAL"));

            return {
                attributes: {
                    position: { components: 4 },
                    normal: s.enabled.has(GL.LIGHTING) || texGenNeedsNormal,
                    // Array draws use GL's current values when an array is
                    // disabled. The draw assembler supplies those values as a
                    // constant-rate vertex buffer, so the fixed shader must
                    // consume the attribute rather than bake white/defaults.
                    color: true,
                    secondaryColor: !!glslFragment || s.enabled.has(GL.COLOR_SUM) ||
                        s.lightModel.colorControl === GL.SEPARATE_SPECULAR_COLOR,
                    fogCoord: (s.enabled.has(GL.FOG) || !!fragmentProgram || !!glslFragment) &&
                        s.fog.coordSource === GL.FOG_COORD,
                    texCoord: Array.from({ length: MAX_TEXTURE_COORDS },
                        (unused, unit) => texture[unit] && texture[unit].enabled ?
                            { components: 4 } : null),
                },
                colorSum,
                lighting: {
                    enabled: s.enabled.has(GL.LIGHTING),
                    twoSide: s.lightModel.twoSide,
                    localViewer: s.lightModel.localViewer,
                    separateSpecular:
                        s.lightModel.colorControl === GL.SEPARATE_SPECULAR_COLOR,
                    normalMode: s.enabled.has(GL.NORMALIZE) ? "normalize" :
                        (s.enabled.has(GL.RESCALE_NORMAL) ? "rescale" : "none"),
                    colorMaterial: {
                        enabled: s.colorMaterial.enabled,
                        face: FACE_NAMES[s.colorMaterial.face] || "FRONT_AND_BACK",
                        mode: COLOR_MATERIAL_MODES[s.colorMaterial.mode] ||
                            "AMBIENT_AND_DIFFUSE",
                    },
                    lights: s.lights.map(light => ({
                        enabled: light.enabled,
                        positional: light.position[3] !== 0,
                        spot: light.spotCutoff !== 180,
                    })),
                },
                // (the program's fragment.fogcoord: computed whatever FOG says)
                ...(fragmentProgram ? { varyingInterface: "arb", arbFragment: true } : {}),
                fog: {
                    enabled: s.enabled.has(GL.FOG) || !!fragmentProgram || !!glslFragment,
                    mode: s.fog.mode === GL.EXP ? "exp" :
                        (s.fog.mode === GL.EXP2 ? "exp2" : "linear"),
                    coordSource: s.fog.coordSource === GL.FOG_COORD ?
                        "coord" : "depth",
                },
                texture,
                alphaTest: variant.alphaTest,
                clipPlaneCount: variant.clipPlaneCount,
                pointSprite: variant.pointSprite,
                pointCoordLowerLeft: variant.pointCoordLowerLeft,
                polygonStipple: variant.polygonStipple,
                logicOp: variant.logicOp,
                flatShading: variant.flatShading,
                colorTargets: variant.colorTargets,
                backFacing: !!(this.drawFace && this.drawFace.back),
                depthOffset: !!(this.drawFace && this.drawFace.depthOffset),
                wideLine: !!(this.drawFace && this.drawFace.wideLine),
                lineStipple: !!(this.drawFace && this.drawFace.lineStipple),
            };
        },

        texEnvSignature(env) {
            const mode = TEXENV_MODE_NAMES[env.mode] || "MODULATE";
            if (mode !== "COMBINE") return {
                mode,
                coordReplace: !!env.pointSprite,
            };
            return {
                mode,
                coordReplace: !!env.pointSprite,
                combineRGB: COMBINE_RGB_NAMES[env.combineRGB] || "MODULATE",
                combineAlpha: COMBINE_RGB_NAMES[env.combineAlpha] || "MODULATE",
                srcRGB: env.srcRGB.map(v => COMBINE_SOURCE_NAMES[v] || "TEXTURE"),
                srcAlpha: env.srcAlpha.map(v => COMBINE_SOURCE_NAMES[v] || "TEXTURE"),
                operandRGB: env.operandRGB.map(v => OPERAND_NAMES[v] || "SRC_COLOR"),
                operandAlpha: env.operandAlpha.map(v =>
                    OPERAND_NAMES[v] || "SRC_ALPHA"),
                rgbScale: env.rgbScale,
                alphaScale: env.alphaScale,
            };
        },

        effectiveTarget(unitState) {
            for (const [enumValue, kind] of TARGET_PRIORITY)
                if (unitState.enabledTargets.has(enumValue))
                    return { enumValue, kind };
            return null;
        },

        textureObjectFor(unit, target) {
            const s = this.current;
            const state = s.textureUnits[unit], id = state.imageBindings[target];
            return id ? s.shareGroup.textureImages.get(id) || null : this.defaultTexture(target);
        },

        textureMatrixOf(unit) {
            const stack = this.current.textureStacks[unit];
            return stack[stack.length - 1];
        },

        /* ---- pipelines ---- */

        ensurePipeline(shaders, request, index) {
            const s = this.current;
            const targets = this.passTargets;
            const shape = this.drawShape(request.mode);
            const topology = shape.topology;
            const strip = topology === "triangle-strip" || topology === "line-strip";
            // POLYGON_OFFSET_FILL is for filled polygons, and WebGPU rejects a
            // depth bias on lines and points (review S1-2c)
            const quads = request.expandedPoints || request.linesExpanded;
            // multisampling: the window's pixel format; alpha to coverage
            // needs more than one sample, and only does anything with them
            const samples = (targets && targets.sampleCount) || 1;
            const alphaToCoverage = samples > 1 && s.enabled.has(GL.MULTISAMPLE) &&
                s.enabled.has(GL.SAMPLE_ALPHA_TO_COVERAGE);
            const fillOffset = s.enabled.has(GL.POLYGON_OFFSET_FILL) &&
                isPolygonPrimitive(request.mode) && !quads;
            // a point's or line's quad is not a face (review S2-18: it was culled)
            const cullMode = request.stencilFace ? (request.stencilFace === "front" ? "back" : "front") :
                quads ? "none" : this.gpuCullMode(s);
            const vertexModule = this.shaderModule(reversedDepthRange(s) ?
                flipDepth(shaders.wgslVertex) : shaders.wgslVertex);
            const fragmentModule = this.shaderModule(shaders.wgslFragment);
            const buffers = request.buffers.map(buffer => ({
                arrayStride: buffer.stride,
                stepMode: buffer.stepMode || "vertex",
                attributes: buffer.attributes.map(a => ({
                    shaderLocation: a.location,
                    format: a.format,
                    offset: a.offset,
                })),
            }));
            // a draw buffer the shader writes no output for keeps its
            // contents (WebGPU requires a zero write mask there)
            const outputs = shaders.colorTargets || 1;
            const colorTargets = (targets ? targets.color : [null]).map((target, i) =>
                target ? {
                    format: target.format,
                    blend: s.enabled.has(GL.BLEND) && !s.enabled.has(GL.COLOR_LOGIC_OP) &&
                        this.blendable(target.format) ? gpuBlendState(s) : undefined,
                    writeMask: i >= outputs ? 0 : (s.colorMask[0] ? 1 : 0) | (s.colorMask[1] ? 2 : 0) |
                        (s.colorMask[2] ? 4 : 0) | (s.colorMask[3] ? 8 : 0),
                } : null);

            const descriptor = {
                label: "GL pipeline",
                layout: "auto",
                vertex: { module: vertexModule, entryPoint: "vs_main", buffers },
                fragment: { module: fragmentModule, entryPoint: "fs_main",
                            targets: colorTargets },
                primitive: {
                    topology: request.expandedPoints ? "triangle-list" : topology,
                    frontFace: this.gpuFrontFace(s),
                    cullMode,
                    ...(strip && index ? { stripIndexFormat: "uint32" } : {}),
                    ...(s.enabled.has(GL.DEPTH_CLAMP) &&
                        this.deviceFeatures.depthClipControl ?
                        { unclippedDepth: true } : {}),
                },
                multisample: {
                    count: samples,
                    mask: sampleCoverageMask(s, samples),
                    alphaToCoverageEnabled: alphaToCoverage,
                },
            };
            if (targets && targets.depthFormat) {
                descriptor.depthStencil = {
                    format: targets.depthFormat,
                    depthWriteEnabled: !!(s.enabled.has(GL.DEPTH_TEST) ?
                        s.depthMask : false),
                    depthCompare: s.enabled.has(GL.DEPTH_TEST) ?
                        (COMPARE_FUNCTIONS[s.depthFunc] || "less") : "always",
                    ...(targets.depthFormat.indexOf("stencil") >= 0 ?
                        gpuStencilState(s, request.stencilFace || (request.face && request.face.back ? "back" : undefined)) : {}),
                    depthBias: fillOffset ? Math.round(s.polygonOffset.units) : 0,
                    depthBiasSlopeScale: fillOffset ? s.polygonOffset.factor : 0,
                };
            }

            // The complete descriptor supplies every GPU pipeline field. Module
            // references and CPU object/link identities are opaque integers.
            const identity = shaders.kind === "program" ? [
                this.pipelineKeys.reference(shaders.program), shaders.program.cpuObjectId || 0,
                shaders.program.cpuLinkGeneration || 0, shaders.program.executableGeneration || 0,
            ] : shaders.kind === "arb" ? [
                shaders.arbVertex ? this.pipelineKeys.reference(shaders.arbVertex) : 0,
                shaders.arbFragment ? this.pipelineKeys.reference(shaders.arbFragment) : 0,
            ] : [];
            if (this.pipelineCache.size > 4096) {this.pipelineCache.clear();this.pipelineKeys.clearKeys();}
            const signature = this.renderPipelineKey(this.pipelineCache, descriptor, identity);
            let pipeline = this.pipelineCache.get(signature);
            if (pipeline) return pipeline.glRejected ? null : pipeline;

            pipeline = this.createPipeline(this.pipelineCache, signature, descriptor);
            pipeline.glShaders = shaders;
            pipeline.glActiveBindings = activeShaderBindings(
                shaders.wgslVertex, shaders.wgslFragment);
            return pipeline;
        },

        createPipeline(cache, key, descriptor) {
            ++this.stats.pipelines;
            const pipeline = this.resources.checked(this.gpuErrors, "render pipeline", cache, key,
                () => this.device.createRenderPipeline(descriptor), () => {
                    ++this.stats.pipelinesRejected;
                    if (cache === this.singletonPipelines && this[key] === pipeline) this[key] = null;
                });
            return pipeline;
        },

        renderPipelineKey(cache, descriptor, identity = []) {
            let keys = this.pipelineKeyTables.get(cache);
            if (!keys) {keys = new CacheKeys();this.pipelineKeyTables.set(cache, keys);}
            keys.reference(descriptor.vertex.module);
            if (descriptor.fragment) keys.reference(descriptor.fragment.module);
            return keys.key([descriptor, identity]);
        },

        // 32-bit float targets blend only with float32-blendable; without it
        // the draw replaces (review S1-2k: the pipeline was rejected)
        blendable(format) {
            if (!/^(r|rg|rgba)32float$/.test(format) ||
                    (this.deviceFeatures && this.deviceFeatures.float32Blendable)) return true;
            this.warnOnce("float32-blend", "this device cannot blend into 32-bit float " +
                "colour buffers: those draws are not blended", { format });
            return false;
        },

        shaderModule(wgsl) {
            let module = this.moduleCache.get(wgsl);
            if (!module) {
                module = this.device.createShaderModule({ code: wgsl });
                this.moduleCache.set(wgsl, module);
            }
            return module;
        },

        /* ---- bind groups ---- */

        /*
         * Group 1 holds the uniform buffers, group 2 the textures and samplers.
         * The layouts come from the pipeline's automatic layout, so a group the
         * entry points do not statically use is not created or bound.  Merely
         * scanning declarations is insufficient: WebGPU omits a binding which
         * is read only by an uncalled GLSL helper function.
         */
        buildBindGroups(pipeline, shaders) {
            const activeBindings = pipeline.glActiveBindings ||
                (pipeline.glActiveBindings = activeShaderBindings(
                    shaders.wgslVertex, shaders.wgslFragment));
            const bindingIsActive = (group, binding) =>
                activeBindings.has(group + ":" + binding);
            let layout = this.stateUniformLayouts.get(shaders.stateFields);
            if (!layout) {
                layout = stateLayout.buildLayout(shaders.stateFields);
                this.stateUniformLayouts.set(shaders.stateFields, layout);
            }
            const stateSlice = bindingIsActive(1, 0) ?
                this.writeStateUniforms(layout, shaders) : null;
            if (bindingIsActive(1, 0) && !stateSlice) return null;
            // binding 1 is the GLSL program's uniform block, or the ARB
            // vertex program's parameters; binding 2 only ever holds an ARB
            // fragment program's.
            const bindingSlices = shaders.kind === "arb" ?
                this.writeARBParameters(shaders, activeBindings) :
                { 1: !bindingIsActive(1, 1) ? null : shaders.kind === "program" ?
                    this.writeProgramUniforms(shaders) :
                    this.writeEmptyUniforms() };
            if (!bindingSlices || (shaders.kind !== "arb" &&
                    bindingIsActive(1, 1) && !bindingSlices[1]))
                return null;

            const groups = [];
            try {
                const uniformEntries = [];
                if (bindingIsActive(1, 0)) {
                    uniformEntries.push({ binding: 0,
                        resource: { buffer: stateSlice.buffer,
                            offset: stateSlice.offset, size: stateSlice.size } });
                }
                for (const binding of [1, 2]) {
                    if (!bindingIsActive(1, binding)) continue;
                    const slice = bindingSlices[binding];
                    if (!slice)
                        return this.refuse("draw", "a shader reads a uniform " +
                            "binding nothing was written for",
                            { binding, shader: shaders.key },
                            GL.INVALID_OPERATION);
                    uniformEntries.push({ binding,
                        resource: { buffer: slice.buffer,
                            offset: slice.offset, size: slice.size } });
                }
                if (uniformEntries.length) {
                    groups.push({
                        index: 1,
                        group: this.cachedBindGroup(pipeline, 1, uniformEntries),
                    });
                }
                const textureEntries = this.textureBindEntries(shaders)
                    .filter(entry => bindingIsActive(2, entry.binding));
                if (textureEntries.length) {
                    groups.push({
                        index: 2,
                        group: this.cachedBindGroup(pipeline, 2, textureEntries),
                    });
                }
                if (!shaders.capture && this.current.enabled.has(GL.COLOR_LOGIC_OP) &&
                        this.current.logicOp !== GL.COPY) {
                    const views = this.logicTargetViews || [];
                    const logicEntries = Array.from({
                        length: shaders.colorTargets || 1,
                    }, (unused, binding) => ({
                        binding,
                        resource: views[binding] || views[0] ||
                            this.fallbackView,
                    })).filter(entry => bindingIsActive(3, entry.binding));
                    if (logicEntries.length) {
                        groups.push({
                            index: 3,
                            group: this.cachedBindGroup(pipeline, 3, logicEntries),
                        });
                    }
                }
            } catch (error) {
                this.refuse("draw", "could not build the bind groups",
                    { message: String(error), shader: shaders.key },
                    GL.INVALID_OPERATION);
                return null;
            }
            if (groups.some(entry => !entry.group)) {
                this.refuse("draw", "WebGPU rejected a bind group of this draw", { shader: shaders.key });
                return null;
            }
            return groups;
        },

        resourceId(object) {
            let id = this.resourceIds.get(object);
            if (!id) {
                id = this.nextResourceId++;
                this.resourceIds.set(object, id);
            }
            return id;
        },

        /*
         * A depth texture sampled without comparison (review S1-2j: WebGPU
         * binds depth only to depth bindings): a colour copy of its levels
         * with DEPTH_TEXTURE_MODE applied, made again when the depth has
         * changed. rgba32float where the device filters it, rgba16float
         * elsewhere.
         */
        depthColorView(object, item) {
            const gpuTexture = this.ensureTextureUploaded(object);
            if (!gpuTexture || object.kind === "3D") return null;
            const mode = object.sampler.depthTextureMode;
            const format = this.deviceFeatures && this.deviceFeatures.float32Filterable ?
                "rgba32float" : "rgba16float";
            const layers = object.kind === "Cube" ? 6 : 1;
            const stamp = object.depthGeneration + ":" + mode;
            let copy = object.depthColor;
            if (!copy || copy.source !== gpuTexture || copy.format !== format) {
                if (copy) this.retire(copy.texture);
                copy = object.depthColor = { source: gpuTexture, format, stamp: null, views: new Map(),
                    texture: this.createGPUTexture({ label: "GL depth texture as colour " + object.name,
                        size: { width: object.gpuWidth, height: object.gpuHeight, depthOrArrayLayers: layers },
                        mipLevelCount: object.gpuLevels, format,
                        usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_TEXTURE_BINDING }) };
            }
            if (copy.stamp !== stamp) {
                const pipeline = this.depthColorPipeline(format, mode);
                if (!pipeline) return null;
                this.endPass();
                const encoder = this.ensureEncoder();
                for (let level = 0; level < object.gpuLevels; ++level) {
                    for (let layer = 0; layer < layers; ++layer) {
                        const subresource = { dimension: "2d", baseMipLevel: level, mipLevelCount: 1,
                            baseArrayLayer: layer, arrayLayerCount: 1 };
                        const pass = encoder.beginRenderPass({ label: "GL depth texture as colour",
                            colorAttachments: [{ view: copy.texture.createView(subresource),
                                loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
                        pass.setPipeline(pipeline);
                        pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
                            entries: [{ binding: 0, resource: gpuTexture.createView({ ...subresource,
                                aspect: "depth-only" }) }] }));
                        pass.draw(3);
                        pass.end();
                    }
                }
                copy.stamp = stamp;
            }
            const kind = item.target === "Cube" || object.kind === "Cube" ? "cube" : "2d";
            const base = clamp(object.sampler.baseLevel, 0, object.gpuLevels - 1);
            const count = clamp(object.sampler.maxLevel - base + 1, 1, object.gpuLevels - base);
            const key = kind + ":" + base + ":" + count;
            if (!copy.views.has(key))
                copy.views.set(key, copy.texture.createView({ dimension: kind, baseMipLevel: base, mipLevelCount: count }));
            return copy.views.get(key);
        },

        depthColorPipeline(format, mode) {
            this.depthColorPipelines = this.depthColorPipelines || new Map();

            // GL 2.1 section 3.8.14: the depth as LUMINANCE, INTENSITY or ALPHA
            const value = mode === GL.INTENSITY ? "vec4<f32>(d)" : mode === GL.ALPHA ?
                "vec4<f32>(0.0, 0.0, 0.0, d)" : "vec4<f32>(d, d, d, 1.0)";
            const module = this.shaderModule(`
@group(0) @binding(0) var depthTexture : texture_depth_2d;
@vertex fn vs_main(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) p : vec4<f32>) -> @location(0) vec4<f32> {
    let d = textureLoad(depthTexture, vec2<i32>(p.xy), 0);
    return ${value};
}`);
            const descriptor = { label: "GL depth texture as colour", layout: "auto",
                    vertex: { module, entryPoint: "vs_main" },
                    fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
                    primitive: { topology: "triangle-list" } };
            const key = this.renderPipelineKey(this.depthColorPipelines, descriptor);
            const pipeline = this.depthColorPipelines.get(key);
            return pipeline || this.createPipeline(this.depthColorPipelines, key, descriptor);
        },

        /*
         * An incomplete or missing texture samples as opaque black, through a
         * view of the binding's dimension and sample type (review S1-2a: one
         * 2D colour view was bound to cube, 3D and depth bindings, which
         * lost the frame).
         */
        fallbackViewFor(item) {
            const target = String(item.target || "2D").toUpperCase();
            const dimension = target === "CUBE" ? "cube" : (target === "3D" ? "3d" : "2d");
            const key = dimension + (item.shadow ? ":depth" : "");
            let view = this.fallbackViews.get(key);
            if (view) return view;
            const layers = dimension === "cube" ? 6 : 1;
            const texture = this.createGPUTexture({
                label: "GL incomplete-texture fallback " + key,
                size: { width: 1, height: 1, depthOrArrayLayers: layers },
                dimension: dimension === "3d" ? "3d" : "2d",
                format: item.shadow ? "depth32float" : "rgba8unorm",
                usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
            });
            if (!item.shadow) {
                const black = new Uint8Array(4 * layers);
                for (let i = 3; i < black.length; i += 4) black[i] = 255;
                this.device.queue.writeTexture({ texture }, black, { bytesPerRow: 4, rowsPerImage: 1 },
                    { width: 1, height: 1, depthOrArrayLayers: layers });
            }
            view = texture.createView({ dimension });
            this.fallbackViews.set(key, view);
            return view;
        },

        cachedBindGroup(pipeline, index, entries) {
            // Automatic layouts are pipeline-specific. Key by actual view /
            // sampler / GPUBuffer identity, never by a recyclable GL name.
            const key = this.resourceId(pipeline) + ":" + index + ":" +
                entries.map(entry => {
                    const r = entry.resource;
                    return entry.binding + ":" + (r.buffer ?
                        [this.resourceId(r.buffer), r.offset || 0, r.size].join("/") :
                        this.resourceId(r));
                }).join("|");
            let group = this.bindGroupCache.get(key);
            if (!group) {
                if (this.bindGroupCache.size >= 2048) this.bindGroupCache.clear();
                group = this.resources.checked(this.gpuErrors, "bind group", this.bindGroupCache, key,
                    () => this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(index), entries }));
                ++this.stats.bindGroups;
            }
            return group;
        },

        textureBindEntries(shaders) {
            const entries = [];
            if (shaders.textures) {
                for (const item of shaders.textures) {
                    const unitState = this.current.textureUnits[item.unit];
                    // a fragment program samples the target its instruction
                    // names, whatever is enabled (review S2-52)
                    const target = item.arbTarget ? { enumValue: ARB_TEXTURE_TARGETS[item.target] } :
                        this.effectiveTarget(unitState);
                    const object = target && target.enumValue ?
                        this.textureObjectFor(item.unit, target.enumValue) : null;
                    entries.push({ binding: item.textureBinding,
                                   resource: this.textureViewFor(object, item) });
                    entries.push({ binding: item.samplerBinding,
                                   resource: this.samplerFor(object, item.shadow) });
                }
                if (shaders.kind === "ff" || shaders.kind === "arb") return entries;
            }
            const program = shaders.program;
            for (const sampler of shaders.reflection.samplers) {
                const count = Math.max(1, sampler.arraySize);
                for (let i = 0; i < count; ++i) {
                    const key = sampler.name +
                        (sampler.arraySize ? "[" + i + "]" : "");
                    const unit = program.samplerUnits.get(key) || 0;
                    const unitState = this.current.textureUnits[
                        clamp(unit, 0, MAX_TEXTURE_UNITS - 1)];
                    const targetEnum = samplerTargetEnum(sampler.dim);
                    const object = unitState ? this.textureObjectFor(clamp(unit, 0, MAX_TEXTURE_UNITS - 1), targetEnum) : null;
                    entries.push({ binding: sampler.binding + i * 2,
                                   resource: this.textureViewFor(object,
                                       { target: sampler.dim, shadow: sampler.shadow }) });
                    entries.push({ binding: sampler.binding + i * 2 + 1,
                                   resource: this.samplerFor(object, sampler.shadow) });
                }
            }
            return entries;
        },

        textureViewFor(object, item) {
            if (!object || !this.textureIsComplete(object)) return this.fallbackViewFor(item);
            const depth = /^depth/.test(object.gpuFormat);
            if (depth && !item.shadow) return this.depthColorView(object, item) || this.fallbackViewFor(item);
            if (!depth && item.shadow) {
                // GL's results are undefined; WebGPU binds no colour texture
                // to a comparison sampler
                this.warnOnce("texture-sample-type", "a shadow sampler reads a colour texture",
                    { format: object.gpuFormat });
                return this.fallbackViewFor(item);
            }
            const gpuTexture = this.ensureTextureUploaded(object);
            if (!gpuTexture) return this.fallbackViewFor(item);
            const kind = item.target === "Cube" || object.kind === "Cube" ?
                "cube" : (object.kind === "3D" ? "3d" : "2d");
            const key = kind + ":" + object.sampler.baseLevel + ":" +
                object.sampler.maxLevel;
            let view = object.viewCache.get(key);
            if (!view) {
                const baseMipLevel = clamp(object.sampler.baseLevel, 0,
                    object.gpuLevels - 1);
                const mipLevelCount = clamp(
                    object.sampler.maxLevel - baseMipLevel + 1, 1,
                    object.gpuLevels - baseMipLevel);
                view = gpuTexture.createView({
                    dimension: kind,
                    baseMipLevel, mipLevelCount,
                });
                object.viewCache.set(key, view);
            }
            return view;
        },

        samplerFor(object, shadow) {
            if (!object) return shadow ? this.fallbackComparisonSampler :
                this.fallbackSampler;
            const sampler = object.sampler;
            const key = [
                sampler.minFilter, sampler.magFilter,
                sampler.wrapS, sampler.wrapT, sampler.wrapR,
                sampler.maxAnisotropy, sampler.minLod, sampler.maxLod,
                shadow ? sampler.compareFunc : "-",
            ].join("|");
            let gpuSampler = this.samplerCache.get(key);
            if (!gpuSampler) {
                const minLinear = sampler.minFilter === GL.LINEAR ||
                    sampler.minFilter === GL.LINEAR_MIPMAP_NEAREST ||
                    sampler.minFilter === GL.LINEAR_MIPMAP_LINEAR;
                const mipLinear = sampler.minFilter === GL.NEAREST_MIPMAP_LINEAR ||
                    sampler.minFilter === GL.LINEAR_MIPMAP_LINEAR;
                const magLinear = sampler.magFilter === GL.LINEAR;
                // WebGPU rejects anisotropy unless all three filters are
                // linear, so it is clamped rather than the sampler refused.
                const anisotropy = (minLinear && magLinear && mipLinear) ?
                    clamp(Math.round(sampler.maxAnisotropy), 1, 16) : 1;
                const maxLod = clamp(sampler.maxLod, 0, 32), minLod = Math.min(maxLod, clamp(sampler.minLod, 0, 32));
                gpuSampler = this.device.createSampler({
                    addressModeU: ADDRESS_MODES[sampler.wrapS] || "repeat",
                    addressModeV: ADDRESS_MODES[sampler.wrapT] || "repeat",
                    addressModeW: ADDRESS_MODES[sampler.wrapR] || "repeat",
                    magFilter: magLinear ? "linear" : "nearest",
                    minFilter: minLinear ? "linear" : "nearest",
                    mipmapFilter: mipLinear ? "linear" : "nearest",
                    lodMinClamp: minLod,
                    lodMaxClamp: maxLod,
                    maxAnisotropy: anisotropy,
                    ...(shadow ? {
                        compare: COMPARE_FUNCTIONS[sampler.compareFunc] ||
                            "less-equal",
                    } : {}),
                });
                this.samplerCache.set(key, gpuSampler);
            }
            return gpuSampler;
        },
    });

    /*
     * Which axes of a texture read its border colour (the fixed pipeline's
     * signature, normalizeBorder): CLAMP_TO_BORDER always, GL_CLAMP under a
     * linear filter, where texels past the edge are the border's (GL 2.1
     * section 3.8.8). The filter is the magnification one's.
     */
    function textureBorder(object, kind) {
        if (!object || kind === "Cube") return null;
        const sampler = object.sampler;
        const linear = sampler.magFilter === GL.LINEAR;
        const mode = wrap => wrap === GL.CLAMP_TO_BORDER ? "border" :
            (wrap === GL.CLAMP && linear ? "clamp" : null);
        const border = { s: mode(sampler.wrapS), t: kind === "1D" ? null : mode(sampler.wrapT),
            r: kind === "3D" ? mode(sampler.wrapR) : null, linear,
            compare: sampler.compareMode === GL.COMPARE_R_TO_TEXTURE ?
                ALPHA_TEST_NAMES[sampler.compareFunc] || "lequal" : null };
        return border.s || border.t || border.r ? border : null;
    }

    // GL 2.1 table 3.15: the border colour's channels as the base format keeps them
    function borderInFormat(color, baseFormat) {
        const [r, g, b, a] = color;
        switch (baseFormat) {
        case "ALPHA": return [0, 0, 0, a];
        case "LUMINANCE": case "DEPTH": return [r, r, r, 1];
        case "LUMINANCE_ALPHA": return [r, r, r, a];
        case "INTENSITY": return [r, r, r, r];
        case "RGB": return [r, g, b, 1];
        default: return [r, g, b, a];
        }
    }

    function samplerTargetEnum(dim) {
        switch (dim) {
        case "1D": return GL.TEXTURE_1D;
        case "3D": return GL.TEXTURE_3D;
        case "Cube": return GL.TEXTURE_CUBE_MAP;
        default: return GL.TEXTURE_2D;
        }
    }

    function isIdentity(m) {
        for (let i = 0; i < 16; ++i) {
            const expected = (i % 5 === 0) ? 1 : 0;
            if (m[i] !== expected) return false;
        }
        return true;
    }

    function gpuBlendState(s) {
        const b = s.blend;
        // GL's MIN and MAX ignore the factors; WebGPU requires them to be ONE
        // (review S1-2b: the default ONE, ZERO lost the frame)
        const component = (src, dst, equation) => {
            const operation = BLEND_EQUATIONS[equation] || "add";
            const minMax = operation === "min" || operation === "max";
            return { srcFactor: minMax ? "one" : BLEND_FACTORS[src] || "one",
                     dstFactor: minMax ? "one" : BLEND_FACTORS[dst] || "zero", operation };
        };
        return {
            color: component(b.srcRGB, b.dstRGB, b.equationRGB),
            alpha: component(b.srcAlpha, b.dstAlpha, b.equationAlpha),
        };
    }

    /*
     * WebGPU has one stencil read mask and one write mask for both faces; GL
     * has a pair each. Divergent polygons use two culled draws per primitive
     * in original order; only the draw for the actual face rasterizes.
     */
    function gpuStencilState(s, side) {
        if (!s.enabled.has(GL.STENCIL_TEST)) {
            const disabled = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" };
            return { stencilFront: disabled, stencilBack: disabled, stencilReadMask: 0xFFFFFFFF, stencilWriteMask: 0 };
        }

        const f = s.stencil[side || "front"], b = side ? f : s.stencil.back;
        const face = state => ({
            compare: COMPARE_FUNCTIONS[state.func] || "always",
            failOp: STENCIL_OPERATIONS[state.fail] || "keep",
            depthFailOp: STENCIL_OPERATIONS[state.zfail] || "keep",
            passOp: STENCIL_OPERATIONS[state.zpass] || "keep",
        });
        return {
            stencilFront: face(f),
            stencilBack: face(b),
            stencilReadMask: f.valueMask >>> 0,
            stencilWriteMask: f.writeMask >>> 0,
        };
    }

    function stencilMasksDiverge(s) {
        const f = s.stencil.front, b = s.stencil.back;
        return f.valueMask !== b.valueMask || f.writeMask !== b.writeMask || f.ref !== b.ref;
    }

    /* ================================================================== */
    /* Executor: uniform upload                                           */
    /* ================================================================== */

    Object.assign(GLWebGPUExecutor.prototype, {

        allocateUniform(byteCount) {
            // WebGPU requires a uniform binding offset to be 256-aligned.
            const size = alignUp(Math.max(16, byteCount), 256);
            if (size > this.uniformCapacity) {
                this.refuse("draw", "uniform block exceeds the ring capacity",
                    { size }, GL.OUT_OF_MEMORY);
                return null;
            }
            if (this.uniformCursor + size > this.uniformCapacity)
                this.rotateUploadPage("uniform");
            const offset = this.uniformCursor;
            this.uniformCursor = offset + size;
            return { buffer: this.uniformRing, offset, size };
        },

        /*
         * The GL state block. Only the fields the shader actually reads are
         * uploaded, so a 2D blit costs sixteen floats rather than the seven
         * hundred the full table would.
         */
        writeStateUniforms(layout, shaders) {
            const floats = layout.uniformScratch ||
                (layout.uniformScratch = new Float32Array(layout.floats));
            floats.fill(0);
            const snapshot = this.stateSnapshot(shaders);
            stateLayout.writeLayout(layout, snapshot, floats, 0);
            return this.writeUniformSnapshot("state:" + this.resourceId(layout),
                new Uint8Array(floats.buffer));
        },

        writeEmptyUniforms() {
            return this.writeUniformSnapshot("empty", new Uint8Array(16));
        },

        writeUniformSnapshot(key, bytes) {
            const cached = this.uniformValueCache.get(key);
            if (cached && cached.bytes.length === bytes.length) {
                let i = 0;
                while (i < bytes.length && cached.bytes[i] === bytes[i]) ++i;
                if (i === bytes.length) return cached.slice;
            }
            const slice = this.allocateUniform(Math.max(16, bytes.byteLength));
            if (!slice) return null;
            this.uniformStaging.fill(0, slice.offset, slice.offset + slice.size);
            this.uniformStaging.set(bytes, slice.offset);
            this.device.queue.writeBuffer(slice.buffer, slice.offset,
                this.uniformStaging, slice.offset, slice.size);
            if (this.uniformValueCache.size >= 256) this.uniformValueCache.clear();
            // Never update an earlier draw's slice in place. Compare bytes,
            // including integer uniforms, so context switches and every setter
            // are covered without relying on an incomplete dirty-state list.
            this.uniformValueCache.set(key, { bytes: bytes.slice(), slice });
            return slice;
        },

        /*
         * env then local for one program, in the shape its generated shader
         * declares. Each stage gets its own block: program.env and
         * program.local are per-program namespaces, so a bound vertex and
         * fragment program hold different values at the same index, and
         * folding them into one block left the vertex stage reading the
         * fragment program's parameters -- silently, since nothing about the
         * draw is invalid.
         */
        writeARBProgramParameters(program, target) {
            const count = arbProgram.MAX_PROGRAM_PARAMETERS * 4;
            const floats = program.parameterScratch ||
                (program.parameterScratch = new Float32Array(count * 2));
            floats.set(this.arbEnvironment(target), 0);
            floats.set(program.local.subarray(0, count), count);
            return this.writeUniformSnapshot("arb:" + this.resourceId(program),
                new Uint8Array(floats.buffer));
        },

        /* One slice per stage that declared a parameter block, keyed by the
         * binding its shader reads. */
        writeARBParameters(shaders, activeBindings) {
            const slices = {};
            const stages = [["vertex", shaders.arbVertex, shaders.wgslVertex],
                            ["fragment", shaders.arbFragment, shaders.wgslFragment]];
            for (const [stage, program, wgsl] of stages) {
                const binding = arbProgram.PARAMETER_BINDING[stage];
                if (activeBindings && !activeBindings.has("1:" + binding)) continue;
                if (wgsl.indexOf("@group(1) @binding(" + binding + ")") < 0)
                    continue;
                if (!program || !program.env || !program.local)
                    return this.refuse("draw", "ARB parameter storage is missing",
                        { stage }, GL.INVALID_OPERATION);
                const slice = this.writeARBProgramParameters(program,
                    stage === "vertex" ? GL.VERTEX_PROGRAM_ARB : GL.FRAGMENT_PROGRAM_ARB);
                if (!slice) return null;
                slices[binding] = slice;
            }
            return slices;
        },

        writeProgramUniforms(shaders) {
            const program = shaders.program;
            const bytes = Math.max(16, shaders.uniformBytes);
            const data = program.uniformData.byteLength >= bytes ?
                program.uniformData.subarray(0, bytes) : new Uint8Array(bytes);
            if (data.buffer !== program.uniformData.buffer)
                data.set(program.uniformData);
            return this.writeUniformSnapshot("program:" + this.resourceId(program), data);
        },

        /*
         * Builds the plain-object view of GL state that gl_state_layout.js
         * writes from. The derived quantities -- the scene colour, the light
         * products, each light's half vector -- are computed here rather than
         * in the shader, because they depend only on state the CPU already has
         * and would otherwise be recomputed per vertex.
         */
        stateSnapshot(shaders) {
            const s = this.current;
            const snapshot = this.snapshot || (this.snapshot = {
                matrices: {
                    modelview: new Float32Array(16),
                    projection: new Float32Array(16),
                    mvp: new Float32Array(16),
                    normal: new Float32Array(9),
                    modelviewInverse: new Float32Array(16),
                    modelviewTranspose: new Float32Array(16),
                    modelviewInverseTranspose: new Float32Array(16),
                    projectionInverse: new Float32Array(16),
                    projectionTranspose: new Float32Array(16),
                    projectionInverseTranspose: new Float32Array(16),
                    mvpInverse: new Float32Array(16),
                    mvpTranspose: new Float32Array(16),
                    mvpInverseTranspose: new Float32Array(16),
                    ...Object.fromEntries(["program", "programInverse", "programTranspose", "programInverseTranspose"].map(name =>
                        [name, Array.from({ length: glCaps.LIMITS.MAX_PROGRAM_MATRICES }, () => new Float32Array(16))])),
                    texture: Array.from({ length: MAX_TEXTURE_COORDS },
                        () => new Float32Array(16)),
                    textureInverse: Array.from({ length: MAX_TEXTURE_COORDS },
                        () => new Float32Array(16)),
                    textureTranspose: Array.from({ length: MAX_TEXTURE_COORDS },
                        () => new Float32Array(16)),
                    textureInverseTranspose: Array.from(
                        { length: MAX_TEXTURE_COORDS }, () => new Float32Array(16)),
                },
                lights: Array.from({ length: MAX_LIGHTS }, () => ({
                    ambient: new Float32Array(4), diffuse: new Float32Array(4),
                    specular: new Float32Array(4), position: new Float32Array(4),
                    halfVector: new Float32Array(4),
                    spotDirection: new Float32Array(3),
                    spotExponent: 0, spotCutoff: 180, spotCosCutoff: -1,
                    constantAttenuation: 1, linearAttenuation: 0,
                    quadraticAttenuation: 0,
                })),
                material: { front: null, back: null },
                lightModel: { ambient: new Float32Array(4) },
                derived: {
                    frontSceneColor: new Float32Array(4),
                    backSceneColor: new Float32Array(4),
                    frontLightProduct: Array.from({ length: MAX_LIGHTS }, () => ({
                        ambient: new Float32Array(4),
                        diffuse: new Float32Array(4),
                        specular: new Float32Array(4),
                    })),
                    backLightProduct: Array.from({ length: MAX_LIGHTS }, () => ({
                        ambient: new Float32Array(4),
                        diffuse: new Float32Array(4),
                        specular: new Float32Array(4),
                    })),
                },
                fog: { color: new Float32Array(4), density: 1, start: 0, end: 1 },
                texEnvColor: Array.from({ length: MAX_TEXTURE_UNITS },
                    () => new Float32Array(4)),
                textureLodBias: new Float32Array(MAX_TEXTURE_UNITS),
                textureBorderColor: Array.from({ length: MAX_TEXTURE_UNITS },
                    () => new Float32Array(4)),
                texGen: Array.from({ length: MAX_TEXTURE_UNITS }, () =>
                    Array.from({ length: 4 }, () => ({
                        objectPlane: new Float32Array(4),
                        eyePlane: new Float32Array(4),
                    }))),
                clipPlanes: Array.from({ length: MAX_CLIP_PLANES },
                    () => new Float32Array(4)),
                depthRange: { near: 0, far: 1 },
                point: { size: 1, sizeMin: 0, sizeMax: 64, fadeThreshold: 1,
                         attenuation: new Float32Array(3) },
                alphaRef: 0,
                viewport: { x: 0, y: 0, width: 1, height: 1 },
                lineWidth: 1,
                lineStipple: { pattern: 0xffff, factor: 1 },
                polygonStippleEnabled: false,
                polygonStipple: new Uint8Array(128),
            });

            const modelview = this.topOf(GL.MODELVIEW);
            const projection = this.topOf(GL.PROJECTION);
            snapshot.matrices.modelview.set(modelview);
            snapshot.matrices.projection.set(projection);
            multiply4(projection, modelview, snapshot.matrices.mvp);
            normalMatrixOf(modelview, snapshot.matrices.normal);

            // The inverse and transpose variants are only produced when a
            // shader named one; they are four 4x4 inversions each otherwise.
            const wants = new Set(shaders.stateFields);
            if (wants.has("modelviewInverse") || wants.has("modelviewInverseTranspose")) {
                invert4(modelview, snapshot.matrices.modelviewInverse);
                if (wants.has("modelviewInverseTranspose"))
                    transpose4(snapshot.matrices.modelviewInverse,
                        snapshot.matrices.modelviewInverseTranspose);
            }
            if (wants.has("modelviewTranspose"))
                transpose4(modelview, snapshot.matrices.modelviewTranspose);
            if (wants.has("projectionInverse") || wants.has("projectionInverseTranspose")) {
                invert4(projection, snapshot.matrices.projectionInverse);
                if (wants.has("projectionInverseTranspose"))
                    transpose4(snapshot.matrices.projectionInverse,
                        snapshot.matrices.projectionInverseTranspose);
            }
            if (wants.has("projectionTranspose"))
                transpose4(projection, snapshot.matrices.projectionTranspose);
            if (wants.has("mvpInverse") || wants.has("mvpInverseTranspose")) {
                invert4(snapshot.matrices.mvp, snapshot.matrices.mvpInverse);
                if (wants.has("mvpInverseTranspose"))
                    transpose4(snapshot.matrices.mvpInverse,
                        snapshot.matrices.mvpInverseTranspose);
            }
            if (wants.has("mvpTranspose"))
                transpose4(snapshot.matrices.mvp, snapshot.matrices.mvpTranspose);

            for (let i = 0; i < MAX_TEXTURE_COORDS; ++i) {
                const m = this.textureMatrixOf(i);
                snapshot.matrices.texture[i].set(m);
                if (wants.has("textureMatrixInverse") ||
                        wants.has("textureMatrixInverseTranspose")) {
                    invert4(m, snapshot.matrices.textureInverse[i]);
                    if (wants.has("textureMatrixInverseTranspose"))
                        transpose4(snapshot.matrices.textureInverse[i],
                            snapshot.matrices.textureInverseTranspose[i]);
                }
                if (wants.has("textureMatrixTranspose"))
                    transpose4(m, snapshot.matrices.textureTranspose[i]);
            }

            for (let i = 0; i < glCaps.LIMITS.MAX_PROGRAM_MATRICES; ++i) {
                const m = this.topOf(GL.MATRIX0_ARB + i);
                if (wants.has("programMatrix")) snapshot.matrices.program[i].set(m);
                if (wants.has("programMatrixInverse") || wants.has("programMatrixInverseTranspose")) {
                    invert4(m, snapshot.matrices.programInverse[i]);
                    if (wants.has("programMatrixInverseTranspose")) transpose4(snapshot.matrices.programInverse[i], snapshot.matrices.programInverseTranspose[i]);
                }
                if (wants.has("programMatrixTranspose")) transpose4(m, snapshot.matrices.programTranspose[i]);
            }

            for (let i = 0; i < MAX_LIGHTS; ++i) {
                const light = s.lights[i];
                const out = snapshot.lights[i];
                out.ambient.set(light.ambient);
                out.diffuse.set(light.diffuse);
                out.specular.set(light.specular);
                out.position.set(light.eyePosition);
                out.spotDirection.set(light.eyeSpotDirection);
                out.spotExponent = light.spotExponent;
                out.spotCutoff = light.spotCutoff;
                out.spotCosCutoff = light.spotCutoff === 180 ? -1 :
                    Math.cos(light.spotCutoff * Math.PI / 180);
                out.constantAttenuation = light.constantAttenuation;
                out.linearAttenuation = light.linearAttenuation;
                out.quadraticAttenuation = light.quadraticAttenuation;
                // gl_LightSource[i].halfVector, for the infinite-viewer case
                // the GL spec defines it in: normalize(normalize(P) + (0,0,1)).
                const px = light.eyePosition[0], py = light.eyePosition[1];
                const pz = light.eyePosition[2];
                const len = Math.sqrt(px * px + py * py + pz * pz) || 1;
                const hx = px / len, hy = py / len, hz = pz / len + 1;
                const hlen = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
                out.halfVector[0] = hx / hlen;
                out.halfVector[1] = hy / hlen;
                out.halfVector[2] = hz / hlen;
                out.halfVector[3] = 0;
            }

            snapshot.material.front = s.material.front;
            snapshot.material.back = s.material.back;
            snapshot.lightModel.ambient.set(s.lightModel.ambient);

            for (const [face, key] of [["front", "frontSceneColor"],
                    ["back", "backSceneColor"]]) {
                const material = s.material[face];
                const out = snapshot.derived[key];
                for (let c = 0; c < 3; ++c)
                    out[c] = material.emission[c] +
                        material.ambient[c] * s.lightModel.ambient[c];
                out[3] = material.diffuse[3];
            }
            for (const [face, key] of [["front", "frontLightProduct"],
                    ["back", "backLightProduct"]]) {
                const material = s.material[face];
                for (let i = 0; i < MAX_LIGHTS; ++i) {
                    const light = s.lights[i];
                    const product = snapshot.derived[key][i];
                    for (let c = 0; c < 4; ++c) {
                        product.ambient[c] = material.ambient[c] * light.ambient[c];
                        product.diffuse[c] = material.diffuse[c] * light.diffuse[c];
                        product.specular[c] = material.specular[c] * light.specular[c];
                    }
                }
            }

            snapshot.fog.color.set(s.fog.color);
            snapshot.fog.density = s.fog.density;
            snapshot.fog.start = s.fog.start;
            snapshot.fog.end = s.fog.end;

            for (let i = 0; i < MAX_TEXTURE_UNITS; ++i) {
                snapshot.texEnvColor[i].set(s.textureUnits[i].env.color);
                const target = this.effectiveTarget(s.textureUnits[i]);
                const object = target ? this.textureObjectFor(i, target.enumValue) : null;
                snapshot.textureLodBias[i] = this.textureLodBias(i, object);
                snapshot.textureBorderColor[i].set(object ?
                    borderInFormat(object.sampler.borderColor, object.baseFormat) : [0, 0, 0, 0]);
                for (let c = 0; c < 4; ++c) {
                    snapshot.texGen[i][c].objectPlane.set(
                        s.textureUnits[i].texGen[c].objectPlane);
                    snapshot.texGen[i][c].eyePlane.set(
                        s.textureUnits[i].texGen[c].eyePlane);
                }
            }
            // the shaders test every plane below the highest enabled one, so
            // a disabled one passes everything: 0x + 0y + 0z + 1w >= 0
            // (review S2-10: plane 0 clipped while only plane 1 was enabled)
            for (let i = 0; i < MAX_CLIP_PLANES; ++i) {
                if (s.enabled.has(GL.CLIP_PLANE0 + i)) snapshot.clipPlanes[i].set(s.clipPlanes[i]);
                else snapshot.clipPlanes[i].set(PASSING_PLANE);
            }

            snapshot.depthRange.near = s.depthRange.near;
            snapshot.depthRange.far = s.depthRange.far;
            snapshot.point.size = s.point.size;
            snapshot.point.sizeMin = s.point.sizeMin;
            snapshot.point.sizeMax = s.point.sizeMax;
            snapshot.point.fadeThreshold = s.point.fadeThreshold;
            snapshot.point.attenuation.set(s.point.attenuation);
            snapshot.alphaRef = s.alphaFunc.ref;
            snapshot.viewport.x = s.viewport.x;
            snapshot.viewport.y = s.viewport.y;
            snapshot.viewport.width = Math.max(1, s.viewport.width);
            snapshot.viewport.height = Math.max(1, s.viewport.height);
            snapshot.lineWidth = s.lineWidth;
            snapshot.lineStipple.pattern = s.lineStipple.pattern;
            snapshot.lineStipple.factor = s.lineStipple.factor;
            snapshot.polygonStippleEnabled = s.enabled.has(GL.POLYGON_STIPPLE);
            snapshot.polygonStipple.set(s.polygonStipple);
            return snapshot;
        },
    });

    /* ================================================================== */
    /* Executor: present, framebuffers, readback, queries                 */
    /* ================================================================== */

    const PRESENT_WGSL = `
struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0) uv : vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) index : u32) -> VSOut {
    // One oversized triangle covers the target with no vertex buffer.
    var out : VSOut;
    let x = f32((index << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(index & 2u) * 2.0 - 1.0;
    out.position = vec4<f32>(x, y, 0.0, 1.0);
    // The back buffer's row 0 is GL's bottom row (plan 4.3), so presenting it
    // is where the image is turned the right way up -- once, here.
    out.uv = vec2<f32>(x * 0.5 + 0.5, y * 0.5 + 0.5);
    return out;
}

@group(0) @binding(0) var source : texture_2d<f32>;
@group(0) @binding(1) var sourceSampler : sampler;

@fragment
fn fs_main(inp : VSOut) -> @location(0) vec4<f32> {
    return textureSample(source, sourceSampler, inp.uv);
}
`;

    // the copy into a base format keeps the components it has (GL 2.1 table
    // 3.15: luminance and intensity from red); the rest read as 0 and 1
    const COPY_COMPONENTS = {
        RGB: "vec4<f32>(c.rgb, 1.0)", LUMINANCE: "vec4<f32>(c.rrr, 1.0)",
        LUMINANCE_ALPHA: "vec4<f32>(c.rrr, c.a)", INTENSITY: "c.rrrr",
        ALPHA: "vec4<f32>(0.0, 0.0, 0.0, c.a)",
    };
    const colorCopyWGSL = base => `
struct CopyParams {
    sourceOrigin : vec2<i32>,
    destinationOrigin : vec2<i32>,
}
@group(0) @binding(0) var sourceTexture : texture_2d<f32>;
@group(0) @binding(1) var<uniform> params : CopyParams;
@vertex fn vs_main(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) p : vec4<f32>) -> @location(0) vec4<f32> {
    let source = params.sourceOrigin + vec2<i32>(p.xy) - params.destinationOrigin;
    let c = textureLoad(sourceTexture, source, 0);
    return ${COPY_COMPONENTS[base] || "c"};
}
`;

    const MIPMAP_WGSL = `
@group(0) @binding(0) var sourceTexture : texture_2d<f32>;
@vertex fn vs_main(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) p : vec4<f32>) -> @location(0) vec4<f32> {
    let dimensions = vec2<i32>(textureDimensions(sourceTexture));
    let maximum = dimensions - vec2<i32>(1);
    let origin = vec2<i32>(p.xy) * 2;
    let a = textureLoad(sourceTexture, min(origin, maximum), 0);
    let b = textureLoad(sourceTexture,
        min(origin + vec2<i32>(1, 0), maximum), 0);
    let c = textureLoad(sourceTexture,
        min(origin + vec2<i32>(0, 1), maximum), 0);
    let d = textureLoad(sourceTexture,
        min(origin + vec2<i32>(1, 1), maximum), 0);
    return (a + b + c + d) * 0.25;
}
`;

    const COLOR_BLIT_WGSL = `
struct BlitParams {
    sourceOrigin : vec2<f32>,
    sourceExtent : vec2<f32>,
    destinationOrigin : vec2<f32>,
    destinationExtent : vec2<f32>,
}
@group(0) @binding(0) var sourceTexture : texture_2d<f32>;
@group(0) @binding(1) var sourceSampler : sampler;
@group(0) @binding(2) var<uniform> params : BlitParams;
@vertex fn vs_main(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) p : vec4<f32>) -> @location(0) vec4<f32> {
    let relative = (p.xy - params.destinationOrigin) / params.destinationExtent;
    let sourcePosition = params.sourceOrigin + relative * params.sourceExtent;
    let dimensions = vec2<f32>(textureDimensions(sourceTexture));
    return textureSampleLevel(sourceTexture, sourceSampler,
        sourcePosition / dimensions, 0.0);
}
`;

    Object.assign(GLWebGPUExecutor.prototype, {

        colorCopyPipeline(format, base) {
            this.colorCopyPipelines = this.colorCopyPipelines || new Map();

            const module = this.shaderModule(colorCopyWGSL(base));
            const descriptor = {
                    label: "GL colour format copy", layout: "auto",
                    vertex: { module, entryPoint: "vs_main" },
                    fragment: { module, entryPoint: "fs_main",
                                targets: [{ format }] },
                    primitive: { topology: "triangle-list" },
                };
            const key = this.renderPipelineKey(this.colorCopyPipelines, descriptor);
            const pipeline = this.colorCopyPipelines.get(key);
            return pipeline || this.createPipeline(this.colorCopyPipelines, key, descriptor);
        },

        mipmapPipeline(format) {
            this.mipmapPipelines = this.mipmapPipelines || new Map();
            const module = this.shaderModule(MIPMAP_WGSL);
            const descriptor = {
                    label: "GL mipmap generator", layout: "auto",
                    vertex: { module, entryPoint: "vs_main" },
                    fragment: { module, entryPoint: "fs_main",
                                targets: [{ format }] },
                    primitive: { topology: "triangle-list" },
                };
            const key = this.renderPipelineKey(this.mipmapPipelines, descriptor);
            const pipeline = this.mipmapPipelines.get(key);
            return pipeline || this.createPipeline(this.mipmapPipelines, key, descriptor);
        },

        colorBlitPipeline(format, samples = 1) {
            this.colorBlitPipelines = this.colorBlitPipelines || new Map();

            const module = this.shaderModule(COLOR_BLIT_WGSL);
            const descriptor = {
                    label: "GL colour blit", layout: "auto",
                    vertex: { module, entryPoint: "vs_main" },
                    fragment: { module, entryPoint: "fs_main",
                                targets: [{ format }] },
                    primitive: { topology: "triangle-list" },
                    multisample: { count: samples },
                };
            const key = this.renderPipelineKey(this.colorBlitPipelines, descriptor);
            const pipeline = this.colorBlitPipelines.get(key);
            return pipeline || this.createPipeline(this.colorBlitPipelines, key, descriptor);
        },

        blitColorTexture(source, destination, sx0, sy0, sx1, sy1,
                dx0, dy0, dx1, dy1, filter) {
            // (a multisampled window is drawn into and resolved, as a pass)
            const pipeline = this.colorBlitPipeline(destination.format, destination.resolveTarget ? 4 : 1);
            if (!pipeline) return false;
            const uniform = this.allocateUniform(32);
            if (!uniform) return false;
            new Float32Array(this.uniformStaging.buffer, uniform.offset, 8).set([
                sx0, sy0, sx1 - sx0, sy1 - sy0,
                dx0, dy0, dx1 - dx0, dy1 - dy0,
            ]);
            this.device.queue.writeBuffer(uniform.buffer, uniform.offset,
                this.uniformStaging, uniform.offset, uniform.size);
            const sampler = this.device.createSampler({
                minFilter: filter === GL.LINEAR ? "linear" : "nearest",
                magFilter: filter === GL.LINEAR ? "linear" : "nearest",
            });
            const sourceView = source.view || source.texture.createView({
                dimension: "2d", baseMipLevel: source.mipLevel || 0,
                mipLevelCount: 1, baseArrayLayer: source.layer || 0,
                arrayLayerCount: 1,
            });
            const left = Math.min(dx0, dx1), top = Math.min(dy0, dy1);
            const width = Math.abs(dx1 - dx0), height = Math.abs(dy1 - dy0);
            this.endPass();
            const pass = this.ensureEncoder().beginRenderPass({
                label: "GL scaled colour blit",
                colorAttachments: [{ view: destination.view, loadOp: "load", storeOp: "store",
                    ...(destination.resolveTarget ? { resolveTarget: destination.resolveTarget } : {}) }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: sourceView },
                    { binding: 1, resource: sampler },
                    { binding: 2, resource: { buffer: uniform.buffer,
                        offset: uniform.offset, size: uniform.size } },
                ],
            }));
            pass.setViewport(left, top, width, height, 0, 1);
            pass.setScissorRect(left, top, width, height);
            pass.draw(3);
            pass.end();
            return true;
        },

        generateTextureMipmapsGPU(texture) {
            const base = texture.levels[0] && texture.levels[0][0];
            if (!base) return false;
            if (texture.kind === "3D" || base.compressed ||
                    base.base === "DEPTH" || base.base === "COLOR_INDEX") {
                for (const list of texture.levels)
                    if (list) list.length = Math.min(1, list.length);
                return this.refuse("glGenerateMipmap",
                    "GPU-authored mipmaps are unsupported for this texture type",
                    { kind: texture.kind, format: base.gpuFormat },
                    GL.INVALID_OPERATION);
            }
            const pipeline = this.mipmapPipeline(base.gpuFormat);
            if (!pipeline) return false;
            const gpuTexture = this.ensureTextureUploaded(texture);
            if (!gpuTexture) return false;
            const layers = texture.kind === "Cube" ? 6 : 1;
            this.endPass();
            for (let layer = 0; layer < layers; ++layer) {
                const list = texture.levels[layer] || [];
                for (let level = 1; level < list.length; ++level) {
                    const sourceView = gpuTexture.createView({
                        dimension: "2d", baseMipLevel: level - 1,
                        mipLevelCount: 1, baseArrayLayer: layer,
                        arrayLayerCount: 1,
                    });
                    const destinationView = gpuTexture.createView({
                        dimension: "2d", baseMipLevel: level,
                        mipLevelCount: 1, baseArrayLayer: layer,
                        arrayLayerCount: 1,
                    });
                    const pass = this.ensureEncoder().beginRenderPass({
                        label: "GL mipmap level " + level,
                        colorAttachments: [{ view: destinationView,
                            loadOp: "clear", storeOp: "store",
                            clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
                    });
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({
                        layout: pipeline.getBindGroupLayout(0),
                        entries: [{ binding: 0, resource: sourceView }],
                    }));
                    pass.draw(3);
                    pass.end();
                }
            }
            texture.dirty = false;
            return true;
        },

        copyColorTexture(source, destination, sourceX, sourceY,
                destinationX, destinationY, width, height, loadOp) {
            if (!source || !destination || width <= 0 || height <= 0) return false;
            const pipeline = this.colorCopyPipeline(destination.format, destination.base);
            if (!pipeline) return false;
            const uniform = this.allocateUniform(16);
            if (!uniform) return false;
            const values = new Int32Array(this.uniformStaging.buffer,
                uniform.offset, 4);
            values.set([sourceX, sourceY, destinationX, destinationY]);
            this.device.queue.writeBuffer(uniform.buffer, uniform.offset,
                this.uniformStaging, uniform.offset, uniform.size);
            const sourceView = source.view || source.texture.createView({
                dimension: "2d", baseMipLevel: source.mipLevel || 0,
                mipLevelCount: 1, baseArrayLayer: source.layer || 0,
                arrayLayerCount: 1,
            });
            this.endPass();
            const pass = this.ensureEncoder().beginRenderPass({
                label: "GL colour copy pass",
                colorAttachments: [{ view: destination.view,
                    loadOp: loadOp || "load", storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: sourceView },
                    { binding: 1, resource: { buffer: uniform.buffer,
                        offset: uniform.offset, size: uniform.size } },
                ],
            }));
            pass.setViewport(destinationX, destinationY, width, height, 0, 1);
            pass.setScissorRect(destinationX, destinationY, width, height);
            pass.draw(3);
            pass.end();
            return true;
        },

        presentToCanvas() {
            if (!this.host || !this.host.context) return false;
            if (!this.presenterToken)
                this.presenterToken = this.host.claimPresenter("opengl");
            if (!this.host.canPresent(this.presenterToken)) return false;
            if (!this.backBuffer) return false;
            let swapTexture;
            try {
                swapTexture = this.host.context.getCurrentTexture();
            } catch (error) {
                this.warnOnce("present", "could not acquire the swap-chain texture",
                    { message: String(error) });
                return false;
            }
            if (!this.presentPipeline) {
                const module = this.shaderModule(PRESENT_WGSL);
                this.presentPipeline = this.createPipeline(this.singletonPipelines, "presentPipeline", {
                    label: "GL present",
                    layout: "auto",
                    vertex: { module, entryPoint: "vs_main" },
                    fragment: { module, entryPoint: "fs_main",
                                targets: [{ format: this.host.format }] },
                    primitive: { topology: "triangle-list" },
                });
                this.presentSampler = this.device.createSampler({
                    magFilter: "linear", minFilter: "linear",
                });
            }
            const encoder = this.ensureEncoder();
            const pass = encoder.beginRenderPass({
                label: "GL present pass",
                colorAttachments: [{
                    view: swapTexture.createView(),
                    loadOp: "clear",
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    storeOp: "store",
                }],
            });
            pass.setPipeline(this.presentPipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: this.presentPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.backBufferView },
                    { binding: 1, resource: this.presentSampler },
                ],
            }));
            pass.draw(3);
            pass.end();
            return true;
        },

        onSwapBuffers() {
            this.frontDrawn = false;
            this.finishFrame(true);
        },

        /* ---- framebuffer objects ---- */

        findFramebuffer(name) {
            const s = this.current, g = s.shareGroup;
            return s.privateFramebuffers.get(name) || g.sharedFramebuffers.get(name) || g.framebufferReservations.get(name) ||
                this.framebuffers.get(s.id).get(name);
        },

        namedFramebuffer(name) {
            const s = this.current, g = s.shareGroup;
            let object = this.findFramebuffer(name);
            if (!object) { object = createFramebuffer(name); g.framebufferReservations.set(name, object); }
            this.framebuffers.get(s.id).set(name, object); return object;
        },

        boundFramebufferObject(target) {
            const s = this.current, read = target === GL.READ_FRAMEBUFFER;
            return (read ? s.readFramebuffer : s.drawFramebuffer) ? framebufferState.owner(s, this.framebuffers.get(s.id), read) : null;
        },

        framebufferTexture(target, attachment, textarget, textureName, level, layer) {
            const s = this.current;
            const fbo = this.boundFramebufferObject(target);
            if (!fbo)
                return this.refuse("glFramebufferTexture2D",
                    "no framebuffer object is bound", { target },
                    GL.INVALID_OPERATION);
            const face = CUBE_FACE_INDEX[textarget];
            const record = textureName ? {
                kind: "texture", name: textureName, level: level | 0,
                imageId: s.shareGroup.textures.get(textureName)?.imageId,
                layer: face !== undefined ? face : (layer | 0),
            } : null;
            this.attachTo(fbo, attachment, record);
            this.endPass();
        },

        framebufferRenderbuffer(target, attachment, rbTarget, rbName) {
            const s = this.current;
            const fbo = this.boundFramebufferObject(target);
            if (!fbo)
                return this.refuse("glFramebufferRenderbuffer",
                    "no framebuffer object is bound", { target },
                    GL.INVALID_OPERATION);
            void rbTarget;
            this.attachTo(fbo, attachment,
                rbName ? { kind: "renderbuffer", name: rbName, level: 0, layer: 0,
                    imageId: s.shareGroup.renderbuffers.get(rbName)?.imageId } :
                    null);
            this.endPass();
        },

        attachTo(fbo, attachment, record) {
            if (attachment === GL.DEPTH_ATTACHMENT) fbo.depth = record;
            else if (attachment === GL.STENCIL_ATTACHMENT) fbo.stencil = record;
            else if (attachment === GL.DEPTH_STENCIL_ATTACHMENT) {
                fbo.depth = record;
                fbo.stencil = record;
            } else {
                const index = attachment - GL.COLOR_ATTACHMENT0;
                if (index < 0 || index >= MAX_DRAW_BUFFERS)
                    return this.refuse("glFramebufferTexture2D",
                        "attachment out of range", { attachment },
                        GL.INVALID_ENUM);
                fbo.color[index] = record;
            }
            const size = this.attachmentSize(record);
            if (size) { fbo.width = size.width; fbo.height = size.height; }
        },

        attachmentSize(record) {
            if (!record) return null;
            if (record.kind === "texture") {
                const texture = this.imageFor(record);
                const slot = texture && texture.levels[record.layer] &&
                    texture.levels[record.layer][record.level];
                return slot ? { width: slot.width, height: slot.height } : null;
            }
            const rb = this.imageFor(record);
            return rb ? { width: rb.width, height: rb.height } : null;
        },

        attachmentFormat(record) {
            if (!record) return null;
            if (record.kind === "texture") {
                const texture = this.imageFor(record);
                const slot = texture && texture.levels[record.layer] &&
                    texture.levels[record.layer][record.level];
                return slot ? slot.gpuFormat : null;
            }
            const rb = this.imageFor(record);
            return rb ? rb.gpuFormat : null;
        },

        renderbufferStorage(internalFormat, width, height) {
            const s = this.current;
            const rb = s.shareGroup.renderbufferImages.get(s.renderbufferImage);
            if (!rb)
                return this.refuse("glRenderbufferStorage",
                    "no renderbuffer is bound", {}, GL.INVALID_OPERATION);
            const storage = renderbufferFormatFor(internalFormat, this.deviceFeatures);
            if (!storage) return this.invalidState(GL.INVALID_ENUM);
            this.endPass();
            rb.width = width && height ? width : 0;
            rb.height = width && height ? height : 0;
            rb.internalFormat = width && height ? storage.internalFormat || internalFormat : GL.RGBA;
            rb.componentBits = width && height ? storage.components : [0, 0, 0, 0, 0, 0];
            // WebGPU has no renderbuffer: a texture with RENDER_ATTACHMENT is
            // the same thing with a different name.
            rb.gpuFormat = storage.gpu;
            this.retire(rb.gpuTexture);
            rb.gpuTexture = null;
            this.allocateRenderbuffer(rb);
        },

        allocateRenderbuffer(rb) {
            if (!rb.width || !rb.height) return;
            rb.gpuTexture = this.createGPUTexture({
                label: "GL renderbuffer " + rb.name,
                size: { width: rb.width, height: rb.height, depthOrArrayLayers: 1 },
                format: rb.gpuFormat,
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC |
                    TEXTURE_USAGE_TEXTURE_BINDING,
            });
        },

        /*
         * GL's completeness rules, answered from the executor's own state --
         * no GPU round trip, so the guest's blocking call returns immediately.
         */
        checkFramebufferStatus(target) {
            const s = this.current;
            const name = target === GL.READ_FRAMEBUFFER ?
                s.readFramebuffer : s.drawFramebuffer;
            if (!name) return GL.FRAMEBUFFER_COMPLETE;
            const fbo = this.boundFramebufferObject(target);
            if (!fbo) return GL.FRAMEBUFFER_UNDEFINED || 0x8219;
            let width = 0, height = 0, any = false;
            const check = record => {
                if (!record) return true;
                const size = this.attachmentSize(record);
                if (!size || !size.width || !size.height) return false;
                if (!any) { width = size.width; height = size.height; any = true; }
                else if (size.width !== width || size.height !== height)
                    return false;
                return true;
            };
            for (const attachment of fbo.color)
                if (!check(attachment)) return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
            if (!check(fbo.depth))
                return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
            if (!check(fbo.stencil))
                return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
            if (!any) return GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT;

            for (const attachment of fbo.color) {
                const format = this.attachmentFormat(attachment);
                if (format && format.indexOf("depth") === 0)
                    return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
            }
            const depthFormat = this.attachmentFormat(fbo.depth);
            if (depthFormat && depthFormat.indexOf("depth") !== 0)
                return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
            const stencilFormat = this.attachmentFormat(fbo.stencil);
            if (stencilFormat && stencilFormat.indexOf("stencil") < 0)
                return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;

            if (fbo.depth && fbo.stencil &&
                    (fbo.depth.kind !== fbo.stencil.kind ||
                     this.imageFor(fbo.depth) !== this.imageFor(fbo.stencil) ||
                     fbo.depth.level !== fbo.stencil.level ||
                     fbo.depth.layer !== fbo.stencil.layer))
                return GL.FRAMEBUFFER_UNSUPPORTED_EXT;

            if (target !== GL.READ_FRAMEBUFFER) {
                for (const buffer of s.drawBuffers) {
                    if (buffer === GL.NONE) continue;
                    const index = buffer >= GL.COLOR_ATTACHMENT0 ?
                        buffer - GL.COLOR_ATTACHMENT0 : 0;
                    if (!fbo.color[index])
                        return GL.FRAMEBUFFER_INCOMPLETE_DRAW_BUFFER_EXT;
                }
            }
            if (target !== GL.DRAW_FRAMEBUFFER && s.readBuffer !== GL.NONE) {
                const index = s.readBuffer >= GL.COLOR_ATTACHMENT0 ?
                    s.readBuffer - GL.COLOR_ATTACHMENT0 : 0;
                if (!fbo.color[index])
                    return GL.FRAMEBUFFER_INCOMPLETE_READ_BUFFER_EXT;
            }
            fbo.width = width;
            fbo.height = height;
            return GL.FRAMEBUFFER_COMPLETE;
        },

        blitFramebuffer(sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter) {
            // A same-size, same-format colour blit is a texture copy. Scaling,
            // axis reversal, or format conversion is implemented by a draw.
            // Depth/stencil copies require aspect-typed pipelines and are
            // rejected explicitly instead of producing a WebGPU validation
            // error that invalidates the whole command buffer.
            if (!(mask & GL.COLOR_BUFFER_BIT) ||
                    (mask & ~GL.COLOR_BUFFER_BIT) !== 0)
                return this.refuse("glBlitFramebuffer",
                    "only colour blits are implemented", { mask }, 0);
            const width = Math.abs(sx1 - sx0), height = Math.abs(sy1 - sy0);
            const dstWidth = Math.abs(dx1 - dx0), dstHeight = Math.abs(dy1 - dy0);
            const source = this.readAttachmentView();
            const target = this.currentTargets();
            if (!source || !target || !target.color[0]) return;
            const destination = target.color[0];
            const straight = sx1 >= sx0 && sy1 >= sy0 &&
                dx1 >= dx0 && dy1 >= dy0;
            if (straight && width === dstWidth && height === dstHeight &&
                    source.format === destination.format && !destination.resolveTarget &&
                    source.texture !== destination.texture) {
                this.endPass();
                this.ensureEncoder().copyTextureToTexture(
                    { texture: source.texture, mipLevel: source.mipLevel || 0,
                      origin: { x: sx0, y: sy0, z: source.layer || 0 } },
                    { texture: destination.texture || this.backBuffer,
                      mipLevel: destination.mipLevel || 0,
                      origin: { x: dx0, y: dy0,
                        z: destination.origin ? destination.origin.z : 0 } },
                    { width, height, depthOrArrayLayers: 1 });
                return;
            }
            this.blitColorTexture(source, destination,
                sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, filter);
        },

        readAttachmentView() {
            const s = this.current;
            if (!s.readFramebuffer)
                return this.backBuffer ? { texture: this.backBuffer,
                    format: this.backBufferFormat,
                    width: this.backBufferWidth,
                    height: this.backBufferHeight } : null;
            const fbo = this.boundFramebufferObject(GL.READ_FRAMEBUFFER);
            if (!fbo) return null;
            const index = s.readBuffer >= GL.COLOR_ATTACHMENT0 ?
                s.readBuffer - GL.COLOR_ATTACHMENT0 : 0;
            const record = fbo.color[index];
            if (!record) return null;
            if (record.kind === "texture") {
                const texture = this.imageFor(record);
                const gpuTexture = this.ensureTextureUploaded(texture);
                return gpuTexture ? { texture: gpuTexture,
                    format: texture.gpuFormat,
                    mipLevel: record.level, layer: record.layer,
                    // ReadPixels copies a 3D z-slice directly. Such a texture
                    // cannot have a 2D/array view; no view is needed for copy.
                    view: texture.kind === "3D" ? undefined : gpuTexture.createView({
                        dimension: "2d", baseMipLevel: record.level,
                        mipLevelCount: 1, baseArrayLayer: record.layer,
                        arrayLayerCount: 1,
                    }),
                    width: Math.max(1, texture.gpuWidth >> record.level),
                    height: Math.max(1, texture.gpuHeight >> record.level) } : null;
            }
            const rb = this.imageFor(record);
            return rb && rb.gpuTexture ? { texture: rb.gpuTexture,
                view: rb.gpuTexture.createView(),
                format: rb.gpuFormat, width: rb.width, height: rb.height } : null;
        },

        copyTexImage(target, level, internalFormat, x, y, width, height) {
            const source = this.readAttachmentView();
            if (!source)
                return this.refuse("glCopyTexImage2D", "no readable attachment",
                    {}, GL.INVALID_FRAMEBUFFER_OPERATION);
            const texture = this.boundTexture(target);
            if (!texture) return;
            const storage = storageFormatFor(internalFormat, this.deviceFeatures);
            const kind = this.textureTargetKind(target);
            if (kind === "3D" || storage.depth || storage.palettised ||
                    storage.compressed)
                return this.refuse("glCopyTexImage2D",
                    "the requested target format cannot receive a colour copy",
                    { target, internalFormat, format: storage.gpu },
                    GL.INVALID_OPERATION);
            texture.target = kind === "Cube" ? GL.TEXTURE_CUBE_MAP : target;
            const bytesPerTexel = storage.gpu === "rgba16float" ? 8 :
                (storage.gpu === "rgba32float" ? 16 : 4);
            const componentType = storage.gpu === "rgba16float" ? "f16" :
                (storage.gpu === "rgba32float" ? "f32" : "u8");
            this.storeLevel(texture, kind, level, CUBE_FACE_INDEX[target] || 0, {
                width, height, depth: 1, gpuFormat: storage.gpu,
                base: storage.base, compressed: false,
                // The level is authored on the GPU.  Keeping pixels null is
                // important: a later lazy upload must not overwrite the copy
                // with a zero-filled CPU shadow.
                pixels: null, bytesPerTexel, componentType, componentCount: 4,
            });
            this.ensureTextureUploaded(texture);
            // Framebuffer row y is GL's row y after the clip-space flip, so the
            // copy is direct rather than mirrored.
            const view = texture.gpuTexture.createView({
                dimension: "2d", baseMipLevel: level, mipLevelCount: 1,
                baseArrayLayer: CUBE_FACE_INDEX[target] || 0,
                arrayLayerCount: 1,
            });
            this.copyColorTexture(source, { view, format: storage.gpu, base: storage.base },
                x, y, 0, 0, width, height, "clear");
            if (texture.generateMipmapHint && level === 0) this.generateMipmapFor(texture);
        },

        copyTexSubImage(target, level, xoffset, yoffset, zoffset, x, y, width,
                height) {
            const source = this.readAttachmentView();
            if (!source)
                return this.refuse("glCopyTexSubImage", "no readable attachment",
                    {}, GL.INVALID_FRAMEBUFFER_OPERATION);
            const texture = this.boundTexture(target);
            if (!texture) return;
            const kind = this.textureTargetKind(target);
            const layer = CUBE_FACE_INDEX[target] || 0;
            const slot = this.levelSlot(texture, kind, level, layer);
            if (!slot)
                return this.refuse("glCopyTexSubImage",
                    "destination level has no storage", { level, layer },
                    GL.INVALID_OPERATION);
            if (kind === "3D" || slot.compressed || slot.base === "DEPTH" ||
                    slot.base === "COLOR_INDEX")
                return this.refuse("glCopyTexSubImage",
                    "the destination format cannot receive a colour copy",
                    { target, format: slot.gpuFormat }, GL.INVALID_OPERATION);
            const gpuTexture = this.ensureTextureUploaded(texture);
            if (!gpuTexture) return;
            void zoffset;
            const view = gpuTexture.createView({
                dimension: "2d", baseMipLevel: level, mipLevelCount: 1,
                baseArrayLayer: layer, arrayLayerCount: 1,
            });
            if (this.copyColorTexture(source,
                    { view, format: slot.gpuFormat, base: slot.base }, x, y,
                    xoffset, yoffset, width, height, "load")) {
                // The CPU copy is no longer authoritative after a framebuffer
                // copy.  Mipmap generation below can continue entirely on GPU.
                slot.pixels = null;
                if (texture.generateMipmapHint && level === 0) this.generateMipmapFor(texture);
            }
        },

        // Metadata has already been validated by the CPU. It captures the
        // object and PACK state once; data requests use its ticket, never a
        // later public name or binding. Each mapping covers a bounded region.
        queryTextureImage(bytes, view, offset, size, metadata) {
            const name = "QUERY_TEXTURE_IMAGE", F = protocol.F[name], header = protocol.RECORDS[name].size;
            if (size < header) throw new GLStreamError("texture image query is short");
            const r = protocol.decodeRecord(name, view, offset), state = this.current;
            const release = () => { if (r.mode === 2 && state?.textureRead?.ticket === r.ticket) state.textureRead = null; };
            const fail = () => {
                release();
                this.answerGuest(bytes, metadata, [
                    [offset + F.error, new Uint8Array(new Uint32Array([GL.INVALID_OPERATION]).buffer)],
                    [offset + F.status, new Uint8Array(new Uint32Array([SYNC_STATUS_FAILED]).buffer)]]);
            };
            if (!state || r.status === SYNC_STATUS_FAILED) return;
            if (r.mode === 3) {
                if (state.textureRead?.ticket === r.ticket) state.textureRead = null;
                return;
            }
            if (!r.mode) {
                if (r.status !== SYNC_STATUS_OK || !r.ticket) return;
                const texture = this.boundTexture(r.target), kind = this.textureTargetKind(r.target);
                const face = CUBE_FACE_INDEX[r.target] || 0, slot = texture && this.levelSlot(texture, kind, r.level, face);
                const gpu = slot && !slot.compressedPixels && !slot.pixels && this.ensureTextureUploaded(texture);
                state.textureRead = { ...r, imageId: texture?.imageId, slot, pack: this.packState(), source: gpu && {
                    texture: gpu, format: texture.gpuFormat, width: r.width, height: r.height,
                    mipLevel: r.level, layer: face, forceDepthConversion: true,
                } };
                return;
            }
            if (r.status !== SYNC_STATUS_PENDING) return;
            const saved = state.textureRead;
            if (!saved || saved.ticket !== r.ticket || saved.context_id !== r.context_id ||
                !saved.slot || r.data_size > size - header || r.offset + r.data_size > saved.span) return fail();
            const out = bytes.slice(offset + header, offset + header + r.data_size);
            const finish = () => {
                release();
                this.answerGuest(bytes, metadata, [[offset + header, out],
                    [offset + F.status, new Uint8Array(new Uint32Array([SYNC_STATUS_OK]).buffer)]]);
            };
            if (saved.compressed) {
                if (!saved.slot.compressedPixels || saved.slot.compressedPixels.length < r.offset + r.data_size) return fail();
                out.set(saved.slot.compressedPixels.subarray(r.offset, r.offset + r.data_size));
                return finish();
            }
            const work = async () => {
                const { width, height, depth, format, type, pack, slot } = saved;
                const bitmap = type === 0x1A00;
                const group = bitmap ? 1 / 8 : TYPE_BYTES[type] * (PACKED_TYPES.has(type) ? 1 : SOURCE_COMPONENTS[format] || 1);
                const stride = alignUp((pack.rowLength || width) * group, pack.alignment);
                const imageStride = stride * (pack.imageHeight || height);
                const base = (r.target === GL.TEXTURE_3D ? (pack.skipImages || 0) * imageStride : 0) +
                    (pack.skipRows || 0) * stride + (pack.skipPixels || 0) * group;
                const begin = r.offset, end = begin + out.length, rowSize = width * group;
                const firstZ = Math.max(0, Math.floor((begin - base - (height - 1) * stride - rowSize) / imageStride) + 1);
                const lastZ = Math.min(depth, Math.ceil((end - base) / imageStride));
                for (let z = firstZ; z < lastZ; ++z) {
                    const slice = base + z * imageStride;
                    let y = Math.max(0, Math.floor((begin - slice - rowSize) / stride) + 1);
                    const lastY = Math.min(height, Math.ceil((end - slice) / stride));
                    while (y < lastY) {
                        const rows = Math.min(lastY - y, Math.max(1, Math.floor(16384 / width)));
                        let values;
                        if (slot.compressedPixels) {
                            const storage = storageFormatFor(slot.compressedFormat, {});
                            const blockBytes = slot.compressedPixels.length / (Math.ceil(width / 4) * Math.ceil(height / 4));
                            const by = Math.floor(y / 4), byEnd = Math.ceil((y + rows) / 4);
                            const data = slot.compressedPixels.subarray(by * Math.ceil(width / 4) * blockBytes,
                                byEnd * Math.ceil(width / 4) * blockBytes);
                            const pixels = decodeDXT(storage.decodeDXT || (blockBytes === 8 ? 1 :
                                slot.compressedFormat === GL.COMPRESSED_RGBA_S3TC_DXT3_EXT ? 3 : 5), data, width, (byEnd - by) * 4);
                            values = unpackReadback(pixels.subarray((y - by * 4) * width * 4), width * 4, width, rows, "rgba8unorm");
                        } else if (slot.pixels) {
                            const at = ((z * height + y) * width) * slot.bytesPerTexel;
                            values = unpackReadback(slot.pixels.subarray(at), width * slot.bytesPerTexel, width, rows,
                                slot.base === "DEPTH" ? slot.gpuFormat === "depth16unorm" ? "depth16" : "r32float" : slot.gpuFormat);
                        } else {
                            if (!saved.source) throw new Error("texture image has no GPU storage");
                            this.endPass();
                            const read = this.readRectangle({ ...saved.source, layer: r.target === GL.TEXTURE_3D ? z : saved.source.layer },
                                slot.base === "DEPTH" ? "depth" : slot.base === "COLOR_INDEX" ? "index" : "color", { x: 0, y, width, height: rows });
                            this.flushFrame();
                            values = await this.awaitReadback(read(), "glGetTexImage", read.cancel);
                        }
                        if (slot.base === "RGB") for (let i = 3; i < values.length; i += 4) values[i] = 1;
                        if (bitmap) {
                            for (let row = 0; row < rows; ++row) for (let col = 0; col < width; ++col) {
                                const bit = (slice + (y + row) * stride) * 8 + col;
                                const at = Math.floor(bit / 8) - begin;
                                if (at >= 0 && at < out.length) {
                                    const mask = 1 << (pack.lsbFirst ? bit % 8 : 7 - bit % 8);
                                    out[at] = out[at] & ~mask | (values[row * width + col] & 1 ? mask : 0);
                                }
                            }
                            y += rows; continue;
                        }
                        const packed = new Uint8Array(rowSize * rows);
                        packPixels(packed, values, width, rows, 0, 0, width, format, type,
                            { alignment: 1, swapBytes: pack.swapBytes, textureImage: true });
                        for (let row = 0; row < rows; ++row) {
                            const at = slice + (y + row) * stride, lo = Math.max(at, begin), hi = Math.min(at + rowSize, end);
                            if (hi > lo) out.set(packed.subarray(row * rowSize + lo - at, row * rowSize + hi - at), lo - begin);
                        }
                        y += rows;
                    }
                }
            };
            this.trackReadback(work().then(finish).catch(error => {
                this.warnOnce("texture-readback", "glGetTexImage mapping failed", { message: String(error) }); fail();
            }));
        },

        /* ---- glReadPixels ----
         *
         * Like texture image reads, framebuffer reads need a GPU round trip. The
         * guest spins on the status word in the record it submitted, so the
         * answer is written back into that record when the mapping resolves --
         * and the heartbeat keeps a busy host from being mistaken for a dead
         * one (plan 6.2).
         */
        readPixels(bytes, view, offset, size, metadata) {
            if (size < READ_PIXELS_HEADER_SIZE) {
                throw new GLStreamError("glReadPixels record is too short");
            }
            const F = protocol.F.READ_PIXELS;
            const x = view.getInt32(offset + F.x, true);
            const y = view.getInt32(offset + F.y, true);
            const width = view.getInt32(offset + F.width, true);
            const height = view.getInt32(offset + F.height, true);
            const format = view.getUint32(offset + F.format, true);
            const type = view.getUint32(offset + F.type, true);
            const dataSize = view.getUint32(offset + F.data_size, true);
            view.setUint32(offset + F.status, SYNC_STATUS_PENDING, true);

            const status = value => {
                const word = new Uint8Array(4);
                new DataView(word.buffer).setUint32(0, value, true);
                return word;
            };
            // GL 2.1 section 4.3.2: colour from the read buffer, or with
            // DEPTH_COMPONENT and STENCIL_INDEX the depth and stencil
            // (review S2-23: always colour, in RGBA order of bytes)
            const kind = format === GL.DEPTH_COMPONENT ? "depth" : format === GL.STENCIL_INDEX ? "stencil" : "color";
            const source = kind === "color" ? this.readAttachmentView() : this.readDepthStencil(kind);
            if (READ_PIXELS_HEADER_SIZE + dataSize > size || !source || width <= 0 || height <= 0 || !TYPE_BYTES[type]) {
                this.answerGuest(bytes, metadata, [[offset + F.status, status(SYNC_STATUS_FAILED)]]);
                return;
            }
            // only the part inside the source is read (review S1-2i: the copy
            // past its edge was refused, and the status said OK)
            const rect = clipToSource(source, x, y, width, height);
            const pack = this.packState();
            const recordOffset = offset;
            const finish = values => {
                // over the caller's bytes, which the guest put in the record:
                // GL leaves row padding and skipped pixels as they were
                const out = new Uint8Array(dataSize);
                const at = recordOffset + READ_PIXELS_HEADER_SIZE;
                out.set(bytes.subarray(at, Math.min(at + dataSize, bytes.length)));
                packPixels(out, values, rect.width, rect.height, rect.x - x, rect.y - y, width, format, type, pack);
                this.answerGuest(bytes, metadata, [[recordOffset + READ_PIXELS_HEADER_SIZE, out],
                    [recordOffset + F.status, status(SYNC_STATUS_OK)]]);
            };
            if (!rect.width || !rect.height) return finish(null);
            this.endPass();
            const read = this.readRectangle(source, kind, rect);
            this.flushFrame();
            this.trackReadback(this.awaitReadback(read(), "glReadPixels", read.cancel).then(finish).catch(error => {
                this.warnOnce("readback", "glReadPixels mapping failed",
                    { message: String(error) });
                // the guest is told, rather than left waiting out its deadline (review S1-7)
                this.answerGuest(bytes, metadata, [[recordOffset + F.status, status(SYNC_STATUS_FAILED)]]);
            }));
        },

        // The pack state as packPixels takes it
        packState() {
            const store = this.current.pixelStore;
            return { alignment: store.packAlignment || 4, rowLength: store.packRowLength,
                skipPixels: store.packSkipPixels, skipRows: store.packSkipRows, swapBytes: !!store.packSwapBytes,
                imageHeight: store.packImageHeight, skipImages: store.packSkipImages, lsbFirst: store.packLsbFirst };
        },

        // The read framebuffer's depth-stencil image
        readDepthStencil(kind) {
            const s = this.current;
            if (!s.readFramebuffer) {
                const samples = this.windowSamples();
                this.ensureDepthTarget(samples);
                if (samples > 1) {
                    // WebGPU resolves colour only: reading one sample is to do
                    this.warnOnce("multisample-depth-read", "the depth and stencil of a " +
                        "multisampled window cannot be read back", {});
                    return null;
                }
                return { texture: this.depthTarget, format: "depth24plus-stencil8", mipLevel: 0, layer: 0,
                    width: this.depthWidth, height: this.depthHeight };
            }
            const fbo = this.boundFramebufferObject(GL.READ_FRAMEBUFFER);
            const record = fbo && (kind === "stencil" ? fbo.stencil || fbo.depth : fbo.depth || fbo.stencil);
            const resolved = record && this.resolveAttachment(record);
            if (!resolved) return null;
            return { texture: resolved.texture, format: resolved.format, mipLevel: resolved.mipLevel,
                layer: resolved.origin.z, width: Math.max(1, resolved.texture.width >> resolved.mipLevel),
                height: Math.max(1, resolved.texture.height >> resolved.mipLevel) };
        },

        /*
         * Encodes the copy of the rectangle, and returns what maps it once the
         * frame is submitted: a Float32Array of RGBA a pixel (colour), of
         * depths or of stencil values, row by row from the bottom. Depth in a
         * depth24plus format cannot be copied, so a pass loads it into an
         * r32float image first.
         */
        readRectangle(source, kind, rect) {
            const encoder = this.ensureEncoder();
            let texture = source.texture, aspect = "all", texelBytes, origin = { x: rect.x, y: rect.y, z: source.layer || 0 };
            let mipLevel = source.mipLevel || 0;
            if (kind === "index") {
                texelBytes = 1;
            } else if (kind === "stencil") {
                aspect = "stencil-only";
                texelBytes = 1;
            } else if (kind === "depth" && !source.forceDepthConversion && (source.format === "depth32float" || source.format === "depth16unorm")) {
                aspect = "depth-only";
                texelBytes = source.format === "depth32float" ? 4 : 2;
            } else if (kind === "depth") {
                texture = this.depthToFloat(encoder, source, rect);
                origin = { x: 0, y: 0, z: 0 };
                mipLevel = 0;
                texelBytes = 4;
            } else {
                texelBytes = source.format.startsWith("rgba32float") ? 16 : source.format.startsWith("rgba16float") ? 8 : 4;
            }
            // a depth or stencil copy has to take the whole image; the
            // rectangle is picked out of it when unpacked
            const whole = aspect !== "all";
            const copy = whole ? { x: 0, y: 0, width: source.width, height: source.height } :
                { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            if (whole) origin = { x: 0, y: 0, z: origin.z };
            const bytesPerRow = alignUp(copy.width * texelBytes, 256);
            const staging = this.createGPUBuffer({
                label: "GL readback", size: bytesPerRow * copy.height,
                usage: BUFFER_USAGE_COPY_DST | BUFFER_USAGE_MAP_READ,
            });
            encoder.copyTextureToBuffer({ texture, mipLevel, origin, aspect },
                { buffer: staging, bytesPerRow, rowsPerImage: copy.height },
                { width: copy.width, height: copy.height, depthOrArrayLayers: 1 });
            if (texture !== source.texture) this.retire(texture);
            const format = kind === "depth" ? (texelBytes === 2 ? "depth16" : "r32float") : kind === "stencil" ? "stencil8" :
                source.format;
            const read = () => staging.mapAsync(1 /* GPUMapMode.READ */).then(() => {
                try {
                    const mapped = new Uint8Array(staging.getMappedRange());
                    const skip = whole ? rect.y * bytesPerRow + rect.x * texelBytes : 0;
                    return unpackReadback(mapped.subarray(skip), bytesPerRow, rect.width, rect.height, format);
                } finally {
                    staging.unmap();
                    staging.destroy();
                }
            }, error => { staging.destroy(); throw error; });
            read.cancel = () => staging.destroy();
            return read;
        },

        // depth24plus's values, loaded into an r32float image of the rectangle
        depthToFloat(encoder, source, rect) {
            if (!this.depthReadPipeline) {
                const module = this.device.createShaderModule({ label: "GL depth readback", code: DEPTH_READ_WGSL });
                this.depthReadPipeline = this.createPipeline(this.singletonPipelines, "depthReadPipeline", {
                    label: "GL depth readback", layout: "auto",
                    vertex: { module, entryPoint: "vs_main" },
                    fragment: { module, entryPoint: "fs_main", targets: [{ format: "r32float" }] },
                    primitive: { topology: "triangle-list" },
                });
            }
            const target = this.createGPUTexture({
                label: "GL depth readback", size: { width: rect.width, height: rect.height, depthOrArrayLayers: 1 },
                format: "r32float", usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC |
                    TEXTURE_USAGE_TEXTURE_BINDING,
            });
            const origin = this.createGPUBuffer({ label: "GL depth readback origin", size: 16,
                usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST });
            this.device.queue.writeBuffer(origin, 0, new Uint32Array([rect.x, rect.y, 0, 0]));
            const bindGroup = this.device.createBindGroup({
                layout: this.depthReadPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: source.texture.createView({ dimension: "2d", aspect: "depth-only",
                        baseMipLevel: source.mipLevel || 0, mipLevelCount: 1, baseArrayLayer: source.layer || 0,
                        arrayLayerCount: 1 }) },
                    { binding: 1, resource: { buffer: origin } },
                ],
            });
            const pass = encoder.beginRenderPass({ label: "GL depth readback",
                colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
            pass.setPipeline(this.depthReadPipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(3);
            pass.end();
            this.retire(origin);
            return target;
        },

        /* ---- occlusion queries ---- */

        beginQuery(target, name) {
            if (target !== GL.SAMPLES_PASSED && target !== GL.ANY_SAMPLES_PASSED && target !== GL.ANY_SAMPLES_PASSED_CONSERVATIVE)
                return this.refuse("glBeginQuery", "unsupported query target",
                    { target }, GL.INVALID_ENUM);
            let query = this.queries.get(name);
            if (!name)
                return this.refuse("glBeginQuery", "zero query name",
                    { name }, GL.INVALID_OPERATION);
            if (query?.target && query.target !== target)
                return this.refuse("glBeginQuery", "query target changed", { name, target }, GL.INVALID_OPERATION);
            if (this.activeQuery)
                return this.refuse("glBeginQuery", "a query is already active",
                    { name }, GL.INVALID_OPERATION);
            if (!query) this.queries.set(name, query = createQuery(name));
            query.target = target; query.active = true;
            query.generation = (query.generation || 0) + 1;
            query.ready = false;
            query.result = 0;
            query.pendingSegments = 0;
            query.ended = false;
            query.slot = -1;
            this.ensureOcclusionQuerySet();
            this.activeQuery = query;
            this.current.activeQuery = query;
            // The set is created lazily, so the pass that is already open on
            // the first glBeginQuery of a session was built without it. Ending
            // it makes ensurePass rebuild one that carries it; the rebuilt
            // pass loads the attachments it just stored, so nothing is lost.
            if (this.pass && !this.passHasOcclusionQuerySet) this.endPass();
            // No rendering is implied by BeginQuery. An empty query is zero,
            // including when the current framebuffer is incomplete. The
            // first draw opens/resumes the GPU segment through ensurePass.
        },

        endQuery(target) {
            const query = this.activeQuery;
            if (![GL.SAMPLES_PASSED, GL.ANY_SAMPLES_PASSED, GL.ANY_SAMPLES_PASSED_CONSERVATIVE].includes(target))
                return this.refuse("glEndQuery", "unknown target", { target }, GL.INVALID_ENUM);
            if (!query || query.target !== target)
                return this.refuse("glEndQuery", "no matching active query", { target }, GL.INVALID_OPERATION);
            this.endOcclusionSegment();
            this.activeQuery = null;
            this.current.activeQuery = null; query.active = false;
            query.ended = true;
            query.ready = query.pendingSegments === 0;
        },

        beginOcclusionSegment() {
            const query = this.activeQuery;
            if (!query || !this.pass || query.slot >= 0) return;
            query.slot = this.nextQuerySlot++;
            this.pass.beginOcclusionQuery(query.slot);
        },

        endOcclusionSegment() {
            const query = this.activeQuery;
            if (!query || !this.pass || query.slot < 0) return;
            this.pass.endOcclusionQuery();
            ++query.pendingSegments;
            this.pendingQueries = this.pendingQueries || [];
            // Keep the slot and generation immutable while mapAsync is in
            // flight. The query object itself is immediately reusable.
            this.pendingQueries.push({
                query,
                slot: query.slot,
                generation: query.generation,
            });
            query.slot = -1;
        },

        completeOcclusionSegment(record, result) {
            const { query, generation } = record;
            if (query.generation !== generation) return;
            // D-07 exposes visibility, so OR all pass/submission segments.
            // A later zero must not erase visibility from an earlier pass.
            if (result) query.result = query.target === GL.SAMPLES_PASSED ? OCCLUSION_VISIBLE_SAMPLES : 1;
            --query.pendingSegments;
            query.ready = query.ended && query.pendingSegments === 0;
        },

        ensureOcclusionQuerySet() {
            if (this.activeOcclusionQuerySet) return;
            this.occlusionCapacity = 4096;
            this.activeOcclusionQuerySet = this.createGPUQuerySet({
                type: "occlusion", count: this.occlusionCapacity,
            });
            this.nextQuerySlot = 0;
        },

        /*
         * Cube 2 keeps a pool of two thousand query objects and asks for them
         * all at once, so the batch resolves every pending query in one
         * readback rather than one per object.
         */
        /*
         * An answer only this side has, written into the guest's record both
         * ways: into these bytes, which are guest memory in the page's mode,
         * and through the bridge's writer, which reaches it from across the
         * CPU worker's boundary. writes: [offset in bytes, data], the status
         * word last -- the guest that observes it must see the rest.
         */
        answerGuest(bytes, metadata, writes) {
            if (metadata && metadata.isMemoryValid && !metadata.isMemoryValid()) return;
            if (metadata && metadata.isInlineMemoryValid && !metadata.isInlineMemoryValid()) return;
            for (const [at, data] of writes) if (at + data.length <= bytes.byteLength) bytes.set(data, at);
            const writeGuest = this.options.writeGuestMemory;
            if (typeof writeGuest === "function")
                for (const [at, data] of writes) writeGuest(at, data, metadata);
        },

        // {count, kind, status, reserved} then {name, ready, result} each:
        // the results resolved so far, the rest not ready (GL permits it)
        queryObjectBatch(bytes, view, offset, size, metadata) {
            const R = protocol.F.QUERY_OBJECT_BATCH, E = protocol.F.QUERY_OBJECT_BATCH_ENTRY;
            const headerSize = protocol.RECORDS.QUERY_OBJECT_BATCH.size;
            const entrySize = protocol.RECORDS.QUERY_OBJECT_BATCH_ENTRY.size;
            if (size < headerSize) throw new GLStreamError("query batch is short");
            if (view.getUint32(offset + R.status, true) !== SYNC_STATUS_PENDING) return;
            const count = view.getUint32(offset + R.count, true);
            const status = new Uint8Array(4);
            if (headerSize + count * entrySize > size) {
                new DataView(status.buffer).setUint32(0, SYNC_STATUS_FAILED, true);
                return this.answerGuest(bytes, metadata, [[offset + R.status, status]]);
            }
            this.flushFrame();
            const entries = new Uint8Array(count * entrySize);
            const out = new DataView(entries.buffer);
            for (let i = 0; i < count; ++i) {
                const name = view.getUint32(offset + headerSize + i * entrySize + E.name, true);
                const query = this.queries.get(name);
                out.setUint32(i * entrySize + E.name, name, true);
                out.setUint32(i * entrySize + E.available, query && query.ready ? 1 : 0, true);
                out.setUint32(i * entrySize + E.result, query ? query.result >>> 0 : 0, true);
            }
            new DataView(status.buffer).setUint32(0, SYNC_STATUS_OK, true);
            this.answerGuest(bytes, metadata, [[offset + headerSize, entries], [offset + R.status, status]]);
        },

        // glFinish returns once the GPU has done the work before it: the
        // guest waits for the status word
        /*
         * glFlush and glFinish: what was drawn into the front buffer of the
         * window is shown (review D-08: only SwapBuffers presented). The
         * front and back buffers share the one colour target, so this
         * presents everything drawn since.
         */
        flushFront() {
            if (!this.frontDrawn) return this.flushFrame();
            this.frontDrawn = false;
            this.finishFrame(true);
        },

        onFinish(bytes, view, offset, size, metadata) {
            this.flushFront();
            if (size < 4) return;
            const answer = value => {
                const status = new Uint8Array(4);
                new DataView(status.buffer).setUint32(0, value, true);
                this.answerGuest(bytes, metadata, [[offset, status]]);
            };
            const done = Promise.resolve().then(() => this.device && this.device.queue.onSubmittedWorkDone ?
                this.device.queue.onSubmittedWorkDone() : undefined);
            this.trackReadback(this.awaitReadback(done, "glFinish").then(() => answer(SYNC_STATUS_OK), error => {
                this.warnOnce("finish", "glFinish fence failed", { message: String(error) });
                answer(SYNC_STATUS_FAILED);
            }));
        },

        /* ---- legacy pixel rectangles ---- */

        drawPixels(bytes, view, offset, size) {
            const R = protocol.F.DRAW_PIXELS, header = protocol.RECORDS.DRAW_PIXELS.size;
            if (size < header) throw new GLStreamError("glDrawPixels record is short");
            const width = view.getInt32(offset + R.width, true);
            const height = view.getInt32(offset + R.height, true);
            const format = view.getUint32(offset + R.format, true);
            const type = view.getUint32(offset + R.type, true);
            const dataSize = view.getUint32(offset + R.data_size, true);
            if (width <= 0 || height <= 0 || !this.current.current.rasterValid)
                return;
            if (header + dataSize > size)
                throw new GLStreamError("glDrawPixels data is truncated");
            const source = bytes.subarray(offset + header, offset + header + dataSize);
            if (format === GL.DEPTH_COMPONENT || format === GL.STENCIL_INDEX)
                return this.drawPixelValues(format, source, width, height, type);
            const store = this.current.pixelStore;
            const rgba = convertPixels(source, 0, width, height, 1,
                format, type, "RGBA", unpackState(store));
            if (!rgba)
                return this.refuse("glDrawPixels", "unsupported or truncated pixel data",
                    { width, height, format, type }, GL.INVALID_ENUM);
            this.applyPixelTransfer(rgba);
            this.drawPixelRGBA(rgba, width, height,
                this.current.current.rasterPos[0],
                this.current.current.rasterPos[1], false);
        },

        /*
         * glDrawPixels of DEPTH_COMPONENT or STENCIL_INDEX (review D-15: drawn
         * as grey colour). Depth fragments carry the raster colour and go
         * through the per-fragment operations; stencil indices are written,
         * under the scissor and the stencil write mask only (GL 2.1 section
         * 4.3.1). The values become a texture drawn like a pixel rectangle.
         */
        drawPixelValues(format, source, width, height, type) {
            const unpack = unpackState(this.current.pixelStore);
            const depth = format === GL.DEPTH_COMPONENT;
            let pixels = null;
            if (depth) {
                const converted = convertPixelsForStorage(source, 0, width, height, 1, format, type,
                    { gpu: "depth32float", depth: true, base: "DEPTH" }, unpack);
                pixels = converted && converted.pixels;
            } else {
                const rgba = convertPixels(source, 0, width, height, 1, format, type, "RGBA", unpack);
                if (rgba) {
                    pixels = new Uint8Array(width * height);
                    for (let i = 0; i < pixels.length; ++i) pixels[i] = rgba[i * 4];
                }
            }
            if (!pixels)
                return this.refuse("glDrawPixels", "unsupported or truncated pixel data",
                    { width, height, format, type }, GL.INVALID_ENUM);
            const texture = this.createGPUTexture({
                label: "GL " + (depth ? "depth" : "stencil") + " pixels",
                size: { width, height, depthOrArrayLayers: 1 }, format: depth ? "r32float" : "r8uint",
                usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
            });
            this.device.queue.writeTexture({ texture }, pixels, { bytesPerRow: width * (depth ? 4 : 1),
                rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
            this.drawValueTexture(depth ? "depth" : "stencil", texture, width, height,
                this.current.current.rasterPos[0], this.current.current.rasterPos[1]);
            this.retire(texture);
        },

        // glCopyPixels of DEPTH or STENCIL: the read buffer's values, drawn as above
        copyPixelValues(kind, x, y, width, height) {
            const source = this.readDepthStencil(kind);
            if (!source) return;
            const rect = clipToSource(source, x, y, width, height);
            if (!rect.width || !rect.height) return;
            this.endPass();
            const encoder = this.ensureEncoder();
            let texture;
            if (kind === "depth") {
                texture = this.depthToFloat(encoder, source, rect);
            } else {
                // the stencil aspect is copied whole, through a buffer
                const bytesPerRow = alignUp(source.width, 256);
                const staging = this.createGPUBuffer({ label: "GL stencil copy",
                    size: bytesPerRow * source.height, usage: BUFFER_USAGE_COPY_DST | BUFFER_USAGE_COPY_SRC });
                encoder.copyTextureToBuffer({ texture: source.texture, mipLevel: source.mipLevel || 0,
                    origin: { x: 0, y: 0, z: source.layer || 0 }, aspect: "stencil-only" },
                { buffer: staging, bytesPerRow, rowsPerImage: source.height },
                { width: source.width, height: source.height, depthOrArrayLayers: 1 });
                texture = this.createGPUTexture({ label: "GL stencil pixels",
                    size: { width: rect.width, height: rect.height, depthOrArrayLayers: 1 }, format: "r8uint",
                    usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING });
                encoder.copyBufferToTexture({ buffer: staging, offset: rect.y * bytesPerRow + rect.x,
                    bytesPerRow, rowsPerImage: source.height }, { texture },
                { width: rect.width, height: rect.height, depthOrArrayLayers: 1 });
                this.retire(staging);
            }
            const raster = this.current.current.rasterPos;
            this.drawValueTexture(kind, texture, rect.width, rect.height,
                raster[0] + (rect.x - x) * this.current.pixelZoom.x, raster[1] + (rect.y - y) * this.current.pixelZoom.y);
            this.retire(texture);
        },

        /*
         * A texture of depths or stencil indices drawn at window (x, y): the
         * depths with the raster colour, through one pipeline; the indices in
         * nine draws -- clearing the covered stencil values, then setting each
         * bit where the index has it, since WebGPU has no per-fragment
         * stencil reference.
         */
        drawValueTexture(kind, texture, width, height, x, y) {
            const s = this.current;
            const pass = this.ensurePass();
            if (!pass) return;
            const targets = this.passTargets;
            if (!targets.depthFormat || (kind === "stencil" && !formatHasStencil(targets.depthFormat))) {
                this.warnOnce("pixel-values-buffer", "the framebuffer has no " + kind + " buffer to draw into", {});
                return;
            }
            const window = { width: targets.width, height: targets.height };
            const x1 = x + width * s.pixelZoom.x, y1 = y + height * s.pixelZoom.y;
            const ndcX = value => value * 2 / window.width - 1;
            const ndcY = value => 1 - value * 2 / window.height;
            const vertices = new Float32Array([
                ndcX(x), ndcY(y), 0, 1, 0, 0,   ndcX(x1), ndcY(y), 0, 1, 1, 0,
                ndcX(x), ndcY(y1), 0, 1, 0, 1,  ndcX(x), ndcY(y1), 0, 1, 0, 1,
                ndcX(x1), ndcY(y), 0, 1, 1, 0,  ndcX(x1), ndcY(y1), 0, 1, 1, 1,
            ]);
            const slice = this.uploadVertices(new Uint8Array(vertices.buffer));
            if (!slice) return;
            const view = texture.createView();
            let color = null;
            if (kind === "depth") {
                color = this.allocateUniform(16);
                if (!color) return;
                new Float32Array(this.uniformStaging.buffer, color.offset, 4).set(s.current.rasterColor);
                this.device.queue.writeBuffer(color.buffer, color.offset, this.uniformStaging, color.offset, 16);
            }
            for (const bit of kind === "depth" ? [0] : [-1, 0, 1, 2, 3, 4, 5, 6, 7]) {
                const pipeline = this.valuePipeline(kind, bit);
                if (!pipeline) return;
                pass.setPipeline(pipeline);
                this.applyPassState(pass);
                pass.setViewport(0, 0, window.width, window.height, 0, 1);
                if (kind === "stencil") pass.setStencilReference(bit < 0 ? 0 : 0xff);
                pass.setVertexBuffer(0, slice.buffer, slice.offset);
                pass.setBindGroup(0, this.device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [{ binding: 0, resource: view }].concat(color ? [{ binding: 1,
                        resource: { buffer: color.buffer, offset: color.offset, size: 16 } }] : []),
                }));
                pass.draw(6, 1, 0, 0);
                ++this.stats.draws;
            }
        },

        valuePipeline(kind, bit) {
            const s = this.current;
            const targets = this.passTargets;
            const depth = kind === "depth";
            const colorMask = (s.colorMask[0] ? 1 : 0) | (s.colorMask[1] ? 2 : 0) |
                (s.colorMask[2] ? 4 : 0) | (s.colorMask[3] ? 8 : 0);
            const stencilMask = s.stencil.front.writeMask & 0xff;
            this.valuePipelineCache = this.valuePipelineCache || new Map();
            const outputs = targets.color.map((target, i) => target && depth ?
                "    @location(" + i + ") color" + i + " : vec4<f32>," : "").join("\n");
            const code = `
struct VSIn { @location(0) position : vec4<f32>, @location(1) uv : vec2<f32>, }
struct Varying { @builtin(position) position : vec4<f32>, @location(0) uv : vec2<f32>, }
@vertex fn vs_main(v : VSIn) -> Varying {
    var out : Varying; out.position = v.position; out.uv = v.uv; return out;
}
@group(0) @binding(0) var values : texture_2d<${depth ? "f32" : "u32"}>;
${depth ? `struct Raster { color : vec4<f32>, }
@group(0) @binding(1) var<uniform> raster : Raster;
struct PixelOut {
${outputs}
    @builtin(frag_depth) depth : f32,
}` : ""}
@fragment fn fs_main(v : Varying) ${depth ? "-> PixelOut " : ""}{
    let size = textureDimensions(values);
    let texel = min(vec2<u32>(v.uv * vec2<f32>(size)), size - vec2<u32>(1u));
    let value = textureLoad(values, texel, 0).r;
${depth ? `    var out : PixelOut;
    out.depth = clamp(value, 0.0, 1.0);
${targets.color.map((target, i) => target ? "    out.color" + i + " = raster.color;" : "").join("\n")}
    return out;` : bit < 0 ? "    _ = value;" : `    if (((value >> ${bit}u) & 1u) == 0u) { discard; }`}
}`;
            const stencilFace = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "replace" };
            const descriptor = {
                label: "GL " + kind + " pixels", layout: "auto",
                vertex: { module: this.shaderModule(code), entryPoint: "vs_main", buffers: [{
                    arrayStride: 24, stepMode: "vertex", attributes: [
                        { shaderLocation: 0, format: "float32x4", offset: 0 },
                        { shaderLocation: 1, format: "float32x2", offset: 16 },
                    ] }] },
                fragment: { module: this.shaderModule(code), entryPoint: "fs_main",
                    targets: targets.color.map(target => target ? { format: target.format,
                        blend: depth && s.enabled.has(GL.BLEND) && this.blendable(target.format) ?
                            gpuBlendState(s) : undefined,
                        writeMask: depth ? colorMask : 0 } : null) },
                primitive: { topology: "triangle-list", cullMode: "none" },
                multisample: { count: targets.sampleCount || 1 },
                depthStencil: depth ? {
                    format: targets.depthFormat,
                    depthWriteEnabled: s.enabled.has(GL.DEPTH_TEST) && s.depthMask,
                    depthCompare: s.enabled.has(GL.DEPTH_TEST) ? COMPARE_FUNCTIONS[s.depthFunc] || "less" : "always",
                    ...(formatHasStencil(targets.depthFormat) ? gpuStencilState(s) : {}),
                } : {
                    format: targets.depthFormat, depthWriteEnabled: false, depthCompare: "always",
                    stencilFront: stencilFace, stencilBack: stencilFace, stencilReadMask: 0xff,
                    stencilWriteMask: bit < 0 ? stencilMask : (1 << bit) & stencilMask,
                },
            };
            const key = this.renderPipelineKey(this.valuePipelineCache, descriptor);
            const pipeline = this.valuePipelineCache.get(key);
            return pipeline || this.createPipeline(this.valuePipelineCache, key, descriptor);
        },

        drawBitmap(bytes, view, offset, size) {
            if (size < 28) throw new GLStreamError("glBitmap record is short");
            const width = view.getInt32(offset, true);
            const height = view.getInt32(offset + 4, true);
            const xorig = view.getFloat32(offset + 8, true);
            const yorig = view.getFloat32(offset + 12, true);
            const xmove = view.getFloat32(offset + 16, true);
            const ymove = view.getFloat32(offset + 20, true);
            const dataSize = view.getUint32(offset + 24, true);
            const s = this.current;
            if (28 + dataSize > size)
                throw new GLStreamError("glBitmap data is truncated");
            if (s.current.rasterValid && width > 0 && height > 0 && dataSize) {
                const source = bytes.subarray(offset + 28,
                    offset + 28 + dataSize);
                const rgba = this.expandBitmap(source, width, height);
                this.drawPixelRGBA(rgba, width, height,
                    s.current.rasterPos[0] - xorig,
                    s.current.rasterPos[1] - yorig, true);
            }
            if (s.current.rasterValid) {
                s.current.rasterPos[0] += xmove;
                s.current.rasterPos[1] += ymove;
            }
        },

        copyPixels(x, y, width, height, type) {
            if (width <= 0 || height <= 0 || !this.current.current.rasterValid)
                return;
            if (type === GL.DEPTH || type === GL.STENCIL)
                return this.copyPixelValues(type === GL.DEPTH ? "depth" : "stencil", x, y, width, height);
            if (type !== GL.COLOR)
                return this.refuse("glCopyPixels", "unknown pixel type", { type }, GL.INVALID_ENUM);
            const source = this.readAttachmentView();
            if (!source) return this.refuse("glCopyPixels",
                "no readable colour attachment", {},
                GL.INVALID_FRAMEBUFFER_OPERATION);
            this.endPass();
            const texture = this.createGPUTexture({
                label: "GL copy-pixels source",
                size: { width, height, depthOrArrayLayers: 1 },
                format: source.format,
                usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
            });
            // only the part inside the read buffer: the rest is undefined in
            // GL (pixel ownership) and an invalid copy in WebGPU (review S2-16)
            const rect = clipToSource(source, x, y, width, height);
            if (rect.width && rect.height)
                this.ensureEncoder().copyTextureToTexture(
                    { texture: source.texture, mipLevel: source.mipLevel || 0,
                      origin: { x: rect.x, y: rect.y, z: source.layer || 0 } },
                    { texture, origin: { x: rect.x - x, y: rect.y - y, z: 0 } },
                    { width: rect.width, height: rect.height, depthOrArrayLayers: 1 });
            this.drawPixelTexture(texture, texture.createView(), width, height,
                this.current.current.rasterPos[0],
                this.current.current.rasterPos[1], false);
            this.retire(texture);
        },

        applyPixelTransfer(rgba) {
            const transfer = this.current.pixelTransfer;
            const maps = this.current.pixelMaps;
            const scales = [transfer.redScale, transfer.greenScale,
                transfer.blueScale, transfer.alphaScale];
            const biases = [transfer.redBias, transfer.greenBias,
                transfer.blueBias, transfer.alphaBias];
            const matrix = this.topOf(GL.COLOR);
            const mapNames = [GL.PIXEL_MAP_R_TO_R, GL.PIXEL_MAP_G_TO_G,
                GL.PIXEL_MAP_B_TO_B, GL.PIXEL_MAP_A_TO_A];
            for (let at = 0; at < rgba.length; at += 4) {
                const input = [0, 0, 0, 0];
                for (let c = 0; c < 4; ++c) {
                    input[c] = clamp(rgba[at + c] / 255 * scales[c] +
                        biases[c], 0, 1);
                }
                const transformed = [
                    matrix[0] * input[0] + matrix[4] * input[1] +
                        matrix[8] * input[2] + matrix[12] * input[3],
                    matrix[1] * input[0] + matrix[5] * input[1] +
                        matrix[9] * input[2] + matrix[13] * input[3],
                    matrix[2] * input[0] + matrix[6] * input[1] +
                        matrix[10] * input[2] + matrix[14] * input[3],
                    matrix[3] * input[0] + matrix[7] * input[1] +
                        matrix[11] * input[2] + matrix[15] * input[3],
                ];
                for (let c = 0; c < 4; ++c) {
                    let value = clamp(transformed[c] *
                        transfer.postColorMatrixScale[c] +
                        transfer.postColorMatrixBias[c], 0, 1);
                    const map = transfer.mapColor ? maps[mapNames[c]] : null;
                    if (map && map.length) {
                        const index = clamp(Math.round(value * (map.length - 1)),
                            0, map.length - 1);
                        value = clamp(map[index], 0, 1);
                    }
                    rgba[at + c] = Math.round(value * 255);
                }
            }
        },

        expandBitmap(source, width, height) {
            const store = this.current.pixelStore;
            const rowLength = store.unpackRowLength || width;
            const rowBytes = Math.ceil(rowLength / 8);
            const stride = alignUp(rowBytes, store.unpackAlignment || 1);
            const skip = store.unpackSkipPixels || 0;
            const rgba = new Uint8Array(width * height * 4);
            // the colour latched with the raster position (review S2-15)
            const color = this.current.current.rasterColor;
            for (let row = 0; row < height; ++row) {
                const rowStart = (store.unpackSkipRows + row) * stride;
                for (let x = 0; x < width; ++x) {
                    const bit = skip + x;
                    const byte = source[rowStart + (bit >> 3)] || 0;
                    const mask = store.unpackLsbFirst ? 1 << (bit & 7) :
                        0x80 >> (bit & 7);
                    if (!(byte & mask)) continue;
                    const at = (row * width + x) * 4;
                    rgba[at] = Math.round(clamp(color[0], 0, 1) * 255);
                    rgba[at + 1] = Math.round(clamp(color[1], 0, 1) * 255);
                    rgba[at + 2] = Math.round(clamp(color[2], 0, 1) * 255);
                    rgba[at + 3] = Math.round(clamp(color[3], 0, 1) * 255);
                }
            }
            return rgba;
        },

        drawPixelRGBA(rgba, width, height, x, y, discardZeroAlpha) {
            const texture = this.createGPUTexture({
                label: "GL pixel rectangle",
                size: { width, height, depthOrArrayLayers: 1 },
                format: "rgba8unorm",
                usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
            });
            this.device.queue.writeTexture({ texture }, rgba,
                { bytesPerRow: width * 4, rowsPerImage: height },
                { width, height, depthOrArrayLayers: 1 });
            this.drawPixelTexture(texture, texture.createView(), width, height,
                x, y, discardZeroAlpha);
            this.retire(texture);
        },

        /*
         * A pixel rectangle is placed in window coordinates and clipped by
         * the window and the scissor, not the viewport (review S2-16): the
         * quad is drawn under a viewport of the whole target, at the raster
         * position's window depth.
         */
        drawPixelTexture(texture, textureView, width, height, x, y,
                discardZeroAlpha) {
            const s = this.current;
            const pass = this.ensurePass();
            if (!pass) return;
            const targets = this.passTargets;
            const window = { width: targets ? targets.width : this.backBufferWidth,
                height: targets ? targets.height : this.backBufferHeight };
            if (!window.width || !window.height) return;
            const x0 = x, y0 = y;
            const x1 = x + width * s.pixelZoom.x;
            const y1 = y + height * s.pixelZoom.y;
            const ndcX = value => value * 2 / window.width - 1;
            // The normal GL vertex path negates clip-space Y. Expressing the
            // window coordinate directly therefore uses the same negated map.
            const ndcY = value => 1 - value * 2 / window.height;
            const z = clamp(s.current.rasterPos[2], 0, 1);
            const vertices = new Float32Array([
                ndcX(x0), ndcY(y0), z, 1, 0, 0,
                ndcX(x1), ndcY(y0), z, 1, 1, 0,
                ndcX(x0), ndcY(y1), z, 1, 0, 1,
                ndcX(x0), ndcY(y1), z, 1, 0, 1,
                ndcX(x1), ndcY(y0), z, 1, 1, 0,
                ndcX(x1), ndcY(y1), z, 1, 1, 1,
            ]);
            const slice = this.uploadVertices(new Uint8Array(vertices.buffer));
            if (!slice) return;
            const pipeline = this.pixelPipeline(discardZeroAlpha);
            if (!pipeline) return;
            pass.setPipeline(pipeline);
            this.applyPassState(pass);
            // (the next draw sets GL's viewport again)
            pass.setViewport(0, 0, window.width, window.height, 0, 1);
            pass.setVertexBuffer(0, slice.buffer, slice.offset);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: textureView },
                    { binding: 1, resource: this.pixelSampler ||
                        (this.pixelSampler = this.device.createSampler({
                            minFilter: "nearest", magFilter: "nearest",
                        })) },
                ],
            }));
            pass.draw(6, 1, 0, 0);
            ++this.stats.draws;
            void texture;
        },

        pixelPipeline(discardZeroAlpha) {
            const s = this.current;
            const targets = this.passTargets;
            if (!targets) return null;
            const alpha = s.enabled.has(GL.ALPHA_TEST) ?
                (ALPHA_TEST_NAMES[s.alphaFunc.func] || "always") : "always";
            this.pixelPipelineCache = this.pixelPipelineCache || new Map();
            const conditions = [];
            if (discardZeroAlpha) conditions.push("color.a <= 0.0");
            if (alpha === "never") conditions.push("true");
            else if (alpha !== "always") {
                const op = {
                    less: "<", equal: "==", lequal: "<=", greater: ">",
                    notequal: "!=", gequal: ">=",
                }[alpha];
                if (op) conditions.push("!(color.a " + op + " " +
                    Number(s.alphaFunc.ref).toPrecision(9) + ")");
            }
            const outputFields = targets.color.map((target, i) => target ?
                "    @location(" + i + ") color" + i + " : vec4<f32>," : "").join("\n");
            const outputWrites = targets.color.map((target, i) => target ?
                "    out.color" + i + " = color;" : "").join("\n");
            const code = `
struct VSIn { @location(0) position : vec4<f32>, @location(1) uv : vec2<f32>, }
struct Varying { @builtin(position) position : vec4<f32>, @location(0) uv : vec2<f32>, }
@vertex fn vs_main(v : VSIn) -> Varying {
    var out : Varying; out.position = v.position; out.uv = v.uv; return out;
}
@group(0) @binding(0) var pixels : texture_2d<f32>;
@group(0) @binding(1) var pixelSampler : sampler;
struct PixelOut {
${outputFields}
}
@fragment fn fs_main(v : Varying) -> PixelOut {
    let color = textureSample(pixels, pixelSampler, v.uv);
    ${conditions.length ? "if (" + conditions.join(" || ") + ") { discard; }" : ""}
    var out : PixelOut;
${outputWrites}
    return out;
}`;
            const colorTargets = targets.color.map(target => target ? {
                format: target.format,
                blend: s.enabled.has(GL.BLEND) && this.blendable(target.format) ?
                    gpuBlendState(s) : undefined,
                writeMask: (s.colorMask[0] ? 1 : 0) | (s.colorMask[1] ? 2 : 0) |
                    (s.colorMask[2] ? 4 : 0) | (s.colorMask[3] ? 8 : 0),
            } : null);
            const module = this.shaderModule(code);
            const descriptor = {
                label: "GL pixel rectangle pipeline",
                layout: "auto",
                vertex: { module, entryPoint: "vs_main", buffers: [{
                    arrayStride: 24, stepMode: "vertex", attributes: [
                        { shaderLocation: 0, format: "float32x4", offset: 0 },
                        { shaderLocation: 1, format: "float32x2", offset: 16 },
                    ],
                }] },
                fragment: { module, entryPoint: "fs_main", targets: colorTargets },
                primitive: { topology: "triangle-list", cullMode: "none" },
                multisample: { count: targets.sampleCount || 1 },
            };
            if (targets.depthFormat) {
                descriptor.depthStencil = {
                    format: targets.depthFormat,
                    depthWriteEnabled: !!(s.enabled.has(GL.DEPTH_TEST) && s.depthMask),
                    depthCompare: s.enabled.has(GL.DEPTH_TEST) ?
                        (COMPARE_FUNCTIONS[s.depthFunc] || "less") : "always",
                    ...(targets.depthFormat.indexOf("stencil") >= 0 ? gpuStencilState(s) : {}),
                };
            }
            const key = this.renderPipelineKey(this.pixelPipelineCache, descriptor);
            const pipeline = this.pixelPipelineCache.get(key);
            return pipeline || this.createPipeline(this.pixelPipelineCache, key, descriptor);
        },

        accum(op, value) {
            const ACCUM = 0x0100, LOAD = 0x0101, RETURN = 0x0102;
            const MULT = 0x0103, ADD = 0x0104;
            if (![ACCUM, LOAD, RETURN, MULT, ADD].includes(op))
                return this.refuse("glAccum", "invalid accumulation operation",
                    { op }, GL.INVALID_ENUM);
            this.endPass();
            const targets = this.currentTargets();
            if (!targets || !targets.color[0])
                return this.refuse("glAccum", "no colour buffer is bound", {},
                    GL.INVALID_OPERATION);
            const accum = this.ensureAccumBuffer(targets);
            const returning = op === RETURN;
            const color = targets.color[0];
            const destination = returning ? color.view : accum.nextView;
            const targetFormat = returning ? color.format : "rgba16float";
            const samples = returning ? targets.sampleCount || 1 : 1;
            const pipeline = this.accumPipeline(op, targetFormat, samples);
            if (!pipeline) return;
            const params = this.allocateUniform(16);
            if (!params) return;
            new Float32Array(this.uniformStaging.buffer, params.offset, 4)
                .set([value, 0, 0, 0]);
            this.device.queue.writeBuffer(params.buffer, params.offset,
                this.uniformStaging, params.offset, params.size);
            const pass = this.ensureEncoder().beginRenderPass({
                label: "GL accumulation operation",
                colorAttachments: [{ view: destination, loadOp: "load", storeOp: "store",
                    ...(returning && color.resolveTarget ? { resolveTarget: color.resolveTarget } : {}) }],
            });
            this.applyAccumScissor(pass, targets);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: accum.currentView },
                    { binding: 1, resource: returning ? this.fallbackView :
                        color.readView || color.view },
                    { binding: 2, resource: { buffer: params.buffer,
                        offset: params.offset, size: 16 } },
                ],
            }));
            pass.draw(3, 1, 0, 0);
            pass.end();
            if (!returning) {
                const texture = accum.currentTexture;
                accum.currentTexture = accum.nextTexture;
                accum.currentView = accum.nextView;
                accum.nextTexture = texture;
                accum.nextView = texture.createView();
            }
        },

        ensureAccumBuffer(targets) {
            const width = Math.max(1, targets.width);
            const height = Math.max(1, targets.height);
            const key = this.current.id + ":" + this.current.drawFramebuffer +
                ":" + width + "x" + height;
            if (this.accumBuffer && this.accumBuffer.key === key)
                return this.accumBuffer;
            if (this.accumBuffer) {
                this.retire(this.accumBuffer.currentTexture);
                this.retire(this.accumBuffer.nextTexture);
            }
            const create = label => this.createGPUTexture({
                label,
                size: { width, height, depthOrArrayLayers: 1 },
                format: "rgba16float",
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT |
                    TEXTURE_USAGE_TEXTURE_BINDING | TEXTURE_USAGE_COPY_SRC |
                    TEXTURE_USAGE_COPY_DST,
            });
            const currentTexture = create("GL accumulation buffer A");
            const nextTexture = create("GL accumulation buffer B");
            this.accumBuffer = {
                key, width, height,
                currentTexture, currentView: currentTexture.createView(),
                nextTexture, nextView: nextTexture.createView(),
            };
            return this.accumBuffer;
        },

        applyAccumScissor(pass, targets) {
            const s = this.current;
            if (s.enabled.has(GL.SCISSOR_TEST) && s.scissor.set) {
                const x = clamp(s.scissor.x, 0, targets.width);
                const y = clamp(s.scissor.y, 0, targets.height);
                pass.setScissorRect(x, y,
                    Math.max(0, Math.min(s.scissor.width, targets.width - x)),
                    Math.max(0, Math.min(s.scissor.height, targets.height - y)));
            } else {
                pass.setScissorRect(0, 0, targets.width, targets.height);
            }
        },

        accumPipeline(op, targetFormat, samples) {
            this.accumPipelineCache = this.accumPipelineCache || new Map();
            const returning = op === 0x0102;


            const expression = {
                0x0100: "oldAccum + framebuffer * params.value.x",
                0x0101: "framebuffer * params.value.x",
                0x0102: "oldAccum * params.value.x",
                0x0103: "oldAccum * params.value.x",
                0x0104: "oldAccum + vec4<f32>(params.value.x)",
            }[op];
            const code = `
struct Params { value : vec4<f32>, }
@group(0) @binding(0) var accumulation : texture_2d<f32>;
@group(0) @binding(1) var colorBuffer : texture_2d<f32>;
@group(0) @binding(2) var<uniform> params : Params;
@vertex fn vs_main(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) p : vec4<f32>) -> @location(0) vec4<f32> {
    let xy = vec2<i32>(p.xy);
    let oldAccum = textureLoad(accumulation, xy, 0);
    let framebuffer = textureLoad(colorBuffer, xy, 0);
    return ${expression};
}`;
            const module = this.shaderModule(code);
            const writeMask = returning ?
                (this.current.colorMask[0] ? 1 : 0) |
                (this.current.colorMask[1] ? 2 : 0) |
                (this.current.colorMask[2] ? 4 : 0) |
                (this.current.colorMask[3] ? 8 : 0) : 15;
            const descriptor = {
                    label: "GL accumulation pipeline",
                    layout: "auto",
                    vertex: { module, entryPoint: "vs_main" },
                    fragment: { module, entryPoint: "fs_main",
                        targets: [{ format: targetFormat, writeMask }] },
                    primitive: { topology: "triangle-list" },
                    multisample: { count: samples },
                };
            const key = this.renderPipelineKey(this.accumPipelineCache, descriptor);
            const pipeline = this.accumPipelineCache.get(key);
            return pipeline || this.createPipeline(this.accumPipelineCache, key, descriptor);
        },

        accumClearPipeline() {
            const color = Array.from(this.current.clearAccum)
                .map(value => Number(value).toPrecision(9));

            this.accumClearPipelineCache = this.accumClearPipelineCache || new Map();
            const code = `
@vertex fn vs_main(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
    return vec4<f32>(${color.join(", ")});
}`;
            const module = this.shaderModule(code);
            const descriptor = {
                label: "GL accumulation clear pipeline", layout: "auto",
                vertex: { module, entryPoint: "vs_main" },
                fragment: { module, entryPoint: "fs_main",
                    targets: [{ format: "rgba16float" }] },
                primitive: { topology: "triangle-list" },
            };
            const key = this.renderPipelineKey(this.accumClearPipelineCache, descriptor);
            const pipeline = this.accumClearPipelineCache.get(key);
            return pipeline || this.createPipeline(this.accumClearPipelineCache, key, descriptor);
        },
        setRasterPos(x, y, z, w) {
            // The raster position is transformed like a vertex; keeping it is
            // cheap and glWindowPos-based code depends on reading it back.
            const s = this.current;
            const eye = transformPoint4(this.topOf(GL.MODELVIEW),
                new Float32Array([x, y, z, w]), new Float32Array(4));
            const clip = transformPoint4(this.topOf(GL.PROJECTION), eye, new Float32Array(4));
            // GL 2.1 section 2.13: a point outside the clip volume, or on the
            // wrong side of an enabled user clip plane, leaves the raster
            // position invalid and glDrawPixels and glBitmap draw nothing
            // (review S2-15: only w = 0 did)
            const cw = clip[3];
            let valid = cw > 0 && Math.abs(clip[0]) <= cw && Math.abs(clip[1]) <= cw && Math.abs(clip[2]) <= cw;
            for (let i = 0; valid && i < MAX_CLIP_PLANES; ++i) {
                const plane = s.clipPlanes[i];
                if (s.enabled.has(GL.CLIP_PLANE0 + i) &&
                        plane[0] * eye[0] + plane[1] * eye[1] + plane[2] * eye[2] + plane[3] * eye[3] < 0)
                    valid = false;
            }
            s.current.rasterValid = valid;
            if (!valid) return;
            // (the current colour, unlit: lighting the raster position is to do)
            s.current.rasterColor.set(s.current.color);
            const ndcX = clip[0] / cw, ndcY = clip[1] / cw;
            const ndcZ = clip[2] / cw;
            s.current.rasterPos[0] = s.viewport.x +
                (ndcX * 0.5 + 0.5) * s.viewport.width;
            s.current.rasterPos[1] = s.viewport.y +
                (ndcY * 0.5 + 0.5) * s.viewport.height;
            s.current.rasterPos[2] = s.depthRange.near +
                (s.depthRange.far - s.depthRange.near) * (ndcZ * 0.5 + 0.5);
            s.current.rasterPos[3] = cw;
        },
        // Rebuild the GPU code from the CPU-accepted ARB source. A failure
        // here is a renderer/front-end disagreement, not a guest GL error.
        programStringARB(target, source) {
            const program = this.arbProgramFor(target);
            if (!program)
                return this.refuse("glProgramStringARB", "no ARB program bound",
                    { target }, GL.INVALID_OPERATION);
            const compiled = arbProgram.compileARBProgram(source, {});
            if (compiled.ok && compiled.target !== (target === GL.VERTEX_PROGRAM_ARB ? "vertex" : "fragment")) {
                compiled.ok = false; compiled.log = "ERROR: program header does not match the target"; compiled.errorPosition = 0;
            }
            if (!compiled.ok) return this.refuse("ARB code generation", "CPU-accepted program failed", {
                target, log: compiled.log, position: compiled.errorPosition,
            });
            program.source = source;
            program.target = target;
            program.compiled = compiled;
            if (program.variants) program.variants.clear();
            arbParameterStorage(program, PROGRAM_PARAMETER_ENV);
            ++this.stats.shaderLinks;
        },

        /*
         * {kind, target, index, count} then count*4 floats, or {kind, target,
         * index, reserved} then four doubles. openglproxy sends the parameter
         * kind first -- V86GL_PROGRAM_PARAMETER_ENV is 1 and _LOCAL is 2 --
         * and the target second.
         */
        programParameterARB(view, offset, size, doublePrecision) {
            const stride = doublePrecision ? 8 : 4;
            if (size < 16 + 4 * stride)
                throw new GLStreamError("ARB parameter record is short");
            // the two records agree up to index
            const F = protocol.F.PROGRAM_PARAMETER_FV_ARB;
            const kind = view.getUint32(offset + F.parameter_kind, true);
            const target = view.getUint32(offset + F.target, true);
            const index = view.getUint32(offset + F.index, true);
            // The double-precision record carries exactly one parameter; the
            // float one carries glProgramEnvParameters4fvEXT's whole run.
            const count = doublePrecision ? 1 :
                Math.max(1, view.getUint32(offset + F.count, true));
            // environment parameters are the context's, one set a target,
            // set whether or not a program is bound (review S2-46)
            const program = kind === PROGRAM_PARAMETER_ENV ? null : this.arbProgramFor(target);
            if (kind !== PROGRAM_PARAMETER_ENV && !program)
                return this.refuse("glProgramParameterARB",
                    "no ARB program is bound", { target },
                    GL.INVALID_OPERATION);
            const limit = arbProgram.parameterLimit(target === GL.VERTEX_PROGRAM_ARB ? "vertex" : "fragment");
            if (index >= limit || count > limit - index)
                return this.refuse("glProgramParameterARB",
                    "parameter index is beyond the advertised count",
                    { index, count }, GL.INVALID_VALUE);
            if (16 + count * 4 * stride > size)
                throw new GLStreamError("ARB parameter record is truncated");
            const storage = program ? arbParameterStorage(program, kind) : this.arbEnvironment(target);
            for (let i = 0; i < count * 4; ++i) {
                const at = offset + 16 + i * stride;
                storage[index * 4 + i] = doublePrecision ?
                    view.getFloat64(at, true) : view.getFloat32(at, true);
            }
        },

        // a target's environment parameters (ARB_vertex_program 2.14.1)
        arbEnvironment(target) {
            const s = this.current;
            s.arbEnvironment = s.arbEnvironment || new Map();
            let env = s.arbEnvironment.get(target);
            if (!env) s.arbEnvironment.set(target, env = new Float32Array(arbProgram.MAX_PROGRAM_PARAMETERS * 4));
            return env;
        },


        /* {kind, target, index, status, data_size, reserved} then the four
         * components at 24 -- the read-back twin of programParameterARB. */

        arbProgramFor(target) {
            const s = this.current;
            if (target !== GL.VERTEX_PROGRAM_ARB && target !== GL.FRAGMENT_PROGRAM_ARB) return null;
            const name = target === GL.VERTEX_PROGRAM_ARB ?
                s.arbVertexProgram : s.arbFragmentProgram;
            return name ? s.arbBindings.get(target) || s.shareGroup.arbPrograms.get(name) || null : s.arbDefaults[target];
        },
    });

    /*
     * Repacks a 256-aligned readback into the format the guest asked for.
     * GL's rows run bottom-up in the same direction the framebuffer does here,
     * so no vertical flip is involved -- which is the point of flipping in the
     * vertex shader instead.
     */
    // depth24plus loaded into r32float, for glReadPixels (readRectangle)
    const DEPTH_UPLOAD_WGSL = `
@group(0) @binding(0) var depths : texture_2d<f32>;
@group(0) @binding(1) var<uniform> origin : vec4<i32>;
@vertex fn vs_main(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) p : vec4<f32>) -> @builtin(frag_depth) f32 {
    return textureLoad(depths, vec2<i32>(p.xy) - origin.xy, 0).r;
}`;

    const DEPTH_READ_WGSL = `
@group(0) @binding(0) var depthTexture : texture_depth_2d;
@group(0) @binding(1) var<uniform> origin : vec4<u32>;
@vertex fn vs_main(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) p : vec4<f32>) -> @location(0) vec4<f32> {
    let at = vec2<i32>(p.xy) + vec2<i32>(origin.xy);
    return vec4<f32>(textureLoad(depthTexture, at, 0), 0.0, 0.0, 1.0);
}`;

    /*
     * A mapped readback's texels as values: RGBA floats a pixel for colour
     * (any of the formats a target has), a float for depth, an integer for
     * stencil.
     */
    function unpackReadback(mapped, bytesPerRow, width, height, format) {
        const view = new DataView(mapped.buffer, mapped.byteOffset, mapped.byteLength);
        const scalar = format === "r32float" || format === "depth16" || format === "stencil8" || format === "r8uint";
        const values = new Float32Array(width * height * (scalar ? 1 : 4));
        const bgra = format.startsWith("bgra");
        let w = 0;
        for (let row = 0; row < height; ++row) {
            const base = row * bytesPerRow;
            for (let col = 0; col < width; ++col) {
                switch (format) {
                case "r32float": values[w++] = view.getFloat32(base + col * 4, true); break;
                case "depth16": values[w++] = view.getUint16(base + col * 2, true) / 65535; break;
                case "stencil8": case "r8uint": values[w++] = mapped[base + col]; break;
                case "rgba32float":
                    for (let c = 0; c < 4; ++c) values[w++] = view.getFloat32(base + col * 16 + c * 4, true);
                    break;
                case "rgba16float":
                    for (let c = 0; c < 4; ++c) values[w++] = halfToFloat(view.getUint16(base + col * 8 + c * 2, true));
                    break;
                default: {
                    const at = base + col * 4;
                    values[w++] = mapped[at + (bgra ? 2 : 0)] / 255;
                    values[w++] = mapped[at + 1] / 255;
                    values[w++] = mapped[at + (bgra ? 0 : 2)] / 255;
                    values[w++] = mapped[at + 3] / 255;
                }
                }
            }
        }
        return values;
    }

    // GL 2.1 table 3.5's bits of each packed type's fields, first component first
    const PACKED_FIELDS = {
        [GL.UNSIGNED_BYTE_3_3_2]: [[5, 3], [2, 3], [0, 2]],
        [GL.UNSIGNED_BYTE_2_3_3_REV]: [[0, 3], [3, 3], [6, 2]],
        [GL.UNSIGNED_SHORT_5_6_5]: [[11, 5], [5, 6], [0, 5]],
        [GL.UNSIGNED_SHORT_5_6_5_REV]: [[0, 5], [5, 6], [11, 5]],
        [GL.UNSIGNED_SHORT_4_4_4_4]: [[12, 4], [8, 4], [4, 4], [0, 4]],
        [GL.UNSIGNED_SHORT_4_4_4_4_REV]: [[0, 4], [4, 4], [8, 4], [12, 4]],
        [GL.UNSIGNED_SHORT_5_5_5_1]: [[11, 5], [6, 5], [1, 5], [0, 1]],
        [GL.UNSIGNED_SHORT_1_5_5_5_REV]: [[0, 5], [5, 5], [10, 5], [15, 1]],
        [GL.UNSIGNED_INT_8_8_8_8]: [[24, 8], [16, 8], [8, 8], [0, 8]],
        [GL.UNSIGNED_INT_8_8_8_8_REV]: [[0, 8], [8, 8], [16, 8], [24, 8]],
        [GL.UNSIGNED_INT_10_10_10_2]: [[22, 10], [12, 10], [2, 10], [0, 2]],
        [GL.UNSIGNED_INT_2_10_10_10_REV]: [[0, 10], [10, 10], [20, 10], [30, 2]],
    };

    /*
     * glReadPixels' packing (GL 2.1 sections 4.3.2 and 3.6.1, table 3.5):
     * the format's components of each value (LUMINANCE is R + G + B), as
     * `type` stores them, at the place the pack state gives (alignment, row
     * length, skips, byte swapping). `values` covers the readable part of
     * the request, (dx, dy) into it; outside it the bytes stay zero.
     */
    function packPixels(out, values, width, height, dx, dy, requestWidth, format, type, pack) {
        if (!values) return;
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
        const little = !pack.swapBytes;
        const packed = PACKED_FIELDS[type];
        const elementBytes = TYPE_BYTES[type];
        const scalar = format === GL.DEPTH_COMPONENT || format === GL.STENCIL_INDEX || format === GL.COLOR_INDEX;
        const components = packed ? 1 : scalar ? 1 : SOURCE_COMPONENTS[format] || 4;
        const groupBytes = packed ? elementBytes : components * elementBytes;
        const rowBytes = alignUp((pack.rowLength || requestWidth) * groupBytes, pack.alignment || 4);
        const start = (pack.skipRows || 0) * rowBytes + (pack.skipPixels || 0) * groupBytes;
        const fixed = !(type === GL.FLOAT || type === GL.HALF_FLOAT);
        const pick = (v, i) => {
            if (scalar) return [v[i]];
            const r = v[i * 4], g = v[i * 4 + 1], b = v[i * 4 + 2], a = v[i * 4 + 3];
            const l = pack.textureImage ? r : r + g + b;
            switch (format) {
            case GL.RED: return [r];
            case GL.GREEN: return [g];
            case GL.BLUE: return [b];
            case GL.ALPHA: return [a];
            case GL.LUMINANCE: return [l];
            case GL.LUMINANCE_ALPHA: return [l, a];
            case GL.RGB: return [r, g, b];
            case GL.BGR: return [b, g, r];
            case GL.BGRA: return [b, g, r, a];
            case GL.ABGR_EXT: return [a, b, g, r];
            default: return [r, g, b, a];
            }
        };
        const store = (at, value) => {
            // a stencil index is an integer; the rest are normalised
            const c = format === GL.STENCIL_INDEX || format === GL.COLOR_INDEX || !fixed ? value : clamp(value, 0, 1);
            const n = format === GL.STENCIL_INDEX || format === GL.COLOR_INDEX ? 1 : 0;
            switch (type) {
            case GL.UNSIGNED_BYTE: view.setUint8(at, n ? c & 0xff : Math.round(c * 255)); break;
            case GL.BYTE: view.setInt8(at, n ? c : Math.round(c * 127)); break;
            case GL.UNSIGNED_SHORT: view.setUint16(at, n ? c & 0xffff : Math.round(c * 65535), little); break;
            case GL.SHORT: view.setInt16(at, n ? c : Math.round(c * 32767), little); break;
            case GL.UNSIGNED_INT: view.setUint32(at, n ? c >>> 0 : Math.round(c * 4294967295), little); break;
            case GL.INT: view.setInt32(at, n ? c : Math.round(c * 2147483647), little); break;
            case GL.HALF_FLOAT: view.setUint16(at, floatToHalf(c), little); break;
            default: view.setFloat32(at, c, little);
            }
        };
        for (let row = 0; row < height; ++row) {
            for (let col = 0; col < width; ++col) {
                const at = start + (dy + row) * rowBytes + (dx + col) * groupBytes;
                if (at + groupBytes > out.length) continue;
                const v = pick(values, row * width + col);
                if (packed) {
                    let word = 0;
                    packed.forEach(([shift, bits], k) => {
                        const max = (1 << bits) - 1;
                        word += Math.round(clamp(k < v.length ? v[k] : 1, 0, 1) * max) * Math.pow(2, shift);
                    });
                    if (elementBytes === 1) view.setUint8(at, word);
                    else if (elementBytes === 2) view.setUint16(at, word, little);
                    else view.setUint32(at, word >>> 0, little);
                } else {
                    v.forEach((value, k) => store(at + k * elementBytes, value));
                }
            }
        }
    }

    /* ================================================================== */
    /* Adapter capability reporting for the CPU shadow                    */
    /* ================================================================== */

    // Report physical adapter capabilities once. The shadow freezes the
    // public GL profile, including its limits and extension strings.
    Object.assign(GLWebGPUExecutor.prototype, {

        // What the adapter backs, as gl_caps.js answers from it (the shadow
        // is sent the same object)
        capabilities() {
            return glCaps.capabilities(this.limits, this.deviceFeatures);
        },


    });

    /* ================================================================== */
    /* Public API                                                         */
    /* ================================================================== */

    function installGLWebGPUExecutor(canvas, options) {
        const executor = new GLWebGPUExecutor(canvas, options);
        // Start GPU allocation before the first accepted rendering batch.
        executor.initialize().catch(() => { /* reported by initialize */ });
        return executor;
    }

    const api = {
        EXECUTOR_REVISION,
        GLWebGPUExecutor, installGLWebGPUExecutor,
        // Exported for the test suite.
        expandIndices, expandIndexArray, expandedIndexCount,
        convertPixels, decodeDXT, storageFormatFor, readSourceTexel, unpackReadback,
        applyBaseFormat, normalMatrixOf, multiply4, invert4, transpose4,
        createContextState, buildHandlerTable, activeShaderBindings,
        colorCopyWGSL, MIPMAP_WGSL, COLOR_BLIT_WGSL,
        PRIMITIVE_TOPOLOGY, BLEND_FACTORS, COMPARE_FUNCTIONS,
        STENCIL_OPERATIONS, ADDRESS_MODES,
        GLWG_RESPONSE_REGION_BYTES, GLWG_QUERY_REGION_BYTES,
        GLWG_READBACK_REGION_OFFSET, GLWG_HEARTBEAT_OFFSET,
        GLWG_RESPONSE_PENDING, GLWG_RESPONSE_OK, GLWG_RESPONSE_FAILED,
        SYNC_STATUS_PENDING, SYNC_STATUS_OK, SYNC_STATUS_FAILED,
    };
    global.installGLWebGPUExecutor = installGLWebGPUExecutor;
    global.GLWebGPUExecutorModule = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
