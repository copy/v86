/*
vga_text.js

Renders text to image buffer using VGA fonts and attributes.
*/
"use strict";

/**
 * @constructor
 * @param {VGAScreen} vga
 */
function GraphicalText(vga)
{
    this.vga = vga;

    /**
     * Number of text columns
     * @type {number}
     */
    this.txt_width = 80;

    /**
     * Number of text rows
     * @type {number}
     */
    this.txt_height = 25;

    /**
     * If true then at least one row in txt_row_dirty is marked as modified
     * @type{number}
     */
    this.txt_dirty = 0;

    /**
     * One bool per row, row was modified if its entry is != 0
     */
    this.txt_row_dirty = new Uint8Array(this.txt_height);

    /**
     * Font bitmaps in VGA memory were changed if true
     * @type{boolean}
     */
    this.font_data_dirty = false;

    /**
     * Font width in pixel (8, 9 or 16)
     * @type {number}
     */
    this.font_width = 9;

    /**
     * Font height in pixel (0...32)
     * @type {number}
     */
    this.font_height = 16;

    /**
     * Duplicate 8th to 9th column in horizontal line drawing characters if true (Line Graphics Enable)
     * @type{boolean}
     */
    this.font_lge = false;

    /**
     * Flat bitmap of 8 fonts, array of size: 8 * 256 * font_width * font_height
     * @type{Uint8ClampedArray<number>}
     */
    this.font_bitmap = new Uint8ClampedArray(8 * 256 * this.font_width * this.font_height);

    /**
     * True: blink when msb (0x80) of text attribute is set (8 background colors)
     * False: msb selects background intensity (16 background colors)
     * @type{boolean}
     */
    this.font_blink_enabled = false;

    /**
     * Active index (0...7) of font A
     * @type {number}
     */
    this.font_index_A = 0;

    /**
     * Active index (0...7) of font B (TODO)
     * @type {number}
     */
    this.font_index_B = 0;

    /**
     * If true then cursor_enabled_latch, cursor_top_latch and cursor_bottom_latch were overwritten since last call to render().
     * @type{boolean}
     */
    this.cursor_attr_dirty = false;

    /**
     * Latest value for cursor_enabled if cursor_attr_dirty is true
     * @type{boolean}
     */
    this.cursor_enabled_latch = false;

    /**
     * Latest value for cursor_top_latch if cursor_attr_dirty is true
     * @type {number}
     */
    this.cursor_top_latch = 0;

    /**
     * Latest value for cursor_bottom_latch if cursor_attr_dirty is true
     * @type {number}
     */
    this.cursor_bottom_latch = 0;

    /**
     * If true then cursor_row_latch and cursor_col_latch were overwritten since last call to render().
     * @type{boolean}
     */
    this.cursor_pos_dirty = false;

    /**
     * Latest value for cursor_row if cursor_pos_dirty is true
     * @type {number}
     */
    this.cursor_row_latch = 0;

    /**
     * Latest value for cursor_col if cursor_pos_dirty is true
     * @type {number}
     */
    this.cursor_col_latch = 0;

    /**
     * Emulate cursor if true, else disable cursor
     * @type{boolean}
     */
    this.cursor_enabled = false;

    /**
     * Cursor position's row (0...txt_height-1)
     * @type {number}
     */
    this.cursor_row = 0;

    /**
     * Cursor position's column (0...txt_width-1)
     * @type {number}
     */
    this.cursor_col = 0;

    /**
     * Cursor box's top scanline (0...font_height)
     * @type {number}
     */
    this.cursor_top = 0;

    /**
     * Cursor box's bottom scanline (0...font_height, inclusive)
     * @type {number}
     */
    this.cursor_bottom = 0;

    /**
     * Tracked value of register vga.attribute_mode
     * @type {number}
     */
    this.vga_attribute_mode = 0;

    /**
     * Tracked value of register vga.clocking_mode
     * @type {number}
     */
    this.vga_clocking_mode = 0;

    /**
     * Tracked value of register vga.max_scan_line
     * @type {number}
     */
    this.vga_max_scan_line = 0;

    /**
     * Width of graphics canvas in pixel (txt_width * font_width)
     * @type {number}
     */
    this.gfx_width = this.txt_width * this.font_width;

    /**
     * Height of graphics canvas in pixel (txt_height * font_height)
     * @type {number}
     */
    this.gfx_height = this.txt_height * this.font_height;

    /**
     * Local screen bitmap buffer, array of size: gfx_width * gfx_height * 4
     * @type{Uint8ClampedArray<number>}
     */
    this.gfx_data = new Uint8ClampedArray(this.gfx_width * this.gfx_height * 4);

    /**
     * Image container of local screen bitmap buffer gfx_data
     * @type{ImageData}
     */
    this.image_data = new ImageData(this.gfx_data, this.gfx_width, this.gfx_height);

    /**
     * Show cursor and blinking text now if true (controlled by framerate counter)
     * @type{boolean}
     */
    this.blink_visible = false;

    /**
     * Frame counter to control blink rate of type Uint32
     * @type {number}
     */
    this.frame_count = 0;
}

