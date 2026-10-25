// virtio-gpu as virtio-vga (1AF4:1050, class 0300): the VGA core for the
// BIOS, boot loaders and VBE (its frame buffer is BAR0), and the virtio-gpu
// device on the same function, its four capabilities in the memory BAR2
// (as QEMU's virtio-vga: viogpudo maps no I/O BARs).
// See docs/gpu-devices.md, "virtio-gpu"; the protocol is
// third_party/virtio/virtio_gpu.h.
//
// This file is the device: the control and cursor queues, 2D resources in
// host memory, filled from their guest backing by TRANSFER_TO_HOST_2D and
// shown on a scanout by RESOURCE_FLUSH, EDID, display events when the page's
// size changes (V86.set_display_size), guest and HOST3D blobs, the host
// visible memory (BAR4) and snapshots. 3D contexts are virgl.js's (virgl)
// and venus.js's (Venus). The screen shows the VGA core until the driver's
// first control command, and again after a device reset.
//
// On a machine without VGA (the virt machine's, machine.has_vga false;
// docs/arm64-virt-android16-plan.md P7.1) it is virtio-gpu-pci (class 0380)
// or a virtio-mmio device: no VGA core, no frame buffer BAR or ROM; until the
// driver's first command the screen is blank. The host visible memory is
// then BAR 2, 64 bits wide (the capabilities are in BAR 4, as QEMU's).

import { VGAScreen } from "../vga_core.js";
import { SoftwareCursor } from "../vmware_svga/svga_cursor.js";
import { make_edid } from "./edid.js";
import { Virgl, Resource3D } from "./virgl.js";
import { CAPSETS, capset } from "./virgl_caps.js";
import { Venus, VenusBlob } from "./venus.js";
import { Gfxstream, GfxstreamBlob } from "./gfxstream.js";
import { VulkanModel } from "./venus_vk.js";
import { GX } from "../renderer_protocol.js";

// For Types Only
import { GraphicsMachine } from "../machine.js";
import { DisplaySource } from "../../display.js";

const DEFAULT_VRAM_SIZE = 32 << 20;
// viogpudo only uses BAR0 as its frame buffer from 16 MiB
const MIN_VRAM_SIZE = 16 << 20;

const VIRTIO_GPU_DEVICE_ID = 0x1050;
const VIRTIO_GPU_SUBSYSTEM_ID = 0x1100;
const VGA_CLASS = 0x030000;
/** without VGA: a display controller of another kind, as QEMU's virtio-gpu-pci */
const DISPLAY_OTHER_CLASS = 0x038000;

// Feature bits
const VIRTIO_GPU_F_VIRGL = 0;
const VIRTIO_GPU_F_EDID = 1;
const VIRTIO_GPU_F_RESOURCE_UUID = 2;
const VIRTIO_GPU_F_RESOURCE_BLOB = 3;
const VIRTIO_GPU_F_CONTEXT_INIT = 4;
const VIRTIO_F_RING_INDIRECT_DESC = 28;

const CONTROLQ = 0;
const CURSORQ = 1;

// What the device declares, chosen at power-on and kept by snapshots, as
// vmware_svga's levels: a new feature needs a new level
const LEVELS = {
    "2d": { features: [VIRTIO_GPU_F_EDID, VIRTIO_GPU_F_RESOURCE_UUID, VIRTIO_F_RING_INDIRECT_DESC] },
    // 3D: virgl contexts (Mesa's virgl driver), drawn by GX; needs a renderer
    "virgl": { features: [VIRTIO_GPU_F_VIRGL, VIRTIO_GPU_F_EDID, VIRTIO_GPU_F_RESOURCE_UUID, VIRTIO_F_RING_INDIRECT_DESC], three_d: true },
    // ... and the capsets of OpenGL 4.3 / GLES 3.2 (virgl_caps.js)
    "virgl43": { features: [VIRTIO_GPU_F_VIRGL, VIRTIO_GPU_F_EDID, VIRTIO_GPU_F_RESOURCE_UUID, VIRTIO_F_RING_INDIRECT_DESC], three_d: true,
        gl43: true },
    // blob resources in guest memory (scanouts straight from it), and
    // contexts of a capset (CONTEXT_INIT: virgl's)
    "2d-blob": { features: [VIRTIO_GPU_F_EDID, VIRTIO_GPU_F_RESOURCE_UUID, VIRTIO_GPU_F_RESOURCE_BLOB, VIRTIO_F_RING_INDIRECT_DESC], blob: true },
    "virgl43-blob": { features: [VIRTIO_GPU_F_VIRGL, VIRTIO_GPU_F_EDID, VIRTIO_GPU_F_RESOURCE_UUID, VIRTIO_GPU_F_RESOURCE_BLOB,
        VIRTIO_GPU_F_CONTEXT_INIT, VIRTIO_F_RING_INDIRECT_DESC], three_d: true, gl43: true, blob: true },
    // ... and blobs of the host's (HOST3D) mapped into host visible memory
    // (BAR4): persistent, coherent buffer mappings (ARB_buffer_storage)
    "virgl43-hostmem": { features: [VIRTIO_GPU_F_VIRGL, VIRTIO_GPU_F_EDID, VIRTIO_GPU_F_RESOURCE_UUID, VIRTIO_GPU_F_RESOURCE_BLOB,
        VIRTIO_GPU_F_CONTEXT_INIT, VIRTIO_F_RING_INDIRECT_DESC], three_d: true, gl43: true, blob: true, hostmem: true },
    // ... and Vulkan: Venus contexts (Mesa's venus driver; venus.js)
    "venus": { features: [VIRTIO_GPU_F_VIRGL, VIRTIO_GPU_F_EDID, VIRTIO_GPU_F_RESOURCE_UUID, VIRTIO_GPU_F_RESOURCE_BLOB,
        VIRTIO_GPU_F_CONTEXT_INIT, VIRTIO_F_RING_INDIRECT_DESC], three_d: true, gl43: true, blob: true, hostmem: true, venus: true },
    // gfxstream's contexts in place of virgl's (gfxstream.js; Android's
    // official images: docs/gfxstream-plan.md): its capsets only, as
    // rutabaga's gfxstream component offers them; a context without a
    // capset is gfxstream's too, and a pipe resource its process pipe
    "gfxstream": { features: [VIRTIO_GPU_F_VIRGL, VIRTIO_GPU_F_EDID, VIRTIO_GPU_F_RESOURCE_UUID, VIRTIO_GPU_F_RESOURCE_BLOB,
        VIRTIO_GPU_F_CONTEXT_INIT, VIRTIO_F_RING_INDIRECT_DESC], three_d: true, gl43: true, blob: true, hostmem: true, gfxstream: true },
};
const LEVEL_ORDER = ["2d", "2d-blob", "virgl", "virgl43", "virgl43-blob", "virgl43-hostmem", "venus", "gfxstream"];
/** Without a pinned level: the highest, with a renderer or without */
const DEFAULT_3D_LEVEL = "virgl43-hostmem";
const DEFAULT_LEVEL = "2d-blob";

// Commands
const CMD_GET_DISPLAY_INFO = 0x0100;
const CMD_RESOURCE_CREATE_2D = 0x0101;
const CMD_RESOURCE_UNREF = 0x0102;
const CMD_SET_SCANOUT = 0x0103;
const CMD_RESOURCE_FLUSH = 0x0104;
const CMD_TRANSFER_TO_HOST_2D = 0x0105;
const CMD_RESOURCE_ATTACH_BACKING = 0x0106;
const CMD_RESOURCE_DETACH_BACKING = 0x0107;
const CMD_GET_CAPSET_INFO = 0x0108;
const CMD_GET_CAPSET = 0x0109;
const CMD_GET_EDID = 0x010A;
const CMD_RESOURCE_ASSIGN_UUID = 0x010B;
const CMD_RESOURCE_CREATE_BLOB = 0x010C;
const CMD_SET_SCANOUT_BLOB = 0x010D;
const CMD_RESOURCE_MAP_BLOB = 0x0208;
const CMD_RESOURCE_UNMAP_BLOB = 0x0209;
const CMD_CTX_CREATE = 0x0200;
const CMD_CTX_DESTROY = 0x0201;
const CMD_CTX_ATTACH_RESOURCE = 0x0202;
const CMD_CTX_DETACH_RESOURCE = 0x0203;
const CMD_RESOURCE_CREATE_3D = 0x0204;
const CMD_TRANSFER_TO_HOST_3D = 0x0205;
const CMD_TRANSFER_FROM_HOST_3D = 0x0206;
const CMD_SUBMIT_3D = 0x0207;
const CMD_UPDATE_CURSOR = 0x0300;
const CMD_MOVE_CURSOR = 0x0301;

// Responses
const RESP_OK_NODATA = 0x1100;
const RESP_OK_DISPLAY_INFO = 0x1101;
const RESP_OK_CAPSET_INFO = 0x1102;
const RESP_OK_CAPSET = 0x1103;
const RESP_OK_EDID = 0x1104;
const RESP_OK_RESOURCE_UUID = 0x1105;
const RESP_OK_MAP_INFO = 0x1106;
const RESP_ERR_UNSPEC = 0x1200;
const RESP_ERR_OUT_OF_MEMORY = 0x1201;
const RESP_ERR_INVALID_SCANOUT_ID = 0x1202;
const RESP_ERR_INVALID_RESOURCE_ID = 0x1203;
const RESP_ERR_INVALID_CONTEXT_ID = 0x1204;
const RESP_ERR_INVALID_PARAMETER = 0x1205;

const FLAG_FENCE = 1;
const FLAG_INFO_RING_IDX = 2;

const EVENT_DISPLAY = 1;

const HEADER_SIZE = 24;
const MAX_SCANOUTS = 16;
const MAX_BACKING_ENTRIES = 16384;
// What resources may take of host memory (as QEMU's max_hostmem)
const MAX_HOST_MEMORY = 256 << 20;

const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 768;

/**
 * The formats (all 4 bytes per pixel, named in memory order): how a pixel,
 * read as a little-endian word, becomes RGBA (opaque)
 * @type {!Object<number, function(number):number>}
 */
const TO_RGBA = {
    // B8G8R8A8, B8G8R8X8
    1: w => w >>> 16 & 0xFF | w & 0xFF00 | (w & 0xFF) << 16 | 0xFF000000,
    2: w => w >>> 16 & 0xFF | w & 0xFF00 | (w & 0xFF) << 16 | 0xFF000000,
    // A8R8G8B8, X8R8G8B8
    3: w => w >>> 8 | 0xFF000000,
    4: w => w >>> 8 | 0xFF000000,
    // R8G8B8A8, R8G8B8X8
    67: w => w | 0xFF000000,
    134: w => w | 0xFF000000,
    // X8B8G8R8, A8B8G8R8
    68: w => w >>> 24 | (w >>> 16 & 0xFF) << 8 | (w >>> 8 & 0xFF) << 16 | 0xFF000000,
    121: w => w >>> 24 | (w >>> 16 & 0xFF) << 8 | (w >>> 8 & 0xFF) << 16 | 0xFF000000,
};

/**
 * The formats with alpha: the byte that holds it, in the little-endian word
 * @type {!Object<number, number>}
 */
const ALPHA_SHIFT = { 1: 24, 67: 24, 3: 0, 121: 0 };

