// D3D9 shader-model 1.x/2.0/3.0 bytecode -> WGSL translation pipeline (M2).
//
// Plan section 9 proposed vkd3d-shader(wasm) -> SPIR-V -> Tint(wasm) -> WGSL
// and argued (9.2) that a hand-written translator is unrealistic because
// SM2.0/3.0 needs "a control flow graph builder and SSA register versioning".
// That argument holds for a *SPIR-V* backend, which is an SSA form and does
// need both. It does not hold for WGSL, and this module takes the shorter
// route for one specific reason:
//
//   D3D9 shader assembly and WGSL are both imperative languages with mutable
//   variables and *structurally* nested control flow. D3D9 has no arbitrary
//   jumps: if/else/endif, rep/endrep, loop/endloop and call/ret nest properly
//   by specification, which is exactly WGSL's if/loop/function vocabulary.
//   So the translation is a statement-by-statement transliteration against
//   `var<private>` registers -- no basic blocks, no CFG, no SSA, no phi
//   nodes. That is what makes this a few hundred lines instead of a compiler.
//
// What that buys, versus the vkd3d/Tint toolchain: no Emscripten/Dawn build
// to keep alive, no LGPL redistribution obligation (plan section 25 flags
// this as unresolved for vkd3d), and a translator that is unit-testable
// directly in Node. What it costs: correctness rests on this file's own test
// suite instead of Wine's decades of game coverage, and the few ps_1_x
// texture-addressing forms with no honest translation are refused (see
// UNSUPPORTED_OPS) rather than approximated. compileShader() is the seam: it takes raw
// bytecode and returns WGSL + reflection, so swapping in a WASM backend later
// changes only this file.
//
// Everything here is pure computation over a Uint32Array -- no WebGPU calls,
// no DOM -- so glbridge/tests/d3d9_shader_pipeline_test.js can exercise it in
// plain Node. d3d9_executor.js owns turning the WGSL into a GPUShaderModule
// and running getCompilationInfo() on it (plan 9.6).

