import { dbg_assert } from "./log.js";
import { VirtIO, VIRTIO_F_VERSION_1 } from "./virtio.js";
import * as marshall from "../lib/marshall.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

// https://docs.oasis-open.org/virtio/virtio/v1.2/csd01/virtio-v1.2-csd01.html#x1-2900003

const VIRTIO_CONSOLE_DEVICE_READY     = 0;
const VIRTIO_CONSOLE_DEVICE_ADD       = 1;
const VIRTIO_CONSOLE_DEVICE_REMOVE    = 2;
const VIRTIO_CONSOLE_PORT_READY       = 3;
const VIRTIO_CONSOLE_CONSOLE_PORT     = 4;
const VIRTIO_CONSOLE_RESIZE           = 5;
const VIRTIO_CONSOLE_PORT_OPEN        = 6;
const VIRTIO_CONSOLE_PORT_NAME        = 7;

const VIRTIO_CONSOLE_F_SIZE           = 0;
const VIRTIO_CONSOLE_F_MULTIPORT      = 1;
const VIRTIO_CONSOLE_F_EMERG_WRITE    = 2;

/**
 * @constructor
 *
 * @param {CPU} cpu
 */
export function VirtioConsole(cpu, bus)
{
    /** @const @type {BusConnector} */
    this.bus = bus;
    this.rows = 25;
    this.cols = 80;
    this.ports = 4;

    const queues = [
        {
            size_supported: 16,
            notify_offset: 0,
        },
        {
            size_supported: 16,
            notify_offset: 1,
        },
        {
            size_supported: 16,
            notify_offset: 2,
        },
        {
            size_supported: 16,
            notify_offset: 3,
        },
    ];

    for(let i = 1; i < this.ports; ++i)
    {
        queues.push({size_supported: 16, notify_offset: 0});
        queues.push({size_supported: 8, notify_offset: 1});
    }

    /** @type {VirtIO} */
    this.virtio = new VirtIO(cpu,
    {
        name: "virtio-console",
        pci_id: 0x0C << 3,
        device_id: 0x1043,
        subsystem_device_id: 3,
        common:
        {
            initial_port: 0xB800,
            queues: queues,
            features:
            [
                VIRTIO_CONSOLE_F_SIZE,
                VIRTIO_CONSOLE_F_MULTIPORT,
                VIRTIO_F_VERSION_1,
            ],
            on_driver_ok: () => {},
        },
        notification:
        {
            initial_port: 0xB900,
            single_handler: false,
            handlers:
            [
                (queue_id) =>
                {

                },
                (queue_id) =>
                {
                    const queue = this.virtio.queues[queue_id];
                    const port = queue_id > 3 ? (queue_id-3 >> 1) : 0;
                    while(queue.has_request())
                    {
                        const bufchain = queue.pop_request();
                        const buffer = new Uint8Array(bufchain.length_readable);
                        bufchain.get_next_blob(buffer);
                        this.bus.send("virtio-console" + port + "-output-bytes", buffer);
                        this.Ack(queue_id, bufchain);
                    }
                },
                (queue_id) =>
                {
                    if(queue_id !== 2)
                    {
                        dbg_assert(false, "VirtioConsole Notified for wrong queue: " + queue_id +
                            " (expected queue_id of 2)");

                    }

                },
                (queue_id) =>
                {
                    if(queue_id !== 3)
                    {
                        dbg_assert(false, "VirtioConsole Notified for wrong queue: " + queue_id +
                            " (expected queue_id of 3)");
                        return;
                    }
                    const queue = this.virtio.queues[queue_id];

                    while(queue.has_request())
                    {
                        const bufchain = queue.pop_request();
                        const buffer = new Uint8Array(bufchain.length_readable);
                        bufchain.get_next_blob(buffer);


                        const parts = marshall.Unmarshall(["w", "h", "h"], buffer, { offset : 0 });
                        const port = parts[0];
                        const event = parts[1];
                        const value = parts[2];


                        this.Ack(queue_id, bufchain);

                        switch(event) {
                            case VIRTIO_CONSOLE_DEVICE_READY:
                                for(let i = 0; i < this.ports; ++i) {
                                    this.SendEvent(i, VIRTIO_CONSOLE_DEVICE_ADD, 0);
                                }
                                break;
                            case VIRTIO_CONSOLE_PORT_READY:
                                this.Ack(queue_id, bufchain);
                                this.SendEvent(port, VIRTIO_CONSOLE_CONSOLE_PORT, 1);
                                this.SendName(port, "virtio-" + port);
                                this.SendEvent(port, VIRTIO_CONSOLE_PORT_OPEN, 1);

                                break;
                            case VIRTIO_CONSOLE_PORT_OPEN:
                                this.Ack(queue_id, bufchain);
                                if(port === 0) {
                                    this.SendWindowSize(port);
                                }
                                break;
                            default:
                                dbg_assert(false," VirtioConsole received unknown event: " + event[1]);
                                return;

                        }
                    }
                },
            ],
        },
        isr_status:
        {
            initial_port: 0xB700,
        },
        device_specific:
        {
            initial_port: 0xB600,
            struct:
            [
                {
                    bytes: 2,
                    name: "cols",
                    read: () => this.cols,
                    write: data => { /* read only */ },
                },
                {
                    bytes: 2,
                    name: "rows",
                    read: () => this.rows,
                    write: data => { /* read only */ },
                },
                {
                    bytes: 4,
                    name: "max_nr_ports",
                    read: () => this.ports,
                    write: data => { /* read only */ },
                },
                {
                    bytes: 4,
                    name: "emerg_wr",
                    read: () => 0,
                    write: data => {
                        dbg_assert(false, "Emergency write!");
                    },
                },
           ]
        },
    });

    for(let port = 0; port < this.ports; ++port) {
        const queue_id = port === 0 ? 0 : port * 2 + 2;
        this.bus.register("virtio-console" + port + "-input-bytes", function(data) {
            const queue = this.virtio.queues[queue_id];
            if(queue.has_request()) {
                const bufchain = queue.pop_request();
                this.Send(queue_id, bufchain, new Uint8Array(data));
            } else {
                //TODO: Buffer
            }
        }, this);

        this.bus.register("virtio-console" + port + "-resize", function(size) {
            if(port === 0) {
                this.cols = size[0];
                this.rows = size[1];
            }

            if(this.virtio.queues[2].is_configured() && this.virtio.queues[2].has_request()) {
                this.SendWindowSize(port, size[0], size[1]);
            }
        }, this);
    }
}

