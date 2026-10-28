// What the GLES host says about itself (docs/gles-proxy-plan.md): its EGL
// configurations as renderControl packs them, its strings, the GLES
// implementation limits and the state's initial values that queries answer.
// The executor (E3) and the shadow state (E2) keep to the same numbers.

/** EGL's enums (EGL 1.4, EGL_KHR_image_base, EGL_ANDROID_recordable) */
export const EGL = {
    NONE: 0x3038, DONT_CARE: -1, TRUE: 1, FALSE: 0,
    BUFFER_SIZE: 0x3020, ALPHA_SIZE: 0x3021, BLUE_SIZE: 0x3022, GREEN_SIZE: 0x3023, RED_SIZE: 0x3024, DEPTH_SIZE: 0x3025,
    STENCIL_SIZE: 0x3026, CONFIG_CAVEAT: 0x3027, CONFIG_ID: 0x3028, LEVEL: 0x3029, MAX_PBUFFER_HEIGHT: 0x302A,
    MAX_PBUFFER_PIXELS: 0x302B, MAX_PBUFFER_WIDTH: 0x302C, NATIVE_RENDERABLE: 0x302D, NATIVE_VISUAL_ID: 0x302E,
    NATIVE_VISUAL_TYPE: 0x302F, PRESERVED_RESOURCES: 0x3030, SAMPLES: 0x3031, SAMPLE_BUFFERS: 0x3032, SURFACE_TYPE: 0x3033,
    TRANSPARENT_TYPE: 0x3034, TRANSPARENT_BLUE_VALUE: 0x3035, TRANSPARENT_GREEN_VALUE: 0x3036, TRANSPARENT_RED_VALUE: 0x3037,
    BIND_TO_TEXTURE_RGB: 0x3039, BIND_TO_TEXTURE_RGBA: 0x303A, MIN_SWAP_INTERVAL: 0x303B, MAX_SWAP_INTERVAL: 0x303C,
    LUMINANCE_SIZE: 0x303D, ALPHA_MASK_SIZE: 0x303E, COLOR_BUFFER_TYPE: 0x303F, RENDERABLE_TYPE: 0x3040,
    MATCH_NATIVE_PIXMAP: 0x3041, CONFORMANT: 0x3042, RECORDABLE_ANDROID: 0x3142, FRAMEBUFFER_TARGET_ANDROID: 0x3147,
    SLOW_CONFIG: 0x3050, NON_CONFORMANT_CONFIG: 0x3051, RGB_BUFFER: 0x308E, LUMINANCE_BUFFER: 0x308F,
    PBUFFER_BIT: 1, WINDOW_BIT: 4, OPENGL_ES_BIT: 1, OPENGL_ES2_BIT: 4, OPENGL_ES3_BIT: 0x40,
    VENDOR: 0x3053, VERSION: 0x3054, EXTENSIONS: 0x3055, CLIENT_APIS: 0x308D,
    CONDITION_SATISFIED_KHR: 0x30F6,
};

/**
 * The attributes of a configuration in renderControl's order (gfxstream's
 * host/gl/EmulatedEglConfig.cpp kConfigAttributes: the guest finds them by
 * the first row rcGetConfigs gives, so the order is the host's own)
 */
