// virtio-snd (virtio 1.2 section 5.14; docs/arm64-virt-android16-plan.md
// P7.5, P12.5) as a built-in device of the virt machine: one output stream
// (PCM, 1 or 2 channels, S16 or S32, 8000 to 48000 Hz), no jacks, one
// channel map (front left, front right).
//
// The driver's PCM buffers (the tx queue) are played at the stream's rate:
// each comes back when the time it lasts has passed on the machine's clock
// since the stream started, as a sound card's period would, its status
// telling the bytes still queued. The samples go to the speaker
// (src/browser/speaker.js: "dac-send-data") and, as the bytes they are, to
// "virtio-snd-pcm" listeners on the bus ({stream, rate, channels, format,
// bytes}: tests compare checksums).

import { VirtIO, VIRTIO_F_VERSION_1, VirtQueueBufferChain } from "./virtio.js";
import { dbg_assert, dbg_log } from "./log.js";
import { LOG_VIRTIO } from "./const.js";

// requests and statuses (struct virtio_snd_hdr's code)
const R_JACK_INFO = 1, R_PCM_INFO = 0x0100, R_PCM_SET_PARAMS = 0x0101, R_PCM_PREPARE = 0x0102,
    R_PCM_RELEASE = 0x0103, R_PCM_START = 0x0104, R_PCM_STOP = 0x0105, R_CHMAP_INFO = 0x0200;
const S_OK = 0x8000, S_BAD_MSG = 0x8001, S_NOT_SUPP = 0x8002;

// formats and rates (their numbers in the PCM info's bit masks)
const FMT_S16 = 5, FMT_S32 = 17;
const RATES = [5512, 8000, 11025, 16000, 22050, 32000, 44100, 48000];
const RATE_FIRST = 1, RATE_LAST = 7;
const DIRECTION_OUTPUT = 0;
const CHMAP_FL = 3, CHMAP_FR = 4;

const QUEUE_CONTROL = 0, QUEUE_EVENT = 1, QUEUE_TX = 2, QUEUE_RX = 3;
const PCM_INFO_BYTES = 32, CHMAP_INFO_BYTES = 24;

/**
 * @constructor
 * @param {?} cpu
 * @param {?} bus
 * @param {?} transport the device's transport (src/virtio_mmio.js), or null: on the PCIe host at `pci_id`
 * @param {number=} pci_id
 */
export function VirtioSnd(cpu, bus, transport, pci_id)
{
    dbg_assert(transport || pci_id !== undefined && cpu.devices.pci.generic, "virtio-snd: on the virt machine's transports only");
    this.cpu = cpu;
    this.bus = bus;
    this.stream = new_stream();

    const struct = [
        { bytes: 4, name: "jacks", read: () => 0, write: () => {} },
        { bytes: 4, name: "streams", read: () => 1, write: () => {} },
        { bytes: 4, name: "chmaps", read: () => 1, write: () => {} },
    ];

    /** @type {VirtIO} */
    this.virtio = new VirtIO(cpu,
    {
        name: "virtio-snd",
        device_id: 0x1059,
        subsystem_device_id: 25,
        // (a multimedia audio controller, as QEMU's)
        class_code: 0x040100,
        common:
        {
            queues: [0, 1, 2, 3].map(i => ({ size_supported: 64, notify_offset: i })),
            features: [VIRTIO_F_VERSION_1],
            on_driver_ok: () => {},
        },
        notification:
        {
            single_handler: false,
            handlers: [
                () => this.control(),
                // (the event queue's buffers stay with the device: no jack or period events are sent)
                () => {},
                () => this.take_pcm(),
                () => this.take_input(),
            ],
        },
        isr_status: {},
        device_specific: { struct },
        on_reset: () => this.reset_streams(),
        transport: transport || undefined,
        pci_id,
    });
}

/** A stream's state: its parameters, whether it plays, the buffers queued */
function new_stream()
{
    return {
        // the parameters (PCM_SET_PARAMS), null until set
        params: null,
        prepared: false,
        running: false,
        // the machine time the bytes played so far started at, and those bytes
        started: 0,
        played: 0,
        /** @type {!Array<{chain: ?, bytes: !Uint8Array}>} the driver's buffers, in order */
        queue: [],
        // the bytes in the queue's buffers before the first's that have played
        queued_bytes: 0,
    };
}

VirtioSnd.prototype.reset_streams = function()
{
    this.stream = new_stream();
};

/** The control queue: each request answered at once */
VirtioSnd.prototype.control = function()
{
    const queue = this.virtio.queues[QUEUE_CONTROL];
    while(queue.has_request())
    {
        const chain = queue.pop_request();
        const request = new Uint8Array(chain.length_readable);
        chain.get_next_blob(request);
        chain.set_next_blob(this.request(request));
        queue.push_reply(chain);
    }
    queue.flush_replies();
};

/**
 * @param {!Uint8Array} request
 * @return {!Uint8Array} the response: a status, then a query's information
 */
