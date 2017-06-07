"use strict";


var
    /**
     * Always 64k
     * @const
     */
    VGA_BANK_SIZE = 64 * 1024,

    /** @const */
    MAX_XRES = 2560,

    /** @const */
    MAX_YRES = 1600,

    /** @const */
    MAX_BPP = 32;

/** @const */
//var VGA_LFB_ADDRESS = 0xFE000000; // set by seabios
var VGA_LFB_ADDRESS = 0xE0000000;

/** @const */
var VGA_PLANAR_REAL_BUFFER_START = 4 * VGA_BANK_SIZE;


/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 * @param {number} vga_memory_size
 */
function VGAScreen(cpu, bus, vga_memory_size)
{
    /** @const @type {BusConnector} */
    this.bus = bus;

    this.vga_memory_size = vga_memory_size;

    /** @type {number} */
    this.cursor_address = 0;

    /** @type {number} */
    this.cursor_scanline_start = 0xE;

    /** @type {number} */
    this.cursor_scanline_end = 0xF;

    /**
     * Number of columns in text mode
     * @type {number}
     */
    this.max_cols = 80;

    /**
     * Number of rows in text mode
     * @type {number}
     */
    this.max_rows = 25;

    /**
     * Width in pixels in graphical mode
     * @type {number}
     */
    this.screen_width = 0;

    /**
     * Height in pixels in graphical mode
     * @type {number}
     */
    this.screen_height = 0;

    /**
     * video memory start address
     * @type {number}
     */
    this.start_address = 0;

    this.crtc = new Uint8Array(0x19);

    /**
     * @type {number}
     */
    this.previous_start_address = 0;

    /** @type {boolean} */
    this.graphical_mode_is_linear = true;

    /** @type {boolean} */
    this.graphical_mode = false;

    /*
     * VGA palette containing 256 colors for video mode 13 etc.
     * Needs to be initialised by the BIOS
     */
    this.vga256_palette = new Int32Array(256);

    // VGA latches
    this.latch0 = 0;
    this.latch1 = 0;
    this.latch2 = 0;
    this.latch3 = 0;


    /** @type {number} */
    this.svga_width = 0;

    /** @type {number} */
    this.svga_height = 0;

    /** @type {number} */
    this.text_mode_width = 80;

    this.svga_enabled = false;

    /** @type {number} */
    this.svga_bpp = 32;

    /** @type {number} */
    this.svga_bank_offset = 0;

    /**
     * The video buffer offset created by VBE_DISPI_INDEX_Y_OFFSET
     * In bytes
     * @type {number}
     */
    this.svga_offset = 0;

    // Experimental, could probably need some changes
    // 01:00.0 VGA compatible controller: NVIDIA Corporation GT216 [GeForce GT 220] (rev a2)
    this.pci_space = [
        0xde, 0x10, 0x20, 0x0a, 0x07, 0x00, 0x00, 0x00,  0xa2, 0x00, 0x00, 0x03, 0x00, 0x00, 0x80, 0x00,
        0x08, VGA_LFB_ADDRESS >>> 8, VGA_LFB_ADDRESS >>> 16, VGA_LFB_ADDRESS >>> 24,
                                0x00, 0x00, 0x00, 0x00,  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  0x00, 0x00, 0x00, 0x00, 0x0a, 0x01, 0x00, 0x00,
    ];
    this.pci_id = 0x12 << 3;
    this.pci_bars = [
        {
            size: vga_memory_size,
        },
    ];

    // TODO: Should be matched with vga bios size and mapping address
    // Seabios config for this device:
    // CONFIG_VGA_PCI=y
    // CONFIG_OVERRIDE_PCI_ID=y
    // CONFIG_VGA_VID=0x10de
    // CONFIG_VGA_DID=0x0a20

    this.pci_rom_size = 0x10000;
    this.pci_rom_address = 0xFEB00000;

    this.name = "vga";

    this.stats = {
        is_graphical: false,
        res_x: 0,
        res_y: 0,
        bpp: 0,
    };

    this.index_crtc = 0;

    this.offset_register = 0;

    // index for setting colors through port 3C9h
    this.dac_color_index_write = 0;
    this.dac_color_index_read = 0;

    this.attribute_controller_index = -1;

    this.dac_map = new Uint8Array(0x10);

    this.sequencer_index = -1;

    // bitmap of planes 0-3
    this.plane_write_bm = 0xF;
    this.sequencer_memory_mode = 0;
    this.graphics_index = -1;

    this.plane_read = 0, // value 0-3, which plane to read
    this.planar_mode = 0;
    this.planar_rotate_reg = 0;
    this.planar_bitmap = 0xFF;

    this.max_scan_line = 0;

    this.miscellaneous_output_register = 0xff;
    this.port_3DA_value = 0xFF;


    var io = cpu.io;

    io.register_write(0x3C0, this, this.port3C0_write);
    io.register_read(0x3C0, this, this.port3C0_read, this.port3C0_read16);

    io.register_read(0x3C1, this, this.port3C1_read);
    io.register_write(0x3C2, this, this.port3C2_write);

    io.register_write_consecutive(0x3C4, this, this.port3C4_write, this.port3C5_write);

    io.register_read(0x3C4, this, this.port3C4_read);
    io.register_read(0x3C5, this, this.port3C5_read);

    io.register_write_consecutive(0x3CE, this, this.port3CE_write, this.port3CF_write);

    io.register_read(0x3CE, this, this.port3CE_read);
    io.register_read(0x3CF, this, this.port3CF_read);

    io.register_write(0x3C7, this, this.port3C7_write);
    io.register_write(0x3C8, this, this.port3C8_write);
    io.register_write(0x3C9, this, this.port3C9_write);
    io.register_read(0x3C9, this, this.port3C9_read);

    io.register_read(0x3CC, this, this.port3CC_read);

    io.register_write_consecutive(0x3D4, this, this.port3D4_write, this.port3D5_write);
    io.register_read(0x3D5, this, this.port3D5_read);

    io.register_read(0x3D4, this, function() { dbg_log("3D4 read", LOG_VGA); return 0; });
    io.register_read(0x3CA, this, function() { dbg_log("3CA read", LOG_VGA); return 0; });

    io.register_read(0x3DA, this, this.port3DA_read);


    // Bochs VBE Extensions
    // http://wiki.osdev.org/Bochs_VBE_Extensions
    this.dispi_index = -1;
    this.dispi_enable_value = 0;

    io.register_write(0x1CE, this, undefined, this.port1CE_write);

    io.register_write(0x1CF, this, undefined, this.port1CF_write);
    io.register_read(0x1CF, this, undefined, this.port1CF_read);

    if(this.vga_memory_size === undefined || this.vga_memory_size < 4 * VGA_BANK_SIZE)
    {
        this.vga_memory_size = 4 * VGA_BANK_SIZE;
        dbg_log("vga memory size rounded up to " + this.vga_memory_size, LOG_VGA);
    }
    else if(this.vga_memory_size & (VGA_BANK_SIZE - 1))
    {
        // round up to next 64k
        this.vga_memory_size |= VGA_BANK_SIZE - 1;
        this.vga_memory_size++;
    }

    this.svga_memory = new Uint8Array(this.vga_memory_size);

    this.diff_addr_min = this.vga_memory_size;
    this.diff_addr_max = 0;

    this.dest_buffer = undefined;

    bus.register("screen-tell-buffer", function(data)
    {
        this.dest_buffer = data[0];
    }, this);

    bus.register("screen-fill-buffer", function()
    {
        this.screen_fill_buffer();
    }, this);


    this.svga_memory16 = new Uint16Array(this.svga_memory.buffer);
    this.svga_memory32 = new Int32Array(this.svga_memory.buffer);
    this.vga_memory = new Uint8Array(this.svga_memory.buffer, 0, 4 * VGA_BANK_SIZE);
    this.plane0 = new Uint8Array(this.svga_memory.buffer, 0 * VGA_BANK_SIZE, VGA_BANK_SIZE);
    this.plane1 = new Uint8Array(this.svga_memory.buffer, 1 * VGA_BANK_SIZE, VGA_BANK_SIZE);
    this.plane2 = new Uint8Array(this.svga_memory.buffer, 2 * VGA_BANK_SIZE, VGA_BANK_SIZE);
    this.plane3 = new Uint8Array(this.svga_memory.buffer, 3 * VGA_BANK_SIZE, VGA_BANK_SIZE);

    var me = this;
    io.mmap_register(0xA0000, 0x20000,
        function(addr) { return me.vga_memory_read(addr); },
        function(addr, value) { me.vga_memory_write(addr, value); }
    );
    io.mmap_register(VGA_LFB_ADDRESS, this.vga_memory_size,
        function(addr) { return me.svga_memory_read8(addr); },
        function(addr, value) { me.svga_memory_write8(addr, value); },
        function(addr) { return me.svga_memory_read32(addr); },
        function(addr, value) { me.svga_memory_write32(addr, value); }
    );

    cpu.devices.pci.register_device(this);
}

