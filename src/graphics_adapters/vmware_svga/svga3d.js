// Legacy 3D (level vgpu9; docs/gpu-devices.md, "VMware SVGA II"): the SVGA3D
// commands of VMware's pre-guest-backed 3D, the D3D9-shaped API that Windows'
// vm3d and Mesa's svga driver speak to a device without SVGA_CAP_GBOBJECTS.
//
// The CPU side (this file) validates commands, reads the guest memory they
// refer to, and writes self-contained D9WG batches (svga3d_d9wg.js) for the
// renderer, which runs them through the D3D9 executor on WebGPU
// (src/browser/glbridge/svga_renderer.js). Nothing here touches WebGPU.
//
// - Each SVGA3D context is a D9WG device of its own: the executor keeps the
//   whole D3D9 state per device, so switching contexts needs no shadowing.
//   Surfaces, shaders and declarations are resources every device can use.
// - A surface is a D9WG texture (2D, cube, volume or depth), created when it
//   is defined. A buffer surface (SVGA3D_BUFFER) is a vertex buffer, a 16-bit
//   index buffer or a 32-bit one depending on how a draw uses it, each made
//   the first time; their bytes are kept here so a new role starts complete.
// - Pictures leave the GPU through readbacks: SURFACE_DMA to the guest, and
//   PRESENT / BLIT_SURFACE_TO_SCREEN, whose rows are read back and drawn into
//   the screens' pictures (or the legacy frame buffer). So the screen, the
//   cursor, screenshots and snapshots stay where the 2D levels have them.
// - Completion: fences and command buffers that follow GPU work complete
//   when the renderer has run every batch before them (after_work).
// - Snapshots (docs/gpu-devices.md, "Snapshots"): the GPU's objects have no
//   guest backing, so before a save every surface is read back
//   (prepare_save). The snapshot keeps each surface's definition and
//   contents, and each context's shaders and the last command for each piece
//   of its state; restoring replays them.

import { LOG_VGA } from "../../const.js";
import { dbg_log } from "../../log.js";
import * as C from "./svga_constants.js";
import { D9WGWriter, OP, KIND, d9wg_encode } from "./svga3d_d9wg.js";
import { RESPONSE_REGION_OFFSET, QUERY_REGION_BYTES, QUERY_SLOT_BYTES, READBACK_HEADER_BYTES, READBACK_MAX_BYTES,
    RESPONSE_OK, GXWriter, GX } from "../renderer_protocol.js";
import { DXDevice } from "./svga3d_dx.js";
import { SURFACE_DESCS, SVGA3DBLOCKDESC_BUFFER, SVGA3DBLOCKDESC_DEPTH } from "./svga_formats.js";
import { FORMATS, D3DFMT, VGPU9_DEVCAPS, PRIMITIVES, primitive_vertices, d3d_transform, d3d_light_type,
    D3DRS, SAME_RENDER_STATES, d3d_blend, D3DTSS, D3DSAMP, TEXTURE_OPS, d3d_texture_argument,
    d3d_texture_transform_flags, d3d_address, d3d_texcoord_generation } from "./svga3d_tables.js";

const INVALID = 0xFFFFFFFF;

const D3DUSAGE_RENDERTARGET = 0x1;
const D3DUSAGE_DEPTHSTENCIL = 0x2;
const D3DUSAGE_DYNAMIC = 0x200;
const D3DUSAGE_AUTOGENMIPMAP = 0x400;
const D3DQUERYTYPE_OCCLUSION = 9;
const D3DFOG_NONE = 0;
const D3DCULL_NONE = 1;
const D3DCULL_CW = 2;
const D3DCULL_CCW = 3;

/** The D9WG device for work that belongs to no context (copies, readbacks) */
const UTILITY_DEVICE = 0x7FFF0001;
/** The executor's first shader handle (D9WG_SHADER_HANDLE_BASE) */
const SHADER_HANDLE_BASE = 0x40000001;
/** Texture stages from here on are the vertex shader's samplers */
const SAMPLERS_PS = 16;
const D3DVERTEXTEXTURESAMPLER0 = 257;
const MAX_STREAMS = 16;
/** A batch is sent at the latest when it is this big */
const BATCH_FLUSH_BYTES = 8 << 20;
/** Query result slots in the response region */
const QUERY_SLOTS = QUERY_REGION_BYTES / QUERY_SLOT_BYTES;

/** SVGA3dDeclType -> bytes */
const DECL_SIZES = [4, 8, 12, 16, 4, 4, 4, 8, 4, 4, 8, 4, 8, 4, 4, 4, 8];

/** Which D9WG resources a buffer surface may have: vertex, index16, index32 */
const ROLE_VERTEX = 0;
const ROLE_INDEX16 = 1;
const ROLE_INDEX32 = 2;

/**
 * @constructor
 */
function Surface(sid, flags, format, faces, sizes, samples)
{
    this.sid = sid;
    this.flags = flags;
    this.format = format;
    /** @type {?Object} its D3D9 format, for D9WG */
    this.info = FORMATS[format] || null;
    const desc = SURFACE_DESCS[format] || SURFACE_DESCS[0];
    /** how its texels are stored: blocks of block x block_h texels, `bytes` each */
    this.layout = { block: /** @type {number} */ (desc[1]) || 1, block_h: /** @type {number} */ (desc[2]) || 1,
        bytes: /** @type {number} */ (desc[4]) };
    this.buffer = format === C.SVGA3D_BUFFER || !!(/** @type {number} */ (desc[0]) & SVGA3DBLOCKDESC_BUFFER);
    this.depth = !!(/** @type {number} */ (desc[0]) & SVGA3DBLOCKDESC_DEPTH);
    /** where its newest contents are on the GPU: "" (nowhere yet: a GB
     * surface's MOB has them), "d9wg", "gx" */
    this.home = "";
    /** it has a D9WG resource (legacy 3D used it) and a GX one (DX used it);
     * the D3D9 driver and DWM share surfaces, so it can have both */
    this.in_d9 = false;
    this.in_gx = false;
    /** the copy that is not at home is older (when it has both) */
    this.stale = false;
    this.faces = faces;
    /** [width, height, depth] of each mip level */
    this.sizes = sizes;
    this.samples = samples;
    this.handle = 0;
    this.kind = 0;
    /** @type {Uint8Array} a buffer's bytes */
    this.data = null;
    /** a buffer's D9WG buffers, by role */
    this.roles = [0, 0, 0];
    /** @type {Int32Array} the SURFACE_DEFINE(_V2) body, for snapshots */
    this.definition = null;
    this.definition_id = 0;
    /** @type {Array<Uint8Array>} contents read back for a snapshot: (face or slice, mip) */
    this.saved = null;
    // guest-backed surfaces: the MOB with their image, and the pitch of
    // its first level there if the driver gave one
    this.mob = INVALID;
    this.mob_pitch = 0;
    /** @type {?{format: number, flags: number, flags2: number, filter: number, array_size: number, pattern: number, quality: number, stride: number, layers: number}} a GB surface's definition */
    this.gb = null;
    /** the GPU may have what the MOB does not: drawn into, copied into */
    this.host_newer = false;
}

/**
 * @constructor
 */
function Context(cid, device)
{
    this.cid = cid;
    /** its D9WG device */
    this.device = device;
    /** "type:shid" -> D9WG shader handle */
    this.shaders = new Map();
    this.viewport = null;
    this.zrange = [0, 1];
    this.scissor = null;
    this.cull = C.SVGA3D_FACE_NONE;
    this.winding = C.SVGA3D_FRONTWINDING_CW;
    this.texcoord_index = new Int32Array(SAMPLERS_PS);
    this.texcoord_gen = new Int32Array(SAMPLERS_PS);
    for(let i = 0; i < SAMPLERS_PS; i++) this.texcoord_index[i] = i;
    /** streams given a frequency other than 1 by the last draw */
    this.instanced = 0;
    /** the color target 0 surface, for the clear and viewport sizes */
    this.target = null;
    /** @type {!Map<number, !Surface>} the bound targets by SVGA3dRenderTargetType: draws write them */
    this.targets = new Map();
    /** @type {!Map<string, !Int32Array>} SHADER_DEFINE bodies by "type:shid", for snapshots */
    this.shader_definitions = new Map();
    /** @type {!Map<string, !Array>} the last command setting each piece of state: [id, body] */
    this.state = new Map();
    /** @type {number|undefined} a GB context's MOB */
    this.mob = undefined;
}

/**
 * @constructor
 * @param {!Object} device the SVGADevice
 * @param {!Object} renderer the channel: post(message, transfer), listen(handler)
 */
export function SVGA3D(device, renderer)
{
    this.device = device;
    this.renderer = renderer;
    this.writer = new D9WGWriter();
    /** @type {!Map<number, !Surface>} */
    this.surfaces = new Map();
    /** @type {!Set<!Surface>} surfaces both D9WG and GX have (the D3D9 driver's and DWM's) */
    this.duals = new Set();
    /** @type {!Map<number, !Context>} */
    this.contexts = new Map();
    this.declarations = new Map();
    this.next_handle = 1;
    this.next_shader = 0;
    this.next_device = 1;
    this.next_request = 1;
    this.frame = 0;
    // batches sent and run
    this.submitted = 0;
    this.completed = 0;
    /** @type {!Array<{seq: number, run: function()}>} waiting for batches, in order */
    this.completions = [];
    /** @type {!Map<number, function(Uint8Array, number)>} request id -> answer */
    this.requests = new Map();
    this.warned = new Set();
    /** @type {?function(number, !Int32Array)} sees each command (for test harnesses) */
    this.command_log = null;
    /** @type {?function(number, number, !Uint8Array)} tests: each DX shader bound (shid, type, tokens) */
    this.shader_log = null;
    /** @type {!Array<string>} the first warnings, for test harnesses */
    this.warnings = [];
    /** @type {!Object<number, number>} how often each command came (for the harnesses) */
    this.counts = {};
    /** @type {!Object<number, number>} the batch bytes each command made (for the harnesses) */
    this.bytes = {};
    /** batch bytes sent so far */
    this.bytes_sent = 0;
    /** guest-backed objects (level gb9 and up) */
    this.gb = !!(device.caps & C.SVGA_CAP_GBOBJECTS);
    /** @type {!Map<number, {type: number, size: number, mob: number, offset: number, handle: number, code: Uint8Array}>} GB shaders by shid */
    this.gb_shaders = new Map();
    /** @type {!Map<number, {width: number, height: number, x: number, y: number, flags: number, dpi: number, image: Array<number>}>} screen targets */
    this.targets = new Map();
    /** @type {?{mob: number, maps: !Map<number, number>}} the GART: its MOB, and MOBs by page offset */
    this.gart = null;
    /** @type {DXDevice} DX contexts (level dx10 and up), drawn by GX */
    this.dx = (device.caps & C.SVGA_CAP_DX) ? new DXDevice(this) : null;
    /** @type {GXWriter} GX batches, for DX and the surfaces it uses */
    this.gxw = null;
    /** the DX context of the command buffer being run */
    this.dx_context = INVALID;
    this.streams();
    renderer.listen(message => this.receive(message));
}

/**
 * The two batch streams, D9WG and GX, go to the renderer in the order they
 * were written: starting to write one sends what the other has
 */
SVGA3D.prototype.streams = function()
{
    // Resource-only work has a device too. Announce it once, before the
    // first command, including after reset/snapshot reconstruction.
    let utility_created = false;
    this.writer.before = () => {
        if(this.gxw && !this.gxw.empty()) this.flush();
        if(!utility_created)
        {
            utility_created = true;
            this.writer.command(OP.CREATE_DEVICE, {
                "device_handle": UTILITY_DEVICE, "width": 1, "height": 1
            });
        }
    };
    if(this.dx)
    {
        this.gxw = new GXWriter();
        this.gxw.before = () => { if(!this.writer.empty()) this.flush(); };
    }
};

/** @return {!GXWriter} */
SVGA3D.prototype.gx_writer = function()
{
    return /** @type {!GXWriter} */ (this.gxw);
};

SVGA3D.prototype.reset = function()
{
    this.writer = new D9WGWriter();
    this.streams();
    if(this.dx) this.dx.reset();
    this.dx_context = INVALID;
    this.surfaces.clear();
    this.duals.clear();
    this.contexts.clear();
    this.declarations.clear();
    this.gb_shaders.clear();
    this.targets.clear();
    this.gart = null;
    this.completions = [];
    this.requests.clear();
    this.completed = this.submitted;
    this.renderer.post({ "type": "reset" });
};

SVGA3D.prototype.warn_once = function(key, text)
{
    if(this.warned.has(key)) return;
    this.warned.add(key);
    if(this.warnings.length < 100) this.warnings.push(text);
    dbg_log("svga3d: " + text, LOG_VGA);
};

// ---------------------------------------------------------------------------
// The FIFO's 3D registers

/**
 * The 3D hardware version and the devcaps record
 * @param {!Int32Array} fifo
 */
SVGA3D.write_fifo_caps = function(fifo)
{
    fifo[C.SVGA_FIFO_3D_HWVERSION] = C.SVGA3D_HWVERSION_WS8_B1;
    fifo[C.SVGA_FIFO_3D_HWVERSION_REVISED] = C.SVGA3D_HWVERSION_WS8_B1;
    let at = C.SVGA_FIFO_3D_CAPS;
    // SVGA3dFifoCapsRecordHeader: length in dwords with itself, type
    fifo[at] = 2 + 2 * VGPU9_DEVCAPS.length;
    fifo[at + 1] = C.SVGA3D_FIFO_CAPS_RECORD_DEVCAPS;
    at += 2;
    for(const [index, value] of VGPU9_DEVCAPS)
    {
        fifo[at++] = index;
        fifo[at++] = value;
    }
    // a record of length 0 ends the list
    fifo[at] = 0;
};

// ---------------------------------------------------------------------------
// Batches and completion

/** @return {boolean} whether something sent to the renderer has not run yet */
SVGA3D.prototype.busy = function()
{
    return !this.writer.empty() || !!this.gxw && !this.gxw.empty() || this.submitted > this.completed;
};

/**
 * Send the batch being written (of either stream; one is empty)
 */
SVGA3D.prototype.flush = function()
{
    if(!this.writer.empty())
    {
        this.bytes_sent += this.writer.size();
        const bytes = this.writer.finish(++this.frame, 0);
        const seq = ++this.submitted;
        this.renderer.post({ "type": "submit", "seq": seq, "bytes": bytes }, [bytes.buffer]);
    }
    if(this.gxw && !this.gxw.empty())
    {
        this.bytes_sent += this.gxw.size();
        const bytes = this.gxw.finish();
        const seq = ++this.submitted;
        this.renderer.post({ "type": "submit", "seq": seq, "bytes": bytes, "stream": "gx" }, [bytes.buffer]);
    }
};

/** Send the batch being written if it is big */
SVGA3D.prototype.flush_big = function()
{
    if(this.writer.size() > BATCH_FLUSH_BYTES || this.gxw && this.gxw.size() > BATCH_FLUSH_BYTES) this.flush();
};

/**
 * A request for an answer from the renderer (a query result, a readback)
 * @param {function(Uint8Array, number)} answer
 * @return {{id: number, slot: number}} its id, and its query slot
 */
SVGA3D.prototype.request = function(answer)
{
    const id = this.next_request++;
    this.requests.set(id, answer);
    return { id, slot: id % QUERY_SLOTS * QUERY_SLOT_BYTES };
};

/**
 * Run `run` once everything sent so far has run (now, if it has)
 * @param {function()} run
 */
SVGA3D.prototype.after_work = function(run)
{
    this.flush();
    if(this.submitted > this.completed)
    {
        this.completions.push({ seq: this.submitted, run });
    }
    else
    {
        run();
    }
};

/**
 * @param {!Object} message from the renderer
 */
SVGA3D.prototype.receive = function(message)
{
    switch(message["type"])
    {
        case "write":
            this.answer(message["offset"], message["bytes"]);
            break;
        case "done":
            this.completed = Math.max(this.completed, message["seq"]);
            while(this.completions.length && this.completions[0].seq <= this.completed)
            {
                this.completions.shift().run();
            }
            break;
        case "lost":
            // The renderer is gone: tell the driver, and let nothing wait
            dbg_log("svga3d: the renderer was lost: " + message["reason"], LOG_VGA);
            this.device.set_irq(C.SVGA_IRQFLAG_ERROR);
            this.completed = this.submitted;
            for(const request of this.requests.values()) request(null, 0);
            this.requests.clear();
            while(this.completions.length) this.completions.shift().run();
            break;
    }
};

/**
 * A write into the response region: a query result or a readback
 * @param {number} offset from the start of the response region
 * @param {!Uint8Array} bytes
 */
