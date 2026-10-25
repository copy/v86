// The virtio-mmio transport, version 2 (virtio 1.2 section 4.2;
// docs/arm64-virt-android16-plan.md P5.3) of the virt machine: a slot of
// 0x200 bytes in VIRT_MMIO's block (src/virt/platform.js) with the device's
// registers, its configuration from 0x100, and an edge-triggered SPI
// (16 + the slot, as the reference's: QEMU's hw/arm/virt.c create_virtio_devices).
// The device itself is src/virtio.js's core: the registers map onto the
// fields of the capabilities it describes for virtio-pci, by name.
//
// The legacy transport, version 1 (virtio 1.2 section 4.2.4; the ranchu
// machine's: Linux 3.10 drives no other): the features without
// VIRTIO_F_VERSION_1, a queue placed by its page frame number (GuestPageSize,
// QueueAlign, QueuePFN: the descriptors, the available ring after them, the
// used ring aligned after that), no QueueReady.

import { dbg_assert } from "./log.js";

const MAGIC = 0x74726976; // "virt"
const VERSION = 2;
const VENDOR = 0x554D4551; // "QEMU", as the reference's

// register offsets (the legacy transport's own: GuestPageSize, QueueAlign, QueuePFN)
const R_GUEST_PAGE_SIZE = 0x028;
const R_QUEUE_ALIGN = 0x03C;
const R_QUEUE_PFN = 0x040;
const R_MAGIC = 0x000;
const R_VERSION = 0x004;
const R_DEVICE_ID = 0x008;
const R_VENDOR_ID = 0x00C;
const R_DEVICE_FEATURES = 0x010;
const R_DEVICE_FEATURES_SEL = 0x014;
const R_DRIVER_FEATURES = 0x020;
const R_DRIVER_FEATURES_SEL = 0x024;
const R_QUEUE_SEL = 0x030;
const R_QUEUE_NUM_MAX = 0x034;
const R_QUEUE_NUM = 0x038;
const R_QUEUE_READY = 0x044;
const R_QUEUE_NOTIFY = 0x050;
const R_INTERRUPT_STATUS = 0x060;
const R_INTERRUPT_ACK = 0x064;
const R_STATUS = 0x070;
const R_QUEUE_DESC_LOW = 0x080;
const R_QUEUE_DESC_HIGH = 0x084;
const R_QUEUE_DRIVER_LOW = 0x090;
const R_QUEUE_DRIVER_HIGH = 0x094;
const R_QUEUE_DEVICE_LOW = 0x0A0;
const R_QUEUE_DEVICE_HIGH = 0x0A4;
const R_SHM_SEL = 0x0AC;
const R_SHM_LEN_LOW = 0x0B0;
const R_SHM_LEN_HIGH = 0x0B4;
const R_SHM_BASE_LOW = 0x0B8;
const R_SHM_BASE_HIGH = 0x0BC;
const R_CONFIG_GENERATION = 0x0FC;
const R_CONFIG = 0x100;

/** A virtio PCI device ID's virtio device ID (0x1040 + id for modern devices) */
export function virtio_device_id(pci_device_id)
{
    dbg_assert(pci_device_id >= 0x1041 && pci_device_id <= 0x107F, "not a modern virtio PCI device ID");
    return pci_device_id - 0x1040;
}

/**
 * The transport of one slot. The machine (src/arm/cpu.js) owns the slots'
 * address ranges and hands this transport the slot's accesses.
 * @constructor
 * @param {{set_irq: function(number, boolean)}} cpu
 * @param {number} slot 0-31
 * @param {number} intid the slot's interrupt (SPI 16 + slot: INTID 48 + slot)
 * @param {boolean=} legacy the legacy transport (version 1)
 */
