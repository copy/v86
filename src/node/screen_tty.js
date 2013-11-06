"use strict";

/*
 * Very simple prototype, mostly incomplete
 */
function NodeScreenTTY()
{
    var stdout = process.stdout,
        cursor_row = 0,
        cursor_col = 0;

    clear();

    function clear()
    {
        stdout.write("\x1b[2J");
    }

    function set_cursor_pos(row, col)
    {
        stdout.write("\x1b[" + row + ";" + col + "H");
    }

    function hide_cursor()
    {
        stdout.write("\x1b[?25l");
    }

    function show_cursor()
    {
        stdout.write("\x1b[?25h");
    }

    this.timer_text = function()
    {

    };

    this.destroy = function()
    {

    };

    this.set_mode = function(is_graphical)
    {
        if(is_graphical)
        {
            console.log("Graphical Mode is not supported for NodeScreenTTY");
        }
    };

    this.clear_screen = function()
    {

    };

    this.set_size_text = function(cols, rows)
    {

    };

    this.set_size_graphical = function(width, height)
    {

    };

    this.update_cursor = function(row, col)
    {
        cursor_row = row;
        cursor_col = col;
    };

    this.update_cursor_scanline = function(start, end)
    {

    };

    this.put_char = function(row, col, chr, bg_color, fg_color)
    {
        var str = String.fromCharCode(chr);

        hide_cursor();
        set_cursor_pos(row, col + 1);

        stdout.write(str);

        set_cursor_pos(cursor_row, cursor_col + 2);
        show_cursor();
    };
}
