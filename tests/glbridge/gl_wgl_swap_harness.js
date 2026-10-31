/* global GLTestStream, GLProtocol, V86GLShadow, GLWebGPUExecutorModule, GPUBufferUsage, GPUMapMode */
"use strict";
(async () => {
    const { GLStream, GL } = GLTestStream, P = GLProtocol, check = (ok, message) => { if (!ok) throw new Error(message); };
    const current = (id, format = 0) => new GLStream().makeCurrent(id, id, 0, 16, 16, id, id, format);
    try {
        for (const copied of [false, true]) {
            let refreshes = 0, cpu = new V86GLShadow.GLShadow(), gpu;
            const create = async () => {
                gpu = new GLWebGPUExecutorModule.GLWebGPUExecutor(document.getElementById("gpu"), { strict: true, requestAnimationFrame: fn => requestAnimationFrame(time => { refreshes++;fn(time); }) });
                await gpu.initialize();
            };
            await create();cpu.setCapabilities(gpu.capabilities());
            const submit = async value => {
                const memory = value.bytes();gpu.options.writeGuestMemory = (at, bytes, metadata) => metadata.memory.set(bytes, at + metadata.baseOffset);
                for (const segment of cpu.process(memory) || [{ offset: 0, length: memory.length }]) {
                    const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, { memory, baseOffset: segment.bytes ? 0 : segment.offset });
                }
                await gpu.idle();check(!cpu.current?.error && !gpu.hostErrors.length && !gpu.gpuErrors.errors.length && !gpu.stats.refusals, "host/CPU swap failure");
            };
            const swap = async (hwnd, interval) => {
                const stream = new GLStream(), reply = stream.swapWindow(hwnd, interval);await submit(stream);check(reply.view.getUint32(P.F.SWAP_WINDOW.status, true) === P.C.V86GL_SYNC_QUERY_STATUS_OK, "swap reply " + hwnd);
            };
            const pixel = async expected => {
                const buffer = gpu.device.createBuffer({size:256 * 16,usage:GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ}), encoder = gpu.device.createCommandEncoder();
                encoder.copyTextureToBuffer({texture:gpu.host.context.getCurrentTexture()},{buffer,bytesPerRow:256},{width:16,height:16});gpu.device.queue.submit([encoder.finish()]);
                await buffer.mapAsync(GPUMapMode.READ);const bytes = new Uint8Array(buffer.getMappedRange()), at = 8 * 256 + 8 * 4;
                const actual = [bytes[at],bytes[at+1],bytes[at+2],bytes[at+3]];if (gpu.host.format.startsWith("bgra")) [actual[0],actual[2]] = [actual[2],actual[0]];
                buffer.unmap();buffer.destroy();check(actual.join() === expected.join(), "presented pixel " + [copied, actual, expected]);
            };
            for (const [id, color] of [[11,[1,0,0,1]],[22,[0,0,1,1]]]) await submit(current(id).call("VIEWPORT",0,0,16,16).call("CLEAR_COLOR",...color).call("CLEAR",GL.COLOR_BUFFER_BIT));
            await submit(current(11));const state = cpu.current, context = gpu.current, drawable = gpu.currentDrawable;
            await swap(22,0);await pixel([0,0,255,255]);check(cpu.current === state && gpu.current === context && gpu.currentDrawable === drawable, "swap changed current RC");check(gpu.surface.hwnd === 22, "presented geometry must name target window");
            await swap(11,2);await pixel([255,0,0,255]);check(refreshes === 2, "interval reaches actual host refresh clock");
            const savedCPU = cpu.getState(), savedGPU = await gpu.saveSnapshot();gpu.lossHandler();
            cpu = new V86GLShadow.GLShadow();cpu.setState(savedCPU);await create();await gpu.restoreSnapshot(savedGPU);
            await swap(22,0);await pixel([0,0,255,255]);check(cpu.current.key === "context:11" && gpu.current.protocolId === 11, "cold restored RC remains current");
            await submit(current(33,P.C.V86GL_FORMAT_SINGLE_BUFFER).call("CLEAR_COLOR",0,1,0,1).call("CLEAR",GL.COLOR_BUFFER_BIT).call("FLUSH"));await pixel([0,255,0,255]);
            await swap(11,0);await pixel([255,0,0,255]);let presentations = 0;const present = gpu.presentToCanvas;gpu.presentToCanvas = function() { presentations++;return present.call(this); };
            await swap(33,0);check(!presentations && gpu.surface.hwnd === 11, "single-buffer swap leaves the displayed front image alone");check(gpu.current.protocolId === 33, "single-buffer swap keeps current RC");
            await submit(new GLStream().record(P.CTRL.RELEASE_CURRENT));await swap(22,0);await pixel([0,0,255,255]);check(!gpu.current && !cpu.current, "swap needs no current RC");gpu.lossHandler();gpu.resetForReplay();
        }
        document.getElementById("result").textContent = "PASS HDC-targeted red/blue presentation, single front flush/no-swap, host refresh interval, no-current swap and cold CPU/GPU restore in both transports";
    } catch (error) { document.getElementById("result").textContent = "FAIL " + error.stack; }
})();
