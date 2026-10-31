// GL_ARB_vertex_program and GL_ARB_fragment_program assembly -> WGSL.
//
// ARB assembly is a register machine: a handful of typed register files, four
// component swizzles, write masks, source modifiers, and a flat instruction
// list with no control flow. That is structurally what D3D9's shader model 1.x
// is, and d3d9_shader_pipeline.js already solved the interesting half of it --
// how to keep swizzles, masks and saturation straight while emitting readable
// WGSL. What does not transfer is the front end (text, not bytecode) and the
// instruction semantics, so those are written out here.
//
// The state bindings (state.matrix.mvp, state.light[n].position, ...) resolve
// into the *same* GLState block the fixed pipeline and the GLSL compatibility
// built-ins use, so an ARB program and a fixed-function draw see one set of
// matrices rather than two that can drift.
//
// See docs/opengl-webgpu-implementation-plan.zh-CN.md chapter 9.

(function(global) {
    "use strict";

    const nodeRequire = (typeof require === "function" &&
        typeof module !== "undefined") ? require : null;
    const stateLayout = nodeRequire ? nodeRequire("./gl_state_layout.js") :
        global.GLStateLayout;
    const translator = nodeRequire ? nodeRequire("./gl_shader_translator.js") :
        global.GLShaderTranslator;

    const ARB_REVISION = 5;

    /*
     * Vertex programs require at least 96 parameters. Fragment programs
     * retain 28 for WineD3D's program.env[27] (openglproxy/README.md).
     * Storage has one shape for both stages; validation and advertised
     * limits use the target's logical range.
     */
    const MAX_PROGRAM_PARAMETERS = 96;
    const MAX_FRAGMENT_PROGRAM_PARAMETERS = 28;
    const MAX_PROGRAM_BINDINGS = 4096;
    const MAX_ADDRESS_REGISTERS = 32;
    const parameterLimit = target => target === "vertex" ? MAX_PROGRAM_PARAMETERS : MAX_FRAGMENT_PROGRAM_PARAMETERS;
    /* Group 1 binding 0 is the shared GL state block; each stage's ARB
     * parameter block gets a binding of its own. */
    const PARAMETER_BINDING = { vertex: 1, fragment: 2 };
    const MAX_TEMPORARIES = 32;
    const MAX_TEXTURE_UNITS = stateLayout.MAX_TEXTURE_UNITS;
    const ATTR = translator.COMPAT_ATTRIBUTE_LOCATIONS;

    class ARBError extends Error {
        constructor(message, line, offset) {
            super(message);
            this.arbLine = line || 0;
            // GL_PROGRAM_ERROR_POSITION_ARB is a character offset into the
            // program string, not a line: the extension expects the caller to
            // be able to point at the exact token it rejected.
            this.arbOffset = offset === undefined ? -1 : offset;
        }
    }

    /* ================================================================== */
    /* Lexer                                                              */
    /* ================================================================== */

    const TOKEN = /(!!ARB[a-z]+1\.0)|([A-Za-z_$][A-Za-z0-9_$]*)|(-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)|(\s+)|(#[^\n]*)|([\s\S])/g;

    function lex(source) {
        const tokens = [];
        let line = 1;
        let match;
        TOKEN.lastIndex = 0;
        while ((match = TOKEN.exec(source)) !== null) {
            if (match[4] !== undefined || match[5] !== undefined) {
                for (const ch of match[0]) if (ch === "\n") ++line;
                continue;
            }
            const at = match.index;
            if (match[1] !== undefined)
                tokens.push({ type: "header", value: match[1], line, at });
            else if (match[2] !== undefined)
                tokens.push({ type: "ident", value: match[2], line, at });
            else if (match[3] !== undefined)
                tokens.push({ type: "number", value: parseFloat(match[3]),
                             line, at });
            else
                tokens.push({ type: "punct", value: match[6], line, at });
        }
        tokens.push({ type: "eof", value: "", line, at: source.length });
        return tokens;
    }

    /* ================================================================== */
    /* Instruction table                                                  */
    /* ================================================================== */

    /*
     * Each entry: how many sources it takes and how to emit it. `emit` receives
     * the already-swizzled source expressions and returns a vec4 expression;
     * the caller applies the write mask and saturation.
     */
    const INSTRUCTIONS = {
        ABS: { sources: 1, emit: a => "abs(" + a[0] + ")" },
        ADD: { sources: 2, emit: a => "(" + a[0] + " + " + a[1] + ")" },
        CMP: { sources: 3, fragmentOnly: true,
               emit: a => "select(" + a[2] + ", " + a[1] + ", " + a[0] +
                   " < vec4<f32>(0.0))" },
        COS: { sources: 1, scalar: true,
               emit: a => "vec4<f32>(cos(" + a[0] + ".x))" },
        DP3: { sources: 2,
               emit: a => "vec4<f32>(dot(" + a[0] + ".xyz, " + a[1] + ".xyz))" },
        DP4: { sources: 2,
               emit: a => "vec4<f32>(dot(" + a[0] + ", " + a[1] + "))" },
        DPH: { sources: 2,
               emit: a => "vec4<f32>(dot(" + a[0] + ".xyz, " + a[1] + ".xyz) + " +
                   a[1] + ".w)" },
        DST: { sources: 2,
               // The distance-vector helper: (1, d, d^2, 1/d) assembled from
               // two operands that each hold half of it.
               emit: a => "vec4<f32>(1.0, " + a[0] + ".y * " + a[1] + ".y, " +
                   a[0] + ".z, " + a[1] + ".w)" },
        EX2: { sources: 1, scalar: true,
               emit: a => "vec4<f32>(exp2(" + a[0] + ".x))" },
        EXP: { sources: 1, scalar: true,
               emit: a => "vec4<f32>(exp2(floor(" + a[0] + ".x)), fract(" +
                   a[0] + ".x), exp2(" + a[0] + ".x), 1.0)" },
        FLR: { sources: 1, emit: a => "floor(" + a[0] + ")" },
        FRC: { sources: 1, emit: a => "fract(" + a[0] + ")" },
        LG2: { sources: 1, scalar: true,
               emit: a => "vec4<f32>(log2(max(" + a[0] + ".x, 1e-30)))" },
        LIT: { sources: 1, emit: a => "arbLit(" + a[0] + ")" },
        LOG: { sources: 1, scalar: true,
               emit: a => "arbLog(" + a[0] + ".x)" },
        LRP: { sources: 3, fragmentOnly: true,
               emit: a => "mix(" + a[2] + ", " + a[1] + ", " + a[0] + ")" },
        MAD: { sources: 3,
               emit: a => "(" + a[0] + " * " + a[1] + " + " + a[2] + ")" },
        MAX: { sources: 2, emit: a => "max(" + a[0] + ", " + a[1] + ")" },
        MIN: { sources: 2, emit: a => "min(" + a[0] + ", " + a[1] + ")" },
        MOV: { sources: 1, emit: a => a[0] },
        MUL: { sources: 2, emit: a => "(" + a[0] + " * " + a[1] + ")" },
        POW: { sources: 2, scalar: true,
               emit: a => "vec4<f32>(pow(max(" + a[0] + ".x, 0.0), " +
                   a[1] + ".x))" },
        RCP: { sources: 1, scalar: true,
               emit: a => "vec4<f32>(1.0 / " + a[0] + ".x)" },
        RSQ: { sources: 1, scalar: true,
               emit: a => "vec4<f32>(inverseSqrt(max(abs(" + a[0] +
                   ".x), 1e-30)))" },
        SCS: { sources: 1, scalar: true, fragmentOnly: true,
               emit: a => "vec4<f32>(cos(" + a[0] + ".x), sin(" + a[0] +
                   ".x), 0.0, 0.0)" },
        SGE: { sources: 2,
               emit: a => "select(vec4<f32>(0.0), vec4<f32>(1.0), " +
                   a[0] + " >= " + a[1] + ")" },
        SIN: { sources: 1, scalar: true, fragmentOnly: true,
               emit: a => "vec4<f32>(sin(" + a[0] + ".x))" },
        SLT: { sources: 2,
               emit: a => "select(vec4<f32>(0.0), vec4<f32>(1.0), " +
                   a[0] + " < " + a[1] + ")" },
        SUB: { sources: 2, emit: a => "(" + a[0] + " - " + a[1] + ")" },
        XPD: { sources: 2,
               emit: a => "vec4<f32>(cross(" + a[0] + ".xyz, " + a[1] +
                   ".xyz), 1.0)" },
        SWZ: { sources: 1, extendedSwizzle: true, emit: a => a[0] },
        // Control and texture instructions are handled by the generator.
        ARL: { sources: 1, vertexOnly: true, address: true },
        KIL: { sources: 1, fragmentOnly: true, kill: true },
        TEX: { sources: 1, texture: "sample", fragmentOnly: true },
        TXB: { sources: 1, texture: "bias", fragmentOnly: true },
        TXP: { sources: 1, texture: "proj", fragmentOnly: true },
    };

    /* WGSL helpers the instruction set needs. Only emitted when used. */
    const HELPERS = {
        arbLit:
            "fn arbLit(v : vec4<f32>) -> vec4<f32> {\n" +
            "    // ARB's lighting helper: (1, max(x,0), x>0 ? pow(max(y,0), w) : 0, 1)\n" +
            "    let diffuse = max(v.x, 0.0);\n" +
            // (an exponent of 0 gives 1, as the extensions' power does; WGSL's
            // pow(0, 0) is NaN)
            "    let exponent = clamp(v.w, -128.0, 128.0);\n" +
            "    let power = select(pow(max(v.y, 0.0), exponent), 1.0, exponent == 0.0);\n" +
            "    let specular = select(0.0, power, v.x > 0.0);\n" +
            "    return vec4<f32>(1.0, diffuse, specular, 1.0);\n" +
            "}",
        arbLog:
            "fn arbLog(x : f32) -> vec4<f32> {\n" +
            "    let a = max(abs(x), 1e-30);\n" +
            "    let e = floor(log2(a));\n" +
            "    return vec4<f32>(e, a / exp2(e), log2(a), 1.0);\n" +
            "}",
    };

    /* ================================================================== */
    /* Register bindings                                                  */
    /* ================================================================== */

    /*
     * state.* bindings resolve into the shared GLState block. Each entry names
     * the field gl_state_layout.js must include and the WGSL expression that
     * reads it, so an ARB program and a fixed-function draw literally read the
     * same bytes.
     */
    const STATE_BINDINGS = {
        "matrix.modelview": { field: "modelview", matrix: "glState.modelview" },
        "matrix.projection": { field: "projection", matrix: "glState.projection" },
        "matrix.mvp": { field: "mvp", matrix: "glState.mvp" },
        "matrix.modelview.inverse": { field: "modelviewInverse",
            matrix: "glState.modelviewInverse" },
        "matrix.modelview.transpose": { field: "modelviewTranspose",
            matrix: "glState.modelviewTranspose" },
        "matrix.modelview.invtrans": { field: "modelviewInverseTranspose",
            matrix: "glState.modelviewInverseTranspose" },
        "matrix.projection.inverse": { field: "projectionInverse",
            matrix: "glState.projectionInverse" },
        "matrix.projection.transpose": { field: "projectionTranspose",
            matrix: "glState.projectionTranspose" },
        "matrix.projection.invtrans": { field: "projectionInverseTranspose",
            matrix: "glState.projectionInverseTranspose" },
        "matrix.mvp.inverse": { field: "mvpInverse", matrix: "glState.mvpInverse" },
        "matrix.mvp.transpose": { field: "mvpTranspose",
            matrix: "glState.mvpTranspose" },
        "matrix.mvp.invtrans": { field: "mvpInverseTranspose",
            matrix: "glState.mvpInverseTranspose" },
        "material.ambient": { field: "frontMaterial",
            vector: "glState.frontMaterial.ambient" },
        "material.diffuse": { field: "frontMaterial",
            vector: "glState.frontMaterial.diffuse" },
        "material.specular": { field: "frontMaterial",
            vector: "glState.frontMaterial.specular" },
        "material.emission": { field: "frontMaterial",
            vector: "glState.frontMaterial.emission" },
        "material.shininess": { field: "frontMaterial",
            vector: "vec4<f32>(glState.frontMaterial.shininess, 0.0, 0.0, 1.0)" },
        "material.front.ambient": { field: "frontMaterial",
            vector: "glState.frontMaterial.ambient" },
        "material.front.diffuse": { field: "frontMaterial",
            vector: "glState.frontMaterial.diffuse" },
        "material.front.specular": { field: "frontMaterial",
            vector: "glState.frontMaterial.specular" },
        "material.back.ambient": { field: "backMaterial",
            vector: "glState.backMaterial.ambient" },
        "material.back.diffuse": { field: "backMaterial",
            vector: "glState.backMaterial.diffuse" },
        "material.back.specular": { field: "backMaterial",
            vector: "glState.backMaterial.specular" },
        "material.back.emission": { field: "backMaterial",
            vector: "glState.backMaterial.emission" },
        "material.back.shininess": { field: "backMaterial",
            vector: "vec4<f32>(glState.backMaterial.shininess, 0.0, 0.0, 1.0)" },
        "lightmodel.ambient": { field: "lightModelAmbient",
            vector: "glState.lightModelAmbient" },
        "lightmodel.scenecolor": { field: "frontSceneColor",
            vector: "glState.frontSceneColor" },
        "lightmodel.front.scenecolor": { field: "frontSceneColor",
            vector: "glState.frontSceneColor" },
        "lightmodel.back.scenecolor": { field: "backSceneColor",
            vector: "glState.backSceneColor" },
        "fog.color": { field: "fogColor", vector: "glState.fogColor" },
        "fog.params": { field: "fogParams", vector: "glState.fogParams" },
        "depth.range": { field: "depthRange", vector: "glState.depthRange" },
        "point.size": { field: "pointParams", vector: "glState.pointParams" },
        "point.attenuation": { field: "pointAttenuation",
            vector: "glState.pointAttenuation" },
    };

    const INDEXED_STATE = [
        { pattern: /^light\[(\d+)\]\.(ambient|diffuse|specular|position|half)$/,
          field: "lights",
          expr: (index, member) => "glState.lights[" + index + "]." +
              (member === "half" ? "halfVector" : member) },
        { pattern: /^light\[(\d+)\]\.attenuation$/, field: "lights",
          expr: index => "vec4<f32>(glState.lights[" + index +
              "].constantAttenuation, glState.lights[" + index +
              "].linearAttenuation, glState.lights[" + index +
              "].quadraticAttenuation, glState.lights[" + index +
              "].spotExponent)" },
        { pattern: /^light\[(\d+)\]\.spot\.direction$/, field: "lights",
          expr: index => "vec4<f32>(glState.lights[" + index +
              "].spotDirection, glState.lights[" + index + "].spotCosCutoff)" },
        { pattern: /^lightprod\[(\d+)\]\.(ambient|diffuse|specular)$/,
          field: "frontLightProduct",
          expr: (index, member) => "glState.frontLightProduct[" + index + "]." +
              member },
        { pattern: /^lightprod\[(\d+)\]\.back\.(ambient|diffuse|specular)$/,
          field: "backLightProduct",
          expr: (index, member) => "glState.backLightProduct[" + index + "]." +
              member },
        { pattern: /^texenv\[(\d+)\]\.color$/, field: "texEnvColor",
          expr: index => "glState.texEnvColor[" + index + "]" },
        { pattern: /^texenv\.color$/, field: "texEnvColor",
          expr: () => "glState.texEnvColor[0]" },
        { pattern: /^clip\[(\d+)\]\.plane$/, field: "clipPlanes",
          expr: index => "glState.clipPlanes[" + index + "]" },
        { pattern: /^texgen\[(\d+)\]\.(eye|object)\.([stqr])$/,
          field: "texGenPlanes",
          expr: (index, space, coord) => "glState.texGenPlanes[" +
              (parseInt(index, 10) * 8 + (space === "eye" ? 4 : 0) +
               "stqr".indexOf(coord)) + "]" },
    ];

    /* Vertex program inputs, and the attribute slot each occupies. */
    const VERTEX_ATTRIBUTES = {
        "vertex.position": { name: "gl_Vertex", location: ATTR.gl_Vertex },
        "vertex.weight": { name: "gl_Weight", location: 1 },
        "vertex.normal": { name: "gl_Normal", location: ATTR.gl_Normal,
                           components: 3 },
        "vertex.color": { name: "gl_Color", location: ATTR.gl_Color },
        "vertex.color.primary": { name: "gl_Color", location: ATTR.gl_Color },
        "vertex.color.secondary": { name: "gl_SecondaryColor",
                                    location: ATTR.gl_SecondaryColor },
        "vertex.fogcoord": { name: "gl_FogCoord", location: ATTR.gl_FogCoord,
                             components: 1 },
    };

    const VERTEX_RESULTS = {
        "result.position": "position",
        "result.color": "frontColor",
        "result.color.primary": "frontColor",
        "result.color.front": "frontColor",
        "result.color.front.primary": "frontColor",
        "result.color.secondary": "frontSecondary",
        "result.color.front.secondary": "frontSecondary",
        "result.color.back": "backColor",
        "result.color.back.primary": "backColor",
        "result.color.back.secondary": "backSecondary",
        "result.fogcoord": "fogCoord",
        "result.pointsize": "pointSize",
    };

    const FRAGMENT_RESULTS = {
        "result.color": "color0",
        "result.depth": "depth",
    };

    /* ================================================================== */
    /* Parser                                                             */
    /* ================================================================== */

    class Parser {
        constructor(source) {
            this.text = source;
            this.tokens = lex(source);
            this.pos = 0;
            this.target = null;
            this.options = new Set();
            this.aliases = new Map();     // name -> resolved binding text
            this.temporaries = new Set();
            this.addresses = new Set();
            this.params = new Map();      // name -> {size, values|binding}
            this.attribs = new Map();
            this.outputs = new Map();
            this.instructions = [];
            this.declarations = new Set();
        }

        peek(offset) { return this.tokens[this.pos + (offset || 0)]; }
        /* Where the parser stopped, for GL_PROGRAM_ERROR_POSITION_ARB. Errors
         * thrown deeper in the parse do not each have to carry an offset: the
         * token the parser was looking at when it gave up is the position the
         * extension asks for. */
        currentOffset() {
            const token = this.tokens[Math.min(this.pos, this.tokens.length - 1)];
            return token && token.at !== undefined ? token.at : 0;
        }
        next() { return this.tokens[this.pos++]; }
        get line() { return this.peek().line; }
        at(value) {
            const token = this.peek();
            return token.value === value;
        }
        accept(value) {
            if (this.at(value)) { ++this.pos; return true; }
            return false;
        }
        expect(value) {
            if (!this.accept(value))
                throw new ARBError("expected '" + value + "' but found '" +
                    String(this.peek().value) + "'", this.line);
        }
        expectIdent() {
            const token = this.next();
            if (token.type !== "ident")
                throw new ARBError("expected an identifier", token.line);
            return token.value;
        }

        parse() {
            const header = this.next();
            if (header.type !== "header")
                throw new ARBError("a program must begin with !!ARBvp1.0 or " +
                    "!!ARBfp1.0", header.line, header.at);
            this.target = header.value === "!!ARBvp1.0" ? "vertex" : "fragment";
            for (;;) {
                const token = this.peek();
                if (token.type === "eof")
                    throw new ARBError("the program has no END", token.line);
                if (token.type === "ident" && token.value === "END") {
                    this.next();
                    break;
                }
                this.statement();
            }
            return this;
        }

        statement() {
            const token = this.peek();
            if (token.type !== "ident")
                throw new ARBError("unexpected token '" + String(token.value) + "'",
                    token.line);
            switch (token.value) {
            case "OPTION": {
                this.next();
                this.options.add(this.expectIdent());
                this.expect(";");
                return;
            }
            case "TEMP": {
                this.next();
                do { this.declareTemporary(this.expectIdent()); }
                while (this.accept(","));
                this.expect(";");
                return;
            }
            case "ADDRESS": {
                this.next();
                if (this.target !== "vertex") throw new ARBError("fragment programs have no address registers", this.line);
                do { const name = this.expectIdent(); this.declare(name); this.addresses.add(name); }
                while (this.accept(","));
                this.expect(";");
                return;
            }
            case "ALIAS": {
                this.next();
                const name = this.expectIdent();
                this.expect("=");
                const original = this.expectIdent();
                if (!this.declarations.has(original)) throw new ARBError("alias refers to an undeclared variable", this.line);
                this.declare(name); this.aliases.set(name, original);
                this.expect(";");
                return;
            }
            case "ATTRIB": {
                this.next();
                const name = this.expectIdent();
                this.declare(name);
                this.expect("=");
                const binding = this.bindingPath();
                if (!binding.startsWith(this.target === "vertex" ? "vertex." : "fragment."))
                    throw new ARBError("invalid attribute binding", this.line);
                this.attribs.set(name, binding);
                this.expect(";");
                return;
            }
            case "OUTPUT": {
                this.next();
                const name = this.expectIdent();
                this.declare(name);
                this.expect("=");
                const binding = this.bindingPath();
                if (!binding.startsWith("result.")) throw new ARBError("invalid output binding", this.line);
                this.outputs.set(name, binding);
                this.expect(";");
                return;
            }
            case "PARAM": {
                this.next();
                return this.paramStatement();
            }
            default:
                return this.instruction();
            }
        }

        declareTemporary(name) {
            this.declare(name);
            if (this.temporaries.size >= MAX_TEMPORARIES)
                throw new ARBError("more than " + MAX_TEMPORARIES +
                    " temporaries", this.line);
            this.temporaries.add(name);
        }

        declare(name) {
            if (this.declarations.has(name)) throw new ARBError("variable '" + name + "' declared twice", this.line);
            this.declarations.add(name);
        }

        /*
         * A dotted binding path such as vertex.color.secondary or
         * state.light[0].position, kept as text for the resolver.
         *
         * `stopAtSwizzle` is what separates `result.color.secondary` (a path)
         * from `result.color.xz` (a path plus a write mask). No ARB path
         * component is spelled with only swizzle letters, so the test is exact
         * rather than a heuristic.
         */
        bindingPath(stopAtSwizzle) {
            let text = this.expectIdent();
            for (;;) {
                if (this.at(".") && stopAtSwizzle) {
                    const after = this.peek(1);
                    if (after && after.type === "ident" &&
                            /^(?:[xyzw]{1,4}|[rgba]{1,4})$/.test(after.value))
                        break;
                }
                if (this.accept(".")) {
                    const token = this.next();
                    text += "." + String(token.value);
                    continue;
                }
                if (this.at("[")) {
                    // the text between the brackets as written: the lexer
                    // reads 0..4 as two numbers and a.x-1 as a and -1
                    // (review S2-48)
                    const open = this.next();
                    while (!this.at("]")) {
                        const token = this.next();
                        if (token.type === "eof")
                            throw new ARBError("unterminated '['", token.line);
                    }
                    const inner = this.text.slice(open.at + 1, this.peek().at).replace(/\s+/g, "");
                    this.expect("]");
                    text += "[" + inner + "]";
                    continue;
                }
                break;
            }
            return text;
        }

        /*
         * PARAM has two shapes that look alike and mean different things:
         *
         *   PARAM half = { 0.5, 0.5, 0.5, 1.0 };     one four-component constant
         *   PARAM mvp[4] = { state.matrix.mvp };     four registers, from a matrix
         *
         * The braces are the same; what decides is the [n] and whether the
         * contents are bare numbers. Reading the first as four separate
         * registers is the mistake that makes a transform silently use 0.5 as
         * its whole matrix.
         */
        paramStatement() {
            const name = this.expectIdent();
            this.declare(name);
            let arraySize = 0;
            if (this.accept("[")) {
                arraySize = this.at("]") ? -1 : this.next().value;
                this.expect("]");
                if (!Number.isInteger(arraySize) || arraySize !== -1 && arraySize < 1 || arraySize > MAX_PROGRAM_BINDINGS)
                    throw new ARBError("invalid parameter array size", this.line);
            }
            this.expect("=");
            const items = [];
            if (this.accept("{")) {
                do { items.push(this.paramItem()); } while (this.accept(","));
                this.expect("}");
            } else {
                items.push(this.paramItem());
            }
            this.expect(";");

            let entries;
            if (!arraySize && items.every(item => item.kind === "number")) {
                const values = items.map(item => item.value);
                if (values.length > 4) throw new ARBError("a constant vector has more than four components", this.line);
                /*
                 * ARB program scalar constants are scalar vector initialisers:
                 *
                 *     PARAM half = 0.5;
                 *
                 * names { 0.5, 0.5, 0.5, 0.5 }, not the conventional GL
                 * vertex expansion { 0.5, 0, 0, 1 }.  glview's bump-map
                 * vertex program uses exactly that spelling for both operands
                 * of its final MAD; expanding it like a vertex made the DOT3
                 * combiner receive a mostly negative light vector and reduced
                 * the whole 1.4/1.5 test to the clear colour.
                 */
                if (values.length === 1) {
                    values.push(values[0], values[0], values[0]);
                } else {
                    while (values.length < 4)
                        values.push(values.length === 3 ? 1 : 0);
                }
                entries = [{ kind: "constant", values }];
            } else {
                entries = items.map(item => {
                    if (item.kind === "number")
                        return { kind: "constant",
                                 values: [item.value, item.value, item.value,
                                          item.value] };
                    if (item.kind === "vector") {
                        const values = item.values.slice();
                        if (values.length > 4) throw new ARBError("a constant vector has more than four components", this.line);
                        while (values.length < 4)
                            values.push(values.length === 3 ? 1 : 0);
                        return { kind: "constant", values };
                    }
                    if (!/^(state\.|program\.(env|local)\[)/.test(item.path)) throw new ARBError("invalid parameter binding", this.line);
                    return { kind: "binding", path: item.path };
                });
                // program.local[0..4]: one register a parameter (S2-48)
                entries = entries.flatMap(entry => {
                    const range = entry.kind === "binding" && /^(.*)\[(\d+)\.\.(\d+)\]$/.exec(entry.path);
                    if (!range) return [entry];
                    if (+range[3] < +range[2] || +range[3] - +range[2] >= MAX_PROGRAM_BINDINGS)
                        throw new ARBError("invalid parameter range", this.line);
                    const out = [];
                    for (let i = +range[2]; i <= +range[3]; ++i)
                        out.push({ kind: "binding", path: range[1] + "[" + i + "]" });
                    return out;
                });
            }
            this.params.set(name, { arraySize, entries });
        }

        paramItem() {
            if (this.accept("{")) {
                const values = [];
                do { values.push(this.signedNumber()); } while (this.accept(","));
                this.expect("}");
                return { kind: "vector", values };
            }
            if (this.peek().type === "number" || this.at("-") || this.at("+"))
                return { kind: "number", value: this.signedNumber() };
            return { kind: "binding", path: this.bindingPath() };
        }

        signedNumber() {
            let sign = 1;
            while (this.at("-") || this.at("+")) {
                if (this.next().value === "-") sign = -sign;
            }
            const token = this.next();
            if (token.type !== "number")
                throw new ARBError("expected a number", token.line);
            return sign * token.value;
        }

        instruction() {
            const token = this.next();
            let opcode = token.value;
            let saturate = false;
            if (opcode.endsWith("_SAT")) {
                saturate = true;
                opcode = opcode.slice(0, -4);
            }
            const info = INSTRUCTIONS[opcode];
            if (!info)
                throw new ARBError("unknown instruction '" + opcode + "'",
                    token.line);
            if (info.vertexOnly && this.target !== "vertex")
                throw new ARBError(opcode + " is vertex-program only", token.line);
            if (info.fragmentOnly && this.target !== "fragment")
                throw new ARBError(opcode + " is fragment-program only", token.line);

            const instruction = { opcode, info, saturate, line: token.line,
                                  at: token.at, sources: [] };
            if (!info.kill) {
                instruction.destination = this.destination();
                this.expect(",");
            }
            const sourceCount = info.sources;
            for (let i = 0; i < sourceCount; ++i) {
                instruction.sources.push(this.source());
                if (i + 1 < sourceCount) this.expect(",");
            }
            if (info.extendedSwizzle) instruction.extendedSwizzle = this.extendedSwizzle();
            if (info.texture) {
                this.expect(",");
                instruction.texture = this.bindingPath();       // texture[n]
                this.expect(",");
                // "2D" lexes as a number followed by an identifier, so the
                // target is read as raw tokens up to the terminator.
                let target = "";
                while (!this.at(";") && this.peek().type !== "eof")
                    target += String(this.next().value);
                instruction.textureTarget = target;
            }
            this.expect(";");
            this.instructions.push(instruction);
        }

        /*
         * A constant written in an instruction, `MUL r, r, 2.0;` or
         * `MOV r, {0, 0, 0, 1};`, as an anonymous PARAM (review S2-48: the
         * parser wanted a name). A scalar stands for all four components; a
         * short vector is filled out with 0 and a w of 1.
         */
        inlineConstant() {
            const item = this.paramItem();
            const values = item.kind === "vector" ? item.values.slice() :
                [item.value, item.value, item.value, item.value];
            if (values.length > 4) throw new ARBError("a constant vector has more than four components", this.line);
            while (values.length < 4) values.push(values.length === 3 ? 1 : 0);
            const name = "$constant" + this.params.size;
            this.params.set(name, { arraySize: 0, entries: [{ kind: "constant", values }] });
            return name;
        }

        // (each operand keeps where it starts: the generator's errors about
        // it report that position)
        destination() {
            const at = this.peek().at;
            const name = this.bindingPath(true);
            let mask = "xyzw";
            if (this.accept(".")) mask = normalizeMask(this.expectIdent());
            if (!/^(?=.+)x?y?z?w?$/.test(mask)) throw new ARBError("invalid destination mask", this.line);
            return { name, mask, line: this.line, at };
        }

        /*
         * SWZ's four components after the source, `x,-y,0,1`: each a source
         * component or 0 or 1, each with its own sign (review S2-48: read as
         * a dotted swizzle).
         */
        extendedSwizzle() {
            const components = [];
            for (let i = 0; i < 4; ++i) {
                this.expect(",");
                let negate = false;
                while (this.at("-") || this.at("+"))
                    if (this.next().value === "-") negate = !negate;
                const token = this.next();
                let component = String(token.value);
                if (token.type === "number" && token.value < 0) {
                    negate = !negate;
                    component = String(-token.value);
                }
                if (!/^(?:[01]|[xyzwrgba])$/.test(component))
                    throw new ARBError("'" + component + "' is not an extended swizzle component", token.line);
                components.push({ negate, component });
            }
            return components;
        }

        source() {
            let negate = false;
            let absolute = false;
            while (this.at("-") || this.at("+")) {
                if (this.next().value === "-") negate = !negate;
            }
            if (this.accept("|")) absolute = true;
            const at = this.peek().at;
            const name = this.at("{") || this.peek().type === "number" ?
                this.inlineConstant() : this.bindingPath(true);
            let swizzle = null;
            if (this.accept(".")) swizzle = String(this.next().value);
            if (swizzle && !/^[xyzwrgba]{1,4}$/.test(swizzle)) throw new ARBError("invalid source swizzle", this.line);
            if (absolute) this.expect("|");
            return { name, swizzle, negate, absolute, line: this.line, at };
        }
    }

    /* ================================================================== */
    /* Generator                                                          */
    /* ================================================================== */

    class Generator {
        constructor(parsed, options) {
            this.parsed = parsed;
            this.options = options || {};
            this.stage = parsed.target;
            this.lines = [];
            this.helpers = new Set();
            this.stateFields = new Set();
            this.constants = [];          // local PARAM constants, inlined
            this.paramArrays = new Map();
            this.registerArrays = new Map();   // relative addressing, by array name
            this.usedAttributes = new Map();
            this.usedResults = new Set();
            this.textureUnits = new Map();  // unit -> target
            this.usesKill = false;
            this.usesAddress = false;
            this.envUsed = false;
            this.localUsed = false;
            this.parameterBindings = new Set();
            this.inputBindings = new Set();
            this.resolvingSources = new Set();
            this.relativeArrays = new Set();
            this.relativeStates = new Set();
            this.relativeConstants = new Set();
            this.relativeConstantCopies = 0;
            this.temporary = 0;
            for (const param of parsed.params.values()) {
                const count = param.entries.reduce((n, entry) => n + (entry.kind === "binding" &&
                    this.stateMatrix(entry.path.replace(/^state\./, "")) ? 4 : 1), 0);
                if (param.arraySize > 0 && param.arraySize !== count || !param.arraySize && count !== 1)
                    throw new ARBError("parameter array size does not match its initializer", 0);
                for (const entry of param.entries)
                    if (entry.kind === "binding" && !this.stateMatrix(entry.path.replace(/^state\./, ""))) this.resolveSource(entry.path);
            }
            for (const name of parsed.attribs.keys()) this.resolveSource(name);
            for (const name of parsed.outputs.keys()) this.resolveDestination({ name, mask: "xyzw", line: 0 });
            this.stateFields.clear(); this.usedAttributes.clear(); this.usedResults.clear();
            this.envUsed = this.localUsed = false;
            // Declared here rather than where it is emitted: the state layout
            // is built before the shell, so a field added later would not be
            // in the struct the shell then reads from.
            if (parsed.options.has("ARB_position_invariant")) {
                this.stateFields.add("mvp");
                if (this.options.vertexCapture) this.stateFields.add("modelview");
                this.useAttribute("vertex.position",
                    VERTEX_ATTRIBUTES["vertex.position"]);
            }
        }

        emit(text) { this.lines.push(text); }

        generate() {
            const body = [];
            for (const instruction of this.parsed.instructions)
                body.push(...this.located(instruction, () => this.instruction(instruction)));
            if (this.parsed.instructions.length > 4096) throw new ARBError("too many program instructions", 0);
            if (this.parsed.addresses.size > MAX_ADDRESS_REGISTERS) throw new ARBError("too many address registers", 0);
            if (this.parameterCount() > MAX_PROGRAM_BINDINGS)
                throw new ARBError("too many parameter bindings", 0);

            // WebGPU validates the inter-stage interface strictly. Desktop GL
            // leaves an unwritten ARB vertex result undefined, so when a
            // fixed-function fragment stage consumes an enabled unit we
            // materialise its missing output using this shell's existing zero
            // value for undefined results.
            if (this.stage === "vertex") {
                if (this.options.vertexCapture) this.usedResults.add("texcoord0");
                if (this.options.vertexCaptureRaster) for (let i = 1; i < 8; ++i) this.usedResults.add("texcoord" + i);
                for (const unit of this.options.forceVertexTexCoords || []) {
                    if (unit >= 0 && unit < MAX_TEXTURE_UNITS)
                        this.usedResults.add("texcoord" + unit);
                }
            }
            // Both stages share one compact GLState uniform. Supplying the
            // union makes the canonical field offsets identical in each WGSL
            // module even when the stages read different pieces of GL state.
            for (const field of this.options.forceStateFields || [])
                this.stateFields.add(field);
            if (this.stage === "fragment" && this.fogMode()) {
                this.stateFields.add("fogParams");
                this.stateFields.add("fogColor");
            }

            if (this.textureUnits.size) this.stateFields.add("samplerState");
            const out = [];
            out.push("diagnostic(off, derivative_uniformity);");
            out.push("// generated by gl_arb_program.js r" + ARB_REVISION +
                " (" + this.stage + " program)");
            out.push("");
            const layout = stateLayout.buildLayout([...this.stateFields]);
            if (this.stateFields.size) {
                out.push(layout.structText);
                out.push("@group(1) @binding(0) var<uniform> glState : GLState;");
                out.push("");
            }
            /*
             * program.env and program.local share one binding: they have the
             * same shape and the guest writes both through the same entry
             * point.  Do not declare the binding when neither namespace is
             * read.  WebGPU's automatic pipeline layout drops unused globals;
             * retaining the declaration here made the executor submit a
             * binding which was absent from the resulting layout.
             *
             * The two stages take *different* bindings because program.env and
             * program.local are per-program namespaces: a bound vertex and
             * fragment program each carry their own, and a single shared block
             * left one stage reading the other program's parameters.
             */
            if (this.envUsed || this.localUsed) {
                out.push("struct ARBParams {");
                out.push("    env : array<vec4<f32>, " +
                    MAX_PROGRAM_PARAMETERS + ">,");
                out.push("    local : array<vec4<f32>, " +
                    MAX_PROGRAM_PARAMETERS + ">,");
                out.push("}");
                out.push("@group(1) @binding(" +
                    PARAMETER_BINDING[this.stage] +
                    ") var<uniform> arbParams : ARBParams;");
                out.push("");
            }
            for (const [unit, target] of this.textureUnits) {
                out.push("@group(2) @binding(" + (unit * 2) + ") var t" + unit +
                    " : " + wgslTextureType(target) + ";");
                out.push("@group(2) @binding(" + (unit * 2 + 1) + ") var s" +
                    unit + " : " + (target.startsWith("SHADOW") ? "sampler_comparison" : "sampler") + ";");
            }
            if (this.textureUnits.size) out.push("");
            for (const [unit, target] of this.textureUnits) out.push(stateLayout.textureSamplingWGSL("gl_arb_sample_" + unit,
                target === "CUBE" ? "Cube" : target === "3D" ? "3D" : "2D", target.startsWith("SHADOW"), "fragment"));
            for (const helper of this.helpers) out.push(HELPERS[helper], "");

            if (this.stage === "vertex") this.emitVertexShell(out, body);
            else this.emitFragmentShell(out, body);
            return out.join("\n") + "\n";
        }

        // the OPTION ARB_fog_* a fragment program asks for, or null
        fogMode() {
            const options = this.parsed.options;
            return options.has("ARB_fog_linear") ? "linear" : options.has("ARB_fog_exp") ? "exp" :
                options.has("ARB_fog_exp2") ? "exp2" : null;
        }

        emitVertexShell(out, body) {
            const capture = !!this.options.vertexCapture;
            const flatLocations = new Set(this.options.forceFlatVaryings || []);
            const varying = location => (flatLocations.has(location) ?
                "    @interpolate(flat) " : "    ") +
                "@location(" + location + ") ";
            out.push("struct VSIn {");
            for (const [, info] of this.usedAttributes)
                out.push("    " + (capture ? "" : "@location(" + info.location + ") ") + info.field +
                    " : " + vecType(info.components || 4) + ",");
            if (!this.usedAttributes.size)
                out.push("    " + (capture ? "" : "@builtin(vertex_index) ") + "vertexIndex : u32,");
            out.push("}");
            out.push("");
            if (capture) {
                out.push(translator.vertexCaptureBindings(this.options.vertexCaptureRaster));
                out.push("@compute @workgroup_size(" + translator.VERTEX_CAPTURE.workgroupSize + ")");
                out.push("fn capture_main(@builtin(global_invocation_id) id : vec3<u32>) {");
                out.push("    if (id.x >= arrayLength(&glCaptureOutput)) { return; }");
                out.push("    var vin : VSIn;");
                for (const [, info] of this.usedAttributes)
                    out.push("    vin." + info.field + " = glCaptureInput[id.x].attributes[" + info.location + "]." + "xyzw".slice(0, info.components || 4) + ";");
            } else {
            out.push("struct VSOut {");
            out.push("    @invariant @builtin(position) position : vec4<f32>,");
            out.push(varying(0) + "frontColor : vec4<f32>,");
            out.push(varying(1) + "frontSecondary : vec4<f32>,");
            out.push(varying(2) + "fogCoord : vec4<f32>,");
            for (let i = 0; i < 8; ++i)
                if (this.usedResults.has("texcoord" + i))
                    out.push(varying(3 + i) + "texcoord" + i +
                        " : vec4<f32>,");
            out.push("}");
            out.push("");
            out.push("@vertex");
            out.push("fn vs_main(vin : VSIn) -> VSOut {");
            }
            out.push("    var result_position = vec4<f32>(0.0, 0.0, 0.0, 1.0);");
            out.push("    var frontColor = vec4<f32>(1.0);");
            out.push("    var frontSecondary = vec4<f32>(0.0);");
            out.push("    var backColor = vec4<f32>(1.0);");
            out.push("    var backSecondary = vec4<f32>(0.0);");
            out.push("    var fogCoordValue = vec4<f32>(0.0);");
            out.push("    var pointSize = vec4<f32>(1.0);");
            for (let i = 0; i < 8; ++i)
                if (this.usedResults.has("texcoord" + i))
                    out.push("    var texcoord" + i + " = vec4<f32>(0.0);");
            for (const name of this.parsed.temporaries)
                out.push("    var " + safe(name) + " = vec4<f32>(0.0);");
            for (const name of this.parsed.addresses)
                out.push("    var " + safe(name) + " = vec4<i32>(0);");
            for (const declaration of this.registerArrays.values()) out.push("    " + declaration);
            for (const line of body) out.push("    " + line);
            if (this.parsed.options.has("ARB_position_invariant")) {
                // The option says the program does not write result.position
                // and the fixed-function transform supplies it -- and it must
                // be the *same* expression, or a depth pre-pass z-fights.
                out.push("    result_position = glState.mvp * vin.gl_Vertex;");
            }
            if (capture) {
                out.push("    glCaptureOutput[id.x].clip = result_position;");
                out.push("    glCaptureOutput[id.x].color = saturate(frontColor);");
                out.push("    glCaptureOutput[id.x].backColor = saturate(backColor);");
                out.push("    glCaptureOutput[id.x].tex = texcoord0;");
                // ARB_vertex_program 2.11 disables user clip planes unless
                // ARB_position_invariant supplies the fixed transformation.
                out.push("    glCaptureOutput[id.x].eye = " + (this.parsed.options.has("ARB_position_invariant") ?
                    "glState.modelview * vin.gl_Vertex" : "vec4<f32>(0.0)") + ";");
                if (this.options.vertexCaptureRaster) {
                    out.push("    glCaptureOutput[id.x].secondary = saturate(frontSecondary);");
                    out.push("    glCaptureOutput[id.x].fog = fogCoordValue;");
                    for (let i = 1; i < 8; ++i) out.push("    glCaptureOutput[id.x].texExtra[" + (i - 1) + "] = texcoord" + i + ";");
                }
                out.push("}");
                return;
            }
            out.push("    var out : VSOut;");
            out.push("    var clip = result_position;");
            out.push("    clip.z = (clip.z + clip.w) * 0.5;");
            out.push("    clip.y = -clip.y;");
            out.push("    out.position = clip;");
            // (colours are clamped to [0, 1] before they are interpolated)
            out.push("    out.frontColor = saturate(frontColor);");
            out.push("    out.frontSecondary = saturate(frontSecondary);");
            out.push("    out.fogCoord = fogCoordValue;");
            for (let i = 0; i < 8; ++i)
                if (this.usedResults.has("texcoord" + i))
                    out.push("    out.texcoord" + i + " = texcoord" + i + ";");
            out.push("    return out;");
            out.push("}");
        }

        emitFragmentShell(out, body) {
            out.push("struct FSIn {");
            out.push("    @builtin(position) position : vec4<f32>,");
            out.push("    @location(0) frontColor : vec4<f32>,");
            out.push("    @location(1) frontSecondary : vec4<f32>,");
            out.push("    @location(2) fogCoord : vec4<f32>,");
            for (let i = 0; i < 8; ++i)
                if (this.usedResults.has("in_texcoord" + i))
                    out.push("    @location(" + (3 + i) + ") texcoord" + i +
                        " : vec4<f32>,");
            out.push("}");
            out.push("");
            out.push("struct FSOut {");
            out.push("    @location(0) color0 : vec4<f32>,");
            if (this.usedResults.has("depth"))
                out.push("    @builtin(frag_depth) depth : f32,");
            out.push("}");
            out.push("");
            out.push("@fragment");
            out.push("fn fs_main(fin : FSIn) -> FSOut {");
            out.push("    var color0 = vec4<f32>(0.0, 0.0, 0.0, 1.0);");
            out.push("    var depthValue = fin.position.z;");
            for (const name of this.parsed.temporaries)
                out.push("    var " + safe(name) + " = vec4<f32>(0.0);");
            for (const line of body) out.push("    " + line);
            const fog = this.fogMode();
            if (fog) {
                // OPTION ARB_fog_*: the fixed fog after the program, from
                // fragment.fogcoord (review S2-50: ignored)
                const c = "fin.fogCoord.x";
                const factor = fog === "linear" ? "(glState.fogParams.z - " + c + ") * glState.fogParams.w" :
                    fog === "exp" ? "exp(-glState.fogParams.x * " + c + ")" :
                        "exp(-(glState.fogParams.x * " + c + ") * (glState.fogParams.x * " + c + "))";
                out.push("    color0 = vec4<f32>(mix(glState.fogColor.rgb, color0.rgb, clamp(" + factor +
                    ", 0.0, 1.0)), color0.a);");
            }
            out.push("    var out : FSOut;");
            out.push("    out.color0 = color0;");
            if (this.usedResults.has("depth"))
                out.push("    out.depth = depthValue;");
            out.push("    return out;");
            out.push("}");
        }

        instruction(instruction) {
            const info = instruction.info;
            const lines = [];

            if (info.kill) {
                const source = this.sourceExpression(instruction.sources[0]);
                lines.push("if (any(" + source + " < vec4<f32>(0.0))) { discard; }");
                this.usesKill = true;
                return lines;
            }

            let value;
            if (instruction.extendedSwizzle) {
                const source = this.sourceExpression(instruction.sources[0]);
                value = "vec4<f32>(" + instruction.extendedSwizzle.map(({ negate, component }) => {
                    const c = component === "0" ? "0.0" : component === "1" ? "1.0" :
                        "(" + source + ")." + "xyzw"["xyzwrgba".indexOf(component) % 4];
                    return negate ? "-(" + c + ")" : c;
                }).join(", ") + ")";
            } else if (info.texture) {
                value = this.textureInstruction(instruction);
            } else if (info.address) {
                const source = this.sourceExpression(instruction.sources[0]);
                const target = this.resolveDestination(instruction.destination);
                if (!target.address || !["x", "xyzw"].includes(instruction.destination.mask)) throw new ARBError("ARL must write an address register's x component", instruction.line);
                this.usesAddress = true;
                lines.push(target.name + " = vec4<i32>(i32(floor(" + source +
                    ".x)));");
                return lines;
            } else {
                const sources = instruction.sources.map(source =>
                    this.sourceExpression(source));
                value = info.emit(sources);
                if (info.emit === HELPERS.arbLit) this.helpers.add("arbLit");
            }
            if (instruction.opcode === "LIT") this.helpers.add("arbLit");
            if (instruction.opcode === "LOG") this.helpers.add("arbLog");
            if (instruction.saturate)
                value = "clamp(" + value + ", vec4<f32>(0.0), vec4<f32>(1.0))";

            const destination = this.resolveDestination(instruction.destination);
            if (destination.address) throw new ARBError("only ARL can write an address register", instruction.line);
            const mask = instruction.destination.mask;
            if (destination.name === "depthValue") {
                // result.depth is a scalar: its z component is the depth
                // (review S2-49: .z and whole writes made invalid WGSL)
                if (mask === "" || mask.includes("z")) lines.push("depthValue = (" + value + ").z;");
            } else if (mask === "xyzw" || mask === "") {
                lines.push(destination.name + " = " + value + ";");
            } else {
                const temporary = "_a" + (this.temporary++);
                lines.push("let " + temporary + " = " + value + ";");
                for (const component of mask)
                    lines.push(destination.name + "." + component + " = " +
                        temporary + "." + component + ";");
            }
            return lines;
        }

        textureInstruction(instruction) {
            const unit = this.textureUnit(instruction.texture);
            const target = normalizeTextureTarget(instruction.textureTarget);
            this.textureUnits.set(unit, target);
            const source = this.sourceExpression(instruction.sources[0]);
            const shadow = target.startsWith("SHADOW"), one = target === "1D" || target === "SHADOW1D",
                triple = target === "CUBE" || target === "3D", projected = instruction.info.texture === "proj",
                bias = instruction.info.texture === "bias" ? "(" + source + ").w" : "0.0",
                q = projected ? " / (" + source + ").w" : "",
                coordinate = one ? "vec2<f32>((" + source + ").x" + q + ", 0.5)" :
                    "(" + source + ")." + (triple ? "xyz" : "xy") + q,
                call = "gl_arb_sample_" + unit + "(t" + unit + ", s" + unit + ", " + coordinate + ", " + unit +
                    "u, 0.0, " + bias + ", false" + (shadow ? ", (" + source + ").z" + q : "") + ")";
            return shadow ? "vec4<f32>(vec3<f32>(" + call + "), 1.0)" : call;
        }

        textureUnit(path) {
            const match = /^texture\[(\d+)\]$/.exec(path) ||
                /^texture$/.exec(path);
            if (!match) throw new ARBError("unknown texture '" + path + "'", 0);
            const unit = match[1] ? parseInt(match[1], 10) : 0;
            if (unit < 0 || unit >= MAX_TEXTURE_UNITS)
                throw new ARBError("texture unit " + unit + " is out of range", 0);
            return unit;
        }

        // An error from fn without a position of its own is at `operand`
        located(operand, fn) {
            try {
                return fn();
            } catch (error) {
                if (error instanceof ARBError && error.arbOffset < 0 && operand.at !== undefined) {
                    error.arbOffset = operand.at;
                    if (!error.arbLine) error.arbLine = operand.line;
                }
                throw error;
            }
        }

        sourceExpression(source) {
            let text = this.located(source, () => this.resolveSource(source.name));
            this.recordBindings(source.name, text);
            if (source.swizzle) text = applySwizzle(text, source.swizzle);
            if (source.absolute) text = "abs(" + text + ")";
            if (source.negate) text = "(-(" + text + "))";
            return text;
        }

        resolveSource(name) {
            if (this.resolvingSources.has(name)) throw new ARBError("cyclic source alias '" + name + "'", 0);
            this.resolvingSources.add(name);
            try { return this.resolveSourceValue(name); }
            finally { this.resolvingSources.delete(name); }
        }

        recordBindings(name, expression) {
            while (this.parsed.aliases.has(name) || this.parsed.attribs.has(name))
                name = this.parsed.aliases.get(name) || this.parsed.attribs.get(name);
            const indexed = /^([A-Za-z_$][A-Za-z0-9_$]*)\[(.+)\]$/.exec(name);
            if (indexed && this.parsed.params.has(indexed[1]) && !/^\d+$/.test(indexed[2].trim())) {
                const array = indexed[1];
                if (!this.relativeArrays.has(array)) {
                    this.relativeArrays.add(array);
                    for (const value of this.paramRegisters(array)) {
                        this.parameterBindings.add(value);
                        if (/^vec4<f32>\([0-9+eE., \-]+\)$/.test(value)) {
                            this.relativeConstants.add(value); ++this.relativeConstantCopies;
                        } else {
                            if (this.relativeStates.has(value)) throw new ARBError("state bound twice in relatively addressed arrays", 0);
                            this.relativeStates.add(value);
                        }
                    }
                }
            } else if (name.startsWith("program.") || name.startsWith("state.") || this.parsed.params.has(name) ||
                    indexed && this.parsed.params.has(indexed[1])) {
                const relative = /^program\.(env|local)\[(.+)\]$/.exec(name);
                if (relative && !/^\d+$/.test(relative[2].trim())) {
                    for (let i = 0; i < parameterLimit(this.stage); ++i)
                        this.parameterBindings.add("arbParams." + relative[1] + "[" + i + "]");
                } else this.parameterBindings.add(expression);
            }
            if (name.startsWith("fragment.")) this.inputBindings.add(expression);
        }

        parameterCount() {
            return this.parameterBindings.size + this.relativeConstantCopies - this.relativeConstants.size;
        }

        resolveSourceValue(name) {
            const alias = this.parsed.aliases.get(name);
            if (alias) return this.resolveSource(alias);

            // A PARAM array element: `PARAM mvp[4] = { state.matrix.mvp };`
            // then `DP4 r0.x, mvp[0], pos;`. The matrix expands to its four
            // rows, which is the whole reason the canonical transform is
            // written as four DP4s.
            const indexed = /^([A-Za-z_$][A-Za-z0-9_$]*)\[(.+)\]$/.exec(name);
            if (indexed && this.parsed.params.has(indexed[1])) {
                const registers = this.paramRegisters(indexed[1]);
                const index = /^\s*(\d+)\s*$/.exec(indexed[2]);
                if (!index) {
                    // relative addressing, A0.x + k (review S2-48): the
                    // registers as an array the address register indexes,
                    // out of range reading as zero
                    const relative = this.relativeIndex(indexed[2]);
                    this.usesAddress = true;
                    const array = safe(indexed[1]) + "_registers";
                    if (!this.registerArrays.has(array))
                        this.registerArrays.set(array, "var " + array + " = array<vec4<f32>, " +
                            (registers.length + 1) + ">(" + registers.join(", ") + ", vec4<f32>(0.0));");
                    return array + "[select(" + registers.length + ", " + relative + ", " + relative +
                        " >= 0 && " + relative + " < " + registers.length + ")]";
                }
                const at = parseInt(index[1], 10);
                if (at >= registers.length)
                    throw new ARBError("PARAM " + indexed[1] + "[" + at +
                        "] is past the end of the array", 0);
                return registers[at];
            }

            if (this.parsed.temporaries.has(name)) return safe(name);
            if (this.parsed.addresses.has(name)) return safe(name);
            const attrib = this.parsed.attribs.get(name);
            if (attrib) return this.resolveSource(attrib);
            const param = this.parsed.params.get(name);
            if (param) return this.resolveParam(name, param);

            // program.env[n] / program.local[n], with optional relative
            // addressing through the address register.
            const parameter = /^program\.(env|local)\[(.+)\]$/.exec(name);
            if (parameter) {
                const which = parameter[1];
                if (which === "env") this.envUsed = true; else this.localUsed = true;
                return "arbParams." + which + "[" +
                    this.parameterIndex(parameter[2]) + "]";
            }
            if (name.startsWith("state."))
                return this.resolveState(name.slice(6));
            if (this.stage === "vertex") {
                const attribute = VERTEX_ATTRIBUTES[name];
                if (attribute) return this.useAttribute(name, attribute);
                const texcoord = /^vertex\.texcoord\[?(\d*)\]?$/.exec(name);
                if (texcoord) {
                    const unit = texcoord[1] ? parseInt(texcoord[1], 10) : 0;
                    return this.useAttribute(name, {
                        name: "gl_MultiTexCoord" + unit,
                        location: ATTR.gl_MultiTexCoord0 + unit,
                    });
                }
                const generic = /^vertex\.attrib\[(\d+)\]$/.exec(name);
                if (generic) {
                    const index = parseInt(generic[1], 10);
                    return this.useAttribute(name, {
                        name: "attrib" + index, location: index,
                    });
                }
            } else {
                if (name === "fragment.color" || name === "fragment.color.primary")
                    return "fin.frontColor";
                if (name === "fragment.color.secondary") return "fin.frontSecondary";
                if (name === "fragment.fogcoord") return "fin.fogCoord";
                if (name === "fragment.position") return "fin.position";
                const texcoord = /^fragment\.texcoord\[?(\d*)\]?$/.exec(name);
                if (texcoord) {
                    const unit = texcoord[1] ? parseInt(texcoord[1], 10) : 0;
                    if (unit >= MAX_TEXTURE_UNITS) throw new ARBError("texture coordinate is out of range", 0);
                    this.usedResults.add("in_texcoord" + unit);
                    return "fin.texcoord" + unit;
                }
            }
            throw new ARBError("unknown source '" + name + "'", 0);
        }

        parameterIndex(text) {
            const numeric = /^\d+$/.exec(text.trim());
            if (numeric) {
                const index = parseInt(numeric[0], 10);
                if (index >= parameterLimit(this.stage))
                    throw new ARBError("program parameter " + index +
                        " is beyond the " + parameterLimit(this.stage) +
                        " this implementation provides", 0);
                return String(index);
            }
            // Relative addressing: A0.x + k. WGSL indexes uniform arrays
            // dynamically, so this maps straight across.
            this.usesAddress = true;
            return "clamp(" + this.relativeIndex(text) + ", 0, " + (parameterLimit(this.stage) - 1) + ")";
        }

        relativeIndex(text) {
            const index = addressIndex(text), name = /^([A-Za-z_$][A-Za-z0-9_$]*)\.x(?:[+-]\d+)?$/.exec(text.replace(/\s+/g, ""));
            if (!name || !this.parsed.addresses.has(name[1])) throw new ARBError("relative access needs a declared address register's x component", 0);
            return index;
        }

        /* Flattens a PARAM declaration into the registers it occupies. */
        paramRegisters(name) {
            if (this.paramArrays.has(name)) return this.paramArrays.get(name);
            const param = this.parsed.params.get(name);
            const registers = [];
            for (const entry of param.entries) {
                if (entry.kind === "constant") {
                    registers.push("vec4<f32>(" +
                        entry.values.map(formatFloat).join(", ") + ")");
                    continue;
                }
                const path = entry.path.startsWith("state.") ?
                    entry.path.slice(6) : entry.path;
                const matrix = this.stateMatrix(path);
                if (matrix) {
                    this.stateFields.add(matrix.field);
                    for (let row = 0; row < 4; ++row)
                        registers.push("vec4<f32>(" + [0, 1, 2, 3].map(column =>
                            matrix.matrix + "[" + column + "][" + row + "]")
                            .join(", ") + ")");
                    continue;
                }
                registers.push(this.resolveSource(entry.path));
            }
            this.paramArrays.set(name, registers);
            return registers;
        }

        /* The matrix behind a state.matrix.* binding, or null if the path is
         * not a whole matrix. */
        stateMatrix(path) {
            path = normalizeStatePath(path);
            const binding = STATE_BINDINGS[path] || arrayMatrixBinding(path);
            return binding && binding.matrix ? binding : null;
        }

        resolveParam(name, param) {
            if (param.entries.length === 1 &&
                    param.entries[0].kind === "constant" && !param.arraySize) {
                const values = param.entries[0].values;
                return "vec4<f32>(" + values.map(formatFloat).join(", ") + ")";
            }
            if (param.entries.length === 1 &&
                    param.entries[0].kind === "binding" && !param.arraySize)
                return this.resolveSource(param.entries[0].path);
            // Naming a PARAM array without an index means its first register,
            // which is how a program written for one row spells it.
            return this.paramRegisters(name)[0];
        }

        resolveState(path) {
            path = normalizeStatePath(path);
            const direct = STATE_BINDINGS[path] || arrayMatrixBinding(path);
            if (direct) {
                this.stateFields.add(direct.field);
                if (direct.vector) return direct.vector;
                // A matrix binding without a row selector means row 0; the
                // usual spelling is state.matrix.mvp[i] via a PARAM array.
                return "vec4<f32>(" + direct.matrix + "[0][0], " +
                    direct.matrix + "[1][0], " + direct.matrix + "[2][0], " +
                    direct.matrix + "[3][0])";
            }
            const row = /^(matrix\..*?)\.row\[(\d+)\]$/.exec(path);
            if (row) {
                const binding = STATE_BINDINGS[row[1]] || arrayMatrixBinding(row[1]);
                if (binding && binding.matrix) {
                    this.stateFields.add(binding.field);
                    const index = parseInt(row[2], 10);
                    if (index > 3) throw new ARBError("matrix row is out of range", 0);
                    // ARB rows are the matrix's rows; WGSL indexes columns, so
                    // the row is gathered rather than indexed.
                    return "vec4<f32>(" + [0, 1, 2, 3].map(c =>
                        binding.matrix + "[" + c + "][" + index + "]").join(", ") + ")";
                }
            }
            for (const entry of INDEXED_STATE) {
                const match = entry.pattern.exec(path);
                if (!match) continue;
                const max = { lights: 8, frontLightProduct: 8, backLightProduct: 8, texEnvColor: 8, clipPlanes: 6, texGenPlanes: 8 }[entry.field];
                if (+match[1] >= max) throw new ARBError("state index is out of range", 0);
                this.stateFields.add(entry.field);
                return entry.expr(match[1], match[2], match[3]);
            }
            throw new ARBError("unsupported state binding 'state." + path + "'", 0);
        }

        useAttribute(path, info) {
            if (info.location < 0 || info.location >= 16) throw new ARBError("vertex attribute is out of range", 0);
            const field = info.name;
            if (!this.usedAttributes.has(field))
                this.usedAttributes.set(field, {
                    field, location: info.location,
                    components: info.components || 4,
                });
            void path;
            const components = info.components || 4;
            if (components === 4) return "vin." + field;
            if (components === 3) return "vec4<f32>(vin." + field + ", 1.0)";
            return "vec4<f32>(vin." + field + ", 0.0, 0.0, 1.0)";
        }

        resolveDestination(destination) {
            return this.located(destination, () => this.resolveDestinationName(destination));
        }

        resolveDestinationName(destination) {
            const name = destination.name;
            const alias = this.parsed.aliases.get(name);
            if (alias) return this.resolveDestination({ ...destination, name: alias });
            if (this.parsed.temporaries.has(name)) return { name: safe(name) };
            if (this.parsed.addresses.has(name)) return { name: safe(name), address: true };
            const output = this.parsed.outputs.get(name);
            if (output) return this.resolveDestination({ ...destination, name: output });

            if (this.stage === "vertex") {
                const texcoord = /^result\.texcoord\[?(\d*)\]?$/.exec(name);
                if (texcoord) {
                    const unit = texcoord[1] ? parseInt(texcoord[1], 10) : 0;
                    if (unit >= MAX_TEXTURE_UNITS) throw new ARBError("texture coordinate result is out of range", 0);
                    this.usedResults.add("texcoord" + unit);
                    return { name: "texcoord" + unit };
                }
                const mapped = VERTEX_RESULTS[name];
                if (mapped) {
                    this.usedResults.add(mapped);
                    if (mapped === "position") return { name: "result_position" };
                    if (mapped === "fogCoord") return { name: "fogCoordValue" };
                    return { name: mapped };
                }
            } else {
                const indexed = /^result\.color\[(\d+)\]$/.exec(name);
                if (indexed && indexed[1] === "0") return { name: "color0" };
                const mapped = FRAGMENT_RESULTS[name];
                if (mapped) {
                    this.usedResults.add(mapped);
                    return { name: mapped === "depth" ? "depthValue" : mapped };
                }
            }
            throw new ARBError("unknown destination '" + name + "'",
                destination.line);
        }
    }

    /* GL writes masks in xyzw or rgba; the generator only speaks xyzw. */
    /*
     * The spellings ARB_vertex_program allows for one binding, reduced to the
     * table's (review S2-48): matrix.modelview[0] is the modelview (it was
     * read as row 0), matrix.texture the unit's 0, lightprod and material
     * name a face, texgen without an index is unit 0's.
     */
    function normalizeStatePath(path) {
        return path
            .replace(/^matrix\.modelview\[0\]/, "matrix.modelview")
            .replace(/^matrix\.texture(?!\[)/, "matrix.texture[0]")
            .replace(/^lightprod\[(\d+)\]\.front\./, "lightprod[$1].")
            .replace(/^material\.front\./, "material.")
            .replace(/^texgen\.(eye|object)\./, "texgen[0].$1.");
    }

    // Program and texture state share the same row/modifier grammar. The
    // inverse variants are computed by the renderer, since WGSL has no inverse.
    function arrayMatrixBinding(path) {
        const match = /^matrix\.(texture|program)\[(\d+)\](?:\.(inverse|transpose|invtrans))?$/.exec(path);
        if (!match || +match[2] >= (match[1] === "program" ? stateLayout.MAX_PROGRAM_MATRICES : MAX_TEXTURE_UNITS)) return null;
        const suffix = { inverse: "Inverse", transpose: "Transpose", invtrans: "InverseTranspose" }[match[3]] || "";
        const field = match[1] + "Matrix" + suffix;
        return { field, matrix: "glState." + field + "[" + match[2] + "]" };
    }

    // `A0.x`, `A0.x+3`, `A0.x-1` as a WGSL integer expression
    function addressIndex(text) {
        const relative = /^([A-Za-z_$][A-Za-z0-9_$]*)\.([xyzw])(?:([+-])(\d+))?$/.exec(text.replace(/\s+/g, ""));
        if (!relative)
            throw new ARBError("unsupported parameter index '" + text + "'", 0);
        return "(" + safe(relative[1]) + "." + relative[2] + (relative[3] ? " " + relative[3] + " " +
            relative[4] : "") + ")";
    }

    function normalizeMask(text) {
        return String(text).replace(/[rgba]/g,
            ch => "xyzw"["rgba".indexOf(ch)]);
    }

    function safe(name) {
        return "arb_" + name.replace(/[^A-Za-z0-9_]/g, "_");
    }

    function vecType(components) {
        return components === 1 ? "f32" : "vec" + components + "<f32>";
    }

    function formatFloat(value) {
        if (Number.isInteger(value)) return value.toFixed(1);
        return String(value);
    }

    function wgslTextureType(target) {
        if (target.startsWith("SHADOW")) return "texture_depth_2d";
        switch (target) {
        case "CUBE": return "texture_cube<f32>";
        case "3D": return "texture_3d<f32>";
        default: return "texture_2d<f32>";
        }
    }

    function normalizeTextureTarget(text) {
        const upper = String(text).toUpperCase();
        if (upper.startsWith("SHADOW")) return upper.indexOf("RECT") >= 0 ? "SHADOWRECT" :
            upper.indexOf("1D") >= 0 ? "SHADOW1D" : "SHADOW2D";
        if (upper.indexOf("CUBE") >= 0) return "CUBE";
        if (upper.indexOf("3D") >= 0) return "3D";
        if (upper.indexOf("1D") >= 0) return "1D";
        if (upper.indexOf("RECT") >= 0) return "RECT";
        return "2D";
    }

    /* ARB swizzles are one to four components, and a single component
     * replicates -- MOV r0, c0.x moves x into all four. */
    function applySwizzle(expression, swizzle) {
        const cleaned = swizzle.replace(/[^xyzwrgba01]/g, "")
            .replace(/[rgba]/g, ch => "xyzw"["rgba".indexOf(ch)]);
        if (!cleaned.length) return expression;
        if (/[01]/.test(cleaned)) {
            const parts = [...cleaned].map(ch =>
                ch === "0" ? "0.0" : (ch === "1" ? "1.0" :
                    "(" + expression + ")." + ch));
            while (parts.length < 4) parts.push("0.0");
            return "vec4<f32>(" + parts.join(", ") + ")";
        }
        if (cleaned.length === 1)
            return "vec4<f32>((" + expression + ")." + cleaned + ")";
        if (cleaned.length === 4) return "(" + expression + ")." + cleaned;
        const parts = [...cleaned].map(ch => "(" + expression + ")." + ch);
        while (parts.length < 4) parts.push(parts[parts.length - 1]);
        return "vec4<f32>(" + parts.join(", ") + ")";
    }

    /* ================================================================== */
    /* Public API                                                         */
    /* ================================================================== */

    // ARB_fragment_program 3.11.6 counts sequential nodes, including a
    // write-after-ALU-read hazard, rather than just texture dataflow depth.
    function instructionCounts(parsed) {
        const written = new Set(), aluUsed = new Set();
        let texture = 0, indirections = 1;
        const temporary = operand => {
            let name = operand && operand.name;
            while (parsed.aliases.has(name)) name = parsed.aliases.get(name);
            return parsed.temporaries.has(name) ? name : null;
        };
        for (const instruction of parsed.instructions) {
            const isTexture = instruction.info.texture || instruction.opcode === "KIL";
            const dest = temporary(instruction.destination), sources = instruction.sources.map(temporary).filter(Boolean);
            if (isTexture) {
                ++texture;
                if (sources.some(name => written.has(name)) || dest && aluUsed.has(dest)) {
                    ++indirections; written.clear(); aluUsed.clear();
                }
            } else {
                for (const name of sources) aluUsed.add(name);
                if (dest) aluUsed.add(dest);
            }
            if (dest) written.add(dest);
        }
        return { textureInstructionCount: texture, aluInstructionCount: parsed.instructions.length - texture,
            textureIndirections: indirections };
    }

    function compileARBProgram(source, options) {
        const result = { ok: false, log: "", target: null, errorPosition: -1 };
        const parser = new Parser(source);
        try {
            const parsed = parser.parse();
            const generator = new Generator(parsed, options);
            result.wgsl = generator.generate();
            result.target = parsed.target;
            result.stage = parsed.target;
            result.reflection = {
                ...instructionCounts(parsed),
                stateFields: [...generator.stateFields],
                attributes: [...generator.usedAttributes.values()],
                textures: [...generator.textureUnits.entries()].map(
                    ([unit, target]) => ({ unit, target })),
                // the texture coordinates a fragment program reads
                fragmentTexCoords: [...generator.usedResults].filter(name => name.startsWith("in_texcoord"))
                    .map(name => Number(name.slice(11))).sort((a, b) => a - b),
                usesKill: generator.usesKill,
                usesAddress: generator.usesAddress,
                usesEnv: generator.envUsed,
                usesLocal: generator.localUsed,
                instructionCount: parsed.instructions.length,
                temporaryCount: parsed.temporaries.size,
                parameterCount: generator.parameterCount(),
                attributeCount: parsed.target === "vertex" ? new Set([...generator.usedAttributes.values()].map(a => a.location)).size : generator.inputBindings.size,
                addressRegisterCount: parsed.addresses.size,
                positionInvariant: parsed.options.has("ARB_position_invariant"),
                maxParameters: parameterLimit(parsed.target),
            };
            result.ok = true;
        } catch (error) {
            if (!(error instanceof ARBError)) throw error;
            result.log = "ERROR: line " + (error.arbLine || 0) + ": " +
                error.message;
            result.errorPosition = error.arbOffset >= 0 ? error.arbOffset :
                parser.currentOffset();
        }
        return result;
    }

    const api = {
        ARB_REVISION, MAX_PROGRAM_PARAMETERS, MAX_FRAGMENT_PROGRAM_PARAMETERS, MAX_PROGRAM_BINDINGS, MAX_ADDRESS_REGISTERS, parameterLimit, MAX_TEMPORARIES,
        PARAMETER_BINDING,
        compileARBProgram, lex, Parser, Generator, ARBError,
        INSTRUCTIONS, STATE_BINDINGS, applySwizzle,
    };
    global.GLARBProgram = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
