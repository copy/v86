#!/usr/bin/env node

// The VMware SVGA II adapter's guest-backed objects (level gb9, svga_gb.js
// and svga3d.js): registers, MOBs and their page tables, object tables, GB
// surfaces moved between MOBs and the GPU, GB shaders, queries and fences
// into MOBs, screen targets, the cursor in a MOB, command buffers in MOBs
// and snapshots. The renderer is the recording one of vmware_svga_3d.js:
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

const floppy = new Uint8Array(1474560);
floppy.set([0xfa, 0xf4, 0xeb, 0xfd]);
floppy[510] = 0x55;
floppy[511] = 0xAA;

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
function sent()
{
    const commands = submitted.slice(seen).flatMap(batch => d9wg_commands(batch["bytes"]));
    seen = submitted.length;
    return commands;
}
const u32 = (command, i) => command.view.getUint32(command.at + 4 * i, true);
const payload = (command, offset, length) => new Uint8Array(command.view.buffer.slice(command.view.byteOffset + offset, command.view.byteOffset + offset + length));
const find = (commands, opcode) => commands.filter(c => c.opcode === opcode);

const vm = new V86({
    graphics_adapter: "vmware_svga",
    graphics_adapter_test: { level: "gb9", renderer },
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
const PAGE = 4096;

// Registers: what vmwgfx and vm3d read before they use GB objects
const caps = reg(C.SVGA_REG_CAPABILITIES);
assert.ok(caps & C.SVGA_CAP_GBOBJECTS && caps & C.SVGA_CAP_3D && caps & C.SVGA_CAP_CAP2_REGISTER);
const cap2 = reg(C.SVGA_REG_CAP2);
assert.ok(cap2 & C.SVGA_CAP2_GROW_OTABLE && cap2 & C.SVGA_CAP2_OTABLE_PTDEPTH_2 && cap2 & C.SVGA_CAP2_CURSOR_MOB);
assert.ok(reg(C.SVGA_REG_MOB_MAX_SIZE) >= 128 << 20);
assert.ok(reg(C.SVGA_REG_GBOBJECT_MEM_SIZE_KB) > 0 && reg(C.SVGA_REG_SUGGESTED_GBOBJECT_MEM_SIZE_KB) > 0);
assert.ok(reg(C.SVGA_REG_SCREENTARGET_MAX_WIDTH) >= 1920 && reg(C.SVGA_REG_SCREENTARGET_MAX_HEIGHT) >= 1080);
assert.equal(reg(C.SVGA_REG_MAX_PRIMARY_MEM), 8 << 20);
const devcap = index => { reg(C.SVGA_REG_DEV_CAP, index); return reg(C.SVGA_REG_DEV_CAP); };
assert.equal(devcap(C.SVGA3D_DEVCAP_3D), 1, "devcaps through SVGA_REG_DEV_CAP");
assert.equal(devcap(C.SVGA3D_DEVCAP_VERTEX_SHADER_VERSION), C.SVGA3DVSVERSION_30);
assert.equal(devcap(C.SVGA3D_DEVCAP_MAX_TEXTURE_WIDTH), 8192);
assert.equal(devcap(C.SVGA3D_DEVCAP_DXCONTEXT), 0, "no DX at gb9");
reg(C.SVGA_REG_GUEST_DRIVER_ID, C.SVGA_REG_GUEST_DRIVER_ID_LINUX);
reg(C.SVGA_REG_GUEST_DRIVER_ID, 0xFFFFFFFF);
assert.equal(reg(C.SVGA_REG_GUEST_DRIVER_ID), C.SVGA_REG_GUEST_DRIVER_ID_LINUX, "SUBMIT ends the list, it is not an id");
console.log("PASS: level gb9's registers: GBOBJECTS, CAP2, devcaps through DEV_CAP, MOB and screen target limits");

reg(C.SVGA_REG_ENABLE, C.SVGA_REG_ENABLE_ENABLE);
const MIN = 0x1000, MAX = 0x10000;
w32(fifo, MIN); w32(fifo + 4, MAX); w32(fifo + 8, MIN); w32(fifo + 12, MIN);
reg(C.SVGA_REG_CONFIG_DONE, 1);
let next = MIN;
const submit = (...dwords) => {
    for(const d of dwords) { w32(fifo + next, d); next = next + 4 === MAX ? MIN : next + 4; }
    w32(fifo + 8, next);
    reg(C.SVGA_REG_SYNC, 1);
};
const cmd3d = (id, ...body) => submit(id, body.length * 4, ...body);
const fence = value => submit(C.SVGA_CMD_FENCE, value);
const fence_passed = () => r32(fifo + C.SVGA_FIFO_FENCE * 4);
const errors = () => svga.stats.errors;

// Object tables: the MOB table is one page (PT_0); the surface table two
// pages through a one-level page table of 64-bit entries
const MOB_TABLE = 0x300000, SURFACE_TABLE_PT = 0x301000;
w32(SURFACE_TABLE_PT, 0x308); w32(SURFACE_TABLE_PT + 4, 0); w32(SURFACE_TABLE_PT + 8, 0x30A); w32(SURFACE_TABLE_PT + 12, 0);
cmd3d(C.SVGA_3D_CMD_SET_OTABLE_BASE64, C.SVGA_OTABLE_MOB, MOB_TABLE / PAGE, 0, PAGE, 0, C.SVGA3D_MOBFMT_PT_0);
cmd3d(C.SVGA_3D_CMD_SET_OTABLE_BASE64, C.SVGA_OTABLE_SURFACE, SURFACE_TABLE_PT / PAGE, 0, 2 * PAGE, 0, C.SVGA3D_MOBFMT_PT64_1);
for(const type of [C.SVGA_OTABLE_CONTEXT, C.SVGA_OTABLE_SHADER, C.SVGA_OTABLE_SCREENTARGET])
{
    cmd3d(C.SVGA_3D_CMD_SET_OTABLE_BASE64, type, (0x302000 + type * PAGE) / PAGE, 0, PAGE, 0, C.SVGA3D_MOBFMT_PT_0);
}

// MOB 1: two pages that are not next to each other, through a page table
// of 32-bit entries; MOB 2: a range of eight pages
const MOB1_PT = 0x310000;
w32(MOB1_PT, 0x320); w32(MOB1_PT + 4, 0x325);
cmd3d(C.SVGA_3D_CMD_DEFINE_GB_MOB64, 1, C.SVGA3D_MOBFMT_PT_1, MOB1_PT / PAGE, 0, 2 * PAGE);
cmd3d(C.SVGA_3D_CMD_DEFINE_GB_MOB64, 2, C.SVGA3D_MOBFMT_RANGE, 0x330, 0, 8 * PAGE);
assert.equal(errors(), 0);
w32(0x325000 + 8, 0xC0FFEE);
assert.equal(svga.mobs.read32(1, PAGE + 8), 0xC0FFEE, "MOB 1's second page is the table's second entry");
assert.deepEqual([0, 1, 2, 3].map(i => r32(MOB_TABLE + 16 + 4 * i)), [C.SVGA3D_MOBFMT_PT_1, 2 * PAGE, MOB1_PT / PAGE, 0],
    "the device writes the MOB's entry");
cmd3d(C.SVGA_3D_CMD_DEFINE_GB_MOB64, 9, 77, 0, 0, PAGE);
assert.equal(errors(), 1, "an unknown page table format is an error");
console.log("PASS: object tables and MOBs: page tables of each depth, entries written by the device");

// A GB surface: 16x16 X8R8G8B8 in MOB 2, filled by the guest, then updated
cmd3d(C.SVGA_3D_CMD_DEFINE_GB_SURFACE_V2, 5, C.SVGA3D_SURFACE_HINT_RENDERTARGET, C.SVGA3D_X8R8G8B8, 1, 0, 0, 16, 16, 1, 1, 0);
cmd3d(C.SVGA_3D_CMD_BIND_GB_SURFACE, 5, 2);
assert.deepEqual([0, 5, 6, 8].map(i => r32(0x308000 + 5 * 64 + 4 * i)), [C.SVGA3D_X8R8G8B8, 16, 16, 2],
    "the surface's entry, in the table's first page: format, size, its MOB");
for(let y = 0; y < 16; y++) for(let x = 0; x < 16; x++) w32(0x330000 + y * 64 + x * 4, 0xFF000000 | y << 8 | x);
cmd3d(C.SVGA_3D_CMD_UPDATE_GB_SURFACE, 5);
fence(1);
run_renderer();
assert.equal(fence_passed(), 1);
let commands = sent();
const texture = u32(find(commands, OP.CREATE_TEXTURE_2D)[0], 1);
const upload = find(commands, OP.UPDATE_TEXTURE)[0];
assert.deepEqual([0, 5, 6, 8].map(i => u32(upload, i)), [texture, 16, 16, 64]);
const texels = payload(upload, u32(upload, 11), 16 * 64);
assert.deepEqual([...texels.subarray(3 * 64 + 5 * 4, 3 * 64 + 5 * 4 + 4)], [5, 3, 0, 0xFF], "texel (5, 3) from the MOB");

// part of it back into the MOB: what the GPU has
cmd3d(C.SVGA_3D_CMD_READBACK_GB_IMAGE_PARTIAL, 5, 0, 0, 4, 2, 0, 8, 4, 1, 0);
fence(2);
assert.equal(r32(0x330000 + 2 * 64 + 4 * 4), 0xFF000204, "not before the renderer has it");
run_renderer();
assert.equal(fence_passed(), 2);
assert.equal(r32(0x330000 + 2 * 64 + 4 * 4), (0x80 << 24 | texture << 16 | 2 << 8 | 4) >>> 0, "readback into the MOB");
assert.equal(r32(0x330000 + 2 * 64 + 12 * 4), 0xFF00020C, "outside of the box, the MOB keeps its own");
console.log("PASS: GB surfaces: UPDATE from the MOB, READBACK into it");

// GB shaders: bytecode in a MOB, used by any context
const SHADER = [0xFFFE0300, 0x0000FFFF];
w32(0x331000 + 0x40, SHADER[0]); w32(0x331000 + 0x44, SHADER[1]);
cmd3d(C.SVGA_3D_CMD_DEFINE_GB_SHADER, 3, C.SVGA3D_SHADERTYPE_VS, 8);
cmd3d(C.SVGA_3D_CMD_BIND_GB_SHADER, 3, 2, PAGE + 0x40);
const CID = 4;
cmd3d(C.SVGA_3D_CMD_DEFINE_GB_CONTEXT, CID);
cmd3d(C.SVGA_3D_CMD_SET_SHADER, CID, C.SVGA3D_SHADERTYPE_VS, 3);
cmd3d(C.SVGA_3D_CMD_SET_GB_SHADERCONSTS_INLINE, CID, 2, C.SVGA3D_SHADERTYPE_PS, C.SVGA3D_CONST_TYPE_BOOL, 1, 0, 1);
fence(3);
run_renderer();
commands = sent();
const vs = find(commands, OP.CREATE_VERTEX_SHADER)[0];
assert.deepEqual([...new Uint32Array(payload(vs, u32(vs, 3), 8).buffer)], SHADER, "the bytecode from the MOB");
assert.equal(u32(find(commands, OP.SET_VERTEX_SHADER)[0], 1), u32(vs, 1));
const bools = find(commands, OP.SET_PIXEL_SHADER_CONSTANT_B)[0];
assert.deepEqual([u32(bools, 1), u32(bools, 2)], [2, 3]);
assert.deepEqual([...new Uint32Array(payload(bools, u32(bools, 3), 12).buffer)], [1, 0, 1], "one dword per bool inline");
assert.deepEqual([0, 1, 2, 3].map(i => r32(0x305000 + 3 * 16 + 4 * i)), [C.SVGA3D_SHADERTYPE_VS, 8, PAGE + 0x40, 2]);
console.log("PASS: GB shaders from MOBs, inline shader constants");

// Queries and fences into MOBs
cmd3d(C.SVGA_3D_CMD_BEGIN_GB_QUERY, CID, C.SVGA3D_QUERYTYPE_OCCLUSION);
cmd3d(C.SVGA_3D_CMD_END_GB_QUERY, CID, C.SVGA3D_QUERYTYPE_OCCLUSION, 2, 2 * PAGE + 0x10);
cmd3d(C.SVGA_3D_CMD_WAIT_FOR_GB_QUERY, CID, C.SVGA3D_QUERYTYPE_OCCLUSION, 2, 2 * PAGE + 0x10);
cmd3d(C.SVGA_3D_CMD_GB_MOB_FENCE, 77, 2, 2 * PAGE + 0x20);
assert.equal(r32(0x332000 + 0x14), C.SVGA3D_QUERYSTATE_PENDING);
assert.equal(r32(0x332000 + 0x20), 0, "the MOB fence waits for the work before it");
run_renderer();
assert.equal(r32(0x332000 + 0x20), 77);
assert.deepEqual([0, 1, 2].map(i => r32(0x332000 + 0x10 + 4 * i)), [12, C.SVGA3D_QUERYSTATE_SUCCEEDED, 42]);
assert.equal(r32(0x332000 + 0x20), 77);
console.log("PASS: GB queries and MOB fences");

// Screen targets: an image the GPU has nothing newer of comes from its MOB
cmd3d(C.SVGA_3D_CMD_DEFINE_GB_SCREENTARGET, 0, 16, 16, 0, 0, C.SVGA_STFLAG_PRIMARY, 96);
cmd3d(C.SVGA_3D_CMD_BIND_GB_SCREENTARGET, 0, 5, 0, 0);
cmd3d(C.SVGA_3D_CMD_UPDATE_GB_SURFACE, 5);
cmd3d(C.SVGA_3D_CMD_UPDATE_GB_SCREENTARGET, 0, 0, 0, 16, 16);
const screen = svga.screens.screens.get(0);
assert.ok(screen && screen.width === 16);
const at = (x, y) => [...screen.rgba.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
assert.deepEqual(at(9, 2), [texture, 2, 9, 255], "from the MOB at once (where the readback above left the GPU's texel (9, 2))");
assert.deepEqual(at(1, 7), [0, 7, 1, 255]);
assert.deepEqual([0, 1, 2, 3].map(i => r32(0x306000 + 4 * i)), [5, 0, 0, 16], "the screen target's entry");
// once drawn into, the GPU's copy is newer: the update reads it back
cmd3d(C.SVGA_3D_CMD_SETRENDERTARGET, CID, C.SVGA3D_RT_COLOR0, 5, 0, 0);
cmd3d(C.SVGA_3D_CMD_UPDATE_GB_SCREENTARGET, 0, 0, 0, 16, 16);
fence(4);
assert.deepEqual(at(1, 7), [0, 7, 1, 255], "not yet");
run_renderer();
assert.deepEqual(at(1, 7), [texture, 7, 1, 255], "from the GPU");
console.log("PASS: screen targets, from the MOB or from the GPU");

// The cursor in a MOB: SVGAGBCursorHeader, then the image
const CURSOR = 0x333000;
[C.SVGA_ALPHA_CURSOR, 1, 2, 4, 4, 0, 0, 64].forEach((v, i) => w32(CURSOR + 4 * i, v));
for(let i = 0; i < 16; i++) w32(CURSOR + 32 + 4 * i, 0xFF0000FF);
cmd3d(C.SVGA_3D_CMD_DEFINE_GB_MOB64, 3, C.SVGA3D_MOBFMT_RANGE, CURSOR / PAGE, 0, PAGE);
reg(C.SVGA_REG_CURSOR_MOBID, 3);
assert.deepEqual([svga.cursor.width, svga.cursor.height, svga.cursor.hot_x, svga.cursor.hot_y, svga.cursor.alpha], [4, 4, 1, 2, true]);
console.log("PASS: the cursor in a MOB");

// A command buffer in a MOB
const header = 0x400000;
const body = [C.SVGA_CMD_FENCE, 9];
body.forEach((v, i) => w32(0x334000 + 0x80 + 4 * i, v));
cmd3d(C.SVGA_3D_CMD_DEFINE_GB_MOB64, 4, C.SVGA3D_MOBFMT_RANGE, 0x334, 0, PAGE);
for(let i = 0; i < 16; i++) w32(header + 4 * i, 0);
w32(header + 16, C.SVGA_CB_FLAG_MOB); w32(header + 20, 8); w32(header + 24, 4); w32(header + 28, 0x80);
reg(C.SVGA_REG_COMMAND_HIGH, 0);
reg(C.SVGA_REG_COMMAND_LOW, header | C.SVGA_CB_CONTEXT_0);
run_renderer();
assert.equal(r32(header), C.SVGA_CB_STATUS_COMPLETED);
assert.equal(fence_passed(), 9);
console.log("PASS: command buffers in MOBs");

// Snapshots: MOBs, tables, the surface's binding and contents, shaders, targets
const saving = vm.save_state();
await new Promise(resolve => setTimeout(resolve, 0));
run_renderer();
const state = await saving;
sent();
await vm.restore_state(state);
run_renderer();
commands = sent();
assert.equal(svga.mobs.read32(1, PAGE + 8), 0xC0FFEE, "MOB 1 is there again");
const restored = svga.svga3d.surfaces.get(5);
assert.ok(restored && restored.mob === 2, "the surface, bound to its MOB");
const recreated = find(commands, OP.CREATE_VERTEX_SHADER)[0];
assert.deepEqual([...new Uint32Array(payload(recreated, u32(recreated, 3), 8).buffer)], SHADER, "the GB shader");
assert.ok(svga.svga3d.targets.get(0).image, "the screen target, bound");
cmd3d(C.SVGA_3D_CMD_UPDATE_GB_SCREENTARGET, 0, 0, 0, 16, 16);
fence(10);
run_renderer();
assert.equal(fence_passed(), 10);
assert.equal(errors(), 1);
console.log("PASS: snapshots of the gb9 level");

// The device's ABI: a restore declares the level and the capabilities the
// snapshot's device declared (its driver read them at boot), not what this
// version would choose or what its tables say now
const { LEVELS } = await import("../../src/graphics_adapters/vmware_svga/svga_device.js");
const gb9_caps = reg(C.SVGA_REG_CAPABILITIES);
reg(C.SVGA_REG_DEV_CAP, C.SVGA3D_DEVCAP_MAX_TEXTURE_WIDTH);
const declared_width = reg(C.SVGA_REG_DEV_CAP);
const saving2 = vm.save_state();
await new Promise(resolve => setTimeout(resolve, 0));
run_renderer();
const state2 = await saving2;
// as if this machine had chosen another level, and the table had changed since
svga.level = "vgpu9";
svga.caps = LEVELS["vgpu9"].caps;
svga.configure_objects();
svga.devcaps.set(C.SVGA3D_DEVCAP_MAX_TEXTURE_WIDTH, 1);
assert.equal(svga.mobs, null, "no MOBs at vgpu9");
await vm.restore_state(state2);
run_renderer();
assert.equal(svga.level, "gb9", "the snapshot's level");
assert.equal(reg(C.SVGA_REG_CAPABILITIES), gb9_caps, "its capabilities");
reg(C.SVGA_REG_DEV_CAP, C.SVGA3D_DEVCAP_MAX_TEXTURE_WIDTH);
assert.equal(reg(C.SVGA_REG_DEV_CAP), declared_width, "the devcap value it declared");
assert.equal(svga.mobs.read32(1, PAGE + 8), 0xC0FFEE, "and its MOBs");
console.log("PASS: a restore declares the snapshot's level and capabilities");

// dx10.1 is dx10 and what shader model 4.1 adds; dx10 itself is unchanged
const { DX10_DEVCAPS, DX10_1_DEVCAPS } = await import("../../src/graphics_adapters/vmware_svga/svga3d_tables.js");
assert.equal(LEVELS["dx10.1"].caps, LEVELS["dx10"].caps);
assert.equal(LEVELS["dx10.1"].fifo_caps, LEVELS["dx10"].fifo_caps);
assert.equal(LEVELS["dx10.1"].cap2, LEVELS["dx10"].cap2 | C.SVGA_CAP2_DX2, "Linux's vmwgfx wants DX2 for SM4.1");
assert.ok(!(LEVELS["dx10"].cap2 & C.SVGA_CAP2_DX2));
const dx10_devcaps = new Map(DX10_DEVCAPS), dx10_1_devcaps = new Map(DX10_1_DEVCAPS);
// (a devcap dx10 does not list reads as 0)
assert.ok([...dx10_devcaps.keys()].every(index => dx10_1_devcaps.has(index)));
for(const [index, value] of dx10_1_devcaps)
{
    const old = dx10_devcaps.get(index) || 0;
    assert.equal((value & old) >>> 0, old >>> 0, "dx10.1 only adds to devcap " + index);
}
assert.equal(dx10_devcaps.get(C.SVGA3D_DEVCAP_SM41), 0);
assert.equal(dx10_1_devcaps.get(C.SVGA3D_DEVCAP_SM41), 1);
assert.equal(dx10_1_devcaps.get(C.SVGA3D_DEVCAP_DXFMT_NV12), C.SVGA3D_DXFMT_SUPPORTED);
// 4x multisampling of every target format (GX supersamples), where dx10 had WebGPU's formats only
assert.ok(!(dx10_devcaps.get(C.SVGA3D_DEVCAP_DXFMT_R32G32B32A32_FLOAT) & C.SVGA3D_DXFMT_MULTISAMPLE));
assert.ok(dx10_1_devcaps.get(C.SVGA3D_DEVCAP_DXFMT_R32G32B32A32_FLOAT) & C.SVGA3D_DXFMT_MULTISAMPLE);
assert.ok(dx10_1_devcaps.get(C.SVGA3D_DEVCAP_DXFMT_R16G16_UNORM) & C.SVGA3D_DXFMT_MULTISAMPLE);
assert.ok(!(dx10_1_devcaps.get(C.SVGA3D_DEVCAP_DXFMT_BC1_UNORM) & C.SVGA3D_DXFMT_MULTISAMPLE));
// B8G8R8X8 vertices and XR_BIAS surfaces from dx10.1 on
assert.ok(!(dx10_devcaps.get(C.SVGA3D_DEVCAP_DXFMT_B8G8R8X8_UNORM) & C.SVGA3D_DXFMT_DX_VERTEX_BUFFER));
assert.ok(dx10_1_devcaps.get(C.SVGA3D_DEVCAP_DXFMT_B8G8R8X8_UNORM) & C.SVGA3D_DXFMT_DX_VERTEX_BUFFER);
assert.ok(!dx10_devcaps.get(C.SVGA3D_DEVCAP_DXFMT_R10G10B10_XR_BIAS_A2_UNORM));
assert.ok(dx10_1_devcaps.get(C.SVGA3D_DEVCAP_DXFMT_R10G10B10_XR_BIAS_A2_UNORM) & C.SVGA3D_DXFMT_SUPPORTED);
console.log("PASS: level dx10.1: dx10 and SVGA_CAP2_DX2, SM41, 4x multisampling of every target format, NV12/YUY2");

// dx11 is dx10.1 and shader model 5
const { DX11_DEVCAPS } = await import("../../src/graphics_adapters/vmware_svga/svga3d_tables.js");
assert.equal(LEVELS["dx11"].caps, LEVELS["dx10.1"].caps);
assert.equal(LEVELS["dx11"].cap2, LEVELS["dx10.1"].cap2 | C.SVGA_CAP2_DX3, "SM5 wants DX3");
const dx11_devcaps = new Map(DX11_DEVCAPS);
for(const [index, value] of dx10_1_devcaps)
{
    const now = dx11_devcaps.get(index);
    assert.ok(now === value || now >= value, "dx11 keeps or raises devcap " + index);
}
for(const [index, value] of [[C.SVGA3D_DEVCAP_SM5, 1], [C.SVGA3D_DEVCAP_MULTISAMPLE_8X, 1], [C.SVGA3D_DEVCAP_GL43, 1],
    [C.SVGA3D_DEVCAP_MAX_FORCED_SAMPLE_COUNT, 8], [C.SVGA3D_DEVCAP_MAX_TEXTURE_WIDTH, 16384]])
{
    assert.equal(dx11_devcaps.get(index), value, "dx11 devcap " + index);
}
console.log("PASS: level dx11: dx10.1 and SVGA_CAP2_DX3, SM5, 8x multisampling, GL43, 16384-texel textures");

await vm.destroy();
