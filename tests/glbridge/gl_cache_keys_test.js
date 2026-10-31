"use strict";
const assert = require("node:assert/strict");
const { CacheKeys } = require("../../src/browser/glbridge/gl-webgpu/gl_cache_keys.js");
// Force every bucket hash to collide. Equality still compares the complete
// integer vector, including structural boundaries and primitive types.
const keys = new CacheKeys(() => 0), moduleA = {}, moduleB = {};
keys.reference(moduleA);keys.reference(moduleB);
const first = keys.key({ vertex: { module: moduleA, constants: { a: 1 } }, formats: ["rgba8unorm", null], count: 4 });
assert.equal(typeof first, "number");
assert.equal(keys.key({ count: 4, formats: ["rgba8unorm", null], vertex: { constants: { a: 1 }, module: moduleA } }), first);
for (const value of [{ vertex: { module: moduleB, constants: { a: 1 } }, formats: ["rgba8unorm", null], count: 4 },
    { vertex: { module: moduleA, constants: { a: 2 } }, formats: ["rgba8unorm", null], count: 4 },
    { vertex: { module: moduleA, constants: { a: 1 } }, formats: ["rgba8unorm", null], count: 1 }]) assert.notEqual(keys.key(value), first);
const values = [null, false, 0, true, 1, "1", undefined, [], {}, [1, 2], [1, [2]], { a: 1, b: 2 }, { a: [1, 2] }, ["a|b", "c"], ["a", "b|c"]];
assert.equal(new Set(values.map(value => keys.key(value))).size, values.length);
assert.equal(keys.key({ a: 1, omitted: undefined }), keys.key({ a: 1 }));
assert.throws(() => keys.key(new DataView(new ArrayBuffer(4))), /Unregistered/);
assert.throws(() => keys.key(new Map([[1, 2]])), /Unregistered/);
const objectID = keys.reference(moduleA);keys.clearKeys();assert.equal(keys.reference(moduleA), objectID);
assert.equal(keys.key({ vertex: moduleA }), keys.key({ vertex: moduleA }));
console.log("gl_cache_keys_test: complete structured integer identity, stable object references and forced bucket collisions passed");