/**
 * A resource: a 2D image in host memory, and the guest pages it is copied from
 * @constructor
 */
function Resource(id, format, width, height)
{
    this.id = id;
    this.format = format;
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    /** @type {Float64Array} the backing: address, length, ... */
    this.backing = null;
    /** @type {Float64Array} where each entry starts in the backing */
    this.backing_starts = null;
    this.backing_length = 0;
    /** @type {Uint8Array} RESOURCE_ASSIGN_UUID's */
    this.uuid = null;
}

Resource.prototype.set_backing = function(entries)
{
    this.backing = entries;
    this.backing_starts = new Float64Array(entries.length / 2);
    let length = 0;
    for(let i = 0; i < entries.length; i += 2)
    {
        this.backing_starts[i / 2] = length;
        length += entries[i + 1];
    }
    this.backing_length = length;
};

/** BLOB_MEM_GUEST: a blob's storage is guest memory; HOST3D: a 3D resource
 * of the host's, from a template of PIPE_RESOURCE_CREATE */
const BLOB_MEM_GUEST = 1;
const BLOB_MEM_HOST3D = 2;
const BLOB_FLAG_USE_MAPPABLE = 1;
/** MAP_BLOB's answer: the guest may cache the mapping */
const MAP_CACHE_CACHED = 1;

/** The host visible memory (BAR4, shared memory region 1), at level hostmem;
 * at level venus, mapped Vulkan memory lives there too; at gfxstream also
 * each guest thread's ring, a MiB each (Cuttlefish's hostmem=256M: with 128
 * MiB, 30 minutes of monkey left the guest's kernel without room for new
 * threads' rings, and their first Vulkan call crashed) */
const HOST_VISIBLE_SIZE = 64 << 20;
const VENUS_HOST_VISIBLE_SIZE = 128 << 20;
const GFXSTREAM_HOST_VISIBLE_SIZE = 256 << 20;
/** what of it Vulkan's host visible heap says it has (the rest: rings, replies) */
const VENUS_MEMORY_SIZE = VENUS_HOST_VISIBLE_SIZE - (16 << 20);
const HOST_VISIBLE_SHMID = 1;

/**
 * The host visible memory of a level (0: none), the device memory the
 * machine reserves for it
 * @param {string} level
 * @return {number}
 */
export function host_visible_size(level)
{
    const l = LEVELS[level];
    return !l || !l.hostmem ? 0 : l.gfxstream ? GFXSTREAM_HOST_VISIBLE_SIZE : l.venus ? VENUS_HOST_VISIBLE_SIZE : HOST_VISIBLE_SIZE;
}
const PAGE = 4096;

/**
 * A blob resource in guest memory (RESOURCE_CREATE_BLOB, BLOB_MEM_GUEST):
 * no copy of the host's; a scanout shows it as SET_SCANOUT_BLOB describes
 * @constructor
 */
function BlobResource(id, flags, size)
{
    this.id = id;
    this.blob = true;
    this.flags = flags;
    this.size = size;
    this.backing = null;
    this.backing_starts = null;
    this.backing_length = 0;
    this.uuid = null;
}
BlobResource.prototype.set_backing = Resource.prototype.set_backing;

/**
 * A display of the guest's
 * @constructor
 */
function Scanout(index)
{
    this.index = index;
    // what the page would like (GET_DISPLAY_INFO, the EDID); scanout 0 is always on
    this.enabled = index === 0;
    this.host_width = DEFAULT_WIDTH;
    this.host_height = DEFAULT_HEIGHT;
    // SET_SCANOUT: the resource (0: none) and the rectangle of it shown
    this.resource_id = 0;
    this.x = 0;
    this.y = 0;
    this.width = 0;
    this.height = 0;
    // where it is on the page's picture
    this.screen_x = 0;
    this.screen_y = 0;
    /** SET_SCANOUT_BLOB: the blob's picture (format, width, height, stride, offset) */
    this.blob = null;
    /** @type {Uint8ClampedArray} the flushed picture, RGBA */
    this.rgba = null;
    /** @type {Array<number>} the part of it not yet sent: x0, y0, x1, y1 */
    this.dirty = null;
    /** the resource the renderer shows itself (SURFACE_PRESENT), 0 when the
     * picture is the device's: `rgba` is then behind the GPU's */
    this.direct = 0;
}

Scanout.prototype.add_dirty = function(x0, y0, x1, y1)
{
    if(x0 >= x1 || y0 >= y1) return;
    const d = this.dirty;
    this.dirty = d ? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)] : [x0, y0, x1, y1];
};

/**
 * In place of the VGA core on a machine without VGA: a blank text screen
 * while the driver has not taken over, nothing else
 * @constructor
 * @param {GraphicsMachine} machine
 */
function NoVGA(machine)
{
    this.display = machine.display;
    /** (no frame buffer: no address is in it) */
    this.lfb_address = Infinity;
    this.lfb_region = -1;
    this.svga_memory = new Uint8Array(0);
}
NoVGA.prototype.redisplay = function()
{
    this.display.set_mode(false);
    this.display.set_size_text(80, 25);
    this.display.clear_screen();
};
NoVGA.prototype.vblank_period = function() { return 1000 / 60; };
NoVGA.prototype.on_vblank = function() {};
NoVGA.prototype.invalidate = function() {};
NoVGA.prototype.render = function() {};
NoVGA.prototype.get_state = function() { return null; };
NoVGA.prototype.set_state = function(state) {};

/**
 * @constructor
 * @implements {DisplaySource}
 * @param {GraphicsMachine} machine
 * @param {{vram_size: (number|undefined), level: (string|undefined), scanouts: (number|undefined), renderer: (Object|undefined)}} options
 *     renderer: the channel to GX (the page's or a test's), which 3D needs
 */
export function VirtioGPU(machine, options)
{
    /** @const */
    this.machine = machine;
    /** @const */
    this.display = machine.display;

    /** @const the machine has VGA: the device is virtio-vga (else virtio-gpu, without VGA) */
    this.has_vga = machine.has_vga;
    const vram_size = options.vram_size || DEFAULT_VRAM_SIZE;
    if(this.has_vga && (vram_size < MIN_VRAM_SIZE || (vram_size & (vram_size - 1))))
    {
        throw new Error("virtio_gpu: vram_size must be a power of two of at least " + (MIN_VRAM_SIZE >> 20) + " MiB");
    }
    /** @const */
    this.vram_size = vram_size;

    this.level = options.level || (options.renderer ? DEFAULT_3D_LEVEL : DEFAULT_LEVEL);
    if(!LEVELS[this.level])
    {
        throw new Error("virtio_gpu: unknown level " + JSON.stringify(this.level) + "; levels: " + LEVEL_ORDER.join(", "));
    }
    if(LEVELS[this.level].three_d && !options.renderer)
    {
        throw new Error("virtio_gpu: level " + this.level + " needs a renderer (WebGPU)");
    }
    this.num_scanouts = Math.max(1, Math.min(MAX_SCANOUTS, options.scanouts || 1));

    // The VGA core: legacy VGA, VBE and the frame buffer (BAR0); this device
    // is the PCI function and the display source
    /** @const */
    this.vga = this.has_vga ? new VGAScreen(machine, vram_size, { pci: false, display_source: false }) :
        /** @type {?} */ (new NoVGA(machine));

    /** @type {!Map<number, (!Resource|!Resource3D|!BlobResource|!VenusBlob)>} 2D, 3D and blob resources */
    this.resources = new Map();
    this.host_memory = 0;
    /** @type {!Array<!Scanout>} */
    this.scanouts = [];
    for(let i = 0; i < this.num_scanouts; i++) this.scanouts.push(new Scanout(i));
    /** @const */
    this.cursor = new SoftwareCursor();
    this.events_read = 0;
    // the driver has sent a control command since the last reset: its
    // scanouts, not the VGA core, are on screen
    this.active = false;
    this.layout_key = "";
    /** a new layout went to the display: the next render sends all of the picture */
    this.layout_all = false;
    /** @type {Uint8ClampedArray} black, for displays that show nothing yet */
    this.blank = null;
    this.serial = 0x0086;
    /** What the driver has done, for harnesses and debugging */
    this.stats = { commands: {}, errors: 0, last_error: 0, transfers: 0, flushes: 0, cursor_updates: 0, cursor_moves: 0,
        /** the fences answered by lane ("" the global timeline, else ctx:ring): [count, the last fence id, its command] */
        fences: {},
        /** the first command the device failed on (an exception), answered with an error */
        failed_command: "" };
    /** @type {Virgl} 3D, at the virgl level */
    this.virgl = LEVELS[this.level].three_d ? new Virgl(this, /** @type {!Object} */ (options.renderer), !!LEVELS[this.level].gl43) : null;
    /** @type {Venus} Vulkan, at level venus */
    this.venus = LEVELS[this.level].venus ? new Venus(this, new VulkanModel({ host_visible_size: VENUS_MEMORY_SIZE, gpu: this })) : null;
    /** @type {!Array<!Object>} the kinds of context besides virgl's, each of
     * its capsets (CONTEXT_INIT): Venus (docs/gfxstream-plan.md G1) */
    /** @type {Gfxstream} gfxstream's contexts, at level gfxstream */
    this.gfxstream = LEVELS[this.level].gfxstream ? new Gfxstream(this, new VulkanModel({ host_visible_size: VENUS_MEMORY_SIZE, gpu: this })) : null;
    this.kinds = [this.venus, this.gfxstream].filter(Boolean);
    /** the capsets: [id, version, size] (gfxstream's alone at its level) */
    this.capsets = this.gfxstream ? this.gfxstream.capsets.slice() : this.virgl ? CAPSETS.concat(...this.kinds.map(kind => kind.capsets)) : [];
    /** @type {!Array<{request: !Object, bytes: !Uint8Array, response: !Uint8Array, ready: boolean}>}
     * control requests answered in the order they came: some wait for the GPU */
    this.pending = [];
    /** @type {?function(function())} set by a command whose answer waits */
    this.deferred = null;
    /** set with `deferred` by a command the ones after it wait for (virglrenderer runs
     * them in order: Venus's vkWaitRingSeqnoMESA before the blob of what the ring makes) */
    this.hold = false;
    this.held = false;
    /** a reset or a restore: answers and holds of the requests before it are not this machine's */
    this.generation = 0;
    /** @type {Array} a restored snapshot's requests not answered yet (get_state), queued again once its guest RAM is back */
    this.restored_requests = null;

    // The host visible memory: device memory of the core's, which the guest
    // reads and writes at memory speed; the pages it writes are uploaded into
    // the mapped blobs before each SUBMIT_3D, and blobs the GPU wrote are
    // read back into it before their fences complete
    this.hostmem_region = -1;
    this.hostmem_backing = 0;
    this.hostmem_size = host_visible_size(this.level) || HOST_VISIBLE_SIZE;
    /** @type {Uint32Array} pages written and not yet uploaded, as taken from the core */
    this.hostmem_pending = null;
    /** @type {!Map<number, (!Resource3D|!VenusBlob)>} the mapped blobs, by resource id */
    this.mapped = new Map();
    const bars = this.has_vga ? [{
        "bar": 0,
        "size": vram_size,
        "address": this.vga.lfb_address,
        "prefetchable": true,
        "on_move": base => this.vga.move_lfb(base),
    }] : [];
    // (without VGA, as QEMU's virtio-gpu-pci: BAR 2, 64 bits wide on the PCIe host)
    const hostmem_bar = this.has_vga ? 4 : 2;
    const shared_memory = [];
    if(LEVELS[this.level].hostmem)
    {
        this.hostmem_region = machine.mmio_ram_allocate(this.hostmem_size);
        if(this.hostmem_region < 0) throw new Error("virtio_gpu: no device memory for the host visible memory");
        this.hostmem_backing = machine.mmio_ram_backing(this.hostmem_region) >>> 0;
        this.hostmem_pending = new Uint32Array(Math.ceil(this.hostmem_size / PAGE / 64) * 2);
        // (a 32-bit BAR: the core decodes device memory below 4 GiB; the
        // firmware places it)
        bars.push({
            "bar": hostmem_bar,
            "size": this.hostmem_size,
            "address": 0,
            "prefetchable": true,
            "on_move": base => machine.mmio_ram_map(this.hostmem_region, base),
        });
        shared_memory.push({ "id": HOST_VISIBLE_SHMID, "bar": hostmem_bar, "offset": 0, "length": this.hostmem_size });
    }

    const features = LEVELS[this.level].features;
    this.virtio = machine.create_virtio({
        "name": "virtio-gpu",
        "device_id": VIRTIO_GPU_DEVICE_ID,
        "subsystem_device_id": VIRTIO_GPU_SUBSYSTEM_ID,
        "class_code": this.has_vga ? VGA_CLASS : DISPLAY_OTHER_CLASS,
        "revision": 1,
        "bars": bars,
        "shared_memory": shared_memory,
        // (as QEMU's virtio-vga; viogpudo maps only memory BARs)
        "capability_bar": 2,
        "pci_rom_size": this.has_vga ? this.vga.pci_rom_size : 0,
        "pci_rom_address": this.has_vga ? this.vga.pci_rom_address : 0,
        // (viogpudo needs QEMU's vector registers and ISR bits)
        "qemu_compatible": this.has_vga,
        "features": features,
        "queues": [{ "size": 256 }, { "size": 16 }],
        "config": [
            { "bytes": 4, "name": "events_read", "read": () => this.events_read },
            { "bytes": 4, "name": "events_clear", "read": () => 0, "write": value => { this.events_read &= ~value; } },
            { "bytes": 4, "name": "num_scanouts", "read": () => this.num_scanouts },
            { "bytes": 4, "name": "num_capsets", "read": () => this.capsets.length },
        ],
        "notify": queue => this.notify(queue),
        "reset": () => this.reset_device(),
    });

    machine.on_host_display_size((width, height, index) => this.set_host_size(index, width, height));
    // (Venus reads its rings whenever the machine's timers run)
    machine.display.add_timer(now => {
        if(this.restored_requests) this.requeue_restored();
        for(const kind of this.kinds) kind.timer(now);
        return 100;
    });
    this.display.add_source(this);
}

