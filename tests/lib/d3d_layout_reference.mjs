import assert from "node:assert/strict";
export function parse_layout_rows(text)
{
    const rows = [];
    for(const line of text.split(/\r?\n/))
    {
        if(line.startsWith("CASE "))
        {
            const m = /^CASE id=(\d+) source=(\d+) fvf=([0-9a-f]{8}) stride=(\d+) mode=(\d+) edge=(\d+) hr=([0-9a-f]{8})$/.exec(line);
            assert(m, "malformed layout case");assert.equal(+m[1], rows.length, "sequential unique layout IDs");
            rows.push({ id: +m[1], source: +m[2], fvf: parseInt(m[3], 16), stride: +m[4], mode: +m[5], edge: +m[6], hr: parseInt(m[7], 16), words: [] });
        }
        else if(line.startsWith("WORD "))
        {
            const m = /^WORD id=(\d+) offset=(\d+) value=([0-9a-f]{8})$/.exec(line);
            assert(m, "malformed layout word");const row = rows.at(-1);assert(row);
            assert.equal(+m[1], row.id);assert.equal(+m[2], row.words.length*4, "sequential unique output words");
            row.words.push(parseInt(m[3], 16));
        }
    }
    assert.equal(rows.length, 168);
    for(const row of rows) assert.equal(row.words.length*4, row.stride*7, "complete public buffer");
    return rows;
}
export function compare_layout_rows(actual, reference)
{
    assert.equal(actual.length, reference.length);
    let compared = 0;
    for(let i = 0; i < reference.length; ++i)
    {
        const expected = reference[i], got = actual[i];
        for(const key of ["id", "source", "fvf", "stride", "mode", "edge"]) assert.equal(got[key], expected[key]);
        // Microsoft RGB rejects several source/destination FVF combinations.
        // The proxy supports more combinations; compare only native successes.
        if(expected.hr === 0) { assert.deepEqual(got, expected, "native public output case " + i);compared++; }
    }
    assert.equal(compared, 84);
    return compared;
}
