// A renderer channel to a real GPU for Node tests (docs/gles-proxy-plan.md
// E3): headless Chrome (WebGPU) runs the page's renderer
// (tests/glbridge/gles_remote_renderer.html: V86SVGARenderer, its GLES
// executor) and the channel's messages cross over HTTP: the page long-polls
// GET /gles/next for what the device posts, POSTs /gles/reply with the
// renderer's answers. Each message is five u32s (kind, two values, the
// stream, the byte length), then its bytes padded to a u32.
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
export const KIND = { submit: 1, reset: 2, hello: 3, done: 11, write: 12, frame: 13, lost: 14, caps: 15 };

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
    const stats = { submitted: 0, bytes: 0, frames: 0, writes: 0, done: 0 };
    if(options.record) fs.writeFileSync(options.record, new Uint8Array(0));
    let ready;
    const up = new Promise(resolve => { ready = resolve; });
    const send_waiting = () =>
    {
        if(!waiting || !outbox.length) return;
        const res = waiting;
        waiting = null;
        res.end(Buffer.from(encode_messages(outbox.splice(0))));
    };
    const server = http.createServer((req, res) =>
    {
        const url = new URL(req.url, "http://localhost");
        if(url.pathname === "/gles/next")
        {
            ready();
            if(waiting) waiting.end(Buffer.alloc(0));
            waiting = res;
            send_waiting();
            // (an empty answer now and then: the page asks again)
            setTimeout(() => { if(waiting === res) { waiting = null; res.end(Buffer.alloc(0)); } }, 15000);
            return;
        }
        if(url.pathname === "/gles/reply" && req.method === "POST")
        {
            const chunks = [];
            req.on("data", d => chunks.push(d));
            req.on("end", () =>
            {
                res.end("OK");
                for(const m of decode_messages(new Uint8Array(Buffer.concat(chunks))))
                {
                    switch(m.kind)
                    {
                        case KIND.done: stats.done++; listener({ type: "done", seq: m.a }); break;
                        case KIND.write: stats.writes++; listener({ type: "write", offset: m.a, bytes: m.bytes }); break;
                        case KIND.frame: stats.frames++; listener({ type: "frame", width: m.a, height: m.b, bytes: m.bytes }); break;
                        case KIND.lost: listener({ type: "lost", reason: new TextDecoder().decode(m.bytes) }); break;
                        case KIND.caps: listener({ type: "caps", present: !!m.a }); break;
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
            }
        },
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
