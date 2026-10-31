"use strict";
const assert = require("node:assert/strict");
(async () => {
    const { compare_pixels: compare } = await import("../../tools/lib/gl_game_trace_pixels.mjs"), a = new Uint8Array([1, 2, 3, 255, 10, 20, 30, 255]), b = new Uint8Array([1, 2, 3, 255, 11, 21, 31, 250]);
    const accepted = compare([a, b], [b, a], 2, 1);assert.equal(accepted.passed, true);assert.deepEqual(accepted.unstableReferencePixels, [{ x: 1, y: 0, rgba: [[10, 20, 30, 255], [11, 21, 31, 250]] }]);
    const stable = a.slice();stable[0] = 2;assert.equal(compare([a, b], [stable], 2, 1).stableMismatches, 1);
    const unseen = b.slice();unseen[4] = 12;const rejected = compare([a, b], [unseen], 2, 1);assert.equal(rejected.passed, false);assert.equal(rejected.outsideObservedValues, 1);
    const combined = b.slice();combined[4] = 10;assert.equal(compare([a, b], [combined], 2, 1).passed, false, "component ranges cannot create an unobserved RGBA combination");
    assert.equal(compare([a], [b], 2, 1).passed, false);assert.throws(() => compare([a], [b.subarray(0, 4)], 2, 1));
    console.log("Game pixel comparisons preserve stable pixels and reject unobserved values and RGBA combinations (passed)");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