/**
 * The kind of context (Venus, ...) that has context ctx_id, or null (virgl's, or none)
 * @param {number} ctx_id
 * @return {Object}
 */
VirtioGPU.prototype.kind_of = function(ctx_id)
{
    return this.kinds.find(kind => kind.contexts.has(ctx_id)) || null;
};

/**
 * The kind of context of a capset, or null (virgl's)
 * @param {number} id
 * @return {Object}
 */
VirtioGPU.prototype.kind_of_capset = function(id)
{
    return this.kinds.find(kind => kind.capsets.some(c => c[0] === id)) || null;
};

/** A machine reset */
VirtioGPU.prototype.reset = function()
{
    this.virtio["reset"]();
};

/**
 * The driver reset the device (or the machine was reset): no resources, and
 * the VGA core is on screen again
 */
VirtioGPU.prototype.reset_device = function()
{
    // (requests popped before are stale: the transport drops their answers)
    this.forget_requests();
    if(this.virgl) this.virgl.reset();
    for(const kind of this.kinds) kind.reset();
    this.unmap_all();
    this.resources.clear();
    this.host_memory = 0;
    this.mapped.clear();
    if(this.hostmem_pending)
    {
        this.take_hostmem_dirty();
        this.hostmem_pending.fill(0);
    }
    for(const scanout of this.scanouts)
    {
        scanout.resource_id = 0;
        scanout.rgba = null;
        scanout.dirty = null;
    }
    this.cursor.reset();
    this.events_read = 0;
    this.set_active(false);
};

/** @param {boolean} active */
VirtioGPU.prototype.set_active = function(active)
{
    if(active === this.active) return;
    this.active = active;
    this.layout_key = "";
    if(!active)
    {
        // the core sends its mode and picture again
        this.vga.redisplay();
    }
};

/**
 * The page's size for a display: the guest learns it from GET_DISPLAY_INFO
 * and the EDID after a display event
 */
VirtioGPU.prototype.set_host_size = function(index, width, height)
{
    const scanout = this.scanouts[index];
    if(!scanout) return;
    const enabled = index === 0 || width > 0 && height > 0;
    if(width > 0 && height > 0)
    {
        width = Math.max(320, Math.min(8192, width));
        height = Math.max(200, Math.min(8192, height));
    }
    else
    {
        width = scanout.host_width;
        height = scanout.host_height;
    }
    if(enabled === scanout.enabled && width === scanout.host_width && height === scanout.host_height) return;
    scanout.enabled = enabled;
    scanout.host_width = width;
    scanout.host_height = height;
    this.events_read |= EVENT_DISPLAY;
    this.virtio["config_changed"]();
};

// ---------------------------------------------------------------------------
// The queues

VirtioGPU.prototype.notify = function(queue)
{
    let request;
    if(queue === CONTROLQ && this.restored_requests) this.requeue_restored();
    // (a request that holds the queue: the ones after it wait, unread)
    while(!(queue === CONTROLQ && this.held) && (request = this.virtio["pop_request"](queue)))
    {
        const bytes = request["read"]();
        if(queue === CONTROLQ)
        {
            this.set_active(true);
            // (a command the device fails on is answered, with an error: a
            // request left unanswered would hold its fence, and the guest, forever)
            let response;
            try
            {
                response = this.control(bytes);
            }
            catch(e)
            {
                if(!this.stats.failed_command) console.warn("virtio-gpu: a command failed:", e);
                this.stats.failed_command = String(e && e.stack || e);
                this.deferred = null;
                this.hold = false;
                response = this.error(RESP_ERR_UNSPEC, bytes.length >= 4 ? bytes[0] | bytes[1] << 8 : 0);
            }
            const wait = this.deferred, hold = this.hold;
            this.deferred = null;
            this.hold = false;
            this.enqueue(request, bytes, response, wait, hold);
        }
        else if(queue === CURSORQ)
        {
            this.cursor_command(bytes);
            request["complete"]();
        }
    }
    if(queue === CONTROLQ) this.drain();
    else this.virtio["flush"](queue);
};

/**
 * A control request's answer, after the ones before it: now, or once `wait`
 * calls back
 * @param {!Object} request
 * @param {!Uint8Array} bytes the request (its header, at least)
 * @param {!Uint8Array} response
 * @param {?function(function())} wait
 * @param {boolean} hold the requests after it wait, unread, until then
 */
VirtioGPU.prototype.enqueue = function(request, bytes, response, wait, hold)
{
    const entry = { request, bytes, response, ready: !wait, hold: !!wait && hold,
        /** a Venus or gfxstream submission's answer (their submit) */
        submission: wait && wait.submission || null,
        /** its lane of answers (timeline_of) */
        timeline: timeline_of(bytes) };
    this.pending.push(entry);
    if(!wait) return;
    if(entry.hold) this.held = true;
    const generation = this.generation;
    wait(() => {
        // (a request of before a reset or a restore: not this machine's)
        if(generation !== this.generation) return;
        entry.ready = true;
        this.drain();
        if(entry.hold && this.held)
        {
            this.held = false;
            this.notify(CONTROLQ);
        }
    });
};

/** A reset or a restore: the requests in progress are not answered, nor waited for */
VirtioGPU.prototype.forget_requests = function()
{
    this.generation++;
    this.pending = [];
    this.held = false;
    this.restored_requests = null;
};

/**
 * The requests a restored snapshot's machine had not answered, after the
 * restore (the device's state comes before the guest's RAM): answered again
 * in their order, a Venus submission run again from the command it waited
 * in (gfxstream's: its sync commands); those it held back are still in the
 * queue
 */
VirtioGPU.prototype.requeue_restored = function()
{
    const saved = /** @type {!Array} */ (this.restored_requests);
    this.restored_requests = null;
    for(const [head, header, response, ready, hold, submission] of saved)
    {
        const request = this.virtio["request_at"] && this.virtio["request_at"](CONTROLQ, head);
        if(!request) continue;
        const kind = this.venus || this.gfxstream;
        const wait = !ready && submission && kind ? kind.resubmit(submission) : null;
        this.enqueue(request, Uint8Array.from(header), Uint8Array.from(response), wait, hold);
    }
    this.drain();
};

/**
 * Before the resources go (a reset, a restore): the blobs are not mapped any
 * more, so that GPU reads still on their way do not land in the host visible
 * memory (a restored blob may be mapped where one of them was)
 */
VirtioGPU.prototype.unmap_all = function()
{
    for(const r of this.resources.values()) if(r.map_offset !== undefined) r.map_offset = -1;
};

/**
 * A request's lane of answers: a fence on a context's ring its own (that
 * timeline's, as rutabaga's fence contexts), the rest one lane in order
 * (docs/gfxstream-plan.md G1)
 * @param {!Uint8Array} bytes the request
 * @return {string}
 */
function timeline_of(bytes)
{
    const flags = bytes[4] | bytes[5] << 8 | bytes[6] << 16 | bytes[7] << 24;
    if(!(flags & FLAG_FENCE && flags & FLAG_INFO_RING_IDX)) return "";
    const ctx_id = (bytes[16] | bytes[17] << 8 | bytes[18] << 16 | bytes[19] << 24) >>> 0;
    return ctx_id + ":" + bytes[20];
}

/**
 * Answer the control requests that are ready, in order within each lane (a
 * fence must not pass the GPU work before it on its timeline; another
 * timeline's does not wait for it)
 */
VirtioGPU.prototype.drain = function()
{
    let answered = false;
    /** the lanes with a request waiting before */
    const blocked = new Set();
    for(let i = 0; i < this.pending.length;)
    {
        const entry = this.pending[i];
        if(!entry.ready || blocked.has(entry.timeline))
        {
            blocked.add(entry.timeline);
            i++;
            continue;
        }
        this.pending.splice(i, 1);
        this.respond(entry.request, entry.bytes, entry.response);
        entry.request["complete"]();
        answered = true;
    }
    if(answered) this.virtio["flush"](CONTROLQ);
};

/**
 * The response's header: its type, and the request's fence when it has one
 * @param {!Object} request
 * @param {!Uint8Array} bytes the request
 * @param {!Uint8Array} response with room for its header
 */
