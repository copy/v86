"use strict";

#define read_imm16s() (read_imm16() << 16 >> 16)
#define read_imm32() (read_imm32s() >>> 0)

#define safe_read8s(addr) (safe_read8(addr) << 24 >> 24)
#define safe_read16s(addr) (safe_read16(addr) << 16 >> 16)
#define safe_read32(addr) (safe_read32s(addr) >>> 0)

var debug = {};


/** @constructor */
function v86()
{

var cpu = this;

this.run = function() 
{
    if(!running)
    {
        setTimeout(cpu_run, 0);
    }
}

this.stop = cpu_stop;
this.init = cpu_init;
this.restart = cpu_restart;

this.dev = {};

this.instr_counter = 0;


var
    segment_is_null,
    segment_offsets,
    segment_limits,
    segment_infos,

    /*
     * Translation Lookaside Buffer 
     */
    tlb_user_read,
    tlb_user_write,
    tlb_system_read,
    tlb_system_write,

    /*
     * Information about which pages are cached in the tlb.
     * By bit:
     *   0 system, read
     *   1 system, write
     *   2 user, read
     *   3 user, write
     */
    tlb_info,

    /*
     * Same as tlb_info, except it only contains global pages
     */
    tlb_info_global,

    /** 
     * Wheter or not in protected mode
     * @type {boolean} 
     */
    protected_mode,

    /** 
     * interrupt descriptor table
     * @type {number}
     */
    idtr_size,
    /** @type {number} */
    idtr_offset,

    /** 
     * global descriptor table register
     * @type {number}
     */
    gdtr_size,
    /** @type {number} */
    gdtr_offset,

    /** 
     * local desciptor table
     * @type {number}
     */
    ldtr_size,
    /** @type {number} */
    ldtr_offset,

    /**
     * task register 
     * @type {number} 
     */
    tsr_size,
    /** @type {number} */
    tsr_offset,

    /*
     * whether or not a page fault occured
     */
    page_fault,

    /** @type {number} */
    cr0,
    /** @type {number} */
    cr2,
    /** @type {number} */
    cr3,
    /** @type {number} */
    cr4,

    // current privilege level
    /** @type {number} */
    cpl,

    // paging enabled
    /** @type {boolean} */
    paging,

    // if false, pages are 4 KiB, else 4 Mib
    /** @type {number} */
    page_size_extensions,

    // current operand/address/stack size
    /** @type {boolean} */
    is_32,
    /** @type {boolean} */
    operand_size_32,
    /** @type {boolean} */
    stack_size_32,

    /** 
     * Cycles since last cpu reset, used by rdtsc instruction
     * @type {number}
     */
    cpu_timestamp_counter,

    /** @type {number} */
    previous_ip,

    /** 
     * wheter or not in step mode
     * used for debugging
     * @type {boolean}
     */
    step_mode,

    /**
     * was the last instruction a hlt
     * @type {boolean}
     */
    in_hlt,

    /** @type {VGAScreen} */
    vga,

    /** @type {PS2} */
    ps2,

    /** 
     * Programmable interval timer
     * @type {PIT}
     */
    timer,


    /** 
     * Real Time Clock
     * @type {RTC}
     */
    rtc,

    /**
     * Floppy Disk controller
     * @type {FloppyController}
     */
    fdc,

    /**
     * Serial controller
     * @type {UART}
     */
    uart,

    /** @type {boolean} */
    running,

    /** @type {boolean} */
    stopped,

    /** @type {number} */
    loop_counter,

    /** @type {Memory} */
    memory,

    /** @type {(FPU|NoFPU)} */
    fpu,

    /**
     * @type {HPET}
     */
    hpet,

    /**
     * Programmable interrupt controller
     * @type {PIC}
     */
    pic,

    /**
     * @type {IO}
     */
    io,

    /**
     * @type {PCI}
     */
    pci,

    /**
     * @type {IDEDevice}
     */
    cdrom,

    /**
     * @type {IDEDevice}
     */
    hda,

    /**
     * @type {IDEDevice}
     */
    hdb,

    /**
     * Direct Memory Access Controller
     * @type {DMA}
     */
    dma,

    translate_address_read,
    translate_address_write,

    ops,

    /** @type {boolean} */
    address_size_32,

    /** @type {number} */
    instruction_pointer,

    /** @type {number} */
    last_virt_eip,

    /** @type {number} */
    eip_phys,

    /** @type {number} */
    last_virt_esp,

    /** @type {number} */
    esp_phys,


    // current state of prefixes
    segment_prefix,


    /** @type {boolean} */
    repeat_string_prefix,

    /** @type {boolean} */
    repeat_string_type,

    /** @type {number} */
    last_result,

    /** @type {number} */
    flags,

    /** 
     * bitmap of flags which are not updated in the flags variable
     * changed by arithmetic instructions, so only relevant to arithmetic flags
     * @type {number}
     */
    flags_changed,

    /** 
     * the last 2 operators and the result and size of the last arithmetic operation
     * @type {number} 
     */
    last_op1,
    /** @type {number} */
    last_op2,
    /** @type {number} */
    last_op_size,


    // registers
    reg32,
    reg32s,
    reg16,
    reg16s,
    reg8,
    reg8s,

    sreg,

    
    // sp or esp, depending on stack size attribute
    stack_reg,
    reg_vsp,
    reg_vbp,

    // reg16 or reg32, depending on address size attribute
    regv,
    reg_vcx,
    reg_vsi,
    reg_vdi,

    // functions that are set depending on whether paging is enabled or not
    read_imm8,
    read_imm8s,
    read_imm16,
    read_imm32s,

    safe_read8,
    safe_read16,
    safe_read32s,

    get_esp_read,
    get_esp_write,


    table,
    table0F,

    modrm_resolve,


    current_settings
;


function cpu_run()
{
    if(stopped)
    {
        stopped = running = false;
        return;
    }

    running = true;

    try {
        do_run();
    }
    catch(e)
    {
        if(e === 0xDEADBEE)
        {
            // A legit CPU exception (for instance, a page fault happened)
            // call_interrupt_vector has already been called at this point,
            // so we just need to reset some state

            page_fault = false;
            repeat_string_prefix = false;
            segment_prefix = -1;
            
            address_size_32 = is_32;
            update_address_size();
            operand_size_32 = is_32;
            update_operand_size();

            cpu.instr_counter = cpu_timestamp_counter;

            next_tick();
        }
        else
        {
            console.log(e);
            console.log(e.stack);
            throw e;
        }
    }
};

function cpu_stop()
{
    if(running)
    {
        stopped = true;
    }
}

function cpu_restart()
{
    var was_running = running;

    stopped = true;
    running = false;

    setTimeout(function()
    {
        ps2.destroy();
        vga.destroy();

        cpu_init(current_settings);

        if(was_running)
        {
            cpu_run();
        }
    }, 10);
}

function cpu_reboot_internal()
{
    dbg_assert(running);

    ps2.destroy();
    vga.destroy();

    cpu_init(current_settings);

    throw 0xDEADBEE;
}

function cpu_init(settings)
{
    // see browser/main.js or node/main.js
    if(typeof set_tick !== "undefined")
    {
        set_tick(cpu_run);
    }

    current_settings = settings;

    cpu.memory = memory = new Memory(new ArrayBuffer(memory_size), memory_size); 

    segment_is_null = new Uint8Array(8);
    segment_limits = new Uint32Array(8);
    segment_infos = new Uint32Array(8);
    segment_offsets = new Int32Array(8);

    // 16 MB in total
    tlb_user_read = new Int32Array(1 << 20);
    tlb_user_write = new Int32Array(1 << 20);
    tlb_system_read = new Int32Array(1 << 20);
    tlb_system_write = new Int32Array(1 << 20);

    tlb_info = new Uint8Array(1 << 20);
    tlb_info_global = new Uint8Array(1 << 20);


    reg32 = new Uint32Array(8);
    reg32s = new Int32Array(reg32.buffer);
    reg16 = new Uint16Array(reg32.buffer);
    reg16s = new Int16Array(reg32.buffer);
    reg8  = new Uint8Array(reg32.buffer);
    reg8s  = new Int8Array(reg32.buffer);
    sreg = new Uint16Array(8);
    protected_mode = false;

    idtr_size = 0;
    idtr_offset = 0;

    gdtr_size = 0;
    gdtr_offset = 0;

    ldtr_size = 0;
    ldtr_offset = 0;

    tsr_size = 0;
    tsr_offset = 0;

    page_fault = false;
    cr0 = 0;
    cr2 = 0;
    cr3 = 0;
    cr4 = 0;
    cpl = 0;
    paging = false;
    page_size_extensions = 0;
    is_32 = false;
    operand_size_32 = false;
    stack_size_32 = false;
    address_size_32 = false;

    paging_changed();

    update_operand_size();
    update_address_size();

    stack_reg = reg16;
    reg_vsp = reg_sp;
    reg_vbp = reg_bp;

    cpu_timestamp_counter = 0;
    previous_ip = 0;
    step_mode = false;
    in_hlt = false;

    running = false;
    stopped = false;
    loop_counter = 20;

    translate_address_read = translate_address_disabled;
    translate_address_write = translate_address_disabled;

    segment_prefix = -1;
    repeat_string_prefix = false;
    last_result = 0;
    flags = flags_default;
    flags_changed = 0;
    last_op1 = 0;
    last_op2 = 0;
    last_op_size = 0;



    if(settings.bios)
    {
        // load bios
        var data = new Uint8Array(settings.bios),
            start = 0x100000 - settings.bios.byteLength;

        memory.mem8.set(data, start);

        if(settings.vga_bios)
        {
            // load vga bios
            data = new Uint8Array(settings.vga_bios);
            memory.mem8.set(data, 0xC0000);
        }

        // seabios expects the bios to be mapped to 0xFFF00000 also
        memory.mmap_register(0xFFF00000, 0x100000, 1,
            function(addr)
            {
                return memory.mem8[addr];
            },
            function(addr, value)
            {
                memory.mem8[addr] = value;
            });


        // ip initial value
        instruction_pointer = 0xFFFF0;

        // ss and sp inital value
        switch_seg(reg_ss, 0x30);
        reg16[reg_sp] = 0x100;
    }
    else if(settings.linux)
    {
        instruction_pointer = 0x10000;

        memory.write_blob(new Uint8Array(settings.linux.vmlinux), 0x100000);
        memory.write_blob(new Uint8Array(settings.linux.linuxstart), instruction_pointer);

        if(settings.linux.root)
        {
            memory.write_blob(new Uint8Array(settings.linux.root), 0x00400000);
            reg32[reg_ebx] = settings.linux.root.byteLength;
        }

        memory.write_string(settings.linux.cmdline, 0xF800);

        reg32[reg_eax] = memory_size;
        reg32[reg_ecx] = 0xF800;

        switch_seg(reg_cs, 0);
        switch_seg(reg_ss, 0);
        switch_seg(reg_ds, 0);
        switch_seg(reg_es, 0);
        switch_seg(reg_gs, 0);
        switch_seg(reg_fs, 0);

        is_32 = true;
        address_size_32 = true;
        operand_size_32 = true;
        stack_size_32 = true;
        protected_mode = true;

        update_operand_size();
        update_address_size();

        regv = reg32;
        reg_vsp = reg_esp;
        reg_vbp = reg_ebp;

        cr0 = 1;
    }
    else
    {
        switch_seg(reg_ss, 0x30);
        reg16[reg_sp] = 0x100;

        instruction_pointer = 0;
    }


    cpu.dev = {};

    if(settings.load_devices)
    {
        var devapi = {
            memory: memory,   
            reboot: cpu_reboot_internal,
            time: function() { return performance.now(); },
        };

        devapi.io = cpu.dev.io = io = new IO();
        devapi.pic = pic = new PIC(devapi, call_interrupt_vector, handle_irqs);
        devapi.pci = pci = new PCI(devapi);
        devapi.dma = dma = new DMA(devapi);
 

        cpu.dev.vga = vga = new VGAScreen(devapi, settings.screen_adapter, VGA_MEMORY_SIZE)
        cpu.dev.ps2 = ps2 = new PS2(devapi, settings.keyboard_adapter, settings.mouse_adapter);
        
        //fpu = new NoFPU();
        fpu = new FPU(devapi);

        uart = new UART(devapi);

        cpu.dev.fdc = fdc = new FloppyController(devapi, settings.floppy_disk);

        if(settings.cdrom_disk)
        {
            cpu.dev.cdrom = cdrom = new IDEDevice(devapi, settings.cdrom_disk, true, 1);
        }

        if(settings.hda_disk)
        {
            cpu.dev.hda = hda = new IDEDevice(devapi, settings.hda_disk, false, 0);
        }
        //if(settings.hdb_disk)
        //{
        //    cpu.dev.hdb = hdb = new IDEDevice(devapi, settings.hdb_disk, false, 1);
        //}

        devapi.pit = timer = new PIT(devapi);
        devapi.rtc = rtc = new RTC(devapi, fdc.type);

        if(ENABLE_HPET)
        {
            hpet = new HPET(devapi);
        }
    }

    if(DEBUG)
    {
        // used for debugging 
        ops = new CircularQueue(30000);

        if(typeof window !== "undefined")
        {
            window.memory = memory;
            window.vga = vga;
        }

        if(io)
        {
            // write seabios debug output to console
            var seabios_debug = "";

            io.register_write(0x402, function(out_byte)
            {
                // seabios debug
                //
                if(out_byte === 10)
                {
                    dbg_log(seabios_debug, LOG_BIOS);
                    seabios_debug = "";
                }
                else
                {
                    seabios_debug += String.fromCharCode(out_byte);
                }
            });
        }
    }
}

function do_run()
{
    var 
        /** 
         * @type {number}
         */
        start = Date.now(),
        now;

    vga.timer(start);

    // outer loop:
    // runs cycles + timers
    for(var j = loop_counter; j--;)
    {
        now = Date.now();

        if(ENABLE_HPET)
        {
            timer.timer(now, hpet.legacy_mode);
            rtc.timer(now, hpet.legacy_mode);
            hpet.timer(now);
        }
        else
        {
            timer.timer(now, false);
            rtc.timer(now, false);
        }

        // inner loop:
        // runs only cycles
        for(var k = LOOP_COUNTER; k--;)
        {
            previous_ip = instruction_pointer;

            cpu_timestamp_counter++;
            cycle();
        }

    }

    cpu.instr_counter = cpu_timestamp_counter;

    if(now - start > TIME_PER_FRAME)
    {
        if(loop_counter > 1)
        {
            loop_counter--;
        }
    }
    else
    {
        loop_counter++;
    }

    next_tick();
}

// do_run must not be inlined into cpu_run, because then more code 
// is in the deoptimized try-catch. 
// This trick is a bit ugly, but it works without further complication.
if(typeof window !== "undefined")
{
    window.__no_inline = do_run;
}


/**
 * execute a single instruction cycle on the cpu
 * this includes reading all prefixes and the whole instruction
 */
function cycle()
{
    var opcode = read_imm8();

    logop(instruction_pointer - 1 >>> 0, opcode);

    // call the instruction
    table[opcode]();

    // TODO
    //if(flags & flag_trap)
    //{
    //    
    //}
}

cpu.cycle = function()
{
    table[read_imm8()]();
}

function cr0_changed()
{
    //protected_mode = (cr0 & 1) === 1;
    //dbg_log("cr0 = " + h(cr0));

    var new_paging = (cr0 & 0x80000000) !== 0;

    if(fpu.is_fpu)
    {
        cr0 &= ~4;
    }
    else
    {
        cr0 |= 4;
    }

    if(new_paging !== paging)
    {
        paging = new_paging;

        paging_changed();
    }
}

function paging_changed()
{
    var table = paging ? pe_functions : npe_functions;

    read_imm8 = table.read_imm8;
    read_imm8s = table.read_imm8s;
    read_imm16 = table.read_imm16;
    read_imm32s = table.read_imm32s;
    
    safe_read8 = table.safe_read8;
    safe_read16 = table.safe_read16;
    safe_read32s = table.safe_read32s;

    get_esp_read = table.get_esp_read;
    get_esp_write = table.get_esp_write;


    // set translate_address_* depending on cpl and paging
    cpl_changed();
}

function cpl_changed()
{
    last_virt_eip = -1;
    last_virt_esp = -1;

    if(!paging)
    {
        translate_address_write = translate_address_disabled;
        translate_address_read = translate_address_disabled;
    }
    else if(cpl)
    {
        translate_address_write = translate_address_user_write;
        translate_address_read = translate_address_user_read;
    }
    else
    {
        translate_address_write = translate_address_system_write;
        translate_address_read = translate_address_system_read;
    }
}


// functions that are used when paging is disabled
var npe_functions = {
    get_esp_read: get_esp_npe,
    get_esp_write: get_esp_npe,

    read_imm8: function()
    {
        return memory.mem8[instruction_pointer++];
    },

    read_imm8s: function()
    {
        return memory.mem8s[instruction_pointer++];
    },

    read_imm16 : function()
    {
        var data16 = memory.read16(instruction_pointer);
        instruction_pointer = instruction_pointer + 2 | 0;
        return data16;
    },

    read_imm32s : function()
    {
        var data32 = memory.read32s(instruction_pointer);
        instruction_pointer = instruction_pointer + 4 | 0;
        return data32;
    },

    safe_read8 : function(addr) { return memory.read8(addr) },
    safe_read16 : function(addr) { return memory.read16(addr); },
    safe_read32s : function(addr) { return memory.read32s(addr); },
};

// functions that are used when paging is enabled
var pe_functions = 
{
    get_esp_read: get_esp_pe_read,
    get_esp_write: get_esp_pe_write,

    read_imm8 : function()
    {
        if((instruction_pointer & ~0xFFF) ^ last_virt_eip)
        {
            eip_phys = translate_address_read(instruction_pointer) ^ instruction_pointer;
            last_virt_eip = instruction_pointer & ~0xFFF;
        }

        // memory.read8 inlined under the assumption that code never runs in 
        // memory-mapped io
        return memory.mem8[eip_phys ^ instruction_pointer++];
    },

    read_imm8s : function()
    {
        if((instruction_pointer & ~0xFFF) ^ last_virt_eip)
        {
            eip_phys = translate_address_read(instruction_pointer) ^ instruction_pointer;
            last_virt_eip = instruction_pointer & ~0xFFF;
        }

        return memory.mem8s[eip_phys ^ instruction_pointer++];
    },

    read_imm16 : function()
    {
        // Two checks in one comparison:
        //    1. Did the high 20 bits of eip change
        // or 2. Are the low 12 bits of eip 0xFFF (and this read crosses a page boundary)
        if((instruction_pointer ^ last_virt_eip) > 0xFFE)
        {
            return read_imm8() | read_imm8() << 8;
        }

        var data16 = memory.read16(eip_phys ^ instruction_pointer);
        instruction_pointer = instruction_pointer + 2 | 0;

        return data16;
    },


    read_imm32s : function()
    {
        // Analogue to the above comment
        if((instruction_pointer ^ last_virt_eip) > 0xFFC)
        {
            return read_imm16() | read_imm16() << 16;
        }

        var data32 = memory.read32s(eip_phys ^ instruction_pointer);
        instruction_pointer = instruction_pointer + 4 | 0;

        return data32;
    },

    safe_read8 : do_safe_read8,
    safe_read16 : do_safe_read16,
    safe_read32s : do_safe_read32s,
};


// read word from a page boundary, given 2 physical addresses
function virt_boundary_read16(low, high)
{
    dbg_assert((low & 0xFFF) === 0xFFF);
    dbg_assert((high & 0xFFF) === 0);

    return memory.read8(low) | memory.read8(high) << 8;
}

// read doubleword from a page boundary, given 2 addresses
function virt_boundary_read32s(low, high)
{
    dbg_assert((low & 0xFFF) >= 0xFFD);
    dbg_assert((high - 3 & 0xFFF) === (low & 0xFFF));

    var result = memory.read8(low) | memory.read8(high) << 24;

    if(low & 1)
    {
        if(low & 2)
        {
            // 0xFFF
            result |= memory.read8(high - 2) << 8 | 
                        memory.read8(high - 1) << 16;
        }
        else
        {
            // 0xFFD
            result |= memory.read8(low + 1) << 8 | 
                        memory.read8(low + 2) << 16;
        }
    }
    else
    {
        // 0xFFE
        result |= memory.read8(low + 1) << 8 | 
                    memory.read8(high - 1) << 16;
    }

    return result;
}

function virt_boundary_write16(low, high, value)
{
    dbg_assert((low & 0xFFF) === 0xFFF);
    dbg_assert((high & 0xFFF) === 0);

    memory.write8(low, value);
    memory.write8(high, value >> 8);
}

function virt_boundary_write32(low, high, value)
{
    dbg_assert((low & 0xFFF) >= 0xFFD);
    dbg_assert((high - 3 & 0xFFF) === (low & 0xFFF));

    memory.write8(low, value);
    memory.write8(high, value >> 24);

    if(low & 1)
    {
        if(low & 2)
        {
            // 0xFFF
            memory.write8(high - 2, value >> 8);
            memory.write8(high - 1, value >> 16);
        }
        else
        {
            // 0xFFD
            memory.write8(low + 1, value >> 8);
            memory.write8(low + 2, value >> 16);
        }
    }
    else
    {
        // 0xFFE
        memory.write8(low + 1, value >> 8);
        memory.write8(high - 1, value >> 16);
    }
}

// safe_read, safe_write
// read or write byte, word or dword to the given *virtual* address,
// and be safe on page boundaries

function do_safe_read8(addr)
{
    return memory.read8(translate_address_read(addr));
}

function do_safe_read16(addr)
{
    if((addr & 0xFFF) === 0xFFF)
    {
        return safe_read8(addr) | safe_read8(addr + 1) << 8;
    }
    else
    {
        return memory.read16(translate_address_read(addr));
    }
}

function do_safe_read32s(addr)
{
    if((addr & 0xFFF) >= 0xFFD)
    {
        return safe_read16(addr) | safe_read16(addr + 2) << 16;
    }
    else
    {
        return memory.read32s(translate_address_read(addr));
    }
}

function safe_write8(addr, value)
{
    memory.write8(translate_address_write(addr), value);
}

function safe_write16(addr, value)
{
    var phys_low = translate_address_write(addr);

    if((addr & 0xFFF) === 0xFFF)
    {
        virt_boundary_write16(phys_low, translate_address_write(addr + 1), value);
    }
    else
    {
        memory.write16(phys_low, value);
    }
}

function safe_write32(addr, value)
{
    var phys_low = translate_address_write(addr);

    if((addr & 0xFFF) >= 0xFFD)
    {
        virt_boundary_write32(phys_low, translate_address_write(addr + 3), value);
    }
    else
    {
        memory.write32(phys_low, value);
    }
}

// read 2 or 4 byte from ip, depending on address size attribute
function read_moffs()
{
    if(address_size_32)
    {
        return get_seg_prefix(reg_ds) + read_imm32s();
    }
    else
    {
        return get_seg_prefix(reg_ds) + read_imm16();
    }
}

function get_flags()
{
    return (flags & ~flags_all) | getcf() | getpf() | getaf() | getzf() | getsf() | getof();
}

function load_flags()
{
    flags = get_flags();
    flags_changed = 0;
}

// get esp with paging disabled
function get_esp_npe(mod)
{
    if(stack_size_32)
    {
        return get_seg(reg_ss) + stack_reg[reg_vsp] + mod;
    }
    else
    {
        return get_seg(reg_ss) + (stack_reg[reg_vsp] + mod & 0xFFFF);
    }
}

function get_esp_pe_read(mod)
{
    // UNSAFE: stack_reg[reg_vsp]+mod needs to be masked in 16 bit mode 
    //   (only if paging is enabled and in 16 bit mode)

    return translate_address_read(get_seg(reg_ss) + stack_reg[reg_vsp] + mod);
}

function get_esp_pe_write(mod)
{
    return translate_address_write(get_seg(reg_ss) + stack_reg[reg_vsp] + mod);
}


/*
 * returns the "real" instruction pointer, 
 * without segment offset
 */
function get_real_ip()
{
    return instruction_pointer - get_seg(reg_cs);
}

function call_interrupt_vector(interrupt_nr, is_software_int, error_code)
{
    if(DEBUG)
    {
        ops.add(instruction_pointer);
        ops.add("-- INT " + h(interrupt_nr));
        ops.add(1);
    }

    //if(interrupt_nr == 0x13)
    //{
    //    dbg_log("INT 13");
    //    dbg_log(memory.read8(ch) + "/" + memory.read8(dh) + "/" + memory.read8(cl) + "   |" + memory.read8(al));
    //    dbg_log("=> ", h(memory.read16(es) * 16 + memory.read16(bx)));
    //}


    //if(interrupt_nr == 0x10)
    //{
    //    dbg_log("int10 ax=" + h(reg16[reg_ax], 4) + " '" + String.fromCharCode(reg8[reg_al]) + "'"); 
    //    dump_regs_short();
    //    if(reg8[reg_ah] == 0xe) vga.tt_write(reg8[reg_al]);
    //}

    //dbg_log("int " + h(interrupt_nr));

    //if(interrupt_nr === 0x13)
    //{
    //    dump_regs_short();
    //}

    //if(interrupt_nr === 0x80)
    //{
    //    dbg_log("linux syscall");
    //    dump_regs_short();
    //}


    //if(interrupt_nr === 14)
    //{
    //    dbg_log("int14 error_code=" + error_code + " cr2=" + h(cr2) + " prev=" + h(previous_ip) + " cpl=" + cpl, LOG_CPU);
    //}


    if(in_hlt)
    {
        // return to the instruction following the hlt
        instruction_pointer++;
        in_hlt = false;
    }

    if(protected_mode)
    {
        if((interrupt_nr << 3 | 7) > idtr_size)
        {
            dbg_log(interrupt_nr, LOG_CPU);
            dbg_trace();
            throw unimpl("#GP handler");
        }


        var addr = idtr_offset + (interrupt_nr << 3) | 0;
        dbg_assert((addr & 0xFFF) < 0xFF8);

        if(paging)
        {
            addr = translate_address_system_read(addr);
        }

        var base = memory.read16(addr) | memory.read16(addr + 6) << 16,
            selector = memory.read16(addr + 2),
            type = memory.read8(addr + 5),
            dpl = type >> 5 & 3,
            is_trap;

        if((type & 128) === 0)
        {
            // present bit not set
            throw unimpl("#NP handler");
        }

        if(is_software_int && dpl < cpl)
        {
            trigger_gp(interrupt_nr << 3 | 2);
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
            throw unimpl("call int to task gate");
        }
        else if(type === 6)
        {
            throw unimpl("16 bit interrupt gate");
        }
        else if(type === 7)
        {
            throw unimpl("16 bit trap gate");
        }
        else
        {
            // invalid type
            dbg_trace();
            dbg_log("invalid type: " + h(type));
            dbg_log(h(addr) + " " + h(base) + " " + h(selector));
            throw unimpl("#GP handler");
        }

        var info = lookup_segment_selector(selector);

        if(info.is_null)
        {
            dbg_log("is null");
            throw unimpl("#GP handler");
        }
        if(info === -1)
        {
            dbg_log("is -1");
            throw unimpl("#GP handler");
        }
        if(!info.is_executable || info.dpl > cpl)
        {
            dbg_log("not exec");
            throw unimpl("#GP handler");
        }
        if(!info.is_present)
        {
            dbg_log("not present");
            throw unimpl("#NP handler");
        }

        if(flags & flag_vm)
        {
            throw unimpl("VM flag");
        }
            

        if(!info.dc_bit && info.dpl < cpl)
        {
            // inter privilege level interrupt

            var tss_stack_addr = (info.dpl << 3) + 4;

            if(tss_stack_addr + 5 > tsr_size)
            {
                throw unimpl("#TS handler");
            }

            tss_stack_addr += tsr_offset;
            
            if(paging)
            {
                tss_stack_addr = translate_address_system_read(tss_stack_addr);
            }

            var new_esp = memory.read32s(tss_stack_addr),
                new_ss = memory.read16(tss_stack_addr + 4),
                ss_info = lookup_segment_selector(new_ss);

            if(ss_info.is_null)
            {
                throw unimpl("#TS handler");
            }
            if(ss_info.rpl !== info.dpl)
            {
                throw unimpl("#TS handler");
            }
            if(ss_info.dpl !== info.dpl || !ss_info.rw_bit)
            {
                throw unimpl("#TS handler");
            }
            if(!ss_info.is_present)
            {
                throw unimpl("#TS handler");
            }

            var old_esp = reg32s[reg_esp],
                old_ss = sreg[reg_ss];

            reg32[reg_esp] = new_esp;
            sreg[reg_ss] = new_ss;

            cpl = info.dpl;
            //dbg_log("int" + h(interrupt_nr, 2) +" from=" + h(instruction_pointer, 8) 
            //        + " cpl=" + cpl + " old ss:esp=" + h(old_ss,4) + ":" + h(old_esp,8), LOG_CPU);

            cpl_changed();

            push32(old_ss);
            push32(old_esp);
        }
        else if(info.dc_bit || info.dpl === cpl)
        {
            // intra privilege level interrupt

            //dbg_log("int" + h(interrupt_nr, 2) +" from=" + h(instruction_pointer, 8), LOG_CPU);
        }


        load_flags();
        push32(flags);

        push32(sreg[reg_cs]);
        push32(get_real_ip());
        //dbg_log("pushed eip to " + h(reg32[reg_esp], 8), LOG_CPU);


        if(error_code !== false)
        {
            dbg_assert(typeof error_code == "number");
            push32(error_code);
        }
        

        // TODO
        sreg[reg_cs] = selector;
        //switch_seg(reg_cs);

        //dbg_log("current esp: " + h(reg32[reg_esp]), LOG_CPU);
        //dbg_log("call int " + h(interrupt_nr) + " from " + h(instruction_pointer) + " to " + h(base) + " with error_code=" + error_code, LOG_CPU);

        instruction_pointer = get_seg(reg_cs) + base | 0;
        
        //dbg_log("int" + h(interrupt_nr) + " trap=" + is_trap + " if=" + +!!(flags & flag_interrupt));
    
        if(!is_trap)
        {
            // clear int flag for interrupt gates
            flags &= ~flag_interrupt;
        }
        else
        {
            handle_irqs();
        }
    }
    else
    {
        // call 4 byte cs:ip interrupt vector from ivt at memory 0
        
        //logop(instruction_pointer, "callu " + h(interrupt_nr) + "." + h(memory.read8(ah)));
        //dbg_log("callu " + h(interrupt_nr) + "." + h(memory.read8(ah)) + " at " + h(instruction_pointer, 8), LOG_CPU, LOG_CPU);

        // push flags, cs:ip
        load_flags();
        push16(flags);
        push16(sreg[reg_cs]);
        push16(get_real_ip());

        flags = flags & ~flag_interrupt;

        switch_seg(reg_cs, memory.read16((interrupt_nr << 2) + 2));
        instruction_pointer = get_seg(reg_cs) + memory.read16(interrupt_nr << 2) | 0;
    }
}

// assumes ip to point to the byte before the next instruction
function raise_exception(interrupt_nr)
{
    if(DEBUG)
    {
        // warn about error
        dbg_log("Exception " + h(interrupt_nr), LOG_CPU);
        dbg_trace();
        //throw "exception: " + interrupt_nr;
    }


    // TODO

    call_interrupt_vector(interrupt_nr, false, false);
    throw 0xDEADBEE;
}

function raise_exception_with_code(interrupt_nr, error_code)
{
    if(DEBUG)
    {
        dbg_log("Exception " + h(interrupt_nr) + " err=" + h(error_code), LOG_CPU);
        dbg_trace();
        //throw "exception: " + interrupt_nr;
    }

    call_interrupt_vector(interrupt_nr, false, error_code);
    throw 0xDEADBEE;
}

function trigger_de()
{
    instruction_pointer = previous_ip;
    raise_exception(0);
}

function trigger_ud()
{
    instruction_pointer = previous_ip;
    raise_exception(6);
}

function trigger_gp(code)
{
    instruction_pointer = previous_ip;
    raise_exception_with_code(13, code);
}

function trigger_np(code)
{
    instruction_pointer = previous_ip;
    raise_exception_with_code(11, code);
}

function trigger_ss(code)
{
    instruction_pointer = previous_ip;
    raise_exception_with_code(12, code);
}


/**
 * @param {number} seg
 */
function seg_prefix(seg)
{
    dbg_assert(segment_prefix === -1);
    dbg_assert(seg >= 0 && seg <= 5);

    segment_prefix = seg;
    table[read_imm8()]();
    segment_prefix = -1;
}

/**
 * Get segment base by prefix or default
 * @param {number} default_segment
 */
function get_seg_prefix(default_segment /*, offset*/)
{
    if(segment_prefix === -1)
    {
        return get_seg(default_segment /*, offset*/);
    }
    else
    {
        return get_seg(segment_prefix /*, offset*/);
    }
}

/**
 * Get segment base
 * @param {number} segment
 */
function get_seg(segment /*, offset*/)
{
    dbg_assert(segment >= 0 && segment < 8);
    dbg_assert(protected_mode || (sreg[segment] << 4) == segment_offsets[segment]);
    
    if(protected_mode)
    {
        if(segment_is_null[segment])
        {
            // trying to access null segment
            if(DEBUG)
            {
                dbg_log("Load null segment: " + h(segment), LOG_CPU);
                throw unimpl("#GP handler");
            }
        }

        // TODO: 
        // - validate segment limits
        // - validate if segment is writable
        // - set accessed bit
    }

    return segment_offsets[segment];
}

function arpl(seg, r16)
{
    flags_changed &= ~flag_zero;

    if((seg & 3) < (reg16[r16] & 3))
    {
        flags |= flag_zero;
        return seg & ~3 | reg16[r16] & 3;
    }
    else
    {
        flags &= ~flag_zero;
        return seg;
    }
}


function handle_irqs()
{
    if(pic)
    {
        if((flags & flag_interrupt) && !page_fault)
        {
            pic.handle_irqs();
        }
    }
}

/**
 * returns the current iopl from the eflags register
 */
function getiopl()
{
    return flags >> 12 & 3;
}

function test_privileges_for_io()
{
    if(protected_mode && (cpl > getiopl() || (flags & flag_vm)))
    {
        // TODO: IO bit fields
        dbg_log("#GP for port io", LOG_CPU);
        trigger_gp(0);
    }
}

function cpuid()
{
    // cpuid
    // TODO: Fill in with less bogus values
    
    // http://lxr.linux.no/linux+%2a/arch/x86/include/asm/cpufeature.h
    
    var id = reg32s[reg_eax];
    
    if((id & 0x7FFFFFFF) === 0)
    {
        reg32[reg_eax] = 2;

        if(id === 0)
        {
            reg32[reg_ebx] = 0x756E6547; // Genu
            reg32[reg_edx] = 0x49656E69; // ineI
            reg32[reg_ecx] = 0x6C65746E; // ntel
        }
    }
    else if(id === 1)
    {
        // pentium
        reg32[reg_eax] = 0x513;
        reg32[reg_ebx] = 0;
        reg32[reg_ecx] = 0;
        reg32[reg_edx] = fpu.is_fpu | 1 << 3 | 1 << 4 | 1 << 8 | 1 << 13 | 1 << 15;
    }
    else if(id === 2)
    {
        // Taken from http://siyobik.info.gf/main/reference/instruction/CPUID
        reg32[reg_eax] = 0x665B5001;
        reg32[reg_ebx] = 0;
        reg32[reg_ecx] = 0;
        reg32[reg_edx] = 0x007A7000;
    }
    else if(id === (0x80860000 | 0))
    {
        reg32[reg_eax] = 0;
        reg32[reg_ebx] = 0;
        reg32[reg_ecx] = 0;
        reg32[reg_edx] = 0;
    }
    else if((id & 0xF0000000) === ~~0x40000000)
    {
        // Invalid
    }
    else
    {
        if(DEBUG) throw "cpuid: unimplemented eax: " + h(id);
    }
}

/**
 * Update the flags register depending on iopl and cpl
 */
function update_flags(new_flags)
{
    var oldflags = flags;

    if(flags & flag_vm)
    {
        if(getiopl() === 3)
        {
            // cannot update iopl, vip, vif
            flags = (new_flags & ~flag_iopl & ~flag_vip & ~flag_vif) | (flags & (flag_iopl | flag_vip | flag_vif));
        }
        else
        {
            trigger_gp(0);
        }
    }
    else 
    {
        if(cpl === 0 || !protected_mode)
        {
            // can update all flags
            flags = new_flags;
        }
        else if(cpl <= getiopl())
        {
            // cpl != 0 and iopl <= cpl
            // can update interrupt flag but not iopl
            flags = (new_flags & ~flag_iopl) | (flags & flag_iopl);
        }
        else
        {
            // cannot update interrupt flag or iopl
            flags = (new_flags & ~flag_iopl & ~flag_interrupt) | (flags & (flag_iopl | flag_interrupt));
        }

        // vip and vif are cleared
        flags &= ~flag_vip & ~flag_vif;
    }

    // cannot modify rf or vm here
    flags = (flags & ~flag_vm & ~flag_rf) | (oldflags & (flag_vm | flag_rf));

    flags = (flags & flags_mask) | flags_default;

    flags_changed = 0;
}

function update_operand_size()
{
    if(operand_size_32)
    {
        table = table32;
        table0F = table0F_32;
    }
    else
    {
        table = table16;
        table0F = table0F_16;
    }
}

function update_address_size()
{
    if(address_size_32)
    {
        modrm_resolve = modrm_resolve32;

        regv = reg32;
        reg_vcx = reg_ecx;
        reg_vsi = reg_esi;
        reg_vdi = reg_edi;
    }
    else
    {
        modrm_resolve = modrm_resolve16;

        regv = reg16;
        reg_vcx = reg_cx;
        reg_vsi = reg_si;
        reg_vdi = reg_di;
    }
}

/**
 * @param {number} selector
 */
function lookup_segment_selector(selector)
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
    };

    if(is_gdt)
    {
        table_offset = gdtr_offset;
        table_limit = gdtr_size;
    }
    else
    {
        table_offset = ldtr_offset
        table_limit = ldtr_size;
    }

    if(selector_offset === 0)
    {
        info.is_null = true;
        return info;
    }

    // limit is the number of entries in the table minus one
    if((selector_offset >> 3) > table_limit)
    {
        info.is_valid = false;
        return info;
    }

    table_offset += selector_offset;

    if(paging)
    {
        table_offset = translate_address_system_read(table_offset);
    }

    info.base = memory.read16(table_offset + 2) | memory.read8(table_offset + 4) << 16 | 
            memory.read8(table_offset + 7) << 24,
    info.access = memory.read8(table_offset + 5),
    info.flags = memory.read8(table_offset + 6) >> 4,
    info.limit = memory.read16(table_offset) | (memory.read8(table_offset + 6) & 0xF) << 16,

    // used if system
    info.type = info.access & 0xF;

    info.dpl = info.access >> 5 & 3;

    info.is_system = (info.access & 0x10) === 0;
    info.is_present = (info.access & 0x80) === 0x80;
    info.is_executable = (info.access & 8) === 8;

    info.rw_bit = (info.access & 2) === 2;
    info.dc_bit = (info.access & 4) === 4;

    info.size = (info.flags & 4) === 4;
    info.granularity = (info.flags & 8) === 8;


    if(info.gr_bit)
    {
        info.real_limit = (info.limit << 12 | 0xFFF) >>> 0;
    }
    else
    {
        info.real_limit = info.limit;
    }

    info.is_writable = info.rw_bit && !info.is_executable;
    info.is_readable = info.rw_bit || !info.is_executable;

    return info;
}

