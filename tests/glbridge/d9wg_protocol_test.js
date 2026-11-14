#!/usr/bin/env node
// d9wg_protocol.js, the one description of D9WG (docs/d3d-webgpu-review.md
// stage 2): the header generated from it compiles with every layout assert
// holding, payloads round-trip, a 1.3 payload decodes the fields 1.4 added as
// 0, and the executor's handler table is the protocol's command list.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const { D3D9WebGPUExecutor } = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js");
require("../../src/browser/glbridge/d3d9-webgpu/ddraw_ops.js");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function header() {
    const result = spawnSync(process.execPath, [join(__dirname, "../../tools/gen_d9wg_header.mjs")],
        { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

// The guest DLLs are 32-bit mingw builds; freestanding needs no libc headers
function compile(source) {
    const attempts = [
        ["clang", ["--target=i686-pc-windows-gnu", "-ffreestanding", "-fsyntax-only", "-x", "c", "-"]],
        ["i686-w64-mingw32-gcc", ["-fsyntax-only", "-x", "c", "-"]],
        ["gcc", ["-m32", "-ffreestanding", "-fsyntax-only", "-x", "c", "-"]],
    ];
    for (const [compiler, args] of attempts) {
        const result = spawnSync(compiler, args, { input: source, encoding: "utf8" });
        if (result.error && result.error.code === "ENOENT") continue;
        return { compiler, ok: result.status === 0, stderr: result.stderr };
    }
    throw new Error("no C compiler (clang, i686-w64-mingw32-gcc or gcc) to check the generated header with");
}

test("native MRT blend masks share a generated state ID without changing SetRenderState layout", async () => {
    const {NV_RS}=await import("../../src/graphics_adapters/vmware_svga/d9wg_constants.js");
    assert.equal(P.C.D9WG_NV_RS_COLOR_BLEND_MASK,0x1000);assert.equal(NV_RS.COLOR_BLEND_MASK,P.C.D9WG_NV_RS_COLOR_BLEND_MASK);
    assert(P.VERSION_MINOR>=12);assert.equal(P.STRUCTS.SetRenderState.size,16);
    const payload=P.encode("SetRenderState",{device_handle:1,state:NV_RS.COLOR_BLEND_MASK,value:10});
    assert.equal(new DataView(payload.buffer).getUint32(P.F.SetRenderState.value,true),10);
});

test("the generated header compiles, and its asserts do fail on a wrong layout", () => {
    const text = header();
    const good = compile(text + "\nint d9wg_header_check;\n");
    assert.ok(good.ok, good.compiler + ": " + good.stderr);
    // one offset off by one must stop the build
    const struct = Object.keys(P.STRUCTS).find(name => Object.keys(P.STRUCTS[name].fields).length > 1);
    const field = Object.keys(P.STRUCTS[struct].fields)[1];
    const line = "offsetof(D9WG" + struct + ", " + field + ") == " + P.F[struct][field] + " ?";
    assert.ok(text.includes(line), line);
    const bad = compile(text.replace(line, "offsetof(D9WG" + struct + ", " + field + ") == " +
        (P.F[struct][field] + 1) + " ?") + "\nint d9wg_header_check;\n");
    assert.ok(!bad.ok, bad.compiler + " accepted a wrong offset assert");
});

test("every opcode is in the header's enum and every command's struct exists", () => {
    const text = header();
    for (const [name, value] of Object.entries(P.OP)) {
        assert.match(text, new RegExp("D9WG_OP_" + name + " = (0x0*" + value.toString(16) + "|" + value + ")\\b", "i"),
            name);
        assert.equal(P.OP_NAME[value], name);
    }
    for (const name of Object.keys(P.COMMANDS)) {
        assert.ok(P.OP[name] !== undefined, name + " has no opcode");
        assert.ok(P.STRUCTS[P.commandStruct(P.OP[name])], name + "'s struct is not described");
    }
});

test("the SVGA encoder's d9wg_constants.js is what the generator writes now", () => {
    const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
    const dir = mkdtempSync(join(require("node:os").tmpdir(), "d9wg-"));
    try {
        const out = join(dir, "d9wg_constants.js");
        const result = spawnSync(process.execPath, [join(__dirname, "../../tools/gen_d9wg_header.mjs"), "--svga", out],
            { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(join(__dirname, "../../src/graphics_adapters/vmware_svga/d9wg_constants.js"), "utf8"),
            readFileSync(out, "utf8"),
            "regenerate it: node tools/gen_d9wg_header.mjs --svga src/graphics_adapters/vmware_svga/d9wg_constants.js");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("encode and decode round-trip every scalar field of every struct", () => {
    let seed = 1;
    const next = () => (seed = (seed * 1103515245 + 12345) >>> 0);
    const sample = type => ({
        uint8_t: () => next() & 0xff, uint16_t: () => next() & 0xffff, uint32_t: () => next(),
        int32_t: () => next() | 0, float: () => Math.fround((next() & 0xffff) / 64 - 512),
    })[type];
    let structs = 0;
    for (const [name, struct] of Object.entries(P.STRUCTS)) {
        const values = {};
        for (const [field, layout] of Object.entries(struct.fields)) {
            const make = sample(layout.type);
            if (!make) continue;
            values[field] = layout.count === 1 ? make() : Array.from({ length: layout.count }, make);
        }
        const bytes = P.encode(name, values);
        assert.equal(bytes.length, struct.size, name);
        const decoded = P.decode(name, new DataView(bytes.buffer), 0);
        for (const field of Object.keys(values)) assert.deepEqual(decoded[field], values[field], name + "." + field);
        ++structs;
    }
    assert.ok(structs >= 60, "only " + structs + " structs");
});

test("a protocol 1.3 payload decodes the fields 1.4 added as 0", () => {
    assert.equal(P.MIN_MINOR, 3);
    for (const [struct, added] of Object.entries(P.ADDED_FIELDS)) {
        const size = P.STRUCTS[struct].size, short = P.minBytes(struct);
        assert.ok(short < size, struct);
        // the added fields are the struct's tail, in order
        const tail = Object.keys(P.STRUCTS[struct].fields).slice(-added.length);
        assert.deepEqual(tail, added, struct);
        const values = Object.fromEntries(Object.keys(P.STRUCTS[struct].fields)
            .filter(field => P.STRUCTS[struct].fields[field].type === "uint32_t").map(field => [field, 7]));
        const bytes = P.encode(struct, values);
        const decoded = P.decode(struct, new DataView(bytes.buffer), 0, short);
        for (const field of added) {
            assert.equal(P.has(short, struct, field), false, struct + "." + field);
            assert.equal(P.has(size, struct, field), true, struct + "." + field);
            if (field in values) assert.equal(decoded[field], 0, struct + "." + field);
        }
    }
    // everything else is as long as its struct
    for (const name of Object.keys(P.COMMANDS)) {
        const struct = P.commandStruct(P.OP[name]);
        if (!P.ADDED_FIELDS[struct]) assert.equal(P.minBytes(struct), P.STRUCTS[struct].size, name);
    }
});

test("the executor handles exactly the protocol's commands", () => {
    const handlers = Object.getOwnPropertyDescriptor(D3D9WebGPUExecutor.prototype, "handlers").get
        .call(Object.create(D3D9WebGPUExecutor.prototype));
    const handled = Object.keys(handlers).map(Number).sort((a, b) => a - b);
    const described = Object.keys(P.COMMANDS).map(name => P.OP[name]).sort((a, b) => a - b);
    const name = op => P.OP_NAME[op] || "0x" + op.toString(16);
    assert.deepEqual(handled.map(name), described.map(name));
});

test("the shared packet encoder preserves minor headers, named blobs and caller inputs", () => {
    for (let minor = P.MIN_MINOR; minor <= P.VERSION_MINOR; minor++) {
        const payload = P.encode("SetRenderTarget", { device_handle: 7, color_texture_handle: 9 });
        const short = minor === 3 ? payload.subarray(0, P.minBytes("SetRenderTarget")) : payload;
        const batch = P.encodeBatch([{ opcode: P.OP.SET_RENDER_TARGET, payload: short }], { version_minor: minor, session_id_low: 8 });
        const header = P.decode("BatchHeader", new DataView(batch.buffer), 0);
        assert.equal(header.version_minor, minor);assert.equal(header.session_id_low, 8);
        assert.equal(header.command_bytes + P.STRUCTS.BatchHeader.size, batch.length);
    }
    const payload = P.encode("DrawIndexedPrimitiveUP", { index_bytes: 3, vertex_bytes: 4 });
    const original = payload.slice(), indices = new Uint8Array([1, 2, 3]), vertices = new Uint8Array([4, 5, 6, 7]);
    const batch = P.encodeBatch([{ opcode: P.OP.DRAW_INDEXED_PRIMITIVE_UP, payload, blobs: [
        { field: "index_data_offset", data: indices }, { field: "vertex_data_offset", data: vertices },
    ] }]);
    const decoded = P.decode("DrawIndexedPrimitiveUP", new DataView(batch.buffer), P.STRUCTS.BatchHeader.size + P.STRUCTS.CommandHeader.size);
    assert.deepEqual(batch.subarray(decoded.index_data_offset, decoded.index_data_offset + 3), indices);
    assert.deepEqual(batch.subarray(decoded.vertex_data_offset, decoded.vertex_data_offset + 4), vertices);
    assert.deepEqual(payload, original, "shared encoder does not mutate reused payloads");
    assert.throws(() => P.encode("SetTexture", { texture_hanlde: 2 }), /unknown field/);
    assert.throws(() => P.encode("SetMaterial", { diffuse: [1, 2] }), /array size/);
    assert.throws(() => P.encodeBatch([{ opcode: P.OP.UPDATE_BUFFER, payload: {}, blobs: [{ field: "wrong", data: indices }] }]), /invalid blob/);
});

test("1.9 fractional blit rectangles preserve the 80-byte layout and 1.8 framing", () => {
    const wire = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
    assert(P.VERSION_MINOR >= 9);
    assert.equal(P.C.D9WG_DDBLT_SOURCE_RECT_F32, 128);
    assert.equal(P.STRUCTS.DDBlt.size, 80);
    assert.equal(P.F.DDBlt.source_rect, 16);
    assert.equal(P.F.DDBlt.flags, 44);
    const values = new Float32Array([1, 4 / 3, 5, 2]);
    const payload = P.encode("DDBlt", { device_handle: 3, source_handle: 4,
        flags: P.C.D9WG_DDBLT_SOURCE_RECT_F32,
        source_rect: [...new Int32Array(values.buffer)], destination_rect: [64, 32, 128, 96] });
    const data = new DataView(payload.buffer);
    for (let i = 0; i < 4; ++i)
        assert.equal(data.getFloat32(P.F.DDBlt.source_rect + i * 4, true), values[i]);
    for (const minor of [8, 9]) {
        const old = P.encode("DDBlt", { source_rect: [1, 1, 5, 2] });
        const batch = P.encodeBatch([{ opcode: P.OP.DD_BLT, payload: minor === 8 ? old : payload }],
            { version_minor: minor });
        const header = wire.readHeader(batch);
        wire.checkStream(header.view, header.end, header.commandCount);
        assert.equal(header.view.getUint16(P.F.BatchHeader.version_minor, true), minor);
        if (minor === 8) assert.deepEqual(P.decode("DDBlt", new DataView(old.buffer), 0).source_rect, [1, 1, 5, 2]);
    }
});

(async () => {
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log("ok   " + name);
        } catch (error) {
            console.error("FAIL " + name + "\n" + (error && error.stack || error));
            process.exitCode = 1;
            return;
        }
    }
    console.log(tests.length + " d9wg protocol tests passed");
})();
