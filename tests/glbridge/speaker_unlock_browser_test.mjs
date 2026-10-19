#!/usr/bin/env node
// The speaker under the browser's autoplay policy (docs/arm64-virt-android16-plan.md
// P12.5; src/browser/speaker.js): headless Chrome with the policy that wants
// a user gesture, a page that starts v86 without one, then a trusted click
// through the DevTools protocol. The AudioContext must be suspended before
// the click and running after it (SpeakerAdapter's unlock).
// GL_CHROME can select a Chromium executable on non-macOS hosts.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const page = `<!doctype html><meta charset="utf-8"><title>speaker unlock</title><pre id="state">loading</pre>
<script type="module">
import { V86 } from "/build/libv86.mjs";
window.vm = new V86({ graphics_adapter: "none", wasm_path: "/build/v86.wasm", bios: { url: "/build/cpu-worker-test.bin" },
    memory_size: 32 << 20, disable_keyboard: true, disable_mouse: true, net_device: { type: "none" }, autostart: true });
window.vm.add_listener("emulator-started", () => { window.started = true; });
</script>`;
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if(pathname === "/unlock.html") { res.setHeader("Content-Type", "text/html"); res.end(page); return; }
    const file = path.resolve(root, "." + pathname);
    if(!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, data) => {
        if(error) { res.writeHead(404).end(); return; }
        res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : /\.(js|mjs)$/.test(file) ? "text/javascript" : "application/octet-stream");
        res.end(data);
    });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-unlock-"));
const browser = spawn(process.env.GL_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--autoplay-policy=document-user-activation-required", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error("FAIL: timed out"); browser.kill(); process.exit(1); }, 60000);
try
{
    // (the DevTools endpoint, from Chrome's stderr)
    let stderr = "";
    const endpoint = await new Promise((resolve, reject) => {
        browser.stderr.on("data", data => {
            stderr += data;
            const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
            if(m) resolve(m[1]);
        });
        browser.on("exit", code => reject(new Error("Chrome exited " + code + "\n" + stderr)));
    });
    const port = new URL(endpoint).port;
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?http://127.0.0.1:${server.address().port}/unlock.html`, { method: "PUT" })).json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let next = 1;
    const pending = new Map();
    socket.onmessage = event => {
        const m = JSON.parse(event.data);
        if(pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const call = (method, params = {}) => new Promise(resolve => {
        const id = next++;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => (await call("Runtime.evaluate", { expression, returnByValue: true })).result.result.value;
    while(!await evaluate("!!window.started")) await sleep(100);
    await sleep(500);
    const before = await evaluate("window.vm.speaker_adapter.audio_context.state");
    assert.equal(before, "suspended", "the context before a gesture");
    for(const type of ["mousePressed", "mouseReleased"])
    {
        await call("Input.dispatchMouseEvent", { type, x: 10, y: 10, button: "left", clickCount: 1 });
    }
    let after = before;
    for(let i = 0; i < 50 && after !== "running"; i++)
    {
        await sleep(100);
        after = await evaluate("window.vm.speaker_adapter.audio_context.state");
    }
    assert.equal(after, "running", "the context after a click");
    const listener = await evaluate("window.vm.speaker_adapter.unlock === null");
    assert.ok(listener, "the unlock listener removed once the context runs");
    console.log(`PASS speaker unlock: ${before} before a gesture, ${after} after a click`);
    socket.close();
}
catch(e)
{
    console.error("FAIL " + (e && e.stack || e));
    process.exitCode = 1;
}
finally
{
    clearTimeout(deadline);
    browser.kill();
    server.close();
}
