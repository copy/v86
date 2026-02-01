import {
    LOG_CPU, LOG_BIOS,
    FW_CFG_SIGNATURE, FW_CFG_SIGNATURE_QEMU,
    WASM_TABLE_SIZE, WASM_TABLE_OFFSET, FW_CFG_ID,
    FW_CFG_RAM_SIZE, FW_CFG_NB_CPUS, FW_CFG_MAX_CPUS,
    FW_CFG_NUMA, FW_CFG_FILE_DIR, FW_CFG_FILE_START,
    FW_CFG_CUSTOM_START, FLAGS_DEFAULT,
    MMAP_BLOCK_BITS, MMAP_BLOCK_SIZE, MMAP_MAX,
    REG_ESP, REG_EBP, REG_ESI, REG_EAX, REG_EBX, REG_ECX, REG_EDX, REG_EDI,
    REG_CS, REG_DS, REG_ES, REG_FS, REG_GS, REG_SS, CR0_PG, CR4_PAE, REG_LDTR,
    FLAG_VM, FLAG_INTERRUPT, FLAG_CARRY, FLAG_ADJUST, FLAG_ZERO, FLAG_SIGN, FLAG_TRAP,
    FLAG_DIRECTION, FLAG_OVERFLOW, FLAG_PARITY,
} from "./const.js";
import { h, view, pads, Bitmap, dump_file } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";

import { SB16 } from "./sb16.js";
import { ACPI } from "./acpi.js";
import { PIT } from "./pit.js";
import { DMA } from "./dma.js";
import { UART } from "./uart.js";
import { Ne2k } from "./ne2k.js";
import { IO } from "./io.js";
import { VirtioConsole } from "./virtio_console.js";
import { PCI } from "./pci.js";
import { PS2 } from "./ps2.js";
import { read_elf } from "./elf.js";

import { FloppyController } from "./floppy.js";
import { IDEController } from "./ide.js";
import { VirtioNet } from "./virtio_net.js";
import { VGAScreen } from "./vga.js";
import { VirtioBalloon } from "./virtio_balloon.js";
import { Virtio9p, Virtio9pHandler, Virtio9pProxy } from "../lib/9p.js";

import { load_kernel } from "./kernel.js";

import {
    RTC,
    CMOS_EQUIPMENT_INFO, CMOS_BIOS_SMP_COUNT,
    CMOS_MEM_HIGHMEM_HIGH, CMOS_MEM_HIGHMEM_MID, CMOS_MEM_HIGHMEM_LOW,
    CMOS_DISK_DATA, CMOS_BIOS_DISKTRANSFLAG, CMOS_FLOPPY_DRIVE_TYPE,
    BOOT_ORDER_CD_FIRST, CMOS_BIOS_BOOTFLAG1, CMOS_BIOS_BOOTFLAG2,
    CMOS_MEM_BASE_LOW, CMOS_MEM_BASE_HIGH,
    CMOS_MEM_OLD_EXT_LOW, CMOS_MEM_OLD_EXT_HIGH, CMOS_MEM_EXTMEM_LOW,
    CMOS_MEM_EXTMEM_HIGH, CMOS_MEM_EXTMEM2_LOW, CMOS_MEM_EXTMEM2_HIGH
} from "./rtc.js";


// For Types Only

import { BusConnector } from "./bus.js";

// Resources:
// https://pdos.csail.mit.edu/6.828/2006/readings/i386/toc.htm
// https://www-ssl.intel.com/content/www/us/en/processors/architectures-software-developer-manuals.html
// http://ref.x86asm.net/geek32.html

const DUMP_GENERATED_WASM = false;
const DUMP_UNCOMPILED_ASSEMBLY = false;

/** @constructor */
export function CPU(bus, wm, stop_idling)
{
    this.stop_idling = stop_idling;
    this.wm = wm;
    this.wasm_patch();
    this.create_jit_imports();

    const memory = this.wm.exports.memory;

    this.wasm_memory = memory;

    this.memory_size = view(Uint32Array, memory, 812, 1);

    this.mem8 = new Uint8Array(0);
    this.mem32s = new Int32Array(this.mem8.buffer);

    this.segment_is_null = view(Uint8Array, memory, 724, 8);
    this.segment_offsets = view(Int32Array, memory, 736, 8);
    this.segment_limits = view(Uint32Array, memory, 768, 8);
    this.segment_access_bytes = view(Uint8Array, memory, 512, 8);

    /**
     * Wheter or not in protected mode
     */
    this.protected_mode = view(Int32Array, memory, 800, 1);

    this.idtr_size = view(Int32Array, memory, 564, 1);
    this.idtr_offset = view(Int32Array, memory, 568, 1);

    /**
     * global descriptor table register
     */
    this.gdtr_size = view(Int32Array, memory, 572, 1);
    this.gdtr_offset = view(Int32Array, memory, 576, 1);

    this.tss_size_32 = view(Int32Array, memory, 1128, 1);

    /*
     * whether or not a page fault occured
     */
    this.page_fault = view(Uint32Array, memory, 540, 8);

    this.cr = view(Int32Array, memory, 580, 8);

    // current privilege level
    this.cpl = view(Uint8Array, memory, 612, 1);

    // current operand/address size
    this.is_32 = view(Int32Array, memory, 804, 1);

    this.stack_size_32 = view(Int32Array, memory, 808, 1);

    /**
     * Was the last instruction a hlt?
     */
    this.in_hlt = view(Uint8Array, memory, 616, 1);

    this.last_virt_eip = view(Int32Array, memory, 620, 1);
    this.eip_phys = view(Int32Array, memory, 624, 1);


    this.sysenter_cs = view(Int32Array, memory, 636, 1);

    this.sysenter_esp = view(Int32Array, memory, 640, 1);

    this.sysenter_eip = view(Int32Array, memory, 644, 1);

    this.prefixes = view(Int32Array, memory, 648, 1);

    this.flags = view(Int32Array, memory, 120, 1);

    /**
     * bitmap of flags which are not updated in the flags variable
     * changed by arithmetic instructions, so only relevant to arithmetic flags
     */
    this.flags_changed = view(Int32Array, memory, 100, 1);

    /**
     * enough infos about the last arithmetic operation to compute eflags
     */
    this.last_op_size = view(Int32Array, memory, 96, 1);
    this.last_op1 = view(Int32Array, memory, 104, 1);
    this.last_result = view(Int32Array, memory, 112, 1);

    this.current_tsc = view(Uint32Array, memory, 960, 2); // 64 bit

    /** @type {!Object} */
    this.devices = {};

    this.instruction_pointer = view(Int32Array, memory, 556, 1);
    this.previous_ip = view(Int32Array, memory, 560, 1);

    // configured by guest
    this.apic_enabled = view(Uint8Array, memory, 548, 1);
    // configured when the emulator starts (changes bios initialisation)
    this.acpi_enabled = view(Uint8Array, memory, 552, 1);

    // managed in io.js
    /** @const */ this.memory_map_read8 = [];
    /** @const */ this.memory_map_write8 = [];
    /** @const */ this.memory_map_read32 = [];
    /** @const */ this.memory_map_write32 = [];

    /**
     * @const
     * @type {{main: ArrayBuffer, vga: ArrayBuffer}}
     */
    this.bios = {
        main: null,
        vga: null,
    };

    this.instruction_counter = view(Uint32Array, memory, 664, 1);

    // registers
    this.reg32 = view(Int32Array, memory, 64, 8);

    this.fpu_st = view(Int32Array, memory, 1152, 4 * 8);

    this.fpu_stack_empty = view(Uint8Array, memory, 816, 1);
    this.fpu_stack_empty[0] = 0xFF;
    this.fpu_stack_ptr = view(Uint8Array, memory, 1032, 1);
    this.fpu_stack_ptr[0] = 0;

    this.fpu_control_word = view(Uint16Array, memory, 1036, 1);
    this.fpu_control_word[0] = 0x37F;
    this.fpu_status_word = view(Uint16Array, memory, 1040, 1);
    this.fpu_status_word[0] = 0;
    this.fpu_ip = view(Int32Array, memory, 1048, 1);
    this.fpu_ip[0] = 0;
    this.fpu_ip_selector = view(Int32Array, memory, 1052, 1);
    this.fpu_ip_selector[0] = 0;
    this.fpu_opcode = view(Int32Array, memory, 1044, 1);
    this.fpu_opcode[0] = 0;
    this.fpu_dp = view(Int32Array, memory, 1056, 1);
    this.fpu_dp[0] = 0;
    this.fpu_dp_selector = view(Int32Array, memory, 1060, 1);
    this.fpu_dp_selector[0] = 0;

    this.reg_xmm32s = view(Int32Array, memory, 832, 8 * 4);

    this.mxcsr = view(Int32Array, memory, 824, 1);

    // segment registers, tr and ldtr
    this.sreg = view(Uint16Array, memory, 668, 8);

    // debug registers
    this.dreg = view(Int32Array, memory, 684, 8);

    this.reg_pdpte = view(Int32Array, memory, 968, 8);

    this.svga_dirty_bitmap_min_offset = view(Uint32Array, memory, 716, 1);
    this.svga_dirty_bitmap_max_offset = view(Uint32Array, memory, 720, 1);

    this.fw_value = [];
    this.fw_pointer = 0;
    this.option_roms = [];

    this.io = undefined;

    this.bus = bus;

    this.set_tsc(0, 0);

    if(DEBUG)
    {
        this.seen_code = {};
        this.seen_code_uncompiled = {};
    }

    //Object.seal(this);
}

CPU.prototype.mmap_read8 = function(addr)
{
    const value = this.memory_map_read8[addr >>> MMAP_BLOCK_BITS](addr);
    dbg_assert(value >= 0 && value <= 0xFF);
    return value;
};

CPU.prototype.mmap_write8 = function(addr, value)
{
    dbg_assert(value >= 0 && value <= 0xFF);
    this.memory_map_write8[addr >>> MMAP_BLOCK_BITS](addr, value);
};

CPU.prototype.mmap_write16 = function(addr, value)
{
    var fn = this.memory_map_write8[addr >>> MMAP_BLOCK_BITS];

    dbg_assert(value >= 0 && value <= 0xFFFF);
    fn(addr, value & 0xFF);
    fn(addr + 1 | 0, value >> 8);
};

CPU.prototype.mmap_read32 = function(addr)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;

    return this.memory_map_read32[aligned_addr](addr);
};

