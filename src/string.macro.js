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

#define loop(s, fn)\
    do {\
        fn;\
        if(use_di) dest += size, cpu.regv[cpu.reg_vdi] += size;\
        if(use_si) src += size, cpu.regv[cpu.reg_vsi] += size;\
        cont = --cpu.regv[cpu.reg_vcx] && (!use_cmp || (data_src === data_dest) === (cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_Z));\
        cpu.timestamp_counter++;\
    } while(cont && next_cycle--)

#define aligned_loop(s, fn)\
    do {\
        fn;\
        if(use_di) phys_dest += single_size;\
        if(use_si) phys_src += single_size;\
        cont = --count && (!use_cmp || (data_src === data_dest) === (cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_Z));\
        cpu.timestamp_counter++;\
    } while(cont && next_cycle--)


#define string_instruction(s, fn, aligned_fn)\
    var src, dest, data_src, data_dest = 0, phys_dest, phys_src;\
    var size = cpu.flags & flag_direction ? -(s >> 3) : s >> 3;\
    var cont = false;\
    if(use_cmp && !use_si) data_src = s === 32 ? cpu.reg32s[reg_eax] : cpu.reg ## s[reg_al];\
    if(use_di) dest = cpu.get_seg(reg_es) + cpu.regv[cpu.reg_vdi] | 0;\
    if(use_si) src = cpu.get_seg_prefix(reg_ds) + cpu.regv[cpu.reg_vsi] | 0;\
    if(cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE) {\
        var count = cpu.regv[cpu.reg_vcx] >>> 0,\
            start_count = count;\
        if(count === 0) return;\
        var next_cycle = 0x4000;\
        var aligned = s === 8 ||\
            ((!use_di || !(dest & (s >> 3) - 1)) && (!use_si || !(src & (s >> 3) - 1)));\
        if(aligned) {\
            var single_size = size >> 31 | 1;\
            if(cpu.paging) {\
                if(use_si) {\
                    next_cycle = (single_size >> 1 ^ ~src) & 0xFFF;\
                    phys_src = cpu.translate_address_read(src);\
                }\
                if(use_di) {\
                    next_cycle = Math.min(next_cycle, (single_size >> 1 ^ ~dest) & 0xFFF);\
                    phys_dest = use_cmp ? cpu.translate_address_read(dest) : cpu.translate_address_write(dest);\
                }\
                if(s === 32) next_cycle >>= 2;\
                else if(s === 16) next_cycle >>= 1;\
            } else {\
                if(use_di) phys_dest = dest;\
                if(use_si) phys_src = src;\
            }\
            if(s === 32) { if(use_di) phys_dest >>>= 2; if(use_si) phys_src >>>= 2; }\
            else if(s === 16) { if(use_di) phys_dest >>>= 1; if(use_si) phys_src >>>= 1; }\
            aligned_loop(s, aligned_fn);\
            var diff = size * (start_count - count) | 0;\
            if(use_di) cpu.regv[cpu.reg_vdi] += diff;\
            if(use_si) cpu.regv[cpu.reg_vsi] += diff;\
            cpu.regv[cpu.reg_vcx] = count;\
        } else { \
            loop(s, fn);\
        }\
    } else {\
        if(s === 8) { \
            if(use_si) phys_src = cpu.translate_address_read(src);\
            if(use_di) phys_dest = use_cmp ? cpu.translate_address_read(dest) : cpu.translate_address_write(dest);\
            aligned_fn; \
        } else { fn; }\
        if(use_di) cpu.regv[cpu.reg_vdi] += size;\
        if(use_si) cpu.regv[cpu.reg_vsi] += size;\
    }\
    if(use_cmp) {\
        cmp ## s(data_src, data_dest);\
    }\
    if(cont) {\
        cpu.instruction_pointer = cpu.previous_ip;\
    }


#define use_cmp false
#define use_si true
#define use_di true
function movsb(cpu)
{
    string_instruction(8,
        {
            // no unaligned fn, bytewise is always aligned
        }, {
            cpu.memory.write8(phys_dest, cpu.memory.read8(phys_src));
        });
}

function movsw(cpu)
{
    string_instruction(16,
        {
            cpu.safe_write16(dest, cpu.safe_read16(src));
        }, {
            cpu.memory.write_aligned16(phys_dest, cpu.memory.read_aligned16(phys_src));
        });
}

function movsd(cpu)
{
    if(false && cpu.repeat_string_prefix !== REPEAT_STRING_PREFIX_NONE)
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

        if(!(dest & align_mask) && 
            !(src & align_mask)  && 
            !cpu.io.in_mmap_range(src, count) && 
            !cpu.io.in_mmap_range(dest, count))
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

            if((dest >>> 0) + (count << 2) <= cpu.memory_size &&
                    (src >>> 0) + (count << 2) <= cpu.memory_size)
            {
                dest >>= 2;
                src >>= 2;

                if(cpu.flags & flag_direction)
                {
                    dest -= count - 1;
                    src -= count - 1;
                }

                var diff = cpu.flags & flag_direction ? -count << 2 : count << 2;

                cpu.regv[cpu.reg_vcx] -= count;
                cpu.regv[cpu.reg_vdi] += diff;
                cpu.regv[cpu.reg_vsi] += diff;

                cpu.memory.mem32s.set(cpu.memory.mem32s.subarray(src, src + count), dest);

                if(cont) 
                {
                    cpu.instruction_pointer = cpu.previous_ip;
                }

                return;
            }
        }
    }

    string_instruction(32,
        {
            cpu.safe_write32(dest, cpu.safe_read32s(src));
        }, {
            cpu.memory.write_aligned32(phys_dest, cpu.memory.read_aligned32(phys_src));
        });
}

