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
    debug.ops = {};

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

        console.log(el);
    };

    debug.init = function()
    {
        if(!DEBUG) return;

        // used for debugging 
        debug.ops = new CircularQueue(30000);

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
        if(!DEBUG || !debug.ops)
        {
            return;
        }
        if(!debug.step_mode)
        {
            return;
        }
        

        debug.ops.add(_ip);
        debug.ops.add(opcode_map[op] || "unkown");
        debug.ops.add(op);
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
            line1 += r32_names[i] + "="  + h(cpu.reg32[r32[r32_names[i]]], 8) + " ";
            line2 += r32_names[i+4] + "="  + h(cpu.reg32[r32[r32_names[i+4]]], 8) + " ";
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
        
        var flg = { "cf": cpu.getcf, "pf": cpu.getpf, "zf": cpu.getzf,  "sf": cpu.getsf, 
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

    function dump_instructions()
    {
        if(!DEBUG) return;

        var opcodes = debug.ops.toArray(),
            out = "";

        for(var i = 0; i < opcodes.length; i += 3)
        {
            if(opcodes[i])
            {
                out += h(opcodes[i], 8)  + ":        " + 
                    String.pads(opcodes[i + 1], 20) + h(opcodes[i + 2], 2) + "\n";
            }
        }

        debug.show(out.substr(0, out.length - 1));

        debug.ops.clear();
        debug.step_mode = true;
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
            var dword = cpu.memory.read32s(cpu.cr3 + 4 * i),
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

        // textarea method: (slow)
        //var result_string = "";
        //for(var i = start; i < start + end; i++)
        //{
        //    result_string += String.fromCharCode(int8array[i]);
        //}
        //dump_text(btoa(result_string));

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
