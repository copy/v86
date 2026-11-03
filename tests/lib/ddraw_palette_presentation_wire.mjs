import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const color = (api, index, step) => (0xff000000 | (32 + api * 16 + step * 8) << 16 | (32 + index * 96) << 8 | (16 + step * 64)) >>> 0;
export function palette_frames() {
    return [{api: 0, step: 0, slot: 0, zero: color(0, 0, 0), one: color(0, 1, 0)}, ...[1, 2, 3, 4, 7].flatMap((api, at) => [0, 1, 2].map(step => ({api, step, slot: at * 2 + 1, zero: color(api, 0, 0), one: color(api, 1, step ? 1 : 0)})))].map((f, index) => ({...f, index, width: 32, height: 24}));
}
export function palette_table_events() {
    const events = [], add = (slot, colors) => events.push({slot, colors: colors.slice()}), seed = Array(256).fill(0xff000000); seed[0] = color(0, 0, 0); seed[1] = color(0, 1, 0); add(0, seed); add(0, seed);
    for (const [at, api] of [1, 2, 3, 4, 7].entries()) {const table = Array(256).fill(0xff000000); table[255] = 0xff090a0b; const other = table.slice(), slot = at * 2 + 1; add(slot, table); add(slot + 1, other); add(slot, table); table[0] = color(api, 0, 0); table[1] = color(api, 1, 0); add(slot, table); table[1] = color(api, 1, 1); add(slot, table); other[0] = table[0]; add(slot + 1, other); add(slot, table);}
    return events;
}
export function inspect_palette_presentation_wire(bytes, result) {
    assert.equal(result.owners.length, 1); assert.deepEqual(result.releases, result.owners);
    const owner = result.owners[0], specs = palette_frames(), events = palette_table_events(), tables = new Map(), frames = []; let device = 0, texture = 0, hwnd = 0, created = 0, destroyed = 0, uploads = 0, tableWrites = 0, screenWrites = 0, bindings = 0, slot = -1, textureDestroyed = 0, modes = 0;
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8); assert.equal(bytes.readUInt32LE(at), owner); assert(size >= 8 && at + 12 + size <= bytes.length); assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8); const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            if (op === P.OP.CREATE_DEVICE) {const q = decode("CreateDevice"); assert.equal(created++, 0); assert(q.device_handle && q.hwnd); assert.equal(q.width, 800); assert.equal(q.height, 600); assert.equal(q.windowed, 0); assert.equal(q.backbuffer_format, 22); device = q.device_handle; hwnd = q.hwnd;}
            if (op === P.OP.DD_SET_DISPLAY_MODE) {const q = decode("DDSetDisplayMode"), first = modes++ === 0; assert.equal(q.device_handle, device); assert.equal(q.width, first ? 800 : 32); assert.equal(q.height, first ? 600 : 24); assert.equal(q.bits_per_pixel, first ? 32 : 8); assert.equal(q.cooperative_flags, 6); assert.equal(q.guest_mode_changed, 0);}
            if (op === P.OP.CREATE_TEXTURE_2D) {const q = decode("CreateTexture2D"); assert.equal(texture, 0); assert.equal(q.device_handle, device); assert.equal(q.width, 32); assert.equal(q.height, 24); assert.equal(q.format, 41); assert.equal(q.level_count, 1); assert.equal(q.usage, P.C.D9WG_USAGE_DDRAW_INDEXED); assert.equal(q.pool, 0); texture = q.resource_handle; assert(texture);}
            if (op === P.OP.UPDATE_TEXTURE) {const q = decode("UpdateTexture"); assert.equal(uploads++, 0, "palette update uploaded indices again"); assert.equal(q.resource_handle, texture); assert.equal(q.x, 0); assert.equal(q.y, 0); assert.equal(q.width, 32); assert.equal(q.height, 24); assert.equal(q.row_pitch, 32); assert.equal(q.data_bytes, 768); assert(q.data_offset + 768 <= packet.length); for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) assert.equal(packet[q.data_offset + y * 32 + x], (x + y) & 1);}
            if (op === P.OP.SET_PALETTE) {const q = decode("SetPalette"), expected = events[tableWrites++]; assert(expected); assert.equal(q.device_handle, device); assert.equal(q.palette_index, expected.slot); assert.equal(q.entry_count, 256); assert(q.data_offset + 1024 <= packet.length); const colors = Array.from({length: 256}, (_, p) => packet.readUInt32LE(q.data_offset + p * 4)); assert.deepEqual(colors, expected.colors); tables.set(q.palette_index, colors);}
            if (op === P.OP.DD_SET_SURFACE_PALETTE) {const q = decode("DDSetSurfacePalette"); assert.equal(q.surface_handle, texture); assert.equal(q.palette_index, bindings ? bindings * 2 - 1 : 0); assert.equal(q.flags, 1); bindings++; slot = q.palette_index;}
            if (op === P.OP.DD_BLT) {const q = decode("DDBlt"), spec = specs[screenWrites++]; assert(spec); assert.equal(q.device_handle, device); assert.equal(q.source_handle, texture); assert.equal(q.destination_handle, 0); assert.equal(q.flags, 0); assert.equal(q.source_level, 0); assert.equal(q.destination_level, 0); assert.deepEqual(Array.from(q.source_rect), [0, 0, 32, 24]); assert.deepEqual(Array.from(q.destination_rect), [0, 0, 32, 24]); assert.equal(slot, spec.slot); assert.equal(tables.get(slot)[0], spec.zero); assert.equal(tables.get(slot)[1], spec.one); assert.equal(uploads, 1); assert.equal(frames.length, spec.index);}
            if (op === P.OP.PRESENT) {const q = decode("Present"), spec = specs[frames.length]; assert(spec); assert.equal(q.device_handle, device); assert.equal(q.hwnd, hwnd); assert.equal(q.width, 32); assert.equal(q.height, 24); assert.equal(q.x, 30); assert.equal(q.y, 40); assert.equal(screenWrites, frames.length + 1); frames.push({owner, device, texture, ...spec});}
            if (op === P.OP.DESTROY_RESOURCE) {const q = decode("DestroyResource"); if (q.resource_kind === 0) {assert.equal(q.resource_handle, device); assert.equal(textureDestroyed, 1); assert.equal(destroyed++, 0); device = 0;} else {assert.equal(q.resource_kind, 3); assert.equal(q.resource_handle, texture); assert.equal(textureDestroyed++, 0); assert.equal(frames.length, 16);}}
            assert(op !== P.OP.READBACK_SURFACE && op !== P.OP.PRESENT_SWAP_CHAIN); x += length;
        }
        at += 12 + size;
    }
    assert.equal(created, 1); assert.equal(destroyed, 1); assert.equal(modes, 2); assert.equal(uploads, 1); assert.equal(tableWrites, 37); assert.equal(bindings, 6); assert.equal(frames.length, 16);
    const hex = n => n.toString(16).toUpperCase(), lines = [];
    for (const f of specs) {lines.push(`PALETTE FRAME api=${f.api} step=${f.step} zero=${hex(f.zero)} one=${hex(f.one)} drawAfter=0`); if (f.api && f.step === 2) lines.push(`PALETTE API api=${f.api} visibleUpdates=3 unboundUpdates=1 refusals=2 textureUploads=0`);}
    lines.push("PALETTE STATUS versions=5 palettes=11 frames=16 indexUploads=1 surfaceRefs=0 factoryRefs=0", "PASS DirectDraw palette presentation"); assert.equal(result.logs["PALT.TXT"].replace(/\r/g, "").trim(), lines.join("\n"));
    return {owners: result.owners, ownerReleases: result.releases, frames, paletteTables: tableWrites, bindings, uploads, palettes: 11, refusals: 10, unboundUpdates: 5};
}
