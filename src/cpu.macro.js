"use strict";

/** @constructor */
function CPU()
{
    /** @type {number } */
    this.memory_size = 0;


    this.segment_is_null = [];
    this.segment_offsets = [];
    this.segment_limits = [];
    //this.segment_infos = [];

    /*
     * Translation Lookaside Buffer 
     */
    this.tlb_data = [];

    /*
     * Information about which pages are cached in the tlb.
     * By bit:
     *   0 system, read
     *   1 system, write
     *   2 user, read
     *   3 user, write
     */
    this.tlb_info = [];

    /*
     * Same as tlb_info, except it only contains global pages
     */
    this.tlb_info_global = [];

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

    /** @type {number} */
    this.cr0 = 0;
    /** @type {number} */
    this.cr2 = 0;
    /** @type {number} */
    this.cr3 = 0;
    /** @type {number} */
    this.cr4 = 0;

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

    this.tsc_offset = 0;


    // cpu.reg16 or cpu.reg32s, depending on address size attribute
    this.regv = this.reg16;
    this.reg_vcx = 0;
    this.reg_vsi = 0;
    this.reg_vdi = 0;

    this.table = [];
    this.table0F = [];

    // paging enabled
    /** @type {boolean} */
    this.paging = false;


    /** @type {number} */
    this.instruction_pointer = 0;

    /** @type {number} */
    this.previous_ip = 0;

    /** @type {!Object} */
    this.bios = {};

    /** 
     * @type {number}
     */
    this.timestamp_counter = 0;

    //this.modrm_resolve = function(x){ dbg_assert(false); };

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


    // sp or esp, depending on stack size attribute
    this.stack_reg = this.reg16;
    this.reg_vsp = 0;
    this.reg_vbp = 0;

    /** @type {Memory} */
    this.memory = null;

    // current state of prefixes
    this.segment_prefix = SEG_PREFIX_NONE;

    // dynamic instruction translator
    this.translator = undefined;

    // was the last instruction a jump?
    this.last_instr_jump = false;

    this.io = undefined;
    this.fpu = undefined;

// it looks pointless to have this here, but 
// Closure Compiler is able to remove unused functions
#include "debug.macro.js"

    /** @const */
    this._state_skip = [
        "bios",
        "debug",
        "regv",
        "table", "table0F",
        "table16", "table32",
        "table0F_16", "table0F_32",
        "reg8", "reg8s", 
        "reg16", "reg16s", "reg32",

        "tlb_data",
        "tlb_info",
        "tlb_info_global",

        "timestamp_counter",
    ];
}

CPU.prototype._state_restore = function()
{
    this.reg32 = new Uint32Array(this.reg32s.buffer);
    this.reg16s = new Int16Array(this.reg32s.buffer);
    this.reg16 = new Uint16Array(this.reg32s.buffer);
    this.reg8s = new Int8Array(this.reg32s.buffer);
    this.reg8 = new Uint8Array(this.reg32s.buffer);

    this.update_address_size();
    this.update_operand_size();

    if(this.stack_size_32)
    {
        this.stack_reg = this.reg32s;
    }
    else
    {
        this.stack_reg = this.reg16;
    }

    this.full_clear_tlb();
    this.timestamp_counter = 0;
    this.tsc_offset = v86.microtick();
};

#include "translate.macro.js"

#include "modrm.macro.js"
#include "arith.macro.js"
#include "string.macro.js"
#include "instructions.macro.js"
#include "misc_instr.macro.js"


CPU.prototype.main_run = function()
{
    try 
    {
        if(this.in_hlt)
        {
            this.hlt_loop();
        }
        else
        {
            this.do_run();
        }
    }
    catch(e)
    {
        this.exception_cleanup(e);
    }
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
        this.repeat_string_prefix = REPEAT_STRING_PREFIX_NONE;
        this.segment_prefix = SEG_PREFIX_NONE;
        
        this.address_size_32 = this.is_32;
        this.update_address_size();
        this.operand_size_32 = this.is_32;
        this.update_operand_size();
    }
    else
    {
        console.log(e);
        console.log(e.stack);
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
    this.segment_is_null = new Uint8Array(8);
    this.segment_limits = new Uint32Array(8);
    //this.segment_infos = new Uint32Array(8);
    this.segment_offsets = new Int32Array(8);

    // 16 MB in total
    this.tlb_data = new Int32Array(1 << 20);
    this.tlb_info = new Uint8Array(1 << 20);
    this.tlb_info_global = new Uint8Array(1 << 20);


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
    this.cr0 = 1 << 30 | 1 << 29 | 1 << 4;
    this.cr2 = 0;
    this.cr3 = 0;
    this.cr4 = 0;
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

    this.stack_reg = this.reg16;
    this.reg_vsp = reg_sp;
    this.reg_vbp = reg_bp;

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
    this.switch_seg(reg_ss, 0x30);
    this.reg16[reg_sp] = 0x100;
};

