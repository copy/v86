"use strict";
const assert = require("node:assert/strict");
const fixture = require("./fixtures/d3d_software_vertex_colors_cpu.json");
const sizes = [4,8,12,16,4,4,4,8,4,4,8,4,8,4,4,4,8];
assert.equal(fixture.cases.length,84);assert.equal(new Set(fixture.cases.map(r => r.name)).size,84);
assert(Object.keys(fixture.sourceSha256).length>=7);
for (const hash of Object.values(fixture.sourceSha256)) assert.match(hash,/^[a-f0-9]{64}$/);
for (const row of fixture.cases) {
    assert.equal(row.bytes.length,sizes[row.type]);assert(row.bytes.every(n => Number.isInteger(n)&&n>=0&&n<256));
    assert.equal(row.decoded.length,4);assert.equal(row.processedColors.length,2);
    assert(row.processedColors.every(n => Number.isInteger(n)&&n>=0&&n<=0xffffffff));
    const values = new Float32Array(new Uint32Array(row.decoded).buffer);
    assert([...values].every(Number.isFinite));
    if (row.mode===3) assert([...values].every(n => n>=0&&n<=1),"fog comparison uses the legal color range");
}
for (let mode=0;mode<4;++mode) {
    const rows = fixture.cases.filter(r => r.mode===mode);assert.equal(rows.length,21);assert.equal(new Set(rows.map(r => r.type)).size,17);
}
const stress = fixture.cases.find(r => r.name==="type-3-sample-1091-row-1091-mode-1");
assert.deepEqual(stress.processedColors,[0x801c69b0,0x80000000],"float material colors retain precision until after lighting");
console.log("PASS typed color differential fixture: 84 cases, all 17 formats, bounded fog inputs and a precise material-color stress case");
