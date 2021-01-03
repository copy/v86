"use strict";

/** @const */
var CPU_LOG_VERBOSE = false;


// Resources:
// https://pdos.csail.mit.edu/6.828/2006/readings/i386/toc.htm
// https://www-ssl.intel.com/content/www/us/en/processors/architectures-software-developer-manuals.html
// http://ref.x86asm.net/geek32.html


/** @constructor */
function CPU(bus, wm)
{
    this.wm = wm;
    this.wasm_patch();
    this.create_jit_imports();

    const memory = this.wm.exports.memory;

    this.wasm_memory = memory;

    this.memory_size = v86util.view(Uint32Array, memory, 812, 1);

    this.mem8 = new Uint8Array(0);
    this.mem32s = new Int32Array(this.mem8.buffer);

    this.segment_is_null = v86util.view(Uint8Array, memory, 724, 8);
    this.segment_offsets = v86util.view(Int32Array, memory, 736, 8);
    this.segment_limits = v86util.view(Uint32Array, memory, 768, 8);

    /**
     * Wheter or not in protected mode
     */
    this.protected_mode = v86util.view(Int32Array, memory, 800, 1);

    this.idtr_size = v86util.view(Int32Array, memory, 564, 1);
    this.idtr_offset = v86util.view(Int32Array, memory, 568, 1);

    /**
     * global descriptor table register
     */
    this.gdtr_size = v86util.view(Int32Array, memory, 572, 1);
    this.gdtr_offset = v86util.view(Int32Array, memory, 576, 1);

    this.tss_size_32 = v86util.view(Int32Array, memory, 1128, 1);

    /*
     * whether or not a page fault occured
     */
    this.page_fault = v86util.view(Uint32Array, memory, 540, 8);

    this.cr = v86util.view(Int32Array, memory, 580, 8);

    // current privilege level
    this.cpl = v86util.view(Uint8Array, memory, 612, 1);

    // current operand/address size
    this.is_32 = v86util.view(Int32Array, memory, 804, 1);

    this.stack_size_32 = v86util.view(Int32Array, memory, 808, 1);

    /**
     * Was the last instruction a hlt?
     */
    this.in_hlt = v86util.view(Uint8Array, memory, 616, 1);

    this.last_virt_eip = v86util.view(Int32Array, memory, 620, 1);
    this.eip_phys = v86util.view(Int32Array, memory, 624, 1);


    this.sysenter_cs = v86util.view(Int32Array, memory, 636, 1);

    this.sysenter_esp = v86util.view(Int32Array, memory, 640, 1);

    this.sysenter_eip = v86util.view(Int32Array, memory, 644, 1);

    this.prefixes = v86util.view(Int32Array, memory, 648, 1);

    this.flags = v86util.view(Int32Array, memory, 120, 1);

    /**
     * bitmap of flags which are not updated in the flags variable
     * changed by arithmetic instructions, so only relevant to arithmetic flags
     */
    this.flags_changed = v86util.view(Int32Array, memory, 116, 1);

    /**
     * enough infos about the last arithmetic operation to compute eflags
     */
    this.last_op1 = v86util.view(Int32Array, memory, 96, 1);
    this.last_op_size = v86util.view(Int32Array, memory, 104, 1);
    this.last_result = v86util.view(Int32Array, memory, 112, 1);

    this.current_tsc = v86util.view(Uint32Array, memory, 960, 2); // 64 bit

    /** @type {!Object} */
    this.devices = {};

    this.instruction_pointer = v86util.view(Int32Array, memory, 556, 1);
    this.previous_ip = v86util.view(Int32Array, memory, 560, 1);

    // configured by guest
    this.apic_enabled = v86util.view(Uint8Array, memory, 548, 1);
    // configured when the emulator starts (changes bios initialisation)
    this.acpi_enabled = v86util.view(Uint8Array, memory, 552, 1);

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

    this.instruction_counter = v86util.view(Uint32Array, memory, 664, 1);

    // registers
    this.reg32 = v86util.view(Int32Array, memory, 64, 8);

    this.fpu_st = v86util.view(Int32Array, memory, 1152, 4 * 8);

    this.fpu_stack_empty = v86util.view(Uint8Array, memory, 816, 1);
    this.fpu_stack_empty[0] = 0xFF;
    this.fpu_stack_ptr = v86util.view(Uint8Array, memory, 1032, 1);
    this.fpu_stack_ptr[0] = 0;

    this.fpu_control_word = v86util.view(Uint16Array, memory, 1036, 1);
    this.fpu_control_word[0] = 0x37F;
    this.fpu_status_word = v86util.view(Uint16Array, memory, 1040, 1);
    this.fpu_status_word[0] = 0;
    this.fpu_ip = v86util.view(Int32Array, memory, 1048, 1);
    this.fpu_ip[0] = 0;
    this.fpu_ip_selector = v86util.view(Int32Array, memory, 1052, 1);
    this.fpu_ip_selector[0] = 0;
    this.fpu_opcode = v86util.view(Int32Array, memory, 1044, 1);
    this.fpu_opcode[0] = 0;
    this.fpu_dp = v86util.view(Int32Array, memory, 1056, 1);
    this.fpu_dp[0] = 0;
    this.fpu_dp_selector = v86util.view(Int32Array, memory, 1060, 1);
    this.fpu_dp_selector[0] = 0;

    this.reg_xmm32s = v86util.view(Int32Array, memory, 832, 8 * 4);

    this.mxcsr = v86util.view(Int32Array, memory, 824, 1);

    // segment registers, tr and ldtr
    this.sreg = v86util.view(Uint16Array, memory, 668, 8);

    // debug registers
    this.dreg = v86util.view(Int32Array, memory, 684, 8);

    this.fw_value = [];
    this.fw_pointer = 0;
    this.option_roms = [];

    this.io = undefined;

    this.bus = bus;

    this.set_tsc(0, 0);

    this.debug_init();

    //Object.seal(this);
}

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

    for(let name of Object.keys(this.wm.exports))
    {
        if(name.startsWith("_") || name.startsWith("ZSTD") || name.startsWith("zstd") || name.endsWith("_js"))
        {
            continue;
        }

        jit_imports[name] = this.wm.exports[name];
    }

    this.jit_imports = jit_imports;
};

