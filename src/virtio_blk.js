// virtio-blk (virtio 1.2 section 5.2; docs/arm64-virt-android16-plan.md
// P5.4) as a built-in device of the virt machine: reads, writes, FLUSH,
// read-only disks, the capacity, SEG_MAX and BLK_SIZE, and GET_ID (the
// disk's `id`, e.g. the probe disk's "a64probe", which Linux shows as
// /dev/disk/by-id/virtio-<id>). The image is behind a BlockBackend: writes
// stay in its in-memory overlay for the session. The image may be in a
// container format (src/image/, docs/disk-image-formats-plan.md): a read or
// write the image fails ends with VIRTIO_BLK_S_IOERR, and a snapshot's
// changes are restored only onto the same image. BLK_SIZE is the image's
// logical sector size (512, or 4096: logical_sector_size); the requests and
// the capacity still count 512-byte sectors, as the specification has them,
// and, as in QEMU, a read or write must cover whole logical sectors (IOERR
// otherwise).

import { VirtIO, VIRTIO_F_VERSION_1 } from "./virtio.js";
import { BlockBackend } from "./block_backend.js";
import { check_disk_state, restore_disk_state } from "./disk_writeback.js";
import { dbg_assert } from "./log.js";

// feature bits
const VIRTIO_BLK_F_SEG_MAX = 2;
const VIRTIO_BLK_F_RO = 5;
const VIRTIO_BLK_F_BLK_SIZE = 6;
const VIRTIO_BLK_F_FLUSH = 9;

// request types
const VIRTIO_BLK_T_IN = 0;
const VIRTIO_BLK_T_OUT = 1;
const VIRTIO_BLK_T_FLUSH = 4;
const VIRTIO_BLK_T_GET_ID = 8;

// request status
const VIRTIO_BLK_S_OK = 0;
const VIRTIO_BLK_S_IOERR = 1;
const VIRTIO_BLK_S_UNSUPP = 2;

const SECTOR = 512;
const QUEUE_SIZE = 256;
const ID_BYTES = 20;

/**
 * @constructor
 * @param {?} cpu
 * @param {?} buffer the image (src/buffer.js)
 * @param {{id: (string|undefined), readonly: (boolean|undefined), name: (string|undefined)}} options
 *   name: the disk's (hda, hdb, virtio_disk<n>): export_disk_image, errors
 * @param {?} transport the device's transport (src/virtio_mmio.js), or null: on the PCIe host at `pci_id`
 * @param {number=} pci_id
 */
export function VirtioBlk(cpu, buffer, options, transport, pci_id)
{
    dbg_assert(transport || pci_id !== undefined && cpu.devices.pci.generic, "virtio-blk: on the virt machine's transports only");
    this.cpu = cpu;
    this.name = options.name || "virtio-blk";
    this.backend = new BlockBackend(cpu, buffer);
    this.readonly = !!options.readonly;
    this.id = new Uint8Array(ID_BYTES);
    this.id.set(new TextEncoder().encode(options.id || "").subarray(0, ID_BYTES));
    this.sectors = Math.floor(buffer.byteLength / SECTOR);
    /** the disk's logical sectors, in bytes (blk_size) */
    this.block_size = buffer.logical_sector_size || SECTOR;
    /**
     * The image's SHA-256 as it was loaded (P5.9: a snapshot records it, a
     * restore checks it), once computed; images held in memory only
     * @type {string}
     */
    this.image_sha256 = "";
    if(buffer.buffer instanceof ArrayBuffer && globalThis.crypto?.subtle)
    {
        globalThis.crypto.subtle.digest("SHA-256", buffer.buffer).then(digest =>
        {
            this.image_sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
        }, () => {});
    }

    const features = [VIRTIO_BLK_F_SEG_MAX, VIRTIO_BLK_F_BLK_SIZE, VIRTIO_BLK_F_FLUSH, VIRTIO_F_VERSION_1];
    if(this.readonly) features.push(VIRTIO_BLK_F_RO);
    const constant = (bytes, name, value) => ({ bytes, name, read: () => value, write: () => {} });

    /** @type {VirtIO} */
    this.virtio = new VirtIO(cpu,
    {
        name: "virtio-blk",
        device_id: 0x1042,
        subsystem_device_id: 2,
        common:
        {
            queues: [{ size_supported: QUEUE_SIZE, notify_offset: 0 }],
            features,
            on_driver_ok: () => {},
        },
        notification:
        {
            single_handler: true,
            handlers: [queue_id => this.process(this.virtio.queues[queue_id])],
        },
        isr_status: {},
        device_specific:
        {
            offset: 0,
            struct:
            [
                // capacity, in 512-byte sectors (a u64: the driver reads it as two words)
                constant(4, "capacity (low dword)", this.sectors >>> 0),
                constant(4, "capacity (high dword)", Math.floor(this.sectors / 0x100000000)),
                constant(4, "size_max", 0),
                constant(4, "seg_max", QUEUE_SIZE - 2),
                constant(2, "cylinders", 0),
                constant(1, "heads", 0),
                constant(1, "sectors", 0),
                constant(4, "blk_size", this.block_size),
            ],
        },
        on_reset: () => this.backend.reset(),
        transport: transport || undefined,
        pci_id,
    });
}

