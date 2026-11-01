"use strict";
const assert = require("node:assert/strict");
const { GraphicsJournal } = require("../../src/browser/glbridge/graphics_journal.js");
const timeout = setTimeout(() => { throw new Error("journal test timed out"); }, 60000);
(async () => {
    const data = new Map();
    let writes = 0, reads = 0;
    const store = {
        async put(bytes) { const key = writes++; data.set(key, bytes.slice()); return key; },
        async get(key) { reads++; return data.get(key).slice(); },
        async destroy() { data.clear(); },
    };
    const journal = new GraphicsJournal({ budget: 16 * 1024, store });
    const payload = new Uint8Array(8 * 1024 * 1024);
    // Cross the old 512 MiB total-history boundary using distinct immutable
    // records, without requiring a half-gigabyte resident test fixture.
    for (let i = 0; i < 66; ++i) {
        payload[0] = i;
        journal.append({ bytes: payload, frameId: i, flags: i % 2, commandCount: 1 });
        payload[0] = 255;
        await journal.work;
    }
    assert.ok(journal.rawBytes > 512 * 1024 * 1024);
    assert.ok(writes > 0, "compressed pages spill after the RAM cache budget");
    assert.ok(journal.residentBytes <= journal.budget);
    const saved = await journal.snapshot();
    assert.ok(saved.length < 2 * 1024 * 1024, "repetitive command history is compressed");
    const parsed = GraphicsJournal.parse(saved);
    let count = 0;
    for await (const record of GraphicsJournal.records(parsed)) {
        assert.equal(record.frameId, count);
        assert.equal(record.flags, count % 2);
        assert.equal(record.bytes[0], count, "history owns bytes before guest reuses the arena");
        assert.equal(record.bytes.length, payload.length);
        assert.equal(record.bytes[record.bytes.length - 1], 0);
        count++;
    }
    assert.equal(count, 66, "every record after 512 MiB is retained and portable");
    assert.ok(reads > 0);
    const again = await journal.snapshot();
    assert.deepEqual(again, saved, "saving twice does not consume spooled pages");
    await journal.destroy();
    assert.equal(data.size, 0, "destroy deletes this session's cache pages");

    // Short/unaligned records and oversized batches must survive page rollover
    // without aliasing the guest's subsequently reused command arena.
    const packed = new GraphicsJournal({ pageBytes: 1024, store: null });
    const sizes = [0, 1, 127, 997, 4096];
    for (let i = 0; i < 100; ++i) {
        const bytes = new Uint8Array(sizes[i % sizes.length]).fill(i);
        packed.append({ frameId: i, flags: i % 2, responseBase: 8192 + i }, bytes);
        bytes.fill(255);
    }
    let packedCount = 0;
    for await (const record of GraphicsJournal.records(GraphicsJournal.parse(await packed.snapshot()))) {
        assert.equal(record.frameId, packedCount);
        assert.equal(record.flags, packedCount % 2);
        assert.equal(record.responseBase, 8192 + packedCount);
        assert.deepEqual(record.bytes, new Uint8Array(sizes[packedCount % sizes.length]).fill(packedCount));
        packedCount++;
    }
    assert.equal(packedCount, 100);
    await packed.destroy();

    const warning = console.warn;
    console.warn = () => {};
    try {
        const fallback = new GraphicsJournal({ budget: 1, pageBytes: 1024,
            store: { async put() { throw new Error("quota exhausted"); }, async destroy() {} } });
        fallback.append({ bytes: payload.subarray(0, 4096), frameId: 7 });
        await fallback.work;
        assert.ok(fallback.cacheError);
        const compressed = await fallback.snapshot();
        const restored = [];
        for await (const record of GraphicsJournal.records(GraphicsJournal.parse(compressed))) restored.push(record);
        assert.equal(restored[0].frameId, 7, "cache failure preserves history in RAM");
        await fallback.destroy();
    } finally { console.warn = warning; }

    const owners = new GraphicsJournal({ pageBytes: 1024, store: null, worker: false });
    owners.append({ bytes: new Uint8Array([7]), ownerToken: 0xffffffff });
    owners.append({ bytes: new Uint8Array([8]), ownerToken: 11 });
    const ownerSaved = await owners.snapshot();
    assert.equal(new DataView(ownerSaved.buffer).getUint16(4, true), 4);
    const ownerRecords = [];
    for await (const record of GraphicsJournal.records(GraphicsJournal.parse(ownerSaved))) ownerRecords.push(record);
    assert.deepEqual(ownerRecords.map(record => record.ownerToken), [0xffffffff, 11]);
    assert.throws(() => owners.append({ ownerToken: -1 }, new Uint8Array()), /owner/);
    assert.throws(() => owners.append({ ownerToken: 1.5 }, new Uint8Array()), /owner/);
    assert.throws(() => owners.append({ ownerToken: 1, barrier: true }, new Uint8Array()), /owner/);
    const legacyJournal = new GraphicsJournal({ pageBytes: 1024, store: null, worker: false });
    legacyJournal.append({ bytes: new Uint8Array([9]), frameId: 17 });
    const legacySaved = await legacyJournal.snapshot();
    new DataView(legacySaved.buffer).setUint16(4, 3, true);
    let legacyCount = 0;
    for await (const record of GraphicsJournal.records(GraphicsJournal.parse(legacySaved))) {
        assert.equal(record.ownerToken, undefined);assert.equal(record.frameId, 17);legacyCount++;
    }
    assert.equal(legacyCount, 1, "version-3 journals remain readable");
    const invalidVersion = ownerSaved.slice();new DataView(invalidVersion.buffer).setUint16(4, 3, true);
    await assert.rejects(async () => {
        for await (const record of GraphicsJournal.records(GraphicsJournal.parse(invalidVersion))) void record;
    }, /Invalid graphics batch/);
    await owners.destroy();await legacyJournal.destroy();

    const truncated = saved.subarray(0, saved.length - 1);
    assert.throws(() => GraphicsJournal.parse(truncated), /Invalid/);
    const corrupt = saved.slice();
    new DataView(corrupt.buffer).setUint32(36, 64 * 1024 * 1024, true);
    assert.throws(() => GraphicsJournal.parse(corrupt), /Invalid/);
    console.log("graphics_journal_test: 528 MiB round trip, compression, spill, quota fallback and cleanup passed");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
