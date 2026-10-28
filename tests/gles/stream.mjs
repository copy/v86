#!/usr/bin/env node
// One connection's stream (src/gles/gles_stream.js; docs/gles-proxy-plan.md E1):
// - the client flags, then commands, written whole, split at every byte
//   and in random pieces: the same commands decoded, the same replies;
// - a reply that waits (a promise) keeps the replies in the commands'
//   order; what the guest wrote meanwhile is decoded after it;
// - an opcode of no range is counted and skipped, so is a command whose
//   parameters do not fill it; a size below 8 breaks the stream;
// - reading the replies in pieces of any size;
// - a decoder that throws: the call answered with zeros, counted.
import assert from "node:assert/strict";
import { GLESStream } from "../../src/gles/gles_stream.js";
import { decode_reply, encode_command } from "../../src/gles/gles_wire.js";

const join = parts =>
{
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for(const p of parts) { bytes.set(p, at); at += p.length; }
    return bytes;
};
const FLAGS = new Uint8Array([0, 0, 0, 0]);

/** A decoder that answers rcGetRendererVersion 1, rcGetFBParam(p) p * 10, glGetIntegerv a counter */
function decoder(log)
{
    let n = 0;
    return (command, args) =>
    {
        log.push(command.name);
        switch(command.name)
        {
            case "rcGetRendererVersion": return 1;
            case "rcGetFBParam": return args[0] * 10;
            case "glGetIntegerv":
                args[1].view.setInt32(0, ++n, true);
                return undefined;
        }
        return 0;
    };
}

const commands = [
    ["rcGetRendererVersion", []],
    ["gles2:glClearColor", [0.25, 0.5, 0.75, 1]],
    ["rcGetFBParam", [2]],
    ["gles2:glShaderString", [7, new TextEncoder().encode("precision mediump float; void main() {}\0"), 40]],
    ["gles2:glGetIntegerv", [0x0D33, 4]],
    ["rcFBPost", [3]],
    ["gles2:glTexImage2D", [0x0DE1, 0, 0x1908, 16, 16, 0, 0x1908, 0x1401, new Uint8Array(1024).map((_, i) => i)]],
    ["gles2:glGetIntegerv", [0x0D33, 4]],
];
const stream_bytes = join([FLAGS, ...commands.map(([name, args]) => encode_command(name, args))]);
const expected_names = commands.map(([name]) => name.replace(/^gles2:/, ""));
const expected_replies = join([
    new Uint8Array([1, 0, 0, 0]), new Uint8Array([20, 0, 0, 0]), new Uint8Array([1, 0, 0, 0]), new Uint8Array([2, 0, 0, 0]),
]);

/** @param {function(!Uint8Array): !Array<!Uint8Array>} split */
function run(split)
{
    const log = [];
    const stream = new GLESStream(decoder(log));
    for(const piece of split(stream_bytes)) stream.write(piece);
    assert.deepEqual(log, expected_names);
    assert.equal(stream.flags, 0);
    const reply = stream.read(1 << 20);
    assert.deepEqual(reply, expected_replies);
    assert.equal(stream.read(16), null, "nothing more");
    assert.equal(stream.counts.get("glGetIntegerv"), 2);
}

// ---- splitting

{
    run(bytes => [bytes]);
    run(bytes => Array.from(bytes, b => new Uint8Array([b])));
    let seed = 7;
    for(let round = 0; round < 50; round++)
    {
        run(bytes =>
        {
            const pieces = [];
            for(let at = 0; at < bytes.length;)
            {
                seed = seed * 1103515245 + 12345 >>> 0;
                const n = 1 + seed % 300;
                pieces.push(bytes.slice(at, at + n));
                at += n;
            }
            return pieces;
        });
    }
    console.log("PASS: commands split anywhere");
}

// ---- a reply that waits

