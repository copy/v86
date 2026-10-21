#!/usr/bin/env node
// The options the pages give new V86(), recorded in headless Chrome
// (docs/vm-manager-plan.md U0): the VM manager (index.html, build/v86_app.js)
// for every profile (?profile=<id>) and a set of query arguments, the debug
// page (debug.html, src/browser/main.js) for those and for starts from its
// form. A test hook (window.v86_record_options, defined by the script this
// server puts at the top of the pages) receives the options instead of
// starting the emulator. The old page (legacy.html, ADVANCED-compiled
// build/v86_all.js) was recorded too until U7 deleted it.
//   node tests/app/legacy_options.mjs record=<file>   record into a JSON file
//   node tests/app/legacy_options.mjs check=<file>    record and compare with a recorded file
// tests/app/shared_options.mjs makes the same starts from the modules.
// Needs build/v86_app.js and build/libv86.mjs (make app), and Chrome (CHROME).

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { QUERY_CASES, FORM_CASES, profile_ids, compare_records } from "./legacy_cases.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const arg = name => (process.argv.find(a => a.startsWith(name + "=")) || "").slice(name.length + 1) || undefined;
const record_file = arg("record"), check_file = arg("check");
if(!record_file && !check_file)
{
    console.error("usage: node tests/app/legacy_options.mjs record=<file> | check=<file>");
    process.exit(2);
}
/** The pages (the form only on the debug page) */
const PAGES = ["index.html", "debug.html"];
const HAS_FORM = page => page !== "index.html";

// (the page's hook and the frame's report to the driver)
const RECORDER = `<script>
(function() {
    const ser = v =>
        v === undefined ? { $: "undefined" } :
        typeof v === "number" && !Number.isFinite(v) ? { $: String(v) } :
        v === null || typeof v !== "object" && typeof v !== "function" ? v :
        typeof v === "function" ? { $: "function" } :
        v instanceof Element ? { $: "element", id: v.id } :
        v instanceof File ? { $: "File", name: v.name, size: v.size } :
        v instanceof ArrayBuffer ? { $: "ArrayBuffer", byteLength: v.byteLength } :
        Array.isArray(v) ? v.map(ser) :
        Object.fromEntries(Object.keys(v).map(k => [k, ser(v[k])]));
    const fields = () => Object.fromEntries(["memory_size", "vga_memory_size", "cpu_type", "machine_type", "acpi"]
        .map(id => document.getElementById(id)).filter(Boolean).map(e => [e.id, e.type === "checkbox" ? e.checked : e.value]));
    window.v86_record_options = options => parent.postMessage({ kind: "options", options: ser(options), search: location.search,
        title: document.title, fields: fields(), reset: document.getElementById("reset")?.style.display || "" }, "*");
    window.alert = text => parent.postMessage({ kind: "alert", text: String(text), fields: fields() }, "*");
})();
</script>`;

const DRIVER = `<!doctype html><body><script>
(async () => {
    const cases = await (await fetch("/__cases")).json();
    const results = {};
    for(const c of cases)
    {
        results[c.key] = await new Promise(resolve => {
            const frame = document.createElement("iframe");
            let done = false;
            const finish = r => {
                if(done) return;
                done = true;
                removeEventListener("message", on_message);
                clearTimeout(timer);
                frame.remove();
                resolve(r);
            };
            const on_message = e => { if(e.source === frame.contentWindow) finish(e.data); };
            addEventListener("message", on_message);
            const timer = setTimeout(() => finish({ kind: "timeout" }), 20000);
            if(c.form)
            {
                frame.onload = () => {
                    const d = frame.contentDocument;
                    for(const [what, id, value] of c.form)
                    {
                        const e = d.getElementById(id);
                        if(!e) { finish({ kind: "missing", id }); return; }
                        if(what === "click") e.click();
                        else if(what === "check") e.checked = value;
                        else e.value = value;
                    }
                    d.getElementById("start_emulation").click();
                };
            }
            frame.src = c.url;
            document.body.appendChild(frame);
        });
    }
    await fetch("/__done", { method: "POST", body: JSON.stringify(results) });
})();
</script>`;