GraphicalText.prototype.rebuild_font_bitmap = function(width_9px, width_double)
{
    const font_height = this.font_height;
    const font_lge = this.font_lge;
    const src_bitmap = this.vga.plane2;
    const dst_bitmap = new Uint8ClampedArray(8 * 256 * this.font_width * font_height);
    const vga_inc_chr = 32 - font_height;

    let i_dst = 0;
    const copy_bit = width_double ?
        function(value)
        {
            dst_bitmap[i_dst++] = value;
            dst_bitmap[i_dst++] = value;
        } :
        function(value)
        {
            dst_bitmap[i_dst++] = value;
        };

    let i_src = 0;
    for(let i_font = 0; i_font < 8; ++i_font)
    {
        for(let i_chr = 0; i_chr < 256; ++i_chr, i_src += vga_inc_chr)
        {
            for(let i_line = 0; i_line < font_height; ++i_line)
            {
                const line_bits = src_bitmap[i_src++];
                for(let i_bit = 0x80; i_bit > 0; i_bit >>= 1)
                {
                    copy_bit(line_bits & i_bit ? 1 : 0);
                }
                if(width_9px)
                {
                    copy_bit(font_lge && i_chr >= 0xC0 && i_chr <= 0xDF && line_bits & 1 ? 1 : 0);
                }
            }
        }
    }

    return dst_bitmap;
};

GraphicalText.prototype.resize_canvas = function()
{
    this.txt_dirty = 1;
    this.txt_row_dirty.fill(1);
};

GraphicalText.prototype.rebuild_image_data = function()
{
    const gfx_size = this.gfx_width * this.gfx_height * 4;
    const gfx_data = new Uint8ClampedArray(gfx_size);
    for(let i = 3; i < gfx_size; i += 4)
    {
        gfx_data[i] = 0xff;
    }
    this.gfx_data = gfx_data;
    this.image_data = new ImageData(this.gfx_data, this.gfx_width, this.gfx_height);
    this.resize_canvas();
};

GraphicalText.prototype.mark_blinking_rows_dirty = function()
{
    const vga_memory = this.vga.vga_memory;
    const txt_row_dirty = this.txt_row_dirty;
    const txt_width = this.txt_width;
    const txt_height = this.txt_height;
    const txt_row_size = txt_width * 2;
    const txt_row_step = Math.max(0, (this.vga.offset_register * 2 - txt_width) * 2);
    const split_screen_row = this.vga.scan_line_to_screen_row(this.vga.line_compare);
    let row, col, txt_i = this.vga.start_address << 1;

    for(row = 0; row < txt_height; ++row, txt_i += txt_row_step)
    {
        if(row === split_screen_row)
        {
            txt_i = 0;
        }

        if(txt_row_dirty[row])
        {
            txt_i += txt_row_size;
            continue;
        }

        for(col = 0; col < txt_width; ++col, txt_i += 2)
        {
            if(vga_memory[txt_i | 1] & 0x80)
            {
                txt_row_dirty[row] = this.txt_dirty = 1;
                txt_i += txt_row_size - col * 2;
                break;
            }
        }
    }
};