VirtioGPU.prototype.respond = function(request, bytes, response)
{
    if(bytes.length >= HEADER_SIZE)
    {
        const flags = bytes[4] | bytes[5] << 8 | bytes[6] << 16 | bytes[7] << 24;
        if(flags & FLAG_FENCE)
        {
            // fence_id, ctx_id, ring_idx
            response[4] = FLAG_FENCE | flags & FLAG_INFO_RING_IDX;
            response.set(bytes.subarray(8, 21), 8);
            const lane = timeline_of(bytes);
            const counts = this.stats.fences[lane] = this.stats.fences[lane] || [0, 0, 0];
            counts[0]++;
            counts[1] = bytes[8] | bytes[9] << 8 | bytes[10] << 16 | bytes[11] << 24;
            counts[2] = bytes[0] | bytes[1] << 8;
        }
    }
    request["write"](response);
};

/**
 * @param {number} type
 * @param {number=} size of the whole response
 * @return {!Uint8Array}
 */
function response(type, size)
{
    const out = new Uint8Array(size || HEADER_SIZE);
    out[0] = type & 0xFF;
    out[1] = type >> 8;
    return out;
}

/**
 * A control command
 * @param {!Uint8Array} bytes
 * @return {!Uint8Array} the response
 */
VirtioGPU.prototype.control = function(bytes)
{
    if(bytes.length < HEADER_SIZE) return this.error(RESP_ERR_UNSPEC, 0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = view.getUint32(0, true);
    this.stats.commands[type] = (this.stats.commands[type] || 0) + 1;
    const u32 = at => HEADER_SIZE + at + 4 <= bytes.length ? view.getUint32(HEADER_SIZE + at, true) : 0;
    const need = size => HEADER_SIZE + size <= bytes.length;

    switch(type)
    {
        case CMD_GET_DISPLAY_INFO:
            return this.display_info();
        case CMD_GET_EDID:
            if(!need(8)) break;
            return this.edid(u32(0));
        case CMD_RESOURCE_CREATE_2D:
            if(!need(16)) break;
            return this.create_2d(u32(0), u32(4), u32(8), u32(12));
        case CMD_RESOURCE_UNREF:
            if(!need(8)) break;
            return this.unref(u32(0));
        case CMD_SET_SCANOUT:
            if(!need(24)) break;
            return this.set_scanout(u32(16), u32(20), u32(0), u32(4), u32(8), u32(12));
        case CMD_RESOURCE_FLUSH:
            if(!need(24)) break;
            return this.flush(u32(16), u32(0), u32(4), u32(8), u32(12));
        case CMD_TRANSFER_TO_HOST_2D:
            if(!need(32)) break;
            return this.transfer_to_host(u32(24), u32(0), u32(4), u32(8), u32(12), u32(16) + u32(20) * 0x100000000);
        case CMD_RESOURCE_ATTACH_BACKING:
        {
            if(!need(8)) break;
            const count = u32(4);
            if(count > MAX_BACKING_ENTRIES || !need(8 + count * 16)) return this.error(RESP_ERR_INVALID_PARAMETER, type);
            const entries = new Float64Array(count * 2);
            for(let i = 0; i < count; i++)
            {
                entries[i * 2] = u32(8 + i * 16) + u32(12 + i * 16) * 0x100000000;
                entries[i * 2 + 1] = u32(16 + i * 16);
            }
            return this.attach_backing(u32(0), entries);
        }
        case CMD_RESOURCE_DETACH_BACKING:
            if(!need(8)) break;
            return this.detach_backing(u32(0));
        case CMD_RESOURCE_ASSIGN_UUID:
            if(!need(8)) break;
            return this.assign_uuid(u32(0));
        case CMD_RESOURCE_CREATE_BLOB:
        {
            // resource, memory, flags, entries, blob id (64), size (64), then the entries
            if(!LEVELS[this.level].blob || !need(32)) break;
            const count = u32(12);
            if(count > MAX_BACKING_ENTRIES || !need(32 + count * 16)) return this.error(RESP_ERR_INVALID_PARAMETER, type);
            const entries = new Float64Array(count * 2);
            for(let i = 0; i < count; i++)
            {
                entries[i * 2] = u32(32 + i * 16) + u32(36 + i * 16) * 0x100000000;
                entries[i * 2 + 1] = u32(40 + i * 16);
            }
            return this.create_blob(u32(0), u32(4), u32(8), u32(24) + u32(28) * 0x100000000, entries,
                view.getUint32(16, true), u32(16) + u32(20) * 0x100000000);
        }
        case CMD_RESOURCE_MAP_BLOB:
            // resource, padding, offset (64)
            if(!LEVELS[this.level].hostmem || !need(16)) break;
            return this.map_blob(u32(0), u32(8) + u32(12) * 0x100000000);
        case CMD_RESOURCE_UNMAP_BLOB:
            if(!LEVELS[this.level].hostmem || !need(8)) break;
            return this.unmap_blob(u32(0));
        case CMD_SET_SCANOUT_BLOB:
            // rectangle, scanout, resource, width, height, format, padding, strides[4], offsets[4]
            if(!LEVELS[this.level].blob || !need(72)) break;
            return this.set_scanout_blob(u32(16), u32(20), u32(0), u32(4), u32(8), u32(12),
                { width: u32(24), height: u32(28), format: u32(32), stride: u32(40), offset: u32(56) });
        case CMD_GET_CAPSET_INFO:
        {
            if(!need(8)) break;
            const entry = this.capsets[u32(0)];
            if(!entry) return this.error(RESP_ERR_INVALID_PARAMETER, type);
            const out = response(RESP_OK_CAPSET_INFO, HEADER_SIZE + 16);
            const v = new DataView(out.buffer);
            v.setUint32(HEADER_SIZE, entry[0], true);
            v.setUint32(HEADER_SIZE + 4, entry[1], true);
            v.setUint32(HEADER_SIZE + 8, entry[2], true);
            return out;
        }
        case CMD_GET_CAPSET:
        {
            if(!need(8)) break;
            const entry = this.capsets.find(c => c[0] === u32(0));
            if(!entry || u32(4) > entry[1]) return this.error(RESP_ERR_INVALID_PARAMETER, type);
            const kind = this.kind_of_capset(entry[0]);
            const data = kind ? kind.capset(entry[0]) : capset(entry[0], !!LEVELS[this.level].gl43, !!LEVELS[this.level].hostmem);
            const out = response(RESP_OK_CAPSET, HEADER_SIZE + data.length);
            out.set(data, HEADER_SIZE);
            return out;
        }
        case CMD_CTX_CREATE:
        case CMD_CTX_DESTROY:
        case CMD_CTX_ATTACH_RESOURCE:
        case CMD_CTX_DETACH_RESOURCE:
        case CMD_RESOURCE_CREATE_3D:
        case CMD_TRANSFER_TO_HOST_3D:
        case CMD_TRANSFER_FROM_HOST_3D:
        case CMD_SUBMIT_3D:
            if(!this.virgl) break;
            return this.command_3d(type, view.getUint32(16, true), bytes, u32, need);
    }
    return this.error(RESP_ERR_UNSPEC, type);
};

VirtioGPU.prototype.error = function(code, command)
{
    this.stats.errors++;
    this.stats.last_error = command << 16 | code & 0xFFFF;
    return response(code);
};

VirtioGPU.prototype.ok = function()
{
    return response(RESP_OK_NODATA);
};

/**
 * Where each enabled display is on the page: side by side, left to right
 */
VirtioGPU.prototype.place_scanouts = function()
{
    let x = 0;
    for(const scanout of this.scanouts)
    {
        scanout.screen_x = x;
        scanout.screen_y = 0;
        if(scanout.enabled) x += scanout.host_width;
    }
};

VirtioGPU.prototype.display_info = function()
{
    const out = response(RESP_OK_DISPLAY_INFO, HEADER_SIZE + MAX_SCANOUTS * 24);
    const view = new DataView(out.buffer);
    this.place_scanouts();
    for(const scanout of this.scanouts)
    {
        if(!scanout.enabled) continue;
        const at = HEADER_SIZE + scanout.index * 24;
        view.setUint32(at, scanout.screen_x, true);
        view.setUint32(at + 4, scanout.screen_y, true);
        view.setUint32(at + 8, scanout.host_width, true);
        view.setUint32(at + 12, scanout.host_height, true);
        view.setUint32(at + 16, 1, true);
    }
    return out;
};

VirtioGPU.prototype.edid = function(index)
{
    const scanout = this.scanouts[index];
    if(!scanout) return this.error(RESP_ERR_INVALID_PARAMETER, CMD_GET_EDID);
    const edid = make_edid(scanout.host_width, scanout.host_height, this.serial + index);
    const out = response(RESP_OK_EDID, HEADER_SIZE + 8 + 1024);
    new DataView(out.buffer).setUint32(HEADER_SIZE, edid.length, true);
    out.set(edid, HEADER_SIZE + 8);
    return out;
};

VirtioGPU.prototype.create_2d = function(id, format, width, height)
{
    if(id === 0 || this.resources.has(id)) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_CREATE_2D);
    if(!TO_RGBA[format] || !width || !height || width > 16384 || height > 16384)
    {
        return this.error(RESP_ERR_INVALID_PARAMETER, CMD_RESOURCE_CREATE_2D);
    }
    const bytes = width * height * 4;
    if(this.host_memory + bytes > MAX_HOST_MEMORY) return this.error(RESP_ERR_OUT_OF_MEMORY, CMD_RESOURCE_CREATE_2D);
    this.host_memory += bytes;
    this.resources.set(id, new Resource(id, format, width, height));
    return this.ok();
};

VirtioGPU.prototype.unref = function(id)
{
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_UNREF);
    // (as QEMU: the displays that show it are switched off)
    for(const scanout of this.scanouts)
    {
        if(scanout.resource_id === id) this.disable_scanout(scanout);
    }
    if(resource.kind)
    {
        // (what the guest wrote through its mapping stays in the memory)
        if(resource.map_offset >= 0) this.upload_hostmem();
        this.mapped.delete(id);
        resource.kind.unref_blob(resource);
        resource.map_offset = -1;
    }
    else if(resource.three_d)
    {
        this.mapped.delete(id);
        resource.map_offset = -1;
        if(!resource.pipe) this.virgl.destroy_resource(/** @type {!Resource3D} */ (resource));
    }
    else if(!resource.blob) this.host_memory -= resource.data.length;
    this.resources.delete(id);
    return this.ok();
};

/**
 * RESOURCE_CREATE_BLOB: in guest memory, or (level hostmem) a 3D resource of
 * the template that the context's PIPE_RESOURCE_CREATE gave the blob id
 */
