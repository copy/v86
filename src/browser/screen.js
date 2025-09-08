import { dbg_assert } from "../log.js";
import { get_charmap } from "../lib.js";

// Draws entire buffer and visualizes the layers that would be drawn
export const DEBUG_SCREEN_LAYERS = DEBUG && false;

/**
 * Adapter to use visual screen in browsers (in contrast to node)
 * @constructor
 * @param {Object} options
 * @param {function()} screen_fill_buffer
 */
export function ScreenAdapter(options, screen_fill_buffer)
{
    const screen_container = options.container;
    this.screen_fill_buffer = screen_fill_buffer;

    console.assert(screen_container, "options.container must be provided");

    const MODE_TEXT = 0;
    const MODE_GRAPHICAL = 1;
    const MODE_GRAPHICAL_TEXT = 2;

    const CHARACTER_INDEX = 0;
    const FLAGS_INDEX = 1;
    const BG_COLOR_INDEX = 2;
    const FG_COLOR_INDEX = 3;
    const TEXT_BUF_COMPONENT_SIZE = 4;

    const FLAG_BLINKING = 0x01;
    const FLAG_FONT_PAGE_B = 0x02;

    this.FLAG_BLINKING = FLAG_BLINKING;
    this.FLAG_FONT_PAGE_B = FLAG_FONT_PAGE_B;

    var
        graphic_screen = screen_container.getElementsByTagName("canvas")[0],
        graphic_context = graphic_screen.getContext("2d", { alpha: false }),

        text_screen = screen_container.getElementsByTagName("div")[0],
        cursor_element = document.createElement("div");

    var
        /** @type {number} */
        cursor_row,

        /** @type {number} */
        cursor_col,

        /** @type {number} */
        scale_x = options.scale !== undefined ? options.scale : 1,

        /** @type {number} */
        scale_y = options.scale !== undefined ? options.scale : 1,

        base_scale = 1,

        changed_rows,

        // current display mode: MODE_GRAPHICAL or either MODE_TEXT/MODE_GRAPHICAL_TEXT
        mode,

        // Index 0: ASCII code
        // Index 1: Flags bitset (see FLAG_...)
        // Index 2: Background color
        // Index 3: Foreground color
        text_mode_data,

        // number of columns
        text_mode_width,

        // number of rows
        text_mode_height,

        // graphical text mode's offscreen canvas contexts
        offscreen_context,
        offscreen_extra_context,

        // fonts
        font_context,
        font_image_data,
        font_is_visible = new Int8Array(8 * 256),
        font_height,
        font_width,
        font_width_9px,
        font_width_dbl,
        font_copy_8th_col,
        font_page_a = 0,
        font_page_b = 0,

        // blink state
        blink_visible,
        tm_last_update = 0,

        // cursor attributes
        cursor_start,
        cursor_end,
        cursor_enabled,

        // 8-bit-text to Unicode character map
        charmap = get_charmap(options.encoding),

        // render loop state
        timer_id = 0,
        paused = false;

    // 0x12345 -> "#012345"
    function number_as_color(n)
    {
        n = n.toString(16);
        return "#" + "0".repeat(6 - n.length) + n;
    }

    function render_font_bitmap(vga_bitmap)
    {
        // - Browsers impose limts on the X- and Y-axes of bitmaps (typically around 8 to 32k).
        //   Draw the 8 VGA font pages of 256 glyphs in 8 rows of 256 columns, this results
        //   in 2048, 2304 or 4096px on the X-axis (for 8, 9 or 16px VGA font width, resp.).
        //   This 2d layout is also convenient for glyph lookup when rendering text.
        // - Font bitmap pixels are black and either fully opaque (alpha 255) or fully transparent (0).
        const bitmap_width = font_width * 256;
        const bitmap_height = font_height * 8;

        let font_canvas = font_context ? font_context.canvas : null;
        if(!font_canvas || font_canvas.width !== bitmap_width || font_canvas.height !== bitmap_height)
        {
            if(!font_canvas)
            {
                font_canvas = new OffscreenCanvas(bitmap_width, bitmap_height);
                font_context = font_canvas.getContext("2d");
            }
            else
            {
                font_canvas.width = bitmap_width;
                font_canvas.height = bitmap_height;
            }
            font_image_data = font_context.createImageData(bitmap_width, bitmap_height);
        }

        const font_bitmap = font_image_data.data;
        let i_dst = 0, is_visible;
        const put_bit = font_width_dbl ?
            function(value)
            {
                is_visible = is_visible || value;
                font_bitmap[i_dst + 3] = value;
                font_bitmap[i_dst + 7] = value;
                i_dst += 8;
            } :
            function(value)
            {
                is_visible = is_visible || value;
                font_bitmap[i_dst + 3] = value;
                i_dst += 4;
            };

        // move i_vga from end of glyph to start of next glyph
        const vga_inc_chr = 32 - font_height;
        // move i_dst from end of font page (bitmap row) to start of next font page
        const dst_inc_row = bitmap_width * (font_height - 1) * 4;
        // move i_dst from end of glyph (bitmap column) to start of next glyph
        const dst_inc_col = (font_width - bitmap_width * font_height) * 4;
        // move i_dst from end of a glyph's scanline to start of its next scanline
        const dst_inc_line = font_width * 255 * 4;

        for(let i_chr_all = 0, i_vga = 0; i_chr_all < 2048; ++i_chr_all, i_vga += vga_inc_chr, i_dst += dst_inc_col)
        {
            const i_chr = i_chr_all % 256;
            if(i_chr_all && !i_chr)
            {
                i_dst += dst_inc_row;
            }
            is_visible = false;
            for(let i_line = 0; i_line < font_height; ++i_line, ++i_vga, i_dst += dst_inc_line)
            {
                const line_bits = vga_bitmap[i_vga];
                for(let i_bit = 0x80; i_bit > 0; i_bit >>= 1)
                {
                    put_bit(line_bits & i_bit ? 255 : 0);
                }
                if(font_width_9px)
                {
                    put_bit(font_copy_8th_col && i_chr >= 0xC0 && i_chr <= 0xDF && line_bits & 1 ? 255 : 0);
                }
            }
            font_is_visible[i_chr_all] = is_visible ? 1 : 0;
        }

        font_context.putImageData(font_image_data, 0, 0);
    }

    function render_changed_rows()
    {
        const font_canvas = font_context.canvas;
        const offscreen_extra_canvas = offscreen_extra_context.canvas;
        const txt_row_size = text_mode_width * TEXT_BUF_COMPONENT_SIZE;
        const gfx_width = text_mode_width * font_width;
        const row_extra_1_y = 0;
        const row_extra_2_y = font_height;

        let n_rows_rendered = 0;
        for(let row_i = 0, row_y = 0, txt_i = 0; row_i < text_mode_height; ++row_i, row_y += font_height)
        {
            if(!changed_rows[row_i])
            {
                txt_i += txt_row_size;
                continue;
            }
            ++n_rows_rendered;

            // clear extra row 2
            offscreen_extra_context.clearRect(0, row_extra_2_y, gfx_width, font_height);

            let fg_rgba, fg_x, bg_rgba, bg_x;
            for(let col_x = 0; col_x < gfx_width; col_x += font_width, txt_i += TEXT_BUF_COMPONENT_SIZE)
            {
                const chr = text_mode_data[txt_i + CHARACTER_INDEX];
                const chr_flags = text_mode_data[txt_i + FLAGS_INDEX];
                const chr_bg_rgba = text_mode_data[txt_i + BG_COLOR_INDEX];
                const chr_fg_rgba = text_mode_data[txt_i + FG_COLOR_INDEX];
                const chr_font_page = chr_flags & FLAG_FONT_PAGE_B ? font_page_b : font_page_a;
                const chr_visible = (!(chr_flags & FLAG_BLINKING) || blink_visible) && font_is_visible[(chr_font_page << 8) + chr];

                if(bg_rgba !== chr_bg_rgba)
                {
                    if(bg_rgba !== undefined)
                    {
                        // draw opaque block of background color into offscreen_context
                        offscreen_context.fillStyle = number_as_color(bg_rgba);
                        offscreen_context.fillRect(bg_x, row_y, col_x - bg_x, font_height);
                    }
                    bg_rgba = chr_bg_rgba;
                    bg_x = col_x;
                }

                if(fg_rgba !== chr_fg_rgba)
                {
                    if(fg_rgba !== undefined)
                    {
                        // draw opaque block of foreground color into extra row 1
                        offscreen_extra_context.fillStyle = number_as_color(fg_rgba);
                        offscreen_extra_context.fillRect(fg_x, row_extra_1_y, col_x - fg_x, font_height);
                    }
                    fg_rgba = chr_fg_rgba;
                    fg_x = col_x;
                }

                if(chr_visible)
                {
                    // copy transparent glyphs into extra row 2
                    offscreen_extra_context.drawImage(font_canvas,
                        chr * font_width, chr_font_page * font_height, font_width, font_height,
                        col_x, row_extra_2_y, font_width, font_height);
                }
            }

            // draw rightmost block of foreground color into extra row 1
            offscreen_extra_context.fillStyle = number_as_color(fg_rgba);
            offscreen_extra_context.fillRect(fg_x, row_extra_1_y, gfx_width - fg_x, font_height);

            // combine extra row 1 (colors) and 2 (glyphs) into extra row 1 (colored glyphs)
            offscreen_extra_context.globalCompositeOperation = "destination-in";
            offscreen_extra_context.drawImage(offscreen_extra_canvas,
                0, row_extra_2_y, gfx_width, font_height,
                0, row_extra_1_y, gfx_width, font_height);
            offscreen_extra_context.globalCompositeOperation = "source-over";

            // draw rightmost block of background color into offscreen_context
            offscreen_context.fillStyle = number_as_color(bg_rgba);
            offscreen_context.fillRect(bg_x, row_y, gfx_width - bg_x, font_height);

            // copy colored glyphs from extra row 1 into offscreen_context (on top of background colors)
            offscreen_context.drawImage(offscreen_extra_canvas,
                0, row_extra_1_y, gfx_width, font_height,
                0, row_y, gfx_width, font_height);
        }

        if(n_rows_rendered)
        {
            if(blink_visible && cursor_enabled && changed_rows[cursor_row])
            {
                const cursor_txt_i = (cursor_row * text_mode_width + cursor_col) * TEXT_BUF_COMPONENT_SIZE;
                const cursor_rgba = text_mode_data[cursor_txt_i + FG_COLOR_INDEX];
                offscreen_context.fillStyle = number_as_color(cursor_rgba);
                offscreen_context.fillRect(
                    cursor_col * font_width,
                    cursor_row * font_height + cursor_start,
                    font_width,
                    cursor_end - cursor_start + 1);
            }
            changed_rows.fill(0);
        }

        return n_rows_rendered;
    }

    function mark_blinking_rows_dirty()
    {
        const txt_row_size = text_mode_width * TEXT_BUF_COMPONENT_SIZE;
        for(let row_i = 0, txt_i = 0; row_i < text_mode_height; ++row_i)
        {
            if(changed_rows[row_i])
            {
                txt_i += txt_row_size;
                continue;
            }
            for(let col_i = 0; col_i < text_mode_width; ++col_i, txt_i += TEXT_BUF_COMPONENT_SIZE)
            {
                if(text_mode_data[txt_i + FLAGS_INDEX] & FLAG_BLINKING)
                {
                    changed_rows[row_i] = 1;
                    txt_i += txt_row_size - col_i * TEXT_BUF_COMPONENT_SIZE;
                    break;
                }
            }
        }
    }

    this.init = function()
    {
        // setup text mode cursor DOM element
        cursor_element.classList.add("cursor");
        cursor_element.style.position = "absolute";
        cursor_element.style.backgroundColor = "#ccc";
        cursor_element.style.width = "7px";
        cursor_element.style.display = "inline-block";

        // initialize display mode and size to 80x25 text with 9x16 font
        this.set_mode(false);
        this.set_size_text(80, 25);
        if(mode === MODE_GRAPHICAL_TEXT)
        {
            this.set_size_graphical(720, 400, 720, 400);
        }

        // initialize CSS scaling
        this.set_scale(scale_x, scale_y);

        this.timer();
    };

    this.make_screenshot = function()
    {
        const image = new Image();

        if(mode === MODE_GRAPHICAL || mode === MODE_GRAPHICAL_TEXT)
        {
            image.src = graphic_screen.toDataURL("image/png");
        }
        else
        {
            // Default 720x400, but can be [8, 16] at 640x400
            const char_size = [9, 16];

            const canvas = document.createElement("canvas");
            canvas.width = text_mode_width * char_size[0];
            canvas.height = text_mode_height * char_size[1];
            const context = canvas.getContext("2d");
            context.imageSmoothingEnabled = false;
            context.font = window.getComputedStyle(text_screen).font;
            context.textBaseline = "top";

            for(let y = 0; y < text_mode_height; y++)
            {
                for(let x = 0; x < text_mode_width; x++)
                {
                    const index = (y * text_mode_width + x) * TEXT_BUF_COMPONENT_SIZE;
                    const character = text_mode_data[index + CHARACTER_INDEX];
                    const bg_color = text_mode_data[index + BG_COLOR_INDEX];
                    const fg_color = text_mode_data[index + FG_COLOR_INDEX];

                    context.fillStyle = number_as_color(bg_color);
                    context.fillRect(x * char_size[0], y * char_size[1], char_size[0], char_size[1]);
                    context.fillStyle = number_as_color(fg_color);
                    context.fillText(charmap[character], x * char_size[0], y * char_size[1]);
                }
            }

            if(cursor_element.style.display !== "none" && cursor_row < text_mode_height && cursor_col < text_mode_width)
            {
                context.fillStyle = cursor_element.style.backgroundColor;
                context.fillRect(
                    cursor_col * char_size[0],
                    cursor_row * char_size[1] + parseInt(cursor_element.style.marginTop, 10),
                    parseInt(cursor_element.style.width, 10),
                    parseInt(cursor_element.style.height, 10)
                );
            }

            image.src = canvas.toDataURL("image/png");
        }
        return image;
    };

    this.put_char = function(row, col, chr, flags, bg_color, fg_color)
    {
        dbg_assert(row >= 0 && row < text_mode_height);
        dbg_assert(col >= 0 && col < text_mode_width);
        dbg_assert(chr >= 0 && chr < 0x100);

        const p = TEXT_BUF_COMPONENT_SIZE * (row * text_mode_width + col);

        text_mode_data[p + CHARACTER_INDEX] = chr;
        text_mode_data[p + FLAGS_INDEX] = flags;
        text_mode_data[p + BG_COLOR_INDEX] = bg_color;
        text_mode_data[p + FG_COLOR_INDEX] = fg_color;

        changed_rows[row] = 1;
    };

    this.timer = function()
    {
        timer_id = requestAnimationFrame(() => this.update_screen());
    };

    this.update_screen = function()
    {
        if(!paused)
        {
            if(mode === MODE_TEXT)
            {
                this.update_text();
            }
            else if(mode === MODE_GRAPHICAL)
            {
                this.update_graphical();
            }
            else
            {
                this.update_graphical_text();
            }
        }
        this.timer();
    };

    this.update_text = function()
    {
        for(var i = 0; i < text_mode_height; i++)
        {
            if(changed_rows[i])
            {
                this.text_update_row(i);
                changed_rows[i] = 0;
            }
        }
    };

    this.update_graphical = function()
    {
        this.screen_fill_buffer();
    };

    this.update_graphical_text = function()
    {
        if(offscreen_context)
        {
            // toggle cursor and blinking character visibility at a frequency of ~3.75hz
            const tm_now = performance.now();
            if(tm_now - tm_last_update > 266)
            {
                blink_visible = !blink_visible;
                if(cursor_enabled)
                {
                    changed_rows[cursor_row] = 1;
                }
                mark_blinking_rows_dirty();
                tm_last_update = tm_now;
            }
            // copy to DOM canvas only if anything new was rendered
            if(render_changed_rows())
            {
                graphic_context.drawImage(offscreen_context.canvas, 0, 0);
            }
        }
    };

    this.destroy = function()
    {
        if(timer_id)
        {
            cancelAnimationFrame(timer_id);
            timer_id = 0;
        }
    };

    this.pause = function()
    {
        paused = true;
        cursor_element.classList.remove("blinking-cursor");
    };

    this.continue = function()
    {
        paused = false;
        cursor_element.classList.add("blinking-cursor");
    };

    this.set_mode = function(graphical)
    {
        mode = graphical ? MODE_GRAPHICAL : (options.use_graphical_text ? MODE_GRAPHICAL_TEXT : MODE_TEXT);

        if(mode === MODE_TEXT)
        {
            text_screen.style.display = "block";
            graphic_screen.style.display = "none";
        }
        else
        {
            text_screen.style.display = "none";
            graphic_screen.style.display = "block";

            if(mode === MODE_GRAPHICAL_TEXT && changed_rows)
            {
                changed_rows.fill(1);
            }
        }
    };

    this.set_font_bitmap = function(height, width_9px, width_dbl, copy_8th_col, vga_bitmap, vga_bitmap_changed)
    {
        const width = width_dbl ? 16 : (width_9px ? 9 : 8);
        if(font_height !== height || font_width !== width || font_width_9px !== width_9px ||
            font_width_dbl !== width_dbl || font_copy_8th_col !== copy_8th_col ||
            vga_bitmap_changed)
        {
            const size_changed = font_width !== width || font_height !== height;
            font_height = height;
            font_width = width;
            font_width_9px = width_9px;
            font_width_dbl = width_dbl;
            font_copy_8th_col = copy_8th_col;
            if(mode === MODE_GRAPHICAL_TEXT)
            {
                render_font_bitmap(vga_bitmap);
                changed_rows.fill(1);
                if(size_changed)
                {
                    this.set_size_graphical_text();
                }
            }
        }
    };

    this.set_font_page = function(page_a, page_b)
    {
        if(font_page_a !== page_a || font_page_b !== page_b)
        {
            font_page_a = page_a;
            font_page_b = page_b;
            changed_rows.fill(1);
        }
    };

    this.clear_screen = function()
    {
        graphic_context.fillStyle = "#000";
        graphic_context.fillRect(0, 0, graphic_screen.width, graphic_screen.height);
    };

    this.set_size_graphical_text = function()
    {
        if(!font_context)
        {
            return;
        }

        const gfx_width = font_width * text_mode_width;
        const gfx_height = font_height * text_mode_height;
        const offscreen_extra_height = font_height * 2;

        if(!offscreen_context || offscreen_context.canvas.width !== gfx_width ||
            offscreen_context.canvas.height !== gfx_height ||
            offscreen_extra_context.canvas.height !== offscreen_extra_height)
        {
            // resize offscreen canvases
            if(!offscreen_context)
            {
                const offscreen_canvas = new OffscreenCanvas(gfx_width, gfx_height);
                offscreen_context = offscreen_canvas.getContext("2d", { alpha: false });
                const offscreen_extra_canvas = new OffscreenCanvas(gfx_width, offscreen_extra_height);
                offscreen_extra_context = offscreen_extra_canvas.getContext("2d");
            }
            else
            {
                offscreen_context.canvas.width = gfx_width;
                offscreen_context.canvas.height = gfx_height;
                offscreen_extra_context.canvas.width = gfx_width;
                offscreen_extra_context.canvas.height = offscreen_extra_height;
            }

            // resize DOM canvas graphic_screen
            this.set_size_graphical(gfx_width, gfx_height, gfx_width, gfx_height);

            changed_rows.fill(1);
        }
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

        changed_rows = new Int8Array(rows);
        text_mode_data = new Int32Array(cols * rows * TEXT_BUF_COMPONENT_SIZE);

        text_mode_width = cols;
        text_mode_height = rows;

        if(mode === MODE_TEXT)
        {
            while(text_screen.childNodes.length > rows)
            {
                text_screen.removeChild(text_screen.firstChild);
            }

            while(text_screen.childNodes.length < rows)
            {
                text_screen.appendChild(document.createElement("div"));
            }

            for(var i = 0; i < rows; i++)
            {
                this.text_update_row(i);
            }

            update_scale_text();
        }
        else if(mode === MODE_GRAPHICAL_TEXT)
        {
            this.set_size_graphical_text();
        }
    };

    this.set_size_graphical = function(width, height, buffer_width, buffer_height)
    {
        if(DEBUG_SCREEN_LAYERS)
        {
            // Draw the entire buffer. Useful for debugging
            // panning / page flipping / screen splitting code for both
            // v86 developers and os developers
            width = buffer_width;
            height = buffer_height;
        }

        graphic_screen.style.display = "block";

        graphic_screen.width = width;
        graphic_screen.height = height;

        // graphic_context must be reconfigured whenever its graphic_screen is resized
        graphic_context.imageSmoothingEnabled = false;

        // add some scaling to tiny resolutions
        if(width <= 640 &&
            width * 2 < window.innerWidth * window.devicePixelRatio &&
            height * 2 < window.innerHeight * window.devicePixelRatio)
        {
            base_scale = 2;
        }
        else
        {
            base_scale = 1;
        }

        update_scale_graphic();
    };

    this.set_scale = function(s_x, s_y)
    {
        scale_x = s_x;
        scale_y = s_y;

        update_scale_text();
        update_scale_graphic();
    };

    function update_scale_text()
    {
        elem_set_scale(text_screen, scale_x, scale_y, true);
    }

    function update_scale_graphic()
    {
        elem_set_scale(graphic_screen, scale_x * base_scale, scale_y * base_scale, false);
    }

    function elem_set_scale(elem, scale_x, scale_y, use_scale)
    {
        if(!scale_x || !scale_y)
        {
            return;
        }

        elem.style.width = "";
        elem.style.height = "";

        if(use_scale)
        {
            elem.style.transform = "";
        }

        var rectangle = elem.getBoundingClientRect();

        if(use_scale)
        {
            var scale_str = "";

            scale_str += scale_x === 1 ? "" : " scaleX(" + scale_x + ")";
            scale_str += scale_y === 1 ? "" : " scaleY(" + scale_y + ")";

            elem.style.transform = scale_str;
        }
        else
        {
            // unblur non-fractional scales
            if(scale_x % 1 === 0 && scale_y % 1 === 0)
            {
                graphic_screen.style["imageRendering"] = "crisp-edges"; // firefox
                graphic_screen.style["imageRendering"] = "pixelated";
                graphic_screen.style["-ms-interpolation-mode"] = "nearest-neighbor";
            }
            else
            {
                graphic_screen.style["imageRendering"] = "";
                graphic_screen.style["-ms-interpolation-mode"] = "";
            }

            // undo fractional css-to-device pixel ratios
            var device_pixel_ratio = window.devicePixelRatio || 1;
            if(device_pixel_ratio % 1 !== 0)
            {
                scale_x /= device_pixel_ratio;
                scale_y /= device_pixel_ratio;
            }
        }

        if(scale_x !== 1)
        {
            elem.style.width = rectangle.width * scale_x + "px";
        }
        if(scale_y !== 1)
        {
            elem.style.height = rectangle.height * scale_y + "px";
        }
    }

    this.update_cursor_scanline = function(start, end, enabled)
    {
        if(start !== cursor_start || end !== cursor_end || enabled !== cursor_enabled)
        {
            if(mode === MODE_TEXT)
            {
                if(enabled)
                {
                    cursor_element.style.display = "inline";
                    cursor_element.style.height = (end - start) + "px";
                    cursor_element.style.marginTop = start + "px";
                }
                else
                {
                    cursor_element.style.display = "none";
                }
            }
            else if(mode === MODE_GRAPHICAL_TEXT)
            {
                if(cursor_row < text_mode_height)
                {
                    changed_rows[cursor_row] = 1;
                }
            }

            cursor_start = start;
            cursor_end = end;
            cursor_enabled = enabled;
        }
    };

    this.update_cursor = function(row, col)
    {
        if(row !== cursor_row || col !== cursor_col)
        {
            if(row < text_mode_height)
            {
                changed_rows[row] = 1;
            }
            if(cursor_row < text_mode_height)
            {
                changed_rows[cursor_row] = 1;
            }

            cursor_row = row;
            cursor_col = col;
        }
    };

    this.text_update_row = function(row)
    {
        var offset = TEXT_BUF_COMPONENT_SIZE * row * text_mode_width,
            row_element,
            color_element,
            fragment;

        var blinking,
            bg_color,
            fg_color,
            text;

        row_element = text_screen.childNodes[row];
        fragment = document.createElement("div");

        for(var i = 0; i < text_mode_width; )
        {
            color_element = document.createElement("span");

            blinking = text_mode_data[offset + FLAGS_INDEX] & FLAG_BLINKING;
            bg_color = text_mode_data[offset + BG_COLOR_INDEX];
            fg_color = text_mode_data[offset + FG_COLOR_INDEX];

            if(blinking)
            {
                color_element.classList.add("blink");
            }

            color_element.style.backgroundColor = number_as_color(bg_color);
            color_element.style.color = number_as_color(fg_color);

            text = "";

            // put characters of the same color in one element
            while(i < text_mode_width &&
                (text_mode_data[offset + FLAGS_INDEX] & FLAG_BLINKING) === blinking &&
                text_mode_data[offset + BG_COLOR_INDEX] === bg_color &&
                text_mode_data[offset + FG_COLOR_INDEX] === fg_color)
            {
                const chr = charmap[text_mode_data[offset + CHARACTER_INDEX]];

                text += chr;
                dbg_assert(chr);

                i++;
                offset += TEXT_BUF_COMPONENT_SIZE;

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
                        cursor_element.style.backgroundColor = color_element.style.color;
                        fragment.appendChild(cursor_element);
                        break;
                    }
                }
            }

            color_element.textContent = text;
            fragment.appendChild(color_element);
        }

        row_element.parentNode.replaceChild(fragment, row_element);
    };

    this.update_buffer = function(layers)
    {
        if(DEBUG_SCREEN_LAYERS)
        {
            // For each visible layer that would've been drawn, draw a
            // rectangle to visualise the layer instead.
            graphic_context.strokeStyle = "#0F0";
            graphic_context.lineWidth = 4;
            for(const layer of layers)
            {
                graphic_context.strokeRect(
                    layer.buffer_x,
                    layer.buffer_y,
                    layer.buffer_width,
                    layer.buffer_height
                );
            }
            graphic_context.lineWidth = 1;
            return;
        }

        for(const layer of layers)
        {
            graphic_context.putImageData(
                layer.image_data,
                layer.screen_x - layer.buffer_x,
                layer.screen_y - layer.buffer_y,
                layer.buffer_x,
                layer.buffer_y,
                layer.buffer_width,
                layer.buffer_height
            );
        }
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
        let row = "";
        for(let i = begin; i < end; i += TEXT_BUF_COMPONENT_SIZE)
        {
            row += charmap[text_mode_data[i]];
        }
        return row;
    };

    this.init();
}
