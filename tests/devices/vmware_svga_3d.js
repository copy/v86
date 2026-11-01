#!/usr/bin/env node

// The VMware SVGA II adapter's legacy 3D (level vgpu9, svga3d.js), driven
// through the FIFO and command buffers the way vm3d and Mesa's svga driver
// do. The renderer here records the D9WG batches the device sends and
// answers readbacks and queries like src/browser/glbridge/svga_renderer.js:
// texel (x, y) of texture h reads back as BGRA (x, y, h, 0x80).

import assert from "assert/strict";
import url from "node:url";
import { createRequire as create_require } from "node:module";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const C = await import("../../src/graphics_adapters/vmware_svga/svga_constants.js");
const { d9wg_commands, OP } = await import("../../src/graphics_adapters/vmware_svga/svga3d_d9wg.js");
const D9WG = create_require(import.meta.url)("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const { QUERY_REGION_BYTES } = await import("../../src/graphics_adapters/renderer_protocol.js");

const floppy = new Uint8Array(1474560);
floppy.set([0xfa, 0xf4, 0xeb, 0xfd]);
floppy[510] = 0x55;
floppy[511] = 0xAA;

// The renderer
const submitted = [];
let queue = [], to_device = null;
const announced_devices = new Set();
const renderer = {
    "post": message => { if(message["type"] === "reset") announced_devices.clear(); if(message["type"] === "submit") { submitted.push(message); queue.push(message); } },
    "listen": handler => { to_device = handler; },
};
function run_renderer()
{
    for(const batch of queue.splice(0))
    {
        for(const { opcode, view, at, size } of d9wg_commands(batch["bytes"]))
        {
            // every command is at least its struct, as the protocol describes it
            const struct = D9WG.commandStruct(opcode);
            assert.ok(struct && size >= D9WG.STRUCTS[struct].size, "D9WG opcode 0x" + opcode.toString(16) + " is " + size + " bytes");
            const device_field = D9WG.F[D9WG.commandStruct(opcode)].device_handle;
            if(device_field !== undefined)
            {
                const device_handle = view.getUint32(at + device_field, true);
                if(opcode === OP.CREATE_DEVICE) announced_devices.add(device_handle);
                else assert.ok(announced_devices.has(device_handle), "device announced before D9WG opcode " + opcode);
            }
            if(opcode === OP.READBACK_SURFACE)
            {
                const r = D9WG.decode(struct, view, at);
                const rows = r.row_count, pitch = r.destination_pitch;
                const answer = new Uint8Array(16 + rows * pitch);
                new DataView(answer.buffer).setUint32(0, r.request_id, true);
                new DataView(answer.buffer).setUint32(4, rows * pitch, true);
                new DataView(answer.buffer).setUint32(12, 1, true);
                for(let y = 0; y < rows; y++) for(let x = 0; x < r.width; x++)
                {
                    answer.set([x, r.first_row + y, r.texture_handle, 0x80], 16 + y * pitch + x * 4);
                }
                to_device({ "type": "write", "offset": r.response_offset, "bytes": answer });
            }
            if(opcode === OP.END_QUERY)
            {
                const q = D9WG.decode(struct, view, at);
                const answer = new Uint32Array([q.request_id, 42, 0, 1]);
                to_device({ "type": "write", "offset": q.response_offset, "bytes": new Uint8Array(answer.buffer) });
            }
        }
        to_device({ "type": "done", "seq": batch["seq"] });
    }
}
let seen = 0;
/** The D9WG commands sent since the last call */
function sent()
{
    const commands = submitted.slice(seen).flatMap(batch => d9wg_commands(batch["bytes"]));
    seen = submitted.length;
    return commands;
}
const u32 = (command, i) => command.view.getUint32(command.at + 4 * i, true);
const f32_bits = v => new Uint32Array(new Float32Array([v]).buffer)[0];

const vm = new V86({
    graphics_adapter: "vmware_svga",
    graphics_adapter_test: { level: "vgpu9", renderer },
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    fda: { buffer: floppy.buffer },
    boot_order: 0x321, autostart: true, memory_size: 32 << 20, vram_size: 8 << 20,
    net_device: { type: "none" }, disable_speaker: true, log_level: 0,
});
await new Promise(resolve => vm.add_listener("emulator-ready", resolve));
await vm.wait_until_vga_screen_contains("Booting from Floppy", { timeout_msec: 30000 });
await vm.stop();

const cpu = vm.v86.cpu, io = cpu.io, svga = cpu.devices.graphics_adapter.device["svga"];
const pci_read = reg => { io.port_write32(0xcf8, 0x80000000 | 0x12 << 3 << 8 | reg); return io.port_read32(0xcfc) >>> 0; };
const port = pci_read(0x10) & ~3, fifo = (pci_read(0x18) & ~0xF) >>> 0;
const reg = (index, value) => { io.port_write32(port, index); if(value === undefined) return io.port_read32(port + 1) >>> 0; io.port_write32(port + 1, value); };
const w32 = (address, value) => { for(let i = 0; i < 4; i++) cpu.write8(address + i, value >>> 8 * i & 0xFF); };
const r32 = address => (cpu.read8(address) | cpu.read8(address + 1) << 8 | cpu.read8(address + 2) << 16 | cpu.read8(address + 3) << 24) >>> 0;

// The device declares 3D and writes its capabilities when the FIFO is set up
assert.ok(reg(C.SVGA_REG_CAPABILITIES) & C.SVGA_CAP_3D, "SVGA_CAP_3D");
reg(C.SVGA_REG_ENABLE, C.SVGA_REG_ENABLE_ENABLE);
const MIN = 0x1000, MAX = 0x10000;
w32(fifo, MIN); w32(fifo + 4, MAX); w32(fifo + 8, MIN); w32(fifo + 12, MIN);
reg(C.SVGA_REG_CONFIG_DONE, 1);
assert.ok(r32(fifo + C.SVGA_FIFO_CAPABILITIES * 4) & C.SVGA_FIFO_CAP_3D_HWVERSION_REVISED);
assert.equal(r32(fifo + C.SVGA_FIFO_3D_HWVERSION_REVISED * 4), C.SVGA3D_HWVERSION_WS8_B1, "what vm3d needs at least");
const caps = fifo + C.SVGA_FIFO_3D_CAPS * 4, record = r32(caps);
assert.equal(r32(caps + 4), C.SVGA3D_FIFO_CAPS_RECORD_DEVCAPS);
assert.ok(record <= C.SVGA_FIFO_3D_CAPS_SIZE - 1, "the record fits");
assert.equal(r32(caps + 4 * record), 0, "an empty record ends the list");
const devcaps = new Map();
for(let i = 2; i < record; i += 2) devcaps.set(r32(caps + 4 * i), r32(caps + 4 * i + 4));
assert.equal(devcaps.get(C.SVGA3D_DEVCAP_3D), 1);
assert.equal(devcaps.get(C.SVGA3D_DEVCAP_VERTEX_SHADER_VERSION), C.SVGA3DVSVERSION_30);
assert.equal(devcaps.get(C.SVGA3D_DEVCAP_FRAGMENT_SHADER_VERSION), C.SVGA3DPSVERSION_30);
assert.equal(devcaps.get(C.SVGA3D_DEVCAP_MAX_RENDER_TARGETS), 4);
assert.ok(devcaps.get(C.SVGA3D_DEVCAP_SURFACEFMT_ARGB_S10E5) & C.SVGA3DFORMAT_OP_OFFSCREEN_RENDERTARGET);
// what VMware's Windows driver asks the backdoor before it has the device
// (it loads as a full WDDM driver only with 3D there)
const backdoor = subcommand => {
    cpu.reg32[0] = 0x564D5868; cpu.reg32[3] = 0; cpu.reg32[1] = subcommand << 16 | 75; cpu.reg32[2] = 0x5658;
    return [io.port_read32(0x5658) >>> 0, cpu.reg32[3] >>> 0];
};
assert.deepEqual(backdoor(0), [reg(C.SVGA_REG_CAPABILITIES), 0x564D5868], "GET_SVGA_CAPABILITIES: the capabilities");
assert.deepEqual(backdoor(2), [C.SVGA3D_HWVERSION_WS8_B1, 0x564D5868], "and the 3D hardware version");
console.log("PASS: level vgpu9 declares 3D: hardware version, devcaps record (" + devcaps.size + " caps)");

let next = MIN;
const submit = (...dwords) => {
    for(const d of dwords) { w32(fifo + next, d); next = next + 4 === MAX ? MIN : next + 4; }
    w32(fifo + 8, next);
    reg(C.SVGA_REG_SYNC, 1);
};
const cmd3d = (id, ...body) => submit(id, body.length * 4, ...body);
const fence = value => submit(C.SVGA_CMD_FENCE, value);
const fence_passed = () => r32(fifo + C.SVGA_FIFO_FENCE * 4);
const find = (commands, opcode) => commands.filter(c => c.opcode === opcode);

// GMR 1: two pages at 2 MiB; screen 0: 32x32
w32(0x100000, 0x200); w32(0x100004, 2); w32(0x100008, 0); w32(0x10000C, 0);
reg(C.SVGA_REG_GMR_ID, 1);
reg(C.SVGA_REG_GMR_DESCRIPTOR, 0x100);
submit(C.SVGA_CMD_DEFINE_SCREEN, 44, 0, C.SVGA_SCREEN_MUST_BE_SET | C.SVGA_SCREEN_IS_PRIMARY, 32, 32, 0, 0, C.SVGA_GMR_NULL, 0, 0, 0);

// Surfaces: a 16x16 render target, a vertex buffer, a depth buffer
const NO_MIPS = [0, 0, 0, 0, 0];
cmd3d(C.SVGA_3D_CMD_SURFACE_DEFINE, 1, C.SVGA3D_SURFACE_HINT_RENDERTARGET, C.SVGA3D_X8R8G8B8, 1, ...NO_MIPS, 16, 16, 1);
cmd3d(C.SVGA_3D_CMD_SURFACE_DEFINE, 2, C.SVGA3D_SURFACE_HINT_VERTEXBUFFER, C.SVGA3D_BUFFER, 1, ...NO_MIPS, 36, 1, 1);
cmd3d(C.SVGA_3D_CMD_SURFACE_DEFINE, 3, C.SVGA3D_SURFACE_HINT_DEPTHSTENCIL, C.SVGA3D_Z_D24S8, 1, ...NO_MIPS, 16, 16, 1);
// three vertices into the buffer, through GMR 1
const vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0];
vertices.forEach((v, i) => w32(0x200000 + 4 * i, f32_bits(v)));
cmd3d(C.SVGA_3D_CMD_SURFACE_DMA, 1, 0, 36, 2, 0, 0, C.SVGA3D_WRITE_HOST_VRAM, 0, 0, 0, 36, 1, 1, 0, 0, 0, 12, 36, 0);
fence(1);
assert.equal(fence_passed(), 0, "the fence waits for the renderer");
run_renderer();
assert.equal(fence_passed(), 1, "and passes when it has run the batch");
let commands = sent();
const textures = find(commands, OP.CREATE_TEXTURE_2D);
assert.equal(textures.length, 2);
const [target, depth] = [u32(textures[0], 1), u32(textures[1], 1)];
assert.deepEqual([u32(textures[0], 2), u32(textures[0], 3), u32(textures[0], 5), u32(textures[0], 6)], [16, 16, 22, 1],
    "16x16 D3DFMT_X8R8G8B8, D3DUSAGE_RENDERTARGET");