SVGA3D.prototype.answer = function(offset, bytes)
{
    if(bytes.length < 16) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id = view.getUint32(0, true), status = view.getUint32(12, true);
    const request = this.requests.get(id);
    if(!request) return;
    this.requests.delete(id);
    if(offset < QUERY_REGION_BYTES)
    {
        // D9WGQueryResponse: request id, value (64 bits), status
        request(bytes.subarray(4, 12), status);
    }
    else
    {
        // D9WGReadbackResponse: request id, byte count, reserved, status, bytes
        const count = view.getUint32(4, true);
        request(status === RESPONSE_OK ? bytes.subarray(READBACK_HEADER_BYTES, READBACK_HEADER_BYTES + count) : null, status);
    }
};

// ---------------------------------------------------------------------------
// Commands

/**
 * One 3D command
 * @param {number} id SVGA_3D_CMD_*
 * @param {!Int32Array} p its body, after SVGA3dCmdHeader
 */
SVGA3D.prototype.command = function(id, p)
{
    const before = this.bytes_written();
    this.run_command(id, p);
    this.bytes[id] = (this.bytes[id] || 0) + this.bytes_written() - before;
};

/** @return {number} batch bytes written so far (sent, and being written) */
SVGA3D.prototype.bytes_written = function()
{
    return this.bytes_sent + this.writer.size() + (this.gxw ? this.gxw.size() : 0);
};

/**
 * @param {number} id SVGA_3D_CMD_*
 * @param {!Int32Array} p its body, after SVGA3dCmdHeader
 */
SVGA3D.prototype.run_command = function(id, p)
{
    const f = new Float32Array(p.buffer, p.byteOffset, p.length);
    this.counts[id] = (this.counts[id] || 0) + 1;
    if(this.command_log) this.command_log(id, p);
    if(this.dx && this.dx.command(id, p, this.dx_context))
    {
        this.flush_big();
        return;
    }
    this.record(id, p);
    switch(id)
    {
        case C.SVGA_3D_CMD_SURFACE_DEFINE: this.define_surface(p, false); break;
        case C.SVGA_3D_CMD_SURFACE_DEFINE_V2: this.define_surface(p, true); break;
        case C.SVGA_3D_CMD_SURFACE_DESTROY: if(p.length >= 1) this.destroy_surface(p[0] >>> 0); break;
        case C.SVGA_3D_CMD_SURFACE_DMA: this.surface_dma(p); break;
        case C.SVGA_3D_CMD_SURFACE_COPY: this.surface_copy(p); break;
        case C.SVGA_3D_CMD_SURFACE_STRETCHBLT: this.surface_stretch(p); break;
        case C.SVGA_3D_CMD_CONTEXT_DEFINE: if(p.length >= 1) this.define_context(p[0] >>> 0); break;
        case C.SVGA_3D_CMD_CONTEXT_DESTROY: if(p.length >= 1) this.destroy_context(p[0] >>> 0); break;
        case C.SVGA_3D_CMD_SETTRANSFORM: this.set_transform(p, f); break;
        case C.SVGA_3D_CMD_SETZRANGE: this.set_zrange(p, f); break;
        case C.SVGA_3D_CMD_SETRENDERSTATE: this.set_render_states(p, f); break;
        case C.SVGA_3D_CMD_SETRENDERTARGET: this.set_render_target(p); break;
        case C.SVGA_3D_CMD_SETTEXTURESTATE: this.set_texture_states(p, f); break;
        case C.SVGA_3D_CMD_SETMATERIAL: this.set_material(p, f); break;
        case C.SVGA_3D_CMD_SETLIGHTDATA: this.set_light(p, f); break;
        case C.SVGA_3D_CMD_SETLIGHTENABLED: this.set_light_enabled(p); break;
        case C.SVGA_3D_CMD_SETVIEWPORT: this.set_viewport(p); break;
        case C.SVGA_3D_CMD_SETCLIPPLANE: this.set_clip_plane(p, f); break;
        case C.SVGA_3D_CMD_CLEAR: this.clear(p, f); break;
        case C.SVGA_3D_CMD_PRESENT: this.present(p); break;
        case C.SVGA_3D_CMD_SHADER_DEFINE: this.define_shader(p); break;
        case C.SVGA_3D_CMD_SHADER_DESTROY: this.destroy_shader(p); break;
        case C.SVGA_3D_CMD_SET_SHADER: this.set_shader(p); break;
        case C.SVGA_3D_CMD_SET_SHADER_CONST: this.set_shader_const(p); break;
        case C.SVGA_3D_CMD_DRAW_PRIMITIVES: this.draw_primitives(p); break;
        case C.SVGA_3D_CMD_SETSCISSORRECT: this.set_scissor(p); break;
        case C.SVGA_3D_CMD_BEGIN_QUERY: this.begin_query(p); break;
        case C.SVGA_3D_CMD_END_QUERY: this.end_query(p, this.device.gmrs); break;
        case C.SVGA_3D_CMD_WAIT_FOR_QUERY:
            // the result is written when it is known; the driver polls it
            break;
        case C.SVGA_3D_CMD_BLIT_SURFACE_TO_SCREEN: this.blit_surface_to_screen(p); break;
        case C.SVGA_3D_CMD_GENERATE_MIPMAPS: this.generate_mipmaps(p); break;
        case C.SVGA_3D_CMD_ACTIVATE_SURFACE:
        case C.SVGA_3D_CMD_DEACTIVATE_SURFACE:
            // residency hints
            break;
        case C.SVGA_3D_CMD_PRESENT_READBACK:
        case C.SVGA_3D_CMD_SCREEN_DMA:
            this.warn_once("cmd" + id, "command " + id + " is not implemented");
            break;
        default:
            if(!(this.gb && this.gb_command(id, p)))
            {
                this.warn_once("cmd" + id, "command " + id + " ignored at level " + this.device.level);
            }
    }
    this.flush_big();
};

/**
 * Keep what a snapshot needs to set a context's state again: per piece of
 * state, the last command (split into one per state where a command sets several)
 * @param {number} id
 * @param {!Int32Array} p
 */
SVGA3D.prototype.record = function(id, p)
{
    if(!p.length) return;
    const context = this.contexts.get(p[0] >>> 0);
    if(!context) return;
    const state = context.state, cid = p[0];
    const keep = (key, body) => state.set(key, [id, body]);
    switch(id)
    {
        case C.SVGA_3D_CMD_SETTRANSFORM: keep("xf" + p[1], p.slice()); break;
        case C.SVGA_3D_CMD_SETZRANGE: keep("zr", p.slice()); break;
        case C.SVGA_3D_CMD_SETRENDERTARGET: keep("rt" + p[1], p.slice()); break;
        case C.SVGA_3D_CMD_SETMATERIAL: keep("mat" + p[1], p.slice()); break;
        case C.SVGA_3D_CMD_SETLIGHTDATA: keep("ld" + p[1], p.slice()); break;
        case C.SVGA_3D_CMD_SETLIGHTENABLED: keep("le" + p[1], p.slice()); break;
        case C.SVGA_3D_CMD_SETVIEWPORT: keep("vp", p.slice()); break;
        case C.SVGA_3D_CMD_SETCLIPPLANE: keep("cp" + p[1], p.slice()); break;
        case C.SVGA_3D_CMD_SETSCISSORRECT: keep("sc", p.slice()); break;
        case C.SVGA_3D_CMD_SET_SHADER: keep("sh" + p[1], p.slice()); break;
        case C.SVGA_3D_CMD_SETRENDERSTATE:
            for(let at = 1; at + 2 <= p.length; at += 2) keep("rs" + p[at], Int32Array.of(cid, p[at], p[at + 1]));
            break;
        case C.SVGA_3D_CMD_SETTEXTURESTATE:
            for(let at = 1; at + 3 <= p.length; at += 3) keep("ts" + p[at] + ":" + p[at + 1], Int32Array.of(cid, p[at], p[at + 1], p[at + 2]));
            break;
        case C.SVGA_3D_CMD_SET_SHADER_CONST:
            for(let r = 0; 4 + 4 * r + 4 <= p.length; r++)
            {
                const body = Int32Array.of(cid, p[1] + r, p[2], p[3], p[4 + 4 * r], p[5 + 4 * r], p[6 + 4 * r], p[7 + 4 * r]);
                keep("c" + p[2] + ":" + p[3] + ":" + (p[1] + r), body);
            }
            break;
        case C.SVGA_3D_CMD_SHADER_DEFINE:
            if(p.length >= 3) context.shader_definitions.set(p[2] + ":" + (p[1] >>> 0), p.slice());
            break;
        case C.SVGA_3D_CMD_SHADER_DESTROY:
            if(p.length >= 3) context.shader_definitions.delete(p[2] + ":" + (p[1] >>> 0));
            break;
    }
};

// ---------------------------------------------------------------------------
// Snapshots

/**
 * Before a save: the batches sent so far run, and every surface's contents
 * come back from the GPU
 * @return {!Promise<undefined>}
 */
SVGA3D.prototype.prepare_save = function()
{
    for(const surface of this.surfaces.values())
    {
        surface.saved = null;
        if(surface.gb)
        {
            // what the GPU has goes into the MOB, which is guest memory and
            // so in the snapshot; after a restore it comes from there
            if(surface.home && surface.host_newer) this.readback_gb_surface(surface);
            continue;
        }
        // depth and multisampled surfaces cannot be read back: they come back cleared
        if(!surface.handle || surface.info.depth || surface.samples > 1) continue;
        const saved = surface.saved = [];
        const volume = surface.kind === KIND.TEXTURE_VOLUME;
        for(let face = 0; face < surface.faces; face++)
        {
            for(let mip = 0; mip < surface.sizes.length; mip++)
            {
                const level = level_layout(surface, mip);
                const layers = volume ? level.depth : 1;
                const bytes = new Uint8Array(level.pitch * level.rows * layers);
                saved.push(bytes);
                for(let layer = 0; layer < layers; layer++)
                {
                    const base = layer * level.pitch * level.rows;
                    this.read_rows(surface, volume ? layer : face, mip, 0, level.rows, (data, first, count, pitch) => {
                        bytes.set(data.subarray(0, count * pitch), base + first * pitch);
                    });
                }
            }
        }
    }
    return new Promise(resolve => this.after_work(resolve));
};

SVGA3D.prototype.get_state = function()
{
    const surfaces = [];
    for(const s of this.surfaces.values())
    {
        surfaces.push([s.definition_id, s.definition, s.data, s.saved || [], s.mob, s.mob_pitch]);
    }
    const contexts = [];
    for(const c of this.contexts.values())
    {
        contexts.push([c.cid, [...c.shader_definitions.values()], [...c.state.values()].map(([id, body]) => [id, body]),
            c.mob === undefined ? null : c.mob]);
    }
    // GB shaders keep their bytecode: the MOB it came from may have changed since
    const shaders = [];
    for(const [shid, sh] of this.gb_shaders)
    {
        shaders.push([shid, sh.type, sh.size, sh.mob, sh.offset, sh.code || null]);
    }
    const targets = [];
    for(const [stid, t] of this.targets) targets.push([stid, t.width, t.height, t.x, t.y, t.flags, t.dpi, t.image]);
    return [3, surfaces, contexts, shaders, targets, this.dx ? this.dx.get_state() : null];
};

/**
 * Make the GPU's objects again, in a fresh renderer
 */
SVGA3D.prototype.set_state = function(state)
{
    this.reset();
    if(!state || state[0] < 1 || state[0] > 3) return;
    for(const [id, definition, data, saved, mob, mob_pitch] of state[1])
    {
        const body = Int32Array.from(definition);
        this.command(id, body);
        const surface = this.surfaces.get(body[0] >>> 0);
        if(!surface) continue;
        if(mob !== undefined)
        {
            surface.mob = mob;
            surface.mob_pitch = mob_pitch;
        }
        if(surface.data && data) surface.data.set(data);
        if(!surface.handle || !saved.length) continue;
        const volume = surface.kind === KIND.TEXTURE_VOLUME;
        let i = 0;
        for(let face = 0; face < surface.faces; face++)
        {
            for(let mip = 0; mip < surface.sizes.length; mip++)
            {
                const bytes = saved[i++];
                if(!bytes) continue;
                const level = level_layout(surface, mip);
                const w = this.writer.command(OP.UPDATE_TEXTURE, {
                    "resource_handle": surface.handle, "level": mip, "x": 0,
                    "y": 0, "z": volume ? 0 : surface.kind === KIND.TEXTURE_CUBE ? face : 0, "width": level.width,
                    "height": level.height, "depth": volume ? level.depth : 1, "row_pitch": level.pitch,
                    "slice_pitch": level.pitch * level.rows, "data_bytes": bytes.length
                });
                w.patch_field("data_offset", w.data(bytes));
                if(this.writer.size() > BATCH_FLUSH_BYTES) this.flush();
            }
        }
    }
    if(state[0] >= 2)
    {
        for(const [shid, type, size, mob, offset, code] of state[3])
        {
            this.gb_shaders.set(shid, { type, size, mob, offset, handle: 0, code: null });
            if(code) this.create_gb_shader(this.gb_shaders.get(shid), new Uint8Array(code));
        }
        for(const [stid, width, height, x, y, flags, dpi, image] of state[4])
        {
            // (the screens keep their pictures themselves)
            this.targets.set(stid, { width, height, x, y, flags, dpi, image: image && Array.from(image) });
        }
    }
    for(const [cid, shaders, entries, mob] of state[2])
    {
        this.command(C.SVGA_3D_CMD_CONTEXT_DEFINE, Int32Array.of(cid));
        if(mob !== null && mob !== undefined) this.contexts.get(cid).mob = mob;
        for(const body of shaders) this.command(C.SVGA_3D_CMD_SHADER_DEFINE, Int32Array.from(body));
        for(const [id, body] of entries) this.command(id, Int32Array.from(body));
    }
    if(state[0] >= 3 && this.dx) this.dx.set_state(state[5]);
    this.flush();
};

/**
 * An object in a table the driver set up again (SET_OTABLE_BASE with valid
 * entries, after a reset): defined again from its entry
 * @param {!Uint32Array} e the entry
 */
SVGA3D.prototype.load_entry = function(type, index, e)
{
    switch(type)
    {
        case C.SVGA_OTABLE_SURFACE:
        {
            // as DEFINE_GB_SURFACE_V4, then its image from the MOB
            this.define_gb_surface(Int32Array.of(index, e[1], e[11], e[0], e[2], e[3], e[12] & 0xFF, e[12] >>> 8 & 0xFF,
                e[4], e[5], e[6], e[7], e[9], e[12] >>> 16), 4);
            const surface = this.surfaces.get(index);
            if(surface && e[8] !== INVALID)
            {
                this.bind_gb_surface(surface, e[8], e[10]);
                this.update_gb_surface(surface);
            }
            break;
        }
        case C.SVGA_OTABLE_CONTEXT:
            this.define_gb_context(e[0]);
            this.bind_gb_context(e[0], e[1], 0);
            break;
        case C.SVGA_OTABLE_SHADER:
            this.define_gb_shader(index, e[0], e[1]);
            this.bind_gb_shader(index, e[3], e[2]);
            break;
        case C.SVGA_OTABLE_SCREENTARGET:
            this.define_screen_target(index, e[3], e[4], e[5] | 0, e[6] | 0, e[7], e[8]);
            if(e[0] !== INVALID) this.bind_screen_target(index, e[0], e[1], e[2]);
            break;
    }
};

// ---------------------------------------------------------------------------
// Surfaces

/**
 * SURFACE_DEFINE(_V2): sid, flags, format, face[6].numMipLevels
 * (V2: multisampleCount, autogenFilter), then an SVGA3dSize per mip of each face
 */
SVGA3D.prototype.define_surface = function(p, v2)
{
    const head = v2 ? 11 : 9;
    if(p.length < head) return;
    const sid = p[0] >>> 0, flags = p[1] >>> 0, format = p[2] >>> 0;
    const mips = p[3] >>> 0;
    let faces = 0;
    for(let i = 0; i < 6; i++) if(p[3 + i]) faces++;
    const samples = v2 ? p[9] >>> 0 : 0;
    if(!mips || !faces || p.length < head + 3 * mips * faces)
    {
        this.warn_once("define", "a surface definition without sizes");
        return;
    }
    const sizes = [];
    for(let i = 0; i < mips; i++)
    {
        const at = head + 3 * i;
        sizes.push([p[at] >>> 0, p[at + 1] >>> 0, Math.max(1, p[at + 2] >>> 0)]);
    }
    const surface = this.create_surface(sid, flags, format, faces, sizes, samples, false);
    surface.definition = p.slice();
    surface.definition_id = v2 ? C.SVGA_3D_CMD_SURFACE_DEFINE_V2 : C.SVGA_3D_CMD_SURFACE_DEFINE;
};

