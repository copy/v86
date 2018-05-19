"use strict";

// http://docs.oasis-open.org/virtio/virtio/v1.0/virtio-v1.0.html

/** @const */
var VIRTIO_PCI_VENDOR_ID = 0x1AF4;

/**
 * @const
 * Identifies vendor-specific PCI capability.
 */
var VIRTIO_PCI_CAP_VENDOR = 0x09;

/**
 * @const
 * Length (bytes) of VIRTIO_PCI_CAP linked list entry.
 */
var VIRTIO_PCI_CAP_LENGTH = 16;

// Capability types.

/** @const */
var VIRTIO_PCI_CAP_COMMON_CFG = 1;
/** @const */
var VIRTIO_PCI_CAP_NOTIFY_CFG = 2;
/** @const */
var VIRTIO_PCI_CAP_ISR_CFG = 3;
/** @const */
var VIRTIO_PCI_CAP_DEVICE_CFG = 4;
/** @const */
var VIRTIO_PCI_CAP_PCI_CFG = 5;

// Status bits (device_status values).

/** @const */
var VIRTIO_STATUS_ACKNOWLEDGE = 1;
/** @const */
var VIRTIO_STATUS_DRIVER = 2;
/** @const */
var VIRTIO_STATUS_DRIVER_OK = 4;
/** @const */
var VIRTIO_STATUS_FEATURES_OK = 8;
/** @const */
var VIRTIO_STATUS_DEVICE_NEEDS_RESET = 64;
/** @const */
var VIRTIO_STATUS_FAILED = 128;

// ISR bits (isr_status values).

/** @const */
var VIRTIO_ISR_QUEUE = 1;
/** @const */
var VIRTIO_ISR_DEVICE_CFG = 2;

// Feature bits (bit positions).

/** @const */
var VIRTIO_F_VERSION_1 = 32;

// Queue struct sizes.

/**
 * @const
 * Size (bytes) of the virtq_desc struct per queue size
 */
var VIRTQ_DESC_ENTRYSIZE = 16;
/**
 * @const
 * Size (bytes) of the virtq_avail struct ignoring ring entries
 */
var VIRTQ_AVAIL_BASESIZE = 6;
/**
 * @const
 * Size (bytes) of the virtq_avail struct per queue size
 */
var VIRTQ_AVAIL_ENTRYSIZE = 2;
/**
 * @const
 * Size (bytes) of the virtq_used struct ignoring ring entries
 */
var VIRTQ_USED_BASESIZE = 6;
/**
 * @const
 * Size (bytes) of the virtq_desc struct per queue size
 */
var VIRTQ_USED_ENTRYSIZE = 8;

// Closure Compiler Types.

/**
 * @typedef {!Array<{
 *     bytes: number,
 *     name: string,
 *     read: function():number,
 *     write: function(number)
 * }>}
 */
var VirtIO_CapabilityStruct;

/**
 * @typedef {
 * {
 *     type: number,
 *     bar: number,
 *     port: number,
 *     use_mmio: boolean,
 *     offset: number,
 *     length: number,
 *     extra: Uint8Array,
 *     struct: VirtIO_CapabilityStruct,
 * }}
 */
var VirtIO_CapabilityInfo;

/**
 * @typedef {
 * {
 *     size_supported: number,
 *     notify_offset: number,
 * }}
 */
var VirtQueue_Options;

/**
 * @typedef {
 * {
 *     initial_port: number,
 *     queues: !Array<VirtQueue_Options>,
 *     features: !Array<number>,
 * }}
 */
var VirtIO_CommonCapabilityOptions;

/**
 * @typedef {
 * {
 *     initial_port: number,
 *     share_handler: boolean,
 *     handlers: !Array<function()>,
 * }}
 */
var VirtIO_NotificationCapabilityOptions;

/**
 * @typedef {
 * {
 *     initial_port: number,
 * }}
 */
var VirtIO_ISRCapabilityOptions;

/**
 * @typedef {
 * {
 *     initial_port: number,
 *     length: number,
 *     struct: VirtIO_CapabilityStruct,
 * }}
 */
var VirtIO_DeviceSpecificCapabilityOptions;

/**
 * @typedef {
 * {
 *     name: string,
 *     pci_id: number,
 *     device_id: number,
 *     subsystem_device_id: number,
 *     common: VirtIO_CommonCapabilityOptions,
 *     notification: (undefined | VirtIO_NotificationCapabilityOptions),
 *     isr_status: (undefined | VirtIO_ISRCapabilityOptions),
 *     device_specific: (undefined | VirtIO_DeviceSpecificCapabilityOptions),
 * }}
 */