CPU.prototype.mmap_write32 = function(addr, value)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;

    this.memory_map_write32[aligned_addr](addr, value);
};

CPU.prototype.mmap_write64 = function(addr, value0, value1)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;
    // This should hold since writes across pages are split up
    dbg_assert(aligned_addr === (addr + 7) >>> MMAP_BLOCK_BITS);

    var write_func32 = this.memory_map_write32[aligned_addr];
    write_func32(addr, value0);
    write_func32(addr + 4, value1);
};

CPU.prototype.mmap_write128 = function(addr, value0, value1, value2, value3)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;
    // This should hold since writes across pages are split up
    dbg_assert(aligned_addr === (addr + 12) >>> MMAP_BLOCK_BITS);

    var write_func32 = this.memory_map_write32[aligned_addr];
    write_func32(addr, value0);
    write_func32(addr + 4, value1);
    write_func32(addr + 8, value2);
    write_func32(addr + 12, value3);
};

/**
 * @param {Array.<number>|Uint8Array} blob
 * @param {number} offset
 */
CPU.prototype.write_blob = function(blob, offset)
{
    dbg_assert(blob && blob.length >= 0);

    if(blob.length)
    {
        dbg_assert(!this.in_mapped_range(offset));
        dbg_assert(!this.in_mapped_range(offset + blob.length - 1));

        this.jit_dirty_cache(offset, offset + blob.length);
        this.mem8.set(blob, offset);
    }
};

CPU.prototype.read_blob = function(offset, length)
{
    if(length)
    {
        dbg_assert(!this.in_mapped_range(offset));
        dbg_assert(!this.in_mapped_range(offset + length - 1));
    }
    return this.mem8.subarray(offset, offset + length);
};

CPU.prototype.clear_opstats = function()
{
    new Uint8Array(this.wasm_memory.buffer, 0x8000, 0x20000).fill(0);
    this.wm.exports["profiler_init"]();
};

CPU.prototype.create_jit_imports = function()
{
    // Set this.jit_imports as generated WASM modules will expect

    const jit_imports = Object.create(null);

    jit_imports["m"] = this.wm.exports["memory"];

    for(const name of Object.keys(this.wm.exports))
    {
        if(name.startsWith("_") || name.startsWith("zstd") || name.endsWith("_js"))
        {
            continue;
        }

        jit_imports[name] = this.wm.exports[name];
    }

    this.jit_imports = jit_imports;
};

CPU.prototype.wasm_patch = function()
{
    const get_optional_import = name => this.wm.exports[name];

    const get_import = name =>
    {
        const f = get_optional_import(name);
        console.assert(f, "Missing import: " + name);
        return f;
    };

    this.reset_cpu = get_import("reset_cpu");

    this.getiopl = get_import("getiopl");
    this.get_eflags = get_import("get_eflags");

    this.handle_irqs = get_import("handle_irqs");

    this.main_loop = get_import("main_loop");

    this.set_jit_config = get_import("set_jit_config");

    this.read8 = get_import("read8");
    this.read16 = get_import("read16");
    this.read32s = get_import("read32s");
    this.write8 = get_import("write8");
    this.write16 = get_import("write16");
    this.write32 = get_import("write32");
    this.in_mapped_range = get_import("in_mapped_range");

    // used by nasmtests
    this.fpu_load_tag_word = get_import("fpu_load_tag_word");
    this.fpu_load_status_word = get_import("fpu_load_status_word");
    this.fpu_get_sti_f64 = get_import("fpu_get_sti_f64");

    this.translate_address_system_read = get_import("translate_address_system_read_js");

    this.get_seg_cs = get_import("get_seg_cs");
    this.get_real_eip = get_import("get_real_eip");

    this.clear_tlb = get_import("clear_tlb");
    this.full_clear_tlb = get_import("full_clear_tlb");
    this.update_state_flags = get_import("update_state_flags");

    this.set_tsc = get_import("set_tsc");
    this.store_current_tsc = get_import("store_current_tsc");

    this.set_cpuid_level = get_import("set_cpuid_level");

    this.device_raise_irq = get_import("device_raise_irq");
    this.device_lower_irq = get_import("device_lower_irq");

    this.apic_timer = get_import("apic_timer");

    if(DEBUG)
    {
        this.jit_force_generate_unsafe = get_optional_import("jit_force_generate_unsafe");
    }

    this.jit_clear_cache = get_import("jit_clear_cache_js");
    this.jit_dirty_cache = get_import("jit_dirty_cache");
    this.codegen_finalize_finished = get_import("codegen_finalize_finished");

    this.allocate_memory = get_import("allocate_memory");
    this.zero_memory = get_import("zero_memory");
    this.is_memory_zeroed = get_import("is_memory_zeroed");

    this.svga_allocate_memory = get_import("svga_allocate_memory");
    this.svga_allocate_dest_buffer = get_import("svga_allocate_dest_buffer");
    this.svga_fill_pixel_buffer = get_import("svga_fill_pixel_buffer");
    this.svga_mark_dirty = get_import("svga_mark_dirty");

    this.get_pic_addr_master = get_import("get_pic_addr_master");
    this.get_pic_addr_slave = get_import("get_pic_addr_slave");
    this.get_apic_addr = get_import("get_apic_addr");
    this.get_ioapic_addr = get_import("get_ioapic_addr");

    this.zstd_create_ctx = get_import("zstd_create_ctx");
    this.zstd_get_src_ptr = get_import("zstd_get_src_ptr");
    this.zstd_free_ctx = get_import("zstd_free_ctx");
    this.zstd_read = get_import("zstd_read");
    this.zstd_read_free = get_import("zstd_read_free");
};

CPU.prototype.jit_force_generate = function(addr)
{
    if(!this.jit_force_generate_unsafe)
    {
        dbg_assert(false, "Not supported in this wasm build: jit_force_generate_unsafe");
        return;
    }

    this.jit_force_generate_unsafe(addr);
};

CPU.prototype.jit_clear_func = function(index)
{
    dbg_assert(index >= 0 && index < WASM_TABLE_SIZE);
    this.wm.wasm_table.set(index + WASM_TABLE_OFFSET, null);
};

CPU.prototype.jit_clear_all_funcs = function()
{
    const table = this.wm.wasm_table;

    for(let i = 0; i < WASM_TABLE_SIZE; i++)
    {
        table.set(WASM_TABLE_OFFSET + i, null);
    }
};

CPU.prototype.get_state = function()
{
    var state = [];

    state[0] = this.memory_size[0];
    state[1] = new Uint8Array([...this.segment_is_null, ...this.segment_access_bytes]);
    state[2] = this.segment_offsets;
    state[3] = this.segment_limits;
    state[4] = this.protected_mode[0];
    state[5] = this.idtr_offset[0];
    state[6] = this.idtr_size[0];
    state[7] = this.gdtr_offset[0];
    state[8] = this.gdtr_size[0];
    state[9] = this.page_fault[0];
    state[10] = this.cr;
    state[11] = this.cpl[0];

    state[13] = this.is_32[0];

    state[16] = this.stack_size_32[0];
    state[17] = this.in_hlt[0];
    state[18] = this.last_virt_eip[0];
    state[19] = this.eip_phys[0];

    state[22] = this.sysenter_cs[0];
    state[23] = this.sysenter_eip[0];
    state[24] = this.sysenter_esp[0];
    state[25] = this.prefixes[0];
    state[26] = this.flags[0];
    state[27] = this.flags_changed[0];
    state[28] = this.last_op1[0];

    state[30] = this.last_op_size[0];

    state[37] = this.instruction_pointer[0];
    state[38] = this.previous_ip[0];
    state[39] = this.reg32;
    state[40] = this.sreg;
    state[41] = this.dreg;
    state[42] = this.reg_pdpte;

    this.store_current_tsc();
    state[43] = this.current_tsc;

    state[45] = this.devices.virtio_9p;
    state[46] = this.get_state_apic();
    state[47] = this.devices.rtc;
    state[48] = this.devices.pci;
    state[49] = this.devices.dma;
    state[50] = this.devices.acpi;
    // 51 (formerly hpet)
    state[52] = this.devices.vga;
    state[53] = this.devices.ps2;
    state[54] = this.devices.uart0;
    state[55] = this.devices.fdc;

    if(!this.devices.ide.secondary)
    {
        if(this.devices.ide.primary?.master.is_atapi)
        {
            state[56] = this.devices.ide.primary;
        }
        else
        {
            state[57] = this.devices.ide.primary;
        }
    }
    else
    {
        state[85] = this.devices.ide;
    }

    state[58] = this.devices.pit;
    state[59] = this.devices.net;
    state[60] = this.get_state_pic();
    state[61] = this.devices.sb16;

    state[62] = this.fw_value;

    state[63] = this.get_state_ioapic();

    state[64] = this.tss_size_32[0];

    state[66] = this.reg_xmm32s;

    state[67] = this.fpu_st;
    state[68] = this.fpu_stack_empty[0];
    state[69] = this.fpu_stack_ptr[0];
    state[70] = this.fpu_control_word[0];
    state[71] = this.fpu_ip[0];
    state[72] = this.fpu_ip_selector[0];
    state[73] = this.fpu_dp[0];
    state[74] = this.fpu_dp_selector[0];
    state[75] = this.fpu_opcode[0];

    const { packed_memory, bitmap } = this.pack_memory();
    state[77] = packed_memory;
    state[78] = new Uint8Array(bitmap.get_buffer());

    state[79] = this.devices.uart1;
    state[80] = this.devices.uart2;
    state[81] = this.devices.uart3;
    state[82] = this.devices.virtio_console;
    state[83] = this.devices.virtio_net;
    state[84] = this.devices.virtio_balloon;

    // state[85] new ide set above

    state[86] = this.last_result;
    state[87] = this.fpu_status_word;
    state[88] = this.mxcsr;

    return state;
};

