"use strict";
const assert = require("node:assert/strict");
const reference = require("../../docs/fixtures/d3d-review/d3d7-native-layout-reference.json");
(async () => {
    const { parse_layout_rows, compare_layout_rows } = await import("../lib/d3d_layout_reference.mjs");
    assert.equal(reference.provenance.batches, 0);assert.deepEqual(reference.provenance.owners, []);
    for (const key of ["sourceSha256", "exeSha256"]) assert.match(reference.provenance[key], /^[0-9a-f]{64}$/);
    assert.deepEqual(reference.rows[0].words.slice(3, 12), [0x424b0000,0x42240000,0x3e900000,0x42640000,0x42380000,0x3ea00000,0x427d0000,0x424c0000,0x3eb00000]);
    assert.equal(reference.rows[0].words[12], 0x3f000000, "native final RHW spills into the next XYZ vertex");
    const hex = n => n.toString(16).padStart(8, "0");
    const log = reference.rows.flatMap(r => ["CASE id=" + r.id + " source=" + r.source + " fvf=" + hex(r.fvf) + " stride=" + r.stride + " mode=" + r.mode + " edge=" + r.edge + " hr=" + hex(r.hr),
        ...r.words.map((n,i) => "WORD id=" + r.id + " offset=" + i*4 + " value=" + hex(n))]).join("\n");
    const parsed = parse_layout_rows(log);assert.deepEqual(parsed, reference.rows);assert.equal(compare_layout_rows(parsed, reference.rows), 84);
    assert.throws(() => parse_layout_rows(log.slice(0, log.lastIndexOf("\n"))));
    assert.throws(() => parse_layout_rows(log.replace("CASE id=1 ", "CASE id=0 ")));
    assert.throws(() => parse_layout_rows(log.replace("offset=4 ", "offset=0 ")));
    assert.throws(() => parse_layout_rows(log.replace("value=a5000000", "value=invalid")));
    const changed = JSON.parse(JSON.stringify(parsed));changed[0].words[12] = 0;
    assert.throws(() => compare_layout_rows(changed, reference.rows));
    changed[0] = {...parsed[0], hr: 0x80070057};assert.throws(() => compare_layout_rows(changed, reference.rows));
    console.log("PASS original Microsoft RGB output fixture: 168 complete buffers / 84 native successes; malformed/truncated/duplicate logs and mismatches rejected");
})().catch(error => {console.error(error);process.exitCode = 1;});
