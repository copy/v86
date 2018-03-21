#pragma once

#include <stdint.h>

typedef uint32_t jit_instr_flags;

#define JIT_INSTR_JUMP_FLAG (1 << 0)
#define JIT_INSTR_NONFAULTING_FLAG (1 << 1)

#define SAFE_READ_WRITE8(addr, fun) \
    int32_t phys_addr = translate_address_write(addr); \
    int32_t ___ = read8(phys_addr); \
    write8(phys_addr, fun);

#define SAFE_READ_WRITE16(addr, fun) \
    int32_t phys_addr = translate_address_write(addr); \
    if((phys_addr & 0xFFF) == 0xFFF) \
    { \
        int32_t phys_addr_high = translate_address_write((addr) + 1); \
        int32_t ___ = virt_boundary_read16(phys_addr, phys_addr_high); \
        virt_boundary_write16(phys_addr, phys_addr_high, fun); \
    } \
    else \
    { \
        int32_t ___ = read16(phys_addr); \
        write16(phys_addr, fun); \
    }

#define SAFE_READ_WRITE32(addr, fun) \
    int32_t phys_addr = translate_address_write(addr); \
    if((phys_addr & 0xFFF) >= 0xFFD) \
    { \
        int32_t phys_addr_high = translate_address_write((addr) + 3 & ~3) | ((addr) + 3) & 3; \
        int32_t ___ = virt_boundary_read32s(phys_addr, phys_addr_high); \
        virt_boundary_write32(phys_addr, phys_addr_high, fun); \
    } \
    else \
    { \
        int32_t ___ = read32s(phys_addr); \
        write32(phys_addr, fun); \
    }

#define DEFINE_MODRM_INSTR1_READ_WRITE_8(name, fun) \
    void name ## _mem(int32_t addr) { SAFE_READ_WRITE8(addr, fun) } \
    void name ## _reg(int32_t r1) { int32_t ___ = read_reg8(r1); write_reg8(r1, fun); }

#define DEFINE_MODRM_INSTR1_READ_WRITE_16(name, fun) \
    void name ## _mem(int32_t addr) { SAFE_READ_WRITE16(addr, fun) } \
    void name ## _reg(int32_t r1) { int32_t ___ = read_reg16(r1); write_reg16(r1, fun); }

#define DEFINE_MODRM_INSTR1_READ_WRITE_32(name, fun) \
    void name ## _mem(int32_t addr) { SAFE_READ_WRITE32(addr, fun) } \
    void name ## _reg(int32_t r1) { int32_t ___ = read_reg32(r1); write_reg32(r1, fun); }


#define DEFINE_MODRM_INSTR2_READ_WRITE_8(name, fun) \
    void name ## _mem(int32_t addr, int32_t imm) { SAFE_READ_WRITE8(addr, fun) } \
    void name ## _reg(int32_t r1, int32_t imm) { int32_t ___ = read_reg8(r1); write_reg8(r1, fun); }

#define DEFINE_MODRM_INSTR2_READ_WRITE_16(name, fun) \
    void name ## _mem(int32_t addr, int32_t imm) { SAFE_READ_WRITE16(addr, fun) } \
    void name ## _reg(int32_t r1, int32_t imm) { int32_t ___ = read_reg16(r1); write_reg16(r1, fun); }

#define DEFINE_MODRM_INSTR2_READ_WRITE_32(name, fun) \
    void name ## _mem(int32_t addr, int32_t imm) { SAFE_READ_WRITE32(addr, fun) } \
    void name ## _reg(int32_t r1, int32_t imm) { int32_t ___ = read_reg32(r1); write_reg32(r1, fun); }


#define DEFINE_MODRM_INSTR_READ_WRITE_8(name, fun) \
    void name ## _mem(int32_t addr, int32_t r) { SAFE_READ_WRITE8(addr, fun) } \
    void name ## _reg(int32_t r1, int32_t r) { int32_t ___ = read_reg8(r1); write_reg8(r1, fun); }

#define DEFINE_MODRM_INSTR_READ_WRITE_16(name, fun) \
    void name ## _mem(int32_t addr, int32_t r) { SAFE_READ_WRITE16(addr, fun) } \
    void name ## _reg(int32_t r1, int32_t r) { int32_t ___ = read_reg16(r1); write_reg16(r1, fun); }

#define DEFINE_MODRM_INSTR_READ_WRITE_32(name, fun) \
    void name ## _mem(int32_t addr, int32_t r) { SAFE_READ_WRITE32(addr, fun) } \
    void name ## _reg(int32_t r1, int32_t r) { int32_t ___ = read_reg32(r1); write_reg32(r1, fun); }


#define DEFINE_MODRM_INSTR1_READ8(name, fun) \
    void name ## _mem(int32_t addr) { int32_t ___ = safe_read8(addr); fun; } \
    void name ## _reg(int32_t r1) { int32_t ___ = read_reg8(r1); fun; }

#define DEFINE_MODRM_INSTR1_READ16(name, fun) \
    void name ## _mem(int32_t addr) { int32_t ___ = safe_read16(addr); fun; } \
    void name ## _reg(int32_t r1) { int32_t ___ = read_reg16(r1); fun; }

#define DEFINE_MODRM_INSTR1_READ32(name, fun) \
    void name ## _mem(int32_t addr) { int32_t ___ = safe_read32s(addr); fun; } \
    void name ## _reg(int32_t r1) { int32_t ___ = read_reg32(r1); fun; }


#define DEFINE_MODRM_INSTR2_READ8(name, fun) \
    void name ## _mem(int32_t addr, int32_t imm) { int32_t ___ = safe_read8(addr); fun; } \
    void name ## _reg(int32_t r1, int32_t imm) { int32_t ___ = read_reg8(r1); fun; }

#define DEFINE_MODRM_INSTR2_READ16(name, fun) \
    void name ## _mem(int32_t addr, int32_t imm) { int32_t ___ = safe_read16(addr); fun; } \
    void name ## _reg(int32_t r1, int32_t imm) { int32_t ___ = read_reg16(r1); fun; }

#define DEFINE_MODRM_INSTR2_READ32(name, fun) \
    void name ## _mem(int32_t addr, int32_t imm) { int32_t ___ = safe_read32s(addr); fun; } \
    void name ## _reg(int32_t r1, int32_t imm) { int32_t ___ = read_reg32(r1); fun; }


