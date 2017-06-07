"use strict";

CPU.prototype.debug_init = function()
{
    var cpu = this;
    var debug = {};
    this.debug = debug;

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

    debug.get_regs_short = get_regs_short;
    debug.dump_regs = dump_regs_short;
    debug.dump_instructions = dump_instructions;
    debug.get_instructions = get_instructions;
    debug.get_state = get_state;
    debug.dump_state = dump_state;
    debug.dump_stack = dump_stack;

    debug.dump_page_directory = dump_page_directory;
    debug.dump_gdt_ldt = dump_gdt_ldt;
    debug.dump_idt = dump_idt;

    debug.get_memory_dump = get_memory_dump;
    debug.memory_hex_dump = memory_hex_dump;
    debug.used_memory_dump = used_memory_dump;

    debug.step = step;
    debug.run_until = run_until;

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
    };

    function step()
    {
        if(!DEBUG) return;

        if(!cpu.running)
        {
            cpu.cycle();
        }

        dump_regs_short();
        var now = Date.now();

        cpu.running = false;
        dump_instructions();
    }

    function run_until()
    {
        if(!DEBUG) return;

        cpu.running = false;
        var a = parseInt(prompt("input hex", ""), 16);
        if(a) while(cpu.instruction_pointer != a) step();
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
    };

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

            dbg_log(line + h(esp + 4 * i, 8) + " | " + h(cpu.read32s(esp + 4 * i) >>> 0));
        }
    }

    function get_state(where)
    {
        var vm = (cpu.flags & flag_vm) ? 1 : 0;
        var mode = cpu.protected_mode ? vm ? "vm86" : "prot" : "real";
        var flags = cpu.get_eflags();
        var iopl = cpu.getiopl();
        var cpl = cpu.cpl;
        var cs_eip = h(cpu.sreg[reg_cs], 4) + ":" + h(cpu.get_real_eip() >>> 0, 8);
        var ss_esp = h(cpu.sreg[reg_ss], 4) + ":" + h(cpu.get_stack_reg() >>> 0, 8);
        var op_size = cpu.is_32 ? "32" : "16";
        var if_ = (cpu.flags & flag_interrupt) ? 1 : 0;

        var flag_names = {
            [flag_carry]: "c",
            [flag_parity]: "p",
            [flag_adjust]: "a",
            [flag_zero]: "z",
            [flag_sign]: "s",
            [flag_trap]: "t",
            [flag_interrupt]: "i",
            [flag_direction]: "d",
            [flag_overflow]: "o",
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

        return ("mode=" + mode + "/" + op_size + " paging=" + (+cpu.paging) +
                " iopl=" + iopl + " cpl=" + cpl + " if=" + if_ + " cs:eip=" + cs_eip +
                " cs_off=" + h(cpu.get_seg(reg_cs) >>> 0, 8) +
                " flgs=" + h(cpu.get_eflags() >>> 0, 6) + " (" + flag_string + ")" +
                " ss:esp=" + ss_esp +
                " ssize=" + (+cpu.stack_size_32) +
                (where ? " in " + where : ""));
    }

    function dump_state(where)
    {
        if(!DEBUG) return;

        dbg_log(get_state(where), LOG_CPU);
    }

    function get_regs_short()
    {
        var
            r32 = { "eax": reg_eax, "ecx": reg_ecx, "edx": reg_edx, "ebx": reg_ebx,
                    "esp": reg_esp, "ebp": reg_ebp, "esi": reg_esi, "edi": reg_edi },
            r32_names = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"],
            s = { "cs": reg_cs, "ds": reg_ds, "es": reg_es, "fs": reg_fs, "gs": reg_gs, "ss": reg_ss },
            line1 = "",
            line2 = "";



        for(var i = 0; i < 4; i++)
        {
            line1 += r32_names[i] + "="  + h(cpu.reg32[r32[r32_names[i]]], 8) + " ";
            line2 += r32_names[i+4] + "="  + h(cpu.reg32[r32[r32_names[i+4]]], 8) + " ";
        }

        //line1 += " eip=" + h(cpu.get_real_eip() >>> 0, 8);
        //line2 += " flg=" + h(cpu.get_eflags(), 8);

        line1 += "  ds=" + h(cpu.sreg[reg_ds], 4) + " es=" + h(cpu.sreg[reg_es], 4) + " fs=" + h(cpu.sreg[reg_fs], 4);
        line2 += "  gs=" + h(cpu.sreg[reg_gs], 4) + " cs=" + h(cpu.sreg[reg_cs], 4) + " ss=" + h(cpu.sreg[reg_ss], 4);

        return [line1, line2];
    }

    function dump_regs_short()
    {
        if(!DEBUG) return;

        var lines = get_regs_short();

        dbg_log(lines[0], LOG_CPU);
        dbg_log(lines[1], LOG_CPU);
    }

    function get_instructions()
    {
        if(!DEBUG) return;

        debug.step_mode = true;

        function add(ip, op)
        {
            out += h(ip, 8)  + ":        " +
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
        dump_table(cpu.translate_address_system_read(cpu.gdtr_offset), cpu.gdtr_size);

        dbg_log("\nldt: (len = " + h(cpu.segment_limits[reg_ldtr]) + ")");
        dump_table(cpu.translate_address_system_read(cpu.segment_offsets[reg_ldtr]), cpu.segment_limits[reg_ldtr]);

        function dump_table(addr, size)
        {
            for(var i = 0; i < size; i += 8, addr += 8)
            {
                var base = cpu.read16(addr + 2) |
                        cpu.read8(addr + 4) << 16 |
                        cpu.read8(addr + 7) << 24,

                    limit = cpu.read16(addr) | (cpu.read8(addr + 6) & 0xF) << 16,
                    access = cpu.read8(addr + 5),
                    flags = cpu.read8(addr + 6) >> 4,
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
    }

    function dump_idt()
    {
        if(!DEBUG) return;

        for(var i = 0; i < cpu.idtr_size; i += 8)
        {
            var addr = cpu.translate_address_system_read(cpu.idtr_offset + i),
                base = cpu.read16(addr) | cpu.read16(addr + 6) << 16,
                selector = cpu.read16(addr + 2),
                type = cpu.read8(addr + 5),
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
            var addr = cpu.cr[3] + 4 * i;
            var dword = cpu.read32s(addr),
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
                var sub_addr = entry.address + 4 * j;
                dword = cpu.read32s(sub_addr);

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
                            h(subentry.address, 8) + " | " + flags + "        (at " + h(sub_addr, 8) + ")");
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

        return cpu.mem8.slice(start, start + count).buffer;
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
                byt = cpu.read8(addr + (i << 4) + j);
                line += h(byt, 2) + " ";
            }

            line += "  ";

            for(j = 0; j < 0x10; j++)
            {
                byt = cpu.read8(addr + (i << 4) + j);
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
            row = h(i * width * block_size, 8) + " | ";

            for(var j = 0; j < width; j++)
            {
                var used = cpu.mem32s[(i * width + j) * block_size] > 0;

                row += used ? "X" : " ";
            }

            dbg_log(row);
        }
    }


    debug.debug_interrupt = function(interrupt_nr)
    {
        //if(interrupt_nr === 0x20)
        //{
        //    //var vxd_device = cpu.safe_read16(cpu.instruction_pointer + 2);
        //    //var vxd_sub = cpu.safe_read16(cpu.instruction_pointer + 0);
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
};
