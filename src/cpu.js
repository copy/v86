"use strict";

// Resources:
// https://pdos.csail.mit.edu/6.828/2006/readings/i386/toc.htm
// https://www-ssl.intel.com/content/www/us/en/processors/architectures-software-developer-manuals.html
// http://ref.x86asm.net/geek32.html


/** @constructor */
function CPU()
{
    /** @type {number} */
    this.memory_size = 0;

    // Note: Currently unused (degrades performance and not required by any OS
    //       that we support)
    this.a20_enabled = true;

    this.mem8 = new Uint8Array(0);
    this.mem16 = new Uint16Array(this.mem8.buffer);
    this.mem32s = new Int32Array(this.mem8.buffer);

    this.segment_is_null = [];
    this.segment_offsets = [];
    this.segment_limits = [];
    //this.segment_infos = [];

    /**
     * Translation Lookaside Buffer
     * @const
     */
    this.tlb_data = new Int32Array(1 << 20);

    /**
     * Information about which pages are cached in the tlb.
     * By bit:
     *   0 system, read
     *   1 system, write
     *   2 user, read
     *   3 user, write
     * @const
     */
    this.tlb_info = new Uint8Array(1 << 20);

    /**
     * Same as tlb_info, except it only contains global pages
     * @const
     */
    this.tlb_info_global = new Uint8Array(1 << 20);

    /**
     * Wheter or not in protected mode
     * @type {boolean}
     */
    this.protected_mode = false;

    /**
     * interrupt descriptor table
     * @type {number}
     */
    this.idtr_size = 0;
    /** @type {number} */
    this.idtr_offset = 0;

    /**
     * global descriptor table register
     * @type {number}
     */
    this.gdtr_size = 0;
    /** @type {number} */
    this.gdtr_offset = 0;

    /*
     * whether or not a page fault occured
     */
    this.page_fault = false;

    this.cr = new Int32Array(8);

    /** @type {number} */
    this.cr[0] = 0;
    /** @type {number} */
    this.cr[2] = 0;
    /** @type {number} */
    this.cr[3] = 0;
    /** @type {number} */
    this.cr[4] = 0;

    // current privilege level
    /** @type {number} */
    this.cpl = 0;

    // if false, pages are 4 KiB, else 4 Mib
    /** @type {number} */
    this.page_size_extensions = 0;

    // current operand/address/stack size
    /** @type {boolean} */
    this.is_32 = false;
    /** @type {boolean} */
    this.operand_size_32 = false;
    /** @type {boolean} */
    this.stack_size_32 = false;

    /** @type {boolean} */
    this.address_size_32 = false;

    /**
     * Was the last instruction a hlt?
     * @type {boolean}
     */
    this.in_hlt = false;

    /** @type {!Object} */
    this.devices = {
        vga: {
            timer: function(now) {},
            destroy: function() {},
        },
        ps2: {
            timer: function(now) {},
            destroy: function() {},
        },
    };

    /** @type {number} */
    this.last_virt_eip = 0;

    /** @type {number} */
    this.eip_phys = 0;

    /** @type {number} */
    this.last_virt_esp = 0;

    /** @type {number} */
    this.esp_phys = 0;


    /** @type {number} */
    this.sysenter_cs = 0;

    /** @type {number} */
    this.sysenter_esp = 0;

    /** @type {number} */
    this.sysenter_eip = 0;


    /** @type {number} */
    this.repeat_string_prefix = REPEAT_STRING_PREFIX_NONE;

    /** @type {number} */
    this.flags = 0;

    /**
     * bitmap of flags which are not updated in the flags variable
     * changed by arithmetic instructions, so only relevant to arithmetic flags
     * @type {number}
     */
    this.flags_changed = 0;

    /**
     * the last 2 operators and the result and size of the last arithmetic operation
     * @type {number}
     */
    this.last_op1 = 0;
    /** @type {number} */
    this.last_op2 = 0;
    /** @type {number} */
    this.last_op_size = 0;

    /** @type {number} */
    this.last_add_result = 0;

    /** @type {number} */
    this.last_result = 0;

    this.mul32_result = new Int32Array(2);
    this.div32_result = new Float64Array(2);

    this.tsc_offset = 0;

    /** @type {number} */
    this.modrm_byte = 0;

    /** @type {number} */
    this.phys_addr = 0;

    /** @type {number} */
    this.phys_addr_high = 0;


    // cpu.reg16 or cpu.reg32s, depending on address size attribute
    this.regv = this.reg16;
    this.reg_vcx = 0;
    this.reg_vsi = 0;
    this.reg_vdi = 0;

    this.table = [];

    // paging enabled
    /** @type {boolean} */
    this.paging = false;


    /** @type {number} */
    this.instruction_pointer = 0;

    /** @type {number} */
    this.previous_ip = 0;

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

    /**
     * @type {number}
     */
    this.timestamp_counter = 0;

    // registers
    this.reg32s = new Int32Array(8);
    this.reg32 = new Uint32Array(this.reg32s.buffer);
    this.reg16s = new Int16Array(this.reg32s.buffer);
    this.reg16 = new Uint16Array(this.reg32s.buffer);
    this.reg8s = new Int8Array(this.reg32s.buffer);
    this.reg8 = new Uint8Array(this.reg32s.buffer);

    // segment registers, tr and ldtr
    this.sreg = new Uint16Array(8);

    // debug registers
    this.dreg = new Int32Array(8);

    // current state of prefixes
    this.segment_prefix = SEG_PREFIX_NONE;

    // dynamic instruction translator
    this.translator = undefined;

    this.io = undefined;
    this.fpu = undefined;

    dbg_assert(this.table16 && this.table32);
    dbg_assert(this.table0F_16 && this.table0F_32);

    this.update_address_size();
    this.update_operand_size();

    this.tsc_offset = v86.microtick();

    this.debug_init();

    //Object.seal(this);
}

CPU.prototype.get_state = function()
{
    var state = [];

    state[0] = this.memory_size;
    state[1] = this.segment_is_null;
    state[2] = this.segment_offsets;
    state[3] = this.segment_limits;
    state[4] = this.protected_mode;
    state[5] = this.idtr_offset;
    state[6] = this.idtr_size;
    state[7] = this.gdtr_offset;
    state[8] = this.gdtr_size;
    state[9] = this.page_fault;
    state[10] = this.cr;
    state[11] = this.cpl;
    state[12] = this.page_size_extensions;
    state[13] = this.is_32;
    state[14] = this.operand_size_32;
    state[15] = this.address_size_32;
    state[16] = this.stack_size_32;
    state[17] = this.in_hlt;
    state[18] = this.last_virt_eip;
    state[19] = this.eip_phys;
    state[20] = this.last_virt_esp;
    state[21] = this.esp_phys;
    state[22] = this.sysenter_cs;
    state[23] = this.sysenter_eip;
    state[24] = this.sysenter_esp;
    state[25] = this.repeat_string_prefix;
    state[26] = this.flags;
    state[27] = this.flags_changed;
    state[28] = this.last_op1;
    state[29] = this.last_op2;
    state[30] = this.last_op_size;
    state[31] = this.last_add_result;
    state[32] = this.modrm_byte;

    state[36] = this.paging;
    state[37] = this.instruction_pointer;
    state[38] = this.previous_ip;
    state[39] = this.reg32s;
    state[40] = this.sreg;
    state[41] = this.dreg;
    state[42] = this.mem8;
    state[43] = this.fpu;

    state[45] = this.devices.virtio;
    //state[46] = this.devices.apic;
    state[47] = this.devices.rtc;
    state[48] = this.devices.pci;
    state[49] = this.devices.dma;
    //state[50] = this.devices.acpi;
    state[51] = this.devices.hpet;
    state[52] = this.devices.vga;
    state[53] = this.devices.ps2;
    state[54] = this.devices.uart;
    state[55] = this.devices.fdc;
    state[56] = this.devices.cdrom;
    state[57] = this.devices.hda;
    state[58] = this.devices.pit;
    state[59] = this.devices.net;
    state[60] = this.devices.pic;

    state[61] = this.a20_enabled;

    return state;
};

CPU.prototype.set_state = function(state)
{
    this.memory_size = state[0];
    this.segment_is_null = state[1];
    this.segment_offsets = state[2];
    this.segment_limits = state[3];
    this.protected_mode = state[4];
    this.idtr_offset = state[5];
    this.idtr_size = state[6];
    this.gdtr_offset = state[7];
    this.gdtr_size = state[8];
    this.page_fault = state[9];
    this.cr = state[10];
    this.cpl = state[11];
    this.page_size_extensions = state[12];
    this.is_32 = state[13];
    this.operand_size_32 = state[14];
    this.address_size_32 = state[15];
    this.stack_size_32 = state[16];
    this.in_hlt = state[17];
    this.last_virt_eip = state[18];
    this.eip_phys = state[19];
    this.last_virt_esp = state[20];
    this.esp_phys = state[21];
    this.sysenter_cs = state[22];
    this.sysenter_eip = state[23];
    this.sysenter_esp = state[24];
    this.repeat_string_prefix = state[25];
    this.flags = state[26];
    this.flags_changed = state[27];
    this.last_op1 = state[28];
    this.last_op2 = state[29];
    this.last_op_size = state[30];
    this.last_add_result = state[31];
    this.modrm_byte = state[32];

    this.paging = state[36];
    this.instruction_pointer = state[37];
    this.previous_ip = state[38];
    this.reg32s = state[39];
    this.sreg = state[40];
    this.dreg = state[41];
    this.mem8 = state[42];
    this.fpu = state[43];

    this.devices.virtio = state[45];
    //this.devices.apic = state[46];
    this.devices.rtc = state[47];
    this.devices.pci = state[48];
    this.devices.dma = state[49];
    //this.devices.acpi = state[50];
    this.devices.hpet = state[51];
    this.devices.vga = state[52];
    this.devices.ps2 = state[53];
    this.devices.uart = state[54];
    this.devices.fdc = state[55];
    this.devices.cdrom = state[56];
    this.devices.hda = state[57];
    this.devices.pit = state[58];
    this.devices.net = state[59];
    this.devices.pic = state[60];

    this.a20_enabled = state[61];

    this.mem16 = new Uint16Array(this.mem8.buffer, this.mem8.byteOffset, this.mem8.length >> 1);
    this.mem32s = new Int32Array(this.mem8.buffer, this.mem8.byteOffset, this.mem8.length >> 2);


    this.full_clear_tlb();
    // tsc_offset?

    this.reg32 = new Uint32Array(this.reg32s.buffer);
    this.reg16s = new Int16Array(this.reg32s.buffer);
    this.reg16 = new Uint16Array(this.reg32s.buffer);
    this.reg8s = new Int8Array(this.reg32s.buffer);
    this.reg8 = new Uint8Array(this.reg32s.buffer);

    this.update_address_size();
    this.update_operand_size();
};


/**
 * @return {number} time in ms until this method should becalled again
 */
CPU.prototype.main_run = function()
{
    if(this.in_hlt)
    {
        //if(false)
        //{
        //    var _t = this.hlt_loop();
        //    var t = 0;
        //}
        //else
        {
            var t = this.hlt_loop();
        }

        if(this.in_hlt)
        {
            return t;
        }
    }

    this.do_run();
    return 0;
};

CPU.prototype.exception_cleanup = function(e)
{
    if(e === MAGIC_CPU_EXCEPTION)
    {
        // A legit CPU exception (for instance, a page fault happened)
        // call_interrupt_vector has already been called at this point,
        // so we just need to reset some state

        this.page_fault = false;

        // restore state from prefixes
        this.clear_prefixes();
    }
    else
    {
        console.log(e);
        console.log(e.stack);
        //var e = new Error(e.message);
        //Error.captureStackTrace && Error.captureStackTrace(e);
        throw e;
    }
}

CPU.prototype.reboot_internal = function()
{
    this.reset();
    this.load_bios();

    throw MAGIC_CPU_EXCEPTION;
};

