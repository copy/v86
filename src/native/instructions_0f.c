#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#include "arith.h"
#include "const.h"
#include "cpu.h"
#include "fpu.h"
#include "global_pointers.h"
#include "instructions.h"
#include "instructions_0f.h"
#include "js_imports.h"
#include "log.h"
#include "memory.h"
#include "misc_instr.h"
#include "sse_instr.h"

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"

bool apic_enabled = false;

void instr_0F00_0_mem(int32_t addr) {
    // sldt
    if(!protected_mode[0] || vm86_mode()) { trigger_ud(); return; }
    safe_write16(addr, sreg[LDTR]);
}
void instr_0F00_0_reg(int32_t r) {
    if(!protected_mode[0] || vm86_mode()) { trigger_ud(); return; }
    write_reg_osize(r, sreg[LDTR]);
}
void instr_0F00_1_mem(int32_t addr) {
    // str
    if(!protected_mode[0] || vm86_mode()) { trigger_ud(); return; }
    safe_write16(addr, sreg[TR]);
}
void instr_0F00_1_reg(int32_t r) {
    if(!protected_mode[0] || vm86_mode()) { trigger_ud(); return; }
    write_reg_osize(r, sreg[TR]);
}
void instr_0F00_2_mem(int32_t addr) {
    // lldt
    if(!protected_mode[0] || vm86_mode()) { trigger_ud(); return; }
    if(cpl[0]) { trigger_gp_non_raising(0); return; }
    load_ldt(safe_read16(addr));
}
void instr_0F00_2_reg(int32_t r) {
    if(!protected_mode[0] || vm86_mode()) { trigger_ud(); return; }
    if(cpl[0]) { trigger_gp_non_raising(0); return; }
    load_ldt(read_reg16(r));
}
void instr_0F00_3_mem(int32_t addr) {
    // ltr
    if(!protected_mode[0] || vm86_mode()) { trigger_ud(); return; }
    if(cpl[0]) { trigger_gp_non_raising(0); return; }
    load_tr(safe_read16(addr));
}
void instr_0F00_3_reg(int32_t r) {
    if(!protected_mode[0] || vm86_mode()) { trigger_ud(); return; }
    if(cpl[0]) { trigger_gp_non_raising(0); return; }
    load_tr(read_reg16(r));
}
void instr_0F00_4_mem(int32_t addr) {
    if(!protected_mode[0] || vm86_mode()) { trigger_ud(); return; }
    verr(safe_read16(addr));
}
void instr_0F00_4_reg(int32_t r) {
    if(!protected_mode[0] || vm86_mode()) { trigger_ud(); return; }
    verr(read_reg16(r));
}
void instr_0F00_5_mem(int32_t addr) {
    if(!protected_mode[0] || vm86_mode()) { trigger_ud(); return; }
    verw(safe_read16(addr));
}
void instr_0F00_5_reg(int32_t r) {
    if(!protected_mode[0] || vm86_mode()) { trigger_ud(); return; }
    verw(read_reg16(r));
}


void instr_0F01_0_reg(int32_t r) { trigger_ud(); }
void instr_0F01_0_mem(int32_t addr) {
    // sgdt
    writable_or_pagefault(addr, 6);
    int32_t mask = is_osize_32() ? -1 : 0x00FFFFFF;
    safe_write16(addr, gdtr_size[0]);
    safe_write32(addr + 2, gdtr_offset[0] & mask);
}
void instr_0F01_1_reg(int32_t r) { trigger_ud(); }
void instr_0F01_1_mem(int32_t addr) {
    // sidt
    writable_or_pagefault(addr, 6);
    int32_t mask = is_osize_32() ? -1 : 0x00FFFFFF;
    safe_write16(addr, idtr_size[0]);
    safe_write32(addr + 2, idtr_offset[0] & mask);
}
void instr_0F01_2_reg(int32_t r) { trigger_ud(); }
void instr_0F01_2_mem(int32_t addr) {
    // lgdt
    if(cpl[0]) { trigger_gp_non_raising(0); return; }
    int32_t size = safe_read16(addr);
    int32_t offset = safe_read32s(addr + 2);
    int32_t mask = is_osize_32() ? -1 : 0x00FFFFFF;
    gdtr_size[0] = size;
    gdtr_offset[0] = offset & mask;
}
void instr_0F01_3_reg(int32_t r) { trigger_ud(); }
void instr_0F01_3_mem(int32_t addr) {
    // lidt
    if(cpl[0]) { trigger_gp_non_raising(0); return; }
    int32_t size = safe_read16(addr);
    int32_t offset = safe_read32s(addr + 2);
    int32_t mask = is_osize_32() ? -1 : 0x00FFFFFF;
    idtr_size[0] = size;
    idtr_offset[0] = offset & mask;
}

void instr_0F01_4_reg(int32_t r) {
    // smsw
    write_reg_osize(r, cr[0]);
}
void instr_0F01_4_mem(int32_t addr) {
    safe_write16(addr, cr[0] & 0xFFFF);
}

void lmsw(int32_t new_cr0) {
    new_cr0 = (cr[0] & ~0xF) | (new_cr0 & 0xF);

    if(protected_mode[0])
    {
        // lmsw cannot be used to switch back
        new_cr0 |= CR0_PE;
    }

    set_cr0(new_cr0);
}
void instr_0F01_6_reg(int32_t r) {
    if(cpl[0]) { trigger_gp_non_raising(0); return; }
    lmsw(read_reg16(r));
}
void instr_0F01_6_mem(int32_t addr) {
    if(cpl[0]) { trigger_gp_non_raising(0); return; }
    lmsw(safe_read16(addr));
}

void instr_0F01_7_reg(int32_t r) { trigger_ud(); }
void instr_0F01_7_mem(int32_t addr) {
    // invlpg
    if(cpl[0]) { trigger_gp_non_raising(0); return; }
    invlpg(addr);
}

DEFINE_MODRM_INSTR_READ16(instr16_0F02, write_reg16(r, lar(___, read_reg16(r))))
DEFINE_MODRM_INSTR_READ16(instr32_0F02, write_reg32(r, lar(___, read_reg32(r))))

DEFINE_MODRM_INSTR_READ16(instr16_0F03, write_reg16(r, lsl(___, read_reg16(r))))
DEFINE_MODRM_INSTR_READ16(instr32_0F03, write_reg32(r, lsl(___, read_reg32(r))))

void instr_0F04() { undefined_instruction(); }
void instr_0F05() { undefined_instruction(); }

void instr_0F06() {
    // clts
    if(cpl[0])
    {
        dbg_log("clts #gp");
        trigger_gp_non_raising(0);
    }
    else
    {
        //dbg_log("clts");
        cr[0] &= ~CR0_TS;
    }
}

void instr_0F07() { undefined_instruction(); }
void instr_0F08() {
    // invd
    undefined_instruction();
}

void instr_0F09() {
    if(cpl[0])
    {
        dbg_log("wbinvd #gp");
        trigger_gp_non_raising(0);
    }
    else
    {
        // wbinvd
    }
}


void instr_0F0A() { undefined_instruction(); }
void instr_0F0B() {
    // UD2
    trigger_ud();
}
void instr_0F0C() { undefined_instruction(); }

void instr_0F0D() {
    // nop
    undefined_instruction();
}

void instr_0F0E() { undefined_instruction(); }
void instr_0F0F() { undefined_instruction(); }

void instr_0F10(union reg128 source, int32_t r) {
    // movups xmm, xmm/m128
    mov_rm_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_0F10, safe_read128s, read_xmm128s)

void instr_F30F10_reg(int32_t r1, int32_t r2) {
    // movss xmm, xmm/m32
    union reg128 data = read_xmm128s(r1);
    union reg128 orig = read_xmm128s(r2);
    write_xmm128(r2, data.u32[0], orig.u32[1], orig.u32[2], orig.u32[3]);
}
void instr_F30F10_mem(int32_t addr, int32_t r) {
    // movss xmm, xmm/m32
    int32_t data = safe_read32s(addr);
    write_xmm128(r, data, 0, 0, 0);
}

void instr_660F10(union reg128 source, int32_t r) {
    // movupd xmm, xmm/m128
    mov_rm_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_660F10, safe_read128s, read_xmm128s)

void instr_F20F10_reg(int32_t r1, int32_t r2) {
    // movsd xmm, xmm/m64
    union reg128 data = read_xmm128s(r1);
    union reg128 orig = read_xmm128s(r2);
    write_xmm128(r2, data.u32[0], data.u32[1], orig.u32[2], orig.u32[3]);
}
void instr_F20F10_mem(int32_t addr, int32_t r) {
    // movsd xmm, xmm/m64
    union reg64 data = safe_read64s(addr);
    write_xmm128(r, data.u32[0], data.u32[1], 0, 0);
}

void instr_0F11_reg(int32_t r1, int32_t r2) {
    // movups xmm/m128, xmm
    mov_r_r128(r1, r2);
}
void instr_0F11_mem(int32_t addr, int32_t r) {
    // movups xmm/m128, xmm
    mov_r_m128(addr, r);
}

void instr_F30F11_reg(int32_t rm_dest, int32_t reg_src) {
    // movss xmm/m32, xmm
    union reg128 data = read_xmm128s(reg_src);
    union reg128 orig = read_xmm128s(rm_dest);
    write_xmm128(rm_dest, data.u32[0], orig.u32[1], orig.u32[2], orig.u32[3]);
}
void instr_F30F11_mem(int32_t addr, int32_t r) {
    // movss xmm/m32, xmm
    union reg128 data = read_xmm128s(r);
    safe_write32(addr, data.u32[0]);
}

void instr_660F11_reg(int32_t r1, int32_t r2) {
    // movupd xmm/m128, xmm
    mov_r_r128(r1, r2);
}
void instr_660F11_mem(int32_t addr, int32_t r) {
    // movupd xmm/m128, xmm
    mov_r_m128(addr, r);
}

void instr_F20F11_reg(int32_t r1, int32_t r2) {
    // movsd xmm/m64, xmm
    union reg128 data = read_xmm128s(r2);
    union reg128 orig = read_xmm128s(r1);
    write_xmm128(r1, data.u32[0], data.u32[1], orig.u32[2], orig.u32[3]);
}
void instr_F20F11_mem(int32_t addr, int32_t r) {
    // movsd xmm/m64, xmm
    union reg64 data = read_xmm64s(r);
    safe_write64(addr, data.u64[0]);
}

void instr_0F12_mem(int32_t addr, int32_t r) {
    // movlps xmm, m64
    union reg64 data = safe_read64s(addr);
    union reg128 orig = read_xmm128s(r);
    write_xmm128(r, data.u32[0], data.u32[1], orig.u32[2], orig.u32[3]);
}
void instr_0F12_reg(int32_t r1, int32_t r2) {
    // movhlps xmm, xmm
    union reg128 data = read_xmm128s(r1);
    union reg128 orig = read_xmm128s(r2);
    write_xmm128(r2, data.u32[2], data.u32[3], orig.u32[2], orig.u32[3]);
}

void instr_660F12_reg(int32_t r1, int32_t r) { trigger_ud(); }
void instr_660F12_mem(int32_t addr, int32_t r) {
    // movlpd xmm, m64
    union reg64 data = safe_read64s(addr);
    write_xmm64(r, data);
}
void instr_F20F12_mem(int32_t addr, int32_t r) { unimplemented_sse(); }
void instr_F20F12_reg(int32_t r1, int32_t r2) { unimplemented_sse(); }
void instr_F30F12_mem(int32_t addr, int32_t r) { unimplemented_sse(); }
void instr_F30F12_reg(int32_t r1, int32_t r2) { unimplemented_sse(); }

void instr_0F13_mem(int32_t addr, int32_t r) {
    // movlps m64, xmm
    movl_r128_m64(addr, r);
}

void instr_0F13_reg(int32_t r1, int32_t r2) { trigger_ud(); }

void instr_660F13_reg(int32_t r1, int32_t r) { trigger_ud(); }
void instr_660F13_mem(int32_t addr, int32_t r) {
    // movlpd xmm/m64, xmm
    movl_r128_m64(addr, r);
}

void instr_0F14(union reg64 source, int32_t r) {
    // unpcklps xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg64 destination = read_xmm64s(r);

    write_xmm128(
        r,
        destination.u32[0],
        source.u32[0],
        destination.u32[1],
        source.u32[1]
    );
}
DEFINE_SSE_SPLIT(instr_0F14, safe_read64s, read_xmm64s)

void instr_660F14(union reg64 source, int32_t r) {
    // unpcklpd xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg64 destination = read_xmm64s(r);

    write_xmm128(
        r,
        destination.u32[0],
        destination.u32[1],
        source.u32[0],
        source.u32[1]
    );
}
DEFINE_SSE_SPLIT(instr_660F14, safe_read64s, read_xmm64s)

void instr_0F15(union reg128 source, int32_t r) {
    // unpckhps xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    write_xmm128(
        r,
        destination.u32[2],
        source.u32[2],
        destination.u32[3],
        source.u32[3]
    );
}
DEFINE_SSE_SPLIT(instr_0F15, safe_read128s, read_xmm128s)

void instr_660F15(union reg128 source, int32_t r) {
    // unpckhpd xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    write_xmm128(
        r,
        destination.u32[2],
        destination.u32[3],
        source.u32[2],
        source.u32[3]
    );
}
DEFINE_SSE_SPLIT(instr_660F15, safe_read128s, read_xmm128s)

void instr_0F16_mem(int32_t addr, int32_t r) {
    // movhps xmm, m64
    movh_m64_r128(addr, r);
}
void instr_0F16_reg(int32_t r1, int32_t r2) {
    // movlhps xmm, xmm
    union reg128 data = read_xmm128s(r1);
    union reg128 orig = read_xmm128s(r2);
    write_xmm128(r2, orig.u32[0], orig.u32[1], data.u32[0], data.u32[1]);
}

void instr_660F16_mem(int32_t addr, int32_t r) {
    // movhpd xmm, m64
    movh_m64_r128(addr, r);
}
void instr_660F16_reg(int32_t r1, int32_t r2) { trigger_ud(); }
void instr_F30F16() { unimplemented_sse(); }

void instr_0F17_mem(int32_t addr, int32_t r) {
    // movhps m64, xmm
    movh_r128_m64(addr, r);
}
void instr_0F17_reg(int32_t r1, int32_t r2) { trigger_ud(); }

void instr_660F17_mem(int32_t addr, int32_t r) {
    // movhpd m64, xmm
    movh_r128_m64(addr, r);
}
void instr_660F17_reg(int32_t r1, int32_t r2) { trigger_ud(); }

void instr_0F18_reg(int32_t r1, int32_t r2) {
    //  reserved nop
}
void instr_0F18_mem(int32_t addr, int32_t r) {
    // prefetch
    // nop for us
}

// hintable nops
void instr_0F19_reg(int32_t r1, int32_t r2) { }
void instr_0F19_mem(int32_t addr, int32_t r) { }
void instr_0F1A() { undefined_instruction(); }
void instr_0F1B() { undefined_instruction(); }
void instr_0F1C_reg(int32_t r1, int32_t r2) { }
void instr_0F1C_mem(int32_t addr, int32_t r) { }
void instr_0F1D_reg(int32_t r1, int32_t r2) { }
void instr_0F1D_mem(int32_t addr, int32_t r) { }
void instr_0F1E_reg(int32_t r1, int32_t r2) { }
void instr_0F1E_mem(int32_t addr, int32_t r) { }
void instr_0F1F_reg(int32_t r1, int32_t r2) { }
void instr_0F1F_mem(int32_t addr, int32_t r) { }


void instr_0F20(int32_t r, int32_t creg) {

    if(cpl[0])
    {
        trigger_gp_non_raising(0);
        return;
    }

    switch(creg)
    {
        case 0:
            write_reg32(r, cr[0]);
            break;
        case 2:
            write_reg32(r, cr[2]);
            break;
        case 3:
            write_reg32(r, cr[3]);
            break;
        case 4:
            write_reg32(r, cr[4]);
            break;
        default:
            dbg_log("%d", creg);
            undefined_instruction();
    }
}

void instr_0F21(int32_t r, int32_t dreg_index) {
    if(cpl[0])
    {
        trigger_gp_non_raising(0);
        return;
    }

    if(dreg_index == 4 || dreg_index == 5)
    {
        if(cr[4] & CR4_DE)
        {
            dbg_log("#ud mov dreg 4/5 with cr4.DE set");
            trigger_ud();
            return;
        }
        else
        {
            // DR4 and DR5 refer to DR6 and DR7 respectively
            dreg_index += 2;
        }
    }

    write_reg32(r, dreg[dreg_index]);

    //dbg_log("read dr%d: %x", dreg_index, dreg[dreg_index]);
}