VirtioSnd.prototype.request = function(request)
{
    if(request.length < 4) return status(S_BAD_MSG);
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
    const code = view.getUint32(0, true);
    const word = at => request.length >= at + 4 ? view.getUint32(at, true) : -1;
    if(code === R_JACK_INFO || code === R_PCM_INFO || code === R_CHMAP_INFO)
    {
        // a query: start_id, count, size of each item
        const [start, count, size] = [word(4), word(8), word(12)];
        const items = code === R_PCM_INFO || code === R_CHMAP_INFO ? 1 : 0;
        const minimum = code === R_PCM_INFO ? PCM_INFO_BYTES : CHMAP_INFO_BYTES;
        if(start < 0 || count < 0 || size < minimum || start + count > items) return status(S_BAD_MSG);
        const response = new Uint8Array(4 + count * size);
        new DataView(response.buffer).setUint32(0, S_OK, true);
        for(let i = 0; i < count; i++)
        {
            const item = new DataView(response.buffer, 4 + i * size, size);
            if(code === R_PCM_INFO)
            {
                // hda_fn_nid, features, formats (u64), rates (u64), direction, channels_min, channels_max
                item.setUint32(0, 0, true);
                item.setUint32(4, 0, true);
                item.setUint32(8, (1 << FMT_S16 | 1 << FMT_S32) >>> 0, true);
                item.setUint32(12, 0, true);
                let rates = 0;
                for(let r = RATE_FIRST; r <= RATE_LAST; r++) rates |= 1 << r;
                item.setUint32(16, rates, true);
                item.setUint32(20, 0, true);
                item.setUint8(24, DIRECTION_OUTPUT);
                item.setUint8(25, 1);
                item.setUint8(26, 2);
            }
            else
            {
                // hda_fn_nid, direction, channels, positions[18]
                item.setUint32(0, 0, true);
                item.setUint8(4, DIRECTION_OUTPUT);
                item.setUint8(5, 2);
                item.setUint8(6, CHMAP_FL);
                item.setUint8(7, CHMAP_FR);
            }
        }
        return response;
    }
    // the stream's requests: stream_id first
    const id = word(4);
    if(id !== 0) return status(S_BAD_MSG);
    const stream = this.stream;
    switch(code)
    {
        case R_PCM_SET_PARAMS:
        {
            if(request.length < 24) return status(S_BAD_MSG);
            const [buffer_bytes, period_bytes] = [word(8), word(12)];
            const [channels, format, rate] = [request[20], request[21], request[22]];
            if(stream.running || channels < 1 || channels > 2 || format !== FMT_S16 && format !== FMT_S32 ||
                rate < RATE_FIRST || rate > RATE_LAST || !period_bytes || buffer_bytes < period_bytes)
            {
                return status(S_NOT_SUPP);
            }
            stream.params = { channels, format, rate: RATES[rate], buffer_bytes, period_bytes,
                frame_bytes: channels * (format === FMT_S16 ? 2 : 4) };
            stream.prepared = false;
            return status(S_OK);
        }
        case R_PCM_PREPARE:
            if(!stream.params || stream.running) return status(S_BAD_MSG);
            stream.prepared = true;
            stream.played = 0;
            return status(S_OK);
        case R_PCM_START:
            if(!stream.prepared || stream.running) return status(S_BAD_MSG);
            stream.running = true;
            stream.started = this.now();
            stream.played = 0;
            this.bus.send("dac-tell-sampling-rate", stream.params.rate);
            this.bus.send("dac-enable");
            return status(S_OK);
        case R_PCM_STOP:
            if(!stream.running) return status(S_BAD_MSG);
            this.play(this.now());
            stream.running = false;
            return status(S_OK);
        case R_PCM_RELEASE:
            if(stream.running) return status(S_BAD_MSG);
            // (every buffer still queued comes back)
            this.complete(stream.queue.length);
            stream.prepared = false;
            return status(S_OK);
    }
    dbg_log("virtio-snd: request 0x" + code.toString(16) + " not supported", LOG_VIRTIO);
    return status(S_NOT_SUPP);
};

/** @param {number} code @return {!Uint8Array} */
function status(code)
{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, code, true);
    return bytes;
}

/** The tx queue: the driver's PCM buffers, played in order */
VirtioSnd.prototype.take_pcm = function()
{
    const queue = this.virtio.queues[QUEUE_TX];
    while(queue.has_request())
    {
        const chain = queue.pop_request();
        const data = new Uint8Array(Math.max(0, chain.length_readable - 4));
        const header = new Uint8Array(4);
        chain.get_next_blob(header);
        chain.get_next_blob(data);
        this.stream.queue.push({ chain, bytes: data });
    }
    if(this.stream.running) this.play(this.now());
    else if(!this.stream.prepared) this.complete(this.stream.queue.length);
};

