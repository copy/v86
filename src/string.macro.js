"use strict";

/*
 * string operations
 *
 *       cmp  si  di
 * movs   0    1   1    A4
 * cmps   1    1   1    A6
 * stos   0    0   1    AA
 * lods   0    1   0    AC
 * scas   1    0   1    AE
 * ins    0    0   1
 * outs   0    1   0
 */

#define string_instruction(s, use_cmp, use_di, use_si, fn, aligned_fn)\
    var src, dest, data_src, data_dest;\
    var size = flags & flag_direction ? -(s >> 3) : s >> 3;\
    var ds, es;\
    if(use_cmp && !use_si) data_src = reg ## s[reg_eax];\
    if(use_di) es = get_seg(reg_es), dest = es + regv[reg_vdi];\
    if(use_si) ds = get_seg_prefix(reg_ds), src = ds + regv[reg_vsi];\
    if(repeat_string_prefix) {\
        if(regv[reg_vcx] === 0) return;\
        var aligned = s > 8 && (!use_di || (dest & (s >> 3) - 1) === 0) && (!use_si || (src & (s >> 3) - 1) === 0);\
        do {\
            if(aligned) {\
                aligned_fn;\
            } else {\
                fn;\
            }\
            if(use_di) dest += size, regv[reg_vdi] += size;\
            if(use_si) src += size, regv[reg_vsi] += size;\
        } while(--regv[reg_vcx] && (!use_cmp || (data_src === data_dest) === repeat_string_type));\
    } else {\
        fn;\
        if(use_di) regv[reg_vdi] += size;\
        if(use_si) regv[reg_vsi] += size;\
    }\
    if(use_cmp) cmp ## s(data_src, data_dest);\


function movsb()
{
    string_instruction(8, false, true, true, 
        {
            safe_write8(dest, safe_read8(src));
        }, {});
}

function movsw()
{
    string_instruction(16, false, true, true, 
        {
            safe_write16(dest, safe_read16(src));
        }, {
            var phys_src = translate_address_read(src);
            var phys_dest = translate_address_write(dest);

            memory.write_aligned16(phys_dest, memory.read_aligned16(phys_src));
        });
}

function movsd()
{
    string_instruction(32, false, true, true, 
        {
            safe_write32(dest, safe_read32s(src));
        }, {
            var phys_src = translate_address_read(src);
            var phys_dest = translate_address_write(dest);

            memory.write_aligned32(phys_dest, memory.read_aligned32(phys_src));
        });
}

function cmpsb()
{
    string_instruction(8, true, true, true,
        {
            data_dest = safe_read8(dest);
            data_src = safe_read8(src);
        }, {});
}


function cmpsw()
{
    string_instruction(16, true, true, true,
        {
            data_dest = safe_read16(dest);
            data_src = safe_read16(src);
        }, {
            data_dest = memory.read_aligned16(translate_address_read(dest));
            data_src = memory.read_aligned16(translate_address_read(src));
        });
}

function cmpsd()
{
    string_instruction(32, true, true, true,
        {
            data_dest = safe_read32(dest);
            data_src = safe_read32(src);
        }, {
            data_dest = memory.read_aligned32(translate_address_read(dest)) >>> 0;
            data_src = memory.read_aligned32(translate_address_read(src)) >>> 0;
        });
}


function stosb()
{
    var data = reg8[reg_al];

    string_instruction(8, false, true, false,
        {
            safe_write8(dest, data);
        }, {});
}


function stosw()
{
    var data = reg16[reg_ax];

    string_instruction(16, false, true, false,
        {
            safe_write16(dest, data);
        }, {
            memory.write_aligned16(translate_address_write(dest), data);
        });
}


function stosd()
{
    //dbg_log("stosd " + ((reg32[reg_edi] & 3) ? "mis" : "") + "aligned", LOG_CPU);
    var data = reg32[reg_eax];

    string_instruction(32, false, true, false,
        {
            safe_write32(dest, data);
        }, {
            memory.write_aligned32(translate_address_write(dest), data);
        });
}


function lodsb()
{
    string_instruction(8, false, false, true,
        {
            reg8[reg_al] = safe_read8(src);
        }, {});
}


function lodsw()
{
    string_instruction(16, false, false, true,
        {
            reg16[reg_ax] = safe_read16(src);
        }, {
            reg16[reg_ax] = safe_read16(src);
        });
}


function lodsd()
{
    string_instruction(32, false, false, true,
        {
            reg32[reg_eax] = safe_read32s(src);
        }, {
            reg32[reg_eax] = safe_read32s(src);
        });
}


function scasb()
{
    string_instruction(8, true, true, false,
        {
            data_dest = safe_read8(dest);
        }, {});
}


function scasw()
{
    string_instruction(16, true, true, false,
        {
            data_dest = safe_read16(dest);
        }, {
            data_dest = memory.read_aligned16(translate_address_read(dest));
        });
}

function scasd()
{
    string_instruction(32, true, true, false,
        {
            data_dest = safe_read32(dest);
        }, {
            data_dest = memory.read_aligned32(translate_address_read(dest)) >>> 0;
        });
}

function insb()
{
    var port = reg16[reg_dx];

    string_instruction(8, false, true, false, 
        {
            safe_write8(dest, in8(port));
        }, {
        });
}

function insw()
{
    var port = reg16[reg_dx];

    string_instruction(8, false, true, false, 
        {
            safe_write16(dest, in16(port));
        }, {
            var phys_dest = translate_address_write(dest);
            memory.write_aligned16(phys_dest, in16(port));
        });
}

function insd()
{
    var port = reg16[reg_dx];

    string_instruction(32, false, true, false, 
        {
            safe_write32(dest, in32(port));
        }, {
            var phys_dest = translate_address_write(dest);
            memory.write_aligned32(phys_dest, in32(port));
        });
}

function outsb()
{
    var port = reg16[reg_dx];

    string_instruction(8, false, false, true, 
        {
            out8(port, safe_read8(src));
        }, {
            out8(port, safe_read8(src));
        });
}

function outsw()
{
    var port = reg16[reg_dx];

    string_instruction(16, false, false, true, 
        {
            out16(port, safe_read16(src));
        }, {
            out16(port, safe_read16(src));
        });
}

function outsd()
{
    var port = reg16[reg_dx];

    string_instruction(32, false, false, true, 
        {
            out32(port, safe_read32s(src));
        }, {
            out32(port, safe_read32s(src));
        });
}