/**
 * @param {number} reg
 * @param {number} selector
 */
function switch_seg(reg, selector)
{
    dbg_assert(reg >= 0 && reg <= 5);
    dbg_assert(typeof selector === "number" && selector < 0x10000 && selector >= 0);
    
    if(reg === reg_cs)
    {
        protected_mode = (cr0 & 1) === 1;
    }

    if(!protected_mode)
    {
        sreg[reg] = selector;
        segment_is_null[reg] = 0;
        segment_limits[reg] = 0xFFFFF;
        segment_offsets[reg] = selector << 4;
        return;
    }

    var info = lookup_segment_selector(selector);

    if(reg === reg_ss)
    {
        if(info.is_null)
        {
            trigger_gp(0);
            return false;
        }
        if(!info.is_valid || 
                info.is_system ||
                info.rpl !== cpl ||
                !info.is_writable ||
                info.dpl !== cpl)
        {
            trigger_gp(selector & ~3);
            return false;
        }
        if(!info.is_present)
        {
            trigger_ss(selector & ~3);
            return false;
        }

        stack_size_32 = info.size;

        if(info.size)
        {
            stack_reg = reg32s;
            reg_vsp = reg_esp;
            reg_vbp = reg_ebp;
        }
        else
        {
            stack_reg = reg16;
            reg_vsp = reg_sp;
            reg_vbp = reg_bp;
        }
    }
    else if(reg === reg_cs)
    {
        if(!info.is_executable)
        {
            // cs not executable
            dbg_log(info + " " + h(selector & ~3), LOG_CPU);
            throw unimpl("#GP handler");
        }

        if(info.is_system)
        {
            dbg_log(info + " " + h(selector & ~3), LOG_CPU);
            throw unimpl("load system segment descriptor, type = " + (info.access & 15));
        }

        if(info.dc_bit && (info.dpl !== info.rpl))
        {
            dbg_log(info + " " + h(selector & ~3), LOG_CPU);
            throw unimpl("#GP handler");
        }

        if(info.rpl !== cpl)
        {
            dbg_log(info + " " + h(selector & ~3), LOG_CPU);
            throw unimpl("privilege change");
        }

        dbg_assert(cpl === info.dpl);

        if(!info.dc_bit && info.dpl < cpl)
        {
            throw unimpl("inter privilege interrupt");
        }
        else
        {
            if(info.dc_bit || info.dpl === cpl)
            {
                // ok
            }
            else
            {
                // PE = 1, interrupt or trap gate, nonconforming code segment, DPL > CPL
                dbg_log(info + " " + h(selector & ~3), LOG_CPU);
                throw unimpl("#GP handler");
            }
        }


        operand_size_32 = address_size_32 = is_32 = info.size;

        update_operand_size();
        update_address_size();
    }
    else
    {
        // es, ds, fs, gs
        if(info.is_null)
        {
            sreg[reg] = selector;
            segment_is_null[reg] = 1;
            return true;
        }
        if(!info.is_valid || 
                info.is_system || 
                !info.is_readable ||
                ((!info.is_executable || !info.dc_bit) &&
                 info.rpl > info.dpl &&
                 cpl > info.dpl))
        {
            trigger_gp(selector & ~3);
            return false;
        }
        if(!info.is_present)
        {
            trigger_np(selector & ~3);
            return false;
        }
    }

    //dbg_log("seg " + reg + " " + h(info.base));

    segment_is_null[reg] = 0;
    segment_limits[reg] = info.real_limit;
    segment_infos[reg] = 0; // TODO
    
    segment_offsets[reg] = info.base;

    sreg[reg] = selector;

    return true;
}