CPU.prototype.get_state_pic = function()
{
    const pic_size = 13;
    const pic = new Uint8Array(this.wasm_memory.buffer, this.get_pic_addr_master(), pic_size);
    const pic_slave = new Uint8Array(this.wasm_memory.buffer, this.get_pic_addr_slave(), pic_size);

    const state = [];
    const state_slave = [];

    state[0] = pic[0]; // irq_mask
    state[1] = pic[1]; // irq_map
    state[2] = pic[2]; // isr
    state[3] = pic[3]; // irr
    state[4] = pic[4]; // is_master
    state[5] = state_slave;
    state[6] = pic[6]; // expect_icw4
    state[7] = pic[7]; // state
    state[8] = pic[8]; // read_isr
    state[9] = pic[9]; // auto_eoi
    state[10] = pic[10]; // elcr
    state[11] = pic[11]; // irq_value
    state[12] = pic[12]; // special_mask_mode

    state_slave[0] = pic_slave[0]; // irq_mask
    state_slave[1] = pic_slave[1]; // irq_map
    state_slave[2] = pic_slave[2]; // isr
    state_slave[3] = pic_slave[3]; // irr
    state_slave[4] = pic_slave[4]; // is_master
    state_slave[5] = null;
    state_slave[6] = pic_slave[6]; // expect_icw4
    state_slave[7] = pic_slave[7]; // state
    state_slave[8] = pic_slave[8]; // read_isr
    state_slave[9] = pic_slave[9]; // auto_eoi
    state_slave[10] = pic_slave[10]; // elcr
    state_slave[11] = pic_slave[11]; // irq_value
    state_slave[12] = pic_slave[12]; // special_mask_mode

    return state;
};

CPU.prototype.get_state_apic = function()
{
    const APIC_STRUCT_SIZE = 4 * 46; // keep in sync with apic.rs
    return new Uint8Array(this.wasm_memory.buffer, this.get_apic_addr(), APIC_STRUCT_SIZE);
};

CPU.prototype.get_state_ioapic = function()
{
    const IOAPIC_STRUCT_SIZE = 4 * 52; // keep in sync with ioapic.rs
    return new Uint8Array(this.wasm_memory.buffer, this.get_ioapic_addr(), IOAPIC_STRUCT_SIZE);
};

CPU.prototype.set_state = function(state)
{
    this.memory_size[0] = state[0];

    if(this.mem8.length !== this.memory_size[0])
    {
        console.warn("Note: Memory size mismatch. we=" + this.mem8.length + " state=" + this.memory_size[0]);
    }

    if(state[1].length === 8)
    {
        // NOTE: support for old state images; delete this when bumping STATE_VERSION
        this.segment_is_null.set(state[1]);
        this.segment_access_bytes.fill(0x80 | (3 << 5) | 0x10 | 0x02);
        this.segment_access_bytes[REG_CS] = 0x80 | (3 << 5) | 0x10 | 0x08 | 0x02;
    }
    else if(state[1].length === 16)
    {
        this.segment_is_null.set(state[1].subarray(0, 8));
        this.segment_access_bytes.set(state[1].subarray(8, 16));
    }
    else
    {
        dbg_assert("Unexpected cpu segment state length:" + state[1].length);
    }
    this.segment_offsets.set(state[2]);
    this.segment_limits.set(state[3]);

    this.protected_mode[0] = state[4];
    this.idtr_offset[0] = state[5];
    this.idtr_size[0] = state[6];
    this.gdtr_offset[0] = state[7];
    this.gdtr_size[0] = state[8];
    this.page_fault[0] = state[9];
    this.cr.set(state[10]);
    this.cpl[0] = state[11];

    this.is_32[0] = state[13];

    this.stack_size_32[0] = state[16];

    this.in_hlt[0] = state[17];
    this.last_virt_eip[0] = state[18];
    this.eip_phys[0] = state[19];

    this.sysenter_cs[0] = state[22];
    this.sysenter_eip[0] = state[23];
    this.sysenter_esp[0] = state[24];
    this.prefixes[0] = state[25];

    this.flags[0] = state[26];
    this.flags_changed[0] = state[27];
    this.last_op1[0] = state[28];

    this.last_op_size[0] = state[30];

    this.instruction_pointer[0] = state[37];
    this.previous_ip[0] = state[38];
    this.reg32.set(state[39]);
    this.sreg.set(state[40]);
    this.dreg.set(state[41]);
    state[42] && this.reg_pdpte.set(state[42]);

    this.set_tsc(state[43][0], state[43][1]);

    this.devices.virtio_9p && this.devices.virtio_9p.set_state(state[45]);
    state[46] && this.set_state_apic(state[46]);
    this.devices.rtc && this.devices.rtc.set_state(state[47]);
    this.devices.dma && this.devices.dma.set_state(state[49]);
    this.devices.acpi && this.devices.acpi.set_state(state[50]);
    // 51 (formerly hpet)
    this.devices.vga && this.devices.vga.set_state(state[52]);
    this.devices.ps2 && this.devices.ps2.set_state(state[53]);
    this.devices.uart0 && this.devices.uart0.set_state(state[54]);
    this.devices.fdc && this.devices.fdc.set_state(state[55]);

    if(state[56] || state[57])
    {
        // ide device from older version of v86, only primary: state[56] contains cdrom, state[57] contains hard drive

        const ide_config = [[undefined, undefined], [undefined, undefined]];
        if(state[56])
        {
            ide_config[0][0] = { is_cdrom: true, buffer: this.devices.cdrom.buffer };
        }
        else
        {
            ide_config[0][0] = { is_cdrom: false, buffer: this.devices.ide.primary.master.buffer };

        }
        this.devices.ide = new IDEController(this, this.devices.ide.bus, ide_config);
        this.devices.cdrom = state[56] ? this.devices.ide.primary.master : undefined;
        this.devices.ide.primary.set_state(state[56] || state[57]);
    }
    else if(state[85])
    {
        this.devices.ide.set_state(state[85]);
    }

    this.devices.pci && this.devices.pci.set_state(state[48]);

    this.devices.pit && this.devices.pit.set_state(state[58]);
    this.devices.net && this.devices.net.set_state(state[59]);
    this.set_state_pic(state[60]);
    this.devices.sb16 && this.devices.sb16.set_state(state[61]);

    this.devices.uart1 && this.devices.uart1.set_state(state[79]);
    this.devices.uart2 && this.devices.uart2.set_state(state[80]);
    this.devices.uart3 && this.devices.uart3.set_state(state[81]);
    this.devices.virtio_console && this.devices.virtio_console.set_state(state[82]);
    this.devices.virtio_net && this.devices.virtio_net.set_state(state[83]);
    this.devices.virtio_balloon && this.devices.virtio_balloon.set_state(state[84]);

    this.fw_value = state[62];

    state[63] && this.set_state_ioapic(state[63]);

    this.tss_size_32[0] = state[64];

    this.reg_xmm32s.set(state[66]);

    this.fpu_st.set(state[67]);
    this.fpu_stack_empty[0] = state[68];
    this.fpu_stack_ptr[0] = state[69];
    this.fpu_control_word[0] = state[70];
    this.fpu_ip[0] = state[71];
    this.fpu_ip_selector[0] = state[72];
    this.fpu_dp[0] = state[73];
    this.fpu_dp_selector[0] = state[74];
    this.fpu_opcode[0] = state[75];

    if(state[86] !== undefined) this.last_result = state[86];
    if(state[87] !== undefined) this.fpu_status_word = state[87];
    if(state[88] !== undefined) this.mxcsr = state[88];

    const bitmap = new Bitmap(state[78].buffer);
    const packed_memory = state[77];
    this.unpack_memory(bitmap, packed_memory);

    this.update_state_flags();

    this.full_clear_tlb();

    this.jit_clear_cache();
};

CPU.prototype.set_state_pic = function(state)
{
    // Note: This could exists for compatibility with old state images
    // It should be deleted when the state version changes

    const pic_size = 13;
    const pic = new Uint8Array(this.wasm_memory.buffer, this.get_pic_addr_master(), pic_size);
    const pic_slave = new Uint8Array(this.wasm_memory.buffer, this.get_pic_addr_slave(), pic_size);

    pic[0] = state[0]; // irq_mask
    pic[1] = state[1]; // irq_map
    pic[2] = state[2]; // isr
    pic[3] = state[3]; // irr
    pic[4] = state[4]; // is_master
    const state_slave = state[5];
    pic[6] = state[6]; // expect_icw4
    pic[7] = state[7]; // state
    pic[8] = state[8]; // read_isr
    pic[9] = state[9]; // auto_eoi
    pic[10] = state[10]; // elcr
    pic[11] = state[11]; // irq_value (undefined in old state images)
    pic[12] = state[12]; // special_mask_mode (undefined in old state images)

    pic_slave[0] = state_slave[0]; // irq_mask
    pic_slave[1] = state_slave[1]; // irq_map
    pic_slave[2] = state_slave[2]; // isr
    pic_slave[3] = state_slave[3]; // irr
    pic_slave[4] = state_slave[4]; // is_master
    // dummy
    pic_slave[6] = state_slave[6]; // expect_icw4
    pic_slave[7] = state_slave[7]; // state
    pic_slave[8] = state_slave[8]; // read_isr
    pic_slave[9] = state_slave[9]; // auto_eoi
    pic_slave[10] = state_slave[10]; // elcr
    pic_slave[11] = state_slave[11]; // irq_value (undefined in old state images)
    pic_slave[12] = state_slave[12]; // special_mask_mode (undefined in old state images)
};

CPU.prototype.set_state_apic = function(state)
{
    const APIC_STRUCT_SIZE = 4 * 46; // keep in sync with apic.rs
    const IOAPIC_CONFIG_MASKED = 1 << 16;

    if(state instanceof Array)
    {
        // old js state image; delete this code path when the state version changes
        const apic = new Int32Array(this.wasm_memory.buffer, this.get_apic_addr(), APIC_STRUCT_SIZE >> 2);
        apic[0] = state[0]; // apic_id
        apic[1] = state[1]; // timer_divier
        apic[2] = state[2]; // timer_divider_shift
        apic[3] = state[3]; // timer_initial_count
        apic[4] = state[4]; // timer_current_count
        // skip next_tick (in js: state[4]; in rust: apic[6] and apic[7])
        apic[8] = state[6]; // lvt_timer
        apic[9] = state[7]; // lvt_perf_counter
        apic[10] = state[8]; // lvt_int0
        apic[11] = state[9]; // lvt_int1
        apic[12] = state[10]; // lvt_error
        apic[13] = state[11]; // tpr
        apic[14] = state[12]; // icr0
        apic[15] = state[13]; // icr1
        apic.set(state[15], 16); // irr
        apic.set(state[15], 24); // isr
        apic.set(state[16], 32); // tmr
        apic[40] = state[17]; // spurious_vector
        apic[41] = state[18]; // destination_format
        apic[42] = state[19]; // local_destination
        apic[43] = state[20]; // error
        apic[44] = state[21]; // read_error
        apic[45] = state[22] || IOAPIC_CONFIG_MASKED; // lvt_thermal_sensor
    }
    else
    {
        const apic = new Uint8Array(this.wasm_memory.buffer, this.get_apic_addr(), APIC_STRUCT_SIZE);
        dbg_assert(state instanceof Uint8Array);
        dbg_assert(state.length === apic.length); // later versions might need to handle state upgrades here
        apic.set(state);
    }
};

