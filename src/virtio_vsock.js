// virtio-vsock (virtio 1.2 section 5.10; docs/arm64-virt-android16-plan.md
// P10.7) on the virt machine: stream sockets between the guest (CID 3) and
// the host (CID 2, this side), the channel Cuttlefish's host uses for adb
// (the guest's adbd listens on vsock:5555 as well as tcp:5555). The host
// side connects to the guest's ports; connections the guest makes to the
// host are refused (RST). The page or test drives it through the bus:
//   "virtio-vsock-connect"   [id, port]   connect to the guest's port
//   "virtio-vsock-send"      [id, bytes]
//   "virtio-vsock-close"     [id]
// and is told
//   "virtio-vsock-connected" [id], "virtio-vsock-data" [id, bytes],
//   "virtio-vsock-closed"    [id]         (also when refused or reset)
// Flow control is the protocol's credit: what the guest has room for
// (buf_alloc - (sent - fwd_cnt)) limits what is sent to it; the host side
// takes everything at once and tells the guest so (CREDIT_UPDATE) after
// every half of its window. Connections do not survive a saved state: after
// a restore the guest is sent TRANSPORT_RESET and the host side is told
// every connection closed.

import { VirtIO, VIRTIO_F_VERSION_1 } from "./virtio.js";
import { dbg_assert, dbg_log } from "./log.js";
import { LOG_VIRTIO } from "./const.js";

// For Types Only
import { BusConnector } from "./bus.js";

const HOST_CID = 2;
export const VSOCK_GUEST_CID = 3;
const HEADER = 44;
const TYPE_STREAM = 1;
const OP_REQUEST = 1, OP_RESPONSE = 2, OP_RST = 3, OP_SHUTDOWN = 4, OP_RW = 5, OP_CREDIT_UPDATE = 6, OP_CREDIT_REQUEST = 7;
const SHUTDOWN_BOTH = 3;
const EVENT_TRANSPORT_RESET = 0;
/** the host side's receive window */
const HOST_BUF_ALLOC = 256 * 1024;
const RX = 0, TX = 1, EVENT = 2;

/**
 * @constructor
 * @param {?} cpu
 * @param {BusConnector} bus
 * @param {?} transport the device's transport (src/virtio_mmio.js), or null: on the PCIe host at `pci_id`
 * @param {number=} pci_id
 */
export function VirtioVsock(cpu, bus, transport, pci_id)
{
    dbg_assert(transport || pci_id !== undefined, "virtio-vsock: on the virt machine's transports only");
    /** @const @type {BusConnector} */
    this.bus = bus;
    /** id -> connection: { id, local_port, port, state, peer_buf_alloc, peer_fwd_cnt, tx_cnt, rx_cnt, rx_reported, pending: !Array<!Uint8Array> } */
    this.connections = new Map();
    /** packets for the guest that wait for receive buffers */
    this.rx_pending = [];
    this.next_local_port = 1024;

    /** @type {VirtIO} */
    this.virtio = new VirtIO(cpu,
    {
        name: "virtio-vsock",
        device_id: 0x1053,
        subsystem_device_id: 19,
        common:
        {
            queues: [
                { size_supported: 128, notify_offset: 0 },
                { size_supported: 128, notify_offset: 0 },
                { size_supported: 16, notify_offset: 0 },
            ],
            features: [VIRTIO_F_VERSION_1],
            on_driver_ok: () => {},
        },
        notification:
        {
            single_handler: true,
            handlers: [queue_id => {
                if(queue_id === RX) this.flush_rx();
                else if(queue_id === TX) this.receive();
            }],
        },
        isr_status: {},
        device_specific:
        {
            struct: [
                { bytes: 4, name: "guest_cid_low", read: () => VSOCK_GUEST_CID, write: () => {} },
                { bytes: 4, name: "guest_cid_high", read: () => 0, write: () => {} },
            ],
        },
        transport: transport || undefined,
        pci_id,
    });

    bus.register("virtio-vsock-connect", ([id, port]) => this.connect(id, port), this);
    bus.register("virtio-vsock-send", ([id, bytes]) => this.send(id, bytes), this);
    bus.register("virtio-vsock-close", ([id]) => this.close(id), this);
}