var VirtIO_Options;

/**
 * @constructor
 * @param {CPU} cpu
 * @param {VirtIO_Options} options
 */
function VirtIO(cpu, options)
{
    var io = cpu.io;

    /** @const @type {CPU} */
    this.cpu = cpu;

    /** @const @type {PCI} */
    this.pci = cpu.devices.pci;

    this.device_id = options.device_id;

    this.pci_space =
    [
        // Vendor ID
        VIRTIO_PCI_VENDOR_ID & 0xFF, VIRTIO_PCI_VENDOR_ID >> 8,
        // Device ID
        options.device_id & 0xFF, options.device_id >> 8,
        // Command
        0x07, 0x05,
        // Status - enable capabilities list
        0x10, 0x00,
        // Revision ID
        0x00,
        // Prof IF, Subclass, Class code
        0x00, 0x02, 0x00,
        // Cache line size
        0x00,
        // Latency Timer
        0x00,
        // Header Type
        0x00,
        // Built-in self test
        0x00,
        // BAR0
        0x01, 0xa8, 0x00, 0x00,
        // BAR1
        0x00, 0x10, 0xbf, 0xfe,
        // BAR2
        0x00, 0x00, 0x00, 0x00,
        // BAR3
        0x00, 0x00, 0x00, 0x00,
        // BAR4
        0x00, 0x00, 0x00, 0x00,
        // BAR5
        0x00, 0x00, 0x00, 0x00,
        // CardBus CIS pointer
        0x00, 0x00, 0x00, 0x00,
        // Subsystem vendor ID
        VIRTIO_PCI_VENDOR_ID & 0xFF, VIRTIO_PCI_VENDOR_ID >> 8,
        // Subsystem ID
        options.subsystem_device_id & 0xFF, options.subsystem_device_id >> 8,
        // Expansion ROM base address
        0x00, 0x00, 0x00, 0x00,
        // Capabilities pointer
        0x40,
        // Reserved
        0x00, 0x00, 0x00,
        // Reserved
        0x00, 0x00, 0x00, 0x00,
        // Interrupt line
        0x00,
        // Interrupt pin
        0x01,
        // Min grant
        0x00,
        // Max latency
        0x00,
    ];
    // Remaining PCI space is appended by capabilities below.

    this.pci_id = options.pci_id;

    // PCI bars gets filled in by capabilities below.
    this.pci_bars = [];

    this.name = options.name;

    // Feature bits grouped in dwords, dword selected by decive_feature_select.
    this.device_feature_select = 0;
    this.driver_feature_select = 0;

    // Unspecified upper bound. Assume 4*32=128 bits.
    this.device_feature = new Uint32Array(4);
    this.driver_feature = new Uint32Array(4);
    options.common.features.forEach((f) =>
    {
        dbg_assert(f >= 0,
            "VirtIO device<" + this.name + "> feature bit numbers must be non-negative");
        dbg_assert(f < 128,
            "VirtIO device<" + this.name + "> feature bit numbers assumed less than 128 in implementation");

        // Feature bits are grouped in 32 bits.
        this.device_feature[f >>> 5] |= 1 << (f & 0x1F);
        this.driver_feature[f >>> 5] |= 1 << (f & 0x1F);
    });

    dbg_assert(options.common.features.indexOf(VIRTIO_F_VERSION_1) !== -1,
        "VirtIO device<" + this.name + "> only non-transitional devices are supported");

    // Indicates whether driver_feature bits is subset of device_feature bits.
    this.features_ok = true;

    this.device_status = 0;

    this.config_has_changed = false;
    this.config_generation = 0;

    /** @type {!Array<VirtQueue>} */
    this.queues = [];
    for(var queue_options of options.common.queues)
    {
        this.queues.push(new VirtQueue(cpu, queue_options));
    }

    this.isr_status = 0;

    this.reset();

    /** @type {!Array<VirtIO_CapabilityInfo>} */
    var capabilities = [];
    capabilities.push(this.create_common_capability(options.common));
    if(options.notification)
    {
        capabilities.push(this.create_notification_capability(options.notification));
    }
    if(options.isr_status)
    {
        capabilities.push(this.create_isr_capability(options.isr_status));
    }
    if(options.device_specific)
    {
        capabilities.push(this.create_device_specific_capability(options.device_specific));
    }
    this.init_capabilities(capabilities);

    // TODO: upgrade the following.
    io.register_write(0xA810, this, undefined, function(data)
    {
        dbg_log("Write queue notify: " + h(data, 4), LOG_VIRTIO);

        // only queue 0 supported
        dbg_assert(data === 0);

        var queue_start = this.queue_address << 12;
        var ring_start = queue_start + 16 * this.queue_size;
        var ring_desc_start = ring_start + 4;

        var //flags = this.cpu.read16(ring_start),
            // index of the next free ring
            idx = this.cpu.read16(ring_start + 2);

        dbg_log("idx=" + h(idx, 4), LOG_VIRTIO);
        //dbg_assert(idx < this.queue_size);

        var mask = this.queue_size - 1;
        idx &= mask;

        while(this.last_idx !== idx)
        {
            var desc_idx = this.cpu.read16(ring_desc_start + this.last_idx * 2);
            this.handle_descriptor(desc_idx);

            this.last_idx = this.last_idx + 1 & mask;
        }
    });

    cpu.devices.pci.register_device(this);
}

