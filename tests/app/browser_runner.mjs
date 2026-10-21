#!/usr/bin/env node
// The VM manager's pages in headless Chrome (docs/vm-manager-plan.md): a
// static server for the repository (no caching), a page that reports its
// result in an element #result starting with PASS or FAIL (the server adds
// the script that sends it here), and Chrome with a profile of its own.
//   node tests/app/browser_runner.mjs <page> [query arguments...]
//   node tests/app/browser_runner.mjs tests/app/store_test.html
// Needs Chrome (CHROME); TIMEOUT_MS (default 300000).

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const page = process.argv[2];
if(!page)
{
    console.error("usage: node tests/app/browser_runner.mjs <page> [query arguments...]");
    process.exit(2);
}
const query = process.argv.slice(3).join("&");

const REPORTER = `<script>
    const reporter = new MutationObserver(() => {
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
    let body;
    try { body = fs.readFileSync(file); }
    catch(e) { res.writeHead(404).end(); return; }
    if(file.endsWith(".html")) body = Buffer.concat([body, Buffer.from(REPORTER)]);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
});

function finish(code)
{
    clearTimeout(timeout);
    server.close();
    process.exitCode = code;
    const remove = () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch(e) {} };
    if(browser && browser.exitCode === null && browser.signalCode === null)
    {
        browser.on("exit", remove);
        browser.kill();
    }
    else remove();
}

server.listen(0, "127.0.0.1", () =>
{
    const url = "http://127.0.0.1:" + server.address().port + "/" + page + (query ? "?" + query : "");
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
