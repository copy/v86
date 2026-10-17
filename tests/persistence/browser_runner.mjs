#!/usr/bin/env node
// The disk persistence plan in headless Chrome (docs/disk-persistence-plan.md):
// tests/persistence/browser_test.html, on the page and in the CPU Worker,
// with MS-DOS 6.22 (images/msdos622.img) read over HTTP Range requests from
// this server, which answers as a static server does (206, Content-Range, a
// strong ETag). D0 ("一致读取"): the server records every request's headers
// for the images (a read_only disk sends what it sent before), and changes
// an image's ETag on request (/__bump?name=...): the page checks that the
// disk read fails rather than mixing versions. A second server on another
// origin answers with CORS headers but does not expose the ETag: a
// cross-origin read_only disk works as before, unchecked.
// D2: a disk service (tools/disk-service.mjs, in this process, on another
// port, accepting this page's origin) serves service/*.img: the page writes
// back to it (part=d2), and the runner checks the service's files
// (/__service_file); part=close: the page writes, the runner kills the
// browser (SIGKILL) and finds the write in the service's file; part=pagehide:
// the page writes and navigates away, the runner checks that the session
// was closed (or, when the browser did not send it, that the lease ends);
// part=page: debug.html in a frame, MS-DOS on a disk written back to the
// service (the page's query arguments hda.url, hda.disk_option): the "Save
// and power off" button, the disk error prompt and its Retry
// (/__service_down, /__service_up), the session closed after powering off.
// Needs build/libv86.mjs, build/cpu-worker.js, build/v86.wasm and Chrome (CHROME).
//   node tests/persistence/browser_runner.mjs [worker=0|1] [part=d0|d2|close|pagehide|page]

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { create_disk_service } from "../../tools/disk-service.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = path.join(root, "build/persistence-browser");
fs.mkdirSync(out, { recursive: true });
// (one copy per machine of the test: each its own ETag)
for(const name of ["stop.img", "report.img", "cross.img"])
{
    fs.copyFileSync(path.join(root, "images/msdos622.img"), path.join(out, name));
}
const service_dir = path.join(out, "service");
fs.rmSync(service_dir, { recursive: true, force: true });
fs.mkdirSync(service_dir);
for(const name of ["dos.img", "shared.img", "close.img", "pagehide.img"])
{
    fs.copyFileSync(path.join(root, "images/msdos622.img"), path.join(service_dir, name));
}
const part = (process.argv.find(a => a.startsWith("part=")) || "part=d0").slice(5);
let service, service_listeners = null;
fs.copyFileSync(path.join(root, "images/msdos622.img"), path.join(service_dir, "page.img"));
fs.copyFileSync(path.join(root, "images/msdos622.img"), path.join(service_dir, "site.img"));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "v86-persistence-browser-"));
let browser, timeout;
/** @type {!Map<string, number>} the version of each image's ETag */
const versions = new Map();
/** the headers of the image requests (the request lines' header names) */
const image_requests = [];

