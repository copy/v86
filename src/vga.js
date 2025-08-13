import { LOG_VGA } from "./const.js";
import { h } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";
import { ScreenAdapter } from "./browser/screen.js";
import { BusConnector } from "./bus.js";
import { DummyScreenAdapter } from "./browser/dummy_screen.js";
import { round_up_to_next_power_of_2, view } from "./lib.js";

// Always 64k
const VGA_BANK_SIZE = 64 * 1024;

const MAX_XRES = 2560;
const MAX_YRES = 1600;
const MAX_BPP = 32;

//const VGA_LFB_ADDRESS = 0xFE000000; // set by seabios
const VGA_LFB_ADDRESS = 0xE0000000;

/**
 * Equals the maximum number of pixels for non svga.
 * 8 pixels per byte.
 */
const VGA_PIXEL_BUFFER_SIZE = 8 * VGA_BANK_SIZE;

const VGA_MIN_MEMORY_SIZE = 4 * VGA_BANK_SIZE;

/**
 * Avoid wrapping past VGA_LFB_ADDRESS
 */
const VGA_MAX_MEMORY_SIZE = 256 * 1024 * 1024;

/**
 * @see {@link http://www.osdever.net/FreeVGA/vga/graphreg.htm#06}
 */
const VGA_HOST_MEMORY_SPACE_START = Uint32Array.from([
    0xA0000,
    0xA0000,
    0xB0000,
    0xB8000,
]);

/**
 * @see {@link http://www.osdever.net/FreeVGA/vga/graphreg.htm#06}
 */
const VGA_HOST_MEMORY_SPACE_SIZE = Uint32Array.from([
    0x20000, // 128K
    0x10000, // 64K
    0x8000, // 32K
    0x8000, // 32K
]);

/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 * @param {ScreenAdapter|DummyScreenAdapter} screen
 * @param {number} vga_memory_size
 */
export function VGAScreen(cpu, bus, screen, vga_memory_size)
{
    this.cpu = cpu;

    /** @const */
    this.bus = bus;

    /** @const */
    this.screen = screen;

    this.vga_memory_size = vga_memory_size;

    /** @type {number} */
    this.cursor_address = 0;

    /** @type {number} */
    this.cursor_scanline_start = 0xE;

    /** @type {number} */
    this.cursor_scanline_end = 0xF;

    /**
     * Number of columns in text mode
     * @type {number}
     */
    this.max_cols = 80;

    /**
     * Number of rows in text mode
     * @type {number}
     */
    this.max_rows = 25;

    /**
     * Width in pixels in graphical mode
     * @type {number}
     */
    this.screen_width = 0;

    /**
     * Height in pixels in graphical mode
     * @type {number}
     */
    this.screen_height = 0;

    /**
     * Logical width in pixels of virtual buffer available for panning
     * @type {number}
     */
    this.virtual_width = 0;

    /**
     * Logical height in pixels of virtual buffer available for panning
     * @type {number}
     */
    this.virtual_height = 0;

    /**
     * The rectangular fragments of the image buffer, and their destination
     * locations, to be drawn every screen_fill_buffer during VGA modes.
     * @type {Array<Object<string, number>>}
     */
    this.layers = [];

    /**
     * video memory start address
     * @type {number}
     */
    this.start_address = 0;

    /**
     * Start address - a copy of start_address that only gets updated
     * during VSync, used for panning and page flipping
     * @type {number}
     */
    this.start_address_latched = 0;

    /**
     * Unimplemented CRTC registers go here
     */
    this.crtc = new Uint8Array(0x19);

    // Implemented CRTC registers:

    /** @type {number} */
    this.crtc_mode = 0;

    /** @type {number} */
    this.horizontal_display_enable_end = 0;

    /** @type {number} */
    this.horizontal_blank_start = 0;

    /** @type {number} */
    this.vertical_display_enable_end = 0;

    /** @type {number} */
    this.vertical_blank_start = 0;

    /** @type {number} */
    this.underline_location_register = 0;

    /** @type {number} */
    this.preset_row_scan = 0;

    /** @type {number} */
    this.offset_register = 0;

    /** @type {number} */
    this.line_compare = 0;

    // End of CRTC registers

    /** @type {boolean} */
    this.graphical_mode = false;

    /*
     * VGA palette containing 256 colors for video mode 13, svga 8bpp, etc.
     * Needs to be initialised by the BIOS
     */
    this.vga256_palette = new Int32Array(256);

    /**
     * VGA read latches
     * @type{number}
     */
    this.latch_dword = 0;

    /** @type {number} */
    this.svga_version = 0xB0C5;

    /** @type {number} */
    this.svga_width = 0;

    /** @type {number} */
    this.svga_height = 0;

    this.svga_enabled = false;

    /** @type {number} */
    this.svga_bpp = 32;

    /** @type {number} */
    this.svga_bank_offset = 0;

    /**
     * The video buffer offset created by VBE_DISPI_INDEX_Y_OFFSET
     * In bytes
     * @type {number}
     */
    this.svga_offset = 0;
    this.svga_offset_x = 0;
    this.svga_offset_y = 0;

    if(this.vga_memory_size === undefined || this.vga_memory_size < VGA_MIN_MEMORY_SIZE)
    {
        this.vga_memory_size = VGA_MIN_MEMORY_SIZE;
    }
    else if(this.vga_memory_size > VGA_MAX_MEMORY_SIZE)
    {
        this.vga_memory_size = VGA_MAX_MEMORY_SIZE;
    }
    else
    {
        // required for pci code
        this.vga_memory_size = round_up_to_next_power_of_2(this.vga_memory_size);
    }
    dbg_log("effective vga memory size: " + this.vga_memory_size, LOG_VGA);

    const pci_revision = 0; // set to 2 for qemu extended registers

    // Experimental, could probably need some changes
    // 01:00.0 VGA compatible controller: NVIDIA Corporation GT216 [GeForce GT 220] (rev a2)
    this.pci_space = [
        0x34, 0x12, 0x11, 0x11, 0x03, 0x01, 0x00, 0x00, pci_revision, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00,
        0x08, VGA_LFB_ADDRESS >>> 8, VGA_LFB_ADDRESS >>> 16, VGA_LFB_ADDRESS >>> 24,
                                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xbf, 0xfe, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf4, 0x1a, 0x00, 0x11,
        0x00, 0x00, 0xbe, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];
    this.pci_id = 0x12 << 3;
    this.pci_bars = [
        {
            size: this.vga_memory_size,
        },
    ];

    // TODO: Should be matched with vga bios size and mapping address
    // Seabios config for this device:
    // CONFIG_VGA_PCI=y
    // CONFIG_OVERRIDE_PCI_ID=y
    // CONFIG_VGA_VID=0x10de
    // CONFIG_VGA_DID=0x0a20

    this.pci_rom_size = 0x10000;
    this.pci_rom_address = 0xFEB00000;

    this.name = "vga";

    this.index_crtc = 0;

    // index for setting colors through port 3C9h
    this.dac_color_index_write = 0;
    this.dac_color_index_read = 0;
    this.dac_state = 0;

    this.dac_mask = 0xFF;

    this.dac_map = new Uint8Array(0x10);

    this.attribute_controller_index = -1;
    this.palette_source = 0x20;
    this.attribute_mode = 0;
    this.color_plane_enable = 0;
    this.horizontal_panning = 0;
    this.color_select = 0;

    this.sequencer_index = -1;

    // bitmap of planes 0-3
    this.plane_write_bm = 0xF;
    this.sequencer_memory_mode = 0;
    this.clocking_mode = 0;
    this.graphics_index = -1;
    this.character_map_select = 0;

    this.plane_read = 0; // value 0-3, which plane to read
    this.planar_mode = 0;
    this.planar_rotate_reg = 0;
    this.planar_bitmap = 0xFF;
    this.planar_setreset = 0;
    this.planar_setreset_enable = 0;
    this.miscellaneous_graphics_register = 0;

    this.color_compare = 0;
    this.color_dont_care = 0;

    this.max_scan_line = 0;

    this.miscellaneous_output_register = 0xff;
    this.port_3DA_value = 0xFF;

    this.font_page_ab_enabled = false;

    var io = cpu.io;

    io.register_write(0x3C0, this, this.port3C0_write);
    io.register_read(0x3C0, this, this.port3C0_read, this.port3C0_read16);

    io.register_read(0x3C1, this, this.port3C1_read);
    io.register_write(0x3C2, this, this.port3C2_write);

    io.register_write_consecutive(0x3C4, this, this.port3C4_write, this.port3C5_write);

    io.register_read(0x3C4, this, this.port3C4_read);
    io.register_read(0x3C5, this, this.port3C5_read);

    io.register_write_consecutive(0x3CE, this, this.port3CE_write, this.port3CF_write);

    io.register_read(0x3CE, this, this.port3CE_read);
    io.register_read(0x3CF, this, this.port3CF_read);

    io.register_read(0x3C6, this, this.port3C6_read);
    io.register_write(0x3C6, this, this.port3C6_write);
    io.register_write(0x3C7, this, this.port3C7_write);
    io.register_read(0x3C7, this, this.port3C7_read);
    io.register_write(0x3C8, this, this.port3C8_write);
    io.register_read(0x3C8, this, this.port3C8_read);
    io.register_write(0x3C9, this, this.port3C9_write);
    io.register_read(0x3C9, this, this.port3C9_read);

    io.register_read(0x3CC, this, this.port3CC_read);

    io.register_write(0x3D4, this, this.port3D4_write, this.port3D4_write16);
    io.register_write(0x3D5, this, this.port3D5_write, this.port3D5_write16);

    io.register_read(0x3D4, this, this.port3D4_read);
    io.register_read(0x3D5, this, this.port3D5_read, this.port3D5_read16);

    // use same handlers for monochrome text-mode's alternate port addresses 0x3B4/0x3B5 as for the regular addresses (0x3D4/0x3D5)
    io.register_write(0x3B4, this, this.port3D4_write, this.port3D4_write16);
    io.register_write(0x3B5, this, this.port3D5_write, this.port3D5_write16);

    io.register_read(0x3B4, this, this.port3D4_read);
    io.register_read(0x3B5, this, this.port3D5_read, this.port3D5_read16);

    io.register_read(0x3CA, this, function() { dbg_log("3CA read", LOG_VGA); return 0; });

    // use same handler for monochrome text-mode's alternate port address 0x3BA as for its regular address (0x3DA)
    io.register_read(0x3DA, this, this.port3DA_read);
    io.register_read(0x3BA, this, this.port3DA_read);


    // Bochs VBE Extensions
    // http://wiki.osdev.org/Bochs_VBE_Extensions
    this.dispi_index = -1;
    this.dispi_enable_value = 0;

    io.register_write(0x1CE, this, undefined, this.port1CE_write);

    io.register_write(0x1CF, this, undefined, this.port1CF_write);
    io.register_read(0x1CF, this, undefined, this.port1CF_read);


    const vga_offset = cpu.svga_allocate_memory(this.vga_memory_size) >>> 0;
    this.svga_memory = view(Uint8Array, cpu.wasm_memory, vga_offset, this.vga_memory_size);

    this.diff_addr_min = this.vga_memory_size;
    this.diff_addr_max = 0;
    this.diff_plot_min = this.vga_memory_size;
    this.diff_plot_max = 0;

    this.image_data = null;

    this.vga_memory = new Uint8Array(4 * VGA_BANK_SIZE);
    this.plane0 = new Uint8Array(this.vga_memory.buffer, 0 * VGA_BANK_SIZE, VGA_BANK_SIZE);
    this.plane1 = new Uint8Array(this.vga_memory.buffer, 1 * VGA_BANK_SIZE, VGA_BANK_SIZE);
    this.plane2 = new Uint8Array(this.vga_memory.buffer, 2 * VGA_BANK_SIZE, VGA_BANK_SIZE);
    this.plane3 = new Uint8Array(this.vga_memory.buffer, 3 * VGA_BANK_SIZE, VGA_BANK_SIZE);
    this.pixel_buffer = new Uint8Array(VGA_PIXEL_BUFFER_SIZE);

    io.mmap_register(0xA0000, 0x20000,
        addr => this.vga_memory_read(addr),
        (addr, value) => this.vga_memory_write(addr, value),
    );

    cpu.devices.pci.register_device(this);
}