assert.deepEqual([u32(textures[1], 5), u32(textures[1], 6)], [75, 2], "D3DFMT_D24S8, D3DUSAGE_DEPTHSTENCIL");
assert.equal(find(commands, OP.CREATE_BUFFER).length, 0, "a buffer becomes a D9WG buffer when a draw uses it");
console.log("PASS: surfaces, and fences after GPU work");

// A context, its state and a draw
const CID = 7;
cmd3d(C.SVGA_3D_CMD_CONTEXT_DEFINE, CID);
cmd3d(C.SVGA_3D_CMD_SETRENDERTARGET, CID, C.SVGA3D_RT_COLOR0, 1, 0, 0);
cmd3d(C.SVGA_3D_CMD_SETRENDERTARGET, CID, C.SVGA3D_RT_DEPTH, 3, 0, 0);
cmd3d(C.SVGA_3D_CMD_SETVIEWPORT, CID, 0, 0, 16, 16);
cmd3d(C.SVGA_3D_CMD_SETRENDERSTATE, CID, C.SVGA3D_RS_CULLMODE, C.SVGA3D_FACE_FRONT, C.SVGA3D_RS_FRONTWINDING, C.SVGA3D_FRONTWINDING_CCW,
    C.SVGA3D_RS_SRCBLEND, C.SVGA3D_BLENDOP_BLENDFACTOR, C.SVGA3D_RS_ALPHAREF, f32_bits(0.5), C.SVGA3D_RS_ZENABLE, 1);
