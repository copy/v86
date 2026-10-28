// A renderer channel to a real GPU for Node tests (docs/gles-proxy-plan.md
// E3): headless Chrome (WebGPU) runs the page's renderer
// (tests/glbridge/gles_remote_renderer.html: V86SVGARenderer, its GLES
// executor) and the channel's messages cross over HTTP: the page long-polls
// GET /gles/next for what the device posts, POSTs /gles/reply with the
// renderer's answers. Each message is five u32s (kind, two values, the
// stream, the byte length), then its bytes padded to a u32. Both are
// numbered so that a request a suspend (the laptop's sleep) breaks is
// asked again without losing or repeating anything: the page asks
// /gles/next?got=<the answers it has read> and gets the last answer again
// when that one never arrived, and posts /gles/reply?n=<its number>, which
// is taken once. A snapshot's
// GLES state ([json, buffers], src/gles/gles_snapshot.js) crosses as one
// byte string (encode_state).
//
// chrome_renderer({ record }) resolves to the channel once the page is up;
// with `record` every batch also goes into that file (as recording_renderer
// writes them). close() ends Chrome and the server. GL_CHROME names another
// Chromium.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
/** message kinds: the device's, then the renderer's */
export const KIND = { submit: 1, reset: 2, hello: 3, gles_save: 4, gles_restore: 5, done: 11, write: 12, frame: 13, lost: 14, caps: 15,
    gles_saved: 16 };

/** A packed state ([json, buffers]) as bytes: the JSON's length and UTF-8, the count, each buffer's length and bytes */
export function encode_state([json, buffers])
{
    const text = new TextEncoder().encode(json);
    const out = new Uint8Array(8 + text.length + buffers.reduce((n, b) => n + 4 + b.length, 0));
    const view = new DataView(out.buffer);
    view.setUint32(0, text.length, true);
    out.set(text, 4);
    let at = 4 + text.length;
    view.setUint32(at, buffers.length, true);
    at += 4;
    for(const b of buffers)
    {
        view.setUint32(at, b.length, true);
        out.set(b, at + 4);
        at += 4 + b.length;
    }
    return out;
}

/** @param {!Uint8Array} bytes encode_state's @return {!Array<*>} [json, buffers] */
export function decode_state(bytes)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(0, true);
    const json = new TextDecoder().decode(bytes.subarray(4, 4 + length));
    let at = 4 + length;
    const count = view.getUint32(at, true);
    at += 4;
    const buffers = [];
    for(let i = 0; i < count; i++)
    {
        const n = view.getUint32(at, true);
        buffers.push(bytes.slice(at + 4, at + 4 + n));
        at += 4 + n;
    }
    return [json, buffers];
}

/** @param {!Array<{kind: number, a: number, b: number, stream: number, bytes: ?Uint8Array}>} messages @return {!Uint8Array} */
export function encode_messages(messages)
{
    const size = messages.reduce((n, m) => n + 20 + ((m.bytes ? m.bytes.length : 0) + 3 & ~3), 0);
    const out = new Uint8Array(size), view = new DataView(out.buffer);
    let at = 0;
    for(const m of messages)
    {
        const length = m.bytes ? m.bytes.length : 0;
        [m.kind, m.a >>> 0, m.b >>> 0, m.stream || 0, length].forEach((v, i) => view.setUint32(at + 4 * i, v, true));
        if(length) out.set(m.bytes, at + 20);
        at += 20 + (length + 3 & ~3);
    }
    return out;
}

/** @param {!Uint8Array} bytes @return {!Array<{kind: number, a: number, b: number, stream: number, bytes: !Uint8Array}>} */
export function decode_messages(bytes)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const messages = [];
    for(let at = 0; at + 20 <= bytes.length;)
    {
        const length = view.getUint32(at + 16, true);
        messages.push({ kind: view.getUint32(at, true), a: view.getUint32(at + 4, true), b: view.getUint32(at + 8, true),
            stream: view.getUint32(at + 12, true), bytes: bytes.slice(at + 20, at + 20 + length) });
        at += 20 + (length + 3 & ~3);
    }
    return messages;
}

/**
 * @param {{record: (string|undefined), timeout: (number|undefined)}=} options
 * @return {!Promise<!Object>} the channel: post, listen, close, stats
 */
