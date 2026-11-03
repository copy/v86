import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_default_format_wire(bytes, result) {
    assert.equal(result.owners.length, 1);
    const s = {owner: result.owners[0], active: 0, devices: [], handles: [], resets: [], textures: [], chains: [], hello: 0, ended: 0};
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "RESET", "CREATE_TEXTURE_2D", "CREATE_SWAP_CHAIN", "DESTROY_SWAP_CHAIN", "DESTROY_RESOURCE", "SET_RENDER_STATE", "SET_MATERIAL", "WINDOW_STATE", "SESSION_END", "GUEST_LOG", "SET_VERTEX_SHADER_CONSTANT_F", "SET_PIXEL_SHADER_CONSTANT_F", "SET_VERTEX_SHADER_CONSTANT_I", "SET_PIXEL_SHADER_CONSTANT_I", "SET_VERTEX_SHADER_CONSTANT_B", "SET_PIXEL_SHADER_CONSTANT_B"].map(n => P.OP[n]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8); assert.equal(bytes.readUInt32LE(at), s.owner); assert(size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected default-format rendering traffic: " + op);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE || op === P.OP.RESET) {
                const reset = op === P.OP.RESET, q = decode(reset ? "ResetDevice" : "CreateDevice");
                assert.equal(q.width, 128); assert.equal(q.height, 96); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 0); assert.equal(q.multisample_type, 0);
                if (reset) {
                    assert.equal(s.devices.length, 2); assert.equal(q.old_device_handle, s.active); assert.equal(q.backbuffer_format, [22, 23, 22][s.resets.length]); assert(s.chains.every(c => c.retired) && s.textures.every(t => t.retired));
                    s.resets.push({old: s.active, next: q.new_device_handle, format: q.backbuffer_format}); s.devices.at(-1).current = q.new_device_handle; s.devices.at(-1).formats.push(q.backbuffer_format);
                } else {
                    assert.equal(s.active, 0); assert.equal(q.backbuffer_format, [22, 21, 23][s.devices.length]);
                    s.devices.push({initial: q.device_handle, current: q.device_handle, formats: [q.backbuffer_format], retired: false});
                }
                const handle = reset ? q.new_device_handle : q.device_handle; assert(handle && !s.handles.includes(handle)); s.handles.push(handle); s.active = handle;
            }
            if (op === P.OP.CREATE_TEXTURE_2D) {
                const q = decode("CreateTexture2D"), i = s.textures.length; assert.equal(s.devices.length, 2); assert.equal(q.device_handle, s.active); assert.equal(q.width, 64); assert.equal(q.height, 64); assert.equal(q.format, [22, 23, 21][i]); assert.equal(q.pool, 0); assert.equal(q.usage, 1); assert.equal(q.level_count, 1); assert.equal(q.multisample_type, 0); assert.equal(s.resets.length, i);
                assert(q.resource_handle && !s.textures.some(t => t.handle === q.resource_handle)); s.textures.push({handle: q.resource_handle, device: s.active, format: q.format, retired: false});
            }
            if (op === P.OP.CREATE_SWAP_CHAIN) {
                const q = decode("CreateSwapChain"), i = s.chains.length; assert.equal(q.device_handle, s.active); assert.equal(q.width, 64); assert.equal(q.height, 64); assert.equal(q.back_buffer_handle, s.textures[i].handle); assert(q.swap_chain_handle && !s.chains.some(c => c.handle === q.swap_chain_handle));
                s.chains.push({handle: q.swap_chain_handle, device: s.active, texture: q.back_buffer_handle, retired: false});
            }
            if (op === P.OP.DESTROY_SWAP_CHAIN) {const q = decode("DestroySwapChain"), c = s.chains.find(c => c.handle === q.swap_chain_handle && !c.retired); assert(c && c.device === s.active && c.device === q.device_handle); c.retired = true;}
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource");
                if (!q.resource_kind) {const d = s.devices.find(d => d.current === q.resource_handle && !d.retired); assert(d && d.current === s.active); assert(s.chains.every(c => c.retired) && s.textures.every(t => t.retired)); d.retired = true; s.active = 0;}
                else {assert.equal(q.resource_kind, 3); const t = s.textures.find(t => t.handle === q.resource_handle && !t.retired); assert(t && t.device === s.active && s.chains.some(c => c.texture === t.handle && c.retired)); t.retired = true;}
            }
            if (op === P.OP.SESSION_END) {assert.equal(s.active, 0); s.ended++;}
            x += length;
        }
        at += 12 + size;
    }
    assert.equal(s.hello, 1); assert.equal(s.ended, 1); assert.equal(s.devices.length, 3); assert.equal(s.resets.length, 3); assert.equal(s.textures.length, 3); assert.equal(s.chains.length, 3); assert(s.devices.every(d => d.retired));
    assert.deepEqual(s.devices.map(d => d.formats), [[22], [21, 22, 23, 22], [23]]);
    const cases = [["constructorUnknown32", 22, 22], ["explicitBase", 21, 22], ["additionalUnknown32", 22, 22], ["resetUnknown32", 22, 22], ["additionalUnknown16", 23, 23], ["resetUnknown16", 23, 23], ["additionalExplicit16", 21, 23], ["resetUnknownRestored", 22, 22], ["constructorUnknown16", 23, 23]];
    const expected = cases.map(([label, format, desktop]) => "DEFAULT FORMAT label=" + label + " format=" + format + " desktop=" + desktop);
    expected.push("DEFAULT FORMAT STATUS lifetimes=3 resets=3 additional=3 invalidFullscreenConstructor=1 invalidFullscreenReset=1 originalRestored=1", "PASS default format");
    assert.equal(result.logs["FMT9.TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    return {perOwner: s, deviceLifetimes: 3, resets: 3, additionalChains: 3, backingTextures: 3, fullscreenRefusals: 2, renderingCommands: 0};
}
