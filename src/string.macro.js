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
        if(use_di) dest += size;\
        if(use_si) src += size;\
        cont = --count && (!use_cmp || (data_src === data_dest) === repeat_string_type);\
    } while(cont && next_cycle--)

#define aligned_loop(s, fn)\
    var single_size = size >> 31 | 1;\
    if(s === 32) { if(use_di) phys_dest >>>= 2; if(use_si) phys_src >>>= 2; }\
    else if(s === 16) { if(use_di) phys_dest >>>= 1; if(use_si) phys_src >>>= 1; }\
    do {\
        fn;\
        if(use_di) phys_dest += single_size;\
        if(use_si) phys_src += single_size;\
        cont = --count && (!use_cmp || (data_src === data_dest) === repeat_string_type);\
    } while(cont && next_cycle--)


#define string_instruction(s, fn, aligned_fn)\
    var src, dest, data_src, data_dest, phys_dest, phys_src;\
    var size = flags & flag_direction ? -(s >> 3) : s >> 3;\
    var cont = false;\
    if(use_cmp && !use_si) data_src = s === 32 ? reg32s[reg_eax] : reg ## s[reg_al];\
    if(use_di) dest = get_seg(reg_es) + regv[reg_vdi] | 0;\
    if(use_si) src = get_seg_prefix(reg_ds) + regv[reg_vsi] | 0;\
    if(repeat_string_prefix) {\
        var count = regv[reg_vcx],\
            start_count = count;\
        if(count === 0) return;\
        var next_cycle = 0x4000;\
        var aligned = s === 8 ||\
            ((!use_di || !(dest & (s >> 3) - 1)) && (!use_si || !(src & (s >> 3) - 1)));\
        if(aligned) {\
            if(paging) {\
                if(use_di) {\
                    next_cycle = ~dest & 0xFFF;\
                    phys_dest = use_cmp ? translate_address_read(dest) : translate_address_write(dest);\
                }\
                if(use_si) {\
                    next_cycle = Math.min(next_cycle, ~src & 0xFFF);\
                    phys_src = translate_address_read(src);\
                }\
                if(s === 32) next_cycle >>= 2;\
                else if(s === 16) next_cycle >>= 1;\
            } else { \
                if(use_di) phys_dest = dest;\
                if(use_si) phys_src = src;\
            }\
            aligned_loop(s, aligned_fn);\
        } else { \
            loop(s, fn);\
        }\
        var diff = size * (start_count - count) | 0;\
        if(use_di) regv[reg_vdi] += diff;\
        if(use_si) regv[reg_vsi] += diff;\
        regv[reg_vcx] = count;\
    } else {\
        if(s === 8) { \
            if(use_si) phys_src = translate_address_read(src);\
            if(use_di) phys_dest = use_cmp ? translate_address_read(dest) : translate_address_write(dest);\
            aligned_fn; \
        } else { fn; }\
        if(use_di) regv[reg_vdi] += size;\
        if(use_si) regv[reg_vsi] += size;\
    }\
    if(use_cmp) {\
        if(s === 32) cmp32(data_src >>> 0, data_dest >>> 0);\
        else cmp ## s(data_src, data_dest);\
    }\
    if(cont) {\
        instruction_pointer = previous_ip;\
    }


#define use_cmp false
#define use_si true
#define use_di true
function movsb()
{
    string_instruction(8,
        {
            // no unaligned fn, bytewise is always aligned
        }, {
            memory.write8(phys_dest, memory.read8(phys_src));
        });
}

function movsw()
{
    string_instruction(16,
        {
            safe_write16(dest, safe_read16(src));
        }, {
            memory.write_aligned16(phys_dest, memory.read_aligned16(phys_src));
        });
}

function movsd()
{
    // TODO: paging
    // For now use standard method
    
    if(repeat_string_prefix && !paging)
    {
        // often used by memcpy, well worth optimizing
        //   using memory.mem32s.set
        
        var ds = get_seg_prefix(reg_ds), 
            src = ds + regv[reg_vsi],
            es = get_seg(reg_es), 
            dest = es + regv[reg_vdi],
            count = regv[reg_vcx];

        if(!(dest & 3) && !(src & 3) && dest + count < memory_size)
        {
            dest >>= 2;
            src >>= 2;

            if(flags & flag_direction)
            {
                dest -= count - 1;
                src -= count - 1;
            }

            if(paging)
            {
                // TODO
            }
            else
            {
                var diff = flags & flag_direction ? -count << 2 : count << 2;
                regv[reg_vcx] = 0;
                regv[reg_vdi] += diff;
                regv[reg_vsi] += diff;
                memory.mem32s.set(memory.mem32s.subarray(src, src + count), dest);
                return;
            }
        }
    }

    string_instruction(32,
        {
            safe_write32(dest, safe_read32s(src));
        }, {
            memory.write_aligned32(phys_dest, memory.read_aligned32(phys_src));
        });
}

