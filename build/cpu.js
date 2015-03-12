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
    this.tsc_offset = 0;
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
    this.timestamp_counter = 0x80000000;
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
"use strict";
(function(cpu)
{
    var debug = {};
    cpu.debug = debug;
    /** 
     * wheter or not in step mode
     * used for debugging
     * @type {boolean}
     */
    debug.step_mode = false;
    debug.ops = undefined;
    debug.all_ops = [];
    debug.trace_all = false;
    // "log" some information visually to the user.
    // Also in non-DEBUG modes
    debug.show = function(x)
    {
        if(typeof document !== "undefined")
        {
            var el = document.getElementById("log");
            if(el)
            {
                el.textContent += x + "\n";
                el.style.display = "block";
                el.scrollTop = 1e9;
                return;
            }
        }
        console.log(x);
    };
    debug.init = function()
    {
        if(!DEBUG) return;
        // used for debugging 
        debug.ops = new CircularQueue(200000);
        if(cpu.io)
        {
            // write seabios debug output to console
            var seabios_debug = "";
            cpu.io.register_write(0x402, this, handle); // seabios
            cpu.io.register_write(0x500, this, handle); // vgabios
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
    debug.dump_regs = dump_regs;
    debug.dump_instructions = dump_instructions;
    debug.get_instructions = get_instructions;
    debug.dump_regs_short = dump_regs_short;
    debug.dump_stack = dump_stack;
    debug.dump_page_directory = dump_page_directory;
    debug.dump_gdt_ldt = dump_gdt_ldt;
    debug.dump_idt = dump_idt;
    debug.get_memory_dump = get_memory_dump;
    debug.memory_hex_dump = memory_hex_dump;
    debug.used_memory_dump = used_memory_dump;
    debug.step = step;
    debug.run_until = run_until;
    debug.debugger = function()
    {
        if(DEBUG)
        {
            debugger;
        }
    }
    /** 
     * @param {string=} msg
     */
    debug.unimpl = function(msg)
    {
        var s = "Unimplemented" + (msg ? ": " + msg : "");
        debug.show(s);
        if(DEBUG)
        {
            console.trace();
            return s;
        }
        else
        {
            debug.show("Execution stopped");
            return s;
        }
        //this.name = "Unimplemented";
    }
    function step()
    {
        if(!DEBUG) return;
        if(!cpu.running)
        {
            try
            {
                cpu.cycle();
            }
            catch(e)
            {
                cpu.exception_cleanup(e);
            }
        }
        dump_regs_short();
        var now = Date.now();
        cpu.devices.vga.timer(now);
        //this.pit.timer(now);
        //this.rtc.timer(now);
        cpu.running = false;
        dump_instructions();
    }
    function run_until()
    {
        if(!DEBUG) return;
        cpu.running = false;
        var a = parseInt(prompt("input hex", ""), 16);
        if(a) while(cpu.instruction_pointer != a) step();
        dump_regs();
    }
    // http://ref.x86asm.net/x86reference.xml
    // for debuggin" purposes
    var opcode_map = [
        "ADD", "ADD", "ADD", "ADD", "ADD", "ADD", "PUSH", "POP",
        "OR", "OR", "OR", "OR", "OR", "OR", "PUSH", "0F:",
        "ADC", "ADC", "ADC", "ADC", "ADC", "ADC", "PUSH", "POP",
        "SBB", "SBB", "SBB", "SBB", "SBB", "SBB", "PUSH", "POP",
        "AND", "AND", "AND", "AND", "AND", "AND", "ES", "DAA",
        "SUB", "SUB", "SUB", "SUB", "SUB", "SUB", "CS", "DAS",
        "XOR", "XOR", "XOR", "XOR", "XOR", "XOR", "SS", "AAA",
        "CMP", "CMP", "CMP", "CMP", "CMP", "CMP", "DS", "AAS",
        "INC", "INC", "INC", "INC", "INC", "INC", "INC", "INC",
        "DEC", "DEC", "DEC", "DEC", "DEC", "DEC", "DEC", "DEC",
        "PUSH", "PUSH", "PUSH", "PUSH", "PUSH", "PUSH", "PUSH", "PUSH",
        "POP", "POP", "POP", "POP", "POP", "POP", "POP", "POP",
        "PUSHA", "POPA", "BOUND", "ARPL", "FS", "GS", "none", "none",
        "PUSH", "IMUL", "PUSH", "IMUL", "INS", "INS", "OUTS", "OUTS",
        "JO", "JNO", "JB", "JNB", "JZ", "JNZ", "JBE", "JNBE",
        "JS", "JNS", "JP", "JNP", "JL", "JNL", "JLE", "JNLE",
        "ADD", "ADD", "ADD", "ADD", "TEST", "TEST", "XCHG", "XCHG",
        "MOV", "MOV", "MOV", "MOV", "MOV", "LEA", "MOV", "POP",
        "NOP", "XCHG", "XCHG", "XCHG", "XCHG", "XCHG", "XCHG", "XCHG",
        "CBW", "CWD", "CALLF", "FWAIT", "PUSHF", "POPF", "SAHF", "LAHF",
        "MOV", "MOV", "MOV", "MOV", "MOVS", "MOVS", "CMPS", "CMPS",
        "TEST", "TEST", "STOS", "STOS", "LODS", "LODS", "SCAS", "SCAS",
        "MOV", "MOV", "MOV", "MOV", "MOV", "MOV", "MOV", "MOV",
        "MOV", "MOV", "MOV", "MOV", "MOV", "MOV", "MOV", "MOV",
        "ROL", "ROL", "RETN", "RETN", "LES", "LDS", "MOV", "MOV",
        "ENTER", "LEAVE", "RETF", "RETF", "INT", "INT", "INTO", "IRET",
        "ROL", "ROL", "ROL", "ROL", "AAM", "AAD", "none", "XLAT",
        "FADD", "FLD", "FIADD", "FILD", "FADD", "FLD", "FIADD", "FILD",
        "LOOPNZ", "LOOPZ", "LOOP", "JCXZ", "IN", "IN", "OUT", "OUT",
        "CALL", "JMP", "JMPF", "JMP", "IN", "IN", "OUT", "OUT",
        "LOCK", "none", "REPNZ", "REPZ", "HLT", "CMC", "TEST", "TEST",
        "CLC", "STC", "CLI", "STI", "CLD", "STD", "INC", "INC"
    ];
    debug.logop = function(_ip, op)
    {
        if(!DEBUG || !debug.step_mode)
        {
            return;
        }
        if(debug.trace_all && debug.all_ops)
        {
            debug.all_ops.push(_ip, op);
        }
        else if(debug.ops)
        {
            debug.ops.add(_ip);
            debug.ops.add(op);
        }
    }
    function dump_stack(start, end)
    {
        if(!DEBUG) return;
        var esp = cpu.reg32[reg_esp];
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
            dbg_log(line + h(esp + 4 * i, 8) + " | " + h(cpu.memory.read32s(esp + 4 * i) >>> 0));
        }
    }
    function dump_regs_short()
    {
        if(!DEBUG) return;
        var
            r32 = { "eax": reg_eax, "ecx": reg_ecx, "edx": reg_edx, "ebx": reg_ebx,
                    "esp": reg_esp, "ebp": reg_ebp, "esi": reg_esi, "edi": reg_edi },
            r32_names = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"],
            s = { "cs": reg_cs, "ds": reg_ds, "es": reg_es, "fs": reg_fs, "gs": reg_gs, "ss": reg_ss },
            line1 = "",
            line2 = "";
        for(var i = 0; i < 4; i++)
        {
            line1 += r32_names[i] + "=" + h(cpu.reg32[r32[r32_names[i]]], 8) + " ";
            line2 += r32_names[i+4] + "=" + h(cpu.reg32[r32[r32_names[i+4]]], 8) + " ";
        }
        line1 += " eip=" + h(cpu.get_real_eip() >>> 0, 8);
        line2 += " flg=" + h(cpu.get_eflags(), 8);
        line1 += "  ds=" + h(cpu.sreg[reg_ds], 4) + " es=" + h(cpu.sreg[reg_es], 4) + "  fs=" + h(cpu.sreg[reg_fs], 4);
        line2 += "  gs=" + h(cpu.sreg[reg_gs], 4) + " cs=" + h(cpu.sreg[reg_cs], 4) + "  ss=" + h(cpu.sreg[reg_ss], 4);
        dbg_log(line1, LOG_CPU);
        dbg_log(line2, LOG_CPU);
    }
    function dump_regs()
    {
        if(!DEBUG) return;
        var
            r32 = { "eax": reg_eax, "ecx": reg_ecx, "edx": reg_edx, "ebx": reg_ebx,
                    "esp": reg_esp, "ebp": reg_ebp, "esi": reg_esi, "edi": reg_edi },
            s = { "cs": reg_cs, "ds": reg_ds, "es": reg_es,
                  "fs": reg_fs, "gs": reg_gs, "ss": reg_ss },
            out;
        dbg_log("----- DUMP (ip = 0x" + h(cpu.instruction_pointer >>> 0) + ") ----------")
        dbg_log("protected mode: " + cpu.protected_mode);
        for(var i in r32)
        {
            dbg_log(i + " =  0x" + h(cpu.reg32[r32[i]], 8));
        }
        dbg_log("eip =  0x" + h(cpu.get_real_eip() >>> 0, 8));
        for(i in s)
        {
            dbg_log(i + "  =  0x" + h(cpu.sreg[s[i]], 4));
        }
        out = "";
        var flg = { "cf": cpu.getcf, "pf": cpu.getpf, "zf": cpu.getzf, "sf": cpu.getsf,
                    "of": cpu.getof, "df": flag_direction, "if": flag_interrupt };
        for(var i in flg)
        {
            if(+flg[i])
            {
                out += i + "=" + Number(!!(cpu.flags & flg[i])) + " | ";
            }
            else
            {
                out += i + "=" + Number(!!flg[i]()) + " | ";
            }
        }
        out += "iopl=" + cpu.getiopl();
        dbg_log(out);
        //dbg_log("last operation: " + h(last_op1 | 0) + ", " +  h(last_op2 | 0) + " = " +
                //h(last_result | 0) + " (" + last_op_size + " bit)")
    }
    function get_instructions()
    {
        if(!DEBUG) return;
        debug.step_mode = true;
        function add(ip, op)
        {
            out += h(ip, 8) + ":        " +
                v86util.pads(opcode_map[op] || "unkown", 20) + h(op, 2) + "\n";
        }
        var opcodes;
        var out = "";
        if(debug.trace_all && debug.all_ops)
        {
            opcodes = debug.all_ops;
        }
        else if(debug.ops)
        {
            opcodes = debug.ops.toArray();
        }
        if(!opcodes)
        {
            return "";
        }
        for(var i = 0; i < opcodes.length; i += 2)
        {
            add(opcodes[i], opcodes[i + 1]);
        }
        debug.ops.clear();
        debug.all_ops = [];
        return out;
    }
    function dump_instructions()
    {
        if(!DEBUG) return;
        debug.show(get_instructions());
    }
    function dump_gdt_ldt()
    {
        if(!DEBUG) return;
        dbg_log("gdt: (len = " + h(cpu.gdtr_size) + ")");
        dump_table(cpu.translate_address_read(cpu.gdtr_offset), cpu.gdtr_size);
        dbg_log("\nldt: (len = " + h(cpu.segment_limits[reg_ldtr]) + ")");
        dump_table(cpu.translate_address_read(cpu.segment_offsets[reg_ldtr]), cpu.segment_limits[reg_ldtr]);
        function dump_table(addr, size)
        {
            for(var i = 0; i < size; i += 8, addr += 8)
            {
                var base = cpu.memory.read16(addr + 2) |
                        cpu.memory.read8(addr + 4) << 16 |
                        cpu.memory.read8(addr + 7) << 24,
                    limit = cpu.memory.read16(addr) | (cpu.memory.read8(addr + 6) & 0xF) << 16,
                    access = cpu.memory.read8(addr + 5),
                    flags = cpu.memory.read8(addr + 6) >> 4,
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
    }
    function dump_idt()
    {
        if(!DEBUG) return;
        for(var i = 0; i < cpu.idtr_size; i += 8)
        {
            var addr = cpu.paging ? cpu.do_page_translation(cpu.idtr_offset + i, 0, 0) : cpu.idtr_offset + i,
                base = cpu.memory.read16(addr) | cpu.memory.read16(addr + 6) << 16,
                selector = cpu.memory.read16(addr + 2),
                type = cpu.memory.read8(addr + 5),
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
    }
    function load_page_entry(dword_entry, is_directory)
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
            address = dword_entry & 0xFFC00000;
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
    function dump_page_directory()
    {
        if(!DEBUG) return;
        for(var i = 0; i < 1024; i++)
        {
            var dword = cpu.memory.read32s(cpu.cr[3] + 4 * i),
                entry = load_page_entry(dword, true);
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
                dbg_log("=== " + h((i << 22) >>> 0, 8) + " -> " + h(entry.address >>> 0, 8) + " | " + flags);
                continue;
            }
            else
            {
                dbg_log("=== " + h((i << 22) >>> 0, 8) + " | " + flags);
            }
            for(var j = 0; j < 1024; j++)
            {
                dword = cpu.memory.read32s(entry.address + 4 * j);
                var subentry = load_page_entry(dword, false);
                if(subentry)
                {
                    flags = "";
                    flags += subentry.cache_disable ? "Cd " : "   ";
                    flags += subentry.user ? "U " : "  ";
                    flags += subentry.read_write ? "Rw " : "   ";
                    flags += subentry.global ? "G " : "  ";
                    flags += subentry.accessed ? "A " : "  ";
                    flags += subentry.dirty ? "Di " : "   ";
                    dbg_log("# " + h((i << 22 | j << 12) >>> 0, 8) + " -> " +
                            h(subentry.address, 8) + " | " + flags);
                }
            }
        }
    }
    function get_memory_dump(start, count)
    {
        if(!DEBUG) return;
        if(start === undefined)
        {
            start = 0;
            count = cpu.memory_size;
        }
        else if(count === undefined)
        {
            count = start;
            start = 0;
        }
        return cpu.memory.buffer.slice(start, start + count);
    }
    function memory_hex_dump(addr, length)
    {
        if(!DEBUG) return;
        length = length || 4 * 0x10;
        var line, byt;
        for(var i = 0; i < length >> 4; i++)
        {
            line = h(addr + (i << 4), 5) + "   ";
            for(var j = 0; j < 0x10; j++)
            {
                byt = cpu.memory.read8(addr + (i << 4) + j);
                line += h(byt, 2) + " ";
            }
            line += "  ";
            for(j = 0; j < 0x10; j++)
            {
                byt = cpu.memory.read8(addr + (i << 4) + j);
                line += (byt < 33 || byt > 126) ? "." : String.fromCharCode(byt);
            }
            dbg_log(line);
        }
    }
    function used_memory_dump()
    {
        if(!DEBUG) return;
        var width = 0x80,
            height = 0x10,
            block_size = cpu.memory_size / width / height | 0,
            row;
        for(var i = 0; i < height; i++)
        {
            row = "0x" + h(i * width * block_size, 8) + " | ";
            for(var j = 0; j < width; j++)
            {
                var used = cpu.memory.mem32s[(i * width + j) * block_size] > 0;
                row += used ? "X" : " ";
            }
            dbg_log(row);
        }
    };
})(this);
    dbg_assert(this.table16 && this.table32);
    dbg_assert(this.table0F_16 && this.table0F_32);
    this._state_restore();
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
    this.timestamp_counter = 0x80000000;
    this.tsc_offset = v86.microtick();
    /** @const */
    this._state_skip = [
        this.bios,
        this.debug,
        this.table16,
        this.table32,
        this.table0F_16,
        this.table0F_32,
        this.tlb_data,
        this.tlb_info,
        this.tlb_info_global,
    ];
};
/** @constructor */
function DynamicTranslator(something)
{
    // TODO
    dbg_assert(false);
    this.clear_cache = function() {};
    this.cycle_translated = function() {};
}
/*
 * This file contains functions to decode the modrm and sib bytes
 *
 * These functions return a virtual address
 */
"use strict";
(function()
{
    CPU.prototype.modrm_table16 = Array(0xC0);
    CPU.prototype.modrm_table32 = Array(0xC0);
    CPU.prototype.sib_table = Array(0x100);
    CPU.prototype.modrm_table16[0x00 | 0] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_si]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 0] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_si]) + cpu.read_imm8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 0] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_si]) + cpu.read_imm16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 1] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_di]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 1] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_di]) + cpu.read_imm8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 1] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_di]) + cpu.read_imm16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 2] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_si]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 2] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_si]) + cpu.read_imm8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 2] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_si]) + cpu.read_imm16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 3] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_di]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 3] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_di]) + cpu.read_imm8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 3] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_di]) + cpu.read_imm16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 4] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_si]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 4] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_si]) + cpu.read_imm8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 4] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_si]) + cpu.read_imm16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 5] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_di]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 5] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_di]) + cpu.read_imm8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 5] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_di]) + cpu.read_imm16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 6] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 6] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp]) + cpu.read_imm8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 6] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp]) + cpu.read_imm16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 7] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 7] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx]) + cpu.read_imm8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 7] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx]) + cpu.read_imm16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table32[0x00 | 0] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 0] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax]) + cpu.read_imm8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 0] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax]) + cpu.read_imm32s() | 0;
    };;
    CPU.prototype.modrm_table32[0x00 | 1] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 1] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx]) + cpu.read_imm8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 1] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx]) + cpu.read_imm32s() | 0;
    };;
    CPU.prototype.modrm_table32[0x00 | 2] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 2] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx]) + cpu.read_imm8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 2] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx]) + cpu.read_imm32s() | 0;
    };;
    CPU.prototype.modrm_table32[0x00 | 3] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 3] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx]) + cpu.read_imm8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 3] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx]) + cpu.read_imm32s() | 0;
    };;
    CPU.prototype.modrm_table32[0x00 | 4] = function(cpu)
    {
        return(cpu.sib_table[cpu.read_imm8()](cpu, false)) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 4] = function(cpu)
    {
        return(cpu.sib_table[cpu.read_imm8()](cpu, false)) + cpu.read_imm8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 4] = function(cpu)
    {
        return(cpu.sib_table[cpu.read_imm8()](cpu, false)) + cpu.read_imm32s() | 0;
    };;
    CPU.prototype.modrm_table32[0x00 | 5] = function(cpu)
    {
        return(cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 5] = function(cpu)
    {
        return(cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp]) + cpu.read_imm8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 5] = function(cpu)
    {
        return(cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp]) + cpu.read_imm32s() | 0;
    };;
    CPU.prototype.modrm_table32[0x00 | 6] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 6] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi]) + cpu.read_imm8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 6] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi]) + cpu.read_imm32s() | 0;
    };;
    CPU.prototype.modrm_table32[0x00 | 7] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 7] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi]) + cpu.read_imm8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 7] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi]) + cpu.read_imm32s() | 0;
    };;
    // special cases
    CPU.prototype.modrm_table16[0x00 | 6] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + cpu.read_imm16() | 0;
    }
    CPU.prototype.modrm_table32[0x00 | 5] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + cpu.read_imm32s() | 0;
    };
    CPU.prototype.modrm_table32[0x00 | 4] = function(cpu)
    {
        return cpu.sib_table[cpu.read_imm8()](cpu, false) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 4] = function(cpu)
    {
        return cpu.sib_table[cpu.read_imm8()](cpu, true) + cpu.read_imm8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 4] = function(cpu)
    {
        return cpu.sib_table[cpu.read_imm8()](cpu, true) + cpu.read_imm32s() | 0;
    };
    for(var low = 0; low < 8; low++)
    {
        for(var high = 0; high < 3; high++)
        {
            var x = low | high << 6;
            for(var i = 1; i < 8; i++)
            {
                CPU.prototype.modrm_table32[x | i << 3] = CPU.prototype.modrm_table32[x];
                CPU.prototype.modrm_table16[x | i << 3] = CPU.prototype.modrm_table16[x];
            }
        }
    }
    CPU.prototype.sib_table[0x00 | 0 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x00 | 0 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 0 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 0 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 0 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x00 | 0 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x00 | 0 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x00 | 0 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 0 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x40 | 0 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 0 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 0 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 0 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x40 | 0 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x40 | 0 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 0 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 0 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x80 | 0 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 0 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 0 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 0 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x80 | 0 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x80 | 0 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 0 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 0 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 0 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 0 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 0 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 0 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 0 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0xC0 | 0 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 0 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_eax] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };;
    CPU.prototype.sib_table[0x00 | 1 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x00 | 1 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 1 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 1 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 1 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x00 | 1 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x00 | 1 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x00 | 1 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 1 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x40 | 1 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 1 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 1 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 1 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x40 | 1 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x40 | 1 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 1 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 1 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x80 | 1 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 1 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 1 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 1 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x80 | 1 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x80 | 1 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 1 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 1 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 1 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 1 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 1 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 1 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 1 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0xC0 | 1 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 1 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ecx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };;
    CPU.prototype.sib_table[0x00 | 2 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x00 | 2 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 2 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 2 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 2 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x00 | 2 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x00 | 2 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x00 | 2 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 2 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x40 | 2 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 2 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 2 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 2 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x40 | 2 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x40 | 2 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 2 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 2 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x80 | 2 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 2 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 2 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 2 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x80 | 2 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x80 | 2 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 2 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 2 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 2 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 2 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 2 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 2 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 2 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0xC0 | 2 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 2 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };;
    CPU.prototype.sib_table[0x00 | 3 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x00 | 3 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 3 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 3 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 3 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x00 | 3 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x00 | 3 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x00 | 3 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 3 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x40 | 3 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 3 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 3 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 3 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x40 | 3 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x40 | 3 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 3 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 3 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x80 | 3 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 3 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 3 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 3 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x80 | 3 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x80 | 3 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 3 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 3 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 3 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 3 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 3 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 3 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 3 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0xC0 | 3 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 3 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebx] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };;
    CPU.prototype.sib_table[0x00 | 4 << 3 | 0] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x00 | 4 << 3 | 1] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 4 << 3 | 2] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 4 << 3 | 3] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 4 << 3 | 4] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x00 | 4 << 3 | 5] = function(cpu, mod)
    {
        return (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x00 | 4 << 3 | 6] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x00 | 4 << 3 | 7] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 4 << 3 | 0] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x40 | 4 << 3 | 1] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 4 << 3 | 2] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 4 << 3 | 3] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 4 << 3 | 4] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x40 | 4 << 3 | 5] = function(cpu, mod)
    {
        return (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x40 | 4 << 3 | 6] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 4 << 3 | 7] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 4 << 3 | 0] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x80 | 4 << 3 | 1] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 4 << 3 | 2] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 4 << 3 | 3] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 4 << 3 | 4] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x80 | 4 << 3 | 5] = function(cpu, mod)
    {
        return (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x80 | 4 << 3 | 6] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 4 << 3 | 7] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 4 << 3 | 0] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 4 << 3 | 1] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 4 << 3 | 2] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 4 << 3 | 3] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 4 << 3 | 4] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 4 << 3 | 5] = function(cpu, mod)
    {
        return (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0xC0 | 4 << 3 | 6] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 4 << 3 | 7] = function(cpu, mod)
    {
        return cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };;
    CPU.prototype.sib_table[0x00 | 5 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x00 | 5 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 5 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 5 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 5 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x00 | 5 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x00 | 5 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x00 | 5 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 5 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x40 | 5 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 5 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 5 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 5 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x40 | 5 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x40 | 5 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 5 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 5 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x80 | 5 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 5 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 5 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 5 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x80 | 5 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x80 | 5 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 5 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 5 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 5 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 5 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 5 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 5 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 5 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0xC0 | 5 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 5 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_ebp] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };;
    CPU.prototype.sib_table[0x00 | 6 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x00 | 6 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 6 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 6 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 6 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x00 | 6 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x00 | 6 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x00 | 6 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 6 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x40 | 6 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 6 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 6 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 6 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x40 | 6 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x40 | 6 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 6 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 6 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x80 | 6 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 6 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 6 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 6 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x80 | 6 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x80 | 6 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 6 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 6 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 6 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 6 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 6 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 6 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 6 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0xC0 | 6 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 6 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_esi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };;
    CPU.prototype.sib_table[0x00 | 7 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x00 | 7 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 7 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 7 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x00 | 7 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x00 | 7 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x00 | 7 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x00 | 7 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi]) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 7 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x40 | 7 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 7 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 7 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x40 | 7 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x40 | 7 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x40 | 7 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x40 | 7 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 1) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 7 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0x80 | 7 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 7 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 7 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0x80 | 7 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0x80 | 7 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0x80 | 7 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0x80 | 7 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 2) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 7 << 3 | 0] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 7 << 3 | 1] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 7 << 3 | 2] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 7 << 3 | 3] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 7 << 3 | 4] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ss() + cpu.reg32s[reg_esp] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 7 << 3 | 5] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_imm32s()) | 0;
    };
    CPU.prototype.sib_table[0xC0 | 7 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 7 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };;
    CPU.prototype.modrm_resolve = function(modrm_byte)
    {
        return(this.address_size_32 ? this.modrm_table32 : this.modrm_table16)[modrm_byte](this);
    };
})();
/*
 * Arithmatic functions
 * This file contains:
 *
 * add, adc, sub, sbc, cmp
 * inc, dec
 * neg, not
 * imul, mul, idiv, div
 * xadd
 *
 * das, daa, aad, aam
 *
 * and, or, xor, test
 * shl, shr, sar, ror, rol, rcr, rcl
 * shld, shrd
 *
 * bts, btr, btc, bt
 * bsf, bsr
 *
 * popcnt
 *
 * Gets #included by cpu.macro.js
 *
*/
"use strict";
CPU.prototype.add = function(dest_operand, source_operand, op_size)
{
    //if(this.safe_read32s(this.instruction_pointer + 1) === 0) throw "0000000";
    this.last_op1 = dest_operand;
    this.last_op2 = source_operand;
    this.last_add_result = this.last_result = dest_operand + source_operand | 0;
    this.last_op_size = op_size;
    this.flags_changed = flags_all;
    return this.last_result;
}
CPU.prototype.adc = function(dest_operand, source_operand, op_size)
{
    var cf = this.getcf();
    this.last_op1 = dest_operand;
    this.last_op2 = source_operand;
    this.last_add_result = this.last_result = (dest_operand + source_operand | 0) + cf | 0;
    this.last_op_size = op_size;
    this.flags_changed = flags_all;
    return this.last_result;
}
CPU.prototype.cmp = function(dest_operand, source_operand, op_size)
{
    this.last_add_result = dest_operand;
    this.last_op2 = source_operand;
    this.last_op1 = this.last_result = dest_operand - source_operand | 0;
    this.last_op_size = op_size;
    this.flags_changed = flags_all;
}
CPU.prototype.sub = function(dest_operand, source_operand, op_size)
{
    this.last_add_result = dest_operand;
    this.last_op2 = source_operand;
    this.last_op1 = this.last_result = dest_operand - source_operand | 0;
    this.last_op_size = op_size;
    this.flags_changed = flags_all;
    return this.last_result;
}
CPU.prototype.sbb = function(dest_operand, source_operand, op_size)
{
    var cf = this.getcf();
    this.last_add_result = dest_operand;
    this.last_op2 = source_operand;
    this.last_op1 = this.last_result = dest_operand - source_operand - cf | 0;
    this.last_op_size = op_size;
    this.flags_changed = flags_all;
    return this.last_result;
}
/*
 * inc and dec
 */
