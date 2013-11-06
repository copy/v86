"use strict";

debug.dump_regs = dump_regs;
debug.dump_regs_short = dump_regs_short;
debug.dump_stack = dump_stack;

debug.dump_page_directory = dump_page_directory;
debug.dump_gdt_ldt = dump_gdt_ldt;
debug.dump_idt = dump_idt;

debug.step = step;
debug.run_until = run_until;

debug.debugger = function()
{
    debugger;
}

function step()
{
    step_mode = true;

    if(!running)
    {
        cycle(); 
    }

    dump_regs(); 
    var now = Date.now();

    vga.timer(now);
    timer.timer(now);
    rtc.timer(now);

    running = false;
}

function run_until()
{
    running = false;
    var a = parseInt(prompt("input hex", ""), 16); 
    if(a) while(instruction_pointer != a) cycle()
    dump_regs();
}

// http://ref.x86asm.net/x86reference.xml
// for debuggin' purposes
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

function logop(_ip, op)
{
    if(!DEBUG || !ops)
    {
        return;
    }
    if(!step_mode)
    {
        //return;
    }
    

    ops.add(_ip);
    ops.add(opcode_map[op] || "unkown");
    ops.add(op);
}

function dump_stack(start, end)
{
    var esp = reg32[reg_esp];
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

        dbg_log(line + h(esp + 4 * i, 8) + " | " + h(memory.read32s(esp + 4 * i) >>> 0));
    }
}

function dump_regs_short()
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
        line1 += r32_names[i] + "="  + h(reg32[r32[r32_names[i]]], 8) + " ";
        line2 += r32_names[i+4] + "="  + h(reg32[r32[r32_names[i+4]]], 8) + " ";
    }

    line1 += " eip=" + h(get_real_ip(), 8);
    line2 += " flg=" + h(get_flags());

    line1 += "  ds=" + h(sreg[reg_ds], 4) + " es=" + h(sreg[reg_es], 4) + "  fs=" + h(sreg[reg_fs], 4);
    line2 += "  gs=" + h(sreg[reg_gs], 4) + " cs=" + h(sreg[reg_cs], 4) + "  ss=" + h(sreg[reg_ss], 4);

    dbg_log(line1);
    dbg_log(line2);
}

function dump_regs()
{
    var
        r32 = { "eax": reg_eax, "ecx": reg_ecx, "edx": reg_edx, "ebx": reg_ebx, 
                "esp": reg_esp, "ebp": reg_ebp, "esi": reg_esi, "edi": reg_edi },

        s = { "cs": reg_cs, "ds": reg_ds, "es": reg_es, 
              "fs": reg_fs, "gs": reg_gs, "ss": reg_ss },

        out = "";

    
    var opcodes = ops.toArray();
    for(var i = 0; i < opcodes.length; i += 3)
    {
        if(opcodes[i])
        {
            out += h(opcodes[i], 6)  + ":        " + 
                String.pads(opcodes[i + 1], 20) + h(opcodes[i + 2], 2) + "\n";
        }
    }

    log(out.substr(0, out.length - 1));
    ops.clear();
    
    dbg_log("----- DUMP (ip = 0x" + h(instruction_pointer >>> 0) + ") ----------")
    dbg_log("protected mode: " + protected_mode);
    
    for(i in r32)
    {
        dbg_log(i + " =  0x" + h(reg32[r32[i]], 8));
    }
    dbg_log("eip =  0x" + h(get_real_ip(), 8));
    
    for(i in s)
    {
        dbg_log(i + "  =  0x" + h(sreg[s[i]], 4));
    }
    
    out = "";
    
    var flg = { "cf": getcf, "pf": getpf, "zf": getzf,  "sf": getsf, 
                "of": getof, "df": flag_direction, "if": flag_interrupt };
    
    for(var i in flg)
    {
        if(+flg[i])
        {
            out += i + "=" + Number(!!(flags & flg[i])) + " | ";
        }
        else
        {
            out += i + "=" + Number(!!flg[i]()) + " | ";
        }
    }
    out += "iopl=" + getiopl();
    dbg_log(out);
    
    
    //dbg_log("last operation: " + h(last_op1 | 0) + ", " +  h(last_op2 | 0) + " = " +
            //h(last_result | 0) + " (" + last_op_size + " bit)")
    
}