VGAScreen.prototype.get_state = function()
{
    var state = [];

    state[0] = this.vga_memory_size;
    state[1] = this.cursor_address;
    state[2] = this.cursor_scanline_start;
    state[3] = this.cursor_scanline_end;
    state[4] = this.max_cols;
    state[5] = this.max_rows;
    state[6] = this.screen_width;
    state[7] = this.screen_height;
    state[8] = this.start_address;
    state[9] = this.graphical_mode;
    state[10] = this.vga256_palette;
    state[11] = this.latch0;
    state[12] = this.latch1;
    state[13] = this.latch2;
    state[14] = this.latch3;
    state[15] = this.svga_width;
    state[16] = this.svga_height;
    state[17] = this.text_mode_width;
    state[18] = this.svga_enabled;
    state[19] = this.svga_bpp;
    state[20] = this.svga_bank_offset;
    state[21] = this.svga_offset;
    state[22] = this.index_crtc;
    state[23] = this.dac_color_index_write;
    state[24] = this.dac_color_index_read;
    state[25] = this.dac_map;
    state[26] = this.sequencer_index;
    state[27] = this.plane_write_bm;
    state[28] = this.sequencer_memory_mode;
    state[29] = this.graphics_index;
    state[30] = this.plane_read;
    state[31] = this.planar_mode;
    state[32] = this.planar_rotate_reg;
    state[33] = this.planar_bitmap;
    state[34] = this.max_scan_line;
    state[35] = this.miscellaneous_output_register;
    state[36] = this.port_3DA_value;
    state[37] = this.dispi_index;
    state[38] = this.dispi_enable_value;
    state[39] = this.svga_memory;
    state[40] = this.graphical_mode_is_linear;
    state[41] = this.attribute_controller_index;
    state[42] = this.offset_register;

    return state;
};