/**
 * The requests the driver queued
 * @param {?} queue
 */
VirtioBlk.prototype.process = function(queue)
{
    while(queue.has_request())
    {
        const chain = queue.pop_request();
        const header = new Uint8Array(16);
        chain.get_next_blob(header);
        const view = new DataView(header.buffer);
        const type = view.getUint32(0, true);
        const sector = view.getUint32(8, true) + view.getUint32(12, true) * 0x100000000;
        // (the status byte is the last writable one)
        const readable = chain.length_readable - 16;
        const writable = chain.length_writable - 1;
        const done = status =>
        {
            // (a read that failed, or a short GET_ID: the status goes after
            // the data area all the same, which reads as zeroes)
            if(chain.length_written < writable) chain.set_next_blob(new Uint8Array(writable - chain.length_written));
            chain.set_next_blob(new Uint8Array([status]));
            queue.push_reply(chain);
            queue.flush_replies();
        };
        // (QEMU's virtio_blk_sect_range_ok: whole logical sectors, within the disk)
        const in_range = length => sector * SECTOR + length <= this.sectors * SECTOR &&
            sector * SECTOR % this.block_size === 0 && length % this.block_size === 0;
        switch(type)
        {
            case VIRTIO_BLK_T_IN:
                if(writable < 0 || !in_range(writable)) { done(VIRTIO_BLK_S_IOERR); break; }
                if(writable === 0) { done(VIRTIO_BLK_S_OK); break; }
                this.backend.read(sector * SECTOR, writable, data =>
                {
                    chain.set_next_blob(data);
                    done(VIRTIO_BLK_S_OK);
                }, () => done(VIRTIO_BLK_S_IOERR));
                break;
            case VIRTIO_BLK_T_OUT:
            {
                if(this.readonly || !in_range(readable)) { done(VIRTIO_BLK_S_IOERR); break; }
                const data = new Uint8Array(readable);
                chain.get_next_blob(data);
                this.backend.write(sector * SECTOR, data, () => done(VIRTIO_BLK_S_OK), () => done(VIRTIO_BLK_S_IOERR));
                break;
            }
            case VIRTIO_BLK_T_FLUSH:
                this.backend.when_writes_done(() => done(VIRTIO_BLK_S_OK), () => done(VIRTIO_BLK_S_IOERR));
                break;
            case VIRTIO_BLK_T_GET_ID:
                chain.set_next_blob(this.id.subarray(0, Math.max(0, Math.min(ID_BYTES, writable))));
                done(VIRTIO_BLK_S_OK);
                break;
            default:
                done(VIRTIO_BLK_S_UNSUPP);
        }
    }
};

VirtioBlk.prototype.reset = function()
{
    this.virtio.reset();
};

/**
 * (P5.9) the device; a writable disk's contents as the controllers' do
 * (src/ide.js: the buffer's own state, all of it or the blocks written); a
 * read-only one's only the image's size and SHA-256, checked on restore
 */
VirtioBlk.prototype.get_state = function()
{
    return [this.virtio, this.readonly ? null : this.backend.buffer, this.backend.byte_length, this.image_sha256, this.block_size];
};

/**
 * Whether a snapshot's state of this disk can be restored, checked before
 * anything is (A64CPU.validate_state): the same size, the same image (an
 * image in memory by its SHA-256; a disk image in a container format by
 * its identity, docs/disk-image-formats-plan.md P1)
 * @param {*} state
 */
VirtioBlk.prototype.check_state = function(state)
{
    if(state[2] !== undefined && state[2] !== this.backend.byte_length)
    {
        throw new Error("The snapshot's virtio-blk disk has " + state[2] + " bytes, this one " + this.backend.byte_length);
    }
    if((state[4] || SECTOR) !== this.block_size)
    {
        throw new Error("The snapshot's virtio-blk disk has " + (state[4] || SECTOR) + "-byte sectors, this one " + this.block_size);
    }
    if(state[3] && this.image_sha256 && state[3] !== this.image_sha256)
    {
        throw new Error("The snapshot's virtio-blk disk is another image (SHA-256 " + state[3] + ", this one " + this.image_sha256 + ")");
    }
    if(this.readonly) return;
    // (and a disk written back: src/disk_writeback.js)
    check_disk_state(this.name, this.backend.buffer, state[1]);
};

VirtioBlk.prototype.set_state = function(state)
{
    this.check_state(state);
    // (requests in flight belong to the state left behind)
    this.backend.reset();
    this.virtio.set_state(state[0]);
    if(state[1] && !this.readonly) restore_disk_state(this.backend.buffer, state[1]);
};