VGAScreen.prototype.get_state = function()
{
    var state = [];

    state[0] = this.vga_memory_size;
    state[1] = this.cursor_address;
    state[2] = this.cursor_scanline_start;
    state[3] = this.cursor_scanline_end;
    state[4] = this.max_cols;
    state[5] = this.max_rows;
    state[6] = this.vga_memory;
    state[7] = this.dac_state;
    state[8] = this.start_address;
    state[9] = this.graphical_mode;
    state[10] = this.vga256_palette;
    state[11] = this.latch_dword;
    state[12] = this.color_compare;
    state[13] = this.color_dont_care;
    state[14] = this.miscellaneous_graphics_register;
    state[15] = this.svga_width;
    state[16] = this.svga_height;
    state[17] = this.crtc_mode;
    state[18] = this.svga_enabled;
    state[19] = this.svga_bpp;
    state[20] = this.svga_bank_offset;
    state[21] = this.svga_offset;
    state[22] = this.index_crtc;
    state[23] = this.dac_color_index_write;
    state[24] = this.dac_color_index_read;
    state[25] = this.dac_map;
    state[26] = this.sequencer_index;
    state[27] = this.plane_write_bm;
    state[28] = this.sequencer_memory_mode;
    state[29] = this.graphics_index;
    state[30] = this.plane_read;
    state[31] = this.planar_mode;
    state[32] = this.planar_rotate_reg;
    state[33] = this.planar_bitmap;
    state[34] = this.max_scan_line;
    state[35] = this.miscellaneous_output_register;
    state[36] = this.port_3DA_value;
    state[37] = this.dispi_index;
    state[38] = this.dispi_enable_value;
    state[39] = this.svga_memory;
    // this.graphical_mode_is_linear
    state[41] = this.attribute_controller_index;
    state[42] = this.offset_register;
    state[43] = this.planar_setreset;
    state[44] = this.planar_setreset_enable;
    state[45] = this.start_address_latched;
    state[46] = this.crtc;
    state[47] = this.horizontal_display_enable_end;
    state[48] = this.horizontal_blank_start;
    state[49] = this.vertical_display_enable_end;
    state[50] = this.vertical_blank_start;
    state[51] = this.underline_location_register;
    state[52] = this.preset_row_scan;
    state[53] = this.offset_register;
    state[54] = this.palette_source;
    state[55] = this.attribute_mode;
    state[56] = this.color_plane_enable;
    state[57] = this.horizontal_panning;
    state[58] = this.color_select;
    state[59] = this.clocking_mode;
    state[60] = this.line_compare;
    state[61] = this.pixel_buffer;
    state[62] = this.dac_mask;
    state[63] = this.character_map_select;
    state[64] = this.font_page_ab_enabled;

    return state;
};

VGAScreen.prototype.set_state = function(state)
{
    this.vga_memory_size = state[0];
    this.cursor_address = state[1];
    this.cursor_scanline_start = state[2];
    this.cursor_scanline_end = state[3];
    this.max_cols = state[4];
    this.max_rows = state[5];
    state[6] && this.vga_memory.set(state[6]);
    this.dac_state = state[7];
    this.start_address = state[8];
    this.graphical_mode = state[9];
    this.vga256_palette = state[10];
    this.latch_dword = state[11];
    this.color_compare = state[12];
    this.color_dont_care = state[13];
    this.miscellaneous_graphics_register = state[14];
    this.svga_width = state[15];
    this.svga_height = state[16];
    this.crtc_mode = state[17];
    this.svga_enabled = state[18];
    this.svga_bpp = state[19];
    this.svga_bank_offset = state[20];
    this.svga_offset = state[21];
    this.index_crtc = state[22];
    this.dac_color_index_write = state[23];
    this.dac_color_index_read = state[24];
    this.dac_map = state[25];
    this.sequencer_index = state[26];
    this.plane_write_bm = state[27];
    this.sequencer_memory_mode = state[28];
    this.graphics_index = state[29];
    this.plane_read = state[30];
    this.planar_mode = state[31];
    this.planar_rotate_reg = state[32];
    this.planar_bitmap = state[33];
    this.max_scan_line = state[34];
    this.miscellaneous_output_register = state[35];
    this.port_3DA_value = state[36];
    this.dispi_index = state[37];
    this.dispi_enable_value = state[38];
    this.svga_memory.set(state[39]);
    // state[40];
    this.attribute_controller_index = state[41];
    this.offset_register = state[42];
    this.planar_setreset = state[43];
    this.planar_setreset_enable = state[44];
    this.start_address_latched = state[45];
    this.crtc.set(state[46]);
    this.horizontal_display_enable_end = state[47];
    this.horizontal_blank_start = state[48];
    this.vertical_display_enable_end = state[49];
    this.vertical_blank_start = state[50];
    this.underline_location_register = state[51];
    this.preset_row_scan = state[52];
    this.offset_register = state[53];
    this.palette_source = state[54];
    this.attribute_mode = state[55];
    this.color_plane_enable = state[56];
    this.horizontal_panning = state[57];
    this.color_select = state[58];
    this.clocking_mode = state[59];
    this.line_compare = state[60];
    state[61] && this.pixel_buffer.set(state[61]);
    this.dac_mask = state[62] === undefined ? 0xFF : state[62];
    this.character_map_select = state[63] === undefined ? 0 : state[63];
    this.font_page_ab_enabled = state[64] === undefined ? 0 : state[64];

    this.screen.set_mode(this.graphical_mode);

    if(this.graphical_mode)
    {
        // Ensure set_size_graphical will update
        this.screen_width = 0;
        this.screen_height = 0;

        if(this.svga_enabled)
        {
            this.set_size_graphical(this.svga_width, this.svga_height, this.svga_width, this.svga_height, this.svga_bpp);
            this.update_layers();
        }
        else
        {
            this.update_vga_size();
            this.update_layers();
            this.complete_replot();
        }
    }
    else
    {
        this.set_font_bitmap(true);
        this.set_size_text(this.max_cols, this.max_rows);
        this.set_font_page();
        this.update_cursor_scanline();
        this.update_cursor();
    }
    this.complete_redraw();
};

VGAScreen.prototype.vga_memory_read = function(addr)
{
    if(this.svga_enabled)
    {
        // vbe banked mode (accessing svga memory through the regular vga memory range)
        return this.cpu.read8((addr - 0xA0000 | this.svga_bank_offset) + VGA_LFB_ADDRESS | 0);
    }

    var memory_space_select = this.miscellaneous_graphics_register >> 2 & 0x3;
    addr -= VGA_HOST_MEMORY_SPACE_START[memory_space_select];

    // VGA chip only decodes addresses within the selected memory space.
    if(addr < 0 || addr >= VGA_HOST_MEMORY_SPACE_SIZE[memory_space_select])
    {
        dbg_log("vga read outside memory space: addr:" + h(addr >>> 0), LOG_VGA);
        return 0;
    }

    this.latch_dword = this.plane0[addr];
    this.latch_dword |= this.plane1[addr] << 8;
    this.latch_dword |= this.plane2[addr] << 16;
    this.latch_dword |= this.plane3[addr] << 24;

    if(this.planar_mode & 0x08)
    {
        // read mode 1
        var reading = 0xFF;

        if(this.color_dont_care & 0x1)
        {
            reading &= this.plane0[addr] ^ ~(this.color_compare & 0x1 ? 0xFF : 0x00);
        }
        if(this.color_dont_care & 0x2)
        {
            reading &= this.plane1[addr] ^ ~(this.color_compare & 0x2 ? 0xFF : 0x00);
        }
        if(this.color_dont_care & 0x4)
        {
            reading &= this.plane2[addr] ^ ~(this.color_compare & 0x4 ? 0xFF : 0x00);
        }
        if(this.color_dont_care & 0x8)
        {
            reading &= this.plane3[addr] ^ ~(this.color_compare & 0x8 ? 0xFF : 0x00);
        }

        return reading;
    }
    else
    {
        // read mode 0

        var plane = this.plane_read;
        if(!this.graphical_mode)
        {
            // We store all text data linearly and font data in plane 2.
            // TODO: works well for planes 0 and 2, but what about plane 1?
            plane &= 0x3;
        }
        else if(this.sequencer_memory_mode & 0x8)
        {
            // Chain 4
            plane = addr & 0x3;
            addr &= ~0x3;
        }
        else if(this.planar_mode & 0x10)
        {
            // Odd/Even host read
            plane = addr & 0x1;
            addr &= ~0x1;
        }
        return this.vga_memory[plane << 16 | addr];
    }
};