CPU.prototype.inc = function(dest_operand, op_size)
{
    this.flags = (this.flags & ~1) | this.getcf();
    this.last_op1 = dest_operand;
    this.last_op2 = 1;
    this.last_add_result = this.last_result = dest_operand + 1 | 0;
    this.last_op_size = op_size;
    this.flags_changed = flags_all & ~1;
    return this.last_result;
}
CPU.prototype.dec = function(dest_operand, op_size)
{
    this.flags = (this.flags & ~1) | this.getcf();
    this.last_add_result = dest_operand;
    this.last_op2 = 1;
    this.last_op1 = this.last_result = dest_operand - 1 | 0;
    this.last_op_size = op_size;
    this.flags_changed = flags_all & ~1;
    return this.last_result;
}
/*
 * neg
 */
CPU.prototype.neg = function(dest_operand, op_size)
{
    this.last_op1 = this.last_result = -dest_operand | 0;
    this.flags_changed = flags_all;
    this.last_add_result = 0;
    this.last_op2 = dest_operand;
    this.last_op_size = op_size;
    return this.last_result;
}
/*
 * mul, imul, div, idiv
 *
 * Note: imul has some extra opcodes
 *       while other functions only allow
 *       ax * modrm
 */
CPU.prototype.mul8 = function(source_operand)
{
    var result = source_operand * this.reg8[reg_al];
    this.reg16[reg_ax] = result;
    if(result < 0x100)
    {
        this.flags = this.flags & ~1 & ~flag_overflow;
    }
    else
    {
        this.flags = this.flags | 1 | flag_overflow;
    }
    this.flags_changed = 0;
}
CPU.prototype.imul8 = function(source_operand)
{
    var result = source_operand * this.reg8s[reg_al];
    this.reg16[reg_ax] = result;
    if(result > 0x7F || result < -0x80)
    {
        this.flags = this.flags | 1 | flag_overflow;
    }
    else
    {
        this.flags = this.flags & ~1 & ~flag_overflow;
    }
    this.flags_changed = 0;
}
CPU.prototype.mul16 = function(source_operand)
{
    var result = source_operand * this.reg16[reg_ax],
        high_result = result >>> 16;
    //console.log(h(a) + " * " + h(this.reg16[reg_ax]) + " = " + h(result));
    this.reg16[reg_ax] = result;
    this.reg16[reg_dx] = high_result;
    if(high_result === 0)
    {
        this.flags &= ~1 & ~flag_overflow;
    }
    else
    {
        this.flags |= 1 | flag_overflow;
    }
    this.flags_changed = 0;
}
/*
 * imul with 1 argument
 * ax = ax * r/m
 */
CPU.prototype.imul16 = function(source_operand)
{
    var result = source_operand * this.reg16s[reg_ax];
    this.reg16[reg_ax] = result;
    this.reg16[reg_dx] = result >> 16;
    if(result > 0x7FFF || result < -0x8000)
    {
        this.flags |= 1 | flag_overflow;
    }
    else
    {
        this.flags &= ~1 & ~flag_overflow;
    }
    this.flags_changed = 0;
}
/*
 * imul with 2 or 3 arguments
 * reg = reg * r/m
 * reg = imm * r/m
 */
CPU.prototype.imul_reg16 = function(operand1, operand2)
{
    dbg_assert(operand1 < 0x8000 && operand1 >= -0x8000);
    dbg_assert(operand2 < 0x8000 && operand2 >= -0x8000);
    var result = operand1 * operand2;
    if(result > 0x7FFF || result < -0x8000)
    {
        this.flags |= 1 | flag_overflow;
    }
    else
    {
        this.flags &= ~1 & ~flag_overflow;
    }
    this.flags_changed = 0;
    return result;
}
CPU.prototype.mul32 = function(source_operand)
{
    var dest_operand = this.reg32s[reg_eax];
    var a00 = dest_operand & 0xFFFF; var a16 = dest_operand >>> 16; var b00 = source_operand & 0xFFFF; var b16 = source_operand >>> 16; var low_result = a00 * b00; var mid = (low_result >>> 16) + (a16 * b00 | 0) | 0; var high_result = mid >>> 16; mid = (mid & 0xFFFF) + (a00 * b16 | 0) | 0; low_result = (mid << 16) | low_result & 0xFFFF; high_result = ((mid >>> 16) + (a16 * b16 | 0) | 0) + high_result | 0;;
    this.reg32s[reg_eax] = low_result;
    this.reg32s[reg_edx] = high_result;
    if(high_result === 0)
    {
        this.flags &= ~1 & ~flag_overflow;
    }
    else
    {
        this.flags |= 1 | flag_overflow;
    }
    this.flags_changed = 0;
    //console.log(h(source_operand >>> 0, 8) + " * " + h(dest_operand >>> 0, 8));
    //console.log("= " + h(this.reg32[reg_edx], 8) + ":" + h(this.reg32[reg_eax], 8));
}
CPU.prototype.imul32 = function(source_operand)
{
    dbg_assert(source_operand < 0x80000000 && source_operand >= -0x80000000);
    var dest_operand = this.reg32s[reg_eax];
    var is_neg = false; if(dest_operand < 0) { is_neg = true; dest_operand = -dest_operand | 0; } if(source_operand < 0) { is_neg = !is_neg; source_operand = -source_operand | 0; } var a00 = dest_operand & 0xFFFF; var a16 = dest_operand >>> 16; var b00 = source_operand & 0xFFFF; var b16 = source_operand >>> 16; var low_result = a00 * b00; var mid = (low_result >>> 16) + (a16 * b00 | 0) | 0; var high_result = mid >>> 16; mid = (mid & 0xFFFF) + (a00 * b16 | 0) | 0; low_result = (mid << 16) | low_result & 0xFFFF; high_result = ((mid >>> 16) + (a16 * b16 | 0) | 0) + high_result | 0;; if(is_neg) { low_result = -low_result | 0; high_result = ~high_result + !low_result | 0; };
    this.reg32s[reg_eax] = low_result;
    this.reg32s[reg_edx] = high_result;
    if(high_result === (low_result >> 31))
    {
        this.flags &= ~1 & ~flag_overflow;
    }
    else
    {
        this.flags |= 1 | flag_overflow;
    }
    this.flags_changed = 0;
    //console.log(target_operand + " * " + source_operand);
    //console.log("= " + h(this.reg32[reg_edx]) + " " + h(this.reg32[reg_eax]));
}
/*
 * imul with 2 or 3 arguments
 * reg = reg * r/m
 * reg = imm * r/m
 */
CPU.prototype.imul_reg32 = function(operand1, operand2)
{
    dbg_assert(operand1 < 0x80000000 && operand1 >= -0x80000000);
    dbg_assert(operand2 < 0x80000000 && operand2 >= -0x80000000);
    var is_neg = false; if(operand1 < 0) { is_neg = true; operand1 = -operand1 | 0; } if(operand2 < 0) { is_neg = !is_neg; operand2 = -operand2 | 0; } var a00 = operand1 & 0xFFFF; var a16 = operand1 >>> 16; var b00 = operand2 & 0xFFFF; var b16 = operand2 >>> 16; var low_result = a00 * b00; var mid = (low_result >>> 16) + (a16 * b00 | 0) | 0; var high_result = mid >>> 16; mid = (mid & 0xFFFF) + (a00 * b16 | 0) | 0; low_result = (mid << 16) | low_result & 0xFFFF; high_result = ((mid >>> 16) + (a16 * b16 | 0) | 0) + high_result | 0;; if(is_neg) { low_result = -low_result | 0; high_result = ~high_result + !low_result | 0; };
    if(high_result === (low_result >> 31))
    {
        this.flags &= ~1 & ~flag_overflow;
    }
    else
    {
        this.flags |= 1 | flag_overflow;
    }
    this.flags_changed = 0;
    return low_result;
    //console.log(operand + " * " + source_operand);
    //console.log("= " + this.reg32[reg]);
}
CPU.prototype.div8 = function(source_operand)
{
    dbg_assert(source_operand >= 0 && source_operand < 0x100);
    var target_operand = this.reg16[reg_ax],
        result = target_operand / source_operand | 0;
    if(result >= 0x100 || source_operand === 0)
    {
        this.trigger_de();
    }
    else
    {
        this.reg8[reg_al] = result;
        this.reg8[reg_ah] = target_operand % source_operand;
    }
}
CPU.prototype.idiv8 = function(source_operand)
{
    dbg_assert(source_operand >= -0x80 && source_operand < 0x80);
    var target_operand = this.reg16s[reg_ax],
        result = target_operand / source_operand | 0;
    if(result >= 0x80 || result <= -0x81 || source_operand === 0)
    {
        this.trigger_de();
    }
    else
    {
        this.reg8[reg_al] = result;
        this.reg8[reg_ah] = target_operand % source_operand;
    }
}
CPU.prototype.div16 = function(source_operand)
{
    dbg_assert(source_operand >= 0 && source_operand < 0x10000);
    var
        target_operand = (this.reg16[reg_ax] | this.reg16[reg_dx] << 16) >>> 0,
        result = target_operand / source_operand | 0;
    if(result >= 0x10000 || result < 0 || source_operand === 0)
    {
        this.trigger_de();
    }
    else
    {
        this.reg16[reg_ax] = result;
        this.reg16[reg_dx] = target_operand % source_operand;
    }
}
CPU.prototype.idiv16 = function(source_operand)
{
    dbg_assert(source_operand >= -0x8000 && source_operand < 0x8000);
    var target_operand = this.reg16[reg_ax] | (this.reg16[reg_dx] << 16),
        result = target_operand / source_operand | 0;
    if(result >= 0x8000 || result <= -0x8001 || source_operand === 0)
    {
        this.trigger_de();
    }
    else
    {
        this.reg16[reg_ax] = result;
        this.reg16[reg_dx] = target_operand % source_operand;
    }
}
// If the dividend is too large, the division cannot be done precisely using
// JavaScript's double floating point numbers. Run simple long divsion until
// the dividend is small enough
CPU.prototype.div32 = function(source_operand)
{
    dbg_assert(source_operand >= 0 && source_operand <= 0xffffffff);
    var dest_operand_low = this.reg32[reg_eax],
        dest_operand_high = this.reg32[reg_edx];
    if(dest_operand_high >= source_operand || !source_operand) this.trigger_de(); var result = 0; if(dest_operand_high > 0x100000) { var m = 0; var i = 32; var q = source_operand; while(q > dest_operand_high) { q >>>= 1; i--; } while(dest_operand_high > 0x100000) { if(dest_operand_high >= q) { dest_operand_high -= q; var sub = source_operand << i >>> 0; if(sub > dest_operand_low) { dest_operand_high--; } dest_operand_low = dest_operand_low - sub >>> 0; result |= 1 << i } i--; q >>= 1; } result >>>= 0; } var div = dest_operand_low + dest_operand_high * 0x100000000; var mod = div % source_operand; result += div / source_operand | 0;;
    if(result >= 0x100000000 || source_operand === 0)
    {
        dbg_log("div32 #DE: " + h(dest_operand_high, 8) + ":" + h(dest_operand_low, 8) + " div " + h(source_operand, 8));
        this.trigger_de();
    }
    else
    {
        this.reg32s[reg_eax] = result;
        this.reg32s[reg_edx] = mod;
    }
    //console.log(h(dest_operand_high) + ":" + h(dest_operand_low) + " / " + h(source_operand));
    //console.log("= " + h(this.reg32[reg_eax]) + " rem " + h(this.reg32[reg_edx]));
}
CPU.prototype.idiv32 = function(source_operand)
{
    dbg_assert(source_operand < 0x80000000 && source_operand >= -0x80000000);
    var dest_operand_low = this.reg32[reg_eax],
        dest_operand_high = this.reg32s[reg_edx],
        div_is_neg = false,
        is_neg = false;
    if(source_operand < 0)
    {
        is_neg = true;
        source_operand = -source_operand;
    }
    if(dest_operand_high < 0)
    {
        div_is_neg = true;
        is_neg = !is_neg;
        dest_operand_low = -dest_operand_low >>> 0;
        dest_operand_high = ~dest_operand_high + !dest_operand_low;
    }
    if(dest_operand_high >= source_operand || !source_operand) this.trigger_de(); var result = 0; if(dest_operand_high > 0x100000) { var m = 0; var i = 32; var q = source_operand; while(q > dest_operand_high) { q >>>= 1; i--; } while(dest_operand_high > 0x100000) { if(dest_operand_high >= q) { dest_operand_high -= q; var sub = source_operand << i >>> 0; if(sub > dest_operand_low) { dest_operand_high--; } dest_operand_low = dest_operand_low - sub >>> 0; result |= 1 << i } i--; q >>= 1; } result >>>= 0; } var div = dest_operand_low + dest_operand_high * 0x100000000; var mod = div % source_operand; result += div / source_operand | 0;;
    if(is_neg)
    {
        result = -result | 0;
    }
    if(div_is_neg)
    {
        mod = -mod | 0;
    }
    if(result >= 0x80000000 || result <= -0x80000001 || source_operand === 0)
    {
        dbg_log("div32 #DE: " + h(dest_operand_high, 8) + ":" + h(dest_operand_low, 8) + " div " + h(source_operand, 8));
        this.trigger_de();
    }
    else
    {
        this.reg32s[reg_eax] = result;
        this.reg32s[reg_edx] = mod;
    }
    //console.log(h(dest_operand_high) + ":" + h(dest_operand_low) + " / " + h(source_operand));
    //console.log("= " + h(this.reg32[reg_eax]) + " rem " + h(this.reg32[reg_edx]));
}
CPU.prototype.xadd8 = function(source_operand, reg)
{
    var tmp = this.reg8[reg];
    this.reg8[reg] = source_operand;
    return this.add(source_operand, tmp, OPSIZE_8);
}
CPU.prototype.xadd16 = function(source_operand, reg)
{
    var tmp = this.reg16[reg];
    this.reg16[reg] = source_operand;
    return this.add(source_operand, tmp, OPSIZE_16);
}
CPU.prototype.xadd32 = function(source_operand, reg)
{
    var tmp = this.reg32s[reg];
    this.reg32s[reg] = source_operand;
    return this.add(source_operand, tmp, OPSIZE_32);
}
CPU.prototype.bcd_daa = function()
{
    //dbg_log("daa");
    // decimal adjust after addition
    var old_al = this.reg8[reg_al],
        old_cf = this.getcf(),
        old_af = this.getaf();
    this.flags &= ~1 & ~flag_adjust
    if((old_al & 0xF) > 9 || old_af)
    {
        this.reg8[reg_al] += 6;
        this.flags |= flag_adjust;
    }
    if(old_al > 0x99 || old_cf)
    {
        this.reg8[reg_al] += 0x60;
        this.flags |= 1;
    }
    this.last_result = this.reg8[reg_al];
    this.last_op_size = OPSIZE_8;
    this.last_op1 = this.last_op2 = 0;
    this.flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
}
CPU.prototype.bcd_das = function()
{
    //dbg_log("das");
    // decimal adjust after subtraction
    var old_al = this.reg8[reg_al],
        old_cf = this.getcf();
    this.flags &= ~1;
    if((old_al & 0xF) > 9 || this.getaf())
    {
        this.reg8[reg_al] -= 6;
        this.flags |= flag_adjust;
        this.flags = this.flags & ~1 | old_cf | this.reg8[reg_al] >> 7;
    }
    else
    {
        this.flags &= ~flag_adjust;
    }
    if(old_al > 0x99 || old_cf)
    {
        this.reg8[reg_al] -= 0x60;
        this.flags |= 1;
    }
    this.last_result = this.reg8[reg_al];
    this.last_op_size = OPSIZE_8;
    this.last_op1 = this.last_op2 = 0;
    this.flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
}
CPU.prototype.bcd_aam = function()
{
    //dbg_log("aam");
    // ascii adjust after multiplication
    var imm8 = this.read_imm8();
    if(imm8 === 0)
    {
        this.trigger_de();
    }
    else
    {
        var temp = this.reg8[reg_al];
        this.reg8[reg_ah] = temp / imm8;
        this.reg8[reg_al] = temp % imm8;
        this.last_result = this.reg8[reg_al];
        this.flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
        this.flags &= ~1 & ~flag_adjust & ~flag_overflow;
    }
}
CPU.prototype.bcd_aad = function()
{
    //dbg_log("aad");
    // ascii adjust before division
    var imm8 = this.read_imm8();
    this.last_result = this.reg8[reg_al] + this.reg8[reg_ah] * imm8 & 0xFF;
    this.reg16[reg_ax] = this.last_result;
    this.last_op_size = OPSIZE_8;
    this.flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
    this.flags &= ~1 & ~flag_adjust & ~flag_overflow;
}
CPU.prototype.bcd_aaa = function()
{
    //dbg_log("aaa");
    if((this.reg8[reg_al] & 0xF) > 9 || this.getaf())
    {
        this.reg16[reg_ax] += 6;
        this.reg8[reg_ah] += 1;
        this.flags |= flag_adjust | 1;
    }
    else
    {
        this.flags &= ~flag_adjust & ~1;
    }
    this.reg8[reg_al] &= 0xF;
    this.flags_changed &= ~flag_adjust & ~1;
};
CPU.prototype.bcd_aas = function()
{
    //dbg_log("aas");
    if((this.reg8[reg_al] & 0xF) > 9 || this.getaf())
    {
        this.reg16[reg_ax] -= 6;
        this.reg8[reg_ah] -= 1;
        this.flags |= flag_adjust | 1;
    }
    else
    {
        this.flags &= ~flag_adjust & ~1;
    }
    this.reg8[reg_al] &= 0xF;
    this.flags_changed &= ~flag_adjust & ~1;
}
/*                     \O
 * bitwise functions    | *                     /  *

 *
 * and, or, xor, test
 * shl, shr, sar, rol, ror, rcl, ror
 * shrd, shld
 *
 * bt, bts, btr, btc
 * bsf, bsr
 */
CPU.prototype.and = function(dest_operand, source_operand, op_size)
{
    this.last_result = dest_operand & source_operand;
    this.last_op_size = op_size;
    this.flags &= ~1 & ~flag_overflow & ~flag_adjust;
    this.flags_changed = flags_all & ~1 & ~flag_overflow & ~flag_adjust;
    return this.last_result;
}
CPU.prototype.or = function(dest_operand, source_operand, op_size)
{
    this.last_result = dest_operand | source_operand;
    this.last_op_size = op_size;
    this.flags &= ~1 & ~flag_overflow & ~flag_adjust;
    this.flags_changed = flags_all & ~1 & ~flag_overflow & ~flag_adjust;
    return this.last_result;
}
CPU.prototype.xor = function(dest_operand, source_operand, op_size)
{
    this.last_result = dest_operand ^ source_operand;
    this.last_op_size = op_size;
    this.flags &= ~1 & ~flag_overflow & ~flag_adjust;
    this.flags_changed = flags_all & ~1 & ~flag_overflow & ~flag_adjust;
    return this.last_result;
}
/*
 * rotates and shifts
 */
CPU.prototype.rol8 = function(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }
    count &= 7;
    var result = dest_operand << count | dest_operand >> (8 - count);
    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (result & 1)
                | (result << 11 ^ result << 4) & flag_overflow;
    return result;
}
CPU.prototype.rol16 = function(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }
    count &= 15;
    var result = dest_operand << count | dest_operand >> (16 - count);
    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (result & 1)
                | (result << 11 ^ result >> 4) & flag_overflow;
    return result;
}
CPU.prototype.rol32 = function(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }
    var result = dest_operand << count | dest_operand >>> (32 - count);
    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (result & 1)
                | (result << 11 ^ result >> 20) & flag_overflow;
    return result;
}
CPU.prototype.rcl8 = function(dest_operand, count)
{
    count %= 9;
    if(!count)
    {
        return dest_operand;
    }
    var result = dest_operand << count | this.getcf() << (count - 1) | dest_operand >> (9 - count);
    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (result >> 8 & 1)
                | (result << 3 ^ result << 4) & flag_overflow;
    return result;
}
CPU.prototype.rcl16 = function(dest_operand, count)
{
    count %= 17;
    if(!count)
    {
        return dest_operand;
    }
    var result = dest_operand << count | this.getcf() << (count - 1) | dest_operand >> (17 - count);
    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (result >> 16 & 1)
                | (result >> 5 ^ result >> 4) & flag_overflow;
    return result;
}
CPU.prototype.rcl32 = function(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }
    var result = dest_operand << count | this.getcf() << (count - 1);
    if(count > 1)
    {
        result |= dest_operand >>> (33 - count);
    }
    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >>> (32 - count) & 1);
    this.flags |= (this.flags << 11 ^ result >> 20) & flag_overflow;
    return result;
}
CPU.prototype.ror8 = function(dest_operand, count)
{
    count &= 7;
    if(!count)
    {
        return dest_operand;
    }
    var result = dest_operand >> count | dest_operand << (8 - count);
    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (result >> 7 & 1)
                | (result << 4 ^ result << 5) & flag_overflow;
    return result;
}
CPU.prototype.ror16 = function(dest_operand, count)
{
    count &= 15;
    if(!count)
    {
        return dest_operand;
    }
    var result = dest_operand >> count | dest_operand << (16 - count);
    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (result >> 15 & 1)
                | (result >> 4 ^ result >> 3) & flag_overflow;
    return result;
}
CPU.prototype.ror32 = function(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }
    var result = dest_operand >>> count | dest_operand << (32 - count);
    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (result >> 31 & 1)
                | (result >> 20 ^ result >> 19) & flag_overflow;
    return result;
}
CPU.prototype.rcr8 = function(dest_operand, count)
{
    count %= 9;
    if(!count)
    {
        return dest_operand;
    }
    var result = dest_operand >> count | this.getcf() << (8 - count) | dest_operand << (9 - count);
    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (result >> 8 & 1)
                | (result << 4 ^ result << 5) & flag_overflow;
    return result;
}
CPU.prototype.rcr16 = function(dest_operand, count)
{
    count %= 17;
    if(!count)
    {
        return dest_operand;
    }
    var result = dest_operand >> count | this.getcf() << (16 - count) | dest_operand << (17 - count);
    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (result >> 16 & 1)
                | (result >> 4 ^ result >> 3) & flag_overflow;
    return result;
}
CPU.prototype.rcr32 = function(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }
    var result = dest_operand >>> count | this.getcf() << (32 - count);
    if(count > 1)
    {
        result |= dest_operand << (33 - count);
    }
    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (dest_operand >> (count - 1) & 1)
                | (result >> 20 ^ result >> 19) & flag_overflow;
    return result;
}
CPU.prototype.shl8 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }
    this.last_result = dest_operand << count;
    this.last_op_size = OPSIZE_8;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (this.last_result >> 8 & 1)
                | (this.last_result << 3 ^ this.last_result << 4) & flag_overflow;
    return this.last_result;
}
CPU.prototype.shl16 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }
    this.last_result = dest_operand << count;
    this.last_op_size = OPSIZE_16;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (this.last_result >> 16 & 1)
                | (this.last_result >> 5 ^ this.last_result >> 4) & flag_overflow;
    return this.last_result;
}
CPU.prototype.shl32 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }
    this.last_result = dest_operand << count;
    this.last_op_size = OPSIZE_32;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    // test this
    this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >>> (32 - count) & 1);
    this.flags |= ((this.flags & 1) ^ (this.last_result >> 31 & 1)) << 11 & flag_overflow;
    return this.last_result;
}
CPU.prototype.shr8 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }
    this.last_result = dest_operand >> count;
    this.last_op_size = OPSIZE_8;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (dest_operand >> (count - 1) & 1)
                | (dest_operand >> 7 & 1) << 11 & flag_overflow;
    return this.last_result;
}
CPU.prototype.shr16 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }
    this.last_result = dest_operand >> count;
    this.last_op_size = OPSIZE_16;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (dest_operand >> (count - 1) & 1)
                | (dest_operand >> 4) & flag_overflow;
    return this.last_result;
}
CPU.prototype.shr32 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }
    this.last_result = dest_operand >>> count;
    this.last_op_size = OPSIZE_32;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow)
                | (dest_operand >>> (count - 1) & 1)
                | (dest_operand >> 20) & flag_overflow;
    return this.last_result;
}
CPU.prototype.sar8 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }
    this.last_result = dest_operand >> count;
    this.last_op_size = OPSIZE_8;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >> (count - 1) & 1);
    // of is zero
    return this.last_result;
}
CPU.prototype.sar16 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }
    this.last_result = dest_operand >> count;
    this.last_op_size = OPSIZE_16;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >> (count - 1) & 1);
    return this.last_result;
}
CPU.prototype.sar32 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }
    this.last_result = dest_operand >> count;
    this.last_op_size = OPSIZE_32;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >>> (count - 1) & 1);
    return this.last_result;
}
CPU.prototype.shrd16 = function(dest_operand, source_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }
    if(count <= 16)
    {
        this.last_result = dest_operand >> count | source_operand << (16 - count);
        this.flags = (this.flags & ~1) | (dest_operand >> (count - 1) & 1);
    }
    else
    {
        this.last_result = dest_operand << (32 - count) | source_operand >> (count - 16);
        this.flags = (this.flags & ~1) | (source_operand >> (count - 17) & 1);
    }
    this.last_op_size = OPSIZE_16;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~flag_overflow) | ((this.last_result ^ dest_operand) >> 4 & flag_overflow);
    return this.last_result;
}
CPU.prototype.shrd32 = function(dest_operand, source_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }
    this.last_result = dest_operand >>> count | source_operand << (32 - count);
    this.last_op_size = OPSIZE_32;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1) | (dest_operand >>> (count - 1) & 1);
    this.flags = (this.flags & ~flag_overflow) | ((this.last_result ^ dest_operand) >> 20 & flag_overflow);
    return this.last_result;
}
CPU.prototype.shld16 = function(dest_operand, source_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }
    if(count <= 16)
    {
        this.last_result = dest_operand << count | source_operand >>> (16 - count);
        this.flags = (this.flags & ~1) | (dest_operand >>> (16 - count) & 1);
    }
    else
    {
        this.last_result = dest_operand >> (32 - count) | source_operand << (count - 16);
        this.flags = (this.flags & ~1) | (source_operand >>> (32 - count) & 1);
    }
    this.last_op_size = OPSIZE_16;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~flag_overflow) | ((this.flags & 1) ^ (this.last_result >> 15 & 1)) << 11;
    return this.last_result;
}
CPU.prototype.shld32 = function(dest_operand, source_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }
    this.last_result = dest_operand << count | source_operand >>> (32 - count);
    this.last_op_size = OPSIZE_32;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1) | (dest_operand >>> (32 - count) & 1);
    this.flags = (this.flags & ~flag_overflow) | ((this.flags & 1) ^ (this.last_result >> 31 & 1)) << 11;
    return this.last_result;
}
CPU.prototype.bt_reg = function(bit_base, bit_offset)
{
    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;
}
CPU.prototype.btc_reg = function(bit_base, bit_offset)
{
    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;
    return bit_base ^ 1 << bit_offset;
}
CPU.prototype.bts_reg = function(bit_base, bit_offset)
{
    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;
    return bit_base | 1 << bit_offset;
}
CPU.prototype.btr_reg = function(bit_base, bit_offset)
{
    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;
    return bit_base & ~(1 << bit_offset);
}
CPU.prototype.bt_mem = function(virt_addr, bit_offset)
{
    var bit_base = this.safe_read8(virt_addr + (bit_offset >> 3));
    bit_offset &= 7;
    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;
}
CPU.prototype.btc_mem = function(virt_addr, bit_offset)
{
    var phys_addr = this.translate_address_write(virt_addr + (bit_offset >> 3));
    var bit_base = this.memory.read8(phys_addr);
    bit_offset &= 7;
    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;
    this.memory.write8(phys_addr, bit_base ^ 1 << bit_offset);
}
CPU.prototype.btr_mem = function(virt_addr, bit_offset)
{
    var phys_addr = this.translate_address_write(virt_addr + (bit_offset >> 3));
    var bit_base = this.memory.read8(phys_addr);
    bit_offset &= 7;
    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;
    this.memory.write8(phys_addr, bit_base & ~(1 << bit_offset));
}
CPU.prototype.bts_mem = function(virt_addr, bit_offset)
{
    var phys_addr = this.translate_address_write(virt_addr + (bit_offset >> 3));
    var bit_base = this.memory.read8(phys_addr);
    bit_offset &= 7;
    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;
    this.memory.write8(phys_addr, bit_base | 1 << bit_offset);
}
CPU.prototype.bsf16 = function(old, bit_base)
{
    this.flags_changed = 0;
    if(bit_base === 0)
    {
        this.flags |= flag_zero;
        // not defined in the docs, but value doesn't change on my intel this
        return old;
    }
    else
    {
        this.flags &= ~flag_zero;
        // http://jsperf.com/lowest-bit-index
        return v86util.int_log2(-bit_base & bit_base);
    }
}
CPU.prototype.bsf32 = function(old, bit_base)
{
    this.flags_changed = 0;
    if(bit_base === 0)
    {
        this.flags |= flag_zero;
        return old;
    }
    else
    {
        this.flags &= ~flag_zero;
        return v86util.int_log2((-bit_base & bit_base) >>> 0);
    }
}
CPU.prototype.bsr16 = function(old, bit_base)
{
    this.flags_changed = 0;
    if(bit_base === 0)
    {
        this.flags |= flag_zero;
        return old;
    }
    else
    {
        this.flags &= ~flag_zero;
        return v86util.int_log2(bit_base);
    }
}
CPU.prototype.bsr32 = function(old, bit_base)
{
    this.flags_changed = 0;
    if(bit_base === 0)
    {
        this.flags |= flag_zero;
        return old;
    }
    else
    {
        this.flags &= ~flag_zero;
        return v86util.int_log2(bit_base >>> 0);
    }
}
CPU.prototype.popcnt = function(v)
{
    this.flags_changed = 0;
    this.flags &= ~flag_overflow & ~flag_sign & ~flag_zero
                & ~flag_adjust & ~flag_parity & ~1;
    if(v)
    {
        // http://graphics.stanford.edu/~seander/bithacks.html#CountBitsSetParallel
        v = v - ((v >> 1) & 0x55555555);
        v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
        return ((v + (v >> 4) & 0xF0F0F0F) * 0x1010101) >> 24;
    }
    else
    {
        this.flags |= flag_zero;
        return 0;
    }
};
"use strict";
/*
 * string operations
 *
 *       cmp  si  di
 * movs   0    1   1/w    A4
 * cmps   1    1   1/r    A6
 * stos   0    0   1/w    AA
 * lods   0    1   0      AC
 * scas   1    0   1/r    AE
 * ins    0    0   1/w
 * outs   0    1   0
 */
