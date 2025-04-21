// https://docs.oasis-open.org/virtio/virtio/v1.2/csd01/virtio-v1.2-csd01.html#x1-2900003

import { dbg_assert } from "./log.js";
import { VirtIO, VIRTIO_F_VERSION_1 } from "./virtio.js";
import { format_mac } from "./ne2k.js";
import * as marshall from "../lib/marshall.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

const VIRTIO_NET_F_MAC = 5;
const VIRTIO_NET_F_CTRL_VQ = 17;
const VIRTIO_NET_F_STATUS = 16;
const VIRTIO_NET_F_MQ = 22;
const VIRTIO_NET_F_CTRL_MAC_ADDR = 23;
const VIRTIO_NET_F_MTU = 3;

const VIRTIO_NET_CTRL_MQ_VQ_PAIRS_SET = 0;
const VIRTIO_NET_CTRL_MAC_ADDR_SET = 1;

/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 * @param {Boolean} preserve_mac_from_state_image
 */
export function VirtioNet(cpu, bus, preserve_mac_from_state_image)
{
    /** @const @type {BusConnector} */
    this.bus = bus;
    this.id = cpu.devices.net ? 1 : 0;
    this.pairs = 1;
    this.status = 1;
    this.preserve_mac_from_state_image = preserve_mac_from_state_image;
    this.mac = new Uint8Array([
        0x00, 0x22, 0x15,
        Math.random() * 255 | 0,
        Math.random() * 255 | 0,
        Math.random() * 255 | 0,
    ]);

    this.bus.send("net" + this.id + "-mac", format_mac(this.mac));

    const queues = [];

    for(let i = 0; i < this.pairs; ++i)
    {
        queues.push({size_supported: 1024, notify_offset: 0});
        queues.push({size_supported: 1024, notify_offset: 1});
    }
    queues.push({
        size_supported: 16,
        notify_offset: 2,
    });

    /** @type {VirtIO} */
    this.virtio = new VirtIO(cpu,
    {
        name: "virtio-net",
        pci_id: 0x0A << 3,
        device_id: 0x1041,
        subsystem_device_id: 1,
        common:
        {
            initial_port: 0xC800,
            queues: queues,
            features:
            [
                VIRTIO_NET_F_MAC,
                VIRTIO_NET_F_STATUS,
                VIRTIO_NET_F_MQ,
                VIRTIO_NET_F_MTU,
                VIRTIO_NET_F_CTRL_VQ,
                VIRTIO_NET_F_CTRL_MAC_ADDR,
                VIRTIO_F_VERSION_1,
            ],
            on_driver_ok: () => {},
        },
        notification:
        {
            initial_port: 0xC900,
            single_handler: false,
            handlers:
            [
                (queue_id) =>
                {

                },
                (queue_id) =>
                {
                    const queue = this.virtio.queues[queue_id];

                    while(queue.has_request())
                    {
                        const bufchain = queue.pop_request();
                        const buffer = new Uint8Array(bufchain.length_readable);
                        bufchain.get_next_blob(buffer);
                        this.bus.send("net" + this.id + "-send", buffer.subarray(12));
                        this.bus.send("eth-transmit-end", [buffer.length - 12]);
                        this.virtio.queues[queue_id].push_reply(bufchain);
                    }
                    this.virtio.queues[queue_id].flush_replies();
                },
                (queue_id) =>
                {
                    if(queue_id !== this.pairs * 2)
                    {
                        dbg_assert(false, "VirtioNet Notified for wrong queue: " + queue_id +
                            " (expected queue_id of 3)");
                        return;
                    }
                    const queue = this.virtio.queues[queue_id];

                    while(queue.has_request())
                    {
                        const bufchain = queue.pop_request();
                        const buffer = new Uint8Array(bufchain.length_readable);
                        bufchain.get_next_blob(buffer);


                        const parts = marshall.Unmarshall(["b", "b"], buffer, { offset : 0 });
                        const xclass = parts[0];
                        const command = parts[1];


                        //this.Ack(queue_id, bufchain);

                        switch(xclass << 8 | command) {
                            case 4 << 8 | VIRTIO_NET_CTRL_MQ_VQ_PAIRS_SET:
                                const data =  marshall.Unmarshall(["h"], buffer, { offset : 2 });
                                dbg_assert(data[0] === 1);
                                this.Send(queue_id, bufchain, new Uint8Array([0]));
                                break;
                            case 1 << 8 | VIRTIO_NET_CTRL_MAC_ADDR_SET:
                                this.mac = buffer.subarray(2, 8);
                                this.Send(queue_id, bufchain, new Uint8Array([0]));
                                this.bus.send("net" + this.id + "-mac", format_mac(this.mac));
                                break;
                            default:
                                dbg_assert(false," VirtioNet received unknown command: " + xclass + ":" + command);
                                this.Send(queue_id, bufchain, new Uint8Array([1]));
                                return;

                        }
                    }
                },
            ],
        },
        isr_status:
        {
            initial_port: 0xC700,
        },
        device_specific:
        {
            initial_port: 0xC600,
            struct:
            [0,1,2,3,4,5].map((v,k) => ({
                bytes: 1,
                name: "mac_" + k,
                read: () => this.mac[k],
                write: data => { /* read only */ },
            })).concat(
            [
                {
                    bytes: 2,
                    name: "status",
                    read: () => this.status,
                    write: data => { /* read only */ },
                },
                {
                    bytes: 2,
                    name: "max_pairs",
                    read: () => this.pairs,
                    write: data => { /* read only */ },
                },
                {
                    bytes: 2,
                    name: "mtu",
                    read: () => 1500,
                    write: data => {},
                }
           ])
        },
    });

    this.bus.register("net" + this.id + "-receive", data => {
        this.bus.send("eth-receive-end", [data.length]);
        const with_header = new Uint8Array(12 + data.byteLength);
        const view = new DataView(with_header.buffer, with_header.byteOffset, with_header.byteLength);
        view.setInt16(10, 1);
        with_header.set(data, 12);

        const queue = this.virtio.queues[0];
        if(queue.has_request()) {
            const bufchain = queue.pop_request();
            bufchain.set_next_blob(with_header);
            this.virtio.queues[0].push_reply(bufchain);
            this.virtio.queues[0].flush_replies();
        } else {
            console.log("No buffer to write into!");
        }
    }, this);

}


VirtioNet.prototype.get_state = function()
{
    const state = [];
    state[0] = this.virtio;
    state[1] = this.id;
    state[2] = this.mac;
    return state;
};

VirtioNet.prototype.set_state = function(state)
{
    this.virtio.set_state(state[0]);
    this.id = state[1];
    if(this.preserve_mac_from_state_image)
    {
        this.mac = state[2];
        this.bus.send("net" + this.id + "-mac", format_mac(this.mac));
    }
};

VirtioNet.prototype.reset = function() {
    this.virtio.reset();
};

VirtioNet.prototype.Send = function (queue_id, bufchain, blob)
{
    bufchain.set_next_blob(blob);
    this.virtio.queues[queue_id].push_reply(bufchain);
    this.virtio.queues[queue_id].flush_replies();
};

VirtioNet.prototype.Ack = function (queue_id, bufchain)
{
    //bufchain.set_next_blob(new Uint8Array(0));
    this.virtio.queues[queue_id].push_reply(bufchain);
    this.virtio.queues[queue_id].flush_replies();
};
