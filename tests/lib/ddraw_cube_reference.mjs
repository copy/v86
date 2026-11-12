import assert from "node:assert/strict";

export function assert_native_cube_attachment_text(text) {
    const lines = text.replace(/\r/g, "").trim().split("\n");
    const rows = name => lines.filter(line => line.startsWith(name + " ")).map(line =>
        Object.fromEntries(line.split(" ").slice(1).map(field => field.split("="))));
    const ok = "00000000", missing = "887600FF";
    const hex = value => value.toString(16).toUpperCase().padStart(8, "0");
    assert.equal(rows("CREATE").length, 4);
    for (const row of rows("CREATE")) assert.equal(row.hr, +row.api === 4 ? "80070057" : ok);
    assert.equal(rows("ROOT").length, 2);
    for (const row of rows("ROOT")) {
        assert.equal(row.api, "7");
        assert.equal(row.width, "16");
        assert.equal(row.caps, +row.levels === 1 ? "00001808" : "00401808");
        assert.equal(row.caps2, "00000600");
    }
    assert.equal(rows("FACE").length, 12);
    for (const row of rows("FACE")) assert.equal(row.hr, ok);
    const queries = rows("QUERY");
    assert.equal(queries.length, 216);
    assert.equal(new Set(queries.map(row => [row.levels,row.source,row.wanted,row.role].join(":"))).size, 216);
    for (const row of queries) {
        const mip = row.source === row.wanted && +row.levels > 1;
        const otherFace = +row.source === 0 && +row.wanted !== 0;
        const success = mip || otherFace;
        assert.equal(row.hr, success ? ok : missing, JSON.stringify(row));
        assert.equal(+row.width, mip ? 8 : otherFace ? 16 : 0);
        assert.equal(row.self, "0");
        assert.equal(row.caps2, success ? hex(0x200 | (0x400 << +row.wanted) | (mip ? 0x10000 : 0)) : "00000000");
        if (!success) assert.equal(row.pointer, "00000000");
    }
    assert.equal(rows("WALK").length, 24);
    for (const row of rows("WALK")) {
        const success = +row.step < +row.levels - 1;
        assert.equal(row.hr, success ? ok : missing);
        assert.equal(+row.width, success ? 8 >> +row.step : 0);
        assert.equal(row.self, "0");
        if (!success) assert.equal(row.pointer, "00000000");
    }
    assert(lines.includes("PASS native cube attachment reference complete"));
    return {creations: 4, rootDescriptors: 2, faces: 12, queries: 216, mipSteps: 24};
}