/** The rx queue: no input stream, so its buffers come back empty with an error */
VirtioSnd.prototype.take_input = function()
{
    const queue = this.virtio.queues[QUEUE_RX];
    while(queue.has_request())
    {
        const chain = queue.pop_request();
        const reply = new Uint8Array(8);
        new DataView(reply.buffer).setUint32(0, S_BAD_MSG, true);
        chain.set_next_blob(reply);
        queue.push_reply(chain);
    }
    queue.flush_replies();
};

/** The machine's time in milliseconds (it stops while the machine does) */
VirtioSnd.prototype.now = function()
{
    return this.cpu.clock ? this.cpu.clock.now() : performance.now();
};

/**
 * The buffers whose time has come: those the time since the start covers
 * @param {number} now
 */
VirtioSnd.prototype.play = function(now)
{
    const stream = this.stream;
    if(!stream.running) return;
    const due = Math.floor((now - stream.started) / 1000 * stream.params.rate) * stream.params.frame_bytes;
    let count = 0, played = stream.played;
    while(count < stream.queue.length && played + stream.queue[count].bytes.length <= due)
    {
        played += stream.queue[count].bytes.length;
        count++;
    }
    if(count) this.complete(count);
};

/**
 * The first `count` queued buffers played and back to the driver
 * @param {number} count
 */
VirtioSnd.prototype.complete = function(count)
{
    const stream = this.stream;
    const queue = this.virtio.queues[QUEUE_TX];
    const done = stream.queue.splice(0, count);
    let left = 0;
    for(const item of stream.queue) left += item.bytes.length;
    for(const { chain, bytes } of done)
    {
        stream.played += bytes.length;
        if(stream.params && bytes.length) this.output(bytes);
        // (struct virtio_snd_pcm_status: status, latency_bytes)
        const reply = new Uint8Array(8);
        const view = new DataView(reply.buffer);
        view.setUint32(0, S_OK, true);
        view.setUint32(4, left, true);
        chain.set_next_blob(reply);
        queue.push_reply(chain);
    }
    queue.flush_replies();
};

/** @param {!Uint8Array} bytes the samples played, interleaved */
VirtioSnd.prototype.output = function(bytes)
{
    const { channels, format, rate } = this.stream.params;
    this.bus.send("virtio-snd-pcm", { "stream": 0, "rate": rate, "channels": channels, "format": format === FMT_S16 ? "s16" : "s32",
        "bytes": bytes });
    // the speaker's two channels, as floats
    const width = format === FMT_S16 ? 2 : 4;
    const frames = Math.floor(bytes.length / (width * channels));
    const left = new Float32Array(frames), right = new Float32Array(frames);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for(let i = 0; i < frames; i++)
    {
        const at = i * width * channels;
        const l = width === 2 ? view.getInt16(at, true) / 32768 : view.getInt32(at, true) / 2147483648;
        const r = channels === 1 ? l : width === 2 ? view.getInt16(at + 2, true) / 32768 : view.getInt32(at + 4, true) / 2147483648;
        left[i] = l;
        right[i] = r;
    }
    this.bus.send("dac-send-data", [left, right]);
};

/**
 * (the machine's device timers) the buffers due by now
 * @param {number} now
 * @return {number} milliseconds until it needs to run again
 */
VirtioSnd.prototype.timer = function(now)
{
    const stream = this.stream;
    if(!stream.running || !stream.queue.length) return 100;
    this.play(now);
    if(!stream.queue.length) return 100;
    // (when the next buffer ends)
    const next = (stream.played + stream.queue[0].bytes.length) / stream.params.frame_bytes / stream.params.rate * 1000 + stream.started;
    return Math.max(1, Math.min(100, Math.ceil(next - now)));
};

VirtioSnd.prototype.reset = function()
{
    this.virtio.reset();
    this.reset_streams();
};

VirtioSnd.prototype.get_state = function()
{
    const stream = this.stream;
    // (the buffers queued by their chains' heads: made again from the ring on a restore)
    return [this.virtio, stream.params ? [stream.params.channels, stream.params.format, stream.params.rate,
        stream.params.buffer_bytes, stream.params.period_bytes] : null, stream.prepared, stream.running,
        stream.started, stream.played, stream.queue.map(({ chain }) => chain.head_idx)];
};

VirtioSnd.prototype.set_state = function(state)
{
    this.virtio.set_state(state[0]);
    const stream = this.stream = new_stream();
    if(state[1])
    {
        const [channels, format, rate, buffer_bytes, period_bytes] = state[1];
        stream.params = { channels, format, rate, buffer_bytes, period_bytes, frame_bytes: channels * (format === FMT_S16 ? 2 : 4) };
    }
    stream.prepared = state[2];
    stream.running = state[3];
    stream.started = state[4];
    stream.played = state[5];
    const queue = this.virtio.queues[QUEUE_TX];
    for(const head of state[6] || [])
    {
        const chain = new VirtQueueBufferChain(queue, head);
        const header = new Uint8Array(4), bytes = new Uint8Array(Math.max(0, chain.length_readable - 4));
        chain.get_next_blob(header);
        chain.get_next_blob(bytes);
        stream.queue.push({ chain, bytes });
    }
};
