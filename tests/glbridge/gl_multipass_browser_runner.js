#!/usr/bin/env node
// Real GPU test, isolated from the game page and the user's browser profile.
// GL_CHROME can select a Chromium executable on non-macOS hosts; GL_TIMEOUT_MS
// the time a page has (60 s). A page can save files (screenshots) by POSTing
// them to /__test_file?name=<name>: they land in build/browser-test-output/.
"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const root = path.resolve(__dirname, "../..");
const profile = fs.mkdtempSync(path.join(require("os").tmpdir(), "gl-multipass-"));
let browser, timeout;
const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url.startsWith("/__test_file?")) {
        const name = path.basename(new URL(req.url, "http://localhost").searchParams.get("name") || "file");
        const chunks = [];
        req.on("data", data => chunks.push(data));
        req.on("end", () => {
            const directory = path.join(root, "build/browser-test-output");
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, name), Buffer.concat(chunks));
            res.end("OK");
        });
        return;
    }
    if (req.method === "POST" && req.url === "/__test_result") {
        let body = "";
        req.on("data", data => { body += data; });
        req.on("end", () => {
            res.end("OK");
            console.log(body);
            finish(JSON.parse(body).status === "PASS" ? 0 : 1);
        });
        return;
    }
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, "." + pathname);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, data) => {
        if (error) { res.writeHead(404).end(); return; }
        res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" :
            /\.(js|mjs)$/.test(file) ? "text/javascript" : "text/html");
        if (file.endsWith(".html")) data = Buffer.concat([data, Buffer.from(`<script>
            const reporter = new MutationObserver(() => {
                const result = document.getElementById("result");
                const text = result && result.textContent || "";
                if (!/^(PASS|FAIL)\\b/.test(text)) return;
                reporter.disconnect();
                fetch("/__test_result", { method: "POST", body: JSON.stringify({
                    status: text.startsWith("PASS") ? "PASS" : "FAIL", details: text
                }) });
            });
            reporter.observe(document.body || document.documentElement, { subtree: true, childList: true, characterData: true });
        </script>`)]);
        res.end(data);
    });
});
function finish(code) {
    clearTimeout(timeout);
    const clean = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (browser) {
        const child = browser;browser = null;
        if (child.exitCode === null && child.signalCode === null) { child.once("exit", clean);child.kill(); }
        else clean();
    } else clean();
    server.close();
    process.exitCode = code;
}
server.listen(0, "127.0.0.1", () => {
    const page = process.argv[2] || "gl_multipass_browser_test.html";
    const url = `http://127.0.0.1:${server.address().port}/tests/glbridge/${page}${page.includes("?") ? "&" : "?"}report=1`;
    browser = spawn(process.env.GL_CHROME ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
        "--headless=new", "--enable-unsafe-webgpu", "--no-first-run",
        ...(process.env.GL_SWIFTSHADER === "1" ? ["--use-webgpu-adapter=swiftshader", "--use-gpu-in-tests"] : []),
        "--no-default-browser-check", "--disable-background-networking",
        `--user-data-dir=${profile}`, url,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    browser.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
    browser.on("error", error => { console.error(error); finish(1); });
    timeout = setTimeout(() => {
        console.error("FAIL: real GPU test timed out\n" + stderr);
        finish(1);
    }, +process.env.GL_TIMEOUT_MS || 60000);
});
