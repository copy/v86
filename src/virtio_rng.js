// virtio-rng (virtio 1.2 section 5.4; docs/arm64-virt-android16-plan.md
// P5.5) as a built-in device of the virt machine: every buffer the driver
// offers on its one queue is filled from crypto.getRandomValues (the
// guest's /dev/hwrng).

import { VirtIO, VIRTIO_F_VERSION_1 } from "./virtio.js";
import { dbg_assert } from "./log.js";

/** crypto.getRandomValues fills at most this many bytes per call */
const ENTROPY_CHUNK = 65536;

/**
 * @constructor
 * @param {?} cpu
 * @param {?} transport the device's transport (src/virtio_mmio.js), or null: on the PCIe host at `pci_id`
 * @param {number=} pci_id
 */
export function VirtioRng(cpu, transport, pci_id)
{
    dbg_assert(transport || pci_id !== undefined && cpu.devices.pci.generic, "virtio-rng: on the virt machine's transports only");
    /** @type {VirtIO} */
    this.virtio = new VirtIO(cpu,
    {
        name: "virtio-rng",
        device_id: 0x1044,
        subsystem_device_id: 4,
        common:
        {
            queues: [{ size_supported: 64, notify_offset: 0 }],
            features: [VIRTIO_F_VERSION_1],
            on_driver_ok: () => {},
        },
        notification:
        {
            single_handler: true,
            handlers: [queue_id => this.fill(this.virtio.queues[queue_id])],
        },
        isr_status: {},
        transport: transport || undefined,
        pci_id,
    });
}

/** @param {?} queue */
VirtioRng.prototype.fill = function(queue)
{
    while(queue.has_request())
    {
        const chain = queue.pop_request();
        const bytes = new Uint8Array(chain.length_writable);
        for(let at = 0; at < bytes.length; at += ENTROPY_CHUNK)
        {
            globalThis.crypto.getRandomValues(bytes.subarray(at, at + ENTROPY_CHUNK));
        }
        chain.set_next_blob(bytes);
        queue.push_reply(chain);
    }
    queue.flush_replies();
};

VirtioRng.prototype.reset = function()
{
    this.virtio.reset();
};

VirtioRng.prototype.get_state = function()
{
    return [this.virtio];
};

VirtioRng.prototype.set_state = function(state)
{
    this.virtio.set_state(state[0]);
};
