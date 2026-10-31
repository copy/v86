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
                    const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);
                    gpu.submit(copied ? bytes.slice() : bytes, { memory, baseOffset: segment.bytes ? 0 : segment.offset });
                }
                await gpu.idle();check(!cpu.current.error && !gpu.hostErrors.length && !gpu.gpuErrors.errors.length && !gpu.stats.refusals, "upload errors " + cpu.current.error);
            };
            const draw = async large => {
                const s = new GLStream().call("CLEAR", GL.COLOR_BUFFER_BIT).call("BEGIN", GL.TRIANGLES);
                for (const [x, y, u, v] of [[-1, -1, 0, 0], [3, -1, 2, 0], [-1, 3, 0, 2]]) s.call("TEX_COORD2F", u, v).call("VERTEX3F", x, y, 0);
                s.call("END");const read = s.readPixels(0, 0, 16, 16, GL.RGBA, GL.UNSIGNED_BYTE, 1024);await submit(s);
                const pixels = read.bytes.subarray(P.RECORDS.READ_PIXELS.size);
                for (let y = 0; y < 16; ++y) for (let x = 0; x < 16; ++x) {
                    const expected = large ? [y, x, 33, 255] : [9, 8, 7, 255];
                    for (let c = 0; c < 4; ++c) check(pixels[(y * 16 + x) * 4 + c] === expected[c], "texture pixel " + [copied, large, x, y, c, pixels[(y * 16 + x) * 4 + c], expected[c]]);
                }
            };
            await submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("BIND_TEXTURE", GL.TEXTURE_2D, 1)
                .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST)
                .call("ENABLE", GL.TEXTURE_2D).texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([9, 8, 7, 255])));
            const data = new Uint8Array(2048 * 2048 * 4);
            for (let y = 0; y < 2048; ++y) for (let x = 0; x < 2048; ++x) data.set([y >> 7, x >> 7, 33, 255], (y * 2048 + x) * 4);
            const record = new GLStream().texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 2048, 2048, GL.RGBA, GL.UNSIGNED_BYTE, data).bytes(), payload = record.subarray(8), band = 5 * 1024 * 1024;
            for (let offset = 0; offset < payload.length; offset += band) {
                const part = payload.subarray(offset, offset + band), header = P.encodeRecord("UPLOAD_CHUNK", { token: 1, opcode: P.GLFN.TEX_IMAGE_2D, total_size: payload.length, offset, data_size: part.length }), chunk = new Uint8Array(header.length + part.length);
                chunk.set(header);chunk.set(part, header.length);await submit(new GLStream().record(P.GLFN.UPLOAD_CHUNK, chunk));
                if (!offset) {
                    await draw(false);
                    const savedCPU = cpu.getState(), savedGPU = await gpu.saveSnapshot();
                    cpu = new V86GLShadow.GLShadow();cpu.setState(savedCPU);
                    gpu = new GLWebGPUExecutorModule.GLWebGPUExecutor(document.getElementById("gpu"), { strict: true });await gpu.initialize();await gpu.restoreSnapshot(savedGPU);
                    await draw(false);check(cpu.current.upload.received === band, "partial upload restored");
                }
            }
            check(!cpu.current.upload && cpu.current.completedUpload.token === 1, "one completed upload");await draw(true);
            const saved = await gpu.saveSnapshot();await gpu.restoreSnapshot(saved);await draw(true);
            gpu = new GLWebGPUExecutorModule.GLWebGPUExecutor(document.getElementById("gpu"), { strict: true });await gpu.initialize();await gpu.restoreSnapshot(saved);await draw(true);
            gpu.lossHandler();gpu.resetForReplay();
        }
        document.getElementById("result").textContent = "PASS 16MiB texture assembled atomically across arena-sized fragments, partial CPU/cold GPU checkpoint and complete hot/cold restore in both transports";
    } catch (error) { document.getElementById("result").textContent = "FAIL " + error.stack; }
})();
