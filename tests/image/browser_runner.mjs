#!/usr/bin/env node
// Disk images in headless Chrome (docs/disk-image-formats-plan.md, "运行入口"):
// tests/image/disk_image_browser_test.html, on the page and in the CPU
// Worker, with the images read over HTTP Range requests from this server
// (status 206, Content-Range, a strong ETag, as a static server answers).
// Needs build/libv86.mjs, build/cpu-worker.js, build/v86.wasm and Chrome
// (CHROME). The server counts the requests and bytes of each image.
//   node tests/image/browser_runner.mjs [worker=0|1]

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build_qcow2 } from "./tiny_qcow2.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = path.join(root, "build/disk-image-browser");
fs.mkdirSync(out, { recursive: true });

// MS-DOS 6.22 in a QCOW2 image (its non-zero clusters), and a file that is
// not one
const raw = fs.readFileSync(path.join(root, "images/msdos622.img"));
const data = [];
for(let offset = 0; offset < raw.length; offset += 65536)
{
    const cluster = raw.subarray(offset, offset + 65536);
    if(cluster.some(b => b)) data.push([offset, new Uint8Array(cluster)]);
}
fs.writeFileSync(path.join(out, "msdos622.qcow2"), build_qcow2({ size: raw.length, data }));
fs.writeFileSync(path.join(out, "not-qcow2.qcow2"), new Uint8Array(65536));
// with the samples of tests/image/samples.mjs (qemu-img): hdb, a compressed
// child (deflate) on a parent with Zstandard clusters
const samples = path.join(root, "build/disk-image-samples");
const params = [];
if(fs.existsSync(path.join(samples, "child-zlib.qcow2")))
{
    for(const name of ["child-zlib.qcow2", "v3-zstd.qcow2"]) fs.copyFileSync(path.join(samples, name), path.join(out, name));
    params.push("child_sha256=" + create_hash("sha256").update(fs.readFileSync(path.join(samples, "child.raw"))).digest("hex"));
}
else
{
    console.log("(no samples in build/disk-image-samples: run tests/image/samples.mjs for the hdb test)");
}
// an OVA of tests/image/vmdk.mjs: its disk, a streamOptimized VMDK of the
// samples' base
if(fs.existsSync(path.join(samples, "dos-ustar.ova")))
{
    fs.copyFileSync(path.join(samples, "dos-ustar.ova"), path.join(out, "dos.ova"));
    params.push("base_sha256=" + create_hash("sha256").update(fs.readFileSync(path.join(samples, "base.raw"))).digest("hex"));
}
else
{
    console.log("(no OVA in build/disk-image-samples: run tests/image/vmdk.mjs for the OVA test)");
}

const stats = new Map();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "v86-disk-image-browser-"));
let browser, timeout;

const QEMU_IMG = process.env.QEMU_IMG || (fs.existsSync("/opt/homebrew/bin/qemu-img") ? "/opt/homebrew/bin/qemu-img" : "qemu-img");
const received = [];

const server = http.createServer((req, res) =>
{
    if(req.method === "POST" && req.url.startsWith("/__test_file?"))
    {
        // a file the page made (an exported image)
        const name = path.basename(new URL(req.url, "http://localhost").searchParams.get("name") || "file");
        const chunks = [];
        req.on("data", d => chunks.push(d));
        req.on("end", () =>
        {
            fs.writeFileSync(path.join(out, name), Buffer.concat(chunks));
            received.push(name);
            res.end("OK");
        });
        return;
    }
    if(req.method === "POST" && req.url === "/__test_result")
    {
        let body = "";
        req.on("data", d => { body += d; });
        req.on("end", () =>
        {
            res.end("OK");
            const result = JSON.parse(body);
            console.log(result.details);
            // the QCOW2 export of MS-DOS's disk: qemu-img check, and compare with msdos622.img
            for(const name of received.filter(n => n.endsWith(".qcow2")))
            {
                try
                {
                    execFileSync(QEMU_IMG, ["check", "-q", "-f", "qcow2", path.join(out, name)]);
                    execFileSync(QEMU_IMG, ["compare", "-q", "-f", "qcow2", "-F", "raw", path.join(out, name), path.join(root, "images/msdos622.img")]);
                    console.log(name + ": qemu-img check: no errors; qemu-img compare: equal to msdos622.img");
                }
                catch(error)
                {
                    console.log(name + ": FAIL " + error.message);
                    result.status = "FAIL";
                }
            }
            for(const [name, s] of stats) console.log("served " + name + ": " + s.requests + " requests, " + s.bytes + " bytes of " + s.size);
            finish(result.status === "PASS" ? 0 : 1);
        });
        return;
    }
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = path.resolve(root, "." + pathname);
    if(!file.startsWith(root)) { res.writeHead(403).end(); return; }
    let stat;
    try { stat = fs.statSync(file); }
    catch(e) { res.writeHead(404).end(); return; }
    const type = file.endsWith(".wasm") ? "application/wasm" : /\.(js|mjs)$/.test(file) ? "text/javascript" :
        file.endsWith(".html") ? "text/html" : "application/octet-stream";
    const etag = "\"" + stat.size + "-" + Math.floor(stat.mtimeMs) + "\"";
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers["range"] || "");
    if(range && file.startsWith(out))
    {
        const start = +range[1], end = Math.min(+range[2], stat.size - 1);
        const name = path.basename(file);
        const s = stats.get(name) || { requests: 0, bytes: 0, size: stat.size };
        s.requests++;
        s.bytes += end - start + 1;
        stats.set(name, s);
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
});

function finish(code)
{
    clearTimeout(timeout);
    server.close();
    process.exitCode = code;
    const remove = () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch(e) {} };
    if(browser && browser.exitCode === null)
    {
        browser.on("exit", remove);
        browser.kill();
    }
    else remove();
}

server.listen(0, "127.0.0.1", () =>
{
    const query = process.argv.slice(2).concat(params, ["raw_sha256=" + create_hash("sha256").update(raw).digest("hex")]).join("&");
    const url = "http://127.0.0.1:" + server.address().port + "/tests/image/disk_image_browser_test.html" + (query ? "?" + query : "");
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