export const CONFIG_ATTRIBUTES = [
    EGL.DEPTH_SIZE, EGL.STENCIL_SIZE, EGL.RENDERABLE_TYPE, EGL.SURFACE_TYPE, EGL.CONFIG_ID, EGL.BUFFER_SIZE,
    EGL.ALPHA_SIZE, EGL.BLUE_SIZE, EGL.GREEN_SIZE, EGL.RED_SIZE, EGL.CONFIG_CAVEAT, EGL.LEVEL, EGL.MAX_PBUFFER_HEIGHT,
    EGL.MAX_PBUFFER_PIXELS, EGL.MAX_PBUFFER_WIDTH, EGL.NATIVE_RENDERABLE, EGL.NATIVE_VISUAL_ID, EGL.NATIVE_VISUAL_TYPE,
    EGL.PRESERVED_RESOURCES, EGL.SAMPLES, EGL.SAMPLE_BUFFERS, EGL.TRANSPARENT_TYPE, EGL.TRANSPARENT_BLUE_VALUE,
    EGL.TRANSPARENT_GREEN_VALUE, EGL.TRANSPARENT_RED_VALUE, EGL.BIND_TO_TEXTURE_RGB, EGL.BIND_TO_TEXTURE_RGBA,
    EGL.MIN_SWAP_INTERVAL, EGL.MAX_SWAP_INTERVAL, EGL.LUMINANCE_SIZE, EGL.ALPHA_MASK_SIZE, EGL.COLOR_BUFFER_TYPE,
    EGL.RECORDABLE_ANDROID, EGL.CONFORMANT,
];

/** The largest surface and texture (WebGPU's default maxTextureDimension2D is 8192) */
export const MAX_SIZE = 4096;

/** Android's HAL pixel formats, a configuration's EGL_NATIVE_VISUAL_ID (SurfaceFlinger matches it) */
const HAL_PIXEL_FORMAT = { RGBA_8888: 1, RGBX_8888: 2, RGB_565: 4 };

/**
 * The configurations: RGBA8888, RGBX8888 and RGB565, each without depth,
 * with 16- or 24-bit depth, and with 24-bit depth and 8-bit stencil; no
 * multisampling (E4). The guest's configuration is its index, its
 * EGL_CONFIG_ID the index plus 1.
 * @type {!Array<!Array<number>>} each in CONFIG_ATTRIBUTES' order
 */
export const CONFIGS = [];
for(const [r, g, b, a, visual] of [[8, 8, 8, 8, HAL_PIXEL_FORMAT.RGBA_8888], [8, 8, 8, 0, HAL_PIXEL_FORMAT.RGBX_8888],
    [5, 6, 5, 0, HAL_PIXEL_FORMAT.RGB_565]])
{
    for(const [depth, stencil] of [[0, 0], [16, 0], [24, 0], [24, 8]])
    {
        const values = new Map([
            [EGL.DEPTH_SIZE, depth], [EGL.STENCIL_SIZE, stencil], [EGL.RENDERABLE_TYPE, EGL.OPENGL_ES_BIT | EGL.OPENGL_ES2_BIT],
            [EGL.SURFACE_TYPE, EGL.WINDOW_BIT | EGL.PBUFFER_BIT], [EGL.CONFIG_ID, CONFIGS.length + 1],
            [EGL.BUFFER_SIZE, r + g + b + a], [EGL.ALPHA_SIZE, a], [EGL.BLUE_SIZE, b], [EGL.GREEN_SIZE, g], [EGL.RED_SIZE, r],
            [EGL.CONFIG_CAVEAT, EGL.NONE], [EGL.LEVEL, 0], [EGL.MAX_PBUFFER_HEIGHT, MAX_SIZE], [EGL.MAX_PBUFFER_PIXELS, MAX_SIZE * MAX_SIZE],
            [EGL.MAX_PBUFFER_WIDTH, MAX_SIZE], [EGL.NATIVE_RENDERABLE, EGL.FALSE], [EGL.NATIVE_VISUAL_ID, visual],
            [EGL.NATIVE_VISUAL_TYPE, EGL.NONE], [EGL.PRESERVED_RESOURCES, 0], [EGL.SAMPLES, 0], [EGL.SAMPLE_BUFFERS, 0],
            [EGL.TRANSPARENT_TYPE, EGL.NONE], [EGL.TRANSPARENT_BLUE_VALUE, 0], [EGL.TRANSPARENT_GREEN_VALUE, 0],
            [EGL.TRANSPARENT_RED_VALUE, 0], [EGL.BIND_TO_TEXTURE_RGB, a ? EGL.FALSE : EGL.TRUE], [EGL.BIND_TO_TEXTURE_RGBA, a ? EGL.TRUE : EGL.FALSE],
            [EGL.MIN_SWAP_INTERVAL, 0], [EGL.MAX_SWAP_INTERVAL, 1], [EGL.LUMINANCE_SIZE, 0], [EGL.ALPHA_MASK_SIZE, 0],
            [EGL.COLOR_BUFFER_TYPE, EGL.RGB_BUFFER], [EGL.RECORDABLE_ANDROID, EGL.TRUE], [EGL.CONFORMANT, EGL.OPENGL_ES_BIT | EGL.OPENGL_ES2_BIT],
        ]);
        CONFIGS.push(CONFIG_ATTRIBUTES.map(attribute => values.get(attribute)));
    }
}

