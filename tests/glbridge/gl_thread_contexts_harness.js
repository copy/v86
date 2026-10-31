/* global GLTestStream, GLProtocol, GLClientArrays, V86GLShadow, GLWebGPUExecutorModule */
"use strict";
(async () => {
    const { GLStream, GL } = GLTestStream, P = GLProtocol, check = (ok, message) => { if (!ok) throw new Error(message); };
    const current = id => new GLStream().makeCurrent(99, 0, 0, 16, 16, id, id);
    const vertex = id => GLClientArrays.immediateRecord([{ attributes: new Uint8Array(), positions: new Uint8Array(new Float32Array(id === 1 ? [-1, 0, 0, 2] : [2, 0, 0, 4]).buffer) }]);
    try {
        for (const copied of [false, true]) {
            let cpu = new V86GLShadow.GLShadow(), gpu = new GLWebGPUExecutorModule.GLWebGPUExecutor(document.getElementById("gpu"), { strict: true });
            await gpu.initialize();cpu.setCapabilities(gpu.capabilities());
            const submit = async value => {
                const memory = value instanceof Uint8Array ? value : value.bytes();gpu.options.writeGuestMemory = (at, bytes, metadata) => metadata.memory.set(bytes, at + metadata.baseOffset);
                for (const segment of cpu.process(memory) || [{ offset: 0, length: memory.length }]) {
                    const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, { memory, baseOffset: segment.bytes ? 0 : segment.offset });
                }
                await gpu.idle();check(!cpu.current?.error && !gpu.hostErrors.length && !gpu.gpuErrors.errors.length && !gpu.stats.refusals, "context failure " + cpu.current?.error);
            };
            gpu.immediateBuffer = new Float32Array(4);
            for (const id of [1, 2]) {
                await submit(current(id).call("VIEWPORT", 0, 0, 16, 16).call("POINT_SIZE", 6).call("COLOR4F", id === 1 ? 1 : 0, id === 2 ? 1 : 0, 0, 1)
                    .call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT).call("BEGIN", GL.POINTS));
                await submit(vertex(id));
            }
            for (let step = 0; step < 16; ++step) {
                for (const id of [1, 2]) {
                    await submit(current(id));check(cpu.stateValue(GL.CURRENT_COLOR)[0].join() === (id === 1 ? "1,0,0,1" : "0,1,0,1"), "CPU per-context color");await submit(vertex(id));
                }
                if (step === 7) {
                    const savedCPU = cpu.getState(), savedGPU = await gpu.saveSnapshot();cpu = new V86GLShadow.GLShadow();cpu.setState(savedCPU);
                    gpu = new GLWebGPUExecutorModule.GLWebGPUExecutor(document.getElementById("gpu"), { strict: true });await gpu.initialize();await gpu.restoreSnapshot(savedGPU);
                }
            }
            for (const id of [1, 2]) await submit(current(id).call("END"));
            const s = current(1), read = s.readPixels(0, 0, 16, 16, GL.RGBA, GL.UNSIGNED_BYTE, 1024);await submit(s);
            for (const [x, expected] of [[4, [255, 0, 0, 255]], [12, [0, 255, 0, 255]]]) for (let c = 0; c < 4; ++c)
                check(read.bytes[P.RECORDS.READ_PIXELS.size + (8 * 16 + x) * 4 + c] === expected[c], "interleaved open primitives pixel " + [copied, x, c, read.bytes[P.RECORDS.READ_PIXELS.size + (8 * 16 + x) * 4 + c], expected[c]]);
            gpu.lossHandler();gpu.resetForReplay();
        }
        document.getElementById("result").textContent = "PASS two contexts on one window retain open primitive buffers, colors and homogeneous w through 32 switches and cold CPU/GPU restore in both transports";
    } catch (error) { document.getElementById("result").textContent = "FAIL " + error.stack; }
})();