CPU.prototype.set_state_ioapic = function(state)
{
    const IOAPIC_STRUCT_SIZE = 4 * 52; // keep in sync with ioapic.rs

    if(state instanceof Array)
    {
        // old js state image; delete this code path when the state version changes
        dbg_assert(state[0].length === 24);
        dbg_assert(state[1].length === 24);
        dbg_assert(state.length === 6);
        const ioapic = new Int32Array(this.wasm_memory.buffer, this.get_ioapic_addr(), IOAPIC_STRUCT_SIZE >> 2);
        ioapic.set(state[0], 0); // ioredtbl_config
        ioapic.set(state[1], 24); // ioredtbl_destination
        ioapic[48] = state[2]; // ioregsel
        ioapic[49] = state[3]; // ioapic_id
        ioapic[50] = state[4]; // irr
        ioapic[51] = state[5]; // irq_value
    }
    else
    {
        const ioapic = new Uint8Array(this.wasm_memory.buffer, this.get_ioapic_addr(), IOAPIC_STRUCT_SIZE);
        dbg_assert(state instanceof Uint8Array);
        dbg_assert(state.length === ioapic.length); // later versions might need to handle state upgrades here
        ioapic.set(state);
    }
};

CPU.prototype.pack_memory = function()
{
    dbg_assert((this.mem8.length & 0xFFF) === 0);

    const page_count = this.mem8.length >> 12;
    const nonzero_pages = [];
    for(let page = 0; page < page_count; page++)
    {
        if(!this.is_memory_zeroed(page << 12, 0x1000))
        {
            nonzero_pages.push(page);
        }
    }

    const bitmap = new Bitmap(page_count);
    const packed_memory = new Uint8Array(nonzero_pages.length << 12);

    for(const [i, page] of nonzero_pages.entries())
    {
        bitmap.set(page, 1);

        const offset = page << 12;
        const page_contents = this.mem8.subarray(offset, offset + 0x1000);
        packed_memory.set(page_contents, i << 12);
    }

    return { bitmap, packed_memory };
};

CPU.prototype.unpack_memory = function(bitmap, packed_memory)
{
    this.zero_memory(0, this.memory_size[0]);

    const page_count = this.memory_size[0] >> 12;
    let packed_page = 0;

    for(let page = 0; page < page_count; page++)
    {
        if(bitmap.get(page))
        {
            const offset = packed_page << 12;
            const view = packed_memory.subarray(offset, offset + 0x1000);
            this.mem8.set(view, page << 12);
            packed_page++;
        }
    }
};

CPU.prototype.reboot_internal = function()
{
    this.reset_cpu();

    this.fw_value = [];

    if(this.devices.virtio_9p)
    {
        this.devices.virtio_9p.reset();
    }
    if(this.devices.virtio_console)
    {
        this.devices.virtio_console.reset();
    }
    if(this.devices.virtio_net)
    {
        this.devices.virtio_net.reset();
    }
    if(this.devices.ps2)
    {
        this.devices.ps2.reset();
    }

    this.load_bios();
};

CPU.prototype.reset_memory = function()
{
    this.mem8.fill(0);
};

CPU.prototype.create_memory = function(size, minimum_size)
{
    if(size < minimum_size)
    {
        size = minimum_size;
        dbg_log("Rounding memory size up to " + size, LOG_CPU);
    }
    else if((size | 0) < 0)
    {
        size = Math.pow(2, 31) - MMAP_BLOCK_SIZE;
        dbg_log("Rounding memory size down to " + size, LOG_CPU);
    }

    size = ((size - 1) | (MMAP_BLOCK_SIZE - 1)) + 1 | 0;
    dbg_assert((size | 0) > 0);
    dbg_assert((size & MMAP_BLOCK_SIZE - 1) === 0);

    console.assert(this.memory_size[0] === 0, "Expected uninitialised memory");

    this.memory_size[0] = size;

    const memory_offset = this.allocate_memory(size);

    this.mem8 = view(Uint8Array, this.wasm_memory, memory_offset, size);
    this.mem32s = view(Uint32Array, this.wasm_memory, memory_offset, size >> 2);
};

/**
 * @param {BusConnector} device_bus
 */
CPU.prototype.init = function(settings, device_bus)
{
    this.create_memory(
        settings.memory_size || 64 * 1024 * 1024,
        settings.initrd ? 64 * 1024 * 1024 : 1024 * 1024,
    );

    if(settings.disable_jit)
    {
        this.set_jit_config(0, 1);
    }

    settings.cpuid_level && this.set_cpuid_level(settings.cpuid_level);

    this.acpi_enabled[0] = +settings.acpi;

    this.reset_cpu();

    var io = new IO(this);
    this.io = io;

    this.bios.main = settings.bios;
    this.bios.vga = settings.vga_bios;

    this.load_bios();

    if(settings.bzimage)
    {
        const option_rom = load_kernel(this.mem8, settings.bzimage, settings.initrd, settings.cmdline || "");

        if(option_rom)
        {
            this.option_roms.push(option_rom);
        }
    }

    io.register_read(0xB3, this, function()
    {
        // seabios smm_relocate_and_restore
        dbg_log("port 0xB3 read");
        return 0;
    });

    var a20_byte = 0;

    io.register_read(0x92, this, function()
    {
        return a20_byte;
    });

    io.register_write(0x92, this, function(out_byte)
    {
        a20_byte = out_byte;
    });

    io.register_read(0x511, this, function()
    {
        // bios config port (used by seabios and kvm-unit-test)
        if(this.fw_pointer < this.fw_value.length)
        {
            return this.fw_value[this.fw_pointer++];
        }
        else
        {
            dbg_assert(false, "config port: Read past value");
            return 0;
        }
    });
    io.register_write(0x510, this, undefined, function(value)
    {
        // https://wiki.osdev.org/QEMU_fw_cfg
        // https://github.com/qemu/qemu/blob/master/docs/specs/fw_cfg.txt

        dbg_log("bios config port, index=" + h(value));

        function i32(x)
        {
            return new Uint8Array(Int32Array.of(x).buffer);
        }

        function to_be16(x)
        {
            return x >> 8 | x << 8 & 0xFF00;
        }

        function to_be32(x)
        {
            return x << 24 | x << 8 & 0xFF0000 | x >> 8 & 0xFF00 | x >>> 24;
        }

        this.fw_pointer = 0;

        if(value === FW_CFG_SIGNATURE)
        {
            // Pretend to be qemu (for seabios)
            this.fw_value = i32(FW_CFG_SIGNATURE_QEMU);
        }
        else if(value === FW_CFG_ID)
        {
            this.fw_value = i32(0);
        }
        else if(value === FW_CFG_RAM_SIZE)
        {
            this.fw_value = i32(this.memory_size[0]);
        }
        else if(value === FW_CFG_NB_CPUS)
        {
            this.fw_value = i32(1);
        }
        else if(value === FW_CFG_MAX_CPUS)
        {
            this.fw_value = i32(1);
        }
        else if(value === FW_CFG_NUMA)
        {
            this.fw_value = new Uint8Array(16);
        }
        else if(value === FW_CFG_FILE_DIR)
        {
            const buffer_size = 4 + 64 * this.option_roms.length;
            const buffer32 = new Int32Array(buffer_size);
            const buffer8 = new Uint8Array(buffer32.buffer);

            buffer32[0] = to_be32(this.option_roms.length);

            for(let i = 0; i < this.option_roms.length; i++)
            {
                const { name, data } = this.option_roms[i];
                const file_struct_ptr = 4 + 64 * i;

                dbg_assert(FW_CFG_FILE_START + i < 0x10000);
                buffer32[file_struct_ptr + 0 >> 2] = to_be32(data.length);
                buffer32[file_struct_ptr + 4 >> 2] = to_be16(FW_CFG_FILE_START + i);

                dbg_assert(name.length < 64 - 8);

                for(let j = 0; j < name.length; j++)
                {
                    buffer8[file_struct_ptr + 8 + j] = name.charCodeAt(j);
                }
            }

            this.fw_value = buffer8;
        }
        else if(value >= FW_CFG_CUSTOM_START && value < FW_CFG_FILE_START)
        {
            this.fw_value = i32(0);
        }
        else if(value >= FW_CFG_FILE_START && value - FW_CFG_FILE_START < this.option_roms.length)
        {
            const i = value - FW_CFG_FILE_START;
            this.fw_value = this.option_roms[i].data;
        }
        else
        {
            dbg_log("Warning: Unimplemented fw index: " + h(value));
            this.fw_value = i32(0);
        }
    });

    if(DEBUG)
    {
        // Avoid logging noisey ports
        io.register_write(0x80, this, function(out_byte) {});
        io.register_read(0x80, this, function() { return 0xFF; });
        io.register_write(0xE9, this, function(out_byte) {});
    }

    this.devices = {};

    // TODO: Make this more configurable
    if(settings.load_devices)
    {
        this.devices.pci = new PCI(this);

        if(this.acpi_enabled[0])
        {
            this.devices.acpi = new ACPI(this);
        }

        this.devices.rtc = new RTC(this);
        this.fill_cmos(this.devices.rtc, settings);

        this.devices.dma = new DMA(this);

        this.devices.vga = new VGAScreen(this, device_bus, settings.screen, settings.vga_memory_size || 8 * 1024 * 1024);

        this.devices.ps2 = new PS2(this, device_bus);

        this.devices.uart0 = new UART(this, 0x3F8, device_bus);

        if(settings.uart1)
        {
            this.devices.uart1 = new UART(this, 0x2F8, device_bus);
        }
        if(settings.uart2)
        {
            this.devices.uart2 = new UART(this, 0x3E8, device_bus);
        }
        if(settings.uart3)
        {
            this.devices.uart3 = new UART(this, 0x2E8, device_bus);
        }

        this.devices.fdc = new FloppyController(this, settings.fda, settings.fdb);

        const ide_config = [[undefined, undefined], [undefined, undefined]];
        if(settings.hda)
        {
            ide_config[0][0] = { buffer: settings.hda };
            ide_config[0][1] = { buffer: settings.hdb };
        }
        ide_config[1][0] = { is_cdrom: true, buffer: settings.cdrom };
        this.devices.ide = new IDEController(this, device_bus, ide_config);
        this.devices.cdrom = this.devices.ide.secondary.master;

        this.devices.pit = new PIT(this, device_bus);

        if(settings.net_device.type === "ne2k")
        {
            this.devices.net = new Ne2k(this, device_bus, settings.preserve_mac_from_state_image, settings.mac_address_translation);
        }
        else if(settings.net_device.type === "virtio")
        {
            this.devices.virtio_net = new VirtioNet(this, device_bus, settings.preserve_mac_from_state_image, settings.net_device.mtu);
        }

        if(settings.fs9p)
        {
            this.devices.virtio_9p = new Virtio9p(settings.fs9p, this, device_bus);
        }
        else if(settings.handle9p)
        {
            this.devices.virtio_9p = new Virtio9pHandler(settings.handle9p, this);
        }
        else if(settings.proxy9p)
        {
            this.devices.virtio_9p = new Virtio9pProxy(settings.proxy9p, this);
        }
        if(settings.virtio_console)
        {
            this.devices.virtio_console = new VirtioConsole(this, device_bus);
        }
        if(settings.virtio_balloon)
        {
            this.devices.virtio_balloon = new VirtioBalloon(this, device_bus);
        }

        if(true)
        {
            this.devices.sb16 = new SB16(this, device_bus);
        }
    }

    if(settings.multiboot)
    {
        dbg_log("loading multiboot", LOG_CPU);
        const option_rom = this.load_multiboot_option_rom(settings.multiboot, settings.initrd, settings.cmdline);

        if(option_rom)
        {
            if(this.bios.main)
            {
                dbg_log("adding option rom for multiboot", LOG_CPU);
                this.option_roms.push(option_rom);
            }
            else
            {
                dbg_log("loaded multiboot without bios", LOG_CPU);
                this.reg32[REG_EAX] = this.io.port_read32(0xF4);
            }
        }
    }

    this.debug_init();
};