VirtioGPU.prototype.create_blob = function(id, mem, flags, size, entries, ctx_id, blob_id)
{
    if(id === 0 || this.resources.has(id)) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_CREATE_BLOB);
    const kind = this.kind_of(ctx_id);
    if(kind)
    {
        // (Venus: shared memory (blob id 0) or a VkDeviceMemory's export, mappable)
        const blob = mem === BLOB_MEM_HOST3D ? kind.create_blob(id, ctx_id, flags, blob_id, size) : null;
        if(!blob) return this.error(RESP_ERR_INVALID_PARAMETER, CMD_RESOURCE_CREATE_BLOB);
        blob.kind = kind;
        this.resources.set(id, blob);
        return this.ok();
    }
    if(mem === BLOB_MEM_HOST3D && LEVELS[this.level].hostmem)
    {
        const virgl = /** @type {!Virgl} */ (this.virgl);
        const key = ctx_id + ":" + blob_id;
        const t = virgl.blob_templates.get(key);
        if(!t) return this.error(RESP_ERR_INVALID_PARAMETER, CMD_RESOURCE_CREATE_BLOB);
        virgl.blob_templates.delete(key);
        const r = new Resource3D(id, t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], t[9]);
        r.set_backing = Resource.prototype.set_backing;
        r.blob_flags = flags;
        r.blob_size = size;
        if(r.is_buffer() && size < r.width || !virgl.create_resource(r))
        {
            return this.error(RESP_ERR_INVALID_PARAMETER, CMD_RESOURCE_CREATE_BLOB);
        }
        this.resources.set(id, r);
        return this.ok();
    }
    if(mem !== BLOB_MEM_GUEST) return this.error(RESP_ERR_INVALID_PARAMETER, CMD_RESOURCE_CREATE_BLOB);
    const r = new BlobResource(id, flags, size);
    r.set_backing(entries);
    if(r.backing_length < size) return this.error(RESP_ERR_INVALID_PARAMETER, CMD_RESOURCE_CREATE_BLOB);
    this.resources.set(id, r);
    return this.ok();
};

/**
 * MAP_BLOB: a HOST3D blob's place in the host visible memory (the guest's
 * kernel allocates it). Buffers only: their mapping is their bytes.
 */
VirtioGPU.prototype.map_blob = function(id, offset)
{
    const found = this.resources.get(id);
    if(found && found.kind)
    {
        // (a blob of a kind of context's: Venus's)
        const blob = /** @type {!VenusBlob} */ (found);
        if(!(blob.blob_flags & BLOB_FLAG_USE_MAPPABLE)) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_MAP_BLOB);
        if(blob.map_offset >= 0 || offset % PAGE || offset + blob.blob_size > this.hostmem_size)
        {
            return this.error(RESP_ERR_INVALID_PARAMETER, CMD_RESOURCE_MAP_BLOB);
        }
        blob.map_offset = offset;
        this.mapped.set(id, blob);
        // (memory's contents may come from the GPU first)
        this.deferred = blob.kind.mapped(blob);
        const out = response(RESP_OK_MAP_INFO, HEADER_SIZE + 8);
        out[HEADER_SIZE] = MAP_CACHE_CACHED;
        return out;
    }
    if(!found || !found.three_d || found.blob_flags < 0 || !(found.blob_flags & BLOB_FLAG_USE_MAPPABLE))
    {
        return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_MAP_BLOB);
    }
    const r = /** @type {!Resource3D} */ (found);
    if(!r.is_buffer() || r.map_offset >= 0 || offset % PAGE || offset + r.blob_size > this.hostmem_size)
    {
        return this.error(RESP_ERR_INVALID_PARAMETER, CMD_RESOURCE_MAP_BLOB);
    }
    // the new buffer's bytes are zeros, as GX's
    this.take_hostmem_dirty();
    this.hostmem_bytes().fill(0, offset, offset + r.blob_size);
    this.for_pages(offset, r.blob_size, page => { this.hostmem_pending[page >>> 5] &= ~(1 << (page & 31)); });
    r.map_offset = offset;
    this.mapped.set(id, r);
    const out = response(RESP_OK_MAP_INFO, HEADER_SIZE + 8);
    out[HEADER_SIZE] = MAP_CACHE_CACHED;
    return out;
};

VirtioGPU.prototype.unmap_blob = function(id)
{
    const r = this.mapped.get(id);
    if(!r) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_UNMAP_BLOB);
    this.mapped.delete(id);
    r.map_offset = -1;
    return this.ok();
};

/** @return {!Uint8Array} the host visible memory, in the wasm memory */
VirtioGPU.prototype.hostmem_bytes = function()
{
    return new Uint8Array(this.machine.wasm_memory.buffer, this.hostmem_backing, this.hostmem_size);
};

/** @param {function(number)} f each page of [offset, offset + length) */
VirtioGPU.prototype.for_pages = function(offset, length, f)
{
    for(let page = Math.floor(offset / PAGE); page < Math.ceil((offset + length) / PAGE); page++) f(page);
};

/** The pages the guest wrote, from the core's bitmap into hostmem_pending */
VirtioGPU.prototype.take_hostmem_dirty = function()
{
    if(this.hostmem_region < 0) return;
    const at = this.machine.mmio_ram_take_dirty(this.hostmem_region) >>> 0;
    if(!at) return;
    const pending = this.hostmem_pending;
    // (64-bit words, little endian: the low dword's bits are the first pages)
    const words = new Uint32Array(this.machine.wasm_memory.buffer, at, pending.length);
    for(let i = 0; i < pending.length; i++) pending[i] |= words[i];
};

/**
 * Before the GPU runs what the guest sent: the pages of mappings the guest
 * wrote go into their blobs
 */
VirtioGPU.prototype.upload_hostmem = function()
{
    if(this.hostmem_region < 0) return;
    this.take_hostmem_dirty();
    const pending = this.hostmem_pending;
    if(!this.mapped.size || !pending.some(word => word !== 0))
    {
        pending.fill(0);
        return;
    }
    const bytes = this.hostmem_bytes();
    const gxw = /** @type {!Virgl} */ (this.virgl).gxw;
    for(const r of this.mapped.values())
    {
        const size = r.kind ? r.blob_size : r.width;
        const first = r.map_offset / PAGE, end = Math.ceil((r.map_offset + size) / PAGE);
        let run = -1;
        for(let page = first; page <= end; page++)
        {
            if(page < end && (pending[page >>> 5] >>> (page & 31) & 1))
            {
                if(r.readbacks) r.fresh.add(page);
                if(run < 0) run = page;
                continue;
            }
            if(run < 0) continue;
            // the run's bytes, as the buffer's (Venus: the memory's)
            const x = run * PAGE - r.map_offset, w = Math.min(size, page * PAGE - r.map_offset) - x;
            const data = bytes.subarray(r.map_offset + x, r.map_offset + x + w);
            if(r.kind) r.kind.upload_blob(r, x, data);
            else gxw.command(GX.SURFACE_UPLOAD, [r.id, 0, 0, x, 0, 0, w, 1, 1, w, w], data);
            run = -1;
        }
    }
    // (and the pages of no mapping are of no blob)
    pending.fill(0);
    /** @type {!Virgl} */ (this.virgl).flush_big();
};

/**
 * After the GPU work sent: the mapped blobs it wrote come back into their
 * mappings (before the fence completes), except for the pages the guest has
 * written since
 */
VirtioGPU.prototype.read_back_hostmem = function()
{
    const virgl = /** @type {!Virgl} */ (this.virgl);
    if(!virgl.written.size) return;
    for(const r of virgl.written)
    {
        if(r.map_offset < 0 || this.resources.get(r.id) !== r) continue;
        const offset = r.map_offset;
        r.readbacks++;
        virgl.read_buffer(r, 0, r.width, data => {
            r.readbacks--;
            if(data && r.map_offset === offset && this.resources.get(r.id) === r)
            {
                this.take_hostmem_dirty();
                const bytes = this.hostmem_bytes(), pending = this.hostmem_pending;
                for(let x = 0; x < data.length; x += PAGE)
                {
                    const page = (offset + x) / PAGE;
                    if(pending[page >>> 5] >>> (page & 31) & 1 || r.fresh.has(page)) continue;
                    bytes.set(data.subarray(x, Math.min(data.length, x + PAGE)), offset + x);
                }
            }
            if(!r.readbacks) r.fresh.clear();
        });
    }
    virgl.written.clear();
};

/**
 * SET_SCANOUT_BLOB: a scanout shows part of a blob, a picture of the given
 * format, size and stride from an offset
 */
VirtioGPU.prototype.set_scanout_blob = function(index, id, x, y, width, height, blob)
{
    const scanout = this.scanouts[index];
    if(!scanout) return this.error(RESP_ERR_INVALID_SCANOUT_ID, CMD_SET_SCANOUT_BLOB);
    if(id === 0)
    {
        this.disable_scanout(scanout);
        return this.ok();
    }
    const resource = this.resources.get(id);
    if(!resource || !resource.blob) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_SET_SCANOUT_BLOB);
    if(!TO_RGBA[blob.format] || width < 16 || height < 16 || x + width > blob.width || y + height > blob.height ||
        blob.stride < blob.width * 4 || blob.offset + blob.stride * (blob.height - 1) + blob.width * 4 > resource.backing_length)
    {
        return this.error(RESP_ERR_INVALID_PARAMETER, CMD_SET_SCANOUT_BLOB);
    }
    if(scanout.width !== width || scanout.height !== height || !scanout.rgba)
    {
        scanout.rgba = new Uint8ClampedArray(width * height * 4);
        this.layout_key = "";
    }
    Object.assign(scanout, { resource_id: id, x, y, width, height, blob });
    this.present(scanout, resource, 0, 0, width, height);
    return this.ok();
};

VirtioGPU.prototype.disable_scanout = function(scanout)
{
    if(scanout.direct) this.leave_direct(scanout);
    scanout.resource_id = 0;
    scanout.blob = null;
    scanout.width = scanout.height = 0;
    scanout.rgba = null;
    scanout.dirty = null;
    this.layout_key = "";
};

VirtioGPU.prototype.set_scanout = function(index, id, x, y, width, height)
{
    const scanout = this.scanouts[index];
    if(!scanout) return this.error(RESP_ERR_INVALID_SCANOUT_ID, CMD_SET_SCANOUT);
    if(id === 0)
    {
        this.disable_scanout(scanout);
        return this.ok();
    }
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_SET_SCANOUT);
    if(width < 16 || height < 16 || x + width > resource.width || y + height > resource.height)
    {
        return this.error(RESP_ERR_INVALID_PARAMETER, CMD_SET_SCANOUT);
    }
    if(scanout.width !== width || scanout.height !== height || !scanout.rgba)
    {
        scanout.rgba = new Uint8ClampedArray(width * height * 4);
        this.layout_key = "";
    }
    if(resource.blob) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_SET_SCANOUT);
    scanout.resource_id = id;
    scanout.x = x;
    scanout.y = y;
    scanout.width = width;
    scanout.height = height;
    scanout.blob = null;
    this.present(scanout, resource, 0, 0, width, height);
    return this.ok();
};

VirtioGPU.prototype.flush = function(id, x, y, width, height)
{
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_FLUSH);
    this.stats.flushes++;
    for(const scanout of this.scanouts)
    {
        if(scanout.resource_id !== id) continue;
        // the rectangle, in the scanout's coordinates
        const x0 = Math.max(x - scanout.x, 0), y0 = Math.max(y - scanout.y, 0);
        const x1 = Math.min(x + width - scanout.x, scanout.width), y1 = Math.min(y + height - scanout.y, scanout.height);
        if(x0 < x1 && y0 < y1) this.present(scanout, resource, x0, y0, x1 - x0, y1 - y0);
    }
    return this.ok();
};

/**
 * A rectangle of a scanout from its resource into its picture
 */