#define DEFINE_MODRM_INSTR_READ8(name, fun) \
    void name ## _mem(int32_t addr, int32_t r) { int32_t ___ = safe_read8(addr); fun; } \
    void name ## _reg(int32_t r1, int32_t r) { int32_t ___ = read_reg8(r1); fun; }

#define DEFINE_MODRM_INSTR_READ16(name, fun) \
    void name ## _mem(int32_t addr, int32_t r) { int32_t ___ = safe_read16(addr); fun; } \
    void name ## _reg(int32_t r1, int32_t r) { int32_t ___ = read_reg16(r1); fun; }

#define DEFINE_MODRM_INSTR_READ32(name, fun) \
    void name ## _mem(int32_t addr, int32_t r) { int32_t ___ = safe_read32s(addr); fun; } \
    void name ## _reg(int32_t r1, int32_t r) { int32_t ___ = read_reg32(r1); fun; }

#define DEFINE_MODRM_INSTR_FPU_READ32(name, fun) \
    void name ## _mem(int32_t addr) { task_switch_test(); double_t ___ = fpu_load_m32(addr); fun; } \
    void name ## _reg(int32_t r) { task_switch_test(); double_t ___ = fpu_get_sti(r); fun; }

#define DEFINE_MODRM_INSTR_FPU_READ64(name, fun) \
    void name ## _mem(int32_t addr) { task_switch_test(); double_t ___ = fpu_load_m64(addr); fun; } \
    void name ## _reg(int32_t r) { task_switch_test(); double_t ___ = fpu_get_sti(r); fun; }

