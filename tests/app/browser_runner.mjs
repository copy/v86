#!/usr/bin/env node
// The VM manager's pages in headless Chrome (docs/vm-manager-plan.md): a
// static server for the repository (no caching), a page that reports its
// result in an element #result starting with PASS or FAIL (the server adds
// the script that sends it here), and Chrome with a profile of its own.
// With service=1, a disk service (tools/disk-service.mjs, --allow-create)
// on a directory of its own (with dos.img, a copy of images/msdos622.img),
// for this page's origin: its URL is the page's query argument
// service=<url>; GET /__service_files lists its files, GET
// /__service_file?name=&contains= says whether one has a text and a writer,
// POST /__service_down and /__service_up take the service away and back.
// With isolated=1, the pages cross-origin isolated (COOP/COEP, as the site's
// _headers): the cores in host threads (vCPU workers). With autoplay=1, audio
// plays without a user's gesture (pages that measure their output).
//   node tests/app/browser_runner.mjs <page> [query arguments...]
//   node tests/app/browser_runner.mjs tests/app/store_test.html
// Needs Chrome (CHROME); TIMEOUT_MS (default 300000); BROWSER_DEBUG_PORT (DevTools).

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { create_disk_service } from "../../tools/disk-service.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const page = process.argv[2];
if(!page)
{
    console.error("usage: node tests/app/browser_runner.mjs <page> [query arguments...]");
    process.exit(2);
}
const args = process.argv.slice(3);
const with_service = args.includes("service=1");
const ISOLATION = args.includes("isolated=1") ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } : {};
const AUTOPLAY = args.includes("autoplay=1");
// (webgpu=1: WebGPU on in headless Chrome, as tests/gles/chrome_renderer.mjs has it, and no throttling of a long run's timers)
const WEBGPU = args.includes("webgpu=1");
let query = args.filter(a => a !== "service=1" && a !== "isolated=1" && a !== "autoplay=1" && a !== "webgpu=1").join("&");
let service, service_dir, service_listeners = null;

const REPORTER = `<script>
    let logged = 0;
    const reporter = new MutationObserver(() => {
        // (the page's #log as it grows: an hour-long part says where it is)
        const log = document.getElementById("log")?.textContent || "";
        if(log.length < logged) logged = 0;
        const added = log.slice(logged).replace(/^\\n/, "");
        logged = log.length;
        if(added) fetch("/__log", { method: "POST", body: "log: " + added });
        const text = document.getElementById("result")?.textContent || "";
        if(!/^(PASS|FAIL)\\b/.test(text)) return;
        reporter.disconnect();
        fetch("/__test_result", { method: "POST", body: JSON.stringify({ status: text.startsWith("PASS") ? "PASS" : "FAIL", details: text }) });
    });
    reporter.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    addEventListener("error", e => fetch("/__log", { method: "POST", body: "error: " + e.message + " " + e.filename + ":" + e.lineno }));
    addEventListener("unhandledrejection", e => fetch("/__log", { method: "POST", body: "unhandled rejection: " + (e.reason && e.reason.stack || e.reason) }));
</script>`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
    ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "v86-app-browser-"));
let browser, timeout;

