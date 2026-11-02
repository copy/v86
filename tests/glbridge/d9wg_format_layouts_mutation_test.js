"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), {spawnSync} = require("node:child_process");
(async () => {
    const {site_directory} = await import("../lib/site.mjs"), site = site_directory(path.resolve(__dirname, "../..")), source = fs.readFileSync(site + "/glbridge/runtime/d9wg_format_layouts.h", "utf8");
    const fourcc = text => [...text].reduce((n, c, i) => n + c.charCodeAt(0) * 2 ** (i * 8), 0);
    const cases = [
        ["float32 bytes", "{114u, 1u, 1u, 4u, 4u, 0u}", "{114u, 1u, 1u, 16u, 4u, 0u}"],
        ["legacy W11 texture", "{65u, 1u, 1u, 4u, 2u, 0u}", "{65u, 1u, 1u, 4u, 0u, 0u}"],
        ["DXT1 bytes", "{" + fourcc("DXT1") + "u, 4u, 4u, 8u, 7u, 0u}", "{" + fourcc("DXT1") + "u, 4u, 4u, 16u, 7u, 0u}"],
        ["paired width", "{" + fourcc("UYVY") + "u, 2u, 1u, 4u, 6u, 0u}", "{" + fourcc("UYVY") + "u, 1u, 1u, 4u, 6u, 0u}"],
        ["DDraw depth bytes", "{80u, 1u, 1u, 2u, 1u, 1u}", "{80u, 1u, 1u, 4u, 1u, 1u}"],
        ["legacy lockable depth classification", "{70u, 1u, 1u, 2u, 0u, 1u}", "{70u, 1u, 1u, 2u, 0u, 0u}"],
        ["partial columns", "width / bw + (width % bw != 0u)", "width / bw"],
        ["partial rows", "height / bh + (height % bh != 0u)", "height / bh"],
        ["pitch overflow", "if (columns > 0xffffffffu / bytes) return 0;", "if (0 && columns > 0xffffffffu / bytes) return 0;"],
        ["atomic failure", "if (columns > 0xffffffffu / bytes) return 0;", "if (columns > 0xffffffffu / bytes) {*row_count = rows;return 0;}"],
    ];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "d9wg-layout-mutants-"));
    try {
        for (const [name, before, after] of cases) {
            assert.equal(source.split(before).length, 2, name); const file = path.join(directory, "mutated.h"); fs.writeFileSync(file, source.replace(before, after));
            const run = spawnSync(process.execPath, [path.join(__dirname, "d9wg_format_layouts_test.js")], {env: {...process.env, D9WG_FORMAT_LAYOUTS_HEADER: file}, encoding: "utf8"});
            assert.notEqual(run.status, 0, "survived " + name); assert.match(run.stderr, /format layout line/, "runtime assertion required: " + name);
        }
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
    console.log("PASS format layout mutations: 10/10 SDK geometry, legacy membership/depth, partial blocks, overflow and atomic output failures");
})().catch(error => {console.error(error); process.exitCode = 1;});