VGAScreen.prototype.set_state = function(state)
{
    this.vga_memory_size = state[0];
    this.cursor_address = state[1];
    this.cursor_scanline_start = state[2];
    this.cursor_scanline_end = state[3];
    this.max_cols = state[4];
    this.max_rows = state[5];
    this.screen_width = state[6];
    this.screen_height = state[7];
    this.start_address = state[8];
    this.graphical_mode = state[9];
    this.vga256_palette = state[10];
    this.latch0 = state[11];
    this.latch1 = state[12];
    this.latch2 = state[13];
    this.latch3 = state[14];
    this.svga_width = state[15];
    this.svga_height = state[16];
    this.text_mode_width = state[17];
    this.svga_enabled = state[18];
    this.svga_bpp = state[19];
    this.svga_bank_offset = state[20];
    this.svga_offset = state[21];
    this.index_crtc = state[22];
    this.dac_color_index_write = state[23];
    this.dac_color_index_read = state[24];
    this.dac_map = state[25];
    this.sequencer_index = state[26];
    this.plane_write_bm = state[27];
    this.sequencer_memory_mode = state[28];
    this.graphics_index = state[29];
    this.plane_read = state[30];
    this.planar_mode = state[31];
    this.planar_rotate_reg = state[32];
    this.planar_bitmap = state[33];
    this.max_scan_line = state[34];
    this.miscellaneous_output_register = state[35];
    this.port_3DA_value = state[36];
    this.dispi_index = state[37];
    this.dispi_enable_value = state[38];
    this.svga_memory.set(state[39]);
    this.graphical_mode_is_linear = state[40];
    this.attribute_controller_index = state[41];
    this.offset_register = state[42];

    this.bus.send("screen-set-mode", this.graphical_mode);

    if(this.graphical_mode)
    {
        // TODO: Consider non-svga modes
        this.set_size_graphical(this.svga_width, this.svga_height, this.svga_bpp);
    }
    else
    {
        this.set_size_text(this.max_cols, this.max_rows);
        this.update_cursor_scanline();
        this.update_cursor();
    }

    this.complete_redraw();
};

VGAScreen.prototype.vga_memory_read = function(addr)
{
    addr -= 0xA0000;

    if(!this.graphical_mode || this.graphical_mode_is_linear)
    {
        addr |= this.svga_bank_offset;

        return this.svga_memory[addr];
    }

    // TODO: "Color don't care"
    //dbg_assert((this.planar_mode & 0x08)  === 0, "unimplemented");

    // planar mode
    addr &= 0xFFFF;

    this.latch0 = this.plane0[addr];
    this.latch1 = this.plane1[addr];
    this.latch2 = this.plane2[addr];
    this.latch3 = this.plane3[addr];

    return this.vga_memory[this.plane_read << 16 | addr];
};

VGAScreen.prototype.vga_memory_write = function(addr, value)
{
    addr -= 0xA0000;

    if(this.graphical_mode)
    {
        if(this.graphical_mode_is_linear)
        {
            this.vga_memory_write_graphical_linear(addr, value);
        }
        else
        {
            this.vga_memory_write_graphical_planar(addr, value);
        }
    }
    else
    {
        this.vga_memory_write_text_mode(addr, value);
    }
};

VGAScreen.prototype.vga_memory_write_graphical_linear = function(addr, value)
{
    addr |= this.svga_bank_offset;

    this.diff_addr_min = addr < this.diff_addr_min ? addr : this.diff_addr_min;
    this.diff_addr_max = addr > this.diff_addr_max ? addr : this.diff_addr_max;

    this.svga_memory[addr] = value;
};