function serve(req, res, cross_origin)
{
    const address = new URL(req.url, "http://localhost");
    if(cross_origin)
    {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Range, X-Accept-Encoding");
        res.setHeader("Access-Control-Expose-Headers", "Content-Range");
        if(req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    }
    else if(req.method === "POST" && address.pathname === "/__bump")
    {
        const name = address.searchParams.get("name");
        versions.set(name, (versions.get(name) || 0) + 1);
        res.end("OK");
        return;
    }
    else if(req.method === "GET" && address.pathname === "/__service_file")
    {
        // (the service's image: has it the text, has it a writer)
        const name = path.basename(address.searchParams.get("name"));
        const text = address.searchParams.get("contains") || "";
        const image = service.images.get(name);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ contains: !!text && fs.readFileSync(path.join(service_dir, name)).includes(text),
            writer: !!(image && image.writer && image.writer.expires > Date.now()), session_open: !!(image && image.writer) }));
        return;
    }
    else if(req.method === "POST" && (address.pathname === "/__service_down" || address.pathname === "/__service_up"))
    {
        // (part=page: the disk service unreachable, and back)
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
    else if(req.method === "POST" && address.pathname === "/__kill")
    {
        // part=close: the browser is killed, then the service's file is checked
        const name = path.basename(address.searchParams.get("name"));
        const text = address.searchParams.get("contains");
        res.end("OK");
        setTimeout(() =>
        {
            browser.kill("SIGKILL");
            browser.on("exit", () =>
            {
                const found = fs.readFileSync(path.join(service_dir, name)).includes(text);
                console.log((found ? "PASS" : "FAIL") + "\nthe browser killed (SIGKILL) after the guest wrote: the service's " + name +
                    (found ? " has" : " lacks") + " \"" + text + "\"");
                finish(found ? 0 : 1);
            });
        }, 100);
        return;
    }
    else if(req.method === "GET" && address.pathname === "/__requests")
    {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(image_requests));
        return;
    }
    else if(req.method === "POST" && address.pathname === "/__test_result")
    {
        let body = "";
        req.on("data", d => { body += d; });
        req.on("end", () =>
        {
            res.end("OK");
            const result = JSON.parse(body);
            console.log(result.details);
            finish(result.status === "PASS" ? 0 : 1);
        });
        return;
    }
    const pathname = decodeURIComponent(address.pathname);
    const file = path.resolve(root, "." + pathname);
    if(!file.startsWith(root)) { res.writeHead(403).end(); return; }
    let stat;
    try { stat = fs.statSync(file); }
    catch(e) { res.writeHead(404).end(); return; }
    const type = file.endsWith(".wasm") ? "application/wasm" : /\.(js|mjs)$/.test(file) ? "text/javascript" :
        file.endsWith(".html") ? "text/html" : "application/octet-stream";
    const name = path.basename(file);
    const etag = "\"" + stat.size + "-" + Math.floor(stat.mtimeMs) + "-" + (versions.get(name) || 0) + "\"";
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers["range"] || "");
    if(file.startsWith(out))
    {
        // (the headers v86 chose: not those every request of the browser
        // has, nor the browser's HTTP cache's revalidation: If-None-Match, If-Range)
        image_requests.push({ name, cross_origin, method: req.method,
            headers: Object.keys(req.headers).filter(h => !["host", "connection", "user-agent", "accept", "accept-language",
                "accept-encoding", "referer", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
                "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "if-none-match", "if-modified-since", "if-range", "cache-control",
                "pragma"].includes(h)).sort() });
    }
    if(range && file.startsWith(out))
    {
        const start = +range[1], end = Math.min(+range[2], stat.size - 1);
        const fd = fs.openSync(file, "r");
        const buffer = Buffer.alloc(end - start + 1);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        fs.closeSync(fd);
        res.writeHead(206, { "Content-Type": type, "Content-Range": "bytes " + start + "-" + end + "/" + stat.size,
            "Content-Length": buffer.length, "ETag": etag, "Accept-Ranges": "bytes" });
        res.end(buffer);
        return;
    }
    let body = fs.readFileSync(file);
    if(file.endsWith(".html"))
    {
        body = Buffer.concat([body, Buffer.from(`<script>
            const reporter = new MutationObserver(() => {
                const text = document.getElementById("result")?.textContent || "";
                if(!/^(PASS|FAIL)\\b/.test(text)) return;
                reporter.disconnect();
                fetch("/__test_result", { method: "POST", body: JSON.stringify({ status: text.startsWith("PASS") ? "PASS" : "FAIL", details: text }) });
            });
            reporter.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
        </script>`)]);
    }
    res.writeHead(200, { "Content-Type": type, "ETag": etag, "Accept-Ranges": "bytes" });
    res.end(body);
}

const server = http.createServer((req, res) => serve(req, res, false));
const cross = http.createServer((req, res) => serve(req, res, true));

function finish(code)
{
    clearTimeout(timeout);
    server.close();
    cross.close();
    process.exitCode = code;
    const remove = () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch(e) {} };
    if(service) service.close();
    if(browser && browser.exitCode === null && browser.signalCode === null)
    {
        browser.on("exit", remove);
        browser.kill();
    }
    else remove();
}

await new Promise(resolve => cross.listen(0, "127.0.0.1", resolve));
server.listen(0, "127.0.0.1", async () =>
{
    const page_origin = "http://127.0.0.1:" + server.address().port;
    service = create_disk_service({ dir: service_dir, origins: [page_origin], lease_ms: 3000 });
    await new Promise(resolve => service.server.listen(0, "127.0.0.1", resolve));
    // (the other origin: another port)
    const query = process.argv.slice(2).filter(a => !a.startsWith("part=")).concat(["cross=" + encodeURIComponent("http://127.0.0.1:" + cross.address().port),
        "service=" + encodeURIComponent("http://127.0.0.1:" + service.server.address().port), "part=" + part]).join("&");
    const url = "http://127.0.0.1:" + server.address().port + "/tests/persistence/browser_test.html?" + query;
    console.log(url);
    browser = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
        "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
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
