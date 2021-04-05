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

    if(DEBUG)
    {
        this.do_many_cycles_count = 0;
        this.do_many_cycles_total = 0;

        this.seen_code = {};
        this.seen_code_uncompiled = {};
    }

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

    this.reset_cpu = get_import("reset_cpu");

    this.getiopl = get_import("getiopl");
    this.get_eflags = get_import("get_eflags");
    this.get_eflags_no_arith = get_import("get_eflags_no_arith");

    this.pic_call_irq = get_import("pic_call_irq");

    this.do_many_cycles_native = get_import("do_many_cycles_native");
    this.cycle_internal = get_import("cycle_internal");

    this.read8 = get_import("read8");
    this.read16 = get_import("read16");
    this.read32s = get_import("read32s");
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

    this.set_tsc = get_import("set_tsc");
    this.store_current_tsc = get_import("store_current_tsc");

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
    this.reset_cpu();

    this.fw_value = [];

    if(this.devices.virtio)
    {
        this.devices.virtio.reset();
    }

    this.load_bios();
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

    this.reset_cpu();

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

        this.reg32[REG_EAX] = 0x2BADB002;

        let multiboot_info_addr = 0x7C00;
        this.reg32[REG_EBX] = multiboot_info_addr;
        this.write32(multiboot_info_addr, 0);

        this.cr[0] = 1;
        this.protected_mode[0] = +true;
        this.flags[0] = FLAGS_DEFAULT;
        this.is_32[0] = +true;
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
                    program.type === 0x6474e551 ||
                    program.type === 0x6474e553)
                {
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

CPU.prototype.do_many_cycles = function()
{
    if(DEBUG)
    {
        var start_time = v86.microtick();
    }

    this.do_many_cycles_native();

    if(DEBUG)
    {
        this.do_many_cycles_total += v86.microtick() - start_time;
        this.do_many_cycles_count++;
    }
};

/** @export */
CPU.prototype.cycle = function()
{
    // XXX: May do several cycles
    this.cycle_internal();
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

CPU.prototype.hlt_loop = function()
{
    if(this.get_eflags_no_arith() & FLAG_INTERRUPT)
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

CPU.prototype.hlt_op = function()
{
    if((this.get_eflags_no_arith() & FLAG_INTERRUPT) === 0)
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

    if(this.get_eflags_no_arith() & FLAG_INTERRUPT)
    {
        this.pic_acknowledge();
    }
};

CPU.prototype.pic_acknowledge = function()
{
    dbg_assert(this.get_eflags_no_arith() & FLAG_INTERRUPT);

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