GraphicalText.prototype.render_dirty_rows = function()
{
    const vga = this.vga;
    const vga_memory = vga.vga_memory;
    const txt_width = this.txt_width;
    const txt_height = this.txt_height;
    const txt_row_dirty = this.txt_row_dirty;
    const gfx_data = this.gfx_data;
    const font_bitmap = this.font_bitmap;
    const font_size = this.font_width * this.font_height;
    const font_A_offset = this.font_index_A * 256;
    const font_B_offset = this.font_index_B * 256;
    const font_AB_enabled = font_A_offset !== font_B_offset;
    const font_blink_enabled = this.font_blink_enabled;
    //const blink_visible = this.blink_visible;
    const blink_visible = true;
    const cursor_visible = this.cursor_enabled && blink_visible;
    const cursor_top = this.cursor_top;
    const cursor_height = this.cursor_bottom - cursor_top + 1;

    const split_screen_row = vga.scan_line_to_screen_row(vga.line_compare);
    const bg_color_mask = font_blink_enabled ? 0x7 : 0xF;
    const palette = new Int32Array(16);
    for(let i = 0; i < 16; ++i)
    {
        palette[i] = vga.vga256_palette[vga.dac_mask & vga.dac_map[i]];
    }

    const txt_row_size = txt_width * 2;
    const txt_row_step = Math.max(0, (vga.offset_register * 2 - txt_width) * 2);

    const gfx_col_size = this.font_width * 4;                       // column size in gfx_data (tuple of 4 RGBA items)
    const gfx_line_size = this.gfx_width * 4;                       // line size in gfx_data
    const gfx_row_size = gfx_line_size * this.font_height;          // row size in gfx_data
    const gfx_col_step = (this.font_width - this.font_height * this.gfx_width) * 4; // move from end of current column to start of next in gfx_data
    const gfx_line_step = (this.gfx_width - this.font_width) * 4;   // move forward to start of column's next line in gfx_data

    // int, current cursor linear position in canvas coordinates (top left of row/col)
    const cursor_gfx_i = (this.cursor_row * this.gfx_width * this.font_height + this.cursor_col * this.font_width) * 4;

    let txt_i, chr, chr_attr, chr_bg_rgba, chr_fg_rgba, chr_blinking, chr_font_ofs;
    let fg, bg, fg_r=0, fg_g=0, fg_b=0, bg_r=0, bg_g=0, bg_b=0;
    let gfx_i, gfx_end_y, gfx_end_x, glyph_i;
    let draw_cursor, gfx_ic;
    let row, col;

    txt_i = vga.start_address << 1;

    for(row = 0; row < txt_height; ++row, txt_i += txt_row_step)
    {
        if(row === split_screen_row)
        {
            txt_i = 0;
        }

        if(! txt_row_dirty[row])
        {
            txt_i += txt_row_size;
            continue;
        }

        gfx_i = row * gfx_row_size;

        for(col = 0; col < txt_width; ++col, txt_i += 2, gfx_i += gfx_col_step)
        {
            chr = vga_memory[txt_i];
            chr_attr = vga_memory[txt_i | 1];
            chr_blinking = font_blink_enabled && chr_attr & 0x80;
            chr_font_ofs = font_AB_enabled ? (chr_attr & 0x8 ? font_A_offset : font_B_offset) : font_A_offset;
            chr_bg_rgba = palette[chr_attr >> 4 & bg_color_mask];
            chr_fg_rgba = palette[chr_attr & 0xF];

            if(bg !== chr_bg_rgba)
            {
                bg = chr_bg_rgba;
                bg_r = bg >> 16;
                bg_g = (bg >> 8) & 0xff;
                bg_b = bg & 0xff;
            }

            if(chr_blinking && ! blink_visible)
            {
                if(fg !== bg) {
                    fg = bg;
                    fg_r = bg_r;
                    fg_g = bg_g;
                    fg_b = bg_b;
                }
            }
            else if(fg !== chr_fg_rgba)
            {
                fg = chr_fg_rgba;
                fg_r = fg >> 16;
                fg_g = (fg >> 8) & 0xff;
                fg_b = fg & 0xff;
            }

            draw_cursor = cursor_visible && cursor_gfx_i === gfx_i;

            glyph_i = (chr_font_ofs + chr) * font_size;

            gfx_end_y = gfx_i + gfx_row_size;
            for(; gfx_i < gfx_end_y; gfx_i += gfx_line_step)
            {
                gfx_end_x = gfx_i + gfx_col_size;
                for(; gfx_i < gfx_end_x; gfx_i += 4)
                {
                    if(font_bitmap[glyph_i++])
                    {
                        gfx_data[gfx_i]   = fg_r;
                        gfx_data[gfx_i+1] = fg_g;
                        gfx_data[gfx_i+2] = fg_b;
                    }
                    else
                    {
                        gfx_data[gfx_i]   = bg_r;
                        gfx_data[gfx_i+1] = bg_g;
                        gfx_data[gfx_i+2] = bg_b;
                    }
                }
            }

            if(draw_cursor)
            {
                gfx_ic = cursor_gfx_i + cursor_top * gfx_line_size;
                gfx_end_y = gfx_ic + cursor_height * gfx_line_size;
                for(; gfx_ic < gfx_end_y; gfx_ic += gfx_line_step)
                {
                    gfx_end_x = gfx_ic + gfx_col_size;
                    for(; gfx_ic < gfx_end_x; gfx_ic += 4)
                    {
                        gfx_data[gfx_ic]   = fg_r;
                        gfx_data[gfx_ic+1] = fg_g;
                        gfx_data[gfx_ic+2] = fg_b;
                    }
                }
            }
        }
    }
};