export async function chrome_renderer(options = {})
{
    let listener = () => {};
    const outbox = [];
    let waiting = null;
    // (the answers to /gles/next handed out and the last one's bytes; the last reply taken)
    let sent = 0, last = Buffer.alloc(0), replied = 0;
    // (lose_answers(): the next answer each way lost, its connection broken)
    const lose = { next: false, reply: false };
    const stats = { submitted: 0, bytes: 0, frames: 0, writes: 0, done: 0, resent: 0, repeated: 0 };
    if(options.record) fs.writeFileSync(options.record, new Uint8Array(0));
    let ready;
    const up = new Promise(resolve => { ready = resolve; });
    const answer = (res, body) =>
    {
        sent++;
        last = body;
        if(lose.next) { lose.next = false; res.socket.destroy(); return; }
        res.end(body);
    };
    const send_waiting = () =>
    {
        if(!waiting || !outbox.length) return;
        const res = waiting;
        waiting = null;
        answer(res, Buffer.from(encode_messages(outbox.splice(0))));
    };
    const server = http.createServer((req, res) =>
    {
        const url = new URL(req.url, "http://localhost");
        if(url.pathname === "/gles/next")
        {
            ready();
            // (a request the page gave up on: its answer, if any, is the one sent again below)
            if(waiting) waiting.end(Buffer.alloc(0));
            waiting = null;
            if(Number(url.searchParams.get("got") ?? sent) < sent)
            {
                stats.resent++;
                res.end(last);
                return;
            }
            waiting = res;
            send_waiting();
            // (an empty answer now and then: the page asks again)
            setTimeout(() => { if(waiting === res) { waiting = null; answer(res, Buffer.alloc(0)); } }, 15000);
            return;
        }
        if(url.pathname === "/gles/reply" && req.method === "POST")
        {
            const chunks = [];
            const n = Number(url.searchParams.get("n") || 0);
            req.on("data", d => chunks.push(d));
            req.on("end", () =>
            {
                if(lose.reply) { lose.reply = false; res.socket.destroy(); }
                else res.end("OK");
                // (a reply posted again after a broken request: taken already)
                if(n && n <= replied) { stats.repeated++; return; }
                if(n) replied = n;
                for(const m of decode_messages(new Uint8Array(Buffer.concat(chunks))))
                {
                    switch(m.kind)
                    {
                        case KIND.done: stats.done++; listener({ type: "done", seq: m.a }); break;
                        case KIND.write: stats.writes++; listener({ type: "write", offset: m.a, bytes: m.bytes }); break;
                        case KIND.frame: stats.frames++; listener({ type: "frame", width: m.a, height: m.b, bytes: m.bytes }); break;
                        case KIND.lost: listener({ type: "lost", reason: new TextDecoder().decode(m.bytes) }); break;
                        case KIND.caps: listener({ type: "caps", present: !!m.a }); break;
                        case KIND.gles_saved: listener({ type: "gles_saved", id: m.a, state: m.b ? decode_state(m.bytes) : null }); break;
                    }
                }
            });
            return;
        }
        if(url.pathname === "/gles/log" && req.method === "POST")
        {
            let body = "";
            req.on("data", d => { body += d; });
            req.on("end", () => { res.end("OK"); console.log("[chrome] " + body.slice(0, 2000)); });
            return;
        }
        const file = path.resolve(root, "." + url.pathname);
        if(!file.startsWith(root)) { res.writeHead(403).end(); return; }
        fs.readFile(file, (error, data) =>
        {
            if(error) { res.writeHead(404).end(); return; }
            res.setHeader("Content-Type", /\.(js|mjs)$/.test(file) ? "text/javascript" : file.endsWith(".wasm") ? "application/wasm" : "text/html");
            res.end(data);
        });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gles-renderer-"));
    const url = `http://127.0.0.1:${server.address().port}/tests/glbridge/gles_remote_renderer.html`;
    const browser = spawn(process.env.GL_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
        "--headless=new", "--enable-unsafe-webgpu", "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        `--user-data-dir=${profile}`, url,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    browser.stderr.on("data", d => { stderr = (stderr + d).slice(-4000); });
    // (Chrome goes with the test, however it ends)
    process.once("exit", () => browser.kill());
    for(const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { browser.kill(); process.exit(128 + (signal === "SIGINT" ? 2 : 15)); });
    const timer = setTimeout(() => ready(new Error("Chrome's renderer page did not start\n" + stderr)), options.timeout || 30000);
    const started = await up;
    clearTimeout(timer);
    if(started instanceof Error) throw started;
    const queue = message =>
    {
        outbox.push(message);
        send_waiting();
    };
    return {
        stats,
        listen(handler) { listener = handler; },
        post(message)
        {
            switch(message.type)
            {
                case "submit":
                    stats.submitted++;
                    stats.bytes += message.bytes.length;
                    if(options.record)
                    {
                        fs.appendFileSync(options.record, new Uint8Array(new Uint32Array([message.bytes.length]).buffer));
                        fs.appendFileSync(options.record, message.bytes);
                    }
                    queue({ kind: KIND.submit, a: message.seq, b: 0, stream: message.stream === "gles" ? 1 : 0, bytes: message.bytes });
                    break;
                case "reset": queue({ kind: KIND.reset, a: 0, b: 0, bytes: null }); break;
                case "hello": queue({ kind: KIND.hello, a: 0, b: 0, bytes: null }); break;
                case "gles_save": queue({ kind: KIND.gles_save, a: message.id, b: 0, bytes: null }); break;
                case "gles_restore": queue({ kind: KIND.gles_restore, a: 0, b: 0, bytes: encode_state(message.state) }); break;
            }
        },
        /** the next answer to the page and the next to its reply lost, as a suspend loses them (tests) */
        lose_answers() { lose.next = lose.reply = true; },
        close()
        {
            browser.kill();
            if(waiting) waiting.end(Buffer.alloc(0));
            server.close();
            server.closeAllConnections?.();
            // (Chrome may still be writing its profile: removed once it is gone)
            browser.once("exit", () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch(e) { /* left in the temporary directory */ } });
        },
    };
}