VGAScreen.prototype.vga_memory_write_graphical_planar = function(addr, value)
{
    if(addr > 0xFFFF)
    {
        return;
    }

    // TODO:
    // Replace 4 byte operations with single double word operations

    var write,
        plane0_byte,
        plane1_byte,
        plane2_byte,
        plane3_byte;

    var write_mode = this.planar_mode & 3;

    // not implemented:
    // - Planar mode 3
    // - Rotation
    // - Shift mode
    // - Host Odd/Even
    dbg_assert((this.planar_rotate_reg & 7) === 0, "unimplemented");
    dbg_assert(write_mode !== 3, "unimplemented");
    dbg_assert((this.planar_mode & 0x70)  === 0, "unimplemented");

    if(write_mode === 0)
    {
        plane0_byte = plane1_byte = plane2_byte = plane3_byte = value;
    }
    else if(write_mode === 2)
    {
        if(this.plane_write_bm & 1)
        {
            write = value & 1 ? 0xFF : 0;
            plane0_byte = this.latch0 & ~this.planar_bitmap | write & this.planar_bitmap;
        }
        if(this.plane_write_bm & 2)
        {
            write = value & 2 ? 0xFF : 0;
            plane1_byte = this.latch1 & ~this.planar_bitmap | write & this.planar_bitmap;
        }
        if(this.plane_write_bm & 4)
        {
            write = value & 4 ? 0xFF : 0;
            plane2_byte = this.latch2 & ~this.planar_bitmap | write & this.planar_bitmap;
        }
        if(this.plane_write_bm & 8)
        {
            write = value & 8 ? 0xFF : 0;
            plane3_byte = this.latch3 & ~this.planar_bitmap | write & this.planar_bitmap;
        }
    }

    if(write_mode === 0 || write_mode === 2)
    {
        switch(this.planar_rotate_reg & 0x18)
        {
            case 0x08:
                plane0_byte &= this.latch0;
                plane1_byte &= this.latch1;
                plane2_byte &= this.latch2;
                plane3_byte &= this.latch3;
                break;
            case 0x10:
                plane0_byte |= this.latch0;
                plane1_byte |= this.latch1;
                plane2_byte |= this.latch2;
                plane3_byte |= this.latch3;
                break;
            case 0x18:
                plane0_byte ^= this.latch0;
                plane1_byte ^= this.latch1;
                plane2_byte ^= this.latch2;
                plane3_byte ^= this.latch3;
                break;
        }

        if(this.plane_write_bm & 1)
        {
            plane0_byte = this.latch0 & ~this.planar_bitmap | plane0_byte & this.planar_bitmap;
        }
        if(this.plane_write_bm & 2)
        {
            plane1_byte = this.latch1 & ~this.planar_bitmap | plane1_byte & this.planar_bitmap;
        }
        if(this.plane_write_bm & 4)
        {
            plane2_byte = this.latch2 & ~this.planar_bitmap | plane2_byte & this.planar_bitmap;
        }
        if(this.plane_write_bm & 8)
        {
            plane3_byte = this.latch3 & ~this.planar_bitmap | plane3_byte & this.planar_bitmap;
        }
    }
    else if(write_mode === 1)
    {
        plane0_byte = this.latch0;
        plane1_byte = this.latch1;
        plane2_byte = this.latch2;
        plane3_byte = this.latch3;
    }

    if(this.plane_write_bm & 1)
    {
        this.plane0[addr] = plane0_byte;
    }
    else
    {
        plane0_byte = this.plane0[addr];
    }
    if(this.plane_write_bm & 2)
    {
        this.plane1[addr] = plane1_byte;
    }
    else
    {
        plane1_byte = this.plane1[addr];
    }
    if(this.plane_write_bm & 4)
    {
        this.plane2[addr] = plane2_byte;
    }
    else
    {
        plane2_byte = this.plane2[addr];
    }
    if(this.plane_write_bm & 8)
    {
        this.plane3[addr] = plane3_byte;
    }
    else
    {
        plane3_byte = this.plane3[addr];
    }

    if(addr >= (this.screen_width * this.screen_height << 3))
    {
        return;
    }

    // Shift these, so that the bits for the color are in
    // the correct position in the for loop
    plane1_byte <<= 1;
    plane2_byte <<= 2;
    plane3_byte <<= 3;

    // 8 pixels per byte, we start at high (addr << 3 | 7)
    var offset = (addr << 3 | 7);

    var actual_buffer_addr = offset + VGA_PLANAR_REAL_BUFFER_START;
    this.diff_addr_min = actual_buffer_addr - 7 < this.diff_addr_min ? actual_buffer_addr - 7 : this.diff_addr_min;
    this.diff_addr_max = actual_buffer_addr > this.diff_addr_max ? actual_buffer_addr : this.diff_addr_max;

    for(var i = 0; i < 8; i++)
    {
        var color_index =
                plane0_byte >> i & 1 |
                plane1_byte >> i & 2 |
                plane2_byte >> i & 4 |
                plane3_byte >> i & 8,
            color = this.dac_map[color_index];

        this.svga_memory[offset + VGA_PLANAR_REAL_BUFFER_START] = color;

        offset--;
    }
};

VGAScreen.prototype.text_mode_redraw = function()
{
    var addr = 0x18000 | this.start_address << 1,
        chr,
        color;

    for(var row = 0; row < this.max_rows; row++)
    {
        for(var col = 0; col < this.max_cols; col++)
        {
            chr = this.vga_memory[addr];
            color = this.vga_memory[addr | 1];

            this.bus.send("screen-put-char", [row, col, chr,
                this.vga256_palette[color >> 4 & 0xF], this.vga256_palette[color & 0xF]]);

            addr += 2;
        }
    }
};

VGAScreen.prototype.vga_memory_write_text_mode = function(addr, value)
{
    if(addr < 0x18000)
    {
        return;
    }

    var memory_start = (addr - 0x18000 >> 1) - this.start_address,
        row = memory_start / this.max_cols | 0,
        col = memory_start % this.max_cols,
        chr,
        color;

    // XXX: Should handle 16 bit write if possible
    if(addr & 1)
    {
        color = value;
        chr = this.vga_memory[addr & ~1];
    }
    else
    {
        chr = value;
        color = this.vga_memory[addr | 1];
    }

    this.bus.send("screen-put-char", [row, col, chr,
            this.vga256_palette[color >> 4 & 0xF], this.vga256_palette[color & 0xF]]);

    this.vga_memory[addr] = value;
};

