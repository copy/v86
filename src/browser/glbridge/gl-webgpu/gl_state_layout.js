// The canonical OpenGL "state" uniform block.
//
// Three things need to agree byte for byte about where gl_ModelViewMatrix
// lives: the fixed-function WGSL generator, the GLSL compatibility built-ins
// in gl_shader_translator.js, and the executor code that fills the buffer.
// Historically that kind of agreement is maintained by three copies of a
// struct and a bug report; here there is one table and everyone derives from
// it.
//
// Fields are allocated per program, not globally: a shader that only touches
// gl_ModelViewProjectionMatrix gets a 16-float block, not the ~4 KB the full
// table would occupy. The unit of trimming is the *field*, and for the array
// state (lights, texture matrices, clip planes) the whole array -- because
// GLSL lets a loop index gl_LightSource[i] with a non-constant i, and an array
// that only sometimes exists cannot be indexed dynamically.
//
// Matrix layout: GL and WGSL are both column-major, so a mat4 is a straight
// 16-float copy. A WGSL mat3x3 in the uniform address space pads each column
// to 16 bytes, hence 12 floats for gl_NormalMatrix.
//
// See docs/glbridge.md (CPU ownership and snapshot resources).

(function(global) {
    "use strict";

    const MAX_LIGHTS = 8;
    const MAX_PROGRAM_MATRICES = 8;
    const MAX_TEXTURE_UNITS = 8;
    const MAX_TEXTURE_COORDS = 8;
    const MAX_CLIP_PLANES = 6;

    /* ---------- helpers used by the field writers ---------- */

    function writeVec4(out, offset, v) {
        out[offset] = v[0]; out[offset + 1] = v[1];
        out[offset + 2] = v[2]; out[offset + 3] = v[3];
        return offset + 4;
    }

    function writeMat4(out, offset, m) {
        for (let i = 0; i < 16; ++i) out[offset + i] = m[i];
        return offset + 16;
    }

    /* A WGSL mat3x3<f32> is three vec4-aligned columns. The source is a
     * 9-float column-major GL 3x3. */
    function writeMat3(out, offset, m) {
        out[offset] = m[0]; out[offset + 1] = m[1]; out[offset + 2] = m[2];
        out[offset + 3] = 0;
        out[offset + 4] = m[3]; out[offset + 5] = m[4]; out[offset + 6] = m[5];
        out[offset + 7] = 0;
        out[offset + 8] = m[6]; out[offset + 9] = m[7]; out[offset + 10] = m[8];
        out[offset + 11] = 0;
        return offset + 12;
    }

    function writeMaterial(out, offset, m) {
        offset = writeVec4(out, offset, m.emission);
        offset = writeVec4(out, offset, m.ambient);
        offset = writeVec4(out, offset, m.diffuse);
        offset = writeVec4(out, offset, m.specular);
        out[offset] = m.shininess;
        out[offset + 1] = 0; out[offset + 2] = 0; out[offset + 3] = 0;
        return offset + 4;
    }

    /* gl_LightSourceParameters, laid out as 8 vec4 so that a WGSL struct with
     * the same field order needs no padding surprises. */
    function writeLight(out, offset, l) {
        offset = writeVec4(out, offset, l.ambient);
        offset = writeVec4(out, offset, l.diffuse);
        offset = writeVec4(out, offset, l.specular);
        offset = writeVec4(out, offset, l.position);
        offset = writeVec4(out, offset, l.halfVector);
        out[offset] = l.spotDirection[0];
        out[offset + 1] = l.spotDirection[1];
        out[offset + 2] = l.spotDirection[2];
        out[offset + 3] = l.spotExponent;
        offset += 4;
        out[offset] = l.spotCutoff;
        out[offset + 1] = l.spotCosCutoff;
        out[offset + 2] = l.constantAttenuation;
        out[offset + 3] = l.linearAttenuation;
        offset += 4;
        out[offset] = l.quadraticAttenuation;
        out[offset + 1] = 0; out[offset + 2] = 0; out[offset + 3] = 0;
        return offset + 4;
    }

    function writeLightProduct(out, offset, p) {
        offset = writeVec4(out, offset, p.ambient);
        offset = writeVec4(out, offset, p.diffuse);
        offset = writeVec4(out, offset, p.specular);
        return offset;
    }

    /* ---------- WGSL struct declarations shared by the fields ---------- */

    const STRUCT_DECLS = {
        GLMaterial:
            "struct GLMaterial {\n" +
            "    emission : vec4<f32>,\n" +
            "    ambient : vec4<f32>,\n" +
            "    diffuse : vec4<f32>,\n" +
            "    specular : vec4<f32>,\n" +
            "    shininess : f32,\n" +
            "    _pad0 : f32,\n" +
            "    _pad1 : f32,\n" +
            "    _pad2 : f32,\n" +
            "}",
        GLLight:
            "struct GLLight {\n" +
            "    ambient : vec4<f32>,\n" +
            "    diffuse : vec4<f32>,\n" +
            "    specular : vec4<f32>,\n" +
            "    position : vec4<f32>,\n" +
            "    halfVector : vec4<f32>,\n" +
            "    spotDirection : vec3<f32>,\n" +
            "    spotExponent : f32,\n" +
            "    spotCutoff : f32,\n" +
            "    spotCosCutoff : f32,\n" +
            "    constantAttenuation : f32,\n" +
            "    linearAttenuation : f32,\n" +
            "    quadraticAttenuation : f32,\n" +
            "    _pad0 : f32,\n" +
            "    _pad1 : f32,\n" +
            "    _pad2 : f32,\n" +
            "}",
        GLLightProduct:
            "struct GLLightProduct {\n" +
            "    ambient : vec4<f32>,\n" +
            "    diffuse : vec4<f32>,\n" +
            "    specular : vec4<f32>,\n" +
            "}",
    };

    /*
     * The field table.
     *
     * id       stable key used by signatures and by the shader cache
     * wgsl     field name inside the generated GLState struct
     * type     WGSL type text
     * floats   size in f32 units (already includes WGSL padding)
     * needs    struct declarations this field's type depends on
     * write    fills `out` starting at `offset`, returns the next offset
     */
    const FIELDS = [
        /* --- matrices --- */
        { id: "modelview", wgsl: "modelview", type: "mat4x4<f32>", floats: 16,
          write: (s, o, off) => writeMat4(o, off, s.matrices.modelview) },
        { id: "projection", wgsl: "projection", type: "mat4x4<f32>", floats: 16,
          write: (s, o, off) => writeMat4(o, off, s.matrices.projection) },
        { id: "mvp", wgsl: "mvp", type: "mat4x4<f32>", floats: 16,
          write: (s, o, off) => writeMat4(o, off, s.matrices.mvp) },
        { id: "normalMatrix", wgsl: "normalMatrix", type: "mat3x3<f32>", floats: 12,
          write: (s, o, off) => writeMat3(o, off, s.matrices.normal) },
        { id: "modelviewInverse", wgsl: "modelviewInverse", type: "mat4x4<f32>", floats: 16,
          write: (s, o, off) => writeMat4(o, off, s.matrices.modelviewInverse) },
        { id: "modelviewTranspose", wgsl: "modelviewTranspose", type: "mat4x4<f32>", floats: 16,
          write: (s, o, off) => writeMat4(o, off, s.matrices.modelviewTranspose) },
        { id: "modelviewInverseTranspose", wgsl: "modelviewInverseTranspose", type: "mat4x4<f32>", floats: 16,
          write: (s, o, off) => writeMat4(o, off, s.matrices.modelviewInverseTranspose) },
        { id: "projectionInverse", wgsl: "projectionInverse", type: "mat4x4<f32>", floats: 16,
          write: (s, o, off) => writeMat4(o, off, s.matrices.projectionInverse) },
        { id: "projectionTranspose", wgsl: "projectionTranspose", type: "mat4x4<f32>", floats: 16,
          write: (s, o, off) => writeMat4(o, off, s.matrices.projectionTranspose) },
        { id: "projectionInverseTranspose", wgsl: "projectionInverseTranspose", type: "mat4x4<f32>", floats: 16,
          write: (s, o, off) => writeMat4(o, off, s.matrices.projectionInverseTranspose) },
        { id: "mvpInverse", wgsl: "mvpInverse", type: "mat4x4<f32>", floats: 16,
          write: (s, o, off) => writeMat4(o, off, s.matrices.mvpInverse) },
        { id: "mvpTranspose", wgsl: "mvpTranspose", type: "mat4x4<f32>", floats: 16,
          write: (s, o, off) => writeMat4(o, off, s.matrices.mvpTranspose) },
        { id: "mvpInverseTranspose", wgsl: "mvpInverseTranspose", type: "mat4x4<f32>", floats: 16,
          write: (s, o, off) => writeMat4(o, off, s.matrices.mvpInverseTranspose) },

        ...["", "Inverse", "Transpose", "InverseTranspose"].map(suffix => ({
            id: "programMatrix" + suffix, wgsl: "programMatrix" + suffix,
            type: "array<mat4x4<f32>, " + MAX_PROGRAM_MATRICES + ">", floats: 16 * MAX_PROGRAM_MATRICES,
            write: (s, o, off) => {
                for (let i = 0; i < MAX_PROGRAM_MATRICES; ++i) off = writeMat4(o, off, s.matrices["program" + suffix][i]);
                return off;
            },
        })),

        /* Texture matrices are one array, not eight fields: GLSL allows
         * gl_TextureMatrix[i] with a runtime i. */
        { id: "textureMatrix", wgsl: "textureMatrix",
          type: "array<mat4x4<f32>, " + MAX_TEXTURE_COORDS + ">",
          floats: 16 * MAX_TEXTURE_COORDS,
          write: (s, o, off) => {
              for (let i = 0; i < MAX_TEXTURE_COORDS; ++i)
                  off = writeMat4(o, off, s.matrices.texture[i]);
              return off;
          } },
        { id: "textureMatrixInverse", wgsl: "textureMatrixInverse",
          type: "array<mat4x4<f32>, " + MAX_TEXTURE_COORDS + ">",
          floats: 16 * MAX_TEXTURE_COORDS,
          write: (s, o, off) => {
              for (let i = 0; i < MAX_TEXTURE_COORDS; ++i)
                  off = writeMat4(o, off, s.matrices.textureInverse[i]);
              return off;
          } },
        { id: "textureMatrixTranspose", wgsl: "textureMatrixTranspose",
          type: "array<mat4x4<f32>, " + MAX_TEXTURE_COORDS + ">",
          floats: 16 * MAX_TEXTURE_COORDS,
          write: (s, o, off) => {
              for (let i = 0; i < MAX_TEXTURE_COORDS; ++i)
                  off = writeMat4(o, off, s.matrices.textureTranspose[i]);
              return off;
          } },
        { id: "textureMatrixInverseTranspose", wgsl: "textureMatrixInverseTranspose",
          type: "array<mat4x4<f32>, " + MAX_TEXTURE_COORDS + ">",
          floats: 16 * MAX_TEXTURE_COORDS,
          write: (s, o, off) => {
              for (let i = 0; i < MAX_TEXTURE_COORDS; ++i)
                  off = writeMat4(o, off, s.matrices.textureInverseTranspose[i]);
              return off;
          } },

        /* --- lighting --- */
        { id: "lights", wgsl: "lights",
          type: "array<GLLight, " + MAX_LIGHTS + ">", needs: ["GLLight"],
          floats: 32 * MAX_LIGHTS,
          write: (s, o, off) => {
              for (let i = 0; i < MAX_LIGHTS; ++i)
                  off = writeLight(o, off, s.lights[i]);
              return off;
          } },
        { id: "frontMaterial", wgsl: "frontMaterial", type: "GLMaterial",
          needs: ["GLMaterial"], floats: 20,
          write: (s, o, off) => writeMaterial(o, off, s.material.front) },
        { id: "backMaterial", wgsl: "backMaterial", type: "GLMaterial",
          needs: ["GLMaterial"], floats: 20,
          write: (s, o, off) => writeMaterial(o, off, s.material.back) },
        { id: "lightModelAmbient", wgsl: "lightModelAmbient", type: "vec4<f32>",
          floats: 4,
          write: (s, o, off) => writeVec4(o, off, s.lightModel.ambient) },
        { id: "frontSceneColor", wgsl: "frontSceneColor", type: "vec4<f32>",
          floats: 4,
          write: (s, o, off) => writeVec4(o, off, s.derived.frontSceneColor) },
        { id: "backSceneColor", wgsl: "backSceneColor", type: "vec4<f32>",
          floats: 4,
          write: (s, o, off) => writeVec4(o, off, s.derived.backSceneColor) },
        { id: "frontLightProduct", wgsl: "frontLightProduct",
          type: "array<GLLightProduct, " + MAX_LIGHTS + ">",
          needs: ["GLLightProduct"], floats: 12 * MAX_LIGHTS,
          write: (s, o, off) => {
              for (let i = 0; i < MAX_LIGHTS; ++i)
                  off = writeLightProduct(o, off, s.derived.frontLightProduct[i]);
              return off;
          } },
        { id: "backLightProduct", wgsl: "backLightProduct",
          type: "array<GLLightProduct, " + MAX_LIGHTS + ">",
          needs: ["GLLightProduct"], floats: 12 * MAX_LIGHTS,
          write: (s, o, off) => {
              for (let i = 0; i < MAX_LIGHTS; ++i)
                  off = writeLightProduct(o, off, s.derived.backLightProduct[i]);
              return off;
          } },

        /* --- fog --- */
        { id: "fogColor", wgsl: "fogColor", type: "vec4<f32>", floats: 4,
          write: (s, o, off) => writeVec4(o, off, s.fog.color) },
        { id: "fogParams", wgsl: "fogParams", type: "vec4<f32>", floats: 4,
          /* density, start, end, scale = 1/(end-start); GLSL exposes these as
           * gl_Fog.density/.start/.end/.scale. */
          write: (s, o, off) => {
              const span = s.fog.end - s.fog.start;
              return writeVec4(o, off, [s.fog.density, s.fog.start, s.fog.end,
                  span !== 0 ? 1 / span : 0]);
          } },

        /* --- texture environment / coordinate generation --- */
        { id: "texEnvColor", wgsl: "texEnvColor",
          type: "array<vec4<f32>, " + MAX_TEXTURE_UNITS + ">",
          floats: 4 * MAX_TEXTURE_UNITS,
          write: (s, o, off) => {
              for (let i = 0; i < MAX_TEXTURE_UNITS; ++i)
                  off = writeVec4(o, off, s.texEnvColor[i]);
              return off;
          } },
        /* Each unit's LOD bias: the unit's TEXTURE_FILTER_CONTROL bias plus
         * its texture's TEXTURE_LOD_BIAS, four units a vec4. */
        { id: "textureLodBias", wgsl: "textureLodBias",
          type: "array<vec4<f32>, " + MAX_TEXTURE_UNITS / 4 + ">",
          floats: MAX_TEXTURE_UNITS,
          write: (s, o, off) => {
              for (let i = 0; i < MAX_TEXTURE_UNITS; i += 4)
                  off = writeVec4(o, off, s.textureLodBias.subarray(i, i + 4));
              return off;
          } },
        /* Each unit's texture border colour, in its base format's channels
         * (GL 2.1 table 3.15: a LUMINANCE border is (R, R, R, 1)). */
        { id: "textureBorderColor", wgsl: "textureBorderColor",
          type: "array<vec4<f32>, " + MAX_TEXTURE_UNITS + ">",
          floats: 4 * MAX_TEXTURE_UNITS,
          write: (s, o, off) => {
              for (let i = 0; i < MAX_TEXTURE_UNITS; ++i)
                  off = writeVec4(o, off, s.textureBorderColor[i]);
              return off;
          } },
        // Four vec4 rows per typed sampler binding, rather than per enabled
        // texture unit: GLSL/ARB instructions select their target explicitly.
        { id: "samplerState", wgsl: "samplerState", type: "array<vec4<f32>, 64>", floats: 256,
          write: (s, o, off) => {
              if (s.samplerState) o.set(s.samplerState, off);
              else o.fill(0, off, off + 256);
              return off + 256;
          } },
        /* Object/eye linear planes: 4 coordinates (S,T,R,Q) x 8 units, each a
         * pair of vec4 (object plane, eye plane). Flat array so the fixed
         * function generator can index it with a constant. */
        { id: "texGenPlanes", wgsl: "texGenPlanes",
          type: "array<vec4<f32>, " + (MAX_TEXTURE_UNITS * 8) + ">",
          floats: 4 * MAX_TEXTURE_UNITS * 8,
          write: (s, o, off) => {
              for (let u = 0; u < MAX_TEXTURE_UNITS; ++u) {
                  const gen = s.texGen[u];
                  for (let c = 0; c < 4; ++c) off = writeVec4(o, off, gen[c].objectPlane);
                  for (let c = 0; c < 4; ++c) off = writeVec4(o, off, gen[c].eyePlane);
              }
              return off;
          } },

        /* --- clipping, depth, point size, alpha test --- */
        { id: "clipPlanes", wgsl: "clipPlanes",
          type: "array<vec4<f32>, " + MAX_CLIP_PLANES + ">",
          floats: 4 * MAX_CLIP_PLANES,
          write: (s, o, off) => {
              for (let i = 0; i < MAX_CLIP_PLANES; ++i)
                  off = writeVec4(o, off, s.clipPlanes[i]);
              return off;
          } },
        { id: "depthRange", wgsl: "depthRange", type: "vec4<f32>", floats: 4,
          /* near, far, diff, unused -- matches gl_DepthRangeParameters. */
          write: (s, o, off) => writeVec4(o, off, [s.depthRange.near,
              s.depthRange.far, s.depthRange.far - s.depthRange.near, 0]) },
        { id: "pointParams", wgsl: "pointParams", type: "vec4<f32>", floats: 4,
          /* size, sizeMin, sizeMax, fadeThresholdSize */
          write: (s, o, off) => writeVec4(o, off, [s.point.size, s.point.sizeMin,
              s.point.sizeMax, s.point.fadeThreshold]) },
        { id: "pointAttenuation", wgsl: "pointAttenuation", type: "vec4<f32>", floats: 4,
          write: (s, o, off) => writeVec4(o, off, [s.point.attenuation[0],
              s.point.attenuation[1], s.point.attenuation[2], 0]) },
        { id: "alphaRef", wgsl: "alphaRef", type: "vec4<f32>", floats: 4,
          /* ref, unused... a vec4 because a lone f32 in a uniform struct still
           * costs 16 bytes of alignment; naming the padding avoids surprises. */
          write: (s, o, off) => writeVec4(o, off, [s.alphaRef, 0, 0, 0]) },

        /* --- viewport, needed by point/line expansion and stipple --- */
        { id: "viewportParams", wgsl: "viewportParams", type: "vec4<f32>", floats: 4,
          /* x, y, width, height in framebuffer pixels */
          write: (s, o, off) => writeVec4(o, off, [s.viewport.x, s.viewport.y,
              s.viewport.width, s.viewport.height]) },
        { id: "rasterParams", wgsl: "rasterParams", type: "vec4<f32>", floats: 4,
          /* lineWidth, lineStipplePattern (as float bits), lineStippleFactor,
           * polygon-stipple enable */
          write: (s, o, off) => writeVec4(o, off, [s.lineWidth,
              s.lineStipple.pattern, s.lineStipple.factor,
              s.polygonStippleEnabled ? 1 : 0]) },
        { id: "polygonStipple", wgsl: "polygonStipple",
          type: "array<vec4<f32>, 32>", floats: 128,
          /* One byte per float keeps all 1024 pattern bits exact while staying
           * inside the existing f32-only uniform staging layout. */
          write: (s, o, off) => {
              for (let i = 0; i < 128; ++i) o[off++] = s.polygonStipple[i];
              return off;
          } },
    ];

    const FIELD_BY_ID = new Map();
    for (const field of FIELDS) FIELD_BY_ID.set(field.id, field);

    /* Fields whose GLSL name maps directly onto one table entry. The compat
     * built-ins the translator resolves through structured access (lights,
     * materials, fog members) are handled in the translator itself. */
    const GLSL_TO_FIELD = {
        gl_ModelViewMatrix: "modelview",
        gl_ProjectionMatrix: "projection",
        gl_ModelViewProjectionMatrix: "mvp",
        gl_NormalMatrix: "normalMatrix",
        gl_ModelViewMatrixInverse: "modelviewInverse",
        gl_ModelViewMatrixTranspose: "modelviewTranspose",
        gl_ModelViewMatrixInverseTranspose: "modelviewInverseTranspose",
        gl_ProjectionMatrixInverse: "projectionInverse",
        gl_ProjectionMatrixTranspose: "projectionTranspose",
        gl_ProjectionMatrixInverseTranspose: "projectionInverseTranspose",
        gl_ModelViewProjectionMatrixInverse: "mvpInverse",
        gl_ModelViewProjectionMatrixTranspose: "mvpTranspose",
        gl_ModelViewProjectionMatrixInverseTranspose: "mvpInverseTranspose",
        gl_TextureMatrix: "textureMatrix",
        gl_TextureMatrixInverse: "textureMatrixInverse",
        gl_TextureMatrixTranspose: "textureMatrixTranspose",
        gl_TextureMatrixInverseTranspose: "textureMatrixInverseTranspose",
        gl_LightSource: "lights",
        gl_FrontMaterial: "frontMaterial",
        gl_BackMaterial: "backMaterial",
        gl_LightModel: "lightModelAmbient",
        gl_FrontLightModelProduct: "frontSceneColor",
        gl_BackLightModelProduct: "backSceneColor",
        gl_FrontLightProduct: "frontLightProduct",
        gl_BackLightProduct: "backLightProduct",
        gl_Fog: "fogColor",             // .color; the scalars come from fogParams
        gl_TextureEnvColor: "texEnvColor",
        gl_ObjectPlaneS: "texGenPlanes",
        gl_EyePlaneS: "texGenPlanes",
        gl_ClipPlane: "clipPlanes",
        gl_DepthRange: "depthRange",
        gl_Point: "pointParams",
    };

    /*
     * Builds the WGSL declaration for a chosen subset.
     *
     * The subset is ordered by the table, not by the order the caller
     * discovered the fields, so the same set always produces the same struct
     * -- which is what lets the shader cache key on the field list.
     */
    function buildLayout(fieldIds) {
        const wanted = new Set(fieldIds);
        const chosen = FIELDS.filter(f => wanted.has(f.id));
        const missing = [...wanted].filter(id => !FIELD_BY_ID.has(id));
        if (missing.length)
            throw new Error("unknown GL state field(s): " + missing.join(", "));

        const structs = [];
        const seenStructs = new Set();
        for (const field of chosen) {
            for (const name of field.needs || []) {
                if (seenStructs.has(name)) continue;
                seenStructs.add(name);
                structs.push(STRUCT_DECLS[name]);
            }
        }

        const lines = [];
        let floats = 0;
        const offsets = new Map();
        lines.push("struct GLState {");
        for (const field of chosen) {
            offsets.set(field.id, floats);
            lines.push("    " + field.wgsl + " : " + field.type + ",");
            floats += field.floats;
        }
        /* An empty uniform struct is invalid WGSL, and a program that touches
         * no GL state still needs a binding slot so the pipeline layout does
         * not change shape per shader. */
        if (!chosen.length) lines.push("    _unused : vec4<f32>,");
        lines.push("}");

        return {
            fields: chosen.map(f => f.id),
            floats: chosen.length ? floats : 4,
            offsets,
            structDecls: structs,
            structText: (structs.length ? structs.join("\n\n") + "\n\n" : "") +
                lines.join("\n"),
        };
    }

    /* Fills `out` (a Float32Array view of the uniform staging buffer) with the
     * layout's fields, in table order, starting at `offset`. Returns the
     * number of floats written, which must equal layout.floats. */
    function writeLayout(layout, state, out, offset) {
        const start = offset;
        for (const id of layout.fields) {
            offset = FIELD_BY_ID.get(id).write(state, out, offset);
        }
        if (!layout.fields.length) {
            out[offset] = 0; out[offset + 1] = 0;
            out[offset + 2] = 0; out[offset + 3] = 0;
            offset += 4;
        }
        return offset - start;
    }

    // Border filtering is performed at each selected mip, with that mip's
    // texel footprint. Using one base-level blend factor around an ordinary
    // trilinear sample gives the wrong border band during minification.
    function textureSamplingWGSL(name, dimension, shadow, stage) {
        const volume = dimension === "3D", cube = dimension === "Cube", n = volume || cube ? 3 : 2,
            vector = "vec" + n, coordinate = vector + "<f32>", integer = vector + "<i32>",
            type = shadow ? "texture_depth_2d" : "texture_" + (cube ? "cube" : volume ? "3d" : "2d") + "<f32>",
            result = shadow ? "f32" : "vec4<f32>", sampler = shadow ? "sampler_comparison" : "sampler";
        const finish = code => {
            if (shadow) return code;
            return code.replace("fn " + name + "(", "fn " + name + "_raw(") + `
fn ${name}(t:${type},s:${sampler},uv:${coordinate},index:u32,level:f32,bias:f32,glExplicit:bool)->${result}{
 var color=${name}_raw(t,s,uv,index,level,bias,glExplicit);
 if(glState.samplerState[index*4u+3u].z>0.5){color.a=1.0;}return color;
}`;
        };
        if (cube) return finish(`fn ${name}(t:${type},s:${sampler},uv:${coordinate},index:u32,level:f32,bias:f32,glExplicit:bool)->${result}{
 let state=glState.samplerState[index*4u+2u];
 ${stage === "vertex" ? "return textureSampleLevel(t,s,uv,level+clamp(state.w,-16.0,16.0));" : `if(glExplicit){return textureSampleLevel(t,s,uv,level+clamp(state.w,-16.0,16.0));}
 return textureSampleBias(t,s,uv,clamp(state.w+bias,-16.0,16.0));`}
}`);
        const load = shadow ? `let depth=textureLoad(t,p,level);return ${name}_compare(glReference,depth,u32(glState.samplerState[index*4u+3u].x));` :
            "return textureLoad(t,p,level);";
        const border = shadow ? `${name}_compare(glReference,glState.samplerState[index*4u].x,u32(glState.samplerState[index*4u+3u].x))` :
            "glState.samplerState[index*4u]";
        const taps = volume ? `for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){
 let bit=vec3<i32>(x,y,z);let w=select(vec3<f32>(1.0)-f,f,bit==vec3<i32>(1));
 sum+=${name}_load(t,at+bit,level,index,glReference,true)*w.x*w.y*w.z;}}}` :
            `for(var y=0;y<2;y++){for(var x=0;x<2;x++){
 let bit=vec2<i32>(x,y);let w=select(vec2<f32>(1.0)-f,f,bit==vec2<i32>(1));
 sum+=${name}_load(t,at+bit,level,index,glReference,true)*w.x*w.y;}}`;
        return finish(`${shadow ? `fn ${name}_compare(glReference:f32,depth:f32,func:u32)->f32 {
 let reference=clamp(glReference,0.0,1.0);
 switch(func){case 512u:{return 0.0;}case 513u:{return select(0.0,1.0,reference<depth);}
 case 514u:{return select(0.0,1.0,reference==depth);}case 515u:{return select(0.0,1.0,reference<=depth);}
 case 516u:{return select(0.0,1.0,reference>depth);}case 517u:{return select(0.0,1.0,reference!=depth);}
 case 518u:{return select(0.0,1.0,reference>=depth);}default:{return 1.0;}}
}
fn ${name}_color(value:f32,index:u32)->vec4<f32>{
 let mode=u32(glState.samplerState[index*4u+3u].y);
 if(mode==6406u){return vec4<f32>(0.0,0.0,0.0,value);}
 if(mode==32841u){return vec4<f32>(value);}return vec4<f32>(vec3<f32>(value),1.0);
}` : ""}
fn ${name}_load(t:${type},at:${integer},level:i32,index:u32,glReference:f32,linear:bool)->${result}{
 let size=${integer}(textureDimensions(t,level));let wraps=glState.samplerState[index*4u+1u];var p=at;
 for(var axis=0;axis<${n};axis++){
 let mode=u32(wraps[axis]);let length=size[axis];
 if(mode==10497u){p[axis]=((p[axis]%length)+length)%length;}
 else if(mode==33648u){let period=length*2;let q=((p[axis]%period)+period)%period;p[axis]=min(q,period-1-q);}
 else if(mode==33069u||(mode==10496u&&linear)){
 if(p[axis]<0||p[axis]>=length){return ${border};}
 }else{p[axis]=clamp(p[axis],0,length-1);}}
 ${load}
}
fn ${name}_level(t:${type},uv:${coordinate},level:i32,index:u32,glReference:f32,linear:bool)->${result}{
 let wraps=glState.samplerState[index*4u+1u];var coord=uv;
 for(var axis=0;axis<${n};axis++){if(u32(wraps[axis])==10496u){coord[axis]=clamp(coord[axis],0.0,1.0);}}
 let p=coord*${coordinate}(textureDimensions(t,level));
 if(!linear){return ${name}_load(t,${integer}(floor(p)),level,index,glReference,false);}
 let at=${integer}(floor(p-${coordinate}(0.5)));let f=fract(p-${coordinate}(0.5));var sum=${result}(0.0);
 ${taps}
 return sum;
}
fn ${name}(t:${type},s:${sampler},uv:${coordinate},index:u32,level:f32,bias:f32,glExplicit:bool${shadow ? ",glReference:f32" : ""})->${result}{
 let wraps=glState.samplerState[index*4u+1u];let state=glState.samplerState[index*4u+2u];
 let minimum=u32(wraps.w);let maximum=u32(state.x);
 ${!shadow ? `let border=any(vec${n}<u32>(wraps.${volume ? "xyz" : "xy"})==vec${n}<u32>(33069u))||any(vec${n}<u32>(wraps.${volume ? "xyz" : "xy"})==vec${n}<u32>(10496u));
 if(!border){${stage === "vertex" ? "return textureSampleLevel(t,s,uv,level+clamp(state.w,-16.0,16.0));" : `if(glExplicit){return textureSampleLevel(t,s,uv,level+clamp(state.w,-16.0,16.0));}return textureSampleBias(t,s,uv,clamp(state.w+bias,-16.0,16.0));`}}` : ""}
 var lod=level+clamp(state.w,-16.0,16.0);
 ${stage === "fragment" ? `if(!glExplicit){let size=${coordinate}(textureDimensions(t,0));
 let dx=dpdx(uv*size);let dy=dpdy(uv*size);lod=log2(max(max(length(dx),length(dy)),1e-8))+clamp(state.w+bias,-16.0,16.0);}` : ""}
 lod=clamp(lod,state.y,state.z);let last=f32(textureNumLevels(t)-1u);
 let threshold=select(0.0,0.5,maximum==9729u&&(minimum==9984u||minimum==9986u));
 if(lod<=threshold){return ${name}_level(t,uv,0,index,${shadow ? "glReference" : "0.0"},maximum==9729u);}
 let linear=minimum==9729u||minimum==9985u||minimum==9987u;
 if(minimum==9728u||minimum==9729u){return ${name}_level(t,uv,0,index,${shadow ? "glReference" : "0.0"},linear);}
 lod=clamp(lod,0.0,last);
 if(minimum==9984u||minimum==9985u){return ${name}_level(t,uv,i32(ceil(lod-0.5)),index,${shadow ? "glReference" : "0.0"},linear);}
 let first=i32(floor(lod));return mix(${name}_level(t,uv,first,index,${shadow ? "glReference" : "0.0"},linear),
 ${name}_level(t,uv,min(first+1,i32(last)),index,${shadow ? "glReference" : "0.0"},linear),fract(lod));
}`);
    }

    // Expansion uses a builtin vertex index, leaving all sixteen application
    // attribute locations available. Desktop aliased points round both size
    // and window centre before the square is expanded (GL 2.1 section 3.3).
    function pointRasterWGSL(desktop, depthClamp, rounded = true) {
        return `
fn gl_point_corner(index:u32)->vec2<f32>{
 let corners=array<vec2<f32>,6>(vec2<f32>(-1.0,-1.0),vec2<f32>(1.0,-1.0),vec2<f32>(-1.0,1.0),
 vec2<f32>(-1.0,1.0),vec2<f32>(1.0,-1.0),vec2<f32>(1.0,1.0));return corners[index%6u];
}
fn gl_point_position(clip:vec4<f32>,size:f32,corner:vec2<f32>,viewport:vec4<f32>)->vec4<f32>{
 ${desktop ? `if(clip.w<=0.0||any(abs(clip.xy)>vec2<f32>(clip.w))${depthClamp ? "" : "||abs(clip.z)>clip.w"}){return vec4<f32>(0.0,0.0,0.0,-1.0);}
 ${rounded ? `let rounded=max(1.0,floor(min(size,64.0)+0.5));let window=viewport.xy+(clip.xy/clip.w*0.5+0.5)*viewport.zw;
 let centre=select(floor(window)+0.5,floor(window+0.5),u32(rounded)%2u==0u);
 var result=clip;result.x=((centre.x-viewport.x)/viewport.z*2.0-1.0)*clip.w;
 result.y=((centre.y-viewport.y)/viewport.w*2.0-1.0)*clip.w;` : "let rounded=min(size,64.0);var result=clip;"}` : "let rounded=size;var result=clip;"}
 result.x+=corner.x*rounded*clip.w/viewport.z;result.y+=corner.y*rounded*clip.w/viewport.w;return result;
}
`;
    }

    const api = {
        FIELDS, FIELD_BY_ID, GLSL_TO_FIELD, STRUCT_DECLS,
        MAX_PROGRAM_MATRICES, MAX_LIGHTS, MAX_TEXTURE_UNITS, MAX_TEXTURE_COORDS, MAX_CLIP_PLANES,
        buildLayout, writeLayout, textureSamplingWGSL, pointRasterWGSL,
    };
    global.GLStateLayout = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