void instr_0F22(int32_t r, int32_t creg) {

    if(cpl[0])
    {
        trigger_gp_non_raising(0);
        return;
    }

    int32_t data = read_reg32(r);

    // mov cr, addr
    switch(creg)
    {
        case 0:
            //dbg_log("cr0 <- %x", data);
            set_cr0(data);
            break;

        case 2:
            dbg_log("cr2 <- %x", data);
            cr[2] = data;
            break;

        case 3:
            //dbg_log("cr3 <- %x", data);
            data &= ~0b111111100111;
            dbg_assert_message((data & 0xFFF) == 0, "TODO");
            cr[3] = data;
            clear_tlb();

            //dump_page_directory();
            break;

        case 4:
            dbg_log("cr4 <- %d", cr[4]);

            if(data & (1 << 11 | 1 << 12 | 1 << 15 | 1 << 16 | 1 << 19 | 0xFFC00000))
            {
                dbg_log("trigger_gp: Invalid cr4 bit");
                trigger_gp_non_raising(0);
                return;
            }

            if((cr[4] ^ data) & (CR4_PGE | CR4_PSE))
            {
                full_clear_tlb();
            }

            cr[4] = data;

            if(cr[4] & CR4_PAE)
            {
                //throw debug.unimpl("PAE");
                assert(false);
            }

            break;

        default:
            dbg_log("%d", creg);
            undefined_instruction();
    }
}
void instr_0F23(int32_t r, int32_t dreg_index) {
    if(cpl[0])
    {
        trigger_gp_non_raising(0);
        return;
    }

    if(dreg_index == 4 || dreg_index == 5)
    {
        if(cr[4] & CR4_DE)
        {
            dbg_log("#ud mov dreg 4/5 with cr4.DE set");
            trigger_ud();
            return;
        }
        else
        {
            // DR4 and DR5 refer to DR6 and DR7 respectively
            dreg_index += 2;
        }
    }

    dreg[dreg_index] = read_reg32(r);

    //dbg_log("write dr%d: %x", dreg_index, dreg[dreg_index]);
}

void instr_0F24() { undefined_instruction(); }
void instr_0F25() { undefined_instruction(); }
void instr_0F26() { undefined_instruction(); }
void instr_0F27() { undefined_instruction(); }

void instr_0F28(union reg128 source, int32_t r) {
    // movaps xmm, xmm/m128
    // XXX: Aligned read or #gp
    mov_rm_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_0F28, safe_read128s, read_xmm128s)

void instr_660F28(union reg128 source, int32_t r) {
    // movapd xmm, xmm/m128
    // XXX: Aligned read or #gp
    // Note: Same as movdqa (660F6F)
    mov_rm_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_660F28, safe_read128s, read_xmm128s)

void instr_0F29_mem(int32_t addr, int32_t r) {
    // movaps m128, xmm
    union reg128 data = read_xmm128s(r);
    // XXX: Aligned write or #gp
    safe_write128(addr, data);
}
void instr_0F29_reg(int32_t r1, int32_t r2) {
    // movaps xmm, xmm
    mov_r_r128(r1, r2);
}
void instr_660F29_mem(int32_t addr, int32_t r) {
    // movapd m128, xmm
    union reg128 data = read_xmm128s(r);
    // XXX: Aligned write or #gp
    safe_write128(addr, data);
}
void instr_660F29_reg(int32_t r1, int32_t r2) {
    // movapd xmm, xmm
    mov_r_r128(r1, r2);
}