/**
 * The configurations as a host of the GLES version answers them: GLES 3.x's
 * add EGL_OPENGL_ES3_BIT_KHR to EGL_RENDERABLE_TYPE and EGL_CONFORMANT (an
 * application asks for it to make a GLES 3 context, dEQP-GLES3 too)
 * @param {number} max_version 20, or 30 to 32
 * @return {!Array<!Array<number>>}
 */
export function configs_for(max_version)
{
    if(max_version < 30) return CONFIGS;
    if(!configs_for.es3)
    {
        const types = [CONFIG_ATTRIBUTES.indexOf(EGL.RENDERABLE_TYPE), CONFIG_ATTRIBUTES.indexOf(EGL.CONFORMANT)];
        configs_for.es3 = CONFIGS.map(config => config.map((value, i) => types.includes(i) ? value | EGL.OPENGL_ES3_BIT : value));
    }
    return configs_for.es3;
}

/** How eglChooseConfig compares an attribute (EGL 1.4, table 3.4): the default value and the rule */
const MATCH = new Map([
    [EGL.BUFFER_SIZE, [0, "atleast"]], [EGL.RED_SIZE, [0, "atleast"]], [EGL.GREEN_SIZE, [0, "atleast"]],
    [EGL.BLUE_SIZE, [0, "atleast"]], [EGL.LUMINANCE_SIZE, [0, "atleast"]], [EGL.ALPHA_SIZE, [0, "atleast"]],
    [EGL.ALPHA_MASK_SIZE, [0, "atleast"]], [EGL.BIND_TO_TEXTURE_RGB, [EGL.DONT_CARE, "exact"]],
    [EGL.BIND_TO_TEXTURE_RGBA, [EGL.DONT_CARE, "exact"]], [EGL.COLOR_BUFFER_TYPE, [EGL.RGB_BUFFER, "exact"]],
    [EGL.CONFIG_CAVEAT, [EGL.DONT_CARE, "exact"]], [EGL.CONFIG_ID, [EGL.DONT_CARE, "exact"]],
    [EGL.CONFORMANT, [0, "mask"]], [EGL.DEPTH_SIZE, [0, "atleast"]], [EGL.LEVEL, [0, "exact"]],
    [EGL.MAX_SWAP_INTERVAL, [EGL.DONT_CARE, "exact"]], [EGL.MIN_SWAP_INTERVAL, [EGL.DONT_CARE, "exact"]],
    [EGL.NATIVE_RENDERABLE, [EGL.DONT_CARE, "exact"]], [EGL.NATIVE_VISUAL_TYPE, [EGL.DONT_CARE, "exact"]],
    [EGL.RENDERABLE_TYPE, [EGL.OPENGL_ES_BIT, "mask"]], [EGL.SAMPLE_BUFFERS, [0, "atleast"]], [EGL.SAMPLES, [0, "atleast"]],
    [EGL.STENCIL_SIZE, [0, "atleast"]], [EGL.SURFACE_TYPE, [EGL.WINDOW_BIT, "mask"]], [EGL.TRANSPARENT_TYPE, [EGL.NONE, "exact"]],
    [EGL.TRANSPARENT_RED_VALUE, [EGL.DONT_CARE, "exact"]], [EGL.TRANSPARENT_GREEN_VALUE, [EGL.DONT_CARE, "exact"]],
    [EGL.TRANSPARENT_BLUE_VALUE, [EGL.DONT_CARE, "exact"]], [EGL.RECORDABLE_ANDROID, [EGL.DONT_CARE, "exact"]],
    // (every configuration is one: the guest's EGL answers EGL_TRUE for it)
    [EGL.FRAMEBUFFER_TARGET_ANDROID, [EGL.DONT_CARE, "true"]],
]);

