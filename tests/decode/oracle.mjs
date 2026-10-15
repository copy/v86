import assert from "node:assert/strict";
import fs from "node:fs";
import {spawnSync} from "node:child_process";
for(const size of [16, 32]) {
    const result = spawnSync("ndisasm", ["-b", String(size), `build/ir-decode/oracle-${size}.bin`], {encoding: "utf8", maxBuffer: 8 * 1024 * 1024});
    if(result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const offsets = result.stdout.split("\n").filter(line => /^[0-9A-F]+\s+[0-9A-F]/.test(line)).map(line => parseInt(line.split(/\s/)[0], 16));
    assert.deepEqual(offsets, JSON.parse(fs.readFileSync(`build/ir-decode/oracle-${size}.json`)));
}
console.log("PASS: 16,384 instruction boundaries agree with independent NDISASM (16/32-bit, prefixes and addressing)");
