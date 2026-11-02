"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), {spawnSync} = require("node:child_process");
(async () => {
    const {site_directory} = await import("../lib/site.mjs"), site = site_directory(path.resolve(__dirname, "../.."));
    const sources = {js: fs.readFileSync(path.resolve(__dirname, "../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js"), "utf8"), c: fs.readFileSync(site + "/glbridge/runtime/d9wg_host_caps.h", "utf8")};
    const data = "writer(at, out.subarray(0, D9WG.F.HostCapabilities.magic));", completion = "writer(at + D9WG.F.HostCapabilities.magic, out.subarray(D9WG.F.HostCapabilities.magic));";
    const cases = [
        ["adapter features instead of enabled device", "js", "const features = this.device && this.device.features;", "const features = this.adapter && this.adapter.features;"],
        ["filter flag", "js", "has(\"float32-filterable\") ? D9WG.C.D9WG_HOST_FEATURE_FLOAT32_FILTERABLE", "has(\"float32-filterable\") ? D9WG.C.D9WG_HOST_FEATURE_FLOAT32_BLENDABLE"],
        ["zero capability cache", "js", "if (reply.publishedBits === bits) return true;", "if (reply.publishedBits) return true;"],
        ["completion before data", "js", data + "\n                " + completion, completion + "\n                " + data],
        ["retry after partial publication", "js", "delete reply.publishedBits;\n                ++this.stats.responseWriteFailures;", "/* stale publication stays cached */\n                ++this.stats.responseWriteFailures;"],
        ["invalid magic", "c", "if (caps->magic != D9WG_HOST_CAPS_MAGIC) return 0;", "/* trust invalid magic */", 2],
        ["future version", "c", "if (caps->version != D9WG_HOST_CAPS_VERSION) return 0;", "/* accept unknown version */"],
        ["unknown feature bits", "c", "*features = bits & D9WG_HOST_FEATURE_MASK;", "*features = bits;"],
    ];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "d9wg-host-caps-mutants-"));
    try {
        for (const [name, kind, before, after, count = 1] of cases) {
            assert.equal(sources[kind].split(before).length, count + 1, name); const file = path.join(directory, kind === "c" ? "mutated.h" : "mutated.js"); fs.writeFileSync(file, sources[kind].replaceAll(before, after));
            const run = spawnSync(process.execPath, [path.join(__dirname, "d9wg_host_caps_test.js")], {env: {...process.env, [kind === "c" ? "D9WG_HOST_CAPS_HEADER" : "D9WG_HOST_CAPS_SOURCE"]: file}, encoding: "utf8"});
            assert.notEqual(run.status, 0, "survived " + name); assert.match(run.stderr, kind === "c" ? /host caps line/ : /AssertionError/, "semantic assertion required: " + name);
        }
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
    console.log("PASS host capability mutations: 8/8 enabled-device truth, flags, zero cache, publication order/retry and conservative C decoding");
})().catch(error => {console.error(error); process.exitCode = 1;});