VGAScreen.prototype.update_cursor = function()
{
    var row = (this.cursor_address - this.start_address) / this.max_cols | 0,
        col = (this.cursor_address - this.start_address) % this.max_cols;

    row = Math.min(this.max_rows - 1, row);

    this.bus.send("screen-update-cursor", [row, col]);
};

VGAScreen.prototype.svga_memory_read8 = function(addr)
{
    return this.svga_memory[addr & 0xFFFFFFF];
};

VGAScreen.prototype.svga_memory_read32 = function(addr)
{
    addr &= 0xFFFFFFF;

    if(addr & 3)
    {
        return this.svga_memory[addr] | this.svga_memory[addr + 1] << 8 |
               this.svga_memory[addr + 2] << 16 | this.svga_memory[addr + 3] << 24;
    }
    else
    {
        return this.svga_memory32[addr >> 2];
    }
};

VGAScreen.prototype.svga_memory_write8 = function(addr, value)
{
    addr &= 0xFFFFFFF;
    this.svga_memory[addr] = value;

    this.diff_addr_min = addr < this.diff_addr_min ? addr : this.diff_addr_min;
    this.diff_addr_max = addr > this.diff_addr_max ? addr : this.diff_addr_max;
};

VGAScreen.prototype.svga_memory_write32 = function(addr, value)
{
    addr &= 0xFFFFFFF;

    this.diff_addr_min = addr < this.diff_addr_min ? addr : this.diff_addr_min;
    this.diff_addr_max = addr + 3 > this.diff_addr_max ? addr + 3 : this.diff_addr_max;

    this.svga_memory[addr] = value;
    this.svga_memory[addr + 1] = value >> 8;
    this.svga_memory[addr + 2] = value >> 16;
    this.svga_memory[addr + 3] = value >> 24;
};

VGAScreen.prototype.complete_redraw = function()
{
    dbg_log("complete redraw", LOG_VGA);

    if(this.graphical_mode)
    {
        this.diff_addr_min = 0;
        this.diff_addr_max = this.vga_memory_size;
    }
    else
    {
        this.text_mode_redraw();
    }
};

VGAScreen.prototype.destroy = function()
{

};

/**
 * @param {number} cols_count
 * @param {number} rows_count
 */
VGAScreen.prototype.set_size_text = function(cols_count, rows_count)
{
    this.max_cols = cols_count;
    this.max_rows = rows_count;

    this.bus.send("screen-set-size-text", [cols_count, rows_count]);
};

VGAScreen.prototype.set_size_graphical = function(width, height, bpp)
{
    this.screen_width = width;
    this.screen_height = height;

    this.stats.bpp = bpp;
    this.stats.is_graphical = true;
    this.stats.res_x = width;
    this.stats.res_y = height;

    this.bus.send("screen-set-size-graphical", [width, height, bpp]);
};

VGAScreen.prototype.update_cursor_scanline = function()
{
    this.bus.send("screen-update-cursor-scanline", [this.cursor_scanline_start, this.cursor_scanline_end]);
};

VGAScreen.prototype.set_video_mode = function(mode)
{
    var is_graphical = false;

    var width = 0;
    var height = 0;

    switch(mode)
    {
        case 0x66:
            this.set_size_text(110, 46);
            break;
        case 0x03:
            this.set_size_text(this.text_mode_width, 25);
            break;
        case 0x10:
            width = 640;
            height = 350;
            is_graphical = true;
            this.graphical_mode_is_linear = false;
            break;
        case 0x12:
            width = 640;
            height = 480;
            is_graphical = true;
            this.graphical_mode_is_linear = false;
            break;
        case 0x13:
            width = 320;
            height = 200;
            is_graphical = true;
            this.graphical_mode_is_linear = true;
            break;
        default:
    }

    this.bus.send("screen-set-mode", is_graphical);
    this.stats.is_graphical = is_graphical;

    if(is_graphical)
    {
        this.svga_width = width;
        this.svga_height = height;
        this.set_size_graphical(width, height, 8);
    }

    this.graphical_mode = is_graphical;

    dbg_log("Current video mode: " + h(mode), LOG_VGA);
};

VGAScreen.prototype.port3C0_write = function(value)
{
    if(this.attribute_controller_index === -1)
    {
        this.attribute_controller_index = value;
    }
    else
    {
        if(this.attribute_controller_index < 0x10)
        {
            this.dac_map[this.attribute_controller_index] = value;
        }
        else
        switch(this.attribute_controller_index)
        {
            default:
                dbg_log("3C0 / attribute controller write " + h(this.attribute_controller_index) + ": " + h(value), LOG_VGA);
        }

        this.attribute_controller_index = -1;
    }
};

VGAScreen.prototype.port3C0_read = function()
{
    dbg_log("3C0 read", LOG_VGA);
    var result = this.attribute_controller_index;
    this.attribute_controller_index = -1;
    return result;
};

VGAScreen.prototype.port3C0_read16 = function()
{
    dbg_log("3C0 read16", LOG_VGA);
    return this.port3C0_read() & 0xFF | this.port3C1_read() << 8 & 0xFF00;
};