function load_tr(selector)
{
    var info = lookup_segment_selector(selector);

    //dbg_log("load tr");

    if(!info.from_gdt)
    {
        throw unimpl("TR can only be loaded from GDT");
    }

    if(info.is_null)
    {
        dbg_log("#GP(0) | tried to load null selector (ltr)");
        throw unimpl("#GP handler");
    }

    if(!info.is_present)
    {
        dbg_log("#GP | present bit not set (ltr)");
        throw unimpl("#GP handler");
    }

    if(!info.is_system)
    {
        dbg_log("#GP | ltr: not a system entry");
        throw unimpl("#GP handler");
    }

    if(info.type !== 9)
    {
        dbg_log("#GP | ltr: invalid type (type = " + info.type + ")");
        throw unimpl("#GP handler");
    }

    tsr_size = info.limit;
    tsr_offset = info.base;

    //dbg_log("tsr at " + h(tsr_offset) + "; (" + tsr_size + " bytes)");
}

function load_ldt(selector)
{
    var info = lookup_segment_selector(selector);

    if(info.is_null)
    {
        // invalid
        ldtr_size = 0;
        ldtr_offset = 0;
        return;
    }

    if(!info.from_gdt)
    {
        throw unimpl("LDTR can only be loaded from GDT");
    }

    if(!info.is_present)
    {
        dbg_log("lldt: present bit not set");
        throw unimpl("#GP handler");
    }

    if(!info.is_system)
    {
        dbg_log("lldt: not a system entry");
        throw unimpl("#GP handler");
    }

    if(info.type !== 2)
    {
        dbg_log("lldt: invalid type (" + info.type + ")");
        throw unimpl("#GP handler");
    }

    ldtr_size = info.limit;
    ldtr_offset = info.base;

    //dbg_log("ldt at " + h(ldtr_offset) + "; (" + ldtr_size + " bytes)");
}