/**
 * @param {VirtIO_CommonCapabilityOptions} options
 * @return {VirtIO_CapabilityInfo}
 */
VirtIO.prototype.create_common_capability = function(options)
{
    var cap =
    {
        type: VIRTIO_PCI_CAP_COMMON_CFG,
        bar: 0,
        port: options.initial_port,
        use_mmio: false,
        offset: 0,
        length: 0,
        extra: new Uint8Array(0),
        struct:
        [
            {
                bytes: 4,
                name: "device_feature_select",
                read: () => this.device_feature_select,
                write: data =>
                {
                    this.device_feature_select = data;
                },
            },
            {
                bytes: 4,
                name: "device_feature",
                read: () => this.device_feature[this.device_feature_select],
                write: data =>
                {
                    this.device_feature[this.device_feature_select] = data;
                },
            },
            {
                bytes: 4,
                name: "driver_feature_select",
                read: () => this.driver_feature_select,
                write: data =>
                {
                    this.driver_feature_select = data;
                },
            },
            {
                bytes: 4,
                name: "driver_feature",
                read: () => this.driver_feature[this.driver_feature_select],
                write: data =>
                {
                    var supported_feature = this.device_feature[this.driver_feature_select];
                    this.driver_feature[this.driver_feature_select] = data & supported_feature;

                    // Check that driver features is an inclusive subset of device features.
                    var invalid_bits = data & ~supported_feature;
                    this.features_ok = this.features_ok && !invalid_bits;
                },
            },
            {
                bytes: 2,
                name: "msix_config",
                read: () =>
                {
                    dbg_log("No msi-x capability supported.", LOG_VIRTIO);
                    return 0xFFFF;
                },
                write: data =>
                {
                    dbg_log("No msi-x capability supported.", LOG_VIRTIO);
                },
            },
            {
                bytes: 2,
                name: "num_queues",
                read: () => this.queues.length,
                write: data => { /* read only */ },
            },
            {
                bytes: 1,
                name: "device_status",
                read: () => this.device_status,
                write: data =>
                {
                    if(data === 0)
                    {
                        dbg_log("Reset device<" + this.name + ">", LOG_VIRTIO);
                        this.reset();
                    }
                    else if(data | VIRTIO_STATUS_FAILED)
                    {
                        dbg_log("Warning: Device<" + this.name + "> status failed", LOG_VIRTIO);
                    }
                    else if(((data & ~this.device_status) | VIRTIO_STATUS_DRIVER_OK) &&
                        (this.device_status & VIRTIO_STATUS_DEVICE_NEEDS_RESET))
                    {
                        this.notify_config_changes();
                    }
                    else
                    {
                        dbg_log(((data & VIRTIO_STATUS_ACKNOWLEDGE) ? "ACKNOWLEDGE " : "") +
                                ((data & VIRTIO_STATUS_DRIVER) ? "DRIVER " : "") +
                                ((data & VIRTIO_STATUS_DRIVER_OK) ? "DRIVER_OK" : "") +
                                ((data & VIRTIO_STATUS_FEATURES_OK) ? "FEATURES_OK" : "") +
                                ((data & VIRTIO_STATUS_DEVICE_NEEDS_RESET) ? "DEVICE_NEEDS_RESET" : ""),
                                LOG_VIRTIO);
                    }

                    // Don't set FEATURES_OK if our device doesn't support requested features.
                    if(!this.features_ok)
                    {
                        data &= ~VIRTIO_STATUS_FEATURES_OK;
                    }

                    this.device_status = data;
                },
            },
            {
                bytes: 1,
                name: "config_generation",
                read: () => this.config_generation,
                write: data => { /* read only */ },
            },
            {
                bytes: 2,
                name: "queue_select",
                read: () => this.queue_select,
                write: data =>
                {
                    this.queue_select = data;

                    if(this.queue_select < this.queues.length)
                    {
                        this.queues_selected = this.queues[this.queue_select];
                    }
                    else
                    {
                        // Allow queue_select >= num_queues.
                        this.queue_selected = null;
                        // Drivers can then detect that the queue is not available
                        // using the below fields.
                    }
                },
            },
            {
                bytes: 2,
                name: "queue_size",
                read: () => this.queue_selected ? this.queue_selected.size : 0,
                write: data =>
                {
                    dbg_assert((data & data - 1) === 0,
                        "VirtIO device<" + this.name + "> queue size needs to be power of 2 or zero");
                    if(this.queue_selected) this.queue_selected.size = data;
                },
            },
            {
                bytes: 2,
                name: "queue_msix_vector",
                read: () =>
                {
                    dbg_log("No msi-x capability supported.", LOG_VIRTIO);
                    return 0xFFFF;
                },
                write: data =>
                {
                    dbg_log("No msi-x capability supported.", LOG_VIRTIO);
                },
            },
            {
                bytes: 2,
                name: "queue_enable",
                read: () => this.queue_selected ? this.queue_selected.enable : 0,
                write: data =>
                {
                    if(this.queue_selected) this.queue_selected.enable = data;
                },
            },
            {
                bytes: 2,
                name: "queue_notify_off",
                read: () => this.queue_selected ? this.queue_selected.notify_offset : 0,
                write: data => { /* read only */ },
            },
            {
                bytes: 2,
                name: "queue_desc",
                read: () => this.queue_selected ? this.queue_selected.desc_table_addr : 0,
                write: data =>
                {
                    if(this.queue_selected) this.queue_selected.set_desc_table_addr(data);
                },
            },
            {
                bytes: 2,
                name: "queue_avail",
                read: () => this.queue_selected ? this.queue_selected.avail_ring_addr : 0,
                write: data =>
                {
                    if(this.queue_selected) this.queue_selected.set_avail_ring_addr(data);
                },
            },
            {
                bytes: 2,
                name: "queue_used",
                read: () => this.queue_selected ? this.queue_selected.used_ring_addr : 0,
                write: data =>
                {
                    if(this.queue_selected) this.queue_selected.set_used_ring_addr(data);
                },
            },
        ],
    };

    return cap;
};

