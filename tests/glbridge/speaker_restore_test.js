"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");

(async () => {
    global.DEBUG = false;
    const { SpeakerAdapter } = await import("../../src/browser/speaker.js");
    const { SB16 } = await import("../../src/audio_devices/sb16/sb16.js");
    const { Bus } = await import("../../src/bus.js");
    let Processor;
    const node = () => ({ gain: { setValueAtTime() {} }, frequency: { setValueAtTime() {} },
        connect() {}, disconnect() {}, start() {} });
    class Context {
        constructor() {
            this.currentTime = 0;
            this.audioWorklet = { addModule: async url => {
                const source = await (await fetch(url)).text();
                vm.runInNewContext(source, { DEBUG: false, sampleRate: 48000,
                    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
                    registerProcessor(name, value) { Processor = value; } });
            } };
        }
        createGain() { return node(); }
        createBiquadFilter() { return node(); }
        createChannelMerger() { return node(); }
        createChannelSplitter() { return node(); }
        createOscillator() { return node(); }
        createBuffer(channels, length, rate) {
            this.lastRate = rate;
            const data = Array.from({ length: channels }, () => new Float32Array(length));
            return { copyToChannel(values, channel) { data[channel].set(values); } };
        }
        createBufferSource() {
            let ended;
            return { ...node(), addEventListener(name, callback) { ended = callback; },
                stop() { ended(); } };
        }
        suspend() { return Promise.resolve(); }
        resume() { return Promise.resolve(); }
        close() {}
    }
    global.window = { AudioContext: Context, AudioWorklet: true };
    global.AudioContext = Context;
    global.AudioWorkletNode = class {
        constructor() {
            this.processor = new Processor();
            this.port = { postMessage: data => this.processor.port.onmessage({ data }), close() {} };
        }
        connect() {}
    };
    const [host, guest] = Bus.create();
    const speaker = new SpeakerAdapter(host);
    for (let n = 0; !speaker.dac.node_processor && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(speaker.dac.node_processor);
    let requests = 0;
    guest.register("dac-request-data", () => requests++);
    const processor = speaker.dac.node_processor.processor;
    const sb = Object.create(SB16.prototype);
    // (its machine's speaker messages: the bus, as src/cpu.js's handle has them)
    sb.machine = { bus_send: (name, data, transfer) => guest.send(name, data, transfer) };
    let cleared = 0;
    sb.dac_buffers = [{ clear() { cleared++; } }, { clear() { cleared++; } }];
    const state = new Array(36).fill(0);
    state[6] = new Uint8Array(0);
    state[24] = new Uint8Array(32);
    state[27] = 44100;
    state[35] = new Uint8Array(16);

    guest.send("dac-tell-sampling-rate", 22050);
    guest.send("emulator-started");
    guest.send("dac-enable");
    const old = new Float32Array(4096).fill(.5);
    guest.send("dac-send-data", [old, old.slice()]);
    const previousGeneration = speaker.dac.generation;
    guest.send("emulator-stopped");
    const pausedRequests = requests;
    speaker.dac.node_processor.port.onmessage({ data: { type: "pump", generation: previousGeneration } });
    assert.equal(requests, pausedRequests, "paused audio cannot advance DMA during graphics replay");
    sb.set_state(state);
    assert.equal(cleared, 2, "discard CPU-side samples from the abandoned timeline");
    assert.equal(speaker.dac.sampling_rate, 44100);
    assert.equal(processor.source_samples_per_destination, 44100 / 48000);
    assert.equal(processor.queue_length, 0);
    assert.equal(processor.source_time, 0);
    const out = [new Float32Array(128), new Float32Array(128)];
    processor.process([], [out], {});
    assert.ok(out[0].every(value => value === 0), "restored audio contains no old queued tone");
    guest.send("emulator-started");
    const resumedRequests = requests;
    speaker.dac.node_processor.port.onmessage({ data: { type: "pump", generation: previousGeneration } });
    assert.equal(requests, resumedRequests, "late pump requests from the old timeline are ignored");

    // Render a 1 kHz source sampled at the saved rate. A stale 22050 Hz host
    // setting would play this one octave lower, at 500 Hz.
    const tone = new Float32Array(44100);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(2 * Math.PI * 1000 * i / 44100);
    guest.send("dac-send-data", [tone, tone.slice()]);
    const rendered = [];
    for (let block = 0; block < 180; block++) {
        processor.process([], [out], {});
        if (block >= 10) rendered.push(...out[0]);
    }
    let crossings = 0;
    for (let i = 1; i < rendered.length; i++) if (rendered[i - 1] <= 0 && rendered[i] > 0) crossings++;
    const hz = crossings * 48000 / rendered.length;
    assert.ok(Math.abs(hz - 1000) < 5, "restored tone stays at 1 kHz: " + hz);
    speaker.destroy();

    global.window.AudioWorklet = false;
    const [fallbackHost, fallbackGuest] = Bus.create();
    const fallback = new SpeakerAdapter(fallbackHost);
    let fallbackRequests = 0;
    fallbackGuest.register("dac-request-data", () => fallbackRequests++);
    fallbackGuest.send("emulator-started");
    fallbackGuest.send("dac-enable");
    fallbackGuest.send("dac-tell-sampling-rate", 44100);
    fallbackGuest.send("dac-send-data", [tone, tone.slice()]);
    assert.equal(fallback.audio_context.lastRate, 44100);
    assert.equal(fallback.dac.sources.size, 1);
    const beforeReset = fallbackRequests;
    fallbackGuest.send("dac-reset");
    assert.equal(fallback.dac.sources.size, 0, "legacy output stops queued AudioBufferSources");
    assert.equal(fallback.dac.buffered_time, 0);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(fallbackRequests, beforeReset, "legacy output ignores stale ended/timer callbacks");
    fallback.destroy();
    console.log("speaker_restore_test: sampling rate, queue reset, paused DMA, stale pump and 1 kHz pitch passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