VGAScreen.prototype.vga_memory_write = function(addr, value)
{
    if(this.svga_enabled)
    {
        // vbe banked mode (accessing svga memory through the regular vga memory range)
        this.cpu.write8((addr - 0xA0000 | this.svga_bank_offset) + VGA_LFB_ADDRESS | 0, value);
        return;
    }

    var memory_space_select = this.miscellaneous_graphics_register >> 2 & 0x3;
    addr -= VGA_HOST_MEMORY_SPACE_START[memory_space_select];

    if(addr < 0 || addr >= VGA_HOST_MEMORY_SPACE_SIZE[memory_space_select])
    {
        dbg_log("vga write outside memory space: addr:" + h(addr >>> 0) + ", value:" + h(value), LOG_VGA);
        return;
    }

    if(this.graphical_mode)
    {
        this.vga_memory_write_graphical(addr, value);
    }
    else if(!(this.plane_write_bm & 0x3))
    {
        if(this.plane_write_bm & 0x4)
        {
            // write to plane 2 (font-bitmap)
            this.plane2[addr] = value;
        }
    }
    else
    {
        this.vga_memory_write_text_mode(addr, value);
    }
};

VGAScreen.prototype.vga_memory_write_graphical = function(addr, value)
{
    var plane_dword;
    var write_mode = this.planar_mode & 3;
    var bitmask = this.apply_feed(this.planar_bitmap);
    var setreset_dword = this.apply_expand(this.planar_setreset);
    var setreset_enable_dword = this.apply_expand(this.planar_setreset_enable);

    // Write modes - see http://www.osdever.net/FreeVGA/vga/graphreg.htm#05
    switch(write_mode)
    {
        case 0:
            value = this.apply_rotate(value);
            plane_dword = this.apply_feed(value);
            plane_dword = this.apply_setreset(plane_dword, setreset_enable_dword);
            plane_dword = this.apply_logical(plane_dword, this.latch_dword);
            plane_dword = this.apply_bitmask(plane_dword, bitmask);
            break;
        case 1:
            plane_dword = this.latch_dword;
            break;
        case 2:
            plane_dword = this.apply_expand(value);
            plane_dword = this.apply_logical(plane_dword, this.latch_dword);
            plane_dword = this.apply_bitmask(plane_dword, bitmask);
            break;
        case 3:
            value = this.apply_rotate(value);
            bitmask &= this.apply_feed(value);
            plane_dword = setreset_dword;
            plane_dword = this.apply_bitmask(plane_dword, bitmask);
            break;
    }

    var plane_select = 0xF;

    switch(this.sequencer_memory_mode & 0xC)
    {
        // Odd/Even (aka chain 2)
        case 0x0:
            plane_select = 0x5 << (addr & 0x1);
            addr &= ~0x1;
            break;

        // Chain 4
        // Note: FreeVGA may have mistakenly stated that this bit field is
        // for system read only, yet the IBM Open Source Graphics Programmer's
        // Reference Manual explicitly states "both read and write".
        case 0x8:
        case 0xC:
            plane_select = 1 << (addr & 0x3);
            addr &= ~0x3;
            break;
    }

    // Plane masks take precedence
    // See: http://www.osdever.net/FreeVGA/vga/seqreg.htm#02
    plane_select &= this.plane_write_bm;

    if(plane_select & 0x1) this.plane0[addr] = (plane_dword >> 0) & 0xFF;
    if(plane_select & 0x2) this.plane1[addr] = (plane_dword >> 8) & 0xFF;
    if(plane_select & 0x4) this.plane2[addr] = (plane_dword >> 16) & 0xFF;
    if(plane_select & 0x8) this.plane3[addr] = (plane_dword >> 24) & 0xFF;

    var pixel_addr = this.vga_addr_to_pixel(addr);
    this.partial_replot(pixel_addr, pixel_addr + 7);
};

/**
 * Copies data_byte into the four planes, with each plane
 * represented by an 8-bit field inside the dword.
 * @param {number} data_byte
 * @return {number} 32-bit number representing the bytes for each plane.
 */
VGAScreen.prototype.apply_feed = function(data_byte)
{
    var dword = data_byte;
    dword |= data_byte << 8;
    dword |= data_byte << 16;
    dword |= data_byte << 24;
    return dword;
};

/**
 * Expands bits 0 to 3 to ocupy bits 0 to 31. Each
 * bit is expanded to 0xFF if set or 0x00 if clear.
 * @param {number} data_byte
 * @return {number} 32-bit number representing the bytes for each plane.
 */
VGAScreen.prototype.apply_expand = function(data_byte)
{
    var dword = data_byte & 0x1 ? 0xFF : 0x00;
    dword |= (data_byte & 0x2 ? 0xFF : 0x00) << 8;
    dword |= (data_byte & 0x4 ? 0xFF : 0x00) << 16;
    dword |= (data_byte & 0x8 ? 0xFF : 0x00) << 24;
    return dword;
};

/**
 * Planar Write - Barrel Shifter
 * @param {number} data_byte
 * @return {number}
 * @see {@link http://www.phatcode.net/res/224/files/html/ch25/25-01.html#Heading3}
 * @see {@link http://www.osdever.net/FreeVGA/vga/graphreg.htm#03}
 */
VGAScreen.prototype.apply_rotate = function(data_byte)
{
    var wrapped = data_byte | (data_byte << 8);
    var count = this.planar_rotate_reg & 0x7;
    var shifted = wrapped >>> count;
    return shifted & 0xFF;
};

/**
 * Planar Write - Set / Reset Circuitry
 * @param {number} data_dword
 * @param {number} enable_dword
 * @return {number}
 * @see {@link http://www.phatcode.net/res/224/files/html/ch25/25-03.html#Heading5}
 * @see {@link http://www.osdever.net/FreeVGA/vga/graphreg.htm#00}
 */
VGAScreen.prototype.apply_setreset = function(data_dword, enable_dword)
{
    var setreset_dword = this.apply_expand(this.planar_setreset);
    data_dword |= enable_dword & setreset_dword;
    data_dword &= ~enable_dword | setreset_dword;
    return data_dword;
};

/**
 * Planar Write - ALU Unit
 * @param {number} data_dword
 * @param {number} latch_dword
 * @return {number}
 * @see {@link http://www.phatcode.net/res/224/files/html/ch24/24-01.html#Heading3}
 * @see {@link http://www.osdever.net/FreeVGA/vga/graphreg.htm#03}
 */
VGAScreen.prototype.apply_logical = function(data_dword, latch_dword)
{
    switch(this.planar_rotate_reg & 0x18)
    {
        case 0x08:
            return data_dword & latch_dword;
        case 0x10:
            return data_dword | latch_dword;
        case 0x18:
            return data_dword ^ latch_dword;
    }
    return data_dword;
};

/**
 * Planar Write - Bitmask Unit
 * @param {number} data_dword
 * @param {number} bitmask_dword
 * @return {number}
 * @see {@link http://www.phatcode.net/res/224/files/html/ch25/25-01.html#Heading2}
 * @see {@link http://www.osdever.net/FreeVGA/vga/graphreg.htm#08}
 */
VGAScreen.prototype.apply_bitmask = function(data_dword, bitmask_dword)
{
    var plane_dword = bitmask_dword & data_dword;
    plane_dword |= ~bitmask_dword & this.latch_dword;
    return plane_dword;
};

VGAScreen.prototype.text_mode_redraw = function()
{
    const split_screen_row = this.scan_line_to_screen_row(this.line_compare);
    const row_offset = Math.max(0, (this.offset_register * 2 - this.max_cols) * 2);
    const blink_enabled = this.attribute_mode & 1 << 3;
    const fg_color_mask = this.font_page_ab_enabled ? 7 : 0xF;
    const bg_color_mask = blink_enabled ? 7 : 0xF;
    const FLAG_BLINKING = this.screen.FLAG_BLINKING;
    const FLAG_FONT_PAGE_B = this.screen.FLAG_FONT_PAGE_B;

    let addr = this.start_address << 1;

    for(let row = 0; row < this.max_rows; row++)
    {
        if(row === split_screen_row)
        {
            addr = 0;
        }

        for(let col = 0; col < this.max_cols; col++)
        {
            const chr = this.vga_memory[addr];
            const color = this.vga_memory[addr | 1];
            const blinking = blink_enabled && (color & 1 << 7);
            const font_page_b = this.font_page_ab_enabled && !(color & 1 << 3);
            const flags = (blinking ? FLAG_BLINKING : 0) | (font_page_b ? FLAG_FONT_PAGE_B : 0);

            this.bus.send("screen-put-char", [row, col, chr]);

            this.screen.put_char(row, col, chr, flags,
                this.vga256_palette[this.dac_mask & this.dac_map[color >> 4 & bg_color_mask]],
                this.vga256_palette[this.dac_mask & this.dac_map[color & fg_color_mask]]);

            addr += 2;
        }

        addr += row_offset;
    }
};

VGAScreen.prototype.vga_memory_write_text_mode = function(addr, value)
{
    this.vga_memory[addr] = value;

    const max_cols = Math.max(this.max_cols, this.offset_register * 2);
    let row;
    let col;

    if((addr >> 1) >= this.start_address)
    {
        const memory_start = (addr >> 1) - this.start_address;
        row = memory_start / max_cols | 0;
        col = memory_start % max_cols;
    }
    else
    {
        const memory_start = addr >> 1;
        row = (memory_start / max_cols | 0) + this.scan_line_to_screen_row(this.line_compare);
        col = memory_start % max_cols;
    }

    dbg_assert(row >= 0 && col >= 0);

    if(col >= this.max_cols || row >= this.max_rows)
    {
        return;
    }

    let chr;
    let color;

    // XXX: Should handle 16 bit write if possible
    if(addr & 1)
    {
        color = value;
        chr = this.vga_memory[addr & ~1];
    }
    else
    {
        chr = value;
        color = this.vga_memory[addr | 1];
    }
    const blink_enabled = this.attribute_mode & 1 << 3;
    const blinking = blink_enabled && (color & 1 << 7);
    const font_page_b = this.font_page_ab_enabled && !(color & 1 << 3);
    const flags = (blinking ? this.screen.FLAG_BLINKING : 0) | (font_page_b ? this.screen.FLAG_FONT_PAGE_B : 0);
    const fg_color_mask = this.font_page_ab_enabled ? 7 : 0xF;
    const bg_color_mask = blink_enabled ? 7 : 0xF;

    this.bus.send("screen-put-char", [row, col, chr]);

    this.screen.put_char(row, col, chr, flags,
        this.vga256_palette[this.dac_mask & this.dac_map[color >> 4 & bg_color_mask]],
        this.vga256_palette[this.dac_mask & this.dac_map[color & fg_color_mask]]);
};

