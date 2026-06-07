import { dbg_assert } from "../log.js";
import { get_charmap } from "../lib.js";

/**
 * @constructor
 * @param {Object=} options
 */
export function ANSIScreenAdapter(options)
{
    const CHARACTER_INDEX = 0;
    const BG_COLOR_INDEX = 1;
    const FG_COLOR_INDEX = 2;
    const TEXT_BUF_COMPONENT_SIZE = 3;

    const ANSI_RESET = "\x1B[0m";

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
        // Index 1: Background color
        // Index 2: Foreground color
        text_mode_data,

        // number of columns
        text_mode_width = 0,

        // number of rows
        text_mode_height = 0,

        // 8-bit-text to Unicode character map
        charmap = get_charmap(options?.encoding);

    function hex_to_ansi_truecolor(color)
    {
        const
            RED   = (color & 0xFF0000) >> 16,
            GREEN = (color & 0x00FF00) >> 8,
            BLUE  = (color & 0x0000FF);

        return `2;${RED};${GREEN};${BLUE}`;
    }

    this.put_char = function(row, col, chr, blinking, bg_color, fg_color)
    {
        dbg_assert(row >= 0 && row < text_mode_height);
        dbg_assert(col >= 0 && col < text_mode_width);
        dbg_assert(chr >= 0 && chr < 0x100);

        const p = TEXT_BUF_COMPONENT_SIZE * (row * text_mode_width + col);

        text_mode_data[p + CHARACTER_INDEX] = chr;
        text_mode_data[p + BG_COLOR_INDEX] = bg_color;
        text_mode_data[p + FG_COLOR_INDEX] = fg_color;
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

        text_mode_data = new Int32Array(cols * rows * TEXT_BUF_COMPONENT_SIZE);
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

    // XXX: duplicated in DummyScreenAdapter
    this.get_text_screen = function()
    {
        var screen = [];

        for(var i = 0; i < text_mode_height; i++)
        {
            screen.push(this.get_text_row(i));
        }

        return screen;
    };

    this.get_text_row = function(y)
    {
        const begin = y * text_mode_width * TEXT_BUF_COMPONENT_SIZE + CHARACTER_INDEX;
        const end = begin + text_mode_width * TEXT_BUF_COMPONENT_SIZE;

        let previous_bg = null;
        let previous_fg = null;
        let row = "";
        for(var i = begin; i < end; i += TEXT_BUF_COMPONENT_SIZE)
        {
            const chr = charmap[text_mode_data[i]];
            const bg_color = text_mode_data[i + BG_COLOR_INDEX];
            const fg_color = text_mode_data[i + FG_COLOR_INDEX];

            let ansi_code = "";
            // combine previous colors with current ones if possible
            if(previous_bg !== bg_color)
            {
                ansi_code += `\x1B[48;${hex_to_ansi_truecolor(bg_color)}m`;
                previous_bg = bg_color;
            }
            if(previous_fg !== fg_color)
            {
                ansi_code += `\x1B[38;${hex_to_ansi_truecolor(fg_color)}m`;
                previous_fg = fg_color;
            }
            row += ansi_code + chr;
        }
        return row + ANSI_RESET;
    };

    this.set_size_text(80, 25);
}
