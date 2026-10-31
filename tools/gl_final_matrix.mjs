#!/usr/bin/env node
// Run applications serially so paired timings have no other VM competing.
import fs from "node:fs";
import path from "node:path";
import { spawnSync as spawn_sync } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
const root = file_url_to_path(new URL("../", import.meta.url)), args = process.argv.slice(2);
const only = args.find(x => x.startsWith("--only="))?.slice(7).split(","), resume = args.includes("--resume");
const revision = JSON.parse(fs.readFileSync(root + "build/glbridge/manifest.json")).revision;
const list = ["glview", "warcraft3", "cube2", "quake3", "wined3d"].flatMap(program => [false, true].map(worker => ({program,worker})));
fs.mkdirSync(root + "build/browser-test-output", { recursive: true });
if(only && only.some(key => !list.some(e => key === e.program + ":" + +e.worker))) throw new Error("Unknown application/mode selection");
const valid = (file, entry) => {
    if(!fs.existsSync(file)) return false;
    const e = JSON.parse(fs.readFileSync(file));
    return e.program === entry.program && e.worker === entry.worker && e.revision === revision && e.fullVM.cold && e.fullVM.before.sha256 === e.fullVM.after.sha256 &&
        (entry.program !== "quake3" || e.observations?.depthReadbacks > 0 && e.observations.stencilEnables > 0 && e.observations.depthRanges.some(r => r[0] === 0 && r[1] > 0 && r[1] < 1)) &&
        e.frames === 64 && e.sequence?.previousContextsReleased && !e.errors.length && e.comparison?.results.length === 4 &&
        e.comparison.results.every(r => r.frameMs.samples.length === 64 && r.executorCpuMs.samples.length === 64) &&
        e.comparison.results.filter(r => r.backend === "candidate").every(r => r.revision === revision);
};
for(const entry of list) {
    const key = entry.program + ":" + +entry.worker;
    if(only && !only.includes(key)) continue;
    const prefix = "gl-final-" + entry.program + "-" + (entry.worker ? "worker" : "local"), file = root + "build/browser-test-output/" + prefix + ".json";
    if(resume && valid(file, entry)) { console.log("VERIFIED " + key);continue; }
    const log_file = root + "build/browser-test-output/" + prefix + ".log", fd = fs.openSync(log_file, "w");
    console.log("RUN " + key + ": cold restore, paired timings and second program");
    let result;
    try { result = spawn_sync(process.execPath, ["tests/app/browser_runner.mjs", "tests/glbridge/gl_final_acceptance.html", "isolated=1", "webgpu=1",
        "program=" + entry.program, "worker=" + +entry.worker, "boot_ms=60000"], { cwd: root, stdio: ["ignore", fd, fd], timeout: 1800000,
        env: { ...process.env, TIMEOUT_MS: "1750000", BROWSER_DEBUG_PORT: process.env.BROWSER_DEBUG_PORT || "19317" } }); }
    finally { fs.closeSync(fd); }
    if(result.error || result.status !== 0 || !valid(file, entry)) throw new Error(key + " failed: " + path.relative(root, log_file) + "\n" + (result.error || fs.readFileSync(log_file, "utf8").slice(-6000)));
    console.log("PASS " + key);
}
