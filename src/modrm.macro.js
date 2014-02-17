/*
 * This file contains functions to decode the modrm and sib bytes
 *
 * These functions return a virtual address
 *
 * Gets #included by cpu.macro.js
 */
"use strict";

var modrm_resolve16,
    modrm_resolve32;

function modrm_skip(modrm_byte)
{
    // advance the instruction pointer depending on modrm byte
    // but don't actually do address arithmatic
    
    if(modrm_byte <= 0xC0)
    {
        // TODO
        modrm_resolve(modrm_byte);
    }
}

(function() {

var modrm_table16 = Array(0xC0),
    modrm_table32 = Array(0xC0),
    sib_table = Array(0x100);

#define ds get_seg_prefix(reg_ds)
#define ss get_seg_prefix(reg_ss)

#define eax reg32s[reg_eax]
#define ecx reg32s[reg_ecx]
#define edx reg32s[reg_edx]
#define ebx reg32s[reg_ebx]
#define esp reg32s[reg_esp]
#define ebp reg32s[reg_ebp]
#define esi reg32s[reg_esi]
#define edi reg32s[reg_edi]

#define imm32 read_imm32s()
#define imm16 read_imm16()
#define imm8 read_imm8()

#define entry16(row, seg, value)\
    entry16_(0x00 | row, seg + ((value) & 0xFFFF))\
    entry16_(0x40 | row, seg + ((value) + read_imm8s() & 0xFFFF))\
    entry16_(0x80 | row, seg + ((value) + read_imm16() & 0xFFFF))\

#define entry16_(n, offset)\
    modrm_table16[n] = function() { return offset | 0; };


#define getsib(mod)\
    sib_table[read_imm8()](mod)

entry16(0, ds, reg16[reg_bx] + reg16[reg_si])
entry16(1, ds, reg16[reg_bx] + reg16[reg_di])
entry16(2, ss, reg16[reg_bp] + reg16[reg_si])
entry16(3, ss, reg16[reg_bp] + reg16[reg_di])
entry16(4, ds, reg16[reg_si])
entry16(5, ds, reg16[reg_di])
entry16(6, ss, reg16[reg_bp])
entry16(7, ds, reg16[reg_bx])

#define entry32(row, value)\
    entry32_(0x00 | row, (value))\
    entry32_(0x40 | row, (value) + read_imm8s())\
    entry32_(0x80 | row, (value) + read_imm32s())\

#define entry32_(n, offset)\
    modrm_table32[n] = function() { return offset | 0; };


entry32(0, ds + eax);
entry32(1, ds + ecx);
entry32(2, ds + edx);
entry32(3, ds + ebx);
entry32(4, getsib(false));
entry32(5, ss + ebp);
entry32(6, ds + esi);
entry32(7, ds + edi);


// special cases
modrm_table16[0x00 | 6] = function() { return ds + read_imm16() | 0; }

modrm_table32[0x00 | 5] = function() { return ds + read_imm32s() | 0; };

modrm_table32[0x00 | 4] = function() { return getsib(false) | 0; };
modrm_table32[0x40 | 4] = function() { return getsib(true) + read_imm8s() | 0; };
modrm_table32[0x80 | 4] = function() { return getsib(true) + read_imm32s() | 0; };


for(var low = 0; low < 8; low++)
{
    for(var high = 0; high < 3; high++)
    {
        for(var i = 1; i < 8; i++)
        {
            var x = low | high << 6;

            modrm_table32[x | i << 3] = modrm_table32[x];
            modrm_table16[x | i << 3] = modrm_table16[x];
        }
    }
}

#define entry_sib(n, reg1)\
    entry_sib2(0x00 | n << 3, reg1)\
    entry_sib2(0x40 | n << 3, reg1 << 1)\
    entry_sib2(0x80 | n << 3, reg1 << 2)\
    entry_sib2(0xC0 | n << 3, reg1 << 3)

#define entry_sib2(n, offset)\
    entry_sib3(n | 0, (offset) + ds + eax)\
    entry_sib3(n | 1, (offset) + ds + ecx)\
    entry_sib3(n | 2, (offset) + ds + edx)\
    entry_sib3(n | 3, (offset) + ds + ebx)\
    entry_sib3(n | 4, (offset) + ss + esp)\
    entry_sib3(n | 5, (offset) + (mod ? ss + ebp : ds + imm32))\
    entry_sib3(n | 6, (offset) + ds + esi)\
    entry_sib3(n | 7, (offset) + ds + edi)

#define entry_sib3(n, offset)\
    sib_table[n] = function(mod) { return offset | 0; };

entry_sib(0, eax);
entry_sib(1, ecx);
entry_sib(2, edx);
entry_sib(3, ebx);
entry_sib(4, 0);
entry_sib(5, ebp);
entry_sib(6, esi);
entry_sib(7, edi);


/**
 * @param {number} modrm_byte
 * @return {number}
 */
modrm_resolve16 = function(modrm_byte)
{
    return modrm_table16[modrm_byte]();
}

/**
 * @param {number} modrm_byte
 * @return {number}
 */
modrm_resolve32 = function(modrm_byte)
{
    return modrm_table32[modrm_byte]();
}

#undef ds 
#undef ss 

#undef eax 
#undef ecx 
#undef edx 
#undef ebx 
#undef esp 
#undef ebp 
#undef esi 
#undef edi 

#undef imm32 
#undef imm16
#undef imm8

#undef entry16
#undef entry16_
#undef entry32_

#undef entry_sib
#undef entry_sib2
#undef entry_sib3

})();