/**
 * @param {VirtIO_NotificationCapabilityOptions} options
 * @return {VirtIO_CapabilityInfo}
 */
VirtIO.prototype.create_notification_capability = function(options)
{
    var notify_struct = [];
    var notify_off_multiplier;

    if(options.share_handler)
    {
        dbg_assert(options.handlers.length === 1,
            "VirtIO device<" + this.name + "> too many notify handlers specified: expected single handler");

        // All queues use the same address for notifying.
        notify_off_multiplier = 0;
    }
    else
    {
        dbg_assert(options.handlers.length === this.queues.length,
            "Virtio device<" + this.name + "> each queue has exactly one notify handler");

        // Each queue uses its own 2 bytes for notifying.
        notify_off_multiplier = 2;
    }

    for (var i = 0; i < options.handlers.length; i++)
    {
        notify_struct.push(
        {
            bytes: 2,
            name: "notify" + i,
            read: () => 0xFFFF, // Write only? TODO
            write: options.handlers[i],
        });
    }

    var cap =
    {
        type: VIRTIO_PCI_CAP_NOTIFY_CFG,
        bar: 1,
        port: options.initial_port,
        use_mmio: false,
        offset: 0,
        length: notify_struct.length * 2,
        extra: new Uint8Array(
        [
            notify_off_multiplier & 0xFF,
            (notify_off_multiplier >> 8) & 0xFF,
            (notify_off_multiplier >> 16) & 0xFF,
            notify_off_multiplier >> 24,
        ]),
        struct: notify_struct,
    };

    return cap;
};

/**
 * @param {VirtIO_ISRCapabilityOptions} options
 * @return {VirtIO_CapabilityInfo}
 */
