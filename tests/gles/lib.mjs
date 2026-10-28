// What the GLES tests share: a renderer channel that keeps the batches it
// is sent (and answers them: done, reads with a pattern), and a guest
// client of a host's services (a process pipe, connections whose calls are
// encoded as the guest's encoder does and whose replies are read back).
import fs from "node:fs";
import { command_of_name, decode_reply, encode_command, has_reply } from "../../src/gles/gles_wire.js";
import { read_gles_batch } from "../../src/gles/gles_batch.js";
import { READBACK_HEADER_BYTES, RESPONSE_OK } from "../../src/graphics_adapters/renderer_protocol.js";

/**
 * A renderer channel: `batches` the submitted batches' bytes; with `manual`
 * nothing is answered until run(); reads are answered with bytes of the
 * request id's value; a snapshot's page state (gles_save) is
 * ["page state <n>", []], and the states given back are `restored`
 * @param {{manual: (boolean|undefined)}=} options
 */
export function fake_renderer(options = {})
{
    let listener = null;
    const pending = [];
    const channel = {
        batches: [], messages: [], restored: [], saves: 0,
        post(message)
        {
            channel.messages.push(message.type);
            if(message.type === "gles_save")
            {
                const id = message.id, n = ++channel.saves;
                setTimeout(() => listener({ type: "gles_saved", id, state: ["page state " + n, []] }), 0);
                return;
            }
            if(message.type === "gles_restore") channel.restored.push(message.state);
            if(message.type !== "submit") return;
            channel.batches.push(message.bytes);
            pending.push(message);
            if(!options.manual) channel.run();
        },
        listen(handler) { listener = handler; },
        /** answer the batches sent so far (at most `count`): their reads, then done */
        run(count = Infinity)
        {
            while(pending.length && count-- > 0)
            {
                const message = pending.shift();
                for(const record of read_gles_batch(message.bytes))
                {
                    if(!["READ_PIXELS", "COLOR_BUFFER_READ", "BUFFER_READ", "QUERY_READ"].includes(record.name)) continue;
                    const size = record.name === "BUFFER_READ" ? record.length : record.name === "QUERY_READ" ? 4 : record.width * record.height * 4;
                    const bytes = new Uint8Array(READBACK_HEADER_BYTES + size);
                    const view = new DataView(bytes.buffer);
                    view.setUint32(0, record.request, true);
                    view.setUint32(4, size, true);
                    view.setUint32(12, RESPONSE_OK, true);
                    bytes.fill(record.request & 0xFF, READBACK_HEADER_BYTES);
                    listener({ type: "write", offset: 0, bytes });
                }
                listener({ type: "done", seq: message.seq });
            }
        },
        /** every record of every batch so far */
        records(decode = true) { return channel.batches.flatMap(bytes => read_gles_batch(bytes, decode)); },
    };
    return channel;
}

/** Let promises settle (replies that waited) */
export const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * A guest process of a host: its process id from GLProcessPipe, and
 * connections whose calls return their decoded replies
 * @param {!Object} host a GLESHost
 */
export function client(host)
{
    const process_pipe = host.service("GLProcessPipe", () => {});
    process_pipe.write(new Uint8Array(new Uint32Array([100]).buffer));
    const id = process_pipe.read(8);
    const puid = new DataView(id.buffer, id.byteOffset).getUint32(0, true);
    const connect = async () =>
    {
        const service = host.service("opengles", () => {});
        service.write(new Uint8Array(4));
        /** @return {!Promise<{outs: !Array<!Uint8Array>, ret: number}>} */
        const call = async (name, ...args) =>
        {
            service.write(encode_command(name, args));
            await settle();
            // (a reply that waits for the page: until it is there, or a broken stream's none)
            for(let tries = 0; has_reply(command_of_name(name)) && !service.available(); tries++)
            {
                if(tries > 20000) throw new Error(name + ": no reply (" + JSON.stringify(host.summary().malformed) + ")");
                await settle();
            }
            const parts = [];
            for(let bytes; (bytes = service.read(1 << 20));) parts.push(bytes.slice());
            const reply = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let at = 0;
            for(const p of parts) { reply.set(p, at); at += p.length; }
            return reply.length ? decode_reply(name, args, reply) : { outs: [], ret: undefined };
        };
        /** a call whose reply is not read (it does not have one) */
        const send = (name, ...args) => service.write(encode_command(name, args));
        await call("rcSetPuid", puid);
        return { call, send, service };
    };
    return { puid, process_pipe, connect };
}

export const i32s = bytes => Array.from(new Int32Array(bytes.slice().buffer));
export const f32s = bytes => Array.from(new Float32Array(bytes.slice().buffer));
export const text = bytes => new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
export const ints = values => new Uint8Array(new Int32Array(values).buffer);
export const floats = values => new Uint8Array(new Float32Array(values).buffer);
export const cstring = s => new TextEncoder().encode(s + "\0");

/**
 * A renderer channel that records every batch into a file (each a u32
 * length, then the batch: tools/gles/batches.mjs reads them) and answers as
 * the page without an executor does: reads failed (the guest reads zeros),
 * each batch done
 * @param {string} file
 */
export function recording_renderer(file)
{
    fs.writeFileSync(file, new Uint8Array(0));
    let listener = null;
    const channel = {
        batches: 0, bytes: 0,
        post(message)
        {
            if(message.type !== "submit") return;
            const length = new Uint8Array(new Uint32Array([message.bytes.length]).buffer);
            fs.appendFileSync(file, length);
            fs.appendFileSync(file, message.bytes);
            channel.batches++;
            channel.bytes += message.bytes.length;
            for(const record of read_gles_batch(message.bytes))
            {
                if(record.name !== "READ_PIXELS" && record.name !== "COLOR_BUFFER_READ") continue;
                const bytes = new Uint8Array(READBACK_HEADER_BYTES);
                new DataView(bytes.buffer).setUint32(0, record.request, true);
                new DataView(bytes.buffer).setUint32(12, 2, true);
                listener({ type: "write", offset: 0, bytes });
            }
            listener({ type: "done", seq: message.seq });
        },
        listen(handler) { listener = handler; },
    };
    return channel;
}
