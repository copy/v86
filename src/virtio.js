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
var VIRTIO_F_RING_INDIRECT_DESC = 28;
/** @const */
var VIRTIO_F_RING_EVENT_IDX = 29;
/** @const */
var VIRTIO_F_VERSION_1 = 32;

// Queue struct sizes.

/**
 * @const
 * Size (bytes) of the virtq_desc struct per queue size.
 */
var VIRTQ_DESC_ENTRYSIZE = 16;
/**
 * @const
 * Size (bytes) of the virtq_avail struct ignoring ring entries.
 */
var VIRTQ_AVAIL_BASESIZE = 6;
/**
 * @const
 * Size (bytes) of the virtq_avail struct per queue size.
 */
var VIRTQ_AVAIL_ENTRYSIZE = 2;
/**
 * @const
 * Size (bytes) of the virtq_used struct ignoring ring entries.
 */
var VIRTQ_USED_BASESIZE = 6;
/**
 * @const
 * Size (bytes) of the virtq_desc struct per queue size.
 */
var VIRTQ_USED_ENTRYSIZE = 8;
/**
 * @const
 * Mask for wrapping the idx field of the virtq_used struct so that the value
 * naturally overflows after 65535 (idx is a word).
 */
var VIRTQ_IDX_MASK = 0xFFFF;

// Queue flags.

/** @const */
var VIRTQ_DESC_F_NEXT = 1;
/** @const */
var VIRTQ_DESC_F_WRITE = 2;
/** @const */
var VIRTQ_DESC_F_INDIRECT = 4;
/** @const */
var VIRTQ_USED_F_NO_NOTIFY = 1;

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
 *     on_driver_ok: function(),
 * }}
 */
var VirtIO_CommonCapabilityOptions;