VGAScreen.prototype.update_cursor = function()
{
    const max_cols = Math.max(this.max_cols, this.offset_register * 2);
    let row;
    let col;

    if(this.cursor_address >= this.start_address)
    {
        row = (this.cursor_address - this.start_address) / max_cols | 0;
        col = (this.cursor_address - this.start_address) % max_cols;
    }
    else
    {
        row = (this.cursor_address / max_cols | 0) + this.scan_line_to_screen_row(this.line_compare);
        col = this.cursor_address % max_cols;
    }

    dbg_assert(row >= 0 && col >= 0);

    // NOTE: is allowed to be out of bounds
    this.screen.update_cursor(row, col);
};

VGAScreen.prototype.complete_redraw = function()
{
    dbg_log("complete redraw", LOG_VGA);

    if(this.graphical_mode)
    {
        if(this.svga_enabled)
        {
            this.cpu.svga_mark_dirty();
        }
        else
        {
            this.diff_addr_min = 0;
            this.diff_addr_max = VGA_PIXEL_BUFFER_SIZE;
        }
    }
    else
    {
        this.text_mode_redraw();
    }
};

VGAScreen.prototype.complete_replot = function()
{
    dbg_log("complete replot", LOG_VGA);

    if(!this.graphical_mode || this.svga_enabled)
    {
        return;
    }

    this.diff_plot_min = 0;
    this.diff_plot_max = VGA_PIXEL_BUFFER_SIZE;

    this.complete_redraw();
};

VGAScreen.prototype.partial_redraw = function(min, max)
{
    if(min < this.diff_addr_min) this.diff_addr_min = min;
    if(max > this.diff_addr_max) this.diff_addr_max = max;
};

VGAScreen.prototype.partial_replot = function(min, max)
{
    if(min < this.diff_plot_min) this.diff_plot_min = min;
    if(max > this.diff_plot_max) this.diff_plot_max = max;

    this.partial_redraw(min, max);
};

VGAScreen.prototype.reset_diffs = function()
{
    this.diff_addr_min = this.vga_memory_size;
    this.diff_addr_max = 0;
    this.diff_plot_min = this.vga_memory_size;
    this.diff_plot_max = 0;
};

VGAScreen.prototype.destroy = function()
{

};

VGAScreen.prototype.vga_bytes_per_line = function()
{
    var bytes_per_line = this.offset_register << 2;
    if(this.underline_location_register & 0x40) bytes_per_line <<= 1;
    else if(this.crtc_mode & 0x40) bytes_per_line >>>= 1;
    return bytes_per_line;
};

VGAScreen.prototype.vga_addr_shift_count = function()
{
    // Count in multiples of 0x40 for convenience
    // Left shift 2 for word mode - 2 bytes per dot clock
    var shift_count = 0x80;

    // Left shift 3 for byte mode - 1 byte per dot clock
    shift_count += ~this.underline_location_register & this.crtc_mode & 0x40;

    // Left shift 1 for doubleword mode - 4 bytes per dot clock
    shift_count -= this.underline_location_register & 0x40;

    // But shift one less if PEL width mode - 2 dot clocks per pixel
    shift_count -= this.attribute_mode & 0x40;

    return shift_count >>> 6;
};

VGAScreen.prototype.vga_addr_to_pixel = function(addr)
{
    var shift_count = this.vga_addr_shift_count();

    // Undo effects of substituted bits 13 and 14
    // Assumptions:
    //  - max_scan_line register is set to the values shown below
    //  - Each scan line stays within the offset alignment
    //  - No panning and no page flipping after drawing
    if(~this.crtc_mode & 0x3)
    {
        var pixel_addr = addr - this.start_address;

        // Remove substituted bits
        pixel_addr &= this.crtc_mode << 13 | ~0x6000;

        // Convert to 1 pixel per address
        pixel_addr <<= shift_count;

        // Decompose address
        var row = pixel_addr / this.virtual_width | 0;
        var col = pixel_addr % this.virtual_width;

        switch(this.crtc_mode & 0x3)
        {
            case 0x2:
                // Alternating rows using bit 13
                // Assumes max scan line = 1
                row = row << 1 | (addr >> 13 & 0x1);
                break;
            case 0x1:
                // Alternating rows using bit 14
                // Assumes max scan line = 3
                row = row << 1 | (addr >> 14 & 0x1);
                break;
            case 0x0:
                // Cycling through rows using bit 13 and 14
                // Assumes max scan line = 3
                row = row << 2 | (addr >> 13 & 0x3);
                break;
        }

        // Reassemble address
        return row * this.virtual_width + col + (this.start_address << shift_count);
    }
    else
    {
        // Convert to 1 pixel per address
        return addr << shift_count;
    }
};

VGAScreen.prototype.scan_line_to_screen_row = function(scan_line)
{
    // Double scanning. The clock to the row scan counter is halved
    // so it is not affected by the memory address bit substitutions below
    if(this.max_scan_line & 0x80)
    {
        scan_line >>>= 1;
    }

    // Maximum scan line, aka scan lines per character row
    // This is the number of repeats - 1 for graphic modes
    var repeat_factor = 1 + (this.max_scan_line & 0x1F);
    scan_line = Math.ceil(scan_line / repeat_factor);

    // Odd and Even Row Scan Counter
    // Despite repeated address counter values, because bit 13 of the shifted
    // address is substituted with bit 0 of the row scan counter, a different
    // display buffer address is generated instead of repeated
    // Assumes maximum scan line register is set to 2 or 4.
    // Note: can't assert this as register values may not be fully programmed.
    if(!(this.crtc_mode & 0x1))
    {
        scan_line <<= 1;
    }

    // Undo effects of substituted bit 14
    // Assumes maximum scan line register is set to 2 or 4
    // Note: can't assert this as register values may not be fully programmed.
    // Other maximum scan line register values would result in weird addressing
    // anyway
    if(!(this.crtc_mode & 0x2))
    {
        scan_line <<= 1;
    }

    return scan_line;
};

/**
 * @param {number} cols_count
 * @param {number} rows_count
 */
VGAScreen.prototype.set_size_text = function(cols_count, rows_count)
{
    dbg_assert(!this.graphical_mode);
    this.max_cols = cols_count;
    this.max_rows = rows_count;

    this.screen.set_size_text(cols_count, rows_count);
    this.bus.send("screen-set-size", [cols_count, rows_count, 0]);
};

VGAScreen.prototype.set_size_graphical = function(width, height, virtual_width, virtual_height, bpp)
{
    dbg_assert(this.graphical_mode);

    virtual_width = Math.max(virtual_width, 1);
    virtual_height = Math.max(virtual_height, 1);

    const needs_update =
        this.screen_width !== width ||
        this.screen_height !== height ||
        this.virtual_width !== virtual_width ||
        this.virtual_height !== virtual_height;

    if(needs_update)
    {
        this.screen_width = width;
        this.screen_height = height;
        this.virtual_width = virtual_width;
        this.virtual_height = virtual_height;

        if(typeof ImageData !== "undefined")
        {
            const size = virtual_width * virtual_height;
            const offset = this.cpu.svga_allocate_dest_buffer(size) >>> 0;

            this.dest_buffet_offset = offset;
            this.image_data = new ImageData(new Uint8ClampedArray(this.cpu.wasm_memory.buffer, offset, 4 * size), virtual_width, virtual_height);

            this.cpu.svga_mark_dirty();
        }
        else
        {
            // TODO: nodejs
        }

        this.screen.set_size_graphical(width, height, virtual_width, virtual_height);
        this.bus.send("screen-set-size", [width, height, bpp]);
    }
};

VGAScreen.prototype.update_vga_size = function()
{
    if(this.svga_enabled)
    {
        return;
    }

    var horizontal_characters = Math.min(1 + this.horizontal_display_enable_end,
        this.horizontal_blank_start);
    var vertical_scans = Math.min(1 + this.vertical_display_enable_end,
        this.vertical_blank_start);

    if(!horizontal_characters || !vertical_scans)
    {
        // Don't update if width or height is zero.
        // These happen when registers are not fully configured yet.
        return;
    }

    if(this.graphical_mode)
    {
        var screen_width = horizontal_characters << 3;

        // Offset is half the number of bytes/words/dwords (depending on clocking mode)
        // of display memory that each logical line occupies.
        // However, the number of pixels latched, regardless of addressing mode,
        // should always 8 pixels per character clock (except for 8 bit PEL width, in which
        // case 4 pixels).
        var virtual_width = this.offset_register << 4;
        var bpp = 4;

        // Pixel Width / PEL Width / Clock Select
        if(this.attribute_mode & 0x40)
        {
            screen_width >>>= 1;
            virtual_width >>>= 1;
            bpp = 8;
        }
        else if(this.attribute_mode & 0x2)
        {
            bpp = 1;
        }

        var screen_height = this.scan_line_to_screen_row(vertical_scans);

        // The virtual buffer height is however many rows of data that can fit.
        // Previously drawn graphics outside of current memory address space can
        // still be drawn by setting start_address. The address at
        // VGA_HOST_MEMORY_SPACE_START[memory_space_select] is mapped to the first
        // byte of the frame buffer. Verified on some hardware.
        // Depended on by: Windows 98 start screen
        var available_bytes = VGA_HOST_MEMORY_SPACE_SIZE[0];

        const bytes_per_line = this.vga_bytes_per_line();
        const virtual_height = bytes_per_line ? Math.ceil(available_bytes / bytes_per_line) : screen_height;

        this.set_size_graphical(screen_width, screen_height, virtual_width, virtual_height, bpp);

        this.update_vertical_retrace();
        this.update_layers();
    }
    else
    {
        if(this.max_scan_line & 0x80)
        {
            // Double scanning means that half of those scan lines
            // are just repeats
            vertical_scans >>>= 1;
        }

        var height = vertical_scans / (1 + (this.max_scan_line & 0x1F)) | 0;

        if(horizontal_characters && height)
        {
            this.set_size_text(horizontal_characters, height);
        }
    }
};