VirtioGPU.prototype.present = function(scanout, resource, x, y, width, height)
{
    const direct = resource.three_d && !(resource.host_newer && resource.data) && this.direct_scanout(scanout);
    if(scanout.direct && (!direct || scanout.direct !== resource.id))
    {
        // (back to the device's picture, or another resource: all of it again)
        this.leave_direct(scanout);
        x = 0;
        y = 0;
        width = scanout.width;
        height = scanout.height;
    }
    if(direct)
    {
        // (the renderer copies it to the page's screen on the GPU: no
        // readback, docs/gfxstream-plan.md G4)
        scanout.direct = resource.id;
        this.virgl.present_surface(/** @type {!Resource3D} */ (resource), scanout.x + x, scanout.y + y, width, height, x, y, scanout.width, scanout.height);
        return;
    }
    if(resource.blob)
    {
        // straight from guest memory, a row at a time
        const b = scanout.blob;
        if(!b) return;
        const convert = TO_RGBA[b.format];
        const row = new Uint8Array(width * 4), words = new Int32Array(row.buffer);
        const dst = new Int32Array(scanout.rgba.buffer);
        for(let r = y; r < y + height; r++)
        {
            const from = b.offset + (scanout.y + r) * b.stride + (scanout.x + x) * 4;
            if(!this.read_backing(resource, from, row, 0, row.length)) return;
            for(let i = 0, to = r * scanout.width + x; i < width; i++, to++) dst[to] = convert(words[i]);
        }
        scanout.add_dirty(x, y, x + width, y + height);
        return;
    }
    if(resource.three_d && !(resource.host_newer && resource.data))
    {
        // (its picture is on the GPU: read back, then converted)
        if(!TO_RGBA[resource.format]) return;
        this.virgl.read_picture(resource, scanout.x + x, scanout.y + y, width, height, (first, count) => {
            if(this.scanouts[scanout.index].resource_id !== resource.id || !scanout.rgba) return;
            this.convert(scanout, resource, x, first - scanout.y, width, count);
        });
        return;
    }
    this.convert(scanout, resource, x, y, width, height);
};

/**
 * Whether the renderer shows the scanout's 3D picture itself: it can (its
 * page's compositor), the scanout is the only one, and no cursor is drawn
 * over the device's picture
 * @param {!Scanout} scanout
 */
VirtioGPU.prototype.direct_scanout = function(scanout)
{
    return !!this.virgl && this.virgl.direct_present && !this.cursor.visible &&
        this.scanouts.every(s => s === scanout || !s.resource_id);
};

/** The renderer's picture of the scanout goes: the device's shows again */
VirtioGPU.prototype.leave_direct = function(scanout)
{
    scanout.direct = 0;
    this.virgl.present_surface(null, 0, 0, 0, 0, 0, 0, 0, 0);
};

/**
 * A rectangle of a scanout from its resource's host copy into its picture
 */
VirtioGPU.prototype.convert = function(scanout, resource, x, y, width, height)
{
    const convert = TO_RGBA[resource.format];
    const src = new Int32Array(resource.data.buffer);
    const dst = new Int32Array(scanout.rgba.buffer);
    for(let row = y; row < y + height; row++)
    {
        let from = (scanout.y + row) * resource.width + scanout.x + x;
        let to = row * scanout.width + x;
        for(const end = to + width; to < end; to++, from++) dst[to] = convert(src[from]);
    }
    scanout.add_dirty(x, y, x + width, y + height);
};

VirtioGPU.prototype.transfer_to_host = function(id, x, y, width, height, offset)
{
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_TRANSFER_TO_HOST_2D);
    // (a blob in guest memory has no host copy to fill)
    if(resource.blob) return this.ok();
    if(!resource.backing) return this.error(RESP_ERR_UNSPEC, CMD_TRANSFER_TO_HOST_2D);
    if(x + width > resource.width || y + height > resource.height || x + width < x || y + height < y)
    {
        return this.error(RESP_ERR_INVALID_PARAMETER, CMD_TRANSFER_TO_HOST_2D);
    }
    this.stats.transfers++;
    if(resource.three_d)
    {
        // a 3D resource the kernel treats as 2D (a dumb buffer: fbcon, KMS
        // clients): a host copy for the screen, and GX's copy for drawing
        if(!resource.data) resource.data = new Uint8Array(resource.width * resource.height * resource.block().bytes);
        const pitch = resource.width * resource.block().bytes;
        const read = (from, out, at, length) => this.read_backing(resource, from, out, at, length);
        if(!this.virgl.transfer_to_host(/** @type {!Resource3D} */ (resource), [x, y, 0, width, height, 1], 0, offset, pitch, 0, read))
        {
            return this.error(RESP_ERR_INVALID_PARAMETER, CMD_TRANSFER_TO_HOST_2D);
        }
        const bytes = resource.block().bytes;
        for(let h = 0; h < height; h++)
        {
            this.read_backing(resource, offset + pitch * h, resource.data, (y + h) * pitch + x * bytes, width * bytes);
        }
        resource.host_newer = true;
        return this.ok();
    }
    const stride = resource.width * 4, row = width * 4;
    if(offset === 0 && x === 0 && y === 0 && width === resource.width)
    {
        // (the whole of the first rows, in one go)
        if(!this.read_backing(resource, 0, resource.data, 0, stride * height))
        {
            return this.error(RESP_ERR_INVALID_PARAMETER, CMD_TRANSFER_TO_HOST_2D);
        }
        return this.ok();
    }
    for(let h = 0; h < height; h++)
    {
        if(!this.read_backing(resource, offset + stride * h, resource.data, (y + h) * stride + x * 4, row))
        {
            return this.error(RESP_ERR_INVALID_PARAMETER, CMD_TRANSFER_TO_HOST_2D);
        }
    }
    return this.ok();
};

/**
 * Bytes of a resource's backing (guest RAM, or the frame buffer in BAR0)
 * @param {(!Resource|!Resource3D|!BlobResource|!VenusBlob)} resource
 * @param {number} from the offset in the backing
 * @param {Uint8Array} out
 * @param {number} at
 * @param {number} length
 * @return {boolean} whether the backing has them
 */
VirtioGPU.prototype.read_backing = function(resource, from, out, at, length)
{
    if(from + length > resource.backing_length) return false;
    const starts = resource.backing_starts, entries = resource.backing;
    // the entry that holds `from`
    let low = 0, high = starts.length - 1;
    while(low < high)
    {
        const mid = low + high + 1 >> 1;
        if(starts[mid] <= from) low = mid;
        else high = mid - 1;
    }
    for(let i = low; length > 0; i++)
    {
        const skip = from - starts[i];
        const count = Math.min(entries[i * 2 + 1] - skip, length);
        if(count > 0)
        {
            const bytes = this.read_guest(entries[i * 2] + skip, count);
            if(!bytes) return false;
            out.set(bytes, at);
            at += count;
            from += count;
            length -= count;
        }
    }
    return true;
};

/**
 * @param {number} address
 * @param {number} length
 * @return {Uint8Array} a view or a copy, null if it is neither RAM nor the frame buffer
 */
VirtioGPU.prototype.read_guest = function(address, length)
{
    const lfb = this.vga.lfb_address;
    if(address >= lfb && address + length <= lfb + this.vram_size)
    {
        return this.vga.svga_memory.subarray(address - lfb, address - lfb + length);
    }
    if(!this.virtio["is_ram"](address, length)) return null;
    return this.virtio["read_memory"](address, length);
};

/**
 * Bytes into a resource's backing (a 3D readback)
 * @param {!Object} resource
 * @param {number} at the offset in the backing
 * @param {!Uint8Array} bytes
 */
VirtioGPU.prototype.write_backing = function(resource, at, bytes)
{
    if(!resource.backing || at + bytes.length > resource.backing_length) return;
    const starts = resource.backing_starts, entries = resource.backing;
    let low = 0, high = starts.length - 1;
    while(low < high)
    {
        const mid = low + high + 1 >> 1;
        if(starts[mid] <= at) low = mid;
        else high = mid - 1;
    }
    let done = 0;
    for(let i = low; done < bytes.length; i++)
    {
        const skip = at + done - starts[i];
        const count = Math.min(entries[i * 2 + 1] - skip, bytes.length - done);
        if(count <= 0) continue;
        const address = entries[i * 2] + skip, piece = bytes.subarray(done, done + count);
        const lfb = this.vga.lfb_address;
        if(address >= lfb && address + count <= lfb + this.vram_size)
        {
            this.vga.svga_memory.set(piece, address - lfb);
            this.machine.mmio_ram_mark_dirty(this.vga.lfb_region);
        }
        else if(this.virtio["is_ram"](address, count))
        {
            this.virtio["write_memory"](piece, address);
        }
        done += count;
    }
};

/**
 * The 3D commands (level virgl)
 * @param {number} type
 * @param {number} ctx_id from the request's header
 * @param {!Uint8Array} bytes the request
 * @param {function(number):number} u32 a dword after the header
 * @param {function(number):boolean} need
 * @return {!Uint8Array}
 */