cmd3d(C.SVGA_3D_CMD_SETTEXTURESTATE, CID, 0, C.SVGA3D_TS_BIND_TEXTURE, 1, 0, C.SVGA3D_TS_ADDRESSU, C.SVGA3D_TEX_ADDRESS_EDGE,
    0, C.SVGA3D_TS_COLORARG1, C.SVGA3D_TA_TEXTURE | C.SVGA3D_TM_ONE_MINUS, 0, C.SVGA3D_TS_COLOROP, C.SVGA3D_TC_MODULATE2X);
const SHADER = [0xFFFE0300, 0x0000FFFF];
cmd3d(C.SVGA_3D_CMD_SHADER_DEFINE, CID, 5, C.SVGA3D_SHADERTYPE_VS, ...SHADER);
cmd3d(C.SVGA_3D_CMD_SET_SHADER, CID, C.SVGA3D_SHADERTYPE_VS, 5);
cmd3d(C.SVGA_3D_CMD_SET_SHADER_CONST, CID, 3, C.SVGA3D_SHADERTYPE_VS, C.SVGA3D_CONST_TYPE_FLOAT, ...[1, 2, 3, 4].map(f32_bits));
cmd3d(C.SVGA_3D_CMD_DRAW_PRIMITIVES, CID, 1, 1,
    C.SVGA3D_DECLTYPE_FLOAT3, C.SVGA3D_DECLMETHOD_DEFAULT, C.SVGA3D_DECLUSAGE_POSITION, 0, 2, 0, 12, 0, 2,
    C.SVGA3D_PRIMITIVE_TRIANGLELIST, 1, 0xFFFFFFFF, 0, 0, 0, 0);