{
    const log = [];
    let release;
    const stream = new GLESStream((command, args) =>
    {
        log.push(command.name);
        if(command.name === "rcGetFBParam") return new Promise(resolve => { release = resolve; });
        return command.name === "rcGetRendererVersion" ? 1 : 0;
    }, () => log.push("readable"));
    stream.write(FLAGS);
    stream.write(encode_command("rcGetFBParam", [1]));
    stream.write(join([encode_command("rcFBPost", [1]), encode_command("rcGetRendererVersion", [])]));
    assert.deepEqual(log, ["rcGetFBParam"], "nothing decoded while the reply waits");
    assert.equal(stream.read(64), null);
    release(480);
    await Promise.resolve();
    assert.deepEqual(log, ["rcGetFBParam", "rcFBPost", "rcGetRendererVersion", "readable"]);
    assert.deepEqual(stream.read(64), new Uint8Array([224, 1, 0, 0, 1, 0, 0, 0]), "480, then 1: in the commands' order");
    console.log("PASS: a waiting reply keeps the order");
}

// ---- unknown, malformed, broken

{
    const log = [];
    const stream = new GLESStream(decoder(log));
    const unknown = new Uint8Array(12);
    new DataView(unknown.buffer).setUint32(0, 9000, true);
    new DataView(unknown.buffer).setUint32(4, 12, true);
    const malformed = encode_command("rcGetFBParam", [1]).slice();
    const padded = join([malformed, new Uint8Array(4)]);
    new DataView(padded.buffer).setUint32(4, padded.length, true);
    const warn = console.warn;
    console.warn = () => {};
    stream.write(join([FLAGS, unknown, padded, encode_command("rcGetRendererVersion", [])]));
    console.warn = warn;
    assert.deepEqual(log, ["rcGetRendererVersion"]);
    assert.deepEqual([...stream.unknown], [[9000, 1]]);
    assert.deepEqual([...stream.malformed], [["rcGetFBParam", 1]]);
    assert.deepEqual(stream.read(64), new Uint8Array([1, 0, 0, 0]));

    const broken = new GLESStream(decoder([]));
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, 10000, true);
    new DataView(bad.buffer).setUint32(4, 4, true);
    console.warn = () => {};
    broken.write(join([FLAGS, bad, encode_command("rcGetRendererVersion", [])]));
    console.warn = warn;
    assert.equal(broken.broken, true);
    assert.equal(broken.dropped_bytes, 8);
    broken.write(new Uint8Array(5));
    assert.equal(broken.dropped_bytes, 13, "the rest of the connection dropped");
    assert.equal(broken.read(64), null);
    console.log("PASS: unknown opcodes, malformed commands, a broken stream");
}

// ---- reading in pieces

{
    const stream = new GLESStream((command, args) => { args[1].data.fill(0xAB); return 7; });
    stream.write(FLAGS);
    // (rcGetConfigs: bufSize, an out buffer of 300 bytes; the reply its bytes, then an i32)
    for(let i = 0; i < 3; i++) stream.write(encode_command("rcGetConfigs", [300, 300]));
    const parts = [];
    for(let bytes; (bytes = stream.read(97));) parts.push(bytes);
    const all = join(parts);
    assert.equal(all.length, 3 * 304);
    assert.ok(parts.every(p => p.length <= 97));
    for(let i = 0; i < 3; i++)
    {
        const { outs, ret } = decode_reply("rcGetConfigs", [300, 300], all.subarray(i * 304, i * 304 + 304));
        assert.equal(ret, 7);
        assert.ok(outs[0].every(b => b === 0xAB));
    }
    console.log("PASS: replies read in pieces");
}

// a decoder that fails: the call is answered with zeros and counted, the stream goes on
{
    const stream = new GLESStream(command =>
    {
        if(command.name === "rcGetFBParam") throw new TypeError("a bug in a decoder");
        return 7;
    });
    const warn = console.warn;
    console.warn = () => {};
    stream.write(join([FLAGS, encode_command("rcGetFBParam", [1]), encode_command("rcGetRendererVersion", [])]));
    console.warn = warn;
    const reply = stream.read(1 << 20);
    assert.equal(decode_reply("rcGetFBParam", [1], reply.subarray(0, 4)).ret, 0, "the failed call: zeros");
    assert.equal(decode_reply("rcGetRendererVersion", [], reply.subarray(4)).ret, 7, "the next call answered");
    assert.deepEqual([...stream.failed], [["rcGetFBParam", 1]]);
    assert.equal(stream.broken, false);
    console.log("ok - a decoder's fault answers zeros");
}