CPU.prototype.load_multiboot = function (buffer)
{
    if(this.bios.main)
    {
        dbg_assert(false, "load_multiboot not supported with BIOS");
    }

    const option_rom = this.load_multiboot_option_rom(buffer, undefined, "");
    if(option_rom)
    {
        dbg_log("loaded multiboot", LOG_CPU);
        this.reg32[REG_EAX] = this.io.port_read32(0xF4);
    }
};

CPU.prototype.load_multiboot_option_rom = function(buffer, initrd, cmdline)
{
    // https://www.gnu.org/software/grub/manual/multiboot/multiboot.html

    dbg_log("Trying multiboot from buffer of size " + buffer.byteLength, LOG_CPU);

    const ELF_MAGIC = 0x464C457F;
    const MULTIBOOT_HEADER_MAGIC = 0x1BADB002;
    const MULTIBOOT_HEADER_MEMORY_INFO = 0x2;
    const MULTIBOOT_HEADER_ADDRESS = 0x10000;
    const MULTIBOOT_BOOTLOADER_MAGIC = 0x2BADB002;
    const MULTIBOOT_SEARCH_BYTES = 8192;
    const MULTIBOOT_INFO_STRUCT_LEN = 116;
    const MULTIBOOT_INFO_CMDLINE = 0x4;
    const MULTIBOOT_INFO_MODS = 0x8;
    const MULTIBOOT_INFO_MEM_MAP = 0x40;

    if(buffer.byteLength < MULTIBOOT_SEARCH_BYTES)
    {
        var buf32 = new Int32Array(MULTIBOOT_SEARCH_BYTES / 4);
        new Uint8Array(buf32.buffer).set(new Uint8Array(buffer));
    }
    else
    {
        var buf32 = new Int32Array(buffer, 0, MULTIBOOT_SEARCH_BYTES / 4);
    }

    for(var offset = 0; offset < MULTIBOOT_SEARCH_BYTES; offset += 4)
    {
        if(buf32[offset >> 2] === MULTIBOOT_HEADER_MAGIC)
        {
            var flags = buf32[offset + 4 >> 2];
            var checksum = buf32[offset + 8 >> 2];
            var total = MULTIBOOT_HEADER_MAGIC + flags + checksum | 0;

            if(total)
            {
                dbg_log("Multiboot checksum check failed", LOG_CPU);
                continue;
            }
        }
        else
        {
            continue;
        }

        dbg_log("Multiboot magic found, flags: " + h(flags >>> 0, 8), LOG_CPU);
        // bit 0 : load modules on page boundaries (may as well, if we load modules)
        // bit 1 : provide a memory map (which we always will)
        dbg_assert((flags & ~MULTIBOOT_HEADER_ADDRESS & ~3) === 0, "TODO");

        // do this in a io register hook, so it can happen after BIOS does its work
        var cpu = this;

        this.io.register_read(0xF4, this, function () {return 0;} , function () { return 0;}, function () {
            // actually do the load and return the multiboot magic
            const multiboot_info_addr = 0x7C00;
            let multiboot_data = multiboot_info_addr + MULTIBOOT_INFO_STRUCT_LEN;
            let info = 0;

            // command line
            if(cmdline)
            {
                info |= MULTIBOOT_INFO_CMDLINE;

                cpu.write32(multiboot_info_addr + 16, multiboot_data);

                cmdline += "\x00";
                const encoder = new TextEncoder();
                const cmdline_utf8 = encoder.encode(cmdline);
                cpu.write_blob(cmdline_utf8, multiboot_data);
                multiboot_data += cmdline_utf8.length;
            }

            // memory map
            if(flags & MULTIBOOT_HEADER_MEMORY_INFO)
            {
                info |= MULTIBOOT_INFO_MEM_MAP;
                let multiboot_mmap_count = 0;
                cpu.write32(multiboot_info_addr + 44, 0);
                cpu.write32(multiboot_info_addr + 48, multiboot_data);

                // Create a memory map for the multiboot kernel
                // does not exclude traditional bios exclusions
                let start = 0;
                let was_memory = false;
                for(let addr = 0; addr < MMAP_MAX; addr += MMAP_BLOCK_SIZE)
                {
                    if(was_memory && cpu.memory_map_read8[addr >>> MMAP_BLOCK_BITS] !== undefined)
                    {
                        cpu.write32(multiboot_data, 20); // size
                        cpu.write32(multiboot_data + 4, start); //addr (64-bit)
                        cpu.write32(multiboot_data + 8, 0);
                        cpu.write32(multiboot_data + 12, addr - start); // len (64-bit)
                        cpu.write32(multiboot_data + 16, 0);
                        cpu.write32(multiboot_data + 20, 1); // type (MULTIBOOT_MEMORY_AVAILABLE)
                        multiboot_data += 24;
                        multiboot_mmap_count += 24;
                        was_memory = false;
                    }
                    else if(!was_memory && cpu.memory_map_read8[addr >>> MMAP_BLOCK_BITS] === undefined)
                    {
                        start = addr;
                        was_memory = true;
                    }
                }
                dbg_assert (!was_memory, "top of 4GB shouldn't have memory");
                cpu.write32(multiboot_info_addr + 44, multiboot_mmap_count);
            }

            let entrypoint = 0;
            let top_of_load = 0;

            if(flags & MULTIBOOT_HEADER_ADDRESS)
            {
                dbg_log("Multiboot specifies its own address table", LOG_CPU);

                var header_addr = buf32[offset + 12 >> 2];
                var load_addr = buf32[offset + 16 >> 2];
                var load_end_addr = buf32[offset + 20 >> 2];
                var bss_end_addr = buf32[offset + 24 >> 2];
                var entry_addr = buf32[offset + 28 >> 2];

                dbg_log("header=" + h(header_addr, 8) +
                        " load=" + h(load_addr, 8) +
                        " load_end=" + h(load_end_addr, 8) +
                        " bss_end=" + h(bss_end_addr, 8) +
                        " entry=" + h(entry_addr, 8));

                dbg_assert(load_addr <= header_addr);

                var file_start = offset - (header_addr - load_addr);

                if(load_end_addr === 0)
                {
                    var length = undefined;
                }
                else
                {
                    dbg_assert(load_end_addr >= load_addr);
                    var length = load_end_addr - load_addr;
                }

                const blob = new Uint8Array(buffer, file_start, length);
                cpu.write_blob(blob, load_addr);

                entrypoint = entry_addr | 0;
                top_of_load = Math.max(load_end_addr, bss_end_addr);
            }
            else if(buf32[0] === ELF_MAGIC)
            {
                dbg_log("Multiboot image is in elf format", LOG_CPU);

                const elf = read_elf(buffer);

                entrypoint = elf.header.entry;

                for(const program of elf.program_headers)
                {
                    if(program.type === 0)
                    {
                        // null
                    }
                    else if(program.type === 1)
                    {
                        // load

                        dbg_assert(program.filesz <= program.memsz);

                        if(program.paddr + program.memsz < cpu.memory_size[0])
                        {
                            if(program.filesz) // offset might be outside of buffer if filesz is 0
                            {
                                const blob = new Uint8Array(buffer, program.offset, program.filesz);
                                cpu.write_blob(blob, program.paddr);
                            }
                            top_of_load = Math.max(top_of_load, program.paddr + program.memsz);
                            dbg_log("prg load " + program.paddr + " to " + (program.paddr + program.memsz), LOG_CPU);

                            // Since multiboot specifies that paging is disabled, we load to the physical address;
                            // but the entry point is specified in virtual addresses so adjust the entrypoint if needed

                            if(entrypoint === elf.header.entry && program.vaddr <= entrypoint && (program.vaddr + program.memsz) > entrypoint)
                            {
                                entrypoint = (entrypoint - program.vaddr) + program.paddr;
                            }
                        }
                        else
                        {
                            dbg_log("Warning: Skipped loading section, paddr=" + h(program.paddr) + " memsz=" + program.memsz, LOG_CPU);
                        }
                    }
                    else if(
                        program.type === 2 || // dynamic
                        program.type === 3 || // interp
                        program.type === 4 || // note
                        program.type === 6 || // phdr
                        program.type === 7 || // tls
                        program.type === 0x6474e550 || // gnu_eh_frame
                        program.type === 0x6474e551 || // gnu_stack
                        program.type === 0x6474e552 || // gnu_relro
                        program.type === 0x6474e553)   // gnu_property
                    {
                        dbg_log("skip load type " + program.type + " " + program.paddr + " to " + (program.paddr + program.memsz), LOG_CPU);
                        // ignore for now
                    }
                    else
                    {
                        dbg_assert(false, "unimplemented elf section type: " + h(program.type));
                    }
                }
            }
            else
            {
                dbg_assert(false, "Not a bootable multiboot format");
            }

            if(initrd)
            {
                info |= MULTIBOOT_INFO_MODS;

                cpu.write32(multiboot_info_addr + 20, 1); // mods_count
                cpu.write32(multiboot_info_addr + 24, multiboot_data); // mods_addr;

                var ramdisk_address = top_of_load;
                if((ramdisk_address & 4095) !== 0)
                {
                    ramdisk_address = (ramdisk_address & ~4095) + 4096;
                }
                dbg_log("ramdisk address " + ramdisk_address);
                var ramdisk_top = ramdisk_address + initrd.byteLength;

                cpu.write32(multiboot_data, ramdisk_address); // mod_start
                cpu.write32(multiboot_data + 4, ramdisk_top); // mod_end
                cpu.write32(multiboot_data + 8, 0); // string
                cpu.write32(multiboot_data + 12, 0); // reserved
                multiboot_data += 16;

                dbg_assert(ramdisk_top < cpu.memory_size[0]);

                cpu.write_blob(new Uint8Array(initrd), ramdisk_address);
            }

            cpu.write32(multiboot_info_addr, info);

            // set state for multiboot

            cpu.reg32[REG_EBX] = multiboot_info_addr;
            cpu.cr[0] = 1;
            cpu.protected_mode[0] = +true;
            cpu.flags[0] = FLAGS_DEFAULT;
            cpu.is_32[0] = +true;
            cpu.stack_size_32[0] = +true;

            for(var i = 0; i < 6; i++)
            {
                cpu.segment_is_null[i] = 0;
                cpu.segment_offsets[i] = 0;
                cpu.segment_limits[i] = 0xFFFFFFFF;
                // cpu.segment_access_bytes[i]
                // Value doesn't matter, OS isn't allowed to reload without setting
                // up a proper GDT
                cpu.sreg[i] = 0xB002;
            }
            cpu.instruction_pointer[0] = cpu.get_seg_cs() + entrypoint | 0;
            cpu.update_state_flags();
            dbg_log("Starting multiboot kernel at:", LOG_CPU);
            cpu.dump_state();
            cpu.dump_regs_short();

            return MULTIBOOT_BOOTLOADER_MAGIC;
        });

        // only for kvm-unit-test
        this.io.register_write_consecutive(0xF4, this,
            function(value)
            {
                console.log("Test exited with code " + h(value, 2));
                throw "HALT";
            },
            function() {},
            function() {},
            function() {});

        // only for kvm-unit-test
        for(let i = 0; i <= 0xF; i++)
        {
            function handle_write(value)
            {
                dbg_log("kvm-unit-test: Set irq " + h(i) + " to " + h(value, 2));
                if(value)
                {
                    this.device_raise_irq(i);
                }
                else
                {
                    this.device_lower_irq(i);
                }
            }

            this.io.register_write(0x2000 + i, this, handle_write, handle_write, handle_write);
        }

        // This rom will be executed by seabios after its initialisation
        // It sets up the multiboot environment.
        const SIZE = 0x200;

        const data8 = new Uint8Array(SIZE);
        const data16 = new Uint16Array(data8.buffer);

        data16[0] = 0xAA55;
        data8[2] = SIZE / 0x200;
        let i = 3;
        // trigger load
        data8[i++] = 0x66; // in 0xF4
        data8[i++] = 0xE5;
        data8[i++] = 0xF4;

        dbg_assert(i < SIZE);

        const checksum_index = i;
        data8[checksum_index] = 0;

        let rom_checksum = 0;

        for(let i = 0; i < data8.length; i++)
        {
            rom_checksum += data8[i];
        }

        data8[checksum_index] = -rom_checksum;

        return {
            name: "genroms/multiboot.bin",
            data: data8
        };
    }
    dbg_log("Multiboot header not found", LOG_CPU);
};

