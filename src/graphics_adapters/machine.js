// The display adapter's view of the machine (plugin side). The machine
// handle's common part (ports, memory maps, PCI, guest memory, the clock) is
// src/device_machine.js; this adds device memory (mmio_ram), virtio-vga and
// the display hub, and converts display layers between plugin names and
// quoted names. v86's side is src/graphics_adapter.js.
// See docs/gpu-devices.md, "Adapter plugins".

import { DeviceMachine, register_device_plugin } from "../device_machine.js";

/**
 * Make a display adapter known to v86. Plugin files call this when they load.
 * @param {!Object} descriptor { "name", "pci_vendor", "pci_device", "create" }
 */
export function register_graphics_adapter(descriptor)
{
    register_device_plugin("V86GraphicsAdapters", descriptor);
}

/**
 * What a display device drives on the presenter side (DisplayHub)
 * @constructor
 * @param {!Object} handle the quoted display handle
 */
function GraphicsDisplay(handle)
{
    this.handle = handle;
}

/** @param {boolean} graphical */
GraphicsDisplay.prototype.set_mode = function(graphical)
{
    this.handle["set_mode"](graphical);
};

/**
 * @param {number} cols
 * @param {number} rows
 */
GraphicsDisplay.prototype.set_size_text = function(cols, rows)
{
    this.handle["set_size_text"](cols, rows);
};

/**
 * @param {number} width
 * @param {number} height
 * @param {number} buffer_width
 * @param {number} buffer_height
 * @param {number} bpp
 */
GraphicsDisplay.prototype.set_size_graphical = function(width, height, buffer_width, buffer_height, bpp)
{
    this.handle["set_size_graphical"](width, height, buffer_width, buffer_height, bpp);
};

/**
 * @param {number} row
 * @param {number} col
 * @param {number} chr
 * @param {number} flags
 * @param {number} bg_color
 * @param {number} fg_color
 */
GraphicsDisplay.prototype.put_char = function(row, col, chr, flags, bg_color, fg_color)
{
    this.handle["put_char"](row, col, chr, flags, bg_color, fg_color);
};

/**
 * @param {number} row
 * @param {number} col
 */
GraphicsDisplay.prototype.update_cursor = function(row, col)
{
    this.handle["update_cursor"](row, col);
};

/**
 * @param {number} start
 * @param {number} end
 * @param {boolean} enabled
 */
GraphicsDisplay.prototype.update_cursor_scanline = function(start, end, enabled)
{
    this.handle["update_cursor_scanline"](start, end, enabled);
};

/**
 * @param {number} height
 * @param {boolean} width_9px
 * @param {boolean} width_dbl
 * @param {boolean} copy_8th_col
 * @param {Uint8Array} bitmap
 * @param {boolean} bitmap_changed
 */
GraphicsDisplay.prototype.set_font_bitmap = function(height, width_9px, width_dbl, copy_8th_col, bitmap, bitmap_changed)
{
    this.handle["set_font_bitmap"](height, width_9px, width_dbl, copy_8th_col, bitmap, bitmap_changed);
};

/**
 * @param {number} page_a
 * @param {number} page_b
 */
GraphicsDisplay.prototype.set_font_page = function(page_a, page_b)
{
    this.handle["set_font_page"](page_a, page_b);
};

GraphicsDisplay.prototype.clear_screen = function()
{
    this.handle["clear_screen"]();
};

GraphicsDisplay.prototype.clear_text_state = function()
{
    this.handle["clear_text_state"]();
};

/**
 * Each layer is { pixels: { data, width, height }, screen_x, screen_y,
 * buffer_x, buffer_y, buffer_width, buffer_height }, as DisplaySink takes it
 * @param {!Array<!Object>} layers
 */
GraphicsDisplay.prototype.update_buffer = function(layers)
{
    this.handle["update_buffer"](layers.map(layer => ({
        "pixels": {
            "data": layer.pixels.data,
            "width": layer.pixels.width,
            "height": layer.pixels.height,
        },
        "screen_x": layer.screen_x,
        "screen_y": layer.screen_y,
        "buffer_x": layer.buffer_x,
        "buffer_y": layer.buffer_y,
        "buffer_width": layer.buffer_width,
        "buffer_height": layer.buffer_height,
    })));
};

/**
 * @param {number} now
 * @return {number}
 */
GraphicsDisplay.prototype.time_since_vblank = function(now)
{
    return this.handle["time_since_vblank"](now);
};

/**
 * Called whenever the machine's timers run (each slice of the CPU's): a
 * device's own polling. Returns milliseconds until it needs to run again.
 * @param {function(number):number} timer
 */
GraphicsDisplay.prototype.add_timer = function(timer)
{
    this.handle["add_timer"](timer);
};

/**
 * A device with a scanout: { vblank_period(), on_vblank(), render(), invalidate() }
 * @param {!Object} source
 */
