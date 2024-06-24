"use strict";

/**
 * @constructor
 *
 * @param {BusConnector} bus
 */
function DummyScreenAdapter(bus)
{
    var
        graphic_image_data,

        /** @type {number} */
        cursor_row,

        /** @type {number} */
        cursor_col,

        graphical_mode_width,
        graphical_mode_height,

        // are we in graphical mode now?
        is_graphical = false,

        // Index 0: ASCII code
        // Index 1: Blinking
        // Index 2: Background color
        // Index 3: Foreground color
        text_mode_data,

        // number of columns
        text_mode_width,

        // number of rows
        text_mode_height;

    const CHARACTER_INDEX = 0;
    const BLINKING_INDEX = 1;
    const BG_COLOR_INDEX = 2;
    const FG_COLOR_INDEX = 3;
    const TEXT_MODE_COMPONENT_SIZE = 4;

    this.bus = bus;

    bus.register("screen-set-mode", function(data)
    {
        this.set_mode(data);
    }, this);

    bus.register("screen-fill-buffer-end", function(data)
    {
        var min = data[0];
        var max = data[1];

        this.update_buffer(min, max);
    }, this);

    bus.register("screen-put-char", function(data)
    {
        //console.log(data);
        this.put_char(data[0], data[1], data[2], data[3], data[4], data[5]);
    }, this);

    bus.register("screen-text-scroll", function(rows)
    {
        console.log("scroll", rows);
    }, this);

    bus.register("screen-update-cursor", function(data)
    {
        this.update_cursor(data[0], data[1]);
    }, this);
    bus.register("screen-update-cursor-scanline", function(data)
    {
        this.update_cursor_scanline(data[0], data[1], data[2]);
    }, this);

    bus.register("screen-set-size-text", function(data)
    {
        this.set_size_text(data[0], data[1]);
    }, this);
    bus.register("screen-set-size-graphical", function(data)
    {
        this.set_size_graphical(data[0], data[1]);
    }, this);

    this.put_char = function(row, col, chr, blinking, bg_color, fg_color)
    {
        if(row < text_mode_height && col < text_mode_width)
        {
            var p = TEXT_MODE_COMPONENT_SIZE * (row * text_mode_width + col);

            text_mode_data[p + CHARACTER_INDEX] = chr;
            text_mode_data[p + BLINKING_INDEX] = blinking;
            text_mode_data[p + BG_COLOR_INDEX] = bg_color;
            text_mode_data[p + FG_COLOR_INDEX] = fg_color;
        }
    };

    this.destroy = function()
    {
    };

    this.set_mode = function(graphical)
    {
        is_graphical = graphical;
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

        text_mode_data = new Int32Array(cols * rows * TEXT_MODE_COMPONENT_SIZE);

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
        if(row !== cursor_row || col !== cursor_col)
        {
            cursor_row = row;
            cursor_col = col;
        }
    };

    this.update_buffer = function(min, max)
    {
        if(max < min)
        {
            return;
        }

        var min_y = min / graphical_mode_width | 0;
        var max_y = max / graphical_mode_width | 0;
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
        var row = "";
        var offset = TEXT_MODE_COMPONENT_SIZE * i * text_mode_width;

        for(var j = 0; j < text_mode_width; j++)
        {
            row += String.fromCharCode(text_mode_data[offset + CHARACTER_INDEX + TEXT_MODE_COMPONENT_SIZE * j]);
        }

        return row;
    };
}