CPU.prototype.fill_cmos = function(rtc, settings)
{
    var boot_order = settings.boot_order || BOOT_ORDER_CD_FIRST;

    // Used by seabios to determine the boot order
    //   Nibble
    //   1: FloppyPrio
    //   2: HDPrio
    //   3: CDPrio
    //   4: BEVPrio
    // bootflag 1, high nibble, lowest priority
    // Low nibble: Disable floppy signature check (1)
    rtc.cmos_write(CMOS_BIOS_BOOTFLAG1 , 1 | boot_order >> 4 & 0xF0);

    // bootflag 2, both nibbles, high and middle priority
    rtc.cmos_write(CMOS_BIOS_BOOTFLAG2, boot_order & 0xFF);

    // 640k or less if less memory is used
    rtc.cmos_write(CMOS_MEM_BASE_LOW, 640 & 0xFF);
    rtc.cmos_write(CMOS_MEM_BASE_HIGH, 640 >> 8);

    var memory_above_1m = 0; // in k
    if(this.memory_size[0] >= 1024 * 1024)
    {
        memory_above_1m = (this.memory_size[0] - 1024 * 1024) >> 10;
        memory_above_1m = Math.min(memory_above_1m, 0xFFFF);
    }

    rtc.cmos_write(CMOS_MEM_OLD_EXT_LOW, memory_above_1m & 0xFF);
    rtc.cmos_write(CMOS_MEM_OLD_EXT_HIGH, memory_above_1m >> 8 & 0xFF);
    rtc.cmos_write(CMOS_MEM_EXTMEM_LOW, memory_above_1m & 0xFF);
    rtc.cmos_write(CMOS_MEM_EXTMEM_HIGH, memory_above_1m >> 8 & 0xFF);

    var memory_above_16m = 0; // in 64k blocks
    if(this.memory_size[0] >= 16 * 1024 * 1024)
    {
        memory_above_16m = (this.memory_size[0] - 16 * 1024 * 1024) >> 16;
        memory_above_16m = Math.min(memory_above_16m, 0xFFFF);
    }
    rtc.cmos_write(CMOS_MEM_EXTMEM2_LOW, memory_above_16m & 0xFF);
    rtc.cmos_write(CMOS_MEM_EXTMEM2_HIGH, memory_above_16m >> 8 & 0xFF);

    // memory above 4G (not supported by this emulator)
    rtc.cmos_write(CMOS_MEM_HIGHMEM_LOW, 0);
    rtc.cmos_write(CMOS_MEM_HIGHMEM_MID, 0);
    rtc.cmos_write(CMOS_MEM_HIGHMEM_HIGH, 0);

    rtc.cmos_write(CMOS_EQUIPMENT_INFO, 0x2F);

    rtc.cmos_write(CMOS_BIOS_SMP_COUNT, 0);

    // Used by bochs BIOS to skip the boot menu delay.
    if(settings.fastboot) rtc.cmos_write(0x3f, 0x01);
};

CPU.prototype.load_bios = function()
{
    var bios = this.bios.main;
    var vga_bios = this.bios.vga;

    if(!bios)
    {
        dbg_log("Warning: No BIOS");
        return;
    }

    dbg_assert(bios instanceof ArrayBuffer);

    // load bios
    var data = new Uint8Array(bios),
        start = 0x100000 - bios.byteLength;

    this.write_blob(data, start);

    if(vga_bios)
    {
        dbg_assert(vga_bios instanceof ArrayBuffer);

        // load vga bios
        var vga_bios8 = new Uint8Array(vga_bios);

        // older versions of seabios
        this.write_blob(vga_bios8, 0xC0000);

        // newer versions of seabios (needs to match pci rom address, see vga.js)
        this.io.mmap_register(0xFEB00000, 0x100000,
            function(addr)
            {
                addr = (addr - 0xFEB00000) | 0;
                if(addr < vga_bios8.length)
                {
                    return vga_bios8[addr];
                }
                else
                {
                    return 0;
                }
            },
            function(addr, value)
            {
                dbg_assert(false, "Unexpected write to VGA rom");
            });
    }
    else
    {
        dbg_log("Warning: No VGA BIOS");
    }

    // seabios expects the bios to be mapped to 0xFFF00000 also
    this.io.mmap_register(0xFFF00000, 0x100000,
        function(addr)
        {
            addr &= 0xFFFFF;
            return this.mem8[addr];
        }.bind(this),
        function(addr, value)
        {
            addr &= 0xFFFFF;
            this.mem8[addr] = value;
        }.bind(this));
};

CPU.prototype.codegen_finalize = function(wasm_table_index, start, state_flags, ptr, len)
{
    ptr >>>= 0;
    len >>>= 0;

    dbg_assert(wasm_table_index >= 0 && wasm_table_index < WASM_TABLE_SIZE);

    const code = new Uint8Array(this.wasm_memory.buffer, ptr, len);

    if(DEBUG)
    {
        if(DUMP_GENERATED_WASM && !this.seen_code[start])
        {
            this.dump_wasm(code);

            const DUMP_ASSEMBLY = false;

            if(DUMP_ASSEMBLY)
            {
                let end = 0;

                if((start ^ end) & ~0xFFF)
                {
                    dbg_log("truncated disassembly start=" + h(start >>> 0) + " end=" + h(end >>> 0));
                    end = (start | 0xFFF) + 1; // until the end of the page
                }

                dbg_assert(end >= start);

                const buffer = new Uint8Array(end - start);

                for(let i = start; i < end; i++)
                {
                    buffer[i - start] = this.read8(i);
                }

                this.debug_dump_code(this.is_32[0] ? 1 : 0, buffer, start);
            }
        }

        this.seen_code[start] = (this.seen_code[start] || 0) + 1;

        if(this.test_hook_did_generate_wasm)
        {
            this.test_hook_did_generate_wasm(code);
        }
    }

    const SYNC_COMPILATION = false;

    if(SYNC_COMPILATION)
    {
        const module = new WebAssembly.Module(code);
        const result = new WebAssembly.Instance(module, { "e": this.jit_imports });
        const f = result.exports["f"];

        this.wm.wasm_table.set(wasm_table_index + WASM_TABLE_OFFSET, f);
        this.codegen_finalize_finished(wasm_table_index, start, state_flags);

        if(this.test_hook_did_finalize_wasm)
        {
            this.test_hook_did_finalize_wasm(code);
        }

        return;
    }

    const result = WebAssembly.instantiate(code, { "e": this.jit_imports }).then(result => {
        const f = result.instance.exports["f"];

        this.wm.wasm_table.set(wasm_table_index + WASM_TABLE_OFFSET, f);
        this.codegen_finalize_finished(wasm_table_index, start, state_flags);

        if(this.test_hook_did_finalize_wasm)
        {
            this.test_hook_did_finalize_wasm(code);
        }
    });

    if(DEBUG)
    {
        result.catch(e => {
            console.log(e);
            debugger;
            throw e;
        });
    }
};