CPU.prototype.wasm_patch = function()
{
    const get_optional_import = (name) => {
        return this.wm.exports[name];
    };

    const get_import = (name) =>
    {
        const f = get_optional_import(name);
        console.assert(f, "Missing import: " + name);
        return f;
    };

    this.getiopl = get_import("getiopl");
    this.vm86_mode = get_import("vm86_mode");
    this.get_eflags = get_import("get_eflags");
    this.get_eflags_no_arith = get_import("get_eflags_no_arith");
    this.update_eflags = get_import("update_eflags");

    this.trigger_gp = get_import("trigger_gp");
    this.trigger_np = get_import("trigger_np");
    this.trigger_ss = get_import("trigger_ss");

    this.switch_cs_real_mode = get_import("switch_cs_real_mode");
    this.pic_call_irq = get_import("pic_call_irq");

    this.do_many_cycles_native = get_import("do_many_cycles_native");
    this.cycle_internal = get_import("cycle_internal");

    this.read8 = get_import("read8");
    this.read16 = get_import("read16");
    this.read32s = get_import("read32s");
    this.write8 = get_import("write8");
    this.write16 = get_import("write16");
    this.write32 = get_import("write32");
    this.in_mapped_range = get_import("in_mapped_range");

    this.push16 = get_import("push16_js");
    this.push32 = get_import("push32_js");

    this.set_stack_reg = get_import("set_stack_reg");

    this.fpu_load_tag_word = get_import("fpu_load_tag_word");
    this.fpu_load_status_word = get_import("fpu_load_status_word");

    this.translate_address_system_read = get_import("translate_address_system_read_js");
    this.translate_address_system_write = get_import("translate_address_system_write_js");

    this.get_seg_cs = get_import("get_seg_cs");
    this.adjust_stack_reg = get_import("adjust_stack_reg");
    this.get_real_eip = get_import("get_real_eip");
    this.get_stack_pointer = get_import("get_stack_pointer");

    this.writable_or_pagefault = get_import("writable_or_pagefault_js");
    this.safe_write32 = get_import("safe_write32_js");
    this.safe_read32s = get_import("safe_read32s_js");
    this.safe_write16 = get_import("safe_write16_js");
    this.safe_read16 = get_import("safe_read16_js");

    this.clear_tlb = get_import("clear_tlb");
    this.full_clear_tlb = get_import("full_clear_tlb");

    this.set_tsc = get_import("set_tsc");
    this.store_current_tsc = get_import("store_current_tsc");

    this.fpu_get_sti_f64 = get_import("fpu_get_sti_f64");

    if(DEBUG)
    {
        this.jit_force_generate_unsafe = get_optional_import("jit_force_generate_unsafe");
    }

    this.jit_clear_cache = get_import("jit_clear_cache_js");
    this.jit_dirty_cache = get_import("jit_dirty_cache");
    this.codegen_finalize_finished = get_import("codegen_finalize_finished");

    this.allocate_memory = get_import("allocate_memory");
    this.zero_memory = get_import("zero_memory");

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
    state[1] = this.segment_is_null;
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

    this.store_current_tsc();
    state[43] = this.current_tsc;

    state[45] = this.devices.virtio_9p;
    state[46] = this.devices.apic;
    state[47] = this.devices.rtc;
    state[48] = this.devices.pci;
    state[49] = this.devices.dma;
    state[50] = this.devices.acpi;
    state[51] = this.devices.hpet;
    state[52] = this.devices.vga;
    state[53] = this.devices.ps2;
    state[54] = this.devices.uart0;
    state[55] = this.devices.fdc;
    state[56] = this.devices.cdrom;
    state[57] = this.devices.hda;
    state[58] = this.devices.pit;
    state[59] = this.devices.net;
    state[60] = this.devices.pic;
    state[61] = this.devices.sb16;

    state[62] = this.fw_value;

    state[63] = this.devices.ioapic;

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

    return state;
};

CPU.prototype.set_state = function(state)
{
    this.memory_size[0] = state[0];

    if(this.mem8.length !== this.memory_size[0])
    {
        console.warn("Note: Memory size mismatch. we=" + this.mem8.length + " state=" + this.memory_size[0]);
    }

    this.segment_is_null.set(state[1]);
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

    this.set_tsc(state[43][0], state[43][1]);

    this.devices.virtio_9p && this.devices.virtio_9p.set_state(state[45]);
    this.devices.apic && this.devices.apic.set_state(state[46]);
    this.devices.rtc && this.devices.rtc.set_state(state[47]);
    this.devices.pci && this.devices.pci.set_state(state[48]);
    this.devices.dma && this.devices.dma.set_state(state[49]);
    this.devices.acpi && this.devices.acpi.set_state(state[50]);
    this.devices.hpet && this.devices.hpet.set_state(state[51]);
    this.devices.vga && this.devices.vga.set_state(state[52]);
    this.devices.ps2 && this.devices.ps2.set_state(state[53]);
    this.devices.uart0 && this.devices.uart0.set_state(state[54]);
    this.devices.fdc && this.devices.fdc.set_state(state[55]);
    this.devices.cdrom && this.devices.cdrom.set_state(state[56]);
    this.devices.hda && this.devices.hda.set_state(state[57]);
    this.devices.pit && this.devices.pit.set_state(state[58]);
    this.devices.net && this.devices.net.set_state(state[59]);
    this.devices.pic && this.devices.pic.set_state(state[60]);
    this.devices.sb16 && this.devices.sb16.set_state(state[61]);

    this.devices.uart1 && this.devices.uart1.set_state(state[79]);
    this.devices.uart2 && this.devices.uart1.set_state(state[80]);
    this.devices.uart3 && this.devices.uart1.set_state(state[81]);

    this.fw_value = state[62];

    this.devices.ioapic && this.devices.ioapic.set_state(state[63]);

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

    const bitmap = new v86util.Bitmap(state[78].buffer);
    const packed_memory = state[77];
    this.unpack_memory(bitmap, packed_memory);

    this.full_clear_tlb();

    this.jit_clear_cache();
};

CPU.prototype.pack_memory = function()
{
    dbg_assert((this.mem8.length & 0xFFF) === 0);

    const page_count = this.mem8.length >> 12;
    const nonzero_pages = [];

    for(let page = 0; page < page_count; page++)
    {
        const offset = page << 12;
        const view = this.mem32s.subarray(offset >> 2, offset + 0x1000 >> 2);
        let is_zero = true;

        for(let i = 0; i < view.length; i++)
        {
            if(view[i] !== 0)
            {
                is_zero = false;
                break;
            }
        }

        if(!is_zero)
        {
            nonzero_pages.push(page);
        }
    }

    const bitmap = new v86util.Bitmap(page_count);
    const packed_memory = new Uint8Array(nonzero_pages.length << 12);

    for(let [i, page] of nonzero_pages.entries())
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
    this.zero_memory(this.memory_size[0]);

    const page_count = this.memory_size[0] >> 12;
    let packed_page = 0;

    for(let page = 0; page < page_count; page++)
    {
        if(bitmap.get(page))
        {
            let offset = packed_page << 12;
            let view = packed_memory.subarray(offset, offset + 0x1000);
            this.mem8.set(view, page << 12);
            packed_page++;
        }
    }
};

