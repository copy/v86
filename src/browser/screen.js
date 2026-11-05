import { dbg_assert } from "../log.js";
import { get_charmap } from "../lib.js";
import { DISPLAY_FLAG_BLINKING, DISPLAY_FLAG_FONT_PAGE_B } from "../display.js";

// For Types Only
import { DisplaySink } from "../display.js";

// Draws entire buffer and visualizes the layers that would be drawn
export const DEBUG_SCREEN_LAYERS = DEBUG && false;

/**
 * The default way to put pixels on the canvas: its 2D context. The other one is
 * a WebGPU compositor that also shows guest D3D/GL windows
 * (glbridge/webgpu_compositor.js); both have these methods, under quoted names
 * because the compositor is not compiled with this file.
 * @param {!HTMLCanvasElement} canvas
 * @return {!Object}
 */
function create_canvas2d_backend(canvas)
{
    const context = canvas.getContext("2d", { alpha: false });

    /** @type {ImageData} */
    let image_data = null;
    /** @type {Uint8ClampedArray} */
    let image_source = null;

    /**
     * ImageData over a pixel buffer, reused while the buffer is. ImageData
     * refuses shared memory (cores in host threads, src/parallel): then copy
     * the rows that are drawn.
     * @param {!Uint8ClampedArray} data
     * @param {number} stride
     * @param {number} rows
     * @param {number} first_row
     * @param {number} row_count
     * @return {!ImageData}
     */
    function image_data_for(data, stride, rows, first_row, row_count)
    {
        if(typeof SharedArrayBuffer !== "undefined" && data.buffer instanceof SharedArrayBuffer)
        {
            if(!image_data || image_source !== null || image_data.width !== stride || image_data.height !== rows)
            {
                image_data = new ImageData(stride, rows);
                image_source = null;
            }
            const first = Math.max(0, first_row) * stride * 4;
            const end = Math.min(rows, first_row + row_count) * stride * 4;
            if(first < end) image_data.data.set(data.subarray(first, end), first);
            return /** @type {!ImageData} */ (image_data);
        }
        if(image_source !== data)
        {
            image_data = new ImageData(data, stride, rows);
            image_source = data;
        }
        return /** @type {!ImageData} */ (image_data);
    }

    return {
        "context": context,
        "attach_presenter": presenter => {},
        "resize": (width, height) => {
            // reset whenever the canvas is resized
            context.imageSmoothingEnabled = false;
        },
        // like putImageData: (sx, sy, sw, sh) of a buffer `stride` pixels wide goes to (dx, dy)
        "put_pixels": (data, stride, rows, sx, sy, sw, sh, dx, dy) => {
            context.putImageData(image_data_for(data, stride, rows, sy, sh), dx - sx, dy - sy, sx, sy, sw, sh);
        },
        "clear": () => {
            context.fillStyle = "#000";
            context.fillRect(0, 0, canvas.width, canvas.height);
        },
        "present": () => {},
        "screenshot": () => canvas.toDataURL("image/png"),
    };
}

/**
 * Adapter to use visual screen in browsers (in contrast to node). Everything
 * is drawn on one canvas: text mode with the guest's own VGA font, graphics
 * modes from the device's pixels.
 * @constructor
 * @implements {DisplaySink}
 * @param {Object} options
 * @param {function(boolean)} screen_fill_buffer asks the device for a new picture,
 *        with every pixel when the argument is true
 */