VirtIO.prototype.create_isr_capability = function(options)
{
    var cap =
    {
        type: VIRTIO_PCI_CAP_ISR_CFG,
        bar: 2,
        port: options.initial_port,
        use_mmio: false,
        offset: 0,
        length: 1,
        extra: new Uint8Array(0),
        struct:
        [
            {
                bytes: 1,
                name: "isr_status",
                read: () =>
                {
                    var isr_status = this.isr_status;
                    this.lower_irq();
                    return isr_status;
                },
                write: data => { /* read only */ },
            },
        ],
    };

    return cap;
};

/**
 * @param {VirtIO_DeviceSpecificCapabilityOptions} options
 * @return {VirtIO_CapabilityInfo}
 */
VirtIO.prototype.create_device_specific_capability = function(options)
{
    var cap =
    {
        type: VIRTIO_PCI_CAP_DEVICE_CFG,
        bar: 5,
        port: options.initial_port,
        use_mmio: false,
        offset: 0,
        length: options.length,
        extra: new Uint8Array(0),
        struct: options.struct,
    };

    return cap;
};

/**
 * Writes capabilities into pci_space and hook up IO/MMIO handlers.
 * Call only within constructor.
 * @param {!Array<VirtIO_CapabilityInfo>} capabilities
 */
VirtIO.prototype.init_capabilities = function(capabilities)
{
    // Next available offset for capabilities linked list.
    var cap_next = this.pci_space[0x34] = 0x40;

    // Current offset.
    var cap_ptr = cap_next;

    capabilities.forEach((cap) =>
    {
        var cap_len = VIRTIO_PCI_CAP_LENGTH + cap.extra.length;

        cap_ptr = cap_next;
        cap_next = cap_ptr + cap_len;

        dbg_assert(cap_next <= 256,
            "VirtIO device<" + this.name + "> can't fit all capabilities into 256byte configspace");

        dbg_assert(0 <= cap.bar && cap.bar < 6,
            "VirtIO device<" + this.name + "> capability invalid bar number");

        var bar_size = cap.struct.reduce((field) => field.bytes, 0);
        bar_size += cap.offset;

        // Round up to next power of 2.
        bar_size = 1 << (v86util.int_log2(bar_size - 1) + 1);

        dbg_assert((cap.port & (bar_size - 1)) === 0,
            "VirtIO device<" + this.name + "> capability port should be aligned to pci bar size");

        this.pci_bars[cap.bar] =
        {
            size: bar_size,
        };

        this.pci_space[cap_ptr] = VIRTIO_PCI_CAP_VENDOR;
        this.pci_space[cap_ptr + 1] = cap_next;
        this.pci_space[cap_ptr + 2] = cap_len;
        this.pci_space[cap_ptr + 3] = cap.type;
        this.pci_space[cap_ptr + 4] = cap.bar;

        this.pci_space[cap_ptr + 5] = 0; // Padding.
        this.pci_space[cap_ptr + 6] = 0; // Padding.
        this.pci_space[cap_ptr + 7] = 0; // Padding.

        this.pci_space[cap_ptr + 8] = cap.offset & 0xFF;
        this.pci_space[cap_ptr + 9] = (cap.offset >>> 8) & 0xFF;
        this.pci_space[cap_ptr + 10] = (cap.offset >>> 16) & 0xFF;
        this.pci_space[cap_ptr + 11] = cap.offset >>> 24;

        this.pci_space[cap_ptr + 12] = bar_size & 0xFF;
        this.pci_space[cap_ptr + 13] = (bar_size >>> 8) & 0xFF;
        this.pci_space[cap_ptr + 14] = (bar_size >>> 16) & 0xFF;
        this.pci_space[cap_ptr + 15] = bar_size >>> 24;

        for(var i = 0; i < cap.extra.length; i++)
        {
            this.pci_space[cap_ptr + 16 + i] = cap.extra[i];
        }

        var bar_offset = 0x10 + 4 * cap.bar;
        this.pci_space[bar_offset] = (cap.port & 0xFE) | !cap.use_mmio;
        this.pci_space[bar_offset + 1] = (cap.port >>> 8) & 0xFF;
        this.pci_space[bar_offset + 2] = (cap.port >>> 16) & 0xFF;
        this.pci_space[bar_offset + 3] = (cap.port >>> 24) & 0xFF;

        var port = cap.port + cap.offset;

        cap.struct.forEach((field) =>
        {
            var read = field.read;
            var write = field.write;

            if(DEBUG)
            {
                read = () =>
                {
                    var val = field.read();

                    dbg_log("Device<" + this.name + "> " +
                            "cap[" + cap.type + "] " +
                            "read[" + field.name + "] " +
                            "=> " + h(val, field.bytes * 8),
                        LOG_VIRTIO);

                    return val;
                };
                write = data =>
                {
                    field.write(data);

                    dbg_log("Device<" + this.name + "> " +
                            "cap[" + cap.type + "] " +
                            "write[" + field.name + "] " +
                            "<= " + h(data, field.bytes * 8),
                        LOG_VIRTIO);
                };
            }

            if(cap.use_mmio)
            {
                dbg_assert(false, "VirtIO device <" + this.name + "> mmio capability not implemented.");
            }
            else
            {
                switch(field.bytes)
                {
                    case 4:
                        this.cpu.io.register_read(port, this, undefined, undefined, read);
                        this.cpu.io.register_write(port, this, undefined, undefined, write);
                        break;
                    case 2:
                        this.cpu.io.register_read(port, this, undefined, read);
                        this.cpu.io.register_write(port, this, undefined, write);
                        break;
                    case 1:
                        this.cpu.io.register_read(port, this, read);
                        this.cpu.io.register_write(port, this, write);
                        break;
                    default:
                        dbg_assert(false,
                            "VirtIO device <" + this.name + "> invalid capability field width");
                        break;
                }
            }

            port += field.bytes;
        });
    });

    // Terminate linked list with null pointer.
    // The field cap_next is at offset 1.
    this.pci_space[cap_ptr + 1] = 0;
};


