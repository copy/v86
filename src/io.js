"use strict";

/**
 * The ISA IO bus
 * Devices register their ports here
 *
 * @constructor
 * @param {CPU} cpu
 */
function IO(cpu)
{
    /** @const */
    this.ports = [];

    /** @const @type {CPU} */
    this.cpu = cpu;

    for(var i = 0; i < 0x10000; i++)
    {
        this.ports[i] = this.create_empty_entry();
    }

    var memory_size = cpu.memory_size[0];

    for(var i = 0; (i << MMAP_BLOCK_BITS) < memory_size; i++)
    {
        // avoid sparse arrays
        cpu.memory_map_read8[i] = cpu.memory_map_write8[i] = undefined;
        cpu.memory_map_read32[i] = cpu.memory_map_write32[i] = undefined;
    }

    this.mmap_register(memory_size, MMAP_MAX - memory_size,
        function(addr) {
            // read outside of the memory size
            dbg_log("Read from unmapped memory space, addr=" + h(addr >>> 0, 8), LOG_IO);
            return 0xFF;
        },
        function(addr, value) {
            // write outside of the memory size
            dbg_log("Write to unmapped memory space, addr=" + h(addr >>> 0, 8) + " value=" + h(value, 2), LOG_IO);
        },
        function(addr) {
            dbg_log("Read from unmapped memory space, addr=" + h(addr >>> 0, 8), LOG_IO);
            return -1;
        },
        function(addr, value) {
            dbg_log("Write to unmapped memory space, addr=" + h(addr >>> 0, 8) + " value=" + h(value >>> 0, 8), LOG_IO);
        }
    );
}

IO.prototype.create_empty_entry = function()
{
    return {
        read8: this.empty_port_read8,
        read16: this.empty_port_read16,
        read32: this.empty_port_read32,

        write8: this.empty_port_write,
        write16: this.empty_port_write,
        write32: this.empty_port_write,

        device: undefined,
    };
};

IO.prototype.empty_port_read8 = function()
{
    return 0xFF;
};

IO.prototype.empty_port_read16 = function()
{
    return 0xFFFF;
};

IO.prototype.empty_port_read32 = function()
{
    return -1;
};

IO.prototype.empty_port_write = function(x)
{
};


/**
 * @param {number} port_addr
 * @param {Object} device
 * @param {function():number=} r8
 * @param {function():number=} r16
 * @param {function():number=} r32
 */
IO.prototype.register_read = function(port_addr, device, r8, r16, r32)
{
    dbg_assert(typeof port_addr === "number");
    dbg_assert(typeof device === "object");
    dbg_assert(!r8 || typeof r8 === "function");
    dbg_assert(!r16 || typeof r16 === "function");
    dbg_assert(!r32 || typeof r32 === "function");
    dbg_assert(r8 || r16 || r32);

    if(DEBUG)
    {
        var fail = function(n) {
            dbg_assert(false, "Overlapped read" + n + " " + h(port_addr, 4) + " (" + device.name + ")");
            return -1 >>> (32 - n) | 0;
        };
        if(!r8) r8 = fail.bind(this, 8);
        if(!r16) r16 = fail.bind(this, 16);
        if(!r32) r32 = fail.bind(this, 32);
    }

    if(r8) this.ports[port_addr].read8 = r8;
    if(r16) this.ports[port_addr].read16 = r16;
    if(r32) this.ports[port_addr].read32 = r32;
    this.ports[port_addr].device = device;
};

/**
 * @param {number} port_addr
 * @param {Object} device
 * @param {function(number)=} w8
 * @param {function(number)=} w16
 * @param {function(number)=} w32
 */
IO.prototype.register_write = function(port_addr, device, w8, w16, w32)
{
    dbg_assert(typeof port_addr === "number");
    dbg_assert(typeof device === "object");
    dbg_assert(!w8 || typeof w8 === "function");
    dbg_assert(!w16 || typeof w16 === "function");
    dbg_assert(!w32 || typeof w32 === "function");
    dbg_assert(w8 || w16 || w32);

    if(DEBUG)
    {
        var fail = function(n) {
            dbg_assert(false, "Overlapped write" + n + " " + h(port_addr) + " (" + device.name + ")");
        };
        if(!w8) w8 = fail.bind(this, 8);
        if(!w16) w16 = fail.bind(this, 16);
        if(!w32) w32 = fail.bind(this, 32);
    }

    if(w8) this.ports[port_addr].write8 = w8;
    if(w16) this.ports[port_addr].write16 = w16;
    if(w32) this.ports[port_addr].write32 = w32;
    this.ports[port_addr].device = device;
};

