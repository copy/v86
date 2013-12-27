"use strict";

function NodeScreenSDL(sdl, font_file)
{
    var ROW_HEIGHT = 16,

        // about right for ascii.ttf
        CHAR_WIDTH = 10,

        /** @type {number} */
        cursor_scanline_start,

        /** @type {number} */
        cursor_scanline_end,

        current_cursor_address,

        is_graphical = false,

        graphic_buffer,
        graphic_buffer8,
        graphic_buffer32;


    sdl.init(sdl.INIT.VIDEO);

    var ttf = sdl.TTF,
        screen;

    ttf.init();

    var font = ttf.openFont(font_file, 16);

    sdl.events.on("QUIT", function()
    {
        process.exit();
    });

    this.put_char = function(row, col, chr, bg_color, fg_color)
    {
        if((chr & 0xff) === 0)
        {
            // required, otherwise sdl throws up
            return;
        }

        var str = String.fromCharCode(chr & 0xff),
            s = ttf.renderTextShaded(font, str, fg_color, bg_color);

        sdl.blitSurface(s, null, screen, [col * CHAR_WIDTH, row * ROW_HEIGHT]);
        sdl.freeSurface(s);
    };

    this.put_pixel_linear = function(offset, color_part)
    {
        graphic_buffer8[offset] = color_part;
    };

    this.put_pixel = function(x, y, color)
    {
        throw "TODO";
    };

    this.timer_text = function()
    {
        sdl.flip(screen);
    };

    this.timer_graphical = function()
    {
        sdl.putImageData(screen, graphic_buffer32);
        sdl.flip(screen);
    };

    this.destroy = function()
    {

    };

    this.set_mode = function(graphical)
    {
        // switch between graphical and text mode
        is_graphical = graphical;
    };

    this.clear_screen = function()
    {

    };

    this.set_size_text = function(cols, rows)
    {
        if(!is_graphical)
        {
            screen = sdl.setVideoMode(CHAR_WIDTH * cols, ROW_HEIGHT * rows, 32, 0);
        }

        //dbg_log(screen, LOG_VGA);
        //dbg_log(screen.pixels, LOG_VGA);
    };

    this.set_size_graphical = function(width, height)
    {
        screen = sdl.setVideoMode(width, height, 32, 0);

        graphic_buffer = new ArrayBuffer(width * height * 4);
        graphic_buffer8 = new Uint8Array(graphic_buffer);
        graphic_buffer32 = new Int32Array(graphic_buffer);
    };

    this.update_cursor = function(cursor_row, cursor_col)
    {
        refresh_cursor();
    };

    this.update_cursor_scanline = function(start, end)
    {
        cursor_scanline_start = start;
        cursor_scanline_end = end;

        refresh_cursor();
    };

    function refresh_cursor()
    {
        // TODO
    }

}