export function VirtioMmio(cpu, slot, intid, legacy = false)
{
    this.cpu = cpu;
    this.slot = slot;
    this.intid = intid;
    this.legacy = legacy;
    /** (legacy) the guest's page size, the queues' alignment and page frame numbers */
    this.guest_page_size = 4096;
    this.queue_align = 4096;
    /** @type {!Array<number>} */
    this.queue_pfn = [];
    /** @type {?Object} the device's core (src/virtio.js VirtIO), once attached */
    this.virtio = null;
    /** @type {!Object<string, {read: function():number, write: function(number)}>} the common fields by name */
    this.common = {};
    /** @type {!Array<{offset: number, bytes: number, read: function():number, write: function(number)}>} */
    this.config = [];
    this.config_size = 0;
    /** @type {!Array<{write: function(number)}>} queue notification fields by queue (common config's, written with the queue's index) */
    this.notify = [];
    /** @type {!Array<{id: number, bar: number, offset: number, length: number, base: number}>} shared memory regions */
    this.shared_memory = [];
    this.shm_select = 0;
    this.level = false;
    this.irq_line = {
        raise: () => this.update_irq(),
        lower: () => this.update_irq(),
    };
}

VirtioMmio.prototype.kind = function() { return "mmio"; };
VirtioMmio.prototype.present = function() { return true; };

/**
 * (VirtIO's constructor) the device's capabilities: the common
 * configuration's fields, the notification handlers, the device's
 * configuration, its shared memory regions (the base: where the machine put
 * the BAR, VirtioMmio.set_shared_memory_base)
 */
VirtioMmio.prototype.attach = function(virtio, capabilities, shared_memory)
{
    this.virtio = virtio;
    for(const cap of capabilities)
    {
        if(cap.type === 1)
        {
            for(const field of cap.struct) this.common[field.name] = field;
        }
        else if(cap.type === 2)
        {
            // (queue q notifies the handler at its notify_offset, or the single one)
            const handlers = cap.struct;
            this.notify = virtio.queues.map(queue => handlers.length === 1 ? handlers[0] : handlers[queue.notify_offset]);
        }
        else if(cap.type === 4)
        {
            let offset = 0;
            for(const field of cap.struct)
            {
                this.config.push({ offset, bytes: field.bytes, read: field.read, write: field.write });
                offset += field.bytes;
            }
            this.config_size = offset;
        }
    }
    this.shared_memory = shared_memory.map(region => ({ id: region.id, bar: region.bar, offset: region.offset, length: region.length, base: -1 }));
};

/**
 * The device's shared memory regions: id, the device's memory (as a BAR
 * number) and the offset in it, length
 * @return {!Array<{id: number, bar: number, offset: number, length: number}>}
 */
VirtioMmio.prototype.shared_memory_regions = function()
{
    return this.shared_memory.map(({ id, bar, offset, length }) => ({ id, bar, offset, length }));
};

/** Where a shared memory region (by id) is in the physical address space */
VirtioMmio.prototype.set_shared_memory_base = function(id, base)
{
    const region = this.shared_memory.find(r => r.id === id);
    if(region) region.base = base;
};

VirtioMmio.prototype.update_irq = function()
{
    // (the line is high while InterruptStatus has a bit: an edge per 0 -> 1)
    const level = this.virtio.isr_status !== 0;
    if(level !== this.level)
    {
        this.level = level;
        this.cpu.set_irq(this.intid, level);
    }
};

/** A field of the common configuration */
VirtioMmio.prototype.field = function(name)
{
    const field = this.common[name];
    dbg_assert(field, "virtio-mmio: no common field " + name);
    return field;
};

/** The bytes [offset, offset + width) of the device's configuration, little endian */
VirtioMmio.prototype.config_read = function(offset, width)
{
    const exact = this.config.find(f => f.offset === offset && f.bytes === width);
    if(exact)
    {
        const value = exact.read();
        return width === 4 ? value >>> 0 : value;
    }
    let value = 0;
    for(let i = 0; i < width; i++)
    {
        const at = offset + i;
        const field = this.config.find(f => at >= f.offset && at < f.offset + f.bytes);
        const byte = field ? field.read() >>> 8 * (at - field.offset) & 0xFF : 0;
        value += byte * 2 ** (8 * i);
    }
    return value;
};