function clear_tlb()
{
    // clear tlb excluding global pages
    last_virt_eip = -1;
    last_virt_esp = -1;

    tlb_info.set(tlb_info_global);

    //dbg_log("page table loaded", LOG_CPU);
}

function full_clear_tlb()
{
    // clear tlb including global pages
    tlb_info_global = new Uint8Array(1 << 20);

    clear_tlb();

}

function invlpg(addr)
{
    var page = addr >>> 12;
    //dbg_log("invlpg: " + h(page), LOG_CPU);

    tlb_info[page] = 0;
    tlb_info_global[page] = 0;

    last_virt_eip = -1;
    last_virt_esp = -1;
}

/**
 * @param {number} addr
 */
function translate_address_disabled(addr)
{
    return addr;
}

function translate_address_user_write(addr)
{
    var base = addr >>> 12;
    
    if(tlb_info[base] & TLB_USER_WRITE)
    {
        return tlb_user_write[base] ^ addr;
    }
    else
    {
        return do_page_translation(addr, 1, 1) | addr & 0xFFF;
    }
}

function translate_address_user_read(addr)
{
    var base = addr >>> 12;
    
    if(tlb_info[base] & TLB_USER_READ)
    {
        return tlb_user_read[base] ^ addr;
    }
    else
    {
        return do_page_translation(addr, 0, 1) | addr & 0xFFF;
    }
}