VirtioGPU.prototype.command_3d = function(type, ctx_id, bytes, u32, need)
{
    const virgl = /** @type {!Virgl} */ (this.virgl);
    // the answer once the GPU has done what was sent so far (and `work`)
    const after_work = () => {
        let finish = null, finished = false;
        virgl.after_work(() => { finished = true; if(finish) finish(); });
        this.deferred = done => { if(finished) done(); else finish = done; };
    };
    switch(type)
    {
        case CMD_CTX_CREATE:
        {
            // name length, context_init (the capset in its low byte: virgl's or none), name
            const capset = LEVELS[this.level].features.includes(VIRTIO_GPU_F_CONTEXT_INIT) ? u32(4) & 0xFF : 0;
            if(capset && !this.capsets.some(c => c[0] === capset)) return this.error(RESP_ERR_INVALID_PARAMETER, type);
            // (a context of one kind: the others' of that id go; without a
            // capset, gfxstream's at its level)
            const kind = capset ? this.kind_of_capset(capset) : this.gfxstream;
            for(const other of this.kinds) if(other !== kind) other.destroy_context(ctx_id);
            if(kind)
            {
                virgl.destroy_context(ctx_id);
                kind.create_context(ctx_id, capset);
                return this.ok();
            }
            virgl.create_context(ctx_id);
            return this.ok();
        }
        case CMD_CTX_DESTROY:
            for(const kind of this.kinds) kind.destroy_context(ctx_id);
            virgl.destroy_context(ctx_id);
            return this.ok();
        case CMD_CTX_ATTACH_RESOURCE:
        case CMD_CTX_DETACH_RESOURCE:
            // (every context sees every resource)
            if(!need(8)) break;
            return this.resources.has(u32(0)) ? this.ok() : this.error(RESP_ERR_INVALID_RESOURCE_ID, type);
        case CMD_RESOURCE_CREATE_3D:
        {
            if(!need(48)) break;
            const id = u32(0);
            if(id === 0 || this.resources.has(id)) return this.error(RESP_ERR_INVALID_RESOURCE_ID, type);
            const r = new Resource3D(id, u32(4), u32(8), u32(12), u32(16), u32(20), u32(24), u32(28), u32(32), u32(36), u32(40));
            r.set_backing = Resource.prototype.set_backing;
            // (gfxstream's process pipe: a buffer of transfers, no texture of the GPU's)
            if(this.gfxstream && this.gfxstream.is_pipe(r.target, r.bind)) r.pipe = this.gfxstream.create_pipe();
            else if(!virgl.create_resource(r)) return this.error(RESP_ERR_INVALID_PARAMETER, type);
            this.resources.set(id, r);
            return this.ok();
        }
        case CMD_TRANSFER_TO_HOST_3D:
        case CMD_TRANSFER_FROM_HOST_3D:
        {
            if(!need(48)) break;
            const box = [u32(0), u32(4), u32(8), u32(12), u32(16), u32(20)];
            const offset = u32(24) + u32(28) * 0x100000000;
            const found = this.resources.get(u32(32));
            if(!found || !found.three_d) return this.error(RESP_ERR_INVALID_RESOURCE_ID, type);
            const r = /** @type {!Resource3D} */ (found);
            if(!r.backing) return this.error(RESP_ERR_UNSPEC, type);
            const level = u32(36), stride = u32(40), layer_stride = u32(44);
            if(r.pipe)
            {
                // a pipe: box x and width are the bytes of its buffer
                const gfxstream = /** @type {!Gfxstream} */ (this.gfxstream);
                if(type === CMD_TRANSFER_TO_HOST_3D)
                {
                    const data = new Uint8Array(box[3]);
                    if(!this.read_backing(r, box[0], data, 0, box[3])) return this.error(RESP_ERR_INVALID_PARAMETER, type);
                    gfxstream.pipe_write(r.pipe, data);
                }
                else this.write_backing(r, box[0], gfxstream.pipe_read(r.pipe, box[3]));
                return this.ok();
            }
            if(type === CMD_TRANSFER_TO_HOST_3D)
            {
                const read = (from, out, at, length) => this.read_backing(r, from, out, at, length);
                if(!virgl.transfer_to_host(r, box, level, offset, stride, layer_stride, read))
                {
                    return this.error(RESP_ERR_INVALID_PARAMETER, type);
                }
                return this.ok();
            }
            let finish = null, finished = false;
            virgl.transfer_from_host(r, box, level, offset, stride, layer_stride, (at, data) => { this.write_backing(r, at, data); return true; },
                () => { finished = true; if(finish) finish(); });
            this.deferred = done => { if(finished) done(); else finish = done; };
            return this.ok();
        }
        case CMD_SUBMIT_3D:
        {
            if(!need(8)) break;
            const size = u32(0);
            if(size & 3 || HEADER_SIZE + 8 + size > bytes.length) return this.error(RESP_ERR_INVALID_PARAMETER, type);
            const start = bytes.byteOffset + HEADER_SIZE + 8;
            const kind = this.kind_of(ctx_id);
            if(kind)
            {
                // (Venus's own commands: rings, waits; Vulkan work is in the rings)
                // (a fence on a queue's timeline: after the queue's work, as virglrenderer's)
                const flags = bytes[4] | bytes[5] << 8 | bytes[6] << 16 | bytes[7] << 24;
                const ring_idx = flags & FLAG_FENCE && flags & FLAG_INFO_RING_IDX ? bytes[20] : 0;
                this.deferred = kind.submit(ctx_id, new Uint8Array(bytes.buffer.slice(start, start + size)), ring_idx);
                // (Venus: the requests after it wait for it, as virglrenderer's;
                // gfxstream's sync tasks hold their fence only)
                this.hold = !!this.deferred && kind === this.venus;
                return this.ok();
            }
            if(!virgl.contexts.has(ctx_id)) return this.error(RESP_ERR_INVALID_CONTEXT_ID, type);
            const words = new Uint32Array(bytes.buffer.slice(start, start + size));
            this.upload_hostmem();
            virgl.submit(ctx_id, words, id => this.resources.get(id) || null);
            this.read_back_hostmem();
            after_work();
            return this.ok();
        }
    }
    return this.error(RESP_ERR_UNSPEC, type);
};

VirtioGPU.prototype.attach_backing = function(id, entries)
{
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_ATTACH_BACKING);
    if(resource.backing) return this.error(RESP_ERR_UNSPEC, CMD_RESOURCE_ATTACH_BACKING);
    resource.set_backing(entries);
    return this.ok();
};

VirtioGPU.prototype.detach_backing = function(id)
{
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_DETACH_BACKING);
    if(!resource.backing) return this.error(RESP_ERR_UNSPEC, CMD_RESOURCE_DETACH_BACKING);
    resource.backing = null;
    resource.backing_starts = null;
    resource.backing_length = 0;
    return this.ok();
};

VirtioGPU.prototype.assign_uuid = function(id)
{
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_ASSIGN_UUID);
    if(!resource.uuid)
    {
        // a version 4 UUID
        resource.uuid = new Uint8Array(16);
        for(let i = 0; i < 16; i++) resource.uuid[i] = Math.random() * 256;
        resource.uuid[6] = resource.uuid[6] & 0x0F | 0x40;
        resource.uuid[8] = resource.uuid[8] & 0x3F | 0x80;
    }
    const out = response(RESP_OK_RESOURCE_UUID, HEADER_SIZE + 16);
    out.set(resource.uuid, HEADER_SIZE);
    return out;
};

/**
 * UPDATE_CURSOR, MOVE_CURSOR: pos (scanout, x, y), resource, hot_x, hot_y
 * @param {!Uint8Array} bytes
 */
VirtioGPU.prototype.cursor_command = function(bytes)
{
    if(bytes.length < HEADER_SIZE + 16) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = view.getUint32(0, true);
    const scanout = this.scanouts[view.getUint32(HEADER_SIZE, true)] || this.scanouts[0];
    this.place_scanouts();
    const x = scanout.screen_x + view.getInt32(HEADER_SIZE + 4, true), y = scanout.screen_y + view.getInt32(HEADER_SIZE + 8, true);
    if(type === CMD_UPDATE_CURSOR && bytes.length >= HEADER_SIZE + 28)
    {
        this.stats.cursor_updates++;
        const id = view.getUint32(HEADER_SIZE + 16, true);
        let resource = this.resources.get(id);
        if(!resource)
        {
            this.cursor.move(x, y, false);
            return;
        }
        if(resource.blob)
        {
            // a cursor in guest memory: 64 x 64, ARGB (DRM's cursor planes)
            const data = new Uint8Array(64 * 64 * 4);
            if(!this.read_backing(resource, 0, data, 0, data.length)) return;
            resource = { format: 1, width: 64, height: 64, data, three_d: false };
        }
        const convert = TO_RGBA[resource.format], shift = ALPHA_SHIFT[resource.format];
        if(!convert) return;
        const hot_x = view.getUint32(HEADER_SIZE + 20, true), hot_y = view.getUint32(HEADER_SIZE + 24, true);
        const define = () => {
            const pixels = new Int32Array(resource.data.buffer);
            // premultiplied 0xAARRGGBB (as DRM's cursor planes are by default)
            this.cursor.define_alpha(hot_x, hot_y, resource.width, resource.height, i => {
                const rgba = convert(pixels[i]), alpha = shift === undefined ? 0xFF : pixels[i] >>> shift & 0xFF;
                return alpha << 24 | (rgba & 0xFF) << 16 | rgba & 0xFF00 | rgba >>> 16 & 0xFF;
            });
            this.cursor.move(x, y, true);
            this.cursor_shown();
        };
        if(resource.three_d && !(resource.host_newer && resource.data))
        {
            // (drawn on the GPU: read back first)
            this.virgl.read_picture(/** @type {!Resource3D} */ (resource), 0, 0, resource.width, resource.height, (first, count) => {
                if(first + count === resource.height && this.resources.get(id) === resource) define();
            });
            return;
        }
        define();
    }
    else if(type === CMD_MOVE_CURSOR)
    {
        this.stats.cursor_moves++;
        this.cursor.move(x, y, this.cursor.visible);
    }
    this.cursor_shown();
};

/** A cursor over a picture the renderer shows: the device's picture again, read back */
VirtioGPU.prototype.cursor_shown = function()
{
    if(!this.cursor.visible) return;
    for(const s of this.scanouts)
    {
        const r = s.direct && this.resources.get(s.resource_id);
        if(r) this.present(s, r, 0, 0, s.width, s.height);
    }
};

// ---------------------------------------------------------------------------
// The scanout

/** @override */
VirtioGPU.prototype.vblank_period = function()
{
    return this.active ? 1000 / 60 : this.vga.vblank_period();
};

/** @override */
VirtioGPU.prototype.on_vblank = function()
{
    this.vga.on_vblank();
    // (a new layout goes to the display now, not with the next render: a
    // page still in text mode asks for no frames, and without VGA nothing
    // else takes it out of it; a 3D scanout shown by the renderer needs the
    // screen at its size too)
    if(this.active)
    {
        this.place_scanouts();
        const shown = this.scanouts.filter(s => s.enabled || s.rgba);
        if(shown.some(s => s.rgba)) this.layout(shown);
    }
};

/** @override */
VirtioGPU.prototype.invalidate = function()
{
    if(this.active)
    {
        this.layout_key = "";
        this.cursor.drawn = null;
    }
    else
    {
        this.vga.invalidate();
    }
};

/**
 * The page's picture: the displays side by side (each the size it shows, or
 * the size the page asked for while it shows nothing). A new layout goes to
 * the display at once, and the next render sends all of the picture.
 * @param {!Array<!Scanout>} shown
 * @return {!Array<!Array<number>>} each display's box: x, y, width, height
 */
VirtioGPU.prototype.layout = function(shown)
{
    let width = 0, height = 0;
    const boxes = shown.map(s => {
        const w = s.rgba ? s.width : s.host_width, h = s.rgba ? s.height : s.host_height;
        const box = [width, 0, w, h];
        width += w;
        height = Math.max(height, h);
        return box;
    });
    const key = boxes.join(";");
    if(key !== this.layout_key)
    {
        this.layout_key = key;
        this.display.set_mode(true);
        this.display.set_size_graphical(width, height, width, height, 32);
        this.cursor.drawn = null;
        this.layout_all = true;
        if(!this.blank || this.blank.length < width * height * 4) this.blank = new Uint8ClampedArray(width * height * 4);
    }
    return boxes;
};

/** @override */
VirtioGPU.prototype.render = function()
{
    if(!this.active)
    {
        this.vga.render();
        return;
    }
    this.place_scanouts();
    const shown = this.scanouts.filter(s => s.enabled || s.rgba);
    const boxes = this.layout(shown);
    const all = this.layout_all;
    this.layout_all = false;
    const layers = [];
    shown.forEach((s, i) => {
        const [bx, by, bw, bh] = boxes[i];
        if(!s.rgba)
        {
            if(all) layers.push({ pixels: { data: this.blank, width: bw, height: bh }, screen_x: bx, screen_y: by,
                buffer_x: 0, buffer_y: 0, buffer_width: bw, buffer_height: bh });
            return;
        }
        const d = all ? [0, 0, s.width, s.height] : s.dirty;
        s.dirty = null;
        if(!d) return;
        layers.push({ pixels: { data: s.rgba, width: s.width, height: s.height }, screen_x: bx + d[0], screen_y: by + d[1],
            buffer_x: d[0], buffer_y: d[1], buffer_width: d[2] - d[0], buffer_height: d[3] - d[1] });
    });
    // the cursor, over whatever display it is on
    const at = (px, py) => {
        for(let i = 0; i < shown.length; i++)
        {
            const s = shown[i], [bx, , bw, bh] = boxes[i];
            if(s.rgba && px >= bx && py >= 0 && px < bx + bw && py < bh) return { s, sx: px - bx, sy: py, bx };
        }
        return null;
    };
    layers.push(...this.cursor.layers(
        (px, py) => {
            const hit = at(px, py);
            return hit ? { data: hit.s.rgba, at: (hit.sy * hit.s.width + hit.sx) * 4 } : null;
        },
        (rx, ry, w, h) => {
            const out = [];
            shown.forEach((s, i) => {
                if(!s.rgba) return;
                const [bx, , bw, bh] = boxes[i];
                const x0 = Math.max(rx, bx), y0 = Math.max(ry, 0), x1 = Math.min(rx + w, bx + bw), y1 = Math.min(ry + h, bh);
                if(x0 < x1 && y0 < y1)
                {
                    out.push({ pixels: { data: s.rgba, width: s.width, height: s.height }, screen_x: x0, screen_y: y0,
                        buffer_x: x0 - bx, buffer_y: y0, buffer_width: x1 - x0, buffer_height: y1 - y0 });
                }
            });
            return out;
        }));
    if(layers.length) this.display.update_buffer(layers);
};