VGAScreen.prototype.update_layers = function()
{
    if(!this.graphical_mode)
    {
        this.text_mode_redraw();
    }

    if(this.svga_enabled)
    {
        this.layers = [];
        return;
    }

    if(!this.virtual_width || !this.screen_width)
    {
        // Avoid division by zero
        return;
    }

    if(!this.palette_source || (this.clocking_mode & 0x20))
    {
        // Palette source and screen disable bits = draw nothing
        // See http://www.phatcode.net/res/224/files/html/ch29/29-05.html#Heading6
        // and http://www.osdever.net/FreeVGA/vga/seqreg.htm#01
        this.layers = [];
        this.screen.clear_screen();
        return;
    }

    var start_addr = this.start_address_latched;

    var pixel_panning = this.horizontal_panning;
    if(this.attribute_mode & 0x40)
    {
        pixel_panning >>>= 1;
    }

    var byte_panning = this.preset_row_scan >> 5 & 0x3;
    var pixel_addr_start = this.vga_addr_to_pixel(start_addr + byte_panning);

    var start_buffer_row = pixel_addr_start / this.virtual_width | 0;
    var start_buffer_col = pixel_addr_start % this.virtual_width + pixel_panning;

    var split_screen_row = this.scan_line_to_screen_row(1 + this.line_compare);
    split_screen_row = Math.min(split_screen_row, this.screen_height);

    var split_buffer_height = this.screen_height - split_screen_row;

    this.layers = [];

    for(var x = -start_buffer_col, y = 0; x < this.screen_width; x += this.virtual_width, y++)
    {
        this.layers.push({
            image_data: this.image_data,
            screen_x: x,
            screen_y: 0,
            buffer_x: 0,
            buffer_y: start_buffer_row + y,
            buffer_width: this.virtual_width,
            buffer_height: split_screen_row,
        });
    }

    var start_split_col = 0;
    if(!(this.attribute_mode & 0x20))
    {
        // Pixel panning mode. Allow panning for the lower split screen
        start_split_col = this.vga_addr_to_pixel(byte_panning) + pixel_panning;
    }

    for(var x = -start_split_col, y = 0; x < this.screen_width; x += this.virtual_width, y++)
    {
        this.layers.push({
            image_data: this.image_data,
            screen_x: x,
            screen_y: split_screen_row,
            buffer_x: 0,
            buffer_y: y,
            buffer_width: this.virtual_width,
            buffer_height: split_buffer_height,
        });
    }
};

VGAScreen.prototype.update_vertical_retrace = function()
{
    // Emulate behaviour during VSync/VRetrace
    this.port_3DA_value |= 0x8;
    if(this.start_address_latched !== this.start_address)
    {
        this.start_address_latched = this.start_address;
        this.update_layers();
    }
};

VGAScreen.prototype.update_cursor_scanline = function()
{
    const disabled = this.cursor_scanline_start & 0x20;
    const max = this.max_scan_line & 0x1F;
    const start = Math.min(max, this.cursor_scanline_start & 0x1F);
    const end = Math.min(max, this.cursor_scanline_end & 0x1F);
    const visible = !disabled && start < end;
    this.screen.update_cursor_scanline(start, end, visible);
};

/**
 * Attribute controller register / index write
 * @see {@link http://www.osdever.net/FreeVGA/vga/attrreg.htm}
 * @see {@link http://www.mcamafia.de/pdf/ibm_vgaxga_trm2.pdf} page 89
 * @see {@link https://01.org/sites/default/files/documentation/intel-gfx-prm-osrc-hsw-display_0.pdf} page 48
 */
VGAScreen.prototype.port3C0_write = function(value)
{
    if(this.attribute_controller_index === -1)
    {
        dbg_log("attribute controller index register: " + h(value), LOG_VGA);
        this.attribute_controller_index = value & 0x1F;
        dbg_log("attribute actual index: " + h(this.attribute_controller_index), LOG_VGA);

        if(this.palette_source !== (value & 0x20))
        {
            // A method of blanking the screen.
            // See http://www.phatcode.net/res/224/files/html/ch29/29-05.html#Heading6
            this.palette_source = value & 0x20;
            this.update_layers();
        }
    }
    else
    {
        if(this.attribute_controller_index < 0x10)
        {
            dbg_log("internal palette: " + h(this.attribute_controller_index) + " -> " + h(value), LOG_VGA);
            this.dac_map[this.attribute_controller_index] = value;

            if(!(this.attribute_mode & 0x40))
            {
                this.complete_redraw();
            }
        }
        else
        switch(this.attribute_controller_index)
        {
            case 0x10:
                dbg_log("3C0 / attribute mode control: " + h(value), LOG_VGA);
                if(this.attribute_mode !== value)
                {
                    var previous_mode = this.attribute_mode;
                    this.attribute_mode = value;

                    const is_graphical = (value & 0x1) !== 0;
                    if(!this.svga_enabled && this.graphical_mode !== is_graphical)
                    {
                        this.graphical_mode = is_graphical;
                        this.screen.set_mode(this.graphical_mode);
                    }

                    if((previous_mode ^ value) & 0x40)
                    {
                        // PEL width changed. Pixel Buffer now invalidated
                        this.complete_replot();
                    }

                    this.update_vga_size();

                    // Data stored in image buffer are invalidated
                    this.complete_redraw();

                    this.set_font_bitmap(false);
                }
                break;
            case 0x12:
                dbg_log("3C0 / color plane enable: " + h(value), LOG_VGA);
                if(this.color_plane_enable !== value)
                {
                    this.color_plane_enable = value;

                    // Data stored in image buffer are invalidated
                    this.complete_redraw();
                }
                break;
            case 0x13:
                dbg_log("3C0 / horizontal panning: " + h(value), LOG_VGA);
                if(this.horizontal_panning !== value)
                {
                    this.horizontal_panning = value & 0xF;
                    this.update_layers();
                }
                break;
            case 0x14:
                dbg_log("3C0 / color select: " + h(value), LOG_VGA);
                if(this.color_select !== value)
                {
                    this.color_select = value;

                    // Data stored in image buffer are invalidated
                    this.complete_redraw();
                }
                break;
            default:
                dbg_log("3C0 / attribute controller write " + h(this.attribute_controller_index) + ": " + h(value), LOG_VGA);
        }

        this.attribute_controller_index = -1;
    }
};

VGAScreen.prototype.port3C0_read = function()
{
    dbg_log("3C0 read", LOG_VGA);
    return (this.attribute_controller_index | this.palette_source) & 0xFF;
};

VGAScreen.prototype.port3C0_read16 = function()
{
    dbg_log("3C0 read16", LOG_VGA);
    return this.port3C0_read() | this.port3C1_read() << 8 & 0xFF00;
};

VGAScreen.prototype.port3C1_read = function()
{
    if(this.attribute_controller_index < 0x10)
    {
        dbg_log("3C1 / internal palette read: " + h(this.attribute_controller_index) +
            " -> " + h(this.dac_map[this.attribute_controller_index]), LOG_VGA);
        return this.dac_map[this.attribute_controller_index] & 0xFF;
    }

    switch(this.attribute_controller_index)
    {
        case 0x10:
            dbg_log("3C1 / attribute mode read: " + h(this.attribute_mode), LOG_VGA);
            return this.attribute_mode;
        case 0x12:
            dbg_log("3C1 / color plane enable read: " + h(this.color_plane_enable), LOG_VGA);
            return this.color_plane_enable;
        case 0x13:
            dbg_log("3C1 / horizontal panning read: " + h(this.horizontal_panning), LOG_VGA);
            return this.horizontal_panning;
        case 0x14:
            dbg_log("3C1 / color select read: " + h(this.color_select), LOG_VGA);
            return this.color_select;
        default:
            dbg_log("3C1 / attribute controller read " + h(this.attribute_controller_index), LOG_VGA);
    }
    return 0xFF;

};

VGAScreen.prototype.port3C2_write = function(value)
{
    dbg_log("3C2 / miscellaneous output register = " + h(value), LOG_VGA);
    this.miscellaneous_output_register = value;
};

VGAScreen.prototype.port3C4_write = function(value)
{
    this.sequencer_index = value;
};

VGAScreen.prototype.port3C4_read = function()
{
    return this.sequencer_index;
};

/**
 * Sequencer register writes
 * @see {@link http://www.osdever.net/FreeVGA/vga/seqreg.htm}
 * @see {@link http://www.mcamafia.de/pdf/ibm_vgaxga_trm2.pdf} page 47
 * @see {@link https://01.org/sites/default/files/documentation/intel-gfx-prm-osrc-hsw-display_0.pdf} page 19
 */
VGAScreen.prototype.port3C5_write = function(value)
{
    switch(this.sequencer_index)
    {
        case 0x01:
            dbg_log("clocking mode: " + h(value), LOG_VGA);
            var previous_clocking_mode = this.clocking_mode;
            this.clocking_mode = value;
            if((previous_clocking_mode ^ value) & 0x20)
            {
                // Screen disable bit modified
                this.update_layers();
            }
            this.set_font_bitmap(false);
            break;
        case 0x02:
            dbg_log("plane write mask: " + h(value), LOG_VGA);
            var previous_plane_write_bm = this.plane_write_bm;
            this.plane_write_bm = value;
            if(!this.graphical_mode && previous_plane_write_bm & 0x4 && !(this.plane_write_bm & 0x4))
            {
                // End of font plane 2 write access
                this.set_font_bitmap(true);
            }
            break;
        case 0x03:
            dbg_log("character map select: " + h(value), LOG_VGA);
            var previous_character_map_select = this.character_map_select;
            this.character_map_select = value;
            if(!this.graphical_mode && previous_character_map_select !== value)
            {
                this.set_font_page();
            }
            break;
        case 0x04:
            dbg_log("sequencer memory mode: " + h(value), LOG_VGA);
            this.sequencer_memory_mode = value;
            break;
        default:
            dbg_log("3C5 / sequencer write " + h(this.sequencer_index) + ": " + h(value), LOG_VGA);
    }
};

VGAScreen.prototype.port3C5_read = function()
{
    dbg_log("3C5 / sequencer read " + h(this.sequencer_index), LOG_VGA);

    switch(this.sequencer_index)
    {
        case 0x01:
            return this.clocking_mode;
        case 0x02:
            return this.plane_write_bm;
        case 0x03:
            return this.character_map_select;
        case 0x04:
            return this.sequencer_memory_mode;
        case 0x06:
            return 0x12;
        default:
    }
    return 0;
};

VGAScreen.prototype.port3C6_write = function(data)
{
    if(this.dac_mask !== data)
    {
        this.dac_mask = data;
        this.complete_redraw();
    }
};

VGAScreen.prototype.port3C6_read = function()
{
    return this.dac_mask;
};

VGAScreen.prototype.port3C7_write = function(index)
{
    // index for reading the DAC
    dbg_log("3C7 write: " + h(index), LOG_VGA);
    this.dac_color_index_read = index * 3;
    this.dac_state &= 0x0;
};