function translate_address_system_write(addr)
{
    var base = addr >>> 12;
    
    if(tlb_info[base] & TLB_SYSTEM_WRITE)
    {
        return tlb_system_write[base] ^ addr;
    }
    else
    {
        return do_page_translation(addr, 1, 0) | addr & 0xFFF;
    }
}

function translate_address_system_read(addr)
{
    var base = addr >>> 12;
    
    if(tlb_info[base] & TLB_SYSTEM_READ)
    {
        return tlb_system_read[base] ^ addr;
    }
    else
    {
        return do_page_translation(addr, 0, 0) | addr & 0xFFF;
    }
}

/**
 * @return {number} 
 */
function do_page_translation(addr, for_writing, user)
{
    var page = addr >>> 12,
        page_dir_addr = (cr3 >>> 2) + (page >> 10),
        page_dir_entry = memory.mem32s[page_dir_addr],
        high,
        can_write = true,
        global,
        cachable = true,
        allow_user = true;

    if(!(page_dir_entry & 1))
    {
        // to do at this place:
        //
        // - set cr2 = addr (which caused the page fault)
        // - call_interrupt_vector  with id 14, error code 0-7 (requires information if read or write)
        // - prevent execution of the function that triggered this call
        //dbg_log("#PF not present", LOG_CPU);

        cr2 = addr;
        trigger_pagefault(for_writing, user, 0);

        // never reached as trigger_pagefault throws up
        dbg_assert(false);
    }

    if((page_dir_entry & 2) === 0)
    {
        can_write = false;

        if(for_writing)
        {
            cr2 = addr;
            trigger_pagefault(for_writing, user, 1);
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
            cr2 = addr;
            trigger_pagefault(for_writing, user, 1);
            dbg_assert(false);
        }
    }
    
    if((page_dir_entry & 0x10) === 0)
    {
        cachable = false;
    }

    if(page_dir_entry & page_size_extensions)
    {
        // size bit is set

        // set the accessed and dirty bits
        memory.mem32s[page_dir_addr] = page_dir_entry | 0x20 | for_writing << 6;

        high = (page_dir_entry & 0xFFC00000) | (page << 12 & 0x3FF000);

        global = page_dir_entry & 0x100;
    }
    else
    {
        var page_table_addr = ((page_dir_entry & 0xFFFFF000) >>> 2) + (page & 0x3FF),
            page_table_entry = memory.mem32s[page_table_addr];

        if(!(page_table_entry & 1))
        {
            //dbg_log("#PF not present table", LOG_CPU);
            cr2 = addr;
            trigger_pagefault(for_writing, user, 0);
            dbg_assert(false);
        }

        if((page_table_entry & 2) === 0)
        {
            can_write = false;

            if(for_writing)
            {
                //dbg_log("#PF not writable page", LOG_CPU);
                cr2 = addr;
                trigger_pagefault(for_writing, user, 1);
                dbg_assert(false);
            }
        }

        if((page_table_entry & 4) === 0)
        {
            allow_user = false;

            if(user)
            {
                //dbg_log("#PF not supervisor page", LOG_CPU);
                cr2 = addr;
                trigger_pagefault(for_writing, user, 1);
                dbg_assert(false);
            }
        }
    
        if((page_table_entry & 0x10) === 0)
        {
            cachable = false;
        }

        // set the accessed and dirty bits
        memory.mem32s[page_dir_addr] = page_dir_entry | 0x20;
        memory.mem32s[page_table_addr] = page_table_entry | 0x20 | for_writing << 6;

        high = page_table_entry & 0xFFFFF000;

        global = page_table_entry & 0x100;
    }

    if(cachable)
    {
        var cache_entry = high ^ page << 12,
            info = 0;

        if(allow_user)
        {
            tlb_user_read[page] = cache_entry;
            info |= TLB_USER_READ;

            if(can_write)
            {
                tlb_user_write[page] = cache_entry;
                info |= TLB_USER_WRITE;
            }
        }
        
        tlb_system_read[page] = cache_entry;
        info |= TLB_SYSTEM_READ;

        if(can_write)
        {
            tlb_system_write[page] = cache_entry;
            info |= TLB_SYSTEM_WRITE;
        }

        tlb_info[page] |= info;

        if(global)
        {
            tlb_info_global[page] = info;
        }
    }

    return high ;
}

function trigger_pagefault(write, user, present)
{
    if(LOG_LEVEL & LOG_CPU)
    {
        //dbg_trace();
    }

    if(page_fault)
    {
        dbg_trace();
        throw unimpl("Double fault");
    }

    instruction_pointer = previous_ip;
    page_fault = true;
    call_interrupt_vector(14, false, user << 2 | write << 1 | present);

    throw 0xDEADBEE;
}


// it looks pointless to have these two here, but 
// Closure Compiler is able to remove unused functions
//#include "test_helpers.js"
#include "debug.macro.js"


#include "modrm.macro.js"
#include "arith.macro.js"
#include "misc_instr.macro.js"
#include "string.macro.js"

#include "fpu.macro.js"

#include "instructions.macro.js"


}
