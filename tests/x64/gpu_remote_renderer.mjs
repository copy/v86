// A real GPU for a guest running in node: the display adapter's 3D renderer
// (src/browser/glbridge/svga_renderer.js) in a headless Chrome with WebGPU,
// connected to the device by a WebSocket. The node harnesses keep their
// automation (screenshots of the device's own picture, keys, overlays) and
// the guest's 3D is drawn by the same code a page runs.
//
//   const remote = await create_remote_renderer();
//   new V86({ ..., graphics_adapter_test: { level: "vgpu9", renderer: remote.renderer } });
//
// GL_CHROME selects the browser. Frames on the socket: a type byte, then
//   1 submit: seq (u32), the batch      2 reset      7 submit of a GX batch
//   3 write: offset (u32), the bytes    4 done: seq (u32)
//   5 lost: the reason (UTF-8)          6 ready (the renderer is up)
//   8 log: a line of the renderer's     9 submit of a VX batch (Venus)

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { submit: 1, reset: 2, write: 3, done: 4, lost: 5, ready: 6, submit_gx: 7, log: 8, submit_vx: 9 };

/** One binary WebSocket frame, server to client (not masked) */
function frame(payload)
{
    const length = payload.length;
    const header = length < 126 ? Buffer.from([0x82, length]) :
        length < 65536 ? Buffer.from([0x82, 126, length >> 8, length & 0xFF]) :
        Buffer.concat([Buffer.from([0x82, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
    return Buffer.concat([header, payload]);
}

/**
 * The messages in what the client sent so far (masked frames, maybe
 * fragmented); keeps what is incomplete
 */
function frame_reader(on_message)
{
    let pending = Buffer.alloc(0), fragments = [];
    return chunk => {
        pending = Buffer.concat([pending, chunk]);
        for(;;)
        {
            if(pending.length < 2) return;
            const fin = pending[0] & 0x80, opcode = pending[0] & 0xF, masked = pending[1] & 0x80;
            let length = pending[1] & 0x7F, at = 2;
            if(length === 126) { if(pending.length < 4) return; length = pending.readUInt16BE(2); at = 4; }
            else if(length === 127) { if(pending.length < 10) return; length = Number(pending.readBigUInt64BE(2)); at = 10; }
            const mask = masked ? pending.subarray(at, at + 4) : null;
            if(masked) at += 4;
            if(pending.length < at + length) return;
            const payload = Buffer.from(pending.subarray(at, at + length));
            if(mask) for(let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            pending = pending.subarray(at + length);
            if(opcode === 8) { on_message(null); return; }
            if(opcode === 0 || opcode === 1 || opcode === 2)
            {
                fragments.push(payload);
                if(fin) { on_message(Buffer.concat(fragments)); fragments = []; }
            }
        }
    };
}

/**
 * @param {{timeout: (number|undefined), shader_dir: (string|undefined)}=} options
 * @return {!Promise<{renderer: !Object, close: function(), stats: !Object}>}
 */
export async function create_remote_renderer(options = {})
{
    let socket = null, to_device = null, ready_resolve, ready_reject;
    const ready = new Promise((resolve, reject) => { ready_resolve = resolve; ready_reject = reject; });
    const stats = { batches: 0, bytes: 0, writes: 0 };

    const server = http.createServer((req, res) => {
        const file = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname);
        if(!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
        fs.readFile(file, (error, data) => {
            if(error) { res.writeHead(404).end(); return; }
            res.setHeader("Content-Type", /\.(js|mjs)$/.test(file) ? "text/javascript" : file.endsWith(".wasm") ? "application/wasm" : "text/html");
            res.end(data);
        });
    });
    server.on("upgrade", (req, connection) => {
        const accept = create_hash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        connection.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
        connection.setNoDelay(true);
        socket = connection;
        connection.on("data", frame_reader(message => {
            if(!message) return;
            const type = message[0];
            if(type === TYPES.ready) { ready_resolve(); return; }
            if(type === TYPES.log) { console.log("renderer: " + message.subarray(1).toString()); return; }
            if(!to_device) return;
            if(type === TYPES.write)
            {
                stats.writes++;
                to_device({ "type": "write", "offset": message.readUInt32LE(1), "bytes": new Uint8Array(message.subarray(5)) });
            }
            else if(type === TYPES.done) to_device({ "type": "done", "seq": message.readUInt32LE(1) });
            else if(type === TYPES.lost) to_device({ "type": "lost", "reason": message.subarray(1).toString() });
        }));
        connection.on("error", () => {});
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "v86-gpu-renderer-"));
    const browser = spawn(process.env.GL_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
        "--headless=new", "--enable-unsafe-webgpu", "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
        `--user-data-dir=${profile}`,
        `http://127.0.0.1:${port}/tests/glbridge/svga_remote_renderer.html?ws=ws://127.0.0.1:${port}/renderer`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    // A harness stopped by a signal skips close(); Chrome would outlive it
    const kill_browser = () => browser.kill("SIGKILL");
    process.on("exit", kill_browser);
    for(const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]])
    {
        if(!process.listenerCount(signal)) process.once(signal, () => process.exit(code));
    }
    let stderr = "";
    browser.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
    let closing = false;
    browser.on("exit", code => {
        ready_reject(new Error("Chrome exited (" + code + "): " + stderr));
        // after that, the device must not wait for it
        if(!closing && to_device) to_device({ "type": "lost", "reason": "Chrome exited (" + code + ")" });
    });
    const timer = setTimeout(() => ready_reject(new Error("the renderer page did not come up\n" + stderr)), options.timeout || 30000);
    try
    {
        await ready;
    }
    finally
    {
        clearTimeout(timer);
    }

    // options.shader_dir: Venus's shaders (VX SHADER_CREATE: SPIR-V, by
    // content) and pipelines (PIPELINE_CREATE, with their shaders' files)
    // written there, a corpus for VX's translation (vx/naga)
    const shader_files = new Map();
    const dump_vx = bytes => {
        const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
        if(words[0] !== 0x30315856) return;
        for(let at = 4, end = Math.min(words[2], words.length); at + 2 <= end;)
        {
            const op = words[at], n = words[at + 1], body = words.subarray(at + 2, at + 2 + n);
            at += 2 + n;
            if(op === 18)
            {
                const spirv = Buffer.from(body.buffer, body.byteOffset + 8, body[1]);
                const name = create_hash("sha1").update(spirv).digest("hex").slice(0, 16) + ".spv";
                shader_files.set(body[0], name);
                if(!fs.existsSync(options.shader_dir + "/" + name)) fs.writeFileSync(options.shader_dir + "/" + name, spirv);
            }
            else if(op === 19)
            {
                let text = Buffer.from(body.buffer, body.byteOffset + 4, (n - 1) * 4).toString("utf8").replace(/\0+$/, "");
                try
                {
                    const desc = JSON.parse(text);
                    for(const stage of desc["stages"] || []) stage["file"] = shader_files.get(stage["shader"]);
                    fs.appendFileSync(options.shader_dir + "/pipelines.jsonl", JSON.stringify(desc) + "\n");
                }
                catch(e) {}
            }
        }
    };
    if(options.shader_dir) fs.mkdirSync(options.shader_dir, { recursive: true });
    const renderer = {
        "post": message => {
            if(!socket) return;
            if(message["type"] === "submit")
            {
                const bytes = message["bytes"], head = Buffer.alloc(5);
                if(options.shader_dir && message["stream"] === "vx") dump_vx(bytes);
                head[0] = message["stream"] === "gx" ? TYPES.submit_gx : message["stream"] === "vx" ? TYPES.submit_vx : TYPES.submit;
                head.writeUInt32LE(message["seq"], 1);
                stats.batches++;
                stats.bytes += bytes.length;
                socket.write(frame(Buffer.concat([head, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)])));
            }
            else if(message["type"] === "reset")
            {
                socket.write(frame(Buffer.from([TYPES.reset])));
            }
        },
        "listen": handler => { to_device = handler; },
    };
    return {
        renderer,
        stats,
        close: () => {
            closing = true;
            socket && socket.destroy();
            browser.kill();
            process.off("exit", kill_browser);
            server.close();
            // (Chrome may still be writing its profile as it goes)
            setTimeout(() => fs.rm(profile, { recursive: true, force: true, maxRetries: 5 }, () => {}), 1000).unref();
        },
    };
}