#undef use_cmp
#undef use_si
#undef use_di
#define use_cmp true
#define use_si true
#define use_di true
function cmpsb(cpu)
{
    string_instruction(8,
        {
        }, {
            data_dest = cpu.memory.read8(phys_dest);
            data_src = cpu.memory.read8(phys_src);
        });
}


function cmpsw(cpu)
{
    string_instruction(16,
        {
            data_dest = cpu.safe_read16(dest);
            data_src = cpu.safe_read16(src);
        }, {
            data_dest = cpu.memory.read_aligned16(phys_dest);
            data_src = cpu.memory.read_aligned16(phys_src);
        });
}

function cmpsd(cpu)
{
    string_instruction(32,
        {
            data_dest = cpu.safe_read32s(dest);
            data_src = cpu.safe_read32s(src);
        }, {
            data_dest = cpu.memory.read_aligned32(phys_dest);
            data_src = cpu.memory.read_aligned32(phys_src);
        });
}


#undef use_cmp
#undef use_si
#undef use_di
#define use_cmp false
#define use_si false
#define use_di true
function stosb(cpu)
{
    var data = cpu.reg8[reg_al];

    string_instruction(8,
        {
        }, {
            cpu.memory.write8(phys_dest, data);
        });
}


function stosw(cpu)
{
    var data = cpu.reg16[reg_ax];

    string_instruction(16,
        {
            cpu.safe_write16(dest, data);
        }, {
            cpu.memory.write_aligned16(phys_dest, data);
        });
}


function stosd(cpu)
{
    //dbg_log("stosd " + ((cpu.reg32s[reg_edi] & 3) ? "mis" : "") + "aligned", LOG_CPU);
    var data = cpu.reg32s[reg_eax];

    string_instruction(32,
        {
            cpu.safe_write32(dest, data);
        }, {
            cpu.memory.write_aligned32(phys_dest, data);
        });
}


#undef use_cmp
#undef use_si
#undef use_di
#define use_cmp false
#define use_si true
#define use_di false
function lodsb(cpu)
{
    string_instruction(8,
        {
        }, {
            cpu.reg8[reg_al] = cpu.memory.read8(phys_src);
        });
}


function lodsw(cpu)
{
    string_instruction(16,
        {
            cpu.reg16[reg_ax] = cpu.safe_read16(src);
        }, {
            cpu.reg16[reg_ax] = cpu.memory.read_aligned16(phys_src);
        });
}


function lodsd(cpu)
{
    string_instruction(32,
        {
            cpu.reg32s[reg_eax] = cpu.safe_read32s(src);
        }, {
            cpu.reg32s[reg_eax] = cpu.memory.read_aligned32(phys_src);
        });
}


#undef use_cmp
#undef use_si
#undef use_di
#define use_cmp true
#define use_si false
#define use_di true
function scasb(cpu)
{
    string_instruction(8,
        {
        }, {
            data_dest = cpu.memory.read8(phys_dest);
        });
}


function scasw(cpu)
{
    string_instruction(16,
        {
            data_dest = cpu.safe_read16(dest);
        }, {
            data_dest = cpu.memory.read_aligned16(phys_dest);
        });
}

function scasd(cpu)
{
    string_instruction(32,
        {
            data_dest = cpu.safe_read32s(dest);
        }, {
            data_dest = cpu.memory.read_aligned32(phys_dest);
        });
}

#undef use_cmp
#undef use_si
#undef use_di
#define use_cmp false
#define use_si false
#define use_di true
function insb(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 1);

    string_instruction(8,
        {
        }, {
            cpu.memory.write8(phys_dest, cpu.io.port_read8(port));
        });
}

function insw(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 2);

    string_instruction(16,
        {
            cpu.safe_write16(dest, cpu.io.port_read16(port));
        }, {
            cpu.memory.write_aligned16(phys_dest, cpu.io.port_read16(port));
        });
}

function insd(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 4);

    string_instruction(32,
        {
            cpu.safe_write32(dest, cpu.io.port_read32(port));
        }, {
            cpu.memory.write_aligned32(phys_dest, cpu.io.port_read32(port));
        });
}


#undef use_cmp
#undef use_si
#undef use_di
#define use_cmp false
#define use_si true
#define use_di false
function outsb(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 1);

    string_instruction(8,
        {
        }, {
            cpu.io.port_write8(port, cpu.memory.read8(phys_src));
        });
}

function outsw(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 2);

    string_instruction(16,
        {
            cpu.io.port_write16(port, cpu.safe_read16(src));
        }, {
            cpu.io.port_write16(port, cpu.memory.read_aligned16(phys_src));
        });
}

function outsd(cpu)
{
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 4);

    string_instruction(32,
        {
            cpu.io.port_write32(port, cpu.safe_read32s(src));
        }, {
            cpu.io.port_write32(port, cpu.memory.read_aligned32(phys_src));
        });
}

#undef use_cmp
#undef use_si
#undef use_di

#undef loop
#undef string_instruction