/**
 * A surface and its D9WG resource (a buffer gets its resources as draws use it)
 * @param {!Array<!Array<number>>} sizes [width, height, depth] of each mip level
 * @return {!Surface}
 */
SVGA3D.prototype.create_surface = function(sid, flags, format, faces, sizes, samples, lazy)
{
    if(this.surfaces.has(sid)) this.destroy_surface(sid);
    const surface = new Surface(sid, flags, format, faces, sizes, samples);
    this.surfaces.set(sid, surface);
    // a legacy surface lives in D9WG from the start; a GB one where it is used first
    if(!lazy) this.make_d9wg(surface);
    return surface;
};

/**
 * The D9WG resource of a surface (a buffer: its bytes here; its D9WG buffers
 * are made as draws use it)
 */
SVGA3D.prototype.make_d9wg = function(surface)
{
    const info = surface.info, flags = surface.flags, sizes = surface.sizes, faces = surface.faces;
    const mips = sizes.length, samples = surface.samples;
    // (the caller copies what GX has, if it has the newest contents)
    const fill = !surface.home;
    if(fill) surface.home = "d9wg";
    surface.in_d9 = true;
    if(!info)
    {
        this.warn_once("format" + surface.format, "surface format " + surface.format + " is not supported by legacy 3D");
        return;
    }
    const [width, height, depth] = sizes[0];
    if(!info.d3d)
    {
        surface.data = new Uint8Array(width * height * depth);
        if(fill && surface.gb && surface.mob !== INVALID)
        {
            const bytes = this.device.mobs.read(surface.mob, 0, surface.data.length);
            if(bytes) surface.data.set(bytes);
        }
        return;
    }

    const handle = surface.handle = this.next_handle++;
    const w = this.writer;
    let usage = 0;
    if(info.depth) usage |= D3DUSAGE_DEPTHSTENCIL;
    else if(info.target && info.block === 1) usage |= D3DUSAGE_RENDERTARGET;
    if(flags & C.SVGA3D_SURFACE_AUTOGENMIPMAPS) usage |= D3DUSAGE_AUTOGENMIPMAP;
    if(faces === 6 && (flags & C.SVGA3D_SURFACE_CUBEMAP))
    {
        surface.kind = KIND.TEXTURE_CUBE;
        w.command(OP.CREATE_TEXTURE_CUBE, {
            "device_handle": UTILITY_DEVICE, "resource_handle": handle, "edge_length": width,
            "level_count": mips, "format": info.d3d, "usage": usage,
            "pool": 0, "reserved": 0
        });
    }
    else if(depth > 1 || (flags & C.SVGA3D_SURFACE_VOLUME))
    {
        surface.kind = KIND.TEXTURE_VOLUME;
        w.command(OP.CREATE_TEXTURE_VOLUME, {
            "device_handle": UTILITY_DEVICE, "resource_handle": handle, "width": width,
            "height": height, "depth": depth, "level_count": mips,
            "format": info.d3d, "usage": usage, "pool": 0,
            "reserved": 0
        });
    }
    else
    {
        surface.kind = KIND.TEXTURE_2D;
        // D3DMULTISAMPLE_n_SAMPLES is n
        w.command(OP.CREATE_TEXTURE_2D, {
            "device_handle": UTILITY_DEVICE, "resource_handle": handle, "width": width,
            "height": height, "level_count": mips, "format": info.d3d,
            "usage": usage, "pool": 0, "multisample_type": samples > 1 ? samples : 0,
            "multisample_quality": 0
        });
    }
    // a GB surface brings what its MOB has
    if(fill && surface.gb && surface.mob !== INVALID && !surface.host_newer) this.update_gb_surface(surface);
};

/**
 * A surface's D9WG handle, made the first time legacy 3D uses it, with the
 * newest contents (copied on the GPU from GX if DX has them)
 * @param {boolean=} write whether legacy 3D will change it
 * @return {number} 0 if it has none (a buffer, or no D3D9 format)
 */
SVGA3D.prototype.d9 = function(surface, write)
{
    const made = !surface.in_d9;
    if(made)
    {
        this.make_d9wg(surface);
        if(surface.in_gx) this.duals.add(surface);
    }
    if(surface.home === "gx")
    {
        if(surface.buffer)
        {
            // (its bytes would have to come back from the GPU first)
            this.warn_once("homes", "a buffer written by DX is read by legacy 3D");
            return 0;
        }
        if((made || surface.stale) && surface.handle) this.gxw.command(GX.SURFACE_EXPORT, [surface.sid, surface.handle]);
        surface.home = "d9wg";
        surface.stale = false;
    }
    if(write && surface.in_gx) surface.stale = true;
    return surface.handle;
};

/**
 * Before a legacy draw or clear: surfaces DX changed since come over, and the
 * bound targets are written
 */
SVGA3D.prototype.drawing = function(context)
{
    if(!this.duals.size) return;
    for(const surface of this.duals) if(surface.home === "gx" && surface.stale) this.d9(surface);
    for(const surface of context.targets.values())
    {
        if(surface.in_gx && this.surfaces.get(surface.sid) === surface) this.d9(surface, true);
    }
};

/**
 * Make a surface in GX the first time DX (or a copy into a DX surface) uses
 * it, with the newest contents (copied on the GPU from D9WG if legacy 3D has them)
 * @param {boolean=} write whether DX will change it
 */
SVGA3D.prototype.gx_surface = function(surface, write)
{
    if(!this.gxw) return;
    const made = !surface.in_gx;
    if(made)
    {
        const [width, height, depth] = surface.sizes[0];
        const g = surface.gb;
        const cube = !!(surface.flags & C.SVGA3D_SURFACE_CUBEMAP);
        const layers = g ? g.layers : surface.faces;
        this.gxw.command(GX.SURFACE_DEFINE, [surface.sid, surface.format, surface.flags, g ? g.flags2 : 0,
            width, height, depth, surface.sizes.length, layers, surface.samples, cube ? 1 : 0]);
        surface.in_gx = true;
        if(surface.in_d9) this.duals.add(surface);
        if(!surface.home)
        {
            surface.home = "gx";
            if(surface.gb && surface.mob !== INVALID && !surface.host_newer) this.update_gb_surface(surface);
        }
    }
    if(surface.home === "d9wg")
    {
        if(made || surface.stale)
        {
            // a buffer's bytes are here; a texture is copied on the GPU
            if(surface.data) this.gxw.command(GX.SURFACE_UPLOAD, [surface.sid, 0, 0, 0, 0, 0,
                surface.data.length, 1, 1, surface.data.length, surface.data.length], surface.data);
            else if(surface.handle) this.gxw.command(GX.SURFACE_IMPORT, [surface.sid, surface.handle]);
        }
        surface.home = "gx";
        surface.stale = false;
    }
    if(write && surface.in_d9) surface.stale = true;
};

/**
 * Bytes for a box of an image, in its home: D9WG or GX. Rows are packed:
 * `pitch` bytes each, `rows` rows per slice.
 */
SVGA3D.prototype.upload = function(surface, layer, mip, x, y, z, w, h, d, pitch, rows, data)
{
    if(surface.in_d9 && surface.in_gx) surface.stale = true;
    if(surface.home === "gx")
    {
        this.gxw.command(GX.SURFACE_UPLOAD, [surface.sid, layer, mip, x, y, z, w, h, d, pitch, pitch * rows], data);
        return;
    }
    if(surface.buffer && surface.data)
    {
        surface.data.set(data.subarray(0, Math.min(data.length, surface.data.length - x)), x);
        for(const handle of surface.roles) if(handle) this.update_buffer(handle, x, data);
        return;
    }
    if(!surface.handle) return;
    const wr = this.writer.command(OP.UPDATE_TEXTURE, {
        "resource_handle": surface.handle, "level": mip, "x": x,
        "y": y, "z": surface.kind === KIND.TEXTURE_VOLUME ? z : layer, "width": w,
        "height": h, "depth": d, "row_pitch": pitch,
        "slice_pitch": pitch * rows, "data_bytes": data.length
    });
    wr.patch_field("data_offset", wr.data(data));
};

SVGA3D.prototype.destroy_surface = function(sid)
{
    const surface = this.surfaces.get(sid);
    if(!surface) return;
    this.surfaces.delete(sid);
    this.duals.delete(surface);
    if(surface.in_gx) this.gxw.command(GX.SURFACE_DESTROY, [sid]);
    if(!surface.in_d9) return;
    const w = this.writer;
    if(surface.handle) w.command(OP.DESTROY_RESOURCE, {
        "resource_handle": surface.handle, "resource_kind": surface.kind
    });
    for(let role = 0; role < 3; role++)
    {
        if(surface.roles[role]) w.command(OP.DESTROY_RESOURCE, {
            "resource_handle": surface.roles[role], "resource_kind": role === ROLE_VERTEX ? KIND.BUFFER_VERTEX : KIND.BUFFER_INDEX
        });
    }
};

/**
 * The D9WG buffer of a buffer surface in a role, made (and filled) the first time
 * @return {number} 0 if the surface is not a buffer
 */
SVGA3D.prototype.buffer_role = function(surface, role)
{
    this.d9(surface);
    if(!surface.data || surface.home !== "d9wg") return 0;
    if(surface.roles[role]) return surface.roles[role];
    const handle = surface.roles[role] = this.next_handle++;
    const w = this.writer;
    const index = role !== ROLE_VERTEX;
    w.command(OP.CREATE_BUFFER, {
        "device_handle": UTILITY_DEVICE, "resource_handle": handle, "resource_kind": index ? KIND.BUFFER_INDEX : KIND.BUFFER_VERTEX,
        "byte_count": surface.data.length, "usage": D3DUSAGE_DYNAMIC, "fvf": role === ROLE_INDEX16 ? D3DFMT.INDEX16 : role === ROLE_INDEX32 ? D3DFMT.INDEX32 : 0,
        "pool": 0, "reserved": 0
    });
    this.update_buffer(handle, 0, surface.data);
    return handle;
};

SVGA3D.prototype.update_buffer = function(handle, offset, bytes)
{
    const w = this.writer.command(OP.UPDATE_BUFFER, {
        "resource_handle": handle, "destination_offset": offset, "byte_count": bytes.length
    });
    w.patch_field("data_offset", w.data(bytes));
};

/**
 * The size of a mip level in blocks, and its bytes per row
 */
function level_layout(surface, mip)
{
    const [width, height, depth] = surface.sizes[mip];
    const { block, block_h, bytes } = surface.layout;
    const columns = Math.ceil(width / block), rows = Math.ceil(height / block_h);
    return { width, height, depth, columns, rows, pitch: columns * bytes };
}

/**
 * SURFACE_DMA: guest image (gmrId, offset, pitch), host image (sid, face,
 * mipmap), transfer, then SVGA3dCopyBox[] and maybe SVGA3dCmdSurfaceDMASuffix
 */
SVGA3D.prototype.surface_dma = function(p)
{
    if(p.length < 7) return;
    const gmr = p[0] >>> 0, offset = p[1] >>> 0, pitch = p[2] >>> 0;
    const surface = this.surfaces.get(p[3] >>> 0);
    const face = p[4] >>> 0, mip = p[5] >>> 0, transfer = p[6] >>> 0;
    if(!surface || mip >= surface.sizes.length) return;
    if(!surface.home)
    {
        if(this.dx) this.gx_surface(surface);
        else this.d9(surface);
    }
    let rest = p.length - 7;
    // the suffix, if there is one, ends the command and says its own size
    if(rest % 9 === 3 && (p[p.length - 3] >>> 0) === 12) rest -= 3;
    const boxes = Math.floor(rest / 9);
    for(let i = 0; i < boxes; i++)
    {
        const b = 7 + 9 * i;
        const box = [p[b] >>> 0, p[b + 1] >>> 0, p[b + 2] >>> 0, p[b + 3] >>> 0, p[b + 4] >>> 0, p[b + 5] >>> 0,
            p[b + 6] >>> 0, p[b + 7] >>> 0, p[b + 8] >>> 0];
        const gmrs = this.device.gmrs;
        if(transfer === C.SVGA3D_WRITE_HOST_VRAM) this.dma_to_host(surface, face, mip, gmrs, gmr, offset, pitch, box);
        else if(transfer === C.SVGA3D_READ_HOST_VRAM) this.dma_to_guest(surface, face, mip, gmrs, gmr, offset, pitch, box);
    }
};

/**
 * One box from guest memory (a GMR or a MOB) into a surface
 * @param {{read: function(number, number, number):Uint8Array, write: function(number, number, !Uint8Array):boolean}} gmrs
 *     the GMRs or the MOBs
 * @param {!Array<number>} box x, y, z, w, h, d (host), srcx, srcy, srcz (guest)
 */
SVGA3D.prototype.dma_to_host = function(surface, face, mip, gmrs, gmr, offset, pitch, box)
{
    let [x, y, z, w, h, d, sx, sy, sz] = box;
    // a GB surface not on the GPU yet: its MOB is where its contents are
    if(!surface.home) return;
    if(surface.buffer)
    {
        // a buffer: bytes x..x+w from the guest's srcx
        w = Math.min(w, buffer_bytes(surface) - x);
        if(w <= 0) return;
        const bytes = gmrs.read(gmr, offset + sx, w);
        if(!bytes) return this.warn_once("dma-gmr", "SURFACE_DMA outside of its GMR");
        this.upload(surface, 0, 0, x, 0, 0, w, 1, 1, w, 1, bytes);
        return;
    }
    if(surface.home === "d9wg")
    {
        if(!surface.handle) return;
        if(surface.info.depth) return this.warn_once("dma-depth", "SURFACE_DMA into a depth surface is not supported");
    }
    const level = level_layout(surface, mip);
    const { block, block_h, bytes: bytes_per } = surface.layout;
    const volume = is_volume(surface);
    x = Math.min(x, level.width); y = Math.min(y, level.height);
    w = Math.min(w, level.width - x); h = Math.min(h, level.height - y);
    if(volume) d = Math.min(d, level.depth - z);
    else { z = 0; d = 1; sz = 0; }
    if(w <= 0 || h <= 0 || d <= 0) return;
    // in blocks
    const bx = Math.floor(x / block), by = Math.floor(y / block_h);
    const columns = Math.ceil((x + w) / block) - bx, rows = Math.ceil((y + h) / block_h) - by;
    const row_bytes = columns * bytes_per;
    const guest_slice = pitch * level.rows;
    const data = new Uint8Array(row_bytes * rows * d);
    for(let slice = 0; slice < d; slice++)
    {
        const start = offset + (sz + slice) * guest_slice + Math.floor(sy / block_h) * pitch + Math.floor(sx / block) * bytes_per;
        const span = gmrs.read(gmr, start, (rows - 1) * pitch + row_bytes);
        if(!span) return this.warn_once("dma-gmr", "SURFACE_DMA outside of its GMR");
        for(let row = 0; row < rows; row++)
        {
            data.set(span.subarray(row * pitch, row * pitch + row_bytes), (slice * rows + row) * row_bytes);
        }
    }
    this.upload(surface, volume ? 0 : face, mip, bx * block, by * block_h, z, w, h, d, row_bytes, rows, data);
};

/** The bytes of a buffer surface */
function buffer_bytes(surface)
{
    const [width, height, depth] = surface.sizes[0];
    return width * height * depth;
}

/** Whether a surface is a volume: its slices are in its levels, not its layers */
function is_volume(surface)
{
    return surface.sizes[0][2] > 1 || !!(surface.flags & C.SVGA3D_SURFACE_VOLUME);
}

/**
 * One box from a surface into guest memory (a GMR or a MOB)
 * @param {{read: function(number, number, number):Uint8Array, write: function(number, number, !Uint8Array):boolean}} gmrs
 */
