// Test-only diagnostic queries for raw renderer unit/pixel streams. This
// adapter is never bundled into the emulator. Application-observable GL
// queries are exercised through GLShadow by the CPU/ABI/worker suites.
"use strict";
(function(global) {
    const protocol = global.GLProtocol || require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
    const { GL } = global.GLWGConstants || require("../../src/browser/glbridge/gl-webgpu/gl_constants.js");
    const moduleAPI = global.GLWebGPUExecutorModule || require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
    const { SYNC_STATUS_PENDING, SYNC_STATUS_OK, SYNC_STATUS_FAILED } = moduleAPI;
    class GLStreamError extends Error {}
    const readCString = (bytes, offset, size) => new TextDecoder().decode(bytes.subarray(offset, offset + size)).split("\0")[0];
    function writeCString(bytes, offset, capacity, text) {
        if (capacity <= 0) return 0;
        const written = Math.min(text.length, capacity - 1);
        for (let i = 0; i < written; ++i) bytes[offset + i] = text.charCodeAt(i) & 255;
        bytes[offset + written] = 0;
        return written;
    }
    const glCaps = global.GLCaps || require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
    const arbProgram = global.GLARBProgram || require("../../src/browser/glbridge/gl-webgpu/gl_arb_program.js");
    const LOCATION_KIND_ATTRIB = protocol.C.V86GL_LOCATION_KIND_ATTRIB, ACTIVE_KIND_ATTRIB = protocol.C.V86GL_ACTIVE_KIND_ATTRIB,
        PROGRAM_PARAMETER_ENV = protocol.C.V86GL_PROGRAM_PARAMETER_ENV, PROGRAM_PARAMETER_LOCAL = protocol.C.V86GL_PROGRAM_PARAMETER_LOCAL;
    function arbParameterStorage(program, kind) {
        if (!program.env) { program.env = new Float32Array(arbProgram.MAX_PROGRAM_PARAMETERS * 4);program.local = new Float32Array(arbProgram.MAX_PROGRAM_PARAMETERS * 4); }
        return kind === PROGRAM_PARAMETER_LOCAL ? program.local : program.env;
    }
    function maxNameLength(...lists) {
        let longest = 0;
        for (const list of lists)
            for (const entry of list)
                longest = Math.max(longest, entry.name.length);
        return longest + 1;
    }

    function samplerTypeName(sampler) {
        if (!sampler.dim) return "sampler2D";
        return "sampler" + sampler.dim + (sampler.shadow ? "Shadow" : "");
    }

    /* GLSL type names to the GL_* enums glGetActiveUniform reports. */
    const GLSL_TYPE_ENUMS = {
        float: GL.FLOAT, vec2: GL.FLOAT_VEC2, vec3: GL.FLOAT_VEC3,
        vec4: GL.FLOAT_VEC4,
        int: GL.INT, ivec2: GL.INT_VEC2, ivec3: GL.INT_VEC3, ivec4: GL.INT_VEC4,
        bool: GL.BOOL, bvec2: GL.BOOL_VEC2, bvec3: GL.BOOL_VEC3,
        bvec4: GL.BOOL_VEC4,
        mat2: GL.FLOAT_MAT2, mat3: GL.FLOAT_MAT3, mat4: GL.FLOAT_MAT4,
        mat2x3: GL.FLOAT_MAT2x3, mat2x4: GL.FLOAT_MAT2x4,
        mat3x2: GL.FLOAT_MAT3x2, mat3x4: GL.FLOAT_MAT3x4,
        mat4x2: GL.FLOAT_MAT4x2, mat4x3: GL.FLOAT_MAT4x3,
        sampler1D: GL.SAMPLER_1D, sampler2D: GL.SAMPLER_2D,
        sampler3D: GL.SAMPLER_3D, samplerCube: GL.SAMPLER_CUBE,
        sampler1DShadow: GL.SAMPLER_1D_SHADOW,
        sampler2DShadow: GL.SAMPLER_2D_SHADOW,
    };

    function glslTypeEnum(name) {
        return GLSL_TYPE_ENUMS[name] || 0;
    }

    const diagnosticMethods = {
        queryLocation(kind, programName, name) {
            const program = this.current.shareGroup.programs.get(programName);
            if (!program || !program.linked || !program.link) return null;
            const reflection = program.link.reflection;
            if (kind === LOCATION_KIND_ATTRIB) {
                // glGetAttribLocation
                const attribute = reflection.attributes.find(a => a.name === name);
                if (!attribute) return { location: -1, type: 0, size: 0 };
                return { location: attribute.location,
                         type: glslTypeEnum(attribute.glslType),
                         size: 1 };
            }
            // glGetUniformLocation. GL says name and name[0] are the same
            // location, and name[i] is location + i.
            let lookupName = name;
            let element = 0;
            const match = /^(.*)\[(\d+)\]$/.exec(name);
            if (match) { lookupName = match[1]; element = parseInt(match[2], 10); }
            const uniform = program.uniformByName.get(lookupName);
            if (!uniform) return { location: -1, type: 0, size: 0 };
            if (uniform.arraySize && element >= uniform.arraySize)
                return { location: -1, type: 0, size: 0 };
            return {
                location: uniform.location + element,
                type: glslTypeEnum(uniform.glslType ||
                    samplerTypeName(uniform)),
                size: uniform.arraySize || 1,
            };
        },
        readUniform(programName, location, valueKind) {
            const program = this.current.shareGroup.programs.get(programName);
            if (!program || !program.linked) return null;
            const entry = program.uniformByLocation.get(location);
            if (!entry) return null;
            if (entry.sampler) {
                const key = entry.sampler.name +
                    (entry.sampler.arraySize ? "[" + entry.element + "]" : "");
                return [program.samplerUnits.get(key) || 0];
            }
            const uniform = entry.uniform;
            const stride = uniform.arraySize ? uniform.arrayStrideBytes : 0;
            const base = uniform.offsetBytes + entry.element * stride;
            const values = [];
            if (uniform.kind === "matrix") {
                const columnStride = uniform.matrixColumnStrideBytes;
                for (let c = 0; c < uniform.columns; ++c)
                    for (let r = 0; r < uniform.rows; ++r)
                        values.push(program.uniformFloats[
                            (base + c * columnStride) / 4 + r]);
            } else {
                for (let c = 0; c < uniform.components; ++c) {
                    values.push(valueKind === 2 || uniform.baseType !== "float" ?
                        program.uniformInts[(base >> 2) + c] :
                        program.uniformFloats[(base >> 2) + c]);
                }
            }
            return values;
        },
        queryObjectiv(kind, name, pname) {
            const group = this.current.shareGroup;
            if (kind === 1) {                     // shader
                const shader = group.shaders.get(name);
                if (!shader) return null;
                switch (pname) {
                case GL.COMPILE_STATUS:
                    return shader.compiled && shader.compiled.ok ? 1 : 0;
                case GL.INFO_LOG_LENGTH:
                    return shader.compiled ? shader.compiled.log.length + 1 : 1;
                case GL.SHADER_SOURCE_LENGTH: return shader.source.length + 1;
                case GL.SHADER_TYPE: return shader.type;
                case GL.DELETE_STATUS: return 0;
                default: return 0;
                }
            }
            if (kind === 2) {                     // program
                const program = group.programs.get(name);
                if (!program) return null;
                const reflection = program.link ? program.link.reflection : null;
                switch (pname) {
                case GL.LINK_STATUS: return program.linked ? 1 : 0;
                case GL.VALIDATE_STATUS: return program.linked ? 1 : 0;
                case GL.INFO_LOG_LENGTH: return program.log.length + 1;
                case GL.ATTACHED_SHADERS: return program.shaders.size;
                case GL.ACTIVE_UNIFORMS:
                    return reflection ?
                        reflection.uniforms.length + reflection.samplers.length : 0;
                case GL.ACTIVE_ATTRIBUTES:
                    return reflection ? reflection.attributes.length : 0;
                case GL.ACTIVE_UNIFORM_MAX_LENGTH:
                    return reflection ? maxNameLength(reflection.uniforms,
                        reflection.samplers) : 1;
                case GL.ACTIVE_ATTRIBUTE_MAX_LENGTH:
                    return reflection ? maxNameLength(reflection.attributes) : 1;
                case GL.DELETE_STATUS: return 0;
                default: return 0;
                }
            }
            // Occlusion query object.
            const query = this.queries.get(name);
            if (!query) return null;
            if (pname === GL.QUERY_RESULT_AVAILABLE) return query.ready ? 1 : 0;
            if (pname === GL.QUERY_RESULT) return query.result >>> 0;
            return 0;
        },
        queryObjectLog(kind, name) {
            const group = this.current.shareGroup;
            if (kind === 1) {
                const shader = group.shaders.get(name);
                return shader ? (shader.compiled ? shader.compiled.log : "") : null;
            }
            const program = group.programs.get(name);
            return program ? program.log : null;
        },
        queryActive(kind, programName, index) {
            const program = this.current.shareGroup.programs.get(programName);
            if (!program || !program.link) return null;
            const reflection = program.link.reflection;
            if (kind === ACTIVE_KIND_ATTRIB) {
                const attribute = reflection.attributes[index];
                if (!attribute) return null;
                return { name: attribute.name, size: 1,
                         type: glslTypeEnum(attribute.glslType) };
            }
            const all = reflection.uniforms.concat(reflection.samplers);
            const uniform = all[index];
            if (!uniform) return null;
            return {
                name: uniform.arraySize ? uniform.name + "[0]" : uniform.name,
                size: uniform.arraySize || 1,
                type: glslTypeEnum(uniform.glslType || samplerTypeName(uniform)),
            };
        },
        queryProgramivARB(target, pname) {
            const program = this.arbProgramFor(target);
            if (pname >= GL.PROGRAM_ALU_INSTRUCTIONS_ARB && pname <= GL.MAX_PROGRAM_NATIVE_TEX_INDIRECTIONS_ARB) {
                if (target !== GL.FRAGMENT_PROGRAM_ARB) return null;
                if (pname >= GL.MAX_PROGRAM_ALU_INSTRUCTIONS_ARB) return 4096;
                const field = ["aluInstructionCount", "textureInstructionCount", "textureIndirections"][(pname - GL.PROGRAM_ALU_INSTRUCTIONS_ARB) % 3];
                return program && program.compiled && program.compiled.ok ? program.compiled.reflection[field] : 0;
            }
            switch (pname) {
            case GL.PROGRAM_LENGTH_ARB:
                return program ? program.source.length : 0;
            case GL.PROGRAM_FORMAT_ARB:
                return GL.PROGRAM_FORMAT_ASCII_ARB;
            case GL.PROGRAM_BINDING_ARB:
                return target === GL.VERTEX_PROGRAM_ARB ?
                    this.current.arbVertexProgram : this.current.arbFragmentProgram;
            case GL.PROGRAM_INSTRUCTIONS_ARB:
            case GL.PROGRAM_NATIVE_INSTRUCTIONS_ARB:
                return program && program.compiled && program.compiled.ok ?
                    program.compiled.reflection.instructionCount : 0;
            case GL.PROGRAM_TEMPORARIES_ARB:
            case GL.PROGRAM_NATIVE_TEMPORARIES_ARB:
                return program && program.compiled && program.compiled.ok ?
                    program.compiled.reflection.temporaryCount : 0;
            case GL.PROGRAM_PARAMETERS_ARB:
            case GL.PROGRAM_NATIVE_PARAMETERS_ARB:
                return program && program.compiled && program.compiled.ok ? program.compiled.reflection.parameterCount : 0;
            case GL.PROGRAM_ATTRIBS_ARB:
            case GL.PROGRAM_NATIVE_ATTRIBS_ARB:
                return program && program.compiled && program.compiled.ok ? program.compiled.reflection.attributeCount : 0;
            case GL.PROGRAM_ADDRESS_REGISTERS_ARB:
            case GL.PROGRAM_NATIVE_ADDRESS_REGISTERS_ARB:
                return program && program.compiled && program.compiled.ok ? program.compiled.reflection.addressRegisterCount : 0;
            case GL.MAX_PROGRAM_ATTRIBS_ARB:
            case GL.MAX_PROGRAM_NATIVE_ATTRIBS_ARB: return 16;
            case GL.MAX_PROGRAM_ADDRESS_REGISTERS_ARB:
            case GL.MAX_PROGRAM_NATIVE_ADDRESS_REGISTERS_ARB: return arbProgram.MAX_ADDRESS_REGISTERS;
            case GL.MAX_PROGRAM_PARAMETERS_ARB:
            case GL.MAX_PROGRAM_NATIVE_PARAMETERS_ARB:
                return arbProgram.MAX_PROGRAM_BINDINGS;
            case GL.MAX_PROGRAM_ENV_PARAMETERS_ARB:
            case GL.MAX_PROGRAM_LOCAL_PARAMETERS_ARB:
                return arbProgram.parameterLimit(target === GL.VERTEX_PROGRAM_ARB ? "vertex" : "fragment");
            case GL.MAX_PROGRAM_INSTRUCTIONS_ARB:
            case GL.MAX_PROGRAM_NATIVE_INSTRUCTIONS_ARB:
                return 4096;
            case GL.MAX_PROGRAM_TEMPORARIES_ARB:
            case GL.MAX_PROGRAM_NATIVE_TEMPORARIES_ARB:
                return arbProgram.MAX_TEMPORARIES;
            case GL.PROGRAM_UNDER_NATIVE_LIMITS_ARB:
                return program && program.compiled && program.compiled.ok ? 1 : 0;
            case GL.PROGRAM_ERROR_POSITION_ARB:
                // -1 means "the last ProgramString succeeded"; otherwise the
                // character offset the parser stopped at.
                return this.current && this.current.arbErrorPosition !== undefined ?
                    this.current.arbErrorPosition : -1;
            default:
                return 0;
            }
        },
        queryProgramParameterARB(view, offset, size, doublePrecision) {
            if (size < 24) throw new GLStreamError("ARB query record is short");
            // FV and DV share the header
            const F = protocol.F.QUERY_PROGRAM_PARAMETER_FV_ARB;
            // answered on the CPU side already (gl_shadow_arb.js)
            if (view.getUint32(offset + F.status, true) !== SYNC_STATUS_PENDING) return;
            const kind = view.getUint32(offset + F.parameter_kind, true);
            const target = view.getUint32(offset + F.target, true);
            const index = view.getUint32(offset + F.index, true);
            const env = kind === PROGRAM_PARAMETER_ENV;
            const program = env ? null : this.arbProgramFor(target);
            const stride = doublePrecision ? 8 : 4;
            if ((!env && !program) || index >= arbProgram.parameterLimit(target === GL.VERTEX_PROGRAM_ARB ? "vertex" : "fragment") ||
                    24 + 4 * stride > size) {
                view.setUint32(offset + F.status, SYNC_STATUS_FAILED, true);
                return;
            }
            const storage = env ? this.arbEnvironment(target) : arbParameterStorage(program, kind);
            view.setUint32(offset + F.status, SYNC_STATUS_OK, true);
            for (let c = 0; c < 4; ++c) {
                const at = offset + 24 + c * stride;
                if (doublePrecision) view.setFloat64(at, storage[index * 4 + c], true);
                else view.setFloat32(at, storage[index * 4 + c], true);
            }
        },
        queryString(pname) {
            const capability = glCaps.string(this.capabilities(), pname);
            if (capability !== undefined) return capability;
            switch (pname) {
            case GL.PROGRAM_ERROR_STRING_ARB:
                // Empty after a successful ProgramString, which is what the
                // extension specifies -- not null, which would leave the guest
                // reporting "unsupported query" for a legal one.
                return this.current ? (this.current.arbErrorString || "") : "";
            default: return null;
            }
        },
        queryInteger(pname) {
            const capability = glCaps.integer(this.capabilities(), pname);
            if (capability !== undefined) return capability;
            const s = this.current;
            switch (pname) {
            case GL.PROGRAM_ERROR_POSITION_ARB:
                // This is the glGetIntegerv spelling, which is the one the
                // extension actually defines and the one the guest uses. It
                // must be -1 when the last glProgramStringARB succeeded: the
                // generic default of 0 reads as "an error at character 0", so
                // a conformance viewer reports a failure on a good program.
                return s && s.arbErrorPosition !== undefined ?
                    s.arbErrorPosition : -1;
            default: break;
            }
            if (!s) return null;
            switch (pname) {
            case GL.VIEWPORT: return s.viewport.width;
            case GL.ACTIVE_TEXTURE: return GL.TEXTURE0 + s.activeTexture;
            case GL.CLIENT_ACTIVE_TEXTURE:
                return GL.TEXTURE0 + s.clientActiveTexture;
            case GL.CURRENT_PROGRAM: return s.currentProgram;
            case GL.ARRAY_BUFFER_BINDING: return s.arrayBuffer;
            case GL.ELEMENT_ARRAY_BUFFER_BINDING: return s.elementArrayBuffer;
            case GL.PIXEL_PACK_BUFFER_BINDING: return s.pixelPackBuffer;
            case GL.PIXEL_UNPACK_BUFFER_BINDING: return s.pixelUnpackBuffer;
            case GL.FRAMEBUFFER_BINDING: return s.drawFramebuffer;
            case GL.RENDERBUFFER_BINDING: return s.renderbuffer;
            case GL.TEXTURE_BINDING_2D:
                return s.textureUnits[s.activeTexture].bindings[GL.TEXTURE_2D] || 0;
            case GL.MATRIX_MODE: return s.matrixMode;
            case GL.DEPTH_FUNC: return s.depthFunc;
            case GL.CULL_FACE_MODE: return s.cullFace;
            case GL.FRONT_FACE: return s.frontFace;
            case GL.SHADE_MODEL: return s.shadeModel;
            case GL.BLEND_SRC: return s.blend.srcRGB;
            case GL.BLEND_DST: return s.blend.dstRGB;
            case GL.ALPHA_TEST_FUNC: return s.alphaFunc.func;
            case GL.STENCIL_FUNC: return s.stencil.front.func;
            case GL.STENCIL_REF: return s.stencil.front.ref;
            case GL.STENCIL_VALUE_MASK: return s.stencil.front.valueMask;
            case GL.STENCIL_WRITEMASK: return s.stencil.front.writeMask;
            case GL.PACK_ALIGNMENT: return s.pixelStore.packAlignment;
            case GL.UNPACK_ALIGNMENT: return s.pixelStore.unpackAlignment;
            case GL.RENDER_MODE: return s.renderMode;
            default: return 0;
            }
        },
    };
    function install(executor) {
        if (executor.rendererTestDiagnostics || executor.options.rendererTestDiagnostics !== true) return;
        executor.rendererTestDiagnostics = true;
        for (const [name, value] of Object.entries(diagnosticMethods)) Object.defineProperty(executor, name, { value, configurable: true });
        const define = (name, handler, options) => {
            const signature = protocol.SIGNATURES[name];
            if (signature?.[1].length) handler.signature = signature[1];
            handler.glName = signature?.[0] || name;
            if (options?.needsContext === false) handler.needsContext = false;
            executor.handlers[protocol.GLFN[name]] = handler;
        };
        define("QUERY_ERROR", function(a, bytes, view, offset, size, metadata) {
            if (size < 16) throw new GLStreamError("query-error record is short");
            const state = this.current;
            const error = state ? state.error : GL.NO_ERROR;
            const F = protocol.F.QUERY_ERROR;
            if (view.getUint32(offset + F.status, true) !== SYNC_STATUS_PENDING) {
                // Old unfiltered streams may have latched the same CPU
                // rejection again. Consume that duplicate, preserving any
                // different renderer error for the next query.
                if (state && error === view.getUint32(offset + F.value, true)) state.error = GL.NO_ERROR;
                return;
            }
            if (state) state.error = GL.NO_ERROR;
            this.answerGuest(bytes, metadata, [[offset + F.value, new Uint8Array(new Uint32Array([error]).buffer)],
                [offset + F.status, new Uint8Array(new Uint32Array([SYNC_STATUS_OK]).buffer)]]);
        }, { needsContext: false });

        define("QUERY_INTEGER", function(a, bytes, view, offset, size) {
            if (size < 16) throw new GLStreamError("query-integer record is short");
            // answered on the CPU side already (gl_shadow.js)
            if (view.getUint32(offset + protocol.F.QUERY_INTEGER.status, true) !== SYNC_STATUS_PENDING) return;
            const pname = view.getUint32(offset + protocol.F.QUERY_INTEGER.pname, true);
            const value = this.queryInteger(pname);
            if (value === null) {
                view.setUint32(offset + protocol.F.QUERY_INTEGER.status, SYNC_STATUS_FAILED, true);
                return;
            }
            view.setUint32(offset + protocol.F.QUERY_INTEGER.status, SYNC_STATUS_OK, true);
            view.setUint32(offset + protocol.F.QUERY_INTEGER.value, value >>> 0, true);
        }, { needsContext: false });

        define("QUERY_GL_STRING", function(a, bytes, view, offset, size) {
            if (size < 16) throw new GLStreamError("query-string record is short");
            // answered on the CPU side already (gl_shadow.js)
            if (view.getUint32(offset + protocol.F.QUERY_GL_STRING.status, true) !== SYNC_STATUS_PENDING) return;
            const pname = view.getUint32(offset + protocol.F.QUERY_GL_STRING.name, true);
            const capacity = view.getUint32(offset + protocol.F.QUERY_GL_STRING.data_size, true);
            const text = this.queryString(pname);
            if (text === null || 16 + capacity > size) {
                view.setUint32(offset + protocol.F.QUERY_GL_STRING.status, SYNC_STATUS_FAILED, true);
                return;
            }
            const encoded = [];
            for (let i = 0; i < text.length; ++i) encoded.push(text.charCodeAt(i) & 0xff);
            encoded.push(0);
            view.setUint32(offset + protocol.F.QUERY_GL_STRING.status, SYNC_STATUS_OK, true);
            view.setUint32(offset + protocol.F.QUERY_GL_STRING.length, encoded.length, true);
            const limit = Math.min(encoded.length, capacity);
            for (let i = 0; i < limit; ++i)
                bytes[offset + 16 + i] = encoded[i];
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
            if (32 + nameLength > size) {
                view.setUint32(offset + protocol.F.QUERY_LOCATION.status, SYNC_STATUS_FAILED, true);
                return;
            }
            const name = readCString(bytes, offset + 32, nameLength);
            const info = this.queryLocation(kind, programName, name);
            if (!info) {
                view.setUint32(offset + protocol.F.QUERY_LOCATION.status, SYNC_STATUS_FAILED, true);
                return;
            }
            view.setUint32(offset + protocol.F.QUERY_LOCATION.status, SYNC_STATUS_OK, true);
            view.setUint32(offset + protocol.F.QUERY_LOCATION.result, info.location >>> 0, true);
            view.setUint32(offset + protocol.F.QUERY_LOCATION.value_type, info.type >>> 0, true);
            view.setUint32(offset + protocol.F.QUERY_LOCATION.value_count, info.size >>> 0, true);
        });

        define("QUERY_UNIFORM", function(a, bytes, view, offset, size) {
            if (size < 32) throw new GLStreamError("query-uniform record is short");
            // answered on the CPU side already (gl_shadow_glsl.js)
            if (view.getUint32(offset + protocol.F.QUERY_UNIFORM.status, true) !== SYNC_STATUS_PENDING) return;
            const programName = view.getUint32(offset + protocol.F.QUERY_UNIFORM.program, true);
            const location = view.getInt32(offset + protocol.F.QUERY_UNIFORM.location, true);
            const valueKind = view.getUint32(offset + protocol.F.QUERY_UNIFORM.value_kind, true);
            const values = this.readUniform(programName, location, valueKind);
            if (!values || !values.length || values.length > 16) {
                view.setUint32(offset + protocol.F.QUERY_UNIFORM.status, SYNC_STATUS_FAILED, true);
                return;
            }
            view.setUint32(offset + protocol.F.QUERY_UNIFORM.status, SYNC_STATUS_OK, true);
            view.setUint32(offset + protocol.F.QUERY_UNIFORM.value_count, values.length, true);
            for (let i = 0; i < values.length; ++i) {
                if (valueKind === 2) view.setInt32(offset + 32 + i * 4, values[i] | 0, true);
                else view.setFloat32(offset + 32 + i * 4, values[i], true);
            }
        });

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
            const value = this.queryObjectiv(kind, name, pname);
            if (value === null) {
                view.setUint32(offset + protocol.F.QUERY_OBJECT_IV.status, SYNC_STATUS_FAILED, true);
                return;
            }
            view.setUint32(offset + protocol.F.QUERY_OBJECT_IV.status, SYNC_STATUS_OK, true);
            view.setUint32(offset + protocol.F.QUERY_OBJECT_IV.value, value >>> 0, true);
        });

        define("QUERY_OBJECT_LOG", function(a, bytes, view, offset, size) {
            if (size < 24) throw new GLStreamError("query-log record is short");
            // answered on the CPU side already (gl_shadow_glsl.js)
            if (view.getUint32(offset + protocol.F.QUERY_OBJECT_LOG.status, true) !== SYNC_STATUS_PENDING) return;
            const kind = view.getUint32(offset + protocol.F.QUERY_OBJECT_LOG.object_kind, true);
            const name = view.getUint32(offset + protocol.F.QUERY_OBJECT_LOG.name, true);
            const capacity = view.getUint32(offset + protocol.F.QUERY_OBJECT_LOG.buf_size, true);
            const text = this.queryObjectLog(kind, name);
            if (text === null || 24 + capacity > size) {
                view.setUint32(offset + protocol.F.QUERY_OBJECT_LOG.status, SYNC_STATUS_FAILED, true);
                return;
            }
            view.setUint32(offset + protocol.F.QUERY_OBJECT_LOG.status, SYNC_STATUS_OK, true);
            view.setUint32(offset + protocol.F.QUERY_OBJECT_LOG.length,
                writeCString(bytes, offset + 24, capacity,
                    text), true);
        });

        define("QUERY_ACTIVE", function(a, bytes, view, offset, size) {
            if (size < 40) throw new GLStreamError("query-active record is short");
            // answered on the CPU side already (gl_shadow_glsl.js)
            if (view.getUint32(offset + protocol.F.QUERY_ACTIVE.status, true) !== SYNC_STATUS_PENDING) return;
            const kind = view.getUint32(offset + protocol.F.QUERY_ACTIVE.active_kind, true);
            const programName = view.getUint32(offset + protocol.F.QUERY_ACTIVE.program, true);
            const index = view.getUint32(offset + protocol.F.QUERY_ACTIVE.index, true);
            const capacity = view.getUint32(offset + protocol.F.QUERY_ACTIVE.buf_size, true);
            const info = this.queryActive(kind, programName, index);
            if (!info || 40 + capacity > size) {
                view.setUint32(offset + protocol.F.QUERY_ACTIVE.status, SYNC_STATUS_FAILED, true);
                return;
            }
            view.setUint32(offset + protocol.F.QUERY_ACTIVE.status, SYNC_STATUS_OK, true);
            view.setUint32(offset + protocol.F.QUERY_ACTIVE.length,
                writeCString(bytes, offset + 40, capacity,
                    info.name), true);
            view.setUint32(offset + protocol.F.QUERY_ACTIVE.size, info.size >>> 0, true);
            view.setUint32(offset + protocol.F.QUERY_ACTIVE.type, info.type >>> 0, true);
        });

        define("CHECK_FRAMEBUFFER_STATUS", function(a, bytes, view, offset, size) {
            if (size < 16) throw new GLStreamError("fbo-status record is short");
            // answered on the CPU side already (gl_shadow_objects.js)
            if (view.getUint32(offset + protocol.F.CHECK_FRAMEBUFFER_STATUS.status, true) !== SYNC_STATUS_PENDING) return;
            const target = view.getUint32(offset + protocol.F.CHECK_FRAMEBUFFER_STATUS.target, true);
            const status = this.checkFramebufferStatus(target);
            view.setUint32(offset + protocol.F.CHECK_FRAMEBUFFER_STATUS.status, SYNC_STATUS_OK, true);
            view.setUint32(offset + protocol.F.CHECK_FRAMEBUFFER_STATUS.result, status >>> 0, true);
        });

        define("QUERY_PROGRAM_IV_ARB", function(a, bytes, view, offset, size) {
            if (size < 16) throw new GLStreamError("ARB query record is short");
            // answered on the CPU side already (gl_shadow_arb.js)
            if (view.getUint32(offset + protocol.F.QUERY_PROGRAM_IV_ARB.status, true) !== SYNC_STATUS_PENDING) return;
            const target = view.getUint32(offset + protocol.F.QUERY_PROGRAM_IV_ARB.target, true);
            const pname = view.getUint32(offset + protocol.F.QUERY_PROGRAM_IV_ARB.pname, true);
            const value = this.queryProgramivARB(target, pname);
            view.setUint32(offset + protocol.F.QUERY_PROGRAM_IV_ARB.status, value === null ?
                SYNC_STATUS_FAILED : SYNC_STATUS_OK, true);
            if (value !== null) view.setUint32(offset + protocol.F.QUERY_PROGRAM_IV_ARB.value, value >>> 0, true);
        });

        define("QUERY_PROGRAM_PARAMETER_FV_ARB", function(a, bytes, view, offset, size) {
            this.queryProgramParameterARB(view, offset, size, false);
        });

        define("QUERY_PROGRAM_PARAMETER_DV_ARB", function(a, bytes, view, offset, size) {
            this.queryProgramParameterARB(view, offset, size, true);
        });

        define("QUERY_PROGRAM_STRING_ARB", function(a, bytes, view, offset, size) {
            if (size < 24) throw new GLStreamError("ARB string record is short");
            // answered on the CPU side already (gl_shadow_arb.js)
            if (view.getUint32(offset + protocol.F.QUERY_PROGRAM_STRING_ARB.status, true) !== SYNC_STATUS_PENDING) return;
            const target = view.getUint32(offset + protocol.F.QUERY_PROGRAM_STRING_ARB.target, true);
            const capacity = view.getUint32(offset + protocol.F.QUERY_PROGRAM_STRING_ARB.data_size, true);
            const program = this.arbProgramFor(target);
            if (!program || 24 + capacity > size) {
                view.setUint32(offset + protocol.F.QUERY_PROGRAM_STRING_ARB.status, SYNC_STATUS_FAILED, true);
                return;
            }
            const text = program.source;
            const written = Math.min(text.length, capacity);
            view.setUint32(offset + protocol.F.QUERY_PROGRAM_STRING_ARB.status, SYNC_STATUS_OK, true);
            view.setUint32(offset + protocol.F.QUERY_PROGRAM_STRING_ARB.length, written, true);
            for (let i = 0; i < written; ++i)
                bytes[offset + 24 + i] = text.charCodeAt(i) & 0xff;
        });
    }
    const proto = moduleAPI.GLWebGPUExecutor.prototype, execute = proto.executeBatch, current = proto.makeCurrent, refuse = proto.refuse, invalid = proto.invalidState;
    // Raw tests also inspect diagnostic values before submitting a batch.
    // Lazy non-enumerable methods never enter renderer snapshots.
    for (const name of Object.keys(diagnosticMethods)) Object.defineProperty(proto, name, {
        configurable: true, get() { if (this.options.rendererTestDiagnostics !== true) return undefined; install(this); return this[name]; },
    });
    proto.executeBatch = function(...args) { install(this); return execute.apply(this, args); };
    proto.makeCurrent = function(...args) {
        const result = current.apply(this, args);
        if (this.options.rendererTestDiagnostics === true && this.current && this.current.error === undefined) this.current.error = GL.NO_ERROR;
        return result;
    };
    const programString = proto.programStringARB;
    proto.programStringARB = function(target, source) {
        if (this.options.rendererTestDiagnostics !== true) return programString.call(this, target, source);
        const compiled = arbProgram.compileARBProgram(source, {});
        if (compiled.ok && compiled.target !== (target === GL.VERTEX_PROGRAM_ARB ? "vertex" : "fragment")) {
            compiled.ok = false;compiled.log = "ERROR: program header does not match the target";compiled.errorPosition = 0;
        }
        this.arbErrorString = this.current.arbErrorString = compiled.ok ? "" : compiled.log;
        this.arbErrorPosition = this.current.arbErrorPosition = compiled.ok ? -1 : Math.max(0, compiled.errorPosition || 0);
        if (!compiled.ok) { this.invalidState(GL.INVALID_OPERATION);return; }
        return programString.call(this, target, source);
    };
    const latch = (executor, code) => { if (executor.current && !executor.current.error) executor.current.error = code; };
    proto.invalidState = function(code) {
        if (this.options.rendererTestDiagnostics !== true) return invalid.call(this, code);
        latch(this, code);
    };
    proto.refuse = function(op, reason, details, code) {
        if (this.options.rendererTestDiagnostics === true && code) latch(this, code);
        return refuse.call(this, op, reason, details);
    };
})(typeof globalThis !== "undefined" ? globalThis : this);