/**
 * eglChooseConfig on the configurations (EGL 1.4, 3.4.1.2): the matching
 * configurations' indices in EGL's sort order. Attributes EGL ignores
 * (EGL_MAX_PBUFFER_*, EGL_NATIVE_VISUAL_ID) and unknown ones are ignored.
 * @param {!Array<number>} attribs pairs, up to EGL_NONE
 * @param {!Array<!Array<number>>=} configs configs_for's, CONFIGS unless given
 * @return {!Array<number>}
 */
export function choose_configs(attribs, configs = CONFIGS)
{
    const wanted = new Map([...MATCH].map(([attribute, [value]]) => [attribute, value]));
    for(let i = 0; i + 1 < attribs.length && attribs[i] !== EGL.NONE; i += 2) if(MATCH.has(attribs[i])) wanted.set(attribs[i], attribs[i + 1]);
    const value_of = (config, attribute) => configs[config][CONFIG_ATTRIBUTES.indexOf(attribute)];
    const matching = [];
    configs.forEach((config, index) =>
    {
        for(const [attribute, value] of wanted)
        {
            if(value === EGL.DONT_CARE) continue;
            const rule = MATCH.get(attribute)[1];
            if(rule === "true") { if(value !== EGL.TRUE) return; continue; }
            const own = value_of(index, attribute);
            if(rule === "atleast" ? own < value : rule === "mask" ? (own & value) !== value : own !== value) return;
        }
        matching.push(index);
    });
    // (the color bits counted: those asked for with a value above 0)
    const color = config => [EGL.RED_SIZE, EGL.GREEN_SIZE, EGL.BLUE_SIZE, EGL.ALPHA_SIZE]
        .reduce((sum, attribute) => sum + (wanted.get(attribute) > 0 ? value_of(config, attribute) : 0), 0);
    const caveat = config => [EGL.NONE, EGL.SLOW_CONFIG, EGL.NON_CONFORMANT_CONFIG].indexOf(value_of(config, EGL.CONFIG_CAVEAT));
    const keys = [caveat, config => value_of(config, EGL.COLOR_BUFFER_TYPE), config => -color(config),
        ...[EGL.BUFFER_SIZE, EGL.SAMPLE_BUFFERS, EGL.SAMPLES, EGL.DEPTH_SIZE, EGL.STENCIL_SIZE, EGL.ALPHA_MASK_SIZE,
            EGL.CONFIG_ID].map(attribute => config => value_of(config, attribute))];
    return matching.sort((x, y) =>
    {
        for(const key of keys) if(key(x) !== key(y)) return key(x) - key(y);
        return 0;
    });
}

/** The EGL strings rcQueryEGLString answers (the guest's EGL makes its own extension string) */
export const EGL_STRINGS = new Map([
    [EGL.VENDOR, "v86"],
    [EGL.VERSION, "1.4 v86"],
    [EGL.EXTENSIONS, "EGL_KHR_image_base EGL_KHR_gl_texture_2D_image EGL_ANDROID_recordable "],
    [EGL.CLIENT_APIS, "OpenGL_ES"],
]);

/** GL's string names */
const GL_VENDOR = 0x1F00;
const GL_RENDERER = 0x1F01;
const GL_VERSION = 0x1F02;
const GL_EXTENSIONS = 0x1F03;
const GL_SHADING_LANGUAGE_VERSION = 0x8B8C;

/**
 * The extensions each API's contexts have. A short list on purpose: each
 * is something E3 (GLES 2.0) or E4 (GLES 1.1) implements; more when an
 * application needs it. No host feature strings (ANDROID_EMU_*): no
 * checksums, GLES 2.0 at most (docs/gles-proxy-plan.md "协议与生成器").
 */
