"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), { createHash } = require("node:crypto"), { gunzipSync } = require("node:zlib");
const dir = path.join(__dirname, "gl_conformance"), mesa = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, "mesa_reference.json.gz")))),
    apple = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, "references.json.gz")))), { scenes } = require("./gl_conformance/scenes.js"),
    policy = require("./gl_conformance/oracle_policy.js"), compare = require("./gl_conformance/compare.js");
assert.equal(mesa.version, 1); assert.match(mesa.environment.renderer, /llvmpipe/); assert.match(mesa.environment.version, /^2\.1 Mesa /);
for (const [file, hash] of Object.entries(mesa.sourceHashes)) {
    const location = file === "scenes.js" ? path.join(dir, file) : file.startsWith("gl_shader_") ? path.join(__dirname, file) : path.join(dir, "reference", file);
    assert.equal(createHash("sha256").update(fs.readFileSync(location)).digest("hex"), hash, "stale Mesa source: " + file);
}
const files = fs.readdirSync(path.join(dir, "reference")).filter(f => f.endsWith(".c") && !["ref.c", "shader_units.c", "shader_mixed.c"].includes(f));
assert.equal(Object.keys(mesa.fixtures).length, files.length + require("./gl_shader_units_cases.js").length + require("./gl_shader_mixed_cases.js").length);
for (const file of files) assert.ok(mesa.fixtures[file.slice(0, -2)], file);
assert.equal(mesa.pixels.scenes.length, scenes.length);
const decode = set => Object.fromEntries(set.scenes.map(scene => [scene.name, { ...scene, rgba: Uint8Array.from(Buffer.from(scene.rgba, "base64")),
    extra: scene.extra.map(e => ({ ...e, bytes: Uint8Array.from(Buffer.from(e.bytes, "base64")) })) }]));
const primary = decode(mesa.pixels), other = decode(apple.hw);
for (const scene of scenes) {
    assert.ok(primary[scene.name]);
    assert.equal(primary[scene.name].fbo, 0x8CD5, scene.name + " native FBO");
    assert.equal(primary[scene.name].error, scene.name === "accum" ? 0x502 : 0, scene.name + " native GL error");
    const alternate = policy.alternative(scene, primary[scene.name], other[scene.name]);
    if (!policy.entries[scene.name]) assert.equal(alternate, primary[scene.name]);
    else {
        const before = primary[scene.name].rgba.slice();
        assert.equal(alternate.rgba[0], before[0]);
        assert.notEqual(alternate.rgba, primary[scene.name].rgba);
        assert.deepEqual(primary[scene.name].rgba, before, "policy cannot mutate its native reference");
    }
}
// The alternative is limited to named tiles. A broken pixel elsewhere must
// still fail even if the other native driver happens to supply a reference.
const scene = scenes.find(s => s.name === "primitives"), native = primary.primitives, alternative = policy.alternative(scene, native, other.primitives), broken = { ...native, rgba: native.rgba.slice() };
const isolated = policy.alternative(scene, { rgba: new Uint8Array(64 * 64 * 4).fill(17) }, { rgba: new Uint8Array(64 * 64 * 4).fill(241) });
assert.equal(isolated.rgba[0], 17, "unapproved pixels cannot use the other driver");
const approved = scene.tiles.find(t => t.label === policy.entries.primitives[0]);
assert.equal(isolated.rgba[(approved.y * 64 + approved.x) * 4], 241);
broken.rgba[0] = native.rgba[0] >= 128 ? 0 : 255;
assert.equal(compare.compareScene(scene, native, alternative, broken).verdict, "FAIL");
assert.equal(mesa.fixtures.render_errors.cases.find(c => c.name === "multi_count").error, 0x501);
console.log("gl_mesa_reference_test: 59 native jobs, 60 pixel scenes, source fingerprints, valid ARB sources and restricted driver alternatives passed");
