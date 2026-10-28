#!/usr/bin/env node
// GLES state in snapshots (docs/gles-proxy-plan.md E5; src/gles/gles_snapshot.js,
// gles_host.js, src/virt/goldfish.js):
// - the packing: Maps, Sets, typed arrays, objects reached twice, classes,
//   undefined and the numbers JSON has no words for;
// - a host's state and a connection's restored on a new host, as the pipe
//   does at a restore: renderControl's objects, the shadow state (a linked
//   program's uniforms, a texture, the viewport), the bytes of a command not
//   whole yet; the page reset and given its state back; new handles go on
//   from the old ones;
// - prepare_save answers the calls that wait for the page first: the reply
//   is kept for the guest to read after the restore;
// - the goldfish pipe keeps its channels with their services' state; a
//   snapshot of the old kind (channels only) closes them.
import assert from "node:assert/strict";
import { GLESHost } from "../../src/gles/gles_host.js";
import { pack, unpack } from "../../src/gles/gles_snapshot.js";
import { GoldfishPipe } from "../../src/virt/goldfish.js";
import { decode_reply, encode_command } from "../../src/gles/gles_wire.js";
import { client, cstring, f32s, fake_renderer, i32s, settle } from "./lib.mjs";

const DISPLAY = { width: 480, height: 800, dpi: 240 };
const GL = { TEXTURE_2D: 0x0DE1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30, LINK_STATUS: 0x8B82,
    VIEWPORT: 0x0BA2, COLOR_CLEAR_VALUE: 0x0C22, TEXTURE_BINDING_2D: 0x8069, CURRENT_PROGRAM: 0x8B8D };

/** Whether a value is what v86's snapshots hold (src/state.js): no plain objects */
function snapshot_safe(value, path = "state")
{
    if(value === null || typeof value !== "object") return assert.notEqual(typeof value, "function", path);
    if(ArrayBuffer.isView(value)) return undefined;
    if(value instanceof Map) return [...value].forEach(([k, v], i) => { snapshot_safe(k, path + ".key" + i); snapshot_safe(v, path + "." + k); });
    assert.ok(Array.isArray(value), path + " is a plain object");
    return value.forEach((v, i) => snapshot_safe(v, path + "[" + i + "]"));
}

// ---- the packing

{
    function Thing() { this.n = 1; }
    Thing.prototype.twice = function() { return this.n * 2; };
    const shared = { name: "group" };
    const value = {
        map: new Map([[1, "one"], ["two", [2, 2]]]), set: new Set([3, "x"]), bytes: new Uint8Array([1, 2, 3]),
        floats: new Float32Array([0.5, -1]).subarray(1), a: shared, b: shared, thing: new Thing(), missing: undefined,
        numbers: [NaN, Infinity, -Infinity, -0, 1e300], nested: [[{ deep: true }]], gone: () => 1, gpu: { texture: 1 },
    };
    const packed = pack(value, { classes: { "Thing": Thing.prototype }, skip: key => key === "gpu" });
    snapshot_safe(packed);
    assert.equal(typeof packed[0], "string");
    const back = unpack(packed, { "Thing": Thing.prototype });
    assert.deepEqual([...back.map], [[1, "one"], ["two", [2, 2]]]);
    assert.deepEqual([...back.set], [3, "x"]);
    assert.ok(back.bytes instanceof Uint8Array);
    assert.deepEqual([...back.bytes], [1, 2, 3]);
    assert.ok(back.floats instanceof Float32Array);
    assert.deepEqual([...back.floats], [-1], "a view: its own elements");
    assert.equal(back.a, back.b, "an object reached twice is one object");
    assert.equal(back.thing.twice(), 2, "a class's prototype");
    assert.ok("missing" in back && back.missing === undefined);
    assert.ok(Number.isNaN(back.numbers[0]));
    assert.deepEqual(back.numbers.slice(1), [Infinity, -Infinity, -0, 1e300]);
    assert.ok(Object.is(back.numbers[3], -0));
    assert.deepEqual(back.nested, [[{ deep: true }]]);
    assert.equal(back.gone, undefined, "a function is left out");
    assert.equal("gpu" in back, false, "a key skipped");
    // (an instance of a class not named: left out, as the GPU's objects are)
    class Device {}
    assert.equal(unpack(pack({ device: new Device() })).device, undefined);
    console.log("ok - the packing");
}