SVGA3D.prototype.dma_to_guest = function(surface, face, mip, gmrs, gmr, offset, pitch, box)
{
    let [x, y, z, w, h, d, sx, sy, sz] = box;
    // a GB surface not on the GPU: its MOB already has it all
    if(!surface.home) return;
    if(surface.buffer)
    {
        w = Math.min(w, buffer_bytes(surface) - x);
        if(w <= 0) return;
        if(surface.data)
        {
            // legacy buffers only change through DMA: their bytes are here
            gmrs.write(gmr, offset + sx, surface.data.subarray(x, x + w));
            return;
        }
        const request = this.request((bytes, status) => {
            if(bytes) gmrs.write(gmr, offset + sx, bytes.subarray(0, w));
        });
        this.gxw.command(GX.SURFACE_READBACK, [surface.sid, 0, 0, x, 0, 0, w, 1, 1, request.id]);
        return;
    }
    if(surface.home === "d9wg" && (!surface.handle || surface.info.depth)) return;
    const level = level_layout(surface, mip);
    const { block, block_h, bytes: bytes_per } = surface.layout;
    const volume = is_volume(surface);
    w = Math.min(w, level.width - x); h = Math.min(h, level.height - y);
    if(!volume) { d = 1; sz = 0; z = face; }
    if(w <= 0 || h <= 0) return;
    const bx = Math.floor(x / block), by = Math.floor(y / block_h);
    const columns = Math.ceil((x + w) / block) - bx, rows = Math.ceil((y + h) / block_h) - by;
    const guest_slice = pitch * level.rows;
    for(let slice = 0; slice < d; slice++)
    {
        const layer = volume ? z + slice : z;
        const guest = offset + (sz + slice) * guest_slice + Math.floor(sy / block_h) * pitch + Math.floor(sx / block) * bytes_per;
        this.read_rows(surface, layer, mip, by, rows, (data, first, count, data_pitch) => {
            for(let row = 0; row < count; row++)
            {
                const from = row * data_pitch + bx * bytes_per;
                gmrs.write(gmr, guest + (first - by + row) * pitch, data.subarray(from, from + columns * bytes_per));
            }
        });
    }
};

/**
 * Read rows (of blocks) of a mip level of a layer (a face or array element;
 * a slice of a volume) from where the surface is: the GPU, in pieces that fit
 * the response region, or its MOB; `done` gets each piece as it arrives
 * @param {function(!Uint8Array, number, number, number, number)} done (bytes,
 *     first row, rows, pitch, first column the bytes start at)
 * @param {number=} x columns x .. x + w only, where the GPU has the surface
 *     (GX; uncompressed formats), else whole rows
 * @param {number=} w
 */
SVGA3D.prototype.read_rows = function(surface, layer, mip, first, rows, done, x, w)
{
    const level = level_layout(surface, mip);
    const block_h = surface.layout.block_h;
    // (part of the rows: GX reads back a box)
    const part = surface.home === "gx" && block_h === 1 && surface.layout.block === 1 && w !== undefined && w > 0 && w < level.width;
    const x0 = part ? /** @type {number} */ (x) : 0, width = part ? w : level.width, pitch = part ? w * surface.layout.bytes : level.pitch;
    const volume = is_volume(surface);
    if(!surface.home)
    {
        if(surface.mob === INVALID) return;
        const image = this.mob_image(surface, volume ? 0 : layer, mip);
        const start = image.offset + (volume ? layer * image.pitch * level.rows : 0) + first * image.pitch;
        const bytes = this.device.mobs.read(surface.mob, start, rows * image.pitch);
        if(bytes) done(bytes, first, rows, image.pitch, 0);
        return;
    }
    const per_request = Math.max(1, Math.floor(READBACK_MAX_BYTES / pitch));
    for(let row = first; row < first + rows; row += per_request)
    {
        const count = Math.min(per_request, first + rows - row);
        const request = this.request((bytes, status) => {
            if(bytes) done(bytes, row, count, pitch, x0);
        });
        const top = row * block_h, height = Math.min(count * block_h, level.height - row * block_h);
        if(surface.home === "gx")
        {
            this.gxw.command(GX.SURFACE_READBACK, [surface.sid, volume ? 0 : layer, mip, x0, top, volume ? layer : 0,
                width, height, 1, request.id]);
            continue;
        }
        this.writer.command(OP.READBACK_SURFACE, {
            "device_handle": UTILITY_DEVICE, "texture_handle": surface.handle, "level": mip,
            "format": surface.info.d3d, "width": level.width, "height": level.height,
            "first_row": top, "row_count": height, "destination_pitch": level.pitch,
            "destination_bytes": count * level.pitch, "response_offset": QUERY_REGION_BYTES, "request_id": request.id,
            "face": layer
        });
    }
};

/** An SVGA3dSurfaceImageId: its surface */
SVGA3D.prototype.image = function(p, at)
{
    return this.surfaces.get(p[at] >>> 0) || null;
};

/**
 * Where two surfaces meet for a copy: where the destination's contents are
 * (else the source's; GX if neither has any yet, at a DX level). Both get
 * their newest contents there.
 * @return {string}
 */
SVGA3D.prototype.meet = function(src, dst)
{
    const where = dst.home || src.home || (this.dx ? "gx" : "d9wg");
    const home = where === "gx" && this.gxw ? "gx" : "d9wg";
    if(home === "gx")
    {
        this.gx_surface(src);
        this.gx_surface(dst, true);
    }
    else
    {
        this.d9(src);
        this.d9(dst, true);
    }
    return home;
};

/**
 * SURFACE_COPY: src image, dest image, then SVGA3dCopyBox[]
 */
SVGA3D.prototype.surface_copy = function(p)
{
    const src = this.image(p, 0), dst = this.image(p, 3);
    if(!src || !dst || p.length < 6) return;
    if(this.meet(src, dst) === "gx")
    {
        dst.host_newer = true;
        for(let b = 6; b + 9 <= p.length; b += 9)
        {
            // box: x, y, z, w, h, d (destination), srcx, srcy, srcz
            this.gxw.command(GX.SURFACE_COPY, [src.sid, p[1], p[2], p[b + 6], p[b + 7], p[b + 8],
                dst.sid, p[4], p[5], p[b], p[b + 1], p[b + 2], p[b + 3], p[b + 4], p[b + 5]]);
        }
        return;
    }
    for(let b = 6; b + 9 <= p.length; b += 9)
    {
        const x = p[b] >>> 0, y = p[b + 1] >>> 0, w = p[b + 3] >>> 0, h = p[b + 4] >>> 0;
        const sx = p[b + 6] >>> 0, sy = p[b + 7] >>> 0;
        if(src.data && dst.data)
        {
            const count = Math.min(w, src.data.length - sx, dst.data.length - x);
            if(count <= 0) continue;
            dst.data.set(src.data.subarray(sx, sx + count), x);
            for(const handle of dst.roles) if(handle) this.update_buffer(handle, x, dst.data.subarray(x, x + count));
            continue;
        }
        if(!src.handle || !dst.handle) continue;
        this.stretch(src, p[1] >>> 0, p[2] >>> 0, sx, sy, sx + w, sy + h, dst, p[4] >>> 0, p[5] >>> 0, x, y, x + w, y + h, true);
    }
};

/**
 * SURFACE_STRETCHBLT: src, dest, boxSrc, boxDest (x, y, z, w, h, d), mode
 */
SVGA3D.prototype.surface_stretch = function(p)
{
    const src = this.image(p, 0), dst = this.image(p, 3);
    if(!src || !dst || p.length < 18) return;
    const sx = p[6] >>> 0, sy = p[7] >>> 0, dx = p[12] >>> 0, dy = p[13] >>> 0;
    if(this.meet(src, dst) === "gx")
    {
        dst.host_newer = true;
        this.gxw.command(GX.SURFACE_STRETCH, [src.sid, p[1], p[2], sx, sy, sx + (p[9] >>> 0), sy + (p[10] >>> 0),
            dst.sid, p[4], p[5], dx, dy, dx + (p[15] >>> 0), dy + (p[16] >>> 0), (p[18] >>> 0) === C.SVGA3D_STRETCH_BLT_POINT ? 0 : 1]);
        return;
    }
    if(!src.handle || !dst.handle) return;
    this.stretch(src, p[1] >>> 0, p[2] >>> 0, sx, sy, sx + (p[9] >>> 0), sy + (p[10] >>> 0),
        dst, p[4] >>> 0, p[5] >>> 0, dx, dy, dx + (p[15] >>> 0), dy + (p[16] >>> 0), (p[18] >>> 0) === C.SVGA3D_STRETCH_BLT_POINT);
};

SVGA3D.prototype.stretch = function(src, src_face, src_mip, sl, st, sr, sb, dst, dst_face, dst_mip, dl, dt, dr, db, point)
{
    dst.host_newer = true;
    this.writer.command(OP.STRETCH_RECT, {
        "device_handle": UTILITY_DEVICE, "source_texture_handle": src.handle, "source_level": src_mip,
        "source_left": sl, "source_top": st, "source_right": sr,
        "source_bottom": sb, "destination_texture_handle": dst.handle, "destination_level": dst_mip,
        "destination_left": dl, "destination_top": dt, "destination_right": dr,
        "destination_bottom": db, "filter_point": point ? 1 : 0, "source_face": src_face,
        "destination_face": dst_face
    });
};

/**
 * GENERATE_MIPMAPS: sid, filter
 */
SVGA3D.prototype.generate_mipmaps = function(p)
{
    const surface = this.image(p, 0);
    if(!surface) return;
    if(!this.d9(surface, true)) return;
    surface.host_newer = true;
    this.writer.command(OP.GENERATE_MIPS, {
        "device_handle": UTILITY_DEVICE, "resource_handle": surface.handle
    });
};

// ---------------------------------------------------------------------------
// Contexts and their state

SVGA3D.prototype.define_context = function(cid)
{
    if(this.contexts.has(cid)) this.destroy_context(cid);
    // a new D9WG device: a fresh, default D3D9 state
    const context = new Context(cid, this.next_device++);
    this.contexts.set(cid, context);
    this.writer.command(OP.CREATE_DEVICE, {
        "device_handle": context.device, "width": 1, "height": 1
    });
};

SVGA3D.prototype.destroy_context = function(cid)
{
    const context = this.contexts.get(cid);
    if(!context) return;
    this.contexts.delete(cid);
    for(const [key, handle] of context.shaders)
    {
        this.writer.command(OP.DESTROY_RESOURCE, {
            "resource_handle": handle, "resource_kind": key.startsWith(C.SVGA3D_SHADERTYPE_VS + ":") ? KIND.VERTEX_SHADER : KIND.PIXEL_SHADER
        });
    }
};

/** @return {Context} the context a command names in its first dword */
SVGA3D.prototype.context = function(p)
{
    const context = p.length ? this.contexts.get(p[0] >>> 0) : undefined;
    if(!context) this.warn_once("cid", "a command for an undefined context");
    return context || null;
};

SVGA3D.prototype.set_transform = function(p, f)
{
    const context = this.context(p);
    const state = p.length >= 18 ? d3d_transform(p[1] >>> 0) : -1;
    if(!context || state < 0) return;
    this.writer.command(OP.SET_TRANSFORM, {
        "device_handle": context.device, "state": state, "matrix": f.subarray(2, 18)
    });
};

SVGA3D.prototype.set_zrange = function(p, f)
{
    const context = this.context(p);
    if(!context || p.length < 3) return;
    context.zrange = [f[1], f[2]];
    this.emit_viewport(context);
};

SVGA3D.prototype.set_viewport = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 5) return;
    context.viewport = [p[1] >>> 0, p[2] >>> 0, p[3] >>> 0, p[4] >>> 0];
    this.emit_viewport(context);
};

SVGA3D.prototype.emit_viewport = function(context)
{
    if(!context.viewport) return;
    const [x, y, width, height] = context.viewport;
    this.writer.command(OP.SET_VIEWPORT, {
        "device_handle": context.device, "x": x, "y": y,
        "width": width, "height": height, "min_z": context.zrange[0],
        "max_z": context.zrange[1], "reserved": 0
    });
};

SVGA3D.prototype.set_scissor = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 5) return;
    const x = p[1] | 0, y = p[2] | 0;
    context.scissor = [x, y, x + (p[3] | 0), y + (p[4] | 0)];
    this.emit_scissor(context);
};

SVGA3D.prototype.emit_scissor = function(context)
{
    if(!context.scissor) return;
    const [l, t, r, b] = context.scissor;
    this.writer.command(OP.SET_SCISSOR_RECT, {
        "device_handle": context.device, "left": l, "top": t,
        "right": r, "bottom": b
    });
};

SVGA3D.prototype.render_state = function(context, state, value)
{
    this.writer.command(OP.SET_RENDER_STATE, {
        "device_handle": context.device, "state": state, "value": value,
        "reserved": 0
    });
};

/**
 * SETRENDERSTATE: cid, then SVGA3dRenderState[] (state, value)
 */
SVGA3D.prototype.set_render_states = function(p, f)
{
    const context = this.context(p);
    if(!context) return;
    for(let at = 1; at + 2 <= p.length; at += 2)
    {
        const state = p[at] >>> 0, value = p[at + 1] >>> 0;
        const same = SAME_RENDER_STATES[state];
        if(same !== undefined)
        {
            this.render_state(context, same, value);
            continue;
        }
        switch(state)
        {
            case C.SVGA3D_RS_SRCBLEND: this.render_state(context, D3DRS.SRCBLEND, d3d_blend(value)); break;
            case C.SVGA3D_RS_DSTBLEND: this.render_state(context, D3DRS.DESTBLEND, d3d_blend(value)); break;
            case C.SVGA3D_RS_SRCBLENDALPHA: this.render_state(context, D3DRS.SRCBLENDALPHA, d3d_blend(value)); break;
            case C.SVGA3D_RS_DSTBLENDALPHA: this.render_state(context, D3DRS.DESTBLENDALPHA, d3d_blend(value)); break;
            case C.SVGA3D_RS_FILLMODE:
                // SVGA3dFillMode: mode, face (D3D9 fills both faces alike)
                this.render_state(context, D3DRS.FILLMODE, value & 0xFFFF);
                break;
            case C.SVGA3D_RS_CULLMODE:
                context.cull = value;
                this.emit_cull(context);
                break;
            case C.SVGA3D_RS_FRONTWINDING:
                context.winding = value;
                this.emit_cull(context);
                break;
            case C.SVGA3D_RS_ALPHAREF:
                // a float in [0, 1]; D3D9's is 0..255
                this.render_state(context, D3DRS.ALPHAREF, Math.max(0, Math.min(255, Math.round(f[at + 1] * 255))));
                break;
            case C.SVGA3D_RS_FOGMODE:
            {
                // SVGA3dFogMode: function (16 bits), type, base
                const fn = value & 0xFFFF, type = value >>> 16 & 0xFF, base = value >>> 24 & 0xFF;
                const mode = fn >= C.SVGA3D_FOGFUNC_EXP && fn <= C.SVGA3D_FOGFUNC_LINEAR ? fn : D3DFOG_NONE;
                this.render_state(context, D3DRS.FOGTABLEMODE, type === C.SVGA3D_FOGTYPE_PIXEL ? mode : D3DFOG_NONE);
                this.render_state(context, D3DRS.FOGVERTEXMODE, type === C.SVGA3D_FOGTYPE_VERTEX ? mode : D3DFOG_NONE);
                this.render_state(context, D3DRS.RANGEFOGENABLE, base === C.SVGA3D_FOGBASE_RANGEBASED ? 1 : 0);
                break;
            }
            case C.SVGA3D_RS_RANGEFOGENABLE:
                this.render_state(context, D3DRS.RANGEFOGENABLE, value);
                break;
            case C.SVGA3D_RS_OUTPUTGAMMA:
                // the output's gamma: 2.2 is sRGB
                this.render_state(context, D3DRS.SRGBWRITEENABLE, f[at + 1] > 1.5 ? 1 : 0);
                break;
            default:
                if(state >= C.SVGA3D_RS_WRAP0 && state <= C.SVGA3D_RS_WRAP15)
                {
                    const i = state - C.SVGA3D_RS_WRAP0;
                    this.render_state(context, i < 8 ? D3DRS.WRAP0 + i : D3DRS.WRAP8 + i - 8, value);
                }
                // LINEPATTERN, ZBIAS, ZVISIBLE, COORDINATETYPE, LINEWIDTH,
                // TRANSPARENCYANTIALIAS: nothing in D3D9 or WebGPU
                break;
        }
    }
};

/**
 * CULLMODE says which face is culled, FRONTWINDING which winding is front;
 * D3D9 says which winding is culled
 */
SVGA3D.prototype.emit_cull = function(context)
{
    let cull = D3DCULL_NONE;
    if(context.cull === C.SVGA3D_FACE_FRONT || context.cull === C.SVGA3D_FACE_BACK)
    {
        const front_cw = context.winding !== C.SVGA3D_FRONTWINDING_CCW;
        const cull_cw = (context.cull === C.SVGA3D_FACE_FRONT) === front_cw;
        cull = cull_cw ? D3DCULL_CW : D3DCULL_CCW;
    }
    this.render_state(context, D3DRS.CULLMODE, cull);
};

/**
 * SETRENDERTARGET: cid, type, target (sid, face, mipmap)
 */
