/* global GLTestStream, GLProtocol, V86GLShadow, GLWebGPUExecutorModule, V86GLGlslang, GLSelectionCases */
"use strict";
(async () => {
    const { GLStream, GL } = GLTestStream, P = GLProtocol;
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    try {
        const compiler = await WebAssembly.compile(await (await fetch("../../bios/glslang.wasm")).arrayBuffer());
        for (const copied of [false, true]) {
            const cpu = new V86GLShadow.GLShadow(), gpu = new GLWebGPUExecutorModule.GLWebGPUExecutor(document.getElementById("gpu"), { strict: true });
            await gpu.initialize();cpu.setCapabilities(gpu.capabilities());cpu.setGlslang(new V86GLGlslang.Glslang(compiler));
            const memories = new Map();let batch = 0;
            cpu.writeResponse = (target, bytes) => memories.get(target.batchId).set(bytes, target.offset);
            gpu.options.writeGuestMemory = (offset, bytes, metadata) => memories.get(metadata.batchId).set(bytes, offset + metadata.baseOffset);
            const forward = (bytes, segments, metadata) => {
                for (const segment of segments || [{ offset: 0, length: bytes.length }]) {
                    const part = segment.bytes || bytes.subarray(segment.offset, segment.offset + segment.length);
                    gpu.submit(copied ? part.slice() : part, { batchId: metadata.batchId, baseOffset: (metadata.offset || 0) + (segment.bytes ? 0 : segment.offset), onVertexCapture: result => cpu.completeVertexCapture(result) });
                }
            };
            cpu.onCPUResume = forward;
            const submit = async stream => {
                const bytes = stream.bytes(), metadata = { generation: 1, batchId: ++batch, root: true, offset: 0 };memories.set(batch, bytes);
                forward(bytes, cpu.process(bytes, metadata), metadata);await gpu.idle();
                check(!cpu.cpuBarrier && !cpu.current.error, "CPU state / capture error " + cpu.current.error);
            };
            await submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1));
            for (const [type, ArrayType, bits] of [[GL.BYTE, Int8Array, 8], [GL.SHORT, Int16Array, 16], [GL.INT, Int32Array, 32]]) {
                const vertex = "#version 120\nattribute vec4 a;varying vec4 c;void main(){gl_Position=gl_Vertex;c=vec4(a.x*" + ((2 ** bits - 1) / 255).toPrecision(15) + ",gl_Color.y,gl_Normal.z,1.0);gl_FrontColor=c;}";
                const fragment = "#version 120\nvarying vec4 c;void main(){gl_FragColor=c;}";
                const setup = new GLStream().call("CREATE_PROGRAM", 1).call("CREATE_SHADER", 2, GL.VERTEX_SHADER).shaderSource(2, vertex).call("COMPILE_SHADER", 2).call("ATTACH_SHADER", 1, 2)
                    .call("CREATE_SHADER", 3, GL.FRAGMENT_SHADER).shaderSource(3, fragment).call("COMPILE_SHADER", 3).call("ATTACH_SHADER", 1, 3);
                const bind = new Uint8Array(14), view = new DataView(bind.buffer);view.setUint32(0, 1, true);view.setInt32(4, 7, true);view.setUint32(8, 2, true);bind[12] = 97;
                setup.record(P.GLFN.BIND_ATTRIB_LOCATION, bind).call("LINK_PROGRAM", 1).call("USE_PROGRAM", 1);await submit(setup);
                const positions = new Float32Array([-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1]), color = new Int8Array(12), normal = new Int8Array(9), generic = new ArrayType(12);
                for (const direct of [false, true]) {
                    const draw = s => direct ? s.call("DRAW_ARRAYS_DIRECT", GL.TRIANGLES, 0, 3) : s.drawArraysGL2(GL.TRIANGLES, 3,
                        { vertex: { size: 4, type: GL.FLOAT, data: positions }, color: { size: 4, type: GL.BYTE, data: color }, normal: { size: 3, type: GL.BYTE, data: normal } },
                        [{ index: 7, size: 4, type, normalized: true, data: generic }]);
                    if (direct) {
                        const s = new GLStream();
                        for (const [id, data, name, size, scalar, array] of [[10, positions, "VERTEX_POINTER_VBO", 4, GL.FLOAT, GL.VERTEX_ARRAY], [11, color, "COLOR_POINTER_VBO", 4, GL.BYTE, GL.COLOR_ARRAY], [12, normal, "NORMAL_POINTER_VBO", 3, GL.BYTE, GL.NORMAL_ARRAY]])
                            s.call("BIND_BUFFER", GL.ARRAY_BUFFER, id).bufferData(GL.ARRAY_BUFFER, data.byteLength, GL.STATIC_DRAW, new Uint8Array(data.buffer)).pointerVBO(name, size, scalar, 0, 0).call("ENABLE_CLIENT_STATE", array);
                        s.call("BIND_BUFFER", GL.ARRAY_BUFFER, 13).bufferData(GL.ARRAY_BUFFER, generic.byteLength, GL.STATIC_DRAW, new Uint8Array(generic.buffer)).attribPointerVBO(7, 4, type, true, 0, 0).call("ENABLE_VERTEX_ATTRIB_ARRAY", 7);await submit(s);
                    }
                    const s = draw(new GLStream().call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT)), read = s.readPixels(8, 8, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, 4);await submit(s);
                    check([1, 1, 1, 255].every((value, i) => read.bytes[P.RECORDS.READ_PIXELS.size + i] === value), "GL 2.1 normalization pixels " + bits + " direct " + direct + ": " + [...read.bytes.slice(P.RECORDS.READ_PIXELS.size)]);
                    // The programmable capture path must read the same normalized arrays.
                    const capture = new GLStream();GLSelectionCases.query(capture, { operation: 1, size: 128, type: GL["3D_COLOR_TEXTURE"] });GLSelectionCases.query(capture, { operation: 2, type: GL.FEEDBACK });draw(capture);
                    const result = GLSelectionCases.query(capture, { operation: 2, type: GL.RENDER });await submit(capture);
                    check(result.view.getInt32(P.F.QUERY_RENDER_MODE.result, true) > 0, "feedback capture produced data");
                    const feedback = GLSelectionCases.read(result);await submit(feedback.stream);
                    for (let component = 0; component < 3; ++component) check(Math.abs(feedback.response.view.getFloat32(P.RECORDS.QUERY_RENDER_MODE.size + (5 + component) * 4, true) - 1 / 255) < 2 ** -24, "capture normalized color " + component);
                }
                await submit(new GLStream().call("USE_PROGRAM", 0).names(P.GLFN.DELETE_BUFFERS, [10, 11, 12, 13]).call("DELETE_SHADER", 2).call("DELETE_SHADER", 3).call("DELETE_PROGRAM", 1));
            }
            check(!gpu.gpuErrors.errors.length && !gpu.hostErrors.length && !gpu.stats.refusals, "GPU errors");gpu.lossHandler();gpu.resetForReplay();
        }
        document.getElementById("result").textContent = "PASS GL 2.1 signed byte/short/int normalization, client and VBO attributes, programmable feedback capture in both transports";
    } catch (error) { document.getElementById("result").textContent = "FAIL " + error.stack; }
})();