VGAScreen.prototype.port3C7_read = function()
{
    // prepared to accept reads or writes
    return this.dac_state;
};

VGAScreen.prototype.port3C8_write = function(index)
{
    this.dac_color_index_write = index * 3;
    this.dac_state |= 0x3;
};

VGAScreen.prototype.port3C8_read = function()
{
    return this.dac_color_index_write / 3 & 0xFF;
};

/**
 * DAC color palette register writes
 * @see {@link http://www.osdever.net/FreeVGA/vga/colorreg.htm}
 * @see {@link http://www.mcamafia.de/pdf/ibm_vgaxga_trm2.pdf} page 104
 * @see {@link https://01.org/sites/default/files/documentation/intel-gfx-prm-osrc-hsw-display_0.pdf} page 57
 */
VGAScreen.prototype.port3C9_write = function(color_byte)
{
    var index = this.dac_color_index_write / 3 | 0,
        offset = this.dac_color_index_write % 3,
        color = this.vga256_palette[index];

    if((this.dispi_enable_value & 0x20) === 0)
    {
        color_byte &= 0x3F;
        const b = color_byte & 1;
        color_byte = color_byte << 2 | b << 1 | b;
    }

    if(offset === 0)
    {
        color = color & ~0xFF0000 | color_byte << 16;
    }
    else if(offset === 1)
    {
        color = color & ~0xFF00 | color_byte << 8;
    }
    else
    {
        color = color & ~0xFF | color_byte;
        dbg_log("dac set color, index=" + h(index) + " value=" + h(color), LOG_VGA);
    }

    if(this.vga256_palette[index] !== color)
    {
        this.vga256_palette[index] = color;
        this.complete_redraw();
    }
    this.dac_color_index_write++;
};

VGAScreen.prototype.port3C9_read = function()
{
    dbg_log("3C9 read", LOG_VGA);

    var index = this.dac_color_index_read / 3 | 0;
    var offset = this.dac_color_index_read % 3;
    var color = this.vga256_palette[index];
    var color8 = color >> (2 - offset) * 8 & 0xFF;

    this.dac_color_index_read++;

    if(this.dispi_enable_value & 0x20)
    {
        return color8;
    }
    else
    {
        return color8 >> 2;
    }
};

VGAScreen.prototype.port3CC_read = function()
{
    dbg_log("3CC read", LOG_VGA);
    return this.miscellaneous_output_register;
};

VGAScreen.prototype.port3CE_write = function(value)
{
    this.graphics_index = value;
};

VGAScreen.prototype.port3CE_read = function()
{
    return this.graphics_index;
};

/**
 * Graphics controller register writes
 * @see {@link http://www.osdever.net/FreeVGA/vga/graphreg.htm}
 * @see {@link http://www.mcamafia.de/pdf/ibm_vgaxga_trm2.pdf} page 78
 * @see {@link https://01.org/sites/default/files/documentation/intel-gfx-prm-osrc-hsw-display_0.pdf} page 29
 */
VGAScreen.prototype.port3CF_write = function(value)
{
    switch(this.graphics_index)
    {
        case 0:
            this.planar_setreset = value;
            dbg_log("plane set/reset: " + h(value), LOG_VGA);
            break;
        case 1:
            this.planar_setreset_enable = value;
            dbg_log("plane set/reset enable: " + h(value), LOG_VGA);
            break;
        case 2:
            this.color_compare = value;
            dbg_log("color compare: " + h(value), LOG_VGA);
            break;
        case 3:
            this.planar_rotate_reg = value;
            dbg_log("plane rotate: " + h(value), LOG_VGA);
            break;
        case 4:
            this.plane_read = value;
            dbg_log("plane read: " + h(value), LOG_VGA);
            break;
        case 5:
            var previous_planar_mode = this.planar_mode;
            this.planar_mode = value;
            dbg_log("planar mode: " + h(value), LOG_VGA);
            if((previous_planar_mode ^ value) & 0x60)
            {
                // Shift mode modified. Pixel buffer invalidated
                this.complete_replot();
            }
            break;
        case 6:
            dbg_log("miscellaneous graphics register: " + h(value), LOG_VGA);
            if(this.miscellaneous_graphics_register !== value)
            {
                this.miscellaneous_graphics_register = value;
                this.update_vga_size();
            }
            break;
        case 7:
            this.color_dont_care = value;
            dbg_log("color don't care: " + h(value), LOG_VGA);
            break;
        case 8:
            this.planar_bitmap = value;
            dbg_log("planar bitmap: " + h(value), LOG_VGA);
            break;
        default:
            dbg_log("3CF / graphics write " + h(this.graphics_index) + ": " + h(value), LOG_VGA);
    }
};

VGAScreen.prototype.port3CF_read = function()
{
    dbg_log("3CF / graphics read " + h(this.graphics_index), LOG_VGA);

    switch(this.graphics_index)
    {
        case 0:
            return this.planar_setreset;
        case 1:
            return this.planar_setreset_enable;
        case 2:
            return this.color_compare;
        case 3:
            return this.planar_rotate_reg;
        case 4:
            return this.plane_read;
        case 5:
            return this.planar_mode;
        case 6:
            return this.miscellaneous_graphics_register;
        case 7:
            return this.color_dont_care;
        case 8:
            return this.planar_bitmap;
        default:
    }
    return 0;
};

VGAScreen.prototype.port3D4_write = function(register)
{
    dbg_log("3D4 / crtc index: " + register, LOG_VGA);
    this.index_crtc = register;
};

VGAScreen.prototype.port3D4_write16 = function(register)
{
    this.port3D4_write(register & 0xFF);
    this.port3D5_write(register >> 8 & 0xFF);
};

VGAScreen.prototype.port3D4_read = function()
{
    dbg_log("3D4 read / crtc index: " + this.index_crtc, LOG_VGA);
    return this.index_crtc;
};

/**
 * CRT controller register writes
 * @see {@link http://www.osdever.net/FreeVGA/vga/crtcreg.htm}
 * @see {@link http://www.mcamafia.de/pdf/ibm_vgaxga_trm2.pdf} page 55
 * @see {@link https://01.org/sites/default/files/documentation/intel-gfx-prm-osrc-hsw-display_0.pdf} page 63
 */
VGAScreen.prototype.port3D5_write = function(value)
{
    switch(this.index_crtc)
    {
        case 0x1:
            dbg_log("3D5 / hdisp enable end write: " + h(value), LOG_VGA);
            if(this.horizontal_display_enable_end !== value)
            {
                this.horizontal_display_enable_end = value;
                this.update_vga_size();
            }
            break;
        case 0x2:
            if(this.horizontal_blank_start !== value)
            {
                this.horizontal_blank_start = value;
                this.update_vga_size();
            }
            break;
        case 0x7:
            dbg_log("3D5 / overflow register write: " + h(value), LOG_VGA);
            var previous_vertical_display_enable_end = this.vertical_display_enable_end;
            this.vertical_display_enable_end &= 0xFF;
            this.vertical_display_enable_end |= (value << 3 & 0x200) | (value << 7 & 0x100);
            if(previous_vertical_display_enable_end !== this.vertical_display_enable_end)
            {
                this.update_vga_size();
            }
            this.line_compare = (this.line_compare & 0x2FF) | (value << 4 & 0x100);

            var previous_vertical_blank_start = this.vertical_blank_start;
            this.vertical_blank_start = (this.vertical_blank_start & 0x2FF) | (value << 5 & 0x100);
            if(previous_vertical_blank_start !== this.vertical_blank_start)
            {
                this.update_vga_size();
            }
            this.update_layers();
            break;
        case 0x8:
            dbg_log("3D5 / preset row scan write: " + h(value), LOG_VGA);
            this.preset_row_scan = value;
            this.update_layers();
            break;
        case 0x9:
            dbg_log("3D5 / max scan line write: " + h(value), LOG_VGA);
            var previous_max_scan_line = this.max_scan_line;
            this.max_scan_line = value;
            this.line_compare = (this.line_compare & 0x1FF) | (value << 3 & 0x200);

            var previous_vertical_blank_start = this.vertical_blank_start;
            this.vertical_blank_start = (this.vertical_blank_start & 0x1FF) | (value << 4 & 0x200);
            if(((previous_max_scan_line ^ this.max_scan_line) & 0x9F) || previous_vertical_blank_start !== this.vertical_blank_start)
            {
                this.update_vga_size();
            }

            this.update_cursor_scanline();
            this.update_layers();

            this.set_font_bitmap(false);
            break;
        case 0xA:
            dbg_log("3D5 / cursor scanline start write: " + h(value), LOG_VGA);
            this.cursor_scanline_start = value;
            this.update_cursor_scanline();
            break;
        case 0xB:
            dbg_log("3D5 / cursor scanline end write: " + h(value), LOG_VGA);
            this.cursor_scanline_end = value;
            this.update_cursor_scanline();
            break;
        case 0xC:
            if((this.start_address >> 8 & 0xFF) !== value)
            {
                this.start_address = this.start_address & 0xff | value << 8;
                this.update_layers();
                if(~this.crtc_mode &  0x3)
                {
                    // Address substitution implementation depends on the
                    // starting row and column, so the pixel buffer is invalidated.
                    this.complete_replot();
                }
            }
            dbg_log("3D5 / start addr hi write: " + h(value) + " -> " + h(this.start_address, 4), LOG_VGA);
            break;
        case 0xD:
            if((this.start_address & 0xFF) !== value)
            {
                this.start_address = this.start_address & 0xff00 | value;
                this.update_layers();
                if(~this.crtc_mode &  0x3)
                {
                    // Address substitution implementation depends on the
                    // starting row and column, so the pixel buffer is invalidated.
                    this.complete_replot();
                }
            }
            dbg_log("3D5 / start addr lo write: " + h(value) + " -> " + h(this.start_address, 4), LOG_VGA);
            break;
        case 0xE:
            dbg_log("3D5 / cursor address hi write: " + h(value), LOG_VGA);
            this.cursor_address = this.cursor_address & 0xFF | value << 8;
            this.update_cursor();
            break;
        case 0xF:
            dbg_log("3D5 / cursor address lo write: " + h(value), LOG_VGA);
            this.cursor_address = this.cursor_address & 0xFF00 | value;
            this.update_cursor();
            break;
        case 0x12:
            dbg_log("3D5 / vdisp enable end write: " + h(value), LOG_VGA);
            if((this.vertical_display_enable_end & 0xFF) !== value)
            {
                this.vertical_display_enable_end = (this.vertical_display_enable_end & 0x300) | value;
                this.update_vga_size();
            }
            break;
        case 0x13:
            dbg_log("3D5 / offset register write: " + h(value), LOG_VGA);
            if(this.offset_register !== value)
            {
                this.offset_register = value;
                this.update_vga_size();

                if(~this.crtc_mode & 0x3)
                {
                    // Address substitution implementation depends on the
                    // virtual width, so the pixel buffer is invalidated.
                    this.complete_replot();
                }
            }
            break;
        case 0x14:
            dbg_log("3D5 / underline location write: " + h(value), LOG_VGA);
            if(this.underline_location_register !== value)
            {
                var previous_underline = this.underline_location_register;

                this.underline_location_register = value;
                this.update_vga_size();

                if((previous_underline ^ value) & 0x40)
                {
                    // Doubleword addressing changed. Pixel buffer invalidated.
                    this.complete_replot();
                }
            }
            break;
        case 0x15:
            dbg_log("3D5 / vertical blank start write: " + h(value), LOG_VGA);
            if((this.vertical_blank_start & 0xFF) !== value)
            {
                this.vertical_blank_start = (this.vertical_blank_start & 0x300) | value;
                this.update_vga_size();
            }
            break;
        case 0x17:
            dbg_log("3D5 / crtc mode write: " + h(value), LOG_VGA);
            if(this.crtc_mode !== value)
            {
                var previous_mode = this.crtc_mode;

                this.crtc_mode = value;
                this.update_vga_size();

                if((previous_mode ^ value) & 0x43)
                {
                    // Word/byte addressing changed or address substitution changed.
                    // Pixel buffer invalidated.
                    this.complete_replot();
                }
            }
            break;
        case 0x18:
            dbg_log("3D5 / line compare write: " + h(value), LOG_VGA);
            this.line_compare = (this.line_compare & 0x300) | value;
            this.update_layers();
            break;
        default:
            if(this.index_crtc < this.crtc.length)
            {
                this.crtc[this.index_crtc] = value;
            }
            dbg_log("3D5 / CRTC write " + h(this.index_crtc) + ": " + h(value), LOG_VGA);
    }

};