CPU.prototype.reset = function()
{
    this.a20_enabled = true;

    this.segment_is_null = new Uint8Array(8);
    this.segment_limits = new Uint32Array(8);
    //this.segment_infos = new Uint32Array(8);
    this.segment_offsets = new Int32Array(8);

    this.full_clear_tlb();

    this.reg32s = new Int32Array(8);
    this.reg32 = new Uint32Array(this.reg32s.buffer);
    this.reg16s = new Int16Array(this.reg32s.buffer);
    this.reg16 = new Uint16Array(this.reg32s.buffer);
    this.reg8s = new Int8Array(this.reg32s.buffer);
    this.reg8 = new Uint8Array(this.reg32s.buffer);
    this.sreg = new Uint16Array(8);
    this.dreg = new Int32Array(8);
    this.protected_mode = false;

    // http://www.sandpile.org/x86/initial.htm
    this.idtr_size = 0;
    this.idtr_offset = 0;

    this.gdtr_size = 0;
    this.gdtr_offset = 0;

    this.page_fault = false;
    this.cr[0] = 1 << 30 | 1 << 29 | 1 << 4;
    this.cr[2] = 0;
    this.cr[3] = 0;
    this.cr[4] = 0;
    this.dreg[6] = 0xFFFF0FF0|0;
    this.dreg[7] = 0x400;
    this.cpl = 0;
    this.paging = false;
    this.page_size_extensions = 0;
    this.is_32 = false;
    this.operand_size_32 = false;
    this.stack_size_32 = false;
    this.address_size_32 = false;

    this.paging_changed();

    this.update_operand_size();
    this.update_address_size();

    this.timestamp_counter = 0;
    this.previous_ip = 0;
    this.in_hlt = false;

    this.sysenter_cs = 0;
    this.sysenter_esp = 0;
    this.sysenter_eip = 0;

    this.segment_prefix = SEG_PREFIX_NONE;
    this.repeat_string_prefix = REPEAT_STRING_PREFIX_NONE;
    this.flags = flags_default;
    this.flags_changed = 0;

    this.last_result = 0;
    this.last_add_result = 0;
    this.last_op1 = 0;
    this.last_op2 = 0;
    this.last_op_size = 0;

    this.tsc_offset = v86.microtick();

    this.instruction_pointer = 0xFFFF0;
    this.switch_cs_real_mode(0xF000);

    this.switch_seg(reg_ss, 0x30);
    this.reg16[reg_sp] = 0x100;

    if(this.devices.virtio)
    {
        this.devices.virtio.reset();
    }
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

    this.memory_size = size;

    // use by dynamic translator
    //if(OP_TRANSLATION) this.mem_page_infos = new Uint8Array(1 << 20);

    var buffer = new ArrayBuffer(size);

    this.mem8 = new Uint8Array(buffer);
    this.mem16 = new Uint16Array(buffer);
    this.mem32s = new Int32Array(buffer);
};