SVGA3D.prototype.set_render_target = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 5) return;
    const type = p[1] >>> 0, sid = p[2] >>> 0, face = p[3] >>> 0, mip = p[4] >>> 0;
    const surface = sid === INVALID ? null : this.surfaces.get(sid) || null;
    const handle = surface && this.d9(surface, true) || 0;
    // drawn into from now on: the MOB is behind
    if(surface) surface.host_newer = true;
    if(surface) context.targets.set(type, surface);
    else context.targets.delete(type);
    if(type === C.SVGA3D_RT_DEPTH)
    {
        const size = surface ? surface.sizes[Math.min(mip, surface.sizes.length - 1)] : [0, 0];
        this.writer.command(OP.SET_DEPTH_STENCIL_SURFACE_LEVEL, {
            "device_handle": context.device, "depth_texture_handle": handle, "depth_level": mip,
            "width": size[0], "height": size[1]
        });
    }
    else if(type === C.SVGA3D_RT_STENCIL)
    {
        // the depth surface carries the stencil too
    }
    else if(type >= C.SVGA3D_RT_COLOR0 && type <= C.SVGA3D_RT_COLOR3)
    {
        const index = type - C.SVGA3D_RT_COLOR0;
        this.writer.command(OP.SET_RENDER_TARGET, {
            "device_handle": context.device, "target_index": index, "color_texture_handle": handle,
            "color_level": mip, "color_face": face
        });
        if(index === 0)
        {
            context.target = surface;
            // D3D9 resets the viewport and scissor with target 0; SVGA3D does not
            this.emit_viewport(context);
            this.emit_scissor(context);
        }
    }
};

/**
 * SETTEXTURESTATE: cid, then SVGA3dTextureState[] (stage, name, value)
 */
SVGA3D.prototype.set_texture_states = function(p, f)
{
    const context = this.context(p);
    if(!context) return;
    const w = this.writer, device = context.device;
    const stage_state = (stage, state, value) => {
        if(stage < 8) w.command(OP.SET_TEXTURE_STAGE_STATE, {
            "device_handle": device, "stage": stage, "state": state,
            "value": value
        });
    };
    for(let at = 1; at + 3 <= p.length; at += 3)
    {
        const stage = p[at] >>> 0, name = p[at + 1] >>> 0, value = p[at + 2] >>> 0;
        const sampler = stage < SAMPLERS_PS ? stage : D3DVERTEXTEXTURESAMPLER0 + stage - SAMPLERS_PS;
        const sampler_state = (state, v) => w.command(OP.SET_SAMPLER_STATE, {
            "device_handle": device, "sampler": sampler, "state": state,
            "value": v
        });
        switch(name)
        {
            case C.SVGA3D_TS_BIND_TEXTURE:
            {
                const surface = value === INVALID ? null : this.surfaces.get(value);
                // (first: making its D9WG texture writes commands of its own)
                const handle = surface && this.d9(surface) || 0;
                w.command(OP.SET_TEXTURE, {
                    "device_handle": device, "stage": sampler, "texture_handle": handle,
                    "reserved": 0
                });
                break;
            }
            case C.SVGA3D_TS_COLOROP: stage_state(stage, D3DTSS.COLOROP, TEXTURE_OPS[value] || 1); break;
            case C.SVGA3D_TS_ALPHAOP: stage_state(stage, D3DTSS.ALPHAOP, TEXTURE_OPS[value] || 1); break;
            case C.SVGA3D_TS_COLORARG0: stage_state(stage, D3DTSS.COLORARG0, d3d_texture_argument(value)); break;
            case C.SVGA3D_TS_COLORARG1: stage_state(stage, D3DTSS.COLORARG1, d3d_texture_argument(value)); break;
            case C.SVGA3D_TS_COLORARG2: stage_state(stage, D3DTSS.COLORARG2, d3d_texture_argument(value)); break;
            case C.SVGA3D_TS_ALPHAARG0: stage_state(stage, D3DTSS.ALPHAARG0, d3d_texture_argument(value)); break;
            case C.SVGA3D_TS_ALPHAARG1: stage_state(stage, D3DTSS.ALPHAARG1, d3d_texture_argument(value)); break;
            case C.SVGA3D_TS_ALPHAARG2: stage_state(stage, D3DTSS.ALPHAARG2, d3d_texture_argument(value)); break;
            case C.SVGA3D_TS_BUMPENVMAT00: stage_state(stage, D3DTSS.BUMPENVMAT00, value); break;
            case C.SVGA3D_TS_BUMPENVMAT01: stage_state(stage, D3DTSS.BUMPENVMAT01, value); break;
            case C.SVGA3D_TS_BUMPENVMAT10: stage_state(stage, D3DTSS.BUMPENVMAT10, value); break;
            case C.SVGA3D_TS_BUMPENVMAT11: stage_state(stage, D3DTSS.BUMPENVMAT11, value); break;
            case C.SVGA3D_TS_BUMPENVLSCALE: stage_state(stage, D3DTSS.BUMPENVLSCALE, value); break;
            case C.SVGA3D_TS_BUMPENVLOFFSET: stage_state(stage, D3DTSS.BUMPENVLOFFSET, value); break;
            case C.SVGA3D_TS_CONSTANT: stage_state(stage, D3DTSS.CONSTANT, value); break;
            case C.SVGA3D_TS_TEXTURETRANSFORMFLAGS: stage_state(stage, D3DTSS.TEXTURETRANSFORMFLAGS, d3d_texture_transform_flags(value)); break;
            case C.SVGA3D_TS_TEXCOORDINDEX:
            case C.SVGA3D_TS_TEXCOORDGEN:
                // one D3D9 state: the index, with the generation in its high bits
                if(stage >= SAMPLERS_PS) break;
                if(name === C.SVGA3D_TS_TEXCOORDINDEX) context.texcoord_index[stage] = value;
                else context.texcoord_gen[stage] = value;
                stage_state(stage, D3DTSS.TEXCOORDINDEX, context.texcoord_index[stage] | d3d_texcoord_generation(context.texcoord_gen[stage]));
                break;
            case C.SVGA3D_TS_ADDRESSU: sampler_state(D3DSAMP.ADDRESSU, d3d_address(value)); break;
            case C.SVGA3D_TS_ADDRESSV: sampler_state(D3DSAMP.ADDRESSV, d3d_address(value)); break;
            case C.SVGA3D_TS_ADDRESSW: sampler_state(D3DSAMP.ADDRESSW, d3d_address(value)); break;
            case C.SVGA3D_TS_MIPFILTER: sampler_state(D3DSAMP.MIPFILTER, value); break;
            case C.SVGA3D_TS_MAGFILTER: sampler_state(D3DSAMP.MAGFILTER, value); break;
            case C.SVGA3D_TS_MINFILTER: sampler_state(D3DSAMP.MINFILTER, value); break;
            case C.SVGA3D_TS_BORDERCOLOR: sampler_state(D3DSAMP.BORDERCOLOR, value); break;
            case C.SVGA3D_TS_TEXTURE_MIPMAP_LEVEL: sampler_state(D3DSAMP.MAXMIPLEVEL, value); break;
            case C.SVGA3D_TS_TEXTURE_LOD_BIAS: sampler_state(D3DSAMP.MIPMAPLODBIAS, value); break;
            case C.SVGA3D_TS_TEXTURE_ANISOTROPIC_LEVEL: sampler_state(D3DSAMP.MAXANISOTROPY, value); break;
            case C.SVGA3D_TS_GAMMA:
                // the texture's gamma: 2.2 is sRGB
                sampler_state(D3DSAMP.SRGBTEXTURE, f[at + 2] > 1.5 ? 1 : 0);
                break;
            default:
                // the colour key states: not in D3D9
                break;
        }
    }
};

/**
 * SETMATERIAL: cid, face, SVGA3dMaterial (diffuse, ambient, specular, emissive, shininess)
 */
SVGA3D.prototype.set_material = function(p, f)
{
    const context = this.context(p);
    if(!context || p.length < 19) return;
    // D3D9 has one material, for both faces
    if((p[1] >>> 0) === C.SVGA3D_FACE_BACK) return;
    this.writer.command(OP.SET_MATERIAL, {
        "device_handle": context.device,
        "diffuse": f.subarray(2, 6), "ambient": f.subarray(6, 10),
        "specular": f.subarray(10, 14), "emissive": f.subarray(14, 18), "power": f[18]
    });
};

/**
 * SETLIGHTDATA: cid, index, SVGA3dLightData
 */
SVGA3D.prototype.set_light = function(p, f)
{
    const context = this.context(p);
    if(!context || p.length < 31) return;
    this.writer.command(OP.SET_LIGHT, {
        "device_handle": context.device, "index": p[1] >>> 0, "type": d3d_light_type(p[2] >>> 0),
        "diffuse": f.subarray(4, 8), "specular": f.subarray(8, 12), "ambient": f.subarray(12, 16),
        "position": f.subarray(16, 19), "direction": f.subarray(20, 23), "range": f[24], "falloff": f[25],
        "attenuation": f.subarray(26, 29), "theta": f[29], "phi": f[30]
    });
};

SVGA3D.prototype.set_light_enabled = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 3) return;
    this.writer.command(OP.LIGHT_ENABLE, {
        "device_handle": context.device, "index": p[1] >>> 0, "enable": p[2] ? 1 : 0,
        "reserved": 0
    });
};

SVGA3D.prototype.set_clip_plane = function(p, f)
{
    const context = this.context(p);
    if(!context || p.length < 6) return;
    this.writer.command(OP.SET_CLIP_PLANE, {
        "device_handle": context.device, "index": p[1] >>> 0, "plane": [f[2], f[3], f[4], f[5]]
    });
};

/**
 * CLEAR: cid, flags, color, depth, stencil, then SVGA3dRect[] (x, y, w, h)
 */
SVGA3D.prototype.clear = function(p, f)
{
    const context = this.context(p);
    if(!context || p.length < 5) return;
    this.drawing(context);
    const rects = Math.floor((p.length - 5) / 4);
    // VMware's reference SVGA3D_BeginClear contract ignores clipping and
    // fragment state. D3D9 Clear clips to viewport/scissor, so translate that
    // difference here and restore the context's drawing state afterwards.
    const target_entry = context.state.get("rt" + C.SVGA3D_RT_COLOR0);
    const mip = target_entry ? target_entry[1][4] >>> 0 : 0;
    const size = context.target ? context.target.sizes[Math.min(mip, context.target.sizes.length - 1)] : [1, 1];
    const viewport = context.viewport || [0, 0, 1, 1];
    const scissor_entry = context.state.get("rs" + C.SVGA3D_RS_SCISSORTESTENABLE);
    const scissor = scissor_entry ? scissor_entry[1][2] >>> 0 : 0;
    this.writer.command(OP.SET_VIEWPORT, {
        "device_handle": context.device, "width": size[0], "height": size[1], "max_z": 1
    });
    if(scissor) this.render_state(context, D3DRS.SCISSORTESTENABLE, 0);
    // the flag bits are D3DCLEAR's
    const w = this.writer.command(OP.CLEAR, {
        "device_handle": context.device, "clear_flags": p[1] & 7, "color": p[2] >>> 0,
        "depth": f[3], "stencil": p[4] >>> 0, "rect_count": rects
    });
    for(let i = 0; i < rects; i++)
    {
        const at = 5 + 4 * i, x = p[at] | 0, y = p[at + 1] | 0;
        w.struct("Rect", { "left": x, "top": y, "right": x + (p[at + 2] | 0), "bottom": y + (p[at + 3] | 0) });
    }
    this.writer.command(OP.SET_VIEWPORT, {
        "device_handle": context.device, "x": viewport[0], "y": viewport[1],
        "width": viewport[2], "height": viewport[3], "min_z": context.zrange[0], "max_z": context.zrange[1]
    });
    if(scissor) this.render_state(context, D3DRS.SCISSORTESTENABLE, scissor);
};

// ---------------------------------------------------------------------------
// Shaders

/** 64-bit FNV-1a over the tokens' bytes (d3d9_shader_pipeline.js hashTokens) */
function hash_tokens(tokens)
{
    let low = 0x84222325, high = 0xcbf29ce4;
    for(let i = 0; i < tokens.length * 4; i++)
    {
        low = (low ^ tokens[i >> 2] >>> 8 * (i & 3) & 0xFF) >>> 0;
        // times 0x100000001b3, in 16-bit limbs
        const l0 = low & 0xFFFF, l1 = low >>> 16, h0 = high & 0xFFFF, h1 = high >>> 16;
        const r0 = l0 * 0x1b3;
        const r1 = l1 * 0x1b3 + (r0 >>> 16);
        const r2 = h0 * 0x1b3 + (r1 >>> 16) + l0;
        const r3 = h1 * 0x1b3 + (r2 >>> 16) + l1;
        low = ((r1 & 0xFFFF) << 16 | r0 & 0xFFFF) >>> 0;
        high = ((r3 & 0xFFFF) << 16 | r2 & 0xFFFF) >>> 0;
    }
    return [low, high];
}

/**
 * SHADER_DEFINE: cid, shid, type, then D3D9 shader tokens
 */
SVGA3D.prototype.define_shader = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 4) return;
    const shid = p[1] >>> 0, type = p[2] >>> 0;
    if(type !== C.SVGA3D_SHADERTYPE_VS && type !== C.SVGA3D_SHADERTYPE_PS) return;
    const key = type + ":" + shid;
    if(context.shaders.has(key)) this.destroy_shader(p);
    const handle = SHADER_HANDLE_BASE + 2 * this.next_shader++;
    context.shaders.set(key, handle);
    const tokens = p.subarray(3);
    const [low, high] = hash_tokens(tokens);
    const w = this.writer.command(type === C.SVGA3D_SHADERTYPE_VS ? OP.CREATE_VERTEX_SHADER : OP.CREATE_PIXEL_SHADER, {
        "device_handle": context.device, "resource_handle": handle, "instruction_token_count": tokens.length,
        "bytecode_hash_low": low, "bytecode_hash_high": high
    });
    w.patch_field("code_offset", w.data(new Uint8Array(tokens.buffer, tokens.byteOffset, tokens.byteLength)));
};

SVGA3D.prototype.destroy_shader = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 3) return;
    const type = p[2] >>> 0, key = type + ":" + (p[1] >>> 0);
    const handle = context.shaders.get(key);
    if(!handle) return;
    context.shaders.delete(key);
    this.writer.command(OP.DESTROY_RESOURCE, {
        "resource_handle": handle, "resource_kind": type === C.SVGA3D_SHADERTYPE_VS ? KIND.VERTEX_SHADER : KIND.PIXEL_SHADER
    });
};

/**
 * SET_SHADER: cid, type, shid (SVGA3D_INVALID_ID: fixed function)
 */
SVGA3D.prototype.set_shader = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 3) return;
    const type = p[1] >>> 0, shid = p[2] >>> 0;
    const gb = this.gb_shaders.get(shid);
    const handle = shid === INVALID ? 0 : context.shaders.get(type + ":" + shid) || gb && gb.type === type && gb.handle || 0;
    if(type === C.SVGA3D_SHADERTYPE_VS) this.writer.command(OP.SET_VERTEX_SHADER, {
        "device_handle": context.device, "shader_handle": handle
    });
    else if(type === C.SVGA3D_SHADERTYPE_PS) this.writer.command(OP.SET_PIXEL_SHADER, {
        "device_handle": context.device, "shader_handle": handle
    });
};

/**
 * SET_SHADER_CONST: cid, reg, type, ctype, then four values per register
 */
SVGA3D.prototype.set_shader_const = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 8) return;
    const reg = p[1] >>> 0, type = p[2] >>> 0, ctype = p[3] >>> 0;
    const count = Math.floor((p.length - 4) / 4);
    const vs = type === C.SVGA3D_SHADERTYPE_VS;
    if(!vs && type !== C.SVGA3D_SHADERTYPE_PS) return;
    let op, data;
    if(ctype === C.SVGA3D_CONST_TYPE_BOOL)
    {
        op = vs ? OP.SET_VERTEX_SHADER_CONSTANT_B : OP.SET_PIXEL_SHADER_CONSTANT_B;
        const bools = new Uint32Array(count);
        for(let i = 0; i < count; i++) bools[i] = p[4 + 4 * i] ? 1 : 0;
        data = new Uint8Array(bools.buffer);
    }
    else
    {
        op = ctype === C.SVGA3D_CONST_TYPE_INT ?
            (vs ? OP.SET_VERTEX_SHADER_CONSTANT_I : OP.SET_PIXEL_SHADER_CONSTANT_I) :
            (vs ? OP.SET_VERTEX_SHADER_CONSTANT_F : OP.SET_PIXEL_SHADER_CONSTANT_F);
        data = new Uint8Array(p.buffer, p.byteOffset + 16, count * 16);
    }
    const w = this.writer.command(op, {
        "device_handle": context.device, "start_register": reg, "vector_count": count
    });
    w.patch_field("data_offset", w.data(data));
};