const server = http.createServer((req, res) =>
{
    const address = new URL(req.url, "http://localhost");
    if(address.pathname === "/__service_file")
    {
        const name = path.basename(address.searchParams.get("name") || "");
        const text = address.searchParams.get("contains") || "";
        const image = service && service.images.get(name);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ contains: !!text && fs.readFileSync(path.join(service_dir, name)).includes(text),
            writer: !!(image && image.writer && image.writer.expires > Date.now()), session_open: !!(image && image.writer) }));
        return;
    }
    if(req.method === "POST" && (address.pathname === "/__service_down" || address.pathname === "/__service_up"))
    {
        if(address.pathname === "/__service_down")
        {
            service_listeners = service.server.listeners("request");
            service.server.removeAllListeners("request");
            service.server.on("request", request => request.socket.destroy());
        }
        else if(service_listeners)
        {
            service.server.removeAllListeners("request");
            for(const listener of service_listeners) service.server.on("request", listener);
            service_listeners = null;
        }
        res.end("OK");
        return;
    }
    if(address.pathname === "/__service_files")
    {
        const files = service_dir ? fs.readdirSync(service_dir).filter(name => !name.startsWith(".")).map(name => ({ name, size: fs.statSync(path.join(service_dir, name)).size })) : [];
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(files));
        return;
    }
    if(req.method === "POST" && (address.pathname === "/__test_result" || address.pathname === "/__log"))
    {
        let body = "";
        req.on("data", d => { body += d; });
        req.on("end", () =>
        {
            res.end("OK");
            if(address.pathname === "/__log")
            {
                console.log("[page] " + body);
                return;
            }
            const result = JSON.parse(body);
            console.log(result.details);
            finish(result.status === "PASS" ? 0 : 1);
        });
        return;
    }
    const file = path.resolve(root, "." + decodeURIComponent(address.pathname));
    if(!file.startsWith(root)) { res.writeHead(403).end(); return; }
    let size;
    try { size = fs.statSync(file).isFile() ? fs.statSync(file).size : -1; }
    catch(e) { size = -1; }
    if(size < 0) { res.writeHead(404).end(); return; }
    const type = TYPES[path.extname(file)] || "application/octet-stream";
    // (Range requests, as web servers answer them: v86 reads images given by URL in parts)
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers["range"] || "");
    if(range && !file.endsWith(".html"))
    {
        const first = +range[1], last = Math.min(range[2] ? +range[2] : size - 1, size - 1);
        if(first >= size || last < first)
        {
            res.writeHead(416, { "Content-Range": "bytes */" + size }).end();
            return;
        }
        const part = Buffer.alloc(last - first + 1);
        const fd = fs.openSync(file, "r");
        try { fs.readSync(fd, part, 0, part.length, first); } finally { fs.closeSync(fd); }
        res.writeHead(206, { "Content-Type": type, "Content-Range": "bytes " + first + "-" + last + "/" + size, "Accept-Ranges": "bytes",
            "Content-Length": part.length, "Cache-Control": "no-store", ...ISOLATION });
        res.end(part);
        return;
    }
    if(!file.endsWith(".html"))
    {
        // (streamed: a package of a GB)
        res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size, "Cache-Control": "no-store", ...ISOLATION });
        fs.createReadStream(file).pipe(res);
        return;
    }
    const body = Buffer.concat([fs.readFileSync(file), Buffer.from(REPORTER)]);
    res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store", ...ISOLATION });
    res.end(body);
});

function finish(code)
{
    clearTimeout(timeout);
    server.close();
    if(service) service.close();
    process.exitCode = code;
    const remove = () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch(e) {} };
    if(browser && browser.exitCode === null && browser.signalCode === null)
    {
        browser.on("exit", remove);
        browser.kill();
    }
    else remove();
}

// (the runner stopped from outside: its Chrome stopped too, not left running the page's machine)
for(const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { finish(1); process.exit(1); });

server.listen(0, "127.0.0.1", async () =>
{
    const origin = "http://127.0.0.1:" + server.address().port;
    if(with_service)
    {
        service_dir = fs.mkdtempSync(path.join(profile, "service-"));
        fs.copyFileSync(path.join(root, "images/msdos622.img"), path.join(service_dir, "dos.img"));
        service = create_disk_service({ dir: service_dir, origins: [origin], allow_create: true, lease_ms: 5000 });
        await new Promise(resolve => service.server.listen(0, "127.0.0.1", resolve));
        query = [query, "service=" + encodeURIComponent("http://127.0.0.1:" + service.server.address().port + "/")].filter(Boolean).join("&");
    }
    const url = origin + "/" + page + (query ? "?" + query : "");
    console.log(url);
    browser = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
        "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
        ...(AUTOPLAY ? ["--autoplay-policy=no-user-gesture-required"] : []),
        ...(WEBGPU ? ["--enable-unsafe-webgpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"] : []),
        // (BROWSER_DEBUG_PORT: DevTools on that port, to look at a long part while it runs)
        ...(process.env.BROWSER_DEBUG_PORT ? ["--remote-debugging-port=" + process.env.BROWSER_DEBUG_PORT] : []),
        "--user-data-dir=" + profile, url,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    browser.stderr.on("data", d => { stderr = (stderr + d).slice(-4000); });
    browser.on("error", error => { console.error(error); finish(1); });
    timeout = setTimeout(() =>
    {
        console.error("FAIL: timed out\n" + stderr);
        finish(1);
    }, +process.env.TIMEOUT_MS || 300000);
});
