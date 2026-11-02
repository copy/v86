"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), {spawnSync} = require("node:child_process");
(async () => {
    const {site_directory} = await import("../lib/site.mjs"), site = site_directory(path.resolve(__dirname, "../..")), source = fs.readFileSync(site + "/glbridge/runtime/d9wg_transport.c", "utf8");
    const cases = [
        ["bounded wait", "< D9WG_HOST_CAPS_WAIT_MS", "< (D9WG_HOST_CAPS_WAIT_MS - 1u)"],
        ["rate limiting", "if (!d9wg_retry_ready(now, process->caps_retry_tick, process->caps_retry_armed)) return 0;", "if (0 && !d9wg_retry_ready(now, process->caps_retry_tick, process->caps_retry_armed)) return 0;"],
        ["missing reply grants features", "process->caps_retry_tick = GetTickCount();\n    return 0;", "process->caps_retry_tick = GetTickCount();\n    return 15;"],
        ["valid zero reply", "if (d9wg_host_caps_read(d9wg_transport_response(process), &bits)) return bits;", "if (d9wg_host_caps_read(d9wg_transport_response(process), &bits) && bits) return bits;", 2],
        ["session order", "{32u, guest_features, process->session_id_low, process->session_id_high}", "{32u, guest_features, process->session_id_high, process->session_id_low}"],
        ["failed flush", "if (!flush(FALSE)) return 0;", "if (!flush(FALSE)) { /* poll after failed flush */ }"],
        ["timeout retry stamp", "process->caps_retry_tick = GetTickCount();", "process->caps_retry_tick += 0;"],
    ];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "d9wg-host-feature-mutants-"));
    try {
        for (const [name, before, after, count = 1] of cases) {
            assert.equal(source.split(before).length, count + 1, name); const file = path.join(directory, "mutated.c"); fs.writeFileSync(file, source.replaceAll(before, after));
            const run = spawnSync(process.execPath, [path.join(__dirname, "d9wg_host_features_transport_test.js")], {env: {...process.env, D9WG_HOST_FEATURES_TRANSPORT_SOURCE: file}, encoding: "utf8", timeout: 10000});
            assert.notEqual(run.status, 0, "survived " + name); assert.match(run.stderr, /host caps transport line/, "native runtime assertion required: " + name);
        }
    } finally {fs.rmSync(directory, {recursive: true, force: true});}
    console.log("PASS host feature transport mutations: 7/7 bounded/retry behavior, conservative missing reply, valid zero, HELLO identity and flush failure");
})().catch(error => {console.error(error); process.exitCode = 1;});
