#!/usr/bin/env node
// Compare sequential, alternating replays of the same actual game frames.
import fs from "node:fs";
import path from "node:path";
import { createHash as hash } from "node:crypto";
import { execFileSync as run } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compare_pixels } from "./lib/gl_game_trace_pixels.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)), directory = root + "build/browser-test-output/", baseline_root = process.env.GL_TRACE_BASELINE_ROOT;
if(!baseline_root) throw new Error("Set GL_TRACE_BASELINE_ROOT to the exact git-archive 7ac45133 tree used for replay");
const sha = file => hash("sha256").update(fs.readFileSync(file)).digest("hex"), load = file => JSON.parse(fs.readFileSync(file, "utf8"));
const git = args => run("git", args, { cwd: root, encoding: "utf8" }).trim();
const summarize = runs => {
    const frames = runs.flatMap(r => r.frameCpuMs).sort((a, b) => a - b);
    return { frames: frames.length, medianMs: frames[frames.length >> 1], p95Ms: frames[Math.floor(frames.length * .95)], runs };
};
const result = { date: "2026-10-31", baselineCommit: "7ac45133", candidateCommit: git(["rev-parse", "HEAD"]),
    method: "One portable GPU checkpoint and the same 64 recorded actual OpenGL frames per game; 4 warm-up frames, then 60 timed frames. Three alternating pairs for Cube 2, five for Warcraft III, one browser at a time. Executor submit + SwapBuffers CPU time; packet cloning, checkpoint restore and GPU completion excluded. CPU authority and VM emulation are absent from replay; D5 leaves authority files unchanged. Gate compares combined median and p95 rounded to the browser's 0.1 ms resolution and requires equal draw counts. Pixels are exact except positions proven variable across baseline repeats; candidate RGBA at each such position must equal a value actually observed there in the baseline. No component or whole-image tolerance.",
    captureNotes: "Warcraft III startup movie was skipped with Escape in the isolated test browser; capture harness now automates that input. Large checkpoint/trace binaries remain generated artifacts; hashes and reproduction harness are tracked.",
    games: {}, sourceHashes: {}, baselineSourceHashes: {}, harnessHashes: {} };
const baseline_files = git(["ls-tree", "-r", "--name-only", "7ac45133", "src/browser/glbridge"]).split("\n").filter(name => /\.js$/.test(name));
for(const file of baseline_files) {
    const expected = hash("sha256").update(run("git", ["show", "7ac45133:" + file], { cwd: root })).digest("hex"), actual = sha(path.join(baseline_root, file));
    if(actual !== expected) throw new Error("Baseline source differs from 7ac45133: " + file);result.baselineSourceHashes[file] = actual;
}
result.baselineUnusedCompatibilityScript = "gl_bind_layouts.js is present only for the common HTML script list; 7ac45133 does not reference it.";
if(git(["diff", "7ac45133", "--name-only", "--", "src/browser/glbridge/gl-webgpu/gl_shadow*.js"])) throw new Error("CPU authority changed; revise the timing method");
let passed = true;
for(const game of ["cube2", "warcraft3"]) {
    const manifest = load(directory + game + "-worker-trace.json"), sets = {}, rounds = game === "cube2" ? 3 : 5;
    for(const label of ["candidate", "baseline"]) sets[label] = summarize(Array.from({ length: rounds }, (unused, i) => load(directory + game + "-replay-" + label + "-" + (i + 1) + ".json")));
    const all = [...sets.candidate.runs, ...sets.baseline.runs], first = all[0];
    if(manifest.frames !== 64 || manifest.errors.length || manifest.hostErrors.length || manifest.stats.refusals ||
        all.some(r => r.frames !== 60 || r.warmupFrames !== 4 || r.frameCpuMs.length !== 60 || r.frameDraws.length !== 60 || r.frameDraws.some((v, i) => v !== first.frameDraws[i]) || r.hostErrors.length || r.stats.refusals || r.stats.pipelinesRejected || r.stats.framesRejected)) throw new Error(game + " replay evidence mismatch");
    const exact = all.every(r => r.finalPixelsSha256 === first.finalPixelsSha256), pixel_comparison = exact ? { mode: "exact SHA-256", sha256: first.finalPixelsSha256, passed: true } :
        compare_pixels(Array.from({ length: rounds }, (unused, i) => fs.readFileSync(directory + game + "-replay-baseline-" + (i + 1) + ".rgba")),
            Array.from({ length: rounds }, (unused, i) => fs.readFileSync(directory + game + "-replay-candidate-" + (i + 1) + ".rgba")), first.width, first.height);
    const round = value => Math.round(value * 10), gate = pixel_comparison.passed && round(sets.candidate.medianMs) <= round(sets.baseline.medianMs) && round(sets.candidate.p95Ms) <= round(sets.baseline.p95Ms);passed &&= gate;
    result.games[game] = { scene: manifest.scene, workerCapture: manifest.worker, checkpointBytes: manifest.checkpointBytes, traceBytes: manifest.traceBytes,
        traceArtifacts: [manifest.checkpoint, manifest.trace].map(name => ({ path: "build/browser-test-output/" + name, size: fs.statSync(directory + name).size, sha256: sha(directory + name) })),
        captureStats: manifest.stats, captureHostErrors: manifest.hostErrors, captureErrors: manifest.errors, pixelComparison: pixel_comparison,
        ...sets, medianChangePercent: (sets.candidate.medianMs / sets.baseline.medianMs - 1) * 100, gate };
}
for(const file of ["gl_executor.js", "gl_cache_keys.js", "gl_bind_layouts.js", "gl_renderer_snapshot.js"]) result.sourceHashes[file] = sha(root + "src/browser/glbridge/gl-webgpu/" + file);
for(const file of ["tests/glbridge/gl_guest_trace_capture.html", "tests/glbridge/gl_game_trace_replay_browser_test.html", "tests/glbridge/gl_game_trace_codec.js", "tools/gl_guest_acceptance.mjs", "tools/gl_game_trace_report.mjs", "tools/lib/gl_game_trace_pixels.mjs"]) result.harnessHashes[file] = sha(root + file);
result.passed = passed;
const output = root + "tests/glbridge/performance/game_traces_20261031.json";
fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");console.log(path.relative(root, output) + ": " + (passed ? "PASS" : "FAIL"));process.exitCode = passed ? 0 : 1;