export function ScreenAdapter(options, screen_fill_buffer)
{
    const screen_container = options.container;
    this.screen_fill_buffer = screen_fill_buffer;

    console.assert(screen_container, "options.container must be provided");

    const MODE_GRAPHICAL = 1;
    const MODE_GRAPHICAL_TEXT = 2;

    const CHARACTER_INDEX = 0;
    const FLAGS_INDEX = 1;
    const BG_COLOR_INDEX = 2;
    const FG_COLOR_INDEX = 3;
    const TEXT_BUF_COMPONENT_SIZE = 4;

    const FLAG_BLINKING = DISPLAY_FLAG_BLINKING;
    const FLAG_FONT_PAGE_B = DISPLAY_FLAG_FONT_PAGE_B;

    // Pages written for the old two-canvas graphics proxy tag its overlay
    // canvas data-v86-graphics; the screen is the other one.
    let graphic_screen = options.canvas || Array.from(screen_container.getElementsByTagName("canvas"))
        .find(canvas => !canvas.hasAttribute("data-v86-graphics"));
    if(!graphic_screen)
    {
        graphic_screen = document.createElement("canvas");
        screen_container.appendChild(graphic_screen);
    }
    // Where the pixels go (create_canvas2d_backend). With options.deferred_backend
    // the canvas is left alone until set_backend or use_canvas2d chooses.
    /** @type {Object} */
    let backend = null;
    let full_frame_wanted = false;
    this.get_graphics_canvas = () => graphic_screen;
    this.is_graphical = () => mode === MODE_GRAPHICAL;
    this.on_geometry_change = null;
    const notify_geometry = () => this.on_geometry_change && this.on_geometry_change();

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

        // current display mode: MODE_GRAPHICAL or MODE_GRAPHICAL_TEXT
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

        // the text screen's pixels, drawn from the guest's font
        /** @type {ImageData} */
        text_image = null,
        /** @type {Uint32Array} */
        text_pixels = null,

        // fonts: a copy of VGA plane 2, 8 pages of 256 glyphs of 32 bytes
        /** @type {Uint8Array} */
        font_bitmap = null,
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

    /**
     * @param {number} color 0xRRGGBB
     * @return {number} the same colour as an RGBA ImageData pixel, read as one little-endian word
     */
    function to_pixel(color)
    {
        return 0xFF000000 | (color & 0xFF) << 16 | color & 0xFF00 | color >> 16 & 0xFF;
    }

    /**
     * Draw one text row into text_pixels, in plain JS: the result is exact and
     * does not depend on how the browser composites canvases.
     * @param {number} row
     */
    function render_row(row)
    {
        const width = text_image.width;
        const row_start = row * font_height * width;
        for(let col = 0, txt_i = row * text_mode_width * TEXT_BUF_COMPONENT_SIZE; col < text_mode_width; col++, txt_i += TEXT_BUF_COMPONENT_SIZE)
        {
            const chr = text_mode_data[txt_i + CHARACTER_INDEX];
            const flags = text_mode_data[txt_i + FLAGS_INDEX];
            const bg = to_pixel(text_mode_data[txt_i + BG_COLOR_INDEX]);
            const fg = to_pixel(text_mode_data[txt_i + FG_COLOR_INDEX]);
            const page = flags & FLAG_FONT_PAGE_B ? font_page_b : font_page_a;
            const visible = !(flags & FLAG_BLINKING) || blink_visible;
            const glyph = (page << 13) + chr * 32;
            // line graphics characters extend into the 9th column
            const ninth = font_width_9px && font_copy_8th_col && chr >= 0xC0 && chr <= 0xDF;

            for(let y = 0, p = row_start + col * font_width; y < font_height; y++, p += width)
            {
                const bits = visible ? font_bitmap[glyph + y] : 0;
                if(font_width_dbl)
                {
                    for(let x = 0; x < 8; x++)
                    {
                        const color = bits & 0x80 >> x ? fg : bg;
                        text_pixels[p + 2 * x] = color;
                        text_pixels[p + 2 * x + 1] = color;
                    }
                }
                else
                {
                    for(let x = 0; x < 8; x++)
                    {
                        text_pixels[p + x] = bits & 0x80 >> x ? fg : bg;
                    }
                    if(font_width_9px)
                    {
                        text_pixels[p + 8] = ninth && bits & 1 ? fg : bg;
                    }
                }
            }
        }

        if(row === cursor_row && cursor_enabled && blink_visible && cursor_col < text_mode_width)
        {
            const fg = to_pixel(text_mode_data[(row * text_mode_width + cursor_col) * TEXT_BUF_COMPONENT_SIZE + FG_COLOR_INDEX]);
            const last = Math.min(cursor_end, font_height - 1);
            for(let y = cursor_start, p = row_start + cursor_start * width + cursor_col * font_width; y <= last; y++, p += width)
            {
                text_pixels.fill(fg, p, p + font_width);
            }
        }
    }

    /**
     * @return {number} rows drawn
     */
    function render_changed_rows()
    {
        if(!text_image || !font_bitmap || !backend)
        {
            return 0;
        }

        let n_rows_rendered = 0;
        for(let row = 0; row < text_mode_height; row++)
        {
            if(changed_rows[row])
            {
                render_row(row);
                const y = row * font_height;
                backend["put_pixels"](text_image.data, text_image.width, text_image.height,
                    0, y, text_image.width, font_height, 0, y);
                n_rows_rendered++;
            }
        }
        changed_rows.fill(0);

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
        // initialize display mode and size to 80x25 text with 9x16 font
        this.set_mode(false);
        this.set_size_text(80, 25);
        resize_canvas(720, 400);

        // initialize CSS scaling
        this.set_scale(scale_x, scale_y);

        this.timer();
    };

    this.make_screenshot = function()
    {
        const image = new Image();
        image.src = backend ? backend["screenshot"]() : graphic_screen.toDataURL("image/png");
        return image;
    };

    /**
     * Draw through `new_backend` from now on (create_canvas2d_backend lists
     * its methods)
     * @param {!Object} new_backend
     */
    this.set_backend = function(new_backend)
    {
        backend = new_backend;
        backend["attach_presenter"]({ "invalidate": () => this.invalidate() });
        backend["resize"](graphic_screen.width, graphic_screen.height);
        this.invalidate();
    };

    /**
     * A canvas keeps the first kind of context it hands out (2D or WebGPU):
     * put a fresh copy of it where it was
     */
    const replace_canvas = () =>
    {
        const fresh = /** @type {!HTMLCanvasElement} */ (graphic_screen.cloneNode(false));
        if(graphic_screen.parentNode)
        {
            graphic_screen.parentNode.replaceChild(fresh, graphic_screen);
        }
        graphic_screen = fresh;
    };

    /**
     * The canvas, able to give out a context of `type` ("2d" or "webgpu").
     * If it already went to the other kind -- another emulator in this
     * container drew on it, or WebGPU took it and then failed to start -- it
     * is replaced by a fresh copy.
     * @param {string} type
     * @return {!HTMLCanvasElement}
     */
    this.claim_canvas = function(type)
    {
        if(type === "webgpu" && !(typeof navigator !== "undefined" && navigator["gpu"]))
        {
            return graphic_screen;
        }
        if(!graphic_screen.getContext(type, type === "2d" ? { alpha: false } : undefined))
        {
            replace_canvas();
        }
        return graphic_screen;
    };

    this.use_canvas2d = function()
    {
        this.set_backend(create_canvas2d_backend(this.claim_canvas("2d")));
    };

    /** Everything on the screen has to be drawn again */
    this.invalidate = function()
    {
        if(changed_rows)
        {
            changed_rows.fill(1);
        }
        full_frame_wanted = true;
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
            if(mode === MODE_GRAPHICAL)
            {
                this.update_graphical();
            }
            else
            {
                this.update_graphical_text();
            }
            if(backend)
            {
                backend["present"]();
            }
        }
        this.timer();
    };

    this.update_graphical = function()
    {
        if(backend)
        {
            const full = full_frame_wanted;
            full_frame_wanted = false;
            this.screen_fill_buffer(full);
        }
    };

    this.update_graphical_text = function()
    {
        if(text_image)
        {
            // toggle cursor and blinking character visibility at a frequency of ~3.75hz
            const tm_now = performance.now();
            if(tm_now - tm_last_update > 266)
            {
                blink_visible = !blink_visible;
                if(cursor_enabled && cursor_row < text_mode_height)
                {
                    changed_rows[cursor_row] = 1;
                }
                mark_blinking_rows_dirty();
                tm_last_update = tm_now;
            }
            render_changed_rows();
        }
    };

    this.destroy = function()
    {
        this.on_geometry_change = null;
        if(timer_id)
        {
            cancelAnimationFrame(timer_id);
            timer_id = 0;
        }
    };

    this.pause = function()
    {
        paused = true;
    };

    this.continue = function()
    {
        paused = false;
    };

    /**
     * Invalidates text rendering state.  This means the next set of
     * calls to set_font_bitmap, set_size_text, etc will be working
     * from a fresh slate even if the dimensions of the loaded state
     * differ from the current dimensions.
     */
    this.clear_text_state = function() {
        font_width = null;
        font_height = null;
        text_mode_width = null;
        text_mode_height = null;
        font_page_a = null;
        font_page_b = null;
    };

    /**
     * Entering a graphics mode leaves the picture undefined until the device
     * sends the size and the pixels, which it always does next.
     */
    this.set_mode = function(graphical)
    {
        mode = graphical ? MODE_GRAPHICAL : MODE_GRAPHICAL_TEXT;

        if(mode === MODE_GRAPHICAL_TEXT)
        {
            // The canvas may still have the size of the graphics mode that just ended
            if(text_image)
            {
                resize_canvas(text_image.width, text_image.height);
            }
            if(changed_rows)
            {
                changed_rows.fill(1);
            }
        }
        notify_geometry();
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
            // plane 2 changes under us; the picture changes when the device says so
            font_bitmap = vga_bitmap.slice();
            changed_rows.fill(1);
            if(size_changed || !text_image)
            {
                this.set_size_graphical_text();
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
        if(backend)
        {
            backend["clear"]();
        }
    };

    this.set_size_graphical_text = function()
    {
        if(!font_bitmap || !font_width || !text_mode_width)
        {
            return;
        }

        const gfx_width = font_width * text_mode_width;
        const gfx_height = font_height * text_mode_height;

        if(!text_image || text_image.width !== gfx_width || text_image.height !== gfx_height)
        {
            text_image = new ImageData(gfx_width, gfx_height);
            text_pixels = new Uint32Array(text_image.data.buffer);

            if(mode === MODE_GRAPHICAL_TEXT)
            {
                resize_canvas(gfx_width, gfx_height);
            }

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
        changed_rows.fill(1);
        text_mode_data = new Int32Array(cols * rows * TEXT_BUF_COMPONENT_SIZE);

        text_mode_width = cols;
        text_mode_height = rows;

        this.set_size_graphical_text();
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

        resize_canvas(width, height);
    };

    /**
     * @param {number} width
     * @param {number} height
     */
    function resize_canvas(width, height)
    {
        if(graphic_screen.width === width && graphic_screen.height === height && graphic_screen.style.display === "block")
        {
            return;
        }

        graphic_screen.style.display = "block";

        graphic_screen.width = width;
        graphic_screen.height = height;

        if(backend)
        {
            backend["resize"](width, height);
        }

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
        notify_geometry();
    }

    this.set_scale = function(s_x, s_y)
    {
        scale_x = s_x;
        scale_y = s_y;

        update_scale_graphic();
        notify_geometry();
    };

    function update_scale_graphic()
    {
        let s_x = scale_x * base_scale;
        let s_y = scale_y * base_scale;
        if(!s_x || !s_y)
        {
            return;
        }

        graphic_screen.style.width = "";
        graphic_screen.style.height = "";

        // Measure the canvas before any ancestor transform. The iPhone
        // console rotates its parent, which swaps the bounding rectangle.
        const width = graphic_screen.offsetWidth;
        const height = graphic_screen.offsetHeight;

        // unblur non-fractional scales
        if(s_x % 1 === 0 && s_y % 1 === 0)
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
        const device_pixel_ratio = window.devicePixelRatio || 1;
        if(device_pixel_ratio % 1 !== 0)
        {
            s_x /= device_pixel_ratio;
            s_y /= device_pixel_ratio;
        }

        if(s_x !== 1)
        {
            graphic_screen.style.width = width * s_x + "px";
        }
        if(s_y !== 1)
        {
            graphic_screen.style.height = height * s_y + "px";
        }
    }

    this.update_cursor_scanline = function(start, end, enabled)
    {
        if(start !== cursor_start || end !== cursor_end || enabled !== cursor_enabled)
        {
            if(cursor_row < text_mode_height)
            {
                changed_rows[cursor_row] = 1;
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

    this.update_buffer = function(layers)
    {
        if(!backend)
        {
            return;
        }

        const debug_context = backend["context"];
        if(DEBUG_SCREEN_LAYERS && debug_context)
        {
            // For each visible layer that would've been drawn, draw a
            // rectangle to visualise the layer instead.
            debug_context.strokeStyle = "#0F0";
            debug_context.lineWidth = 4;
            for(const layer of layers)
            {
                debug_context.strokeRect(
                    layer.buffer_x,
                    layer.buffer_y,
                    layer.buffer_width,
                    layer.buffer_height
                );
            }
            debug_context.lineWidth = 1;
            return;
        }

        for(const layer of layers)
        {
            const pixels = layer.pixels;
            backend["put_pixels"](pixels.data, pixels.width, pixels.height,
                layer.buffer_x, layer.buffer_y, layer.buffer_width, layer.buffer_height,
                layer.screen_x, layer.screen_y);
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
        if(!(y >= 0 && y < text_mode_height))
        {
            return "";
        }
        const begin = y * text_mode_width * TEXT_BUF_COMPONENT_SIZE + CHARACTER_INDEX;
        const end = begin + text_mode_width * TEXT_BUF_COMPONENT_SIZE;
        let row = "";
        for(let i = begin; i < end; i += TEXT_BUF_COMPONENT_SIZE)
        {
            row += charmap[text_mode_data[i]];
        }
        return row;
    };

    if(!options.deferred_backend)
    {
        this.use_canvas2d();
    }
    this.init();
}