void instr_00_mem(int32_t addr, int32_t r);
void instr_00_reg(int32_t r1, int32_t r);
void instr16_01_mem(int32_t addr, int32_t r);
void instr16_01_reg(int32_t r1, int32_t r);
void instr32_01_mem(int32_t addr, int32_t r);
void instr32_01_reg(int32_t r1, int32_t r);
void instr_02_mem(int32_t addr, int32_t r);
void instr_02_reg(int32_t r1, int32_t r);
void instr16_03_mem(int32_t addr, int32_t r);
void instr16_03_reg(int32_t r1, int32_t r);
void instr32_03_mem(int32_t addr, int32_t r);
void instr32_03_reg(int32_t r1, int32_t r);
void instr_04(int32_t imm8);
void instr16_05(int32_t imm16);
void instr32_05(int32_t imm32);
void instr16_06(void);
void instr32_06(void);
void instr16_07(void);
void instr32_07(void);
void instr_08_mem(int32_t addr, int32_t r);
void instr_08_reg(int32_t r1, int32_t r);
void instr16_09_mem(int32_t addr, int32_t r);
void instr16_09_reg(int32_t r1, int32_t r);
void instr32_09_mem(int32_t addr, int32_t r);
void instr32_09_reg(int32_t r1, int32_t r);
void instr_0A_mem(int32_t addr, int32_t r);
void instr_0A_reg(int32_t r1, int32_t r);
void instr16_0B_mem(int32_t addr, int32_t r);
void instr16_0B_reg(int32_t r1, int32_t r);
void instr32_0B_mem(int32_t addr, int32_t r);
void instr32_0B_reg(int32_t r1, int32_t r);
void instr_0C(int32_t imm8);
void instr16_0D(int32_t imm16);
void instr32_0D(int32_t imm32);
void instr16_0E(void);
void instr32_0E(void);
void instr16_0F(void);
void instr32_0F(void);
jit_instr_flags instr16_0F_jit(void);
jit_instr_flags instr32_0F_jit(void);
void instr_10_mem(int32_t addr, int32_t r);
void instr_10_reg(int32_t r1, int32_t r);
void instr16_11_mem(int32_t addr, int32_t r);
void instr16_11_reg(int32_t r1, int32_t r);
void instr32_11_mem(int32_t addr, int32_t r);
void instr32_11_reg(int32_t r1, int32_t r);
void instr_12_mem(int32_t addr, int32_t r);
void instr_12_reg(int32_t r1, int32_t r);
void instr16_13_mem(int32_t addr, int32_t r);
void instr16_13_reg(int32_t r1, int32_t r);
void instr32_13_mem(int32_t addr, int32_t r);
void instr32_13_reg(int32_t r1, int32_t r);
void instr_14(int32_t imm8);
void instr16_15(int32_t imm16);
void instr32_15(int32_t imm32);
void instr16_16(void);
void instr32_16(void);
void instr16_17(void);
void instr32_17(void);
void instr_18_mem(int32_t addr, int32_t r);
void instr_18_reg(int32_t r1, int32_t r);
void instr16_19_mem(int32_t addr, int32_t r);
void instr16_19_reg(int32_t r1, int32_t r);
void instr32_19_mem(int32_t addr, int32_t r);
void instr32_19_reg(int32_t r1, int32_t r);
void instr_1A_mem(int32_t addr, int32_t r);
void instr_1A_reg(int32_t r1, int32_t r);
void instr16_1B_mem(int32_t addr, int32_t r);
void instr16_1B_reg(int32_t r1, int32_t r);
void instr32_1B_mem(int32_t addr, int32_t r);
void instr32_1B_reg(int32_t r1, int32_t r);
void instr_1C(int32_t imm8);
void instr16_1D(int32_t imm16);
void instr32_1D(int32_t imm32);
void instr16_1E(void);
void instr32_1E(void);
void instr16_1F(void);
void instr32_1F(void);
void instr_20_mem(int32_t addr, int32_t r);
void instr_20_reg(int32_t r1, int32_t r);
void instr16_21_mem(int32_t addr, int32_t r);
void instr16_21_reg(int32_t r1, int32_t r);
void instr32_21_mem(int32_t addr, int32_t r);
void instr32_21_reg(int32_t r1, int32_t r);
void instr_22_mem(int32_t addr, int32_t r);
void instr_22_reg(int32_t r1, int32_t r);
void instr16_23_mem(int32_t addr, int32_t r);
void instr16_23_reg(int32_t r1, int32_t r);
void instr32_23_mem(int32_t addr, int32_t r);
void instr32_23_reg(int32_t r1, int32_t r);
void instr_24(int32_t imm8);
void instr16_25(int32_t imm16);
void instr32_25(int32_t imm32);
void instr_26(void);
jit_instr_flags instr_26_jit(void);
void instr_27(void);
void instr_28_mem(int32_t addr, int32_t r);
void instr_28_reg(int32_t r1, int32_t r);
void instr16_29_mem(int32_t addr, int32_t r);
void instr16_29_reg(int32_t r1, int32_t r);
void instr32_29_mem(int32_t addr, int32_t r);
void instr32_29_reg(int32_t r1, int32_t r);
void instr_2A_mem(int32_t addr, int32_t r);
void instr_2A_reg(int32_t r1, int32_t r);
void instr16_2B_mem(int32_t addr, int32_t r);
void instr16_2B_reg(int32_t r1, int32_t r);
void instr32_2B_mem(int32_t addr, int32_t r);
void instr32_2B_reg(int32_t r1, int32_t r);
void instr_2C(int32_t imm8);
void instr16_2D(int32_t imm16);
void instr32_2D(int32_t imm32);
void instr_2E(void);
jit_instr_flags instr_2E_jit(void);
void instr_2F(void);
void instr_30_mem(int32_t addr, int32_t r);
void instr_30_reg(int32_t r1, int32_t r);
void instr16_31_mem(int32_t addr, int32_t r);
void instr16_31_reg(int32_t r1, int32_t r);
void instr32_31_mem(int32_t addr, int32_t r);
void instr32_31_reg(int32_t r1, int32_t r);
void instr_32_mem(int32_t addr, int32_t r);
void instr_32_reg(int32_t r1, int32_t r);
void instr16_33_mem(int32_t addr, int32_t r);
void instr16_33_reg(int32_t r1, int32_t r);
void instr32_33_mem(int32_t addr, int32_t r);
void instr32_33_reg(int32_t r1, int32_t r);
void instr_34(int32_t imm8);
void instr16_35(int32_t imm16);
void instr32_35(int32_t imm32);
void instr_36(void);
jit_instr_flags instr_36_jit(void);
void instr_37(void);
void instr_38_mem(int32_t addr, int32_t r);
void instr_38_reg(int32_t r1, int32_t r);
void instr16_39_mem(int32_t addr, int32_t r);
void instr16_39_reg(int32_t r1, int32_t r);
void instr32_39_mem(int32_t addr, int32_t r);
void instr32_39_reg(int32_t r1, int32_t r);
void instr_3A_mem(int32_t addr, int32_t r);
void instr_3A_reg(int32_t r1, int32_t r);
void instr16_3B_mem(int32_t addr, int32_t r);
void instr16_3B_reg(int32_t r1, int32_t r);
void instr32_3B_mem(int32_t addr, int32_t r);
void instr32_3B_reg(int32_t r1, int32_t r);
void instr_3C(int32_t imm8);
void instr16_3D(int32_t imm16);
void instr32_3D(int32_t imm32);
void instr_3E(void);
jit_instr_flags instr_3E_jit(void);
void instr_3F(void);
void instr16_40(void);
void instr32_40(void);
void instr16_41(void);
void instr32_41(void);
void instr16_42(void);
void instr32_42(void);
void instr16_43(void);
void instr32_43(void);
void instr16_44(void);
void instr32_44(void);
void instr16_45(void);
void instr32_45(void);
void instr16_46(void);
void instr32_46(void);
void instr16_47(void);
void instr32_47(void);
void instr16_48(void);
void instr32_48(void);
void instr16_49(void);
void instr32_49(void);
void instr16_4A(void);
void instr32_4A(void);
void instr16_4B(void);
void instr32_4B(void);
void instr16_4C(void);
void instr32_4C(void);
void instr16_4D(void);
void instr32_4D(void);
void instr16_4E(void);
void instr32_4E(void);
void instr16_4F(void);
void instr32_4F(void);
void instr16_50(void);
void instr32_50(void);
void instr16_51(void);
void instr32_51(void);
void instr16_52(void);
void instr32_52(void);
void instr16_53(void);
void instr32_53(void);
void instr16_54(void);
void instr32_54(void);
void instr16_55(void);
void instr32_55(void);
void instr16_56(void);
void instr32_56(void);
void instr16_57(void);
void instr32_57(void);
void instr16_58(void);
void instr32_58(void);
void instr16_59(void);
void instr32_59(void);
void instr16_5A(void);
void instr32_5A(void);
void instr16_5B(void);
void instr32_5B(void);
void instr16_5C(void);
void instr32_5C(void);
void instr16_5D(void);
void instr32_5D(void);
void instr16_5E(void);
void instr32_5E(void);
void instr16_5F(void);
void instr32_5F(void);
void instr16_60(void);
void instr32_60(void);
void instr16_61(void);
void instr32_61(void);
void instr_62_reg(int32_t r2, int32_t r);
void instr_62_mem(int32_t addr, int32_t r);
void instr_63_mem(int32_t addr, int32_t r);
void instr_63_reg(int32_t r1, int32_t r);
void instr_64(void);
jit_instr_flags instr_64_jit(void);
void instr_65(void);
jit_instr_flags instr_65_jit(void);
void instr_66(void);
jit_instr_flags instr_66_jit(void);
void instr_67(void);
jit_instr_flags instr_67_jit(void);
void instr16_68(int32_t imm16);
void instr32_68(int32_t imm32);
void instr16_69_mem(int32_t addr, int32_t r, int32_t imm);
void instr16_69_reg(int32_t r1, int32_t r, int32_t imm);
void instr32_69_mem(int32_t addr, int32_t r, int32_t imm);
void instr32_69_reg(int32_t r1, int32_t r, int32_t imm);
void instr16_6A(int32_t imm8);
void instr32_6A(int32_t imm8);
void instr16_6B_mem(int32_t addr, int32_t r, int32_t imm);
void instr16_6B_reg(int32_t r1, int32_t r, int32_t imm);
void instr32_6B_mem(int32_t addr, int32_t r, int32_t imm);
void instr32_6B_reg(int32_t r1, int32_t r, int32_t imm);
void instr_6C(void);
void instr16_6D(void);
void instr32_6D(void);
void instr_6E(void);
void instr16_6F(void);
void instr32_6F(void);
void instr_70(int32_t imm8);
void instr_71(int32_t imm8);
void instr_72(int32_t imm8);
void instr_73(int32_t imm8);
void instr_74(int32_t imm8);
void instr_75(int32_t imm8);
void instr_76(int32_t imm8);
void instr_77(int32_t imm8);
void instr_78(int32_t imm8);
void instr_79(int32_t imm8);
void instr_7A(int32_t imm8);
void instr_7B(int32_t imm8);
void instr_7C(int32_t imm8);
void instr_7D(int32_t imm8);
void instr_7E(int32_t imm8);
void instr_7F(int32_t imm8);
void instr_80_0_mem(int32_t addr, int32_t imm);
void instr_80_0_reg(int32_t r1, int32_t imm);
void instr_80_1_mem(int32_t addr, int32_t imm);
void instr_80_1_reg(int32_t r1, int32_t imm);
void instr_80_2_mem(int32_t addr, int32_t imm);
void instr_80_2_reg(int32_t r1, int32_t imm);
void instr_80_3_mem(int32_t addr, int32_t imm);
void instr_80_3_reg(int32_t r1, int32_t imm);
void instr_80_4_mem(int32_t addr, int32_t imm);
void instr_80_4_reg(int32_t r1, int32_t imm);
void instr_80_5_mem(int32_t addr, int32_t imm);
void instr_80_5_reg(int32_t r1, int32_t imm);
void instr_80_6_mem(int32_t addr, int32_t imm);
void instr_80_6_reg(int32_t r1, int32_t imm);
void instr_80_7_reg(int32_t r, int32_t imm);
void instr_80_7_mem(int32_t addr, int32_t imm);
void instr16_81_0_mem(int32_t addr, int32_t imm);
void instr16_81_0_reg(int32_t r1, int32_t imm);
void instr16_81_1_mem(int32_t addr, int32_t imm);
void instr16_81_1_reg(int32_t r1, int32_t imm);
void instr16_81_2_mem(int32_t addr, int32_t imm);
void instr16_81_2_reg(int32_t r1, int32_t imm);
void instr16_81_3_mem(int32_t addr, int32_t imm);
void instr16_81_3_reg(int32_t r1, int32_t imm);
void instr16_81_4_mem(int32_t addr, int32_t imm);
void instr16_81_4_reg(int32_t r1, int32_t imm);
void instr16_81_5_mem(int32_t addr, int32_t imm);
void instr16_81_5_reg(int32_t r1, int32_t imm);
void instr16_81_6_mem(int32_t addr, int32_t imm);
void instr16_81_6_reg(int32_t r1, int32_t imm);
void instr16_81_7_reg(int32_t r, int32_t imm);
void instr16_81_7_mem(int32_t addr, int32_t imm);
void instr32_81_0_mem(int32_t addr, int32_t imm);
void instr32_81_0_reg(int32_t r1, int32_t imm);
void instr32_81_1_mem(int32_t addr, int32_t imm);
void instr32_81_1_reg(int32_t r1, int32_t imm);
void instr32_81_2_mem(int32_t addr, int32_t imm);
void instr32_81_2_reg(int32_t r1, int32_t imm);
void instr32_81_3_mem(int32_t addr, int32_t imm);
void instr32_81_3_reg(int32_t r1, int32_t imm);
void instr32_81_4_mem(int32_t addr, int32_t imm);
void instr32_81_4_reg(int32_t r1, int32_t imm);
void instr32_81_5_mem(int32_t addr, int32_t imm);
void instr32_81_5_reg(int32_t r1, int32_t imm);
void instr32_81_6_mem(int32_t addr, int32_t imm);
void instr32_81_6_reg(int32_t r1, int32_t imm);
void instr32_81_7_reg(int32_t r, int32_t imm);
void instr32_81_7_mem(int32_t addr, int32_t imm);
void instr_82_0_mem(int32_t addr, int32_t imm);
void instr_82_0_reg(int32_t r1, int32_t imm);
void instr_82_1_mem(int32_t addr, int32_t imm);
void instr_82_1_reg(int32_t r1, int32_t imm);
void instr_82_2_mem(int32_t addr, int32_t imm);
void instr_82_2_reg(int32_t r1, int32_t imm);
void instr_82_3_mem(int32_t addr, int32_t imm);
void instr_82_3_reg(int32_t r1, int32_t imm);
void instr_82_4_mem(int32_t addr, int32_t imm);
void instr_82_4_reg(int32_t r1, int32_t imm);
void instr_82_5_mem(int32_t addr, int32_t imm);
void instr_82_5_reg(int32_t r1, int32_t imm);
void instr_82_6_mem(int32_t addr, int32_t imm);
void instr_82_6_reg(int32_t r1, int32_t imm);
void instr_82_7_reg(int32_t r, int32_t imm);
void instr_82_7_mem(int32_t addr, int32_t imm);
void instr16_83_0_mem(int32_t addr, int32_t imm);
void instr16_83_0_reg(int32_t r1, int32_t imm);
void instr16_83_1_mem(int32_t addr, int32_t imm);
void instr16_83_1_reg(int32_t r1, int32_t imm);
void instr16_83_2_mem(int32_t addr, int32_t imm);
void instr16_83_2_reg(int32_t r1, int32_t imm);
void instr16_83_3_mem(int32_t addr, int32_t imm);
void instr16_83_3_reg(int32_t r1, int32_t imm);
void instr16_83_4_mem(int32_t addr, int32_t imm);
void instr16_83_4_reg(int32_t r1, int32_t imm);
void instr16_83_5_mem(int32_t addr, int32_t imm);
void instr16_83_5_reg(int32_t r1, int32_t imm);
void instr16_83_6_mem(int32_t addr, int32_t imm);
void instr16_83_6_reg(int32_t r1, int32_t imm);
void instr16_83_7_reg(int32_t r, int32_t imm);
void instr16_83_7_mem(int32_t addr, int32_t imm);
void instr32_83_0_mem(int32_t addr, int32_t imm);
void instr32_83_0_reg(int32_t r1, int32_t imm);
void instr32_83_1_mem(int32_t addr, int32_t imm);
void instr32_83_1_reg(int32_t r1, int32_t imm);
void instr32_83_2_mem(int32_t addr, int32_t imm);
void instr32_83_2_reg(int32_t r1, int32_t imm);
void instr32_83_3_mem(int32_t addr, int32_t imm);
void instr32_83_3_reg(int32_t r1, int32_t imm);
void instr32_83_4_mem(int32_t addr, int32_t imm);
void instr32_83_4_reg(int32_t r1, int32_t imm);
void instr32_83_5_mem(int32_t addr, int32_t imm);
void instr32_83_5_reg(int32_t r1, int32_t imm);
void instr32_83_6_mem(int32_t addr, int32_t imm);
void instr32_83_6_reg(int32_t r1, int32_t imm);
void instr32_83_7_reg(int32_t r, int32_t imm);
void instr32_83_7_mem(int32_t addr, int32_t imm);
void instr_84_mem(int32_t addr, int32_t r);
void instr_84_reg(int32_t r1, int32_t r);
void instr16_85_mem(int32_t addr, int32_t r);
void instr16_85_reg(int32_t r1, int32_t r);
void instr32_85_mem(int32_t addr, int32_t r);
void instr32_85_reg(int32_t r1, int32_t r);
void instr_86_mem(int32_t addr, int32_t r);
void instr_86_reg(int32_t r1, int32_t r);
void instr16_87_mem(int32_t addr, int32_t r);
void instr16_87_reg(int32_t r1, int32_t r);
void instr32_87_mem(int32_t addr, int32_t r);
void instr32_87_reg(int32_t r1, int32_t r);
void instr_88_reg(int32_t r2, int32_t r);
void instr_88_mem(int32_t addr, int32_t r);
void instr16_89_reg(int32_t r2, int32_t r);
void instr16_89_mem(int32_t addr, int32_t r);
void instr32_89_reg(int32_t r2, int32_t r);
void instr32_89_mem(int32_t addr, int32_t r);
void instr_8A_mem(int32_t addr, int32_t r);
void instr_8A_reg(int32_t r1, int32_t r);
void instr16_8B_mem(int32_t addr, int32_t r);
void instr16_8B_reg(int32_t r1, int32_t r);
void instr32_8B_mem(int32_t addr, int32_t r);
void instr32_8B_reg(int32_t r1, int32_t r);
void instr_8C_check_sreg(int32_t sreg);
void instr16_8C_reg(int32_t r, int32_t seg);
void instr16_8C_mem(int32_t addr, int32_t seg);
void instr32_8C_reg(int32_t r, int32_t seg);
void instr32_8C_mem(int32_t addr, int32_t seg);
void instr16_8D_reg(int32_t r, int32_t r2);
void instr16_8D_mem_pre(void);
void instr16_8D_mem(int32_t addr, int32_t r);
void instr32_8D_reg(int32_t r, int32_t r2);
void instr32_8D_mem_pre(void);
void instr32_8D_mem(int32_t addr, int32_t r);
void instr16_8D_mem_jit(int32_t modrm_byte);
void instr32_8D_mem_jit(int32_t modrm_byte);
void instr_8E_helper(int32_t data, int32_t mod);
void instr_8E_mem(int32_t addr, int32_t r);
void instr_8E_reg(int32_t r1, int32_t r);
void instr16_8F_0_mem_pre(void);
void instr16_8F_0_mem(int32_t addr);
void instr16_8F_0_reg(int32_t r);
void instr32_8F_0_mem_pre(void);
void instr32_8F_0_mem(int32_t addr);
void instr32_8F_0_reg(int32_t r);
void instr_90(void);
void instr16_91(void);
void instr32_91(void);
void instr16_92(void);
void instr32_92(void);
void instr16_93(void);
void instr32_93(void);
void instr16_94(void);
void instr32_94(void);
void instr16_95(void);
void instr32_95(void);
void instr16_96(void);
void instr32_96(void);
void instr16_97(void);
void instr32_97(void);
void instr16_98(void);
void instr32_98(void);
void instr16_99(void);
void instr32_99(void);
void instr16_9A(int32_t new_ip, int32_t new_cs);
void instr32_9A(int32_t new_ip, int32_t new_cs);
void instr_9B(void);
void instr16_9C(void);
void instr32_9C(void);
void instr16_9D(void);
void instr32_9D(void);
void instr_9E(void);
void instr_9F(void);
void instr_A0(int32_t moffs);
void instr16_A1(int32_t moffs);
void instr32_A1(int32_t moffs);
void instr_A2(int32_t moffs);
void instr16_A3(int32_t moffs);
void instr32_A3(int32_t moffs);
void instr_A4(void);
void instr16_A5(void);
void instr32_A5(void);
void instr_A6(void);
void instr16_A7(void);
void instr32_A7(void);
void instr_A8(int32_t imm8);
void instr16_A9(int32_t imm16);
void instr32_A9(int32_t imm32);
void instr_AA(void);
void instr16_AB(void);
void instr32_AB(void);
void instr_AC(void);
void instr16_AD(void);
void instr32_AD(void);
void instr_AE(void);
void instr16_AF(void);
void instr32_AF(void);
void instr_B0(int32_t imm8);
void instr_B1(int32_t imm8);
void instr_B2(int32_t imm8);
void instr_B3(int32_t imm8);
void instr_B4(int32_t imm8);
void instr_B5(int32_t imm8);
void instr_B6(int32_t imm8);
void instr_B7(int32_t imm8);
void instr16_B8(int32_t imm);
void instr32_B8(int32_t imm);
void instr16_B9(int32_t imm);
void instr32_B9(int32_t imm);
void instr16_BA(int32_t imm);
void instr32_BA(int32_t imm);
void instr16_BB(int32_t imm);
void instr32_BB(int32_t imm);
void instr16_BC(int32_t imm);
void instr32_BC(int32_t imm);
void instr16_BD(int32_t imm);
void instr32_BD(int32_t imm);
void instr16_BE(int32_t imm);
void instr32_BE(int32_t imm);
void instr16_BF(int32_t imm);
void instr32_BF(int32_t imm);
void instr_C0_0_mem(int32_t addr, int32_t imm);
void instr_C0_0_reg(int32_t r1, int32_t imm);
void instr_C0_1_mem(int32_t addr, int32_t imm);
void instr_C0_1_reg(int32_t r1, int32_t imm);
void instr_C0_2_mem(int32_t addr, int32_t imm);
void instr_C0_2_reg(int32_t r1, int32_t imm);
void instr_C0_3_mem(int32_t addr, int32_t imm);
void instr_C0_3_reg(int32_t r1, int32_t imm);
void instr_C0_4_mem(int32_t addr, int32_t imm);
void instr_C0_4_reg(int32_t r1, int32_t imm);
void instr_C0_5_mem(int32_t addr, int32_t imm);
void instr_C0_5_reg(int32_t r1, int32_t imm);
void instr_C0_6_mem(int32_t addr, int32_t imm);
void instr_C0_6_reg(int32_t r1, int32_t imm);
void instr_C0_7_mem(int32_t addr, int32_t imm);
void instr_C0_7_reg(int32_t r1, int32_t imm);
void instr16_C1_0_mem(int32_t addr, int32_t imm);
void instr16_C1_0_reg(int32_t r1, int32_t imm);
void instr16_C1_1_mem(int32_t addr, int32_t imm);
void instr16_C1_1_reg(int32_t r1, int32_t imm);
void instr16_C1_2_mem(int32_t addr, int32_t imm);
void instr16_C1_2_reg(int32_t r1, int32_t imm);
void instr16_C1_3_mem(int32_t addr, int32_t imm);
void instr16_C1_3_reg(int32_t r1, int32_t imm);
void instr16_C1_4_mem(int32_t addr, int32_t imm);
void instr16_C1_4_reg(int32_t r1, int32_t imm);
void instr16_C1_5_mem(int32_t addr, int32_t imm);
void instr16_C1_5_reg(int32_t r1, int32_t imm);
void instr16_C1_6_mem(int32_t addr, int32_t imm);
void instr16_C1_6_reg(int32_t r1, int32_t imm);
void instr16_C1_7_mem(int32_t addr, int32_t imm);
void instr16_C1_7_reg(int32_t r1, int32_t imm);
void instr32_C1_0_mem(int32_t addr, int32_t imm);
void instr32_C1_0_reg(int32_t r1, int32_t imm);
void instr32_C1_1_mem(int32_t addr, int32_t imm);
void instr32_C1_1_reg(int32_t r1, int32_t imm);
void instr32_C1_2_mem(int32_t addr, int32_t imm);
void instr32_C1_2_reg(int32_t r1, int32_t imm);
void instr32_C1_3_mem(int32_t addr, int32_t imm);
void instr32_C1_3_reg(int32_t r1, int32_t imm);
void instr32_C1_4_mem(int32_t addr, int32_t imm);
void instr32_C1_4_reg(int32_t r1, int32_t imm);
void instr32_C1_5_mem(int32_t addr, int32_t imm);
void instr32_C1_5_reg(int32_t r1, int32_t imm);
void instr32_C1_6_mem(int32_t addr, int32_t imm);
void instr32_C1_6_reg(int32_t r1, int32_t imm);
void instr32_C1_7_mem(int32_t addr, int32_t imm);
void instr32_C1_7_reg(int32_t r1, int32_t imm);
void instr16_C2(int32_t imm16);
void instr32_C2(int32_t imm16);
void instr16_C3(void);
void instr32_C3(void);
void instr16_C4_reg(int32_t _unused1, int32_t _unused2);
void instr16_C4_mem(int32_t addr, int32_t r);
void instr32_C4_reg(int32_t _unused1, int32_t _unused2);
void instr32_C4_mem(int32_t addr, int32_t r);
void instr16_C5_reg(int32_t _unused1, int32_t _unused2);
void instr16_C5_mem(int32_t addr, int32_t r);
void instr32_C5_reg(int32_t _unused1, int32_t _unused2);
void instr32_C5_mem(int32_t addr, int32_t r);
void instr_C6_0_reg(int32_t r, int32_t imm);
void instr_C6_0_mem(int32_t addr, int32_t imm);
void instr16_C7_0_reg(int32_t r, int32_t imm);
void instr16_C7_0_mem(int32_t addr, int32_t imm);
void instr32_C7_0_reg(int32_t r, int32_t imm);
void instr32_C7_0_mem(int32_t addr, int32_t imm);
void instr16_C8(int32_t size, int32_t nesting);
void instr32_C8(int32_t size, int32_t nesting);
void instr16_C9(void);
void instr32_C9(void);
void instr16_CA(int32_t imm16);
void instr32_CA(int32_t imm16);
void instr16_CB(void);
void instr32_CB(void);
void instr_CC(void);
void instr_CD(int32_t imm8);
void instr_CE(void);
void instr16_CF(void);
void instr32_CF(void);
void instr_D0_0_mem(int32_t addr);
void instr_D0_0_reg(int32_t r1);
void instr_D0_1_mem(int32_t addr);
void instr_D0_1_reg(int32_t r1);
void instr_D0_2_mem(int32_t addr);
void instr_D0_2_reg(int32_t r1);
void instr_D0_3_mem(int32_t addr);
void instr_D0_3_reg(int32_t r1);
void instr_D0_4_mem(int32_t addr);
void instr_D0_4_reg(int32_t r1);
void instr_D0_5_mem(int32_t addr);
void instr_D0_5_reg(int32_t r1);
void instr_D0_6_mem(int32_t addr);
void instr_D0_6_reg(int32_t r1);
void instr_D0_7_mem(int32_t addr);
void instr_D0_7_reg(int32_t r1);
void instr16_D1_0_mem(int32_t addr);
void instr16_D1_0_reg(int32_t r1);
void instr16_D1_1_mem(int32_t addr);
void instr16_D1_1_reg(int32_t r1);
void instr16_D1_2_mem(int32_t addr);
void instr16_D1_2_reg(int32_t r1);
void instr16_D1_3_mem(int32_t addr);
void instr16_D1_3_reg(int32_t r1);
void instr16_D1_4_mem(int32_t addr);
void instr16_D1_4_reg(int32_t r1);
void instr16_D1_5_mem(int32_t addr);
void instr16_D1_5_reg(int32_t r1);
void instr16_D1_6_mem(int32_t addr);
void instr16_D1_6_reg(int32_t r1);
void instr16_D1_7_mem(int32_t addr);
void instr16_D1_7_reg(int32_t r1);
void instr32_D1_0_mem(int32_t addr);
void instr32_D1_0_reg(int32_t r1);
void instr32_D1_1_mem(int32_t addr);
void instr32_D1_1_reg(int32_t r1);
void instr32_D1_2_mem(int32_t addr);
void instr32_D1_2_reg(int32_t r1);
void instr32_D1_3_mem(int32_t addr);
void instr32_D1_3_reg(int32_t r1);
void instr32_D1_4_mem(int32_t addr);
void instr32_D1_4_reg(int32_t r1);
void instr32_D1_5_mem(int32_t addr);
void instr32_D1_5_reg(int32_t r1);
void instr32_D1_6_mem(int32_t addr);
void instr32_D1_6_reg(int32_t r1);
void instr32_D1_7_mem(int32_t addr);
void instr32_D1_7_reg(int32_t r1);
void instr_D2_0_mem(int32_t addr);
void instr_D2_0_reg(int32_t r1);
void instr_D2_1_mem(int32_t addr);
void instr_D2_1_reg(int32_t r1);
void instr_D2_2_mem(int32_t addr);
void instr_D2_2_reg(int32_t r1);
void instr_D2_3_mem(int32_t addr);
void instr_D2_3_reg(int32_t r1);
void instr_D2_4_mem(int32_t addr);
void instr_D2_4_reg(int32_t r1);
void instr_D2_5_mem(int32_t addr);
void instr_D2_5_reg(int32_t r1);
void instr_D2_6_mem(int32_t addr);
void instr_D2_6_reg(int32_t r1);
void instr_D2_7_mem(int32_t addr);
void instr_D2_7_reg(int32_t r1);
void instr16_D3_0_mem(int32_t addr);
void instr16_D3_0_reg(int32_t r1);
void instr16_D3_1_mem(int32_t addr);
void instr16_D3_1_reg(int32_t r1);
void instr16_D3_2_mem(int32_t addr);
void instr16_D3_2_reg(int32_t r1);
void instr16_D3_3_mem(int32_t addr);
void instr16_D3_3_reg(int32_t r1);
void instr16_D3_4_mem(int32_t addr);
void instr16_D3_4_reg(int32_t r1);
void instr16_D3_5_mem(int32_t addr);
void instr16_D3_5_reg(int32_t r1);
void instr16_D3_6_mem(int32_t addr);
void instr16_D3_6_reg(int32_t r1);
void instr16_D3_7_mem(int32_t addr);
void instr16_D3_7_reg(int32_t r1);
void instr32_D3_0_mem(int32_t addr);
void instr32_D3_0_reg(int32_t r1);
void instr32_D3_1_mem(int32_t addr);
void instr32_D3_1_reg(int32_t r1);
void instr32_D3_2_mem(int32_t addr);
void instr32_D3_2_reg(int32_t r1);
void instr32_D3_3_mem(int32_t addr);
void instr32_D3_3_reg(int32_t r1);
void instr32_D3_4_mem(int32_t addr);
void instr32_D3_4_reg(int32_t r1);
void instr32_D3_5_mem(int32_t addr);
void instr32_D3_5_reg(int32_t r1);
void instr32_D3_6_mem(int32_t addr);
void instr32_D3_6_reg(int32_t r1);
void instr32_D3_7_mem(int32_t addr);
void instr32_D3_7_reg(int32_t r1);
void instr_D4(int32_t arg);
void instr_D5(int32_t arg);
void instr_D6(void);
void instr_D7(void);
void instr_D8_0_mem(int32_t addr);
void instr_D8_0_reg(int32_t r);
void instr_D8_1_mem(int32_t addr);
void instr_D8_1_reg(int32_t r);
void instr_D8_2_mem(int32_t addr);
void instr_D8_2_reg(int32_t r);
void instr_D8_3_mem(int32_t addr);
void instr_D8_3_reg(int32_t r);
void instr_D8_4_mem(int32_t addr);
void instr_D8_4_reg(int32_t r);
void instr_D8_5_mem(int32_t addr);
void instr_D8_5_reg(int32_t r);
void instr_D8_6_mem(int32_t addr);
void instr_D8_6_reg(int32_t r);
void instr_D8_7_mem(int32_t addr);
void instr_D8_7_reg(int32_t r);
void instr_D9_0_mem(int32_t addr);
void instr_D9_0_reg(int32_t r);
void instr_D9_1_mem(int32_t addr);
void instr_D9_1_reg(int32_t r);
void instr_D9_2_mem(int32_t addr);
void instr_D9_2_reg(int32_t r);
void instr_D9_3_mem(int32_t addr);
void instr_D9_3_reg(int32_t r);
void instr_D9_4_mem(int32_t addr);
void instr_D9_4_reg(int32_t r);
void instr_D9_5_mem(int32_t addr);
void instr_D9_5_reg(int32_t r);
void instr_D9_6_mem(int32_t addr);
void instr_D9_6_reg(int32_t r);
void instr_D9_7_mem(int32_t addr);
void instr_D9_7_reg(int32_t r);
void instr_DA_0_mem(int32_t addr);
void instr_DA_0_reg(int32_t r);
void instr_DA_1_mem(int32_t addr);
void instr_DA_1_reg(int32_t r);
void instr_DA_2_mem(int32_t addr);
void instr_DA_2_reg(int32_t r);
void instr_DA_3_mem(int32_t addr);
void instr_DA_3_reg(int32_t r);
void instr_DA_4_mem(int32_t addr);
void instr_DA_4_reg(int32_t r);
void instr_DA_5_mem(int32_t addr);
void instr_DA_5_reg(int32_t r);
void instr_DA_6_mem(int32_t addr);
void instr_DA_6_reg(int32_t r);
void instr_DA_7_mem(int32_t addr);
void instr_DA_7_reg(int32_t r);
void instr_DB_mem(int32_t addr, int32_t r);
void instr_DB_reg(int32_t r2, int32_t r);
void instr_DC_mem(int32_t addr, int32_t r);
void instr_DC_reg(int32_t r2, int32_t r);
void instr_DD_mem(int32_t addr, int32_t r);
void instr_DD_reg(int32_t r2, int32_t r);
void instr_DE_mem(int32_t addr, int32_t r);
void instr_DE_reg(int32_t r2, int32_t r);
void instr_DF_mem(int32_t addr, int32_t r);
void instr_DF_reg(int32_t r2, int32_t r);
void instr_E0(int32_t off);
void instr_E1(int32_t off);
void instr_E2(int32_t off);
void instr_E3(int32_t off);
void instr_E4(int32_t port);
void instr16_E5(int32_t port);
void instr32_E5(int32_t port);
void instr_E6(int32_t port);
void instr16_E7(int32_t port);
void instr32_E7(int32_t port);
void instr16_E8(int32_t imm16);
void instr32_E8(int32_t imm32s);
void instr16_E9(int32_t imm16);
void instr32_E9(int32_t imm32s);
void instr16_EA(int32_t new_ip, int32_t cs);
void instr32_EA(int32_t new_ip, int32_t cs);
void instr_EB(int32_t imm8);
void instr_EC(void);
void instr16_ED(void);
void instr32_ED(void);
void instr_EE(void);
void instr16_EF(void);
void instr32_EF(void);
void instr_F0(void);
jit_instr_flags instr_F0_jit(void);
void instr_F1(void);
void instr_F2(void);
jit_instr_flags instr_F2_jit(void);
void instr_F3(void);
jit_instr_flags instr_F3_jit(void);
void instr_F4(void);
void instr_F5(void);
void instr_F6_0_mem(int32_t addr, int32_t imm);
void instr_F6_0_reg(int32_t r1, int32_t imm);
void instr_F6_1_mem(int32_t addr, int32_t imm);
void instr_F6_1_reg(int32_t r1, int32_t imm);
void instr_F6_2_mem(int32_t addr);
void instr_F6_2_reg(int32_t r1);
void instr_F6_3_mem(int32_t addr);
void instr_F6_3_reg(int32_t r1);
void instr_F6_4_mem(int32_t addr);
void instr_F6_4_reg(int32_t r1);
void instr_F6_5_mem(int32_t addr);
void instr_F6_5_reg(int32_t r1);
void instr_F6_6_mem(int32_t addr);
void instr_F6_6_reg(int32_t r1);
void instr_F6_7_mem(int32_t addr);
void instr_F6_7_reg(int32_t r1);
void instr16_F7_0_mem(int32_t addr, int32_t imm);
void instr16_F7_0_reg(int32_t r1, int32_t imm);
void instr16_F7_1_mem(int32_t addr, int32_t imm);
void instr16_F7_1_reg(int32_t r1, int32_t imm);
void instr16_F7_2_mem(int32_t addr);
void instr16_F7_2_reg(int32_t r1);
void instr16_F7_3_mem(int32_t addr);
void instr16_F7_3_reg(int32_t r1);
void instr16_F7_4_mem(int32_t addr);
void instr16_F7_4_reg(int32_t r1);
void instr16_F7_5_mem(int32_t addr);
void instr16_F7_5_reg(int32_t r1);
void instr16_F7_6_mem(int32_t addr);
void instr16_F7_6_reg(int32_t r1);
void instr16_F7_7_mem(int32_t addr);
void instr16_F7_7_reg(int32_t r1);
void instr32_F7_0_mem(int32_t addr, int32_t imm);
void instr32_F7_0_reg(int32_t r1, int32_t imm);
void instr32_F7_1_mem(int32_t addr, int32_t imm);
void instr32_F7_1_reg(int32_t r1, int32_t imm);
void instr32_F7_2_mem(int32_t addr);
void instr32_F7_2_reg(int32_t r1);
void instr32_F7_3_mem(int32_t addr);
void instr32_F7_3_reg(int32_t r1);
void instr32_F7_4_mem(int32_t addr);
void instr32_F7_4_reg(int32_t r1);
void instr32_F7_5_mem(int32_t addr);
void instr32_F7_5_reg(int32_t r1);
void instr32_F7_6_mem(int32_t addr);
void instr32_F7_6_reg(int32_t r1);
void instr32_F7_7_mem(int32_t addr);
void instr32_F7_7_reg(int32_t r1);
void instr_F8(void);
void instr_F9(void);
void instr_FA(void);
void instr_FB(void);
void instr_FC(void);
void instr_FD(void);
void instr_FE_0_mem(int32_t addr);
void instr_FE_0_reg(int32_t r1);
void instr_FE_1_mem(int32_t addr);
void instr_FE_1_reg(int32_t r1);
void instr16_FF_0_mem(int32_t addr);
void instr16_FF_0_reg(int32_t r1);
void instr16_FF_1_mem(int32_t addr);
void instr16_FF_1_reg(int32_t r1);
void instr16_FF_2_helper(int32_t data);
void instr16_FF_2_mem(int32_t addr);
void instr16_FF_2_reg(int32_t r1);
void instr16_FF_3_reg(int32_t r);
void instr16_FF_3_mem(int32_t addr);
void instr16_FF_4_helper(int32_t data);
void instr16_FF_4_mem(int32_t addr);
void instr16_FF_4_reg(int32_t r1);
void instr16_FF_5_reg(int32_t r);
void instr16_FF_5_mem(int32_t addr);
void instr16_FF_6_mem(int32_t addr);
void instr16_FF_6_reg(int32_t r1);
void instr32_FF_0_mem(int32_t addr);
void instr32_FF_0_reg(int32_t r1);
void instr32_FF_1_mem(int32_t addr);
void instr32_FF_1_reg(int32_t r1);
void instr32_FF_2_helper(int32_t data);
void instr32_FF_2_mem(int32_t addr);
void instr32_FF_2_reg(int32_t r1);
void instr32_FF_3_reg(int32_t r);
void instr32_FF_3_mem(int32_t addr);
void instr32_FF_4_helper(int32_t data);
void instr32_FF_4_mem(int32_t addr);
void instr32_FF_4_reg(int32_t r1);
void instr32_FF_5_reg(int32_t r);
void instr32_FF_5_mem(int32_t addr);
void instr32_FF_6_mem(int32_t addr);
void instr32_FF_6_reg(int32_t r1);
void run_instruction(int32_t opcode);
jit_instr_flags jit_instruction(int32_t opcode);