/**
 * > Any two consecutive 8-bit ports can be treated as a 16-bit port;
 * > and four consecutive 8-bit ports can be treated as a 32-bit port
 * > http://css.csail.mit.edu/6.858/2012/readings/i386/s08_01.htm
 *
 * This info is not correct for all ports, but handled by the following functions
 *
 * Register the write of 2 or 4 consecutive 8-bit ports, 1 or 2 16-bit
 * ports and 0 or 1 32-bit ports
 *
 * @param {number} port_addr
 * @param {!Object} device
 * @param {function():number} r8_1
 * @param {function():number} r8_2
 * @param {function():number=} r8_3
 * @param {function():number=} r8_4
 */
IO.prototype.register_read_consecutive = function(port_addr, device, r8_1, r8_2, r8_3, r8_4)
{
    dbg_assert(arguments.length === 4 || arguments.length === 6);

    function r16_1()
    {
        return r8_1.call(this) |
                r8_2.call(this) << 8;
    }
    function r16_2()
    {
        return r8_3.call(this) |
                r8_4.call(this) << 8;
    }
    function r32()
    {
        return r8_1.call(this) |
                r8_2.call(this) << 8 |
                r8_3.call(this) << 16 |
                r8_4.call(this) << 24;
    }

    if(r8_3 && r8_4)
    {
        this.register_read(port_addr, device, r8_1, r16_1, r32);
        this.register_read(port_addr + 1, device, r8_2);
        this.register_read(port_addr + 2, device, r8_3, r16_2);
        this.register_read(port_addr + 3, device, r8_4);
    }
    else
    {
        this.register_read(port_addr, device, r8_1, r16_1);
        this.register_read(port_addr + 1, device, r8_2);
    }
};

/**
 * @param {number} port_addr
 * @param {!Object} device
 * @param {function(number)} w8_1
 * @param {function(number)} w8_2
 * @param {function(number)=} w8_3
 * @param {function(number)=} w8_4
 */
IO.prototype.register_write_consecutive = function(port_addr, device, w8_1, w8_2, w8_3, w8_4)
{
    dbg_assert(arguments.length === 4 || arguments.length === 6);

    function w16_1(data)
    {
        w8_1.call(this, data & 0xFF);
        w8_2.call(this, data >> 8 & 0xFF);
    }
    function w16_2(data)
    {
        w8_3.call(this, data & 0xFF);
        w8_4.call(this, data >> 8 & 0xFF);
    }
    function w32(data)
    {
        w8_1.call(this, data & 0xFF);
        w8_2.call(this, data >> 8 & 0xFF);
        w8_3.call(this, data >> 16 & 0xFF);
        w8_4.call(this, data >>> 24);
    }

    if(w8_3 && w8_4)
    {
        this.register_write(port_addr,     device, w8_1, w16_1, w32);
        this.register_write(port_addr + 1, device, w8_2);
        this.register_write(port_addr + 2, device, w8_3, w16_2);
        this.register_write(port_addr + 3, device, w8_4);
    }
    else
    {
        this.register_write(port_addr,     device, w8_1, w16_1);
        this.register_write(port_addr + 1, device, w8_2);
    }
};

IO.prototype.mmap_read32_shim = function(addr)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;
    var fn = this.cpu.memory_map_read8[aligned_addr];

    return fn(addr) | fn(addr + 1) << 8 |
            fn(addr + 2) << 16 | fn(addr + 3) << 24;
};

IO.prototype.mmap_write32_shim = function(addr, value)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;
    var fn = this.cpu.memory_map_write8[aligned_addr];

    fn(addr, value & 0xFF);
    fn(addr + 1, value >> 8 & 0xFF);
    fn(addr + 2, value >> 16 & 0xFF);
    fn(addr + 3, value >>> 24);
};

