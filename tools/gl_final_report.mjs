#!/usr/bin/env node
// Freeze only complete, current application runs. Original game packages and
// screenshots remain local; this report retains hashes and raw measurements.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire as create_require } from "node:module";
import { fileURLToPath as file_url_to_path } from "node:url";
const root = file_url_to_path(new URL("../", import.meta.url)), output = root + "tests/glbridge/acceptance/";
const read = file => JSON.parse(fs.readFileSync(file));
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const revision = read(root + "build/glbridge/manifest.json").revision;
const baseline_revision = "6a5eb14d73549ecd56fe", records = [];
const protocol = create_require(import.meta.url)("../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const assert = (ok, message) => { if(!ok) throw new Error(message); };
const mean = numbers => numbers.reduce((a, b) => a + b, 0) / numbers.length;
const gate = read(output + "mutation-gate.json");
assert(gate.exitCode === 0 && gate.applied === 802 && gate.killed === 792 && gate.families.length === 44, "Incomplete mutation gate");
for(const [file, digest] of Object.entries(gate.sourceHashes)) assert(hash(root + file) === digest, "Gate source changed: " + file);
assert(hash(root + "tests/glbridge/mutations.mjs") === gate.driverHashes.runner &&
    hash(root + "tests/glbridge/mutation_killers.json") === gate.driverHashes.hints, "Mutation driver changed after the successful gate");
const coverage = read(root + "tests/glbridge/gl_behavior_coverage.json"),
    core_groups = fs.readFileSync(output + "core-regression.log", "utf8").split("\n").filter(line => line.startsWith("PASS ")).length,
    gpu_pages = fs.readFileSync(output + "gpu-regression.log", "utf8").split("\n").filter(line => /^(gl|d3d9)_\w+_browser_test\.html(\?\S+)?$/.test(line)).length,
    gles_groups = fs.readFileSync(output + "gles-regression.log", "utf8").split("\n").filter(line => line.startsWith("node tests/gles/")).length;
assert(core_groups === 115 && gpu_pages === 55 && gles_groups === 9 && coverage.suites.length === 94 &&
    Object.keys(protocol.GLFN).length === 257 && Object.keys(protocol.GLFN).every(name => coverage.records[name]?.length) &&
    !coverage.missing.length, "Incomplete regression evidence");
for(const program of ["glview", "warcraft3", "cube2", "quake3", "wined3d"])
    for(const worker of [false, true]) {
        const name = "gl-final-" + program + "-" + (worker ? "worker" : "local"),
            file = root + "build/browser-test-output/" + name + ".json", entry = read(file);
        assert(entry.program === program && entry.worker === worker && entry.revision === revision, name + ": stale identity");
        assert(entry.fullVM.cold && entry.fullVM.format === "stream-v9" && entry.fullVM.contexts > 0 &&
            JSON.stringify(entry.fullVM.before) === JSON.stringify(entry.fullVM.after), name + ": incomplete cold restore");
        assert(entry.frames === 64 && entry.frameMs.samples.length === 64 && !entry.errors.length, name + ": incomplete resumed frames");
        const sequence = entry.sequence;
        assert(sequence?.previousContextsReleased && sequence.after.draws > sequence.before.draws &&
            sequence.after.textureUploads > sequence.before.textureUploads, name + ": incomplete second program");
        const comparison = entry.comparison, measurements = comparison?.results;
        assert(comparison?.warmupFrames === 21 && comparison.measuredFrames === 64 && measurements?.length === 4 &&
            measurements.map(r => r.backend).join() === "candidate,baseline,baseline,candidate", name + ": invalid pairing");
        for(const measurement of measurements) {
            assert(measurement.revision === (measurement.backend === "baseline" ? baseline_revision : revision), name + ": wrong benchmark asset");
            for(const metric of [measurement.frameMs, measurement.executorCpuMs])
                assert(metric.samples.length === 64 && metric.samples.every(x => Number.isFinite(x) && x >= 0), name + ": invalid measurements");
        }
        for(const stats of [entry.beforeStats, entry.afterStats, sequence.after, ...measurements.map(r => r.stats)])
            assert(!stats.refusals && !stats.pipelinesRejected && !stats.framesRejected && !stats.hostErrors, name + ": renderer rejected work");
        if(program === "quake3") assert(entry.observations.depthReadbacks > 0 && entry.observations.stencilEnables > 0 &&
            entry.observations.depthRanges.some(r => r[0] === 0 && r[1] > 0 && r[1] < 1), name + ": missing depth/stencil behavior");
        const timings = {};
        for(const backend of ["baseline", "candidate"]) {
            const runs = measurements.filter(r => r.backend === backend);
            timings[backend] = { frameMedianMs: mean(runs.map(r => r.frameMs.median)), executorCpuMedianMs: mean(runs.map(r => r.executorCpuMs.median)) };
        }
        const screenshots = ["before", "restored", "resumed", "second-program"].map(suffix => {
            const image = root + "build/browser-test-output/" + name + "-" + suffix + ".png";
            assert(fs.statSync(image).size > 0, name + ": missing screenshot");return { path: path.relative(root, image), sha256: hash(image) };
        });
        const log = file.replace(/\.json$/, ".log");assert(fs.readFileSync(log, "utf8").includes("PASS complete VM cold restore"), name + ": missing successful runner log");
        const application = { glview: "GLView 2.6.0", warcraft3: "Warcraft III", cube2: "Cube 2", quake3: "Tremulous GPP1 (Quake 3 engine)", wined3d: "WineD3D 1.7.52 / D3D8 cube" }[program];
        records.push({ name, program, application, worker, evidence: path.basename(file), evidenceSha256: hash(file), screenshots,
            snapshotBytes: entry.fullVM.bytes, pixelSha256: entry.fullVM.before.sha256, secondProgram: sequence.second, observations: entry.observations, timings });
    }
// Validate the complete set before replacing any committed evidence.
fs.mkdirSync(output, { recursive: true });
for(const record of records) for(const extension of [".json", ".log"])
    fs.copyFileSync(root + "build/browser-test-output/" + record.name + extension, output + record.name + extension);
fs.copyFileSync(root + "build/gl-final/inputs.json", output + "application-inputs.json");
const assets = root + "build/gl-acceptance-assets/", packages = [
    { file: "GLview-2.60.download", source: "https://www.realtech-vr.com/glview-download/" },
    { file: "WineD3D-1.7.52.zip", source: "WineD3D for Windows 1.7.52; included README.txt identifies the MinGW prebuilt distribution" },
    { file: "tremulous-1.1.0-installer.exe", source: "https://downloads.sourceforge.net/project/tremulous/tremulous/1.1/tremulous-1.1.0-installer.exe" },
    { file: "tremulous-gpp1-installer.exe", source: "https://downloads.sourceforge.net/project/tremulous/tremulous/gpp/tremulous-gpp1-installer.exe" },
].map(entry => ({ ...entry, bytes: fs.statSync(assets + entry.file).size, sha256: hash(assets + entry.file) }));
const source_files = ["tremulous-source/tremulous-1.1.0-src/src/renderer/tr_surface.c", "tremulous-gpp-source/tremulous-ggp1-src/src/renderer/tr_surface.c",
    "tremulous-gpp-source/tremulous-ggp1-src/src/renderer/tr_flares.c", "tremulous-gpp-source/tremulous-ggp1-src/src/game/g_cmds.c", "wined3d/README.txt"];
fs.writeFileSync(output + "package-provenance.json", JSON.stringify({ packages, extractedSources: source_files.map(file => ({ file, sha256: hash(assets + file) })),
    note: "Original packages and extracted sources are retained locally. No third-party binary or map package is redistributed in this evidence directory." }, null, 2) + "\n");
fs.writeFileSync(output + "application-matrix.json", JSON.stringify({ version: 1, date: "2026-11-01", revision, baselineRevision: baseline_revision,
    baseline: "retro-gaming-site e0b52c0 F6 shipped host assets", method: "Serial full-VM cold restore, exact stopped composed RGBA, 64 resumed frames, ABBA from the same snapshot (21 warmup + 64 measured frames per run), then a second real program in the same VM. Timing summaries average the two run medians; raw samples are retained.",
    scope: "Application rendering smoke and explicit engine feature counters; this is not every GLView checkbox, full dEQP, or native conformance. Package corrections and test-only map provenance are documented in docs/opengl-webgpu-acceptance.md.",
    timingRepetitions: [{ evidence: "quake3-worker-first.json", sha256: hash(output + "quake3-worker-first.json") }],
    regression: { coreGroups: core_groups, gpuPages: gpu_pages, sharedGlesGroups: gles_groups, behaviorSuites: coverage.suites.length, records: Object.keys(protocol.GLFN).length,
        mutationFamilies: gate.families.length, mutants: gate.applied, killed: gate.killed, survivors: gate.survivors },
    inputsSha256: hash(output + "application-inputs.json"), records }, null, 2) + "\n");
console.log("Verified and froze " + records.length + " current application/mode runs at " + revision);