#undef use_cmp
#undef use_si
#undef use_di
#define use_cmp true
#define use_si true
#define use_di true
function cmpsb()
{
    string_instruction(8,
        {
        }, {
            data_dest = memory.read8(phys_dest);
            data_src = memory.read8(phys_src);
        });
}


function cmpsw()
{
    string_instruction(16,
        {
            data_dest = safe_read16(dest);
            data_src = safe_read16(src);
        }, {
            data_dest = memory.read_aligned16(phys_dest);
            data_src = memory.read_aligned16(phys_src);
        });
}

function cmpsd()
{
    string_instruction(32,
        {
            data_dest = safe_read32s(dest);
            data_src = safe_read32s(src);
        }, {
            data_dest = memory.read_aligned32(phys_dest);
            data_src = memory.read_aligned32(phys_src);
        });
}


#undef use_cmp
#undef use_si
#undef use_di
#define use_cmp false
#define use_si false
#define use_di true
function stosb()
{
    var data = reg8[reg_al];

    string_instruction(8,
        {
        }, {
            memory.write8(phys_dest, data);
        });
}


function stosw()
{
    var data = reg16[reg_ax];

    string_instruction(16,
        {
            safe_write16(dest, data);
        }, {
            memory.write_aligned16(phys_dest, data);
        });
}


function stosd()
{
    //dbg_log("stosd " + ((reg32[reg_edi] & 3) ? "mis" : "") + "aligned", LOG_CPU);
    var data = reg32s[reg_eax];

    string_instruction(32,
        {
            safe_write32(dest, data);
        }, {
            memory.write_aligned32(phys_dest, data);
        });
}


#undef use_cmp
#undef use_si
#undef use_di
#define use_cmp false
#define use_si true
#define use_di false
function lodsb()
{
    string_instruction(8,
        {
        }, {
            reg8[reg_al] = memory.read8(phys_src);
        });
}


function lodsw()
{
    string_instruction(16,
        {
            reg16[reg_ax] = safe_read16(src);
        }, {
            reg16[reg_ax] = memory.read_aligned16(phys_src);
        });
}


function lodsd()
{
    string_instruction(32,
        {
            reg32[reg_eax] = safe_read32s(src);
        }, {
            reg32[reg_eax] = memory.read_aligned32(phys_src);
        });
}


#undef use_cmp
#undef use_si
#undef use_di
#define use_cmp true
#define use_si false
#define use_di true
function scasb()
{
    string_instruction(8,
        {
        }, {
            data_dest = memory.read8(phys_dest);
        });
}


function scasw()
{
    string_instruction(16,
        {
            data_dest = safe_read16(dest);
        }, {
            data_dest = memory.read_aligned16(phys_dest);
        });
}

function scasd()
{
    string_instruction(32,
        {
            data_dest = safe_read32s(dest);
        }, {
            data_dest = memory.read_aligned32(phys_dest);
        });
}

#undef use_cmp
#undef use_si
#undef use_di
#define use_cmp false
#define use_si false
#define use_di true
function insb()
{
    test_privileges_for_io();

    var port = reg16[reg_dx];

    string_instruction(8,
        {
        }, {
            memory.write8(phys_dest, io.port_read8(port));
        });
}

function insw()
{
    test_privileges_for_io();

    var port = reg16[reg_dx];

    string_instruction(16,
        {
            safe_write16(dest, io.port_read16(port));
        }, {
            memory.write_aligned16(phys_dest, io.port_read16(port));
        });
}

function insd()
{
    test_privileges_for_io();

    var port = reg16[reg_dx];

    string_instruction(32,
        {
            safe_write32(dest, io.port_read32(port));
        }, {
            memory.write_aligned32(phys_dest, io.port_read32(port));
        });
}


#undef use_cmp
#undef use_si
#undef use_di
#define use_cmp false
#define use_si true
#define use_di false
function outsb()
{
    test_privileges_for_io();

    var port = reg16[reg_dx];

    string_instruction(8,
        {
        }, {
            io.port_write8(port, memory.read8(phys_src));
        });
}

function outsw()
{
    test_privileges_for_io();

    var port = reg16[reg_dx];

    string_instruction(16,
        {
            io.port_write16(port, safe_read16(src));
        }, {
            io.port_write16(port, memory.read_aligned16(phys_src));
        });
}

function outsd()
{
    test_privileges_for_io();

    var port = reg16[reg_dx];

    string_instruction(32,
        {
            io.port_write32(port, safe_read32s(src));
        }, {
            io.port_write32(port, memory.read_aligned32(phys_src));
        });
}

#undef use_cmp
#undef use_si
#undef use_di

#undef loop
#undef string_instruction