VGAScreen.prototype.port3C1_read = function()
{
    this.attribute_controller_index = -1;

    dbg_log("3C1 / attribute controller read " + h(this.attribute_controller_index), LOG_VGA);
    return -1;
};

VGAScreen.prototype.port3C2_write = function(value)
{
    dbg_log("3C2 / miscellaneous output register = " + h(value), LOG_VGA);
    this.miscellaneous_output_register = value;

    // cheat way to figure out which video mode is indended to be used
    this.switch_video_mode(value);
};

VGAScreen.prototype.port3C4_write = function(value)
{
    this.sequencer_index = value;
};

VGAScreen.prototype.port3C4_read = function()
{
    return this.sequencer_index;
};

VGAScreen.prototype.port3C5_write = function(value)
{
    switch(this.sequencer_index)
    {
        case 0x02:
            //dbg_log("plane write mask: " + h(value), LOG_VGA);
            this.plane_write_bm = value;
            break;
        case 0x04:
            dbg_log("sequencer memory mode: " + h(value), LOG_VGA);
            this.sequencer_memory_mode = value;
            break;
        default:
            dbg_log("3C5 / sequencer write " + h(this.sequencer_index) + ": " + h(value), LOG_VGA);
    }
};

VGAScreen.prototype.port3C5_read = function()
{
    dbg_log("3C5 / sequencer read " + h(this.sequencer_index), LOG_VGA);

    switch(this.sequencer_index)
    {
        case 0x02:
            return this.plane_write_bm;
        case 0x04:
            return this.sequencer_memory_mode;
        case 0x06:
            return 0x12;
        default:
    }
    return 0;
};

VGAScreen.prototype.port3C7_write = function(index)
{
    // index for reading the DAC
    dbg_log("3C7 write: " + h(index), LOG_VGA);
    this.dac_color_index_read = index * 3;
};

VGAScreen.prototype.port3C8_write = function(index)
{
    this.dac_color_index_write = index * 3;
};

VGAScreen.prototype.port3C9_write = function(color_byte)
{
    var index = this.dac_color_index_write / 3 | 0,
        offset = this.dac_color_index_write % 3,
        color = this.vga256_palette[index];

    color_byte = color_byte * 255 / 63 & 0xFF;

    if(offset === 0)
    {
        color = color & ~0xFF0000 | color_byte << 16;
    }
    else if(offset === 1)
    {
        color = color & ~0xFF00 | color_byte << 8;
    }
    else
    {
        color = color & ~0xFF | color_byte;
        dbg_log("dac set color, index=" + h(index) + " value=" + h(color), LOG_VGA);
    }

    this.vga256_palette[index] = color;
    this.dac_color_index_write++;

    // Needs to be throttled:
    //this.complete_redraw();
};

VGAScreen.prototype.port3C9_read = function()
{
    dbg_log("3C9 read", LOG_VGA);

    var index = this.dac_color_index_read / 3 | 0;
    var offset = this.dac_color_index_read % 3;
    var color = this.vga256_palette[index];

    this.dac_color_index_read++;
    return (color >> (2 - offset) * 8 & 0xFF) / 255 * 63 | 0;
};

VGAScreen.prototype.port3CC_read = function()
{
    dbg_log("3CC read", LOG_VGA);
    return this.miscellaneous_output_register;
};

VGAScreen.prototype.port3CE_write = function(value)
{
    this.graphics_index = value;
};

VGAScreen.prototype.port3CE_read = function()
{
    return this.graphics_index;
};

VGAScreen.prototype.port3CF_write = function(value)
{
    switch(this.graphics_index)
    {
        // TODO: Set/Reset bit
        //case 0:
        //case 1:
            //break;
        case 3:
            this.planar_rotate_reg = value;
            dbg_log("plane rotate: " + h(value), LOG_VGA);
            break;
        case 4:
            this.plane_read = value;
            //dbg_assert(value < 4, "unimplemented");
            dbg_log("plane read: " + h(value), LOG_VGA);
            break;
        case 5:
            this.planar_mode = value;
            dbg_log("planar mode: " + h(value), LOG_VGA);
            break;
        case 8:
            this.planar_bitmap = value;
            dbg_log("planar bitmap: " + h(value), LOG_VGA);
            break;
        default:
            dbg_log("3CF / graphics write " + h(this.graphics_index) + ": " + h(value), LOG_VGA);
    }
};

VGAScreen.prototype.port3CF_read = function()
{
    dbg_log("3CF / graphics read " + h(this.graphics_index), LOG_VGA);

    switch(this.graphics_index)
    {
        case 3:
            return this.planar_rotate_reg;
        case 4:
            return this.plane_read;
        case 5:
            return this.planar_mode;
        case 8:
            return this.planar_bitmap;
        default:
    }
    return 0;
};

VGAScreen.prototype.port3D4_write = function(register)
{
    this.index_crtc = register;
};

