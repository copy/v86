// glslang for the GLES host (docs/gles3-plan.md, "着色器的数据流"): the
// module tools/glslang/build.sh builds (bios/glslang.wasm; its interface
// tools/glslang/v86_glslang.cpp), synchronous once instantiated, as the
// shadow state answers glCompileShader and glLinkProgram at once.
//
// check_shader, check_program: OpenGL ES's rules at the shader's own
// version; the info logs and GL's reflection. program_spirv: each stage's
// SPIR-V under Vulkan's relaxed rules, with that program's reflection.

/** glslang's EShLanguage, by GL's shader type */
export const STAGE = { vertex: 0, tess_control: 1, tess_evaluation: 2, geometry: 3, fragment: 4, compute: 5 };
export const STAGE_OF_GL_TYPE = new Map([[0x8B31, 0], [0x8E88, 1], [0x8E87, 2], [0x8DD9, 3], [0x8B30, 4], [0x91B9, 5]]);

const ERRNO_NOSYS = 52;

/**
 * Compile the module (asynchronously: browsers refuse large modules
 * compiled synchronously on the page's thread)
 * @param {!ArrayBuffer|!Uint8Array} bytes
 * @return {!Promise<!WebAssembly.Module>}
 */
export function compile_glslang(bytes)
{
    return WebAssembly.compile(bytes);
}

/**
 * An instance of the module
 * @param {!WebAssembly.Module} module
 * @return {!Promise<!Glslang>}
 */
export async function create_glslang(module)
{
    const glslang = new Glslang();
    const instance = await WebAssembly.instantiate(/** @type {?} */ (module), glslang.imports());
    glslang.exports = instance.exports;
    glslang.exports["_initialize"]();
    return glslang;
}

/** @constructor */
export function Glslang()
{
    /** @type {!Object} */
    this.exports = {};
    /** what glslang printed (it should print nothing) */
    this.printed = "";
    /** @type {Object<string, number>} the limits set last */
    this.limits = null;
}

/** @return {!Uint8Array} the module's memory as it is (it may grow) */
Glslang.prototype.memory = function()
{
    return new Uint8Array(this.exports["memory"].buffer);
};

Glslang.prototype.imports = function()
{
    const view = () => new DataView(this.exports["memory"].buffer);
    return {
        "env": {
            "emscripten_notify_memory_growth": () => {},
            "__syscall_getcwd": () => -ERRNO_NOSYS,
        },
        "wasi_snapshot_preview1": {
            "fd_write": (fd, iovs, count, written) =>
            {
                let total = 0;
                for(let i = 0; i < count; i++)
                {
                    const pointer = view().getUint32(iovs + 8 * i, true), length = view().getUint32(iovs + 8 * i + 4, true);
                    this.printed += new TextDecoder().decode(this.memory().subarray(pointer, pointer + length));
                    total += length;
                }
                view().setUint32(written, total, true);
                return 0;
            },
            "fd_close": () => 0,
            "fd_seek": () => ERRNO_NOSYS,
            "environ_sizes_get": (count, size) => { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0; },
            "environ_get": () => 0,
        },
    };
};

/**
 * Bytes into the module's memory, for one call
 * @param {!Uint8Array} bytes
 * @param {function(number):*} call with the pointer
 */
Glslang.prototype.with_bytes = function(bytes, call)
{
    const pointer = this.exports["v86_glslang_alloc"](Math.max(1, bytes.length));
    this.memory().set(bytes, pointer);
    try
    {
        return call(pointer);
    }
    finally
    {
        this.exports["v86_glslang_free"](pointer);
    }
};

/** @return {!Uint8Array} the last call's output (a copy) */
Glslang.prototype.output = function()
{
    const pointer = this.exports["v86_glslang_output"](), size = this.exports["v86_glslang_output_size"]();
    return this.memory().slice(pointer, pointer + size);
};

/**
 * The limits gl_Max* and the checks see
 * @param {!Object<string, number>} limits by glslangValidator's names ("MaxDrawBuffers")
 */
Glslang.prototype.set_limits = function(limits)
{
    if(limits === this.limits) return;
    this.limits = limits;
    const text = Object.entries(limits).map(([name, value]) => name + " " + value).join("\n") + "\n";
    this.with_bytes(new TextEncoder().encode(text + "\0"), pointer => this.exports["v86_glslang_limits"](pointer));
};

/**
 * @param {!Array<{stage: number, source: string}>} shaders
 * @return {!Uint8Array} as the module takes them
 */
function pack(shaders)
{
    const encoded = shaders.map(s => new TextEncoder().encode(s.source));
    const bytes = new Uint8Array(encoded.reduce((n, e) => n + 8 + (e.length + 3 & ~3), 0));
    const view = new DataView(bytes.buffer);
    let at = 0;
    shaders.forEach((s, i) =>
    {
        view.setUint32(at, s.stage, true);
        view.setUint32(at + 4, encoded[i].length, true);
        bytes.set(encoded[i], at + 8);
        at += 8 + (encoded[i].length + 3 & ~3);
    });
    return bytes;
}

/**
 * One shader, OpenGL ES's rules
 * @param {number} stage STAGE's
 * @param {string} source
 * @return {{ok: boolean, log: string}}
 */
Glslang.prototype.check_shader = function(stage, source)
{
    const packed = pack([{ stage, source }]);
    const ok = this.with_bytes(packed, pointer => this.exports["v86_glslang_compile"](pointer, packed.length));
    return { ok: !!ok, log: new TextDecoder().decode(this.output()) };
};

/**
 * A program, OpenGL ES's rules
 * @param {!Array<{stage: number, source: string}>} shaders
 * @param {number=} flags
 * @return {!Object} {ok, log} and GL's reflection: uniforms, uniformBlocks,
 *     bufferVariables, bufferBlocks, inputs, outputs, atomicCounters, localSize
 */
Glslang.prototype.check_program = function(shaders, flags)
{
    const packed = pack(shaders);
    this.with_bytes(packed, pointer => this.exports["v86_glslang_link"](pointer, packed.length, flags || 0));
    return JSON.parse(new TextDecoder().decode(this.output()));
};

/**
 * A program's SPIR-V, Vulkan's relaxed rules
 * @param {!Array<{stage: number, source: string}>} shaders
 * @param {number=} flags
 * @return {!Object} {ok, log, reflection fields as check_program's, modules: [{stage, words}]}
 */
Glslang.prototype.program_spirv = function(shaders, flags)
{
    const packed = pack(shaders);
    this.with_bytes(packed, pointer => this.exports["v86_glslang_spirv"](pointer, packed.length, flags || 0));
    const out = this.output();
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const json_length = view.getUint32(0, true);
    const result = JSON.parse(new TextDecoder().decode(out.subarray(4, 4 + json_length)));
    result.modules = [];
    for(let at = 4 + json_length + 3 & ~3; at + 8 <= out.length;)
    {
        const stage = view.getUint32(at, true), count = view.getUint32(at + 4, true);
        result.modules.push({ stage, words: new Uint32Array(out.slice(at + 8, at + 8 + 4 * count).buffer) });
        at += 8 + 4 * count;
    }
    return result;
};