var data_dest,
    data_src;
CPU.prototype.string_instruction = function(s, use_cmp, use_si, use_di, fn, aligned_fn)
{
    var cpu = this;
    var src, dest, phys_dest, phys_src;
    var size = cpu.flags & flag_direction ? -(s >> 3) : s >> 3;
    var cont = false;
    if(use_cmp && !use_si) {
        if(s === 32) data_src = cpu.reg32s[reg_eax];
        else if(s === 16) data_src = cpu.reg16[reg_ax];
        else data_src = cpu.reg8[reg_al]
    }
    if(use_di) dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;
    if(use_si) src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;
    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE) {
        var count = cpu.regv[cpu.reg_vcx] >>> 0,
            start_count = count;
        if(count === 0) return;
        var next_cycle = 0x4000;
        var aligned = s === 8 ||
            ((!use_di || !(dest & (s >> 3) - 1)) && (!use_si || !(src & (s >> 3) - 1)));
        if(aligned) {
            var single_size = size >> 31 | 1;
            if(cpu.paging) {
                if(use_si) {
                    next_cycle = (single_size >> 1 ^ ~src) & 0xFFF;
                    phys_src = cpu.translate_address_read(src);
                }
                if(use_di) {
                    next_cycle = Math.min(next_cycle, (single_size >> 1 ^ ~dest) & 0xFFF);
                    phys_dest = use_cmp ? cpu.translate_address_read(dest) : cpu.translate_address_write(dest);
                }
                if(s === 32) next_cycle >>= 2;
                else if(s === 16) next_cycle >>= 1;
            } else {
                if(use_di) phys_dest = dest;
                if(use_si) phys_src = src;
            }
            if(s === 32) { if(use_di) phys_dest >>>= 2; if(use_si) phys_src >>>= 2; }
            else if(s === 16) { if(use_di) phys_dest >>>= 1; if(use_si) phys_src >>>= 1; }
            do {
                aligned_fn(cpu, phys_src, phys_dest);
                if(use_di) phys_dest += single_size;
                if(use_si) phys_src += single_size;
                cont = --count !== 0 && (!use_cmp || (data_src === data_dest) === (cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_Z));
            } while(cont && next_cycle--)
            var diff = size * (start_count - count) | 0;
            if(use_di) cpu.regv[cpu.reg_vdi] += diff;
            if(use_si) cpu.regv[cpu.reg_vsi] += diff;
            cpu.regv[cpu.reg_vcx] = count;
            cpu.timestamp_counter += start_count - count;
        } else {
            do {
                fn(cpu, src, dest);
                if(use_di) dest += size, cpu.regv[cpu.reg_vdi] += size;
                if(use_si) src += size, cpu.regv[cpu.reg_vsi] += size;
                cont = --cpu.regv[cpu.reg_vcx] !== 0 && (!use_cmp || (data_src === data_dest) === (cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_Z));
            } while(cont && next_cycle--)
        }
    } else {
        if(s === 8) {
            if(use_si) phys_src = cpu.translate_address_read(src);
            if(use_di) phys_dest = use_cmp ? cpu.translate_address_read(dest) : cpu.translate_address_write(dest);
            aligned_fn(cpu, phys_src, phys_dest);
        } else { fn(cpu, src, dest); }
        if(use_di) cpu.regv[cpu.reg_vdi] += size;
        if(use_si) cpu.regv[cpu.reg_vsi] += size;
    }
    if(use_cmp)
    {
        if(s === 32) cpu.sub(data_src, data_dest, OPSIZE_32);
        else if(s === 16) cpu.sub(data_src, data_dest, OPSIZE_16);
        else cpu.sub(data_src, data_dest, OPSIZE_8);
    }
    if(cont)
    {
        cpu.instruction_pointer = cpu.previous_ip;
    }
};
function movsb(cpu)
{
    cpu.string_instruction(8, false, true, true,
        function(cpu, src, dest) {
            // no unaligned fn, bytewise is always aligned
            dbg_assert(false);
        }, function(cpu, phys_src, phys_dest) {
            cpu.memory.write8(phys_dest, cpu.memory.read8(phys_src));
        });
}
function movsw(cpu)
{
    cpu.string_instruction(16, false, true, true,
        function(cpu, src, dest) {
            cpu.safe_write16(dest, cpu.safe_read16(src));
        }, function(cpu, phys_src, phys_dest) {
            cpu.memory.write_aligned16(phys_dest, cpu.memory.read_aligned16(phys_src));
        });
}
function movsd(cpu)
{
    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
    {
        // often used by memcpy, well worth optimizing
        //   using cpu.memory.mem32s.set
        var ds = cpu.get_seg_prefix(reg_ds),
            src = ds + cpu.regv[cpu.reg_vsi],
            es = cpu.get_seg(reg_es),
            dest = es + cpu.regv[cpu.reg_vdi],
            count = cpu.regv[cpu.reg_vcx] >>> 0;
        if(!count)
        {
            return;
        }
        // must be page-aligned if cpu.paging is enabled
        // and dword-aligned in general
        var align_mask = cpu.paging ? 0xFFF : 3;
        if((dest & align_mask) === 0 &&
           (src & align_mask) === 0 &&
           // If df is set, alignment works a different
           // This should be unlikely
           (cpu.flags & flag_direction) === 0)
        {
            var cont = false;
            if(cpu.paging)
            {
                src = cpu.translate_address_read(src);
                dest = cpu.translate_address_write(dest);
                if(count > 0x400)
                {
                    count = 0x400;
                    cont = true;
                }
            }
            if(!cpu.io.in_mmap_range(src, count) &&
               !cpu.io.in_mmap_range(dest, count))
            {
                var diff = count << 2;
                cpu.regv[cpu.reg_vcx] -= count;
                cpu.regv[cpu.reg_vdi] += diff;
                cpu.regv[cpu.reg_vsi] += diff;
                dest >>= 2;
                src >>= 2;
                cpu.memory.mem32s.set(cpu.memory.mem32s.subarray(src, src + count), dest);
                if(cont)
                {
                    cpu.instruction_pointer = cpu.previous_ip;
                }
                return;
            }
        }
    }
    cpu.string_instruction(32, false, true, true,
        function(cpu, src, dest) {
            cpu.safe_write32(dest, cpu.safe_read32s(src));
        }, function(cpu, phys_src, phys_dest) {
            cpu.memory.write_aligned32(phys_dest, cpu.memory.read_aligned32(phys_src));
        });
}
function cmpsb(cpu)
{
    cpu.string_instruction(8, true, true, true,
        function(cpu, src, dest) {
            dbg_assert(false);
        }, function(cpu, phys_src, phys_dest) {
            data_dest = cpu.memory.read8(phys_dest);
            data_src = cpu.memory.read8(phys_src);
        });
}
function cmpsw(cpu)
{
    cpu.string_instruction(16, true, true, true,
        function(cpu, src, dest) {
            data_dest = cpu.safe_read16(dest);
            data_src = cpu.safe_read16(src);
        }, function(cpu, phys_src, phys_dest) {
            data_dest = cpu.memory.read_aligned16(phys_dest);
            data_src = cpu.memory.read_aligned16(phys_src);
        });
}
function cmpsd(cpu)
{
    cpu.string_instruction(32, true, true, true,
        function(cpu, src, dest) {
            data_dest = cpu.safe_read32s(dest);
            data_src = cpu.safe_read32s(src);
        }, function(cpu, phys_src, phys_dest) {
            data_dest = cpu.memory.read_aligned32(phys_dest);
            data_src = cpu.memory.read_aligned32(phys_src);
        });
}
function stosb(cpu)
{
    var data = cpu.reg8[reg_al];
    cpu.string_instruction(8, false, false, true,
        function(cpu, src, dest) {
            dbg_assert(false);
        }, function(cpu, phys_src, phys_dest) {
            cpu.memory.write8(phys_dest, data);
        });
}
function stosw(cpu)
{
    var data = cpu.reg16[reg_ax];
    cpu.string_instruction(16, false, false, true,
        function(cpu, src, dest) {
            cpu.safe_write16(dest, data);
        }, function(cpu, phys_src, phys_dest) {
            cpu.memory.write_aligned16(phys_dest, data);
        });
}
function stosd(cpu)
{
    //dbg_log("stosd " + ((cpu.reg32s[reg_edi] & 3) ? "mis" : "") + "aligned", LOG_CPU);
    var data = cpu.reg32s[reg_eax];
    cpu.string_instruction(32, false, false, true,
        function(cpu, src, dest) {
            cpu.safe_write32(dest, data);
        }, function(cpu, phys_src, phys_dest) {
            cpu.memory.write_aligned32(phys_dest, data);
        });
}
function lodsb(cpu)
{
    cpu.string_instruction(8, false, true, false,
        function(cpu, src, dest) {
            dbg_assert(false);
        }, function(cpu, phys_src, phys_dest) {
            cpu.reg8[reg_al] = cpu.memory.read8(phys_src);
        });
}
function lodsw(cpu)
{
    cpu.string_instruction(16, false, true, false,
        function(cpu, src, dest) {
            cpu.reg16[reg_ax] = cpu.safe_read16(src);
        }, function(cpu, phys_src, phys_dest) {
            cpu.reg16[reg_ax] = cpu.memory.read_aligned16(phys_src);
        });
}
function lodsd(cpu)
{
    cpu.string_instruction(32, false, true, false,
        function(cpu, src, dest) {
            cpu.reg32s[reg_eax] = cpu.safe_read32s(src);
        }, function(cpu, phys_src, phys_dest) {
            cpu.reg32s[reg_eax] = cpu.memory.read_aligned32(phys_src);
        });
}
function scasb(cpu)
{
    cpu.string_instruction(8, true, false, true,
        function(cpu, src, dest) {
            dbg_assert(false);
        }, function(cpu, phys_src, phys_dest) {
            data_dest = cpu.memory.read8(phys_dest);
        });
}
function scasw(cpu)
{
    cpu.string_instruction(16, true, false, true,
        function(cpu, src, dest) {
            data_dest = cpu.safe_read16(dest);
        }, function(cpu, phys_src, phys_dest) {
            data_dest = cpu.memory.read_aligned16(phys_dest);
        });
}
function scasd(cpu)
{
    cpu.string_instruction(32, true, false, true,
        function(cpu, src, dest) {
            data_dest = cpu.safe_read32s(dest);
        }, function(cpu, phys_src, phys_dest) {
            data_dest = cpu.memory.read_aligned32(phys_dest);
        });
}
function insb(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 1);
    cpu.string_instruction(8, false, false, true,
        function(cpu, src, dest) {
            dbg_assert(false);
        }, function(cpu, phys_src, phys_dest) {
            cpu.memory.write8(phys_dest, cpu.io.port_read8(port));
        });
}
function insw(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 2);
    cpu.string_instruction(16, false, false, true,
        function(cpu, src, dest) {
            cpu.safe_write16(dest, cpu.io.port_read16(port));
        }, function(cpu, phys_src, phys_dest) {
            cpu.memory.write_aligned16(phys_dest, cpu.io.port_read16(port));
        });
}
function insd(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 4);
    cpu.string_instruction(32, false, false, true,
        function(cpu, src, dest) {
            cpu.safe_write32(dest, cpu.io.port_read32(port));
        }, function(cpu, phys_src, phys_dest) {
            cpu.memory.write_aligned32(phys_dest, cpu.io.port_read32(port));
        });
}
function outsb(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 1);
    cpu.string_instruction(8, false, true, false,
        function(cpu, src, dest) {
            dbg_assert(false);
        }, function(cpu, phys_src, phys_dest) {
            cpu.io.port_write8(port, cpu.memory.read8(phys_src));
        });
}
function outsw(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 2);
    cpu.string_instruction(16, false, true, false,
        function(cpu, src, dest) {
            cpu.io.port_write16(port, cpu.safe_read16(src));
        }, function(cpu, phys_src, phys_dest) {
            cpu.io.port_write16(port, cpu.memory.read_aligned16(phys_src));
        });
}
function outsd(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 4);
    cpu.string_instruction(32, false, true, false,
        function(cpu, src, dest) {
            cpu.io.port_write32(port, cpu.safe_read32s(src));
        }, function(cpu, phys_src, phys_dest) {
            cpu.io.port_write32(port, cpu.memory.read_aligned32(phys_src));
        });
}
"use strict";
var
    table16 = [],
    table32 = [],
    table0F_16 = [],
    table0F_32 = [];