VirtioMmio.prototype.config_write = function(offset, width, value)
{
    const exact = this.config.find(f => f.offset === offset && f.bytes === width);
    if(exact)
    {
        exact.write(value);
        return;
    }
    // (part of a field: read, merge, write it whole)
    for(let i = 0; i < width; i++)
    {
        const at = offset + i;
        const field = this.config.find(f => at >= f.offset && at < f.offset + f.bytes);
        if(!field) continue;
        const shift = 8 * (at - field.offset);
        const old = field.read();
        field.write((old & ~(0xFF << shift) | (Math.floor(value / 2 ** (8 * i)) & 0xFF) << shift) >>> 0);
    }
};

/** (the machine's MmioHandler) a register read */
VirtioMmio.prototype.read = function(offset, width)
{
    const virtio = this.virtio;
    if(offset >= R_CONFIG)
    {
        // (the driver reads the generation around the configuration: it stays fresh)
        virtio.update_config_generation();
        return this.config_read(offset - R_CONFIG, width);
    }
    if(width !== 4) return 0;
    const queue = virtio.queue_selected;
    switch(offset)
    {
        case R_MAGIC: return MAGIC;
        case R_VERSION: return this.legacy ? 1 : VERSION;
        case R_DEVICE_ID: return virtio_device_id(virtio.device_id);
        case R_VENDOR_ID: return VENDOR;
        case R_DEVICE_FEATURES:
        {
            const features = this.field("device_feature").read() >>> 0;
            // (a legacy device: not VIRTIO_F_VERSION_1, bit 32)
            return this.legacy && virtio.device_feature_select === 1 ? (features & ~1) >>> 0 : features;
        }
        case R_QUEUE_PFN: return this.legacy ? this.queue_pfn[virtio.queue_select] || 0 : 0;
        case R_DEVICE_FEATURES_SEL: return virtio.device_feature_select;
        case R_QUEUE_NUM_MAX: return queue ? queue.size_supported : 0;
        case R_QUEUE_READY: return queue ? queue.enabled | 0 : 0;
        case R_INTERRUPT_STATUS: return virtio.isr_status;
        case R_STATUS: return virtio.device_status;
        case R_QUEUE_DESC_LOW: return queue ? queue.address_words[0] >>> 0 : 0;
        case R_QUEUE_DESC_HIGH: return queue ? queue.address_words[1] >>> 0 : 0;
        case R_QUEUE_DRIVER_LOW: return queue ? queue.address_words[2] >>> 0 : 0;
        case R_QUEUE_DRIVER_HIGH: return queue ? queue.address_words[3] >>> 0 : 0;
        case R_QUEUE_DEVICE_LOW: return queue ? queue.address_words[4] >>> 0 : 0;
        case R_QUEUE_DEVICE_HIGH: return queue ? queue.address_words[5] >>> 0 : 0;
        case R_SHM_LEN_LOW:
        case R_SHM_LEN_HIGH:
        case R_SHM_BASE_LOW:
        case R_SHM_BASE_HIGH:
        {
            // (a region that does not exist: all ones)
            const region = this.shared_memory.find(r => r.id === this.shm_select);
            if(!region || region.base < 0) return 0xFFFFFFFF;
            const value = offset < R_SHM_BASE_LOW ? region.length : region.base;
            return offset & 4 ? Math.floor(value / 0x100000000) >>> 0 : value >>> 0;
        }
        case R_CONFIG_GENERATION:
            virtio.update_config_generation();
            return virtio.config_generation;
        default: return 0;
    }
};