CPU.prototype.log_uncompiled_code = function(start, end)
{
    if(!DEBUG || !DUMP_UNCOMPILED_ASSEMBLY)
    {
        return;
    }

    if((this.seen_code_uncompiled[start] || 0) < 100)
    {
        this.seen_code_uncompiled[start] = (this.seen_code_uncompiled[start] || 0) + 1;

        end += 8; // final jump is not included

        if((start ^ end) & ~0xFFF)
        {
            dbg_log("truncated disassembly start=" + h(start >>> 0) + " end=" + h(end >>> 0));
            end = (start | 0xFFF) + 1; // until the end of the page
        }

        if(end < start) end = start;

        dbg_assert(end >= start);

        const buffer = new Uint8Array(end - start);

        for(let i = start; i < end; i++)
        {
            buffer[i - start] = this.read8(i);
        }

        dbg_log("Uncompiled code:");
        this.debug_dump_code(this.is_32[0] ? 1 : 0, buffer, start);
    }
};

CPU.prototype.dump_function_code = function(block_ptr, count)
{
    if(!DEBUG || !DUMP_GENERATED_WASM)
    {
        return;
    }

    const SIZEOF_BASIC_BLOCK_IN_DWORDS = 7;

    const mem32 = new Int32Array(this.wasm_memory.buffer);

    dbg_assert((block_ptr & 3) === 0);

    const is_32 = this.is_32[0];

    for(let i = 0; i < count; i++)
    {
        const struct_start = (block_ptr >> 2) + i * SIZEOF_BASIC_BLOCK_IN_DWORDS;
        const start = mem32[struct_start + 0];
        const end = mem32[struct_start + 1];
        const is_entry_block = mem32[struct_start + 6] & 0xFF00;

        const buffer = new Uint8Array(end - start);

        for(let i = start; i < end; i++)
        {
            buffer[i - start] = this.read8(this.translate_address_system_read(i));
        }

        dbg_log("---" + (is_entry_block ? " entry" : ""));
        this.debug_dump_code(is_32 ? 1 : 0, buffer, start);
    }
};

CPU.prototype.run_hardware_timers = function(acpi_enabled, now)
{
    const pit_time = this.devices.pit.timer(now, false);
    const rtc_time = this.devices.rtc.timer(now, false);

    let acpi_time = 100;
    let apic_time = 100;
    if(acpi_enabled)
    {
        acpi_time = this.devices.acpi.timer(now);
        apic_time = this.apic_timer(now);
    }

    return Math.min(pit_time, rtc_time, acpi_time, apic_time);
};

CPU.prototype.debug_init = function()
{
    if(!DEBUG) return;

    if(this.io)
    {
        // write seabios debug output to console
        var seabios_debug = "";

        this.io.register_write(0x402, this, handle); // seabios
        this.io.register_write(0x500, this, handle); // vgabios
    }

    function handle(out_byte)
    {
        if(out_byte === 10)
        {
            dbg_log(seabios_debug, LOG_BIOS);
            seabios_debug = "";
        }
        else
        {
            seabios_debug += String.fromCharCode(out_byte);
        }
    }
};

CPU.prototype.dump_stack = function(start, end)
{
    if(!DEBUG) return;

    var esp = this.reg32[REG_ESP];
    dbg_log("========= STACK ==========");

    if(end >= start || end === undefined)
    {
        start = 5;
        end = -5;
    }

    for(var i = start; i > end; i--)
    {
        var line = "    ";

        if(!i) line = "=>  ";

        line += h(i, 2) + " | ";

        dbg_log(line + h(esp + 4 * i, 8) + " | " + h(this.read32s(esp + 4 * i) >>> 0));
    }
};

/** @param {string=} where */
CPU.prototype.debug_get_state = function(where)
{
    if(!DEBUG) return;

    var mode = this.protected_mode[0] ? "prot" : "real";
    var vm = (this.flags[0] & FLAG_VM) ? 1 : 0;
    var flags = this.get_eflags();
    var iopl = this.getiopl();
    var cpl = this.cpl[0];
    var cs_eip = h(this.sreg[REG_CS], 4) + ":" + h(this.get_real_eip() >>> 0, 8);
    var ss_esp = h(this.sreg[REG_SS], 4) + ":" + h(this.reg32[REG_ES] >>> 0, 8);
    var op_size = this.is_32[0] ? "32" : "16";
    var if_ = (this.flags[0] & FLAG_INTERRUPT) ? 1 : 0;

    var flag_names = {
        [FLAG_CARRY]: "c",
        [FLAG_PARITY]: "p",
        [FLAG_ADJUST]: "a",
        [FLAG_ZERO]: "z",
        [FLAG_SIGN]: "s",
        [FLAG_TRAP]: "t",
        [FLAG_INTERRUPT]: "i",
        [FLAG_DIRECTION]: "d",
        [FLAG_OVERFLOW]: "o",
    };
    var flag_string = "";

    for(var i = 0; i < 16; i++)
    {
        if(flag_names[1 << i])
        {
            if(flags & 1 << i)
            {
                flag_string += flag_names[1 << i];
            }
            else
            {
                flag_string += " ";
            }
        }
    }

    return ("mode=" + mode + "/" + op_size + " paging=" + (+((this.cr[0] & CR0_PG) !== 0)) +
        " pae=" + (+((this.cr[4] & CR4_PAE) !== 0)) +
        " iopl=" + iopl + " cpl=" + cpl + " if=" + if_ + " cs:eip=" + cs_eip +
        " cs_off=" + h(this.get_seg_cs() >>> 0, 8) +
        " flgs=" + h(this.get_eflags() >>> 0, 6) + " (" + flag_string + ")" +
        " ss:esp=" + ss_esp +
        " ssize=" + (+this.stack_size_32[0]) +
        (where ? " in " + where : ""));
};

/** @param {string=} where */
CPU.prototype.dump_state = function(where)
{
    if(!DEBUG) return;

    dbg_log(this.debug_get_state(where), LOG_CPU);
};

CPU.prototype.get_regs_short = function()
{
    if(!DEBUG) return;

    var
    r32 = { "eax": REG_EAX, "ecx": REG_ECX, "edx": REG_EDX, "ebx": REG_EBX,
        "esp": REG_ESP, "ebp": REG_EBP, "esi": REG_ESI, "edi": REG_EDI },
        r32_names = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"],
        s = { "cs": REG_CS, "ds": REG_DS, "es": REG_ES, "fs": REG_FS, "gs": REG_GS, "ss": REG_SS },
        line1 = "",
        line2 = "";

    for(var i = 0; i < 4; i++)
    {
        line1 += r32_names[i] + "="  + h(this.reg32[r32[r32_names[i]]] >>> 0, 8) + " ";
        line2 += r32_names[i+4] + "="  + h(this.reg32[r32[r32_names[i+4]]] >>> 0, 8) + " ";
    }

    //line1 += " eip=" + h(this.get_real_eip() >>> 0, 8);
    //line2 += " flg=" + h(this.get_eflags(), 8);

    line1 += "  ds=" + h(this.sreg[REG_DS], 4) + " es=" + h(this.sreg[REG_ES], 4) + " fs=" + h(this.sreg[REG_FS], 4);
    line2 += "  gs=" + h(this.sreg[REG_GS], 4) + " cs=" + h(this.sreg[REG_CS], 4) + " ss=" + h(this.sreg[REG_SS], 4);

    return [line1, line2];
};

CPU.prototype.dump_regs_short = function()
{
    if(!DEBUG) return;

    var lines = this.get_regs_short();

    dbg_log(lines[0], LOG_CPU);
    dbg_log(lines[1], LOG_CPU);
};

CPU.prototype.dump_gdt_ldt = function()
{
    if(!DEBUG) return;

    dbg_log("gdt: (len = " + h(this.gdtr_size[0]) + ")");
    dump_table(this.translate_address_system_read(this.gdtr_offset[0]), this.gdtr_size[0]);

    dbg_log("\nldt: (len = " + h(this.segment_limits[REG_LDTR]) + ")");
    dump_table(this.translate_address_system_read(this.segment_offsets[REG_LDTR]), this.segment_limits[REG_LDTR]);

    function dump_table(addr, size)
    {
        for(var i = 0; i < size; i += 8, addr += 8)
        {
            var base = this.read16(addr + 2) |
                this.read8(addr + 4) << 16 |
                this.read8(addr + 7) << 24,

                limit = this.read16(addr) | (this.read8(addr + 6) & 0xF) << 16,
                access = this.read8(addr + 5),
                flags = this.read8(addr + 6) >> 4,
                flags_str = "",
                dpl = access >> 5 & 3;

            if(!(access & 128))
            {
                // present bit not set
                //continue;
                flags_str += "NP ";
            }
            else
            {
                flags_str += " P ";
            }

            if(access & 16)
            {
                if(flags & 4)
                {
                    flags_str += "32b ";
                }
                else
                {
                    flags_str += "16b ";
                }

                if(access & 8)
                {
                    // executable
                    flags_str += "X ";

                    if(access & 4)
                    {
                        flags_str += "C ";
                    }
                }
                else
                {
                    // data
                    flags_str += "R ";
                }

                flags_str += "RW ";
            }
            else
            {
                // system
                flags_str += "sys: " + h(access & 15);
            }

            if(flags & 8)
            {
                limit = limit << 12 | 0xFFF;
            }

            dbg_log(h(i & ~7, 4) + " " + h(base >>> 0, 8) + " (" + h(limit >>> 0, 8) + " bytes) " +
                flags_str + ";  dpl = " + dpl + ", a = " + access.toString(2) +
                ", f = " + flags.toString(2));
        }
    }
};

