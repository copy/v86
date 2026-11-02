#!/usr/bin/env node
// Real SwiftShader must detect the original BC view issue and a stale mirror.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url)), directory = path.join(root, "build/d3d-review/stage4f2b-bc-gpu-mutations");
fs.mkdirSync(directory, {recursive: true});
const source = fs.readFileSync(root + "src/browser/glbridge/d3d9-webgpu/d9wg_resources.js", "utf8");
const html = fs.readFileSync(root + "tests/glbridge/d3d9_conformance_browser_test.html", "utf8").replaceAll('src="../../src/', 'src="/src/').replace(/src="(d3d[^"/]+\.js)"/g, 'src="/tests/glbridge/$1"');
const results = [];
for (const [name, before, after, failure] of [
    ["reinterpretation-view", "if (isCompressedFormat(texture.format)) {", "if (false && isCompressedFormat(texture.format)) {", "sRGB decode precedes linear filtering"],
    ["stale-copy", "if (resource.srgbCopyTexture) resource.srgbCopyDirty = true;", "/* stale compressed sRGB copy */", "BC sRGB ordered upload and alternating linear sampling"],
]) {
    assert.equal(source.split(before).length, 2);
    fs.writeFileSync(directory + "/resources.js", source.replace(before, after));
    fs.writeFileSync(directory + "/test.html", html.replace('src="/src/browser/glbridge/d3d9-webgpu/d9wg_resources.js"', 'src="/build/d3d-review/stage4f2b-bc-gpu-mutations/resources.js"'));
    const run = spawnSync(process.execPath, [root + "tests/glbridge/gl_multipass_browser_runner.js", "../../build/d3d-review/stage4f2b-bc-gpu-mutations/test.html?group=bc-srgb"], {cwd: root, env: {...process.env, GL_SWIFTSHADER: "1"}, encoding: "utf8", timeout: 120000});
    assert.equal(run.status, 1, "GPU mutant survived: " + name + ": " + run.stderr);
    const result = JSON.parse(run.stdout); assert.equal(result.status, "FAIL"); assert(result.details.includes("FAIL  ") && result.details.includes(failure));
    assert(!/WebGPU |FAIL exception|host:/.test(result.details), "pixel mismatch, not a transport/validation failure, must kill the mutant");
    fs.writeFileSync(directory + "/" + name + ".json", JSON.stringify(result, null, 2) + "\n"); results.push({name, killed: true, result});
}
fs.writeFileSync(directory + "/result.json", JSON.stringify({status: "PASS", killed: results.length, total: 2, results}, null, 2) + "\n");
console.log("PASS real GPU BC sRGB mutations: 2/2 reinterpretation-view and stale-copy defects produce independent pixel mismatches");