/**
 * @typedef {
 * {
 *     initial_port: number,
 *     single_handler: boolean,
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
        this.queues.push(new VirtQueue(cpu, this, queue_options));
    }
    this.queue_select = 0;
    this.queue_selected = this.queues[0];

    this.isr_status = 0;

    /** @type {!Array<VirtIO_CapabilityInfo>} */
    var capabilities = [];
    capabilities.push(this.create_common_capability(options.common));
    if(options.notification)
    {
        if(DEBUG)
        {
            var offsets = new Set();
            for(var offset of this.queues.map(q => q.notify_offset))
            {
                offsets.add(offset);
                offset *= options.notification.single_handler ? 0 : 1;
                dbg_assert(options.notification.handlers[offset],
                    "VirtIO device<" + this.name + "> every queue's notifier must exist");
            }
            options.notification.handlers.forEach((handler, index) =>
            {
                dbg_assert(!handler || offsets.has(index),
                    "VirtIO device<" + this.name +"> no defined notify handler should be unused");
            });
        }
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

    cpu.devices.pci.register_device(this);
    this.reset();
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

                    // Note: only set subset of device_features.
                    // Required for is_feature_negotiated().
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
                    else if(data & VIRTIO_STATUS_FAILED)
                    {
                        dbg_log("Warning: Device<" + this.name + "> status failed", LOG_VIRTIO);
                    }
                    else
                    {
                        dbg_log("Device<" + this.name +"> status: " +
                                ((data & VIRTIO_STATUS_ACKNOWLEDGE) ? "ACKNOWLEDGE " : "") +
                                ((data & VIRTIO_STATUS_DRIVER) ? "DRIVER " : "") +
                                ((data & VIRTIO_STATUS_DRIVER_OK) ? "DRIVER_OK" : "") +
                                ((data & VIRTIO_STATUS_FEATURES_OK) ? "FEATURES_OK " : "") +
                                ((data & VIRTIO_STATUS_DEVICE_NEEDS_RESET) ? "DEVICE_NEEDS_RESET" : ""),
                                LOG_VIRTIO);
                    }

                    if((data & ~this.device_status & VIRTIO_STATUS_DRIVER_OK) &&
                        (this.device_status & VIRTIO_STATUS_DEVICE_NEEDS_RESET))
                    {
                        // We couldn't notify NEEDS_RESET earlier because DRIVER_OK was not set.
                        // Now it has been set, notify now.
                        this.notify_config_changes();
                    }

                    // Don't set FEATURES_OK if our device doesn't support requested features.
                    if(!this.features_ok)
                    {
                        if(DEBUG && (data & VIRTIO_STATUS_FEATURES_OK))
                        {
                            dbg_log("Removing FEATURES_OK", LOG_VIRTIO);
                        }
                        data &= ~VIRTIO_STATUS_FEATURES_OK;
                    }

                    this.device_status = data;

                    if(data & ~this.device_status & VIRTIO_STATUS_DRIVER_OK)
                    {
                        options.on_driver_ok();
                    }
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
                    if(!this.queue_selected)
                    {
                        return;
                    }
                    if(data & data - 1)
                    {
                        dbg_log("Warning: dev<" + this.name +"> " +
                                "Given queue size was not a power of 2. " +
                                "Rounding up to next power of 2.", LOG_VIRTIO);
                        data = 1 << (v86util.int_log2(data - 1) + 1);
                    }
                    if(data > this.queue_selected.size_supported)
                    {
                        dbg_log("Warning: dev<" + this.name +"> " +
                                "Trying to set queue size greater than supported. " +
                                "Clamping to supported size.", LOG_VIRTIO);
                        data = this.queue_selected.size_supported;
                    }
                    this.queue_selected.set_size(data);
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
                read: () => this.queue_selected ? this.queue_selected.enabled | 0 : 0,
                write: data =>
                {
                    if(!this.queue_selected)
                    {
                        return;
                    }
                    if(data === 1)
                    {
                        if(this.queue_selected.is_configured())
                        {
                            this.queue_selected.enable();
                        }
                        else
                        {
                            dbg_log("Driver bug: tried enabling unconfigured queue", LOG_VIRTIO);
                        }
                    }
                    else if(data === 0)
                    {
                        dbg_log("Driver bug: tried writing 0 to queue_enable", LOG_VIRTIO);
                    }
                },
            },
            {
                bytes: 2,
                name: "queue_notify_off",
                read: () => this.queue_selected ? this.queue_selected.notify_offset : 0,
                write: data => { /* read only */ },
            },
            {
                bytes: 4,
                name: "queue_desc (low dword)",
                read: () => this.queue_selected ? this.queue_selected.desc_addr : 0,
                write: data =>
                {
                    if(this.queue_selected) this.queue_selected.set_desc_addr(data);
                },
            },
            {
                bytes: 4,
                name: "queue_desc (high dword)",
                read: () => 0, // TODO: 64 bit addresses?
                write: data =>
                {
                    dbg_log("Warning: High dword of 64 bit queue_desc ignored", LOG_VIRTIO);
                },
            },
            {
                bytes: 4,
                name: "queue_avail (low dword)",
                read: () => this.queue_selected ? this.queue_selected.avail_addr : 0,
                write: data =>
                {
                    if(this.queue_selected) this.queue_selected.set_avail_addr(data);
                },
            },
            {
                bytes: 4,
                name: "queue_avail (high dword)",
                read: () => 0, // TODO: 64 bit addresses?
                write: data =>
                {
                    dbg_log("Warning: High dword of 64 bit queue_avail ignored", LOG_VIRTIO);
                },
            },
            {
                bytes: 4,
                name: "queue_used (low dword)",
                read: () => this.queue_selected ? this.queue_selected.used_addr : 0,
                write: data =>
                {
                    if(this.queue_selected) this.queue_selected.set_used_addr(data);
                },
            },
            {
                bytes: 4,
                name: "queue_used (high dword)",
                read: () => 0, // TODO: 64 bit addresses?
                write: data =>
                {
                    dbg_log("Warning: High dword of 64 bit queue_used ignored", LOG_VIRTIO);
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

    if(options.single_handler)
    {
        dbg_assert(options.handlers.length === 1,
            "VirtIO device<" + this.name + "> too many notify handlers specified: expected single handler");

        // Forces all queues to use the same address for notifying.
        notify_off_multiplier = 0;
    }
    else
    {
        notify_off_multiplier = 2;
    }

    for(var i = 0; i < options.handlers.length; i++)
    {
        notify_struct.push(
        {
            bytes: 2,
            name: "notify" + i,
            read: () => 0xFFFF,
            write: options.handlers[i] || (data => {}),
        });
    }

    var cap =
    {
        type: VIRTIO_PCI_CAP_NOTIFY_CFG,
        bar: 1,
        port: options.initial_port,
        use_mmio: false,
        offset: 0,
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
    dbg_assert(~options.offset & 0x3,
            "VirtIO device<" + this.name + "> device specific cap offset must be 4-byte aligned");

    var cap =
    {
        type: VIRTIO_PCI_CAP_DEVICE_CFG,
        bar: 5,
        port: options.initial_port,
        use_mmio: false,
        offset: 0,
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

        var bar_size = cap.struct.reduce((bytes, field) => bytes + field.bytes, 0);
        bar_size += cap.offset;

        // Round up to next power of 2,
        // Minimum 16 bytes for its size to be detectable in general (esp. mmio).
        bar_size = bar_size < 16 ? 16 : 1 << (v86util.int_log2(bar_size - 1) + 1);

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
                    dbg_log("Device<" + this.name + "> " +
                            "cap[" + cap.type + "] " +
                            "write[" + field.name + "] " +
                            "<= " + h(data, field.bytes * 8),
                        LOG_VIRTIO);

                    field.write(data);
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

    state[0] = this.device_feature_select;
    state[1] = this.driver_feature_select;
    state[2] = this.device_feature;
    state[3] = this.driver_feature;
    state[4] = this.features_ok;
    state[5] = this.device_status;
    state[6] = this.config_has_changed;
    state[7] = this.config_generation;
    state[8] = this.isr_status;
    state[9] = this.queue_select;
    state = state.concat(this.queues);

    return state;
};

VirtIO.prototype.set_state = function(state)
{
    this.device_feature_select = state[0];
    this.driver_feature_select = state[1];
    this.device_feature = state[2];
    this.driver_feature = state[3];
    this.features_ok = state[4];
    this.device_status = state[5];
    this.config_has_changed = state[6];
    this.config_generation = state[7];
    this.isr_status = state[8];
    this.queue_select = state[9];
    this.queues = state.slice(10);
    this.queue_selected = this.queues[this.queue_select] || null;
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

VirtIO.prototype.is_feature_negotiated = function(feature)
{
    // Feature bits are grouped in 32 bits.
    // Note: earlier we chose not to set invalid features into driver_feature.
    return (this.driver_feature[feature >>> 5] & (1 << (feature & 0x1F))) > 0;
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
    dbg_log("Raise irq " + h(type), LOG_VIRTIO);
    this.isr_status |= type;
    this.pci.raise_irq(this.pci_id);
};

VirtIO.prototype.lower_irq = function()
{
    dbg_log("Lower irq ", LOG_VIRTIO);
    this.isr_status = 0;
    this.pci.lower_irq(this.pci_id);
};

/**
 * @constructor
 * @param {CPU} cpu
 * @param {VirtQueue_Options} options
 */
function VirtQueue(cpu, virtio, options)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    /** @const @type {VirtIO} */
    this.virtio = virtio;

    // Number of entries.
    this.size = options.size_supported;
    this.size_supported = options.size_supported;
    this.mask = this.size - 1;
    this.enabled = false;
    this.notify_offset = options.notify_offset;

    this.desc = null;
    this.desc_addr = 0;

    this.avail = null;
    this.avail_addr = 0;
    this.avail_last_idx = 0;

    this.used = null;
    this.used_addr = 0;
    this.num_staged_replies = 0;

    this.reset();
}

VirtQueue.prototype.get_state = function()
{
    var state = [];

    state[0] = this.size;
    state[1] = this.size_supported;
    state[2] = this.enabled;
    state[3] = this.notify_offset;
    state[4] = this.desc_addr;
    state[5] = this.avail_addr;
    state[6] = this.avail_last_idx;
    state[7] = this.used_addr;
    state[8] = this.num_staged_replies;

    return state;
};

VirtQueue.prototype.set_state = function(state)
{
    this.size = state[0];
    this.size_supported = state[1];
    this.enabled = state[2];
    this.notify_offset = state[3];
    this.desc_addr = state[4];
    this.avail_addr = state[5];
    this.avail_last_idx = state[6];
    this.used_addr = state[7];
    this.num_staged_replies = state[8];

    this.mask = this.size - 1;
    this.desc = null;
    this.avail = null;
    this.used = null;
    if(this.desc_addr) this.set_desc_addr(this.desc_addr);
    if(this.avail_addr) this.set_avail_addr(this.avail_addr);
    if(this.used_addr) this.set_used_addr(this.used_addr);
};

VirtQueue.prototype.reset = function()
{
    this.set_size(this.size_supported);
    this.enabled = false;
    this.desc = null;
    this.desc_addr = 0;
    this.avail = null;
    this.avail_addr = 0;
    this.avail_last_idx = 0;
    this.used = null;
    this.used_addr = 0;
    this.num_staged_replies = 0;
};

VirtQueue.prototype.is_configured = function()
{
    return this.desc && this.avail && this.used;
};

VirtQueue.prototype.enable = function()
{
    dbg_assert(this.is_configured(), "VirtQueue must be configured before enabled");
    this.enabled = true;
};

VirtQueue.prototype.set_size = function(size)
{
    dbg_assert((size & size - 1) === 0, "VirtQueue size must be power of 2 or zero");
    dbg_assert(size <= this.size_supported, "VirtQueue size must be within supported size");
    this.size = size;
    this.mask = size - 1;

    // Data views are now invalidated. Update if already set.
    if(this.desc) this.set_desc_addr(this.desc_addr);
    if(this.avail) this.set_avail_addr(this.avail_addr);
    if(this.used) this.set_used_addr(this.used_addr);
};

/**
 * @return {number}
 */
VirtQueue.prototype.count_requests = function()
{
    dbg_assert(this.avail, "VirtQueue addresses must be configured before use");
    return (this.avail.get_idx() - this.avail_last_idx) & this.mask;
};

/**
 * @return {boolean}
 */
VirtQueue.prototype.has_request = function()
{
    dbg_assert(this.avail, "VirtQueue addresses must be configured before use");
    return (this.avail.get_idx() & this.mask) !== this.avail_last_idx;
};

/**
 * @return {VirtQueueBufferChain}
 */
VirtQueue.prototype.pop_request = function()
{
    dbg_assert(this.avail, "VirtQueue addresses must be configured before use");
    dbg_assert(this.has_request(), "VirtQueue must not pop nonexistent request");

    var desc_idx = this.avail.get_entry(this.avail_last_idx);
    dbg_log("Pop request: avail_last_idx=" + this.avail_last_idx +
        " desc_idx=" + desc_idx, LOG_VIRTIO);

    var bufchain = new VirtQueueBufferChain(this, desc_idx);

    this.avail_last_idx = this.avail_last_idx + 1 & this.mask;

    return bufchain;
};

/**
 * Stage a buffer chain into the used ring.
 * Can call push_reply many times before flushing to batch replies together.
 * Note: this reply is not visible to driver until flush_replies is called.
 * @param {VirtQueueBufferChain} bufchain
 */
VirtQueue.prototype.push_reply = function(bufchain)
{
    dbg_assert(this.used, "VirtQueue addresses must be configured before use");
    dbg_assert(this.num_staged_replies < this.size, "VirtQueue replies must not exceed queue size");

    var used_idx = this.used.get_idx() + this.num_staged_replies & this.mask;
    dbg_log("Push reply: used_idx=" + used_idx +
        " desc_idx=" + bufchain.head_idx, LOG_VIRTIO);

    this.used.set_entry_id(used_idx, bufchain.head_idx);
    this.used.set_entry_len(used_idx, bufchain.length_written);
    this.num_staged_replies++;
};

/**
 * Makes replies visible to driver by updating the used ring idx and
 * firing appropriate interrupt if needed.
 */
VirtQueue.prototype.flush_replies = function()
{
    dbg_assert(this.used, "VirtQueue addresses must be configured before use");

    if(this.num_staged_replies === 0)
    {
        dbg_log("flush_replies: Nothing to flush", LOG_VIRTIO);
        return;
    }

    dbg_log("Flushing " + this.num_staged_replies + " replies", LOG_VIRTIO);
    var old_idx = this.used.get_idx();
    var new_idx = old_idx + this.num_staged_replies & VIRTQ_IDX_MASK;
    this.used.set_idx(new_idx);

    this.num_staged_replies = 0;

    if(this.virtio.is_feature_negotiated(VIRTIO_F_RING_EVENT_IDX))
    {
        var used_event = this.avail.get_used_event();

        // Fire irq when idx values associated with the pushed reply buffers
        // has reached or gone past used_event.
        var has_passed = old_idx <= used_event && used_event < new_idx;

        // Has overflowed? Assumes num_staged_replies > 0.
        if(new_idx <= old_idx)
        {
            has_passed = used_event < new_idx || old_idx <= used_event;
        }

        if(has_passed)
        {
            this.virtio.raise_irq(VIRTIO_ISR_QUEUE);
        }
    }
    else
    {
        if(~this.avail.get_flags() & VIRTQ_USED_F_NO_NOTIFY)
        {
            this.virtio.raise_irq(VIRTIO_ISR_QUEUE);
        }
    }
};

/**
 * @param {number} address
 */
VirtQueue.prototype.set_desc_addr = function(address)
{
    this.desc_addr = address;
    this.desc = this.create_desc_table(address);
};

/**
 * @param {number} address
 */
VirtQueue.prototype.create_desc_table = function(address)
{
    var desc_table =
    {
        get_addr_low: i => this.cpu.read32s(address + i * VIRTQ_DESC_ENTRYSIZE),
        get_addr_high: i => this.cpu.read32s(address + i * VIRTQ_DESC_ENTRYSIZE + 4),
        get_len: i => this.cpu.read32s(address + i * VIRTQ_DESC_ENTRYSIZE + 8),
        get_flags: i => this.cpu.read16(address + i * VIRTQ_DESC_ENTRYSIZE + 12),
        get_next: i => this.cpu.read16(address + i * VIRTQ_DESC_ENTRYSIZE + 14),
    };
    return desc_table;
};

/**
 * @param {number} address
 */
VirtQueue.prototype.set_avail_addr = function(address)
{
    this.avail_addr = address;
    this.avail =
    {
        get_flags: () => this.cpu.read16(address),
        get_idx: () => this.cpu.read16(address + 2),
        get_entry: i => this.cpu.read16(address + 4 + VIRTQ_AVAIL_ENTRYSIZE * i),
        get_used_event: () => this.cpu.read16(address + 4 + VIRTQ_AVAIL_ENTRYSIZE * this.size),
    };
};

/**
 * @param {number} address
 */
VirtQueue.prototype.set_used_addr = function(address)
{
    this.used_addr = address;
    this.used =
    {
        get_flags: () => this.cpu.read16(address),
        get_idx: () => this.cpu.read16(address + 2),
        get_entry_id: i => this.cpu.read32s(address + 4 + VIRTQ_USED_ENTRYSIZE * i),
        set_entry_id: (i, value) => this.cpu.write32(address + 4 + VIRTQ_USED_ENTRYSIZE * i, value),
        get_entry_len: i => this.cpu.read32s(address + 8 + VIRTQ_USED_ENTRYSIZE * i),
        set_entry_len: (i, value) => this.cpu.write32(address + 8 + VIRTQ_USED_ENTRYSIZE * i, value),
        get_avail_event: () => this.cpu.read16(address + 4 + VIRTQ_AVAIL_ENTRYSIZE * this.size),
    };
};

/**
 * Traverses through descriptor chain starting at head_id.
 * Provides means to read/write to buffers represented by the descriptors.
 * @constructor
 * @param {VirtQueue} virtqueue
 * @param {number} head_idx
 */
function VirtQueueBufferChain(virtqueue, head_idx)
{
    /** @const @type {CPU} */
    this.cpu = virtqueue.cpu;

    /** @const @type {VirtIO} */
    this.virtio = virtqueue.virtio;

    this.head_idx = head_idx;

    this.read_buffers = [];
    // Pointers for sequential consumption via get_next_blob.
    this.read_buffer_idx = 0;
    this.read_buffer_offset = 0;
    this.length_readable = 0;

    this.write_buffers = [];
    // Pointers for sequential write via set_next_blob.
    this.write_buffer_idx = 0;
    this.write_buffer_offset = 0;
    this.length_written = 0;
    this.length_writable = 0;

    // Traverse chain to discover buffers.
    // - There shouldn't be an excessive amount of descriptor elements.
    var table = virtqueue.desc;
    var desc_idx = head_idx;
    var chain_length = 0;
    var chain_max = virtqueue.size;
    var writable_region = false;
    var has_indirect_feature = this.virtio.is_feature_negotiated(VIRTIO_F_RING_INDIRECT_DESC);
    dbg_log("<<< Descriptor chain start", LOG_VIRTIO);
    do
    {
        var flags = table.get_flags(desc_idx);
        var addr_low = table.get_addr_low(desc_idx);
        var addr_high = table.get_addr_high(desc_idx);
        var len = table.get_len(desc_idx);
        var next = table.get_next(desc_idx);

        dbg_log("descriptor: idx=" + desc_idx + " addr=" + h(addr_high, 8) + ":" + h(addr_low, 8) +
            " len=" + h(len, 8) + " flags=" + h(flags, 4) + " next=" + h(next, 4), LOG_VIRTIO);

        if(has_indirect_feature && (flags & VIRTQ_DESC_F_INDIRECT))
        {
            if(DEBUG && (flags & VIRTQ_DESC_F_NEXT))
            {
                dbg_log("Driver bug: has set VIRTQ_DESC_F_NEXT flag in an indirect table descriptor", LOG_VIRTIO);
            }

            var table_address = table.get_addr_low(desc_idx);
            var table_length = table.get_len(desc_idx);

            // Carry on using indirect table, starting at first entry.
            table = virtqueue.create_desc_table(table_address);
            desc_idx = 0;
            chain_length = 0;
            chain_max = table_length / VIRTQ_DESC_ENTRYSIZE;
            dbg_log("start indirect", LOG_VIRTIO);
            continue;
        }

        var buf =
        {
            addr_low: addr_low,
            addr_high: addr_high,
            len: len,
        };

        if(flags & VIRTQ_DESC_F_WRITE)
        {
            writable_region = true;
            this.read_buffers.push(buf);
            this.length_readable += buf.len;
        }
        else
        {
            if(writable_region)
            {
                dbg_log("Driver bug: readonly buffer after writeonly buffer within chain", LOG_VIRTIO);
                break;
            }
            this.write_buffers.push(buf);
            this.length_writable += buf.len;
        }

        chain_length++;
        if(chain_length > chain_max)
        {
            dbg_log("Driver bug: descriptor chain cycle detected", LOG_VIRTIO);
            break;
        }

        if(flags & VIRTQ_DESC_F_NEXT)
        {
            desc_idx = next;
        }
        else
        {
            break;
        }
    }
    while(true);
    dbg_log("Descriptor chain end >>>", LOG_VIRTIO);
}

/**
 * Reads the next blob of memory represented by the buffer chain into dest_buffer.
 * @param {Uint8Array} dest_buffer
 * @return {number} Number of bytes successfully read.
 */
VirtQueueBufferChain.prototype.get_next_blob = function(dest_buffer)
{
    var dest_offset = 0;
    var remaining = dest_buffer.length;

    while(remaining)
    {
        if(this.read_buffer_idx === this.read_buffers.length)
        {
            dbg_log("Device<" + this.virtio.name + "> Read more than device-readable buffers has", LOG_VIRTIO);
            break;
        }
        var buf = this.read_buffers[this.read_buffer_idx];
        var read_address = buf.addr_low + this.read_buffer_offset;
        var read_length = buf.len - this.read_buffer_offset;

        if(read_length > remaining)
        {
            read_length = remaining;
            this.read_buffer_offset += remaining;
        }
        else
        {
            this.read_buffer_idx++;
            this.read_buffer_offset = 0;
        }

        dest_buffer.set(this.cpu.read_blob(read_address, read_length), dest_offset);

        dest_offset += read_length;
        remaining -= read_length;
    }

    return dest_offset;
};

/**
 * Appends contents of src_buffer into the memory represented by the buffer chain.
 * @param {Uint8Array} src_buffer
 * @return {number} Number of bytes successfully written.
 */
VirtQueueBufferChain.prototype.set_next_blob = function(src_buffer)
{
    var src_offset = 0;
    var remaining = src_buffer.length;

    while(remaining)
    {
        if(this.write_buffer_idx === this.write_buffers.length)
        {
            dbg_log("Device<" + this.virtio.name + "> Write more than device-writable capacity", LOG_VIRTIO);
            break;
        }

        var buf = this.write_buffers[this.write_buffer_idx];

        var write_address = buf.addr_low + this.write_buffer_offset;
        var write_length = buf.len - this.write_buffer_offset;
        var next_offset = 0;

        if(write_length > remaining)
        {
            write_length = remaining;
            this.write_buffer_offset += remaining;
        }
        else
        {
            this.write_buffer_idx++;
            this.write_buffer_offset = 0;
        }

        var src_end = src_offset + write_length;
        this.cpu.write_blob(src_buffer.subarray(src_offset, src_end), write_address);

        src_offset += write_length;
        remaining -= write_length;
    }

    this.length_written += src_offset;
    return src_offset;
};