//
// Public methods
//

GraphicalText.prototype.mark_dirty = function()
{
    this.txt_row_dirty.fill(1);
    this.txt_dirty = 1;
};

GraphicalText.prototype.invalidate_row = function(row)
{
    if(row >= 0 && row < this.txt_height)
    {
        this.txt_row_dirty[row] = this.txt_dirty = 1;
    }
};

GraphicalText.prototype.invalidate_font_shape = function()
{
    this.font_data_dirty = true;
};

GraphicalText.prototype.set_size = function(rows, cols)
{
    if(rows > 0 && rows < 256 && cols > 0 && cols < 256)
    {
        this.txt_width = cols;
        this.txt_height = rows;

        this.gfx_width = this.txt_width * this.font_width;
        this.gfx_height = this.txt_height * this.font_height;

        this.txt_row_dirty = new Uint8Array(this.txt_height);
        this.vga.screen.set_size_graphical(this.gfx_width, this.gfx_height, this.gfx_width, this.gfx_height);
        this.mark_dirty();
        this.rebuild_image_data();
    }
};

GraphicalText.prototype.set_character_map = function(char_map_select)
{
    // bits 2, 3 and 5 (LSB to MSB): VGA font page index of font A
    // bits 0, 1 and 4: VGA font page index of font B
    // linear_index_map[] maps VGA's non-liner font page index to linear index
    const linear_index_map = [0, 2, 4, 6, 1, 3, 5, 7];
    const vga_index_A = ((char_map_select & 0b1100) >> 2) | ((char_map_select & 0b100000) >> 3);
    const vga_index_B = (char_map_select & 0b11) | ((char_map_select & 0b10000) >> 2);
    const font_index_A = linear_index_map[vga_index_A];
    const font_index_B = linear_index_map[vga_index_B];

    if(this.font_index_A !== font_index_A || this.font_index_B !== font_index_B)
    {
        this.font_index_A = font_index_A;
        this.font_index_B = font_index_B;
        this.mark_dirty();
    }
};

GraphicalText.prototype.set_cursor_pos = function(row, col)
{
    this.cursor_pos_dirty = true;
    this.cursor_row_latch = row;
    this.cursor_col_latch = col;
};

GraphicalText.prototype.set_cursor_attr = function(start, end, visible)
{
    this.cursor_attr_dirty = true;
    this.cursor_enabled_latch = !! visible;
    this.cursor_top_latch = start;
    this.cursor_bottom_latch = end;
};