(function(global) {
    "use strict";

    // ---- bytecode constants (d3d9types.h) ----

    const D3DSI_OPCODE_MASK = 0x0000ffff;
    const D3DSI_INSTLENGTH_MASK = 0x0f000000;
    const D3DSI_INSTLENGTH_SHIFT = 24;
    const D3DSI_PREDICATED = 0x10000000;
    const D3DSI_COMMENTSIZE_SHIFT = 16;
    const D3DSI_COMMENTSIZE_MASK = 0x7fff;
    const D3DSP_OPCODESPECIFICCONTROL_SHIFT = 16;
    const D3DSP_OPCODESPECIFICCONTROL_MASK = 0x00ff0000;

    const D3DSP_REGNUM_MASK = 0x000007ff;
    const D3DSP_WRITEMASK_SHIFT = 16;
    const D3DSP_DSTMOD_SHIFT = 20;
    const D3DSP_DSTSHIFT_SHIFT = 24;
    const D3DSP_SWIZZLE_SHIFT = 16;
    const D3DSP_SRCMOD_SHIFT = 24;
    const D3DSHADER_ADDRESSMODE_RELATIVE = 1 << 13;

    // Register type is split across two bit fields (bits 28-30 and 11-12).
    function regTypeOf(token) {
        return ((token >>> 28) & 0x7) | ((token >>> 8) & 0x18);
    }

    const REG_TEMP = 0;
    const REG_INPUT = 1;
    const REG_CONST = 2;
    const REG_ADDR = 3;      // vertex shaders: a0
    const REG_TEXTURE = 3;   // pixel shaders: t#  (same numeric type)
    const REG_RASTOUT = 4;
    const REG_ATTROUT = 5;
    const REG_OUTPUT = 6;    // vs_3_0 o#; vs_1_1/2_0 call the same type TEXCRDOUT
    const REG_CONSTINT = 7;
    const REG_COLOROUT = 8;
    const REG_DEPTHOUT = 9;
    const REG_SAMPLER = 10;
    const REG_CONST2 = 11;
    const REG_CONST3 = 12;
    const REG_CONST4 = 13;
    const REG_CONSTBOOL = 14;
    const REG_LOOP = 15;
    const REG_MISCTYPE = 17;
    const REG_LABEL = 18;
    const REG_PREDICATE = 19;

    const RASTOUT_POSITION = 0;
    const RASTOUT_FOG = 1;
    const RASTOUT_POINTSIZE = 2;

    const MISC_POSITION = 0; // vPos
    const MISC_FACE = 1;     // vFace

    const SRCMOD_NONE = 0, SRCMOD_NEG = 1, SRCMOD_BIAS = 2, SRCMOD_BIASNEG = 3,
        SRCMOD_SIGN = 4, SRCMOD_SIGNNEG = 5, SRCMOD_COMP = 6, SRCMOD_X2 = 7,
        SRCMOD_X2NEG = 8, SRCMOD_DZ = 9, SRCMOD_DW = 10, SRCMOD_ABS = 11,
        SRCMOD_ABSNEG = 12, SRCMOD_NOT = 13;

    const DSTMOD_SATURATE = 1;

    const OP = {
        NOP: 0, MOV: 1, ADD: 2, SUB: 3, MAD: 4, MUL: 5, RCP: 6, RSQ: 7,
        DP3: 8, DP4: 9, MIN: 10, MAX: 11, SLT: 12, SGE: 13, EXP: 14, LOG: 15,
        LIT: 16, DST: 17, LRP: 18, FRC: 19, M4x4: 20, M4x3: 21, M3x4: 22,
        M3x3: 23, M3x2: 24, CALL: 25, CALLNZ: 26, LOOP: 27, RET: 28,
        ENDLOOP: 29, LABEL: 30, DCL: 31, POW: 32, CRS: 33, SGN: 34, ABS: 35,
        NRM: 36, SINCOS: 37, REP: 38, ENDREP: 39, IF: 40, IFC: 41, ELSE: 42,
        ENDIF: 43, BREAK: 44, BREAKC: 45, MOVA: 46, DEFB: 47, DEFI: 48,
        TEXCOORD: 64, TEXKILL: 65, TEX: 66, TEXBEM: 67, TEXBEML: 68,
        TEXREG2AR: 69, TEXREG2GB: 70, TEXM3x2PAD: 71, TEXM3x2TEX: 72,
        TEXM3x3PAD: 73, TEXM3x3TEX: 74, TEXM3x3SPEC: 76, TEXM3x3VSPEC: 77,
        EXPP: 78, LOGP: 79, CND: 80, DEF: 81, TEXREG2RGB: 82, TEXDP3TEX: 83,
        TEXM3x2DEPTH: 84, TEXDP3: 85, TEXM3x3: 86, TEXDEPTH: 87, CMP: 88,
        BEM: 89, DP2ADD: 90, DSX: 91, DSY: 92, TEXLDD: 93, SETP: 94,
        TEXLDL: 95, BREAKP: 96,
        PHASE: 0xfffd, COMMENT: 0xfffe, END: 0xffff,
    };

    const OP_NAMES = (() => {
        const names = {};
        for (const key of Object.keys(OP)) names[OP[key]] = key.toLowerCase();
        return names;
    })();

    // What remains of the ps_1_x texture-addressing family after the bump and
    // matrix forms were implemented (see the TEXBEM/TEXM3x*/BEM cases in
    // emit()).
    //
    // These three are the ones with no honest translation. TEXDEPTH and
    // TEXM3x2DEPTH replace the fragment's depth from a texture-addressing
    // result, which needs a frag_depth output the surrounding pipeline is not
    // built for; TEXM3x3 is the Radeon-era variant that writes a 3x3 result
    // without sampling, and nothing that reaches this translator emits it.
    // Refusing keeps the "no pretending" discipline: the shader is marked
    // unusable and draws that bind it are counted and skipped, rather than
    // silently rendering something wrong.
    const UNSUPPORTED_OPS = new Set([
        OP.TEXM3x2DEPTH, OP.TEXM3x3, OP.TEXDEPTH,
    ]);

    // Operand shape per opcode: [destCount, sourceCount]. SM2.0+ instruction
    // tokens also carry a length field, which parseShader() uses as the
    // authoritative stride; this table is what drives operand decoding, and
    // is the only source of truth for SM1.x where no length field exists.
    const OPERANDS = {
        [OP.NOP]: [0, 0], [OP.MOV]: [1, 1], [OP.ADD]: [1, 2], [OP.SUB]: [1, 2],
        [OP.MAD]: [1, 3], [OP.MUL]: [1, 2], [OP.RCP]: [1, 1], [OP.RSQ]: [1, 1],
        [OP.DP3]: [1, 2], [OP.DP4]: [1, 2], [OP.MIN]: [1, 2], [OP.MAX]: [1, 2],
        [OP.SLT]: [1, 2], [OP.SGE]: [1, 2], [OP.EXP]: [1, 1], [OP.LOG]: [1, 1],
        [OP.LIT]: [1, 1], [OP.DST]: [1, 2], [OP.LRP]: [1, 3], [OP.FRC]: [1, 1],
        [OP.M4x4]: [1, 2], [OP.M4x3]: [1, 2], [OP.M3x4]: [1, 2],
        [OP.M3x3]: [1, 2], [OP.M3x2]: [1, 2],
        [OP.CALL]: [0, 1], [OP.CALLNZ]: [0, 2], [OP.LOOP]: [0, 2],
        [OP.RET]: [0, 0], [OP.ENDLOOP]: [0, 0], [OP.LABEL]: [0, 1],
        [OP.POW]: [1, 2], [OP.CRS]: [1, 2], [OP.SGN]: [1, 3], [OP.ABS]: [1, 1],
        [OP.NRM]: [1, 1], [OP.REP]: [0, 1], [OP.ENDREP]: [0, 0],
        [OP.IF]: [0, 1], [OP.IFC]: [0, 2], [OP.ELSE]: [0, 0],
        [OP.ENDIF]: [0, 0], [OP.BREAK]: [0, 0], [OP.BREAKC]: [0, 2],
        [OP.BREAKP]: [0, 1], [OP.MOVA]: [1, 1], [OP.SETP]: [1, 2],
        [OP.TEXCOORD]: [1, 0], [OP.TEXKILL]: [1, 0],
        [OP.EXPP]: [1, 1], [OP.LOGP]: [1, 1], [OP.CND]: [1, 3],
        [OP.CMP]: [1, 3], [OP.DP2ADD]: [1, 3], [OP.DSX]: [1, 1],
        [OP.DSY]: [1, 1], [OP.TEXLDD]: [1, 4], [OP.TEXLDL]: [1, 2],
        [OP.TEXREG2AR]: [1, 1], [OP.TEXREG2GB]: [1, 1],
        [OP.TEXREG2RGB]: [1, 1], [OP.PHASE]: [0, 0],
        // The UNSUPPORTED_OPS family still needs an operand shape: the stream
        // has to decode cleanly before translate() can refuse the shader with
        // a message naming the instruction, rather than dying at "unknown
        // opcode" and hiding which feature was actually missing. BEM is
        // translated, and is here because it is the one ps_1_4 form that takes
        // two sources.
        [OP.TEXBEM]: [1, 1], [OP.TEXBEML]: [1, 1], [OP.BEM]: [1, 2],
        [OP.TEXM3x2PAD]: [1, 1], [OP.TEXM3x2TEX]: [1, 1],
        [OP.TEXM3x3PAD]: [1, 1], [OP.TEXM3x3TEX]: [1, 1],
        [OP.TEXM3x3SPEC]: [1, 2], [OP.TEXM3x3VSPEC]: [1, 1],
        [OP.TEXM3x2DEPTH]: [1, 1], [OP.TEXM3x3]: [1, 1],
        [OP.TEXDEPTH]: [1, 0], [OP.TEXDP3TEX]: [1, 1], [OP.TEXDP3]: [1, 1],
    };

    const WRITEMASK_NAMES = ["x", "y", "z", "w"];
    // Written as a hex float because that is the only spelling guaranteed to
    // be exact: the shortest decimal that round-trips through a double,
    // 3.4028235e38, is *above* f32's maximum once parsed, and Tint rejects it
    // outright ("cannot be represented as 'f32'") even though naga accepts it.
    // 0x1.fffffep+127 is f32 max exactly.
    const FLOAT_MAX = "0x1.fffffep+127";

    // Canonical vertex-output/pixel-input varying slots. Vertex and pixel
    // shaders are compiled into separate GPUShaderModules and only meet
    // inside a GPURenderPipeline, so their @location numbering has to be
    // fixed by semantic rather than negotiated per pair. Every translated
    // vertex shader emits all of these (WebGPU allows a vertex stage to
    // produce outputs the fragment stage ignores, but not the reverse), so
    // no VS/PS combination can ever fail to link.
    // Identifies *this build of the translator* to the persistent shader
    // cache. The cache's own `version` field describes the storage format, so
    // it stayed at 1 while the translator changed underneath it -- and every
    // entry already in IndexedDB was then restored verbatim, WGSL and
    // reflection included. The effect is a translator fix that does nothing
    // for exactly the shaders that have been seen before, which is silent, and
    // survives a reload: the symptom is a change that "did not work" plus a
    // reflection field that reads undefined because the stored object predates
    // it. Both happened here.
    //
    // The page already versions this file through the ?v= cache-buster it is
    // loaded with, and that string is bumped whenever the file changes, so
    // deriving the revision from it keeps the two in step with no extra
    // discipline. Outside a browser (the Node test suite) one constant serves,
    // because there the cache never outlives the process.
    const TRANSLATOR_REVISION = (function() {
        if (global.V86GL_BUILD_REVISION) return global.V86GL_BUILD_REVISION;
        try {
            const script = typeof document !== "undefined" &&
                document.currentScript;
            const source = script && script.src;
            if (source) {
                const query = source.indexOf("?v=");
                if (query >= 0) return source.slice(query + 3);
                return source;
            }
        } catch (error) { /* no document: fall through */ }
        return "node";
    })();

    const VARYING_COLOR0 = 0;
    const VARYING_COLOR1 = 1;
    const VARYING_TEXCOORD0 = 2; // .. 9 for TEXCOORD0..7
    const VARYING_FOG = 10;
    const VARYING_COUNT = 11;

    const DECLUSAGE_POSITION = 0, DECLUSAGE_BLENDWEIGHT = 1,
        DECLUSAGE_BLENDINDICES = 2, DECLUSAGE_NORMAL = 3, DECLUSAGE_PSIZE = 4,
        DECLUSAGE_TEXCOORD = 5, DECLUSAGE_TANGENT = 6, DECLUSAGE_BINORMAL = 7,
        DECLUSAGE_TESSFACTOR = 8, DECLUSAGE_POSITIONT = 9, DECLUSAGE_COLOR = 10,
        DECLUSAGE_FOG = 11, DECLUSAGE_DEPTH = 12, DECLUSAGE_SAMPLE = 13;

    /*
     * vs_1_x has no `dcl_` instructions: what a v# register means is fixed by
     * the API rather than declared by the shader. D3D8 spells that table as
     * D3DVSDE_*, D3D9 as the usage a D3DVERTEXELEMENT9 carries, and the D3D8
     * guest frontend converts its declarations with the same table
     * (d3d8_vsd_register_usage in d3d8proxy/d3d8_protocol.h) -- the two must
     * agree exactly, since the executor pairs a declaration element to a
     * shader input by (usage, usageIndex) and binds nothing when they differ.
     *
     * Without this, a real vs_1_1 -- which never carries a dcl -- reflects no
     * inputs at all: every v# read becomes a zeroed private variable and the
     * executor drops the draw for having no attribute to bind. Only shaders
     * assembled with a dcl, which vs_1_x cannot contain, appeared to work.
     */
    const VS1_FIXED_INPUT_SEMANTICS = {
        0: [DECLUSAGE_POSITION, 0], 1: [DECLUSAGE_BLENDWEIGHT, 0],
        2: [DECLUSAGE_BLENDINDICES, 0], 3: [DECLUSAGE_NORMAL, 0],
        4: [DECLUSAGE_PSIZE, 0], 5: [DECLUSAGE_COLOR, 0],
        6: [DECLUSAGE_COLOR, 1], 15: [DECLUSAGE_POSITION, 1],
    };

    function vs1InputSemantic(register) {
        const fixed = VS1_FIXED_INPUT_SEMANTICS[register];
        if (fixed) return { usage: fixed[0], usageIndex: fixed[1] };
        if (register >= 7 && register <= 14)
            return { usage: DECLUSAGE_TEXCOORD, usageIndex: register - 7 };
        return { usage: DECLUSAGE_TEXCOORD, usageIndex: 8 + (register & 7) };
    }

    const TEXTURE_TYPE_NAMES = { 2: "2d", 3: "cube", 4: "3d" };

    function varyingForSemantic(usage, usageIndex) {
        if (usage === DECLUSAGE_COLOR && usageIndex < 2)
            return VARYING_COLOR0 + usageIndex;
        if (usage === DECLUSAGE_TEXCOORD && usageIndex < 8)
            return VARYING_TEXCOORD0 + usageIndex;
        if (usage === DECLUSAGE_FOG) return VARYING_FOG;
        return -1;
    }

    // ---- bytecode parsing ----

    function decodeDest(token, relativeToken) {
        const mask = (token >>> D3DSP_WRITEMASK_SHIFT) & 0xf;
        return {
            type: regTypeOf(token),
            index: token & D3DSP_REGNUM_MASK,
            writeMask: mask === 0 ? 0xf : mask,
            modifier: (token >>> D3DSP_DSTMOD_SHIFT) & 0xf,
            shift: ((token >>> D3DSP_DSTSHIFT_SHIFT) & 0xf),
            relative: (token & D3DSHADER_ADDRESSMODE_RELATIVE) !== 0,
            relativeToken: relativeToken || 0,
        };
    }

    function decodeSource(token, relativeToken) {
        return {
            type: regTypeOf(token),
            index: token & D3DSP_REGNUM_MASK,
            swizzle: (token >>> D3DSP_SWIZZLE_SHIFT) & 0xff,
            modifier: (token >>> D3DSP_SRCMOD_SHIFT) & 0xf,
            relative: (token & D3DSHADER_ADDRESSMODE_RELATIVE) !== 0,
            relativeToken: relativeToken || 0,
        };
    }

    function parseShader(tokens) {
        if (!tokens || tokens.length < 2)
            throw new Error("shader bytecode is too short to hold a version token");
        const versionToken = tokens[0] >>> 0;
        const marker = versionToken >>> 16;
        let kind;
        if (marker === 0xfffe) kind = "vertex";
        else if (marker === 0xffff) kind = "pixel";
        else throw new Error("not a D3D9 shader: version token 0x" +
            versionToken.toString(16));
        const major = (versionToken >>> 8) & 0xff;
        const minor = versionToken & 0xff;
        if (major < 1 || major > 3)
            throw new Error("unsupported shader model " + major + "." + minor);

        const instructions = [];
        let i = 1;
        while (i < tokens.length) {
            const token = tokens[i] >>> 0;
            const opcode = token & D3DSI_OPCODE_MASK;
            if (opcode === OP.END) break;
            if (opcode === OP.COMMENT) {
                const words = (token >>> D3DSI_COMMENTSIZE_SHIFT) & D3DSI_COMMENTSIZE_MASK;
                i += 1 + words;
                continue;
            }
            const start = i;
            const length = (token & D3DSI_INSTLENGTH_MASK) >>> D3DSI_INSTLENGTH_SHIFT;
            const predicated = (token & D3DSI_PREDICATED) !== 0;
            const control = (token & D3DSP_OPCODESPECIFICCONTROL_MASK) >>>
                D3DSP_OPCODESPECIFICCONTROL_SHIFT;
            ++i;

            const instruction = { opcode, control, predicated, dest: null,
                predicate: null, sources: [], literals: null, declaration: null };

            const readOperand = decode => {
                if (i >= tokens.length)
                    throw new Error("shader bytecode ends inside an instruction");
                const operandToken = tokens[i++] >>> 0;
                let relative = 0;
                if ((operandToken & D3DSHADER_ADDRESSMODE_RELATIVE) &&
                        (major >= 2 || regTypeOf(operandToken) !== REG_CONST)) {
                    // vs_1_1 encodes c[a0.x] with the relative bit but *no*
                    // extra token (a0 is the only possible index); vs_2_0+
                    // spells the index register out in a following token.
                    if (major >= 2) relative = tokens[i++] >>> 0;
                }
                return decode(operandToken, relative);
            };

            if (opcode === OP.DCL) {
                const dclToken = tokens[i++] >>> 0;
                instruction.declaration = {
                    usage: dclToken & 0xf,
                    usageIndex: (dclToken >>> 16) & 0xf,
                    textureType: (dclToken >>> 27) & 0xf,
                };
                instruction.dest = decodeDest(tokens[i++] >>> 0, 0);
            } else if (opcode === OP.DEF || opcode === OP.DEFI) {
                instruction.dest = decodeDest(tokens[i++] >>> 0, 0);
                const raw = new Uint32Array(4);
                for (let k = 0; k < 4; ++k) raw[k] = tokens[i++] >>> 0;
                instruction.literals = opcode === OP.DEF
                    ? Array.from(new Float32Array(raw.buffer))
                    : Array.from(new Int32Array(raw.buffer));
            } else if (opcode === OP.DEFB) {
                instruction.dest = decodeDest(tokens[i++] >>> 0, 0);
                instruction.literals = [(tokens[i++] >>> 0) !== 0];
            } else {
                const shape = operandShape(opcode, kind, major, minor);
                if (!shape)
                    throw new Error("unknown opcode 0x" + opcode.toString(16));
                if (shape[0]) instruction.dest = readOperand(decodeDest);
                if (predicated) instruction.predicate = readOperand(decodeSource);
                for (let k = 0; k < shape[1]; ++k)
                    instruction.sources.push(readOperand(decodeSource));
            }

            // SM2.0+ carries an authoritative token count. Trusting it over
            // our own operand walk means a miscounted exotic instruction
            // cannot desynchronise the rest of the stream (plan 6.8's parser
            // safety rule applied one level down, to the bytecode itself).
            if (major >= 2 && length > 0) i = start + 1 + length;
            if (i <= start)
                throw new Error("shader instruction made no progress");
            instructions.push(instruction);
        }
        return { kind, major, minor, instructions };
    }

    // Instructions whose operand count depends on the shader model.
    function operandShape(opcode, kind, major, minor) {
        if (opcode === OP.TEX) {
            if (kind === "pixel" && major === 1) return minor < 4 ? [1, 0] : [1, 1];
            return [1, 2]; // ps_2_0+ texld dst, coord, sampler
        }
        if (opcode === OP.TEXCOORD)
            return (kind === "pixel" && major === 1 && minor >= 4) ? [1, 1] : [1, 0];
        if (opcode === OP.SINCOS) return major >= 3 ? [1, 1] : [1, 3];
        return OPERANDS[opcode] || null;
    }

    // ---- WGSL emission ----

    const SWIZZLE_CHARS = "xyzw";

    function swizzleString(swizzle) {
        let out = "";
        for (let i = 0; i < 4; ++i) out += SWIZZLE_CHARS[(swizzle >>> (i * 2)) & 0x3];
        return out;
    }

    function floatLiteral(value) {
        if (!isFinite(value)) return value > 0 ? FLOAT_MAX : "-" + FLOAT_MAX;
        if (Number.isInteger(value) && Math.abs(value) < 1e9)
            return value.toFixed(1);
        return String(value);
    }

    class Translator {
        constructor(parsed, options) {
            this.parsed = parsed;
            this.options = options || {};
            this.kind = parsed.kind;
            this.major = parsed.major;
            this.minor = parsed.minor;
            this.lines = [];
            this.indent = 2;
            this.temps = new Set();
            this.usedInputs = new Map();       // register -> {usage, usageIndex}
            this.outputSemantics = new Map();  // vs_3_0 o# -> {usage, usageIndex}
            this.samplers = new Map();         // index -> "2d"|"cube"|"3d"
            // Stages the caller has a D3D9 depth texture bound to. D3D9 has no
            // syntax for a shadow sample: `tex2D`/`tex2Dproj` on a sampler
            // whose texture is a depth format silently becomes a hardware
            // depth comparison returning filtered visibility. WGSL demands the
            // opposite -- texture_depth_2d and sampler_comparison are distinct
            // types chosen at module scope -- so which stages are depth has to
            // reach translation, and the same bytecode compiles to a different
            // module depending on what is bound. See isDepthSampler() for why
            // this is a request rather than a directive.
            this.requestedDepthSamplers = new Set(
                (this.options.depthSamplers || []).map(index => index | 0));
            // The subset of those which read the stored depth back rather than
            // comparing against it -- D3D9's ATI FOURCC depth formats. Same
            // texture_depth_2d declaration, an ordinary sampler instead of a
            // comparison one, and no reference value at all.
            this.requestedDepthFetchSamplers = new Set(
                (this.options.depthFetchSamplers || []).map(index => index | 0));
            // D3DSAMP_MIPMAPLODBIAS per sampler, already quantised by the
            // caller. WebGPU samplers have no bias field, so it can only be
            // applied at the sample call; it arrives as a compile option rather
            // than a uniform because that keeps it out of the per-draw uniform
            // writer, and the caller folds it into the shader variant key.
            this.samplerLodBias = this.options.samplerLodBias || null;
            // D3DTADDRESS_MIRRORONCE per sampler, as the axis letters that use
            // it ("xy", "x", ...). The host sampler is already clamp-to-edge
            // for such an axis, so mirroring about zero is all that is left,
            // and abs() on the coordinate is exactly that. It arrives as a
            // compile option for the same reason the LOD bias does: it changes
            // the WGSL, so it belongs in the shader variant key.
            this.samplerMirrorOnce = this.options.samplerMirrorOnce || null;
            // D3DRS_SHADEMODE's D3DSHADE_FLAT: the two colour varyings take
            // the provoking vertex's value, with shaders as without them (as
            // wined3d's flatshading). A vertex output and the fragment input
            // at one location must agree, so the caller passes the same flag
            // to both stages, as the fixed-function ones get it, and keys the
            // variant on it.
            this.flatShading = !!this.options.flatShading;
            this.writtenVaryings = new Set();
            this.usesAddress = false;
            this.usesLoopCounter = false;
            this.usesPredicate = false;
            this.usesPointSize = false;
            this.usesDepthOutput = false;
            this.usesFragPosition = false;
            this.usesFrontFacing = false;
            this.usesRelativeConstants = false;
            this.maxFloatConst = -1;
            this.maxIntConst = -1;
            this.maxBoolConst = -1;
            this.floatDefaults = new Map();    // c# -> [x,y,z,w] from `def`
            this.intDefaults = new Map();
            this.boolDefaults = new Map();
            this.psTexcoordInputs = new Set(); // ps t# registers touched
            // ps_1_x texture addressing. bumpStages are the samplers whose
            // D3DTSS_BUMPENVMAT* matrix a texbem/texbeml needs; matrixRows is
            // the running accumulator the texm3x*pad instructions feed and the
            // texm3x*tex/spec/vspec that follows consumes.
            this.bumpStages = new Set();
            this.matrixRows = [];
            this.psColorInputs = new Set();    // ps v# registers touched
            this.colorOutputs = new Set();
            this.controlDepth = 0;             // >0 => inside if/loop
            this.nonUniformDepth = 0;          // >0 => implicit-LOD sampling illegal
            this.nonUniformFrames = [];        // open non-uniform regions
            this.levelZeroSamples = 0;
            this.temporaryId = 0;
            this.warnings = [];
        }

        emit(text) {
            this.lines.push(" ".repeat(this.indent) + text);
        }

        // One varying of the inter-stage struct, the same in both stages:
        // with flat shading the colour slots are flat (texture coordinates
        // and fog keep interpolating, as in D3D9)
        varyingDeclaration(slot) {
            const flat = this.flatShading &&
                (slot === VARYING_COLOR0 || slot === VARYING_COLOR1);
            return "    @location(" + slot + ")" +
                (flat ? " @interpolate(flat)" : "") +
                " varying" + slot + ": vec4<f32>,";
        }

        fresh(prefix) {
            return "_" + (prefix || "t") + (this.temporaryId++);
        }

        note(message) {
            if (this.warnings.indexOf(message) === -1) this.warnings.push(message);
        }

        // ---- register access ----

        constantIndexExpression(source, bank) {
            const base = source.index + bank * 2048;
            if (!source.relative) {
                if (base > this.maxFloatConst) this.maxFloatConst = base;
                return String(base);
            }
            this.usesRelativeConstants = true;
            this.maxFloatConst = Math.max(this.maxFloatConst, 255);
            // vs_1_1 has no relative-index token: a0.x is the only legal
            // index register. vs_2_0+ names it (a0 or aL) explicitly.
            let index = "a0.x";
            if (source.relativeToken) {
                const rel = decodeSource(source.relativeToken, 0);
                const component = SWIZZLE_CHARS[rel.swizzle & 0x3];
                index = rel.type === REG_LOOP ? "aL"
                    : "a0." + component;
                if (rel.type === REG_LOOP) this.usesLoopCounter = true;
                else this.usesAddress = true;
            } else {
                this.usesAddress = true;
            }
            return "clamp(" + index + " + " + base + ", 0, " +
                (this.constantCapacity() - 1) + ")";
        }

        constantCapacity() {
            return this.kind === "vertex" ? 256 : 224;
        }

        // Raw (unswizzled, unmodified) vec4<f32> read of a source register.
        rawSource(source) {
            switch (source.type) {
            case REG_TEMP:
                this.temps.add(source.index);
                return "r" + source.index;
            case REG_CONST:
                return "d9c.f[" + this.constantIndexExpression(source, 0) + "]";
            case REG_CONST2:
                return "d9c.f[" + this.constantIndexExpression(source, 1) + "]";
            case REG_CONST3:
                return "d9c.f[" + this.constantIndexExpression(source, 2) + "]";
            case REG_CONST4:
                return "d9c.f[" + this.constantIndexExpression(source, 3) + "]";
            case REG_CONSTINT:
                this.maxIntConst = Math.max(this.maxIntConst, source.index);
                return "vec4<f32>(d9c.i[" + source.index + "])";
            case REG_CONSTBOOL:
                this.maxBoolConst = Math.max(this.maxBoolConst, source.index);
                return "vec4<f32>(f32(d9c.b[" + (source.index >> 2) + "][" +
                    (source.index & 3) + "]))";
            case REG_PREDICATE:
                this.usesPredicate = true;
                return "vec4<f32>(p0)";
            case REG_LOOP:
                this.usesLoopCounter = true;
                return "vec4<f32>(f32(aL))";
            case REG_ADDR: // === REG_TEXTURE
                if (this.kind === "vertex") {
                    this.usesAddress = true;
                    return "vec4<f32>(a0)";
                }
                this.psTexcoordInputs.add(source.index);
                return "t" + source.index;
            case REG_INPUT:
                if (this.kind === "vertex") {
                    if (!this.usedInputs.has(source.index))
                        this.usedInputs.set(source.index, null);
                    return "vin" + source.index;
                }
                this.psColorInputs.add(source.index);
                return "v" + source.index;
            case REG_MISCTYPE:
                if (source.index === MISC_POSITION) {
                    this.usesFragPosition = true;
                    return "vec4<f32>(floor(d9_frag_position.xy), " +
                        "d9_frag_position.z, d9_frag_position.w)";
                }
                if (source.index === MISC_FACE) {
                    this.usesFrontFacing = true;
                    return "vec4<f32>(d9_face)";
                }
                throw new Error("unsupported misc register index " + source.index);
            case REG_OUTPUT: // readable in vs_3_0 (o# behaves like a temp)
                if (this.kind === "vertex" && this.major >= 3)
                    return "o" + source.index;
                throw new Error("output register is not readable in this shader model");
            default:
                throw new Error("unsupported source register type " + source.type);
            }
        }

        // Applies swizzle then the source modifier, per D3D9 evaluation order.
        source(index) {
            const source = this.parsed.currentSources[index];
            return this.sourceExpression(source);
        }

        sourceExpression(source) {
            let expression = this.rawSource(source);
            const swizzle = swizzleString(source.swizzle);
            if (swizzle !== "xyzw") expression = "(" + expression + ")." + swizzle;
            switch (source.modifier) {
            case SRCMOD_NONE: return expression;
            case SRCMOD_NEG: return "-(" + expression + ")";
            case SRCMOD_BIAS: return "((" + expression + ") - vec4<f32>(0.5))";
            case SRCMOD_BIASNEG: return "-((" + expression + ") - vec4<f32>(0.5))";
            case SRCMOD_SIGN: return "((" + expression + ") * 2.0 - vec4<f32>(1.0))";
            case SRCMOD_SIGNNEG: return "-((" + expression + ") * 2.0 - vec4<f32>(1.0))";
            case SRCMOD_COMP: return "(vec4<f32>(1.0) - (" + expression + "))";
            case SRCMOD_X2: return "((" + expression + ") * 2.0)";
            case SRCMOD_X2NEG: return "-((" + expression + ") * 2.0)";
            case SRCMOD_DZ: {
                const name = this.fresh("dz");
                this.emit("let " + name + " = " + expression + ";");
                return "(" + name + " / select(-max(abs(" + name +
                    ".z), 1e-8), max(abs(" + name + ".z), 1e-8), " +
                    name + ".z >= 0.0))";
            }
            case SRCMOD_DW: {
                const name = this.fresh("dw");
                this.emit("let " + name + " = " + expression + ";");
                return "(" + name + " / select(-max(abs(" + name +
                    ".w), 1e-8), max(abs(" + name + ".w), 1e-8), " +
                    name + ".w >= 0.0))";
            }
            case SRCMOD_ABS: return "abs(" + expression + ")";
            case SRCMOD_ABSNEG: return "-abs(" + expression + ")";
            case SRCMOD_NOT: return "(vec4<f32>(1.0) - (" + expression + "))";
            default:
                throw new Error("unsupported source modifier " + source.modifier);
            }
        }

        // Name of the lvalue a destination register writes through, plus the
        // bookkeeping that makes it exist in the prologue/epilogue.
        destTarget(dest) {
            switch (dest.type) {
            case REG_TEMP:
                this.temps.add(dest.index);
                return "r" + dest.index;
            case REG_ADDR: // vs: a0 (MOV in 1.1, MOVA in 2.0+); ps: t# scratch
                if (this.kind === "vertex") {
                    this.usesAddress = true;
                    return "a0f";
                }
                this.psTexcoordInputs.add(dest.index);
                return "t" + dest.index;
            case REG_RASTOUT:
                if (dest.index === RASTOUT_POSITION) return "o_position";
                if (dest.index === RASTOUT_FOG) {
                    this.writtenVaryings.add(VARYING_FOG);
                    return "o_varying" + VARYING_FOG;
                }
                if (dest.index === RASTOUT_POINTSIZE) {
                    this.usesPointSize = true;
                    return "o_pointsize";
                }
                throw new Error("unsupported rasterizer output " + dest.index);
            case REG_ATTROUT: {
                const slot = VARYING_COLOR0 + dest.index;
                if (dest.index > 1)
                    throw new Error("only oD0/oD1 exist as colour outputs");
                this.writtenVaryings.add(slot);
                return "o_varying" + slot;
            }
            case REG_OUTPUT: {
                if (this.kind === "vertex" && this.major >= 3) {
                    const semantic = this.outputSemantics.get(dest.index);
                    if (!semantic)
                        throw new Error("vs_3_0 output o" + dest.index +
                            " was written without a dcl semantic");
                    if (semantic.usage === DECLUSAGE_POSITION) return "o_position";
                    if (semantic.usage === DECLUSAGE_PSIZE) {
                        this.usesPointSize = true;
                        return "o_pointsize";
                    }
                    const slot = varyingForSemantic(semantic.usage, semantic.usageIndex);
                    if (slot < 0)
                        throw new Error("vs_3_0 output semantic " + semantic.usage +
                            "[" + semantic.usageIndex + "] has no varying slot");
                    this.writtenVaryings.add(slot);
                    return "o_varying" + slot;
                }
                const slot = VARYING_TEXCOORD0 + dest.index;
                if (dest.index > 7)
                    throw new Error("only oT0..oT7 exist as texcoord outputs");
                this.writtenVaryings.add(slot);
                return "o_varying" + slot;
            }
            case REG_COLOROUT:
                this.colorOutputs.add(dest.index);
                return "oC" + dest.index;
            case REG_DEPTHOUT:
                this.usesDepthOutput = true;
                return "o_depthv";
            case REG_PREDICATE:
                this.usesPredicate = true;
                return "p0f";
            default:
                throw new Error("unsupported destination register type " + dest.type);
            }
        }

        // Emits `dest.<mask> = value`, honouring _sat, the ps_1_x result
        // shift, and the write mask. WGSL only allows assignment through a
        // single-component swizzle, so a multi-component mask becomes one
        // statement per component rather than `dest.xy = ...`.
        store(dest, valueExpression, options) {
            const asBool = options && options.bool;
            this.noteRegisterWrite(dest);
            const target = this.destTarget(dest);
            const name = this.fresh("v");
            let value = valueExpression;
            if (!asBool) {
                if (dest.shift) {
                    // 4-bit signed field: 1..7 scale up by 2^n, 9..15 (i.e.
                    // -7..-1) scale down.
                    const shift = dest.shift > 7 ? dest.shift - 16 : dest.shift;
                    value = "((" + value + ") * " +
                        floatLiteral(Math.pow(2, shift)) + ")";
                }
                if ((dest.modifier & DSTMOD_SATURATE) !== 0)
                    value = "clamp(" + value + ", vec4<f32>(0.0), vec4<f32>(1.0))";
            }
            this.emit("let " + name + " = " + value + ";");
            if (dest.writeMask === 0xf) {
                this.emit(target + " = " + name + ";");
                return;
            }
            for (let i = 0; i < 4; ++i) {
                if (!(dest.writeMask & (1 << i))) continue;
                const component = WRITEMASK_NAMES[i];
                this.emit(target + "." + component + " = " + name + "." + component + ";");
            }
        }

        // ---- instruction translation ----

        translate() {
            const parsed = this.parsed;
            // dcl/def are order-independent declarations; hoisting them means
            // a dcl that follows its first use (legal, and produced by some
            // compilers for vs_3_0 outputs) still informs code generation.
            for (const instruction of parsed.instructions) {
                if (instruction.opcode === OP.DCL) this.declare(instruction);
                else if (instruction.opcode === OP.DEF)
                    this.floatDefaults.set(instruction.dest.index, instruction.literals);
                else if (instruction.opcode === OP.DEFI)
                    this.intDefaults.set(instruction.dest.index, instruction.literals);
                else if (instruction.opcode === OP.DEFB)
                    this.boolDefaults.set(instruction.dest.index, instruction.literals[0]);
                else if (UNSUPPORTED_OPS.has(instruction.opcode))
                    throw new Error("unsupported instruction '" +
                        (OP_NAMES[instruction.opcode] || instruction.opcode) +
                        "' (ps_1_x bump-environment/matrix texture addressing)");
            }
            for (const [register, literals] of this.floatDefaults)
                this.maxFloatConst = Math.max(this.maxFloatConst, register);
            for (const register of this.intDefaults.keys())
                this.maxIntConst = Math.max(this.maxIntConst, register);
            for (const register of this.boolDefaults.keys())
                this.maxBoolConst = Math.max(this.maxBoolConst, register);

            // Split top-level code from `label`-introduced subroutines. D3D9
            // forbids recursion, so the call graph is a DAG and the routines
            // can simply be emitted in dependency order ahead of the body.
            const routines = this.splitRoutines(parsed.instructions);
            const bodies = new Map();
            for (const routine of routines.subroutines) {
                this.lines = [];
                this.indent = 4;
                this.emitBlock(routine.instructions);
                bodies.set(routine.label, this.lines);
            }
            this.lines = [];
            this.indent = 4;
            this.emitBlock(routines.main);
            const mainBody = this.lines;

            return this.assemble(routines, bodies, mainBody);
        }

        declare(instruction) {
            const declaration = instruction.declaration;
            const dest = instruction.dest;
            if (dest.type === REG_SAMPLER) {
                const type = TEXTURE_TYPE_NAMES[declaration.textureType] || "2d";
                this.samplers.set(dest.index, type);
                return;
            }
            if (this.kind === "vertex" && dest.type === REG_INPUT) {
                this.usedInputs.set(dest.index, {
                    usage: declaration.usage, usageIndex: declaration.usageIndex });
                return;
            }
            if (this.kind === "vertex" && dest.type === REG_OUTPUT && this.major >= 3) {
                this.outputSemantics.set(dest.index, {
                    usage: declaration.usage, usageIndex: declaration.usageIndex });
                return;
            }
            if (this.kind === "pixel") {
                // ps_2_0 declares its texcoord inputs as t#, ps_3_0 as v#
                // with an explicit semantic.
                if (dest.type === REG_TEXTURE) this.psTexcoordInputs.add(dest.index);
                else if (dest.type === REG_INPUT) {
                    this.usedInputs.set(dest.index, {
                        usage: declaration.usage, usageIndex: declaration.usageIndex });
                    this.psColorInputs.add(dest.index);
                }

            }
            // vs_1_1/2_0 output dcls carry no information we need.
        }

        splitRoutines(instructions) {
            const main = [];
            const subroutines = [];
            let current = main;
            let depth = 0;
            for (const instruction of instructions) {
                if (instruction.opcode === OP.DCL || instruction.opcode === OP.DEF ||
                        instruction.opcode === OP.DEFI || instruction.opcode === OP.DEFB)
                    continue;
                if (instruction.opcode === OP.LABEL) {
                    const label = instruction.sources[0].index;
                    const routine = { label, instructions: [] };
                    subroutines.push(routine);
                    current = routine.instructions;
                    depth = 0;
                    continue;
                }
                if (instruction.opcode === OP.RET && depth === 0 && current === main)
                    continue; // end of the main body; the epilogue follows
                if (instruction.opcode === OP.IF || instruction.opcode === OP.IFC ||
                        instruction.opcode === OP.REP || instruction.opcode === OP.LOOP)
                    ++depth;
                else if (instruction.opcode === OP.ENDIF ||
                        instruction.opcode === OP.ENDREP ||
                        instruction.opcode === OP.ENDLOOP)
                    --depth;
                current.push(instruction);
            }
            // Order subroutines so a callee is always defined before its
            // caller, as WGSL requires.
            const byLabel = new Map(subroutines.map(r => [r.label, r]));
            const ordered = [];
            const state = new Map();
            const visit = routine => {
                const status = state.get(routine.label);
                if (status === "done") return;
                if (status === "visiting")
                    throw new Error("recursive shader subroutine call");
                state.set(routine.label, "visiting");
                for (const instruction of routine.instructions) {
                    if (instruction.opcode !== OP.CALL && instruction.opcode !== OP.CALLNZ)
                        continue;
                    const callee = byLabel.get(instruction.sources[0].index);
                    if (callee) visit(callee);
                }
                state.set(routine.label, "done");
                ordered.push(routine);
            };
            for (const routine of subroutines) visit(routine);
            return { main, subroutines: ordered };
        }

        emitBlock(instructions) {
            for (const instruction of instructions) this.instruction(instruction);
        }

        instruction(instruction) {
            this.parsed.currentSources = instruction.sources;
            const opcode = instruction.opcode;
            const dest = instruction.dest;
            const sources = instruction.sources;

            if (instruction.predicated && instruction.predicate) {
                // `(p0.x) mov r0, r1` -- run the instruction, then keep the
                // old value where the predicate is false. Doing it as a
                // guarded block is simpler and matches the semantics for
                // every opcode, including texture reads.
                this.usesPredicate = true;
                const predicate = instruction.predicate;
                const component = SWIZZLE_CHARS[predicate.swizzle & 0x3];
                const negated = predicate.modifier === SRCMOD_NOT;
                this.emit("if (" + (negated ? "!" : "") + "p0." + component + ") {");
                this.indent += 2;
                ++this.controlDepth;
                ++this.nonUniformDepth;
                this.pushNonUniformFrame();
                const inner = Object.assign({}, instruction, { predicated: false });
                this.instruction(inner);
                (this.nonUniformFrames || []).pop();
                --this.nonUniformDepth;
                --this.controlDepth;
                this.indent -= 2;
                this.emit("}");
                return;
            }

            const s = i => this.sourceExpression(sources[i]);
            const scalar = (i, component) =>
                "(" + this.sourceExpression(sources[i]) + ")." + (component || "x");

            switch (opcode) {
            case OP.NOP: case OP.PHASE:
                if (opcode === OP.PHASE)
                    this.note("ps_1_4 `phase` is treated as a no-op");
                return;
            case OP.MOV:
                // vs_1_1 predates MOVA. Its only legal way to load a0.x is
                // `mov a0.x, src`, which performs the same round-to-nearest
                // float-to-integer conversion MOVA performs in later models.
                // Keep the float mirror for masked assignment, then update
                // the integer register relative c[a0.x + n] reads.
                if (this.kind === "vertex" && this.major === 1 &&
                        dest.type === REG_ADDR) {
                    this.store(dest, "round(" + s(0) + ")");
                    this.emit("a0 = vec4<i32>(a0f);");
                } else {
                    this.store(dest, s(0));
                }
                return;
            case OP.MOVA:
                this.store(dest, "round(" + s(0) + ")");
                this.emit("a0 = vec4<i32>(a0f);");
                return;
            case OP.ADD: this.store(dest, "(" + s(0) + ") + (" + s(1) + ")"); return;
            case OP.SUB: this.store(dest, "(" + s(0) + ") - (" + s(1) + ")"); return;
            case OP.MUL: this.store(dest, "(" + s(0) + ") * (" + s(1) + ")"); return;
            case OP.MAD:
                this.store(dest, "(" + s(0) + ") * (" + s(1) + ") + (" + s(2) + ")");
                return;
            case OP.MIN: this.store(dest, "min(" + s(0) + ", " + s(1) + ")"); return;
            case OP.MAX: this.store(dest, "max(" + s(0) + ", " + s(1) + ")"); return;
            case OP.SLT:
                this.store(dest, "select(vec4<f32>(0.0), vec4<f32>(1.0), (" +
                    s(0) + ") < (" + s(1) + "))");
                return;
            case OP.SGE:
                this.store(dest, "select(vec4<f32>(0.0), vec4<f32>(1.0), (" +
                    s(0) + ") >= (" + s(1) + "))");
                return;
            case OP.FRC: this.store(dest, "fract(" + s(0) + ")"); return;
            case OP.ABS: this.store(dest, "abs(" + s(0) + ")"); return;
            case OP.RCP: this.store(dest, "vec4<f32>(d9_rcp(" + scalar(0) + "))"); return;
            case OP.RSQ: this.store(dest, "vec4<f32>(d9_rsq(" + scalar(0) + "))"); return;
            case OP.EXP: this.store(dest, "vec4<f32>(exp2(" + scalar(0) + "))"); return;
            case OP.LOG: this.store(dest, "vec4<f32>(d9_log(" + scalar(0) + "))"); return;
            case OP.EXPP:
                if (this.major === 1) {
                    const name = this.fresh("e");
                    this.emit("let " + name + " = " + scalar(0) + ";");
                    this.store(dest, "vec4<f32>(exp2(floor(" + name + ")), " +
                        "fract(" + name + "), exp2(" + name + "), 1.0)");
                } else {
                    this.store(dest, "vec4<f32>(exp2(" + scalar(0) + "))");
                }
                return;
            case OP.LOGP: this.store(dest, "vec4<f32>(d9_log(" + scalar(0) + "))"); return;
            case OP.POW:
                this.store(dest, "vec4<f32>(pow(abs(" + scalar(0) + "), " +
                    scalar(1) + "))");
                return;
            case OP.DP3:
                this.store(dest, "vec4<f32>(dot((" + s(0) + ").xyz, (" + s(1) + ").xyz))");
                return;
            case OP.DP4:
                this.store(dest, "vec4<f32>(dot(" + s(0) + ", " + s(1) + "))");
                return;
            case OP.DP2ADD:
                this.store(dest, "vec4<f32>(dot((" + s(0) + ").xy, (" + s(1) +
                    ").xy) + " + scalar(2) + ")");
                return;
            case OP.CRS:
                this.store(dest, "vec4<f32>(cross((" + s(0) + ").xyz, (" +
                    s(1) + ").xyz), 0.0)");
                return;
            case OP.NRM:
                this.store(dest, "vec4<f32>(d9_normalize((" + s(0) + ").xyz), 0.0)");
                return;
            case OP.SGN: this.store(dest, "sign(" + s(0) + ")"); return;
            case OP.LIT: this.store(dest, "d9_lit(" + s(0) + ")"); return;
            case OP.DST: {
                const a = this.fresh("a"), b = this.fresh("b");
                this.emit("let " + a + " = " + s(0) + ";");
                this.emit("let " + b + " = " + s(1) + ";");
                this.store(dest, "vec4<f32>(1.0, " + a + ".y * " + b + ".y, " +
                    a + ".z, " + b + ".w)");
                return;
            }
            case OP.LRP:
                this.store(dest, "mix(" + s(2) + ", " + s(1) + ", " + s(0) + ")");
                return;
            case OP.CMP:
                this.store(dest, "select(" + s(2) + ", " + s(1) + ", (" +
                    s(0) + ") >= vec4<f32>(0.0))");
                return;
            case OP.CND:
                this.store(dest, "select(" + s(2) + ", " + s(1) + ", (" +
                    s(0) + ") > vec4<f32>(0.5))");
                return;
            case OP.SINCOS: {
                const name = this.fresh("sc");
                this.emit("let " + name + " = " + scalar(0) + ";");
                this.store(dest, "vec4<f32>(cos(" + name + "), sin(" + name +
                    "), 0.0, 0.0)");
                return;
            }
            case OP.DSX:
            case OP.DSY: {
                const builtin = opcode === OP.DSX ? "dpdx" : "dpdy";
                this.store(dest, this.nonUniformDepth > 0
                    ? this.derivativeExpression(builtin, sources[0])
                    : builtin + "(" + s(0) + ")");
                return;
            }
            case OP.M4x4: this.matrix(dest, sources, 4, 4); return;
            case OP.M4x3: this.matrix(dest, sources, 4, 3); return;
            case OP.M3x4: this.matrix(dest, sources, 3, 4); return;
            case OP.M3x3: this.matrix(dest, sources, 3, 3); return;
            case OP.M3x2: this.matrix(dest, sources, 3, 2); return;
            case OP.SETP: {
                const comparison = this.comparison(instruction.control,
                    s(0), s(1), true);
                this.store(dest, comparison, { bool: true });
                return;
            }
            case OP.TEXKILL: {
                // ps_1_x tests xyz, ps_2_0+ tests xyzw.
                const register = this.rawSource({ type: dest.type, index: dest.index,
                    swizzle: 0xe4, modifier: 0, relative: false, relativeToken: 0 });
                const components = this.major === 1 ? ".xyz" : ".xyzw";
                this.emit("if (any((" + register + ")" + components +
                    " < vec" + (this.major === 1 ? 3 : 4) + "<f32>(0.0))) { discard; }");
                return;
            }
            case OP.TEXCOORD: {
                if (this.major === 1 && this.minor < 4) {
                    // ps_1_1-1_3: dest register number *is* the texcoord index,
                    // and the result is clamped to [0,1].
                    this.psTexcoordInputs.add(dest.index);
                    this.store(dest, "clamp(t" + dest.index +
                        ", vec4<f32>(0.0), vec4<f32>(1.0))");
                } else {
                    this.store(dest, s(0));
                }
                return;
            }
            case OP.TEX: this.textureLoad(instruction); return;
            case OP.TEXLDL: this.textureLoad(instruction, { explicitLod: true }); return;
            case OP.TEXLDD: this.textureLoad(instruction, { gradients: true }); return;
            case OP.BEM: {
                // ps_1_4's arithmetic form of the same displacement, with no
                // sampling: src1 carries a (du, dv) pair, src0 the coordinate
                // to displace, and the 2x2 matrix comes from the texture stage
                // named by the *destination* register index -- the rule texbem
                // follows and the one Wine's shader backends implement.
                //
                //   dest.r = src0.r + m00 * src1.r + m10 * src1.g
                //   dest.g = src0.g + m01 * src1.r + m11 * src1.g
                //
                // The instruction writes .rg and nothing else, so the mask is
                // narrowed here rather than trusted: a full-mask encoding must
                // not clear the destination's b and a.
                const index = dest.index;
                this.bumpStages.add(index);
                const bump = "d9c.bump[" + index + "]";
                const base = this.fresh("bem");
                const delta = this.fresh("bemd");
                this.emit("let " + base + " = " + s(0) + ";");
                this.emit("let " + delta + " = " + s(1) + ";");
                this.store(Object.assign({}, dest,
                        { writeMask: dest.writeMask & 0x3 }),
                    "vec4<f32>(" + base + ".x + " + bump + ".x * " + delta +
                    ".x + " + bump + ".z * " + delta + ".y, " + base + ".y + " +
                    bump + ".y * " + delta + ".x + " + bump + ".w * " + delta +
                    ".y, 0.0, 0.0)");
                return;
            }
            case OP.TEXBEM:
            case OP.TEXBEML: {
                // ps_1_x environment bump mapping. The source register holds a
                // sampled (du, dv) pair; this stage's own texture coordinate is
                // displaced by it through the stage's D3DTSS_BUMPENVMAT*
                // matrix, and the displaced coordinate is what gets sampled.
                //
                // The matrix is texture-stage state, not shader state, so it
                // arrives through the uniform block the host fills from
                // textureStageStates -- see bumpStageCount in the reflection.
                const index = dest.index;
                if (!this.samplers.has(index)) this.samplers.set(index, "2d");
                this.psTexcoordInputs.add(index);
                this.bumpStages.add(index);
                const bump = "d9c.bump[" + index + "]";
                const source = this.rawSource({ type: sources[0].type,
                    index: sources[0].index, swizzle: 0xe4, modifier: 0,
                    relative: false, relativeToken: 0 });
                const perturbed = this.fresh("bem");
                this.emit("let " + perturbed + " = t" + index + ".xy + vec2<f32>(" +
                    bump + ".x * (" + source + ").x + " + bump + ".z * (" +
                    source + ").y, " + bump + ".y * (" + source + ").x + " +
                    bump + ".w * (" + source + ").y);");
                const sampled = this.sampleExpression(index,
                    { coord: perturbed, ref: null }, {});
                if (instruction.opcode === OP.TEXBEM) {
                    this.store(dest, sampled);
                } else {
                    // The luminance form scales the sampled colour by the bump
                    // map's blue channel through BUMPENVLSCALE/BUMPENVLOFFSET.
                    const lit = this.fresh("beml");
                    const lum = "d9c.bump_lum[" + index + "]";
                    this.emit("let " + lit + " = " + sampled + ";");
                    this.store(dest, "vec4<f32>(" + lit + ".rgb * clamp(" +
                        lum + ".x * (" + source + ").z + " + lum +
                        ".y, 0.0, 1.0), " + lit + ".a)");
                }
                return;
            }
            case OP.TEXDP3: {
                // A 3-component dot of this stage's texture coordinate with the
                // source register, replicated across the destination.
                const index = dest.index;
                this.psTexcoordInputs.add(index);
                const value = "dot(t" + index + ".xyz, (" +
                    this.rawSource({ type: sources[0].type,
                        index: sources[0].index, swizzle: 0xe4, modifier: 0,
                        relative: false, relativeToken: 0 }) + ").xyz)";
                this.store(dest, "vec4<f32>(" + value + ")");
                return;
            }
            case OP.TEXDP3TEX: {
                // Same dot, then a 1D lookup with it. WGSL has no 1D texture,
                // so the sampler is treated as 2D with v = 0 -- which is how
                // every desktop driver implements the ps_1_x 1D forms too.
                const index = dest.index;
                if (!this.samplers.has(index)) this.samplers.set(index, "2d");
                this.psTexcoordInputs.add(index);
                const coord = this.fresh("dp3tex");
                this.emit("let " + coord + " = vec2<f32>(dot(t" + index +
                    ".xyz, (" + this.rawSource({ type: sources[0].type,
                        index: sources[0].index, swizzle: 0xe4, modifier: 0,
                        relative: false, relativeToken: 0 }) +
                    ").xyz), 0.0);");
                this.store(dest, this.sampleExpression(index,
                    { coord, ref: null }, {}));
                return;
            }
            case OP.TEXM3x2PAD:
            case OP.TEXM3x3PAD: {
                // A "pad" instruction contributes one row of the matrix and
                // produces no visible result; the row is consumed by the
                // TEXM3x*TEX/SPEC/VSPEC that follows it. ps_1_x guarantees the
                // ordering, so a running list is enough.
                const row = this.fresh("m3row");
                this.psTexcoordInputs.add(dest.index);
                this.emit("let " + row + " = dot(t" + dest.index + ".xyz, (" +
                    this.rawSource({ type: sources[0].type,
                        index: sources[0].index, swizzle: 0xe4, modifier: 0,
                        relative: false, relativeToken: 0 }) + ").xyz);");
                this.matrixRows.push(row);
                return;
            }
            case OP.TEXM3x2TEX: {
                const index = dest.index;
                if (!this.samplers.has(index)) this.samplers.set(index, "2d");
                this.psTexcoordInputs.add(index);
                const last = this.fresh("m3row");
                this.emit("let " + last + " = dot(t" + index + ".xyz, (" +
                    this.rawSource({ type: sources[0].type,
                        index: sources[0].index, swizzle: 0xe4, modifier: 0,
                        relative: false, relativeToken: 0 }) + ").xyz);");
                const rows = this.takeMatrixRows(1, last);
                const coord = this.fresh("m3x2");
                this.emit("let " + coord + " = vec2<f32>(" + rows.join(", ") + ");");
                this.store(dest, this.sampleExpression(index,
                    { coord, ref: null }, {}));
                return;
            }
            case OP.TEXM3x3TEX:
            case OP.TEXM3x3SPEC:
            case OP.TEXM3x3VSPEC: {
                const index = dest.index;
                // The 3x3 forms address a cube map or a volume; both take a
                // three-component coordinate, and a cube is what environment
                // mapping actually binds.
                if (!this.samplers.has(index)) this.samplers.set(index, "cube");
                this.psTexcoordInputs.add(index);
                const last = this.fresh("m3row");
                this.emit("let " + last + " = dot(t" + index + ".xyz, (" +
                    this.rawSource({ type: sources[0].type,
                        index: sources[0].index, swizzle: 0xe4, modifier: 0,
                        relative: false, relativeToken: 0 }) + ").xyz);");
                const rows = this.takeMatrixRows(2, last);
                const normal = this.fresh("m3x3");
                this.emit("let " + normal + " = vec3<f32>(" + rows.join(", ") + ");");
                let coord = normal;
                if (instruction.opcode !== OP.TEXM3x3TEX) {
                    // SPEC takes the eye vector from a constant register;
                    // VSPEC takes it from the q components of the three
                    // texture coordinates the rows were built from.
                    const eye = instruction.opcode === OP.TEXM3x3SPEC
                        ? "(" + this.sourceExpression(sources[1]) + ").xyz"
                        : "vec3<f32>(t" + (index - 2) + ".w, t" + (index - 1) +
                          ".w, t" + index + ".w)";
                    const reflected = this.fresh("m3refl");
                    // D3D's formula: 2 * N * (N.E) / (N.N) - E.
                    this.emit("let " + reflected + " = 2.0 * " + normal +
                        " * dot(" + normal + ", " + eye + ") / max(dot(" +
                        normal + ", " + normal + "), 1e-6) - " + eye + ";");
                    coord = reflected;
                }
                this.store(dest, this.sampleExpression(index,
                    { coord, ref: null }, {}));
                return;
            }
            case OP.TEXREG2AR:
                this.textureLoadFromComponents(instruction, "wx");
                return;
            case OP.TEXREG2GB:
                this.textureLoadFromComponents(instruction, "yz");
                return;
            case OP.TEXREG2RGB:
                this.textureLoadFromComponents(instruction, "xyz");
                return;
            case OP.IF:
                this.emit("if (" + this.booleanSource(sources[0]) + ") {");
                this.enter(false);
                return;
            case OP.IFC:
                this.emit("if (" + this.comparison(instruction.control,
                    "(" + s(0) + ").x", "(" + s(1) + ").x", false) + ") {");
                this.enter(true);
                return;
            case OP.ELSE:
                this.leave();
                this.emit("} else {");
                this.enterSameUniformity();
                return;
            case OP.ENDIF:
                this.leave();
                this.emit("}");
                return;
            case OP.REP: {
                const counter = this.fresh("rep");
                this.maxIntConst = Math.max(this.maxIntConst, sources[0].index);
                this.emit("for (var " + counter + " = 0; " + counter + " < d9c.i[" +
                    sources[0].index + "].x; " + counter + " = " + counter + " + 1) {");
                this.enter(false);
                return;
            }
            case OP.ENDREP:
                this.leave();
                this.emit("}");
                return;
            case OP.LOOP: {
                const counter = this.fresh("loop");
                const register = sources[1].index;
                this.usesLoopCounter = true;
                this.maxIntConst = Math.max(this.maxIntConst, register);
                this.emit("aL = d9c.i[" + register + "].y;");
                this.emit("for (var " + counter + " = 0; " + counter + " < d9c.i[" +
                    register + "].x; " + counter + " = " + counter + " + 1) {");
                this.enter(false);
                this.emit("// aL advances at the bottom of the body");
                this.pendingLoopStep = this.pendingLoopStep || [];
                this.pendingLoopStep.push(register);
                return;
            }
            case OP.ENDLOOP: {
                const register = this.pendingLoopStep && this.pendingLoopStep.pop();
                if (register !== undefined)
                    this.emit("aL = aL + d9c.i[" + register + "].z;");
                this.leave();
                this.emit("}");
                return;
            }
            case OP.BREAK: this.emit("break;"); return;
            case OP.BREAKC:
                this.emit("if (" + this.comparison(instruction.control,
                    "(" + s(0) + ").x", "(" + s(1) + ").x", false) + ") { break; }");
                return;
            case OP.BREAKP: {
                const component = SWIZZLE_CHARS[sources[0].swizzle & 0x3];
                this.usesPredicate = true;
                this.emit("if (" + (sources[0].modifier === SRCMOD_NOT ? "!" : "") +
                    "p0." + component + ") { break; }");
                return;
            }
            case OP.CALL:
                this.emit("d9_sub" + sources[0].index + "();");
                return;
            case OP.CALLNZ:
                this.emit("if (" + this.booleanSource(sources[1]) + ") { d9_sub" +
                    sources[0].index + "(); }");
                return;
            case OP.RET:
                this.emit("return;");
                return;
            case OP.LABEL:
                return; // handled by splitRoutines
            default:
                throw new Error("unimplemented instruction '" +
                    (OP_NAMES[opcode] || ("0x" + opcode.toString(16))) + "'");
            }
        }

        // A frame per open non-uniform region, recording where its opening
        // statement began and which registers have been written since. Both are
        // what dsx/dsy needs: see derivativeExpression().
        pushNonUniformFrame(insertAt) {
            this.nonUniformFrames = this.nonUniformFrames || [];
            this.nonUniformFrames.push({
                // The `if (...) {` line is emitted before enter() runs, so the
                // position *before* the region is one line back.
                insertAt: insertAt === undefined
                    ? Math.max(0, this.lines.length - 1) : insertAt,
                indent: Math.max(0, this.indent - 2),
                written: new Set(),
            });
        }

        enter(nonUniform) {
            this.indent += 2;
            ++this.controlDepth;
            this.uniformityStack = this.uniformityStack || [];
            this.uniformityStack.push(!!nonUniform);
            if (nonUniform) {
                ++this.nonUniformDepth;
                this.pushNonUniformFrame();
            }
        }

        enterSameUniformity() {
            this.indent += 2;
            ++this.controlDepth;
            const nonUniform = this.lastLeftNonUniform;
            this.uniformityStack.push(nonUniform);
            if (nonUniform) {
                ++this.nonUniformDepth;
                // An `else` branch hoists to before the whole `if`, not to
                // before the `} else {` -- that position is inside the *then*
                // branch, where the code would run under the wrong condition.
                // Writes made by the then-branch do not reach here, so the
                // written-register set starts empty again.
                this.pushNonUniformFrame(this.lastLeftInsertAt);
            }
        }

        leave() {
            this.indent -= 2;
            --this.controlDepth;
            const nonUniform = (this.uniformityStack || []).pop();
            this.lastLeftNonUniform = nonUniform;
            if (nonUniform) {
                --this.nonUniformDepth;
                const frame = (this.nonUniformFrames || []).pop();
                this.lastLeftInsertAt = frame ? frame.insertAt : undefined;
            }
        }

        // Every register written inside an open non-uniform region, so a later
        // hoist can tell whether the value it wants still exists above it.
        noteRegisterWrite(dest) {
            if (!this.nonUniformFrames || !this.nonUniformFrames.length) return;
            const key = dest.type + ":" + dest.index;
            for (const frame of this.nonUniformFrames) frame.written.add(key);
        }

        /*
         * dsx/dsy inside data-dependent control flow.
         *
         * D3D9 runs both sides of a branch on real hardware, so a derivative
         * taken inside an `if` is well defined there. WGSL forbids it outright,
         * and the shader fails to compile -- which is not a subtle difference:
         * 3DMark06's airship rendered as a black silhouette because its pixel
         * shader would not build at all.
         *
         * The derivative almost always reads a register computed *before* the
         * branch (screen-space coordinates, most often), so hoisting the call
         * to just above the branch is both legal and exactly what the shader
         * asked for. That is only true while nothing has overwritten the
         * operand inside the region, which is what the written-register set
         * tracks; when it has, there is no value above the branch to take a
         * derivative of and the result degrades to zero -- flat, noted, and
         * still a shader that compiles.
         */
        derivativeExpression(builtin, source) {
            const registerKey = source.type + ":" + source.index;
            const frames = this.nonUniformFrames || [];
            const clobbered = frames.some(frame => frame.written.has(registerKey));
            const before = this.lines.length;
            const expression = this.sourceExpression(source);
            // A source modifier that emits its own statement cannot be hoisted
            // with the call; those statements would stay behind.
            const emitted = this.lines.length !== before;
            if (!clobbered && !emitted && !source.relative && frames.length) {
                const outermost = frames[0];
                const name = this.fresh("deriv");
                this.lines.splice(outermost.insertAt, 0,
                    " ".repeat(outermost.indent) + "let " + name + " = " +
                    builtin + "(" + expression + ");");
                for (const frame of frames) ++frame.insertAt;
                this.note("a screen-space derivative inside data-dependent " +
                    "control flow was hoisted above the branch, which WGSL " +
                    "requires and D3D9 does not");
                return name;
            }
            this.note("a screen-space derivative inside data-dependent control " +
                "flow reads a register the branch itself overwrote; there is no " +
                "value above the branch to differentiate, so it evaluates to " +
                "zero (WGSL forbids the call there)");
            return "vec4<f32>(0.0)";
        }

        comparison(control, left, right, componentwise) {
            const operators = { 1: ">", 2: "==", 3: ">=", 4: "<", 5: "!=", 6: "<=" };
            const operator = operators[control];
            if (!operator)
                throw new Error("unsupported comparison control " + control);
            void componentwise;
            return "(" + left + ") " + operator + " (" + right + ")";
        }

        // `if b3` / `callnz l0, b3` -- a bool constant register, optionally
        // negated with the `!` source modifier.
        booleanSource(source) {
            if (source.type === REG_CONSTBOOL) {
                this.maxBoolConst = Math.max(this.maxBoolConst, source.index);
                const expression = "(d9c.b[" + (source.index >> 2) + "][" +
                    (source.index & 3) + "] != 0u)";
                return source.modifier === SRCMOD_NOT ? "!" + expression : expression;
            }
            if (source.type === REG_PREDICATE) {
                this.usesPredicate = true;
                const component = SWIZZLE_CHARS[source.swizzle & 0x3];
                return (source.modifier === SRCMOD_NOT ? "!" : "") + "p0." + component;
            }
            return "((" + this.sourceExpression(source) + ").x != 0.0)";
        }

        // m4x4/m4x3/m3x4/m3x2: src1 names the first of `rows` consecutive
        // registers; each contributes one dot product against src0.
        matrix(dest, sources, size, rows) {
            const vector = this.fresh("m");
            this.emit("let " + vector + " = " + this.sourceExpression(sources[0]) + ";");
            const components = [];
            for (let row = 0; row < rows; ++row) {
                const rowSource = Object.assign({}, sources[1],
                    { index: sources[1].index + row });
                const rowExpression = this.sourceExpression(rowSource);
                components.push(size === 4
                    ? "dot(" + vector + ", " + rowExpression + ")"
                    : "dot(" + vector + ".xyz, (" + rowExpression + ").xyz)");
            }
            while (components.length < 4) components.push("0.0");
            this.store(dest, "vec4<f32>(" + components.join(", ") + ")");
        }

        samplerIndexFor(source) {
            if (source.type !== REG_SAMPLER)
                throw new Error("texture instruction source is not a sampler register");
            if (!this.samplers.has(source.index)) this.samplers.set(source.index, "2d");
            return source.index;
        }

        // Whether stage `index` is sampled as a depth comparison rather than as
        // an ordinary texture. The caller asks; this decides, because a depth
        // sample needs a comparison reference the shader must actually supply:
        //
        //  - Only 2D. A cube or volume depth texture cannot be created here at
        //    all (the protocol's render target binding carries no face index),
        //    so a request for one is a caller bug, not a shader to translate.
        //  - Not ps_1_x. Its texreg2* forms build coordinates out of a
        //    previously sampled register and have no z to compare against, and
        //    hardware shadow maps postdate that shader model entirely.
        //  - Pixel stage only. vs_3_0 vertex texture fetch on a shadow map is
        //    legal in principle but has no caller, and supporting it would mean
        //    a second binding-type path through the vertex sampler layout.
        //
        // Whatever survives is reported in the reflection so the host binds a
        // depth view to exactly the slots declared texture_depth_2d, and the
        // white fallback everywhere else. A mismatch there is a WebGPU
        // validation error that takes down the whole submit, not one draw.
        isDepthSampler(index) {
            return this.requestedDepthSamplers.has(index)
                && this.kind === "pixel" && this.major >= 2
                && (this.samplers.get(index) || "2d") === "2d";
        }

        isDepthFetchSampler(index) {
            return this.isDepthSampler(index)
                && this.requestedDepthFetchSamplers.has(index);
        }

        // Coordinate arity per sampler type; the extra components a D3D9
        // shader leaves in the register are simply not read -- except on a
        // depth sampler, where z is the comparison reference and so has to be
        // carried out alongside the uv rather than dropped with the rest.
        coordinateFor(index, expression, projected) {
            const type = this.samplers.get(index) || "2d";
            const arity = type === "cube" ? 3 : (type === "3d" ? 3 : 2);
            const name = this.fresh("uv");
            this.emit("let " + name + " = " + expression + ";");
            const swizzle = arity === 3 ? "xyz" : "xy";
            // A fetch sampler is depth but takes no reference: emitting one
            // would send it down the comparison path in sampleExpression().
            const wantsDepth = this.isDepthSampler(index)
                && !this.isDepthFetchSampler(index);
            // The divisor is spelled out twice rather than hoisted into a let:
            // the non-projected and non-depth forms have to keep producing
            // exactly the expression they produced before, and `a / b * c` does
            // not reassociate to `a * (c / b)` in floating point.
            const project = value => "(" + value + " / max(abs(" + name +
                ".w), 1e-8) * sign(" + name + ".w + 1e-20))";
            if (projected)
                return { coord: project(name + "." + swizzle),
                    ref: wantsDepth ? project(name + ".z") : null };
            return { coord: name + "." + swizzle,
                ref: wantsDepth ? name + ".z" : null };
        }

        sampleExpression(index, coordinate, options) {
            const texture = "d9_tex" + index;
            const sampler = "d9_smp" + index;
            const coord = this.mirrorOnceCoord(index, coordinate.coord);
            if (coordinate.ref !== null && coordinate.ref !== undefined)
                return this.compareExpression(texture, sampler, coord,
                    coordinate.ref, options);
            if (this.isDepthFetchSampler(index))
                return this.depthFetchExpression(texture, sampler, coord,
                    options);
            if (options && options.gradients)
                return "textureSampleGrad(" + texture + ", " + sampler + ", " +
                    coord + ", " + options.ddx + ", " + options.ddy + ")";
            if (options && options.explicitLod)
                return "textureSampleLevel(" + texture + ", " + sampler + ", " +
                    coord + ", " + options.lod + ")";
            if (options && options.bias !== undefined)
                return this.nonUniformDepth > 0
                    ? this.degradedSample(texture, sampler, coord)
                    : "textureSampleBias(" + texture + ", " + sampler + ", " +
                        coord + ", " + options.bias + ")";
            const stateBias = this.samplerLodBias
                ? this.samplerLodBias[index] : 0;
            if (this.nonUniformDepth > 0)
                return this.degradedSample(texture, sampler, coord);
            // A sampler-state bias applies to the ordinary implicit-derivative
            // sample only. D3D9 ignores it for the explicit-LOD and gradient
            // forms above, and a vertex fetch has no mip chain to bias.
            if (stateBias && this.kind !== "vertex")
                return "textureSampleBias(" + texture + ", " + sampler + ", " +
                    coord + ", " + floatLiteral(stateBias) + ")";
            // Vertex shaders have no implicit derivatives. D3D9 permits VTF
            // only in vs_3_0 and its ordinary texld form selects mip zero;
            // texldl above still uses the explicit LOD carried in coord.w.
            if (this.kind === "vertex")
                return "textureSampleLevel(" + texture + ", " + sampler + ", " +
                    coord + ", 0.0)";
            return "textureSample(" + texture + ", " + sampler + ", " + coord + ")";
        }

        // D3DTADDRESS_MIRRORONCE folded into the coordinate. Cube addressing
        // ignores address modes entirely, so a cube sampler is left alone.
        mirrorOnceCoord(index, coord) {
            const axes = this.samplerMirrorOnce
                ? this.samplerMirrorOnce[index] : null;
            if (!axes) return coord;
            const type = this.samplers.get(index) || "2d";
            if (type === "cube") return coord;
            const components = type === "3d" ? ["x", "y", "z"] : ["x", "y"];
            const vector = type === "3d" ? "vec3<f32>" : "vec2<f32>";
            return vector + "(" + components.map(component =>
                (axes.includes(component)
                    ? "abs((" + coord + ")." + component + ")"
                    : "(" + coord + ")." + component)).join(", ") + ")";
        }

        // Reading a depth texture's stored value. texture_depth_2d sampling
        // returns a scalar, and D3D9 puts the depth in every channel -- shaders
        // read .r or .x from an INTZ/DF24 fetch interchangeably.
        //
        // WebGPU refuses to filter a depth texture except through a comparison,
        // so this is always a point sample of one level. That matches the
        // formats' purpose: an app choosing DF24 wants the exact stored depth
        // to filter itself, not a value the hardware already blended.
        depthFetchExpression(texture, sampler, coord, options) {
            // textureSampleLevel on a depth texture takes a *concrete integer*
            // level, unlike the f32 every colour-texture overload takes. naga
            // rejects the f32 form outright, which is the good outcome: the
            // alternative was a driver-specific failure inside the browser.
            const lod = (options && options.explicitLod)
                ? "i32(" + options.lod + ")" : "0i";
            return "vec4<f32>(textureSampleLevel(" + texture + ", " + sampler +
                ", " + coord + ", " + lod + "))";
        }

        // The hardware shadow map path. D3D9 returns the filtered comparison
        // result broadcast across all four channels -- shaders routinely read
        // .x, .w or .rgb from it interchangeably -- so the scalar is splatted
        // rather than placed in one component.
        //
        // WGSL has no comparison sampling with a gradient or a bias, and none
        // at all under non-uniform control flow. Every one of those degrades to
        // textureSampleCompareLevel, which samples level zero: shadow maps are
        // very nearly always single-level to begin with, so this is a real
        // approximation only for the rare mipped one.
        compareExpression(texture, sampler, coord, ref, options) {
            const explicitLevel = (options && (options.gradients ||
                options.explicitLod || options.bias !== undefined)) ||
                this.nonUniformDepth > 0;
            if (explicitLevel) {
                ++this.levelZeroSamples;
                this.note("a depth comparison sample selects mip level 0: WGSL " +
                    "has no gradient, bias or non-uniform form of " +
                    "textureSampleCompare");
                return "vec4<f32>(textureSampleCompareLevel(" + texture + ", " +
                    sampler + ", " + coord + ", " + ref + "))";
            }
            return "vec4<f32>(textureSampleCompare(" + texture + ", " +
                sampler + ", " + coord + ", " + ref + "))";
        }

        /*
         * Recovers real gradients for a texture sample inside data-dependent
         * control flow.
         *
         * WGSL forbids implicit-derivative sampling there, and the fallback
         * below picks mip level 0 -- correct-ish but visibly aliased wherever
         * the surface is minified, which in practice is most of a scene. When
         * the coordinate comes from a register the branch has not touched,
         * there *is* a value above the branch to differentiate: hoist the
         * coordinate and both derivatives out, and sample with
         * textureSampleGrad, which WGSL permits under any control flow because
         * the gradients are explicit. That is not a degradation at all -- it is
         * the mip level the shader would have selected on D3D9 hardware.
         *
         * Returns null when the coordinate cannot be reconstructed above the
         * branch, leaving degradedSample() to handle it.
         */
        hoistedGradients(index, source, coordinateExpression, projected) {
            const frames = this.nonUniformFrames || [];
            if (!frames.length || !source || source.relative) return null;
            if (frames.some(frame =>
                    frame.written.has(source.type + ":" + source.index)))
                return null;
            const type = this.samplers.get(index) || "2d";
            const swizzle = (type === "cube" || type === "3d") ? "xyz" : "xy";
            const outermost = frames[0];
            const pad = " ".repeat(outermost.indent);
            const raw = this.fresh("guv");
            const uv = this.fresh("gc");
            const dx = this.fresh("gdx");
            const dy = this.fresh("gdy");
            const projectedExpression = projected
                ? "(" + raw + "." + swizzle + " / max(abs(" + raw +
                    ".w), 1e-8) * sign(" + raw + ".w + 1e-20))"
                : raw + "." + swizzle;
            this.lines.splice(outermost.insertAt, 0,
                pad + "let " + raw + " = " + coordinateExpression + ";",
                pad + "let " + uv + " = " + projectedExpression + ";",
                pad + "let " + dx + " = dpdx(" + uv + ");",
                pad + "let " + dy + " = dpdy(" + uv + ");");
            for (const frame of frames) frame.insertAt += 4;
            this.note("a texture sample inside data-dependent control flow " +
                "keeps its real mip level: the coordinate and its derivatives " +
                "are hoisted above the branch and the sample uses explicit " +
                "gradients, which WGSL allows there");
            return { coordinate: uv, ddx: dx, ddy: dy };
        }

        // WGSL forbids implicit-derivative sampling under non-uniform control
        // flow. When hoistedGradients() cannot reconstruct the coordinate above
        // the branch -- because the branch computed it -- mip level 0 is the
        // legal, deterministic fallback: visibly sharper/aliased rather than
        // wrong colours, and counted so it is never a silent difference. Note
        // this is unreachable for ps_2_0 (no flow control at all in that model)
        // and for uniform `if b#`/`rep`/`loop` bodies, whose conditions come
        // from the uniform buffer and so keep control flow uniform.
        degradedSample(texture, sampler, coordinate) {
            ++this.levelZeroSamples;
            this.note("sampling inside data-dependent control flow falls back " +
                "to mip level 0 (WGSL forbids implicit derivatives there)");
            return "textureSampleLevel(" + texture + ", " + sampler + ", " +
                coordinate + ", 0.0)";
        }

        // Consumes the rows the preceding texm3x*pad instructions produced,
        // plus the row the consuming instruction just computed.
        //
        // A shader whose pad/tex pairing is malformed (a texm3x3tex with no
        // pads before it, say) would otherwise read undefined rows. Padding
        // with zero keeps the translation well-formed and notes it, rather
        // than emitting WGSL that references a variable that was never let.
        takeMatrixRows(expected, last) {
            const rows = this.matrixRows.splice(-expected, expected);
            while (rows.length < expected) {
                rows.unshift("0.0");
                this.note("a texm3x* instruction found fewer preceding " +
                    "texm3x*pad rows than it needs; the missing rows read zero");
            }
            rows.push(last);
            return rows;
        }

        legacySamplerType(index) {
            // ps_1_x tex/texld have no sampler declaration. SetTexture selects
            // the dimension at draw time; default to 2D only for the base
            // translation made before a texture is bound.
            const type = (this.options.legacySamplerTypes || {})[index];
            return type === "cube" || type === "3d" ? type : "2d";
        }

        textureLoad(instruction, options) {
            const dest = instruction.dest;
            const sources = instruction.sources;
            const projected = (instruction.control & 0x1) !== 0;
            const biased = (instruction.control & 0x2) !== 0;
            let index, coordinateExpression;
            if (this.kind === "pixel" && this.major === 1 && this.minor < 4) {
                // ps_1_1-1_3 `tex t#`: register number selects both the
                // sampler and the texture coordinate set.
                index = dest.index;
                if (!this.samplers.has(index))
                    this.samplers.set(index, this.legacySamplerType(index));
                this.psTexcoordInputs.add(index);
                coordinateExpression = "t" + index;
            } else if (this.kind === "pixel" && this.major === 1) {
                // ps_1_4 `texld r#, t#`: sampler comes from the destination.
                index = dest.index;
                if (!this.samplers.has(index))
                    this.samplers.set(index, this.legacySamplerType(index));
                coordinateExpression = this.sourceExpression(sources[0]);
            } else {
                index = this.samplerIndexFor(sources[1]);
                coordinateExpression = this.sourceExpression(sources[0]);
            }
            // Try to keep the real mip level before anything else decides the
            // sample has to be level 0. Only the plain and biased forms need
            // it: texldd already carries explicit gradients and texldl an
            // explicit level, and both are legal in non-uniform flow as they
            // stand.
            //
            // Depth samplers are excluded: WGSL has no textureSampleCompareGrad,
            // so there is no gradient form to recover *to*, and the comparison
            // reference must survive -- compareExpression() already handles
            // them and drops to textureSampleCompareLevel.
            const wantsImplicitLod = !(options &&
                (options.explicitLod || options.gradients)) &&
                !this.isDepthSampler(index);
            const recovered = (this.nonUniformDepth > 0 && wantsImplicitLod)
                ? this.hoistedGradients(index,
                    (this.kind === "pixel" && this.major === 1 && this.minor < 4)
                        ? null : sources[0],
                    coordinateExpression, projected)
                : null;
            if (recovered) {
                this.store(dest, this.sampleExpression(index,
                    { coord: recovered.coordinate, ref: null },
                    { gradients: true, ddx: recovered.ddx, ddy: recovered.ddy }));
                return;
            }
            const coordinate = this.coordinateFor(index, coordinateExpression, projected);
            const sampleOptions = {};
            if (options && options.explicitLod) {
                const raw = this.fresh("lod");
                this.emit("let " + raw + " = (" + coordinateExpression + ").w;");
                sampleOptions.explicitLod = true;
                sampleOptions.lod = raw;
            } else if (options && options.gradients) {
                sampleOptions.gradients = true;
                sampleOptions.ddx = "(" + this.sourceExpression(sources[2]) + ")." +
                    ((this.samplers.get(index) || "2d") === "2d" ? "xy" : "xyz");
                sampleOptions.ddy = "(" + this.sourceExpression(sources[3]) + ")." +
                    ((this.samplers.get(index) || "2d") === "2d" ? "xy" : "xyz");
            } else if (biased) {
                sampleOptions.bias = "(" + coordinateExpression + ").w";
            }
            this.store(dest, this.sampleExpression(index, coordinate, sampleOptions));
        }

        // ps_1_x texreg2ar/gb/rgb: build the coordinate from components of a
        // previously-sampled register instead of a texcoord input.
        textureLoadFromComponents(instruction, components) {
            const dest = instruction.dest;
            const index = dest.index;
            if (!this.samplers.has(index))
                this.samplers.set(index, components.length === 3 ? "3d" : "2d");
            // ps_1_x only, and isDepthSampler() excludes ps_1_x, so this form
            // never carries a comparison reference.
            const coordinate = { coord: "(" +
                this.sourceExpression(instruction.sources[0]) + ")." + components,
                ref: null };
            this.store(dest, this.sampleExpression(index, coordinate, {}));
        }

        // ---- module assembly ----

        assemble(routines, bodies, mainBody) {
            const out = [];
            const kind = this.kind;
            const floatCount = Math.max(1, Math.min(this.constantCapacity(),
                this.maxFloatConst + 1));
            const intCount = Math.max(1, this.maxIntConst + 1);
            const boolVectors = Math.max(1, Math.ceil((this.maxBoolConst + 1) / 4));

            out.push("// translated from " + kind + " shader model " +
                this.major + "." + this.minor);
            out.push("struct D9Constants {");
            out.push("    f: array<vec4<f32>, " + floatCount + ">,");
            out.push("    i: array<vec4<i32>, " + intCount + ">,");
            out.push("    b: array<vec4<u32>, " + boolVectors + ">,");
            if (kind === "vertex") {
                // xy = render target size in pixels, for the D3D9 half-pixel
                // offset applied to o_position below.
                out.push("    viewport: vec4<f32>,");
                if (this.options.clipPlaneCount)
                    out.push("    clip_planes: array<vec4<f32>, " +
                        this.options.clipPlaneCount + ">,");
            }
            if (kind === "vertex" && this.options.pointExpansion) {
                out.push("    point_viewport: vec4<f32>,");
                out.push("    point_params: vec4<f32>,");
            }
            if (kind === "pixel" && this.bumpStages.size) {
                // One (m00, m01, m10, m11) per sampler up to the highest one a
                // texbem names, plus the luminance scale/offset pair. Indexed
                // by sampler so the WGSL can subscript it directly.
                const count = Math.max(...this.bumpStages) + 1;
                out.push("    bump: array<vec4<f32>, " + count + ">,");
                out.push("    bump_lum: array<vec4<f32>, " + count + ">,");
            }
            out.push("};");
            out.push("@group(0) @binding(" + (kind === "vertex" ? 0 : 1) +
                ") var<uniform> d9c: D9Constants;");

            const samplerIndices = Array.from(this.samplers.keys()).sort((a, b) => a - b);
            const samplerBindingBase = kind === "vertex" ? 34 : 2;
            for (const index of samplerIndices) {
                const type = this.samplers.get(index);
                const depth = this.isDepthSampler(index);
                const compare = depth && !this.isDepthFetchSampler(index);
                const wgslType = depth ? "texture_depth_2d"
                    : (type === "cube" ? "texture_cube<f32>"
                        : (type === "3d" ? "texture_3d<f32>" : "texture_2d<f32>"));
                out.push("@group(0) @binding(" + (samplerBindingBase + index * 2) + ") var d9_tex" +
                    index + ": " + wgslType + ";");
                out.push("@group(0) @binding(" + (samplerBindingBase + 1 + index * 2) + ") var d9_smp" +
                    index + ": " + (compare ? "sampler_comparison" : "sampler") + ";");
            }

            out.push("");
            out.push("fn d9_rcp(v: f32) -> f32 { return select(1.0 / v, " +
                FLOAT_MAX + ", v == 0.0); }");
            out.push("fn d9_rsq(v: f32) -> f32 { let a = abs(v); return " +
                "select(inverseSqrt(a), " + FLOAT_MAX + ", a == 0.0); }");
            out.push("fn d9_log(v: f32) -> f32 { let a = abs(v); return " +
                "select(log2(a), -" + FLOAT_MAX + ", a == 0.0); }");
            out.push("fn d9_normalize(v: vec3<f32>) -> vec3<f32> { let l = " +
                "dot(v, v); return select(v * inverseSqrt(l), vec3<f32>(0.0), l == 0.0); }");
            out.push("fn d9_lit(s: vec4<f32>) -> vec4<f32> {");
            out.push("    let power = clamp(s.w, -127.9961, 127.9961);");
            out.push("    let specular = select(0.0, pow(max(s.y, 0.0), power), " +
                "s.x > 0.0 && s.y > 0.0);");
            out.push("    return vec4<f32>(1.0, max(s.x, 0.0), specular, 1.0);");
            out.push("}");
            out.push("");

            // Registers live at module scope so `label` subroutines can share
            // them without threading a state struct through every call.
            for (const index of Array.from(this.temps).sort((a, b) => a - b))
                out.push("var<private> r" + index + ": vec4<f32> = vec4<f32>(0.0);");
            if (this.usesAddress) {
                out.push("var<private> a0: vec4<i32> = vec4<i32>(0);");
                out.push("var<private> a0f: vec4<f32> = vec4<f32>(0.0);");
            }
            if (this.usesLoopCounter) out.push("var<private> aL: i32 = 0;");
            if (this.usesPredicate) {
                out.push("var<private> p0: vec4<bool> = vec4<bool>(false);");
                out.push("var<private> p0f: vec4<bool> = vec4<bool>(false);");
            }

            if (kind === "vertex") {
                out.push("var<private> o_position: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 1.0);");
                if (this.usesPointSize)
                    out.push("var<private> o_pointsize: vec4<f32> = vec4<f32>(1.0);");
                for (let slot = 0; slot < VARYING_COUNT; ++slot) {
                    // D3D9's oFog factor defaults to one (no fog) when a
                    // vertex shader does not write it. Initialising it to
                    // zero makes a fixed-function pixel fog blend replace the
                    // entire textured draw with the fog colour.
                    const initialValue = slot === VARYING_FOG
                        ? "vec4<f32>(1.0, 0.0, 0.0, 0.0)" : "vec4<f32>(0.0)";
                    out.push("var<private> o_varying" + slot +
                        ": vec4<f32> = " + initialValue + ";");
                }
                for (const index of Array.from(this.usedInputs.keys()).sort((a, b) => a - b))
                    out.push("var<private> vin" + index + ": vec4<f32> = vec4<f32>(0.0);");
            } else {
                for (const index of Array.from(this.psTexcoordInputs).sort((a, b) => a - b))
                    out.push("var<private> t" + index + ": vec4<f32> = vec4<f32>(0.0);");
                for (const index of Array.from(this.psColorInputs).sort((a, b) => a - b))
                    out.push("var<private> v" + index + ": vec4<f32> = vec4<f32>(0.0);");
                for (const index of Array.from(this.colorOutputs).sort((a, b) => a - b))
                    out.push("var<private> oC" + index + ": vec4<f32> = vec4<f32>(0.0);");
                // ps_1_x has no oC# register at all: the final colour is
                // whatever the shader left in r0. r0 is declared with the
                // other temps above, so nothing extra is needed there, but a
                // ps_2_0+ shader that never writes oC0 still needs the
                // variable to exist for the epilogue to read.
                if (this.major > 1 && !this.colorOutputs.has(0))
                    out.push("var<private> oC0: vec4<f32> = vec4<f32>(0.0);");
                if (this.usesDepthOutput)
                    out.push("var<private> o_depthv: vec4<f32> = vec4<f32>(0.0);");
                if (this.usesFragPosition)
                    out.push("var<private> d9_frag_position: vec4<f32> = vec4<f32>(0.0);");
                if (this.usesFrontFacing)
                    out.push("var<private> d9_face: f32 = 1.0;");
            }
            out.push("");

            for (const routine of routines.subroutines) {
                out.push("fn d9_sub" + routine.label + "() {");
                out.push(...bodies.get(routine.label));
                out.push("}");
                out.push("");
            }

            out.push("fn d9_body() {");
            out.push(...mainBody);
            out.push("}");
            out.push("");

            if (kind === "vertex") this.assembleVertexEntry(out);
            else this.assemblePixelEntry(out);

            const reflection = this.reflect(floatCount, intCount, boolVectors);
            return { wgsl: out.join("\n") + "\n", reflection };
        }

        assembleVertexEntry(out) {
            const inputs = Array.from(this.usedInputs.keys())
                .map(register => [register, this.inputSemanticFor(register)])
                .filter(entry => entry[1])
                .sort((a, b) => a[0] - b[0]);
            const conversions = this.options.inputConversions || {};
            const conversionKinds = new Set(Object.values(conversions));
            if (conversionKinds.has("udec3")) {
                out.push("fn d9_unpack_udec3(value: u32) -> vec4<f32> {");
                out.push("    return vec4<f32>(f32(value & 0x3ffu), " +
                    "f32((value >> 10u) & 0x3ffu), " +
                    "f32((value >> 20u) & 0x3ffu), 1.0);");
                out.push("}");
                out.push("");
            }
            if (conversionKinds.has("dec3n")) {
                out.push("fn d9_snorm10(value: u32) -> f32 {");
                out.push("    let signed_value = i32(value << 22u) >> 22;");
                out.push("    return max(f32(signed_value) / 511.0, -1.0);");
                out.push("}");
                out.push("fn d9_unpack_dec3n(value: u32) -> vec4<f32> {");
                out.push("    return vec4<f32>(d9_snorm10(value & 0x3ffu), " +
                    "d9_snorm10((value >> 10u) & 0x3ffu), " +
                    "d9_snorm10((value >> 20u) & 0x3ffu), 1.0);");
                out.push("}");
                out.push("");
            }
            out.push("struct D9VertexOutput {");
            out.push("    @builtin(position) position: vec4<f32>,");
            for (let slot = 0; slot < VARYING_COUNT; ++slot)
                out.push(this.varyingDeclaration(slot));
            const clipPlaneCount = this.options.clipPlaneCount || 0;
            for (let group = 0; group < Math.ceil(clipPlaneCount / 4); ++group)
                out.push("    @location(" + (VARYING_COUNT + group) +
                    ") clip" + group + ": vec4<f32>,");
            out.push("};");
            out.push("");
            const inputType = location => ({
                ubyte4: "vec4<u32>", short2: "vec2<i32>",
                short4: "vec4<i32>", udec3: "u32", dec3n: "u32",
            })[conversions[location]] || "vec4<f32>";
            const parameters = inputs.map(entry =>
                "@location(" + entry[0] + ") in" + entry[0] + ": " +
                    inputType(entry[0]));
            if (this.options.pointExpansion)
                parameters.push("@builtin(vertex_index) d9_vertex_index: u32");
            out.push("@vertex");
            out.push("fn d9_vs_main(" + parameters.join(", ") + ") -> D9VertexOutput {");
            // A D3DCOLOR-typed attribute is packed ARGB in memory, so WebGPU's
            // unorm8x4 delivers it as (b, g, r, a) while D3D9 hands the shader
            // (r, g, b, a). The caller passes the set of locations that need
            // correcting -- it is the only party that knows the vertex
            // declaration -- and the swizzle rides on the copy into the
            // register instead of costing a CPU pass over the vertex data.
            // This is why a shader can have more than one translated variant
            // (see bgraInputLocations/inputConversions in compileShader's
            // options). Compact integer declarations need the same treatment:
            // WebGPU exposes integer vertex formats as integer WGSL values,
            // while D3D9 always presents them to v# as a float4.
            const bgra = new Set(this.options.bgraInputLocations || []);
            const inputValue = location => {
                const name = "in" + location;
                switch (conversions[location]) {
                case "ubyte4":
                case "short4": return "vec4<f32>(" + name + ")";
                case "short2":
                    return "vec4<f32>(vec2<f32>(" + name + "), 0.0, 1.0)";
                case "udec3": return "d9_unpack_udec3(" + name + ")";
                case "dec3n": return "d9_unpack_dec3n(" + name + ")";
                default: return name + (bgra.has(location) ? ".bgra" : "");
                }
            };
            for (const entry of inputs)
                out.push("    vin" + entry[0] + " = " +
                    inputValue(entry[0]) + ";");
            out.push("    d9_body();");
            out.push("    var result: D9VertexOutput;");
            // D3D9 clip space is z in [0, w]; WebGPU's is identical, so the
            // position needs no depth-range remap (unlike an OpenGL target,
            // which would need z = 2z - w here).
            //
            // XY does need fixing up: D3D9 samples a pixel at its integer
            // corner and WebGPU at its centre, half a pixel apart, and a title
            // that aligns output to pixels has already subtracted that half
            // pixel itself. Put it back, scaled by w so it stays half a pixel
            // at any depth, with y negated because screen y grows downward
            // while NDC y grows upward. Same fix as the fixed-function path's
            // HALF_PIXEL_OFFSET_BODY, and as wined3d's posFixup.
            out.push("    result.position = vec4<f32>(");
            out.push("        o_position.x + o_position.w / d9c.viewport.x,");
            out.push("        o_position.y - o_position.w / d9c.viewport.y,");
            out.push("        o_position.zw);");
            for (let slot = 0; slot < VARYING_COUNT; ++slot)
                out.push("    result.varying" + slot + " = o_varying" + slot + ";");
            for (let group = 0; group < Math.ceil(clipPlaneCount / 4); ++group)
                out.push("    result.clip" + group + " = vec4<f32>(1.0);");
            for (let plane = 0; plane < clipPlaneCount; ++plane)
                out.push("    result.clip" + Math.floor(plane / 4) + "." +
                    "xyzw"[plane & 3] + " = dot(o_position, " +
                    "d9c.clip_planes[" + plane + "]);" );
            if (this.options.pointExpansion) {
                out.push("    let d9_point_uvs = array<vec2<f32>, 6>(");
                out.push("        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0),");
                out.push("        vec2<f32>(0.0, 1.0), vec2<f32>(0.0, 1.0),");
                out.push("        vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));");
                out.push("    let d9_point_uv = d9_point_uvs[d9_vertex_index % 6u];");
                out.push("    var d9_point_size = " + (this.usesPointSize
                    ? "o_pointsize.x;" : "d9c.point_params.x;"));
                out.push("    d9_point_size = clamp(d9_point_size, d9c.point_params.y,");
                out.push("        max(d9c.point_params.y, d9c.point_params.z));");
                out.push("    let d9_point_ndc = vec2<f32>(");
                out.push("        (d9_point_uv.x * 2.0 - 1.0) * d9_point_size / d9c.point_viewport.x,");
                out.push("        (1.0 - d9_point_uv.y * 2.0) * d9_point_size / d9c.point_viewport.y);");
                out.push("    result.position = vec4<f32>(result.position.xy +");
                out.push("        d9_point_ndc * result.position.w, result.position.zw);");
                if (this.options.pointSprite) {
                    for (let stage = 0; stage < 8; ++stage) {
                        out.push("    result.varying" + (VARYING_TEXCOORD0 + stage) +
                            " = vec4<f32>(d9_point_uv, 0.0, 1.0);");
                    }
                }
            }
            out.push("    return result;");
            out.push("}");
        }

        assemblePixelEntry(out) {
            // ps_1_x/ps_2_0 have a fixed input mapping (t# = TEXCOORD#,
            // v# = COLOR#); ps_3_0 replaces it with dcl-declared semantics on
            // v# and has no t# registers at all.
            const declared = []; // { slot, register }
            if (this.major < 3) {
                for (const index of this.psTexcoordInputs)
                    declared.push({ slot: VARYING_TEXCOORD0 + index, register: "t" + index });
                for (const index of this.psColorInputs)
                    declared.push({ slot: VARYING_COLOR0 + index, register: "v" + index });
            } else {
                for (const index of this.psColorInputs) {
                    const semantic = this.usedInputs.get(index);
                    if (!semantic)
                        throw new Error("ps_3_0 input v" + index +
                            " was read without a dcl semantic");
                    const slot = varyingForSemantic(semantic.usage, semantic.usageIndex);
                    if (slot < 0)
                        throw new Error("pixel shader input semantic " + semantic.usage +
                            "[" + semantic.usageIndex + "] has no varying slot");
                    declared.push({ slot, register: "v" + index });
                }
            }
            for (const entry of declared) {
                if (entry.slot < 0 || entry.slot >= VARYING_COUNT)
                    throw new Error("pixel shader input maps outside the varying set");
            }

            out.push("struct D9PixelInput {");
            out.push("    @builtin(position) position: vec4<f32>,");
            for (let slot = 0; slot < VARYING_COUNT; ++slot)
                out.push(this.varyingDeclaration(slot));
            const clipPlaneCount = this.options.clipPlaneCount || 0;
            for (let group = 0; group < Math.ceil(clipPlaneCount / 4); ++group)
                out.push("    @location(" + (VARYING_COUNT + group) +
                    ") clip" + group + ": vec4<f32>,");
            out.push("};");
            out.push("");
            // One @location per oC# the shader writes. D3D9 requires oC0 and
            // allows oC1..oC3 for multiple render targets; a shader that skips
            // a middle target would leave a hole WebGPU has no way to express,
            // so the declared set is filled contiguously up to the highest one
            // written and the unwritten slots get whatever oC# defaulted to
            // (zero) -- which is what a real driver leaves in an untouched
            // target within a pass, and is visible in reflection.colorOutputs.
            const targetCount = this.colorOutputs.size
                ? Math.max(...this.colorOutputs) + 1 : 1;
            out.push("struct D9PixelOutput {");
            for (let target = 0; target < targetCount; ++target)
                out.push("    @location(" + target + ") color" + target +
                    ": vec4<f32>,");
            if (this.usesDepthOutput)
                out.push("    @builtin(frag_depth) depth: f32,");
            out.push("};");
            out.push("");
            out.push("@fragment");
            const faceParameter = this.usesFrontFacing
                ? ", @builtin(front_facing) d9_front: bool" : "";
            out.push("fn d9_ps_main(stage_in: D9PixelInput" + faceParameter +
                ") -> D9PixelOutput {");
            for (let plane = 0; plane < clipPlaneCount; ++plane)
                out.push("    if (stage_in.clip" + Math.floor(plane / 4) +
                    "." + "xyzw"[plane & 3] + " < 0.0) { discard; }");
            for (const entry of declared)
                out.push("    " + entry.register + " = stage_in.varying" + entry.slot + ";");
            if (this.usesFragPosition)
                out.push("    d9_frag_position = stage_in.position;");
            if (this.usesFrontFacing)
                out.push("    d9_face = select(-1.0, 1.0, d9_front);");
            out.push("    d9_body();");
            out.push("    var result: D9PixelOutput;");
            // ps_1_x leaves its result in r0; ps_2_0+ writes oC0 explicitly.
            out.push("    result.color0 = " + (this.major === 1 ? "r0" : "oC0") + ";");
            for (let target = 1; target < targetCount; ++target)
                out.push("    result.color" + target + " = oC" + target + ";");
            // D3D9's alpha test runs after the shader, on the colour it
            // produced. WebGPU has no such stage, so the caller passes the
            // comparison in and it becomes a discard here -- which is why an
            // alpha-tested draw needs its own translated variant of the same
            // bytecode (see alphaTest in compileShader's options).
            if (this.options.alphaTestDiscard)
                out.push(this.options.alphaTestDiscard.replace(/\n$/, ""));
            if (this.usesDepthOutput)
                out.push("    result.depth = o_depthv.x;");
            out.push("    return result;");
            out.push("}");

        }

        // The semantic a used v# carries: the one its dcl declared, or the
        // API's fixed vs_1_x table when the model has no dcl to declare it.
        inputSemanticFor(register) {
            const declared = this.usedInputs.get(register);
            if (declared) return declared;
            if (this.kind === "vertex" && this.major === 1)
                return vs1InputSemantic(register);
            return null;
        }

        reflect(floatCount, intCount, boolVectors) {
            const inputs = [];
            for (const register of this.usedInputs.keys()) {
                const semantic = this.inputSemanticFor(register);
                if (!semantic) continue;
                inputs.push({ register, usage: semantic.usage,
                    usageIndex: semantic.usageIndex, location: register });
            }
            inputs.sort((a, b) => a.register - b.register);
            const samplerBindingBase = this.kind === "vertex" ? 34 : 2;
            const samplers = Array.from(this.samplers.entries())
                .map(([index, type]) => ({ index, type,
                    depth: this.isDepthSampler(index)
                        ? (this.isDepthFetchSampler(index) ? "fetch" : "compare")
                        : false,
                    textureBinding: samplerBindingBase + index * 2,
                    samplerBinding: samplerBindingBase + 1 + index * 2 }))
                .sort((a, b) => a.index - b.index);
            const floatDefaults = [];
            for (const [register, values] of this.floatDefaults)
                floatDefaults.push({ register, values });
            const intDefaults = [];
            for (const [register, values] of this.intDefaults)
                intDefaults.push({ register, values });
            const boolDefaults = [];
            for (const [register, value] of this.boolDefaults)
                boolDefaults.push({ register, value });
            const registerUniformBytes = floatCount * 16 + intCount * 16 +
                boolVectors * 16;
            const pointExpansion = this.kind === "vertex" &&
                !!this.options.pointExpansion;
            // Every vertex shader carries the render target size for the
            // half-pixel offset, so it sits between the register region and the
            // optional point-sprite fields.
            const isVertex = this.kind === "vertex";
            const viewportOffset = isVertex ? registerUniformBytes : -1;
            const clipPlaneCount = isVertex
                ? (this.options.clipPlaneCount || 0) : 0;
            const clipPlanesOffset = clipPlaneCount
                ? registerUniformBytes + 16 : -1;
            const trailingOffset = registerUniformBytes + (isVertex ? 16 : 0)
                + clipPlaneCount * 16;
            // ps_1_x texbem/texbeml: the stage matrices follow the register
            // region, in the same order the struct above declares them.
            const bumpStageCount = (!isVertex && this.bumpStages.size)
                ? Math.max(...this.bumpStages) + 1 : 0;
            const bumpOffset = bumpStageCount ? trailingOffset : -1;
            const bumpLuminanceOffset = bumpStageCount
                ? trailingOffset + bumpStageCount * 16 : -1;
            return {
                kind: this.kind,
                version: { major: this.major, minor: this.minor },
                entryPoint: this.kind === "vertex" ? "d9_vs_main" : "d9_ps_main",
                inputs,
                samplers,
                floatConstCount: floatCount,
                intConstCount: intCount,
                boolVectorCount: boolVectors,
                usesRelativeConstants: this.usesRelativeConstants,
                writesPointSize: this.usesPointSize,
                writesDepth: this.usesDepthOutput,
                readsFrontFacing: this.usesFrontFacing,
                readsFragmentPosition: this.usesFragPosition,
                colorOutputs: Array.from(this.colorOutputs).sort((a, b) => a - b),
                // Which varying slots this shader actually assigns. A fixed-
                // function pixel cascade paired with a translated vertex
                // shader has to read the slots that shader wrote; reading one
                // it never wrote yields a constant, and a constant texture
                // coordinate samples one texel across a whole model -- a flat
                // silhouette that looks like a lighting or texture bug rather
                // than the stage/varying mismatch it is.
                writtenVaryings: Array.from(this.writtenVaryings)
                    .sort((a, b) => a - b),
                floatDefaults, intDefaults, boolDefaults,
                levelZeroSamples: this.levelZeroSamples,
                warnings: this.warnings.slice(),
                uniformBytes: trailingOffset + (pointExpansion ? 32 : 0) +
                    bumpStageCount * 32,
                bumpStageCount,
                bumpOffset,
                bumpLuminanceOffset,
                floatRegionBytes: floatCount * 16,
                intRegionBytes: intCount * 16,
                boolRegionBytes: boolVectors * 16,
                viewportOffset,
                clipPlaneCount,
                clipPlanesOffset,
                pointExpansion,
                pointSprite: pointExpansion && !!this.options.pointSprite,
                pointViewportOffset: pointExpansion ? trailingOffset : -1,
                pointParamsOffset: pointExpansion ? trailingOffset + 16 : -1,
            };
        }
    }

    // Translates one shader's raw token array. Never throws: a shader this
    // module cannot handle comes back as {ok:false, error}, because the
    // caller's contract (plan 4.2) is to mark the handle unusable and skip
    // draws that bind it -- not to fail the whole command batch.
    function compileShader(tokens, options) {
        try {
            const parsed = parseShader(tokens);
            const translator = new Translator(parsed, options);
            const result = translator.translate();
            return { ok: true, wgsl: result.wgsl, reflection: result.reflection };
        } catch (error) {
            return { ok: false, error: error && error.message ? error.message :
                String(error) };
        }
    }

    // 64-bit FNV-1a over the token stream, matching shader_bytecode_hash() in
    // d3d9_proxy.c so a host cache lookup can use the hash the guest already
    // computed without re-deriving it.
    function hashTokens(tokens) {
        let low = 0x84222325 >>> 0, high = 0xcbf29ce4 >>> 0;
        const mix = byte => {
            low = (low ^ byte) >>> 0;
            // 64-bit multiply by the FNV prime 0x100000001b3, done in 16-bit
            // limbs so it stays exact in doubles.
            const primeLow = 0x000001b3;
            const l0 = low & 0xffff, l1 = low >>> 16;
            const h0 = high & 0xffff, h1 = high >>> 16;
            let r0 = l0 * primeLow;
            let r1 = l1 * primeLow + (r0 >>> 16);
            let r2 = h0 * primeLow + (r1 >>> 16) + l0; // + low << 32 term
            let r3 = h1 * primeLow + (r2 >>> 16) + l1;
            low = ((r1 & 0xffff) << 16 | (r0 & 0xffff)) >>> 0;
            high = ((r3 & 0xffff) << 16 | (r2 & 0xffff)) >>> 0;
        };
        for (let i = 0; i < tokens.length; ++i) {
            const token = tokens[i] >>> 0;
            mix(token & 0xff);
            mix((token >>> 8) & 0xff);
            mix((token >>> 16) & 0xff);
            mix((token >>> 24) & 0xff);
        }
        return { low: low >>> 0, high: high >>> 0 };
    }

    // Content-addressed cache in front of compileShader(). Keyed by the
    // guest's bytecode hash so two CreateVertexShader calls with identical
    // bytecode -- routine when a game recreates its effect set after a device
    // Reset -- translate exactly once. Deliberately holds no GPU objects:
    // WGSL text survives device loss (plan 8.5), GPUShaderModules do not.
    class D3D9ShaderCache {
        constructor(options) {
            this.options = options || {};
            this.limit = this.options.limit || 4096;
            this.entries = new Map();
            this.clock = this.options.clock || (() =>
                typeof performance !== "undefined" && performance.now
                    ? performance.now() : Date.now());
            this.compileTimes = [];
            this.totalWGSLBytes = 0;
            this.stats = { compiles: 0, hits: 0, failures: 0, evictions: 0,
                restored: 0 };
        }

        key(hashLow, hashHigh) {
            return ((hashHigh >>> 0).toString(16) + ":" + (hashLow >>> 0).toString(16));
        }

        get(hashLow, hashHigh) {
            const key = this.key(hashLow, hashHigh);
            const entry = this.entries.get(key);
            if (!entry) return null;
            // Re-insert so Map iteration order stays least-recently-used first.
            this.entries.delete(key);
            this.entries.set(key, entry);
            ++this.stats.hits;
            return entry;
        }

        compile(tokens, hashLow, hashHigh, options) {
            const existing = this.get(hashLow, hashHigh);
            if (existing) return existing;
            const started = this.clock();
            const result = compileShader(tokens, options);
            const elapsed = Math.max(0, this.clock() - started);
            return this.store(hashLow, hashHigh, result, elapsed);
        }

        store(hashLow, hashHigh, result, elapsed) {
            const key = this.key(hashLow, hashHigh);
            const existing = this.entries.get(key);
            if (existing) return existing;
            elapsed = Math.max(0, Number(elapsed) || 0);
            this.compileTimes.push(elapsed);
            if (this.compileTimes.length > this.limit)
                this.compileTimes.shift();
            ++this.stats.compiles;
            if (!result.ok) ++this.stats.failures;
            this.entries.set(key, result);
            if (result.ok) this.totalWGSLBytes += result.wgsl.length * 2;
            while (this.entries.size > this.limit) {
                const oldest = this.entries.keys().next();
                if (oldest.done) break;
                const evicted = this.entries.get(oldest.value);
                if (evicted && evicted.ok)
                    this.totalWGSLBytes -= evicted.wgsl.length * 2;
                this.entries.delete(oldest.value);
                ++this.stats.evictions;
            }
            return result;
        }

        snapshot() {
            const sorted = this.compileTimes.slice().sort((a, b) => a - b);
            const percentile = value => {
                if (!sorted.length) return 0;
                return sorted[Math.min(sorted.length - 1,
                    Math.max(0, Math.ceil(value * sorted.length) - 1))];
            };
            return { hits: this.stats.hits, misses: this.stats.compiles,
                failures: this.stats.failures, evictions: this.stats.evictions,
                restored: this.stats.restored,
                cached: this.entries.size,
                totalWGSLBytes: Math.max(0, this.totalWGSLBytes),
                compileLatencyMs: { p50: percentile(0.50),
                    p95: percentile(0.95), p99: percentile(0.99),
                    samples: sorted.length } };
        }

        exportEntries(maxBytes) {
            const limit = maxBytes || 2 * 1024 * 1024;
            const entries = [];
            let bytes = 0;
            // Newest LRU entries are at the end; keep as many of those as the
            // persistent budget permits, then restore their original order.
            for (const [key, result] of Array.from(this.entries).reverse()) {
                const item = { key, result };
                const encoded = JSON.stringify(item);
                if (bytes + encoded.length * 2 > limit) continue;
                entries.push(item);
                bytes += encoded.length * 2;
            }
            entries.reverse();
            return { version: 1, revision: TRANSLATOR_REVISION, entries };
        }

        importEntries(payload) {
            if (!payload || payload.version !== 1 || !Array.isArray(payload.entries))
                return 0;
            // A payload written by a different build of the translator holds
            // that build's WGSL and reflection. Restoring it would mean this
            // session runs code this file no longer generates.
            if (payload.revision !== TRANSLATOR_REVISION) return 0;
            let restored = 0;
            for (const item of payload.entries) {
                if (!item || typeof item.key !== "string" || !item.result) continue;
                const result = item.result;
                if (result.ok && (typeof result.wgsl !== "string" ||
                        !result.reflection)) continue;
                if (!result.ok && typeof result.error !== "string") continue;
                if (this.entries.has(item.key)) continue;
                this.entries.set(item.key, result);
                if (result.ok) this.totalWGSLBytes += result.wgsl.length * 2;
                ++restored;
                if (this.entries.size >= this.limit) break;
            }
            this.stats.restored += restored;
            return restored;
        }
    }

    const api = {
        compileShader, parseShader, hashTokens, D3D9ShaderCache,
        TRANSLATOR_REVISION,
        VARYING_COLOR0, VARYING_COLOR1, VARYING_TEXCOORD0, VARYING_FOG,
        VARYING_COUNT, varyingForSemantic,
        OP, REGISTER: {
            TEMP: REG_TEMP, INPUT: REG_INPUT, CONST: REG_CONST, ADDR: REG_ADDR,
            TEXTURE: REG_TEXTURE, RASTOUT: REG_RASTOUT, ATTROUT: REG_ATTROUT,
            OUTPUT: REG_OUTPUT, CONSTINT: REG_CONSTINT, COLOROUT: REG_COLOROUT,
            DEPTHOUT: REG_DEPTHOUT, SAMPLER: REG_SAMPLER,
            CONSTBOOL: REG_CONSTBOOL, LOOP: REG_LOOP, MISCTYPE: REG_MISCTYPE,
            LABEL: REG_LABEL, PREDICATE: REG_PREDICATE,
        },
    };

    global.D3D9ShaderPipeline = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