CPU.prototype.table16 = table16;
CPU.prototype.table32 = table32;
CPU.prototype.table0F_16 = table0F_16;
CPU.prototype.table0F_32 = table0F_32;
// opcode with modm byte
// opcode that has a 16 and a 32 bit version
// very special, should be somewhere else?
// equivalent to switch(modrm_byte >> 3 & 7)
//#define sub_op(i0, i1, i2, i3, i4, i5, i6, i7) //    if(modrm_byte & 0x20) { sub_op1(i4, i5, i6, i7) }//    else { sub_op1(i0, i1, i2, i3) }
//
//#define sub_op1(i0, i1, i2, i3)//    if(modrm_byte & 0x10) { sub_op2(i2, i3) }//    else { sub_op2(i0, i1) }
//
//#define sub_op2(i0, i1)//    if(modrm_byte & 0x08) { i1 }//    else { i0 }
// Evaluate the modrm byte of the instruction and run one
//   of the 8 instructions depending on the middle 3 bits.
// Used by 0x80-0x83, 0xd0-0xd3, 0xc0-0xc1, 0xf6-0xf7 and 0xff
// equivalent to switch(modrm_byte >> 3 & 7)
//#define reg_g32 cpu.reg32[modrm_byte >> 3 & 7] 
// use modrm_byte to write a value to cpu.memory or register 
// (without reading it beforehand)
// use modrm_byte to write a value to cpu.memory or register,
// using the previous data from cpu.memory or register.
// op is a function call that needs to return the result
// instructions start here
table16[0x00] = table32[0x00] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = cpu.add(data, cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], OPSIZE_8); if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; } } }; table16[0x00 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.add(data, cpu.reg16[modrm_byte >> 2 & 14], OPSIZE_16); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; } } }; table32[0x00 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.add(data, cpu.reg32s[modrm_byte >> 3 & 7], OPSIZE_32); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; } } }; table16[0x00 | 2] = table32[0x00 | 2] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1] = cpu.add(cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], data, OPSIZE_8); } }; table16[0x00 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.add(cpu.reg16[modrm_byte >> 2 & 14], data, OPSIZE_16); } }; table32[0x00 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.add(cpu.reg32s[modrm_byte >> 3 & 7], data, OPSIZE_32); } }; table16[0x00 | 4] = table32[0x00 | 4] = function(cpu) { { cpu.reg8[reg_al] = cpu.add(cpu.reg8[reg_al], cpu.read_imm8(), OPSIZE_8); } }; table16[0x00 | 5] = function(cpu) { { cpu.reg16[reg_ax] = cpu.add(cpu.reg16[reg_ax], cpu.read_imm16(), OPSIZE_16); } }; table32[0x00 | 5] = function(cpu) { { cpu.reg32s[reg_eax] = cpu.add(cpu.reg32s[reg_eax], cpu.read_imm32s(), OPSIZE_32); } };;
table16[0x06] = function(cpu) { { cpu.push16(cpu.sreg[reg_es]); } }; table32[0x06] = function(cpu) { { cpu.push32(cpu.sreg[reg_es]); } };;
table16[0x07] = function(cpu) { { cpu.switch_seg(reg_es, cpu.safe_read16(cpu.get_stack_pointer(0))); cpu.stack_reg[cpu.reg_vsp] += 2; } }; table32[0x07] = function(cpu) { { cpu.switch_seg(reg_es, cpu.safe_read16(cpu.get_stack_pointer(0))); cpu.stack_reg[cpu.reg_vsp] += 4; } };;;
table16[0x08] = table32[0x08] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = cpu.or(data, cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], OPSIZE_8); if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; } } }; table16[0x08 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.or(data, cpu.reg16[modrm_byte >> 2 & 14], OPSIZE_16); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; } } }; table32[0x08 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.or(data, cpu.reg32s[modrm_byte >> 3 & 7], OPSIZE_32); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; } } }; table16[0x08 | 2] = table32[0x08 | 2] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1] = cpu.or(cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], data, OPSIZE_8); } }; table16[0x08 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.or(cpu.reg16[modrm_byte >> 2 & 14], data, OPSIZE_16); } }; table32[0x08 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.or(cpu.reg32s[modrm_byte >> 3 & 7], data, OPSIZE_32); } }; table16[0x08 | 4] = table32[0x08 | 4] = function(cpu) { { cpu.reg8[reg_al] = cpu.or(cpu.reg8[reg_al], cpu.read_imm8(), OPSIZE_8); } }; table16[0x08 | 5] = function(cpu) { { cpu.reg16[reg_ax] = cpu.or(cpu.reg16[reg_ax], cpu.read_imm16(), OPSIZE_16); } }; table32[0x08 | 5] = function(cpu) { { cpu.reg32s[reg_eax] = cpu.or(cpu.reg32s[reg_eax], cpu.read_imm32s(), OPSIZE_32); } };;
table16[0x0E] = function(cpu) { { cpu.push16(cpu.sreg[reg_cs]); } }; table32[0x0E] = function(cpu) { { cpu.push32(cpu.sreg[reg_cs]); } };;
table16[0x0F] = function(cpu) { { cpu.table0F_16[cpu.read_imm8()](cpu); } }; table32[0x0F] = function(cpu) { { cpu.table0F_32[cpu.read_imm8()](cpu); } };;
table16[0x10] = table32[0x10] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = cpu.adc(data, cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], OPSIZE_8); if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; } } }; table16[0x10 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.adc(data, cpu.reg16[modrm_byte >> 2 & 14], OPSIZE_16); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; } } }; table32[0x10 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.adc(data, cpu.reg32s[modrm_byte >> 3 & 7], OPSIZE_32); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; } } }; table16[0x10 | 2] = table32[0x10 | 2] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1] = cpu.adc(cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], data, OPSIZE_8); } }; table16[0x10 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.adc(cpu.reg16[modrm_byte >> 2 & 14], data, OPSIZE_16); } }; table32[0x10 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.adc(cpu.reg32s[modrm_byte >> 3 & 7], data, OPSIZE_32); } }; table16[0x10 | 4] = table32[0x10 | 4] = function(cpu) { { cpu.reg8[reg_al] = cpu.adc(cpu.reg8[reg_al], cpu.read_imm8(), OPSIZE_8); } }; table16[0x10 | 5] = function(cpu) { { cpu.reg16[reg_ax] = cpu.adc(cpu.reg16[reg_ax], cpu.read_imm16(), OPSIZE_16); } }; table32[0x10 | 5] = function(cpu) { { cpu.reg32s[reg_eax] = cpu.adc(cpu.reg32s[reg_eax], cpu.read_imm32s(), OPSIZE_32); } };;
table16[0x16] = function(cpu) { { cpu.push16(cpu.sreg[reg_ss]); } }; table32[0x16] = function(cpu) { { cpu.push32(cpu.sreg[reg_ss]); } };;
table16[0x17] = function(cpu) { { cpu.switch_seg(reg_ss, cpu.safe_read16(cpu.get_stack_pointer(0))); cpu.stack_reg[cpu.reg_vsp] += 2; } }; table32[0x17] = function(cpu) { { cpu.switch_seg(reg_ss, cpu.safe_read16(cpu.get_stack_pointer(0))); cpu.stack_reg[cpu.reg_vsp] += 4; } };;;
table16[0x18] = table32[0x18] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = cpu.sbb(data, cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], OPSIZE_8); if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; } } }; table16[0x18 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.sbb(data, cpu.reg16[modrm_byte >> 2 & 14], OPSIZE_16); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; } } }; table32[0x18 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.sbb(data, cpu.reg32s[modrm_byte >> 3 & 7], OPSIZE_32); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; } } }; table16[0x18 | 2] = table32[0x18 | 2] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1] = cpu.sbb(cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], data, OPSIZE_8); } }; table16[0x18 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.sbb(cpu.reg16[modrm_byte >> 2 & 14], data, OPSIZE_16); } }; table32[0x18 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.sbb(cpu.reg32s[modrm_byte >> 3 & 7], data, OPSIZE_32); } }; table16[0x18 | 4] = table32[0x18 | 4] = function(cpu) { { cpu.reg8[reg_al] = cpu.sbb(cpu.reg8[reg_al], cpu.read_imm8(), OPSIZE_8); } }; table16[0x18 | 5] = function(cpu) { { cpu.reg16[reg_ax] = cpu.sbb(cpu.reg16[reg_ax], cpu.read_imm16(), OPSIZE_16); } }; table32[0x18 | 5] = function(cpu) { { cpu.reg32s[reg_eax] = cpu.sbb(cpu.reg32s[reg_eax], cpu.read_imm32s(), OPSIZE_32); } };;
table16[0x1E] = function(cpu) { { cpu.push16(cpu.sreg[reg_ds]); } }; table32[0x1E] = function(cpu) { { cpu.push32(cpu.sreg[reg_ds]); } };;
table16[0x1F] = function(cpu) { { cpu.switch_seg(reg_ds, cpu.safe_read16(cpu.get_stack_pointer(0))); cpu.stack_reg[cpu.reg_vsp] += 2; } }; table32[0x1F] = function(cpu) { { cpu.switch_seg(reg_ds, cpu.safe_read16(cpu.get_stack_pointer(0))); cpu.stack_reg[cpu.reg_vsp] += 4; } };;;
table16[0x20] = table32[0x20] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = cpu.and(data, cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], OPSIZE_8); if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; } } }; table16[0x20 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.and(data, cpu.reg16[modrm_byte >> 2 & 14], OPSIZE_16); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; } } }; table32[0x20 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.and(data, cpu.reg32s[modrm_byte >> 3 & 7], OPSIZE_32); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; } } }; table16[0x20 | 2] = table32[0x20 | 2] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1] = cpu.and(cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], data, OPSIZE_8); } }; table16[0x20 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.and(cpu.reg16[modrm_byte >> 2 & 14], data, OPSIZE_16); } }; table32[0x20 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.and(cpu.reg32s[modrm_byte >> 3 & 7], data, OPSIZE_32); } }; table16[0x20 | 4] = table32[0x20 | 4] = function(cpu) { { cpu.reg8[reg_al] = cpu.and(cpu.reg8[reg_al], cpu.read_imm8(), OPSIZE_8); } }; table16[0x20 | 5] = function(cpu) { { cpu.reg16[reg_ax] = cpu.and(cpu.reg16[reg_ax], cpu.read_imm16(), OPSIZE_16); } }; table32[0x20 | 5] = function(cpu) { { cpu.reg32s[reg_eax] = cpu.and(cpu.reg32s[reg_eax], cpu.read_imm32s(), OPSIZE_32); } };;
table16[0x26] = table32[0x26] = function(cpu) { { cpu.seg_prefix(reg_es); } };;
table16[0x27] = table32[0x27] = function(cpu) { { cpu.bcd_daa(); } };;
table16[0x28] = table32[0x28] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = cpu.sub(data, cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], OPSIZE_8); if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; } } }; table16[0x28 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.sub(data, cpu.reg16[modrm_byte >> 2 & 14], OPSIZE_16); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; } } }; table32[0x28 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.sub(data, cpu.reg32s[modrm_byte >> 3 & 7], OPSIZE_32); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; } } }; table16[0x28 | 2] = table32[0x28 | 2] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1] = cpu.sub(cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], data, OPSIZE_8); } }; table16[0x28 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.sub(cpu.reg16[modrm_byte >> 2 & 14], data, OPSIZE_16); } }; table32[0x28 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.sub(cpu.reg32s[modrm_byte >> 3 & 7], data, OPSIZE_32); } }; table16[0x28 | 4] = table32[0x28 | 4] = function(cpu) { { cpu.reg8[reg_al] = cpu.sub(cpu.reg8[reg_al], cpu.read_imm8(), OPSIZE_8); } }; table16[0x28 | 5] = function(cpu) { { cpu.reg16[reg_ax] = cpu.sub(cpu.reg16[reg_ax], cpu.read_imm16(), OPSIZE_16); } }; table32[0x28 | 5] = function(cpu) { { cpu.reg32s[reg_eax] = cpu.sub(cpu.reg32s[reg_eax], cpu.read_imm32s(), OPSIZE_32); } };;
table16[0x2E] = table32[0x2E] = function(cpu) { { cpu.seg_prefix(reg_cs); } };;
table16[0x2F] = table32[0x2F] = function(cpu) { { cpu.bcd_das(); } };;
table16[0x30] = table32[0x30] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = cpu.xor(data, cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], OPSIZE_8); if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; } } }; table16[0x30 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.xor(data, cpu.reg16[modrm_byte >> 2 & 14], OPSIZE_16); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; } } }; table32[0x30 | 1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.xor(data, cpu.reg32s[modrm_byte >> 3 & 7], OPSIZE_32); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; } } }; table16[0x30 | 2] = table32[0x30 | 2] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1] = cpu.xor(cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], data, OPSIZE_8); } }; table16[0x30 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.xor(cpu.reg16[modrm_byte >> 2 & 14], data, OPSIZE_16); } }; table32[0x30 | 3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.xor(cpu.reg32s[modrm_byte >> 3 & 7], data, OPSIZE_32); } }; table16[0x30 | 4] = table32[0x30 | 4] = function(cpu) { { cpu.reg8[reg_al] = cpu.xor(cpu.reg8[reg_al], cpu.read_imm8(), OPSIZE_8); } }; table16[0x30 | 5] = function(cpu) { { cpu.reg16[reg_ax] = cpu.xor(cpu.reg16[reg_ax], cpu.read_imm16(), OPSIZE_16); } }; table32[0x30 | 5] = function(cpu) { { cpu.reg32s[reg_eax] = cpu.xor(cpu.reg32s[reg_eax], cpu.read_imm32s(), OPSIZE_32); } };;
table16[0x36] = table32[0x36] = function(cpu) { { cpu.seg_prefix(reg_ss); } };;
table16[0x37] = table32[0x37] = function(cpu) { { cpu.bcd_aaa(); } };;
table16[0x38] = table32[0x38] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.sub(data, cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], OPSIZE_8); } };
table16[0x39] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.sub(data, cpu.reg16[modrm_byte >> 2 & 14], OPSIZE_16); } }; table32[0x39] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.sub(data, cpu.reg32s[modrm_byte >> 3 & 7], OPSIZE_32); } };
table16[0x3A] = table32[0x3A] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.sub(cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], data, OPSIZE_8); } };
table16[0x3B] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.sub(cpu.reg16[modrm_byte >> 2 & 14], data, OPSIZE_16); } }; table32[0x3B] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.sub(cpu.reg32s[modrm_byte >> 3 & 7], data, OPSIZE_32); } };
table16[0x3C] = table32[0x3C] = function(cpu) { { cpu.sub(cpu.reg8[reg_al], cpu.read_imm8(), OPSIZE_8); } };
table16[0x3D] = function(cpu) { { cpu.sub(cpu.reg16[reg_ax], cpu.read_imm16(), OPSIZE_16); } }; table32[0x3D] = function(cpu) { { cpu.sub(cpu.reg32s[reg_eax], cpu.read_imm32s(), OPSIZE_32); } };
table16[0x3E] = table32[0x3E] = function(cpu) { { cpu.seg_prefix(reg_ds); } };;
table16[0x3F] = table32[0x3F] = function(cpu) { { cpu.bcd_aas(); } };;
table16[0x40] = function(cpu) { { cpu.reg16[reg_ax] = cpu.inc(cpu.reg16[reg_ax], OPSIZE_16); } }; table32[0x40] = function(cpu) { { cpu.reg32s[reg_eax] = cpu.inc(cpu.reg32s[reg_eax], OPSIZE_32); } };;
table16[0x41] = function(cpu) { { cpu.reg16[reg_cx] = cpu.inc(cpu.reg16[reg_cx], OPSIZE_16); } }; table32[0x41] = function(cpu) { { cpu.reg32s[reg_ecx] = cpu.inc(cpu.reg32s[reg_ecx], OPSIZE_32); } };;
table16[0x42] = function(cpu) { { cpu.reg16[reg_dx] = cpu.inc(cpu.reg16[reg_dx], OPSIZE_16); } }; table32[0x42] = function(cpu) { { cpu.reg32s[reg_edx] = cpu.inc(cpu.reg32s[reg_edx], OPSIZE_32); } };;
table16[0x43] = function(cpu) { { cpu.reg16[reg_bx] = cpu.inc(cpu.reg16[reg_bx], OPSIZE_16); } }; table32[0x43] = function(cpu) { { cpu.reg32s[reg_ebx] = cpu.inc(cpu.reg32s[reg_ebx], OPSIZE_32); } };;
table16[0x44] = function(cpu) { { cpu.reg16[reg_sp] = cpu.inc(cpu.reg16[reg_sp], OPSIZE_16); } }; table32[0x44] = function(cpu) { { cpu.reg32s[reg_esp] = cpu.inc(cpu.reg32s[reg_esp], OPSIZE_32); } };;
table16[0x45] = function(cpu) { { cpu.reg16[reg_bp] = cpu.inc(cpu.reg16[reg_bp], OPSIZE_16); } }; table32[0x45] = function(cpu) { { cpu.reg32s[reg_ebp] = cpu.inc(cpu.reg32s[reg_ebp], OPSIZE_32); } };;
table16[0x46] = function(cpu) { { cpu.reg16[reg_si] = cpu.inc(cpu.reg16[reg_si], OPSIZE_16); } }; table32[0x46] = function(cpu) { { cpu.reg32s[reg_esi] = cpu.inc(cpu.reg32s[reg_esi], OPSIZE_32); } };;
table16[0x47] = function(cpu) { { cpu.reg16[reg_di] = cpu.inc(cpu.reg16[reg_di], OPSIZE_16); } }; table32[0x47] = function(cpu) { { cpu.reg32s[reg_edi] = cpu.inc(cpu.reg32s[reg_edi], OPSIZE_32); } };;
table16[0x48] = function(cpu) { { cpu.reg16[reg_ax] = cpu.dec(cpu.reg16[reg_ax], OPSIZE_16); } }; table32[0x48] = function(cpu) { { cpu.reg32s[reg_eax] = cpu.dec(cpu.reg32s[reg_eax], OPSIZE_32); } };;
table16[0x49] = function(cpu) { { cpu.reg16[reg_cx] = cpu.dec(cpu.reg16[reg_cx], OPSIZE_16); } }; table32[0x49] = function(cpu) { { cpu.reg32s[reg_ecx] = cpu.dec(cpu.reg32s[reg_ecx], OPSIZE_32); } };;
table16[0x4A] = function(cpu) { { cpu.reg16[reg_dx] = cpu.dec(cpu.reg16[reg_dx], OPSIZE_16); } }; table32[0x4A] = function(cpu) { { cpu.reg32s[reg_edx] = cpu.dec(cpu.reg32s[reg_edx], OPSIZE_32); } };;
table16[0x4B] = function(cpu) { { cpu.reg16[reg_bx] = cpu.dec(cpu.reg16[reg_bx], OPSIZE_16); } }; table32[0x4B] = function(cpu) { { cpu.reg32s[reg_ebx] = cpu.dec(cpu.reg32s[reg_ebx], OPSIZE_32); } };;
table16[0x4C] = function(cpu) { { cpu.reg16[reg_sp] = cpu.dec(cpu.reg16[reg_sp], OPSIZE_16); } }; table32[0x4C] = function(cpu) { { cpu.reg32s[reg_esp] = cpu.dec(cpu.reg32s[reg_esp], OPSIZE_32); } };;
table16[0x4D] = function(cpu) { { cpu.reg16[reg_bp] = cpu.dec(cpu.reg16[reg_bp], OPSIZE_16); } }; table32[0x4D] = function(cpu) { { cpu.reg32s[reg_ebp] = cpu.dec(cpu.reg32s[reg_ebp], OPSIZE_32); } };;
table16[0x4E] = function(cpu) { { cpu.reg16[reg_si] = cpu.dec(cpu.reg16[reg_si], OPSIZE_16); } }; table32[0x4E] = function(cpu) { { cpu.reg32s[reg_esi] = cpu.dec(cpu.reg32s[reg_esi], OPSIZE_32); } };;
table16[0x4F] = function(cpu) { { cpu.reg16[reg_di] = cpu.dec(cpu.reg16[reg_di], OPSIZE_16); } }; table32[0x4F] = function(cpu) { { cpu.reg32s[reg_edi] = cpu.dec(cpu.reg32s[reg_edi], OPSIZE_32); } };;
table16[0x50] = function(cpu) { { cpu.push16(cpu.reg16[reg_ax]); } }; table32[0x50] = function(cpu) { { cpu.push32(cpu.reg32s[reg_eax]); } };
table16[0x51] = function(cpu) { { cpu.push16(cpu.reg16[reg_cx]); } }; table32[0x51] = function(cpu) { { cpu.push32(cpu.reg32s[reg_ecx]); } };
table16[0x52] = function(cpu) { { cpu.push16(cpu.reg16[reg_dx]); } }; table32[0x52] = function(cpu) { { cpu.push32(cpu.reg32s[reg_edx]); } };
table16[0x53] = function(cpu) { { cpu.push16(cpu.reg16[reg_bx]); } }; table32[0x53] = function(cpu) { { cpu.push32(cpu.reg32s[reg_ebx]); } };
table16[0x54] = function(cpu) { { cpu.push16(cpu.reg16[reg_sp]); } }; table32[0x54] = function(cpu) { { cpu.push32(cpu.reg32s[reg_esp]); } };
table16[0x55] = function(cpu) { { cpu.push16(cpu.reg16[reg_bp]); } }; table32[0x55] = function(cpu) { { cpu.push32(cpu.reg32s[reg_ebp]); } };
table16[0x56] = function(cpu) { { cpu.push16(cpu.reg16[reg_si]); } }; table32[0x56] = function(cpu) { { cpu.push32(cpu.reg32s[reg_esi]); } };
table16[0x57] = function(cpu) { { cpu.push16(cpu.reg16[reg_di]); } }; table32[0x57] = function(cpu) { { cpu.push32(cpu.reg32s[reg_edi]); } };
table16[0x58] = function(cpu) { { cpu.reg16[reg_ax] = cpu.pop16(); } }; table32[0x58] = function(cpu) { { cpu.reg32s[reg_eax] = cpu.pop32s(); } };
table16[0x59] = function(cpu) { { cpu.reg16[reg_cx] = cpu.pop16(); } }; table32[0x59] = function(cpu) { { cpu.reg32s[reg_ecx] = cpu.pop32s(); } };
table16[0x5A] = function(cpu) { { cpu.reg16[reg_dx] = cpu.pop16(); } }; table32[0x5A] = function(cpu) { { cpu.reg32s[reg_edx] = cpu.pop32s(); } };
table16[0x5B] = function(cpu) { { cpu.reg16[reg_bx] = cpu.pop16(); } }; table32[0x5B] = function(cpu) { { cpu.reg32s[reg_ebx] = cpu.pop32s(); } };
table16[0x5C] = function(cpu) { { cpu.reg16[reg_sp] = cpu.pop16(); } }; table32[0x5C] = function(cpu) { { cpu.reg32s[reg_esp] = cpu.pop32s(); } };
table16[0x5D] = function(cpu) { { cpu.reg16[reg_bp] = cpu.pop16(); } }; table32[0x5D] = function(cpu) { { cpu.reg32s[reg_ebp] = cpu.pop32s(); } };
table16[0x5E] = function(cpu) { { cpu.reg16[reg_si] = cpu.pop16(); } }; table32[0x5E] = function(cpu) { { cpu.reg32s[reg_esi] = cpu.pop32s(); } };
table16[0x5F] = function(cpu) { { cpu.reg16[reg_di] = cpu.pop16(); } }; table32[0x5F] = function(cpu) { { cpu.reg32s[reg_edi] = cpu.pop32s(); } };
table16[0x60] = function(cpu) { { cpu.pusha16(); } }; table32[0x60] = function(cpu) { { cpu.pusha32(); } };;
table16[0x61] = function(cpu) { { cpu.popa16(); } }; table32[0x61] = function(cpu) { { cpu.popa32(); } };;
table16[0x62] = table32[0x62] = function(cpu) { { /* bound*/ dbg_log("Unimplemented BOUND instruction", LOG_CPU); } };;
table16[0x63] = table32[0x63] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* arpl*/ dbg_log("arpl", LOG_CPU); if(cpu.protected_mode && !cpu.vm86_mode()) { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.arpl(data, modrm_byte >> 2 & 14); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; }; } else { cpu.trigger_ud(); } } };;
table16[0x64] = table32[0x64] = function(cpu) { { cpu.seg_prefix(reg_fs); } };;
table16[0x65] = table32[0x65] = function(cpu) { { cpu.seg_prefix(reg_gs); } };;
table16[0x66] = function(cpu) { { /* Operand-size override prefix*/ dbg_assert(cpu.operand_size_32 === cpu.is_32); cpu.operand_size_32 = true; cpu.table = cpu.table32; cpu.do_op(); cpu.operand_size_32 = cpu.is_32; cpu.update_operand_size(); } }; table32[0x66] = function(cpu) { { dbg_assert(cpu.operand_size_32 === cpu.is_32); cpu.operand_size_32 = false; cpu.table = cpu.table16; cpu.do_op(); cpu.operand_size_32 = cpu.is_32; cpu.update_operand_size(); } };;
table16[0x67] = table32[0x67] = function(cpu) { { /* Address-size override prefix*/ dbg_assert(cpu.address_size_32 === cpu.is_32); cpu.address_size_32 = !cpu.is_32; cpu.update_address_size(); cpu.do_op(); cpu.address_size_32 = cpu.is_32; cpu.update_address_size(); } };;
table16[0x68] = function(cpu) { { cpu.push16(cpu.read_imm16()); } }; table32[0x68] = function(cpu) { { cpu.push32(cpu.read_imm32s()); } };;
table16[0x69] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = (cpu.safe_read16(cpu.modrm_resolve(modrm_byte)) << 16 >> 16); } else { data = cpu.reg16s[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.imul_reg16(cpu.read_imm16s(), data); } }; table32[0x69] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.imul_reg32(cpu.read_imm32s(), data); } };;
table16[0x6A] = function(cpu) { { cpu.push16(cpu.read_imm8s()); } }; table32[0x6A] = function(cpu) { { cpu.push32(cpu.read_imm8s()); } };;
table16[0x6B] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = (cpu.safe_read16(cpu.modrm_resolve(modrm_byte)) << 16 >> 16); } else { data = cpu.reg16s[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.imul_reg16(cpu.read_imm8s(), data); } }; table32[0x6B] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.imul_reg32(cpu.read_imm8s(), data); } };;
table16[0x6C] = table32[0x6C] = function(cpu) { { insb(cpu); } };;
table16[0x6D] = function(cpu) { { insw(cpu); } }; table32[0x6D] = function(cpu) { { insd(cpu); } };;
table16[0x6E] = table32[0x6E] = function(cpu) { { outsb(cpu); } };;
table16[0x6F] = function(cpu) { { outsw(cpu); } }; table32[0x6F] = function(cpu) { { outsd(cpu); } };;
table16[0x70 | 0x0] = table32[0x70 | 0x0] = function(cpu) { { if(( cpu.test_o())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0x1] = table32[0x70 | 0x1] = function(cpu) { { if((!cpu.test_o())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0x2] = table32[0x70 | 0x2] = function(cpu) { { if(( cpu.test_b())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0x3] = table32[0x70 | 0x3] = function(cpu) { { if((!cpu.test_b())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0x4] = table32[0x70 | 0x4] = function(cpu) { { if(( cpu.test_z())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0x5] = table32[0x70 | 0x5] = function(cpu) { { if((!cpu.test_z())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0x6] = table32[0x70 | 0x6] = function(cpu) { { if(( cpu.test_be())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0x7] = table32[0x70 | 0x7] = function(cpu) { { if((!cpu.test_be())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0x8] = table32[0x70 | 0x8] = function(cpu) { { if(( cpu.test_s())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0x9] = table32[0x70 | 0x9] = function(cpu) { { if((!cpu.test_s())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0xA] = table32[0x70 | 0xA] = function(cpu) { { if(( cpu.test_p())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0xB] = table32[0x70 | 0xB] = function(cpu) { { if((!cpu.test_p())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0xC] = table32[0x70 | 0xC] = function(cpu) { { if(( cpu.test_l())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0xD] = table32[0x70 | 0xD] = function(cpu) { { if((!cpu.test_l())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0xE] = table32[0x70 | 0xE] = function(cpu) { { if(( cpu.test_le())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;; table16[0x70 | 0xF] = table32[0x70 | 0xF] = function(cpu) { { if((!cpu.test_le())) { cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0; } cpu.instruction_pointer++; cpu.last_instr_jump = true; } };;;;
table16[0x80] = table32[0x80] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if((modrm_byte & 56) === 56) { /* CMP*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.sub(data, cpu.read_imm8(), OPSIZE_8); } else { var data2; var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = 0; data2 = cpu.read_imm8(); switch(modrm_byte >> 3 & 7) { case 0: result = cpu.add(data, data2, OPSIZE_8); break; case 1: result = cpu.or(data, data2, OPSIZE_8); break; case 2: result = cpu.adc(data, data2, OPSIZE_8); break; case 3: result = cpu.sbb(data, data2, OPSIZE_8); break; case 4: result = cpu.and(data, data2, OPSIZE_8); break; case 5: result = cpu.sub(data, data2, OPSIZE_8); break; case 6: result = cpu.xor(data, data2, OPSIZE_8); break; case 7: result = dbg_assert.bind(this, 0)(data, data2); break; }; if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; } } } };;
table16[0x81] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if((modrm_byte & 56) === 56) { /* CMP*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.sub(data, cpu.read_imm16(), OPSIZE_16); } else { var data2; var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = 0; data2 = cpu.read_imm16(); switch(modrm_byte >> 3 & 7) { case 0: result = cpu.add(data, data2, OPSIZE_16); break; case 1: result = cpu.or(data, data2, OPSIZE_16); break; case 2: result = cpu.adc(data, data2, OPSIZE_16); break; case 3: result = cpu.sbb(data, data2, OPSIZE_16); break; case 4: result = cpu.and(data, data2, OPSIZE_16); break; case 5: result = cpu.sub(data, data2, OPSIZE_16); break; case 6: result = cpu.xor(data, data2, OPSIZE_16); break; case 7: result = dbg_assert.bind(this, 0)(data, data2); break; }; if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; } } } }; table32[0x81] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if((modrm_byte & 56) === 56) { /* CMP*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.sub(data, cpu.read_imm32s(), OPSIZE_32); } else { var data2; var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = 0; data2 = cpu.read_imm32s(); switch(modrm_byte >> 3 & 7) { case 0: result = cpu.add(data, data2, OPSIZE_32); break; case 1: result = cpu.or(data, data2, OPSIZE_32); break; case 2: result = cpu.adc(data, data2, OPSIZE_32); break; case 3: result = cpu.sbb(data, data2, OPSIZE_32); break; case 4: result = cpu.and(data, data2, OPSIZE_32); break; case 5: result = cpu.sub(data, data2, OPSIZE_32); break; case 6: result = cpu.xor(data, data2, OPSIZE_32); break; case 7: result = dbg_assert.bind(this, 0)(data, data2); break; }; if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; } } } };;
table16[0x82] = table32[0x82] = function(cpu) { { cpu.table[0x80](cpu); /* alias*/ } };;
table16[0x83] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if((modrm_byte & 56) === 56) { /* CMP*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.sub(data, cpu.read_imm8s(), OPSIZE_16); } else { var data2; var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = 0; data2 = cpu.read_imm8s(); switch(modrm_byte >> 3 & 7) { case 0: result = cpu.add(data, data2, OPSIZE_16); break; case 1: result = cpu.or(data, data2, OPSIZE_16); break; case 2: result = cpu.adc(data, data2, OPSIZE_16); break; case 3: result = cpu.sbb(data, data2, OPSIZE_16); break; case 4: result = cpu.and(data, data2, OPSIZE_16); break; case 5: result = cpu.sub(data, data2, OPSIZE_16); break; case 6: result = cpu.xor(data, data2, OPSIZE_16); break; case 7: result = dbg_assert.bind(this, 0)(data, data2); break; }; if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; } } } }; table32[0x83] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if((modrm_byte & 56) === 56) { /* CMP*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.sub(data, cpu.read_imm8s(), OPSIZE_32); } else { var data2; var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = 0; data2 = cpu.read_imm8s(); switch(modrm_byte >> 3 & 7) { case 0: result = cpu.add(data, data2, OPSIZE_32); break; case 1: result = cpu.or(data, data2, OPSIZE_32); break; case 2: result = cpu.adc(data, data2, OPSIZE_32); break; case 3: result = cpu.sbb(data, data2, OPSIZE_32); break; case 4: result = cpu.and(data, data2, OPSIZE_32); break; case 5: result = cpu.sub(data, data2, OPSIZE_32); break; case 6: result = cpu.xor(data, data2, OPSIZE_32); break; case 7: result = dbg_assert.bind(this, 0)(data, data2); break; }; if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; } } } };;
table16[0x84] = table32[0x84] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.and(data, cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1], OPSIZE_8); } };
table16[0x85] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.and(data, cpu.reg16[modrm_byte >> 2 & 14], OPSIZE_16); } }; table32[0x85] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.and(data, cpu.reg32s[modrm_byte >> 3 & 7], OPSIZE_32); } };
table16[0x86] = table32[0x86] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = cpu.xchg8(data, modrm_byte); if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; }; } };;
table16[0x87] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.xchg16(data, modrm_byte); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; }; } }; table32[0x87] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.xchg32(data, modrm_byte); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; }; } };;
table16[0x88] = table32[0x88] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1]; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };
table16[0x89] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = cpu.reg16[modrm_byte >> 2 & 14]; if(modrm_byte < 0xC0) { cpu.safe_write16(addr, data); } else { cpu.reg16[modrm_byte << 1 & 14] = data; }; } }; table32[0x89] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = cpu.reg32s[modrm_byte >> 3 & 7]; if(modrm_byte < 0xC0) { cpu.safe_write32(addr, data); } else { cpu.reg32[modrm_byte & 7] = data; }; } };
table16[0x8A] = table32[0x8A] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1] = data; } };;
table16[0x8B] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = data; } }; table32[0x8B] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = data; } };;
table16[0x8C] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = cpu.sreg[modrm_byte >> 3 & 7]; if(modrm_byte < 0xC0) { cpu.safe_write16(addr, data); } else { cpu.reg16[modrm_byte << 1 & 14] = data; }; } }; table32[0x8C] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = cpu.sreg[modrm_byte >> 3 & 7]; if(modrm_byte < 0xC0) { cpu.safe_write32(addr, data); } else { cpu.reg32[modrm_byte & 7] = data; }; } };;
table16[0x8D] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* lea*/ if(modrm_byte >= 0xC0) { cpu.trigger_ud(); } var mod = modrm_byte >> 3 & 7; /* override prefix, so modrm_resolve does not return the segment part*/ cpu.segment_prefix = SEG_PREFIX_ZERO; cpu.reg16[mod << 1] = cpu.modrm_resolve(modrm_byte); cpu.segment_prefix = SEG_PREFIX_NONE; } }; table32[0x8D] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte >= 0xC0) { cpu.trigger_ud(); } var mod = modrm_byte >> 3 & 7; cpu.segment_prefix = SEG_PREFIX_ZERO; cpu.reg32s[mod] = cpu.modrm_resolve(modrm_byte); cpu.segment_prefix = SEG_PREFIX_NONE; } };;
table16[0x8E] = table32[0x8E] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var mod = modrm_byte >> 3 & 7; if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.switch_seg(mod, data); if(mod === reg_ss) { /* TODO*/ /* run next instruction, so no irqs are handled*/ /* Can't use cpu.cycle, because prefixes are still active*/ } } };;
table16[0x8F] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* pop*/ var sp = cpu.safe_read16(cpu.get_stack_pointer(0)); cpu.stack_reg[cpu.reg_vsp] += 2; if(modrm_byte < 0xC0) { var addr = cpu.modrm_resolve(modrm_byte); cpu.stack_reg[cpu.reg_vsp] -= 2; cpu.safe_write16(addr, sp); cpu.stack_reg[cpu.reg_vsp] += 2; } else { cpu.reg16[modrm_byte << 1 & 14] = sp; } } }; table32[0x8F] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var sp = cpu.safe_read32s(cpu.get_stack_pointer(0)); /* change esp first, then resolve modrm address*/ cpu.stack_reg[cpu.reg_vsp] += 4; if(modrm_byte < 0xC0) { var addr = cpu.modrm_resolve(modrm_byte); /* Before attempting a write that might cause a page fault,*/ /* we must set esp to the old value. Fuck Intel.*/ cpu.stack_reg[cpu.reg_vsp] -= 4; cpu.safe_write32(addr, sp); cpu.stack_reg[cpu.reg_vsp] += 4; } else { cpu.reg32s[modrm_byte & 7] = sp; } } };;
table16[0x90] = table32[0x90] = function(cpu) { /* nop */ };;
table16[0x91] = function(cpu) { { cpu.xchg16r(reg_cx) } }; table32[0x91] = function(cpu) { { cpu.xchg32r(reg_ecx) } };;
table16[0x92] = function(cpu) { { cpu.xchg16r(reg_dx) } }; table32[0x92] = function(cpu) { { cpu.xchg32r(reg_edx) } };;
table16[0x93] = function(cpu) { { cpu.xchg16r(reg_bx) } }; table32[0x93] = function(cpu) { { cpu.xchg32r(reg_ebx) } };;
table16[0x94] = function(cpu) { { cpu.xchg16r(reg_sp) } }; table32[0x94] = function(cpu) { { cpu.xchg32r(reg_esp) } };;
table16[0x95] = function(cpu) { { cpu.xchg16r(reg_bp) } }; table32[0x95] = function(cpu) { { cpu.xchg32r(reg_ebp) } };;
table16[0x96] = function(cpu) { { cpu.xchg16r(reg_si) } }; table32[0x96] = function(cpu) { { cpu.xchg32r(reg_esi) } };;
table16[0x97] = function(cpu) { { cpu.xchg16r(reg_di) } }; table32[0x97] = function(cpu) { { cpu.xchg32r(reg_edi) } };;
table16[0x98] = function(cpu) { { /* cbw */ cpu.reg16[reg_ax] = cpu.reg8s[reg_al]; } }; table32[0x98] = function(cpu) { { /* cwde */ cpu.reg32s[reg_eax] = cpu.reg16s[reg_ax]; } };;
table16[0x99] = function(cpu) { { /* cwd */ cpu.reg16[reg_dx] = cpu.reg16s[reg_ax] >> 15; } }; table32[0x99] = function(cpu) { { /* cdq */ cpu.reg32s[reg_edx] = cpu.reg32s[reg_eax] >> 31; } };;
table16[0x9A] = function(cpu) { { /* callf*/ var new_ip = cpu.read_imm16(); var new_cs = cpu.read_imm16(); cpu.writable_or_pagefault(cpu.get_stack_pointer(-4), 4); cpu.push16(cpu.sreg[reg_cs]); cpu.push16(cpu.get_real_eip()); cpu.switch_seg(reg_cs, new_cs); cpu.instruction_pointer = cpu.get_seg(reg_cs) + new_ip | 0; cpu.last_instr_jump = true; } }; table32[0x9A] = function(cpu) { { var new_ip = cpu.read_imm32s(); var new_cs = cpu.read_imm16(); if(!cpu.protected_mode || cpu.vm86_mode()) { if(new_ip & 0xFFFF0000) { throw cpu.debug.unimpl("#GP handler"); } } cpu.writable_or_pagefault(cpu.get_stack_pointer(-8), 8); cpu.push32(cpu.sreg[reg_cs]); cpu.push32(cpu.get_real_eip()); cpu.switch_seg(reg_cs, new_cs); cpu.instruction_pointer = cpu.get_seg(reg_cs) + new_ip | 0; cpu.last_instr_jump = true; } };;
table16[0x9B] = table32[0x9B] = function(cpu) { { /* fwait: check for pending fpu exceptions*/ if((cpu.cr[0] & (CR0_MP | CR0_TS)) === (CR0_MP | CR0_TS)) { /* task switched and MP bit is set*/ cpu.trigger_nm(); } else { if(cpu.fpu) { cpu.fpu.fwait(); } else { /* EM bit isn't checked*/ /* If there's no FPU, do nothing*/ } } } };;
table16[0x9C] = function(cpu) { { /* pushf*/ if((cpu.flags & flag_vm) && cpu.getiopl() < 3) { cpu.trigger_gp(0); } else { cpu.load_eflags(); cpu.push16(cpu.flags); } } }; table32[0x9C] = function(cpu) { { /* pushf*/ if((cpu.flags & flag_vm) && cpu.getiopl() < 3) { /* trap to virtual 8086 monitor*/ cpu.trigger_gp(0); } else { cpu.load_eflags(); /* vm and rf flag are cleared in image stored on the stack*/ cpu.push32(cpu.flags & 0x00FCFFFF); } } };;
table16[0x9D] = function(cpu) { { /* popf*/ if((cpu.flags & flag_vm) && cpu.getiopl() < 3) { cpu.trigger_gp(0); } cpu.update_eflags((cpu.flags & ~0xFFFF) | cpu.pop16()); cpu.handle_irqs(); } }; table32[0x9D] = function(cpu) { { /* popf*/ if((cpu.flags & flag_vm) && cpu.getiopl() < 3) { cpu.trigger_gp(0); } cpu.update_eflags(cpu.pop32s()); cpu.handle_irqs(); } };;
table16[0x9E] = table32[0x9E] = function(cpu) { { /* sahf*/ cpu.flags = (cpu.flags & ~0xFF) | cpu.reg8[reg_ah]; cpu.flags = (cpu.flags & flags_mask) | flags_default; cpu.flags_changed = 0; } };;
table16[0x9F] = table32[0x9F] = function(cpu) { { /* lahf*/ cpu.load_eflags(); cpu.reg8[reg_ah] = cpu.flags; } };;
table16[0xA0] = table32[0xA0] = function(cpu) { { /* mov*/ var data = cpu.safe_read8(cpu.read_moffs()); cpu.reg8[reg_al] = data; } };;
table16[0xA1] = function(cpu) { { /* mov*/ var data = cpu.safe_read16(cpu.read_moffs()); cpu.reg16[reg_ax] = data; } }; table32[0xA1] = function(cpu) { { var data = cpu.safe_read32s(cpu.read_moffs()); cpu.reg32s[reg_eax] = data; } };;
table16[0xA2] = table32[0xA2] = function(cpu) { { /* mov*/ cpu.safe_write8(cpu.read_moffs(), cpu.reg8[reg_al]); } };;
table16[0xA3] = function(cpu) { { /* mov*/ cpu.safe_write16(cpu.read_moffs(), cpu.reg16[reg_ax]); } }; table32[0xA3] = function(cpu) { { cpu.safe_write32(cpu.read_moffs(), cpu.reg32s[reg_eax]); } };;
table16[0xA4] = table32[0xA4] = function(cpu) { { movsb(cpu); } };;
table16[0xA5] = function(cpu) { { movsw(cpu); } }; table32[0xA5] = function(cpu) { { movsd(cpu); } };;
table16[0xA6] = table32[0xA6] = function(cpu) { { cmpsb(cpu); } };;
table16[0xA7] = function(cpu) { { cmpsw(cpu); } }; table32[0xA7] = function(cpu) { { cmpsd(cpu); } };;
table16[0xA8] = table32[0xA8] = function(cpu) { { cpu.and(cpu.reg8[reg_al], cpu.read_imm8(), OPSIZE_8); } };;
table16[0xA9] = function(cpu) { { cpu.and(cpu.reg16[reg_ax], cpu.read_imm16(), OPSIZE_16); } }; table32[0xA9] = function(cpu) { { cpu.and(cpu.reg32s[reg_eax], cpu.read_imm32s(), OPSIZE_32); } };;
table16[0xAA] = table32[0xAA] = function(cpu) { { stosb(cpu); } };;
table16[0xAB] = function(cpu) { { stosw(cpu); } }; table32[0xAB] = function(cpu) { { stosd(cpu); } };;
table16[0xAC] = table32[0xAC] = function(cpu) { { lodsb(cpu); } };;
table16[0xAD] = function(cpu) { { lodsw(cpu); } }; table32[0xAD] = function(cpu) { { lodsd(cpu); } };;
table16[0xAE] = table32[0xAE] = function(cpu) { { scasb(cpu); } };;
table16[0xAF] = function(cpu) { { scasw(cpu); } }; table32[0xAF] = function(cpu) { { scasd(cpu); } };;
table16[0xB0] = table32[0xB0] = function(cpu) { { cpu.reg8[reg_al] = cpu.read_imm8(); } };
table16[0xB1] = table32[0xB1] = function(cpu) { { cpu.reg8[reg_cl] = cpu.read_imm8(); } };
table16[0xB2] = table32[0xB2] = function(cpu) { { cpu.reg8[reg_dl] = cpu.read_imm8(); } };
table16[0xB3] = table32[0xB3] = function(cpu) { { cpu.reg8[reg_bl] = cpu.read_imm8(); } };
table16[0xB4] = table32[0xB4] = function(cpu) { { cpu.reg8[reg_ah] = cpu.read_imm8(); } };
table16[0xB5] = table32[0xB5] = function(cpu) { { cpu.reg8[reg_ch] = cpu.read_imm8(); } };
table16[0xB6] = table32[0xB6] = function(cpu) { { cpu.reg8[reg_dh] = cpu.read_imm8(); } };
table16[0xB7] = table32[0xB7] = function(cpu) { { cpu.reg8[reg_bh] = cpu.read_imm8(); } };
table16[0xB8] = function(cpu) { { cpu.reg16[reg_ax] = cpu.read_imm16(); } }; table32[0xB8] = function(cpu) { { cpu.reg32s[reg_eax] = cpu.read_imm32s(); } };;
table16[0xB9] = function(cpu) { { cpu.reg16[reg_cx] = cpu.read_imm16(); } }; table32[0xB9] = function(cpu) { { cpu.reg32s[reg_ecx] = cpu.read_imm32s(); } };;
table16[0xBA] = function(cpu) { { cpu.reg16[reg_dx] = cpu.read_imm16(); } }; table32[0xBA] = function(cpu) { { cpu.reg32s[reg_edx] = cpu.read_imm32s(); } };;
table16[0xBB] = function(cpu) { { cpu.reg16[reg_bx] = cpu.read_imm16(); } }; table32[0xBB] = function(cpu) { { cpu.reg32s[reg_ebx] = cpu.read_imm32s(); } };;
table16[0xBC] = function(cpu) { { cpu.reg16[reg_sp] = cpu.read_imm16(); } }; table32[0xBC] = function(cpu) { { cpu.reg32s[reg_esp] = cpu.read_imm32s(); } };;
table16[0xBD] = function(cpu) { { cpu.reg16[reg_bp] = cpu.read_imm16(); } }; table32[0xBD] = function(cpu) { { cpu.reg32s[reg_ebp] = cpu.read_imm32s(); } };;
table16[0xBE] = function(cpu) { { cpu.reg16[reg_si] = cpu.read_imm16(); } }; table32[0xBE] = function(cpu) { { cpu.reg32s[reg_esi] = cpu.read_imm32s(); } };;
table16[0xBF] = function(cpu) { { cpu.reg16[reg_di] = cpu.read_imm16(); } }; table32[0xBF] = function(cpu) { { cpu.reg32s[reg_edi] = cpu.read_imm32s(); } };;
table16[0xC0] = table32[0xC0] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data2; var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = 0; data2 = cpu.read_imm8() & 31; switch(modrm_byte >> 3 & 7) { case 0: result = cpu.rol8(data, data2); break; case 1: result = cpu.ror8(data, data2); break; case 2: result = cpu.rcl8(data, data2); break; case 3: result = cpu.rcr8(data, data2); break; case 4: result = cpu.shl8(data, data2); break; case 5: result = cpu.shr8(data, data2); break; case 6: result = cpu.shl8(data, data2); break; case 7: result = cpu.sar8(data, data2); break; }; if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; } } };;
table16[0xC1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data2; var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = 0; data2 = cpu.read_imm8() & 31; switch(modrm_byte >> 3 & 7) { case 0: result = cpu.rol16(data, data2); break; case 1: result = cpu.ror16(data, data2); break; case 2: result = cpu.rcl16(data, data2); break; case 3: result = cpu.rcr16(data, data2); break; case 4: result = cpu.shl16(data, data2); break; case 5: result = cpu.shr16(data, data2); break; case 6: result = cpu.shl16(data, data2); break; case 7: result = cpu.sar16(data, data2); break; }; if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; } } }; table32[0xC1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data2; var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = 0; data2 = cpu.read_imm8() & 31; switch(modrm_byte >> 3 & 7) { case 0: result = cpu.rol32(data, data2); break; case 1: result = cpu.ror32(data, data2); break; case 2: result = cpu.rcl32(data, data2); break; case 3: result = cpu.rcr32(data, data2); break; case 4: result = cpu.shl32(data, data2); break; case 5: result = cpu.shr32(data, data2); break; case 6: result = cpu.shl32(data, data2); break; case 7: result = cpu.sar32(data, data2); break; }; if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; } } };;
table16[0xC2] = function(cpu) { { /* retn*/ var imm16 = cpu.read_imm16(); cpu.instruction_pointer = cpu.get_seg(reg_cs) + cpu.pop16() | 0; cpu.stack_reg[cpu.reg_vsp] += imm16; cpu.last_instr_jump = true; } }; table32[0xC2] = function(cpu) { { /* retn*/ var imm16 = cpu.read_imm16(); cpu.instruction_pointer = cpu.get_seg(reg_cs) + cpu.pop32s() | 0; cpu.stack_reg[cpu.reg_vsp] += imm16; cpu.last_instr_jump = true; } };;
table16[0xC3] = function(cpu) { { /* retn*/ cpu.instruction_pointer = cpu.get_seg(reg_cs) + cpu.pop16() | 0; cpu.last_instr_jump = true; } }; table32[0xC3] = function(cpu) { { /* retn*/ cpu.instruction_pointer = cpu.get_seg(reg_cs) + cpu.pop32s() | 0; cpu.last_instr_jump = true; } };;
table16[0xC4] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte >= 0xC0) { cpu.trigger_ud(); } cpu.lss16(reg_es, cpu.modrm_resolve(modrm_byte), modrm_byte >> 2 & 14);; } }; table32[0xC4] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte >= 0xC0) { cpu.trigger_ud(); } cpu.lss32(reg_es, cpu.modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);; } };;
table16[0xC5] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte >= 0xC0) { cpu.trigger_ud(); } cpu.lss16(reg_ds, cpu.modrm_resolve(modrm_byte), modrm_byte >> 2 & 14);; } }; table32[0xC5] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte >= 0xC0) { cpu.trigger_ud(); } cpu.lss32(reg_ds, cpu.modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);; } };;
table16[0xC6] = table32[0xC6] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = cpu.read_imm8(); if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };
table16[0xC7] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = cpu.read_imm16(); if(modrm_byte < 0xC0) { cpu.safe_write16(addr, data); } else { cpu.reg16[modrm_byte << 1 & 14] = data; }; } }; table32[0xC7] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = cpu.read_imm32s(); if(modrm_byte < 0xC0) { cpu.safe_write32(addr, data); } else { cpu.reg32[modrm_byte & 7] = data; }; } };
table16[0xC8] = function(cpu) { { cpu.enter16(); } }; table32[0xC8] = function(cpu) { { cpu.enter32(); } };;
table16[0xC9] = function(cpu) { { /* leave*/ cpu.stack_reg[cpu.reg_vsp] = cpu.stack_reg[cpu.reg_vbp]; cpu.reg16[reg_bp] = cpu.pop16(); } }; table32[0xC9] = function(cpu) { { cpu.stack_reg[cpu.reg_vsp] = cpu.stack_reg[cpu.reg_vbp]; cpu.reg32s[reg_ebp] = cpu.pop32s(); } };;
table16[0xCA] = function(cpu) { { /* retf*/ cpu.translate_address_read(cpu.get_seg(reg_ss) + cpu.stack_reg[cpu.reg_vsp] + 4); var imm16 = cpu.read_imm16(); var ip = cpu.pop16(); cpu.switch_seg(reg_cs, cpu.pop16()); cpu.instruction_pointer = cpu.get_seg(reg_cs) + ip | 0; cpu.stack_reg[cpu.reg_vsp] += imm16; cpu.last_instr_jump = true; } }; table32[0xCA] = function(cpu) { { /* retf */ cpu.translate_address_read(cpu.get_seg(reg_ss) + cpu.stack_reg[cpu.reg_vsp] + 8); var imm16 = cpu.read_imm16(); var ip = cpu.pop32s(); cpu.switch_seg(reg_cs, cpu.pop32s() & 0xFFFF); cpu.instruction_pointer = cpu.get_seg(reg_cs) + ip | 0; cpu.stack_reg[cpu.reg_vsp] += imm16; cpu.last_instr_jump = true; } };;
table16[0xCB] = function(cpu) { { /* retf*/ cpu.translate_address_read(cpu.get_seg(reg_ss) + cpu.stack_reg[cpu.reg_vsp] + 4); var ip = cpu.pop16(); cpu.switch_seg(reg_cs, cpu.pop16()); cpu.instruction_pointer = cpu.get_seg(reg_cs) + ip | 0; cpu.last_instr_jump = true; } }; table32[0xCB] = function(cpu) { { /* retf */ cpu.translate_address_read(cpu.get_seg(reg_ss) + cpu.stack_reg[cpu.reg_vsp] + 8); var ip = cpu.pop32s(); cpu.switch_seg(reg_cs, cpu.pop32s() & 0xFFFF); cpu.instruction_pointer = cpu.get_seg(reg_cs) + ip | 0; cpu.last_instr_jump = true; } };;
table16[0xCC] = table32[0xCC] = function(cpu) { { /* INT3*/ cpu.call_interrupt_vector(3, true, false); } };;
table16[0xCD] = table32[0xCD] = function(cpu) { { /* INT */ var imm8 = cpu.read_imm8(); cpu.call_interrupt_vector(imm8, true, false); } };;
table16[0xCE] = table32[0xCE] = function(cpu) { { /* INTO*/ if(cpu.getof()) { cpu.call_interrupt_vector(4, true, false); } } };;
table16[0xCF] = function(cpu) { { /* iret*/ cpu.iret16(); } }; table32[0xCF] = function(cpu) { { cpu.iret32(); } };;
table16[0xD0] = table32[0xD0] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data2; var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = 0; data2 = 1; switch(modrm_byte >> 3 & 7) { case 0: result = cpu.rol8(data, data2); break; case 1: result = cpu.ror8(data, data2); break; case 2: result = cpu.rcl8(data, data2); break; case 3: result = cpu.rcr8(data, data2); break; case 4: result = cpu.shl8(data, data2); break; case 5: result = cpu.shr8(data, data2); break; case 6: result = cpu.shl8(data, data2); break; case 7: result = cpu.sar8(data, data2); break; }; if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; } } };;
table16[0xD1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data2; var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = 0; data2 = 1; switch(modrm_byte >> 3 & 7) { case 0: result = cpu.rol16(data, data2); break; case 1: result = cpu.ror16(data, data2); break; case 2: result = cpu.rcl16(data, data2); break; case 3: result = cpu.rcr16(data, data2); break; case 4: result = cpu.shl16(data, data2); break; case 5: result = cpu.shr16(data, data2); break; case 6: result = cpu.shl16(data, data2); break; case 7: result = cpu.sar16(data, data2); break; }; if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; } } }; table32[0xD1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data2; var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = 0; data2 = 1; switch(modrm_byte >> 3 & 7) { case 0: result = cpu.rol32(data, data2); break; case 1: result = cpu.ror32(data, data2); break; case 2: result = cpu.rcl32(data, data2); break; case 3: result = cpu.rcr32(data, data2); break; case 4: result = cpu.shl32(data, data2); break; case 5: result = cpu.shr32(data, data2); break; case 6: result = cpu.shl32(data, data2); break; case 7: result = cpu.sar32(data, data2); break; }; if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; } } };;
table16[0xD2] = table32[0xD2] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data2; var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = 0; data2 = cpu.reg8[reg_cl] & 31; switch(modrm_byte >> 3 & 7) { case 0: result = cpu.rol8(data, data2); break; case 1: result = cpu.ror8(data, data2); break; case 2: result = cpu.rcl8(data, data2); break; case 3: result = cpu.rcr8(data, data2); break; case 4: result = cpu.shl8(data, data2); break; case 5: result = cpu.shr8(data, data2); break; case 6: result = cpu.shl8(data, data2); break; case 7: result = cpu.sar8(data, data2); break; }; if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; } } };;
table16[0xD3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data2; var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = 0; data2 = cpu.reg8[reg_cl] & 31; switch(modrm_byte >> 3 & 7) { case 0: result = cpu.rol16(data, data2); break; case 1: result = cpu.ror16(data, data2); break; case 2: result = cpu.rcl16(data, data2); break; case 3: result = cpu.rcr16(data, data2); break; case 4: result = cpu.shl16(data, data2); break; case 5: result = cpu.shr16(data, data2); break; case 6: result = cpu.shl16(data, data2); break; case 7: result = cpu.sar16(data, data2); break; }; if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; } } }; table32[0xD3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data2; var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = 0; data2 = cpu.reg8[reg_cl] & 31; switch(modrm_byte >> 3 & 7) { case 0: result = cpu.rol32(data, data2); break; case 1: result = cpu.ror32(data, data2); break; case 2: result = cpu.rcl32(data, data2); break; case 3: result = cpu.rcr32(data, data2); break; case 4: result = cpu.shl32(data, data2); break; case 5: result = cpu.shr32(data, data2); break; case 6: result = cpu.shl32(data, data2); break; case 7: result = cpu.sar32(data, data2); break; }; if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; } } };;
table16[0xD4] = table32[0xD4] = function(cpu) { { cpu.bcd_aam(); } };;
table16[0xD5] = table32[0xD5] = function(cpu) { { cpu.bcd_aad(); } };;
table16[0xD6] = table32[0xD6] = function(cpu) { { /* salc*/ cpu.reg8[reg_al] = -cpu.getcf(); } };;
table16[0xD7] = table32[0xD7] = function(cpu) { { /* xlat*/ if(cpu.address_size_32) { cpu.reg8[reg_al] = cpu.safe_read8(cpu.get_seg_prefix(reg_ds) + cpu.reg32s[reg_ebx] + cpu.reg8[reg_al]); } else { cpu.reg8[reg_al] = cpu.safe_read8(cpu.get_seg_prefix(reg_ds) + cpu.reg16[reg_bx] + cpu.reg8[reg_al]); } } };;
// fpu instructions
table16[0xD8] = table32[0xD8] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(cpu.cr[0] & (CR0_EM | CR0_TS)) cpu.trigger_nm(); if(modrm_byte < 0xC0) cpu.fpu.op_D8_mem(modrm_byte, cpu.modrm_resolve(modrm_byte)); else cpu.fpu.op_D8_reg(modrm_byte); } };;
table16[0xD9] = table32[0xD9] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(cpu.cr[0] & (CR0_EM | CR0_TS)) cpu.trigger_nm(); if(modrm_byte < 0xC0) cpu.fpu.op_D9_mem(modrm_byte, cpu.modrm_resolve(modrm_byte)); else cpu.fpu.op_D9_reg(modrm_byte); } };;
table16[0xDA] = table32[0xDA] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(cpu.cr[0] & (CR0_EM | CR0_TS)) cpu.trigger_nm(); if(modrm_byte < 0xC0) cpu.fpu.op_DA_mem(modrm_byte, cpu.modrm_resolve(modrm_byte)); else cpu.fpu.op_DA_reg(modrm_byte); } };;
table16[0xDB] = table32[0xDB] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(cpu.cr[0] & (CR0_EM | CR0_TS)) cpu.trigger_nm(); if(modrm_byte < 0xC0) cpu.fpu.op_DB_mem(modrm_byte, cpu.modrm_resolve(modrm_byte)); else cpu.fpu.op_DB_reg(modrm_byte); } };;
table16[0xDC] = table32[0xDC] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(cpu.cr[0] & (CR0_EM | CR0_TS)) cpu.trigger_nm(); if(modrm_byte < 0xC0) cpu.fpu.op_DC_mem(modrm_byte, cpu.modrm_resolve(modrm_byte)); else cpu.fpu.op_DC_reg(modrm_byte); } };;
table16[0xDD] = table32[0xDD] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(cpu.cr[0] & (CR0_EM | CR0_TS)) cpu.trigger_nm(); if(modrm_byte < 0xC0) cpu.fpu.op_DD_mem(modrm_byte, cpu.modrm_resolve(modrm_byte)); else cpu.fpu.op_DD_reg(modrm_byte); } };;
table16[0xDE] = table32[0xDE] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(cpu.cr[0] & (CR0_EM | CR0_TS)) cpu.trigger_nm(); if(modrm_byte < 0xC0) cpu.fpu.op_DE_mem(modrm_byte, cpu.modrm_resolve(modrm_byte)); else cpu.fpu.op_DE_reg(modrm_byte); } };;
table16[0xDF] = table32[0xDF] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(cpu.cr[0] & (CR0_EM | CR0_TS)) cpu.trigger_nm(); if(modrm_byte < 0xC0) cpu.fpu.op_DF_mem(modrm_byte, cpu.modrm_resolve(modrm_byte)); else cpu.fpu.op_DF_reg(modrm_byte); } };;
table16[0xE0] = table32[0xE0] = function(cpu) { { cpu.loopne(); } };;
table16[0xE1] = table32[0xE1] = function(cpu) { { cpu.loope(); } };;
table16[0xE2] = table32[0xE2] = function(cpu) { { cpu.loop(); } };;
table16[0xE3] = table32[0xE3] = function(cpu) { { cpu.jcxz(); } };;
table16[0xE4] = table32[0xE4] = function(cpu) { { var port = cpu.read_imm8(); cpu.test_privileges_for_io(port, 1); cpu.reg8[reg_al] = cpu.io.port_read8(port); } };;
table16[0xE5] = function(cpu) { { var port = cpu.read_imm8(); cpu.test_privileges_for_io(port, 2); cpu.reg16[reg_ax] = cpu.io.port_read16(port); } }; table32[0xE5] = function(cpu) { { var port = cpu.read_imm8(); cpu.test_privileges_for_io(port, 4); cpu.reg32s[reg_eax] = cpu.io.port_read32(port); } };;
table16[0xE6] = table32[0xE6] = function(cpu) { { var port = cpu.read_imm8(); cpu.test_privileges_for_io(port, 1); cpu.io.port_write8(port, cpu.reg8[reg_al]); } };;
table16[0xE7] = function(cpu) { { var port = cpu.read_imm8(); cpu.test_privileges_for_io(port, 2); cpu.io.port_write16(port, cpu.reg16[reg_ax]); } }; table32[0xE7] = function(cpu) { { var port = cpu.read_imm8(); cpu.test_privileges_for_io(port, 4); cpu.io.port_write32(port, cpu.reg32s[reg_eax]); } };;
table16[0xE8] = function(cpu) { { /* call*/ var imm16s = cpu.read_imm16s(); cpu.push16(cpu.get_real_eip()); cpu.jmp_rel16(imm16s); cpu.last_instr_jump = true; } }; table32[0xE8] = function(cpu) { { /* call*/ var imm32s = cpu.read_imm32s(); cpu.push32(cpu.get_real_eip()); cpu.instruction_pointer = cpu.instruction_pointer + imm32s | 0; cpu.last_instr_jump = true; } };;
table16[0xE9] = function(cpu) { { /* jmp*/ var imm16s = cpu.read_imm16s(); cpu.jmp_rel16(imm16s); cpu.last_instr_jump = true; } }; table32[0xE9] = function(cpu) { { /* jmp*/ var imm32s = cpu.read_imm32s(); cpu.instruction_pointer = cpu.instruction_pointer + imm32s | 0; cpu.last_instr_jump = true; } };;
table16[0xEA] = function(cpu) { { /* jmpf*/ var ip = cpu.read_imm16(); cpu.switch_seg(reg_cs, cpu.read_imm16()); cpu.instruction_pointer = ip + cpu.get_seg(reg_cs) | 0; cpu.last_instr_jump = true; } }; table32[0xEA] = function(cpu) { { /* jmpf*/ var ip = cpu.read_imm32s(); cpu.switch_seg(reg_cs, cpu.read_imm16()); cpu.instruction_pointer = ip + cpu.get_seg(reg_cs) | 0; cpu.last_instr_jump = true; } };;
table16[0xEB] = table32[0xEB] = function(cpu) { { /* jmp near*/ var imm8 = cpu.read_imm8s(); cpu.instruction_pointer = cpu.instruction_pointer + imm8 | 0; cpu.last_instr_jump = true; } };;
table16[0xEC] = table32[0xEC] = function(cpu) { { var port = cpu.reg16[reg_dx]; cpu.test_privileges_for_io(port, 1); cpu.reg8[reg_al] = cpu.io.port_read8(port); } };;
table16[0xED] = function(cpu) { { var port = cpu.reg16[reg_dx]; cpu.test_privileges_for_io(port, 2); cpu.reg16[reg_ax] = cpu.io.port_read16(port); } }; table32[0xED] = function(cpu) { { var port = cpu.reg16[reg_dx]; cpu.test_privileges_for_io(port, 4); cpu.reg32s[reg_eax] = cpu.io.port_read32(port); } };;
table16[0xEE] = table32[0xEE] = function(cpu) { { var port = cpu.reg16[reg_dx]; cpu.test_privileges_for_io(port, 1); cpu.io.port_write8(port, cpu.reg8[reg_al]); } };;
table16[0xEF] = function(cpu) { { var port = cpu.reg16[reg_dx]; cpu.test_privileges_for_io(port, 2); cpu.io.port_write16(port, cpu.reg16[reg_ax]); } }; table32[0xEF] = function(cpu) { { var port = cpu.reg16[reg_dx]; cpu.test_privileges_for_io(port, 4); cpu.io.port_write32(port, cpu.reg32s[reg_eax]); } };;
table16[0xF0] = table32[0xF0] = function(cpu) { { /* lock*/ /* TODO*/ /* This triggers UD when used with*/ /* some instructions that don't write to memory*/ cpu.do_op(); } };;
table16[0xF1] = table32[0xF1] = function(cpu) { { /* INT1*/ /* https://code.google.com/p/corkami/wiki/x86oddities#IceBP*/ throw cpu.debug.unimpl("int1 instruction"); } };;
table16[0xF2] = table32[0xF2] = function(cpu) { { /* repnz*/ dbg_assert(cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_NONE); cpu.repeat_string_prefix = REPEAT_STRING_PREFIX_NZ; cpu.do_op(); cpu.repeat_string_prefix = REPEAT_STRING_PREFIX_NONE; } };;
table16[0xF3] = table32[0xF3] = function(cpu) { { /* repz*/ dbg_assert(cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_NONE); cpu.repeat_string_prefix = REPEAT_STRING_PREFIX_Z; cpu.do_op(); cpu.repeat_string_prefix = REPEAT_STRING_PREFIX_NONE; } };;
table16[0xF4] = table32[0xF4] = function(cpu) { { cpu.hlt_op(); } };;
table16[0xF5] = table32[0xF5] = function(cpu) { { /* cmc*/ cpu.flags = (cpu.flags | 1) ^ cpu.getcf(); cpu.flags_changed &= ~1; } };;
table16[0xF6] = table32[0xF6] = function(cpu) { var modrm_byte = cpu.read_imm8(); { switch(modrm_byte >> 3 & 7) { case 0: { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.and(data, cpu.read_imm8(), OPSIZE_8); }; break; case 1: { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.and(data, cpu.read_imm8(), OPSIZE_8); }; break; case 2: { var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = ~(data); if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; }; }; break; case 3: { var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = cpu.neg(data, OPSIZE_8); if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; }; }; break; case 4: { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.mul8(data); }; break; case 5: { if(modrm_byte < 0xC0) { var data = (cpu.safe_read8(cpu.modrm_resolve(modrm_byte)) << 24 >> 24); } else { data = cpu.reg8s[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.imul8(data); }; break; case 6: { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.div8(data); }; break; case 7: { if(modrm_byte < 0xC0) { var data = (cpu.safe_read8(cpu.modrm_resolve(modrm_byte)) << 24 >> 24); } else { data = cpu.reg8s[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.idiv8(data); }; break; } } };;
table16[0xF7] = function(cpu) { var modrm_byte = cpu.read_imm8(); { switch(modrm_byte >> 3 & 7) { case 0: { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.and(data, cpu.read_imm16(), OPSIZE_16); }; break; case 1: { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.and(data, cpu.read_imm16(), OPSIZE_16); }; break; case 2: { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = ~(data); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; }; }; break; case 3: { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.neg(data, OPSIZE_16); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; }; }; break; case 4: { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.mul16(data); }; break; case 5: { if(modrm_byte < 0xC0) { var data = (cpu.safe_read16(cpu.modrm_resolve(modrm_byte)) << 16 >> 16); } else { data = cpu.reg16s[modrm_byte << 1 & 14]; }; cpu.imul16(data); }; break; case 6: { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.div16(data); }; break; case 7: { if(modrm_byte < 0xC0) { var data = (cpu.safe_read16(cpu.modrm_resolve(modrm_byte)) << 16 >> 16); } else { data = cpu.reg16s[modrm_byte << 1 & 14]; }; cpu.idiv16(data); }; break; } } }; table32[0xF7] = function(cpu) { var modrm_byte = cpu.read_imm8(); { switch(modrm_byte >> 3 & 7) { case 0: { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.and(data, cpu.read_imm32s(), OPSIZE_32); }; break; case 1: { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.and(data, cpu.read_imm32s(), OPSIZE_32); }; break; case 2: { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = ~(data); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; }; }; break; case 3: { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.neg(data, OPSIZE_32); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; }; }; break; case 4: { if(modrm_byte < 0xC0) { var data = (cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)) >>> 0); } else { data = cpu.reg32[modrm_byte & 7]; }; cpu.mul32(data); }; break; case 5: { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.imul32(data); }; break; case 6: { if(modrm_byte < 0xC0) { var data = (cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)) >>> 0); } else { data = cpu.reg32[modrm_byte & 7]; }; cpu.div32(data); }; break; case 7: { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.idiv32(data); }; break; } } };;
table16[0xF8] = table32[0xF8] = function(cpu) { { /* clc*/ cpu.flags &= ~flag_carry; cpu.flags_changed &= ~1; } };;
table16[0xF9] = table32[0xF9] = function(cpu) { { /* stc*/ cpu.flags |= flag_carry; cpu.flags_changed &= ~1; } };;
table16[0xFA] = table32[0xFA] = function(cpu) { { /* cli*/ /*dbg_log("interrupts off");*/ if(!cpu.protected_mode || ((cpu.flags & flag_vm) ? cpu.getiopl() === 3 : cpu.getiopl() >= cpu.cpl)) { cpu.flags &= ~flag_interrupt; } else { if(cpu.getiopl() < 3 && ((cpu.flags & flag_vm) ? (cpu.cr[4] & CR4_VME) : (cpu.cpl === 3 && (cpu.cr[4] & CR4_PVI)))) { cpu.flags &= ~flag_vif; } else { cpu.trigger_gp(0); } } } };;
table16[0xFB] = table32[0xFB] = function(cpu) { { /* sti*/ /*dbg_log("interrupts on");*/ if(!cpu.protected_mode || ((cpu.flags & flag_vm) ? cpu.getiopl() === 3 : cpu.getiopl() >= cpu.cpl)) { cpu.flags |= flag_interrupt; /*cpu.table[cpu.read_imm8()](cpu);*/ cpu.cycle(); cpu.handle_irqs(); } else { if(cpu.getiopl() < 3 && (cpu.flags & flag_vip) === 0 && ((cpu.flags & flag_vm) ? (cpu.cr[4] & CR4_VME) : (cpu.cpl === 3 && (cpu.cr[4] & CR4_PVI)))) { cpu.flags |= flag_vif; } else { cpu.trigger_gp(0); } } } };;
table16[0xFC] = table32[0xFC] = function(cpu) { { /* cld*/ cpu.flags &= ~flag_direction; } };;
table16[0xFD] = table32[0xFD] = function(cpu) { { /* std*/ cpu.flags |= flag_direction; } };;
table16[0xFE] = table32[0xFE] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var mod = modrm_byte & 56; if(mod === 0) { var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = cpu.inc(data, OPSIZE_8); if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; }; } else if(mod === 8) { var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = cpu.dec(data, OPSIZE_8); if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; }; } else { if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } } };;
table16[0xFF] = function(cpu) { var modrm_byte = cpu.read_imm8(); { switch(modrm_byte >> 3 & 7) { case 0: { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.inc(data, OPSIZE_16); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; }; }; break; case 1: { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.dec(data, OPSIZE_16); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; }; }; break; case 2: { /* 2, call near*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.push16(cpu.get_real_eip()); cpu.instruction_pointer = cpu.get_seg(reg_cs) + data | 0; cpu.last_instr_jump = true; }; break; case 3: { /* 3, callf*/ if(modrm_byte >= 0xC0) { cpu.trigger_ud(); dbg_assert(false, "unreachable"); } var virt_addr = cpu.modrm_resolve(modrm_byte); var new_cs = cpu.safe_read16(virt_addr + 2); var new_ip = cpu.safe_read16(virt_addr); cpu.writable_or_pagefault(cpu.get_stack_pointer(-4), 4); cpu.push16(cpu.sreg[reg_cs]); cpu.push16(cpu.get_real_eip()); cpu.switch_seg(reg_cs, new_cs); cpu.instruction_pointer = cpu.get_seg(reg_cs) + new_ip | 0; cpu.last_instr_jump = true; }; break; case 4: { /* 4, jmp near*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.instruction_pointer = cpu.get_seg(reg_cs) + data | 0; cpu.last_instr_jump = true; }; break; case 5: { /* 5, jmpf*/ if(modrm_byte >= 0xC0) { cpu.trigger_ud(); dbg_assert(false, "unreachable"); } var virt_addr = cpu.modrm_resolve(modrm_byte); var new_cs = cpu.safe_read16(virt_addr + 2); var new_ip = cpu.safe_read16(virt_addr); cpu.switch_seg(reg_cs, new_cs); cpu.instruction_pointer = cpu.get_seg(reg_cs) + new_ip | 0; cpu.last_instr_jump = true; }; break; case 6: { /* 6, push*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.push16(data); }; break; case 7: { if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; }; break; } } }; table32[0xFF] = function(cpu) { var modrm_byte = cpu.read_imm8(); { switch(modrm_byte >> 3 & 7) { case 0: { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.inc(data, OPSIZE_32); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; }; }; break; case 1: { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.dec(data, OPSIZE_32); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; }; }; break; case 2: { /* 2, call near*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.push32(cpu.get_real_eip()); cpu.instruction_pointer = cpu.get_seg(reg_cs) + data | 0; cpu.last_instr_jump = true; }; break; case 3: { /* 3, callf*/ if(modrm_byte >= 0xC0) { cpu.trigger_ud(); dbg_assert(false, "unreachable"); } var virt_addr = cpu.modrm_resolve(modrm_byte); var new_cs = cpu.safe_read16(virt_addr + 4); var new_ip = cpu.safe_read32s(virt_addr); cpu.writable_or_pagefault(cpu.get_stack_pointer(-8), 8); cpu.push32(cpu.sreg[reg_cs]); cpu.push32(cpu.get_real_eip()); cpu.switch_seg(reg_cs, new_cs); cpu.instruction_pointer = cpu.get_seg(reg_cs) + new_ip | 0; cpu.last_instr_jump = true; }; break; case 4: { /* 4, jmp near*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.instruction_pointer = cpu.get_seg(reg_cs) + data | 0; cpu.last_instr_jump = true; }; break; case 5: { /* 5, jmpf*/ if(modrm_byte >= 0xC0) { cpu.trigger_ud(); dbg_assert(false, "unreachable"); } var virt_addr = cpu.modrm_resolve(modrm_byte); var new_cs = cpu.safe_read16(virt_addr + 4); var new_ip = cpu.safe_read32s(virt_addr); cpu.switch_seg(reg_cs, new_cs); cpu.instruction_pointer = cpu.get_seg(reg_cs) + new_ip | 0; cpu.last_instr_jump = true; }; break; case 6: { /* push*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.push32(data); }; break; case 7: { if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; }; break; } } };;
// 0F ops start here
table0F_16[0x00] = table0F_32[0x00] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /*console.log("0x00 protected_mode=%s vm86_mode=%s cpl=%s", cpu.protected_mode, cpu.vm86_mode(), cpu.cpl);*/ if(!cpu.protected_mode || cpu.vm86_mode()) { /* No GP, UD is correct here*/ cpu.trigger_ud(); } if(cpu.cpl) { cpu.trigger_gp(0); } switch(modrm_byte >> 3 & 7) { case 0: /* sldt*/ if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = cpu.sreg[reg_ldtr]; if(modrm_byte < 0xC0) { cpu.safe_write16(addr, data); } else { cpu.reg16[modrm_byte << 1 & 14] = data; }; break; case 1: /* str*/ if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = cpu.sreg[reg_tr]; if(modrm_byte < 0xC0) { cpu.safe_write16(addr, data); } else { cpu.reg16[modrm_byte << 1 & 14] = data; }; break; case 2: /* lldt*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.load_ldt(data); break; case 3: /* ltr*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.load_tr(data); break; default: dbg_log(modrm_byte >> 3 & 7, LOG_CPU); if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } } };;
table0F_16[0x01] = table0F_32[0x01] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(cpu.cpl) { cpu.trigger_gp(0); } var mod = modrm_byte >> 3 & 7; if(mod === 4) { /* smsw*/ if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = cpu.cr[0]; if(modrm_byte < 0xC0) { cpu.safe_write16(addr, data); } else { cpu.reg16[modrm_byte << 1 & 14] = data; }; return; } else if(mod === 6) { /* lmsw*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; var old_cr0 = cpu.cr[0]; cpu.cr[0] = (cpu.cr[0] & ~0xF) | (data & 0xF); if(cpu.protected_mode) { /* lmsw cannot be used to switch back*/ cpu.cr[0] |= CR0_PE; } /*dbg_log("cr0=" + h(data >>> 0), LOG_CPU);*/ cpu.cr0_changed(old_cr0); return; } if(modrm_byte >= 0xC0) { /* only memory*/ cpu.trigger_ud(); } if((mod === 2 || mod === 3) && cpu.protected_mode) { /* override prefix, so cpu.modrm_resolve does not return the segment part*/ /* only lgdt and lidt and only in protected mode*/ cpu.segment_prefix = SEG_PREFIX_ZERO; } var addr = cpu.modrm_resolve(modrm_byte); cpu.segment_prefix = SEG_PREFIX_NONE; switch(mod) { case 0: /* sgdt*/ cpu.writable_or_pagefault(addr, 6); cpu.safe_write16(addr, cpu.gdtr_size); cpu.safe_write32(addr + 2, cpu.gdtr_offset); break; case 1: /* sidt*/ cpu.writable_or_pagefault(addr, 6); cpu.safe_write16(addr, cpu.idtr_size); cpu.safe_write32(addr + 2, cpu.idtr_offset); break; case 2: /* lgdt*/ var size = cpu.safe_read16(addr); var offset = cpu.safe_read32s(addr + 2); cpu.gdtr_size = size; cpu.gdtr_offset = offset; if(!cpu.operand_size_32) { cpu.gdtr_offset &= 0xFFFFFF; } /*dbg_log("gdt at " + h(cpu.gdtr_offset) + ", " + cpu.gdtr_size + " bytes", LOG_CPU);*/ /*dump_gdt_ldt();*/ break; case 3: /* lidt*/ var size = cpu.safe_read16(addr); var offset = cpu.safe_read32s(addr + 2); cpu.idtr_size = size; cpu.idtr_offset = offset; if(!cpu.operand_size_32) { cpu.idtr_offset &= 0xFFFFFF; } /*dbg_log("[" + h(cpu.instruction_pointer) + "] idt at " + */ /*        h(idtr_offset) + ", " + cpu.idtr_size + " bytes " + h(addr), LOG_CPU);*/ break; case 7: /* flush translation lookaside buffer*/ cpu.invlpg(addr); break; default: dbg_log(mod); if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } } };;
table0F_16[0x02] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* lar*/ dbg_log("lar", LOG_CPU); if(!cpu.protected_mode || cpu.vm86_mode()) { cpu.trigger_ud(); } if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.lar(data, cpu.reg16[modrm_byte >> 2 & 14]); } }; table0F_32[0x02] = function(cpu) { var modrm_byte = cpu.read_imm8(); { dbg_log("lar", LOG_CPU); if(!cpu.protected_mode || cpu.vm86_mode()) { cpu.trigger_ud(); } if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.lar(data, cpu.reg32s[modrm_byte >> 3 & 7]); } };;
table0F_16[0x03] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* lsl*/ dbg_log("lsl", LOG_CPU); if(!cpu.protected_mode || cpu.vm86_mode()) { cpu.trigger_ud(); } if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.lsl(data, cpu.reg16[modrm_byte >> 2 & 14]); } }; table0F_32[0x03] = function(cpu) { var modrm_byte = cpu.read_imm8(); { dbg_log("lsl", LOG_CPU); if(!cpu.protected_mode || cpu.vm86_mode()) { cpu.trigger_ud(); } if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.lsl(data, cpu.reg32s[modrm_byte >> 3 & 7]); } };;
table0F_16[0x04] = table0F_32[0x04] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0x05] = table0F_32[0x05] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0x06] = table0F_32[0x06] = function(cpu) { { /* clts*/ if(cpu.cpl) { cpu.trigger_gp(0); } else { /*dbg_log("clts", LOG_CPU);*/ cpu.cr[0] &= ~CR0_TS; /* do something here ?*/ } } };;
table0F_16[0x07] = table0F_32[0x07] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0x08] = table0F_32[0x08] = function(cpu) { { /* invd*/ if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } };
table0F_16[0x09] = table0F_32[0x09] = function(cpu) { { if(cpu.cpl) { cpu.trigger_gp(0); } /* wbinvd*/ } };;
table0F_16[0x0A] = table0F_32[0x0A] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0x0B] = table0F_32[0x0B] = function(cpu) { { /* UD2*/ cpu.trigger_ud(); } };;
table0F_16[0x0C] = table0F_32[0x0C] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0x0D] = table0F_32[0x0D] = function(cpu) { { /* nop*/ if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } };
table0F_16[0x0E] = table0F_32[0x0E] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0x0F] = table0F_32[0x0F] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0x10] = table0F_32[0x10] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x11] = table0F_32[0x11] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x12] = table0F_32[0x12] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x13] = table0F_32[0x13] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x14] = table0F_32[0x14] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x15] = table0F_32[0x15] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x16] = table0F_32[0x16] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x17] = table0F_32[0x17] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x18] = table0F_32[0x18] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* prefetch*/ /* nop for us */ if(modrm_byte < 0xC0) cpu.modrm_resolve(modrm_byte); } };;
table0F_16[0x19] = table0F_32[0x19] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x1A] = table0F_32[0x1A] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x1B] = table0F_32[0x1B] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x1C] = table0F_32[0x1C] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x1D] = table0F_32[0x1D] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x1E] = table0F_32[0x1E] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x1F] = table0F_32[0x1F] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x20] = table0F_32[0x20] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(cpu.cpl) { cpu.trigger_gp(0); } /*dbg_log("cr" + mod + " read", LOG_CPU);*/ /* mov addr, cr*/ /* mod = which control register*/ switch(modrm_byte >> 3 & 7) { case 0: cpu.reg32s[modrm_byte & 7] = cpu.cr[0]; break; case 2: cpu.reg32s[modrm_byte & 7] = cpu.cr[2]; break; case 3: /*dbg_log("read cr3 (" + h(cpu.cr[3], 8) + ")", LOG_CPU);*/ cpu.reg32s[modrm_byte & 7] = cpu.cr[3]; break; case 4: cpu.reg32s[modrm_byte & 7] = cpu.cr[4]; break; default: dbg_log(modrm_byte >> 3 & 7); if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } } };;
table0F_16[0x21] = table0F_32[0x21] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(cpu.cpl) { cpu.trigger_gp(0); } /* TODO: mov from debug register*/ dbg_assert(modrm_byte >= 0xC0); cpu.reg32s[modrm_byte & 7] = cpu.dreg[modrm_byte >> 3 & 7]; /*dbg_log("read dr" + (modrm_byte >> 3 & 7) + ": " + h(cpu.reg32[modrm_byte & 7]), LOG_CPU);*/ } };;
table0F_16[0x22] = table0F_32[0x22] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(cpu.cpl) { cpu.trigger_gp(0); } var data = cpu.reg32s[modrm_byte & 7]; /*dbg_log("cr" + mod + " written: " + h(cpu.reg32[reg]), LOG_CPU);*/ /* mov cr, addr*/ /* mod = which control register*/ switch(modrm_byte >> 3 & 7) { case 0: var old_cr0 = cpu.cr[0]; cpu.cr[0] = data; if((cpu.cr[0] & (CR0_PE | CR0_PG)) === CR0_PG) { /* cannot load PG without PE*/ throw cpu.debug.unimpl("#GP handler"); } cpu.cr0_changed(old_cr0); /*dbg_log("cr0=" + h(data >>> 0), LOG_CPU);*/ break; case 2: cpu.cr[2] = data; /*dbg_log("cr2=" + h(data >>> 0), LOG_CPU);*/ break; case 3: /*dbg_log("cr3=" + h(data >>> 0), LOG_CPU);*/ cpu.cr[3] = data; dbg_assert((cpu.cr[3] & 0xFFF) === 0); cpu.clear_tlb(); /*dump_page_directory();*/ /*dbg_log("page directory loaded at " + h(cpu.cr[3] >>> 0, 8), LOG_CPU);*/ break; case 4: if(data & (1 << 11 | 1 << 12 | 1 << 15 | 1 << 16 | 1 << 19 | 0xFFC00000)) { cpu.trigger_gp(0); } if((cpu.cr[4] ^ data) & CR4_PGE) { if(data & CR4_PGE) { /* The PGE bit has been enabled. The global TLB is*/ /* still empty, so we only have to copy it over*/ cpu.clear_tlb(); } else { /* Clear the global TLB*/ cpu.full_clear_tlb(); } } cpu.cr[4] = data; cpu.page_size_extensions = (cpu.cr[4] & CR4_PSE) ? PSE_ENABLED : 0; if(cpu.cr[4] & CR4_PAE) { throw cpu.debug.unimpl("PAE"); } dbg_log("cr4=" + h(cpu.cr[4] >>> 0), LOG_CPU); break; default: dbg_log(modrm_byte >> 3 & 7); if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } } };;
table0F_16[0x23] = table0F_32[0x23] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(cpu.cpl) { cpu.trigger_gp(0); } /* TODO: mov to debug register*/ dbg_assert(modrm_byte >= 0xC0); /*dbg_log("write dr" + (modrm_byte >> 3 & 7) + ": " + h(cpu.reg32[modrm_byte & 7]), LOG_CPU);*/ cpu.dreg[modrm_byte >> 3 & 7] = cpu.reg32s[modrm_byte & 7]; } };;
table0F_16[0x24] = table0F_32[0x24] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0x25] = table0F_32[0x25] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0x26] = table0F_32[0x26] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0x27] = table0F_32[0x27] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0x28] = table0F_32[0x28] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x29] = table0F_32[0x29] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x2A] = table0F_32[0x2A] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x2B] = table0F_32[0x2B] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x2C] = table0F_32[0x2C] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x2D] = table0F_32[0x2D] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x2E] = table0F_32[0x2E] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x2F] = table0F_32[0x2F] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
// wrmsr
table0F_16[0x30] = table0F_32[0x30] = function(cpu) { { /* wrmsr - write maschine specific register*/ if(cpu.cpl) { /* cpl > 0 or vm86 mode (vm86 mode is always runs with cpl=3)*/ cpu.trigger_gp(0); } var index = cpu.reg32s[reg_ecx]; var low = cpu.reg32s[reg_eax]; var high = cpu.reg32s[reg_edx]; dbg_log("wrmsr ecx=" + h(index >>> 0, 8) + " data=" + h(high >>> 0, 8) + ":" + h(low >>> 0, 8), LOG_CPU); switch(index) { case IA32_SYSENTER_CS: cpu.sysenter_cs = low & 0xFFFF; break; case IA32_SYSENTER_EIP: cpu.sysenter_eip = low; break; case IA32_SYSENTER_ESP: cpu.sysenter_esp = low; break; } } };;
table0F_16[0x31] = table0F_32[0x31] = function(cpu) { { /* rdtsc - read timestamp counter*/ if(!cpu.cpl || !(cpu.cr[4] & CR4_TSD)) { var n = v86.microtick() - cpu.tsc_offset; dbg_assert(isFinite(n), "non-finite tsc: " + n); cpu.reg32s[reg_eax] = n * TSC_RATE; cpu.reg32s[reg_edx] = n * (TSC_RATE / 0x100000000); /*dbg_log("rtdsc  edx:eax=" + h(cpu.reg32[reg_edx], 8) + ":" + h(cpu.reg32[reg_eax], 8), LOG_CPU);*/ } else { cpu.trigger_gp(0); } } };;
table0F_16[0x32] = table0F_32[0x32] = function(cpu) { { /* rdmsr - read maschine specific register*/ if(cpu.cpl) { cpu.trigger_gp(0); } var index = cpu.reg32s[reg_ecx]; dbg_log("rdmsr ecx=" + h(index >>> 0, 8), LOG_CPU); var low = 0; var high = 0; switch(index) { case IA32_SYSENTER_CS: low = cpu.sysenter_cs; break; case IA32_SYSENTER_EIP: low = cpu.sysenter_eip; break; case IA32_SYSENTER_ESP: low = cpu.sysenter_esp; break; } cpu.reg32s[reg_eax] = low; cpu.reg32s[reg_edx] = high; } };;
table0F_16[0x33] = table0F_32[0x33] = function(cpu) { { /* rdpmc*/ if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } };
table0F_16[0x34] = table0F_32[0x34] = function(cpu) { { /* sysenter*/ var seg = cpu.sysenter_cs & 0xFFFC; if(!cpu.protected_mode || seg === 0) { cpu.trigger_gp(0); } /*dbg_log("sysenter  cs:eip=" + h(seg    , 4) + ":" + h(cpu.sysenter_eip >>> 0, 8) + */ /*                 " ss:esp=" + h(seg + 8, 4) + ":" + h(cpu.sysenter_esp >>> 0, 8), LOG_CPU);*/ cpu.flags &= ~flag_vm & ~flag_interrupt; cpu.instruction_pointer = cpu.sysenter_eip; cpu.reg32s[reg_esp] = cpu.sysenter_esp; cpu.sreg[reg_cs] = seg; cpu.segment_is_null[reg_cs] = 0; cpu.segment_limits[reg_cs] = -1; cpu.segment_offsets[reg_cs] = 0; if(!cpu.is_32) cpu.update_cs_size(true); cpu.cpl = 0; cpu.cpl_changed(); cpu.sreg[reg_ss] = seg + 8; cpu.segment_is_null[reg_ss] = 0; cpu.segment_limits[reg_ss] = -1; cpu.segment_offsets[reg_ss] = 0; cpu.stack_size_32 = true; console.log("stack_reg <- 32"); cpu.stack_reg = cpu.reg32s; cpu.reg_vsp = reg_esp; cpu.reg_vbp = reg_ebp; } };;
table0F_16[0x35] = table0F_32[0x35] = function(cpu) { { /* sysexit*/ var seg = cpu.sysenter_cs & 0xFFFC; if(!cpu.protected_mode || cpu.cpl || seg === 0) { cpu.trigger_gp(0); } /*dbg_log("sysexit  cs:eip=" + h(seg + 16, 4) + ":" + h(cpu.reg32s[reg_edx] >>> 0, 8) + */ /*                 " ss:esp=" + h(seg + 24, 4) + ":" + h(cpu.reg32s[reg_ecx] >>> 0, 8), LOG_CPU);*/ cpu.instruction_pointer = cpu.reg32s[reg_edx]; cpu.reg32s[reg_esp] = cpu.reg32s[reg_ecx]; cpu.sreg[reg_cs] = seg + 16 | 3; cpu.segment_is_null[reg_cs] = 0; cpu.segment_limits[reg_cs] = -1; cpu.segment_offsets[reg_cs] = 0; if(!cpu.is_32) cpu.update_cs_size(true); cpu.cpl = 3; cpu.cpl_changed(); cpu.sreg[reg_ss] = seg + 24 | 3; cpu.segment_is_null[reg_ss] = 0; cpu.segment_limits[reg_ss] = -1; cpu.segment_offsets[reg_ss] = 0; cpu.stack_size_32 = true; console.log("stack_reg <- 32"); cpu.stack_reg = cpu.reg32s; cpu.reg_vsp = reg_esp; cpu.reg_vbp = reg_ebp; } };;
table0F_16[0x36] = table0F_32[0x36] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0x37] = table0F_32[0x37] = function(cpu) { { /* getsec*/ if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } };
table0F_16[0x38] = table0F_32[0x38] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x39] = table0F_32[0x39] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x3A] = table0F_32[0x3A] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x3B] = table0F_32[0x3B] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x3C] = table0F_32[0x3C] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x3D] = table0F_32[0x3D] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x3E] = table0F_32[0x3E] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x3F] = table0F_32[0x3F] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
// cmov
table0F_16[0x40 | 0x0] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if(( cpu.test_o())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0x0] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if(( cpu.test_o())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0x1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if((!cpu.test_o())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0x1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if((!cpu.test_o())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0x2] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if(( cpu.test_b())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0x2] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if(( cpu.test_b())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0x3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if((!cpu.test_b())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0x3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if((!cpu.test_b())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0x4] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if(( cpu.test_z())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0x4] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if(( cpu.test_z())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0x5] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if((!cpu.test_z())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0x5] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if((!cpu.test_z())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0x6] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if(( cpu.test_be())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0x6] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if(( cpu.test_be())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0x7] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if((!cpu.test_be())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0x7] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if((!cpu.test_be())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0x8] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if(( cpu.test_s())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0x8] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if(( cpu.test_s())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0x9] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if((!cpu.test_s())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0x9] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if((!cpu.test_s())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0xA] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if(( cpu.test_p())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0xA] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if(( cpu.test_p())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0xB] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if((!cpu.test_p())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0xB] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if((!cpu.test_p())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0xC] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if(( cpu.test_l())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0xC] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if(( cpu.test_l())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0xD] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if((!cpu.test_l())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0xD] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if((!cpu.test_l())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0xE] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if(( cpu.test_le())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0xE] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if(( cpu.test_le())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;; table0F_16[0x40 | 0xF] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; if((!cpu.test_le())) { cpu.reg16[modrm_byte >> 2 & 14] = data; } } }; table0F_32[0x40 | 0xF] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; if((!cpu.test_le())) { cpu.reg32s[modrm_byte >> 3 & 7] = data; } } };;;;
table0F_16[0x50] = table0F_32[0x50] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x51] = table0F_32[0x51] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x52] = table0F_32[0x52] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x53] = table0F_32[0x53] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x54] = table0F_32[0x54] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x55] = table0F_32[0x55] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x56] = table0F_32[0x56] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x57] = table0F_32[0x57] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x58] = table0F_32[0x58] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x59] = table0F_32[0x59] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x5A] = table0F_32[0x5A] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x5B] = table0F_32[0x5B] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x5C] = table0F_32[0x5C] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x5D] = table0F_32[0x5D] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x5E] = table0F_32[0x5E] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x5F] = table0F_32[0x5F] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x60] = table0F_32[0x60] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x61] = table0F_32[0x61] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x62] = table0F_32[0x62] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x63] = table0F_32[0x63] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x64] = table0F_32[0x64] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x65] = table0F_32[0x65] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x66] = table0F_32[0x66] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x67] = table0F_32[0x67] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x68] = table0F_32[0x68] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x69] = table0F_32[0x69] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x6A] = table0F_32[0x6A] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x6B] = table0F_32[0x6B] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x6C] = table0F_32[0x6C] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x6D] = table0F_32[0x6D] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x6E] = table0F_32[0x6E] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x6F] = table0F_32[0x6F] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x70] = table0F_32[0x70] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x71] = table0F_32[0x71] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x72] = table0F_32[0x72] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x73] = table0F_32[0x73] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x74] = table0F_32[0x74] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x75] = table0F_32[0x75] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x76] = table0F_32[0x76] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x77] = table0F_32[0x77] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x78] = table0F_32[0x78] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x79] = table0F_32[0x79] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x7A] = table0F_32[0x7A] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x7B] = table0F_32[0x7B] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x7C] = table0F_32[0x7C] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x7D] = table0F_32[0x7D] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x7E] = table0F_32[0x7E] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x7F] = table0F_32[0x7F] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0x80 | 0x0] = function(cpu) { { cpu.jmpcc16(( cpu.test_o())); } }; table0F_32[0x80 | 0x0] = function(cpu) { { cpu.jmpcc32(( cpu.test_o())); } };; table0F_16[0x80 | 0x1] = function(cpu) { { cpu.jmpcc16((!cpu.test_o())); } }; table0F_32[0x80 | 0x1] = function(cpu) { { cpu.jmpcc32((!cpu.test_o())); } };; table0F_16[0x80 | 0x2] = function(cpu) { { cpu.jmpcc16(( cpu.test_b())); } }; table0F_32[0x80 | 0x2] = function(cpu) { { cpu.jmpcc32(( cpu.test_b())); } };; table0F_16[0x80 | 0x3] = function(cpu) { { cpu.jmpcc16((!cpu.test_b())); } }; table0F_32[0x80 | 0x3] = function(cpu) { { cpu.jmpcc32((!cpu.test_b())); } };; table0F_16[0x80 | 0x4] = function(cpu) { { cpu.jmpcc16(( cpu.test_z())); } }; table0F_32[0x80 | 0x4] = function(cpu) { { cpu.jmpcc32(( cpu.test_z())); } };; table0F_16[0x80 | 0x5] = function(cpu) { { cpu.jmpcc16((!cpu.test_z())); } }; table0F_32[0x80 | 0x5] = function(cpu) { { cpu.jmpcc32((!cpu.test_z())); } };; table0F_16[0x80 | 0x6] = function(cpu) { { cpu.jmpcc16(( cpu.test_be())); } }; table0F_32[0x80 | 0x6] = function(cpu) { { cpu.jmpcc32(( cpu.test_be())); } };; table0F_16[0x80 | 0x7] = function(cpu) { { cpu.jmpcc16((!cpu.test_be())); } }; table0F_32[0x80 | 0x7] = function(cpu) { { cpu.jmpcc32((!cpu.test_be())); } };; table0F_16[0x80 | 0x8] = function(cpu) { { cpu.jmpcc16(( cpu.test_s())); } }; table0F_32[0x80 | 0x8] = function(cpu) { { cpu.jmpcc32(( cpu.test_s())); } };; table0F_16[0x80 | 0x9] = function(cpu) { { cpu.jmpcc16((!cpu.test_s())); } }; table0F_32[0x80 | 0x9] = function(cpu) { { cpu.jmpcc32((!cpu.test_s())); } };; table0F_16[0x80 | 0xA] = function(cpu) { { cpu.jmpcc16(( cpu.test_p())); } }; table0F_32[0x80 | 0xA] = function(cpu) { { cpu.jmpcc32(( cpu.test_p())); } };; table0F_16[0x80 | 0xB] = function(cpu) { { cpu.jmpcc16((!cpu.test_p())); } }; table0F_32[0x80 | 0xB] = function(cpu) { { cpu.jmpcc32((!cpu.test_p())); } };; table0F_16[0x80 | 0xC] = function(cpu) { { cpu.jmpcc16(( cpu.test_l())); } }; table0F_32[0x80 | 0xC] = function(cpu) { { cpu.jmpcc32(( cpu.test_l())); } };; table0F_16[0x80 | 0xD] = function(cpu) { { cpu.jmpcc16((!cpu.test_l())); } }; table0F_32[0x80 | 0xD] = function(cpu) { { cpu.jmpcc32((!cpu.test_l())); } };; table0F_16[0x80 | 0xE] = function(cpu) { { cpu.jmpcc16(( cpu.test_le())); } }; table0F_32[0x80 | 0xE] = function(cpu) { { cpu.jmpcc32(( cpu.test_le())); } };; table0F_16[0x80 | 0xF] = function(cpu) { { cpu.jmpcc16((!cpu.test_le())); } }; table0F_32[0x80 | 0xF] = function(cpu) { { cpu.jmpcc32((!cpu.test_le())); } };;
table0F_16[0x90 | 0x0] = table0F_32[0x90 | 0x0] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !( cpu.test_o()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0x1] = table0F_32[0x90 | 0x1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !(!cpu.test_o()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0x2] = table0F_32[0x90 | 0x2] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !( cpu.test_b()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0x3] = table0F_32[0x90 | 0x3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !(!cpu.test_b()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0x4] = table0F_32[0x90 | 0x4] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !( cpu.test_z()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0x5] = table0F_32[0x90 | 0x5] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !(!cpu.test_z()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0x6] = table0F_32[0x90 | 0x6] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !( cpu.test_be()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0x7] = table0F_32[0x90 | 0x7] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !(!cpu.test_be()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0x8] = table0F_32[0x90 | 0x8] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !( cpu.test_s()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0x9] = table0F_32[0x90 | 0x9] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !(!cpu.test_s()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0xA] = table0F_32[0x90 | 0xA] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !( cpu.test_p()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0xB] = table0F_32[0x90 | 0xB] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !(!cpu.test_p()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0xC] = table0F_32[0x90 | 0xC] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !( cpu.test_l()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0xD] = table0F_32[0x90 | 0xD] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !(!cpu.test_l()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0xE] = table0F_32[0x90 | 0xE] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !( cpu.test_le()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;; table0F_16[0x90 | 0xF] = table0F_32[0x90 | 0xF] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte); var data = !(!cpu.test_le()) ^ 1; if(modrm_byte < 0xC0) { cpu.safe_write8(addr, data); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = data; }; } };;;;
table0F_16[0xA0] = function(cpu) { { cpu.push16(cpu.sreg[reg_fs]); } }; table0F_32[0xA0] = function(cpu) { { cpu.push32(cpu.sreg[reg_fs]); } };;
table0F_16[0xA1] = function(cpu) { { cpu.switch_seg(reg_fs, cpu.safe_read16(cpu.get_stack_pointer(0))); cpu.stack_reg[cpu.reg_vsp] += 2; } }; table0F_32[0xA1] = function(cpu) { { cpu.switch_seg(reg_fs, cpu.safe_read16(cpu.get_stack_pointer(0))); cpu.stack_reg[cpu.reg_vsp] += 4; } };;;
table0F_16[0xA2] = table0F_32[0xA2] = function(cpu) { { cpu.cpuid(); } };;
table0F_16[0xA3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { cpu.bt_mem(cpu.modrm_resolve(modrm_byte), cpu.reg16s[modrm_byte >> 2 & 14]); } else { cpu.bt_reg(cpu.reg16[modrm_byte << 1 & 14], cpu.reg16[modrm_byte >> 2 & 14] & 15); } } }; table0F_32[0xA3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { cpu.bt_mem(cpu.modrm_resolve(modrm_byte), cpu.reg32s[modrm_byte >> 3 & 7]); } else { cpu.bt_reg(cpu.reg32s[modrm_byte & 7], cpu.reg32s[modrm_byte >> 3 & 7] & 31); } } };;
table0F_16[0xA4] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.shld16(data, cpu.reg16[modrm_byte >> 2 & 14], cpu.read_imm8() & 31); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; }; } }; table0F_32[0xA4] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.shld32(data, cpu.reg32s[modrm_byte >> 3 & 7], cpu.read_imm8() & 31); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; }; } };;
table0F_16[0xA5] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.shld16(data, cpu.reg16[modrm_byte >> 2 & 14], cpu.reg8[reg_cl] & 31); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; }; } }; table0F_32[0xA5] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.shld32(data, cpu.reg32s[modrm_byte >> 3 & 7], cpu.reg8[reg_cl] & 31); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; }; } };;
table0F_16[0xA6] = table0F_32[0xA6] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0xA7] = table0F_32[0xA7] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
table0F_16[0xA8] = function(cpu) { { cpu.push16(cpu.sreg[reg_gs]); } }; table0F_32[0xA8] = function(cpu) { { cpu.push32(cpu.sreg[reg_gs]); } };;
table0F_16[0xA9] = function(cpu) { { cpu.switch_seg(reg_gs, cpu.safe_read16(cpu.get_stack_pointer(0))); cpu.stack_reg[cpu.reg_vsp] += 2; } }; table0F_32[0xA9] = function(cpu) { { cpu.switch_seg(reg_gs, cpu.safe_read16(cpu.get_stack_pointer(0))); cpu.stack_reg[cpu.reg_vsp] += 4; } };;;
table0F_16[0xAA] = table0F_32[0xAA] = function(cpu) { { /* rsm*/ if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } };
table0F_16[0xAB] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { cpu.bts_mem(cpu.modrm_resolve(modrm_byte), cpu.reg16s[modrm_byte >> 2 & 14]); } else { cpu.reg16[modrm_byte << 1 & 14] = cpu.bts_reg(cpu.reg16[modrm_byte << 1 & 14], cpu.reg16s[modrm_byte >> 2 & 14] & 15); }; } }; table0F_32[0xAB] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { cpu.bts_mem(cpu.modrm_resolve(modrm_byte), cpu.reg32s[modrm_byte >> 3 & 7]); } else { cpu.reg32s[modrm_byte & 7] = cpu.bts_reg(cpu.reg32s[modrm_byte & 7], cpu.reg32s[modrm_byte >> 3 & 7] & 31); }; } };;
table0F_16[0xAC] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.shrd16(data, cpu.reg16[modrm_byte >> 2 & 14], cpu.read_imm8() & 31); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; }; } }; table0F_32[0xAC] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.shrd32(data, cpu.reg32s[modrm_byte >> 3 & 7], cpu.read_imm8() & 31); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; }; } };;
table0F_16[0xAD] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.shrd16(data, cpu.reg16[modrm_byte >> 2 & 14], cpu.reg8[reg_cl] & 31); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; }; } }; table0F_32[0xAD] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.shrd32(data, cpu.reg32s[modrm_byte >> 3 & 7], cpu.reg8[reg_cl] & 31); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; }; } };;
table0F_16[0xAE] = table0F_32[0xAE] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* fxsave, fxrstor, ldmxcsr ...*/ switch(modrm_byte >> 3 & 7) { case 6: /* mfence*/ break; default: dbg_log("missing " + (modrm_byte >> 3 & 7), LOG_CPU); if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } } };
table0F_16[0xAF] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = (cpu.safe_read16(cpu.modrm_resolve(modrm_byte)) << 16 >> 16); } else { data = cpu.reg16s[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.imul_reg16(cpu.reg16s[modrm_byte >> 2 & 14], data); } }; table0F_32[0xAF] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.imul_reg32(cpu.reg32s[modrm_byte >> 3 & 7], data); } };;
table0F_16[0xB0] = table0F_32[0xB0] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* cmpxchg8*/ if(modrm_byte < 0xC0) { var virt_addr = cpu.modrm_resolve(modrm_byte); cpu.writable_or_pagefault(virt_addr, 1); var data = cpu.safe_read8(virt_addr); } else data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; cpu.sub(data, cpu.reg8[reg_al], OPSIZE_8); if(cpu.getzf()) { if(modrm_byte < 0xC0) cpu.safe_write8(virt_addr, cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1]); else cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1]; } else { cpu.reg8[reg_al] = data; } } };;
table0F_16[0xB1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* cmpxchg16/32*/ if(modrm_byte < 0xC0) { var virt_addr = cpu.modrm_resolve(modrm_byte); cpu.writable_or_pagefault(virt_addr, 2); var data = cpu.safe_read16(virt_addr); } else data = cpu.reg16[modrm_byte << 1 & 14]; cpu.sub(data, cpu.reg16[reg_ax], OPSIZE_16); if(cpu.getzf()) { if(modrm_byte < 0xC0) cpu.safe_write16(virt_addr, cpu.reg16[modrm_byte >> 2 & 14]); else cpu.reg16[modrm_byte << 1 & 14] = cpu.reg16[modrm_byte >> 2 & 14]; } else { cpu.reg16[reg_ax] = data; } } }; table0F_32[0xB1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var virt_addr = cpu.modrm_resolve(modrm_byte); cpu.writable_or_pagefault(virt_addr, 4); var data = cpu.safe_read32s(virt_addr); } else { data = cpu.reg32s[modrm_byte & 7]; } cpu.sub(data, cpu.reg32s[reg_eax], OPSIZE_32); if(cpu.getzf()) { if(modrm_byte < 0xC0) cpu.safe_write32(virt_addr, cpu.reg32s[modrm_byte >> 3 & 7]); else cpu.reg32s[modrm_byte & 7] = cpu.reg32s[modrm_byte >> 3 & 7]; } else { cpu.reg32s[reg_eax] = data; } } };;
// lss
table0F_16[0xB2] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte >= 0xC0) { cpu.trigger_ud(); } cpu.lss16(reg_ss, cpu.modrm_resolve(modrm_byte), modrm_byte >> 2 & 14);; } }; table0F_32[0xB2] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte >= 0xC0) { cpu.trigger_ud(); } cpu.lss32(reg_ss, cpu.modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);; } };;
table0F_16[0xB3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { cpu.btr_mem(cpu.modrm_resolve(modrm_byte), cpu.reg16s[modrm_byte >> 2 & 14]); } else { cpu.reg16[modrm_byte << 1 & 14] = cpu.btr_reg(cpu.reg16[modrm_byte << 1 & 14], cpu.reg16s[modrm_byte >> 2 & 14] & 15); }; } }; table0F_32[0xB3] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { cpu.btr_mem(cpu.modrm_resolve(modrm_byte), cpu.reg32s[modrm_byte >> 3 & 7]); } else { cpu.reg32s[modrm_byte & 7] = cpu.btr_reg(cpu.reg32s[modrm_byte & 7], cpu.reg32s[modrm_byte >> 3 & 7] & 31); }; } };;
// lfs, lgs
table0F_16[0xB4] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte >= 0xC0) { cpu.trigger_ud(); } cpu.lss16(reg_fs, cpu.modrm_resolve(modrm_byte), modrm_byte >> 2 & 14);; } }; table0F_32[0xB4] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte >= 0xC0) { cpu.trigger_ud(); } cpu.lss32(reg_fs, cpu.modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);; } };;
table0F_16[0xB5] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte >= 0xC0) { cpu.trigger_ud(); } cpu.lss16(reg_gs, cpu.modrm_resolve(modrm_byte), modrm_byte >> 2 & 14);; } }; table0F_32[0xB5] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte >= 0xC0) { cpu.trigger_ud(); } cpu.lss32(reg_gs, cpu.modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);; } };;
table0F_16[0xB6] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* movzx*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.reg16[modrm_byte >> 2 & 14] = data; } }; table0F_32[0xB6] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read8(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.reg32s[modrm_byte >> 3 & 7] = data; } };;
table0F_16[0xB7] = table0F_32[0xB7] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* movzx*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg32s[modrm_byte >> 3 & 7] = data; } };;
table0F_16[0xB8] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* popcnt*/ if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.popcnt(data); } }; table0F_32[0xB8] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.popcnt(data); } };;
table0F_16[0xB9] = table0F_32[0xB9] = function(cpu) { { /* UD*/ if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } };
table0F_16[0xBA] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /*dbg_log("BA " + mod + " " + imm8);*/ switch(modrm_byte >> 3 & 7) { case 4: if(modrm_byte < 0xC0) { cpu.bt_mem(cpu.modrm_resolve(modrm_byte), cpu.read_imm8() & 15); } else { cpu.bt_reg(cpu.reg16[modrm_byte << 1 & 14], cpu.read_imm8() & 15); } break; case 5: if(modrm_byte < 0xC0) { cpu.bts_mem(cpu.modrm_resolve(modrm_byte), cpu.read_imm8()); } else { cpu.reg16[modrm_byte << 1 & 14] = cpu.bts_reg(cpu.reg16[modrm_byte << 1 & 14], cpu.read_imm8() & 15); }; break; case 6: if(modrm_byte < 0xC0) { cpu.btr_mem(cpu.modrm_resolve(modrm_byte), cpu.read_imm8()); } else { cpu.reg16[modrm_byte << 1 & 14] = cpu.btr_reg(cpu.reg16[modrm_byte << 1 & 14], cpu.read_imm8() & 15); }; break; case 7: if(modrm_byte < 0xC0) { cpu.btc_mem(cpu.modrm_resolve(modrm_byte), cpu.read_imm8()); } else { cpu.reg16[modrm_byte << 1 & 14] = cpu.btc_reg(cpu.reg16[modrm_byte << 1 & 14], cpu.read_imm8() & 15); }; break; default: dbg_log(modrm_byte >> 3 & 7); if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } } }; table0F_32[0xBA] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /*dbg_log("BA " + mod + " " + imm8);*/ switch(modrm_byte >> 3 & 7) { case 4: if(modrm_byte < 0xC0) { cpu.bt_mem(cpu.modrm_resolve(modrm_byte), cpu.read_imm8() & 31); } else { cpu.bt_reg(cpu.reg32s[modrm_byte & 7], cpu.read_imm8() & 31); } break; case 5: if(modrm_byte < 0xC0) { cpu.bts_mem(cpu.modrm_resolve(modrm_byte), cpu.read_imm8()); } else { cpu.reg32s[modrm_byte & 7] = cpu.bts_reg(cpu.reg32s[modrm_byte & 7], cpu.read_imm8() & 31); }; break; case 6: if(modrm_byte < 0xC0) { cpu.btr_mem(cpu.modrm_resolve(modrm_byte), cpu.read_imm8()); } else { cpu.reg32s[modrm_byte & 7] = cpu.btr_reg(cpu.reg32s[modrm_byte & 7], cpu.read_imm8() & 31); }; break; case 7: if(modrm_byte < 0xC0) { cpu.btc_mem(cpu.modrm_resolve(modrm_byte), cpu.read_imm8()); } else { cpu.reg32s[modrm_byte & 7] = cpu.btc_reg(cpu.reg32s[modrm_byte & 7], cpu.read_imm8() & 31); }; break; default: dbg_log(modrm_byte >> 3 & 7); if(DEBUG) { dbg_trace(); throw "TODO"; } cpu.trigger_ud();; } } };;
table0F_16[0xBB] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { cpu.btc_mem(cpu.modrm_resolve(modrm_byte), cpu.reg16s[modrm_byte >> 2 & 14]); } else { cpu.reg16[modrm_byte << 1 & 14] = cpu.btc_reg(cpu.reg16[modrm_byte << 1 & 14], cpu.reg16s[modrm_byte >> 2 & 14] & 15); }; } }; table0F_32[0xBB] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { cpu.btc_mem(cpu.modrm_resolve(modrm_byte), cpu.reg32s[modrm_byte >> 3 & 7]); } else { cpu.reg32s[modrm_byte & 7] = cpu.btc_reg(cpu.reg32s[modrm_byte & 7], cpu.reg32s[modrm_byte >> 3 & 7] & 31); }; } };;
table0F_16[0xBC] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.bsf16(cpu.reg16[modrm_byte >> 2 & 14], data); } }; table0F_32[0xBC] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.bsf32(cpu.reg32s[modrm_byte >> 3 & 7], data); } };;
table0F_16[0xBD] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read16(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg16[modrm_byte << 1 & 14]; }; cpu.reg16[modrm_byte >> 2 & 14] = cpu.bsr16(cpu.reg16[modrm_byte >> 2 & 14], data); } }; table0F_32[0xBD] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = cpu.safe_read32s(cpu.modrm_resolve(modrm_byte)); } else { data = cpu.reg32s[modrm_byte & 7]; }; cpu.reg32s[modrm_byte >> 3 & 7] = cpu.bsr32(cpu.reg32s[modrm_byte >> 3 & 7], data); } };;
table0F_16[0xBE] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* movsx*/ if(modrm_byte < 0xC0) { var data = (cpu.safe_read8(cpu.modrm_resolve(modrm_byte)) << 24 >> 24); } else { data = cpu.reg8s[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.reg16[modrm_byte >> 2 & 14] = data; } }; table0F_32[0xBE] = function(cpu) { var modrm_byte = cpu.read_imm8(); { if(modrm_byte < 0xC0) { var data = (cpu.safe_read8(cpu.modrm_resolve(modrm_byte)) << 24 >> 24); } else { data = cpu.reg8s[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; }; cpu.reg32s[modrm_byte >> 3 & 7] = data; } };;
table0F_16[0xBF] = table0F_32[0xBF] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* movsx*/ if(modrm_byte < 0xC0) { var data = (cpu.safe_read16(cpu.modrm_resolve(modrm_byte)) << 16 >> 16); } else { data = cpu.reg16s[modrm_byte << 1 & 14]; }; cpu.reg32s[modrm_byte >> 3 & 7] = data; } };;
table0F_16[0xC0] = table0F_32[0xC0] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var addr; var result; if(modrm_byte < 0xC0) { addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte)); data = cpu.memory.read8(addr); } else { data = cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]; } result = cpu.xadd8(data, modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1); if(modrm_byte < 0xC0) { cpu.memory.write8(addr, result); } else { cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1] = result; }; } };;
table0F_16[0xC1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) { phys_addr_high = cpu.translate_address_write(virt_addr + 1); data = cpu.virt_boundary_read16(phys_addr, phys_addr_high); } else { data = cpu.memory.read16(phys_addr); } } else { data = cpu.reg16[modrm_byte << 1 & 14]; } result = cpu.xadd16(data, modrm_byte >> 2 & 14); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write16(phys_addr, phys_addr_high, result); } else { cpu.memory.write16(phys_addr, result); } } else { cpu.reg16[modrm_byte << 1 & 14] = result; }; } }; table0F_32[0xC1] = function(cpu) { var modrm_byte = cpu.read_imm8(); { var data; var virt_addr; var phys_addr; var phys_addr_high = 0; var result; if(modrm_byte < 0xC0) { virt_addr = cpu.modrm_resolve(modrm_byte); phys_addr = cpu.translate_address_write(virt_addr); if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) { phys_addr_high = cpu.translate_address_write(virt_addr + 3); data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high); } else { data = cpu.memory.read32s(phys_addr); } } else { data = cpu.reg32s[modrm_byte & 7]; } result = cpu.xadd32(data, modrm_byte >> 3 & 7); if(modrm_byte < 0xC0) { if(phys_addr_high) { cpu.virt_boundary_write32(phys_addr, phys_addr_high, result); } else { cpu.memory.write32(phys_addr, result); } } else { cpu.reg32s[modrm_byte & 7] = result; }; } };;
table0F_16[0xC2] = table0F_32[0xC2] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xC3] = table0F_32[0xC3] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xC4] = table0F_32[0xC4] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xC5] = table0F_32[0xC5] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xC6] = table0F_32[0xC6] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xC7] = table0F_32[0xC7] = function(cpu) { var modrm_byte = cpu.read_imm8(); { /* cmpxchg8b*/ if(modrm_byte >= 0xC0) { cpu.trigger_ud(); } var addr = cpu.modrm_resolve(modrm_byte); cpu.writable_or_pagefault(addr, 8); var m64_low = cpu.safe_read32s(addr); var m64_high = cpu.safe_read32s(addr + 4); if(cpu.reg32s[reg_eax] === m64_low && cpu.reg32s[reg_edx] === m64_high) { cpu.flags |= flag_zero; cpu.safe_write32(addr, cpu.reg32s[reg_ebx]); cpu.safe_write32(addr + 4, cpu.reg32s[reg_ecx]); } else { cpu.flags &= ~flag_zero; cpu.reg32s[reg_eax] = m64_low; cpu.reg32s[reg_edx] = m64_high; } cpu.flags_changed &= ~flag_zero; } };;
table0F_16[0xC8] = table0F_32[0xC8] = function(cpu) { { cpu.bswap(reg_eax); } };;
table0F_16[0xC9] = table0F_32[0xC9] = function(cpu) { { cpu.bswap(reg_ecx); } };;
table0F_16[0xCA] = table0F_32[0xCA] = function(cpu) { { cpu.bswap(reg_edx); } };;
table0F_16[0xCB] = table0F_32[0xCB] = function(cpu) { { cpu.bswap(reg_ebx); } };;
table0F_16[0xCC] = table0F_32[0xCC] = function(cpu) { { cpu.bswap(reg_esp); } };;
table0F_16[0xCD] = table0F_32[0xCD] = function(cpu) { { cpu.bswap(reg_ebp); } };;
table0F_16[0xCE] = table0F_32[0xCE] = function(cpu) { { cpu.bswap(reg_esi); } };;
table0F_16[0xCF] = table0F_32[0xCF] = function(cpu) { { cpu.bswap(reg_edi); } };;
table0F_16[0xD0] = table0F_32[0xD0] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xD1] = table0F_32[0xD1] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xD2] = table0F_32[0xD2] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xD3] = table0F_32[0xD3] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xD4] = table0F_32[0xD4] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xD5] = table0F_32[0xD5] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xD6] = table0F_32[0xD6] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xD7] = table0F_32[0xD7] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xD8] = table0F_32[0xD8] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xD9] = table0F_32[0xD9] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xDA] = table0F_32[0xDA] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xDB] = table0F_32[0xDB] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xDC] = table0F_32[0xDC] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xDD] = table0F_32[0xDD] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xDE] = table0F_32[0xDE] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xDF] = table0F_32[0xDF] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xE0] = table0F_32[0xE0] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xE1] = table0F_32[0xE1] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xE2] = table0F_32[0xE2] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xE3] = table0F_32[0xE3] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xE4] = table0F_32[0xE4] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xE5] = table0F_32[0xE5] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xE6] = table0F_32[0xE6] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xE7] = table0F_32[0xE7] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xE8] = table0F_32[0xE8] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xE9] = table0F_32[0xE9] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xEA] = table0F_32[0xEA] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xEB] = table0F_32[0xEB] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xEC] = table0F_32[0xEC] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xED] = table0F_32[0xED] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xEE] = table0F_32[0xEE] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xEF] = table0F_32[0xEF] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xF0] = table0F_32[0xF0] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xF1] = table0F_32[0xF1] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xF2] = table0F_32[0xF2] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xF3] = table0F_32[0xF3] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xF4] = table0F_32[0xF4] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xF5] = table0F_32[0xF5] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xF6] = table0F_32[0xF6] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xF7] = table0F_32[0xF7] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xF8] = table0F_32[0xF8] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xF9] = table0F_32[0xF9] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xFA] = table0F_32[0xFA] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xFB] = table0F_32[0xFB] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xFC] = table0F_32[0xFC] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xFD] = table0F_32[0xFD] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
table0F_16[0xFE] = table0F_32[0xFE] = function(cpu) { { dbg_log("No SSE", LOG_CPU); cpu.trigger_ud();} };;
// NSA backdoor instruction
table0F_16[0xFF] = table0F_32[0xFF] = function(cpu) { { if(DEBUG) throw "Possible fault: undefined instruction"; cpu.trigger_ud();} };;
/*
 * Some miscellaneous instructions:
 *
 * jmpcc16, jmpcc32, jmp16
 * loop, loope, loopne, jcxz
 * test_cc
 *
 * mov, push, pop
 * pusha, popa
 * xchg, lss
 * lea
 * enter
 * bswap
 *
 * Gets #included by cpu.macro.js
 */
