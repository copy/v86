"use strict";
const assert = require("node:assert/strict");
const fixture = require("./fixtures/d3d_vertex_formats_cpu.json");
assert.match(fixture.sourceSha256,/^[a-f0-9]{64}$/);
const sizes=[4,8,12,16,4,4,4,8,4,4,8,4,8,4,4,4,8];
assert.equal(fixture.cases.length,1088);
for (let type=0;type<17;++type) {
    const rows=fixture.cases.filter(r => r.type===type);assert.equal(rows.length,64);
    for (const row of rows) {
        assert.equal(row.bytes.length,sizes[type]);assert(row.bytes.every(n => Number.isInteger(n)&&n>=0&&n<256));
        assert.equal(row.expected.length,4);assert(row.expected.every(n => Number.isInteger(n)&&n>=0&&n<=0xffffffff));
    }
}
assert.deepEqual(fixture.cases[0].expected,[0x80000000,0,0,0x3f800000]);
assert.deepEqual(fixture.cases[9*64+2].expected,[0xbf800000,0xbf800000,0,0x3f800000]);
assert.deepEqual(fixture.cases[14*64+4].expected,[0xbf800000,0xbf800000,0xbf800000,0x3f800000]);
assert.deepEqual(fixture.cases[15*64+2].expected,[0x80000000,0x80000000,0,0x3f800000]);
assert.deepEqual(fixture.cases[4*64+1].expected,[0x3f800000,0x3f800000,0x3f800000,0x3f800000]);
console.log("PASS typed vertex fixture: 17 formats / 1088 independent vectors, expansion, signed-normalized extrema, ARGB and signed half zero");
