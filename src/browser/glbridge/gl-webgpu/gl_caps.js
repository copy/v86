// What the renderer can do, as OpenGL reports it (docs/opengl-webgpu-plan.md
// C3: the capabilities come from one place). The page's executor and the CPU
// side's shadow (gl_shadow.js) both answer from here. A capabilities object
// is { limits, features } as the WebGPU adapter reports them -- plain data:
// the renderer sends it to the device once its adapter is up, and the device
// keeps it in its snapshot, so a guest restored on another machine is told
// what it was told before.

(function(global) {
    "use strict";

    const constants = global.GLWGConstants || require("./gl_constants.js");
    const protocol = global.GLProtocol || require("./gl_protocol.js");
    const GL = constants.GL;

    // Fixed by the executor's design, whatever the adapter
    const LIMITS = {
        MAX_TEXTURE_UNITS: 8,
        MAX_TEXTURE_COORDS: 8,
        MAX_TEXTURE_IMAGE_UNITS: 8,
        MAX_VERTEX_TEXTURE_IMAGE_UNITS: 8,
        MAX_COMBINED_TEXTURE_IMAGE_UNITS: 8,
        MAX_LIGHTS: 8,
        MAX_CLIP_PLANES: 6,
        MAX_VERTEX_ATTRIBS: 16,
        MAX_NAME_STACK_DEPTH: 64,
        MAX_EVAL_ORDER: protocol.C.V86GL_MAX_EVAL_ORDER,
        MAX_ATTRIB_STACK_DEPTH: 16,
        MAX_CLIENT_ATTRIB_STACK_DEPTH: 16,
        MAX_POINT_SIZE: 64,
        MAX_LINE_WIDTH: 64,
        MAX_DRAW_BUFFERS: 8,
        MAX_PIXEL_MAP_TABLE: protocol.C.V86GL_MAX_TYPED_QUERY_VALUES,
        MODELVIEW_STACK_DEPTH: 32,
        OTHER_STACK_DEPTH: 4,
        MAX_PROGRAM_MATRICES: 8,
        PROGRAM_MATRIX_STACK_DEPTH: 2,
        // gl_shader_translator.js's MAX_INTER_STAGE_SLOTS vec4s
        MAX_VARYING_FLOATS: 16 * 4,
    };

    const BASE_EXTENSIONS = [
        "GL_ARB_multitexture", "GL_ARB_texture_env_add",
        "GL_ARB_texture_env_combine", "GL_ARB_texture_env_dot3",
        "GL_ARB_texture_env_crossbar", "GL_ARB_texture_cube_map",
        "GL_ARB_texture_border_clamp", "GL_ARB_texture_mirrored_repeat",
        "GL_ARB_texture_compression", "GL_SGI_color_matrix",
        "GL_ARB_texture_non_power_of_two", "GL_ARB_depth_texture",
        "GL_ARB_shadow", "GL_ARB_point_parameters", "GL_ARB_point_sprite",
        "GL_ARB_transpose_matrix", "GL_ARB_window_pos",
        "GL_ARB_vertex_buffer_object", "GL_ARB_occlusion_query",
        "GL_ARB_multisample", "GL_ARB_shader_objects",
        "GL_ARB_vertex_shader", "GL_ARB_fragment_shader",
        "GL_ARB_shading_language_100", "GL_ARB_draw_buffers",
        "GL_EXT_texture3D", "GL_EXT_texture_lod_bias",
        "GL_EXT_texture_edge_clamp", "GL_EXT_blend_color",
        "GL_EXT_blend_minmax", "GL_EXT_blend_subtract",
        "GL_EXT_blend_func_separate", "GL_EXT_blend_equation_separate",
        "GL_EXT_stencil_wrap", "GL_EXT_stencil_two_side",
        "GL_EXT_secondary_color", "GL_EXT_fog_coord",
        "GL_EXT_packed_pixels", "GL_EXT_rescale_normal",
        "GL_EXT_separate_specular_color", "GL_EXT_bgra",
        "GL_EXT_framebuffer_object", "GL_EXT_framebuffer_blit",
        "GL_EXT_generate_mipmap",
        "GL_SGIS_generate_mipmap", "GL_SGIS_texture_edge_clamp",
        "GL_SGIS_texture_lod", "GL_NV_blend_square",
    ];

    /*
     * The capabilities to send: the adapter limits the answers use, and the
     * features. limits and features are the executor's (WebGPU's
     * GPUSupportedLimits, and its own feature flags).
     */
    function capabilities(limits, features) {
        limits = limits || {};
        features = features || {};
        return {
            limits: {
                maxTextureDimension2D: limits.maxTextureDimension2D || 8192,
                maxTextureDimension3D: limits.maxTextureDimension3D || 2048,
                maxColorAttachments: limits.maxColorAttachments || 8,
            },
            features: {
                bc: !!features.bc,
                float32Filterable: !!features.float32Filterable,
                depthClipControl: !!features.depthClipControl,
            },
        };
    }

    function extensions(caps) {
        if (caps.profile) return caps.profile.strings[GL.EXTENSIONS];
        const list = [...BASE_EXTENSIONS];
        // Only advertised when the adapter really has the BC formats: the
        // CPU decode path keeps the picture right, but a guest that sees
        // S3TC will hand us compressed data forever, and saying so honestly
        // lets it choose.
        if (caps.features.bc)
            list.push("GL_EXT_texture_compression_s3tc");
        if (caps.features.float32Filterable)
            list.push("GL_ARB_texture_float", "GL_ARB_half_float_pixel");
        if (caps.features.depthClipControl)
            list.push("GL_ARB_depth_clamp");
        list.push("GL_EXT_texture_filter_anisotropic");
        return list.join(" ");
    }

    // glGetString's answer, or undefined when pname is not a capability
    function string(caps, pname) {
        if (caps.profile) return caps.profile.strings[pname];
        switch (pname) {
        case GL.VENDOR: return "VMware, Inc.";
        case GL.RENDERER: return "SVGA3D; v86 WebGPU bridge";
        case GL.VERSION: return "2.1 v86gl (WebGPU)";
        case GL.SHADING_LANGUAGE_VERSION: return "1.20 v86gl";
        case GL.EXTENSIONS: return extensions(caps);
        default: return undefined;
        }
    }

    // The DLL chooses a WineD3D compatibility hint; the CPU owns the answer.
    // WineD3D 1.7.52 treats an unknown vendor as GeForce FX, disables NPOT,
    // and then selects rectangle textures. Preserve its known SVGA3D path.
    // A hint only hides capabilities; it never grants an unimplemented one.
    function profileString(caps, profile, pname) {
        if (!profile) return string(caps, pname);
        const C = protocol.C, legacy = profile === C.V86GL_CAPS_PROFILE_WINED3D_GL15 ||
            profile === C.V86GL_CAPS_PROFILE_WINED3D_ARB;
        switch (pname) {
        case GL.VENDOR: return "VMware, Inc.";
        case GL.RENDERER: return "SVGA3D; v86 WebGPU bridge";
        case GL.VERSION: return legacy ? "1.5 v86gl (WineD3D backbuffer profile)" : "2.1 v86gl (WebGPU)";
        case GL.SHADING_LANGUAGE_VERSION: return legacy ? undefined : string(caps, pname);
        case GL.EXTENSIONS:
            return extensions(caps).split(" ").filter(name => {
                if (legacy && ["GL_ARB_shader_objects", "GL_ARB_vertex_shader", "GL_ARB_fragment_shader", "GL_ARB_shading_language_100"].includes(name)) return false;
                if ((legacy || profile === C.V86GL_CAPS_PROFILE_GL21_NO_FBO) &&
                    ["GL_EXT_framebuffer_object", "GL_EXT_framebuffer_blit"].includes(name)) return false;
                if ((profile === C.V86GL_CAPS_PROFILE_WINED3D_GL15 || profile === C.V86GL_CAPS_PROFILE_GL21_FBO_FFP) &&
                    ["GL_ARB_vertex_program", "GL_ARB_fragment_program"].includes(name)) return false;
                return true;
            }).join(" ");
        default: return string(caps, pname);
        }
    }

    // glGetIntegerv's answer, or undefined when pname is not a capability
    function integer(caps, pname) {
        if (caps.profile) return caps.profile.integers[pname];
        const limits = caps.limits;
        const C = protocol.C;
        switch (pname) {
        case C.V86GL_QUERY_HOST_CAPABILITIES:
            return C.V86GL_HOST_CAP_WEBGL2 | C.V86GL_HOST_CAP_COLOR_BUFFER_FLOAT |
                (caps.features.float32Filterable ? C.V86GL_HOST_CAP_TEXTURE_FLOAT_LINEAR : 0) |
                C.V86GL_HOST_CAP_ANISOTROPY;
        case GL.MAX_TEXTURE_SIZE:
            return Math.min(16384, limits.maxTextureDimension2D);
        case GL.MAX_3D_TEXTURE_SIZE:
            return Math.min(2048, limits.maxTextureDimension3D);
        case GL.MAX_CUBE_MAP_TEXTURE_SIZE:
            return Math.min(16384, limits.maxTextureDimension2D);
        case GL.MAX_TEXTURE_UNITS: return LIMITS.MAX_TEXTURE_UNITS;
        case GL.MAX_PROGRAM_MATRICES_ARB: return LIMITS.MAX_PROGRAM_MATRICES;
        case GL.MAX_PROGRAM_MATRIX_STACK_DEPTH_ARB: return LIMITS.PROGRAM_MATRIX_STACK_DEPTH;
        case GL.MAX_EVAL_ORDER: return LIMITS.MAX_EVAL_ORDER;
        case GL.MAX_ATTRIB_STACK_DEPTH: return LIMITS.MAX_ATTRIB_STACK_DEPTH;
        case GL.MAX_CLIENT_ATTRIB_STACK_DEPTH: return LIMITS.MAX_CLIENT_ATTRIB_STACK_DEPTH;
        case GL.MAX_COLOR_MATRIX_STACK_DEPTH_SGI: return LIMITS.OTHER_STACK_DEPTH;
        case GL.RGBA_MODE: return 1;
        case GL.STEREO: return 0;
        case GL.AUX_BUFFERS: case GL.INDEX_MODE: case GL.INDEX_BITS:
        case GL.ACCUM_RED_BITS: case GL.ACCUM_GREEN_BITS: case GL.ACCUM_BLUE_BITS: case GL.ACCUM_ALPHA_BITS: return 0;
        case GL.MAX_TEXTURE_COORDS: return LIMITS.MAX_TEXTURE_COORDS;
        case GL.MAX_TEXTURE_IMAGE_UNITS: return LIMITS.MAX_TEXTURE_IMAGE_UNITS;
        case GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS: return LIMITS.MAX_VERTEX_TEXTURE_IMAGE_UNITS;
        case GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS: return LIMITS.MAX_COMBINED_TEXTURE_IMAGE_UNITS;
        case GL.MAX_VERTEX_ATTRIBS: return LIMITS.MAX_VERTEX_ATTRIBS;
        case GL.MAX_NAME_STACK_DEPTH: return LIMITS.MAX_NAME_STACK_DEPTH;
        case GL.MAX_VARYING_FLOATS: return LIMITS.MAX_VARYING_FLOATS;
        case GL.MAX_VERTEX_UNIFORM_COMPONENTS: return 1024;
        case GL.MAX_FRAGMENT_UNIFORM_COMPONENTS: return 1024;
        case GL.MAX_DRAW_BUFFERS:
        case GL.MAX_COLOR_ATTACHMENTS:
            return Math.min(LIMITS.MAX_DRAW_BUFFERS, limits.maxColorAttachments);
        case GL.MAX_RENDERBUFFER_SIZE:
            return Math.min(16384, limits.maxTextureDimension2D);
        case GL.MAX_LIGHTS: return LIMITS.MAX_LIGHTS;
        case GL.MAX_PIXEL_MAP_TABLE: return LIMITS.MAX_PIXEL_MAP_TABLE;
        case GL.MAX_CLIP_PLANES: return LIMITS.MAX_CLIP_PLANES;
        case GL.MAX_MODELVIEW_STACK_DEPTH: return LIMITS.MODELVIEW_STACK_DEPTH;
        case GL.MAX_PROJECTION_STACK_DEPTH: return LIMITS.OTHER_STACK_DEPTH;
        case GL.MAX_TEXTURE_STACK_DEPTH: return LIMITS.OTHER_STACK_DEPTH;
        case GL.MAX_TEXTURE_MAX_ANISOTROPY_EXT: return 16;
        case GL.MAX_TEXTURE_LOD_BIAS: return 16;
        case GL.MAX_ELEMENTS_VERTICES: return 65536;
        case GL.MAX_ELEMENTS_INDICES: return 65536;
        case GL.SAMPLE_BUFFERS: return 0;
        // GL_SAMPLES is zero when the selected framebuffer has no
        // multisample buffer; one is the raster sample count, not the GL
        // query value for this pixel format.
        case GL.SAMPLES: return 0;
        case GL.SUBPIXEL_BITS: return 8;
        case GL.RED_BITS: case GL.GREEN_BITS:
        case GL.BLUE_BITS: case GL.ALPHA_BITS: return 8;
        case GL.DEPTH_BITS: return 24;
        case GL.STENCIL_BITS: return 8;
        case GL.MAX_VIEWPORT_DIMS:
            return Math.min(16384, limits.maxTextureDimension2D);
        case GL.NUM_COMPRESSED_TEXTURE_FORMATS:
            return caps.features.bc ? 4 : 0;
        default: return undefined;
        }
    }

    function vector(caps, pname) {
        if (caps.profile?.vectors && Object.hasOwn(caps.profile.vectors, pname)) return caps.profile.vectors[pname];
        switch (pname) {
        case GL.POINT_SIZE_RANGE: case GL.ALIASED_POINT_SIZE_RANGE: return [1, LIMITS.MAX_POINT_SIZE];
        case GL.LINE_WIDTH_RANGE: case GL.ALIASED_LINE_WIDTH_RANGE: return [1, LIMITS.MAX_LINE_WIDTH];
        case GL.POINT_SIZE_GRANULARITY: case GL.LINE_WIDTH_GRANULARITY: return [1];
        case GL.COMPRESSED_TEXTURE_FORMATS:
            return [GL.COMPRESSED_RGB_S3TC_DXT1_EXT, GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, GL.COMPRESSED_RGBA_S3TC_DXT3_EXT, GL.COMPRESSED_RGBA_S3TC_DXT5_EXT]
                .slice(0, integer(caps, GL.NUM_COMPRESSED_TEXTURE_FORMATS));
        default: return undefined;
        }
    }

    // Keep the virtual device's advertised values independent of later host
    // adapters and bridge revisions. Copy first: the renderer owns its input.
    function freeze(caps) {
        if (!caps) return null;
        const result = capabilities(caps.limits, caps.features);
        let integers = {}, strings = {}, vectors = {};
        if (caps.profile) {
            integers = { ...caps.profile.integers }; strings = { ...caps.profile.strings };
            // Values formerly answered by the DLL remain stable in saves
            // predating the CPU vector capability table.
            for (const [pname, value] of [[GL.MAX_ATTRIB_STACK_DEPTH, 16], [GL.MAX_CLIENT_ATTRIB_STACK_DEPTH, 16],
                [GL.MAX_COLOR_MATRIX_STACK_DEPTH_SGI, 2], [GL.MAX_PROGRAM_MATRICES_ARB, LIMITS.MAX_PROGRAM_MATRICES],
                [GL.MAX_PROGRAM_MATRIX_STACK_DEPTH_ARB, LIMITS.PROGRAM_MATRIX_STACK_DEPTH], [GL.RGBA_MODE, 1], [GL.STEREO, 0]]) if (integers[pname] === undefined) integers[pname] = value;
            for (const pname of [GL.AUX_BUFFERS, GL.INDEX_MODE, GL.INDEX_BITS, GL.ACCUM_RED_BITS, GL.ACCUM_GREEN_BITS, GL.ACCUM_BLUE_BITS, GL.ACCUM_ALPHA_BITS])
                if (integers[pname] === undefined) integers[pname] = 0;
        } else {
            for (const pname of new Set([...Object.values(GL), protocol.C.V86GL_QUERY_HOST_CAPABILITIES])) {
                const value = integer(result, pname), text = string(result, pname);
                if (value !== undefined) integers[pname] = value;
                if (text !== undefined) strings[pname] = text;
            }
        }
        for (const pname of [GL.POINT_SIZE_RANGE, GL.ALIASED_POINT_SIZE_RANGE, GL.LINE_WIDTH_RANGE, GL.ALIASED_LINE_WIDTH_RANGE, GL.POINT_SIZE_GRANULARITY, GL.LINE_WIDTH_GRANULARITY, GL.COMPRESSED_TEXTURE_FORMATS])
            vectors[pname] = Object.freeze(Array.from(vector(caps, pname)));
        result.profile = Object.freeze({ version: 2, integers: Object.freeze(integers), strings: Object.freeze(strings), vectors: Object.freeze(vectors) });
        Object.freeze(result.limits); Object.freeze(result.features);
        return Object.freeze(result);
    }

    const api = { LIMITS, capabilities, extensions, string, profileString, integer, vector, freeze };
    global.GLCaps = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
