"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), {spawnSync} = require("node:child_process");
const source = fs.readFileSync(path.resolve(__dirname, "../../src/browser/glbridge/d3d9-webgpu/d9wg_resources.js"), "utf8"), directory = fs.mkdtempSync(path.join(os.tmpdir(), "d9wg-bc-srgb-mutants-"));
const cases = [
    ["native sRGB storage", "format: texture.srgbFormat, viewFormats: [],", "format: texture.gpuFormat, viewFormats: [],"],
    ["write invalidation", "if (resource.srgbCopyTexture) resource.srgbCopyDirty = true;", "/* stale mirror after an upload */"],
    ["all mips", "level < texture.levelCount; ++level", "level < 1; ++level"],
    ["physical mip tail", "width: blockAlignedCopyExtent(Math.max(1, texture.width >> level), true)", "width: Math.max(1, texture.width >> level)"],
    ["all cube faces", "depthOrArrayLayers: texture.layerCount || 1", "depthOrArrayLayers: 1"],
    ["mirror retirement", "this.retireGPUObject(resource.srgbCopyTexture);", "/* leak mirror */"],
];
try {
    for (const [name, before, after] of cases) {
        assert.equal(source.split(before).length, 2, name); const file = path.join(directory, "mutated.js"); fs.writeFileSync(file, source.replace(before, after));
        const run = spawnSync(process.execPath, [path.join(__dirname, "d9wg_bc_srgb_test.js")], {env: {...process.env, D9WG_BC_SRGB_SOURCE: file}, encoding: "utf8"});
        assert.notEqual(run.status, 0, "survived " + name); assert.match(run.stderr, /AssertionError/, "runtime assertion required: " + name);
    }
} finally {fs.rmSync(directory, {recursive: true, force: true});}
console.log("PASS BC sRGB mutations: 6/6 native storage, upload invalidation, mip tails, cube layers and retirement");
