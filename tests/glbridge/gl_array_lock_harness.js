/* global GLTestStream, GLProtocol, V86GLShadow, GLWebGPUExecutorModule */
"use strict";
(async () => {
    const { GLStream, GL } = GLTestStream, P = GLProtocol, check = (ok, message) => { if (!ok) throw new Error(message); };
    try {
        for (const copied of [false, true]) {
            let cpu = new V86GLShadow.GLShadow(), gpu = new GLWebGPUExecutorModule.GLWebGPUExecutor(document.getElementById("gpu"), { strict: true });
            await gpu.initialize();cpu.setCapabilities(gpu.capabilities());
            const submit = async s => {
                const memory = s.bytes();gpu.options.writeGuestMemory = (at, bytes, metadata) => metadata.memory.set(bytes, at + metadata.baseOffset);
                for (const segment of cpu.process(memory) || [{ offset: 0, length: memory.length }]) {
                    const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, { memory, baseOffset: segment.bytes ? 0 : segment.offset });
                }
                await gpu.idle();check(!cpu.current.error && !gpu.hostErrors.length && !gpu.gpuErrors.errors.length && !gpu.stats.refusals, "array-lock failure " + cpu.current.error);
            };
            const lock = (s, operation, first = 0, count = 0) => s.record(P.GLFN.QUERY_ARRAY_LOCK, P.encodeRecord("QUERY_ARRAY_LOCK", { operation, first, count }));
            const list = (s, operation, name = 0, value = 0) => s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation, name, value }));
            const draw = async label => {
                const s = new GLStream().call("CLEAR", GL.COLOR_BUFFER_BIT).drawArraysGL2(GL.POINTS, 2, {
                    vertex: { size: 4, type: GL.FLOAT, data: new Float32Array([-1, 0, 0, 2, 2, 0, 0, 4]) },
                    color: { size: 4, type: GL.UNSIGNED_BYTE, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]) },
                });const read = s.readPixels(0, 0, 16, 16, GL.RGBA, GL.UNSIGNED_BYTE, 1024);await submit(s);
                for (const [x, expected] of [[4, [255, 0, 0, 255]], [12, [0, 255, 0, 255]]]) for (let c = 0; c < 4; ++c)
                    check(read.bytes[P.RECORDS.READ_PIXELS.size + (8 * 16 + x) * 4 + c] === expected[c], label + " point " + [x, c]);
            };
            const setup = new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("POINT_SIZE", 6);lock(setup, 0, 0, 2);await submit(setup);await draw("locked");
            const stack = new GLStream().call("PUSH_CLIENT_ATTRIB", GL.CLIENT_ALL_ATTRIB_BITS);lock(stack, 1);stack.call("POP_CLIENT_ATTRIB");await submit(stack);
            check(cpu.current.state.arrays.lock.count === 2, "all client attributes restore the range");
            const savedCPU = cpu.getState(), savedGPU = await gpu.saveSnapshot();cpu = new V86GLShadow.GLShadow();cpu.setState(savedCPU);
            gpu = new GLWebGPUExecutorModule.GLWebGPUExecutor(document.getElementById("gpu"), { strict: true });await gpu.initialize();await gpu.restoreSnapshot(savedGPU);await draw("cold restored lock");
            const reset = new GLStream();lock(reset, 1);list(reset, 1, 99, GL.COMPILE);lock(reset, 0, 0, 2);list(reset, 2);await submit(reset);check(cpu.current.state.arrays.lock.count === 2, "LockArrays executes during compilation");
            const call = new GLStream();lock(call, 1);list(call, 3, 99);await submit(call);check(cpu.current.state.arrays.lock.count === 0, "list does not replay a lock");await draw("unlocked");
            gpu.lossHandler();gpu.resetForReplay();
        }
        document.getElementById("result").textContent = "PASS compiled vertex-array range, all-client stack, list-immediate semantics and cold CPU/GPU restore with exact array pixels in both transports";
    } catch (error) { document.getElementById("result").textContent = "FAIL " + error.stack; }
})();