/**
 * @return {number} time in ms until this method should becalled again
 */
CPU.prototype.main_run = function()
{
    if(this.in_hlt[0])
    {
        //if(false)
        //{
        //    var _t = this.hlt_loop();
        //    var t = 0;
        //}
        //else
        //{
            var t = this.hlt_loop();
        //}

        if(this.in_hlt[0])
        {
            return t;
        }
    }

    this.do_run();

    return 0;
};

CPU.prototype.reboot_internal = function()
{
    this.reset();
    this.load_bios();
};

CPU.prototype.reset = function()
{
    this.segment_is_null.fill(0);
    this.segment_limits.fill(0);
    //this.segment_infos = new Uint32Array(8);
    this.segment_offsets.fill(0);

    this.reg32.fill(0);

    this.sreg.fill(0);
    this.dreg.fill(0);

    this.fpu_st.fill(0);
    this.fpu_stack_empty[0] = 0xFF;
    this.fpu_stack_ptr[0] = 0;
    this.fpu_control_word[0] = 0x37F;
    this.fpu_status_word[0] = 0;
    this.fpu_ip[0] = 0;
    this.fpu_ip_selector[0] = 0;
    this.fpu_opcode[0] = 0;
    this.fpu_dp[0] = 0;
    this.fpu_dp_selector[0] = 0;

    this.reg_xmm32s.fill(0);

    this.mxcsr[0] = 0x1F80;

    this.full_clear_tlb();

    this.protected_mode[0] = +false;

    // http://www.sandpile.org/x86/initial.htm
    this.idtr_size[0] = 0;
    this.idtr_offset[0] = 0;

    this.gdtr_size[0] = 0;
    this.gdtr_offset[0] = 0;

    this.page_fault[0] = 0;
    this.cr[0] = 1 << 30 | 1 << 29 | 1 << 4;
    this.cr[2] = 0;
    this.cr[3] = 0;
    this.cr[4] = 0;
    this.dreg[6] = 0xFFFF0FF0|0;
    this.dreg[7] = 0x400;
    this.cpl[0] = 0;

    this.is_32[0] = +false;
    this.stack_size_32[0] = +false;
    this.prefixes[0] = 0;

    this.last_virt_eip[0] = -1;

    this.instruction_counter[0] = 0;
    this.previous_ip[0] = 0;
    this.in_hlt[0] = +false;

    this.sysenter_cs[0] = 0;
    this.sysenter_esp[0] = 0;
    this.sysenter_eip[0] = 0;

    this.flags[0] = flags_default;
    this.flags_changed.fill(0);
    this.last_result.fill(0);
    this.last_op1.fill(0);
    this.last_op_size.fill(0);

    this.set_tsc(0, 0);

    this.instruction_pointer[0] = 0xFFFF0;
    this.switch_cs_real_mode(0xF000);

    if(!this.switch_seg(reg_ss, 0x30)) dbg_assert(false);
    this.reg32[reg_esp] = 0x100;

    if(this.devices.virtio)
    {
        this.devices.virtio.reset();
    }

    this.fw_value = [];

    this.jit_clear_cache();
};

CPU.prototype.reset_memory = function()
{
    this.mem8.fill(0);
};

/** @export */
CPU.prototype.create_memory = function(size)
{
    if(size < 1024 * 1024)
    {
        size = 1024 * 1024;
    }
    else if((size | 0) < 0)
    {
        size = Math.pow(2, 31) - MMAP_BLOCK_SIZE;
    }

    size = ((size - 1) | (MMAP_BLOCK_SIZE - 1)) + 1 | 0;
    dbg_assert((size | 0) > 0);
    dbg_assert((size & MMAP_BLOCK_SIZE - 1) === 0);

    console.assert(this.memory_size[0] === 0, "Expected uninitialised memory");

    this.memory_size[0] = size;

    const memory_offset = this.allocate_memory(size);

    this.mem8 = v86util.view(Uint8Array, this.wasm_memory, memory_offset, size);
    this.mem32s = v86util.view(Uint32Array, this.wasm_memory, memory_offset, size >> 2);
};

CPU.prototype.init = function(settings, device_bus)
{
    if(typeof settings.log_level === "number")
    {
        // XXX: Shared between all emulator instances
        LOG_LEVEL = settings.log_level;
    }

    this.create_memory(typeof settings.memory_size === "number" ?
        settings.memory_size : 1024 * 1024 * 64);

    this.acpi_enabled[0] = +settings.acpi;

    this.reset();

    var io = new IO(this);
    this.io = io;

    this.bios.main = settings.bios;
    this.bios.vga = settings.vga_bios;

    this.load_bios();

    if(settings.bzimage)
    {
        const { option_rom } = load_kernel(this.mem8, settings.bzimage, settings.initrd, settings.cmdline || "");

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
            return new Uint8Array(new Int32Array([x]).buffer);
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
        // Use by linux for port-IO delay
        // Avoid generating tons of debug messages
        io.register_write(0x80, this, function(out_byte)
        {
        });
    }

    this.devices = {};

    // TODO: Make this more configurable
    if(settings.load_devices)
    {
        this.devices.pic = new PIC(this);
        this.devices.pci = new PCI(this);

        if(this.acpi_enabled[0])
        {
            this.devices.ioapic = new IOAPIC(this);
            this.devices.apic = new APIC(this);
            this.devices.acpi = new ACPI(this);
        }

        this.devices.rtc = new RTC(this);
        this.fill_cmos(this.devices.rtc, settings);

        this.devices.dma = new DMA(this);

        if(ENABLE_HPET)
        {
            this.devices.hpet = new HPET(this);
        }

        this.devices.vga = new VGAScreen(this, device_bus,
                settings.vga_memory_size || 8 * 1024 * 1024);

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
            this.devices.uart3 = new UART(this, 0x3E8, device_bus);
        }

        this.devices.fdc = new FloppyController(this, settings.fda, settings.fdb);

        var ide_device_count = 0;

        if(settings.hda)
        {
            this.devices.hda = new IDEDevice(this, settings.hda, settings.hdb, false, ide_device_count++, device_bus);
        }

        if(settings.cdrom)
        {
            this.devices.cdrom = new IDEDevice(this, settings.cdrom, undefined, true, ide_device_count++, device_bus);
        }

        this.devices.pit = new PIT(this, device_bus);

        if(settings.enable_ne2k)
        {
            this.devices.net = new Ne2k(this, device_bus, settings.preserve_mac_from_state_image);
        }

        if(settings.fs9p)
        {
            this.devices.virtio_9p = new Virtio9p(settings.fs9p, this, device_bus);
        }

        if(true)
        {
            this.devices.sb16 = new SB16(this, device_bus);
        }
    }

    if(settings.multiboot)
    {
        this.load_multiboot(settings.multiboot);
    }

    if(DEBUG)
    {
        this.debug.init();
    }
};