CPU.prototype.init = function(settings)
{
    this.memory_size = settings.memory_size || 1024 * 1024 * 64;
    this.memory = new Memory(this.memory_size);

    this.reset();

    if(OP_TRANSLATION)
    {
        this.translator = new DynamicTranslator(this);
        this.last_instr_jump = false;
    }

    var io = new IO(this.memory);
    this.io = io;

    this.bios = {
        main: settings.bios,
        vga: settings.vga_bios,
    };

    this.load_bios();

    var a20_byte = 0;

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
        this.devices.dma = new DMA(this);

        this.devices.acpi = new ACPI(this);
        if(ENABLE_HPET)
        {
            this.devices.hpet = new HPET(this);
        }

        this.devices.vga = new VGAScreen(this, 
                settings.screen_adapter, settings.vga_memory_size || 8 * 1024 * 1024);
        this.devices.ps2 = new PS2(this, settings.keyboard_adapter, settings.mouse_adapter);
        
        this.fpu = new FPU(this);

        if(settings.serial_adapter)
        {
            this.devices.uart = new UART(this, 0x3F8, settings.serial_adapter);
        }
        else
        {
            this.devices.uart = new UART(this, 0x3F8, { 
                put_chr: function(chr) { },
                init: function(fn) {  },
            });
        }

        this.devices.fdc = new FloppyController(this, settings.fda, settings.fdb);

        if(settings.cdrom)
        {
            this.devices.cdrom = new IDEDevice(this, settings.cdrom, true, 1);
        }

        if(settings.hda)
        {
            this.devices.hda = new IDEDevice(this, settings.hda, false, 0);
        }
        else
        {
            //this.devices.hda = new IDEDevice(this, undefined, false, 0);
        }
        //if(settings.hdb)
        //{
        //    this.devices.hdb = hdb = new IDEDevice(this, settings.hdb, false, 1);
        //}

        this.devices.pit = new PIT(this);
        this.devices.rtc = new RTC(this, this.devices.fdc.type, settings.boot_order || 0x213);

        if(settings.network_adapter)
        {
            this.devices.net = new Ne2k(this, settings.network_adapter);
        }

        if(settings.fs9p)
        {
            this.devices.virtio = new VirtIO(this, settings.fs9p);
        }
    }

    if(DEBUG)
    {
        this.debug.init();
    }
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

    this.memory.mem8.set(data, start);

    if(vga_bios)
    {
        // load vga bios
        data = new Uint8Array(vga_bios);
        this.memory.mem8.set(data, 0xC0000);
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
            return this.memory.mem8[addr];
            //return data[start + addr];
        }.bind(this),
        function(addr, value)
        {
            addr &= 0xFFFFF;
            this.memory.mem8[addr] = value;
            //data[start + addr] = value;
        }.bind(this));

};

CPU.prototype.do_run = function()
{
    var 
        /** 
         * @type {number}
         */
        start = Date.now(),
        now = start;

    this.devices.vga.timer();

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

        this.handle_irqs();

        // inner loop:
        // runs only cycles
        for(var k = LOOP_COUNTER; k--;)
        {
            if(OP_TRANSLATION)
            {
                this.translator.cycle_translated();
            }
            else
            {
                this.cycle();
            }
        }

        now = Date.now();
    }
};


// do_run must not be inlined into cpu_run, because then more code 
// is in the deoptimized try-catch. 
// This trick is a bit ugly, but it works without further complication.
if(typeof window !== "undefined")
{
    window.__no_inline1 = CPU.prototype.do_run;
    window.__no_inline2 = CPU.prototype.exception_cleanup;
    window.__no_inline3 = CPU.prototype.hlt_loop;
};

/**
 * execute a single instruction cycle on the cpu
 * this includes reading all prefixes and the whole instruction
 */
CPU.prototype.cycle = function()
{
    this.timestamp_counter++;
    this.previous_ip = this.instruction_pointer;

    var opcode = this.read_imm8();

    if(DEBUG) 
    { 
        this.debug.logop(this.instruction_pointer - 1 >>> 0, opcode); 
    }

    // call the instruction
    this.table[opcode](this);

    if(this.flags & flag_trap)
    {
        // TODO
        dbg_log("Trap flag: Ignored", LOG_CPU);
    }
};

CPU.prototype.do_op = function()
{
    this.table[this.read_imm8()](this);
};

CPU.prototype.hlt_loop = function()
{
    //dbg_log("In HLT loop", LOG_CPU);

    var now = Date.now();

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

    this.devices.vga.timer(now);

    //if(this.in_hlt)
    //{
    //    var me = this;
    //    setTimeout(function() { me.hlt_loop(); }, 0);
    //}
    //else
    //{
    //    this.next_tick();
    //}
};