VirtIO.prototype.get_state = function()
{
    var state = [];

    // TODO: Upgrade
    state[0] = 0; // unused
    state[1] = this.queue_select;
    state[2] = this.device_status;
    state[3] = this.isr;
    state[4] = this.last_idx;
    state[5] = this.queue_size;
    state[6] = this.queue_address;
    state[7] = this.device;

    return state;
};

VirtIO.prototype.set_state = function(state)
{
    // TODO: Upgrade
    this.queue_select = state[1];
    this.device_status = state[2];
    this.isr = state[3];
    this.last_idx = state[4];
    this.queue_size = state[5];
    this.queue_address = state[6];

    this.device = state[7];
    this.device.SendReply = this.device_reply.bind(this);
};

VirtIO.prototype.reset = function()
{
    this.device_feature_select = 0;
    this.driver_feature_select = 0;
    this.driver_feature.set(this.device_feature);

    this.features_ok = true;
    this.device_status = 0;

    this.queue_select = 0;
    this.queue_selected = this.queues[0];

    for(var queue of this.queues)
    {
        queue.reset();
    }

    this.config_has_changed = false;
    this.config_generation = 0;

    this.lower_irq();

    // Old:
    this.queue_select = 0;
    this.device_status = 0;
    this.isr = 0;

    this.last_idx = 0;
    this.queue_size = 32;
    this.queue_address = 0;
};

/**
 * Call this when device-specific configuration state changes.
 * Also called when status DEVICE_NEEDS_RESET is set.
 */
VirtIO.prototype.notify_config_changes = function()
{
    this.config_has_changed = true;

    if(this.device_status & VIRTIO_STATUS_DRIVER_OK)
    {
        this.raise_irq(VIRTIO_ISR_DEVICE_CFG);
    }
    else
    {
        dbg_assert(false,
            "VirtIO device<" + this.name + "> attempted to notify driver before DRIVER_OK");
    }
};

/**
 * To be called after reading any field whose write can trigger notify_config_changes().
 */
VirtIO.prototype.update_config_generation = function()
{
    if(this.config_has_changed)
    {
        this.config_generation++;
        this.config_generation &= 0xFF;
        this.config_has_changed = false;
    }
};

VirtIO.prototype.does_driver_support = function(feature)
{
    // Feature bits are grouped in 32 bits.
    return this.driver_feature[feature >>> 5] & (1 << (feature & 0x1F)) === 1;
};

VirtIO.prototype.pop_request = function(queue_id)
{
    // TODO
};

VirtIO.prototype.push_reply = function()
{
    // TODO
};

/**
 * Call this if an irrecoverable error has been occured.
 * Notifies driver if DRIVER_OK, or when DRIVER_OK gets set.
 */
VirtIO.prototype.needs_reset = function()
{
    dbg_log("Device<" + this.name + "> experienced error - requires reset", LOG_VIRTIO);
    this.device_status |= VIRTIO_STATUS_DEVICE_NEEDS_RESET;

    if(this.device_status & VIRTIO_STATUS_DRIVER_OK)
    {
        this.notify_config_changes();
    }
};

