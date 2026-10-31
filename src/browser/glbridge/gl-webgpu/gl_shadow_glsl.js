// The GL shadow's shaders and programs (docs/opengl-webgpu-plan.md C4, the
// first step): GLSL 1.10/1.20 checked, linked and reflected by glslang on the
// CPU side, so glGetShaderiv, glGetProgramiv, the info logs, the active
// uniforms and attributes, the locations and glGetUniform* are answered in
// the request that asks, in both of the proxy's modes.
//
// glslang runs when an answer needs it, not at glCompileShader: the module
// may arrive after the first shaders (the renderer sends it), and a guest
// that never asks pays nothing. The device holds startup submissions until
// the compiler and capabilities arrive; a load failure is a CPU-side compile
// and link failure with a log, consistently in local and worker modes.
//
// Locations are this side's. A uniform's are the program's name times
// UNIFORM_LOCATIONS_PER_PROGRAM plus its position among the program's
// uniform elements, so they are the same after a relink and after a
// snapshot; an attribute not bound by the application takes the highest
// free slot, around the slots the conventional attributes alias
// (gl_shader_translator.js's table, NVIDIA's). The page's executor adopts
// what the guest was told: an answered location record is the mapping.

(function(global) {
    "use strict";

    const protocol = global.GLProtocol || require("./gl_protocol.js");
    const constants = global.GLWGConstants || require("./gl_constants.js");
    const caps = global.GLCaps || require("./gl_caps.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const record = (fn, parts) => (global.GLListArrays || require("./gl_list_arrays.js")).record(fn, parts);
    const { STAGE_OF_GL_TYPE } = global.V86GLGlslang || require("./gl_glslang.js");
    const { GLFN, C, F, RECORDS } = protocol;
    const GL = constants.GL;

    const OK = C.V86GL_SYNC_QUERY_STATUS_OK;
    const FAILED = C.V86GL_SYNC_QUERY_STATUS_FAILED;
    const PENDING = C.V86GL_SYNC_QUERY_STATUS_PENDING;
    const UNIFORM_LOCATIONS_PER_PROGRAM = 4096;
    const MAX_VERTEX_ATTRIBS = 16;
    const RENDER_COMMANDS = new Set(["BEGIN", "DRAW_ARRAYS", "DRAW_ELEMENTS", "DRAW_ARRAYS_GL2",
        "DRAW_ELEMENTS_GL2", "DRAW_ARRAYS_DIRECT", "DRAW_ELEMENTS_DIRECT", "DRAW_RANGE_ELEMENTS_DIRECT",
        "MULTI_DRAW_ARRAYS_DIRECT", "MULTI_DRAW_ELEMENTS_DIRECT", "DRAW_PIXELS", "COPY_PIXELS", "BITMAP", "RASTER_POS4F"]
        .map(name => GLFN[name]));
    const SAMPLER_TYPES = new Set([0x8B5D, 0x8B5E, 0x8B5F, 0x8B60, 0x8B61, 0x8B62, 0x8B63, 0x8B64]);
    const CONVENTIONAL_SLOTS = {
        gl_Vertex: 0, gl_Normal: 2, gl_Color: 3, gl_SecondaryColor: 4, gl_FogCoord: 5,
        gl_MultiTexCoord0: 8, gl_MultiTexCoord1: 9, gl_MultiTexCoord2: 10, gl_MultiTexCoord3: 11,
        gl_MultiTexCoord4: 12, gl_MultiTexCoord5: 13, gl_MultiTexCoord6: 14, gl_MultiTexCoord7: 15,
    };

    // GL type -> [base ("f", "i", "b"), columns, rows]: a vector is one
    // column, a sampler an int
    const TYPES = new Map([
        [0x1406, ["f", 1, 1]], [0x8B50, ["f", 1, 2]], [0x8B51, ["f", 1, 3]], [0x8B52, ["f", 1, 4]],
        [0x1404, ["i", 1, 1]], [0x8B53, ["i", 1, 2]], [0x8B54, ["i", 1, 3]], [0x8B55, ["i", 1, 4]],
        [0x8B56, ["b", 1, 1]], [0x8B57, ["b", 1, 2]], [0x8B58, ["b", 1, 3]], [0x8B59, ["b", 1, 4]],
        [0x8B5A, ["f", 2, 2]], [0x8B5B, ["f", 3, 3]], [0x8B5C, ["f", 4, 4]],
        [0x8B65, ["f", 2, 3]], [0x8B66, ["f", 2, 4]], [0x8B67, ["f", 3, 2]],
        [0x8B68, ["f", 3, 4]], [0x8B69, ["f", 4, 2]], [0x8B6A, ["f", 4, 3]],
    ]);
    const typeOf = type => TYPES.get(type) || ["i", 1, 1];
    const objectError = (group, name, shader) => (shader ? group.shaders : group.programs).has(name) ? 0 :
        (shader ? group.programs : group.shaders).has(name) ? GL.INVALID_OPERATION : GL.INVALID_VALUE;
    GLShadow.rules({ [GLFN.RESOLVED_PROGRAM_INTERFACE]: () => GL.INVALID_OPERATION, [GLFN.PROGRAM_LINK_FAILED]: () => GL.INVALID_OPERATION,
        [GLFN.PROGRAM_LINK_VALIDATION]: () => GL.INVALID_OPERATION });
    function rule(name, check) {
        GLShadow.rules({ [GLFN[name]]: (shadow, bytes, view, offset, size) => {
            if (shadow.current.state && shadow.current.state.begin) return GL.INVALID_OPERATION;
            return check(shadow, bytes, view, offset, size);
        } });
    }
    for (const name of ["CREATE_SHADER", "CREATE_PROGRAM"]) rule(name, (s, b, v, o, n) => {
        const a = s.args(name, v, o, n), g = s.current.group;
        if (name === "CREATE_SHADER" && !STAGE_OF_GL_TYPE.has(a[1])) return GL.INVALID_ENUM;
        if (name === "CREATE_PROGRAM" && g.nextProgramObjectId > 0xFFFFFFFF) return GL.OUT_OF_MEMORY;
        const kind = name === "CREATE_SHADER" ? C.V86GL_OBJECT_KIND_SHADER : C.V86GL_OBJECT_KIND_PROGRAM;
        if (g.glslNames?.has(a[0]) && g.glslNames.get(a[0]) !== kind) return GL.INVALID_VALUE;
        return !a[0] || g.shaders.has(a[0]) || g.programs.has(a[0]) ? GL.INVALID_VALUE : 0;
    });
    for (const [name, shader] of [["COMPILE_SHADER", true], ["DELETE_SHADER", true], ["LINK_PROGRAM", false],
            ["DELETE_PROGRAM", false], ["VALIDATE_PROGRAM", false], ["USE_PROGRAM", false]]) rule(name, (s, b, v, o, n) => {
        const id = s.args(name, v, o, n)[0];
        if (!id && ["DELETE_SHADER", "DELETE_PROGRAM", "USE_PROGRAM"].includes(name)) return 0;
        const error = objectError(s.current.group, id, shader); if (error) return error;
        if (name === "LINK_PROGRAM" && s.current.group.programs.get(id).linkGeneration >= 0xFFFFFFFF) return GL.OUT_OF_MEMORY;
        if (name === "USE_PROGRAM") {
            const linked = s.linkedProgram(s.current.group.programs.get(id));
            if (linked && !linked.ok) return GL.INVALID_OPERATION;
        }
        return 0;
    });
    for (const name of ["ATTACH_SHADER", "DETACH_SHADER"]) rule(name, (s, b, v, o, n) => {
        const a = s.args(name, v, o, n), g = s.current.group;
        const error = objectError(g, a[0], false) || objectError(g, a[1], true);
        if (error) return error;
        const attached = g.programs.get(a[0]).attached.has(a[1]);
        return attached === (name === "ATTACH_SHADER") ? GL.INVALID_OPERATION : 0;
    });
    rule("SHADER_SOURCE", (s, b, v, o, n) => {
        const r = protocol.decodeRecord("SHADER_SOURCE", v, o);
        return objectError(s.current.group, r.shader, true) || (RECORDS.SHADER_SOURCE.size + r.length > n ? GL.INVALID_VALUE : 0);
    });
    rule("BIND_ATTRIB_LOCATION", (s, b, v, o, n) => {
        const r = protocol.decodeRecord("BIND_ATTRIB_LOCATION", v, o), header = RECORDS.BIND_ATTRIB_LOCATION.size;
        const error = objectError(s.current.group, r.program, false); if (error) return error;
        if (header + r.name_length > n || r.location < 0 || r.location >= MAX_VERTEX_ATTRIBS) return GL.INVALID_VALUE;
        return readText(b, o + header, r.name_length).startsWith("gl_") ? GL.INVALID_OPERATION : 0;
    });

    // Validate the entire update before either side writes any uniform. An
    // array update stops at this uniform's end, never at the next location.
    for (const name of ["UNIFORM_FV", "UNIFORM_IV", "UNIFORM_MATRIX_FV", "UNIFORM_MATRIX_RECT_FV"])
        rule(name, (s, b, v, o, n) => {
            const r = protocol.decodeRecord(name, v, o), matrix = name.includes("MATRIX");
            const columns = matrix ? r.columns ?? r.dimension : 1, rows = matrix ? r.rows ?? r.dimension : r.components;
            if (r.count < 0 || columns < (matrix ? 2 : 1) || columns > 4 || rows < (matrix ? 2 : 1) || rows > 4 ||
                    RECORDS[name].size + r.count * columns * rows * 4 > n) return GL.INVALID_VALUE;
            const program = s.current.group.programs.get(s.current.program);
            if (!program) return GL.INVALID_OPERATION;
            if (r.location === -1) return 0;
            const linked = s.linkedProgram(program);
            if (linked === null) return 0; // the existing late-glslang path
            const entry = linked.ok && linked.byLocation.get(r.location);
            if (!entry) return GL.INVALID_OPERATION;
            const [base, c, rowsOfType] = typeOf(entry.uniform.type), integer = name === "UNIFORM_IV";
            if (columns !== c || rows !== rowsOfType || base !== "b" && integer !== (base === "i") ||
                    r.count > 1 && !entry.uniform.array) return GL.INVALID_OPERATION;
            const count = Math.min(r.count, entry.uniform.size - entry.element);
            v.setInt32(o + F[name].count, count, true);
            return 0;
        });

    // glslang's limits, from what the renderer backs (gl_caps.js)
    function glslangLimits(capabilities) {
        const limits = capabilities.limits;
        return {
            MaxLights: 8, MaxClipPlanes: 6, MaxTextureUnits: 8, MaxTextureCoords: 8,
            MaxVertexAttribs: MAX_VERTEX_ATTRIBS, MaxVertexUniformComponents: 1024, MaxVaryingFloats: 64,
            MaxVertexTextureImageUnits: caps.integer(capabilities, GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
            MaxCombinedTextureImageUnits: caps.integer(capabilities, GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
            MaxTextureImageUnits: caps.integer(capabilities, GL.MAX_TEXTURE_IMAGE_UNITS),
            MaxFragmentUniformComponents: 1024, MaxDrawBuffers: Math.min(8, limits.maxColorAttachments),
        };
    }

    function readText(bytes, at, length, terminated = true) {
        let end = at;
        while (end < at + length && (!terminated || bytes[end])) ++end;
        let text = "";
        for (let i = at; i < end; ++i) text += String.fromCharCode(bytes[i]);
        return text;
    }

    // As much of `text` as fits in `capacity` bytes, terminated; the length written
    function writeText(bytes, at, capacity, text) {
        if (!capacity) return 0;
        const length = Math.min(text.length, capacity - 1);
        for (let i = 0; i < length; ++i) bytes[at + i] = text.charCodeAt(i) & 0xff;
        bytes[at + length] = 0;
        return length;
    }

    const proto = GLShadow.prototype;

    proto.createShader = function(bytes, view, offset, size) {
        const a = this.args("CREATE_SHADER", view, offset, size);
        if (!a || !STAGE_OF_GL_TYPE.has(a[1])) return;
        this.current.group.glslNames?.delete(a[0]);
        this.current.group.shaders.set(a[0], { name: a[0], type: a[1], source: "", compileSource: null,
            compiled: null, deleted: false });
    };

    proto.shaderSource = function(bytes, view, offset, size) {
        if (size < RECORDS.SHADER_SOURCE.size) return;
        const shader = this.current.group.shaders.get(view.getUint32(offset + F.SHADER_SOURCE.shader, true));
        const length = view.getUint32(offset + F.SHADER_SOURCE.length, true);
        if (!shader || RECORDS.SHADER_SOURCE.size + length > size) return;
        shader.source = readText(bytes, offset + RECORDS.SHADER_SOURCE.size, length, false);
    };

    // compiled when an answer needs it: the source as it was now
    proto.compileShader = function(bytes, view, offset, size) {
        const a = this.args("COMPILE_SHADER", view, offset, size);
        const shader = a && this.current.group.shaders.get(a[0]);
        if (!shader) return;
        shader.compileSource = shader.source;
        shader.compiled = null;
    };

    // {ok, log}, or null without glslang
    proto.compiledShader = function(shader) {
        if (shader.compileSource === null) return { ok: false, log: "" };
        if (!shader.compiled) {
            if (this.glslangFailure) return shader.compiled = { ok: false, log: this.glslangFailure };
            if (!this.prepareGlslang()) return null;
            shader.compiled = this.glslang.compile(STAGE_OF_GL_TYPE.get(shader.type), shader.compileSource);
        }
        return shader.compiled;
    };

    proto.prepareGlslang = function() {
        if (!this.glslang || !this.capabilities) return false;
        this.glslang.setLimits(glslangLimits(this.capabilities));
        return true;
    };

    // A shader flagged for deletion goes once no program has it attached
    proto.deleteShader = function(bytes, view, offset, size) {
        const a = this.args("DELETE_SHADER", view, offset, size);
        const group = this.current.group;
        const shader = a && group.shaders.get(a[0]);
        if (!shader) return;
        shader.deleted = true;
        this.collectShader(group, shader);
    };

    proto.collectShader = function(group, shader) {
        if (!shader.deleted) return;
        for (const program of group.programs.values()) if (program.attached.has(shader.name)) return;
        group.shaders.delete(shader.name);
    };

    proto.createProgram = function(bytes, view, offset, size) {
        const a = this.args("CREATE_PROGRAM", view, offset, size);
        if (!a) return;
        this.current.group.glslNames?.delete(a[0]);
        this.current.group.programs.set(a[0], { name: a[0], objectId: this.current.group.nextProgramObjectId++, linkGeneration: 0, attached: new Set(), bindings: new Map(),
            linkInput: null, linked: null, executableInput: null, resetValues: false,
            validated: false, validation: null, installed: null, deleted: false, values: new Map() });
    };

    proto.attachShader = function(bytes, view, offset, size) {
        const a = this.args("ATTACH_SHADER", view, offset, size);
        const group = this.current.group;
        const program = a && group.programs.get(a[0]);
        if (program && group.shaders.has(a[1])) program.attached.add(a[1]);
    };

    proto.detachShader = function(bytes, view, offset, size) {
        const a = this.args("DETACH_SHADER", view, offset, size);
        const group = this.current.group;
        const program = a && group.programs.get(a[0]);
        if (!program || !program.attached.delete(a[1])) return;
        const shader = group.shaders.get(a[1]);
        if (shader) this.collectShader(group, shader);
    };

    proto.bindAttribLocation = function(bytes, view, offset, size) {
        const header = RECORDS.BIND_ATTRIB_LOCATION.size;
        if (size < header) return;
        const program = this.current.group.programs.get(view.getUint32(offset + F.BIND_ATTRIB_LOCATION.program, true));
        const length = view.getUint32(offset + F.BIND_ATTRIB_LOCATION.name_length, true);
        if (!program || header + length > size) return;
        // takes effect at the next link
        program.bindings.set(readText(bytes, offset + header, length),
            view.getInt32(offset + F.BIND_ATTRIB_LOCATION.location, true));
    };

    // Freeze the compile inputs at LinkProgram, even if glslang arrives later.
    // Only a successful link replaces installed code and zeros its uniforms
    // (GL 2.1 section 2.15.2); failed links still replace the query result.
    proto.linkProgram = function(bytes, view, offset, size) {
        const a = this.args("LINK_PROGRAM", view, offset, size);
        const group = this.current.group;
        const program = a && group.programs.get(a[0]);
        if (!program) return;
        this.linkedProgram(program);
        const shaders = [...program.attached].map(name => group.shaders.get(name)).filter(Boolean);
        program.linkInput = { generation: ++program.linkGeneration, shaders: shaders.map(s => ({ type: s.type, compileSource: s.compileSource })),
            bindings: [...program.bindings] };
        program.backendLinkFailure = null;
        program.linked = null;
        program.validated = false;
        program.validation = null;
        program.resetValues = true;
        this.linkedProgram(program);
    };

    // The link's result: {ok, log, uniforms, attributes, byLocation}, or null without glslang
    proto.linkedProgram = function(program) {
        if (program.linked) return program.linked;
        if (!program.linkInput) return { ok: false, log: "", uniforms: [], attributes: [], byLocation: new Map() };
        const failed = log => ({ ok: false, log, uniforms: [], attributes: [], byLocation: new Map() });
        if (program.backendLinkFailure?.generation === program.linkInput.generation)
            return program.linked = failed(program.backendLinkFailure.log);
        if (this.glslangFailure) return program.linked = failed(this.glslangFailure);
        if (!this.prepareGlslang()) return null;
        const shaders = program.linkInput.shaders;
        if (!shaders.length) return program.linked = failed("ERROR: no shaders attached\n");
        for (const shader of shaders) {
            if (shader.compileSource === null) return program.linked = failed("ERROR: a shader is not compiled\n");
            if (!this.glslang.compile(STAGE_OF_GL_TYPE.get(shader.type), shader.compileSource).ok)
                return program.linked = failed("ERROR: a shader did not compile\n");
        }
        const result = this.glslang.link(shaders.map(s => ({ stage: STAGE_OF_GL_TYPE.get(s.type),
            source: s.compileSource })));
        if (!result.ok) return program.linked = failed(result.log);
        // glslang's desktop resource table constrains built-ins, but does not
        // reject every excess active user sampler. Count stage uses as GL 2.1
        // requires: a uniform used by both stages consumes two combined slots.
        let vertexSamplers = 0, fragmentSamplers = 0;
        for (const uniform of result.uniforms) if (SAMPLER_TYPES.has(uniform.type)) {
            if (uniform.stages & 1) vertexSamplers += Math.max(1, uniform.size);
            if (uniform.stages & 16) fragmentSamplers += Math.max(1, uniform.size);
        }
        if (vertexSamplers > caps.integer(this.capabilities, GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS) ||
                fragmentSamplers > caps.integer(this.capabilities, GL.MAX_TEXTURE_IMAGE_UNITS) ||
                vertexSamplers + fragmentSamplers > caps.integer(this.capabilities, GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS))
            return program.linked = failed("ERROR: active samplers exceed the available texture image units\n");
        const linked = { ok: true, log: result.log, uniforms: [], attributes: [], byLocation: new Map() };
        // uniforms: GL's list, built-ins too ("gl_" names have no location)
        let next = (program.name % (0x80000000 / UNIFORM_LOCATIONS_PER_PROGRAM)) * UNIFORM_LOCATIONS_PER_PROGRAM;
        for (const u of result.uniforms) {
            const name = u.name.replace(/\[0\]$/, "");
            const size = Math.max(1, u.size);
            const uniform = { name, active: u.arrayDims ? name + "[0]" : name, array: !!u.arrayDims, type: u.type,
                size, location: -1 };
            if (!name.startsWith("gl_")) {
                uniform.location = next;
                for (let i = 0; i < size; ++i) linked.byLocation.set(next + i, { uniform, element: i });
                next += size;
            }
            linked.uniforms.push(uniform);
        }
        // attributes: the vertex stage's inputs
        const vertexSources = shaders.filter(s => s.type === GL.VERTEX_SHADER).map(s => s.compileSource).join("\n");
        const used = new Set();
        if (/\b(gl_Vertex|ftransform)\b/.test(vertexSources)) used.add(0);
        const inputs = result.inputs.filter(i => i.stages & 1 || !(i.stages >>> 0));
        for (const i of inputs) if (i.name in CONVENTIONAL_SLOTS) used.add(CONVENTIONAL_SLOTS[i.name]);
        const bindings = new Map(program.linkInput.bindings);
        const slots = type => typeOf(type)[1];
        for (const i of inputs) {
            const attribute = { name: i.name, type: i.type, size: Math.max(1, i.size), location: -1 };
            linked.attributes.push(attribute);
            if (i.name.startsWith("gl_")) continue;
            const bound = bindings.get(i.name);
            if (bound !== undefined) {
                attribute.location = bound;
                const n = slots(i.type) * attribute.size;
                if (bound + n > MAX_VERTEX_ATTRIBS)
                    return program.linked = failed("ERROR: vertex attribute '" + i.name + "' exceeds the available slots\n");
                for (let k = 0; k < n; ++k) used.add(bound + k);
            }
        }
        for (const attribute of linked.attributes) {
            if (attribute.name.startsWith("gl_") || attribute.location >= 0) continue;
            const n = slots(attribute.type) * attribute.size;
            let base = MAX_VERTEX_ATTRIBS - n;
            const free = b => { for (let k = 0; k < n; ++k) if (used.has(b + k)) return false; return true; };
            while (base >= 0 && !free(base)) --base;
            if (base < 0) return program.linked = failed("ERROR: out of vertex attribute slots for '" +
                attribute.name + "'\n");
            for (let k = 0; k < n; ++k) used.add(base + k);
            attribute.location = base;
        }
        if (program.resetValues) {
            program.values = new Map();
            for (const uniform of linked.uniforms) {
                const values = result.initializers?.[uniform.name];
                if (!values || uniform.location < 0) continue;
                const [, columns, rows] = typeOf(uniform.type), width = columns * rows;
                for (let i = 0; i < uniform.size; ++i) if (values.length >= (i + 1) * width)
                    program.values.set(uniform.location + i, values.slice(i * width, (i + 1) * width));
            }
        }
        program.resetValues = false;
        program.executableInput = program.linkInput;
        program.executableGeneration = program.linkInput.generation || 1;
        program.installed = linked;
        return program.linked = linked;
    };

    // The latest failed link does not replace code already installed by UseProgram.
    // Reflection is reconstructed from the successful input after a snapshot.
    proto.installedProgram = function(program) {
        this.linkedProgram(program);
        if (!program.installed && program.executableInput) {
            program.installed = this.linkedProgram({ name: program.name, linkInput: program.executableInput,
                values: new Map(), resetValues: false });
        }
        return program.installed;
    };

    proto.samplerValidation = function(program, linked) {
        const units = new Map(), limit = caps.integer(this.capabilities, GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
        for (const uniform of linked.uniforms) {
            if (!SAMPLER_TYPES.has(uniform.type) || uniform.location < 0) continue;
            for (let i = 0; i < uniform.size; ++i) {
                const unit = (program.values.get(uniform.location + i) || [0])[0];
                if (unit < 0 || unit >= limit)
                    return { ok: false, log: "ERROR: sampler '" + uniform.name + "' selects an unavailable texture unit\n" };
                if (units.has(unit) && units.get(unit) !== uniform.type)
                    return { ok: false, log: "ERROR: samplers of different types select the same texture unit\n" };
                units.set(unit, uniform.type);
            }
        }
        return { ok: true, log: "" };
    };

    proto.programValidation = function(program) {
        if (!program.validated) return { ok: false, log: "" };
        if (!program.validation) {
            const linked = this.linkedProgram(program);
            if (!linked) return null;
            program.validation = linked.ok ? this.samplerValidation(program, linked) :
                { ok: false, log: "ERROR: program is not linked\n" };
        }
        return program.validation;
    };

    proto.useProgram = function(bytes, view, offset, size) {
        const a = this.args("USE_PROGRAM", view, offset, size);
        if (!a) return;
        const group = this.current.group;
        const previous = group.programs.get(this.current.program);
        this.current.program = a[0];
        if (previous) this.collectProgram(group, previous);
    };

    proto.validateProgram = function(bytes, view, offset, size) {
        const a = this.args("VALIDATE_PROGRAM", view, offset, size);
        const program = a && this.current.group.programs.get(a[0]);
        if (program) {
            program.validated = true;
            program.validation = null;
            this.programValidation(program);
        }
    };

    // A program flagged for deletion goes once no context uses it
    proto.deleteProgram = function(bytes, view, offset, size) {
        const a = this.args("DELETE_PROGRAM", view, offset, size);
        const group = this.current.group;
        const program = a && group.programs.get(a[0]);
        if (!program) return;
        program.deleted = true;
        this.collectProgram(group, program);
    };

    proto.collectProgram = function(group, program) {
        if (!program.deleted) return;
        for (const context of this.contexts.values())
            if (context.group === group && context.program === program.name) return;
        group.programs.delete(program.name);
        for (const name of program.attached) {
            const shader = group.shaders.get(name);
            program.attached.delete(name);
            if (shader) this.collectShader(group, shader);
        }
    };

    // glUniform*: the current program's values, by location
    proto.uniformValues = function(view, offset, size, header, location, columns, rows, count, transpose, integer) {
        const program = this.current.group.programs.get(this.current.program);
        const linked = program && this.linkedProgram(program);
        if (!linked || !linked.ok) return;
        const start = linked.byLocation.get(location);
        if (!start) return;
        count = Math.min(count, start.uniform.size - start.element);
        for (let m = 0; m < count; ++m) {
            const entry = linked.byLocation.get(location + m);
            if (!entry || entry.uniform.location + entry.uniform.size <= location + m) return;
            const values = [];
            for (let c = 0; c < columns; ++c) for (let r = 0; r < rows; ++r) {
                const index = transpose ? r * columns + c : c * rows + r;
                const at = offset + header + (m * columns * rows + index) * 4;
                if (at + 4 > offset + size) return;
                const v = integer ? view.getInt32(at, true) : view.getFloat32(at, true);
                values.push(typeOf(entry.uniform.type)[0] === "b" ? +!!v : v);
            }
            program.values.set(location + m, values);
        }
    };

    proto.uniformVector = function(integer) {
        return function(bytes, view, offset, size) {
            const name = integer ? "UNIFORM_IV" : "UNIFORM_FV";
            if (size < RECORDS[name].size) return;
            const components = view.getInt32(offset + F[name].components, true);
            if (components < 1 || components > 4) return;
            this.uniformValues(view, offset, size, RECORDS[name].size, view.getInt32(offset + F[name].location, true),
                1, components, view.getInt32(offset + F[name].count, true), false, integer);
        };
    };
    proto.uniformFv = proto.uniformVector(false);
    proto.uniformIv = proto.uniformVector(true);

    proto.uniformMatrix = function(bytes, view, offset, size) {
        const R = F.UNIFORM_MATRIX_FV;
        if (size < RECORDS.UNIFORM_MATRIX_FV.size) return;
        const n = view.getInt32(offset + R.dimension, true);
        this.uniformValues(view, offset, size, RECORDS.UNIFORM_MATRIX_FV.size, view.getInt32(offset + R.location, true),
            n, n, view.getInt32(offset + R.count, true), view.getUint32(offset + R.transpose, true) !== 0, false);
    };

    proto.uniformMatrixRect = function(bytes, view, offset, size) {
        const R = F.UNIFORM_MATRIX_RECT_FV;
        if (size < RECORDS.UNIFORM_MATRIX_RECT_FV.size) return;
        this.uniformValues(view, offset, size, RECORDS.UNIFORM_MATRIX_RECT_FV.size,
            view.getInt32(offset + R.location, true), view.getInt32(offset + R.columns, true),
            view.getInt32(offset + R.rows, true), view.getInt32(offset + R.count, true),
            view.getUint32(offset + R.transpose, true) !== 0, false);
    };

    /* ---- the answers ---- */

    const maxLength = list => list.reduce((n, e) => Math.max(n, e.length + 1), 0);

    proto.failedGLSLQuery = function(name, view, offset, error) {
        this.answered(name, view, offset, FAILED);
        return error;
    };

    proto.queryObjectIv = function(bytes, view, offset, size) {
        const R = F.QUERY_OBJECT_IV;
        if (!this.pending("QUERY_OBJECT_IV", view, offset, size)) return;
        const kind = view.getUint32(offset + R.object_kind, true);
        const name = view.getUint32(offset + R.name, true);
        const pname = view.getUint32(offset + R.pname, true);
        const group = this.current.group;
        let value = null;
        if (kind === C.V86GL_OBJECT_KIND_SHADER) {
            const shader = group.shaders.get(name);
            if (!shader) return this.failedGLSLQuery("QUERY_OBJECT_IV", view, offset, objectError(group, name, true));
            if (pname === GL.COMPILE_STATUS || pname === GL.INFO_LOG_LENGTH) {
                const compiled = this.compiledShader(shader);
                if (!compiled) return;
                value = pname === GL.COMPILE_STATUS ? +compiled.ok : compiled.log ? compiled.log.length + 1 : 0;
            } else if (pname === GL.SHADER_TYPE) value = shader.type;
            else if (pname === GL.DELETE_STATUS) value = +shader.deleted;
            else if (pname === GL.SHADER_SOURCE_LENGTH) value = shader.source ? shader.source.length + 1 : 0;
        } else if (kind === C.V86GL_OBJECT_KIND_PROGRAM) {
            const program = group.programs.get(name);
            if (!program) return this.failedGLSLQuery("QUERY_OBJECT_IV", view, offset, objectError(group, name, false));
            if (pname === GL.DELETE_STATUS) value = +program.deleted;
            else if (pname === GL.ATTACHED_SHADERS) value = program.attached.size;
            else if (pname === GL.VALIDATE_STATUS) {
                const validation = this.programValidation(program);
                if (!validation) return;
                value = +validation.ok;
            } else {
                const linked = this.linkedProgram(program);
                if (!linked) return;
                switch (pname) {
                case GL.LINK_STATUS: value = +linked.ok; break;
                case GL.INFO_LOG_LENGTH: {
                    const result = program.validated ? this.programValidation(program) : linked;
                    if (!result) return;
                    value = result.log ? result.log.length + 1 : 0; break;
                }
                case GL.ACTIVE_UNIFORMS: value = linked.uniforms.length; break;
                case GL.ACTIVE_ATTRIBUTES: value = linked.attributes.length; break;
                case GL.ACTIVE_UNIFORM_MAX_LENGTH: value = maxLength(linked.uniforms.map(u => u.active)); break;
                case GL.ACTIVE_ATTRIBUTE_MAX_LENGTH: value = maxLength(linked.attributes.map(a => a.name)); break;
                }
            }
        } else {
            // queries' results are the renderer's
            return;
        }
        if (value === null) return this.failedGLSLQuery("QUERY_OBJECT_IV", view, offset, GL.INVALID_ENUM);
        view.setInt32(offset + R.value, value, true);
        this.answered("QUERY_OBJECT_IV", view, offset, OK);
    };

    // {object_kind, name, buf_size, status, length, data_size} then the text
    proto.queryObjectLog = function(bytes, view, offset, size) {
        const R = F.QUERY_OBJECT_LOG, header = RECORDS.QUERY_OBJECT_LOG.size;
        if (!this.pending("QUERY_OBJECT_LOG", view, offset, size)) return;
        const kind = view.getUint32(offset + R.object_kind, true);
        const name = view.getUint32(offset + R.name, true);
        const capacity = view.getUint32(offset + R.buf_size, true);
        const group = this.current.group;
        let result;
        if (kind === C.V86GL_TEXT_SHADER_SOURCE) {
            const shader = group.shaders.get(name);
            if (!shader) return this.failedGLSLQuery("QUERY_OBJECT_LOG", view, offset, objectError(group, name, true));
            result = {log: shader.source};
        } else if (kind === C.V86GL_OBJECT_KIND_SHADER) {
            const shader = group.shaders.get(name);
            if (!shader) return this.failedGLSLQuery("QUERY_OBJECT_LOG", view, offset, objectError(group, name, true));
            result = shader ? this.compiledShader(shader) : undefined;
        } else if (kind === C.V86GL_OBJECT_KIND_PROGRAM) {
            const program = group.programs.get(name);
            if (!program) return this.failedGLSLQuery("QUERY_OBJECT_LOG", view, offset, objectError(group, name, false));
            result = program.validated ? this.programValidation(program) : this.linkedProgram(program);
        } else {
            return;
        }
        if (result === null) return;
        if (!result || header + capacity > size) return this.answered("QUERY_OBJECT_LOG", view, offset, FAILED);
        view.setUint32(offset + R.length, writeText(bytes, offset + header, capacity, result.log), true);
        this.answered("QUERY_OBJECT_LOG", view, offset, OK);
    };

    // {active_kind, program, index, buf_size, status, length, size, type, data_size, reserved} then the name
    proto.queryActive = function(bytes, view, offset, size) {
        const R = F.QUERY_ACTIVE, header = RECORDS.QUERY_ACTIVE.size;
        if (!this.pending("QUERY_ACTIVE", view, offset, size)) return;
        const program = this.current.group.programs.get(view.getUint32(offset + R.program, true));
        if (!program) return this.failedGLSLQuery("QUERY_ACTIVE", view, offset,
            objectError(this.current.group, view.getUint32(offset + R.program, true), false));
        const linked = program ? this.linkedProgram(program) : undefined;
        if (linked === null) return;
        const kind = view.getUint32(offset + R.active_kind, true);
        const index = view.getUint32(offset + R.index, true);
        const capacity = view.getUint32(offset + R.buf_size, true);
        const list = !linked ? [] : kind === C.V86GL_ACTIVE_KIND_ATTRIB ? linked.attributes : linked.uniforms;
        const entry = list[index];
        if (!entry) return this.failedGLSLQuery("QUERY_ACTIVE", view, offset, GL.INVALID_VALUE);
        if (header + capacity > size) return this.answered("QUERY_ACTIVE", view, offset, FAILED);
        view.setUint32(offset + R.length, writeText(bytes, offset + header, capacity, entry.active || entry.name), true);
        view.setInt32(offset + R.size, entry.size, true);
        view.setUint32(offset + R.type, entry.type, true);
        this.answered("QUERY_ACTIVE", view, offset, OK);
    };

    // {location_kind, program, guest_location, status, result, value_type, value_count, name_length} then the name
    proto.queryLocation = function(bytes, view, offset, size) {
        const R = F.QUERY_LOCATION, header = RECORDS.QUERY_LOCATION.size;
        if (!this.pending("QUERY_LOCATION", view, offset, size)) return;
        const program = this.current.group.programs.get(view.getUint32(offset + R.program, true));
        if (!program) return this.failedGLSLQuery("QUERY_LOCATION", view, offset,
            objectError(this.current.group, view.getUint32(offset + R.program, true), false));
        const linked = program ? this.linkedProgram(program) : undefined;
        if (linked === null) return;
        const length = view.getUint32(offset + R.name_length, true);
        if (!linked || !linked.ok) return this.failedGLSLQuery("QUERY_LOCATION", view, offset, GL.INVALID_OPERATION);
        if (header + length > size) return this.answered("QUERY_LOCATION", view, offset, FAILED);
        const name = readText(bytes, offset + header, length);
        let location = -1, type = 0, count = 0;
        if (view.getUint32(offset + R.location_kind, true) === C.V86GL_LOCATION_KIND_ATTRIB) {
            const attribute = linked.attributes.find(a => a.name === name);
            if (attribute && attribute.location >= 0) {
                location = attribute.location;
                type = attribute.type;
                count = typeOf(type)[1] * typeOf(type)[2];
            }
        } else {
            // name, name[0] and name[i]: location + i
            const match = /^(.*)\[(\d+)\]$/.exec(name);
            const base = match ? match[1] : name, element = match ? +match[2] : 0;
            const uniform = linked.uniforms.find(u => u.name === base);
            if (uniform && uniform.location >= 0 && element < uniform.size && (!match || uniform.array)) {
                location = uniform.location + element;
                type = uniform.type;
                count = typeOf(type)[1] * typeOf(type)[2];
            }
        }
        view.setInt32(offset + R.result, location, true);
        view.setUint32(offset + R.value_type, type, true);
        view.setInt32(offset + R.value_count, count, true);
        this.answered("QUERY_LOCATION", view, offset, OK);
    };

    // {program, location, value_kind, status, value_count, data_size, reserved0, reserved1} then the values:
    // value_kind 1 floats, 2 ints
    proto.queryUniform = function(bytes, view, offset, size) {
        const R = F.QUERY_UNIFORM, header = RECORDS.QUERY_UNIFORM.size;
        if (!this.pending("QUERY_UNIFORM", view, offset, size)) return;
        const program = this.current.group.programs.get(view.getUint32(offset + R.program, true));
        if (!program) return this.failedGLSLQuery("QUERY_UNIFORM", view, offset,
            objectError(this.current.group, view.getUint32(offset + R.program, true), false));
        const linked = program ? this.linkedProgram(program) : undefined;
        if (linked === null) return;
        const location = view.getInt32(offset + R.location, true);
        const entry = linked && linked.ok ? linked.byLocation.get(location) : null;
        if (!entry) return this.failedGLSLQuery("QUERY_UNIFORM", view, offset, GL.INVALID_OPERATION);
        const [base, columns, rows] = typeOf(entry.uniform.type);
        const count = columns * rows;
        if (header + count * 4 > size) return this.answered("QUERY_UNIFORM", view, offset, FAILED);
        const values = program.values.get(location) || new Array(count).fill(0);
        const integer = view.getUint32(offset + R.value_kind, true) === 2;
        for (let i = 0; i < count; ++i) {
            let v = values[i] ?? 0;
            if (base === "b") v = v ? 1 : 0;
            if (integer) view.setInt32(offset + header + i * 4, base === "f" ? Math.round(v) : v, true);
            else view.setFloat32(offset + header + i * 4, v, true);
        }
        view.setInt32(offset + R.value_count, count, true);
        this.answered("QUERY_UNIFORM", view, offset, OK);
    };

    GLShadow.install({
        [GLFN.CREATE_SHADER]: "createShader",
        [GLFN.SHADER_SOURCE]: "shaderSource",
        [GLFN.COMPILE_SHADER]: "compileShader",
        [GLFN.DELETE_SHADER]: "deleteShader",
        [GLFN.CREATE_PROGRAM]: "createProgram",
        [GLFN.ATTACH_SHADER]: "attachShader",
        [GLFN.DETACH_SHADER]: "detachShader",
        [GLFN.BIND_ATTRIB_LOCATION]: "bindAttribLocation",
        [GLFN.LINK_PROGRAM]: "linkProgram",
        [GLFN.USE_PROGRAM]: "useProgram",
        [GLFN.VALIDATE_PROGRAM]: "validateProgram",
        [GLFN.DELETE_PROGRAM]: "deleteProgram",
        [GLFN.UNIFORM_FV]: "uniformFv",
        [GLFN.UNIFORM_IV]: "uniformIv",
        [GLFN.UNIFORM_MATRIX_FV]: "uniformMatrix",
        [GLFN.UNIFORM_MATRIX_RECT_FV]: "uniformMatrixRect",
        [GLFN.QUERY_OBJECT_IV]: "queryObjectIv",
        [GLFN.QUERY_OBJECT_LOG]: "queryObjectLog",
        [GLFN.QUERY_ACTIVE]: "queryActive",
        [GLFN.QUERY_LOCATION]: "queryLocation",
        [GLFN.QUERY_UNIFORM]: "queryUniform",
    });

    function validationRecord(job, operation, data = new Uint8Array()) {
        return record(GLFN.PROGRAM_LINK_VALIDATION, [protocol.encodeRecord("PROGRAM_LINK_VALIDATION", {
            operation, job: job.id, program: job.program.name, object_id: job.program.objectId,
            link_generation: job.generation, data_size: data.length,
        }), data]);
    }
    function restoreExecutable(program, previous) {
        for (const name of ["installed", "values", "executableInput", "executableGeneration"]) program[name] = previous[name];
        program.resetValues = false;
    }
    proto.completeProgramLink = function(message) {
        const job = this.programLinkJobs?.get(message.job);
        if (!job || this.cpuBarrier?.token !== job.token || message.program !== job.program.name || message.object_id !== job.program.objectId ||
                message.link_generation !== job.generation || typeof message.ok !== "boolean") return false;
        this.programLinkJobs.delete(job.id);
        const program = job.program, current = job.group.programs.get(program.name) === program && program.linkGeneration === job.generation;
        const ok = current && message.ok;
        if (ok) {
            program.linked = job.linked;
            for (const name of ["installed", "values", "executableInput", "executableGeneration"]) program[name] = job.candidate[name];
            program.resetValues = false;
        } else if (current) {
            const log = "ERROR: GPU program link: " + String(message.log || "validation failed").slice(0, 65536);
            program.backendLinkFailure = { generation: job.generation, log };
            program.linked = { ok: false, log, uniforms: [], attributes: [], byLocation: new Map() };
        }
        const commands = [validationRecord(job, ok ? 1 : 2)];
        if (!ok && current) commands.push(record(GLFN.PROGRAM_LINK_FAILED, [protocol.encodeArgs("PROGRAM_LINK_FAILED", [program.name])]));
        this.resumeCPU(job.token, commands);
        return true;
    };

    // The objects, in snapshots: what was compiled and linked, and the
    // uniforms' values (glslang runs again when an answer needs it)
    GLShadow.part({
        routeRecord(shadow, fn, bytes, view, offset, size) {
            if (fn !== GLFN.LINK_PROGRAM || !shadow.current) return;
            if (shadow.requireGPUProgramValidation && shadow.nextProgramLinkJob >= 0xFFFFFFFF) return { error: GL.OUT_OF_MEMORY };
            const original = shadow.current.group.programs.get(view.getUint32(offset, true));
            if (original) shadow.linkedProgram(original);
            const previous = original && { installed: original.installed, values: original.values,
                executableInput: original.executableInput, executableGeneration: original.executableGeneration };
            const error = shadow.dispatch(fn, bytes, view, offset, size); if (error) return { error };
            const program = shadow.current.group.programs.get(view.getUint32(offset, true)), linked = program.linked;
            if (!linked) return { commands: [record(fn, [bytes.subarray(offset, offset + size)])] };
            if (!linked.ok) {
                view.setUint16(offset - 4, GLFN.PROGRAM_LINK_FAILED, true);
                return { commands: [record(GLFN.PROGRAM_LINK_FAILED, [bytes.subarray(offset, offset + size)])] };
            }
            const entry = (row, kind) => ({ name: row.name, location_kind: kind, location: row.location, value_type: row.type, value_count: row.size });
            const entries = [...linked.attributes.filter(a => a.location >= 0).map(a => entry(a, C.V86GL_LOCATION_KIND_ATTRIB)),
                ...linked.uniforms.filter(u => u.location >= 0).map(u => entry(u, C.V86GL_LOCATION_KIND_UNIFORM))];
            const resolved = protocol.encodeProgramInterface({ program: program.name, object_id: program.objectId, link_generation: program.executableGeneration }, entries,
                [...program.values].map(([location, values]) => ({location, values})));
            if (shadow.requireGPUProgramValidation) {
                const id = ++shadow.nextProgramLinkJob, job = { id, token: {kind: "program-link", id}, program, group: shadow.current.group,
                    generation: program.linkGeneration, linked, candidate: { installed: program.installed, values: program.values,
                        executableInput: program.executableInput, executableGeneration: program.executableGeneration } };
                restoreExecutable(program, previous);shadow.programLinkJobs.set(id, job);shadow.blockCPU(job.token);
                return { commands: [validationRecord(job, 0, resolved)] };
            }
            return { commands: [record(fn, [bytes.subarray(offset, offset + size)]), record(GLFN.RESOLVED_PROGRAM_INTERFACE,
                [resolved])] };
        },
        forwardOpcode(shadow, fn, bytes, view, offset, size) {
            if (fn !== GLFN.LINK_PROGRAM || !shadow.current || size < 4) return;
            const program = shadow.current.group.programs.get(view.getUint32(offset, true));
            if (program && program.linked && !program.linked.ok) return GLFN.PROGRAM_LINK_FAILED;
        },
        checkCommand(shadow, fn) {
            if (!RENDER_COMMANDS.has(fn) || !shadow.capabilities) return 0;
            const program = shadow.current.group.programs.get(shadow.current.program);
            if (!program) return 0;
            const linked = shadow.installedProgram(program);
            return linked && linked.ok && !shadow.samplerValidation(program, linked).ok ? GL.INVALID_OPERATION : 0;
        },
        group(group) {
            group.nextProgramObjectId = 1;
            group.shaders = new Map();
            group.programs = new Map();
        },
        reset(shadow) {shadow.programLinkJobs = new Map();shadow.nextProgramLinkJob ||= 0;},
        cancelCPU(shadow) {
            for (const job of shadow.programLinkJobs.values()) {
                const log = "ERROR: GPU program link validation cancelled";
                job.program.backendLinkFailure = {generation: job.generation, log};
                job.program.linked = {ok: false, log, uniforms: [], attributes: [], byLocation: new Map()};
            }
            shadow.programLinkJobs.clear();
        },
        destroy(shadow, context) {
            for (const program of context.group.programs.values()) shadow.collectProgram(context.group, program);
        },
        getState(shadow, state) {
            state.glsl = [...shadow.groups.values()].map(group => ({
                key: group.key,
                nextProgramObjectId: group.nextProgramObjectId,
                shaders: [...group.shaders.values()].map(s => [s.name, s.type, s.source, s.compileSource, s.deleted]),
                programs: [...group.programs.values()].map(p => [p.name, [...p.attached], [...p.bindings], p.linkInput,
                    p.validated, p.deleted, [...p.values], p.executableInput, p.resetValues, p.validation, p.objectId, p.linkGeneration, p.executableGeneration, p.backendLinkFailure || null]),
            }));
        },
        setState(shadow, state) {
            for (const saved of state.glsl || []) {
                const group = shadow.groups.get(saved.key);
                if (!group) continue;
                group.nextProgramObjectId = saved.nextProgramObjectId || 1;
                for (const [name, type, source, compileSource, deleted] of saved.shaders)
                    group.shaders.set(name, { name, type, source, compileSource, compiled: null, deleted });
                for (const [name, attached, bindings, linkInput, validated, deleted, values, executableInput, resetValues, validation, objectId, linkGeneration, executableGeneration, backendLinkFailure] of saved.programs)
                    group.programs.set(name, { name, attached: new Set(attached), bindings: new Map(bindings), linkInput,
                        objectId: objectId || group.nextProgramObjectId++, linkGeneration: linkGeneration || linkInput?.generation || 0, executableGeneration: executableGeneration || executableInput?.generation || 0,
                        linked: null, executableInput: executableInput || null, resetValues: !!resetValues,
                        validated, validation: validation || null, installed: null, deleted, values: new Map(values), backendLinkFailure: backendLinkFailure || null });
            }
        },
    });

    const api = { UNIFORM_LOCATIONS_PER_PROGRAM, CONVENTIONAL_SLOTS };
    global.V86GLShadowGLSL = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