fence(2);
run_renderer();
assert.equal(fence_passed(), 2);
commands = sent();
const rt = find(commands, OP.SET_RENDER_TARGET)[0];
const device = u32(rt, 0);
assert.deepEqual([u32(rt, 1), u32(rt, 2)], [0, target], "COLOR0 is the render target's texture");
assert.deepEqual([1, 2, 3, 4].map(i => u32(find(commands, OP.SET_DEPTH_STENCIL_SURFACE_LEVEL)[0], i)), [depth, 0, 16, 16]);
const states = new Map(find(commands, OP.SET_RENDER_STATE).map(c => [u32(c, 1), u32(c, 2)]));
assert.equal(states.get(22), 3, "culling the front with counterclockwise fronts is D3DCULL_CCW");
assert.equal(states.get(19), 14, "SVGA3D_BLENDOP_BLENDFACTOR is D3DBLEND_BLENDFACTOR");
assert.equal(states.get(24), 128, "the alpha reference is a float in SVGA3D");
assert.equal(states.get(7), 1);
assert.deepEqual(find(commands, OP.SET_TEXTURE).map(c => [u32(c, 1), u32(c, 2)]), [[0, target]]);
assert.deepEqual(find(commands, OP.SET_SAMPLER_STATE).map(c => [u32(c, 2), u32(c, 3)]), [[1, 3]], "ADDRESS_EDGE is D3D's clamp");
assert.deepEqual(find(commands, OP.SET_TEXTURE_STAGE_STATE).map(c => [u32(c, 2), u32(c, 3)]), [[2, 0x12], [1, 5]],
    "TEXTURE|ONE_MINUS is D3DTA_TEXTURE|D3DTA_COMPLEMENT, MODULATE2X is 5");
