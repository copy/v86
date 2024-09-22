"use strict";

/**
 * @constructor
 */
function DummyScreenAdapter()
{
    var
        graphic_image_data,

        /** @type {number} */
        cursor_row = 0,

        /** @type {number} */
        cursor_col = 0,

        graphical_mode_width = 0,
        graphical_mode_height = 0,

        // are we in graphical mode now?
        is_graphical = false,

        // Index 0: ASCII code
        // Index 1: Blinking
        // Index 2: Background color
        // Index 3: Foreground color
        text_mode_data,

        // number of columns
        text_mode_width = 0,

        // number of rows
        text_mode_height = 0;

    this.put_char = function(row, col, chr, blinking, bg_color, fg_color)
    {
        dbg_assert(row >= 0 && row < text_mode_height);
        dbg_assert(col >= 0 && col < text_mode_width);
        text_mode_data[row * text_mode_width + col] = chr;
    };

    this.destroy = function() {};
    this.pause = function() {};
    this.continue = function() {};

    this.set_mode = function(graphical)
    {
        is_graphical = graphical;
    };

    this.set_font_bitmap = function(height, width_9px, width_dbl, copy_8th_col, bitmap, bitmap_changed)
    {
    };

    this.set_font_page = function(page_a, page_b)
    {
    };

    this.clear_screen = function()
    {
    };

    /**
     * @param {number} cols
     * @param {number} rows
     */
    this.set_size_text = function(cols, rows)
    {
        if(cols === text_mode_width && rows === text_mode_height)
        {
            return;
        }

        text_mode_data = new Uint8Array(cols * rows);
        text_mode_width = cols;
        text_mode_height = rows;
    };

    this.set_size_graphical = function(width, height)
    {
        graphical_mode_width = width;
        graphical_mode_height = height;
    };

    this.set_scale = function(s_x, s_y)
    {
    };

    this.update_cursor_scanline = function(start, end, max)
    {
    };

    this.update_cursor = function(row, col)
    {
        cursor_row = row;
        cursor_col = col;
    };

    this.update_buffer = function(layers)
    {
    };

    this.get_text_screen = function()
    {
        var screen = [];

        for(var i = 0; i < text_mode_height; i++)
        {
            screen.push(this.get_text_row(i));
        }

        return screen;
    };

    this.get_text_row = function(i)
    {
        const offset = i * text_mode_width;
        return String.fromCharCode.apply(String, text_mode_data.subarray(offset, offset + text_mode_width));
    };

    this.set_size_text(80, 25);
}
