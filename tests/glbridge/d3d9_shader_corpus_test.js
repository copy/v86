#!/usr/bin/env node
// Replays a directory of real-game shader bytecode through the translator.
//
// This is the consumer of D9WG_DUMP_SHADERS=1 (see dump_shader_bytecode in
// glbridge/d3d9proxy/d3d9_proxy.c). The translator in d3d9_shader_pipeline.js
// is hand-written, so unlike a vkd3d-shader/Tint pipeline it has no years of
// real-game coverage behind it -- and this repository's own tests are written
// against bytecode we assembled by hand, which is exactly the wrong sample: it
// contains the encodings we already thought of, not the ones we did not.
//
// Any D3D9 game is a corpus contributor whether or not it is playable here. A
// client that wedges at its main menu has still created its whole shader set
// during startup, so a few minutes in v86 yields a permanent regression corpus
// that replays offline in a second.
//
// Usage:
//     D9_SHADER_CORPUS=path/to/d3d9_dump node d3d9_shader_corpus_test.js
//     D9_NAGA=~/.cargo/bin/naga  (optional, validates the generated WGSL too)
//
// With no corpus directory this exits 0 after saying so: the dump is opt-in, so
// a checkout without one is not a failure. Point it at a directory of .d9sh
// files (raw DWORD token streams, named by content hash) to get a real report.
//
// Failures are grouped by message rather than listed per shader, because one
// unimplemented opcode in a game's shared shader prologue shows up in dozens of
// shaders and a flat list buries the second distinct problem.

"use strict";

const { findNaga, requireNaga } = require("./naga.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const pipeline = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_shader_pipeline.js");

const strict = process.env.D9_CORPUS_STRICT === "1" || process.env.D3D9_CORPUS_STRICT === "1";
const directory = process.env.D9_SHADER_CORPUS;
if (!directory) {
    if (strict) { console.error("Strict D3D corpus validation requires D9_SHADER_CORPUS");process.exit(1); }
    console.log("SKIP: set D9_SHADER_CORPUS to a directory of .d9sh files " +
        "(produced by running a game with D9WG_DUMP_SHADERS=1) -- no corpus, " +
        "nothing to replay");
    process.exit(0);
}
if (!fs.existsSync(directory)) {
    console.error("D9_SHADER_CORPUS points at " + directory +
        ", which does not exist");
    process.exit(1);
}

const naga = strict ? requireNaga("strict D3D game corpus") : findNaga();

const files = fs.readdirSync(directory)
    .filter(name => name.endsWith(".d9sh"))
    .sort();
if (!files.length) {
    if (strict) { console.error("Strict D3D corpus directory has no .d9sh files");process.exit(1); }
    console.log("SKIP: " + directory + " holds no .d9sh files");
    process.exit(0);
}

const scratch = naga
    ? fs.mkdtempSync(path.join(os.tmpdir(), "d9corpus-")) : null;
// message -> {count, examples}
const translationFailures = new Map();
const validationFailures = new Map();
const notes = new Map();
let translated = 0;
let validated = 0;
const versions = new Map();

function record(map, message, file) {
    let entry = map.get(message);
    if (!entry) map.set(message, entry = { count: 0, examples: [] });
    ++entry.count;
    if (entry.examples.length < 3) entry.examples.push(file);
}

for (const file of files) {
    const bytes = fs.readFileSync(path.join(directory, file));
    if (bytes.length < 8 || bytes.length % 4 !== 0) {
        record(translationFailures, "file is not a whole number of DWORD tokens",
            file);
        continue;
    }
    const tokens = new Uint32Array(bytes.buffer, bytes.byteOffset,
        bytes.length / 4);
    const version = tokens[0];
    const kind = (version >>> 16) === 0xFFFF ? "ps"
        : ((version >>> 16) === 0xFFFE ? "vs" : "??");
    const label = kind + "_" + ((version >>> 8) & 0xFF) + "_" + (version & 0xFF);
    versions.set(label, (versions.get(label) || 0) + 1);

    const result = pipeline.compileShader(tokens);
    if (!result.ok) {
        record(translationFailures, result.error, file);
        continue;
    }
    ++translated;
    for (const note of result.notes || []) record(notes, note, file);
    if (!naga) continue;
    const wgslPath = path.join(scratch, file.replace(/\.d9sh$/, "") + ".wgsl");
    fs.writeFileSync(wgslPath, result.wgsl);
    const run = spawnSync(naga, [wgslPath], { encoding: "utf8" });
    if (run.status !== 0) {
        record(validationFailures,
            (run.stderr || run.stdout || "").trim().split("\n")[0], file);
        continue;
    }
    ++validated;
}

console.log(files.length + " shaders in " + directory);
console.log("  versions: " + [...versions.entries()].sort()
    .map(([label, count]) => label + " x" + count).join(", "));
console.log("  translated: " + translated + "/" + files.length);
if (naga) console.log("  naga-validated: " + validated + "/" + translated);
else console.log("  naga not found; WGSL was generated but not validated");

const report = (title, map) => {
    if (!map.size) return;
    console.log("\n" + title + ":");
    for (const [message, entry] of [...map.entries()]
            .sort((a, b) => b[1].count - a[1].count))
        console.log("  x" + entry.count + "  " + message +
            "\n        e.g. " + entry.examples.join(", "));
};
report("translation failures", translationFailures);
report("WGSL validation failures", validationFailures);
report("notes (translated, but with a documented approximation)", notes);

if (scratch && !validationFailures.size)
    fs.rmSync(scratch, { recursive: true, force: true });
else if (scratch)
    console.log("\ngenerated WGSL kept in " + scratch);

// A corpus is a measurement, not a pass/fail gate: a newly dumped game is
// *expected* to contain instructions we have not implemented, and failing the
// build for that would make people stop dumping. Set D9_CORPUS_STRICT=1 once a
// corpus is checked in as a regression baseline.
if (strict &&
        (translationFailures.size || validationFailures.size)) {
    console.error("\nD9_CORPUS_STRICT=1 and the corpus has failures");
    process.exit(1);
}

// Strict mode also requires Chrome's production Tint validator. Naga alone
// accepts programs that browsers may reject. Private tokens stay under build/.
if (strict) {
    const crypto = require("node:crypto"), root = path.resolve(__dirname, "../..");
    const input = files.map(name => {
        const bytes = fs.readFileSync(path.join(directory, name));
        return { name, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
            tokens: Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readUInt32LE(i * 4)) };
    });
    const target = path.join(root, "build/d3d-review/corpus-tint-input.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(input));
    const checked = spawnSync(process.execPath, [path.join(__dirname, "gl_multipass_browser_runner.js"),
        "d3d9_shader_corpus_browser_test.html"], { cwd: root, encoding: "utf8", timeout: 190000,
        env: { ...process.env, GL_TIMEOUT_MS: process.env.GL_TIMEOUT_MS || "180000" } });
    process.stdout.write(checked.stdout || "");process.stderr.write(checked.stderr || "");
    if (checked.status !== 0) {
        console.error("Strict D3D corpus Chrome Tint validation failed", checked.error || checked.signal || "");
        process.exit(1);
    }
}