// ---------------------------------------------------------------------------
// Drawing

/**
 * DRAW_PRIMITIVES: cid, numVertexDecls, numRanges, then SVGA3dVertexDecl[]
 * (type, method, usage, usageIndex, surfaceId, offset, stride, first, last),
 * SVGA3dPrimitiveRange[] (primType, primitiveCount, indexArray surfaceId,
 * offset, stride, indexWidth, indexBias) and maybe SVGA3dVertexDivisor[]
 */
SVGA3D.prototype.draw_primitives = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 3) return;
    const decls = p[1] >>> 0, ranges = p[2] >>> 0;
    const ranges_at = 3 + 9 * decls, divisors_at = ranges_at + 7 * ranges;
    if(decls > 32 || ranges > 32 || p.length < divisors_at) return;
    this.drawing(context);
    const has_divisors = p.length >= divisors_at + decls;
    const w = this.writer, device = context.device;

    // Elements into streams: one per buffer and stride, split where an
    // element would not fit inside the stride from the stream's start
    const elements = [];
    for(let i = 0; i < decls; i++)
    {
        const at = 3 + 9 * i;
        elements.push({
            type: p[at] >>> 0, method: p[at + 1] >>> 0, usage: p[at + 2] >>> 0, usage_index: p[at + 3] >>> 0,
            sid: p[at + 4] >>> 0, offset: p[at + 5] >>> 0, stride: p[at + 6] >>> 0,
            divisor: has_divisors ? p[divisors_at + i] >>> 0 : 0,
        });
    }
    const order = elements.slice().sort((a, b) => a.sid - b.sid || a.stride - b.stride || a.divisor - b.divisor || a.offset - b.offset);
    const streams = [];
    for(const e of order)
    {
        const size = DECL_SIZES[e.type] || 4;
        let stream = streams[streams.length - 1];
        if(!stream || stream.sid !== e.sid || stream.stride !== e.stride || stream.divisor !== e.divisor ||
            e.stride && e.offset + size - stream.base > e.stride || e.offset - stream.base > 0xFFFF)
        {
            stream = { sid: e.sid, stride: e.stride, divisor: e.divisor, base: e.offset };
            streams.push(stream);
        }
        e.stream = streams.length - 1;
    }
    if(streams.length > MAX_STREAMS) return this.warn_once("streams", "a draw with more than 16 vertex streams");

    // the declaration, in the guest's element order (D3DVERTEXELEMENT9)
    const declaration = new Uint8Array(8 * elements.length);
    elements.forEach((e, i) => {
        declaration.set(d9wg_encode("VertexElement", {
            "stream": e.stream, "offset": e.offset - streams[e.stream].base,
            "type": e.type, "method": e.method, "usage": e.usage, "usage_index": e.usage_index,
        }), 8 * i);
    });
    const key = declaration.join(",");
    let handle = this.declarations.get(key);
    if(!handle)
    {
        handle = this.next_handle++;
        this.declarations.set(key, handle);
        w.command(OP.CREATE_VERTEX_DECLARATION, {
            "device_handle": UTILITY_DEVICE, "resource_handle": handle, "element_count": elements.length,
            "reserved": 0
        });
        w.data(declaration);
    }
    w.command(OP.SET_VERTEX_DECLARATION, {
        "device_handle": device, "declaration_handle": handle
    });

    let instanced = 0;
    for(let i = 0; i < streams.length; i++)
    {
        const s = streams[i], surface = this.surfaces.get(s.sid);
        const buffer = surface ? this.buffer_role(surface, ROLE_VERTEX) : 0;
        w.command(OP.SET_STREAM_SOURCE, {
            "device_handle": device, "stream": i, "buffer_handle": buffer,
            "stride": s.stride, "offset_in_bytes": s.base, "reserved": 0
        });
        // SVGA3dVertexDivisor has D3DSTREAMSOURCE_INDEXEDDATA's and _INSTANCEDATA's bits
        if(s.divisor)
        {
            w.command(OP.SET_STREAM_SOURCE_FREQ, {
                "device_handle": device, "stream": i, "divider": s.divisor
            });
            instanced |= 1 << i;
        }
    }
    // streams that had a frequency and now do not
    for(let i = 0; i < MAX_STREAMS; i++)
    {
        if(context.instanced & ~instanced & 1 << i) w.command(OP.SET_STREAM_SOURCE_FREQ, {
            "device_handle": device, "stream": i, "divider": 1
        });
    }
    context.instanced = instanced;

    for(let r = 0; r < ranges; r++)
    {
        const at = ranges_at + 7 * r;
        const type = PRIMITIVES[p[at] >>> 0], count = p[at + 1] >>> 0;
        const index_sid = p[at + 2] >>> 0, index_offset = p[at + 3] >>> 0;
        const index_width = p[at + 5] >>> 0, bias = p[at + 6] | 0;
        if(!type || !count) continue;
        if(index_sid === INVALID)
        {
            // not indexed: indexBias is the first vertex
            w.command(OP.DRAW_PRIMITIVE, {
                "device_handle": device, "primitive_type": type, "start_vertex": bias,
                "primitive_count": count
            });
            continue;
        }
        const surface = this.surfaces.get(index_sid);
        if(!surface || (index_width !== 2 && index_width !== 4) || index_offset % index_width) continue;
        const buffer = this.buffer_role(surface, index_width === 2 ? ROLE_INDEX16 : ROLE_INDEX32);
        w.command(OP.SET_INDICES, {
            "device_handle": device, "buffer_handle": buffer
        });
        w.command(OP.DRAW_INDEXED_PRIMITIVE, {
            "device_handle": device, "primitive_type": type, "base_vertex_index": bias,
            "min_vertex_index": 0, "vertex_count": primitive_vertices(type, count), "start_index": index_offset / index_width,
            "primitive_count": count
        });
    }
};

// ---------------------------------------------------------------------------
// Queries

/**
 * BEGIN_QUERY: cid, type. Only occlusion is declared.
 */
SVGA3D.prototype.begin_query = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 2 || (p[1] >>> 0) !== C.SVGA3D_QUERYTYPE_OCCLUSION) return;
    // a D9WG query per BEGIN/END pair: results can overlap
    const handle = context.query = this.next_handle++;
    this.writer.command(OP.CREATE_QUERY, {
        "device_handle": context.device, "resource_handle": handle, "query_type": D3DQUERYTYPE_OCCLUSION,
        "response_offset": 0
    });
    this.writer.command(OP.BEGIN_QUERY, {
        "device_handle": context.device, "resource_handle": handle, "response_offset": 0,
        "request_id": 0
    });
};

/**
 * END_QUERY: cid, type, guestResult (gmrId, offset); END_GB_QUERY: cid,
 * type, mobid, offset. The result is pending until the renderer has the count.
 * @param {{write: function(number, number, !Uint8Array):boolean}} memory the GMRs or the MOBs
 */
SVGA3D.prototype.end_query = function(p, memory)
{
    const context = this.context(p);
    if(!context || p.length < 4) return;
    const gmr = p[2] >>> 0, offset = p[3] >>> 0;
    const result = (state, value) => {
        const bytes = new Uint32Array([12, state, value]);
        memory.write(gmr, offset, new Uint8Array(bytes.buffer));
    };
    const handle = context.query;
    if((p[1] >>> 0) !== C.SVGA3D_QUERYTYPE_OCCLUSION || !handle)
    {
        result(C.SVGA3D_QUERYSTATE_FAILED, 0);
        return;
    }
    context.query = 0;
    result(C.SVGA3D_QUERYSTATE_PENDING, 0);
    const id = this.next_request++;
    const slot = id % QUERY_SLOTS * QUERY_SLOT_BYTES;
    this.requests.set(id, (value, status) => {
        const count = value ? value[0] | value[1] << 8 | value[2] << 16 | value[3] << 24 : 0;
        result(status === RESPONSE_OK ? C.SVGA3D_QUERYSTATE_SUCCEEDED : C.SVGA3D_QUERYSTATE_FAILED, count >>> 0);
    });
    this.writer.command(OP.END_QUERY, {
        "device_handle": context.device, "resource_handle": handle, "response_offset": slot,
        "request_id": id
    });
    this.writer.command(OP.DESTROY_RESOURCE, {
        "resource_handle": handle, "resource_kind": KIND.QUERY
    });
};

// ---------------------------------------------------------------------------
// Guest-backed objects (level gb9; docs/gpu-devices.md, "VMware SVGA II")
//
// The objects are the same as at vgpu9 (svga_gb.js has the MOBs and object
// tables); what changes is where their contents live between uses: a
// surface's image in its MOB, moved by UPDATE (MOB to GPU) and READBACK
// (GPU to MOB); a shader's bytecode in a MOB; a query's result in a MOB.
// Screen targets are screens whose picture is a surface.

/**
 * Write an object's entry in its object table
 * @param {Array<number>} dwords null clears it
 */
SVGA3D.prototype.otable = function(type, index, dwords)
{
    const tables = this.device.otables;
    if(!tables) return;
    tables.write_entry(type, index, dwords && new Uint8Array(Uint32Array.from(dwords, v => v >>> 0).buffer));
};

/**
 * The entry of a surface (SVGAOTableSurfaceEntry)
 */
SVGA3D.prototype.surface_otable = function(surface)
{
    const g = surface.gb;
    if(!g) return;
    const [width, height, depth] = surface.sizes[0];
    this.otable(C.SVGA_OTABLE_SURFACE, surface.sid, [g.format, g.flags, surface.sizes.length, surface.samples, g.filter,
        width, height, depth, surface.mob, g.array_size, surface.mob_pitch, g.flags2,
        g.pattern | g.quality << 8 | g.stride << 16, 0, 0, 0]);
};

/**
 * DEFINE_GB_SURFACE (v1 to v4)
 * @param {number} version 1 to 4
 */
SVGA3D.prototype.define_gb_surface = function(p, version)
{
    const wide = version >= 3;
    if(p.length < [9, 11, 13, 14][version - 1]) return;
    const at = wide ? 1 : 0;
    const sid = p[0] >>> 0, flags = p[1] >>> 0, flags2 = wide ? p[2] >>> 0 : 0;
    const format = p[2 + at] >>> 0, mips = Math.max(1, p[3 + at] >>> 0), samples = p[4 + at] >>> 0;
    const pattern = wide ? p[6] >>> 0 : 0, quality = wide ? p[7] >>> 0 : 0;
    const rest = wide ? 8 : 5;
    const filter = p[rest] >>> 0;
    const width = p[rest + 1] >>> 0, height = p[rest + 2] >>> 0, depth = Math.max(1, p[rest + 3] >>> 0);
    const array_size = version >= 2 ? p[rest + 4] >>> 0 : 0;
    const stride = version === 4 ? p[13] & 0xFFFF : 0;
    const cube = !!(flags & C.SVGA3D_SURFACE_CUBEMAP);
    const layers = cube ? Math.max(6, array_size) : Math.max(1, array_size);
    if(layers > (cube ? 6 : 1) && !this.dx) this.warn_once("gb-array", "surface arrays need DX (level dx10)");
    const sizes = [];
    for(let i = 0; i < mips; i++) sizes.push([Math.max(1, width >> i), Math.max(1, height >> i), Math.max(1, depth >> i)]);
    // at the DX levels a surface is made on the GPU where it is first used
    const surface = this.create_surface(sid, flags, format, cube ? 6 : 1, sizes, samples, !!this.dx);
    surface.gb = { format, flags, flags2, filter, array_size, pattern, quality, stride, layers };
    surface.definition = p.slice();
    surface.definition_id = [C.SVGA_3D_CMD_DEFINE_GB_SURFACE, C.SVGA_3D_CMD_DEFINE_GB_SURFACE_V2,
        C.SVGA_3D_CMD_DEFINE_GB_SURFACE_V3, C.SVGA_3D_CMD_DEFINE_GB_SURFACE_V4][version - 1];
    this.surface_otable(surface);
};

SVGA3D.prototype.destroy_gb_surface = function(sid)
{
    const surface = this.surfaces.get(sid);
    if(!surface || !surface.gb) return;
    this.destroy_surface(sid);
    this.otable(C.SVGA_OTABLE_SURFACE, sid, null);
};

/**
 * Where an image of a surface is in its MOB: layer after layer, each a
 * chain of mip levels, each level packed (vmw_surf_get_image_offset)
 * @return {{offset: number, pitch: number}}
 */
SVGA3D.prototype.mob_image = function(surface, layer, mip)
{
    let chain = 0, before = 0;
    for(let i = 0; i < surface.sizes.length; i++)
    {
        const level = level_layout(surface, i);
        const pitch = i === 0 && surface.mob_pitch ? surface.mob_pitch : level.pitch;
        const bytes = pitch * level.rows * level.depth;
        if(i < mip) before += bytes;
        chain += bytes;
    }
    const pitch = mip === 0 && surface.mob_pitch ? surface.mob_pitch : level_layout(surface, mip).pitch;
    return { offset: layer * chain + before, pitch };
};

/** The layers of a surface's MOB image: cube faces (volumes keep slices in their levels) */
function layers_of(surface)
{
    return surface.gb ? surface.gb.layers : surface.faces;
}

/**
 * UPDATE_GB_IMAGE: a box of an image from the MOB to the GPU
 * @param {Array<number>} box x, y, z, w, h, d; null for all of it
 */
SVGA3D.prototype.update_gb_image = function(surface, face, mip, box)
{
    if(surface.mob === INVALID || mip >= surface.sizes.length || face >= layers_of(surface)) return;
    const { offset, pitch } = this.mob_image(surface, face, mip);
    const [width, height, depth] = surface.sizes[mip];
    const [x, y, z, w, h, d] = box || [0, 0, 0, width, height, depth];
    this.dma_to_host(surface, face, mip, this.device.mobs, surface.mob, offset, pitch, [x, y, z, w, h, d, x, y, z]);
};

SVGA3D.prototype.update_gb_surface = function(surface)
{
    if(surface.mob === INVALID) return;
    for(let face = 0; face < layers_of(surface); face++)
    {
        for(let mip = 0; mip < surface.sizes.length; mip++) this.update_gb_image(surface, face, mip, null);
    }
    surface.host_newer = false;
};

/**
 * UPDATE_ZERO_SURFACE: the surface's images become zeros (its MOB is not
 * read, VMware's DX driver sends it for resources made without contents);
 * WRITE_ZERO_SURFACE: and its MOB too
 */
SVGA3D.prototype.zero_gb_surface = function(surface, write_mob)
{
    const zeros = {
        read: /** @type {function(number, number, number): Uint8Array} */ ((id, offset, length) => new Uint8Array(length)),
        write: /** @type {function(number, number, Uint8Array): boolean} */ ((id, offset, bytes) => false),
    };
    for(let face = 0; face < layers_of(surface); face++)
    {
        for(let mip = 0; mip < surface.sizes.length; mip++)
        {
            const { offset, pitch } = this.mob_image(surface, face, mip);
            const level = level_layout(surface, mip);
            if(write_mob && surface.mob !== INVALID)
            {
                this.device.mobs.write(surface.mob, offset, new Uint8Array(pitch * level.rows * level.depth));
            }
            // (a new texture is zeros already; a multisampled one takes no upload)
            if(surface.samples > 1) continue;
            this.dma_to_host(surface, face, mip, zeros, 0, offset, pitch,
                [0, 0, 0, level.width, level.height, level.depth, 0, 0, 0]);
        }
    }
    surface.host_newer = false;
};

/**
 * READBACK_GB_IMAGE(_PARTIAL): an image from the GPU into the MOB, written
 * when the renderer has read it (fences and command buffers after it wait)
 */
SVGA3D.prototype.readback_gb_image = function(surface, face, mip, box)
{
    if(surface.mob === INVALID || mip >= surface.sizes.length || face >= layers_of(surface)) return;
    if(surface.depth || surface.samples > 1)
    {
        return this.warn_once("gb-readback-depth", "depth and multisampled surfaces are not read back");
    }
    const { offset, pitch } = this.mob_image(surface, face, mip);
    const [width, height, depth] = surface.sizes[mip];
    const [x, y, z, w, h, d] = box || [0, 0, 0, width, height, depth];
    this.dma_to_guest(surface, face, mip, this.device.mobs, surface.mob, offset, pitch, [x, y, z, w, h, d, x, y, z]);
};