VirtIO.prototype.raise_irq = function(type)
{
    this.isr_status |= type;
    this.pci.raise_irq(this.pci_id);
};

VirtIO.prototype.lower_irq = function()
{
    this.isr_status = 0;
    this.pci.lower_irq(this.pci_id);
};

// TODO: upgrade the following.
VirtIO.prototype.handle_descriptor = function(idx)
{
    var next = idx;
    var desc_start = this.queue_address << 12;

    var buffer_idx = 0;
    var buffers = [];

    do
    {
        var addr = desc_start + next * 16;
        var flags = this.cpu.read16(addr + 12);

        if(flags & VRING_DESC_F_WRITE)
        {
            break;
        }

        if(flags & VRING_DESC_F_INDIRECT) {
            dbg_assert(false, "unsupported");
        }

        var addr_low = this.cpu.read32s(addr);
        var addr_high = this.cpu.read32s(addr + 4);
        var len = this.cpu.read32s(addr + 8) >>> 0;

        buffers.push({
            addr_low: addr_low,
            addr_high: addr_high,
            len: len,
        });

        dbg_log("descriptor: addr=" + h(addr_high, 8) + ":" + h(addr_low, 8) +
                             " len=" + h(len, 8) + " flags=" + h(flags, 4) + " next=" + h(next, 4), LOG_VIRTIO);

        if(flags & VRING_DESC_F_NEXT)
        {
            next = this.cpu.read16(addr + 14);
            dbg_assert(next < this.queue_size);
        }
        else
        {
            next = -1;
            break;
        }
    }
    while(true);

    var infos = {
        start: idx,
        next: next,
    };

    let total_length = 0;

    for(let i = 0; i < buffers.length; i++)
    {
        total_length += buffers[i].len;
    }

    // TODO: Remove this unnecessary copy. Instead, pass list of memory views
    const memory_buffer = new Uint8Array(total_length);
    let pointer = 0;

    for(let i = 0; i < buffers.length; i++)
    {
        const buf = buffers[i];
        memory_buffer.set(this.cpu.read_blob(buf.addr_low, buf.len), pointer);
        pointer += buf.len;
    }

    this.device.ReceiveRequest(infos, memory_buffer);
};

// TODO: upgrade the following.
VirtIO.prototype.device_reply = function(queueidx, infos)
{
    if(infos.next === -1)
    {
        dbg_log("Reply to invalid index", LOG_VIRTIO);
        return;
    }

    var mask = this.queue_size - 1;
    var result_length = this.device.replybuffersize;

    var next = infos.next;
    var desc_start = this.queue_address << 12;

    var buffers = [];

    do
    {
        var addr = desc_start + next * 16;
        var flags = this.cpu.read16(addr + 12);

        if((flags & VRING_DESC_F_WRITE) === 0)
        {
            dbg_log("Bug: Readonly ring after writeonly ring", LOG_VIRTIO);
            break;
        }

        var addr_low = this.cpu.read32s(addr);
        var addr_high = this.cpu.read32s(addr + 4);
        var len = this.cpu.read32s(addr + 8) >>> 0;

        buffers.push({
            addr_low: addr_low,
            addr_high: addr_high,
            len: len,
        });

        dbg_log("descriptor: addr=" + h(addr_high, 8) + ":" + h(addr_low, 8) +
                             " len=" + h(len, 8) + " flags=" + h(flags, 4) + " next=" + h(next, 4), LOG_VIRTIO);

        if(flags & VRING_DESC_F_NEXT)
        {
            next = this.cpu.read16(addr + 14);
            dbg_assert(next < this.queue_size);
        }
        else
        {
            break;
        }
    }
    while(true);

    var buffer_idx = 0;

    for(var i = 0; i < result_length; )
    {
        if(buffer_idx === buffers.length)
        {
            dbg_log("Write more data than descriptor has", LOG_VIRTIO);
            return 0;
        }

        const buf = buffers[buffer_idx++];
        const slice = this.device.replybuffer.subarray(i, i + buf.len);

        this.cpu.write_blob(slice, buf.addr_low);
        i += buf.len;
    }

    var used_desc_start = (this.queue_address << 12) + 16 * this.queue_size + 4 + 2 * this.queue_size;
    used_desc_start = used_desc_start + 4095 & ~4095;

    var flags = this.cpu.read16(used_desc_start);
    var used_idx = this.cpu.read16(used_desc_start + 2);
    this.cpu.write16(used_desc_start + 2, used_idx + 1);

    dbg_log("used descriptor: addr=" + h(used_desc_start, 8) + " flags=" + h(flags, 4) + " idx=" + h(used_idx, 4), LOG_VIRTIO);

    used_idx &= mask;
    var used_desc_offset = used_desc_start + 4 + used_idx * 8;
    this.cpu.write32(used_desc_offset, infos.start);
    this.cpu.write32(used_desc_offset + 4, result_length);

    this.isr |= 1;
    this.pci.raise_irq(this.pci_id);
};