// ---- a host and a connection, saved and restored on a new host

/** A connection's calls on a service (the guest's encoder; replies read back) */
function caller(service)
{
    return async (name, ...args) =>
    {
        service.write(encode_command(name, args));
        await settle();
        const parts = [];
        for(let bytes; (bytes = service.read(1 << 20));) parts.push(bytes.slice());
        const reply = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for(const p of parts) { reply.set(p, at); at += p.length; }
        return reply.length ? decode_reply(name, args, reply) : { outs: [], ret: undefined };
    };
}

{
    const renderer = fake_renderer();
    const host = new GLESHost(DISPLAY, renderer);
    const guest = client(host);
    const conn = await guest.connect();
    const call = conn.call;
    const context = (await call("rcCreateContext", 0, 0, 2)).ret;
    const surface = (await call("rcCreateWindowSurface", 0, 64, 64)).ret;
    const buffer = (await call("rcCreateColorBuffer", 64, 64, GL.RGBA)).ret;
    await call("rcSetWindowColorBuffer", surface, buffer);
    await call("rcMakeCurrent", context, surface, surface);
    const shader = async (type, source) =>
    {
        const name = (await call("gles2:glCreateShader", type)).ret;
        await call("gles2:glShaderString", name, cstring(source), source.length + 1);
        await call("gles2:glCompileShader", name);
        return name;
    };
    const vs = await shader(GL.VERTEX_SHADER, "attribute vec4 position; void main() { gl_Position = position; }");
    const fs = await shader(GL.FRAGMENT_SHADER, "precision mediump float; uniform vec4 tint; void main() { gl_FragColor = tint; }");
    const program = (await call("gles2:glCreateProgram")).ret;
    await call("gles2:glAttachShader", program, vs);
    await call("gles2:glAttachShader", program, fs);
    await call("gles2:glLinkProgram", program);
    // (the shader's source changed after the link: the program keeps what it linked)
    await call("gles2:glShaderString", fs, cstring("not GLSL"), 9);
    await call("gles2:glUseProgram", program);
    const tint = (await call("gles2:glGetUniformLocation", program, cstring("tint"))).ret;
    await call("gles2:glUniform4f", tint, 0.25, 0.5, 0.75, 1);
    const [texture] = i32s((await call("gles2:glGenTextures", 1, 4)).outs[0]);
    await call("gles2:glBindTexture", GL.TEXTURE_2D, texture);
    await call("gles2:glTexImage2D", GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(64));
    await call("gles2:glViewport", 1, 2, 30, 40);
    await call("gles2:glClearColor", 0.5, 0.25, 1, 0);
    // (half a command written when the machine stops)
    const viewport_get = encode_command("gles2:glGetIntegerv", [GL.VIEWPORT, 16]);
    conn.service.write(viewport_get.subarray(0, 5));

    await host.prepare_save();
    const connection_state = conn.service.get_state();
    const process_state = guest.process_pipe.get_state();
    const state = host.get_state();
    snapshot_safe(connection_state, "connection");
    snapshot_safe(process_state, "process");
    snapshot_safe(state, "host");
    assert.deepEqual(state[2], ["page state 1", []], "the page's state, fetched by prepare_save");
    assert.equal(host.get_state()[2], null, "kept for one snapshot");

    const renderer2 = fake_renderer();
    const host2 = new GLESHost(DISPLAY, renderer2);
    // (as at a restore: the pipe's channels first, then the host's slot)
    const service = host2.service("opengles", () => {}, connection_state);
    host2.service("GLProcessPipe", () => {}, process_state);
    host2.set_state(state);
    assert.deepEqual(renderer2.messages.slice(-2), ["reset", "gles_restore"]);
    assert.deepEqual(renderer2.restored, [["page state 1", []]]);
    // (the rest of the command the guest was writing)
    service.write(viewport_get.subarray(5));
    await settle();
    const viewport = decode_reply("gles2:glGetIntegerv", [GL.VIEWPORT, 16], service.read(1 << 20));
    assert.deepEqual(i32s(viewport.outs[0]), [1, 2, 30, 40], "the viewport, through the command written across the snapshot");
    const call2 = caller(service);
    assert.deepEqual(f32s((await call2("gles2:glGetFloatv", GL.COLOR_CLEAR_VALUE, 16)).outs[0]), [0.5, 0.25, 1, 0]);
    assert.deepEqual(i32s((await call2("gles2:glGetIntegerv", GL.CURRENT_PROGRAM, 4)).outs[0]), [program]);
    assert.deepEqual(i32s((await call2("gles2:glGetProgramiv", program, GL.LINK_STATUS, 4)).outs[0]), [1], "linked again from what it linked");
    assert.equal((await call2("gles2:glGetUniformLocation", program, cstring("tint"))).ret, tint);
    assert.deepEqual(f32s((await call2("gles2:glGetUniformfv", program, tint, 16)).outs[0]), [0.25, 0.5, 0.75, 1]);
    assert.deepEqual(i32s((await call2("gles2:glGetIntegerv", GL.TEXTURE_BINDING_2D, 4)).outs[0]), [texture]);
    assert.equal((await call2("gles2:glIsTexture", texture)).ret, 1);
    assert.equal((await call2("gles2:glGetError")).ret, 0);
    // (the program draws: its link info is back)
    await call2("gles2:glUseProgram", program);
    assert.equal((await call2("gles2:glGetError")).ret, 0);
    // (new handles after the old ones; the process's objects still its)
    const buffer2 = (await call2("rcCreateColorBuffer", 8, 8, GL.RGBA)).ret;
    assert.ok(buffer2 > buffer, `${buffer2} after ${buffer}`);
    assert.equal(host2.rc.color_buffers.size, 2);
    assert.equal(host2.rc.contexts.get(context).owner, "p" + guest.puid);
    // (and the page's batches go on)
    assert.equal((await call2("rcFlushWindowColorBuffer", surface)).ret, 0);
    const names = renderer2.records().map(r => r.name);
    assert.ok(names.includes("FLUSH_SURFACE"), names.join());
    assert.equal(host2.summary().connections, 1);
    console.log("ok - a host and its connection restored on a new host");
}

