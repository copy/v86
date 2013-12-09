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

var 
/** @const */ PCI_CONFIG_ADDRESS = 0xCF8,
/** @const */ PCI_CONFIG_DATA = 0xCFC;

/** @constructor */
function PCI(dev)
{
    var
        io = dev.io,
        pci_data = new Uint8Array(4),
        pci_response = new Uint8Array(4),
        pci_status = new Uint8Array(4),

        pci_data32 = new Int32Array(pci_data.buffer),
        pci_response32 = new Int32Array(pci_response.buffer),
        pci_status32 = new Int32Array(pci_status.buffer),
        pci = this;

    this.devices = Array(0x10000);

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
    
    function pci_write_byte(byte_pos, byte)
    {
        var bdf = pci_data[2] << 8 | pci_data[1],
            addr = pci_data[0] & 0xFC;

        //if(bdf === (7 << 3))
        //{
        //    var device = me.devices[bdf];

        //    (new Uint8Array(device.buffer))[addr] = byte;
        //}
    }

    io.register_write(PCI_CONFIG_DATA, function(out_byte)
    {
        dbg_log("PCI data0: " + h(out_byte, 2) + " addr=" + h(pci_data32[0] >>> 0), LOG_PCI);

    });
    io.register_write(PCI_CONFIG_DATA | 1, function(out_byte)
    {
        dbg_log("PCI data1: " + h(out_byte, 2)+ " addr=" + h(pci_data32[0] >>> 0), LOG_PCI);
    });
    io.register_write(PCI_CONFIG_DATA | 2, function(out_byte)
    {
        dbg_log("PCI data2: " + h(out_byte, 2)+ " addr=" + h(pci_data32[0] >>> 0), LOG_PCI);
    });
    io.register_write(PCI_CONFIG_DATA | 3, function(out_byte)
    {
        dbg_log("PCI data3: " + h(out_byte, 2)+ " addr=" + h(pci_data32[0] >>> 0), LOG_PCI);
    });

    io.register_read(PCI_CONFIG_DATA, function()
    {
        return pci_response[0];
    });
    io.register_read(PCI_CONFIG_DATA | 1, function()
    {
        return pci_response[1];
    });
    io.register_read(PCI_CONFIG_DATA | 2, function()
    {
        return pci_response[2];
    });
    io.register_read(PCI_CONFIG_DATA | 3, function()
    {
        return pci_response[3];
    });

    io.register_read(PCI_CONFIG_ADDRESS, function()
    {
        return pci_status[0];
    });
    io.register_read(PCI_CONFIG_ADDRESS | 1, function()
    {
        return pci_status[1];
    });
    io.register_read(PCI_CONFIG_ADDRESS | 2, function()
    {
        return pci_status[2];
    });
    io.register_read(PCI_CONFIG_ADDRESS | 3, function()
    {
        return pci_status[3];
    });

    io.register_write(PCI_CONFIG_ADDRESS, function(out_byte)
    {
        pci_data[0] = out_byte;
    });
    io.register_write(PCI_CONFIG_ADDRESS | 1, function(out_byte)
    {
        pci_data[1] = out_byte;
    });
    io.register_write(PCI_CONFIG_ADDRESS | 2, function(out_byte)
    {
        pci_data[2] = out_byte;
    });
    io.register_write(PCI_CONFIG_ADDRESS | 3, function(out_byte)
    {
        pci_data[3] = out_byte;

        pci_query();
    });

    function pci_query()
    {
        var dbg_line = "PCI: ";
        
        // Bit | .31                     .0
        // Fmt | EBBBBBBBBDDDDDFFFRRRRRR00

        var bdf = pci_data[2] << 8 | pci_data[1],
            addr = pci_data[0] & 0xFC,
            devfn = bdf & 0xFF,
            bus = bdf >> 8,
            dev = bdf >> 3 & 0x1F,
            fn = bdf & 7,
            enabled = pci_data[3] >> 7;

        dbg_line += " enabled=" + (enabled);
        dbg_line += " bdf=" + h(bdf, 4);
        dbg_line += " addr=" + h(addr, 2);

        //dbg_log(dbg_line + " " + h(pci_data32[0] >>> 0, 8), LOG_PCI);

        var device = pci.devices[bdf];

        if(device !== undefined)
        {
            dbg_log(dbg_line + " " + h(pci_data32[0] >>> 0, 8), LOG_PCI);

            pci_status32[0] = 0x80000000 | 0;

            if(addr < device.byteLength)
            {
                pci_response32[0] = device[addr >> 2];
            }
            else
            {
                pci_response32[0] = 0;
            }
        }
        else
        {
            pci_response32[0] = 0;
            pci_status32[0] = 0;
        }
    }

    this.register_device = function(device, device_id)
    {
        dbg_log("PCI register bdf=" + h(device_id), LOG_PCI);

        dbg_assert(!pci.devices[device_id]);
        dbg_assert(device.length === 64);

        // convert bytewise notation from lspci to double words
        pci.devices[device_id] = new Int32Array(new Uint8Array(device).buffer);
    };

    // Some experimental PCI devices taken from my PC:

    // 00:00.0 Host bridge: Intel Corporation 4 Series Chipset DRAM Controller (rev 02)
    this.register_device([
        0x86, 0x80, 0x20, 0x2e, 0x06, 0x00, 0x90, 0x20, 0x02, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x43, 0x10, 0xd3, 0x82,
        0x00, 0x00, 0x00, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ], 0);

    // 00:1e.0 PCI bridge: Intel Corporation 82801 PCI Bridge (rev 90)
    //this.register_device([
    //    0x86, 0x80, 0x4e, 0x24, 0x07, 0x01, 0x10, 0x00, 0x90, 0x01, 0x04, 0x06, 0x00, 0x00, 0x01, 0x00,
    //    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x05, 0x20, 0xe0, 0xe0, 0x80, 0x22,
    //    0xb0, 0xfe, 0xb0, 0xfe, 0xf1, 0xff, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    //    0x00, 0x00, 0x00, 0x00, 0x50, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x02, 0x00,
    //], 0x1e << 3);

}