/**
 * @param {number} addr
 * @param {number} size
 * @param {*} read_func8
 * @param {*} write_func8
 * @param {*=} read_func32
 * @param {*=} write_func32
 */
IO.prototype.mmap_register = function(addr, size, read_func8, write_func8, read_func32, write_func32)
{
    dbg_log("mmap_register addr=" + h(addr >>> 0, 8) + " size=" + h(size, 8), LOG_IO);

    dbg_assert((addr & MMAP_BLOCK_SIZE - 1) === 0);
    dbg_assert(size && (size & MMAP_BLOCK_SIZE - 1) === 0);

    if(!read_func32)
        read_func32 = this.mmap_read32_shim.bind(this);

    if(!write_func32)
        write_func32 = this.mmap_write32_shim.bind(this);

    var aligned_addr = addr >>> MMAP_BLOCK_BITS;

    for(; size > 0; aligned_addr++)
    {
        this.cpu.memory_map_read8[aligned_addr] = read_func8;
        this.cpu.memory_map_write8[aligned_addr] = write_func8;
        this.cpu.memory_map_read32[aligned_addr] = read_func32;
        this.cpu.memory_map_write32[aligned_addr] = write_func32;

        size -= MMAP_BLOCK_SIZE;
    }
};


IO.prototype.port_write8 = function(port_addr, data)
{
    var entry = this.ports[port_addr];

    if(entry.write8 === this.empty_port_write || LOG_ALL_IO)
    {
        dbg_log(
            "write8 port #" + h(port_addr, 4) + " <- " + h(data, 2) + this.get_port_description(port_addr),
            LOG_IO
        );
    }
    return entry.write8.call(entry.device, data);
};

IO.prototype.port_write16 = function(port_addr, data)
{
    var entry = this.ports[port_addr];

    if(entry.write16 === this.empty_port_write || LOG_ALL_IO)
    {
        dbg_log(
            "write16 port #" + h(port_addr, 4) + " <- " + h(data, 4) + this.get_port_description(port_addr),
            LOG_IO
        );
    }
    return entry.write16.call(entry.device, data);
};

IO.prototype.port_write32 = function(port_addr, data)
{
    var entry = this.ports[port_addr];

    if(entry.write32 === this.empty_port_write || LOG_ALL_IO)
    {
        dbg_log(
            "write32 port #" + h(port_addr, 4) + " <- " + h(data >>> 0, 8) + this.get_port_description(port_addr),
            LOG_IO
        );
    }
    return entry.write32.call(entry.device, data);
};

IO.prototype.port_read8 = function(port_addr)
{
    var entry = this.ports[port_addr];

    if(entry.read8 === this.empty_port_read8 || LOG_ALL_IO)
    {
        dbg_log(
            "read8 port  #" + h(port_addr, 4) + this.get_port_description(port_addr),
            LOG_IO
        );
    }
    var value = entry.read8.call(entry.device);
    dbg_assert(typeof value === "number");
    dbg_assert(value < 0x100 && value >= 0, "8 bit port returned large value: " + h(port_addr));
    return value;
};

IO.prototype.port_read16 = function(port_addr)
{
    var entry = this.ports[port_addr];

    if(entry.read16 === this.empty_port_read16 || LOG_ALL_IO)
    {
        dbg_log(
            "read16 port  #" + h(port_addr, 4) + this.get_port_description(port_addr),
            LOG_IO
        );
    }
    var value = entry.read16.call(entry.device);
    dbg_assert(typeof value === "number");
    dbg_assert(value < 0x10000 && value >= 0, "16 bit port returned large value: " + h(port_addr));
    return value;
};

IO.prototype.port_read32 = function(port_addr)
{
    var entry = this.ports[port_addr];

    if(entry.read32 === this.empty_port_read32 || LOG_ALL_IO)
    {
        dbg_log(
            "read32 port  #" + h(port_addr, 4) + this.get_port_description(port_addr),
            LOG_IO
        );
    }
    var value = entry.read32.call(entry.device);
    dbg_assert((value | 0) === value);
    return value;
};

// via seabios ioport.h
var debug_port_list = {
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

IO.prototype.get_port_description = function(addr)
{
    if(debug_port_list[addr])
    {
        return "  (" + debug_port_list[addr] + ")";
    }
    else
    {
        return "";
    }
};
