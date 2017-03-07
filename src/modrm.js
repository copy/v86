/**
 * This file contains functions to decode the modrm and sib bytes
 *
 * These functions return a virtual address
 *
 * @fileoverview .
 * @suppress {newCheckTypes}
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
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_si]) + cpu.read_disp8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 0] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_si]) + cpu.read_disp16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 1] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_di]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 1] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_di]) + cpu.read_disp8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 1] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx] + cpu.reg16[reg_di]) + cpu.read_disp16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 2] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_si]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 2] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_si]) + cpu.read_disp8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 2] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_si]) + cpu.read_disp16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 3] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_di]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 3] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_di]) + cpu.read_disp8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 3] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp] + cpu.reg16[reg_di]) + cpu.read_disp16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 4] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_si]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 4] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_si]) + cpu.read_disp8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 4] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_si]) + cpu.read_disp16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 5] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_di]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 5] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_di]) + cpu.read_disp8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 5] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_di]) + cpu.read_disp16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 6] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 6] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp]) + cpu.read_disp8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 6] = function(cpu)
    {
        return cpu.get_seg_prefix_ss() + ((cpu.reg16[reg_bp]) + cpu.read_disp16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x00 | 7] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx]) & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x40 | 7] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx]) + cpu.read_disp8s() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table16[0x80 | 7] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + ((cpu.reg16[reg_bx]) + cpu.read_disp16() & 0xFFFF) | 0;
    };
    CPU.prototype.modrm_table32[0x00 | 0] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 0] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax]) + cpu.read_disp8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 0] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_eax]) + cpu.read_disp32s() | 0;
    };;
    CPU.prototype.modrm_table32[0x00 | 1] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 1] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx]) + cpu.read_disp8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 1] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ecx]) + cpu.read_disp32s() | 0;
    };;
    CPU.prototype.modrm_table32[0x00 | 2] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 2] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx]) + cpu.read_disp8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 2] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edx]) + cpu.read_disp32s() | 0;
    };;
    CPU.prototype.modrm_table32[0x00 | 3] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 3] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx]) + cpu.read_disp8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 3] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_ebx]) + cpu.read_disp32s() | 0;
    };;
    CPU.prototype.modrm_table32[0x00 | 5] = function(cpu)
    {
        return(cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 5] = function(cpu)
    {
        return(cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp]) + cpu.read_disp8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 5] = function(cpu)
    {
        return(cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp]) + cpu.read_disp32s() | 0;
    };;
    CPU.prototype.modrm_table32[0x00 | 6] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 6] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi]) + cpu.read_disp8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 6] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi]) + cpu.read_disp32s() | 0;
    };;
    CPU.prototype.modrm_table32[0x00 | 7] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi]) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 7] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi]) + cpu.read_disp8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 7] = function(cpu)
    {
        return(cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi]) + cpu.read_disp32s() | 0;
    };;
    // special cases
    CPU.prototype.modrm_table16[0x00 | 6] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + cpu.read_disp16() | 0;
    }
    CPU.prototype.modrm_table32[0x00 | 5] = function(cpu)
    {
        return cpu.get_seg_prefix_ds() + cpu.read_disp32s() | 0;
    };
    CPU.prototype.modrm_table32[0x00 | 4] = function(cpu)
    {
        return cpu.sib_resolve(false) | 0;
    };
    CPU.prototype.modrm_table32[0x40 | 4] = function(cpu)
    {
        return cpu.sib_resolve(true) + cpu.read_disp8s() | 0;
    };
    CPU.prototype.modrm_table32[0x80 | 4] = function(cpu)
    {
        return cpu.sib_resolve(true) + cpu.read_disp32s() | 0;
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
        return(cpu.reg32s[reg_eax]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_eax] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_eax] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_eax] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_ecx]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_ecx] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_ecx] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_ecx] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_edx]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_edx] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_edx] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_edx] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_ebx]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_ebx] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_ebx] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_ebx] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_ebp]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_ebp] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_ebp] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_ebp] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_esi]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_esi] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_esi] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_esi] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_edi]) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_edi] << 1) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_edi] << 2) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
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
        return(cpu.reg32s[reg_edi] << 3) + (mod ? cpu.get_seg_prefix_ss() + cpu.reg32s[reg_ebp] : cpu.get_seg_prefix_ds() + cpu.read_disp32s()) | 0;
    };
    CPU.prototype.sib_table[0xC0 | 7 << 3 | 6] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_esi] | 0;
    };
    CPU.prototype.sib_table[0xC0 | 7 << 3 | 7] = function(cpu, mod)
    {
        return(cpu.reg32s[reg_edi] << 3) + cpu.get_seg_prefix_ds() + cpu.reg32s[reg_edi] | 0;
    };
})();