CPU.prototype.load_multiboot = function(buffer)
{
    // https://www.gnu.org/software/grub/manual/multiboot/multiboot.html

    dbg_log("Trying multiboot from buffer of size " + buffer.byteLength, LOG_CPU);

    const MAGIC = 0x1BADB002;
    const ELF_MAGIC = 0x464C457F;
    const MULTIBOOT_HEADER_ADDRESS = 0x10000;
    const MULTIBOOT_SEARCH_BYTES = 8192;

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
        if(buf32[offset >> 2] === MAGIC)
        {
            var flags = buf32[offset + 4 >> 2];
            var checksum = buf32[offset + 8 >> 2];
            var total = MAGIC + flags + checksum | 0;

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
        dbg_assert((flags & ~MULTIBOOT_HEADER_ADDRESS) === 0, "TODO");

        this.reg32[reg_eax] = 0x2BADB002;

        let multiboot_info_addr = 0x7C00;
        this.reg32[reg_ebx] = multiboot_info_addr;
        this.write32(multiboot_info_addr, 0);

        this.cr[0] = 1;
        this.protected_mode[0] = +true;
        this.flags[0] = flags_default;
        this.update_cs_size(true);
        this.stack_size_32[0] = +true;

        for(var i = 0; i < 6; i++)
        {
            this.segment_is_null[i] = 0;
            this.segment_offsets[i] = 0;
            this.segment_limits[i] = 0xFFFFFFFF;

            // Value doesn't matter, OS isn't allowed to reload without setting
            // up a proper GDT
            this.sreg[i] = 0xB002;
        }

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

            let blob = new Uint8Array(buffer, file_start, length);
            this.write_blob(blob, load_addr);

            this.instruction_pointer[0] = this.get_seg_cs() + entry_addr | 0;
        }
        else if(buf32[0] === ELF_MAGIC)
        {
            dbg_log("Multiboot image is in elf format", LOG_CPU);

            let elf = read_elf(buffer);

            this.instruction_pointer[0] = this.get_seg_cs() + elf.header.entry | 0;

            for(let program of elf.program_headers)
            {
                if(program.type === 0)
                {
                    // null
                }
                else if(program.type === 1)
                {
                    // load

                    // Since multiboot specifies that paging is disabled,
                    // virtual and physical address must be equal
                    dbg_assert(program.paddr === program.vaddr);
                    dbg_assert(program.filesz <= program.memsz);

                    if(program.paddr + program.memsz < this.memory_size[0])
                    {
                        if(program.filesz) // offset might be outside of buffer if filesz is 0
                        {
                            let blob = new Uint8Array(buffer, program.offset, program.filesz);
                            this.write_blob(blob, program.paddr);
                        }
                    }
                    else
                    {
                        dbg_log("Warning: Skipped loading section, paddr=" + h(program.paddr) + " memsz=" + program.memsz, LOG_CPU);
                    }
                }
                else if(
                    program.type === 2 ||
                    program.type === 3 ||
                    program.type === 4 ||
                    program.type === 6 ||
                    program.type === 0x6474e550 ||
                    program.type === 0x6474e551)
                {
                    // ignore for now
                }
                else
                {
                    dbg_assert(false, "unimplemented elf section type");
                }
            }
        }
        else
        {
            dbg_assert(false, "Not a bootable multiboot format");
        }

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
        for(let i = 0xE; i <= 0xF; i++)
        {
            this.io.register_write(0x2000 + i, this,
                function(value)
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
                });
        }

        dbg_log("Starting multiboot kernel at:", LOG_CPU);
        this.debug.dump_state();
        this.debug.dump_regs();

        break;
    }
};