/** The keys in order, for a stable file */
function sorted(value)
{
    if(Array.isArray(value)) return value.map(sorted);
    if(value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])]));
    return value;
}

const ids = await profile_ids(root);
const cases = [];
for(const page of PAGES)
{
    for(const id of ids) cases.push({ key: page + " ?profile=" + id, url: "/" + page + "?profile=" + id });
    for(const query of QUERY_CASES) cases.push({ key: page + " ?" + query, url: "/" + page + "?" + query });
    if(HAS_FORM(page)) for(const [name, form] of FORM_CASES) cases.push({ key: page + " form " + name, url: "/" + page, form });
}

const profile_dir = fs.mkdtempSync(path.join(os.tmpdir(), "v86-legacy-options-"));
let browser, timeout, port;

const server = http.createServer((req, res) =>
{
    const address = new URL(req.url, "http://localhost");
    if(address.pathname === "/__driver.html") { res.writeHead(200, { "Content-Type": "text/html" }).end(DRIVER); return; }
    if(address.pathname === "/__cases") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(cases)); return; }
    if(address.pathname === "/__done")
    {
        let body = "";
        req.on("data", d => { body += d; });
        req.on("end", () => { res.end("OK"); done(JSON.parse(body)); });
        return;
    }
    const file = path.resolve(root, "." + decodeURIComponent(address.pathname));
    if(!file.startsWith(root)) { res.writeHead(403).end(); return; }
    let body;
    try { body = fs.readFileSync(file); }
    catch(e) { res.writeHead(404).end(); return; }
    const type = file.endsWith(".wasm") ? "application/wasm" : /\.(js|mjs)$/.test(file) ? "text/javascript" :
        file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
    if(file.endsWith(".html")) body = Buffer.from(RECORDER + body.toString());
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
});

function done(results)
{
    clearTimeout(timeout);
    server.close();
    if(browser) browser.kill();
    setTimeout(() => fs.rmSync(profile_dir, { recursive: true, force: true }), 500);

    // (this server's origin, a new port each run, as one name)
    const origin = new RegExp("http://127\\.0\\.0\\.1:" + port, "g");
    const record = {};
    for(const [key, result] of Object.entries(results))
    {
        const value = sorted(result);
        record[key] = JSON.parse(JSON.stringify(value).replace(origin, "http://ORIGIN"));
    }
    // (a form case of a field the page does not have is recorded as such)
    const failed = Object.entries(record).filter(([, r]) => !["options", "alert", "missing"].includes(r.kind));
    for(const [key, r] of failed) console.log("NO OPTIONS " + key + ": " + JSON.stringify(r));
    console.log(Object.keys(record).length + " cases, " + ids.length + " profiles, " + failed.length + " without options");
    if(record_file)
    {
        fs.writeFileSync(record_file, JSON.stringify(record, null, 1) + "\n");
        console.log("recorded " + record_file);
        process.exitCode = failed.length ? 1 : 0;
        return;
    }
    const differences = compare_records(JSON.parse(fs.readFileSync(check_file, "utf8")), record);
    for(const line of differences) console.log(line);
    console.log(differences.length ? "FAIL: " + differences.length + " differences from " + check_file : "PASS: the same as " + check_file);
    process.exitCode = differences.length || failed.length ? 1 : 0;
}

server.listen(0, "127.0.0.1", () =>
{
    port = server.address().port;
    const url = "http://127.0.0.1:" + port + "/__driver.html";
    browser = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
        "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
        "--user-data-dir=" + profile_dir, url,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    browser.stderr.on("data", d => { stderr = (stderr + d).slice(-4000); });
    timeout = setTimeout(() =>
    {
        console.error("FAIL: timed out\n" + stderr);
        server.close();
        browser.kill();
        process.exitCode = 1;
    }, +process.env.TIMEOUT_MS || 600000);
});