GraphicalText.prototype.render = function()
{
    // increment Uint32 frame counter
    this.frame_count = (this.frame_count + 1) >>> 0;

    // apply changes to font_width, font_height, font_lge, font_bitmap and font_blink_enabled
    const curr_clocking_mode = this.vga.clocking_mode & 0b00001001;
    const curr_attribute_mode = this.vga.attribute_mode & 0b00001100;
    const curr_max_scan_line = this.vga.max_scan_line & 0b10011111;
    if(this.font_data_dirty ||
            this.vga_clocking_mode !== curr_clocking_mode ||
            this.vga_attribute_mode !== curr_attribute_mode ||
            this.vga_max_scan_line !== curr_max_scan_line)
    {
        const width_9px = ! (curr_clocking_mode & 0x01);
        const width_double = !! (curr_clocking_mode & 0x08);
        const curr_font_width = (width_9px ? 9 : 8) * (width_double ? 2 : 1);
        const curr_font_blink_enabled = !! (curr_attribute_mode & 0b00001000);
        const curr_font_lge = !! (curr_attribute_mode & 0b00000100);
        const curr_font_height = (curr_max_scan_line & 0b00011111) + 1;

        const font_data_changed = this.font_data_dirty || this.font_lge !== curr_font_lge;
        const font_size_changed = this.font_width !== curr_font_width || this.font_height !== curr_font_height;

        this.font_data_dirty = false;
        this.font_width = curr_font_width;
        this.font_height = curr_font_height;
        this.font_blink_enabled = curr_font_blink_enabled;
        this.font_lge = curr_font_lge;

        this.vga_clocking_mode = curr_clocking_mode;
        this.vga_attribute_mode = curr_attribute_mode;
        this.vga_max_scan_line = curr_max_scan_line;

        if(font_data_changed || font_size_changed)
        {
            if(font_size_changed)
            {
                this.gfx_width = this.txt_width * this.font_width;
                this.gfx_height = this.txt_height * this.font_height;
                this.rebuild_image_data();
            }
            this.font_bitmap = this.rebuild_font_bitmap(width_9px, width_double);
        }
        this.mark_dirty();
    }

    // apply changes to cursor position
    if(this.cursor_pos_dirty)
    {
        this.cursor_pos_dirty = false;
        this.cursor_row_latch = Math.min(this.cursor_row_latch, this.txt_height-1);
        this.cursor_col_latch = Math.min(this.cursor_col_latch, this.txt_width-1);
        if(this.cursor_row !== this.cursor_row_latch || this.cursor_col !== this.cursor_col_latch)
        {
            this.txt_row_dirty[this.cursor_row] = this.txt_row_dirty[this.cursor_row_latch] = this.txt_dirty = 1;
            this.cursor_row = this.cursor_row_latch;
            this.cursor_col = this.cursor_col_latch;
        }
    }

    // apply changes to cursor_enabled, cursor_top and cursor_bottom
    if(this.cursor_attr_dirty)
    {
        this.cursor_attr_dirty = false;
        if(this.cursor_enabled !== this.cursor_enabled_latch ||
                this.cursor_top !== this.cursor_top_latch ||
                this.cursor_bottom !== this.cursor_bottom_latch)
        {
            this.cursor_enabled = this.cursor_enabled_latch;
            this.cursor_top = this.cursor_top_latch;
            this.cursor_bottom = this.cursor_bottom_latch;
            this.txt_row_dirty[this.cursor_row] = this.txt_dirty = 1;
        }
    }

    // toggle cursor and blinking character visibility at a frequency of ~3.75hz (every 16th frame at 60fps)
    // TODO: make framerate independant
    //if(this.frame_count % 16 === 0)
    //{
    //    this.blink_visible = ! this.blink_visible;
    //    if(this.font_blink_enabled)
    //    {
    //        this.mark_blinking_rows_dirty();
    //    }
    //    if(this.cursor_enabled)
    //    {
    //        this.txt_row_dirty[this.cursor_row] = this.txt_dirty = 1;
    //    }
    //}

    // render changed rows
    if(this.txt_dirty)
    {
        this.render_dirty_rows();
        this.txt_dirty = 0;
        this.txt_row_dirty.fill(0);
    }

    return this.image_data;
};