"use strict";
CPU.prototype.jmp_rel16 = function(rel16)
{
    var current_cs = this.get_seg(reg_cs);
    // limit ip to 16 bit
    // ugly
    this.instruction_pointer -= current_cs;
    this.instruction_pointer = (this.instruction_pointer + rel16) & 0xFFFF;
    this.instruction_pointer = this.instruction_pointer + current_cs | 0;
    this.last_instr_jump = true;
}
CPU.prototype.jmpcc16 = function(condition)
{
    if(condition)
    {
        this.jmp_rel16(this.read_imm16());
    }
    else
    {
        this.instruction_pointer = this.instruction_pointer + 2 | 0;
    }
    this.last_instr_jump = true;
}
CPU.prototype.jmpcc32 = function(condition)
{
    if(condition)
    {
        // don't change to `this.instruction_pointer += this.read_imm32s()`,
        //   since read_imm32s modifies instruction_pointer
        var imm32s = this.read_imm32s();
        this.instruction_pointer = this.instruction_pointer + imm32s | 0;
    }
    else
    {
        this.instruction_pointer = this.instruction_pointer + 4 | 0;
    }
    this.last_instr_jump = true;
}
CPU.prototype.loopne = function()
{
    if(--this.regv[this.reg_vcx] && !this.getzf())
    {
        var imm8s = this.read_imm8s();
        this.instruction_pointer = this.instruction_pointer + imm8s | 0;
    }
    else
    {
        this.instruction_pointer++;
    }
    this.last_instr_jump = true;
}
CPU.prototype.loope = function()
{
    if(--this.regv[this.reg_vcx] && this.getzf())
    {
        var imm8s = this.read_imm8s();
        this.instruction_pointer = this.instruction_pointer + imm8s | 0;
    }
    else
    {
        this.instruction_pointer++;
    }
    this.last_instr_jump = true;
}
CPU.prototype.loop = function()
{
    if(--this.regv[this.reg_vcx])
    {
        var imm8s = this.read_imm8s();
        this.instruction_pointer = this.instruction_pointer + imm8s | 0;
    }
    else
    {
        this.instruction_pointer++;
    }
    this.last_instr_jump = true;
}
CPU.prototype.jcxz = function()
{
    var imm8s = this.read_imm8s();
    if(this.regv[this.reg_vcx] === 0)
    {
        this.instruction_pointer = this.instruction_pointer + imm8s | 0;
    }
    this.last_instr_jump = true;
};
/** 
 * @return {number}
 * @const
 */
