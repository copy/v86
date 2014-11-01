/*
 * This file contains functions to decode the modrm and sib bytes
 *
 * These functions return a virtual address
 *
 * Gets #included by cpu.macro.js
 */
"use strict";


(function() {

v86.prototype.modrm_table16 = Array(0xC0);
v86.prototype.modrm_table32 = Array(0xC0);
v86.prototype.sib_table = Array(0x100);


#define ds cpu.get_seg_prefix_ds()
#define ss cpu.get_seg_prefix_ss()

#define eax cpu.reg32s[reg_eax]
#define ecx cpu.reg32s[reg_ecx]
#define edx cpu.reg32s[reg_edx]
#define ebx cpu.reg32s[reg_ebx]
#define esp cpu.reg32s[reg_esp]
#define ebp cpu.reg32s[reg_ebp]
#define esi cpu.reg32s[reg_esi]
#define edi cpu.reg32s[reg_edi]

#define entry16_level1(row, seg, value)\
    entry16_level2(0x00 | row, seg + ((value) & 0xFFFF))\
    entry16_level2(0x40 | row, seg + ((value) + cpu.read_imm8s() & 0xFFFF))\
    entry16_level2(0x80 | row, seg + ((value) + cpu.read_imm16() & 0xFFFF))\

#define entry16_level2(n, offset)\
    v86.prototype.modrm_table16[n] = function(cpu) { return offset | 0; };\

entry16_level1(0, ds, cpu.reg16[reg_bx] + cpu.reg16[reg_si])
entry16_level1(1, ds, cpu.reg16[reg_bx] + cpu.reg16[reg_di])
entry16_level1(2, ss, cpu.reg16[reg_bp] + cpu.reg16[reg_si])
entry16_level1(3, ss, cpu.reg16[reg_bp] + cpu.reg16[reg_di])
entry16_level1(4, ds, cpu.reg16[reg_si])
entry16_level1(5, ds, cpu.reg16[reg_di])
entry16_level1(6, ss, cpu.reg16[reg_bp])
entry16_level1(7, ds, cpu.reg16[reg_bx])



#define getsib(mod)\
    cpu.sib_table[cpu.read_imm8()](cpu, mod)

#define entry32_level1(row, value)\
    entry32_level2(0x00 | row, (value))\
    entry32_level2(0x40 | row, (value) + cpu.read_imm8s())\
    entry32_level2(0x80 | row, (value) + cpu.read_imm32s())\

#define entry32_level2(n, offset)\
    v86.prototype.modrm_table32[n] = function(cpu) { return offset | 0; };


entry32_level1(0, ds + eax);
entry32_level1(1, ds + ecx);
entry32_level1(2, ds + edx);
entry32_level1(3, ds + ebx);
entry32_level1(4, getsib(false));
entry32_level1(5, ss + ebp);
entry32_level1(6, ds + esi);
entry32_level1(7, ds + edi);


// special cases
v86.prototype.modrm_table16[0x00 | 6] = function(cpu) { return ds + cpu.read_imm16() | 0; }

v86.prototype.modrm_table32[0x00 | 5] = function(cpu) { return ds + cpu.read_imm32s() | 0; };

v86.prototype.modrm_table32[0x00 | 4] = function(cpu) { return getsib(false) | 0; };
v86.prototype.modrm_table32[0x40 | 4] = function(cpu) { return getsib(true) + cpu.read_imm8s() | 0; };
v86.prototype.modrm_table32[0x80 | 4] = function(cpu) { return getsib(true) + cpu.read_imm32s() | 0; };


for(var low = 0; low < 8; low++)
{
    for(var high = 0; high < 3; high++)
    {
        var x = low | high << 6;

        for(var i = 1; i < 8; i++)
        {
            v86.prototype.modrm_table32[x | i << 3] = v86.prototype.modrm_table32[x];
            v86.prototype.modrm_table16[x | i << 3] = v86.prototype.modrm_table16[x];
        }
    }
}

#define entry_sib_level1(n, reg1)\
    entry_sib_level2(0x00 | n << 3, reg1)\
    entry_sib_level2(0x40 | n << 3, reg1 << 1)\
    entry_sib_level2(0x80 | n << 3, reg1 << 2)\
    entry_sib_level2(0xC0 | n << 3, reg1 << 3)

#define entry_sib_level2(n, offset)\
    entry_sib_level3(n | 0, (offset) + ds + eax)\
    entry_sib_level3(n | 1, (offset) + ds + ecx)\
    entry_sib_level3(n | 2, (offset) + ds + edx)\
    entry_sib_level3(n | 3, (offset) + ds + ebx)\
    entry_sib_level3(n | 4, (offset) + ss + esp)\
    entry_sib_level3(n | 5, (offset) + (mod ? ss + ebp : ds + cpu.read_imm32s()))\
    entry_sib_level3(n | 6, (offset) + ds + esi)\
    entry_sib_level3(n | 7, (offset) + ds + edi)

#define entry_sib_level3(n, offset)\
    v86.prototype.sib_table[n] = function(cpu, mod) { return offset | 0; };

entry_sib_level1(0, eax);
entry_sib_level1(1, ecx);
entry_sib_level1(2, edx);
entry_sib_level1(3, ebx);
entry_sib_level1(4, 0);
entry_sib_level1(5, ebp);
entry_sib_level1(6, esi);
entry_sib_level1(7, edi);


v86.prototype.modrm_resolve = function(modrm_byte)
{
    return (this.address_size_32 ? this.modrm_table32 : this.modrm_table16)[modrm_byte](this);
};

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

#undef entry16_level1
#undef entry16_level2
#undef entry32_level1
#undef entry32_level2

#undef getsib

#undef entry_sib_level1
#undef entry_sib_level2
#undef entry_sib_level3

})();
