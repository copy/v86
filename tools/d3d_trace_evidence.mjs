#!/usr/bin/env node
// Export reviewable metadata; game packets, screenshots and guest RAM stay local.
import fs from "node:fs";
import crypto from "node:crypto";
import { gunzipSync as gunzip_sync } from "node:zlib";
import { fileURLToPath as file_url_to_path } from "node:url";
const root = file_url_to_path(new URL("../", import.meta.url)), prefix = process.argv[2], destination = process.argv[3];
if(!/^[a-z0-9_-]+$/.test(prefix || "") || !destination) throw new Error("Usage: d3d_trace_evidence.mjs <prefix> <output.json>");
const directory = root + "build/browser-test-output/", read = name => fs.readFileSync(directory + name);
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const capture = JSON.parse(read(prefix + ".json")), policy = JSON.parse(read(prefix + "-pixel-policy.json"));
const golden = gunzip_sync(read(prefix + "-golden.bgra.gz")), journal = capture.format === "paged-d9wg-journal";
const trace = read(prefix + (journal ? "-journal.bin" : "-trace.bin.gz"));
if(hash(journal ? trace : gunzip_sync(trace)) !== policy.traceSha256 || hash(golden) !== policy.goldenSha256 ||
    capture.hostErrors.length || capture.gpuErrors.length || capture.stats.commandsFailed || capture.stats.droppedDraws) throw new Error("Capture is not an accepted baseline");
const observations = policy.runs.map(run => {
    if(!run.evidenceSha256 || !/^[a-z0-9_./-]+$/i.test(run.evidence) || run.evidence.split("/").includes("..")) throw new Error("Unverified reference path");
    const data = read(run.evidence), report = JSON.parse(data), evidence = report.evidence || report;
    if(hash(data) !== run.evidenceSha256 || evidence.hostErrors.length || evidence.gpuErrors.length || evidence.stats.commandsFailed || evidence.stats.droppedDraws) throw new Error("Reference evidence changed or rejected work");
    if(run.bgraFile && hash(gunzip_sync(read(run.bgraFile))) !== run.bgraSha256) throw new Error("Reference pixels changed");
    if(!run.bgraFile && !run.reconstructedFromCompleteDifferenceReport) throw new Error("Reference image missing");
    return { ...run, packets: evidence.packets, indexedDrawCalls: evidence.stats.indexedDrawCalls, elapsedMs: evidence.elapsedMs,
        dispatchMs: evidence.dispatchMs, ...(report.originalLogSha256 ? { originalLogSha256: report.originalLogSha256 } : {}) };
});
fs.writeFileSync(destination, JSON.stringify({
    game: capture.game, worker: capture.worker, width: capture.width, height: capture.height, hostBundle: capture.revision,
    traceFormat: journal ? capture.format : "V86GTRC1", traceBytes: capture.bytes, packets: capture.packets,
    captureStats: capture.stats, inputs: capture.inputs, policy: { ...policy, runs: observations },
    limitations: ["Private game packets, full images and guest state remain in the ignored local build directory.",
        "Only observed finite RGBA tuples at the listed positions are accepted; all other pixels are exact.",
        "Repeatability cause is undetermined. This is a host regression baseline, not native D3D conformance.",
        "Early trial filenames were reused. Overwritten trials are excluded; all listed reports and retained images were hash-verified.",
        "dispatchMs covers all command dispatch, not per-draw CPU cost."]
}, null, 2) + "\n");
console.log("Exported " + observations.length + " verified reference observations, plus the original captured image");