VGAScreen.prototype.port3D5_write16 = function(register)
{
    dbg_log("16-bit write to 3D5: " + h(register, 4), LOG_VGA);
    this.port3D5_write(register & 0xFF);
};

VGAScreen.prototype.port3D5_read = function()
{
    dbg_log("3D5 read " + h(this.index_crtc), LOG_VGA);

    switch(this.index_crtc)
    {
        case 0x1:
            return this.horizontal_display_enable_end;
        case 0x2:
            return this.horizontal_blank_start;
        case 0x7:
            return (this.vertical_display_enable_end >> 7 & 0x2) |
                (this.vertical_blank_start >> 5 & 0x8) |
                (this.line_compare >> 4 & 0x10) |
                (this.vertical_display_enable_end >> 3 & 0x40);
        case 0x8:
            return this.preset_row_scan;
        case 0x9:
            return this.max_scan_line;
        case 0xA:
            return this.cursor_scanline_start;
        case 0xB:
            return this.cursor_scanline_end;
        case 0xC:
            return this.start_address & 0xFF;
        case 0xD:
            return this.start_address >> 8;
        case 0xE:
            return this.cursor_address >> 8;
        case 0xF:
            return this.cursor_address & 0xFF;
        case 0x12:
            return this.vertical_display_enable_end & 0xFF;
        case 0x13:
            return this.offset_register;
        case 0x14:
            return this.underline_location_register;
        case 0x15:
            return this.vertical_blank_start & 0xFF;
        case 0x17:
            return this.crtc_mode;
        case 0x18:
            return this.line_compare & 0xFF;
    }

    if(this.index_crtc < this.crtc.length)
    {
        return this.crtc[this.index_crtc];
    }
    else
    {
        return 0;
    }
};

VGAScreen.prototype.port3D5_read16 = function()
{
    dbg_log("Warning: 16-bit read from 3D5", LOG_VGA);
    return this.port3D5_read();
};

VGAScreen.prototype.port3DA_read = function()
{
    dbg_log("3DA read - status 1 and clear attr index", LOG_VGA);

    var value = this.port_3DA_value;

    // Status register, bit 3 set by update_vertical_retrace
    // during screen-fill-buffer
    if(!this.graphical_mode)
    {
        // But screen-fill-buffer may not get triggered in text mode
        // so toggle it manually here
        if(this.port_3DA_value & 1)
        {
            this.port_3DA_value ^= 8;
        }
        this.port_3DA_value ^= 1;
    }
    else
    {
        this.port_3DA_value ^= 1;
        this.port_3DA_value &= 1;
    }
    this.attribute_controller_index = -1;
    return value;
};

VGAScreen.prototype.port1CE_write = function(value)
{
    this.dispi_index = value;
};

VGAScreen.prototype.port1CF_write = function(value)
{
    dbg_log("1CF / dispi write " + h(this.dispi_index) + ": " + h(value), LOG_VGA);

    const was_enabled = this.svga_enabled;

    switch(this.dispi_index)
    {
        case 0:
            if(value >= 0xB0C0 && value <= 0xB0C5)
            {
                this.svga_version = value;
            }
            else
            {
                dbg_log("Invalid version value: " + h(value), LOG_VGA);
            }
            break;
        case 1:
            this.svga_width = value;
            if(this.svga_width > MAX_XRES)
            {
                dbg_log("svga_width reduced from " + this.svga_width + " to " + MAX_XRES, LOG_VGA);
                this.svga_width = MAX_XRES;
            }
            break;
        case 2:
            this.svga_height = value;
            if(this.svga_height > MAX_YRES)
            {
                dbg_log("svga_height reduced from " + this.svga_height + " to " + MAX_YRES, LOG_VGA);
                this.svga_height = MAX_YRES;
            }
            break;
        case 3:
            this.svga_bpp = value;
            break;
        case 4:
            // enable, options
            this.svga_enabled = (value & 1) === 1;
            if(this.svga_enabled && (value & 0x80) === 0)
            {
                this.svga_memory.fill(0);
            }
            this.dispi_enable_value = value;
            break;
        case 5:
            dbg_log("SVGA bank offset: " + h(value << 16), LOG_VGA);
            this.svga_bank_offset = value << 16;
            break;
        case 8:
            // x offset
            dbg_log("SVGA X offset: " + h(value), LOG_VGA);
            if(this.svga_offset_x !== value)
            {
                this.svga_offset_x = value;
                this.svga_offset = this.svga_offset_y * this.svga_width + this.svga_offset_x;
                this.complete_redraw();
            }
            break;
        case 9:
            // y offset
            dbg_log("SVGA Y offset: " + h(value * this.svga_width) + " y=" + h(value), LOG_VGA);
            if(this.svga_offset_y !== value)
            {
                this.svga_offset_y = value;
                this.svga_offset = this.svga_offset_y * this.svga_width + this.svga_offset_x;
                this.complete_redraw();
            }
            break;
        default:
            dbg_log("Unimplemented dispi write index: " + h(this.dispi_index), LOG_VGA);
    }

    if(this.svga_enabled && (!this.svga_width || !this.svga_height))
    {
        dbg_log("SVGA: disabled because of invalid width/height: " + this.svga_width + "x" + this.svga_height, LOG_VGA);
        this.svga_enabled = false;
    }

    dbg_assert(this.svga_bpp !== 4, "unimplemented svga bpp: 4");
    dbg_assert(this.svga_bpp === 4 || this.svga_bpp === 8 ||
               this.svga_bpp === 15 || this.svga_bpp === 16 ||
               this.svga_bpp === 24 || this.svga_bpp === 32,
               "unexpected svga bpp: " + this.svga_bpp);

    if(this.svga_enabled)
    {
        dbg_log("SVGA: enabled, " + this.svga_width + "x" + this.svga_height + "x" + this.svga_bpp, LOG_VGA);
    }
    else
    {
        dbg_log("SVGA: disabled", LOG_VGA);
    }

    if(this.svga_enabled && !was_enabled)
    {
        this.svga_offset = 0;
        this.svga_offset_x = 0;
        this.svga_offset_y = 0;

        this.graphical_mode = true;
        this.screen.set_mode(this.graphical_mode);
        this.set_size_graphical(this.svga_width, this.svga_height, this.svga_width, this.svga_height, this.svga_bpp);
    }

    if(was_enabled && !this.svga_enabled)
    {
        const is_graphical = (this.attribute_mode & 0x1) !== 0;
        this.graphical_mode = is_graphical;
        this.screen.set_mode(is_graphical);
        this.update_vga_size();
        this.set_font_bitmap(false);
        this.complete_redraw();
    }

    if(!this.svga_enabled)
    {
        this.svga_bank_offset = 0;
    }

    this.update_layers();
};

VGAScreen.prototype.port1CF_read = function()
{
    dbg_log("1CF / dispi read " + h(this.dispi_index), LOG_VGA);
    return this.svga_register_read(this.dispi_index);
};

VGAScreen.prototype.svga_register_read = function(n)
{
    switch(n)
    {
        case 0:
            return this.svga_version;
        case 1:
            return this.dispi_enable_value & 2 ? MAX_XRES : this.svga_width;
        case 2:
            return this.dispi_enable_value & 2 ? MAX_YRES : this.svga_height;
        case 3:
            return this.dispi_enable_value & 2 ? MAX_BPP : this.svga_bpp;
        case 4:
            return this.dispi_enable_value;
        case 5:
            return this.svga_bank_offset >>> 16;
        case 6:
            // virtual width
            if(this.screen_width)
            {
                return this.screen_width;
            }
            else
            {
                return 1; // seabios/windows98 divide exception
            }
            break;

        case 8:
            // x offset
            return this.svga_offset_x;
        case 9:
            return this.svga_offset_y;
        case 0x0A:
            // memory size in 64 kilobyte banks
            return this.vga_memory_size / VGA_BANK_SIZE | 0;
        default:
            dbg_log("Unimplemented dispi read index: " + h(this.dispi_index), LOG_VGA);
    }

    return 0xFF;
};

/**
 * Transfers graphics from VGA Planes to the Pixel Buffer
 * VGA Planes represent data stored on actual hardware.
 * Pixel Buffer caches the 4-bit or 8-bit color indices for each pixel.
 */