CPU.prototype.init = function(settings, device_bus)
{
    this.create_memory(settings.memory_size || 1024 * 1024 * 64);

    this.reset();

    if(OP_TRANSLATION)
    {
        this.translator = new DynamicTranslator(this);
    }

    var io = new IO(this);
    this.io = io;

    this.bios.main = settings.bios;
    this.bios.vga = settings.vga_bios;

    this.load_bios();

    var a20_byte = 0;

    io.register_read(0xB3, this, function()
    {
        // seabios smm_relocate_and_restore
        dbg_log("port 0xB3 read");
        return 0;
    });

    io.register_read(0x92, this, function()
    {
        return a20_byte;
    });

    io.register_write(0x92, this, function(out_byte)
    {
        a20_byte = out_byte;
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

        if(ENABLE_ACPI)
        {
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

        this.fpu = new FPU(this);

        this.devices.ps2 = new PS2(this, device_bus);

        this.devices.uart = new UART(this, 0x3F8, device_bus);

        this.devices.fdc = new FloppyController(this, settings.fda, settings.fdb);

        var ide_device_count = 0;

        if(settings.hda)
        {
            this.devices.hda = new IDEDevice(this, settings.hda, false, ide_device_count++, device_bus);
        }

        if(settings.cdrom)
        {
            this.devices.cdrom = new IDEDevice(this, settings.cdrom, true, ide_device_count++, device_bus);
        }

        if(settings.hdb)
        {
            this.devices.hdb = new IDEDevice(this, settings.hdb, false, ide_device_count++, device_bus);
        }

        this.devices.pit = new PIT(this);

        if(settings.enable_ne2k)
        {
            this.devices.net = new Ne2k(this, device_bus);
        }

        if(settings.fs9p)
        {
            this.devices.virtio = new VirtIO(this, device_bus, settings.fs9p);
        }
    }

    if(DEBUG)
    {
        this.debug.init();
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
    if(this.memory_size >= 1024 * 1024)
    {
        memory_above_1m = (this.memory_size - 1024 * 1024) >> 10;
        memory_above_1m = Math.min(memory_above_1m, 0xFFFF);
    }

    rtc.cmos_write(CMOS_MEM_OLD_EXT_LOW, memory_above_1m & 0xFF);
    rtc.cmos_write(CMOS_MEM_OLD_EXT_HIGH, memory_above_1m >> 8 & 0xFF);
    rtc.cmos_write(CMOS_MEM_EXTMEM_LOW, memory_above_1m & 0xFF);
    rtc.cmos_write(CMOS_MEM_EXTMEM_HIGH, memory_above_1m >> 8 & 0xFF);

    var memory_above_16m = 0; // in 64k blocks
    if(this.memory_size >= 16 * 1024 * 1024)
    {
        memory_above_16m = (this.memory_size - 16 * 1024 * 1024) >> 16;
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
        data = new Uint8Array(vga_bios);
        this.write_blob(data, 0xC0000);
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
        if(ENABLE_HPET)
        {
            this.devices.pit.timer(now, this.devices.hpet.legacy_mode);
            this.devices.rtc.timer(now, this.devices.hpet.legacy_mode);
            this.devices.hpet.timer(now);
        }
        else
        {
            this.devices.pit.timer(now, false);
            this.devices.rtc.timer(now, false);
        }

        if(ENABLE_ACPI)
        {
            this.devices.apic.timer(now);
        }

        this.handle_irqs();
        this.do_many_cycles();

        if(this.in_hlt)
        {
            this.hlt_loop();
            return;
        }

        now = v86.microtick();
    }
};

CPU.prototype.do_many_cycles = function()
{
    try {
        this.do_many_cycles_unsafe();
    }
    catch(e)
    {
        this.exception_cleanup(e);
    }
};

CPU.prototype.do_many_cycles_unsafe = function()
{
    // inner loop:
    // runs only cycles
    for(var k = LOOP_COUNTER; k--;)
    {
        this.cycle_internal();
    }
}

// Some functions must not be inlined, because then more code is in the
// deoptimized try-catch block.
// This trick is a bit ugly, but it works without further complication.
if(typeof window !== "undefined")
{
    window["__no_inline_for_closure_compiler__"] = [
        CPU.prototype.exception_cleanup,
        CPU.prototype.do_many_cycles_unsafe,
        CPU.prototype.do_many_cycles,
    ];
};

/** @const */
var PROFILING = false;

if(PROFILING)
{
    var instruction_total = new Float64Array(256);
    var instruction_count = new Float64Array(256);

    window["print_profiling"] = function print_profiling()
    {
        var prof_instructions = [];
        for(var i = 0; i < 256; i++) prof_instructions[i] = {
            n: h(i, 2),
            total: instruction_total[i],
            count: instruction_count[i],
            per: (instruction_total[i] / instruction_count[i]) || 0,
        }

        console.log("count:");
        console.table(prof_instructions.sort((p0, p1) => p1.count - p0.count));

        console.log("time:");
        console.table(prof_instructions.sort((p0, p1) => p1.total - p0.total));

        console.log("time/count:");
        console.table(prof_instructions.sort((p0, p1) => p1.per - p0.per));
    }
}

/**
 * execute a single instruction cycle on the cpu
 * this includes reading all prefixes and the whole instruction
 */
CPU.prototype.cycle_internal = function()
{
    this.previous_ip = this.instruction_pointer;

    this.timestamp_counter++;

    if(PROFILING)
    {
        var start = performance.now();
    }

    var opcode = this.read_imm8();
    //this.translate_address_read(this.instruction_pointer + 15|0)

    if(DEBUG)
    {
        this.debug.logop(this.instruction_pointer - 1 >>> 0, opcode);
    }

    // call the instruction
    this.table[opcode](this);

    if(PROFILING)
    {
        var end = performance.now();
        instruction_total[opcode] += end - start;
        instruction_count[opcode]++;
    }

    if(this.flags & flag_trap)
    {
        // TODO
        dbg_log("Trap flag: Ignored", LOG_CPU);
    }
};

/** @export */
CPU.prototype.cycle = function()
{
    try
    {
        this.cycle_internal();
    }
    catch(e)
    {
        this.exception_cleanup(e);
    }
};

CPU.prototype.run_prefix_instruction = function()
{
    this.table[this.read_imm8()](this);
};

CPU.prototype.hlt_loop = function()
{
    dbg_assert(this.flags & flag_interrupt);
    //dbg_log("In HLT loop", LOG_CPU);

    var now = v86.microtick();

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

    if(ENABLE_ACPI)
    {
        this.devices.apic.timer(now);
    }

    return pit_time < rtc_time ? pit_time : rtc_time;
};

CPU.prototype.clear_prefixes = function()
{
    this.repeat_string_prefix = REPEAT_STRING_PREFIX_NONE;
    this.segment_prefix = SEG_PREFIX_NONE;

    if(this.address_size_32 !== this.is_32)
    {
        this.address_size_32 = this.is_32;
        this.update_address_size();
    }

    if(this.operand_size_32 !== this.is_32)
    {
        this.operand_size_32 = this.is_32;
        this.update_operand_size();
    }
};

CPU.prototype.cr0_changed = function(old_cr0)
{
    //dbg_log("cr0 = " + h(this.cr[0] >>> 0), LOG_CPU);

    var new_paging = (this.cr[0] & CR0_PG) === CR0_PG;

    if(!this.fpu)
    {
        // if there's no FPU, keep emulation set
        this.cr[0] |= CR0_EM;
    }
    this.cr[0] |= CR0_ET;

    this.paging_changed();

    dbg_assert(typeof this.paging === "boolean");
    if(new_paging !== this.paging)
    {
        this.paging = new_paging;
        this.full_clear_tlb();
    }

    if(OP_TRANSLATION && (this.cr[0] ^ old_cr0) & 1)
    {
        this.translator.clear_cache();
    }
};

CPU.prototype.paging_changed = function()
{
    this.last_virt_eip = -1;
    this.last_virt_esp = -1;
};

CPU.prototype.cpl_changed = function()
{
    this.last_virt_eip = -1;
    this.last_virt_esp = -1;
};

CPU.prototype.read_imm8 = function()
{
    if((this.instruction_pointer & ~0xFFF) ^ this.last_virt_eip)
    {
        this.eip_phys = this.translate_address_read(this.instruction_pointer) ^ this.instruction_pointer;
        this.last_virt_eip = this.instruction_pointer & ~0xFFF;
    }

    var data8 = this.read8(this.eip_phys ^ this.instruction_pointer);
    this.instruction_pointer = this.instruction_pointer + 1 | 0;

    return data8;
};

CPU.prototype.read_imm8s = function()
{
    return this.read_imm8() << 24 >> 24;
};

CPU.prototype.read_imm16 = function()
{
    // Two checks in one comparison:
    //    1. Did the high 20 bits of eip change
    // or 2. Are the low 12 bits of eip 0xFFF (and this read crosses a page boundary)
    if(((this.instruction_pointer ^ this.last_virt_eip) >>> 0) > 0xFFE)
    {
        return this.read_imm8() | this.read_imm8() << 8;
    }

    var data16 = this.read16(this.eip_phys ^ this.instruction_pointer);
    this.instruction_pointer = this.instruction_pointer + 2 | 0;

    return data16;
};

CPU.prototype.read_imm32s = function()
{
    // Analogue to the above comment
    if(((this.instruction_pointer ^ this.last_virt_eip) >>> 0) > 0xFFC)
    {
        return this.read_imm16() | this.read_imm16() << 16;
    }

    var data32 = this.read32s(this.eip_phys ^ this.instruction_pointer);
    this.instruction_pointer = this.instruction_pointer + 4 | 0;

    return data32;
};

CPU.prototype.read_modrm_byte = function()
{
    this.modrm_byte = this.read_imm8();
};

CPU.prototype.read_sib = CPU.prototype.read_imm8;
CPU.prototype.read_op8 = CPU.prototype.read_imm8;
CPU.prototype.read_op8s = CPU.prototype.read_imm8s;
CPU.prototype.read_op16 = CPU.prototype.read_imm16;
CPU.prototype.read_op32s = CPU.prototype.read_imm32s;
CPU.prototype.read_second_op8 = CPU.prototype.read_imm8;
CPU.prototype.read_second_op16 = CPU.prototype.read_imm16;
CPU.prototype.read_disp8s = CPU.prototype.read_imm8s;
CPU.prototype.read_disp16 = CPU.prototype.read_imm16;
CPU.prototype.read_disp32s = CPU.prototype.read_imm32s;

// read word from a page boundary, given 2 physical addresses
CPU.prototype.virt_boundary_read16 = function(low, high)
{
    dbg_assert((low & 0xFFF) === 0xFFF);
    dbg_assert((high & 0xFFF) === 0);

    return this.read8(low) | this.read8(high) << 8;
};

// read doubleword from a page boundary, given 2 addresses
CPU.prototype.virt_boundary_read32s = function(low, high)
{
    dbg_assert((low & 0xFFF) >= 0xFFD);
    dbg_assert((high - 3 & 0xFFF) === (low & 0xFFF));

    var mid;

    if(low & 1)
    {
        if(low & 2)
        {
            // 0xFFF
            mid = this.read_aligned16(high - 2 >> 1);
        }
        else
        {
            // 0xFFD
            mid = this.read_aligned16(low + 1 >> 1);
        }
    }
    else
    {
        // 0xFFE
        mid = this.virt_boundary_read16(low + 1 | 0, high - 1 | 0);
    }

    return this.read8(low) | mid << 8 | this.read8(high) << 24;;
};

CPU.prototype.virt_boundary_write16 = function(low, high, value)
{
    dbg_assert((low & 0xFFF) === 0xFFF);
    dbg_assert((high & 0xFFF) === 0);

    this.write8(low, value);
    this.write8(high, value >> 8);
};

CPU.prototype.virt_boundary_write32 = function(low, high, value)
{
    dbg_assert((low & 0xFFF) >= 0xFFD);
    dbg_assert((high - 3 & 0xFFF) === (low & 0xFFF));

    this.write8(low, value);
    this.write8(high, value >> 24);

    if(low & 1)
    {
        if(low & 2)
        {
            // 0xFFF
            this.write8(high - 2, value >> 8);
            this.write8(high - 1, value >> 16);
        }
        else
        {
            // 0xFFD
            this.write8(low + 1 | 0, value >> 8);
            this.write8(low + 2 | 0, value >> 16);
        }
    }
    else
    {
        // 0xFFE
        this.write8(low + 1 | 0, value >> 8);
        this.write8(high - 1, value >> 16);
    }
};

// safe_read, safe_write
// read or write byte, word or dword to the given *virtual* address,
// and be safe on page boundaries

CPU.prototype.safe_read8 = function(addr)
{
    dbg_assert(addr < 0x80000000);
    return this.read8(this.translate_address_read(addr));
};

CPU.prototype.safe_read16 = function(addr)
{
    if(this.paging && (addr & 0xFFF) === 0xFFF)
    {
        return this.safe_read8(addr) | this.safe_read8(addr + 1 | 0) << 8;
    }
    else
    {
        return this.read16(this.translate_address_read(addr));
    }
};

CPU.prototype.safe_read32s = function(addr)
{
    if(this.paging && (addr & 0xFFF) >= 0xFFD)
    {
        return this.safe_read16(addr) | this.safe_read16(addr + 2 | 0) << 16;
    }
    else
    {
        return this.read32s(this.translate_address_read(addr));
    }
};

CPU.prototype.safe_write8 = function(addr, value)
{
    dbg_assert(addr < 0x80000000);
    this.write8(this.translate_address_write(addr), value);
};

CPU.prototype.safe_write16 = function(addr, value)
{
    var phys_low = this.translate_address_write(addr);

    if((addr & 0xFFF) === 0xFFF)
    {
        this.virt_boundary_write16(phys_low, this.translate_address_write(addr + 1 | 0), value);
    }
    else
    {
        this.write16(phys_low, value);
    }
};

CPU.prototype.safe_write32 = function(addr, value)
{
    var phys_low = this.translate_address_write(addr);

    if((addr & 0xFFF) >= 0xFFD)
    {
        this.virt_boundary_write32(phys_low, this.translate_address_write(addr + 3 | 0), value);
    }
    else
    {
        this.write32(phys_low, value);
    }
};

// read 2 or 4 byte from ip, depending on address size attribute
CPU.prototype.read_moffs = function()
{
    if(this.address_size_32)
    {
        return this.get_seg_prefix(reg_ds) + this.read_op32s() | 0;
    }
    else
    {
        return this.get_seg_prefix(reg_ds) + this.read_op16() | 0;
    }
};

CPU.prototype.getiopl = function()
{
    return this.flags >> 12 & 3;
};

CPU.prototype.vm86_mode = function()
{
    return !!(this.flags & flag_vm);
};

CPU.prototype.get_eflags = function()
{
    return (this.flags & ~flags_all) | !!this.getcf() | !!this.getpf() << 2 | !!this.getaf() << 4 |
                                  !!this.getzf() << 6 | !!this.getsf() << 7 | !!this.getof() << 11;
};

CPU.prototype.load_eflags = function()
{
    this.flags = this.get_eflags();
    this.flags_changed = 0;
};

/**
 * Update the flags register depending on iopl and cpl
 */
CPU.prototype.update_eflags = function(new_flags)
{
    var dont_update = flag_rf | flag_vm | flag_vip | flag_vif,
        clear = ~flag_vip & ~flag_vif & flags_mask;

    if(this.flags & flag_vm)
    {
        // other case needs to be handled in popf or iret
        dbg_assert(this.getiopl() === 3);

        dont_update |= flag_iopl;

        // don't clear vip or vif
        clear |= flag_vip | flag_vif;
    }
    else
    {
        if(!this.protected_mode) dbg_assert(this.cpl === 0);

        if(this.cpl)
        {
            // cpl > 0
            // cannot update iopl
            dont_update |= flag_iopl;

            if(this.cpl > this.getiopl())
            {
                // cpl > iopl
                // cannot update interrupt flag
                dont_update |= flag_interrupt;
            }
        }
    }

    this.flags = (new_flags ^ ((this.flags ^ new_flags) & dont_update)) & clear | flags_default;

    this.flags_changed = 0;
};

CPU.prototype.get_stack_reg = function()
{
    if(this.stack_size_32)
    {
        return this.reg32s[reg_esp];
    }
    else
    {
        return this.reg16[reg_sp];
    }
};

CPU.prototype.set_stack_reg = function(value)
{
    if(this.stack_size_32)
    {
        this.reg32s[reg_esp] = value;
    }
    else
    {
        this.reg16[reg_sp] = value;
    }
};

CPU.prototype.adjust_stack_reg = function(value)
{
    if(this.stack_size_32)
    {
        this.reg32s[reg_esp] += value;
    }
    else
    {
        this.reg16[reg_sp] += value;
    }
};

CPU.prototype.get_stack_pointer = function(mod)
{
    if(this.stack_size_32)
    {
        return this.get_seg(reg_ss) + this.reg32s[reg_esp] + mod | 0;
    }
    else
    {
        return this.get_seg(reg_ss) + (this.reg16[reg_sp] + mod & 0xFFFF) | 0;
    }
};

/*
 * returns the "real" instruction pointer,
 * without segment offset
 */
CPU.prototype.get_real_eip = function()
{
    return this.instruction_pointer - this.get_seg(reg_cs) | 0;
};

CPU.prototype.call_interrupt_vector = function(interrupt_nr, is_software_int, error_code)
{
    //dbg_log("int " + h(interrupt_nr, 2) + " (" + (is_software_int ? "soft" : "hard") + "ware)", LOG_CPU);
    CPU_LOG_VERBOSE && this.debug.dump_state("int start");
    //this.debug.dump_regs_short();

    this.debug.debug_interrupt(interrupt_nr);

    dbg_assert(error_code === false || typeof error_code === "number");

    // we have to leave hlt_loop at some point, this is a
    // good place to do it
    //this.in_hlt && dbg_log("Leave HLT loop", LOG_CPU);
    this.in_hlt = false;

    if(this.protected_mode)
    {
        if(this.vm86_mode() && (this.cr[4] & CR4_VME))
        {
            throw this.debug.unimpl("VME");
        }

        if(this.vm86_mode() && is_software_int && this.getiopl() < 3)
        {
            dbg_log("call_interrupt_vector #GP. vm86 && software int && iopl < 3", LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_gp(0);
        }

        if((interrupt_nr << 3 | 7) > this.idtr_size)
        {
            dbg_log(interrupt_nr, LOG_CPU);
            dbg_trace(LOG_CPU);
            throw this.debug.unimpl("#GP handler");
        }

        var addr = this.idtr_offset + (interrupt_nr << 3) | 0;
        dbg_assert((addr & 0xFFF) < 0xFF8);

        if(this.paging)
        {
            addr = this.translate_address_system_read(addr);
        }

        var base = this.read16(addr) | this.read16(addr + 6 | 0) << 16;
        var selector = this.read16(addr + 2 | 0);
        var access = this.read8(addr + 5 | 0);
        var dpl = access >> 5 & 3;
        var type = access & 31;

        if((access & 0x80) === 0)
        {
            // present bit not set
            throw this.debug.unimpl("#NP handler");
        }

        if(is_software_int && dpl < this.cpl)
        {
            dbg_log("#gp software interrupt (" + h(interrupt_nr, 2) + ") and dpl < cpl", LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_gp(interrupt_nr << 3 | 2);
        }

        if(type === 5)
        {
            // task gate
            dbg_log("interrupt to task gate: int=" + h(interrupt_nr, 2) + " sel=" + h(selector, 4) + " dpl=" + dpl, LOG_CPU);
            dbg_trace(LOG_CPU);

            this.do_task_switch(selector);

            if(error_code !== false)
            {
                // TODO: push16 if in 16 bit mode?
                this.push32(error_code);
            }
            return;
        }

        if((type & ~1 & ~8) !== 6)
        {
            // invalid type
            dbg_trace(LOG_CPU);
            dbg_log("invalid type: " + h(type));
            dbg_log(h(addr) + " " + h(base >>> 0) + " " + h(selector));
            throw this.debug.unimpl("#GP handler");
        }

        var is_trap = (type & 1) === 1;
        var is_16 = (type & 8) === 0;

        var info = this.lookup_segment_selector(selector);

        dbg_assert((base >>> 0) <= info.effective_limit);
        dbg_assert(info.is_valid);

        if(info.is_null)
        {
            dbg_log("is null");
            throw this.debug.unimpl("#GP handler");
        }
        if(!info.is_executable || info.dpl > this.cpl)
        {
            dbg_log("not exec");
            throw this.debug.unimpl("#GP handler");
        }
        if(!info.is_present)
        {
            dbg_log("not present");
            throw this.debug.unimpl("#NP handler");
        }

        this.load_eflags();
        var old_flags = this.flags;

        //dbg_log("interrupt " + h(interrupt_nr, 2) + " (" + (is_software_int ? "soft" : "hard") + "ware) from cpl=" + this.cpl + " vm=" + (this.flags & flag_vm) + " cs:eip=" + h(this.sreg[reg_cs], 4) + ":" + h(this.get_real_eip(), 8) + " to cpl="

        if(!info.dc_bit && info.dpl < this.cpl)
        {
            // inter privilege level interrupt
            // interrupt from vm86 mode

            //dbg_log("Inter privilege interrupt gate=" + h(selector, 4) + ":" + h(base >>> 0, 8) + " trap=" + is_trap + " 16bit=" + is_16, LOG_CPU);
            //this.debug.dump_regs_short();
            var tss_stack_addr = this.get_tss_stack_addr(info.dpl);

            var new_esp = this.read32s(tss_stack_addr);
            var new_ss = this.read16(tss_stack_addr + 4 | 0);
            var ss_info = this.lookup_segment_selector(new_ss);

            // Disabled: Incorrect handling of direction bit
            // See http://css.csail.mit.edu/6.858/2014/readings/i386/s06_03.htm
            //if(!((new_esp >>> 0) <= ss_info.effective_limit))
            //    debugger;
            //dbg_assert((new_esp >>> 0) <= ss_info.effective_limit);
            dbg_assert(ss_info.is_valid && !ss_info.is_system && ss_info.is_writable);

            if(ss_info.is_null)
            {
                throw this.debug.unimpl("#TS handler");
            }
            if(ss_info.rpl !== info.dpl) // xxx: 0 in v86 mode
            {
                throw this.debug.unimpl("#TS handler");
            }
            if(ss_info.dpl !== info.dpl || !ss_info.rw_bit)
            {
                throw this.debug.unimpl("#TS handler");
            }
            if(!ss_info.is_present)
            {
                throw this.debug.unimpl("#TS handler");
            }

            var old_esp = this.reg32s[reg_esp];
            var old_ss = this.sreg[reg_ss];

            if(old_flags & flag_vm)
            {
                //dbg_log("return from vm86 mode");
                //this.debug.dump_regs_short();
                dbg_assert(info.dpl === 0, "switch to non-0 dpl from vm86 mode");
            }

            var stack_space = (is_16 ? 2 : 4) * (5 + (error_code !== false) + 4 * ((old_flags & flag_vm) === flag_vm));
            var new_stack_pointer = ss_info.base + (ss_info.size ? new_esp - stack_space : (new_esp - stack_space & 0xFFFF));

            // XXX: with new cpl or with cpl 0?
            this.translate_address_system_write(new_stack_pointer);
            this.translate_address_system_write(ss_info.base + new_esp - 1);

            // no exceptions below

            this.cpl = info.dpl;
            this.cpl_changed();

            dbg_assert(typeof info.size === "boolean");
            if(this.is_32 !== info.size)
            {
                this.update_cs_size(info.size);
            }

            this.flags &= ~flag_vm & ~flag_rf;

            this.switch_seg(reg_ss, new_ss);
            this.set_stack_reg(new_esp);

            if(old_flags & flag_vm)
            {
                if(is_16)
                {
                    dbg_assert(false);
                }
                else
                {
                    this.push32(this.sreg[reg_gs]);
                    this.push32(this.sreg[reg_fs]);
                    this.push32(this.sreg[reg_ds]);
                    this.push32(this.sreg[reg_es]);
                }
            }

            if(is_16)
            {
                this.push16(old_ss);
                this.push16(old_esp);
            }
            else
            {
                this.push32(old_ss);
                this.push32(old_esp);
            }
        }
        else if(info.dc_bit || info.dpl === this.cpl)
        {
            // intra privilege level interrupt

            //dbg_log("Intra privilege interrupt gate=" + h(selector, 4) + ":" + h(base >>> 0, 8) +
            //        " trap=" + is_trap + " 16bit=" + is_16 +
            //        " cpl=" + this.cpl + " dpl=" + info.dpl + " conforming=" + +info.dc_bit, LOG_CPU);
            //this.debug.dump_regs_short();

            if(this.flags & flag_vm)
            {
                dbg_assert(false, "check error code");
                this.trigger_gp(selector & ~3);
            }

            var stack_space = (is_16 ? 2 : 4) * (3 + (error_code !== false));

            // XXX: with current cpl or with cpl 0?
            this.writable_or_pagefault(this.get_stack_pointer(-stack_space), stack_space);

            // no exceptions below
        }
        else
        {
            throw this.debug.unimpl("#GP handler");
        }

        if(is_16)
        {
            this.push16(old_flags);
            this.push16(this.sreg[reg_cs]);
            this.push16(this.get_real_eip());

            if(error_code !== false)
            {
                this.push16(error_code);
            }

            base &= 0xFFFF;
        }
        else
        {
            this.push32(old_flags);
            this.push32(this.sreg[reg_cs]);
            this.push32(this.get_real_eip());

            if(error_code !== false)
            {
                this.push32(error_code);
            }
        }

        if(old_flags & flag_vm)
        {
            this.switch_seg(reg_gs, 0);
            this.switch_seg(reg_fs, 0);
            this.switch_seg(reg_ds, 0);
            this.switch_seg(reg_es, 0);
        }


        this.sreg[reg_cs] = selector & ~3 | this.cpl;
        dbg_assert((this.sreg[reg_cs] & 3) === this.cpl);

        dbg_assert(typeof info.size === "boolean");
        dbg_assert(typeof this.is_32 === "boolean");
        if(this.is_32 !== info.size)
        {
            this.update_cs_size(info.size);
        }

        this.segment_limits[reg_cs] = info.effective_limit;
        this.segment_offsets[reg_cs] = info.base;

        this.instruction_pointer = this.get_seg(reg_cs) + base | 0;

        this.flags &= ~flag_nt & ~flag_vm & ~flag_rf & ~flag_trap;

        if(!is_trap)
        {
            // clear int flag for interrupt gates
            this.flags &= ~flag_interrupt;
        }
        else
        {
            if(!this.page_fault) // XXX
            {
                this.handle_irqs();
            }
        }
    }
    else
    {
        // call 4 byte cs:ip interrupt vector from ivt at cpu.memory 0

        var index = interrupt_nr << 2;
        var new_ip = this.read16(index);
        var new_cs = this.read16(index + 2 | 0);

        // push flags, cs:ip
        this.load_eflags();
        this.push16(this.flags);
        this.push16(this.sreg[reg_cs]);
        this.push16(this.get_real_eip());

        this.flags &= ~flag_interrupt;

        this.switch_cs_real_mode(new_cs);
        this.instruction_pointer = this.get_seg(reg_cs) + new_ip | 0;
    }

    //dbg_log("int to:", LOG_CPU);
    CPU_LOG_VERBOSE && this.debug.dump_state("int end");
};

CPU.prototype.iret16 = function()
{
    this.iret(true);
};

CPU.prototype.iret32 = function()
{
    this.iret(false);
};

CPU.prototype.iret = function(is_16)
{
    //dbg_log("iret is_16=" + is_16, LOG_CPU);
    CPU_LOG_VERBOSE && this.debug.dump_state("iret start");
    //this.debug.dump_regs_short();

    if(is_16)
    {
        var new_eip = this.safe_read16(this.get_stack_pointer(0));
        var new_cs = this.safe_read16(this.get_stack_pointer(2));
        var new_flags = this.safe_read16(this.get_stack_pointer(4));
    }
    else
    {
        var new_eip = this.safe_read32s(this.get_stack_pointer(0));
        var new_cs = this.safe_read16(this.get_stack_pointer(4));
        var new_flags = this.safe_read32s(this.get_stack_pointer(8));
    }

    if(!this.protected_mode || (this.vm86_mode() && this.getiopl() === 3))
    {
        if(new_eip & 0xFFFF0000)
        {
            throw this.debug.unimpl("#GP handler");
        }

        this.switch_cs_real_mode(new_cs);
        this.instruction_pointer = new_eip + this.get_seg(reg_cs) | 0;

        if(is_16)
        {
            this.update_eflags(new_flags | this.flags & ~0xFFFF);
            this.adjust_stack_reg(3 * 2);
        }
        else
        {
            this.update_eflags(new_flags);
            this.adjust_stack_reg(3 * 4);
        }

        //dbg_log("iret32 to:", LOG_CPU);
        CPU_LOG_VERBOSE && this.debug.dump_state("iret end");

        this.handle_irqs();
        return;
    }

    if(this.vm86_mode())
    {
        // vm86 mode, iopl != 3
        dbg_log("#gp iret vm86 mode, iopl != 3", LOG_CPU)
        this.trigger_gp(0);
    }

    if(this.flags & flag_nt)
    {
        if(DEBUG) throw this.debug.unimpl("nt");
        this.trigger_gp(0);
    }

    if(new_flags & flag_vm)
    {
        if(this.cpl === 0)
        {
            // return to virtual 8086 mode

            // vm86 cannot be set in 16 bit flag
            dbg_assert(!is_16);

            dbg_assert((new_eip & ~0xFFFF) === 0);

            //dbg_log("in vm86 mode now " +
            //        " cs:eip=" + h(new_cs, 4) + ":" + h(this.instruction_pointer >>> 0, 8) +
            //        " iopl=" + this.getiopl() + " flags=" + h(new_flags, 8), LOG_CPU);


            var temp_esp = this.safe_read32s(this.get_stack_pointer(12));
            var temp_ss = this.safe_read16(this.get_stack_pointer(16));

            var new_es = this.safe_read16(this.get_stack_pointer(20));
            var new_ds = this.safe_read16(this.get_stack_pointer(24));
            var new_fs = this.safe_read16(this.get_stack_pointer(28));
            var new_gs = this.safe_read16(this.get_stack_pointer(32));

            // no exceptions below

            this.update_eflags(new_flags);
            this.flags |= flag_vm;

            this.switch_cs_real_mode(new_cs);
            this.instruction_pointer = (new_eip & 0xFFFF) + this.get_seg(reg_cs) | 0;

            this.switch_seg(reg_es, new_es);
            this.switch_seg(reg_ds, new_ds);
            this.switch_seg(reg_fs, new_fs);
            this.switch_seg(reg_gs, new_gs);

            this.adjust_stack_reg(9 * 4); // 9 dwords: eip, cs, flags, esp, ss, es, ds, fs, gs

            this.reg32s[reg_esp] = temp_esp;
            this.switch_seg(reg_ss, temp_ss);

            this.cpl = 3;
            this.cpl_changed();

            this.update_cs_size(false);

            //dbg_log("iret32 to:", LOG_CPU);
            CPU_LOG_VERBOSE && this.debug.dump_state("iret end");
            //this.debug.dump_regs_short();

            return;
        }
        else
        {
            dbg_log("vm86 flag ignored because cpl != 0", LOG_CPU);
            new_flags &= ~flag_vm;
        }
    }

    // protected mode return

    var info = this.lookup_segment_selector(new_cs);

    dbg_assert(info.is_valid);
    dbg_assert((new_eip >>> 0) <= info.effective_limit);

    if(info.is_null)
    {
        throw this.debug.unimpl("is null");
    }
    if(!info.is_present)
    {
        throw this.debug.unimpl("not present");
    }
    if(!info.is_executable)
    {
        throw this.debug.unimpl("not exec");
    }
    if(info.rpl < this.cpl)
    {
        throw this.debug.unimpl("rpl < cpl");
    }
    if(info.dc_bit && info.dpl > info.rpl)
    {
        throw this.debug.unimpl("conforming and dpl > rpl");
    }


    if(info.rpl > this.cpl)
    {
        // outer privilege return
        if(is_16)
        {
            var temp_esp = this.safe_read16(this.get_stack_pointer(6));
            var temp_ss = this.safe_read16(this.get_stack_pointer(8));
        }
        else
        {
            var temp_esp = this.safe_read32s(this.get_stack_pointer(12));
            var temp_ss = this.safe_read16(this.get_stack_pointer(16));
        }

        var ss_info = this.lookup_segment_selector(temp_ss);
        var new_cpl = info.rpl;

        if(ss_info.is_null)
        {
            dbg_log("#GP for loading 0 in SS sel=" + h(temp_ss, 4), LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_gp(0);
        }

        if(!ss_info.is_valid ||
           ss_info.is_system ||
           ss_info.rpl !== new_cpl ||
           !ss_info.is_writable ||
           ss_info.dpl !== new_cpl)
        {
            dbg_log("#GP for loading invalid in SS sel=" + h(temp_ss, 4), LOG_CPU);
            debugger;
            dbg_trace(LOG_CPU);
            this.trigger_gp(temp_ss & ~3);
        }

        if(!ss_info.is_present)
        {
            dbg_log("#SS for loading non-present in SS sel=" + h(temp_ss, 4), LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_ss(temp_ss & ~3);
        }

        // no exceptions below

        if(is_16)
        {
            this.update_eflags(new_flags | this.flags & ~0xFFFF);
        }
        else
        {
            this.update_eflags(new_flags);
        }

        this.cpl = info.rpl;
        this.cpl_changed();

        //dbg_log("outer privilege return: from=" + this.cpl + " to=" + info.rpl + " ss:esp=" + h(temp_ss, 4) + ":" + h(temp_esp >>> 0, 8), LOG_CPU);

        this.switch_seg(reg_ss, temp_ss);

        this.set_stack_reg(temp_esp);

        if(this.cpl === 0)
        {
            this.flags = this.flags & ~flag_vif & ~flag_vip | (new_flags & (flag_vif | flag_vip));
        }


        // XXX: Set segment to 0 if it's not usable in the new cpl
        // XXX: Use cached segment information
        //var ds_info = this.lookup_segment_selector(this.sreg[reg_ds]);
        //if(this.cpl > ds_info.dpl && (!ds_info.is_executable || !ds_info.dc_bit)) this.switch_seg(reg_ds, 0);
        // ...
    }
    else if(info.rpl === this.cpl)
    {
        // same privilege return
        // no exceptions below
        if(is_16)
        {
            this.adjust_stack_reg(3 * 2);
            this.update_eflags(new_flags | this.flags & ~0xFFFF);
        }
        else
        {
            this.adjust_stack_reg(3 * 4);
            this.update_eflags(new_flags);
        }

        // update vip and vif, which are not changed by update_eflags
        if(this.cpl === 0)
        {
            this.flags = this.flags & ~flag_vif & ~flag_vip | (new_flags & (flag_vif | flag_vip));
        }
    }
    else
    {
        dbg_assert(false);
    }

    this.sreg[reg_cs] = new_cs;
    dbg_assert((new_cs & 3) === this.cpl);

    dbg_assert(typeof info.size === "boolean");
    if(info.size !== this.is_32)
    {
        this.update_cs_size(info.size);
    }

    this.segment_limits[reg_cs] = info.effective_limit;
    this.segment_offsets[reg_cs] = info.base;

    this.instruction_pointer = new_eip + this.get_seg(reg_cs) | 0;

    //dbg_log("iret is_16=" + is_16 + " to:", LOG_CPU);
    CPU_LOG_VERBOSE && this.debug.dump_state("iret end");

    this.handle_irqs();
};

CPU.prototype.switch_cs_real_mode = function(selector)
{
    dbg_assert(!this.protected_mode || this.vm86_mode());

    this.sreg[reg_cs] = selector;
    this.segment_is_null[reg_cs] = 0;
    this.segment_offsets[reg_cs] = selector << 4;
};

CPU.prototype.far_return = function(eip, selector, stack_adjust)
{
    dbg_assert(typeof selector === "number" && selector < 0x10000 && selector >= 0);

    //dbg_log("far return eip=" + h(eip >>> 0, 8) + " cs=" + h(selector, 4) + " stack_adjust=" + h(stack_adjust), LOG_CPU);
    CPU_LOG_VERBOSE && this.debug.dump_state("far ret start");

    this.protected_mode = (this.cr[0] & CR0_PE) === CR0_PE;

    if(!this.protected_mode)
    {
        dbg_assert(!this.is_32);
        //dbg_assert(!this.stack_size_32);
    }

    if(!this.protected_mode || this.vm86_mode())
    {
        this.switch_cs_real_mode(selector);
        this.instruction_pointer = this.get_seg(reg_cs) + eip | 0;
        this.adjust_stack_reg(2 * (this.operand_size_32 ? 4 : 2) + stack_adjust);
        return;
    }

    var info = this.lookup_segment_selector(selector);

    if(info.is_null)
    {
        dbg_log("null cs", LOG_CPU);
        this.trigger_gp(0);
    }

    if(!info.is_valid)
    {
        dbg_log("invalid cs: " + h(selector), LOG_CPU);
        this.trigger_gp(selector & ~3);
    }

    if(info.is_system)
    {
        dbg_assert(false, "is system in far return");
        this.trigger_gp(selector & ~3);
    }

    if(!info.is_executable)
    {
        dbg_log("non-executable cs: " + h(selector), LOG_CPU);
        this.trigger_gp(selector & ~3);
    }

    if(info.rpl < this.cpl)
    {
        dbg_log("cs rpl < cpl: " + h(selector), LOG_CPU);
        this.trigger_gp(selector & ~3);
    }

    if(info.dc_bit && info.dpl > info.rpl)
    {
        dbg_log("cs conforming and dpl > rpl: " + h(selector), LOG_CPU);
        this.trigger_gp(selector & ~3);
    }

    if(!info.dc_bit && info.dpl !== info.rpl)
    {
        dbg_log("cs non-conforming and dpl != rpl: " + h(selector), LOG_CPU);
        this.trigger_gp(selector & ~3);
    }

    if(!info.is_present)
    {
        dbg_log("#NP for loading not-present in cs sel=" + h(selector, 4), LOG_CPU);
        dbg_trace(LOG_CPU);
        this.trigger_np(selector & ~3);
    }

    if(info.rpl > this.cpl)
    {
        dbg_log("far return privilege change cs: " + h(selector) + " from=" + this.cpl + " to=" + info.rpl + " is_16=" + this.operand_size_32, LOG_CPU);

        if(this.operand_size_32)
        {
            dbg_log("esp read from " + h(this.translate_address_system_read(this.get_stack_pointer(stack_adjust + 8))))
            var temp_esp = this.safe_read32s(this.get_stack_pointer(stack_adjust + 8));
            dbg_log("esp=" + h(temp_esp));
            var temp_ss = this.safe_read16(this.get_stack_pointer(stack_adjust + 12));
        }
        else
        {
            dbg_log("esp read from " + h(this.translate_address_system_read(this.get_stack_pointer(stack_adjust + 4))));
            var temp_esp = this.safe_read16(this.get_stack_pointer(stack_adjust + 4));
            dbg_log("esp=" + h(temp_esp));
            var temp_ss = this.safe_read16(this.get_stack_pointer(stack_adjust + 6));
        }

        this.cpl = info.rpl;
        this.cpl_changed();

        // XXX: Can raise, conditions should be checked before side effects
        this.switch_seg(reg_ss, temp_ss);
        this.set_stack_reg(temp_esp + stack_adjust);

        //if(this.operand_size_32)
        //{
        //    this.adjust_stack_reg(2 * 4);
        //}
        //else
        //{
        //    this.adjust_stack_reg(2 * 2);
        //}

        //throw this.debug.unimpl("privilege change");

        //this.adjust_stack_reg(stack_adjust);
    }
    else
    {
        if(this.operand_size_32)
        {
            this.adjust_stack_reg(2 * 4 + stack_adjust);
        }
        else
        {
            this.adjust_stack_reg(2 * 2 + stack_adjust);
        }
    }

    //dbg_assert(this.cpl === info.dpl);

    dbg_assert(typeof info.size === "boolean");
    if(info.size !== this.is_32)
    {
        this.update_cs_size(info.size);
    }

    this.segment_is_null[reg_cs] = 0;
    this.segment_limits[reg_cs] = info.effective_limit;
    //this.segment_infos[reg_cs] = 0; // TODO

    this.segment_offsets[reg_cs] = info.base;
    this.sreg[reg_cs] = selector;
    dbg_assert((selector & 3) === this.cpl);

    this.instruction_pointer = this.get_seg(reg_cs) + eip | 0;

    //dbg_log("far return to:", LOG_CPU)
    CPU_LOG_VERBOSE && this.debug.dump_state("far ret end");
};

CPU.prototype.far_jump = function(eip, selector, is_call)
{
    dbg_assert(typeof selector === "number" && selector < 0x10000 && selector >= 0);

    //dbg_log("far " + ["jump", "call"][+is_call] + " eip=" + h(eip >>> 0, 8) + " cs=" + h(selector, 4), LOG_CPU);
    CPU_LOG_VERBOSE && this.debug.dump_state("far " + ["jump", "call"][+is_call]);

    this.protected_mode = (this.cr[0] & CR0_PE) === CR0_PE;

    if(!this.protected_mode || this.vm86_mode())
    {
        if(is_call)
        {
            if(this.operand_size_32)
            {
                this.writable_or_pagefault(this.get_stack_pointer(-8), 8);
                this.push32(this.sreg[reg_cs]);
                this.push32(this.get_real_eip());
            }
            else
            {
                this.writable_or_pagefault(this.get_stack_pointer(-4), 4);
                this.push16(this.sreg[reg_cs]);
                this.push16(this.get_real_eip());
            }
        }
        this.switch_cs_real_mode(selector);
        this.instruction_pointer = this.get_seg(reg_cs) + eip | 0;
        return;
    }

    var info = this.lookup_segment_selector(selector);

    if(info.is_null)
    {
        dbg_log("#gp null cs", LOG_CPU);
        this.trigger_gp(0);
    }

    if(!info.is_valid)
    {
        dbg_log("#gp invalid cs: " + h(selector), LOG_CPU);
        this.trigger_gp(selector & ~3);
    }

    if(info.is_system)
    {
        dbg_assert(is_call, "TODO: Jump")

        dbg_log("system type cs: " + h(selector), LOG_CPU);

        if(info.type === 0xC || info.type === 4)
        {
            // call gate
            var is_16 = info.type === 4;

            if(info.dpl < this.cpl || info.dpl < info.rpl)
            {
                dbg_log("#gp cs gate dpl < cpl or dpl < rpl: " + h(selector), LOG_CPU);
                this.trigger_gp(selector & ~3);
            }

            if(!info.is_present)
            {
                dbg_log("#NP for loading not-present in gate cs sel=" + h(selector, 4), LOG_CPU);
                this.trigger_np(selector & ~3);
            }

            var cs_selector = info.raw0 >>> 16;
            var cs_info = this.lookup_segment_selector(cs_selector);

            if(cs_info.is_null)
            {
                dbg_log("#gp null cs", LOG_CPU);
                this.trigger_gp(0);
            }

            if(!cs_info.is_valid)
            {
                dbg_log("#gp invalid cs: " + h(cs_selector), LOG_CPU);
                this.trigger_gp(cs_selector & ~3);
            }

            if(!cs_info.is_executable)
            {
                dbg_log("#gp non-executable cs: " + h(cs_selector), LOG_CPU);
                this.trigger_gp(cs_selector & ~3);
            }

            if(cs_info.dpl > this.cpl)
            {
                dbg_log("#gp dpl > cpl: " + h(cs_selector), LOG_CPU);
                this.trigger_gp(cs_selector & ~3);
            }

            if(!cs_info.is_present)
            {
                dbg_log("#NP for loading not-present in cs sel=" + h(cs_selector, 4), LOG_CPU);
                this.trigger_np(cs_selector & ~3);
            }

            if(!cs_info.dc_bit && cs_info.dpl < this.cpl)
            {
                dbg_log("more privilege call gate is_16=" + is_16 + " from=" + this.cpl + " to=" + cs_info.dpl);
                var tss_stack_addr = this.get_tss_stack_addr(cs_info.dpl);

                var new_esp = this.read32s(tss_stack_addr);
                var new_ss = this.read16(tss_stack_addr + 4 | 0);
                var ss_info = this.lookup_segment_selector(new_ss);

                // Disabled: Incorrect handling of direction bit
                // See http://css.csail.mit.edu/6.858/2014/readings/i386/s06_03.htm
                //if(!((new_esp >>> 0) <= ss_info.effective_limit))
                //    debugger;
                //dbg_assert((new_esp >>> 0) <= ss_info.effective_limit);
                dbg_assert(ss_info.is_valid && !ss_info.is_system && ss_info.is_writable);

                if(ss_info.is_null)
                {
                    throw this.debug.unimpl("#TS handler");
                }
                if(ss_info.rpl !== cs_info.dpl) // xxx: 0 in v86 mode
                {
                    throw this.debug.unimpl("#TS handler");
                }
                if(ss_info.dpl !== cs_info.dpl || !ss_info.rw_bit)
                {
                    throw this.debug.unimpl("#TS handler");
                }
                if(!ss_info.is_present)
                {
                    throw this.debug.unimpl("#SS handler");
                }

                var parameter_count = info.raw1 & 0x1F;
                var stack_space = is_16 ? 4 : 8;
                if(is_call)
                {
                    stack_space += is_16 ? 4 + 2 * parameter_count : 8 + 4 * parameter_count;
                }
                if(ss_info.size)
                {
                    //try {
                    this.writable_or_pagefault(ss_info.base + new_esp - stack_space | 0, stack_space); // , cs_info.dpl
                    //} catch(e) { debugger; }
                }
                else
                {
                    //try {
                    this.writable_or_pagefault(ss_info.base + (new_esp - stack_space & 0xFFFF) | 0, stack_space); // , cs_info.dpl
                    //} catch(e) { debugger; }
                }

                var old_esp = this.reg32s[reg_esp];
                var old_ss = this.sreg[reg_ss];
                var old_stack_pointer = this.get_stack_pointer(0);

                //dbg_log("old_esp=" + h(old_esp));

                this.cpl = cs_info.dpl;
                this.cpl_changed();

                if(this.is_32 !== cs_info.size)
                {
                    this.update_cs_size(cs_info.size);
                }

                this.switch_seg(reg_ss, new_ss);
                this.set_stack_reg(new_esp);

                //dbg_log("parameter_count=" + parameter_count);
                //dbg_assert(parameter_count === 0, "TODO");

                if(is_16)
                {
                    this.push16(old_ss);
                    this.push16(old_esp);
                    //dbg_log("old esp written to " + h(this.translate_address_system_read(this.get_stack_pointer(0))));
                }
                else
                {
                    this.push32(old_ss);
                    this.push32(old_esp);
                    //dbg_log("old esp written to " + h(this.translate_address_system_read(this.get_stack_pointer(0))));
                }

                if(is_call)
                {
                    if(is_16)
                    {
                        for(var i = parameter_count - 1; i >= 0; i--)
                        {
                            var parameter = this.safe_read16(old_stack_pointer + 2 * i);
                            this.push16(parameter);
                        }

                        //this.writable_or_pagefault(this.get_stack_pointer(-4), 4);
                        this.push16(this.sreg[reg_cs]);
                        this.push16(this.get_real_eip());
                    }
                    else
                    {
                        for(var i = parameter_count - 1; i >= 0; i--)
                        {
                            var parameter = this.safe_read32s(old_stack_pointer + 4 * i);
                            this.push32(parameter);
                        }

                        //this.writable_or_pagefault(this.get_stack_pointer(-8), 8);
                        this.push32(this.sreg[reg_cs]);
                        this.push32(this.get_real_eip());
                    }
                }
            }
            else
            {
                dbg_log("same privilege call gate is_16=" + is_16 + " from=" + this.cpl + " to=" + cs_info.dpl + " conforming=" + cs_info.dc_bit);
                // ok

                if(is_call)
                {
                    if(is_16)
                    {
                        this.writable_or_pagefault(this.get_stack_pointer(-4), 4);
                        this.push16(this.sreg[reg_cs]);
                        this.push16(this.get_real_eip());
                    }
                    else
                    {
                        this.writable_or_pagefault(this.get_stack_pointer(-8), 8);
                        this.push32(this.sreg[reg_cs]);
                        this.push32(this.get_real_eip());
                    }
                }
            }

            // Note: eip from call is ignored
            var new_eip = info.raw0 & 0xFFFF;
            if(!is_16)
            {
                new_eip |= info.raw1 & 0xFFFF0000;
            }

            dbg_log("call gate eip=" + h(new_eip >>> 0) + " cs=" + h(cs_selector) + " conforming=" + cs_info.dc_bit);
            dbg_assert((new_eip >>> 0) <= cs_info.effective_limit, "todo: #gp");

            if(cs_info.size !== this.is_32)
            {
                this.update_cs_size(cs_info.size);
            }

            this.segment_is_null[reg_cs] = 0;
            this.segment_limits[reg_cs] = cs_info.effective_limit;
            //this.segment_infos[reg_cs] = 0; // TODO
            this.segment_offsets[reg_cs] = cs_info.base;
            this.sreg[reg_cs] = cs_selector & ~3 | this.cpl;
            dbg_assert((this.sreg[reg_cs] & 3) === this.cpl);

            this.instruction_pointer = this.get_seg(reg_cs) + new_eip | 0;
        }
        else
        {
            var types = { 9: "Available 386 TSS", 0xb: "Busy 386 TSS", 4: "286 Call Gate", 0xc: "386 Call Gate" };
            throw this.debug.unimpl("load system segment descriptor, type = " + (info.access & 15) + " (" + types[info.access & 15] + ")");
        }
    }
    else
    {
        if(!info.is_executable)
        {
            dbg_log("#gp non-executable cs: " + h(selector), LOG_CPU);
            this.trigger_gp(selector & ~3);
        }

        if(info.dc_bit)
        {
            // conforming code segment
            if(info.dpl > this.cpl)
            {
                dbg_log("#gp cs dpl > cpl: " + h(selector), LOG_CPU);
                this.trigger_gp(selector & ~3);
            }
        }
        else
        {
            // non-conforming code segment

            if(info.rpl > this.cpl || info.dpl !== this.cpl)
            {
                dbg_log("#gp cs rpl > cpl or dpl != cpl: " + h(selector), LOG_CPU);
                this.trigger_gp(selector & ~3);
            }
        }

        if(!info.is_present)
        {
            dbg_log("#NP for loading not-present in cs sel=" + h(selector, 4), LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_np(selector & ~3);
        }

        if(is_call)
        {
            if(this.operand_size_32)
            {
                this.writable_or_pagefault(this.get_stack_pointer(-8), 8);
                this.push32(this.sreg[reg_cs]);
                this.push32(this.get_real_eip());
            }
            else
            {
                this.writable_or_pagefault(this.get_stack_pointer(-4), 4);
                this.push16(this.sreg[reg_cs]);
                this.push16(this.get_real_eip());
            }
        }

        dbg_assert((eip >>> 0) <= info.effective_limit, "todo: #gp");

        if(info.size !== this.is_32)
        {
            this.update_cs_size(info.size);
        }

        this.segment_is_null[reg_cs] = 0;
        this.segment_limits[reg_cs] = info.effective_limit;
        //this.segment_infos[reg_cs] = 0; // TODO

        this.segment_offsets[reg_cs] = info.base;
        this.sreg[reg_cs] = selector & ~3 | this.cpl;

        this.instruction_pointer = this.get_seg(reg_cs) + eip | 0;
    }

    //dbg_log("far " + ["jump", "call"][+is_call] + " to:", LOG_CPU)
    CPU_LOG_VERBOSE && this.debug.dump_state("far " + ["jump", "call"][+is_call] + " end");
};

CPU.prototype.get_tss_stack_addr = function(dpl)
{
    var tss_stack_addr = (dpl << 3) + 4 | 0;

    if((tss_stack_addr + 5 | 0) > this.segment_limits[reg_tr])
    {
        throw this.debug.unimpl("#TS handler");
    }

    tss_stack_addr = tss_stack_addr + this.segment_offsets[reg_tr] | 0;

    if(this.paging)
    {
        tss_stack_addr = this.translate_address_system_read(tss_stack_addr);
    }

    dbg_assert((tss_stack_addr & 0xFFF) <= 0x1000 - 6);

    return tss_stack_addr;
};

CPU.prototype.do_task_switch = function(selector)
{
    dbg_log("do_task_switch sel=" + h(selector), LOG_CPU);
    var descriptor = this.lookup_segment_selector(selector);

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

    //if(false /* is iret */)
    //{
    //    old_eflags &= ~flag_nt;
    //}

    this.writable_or_pagefault(tsr_offset, 0x66);

    //this.safe_write32(tsr_offset + TSR_CR3, this.cr[3]);

    this.safe_write32(tsr_offset + TSR_EIP, this.get_real_eip());
    this.safe_write32(tsr_offset + TSR_EFLAGS, old_eflags);

    this.safe_write32(tsr_offset + TSR_EAX, this.reg32s[reg_eax]);
    this.safe_write32(tsr_offset + TSR_ECX, this.reg32s[reg_ecx]);
    this.safe_write32(tsr_offset + TSR_EDX, this.reg32s[reg_edx]);
    this.safe_write32(tsr_offset + TSR_EBX, this.reg32s[reg_ebx]);

    this.safe_write32(tsr_offset + TSR_ESP, this.reg32s[reg_esp]);
    this.safe_write32(tsr_offset + TSR_EBP, this.reg32s[reg_ebp]);
    this.safe_write32(tsr_offset + TSR_ESI, this.reg32s[reg_esi]);
    this.safe_write32(tsr_offset + TSR_EDI, this.reg32s[reg_edi]);

    this.safe_write32(tsr_offset + TSR_ES, this.sreg[reg_es]);
    this.safe_write32(tsr_offset + TSR_CS, this.sreg[reg_cs]);
    this.safe_write32(tsr_offset + TSR_SS, this.sreg[reg_ss]);
    this.safe_write32(tsr_offset + TSR_DS, this.sreg[reg_ds]);
    this.safe_write32(tsr_offset + TSR_FS, this.sreg[reg_fs]);
    this.safe_write32(tsr_offset + TSR_GS, this.sreg[reg_gs]);
    this.safe_write32(tsr_offset + TSR_LDT, this.sreg[reg_ldtr]);

    if(true /* is jump or call or int */)
    {
        // mark as busy
        this.write8(descriptor.table_offset + 5 | 0, this.read8(descriptor.table_offset + 5 | 0) | 2);
    }

    //var new_tsr_size = descriptor.effective_limit;
    var new_tsr_offset = descriptor.base;

    var new_cr3 = this.safe_read32s(new_tsr_offset + TSR_CR3);

    this.flags &= ~flag_vm;

    dbg_assert(false);
    this.switch_seg(reg_cs, this.safe_read16(new_tsr_offset + TSR_CS));

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

    var new_ldt = this.safe_read16(new_tsr_offset + TSR_LDT);
    this.load_ldt(new_ldt);

    this.reg32s[reg_eax] = this.safe_read32s(new_tsr_offset + TSR_EAX);
    this.reg32s[reg_ecx] = this.safe_read32s(new_tsr_offset + TSR_ECX);
    this.reg32s[reg_edx] = this.safe_read32s(new_tsr_offset + TSR_EDX);
    this.reg32s[reg_ebx] = this.safe_read32s(new_tsr_offset + TSR_EBX);

    this.reg32s[reg_esp] = this.safe_read32s(new_tsr_offset + TSR_ESP);
    this.reg32s[reg_ebp] = this.safe_read32s(new_tsr_offset + TSR_EBP);
    this.reg32s[reg_esi] = this.safe_read32s(new_tsr_offset + TSR_ESI);
    this.reg32s[reg_edi] = this.safe_read32s(new_tsr_offset + TSR_EDI);

    this.switch_seg(reg_es, this.safe_read16(new_tsr_offset + TSR_ES));
    this.switch_seg(reg_ss, this.safe_read16(new_tsr_offset + TSR_SS));
    this.switch_seg(reg_ds, this.safe_read16(new_tsr_offset + TSR_DS));
    this.switch_seg(reg_fs, this.safe_read16(new_tsr_offset + TSR_FS));
    this.switch_seg(reg_gs, this.safe_read16(new_tsr_offset + TSR_GS));

    this.instruction_pointer = this.get_seg(reg_cs) + this.safe_read32s(new_tsr_offset + TSR_EIP) | 0;

    this.segment_offsets[reg_tr] = descriptor.base;
    this.segment_limits[reg_tr] = descriptor.effective_limit;
    this.sreg[reg_tr] = selector;

    this.cr[3] = new_cr3;
    dbg_assert((this.cr[3] & 0xFFF) === 0);
    this.clear_tlb();

    this.cr[0] |= CR0_TS;
};

CPU.prototype.hlt_op = function()
{
    if(this.cpl)
    {
        this.trigger_gp(0);
    }

    // hlt
    if((this.flags & flag_interrupt) === 0)
    {
        this.debug.show("cpu halted");
        if(DEBUG) this.debug.dump_regs();
        throw "HALT";
    }
    else
    {
        // get out of here and into hlt_loop
        this.in_hlt = true;
        throw MAGIC_CPU_EXCEPTION;
    }
};

// assumes ip to point to the byte before the next instruction
CPU.prototype.raise_exception = function(interrupt_nr)
{
    //if(DEBUG && interrupt_nr !== 7)
    //{
    //    // show interesting exceptions
    //    dbg_log("Exception " + h(interrupt_nr) + " at " + h(this.previous_ip >>> 0, 8) + " (cs=" + h(this.sreg[reg_cs], 4) + ")", LOG_CPU);
    //    dbg_trace(LOG_CPU);
    //    this.debug.dump_regs_short();
    //    this.debug.dump_state();
    //}

    this.call_interrupt_vector(interrupt_nr, false, false);
    throw MAGIC_CPU_EXCEPTION;
};

CPU.prototype.raise_exception_with_code = function(interrupt_nr, error_code)
{
    //if(DEBUG)
    //{
    //    dbg_log("Exception " + h(interrupt_nr) + " err=" + h(error_code) + " at " + h(this.previous_ip >>> 0, 8) + " (cs=" + h(this.sreg[reg_cs], 4) + ")", LOG_CPU);
    //    dbg_trace(LOG_CPU);
    //    this.debug.dump_regs_short();
    //}

    this.call_interrupt_vector(interrupt_nr, false, error_code);
    throw MAGIC_CPU_EXCEPTION;
};

CPU.prototype.trigger_de = function()
{
    this.instruction_pointer = this.previous_ip;
    this.raise_exception(0);
};

CPU.prototype.trigger_ud = function()
{
    this.instruction_pointer = this.previous_ip;
    this.raise_exception(6);
};

CPU.prototype.trigger_nm = function()
{
    this.instruction_pointer = this.previous_ip;
    this.raise_exception(7);
};

CPU.prototype.trigger_ts = function(code)
{
    this.instruction_pointer = this.previous_ip;
    this.raise_exception_with_code(10, code);
};

CPU.prototype.trigger_gp = function(code)
{
    this.instruction_pointer = this.previous_ip;
    this.raise_exception_with_code(13, code);
};

CPU.prototype.trigger_np = function(code)
{
    this.instruction_pointer = this.previous_ip;
    this.raise_exception_with_code(11, code);
};

CPU.prototype.trigger_ss = function(code)
{
    this.instruction_pointer = this.previous_ip;
    this.raise_exception_with_code(12, code);
};

// used before fpu instructions
CPU.prototype.task_switch_test = function()
{
    if(this.cr[0] & (CR0_EM | CR0_TS))
    {
        this.trigger_nm();
    }
};

CPU.prototype.todo = function()
{
    if(DEBUG)
    {
        dbg_trace();
        throw "TODO";
    }

    this.trigger_ud();
};

CPU.prototype.undefined_instruction = function()
{
    if(DEBUG)
    {
        throw "Possible fault: undefined instruction";
    }

    this.trigger_ud();
};

CPU.prototype.unimplemented_sse = function()
{
    dbg_log("No SSE", LOG_CPU);
    this.trigger_ud();
};

CPU.prototype.get_seg_prefix_ds = function()
{
    return this.get_seg_prefix(reg_ds);
};

CPU.prototype.get_seg_prefix_ss = function()
{
    return this.get_seg_prefix(reg_ss);
};

CPU.prototype.get_seg_prefix_cs = function()
{
    return this.get_seg_prefix(reg_cs);
};

/**
 * Get segment base by prefix or default
 * @param {number} default_segment
 */
CPU.prototype.get_seg_prefix = function(default_segment /*, offset*/)
{
    if(this.segment_prefix === SEG_PREFIX_NONE)
    {
        return this.get_seg(default_segment /*, offset*/);
    }
    else if(this.segment_prefix === SEG_PREFIX_ZERO)
    {
        return 0;
    }
    else
    {
        return this.get_seg(this.segment_prefix /*, offset*/);
    }
};

/**
 * Get segment base
 * @param {number} segment
 */
CPU.prototype.get_seg = function(segment /*, offset*/)
{
    dbg_assert(segment >= 0 && segment < 8);

    if(this.protected_mode)
    {
        if(this.segment_is_null[segment])
        {
            dbg_assert(segment !== reg_cs && segment !== reg_ss);
            dbg_log("#gp Use null segment: " + segment + " sel=" + h(this.sreg[segment], 4), LOG_CPU);

            this.trigger_gp(0);
        }

        // TODO:
        // - validate segment limits
        // - validate if segment is writable
    }

    return this.segment_offsets[segment];
};

CPU.prototype.read_e8 = function()
{
    if(this.modrm_byte < 0xC0) {
        return this.safe_read8(this.modrm_resolve(this.modrm_byte));
    } else {
        return this.reg8[this.modrm_byte << 2 & 0xC | this.modrm_byte >> 2 & 1];
    }
};

CPU.prototype.read_e8s = function()
{
    return this.read_e8() << 24 >> 24;
};

CPU.prototype.read_e16 = function()
{
    if(this.modrm_byte < 0xC0) {
        return this.safe_read16(this.modrm_resolve(this.modrm_byte));
    } else {
        return this.reg16[this.modrm_byte << 1 & 14];
    }
};

CPU.prototype.read_e16s = function()
{
    return this.read_e16() << 16 >> 16;
};

CPU.prototype.read_e32s = function()
{
    if(this.modrm_byte < 0xC0) {
        return this.safe_read32s(this.modrm_resolve(this.modrm_byte));
    } else {
        return this.reg32s[this.modrm_byte & 7];
    }
};

CPU.prototype.read_e32 = function()
{
    return this.read_e32s() >>> 0;
};

CPU.prototype.set_e8 = function(value)
{
    if(this.modrm_byte < 0xC0) {
        var addr = this.modrm_resolve(this.modrm_byte);
        this.safe_write8(addr, value);
    } else {
        this.reg8[this.modrm_byte << 2 & 0xC | this.modrm_byte >> 2 & 1] = value;
    }
};

CPU.prototype.set_e16 = function(value)
{
    if(this.modrm_byte < 0xC0) {
        var addr = this.modrm_resolve(this.modrm_byte);
        this.safe_write16(addr, value);
    } else {
        this.reg16[this.modrm_byte << 1 & 14] = value;
    }
};

CPU.prototype.set_e32 = function(value)
{
    if(this.modrm_byte < 0xC0) {
        var addr = this.modrm_resolve(this.modrm_byte);
        this.safe_write32(addr, value);
    } else {
        this.reg32s[this.modrm_byte & 7] = value;
    }
};


CPU.prototype.read_write_e8 = function()
{
    if(this.modrm_byte < 0xC0) {
        var virt_addr = this.modrm_resolve(this.modrm_byte);
        this.phys_addr = this.translate_address_write(virt_addr);
        return this.read8(this.phys_addr);
    } else {
        return this.reg8[this.modrm_byte << 2 & 0xC | this.modrm_byte >> 2 & 1];
    }
};

CPU.prototype.write_e8 = function(value)
{
    if(this.modrm_byte < 0xC0) {
        this.write8(this.phys_addr, value);
    }
    else {
        this.reg8[this.modrm_byte << 2 & 0xC | this.modrm_byte >> 2 & 1] = value;
    }
};

CPU.prototype.read_write_e16 = function()
{
    if(this.modrm_byte < 0xC0) {
        var virt_addr = this.modrm_resolve(this.modrm_byte);
        this.phys_addr = this.translate_address_write(virt_addr);
        if(this.paging && (virt_addr & 0xFFF) === 0xFFF) {
            this.phys_addr_high = this.translate_address_write(virt_addr + 1 | 0);
            dbg_assert(this.phys_addr_high);
            return this.virt_boundary_read16(this.phys_addr, this.phys_addr_high);
        } else {
            this.phys_addr_high = 0;
            return this.read16(this.phys_addr);
        }
    } else {
        return this.reg16[this.modrm_byte << 1 & 14];
    }
};

CPU.prototype.write_e16 = function(value)
{
    if(this.modrm_byte < 0xC0) {
        if(this.phys_addr_high) {
            this.virt_boundary_write16(this.phys_addr, this.phys_addr_high, value);
        } else {
            this.write16(this.phys_addr, value);
        }
    } else {
        this.reg16[this.modrm_byte << 1 & 14] = value;
    }
};

CPU.prototype.read_write_e32 = function()
{
    if(this.modrm_byte < 0xC0) {
        var virt_addr = this.modrm_resolve(this.modrm_byte);
        this.phys_addr = this.translate_address_write(virt_addr);
        if(this.paging && (virt_addr & 0xFFF) >= 0xFFD) {
            this.phys_addr_high = this.translate_address_write(virt_addr + 3 | 0);
            dbg_assert(this.phys_addr_high);
            return this.virt_boundary_read32s(this.phys_addr, this.phys_addr_high);
        } else {
            this.phys_addr_high = 0;
            return this.read32s(this.phys_addr);
        }
    } else {
        return this.reg32s[this.modrm_byte & 7];
    }
};

CPU.prototype.write_e32 = function(value)
{
    if(this.modrm_byte < 0xC0) {
        if(this.phys_addr_high) {
            this.virt_boundary_write32(this.phys_addr, this.phys_addr_high, value);
        } else {
            this.write32(this.phys_addr, value);
        }
    } else {
        this.reg32s[this.modrm_byte & 7] = value;
    }
};

CPU.prototype.read_reg_e16 = function()
{
    return this.reg16[this.modrm_byte << 1 & 14];
}

CPU.prototype.write_reg_e16 = function(value)
{
    this.reg16[this.modrm_byte << 1 & 14] = value;
}

CPU.prototype.read_reg_e32s = function()
{
    return this.reg32s[this.modrm_byte & 7];
};

CPU.prototype.write_reg_e32 = function(value)
{
    this.reg32s[this.modrm_byte & 7] = value;
};

CPU.prototype.read_g8 = function()
{
    return this.reg8[this.modrm_byte >> 1 & 0xC | this.modrm_byte >> 5 & 1];
};

CPU.prototype.write_g8 = function(value)
{
    this.reg8[this.modrm_byte >> 1 & 0xC | this.modrm_byte >> 5 & 1] = value;
};

CPU.prototype.read_g16 = function()
{
    return this.reg16[this.modrm_byte >> 2 & 14];
};

CPU.prototype.read_g16s = function()
{
    return this.reg16s[this.modrm_byte >> 2 & 14];
};

CPU.prototype.write_g16 = function(value)
{
    this.reg16[this.modrm_byte >> 2 & 14] = value;
};

CPU.prototype.read_g32s = function()
{
    return this.reg32s[this.modrm_byte >> 3 & 7];
};

CPU.prototype.write_g32 = function(value)
{
    this.reg32[this.modrm_byte >> 3 & 7] = value;
};

CPU.prototype.pic_call_irq = function(int)
{
    try
    {
        this.previous_ip = this.instruction_pointer;
        this.call_interrupt_vector(int, false, false);
    }
    catch(e)
    {
        this.exception_cleanup(e);
    }
};

CPU.prototype.handle_irqs = function()
{
    dbg_assert(!this.page_fault);

    if((this.flags & flag_interrupt) && !this.page_fault)
    {
        if(this.devices.pic)
        {
            this.devices.pic.check_irqs();
        }

        if(this.devices.apic)
        {
            this.devices.apic.check_irqs();
        }
    }
};

CPU.prototype.device_raise_irq = function(i)
{
    dbg_assert(arguments.length === 1);
    if(this.devices.pic)
    {
        this.devices.pic.set_irq(i);
    }

    if(this.devices.apic)
    {
        this.devices.apic.set_irq(i);
    }
};

CPU.prototype.device_lower_irq = function(i)
{
    if(this.devices.pic)
    {
        this.devices.pic.clear_irq(i);
    }

    if(this.devices.apic)
    {
        this.devices.apic.clear_irq(i);
    }
};

CPU.prototype.test_privileges_for_io = function(port, size)
{
    if(this.protected_mode && (this.cpl > this.getiopl() || (this.flags & flag_vm)))
    {
        var tsr_size = this.segment_limits[reg_tr],
            tsr_offset = this.segment_offsets[reg_tr];

        if(tsr_size >= 0x67)
        {
            dbg_assert((tsr_offset + 0x64 + 2 & 0xFFF) < 0xFFF);

            var iomap_base = this.read16(this.translate_address_system_read(tsr_offset + 0x64 + 2 | 0)),
                high_port = port + size - 1 | 0;

            if(tsr_size >= (iomap_base + (high_port >> 3) | 0))
            {
                var mask = ((1 << size) - 1) << (port & 7),
                    addr = this.translate_address_system_read(tsr_offset + iomap_base + (port >> 3) | 0),
                    port_info = (mask & 0xFF00) ?
                        this.read16(addr) : this.read8(addr);

                dbg_assert((addr & 0xFFF) < 0xFFF);

                if(!(port_info & mask))
                {
                    return;
                }
            }
        }

        dbg_log("#GP for port io  port=" + h(port) + " size=" + size, LOG_CPU);
        CPU_LOG_VERBOSE && this.debug.dump_state();
        this.trigger_gp(0);
    }
};

CPU.prototype.cpuid = function()
{
    // cpuid
    // TODO: Fill in with less bogus values

    // http://lxr.linux.no/linux+%2a/arch/x86/include/asm/cpufeature.h
    // http://www.sandpile.org/x86/cpuid.htm

    var eax = 0,
        ecx = 0,
        edx = 0,
        ebx = 0;

    var winnt_fix = false;

    switch(this.reg32s[reg_eax])
    {
        case 0:
            // maximum supported level
            if(winnt_fix)
            {
                eax = 2;
            }
            else
            {
                eax = 5;
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
            edx = (this.fpu ? 1 : 0) |                // fpu
                    vme | 1 << 3 | 1 << 4 | 1 << 5 |   // vme, pse, tsc, msr
                    1 << 8 | 1 << 11 | 1 << 13 | 1 << 15; // cx8, sep, pge, cmov

            if(ENABLE_ACPI)
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
            switch(this.reg32s[reg_ecx])
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
                    break
                case 2:
                    eax = 0x00000143;
                    ebx = 0x05c0003f;
                    ecx = 0x00000fff;
                    edx = 0x00000001;
                    break;
            }
            break;

        case 0x80000000|0:
            // maximum supported extended level
            eax = 5;
            // other registers are reserved
            break;

        default:
            dbg_log("cpuid: unimplemented eax: " + h(this.reg32[reg_eax]), LOG_CPU);
    }

    dbg_log("cpuid: eax=" + h(this.reg32[reg_eax], 8) + " cl=" + h(this.reg8[reg_cl], 2), LOG_CPU);

    this.reg32s[reg_eax] = eax;
    this.reg32s[reg_ecx] = ecx;
    this.reg32s[reg_edx] = edx;
    this.reg32s[reg_ebx] = ebx;
};

CPU.prototype.update_cs_size = function(new_size)
{
    this.is_32 = this.operand_size_32 = this.address_size_32 = new_size;

    this.update_operand_size();
    this.update_address_size();

    if(OP_TRANSLATION)
    {
        this.translator.clear_cache();
    }
};

CPU.prototype.update_operand_size = function()
{
    if(this.operand_size_32)
    {
        this.table = this.table32;
    }
    else
    {
        this.table = this.table16;
    }
};

CPU.prototype.update_address_size = function()
{
    if(this.address_size_32)
    {
        this.regv = this.reg32s;
        this.reg_vcx = reg_ecx;
        this.reg_vsi = reg_esi;
        this.reg_vdi = reg_edi;
    }
    else
    {
        this.regv = this.reg16;
        this.reg_vcx = reg_cx;
        this.reg_vsi = reg_si;
        this.reg_vdi = reg_di;
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
        table_offset = this.gdtr_offset;
        table_limit = this.gdtr_size;
    }
    else
    {
        table_offset = this.segment_offsets[reg_ldtr];
        table_limit = this.segment_limits[reg_ldtr];
    }

    if(selector_offset === 0)
    {
        info.is_null = true;
        return info;
    }

    // limit is the number of entries in the table minus one
    if((selector | 7) > table_limit)
    {
        dbg_log("Selector " + h(selector, 4) + " is outside of the "
                    + (is_gdt ? "g" : "l") + "dt limits", LOG_CPU)
        info.is_valid = false;
        return info;
    }

    table_offset = table_offset + selector_offset | 0;

    if(this.paging)
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
 * @param {number} reg
 * @param {number} selector
 */
CPU.prototype.switch_seg = function(reg, selector)
{
    dbg_assert(reg >= 0 && reg <= 5);
    dbg_assert(typeof selector === "number" && selector < 0x10000 && selector >= 0);

    if(!this.protected_mode || this.vm86_mode())
    {
        this.sreg[reg] = selector;
        this.segment_is_null[reg] = 0;
        this.segment_offsets[reg] = selector << 4;

        if(reg === reg_ss)
        {
            this.stack_size_32 = false;
        }
        return;
    }

    var info = this.lookup_segment_selector(selector);

    if(reg === reg_ss)
    {
        if(info.is_null)
        {
            dbg_log("#GP for loading 0 in SS sel=" + h(selector, 4), LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_gp(0);
        }

        if(!info.is_valid ||
           info.is_system ||
           info.rpl !== this.cpl ||
           !info.is_writable ||
           info.dpl !== this.cpl)
        {
            dbg_log("#GP for loading invalid in SS sel=" + h(selector, 4), LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_gp(selector & ~3);
        }

        if(!info.is_present)
        {
            dbg_log("#SS for loading non-present in SS sel=" + h(selector, 4), LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_ss(selector & ~3);
        }

        this.stack_size_32 = info.size;
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
            return;
        }

        if(!info.is_valid ||
           info.is_system ||
           !info.is_readable ||
           (!info.is_conforming_executable &&
            (info.rpl > info.dpl || this.cpl > info.dpl))
        ) {
            dbg_log("#GP for loading invalid in seg " + reg + " sel=" + h(selector, 4), LOG_CPU);
            this.debug.dump_state();
            this.debug.dump_regs_short();
            dbg_trace(LOG_CPU);
            this.trigger_gp(selector & ~3);
        }

        if(!info.is_present)
        {
            dbg_log("#NP for loading not-present in seg " + reg + " sel=" + h(selector, 4), LOG_CPU);
            dbg_trace(LOG_CPU);
            this.trigger_np(selector & ~3);
        }
    }

    this.segment_is_null[reg] = 0;
    this.segment_limits[reg] = info.effective_limit;
    //this.segment_infos[reg] = 0; // TODO

    this.segment_offsets[reg] = info.base;
    this.sreg[reg] = selector;
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

    if(!info.is_present)
    {
        dbg_log("#GP | present bit not set (ltr)");
        throw this.debug.unimpl("#GP handler");
    }

    if(!info.is_system)
    {
        dbg_log("#GP | ltr: not a system entry");
        throw this.debug.unimpl("#GP handler");
    }

    if(info.type !== 9 && info.type !== 1)
    {
        // 0xB: busy 386 TSS (GP)
        // 0x3: busy 286 TSS (GP)
        // 0x1: 286 TSS (??)
        dbg_log("#GP | ltr: invalid type (type = " + h(info.type) + ")");
        throw this.debug.unimpl("#GP handler");
    }

    if(info.type === 1)
    {
        // 286 tss: Load 16 bit values from tss in call_interrupt_vector
        throw this.debug.unimpl("286 tss");
    }

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

CPU.prototype.arpl = function(seg, r16)
{
    this.flags_changed &= ~flag_zero;

    if((seg & 3) < (this.reg16[r16] & 3))
    {
        this.flags |= flag_zero;
        return seg & ~3 | this.reg16[r16] & 3;
    }
    else
    {
        this.flags &= ~flag_zero;
        return seg;
    }
};

CPU.prototype.lar = function(selector, original)
{
    /** @const */
    var LAR_INVALID_TYPE = 1 << 0 | 1 << 6 | 1 << 7 | 1 << 8 | 1 << 0xA |
                           1 << 0xD | 1 << 0xE | 1 << 0xF;

    var info = this.lookup_segment_selector(selector);
    this.flags_changed &= ~flag_zero;

    var dpl_bad = info.dpl < this.cpl || info.dpl < info.rpl;

    if(info.is_null || !info.is_valid ||
       (info.is_system ? (LAR_INVALID_TYPE >> info.type & 1) || dpl_bad :
                         !info.is_conforming_executable && dpl_bad)
    ) {
        this.flags &= ~flag_zero;
        dbg_log("lar: invalid selector=" + h(selector, 4) + " is_null=" + info.is_null, LOG_CPU);
        return original;
    }
    else
    {
        this.flags |= flag_zero;
        return info.raw1 & 0x00FFFF00;
    }

};

CPU.prototype.lsl = function(selector, original)
{
    /** @const */
    var LSL_INVALID_TYPE = 1 << 0 | 1 << 4 | 1 << 5 | 1 << 6 | 1 << 8 |
                           1 << 0xA | 1 << 0xC | 1 << 0xD | 1 << 0xE | 1 << 0xF;

    var info = this.lookup_segment_selector(selector);
    this.flags_changed &= ~flag_zero;

    var dpl_bad = info.dpl < this.cpl || info.dpl < info.rpl;

    if(info.is_null || !info.is_valid ||
       (info.is_system ? (LSL_INVALID_TYPE >> info.type & 1) || dpl_bad :
                         !info.is_conforming_executable && dpl_bad)
    ) {
        this.flags &= ~flag_zero;
        dbg_log("lsl: invalid  selector=" + h(selector, 4) + " is_null=" + info.is_null, LOG_CPU);
        return original;
    }
    else
    {
        this.flags |= flag_zero;
        return info.effective_limit | 0;
    }

};

CPU.prototype.verr = function(selector)
{
    var info = this.lookup_segment_selector(selector);
    this.flags_changed &= ~flag_zero;

    if(info.is_null || !info.is_valid || info.is_system || !info.is_readable ||
       (!info.is_conforming_executable && (info.dpl < this.cpl || info.dpl < info.rpl)))
    {
        dbg_log("verr -> invalid. selector=" + h(selector, 4), LOG_CPU);
        this.flags &= ~flag_zero;
    }
    else
    {
        dbg_log("verr -> valid. selector=" + h(selector, 4), LOG_CPU);
        this.flags |= flag_zero;
    }
};

CPU.prototype.verw = function(selector)
{
    var info = this.lookup_segment_selector(selector);
    this.flags_changed &= ~flag_zero;

    if(info.is_null || !info.is_valid || info.is_system || !info.is_writable ||
       info.dpl < this.cpl || info.dpl < info.rpl)
    {
        dbg_log("verw invalid " + " " + h(selector) + " " + info.is_null + " " +
                !info.is_valid + " " + info.is_system + " " + !info.is_writable + " " +
                (info.dpl < this.cpl) + " " + (info.dpl < info.rpl) + " " + LOG_CPU);
        this.flags &= ~flag_zero;
    }
    else
    {
        this.flags |= flag_zero;
    }
};

CPU.prototype.clear_tlb = function()
{
    // clear tlb excluding global pages
    this.last_virt_eip = -1;
    this.last_virt_esp = -1;

    this.tlb_info.set(this.tlb_info_global);

    //dbg_log("page table loaded", LOG_CPU);
};

CPU.prototype.full_clear_tlb = function()
{
    //dbg_log("TLB full clear", LOG_CPU);

    // clear tlb including global pages
    var buf32 = new Int32Array(this.tlb_info_global.buffer);
    for(var i = 0; i < (1 << 18); )
    {
        buf32[i++] = buf32[i++] = buf32[i++] = buf32[i++] = 0;
    }

    this.clear_tlb();
};

CPU.prototype.invlpg = function(addr)
{
    var page = addr >>> 12;
    //dbg_log("invlpg: addr=" + h(addr >>> 0), LOG_CPU);

    this.tlb_info[page] = 0;
    this.tlb_info_global[page] = 0;

    this.last_virt_eip = -1;
    this.last_virt_esp = -1;
};

CPU.prototype.translate_address_read = function(addr)
{
    if(!this.paging)
    {
        return addr;
    }

    if(this.cpl === 3)
    {
        return this.translate_address_user_read(addr);
    }
    else
    {
        return this.translate_address_system_read(addr);
    }
};

CPU.prototype.translate_address_write = function(addr)
{
    if(!this.paging)
    {
        return addr;
    }

    if(this.cpl === 3)
    {
        return this.translate_address_user_write(addr);
    }
    else
    {
        return this.translate_address_system_write(addr);
    }
};

CPU.prototype.translate_address_user_write = function(addr)
{
    if(!this.paging)
    {
        return addr;
    }

    var base = addr >>> 12;

    if(this.tlb_info[base] & TLB_USER_WRITE)
    {
        return this.tlb_data[base] ^ addr;
    }
    else
    {
        return this.do_page_translation(addr, 1, 1) | addr & 0xFFF;
    }
};

CPU.prototype.translate_address_user_read = function(addr)
{
    if(!this.paging)
    {
        return addr;
    }

    var base = addr >>> 12;

    if(this.tlb_info[base] & TLB_USER_READ)
    {
        return this.tlb_data[base] ^ addr;
    }
    else
    {
        return this.do_page_translation(addr, 0, 1) | addr & 0xFFF;
    }
};

CPU.prototype.translate_address_system_write = function(addr)
{
    if(!this.paging)
    {
        return addr;
    }

    var base = addr >>> 12;

    if(this.tlb_info[base] & TLB_SYSTEM_WRITE)
    {
        return this.tlb_data[base] ^ addr;
    }
    else
    {
        return this.do_page_translation(addr, 1, 0) | addr & 0xFFF;
    }
};

CPU.prototype.translate_address_system_read = function(addr)
{
    if(!this.paging)
    {
        return addr;
    }

    var base = addr >>> 12;

    if(this.tlb_info[base] & TLB_SYSTEM_READ)
    {
        return this.tlb_data[base] ^ addr;
    }
    else
    {
        return this.do_page_translation(addr, 0, 0) | addr & 0xFFF;
    }
};

/**
 * @return {number}
 */
CPU.prototype.do_page_translation = function(addr, for_writing, user)
{
    var page = addr >>> 12,
        page_dir_addr = (this.cr[3] >>> 2) + (page >> 10) | 0,
        page_dir_entry = this.mem32s[page_dir_addr],
        high,
        can_write = true,
        global,
        cachable = true,
        allow_user = true;

    dbg_assert(addr < 0x80000000);

    if(!(page_dir_entry & 1))
    {
        // to do at this place:
        //
        // - set cr2 = addr (which caused the page fault)
        // - call_interrupt_vector  with id 14, error code 0-7 (requires information if read or write)
        // - prevent execution of the function that triggered this call
        //dbg_log("#PF not present", LOG_CPU);

        this.cr[2] = addr;
        this.trigger_pagefault(for_writing, user, 0);

        // never reached as this.trigger_pagefault throws up
        dbg_assert(false);
    }

    if((page_dir_entry & 2) === 0)
    {
        can_write = false;

        if(for_writing && (user || (this.cr[0] & CR0_WP)))
        {
            this.cr[2] = addr;
            this.trigger_pagefault(for_writing, user, 1);
            dbg_assert(false);
        }
    }

    if((page_dir_entry & 4) === 0)
    {
        allow_user = false;

        if(user)
        {
            // "Page Fault: page table accessed by non-supervisor";
            //dbg_log("#PF supervisor", LOG_CPU);
            this.cr[2] = addr;
            this.trigger_pagefault(for_writing, user, 1);
            dbg_assert(false);
        }
    }

    if(page_dir_entry & this.page_size_extensions)
    {
        // size bit is set

        // set the accessed and dirty bits
        this.mem32s[page_dir_addr] = page_dir_entry | 0x20 | for_writing << 6;

        high = (page_dir_entry & 0xFFC00000) | (addr & 0x3FF000);
        global = page_dir_entry & 0x100;
    }
    else
    {
        var page_table_addr = ((page_dir_entry & 0xFFFFF000) >>> 2) + (page & 0x3FF) | 0,
            page_table_entry = this.mem32s[page_table_addr];

        if((page_table_entry & 1) === 0)
        {
            //dbg_log("#PF not present table", LOG_CPU);
            this.cr[2] = addr;
            this.trigger_pagefault(for_writing, user, 0);
            dbg_assert(false);
        }

        if((page_table_entry & 2) === 0)
        {
            can_write = false;

            if(for_writing && (user || (this.cr[0] & CR0_WP)))
            {
                //dbg_log("#PF not writable page", LOG_CPU);
                this.cr[2] = addr;
                this.trigger_pagefault(for_writing, user, 1);
                dbg_assert(false);
            }
        }

        if((page_table_entry & 4) === 0)
        {
            allow_user = false;

            if(user)
            {
                //dbg_log("#PF not supervisor page", LOG_CPU);
                this.cr[2] = addr;
                this.trigger_pagefault(for_writing, user, 1);
                dbg_assert(false);
            }
        }

        // set the accessed and dirty bits
        this.write_aligned32(page_dir_addr, page_dir_entry | 0x20);
        this.write_aligned32(page_table_addr, page_table_entry | 0x20 | for_writing << 6);

        high = page_table_entry & 0xFFFFF000;
        global = page_table_entry & 0x100;
    }

    this.tlb_data[page] = high ^ page << 12;

    var allowed_flag;

    if(allow_user)
    {
        if(can_write)
        {
            allowed_flag = TLB_SYSTEM_READ | TLB_SYSTEM_WRITE | TLB_USER_READ | TLB_USER_WRITE;
        }
        else
        {
            // TODO: Consider if cr0.wp is not set
            allowed_flag = TLB_SYSTEM_READ | TLB_USER_READ;
        }
    }
    else
    {
        if(can_write)
        {
            allowed_flag = TLB_SYSTEM_READ | TLB_SYSTEM_WRITE;
        }
        else
        {
            allowed_flag = TLB_SYSTEM_READ;
        }
    }

    this.tlb_info[page] = allowed_flag;

    if(global && (this.cr[4] & CR4_PGE))
    {
        this.tlb_info_global[page] = allowed_flag;
    }

    return high;
};

CPU.prototype.writable_or_pagefault = function(addr, size)
{
    dbg_assert(size < 0x1000, "not supported yet");
    dbg_assert(size > 0);

    if(!this.paging)
    {
        return;
    }

    var user = this.cpl === 3 ? 1 : 0,
        mask = user ? TLB_USER_WRITE : TLB_SYSTEM_WRITE,
        page = addr >>> 12;

    if((this.tlb_info[page] & mask) === 0)
    {
        this.do_page_translation(addr, 1, user);
    }

    if((addr & 0xFFF) + size - 1 >= 0x1000)
    {
        if((this.tlb_info[page + 1 | 0] & mask) === 0)
        {
            this.do_page_translation(addr + size - 1 | 0, 1, user);
        }
    }
};

CPU.prototype.trigger_pagefault = function(write, user, present)
{
    //dbg_log("page fault w=" + write + " u=" + user + " p=" + present +
    //        " eip=" + h(this.previous_ip >>> 0, 8) +
    //        " cr2=" + h(this.cr[2] >>> 0, 8), LOG_CPU);
    //dbg_trace(LOG_CPU);

    if(this.page_fault)
    {
        dbg_trace(LOG_CPU);
        throw this.debug.unimpl("Double fault");
    }

    // invalidate tlb entry
    var page = this.cr[2] >>> 12;

    this.tlb_info[page] = 0;
    this.tlb_info_global[page] = 0;

    this.instruction_pointer = this.previous_ip;
    this.page_fault = true;
    this.call_interrupt_vector(14, false, user << 2 | write << 1 | present);

    throw MAGIC_CPU_EXCEPTION;
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