/**
 * @constructor
 * @param {CPU} cpu
 * @param {VirtQueue_Options} options
 */
function VirtQueue(cpu, options)
{
    /** @type {CPU} */
    this.cpu = cpu;

    // Number of entries.
    this.size = options.size_supported;
    this.size_supported = options.size_supported;
    this.enable = 0;
    this.notify_offset = options.notify_offset;

    this.desc_table = null;
    this.desc_table_addr = 0;
    this.avail_ring = null;
    this.avail_ring_addr = 0;
    this.used_ring = null;
    this.used_ring_addr = 0;

    this.reset();
}

VirtQueue.prototype.reset = function()
{
    this.size = this.size_supported;
    this.enable = 0;
    this.desc_table = null;
    this.desc_table_addr = 0;
    this.avail_ring = null;
    this.avail_ring_addr = 0;
    this.used_ring = null;
    this.used_ring_addr = 0;
};

VirtQueue.prototype.push_reply = function()
{
    // TODO
};

VirtQueue.prototype.pop_request = function()
{
    // TODO
};

/**
 * @param {number} address
 */
VirtQueue.prototype.set_desc_table_address = function(address)
{
    var table_size = this.size * VIRTQ_DESC_ENTRYSIZE;
    var data_view = new DataView(this.cpu.mem8.buffer, address, address + table_size);
    this.desc_table_addr = address;
    this.desc_table =
    {
        get_addr_low: i => data_view.getUint32(i * VIRTQ_DESC_ENTRYSIZE, true),
        get_addr_high: i => data_view.getUint32(i * VIRTQ_DESC_ENTRYSIZE + 4, true),
        get_len: i => data_view.getUint32(i * VIRTQ_DESC_ENTRYSIZE + 8, true),
        get_flags: i => data_view.getUint16(i * VIRTQ_DESC_ENTRYSIZE + 12, true),
        get_next: i => data_view.getUint16(i * VIRTQ_DESC_ENTRYSIZE + 14, true),
    };
};

/**
 * @param {number} address
 */
VirtQueue.prototype.set_avail_ring_address = function(address)
{
    var ring_size = VIRTQ_AVAIL_BASESIZE + this.size * VIRTQ_AVAIL_ENTRYSIZE;
    var data_view = new DataView(this.cpu.mem8.buffer, address, address + ring_size);
    this.avail_ring_addr = address;
    this.avail_ring =
    {
        get_flags: () => data_view.getUint16(0, true),
        get_idx: () => data_view.getUint16(2, true),
        get_entry: i => data_view.getUint16(2 + VIRTQ_AVAIL_ENTRYSIZE * i, true),
        get_used_event: () => data_view.getUint16(2 + VIRTQ_AVAIL_ENTRYSIZE * this.size, true),
    };
};

/**
 * @param {number} address
 */
VirtQueue.prototype.set_used_ring_address = function(address)
{
    var ring_size = VIRTQ_USED_BASESIZE + this.size * VIRTQ_USED_ENTRYSIZE;
    var data_view = new DataView(this.cpu.mem8.buffer, address, address + ring_size);
    this.used_ring_addr = address;
    this.used_ring =
    {
        get_flags: () => data_view.getUint16(0, true),
        get_idx: () => data_view.getUint16(2, true),
        get_entry_id: i => data_view.getUint16(2 + VIRTQ_USED_ENTRYSIZE * i, true),
        set_entry_id: (i, value) => data_view.setUint32(2 + VIRTQ_USED_ENTRYSIZE * i, value, true),
        get_entry_len: i => data_view.getUint16(6 + VIRTQ_USED_ENTRYSIZE * i, true),
        set_entry_len: (i, value) => data_view.setUint32(6 + VIRTQ_USED_ENTRYSIZE * i, value, true),
        get_avail_event: () => data_view.getUint16(2 + VIRTQ_AVAIL_ENTRYSIZE * this.size, true),
    };
};
