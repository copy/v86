#!/usr/bin/env node
// The GLES wire format (docs/gles-proxy-plan.md "协议与生成器", E1):
// - the generated tables (src/gles/gles_protocol.js): each API's base and
//   size, ranges that do not overlap, the layouts of commands whose shape
//   the guest's encoder (API 25's libGLESv2_enc, lib_renderControl_enc) is
//   known to use; every renderControl command the API 25 guest calls;
// - every command encoded as the guest's encoder would (gles_wire.js's test
//   encoder), decoded, answered and the answer read back: the same values;
// - a command whose parameters do not fill it is refused;
// - with the pinned specs at hand (build/gles/gfxstream-7e9d595b, or
//   GLES_SPECS), tools/gles/gen.mjs makes the same file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { GLES_APIS } from "../../src/gles/gles_protocol.js";
import { GLES_RANGES, KIND_BYTES, OutBuffer, command_of_name, command_of_opcode, decode_arguments, decode_reply, encode_command,
    encode_reply, has_reply } from "../../src/gles/gles_wire.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

// ---- the tables

{
    assert.deepEqual(Object.fromEntries(Object.entries(GLES_APIS).map(([api, { base, commands }]) => [api, [base, commands.length]])),
        { rc: [10000, 72], gles1: [1024, 293], gles2: [2048, 439] }, "the pinned specs' bases and sizes");
    const sorted = [...GLES_RANGES].sort((a, b) => a.first - b.first);
    for(let i = 1; i < sorted.length; i++) assert.ok(sorted[i].first > sorted[i - 1].last, "ranges apart: " + sorted[i].api);
    assert.equal(command_of_opcode(10000).name, "rcGetRendererVersion");
    assert.equal(command_of_opcode(1024).name, "glAlphaFunc");
    assert.equal(command_of_opcode(2048).name, "glActiveTexture");
    assert.equal(command_of_opcode(10072), null);
    assert.equal(command_of_opcode(1023), null);
    // (GLESv1's and GLESv2's names apart; a bare name is the first API's)
    assert.equal(command_of_name("gles2:glGetIntegerv").api, "gles2");
    assert.equal(command_of_name("gles1:glGetIntegerv").api, "gles1");

    const shape = name => { const c = command_of_name(name); return [c.ret, c.params.map(p => p.slice(1).flat().join(" "))]; };
    assert.deepEqual(shape("rcChooseConfig"), ["i32", ["ptr in", "u32", "ptr out nullAllowed", "u32"]]);
    assert.deepEqual(shape("rcCreateSyncKHR"), ["void", ["u32", "ptr in", "u32", "i32", "ptr out", "ptr out"]]);
    assert.deepEqual(shape("rcClientWaitSyncKHR"), ["i32", ["u64", "i32", "u64"]]);
    assert.deepEqual(shape("rcUpdateColorBuffer"), ["i32", ["u32", "i32", "i32", "i32", "i32", "u32", "u32", "ptr in isLarge"]]);
    assert.deepEqual(shape("rcUpdateColorBufferDMA")[1].slice(7), ["ptr in DMA", "u32"]);
    assert.deepEqual(shape("gles2:glTexImage2D"), ["void", ["u32", "i32", "i32", "i32", "i32", "i32", "u32", "u32", "ptr in nullAllowed isLarge"]]);
    assert.deepEqual(shape("gles2:glVertexAttribPointerData"), ["void", ["u32", "i32", "u32", "u8", "i32", "ptr in", "u32"]]);
    assert.deepEqual(shape("gles2:glShaderString"), ["void", ["u32", "ptr in", "i32"]]);
    assert.deepEqual(shape("gles2:glGetShaderPrecisionFormat"), ["void", ["u32", "u32", "ptr out", "ptr out"]]);
    assert.deepEqual(shape("gles2:glFinishRoundTrip"), ["i32", []]);
    assert.deepEqual(shape("gles1:glClearColorx"), ["void", ["i32", "i32", "i32", "i32"]]);
    assert.deepEqual(shape("gles1:glDrawTexsOES"), ["void", ["i16", "i16", "i16", "i16", "i16"]]);
    assert.ok(command_of_name("gles2:glGetString").flags.includes("unsupported"), "glGetString never on the wire (rcGetGLString instead)");

    // the API 25 guest's renderControl (lib_renderControl_enc's symbols, docs/gles-proxy-plan.md "复核结论")
    for(const name of ["rcGetRendererVersion", "rcGetEGLVersion", "rcQueryEGLString", "rcGetGLString", "rcGetNumConfigs", "rcGetConfigs",
        "rcChooseConfig", "rcGetFBParam", "rcCreateContext", "rcDestroyContext", "rcCreateWindowSurface", "rcDestroyWindowSurface",
        "rcCreateColorBuffer", "rcOpenColorBuffer", "rcOpenColorBuffer2", "rcCloseColorBuffer", "rcSetWindowColorBuffer",
        "rcFlushWindowColorBuffer", "rcFlushWindowColorBufferAsync", "rcMakeCurrent", "rcFBPost", "rcFBSetSwapInterval", "rcBindTexture",
        "rcBindRenderbuffer", "rcColorBufferCacheFlush", "rcReadColorBuffer", "rcUpdateColorBuffer", "rcUpdateColorBufferDMA",
        "rcCreateColorBufferDMA", "rcCreateClientImage", "rcDestroyClientImage", "rcSelectChecksumHelper", "rcCreateSyncKHR",
        "rcClientWaitSyncKHR", "rcWaitSyncKHR", "rcDestroySyncKHR", "rcSetPuid"])
    {
        assert.equal(command_of_name(name)?.api, "rc", name);
    }
    console.log("PASS: the tables");
}

