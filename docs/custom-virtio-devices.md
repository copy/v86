# Custom virtio devices

The `virtio_devices` option adds virtio PCI devices that are implemented
outside of v86. v86 provides the transport:

- the PCI function and its capabilities;
- feature negotiation and the virtqueues;
- the interrupt;
- the transport's part of a saved state.

The descriptor provides what the device does. This is how a device with its
own guest driver can live in a separate project.

Descriptors run on the CPU's thread, so `virtio_devices` cannot be combined
with `cpu_worker`. Device plugins can: `graphics_proxy` is one. Its device
runs in the worker and talks to the page over a channel; see
[glbridge.md](glbridge.md).

## Example: an entropy device

Linux's `virtio_rng` driver reads random bytes from device type 4 (PCI device
ID 0x1044). `tests/devices/virtio_rng.js` boots Linux with this device and
reads it from `/dev/hwrng`.

```js
let device;
const rng = {
    name: "rng",
    device_id: 0x1044,
    subsystem_device_id: 4,
    queues: [{ size: 8 }],
    init(handle) { device = handle; },
    notify(queue) {
        let request;
        while((request = device.pop_request(queue))) {
            request.write(crypto.getRandomValues(new Uint8Array(request.writable)));
            request.complete();
        }
        device.flush(queue);
    },
};

const emulator = new V86({
    graphics_adapter: "bochs_vga",
    // ...
    virtio_devices: [rng],
});
```

## The descriptor

| Field | |
|---|---|
| `name` | Unique among the devices; its part of a saved state is stored under this name |
| `device_id`, `subsystem_device_id` | PCI IDs; the vendor is always 0x1AF4 |
| `pci_slot` | Optional (1 to 31). By default, the first free slot from 0x10. A stable slot matters to guests that remember devices by location, such as Windows |
| `pcie_root_port` | Optional, instead of `pci_slot`: put the device behind PCI Express root port n (from 0) of a `machine_type: "q35"` machine with `pcie_root_ports` above n, as device 0 of the port's secondary bus. One device per root port. The guest numbers the bus and opens the port's windows (SeaBIOS does). The device is the card in the port's hot plug slot: `attach_pcie_device(n)` and `detach_pcie_device(n)` plug it in and take it out |
| `pcie_plugged` | Optional, with `pcie_root_port`: `false` starts with the slot empty |
| `io_base` | Optional base of four 256-byte I/O windows. By default, allocated from 0xE000 |
| `features` | Device feature bits. `VIRTIO_F_VERSION_1` (32) is always added |
| `queues` | `[{ size }]`, with sizes that are powers of two |
| `config` | Optional device configuration space, at most 256 bytes: `[{ bytes: 1, 2 or 4, read(), write(value) }]` |
| `init(handle)` | Called once, after the PCI function exists |
| `notify(queue)` | The driver made requests available. Only called after the driver has set DRIVER_OK |
| `reset()` | The driver reset the device, the machine was reset, or the device starts afresh in its hot plug slot (plugged in again, or the guest switched the slot on) |
| `get_state()`, `set_state(state)` | The device's part of a saved state. Synchronous. Numbers, strings, arrays and typed arrays only, no plain objects |
| `busy()` | Optional: the work the device still waits for from elsewhere. Before a snapshot, the CPU worker waits until this is 0 |
| `upgrade_state(slot)` | Optional: recognizes `state[92]` of a snapshot from before custom devices, and returns `[transport state, device state, host state]` or `null` |

Descriptors are read with their field names as written, so they work with
any bundle, also one compiled with Closure's ADVANCED mode (as the old page's
`v86_all.js` was).

A slot or I/O window that is already taken is an error. So are two devices
with the same name.

## The handle

| Method | |
|---|---|
| `pop_request(queue)` | The next request, or `null` |
| `has_request(queue)` | |
| `flush(queue)` | Publishes the completed requests and raises the interrupt |
| `read_memory(address, length)`, `write_memory(bytes, address)` | Guest RAM, plain or extended, anywhere on the 36-bit bus. Anything else, such as device memory or the legacy VGA/ROM range, throws a `RangeError`. A read returns a view where one contiguous backing holds the range, and a copy otherwise. Writes invalidate compiled code |
| `is_ram(address, length)` | |
| `is_ready()` | DRIVER_OK is set, and neither the driver nor the device has failed |
| `is_feature_negotiated(bit)` | |
| `needs_reset()` | Tells the driver the device has failed |
| `config_changed()` | Tells the driver the configuration space changed |

A request has these members:

- `readable` and `writable`: the byte counts of its buffers;
- `read()`: returns the bytes the driver wrote;
- `write(bytes)`: writes the reply;
- `complete()`: hands the request back. It becomes visible to the driver on
  the next `flush`.

A request can be completed later, for example after asynchronous work. If the
device is reset or a state is restored in between, `write` and `complete` do
nothing.

Rings and buffers must be in guest RAM. If they are not, the driver is told to
reset the device, and `pop_request` returns `null`.

## Saved states

A saved state holds each device's transport state and its `get_state()`,
under the device's name. Restoring such a state needs a device with the same
name, and throws otherwise. A device the state does not know about is reset.
Machines without custom devices save exactly what they saved before.
A `state[92]` written before custom devices existed goes to the device whose
`upgrade_state` recognizes it.
