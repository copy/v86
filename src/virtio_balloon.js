// https://docs.oasis-open.org/virtio/virtio/v1.2/csd01/virtio-v1.2-csd01.html#x1-2900003

import { LOG_PCI } from "./const.js";
import { dbg_log } from "./log.js";
import { VirtIO, VIRTIO_F_VERSION_1 } from "./virtio.js";
import * as marshall from "../lib/marshall.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

const VIRTIO_BALLOON_F_MUST_TELL_HOST = 0;
const VIRTIO_BALLOON_F_STATS_VQ = 1;
const VIRTIO_BALLOON_F_DEFLATE_ON_OOM = 2;
const VIRTIO_BALLOON_F_FREE_PAGE_HINT = 3;

const STAT_NAMES = [
    "SWAP_IN",
    "SWAP_OUT",
    "MAJFLT",
    "MINFLT",
    "MEMFREE",
    "MEMTOT",
    "AVAIL",
    "CACHES",
    "HTLB_PGALLOC",
    "HTLB_PGFAIL",
];

/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 */
export function VirtioBalloon(cpu, bus)
{
    /** @const @type {BusConnector} */
    this.bus = bus;
    this.num_pages = 0;
    this.actual = 0;
    this.fp_cmd = 0;
    this.zeroed = 0;

    const queues = [
        {size_supported: 32, notify_offset: 0},
        {size_supported: 32, notify_offset: 0},
        {size_supported: 2, notify_offset: 1},
        {size_supported: 64, notify_offset: 2},
    ];

    //setInterval(() => this.GetStats(console.log.bind(console, "STATS")), 10000);

    /** @type {VirtIO} */
    this.virtio = new VirtIO(cpu,
    {
        name: "virtio-balloon",
        pci_id: 0x0B << 3,
        device_id: 0x1045,
        subsystem_device_id: 5,
        common:
        {
            initial_port: 0xD800,
            queues: queues,
            features:
            [
                VIRTIO_BALLOON_F_STATS_VQ,
                VIRTIO_BALLOON_F_FREE_PAGE_HINT,
                VIRTIO_F_VERSION_1,
            ],
            on_driver_ok: () => {
                dbg_log("Balloon setup", LOG_PCI);
            },
        },
        notification:
        {
            initial_port: 0xD900,
            single_handler: false,
            handlers:
            [
                (queue_id) =>
                {
                    const queue = this.virtio.queues[queue_id];
                    while(queue.has_request())
                    {
                        const bufchain = queue.pop_request();
                        const buffer = new Uint8Array(bufchain.length_readable);
                        bufchain.get_next_blob(buffer);
                        this.virtio.queues[queue_id].push_reply(bufchain);
                        let n = buffer.byteLength / 4;
                        this.actual += (queue_id === 0 ? n : -n);
                        //console.log(queue_id === 0 ? "Inflate" : "Deflate", this.num_pages, this.actual, bufchain.read_buffers);
                    }
                    this.virtio.queues[queue_id].flush_replies();
                },
                (queue_id) =>
                {
                    const queue = this.virtio.queues[queue_id];
                    if(queue.has_request())
                    {
                        const bufchain = queue.pop_request();
                        const buffer = new Uint8Array(bufchain.length_readable);
                        bufchain.get_next_blob(buffer);
                        let result = {};
                        for(let i = 0; i < bufchain.length_readable; i += 10) {
                            let [cat, value] = marshall.Unmarshall(["h", "d"], buffer, { offset : i });
                            result[STAT_NAMES[cat]] = value;
                        }
                        this.virtio.queues[queue_id].push_reply(bufchain);
                        if(this.stats_cb) this.stats_cb(result);
                    }
                },
                (queue_id) =>
                {
                    const queue = this.virtio.queues[queue_id];
                    while(queue.has_request())
                    {
                        const bufchain = queue.pop_request();
                        if(bufchain.length_readable > 0) {
                            const buffer = new Uint8Array(bufchain.length_readable);
                            bufchain.get_next_blob(buffer);
                            let [cmd] = marshall.Unmarshall(["w"], buffer, { offset : 0 });
                            if(cmd === 0) {
                                if(this.free_cb) this.free_cb(this.zeroed);
                                if(this.fp_cmd > 1) this.fp_cmd = 1; // Signal done
                                this.virtio.notify_config_changes();
                            }
                        }
                        if(bufchain.length_writable > 0) {
                            // console.log("Free pages hinted", bufchain.read_buffers, bufchain.write_buffers);
                            let zeros = new Uint8Array(0);
                            for(let i = 0; i < bufchain.write_buffers.length; ++i) {
                                let b = bufchain.write_buffers[i];
                                this.zeroed += b.len;
                                this.virtio.cpu.zero_memory(b.addr_low, b.len);
                            }
                        }
                        this.virtio.queues[queue_id].push_reply(bufchain);
                    }
                    this.virtio.queues[queue_id].flush_replies();
                },
            ],
        },
        isr_status:
        {
            initial_port: 0xD700,
        },
        device_specific:
        {
            initial_port: 0xD600,
            struct:
            [
                {
                    bytes: 4,
                    name: "num_pages",
                    read: () => this.num_pages,
                    write: data => { /* read only */ },
                },
                {
                    bytes: 4,
                    name: "actual",
                    read: () => {
                        return this.actual;
                    },
                    write: data => { /* read only */ },
                },
                {
                    bytes: 4,
                    name: "free_page_hint_cmd_id",
                    read: () => this.fp_cmd,
                    write: data => { /* read only */ },
                }
           ]
        },
    });
}

VirtioBalloon.prototype.Inflate = function(amount) {
    this.num_pages += amount;
    this.virtio.notify_config_changes();
};

VirtioBalloon.prototype.Deflate = function(amount) {
    this.num_pages -= amount;
    this.virtio.notify_config_changes();
};

VirtioBalloon.prototype.Cleanup = function(cb) {
    this.fp_cmd = 2;
    this.free_cb = cb;
    this.zeroed = 0;
    this.virtio.notify_config_changes();
};


VirtioBalloon.prototype.get_state = function()
{
    const state = [];
    state[0] = this.virtio;
    state[1] = this.num_pages;
    state[2] = this.actual;
    return state;
};

VirtioBalloon.prototype.set_state = function(state)
{
    this.virtio.set_state(state[0]);
    this.num_pages = state[1];
    this.actual = state[2];
};

VirtioBalloon.prototype.GetStats = function(data)
{
    this.stats_cb = data;
    const queue = this.virtio.queues[2];
    while(queue.has_request())
    {
        const bufchain = queue.pop_request();
        this.virtio.queues[2].push_reply(bufchain);
    }
    this.virtio.queues[2].flush_replies();
};

VirtioBalloon.prototype.Reset = function() {

};