CPU.prototype.cr0_changed = function(old_cr0)
{
    //dbg_log("cr0 = " + h(this.cr0 >>> 0), LOG_CPU);

    var new_paging = (this.cr0 & CR0_PG) === CR0_PG;

    if(!this.fpu)
    {
        // if there's no FPU, keep emulation set
        this.cr0 |= CR0_EM;
    }
    this.cr0 |= CR0_ET;

    dbg_assert(typeof this.paging === "boolean");
    if(new_paging !== this.paging)
    {
        this.paging = new_paging;
        this.full_clear_tlb();
    }

    if(OP_TRANSLATION && (this.cr0 ^ old_cr0) & 1)
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

CPU.prototype.get_phys_eip = function()
{
    if((this.instruction_pointer & ~0xFFF) ^ this.last_virt_eip)
    {
        this.eip_phys = this.translate_address_read(this.instruction_pointer) ^ this.instruction_pointer;
        this.last_virt_eip = this.instruction_pointer & ~0xFFF;
    }

    return this.eip_phys ^ this.instruction_pointer;
};

CPU.prototype.read_imm8 = function()
{
    if((this.instruction_pointer & ~0xFFF) ^ this.last_virt_eip)
    {
        this.eip_phys = this.translate_address_read(this.instruction_pointer) ^ this.instruction_pointer;
        this.last_virt_eip = this.instruction_pointer & ~0xFFF;
    }

    // memory.read8 inlined under the assumption that code never runs in 
    // memory-mapped space
    var data8 = this.memory.mem8[this.eip_phys ^ this.instruction_pointer] | 0;
    //var data8 = this.memory.read8(this.eip_phys ^ this.instruction_pointer);
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

    var data16 = this.memory.read16(this.eip_phys ^ this.instruction_pointer);
    this.instruction_pointer = this.instruction_pointer + 2 | 0;

    return data16;
};

CPU.prototype.read_imm16s = function()
{
    return this.read_imm16() << 16 >> 16;
};

CPU.prototype.read_imm32s = function()
{
    // Analogue to the above comment
    if(((this.instruction_pointer ^ this.last_virt_eip) >>> 0) > 0xFFC)
    {
        return this.read_imm16() | this.read_imm16() << 16;
    }

    var data32 = this.memory.read32s(this.eip_phys ^ this.instruction_pointer);
    this.instruction_pointer = this.instruction_pointer + 4 | 0;

    return data32;
};

// read word from a page boundary, given 2 physical addresses
CPU.prototype.virt_boundary_read16 = function(low, high)
{
    dbg_assert((low & 0xFFF) === 0xFFF);
    dbg_assert((high & 0xFFF) === 0);

    return this.memory.read8(low) | this.memory.read8(high) << 8;
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
            mid = this.memory.read_aligned16(high - 2 >> 1);
        }
        else
        {
            // 0xFFD
            mid = this.memory.read_aligned16(low + 1 >> 1);
        }
    }
    else
    {
        // 0xFFE
        mid = this.virt_boundary_read16(low + 1, high - 1); 
    }

    return this.memory.read8(low) | mid << 8 | this.memory.read8(high) << 24;;
};

CPU.prototype.virt_boundary_write16 = function(low, high, value)
{
    dbg_assert((low & 0xFFF) === 0xFFF);
    dbg_assert((high & 0xFFF) === 0);

    this.memory.write8(low, value);
    this.memory.write8(high, value >> 8);
};

CPU.prototype.virt_boundary_write32 = function(low, high, value)
{
    dbg_assert((low & 0xFFF) >= 0xFFD);
    dbg_assert((high - 3 & 0xFFF) === (low & 0xFFF));

    this.memory.write8(low, value);
    this.memory.write8(high, value >> 24);

    if(low & 1)
    {
        if(low & 2)
        {
            // 0xFFF
            this.memory.write8(high - 2, value >> 8);
            this.memory.write8(high - 1, value >> 16);
        }
        else
        {
            // 0xFFD
            this.memory.write8(low + 1, value >> 8);
            this.memory.write8(low + 2, value >> 16);
        }
    }
    else
    {
        // 0xFFE
        this.memory.write8(low + 1, value >> 8);
        this.memory.write8(high - 1, value >> 16);
    }
};

// safe_read, safe_write
// read or write byte, word or dword to the given *virtual* address,
// and be safe on page boundaries

CPU.prototype.safe_read8 = function(addr)
{
    dbg_assert(addr < 0x80000000);
    return this.memory.read8(this.translate_address_read(addr));
};

CPU.prototype.safe_read16 = function(addr)
{
    if(this.paging && (addr & 0xFFF) === 0xFFF)
    {
        return this.safe_read8(addr) | this.safe_read8(addr + 1) << 8;
    }
    else
    {
        return this.memory.read16(this.translate_address_read(addr));
    }
};

CPU.prototype.safe_read32s = function(addr)
{
    if(this.paging && (addr & 0xFFF) >= 0xFFD)
    {
        return this.safe_read16(addr) | this.safe_read16(addr + 2) << 16;
    }
    else
    {
        return this.memory.read32s(this.translate_address_read(addr));
    }
};

CPU.prototype.safe_write8 = function(addr, value)
{
    dbg_assert(addr < 0x80000000);
    this.memory.write8(this.translate_address_write(addr), value);
};

CPU.prototype.safe_write16 = function(addr, value)
{
    var phys_low = this.translate_address_write(addr);

    if((addr & 0xFFF) === 0xFFF)
    {
        this.virt_boundary_write16(phys_low, this.translate_address_write(addr + 1), value);
    }
    else
    {
        this.memory.write16(phys_low, value);
    }
};

CPU.prototype.safe_write32 = function(addr, value)
{
    var phys_low = this.translate_address_write(addr);

    if((addr & 0xFFF) >= 0xFFD)
    {
        this.virt_boundary_write32(phys_low, this.translate_address_write(addr + 3), value);
    }
    else
    {
        this.memory.write32(phys_low, value);
    }
};

