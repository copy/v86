#!/usr/bin/env node
// Train a finite repeatability policy only on the pinned, unmodified host.
// Failed pixel runs remain in the report; infrastructure/render failures abort.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gunzipSync as gunzip_sync } from "node:zlib";
import { spawnSync as spawn_sync, execFileSync as run } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
import { compare_pixels, compare_frozen_pixels } from "./lib/gl_game_trace_pixels.mjs";
const root = file_url_to_path(new URL("../", import.meta.url)), prefix = process.argv[2], count = Number(process.argv[3] || 8);
if(!/^[a-z0-9_-]+$/.test(prefix || "") || !Number.isInteger(count) || count < 4 || count > 16) throw new Error("Usage: d3d_trace_baseline.mjs <prefix> [4..16 runs]");
const output = root + "build/browser-test-output/", pinned = "81d8d626", frozen = root + "build/d3d-review/baseline-host/";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), sources = {};
for(const file of ["webgpu_host.js", "d3d9-webgpu/d3d9_shader_pipeline.js", "d3d9-webgpu/d9wg_protocol.js", "d3d9-webgpu/d3d9_executor.js", "d3d9-webgpu/ddraw_ops.js"])
{
    const data = run("git", ["show", pinned + ":src/browser/glbridge/" + file], { cwd: root, maxBuffer: 8 << 20 });
    fs.mkdirSync(path.dirname(frozen + file), { recursive: true });fs.writeFileSync(frozen + file, data);sources[file] = hash(data);
}
fs.writeFileSync(frozen + "manifest.json", JSON.stringify({ reference: pinned, sources }, null, 2));
const info = JSON.parse(fs.readFileSync(output + prefix + ".json")), journal = info.format === "paged-d9wg-journal";
const expected = gunzip_sync(fs.readFileSync(output + prefix + "-golden.bgra.gz")), rgba = bytes => {
    const out = new Uint8Array(bytes);for(let at = 0; at < out.length; at += 4) { out[at] = bytes[at + 2];out[at + 2] = bytes[at]; } return out;
};
const series = Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex"), policy_file = output + prefix + "-pixel-policy.json";
const trace = fs.readFileSync(output + prefix + (journal ? "-journal.bin" : "-trace.bin.gz")), trace_hash = hash(journal ? trace : gunzip_sync(trace));
const reference = [rgba(expected)], runs = [], retained = [], previous = fs.existsSync(policy_file) ? JSON.parse(fs.readFileSync(policy_file)) : null;
if(previous)
{
    if(previous.referenceCommit !== pinned || previous.traceSha256 !== trace_hash || previous.goldenSha256 !== hash(expected) ||
        Object.entries(sources).some(([name, digest]) => previous.sources[name] !== digest)) throw new Error("Existing policy belongs to different inputs; use a new capture prefix");
    compare_frozen_pixels(reference[0], reference[0], info.width, info.height, previous.variations);
    const directory = "baseline-history/" + prefix + "/" + series + "/";fs.mkdirSync(output + directory, { recursive: true });
    fs.copyFileSync(policy_file, output + directory + "previous-policy.json");
    for(const [index, old] of previous.runs.entries())
    {
        const file = output + old.evidence, data = fs.readFileSync(file), target = directory + "retained-" + index;
        if(old.evidenceSha256 && hash(data) !== old.evidenceSha256) throw new Error("Retained reference report changed");
        fs.writeFileSync(output + target + ".json", data);
        const pixels = output + (old.bgraFile || old.evidence.replace(/\.json$/, ".bgra.gz"));let bgra_file;
        if(fs.existsSync(pixels))
        {
            if(hash(gunzip_sync(fs.readFileSync(pixels))) !== old.bgraSha256) throw new Error("Retained reference image changed");
            bgra_file = target + ".bgra.gz";fs.copyFileSync(pixels, output + bgra_file);
        }
        else if(!old.reconstructedFromCompleteDifferenceReport) throw new Error("Retained reference image is missing");
        retained.push({ ...old, evidence: target + ".json", evidenceSha256: hash(data), ...(bgra_file ? { bgraFile: bgra_file } : {}) });
    }
}
for(const argument of process.argv.slice(4))
{
    if(!argument.startsWith("--supplement=")) throw new Error("Unknown baseline argument");
    const file = argument.slice(13), raw = fs.readFileSync(file), result = JSON.parse(raw), marker = "D9WG replay differs or rejected work: ";
    const text = result.details.slice(result.details.indexOf(marker) + marker.length).split("\n    at ")[0], evidence = JSON.parse(text);
    if(result.status !== "FAIL" || !result.details.includes(marker) || evidence.game !== info.game || evidence.packets !== info.packets ||
        evidence.differences.length !== evidence.differingBytes || evidence.hostErrors.length || evidence.gpuErrors.length || evidence.stats.commandsFailed || evidence.stats.droppedDraws) throw new Error("Incomplete supplemental baseline report");
    // Every differing byte is present in this exhaustive comparison report;
    // reconstructing its image is exact, not a guessed tolerance or a render.
    const pixels = new Uint8Array(expected), seen = new Set();
    for(const difference of evidence.differences)
    {
        if(!Number.isInteger(difference.at) || difference.at < 0 || difference.at >= pixels.length || seen.has(difference.at) || pixels[difference.at] !== difference.expected ||
            !Number.isInteger(difference.actual) || difference.actual < 0 || difference.actual > 255) throw new Error("Invalid supplemental pixel");
        seen.add(difference.at);pixels[difference.at] = difference.actual;
    }
    reference.push(rgba(pixels));const name = prefix + "-reference-" + series + "-supplement-" + runs.length + ".json";
    fs.writeFileSync(output + name, JSON.stringify({ originalLogSha256: hash(raw), method: "Exact image reconstructed from original golden plus the complete per-byte GPU comparison report", evidence }, null, 2));
    runs.push({ evidence: name, evidenceSha256: hash(fs.readFileSync(output + name)), exitCode: 1, differingBytes: evidence.differingBytes, bgraSha256: hash(pixels), reconstructedFromCompleteDifferenceReport: true });
}
for(let i = 0; i < count; i++)
{
    const label = "reference-" + series + "-" + i, fd = fs.openSync(output + prefix + "-" + label + ".log", "wx");let result;
    try { result = spawn_sync(process.execPath, ["tests/glbridge/gl_multipass_browser_runner.js", "d3d_game_trace_replay_browser_test.html?prefix=" + prefix + "&source=baseline&label=" + label + (journal ? "&journal=1" : "")],
        { cwd: root, stdio: ["ignore", fd, fd], timeout: 600000, env: { ...process.env, GL_TIMEOUT_MS: "590000" } }); }
    finally { fs.closeSync(fd); }
    if(result.error || result.signal) throw new Error("Baseline replay infrastructure failed: " + (result.error || result.signal));
    const file = output + prefix + "-replay-" + label, evidence = JSON.parse(fs.readFileSync(file + ".json"));
    if(evidence.hostErrors.length || evidence.gpuErrors.length || evidence.stats.commandsFailed || evidence.stats.droppedDraws || evidence.stats.framesRejected || evidence.stats.pipelinesRejected) throw new Error("Pinned baseline rejected rendering");
    const pixels = gunzip_sync(fs.readFileSync(file + ".bgra.gz"));reference.push(rgba(pixels));
    runs.push({ evidence: path.basename(file + ".json"), evidenceSha256: hash(fs.readFileSync(file + ".json")), bgraFile: path.basename(file + ".bgra.gz"), exitCode: result.status, differingBytes: evidence.differingBytes, bgraSha256: hash(pixels) });
    console.log("Reference " + (i + 1) + "/" + count + ": " + evidence.differingBytes + " differing bytes");
}
const comparison = compare_pixels(reference, [reference[0]], info.width, info.height), variants = new Map();
for(const item of [...(previous?.variations || []), ...comparison.unstableReferencePixels])
{
    const key = item.y * info.width + item.x, values = variants.get(key) || { x: item.x, y: item.y, rgba: [] };
    for(const tuple of item.rgba) if(!values.rgba.some(old => old.every((v, i) => v === tuple[i]))) values.rgba.push(tuple);
    variants.set(key, values);
}
if(variants.size > 64) throw new Error("Baseline variability is too broad; investigate instead of freezing it");
const policy = { referenceCommit: pinned, sources, width: info.width, height: info.height, traceSha256: trace_hash, goldenSha256: hash(expected),
    method: comparison.mode, variations: [...variants.values()].sort((a, b) => a.y - b.y || a.x - b.x), runs: [...retained, ...runs],
    scope: "Observed repeatability limit of the unmodified host, cause undetermined. Exact tuples at these positions only; every other pixel exact. These samples do not establish native D3D conformance." };
fs.writeFileSync(policy_file + ".tmp", JSON.stringify(policy, null, 2) + "\n");fs.renameSync(policy_file + ".tmp", policy_file);
console.log("Froze " + policy.variations.length + " variable pixels from " + (policy.runs.length + 1) + " pinned reference observations; previous samples retained");
