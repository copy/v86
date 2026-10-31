#!/usr/bin/env node
// Observe actual record decoding/dispatch in passing behavioral suites. This
// is deliberately separate from the protocol's structural round-trip test.
/* global __dirname, __filename */
"use strict";
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process"), os = require("node:os");
const root = path.join(__dirname, ".."), protocol = require(path.join(root, "src/browser/glbridge/gl-webgpu/gl_protocol.js"));
if(process.env.GL_BEHAVIOR_CAPTURE) {
    const seen = new Set(), decode = protocol.decodeRecord;
    protocol.decodeRecord = function(name, ...args) { const value = decode.call(this, name, ...args);seen.add(name);return value; };
    const { GLShadow } = require(path.join(root, "src/browser/glbridge/gl-webgpu/gl_shadow.js")), cpu_dispatch = GLShadow.prototype.dispatch;
    GLShadow.prototype.dispatch = function(fn, ...args) {
        const value = cpu_dispatch.call(this, fn, ...args);
        if(!value && this.current && protocol.NAME_BY_OPCODE[fn]) seen.add(protocol.NAME_BY_OPCODE[fn]);return value;
    };
    const { GLWebGPUExecutor } = require(path.join(root, "src/browser/glbridge/gl-webgpu/gl_executor.js")), dispatch = GLWebGPUExecutor.prototype.dispatch;
    GLWebGPUExecutor.prototype.dispatch = function(fn, ...args) {
        const active = this.current || this.handlers[fn]?.needsContext === false, before = this.stats.refusals;
        const value = dispatch.call(this, fn, ...args);
        if(active && before === this.stats.refusals && protocol.NAME_BY_OPCODE[fn]) seen.add(protocol.NAME_BY_OPCODE[fn]);return value;
    };
    process.on("exit", code => {
        if(!code && process.argv[1]?.endsWith("_test.js")) fs.writeFileSync(process.env.GL_BEHAVIOR_CAPTURE + "." + process.pid, JSON.stringify([...seen].sort()));
    });
} else {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "gl-behavior-")), covered = {}, suites = [];
    try {
        for(const file of fs.readdirSync(path.join(root, "tests/glbridge")).sort()) {
            if(!file.startsWith("gl_") || !file.endsWith("_test.js") || file.includes("_perf_") || file.includes("_corpus_") || file === "gl_protocol_test.js") continue;
            const prefix = path.join(temp, file), result = spawnSync(process.execPath, ["--require", __filename, path.join(root, "tests/glbridge", file)],
                { encoding: "utf8", timeout: 180000, env: { ...process.env, GL_BEHAVIOR_CAPTURE: prefix } });
            if(result.error || result.status !== 0) throw new Error(file + ": " + (result.error || result.stderr || result.stdout));
            for(const output of fs.readdirSync(temp).filter(name => name.startsWith(file + "."))) for(const name of JSON.parse(fs.readFileSync(path.join(temp, output)))) {
                if(!covered[name]) covered[name] = [];if(!covered[name].includes(file)) covered[name].push(file);
            }
            suites.push(file);console.log("PASS " + file);
        }
        const missing = Object.keys(protocol.GLFN).filter(name => !covered[name]?.length);
        fs.writeFileSync(path.join(root, "tests/glbridge/gl_behavior_coverage.json"), JSON.stringify({ method: "Runtime decodeRecord or accepted GPU dispatch in passing behavioral Node suites; excludes protocol round-trip", suites, records: covered, missing }, null, 2) + "\n");
        if(missing.length) throw new Error("Behavior coverage missing: " + missing.join(", "));
        console.log("PASS " + Object.keys(protocol.GLFN).length + " records decoded by " + suites.length + " behavioral suites");
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