// ---- prepare_save answers what waits

{
    const renderer = fake_renderer({ manual: true });
    const host = new GLESHost(DISPLAY, renderer);
    const conn = await client(host).connect();
    const context = (await conn.call("rcCreateContext", 0, 0, 2)).ret;
    const surface = (await conn.call("rcCreateWindowSurface", 0, 16, 16)).ret;
    await conn.call("rcMakeCurrent", context, surface, surface);
    renderer.run();
    // (glReadPixels waits for the page; then a command after it, held back)
    conn.send("gles2:glReadPixels", 0, 0, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE, 16);
    conn.send("gles2:glGetError");
    await settle();
    assert.equal(conn.service.available(), false, "the read waits");
    const saved = host.prepare_save();
    await settle();
    renderer.run();
    await saved;
    const state = conn.service.get_state();
    const host_state = host.get_state();
    const host2 = new GLESHost(DISPLAY, fake_renderer());
    const service = host2.service("opengles", () => {}, state);
    host2.set_state(host_state);
    const reply = service.read(1 << 20);
    const pixels = decode_reply("gles2:glReadPixels", [0, 0, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE, 16], reply.subarray(0, 16));
    assert.deepEqual([...pixels.outs[0]], new Array(16).fill(host.next_request - 2 & 0xFF), "the read's pixels, answered before the save");
    assert.equal(decode_reply("gles2:glGetError", [], reply.subarray(16)).ret, 0, "and the call after it");
    console.log("ok - prepare_save answers what waits for the page");
}