GraphicsDisplay.prototype.add_source = function(source)
{
    this.handle["add_source"]({
        "vblank_period": () => source.vblank_period(),
        "on_vblank": () => source.on_vblank(),
        "render": () => source.render(),
        "invalidate": () => source.invalidate(),
    });
};

/**
 * @constructor
 * @extends {DeviceMachine}
 * @param {!Object} handle the quoted machine handle from src/graphics_adapter.js
 */
export function GraphicsMachine(handle)
{
    DeviceMachine.call(this, handle);

    /** @const @type {boolean} whether the machine has a VGA (not the virt machine: no legacy VGA, ROM or ports) */
    this.has_vga = handle["has_vga"] !== false;

    /** @const */
    this.display = new GraphicsDisplay(handle["display"]);
}
GraphicsMachine.prototype = Object.create(DeviceMachine.prototype);
GraphicsMachine.prototype.constructor = GraphicsMachine;

/**
 * Device memory (src/rust/cpu/mmio_ram.rs)
 * @param {number} size
 * @return {number} the region, or -1
 */
GraphicsMachine.prototype.mmio_ram_allocate = function(size)
{
    return this.handle["mmio_ram_allocate"](size);
};

/**
 * @param {number} region
 * @return {number} the offset of its memory in wasm memory
 */
GraphicsMachine.prototype.mmio_ram_backing = function(region)
{
    return this.handle["mmio_ram_backing"](region);
};

/**
 * @param {number} region
 * @param {number} address
 */
GraphicsMachine.prototype.mmio_ram_map = function(region, address)
{
    this.handle["mmio_ram_map"](region, address);
};

/**
 * @param {number} region
 * @param {number} offset
 * @return {number}
 */
GraphicsMachine.prototype.mmio_ram_read8 = function(region, offset)
{
    return this.handle["mmio_ram_read8"](region, offset);
};

/**
 * @param {number} region
 * @param {number} offset
 * @param {number} value
 */
GraphicsMachine.prototype.mmio_ram_write8 = function(region, offset, value)
{
    this.handle["mmio_ram_write8"](region, offset, value);
};

/** @param {number} region */
GraphicsMachine.prototype.mmio_ram_mark_dirty = function(region)
{
    this.handle["mmio_ram_mark_dirty"](region);
};

/**
 * Take the region's bitmap of written pages (a bit a page, 64 a word)
 * @param {number} region
 * @return {number} the offset of the words in wasm memory (0: none)
 */
GraphicsMachine.prototype.mmio_ram_take_dirty = function(region)
{
    return this.handle["mmio_ram_take_dirty"](region);
};

/** @param {number} region */
GraphicsMachine.prototype.mmio_ram_unmap = function(region)
{
    this.handle["mmio_ram_unmap"](region);
};

/**
 * @param {number} region
 * @param {number} pixels
 * @return {number} the offset of the RGBA picture in wasm memory
 */
GraphicsMachine.prototype.mmio_ram_allocate_pixels = function(region, pixels)
{
    return this.handle["mmio_ram_allocate_pixels"](region, pixels);
};

/**
 * Convert the region's dirty pages into its RGBA picture
 * @param {number} region
 * @param {number} bpp
 * @param {number} offset
 */
GraphicsMachine.prototype.mmio_ram_fill_pixels = function(region, bpp, offset)
{
    this.handle["mmio_ram_fill_pixels"](region, bpp, offset);
};

/**
 * The byte range the last mmio_ram_fill_pixels converted
 * @return {number}
 */
GraphicsMachine.prototype.dirty_min_offset = function()
{
    return this.handle["dirty_min_offset"]();
};

/** @return {number} */
GraphicsMachine.prototype.dirty_max_offset = function()
{
    return this.handle["dirty_max_offset"]();
};

/**
 * Make the device's PCI function a virtio device (virtio-vga), in place of
 * register_pci. The descriptor uses quoted names, as for the virtio_devices
 * option, with "class_code", "revision", "bars" and "capability_bar"
 * (src/virtio_devices.js, create_adapter_virtio_device).
 * @param {!Object} descriptor
 * @return {!Object} the quoted handle: has_request, pop_request, request_at, flush,
 *     read_memory, write_memory, config_changed, transport, set_transport, reset, ...
 */
GraphicsMachine.prototype.create_virtio = function(descriptor)
{
    return this.handle["create_virtio"](descriptor);
};

/**
 * The size the page would like a display to have (V86.set_display_size)
 * @param {function(number, number, number)} handler width, height, display
 */
GraphicsMachine.prototype.on_host_display_size = function(handler)
{
    this.handle["on_host_display_size"](handler);
};

/** @return {boolean} whether the CPU runs a virtual 8086 task (Win9x DOS boxes) */
GraphicsMachine.prototype.in_vm86 = function()
{
    return this.handle["in_vm86"]();
};