/** a packet for the guest: header and payload */
VirtioVsock.prototype.packet = function(connection, op, payload, flags = 0)
{
    const bytes = new Uint8Array(HEADER + (payload ? payload.length : 0));
    const view = new DataView(bytes.buffer);
    view.setUint32(0, HOST_CID, true);
    view.setUint32(8, VSOCK_GUEST_CID, true);
    view.setUint32(16, connection.local_port, true);
    view.setUint32(20, connection.port, true);
    view.setUint32(24, payload ? payload.length : 0, true);
    view.setUint16(28, TYPE_STREAM, true);
    view.setUint16(30, op, true);
    view.setUint32(32, flags, true);
    view.setUint32(36, HOST_BUF_ALLOC, true);
    view.setUint32(40, connection.rx_cnt, true);
    if(payload) bytes.set(payload, HEADER);
    connection.rx_reported = connection.rx_cnt;
    return bytes;
};

VirtioVsock.prototype.to_guest = function(bytes)
{
    this.rx_pending.push(bytes);
    this.flush_rx();
};

VirtioVsock.prototype.flush_rx = function()
{
    const queue = this.virtio.queues[RX];
    if(!queue || !queue.is_configured()) return;
    let sent = false;
    while(this.rx_pending.length && queue.has_request())
    {
        const chain = queue.pop_request();
        let bytes = this.rx_pending[0];
        if(bytes.length > chain.length_writable)
        {
            // (a data packet longer than the guest's buffer: the rest in the
            // next one, with its own header)
            dbg_assert(chain.length_writable > HEADER, "virtio-vsock: receive buffer without room for data");
            const view = new DataView(bytes.buffer, bytes.byteOffset);
            const take = chain.length_writable - HEADER;
            const first = bytes.slice(0, HEADER + take);
            new DataView(first.buffer).setUint32(24, take, true);
            const rest = new Uint8Array(bytes.length - take);
            rest.set(bytes.subarray(0, HEADER));
            rest.set(bytes.subarray(HEADER + take), HEADER);
            new DataView(rest.buffer).setUint32(24, view.getUint32(24, true) - take, true);
            this.rx_pending[0] = rest;
            bytes = first;
        }
        else this.rx_pending.shift();
        chain.set_next_blob(bytes);
        queue.push_reply(chain);
        sent = true;
    }
    if(sent) queue.flush_replies();
};

/** the guest's packets */
VirtioVsock.prototype.receive = function()
{
    const queue = this.virtio.queues[TX];
    while(queue.has_request())
    {
        const chain = queue.pop_request();
        const bytes = new Uint8Array(chain.length_readable);
        chain.get_next_blob(bytes);
        queue.push_reply(chain);
        if(bytes.length >= HEADER) this.handle(bytes);
    }
    queue.flush_replies();
};

VirtioVsock.prototype.find = function(local_port, port)
{
    for(const connection of this.connections.values())
    {
        if(connection.local_port === local_port && connection.port === port) return connection;
    }
    return null;
};