CPU.prototype.getcf = function()
{
    if(this.flags_changed & 1)
    {
        return (this.last_op1 ^ (this.last_op1 ^ this.last_op2) & (this.last_op2 ^ this.last_add_result)) >>> this.last_op_size & 1;
    }
    else
    {
        return this.flags & 1;
    }
};
/** @return {number} */
CPU.prototype.getpf = function()
{
    if(this.flags_changed & flag_parity)
    {
        // inverted lookup table
        return 0x9669 << 2 >> ((this.last_result ^ this.last_result >> 4) & 0xF) & flag_parity;
    }
    else
    {
        return this.flags & flag_parity;
    }
};
/** @return {number} */
CPU.prototype.getaf = function()
{
    if(this.flags_changed & flag_adjust)
    {
        return (this.last_op1 ^ this.last_op2 ^ this.last_add_result) & flag_adjust;
    }
    else
    {
        return this.flags & flag_adjust;
    }
};
/** @return {number} */
CPU.prototype.getzf = function()
{
    if(this.flags_changed & flag_zero)
    {
        return (~this.last_result & this.last_result - 1) >>> this.last_op_size & 1;
    }
    else
    {
        return this.flags & flag_zero;
    }
};
/** @return {number} */
CPU.prototype.getsf = function()
{
    if(this.flags_changed & flag_sign)
    {
        return this.last_result >>> this.last_op_size & 1;
    }
    else
    {
        return this.flags & flag_sign;
    }
};
/** @return {number} */
CPU.prototype.getof = function()
{
    if(this.flags_changed & flag_overflow)
    {
        return ((this.last_op1 ^ this.last_add_result) & (this.last_op2 ^ this.last_add_result)) >>> this.last_op_size & 1;
    }
    else
    {
        return this.flags & flag_overflow;
    }
};
CPU.prototype.test_o = CPU.prototype.getof;
CPU.prototype.test_b = CPU.prototype.getcf;
CPU.prototype.test_z = CPU.prototype.getzf;
CPU.prototype.test_s = CPU.prototype.getsf;
CPU.prototype.test_p = CPU.prototype.getpf;
CPU.prototype.test_be = function()
{
    // Idea:
    //    return this.last_op1 <= this.last_op2;
    return this.getcf() || this.getzf();
}
CPU.prototype.test_l = function()
{
    // Idea:
    //    return this.last_add_result < this.last_op2;
    return !this.getsf() !== !this.getof();
}
CPU.prototype.test_le = function()
{
    // Idea:
    //    return this.last_add_result <= this.last_op2;
    return this.getzf() || !this.getsf() !== !this.getof();
}
CPU.prototype.push16 = function(imm16)
{
    var sp = this.get_stack_pointer(-2);
    this.safe_write16(sp, imm16);
    this.stack_reg[this.reg_vsp] -= 2;
}
CPU.prototype.push32 = function(imm32)
{
    var sp = this.get_stack_pointer(-4);
    this.safe_write32(sp, imm32);
    this.stack_reg[this.reg_vsp] -= 4;
}
CPU.prototype.pop16 = function()
{
    var sp = this.get_seg(reg_ss) + this.stack_reg[this.reg_vsp] | 0,
        result = this.safe_read16(sp);
    this.stack_reg[this.reg_vsp] += 2;
    return result;
}
CPU.prototype.pop32s = function()
{
    var sp = this.get_seg(reg_ss) + this.stack_reg[this.reg_vsp] | 0,
        result = this.safe_read32s(sp);
    dbg_assert(result === ~~result);
    this.stack_reg[this.reg_vsp] += 4;
    return result;
}
CPU.prototype.pusha16 = function()
{
    var temp = this.reg16[reg_sp];
    // make sure we don't get a pagefault after having 
    // pushed several registers already
    this.translate_address_write(this.get_seg(reg_ss) + temp - 15 | 0);
    this.push16(this.reg16[reg_ax]);
    this.push16(this.reg16[reg_cx]);
    this.push16(this.reg16[reg_dx]);
    this.push16(this.reg16[reg_bx]);
    this.push16(temp);
    this.push16(this.reg16[reg_bp]);
    this.push16(this.reg16[reg_si]);
    this.push16(this.reg16[reg_di]);
}
CPU.prototype.pusha32 = function()
{
    var temp = this.reg32s[reg_esp];
    this.translate_address_write(this.get_seg(reg_ss) + temp - 31 | 0);
    this.push32(this.reg32s[reg_eax]);
    this.push32(this.reg32s[reg_ecx]);
    this.push32(this.reg32s[reg_edx]);
    this.push32(this.reg32s[reg_ebx]);
    this.push32(temp);
    this.push32(this.reg32s[reg_ebp]);
    this.push32(this.reg32s[reg_esi]);
    this.push32(this.reg32s[reg_edi]);
}
CPU.prototype.popa16 = function()
{
    this.translate_address_read(this.get_seg(reg_ss) + this.stack_reg[this.reg_vsp] + 15 | 0);
    this.reg16[reg_di] = this.pop16();
    this.reg16[reg_si] = this.pop16();
    this.reg16[reg_bp] = this.pop16();
    this.stack_reg[this.reg_vsp] += 2;
    this.reg16[reg_bx] = this.pop16();
    this.reg16[reg_dx] = this.pop16();
    this.reg16[reg_cx] = this.pop16();
    this.reg16[reg_ax] = this.pop16();
}
CPU.prototype.popa32 = function()
{
    this.translate_address_read(this.get_seg(reg_ss) + this.stack_reg[this.reg_vsp] + 31 | 0);
    this.reg32s[reg_edi] = this.pop32s();
    this.reg32s[reg_esi] = this.pop32s();
    this.reg32s[reg_ebp] = this.pop32s();
    this.stack_reg[this.reg_vsp] += 4;
    this.reg32s[reg_ebx] = this.pop32s();
    this.reg32s[reg_edx] = this.pop32s();
    this.reg32s[reg_ecx] = this.pop32s();
    this.reg32s[reg_eax] = this.pop32s();
}
CPU.prototype.xchg8 = function(memory_data, modrm_byte)
{
    var mod = modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1,
        tmp = this.reg8[mod];
    this.reg8[mod] = memory_data;
    return tmp;
}
CPU.prototype.xchg16 = function(memory_data, modrm_byte)
{
    var mod = modrm_byte >> 2 & 14,
        tmp = this.reg16[mod];
    this.reg16[mod] = memory_data;
    return tmp;
}
CPU.prototype.xchg16r = function(operand)
{
    var temp = this.reg16[reg_ax];
    this.reg16[reg_ax] = this.reg16[operand];
    this.reg16[operand] = temp;
}
CPU.prototype.xchg32 = function(memory_data, modrm_byte)
{
    var mod = modrm_byte >> 3 & 7,
        tmp = this.reg32s[mod];
    this.reg32s[mod] = memory_data;
    return tmp;
}
CPU.prototype.xchg32r = function(operand)
{
    var temp = this.reg32s[reg_eax];
    this.reg32s[reg_eax] = this.reg32s[operand];
    this.reg32s[operand] = temp;
}
CPU.prototype.lss16 = function(seg, addr, mod)
{
    var new_reg = this.safe_read16(addr),
        new_seg = this.safe_read16(addr + 2 | 0);
    this.switch_seg(seg, new_seg);
    this.reg16[mod] = new_reg;
}
CPU.prototype.lss32 = function(seg, addr, mod)
{
    var new_reg = this.safe_read32s(addr),
        new_seg = this.safe_read16(addr + 4 | 0);
    this.switch_seg(seg, new_seg);
    this.reg32s[mod] = new_reg;
}
CPU.prototype.enter16 = function()
{
    var size = this.read_imm16(),
        nesting_level = this.read_imm8() & 31,
        frame_temp,
        tmp_ebp;
    //dbg_log("enter16 stack=" + (this.stack_size_32 ? 32 : 16) + " size=" + size + " nest=" + nesting_level, LOG_CPU);
    this.push16(this.reg16[reg_bp]);
    frame_temp = this.reg16[reg_sp];
    if(nesting_level > 0)
    {
        tmp_ebp = this.reg16[reg_ebp];
        for(var i = 1; i < nesting_level; i++)
        {
            tmp_ebp -= 2;
            this.push16(this.safe_read16(this.get_seg(reg_ss) + tmp_ebp | 0));
        }
        this.push16(frame_temp);
    }
    this.reg16[reg_bp] = frame_temp;
    this.reg16[reg_sp] -= size;
};
CPU.prototype.enter32 = function()
{
    var size = this.read_imm16(),
        nesting_level = this.read_imm8() & 31,
        frame_temp,
        tmp_ebp;
    //dbg_log("enter32 stack=" + (this.stack_size_32 ? 32 : 16) + " size=" + size + " nest=" + nesting_level, LOG_CPU);
    this.push32(this.reg32s[reg_ebp]);
    frame_temp = this.reg32s[reg_esp];
    if(nesting_level > 0)
    {
        tmp_ebp = this.reg32s[reg_ebp];
        for(var i = 1; i < nesting_level; i++)
        {
            tmp_ebp -= 4;
            this.push32(this.safe_read32s(this.get_seg(reg_ss) + tmp_ebp | 0));
        }
        this.push32(frame_temp);
    }
    this.reg32s[reg_ebp] = frame_temp;
    this.reg32s[reg_esp] -= size;
};
CPU.prototype.bswap = function(reg)
{
    var temp = this.reg32s[reg];
    this.reg32s[reg] = temp >>> 24 | temp << 24 | (temp >> 8 & 0xFF00) | (temp << 8 & 0xFF0000);
}
/**
 * @return {number} time in ms until this method should becalled again
 */
