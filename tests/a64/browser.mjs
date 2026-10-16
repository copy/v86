#!/usr/bin/env node
// The arm64 virt machine in a headless Chrome (docs/arm64-virt-android16-plan.md
// P8.7): tests/a64/browser_test.html from a local server boots Alpine 3.24
// aarch64 from its ISO to a shell and runs the probe, from the source tree,
// from build/libv86.mjs, and in the CPU worker. The files come from
// tests/a64/linux_boot.mjs (A64_LINUX_PREPARE_ONLY=1). BROWSER_CHROME
// selects the browser.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const chrome = process.env.BROWSER_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
for(const file of ["build/a64-linux/boot/vmlinuz-virt", "build/a64-linux/boot/initramfs-virt", "build/a64-linux/probe/probe.tar",
    "build/a64-linux/alpine-virt-3.24.0-aarch64.iso", "build/v86-arm64.wasm"])
{
    if(!fs.existsSync(root + file)) throw new Error(file + " is missing: A64_LINUX_PREPARE_ONLY=1 node tests/a64/linux_boot.mjs, make build/v86-arm64.wasm");
}

function run(query)
{
    return new Promise((resolve, reject) => {
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), "v86-a64-browser-"));
        let browser, timer;
        const server = http.createServer((req, res) => {
            if(req.method === "POST" && req.url === "/__result")
            {
                let body = "";
                req.on("data", data => { body += data; });
                req.on("end", () => { res.end("OK"); finish(body); });
                return;
            }
            const file = path.resolve(root, "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname));
            if(!file.startsWith(root)) { res.writeHead(403).end(); return; }
            fs.stat(file, (error, stat) => {
                if(error || !stat.isFile()) { res.writeHead(404).end(); return; }
                res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" :
                    /\.(js|mjs)$/.test(file) ? "text/javascript" : file.endsWith(".html") ? "text/html" : "application/octet-stream");
                res.setHeader("Accept-Ranges", "bytes");
                // (the ISO is read in ranges: async virtio-blk)
                const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers["range"] || "");
                if(range)
                {
                    const start = +range[1], end = Math.min(+range[2], stat.size - 1);
                    res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
                    fs.createReadStream(file, { start, end }).pipe(res);
                    return;
                }
                if(file.endsWith(".html"))
                {
                    const data = Buffer.concat([fs.readFileSync(file), Buffer.from(`<script>
                        new MutationObserver((_, observer) => {
                            const text = document.getElementById("result").textContent;
                            if(!/^(PASS|FAIL)/.test(text)) return;
                            observer.disconnect();
                            fetch("/__result", { method: "POST", body: text + "\\n" + document.getElementById("log").textContent });
                        }).observe(document.body, { subtree: true, childList: true, characterData: true });
                    </script>`)]);
                    res.end(data);
                    return;
                }
                res.setHeader("Content-Length", stat.size);
                fs.createReadStream(file).pipe(res);
            });
        });
        const finish = text => {
            clearTimeout(timer);
            browser?.kill();
            server.close();
            try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch(e) { /* left in the temporary directory */ }
            (text.startsWith("PASS") ? resolve : reject)(text);
        };
        server.listen(0, "127.0.0.1", () => {
            const url = `http://127.0.0.1:${server.address().port}/tests/a64/browser_test.html?${query}`;
            browser = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check",
                "--disable-background-networking", `--user-data-dir=${profile}`, url], { stdio: "ignore" });
            browser.on("error", error => finish("FAIL " + error));
            timer = setTimeout(() => finish("FAIL timeout"), 900000);
        });
    });
}

let failed = 0;
for(const query of (process.env.A64_BROWSER_QUERIES || "build=source;build=bundle;build=bundle&cpu_worker=1;build=bundle&transport=pci").split(";"))
{
    try
    {
        console.log((await run(query)).split("\n")[0] + "  (" + query + ")");
    }
    catch(error)
    {
        failed++;
        console.log(String(error).slice(0, 3000) + "  (" + query + ")");
    }
}
process.exit(failed ? 1 : 0);