CPU.prototype.fill_cmos = function(rtc, settings)
{
    var boot_order = settings.boot_order || 0x213;

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
    if (settings.fastboot) rtc.cmos_write(0x3f, 0x01);
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

    // load bios
    var data = new Uint8Array(bios),
        start = 0x100000 - bios.byteLength;

    this.write_blob(data, start);

    if(vga_bios)
    {
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

CPU.prototype.do_run = function()
{
    /** @type {number} */
    var start = v86.microtick();

    /** @type {number} */
    var now = start;

    // outer loop:
    // runs cycles + timers
    for(; now - start < TIME_PER_FRAME;)
    {
        this.run_hardware_timers(now);
        this.handle_irqs();

        this.do_many_cycles();

        if(this.in_hlt[0])
        {
            return;
        }

        now = v86.microtick();
    }
};

let do_many_cycles_count = 0;
let do_many_cycles_total = 0;

CPU.prototype.do_many_cycles = function()
{
    if(DEBUG)
    {
        var start_time = v86.microtick();
    }

    this.do_many_cycles_native();

    if(DEBUG)
    {
        do_many_cycles_total += v86.microtick() - start_time;
        do_many_cycles_count++;
    }
};

/** @export */
CPU.prototype.cycle = function()
{
    // XXX: May do several cycles
    this.cycle_internal();
};

var seen_code = {};
var seen_code_uncompiled = {};

CPU.prototype.codegen_finalize = function(wasm_table_index, start, state_flags, ptr, len)
{
    ptr >>>= 0;
    len >>>= 0;

    dbg_assert(wasm_table_index >= 0 && wasm_table_index < WASM_TABLE_SIZE);

    const code = new Uint8Array(this.wasm_memory.buffer, ptr, len);

    if(DEBUG)
    {
        if(DUMP_GENERATED_WASM && !seen_code[start])
        {
            this.debug.dump_wasm(code);

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

                this.debug.dump_code(this.is_32[0] ? 1 : 0, buffer, start);
            }
        }

        seen_code[start] = (seen_code[start] || 0) + 1;

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

        this.codegen_finalize_finished(wasm_table_index, start, state_flags);

        this.wm.wasm_table.set(wasm_table_index + WASM_TABLE_OFFSET, f);

        if(this.test_hook_did_finalize_wasm)
        {
            this.test_hook_did_finalize_wasm(code);
        }

        return;
    }

    const result = WebAssembly.instantiate(code, { "e": this.jit_imports }).then(result => {
        const f = result.instance.exports["f"];

        this.codegen_finalize_finished(wasm_table_index, start, state_flags);

        this.wm.wasm_table.set(wasm_table_index + WASM_TABLE_OFFSET, f);

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

    if((seen_code_uncompiled[start] || 0) < 100)
    {
        seen_code_uncompiled[start] = (seen_code_uncompiled[start] || 0) + 1;

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
        this.debug.dump_code(this.is_32[0] ? 1 : 0, buffer, start);
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
        this.debug.dump_code(is_32 ? 1 : 0, buffer, start);
    }
};

CPU.prototype.dbg_log = function()
{
    dbg_log("from wasm: " + [].join.call(arguments));
};

CPU.prototype.dbg_assert = function(x)
{
    dbg_assert(x);
};

CPU.prototype.hlt_loop = function()
{
    if(this.get_eflags_no_arith() & flag_interrupt)
    {
        //dbg_log("In HLT loop", LOG_CPU);

        this.run_hardware_timers(v86.microtick());
        this.handle_irqs();

        return 0;
    }
    else
    {
        return 100;
    }
};

CPU.prototype.run_hardware_timers = function(now)
{
    if(ENABLE_HPET)
    {
        var pit_time = this.devices.pit.timer(now, this.devices.hpet.legacy_mode);
        var rtc_time = this.devices.rtc.timer(now, this.devices.hpet.legacy_mode);
        this.devices.hpet.timer(now);
    }
    else
    {
        var pit_time = this.devices.pit.timer(now, false);
        var rtc_time = this.devices.rtc.timer(now, false);
    }

    if(this.acpi_enabled[0])
    {
        this.devices.acpi.timer(now);
        this.devices.apic.timer(now);
    }
};

CPU.prototype.cpl_changed = function()
{
    this.last_virt_eip[0] = -1;
};

CPU.prototype.do_task_switch = function(selector, has_error_code, error_code)
{
    dbg_assert(this.tss_size_32[0], "TODO");

    dbg_log("do_task_switch sel=" + h(selector), LOG_CPU);
    var descriptor = this.lookup_segment_selector(selector);

    dbg_assert((descriptor.type | 2) === 3 || (descriptor.type | 2) === 0xb);
    var tss_is_16 = descriptor.type <= 3;
    var tss_is_busy = (descriptor.type & 2) === 2;

    if(!descriptor.is_valid || descriptor.is_null || !descriptor.from_gdt)
    {
        throw this.debug.unimpl("#GP handler");
    }

    if((descriptor.access & 31) === 0xB)
    {
        // is busy
        throw this.debug.unimpl("#GP handler");
    }

    if(!descriptor.is_present)
    {
        throw this.debug.unimpl("#NP handler");
    }

    if(descriptor.effective_limit < 103)
    {
        throw this.debug.unimpl("#NP handler");
    }

    var tsr_size = this.segment_limits[reg_tr];
    var tsr_offset = this.segment_offsets[reg_tr];

    var old_eflags = this.get_eflags();

    if(tss_is_busy)
    {
        old_eflags &= ~flag_nt;
    }

    if(!this.writable_or_pagefault(tsr_offset, 0x66))
    {
        return;
    }

    //this.safe_write32(tsr_offset + TSR_CR3, this.cr[3]);

    // TODO: Write 16 bit values if old tss is 16 bit
    this.safe_write32(tsr_offset + TSR_EIP, this.get_real_eip());
    this.safe_write32(tsr_offset + TSR_EFLAGS, old_eflags);

    this.safe_write32(tsr_offset + TSR_EAX, this.reg32[reg_eax]);
    this.safe_write32(tsr_offset + TSR_ECX, this.reg32[reg_ecx]);
    this.safe_write32(tsr_offset + TSR_EDX, this.reg32[reg_edx]);
    this.safe_write32(tsr_offset + TSR_EBX, this.reg32[reg_ebx]);

    this.safe_write32(tsr_offset + TSR_ESP, this.reg32[reg_esp]);
    this.safe_write32(tsr_offset + TSR_EBP, this.reg32[reg_ebp]);
    this.safe_write32(tsr_offset + TSR_ESI, this.reg32[reg_esi]);
    this.safe_write32(tsr_offset + TSR_EDI, this.reg32[reg_edi]);

    this.safe_write32(tsr_offset + TSR_ES, this.sreg[reg_es]);
    this.safe_write32(tsr_offset + TSR_CS, this.sreg[reg_cs]);
    this.safe_write32(tsr_offset + TSR_SS, this.sreg[reg_ss]);
    this.safe_write32(tsr_offset + TSR_DS, this.sreg[reg_ds]);
    this.safe_write32(tsr_offset + TSR_FS, this.sreg[reg_fs]);
    this.safe_write32(tsr_offset + TSR_GS, this.sreg[reg_gs]);

    //this.safe_write32(tsr_offset + TSR_LDT, this.sreg[reg_ldtr]);

    if(true /* is jump or call or int */)
    {
        // mark as busy
        this.write8(descriptor.table_offset + 5 | 0, this.read8(descriptor.table_offset + 5 | 0) | 2);
    }

    //var new_tsr_size = descriptor.effective_limit;
    var new_tsr_offset = descriptor.base;

    dbg_assert(!tss_is_16, "unimplemented");

    if(true /* is call or int */)
    {
        this.safe_write16(new_tsr_offset + TSR_BACKLINK, this.sreg[reg_tr]);
    }

    var new_cr3 = this.safe_read32s(new_tsr_offset + TSR_CR3);

    this.flags[0] &= ~flag_vm;

    var new_eip = this.safe_read32s(new_tsr_offset + TSR_EIP);
    var new_cs = this.safe_read16(new_tsr_offset + TSR_CS);
    var info = this.lookup_segment_selector(new_cs);

    if(info.is_null)
    {
        dbg_log("null cs", LOG_CPU);
        throw this.debug.unimpl("#TS handler");
    }

    if(!info.is_valid)
    {
        dbg_log("invalid cs: " + h(selector), LOG_CPU);
        throw this.debug.unimpl("#TS handler");
    }

    if(info.is_system)
    {
        throw this.debug.unimpl("#TS handler");
    }

    if(!info.is_executable)
    {
        throw this.debug.unimpl("#TS handler");
    }

    if(info.dc_bit && info.dpl > info.rpl)
    {
        dbg_log("cs conforming and dpl > rpl: " + h(selector), LOG_CPU);
        throw this.debug.unimpl("#TS handler");
    }

    if(!info.dc_bit && info.dpl !== info.rpl)
    {
        dbg_log("cs non-conforming and dpl != rpl: " + h(selector), LOG_CPU);
        throw this.debug.unimpl("#TS handler");
    }

    if(!info.is_present)
    {
        dbg_log("#NP for loading not-present in cs sel=" + h(selector, 4), LOG_CPU);
        throw this.debug.unimpl("#TS handler");
    }

    this.segment_is_null[reg_cs] = 0;
    this.segment_limits[reg_cs] = info.effective_limit;
    this.segment_offsets[reg_cs] = info.base;
    this.sreg[reg_cs] = new_cs;

    this.cpl = info.dpl;
    this.cpl_changed();

    dbg_assert((this.sreg[reg_cs] & 3) === this.cpl);

    dbg_assert((new_eip >>> 0) <= info.effective_limit, "todo: #gp");
    this.update_cs_size(info.size);

    var new_eflags = this.safe_read32s(new_tsr_offset + TSR_EFLAGS);

    if(true /* is call or int */)
    {
        this.safe_write32(tsr_offset + TSR_BACKLINK, selector);
        new_eflags |= flag_nt;
    }

    if(new_eflags & flag_vm)
    {
        throw this.debug.unimpl("task switch to VM mode");
    }

    this.update_eflags(new_eflags);

    if(true /* call or int */)
    {
        this.flags[0] |= flag_nt;
    }

    var new_ldt = this.safe_read16(new_tsr_offset + TSR_LDT);
    this.load_ldt(new_ldt);

    this.reg32[reg_eax] = this.safe_read32s(new_tsr_offset + TSR_EAX);
    this.reg32[reg_ecx] = this.safe_read32s(new_tsr_offset + TSR_ECX);
    this.reg32[reg_edx] = this.safe_read32s(new_tsr_offset + TSR_EDX);
    this.reg32[reg_ebx] = this.safe_read32s(new_tsr_offset + TSR_EBX);

    this.reg32[reg_esp] = this.safe_read32s(new_tsr_offset + TSR_ESP);
    this.reg32[reg_ebp] = this.safe_read32s(new_tsr_offset + TSR_EBP);
    this.reg32[reg_esi] = this.safe_read32s(new_tsr_offset + TSR_ESI);
    this.reg32[reg_edi] = this.safe_read32s(new_tsr_offset + TSR_EDI);

    if(
        !this.switch_seg(reg_es, this.safe_read16(new_tsr_offset + TSR_ES)) ||
        !this.switch_seg(reg_ss, this.safe_read16(new_tsr_offset + TSR_SS)) ||
        !this.switch_seg(reg_ds, this.safe_read16(new_tsr_offset + TSR_DS)) ||
        !this.switch_seg(reg_fs, this.safe_read16(new_tsr_offset + TSR_FS)) ||
        !this.switch_seg(reg_gs, this.safe_read16(new_tsr_offset + TSR_GS))
    )
    {
        // XXX: Should be checked before side effects
        dbg_assert(false);
    }

    this.instruction_pointer[0] = this.get_seg_cs() + new_eip | 0;

    this.segment_offsets[reg_tr] = descriptor.base;
    this.segment_limits[reg_tr] = descriptor.effective_limit;
    this.sreg[reg_tr] = selector;

    this.cr[3] = new_cr3;
    dbg_assert((this.cr[3] & 0xFFF) === 0);
    this.clear_tlb();

    this.cr[0] |= CR0_TS;

    if(has_error_code !== false)
    {
        if(tss_is_16)
        {
            this.push16(error_code & 0xFFFF);
        }
        else
        {
            this.push32(error_code);
        }
    }
};

CPU.prototype.hlt_op = function()
{
    if(this.cpl[0])
    {
        dbg_log("#gp hlt with cpl != 0", LOG_CPU);
        this.trigger_gp(0);
        return;
    }

    if((this.get_eflags_no_arith() & flag_interrupt) === 0)
    {
        // execution can never resume (until NMIs are supported)
        this.bus.send("cpu-event-halt");
    }

    // get out of here and into hlt_loop
    this.in_hlt[0] = +true;

    // Try an hlt loop right now: This will run timer interrupts, and if one is
    // due it will immediately call call_interrupt_vector and continue
    // execution without an unnecessary cycle through do_run
    this.hlt_loop();
};

CPU.prototype.handle_irqs = function()
{
    //dbg_assert(this.prefixes[0] === 0);

    if(this.get_eflags_no_arith() & flag_interrupt)
    {
        this.pic_acknowledge();
    }
};

CPU.prototype.pic_acknowledge = function()
{
    dbg_assert(this.get_eflags_no_arith() & flag_interrupt);

    if(this.devices.pic)
    {
        this.devices.pic.acknowledge_irq();
    }

    if(this.devices.apic)
    {
        this.devices.apic.acknowledge_irq();
    }
};

CPU.prototype.device_raise_irq = function(i)
{
    dbg_assert(arguments.length === 1);
    if(this.devices.pic)
    {
        this.devices.pic.set_irq(i);
    }

    if(this.devices.ioapic)
    {
        this.devices.ioapic.set_irq(i);
    }
};

CPU.prototype.device_lower_irq = function(i)
{
    if(this.devices.pic)
    {
        this.devices.pic.clear_irq(i);
    }

    if(this.devices.ioapic)
    {
        this.devices.ioapic.clear_irq(i);
    }
};

CPU.prototype.cpuid = function()
{
    // cpuid
    // TODO: Fill in with less bogus values

    // http://lxr.linux.no/linux+%2a/arch/x86/include/asm/cpufeature.h
    // http://www.sandpile.org/x86/cpuid.htm

    var eax = 0;
    var ecx = 0;
    var edx = 0;
    var ebx = 0;

    const winnt_fix = false;
    const level = this.reg32[reg_eax];

    switch(level)
    {
        case 0:
            // maximum supported level
            if(winnt_fix)
            {
                eax = 2;
            }
            else
            {
                eax = 0x16;
            }

            ebx = 0x756E6547|0; // Genu
            edx = 0x49656E69|0; // ineI
            ecx = 0x6C65746E|0; // ntel
            break;

        case 1:
            // pentium
            eax = 3 | 6 << 4 | 15 << 8;
            ebx = 1 << 16 | 8 << 8; // cpu count, clflush size
            ecx = 1 << 23 | 1 << 30; // popcnt, rdrand
            var vme = 0 << 1;
            if(VMWARE_HYPERVISOR_PORT) ecx |= 1 << 31; // hypervisor
            edx = (true /* have fpu */ ? 1 : 0) |      // fpu
                    vme | 1 << 3 | 1 << 4 | 1 << 5 |   // vme, pse, tsc, msr
                    1 << 8 | 1 << 11 | 1 << 13 | 1 << 15 | // cx8, sep, pge, cmov
                    1 << 23 | 1 << 24 | 1 << 25 | 1 << 26;   // mmx, fxsr, sse1, sse2

            if(this.acpi_enabled[0]) //&& this.apic_enabled[0])
            {
                edx |= 1 << 9; // apic
            }
            break;

        case 2:
            // Taken from http://siyobik.info.gf/main/reference/instruction/CPUID
            eax = 0x665B5001|0;
            ebx = 0;
            ecx = 0;
            edx = 0x007A7000;
            break;

        case 4:
            // from my local machine
            switch(this.reg32[reg_ecx])
            {
                case 0:
                    eax = 0x00000121;
                    ebx = 0x01c0003f;
                    ecx = 0x0000003f;
                    edx = 0x00000001;
                    break;
                case 1:
                    eax = 0x00000122;
                    ebx = 0x01c0003f;
                    ecx = 0x0000003f;
                    edx = 0x00000001;
                    break;
                case 2:
                    eax = 0x00000143;
                    ebx = 0x05c0003f;
                    ecx = 0x00000fff;
                    edx = 0x00000001;
                    break;
            }
            break;

        case 5:
            // from my local machine
            eax = 0x40;
            ebx = 0x40;
            ecx = 3;
            edx = 0x00142120;
            break;

        case 7:
            eax = 0; // maximum supported sub-level
            ebx = 1 << 9; // enhanced REP MOVSB/STOSB
            ecx = 0;
            edx = 0;
            break;

        case 0x80000000|0:
            // maximum supported extended level
            eax = 5;
            // other registers are reserved
            break;

        case 0x40000000|0: // hypervisor
            if(VMWARE_HYPERVISOR_PORT)
            {
                // h("Ware".split("").reduce((a, c, i) => a | c.charCodeAt(0) << i * 8, 0))
                ebx = 0x61774D56|0; // VMwa
                ecx = 0x4D566572|0; // reVM
                edx = 0x65726177|0; // ware
            }
            break;

        case 0x15:
            eax = 1; // denominator
            ebx = 1; // numerator
            ecx = TSC_RATE * 1000; // core crystal clock frequency in Hz
            dbg_assert((ecx >>> 0) === ecx);
            //  (TSC frequency = core crystal clock frequency * EBX/EAX)
            break;

        case 0x16:
            eax = Math.floor(TSC_RATE / 1000); // core base frequency in MHz
            ebx = Math.floor(TSC_RATE / 1000); // core maximum frequency in MHz
            ecx = 10; // bus (reference) frequency in MHz

            // 16-bit values
            dbg_assert(eax < 0x10000);
            dbg_assert(ebx < 0x10000);
            dbg_assert(ecx < 0x10000);
            break;

        default:
            dbg_log("cpuid: unimplemented eax: " + h(this.reg32[reg_eax] >>> 0), LOG_CPU);
    }

    if(level === 4)
    {
        dbg_log("cpuid: eax=" + h(this.reg32[reg_eax] >>> 0, 8) + " cl=" + h(this.reg32[reg_ecx] & 0xFF, 2), LOG_CPU);
    }
    else if(level !== 0 && level !== 2 && level !== (0x80000000 | 0))
    {
        dbg_log("cpuid: eax=" + h(this.reg32[reg_eax] >>> 0, 8), LOG_CPU);
    }

    this.reg32[reg_eax] = eax;
    this.reg32[reg_ecx] = ecx;
    this.reg32[reg_edx] = edx;
    this.reg32[reg_ebx] = ebx;
};

CPU.prototype.update_cs_size = function(new_size)
{
    new_size = Boolean(new_size);

    if(Boolean(this.is_32[0]) !== new_size)
    {
        this.is_32[0] = +new_size;
    }
};

/**
 * @param {number} selector
 */
CPU.prototype.lookup_segment_selector = function(selector)
{
    dbg_assert(typeof selector === "number" && selector >= 0 && selector < 0x10000);

    var is_gdt = (selector & 4) === 0,
        selector_offset = selector & ~7,
        info,
        table_offset,
        table_limit;

    info = {
        rpl: selector & 3,
        from_gdt: is_gdt,
        is_null: false,
        is_valid: true,

        base: 0,
        access: 0,
        flags: 0,
        type: 0,
        dpl: 0,
        is_system: false,
        is_present: false,
        is_executable: false,
        rw_bit: false,
        dc_bit: false,
        size: false,

        is_conforming_executable: false,

        // limit after applying granularity
        effective_limit: 0,

        is_writable: false,
        is_readable: false,
        table_offset: 0,

        raw0: 0,
        raw1: 0,
    };

    if(is_gdt)
    {
        table_offset = this.gdtr_offset[0];
        table_limit = this.gdtr_size[0];
    }
    else
    {
        table_offset = this.segment_offsets[reg_ldtr];
        table_limit = this.segment_limits[reg_ldtr];
    }

    if(is_gdt && selector_offset === 0)
    {
        info.is_null = true;
        return info;
    }

    // limit is the number of entries in the table minus one
    if((selector | 7) > table_limit)
    {
        dbg_log("Selector " + h(selector, 4) + " is outside of the " +
            (is_gdt ? "g" : "l") + "dt limits", LOG_CPU);
        info.is_valid = false;
        return info;
    }

    table_offset = table_offset + selector_offset | 0;

    if(this.cr[0] & CR0_PG)
    {
        table_offset = this.translate_address_system_read(table_offset);
    }
    info.table_offset = table_offset;

    info.base = this.read16(table_offset + 2 | 0) | this.read8(table_offset + 4 | 0) << 16 |
                this.read8(table_offset + 7 | 0) << 24;
    info.access = this.read8(table_offset + 5 | 0);
    info.flags = this.read8(table_offset + 6 | 0) >> 4;

    info.raw0 = this.read32s(table_offset     | 0);
    info.raw1 = this.read32s(table_offset + 4 | 0);

    //this.write8(table_offset + 5 | 0, info.access | 1);

    // used if system
    info.type = info.access & 0xF;

    info.dpl = info.access >> 5 & 3;

    info.is_system = (info.access & 0x10) === 0;
    info.is_present = (info.access & 0x80) === 0x80;
    info.is_executable = (info.access & 8) === 8;

    info.rw_bit = (info.access & 2) === 2;
    info.dc_bit = (info.access & 4) === 4;

    info.is_conforming_executable = info.dc_bit && info.is_executable;

    info.size = (info.flags & 4) === 4;

    var limit = this.read16(table_offset) |
                (this.read8(table_offset + 6 | 0) & 0xF) << 16;

    if(info.flags & 8)
    {
        // granularity set
        info.effective_limit = (limit << 12 | 0xFFF) >>> 0;
    }
    else
    {
        info.effective_limit = limit;
    }

    info.is_writable = info.rw_bit && !info.is_executable;
    info.is_readable = info.rw_bit || !info.is_executable;

    return info;
};

/**
 * Returns false if changing was aborted due to an exception
 *
 * @param {number} reg
 * @param {number} selector
 */
CPU.prototype.switch_seg = function(reg, selector)
{
    dbg_assert(reg >= 0 && reg <= 5);
    dbg_assert(typeof selector === "number" && selector < 0x10000 && selector >= 0);

    if(!this.protected_mode[0] || this.vm86_mode())
    {
        this.sreg[reg] = selector;
        this.segment_is_null[reg] = 0;
        this.segment_offsets[reg] = selector << 4;

        if(reg === reg_ss)
        {
            this.stack_size_32[0] = +false;
        }
        return true;
    }

    var info = this.lookup_segment_selector(selector);

    if(reg === reg_ss)
    {
        if(info.is_null)
        {
            dbg_log("#GP for loading 0 in SS sel=" + h(selector, 4), LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_gp(0);
            return false;
        }

        if(!info.is_valid ||
           info.is_system ||
           info.rpl !== this.cpl[0] ||
           !info.is_writable ||
           info.dpl !== this.cpl[0])
        {
            dbg_log("#GP for loading invalid in SS sel=" + h(selector, 4), LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_gp(selector & ~3);
            return false;
        }

        if(!info.is_present)
        {
            dbg_log("#SS for loading non-present in SS sel=" + h(selector, 4), LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_ss(selector & ~3);
            return false;
        }

        this.stack_size_32[0] = info.size;
    }
    else if(reg === reg_cs)
    {
        // handled by switch_cs_real_mode, far_return or far_jump
        dbg_assert(false);
    }
    else
    {
        // es, ds, fs, gs
        if(info.is_null)
        {
            //dbg_log("0 loaded in seg=" + reg + " sel=" + h(selector, 4), LOG_CPU);
            //dbg_trace(LOG_CPU);
            this.sreg[reg] = selector;
            this.segment_is_null[reg] = 1;
            return true;
        }

        if(!info.is_valid ||
           info.is_system ||
           !info.is_readable ||
           (!info.is_conforming_executable &&
            (info.rpl > info.dpl || this.cpl[0] > info.dpl))
        ) {
            dbg_log("#GP for loading invalid in seg " + reg + " sel=" + h(selector, 4), LOG_CPU);
            this.debug.dump_state();
            this.debug.dump_regs();
            dbg_trace(LOG_CPU);
            this.trigger_gp(selector & ~3);
            return false;
        }

        if(!info.is_present)
        {
            dbg_log("#NP for loading not-present in seg " + reg + " sel=" + h(selector, 4), LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_np(selector & ~3);
            return false;
        }
    }

    this.segment_is_null[reg] = 0;
    this.segment_limits[reg] = info.effective_limit;
    //this.segment_infos[reg] = 0; // TODO

    this.segment_offsets[reg] = info.base;
    this.sreg[reg] = selector;

    return true;
};

CPU.prototype.load_tr = function(selector)
{
    var info = this.lookup_segment_selector(selector);

    dbg_assert(info.is_valid);
    //dbg_log("load tr: " + h(selector, 4) + " offset=" + h(info.base >>> 0, 8) + " limit=" + h(info.effective_limit >>> 0, 8), LOG_CPU);

    if(!info.from_gdt)
    {
        throw this.debug.unimpl("TR can only be loaded from GDT");
    }

    if(info.is_null)
    {
        dbg_log("#GP(0) | tried to load null selector (ltr)");
        throw this.debug.unimpl("#GP handler");
    }

    if(!info.is_system)
    {
        dbg_log("#GP | ltr: not a system entry");
        throw this.debug.unimpl("#GP handler (happens when running kvm-unit-test without ACPI)");
    }

    if(info.type !== 9 && info.type !== 1)
    {
        // 0xB: busy 386 TSS (GP)
        // 0x9: 386 TSS
        // 0x3: busy 286 TSS (GP)
        // 0x1: 286 TSS (??)
        dbg_log("#GP | ltr: invalid type (type = " + h(info.type) + ")");
        throw this.debug.unimpl("#GP handler");
    }

    if(!info.is_present)
    {
        dbg_log("#NT | present bit not set (ltr)");
        throw this.debug.unimpl("#NT handler");
    }

    this.tss_size_32[0] = info.type === 9;
    this.segment_offsets[reg_tr] = info.base;
    this.segment_limits[reg_tr] = info.effective_limit;
    this.sreg[reg_tr] = selector;

    // Mark task as busy
    this.write8(info.table_offset + 5 | 0, this.read8(info.table_offset + 5 | 0) | 2);

    //dbg_log("tsr at " + h(info.base) + "; (" + info.effective_limit + " bytes)");
};

CPU.prototype.load_ldt = function(selector)
{
    var info = this.lookup_segment_selector(selector);

    if(info.is_null)
    {
        // invalid
        this.segment_offsets[reg_ldtr] = 0;
        this.segment_limits[reg_ldtr] = 0;
        return;
    }

    dbg_assert(info.is_valid);

    if(!info.from_gdt)
    {
        throw this.debug.unimpl("LDTR can only be loaded from GDT");
    }

    if(!info.is_present)
    {
        dbg_log("lldt: present bit not set");
        throw this.debug.unimpl("#GP handler");
    }

    if(!info.is_system)
    {
        dbg_log("lldt: not a system entry");
        throw this.debug.unimpl("#GP handler");
    }

    if(info.type !== 2)
    {
        dbg_log("lldt: invalid type (" + info.type + ")");
        throw this.debug.unimpl("#GP handler");
    }

    this.segment_offsets[reg_ldtr] = info.base;
    this.segment_limits[reg_ldtr] = info.effective_limit;
    this.sreg[reg_ldtr] = selector;

    //dbg_log("ldt at " + h(info.base >>> 0) + "; (" + info.effective_limit + " bytes)", LOG_CPU);
};

// Closure Compiler's way of exporting
if(typeof window !== "undefined")
{
    window["CPU"] = CPU;
}
else if(typeof module !== "undefined" && typeof module.exports !== "undefined")
{
    module.exports["CPU"] = CPU;
}
else if(typeof importScripts === "function")
{
    self["CPU"] = CPU;
}