function dump_gdt_ldt()
{
    dbg_log("gdt: (len = " + h(gdtr_size) + ")");
    dump_table(translate_address_read(gdtr_offset), gdtr_size);

    dbg_log("\nldt: (len = " + h(ldtr_size) + ")");
    dump_table(translate_address_read(ldtr_offset), ldtr_size);

    function dump_table(addr, size)
    {
        for(var i = 0; i < size; i += 8, addr += 8)
        {
            var base = memory.read16(addr + 2) | 
                    memory.read8(addr + 4) << 16 | 
                    memory.read8(addr + 7) << 24,

                limit = (memory.read16(addr) | memory.read8(addr + 6) & 0xF) + 1,
                access = memory.read8(addr + 5),
                flags = memory.read8(addr + 6) >> 4,
                flags_str = '',
                dpl = access >> 5 & 3;

            if(!(access & 128))
            {
                // present bit not set
                //continue;
                flags_str += 'NP ';
            }
            else
            {
                flags_str += ' P ';
            }

            if(access & 16)
            {
                if(flags & 4) 
                {
                    flags_str += '32b ';
                }
                else
                {
                    flags_str += '16b ';
                }

                if(access & 8)
                {
                    // executable
                    flags_str += 'X ';

                    if(access & 4)
                    {
                        flags_str += 'C ';
                    }
                }
                else
                {
                    // data
                    flags_str += 'R ';
                }
            }
            else
            {
                // system
                flags_str += 'sys: ' + h(access & 15);
            }

            if(flags & 8)
            {
                limit <<= 12;
            }
            
            dbg_log(h(i & ~7, 4) + " " + h(base >>> 0, 8) + " (" + h(limit, 8) + " bytes) " +
                    flags_str + ";  dpl = " + dpl + ", a = " + access.toString(2) +
                    ", f = " + flags.toString(2));
        }
    }
}

function dump_idt()
{
    for(var i = 0; i < idtr_size; i += 8)
    {
        var addr = do_page_translation(idtr_offset + i, 0, 0),
            base = memory.read16(addr) | memory.read16(addr + 6) << 16,
            selector = memory.read16(addr + 2),
            type = memory.read8(addr + 5),
            line,
            dpl = type >> 5 & 3;

        if((type & 31) === 5)
        {
            line = 'task gate ';
        }
        else if((type & 31) === 14)
        {
            line = 'intr gate ';
        }
        else if((type & 31) === 15)
        {
            line = 'trap gate ';
        }
        else
        {
            line = 'invalid   ';
        }


        if(type & 128)
        {
            line += ' P';
        }
        else
        {
            // present bit not set
            //continue;
            line += 'NP';
        }

    
        dbg_log(h(i >> 3, 4) + " " + h(base >>> 0, 8) + ", " + 
                h(selector, 4) + "; " + line + ";  dpl = " + dpl + ", t = " + type.toString(2));
    }
}

function load_page_entry(dword_entry, is_directory)
{
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
        cache : (dword_entry & 16) === 16,
        user : (dword_entry & 4) === 4,
        read_write : (dword_entry & 2) === 2,
        address : address >>> 0
    };
}

function dump_page_directory()
{
    for(var i = 0; i < 1024; i++)
    {
        var dword = memory.read32s(cr3 + 4 * i),
            entry = load_page_entry(dword, true);

        if(!entry)
        {
            continue;
        }

        var flags = '';

        if(entry.size)
            flags += 'S ';

        if(entry.cache)
            flags += 'D ';

        if(entry.user)
            flags += 'U ';

        if(entry.read_write)
            flags += 'R ';

        if(entry.accessed)
            flags += 'A ';

        dbg_log("=== " + h(entry.address >>> 0, 8) + " | " + flags);
        
        if(entry.size)
        {
            continue;
        }

        for(var j = 0; j < 1024; j++)
        {
            dword = memory.read32s(entry.address + 4 * j);
            
            var subentry = load_page_entry(dword, false);

            if(subentry)
            {
                flags = '';

                if(subentry.size)
                    flags += 'S ';

                if(subentry.cache)
                    flags += 'D ';

                if(subentry.user)
                    flags += 'U ';

                if(subentry.read_write)
                    flags += 'R ';

                if(subentry.global)
                    flags += 'G ';
                
                if(subentry.accessed)
                    flags += 'A ';

                if(subentry.dirty)
                    flags += 'Di ';

                dbg_log("# " + h((i << 22 | j << 12) >>> 0, 8) + " -> " +
                        h(subentry.address, 8) + " | " + flags);
            }
        }
    }
}