// ---------------------------------------------------------------------------
// Snapshots

/**
 * Before a save: the GPU's work done, then the 3D resources' contents read
 * back (a snapshot keeps them: they are the host's, not in guest memory)
 */
VirtioGPU.prototype.prepare_save = function()
{
    const virgl = this.virgl;
    if(!virgl) return Promise.resolve(undefined);
    const resources = /** @type {!Array<!Resource3D>} */ ([...this.resources.values()].filter(r => r.three_d && !r.pipe));
    // (the mappings' newest bytes into their blobs, and back)
    this.upload_hostmem();
    const kind = this.venus || this.gfxstream;
    const done = () => new Promise(resolve => virgl.after_work(() => resolve(undefined)));
    return done().then(() => virgl.save_contents(resources)).then(() => {
        if(!kind) return undefined;
        // Venus, gfxstream: the requests that wait (SUBMIT_3D) answered, the
        // GPU's work done, then its memories' and images' contents read back
        return kind.settle(() => !this.pending.length).then(done).then(() => kind.vk.save_contents());
    });
};

/** 2: with the 3D resources and virgl's contexts; 3: with Venus's (and, since 2026-10-20, the requests not answered yet;
 * since 2026-10-24, at level gfxstream, gfxstream's in Venus's places and its process pipes) */
const STATE_VERSION = 3;

VirtioGPU.prototype.get_state = function()
{
    // (Venus's blobs and state, or at level gfxstream gfxstream's)
    const kind = this.venus || this.gfxstream;
    const resources = [], resources_3d = [], blobs = [], kind_blobs = [], pipes = [];
    for(const found of this.resources.values())
    {
        if(found.kind)
        {
            const b = /** @type {!VenusBlob} */ (found);
            kind_blobs.push([b.id, b.ctx_id, b.blob_id, b.blob_flags, b.blob_size, b.map_offset,
                b.map_offset >= 0 ? this.hostmem_bytes().slice(b.map_offset, b.map_offset + b.blob_size) : null]);
            continue;
        }
        if(found.pipe)
        {
            // (gfxstream's process pipes: a process keeps its own open)
            const r = /** @type {!Resource3D} */ (found);
            pipes.push([r.id, r.target, r.format, r.bind, r.width, r.height, r.depth, r.array_size, r.last_level, r.nr_samples, r.flags,
                r.backing, r.uuid, /** @type {!Gfxstream} */ (this.gfxstream).save_pipe(/** @type {!Object} */ (r.pipe))]);
            continue;
        }
        if(found.three_d)
        {
            const r = /** @type {!Resource3D} */ (found);
            resources_3d.push([r.id, r.target, r.format, r.bind, r.width, r.height, r.depth, r.array_size, r.last_level,
                r.nr_samples, r.flags, r.backing, r.uuid, r.saved || [], r.data, r.host_newer, r.blob_flags, r.blob_size,
                r.map_offset, r.map_offset >= 0 ? this.hostmem_bytes().slice(r.map_offset, r.map_offset + r.blob_size) : null]);
            continue;
        }
        if(found.blob)
        {
            blobs.push([found.id, found.flags, found.size, found.backing, found.uuid]);
            continue;
        }
        const r = /** @type {!Resource} */ (found);
        resources.push([r.id, r.format, r.width, r.height, r.data, r.backing, r.uuid]);
    }
    return [
        STATE_VERSION,
        this.level,
        this.num_scanouts,
        this.vga.get_state(),
        // (v86's own object: v86 saves and restores it)
        this.virtio["transport"](),
        resources,
        this.scanouts.map(s => [s.enabled, s.host_width, s.host_height, s.resource_id, s.x, s.y, s.width, s.height]),
        this.cursor.get_state(),
        this.events_read,
        this.active,
        resources_3d,
        this.virgl ? this.virgl.get_state() : null,
        blobs,
        this.scanouts.map(s => s.blob ? [s.blob.width, s.blob.height, s.blob.format, s.blob.stride, s.blob.offset] : null),
        kind_blobs,
        kind ? kind.get_state() : null,
        // the control requests not answered yet, in order: their heads in the
        // queue, headers and answers; a Venus submission's commands from the
        // one it waits in, a gfxstream one's sync commands (prepare_save
        // waits for them, a while at most)
        this.restored_requests || this.pending.filter(e => typeof e.request["head"] === "number").map(e => [e.request["head"],
            e.bytes.slice(0, HEADER_SIZE), e.response, e.ready, e.hold, e.submission && kind ? kind.save_submission(e.submission) : null]),
        pipes,
    ];
};

VirtioGPU.prototype.set_state = function(state)
{
    if(state[0] !== 1 && state[0] !== 2 && state[0] !== STATE_VERSION)
    {
        throw new Error("virtio_gpu: unsupported state version " + state[0]);
    }
    if(state[1] !== this.level || state[2] !== this.num_scanouts)
    {
        throw new Error("virtio_gpu: the snapshot is from level " + state[1] + " with " + state[2] +
            " displays; this device has level " + this.level + " with " + this.num_scanouts);
    }
    this.vga.set_state(state[3]);
    this.virtio["set_transport"](state[4]);
    this.forget_requests();
    this.unmap_all();
    this.resources.clear();
    this.host_memory = 0;
    this.mapped.clear();
    if(this.hostmem_pending)
    {
        // (what the guest wrote before belongs to the old machine)
        this.take_hostmem_dirty();
        this.hostmem_pending.fill(0);
    }
    for(const [id, format, width, height, data, backing, uuid] of state[5])
    {
        const r = new Resource(id, format, width, height);
        r.data.set(data);
        if(backing) r.set_backing(Float64Array.from(backing));
        r.uuid = uuid ? Uint8Array.from(uuid) : null;
        this.resources.set(id, r);
        this.host_memory += r.data.length;
    }
    for(const [id, flags, size, backing, uuid] of state[12] || [])
    {
        const r = new BlobResource(id, flags, size);
        if(backing) r.set_backing(Float64Array.from(backing));
        r.uuid = uuid ? Uint8Array.from(uuid) : null;
        this.resources.set(id, r);
    }
    (state[13] || []).forEach((b, i) => {
        if(b && this.scanouts[i]) this.scanouts[i].pending_blob = { width: b[0], height: b[1], format: b[2], stride: b[3], offset: b[4] };
    });
    // 3D: GX starts again from the resources and contexts saved
    if(this.virgl)
    {
        this.virgl.reset();
        for(const [id, target, format, bind, width, height, depth, array_size, last_level, nr_samples, flags, backing, uuid,
            saved, data, host_newer, blob_flags, blob_size, map_offset, mapping] of state[10] || [])
        {
            const r = new Resource3D(id, target, format, bind, width, height, depth, array_size, last_level, nr_samples, flags);
            if(blob_flags !== undefined && blob_flags >= 0)
            {
                r.blob_flags = blob_flags;
                r.blob_size = blob_size;
                if(map_offset >= 0 && mapping && this.hostmem_region >= 0)
                {
                    r.map_offset = map_offset;
                    this.hostmem_bytes().set(mapping, map_offset);
                    this.mapped.set(id, r);
                }
            }
            r.set_backing = Resource.prototype.set_backing;
            if(backing) r.set_backing(Float64Array.from(backing));
            r.uuid = uuid ? Uint8Array.from(uuid) : null;
            r.saved = saved;
            r.data = data ? Uint8Array.from(data) : null;
            r.host_newer = !!host_newer;
            this.resources.set(id, r);
            this.virgl.restore_resource(r);
            r.saved = null;
        }
        if(state[11]) this.virgl.set_state(state[11], id => this.resources.get(id) || null);
    }
    // Venus (or gfxstream): its blobs, mapped where they were, then its contexts
    const kind = this.venus || this.gfxstream;
    for(const [id, ctx_id, blob_id, flags, size, map_offset, mapping] of state[14] || [])
    {
        // (gfxstream's blobs are as Venus's to the device)
        const blob = /** @type {?} */ (this.venus ? new VenusBlob(id, ctx_id, blob_id, flags, size) : new GfxstreamBlob(id, ctx_id, blob_id, flags, size));
        blob.kind = kind;
        if(map_offset >= 0 && mapping && this.hostmem_region >= 0)
        {
            blob.map_offset = map_offset;
            this.hostmem_bytes().set(mapping, map_offset);
            this.mapped.set(id, blob);
        }
        this.resources.set(id, blob);
    }
    if(this.venus)
    {
        if(state[15]) this.venus.set_state(state[15], id => { const r = this.resources.get(id); return r && r.venus ? /** @type {!VenusBlob} */ (r) : null; });
        else this.venus.reset();
    }
    if(this.gfxstream)
    {
        const gfxstream = this.gfxstream;
        for(const [id, target, format, bind, width, height, depth, array_size, last_level, nr_samples, flags, backing, uuid, pipe] of state[17] || [])
        {
            const r = new Resource3D(id, target, format, bind, width, height, depth, array_size, last_level, nr_samples, flags);
            r.set_backing = Resource.prototype.set_backing;
            if(backing) r.set_backing(Float64Array.from(backing));
            r.uuid = uuid ? Uint8Array.from(uuid) : null;
            r.pipe = gfxstream.restore_pipe(pipe);
            this.resources.set(id, r);
        }
        if(state[15]) gfxstream.set_state(state[15], id => { const r = this.resources.get(id); return r instanceof GfxstreamBlob ? r : null; });
        else gfxstream.reset();
    }
    state[6].forEach(([enabled, host_width, host_height, resource_id, x, y, width, height], i) => {
        const s = this.scanouts[i];
        Object.assign(s, { enabled, host_width, host_height, resource_id: 0, x, y, width: 0, height: 0, rgba: null, dirty: null,
            blob: s.pending_blob || null });
        s.pending_blob = null;
        const resource = resource_id && this.resources.get(resource_id);
        if(resource)
        {
            s.rgba = new Uint8ClampedArray(width * height * 4);
            Object.assign(s, { resource_id, width, height });
            this.present(s, resource, 0, 0, width, height);
        }
    });
    this.cursor.set_state(state[7]);
    this.events_read = state[8];
    this.active = state[9];
    this.layout_key = "";
    if(!this.active) this.vga.redisplay();
    this.restored_requests = state[16] && state[16].length ? state[16] : null;
};