/**
 * DX_UPDATE_SUBRESOURCE, DX_BUFFER_UPDATE: a box of a subresource (mip
 * levels, then array layers) from the MOB to the GPU
 * @param {Array<number>} box x, y, z, w, h, d
 */
SVGA3D.prototype.update_subresource = function(surface, subresource, box)
{
    const mips = surface.sizes.length;
    this.update_gb_image(surface, Math.floor(subresource / mips), subresource % mips, box);
};

/** DX_READBACK_SUBRESOURCE: a subresource into the MOB */
SVGA3D.prototype.readback_subresource = function(surface, subresource)
{
    const mips = surface.sizes.length;
    this.readback_gb_image(surface, Math.floor(subresource / mips), subresource % mips, null);
};

/** A whole surface into its MOB (copies that end in a readback) */
SVGA3D.prototype.readback_surface = function(surface)
{
    if(surface) this.readback_gb_surface(surface);
};

SVGA3D.prototype.readback_gb_surface = function(surface)
{
    if(surface.mob === INVALID) return;
    for(let face = 0; face < layers_of(surface); face++)
    {
        for(let mip = 0; mip < surface.sizes.length; mip++) this.readback_gb_image(surface, face, mip, null);
    }
    surface.host_newer = false;
};

/**
 * BIND_GB_SURFACE(_WITH_PITCH), COND_BIND_GB_SURFACE
 */
SVGA3D.prototype.bind_gb_surface = function(surface, mob, pitch)
{
    surface.mob = mob;
    surface.mob_pitch = pitch;
    this.surface_otable(surface);
};

/** An SVGA3dSurfaceImageId: [surface, face, mip], the surface null if it is not defined */
SVGA3D.prototype.image_id = function(p, at)
{
    return [this.surfaces.get(p[at] >>> 0) || null, p[at + 1] >>> 0, p[at + 2] >>> 0];
};

/**
 * DEFINE/BIND_GB_CONTEXT. A context's state stays with its D9WG device,
 * so its MOB is only remembered (READBACK and INVALIDATE have nothing to do)
 */
SVGA3D.prototype.define_gb_context = function(cid)
{
    this.define_context(cid);
    this.contexts.get(cid).mob = INVALID;
    this.otable(C.SVGA_OTABLE_CONTEXT, cid, [cid, INVALID]);
};

SVGA3D.prototype.bind_gb_context = function(cid, mob, valid)
{
    const context = this.contexts.get(cid);
    if(!context) return;
    context.mob = mob;
    this.otable(C.SVGA_OTABLE_CONTEXT, cid, [cid, mob]);
};

/**
 * DEFINE_GB_SHADER: shid, type, sizeInBytes. GB shaders belong to no
 * context; their bytecode comes with BIND_GB_SHADER.
 */
SVGA3D.prototype.define_gb_shader = function(shid, type, size)
{
    this.destroy_gb_shader(shid);
    this.gb_shaders.set(shid, { type, size, mob: INVALID, offset: 0, handle: 0, code: null });
    this.otable(C.SVGA_OTABLE_SHADER, shid, [type, size, 0, INVALID]);
};

SVGA3D.prototype.destroy_gb_shader = function(shid)
{
    const shader = this.gb_shaders.get(shid);
    if(!shader) return;
    if(shader.handle)
    {
        this.writer.command(OP.DESTROY_RESOURCE, {
            "resource_handle": shader.handle, "resource_kind": shader.type === C.SVGA3D_SHADERTYPE_VS ? KIND.VERTEX_SHADER : KIND.PIXEL_SHADER
        });
    }
    this.gb_shaders.delete(shid);
    this.otable(C.SVGA_OTABLE_SHADER, shid, null);
};

/**
 * BIND_GB_SHADER: shid, mobid, offsetInBytes: the bytecode is read now
 */
SVGA3D.prototype.bind_gb_shader = function(shid, mob, offset)
{
    const shader = this.gb_shaders.get(shid);
    if(!shader) return;
    shader.mob = mob;
    shader.offset = offset;
    this.otable(C.SVGA_OTABLE_SHADER, shid, [shader.type, shader.size, offset, mob]);
    if(mob === INVALID) return;
    const bytes = this.device.mobs.read(mob, offset, shader.size & ~3);
    if(!bytes || shader.size < 4) return this.warn_once("gb-shader", "a shader outside of its MOB");
    if(shader.type !== C.SVGA3D_SHADERTYPE_VS && shader.type !== C.SVGA3D_SHADERTYPE_PS)
    {
        return this.warn_once("gb-shader-type", "shader type " + shader.type + " needs DX (level dx10)");
    }
    this.create_gb_shader(shader, bytes);
};

/**
 * The D9WG shader of a GB shader, from its bytecode
 * @param {!Uint8Array} bytes
 */
SVGA3D.prototype.create_gb_shader = function(shader, bytes)
{
    const kind = shader.type === C.SVGA3D_SHADERTYPE_VS ? KIND.VERTEX_SHADER : KIND.PIXEL_SHADER;
    if(shader.handle) this.writer.command(OP.DESTROY_RESOURCE, {
        "resource_handle": shader.handle, "resource_kind": kind
    });
    shader.code = bytes;
    const handle = shader.handle = SHADER_HANDLE_BASE + 2 * this.next_shader++;
    const tokens = new Int32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
    const [low, high] = hash_tokens(tokens);
    const w = this.writer.command(shader.type === C.SVGA3D_SHADERTYPE_VS ? OP.CREATE_VERTEX_SHADER : OP.CREATE_PIXEL_SHADER, {
        "device_handle": UTILITY_DEVICE, "resource_handle": handle, "instruction_token_count": tokens.length,
        "bytecode_hash_low": low, "bytecode_hash_high": high
    });
    w.patch_field("code_offset", w.data(bytes));
};

/**
 * SET_GB_SHADERCONSTS_INLINE: cid, regStart, shaderType, constType, then
 * the values: four dwords per float or int register, one per bool. Run as
 * SET_SHADER_CONST, which has four dwords for every type.
 */
SVGA3D.prototype.set_gb_shader_consts = function(p)
{
    if(p.length < 4) return;
    if((p[3] >>> 0) !== C.SVGA3D_CONST_TYPE_BOOL)
    {
        this.command(C.SVGA_3D_CMD_SET_SHADER_CONST, p);
        return;
    }
    const count = p.length - 4;
    const body = new Int32Array(4 + 4 * count);
    body.set(p.subarray(0, 4));
    for(let i = 0; i < count; i++) body[4 + 4 * i] = p[4 + i];
    this.command(C.SVGA_3D_CMD_SET_SHADER_CONST, body);
};

/**
 * GB_MOB_FENCE: value, mobId, mobOffset: written once the work before it is done
 */
SVGA3D.prototype.mob_fence = function(value, mob, offset)
{
    this.after_work(() => {
        this.device.mobs.write32(mob, offset, value);
        this.device.set_irq(C.SVGA_IRQFLAG_MOB_FENCE);
    });
};

/**
 * The commands of guest-backed objects
 * @return {boolean} whether it was one
 */
SVGA3D.prototype.gb_command = function(id, p)
{
    const device = this.device, mobs = device.mobs;
    const u = i => p[i] >>> 0;
    const enough = n => {
        if(p.length >= n) return true;
        this.warn_once("short" + id, "command " + id + " is too short");
        return false;
    };
    switch(id)
    {
        case C.SVGA_3D_CMD_SET_OTABLE_BASE:
            if(enough(5)) device.set_otable(u(0), u(4), u(1), u(2), u(3));
            return true;
        case C.SVGA_3D_CMD_SET_OTABLE_BASE64:
            if(enough(6)) device.set_otable(u(0), u(5), u(1) + u(2) * 0x100000000, u(3), u(4));
            return true;
        case C.SVGA_3D_CMD_GROW_OTABLE:
            if(enough(6)) device.grow_otable(u(0), u(5), u(1) + u(2) * 0x100000000, u(3), u(4));
            return true;
        case C.SVGA_3D_CMD_READBACK_OTABLE:
            // the entries are written as objects change
            return true;
        case C.SVGA_3D_CMD_DEFINE_GB_MOB:
            if(enough(4)) device.define_mob(u(0), u(1), u(2), u(3));
            return true;
        case C.SVGA_3D_CMD_DEFINE_GB_MOB64:
        case C.SVGA_3D_CMD_REDEFINE_GB_MOB64:
            if(enough(5)) device.define_mob(u(0), u(1), u(2) + u(3) * 0x100000000, u(4));
            return true;
        case C.SVGA_3D_CMD_DESTROY_GB_MOB:
            if(enough(1)) device.destroy_mob(u(0));
            return true;
        case C.SVGA_3D_CMD_UPDATE_GB_MOB_MAPPING:
        {
            // the page table changed: walk it again
            const mob = enough(1) && mobs.mobs.get(u(0));
            if(mob) device.define_mob(u(0), mob.format, mob.base, mob.size);
            return true;
        }
        case C.SVGA_3D_CMD_DEFINE_GB_SURFACE: this.define_gb_surface(p, 1); return true;
        case C.SVGA_3D_CMD_DEFINE_GB_SURFACE_V2: this.define_gb_surface(p, 2); return true;
        case C.SVGA_3D_CMD_DEFINE_GB_SURFACE_V3: this.define_gb_surface(p, 3); return true;
        case C.SVGA_3D_CMD_DEFINE_GB_SURFACE_V4: this.define_gb_surface(p, 4); return true;
        case C.SVGA_3D_CMD_DESTROY_GB_SURFACE:
            if(enough(1)) this.destroy_gb_surface(u(0));
            return true;
        case C.SVGA_3D_CMD_BIND_GB_SURFACE:
        case C.SVGA_3D_CMD_BIND_GB_SURFACE_WITH_PITCH:
        {
            const surface = enough(2) && this.surfaces.get(u(0));
            if(surface) this.bind_gb_surface(surface, u(1), id === C.SVGA_3D_CMD_BIND_GB_SURFACE_WITH_PITCH && p.length >= 3 ? u(2) : 0);
            return true;
        }
        case C.SVGA_3D_CMD_COND_BIND_GB_SURFACE:
        {
            // sid, testMobid, mobid, flags: only if it is bound to testMobid
            const surface = enough(4) && this.surfaces.get(u(0));
            if(!surface || surface.mob !== u(1)) return true;
            if(u(3) & C.SVGA3D_COND_BIND_GB_SURFACE_FLAG_READBACK) this.readback_gb_surface(surface);
            this.bind_gb_surface(surface, u(2), 0);
            if(u(3) & C.SVGA3D_COND_BIND_GB_SURFACE_FLAG_UPDATE) this.update_gb_surface(surface);
            return true;
        }
        case C.SVGA_3D_CMD_UPDATE_GB_IMAGE:
        {
            const [surface, face, mip] = enough(9) ? this.image_id(p, 0) : [null, 0, 0];
            if(surface) this.update_gb_image(surface, face, mip, [u(3), u(4), u(5), u(6), u(7), u(8)]);
            return true;
        }
        case C.SVGA_3D_CMD_UPDATE_GB_SURFACE:
        {
            const surface = enough(1) && this.surfaces.get(u(0));
            if(surface) this.update_gb_surface(surface);
            return true;
        }
        case C.SVGA_3D_CMD_UPDATE_ZERO_SURFACE:
        case C.SVGA_3D_CMD_WRITE_ZERO_SURFACE:
        {
            const surface = enough(1) && this.surfaces.get(u(0));
            if(surface) this.zero_gb_surface(surface, id === C.SVGA_3D_CMD_WRITE_ZERO_SURFACE);
            return true;
        }
        case C.SVGA_3D_CMD_READBACK_GB_IMAGE:
        {
            const [surface, face, mip] = enough(3) ? this.image_id(p, 0) : [null, 0, 0];
            if(surface) this.readback_gb_image(surface, face, mip, null);
            return true;
        }
        case C.SVGA_3D_CMD_READBACK_GB_IMAGE_PARTIAL:
        {
            // (invertBox: the box is what not to read; reading all of it is as good)
            const [surface, face, mip] = enough(10) ? this.image_id(p, 0) : [null, 0, 0];
            if(surface) this.readback_gb_image(surface, face, mip, u(9) ? null : [u(3), u(4), u(5), u(6), u(7), u(8)]);
            return true;
        }
        case C.SVGA_3D_CMD_READBACK_GB_SURFACE:
        {
            const surface = enough(1) && this.surfaces.get(u(0));
            if(surface) this.readback_gb_surface(surface);
            return true;
        }
        case C.SVGA_3D_CMD_INVALIDATE_GB_IMAGE:
        case C.SVGA_3D_CMD_INVALIDATE_GB_SURFACE:
        case C.SVGA_3D_CMD_INVALIDATE_GB_IMAGE_PARTIAL:
            // the GPU's copy may be dropped; keeping it is as good
            return true;
        case C.SVGA_3D_CMD_DEFINE_GB_CONTEXT:
            if(enough(1)) this.define_gb_context(u(0));
            return true;
        case C.SVGA_3D_CMD_DESTROY_GB_CONTEXT:
            if(enough(1))
            {
                this.destroy_context(u(0));
                this.otable(C.SVGA_OTABLE_CONTEXT, u(0), null);
            }
            return true;
        case C.SVGA_3D_CMD_BIND_GB_CONTEXT:
            if(enough(3)) this.bind_gb_context(u(0), u(1), u(2));
            return true;
        case C.SVGA_3D_CMD_READBACK_GB_CONTEXT:
        case C.SVGA_3D_CMD_INVALIDATE_GB_CONTEXT:
            return true;
        case C.SVGA_3D_CMD_DEFINE_GB_SHADER:
            if(enough(3)) this.define_gb_shader(u(0), u(1), u(2));
            return true;
        case C.SVGA_3D_CMD_DESTROY_GB_SHADER:
            if(enough(1)) this.destroy_gb_shader(u(0));
            return true;
        case C.SVGA_3D_CMD_BIND_GB_SHADER:
            if(enough(3)) this.bind_gb_shader(u(0), u(1), u(2));
            return true;
        case C.SVGA_3D_CMD_SET_GB_SHADERCONSTS_INLINE:
            this.set_gb_shader_consts(p);
            return true;
        case C.SVGA_3D_CMD_BEGIN_GB_QUERY:
            this.begin_query(p);
            return true;
        case C.SVGA_3D_CMD_END_GB_QUERY:
            this.end_query(p, mobs);
            return true;
        case C.SVGA_3D_CMD_WAIT_FOR_GB_QUERY:
            // the result is written when it is known: what follows waits for it
            return true;
        case C.SVGA_3D_CMD_NOP:
            return true;
        case C.SVGA_3D_CMD_GB_MOB_FENCE:
            if(enough(3)) this.mob_fence(u(0), u(1), u(2));
            return true;
        case C.SVGA_3D_CMD_DEFINE_GB_SCREENTARGET:
            if(enough(7)) this.define_screen_target(u(0), u(1), u(2), p[3], p[4], u(5), u(6));
            return true;
        case C.SVGA_3D_CMD_DESTROY_GB_SCREENTARGET:
            if(enough(1)) this.destroy_screen_target(u(0));
            return true;
        case C.SVGA_3D_CMD_BIND_GB_SCREENTARGET:
            if(enough(4)) this.bind_screen_target(u(0), u(1), u(2), u(3));
            return true;
        case C.SVGA_3D_CMD_UPDATE_GB_SCREENTARGET:
        case C.SVGA_3D_CMD_UPDATE_GB_SCREENTARGET_V2:
            if(enough(5)) this.update_screen_target(u(0), p[1], p[2], u(3), u(4), p[1], p[2]);
            return true;
        case C.SVGA_3D_CMD_UPDATE_GB_SCREENTARGET_MOVE:
            // stid, rect, type, srcPoint: the rectangle comes from elsewhere in the surface
            if(enough(8)) this.update_screen_target(u(0), p[1], p[2], u(3), u(4), p[6], p[7]);
            return true;
        case C.SVGA_3D_CMD_GB_SCREEN_DMA:
            if(enough(5)) this.screen_dma(u(0), u(2), u(3));
            return true;
        // The GART: an aperture of MOB pages Windows' vm3d keeps for its
        // memory segment. Commands name MOBs, not GART offsets, so the
        // mappings are only kept.
        case C.SVGA_3D_CMD_ENABLE_GART:
            if(enough(1)) this.gart = { mob: u(0), maps: new Map() };
            return true;
        case C.SVGA_3D_CMD_DISABLE_GART:
            this.gart = null;
            return true;
        case C.SVGA_3D_CMD_MAP_MOB_INTO_GART:
            if(enough(2) && this.gart) this.gart.maps.set(u(1), u(0));
            return true;
        case C.SVGA_3D_CMD_UNMAP_GART_RANGE:
            if(enough(2) && this.gart)
            {
                for(const offset of this.gart.maps.keys())
                {
                    if(offset >= u(0) && offset < u(0) + u(1)) this.gart.maps.delete(offset);
                }
            }
            return true;
    }
    return false;
};