VGAScreen.prototype.vga_replot = function()
{
    // Round to multiple of 8 towards extreme
    var start = this.diff_plot_min & ~0xF;
    var end = Math.min((this.diff_plot_max | 0xF), VGA_PIXEL_BUFFER_SIZE - 1);

    var addr_shift = this.vga_addr_shift_count();
    var addr_substitution = ~this.crtc_mode & 0x3;

    var shift_mode = this.planar_mode & 0x60;
    var pel_width = this.attribute_mode & 0x40;

    for(var pixel_addr = start; pixel_addr <= end;)
    {
        var addr = pixel_addr >>> addr_shift;
        if(addr_substitution)
        {
            var row = pixel_addr / this.virtual_width | 0;
            var col = pixel_addr - this.virtual_width * row;

            switch(addr_substitution)
            {
                case 0x1:
                    // Alternating rows using bit 13
                    // Assumes max scan line = 1
                    addr = (row & 0x1) << 13;
                    row >>>= 1;
                    break;
                case 0x2:
                    // Alternating rows using bit 14
                    // Assumes max scan line = 3
                    addr = (row & 0x1) << 14;
                    row >>>= 1;
                    break;
                case 0x3:
                    // Cycling through rows using bit 13 and 14
                    // Assumes max scan line = 3
                    addr = (row & 0x3) << 13;
                    row >>>= 2;
                    break;
            }

            addr |= (row * this.virtual_width + col >>> addr_shift) + this.start_address;
        }

        var byte0 = this.plane0[addr];
        var byte1 = this.plane1[addr];
        var byte2 = this.plane2[addr];
        var byte3 = this.plane3[addr];

        var shift_loads = new Uint8Array(8);
        switch(shift_mode)
        {
            // Planar Shift Mode
            // See http://www.osdever.net/FreeVGA/vga/vgaseq.htm
            case 0x00:
                // Shift these, so that the bits for the color are in
                // the correct position in the for loop
                byte0 <<= 0;
                byte1 <<= 1;
                byte2 <<= 2;
                byte3 <<= 3;

                for(var i = 7; i >= 0; i--)
                {
                    shift_loads[7 - i] =
                            byte0 >> i & 1 |
                            byte1 >> i & 2 |
                            byte2 >> i & 4 |
                            byte3 >> i & 8;
                }
                break;

            // Packed Shift Mode, aka Interleaved Shift Mode
            // Video Modes 4h and 5h
            case 0x20:
                shift_loads[0] = (byte0 >> 6 & 0x3) | (byte2 >> 4 & 0xC);
                shift_loads[1] = (byte0 >> 4 & 0x3) | (byte2 >> 2 & 0xC);
                shift_loads[2] = (byte0 >> 2 & 0x3) | (byte2 >> 0 & 0xC);
                shift_loads[3] = (byte0 >> 0 & 0x3) | (byte2 << 2 & 0xC);

                shift_loads[4] = (byte1 >> 6 & 0x3) | (byte3 >> 4 & 0xC);
                shift_loads[5] = (byte1 >> 4 & 0x3) | (byte3 >> 2 & 0xC);
                shift_loads[6] = (byte1 >> 2 & 0x3) | (byte3 >> 0 & 0xC);
                shift_loads[7] = (byte1 >> 0 & 0x3) | (byte3 << 2 & 0xC);
                break;

            // 256-Color Shift Mode
            // Video Modes 13h and unchained 256 color
            case 0x40:
            case 0x60:
                shift_loads[0] = byte0 >> 4 & 0xF;
                shift_loads[1] = byte0 >> 0 & 0xF;
                shift_loads[2] = byte1 >> 4 & 0xF;
                shift_loads[3] = byte1 >> 0 & 0xF;
                shift_loads[4] = byte2 >> 4 & 0xF;
                shift_loads[5] = byte2 >> 0 & 0xF;
                shift_loads[6] = byte3 >> 4 & 0xF;
                shift_loads[7] = byte3 >> 0 & 0xF;
                break;
        }

        if(pel_width)
        {
            // Assemble from two sets of 4 bits.
            for(var i = 0, j = 0; i < 4; i++, pixel_addr++, j += 2)
            {
                this.pixel_buffer[pixel_addr] = (shift_loads[j] << 4) | shift_loads[j + 1];
            }
        }
        else
        {
            for(var i = 0; i < 8; i++, pixel_addr++)
            {
                this.pixel_buffer[pixel_addr] = shift_loads[i];
            }
        }
    }
};

/**
 * Transfers graphics from Pixel Buffer to Destination Image Buffer.
 * The 4-bit/8-bit color indices in the Pixel Buffer are passed through
 * the internal palette (dac_map) and the DAC palette (vga256_palette) to
 * obtain the final 32 bit color that the Canvas API uses.
 */
VGAScreen.prototype.vga_redraw = function()
{
    var start = this.diff_addr_min;
    var end = Math.min(this.diff_addr_max, VGA_PIXEL_BUFFER_SIZE - 1);
    const buffer = new Int32Array(this.cpu.wasm_memory.buffer, this.dest_buffet_offset, this.virtual_width * this.virtual_height);

    var mask = 0xFF;
    var colorset = 0x00;
    if(this.attribute_mode & 0x80)
    {
        // Palette bits 5/4 select
        mask &= 0xCF;
        colorset |= this.color_select << 4 & 0x30;
    }

    if(this.attribute_mode & 0x40)
    {
        // 8 bit mode

        for(var pixel_addr = start; pixel_addr <= end; pixel_addr++)
        {
            var color256 = (this.pixel_buffer[pixel_addr] & mask) | colorset;
            var color = this.vga256_palette[color256];

            buffer[pixel_addr] = color & 0xFF00 | color << 16 | color >> 16 | 0xFF000000;
        }
    }
    else
    {
        // 4 bit mode

        // Palette bits 7/6 select
        mask &= 0x3F;
        colorset |= this.color_select << 4 & 0xC0;

        for(var pixel_addr = start; pixel_addr <= end; pixel_addr++)
        {
            var color16 = this.pixel_buffer[pixel_addr] & this.color_plane_enable;
            var color256 = (this.dac_map[color16] & mask) | colorset;
            var color = this.vga256_palette[color256];

            buffer[pixel_addr] = color & 0xFF00 | color << 16 | color >> 16 | 0xFF000000;
        }
    }
};

VGAScreen.prototype.screen_fill_buffer = function()
{
    if(!this.graphical_mode)
    {
        // text mode
        // Update retrace behaviour anyway - programs waiting for signal before
        // changing to graphical mode
        this.update_vertical_retrace();
        return;
    }

    if(this.image_data.data.byteLength === 0)
    {
        // wasm memory resized
        const buffer = new Uint8ClampedArray(this.cpu.wasm_memory.buffer, this.dest_buffet_offset, 4 * this.virtual_width * this.virtual_height);
        this.image_data = new ImageData(buffer, this.virtual_width, this.virtual_height);
        this.update_layers();
    }

    if(this.svga_enabled)
    {
        let min_y = 0;
        let max_y = this.svga_height;

        if(this.svga_bpp === 8)
        {
            // XXX: Slow, should be ported to rust, but it doesn't have access to vga256_palette
            // XXX: Doesn't take svga_offset into account
            const buffer = new Int32Array(this.cpu.wasm_memory.buffer, this.dest_buffet_offset, this.screen_width * this.screen_height);
            const svga_memory = new Uint8Array(this.cpu.wasm_memory.buffer, this.svga_memory.byteOffset, this.vga_memory_size);

            for(var i = 0; i < buffer.length; i++)
            {
                var color = this.vga256_palette[svga_memory[i]];
                buffer[i] = color & 0xFF00 | color << 16 | color >> 16 | 0xFF000000;
            }
        }
        else
        {
            this.cpu.svga_fill_pixel_buffer(this.svga_bpp, this.svga_offset);

            const bytes_per_pixel = this.svga_bpp === 15 ? 2 : this.svga_bpp / 8;
            min_y = (((this.cpu.svga_dirty_bitmap_min_offset[0] / bytes_per_pixel | 0) - this.svga_offset) / this.svga_width | 0);
            max_y = (((this.cpu.svga_dirty_bitmap_max_offset[0] / bytes_per_pixel | 0) - this.svga_offset) / this.svga_width | 0) + 1;
        }

        if(min_y < max_y)
        {
            min_y = Math.max(min_y, 0);
            max_y = Math.min(max_y, this.svga_height);

            this.screen.update_buffer([{
                image_data: this.image_data,
                screen_x: 0, screen_y: min_y,
                buffer_x: 0, buffer_y: min_y,
                buffer_width: this.svga_width,
                buffer_height: max_y - min_y,
            }]);
        }
    }
    else
    {
        this.vga_replot();
        this.vga_redraw();
        this.screen.update_buffer(this.layers);
    }

    this.reset_diffs();
    this.update_vertical_retrace();
};

VGAScreen.prototype.set_font_bitmap = function(font_plane_dirty)
{
    const height = this.max_scan_line & 0x1f;
    if(height && !this.graphical_mode)
    {
        const width_dbl = !!(this.clocking_mode & 0x08);
        const width_9px = !width_dbl && !(this.clocking_mode & 0x01);
        const copy_8th_col = !!(this.attribute_mode & 0x04);
        this.screen.set_font_bitmap(
            height + 1,         // int height, font height 1..32px
            width_9px,          // bool width_9px, True: font width 9px, else 8px
            width_dbl,          // bool width_dbl, True: font width 16px (overrides width_9px)
            copy_8th_col,       // bool copy_8th_col, True: duplicate 8th into 9th column in ASCII chars 0xC0-0xDF
            this.plane2,        // Uint8Array font_bitmap[64k], static
            font_plane_dirty    // bool bitmap_changed, True: content of this.plane2 has changed
        );
    }
};

VGAScreen.prototype.set_font_page = function()
{
    // bits 2, 3 and 5 (LSB to MSB): VGA font page index of font A
    // bits 0, 1 and 4: VGA font page index of font B
    // linear_index_map[] maps VGA's non-liner font page index to linear index
    const linear_index_map = [0, 2, 4, 6, 1, 3, 5, 7];
    const vga_index_A = ((this.character_map_select & 0b1100) >> 2) | ((this.character_map_select & 0b100000) >> 3);
    const vga_index_B = (this.character_map_select & 0b11) | ((this.character_map_select & 0b10000) >> 2);
    this.font_page_ab_enabled = vga_index_A !== vga_index_B;
    this.screen.set_font_page(linear_index_map[vga_index_A], linear_index_map[vga_index_B]);
    this.complete_redraw();
};
