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

/** 
 * @constructor 
 * @param {CPU} cpu
 */
function PCI(cpu)
{
    var
        io = cpu.io,
        pci_addr = new Uint8Array(4),
        pci_response = new Uint8Array(4),
        pci_status = new Uint8Array(4),

        pci_addr32 = new Int32Array(pci_addr.buffer),
        pci_response32 = new Int32Array(pci_response.buffer),
        pci_status32 = new Int32Array(pci_status.buffer),
        pci = this;

    var device_spaces = Array(0x10000),
        devices = Array(0x10000);

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
    
    io.register_write_consecutive(PCI_CONFIG_DATA, this, 
        function(out_byte)
        {
            dbg_log("PCI data0: " + h(out_byte, 2) + " addr=" + h(pci_addr32[0] >>> 0), LOG_PCI);
            pci_write_byte(0, out_byte);
        },
        function(out_byte)
        {
            dbg_log("PCI data1: " + h(out_byte, 2) + " addr=" + h(pci_addr32[0] >>> 0), LOG_PCI);
            pci_write_byte(1, out_byte);
        },
        function(out_byte)
        {
            dbg_log("PCI data2: " + h(out_byte, 2) + " addr=" + h(pci_addr32[0] >>> 0), LOG_PCI);
            pci_write_byte(2, out_byte);
        },
        function(out_byte)
        {
            dbg_log("PCI data3: " + h(out_byte, 2) + " addr=" + h(pci_addr32[0] >>> 0), LOG_PCI);
            pci_write_byte(3, out_byte);
        }
    );

    io.register_read_consecutive(PCI_CONFIG_DATA, this, 
        function()
        {
            return pci_response[0];
        },
        function()
        {
            return pci_response[1];
        },
        function()
        {
            return pci_response[2];
        },
        function()
        {
            return pci_response[3];
        }
    );

    io.register_read_consecutive(PCI_CONFIG_ADDRESS, this, 
        function()
        {
            return pci_status[0];
        },
        function()
        {
            return pci_status[1];
        },
        function()
        {
            return pci_status[2];
        },
        function()
        {
            return pci_status[3];
        }
    );

    io.register_write_consecutive(PCI_CONFIG_ADDRESS, this, 
        function(out_byte)
        {
            pci_addr[0] = out_byte;
        },
        function(out_byte)
        {
            pci_addr[1] = out_byte;
        },
        function(out_byte)
        {
            pci_addr[2] = out_byte;
        },
        function(out_byte)
        {
            pci_addr[3] = out_byte;
            pci_query();
        }
    );

    function pci_query()
    {
        var dbg_line = "PCI: ";
        
        // Bit | .31                     .0
        // Fmt | EBBBBBBBBDDDDDFFFRRRRRR00

        var bdf = pci_addr[2] << 8 | pci_addr[1],
            addr = pci_addr[0] & 0xFC,
            devfn = bdf & 0xFF,
            bus = bdf >> 8,
            dev = bdf >> 3 & 0x1F,
            fn = bdf & 7,
            enabled = pci_addr[3] >> 7;

        dbg_line += " enabled=" + (enabled);
        dbg_line += " bdf=" + h(bdf, 4);
        dbg_line += " addr=" + h(addr, 2);

        //dbg_log(dbg_line + " " + h(pci_addr32[0] >>> 0, 8), LOG_PCI);

        var device = device_spaces[bdf];

        if(device !== undefined)
        {
            pci_status32[0] = 0x80000000 | 0;

            if(addr < device.byteLength)
            {
                pci_response32[0] = device[addr >> 2];
            }
            else
            {
                pci_response32[0] = -1;
            }

            dbg_log(dbg_line + " " + h(pci_addr32[0] >>> 0, 8) + "  " + h(pci_response32[0] >>> 0, 8), LOG_PCI);
        }
        else
        {
            pci_response32[0] = -1;
            pci_status32[0] = 0;
        }
    }

    function pci_write_byte(byte_pos, byte)
    {
        var bdf = pci_addr[2] << 8 | pci_addr[1],
            addr = pci_addr[0] & 0xFC;

        var space = device_spaces[bdf],
            device = devices[bdf];

        if(space)
        {
            //(new Uint8Array(space.buffer))[addr | byte_pos] = byte;

            if(byte_pos === 3 && addr >= 0x10 && addr < 0x28)
            {
                var bar_nr = addr - 0x10 >> 2,
                    bars = device.pci_bars,
                    bar = bar_nr < bars.length ? bars[bar_nr] : undefined,
                    value = space[addr >> 2];

                dbg_log("BAR" + bar_nr + " changed to " + h(space[addr >> 2] >>> 0) + " dev=" + h(bdf, 2), LOG_PCI);

                if(bar)
                {
                    dbg_assert(!(bar.size & bar.size - 1));
                    //space[addr >> 2] = value & ~(bar.size - 1) | 3;
                }
                else
                {
                    space[addr >> 2] = 0;
                }
            }
        }
    }

    this.register_device = function(device)
    {
        dbg_assert(device.pci_id !== undefined);
        dbg_assert(device.pci_space !== undefined);
        dbg_assert(device.pci_bars !== undefined);

        var device_id = device.pci_id;

        dbg_log("PCI register bdf=" + h(device_id), LOG_PCI);

        dbg_assert(!devices[device_id]);
        dbg_assert(device.pci_space.length >= 64);

        // convert bytewise notation from lspci to double words
        device_spaces[device_id] = new Int32Array(new Uint8Array(device.pci_space).buffer);
        devices[device_id] = device;
    };

    // Some experimental PCI devices taken from my PC:

    // 00:00.0 Host bridge: Intel Corporation 4 Series Chipset DRAM Controller (rev 02)
    //var host_bridge = {
    //    pci_id: 0,
    //    pci_space: [
    //        0x86, 0x80, 0x20, 0x2e, 0x06, 0x00, 0x90, 0x20, 0x02, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00,
    //        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    //        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x43, 0x10, 0xd3, 0x82,
    //        0x00, 0x00, 0x00, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    //    ],
    //    pci_bars: [],
    //};
    
    var host_bridge = {
        pci_id: 0,
        pci_space: [
            // 00:00.0 Host bridge: Intel Corporation 440FX - 82441FX PMC [Natoma] (rev 02)
            0x86, 0x80, 0x37, 0x12, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ],
        pci_bars: [],
    };
    this.register_device(host_bridge);

    var isa_bridge = {
        pci_id: 1 << 3,
        pci_space: [
            // 00:01.0 ISA bridge: Intel Corporation 82371SB PIIX3 ISA [Natoma/Triton II]
            0x86, 0x80, 0x00, 0x70, 0x07, 0x00, 0x00, 0x02, 0x00, 0x00, 0x01, 0x06, 0x00, 0x00, 0x80, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ],
        pci_bars: [],
    };
    this.register_device(isa_bridge);

    // 00:1e.0 PCI bridge: Intel Corporation 82801 PCI Bridge (rev 90)
    //this.register_device([
    //    0x86, 0x80, 0x4e, 0x24, 0x07, 0x01, 0x10, 0x00, 0x90, 0x01, 0x04, 0x06, 0x00, 0x00, 0x01, 0x00,
    //    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x05, 0x20, 0xe0, 0xe0, 0x80, 0x22,
    //    0xb0, 0xfe, 0xb0, 0xfe, 0xf1, 0xff, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    //    0x00, 0x00, 0x00, 0x00, 0x50, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x02, 0x00,
    //], 0x1e << 3);
}
