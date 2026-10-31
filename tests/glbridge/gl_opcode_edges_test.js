"use strict";
const assert = require("node:assert/strict"), P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"),
    { GLStream, GL } = require("./gl_stream_builder.js"), { createFakeHost } = require("./gl_fake_gpu.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"),
    { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "render", "arrays", "images", "textures", "buffers", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
function record(name, fields, tail = new Uint8Array()) {
    const head = P.encodeRecord(name, fields), payload = new Uint8Array(head.length + tail.length);payload.set(head);payload.set(tail, head.length);
    return new GLStream().record(P.GLFN[name], payload);
}
(async () => {
    for (const copied of [false, true]) {
        const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());
        const send = stream => { const bytes = stream.bytes();gpu.submit(copied ? bytes.slice() : bytes, {}); };
        const cpuSend = stream => { const bytes = stream.bytes();const working = copied ? bytes.slice() : bytes;cpu.process(working);return working; };
        send(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1));cpuSend(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1));
        send(new GLStream().call("FRUSTUM", -1, 1, -1, 1, 1, 9));
        assert.equal(gpu.current.stacks[GL.MODELVIEW][0][11], -1);assert.equal(gpu.current.stacks[GL.MODELVIEW][0][14], -2.25);
        send(new GLStream().call("LOAD_IDENTITY").call("ORTHO", -2, 2, -4, 4, -1, 1));
        assert.deepEqual([...gpu.current.stacks[GL.MODELVIEW][0]].filter((_, i) => i % 5 === 0), [0.5, 0.25, -1, 1]);
        send(new GLStream().call("LOAD_IDENTITY").call("ROTATEF", 90, 0, 0, 1));
        assert.ok(Math.abs(gpu.current.stacks[GL.MODELVIEW][0][1] - 1) < 1e-6);
        const scale = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1];
        send(new GLStream().call("LOAD_IDENTITY"));send(record("MULT_MATRIXF", { values: scale }));
        assert.deepEqual([...gpu.current.stacks[GL.MODELVIEW][0]], scale);
        cpuSend(new GLStream().call("LIGHTI", GL.LIGHT0, GL.SPOT_EXPONENT, 12).call("LIGHT_MODELF", GL.LIGHT_MODEL_TWO_SIDE, 1)
            .call("LIGHT_MODELIV", GL.LIGHT_MODEL_AMBIENT, 4, 2147483647, 0, 0, 2147483647).call("TEX_GENF", GL.S, GL.TEXTURE_GEN_MODE, GL.OBJECT_LINEAR));
        assert.equal(cpu.current.error, 0);assert.deepEqual(cpu.current.state.values[GL.LIGHT_MODEL_AMBIENT], [1, 0, 0, 1]);
        assert.deepEqual(cpu.current.state.values[GL.LIGHT_MODEL_TWO_SIDE], [1]);
        send(new GLStream().call("BLEND_COLOR", 0, 0.25, 1, 0.5));assert.deepEqual([...gpu.current.blend.color], [0, 0.25, 1, 0.5]);
        send(new GLStream().call("BIND_TEXTURE", GL.TEXTURE_1D, 4));
        const image = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
        send(record("TEX_IMAGE_1D", { target: GL.TEXTURE_1D, internalformat: GL.RGBA8, width: 2, format: GL.RGBA, type: GL.UNSIGNED_BYTE, data_size: 8 }, image));
        send(record("TEX_SUB_IMAGE_1D", { target: GL.TEXTURE_1D, xoffset: 1, width: 1, format: GL.RGBA, type: GL.UNSIGNED_BYTE, data_size: 4 }, new Uint8Array([0, 255, 0, 255])));
        assert.deepEqual([...gpu.boundTexture(GL.TEXTURE_1D).levels[0][0].pixels], [255, 0, 0, 255, 0, 255, 0, 255]);
        // BC 3D definition is an invalid target; subimages without storage
        // are invalid operations. These are complete, well-formed records.
        for (const [name, target] of [["COMPRESSED_TEX_IMAGE_3D", GL.TEXTURE_3D], ["COMPRESSED_TEX_SUB_IMAGE_1D", GL.TEXTURE_1D], ["COMPRESSED_TEX_SUB_IMAGE_3D", GL.TEXTURE_3D]]) {
            cpuSend(new GLStream().call("BIND_TEXTURE", target, 9));cpu.current.error = 0;
            cpuSend(record(name, { target, internalformat: 0x83F1, format: 0x83F1, width: 4, height: 4, depth: 1, image_size: 8 }, new Uint8Array(8)));
            assert.equal(cpu.current.error, name === "COMPRESSED_TEX_IMAGE_3D" ? GL.INVALID_ENUM : GL.INVALID_OPERATION, name + " rejects the exact invalid operation");cpu.current.error = 0;
        }
        const values = [0.125, -0.5, 7, 1];cpuSend(record("PROGRAM_PARAMETER_DV_ARB", { parameter_kind: P.C.V86GL_PROGRAM_PARAMETER_ENV,
            target: GL.VERTEX_PROGRAM_ARB, index: 2, values }));assert.equal(cpu.current.error, 0);
        const q = record("QUERY_PROGRAM_PARAMETER_DV_ARB", { parameter_kind: P.C.V86GL_PROGRAM_PARAMETER_ENV, target: GL.VERTEX_PROGRAM_ARB, index: 2, data_size: 32 }, new Uint8Array(32));
        const queried = cpuSend(q), view = new DataView(queried.buffer, queried.byteOffset + 4);
        assert.equal(view.getUint32(P.F.QUERY_PROGRAM_PARAMETER_DV_ARB.status, true), 1);
        assert.deepEqual(values.map((_, i) => view.getFloat64(24 + i * 8, true)), values);
        send(record("RESOLVED_RASTER_STATE", { valid: 1, position: [3, 4, 0.5, 1], color: [0.25, 0.5, 0.75, 1] }));
        assert.deepEqual([...gpu.current.current.rasterPos], [3, 4, 0.5, 1]);assert.deepEqual([...gpu.current.current.rasterColor], [0.25, 0.5, 0.75, 1]);
        const oldColor = [...gpu.current.current.color];send(new GLStream().call("BEGIN", GL.POINTS));
        send(record("RESOLVED_EVAL_VERTEX", { position: [0, 0, 0, 1], color: [1, 0, 0, 1], normal: [0, 0, 1, 0], texcoord: [0, 0, 0, 1] }));
        send(new GLStream().call("END"));assert.deepEqual([...gpu.current.current.color], oldColor, "evaluated attributes do not leak to current state");
        send(new GLStream().call("CREATE_PROGRAM", 100).call("CREATE_SHADER", 101, GL.VERTEX_SHADER).shaderSource(101,
            "#version 120\nuniform mat2x3 matrix;void main(){gl_Position=vec4(matrix*gl_Vertex.xy,1.0);}").call("COMPILE_SHADER", 101)
            .call("ATTACH_SHADER", 100, 101).call("CREATE_SHADER", 102, GL.FRAGMENT_SHADER).shaderSource(102, "void main(){gl_FragColor=vec4(1.0);}")
            .call("COMPILE_SHADER", 102).call("ATTACH_SHADER", 100, 102).call("LINK_PROGRAM", 100).call("USE_PROGRAM", 100));
        const program = gpu.currentProgramObject();assert.ok(program.linked);
        const [location, entry] = [...program.uniformByLocation.entries()][0], matrix = new Float32Array([1, 2, 3, 4, 5, 6]);
        send(record("UNIFORM_MATRIX_RECT_FV", { location, columns: 2, rows: 3, count: 1 }, new Uint8Array(matrix.buffer)));
        const base = entry.uniform.offsetBytes / 4, stride = entry.uniform.matrixColumnStrideBytes / 4;
        assert.deepEqual([...program.uniformFloats.slice(base, base + 3)], [1, 2, 3]);assert.deepEqual([...program.uniformFloats.slice(base + stride, base + stride + 3)], [4, 5, 6]);
        const serial = program.serial;send(new GLStream().call("MAP_UNIFORM_LOCATION").call("MAP_ATTRIB_LOCATION"));
        assert.equal(program.serial, serial, "retired location-map sentinels are harmless");
        send(new GLStream().call("INVALIDATE_PROGRAM_LOCATIONS", 100));assert.equal(program.serial, serial + 1);
        await gpu.idle();assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);
    }
    console.log("PASS edge opcode behaviors: matrix transforms, integer lighting, 1D updates, rejected compressed targets, double ARB queries, resolved vertices and rectangular uniforms in both transports");
})().catch(error => { console.error(error);process.exitCode = 1; });