// ---- every command: encoded, decoded, answered, the answer read back

{
    let seed = 1;
    const random = () => (seed = seed * 1103515245 + 12345 >>> 0) / 0x100000000;
    const value_of = kind =>
    {
        switch(kind)
        {
            case "u8": return random() * 256 | 0;
            case "i16": return (random() * 65536 | 0) - 32768;
            case "u16": return random() * 65536 | 0;
            case "i32": return (random() * 0x100000000 | 0);
            case "u32": return random() * 0x100000000 >>> 0;
            case "f32": return Math.fround(random() * 200 - 100);
            case "u64": return Math.floor(random() * 2 ** 52);
            case "i64": return Math.floor(random() * 2 ** 52) - 2 ** 51;
        }
        throw new Error(kind);
    };
    let checked = 0, answered = 0;
    for(const [api, { commands }] of Object.entries(GLES_APIS))
    {
        for(const [name] of commands)
        {
            const command = command_of_name(api + ":" + name);
            const args = command.params.map(([, kind, dir, flags]) =>
            {
                if(kind !== "ptr") return value_of(kind);
                if(flags && flags.includes("DMA")) return Math.floor(random() * 2 ** 40);
                const length = random() * 40 | 0;
                if(dir === "out") return length;
                return Uint8Array.from({ length }, () => random() * 256 | 0);
            });
            const bytes = encode_command(api + ":" + name, args);
            assert.equal(new DataView(bytes.buffer).getUint32(0, true), command.opcode, name);
            assert.equal(new DataView(bytes.buffer).getUint32(4, true), bytes.length, name);
            const decoded = decode_arguments(command, bytes);
            const outs = [];
            command.params.forEach(([, kind, dir, flags], i) =>
            {
                const got = decoded[i];
                if(kind !== "ptr") assert.equal(got, args[i], name + " " + i);
                else if(flags && flags.includes("DMA")) assert.deepEqual(got, { dma: args[i] }, name + " " + i);
                else if(dir === "out")
                {
                    assert.ok(got instanceof OutBuffer && got.size === args[i], name + " " + i);
                    got.data.set(Uint8Array.from({ length: got.size }, () => random() * 256 | 0));
                    outs.push(got.data.slice());
                }
                else if(dir === "inout")
                {
                    assert.deepEqual(got.data, args[i], name + " " + i);
                    got.data.reverse();
                    outs.push(got.data.slice());
                }
                else if(!args[i].length && flags && flags.includes("nullAllowed")) assert.equal(got, null, name + " " + i);
                else assert.deepEqual(got, args[i], name + " " + i);
            });
            const ret = command.ret === "void" ? undefined : value_of(command.ret);
            const reply = encode_reply(command, decoded, ret);
            if(has_reply(command) && reply)
            {
                const back = decode_reply(api + ":" + name, args, reply);
                assert.deepEqual(back.outs.map(b => b.slice()), outs, name + "'s out pointers");
                if(command.ret !== "void") assert.equal(back.ret, command.ret === "f32" ? Math.fround(ret) : ret, name + "'s return value");
                answered++;
            }
            else
            {
                assert.equal(KIND_BYTES[command.ret] + outs.reduce((n, b) => n + b.length, 0), 0, name + ": no reply, nothing to answer");
            }
            checked++;
        }
    }
    assert.equal(checked, 72 + 293 + 439);
    console.log(`PASS: ${checked} commands round trip (${answered} with a reply)`);
}

// ---- a command its parameters do not fill

{
    const command = command_of_name("rcFBPost");
    const bytes = encode_command("rcFBPost", [5]);
    assert.deepEqual(decode_arguments(command, bytes), [5]);
    const longer = new Uint8Array(bytes.length + 4);
    longer.set(bytes);
    new DataView(longer.buffer).setUint32(4, longer.length, true);
    assert.throws(() => decode_arguments(command, longer), /take 12 bytes, the command has 16/);
    const shader = encode_command("gles2:glShaderString", [3, new TextEncoder().encode("void main(){}\0"), 14]);
    new DataView(shader.buffer).setUint32(12, 1000, true);
    assert.throws(() => decode_arguments(command_of_name("gles2:glShaderString"), shader), /beyond the command/);
    console.log("PASS: malformed commands");
}

// ---- the generator against the pinned specs

{
    const specs = process.env.GLES_SPECS || [root + "build/gles/gfxstream-7e9d595b/codegen", root + "../../build/gles/gfxstream-7e9d595b/codegen"]
        .find(dir => fs.existsSync(dir));
    if(specs && fs.existsSync(specs))
    {
        const out = fs.mkdtempSync(os.tmpdir() + "/gles-gen-") + "/gles_protocol.js";
        execFileSync(process.execPath, [root + "tools/gles/gen.mjs", specs, out], { encoding: "utf8" });
        assert.equal(fs.readFileSync(out, "utf8"), fs.readFileSync(root + "src/gles/gles_protocol.js", "utf8"), "gen.mjs makes the same tables");
        fs.rmSync(out.replace(/\/[^/]+$/, ""), { recursive: true });
        console.log("PASS: tools/gles/gen.mjs (" + specs + ")");
    }
    else
    {
        console.log("SKIP: tools/gles/gen.mjs (no pinned specs: GLES_SPECS)");
    }
}