VGAScreen.prototype.port3D5_write = function(value)
{
    switch(this.index_crtc)
    {
        case 0x2:
            this.text_mode_width = value;
            break;
        case 0x9:
            this.max_scan_line = value;
            if((value & 0x1F) === 7)
            {
                this.set_size_text(this.text_mode_width, 50);
            }
            else
            {
                this.set_size_text(this.text_mode_width, 25);
            }
            break;
        case 0xA:
            this.cursor_scanline_start = value;
            this.update_cursor_scanline();
            break;
        case 0xB:
            this.cursor_scanline_end = value;
            this.update_cursor_scanline();
            break;
        case 0xC:
            this.previous_start_address = this.start_address;
            this.start_address = this.start_address & 0xff | value << 8;
            this.complete_redraw();
            break;
        case 0xD:
            this.start_address = this.start_address & 0xff00 | value;
            var delta = this.start_address - this.previous_start_address;
            if(delta)
            {
                //if(!this.graphical_mode && delta % this.text_mode_width === 0)
                //{
                //    this.bus.send("screen-text-scroll", delta / this.text_mode_width);
                //}
                //else
                {
                    this.complete_redraw();
                }
            }
            dbg_log("start addr: " + h(this.start_address, 4), LOG_VGA);
            break;
        case 0xE:
            this.cursor_address = this.cursor_address & 0xFF | value << 8;
            this.update_cursor();
            break;
        case 0xF:
            this.cursor_address = this.cursor_address & 0xFF00 | value;
            this.update_cursor();
            break;
        case 0x13:
            this.offset_register = value;
            break;
        default:
            if(this.index_crtc < this.crtc.length)
            {
                this.crtc[this.index_crtc] = value;
            }
            dbg_log("3D5 / CRTC write " + h(this.index_crtc) + ": " + h(value), LOG_VGA);
    }

};

VGAScreen.prototype.port3D5_read = function()
{
    dbg_log("3D5 read " + h(this.index_crtc), LOG_VGA);

    switch(this.index_crtc)
    {
        case 0x9:
            return this.max_scan_line;
        case 0xA:
            return this.cursor_scanline_start;
        case 0xB:
            return this.cursor_scanline_end;
        case 0xC:
            return this.start_address & 0xFF;
        case 0xD:
            return this.start_address >> 8;
        case 0xE:
            return this.cursor_address >> 8;
        case 0xF:
            return this.cursor_address & 0xFF;
        case 0x1:
            return 80; // cols
        case 0x12:
            return 50; // rows
        case 0x13:
            return this.offset_register;
    }

    if(this.index_crtc < this.crtc.length)
    {
        return this.crtc[this.index_crtc];
    }
    else
    {
        return 0;
    }
};

VGAScreen.prototype.port3DA_read = function()
{
    dbg_log("3DA read", LOG_VGA);

    // status register
    this.port_3DA_value ^= 8;
    this.attribute_controller_index = -1;
    return this.port_3DA_value;
};

VGAScreen.prototype.switch_video_mode = function(mar)
{
    // Cheap way to figure this out, using the Miscellaneous Output Register
    // See: http://wiki.osdev.org/VGA_Hardware#List_of_register_settings

    if(mar === 0x66)
    {
        this.set_video_mode(0x66);
    }
    else if(mar === 0x67)
    {
        this.set_video_mode(0x3);
    }
    else if(mar === 0xE3)
    {
        // also mode X
        this.set_video_mode(0x12);
    }
    else if(mar === 0x63)
    {
        this.set_video_mode(0x13);
    }
    else if(mar === 0xA3)
    {
        this.set_video_mode(0x10);
    }
    else
    {
        dbg_log("Unkown MAR value: " + h(mar, 2) + ", going back to text mode", LOG_VGA);
        this.set_video_mode(0x3);
    }
};

VGAScreen.prototype.svga_bytes_per_line = function()
{
    var bits = this.svga_bpp === 15 ? 16 : this.svga_bpp;

    return this.svga_width * bits / 8;
};

VGAScreen.prototype.port1CE_write = function(value)
{
    this.dispi_index = value;
};

VGAScreen.prototype.port1CF_write = function(value)
{
    dbg_log("1CF / dispi write " + h(this.dispi_index) + ": " + h(value), LOG_VGA);

    switch(this.dispi_index)
    {
        case 1:
            this.svga_width = value;
            if(this.svga_width > MAX_XRES)
            {
                dbg_log("svga_width reduced from " + this.svga_width + " to " + MAX_XRES, LOG_VGA);
                this.svga_width = MAX_XRES;
            }
            break;
        case 2:
            this.svga_height = value;
            if(this.svga_height > MAX_YRES)
            {
                dbg_log("svga_height reduced from " + this.svga_height + " to " + MAX_YRES, LOG_VGA);
                this.svga_height = MAX_YRES;
            }
            break;
        case 3:
            this.svga_bpp = value;
            break;
        case 4:
            // enable, options
            this.svga_enabled = (value & 1) === 1;
            this.dispi_enable_value = value;
            break;
        case 5:
            this.svga_bank_offset = value << 16;
            break;
        case 9:
            // y offset
            this.svga_offset = value * this.svga_bytes_per_line();
            dbg_log("SVGA offset: " + h(this.svga_offset) + " y=" + h(value), LOG_VGA);
            this.complete_redraw();
            break;
        default:
    }

    if(this.svga_enabled && (!this.svga_width || !this.svga_height))
    {
        dbg_log("SVGA: disabled because of invalid width/height: " + this.svga_width + "x" + this.svga_height, LOG_VGA);
        this.svga_enabled = false;
    }

    dbg_assert(this.svga_bpp !== 4, "unimplemented svga bpp: 4");
    dbg_assert(this.svga_bpp !== 15, "unimplemented svga bpp: 15");
    dbg_assert(this.svga_bpp === 4 || this.svga_bpp === 8 ||
               this.svga_bpp === 15 || this.svga_bpp === 16 ||
               this.svga_bpp === 24 || this.svga_bpp === 32,
               "unexpected svga bpp: " + this.svga_bpp);

    dbg_log("SVGA: enabled=" + this.svga_enabled + ", " + this.svga_width + "x" + this.svga_height + "x" + this.svga_bpp, LOG_VGA);

    if(this.svga_enabled && this.dispi_index === 4)
    {
        this.set_size_graphical(this.svga_width, this.svga_height, this.svga_bpp);
        this.bus.send("screen-set-mode", true);
        this.graphical_mode = true;
        this.graphical_mode_is_linear = true;
    }

    if(!this.svga_enabled)
    {
        this.svga_bank_offset = 0;
    }
};