const shader = find(commands, OP.CREATE_VERTEX_SHADER)[0];
assert.deepEqual([u32(shader, 0), u32(shader, 1), u32(shader, 2)], [device, 0x40000001, 2]);
assert.deepEqual([...new Uint32Array(rt.view.buffer.slice(rt.view.byteOffset + u32(shader, 3), rt.view.byteOffset + u32(shader, 3) + 8))], SHADER);
assert.equal(u32(find(commands, OP.SET_VERTEX_SHADER)[0], 1), 0x40000001);
const constant = find(commands, OP.SET_VERTEX_SHADER_CONSTANT_F)[0];
assert.deepEqual([u32(constant, 1), u32(constant, 2)], [3, 1]);
assert.deepEqual([...new Float32Array(constant.view.buffer.slice(constant.view.byteOffset + u32(constant, 3), constant.view.byteOffset + u32(constant, 3) + 16))], [1, 2, 3, 4]);
const buffer = find(commands, OP.CREATE_BUFFER)[0];
assert.deepEqual([u32(buffer, 2), u32(buffer, 3)], [1, 36], "a 36-byte vertex buffer");
const upload = find(commands, OP.UPDATE_BUFFER)[0];
assert.deepEqual([...new Float32Array(upload.view.buffer.slice(upload.view.byteOffset + u32(upload, 3), upload.view.byteOffset + u32(upload, 3) + 36))], vertices,
    "filled with what SURFACE_DMA brought");
const declaration = find(commands, OP.CREATE_VERTEX_DECLARATION)[0];
assert.equal(u32(declaration, 2), 1);
assert.deepEqual([u32(declaration, 4), u32(declaration, 5)], [0, C.SVGA3D_DECLTYPE_FLOAT3 | 0 << 8 | C.SVGA3D_DECLUSAGE_POSITION << 16],
    "stream 0, offset 0, FLOAT3 POSITION");
assert.deepEqual([1, 2, 3, 4].map(i => u32(find(commands, OP.SET_STREAM_SOURCE)[0], i)), [0, u32(buffer, 1), 12, 0]);
assert.deepEqual([1, 2, 3].map(i => u32(find(commands, OP.DRAW_PRIMITIVE)[0], i)), [4, 0, 1], "D3DPT_TRIANGLELIST, from 0, one");
console.log("PASS: a context's state, shaders, constants, vertex streams and a draw");

// Readbacks: SURFACE_DMA into the guest, and presenting to the screen
cmd3d(C.SVGA_3D_CMD_SURFACE_DMA, 1, 0x100, 64, 1, 0, 0, C.SVGA3D_READ_HOST_VRAM, 2, 3, 0, 4, 2, 1, 0, 0, 0);
cmd3d(C.SVGA_3D_CMD_BLIT_SURFACE_TO_SCREEN, 1, 0, 0, 0, 0, 16, 16, 0, 4, 4, 20, 20);
fence(3);
const screen = svga.screens.screens.get(0);
assert.deepEqual([...screen.rgba.subarray((10 * 32 + 9) * 4, (10 * 32 + 9) * 4 + 4)], [0, 0, 0, 0], "not before the renderer has run it");
run_renderer();
assert.equal(fence_passed(), 3);
assert.deepEqual([0, 1, 2, 3].map(i => cpu.read8(0x200100 + 64 + 4 + i)), [3, 4, target, 0x80],
    "texel (3, 4) of the box at (2, 3) is in the guest, one row and one texel in");
assert.deepEqual([...screen.rgba.subarray((10 * 32 + 9) * 4, (10 * 32 + 9) * 4 + 4)], [target, 6, 5, 255],
    "texel (5, 6) on the screen at (9, 10), BGRA to RGBA");
// scaled: the 16x16 surface into 8x8
cmd3d(C.SVGA_3D_CMD_BLIT_SURFACE_TO_SCREEN, 1, 0, 0, 0, 0, 16, 16, 0, 0, 0, 8, 8);
fence(4);
run_renderer();
assert.deepEqual([...screen.rgba.subarray((3 * 32 + 1) * 4, (3 * 32 + 1) * 4 + 3)], [target, 6, 2], "scaled down");
console.log("PASS: readbacks into guest memory and onto the screen");