const EXTENSIONS = {
    1: ["GL_OES_EGL_image", "GL_OES_EGL_image_external", "GL_OES_compressed_ETC1_RGB8_texture", "GL_OES_element_index_uint",
        "GL_OES_framebuffer_object", "GL_OES_depth24", "GL_OES_packed_depth_stencil", "GL_OES_rgb8_rgba8", "GL_OES_texture_npot",
        "GL_OES_blend_func_separate", "GL_OES_blend_equation_separate", "GL_OES_blend_subtract",
        "GL_OES_draw_texture", "GL_OES_point_sprite", "GL_OES_point_size_array", "GL_EXT_texture_format_BGRA8888"],
    2: ["GL_OES_EGL_image", "GL_OES_EGL_image_external", "GL_OES_compressed_ETC1_RGB8_texture", "GL_OES_element_index_uint",
        "GL_OES_depth24", "GL_OES_packed_depth_stencil", "GL_OES_rgb8_rgba8", "GL_OES_texture_npot", "GL_OES_standard_derivatives",
        "GL_EXT_texture_format_BGRA8888"],
    // (GLES 3.x: GLES 2.0's, those 3.0 has in its core too: the guest's EGL makes a GLES 2.0 context one of the
    // highest version announced, and GLES 2.0 programs, dEQP-GLES2 among them, look for them; docs/gles3-plan.md)
    3: ["GL_OES_EGL_image", "GL_OES_EGL_image_external", "GL_OES_EGL_image_external_essl3", "GL_OES_compressed_ETC1_RGB8_texture",
        "GL_OES_element_index_uint", "GL_OES_depth24", "GL_OES_packed_depth_stencil", "GL_OES_rgb8_rgba8", "GL_OES_texture_npot",
        "GL_OES_standard_derivatives", "GL_EXT_texture_format_BGRA8888"],
};

/** GL_EXTENSIONS of GLES 3.x's contexts, as glGetStringi counts them */
export const EXTENSIONS_3 = EXTENSIONS[3];

/**
 * What rcGetGLString answers: the strings of the connection's current
 * context's API (1: GLES 1.1, 2: GLES 2.0, 30 to 32: GLES 3.0 to 3.2;
 * none current: 2.0's). The extensions end with the host's feature string
 * of the highest version announced (ANDROID_EMU_gles_max_version_3_*),
 * which the guest's libraries look for there (docs/gles3-plan.md).
 * @param {number} name
 * @param {number} api
 * @param {number=} max_version 20 to 32
 * @return {string} "" for a name it does not know
 */
export function gl_string(name, api, max_version)
{
    const es3 = api >= 30;
    switch(name)
    {
        case GL_VENDOR: return "v86";
        case GL_RENDERER: return "v86 GLES (WebGPU)";
        case GL_VERSION: return api === 1 ? "OpenGL ES-CM 1.1 v86" : es3 ? "OpenGL ES " + (api / 10).toFixed(1) + " v86" : "OpenGL ES 2.0 v86";
        case GL_EXTENSIONS:
        {
            const feature = max_version >= 30 ? "ANDROID_EMU_gles_max_version_" + (max_version / 10).toFixed(1).replace(".", "_") + " " : "";
            return EXTENSIONS[api === 1 ? 1 : es3 ? 3 : 2].join(" ") + " " + feature;
        }
        case GL_SHADING_LANGUAGE_VERSION: return api === 1 ? "" : es3 ? "OpenGL ES GLSL ES " + (api / 10).toFixed(2) : "OpenGL ES GLSL ES 1.00";
    }
    return "";
}

/** The compressed texture formats (GL_COMPRESSED_TEXTURE_FORMATS): ETC1 */
export const COMPRESSED_TEXTURE_FORMATS = [0x8D64];

/**
 * The implementation's limits and the state's initial values, by pname:
 * what glGet* answers before the shadow state (E2) tracks the value.
 * Values are numbers (booleans 0 or 1); the viewport and scissor box are
 * the draw surface's (gles_defaults.js).
 * @type {!Map<number, !Array<number>>}
 */
