"use strict";

/**
 * The ISA IO bus
 * Devices register their ports here
 *
 * @constructor
 */
function IO(memory)
{
    var memory_size = memory.size;

    function get_port_description(addr)
    {
        // via seabios ioport.h
        var ports = {
            0x0004: "PORT_DMA_ADDR_2",
            0x0005: "PORT_DMA_CNT_2",
            0x000a: "PORT_DMA1_MASK_REG",
            0x000b: "PORT_DMA1_MODE_REG",
            0x000c: "PORT_DMA1_CLEAR_FF_REG",
            0x000d: "PORT_DMA1_MASTER_CLEAR",
            0x0020: "PORT_PIC1_CMD",
            0x0021: "PORT_PIC1_DATA",
            0x0040: "PORT_PIT_COUNTER0",
            0x0041: "PORT_PIT_COUNTER1",
            0x0042: "PORT_PIT_COUNTER2",
            0x0043: "PORT_PIT_MODE",
            0x0060: "PORT_PS2_DATA",
            0x0061: "PORT_PS2_CTRLB",
            0x0064: "PORT_PS2_STATUS",
            0x0070: "PORT_CMOS_INDEX",
            0x0071: "PORT_CMOS_DATA",
            0x0080: "PORT_DIAG",
            0x0081: "PORT_DMA_PAGE_2",
            0x0092: "PORT_A20",
            0x00a0: "PORT_PIC2_CMD",
            0x00a1: "PORT_PIC2_DATA",
            0x00b2: "PORT_SMI_CMD",
            0x00b3: "PORT_SMI_STATUS",
            0x00d4: "PORT_DMA2_MASK_REG",
            0x00d6: "PORT_DMA2_MODE_REG",
            0x00da: "PORT_DMA2_MASTER_CLEAR",
            0x00f0: "PORT_MATH_CLEAR",
            0x0170: "PORT_ATA2_CMD_BASE",
            0x01f0: "PORT_ATA1_CMD_BASE",
            0x0278: "PORT_LPT2",
            0x02e8: "PORT_SERIAL4",
            0x02f8: "PORT_SERIAL2",
            0x0374: "PORT_ATA2_CTRL_BASE",
            0x0378: "PORT_LPT1",
            0x03e8: "PORT_SERIAL3",
            //0x03f4: "PORT_ATA1_CTRL_BASE",
            0x03f0: "PORT_FD_BASE",
            0x03f2: "PORT_FD_DOR",
            0x03f4: "PORT_FD_STATUS",
            0x03f5: "PORT_FD_DATA",
            0x03f6: "PORT_HD_DATA",
            0x03f7: "PORT_FD_DIR",
            0x03f8: "PORT_SERIAL1",
            0x0cf8: "PORT_PCI_CMD",
            0x0cf9: "PORT_PCI_REBOOT",
            0x0cfc: "PORT_PCI_DATA",
            0x0402: "PORT_BIOS_DEBUG",
            0x0510: "PORT_QEMU_CFG_CTL",
            0x0511: "PORT_QEMU_CFG_DATA",
            0xb000: "PORT_ACPI_PM_BASE",
            0xb100: "PORT_SMB_BASE",
            0x8900: "PORT_BIOS_APM"
        };

        if(ports[addr])
        {
            return "  (" + ports[addr] + ")";
        }
        else
        {
            return "";
        }
    }

    function empty_port_read_debug(port_addr)
    {
        dbg_log(
            "read port  #" + h(port_addr, 3) + get_port_description(port_addr),
            LOG_IO
        );

        return 0xFF;
    }

    function empty_port_write_debug(out_byte, port_addr)
    {
        dbg_log(
            "write port #" + h(port_addr, 3) + " <- " + h(out_byte, 2) + get_port_description(port_addr),
            LOG_IO
        );
    }

    function empty_port_read()
    {
        return 0xFF;
    }

    function empty_port_write(x)
    {
    }

    // Why 0x10003 if there are only 0x10000 ports:
    //   Reading/Writing from port 0xFFFF could make the number
    //   go outside of the valid range and cause an exception otherwise
    /** @const */
    var NUM_PORTS = 0x10003;

    var read_callbacks = Array(NUM_PORTS),
        write_callbacks = Array(NUM_PORTS);

    for(var i = 0; i < NUM_PORTS; i++)
    {
        // avoid sparse arrays

        if(DEBUG)
        {
            read_callbacks[i] = empty_port_read_debug;
            write_callbacks[i] = empty_port_write_debug;
        }
        else
        {
            read_callbacks[i] = empty_port_read;
            write_callbacks[i] = empty_port_write;
        }
    }

    /**
     * @param {number} port_addr
     * @param {function():number} callback
     * @param {Object=} device
     */
    this.register_read = function(port_addr, callback, device)
    {
        if(device !== undefined)
        {
            callback = callback.bind(device);
        }

        read_callbacks[port_addr] = callback.bind(device);
    };

    /**
     * @param {number} port_addr
     * @param {function(number)} callback
     * @param {Object=} device
     */
    this.register_write = function(port_addr, callback, device)
    {
        if(device !== undefined)
        {
            callback = callback.bind(device);
        }

        write_callbacks[port_addr] = callback;
    };

    // remember registrations in the RAM area, used by in_mmap_range
    var low_memory_registered = new Uint8Array(memory_size >> MMAP_BLOCK_BITS);

    /**
     * @param addr {number}
     * @param size {number}
     *
     */
    this.mmap_register = function(addr, size, fn_size, read_func, write_func)
    {
        dbg_log("mmap_register addr=" + h(addr >>> 0, 8) + " size=" + h(size, 8) + " fn_size=" + fn_size, LOG_IO);

        dbg_assert((addr & MMAP_BLOCK_SIZE - 1) === 0);
        dbg_assert(size && (size & MMAP_BLOCK_SIZE - 1) === 0);
        dbg_assert(fn_size === 1 || fn_size === 4);

        var aligned_addr = addr >>> MMAP_BLOCK_BITS;

        for(; size > 0; aligned_addr++)
        {
            memory.memory_map_registered[aligned_addr] = fn_size;

            memory.memory_map_read[aligned_addr] = do_read;
            memory.memory_map_write[aligned_addr] = do_write;

            if((aligned_addr << MMAP_BLOCK_BITS >>> 0) < memory_size)
            {
                low_memory_registered[aligned_addr] = fn_size;
            }

            size -= MMAP_BLOCK_SIZE;
        }

        function do_read(read_addr)
        {
            return read_func(read_addr - addr | 0);
        }

        function do_write(write_addr, value)
        {
            write_func(write_addr - addr | 0, value);
        }
    };

    for(var i = 0; (i << MMAP_BLOCK_BITS) < memory_size; i++)
    {
        // avoid sparse arrays
        memory.memory_map_read[i] = memory.memory_map_write[i] = undefined;
    }

    this.mmap_register(memory_size, 0x100000000 - memory_size, 1,
        function(addr) {
            // read outside of the memory size
            addr += memory_size;
            dbg_log("Read from unmapped memory space, addr=" + h(addr >>> 0, 8), LOG_IO);
            return 0xFF;
        },
        function(addr, value) {
            // write outside of the memory size
            addr += memory_size;
            dbg_log("Write to unmapped memory space, addr=" + h(addr >>> 0, 8) + " value=" + h(value, 2), LOG_IO);
        });

    
    this.in_mmap_range = function(start, count)
    {
        var end = start + count;

        if(end >= memory_size)
        {
            return true;
        }

        start &= ~(MMAP_BLOCK_SIZE - 1);

        while(start < end)
        {
            if(low_memory_registered[start >> MMAP_BLOCK_BITS])
            {
                return true;
            }

            start += MMAP_BLOCK_SIZE;
        }

        return false;
    };

    // any two consecutive 8-bit ports can be treated as a 16-bit port;
    // and four consecutive 8-bit ports can be treated as a 32-bit port
    //
    // http://css.csail.mit.edu/6.858/2012/readings/i386/s08_01.htm
    //
    // This info seems to be incorrect, at least some multibyte ports are next
    // to each other, such as 1CE and 1CF (VBE dispi) or the 170 (ATA data port).
    //
    // As a workaround, we pass the original port to the callback as the last argument.


    this.port_write8 = function(port_addr, out_byte)
    {
        write_callbacks[port_addr](out_byte, port_addr);
    };

    this.port_write16 = function(port_addr, out_byte)
    {
        write_callbacks[port_addr](out_byte & 0xFF, port_addr);
        write_callbacks[port_addr + 1](out_byte >> 8, port_addr);
    };

    this.port_write32 = function(port_addr, out_byte)
    {
        write_callbacks[port_addr](out_byte & 0xFF, port_addr);
        write_callbacks[port_addr + 1](out_byte >> 8 & 0xFF, port_addr);
        write_callbacks[port_addr + 2](out_byte >> 16 & 0xFF, port_addr);
        write_callbacks[port_addr + 3](out_byte >>> 24, port_addr);
    };

    // read byte from port
    this.port_read8 = function(port_addr)
    {
        return read_callbacks[port_addr](port_addr);
    };

    this.port_read16 = function(port_addr)
    {
        return read_callbacks[port_addr](port_addr) | 
                    read_callbacks[port_addr + 1](port_addr) << 8;
    };

    this.port_read32 = function(port_addr)
    {
        return read_callbacks[port_addr](port_addr) | 
                    read_callbacks[port_addr + 1](port_addr) << 8 | 
                    read_callbacks[port_addr + 2](port_addr) << 16 | 
                    read_callbacks[port_addr + 3](port_addr) << 24;
    };
}

