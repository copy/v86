import assert from "node:assert/strict";

export function assert_native_mip_resource_text(text) {
    const lines = text.replace(/\r/g, "").trim().split("\n");
    const rows = name => lines.filter(line => line.startsWith(name + " ")).map(line =>
        Object.fromEntries(line.split(" ").slice(1).map(field => field.split("="))));
    const ok = "00000000", invalid = "80070057", noPalette = "8876023C";
    const sublevel = row => +row.kind === 2 && +row.level > 0;
    const paletteResult = row => sublevel(row) ? "8876025B"
        : +row.palette === 1 && +row.resource === 0 ? "88760250"
        : +row.format === 1 ? +row.palette === 2 ? noPalette : "88760091" : ok;
    assert.equal(rows("CREATE").length, 24);
    for (const row of rows("CREATE")) assert.equal(row.hr, ok);
    assert.equal(rows("GET").length, 36);
    for (const row of rows("GET")) {
        assert.equal(row.hr, noPalette);
        assert.equal(row.pointer, "00000000");
    }
    assert.equal(rows("SET").length, 108);
    for (const row of rows("SET")) {
        assert.equal(row.hr, paletteResult(row), JSON.stringify(row));
        assert.equal(+row.refs, row.hr === ok && +row.palette < 2 ? 2 : 1);
    }
    assert.equal(rows("AFTER").length, 108);
    for (const row of rows("AFTER")) {
        const present = !sublevel(row) && +row.format === 0 && +row.palette < 2;
        const matches = present ? +row.palette === 0 || +row.resource !== 0 : +row.palette === 2;
        assert.equal(row.hr, present ? ok : noPalette);
        assert.equal(+row.nonnull, +present);
        assert.equal(+row.match, +matches);
    }
    for (const name of ["KEYSET", "KEYCLEAR", "KEYGET"]) {
        assert.equal(rows(name).length, 36);
        for (const row of rows(name)) {
            assert.equal(row.hr, sublevel(row) ? name === "KEYGET" ? "887600D7" : "8876025B" : ok);
            if (name === "KEYGET") {
                assert.equal(row.low, sublevel(row) ? "DEADBEEF" : "00000022");
                assert.equal(row.high, row.low);
            }
        }
    }
    assert.equal(rows("PRIORITY").length, 24);
    for (const row of rows("PRIORITY")) {
        const expected = +row.resource === 0 ? "88760082"
            : +row.resource === 1 || +row.level > 0 ? invalid : ok;
        assert.equal(row.hr, expected);
        assert.equal(row.value, expected !== ok ? "DEADBEEF"
            : +row.stage === 0 ? "00000000" : +row.stage === 1 ? "00000001" : "FFFFFFFF");
    }
    assert.equal(rows("SETPRIORITY").length, 12);
    for (const row of rows("SETPRIORITY")) assert.equal(row.hr, +row.resource === 1 ? invalid : ok);
    assert(lines.includes("PASS native mip resource reference complete"));
    return {creation: 24, initialPalette: 36, paletteSetters: 108, paletteResults: 108,
        colorKeySetters: 72, colorKeyResults: 36, priorityResults: 24, prioritySetters: 12};
}

export function assert_native_mip_view_text(text) {
    const lines = text.replace(/\r/g, "").trim().split("\n");
    const rows = name => lines.filter(line => line.startsWith(name + " ")).map(line =>
        Object.fromEntries(line.split(" ").slice(1).map(field => field.split("="))));
    assert.equal(rows("CREATE").length, 3);
    for (const row of rows("CREATE")) assert.equal(row.hr, "00000000");
    assert.equal(rows("QI").length, 30);
    for (const row of rows("QI")) assert.equal(row.hr, "00000000");
    const views = rows("VIEW");
    assert.equal(views.length, 30);
    assert.equal(new Set(views.map(row => row.kind + ":" + row.level + ":" + row.view)).size, 30);
    for (const row of views) {
        const denied = +row.level > 0 && +row.view === 7;
        assert.equal(row.empty, denied ? "8876025B" : "8876023C");
        for (const field of ["set", "clear", "keyset", "keyclear"])
            assert.equal(row[field], denied ? "8876025B" : "00000000");
    }
    assert(lines.includes("PASS native mip view reference complete"));
    return {creation: 3, queries: 30, interfaceMetadataObservations: 150};
}