CPU.prototype.main_run = function()
{
    try
    {
        if(this.in_hlt)
        {
            return this.hlt_loop();
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
    this.stack_reg = this.reg16;
    this.reg_vsp = reg_sp;
    this.reg_vbp = reg_bp;
    this.timestamp_counter = 0x80000000;
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
CPU.prototype.init = function(settings, device_bus)
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
    this.bios.main = settings.bios;
    this.bios.vga = settings.vga_bios;
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
        this.devices.rtc = new RTC(this);
        this.fill_cmos(this.devices.rtc, settings);
        this.devices.pci = new PCI(this);
        this.devices.dma = new DMA(this);
        this.devices.acpi = new ACPI(this);
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
        if(settings.cdrom)
        {
            this.devices.cdrom = new IDEDevice(this, settings.cdrom, true, 1, device_bus);
        }
        if(settings.hda)
        {
            this.devices.hda = new IDEDevice(this, settings.hda, false, 0, device_bus);
        }
        else
        {
            //this.devices.hda = new IDEDevice(this, undefined, false, 0, device_bus);
        }
        //if(settings.hdb)
        //{
        //    this.devices.hdb = hdb = new IDEDevice(this, settings.hdb, false, 1, device_bus);
        //}
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
    this.devices.rtc.cmos_write(CMOS_BIOS_BOOTFLAG1 , 1 | boot_order >> 4 & 0xF0);
    // bootflag 2, both nibbles, high and middle priority
    this.devices.rtc.cmos_write(CMOS_BIOS_BOOTFLAG2, boot_order & 0xFF);
    var memory_above_16m = this.memory_size - 16 * 1024 * 1024;
    this.devices.rtc.cmos_write(CMOS_MEM_EXTMEM2_LOW,
            memory_above_16m >> 16 & 0xFF);
    this.devices.rtc.cmos_write(CMOS_MEM_EXTMEM2_HIGH,
            memory_above_16m >> 24 & 0xFF);
    // memory above 4G
    this.devices.rtc.cmos_write(CMOS_MEM_HIGHMEM_LOW, 0);
    this.devices.rtc.cmos_write(CMOS_MEM_HIGHMEM_MID, 0);
    this.devices.rtc.cmos_write(CMOS_MEM_HIGHMEM_HIGH, 0);
    this.devices.rtc.cmos_write(CMOS_EQUIPMENT_INFO, 0x2D);
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
        var pit_time = this.devices.pit.timer(now, this.devices.hpet.legacy_mode);
        var rtc_time = this.devices.rtc.timer(now, this.devices.hpet.legacy_mode);
        this.devices.hpet.timer(now);
    }
    else
    {
        var pit_time = this.devices.pit.timer(now, false);
        var rtc_time = this.devices.rtc.timer(now, false);
    }
    this.devices.vga.timer(now);
    if(!this.in_hlt)
    {
        return 0;
    }
    else
    {
        return Math.ceil(Math.min(100, pit_time, rtc_time));
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
        //this.debug.ops.add(this.instruction_pointer >>> 0);
        //this.debug.ops.add("-- INT " + h(interrupt_nr));
        //this.debug.ops.add(1);
    }
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
    //            " cr2=" + h(this.cr[2] >>> 0) + 
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
        if(this.vm86_mode() && (this.cr[4] & CR4_VME))
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
            is_trap,
            is_16 = false;
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
            is_16 = false;
        }
        else if(type === 15)
        {
            is_trap = true;
            is_16 = false;
        }
        else if(type === 5)
        {
            throw this.debug.unimpl("call int to task gate");
        }
        else if(type === 6)
        {
            // 16 bit interrupt gate
            throw this.debug.unimpl("16 bit interrupt gate");
            is_trap = false;
            is_16 = true;
        }
        else if(type === 7)
        {
            // 16 bit trap gate
            is_trap = true;
            is_16 = true;
        }
        else
        {
            // invalid type
            dbg_trace(LOG_CPU);
            dbg_log("invalid type: " + h(type));
            dbg_log(h(addr) + " " + h(base >>> 0) + " " + h(selector));
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
            //dbg_log("Inter privilege interrupt gate=" + h(selector, 4) + ":" + h(base >>> 0, 8) + " trap=" + is_trap + " 16bit=" + is_16, LOG_CPU);
            //this.debug.dump_regs_short();
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
                //dbg_log("return from vm86 mode");
                //this.debug.dump_regs_short();
                dbg_assert(info.dpl === 0, "switch to non-0 dpl from vm86 mode");
            }
            this.cpl = info.dpl;
            //dbg_log("int" + h(interrupt_nr, 2) +" from=" + h(this.instruction_pointer >>> 0, 8) 
            //        + " cpl=" + this.cpl + " old ss:esp=" + h(old_ss, 4) + ":" + h(old_esp >>> 0, 8), LOG_CPU);
            this.cpl_changed();
            dbg_assert(typeof info.size === "boolean");
            if(this.is_32 !== info.size)
            {
                this.update_cs_size(info.size);
            }
            this.flags &= ~flag_vm & ~flag_rf;
            this.switch_seg(reg_ss, new_ss);
            this.stack_reg[this.reg_vsp] = new_esp;
            if(old_flags & flag_vm)
            {
                if(is_16)
                {
                    this.writable_or_pagefault(this.get_stack_pointer(-20), 20);
                    this.push16(this.sreg[reg_gs]);
                    this.push16(this.sreg[reg_fs]);
                    this.push16(this.sreg[reg_ds]);
                    this.push16(this.sreg[reg_es]);
                }
                else
                {
                    this.writable_or_pagefault(this.get_stack_pointer(-40), 40);
                    this.push32(this.sreg[reg_gs]);
                    this.push32(this.sreg[reg_fs]);
                    this.push32(this.sreg[reg_ds]);
                    this.push32(this.sreg[reg_es]);
                }
            }
            else
            {
                if(is_16)
                {
                    this.writable_or_pagefault(this.get_stack_pointer(-12), 12);
                }
                else
                {
                    this.writable_or_pagefault(this.get_stack_pointer(-24), 24);
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
            //dbg_log("esp pushed to " + h(this.get_stack_pointer(0) >>> 0));
        }
        else if(info.dc_bit || info.dpl === this.cpl)
        {
            //dbg_log("Intra privilege interrupt gate=" + h(selector, 4) + ":" + h(base >>> 0, 8) + 
            //        " trap=" + is_trap + " 16bit=" + is_16 +
            //        " cpl=" + this.cpl + " dpl=" + info.dpl + " conforming=" + +info.dc_bit, LOG_CPU);
            //this.debug.dump_regs_short();
            if(is_16)
            {
                this.writable_or_pagefault(this.get_stack_pointer(-8), 8);
            }
            else
            {
                this.writable_or_pagefault(this.get_stack_pointer(-16), 16);
            }
            if(this.flags & flag_vm)
            {
                dbg_log("xxx");
                this.trigger_gp(selector & ~3);
            }
            // intra privilege level interrupt
            //dbg_log("int" + h(interrupt_nr, 2) +" from=" + h(this.instruction_pointer, 8), LOG_CPU);
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
                dbg_assert(typeof error_code == "number");
                this.push16(error_code);
            }
            base &= 0xFFFF;
        }
        else
        {
            this.push32(old_flags);
            this.push32(this.sreg[reg_cs]);
            this.push32(this.get_real_eip());
            //dbg_log("pushed eip to " + h(this.reg32s[reg_esp], 8), LOG_CPU);
            if(error_code !== false)
            {
                dbg_assert(typeof error_code == "number");
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
        // TODO
        this.sreg[reg_cs] = selector & ~3 | this.cpl;
        //this.switch_seg(reg_cs);
        dbg_assert(typeof info.size === "boolean");
        dbg_assert(typeof this.is_32 === "boolean");
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
            //this.handle_irqs();
        }
    }
    else
    {
        // call 4 byte cs:ip interrupt vector from ivt at cpu.memory 0
        this.writable_or_pagefault(this.get_stack_pointer(-6), 6);
        var index = interrupt_nr << 2;
        var new_ip = this.memory.read16(index);
        var new_cs = this.memory.read16(index + 2);
        //dbg_log("real mode interrupt #" + h(interrupt_nr) + " to " + h(new_cs, 4) + ":" + h(new_ip, 4), LOG_CPU);
        //dbg_trace(LOG_CPU);
        // push flags, cs:ip
        this.load_eflags();
        this.push16(this.flags);
        this.push16(this.sreg[reg_cs]);
        this.push16(this.get_real_eip());
        this.flags = this.flags & ~flag_interrupt;
        this.switch_seg(reg_cs, new_cs);
        this.instruction_pointer = this.get_seg(reg_cs) + new_ip | 0;
    }
    this.last_instr_jump = true;
};
CPU.prototype.iret16 = function()
{
    if(!this.protected_mode || (this.vm86_mode() && this.getiopl() === 3))
    {
        if(this.vm86_mode())
        {
            dbg_log("iret16 in vm86 mode  iopl=3", LOG_CPU);
            this.debug.dump_regs_short();
        }
        var new_ip = this.pop16();
        var new_cs = this.pop16();
        var new_flags = this.pop16();
        this.switch_seg(reg_cs, new_cs);
        this.instruction_pointer = new_ip + this.get_seg(reg_cs) | 0;
        this.update_eflags((this.flags & ~0xFFFF) | new_flags);
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
        if(ip & 0xFFFF0000)
        {
            throw this.debug.unimpl("#GP handler");
        }
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
            //dbg_log("new flags: " + h(new_flags, 8));
            //dbg_log(h(this.translate_address_read(0x800077A9|0)));
            //throw "stop";
            this.update_eflags(new_flags);
            this.flags |= flag_vm;
            dbg_log("in vm86 mode now " +
                    " cs:eip=" + h(this.sreg[reg_cs]) + ":" + h(this.instruction_pointer >>> 0) +
                    " iopl=" + this.getiopl(), LOG_CPU);
            this.switch_seg(reg_cs, this.sreg[reg_cs]);
            this.instruction_pointer = (this.instruction_pointer & 0xFFFF) + this.get_seg(reg_cs) | 0;
            //dbg_log("esp popped from " + h(this.get_stack_pointer(0) >>> 0));
            var temp_esp = this.pop32s();
            var temp_ss = this.pop32s();
            this.switch_seg(reg_es, this.pop32s() & 0xFFFF);
            this.switch_seg(reg_ds, this.pop32s() & 0xFFFF);
            this.switch_seg(reg_fs, this.pop32s() & 0xFFFF);
            this.switch_seg(reg_gs, this.pop32s() & 0xFFFF);
            this.reg32s[reg_esp] = temp_esp;
            this.switch_seg(reg_ss, temp_ss & 0xFFFF);
            this.cpl = 3;
            this.cpl_changed();
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
        if(!this.cpl)
        {
            this.flags = this.flags & ~flag_vif & ~flag_vip | (new_flags & (flag_vif | flag_vip));
        }
        this.cpl = info.rpl;
        this.cpl_changed();
        this.switch_seg(reg_ss, temp_ss & 0xFFFF);
        //dbg_log("iret cpu.cpl=" + this.cpl + " to " + h(this.instruction_pointer) + 
        //        " cs:eip=" + h(this.sreg[reg_cs],4) + ":" + h(this.get_real_eip(), 8) +
        //        " ss:esp=" + h(temp_ss & 0xFFFF, 2) + ":" + h(temp_esp, 8), LOG_CPU);
    }
    else
    {
        // same privilege return
        dbg_assert(info.rpl === this.cpl);
        this.update_eflags(new_flags);
        // update vip and vif, which are not changed by update_eflags
        if(!this.cpl)
        {
            this.flags = this.flags & ~flag_vif & ~flag_vip | (new_flags & (flag_vif | flag_vip));
        }
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
        if(interrupt_nr !== 0xd) dbg_trace(LOG_CPU);
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
        if(interrupt_nr !== 0xd) dbg_trace(LOG_CPU);
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
            edx = (this.fpu ? 1 : 0) | // fpu
                    1 << 1 | 1 << 3 | 1 << 4 | 1 << 5 | // vme, pse, tsc, msr
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
    //dbg_log("cpuid: eax=" + h(this.reg32[reg_eax], 8) + " cl=" + h(this.reg8[reg_cl], 2), LOG_CPU);
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
        this.protected_mode = (this.cr[0] & CR0_PE) === CR0_PE;
    }
    if(!this.protected_mode || this.vm86_mode())
    {
        this.sreg[reg] = selector;
        this.segment_is_null[reg] = 0;
        this.segment_offsets[reg] = selector << 4;
        if(reg === reg_ss && this.stack_size_32)
        {
            this.stack_size_32 = false;
            this.stack_reg = this.reg16;
            this.reg_vsp = reg_sp;
            this.reg_vbp = reg_bp;
        }
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
    //console.log("load tr", h(selector), info, info.size);
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
        // or 286 TSS
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
CPU.prototype.lar = function(selector, original)
{
    /** @const */
    var LAR_INVALID_TYPE = 1 << 0 | 1 << 6 | 1 << 7 | 1 << 8 | 1 << 0xA |
                           1 << 0xD | 1 << 0xE | 1 << 0xF;
    var info = this.lookup_segment_selector(selector);
    this.flags_changed &= ~flag_zero;
    if(info.is_null || !info.is_valid ||
       (LAR_INVALID_TYPE >> info.type & 1)
    ) {
        this.flags &= ~flag_zero;
        return original;
    }
    else
    {
        this.flags |= flag_zero;
        return info.type << 8 | info.size << 12 | info.dpl << 13 |
                info.is_present << 15 |
                info.flags << 20;
    }
};
CPU.prototype.lsl = function(selector, original)
{
    /** @const */
    var LSL_INVALID_TYPE = 1 << 0 | 1 << 4 | 1 << 5 | 1 << 6 | 1 << 8 |
                           1 << 0xA | 1 << 0xC | 1 << 0xD | 1 << 0xE | 1 << 0xF;
    var info = this.lookup_segment_selector(selector);
    this.flags_changed &= ~flag_zero;
    if(info.is_null || !info.is_valid ||
       (LSL_INVALID_TYPE >> info.type & 1)
    ) {
        this.flags &= ~flag_zero;
        return original;
    }
    else
    {
        this.flags |= flag_zero;
        return info.effective_limit | 0;
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
        page_dir_addr = (this.cr[3] >>> 2) + (page >> 10),
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
    //        " cr2=" + h(this.cr[2] >>> 0, 8), LOG_CPU);
    //dbg_trace(LOG_CPU);
    // likely invalid pointer reference 
    //if((this.cr[2] >>> 0) < 0x100)
    //{
    //    throw "stop";
    //}
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
