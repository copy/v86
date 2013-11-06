"use strict";

var 
/** @const */  PCI_VENDOR_ID =		0x00	/* 16 bits */
/** @const */ ,PCI_DEVICE_ID =		0x02	/* 16 bits */
/** @const */ ,PCI_COMMAND =		0x04	/* 16 bits */
/** @const */ ,PCI_BASE_ADDRESS_0 =	0x10	/* 32 bits */
/** @const */ ,PCI_BASE_ADDRESS_1 =	0x14	/* 32 bits [htype 0,1 only] */
/** @const */ ,PCI_BASE_ADDRESS_2 =	0x18	/* 32 bits [htype 0 only] */
/** @const */ ,PCI_BASE_ADDRESS_3 =	0x1c	/* 32 bits */
/** @const */ ,PCI_BASE_ADDRESS_4 =	0x20	/* 32 bits */
/** @const */ ,PCI_BASE_ADDRESS_5 =	0x24	/* 32 bits */
/** @const */ ,PCI_INTERRUPT_LINE =	0x3c	/* 8 bits */
/** @const */ ,PCI_CLASS_REVISION =	0x08;	/* High 24 bits are class, low 8 revision */

/** @constructor */
function PCI(dev)
{
    var
        io = dev.io,
        pci_data = 0,
        pci_counter = 0,
        pci_response = -1,
        pci_status = -1,
        self = this;

    // TODO: Change the format of this
    this.devices = {};

    /*
    io.register_write(0xCF9, function(value)
    {
        dbg_log("PCI reboot: " + h(value, 2), LOG_PCI);

        // PCI reboot
        if(value & 6)
        {
            cpu_restart();
        }
    });*/

    io.register_read(0xCFC, function()
    {
        return pci_response & 0xFF;
    });

    io.register_read(0xCFD, function()
    {
        return pci_response >> 8 & 0xFF;
    });
    io.register_read(0xCFE, function()
    {
        return pci_response >> 16 & 0xFF;
    });
    io.register_read(0xCFF, function()
    {
        return pci_response >> 24 & 0xFF;
    });

    io.register_read(0xCF8, function()
    {
        return pci_status & 0xFF;
    });
    io.register_read(0xCF9, function()
    {
        return pci_status >> 8 & 0xFF;
    });
    io.register_read(0xCFA, function()
    {
        return pci_status >> 16 & 0xFF;
    });
    io.register_read(0xCFB, function()
    {
        return pci_status >> 24 & 0xFF;
    });

    io.register_write(0xCF8, function(out_byte)
    {
        pci_data = pci_data & ~0xFF | out_byte;
    });
    io.register_write(0xCF9, function(out_byte)
    {
        pci_data = pci_data & ~0xFF00 | out_byte << 8;
    });
    io.register_write(0xCFA, function(out_byte)
    {
        pci_data = pci_data & ~0xFF0000 | out_byte << 16;
    });
    io.register_write(0xCFB, function(out_byte)
    {
        pci_data = pci_data & 0xFFFFFF | out_byte << 24;
        pci_query(pci_data);
    });

    function pci_query(dword)
    {
        var dbg_line = "PCI: ";
        
        // Bit | .31                     .0
        // Fmt | EBBBBBBBBDDDDDFFFRRRRRR00

        var bdf = (dword & 0x7FFFFFFF) >> 8,
            addr = dword & 0xFC,
            devfn = bdf & 0xFF,
            bus = bdf >> 8,
            dev = bdf >> 3 & 0x1F,
            fn = bdf & 7,
            enabled = dword >> 31 & 1;

        dbg_line += " enabled=" + (enabled);
        dbg_line += " bdf=" + h(bdf);
        dbg_line += " addr=" + h(addr);

        dbg_log(dbg_line + " " + h(dword >>> 0, 8), LOG_PCI);

        if(dword === (0x80000000 | 0))
        {
            pci_status = 0x80000000;
        }
        else if(self.devices[bdf])
        {
            var device = self.devices[bdf];

            pci_status = 0x80000000;

            if(addr === PCI_VENDOR_ID)
            {
                pci_response = device.vendor_id;
            }
            else if(addr === PCI_CLASS_REVISION)
            {
                pci_response = device.class_revision;
            }
            else if(addr === PCI_BASE_ADDRESS_5)
            {
                pci_response = device.iobase;
            }
            else if(addr === PCI_INTERRUPT_LINE)
            {
                pci_response = device.irq;
            }
            else
            {
                dbg_log("unimplemented addr " + h(addr) + " for device " + h(bdf), LOG_PCI);
                pci_response = 0;
            }
        }
        else
        {
            pci_response = 0;
            pci_status = 0;
        }
    }

    this.register_device = function(device, device_id)
    {
        dbg_assert(!this.devices[device_id]);
        this.devices[device_id] = device;
    };

    // ~% lspci -x   
    // 00:00.0 Host bridge: Intel Corporation 4 Series Chipset DRAM Controller (rev 02)
    // 00: 86 80 20 2e 06 00 90 20 02 00 00 06 00 00 00 00
    // 10: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    // 20: 00 00 00 00 00 00 00 00 00 00 00 00 43 10 d3 82
    // 30: 00 00 00 00 e0 00 00 00 00 00 00 00 00 00 00 00
    this.register_device({
        irq: 0,
        iobase: 0,
        vendor_id: 0x8680202e,
        class_revision: 0x06009020,
    }, 0);
}
