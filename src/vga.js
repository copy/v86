"use strict";


/**
 * @constructor
 */
function VGAScreen(cpu, adapter, vga_memory_size)
{
    var
        dev = cpu.devices,
        io = cpu.io,
        memory = cpu.memory,

        /** 
         * Always 64k
         * @const 
         */
        VGA_BANK_SIZE = 64 * 1024,

        /** @const */
        MAX_XRES = 1920,

        /** @const */
        MAX_YRES = 1080,

        /** @const */
        MAX_BPP = 32,
        
        /** @type {number} */
        cursor_address = 0,

        /** @type {number} */
        cursor_scanline_start = 0xE,

        /** @type {number} */
        cursor_scanline_end = 0xF,

        /** @type {VGAScreen} */
        screen = this,

        /**
         * Number of columns in text mode
         * @type {number} 
         */
        max_cols,

        /** 
         * Number of rows in text mode
         * @type {number} 
         */
        max_rows,

        /**
         * Width in pixels in graphical mode
         * @type {number}
         */
        screen_width,

        /**
         * Height in pixels in graphical mode
         * @type {number}
         */
        screen_height,

        /**
         * video memory start address
         * @type {number}
         */
        start_address = 0,

        /** @type {boolean} */
        graphical_mode_is_linear = true,

        /** @type {boolean} */
        graphical_mode = false,

        /** @type {boolean} */
        do_complete_redraw = false,

        /* 
         * VGA palette containing 256 colors for video mode 13 etc.
         * Needs to be initialised by the BIOS
         */
        vga256_palette = new Int32Array(256),

        // VGA latches
        latch0 = 0,
        latch1 = 0,
        latch2 = 0,
        latch3 = 0,

        
        /** @type {number} */
        svga_width = 0,

        /** @type {number} */
        svga_height = 0,

        plane0,
        plane1,
        plane2,
        plane3;

    if(adapter === undefined)
    {
        adapter = new VGADummyAdapter();
    }

    // 4 times 64k
    this.vga_memory = null;
    
    this.svga_memory = null;
    this.svga_enabled = false;

    this.adapter = adapter;
    this.svga_memory16 = null;

    /** @type {number} */
    this.svga_bpp = 0;

    // Experimental, could probably need some changes
    // 01:00.0 VGA compatible controller: NVIDIA Corporation GT216 [GeForce GT 220] (rev a2)
    this.pci_space = [
        0xde, 0x10, 0x20, 0x0a, 0x07, 0x00, 0x00, 0x00, 0xa2, 0x00, 0x00, 0x03, 0x00, 0x00, 0x80, 0x00,
        0x08, 0x00, 0x00, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x01, 0x00, 0x00,
    ];
    this.pci_id = 0x12 << 3;
    this.pci_bars = [
        {
            size: vga_memory_size,
        },
    ];

    dev.pci.register_device(this);

    this.stats = {
        is_graphical: false,
        res_x: 0,
        res_y: 0,
        bpp: 0,
    };

    this.init = function()
    {
        if(vga_memory_size === undefined || vga_memory_size < 4 * VGA_BANK_SIZE)
        {
            vga_memory_size = 4 * VGA_BANK_SIZE;
            dbg_log("vga memory size rounded up to " + vga_memory_size, LOG_VGA);
        }
        else if(vga_memory_size & (VGA_BANK_SIZE - 1))
        {
            // round up to next 64k
            vga_memory_size |= VGA_BANK_SIZE - 1;
            vga_memory_size++;
        }

        this.svga_memory = new Uint8Array(vga_memory_size);
        this.svga_memory16 = new Uint16Array(this.svga_memory.buffer);

        this.vga_memory = new Uint8Array(this.svga_memory.buffer, 0, 4 * VGA_BANK_SIZE);

        plane0 = new Uint8Array(this.svga_memory.buffer, 0 * VGA_BANK_SIZE, VGA_BANK_SIZE);
        plane1 = new Uint8Array(this.svga_memory.buffer, 1 * VGA_BANK_SIZE, VGA_BANK_SIZE);
        plane2 = new Uint8Array(this.svga_memory.buffer, 2 * VGA_BANK_SIZE, VGA_BANK_SIZE);
        plane3 = new Uint8Array(this.svga_memory.buffer, 3 * VGA_BANK_SIZE, VGA_BANK_SIZE);

        this.set_size_text(80, 25);
        this.update_cursor_scanline();

        io.mmap_register(0xA0000, 0x20000, 1, this.vga_memory_read, this.vga_memory_write);
        io.mmap_register(0xE0000000, vga_memory_size, 1, this.svga_memory_read, this.svga_memory_write);
    }

    this.vga_memory_read = function(addr)
    {
        if(!graphical_mode || graphical_mode_is_linear)
        {
            return screen.vga_memory[addr];
        }

        // TODO: "Color don't care"
        //dbg_assert((planar_mode & 0x08)  === 0, "unimplemented");

        // planar mode
        addr &= 0xFFFF;

        latch0 = plane0[addr];
        latch1 = plane1[addr];
        latch2 = plane2[addr];
        latch3 = plane3[addr];

        return screen.vga_memory[plane_read << 16 | addr];
    }

    this.vga_memory_write = function(addr, value)
    {
        if(graphical_mode)
        {
            if(graphical_mode_is_linear)
            {
                screen.vga_memory_write_graphical_linear(addr, value);
            }
            else
            {
                screen.vga_memory_write_graphical_planar(addr, value);
            }
        }
        else
        {
            screen.vga_memory_write_text_mode(addr, value);
        }
    }

    this.vga_memory_write_graphical_linear = function(addr, value)
    {
        var offset = addr << 2,
            color = vga256_palette[value];

        this.adapter.put_pixel_linear(offset | 2, color >> 16 & 0xFF);
        this.adapter.put_pixel_linear(offset | 1, color >> 8 & 0xFF);
        this.adapter.put_pixel_linear(offset, color & 0xFF);

        this.vga_memory[addr] = value;
    }

    this.vga_memory_write_graphical_planar = function(addr, value)
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

        var write_mode = planar_mode & 3;

        // not implemented:
        // - Planar mode 3
        // - Rotation
        // - Shift mode
        // - Host Odd/Even
        dbg_assert((planar_rotate_reg & 7) === 0, "unimplemented");
        dbg_assert(write_mode !== 3, "unimplemented");
        dbg_assert((planar_mode & 0x70)  === 0, "unimplemented");
        
        if(write_mode === 0)
        {
            plane0_byte = plane1_byte = plane2_byte = plane3_byte = value;
        }
        else if(write_mode === 2)
        {
            if(plane_write_bm & 1)
            {
                write = value & 1 ? 0xFF : 0;
                plane0_byte = latch0 & ~planar_bitmap | write & planar_bitmap;
            }
            if(plane_write_bm & 2)
            {
                write = value & 2 ? 0xFF : 0;
                plane1_byte = latch1 & ~planar_bitmap | write & planar_bitmap;
            }
            if(plane_write_bm & 4)
            {
                write = value & 4 ? 0xFF : 0;
                plane2_byte = latch2 & ~planar_bitmap | write & planar_bitmap;
            }
            if(plane_write_bm & 8)
            {
                write = value & 8 ? 0xFF : 0;
                plane3_byte = latch3 & ~planar_bitmap | write & planar_bitmap;
            }
        }

        if(write_mode === 0 || write_mode === 2)
        {
            switch(planar_rotate_reg & 0x18)
            {
                case 0x08:
                    plane0_byte &= latch0;
                    plane1_byte &= latch1;
                    plane2_byte &= latch2;
                    plane3_byte &= latch3;
                    break;
                case 0x10:
                    plane0_byte |= latch0;
                    plane1_byte |= latch1;
                    plane2_byte |= latch2;
                    plane3_byte |= latch3;
                    break;
                case 0x18:
                    plane0_byte ^= latch0;
                    plane1_byte ^= latch1;
                    plane2_byte ^= latch2;
                    plane3_byte ^= latch3;
                    break;
            }

            if(plane_write_bm & 1)
            {
                plane0_byte = latch0 & ~planar_bitmap | plane0_byte & planar_bitmap;
            }
            if(plane_write_bm & 2)
            {
                plane1_byte = latch1 & ~planar_bitmap | plane1_byte & planar_bitmap;
            }
            if(plane_write_bm & 4)
            {
                plane2_byte = latch2 & ~planar_bitmap | plane2_byte & planar_bitmap;
            }
            if(plane_write_bm & 8)
            {
                plane3_byte = latch3 & ~planar_bitmap | plane3_byte & planar_bitmap;
            }
        }
        else if(write_mode === 1)
        {
            plane0_byte = latch0;
            plane1_byte = latch1;
            plane2_byte = latch2;
            plane3_byte = latch3;
        }

        if(plane_write_bm & 1)
        {
            plane0[addr] = plane0_byte;
        }
        else
        {
            plane0_byte = plane0[addr];
        }
        if(plane_write_bm & 2)
        {
            plane1[addr] = plane1_byte;
        }
        else
        {
            plane1_byte = plane1[addr];
        }
        if(plane_write_bm & 4)
        {
            plane2[addr] = plane2_byte;
        }
        else
        {
            plane2_byte = plane2[addr];
        }
        if(plane_write_bm & 8)
        {
            plane3[addr] = plane3_byte;
        }
        else
        {
            plane3_byte = plane3[addr];
        }

        if(addr >= (screen_width * screen_height << 3))
        {
            return;
        }

        // Shift these, so that the bits for the color are in 
        // the correct position in the while loop
        plane1_byte <<= 1;
        plane2_byte <<= 2;
        plane3_byte <<= 3;

        // 8 pixels per byte, we start at high (addr << 3 | 7)
        // << 2 because we're using put_pixel_linear
        var offset = (addr << 3 | 7) << 2;

        for(var i = 0; i < 8; i++)
        {
            var color_index = 
                    plane0_byte >> i & 1 |
                    plane1_byte >> i & 2 |
                    plane2_byte >> i & 4 |
                    plane3_byte >> i & 8,
                color = vga256_palette[dac_map[color_index]];

            this.adapter.put_pixel_linear(offset | 2, color >> 16);
            this.adapter.put_pixel_linear(offset | 1, color >> 8 & 0xFF);
            this.adapter.put_pixel_linear(offset, color & 0xFF);

            offset -= 4;
        }
    }

    this.text_mode_redraw = function()
    {
        var addr = 0x18000 | start_address << 1,
            chr,
            color;

        for(var row = 0; row < max_rows; row++)
        {
            for(var col = 0; col < max_cols; col++)
            {
                chr = this.vga_memory[addr];
                color = this.vga_memory[addr | 1];

                this.adapter.put_char(row, col, chr, 
                    vga256_palette[color >> 4 & 0xF], vga256_palette[color & 0xF]);

                addr += 2;
            }
        }
    }

    this.graphical_linear_redraw = function()
    {
        // TODO
    };

    this.graphical_planar_redraw = function()
    {
        var addr = 0,
            color;

        for(var y = 0; y < screen_height; y++)
        {
            for(var x = 0; x < screen_width; x += 8)
            {
                for(var i = 0; i < 8; i++)
                {
                    color = 
                        plane0[addr] >> i & 1 |
                        plane1[addr] >> i << 1 & 2 |
                        plane2[addr] >> i << 2 & 4 |
                        plane3[addr] >> i << 3 & 8;

                    this.adapter.put_pixel(x + 7 - i, y, vga256_palette[dac_map[color]]);
                }

                addr++;
            }
        }
    };

    this.vga_memory_write_text_mode = function(addr, value)
    {
        if(addr < 0x18000)
        {
            return;
        }

        var memory_start = (addr - 0x18000 >> 1) - start_address,
            row = memory_start / max_cols | 0,
            col = memory_start % max_cols,
            chr,
            color;

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

        this.adapter.put_char(row, col, chr, 
                vga256_palette[color >> 4 & 0xF], vga256_palette[color & 0xF]);

        this.vga_memory[addr] = value;
    }

    this.update_cursor = function()
    {
        var row = (cursor_address - start_address) / max_cols | 0,
            col = (cursor_address - start_address) % max_cols;

        row = Math.min(max_rows - 1, row);

        this.adapter.update_cursor(row, col);
    }


    this.svga_memory_read = function(addr)
    {
        return screen.svga_memory[addr];
    }

    this.svga_memory_write = function(addr, value)
    {
        screen.svga_memory[addr] = value;

        if(!screen.svga_enabled)
        {
            return;
        }

        switch(screen.svga_bpp)
        {
            case 32:
                // 4th byte is meaningless
                if((addr & 3) !== 3)
                {
                    screen.adapter.put_pixel_linear(addr, value);
                }
                break;

            case 24:
                addr = (addr << 2) / 3 | 0;
                screen.adapter.put_pixel_linear(addr, value);
                break;

            case 16:
                if(addr & 1)
                {
                    var word = screen.svga_memory16[addr >> 1],
                        red = word & 0x1F,
                        green = word >> 5 & 0x3F,
                        blue = value >> 3 & 0x1F;

                    blue = blue * 0xFF / 0x1F | 0;
                    green = green * 0xFF / 0x3F | 0;
                    red = red * 0xFF / 0x1F | 0;

                    addr <<= 1;

                    screen.adapter.put_pixel_linear(addr, red);
                    screen.adapter.put_pixel_linear(addr - 1, green);
                    screen.adapter.put_pixel_linear(addr - 2, blue);
                }
                break;

            case 8:
                var color = vga256_palette[value],
                    offset = addr << 2;

                screen.adapter.put_pixel_linear(offset, color >> 16 & 0xFF);
                screen.adapter.put_pixel_linear(offset | 1, color >> 8 & 0xFF);
                screen.adapter.put_pixel_linear(offset | 2, color & 0xFF);
                break;

            default:
                if(DEBUG)
                {
                    throw "SVGA: Unsupported BPP: " + screen.svga_bpp;
                }
        }
    }

    this.timer = function(time)
    {
        if(do_complete_redraw)
        {
            do_complete_redraw = false;

            if(graphical_mode)
            {
                if(graphical_mode_is_linear)
                {
                    this.graphical_linear_redraw();
                }
                else 
                {
                    this.graphical_planar_redraw();
                }
            }
            else
            {
                this.text_mode_redraw();
            }
        }

        if(graphical_mode || this.svga_enabled)
        {
            this.adapter.timer_graphical();
        }
        else
        {
            this.adapter.timer_text();
        }
    };

    /**
     * @param {number} cols_count 
     * @param {number} rows_count 
     */
    this.set_size_text = function(cols_count, rows_count)
    {
        max_cols = cols_count;
        max_rows = rows_count;

        this.adapter.set_size_text(cols_count, rows_count);
    };

    this.set_size_graphical = function(width, height)
    {
        this.adapter.set_size_graphical(width, height);
    }

    this.update_cursor_scanline = function()
    {
        this.adapter.update_cursor_scanline(cursor_scanline_start, cursor_scanline_end);
    };

    this.clear_screen = function()
    {
        this.adapter.clear_screen();
    };

    this.set_video_mode = function(mode)
    {
        var is_graphical = false;

        switch(mode)
        {
            case 0x03:
                this.set_size_text(80, 25);
                break;
            case 0x10:
                screen_width = 640;
                screen_height = 350;
                is_graphical = true;
                graphical_mode_is_linear = false;
                break;
            case 0x12:
                screen_width = 640;
                screen_height = 480;
                is_graphical = true;
                graphical_mode_is_linear = false;
                break;
            case 0x13:
                screen_width = 320;
                screen_height = 200;
                is_graphical = true;
                graphical_mode_is_linear = true;
                break;
            default:
        }

        this.adapter.set_mode(is_graphical);
        this.stats.is_graphical = is_graphical;

        if(is_graphical)
        {
            this.set_size_graphical(screen_width, screen_height);
            this.stats.res_x = screen_width;
            this.stats.res_y = screen_height;
            this.stats.bpp = 8;
        }

        graphical_mode = is_graphical;

        dbg_log("Current video mode: " + h(mode), LOG_VGA);
    };

    this.destroy = function()
    {

    };

    var index_crtc = 0,
        index_dac = 0,
        index_attribute = 0;


    // index for setting colors through port 3C9h
    var dac_color_index = 0;

    function port3C7_write(index)
    {
        // index for reading the DAC
        dbg_log("3C7 write: " + h(index), LOG_VGA);
    };
    io.register_write(0x3C7, port3C7_write);

    function port3C8_write(index)
    {
        dac_color_index = index * 3;
    };
    io.register_write(0x3C8, port3C8_write);


    function port3C9_write(color_byte)
    {
        var index = dac_color_index / 3 | 0,
            offset = dac_color_index % 3,
            color = vga256_palette[index];

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

        vga256_palette[index] = color;

        dac_color_index++;

        do_complete_redraw = true;
    }
    io.register_write(0x3C9, port3C9_write);

    var max_scan_line = 0;

    function port3D4_write(register)
    {
        index_crtc = register;
    };
    io.register_write(0x3D4, port3D4_write);

    function port3D5_write(value)
    {
        switch(index_crtc)
        {
            case 0x9:
                max_scan_line = value;
                if((value & 0x1F) === 7)
                {
                    screen.set_size_text(80, 50);
                }
                else
                {
                    screen.set_size_text(80, 25);
                }
                break;
            case 0xA:
                cursor_scanline_start = value;
                screen.update_cursor_scanline();
                break;
            case 0xB:
                cursor_scanline_end = value;
                screen.update_cursor_scanline();
                break;
            case 0xC:
                start_address = start_address & 0xff | value << 8;
                do_complete_redraw = true;
                break;
            case 0xD:
                start_address = start_address & 0xff00 | value;
                do_complete_redraw = true;
                //dbg_log("start addr: " + h(start_address, 4), LOG_VGA);
                break;
            case 0xE:
                cursor_address = cursor_address & 0xFF | value << 8;
                screen.update_cursor();
                break;
            case 0xF:
                cursor_address = cursor_address & 0xFF00 | value;
                screen.update_cursor();
                break;
            default:
                dbg_log("3D5 / CRTC write " + h(index_crtc) + ": " + h(value), LOG_VGA);
        }

    };
    io.register_write(0x3D5, port3D5_write);

    function port3D5_read()
    {
        if(index_crtc === 0x9)
        {
            return max_scan_line;
        }
        if(index_crtc === 0xA)
        {
            return cursor_scanline_start;
        }
        else if(index_crtc === 0xB)
        {
            return cursor_scanline_end;
        }
        else if(index_crtc === 0xE)
        {
            return cursor_address >> 8;
        }
        else if(index_crtc === 0xF)
        {
            return cursor_address & 0xFF;
        }

        dbg_log("3D5 read " + h(index_crtc), LOG_VGA);
        return 0;
    };
    io.register_read(0x3D5, port3D5_read);

    var miscellaneous_output_register = 0xff;

    function port3CC_read()
    {
        return miscellaneous_output_register;
    }
    io.register_read(0x3CC, port3CC_read);

    function port3C2_write(value)
    {
        dbg_log("3C2 / miscellaneous output register = " + h(value), LOG_VGA);
        miscellaneous_output_register = value;

        // cheat way to figure out which video mode is indended to be used
        switch_video_mode(value);
    }
    io.register_write(0x3C2, port3C2_write);


    function port3DA_read()
    {
        // status register
        attribute_controller_index = -1;
        return 0xff;
    }
    io.register_read(0x3DA, port3DA_read);


    var attribute_controller_index = -1;

    function port3C1_read()
    {
        attribute_controller_index = -1;

        dbg_log("3C1 / attribute controller read " + h(attribute_controller_index), LOG_VGA);
        return -1;
    }
    io.register_read(0x3C1, port3C1_read);

    var dac_map = new Uint8Array(0x10);

    function port3C0_write(value)
    {
        if(attribute_controller_index === -1)
        {
            attribute_controller_index = value;
        }
        else
        {
            if(attribute_controller_index < 0x10)
            {
                dac_map[attribute_controller_index] = value;
            }
            else
            switch(attribute_controller_index)
            {
                default:
                    dbg_log("3C0 / attribute controller write " + h(attribute_controller_index) + ": " + h(value), LOG_VGA);
            }

            attribute_controller_index = -1;

        }
    }
    io.register_write(0x3C0, port3C0_write);

    function port3C0_read()
    {
        dbg_log("3C0 read", LOG_VGA);
        var result = attribute_controller_index;
        attribute_controller_index = -1;
        return result;
    }
    io.register_read(0x3C0, port3C0_read);

    
    var sequencer_index = -1;

    function port3C4_write(value)
    {
        sequencer_index = value;
    }
    io.register_write(0x3C4, port3C4_write);

    function port3C4_read()
    {
        return sequencer_index;
    }
    io.register_read(0x3C4, port3C4_read);

    var 
        // bitmap of planes 0-3
        plane_write_bm = 0xF,
        sequencer_memory_mode = 0
        ; 

    function port3C5_write(value)
    {
        switch(sequencer_index)
        {
            case 0x02:
                //dbg_log("plane write mask: " + h(value), LOG_VGA);
                plane_write_bm = value;
                break;
            case 0x04:
                dbg_log("sequencer memory mode: " + h(value), LOG_VGA);
                sequencer_memory_mode = value;
                break;
            default:
                dbg_log("3C5 / sequencer write " + h(sequencer_index) + ": " + h(value), LOG_VGA);
        }
    }
    io.register_write(0x3C5, port3C5_write);


    function port3C5_read()
    {
        switch(sequencer_index)
        {
            case 0x02:
                return plane_write_bm;
            case 0x04:
                return sequencer_memory_mode;
            case 0x06:
                return 0x12;
            default:
                dbg_log("3C5 / sequencer read " + h(sequencer_index), LOG_VGA);
        }
        return 0;
    }
    io.register_read(0x3C5, port3C5_read);


    var graphics_index = -1;

    function port3CE_write(value)
    {
        graphics_index = value;
    }
    io.register_write(0x3CE, port3CE_write);

    function port3CE_read()
    {
        return graphics_index;
    }
    io.register_read(0x3CE, port3CE_read);

    var plane_read = 0, // value 0-3, which plane to read
        planar_mode = 0,
        planar_rotate_reg = 0,
        planar_bitmap = 0xFF;

    function port3CF_write(value)
    {
        switch(graphics_index)
        {
            // TODO: Set/Reset bit
            //case 0:
            //case 1:
                //break;
            case 3:
                planar_rotate_reg = value;
                dbg_log("plane rotate: " + h(value), LOG_VGA);
                break;
            case 4:
                plane_read = value;
                dbg_assert(value < 4);
                dbg_log("plane read: " + h(value), LOG_VGA);
                break;
            case 5:
                planar_mode = value;
                dbg_log("planar mode: " + h(value), LOG_VGA);
                break;
            case 8:
                planar_bitmap = value;
                //dbg_log("planar bitmap: " + h(value), LOG_VGA);
                break;
            default:
                dbg_log("3CF / graphics write " + h(graphics_index) + ": " + h(value), LOG_VGA);
        }
    }
    io.register_write(0x3CF, port3CF_write);

    function port3CF_read()
    {
        switch(graphics_index)
        {
            case 3:
                return planar_rotate_reg;
            case 4:
                return plane_read;
            case 5:
                return planar_mode;
            case 8:
                return planar_bitmap;
            default:
                dbg_log("3CF / graphics read " + h(graphics_index), LOG_VGA);
        }
        return 0;
    }
    io.register_read(0x3CF, port3CF_read);


    function switch_video_mode(mar)
    {
        // Cheap way to figure this out, using the Miscellaneous Output Register 
        // See: http://wiki.osdev.org/VGA_Hardware#List_of_register_settings

        if(mar === 0x67)
        {
            screen.set_video_mode(0x3);
        }
        else if(mar === 0xE3)
        {
            // also mode X
            screen.set_video_mode(0x12);
        }
        else if(mar === 0x63)
        {
            screen.set_video_mode(0x13);
        }
        else if(mar === 0xA3)
        {
            screen.set_video_mode(0x10);
        }
        else
        {
            dbg_log("Unkown MAR value: " + h(mar, 2) + ", going back to text mode", LOG_VGA);
            screen.set_video_mode(0x3);
        }
    }


    // Bochs VBE Extensions
    // http://wiki.osdev.org/Bochs_VBE_Extensions
    var dispi_index = -1,
        dispi_value = -1;

    function port1CE_write(value)
    {
        dispi_index = value;
    }
    io.register_write(0x1CE, port1CE_write);

    function port1CF_write(value, low_port)
    {
        if(low_port === 0x1CE)
        {
            dispi_index = dispi_index & 0xFF | value << 8;
        }
        else
        {
            dispi_value = value;

            dbg_log("1CF / dispi write low " + h(dispi_index) + ": " + h(value), LOG_VGA);
        }
    }
    io.register_write(0x1CF, port1CF_write);

    function port1D0_write(value)
    {
        dbg_log("1D0 / dispi write high " + h(dispi_index) + ": " + h(value), LOG_VGA);
        dispi_value = dispi_value & 0xFF | value << 8;

        switch(dispi_index)
        {
            case 1:
                svga_width = dispi_value;
                if(svga_width > MAX_XRES)
                {
                    dbg_log("svga_width reduced from " + svga_width + " to " + MAX_XRES, LOG_VGA);
                    svga_width = MAX_XRES;
                }
                break;
            case 2:
                svga_height = dispi_value;
                if(svga_height > MAX_YRES)
                {
                    dbg_log("svga_height reduced from " + svga_height + " to " + MAX_YRES, LOG_VGA);
                    svga_height = MAX_YRES;
                }
                break;
            case 3:
                this.svga_bpp = dispi_value;
                break;
            case 4:
                // enable, options
                this.svga_enabled = (dispi_value & 1) === 1;
                break;
            default:
        }

        if(this.svga_enabled && (!svga_width || !svga_width))
        {
            dbg_log("SVGA: disabled because of invalid width/height: " + svga_width + "x" + svga_height, LOG_VGA);
            this.svga_enabled = false;
        }

        dbg_log("SVGA: enabled=" + this.svga_enabled + ", " + svga_width + "x" + svga_height + "x" + this.svga_bpp, LOG_VGA);

        if(this.svga_enabled)
        {
            screen.set_size_graphical(svga_width, svga_height);
            this.adapter.set_mode(true);

            screen.stats.bpp = this.svga_bpp;
            screen.stats.is_graphical = true;
            screen.stats.res_x = svga_width;
            screen.stats.res_y = svga_height;
        }
    }
    io.register_write(0x1D0, port1D0_write.bind(this));


    function port1CF_read()
    {
        switch(dispi_index)
        {
            case 0:
                // id
                return 0xC0;
            case 1:
                return MAX_XRES;
            case 2:
                return MAX_YRES;
            case 3:
                return MAX_BPP;
            case 0x0A:
                // memory size in 64 kilobyte banks
                return vga_memory_size / VGA_BANK_SIZE | 0;
            default:
        }
        dbg_log("1CF / dispi read low " + h(dispi_index), LOG_VGA);
        return 0xFF;
    }
    io.register_read(0x1CF, port1CF_read);

    function port1D0_read()
    {
        switch(dispi_index)
        {
            case 0:
                // id
                return 0xB0;
            case 1:
                return MAX_XRES >> 8;
            case 2:
                return MAX_YRES >> 8;
            case 3:
                return MAX_BPP >> 8;
            case 0x0A:
                return vga_memory_size / VGA_BANK_SIZE >> 8;
            default:
        }
        dbg_log("1D0 / dispi read high " + h(dispi_index), LOG_VGA);
        return 0xFF;
    }
    io.register_read(0x1D0, port1D0_read);

    this.init();
}

/** @constructor */
function VGADummyAdapter()
{
    this.put_pixel_linear = function() {};
    this.put_char = function() {};
    this.put_pixel = function() {};
    this.set_mode = function() {};
    this.clear_screen = function() {};
    this.update_cursor = function() {};
    this.update_cursor_scanline = function() {};
    this.set_size_graphical = function() {};
    this.timer_text = function() {};
    this.timer_graphical = function() {};
    this.set_size_text = function() {};
}