CPU.prototype.dump_idt = function()
{
    if(!DEBUG) return;

    for(var i = 0; i < this.idtr_size[0]; i += 8)
    {
        var addr = this.translate_address_system_read(this.idtr_offset[0] + i),
            base = this.read16(addr) | this.read16(addr + 6) << 16,
            selector = this.read16(addr + 2),
            type = this.read8(addr + 5),
            line,
            dpl = type >> 5 & 3;

        if((type & 31) === 5)
        {
            line = "task gate ";
        }
        else if((type & 31) === 14)
        {
            line = "intr gate ";
        }
        else if((type & 31) === 15)
        {
            line = "trap gate ";
        }
        else
        {
            line = "invalid   ";
        }


        if(type & 128)
        {
            line += " P";
        }
        else
        {
            // present bit not set
            //continue;
            line += "NP";
        }


        dbg_log(h(i >> 3, 4) + " " + h(base >>> 0, 8) + ", " +
            h(selector, 4) + "; " + line + ";  dpl = " + dpl + ", t = " + type.toString(2));
    }
};

CPU.prototype.dump_page_structures = function()
{
    var pae = !!(this.cr[4] & CR4_PAE);
    if(pae)
    {
        dbg_log("PAE enabled");

        for(var i = 0; i < 4; i++) {
            var addr = this.cr[3] + 8 * i;
            var dword = this.read32s(addr);
            if(dword & 1)
            {
                this.dump_page_directory(dword & 0xFFFFF000, true, i << 30);
            }
        }
    }
    else
    {
        dbg_log("PAE disabled");
        this.dump_page_directory(this.cr[3], false, 0);
    }
};

// NOTE: PAE entries are 64-bits, we ignore the high half here.
CPU.prototype.dump_page_directory = function(pd_addr, pae, start)
{
    if(!DEBUG) return;

    function load_page_entry(dword_entry, pae, is_directory)
    {
        if(!DEBUG) return;

        if(!(dword_entry & 1))
        {
            // present bit not set
            return false;
        }

        var size = (dword_entry & 128) === 128,
            address;

        if(size && !is_directory)
        {
            address = dword_entry & (pae ? 0xFFE00000 : 0xFFC00000);
        }
        else
        {
            address = dword_entry & 0xFFFFF000;
        }

        return {
            size: size,
            global: (dword_entry & 256) === 256,
            accessed: (dword_entry & 0x20) === 0x20,
            dirty: (dword_entry & 0x40) === 0x40,
            cache_disable : (dword_entry & 16) === 16,
            user : (dword_entry & 4) === 4,
            read_write : (dword_entry & 2) === 2,
            address : address >>> 0
        };
    }

    var n = pae ? 512 : 1024;
    var entry_size = pae ? 8 : 4;
    var pd_shift = pae ? 21 : 22;

    for(var i = 0; i < n; i++)
    {
        var addr = pd_addr + i * entry_size,
            dword = this.read32s(addr),
            entry = load_page_entry(dword, pae, true);

        if(!entry)
        {
            continue;
        }

        var flags = "";

        flags += entry.size ? "S " : "  ";
        flags += entry.accessed ? "A " : "  ";
        flags += entry.cache_disable ? "Cd " : "  ";
        flags += entry.user ? "U " : "  ";
        flags += entry.read_write ? "Rw " : "   ";

        if(entry.size)
        {
            dbg_log("=== " + h(start + (i << pd_shift) >>> 0, 8) + " -> " +
                h(entry.address >>> 0, 8) + " | " + flags);
            continue;
        }
        else
        {
            dbg_log("=== " + h(start + (i << pd_shift) >>> 0, 8) + " | " + flags);
        }

        for(var j = 0; j < n; j++)
        {
            var sub_addr = entry.address + j * entry_size;
            dword = this.read32s(sub_addr);

            var subentry = load_page_entry(dword, pae, false);

            if(subentry)
            {
                flags = "";

                flags += subentry.cache_disable ? "Cd " : "   ";
                flags += subentry.user ? "U " : "  ";
                flags += subentry.read_write ? "Rw " : "   ";
                flags += subentry.global ? "G " : "  ";
                flags += subentry.accessed ? "A " : "  ";
                flags += subentry.dirty ? "Di " : "   ";

                dbg_log("# " + h(start + (i << pd_shift | j << 12) >>> 0, 8) + " -> " +
                    h(subentry.address, 8) + " | " + flags + "        (at " + h(sub_addr, 8) + ")");
            }
        }
    }
};

CPU.prototype.get_memory_dump = function(start, count)
{
    if(!DEBUG) return;

    if(start === undefined)
    {
        start = 0;
        count = this.memory_size[0];
    }
    else if(count === undefined)
    {
        count = start;
        start = 0;
    }

    return this.mem8.slice(start, start + count).buffer;
};

CPU.prototype.memory_hex_dump = function(addr, length)
{
    if(!DEBUG) return;

    length = length || 4 * 0x10;
    var line, byt;

    for(var i = 0; i < length >> 4; i++)
    {
        line = h(addr + (i << 4), 5) + "   ";

        for(var j = 0; j < 0x10; j++)
        {
            byt = this.read8(addr + (i << 4) + j);
            line += h(byt, 2) + " ";
        }

        line += "  ";

        for(j = 0; j < 0x10; j++)
        {
            byt = this.read8(addr + (i << 4) + j);
            line += (byt < 33 || byt > 126) ? "." : String.fromCharCode(byt);
        }

        dbg_log(line);
    }
};

CPU.prototype.used_memory_dump = function()
{
    if(!DEBUG) return;

    var width = 0x80,
        height = 0x10,
        block_size = this.memory_size[0] / width / height | 0,
        row;

    for(var i = 0; i < height; i++)
    {
        row = h(i * width * block_size, 8) + " | ";

        for(var j = 0; j < width; j++)
        {
            var used = this.mem32s[(i * width + j) * block_size] > 0;

            row += used ? "X" : " ";
        }

        dbg_log(row);
    }
};

CPU.prototype.debug_interrupt = function(interrupt_nr)
{
    //if(interrupt_nr === 0x20)
    //{
    //    //var vxd_device = this.safe_read16(this.instruction_pointer + 2);
    //    //var vxd_sub = this.safe_read16(this.instruction_pointer + 0);
    //    //var service = "";
    //    //if(vxd_device === 1)
    //    //{
    //    //    service = vxd_table1[vxd_sub];
    //    //}
    //    //dbg_log("vxd: " + h(vxd_device, 4) + " " + h(vxd_sub, 4) + " " + service);
    //}

    //if(interrupt_nr >= 0x21 && interrupt_nr < 0x30)
    //{
    //    dbg_log("dos: " + h(interrupt_nr, 2) + " ah=" + h(this.reg8[reg_ah], 2) + " ax=" + h(this.reg16[reg_ax], 4));
    //}

    //if(interrupt_nr === 0x13 && (this.reg8[reg_ah] | 1) === 0x43)
    //{
    //    this.debug.memory_hex_dump(this.get_seg(reg_ds) + this.reg16[reg_si], 0x18);
    //}

    //if(interrupt_nr == 0x10)
    //{
    //    dbg_log("int10 ax=" + h(this.reg16[reg_ax], 4) + " '" + String.fromCharCode(this.reg8[reg_al]) + "'");
    //    this.debug.dump_regs_short();
    //    if(this.reg8[reg_ah] == 0xe) vga.tt_write(this.reg8[reg_al]);
    //}

    //if(interrupt_nr === 0x13)
    //{
    //    this.debug.dump_regs_short();
    //}

    //if(interrupt_nr === 6)
    //{
    //    this.instruction_pointer += 2;
    //    dbg_log("BUG()", LOG_CPU);
    //    dbg_log("line=" + this.read_imm16() + " " +
    //            "file=" + this.read_string(this.translate_address_read(this.read_imm32s())), LOG_CPU);
    //    this.instruction_pointer -= 8;
    //    this.debug.dump_regs_short();
    //}

    //if(interrupt_nr === 0x80)
    //{
    //    dbg_log("linux syscall");
    //    this.debug.dump_regs_short();
    //}

    //if(interrupt_nr === 0x40)
    //{
    //    dbg_log("kolibri syscall");
    //    this.debug.dump_regs_short();
    //}
};

CPU.prototype.debug_dump_code = function(is_32, buffer, start)
{
    if(!DEBUG) return;

    if(!this.capstone_decoder)
    {
        let cs = window.cs;

        /* global require */
        if(typeof require === "function")
        {
            cs = require("./capstone-x86.min.js");
        }

        if(cs === undefined)
        {
            dbg_log("Warning: Missing capstone library, disassembly not available");
            return;
        }

        this.capstone_decoder = [
            new cs.Capstone(cs.ARCH_X86, cs.MODE_16),
            new cs.Capstone(cs.ARCH_X86, cs.MODE_32),
        ];
    }

    if(buffer instanceof Array)
    {
        buffer = new Uint8Array(buffer);
    }

    try
    {
        const instructions = this.capstone_decoder[+is_32].disasm(buffer, start);

        instructions.forEach(function (instr) {
            dbg_log(h(instr.address >>> 0) + ": " +
                pads(instr.bytes.map(x => h(x, 2).slice(-2)).join(" "), 20) + " " +
                instr.mnemonic + " " + instr.op_str);
        });
        dbg_log("");
    }
    catch(e)
    {
        dbg_log("Could not disassemble: " + Array.from(buffer).map(x => h(x, 2)).join(" "));
    }
};

CPU.prototype.dump_wasm = function(buffer)
{
    if(!DEBUG) return;

    /* global require */
    if(this.wabt === undefined)
    {
        if(typeof require === "function")
        {
            this.wabt = require("./libwabt.cjs");
        }
        else
        {
            this.wabt = new window.WabtModule;
        }

        if(this.wabt === undefined)
        {
            dbg_log("Warning: Missing libwabt, wasm dump not available");
            return;
        }
    }

    // Need to make a small copy otherwise libwabt goes nuts trying to copy
    // the whole underlying buffer
    buffer = buffer.slice();

    try
    {
        var module = this.wabt.readWasm(buffer, { readDebugNames: false });
        module.generateNames();
        module.applyNames();
        const result = module.toText({ foldExprs: true, inlineExport: true });
        dbg_log(result);
    }
    catch(e)
    {
        dump_file(buffer, "failed.wasm");
        console.log(e.toString());
    }
    finally
    {
        if(module)
        {
            module.destroy();
        }
    }
};