// ---- the pipe's channels

{
    const memory = new Uint8Array(4096);
    let irq = false;
    let mmio = null;
    const cpu = {
        io: { register_mmio: (base, size, handlers) => { mmio = handlers; } },
        set_irq: (intid, level) => { irq = level; },
        read_blob_physical: (address, size) => memory.slice(address, address + size),
        write_blob_physical: (bytes, address) => memory.set(bytes, address),
    };
    const services = [];
    const pipe = new GoldfishPipe(cpu, 0, 32, { "ro.test": "1" }, (name, wake, saved) =>
    {
        if(name !== "echo") return null;
        let bytes = saved ? saved : new Uint8Array(0);
        const service = { write: b => { bytes = b.slice(); }, read: () => { const out = bytes; bytes = new Uint8Array(0); return out.length ? out : null; },
            available: () => bytes.length > 0, close() {}, get_state: () => bytes.slice(), saved };
        services.push(service);
        return service;
    });
    const machine = { pipe, mmio: () => mmio };
    const REG = { COMMAND: 0x00, STATUS: 0x04, CHANNEL: 0x08, SIZE: 0x0C, ADDRESS: 0x10 };
    const command = (target, channel, code, bytes) =>
    {
        const io = target.mmio();
        if(bytes) memory.set(bytes, 0);
        io.write(REG.CHANNEL, 4, channel);
        io.write(REG.SIZE, 4, bytes ? bytes.length : 256);
        io.write(REG.ADDRESS, 4, 0);
        io.write(REG.COMMAND, 4, code);
        return io.read(REG.STATUS) | 0;
    };
    const OPEN = 1, WRITE = 4, READ = 6;
    const text = s => new TextEncoder().encode(s);
    command(machine, 7, OPEN);
    command(machine, 7, WRITE, text("pipe:qemud:boot-properties\0"));
    command(machine, 7, WRITE, text("0004list"));
    command(machine, 9, OPEN);
    command(machine, 9, WRITE, text("pipe:echo\0"));
    command(machine, 9, WRITE, text("hello"));
    command(machine, 11, OPEN);
    command(machine, 11, WRITE, text("pipe:ec"));
    const state = pipe.get_state();
    snapshot_safe(state, "pipe");

    // (a new machine's pipe, its state set)
    const pipe2 = new GoldfishPipe(cpu, 0, 32, { "ro.test": "1" }, (name, wake, saved) =>
    {
        if(name !== "echo") return null;
        let bytes = saved || new Uint8Array(0);
        return { write: b => { bytes = b.slice(); }, read: () => { const out = bytes; bytes = new Uint8Array(0); return out.length ? out : null; },
            available: () => bytes.length > 0, close() {}, get_state: () => bytes.slice() };
    });
    pipe2.set_state(state);
    const machine2 = { pipe: pipe2, mmio: () => mmio };
    const read = (target, channel) =>
    {
        const n = command(target, channel, READ);
        return n > 0 ? new TextDecoder().decode(memory.slice(0, n)) : n;
    };
    assert.match(read(machine2, 7), /ro\.test=1/, "qemud's answer, not read before the snapshot");
    assert.equal(read(machine2, 9), "hello", "a service's own state");
    assert.equal(command(machine2, 11, WRITE, text("ho\0")), 3, "a name written across the snapshot");
    assert.equal(command(machine2, 11, WRITE, text("again")), 5);
    assert.equal(read(machine2, 11), "again");
    // (a snapshot of the old kind: its channels closed)
    const pipe3 = new GoldfishPipe(cpu, 0, 32, {}, () => null);
    pipe3.set_state([7, 9]);
    assert.equal(command({ mmio: () => mmio }, 9, READ), 0, "closed: end of stream");
    assert.equal(irq, true, "the closed channels' wakes");
    console.log("ok - the goldfish pipe's channels");
}