export const GL_STATE = new Map([
    // limits (GLES 2.0 table 6.18-6.20; WebGPU's defaults bound them)
    [0x0D33, [MAX_SIZE]], // GL_MAX_TEXTURE_SIZE
    [0x851C, [MAX_SIZE]], // GL_MAX_CUBE_MAP_TEXTURE_SIZE
    [0x84E8, [MAX_SIZE]], // GL_MAX_RENDERBUFFER_SIZE
    [0x0D3A, [MAX_SIZE, MAX_SIZE]], // GL_MAX_VIEWPORT_DIMS
    [0x8869, [16]], // GL_MAX_VERTEX_ATTRIBS
    [0x8DFB, [256]], // GL_MAX_VERTEX_UNIFORM_VECTORS
    [0x8DFC, [15]], // GL_MAX_VARYING_VECTORS
    [0x8DFD, [224]], // GL_MAX_FRAGMENT_UNIFORM_VECTORS
    [0x8B4D, [32]], // GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS
    [0x8B4C, [16]], // GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS
    [0x8872, [16]], // GL_MAX_TEXTURE_IMAGE_UNITS
    [0x846D, [1, 256]], // GL_ALIASED_POINT_SIZE_RANGE
    [0x846E, [1, 1]], // GL_ALIASED_LINE_WIDTH_RANGE
    [0x0D50, [4]], // GL_SUBPIXEL_BITS
    [0x80A8, [0]], // GL_SAMPLE_BUFFERS
    [0x80A9, [0]], // GL_SAMPLES
    [0x86A2, [COMPRESSED_TEXTURE_FORMATS.length]], // GL_NUM_COMPRESSED_TEXTURE_FORMATS
    [0x86A3, COMPRESSED_TEXTURE_FORMATS], // GL_COMPRESSED_TEXTURE_FORMATS
    [0x8DF9, [0]], // GL_NUM_SHADER_BINARY_FORMATS
    [0x8DFA, [1]], // GL_SHADER_COMPILER
    [0x8B9A, [0x1401]], // GL_IMPLEMENTATION_COLOR_READ_TYPE: GL_UNSIGNED_BYTE
    [0x8B9B, [0x1908]], // GL_IMPLEMENTATION_COLOR_READ_FORMAT: GL_RGBA
    // GLES 1.1's (table 6.25-6.26)
    [0x0D31, [8]], // GL_MAX_LIGHTS
    [0x0D32, [6]], // GL_MAX_CLIP_PLANES
    [0x0D36, [16]], // GL_MAX_MODELVIEW_STACK_DEPTH
    [0x0D38, [2]], // GL_MAX_PROJECTION_STACK_DEPTH
    [0x0D39, [2]], // GL_MAX_TEXTURE_STACK_DEPTH
    [0x84E2, [4]], // GL_MAX_TEXTURE_UNITS
    [0x0B12, [1, 1]], // GL_SMOOTH_POINT_SIZE_RANGE
    [0x0B22, [1, 1]], // GL_SMOOTH_LINE_WIDTH_RANGE
    // initial values (GLES 2.0 tables 6.2-6.17, GLES 1.1's)
    [0x0B70, [0, 1]], // GL_DEPTH_RANGE
    [0x0B21, [1]], // GL_LINE_WIDTH
    [0x0B45, [0x0405]], // GL_CULL_FACE_MODE: GL_BACK
    [0x0B46, [0x0901]], // GL_FRONT_FACE: GL_CCW
    [0x80AA, [1]], // GL_SAMPLE_COVERAGE_VALUE
    [0x84E0, [0x84C0]], // GL_ACTIVE_TEXTURE: GL_TEXTURE0
    [0x84E1, [0x84C0]], // GL_CLIENT_ACTIVE_TEXTURE: GL_TEXTURE0
    [0x0C23, [1, 1, 1, 1]], // GL_COLOR_WRITEMASK
    [0x0B72, [1]], // GL_DEPTH_WRITEMASK
    [0x0B98, [-1]], // GL_STENCIL_WRITEMASK
    [0x8CA5, [-1]], // GL_STENCIL_BACK_WRITEMASK
    [0x0B73, [1]], // GL_DEPTH_CLEAR_VALUE
    [0x0B74, [0x0201]], // GL_DEPTH_FUNC: GL_LESS
    [0x80C9, [1]], // GL_BLEND_SRC_RGB: GL_ONE
    [0x80CB, [1]], // GL_BLEND_SRC_ALPHA: GL_ONE
    [0x0BE1, [1]], // GL_BLEND_SRC: GL_ONE
    [0x8009, [0x8006]], // GL_BLEND_EQUATION_RGB: GL_FUNC_ADD
    [0x883D, [0x8006]], // GL_BLEND_EQUATION_ALPHA: GL_FUNC_ADD
    [0x0B92, [0x0207]], // GL_STENCIL_FUNC: GL_ALWAYS
    [0x8800, [0x0207]], // GL_STENCIL_BACK_FUNC: GL_ALWAYS
    [0x0B93, [-1]], // GL_STENCIL_VALUE_MASK
    [0x8CA4, [-1]], // GL_STENCIL_BACK_VALUE_MASK
    [0x0B94, [0x1E00]], [0x0B95, [0x1E00]], [0x0B96, [0x1E00]], // GL_STENCIL_FAIL, _PASS_DEPTH_FAIL, _PASS_DEPTH_PASS: GL_KEEP
    [0x8801, [0x1E00]], [0x8802, [0x1E00]], [0x8803, [0x1E00]], // the back face's
    [0x0CF5, [4]], // GL_UNPACK_ALIGNMENT
    [0x0D05, [4]], // GL_PACK_ALIGNMENT
    [0x8192, [0x1100]], // GL_GENERATE_MIPMAP_HINT: GL_DONT_CARE
    [0x0C50, [0x1100]], [0x0C51, [0x1100]], [0x0C52, [0x1100]], [0x0C54, [0x1100]], // GLES 1.1's hints
    [0x0BA0, [0x1700]], // GL_MATRIX_MODE: GL_MODELVIEW
    [0x0B54, [0x1D01]], // GL_SHADE_MODEL: GL_SMOOTH
    [0x0B00, [1, 1, 1, 1]], // GL_CURRENT_COLOR
    [0x0B02, [0, 0, 1]], // GL_CURRENT_NORMAL
    [0x0B03, [0, 0, 0, 1]], // GL_CURRENT_TEXTURE_COORDS
    [0x0B11, [1]], // GL_POINT_SIZE
    [0x8127, [256]], // GL_POINT_SIZE_MAX
    [0x8128, [1]], // GL_POINT_FADE_THRESHOLD_SIZE
    [0x8129, [1, 0, 0]], // GL_POINT_DISTANCE_ATTENUATION
    [0x0BC1, [0x0207]], // GL_ALPHA_TEST_FUNC: GL_ALWAYS
    [0x0B65, [0x0800]], // GL_FOG_MODE: GL_EXP
    [0x0B62, [1]], // GL_FOG_DENSITY
    [0x0B64, [1]], // GL_FOG_END
    [0x0B53, [0.2, 0.2, 0.2, 1]], // GL_LIGHT_MODEL_AMBIENT
    [0x0BF0, [0x1503]], // GL_LOGIC_OP_MODE: GL_COPY
    [0x0BA3, [1]], [0x0BA4, [1]], [0x0BA5, [1]], // the matrix stacks' depths
    [0x0BA6, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]], // GL_MODELVIEW_MATRIX
    [0x0BA7, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]], // GL_PROJECTION_MATRIX
    [0x0BA8, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]], // GL_TEXTURE_MATRIX
]);

/** The capabilities enabled at first: GL_DITHER, GLES 1.1's GL_MULTISAMPLE */
export const GL_ENABLED_INITIALLY = [0x0BD0, 0x809D];
