/* global GLTestStream, GLProtocol, GLClientArrays, V86GLShadow, GLWebGPUExecutorModule, V86GLGlslang, GLSelectionCases */
"use strict";
(async () => {
    const { GLStream, GL } = GLTestStream, P = GLProtocol, check = (ok, message) => { if (!ok) throw new Error(message); };
    const block = (color, position) => GLClientArrays.immediateRecord([{ attributes: new GLStream().call("COLOR4F", ...color).bytes(), positions: new Uint8Array(new Float32Array(position).buffer) }]);
    const list = (s, operation, name = 0, value = 0) => s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation, name, value }));
    try {
        const compiler = await WebAssembly.compile(await (await fetch("../../bios/glslang.wasm")).arrayBuffer());
        for (const copied of [false, true]) {
            let cpu = new V86GLShadow.GLShadow(), gpu = new GLWebGPUExecutorModule.GLWebGPUExecutor(document.getElementById("gpu"), { strict: true });
            await gpu.initialize();cpu.setCapabilities(gpu.capabilities());cpu.setGlslang(new V86GLGlslang.Glslang(compiler));
            const memories = new Map();let batch = 0;
            const forward = (bytes, segments, metadata) => {
                for (const segment of segments || [{ offset: 0, length: bytes.length }]) {
                    const part = segment.bytes || bytes.subarray(segment.offset, segment.offset + segment.length);
                    gpu.submit(copied ? part.slice() : part, { batchId: metadata.batchId, baseOffset: (metadata.offset || 0) + (segment.bytes ? 0 : segment.offset), onVertexCapture: result => cpu.completeVertexCapture(result) });
                }
            };
            const configure = () => {
                cpu.writeResponse = (target, bytes) => memories.get(target.batchId).set(bytes, target.offset);cpu.onCPUResume = forward;
                gpu.options.writeGuestMemory = (offset, bytes, metadata) => memories.get(metadata.batchId).set(bytes, offset + metadata.baseOffset);
            };
            configure();
            const submit = async value => {
                const bytes = value instanceof Uint8Array ? value : value.bytes(), metadata = { generation: 1, batchId: ++batch, root: true, offset: 0 };memories.set(batch, bytes);
                forward(bytes, cpu.process(bytes, metadata), metadata);await gpu.idle();
                check(!cpu.cpuBarrier && !cpu.current.error && !gpu.hostErrors.length && !gpu.gpuErrors.errors.length && !gpu.stats.refusals, "block error " + cpu.current.error);
            };
            const pixels = async label => {
                const s = new GLStream(), read = s.readPixels(0, 0, 16, 16, GL.RGBA, GL.UNSIGNED_BYTE, 1024);await submit(s);
                for (const [x, color] of [[4, [255, 0, 0, 255]], [12, [0, 255, 0, 255]]]) for (let c = 0; c < 4; ++c)
                    check(read.bytes[P.RECORDS.READ_PIXELS.size + (8 * 16 + x) * 4 + c] === color[c], label + " pixel " + [x, c]);
            };
            await submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("POINT_SIZE", 6).call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT).call("BEGIN", GL.POINTS));
            await submit(block([1, 0, 0, 1], [-1, 0, 0, 2]));
            const savedCPU = cpu.getState(), savedGPU = await gpu.saveSnapshot();cpu = new V86GLShadow.GLShadow();cpu.setState(savedCPU);cpu.setGlslang(new V86GLGlslang.Glslang(compiler));
            gpu = new GLWebGPUExecutorModule.GLWebGPUExecutor(document.getElementById("gpu"), { strict: true });await gpu.initialize();await gpu.restoreSnapshot(savedGPU);configure();
            await submit(block([0, 1, 0, 1], [2, 0, 0, 4]));await submit(block([0, 0, 1, 1], []));await submit(new GLStream().call("END"));await pixels("open primitive cold restore");
            check(cpu.stateValue(GL.CURRENT_COLOR)[0].join() === "0,0,1,1", "trailing attributes update CPU state");
            const compile = new GLStream();list(compile, 1, 99, GL.COMPILE);compile.call("BEGIN", GL.POINTS);await submit(compile);
            const red = block([1, 0, 0, 1], [-1, 0, 0, 2]);await submit(red);red.fill(0);await submit(block([0, 1, 0, 1], [2, 0, 0, 4]));
            const close = new GLStream().call("END");list(close, 2);await submit(close);check(cpu.stateValue(GL.CURRENT_COLOR)[0][2] === 1, "COMPILE leaves current state untouched");
            await submit(new GLStream().call("CREATE_PROGRAM", 1).call("CREATE_SHADER", 2, GL.VERTEX_SHADER).shaderSource(2, "#version 120\nvoid main(){gl_Position=gl_Vertex;gl_FrontColor=gl_Color;}").call("COMPILE_SHADER", 2).call("ATTACH_SHADER", 1, 2)
                .call("CREATE_SHADER", 3, GL.FRAGMENT_SHADER).shaderSource(3, "#version 120\nvoid main(){gl_FragColor=gl_Color;}").call("COMPILE_SHADER", 3).call("ATTACH_SHADER", 1, 3).call("LINK_PROGRAM", 1).call("USE_PROGRAM", 1));
            const draw = new GLStream().call("CLEAR", GL.COLOR_BUFFER_BIT);list(draw, 3, 99);await submit(draw);await pixels("immutable programmable list");
            const capture = new GLStream();GLSelectionCases.query(capture, { operation: 1, size: 128, type: GL["4D_COLOR_TEXTURE"] });GLSelectionCases.query(capture, { operation: 2, type: GL.FEEDBACK });list(capture, 3, 99);
            const result = GLSelectionCases.query(capture, { operation: 2, type: GL.RENDER });await submit(capture);check(result.view.getInt32(P.F.QUERY_RENDER_MODE.result, true) === 26, "two captured points");
            const feedback = GLSelectionCases.read(result);await submit(feedback.stream);
            for (const [i, expected] of [[0, GL.POINT_TOKEN], [1, 4], [2, 8], [4, 2], [5, 1], [6, 0], [13, GL.POINT_TOKEN], [14, 12], [17, 4], [18, 0], [19, 1]])
                check(feedback.response.view.getFloat32(P.RECORDS.QUERY_RENDER_MODE.size + i * 4, true) === expected, "programmable block feedback " + i);
            gpu.lossHandler();gpu.resetForReplay();
        }
        document.getElementById("result").textContent = "PASS immediate vertex blocks: exact point pixels, attributes/w, open primitive cold restore, immutable lists and programmable feedback in both transports";
    } catch (error) { document.getElementById("result").textContent = "FAIL " + error.stack; }
})();