VGAScreen.prototype.port1CF_read = function()
{
    dbg_log("1CF / dispi read " + h(this.dispi_index), LOG_VGA);
    return this.svga_register_read(this.dispi_index);
};

VGAScreen.prototype.svga_register_read = function(n)
{
    switch(n)
    {
        case 0:
            // id
            return 0xB0C0;
        case 1:
            return this.dispi_enable_value & 2 ? MAX_XRES : this.svga_width;
        case 2:
            return this.dispi_enable_value & 2 ? MAX_YRES : this.svga_height;
        case 3:
            return this.dispi_enable_value & 2 ? MAX_BPP : this.svga_bpp;
        case 4:
            return this.dispi_enable_value;
        case 5:
            return this.svga_bank_offset >>> 16;
        case 6:
            // virtual width
            if(this.screen_width)
            {
                return this.screen_width;
            }
            else
            {
                return 1; // seabios/windows98 divide exception
            }
            break;

        case 8:
            // x offset
            return 0;
        case 0x0A:
            // memory size in 64 kilobyte banks
            return this.vga_memory_size / VGA_BANK_SIZE | 0;
    }

    return 0xFF;
};

VGAScreen.prototype.screen_fill_buffer = function()
{
    if(!this.graphical_mode)
    {
        // text mode
        return;
    }

    if(!this.dest_buffer)
    {
        dbg_log("Cannot fill buffer: No destination buffer", LOG_VGA);
        return;
    }

    if(this.diff_addr_max < this.diff_addr_min)
    {
        return;
    }

    var bpp = 0;
    var offset = 0;

    if(this.svga_enabled)
    {
        bpp = this.svga_bpp;
    }
    else
    {
        if(this.graphical_mode_is_linear)
        {
            bpp = 8;
        }
        else
        {
            bpp = 8;
            offset = VGA_PLANAR_REAL_BUFFER_START;
        }
    }


    var buffer = this.dest_buffer;

    var start = this.diff_addr_min;
    var end = this.diff_addr_max;

    switch(bpp)
    {
        case 32:
            var start_pixel = start >> 2;
            var end_pixel = (end >> 2) + 1;

            for(var i = start_pixel; i < end_pixel; i++)
            {
                var dword = this.svga_memory32[i];

                buffer[i] = dword << 16 | dword >> 16 & 0xFF | dword & 0xFF00 | 0xFF000000;
            }
            break;

        case 24:
            var start_pixel = start / 3 | 0;
            var end_pixel = (end / 3 | 0) + 1;
            var addr = start_pixel * 3;

            for(var i = start_pixel; addr < end; i++)
            {
                var red = this.svga_memory[addr++];
                var green = this.svga_memory[addr++];
                var blue = this.svga_memory[addr++];

                buffer[i] = red << 16 | green << 8 | blue | 0xFF000000;
            }
            break;

        case 16:
            var start_pixel = start >> 1;
            var end_pixel = (end >> 1) + 1;

            for(var i = start_pixel; i < end_pixel; i++)
            {
                var word = this.svga_memory16[i];

                var blue = (word >> 11) * 0xFF / 0x1F | 0;
                var green = (word >> 5 & 0x3F) * 0xFF / 0x3F | 0;
                var red = (word & 0x1F) * 0xFF / 0x1F | 0;

                buffer[i] = red << 16 | green << 8 | blue | 0xFF000000;
            }
            break;

        case 8:
            var start_pixel = start - offset;
            var end_pixel = end - offset + 1;

            for(var i = start; i < end; i++)
            {
                var color = this.vga256_palette[this.svga_memory[i]];
                buffer[i - offset] = color & 0xFF00 | color << 16 | color >> 16 | 0xFF000000;
            }
            break;

        default:
            dbg_assert(false, "Unsupported BPP: " + bpp);
    }

    this.diff_addr_min = this.vga_memory_size;
    this.diff_addr_max = 0;

    this.bus.send("screen-fill-buffer-end", [start_pixel, end_pixel]);
};