// read 2 or 4 byte from ip, depending on address size attribute
CPU.prototype.read_moffs = function()
{
    if(this.address_size_32)
    {
        return this.get_seg_prefix(reg_ds) + this.read_imm32s() | 0;
    }
    else
    {
        return this.get_seg_prefix(reg_ds) + this.read_imm16() | 0;
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
    var mask = flag_rf | flag_vm | flag_vip | flag_vif,
        clear = ~flag_vip & ~flag_vif & flags_mask;

    if(this.flags & flag_vm)
    {
        // other case needs to be handled in popf or iret
        dbg_assert(this.getiopl() === 3);

        mask |= flag_iopl;

        // vip and vif are preserved
        clear |= flag_vip | flag_vif;
    }
    else 
    {
        if(!this.protected_mode) dbg_assert(this.cpl === 0);

        if(this.cpl)
        {
            // cpl > 0
            // cannot update iopl
            mask |= flag_iopl;

            if(this.cpl > this.getiopl())
            {
                // cpl > iopl
                // can update interrupt flag but not iopl
                mask |= flag_interrupt;
            }
        }
    }

    this.flags = (new_flags ^ ((this.flags ^ new_flags) & mask)) & clear | flags_default;

    this.flags_changed = 0;
};


CPU.prototype.get_stack_pointer = function(mod)
{
    return this.get_seg(reg_ss) + this.stack_reg[this.reg_vsp] + mod | 0;
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
    dbg_assert(this.instruction_pointer !== undefined);

    if(DEBUG && this.debug.step_mode)
    {
        this.debug.ops.add(this.instruction_pointer >>> 0);
        this.debug.ops.add("-- INT " + h(interrupt_nr));
        this.debug.ops.add(1);
    }

    //if(interrupt_nr == 0x13)
    //{
    //    dbg_log("INT 13");
    //    dbg_log(this.memory.read8(ch) + "/" + this.memory.read8(dh) + "/" + this.memory.read8(cl) + "   |" + this.memory.read8(al));
    //    dbg_log("=> ", h(this.memory.read16(es) * 16 + this.memory.read16(bx)));
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
    //            "file=" + this.memory.read_string(this.translate_address_read(this.read_imm32s())), LOG_CPU);
    //    this.instruction_pointer -= 8;
    //    this.debug.dump_regs_short();
    //}

    //if(interrupt_nr === 0x80)
    //{
    //    dbg_log("linux syscall");
    //    this.debug.dump_regs_short();
    //}


    //if(interrupt_nr === 14)
    //{
    //    dbg_log("int14 error_code=" + error_code + 
    //            " cr2=" + h(this.cr2 >>> 0) + 
    //            " prev=" + h(this.previous_ip >>> 0) + 
    //            " cpl=" + this.cpl, LOG_CPU);
    //}

    //if(interrupt_nr === 0x40)
    //{
    //    dbg_log("kolibri syscall");
    //    this.debug.dump_regs_short();
    //}


    // we have to leave hlt_loop at some point, this is a 
    // good place to do it
    //this.in_hlt && dbg_log("Leave HLT loop", LOG_CPU);
    this.in_hlt = false;

    if(this.protected_mode)
    {
        if(this.vm86_mode() && (this.cr4 & CR4_VME))
        {
            throw this.debug.unimpl("VME");
        }

        if(this.vm86_mode() && is_software_int && this.getiopl() < 3)
        {
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

        var base = this.memory.read16(addr) | this.memory.read16(addr + 6) << 16,
            selector = this.memory.read16(addr + 2),
            type = this.memory.read8(addr + 5),
            dpl = type >> 5 & 3,
            is_trap;

        if((type & 128) === 0)
        {
            // present bit not set
            throw this.debug.unimpl("#NP handler");
        }

        if(is_software_int && dpl < this.cpl)
        {
            this.trigger_gp(interrupt_nr << 3 | 2);
        }

        type &= 31;
        
        if(type === 14)
        {
            is_trap = false;
        }
        else if(type === 15)
        {
            is_trap = true;
        }
        else if(type === 5)
        {
            throw this.debug.unimpl("call int to task gate");
        }
        else if(type === 6)
        {
            throw this.debug.unimpl("16 bit interrupt gate");
        }
        else if(type === 7)
        {
            throw this.debug.unimpl("16 bit trap gate");
        }
        else
        {
            // invalid type
            dbg_trace(LOG_CPU);
            dbg_log("invalid type: " + h(type));
            dbg_log(h(addr) + " " + h(base) + " " + h(selector));
            throw this.debug.unimpl("#GP handler");
        }

        var info = this.lookup_segment_selector(selector);

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

        if(!info.dc_bit && info.dpl < this.cpl)
        {
            // inter privilege level interrupt
            // interrupt from vm86 mode

            var tss_stack_addr = (info.dpl << 3) + 4;

            if(tss_stack_addr + 5 > this.segment_limits[reg_tr])
            {
                throw this.debug.unimpl("#TS handler");
            }

            tss_stack_addr = tss_stack_addr + this.segment_offsets[reg_tr] | 0;
            
            if(this.paging)
            {
                tss_stack_addr = this.translate_address_system_read(tss_stack_addr);
            }

            var new_esp = this.memory.read32s(tss_stack_addr),
                new_ss = this.memory.read16(tss_stack_addr + 4),
                ss_info = this.lookup_segment_selector(new_ss);

            if(ss_info.is_null)
            {
                throw this.debug.unimpl("#TS handler");
            }
            if(ss_info.rpl !== info.dpl)
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

            var old_esp = this.reg32s[reg_esp],
                old_ss = this.sreg[reg_ss];

            if(old_flags & flag_vm)
            {
                dbg_log("return from vm86 mode");
                this.debug.dump_regs_short();
            }


            this.cpl = info.dpl;
            //dbg_log("int" + h(interrupt_nr, 2) +" from=" + h(this.instruction_pointer >>> 0, 8) 
            //        + " cpl=" + cpl + " old ss:esp=" + h(old_ss, 4) + ":" + h(old_esp >>> 0, 8), LOG_CPU);

            this.cpl_changed();

            dbg_assert(typeof info.size === "boolean");
            if(this.is_32 !== info.size)
            {
                this.update_cs_size(info.size);
            }

            this.flags &= ~flag_vm & ~flag_rf;

            this.reg32s[reg_esp] = new_esp;
            this.switch_seg(reg_ss, new_ss);

            if(old_flags & flag_vm)
            {
                this.push32(this.sreg[reg_gs]);
                this.push32(this.sreg[reg_fs]);
                this.push32(this.sreg[reg_ds]);
                this.push32(this.sreg[reg_es]);
            }

            this.push32(old_ss);
            this.push32(old_esp);
        }
        else if(info.dc_bit || info.dpl === this.cpl)
        {
            if(this.flags & flag_vm)
            {
                this.trigger_gp(selector & ~3);
            }
            // intra privilege level interrupt

            //dbg_log("int" + h(interrupt_nr, 2) +" from=" + h(this.instruction_pointer, 8), LOG_CPU);
        }
        else
        {
            throw this.debug.unimpl("#GP handler");
        }

        this.push32(old_flags);

        this.push32(this.sreg[reg_cs]);
        this.push32(this.get_real_eip());
        //dbg_log("pushed eip to " + h(this.reg32s[reg_esp], 8), LOG_CPU);

        if(old_flags & flag_vm)
        {
            this.switch_seg(reg_gs, 0);
            this.switch_seg(reg_fs, 0);
            this.switch_seg(reg_ds, 0);
            this.switch_seg(reg_es, 0);
        }

        if(error_code !== false)
        {
            dbg_assert(typeof error_code == "number");
            this.push32(error_code);
        }
        

        // TODO
        this.sreg[reg_cs] = selector;
        //this.switch_seg(reg_cs);

        dbg_assert(typeof info.size === "boolean");
        if(this.is_32 !== info.size)
        {
            this.update_cs_size(info.size);
        }

        this.segment_limits[reg_cs] = info.effective_limit;
        this.segment_offsets[reg_cs] = info.base;

        //dbg_log("current esp: " + h(this.reg32s[reg_esp]), LOG_CPU);
        //dbg_log("call int " + h(interrupt_nr >>> 0, 8) + 
        //        " from " + h(this.instruction_pointer >>> 0, 8) + 
        //        " to " + h(base >>> 0) + 
        //        " if=" + +!!(is_trap && this.flags & flag_interrupt) + 
        //        " error_code=" + error_code, LOG_CPU);

        this.instruction_pointer = this.get_seg(reg_cs) + base | 0;
        
        //dbg_log("int" + h(interrupt_nr) + " trap=" + is_trap + " if=" + +!!(this.flags & flag_interrupt));
    
        if(!is_trap)
        {
            // clear int flag for interrupt gates
            this.flags &= ~flag_interrupt;
        }
        else
        {
            this.handle_irqs();
        }
    }
    else
    {
        // call 4 byte cs:ip interrupt vector from ivt at cpu.memory 0
        
        //debug.logop(this.instruction_pointer, "callu " + h(interrupt_nr) + "." + h(this.memory.read8(ah)));
        //dbg_log("callu " + h(interrupt_nr) + "." + 
        //        h(this.memory.read8(ah)) + " at " + h(this.instruction_pointer, 8), LOG_CPU, LOG_CPU);

        // push flags, cs:ip
        this.load_eflags();
        this.push16(this.flags);
        this.push16(this.sreg[reg_cs]);
        this.push16(this.get_real_eip());

        this.flags = this.flags & ~flag_interrupt;

        this.switch_seg(reg_cs, this.memory.read16((interrupt_nr << 2) + 2));
        this.instruction_pointer = this.get_seg(reg_cs) + this.memory.read16(interrupt_nr << 2) | 0;
    }

    this.last_instr_jump = true;
};

CPU.prototype.iret16 = function()
{
    if(!this.protected_mode || (this.vm86_mode() && this.getiopl() === 3))
    {
        var ip = this.pop16();

        this.switch_seg(reg_cs, this.pop16());
        var new_flags = this.pop16();

        this.instruction_pointer = ip + this.get_seg(reg_cs) | 0;
        this.update_eflags(new_flags);

        this.handle_irqs();
    } 
    else
    {
        if(this.vm86_mode()) 
        {
            // vm86 mode, iopl != 3
            this.trigger_gp(0);
        }

        throw this.debug.unimpl("16 bit iret in protected mode");
    }

    this.last_instr_jump = true;
};

CPU.prototype.iret32 = function()
{
    if(!this.protected_mode || (this.vm86_mode() && this.getiopl() === 3))
    {
        if(this.vm86_mode()) dbg_log("iret in vm86 mode  iopl=3", LOG_CPU);

        var ip = this.pop32s();

        this.switch_seg(reg_cs, this.pop32s() & 0xFFFF);
        var new_flags = this.pop32s();

        this.instruction_pointer = ip + this.get_seg(reg_cs) | 0;
        this.update_eflags(new_flags);

        this.handle_irqs();
        return;
    }

    if(this.vm86_mode()) 
    {
        // vm86 mode, iopl != 3
        this.trigger_gp(0);
    }

    if(this.flags & flag_nt)
    {
        if(DEBUG) throw this.debug.unimpl("nt");
    }

    //dbg_log("pop eip from " + h(this.reg32[reg_esp], 8));
    this.instruction_pointer = this.pop32s();

    //dbg_log("IRET | from " + h(this.previous_ip >>> 0) + " to " + h(this.instruction_pointer >>> 0));
    //this.debug.dump_regs_short();

    this.sreg[reg_cs] = this.pop32s();

    var new_flags = this.pop32s();

    if(new_flags & flag_vm)
    {
        if(this.cpl === 0)
        {
            // return to virtual 8086 mode

            this.update_eflags(new_flags);
            this.flags |= flag_vm;

            dbg_log("in vm86 mode now " + 
                    " cs:eip=" + h(this.sreg[reg_cs]) + ":" + h(this.instruction_pointer >>> 0) +
                    " iopl=" + this.getiopl(), LOG_CPU);

            this.switch_seg(reg_cs, this.sreg[reg_cs]);
            this.instruction_pointer = this.instruction_pointer + this.get_seg(reg_cs) | 0;

            var temp_esp = this.pop32s();
            var temp_ss = this.pop32s();

            this.switch_seg(reg_es, this.pop32s() & 0xFFFF);
            this.switch_seg(reg_ds, this.pop32s() & 0xFFFF);
            this.switch_seg(reg_fs, this.pop32s() & 0xFFFF);
            this.switch_seg(reg_gs, this.pop32s() & 0xFFFF);

            this.reg32s[reg_esp] = temp_esp;
            this.switch_seg(reg_ss, temp_ss & 0xFFFF);

            this.cpl = 3;
            this.update_cs_size(false);

            this.debug.dump_regs_short();

            return;
        }
        else
        {
            // ignored if not cpl=0
            new_flags &= ~flag_vm;
        }
    }

    // protected mode return

    var info = this.lookup_segment_selector(this.sreg[reg_cs]);

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
        var temp_esp = this.pop32s();
        var temp_ss = this.pop32s();


        this.reg32s[reg_esp] = temp_esp;

        this.update_eflags(new_flags);

        this.cpl = info.rpl;
        this.switch_seg(reg_ss, temp_ss & 0xFFFF);

        //dbg_log("iret cpu.cpl=" + this.cpl + " to " + h(this.instruction_pointer) + 
        //        " cs:eip=" + h(this.sreg[reg_cs],4) + ":" + h(this.get_real_eip(), 8) +
        //        " ss:esp=" + h(temp_ss & 0xFFFF, 2) + ":" + h(temp_esp, 8), LOG_CPU);

        this.cpl_changed();
    }
    else
    {
        this.update_eflags(new_flags);
        // same privilege return

        //dbg_log(h(new_flags) + " " + h(this.flags));
        //dbg_log("iret to " + h(this.instruction_pointer));
    }

    dbg_assert(typeof info.size === "boolean");
    if(info.size !== this.is_32)
    {
        this.update_cs_size(info.size);
    }

    this.segment_limits[reg_cs] = info.effective_limit;
    this.segment_offsets[reg_cs] = info.base;

    this.instruction_pointer = this.instruction_pointer + this.get_seg(reg_cs) | 0;


    //dbg_log("iret if=" + (this.flags & flag_interrupt) + " cpl=" + this.cpl + " eip=" + h(this.instruction_pointer >>> 0, 8), LOG_CPU);

    this.handle_irqs();
    this.last_instr_jump = true;
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
    if(DEBUG && interrupt_nr !== 7)
    {
        // show interesting exceptions
        dbg_log("Exception " + h(interrupt_nr), LOG_CPU);
        dbg_trace(LOG_CPU);
        this.debug.dump_regs_short();
    }

    this.call_interrupt_vector(interrupt_nr, false, false);
    throw MAGIC_CPU_EXCEPTION;
};

CPU.prototype.raise_exception_with_code = function(interrupt_nr, error_code)
{
    if(DEBUG)
    {
        dbg_log("Exception " + h(interrupt_nr) + " err=" + h(error_code), LOG_CPU);
        dbg_trace(LOG_CPU);
        this.debug.dump_regs_short();
    }

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

/**
 * @param {number} seg
 */
CPU.prototype.seg_prefix = function(seg)
{
    dbg_assert(this.segment_prefix === SEG_PREFIX_NONE);
    dbg_assert(seg >= 0 && seg <= 5);

    this.segment_prefix = seg;
    this.table[this.read_imm8()](this);
    this.segment_prefix = SEG_PREFIX_NONE;
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
    dbg_assert(this.protected_mode || (this.sreg[segment] << 4) == this.segment_offsets[segment]);
    
    if(this.protected_mode)
    {
        if(this.segment_is_null[segment])
        {
            // trying to access null segment
            if(DEBUG)
            {
                dbg_log("Load null segment: " + h(segment), LOG_CPU);
                throw this.debug.unimpl("#GP handler");
            }
        }

        // TODO: 
        // - validate segment limits
        // - validate if segment is writable
        // - set accessed bit
    }

    return this.segment_offsets[segment];
};

CPU.prototype.handle_irqs = function()
{
    if(this.devices.pic)
    {
        dbg_assert(!this.page_fault);

        if((this.flags & flag_interrupt) && !this.page_fault)
        {
            this.devices.pic.check_irqs();
        }
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
            var iomap_base = this.memory.read16(this.translate_address_system_read(tsr_offset + 0x64 + 2)),
                high_port = port + size - 1;

            if(tsr_size >= iomap_base + (high_port >> 3))
            {
                var mask = ((1 << size) - 1) << (port & 7),
                    addr = this.translate_address_system_read(tsr_offset + iomap_base + (port >> 3)),
                    port_info = (mask & 0xFF00) ? 
                        this.memory.read16(addr) : this.memory.read8(addr);

                if(!(port_info & mask))
                {
                    return;
                }
            }
        }

        dbg_log("#GP for port io  port=" + h(port) + " size=" + size, LOG_CPU);
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
    
    switch(this.reg32s[reg_eax])
    {
        case 0:
            // maximum supported level
            eax = 5;

            ebx = 0x756E6547|0; // Genu
            edx = 0x49656E69|0; // ineI
            ecx = 0x6C65746E|0; // ntel
            break;

        case 1:
            // pentium
            eax = 3 | 6 << 4 | 15 << 8;
            ebx = 0;
            ecx = 1 << 23; // popcnt
            edx = (this.fpu ? 1 : 0) |                // fpu
                    1 << 1 | 1 << 3 | 1 << 4 | 1 << 5 |   // vme, pse, tsc, msr
                    1 << 8 | 1 << 11 | 1 << 13 | 1 << 15; // cx8, sep, pge, cmov
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
                    eax = 0x0c000121; 
                    ebx = 0x01c0003f; 
                    ecx = 0x0000003f; 
                    edx = 0x00000001;
                    break;
                case 1:
                    eax = 0x0c000122; 
                    ebx = 0x01c0003f; 
                    ecx = 0x0000003f; 
                    edx = 0x00000001;
                    break
                case 2:
                    eax = 0x0c004143; 
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
        this.table0F = this.table0F_32;
    }
    else
    {
        this.table = this.table16;
        this.table0F = this.table0F_16;
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

        // limit after applying granularity
        effective_limit: 0,

        is_writable: false,
        is_readable: false,
        table_offset: 0,
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

    info.base = this.memory.read16(table_offset + 2) | this.memory.read8(table_offset + 4) << 16 | 
            this.memory.read8(table_offset + 7) << 24,
    info.access = this.memory.read8(table_offset + 5),
    info.flags = this.memory.read8(table_offset + 6) >> 4,

    // used if system
    info.type = info.access & 0xF;

    info.dpl = info.access >> 5 & 3;

    info.is_system = (info.access & 0x10) === 0;
    info.is_present = (info.access & 0x80) === 0x80;
    info.is_executable = (info.access & 8) === 8;

    info.rw_bit = (info.access & 2) === 2;
    info.dc_bit = (info.access & 4) === 4;

    info.size = (info.flags & 4) === 4;

    var limit = this.memory.read16(table_offset) | 
                (this.memory.read8(table_offset + 6) & 0xF) << 16;

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

    if(reg === reg_cs)
    {
        this.protected_mode = (this.cr0 & CR0_PE) === CR0_PE;
    }

    if(!this.protected_mode || this.vm86_mode())
    {
        this.sreg[reg] = selector;
        this.segment_is_null[reg] = 0;
        this.segment_limits[reg] = 0xFFFFF;
        this.segment_offsets[reg] = selector << 4;
        return;
    }

    var info = this.lookup_segment_selector(selector);

    if(reg === reg_ss)
    {
        if(info.is_null)
        {
            this.trigger_gp(0);
            return false;
        }
        if(!info.is_valid || 
                info.is_system ||
                info.rpl !== this.cpl ||
                !info.is_writable ||
                info.dpl !== this.cpl)
        {
            this.trigger_gp(selector & ~3);
            return false;
        }
        if(!info.is_present)
        {
            this.trigger_ss(selector & ~3);
            return false;
        }

        this.stack_size_32 = info.size;

        if(info.size)
        {
            this.stack_reg = this.reg32s;
            this.reg_vsp = reg_esp;
            this.reg_vbp = reg_ebp;
        }
        else
        {
            this.stack_reg = this.reg16;
            this.reg_vsp = reg_sp;
            this.reg_vbp = reg_bp;
        }
    }
    else if(reg === reg_cs)
    {
        if(!info.is_executable)
        {
            // cs not executable
            dbg_log(info + " " + h(selector & ~3), LOG_CPU);
            throw this.debug.unimpl("#GP handler");
        }

        if(info.is_system)
        {
            dbg_log(info + " " + h(selector & ~3), LOG_CPU);
            throw this.debug.unimpl("load system segment descriptor, type = " + (info.access & 15));
        }

        //if(info.dc_bit && (info.dpl !== info.rpl))
        //{
        //    dbg_log(info + " " + h(selector & ~3), LOG_CPU);
        //    throw this.debug.unimpl("#GP handler");
        //}

        if(info.rpl !== this.cpl)
        {
            dbg_log(info + " " + h(selector & ~3), LOG_CPU);
            throw this.debug.unimpl("privilege change");
        }

        dbg_assert(this.cpl === info.dpl);

        if(!info.dc_bit && info.dpl < this.cpl)
        {
            throw this.debug.unimpl("inter privilege call");
        }
        else
        {
            if(info.dc_bit || info.dpl === this.cpl)
            {
                // ok
            }
            else
            {
                // PE = 1, interrupt or trap gate, nonconforming code segment, DPL > CPL
                dbg_log(info + " " + h(selector & ~3), LOG_CPU);
                throw this.debug.unimpl("#GP handler");
            }
        }

        dbg_assert(typeof info.size === "boolean");
        if(info.size !== this.is_32)
        {
            this.update_cs_size(info.size);
        }
    }
    else
    {
        // es, ds, fs, gs
        if(info.is_null)
        {
            this.sreg[reg] = selector;
            this.segment_is_null[reg] = 1;
            return true;
        }
        if(!info.is_valid || 
                info.is_system || 
                !info.is_readable ||
                ((!info.is_executable || !info.dc_bit) &&
                 info.rpl > info.dpl &&
                 this.cpl > info.dpl))
        {
            this.trigger_gp(selector & ~3);
            return false;
        }
        if(!info.is_present)
        {
            this.trigger_np(selector & ~3);
            return false;
        }
    }

    //dbg_log("seg " + reg + " " + h(info.base));

    this.segment_is_null[reg] = 0;
    this.segment_limits[reg] = info.effective_limit;
    //this.segment_infos[reg] = 0; // TODO
    
    if(OP_TRANSLATION && (reg === reg_ds || reg === reg_ss) && info.base !== this.segment_offsets[reg])
    {
        this.translator.clear_cache();
    }
    
    this.segment_offsets[reg] = info.base;

    this.sreg[reg] = selector;

    return true;
};

CPU.prototype.load_tr = function(selector)
{
    var info = this.lookup_segment_selector(selector);

    //dbg_log("load tr");

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

    if(info.type !== 9)
    {
        dbg_log("#GP | ltr: invalid type (type = " + info.type + ")");
        throw this.debug.unimpl("#GP handler");
    }


    this.segment_offsets[reg_tr] = info.base;
    this.segment_limits[reg_tr] = info.effective_limit;
    this.sreg[reg_tr] = selector;

    // mark task as busy
    this.memory.write8(info.table_offset + 5, this.memory.read8(info.table_offset + 5) | 2);

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

    //dbg_log("ldt at " + h(info.base) + "; (" + info.effective_limit + " bytes)");
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
    dbg_log("TLB full clear", LOG_CPU);

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
        page_dir_addr = (this.cr3 >>> 2) + (page >> 10),
        page_dir_entry = this.memory.mem32s[page_dir_addr],
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

        this.cr2 = addr;
        this.trigger_pagefault(for_writing, user, 0);

        // never reached as this.trigger_pagefault throws up
        dbg_assert(false);
    }

    if((page_dir_entry & 2) === 0)
    {
        can_write = false;

        if(for_writing && (user || (this.cr0 & CR0_WP)))
        {
            this.cr2 = addr;
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
            this.cr2 = addr;
            this.trigger_pagefault(for_writing, user, 1);
            dbg_assert(false);
        }
    }

    if(page_dir_entry & this.page_size_extensions)
    {
        // size bit is set

        // set the accessed and dirty bits
        this.memory.mem32s[page_dir_addr] = page_dir_entry | 0x20 | for_writing << 6;

        high = (page_dir_entry & 0xFFC00000) | (addr & 0x3FF000);
        global = page_dir_entry & 0x100;
    }
    else
    {
        var page_table_addr = ((page_dir_entry & 0xFFFFF000) >>> 2) + (page & 0x3FF),
            page_table_entry = this.memory.mem32s[page_table_addr];

        if((page_table_entry & 1) === 0)
        {
            //dbg_log("#PF not present table", LOG_CPU);
            this.cr2 = addr;
            this.trigger_pagefault(for_writing, user, 0);
            dbg_assert(false);
        }

        if((page_table_entry & 2) === 0)
        {
            can_write = false;

            if(for_writing && (user || (this.cr0 & CR0_WP)))
            {
                //dbg_log("#PF not writable page", LOG_CPU);
                this.cr2 = addr;
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
                this.cr2 = addr;
                this.trigger_pagefault(for_writing, user, 1);
                dbg_assert(false);
            }
        }

        // set the accessed and dirty bits
        this.memory.mem32s[page_dir_addr] = page_dir_entry | 0x20;
        this.memory.mem32s[page_table_addr] = page_table_entry | 0x20 | for_writing << 6;

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

    if(global && (this.cr4 & CR4_PGE))
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
        if((this.tlb_info[page + 1] & mask) === 0)
        {
            this.do_page_translation(addr + size - 1, 1, user);
        }
    }
};

CPU.prototype.trigger_pagefault = function(write, user, present)
{
    //dbg_log("page fault w=" + write + " u=" + user + " p=" + present + 
    //        " eip=" + h(this.previous_ip >>> 0, 8) +
    //        " cr2=" + h(this.cr2 >>> 0, 8), LOG_CPU);
    //dbg_trace(LOG_CPU);

    // likely invalid pointer reference 
    //if((this.cr2 >>> 0) < 0x100)
    //{
    //    throw "stop";
    //}

    if(this.page_fault)
    {
        dbg_trace(LOG_CPU);
        throw this.debug.unimpl("Double fault");
    }

    // invalidate tlb entry
    var page = this.cr2 >>> 12;

    this.tlb_info[page] = 0;
    this.tlb_info_global[page] = 0;

    this.instruction_pointer = this.previous_ip;
    this.page_fault = true;
    this.call_interrupt_vector(14, false, user << 2 | write << 1 | present);

    throw MAGIC_CPU_EXCEPTION;
};

