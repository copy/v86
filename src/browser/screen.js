"use strict";

if(!window.requestAnimationFrame)
{
    window.requestAnimationFrame = 
        window.mozRequestAnimationFrame || 
        window.webkitRequestAnimationFrame;
}


/**
 * Adapter to use visual screen in browsers (in constrast to node)
 * @constructor
 */
function ScreenAdapter()
{
    var 
        dom_target = document.body,
        text_screen = document.getElementById("screen"),
        graphic_screen = document.getElementById("vga"),
        graphic_context = graphic_screen.getContext("2d"),
        cursor_element = document.createElement("div"),


        graphic_image_data,
        graphic_buffer,

        /** @type {number} */
        cursor_row,

        /** @type {number} */
        cursor_col,

        /** @type {number} */
        scale_x = 1,

        /** @type {number} */
        scale_y = 1,

        graphical_mode_width,

        screen = this,

        changed_rows,

        did_redraw = true,
        did_change = false,

        // Index 0: ASCII code
        // Index 1: Background color
        // Index 2: Foreground color
        text_mode_data,

        // number of columns
        text_mode_width,

        // number of rows
        text_mode_height;



    /**
     * Charmaps that containt unicode sequences for the default dospage
     * @const
     */
    var charmap_high = new Uint16Array([
        0xC7, 0xFC, 0xE9, 0xE2, 0xE4, 0xE0, 0xE5, 0xE7,
        0xEA, 0xEB, 0xE8, 0xEF, 0xEE, 0xEC, 0xC4, 0xC5, 
        0xC9, 0xE6, 0xC6, 0xF4, 0xF6, 0xF2, 0xFB, 0xF9, 
        0xFF, 0xD6, 0xDC, 0xA2, 0xA3, 0xA5, 0x20A7, 0x192,
        0xE1, 0xED, 0xF3, 0xFA, 0xF1, 0xD1, 0xAA, 0xBA,
        0xBF, 0x2310, 0xAC, 0xBD, 0xBC, 0xA1, 0xAB, 0xBB,
        0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
        0x2555, 0x2563, 0x2551, 0x2557, 0x255D, 0x255C, 0x255B, 0x2510,
        0x2514, 0x2534, 0x252C, 0x251C, 0x2500, 0x253C, 0x255E, 0x255F,
        0x255A, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256C, 0x2567, 
        0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256B,
        0x256A, 0x2518, 0x250C, 0x2588, 0x2584, 0x258C, 0x2590, 0x2580,
        0x3B1, 0xDF, 0x393, 0x3C0, 0x3A3, 0x3C3, 0xB5, 0x3C4,
        0x3A6, 0x398, 0x3A9, 0x3B4, 0x221E, 0x3C6, 0x3B5, 0x2229, 
        0x2261, 0xB1, 0x2265, 0x2264, 0x2320, 0x2321, 0xF7,
        0x2248, 0xB0, 0x2219, 0xB7, 0x221A, 0x207F, 0xB2, 0x25A0, 0xA0
    ]);

    /** @const */
    var charmap_low = new Uint16Array([
        0x20,   0x263A, 0x263B, 0x2665, 0x2666, 0x2663, 0x2660, 0x2022,
        0x25D8, 0x25CB, 0x25D9, 0x2642, 0x2640, 0x266A, 0x266B, 0x263C,
        0x25BA, 0x25C4, 0x2195, 0x203C, 0xB6,   0xA7,   0x25AC, 0x21A8,
        0x2191, 0x2193, 0x2192, 0x2190, 0x221F, 0x2194, 0x25B2, 0x25BC
    ]);

    graphic_context["imageSmoothingEnabled"] = false;
    graphic_context["mozImageSmoothingEnabled"] = false;
    graphic_context["webkitImageSmoothingEnabled"] = false;

    cursor_element.id = "cursor";
    text_screen.style.display = "block";

    graphic_screen.style.display = "none";

    this.make_screenshot = function()
    {
        try {
            window.open(graphic_screen.toDataURL());
        }
        catch(e) {}
    };

    this.put_char = function(row, col, chr, bg_color, fg_color)
    {
        changed_rows[row] = 1;

        var p = 3 * (row * text_mode_width + col);
        text_mode_data[p] = chr;
        text_mode_data[p + 1] = bg_color;
        text_mode_data[p + 2] = fg_color;
    };

    this.timer_text = function()
    {
        if(!did_redraw)
        {
            return;
        }
        did_redraw = false;

        requestAnimationFrame(update_text);
    };

    function update_text()
    {
        did_redraw = true;

        for(var i = 0; i < text_mode_height; i++)
        {
            if(changed_rows[i])
            {
                screen.text_update_row(i);
                changed_rows[i] = 0;
            }
        }
    }

    this.put_pixel = function(x, y, color)
    {
        var offset = y * graphical_mode_width + x << 2;

        graphic_buffer[offset] = color >> 16 & 0xFF;
        graphic_buffer[offset + 1] = color >> 8 & 0xFF;
        graphic_buffer[offset + 2] = color & 0xFF;

        did_change = true;
    };

    this.put_pixel_linear = function(index, color)
    {
        dbg_assert((index & 3) !== 3);

        // (addr + 1) ^ 3: Change BGR (svga) order to RGB (canvas)
        graphic_buffer[(index + 1) ^ 3] = color;

        did_change = true;
    };

    this.timer_graphical = function()
    {
        if(!did_redraw)
        {
            return;
        }
        did_redraw = false;

        requestAnimationFrame(function()
        {
            did_redraw = true;

            if(did_change)
            {
                did_change = false;
                graphic_context.putImageData(graphic_image_data, 0, 0);
            }
        });
    };

    this.destroy = function()
    {
        //dom_target.removeChild(text_screen);
        //dom_target.removeChild(graphic_screen);
    };

    this.set_mode = function(graphical)
    {
        if(graphical)
        {
            text_screen.style.display = "none";
            graphic_screen.style.display = "block";
        }
        else
        {
            text_screen.style.display = "block";
            graphic_screen.style.display = "none";
        }
    };

    this.clear_screen = function()
    {
        graphic_context.fillStyle = "#000";
        graphic_context.fillRect(0, 0, graphic_screen.width, graphic_screen.height);
    };

    /**
     * @param {number} cols 
     * @param {number} rows
     */
    this.set_size_text = function(cols, rows)
    {
        changed_rows = new Int8Array(rows);
        text_mode_data = new Int32Array(cols * rows * 3);

        text_mode_width = cols;
        text_mode_height = rows;

        while(text_screen.firstChild)
        {
            text_screen.removeChild(text_screen.firstChild);
        }

        for(var i = 0; i < rows; i++)
        {
            text_screen.appendChild(document.createElement("div"));
        }

        for(var i = 0; i < rows; i++)
        {
            this.text_update_row(i);
        }
    };

    this.set_size_graphical = function(width, height)
    {
        graphic_screen.style.display = "block";

        graphic_screen.width = width;
        graphic_screen.height = height;
        
        //graphic_screen.style.width = width * scale_x + "px";
        //graphic_screen.style.height = height * scale_y + "px";

        // Make sure to call this here, because pixels are transparent otherwise
        screen.clear_screen();

        graphic_image_data = graphic_context.getImageData(0, 0, width, height);
        graphic_buffer = graphic_image_data.data;

        graphical_mode_width = width;
    };

    this.set_scale = function(s_x, s_y)
    {
        scale_x = s_x;
        scale_y = s_y;

        elem_set_scale(graphic_screen, scale_x, scale_y);
        elem_set_scale(text_screen, scale_x, scale_y);
    };
    this.set_scale(scale_x, scale_y);

    function elem_set_scale(elem, scale_x, scale_y)
    {
        var scale_str = "";

        scale_str += scale_x === 1 ? "" : " scaleX(" + scale_x + ")";
        scale_str += scale_y === 1 ? "" : " scaleY(" + scale_y + ")";

        elem.style.webkitTransform = elem.style.MozTransform = scale_str;
    }

    this.update_cursor_scanline = function(start, end)
    {
        if(start & 0x20)
        {
            cursor_element.style.display = "none";
        }
        else
        {
            cursor_element.style.display = "inline";

            cursor_element.style.height = Math.min(15, end - start) + "px";
            cursor_element.style.marginTop = Math.min(15, start) + "px";
        }
    };

    this.update_cursor = function(row, col)
    {
        if(row !== cursor_row || col !== cursor_col)
        {
            changed_rows[row] = 1;
            changed_rows[cursor_row] = 1;

            cursor_row = row;
            cursor_col = col;
        }
    };

    this.text_update_row = function(row)
    {
        var offset = 3 * row * text_mode_width,
            row_element, 
            color_element, 
            bg_color,
            fg_color,
            text;

        row_element = document.createElement("div");

        for(var i = 0; i < text_mode_width; )
        {
            color_element = document.createElement("span");

            bg_color = text_mode_data[offset + 1];
            fg_color = text_mode_data[offset + 2];

            color_element.style.backgroundColor = "#" + h(bg_color, 6);
            color_element.style.color = "#" + h(fg_color, 6);
            
            text = "";

            // put characters of the same color in one element
            while(i < text_mode_width 
                    && text_mode_data[offset + 1] === bg_color
                    && text_mode_data[offset + 2] === fg_color)
            {
                var ascii = text_mode_data[offset],
                    chr;

                // use of utf-8
                if(ascii > 127)
                {
                    chr = String.fromCharCode(charmap_high[ascii - 0x80]);
                }
                else if(ascii < 32)
                {
                    chr = String.fromCharCode(charmap_low[ascii]);
                }
                else
                {
                    chr = String.fromCharCode(ascii);
                }

                text += chr;

                i++;
                offset += 3;

                if(row === cursor_row)
                {
                    if(i === cursor_col)
                    {
                        // next row will be cursor
                        // create new element
                        break;
                    }
                    else if(i === cursor_col + 1)
                    {
                        // found the cursor
                        row_element.appendChild(cursor_element);
                        break;
                    }
                }
            }

            color_element.textContent = text;
            row_element.appendChild(color_element);
        }

        text_screen.replaceChild(row_element, text_screen.childNodes[row]);
    };
}