// ---------------------------------------------------------------------------
// Screen targets: screens (svga_screens.js) whose picture is a surface image,
// copied into them by UPDATE_GB_SCREENTARGET

SVGA3D.prototype.target_otable = function(stid)
{
    const t = this.targets.get(stid);
    if(!t) return this.otable(C.SVGA_OTABLE_SCREENTARGET, stid, null);
    const image = t.image || [INVALID, 0, 0];
    this.otable(C.SVGA_OTABLE_SCREENTARGET, stid, [image[0], image[1], image[2], t.width, t.height, t.x, t.y, t.flags, t.dpi]);
};

SVGA3D.prototype.define_screen_target = function(stid, width, height, x, y, flags, dpi)
{
    if(!this.device.screens.define_target(stid, flags, width, height, x, y))
    {
        this.warn_once("target", "an invalid screen target");
        return;
    }
    this.targets.set(stid, { width, height, x, y, flags, dpi, image: null });
    this.target_otable(stid);
};

SVGA3D.prototype.destroy_screen_target = function(stid)
{
    this.targets.delete(stid);
    this.device.screens.destroy(stid);
    this.target_otable(stid);
};

SVGA3D.prototype.bind_screen_target = function(stid, sid, face, mip)
{
    const target = this.targets.get(stid);
    if(!target) return;
    target.image = sid === INVALID ? null : [sid, face, mip];
    this.target_otable(stid);
    if(!target.image) this.device.screens.blank(stid);
};

/**
 * UPDATE_GB_SCREENTARGET: rectangle (x, y, w, h) of a screen target from its
 * image, at (sx, sy) in it. An image the GPU has nothing newer of is read
 * from its MOB; otherwise from the GPU.
 */
SVGA3D.prototype.update_screen_target = function(stid, x, y, w, h, sx, sy)
{
    const target = this.targets.get(stid);
    const screen = this.device.screens.screens.get(stid);
    if(!target || !target.image || !screen) return;
    const surface = this.surfaces.get(target.image[0]);
    if(!surface) return;
    const [, face, mip] = target.image;
    x = Math.max(0, x); y = Math.max(0, y);
    w = Math.min(w, screen.width - x); h = Math.min(h, screen.height - y);
    const [width, height] = surface.sizes[Math.min(mip, surface.sizes.length - 1)];
    w = Math.min(w, width - sx); h = Math.min(h, height - sy);
    if(w <= 0 || h <= 0 || sx < 0 || sy < 0) return;
    if(surface.host_newer || surface.mob === INVALID)
    {
        if(surface.home && (surface.home === "gx" || surface.handle)) this.to_desktop(surface, sx, sy, w, h, screen.x + x, screen.y + y, w, h, null);
        return;
    }
    const pixel = surface_pixel_reader(surface);
    if(!pixel) return this.warn_once("present-format" + surface.format, "presenting format " + surface.format + " is not supported");
    const { offset, pitch } = this.mob_image(surface, face, mip);
    const bytes_per = surface.layout.bytes;
    const rows = this.device.mobs.read(surface.mob, offset + sy * pitch, (h - 1) * pitch + (sx + w) * bytes_per);
    if(!rows) return this.warn_once("target-mob", "a screen target image outside of its MOB");
    const word = surface_word_converter(surface);
    for(let row = 0; row < h; row++)
    {
        const at = ((y + row) * screen.width + x) * 4;
        if(word && convert_row_32(word, rows, row * pitch + sx * 4, screen.rgba, at, w)) continue;
        for(let column = 0; column < w; column++)
        {
            pixel(rows, row * pitch + (sx + column) * bytes_per, screen.rgba, at + column * 4);
        }
    }
    screen.mark(y, y + h);
};

/**
 * GB_SCREEN_DMA: screenId, (dead), destMobID, destPitch: the screen's
 * picture into a MOB, as BGRX
 */
SVGA3D.prototype.screen_dma = function(id, mob, pitch)
{
    const screen = this.device.screens.screens.get(id);
    if(!screen || pitch < screen.width * 4) return;
    const row = new Uint8Array(screen.width * 4);
    for(let y = 0; y < screen.height; y++)
    {
        for(let x = 0; x < screen.width; x++)
        {
            const at = (y * screen.width + x) * 4;
            row[x * 4] = screen.rgba[at + 2]; row[x * 4 + 1] = screen.rgba[at + 1]; row[x * 4 + 2] = screen.rgba[at]; row[x * 4 + 3] = 0;
        }
        if(!this.device.mobs.write(mob, y * pitch, row)) return;
    }
};

// ---------------------------------------------------------------------------
// Pictures to the screen

/**
 * PRESENT: sid, then SVGA3dCopyRect[] (x, y, w, h, srcx, srcy): the
 * surface's rectangles to the desktop
 */
SVGA3D.prototype.present = function(p)
{
    const surface = this.image(p, 0);
    if(!surface || surface.home === "d9wg" && !surface.handle) return;
    const rects = [];
    for(let at = 1; at + 6 <= p.length; at += 6)
    {
        rects.push({ dx: p[at] | 0, dy: p[at + 1] | 0, w: p[at + 2] | 0, h: p[at + 3] | 0, sx: p[at + 4] | 0, sy: p[at + 5] | 0 });
    }
    if(!rects.length)
    {
        const [width, height] = surface.sizes[0];
        rects.push({ dx: 0, dy: 0, w: width, h: height, sx: 0, sy: 0 });
    }
    for(const r of rects)
    {
        this.to_desktop(surface, r.sx, r.sy, r.w, r.h, r.dx, r.dy, r.w, r.h, null);
    }
};

/**
 * BLIT_SURFACE_TO_SCREEN: srcImage, srcRect (l, t, r, b), destScreenId,
 * destRect (l, t, r, b, in the screen), then clip rectangles in the screen
 */
SVGA3D.prototype.blit_surface_to_screen = function(p)
{
    const surface = this.image(p, 0);
    if(!surface || surface.home === "d9wg" && !surface.handle || p.length < 12) return;
    const screen = this.device.screens.screens.get(p[7] >>> 0);
    if(!screen) return;
    const sl = p[3] | 0, st = p[4] | 0, sw = (p[5] | 0) - sl, sh = (p[6] | 0) - st;
    const dl = p[8] | 0, dt = p[9] | 0, dw = (p[10] | 0) - dl, dh = (p[11] | 0) - dt;
    if(sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
    let clips = null;
    if(p.length >= 16)
    {
        clips = [];
        for(let at = 12; at + 4 <= p.length; at += 4) clips.push([p[at] | 0, p[at + 1] | 0, p[at + 2] | 0, p[at + 3] | 0]);
    }
    this.to_desktop(surface, sl, st, sw, sh, screen.x + dl, screen.y + dt, dw, dh,
        clips && clips.map(([l, t, r, b]) => [screen.x + l, screen.y + t, screen.x + r, screen.y + b]));
};

/**
 * Read a rectangle of a surface back and draw it, scaled, on the desktop:
 * into the screens it covers, or into the frame buffer without screens
 * @param {Array<!Array<number>>} clips rectangles (l, t, r, b) on the desktop it is limited to
 */
SVGA3D.prototype.to_desktop = function(surface, sx, sy, sw, sh, dx, dy, dw, dh, clips)
{
    const [width, height] = surface.sizes[0];
    if(sx < 0 || sy < 0 || sx + sw > width || sy + sh > height)
    {
        this.warn_once("present-bounds", "a present outside of its surface");
        return;
    }
    const pixel = surface_pixel_reader(surface);
    if(!pixel) return this.warn_once("present-format" + surface.format, "presenting format " + surface.format + " is not supported");
    const device = this.device;
    const bytes_per = surface.layout.bytes;
    // (unscaled 32-bit pixels: a row at a time, as words)
    const word = sw === dw && sh === dh ? surface_word_converter(surface) : null;
    this.read_rows(surface, 0, 0, sy, sh, (data, first, count, pitch, x0) => {
        // the destination rows this piece of source rows makes
        const top = dy + Math.ceil((first - sy) * dh / sh), bottom = dy + Math.ceil((first - sy + count) * dh / sh);
        const put = (rgba, row_at, left, right, y) => {
            const source_row = sy + Math.floor((y - dy) * sh / dh) - first;
            if(word && convert_row_32(word, data, source_row * pitch + (sx + left - dx - x0) * 4, rgba, row_at + left * 4, right - left)) return;
            for(let x = left; x < right; x++)
            {
                const column = sx + Math.floor((x - dx) * sw / dw) - x0;
                pixel(data, source_row * pitch + column * bytes_per, rgba, row_at + x * 4);
            }
        };
        const screens = device.screens.screens;
        if(screens.size)
        {
            for(const screen of screens.values())
            {
                for(const [l, t, r, b] of clips || [[dx, dy, dx + dw, dy + dh]])
                {
                    const left = Math.max(l, dx, screen.x), right = Math.min(r, dx + dw, screen.x + screen.width);
                    const y0 = Math.max(t, top, screen.y), y1 = Math.min(b, bottom, screen.y + screen.height);
                    if(left >= right || y0 >= y1) continue;
                    for(let y = y0; y < y1; y++)
                    {
                        // the screen's own coordinates
                        const row_at = ((y - screen.y) * screen.width - screen.x) * 4;
                        put(screen.rgba, row_at, left, right, y);
                    }
                    if(screen.backing) device.screens.copy_to_backing(screen, left - screen.x, y0 - screen.y, right - screen.x, y1 - screen.y);
                    screen.mark(y0 - screen.y, y1 - screen.y);
                }
            }
        }
        else if(device.svga_active() && device.bpp === 32)
        {
            // the frame buffer of the register mode: BGRX
            const vram = device.vram(), pitch_fb = device.pitch(), row = new Uint8ClampedArray(device.width * 4);
            for(const [l, t, r, b] of clips || [[dx, dy, dx + dw, dy + dh]])
            {
                const left = Math.max(l, dx, 0), right = Math.min(r, dx + dw, device.width);
                for(let y = Math.max(t, top, 0); y < Math.min(b, bottom, device.height); y++)
                {
                    put(row, 0, left, right, y);
                    for(let x = left; x < right; x++)
                    {
                        const at = y * pitch_fb + x * 4;
                        vram[at] = row[x * 4 + 2]; vram[at + 1] = row[x * 4 + 1]; vram[at + 2] = row[x * 4]; vram[at + 3] = 0;
                    }
                }
            }
            device.machine.mmio_ram_mark_dirty(device.vga.lfb_region);
        }
    }, sx, sw);
};

/**
 * How to turn a 32-bit pixel of a surface, as a little-endian word, into an
 * RGBA one (opaque): for the formats presents mostly have, else null
 * @return {?function(number):number}
 */
function surface_word_converter(surface)
{
    const d3d = surface.info && surface.info.d3d;
    if(d3d === D3DFMT.X8R8G8B8 || d3d === D3DFMT.A8R8G8B8) return bgra_to_rgba;
    if(d3d === D3DFMT.A8B8G8R8) return rgba_opaque;
    if(d3d) return null;
    switch(surface.format)
    {
        case C.SVGA3D_B8G8R8A8_UNORM: case C.SVGA3D_B8G8R8X8_UNORM: case C.SVGA3D_B8G8R8A8_UNORM_SRGB:
        case C.SVGA3D_B8G8R8X8_UNORM_SRGB: case C.SVGA3D_B8G8R8A8_TYPELESS: case C.SVGA3D_B8G8R8X8_TYPELESS:
            return bgra_to_rgba;
        case C.SVGA3D_R8G8B8A8_UNORM: case C.SVGA3D_R8G8B8A8_UNORM_SRGB: case C.SVGA3D_R8G8B8A8_TYPELESS:
            return rgba_opaque;
    }
    return null;
}

const bgra_to_rgba = v => 0xFF000000 | (v & 0xFF) << 16 | v & 0xFF00 | v >>> 16 & 0xFF;
const rgba_opaque = v => v | 0xFF000000;

/**
 * `count` 32-bit pixels from `source` (at byte `from`) into `rgba` (at byte
 * `to`), converted by `word`
 * @return {boolean} false where the bytes are not word aligned (the caller
 *     converts pixel by pixel)
 */
function convert_row_32(word, source, from, rgba, to, count)
{
    if(((source.byteOffset + from) & 3) || ((rgba.byteOffset + to) & 3) || count <= 0) return count <= 0;
    const s = new Int32Array(source.buffer, source.byteOffset + from, count);
    const d = new Int32Array(rgba.buffer, rgba.byteOffset + to, count);
    for(let i = 0; i < count; i++) d[i] = word(s[i]);
    return true;
}

/**
 * How to turn a pixel of a surface into RGBA: its D3D9 format, or a DX one
 * @return {?function(!Uint8Array, number, !Uint8ClampedArray, number)}
 */
function surface_pixel_reader(surface)
{
    if(surface.info && surface.info.d3d) return pixel_reader(surface.info.d3d);
    switch(surface.format)
    {
        case C.SVGA3D_B8G8R8A8_UNORM: case C.SVGA3D_B8G8R8X8_UNORM: case C.SVGA3D_B8G8R8A8_UNORM_SRGB:
        case C.SVGA3D_B8G8R8X8_UNORM_SRGB: case C.SVGA3D_B8G8R8A8_TYPELESS: case C.SVGA3D_B8G8R8X8_TYPELESS:
            return pixel_reader(D3DFMT.X8R8G8B8);
        case C.SVGA3D_R8G8B8A8_UNORM: case C.SVGA3D_R8G8B8A8_UNORM_SRGB: case C.SVGA3D_R8G8B8A8_TYPELESS:
            return pixel_reader(D3DFMT.A8B8G8R8);
        case C.SVGA3D_B5G6R5_UNORM:
            return pixel_reader(D3DFMT.R5G6B5);
        case C.SVGA3D_B5G5R5A1_UNORM:
            return pixel_reader(D3DFMT.A1R5G5B5);
        case C.SVGA3D_R10G10B10A2_UNORM: case C.SVGA3D_R10G10B10A2_TYPELESS:
            return (s, i, t, o) => {
                const v = (s[i] | s[i + 1] << 8 | s[i + 2] << 16 | s[i + 3] << 24) >>> 0;
                t[o] = (v & 1023) >> 2; t[o + 1] = (v >> 10 & 1023) >> 2; t[o + 2] = (v >> 20 & 1023) >> 2; t[o + 3] = 255;
            };
    }
    return null;
}

/**
 * How to turn a pixel of a format into RGBA
 * @return {?function(!Uint8Array, number, !Uint8ClampedArray, number)}
 */
function pixel_reader(d3d)
{
    switch(d3d)
    {
        case D3DFMT.X8R8G8B8:
        case D3DFMT.A8R8G8B8:
            return (s, i, t, o) => { t[o] = s[i + 2]; t[o + 1] = s[i + 1]; t[o + 2] = s[i]; t[o + 3] = 255; };
        case D3DFMT.A8B8G8R8:
            return (s, i, t, o) => { t[o] = s[i]; t[o + 1] = s[i + 1]; t[o + 2] = s[i + 2]; t[o + 3] = 255; };
        case D3DFMT.R5G6B5:
            return (s, i, t, o) => {
                const v = s[i] | s[i + 1] << 8;
                t[o] = (v >> 11 & 31) * 255 / 31; t[o + 1] = (v >> 5 & 63) * 255 / 63; t[o + 2] = (v & 31) * 255 / 31; t[o + 3] = 255;
            };
        case D3DFMT.X1R5G5B5:
        case D3DFMT.A1R5G5B5:
            return (s, i, t, o) => {
                const v = s[i] | s[i + 1] << 8;
                t[o] = (v >> 10 & 31) * 255 / 31; t[o + 1] = (v >> 5 & 31) * 255 / 31; t[o + 2] = (v & 31) * 255 / 31; t[o + 3] = 255;
            };
        case D3DFMT.A2R10G10B10:
            return (s, i, t, o) => {
                const v = (s[i] | s[i + 1] << 8 | s[i + 2] << 16 | s[i + 3] << 24) >>> 0;
                t[o] = (v >> 20 & 1023) >> 2; t[o + 1] = (v >> 10 & 1023) >> 2; t[o + 2] = (v & 1023) >> 2; t[o + 3] = 255;
            };
    }
    return null;
}