// An occlusion query: pending, then the count
cmd3d(C.SVGA_3D_CMD_BEGIN_QUERY, CID, C.SVGA3D_QUERYTYPE_OCCLUSION);
cmd3d(C.SVGA_3D_CMD_END_QUERY, CID, C.SVGA3D_QUERYTYPE_OCCLUSION, 1, 0x400);
assert.deepEqual([r32(0x200400), r32(0x200404)], [12, C.SVGA3D_QUERYSTATE_PENDING]);
fence(5);
run_renderer();
assert.deepEqual([r32(0x200400), r32(0x200404), r32(0x200408)], [12, C.SVGA3D_QUERYSTATE_SUCCEEDED, 42]);
console.log("PASS: occlusion queries");

// A command buffer with 3D in it completes after the GPU work
const header = 0x400000, body = 0x401000;
const clear = [C.SVGA_3D_CMD_CLEAR, 20, CID, C.SVGA3D_CLEAR_COLOR, 0xFF00FF00, 0, 0];
clear.forEach((d, i) => w32(body + i * 4, d));
for(let i = 0; i < 64; i += 4) w32(header + i, 0);
w32(header + 20, clear.length * 4); w32(header + 24, body);
reg(C.SVGA_REG_COMMAND_HIGH, 0);
reg(C.SVGA_REG_COMMAND_LOW, header);
assert.equal(r32(header), C.SVGA_CB_STATUS_NONE, "not complete while the renderer has not run it");
run_renderer();
assert.equal(r32(header), C.SVGA_CB_STATUS_COMPLETED);
const clears = find(sent(), OP.CLEAR);
assert.deepEqual([0, 1, 2, 5].map(i => u32(clears[0], i)), [device, 1, 0xFF00FF00, 0]);
console.log("PASS: command buffers with 3D complete after it");

// Snapshots: the GPU's contents are read back first, and a restore makes the
// objects again in a fresh renderer, filled and with their state
sent();
const saving = vm.save_state();
// (the readbacks of the save need the renderer)
await new Promise(resolve => setTimeout(resolve, 0));
run_renderer();
const state = await saving;
commands = sent();
assert.ok(find(commands, OP.READBACK_SURFACE).length >= 1, "the save read the render target back");
await vm.restore_state(state);
run_renderer();
commands = sent();
const created = find(commands, OP.CREATE_TEXTURE_2D);
assert.equal(created.length, 2, "both textures again");
const restored_target = u32(created[0], 1);
const filled = find(commands, OP.UPDATE_TEXTURE).find(c => u32(c, 0) === restored_target);
assert.ok(filled, "the render target is filled again");
const texels = new Uint8Array(filled.view.buffer.slice(filled.view.byteOffset + u32(filled, 11), filled.view.byteOffset + u32(filled, 11) + 16 * 16 * 4));
assert.deepEqual([...texels.subarray((6 * 16 + 5) * 4, (6 * 16 + 5) * 4 + 3)], [5, 6, target & 0xFF], "with what was read back");
const restored_states = new Map(find(commands, OP.SET_RENDER_STATE).map(c => [u32(c, 1), u32(c, 2)]));
assert.equal(restored_states.get(22), 3, "the context's render states are set again");
assert.equal(find(commands, OP.CREATE_VERTEX_SHADER).length, 1, "and its shaders defined");
assert.equal(u32(find(commands, OP.SET_RENDER_TARGET)[0], 2), restored_target, "its target is the new texture");
// the buffer's bytes are in the snapshot itself
cmd3d(C.SVGA_3D_CMD_DRAW_PRIMITIVES, CID, 1, 1,
    C.SVGA3D_DECLTYPE_FLOAT3, C.SVGA3D_DECLMETHOD_DEFAULT, C.SVGA3D_DECLUSAGE_POSITION, 0, 2, 0, 12, 0, 2,
    C.SVGA3D_PRIMITIVE_TRIANGLELIST, 1, 0xFFFFFFFF, 0, 0, 0, 0);
fence(6);
run_renderer();
const again = find(sent(), OP.UPDATE_BUFFER)[0];
assert.deepEqual([...new Float32Array(again.view.buffer.slice(again.view.byteOffset + u32(again, 3), again.view.byteOffset + u32(again, 3) + 36))], vertices);
console.log("PASS: snapshots of the 3D level");

await vm.destroy();
