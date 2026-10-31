#!/usr/bin/env node
// gl_protocol.js, the one description of the OpenGL records
// (docs/opengl-webgpu-plan.md C1): the guest header generated from it
// compiles with every layout assert holding, records round-trip, and the
// executor has a handler for every opcode.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const constants = require("../../src/browser/glbridge/gl-webgpu/gl_constants.js");
const executorModule = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function generate() {
    const dir = mkdtempSync(join(tmpdir(), "gl-protocol-"));
    try {
        const result = spawnSync(process.execPath, [join(__dirname, "../../tools/gen_gl_protocol_header.mjs"), dir],
            { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return { protocol: readFileSync(join(dir, "gl_protocol.h"), "utf8"),
            names: readFileSync(join(dir, "gl_opcode_names.h"), "utf8") };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// The guest DLL is a 32-bit mingw build; freestanding needs no libc headers
function compile(source) {
    const attempts = [
        ["clang", ["--target=i686-pc-windows-gnu", "-ffreestanding", "-fsyntax-only", "-Wall", "-x", "c", "-"]],
        ["i686-w64-mingw32-gcc", ["-fsyntax-only", "-Wall", "-x", "c", "-"]],
        ["gcc", ["-m32", "-ffreestanding", "-fsyntax-only", "-Wall", "-x", "c", "-"]],
    ];
    for (const [compiler, args] of attempts) {
        const result = spawnSync(compiler, args, { input: source, encoding: "utf8" });
        if (result.error && result.error.code === "ENOENT") continue;
        return { compiler, ok: result.status === 0, stderr: result.stderr };
    }
    throw new Error("no C compiler (clang, i686-w64-mingw32-gcc or gcc) to check the generated header with");
}

test("the generated headers compile, and a wrong offset assert fails the build", () => {
    const { protocol, names } = generate();
    const good = compile(protocol + names +
        "\nconst char *check(void) { return v86gl_opcode_name(GLFN_BLIT_FRAMEBUFFER); }\n");
    assert.ok(good.ok, good.compiler + ": " + good.stderr);
    const line = "offsetof(V86GLRecordQueryLocation, status) == " + P.F.QUERY_LOCATION.status + " ?";
    assert.ok(protocol.includes(line), line);
    const bad = compile(protocol.replace(line, "offsetof(V86GLRecordQueryLocation, status) == " +
        (P.F.QUERY_LOCATION.status + 4) + " ?"));
    assert.ok(!bad.ok, bad.compiler + " accepted a wrong offset assert");
});

test("the header has every opcode and the name table every name", () => {
    const { protocol, names } = generate();
    assert.equal(P.OPCODES.length, 253);
    for (const [name, value] of P.OPCODES) {
        assert.ok(protocol.includes("    GLFN_" + name + " = " + value), name);
        assert.ok(names.includes("[" + value + "] = \"" + name + "\""), name);
    }
    for (const [name] of P.DEFINES) assert.match(protocol, new RegExp("#define " + name + " "), name);
});

test("gl_constants.js takes the opcodes from the protocol", () => {
    assert.equal(constants.GLFN, P.GLFN);
    assert.equal(constants.CTRL, P.CTRL);
    for (const [name, value] of P.OPCODES) assert.equal(constants.NAME_BY_OPCODE[value], name);
});

test("every opcode has a signature or fixed header, including composite prefixes", () => {
    for (const [name] of P.OPCODES) assert.ok(P.SIGNATURES[name] || P.RECORDS[name], name + " has no wire layout");
    for (const suffix of ["", "_GL2"]) {
        for (const base of ["DRAW_ARRAYS", "DRAW_ELEMENTS"]) {
            const record = P.RECORDS[base + suffix], full = P.RECORDS["PACKED_" + base + suffix + "_MT"];
            for (const [field, layout] of Object.entries(record.fields)) assert.deepEqual(full.fields[field], layout);
        }
    }
    for (const name of ["COLOR", "TEX_COORD", "NORMAL", "SECONDARY_COLOR", "FOG_COORD"])
        assert.deepEqual(P.RECORDS[name + "_POINTER_VBO"], P.RECORDS.VERTEX_POINTER_VBO);
});

test("truncated multi-draw payloads never execute a partial batch", async () => {
    const { GLStream, GL } = require("./gl_stream_builder.js");
    const { host } = createFakeHost(), executor = new executorModule.GLWebGPUExecutor(null, { host, strict: true });
    await executor.initialize(); executor.submit(new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1).bytes(), {});
    const calls = []; executor.drawFromBuffers = (...args) => calls.push(args);
    for (const name of ["MULTI_DRAW_ARRAYS_DIRECT", "MULTI_DRAW_ELEMENTS_DIRECT"]) {
        const header = P.encodeRecord(name, { mode: GL.TRIANGLES, type: GL.UNSIGNED_SHORT, primcount: 2 });
        const entryName = name === "MULTI_DRAW_ARRAYS_DIRECT" ? "MULTI_DRAW_ARRAYS_ENTRY" : "MULTI_DRAW_ELEMENTS_ENTRY";
        const entry = P.encodeRecord(entryName, { first: 7, count: 3, offset: 12 });
        const payload = new Uint8Array(header.length + entry.length); payload.set(header); payload.set(entry, header.length);
        assert.throws(() => executor.handlers[P.GLFN[name]].call(executor, [], payload, new DataView(payload.buffer), 0, payload.length), /truncated/);
        assert.equal(calls.length, 0);
        new DataView(payload.buffer).setInt32(P.F[name].primcount, 1, true);
        executor.handlers[P.GLFN[name]].call(executor, [], payload, new DataView(payload.buffer), 0, payload.length);
        assert.deepEqual(calls.pop(), name === "MULTI_DRAW_ARRAYS_DIRECT" ? [GL.TRIANGLES, 7, 3, null] :
            [GL.TRIANGLES, 0, 3, { type: GL.UNSIGNED_SHORT, bufferOffset: 12 }]);
    }
});

test("typed state and parameter replies share the guest decoder's prefix", () => {
    for (const field of ["pname", "value_kind", "status", "count", "data_size", "error"])
        assert.equal(P.F.QUERY_PARAMETER[field], P.F.QUERY_STATE[field], field);
    assert.equal(P.RECORDS.QUERY_STATE.size, 24);
    assert.equal(P.RECORDS.QUERY_PARAMETER.size, 40);
});

test("rejected record tags preserve opcode and every GL error without colliding with controls", () => {
    for (const [name, opcode] of P.OPCODES) {
        assert.ok(opcode <= P.C.V86GL_REJECTED_OPCODE_MASK, name);
        assert.ok(!P.isRejected(opcode), name);
        for (let error = 0x500; error <= 0x506; ++error) {
            const encoded = P.rejectedOpcode(opcode, error);
            assert.ok(P.isRejected(encoded)); assert.equal(P.rejectionError(encoded), error);
            assert.equal(encoded & P.C.V86GL_REJECTED_OPCODE_MASK, opcode);
        }
    }
    for (const opcode of Object.values(P.CTRL)) assert.ok(!P.isRejected(opcode));
    assert.throws(() => P.rejectedOpcode(256, 0x500), RangeError);
    assert.throws(() => P.rejectedOpcode(1, 0), RangeError);
});

test("the runtime response area agrees with the generated guest heartbeat layout", () => {
    assert.equal(executorModule.GLWG_RESPONSE_REGION_BYTES, P.C.V86GL_RESPONSE_REGION_BYTES);
    assert.equal(executorModule.GLWG_HEARTBEAT_OFFSET, P.C.V86GL_HEARTBEAT_OFFSET);
    assert.equal(P.C.V86GL_HEARTBEAT_OFFSET + P.C.V86GL_HEARTBEAT_BYTES, P.C.V86GL_RESPONSE_REGION_BYTES);
    assert.ok(P.C.V86GL_ASYNC_HOST_TIMEOUT_MS < P.C.V86GL_ASYNC_SILENCE_MS);
});

test("flat records and fixed headers round-trip", () => {
    for (const [name, [, types]] of Object.entries(P.SIGNATURES)) {
        const args = [...types].map((t, i) => t === "f" || t === "d" ? i + 0.5 : t === "i" ? -i - 1 : i + 7);
        const bytes = P.encodeArgs(name, args);
        assert.equal(bytes.length, P.payloadBytes(types), name);
        const out = [];
        assert.equal(P.decodeArgs(types, new DataView(bytes.buffer), 0, bytes.length, out), types.length);
        assert.deepEqual(out, args, name);
        if (types.length)
            assert.equal(P.decodeArgs(types, new DataView(bytes.buffer), 0, bytes.length - 1, out), -1, name);
    }
    for (const [name, record] of Object.entries(P.RECORDS)) {
        const values = {};
        let k = 1;
        for (const [field, f] of Object.entries(record.fields)) {
            const v = () => f.type === "f" || f.type === "d" ? k++ + 0.25 : f.type === "i" ? -(k++) : k++;
            values[field] = f.count === 1 ? v() : Array.from({ length: f.count }, v);
        }
        const bytes = P.encodeRecord(name, values);
        assert.equal(bytes.length, record.size, name);
        assert.deepEqual(P.decodeRecord(name, new DataView(bytes.buffer), 0), values, name);
    }
});

test("the executor has a handler for every opcode", () => {
    const { host } = createFakeHost();
    const executor = new executorModule.GLWebGPUExecutor(null, { host });
    const missing = P.OPCODES.filter(([, value]) => !executor.handlers[value]).map(([name]) => name);
    assert.deepEqual(missing, []);
    // and the flat ones decode through the protocol's argument list
    for (const [name, [, types]] of Object.entries(P.SIGNATURES))
        assert.equal(executor.handlers[P.GLFN[name]].signature || "", types, name);
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
    console.log(tests.length + " GL protocol tests passed");
})();
