"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_additional_lifetime_wire} = await import("../lib/d3d8_additional_lifetime_wire.mjs"), m = require("./fixtures/d3d8_additional_lifetime_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d8_additional_lifetime_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d8_additional_lifetime_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_additional_lifetime_wire(b, result), {perAPI: m.perAPI, deviceLifetimes: 3, resets: 2, chains: 3, textures: 3, renderTargetBindings: 1, cachedRevivalCycles: 32, refusedResetCalls: 1, privateObjectsFinalized: 3, drawOrPresentCommands: 0});
    const fields = [["createWidth", "CreateDevice", "width", "CREATE_DEVICE"], ["device", "CreateDevice", "device_handle", "CREATE_DEVICE"], ["backing", "CreateSwapChain", "back_buffer_handle", "CREATE_SWAP_CHAIN"], ["format", "CreateTexture2D", "format", "CREATE_TEXTURE_2D"], ["pool", "CreateTexture2D", "pool", "CREATE_TEXTURE_2D"], ["target", "SetRenderTarget", "color_texture_handle", "SET_RENDER_TARGET"], ["chain", "DestroySwapChain", "swap_chain_handle", "DESTROY_SWAP_CHAIN"], ["resource", "DestroyResource", "resource_handle", "DESTROY_RESOURCE"], ["old", "ResetDevice", "old_device_handle", "RESET"], ["new", "ResetDevice", "new_device_handle", "RESET"]], targets = Object.create(null);
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for (const [name, kind, field, opcode] of fields) if (op === P.OP[opcode] && !targets[name]) targets[name] = p + P.F[kind][field];
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 10);
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_additional_lifetime_wire(bad, result), undefined, name);}
    for (const [from, to] of [["cycles=32", "cycles=0"], ["devicePin=1", "devicePin=2"], ["lastViewDevice=0", "lastViewDevice=1"], ["bindingOnly=1", "bindingOnly=0"]]) assert.throws(() => inspect_additional_lifetime_wire(b, {...result, logs: {...result.logs, "REF8.TXT": result.logs["REF8.TXT"].replace(from, to)}}));
    console.log("PASS frozen XP D3D8 additional lifetime: 32 zero-count revivals, three device/chain/private-object lifetimes, two Resets and binding-only cleanup, fourteen semantic corruptions");
})().catch(e => {console.error(e); process.exitCode = 1;});