void instr_0F2A(union reg64 source, int32_t r) {
    // cvtpi2ps xmm, mm/m64
    // XXX: The non-memory variant causes a transition from x87 FPU to MMX technology operation
    union reg64 result = {
        .f32 = {
            // Note: Casts here can fail
            source.i32[0],
            source.i32[1],
        }
    };
    write_xmm64(r, result);
}
DEFINE_SSE_SPLIT(instr_0F2A, safe_read64s, read_mmx64s)
void instr_660F2A(union reg64 source, int32_t r) {
    // cvtpi2pd xmm, xmm/m64
    // XXX: The non-memory variant causes a transition from x87 FPU to MMX technology operation
    union reg128 result = {
        .f64 = {
            // These casts can't fail
            source.i32[0],
            source.i32[1],
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660F2A, safe_read64s, read_mmx64s)
void instr_F20F2A(int32_t source, int32_t r) {
    // cvtsi2sd xmm, r32/m32
    union reg64 result = {
        // This cast can't fail
        .f64 = { source }
    };
    write_xmm64(r, result);
}
DEFINE_SSE_SPLIT(instr_F20F2A, safe_read32s, read_reg32)
void instr_F30F2A(int32_t source, int32_t r) {
    // cvtsi2ss xmm, r/m32
    // Note: This cast can fail
    float_t result = source;
    write_xmm_f32(r, result);
}
DEFINE_SSE_SPLIT(instr_F30F2A, safe_read32s, read_reg32)

void instr_0F2B_reg(int32_t r1, int32_t r2) { trigger_ud(); }
void instr_0F2B_mem(int32_t addr, int32_t r) {
    // movntps m128, xmm
    // XXX: Aligned write or #gp
    mov_r_m128(addr, r);
}

void instr_660F2B_reg(int32_t r1, int32_t r2) { trigger_ud(); }
void instr_660F2B_mem(int32_t addr, int32_t r) {
    // movntpd m128, xmm
    // XXX: Aligned write or #gp
    mov_r_m128(addr, r);
}

void instr_0F2C(union reg64 source, int32_t r) { unimplemented_sse(); }
DEFINE_SSE_SPLIT(instr_0F2C, safe_read64s, read_mmx64s)

void instr_660F2C(union reg128 source, int32_t r) { unimplemented_sse(); }
DEFINE_SSE_SPLIT(instr_660F2C, safe_read128s, read_xmm128s)

void instr_F20F2C(union reg64 source, int32_t r) {
    // cvttsd2si r32, xmm/m64
    // emscripten bug causes this ported instruction to throw "integer result unpresentable"
    // https://github.com/kripken/emscripten/issues/5433
#if 0
    union reg64 source = read_xmm_mem64s();
    double f = source.f64[0];

    if(f <= 0x7FFFFFFF && f >= -0x80000000)
    {
        int32_t si = (int32_t) f;
        write_g32(si);
    }
    else
    {
        write_g32(0x80000000);
    }
#else
    write_reg32(r, convert_f64_to_i32(source.f64[0]));
#endif
}
DEFINE_SSE_SPLIT(instr_F20F2C, safe_read64s, read_xmm64s)

void instr_F30F2C(float_t source, int32_t r) { unimplemented_sse(); }
DEFINE_SSE_SPLIT(instr_F30F2C, fpu_load_m32, read_xmm_f32)

void instr_0F2D(union reg64 source, int32_t r) { unimplemented_sse(); }
DEFINE_SSE_SPLIT(instr_0F2D, safe_read64s, read_mmx64s)

void instr_660F2D(union reg128 source, int32_t r) { unimplemented_sse(); }
DEFINE_SSE_SPLIT(instr_660F2D, safe_read128s, read_xmm128s)

void instr_F20F2D(union reg64 source, int32_t r) {
    // cvtsd2si r32, xmm/m64
    write_reg32(r, sse_convert_f64_to_i32(source.f64[0]));
}
DEFINE_SSE_SPLIT(instr_F20F2D, safe_read64s, read_xmm64s)

void instr_F30F2D(float_t source, int32_t r) { unimplemented_sse(); }
DEFINE_SSE_SPLIT(instr_F30F2D, fpu_load_m32, read_xmm_f32)

void instr_0F2E() { unimplemented_sse(); }
void instr_0F2F() { unimplemented_sse(); }

// wrmsr
void instr_0F30() {
    // wrmsr - write maschine specific register

    if(cpl[0])
    {
        trigger_gp_non_raising(0);
        return;
    }

    int32_t index = reg32s[ECX];
    int32_t low = reg32s[EAX];
    int32_t high = reg32s[EDX];

    if(index != IA32_SYSENTER_ESP)
    {
        dbg_log("wrmsr ecx=%x data=%x:%x", index, high, low);
    }

    switch(index)
    {
        case IA32_SYSENTER_CS:
            sysenter_cs[0] = low & 0xFFFF;
            break;

        case IA32_SYSENTER_EIP:
            sysenter_eip[0] = low;
            break;

        case IA32_SYSENTER_ESP:
            sysenter_esp[0] = low;
            break;

        case IA32_APIC_BASE_MSR:
            {
                dbg_assert_message(high == 0, "Changing APIC address (high 32 bits) not supported");
                int32_t address = low & ~(IA32_APIC_BASE_BSP | IA32_APIC_BASE_EXTD | IA32_APIC_BASE_EN);
                dbg_assert_message(address == APIC_ADDRESS, "Changing APIC address not supported");
                dbg_assert_message((low & IA32_APIC_BASE_EXTD) == 0, "x2apic not supported");
                apic_enabled = (low & IA32_APIC_BASE_EN) == IA32_APIC_BASE_EN;
            }
            break;

        case IA32_TIME_STAMP_COUNTER:
            set_tsc(low, high);
            break;

        case IA32_BIOS_SIGN_ID:
            break;

        case MSR_MISC_FEATURE_ENABLES:
            // Linux 4, see: https://patchwork.kernel.org/patch/9528279/
            break;

        case IA32_MISC_ENABLE: // Enable Misc. Processor Features
            break;

        case IA32_MCG_CAP:
            // netbsd
            break;

        case IA32_KERNEL_GS_BASE:
            // Only used in 64 bit mode (by SWAPGS), but set by kvm-unit-test
            dbg_log("GS Base written");
            break;

        default:
            dbg_log("Unknown msr: %x", index);
            assert(false);
    }
}

void instr_0F31() {
    // rdtsc - read timestamp counter

    if(!cpl[0] || !(cr[4] & CR4_TSD))
    {
        uint64_t tsc = read_tsc();

        reg32s[EAX] = tsc;
        reg32s[EDX] = tsc >> 32;

        //dbg_log("rdtsc  edx:eax=%x:%x", reg32s[EDX], reg32s[EAX]);
    }
    else
    {
        trigger_gp_non_raising(0);
    }
}

void instr_0F32() {
    // rdmsr - read maschine specific register
    if(cpl[0])
    {
        trigger_gp_non_raising(0);
        return;
    }

    int32_t index = reg32s[ECX];

    dbg_log("rdmsr ecx=%x", index);

    int32_t low = 0;
    int32_t high = 0;

    switch(index)
    {
        case IA32_SYSENTER_CS:
            low = sysenter_cs[0];
            break;

        case IA32_SYSENTER_EIP:
            low = sysenter_eip[0];
            break;

        case IA32_SYSENTER_ESP:
            low = sysenter_esp[0];
            break;

        case IA32_TIME_STAMP_COUNTER:
            {
                uint64_t tsc = read_tsc();
                low = tsc;
                high = tsc >> 32;
            }
            break;

        case IA32_PLATFORM_ID:
            break;

        case IA32_APIC_BASE_MSR:
            if(ENABLE_ACPI)
            {
                low = APIC_ADDRESS;

                if(apic_enabled)
                {
                    low |= IA32_APIC_BASE_EN;
                }
            }
            break;

        case IA32_BIOS_SIGN_ID:
            break;

        case MSR_PLATFORM_INFO:
            low = 1 << 8;
            break;

        case MSR_MISC_FEATURE_ENABLES:
            break;

        case IA32_MISC_ENABLE: // Enable Misc. Processor Features
            low = 1 << 0; // fast string
            break;

        case IA32_RTIT_CTL:
            // linux4
            break;

        case MSR_SMI_COUNT:
            break;

        case IA32_MCG_CAP:
            // netbsd
            break;

        case MSR_PKG_C2_RESIDENCY:
            break;

        default:
            dbg_log("Unknown msr: %x", index);
            assert(false);
    }

    reg32s[EAX] = low;
    reg32s[EDX] = high;
}

void instr_0F33() {
    // rdpmc
    undefined_instruction();
}

void instr_0F34() {
    // sysenter
    int32_t seg = sysenter_cs[0] & 0xFFFC;

    if(!protected_mode[0] || seg == 0)
    {
        trigger_gp_non_raising(0);
        return;
    }

    if(CPU_LOG_VERBOSE)
    {
        //dbg_log("sysenter  cs:eip=" + h(seg    , 4) + ":" + h(sysenter_eip[0], 8) +
        //                 " ss:esp=" + h(seg + 8, 4) + ":" + h(sysenter_esp[0], 8));
    }

    flags[0] &= ~FLAG_VM & ~FLAG_INTERRUPT;

    instruction_pointer[0] = sysenter_eip[0];
    reg32s[ESP] = sysenter_esp[0];

    sreg[CS] = seg;
    segment_is_null[CS] = 0;
    segment_limits[CS] = -1;
    segment_offsets[CS] = 0;

    update_cs_size(true);

    cpl[0] = 0;
    cpl_changed();

    sreg[SS] = seg + 8;
    segment_is_null[SS] = 0;
    segment_limits[SS] = -1;
    segment_offsets[SS] = 0;

    stack_size_32[0] = true;
}

void instr_0F35() {
    // sysexit
    int32_t seg = sysenter_cs[0] & 0xFFFC;

    if(!protected_mode[0] || cpl[0] || seg == 0)
    {
        trigger_gp_non_raising(0);
        return;
    }

    if(CPU_LOG_VERBOSE)
    {
        //dbg_log("sysexit  cs:eip=" + h(seg + 16, 4) + ":" + h(reg32s[EDX], 8) +
        //                 " ss:esp=" + h(seg + 24, 4) + ":" + h(reg32s[ECX], 8));
    }

    instruction_pointer[0] = reg32s[EDX];
    reg32s[ESP] = reg32s[ECX];

    sreg[CS] = seg + 16 | 3;

    segment_is_null[CS] = 0;
    segment_limits[CS] = -1;
    segment_offsets[CS] = 0;

    update_cs_size(true);

    cpl[0] = 3;
    cpl_changed();

    sreg[SS] = seg + 24 | 3;
    segment_is_null[SS] = 0;
    segment_limits[SS] = -1;
    segment_offsets[SS] = 0;

    stack_size_32[0] = true;
}

void instr_0F36() { undefined_instruction(); }

void instr_0F37() {
    // getsec
    undefined_instruction();
}

// sse3+
void instr_0F38() { unimplemented_sse(); }
void instr_0F39() { unimplemented_sse(); }
void instr_0F3A() { unimplemented_sse(); }
void instr_0F3B() { unimplemented_sse(); }
void instr_0F3C() { unimplemented_sse(); }
void instr_0F3D() { unimplemented_sse(); }
void instr_0F3E() { unimplemented_sse(); }
void instr_0F3F() { unimplemented_sse(); }


// cmov
DEFINE_MODRM_INSTR_READ16(instr16_0F40, cmovcc16( test_o(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F40, cmovcc32( test_o(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F41, cmovcc16(!test_o(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F41, cmovcc32(!test_o(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F42, cmovcc16( test_b(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F42, cmovcc32( test_b(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F43, cmovcc16(!test_b(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F43, cmovcc32(!test_b(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F44, cmovcc16( test_z(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F44, cmovcc32( test_z(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F45, cmovcc16(!test_z(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F45, cmovcc32(!test_z(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F46, cmovcc16( test_be(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F46, cmovcc32( test_be(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F47, cmovcc16(!test_be(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F47, cmovcc32(!test_be(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F48, cmovcc16( test_s(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F48, cmovcc32( test_s(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F49, cmovcc16(!test_s(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F49, cmovcc32(!test_s(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F4A, cmovcc16( test_p(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F4A, cmovcc32( test_p(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F4B, cmovcc16(!test_p(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F4B, cmovcc32(!test_p(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F4C, cmovcc16( test_l(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F4C, cmovcc32( test_l(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F4D, cmovcc16(!test_l(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F4D, cmovcc32(!test_l(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F4E, cmovcc16( test_le(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F4E, cmovcc32( test_le(), ___, r))
DEFINE_MODRM_INSTR_READ16(instr16_0F4F, cmovcc16(!test_le(), ___, r))
DEFINE_MODRM_INSTR_READ32(instr32_0F4F, cmovcc32(!test_le(), ___, r))


void instr_0F50_reg(int32_t r1, int32_t r2) {
    // movmskps r, xmm
    union reg128 source = read_xmm128s(r1);
    int32_t data = source.u32[0] >> 31 | (source.u32[1] >> 31) << 1 |
        (source.u32[2] >> 31) << 2 | (source.u32[3] >> 31) << 3;
    write_reg32(r2, data);
}
void instr_0F50_mem(int32_t addr, int32_t r1) { trigger_ud(); }

void instr_660F50_reg(int32_t r1, int32_t r2) {
    // movmskpd r, xmm
    union reg128 source = read_xmm128s(r1);
    int32_t data = (source.u32[1] >> 31) | (source.u32[3] >> 31) << 1;
    write_reg32(r2, data);
}
void instr_660F50_mem(int32_t addr, int32_t r1) { trigger_ud(); }

void instr_0F51(union reg128 source, int32_t r) {
    // sqrtps xmm, xmm/mem128
    union reg128 result = {
        .f32 = {
            sqrtf(source.f32[0]),
            sqrtf(source.f32[1]),
            sqrtf(source.f32[2]),
            sqrtf(source.f32[3]),
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_0F51, safe_read128s, read_xmm128s)
void instr_660F51(union reg128 source, int32_t r) {
    // sqrtpd xmm, xmm/mem128
    union reg128 result = {
        .f64 = {
            sqrt(source.f64[0]),
            sqrt(source.f64[1]),
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660F51, safe_read128s, read_xmm128s)
void instr_F20F51(union reg64 source, int32_t r) {
    // sqrtsd xmm, xmm/mem64
    union reg64 result = {
        .f64 = { sqrt(source.f64[0]), }
    };
    write_xmm64(r, result);
}
DEFINE_SSE_SPLIT(instr_F20F51, safe_read64s, read_xmm64s)
void instr_F30F51(float_t source, int32_t r) {
    // sqrtss xmm, xmm/mem32
    write_xmm_f32(r, sqrtf(source));
}
DEFINE_SSE_SPLIT(instr_F30F51, fpu_load_m32, read_xmm_f32)

void instr_0F52() { unimplemented_sse(); }

void instr_0F53(union reg128 source, int32_t r) {
    // rcpps xmm, xmm/m128
    union reg128 result = {
        .f32 = {
            1 / source.f32[0],
            1 / source.f32[1],
            1 / source.f32[2],
            1 / source.f32[3],
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_0F53, safe_read128s, read_xmm128s)

void instr_F30F53(float_t source, int32_t r) {
    // rcpss xmm, xmm/m32
    write_xmm_f32(r, 1 / source);
}
DEFINE_SSE_SPLIT(instr_F30F53, fpu_load_m32, read_xmm_f32)

void instr_0F54(union reg128 source, int32_t r) {
    // andps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pand_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_0F54, safe_read128s, read_xmm128s)

void instr_660F54(union reg128 source, int32_t r) {
    // andpd xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pand_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_660F54, safe_read128s, read_xmm128s)

void instr_0F55(union reg128 source, int32_t r) {
    // andnps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pandn_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_0F55, safe_read128s, read_xmm128s)

void instr_660F55(union reg128 source, int32_t r) {
    // andnpd xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pandn_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_660F55, safe_read128s, read_xmm128s)

void instr_0F56(union reg128 source, int32_t r) {
    // orps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    por_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_0F56, safe_read128s, read_xmm128s)

void instr_660F56(union reg128 source, int32_t r) {
    // orpd xmm, xmm/mem128
    // XXX: Aligned access or #gp
    por_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_660F56, safe_read128s, read_xmm128s)

void instr_0F57(union reg128 source, int32_t r) {
    // xorps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pxor_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_0F57, safe_read128s, read_xmm128s)

void instr_660F57(union reg128 source, int32_t r) {
    // xorpd xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pxor_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_660F57, safe_read128s, read_xmm128s)

void instr_0F58(union reg128 source, int32_t r) {
    // addps xmm, xmm/mem128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .f32 = {
            source.f32[0] + destination.f32[0],
            source.f32[1] + destination.f32[1],
            source.f32[2] + destination.f32[2],
            source.f32[3] + destination.f32[3],
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_0F58, safe_read128s, read_xmm128s)
void instr_660F58(union reg128 source, int32_t r) {
    // addpd xmm, xmm/mem128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .f64 = {
            source.f64[0] + destination.f64[0],
            source.f64[1] + destination.f64[1],
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660F58, safe_read128s, read_xmm128s)
void instr_F20F58(union reg64 source, int32_t r) {
    // addsd xmm, xmm/mem64
    union reg64 destination = read_xmm64s(r);
    union reg64 result = {
        .f64 = { source.f64[0] + destination.f64[0], }
    };
    write_xmm64(r, result);
}
DEFINE_SSE_SPLIT(instr_F20F58, safe_read64s, read_xmm64s)
void instr_F30F58(float_t source, int32_t r) {
    // addss xmm, xmm/mem32
    float_t destination = read_xmm_f32(r);
    float result = source + destination;
    write_xmm_f32(r, result);
}
DEFINE_SSE_SPLIT(instr_F30F58, fpu_load_m32, read_xmm_f32)

void instr_0F59(union reg128 source, int32_t r) {
    // mulps xmm, xmm/mem128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .f32 = {
            source.f32[0] * destination.f32[0],
            source.f32[1] * destination.f32[1],
            source.f32[2] * destination.f32[2],
            source.f32[3] * destination.f32[3],
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_0F59, safe_read128s, read_xmm128s)
void instr_660F59(union reg128 source, int32_t r) {
    // mulpd xmm, xmm/mem128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .f64 = {
            source.f64[0] * destination.f64[0],
            source.f64[1] * destination.f64[1],
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660F59, safe_read128s, read_xmm128s)
void instr_F20F59(union reg64 source, int32_t r) {
    // mulsd xmm, xmm/mem64
    union reg64 destination = read_xmm64s(r);
    union reg64 result = {
        .f64 = { source.f64[0] * destination.f64[0], }
    };
    write_xmm64(r, result);
}
DEFINE_SSE_SPLIT(instr_F20F59, safe_read64s, read_xmm64s)
void instr_F30F59(float_t source, int32_t r) {
    // mulss xmm, xmm/mem32
    float_t destination = read_xmm_f32(r);
    float result = source * destination;
    write_xmm_f32(r, result);
}
DEFINE_SSE_SPLIT(instr_F30F59, fpu_load_m32, read_xmm_f32)

void instr_0F5A() { unimplemented_sse(); }
void instr_0F5B() { unimplemented_sse(); }

void instr_0F5C(union reg128 source, int32_t r) {
    // subps xmm, xmm/mem128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .f32 = {
            destination.f32[0] - source.f32[0],
            destination.f32[1] - source.f32[1],
            destination.f32[2] - source.f32[2],
            destination.f32[3] - source.f32[3],
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_0F5C, safe_read128s, read_xmm128s)
void instr_660F5C(union reg128 source, int32_t r) {
    // subpd xmm, xmm/mem128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .f64 = {
            destination.f64[0] - source.f64[0],
            destination.f64[1] - source.f64[1],
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660F5C, safe_read128s, read_xmm128s)
void instr_F20F5C(union reg64 source, int32_t r) {
    // subsd xmm, xmm/mem64
    union reg64 destination = read_xmm64s(r);
    union reg64 result = {
        .f64 = { destination.f64[0] - source.f64[0], }
    };
    write_xmm64(r, result);
}
DEFINE_SSE_SPLIT(instr_F20F5C, safe_read64s, read_xmm64s)
void instr_F30F5C(float_t source, int32_t r) {
    // subss xmm, xmm/mem32
    float_t destination = read_xmm_f32(r);
    float result = destination - source;
    write_xmm_f32(r, result);
}
DEFINE_SSE_SPLIT(instr_F30F5C, fpu_load_m32, read_xmm_f32)

void instr_0F5D(union reg128 source, int32_t r) {
    // minps xmm, xmm/mem128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .f32 = {
            sse_min(destination.f32[0], source.f32[0]),
            sse_min(destination.f32[1], source.f32[1]),
            sse_min(destination.f32[2], source.f32[2]),
            sse_min(destination.f32[3], source.f32[3]),
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_0F5D, safe_read128s, read_xmm128s)
void instr_660F5D(union reg128 source, int32_t r) {
    // minpd xmm, xmm/mem128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .f64 = {
            sse_min(destination.f64[0], source.f64[0]),
            sse_min(destination.f64[1], source.f64[1]),
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660F5D, safe_read128s, read_xmm128s)
void instr_F20F5D(union reg64 source, int32_t r) {
    // minsd xmm, xmm/mem64
    union reg64 destination = read_xmm64s(r);
    union reg64 result = {
        .f64 = { sse_min(destination.f64[0], source.f64[0]), }
    };
    write_xmm64(r, result);
}
DEFINE_SSE_SPLIT(instr_F20F5D, safe_read64s, read_xmm64s)
void instr_F30F5D(float_t source, int32_t r) {
    // minss xmm, xmm/mem32
    float_t destination = read_xmm_f32(r);
    float result = sse_min(destination, source);
    write_xmm_f32(r, result);
}
DEFINE_SSE_SPLIT(instr_F30F5D, fpu_load_m32, read_xmm_f32)

void instr_0F5E(union reg128 source, int32_t r) {
    // divps xmm, xmm/mem128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .f32 = {
            destination.f32[0] / source.f32[0],
            destination.f32[1] / source.f32[1],
            destination.f32[2] / source.f32[2],
            destination.f32[3] / source.f32[3],
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_0F5E, safe_read128s, read_xmm128s)
void instr_660F5E(union reg128 source, int32_t r) {
    // divpd xmm, xmm/mem128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .f64 = {
            destination.f64[0] / source.f64[0],
            destination.f64[1] / source.f64[1],
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660F5E, safe_read128s, read_xmm128s)
void instr_F20F5E(union reg64 source, int32_t r) {
    // divsd xmm, xmm/mem64
    union reg64 destination = read_xmm64s(r);
    union reg64 result = {
        .f64 = { destination.f64[0] / source.f64[0], }
    };
    write_xmm64(r, result);
}
DEFINE_SSE_SPLIT(instr_F20F5E, safe_read64s, read_xmm64s)
void instr_F30F5E(float_t source, int32_t r) {
    // divss xmm, xmm/mem32
    float_t destination = read_xmm_f32(r);
    float result = destination / source;
    write_xmm_f32(r, result);
}
DEFINE_SSE_SPLIT(instr_F30F5E, fpu_load_m32, read_xmm_f32)

void instr_0F5F(union reg128 source, int32_t r) {
    // maxps xmm, xmm/mem128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .f32 = {
            sse_max(destination.f32[0], source.f32[0]),
            sse_max(destination.f32[1], source.f32[1]),
            sse_max(destination.f32[2], source.f32[2]),
            sse_max(destination.f32[3], source.f32[3]),
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_0F5F, safe_read128s, read_xmm128s)
void instr_660F5F(union reg128 source, int32_t r) {
    // maxpd xmm, xmm/mem128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .f64 = {
            sse_max(destination.f64[0], source.f64[0]),
            sse_max(destination.f64[1], source.f64[1]),
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660F5F, safe_read128s, read_xmm128s)
void instr_F20F5F(union reg64 source, int32_t r) {
    // maxsd xmm, xmm/mem64
    union reg64 destination = read_xmm64s(r);
    union reg64 result = {
        .f64 = { sse_max(destination.f64[0], source.f64[0]), }
    };
    write_xmm64(r, result);
}
DEFINE_SSE_SPLIT(instr_F20F5F, safe_read64s, read_xmm64s)
void instr_F30F5F(float_t source, int32_t r) {
    // maxss xmm, xmm/mem32
    float_t destination = read_xmm_f32(r);
    float result = sse_max(destination, source);
    write_xmm_f32(r, result);
}
DEFINE_SSE_SPLIT(instr_F30F5F, fpu_load_m32, read_xmm_f32)


void instr_0F60(int32_t source, int32_t r) {
    // punpcklbw mm, mm/m32
    union reg64 destination = read_mmx64s(r);

    int32_t byte0 = destination.u8[0];
    int32_t byte1 = source & 0xFF;
    int32_t byte2 = destination.u8[1];
    int32_t byte3 = (source >> 8) & 0xFF;
    int32_t byte4 = destination.u8[2];
    int32_t byte5 = (source >> 16) & 0xFF;
    int32_t byte6 = destination.u8[3];
    int32_t byte7 = source >> 24;

    int32_t low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
    int32_t high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0F60, safe_read32s, read_mmx32s)

void instr_660F60(union reg64 source, int32_t r) {
    // punpcklbw xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg64 destination = read_xmm64s(r);
    write_xmm128(
        r,
        destination.u8[0] | source.u8[0] << 8 | destination.u8[1] << 16 | source.u8[1] << 24,
        destination.u8[2] | source.u8[2] << 8 | destination.u8[3] << 16 | source.u8[3] << 24,
        destination.u8[4] | source.u8[4] << 8 | destination.u8[5] << 16 | source.u8[5] << 24,
        destination.u8[6] | source.u8[6] << 8 | destination.u8[7] << 16 | source.u8[7] << 24
    );
}
DEFINE_SSE_SPLIT(instr_660F60, safe_read64s, read_xmm64s)

void instr_0F61(int32_t source, int32_t r) {
    // punpcklwd mm, mm/m32
    union reg64 destination = read_mmx64s(r);

    int32_t word0 = destination.u16[0];
    int32_t word1 = source & 0xFFFF;
    int32_t word2 = destination.u16[1];
    int32_t word3 = source >> 16;

    int32_t low = word0 | word1 << 16;
    int32_t high = word2 | word3 << 16;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0F61, safe_read32s, read_mmx32s)

void instr_660F61(union reg64 source, int32_t r) {
    // punpcklwd xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg64 destination = read_xmm64s(r);
    write_xmm128(
        r,
        destination.u16[0] | source.u16[0] << 16,
        destination.u16[1] | source.u16[1] << 16,
        destination.u16[2] | source.u16[2] << 16,
        destination.u16[3] | source.u16[3] << 16
    );
}
DEFINE_SSE_SPLIT(instr_660F61, safe_read64s, read_xmm64s)

void instr_0F62(int32_t source, int32_t r) {
    // punpckldq mm, mm/m32
    union reg64 destination = read_mmx64s(r);
    write_mmx64(r, destination.u32[0], source);
}
DEFINE_SSE_SPLIT(instr_0F62, safe_read32s, read_mmx32s)

void instr_660F62(union reg128 source, int32_t r) {
    // punpckldq xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32[0],
        source.u32[0],
        destination.u32[1],
        source.u32[1]
    );
}
DEFINE_SSE_SPLIT(instr_660F62, safe_read128s, read_xmm128s)

void instr_0F63(union reg64 source, int32_t r) {
    // packsswb mm, mm/m64
    union reg64 destination = read_mmx64s(r);

    int32_t low = saturate_sw_to_sb(destination.u16[0]) |
        saturate_sw_to_sb(destination.u16[1]) << 8 |
        saturate_sw_to_sb(destination.u16[2]) << 16 |
        saturate_sw_to_sb(destination.u16[3]) << 24;

    int32_t high = saturate_sw_to_sb(source.u16[0]) |
        saturate_sw_to_sb(source.u16[1]) << 8 |
        saturate_sw_to_sb(source.u16[2]) << 16 |
        saturate_sw_to_sb(source.u16[3]) << 24;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0F63, safe_read64s, read_mmx64s)

void instr_660F63(union reg128 source, int32_t r) {
    // packsswb xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    int32_t dword0 = saturate_sw_to_sb(destination.u16[0]) |
        saturate_sw_to_sb(destination.u16[1]) << 8 |
        saturate_sw_to_sb(destination.u16[2]) << 16 |
        saturate_sw_to_sb(destination.u16[3]) << 24;

    int32_t dword1 = saturate_sw_to_sb(destination.u16[4]) |
        saturate_sw_to_sb(destination.u16[5]) << 8 |
        saturate_sw_to_sb(destination.u16[6]) << 16 |
        saturate_sw_to_sb(destination.u16[7]) << 24;

    int32_t dword2 = saturate_sw_to_sb(source.u16[0]) |
        saturate_sw_to_sb(source.u16[1]) << 8 |
        saturate_sw_to_sb(source.u16[2]) << 16 |
        saturate_sw_to_sb(source.u16[3]) << 24;

    int32_t dword3 = saturate_sw_to_sb(source.u16[4]) |
        saturate_sw_to_sb(source.u16[5]) << 8 |
        saturate_sw_to_sb(source.u16[6]) << 16 |
        saturate_sw_to_sb(source.u16[7]) << 24;

    write_xmm128(r, dword0, dword1, dword2, dword3);
}
DEFINE_SSE_SPLIT(instr_660F63, safe_read128s, read_xmm128s)

void instr_0F64(union reg64 source, int32_t r) {
    // pcmpgtb mm, mm/m64
    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    for(uint32_t i = 0; i < 8; i++)
    {
        result.u8[i] = destination.i8[i] > source.i8[i] ? 0xFF : 0;
    }

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0F64, safe_read64s, read_mmx64s)

void instr_660F64(union reg128 source, int32_t r) {
    // pcmpgtb xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);
    union reg128 result = { { 0 } };

    for(int32_t i = 0; i < 16; i++)
    {
        result.i8[i] = destination.i8[i] > source.i8[i] ? 0xFF : 0;
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660F64, safe_read128s, read_xmm128s)

void instr_0F65(union reg64 source, int32_t r) {
    // pcmpgtw mm, mm/m64
    union reg64 destination = read_mmx64s(r);

    int32_t word0 = destination.i16[0] > source.i16[0] ? 0xFFFF : 0;
    int32_t word1 = destination.i16[1] > source.i16[1] ? 0xFFFF : 0;
    int32_t word2 = destination.i16[2] > source.i16[2] ? 0xFFFF : 0;
    int32_t word3 = destination.i16[3] > source.i16[3] ? 0xFFFF : 0;

    int32_t low = word0 | word1 << 16;
    int32_t high = word2 | word3 << 16;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0F65, safe_read64s, read_mmx64s)

void instr_660F65(union reg128 source, int32_t r) {
    // pcmpgtw xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);
    union reg128 result = { { 0 } };

    for(int32_t i = 0; i < 8; i++)
    {
        result.u16[i] = destination.i16[i] > source.i16[i] ? 0xFFFF : 0;
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660F65, safe_read128s, read_xmm128s)

void instr_0F66(union reg64 source, int32_t r) {
    // pcmpgtd mm, mm/m64
    union reg64 destination = read_mmx64s(r);

    int32_t low = destination.i32[0] > source.i32[0] ? -1 : 0;
    int32_t high = destination.i32[1] > source.i32[1] ? -1 : 0;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0F66, safe_read64s, read_mmx64s)

void instr_660F66(union reg128 source, int32_t r) {
    // pcmpgtd xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    write_xmm128(
        r,
        destination.i32[0] > source.i32[0] ? -1 : 0,
        destination.i32[1] > source.i32[1] ? -1 : 0,
        destination.i32[2] > source.i32[2] ? -1 : 0,
        destination.i32[3] > source.i32[3] ? -1 : 0
    );
}
DEFINE_SSE_SPLIT(instr_660F66, safe_read128s, read_xmm128s)

void instr_0F67(union reg64 source, int32_t r) {
    // packuswb mm, mm/m64
    union reg64 destination = read_mmx64s(r);

    uint32_t low = saturate_sw_to_ub(destination.u16[0]) |
        saturate_sw_to_ub(destination.u16[1]) << 8 |
        saturate_sw_to_ub(destination.u16[2]) << 16 |
        saturate_sw_to_ub(destination.u16[3]) << 24;

    uint32_t high = saturate_sw_to_ub(source.u16[0]) |
        saturate_sw_to_ub(source.u16[1]) << 8 |
        saturate_sw_to_ub(source.u16[2]) << 16 |
        saturate_sw_to_ub(source.u16[3]) << 24;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0F67, safe_read64s, read_mmx64s)

void instr_660F67(union reg128 source, int32_t r) {
    // packuswb xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);
    union reg128 result;

    for(int32_t i = 0; i < 8; i++)
    {
        result.u8[i] = saturate_sw_to_ub(destination.u16[i]);
        result.u8[i | 8] = saturate_sw_to_ub(source.u16[i]);
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660F67, safe_read128s, read_xmm128s)


void instr_0F68(union reg64 source, int32_t r) {
    // punpckhbw mm, mm/m64
    union reg64 destination = read_mmx64s(r);

    int32_t byte0 = destination.u8[4];
    int32_t byte1 = source.u8[4];
    int32_t byte2 = destination.u8[5];
    int32_t byte3 = source.u8[5];
    int32_t byte4 = destination.u8[6];
    int32_t byte5 = source.u8[6];
    int32_t byte6 = destination.u8[7];
    int32_t byte7 = source.u8[7];

    int32_t low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
    int32_t high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0F68, safe_read64s, read_mmx64s)

void instr_660F68(union reg128 source, int32_t r) {
    // punpckhbw xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    write_xmm128(
        r,
        destination.u8[ 8] | source.u8[ 8] << 8 | destination.u8[ 9] << 16 | source.u8[ 9] << 24,
        destination.u8[10] | source.u8[10] << 8 | destination.u8[11] << 16 | source.u8[11] << 24,
        destination.u8[12] | source.u8[12] << 8 | destination.u8[13] << 16 | source.u8[13] << 24,
        destination.u8[14] | source.u8[14] << 8 | destination.u8[15] << 16 | source.u8[15] << 24
    );
}
DEFINE_SSE_SPLIT(instr_660F68, safe_read128s, read_xmm128s)

void instr_0F69(union reg64 source, int32_t r) {
    // punpckhwd mm, mm/m64
    union reg64 destination = read_mmx64s(r);

    int32_t word0 = destination.u16[2];
    int32_t word1 = source.u16[2];
    int32_t word2 = destination.u16[3];
    int32_t word3 = source.u16[3];

    int32_t low = word0 | word1 << 16;
    int32_t high = word2 | word3 << 16;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0F69, safe_read64s, read_mmx64s)

void instr_660F69(union reg128 source, int32_t r) {
    // punpckhwd xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    int32_t dword0 = destination.u16[4] | source.u16[4] << 16;
    int32_t dword1 = destination.u16[5] | source.u16[5] << 16;
    int32_t dword2 = destination.u16[6] | source.u16[6] << 16;
    int32_t dword3 = destination.u16[7] | source.u16[7] << 16;

    write_xmm128(r, dword0, dword1, dword2, dword3);
}
DEFINE_SSE_SPLIT(instr_660F69, safe_read128s, read_xmm128s)

void instr_0F6A(union reg64 source, int32_t r) {
    // punpckhdq mm, mm/m64
    union reg64 destination = read_mmx64s(r);
    write_mmx64(r, destination.u32[1], source.u32[1]);
}
DEFINE_SSE_SPLIT(instr_0F6A, safe_read64s, read_mmx64s)

void instr_660F6A(union reg128 source, int32_t r) {
    // punpckhdq xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);
    write_xmm128(r, destination.u32[2], source.u32[2], destination.u32[3], source.u32[3]);
}
DEFINE_SSE_SPLIT(instr_660F6A, safe_read128s, read_xmm128s)

void instr_0F6B(union reg64 source, int32_t r) {
    // packssdw mm, mm/m64
    union reg64 destination = read_mmx64s(r);

    int32_t low = saturate_sd_to_sw(destination.u32[0]) |
        saturate_sd_to_sw(destination.u32[1]) << 16;
    int32_t high = saturate_sd_to_sw(source.u32[0]) |
        saturate_sd_to_sw(source.u32[1]) << 16;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0F6B, safe_read64s, read_mmx64s)

void instr_660F6B(union reg128 source, int32_t r) {
    // packssdw xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    int32_t dword0 = saturate_sd_to_sw(destination.u32[0]) |
        saturate_sd_to_sw(destination.u32[1]) << 16;
    int32_t dword1 = saturate_sd_to_sw(destination.u32[2]) |
        saturate_sd_to_sw(destination.u32[3]) << 16;
    int32_t dword2 = saturate_sd_to_sw(source.u32[0]) |
        saturate_sd_to_sw(source.u32[1]) << 16;
    int32_t dword3 = saturate_sd_to_sw(source.u32[2]) |
        saturate_sd_to_sw(source.u32[3]) << 16;

    write_xmm128(r, dword0, dword1, dword2, dword3);
}
DEFINE_SSE_SPLIT(instr_660F6B, safe_read128s, read_xmm128s)

void instr_0F6C_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_0F6C_reg(int32_t r1, int32_t r2) { trigger_ud(); }

void instr_660F6C(union reg128 source, int32_t r) {
    // punpcklqdq xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    write_xmm128(r, destination.u32[0], destination.u32[1], source.u32[0], source.u32[1]);
}
DEFINE_SSE_SPLIT(instr_660F6C, safe_read128s, read_xmm128s)

void instr_0F6D_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_0F6D_reg(int32_t r1, int32_t r2) { trigger_ud(); }

void instr_660F6D(union reg128 source, int32_t r) {
    // punpckhqdq xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    write_xmm128(r, destination.u32[2], destination.u32[3], source.u32[2], source.u32[3]);
}
DEFINE_SSE_SPLIT(instr_660F6D, safe_read128s, read_xmm128s)

void instr_0F6E(int32_t source, int32_t r) {
    // movd mm, r/m32
    write_mmx64(r, source, 0);
}
DEFINE_SSE_SPLIT(instr_0F6E, safe_read32s, read_reg32)

void instr_660F6E(int32_t source, int32_t r) {
    // movd mm, r/m32
    write_xmm128(r, source, 0, 0, 0);
}
DEFINE_SSE_SPLIT(instr_660F6E, safe_read32s, read_reg32)

void instr_0F6F(union reg64 source, int32_t r) {
    // movq mm, mm/m64
    write_mmx64(r, source.u32[0], source.u32[1]);
}
DEFINE_SSE_SPLIT(instr_0F6F, safe_read64s, read_mmx64s)

void instr_660F6F(union reg128 source, int32_t r) {
    // movdqa xmm, xmm/mem128
    // XXX: Aligned access or #gp
    // XXX: Aligned read or #gp
    mov_rm_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_660F6F, safe_read128s, read_xmm128s)
void instr_F30F6F(union reg128 source, int32_t r) {
    // movdqu xmm, xmm/m128
    mov_rm_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_F30F6F, safe_read128s, read_xmm128s)

void instr_0F70(union reg64 source, int32_t r, int32_t imm8) {
    // pshufw mm1, mm2/m64, imm8

    int32_t word0_shift = imm8 & 0b11;
    uint32_t word0 = source.u32[word0_shift >> 1] >> ((word0_shift & 1) << 4) & 0xFFFF;
    int32_t word1_shift = (imm8 >> 2) & 0b11;
    uint32_t word1 = source.u32[word1_shift >> 1] >> ((word1_shift & 1) << 4);
    int32_t low = word0 | word1 << 16;

    int32_t word2_shift = (imm8 >> 4) & 0b11;
    uint32_t word2 = source.u32[word2_shift >> 1] >> ((word2_shift & 1) << 4) & 0xFFFF;
    uint32_t word3_shift = (imm8 >> 6);
    uint32_t word3 = source.u32[word3_shift >> 1] >> ((word3_shift & 1) << 4);
    int32_t high = word2 | word3 << 16;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT_IMM(instr_0F70, safe_read64s, read_mmx64s)

void instr_660F70(union reg128 source, int32_t r, int32_t imm8) {
    // pshufd xmm, xmm/mem128
    // XXX: Aligned access or #gp
    write_xmm128(
        r,
        source.u32[imm8 & 3],
        source.u32[imm8 >> 2 & 3],
        source.u32[imm8 >> 4 & 3],
        source.u32[imm8 >> 6 & 3]
    );
}
DEFINE_SSE_SPLIT_IMM(instr_660F70, safe_read128s, read_xmm128s)

void instr_F20F70(union reg128 source, int32_t r, int32_t imm8) {
    // pshuflw xmm, xmm/m128, imm8
    // XXX: Aligned access or #gp
    write_xmm128(
        r,
        source.u16[imm8 & 3] | source.u16[imm8 >> 2 & 3] << 16,
        source.u16[imm8 >> 4 & 3] | source.u16[imm8 >> 6 & 3] << 16,
        source.u32[2],
        source.u32[3]
    );
}
DEFINE_SSE_SPLIT_IMM(instr_F20F70, safe_read128s, read_xmm128s)

void instr_F30F70(union reg128 source, int32_t r, int32_t imm8) {
    // pshufhw xmm, xmm/m128, imm8
    // XXX: Aligned access or #gp
    write_xmm128(
        r,
        source.u32[0],
        source.u32[1],
        source.u16[imm8 & 3 | 4] | source.u16[imm8 >> 2 & 3 | 4] << 16,
        source.u16[imm8 >> 4 & 3 | 4] | source.u16[imm8 >> 6 & 3 | 4] << 16
    );
}
DEFINE_SSE_SPLIT_IMM(instr_F30F70, safe_read128s, read_xmm128s)

void instr_0F71_2_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_0F71_4_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_0F71_6_mem(int32_t addr, int32_t r) { trigger_ud(); }

void instr_0F71_2_reg(int32_t r, int32_t imm8) {
    // psrlw mm, imm8
    psrlw_r64(r, imm8);
}

void instr_0F71_4_reg(int32_t r, int32_t imm8) {
    // psraw mm, imm8
    psraw_r64(r, imm8);
}

void instr_0F71_6_reg(int32_t r, int32_t imm8) {
    // psllw mm, imm8
    psllw_r64(r, imm8);
}

void instr_660F71_2_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_660F71_4_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_660F71_6_mem(int32_t addr, int32_t r) { trigger_ud(); }

void instr_660F71_2_reg(int32_t r, int32_t imm8) {
    // psrlw xmm, imm8
    psrlw_r128(r, imm8);
}

void instr_660F71_4_reg(int32_t r, int32_t imm8) {
    // psraw xmm, imm8
    psraw_r128(r, imm8);
}

void instr_660F71_6_reg(int32_t r, int32_t imm8) {
    // psllw xmm, imm8
    psllw_r128(r, imm8);
}

void instr_0F72_2_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_0F72_4_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_0F72_6_mem(int32_t addr, int32_t r) { trigger_ud(); }

void instr_0F72_2_reg(int32_t r, int32_t imm8) {
    // psrld mm, imm8
    psrld_r64(r, imm8);
}

void instr_0F72_4_reg(int32_t r, int32_t imm8) {
    // psrad mm, imm8
    psrad_r64(r, imm8);
}

void instr_0F72_6_reg(int32_t r, int32_t imm8) {
    // pslld mm, imm8
    pslld_r64(r, imm8);
}

void instr_660F72_2_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_660F72_4_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_660F72_6_mem(int32_t addr, int32_t r) { trigger_ud(); }

void instr_660F72_2_reg(int32_t r, int32_t imm8) {
    // psrld xmm, imm8
    psrld_r128(r, imm8);
}

void instr_660F72_4_reg(int32_t r, int32_t imm8) {
    // psrad xmm, imm8
    psrad_r128(r, imm8);
}

void instr_660F72_6_reg(int32_t r, int32_t imm8) {
    // pslld xmm, imm8
    pslld_r128(r, imm8);
}

void instr_0F73_2_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_0F73_6_mem(int32_t addr, int32_t r) { trigger_ud(); }

void instr_0F73_2_reg(int32_t r, int32_t imm8) {
    // psrlq mm, imm8
    psrlq_r64(r, imm8);
}

void instr_0F73_6_reg(int32_t r, int32_t imm8) {
    // psllq mm, imm8
    psllq_r64(r, imm8);
}

void instr_660F73_2_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_660F73_3_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_660F73_6_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_660F73_7_mem(int32_t addr, int32_t r) { trigger_ud(); }

void instr_660F73_2_reg(int32_t r, int32_t imm8) {
    // psrlq xmm, imm8
    psrlq_r128(r, imm8);
}

void instr_660F73_3_reg(int32_t r, int32_t imm8) {
    // psrldq xmm, imm8
    union reg128 destination = read_xmm128s(r);

    if(imm8 == 0)
    {
        return;
    }

    union reg128 result = { { 0 } };
    uint32_t shift = imm8 > 15 ? 128 : imm8 << 3;

    if(shift <= 63)
    {
        result.u64[0] = destination.u64[0] >> shift | destination.u64[1] << (64 - shift);
        result.u64[1] = destination.u64[1] >> shift;
    }
    else if(shift <= 127)
    {
        result.u64[0] = destination.u64[1] >> (shift - 64);
        result.u64[1] = 0;
    }

    write_xmm_reg128(r, result);
}

void instr_660F73_6_reg(int32_t r, int32_t imm8) {
    // psllq xmm, imm8
    psllq_r128(r, imm8);
}


void instr_660F73_7_reg(int32_t r, int32_t imm8) {
    // pslldq xmm, imm8
    union reg128 destination = read_xmm128s(r);

    if(imm8 == 0)
    {
        return;
    }

    union reg128 result = { { 0 } };
    uint32_t shift = imm8 > 15 ? 128 : imm8 << 3;

    if(shift <= 63)
    {
        result.u64[0] = destination.u64[0] << shift;
        result.u64[1] = destination.u64[1] << shift | destination.u64[0] >> (64 - shift);
    }
    else if(shift <= 127)
    {
        result.u64[0] = 0;
        result.u64[1] = destination.u64[0] << (shift - 64);
    }

    write_xmm_reg128(r, result);
}

void instr_0F74(union reg64 source, int32_t r) {
    // pcmpeqb mm, mm/m64
    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    for(uint32_t i = 0; i < 8; i++)
    {
        result.u8[i] = destination.i8[i] == source.i8[i] ? 0xFF : 0;
    }

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0F74, safe_read64s, read_mmx64s)

void instr_660F74(union reg128 source, int32_t r) {
    // pcmpeqb xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);
    union reg128 result;

    for(int32_t i = 0; i < 16; i++)
    {
        result.u8[i] = source.u8[i] == destination.u8[i] ? 0xFF : 0;
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660F74, safe_read128s, read_xmm128s)

void instr_0F75(union reg64 source, int32_t r) {
    // pcmpeqw mm, mm/m64
    union reg64 destination = read_mmx64s(r);

    int32_t word0 = destination.u16[0] == source.u16[0] ? 0xFFFF : 0;
    int32_t word1 = destination.u16[1] == source.u16[1] ? 0xFFFF : 0;
    int32_t word2 = destination.u16[2] == source.u16[2] ? 0xFFFF : 0;
    int32_t word3 = destination.u16[3] == source.u16[3] ? 0xFFFF : 0;

    int32_t low = word0 | word1 << 16;
    int32_t high = word2 | word3 << 16;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0F75, safe_read64s, read_mmx64s)

void instr_660F75(union reg128 source, int32_t r) {
    // pcmpeqw xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);
    union reg128 result;

    for(int32_t i = 0; i < 8; i++)
    {
        result.u16[i] = source.u16[i] == destination.u16[i] ? 0xFFFF : 0;
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660F75, safe_read128s, read_xmm128s)

void instr_0F76(union reg64 source, int32_t r) {
    // pcmpeqd mm, mm/m64
    union reg64 destination = read_mmx64s(r);

    int32_t low = destination.u32[0] == source.u32[0] ? -1 : 0;
    int32_t high = destination.u32[1] == source.u32[1] ? -1 : 0;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0F76, safe_read64s, read_mmx64s)

void instr_660F76(union reg128 source, int32_t r) {
    // pcmpeqd xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    write_xmm128(
        r,
        source.u32[0] == destination.u32[0] ? -1 : 0,
        source.u32[1] == destination.u32[1] ? -1 : 0,
        source.u32[2] == destination.u32[2] ? -1 : 0,
        source.u32[3] == destination.u32[3] ? -1 : 0
    );
}
DEFINE_SSE_SPLIT(instr_660F76, safe_read128s, read_xmm128s)

void instr_0F77() {
    // emms
    fpu_set_tag_word(0xFFFF);
}

void instr_0F78() { unimplemented_sse(); }
void instr_0F79() { unimplemented_sse(); }
void instr_0F7A() { unimplemented_sse(); }
void instr_0F7B() { unimplemented_sse(); }
void instr_0F7C() { unimplemented_sse(); }
void instr_0F7D() { unimplemented_sse(); }

int32_t instr_0F7E(int32_t r) {
    // movd r/m32, mm
    union reg64 data = read_mmx64s(r);
    return data.u32[0];
}
DEFINE_SSE_SPLIT_WRITE(instr_0F7E, safe_write32, write_reg32)
int32_t instr_660F7E(int32_t r) {
    // movd r/m32, xmm
    union reg64 data = read_xmm64s(r);
    return data.u32[0];
}
DEFINE_SSE_SPLIT_WRITE(instr_660F7E, safe_write32, write_reg32)
void instr_F30F7E_mem(int32_t addr, int32_t r) {
    // movq xmm, xmm/mem64
    union reg64 data = safe_read64s(addr);
    write_xmm128(r, data.u32[0], data.u32[1], 0, 0);
}
void instr_F30F7E_reg(int32_t r1, int32_t r2) {
    // movq xmm, xmm/mem64
    union reg64 data = read_xmm64s(r1);
    write_xmm128(r2, data.u32[0], data.u32[1], 0, 0);
}

void instr_0F7F_mem(int32_t addr, int32_t r) {
    // movq mm/m64, mm
    mov_r_m64(addr, r);
}
void instr_0F7F_reg(int32_t r1, int32_t r2) {
    // movq mm/m64, mm
    union reg64 data = read_mmx64s(r2);
    write_mmx64(r1, data.u32[0], data.u32[1]);
}
void instr_660F7F_mem(int32_t addr, int32_t r) {
    // movdqa xmm/m128, xmm
    // XXX: Aligned write or #gp
    mov_r_m128(addr, r);
}
void instr_660F7F_reg(int32_t r1, int32_t r2) {
    // movdqa xmm/m128, xmm
    // XXX: Aligned access or #gp
    mov_r_r128(r1, r2);
}
void instr_F30F7F_mem(int32_t addr, int32_t r) {
    // movdqu xmm/m128, xmm
    mov_r_m128(addr, r);
}
void instr_F30F7F_reg(int32_t r1, int32_t r2) {
    // movdqu xmm/m128, xmm
    mov_r_r128(r1, r2);
}

// jmpcc
void instr16_0F80(int32_t imm) { jmpcc16( test_o(), imm); }
void instr32_0F80(int32_t imm) { jmpcc32( test_o(), imm); }
void instr16_0F81(int32_t imm) { jmpcc16(!test_o(), imm); }
void instr32_0F81(int32_t imm) { jmpcc32(!test_o(), imm); }
void instr16_0F82(int32_t imm) { jmpcc16( test_b(), imm); }
void instr32_0F82(int32_t imm) { jmpcc32( test_b(), imm); }
void instr16_0F83(int32_t imm) { jmpcc16(!test_b(), imm); }
void instr32_0F83(int32_t imm) { jmpcc32(!test_b(), imm); }
void instr16_0F84(int32_t imm) { jmpcc16( test_z(), imm); }
void instr32_0F84(int32_t imm) { jmpcc32( test_z(), imm); }
void instr16_0F85(int32_t imm) { jmpcc16(!test_z(), imm); }
void instr32_0F85(int32_t imm) { jmpcc32(!test_z(), imm); }
void instr16_0F86(int32_t imm) { jmpcc16( test_be(), imm); }
void instr32_0F86(int32_t imm) { jmpcc32( test_be(), imm); }
void instr16_0F87(int32_t imm) { jmpcc16(!test_be(), imm); }
void instr32_0F87(int32_t imm) { jmpcc32(!test_be(), imm); }
void instr16_0F88(int32_t imm) { jmpcc16( test_s(), imm); }
void instr32_0F88(int32_t imm) { jmpcc32( test_s(), imm); }
void instr16_0F89(int32_t imm) { jmpcc16(!test_s(), imm); }
void instr32_0F89(int32_t imm) { jmpcc32(!test_s(), imm); }
void instr16_0F8A(int32_t imm) { jmpcc16( test_p(), imm); }
void instr32_0F8A(int32_t imm) { jmpcc32( test_p(), imm); }
void instr16_0F8B(int32_t imm) { jmpcc16(!test_p(), imm); }
void instr32_0F8B(int32_t imm) { jmpcc32(!test_p(), imm); }
void instr16_0F8C(int32_t imm) { jmpcc16( test_l(), imm); }
void instr32_0F8C(int32_t imm) { jmpcc32( test_l(), imm); }
void instr16_0F8D(int32_t imm) { jmpcc16(!test_l(), imm); }
void instr32_0F8D(int32_t imm) { jmpcc32(!test_l(), imm); }
void instr16_0F8E(int32_t imm) { jmpcc16( test_le(), imm); }
void instr32_0F8E(int32_t imm) { jmpcc32( test_le(), imm); }
void instr16_0F8F(int32_t imm) { jmpcc16(!test_le(), imm); }
void instr32_0F8F(int32_t imm) { jmpcc32(!test_le(), imm); }

// setcc
void instr_0F90_reg(int32_t r, int32_t unused) { setcc_reg( test_o(), r); }
void instr_0F91_reg(int32_t r, int32_t unused) { setcc_reg(!test_o(), r); }
void instr_0F92_reg(int32_t r, int32_t unused) { setcc_reg( test_b(), r); }
void instr_0F93_reg(int32_t r, int32_t unused) { setcc_reg(!test_b(), r); }
void instr_0F94_reg(int32_t r, int32_t unused) { setcc_reg( test_z(), r); }
void instr_0F95_reg(int32_t r, int32_t unused) { setcc_reg(!test_z(), r); }
void instr_0F96_reg(int32_t r, int32_t unused) { setcc_reg( test_be(), r); }
void instr_0F97_reg(int32_t r, int32_t unused) { setcc_reg(!test_be(), r); }
void instr_0F98_reg(int32_t r, int32_t unused) { setcc_reg( test_s(), r); }
void instr_0F99_reg(int32_t r, int32_t unused) { setcc_reg(!test_s(), r); }
void instr_0F9A_reg(int32_t r, int32_t unused) { setcc_reg( test_p(), r); }
void instr_0F9B_reg(int32_t r, int32_t unused) { setcc_reg(!test_p(), r); }
void instr_0F9C_reg(int32_t r, int32_t unused) { setcc_reg( test_l(), r); }
void instr_0F9D_reg(int32_t r, int32_t unused) { setcc_reg(!test_l(), r); }
void instr_0F9E_reg(int32_t r, int32_t unused) { setcc_reg( test_le(), r); }
void instr_0F9F_reg(int32_t r, int32_t unused) { setcc_reg(!test_le(), r); }

void instr_0F90_mem(int32_t addr, int32_t unused) { setcc_mem( test_o(), addr); }
void instr_0F91_mem(int32_t addr, int32_t unused) { setcc_mem(!test_o(), addr); }
void instr_0F92_mem(int32_t addr, int32_t unused) { setcc_mem( test_b(), addr); }
void instr_0F93_mem(int32_t addr, int32_t unused) { setcc_mem(!test_b(), addr); }
void instr_0F94_mem(int32_t addr, int32_t unused) { setcc_mem( test_z(), addr); }
void instr_0F95_mem(int32_t addr, int32_t unused) { setcc_mem(!test_z(), addr); }
void instr_0F96_mem(int32_t addr, int32_t unused) { setcc_mem( test_be(), addr); }
void instr_0F97_mem(int32_t addr, int32_t unused) { setcc_mem(!test_be(), addr); }
void instr_0F98_mem(int32_t addr, int32_t unused) { setcc_mem( test_s(), addr); }
void instr_0F99_mem(int32_t addr, int32_t unused) { setcc_mem(!test_s(), addr); }
void instr_0F9A_mem(int32_t addr, int32_t unused) { setcc_mem( test_p(), addr); }
void instr_0F9B_mem(int32_t addr, int32_t unused) { setcc_mem(!test_p(), addr); }
void instr_0F9C_mem(int32_t addr, int32_t unused) { setcc_mem( test_l(), addr); }
void instr_0F9D_mem(int32_t addr, int32_t unused) { setcc_mem(!test_l(), addr); }
void instr_0F9E_mem(int32_t addr, int32_t unused) { setcc_mem( test_le(), addr); }
void instr_0F9F_mem(int32_t addr, int32_t unused) { setcc_mem(!test_le(), addr); }


void instr16_0FA0() { push16(sreg[FS]); }
void instr32_0FA0() { push32(sreg[FS]); }
void instr16_0FA1() {
    if(!switch_seg(FS, safe_read16(get_stack_pointer(0)))) return;
    adjust_stack_reg(2);
}
void instr32_0FA1() {
    if(!switch_seg(FS, safe_read32s(get_stack_pointer(0)) & 0xFFFF)) return;
    adjust_stack_reg(4);
}

void instr_0FA2() { cpuid(); }

void instr16_0FA3_reg(int32_t r1, int32_t r2) { bt_reg(read_reg16(r1), read_reg16(r2) & 15); }
void instr16_0FA3_mem(int32_t addr, int32_t r) { bt_mem(addr, read_reg16(r) << 16 >> 16); }
void instr32_0FA3_reg(int32_t r1, int32_t r2) { bt_reg(read_reg32(r1), read_reg32(r2) & 31); }
void instr32_0FA3_mem(int32_t addr, int32_t r) { bt_mem(addr, read_reg32(r)); }

DEFINE_MODRM_INSTR_IMM_READ_WRITE_16(instr16_0FA4, shld16(___, read_reg16(r), imm & 31))
DEFINE_MODRM_INSTR_IMM_READ_WRITE_32(instr32_0FA4, shld32(___, read_reg32(r), imm & 31))
DEFINE_MODRM_INSTR_READ_WRITE_16(instr16_0FA5, shld16(___, read_reg16(r), reg8[CL] & 31))
DEFINE_MODRM_INSTR_READ_WRITE_32(instr32_0FA5, shld32(___, read_reg32(r), reg8[CL] & 31))

void instr_0FA6() {
    // obsolete cmpxchg (os/2)
    trigger_ud();
}
void instr_0FA7() { undefined_instruction(); }

void instr16_0FA8() { push16(sreg[GS]); }
void instr32_0FA8() { push32(sreg[GS]); }
void instr16_0FA9() {
    if(!switch_seg(GS, safe_read16(get_stack_pointer(0)))) return;
    adjust_stack_reg(2);
}
void instr32_0FA9() {
    if(!switch_seg(GS, safe_read32s(get_stack_pointer(0)) & 0xFFFF)) return;
    adjust_stack_reg(4);
}


void instr_0FAA() {
    // rsm
    undefined_instruction();
}

void instr16_0FAB_reg(int32_t r1, int32_t r2) { write_reg16(r1, bts_reg(read_reg16(r1), read_reg16(r2) & 15)); }
void instr16_0FAB_mem(int32_t addr, int32_t r) { bts_mem(addr, read_reg16(r) << 16 >> 16); }
void instr32_0FAB_reg(int32_t r1, int32_t r2) { write_reg32(r1, bts_reg(read_reg32(r1), read_reg32(r2) & 31)); }
void instr32_0FAB_mem(int32_t addr, int32_t r) { bts_mem(addr, read_reg32(r)); }

DEFINE_MODRM_INSTR_IMM_READ_WRITE_16(instr16_0FAC, shrd16(___, read_reg16(r), imm & 31))
DEFINE_MODRM_INSTR_IMM_READ_WRITE_32(instr32_0FAC, shrd32(___, read_reg32(r), imm & 31))
DEFINE_MODRM_INSTR_READ_WRITE_16(instr16_0FAD, shrd16(___, read_reg16(r), reg8[CL] & 31))
DEFINE_MODRM_INSTR_READ_WRITE_32(instr32_0FAD, shrd32(___, read_reg32(r), reg8[CL] & 31))

void instr_0FAE_0_reg(int32_t r) { trigger_ud(); }
void instr_0FAE_0_mem(int32_t addr) {
    fxsave(addr);
}
void instr_0FAE_1_reg(int32_t r) { trigger_ud(); }
void instr_0FAE_1_mem(int32_t addr) {
    fxrstor(addr);
}
void instr_0FAE_2_reg(int32_t r) { unimplemented_sse(); }
void instr_0FAE_2_mem(int32_t addr) {
    // ldmxcsr
    int32_t new_mxcsr = safe_read32s(addr);
    if(new_mxcsr & ~MXCSR_MASK)
    {
        dbg_log("Invalid mxcsr bits: %x", (new_mxcsr & ~MXCSR_MASK));
        assert(false);
        trigger_gp_non_raising(0);
        return;
    }
    *mxcsr = new_mxcsr;
}
void instr_0FAE_3_reg(int32_t r) { trigger_ud(); }
void instr_0FAE_3_mem(int32_t addr) {
    // stmxcsr
    safe_write32(addr, *mxcsr);
}
void instr_0FAE_4_reg(int32_t r) { trigger_ud(); }
void instr_0FAE_4_mem(int32_t addr) {
    // xsave
    undefined_instruction();
}
void instr_0FAE_5_reg(int32_t r) {
    // lfence
    dbg_assert_message(r == 0, "Unexpected lfence encoding");
}
void instr_0FAE_5_mem(int32_t addr) {
    // xrstor
    undefined_instruction();
}
void instr_0FAE_6_reg(int32_t r) {
    // mfence
    dbg_assert_message(r == 0, "Unexpected mfence encoding");
}
void instr_0FAE_6_mem(int32_t addr) {
    // xsaveopt
    undefined_instruction();
}
void instr_0FAE_7_reg(int32_t r) {
    // sfence
    dbg_assert_message(r == 0, "Unexpected sfence encoding");
}
void instr_0FAE_7_mem(int32_t addr) {
    // clflush
    undefined_instruction();
}

DEFINE_MODRM_INSTR_READ16(instr16_0FAF, write_reg16(r, imul_reg16(read_reg16(r) << 16 >> 16, ___ << 16 >> 16)))
DEFINE_MODRM_INSTR_READ32(instr32_0FAF, write_reg32(r, imul_reg32(read_reg32(r), ___)))

void instr_0FB0_reg(int32_t r1, int32_t r2) {
    // cmpxchg8
    int32_t data = read_reg8(r1);
    cmp8(reg8[AL], data);

    if(getzf())
    {
        write_reg8(r1, read_reg8(r2));
    }
    else
    {
        reg8[AL] = data;
    }
}
void instr_0FB0_mem(int32_t addr, int32_t r) {
    // cmpxchg8
    writable_or_pagefault(addr, 1);
    int32_t data = safe_read8(addr);
    cmp8(reg8[AL], data);

    if(getzf())
    {
        safe_write8(addr, read_reg8(r));
    }
    else
    {
        safe_write8(addr, data);
        reg8[AL] = data;
    }
}

void instr16_0FB1_reg(int32_t r1, int32_t r2) {
    // cmpxchg16
    int32_t data = read_reg16(r1);
    cmp16(reg16[AX], data);

    if(getzf())
    {
        write_reg16(r1, read_reg16(r2));
    }
    else
    {
        reg16[AX] = data;
    }
}
void instr16_0FB1_mem(int32_t addr, int32_t r) {
    // cmpxchg16
    writable_or_pagefault(addr, 2);
    int32_t data = safe_read16(addr);
    cmp16(reg16[AX], data);

    if(getzf())
    {
        safe_write16(addr, read_reg16(r));
    }
    else
    {
        safe_write16(addr, data);
        reg16[AX] = data;
    }
}

void instr32_0FB1_reg(int32_t r1, int32_t r2) {
    // cmpxchg32
    int32_t data = read_reg32(r1);
    cmp32(reg32s[EAX], data);

    if(getzf())
    {
        write_reg32(r1, read_reg32(r2));
    }
    else
    {
        reg32s[EAX] = data;
    }
}
void instr32_0FB1_mem(int32_t addr, int32_t r) {
    // cmpxchg32
    writable_or_pagefault(addr, 4);
    int32_t data = safe_read32s(addr);
    cmp32(reg32s[EAX], data);

    if(getzf())
    {
        safe_write32(addr, read_reg32(r));
    }
    else
    {
        safe_write32(addr, data);
        reg32s[EAX] = data;
    }
}

// lss
void instr16_0FB2_reg(int32_t unused, int32_t unused2) { trigger_ud(); }
void instr16_0FB2_mem(int32_t addr, int32_t r) {
    lss16(addr, get_reg16_index(r), SS);
}
void instr32_0FB2_reg(int32_t unused, int32_t unused2) { trigger_ud(); }
void instr32_0FB2_mem(int32_t addr, int32_t r) {
    lss32(addr, r, SS);
}

void instr16_0FB3_reg(int32_t r1, int32_t r2) { write_reg16(r1, btr_reg(read_reg16(r1), read_reg16(r2) & 15)); }
void instr16_0FB3_mem(int32_t addr, int32_t r) { btr_mem(addr, read_reg16(r) << 16 >> 16); }
void instr32_0FB3_reg(int32_t r1, int32_t r2) { write_reg32(r1, btr_reg(read_reg32(r1), read_reg32(r2) & 31)); }
void instr32_0FB3_mem(int32_t addr, int32_t r) { btr_mem(addr, read_reg32(r)); }

// lfs, lgs
void instr16_0FB4_reg(int32_t unused, int32_t unused2) { trigger_ud(); }
void instr16_0FB4_mem(int32_t addr, int32_t r) {
    lss16(addr, get_reg16_index(r), FS);
}
void instr32_0FB4_reg(int32_t unused, int32_t unused2) { trigger_ud(); }
void instr32_0FB4_mem(int32_t addr, int32_t r) {
    lss32(addr, r, FS);
}
void instr16_0FB5_reg(int32_t unused, int32_t unused2) { trigger_ud(); }
void instr16_0FB5_mem(int32_t addr, int32_t r) {
    lss16(addr, get_reg16_index(r), GS);
}
void instr32_0FB5_reg(int32_t unused, int32_t unused2) { trigger_ud(); }
void instr32_0FB5_mem(int32_t addr, int32_t r) {
    lss32(addr, r, GS);
}

// movzx
DEFINE_MODRM_INSTR_READ8(instr16_0FB6, write_reg16(r, ___))
DEFINE_MODRM_INSTR_READ8(instr32_0FB6, write_reg32(r, ___))
DEFINE_MODRM_INSTR_READ16(instr16_0FB7, write_reg16(r, ___))
DEFINE_MODRM_INSTR_READ16(instr32_0FB7, write_reg32(r, ___))

void instr16_0FB8_reg(int32_t r1, int32_t r2) { trigger_ud(); }
void instr16_0FB8_mem(int32_t addr, int32_t r) { trigger_ud(); }
DEFINE_MODRM_INSTR_READ16(instr16_F30FB8, write_reg16(r, popcnt(___)))

void instr32_0FB8_reg(int32_t r1, int32_t r2) { trigger_ud(); }
void instr32_0FB8_mem(int32_t addr, int32_t r) { trigger_ud(); }
DEFINE_MODRM_INSTR_READ32(instr32_F30FB8, write_reg32(r, popcnt(___)))

void instr_0FB9() {
    // UD2
    trigger_ud();
}

void instr16_0FBA_4_reg(int32_t r, int32_t imm) {
    bt_reg(read_reg16(r), imm & 15);
}
void instr16_0FBA_4_mem(int32_t addr, int32_t imm) {
    bt_mem(addr, imm & 15);
}
void instr16_0FBA_5_reg(int32_t r, int32_t imm) {
    write_reg16(r, bts_reg(read_reg16(r), imm & 15));
}
void instr16_0FBA_5_mem(int32_t addr, int32_t imm) {
    bts_mem(addr, imm & 15);
}
void instr16_0FBA_6_reg(int32_t r, int32_t imm) {
    write_reg16(r, btr_reg(read_reg16(r), imm & 15));
}
void instr16_0FBA_6_mem(int32_t addr, int32_t imm) {
    btr_mem(addr, imm & 15);
}
void instr16_0FBA_7_reg(int32_t r, int32_t imm) {
    write_reg16(r, btc_reg(read_reg16(r), imm & 15));
}
void instr16_0FBA_7_mem(int32_t addr, int32_t imm) {
    btc_mem(addr, imm & 15);
}

void instr32_0FBA_4_reg(int32_t r, int32_t imm) {
    bt_reg(read_reg32(r), imm & 31);
}
void instr32_0FBA_4_mem(int32_t addr, int32_t imm) {
    bt_mem(addr, imm & 31);
}
void instr32_0FBA_5_reg(int32_t r, int32_t imm) {
    write_reg32(r, bts_reg(read_reg32(r), imm & 31));
}
void instr32_0FBA_5_mem(int32_t addr, int32_t imm) {
    bts_mem(addr, imm & 31);
}
void instr32_0FBA_6_reg(int32_t r, int32_t imm) {
    write_reg32(r, btr_reg(read_reg32(r), imm & 31));
}
void instr32_0FBA_6_mem(int32_t addr, int32_t imm) {
    btr_mem(addr, imm & 31);
}
void instr32_0FBA_7_reg(int32_t r, int32_t imm) {
    write_reg32(r, btc_reg(read_reg32(r), imm & 31));
}
void instr32_0FBA_7_mem(int32_t addr, int32_t imm) {
    btc_mem(addr, imm & 31);
}

void instr16_0FBB_reg(int32_t r1, int32_t r2) { write_reg16(r1, btc_reg(read_reg16(r1), read_reg16(r2) & 15)); }
void instr16_0FBB_mem(int32_t addr, int32_t r) { btc_mem(addr, read_reg16(r) << 16 >> 16); }
void instr32_0FBB_reg(int32_t r1, int32_t r2) { write_reg32(r1, btc_reg(read_reg32(r1), read_reg32(r2) & 31)); }
void instr32_0FBB_mem(int32_t addr, int32_t r) { btc_mem(addr, read_reg32(r)); }

DEFINE_MODRM_INSTR_READ16(instr16_0FBC, write_reg16(r, bsf16(read_reg16(r), ___)))
DEFINE_MODRM_INSTR_READ32(instr32_0FBC, write_reg32(r, bsf32(read_reg32(r), ___)))
DEFINE_MODRM_INSTR_READ16(instr16_0FBD, write_reg16(r, bsr16(read_reg16(r), ___)))
DEFINE_MODRM_INSTR_READ32(instr32_0FBD, write_reg32(r, bsr32(read_reg32(r), ___)))

// movsx
DEFINE_MODRM_INSTR_READ8(instr16_0FBE, write_reg16(r, ___ << 24 >> 24))
DEFINE_MODRM_INSTR_READ8(instr32_0FBE, write_reg32(r, ___ << 24 >> 24))
DEFINE_MODRM_INSTR_READ16(instr16_0FBF, write_reg16(r, ___ << 16 >> 16))
DEFINE_MODRM_INSTR_READ16(instr32_0FBF, write_reg32(r, ___ << 16 >> 16))

DEFINE_MODRM_INSTR_READ_WRITE_8(instr_0FC0, xadd8(___, get_reg8_index(r)))
DEFINE_MODRM_INSTR_READ_WRITE_16(instr16_0FC1, xadd16(___, get_reg16_index(r)))
DEFINE_MODRM_INSTR_READ_WRITE_32(instr32_0FC1, xadd32(___, r))

void instr_0FC2(union reg128 source, int32_t r, int32_t imm8) {
    // cmpps xmm, xmm/m128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .i32 = {
            sse_comparison(imm8, destination.f32[0], source.f32[0]) ? -1 : 0,
            sse_comparison(imm8, destination.f32[1], source.f32[1]) ? -1 : 0,
            sse_comparison(imm8, destination.f32[2], source.f32[2]) ? -1 : 0,
            sse_comparison(imm8, destination.f32[3], source.f32[3]) ? -1 : 0,
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT_IMM(instr_0FC2, safe_read128s, read_xmm128s)

void instr_660FC2(union reg128 source, int32_t r, int32_t imm8) {
    // cmppd xmm, xmm/m128
    union reg128 destination = read_xmm128s(r);
    union reg128 result = {
        .i64 = {
            sse_comparison(imm8, destination.f64[0], source.f64[0]) ? -1 : 0,
            sse_comparison(imm8, destination.f64[1], source.f64[1]) ? -1 : 0,
        }
    };
    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT_IMM(instr_660FC2, safe_read128s, read_xmm128s)
void instr_F20FC2(union reg64 source, int32_t r, int32_t imm8) {
    // cmpsd xmm, xmm/m64
    union reg64 destination = read_xmm64s(r);
    union reg64 result = {
        .i64 = { sse_comparison(imm8, destination.f64[0], source.f64[0]) ? -1 : 0, }
    };
    write_xmm64(r, result);
}
DEFINE_SSE_SPLIT_IMM(instr_F20FC2, safe_read64s, read_xmm64s)
void instr_F30FC2(float_t source, int32_t r, int32_t imm8) {
    // cmpss xmm, xmm/m32
    float_t destination = read_xmm_f32(r);
    int32_t result = sse_comparison(imm8, destination, source) ? -1 : 0;
    write_xmm32(r, result);
}
DEFINE_SSE_SPLIT_IMM(instr_F30FC2, fpu_load_m32, read_xmm_f32)

void instr_0FC3_reg(int32_t r1, int32_t r2) { trigger_ud(); }
void instr_0FC3_mem(int32_t addr, int32_t r) {
    // movnti
    safe_write32(addr, read_reg32(r));
}

void instr_0FC4(int32_t source, int32_t r, int32_t imm8) {
    // pinsrw mm, r32/m16, imm8
    union reg64 destination = read_mmx64s(r);

    uint32_t index = imm8 & 3;
    destination.u16[index] = source & 0xffff;

    write_mmx_reg64(r, destination);
}
DEFINE_SSE_SPLIT_IMM(instr_0FC4, safe_read16, read_reg32)

void instr_660FC4(int32_t source, int32_t r, int32_t imm8) {
    // pinsrw xmm, r32/m16, imm8
    union reg128 destination = read_xmm128s(r);

    uint32_t index = imm8 & 7;
    destination.u16[index] = source & 0xffff;

    write_xmm_reg128(r, destination);
}
DEFINE_SSE_SPLIT_IMM(instr_660FC4, safe_read16, read_reg32)

void instr_0FC5_mem(int32_t addr, int32_t r, int32_t imm8) { trigger_ud(); }
void instr_0FC5_reg(int32_t r1, int32_t r2, int32_t imm8) {
    // pextrw r32, mm, imm8

    union reg64 data = read_mmx64s(r1);
    uint32_t index = imm8 & 3;
    uint32_t result = data.u16[index];

    write_reg32(r2, result);
}

void instr_660FC5_mem(int32_t addr, int32_t r, int32_t imm8) { trigger_ud(); }
void instr_660FC5_reg(int32_t r1, int32_t r2, int32_t imm8) {
    // pextrw r32, xmm, imm8

    union reg128 data = read_xmm128s(r1);
    uint32_t index = imm8 & 7;
    uint32_t result = data.u16[index];

    write_reg32(r2, result);
}

void instr_0FC6() { unimplemented_sse(); }

void instr_0FC7_1_reg(int32_t r) { trigger_ud(); }
void instr_0FC7_1_mem(int32_t addr) {
    // cmpxchg8b
    writable_or_pagefault(addr, 8);

    int32_t m64_low = safe_read32s(addr);
    int32_t m64_high = safe_read32s(addr + 4);

    if(reg32s[EAX] == m64_low &&
            reg32s[EDX] == m64_high)
    {
        flags[0] |= FLAG_ZERO;

        safe_write32(addr, reg32s[EBX]);
        safe_write32(addr + 4, reg32s[ECX]);
    }
    else
    {
        flags[0] &= ~FLAG_ZERO;

        reg32s[EAX] = m64_low;
        reg32s[EDX] = m64_high;

        safe_write32(addr, m64_low);
        safe_write32(addr + 4, m64_high);
    }

    flags_changed[0] &= ~FLAG_ZERO;
}

void instr_0FC7_6_reg(int32_t r) {
    // rdrand
    int32_t has_rand = has_rand_int();

    int32_t rand = 0;
    if(has_rand)
    {
        rand = get_rand_int();
    }

    write_reg_osize(r, rand);

    flags[0] &= ~FLAGS_ALL;
    flags[0] |= has_rand;
    flags_changed[0] = 0;
}
void instr_0FC7_6_mem(int32_t addr) {
    trigger_ud();
}

void instr_0FC8() { bswap(EAX); }
void instr_0FC9() { bswap(ECX); }
void instr_0FCA() { bswap(EDX); }
void instr_0FCB() { bswap(EBX); }
void instr_0FCC() { bswap(ESP); }
void instr_0FCD() { bswap(EBP); }
void instr_0FCE() { bswap(ESI); }
void instr_0FCF() { bswap(EDI); }

void instr_0FD0() { unimplemented_sse(); }

void instr_0FD1(union reg64 source, int32_t r) {
    // psrlw mm, mm/m64
    psrlw_r64(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_0FD1, safe_read64s, read_mmx64s)

void instr_660FD1(union reg128 source, int32_t r) {
    // psrlw xmm, xmm/m128
    // XXX: Aligned access or #gp
    psrlw_r128(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_660FD1, safe_read128s, read_xmm128s)

void instr_0FD2(union reg64 source, int32_t r) {
    // psrld mm, mm/m64
    psrld_r64(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_0FD2, safe_read64s, read_mmx64s)

void instr_660FD2(union reg128 source, int32_t r) {
    // psrld xmm, xmm/m128
    // XXX: Aligned access or #gp
    psrld_r128(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_660FD2, safe_read128s, read_xmm128s)

void instr_0FD3(union reg64 source, int32_t r) {
    // psrlq mm, mm/m64
    psrlq_r64(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_0FD3, safe_read64s, read_mmx64s)

void instr_660FD3(union reg128 source, int32_t r) {
    // psrlq xmm, mm/m64
    psrlq_r128(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_660FD3, safe_read128s, read_xmm128s)

void instr_0FD4(union reg64 source, int32_t r) {
    // paddq mm, mm/m64
    union reg64 destination = read_mmx64s(r);
    destination.u64[0] += source.u64[0];
    write_mmx_reg64(r, destination);
}
DEFINE_SSE_SPLIT(instr_0FD4, safe_read64s, read_mmx64s)

void instr_660FD4(union reg128 source, int32_t r) {
    // paddq xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);
    destination.u64[0] += source.u64[0];
    destination.u64[1] += source.u64[1];
    write_xmm_reg128(r, destination);
}
DEFINE_SSE_SPLIT(instr_660FD4, safe_read128s, read_xmm128s)

void instr_0FD5(union reg64 source, int32_t r) {
    // pmullw mm, mm/m64

    union reg64 destination = read_mmx64s(r);

    int32_t word0 = (destination.u16[0] * source.u16[0]) & 0xFFFF;
    int32_t word1 = (destination.u16[1] * source.u16[1]) & 0xFFFF;
    int32_t word2 = (destination.u16[2] * source.u16[2]) & 0xFFFF;
    int32_t word3 = (destination.u16[3] * source.u16[3]) & 0xFFFF;

    int32_t low = word0 | word1 << 16;
    int32_t high = word2 | word3 << 16;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0FD5, safe_read64s, read_mmx64s)

void instr_660FD5(union reg128 source, int32_t r) {
    // pmullw xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    write_xmm128(
        r,
        source.u16[0] * destination.u16[0] & 0xFFFF | source.u16[1] * destination.u16[1] << 16,
        source.u16[2] * destination.u16[2] & 0xFFFF | source.u16[3] * destination.u16[3] << 16,
        source.u16[4] * destination.u16[4] & 0xFFFF | source.u16[5] * destination.u16[5] << 16,
        source.u16[6] * destination.u16[6] & 0xFFFF | source.u16[7] * destination.u16[7] << 16
    );
}
DEFINE_SSE_SPLIT(instr_660FD5, safe_read128s, read_xmm128s)

void instr_0FD6_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_0FD6_reg(int32_t r1, int32_t r2) { trigger_ud(); }

void instr_660FD6_mem(int32_t addr, int32_t r) {
    // movq xmm/m64, xmm
    movl_r128_m64(addr, r);
}
void instr_660FD6_reg(int32_t r1, int32_t r2) {
    // movq xmm/m64, xmm
    union reg64 data = read_xmm64s(r2);
    write_xmm128(r1, data.u32[0], data.u32[1], 0, 0);
}

void instr_F20FD6_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_F20FD6_reg(int32_t r1, int32_t r2) {
    // movdq2q mm, xmm
    union reg128 source = read_xmm128s(r1);
    write_mmx64(r2, source.u32[0], source.u32[1]);
}

void instr_F30FD6_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_F30FD6_reg(int32_t r1, int32_t r2) {
    // movq2dq xmm, mm
    union reg64 source = read_mmx64s(r1);
    write_xmm128(r2, source.u32[0], source.u32[1], 0, 0);
}

void instr_0FD7_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_0FD7_reg(int32_t r1, int32_t r2) {
    // pmovmskb r, mm
    union reg64 x = read_mmx64s(r1);
    uint32_t result =
        x.u8[0] >> 7 << 0 | x.u8[1] >> 7 << 1 | x.u8[2] >> 7 << 2 | x.u8[3] >> 7 << 3 |
        x.u8[4] >> 7 << 4 | x.u8[5] >> 7 << 5 | x.u8[6] >> 7 << 6 | x.u8[7] >> 7 << 7;
    write_reg32(r2, result);
}

void instr_660FD7_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_660FD7_reg(int32_t r1, int32_t r2) {
    // pmovmskb reg, xmm

    union reg128 x = read_xmm128s(r1);
    int32_t result =
        x.u8[0] >> 7 << 0 | x.u8[1] >> 7 << 1 | x.u8[2] >> 7 << 2 | x.u8[3] >> 7 << 3 |
        x.u8[4] >> 7 << 4 | x.u8[5] >> 7 << 5 | x.u8[6] >> 7 << 6 | x.u8[7] >> 7 << 7 |
        x.u8[8] >> 7 << 8 | x.u8[9] >> 7 << 9 | x.u8[10] >> 7 << 10 | x.u8[11] >> 7 << 11 |
        x.u8[12] >> 7 << 12 | x.u8[13] >> 7 << 13 | x.u8[14] >> 7 << 14 | x.u8[15] >> 7 << 15;
    write_reg32(r2, result);
}

void instr_0FD8(union reg64 source, int32_t r) {
    // psubusb mm, mm/m64

    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    for(uint32_t i = 0; i < 8; i++)
    {
        result.u8[i] = saturate_sd_to_ub(destination.u8[i] - source.u8[i]);
    }

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FD8, safe_read64s, read_mmx64s)

void instr_660FD8(union reg128 source, int32_t r) {
    // psubusb xmm, xmm/m128

    union reg128 destination = read_xmm128s(r);
    union reg128 result;

    for(uint32_t i = 0; i < 16; i++)
    {
        result.u8[i] = saturate_sd_to_ub(destination.u8[i] - source.u8[i]);
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FD8, safe_read128s, read_xmm128s)

void instr_0FD9(union reg64 source, int32_t r) {
    // psubusw mm, mm/m64

    union reg64 destination = read_mmx64s(r);

    int32_t word0 = saturate_uw(destination.u16[0] - source.u16[0]);
    int32_t word1 = saturate_uw(destination.u16[1] - source.u16[1]);
    int32_t word2 = saturate_uw(destination.u16[2] - source.u16[2]);
    int32_t word3 = saturate_uw(destination.u16[3] - source.u16[3]);

    int32_t low = word0 | word1 << 16;
    int32_t high = word2 | word3 << 16;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0FD9, safe_read64s, read_mmx64s)

void instr_660FD9(union reg128 source, int32_t r) {
    // psubusw xmm, xmm/m128

    union reg128 destination = read_xmm128s(r);
    union reg128 result;

    for(uint32_t i = 0; i < 8; i++)
    {
        result.u16[i] = saturate_uw(destination.u16[i] - source.u16[i]);
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FD9, safe_read128s, read_xmm128s)

void instr_0FDA(union reg64 source, int32_t r) {
    // pminub mm, mm/m64

    union reg64 destination = read_mmx64s(r);
    union reg64 result;

    for(uint32_t i = 0; i < 8; i++)
    {
        result.u8[i] = source.u8[i] < destination.u8[i] ? source.u8[i] : destination.u8[i];
    }

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FDA, safe_read64s, read_mmx64s)

void instr_660FDA(union reg128 source, int32_t r) {
    // pminub xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);
    union reg128 result;

    for(uint32_t i = 0; i < 16; i++)
    {
        result.u8[i] = source.u8[i] < destination.u8[i] ? source.u8[i] : destination.u8[i];
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FDA, safe_read128s, read_xmm128s)

void instr_0FDB(union reg64 source, int32_t r) {
    // pand mm, mm/m64

    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    result.u64[0] = source.u64[0] & destination.u64[0];

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FDB, safe_read64s, read_mmx64s)

void instr_660FDB(union reg128 source, int32_t r) {
    // pand xmm, xmm/m128
    // XXX: Aligned access or #gp
    pand_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_660FDB, safe_read128s, read_xmm128s)

void instr_0FDC(union reg64 source, int32_t r) {
    // paddusb mm, mm/m64

    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    for(uint32_t i = 0; i < 8; i++)
    {
        result.u8[i] = saturate_ud_to_ub(destination.u8[i] + source.u8[i]);
    }

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FDC, safe_read64s, read_mmx64s)

void instr_660FDC(union reg128 source, int32_t r) {
    // paddusb xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);
    union reg128 result;

    for(uint32_t i = 0; i < 16; i++)
    {
        result.u8[i] = saturate_ud_to_ub(source.u8[i] + destination.u8[i]);
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FDC, safe_read128s, read_xmm128s)

void instr_0FDD(union reg64 source, int32_t r) {
    // paddusw mm, mm/m64

    union reg64 destination = read_mmx64s(r);

    int32_t word0 = saturate_uw(destination.u16[0] + source.u16[0]);
    int32_t word1 = saturate_uw(destination.u16[1] + source.u16[1]);
    int32_t word2 = saturate_uw(destination.u16[2] + source.u16[2]);
    int32_t word3 = saturate_uw(destination.u16[3] + source.u16[3]);

    int32_t low = word0 | word1 << 16;
    int32_t high = word2 | word3 << 16;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0FDD, safe_read64s, read_mmx64s)

void instr_660FDD(union reg128 source, int32_t r) {
    // paddusw xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);

    write_xmm128(
        r,
        saturate_uw(source.u16[0] + destination.u16[0]) | saturate_uw(source.u16[1] + destination.u16[1]) << 16,
        saturate_uw(source.u16[2] + destination.u16[2]) | saturate_uw(source.u16[3] + destination.u16[3]) << 16,
        saturate_uw(source.u16[4] + destination.u16[4]) | saturate_uw(source.u16[5] + destination.u16[5]) << 16,
        saturate_uw(source.u16[6] + destination.u16[6]) | saturate_uw(source.u16[7] + destination.u16[7]) << 16
    );
}
DEFINE_SSE_SPLIT(instr_660FDD, safe_read128s, read_xmm128s)

void instr_0FDE(union reg64 source, int32_t r) {
    // pmaxub mm, mm/m64

    union reg64 destination = read_mmx64s(r);
    union reg64 result;

    for(uint32_t i = 0; i < 8; i++)
    {
        result.u8[i] = source.u8[i] > destination.u8[i] ? source.u8[i] : destination.u8[i];
    }

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FDE, safe_read64s, read_mmx64s)

void instr_660FDE(union reg128 source, int32_t r) {
    // pmaxub xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);
    union reg128 result;

    for(uint32_t i = 0; i < 16; i++)
    {
        result.u8[i] = source.u8[i] > destination.u8[i] ? source.u8[i] : destination.u8[i];
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FDE, safe_read128s, read_xmm128s)

void instr_0FDF(union reg64 source, int32_t r) {
    // pandn mm, mm/m64

    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    result.u64[0] = source.u64[0] & ~destination.u64[0];

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FDF, safe_read64s, read_mmx64s)

void instr_660FDF(union reg128 source, int32_t r) {
    // pandn xmm, xmm/m128
    // XXX: Aligned access or #gp
    pandn_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_660FDF, safe_read128s, read_xmm128s)

void instr_0FE0(union reg64 source, int32_t r) {
    // pavgb mm, mm/m64
    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    for(uint32_t i = 0; i < 8; i++)
    {
        result.u8[i] = (destination.u8[i] + source.u8[i] + 1) >> 1;
    }

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FE0, safe_read64s, read_mmx64s)

void instr_660FE0(union reg128 source, int32_t r) {
    // pavgb xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);
    union reg128 result;

    for(uint32_t i = 0; i < 16; i++)
    {
        result.u8[i] = (destination.u8[i] + source.u8[i] + 1) >> 1;
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FE0, safe_read128s, read_xmm128s)

void instr_0FE1(union reg64 source, int32_t r) {
    // psraw mm, mm/m64
    psraw_r64(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_0FE1, safe_read64s, read_mmx64s)

void instr_660FE1(union reg128 source, int32_t r) {
    // psraw xmm, xmm/m128
    // XXX: Aligned access or #gp
    psraw_r128(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_660FE1, safe_read128s, read_xmm128s)

void instr_0FE2(union reg64 source, int32_t r) {
    // psrad mm, mm/m64
    psrad_r64(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_0FE2, safe_read64s, read_mmx64s)

void instr_660FE2(union reg128 source, int32_t r) {
    // psrad xmm, xmm/m128
    // XXX: Aligned access or #gp
    psrad_r128(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_660FE2, safe_read128s, read_xmm128s)

void instr_0FE3(union reg64 source, int32_t r) {
    // pavgw mm, mm/m64
    union reg64 destination = read_mmx64s(r);

    destination.u16[0] = (destination.u16[0] + source.u16[0] + 1) >> 1;
    destination.u16[1] = (destination.u16[1] + source.u16[1] + 1) >> 1;
    destination.u16[2] = (destination.u16[2] + source.u16[2] + 1) >> 1;
    destination.u16[3] = (destination.u16[3] + source.u16[3] + 1) >> 1;

    write_mmx_reg64(r, destination);
}
DEFINE_SSE_SPLIT(instr_0FE3, safe_read64s, read_mmx64s)

void instr_660FE3(union reg128 source, int32_t r) {
    // pavgw xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    destination.u16[0] = (destination.u16[0] + source.u16[0] + 1) >> 1;
    destination.u16[1] = (destination.u16[1] + source.u16[1] + 1) >> 1;
    destination.u16[2] = (destination.u16[2] + source.u16[2] + 1) >> 1;
    destination.u16[3] = (destination.u16[3] + source.u16[3] + 1) >> 1;
    destination.u16[4] = (destination.u16[4] + source.u16[4] + 1) >> 1;
    destination.u16[5] = (destination.u16[5] + source.u16[5] + 1) >> 1;
    destination.u16[6] = (destination.u16[6] + source.u16[6] + 1) >> 1;
    destination.u16[7] = (destination.u16[7] + source.u16[7] + 1) >> 1;

    write_xmm_reg128(r, destination);
}
DEFINE_SSE_SPLIT(instr_660FE3, safe_read128s, read_xmm128s)

void instr_0FE4(union reg64 source, int32_t r) {
    // pmulhuw mm, mm/m64

    union reg64 destination = read_mmx64s(r);

    write_mmx64(
        r,
        (source.u16[0] * destination.u16[0] >> 16) & 0xFFFF | source.u16[1] * destination.u16[1] & 0xFFFF0000,
        (source.u16[2] * destination.u16[2] >> 16) & 0xFFFF | source.u16[3] * destination.u16[3] & 0xFFFF0000
    );
}
DEFINE_SSE_SPLIT(instr_0FE4, safe_read64s, read_mmx64s)

void instr_660FE4(union reg128 source, int32_t r) {
    // pmulhuw xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);

    write_xmm128(
        r,
        (source.u16[0] * destination.u16[0] >> 16) & 0xFFFF | source.u16[1] * destination.u16[1] & 0xFFFF0000,
        (source.u16[2] * destination.u16[2] >> 16) & 0xFFFF | source.u16[3] * destination.u16[3] & 0xFFFF0000,
        (source.u16[4] * destination.u16[4] >> 16) & 0xFFFF | source.u16[5] * destination.u16[5] & 0xFFFF0000,
        (source.u16[6] * destination.u16[6] >> 16) & 0xFFFF | source.u16[7] * destination.u16[7] & 0xFFFF0000
    );
}
DEFINE_SSE_SPLIT(instr_660FE4, safe_read128s, read_xmm128s)

void instr_0FE5(union reg64 source, int32_t r) {
    // pmulhw mm, mm/m64

    union reg64 destination = read_mmx64s(r);

    uint32_t word0 = ((destination.i16[0] * source.i16[0]) >> 16) & 0xFFFF;
    uint32_t word1 = ((destination.i16[1] * source.i16[1]) >> 16) & 0xFFFF;
    uint32_t word2 = ((destination.i16[2] * source.i16[2]) >> 16) & 0xFFFF;
    uint32_t word3 = ((destination.i16[3] * source.i16[3]) >> 16) & 0xFFFF;

    int32_t low = word0 | (word1 << 16);
    int32_t high = word2 | (word3 << 16);

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0FE5, safe_read64s, read_mmx64s)

void instr_660FE5(union reg128 source, int32_t r) {
    // pmulhw xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);

    int32_t dword0 = ((destination.i16[0] * source.i16[0]) >> 16) & 0xFFFF |
        ((destination.i16[1] * source.i16[1]) & 0xFFFF0000);
    int32_t dword1 = ((destination.i16[2] * source.i16[2]) >> 16) & 0xFFFF |
        ((destination.i16[3] * source.i16[3]) & 0xFFFF0000);
    int32_t dword2 = ((destination.i16[4] * source.i16[4]) >> 16) & 0xFFFF |
        ((destination.i16[5] * source.i16[5]) & 0xFFFF0000);
    int32_t dword3 = ((destination.i16[6] * source.i16[6]) >> 16) & 0xFFFF |
        ((destination.i16[7] * source.i16[7]) & 0xFFFF0000);

    write_xmm128(r, dword0, dword1, dword2, dword3);
}
DEFINE_SSE_SPLIT(instr_660FE5, safe_read128s, read_xmm128s)

void instr_0FE6_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_0FE6_reg(int32_t r1, int32_t r2) { trigger_ud(); }
void instr_660FE6_mem(int32_t addr, int32_t r) { unimplemented_sse(); }
void instr_660FE6_reg(int32_t r1, int32_t r2) { unimplemented_sse(); }
void instr_F20FE6_mem(int32_t addr, int32_t r) { unimplemented_sse(); }
void instr_F20FE6_reg(int32_t r1, int32_t r2) { unimplemented_sse(); }
void instr_F30FE6_mem(int32_t addr, int32_t r) { unimplemented_sse(); }
void instr_F30FE6_reg(int32_t r1, int32_t r2) { unimplemented_sse(); }

void instr_0FE7_mem(int32_t addr, int32_t r) {
    // movntq m64, mm
    mov_r_m64(addr, r);
}
void instr_0FE7_reg(int32_t r1, int32_t r2) { trigger_ud(); }

void instr_660FE7_reg(int32_t r1, int32_t r2) { trigger_ud(); }
void instr_660FE7_mem(int32_t addr, int32_t r) {
    // movntdq m128, xmm
    mov_r_m128(addr, r);
}

void instr_0FE8(union reg64 source, int32_t r) {
    // psubsb mm, mm/m64

    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    for(uint32_t i = 0; i < 8; i++)
    {
        result.u8[i] = saturate_sd_to_sb(destination.i8[i] - source.i8[i]);
    }

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FE8, safe_read64s, read_mmx64s)

void instr_660FE8(union reg128 source, int32_t r) {
    // psubsb xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);
    union reg128 result;

    for(uint32_t i = 0; i < 16; i++)
    {
        result.i8[i] = saturate_sd_to_sb(destination.i8[i] - source.i8[i]);
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FE8, safe_read128s, read_xmm128s)

void instr_0FE9(union reg64 source, int32_t r) {
    // psubsw mm, mm/m64

    union reg64 destination = read_mmx64s(r);

    int32_t word0 = saturate_sd_to_sw(destination.i16[0] - source.i16[0]);
    int32_t word1 = saturate_sd_to_sw(destination.i16[1] - source.i16[1]);
    int32_t word2 = saturate_sd_to_sw(destination.i16[2] - source.i16[2]);
    int32_t word3 = saturate_sd_to_sw(destination.i16[3] - source.i16[3]);

    int32_t low = word0 | word1 << 16;
    int32_t high = word2 | word3 << 16;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0FE9, safe_read64s, read_mmx64s)

void instr_660FE9(union reg128 source, int32_t r) {
    // psubsw xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);

    int32_t dword0 = saturate_sd_to_sw(destination.i16[0] - source.i16[0]) |
        saturate_sd_to_sw(destination.i16[1] - source.i16[1]) << 16;
    int32_t dword1 = saturate_sd_to_sw(destination.i16[2] - source.i16[2]) |
        saturate_sd_to_sw(destination.i16[3] - source.i16[3]) << 16;
    int32_t dword2 = saturate_sd_to_sw(destination.i16[4] - source.i16[4]) |
        saturate_sd_to_sw(destination.i16[5] - source.i16[5]) << 16;
    int32_t dword3 = saturate_sd_to_sw(destination.i16[6] - source.i16[6]) |
        saturate_sd_to_sw(destination.i16[7] - source.i16[7]) << 16;

    write_xmm128(r, dword0, dword1, dword2, dword3);
}
DEFINE_SSE_SPLIT(instr_660FE9, safe_read128s, read_xmm128s)

void instr_0FEA(union reg64 source, int32_t r) {
    // pminsw mm, mm/m64

    union reg64 destination = read_mmx64s(r);
    union reg64 result;

    for(uint32_t i = 0; i < 4; i++)
    {
        result.i16[i] = destination.i16[i] < source.i16[i] ? destination.i16[i] : source.i16[i];
    }

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FEA, safe_read64s, read_mmx64s)

void instr_660FEA(union reg128 source, int32_t r) {
    // pminsw xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);
    union reg128 result;

    for(uint32_t i = 0; i < 8; i++)
    {
        result.i16[i] = destination.i16[i] < source.i16[i] ? destination.i16[i] : source.i16[i];
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FEA, safe_read128s, read_xmm128s)

void instr_0FEB(union reg64 source, int32_t r) {
    // por mm, mm/m64

    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    result.u64[0] = source.u64[0] | destination.u64[0];

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FEB, safe_read64s, read_mmx64s)

void instr_660FEB(union reg128 source, int32_t r) {
    // por xmm, xmm/m128
    // XXX: Aligned access or #gp
    por_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_660FEB, safe_read128s, read_xmm128s)

void instr_0FEC(union reg64 source, int32_t r) {
    // paddsb mm, mm/m64

    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    for(uint32_t i = 0; i < 8; i++)
    {
        result.u8[i] = saturate_sd_to_sb(destination.i8[i] + source.i8[i]);
    }

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FEC, safe_read64s, read_mmx64s)

void instr_660FEC(union reg128 source, int32_t r) {
    // paddsb xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);
    union reg128 result;

    for(uint32_t i = 0; i < 16; i++)
    {
        result.i8[i] = saturate_sd_to_sb(destination.i8[i] + source.i8[i]);
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FEC, safe_read128s, read_xmm128s)

void instr_0FED(union reg64 source, int32_t r) {
    // paddsw mm, mm/m64

    union reg64 destination = read_mmx64s(r);

    int32_t word0 = saturate_sd_to_sw(destination.i16[0] + source.i16[0]);
    int32_t word1 = saturate_sd_to_sw(destination.i16[1] + source.i16[1]);
    int32_t word2 = saturate_sd_to_sw(destination.i16[2] + source.i16[2]);
    int32_t word3 = saturate_sd_to_sw(destination.i16[3] + source.i16[3]);

    int32_t low = word0 | word1 << 16;
    int32_t high = word2 | word3 << 16;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0FED, safe_read64s, read_mmx64s)

void instr_660FED(union reg128 source, int32_t r) {
    // paddsw xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);

    int32_t dword0 = saturate_sd_to_sw(destination.i16[0] + source.i16[0]) |
        saturate_sd_to_sw(destination.i16[1] + source.i16[1]) << 16;
    int32_t dword1 = saturate_sd_to_sw(destination.i16[2] + source.i16[2]) |
        saturate_sd_to_sw(destination.i16[3] + source.i16[3]) << 16;
    int32_t dword2 = saturate_sd_to_sw(destination.i16[4] + source.i16[4]) |
        saturate_sd_to_sw(destination.i16[5] + source.i16[5]) << 16;
    int32_t dword3 = saturate_sd_to_sw(destination.i16[6] + source.i16[6]) |
        saturate_sd_to_sw(destination.i16[7] + source.i16[7]) << 16;

    write_xmm128(r, dword0, dword1, dword2, dword3);
}
DEFINE_SSE_SPLIT(instr_660FED, safe_read128s, read_xmm128s)

void instr_0FEE(union reg64 source, int32_t r) {
    // pmaxsw mm, mm/m64

    union reg64 destination = read_mmx64s(r);
    union reg64 result;

    for(uint32_t i = 0; i < 4; i++)
    {
        result.i16[i] = destination.i16[i] >= source.i16[i] ? destination.i16[i] : source.i16[i];
    }

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FEE, safe_read64s, read_mmx64s)

void instr_660FEE(union reg128 source, int32_t r) {
    // pmaxsw xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);
    union reg128 result;

    for(uint32_t i = 0; i < 8; i++)
    {
        result.i16[i] = destination.i16[i] >= source.i16[i] ? destination.i16[i] : source.i16[i];
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FEE, safe_read128s, read_xmm128s)

void instr_0FEF(union reg64 source, int32_t r) {
    // pxor mm, mm/m64
    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    result.u64[0] = source.u64[0] ^ destination.u64[0];

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FEF, safe_read64s, read_mmx64s)

void instr_660FEF(union reg128 source, int32_t r) {
    // pxor xmm, xmm/m128
    // XXX: Aligned access or #gp
    pxor_r128(source, r);
}
DEFINE_SSE_SPLIT(instr_660FEF, safe_read128s, read_xmm128s)

void instr_0FF0() { unimplemented_sse(); }

void instr_0FF1(union reg64 source, int32_t r) {
    // psllw mm, mm/m64
    psllw_r64(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_0FF1, safe_read64s, read_mmx64s)

void instr_660FF1(union reg128 source, int32_t r) {
    // psllw xmm, xmm/m128
    // XXX: Aligned access or #gp
    psllw_r128(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_660FF1, safe_read128s, read_xmm128s)

void instr_0FF2(union reg64 source, int32_t r) {
    // pslld mm, mm/m64
    pslld_r64(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_0FF2, safe_read64s, read_mmx64s)

void instr_660FF2(union reg128 source, int32_t r) {
    // pslld xmm, xmm/m128
    // XXX: Aligned access or #gp
    pslld_r128(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_660FF2, safe_read128s, read_xmm128s)

void instr_0FF3(union reg64 source, int32_t r) {
    // psllq mm, mm/m64
    psllq_r64(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_0FF3, safe_read64s, read_mmx64s)

void instr_660FF3(union reg128 source, int32_t r) {
    // psllq xmm, xmm/m128
    // XXX: Aligned access or #gp
    psllq_r128(r, source.u32[0]);
}
DEFINE_SSE_SPLIT(instr_660FF3, safe_read128s, read_xmm128s)

void instr_0FF4(union reg64 source, int32_t r) {
    // pmuludq mm, mm/m64
    union reg64 destination = read_mmx64s(r);

    destination.u64[0] = (uint64_t) source.u32[0] * (uint64_t) destination.u32[0];
    write_mmx_reg64(r, destination);
}
DEFINE_SSE_SPLIT(instr_0FF4, safe_read64s, read_mmx64s)

void instr_660FF4(union reg128 source, int32_t r) {
    // pmuludq xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    destination.u64[0] = (uint64_t) source.u32[0] * (uint64_t) destination.u32[0];
    destination.u64[1] = (uint64_t) source.u32[2] * (uint64_t) destination.u32[2];
    write_xmm_reg128(r, destination);
}
DEFINE_SSE_SPLIT(instr_660FF4, safe_read128s, read_xmm128s)

void instr_0FF5(union reg64 source, int32_t r) {
    // pmaddwd mm, mm/m64

    union reg64 destination = read_mmx64s(r);

    int32_t mul0 = destination.i16[0] * source.i16[0];
    int32_t mul1 = destination.i16[1] * source.i16[1];
    int32_t mul2 = destination.i16[2] * source.i16[2];
    int32_t mul3 = destination.i16[3] * source.i16[3];

    int32_t low = mul0 + mul1;
    int32_t high = mul2 + mul3;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0FF5, safe_read64s, read_mmx64s)

void instr_660FF5(union reg128 source, int32_t r) {
    // pmaddwd xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);

    int32_t dword0 = (destination.i16[0] * source.i16[0]) +
        (destination.i16[1] * source.i16[1]);
    int32_t dword1 = (destination.i16[2] * source.i16[2]) +
        (destination.i16[3] * source.i16[3]);
    int32_t dword2 = (destination.i16[4] * source.i16[4]) +
        (destination.i16[5] * source.i16[5]);
    int32_t dword3 = (destination.i16[6] * source.i16[6]) +
        (destination.i16[7] * source.i16[7]);

    write_xmm128(r, dword0, dword1, dword2, dword3);
}
DEFINE_SSE_SPLIT(instr_660FF5, safe_read128s, read_xmm128s)

void instr_0FF6(union reg64 source, int32_t r) {
    // psadbw mm, mm/m64
    union reg64 destination = read_mmx64s(r);
    uint32_t sum = 0;

    for(uint32_t i = 0; i < 8; i++)
    {
        sum += abs(destination.u8[i] - source.u8[i]);
    }

    write_mmx64(r, sum, 0);
}
DEFINE_SSE_SPLIT(instr_0FF6, safe_read64s, read_mmx64s)

void instr_660FF6(union reg128 source, int32_t r) {
    // psadbw xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);
    uint32_t sum0 = 0;
    uint32_t sum1 = 0;

    for(uint32_t i = 0; i < 8; i++)
    {
        sum0 += abs(destination.u8[i] - source.u8[i]);
        sum1 += abs(destination.u8[i + 8] - source.u8[i + 8]);
    }

    write_xmm128(r, sum0, 0, sum1, 0);
}
DEFINE_SSE_SPLIT(instr_660FF6, safe_read128s, read_xmm128s)

void instr_0FF7_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_0FF7_reg(int32_t r1, int32_t r2) {
    // maskmovq mm, mm
    union reg64 source = read_mmx64s(r2);
    union reg64 mask = read_mmx64s(r1);
    int32_t addr = get_seg_prefix(DS) + get_reg_asize(EDI);

    writable_or_pagefault(addr, 8);
    for(uint32_t i = 0; i < 8; i++)
    {
        if(mask.u8[i] & 0x80)
        {
            safe_write8(addr + i, source.u8[i]);
        }
    }
}

void instr_660FF7_mem(int32_t addr, int32_t r) { trigger_ud(); }
void instr_660FF7_reg(int32_t r1, int32_t r2) {
    // maskmovdqu xmm, xmm
    union reg128 source = read_xmm128s(r2);
    union reg128 mask = read_xmm128s(r1);
    int32_t addr = get_seg_prefix(DS) + get_reg_asize(EDI);

    writable_or_pagefault(addr, 16);
    for(uint32_t i = 0; i < 16; i++)
    {
        if(mask.u8[i] & 0x80)
        {
            safe_write8(addr + i, source.u8[i]);
        }
    }
}

void instr_0FF8(union reg64 source, int32_t r) {
    // psubb mm, mm/m64

    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    for(uint32_t i = 0; i < 8; i++)
    {
        result.u8[i] = (destination.i8[i] - source.i8[i]) & 0xFF;
    }

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FF8, safe_read64s, read_mmx64s)

void instr_660FF8(union reg128 source, int32_t r) {
    // psubb xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);
    union reg128 result = { { 0 } };

    for(uint32_t i = 0; i < 16; i++)
    {
        result.i8[i] = (destination.i8[i] - source.i8[i]) & 0xFF;
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FF8, safe_read128s, read_xmm128s)

void instr_0FF9(union reg64 source, int32_t r) {
    // psubw mm, mm/m64

    union reg64 destination = read_mmx64s(r);

    int32_t word0 = (destination.u32[0] - source.u32[0]) & 0xFFFF;
    int32_t word1 = (((uint32_t) destination.u16[1]) - source.u16[1]) & 0xFFFF;
    int32_t low = word0 | word1 << 16;

    int32_t word2 = (destination.u32[1] - source.u32[1]) & 0xFFFF;
    int32_t word3 = (((uint32_t) destination.u16[3]) - source.u16[3]) & 0xFFFF;
    int32_t high = word2 | word3 << 16;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0FF9, safe_read64s, read_mmx64s)

void instr_660FF9(union reg128 source, int32_t r) {
    // psubw xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);
    union reg128 result = { { 0 } };

    for(uint32_t i = 0; i < 8; i++)
    {
        result.i16[i] = (destination.i16[i] - source.i16[i]) & 0xFFFF;
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FF9, safe_read128s, read_xmm128s)

void instr_0FFA(union reg64 source, int32_t r) {
    // psubd mm, mm/m64

    union reg64 destination = read_mmx64s(r);

    write_mmx64(
        r,
        destination.u32[0] - source.u32[0],
        destination.u32[1] - source.u32[1]
    );
}
DEFINE_SSE_SPLIT(instr_0FFA, safe_read64s, read_mmx64s)

void instr_660FFA(union reg128 source, int32_t r) {
    // psubd xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);

    write_xmm128(
        r,
        destination.u32[0] - source.u32[0],
        destination.u32[1] - source.u32[1],
        destination.u32[2] - source.u32[2],
        destination.u32[3] - source.u32[3]
    );
}
DEFINE_SSE_SPLIT(instr_660FFA, safe_read128s, read_xmm128s)

void instr_0FFB(union reg64 source, int32_t r) {
    // psubq mm, mm/m64
    union reg64 destination = read_mmx64s(r);

    destination.u64[0] = destination.u64[0] - source.u64[0];
    write_mmx_reg64(r, destination);
}
DEFINE_SSE_SPLIT(instr_0FFB, safe_read64s, read_mmx64s)

void instr_660FFB(union reg128 source, int32_t r) {
    // psubq xmm, xmm/m128
    // XXX: Aligned access or #gp
    union reg128 destination = read_xmm128s(r);

    destination.u64[0] = destination.u64[0] - source.u64[0];
    destination.u64[1] = destination.u64[1] - source.u64[1];

    write_xmm_reg128(r, destination);
}
DEFINE_SSE_SPLIT(instr_660FFB, safe_read128s, read_xmm128s)

void instr_0FFC(union reg64 source, int32_t r) {
    // paddb mm, mm/m64

    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    for(uint32_t i = 0; i < 8; i++)
    {
        result.u8[i] = (destination.u8[i] + source.u8[i]) & 0xFF;
    }

    write_mmx_reg64(r, result);
}
DEFINE_SSE_SPLIT(instr_0FFC, safe_read64s, read_mmx64s)

void instr_660FFC(union reg128 source, int32_t r) {
    // paddb xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);
    union reg128 result = { { 0 } };

    for(uint32_t i = 0; i < 16; i++)
    {
        result.u8[i] = (destination.u8[i] + source.u8[i]) & 0xFF;
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FFC, safe_read128s, read_xmm128s)

void instr_0FFD(union reg64 source, int32_t r) {
    // paddw mm, mm/m64

    union reg64 destination = read_mmx64s(r);

    int32_t word0 = (destination.u32[0] + source.u32[0]) & 0xFFFF;
    int32_t word1 = (destination.u16[1] + source.u16[1]) & 0xFFFF;
    int32_t low = word0 | word1 << 16;

    int32_t word2 = (destination.u32[1] + source.u32[1]) & 0xFFFF;
    int32_t word3 = (destination.u16[3] + source.u16[3]) & 0xFFFF;
    int32_t high = word2 | word3 << 16;

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0FFD, safe_read64s, read_mmx64s)

void instr_660FFD(union reg128 source, int32_t r) {
    // paddw xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);
    union reg128 result = { { 0 } };

    for(uint32_t i = 0; i < 8; i++)
    {
        result.u16[i] = (destination.u16[i] + source.u16[i]) & 0xFFFF;
    }

    write_xmm_reg128(r, result);
}
DEFINE_SSE_SPLIT(instr_660FFD, safe_read128s, read_xmm128s)

void instr_0FFE(union reg64 source, int32_t r) {
    // paddd mm, mm/m64

    union reg64 destination = read_mmx64s(r);

    int32_t low = destination.u32[0] + source.u32[0];
    int32_t high = destination.u32[1] + source.u32[1];

    write_mmx64(r, low, high);
}
DEFINE_SSE_SPLIT(instr_0FFE, safe_read64s, read_mmx64s)

void instr_660FFE(union reg128 source, int32_t r) {
    // paddd xmm, xmm/m128
    // XXX: Aligned access or #gp

    union reg128 destination = read_xmm128s(r);

    int32_t dword0 = destination.u32[0] + source.u32[0];
    int32_t dword1 = destination.u32[1] + source.u32[1];
    int32_t dword2 = destination.u32[2] + source.u32[2];
    int32_t dword3 = destination.u32[3] + source.u32[3];

    write_xmm128(r, dword0, dword1, dword2, dword3);
}
DEFINE_SSE_SPLIT(instr_660FFE, safe_read128s, read_xmm128s)

void instr_0FFF() {
    // Windows 98
    dbg_log("#ud: 0F FF");
    trigger_ud();
}

void run_instruction0f_16(int32_t opcode)
{
#include "../../build/interpreter0f_16.c"
}

void run_instruction0f_32(int32_t opcode)
{
#include "../../build/interpreter0f_32.c"
}

#pragma clang diagnostic pop