/** (the machine's MmioHandler) a register write */
VirtioMmio.prototype.write = function(offset, width, value)
{
    const virtio = this.virtio;
    if(offset >= R_CONFIG)
    {
        this.config_write(offset - R_CONFIG, width, Number(value));
        return;
    }
    if(width !== 4) return;
    value = Number(value) >>> 0;
    const queue = virtio.queue_selected;
    switch(offset)
    {
        case R_DEVICE_FEATURES_SEL: this.field("device_feature_select").write(value); break;
        case R_DRIVER_FEATURES: this.field("driver_feature").write(value); break;
        case R_DRIVER_FEATURES_SEL: this.field("driver_feature_select").write(value); break;
        case R_QUEUE_SEL: this.field("queue_select").write(value); break;
        case R_QUEUE_NUM: this.field("queue_size").write(value); break;
        case R_QUEUE_READY:
            if(!queue) break;
            if(value & 1) this.field("queue_enable").write(1);
            // (0: the queue is taken back, its state forgotten)
            else if(queue.enabled) queue.reset();
            break;
        case R_QUEUE_NOTIFY:
        {
            const handler = this.notify[value & 0xFFFF];
            if(handler) handler.write(value & 0xFFFF);
            break;
        }
        case R_INTERRUPT_ACK:
            virtio.isr_status &= ~value;
            this.update_irq();
            break;
        case R_STATUS:
            this.field("device_status").write(value & 0xFF);
            // (a legacy driver's reset: the queues' pages too)
            if(this.legacy && value === 0) this.queue_pfn = [];
            break;
        case R_GUEST_PAGE_SIZE: if(this.legacy) this.guest_page_size = value || 4096; break;
        case R_QUEUE_ALIGN: if(this.legacy) this.queue_align = value || 4096; break;
        case R_QUEUE_PFN:
        {
            if(!this.legacy || !queue) break;
            this.queue_pfn[virtio.queue_select] = value;
            if(!value)
            {
                if(queue.enabled) queue.reset();
                break;
            }
            // (the split ring in one place: 16 bytes a descriptor; the
            // available ring's flags, index, ring and used_event; the used ring aligned)
            const size = queue.size;
            const desc = value * this.guest_page_size;
            const avail = desc + 16 * size;
            const used = Math.ceil((avail + 6 + 2 * size) / this.queue_align) * this.queue_align;
            const set = (name, address) => {
                this.field(name + " (low dword)").write(address >>> 0);
                this.field(name + " (high dword)").write(Math.floor(address / 0x100000000) >>> 0);
            };
            set("queue_desc", desc);
            set("queue_avail", avail);
            set("queue_used", used);
            this.field("queue_enable").write(1);
            break;
        }
        case R_QUEUE_DESC_LOW: this.field("queue_desc (low dword)").write(value); break;
        case R_QUEUE_DESC_HIGH: this.field("queue_desc (high dword)").write(value); break;
        case R_QUEUE_DRIVER_LOW: this.field("queue_avail (low dword)").write(value); break;
        case R_QUEUE_DRIVER_HIGH: this.field("queue_avail (high dword)").write(value); break;
        case R_QUEUE_DEVICE_LOW: this.field("queue_used (low dword)").write(value); break;
        case R_QUEUE_DEVICE_HIGH: this.field("queue_used (high dword)").write(value); break;
        case R_SHM_SEL: this.shm_select = value; break;
    }
};

/** (snapshots, P5.9) the transport's own registers */
VirtioMmio.prototype.get_state = function()
{
    return [this.slot, this.shm_select, this.level, this.legacy ? [this.guest_page_size, this.queue_align, this.queue_pfn.slice()] : null];
};

VirtioMmio.prototype.set_state = function(state)
{
    if(state[0] !== this.slot)
    {
        throw new Error("The snapshot has the virtio device in slot " + state[0] + ", this machine in " + this.slot);
    }
    this.shm_select = state[1];
    this.level = state[2];
    if(this.legacy && state[3]) [this.guest_page_size, this.queue_align, this.queue_pfn] = state[3];
    this.cpu.set_irq(this.intid, this.level);
};