VirtioConsole.prototype.SendWindowSize = function(port, cols = undefined, rows = undefined)
{
    rows = rows || this.rows;
    cols = cols || this.cols;
    const bufchain = this.virtio.queues[2].pop_request();
    const buf = new Uint8Array(12);
    marshall.Marshall(["w", "h", "h", "h", "h"], [port, VIRTIO_CONSOLE_RESIZE, 0, rows, cols], buf, 0);
    this.Send(2, bufchain, buf);
};

VirtioConsole.prototype.SendName = function(port, name)
{
    const bufchain = this.virtio.queues[2].pop_request();
    const namex = new TextEncoder().encode(name);
    const buf = new Uint8Array(8 + namex.length + 1);
    marshall.Marshall(["w", "h", "h"], [port, VIRTIO_CONSOLE_PORT_NAME, 1], buf, 0);
    for( let i = 0; i < namex.length; ++i ) {
        buf[i+8] = namex[i];
    }
    buf[8 + namex.length] = 0;
    this.Send(2, bufchain, buf);
};


VirtioConsole.prototype.get_state = function()
{
    const state = [];

    state[0] = this.virtio;
    state[1] = this.rows;
    state[2] = this.cols;
    state[3] = this.ports;

    return state;
};

VirtioConsole.prototype.set_state = function(state)
{
    this.virtio.set_state(state[0]);
    this.rows = state[1];
    this.cols = state[2];
    this.ports = state[3];
};

VirtioConsole.prototype.reset = function() {
    this.virtio.reset();
};

VirtioConsole.prototype.SendEvent = function(port, event, value)
{
    const queue = this.virtio.queues[2];
    const bufchain = queue.pop_request();

    const buf = new Uint8Array(8);
    marshall.Marshall(["w","h","h"], [port, event, value], buf, 0);
    this.Send(2, bufchain, buf);
};

VirtioConsole.prototype.Send = function (queue_id, bufchain, blob)
{
    bufchain.set_next_blob(blob);
    this.virtio.queues[queue_id].push_reply(bufchain);
    this.virtio.queues[queue_id].flush_replies();
};

VirtioConsole.prototype.Ack = function (queue_id, bufchain)
{
    bufchain.set_next_blob(new Uint8Array(0));
    this.virtio.queues[queue_id].push_reply(bufchain);
    this.virtio.queues[queue_id].flush_replies();
};