VirtioVsock.prototype.handle = function(bytes)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const src_port = view.getUint32(16, true), dst_port = view.getUint32(20, true);
    const length = view.getUint32(24, true), type = view.getUint16(28, true), op = view.getUint16(30, true);
    const connection = this.find(dst_port, src_port);
    if(!connection)
    {
        // a connection the host side does not know (the guest's own, to the
        // host): refused
        if(op !== OP_RST)
        {
            this.to_guest(this.packet({ local_port: dst_port, port: src_port, rx_cnt: 0 }, OP_RST, null));
        }
        return;
    }
    if(type !== TYPE_STREAM) return;
    connection.peer_buf_alloc = view.getUint32(36, true);
    connection.peer_fwd_cnt = view.getUint32(40, true);
    switch(op)
    {
        case OP_RESPONSE:
            if(connection.state === "connecting")
            {
                connection.state = "open";
                this.bus.send("virtio-vsock-connected", [connection.id]);
            }
            break;
        case OP_RW:
        {
            const payload = bytes.slice(HEADER, HEADER + length);
            connection.rx_cnt = connection.rx_cnt + payload.length >>> 0;
            this.bus.send("virtio-vsock-data", [connection.id, payload]);
            if((connection.rx_cnt - connection.rx_reported >>> 0) >= HOST_BUF_ALLOC / 2)
            {
                this.to_guest(this.packet(connection, OP_CREDIT_UPDATE, null));
            }
            break;
        }
        case OP_CREDIT_REQUEST:
            this.to_guest(this.packet(connection, OP_CREDIT_UPDATE, null));
            break;
        case OP_CREDIT_UPDATE:
            break;
        case OP_SHUTDOWN:
            this.to_guest(this.packet(connection, OP_RST, null));
            this.drop(connection);
            return;
        case OP_RST:
            this.drop(connection);
            return;
        default:
            dbg_log("virtio-vsock: op " + op + " from the guest", LOG_VIRTIO);
    }
    this.flush_tx(connection);
};

/** the host side's data that the guest's credit allows */
VirtioVsock.prototype.flush_tx = function(connection)
{
    while(connection.state === "open" && connection.pending.length)
    {
        const credit = connection.peer_buf_alloc - (connection.tx_cnt - connection.peer_fwd_cnt >>> 0);
        if(credit <= 0) break;
        let chunk = connection.pending[0];
        if(chunk.length > credit)
        {
            connection.pending[0] = chunk.subarray(credit);
            chunk = chunk.subarray(0, credit);
        }
        else connection.pending.shift();
        connection.tx_cnt = connection.tx_cnt + chunk.length >>> 0;
        this.to_guest(this.packet(connection, OP_RW, chunk));
    }
};

VirtioVsock.prototype.connect = function(id, port)
{
    const connection = { id, local_port: this.next_local_port++, port, state: "connecting",
        peer_buf_alloc: 0, peer_fwd_cnt: 0, tx_cnt: 0, rx_cnt: 0, rx_reported: 0, pending: [] };
    if(this.next_local_port > 0xFFFF) this.next_local_port = 1024;
    this.connections.set(id, connection);
    this.to_guest(this.packet(connection, OP_REQUEST, null));
};

VirtioVsock.prototype.send = function(id, bytes)
{
    const connection = this.connections.get(id);
    if(!connection) return;
    connection.pending.push(new Uint8Array(bytes));
    this.flush_tx(connection);
};

VirtioVsock.prototype.close = function(id)
{
    const connection = this.connections.get(id);
    if(!connection) return;
    this.to_guest(this.packet(connection, OP_SHUTDOWN, null, SHUTDOWN_BOTH));
    this.drop(connection);
};

VirtioVsock.prototype.drop = function(connection)
{
    this.connections.delete(connection.id);
    this.bus.send("virtio-vsock-closed", [connection.id]);
};

/** every connection closed; the guest told so once it has an event buffer */
VirtioVsock.prototype.reset_connections = function(tell_guest)
{
    for(const connection of [...this.connections.values()]) this.drop(connection);
    this.rx_pending = [];
    if(tell_guest)
    {
        const queue = this.virtio.queues[EVENT];
        if(queue && queue.is_configured() && queue.has_request())
        {
            const chain = queue.pop_request();
            const event = new Uint8Array(4);
            new DataView(event.buffer).setUint32(0, EVENT_TRANSPORT_RESET, true);
            chain.set_next_blob(event);
            queue.push_reply(chain);
            queue.flush_replies();
        }
    }
};

VirtioVsock.prototype.reset = function()
{
    this.reset_connections(false);
    this.virtio.reset();
};

VirtioVsock.prototype.get_state = function()
{
    return [this.virtio];
};

VirtioVsock.prototype.set_state = function(state)
{
    this.virtio.set_state(state[0]);
    this.reset_connections(true);
};
