#include <stdint.h>
#include <math.h>
#include <assert.h>
#include <stdbool.h>

#include <stdio.h>

#include "const.h"
#include "global_pointers.h"
#include "codegen/codegen.h"

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"

int32_t translate_address_write(int32_t);
int32_t resolve_modrm(int32_t);


#define SAFE_READ_WRITE8(addr, fun) \
    int32_t phys_addr = translate_address_write(addr); \
    int32_t ___ = read8(phys_addr); \
    write8(phys_addr, fun);

#define SAFE_READ_WRITE16(addr, fun) \
    int32_t phys_addr = translate_address_write(addr); \
    if((phys_addr & 0xFFF) == 0xFFF) \
    { \
        int32_t phys_addr_high = translate_address_write(addr + 1); \
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
        int32_t phys_addr_high = translate_address_write(addr + 3 & ~3) | (addr + 3) & 3; \
        int32_t ___ = virt_boundary_read32s(phys_addr, phys_addr_high); \
        virt_boundary_write32(phys_addr, phys_addr_high, fun); \
    } \
    else \
    { \
        int32_t ___ = read32s(phys_addr); \
        write32(phys_addr, fun); \
    }

// XXX: Remove these declarations when they are implemented in C
void push16(int32_t);
void push32(int32_t);

void pusha16(void);
void pusha32(void);
void popa16(void);
void popa32(void);
int32_t arpl(int32_t, int32_t);

void trigger_ud(void);
void trigger_nm(void);
void run_prefix_instruction(void);

int32_t pop16(void);
int32_t pop32s(void);

int32_t safe_read8(int32_t);
int32_t safe_read16(int32_t);
int32_t safe_read32s(int32_t);

void safe_write8(int32_t, int32_t);
void safe_write16(int32_t, int32_t);
void safe_write32(int32_t, int32_t);

void push32(int32_t);
int32_t get_stack_pointer(int32_t);
void adjust_stack_reg(int32_t);
void set_stack_reg(int32_t);

int32_t getiopl(void);
int32_t get_eflags(void);
int32_t getof(void);
int32_t getzf(void);

void switch_seg(int32_t, int32_t);

bool vm86_mode(void);

int32_t shl8(int32_t, int32_t);
int32_t shr8(int32_t, int32_t);
int32_t sar8(int32_t, int32_t);
int32_t ror8(int32_t, int32_t);
int32_t rol8(int32_t, int32_t);
int32_t rcr8(int32_t, int32_t);
int32_t rcl8(int32_t, int32_t);

int32_t shl16(int32_t, int32_t);
int32_t shr16(int32_t, int32_t);
int32_t sar16(int32_t, int32_t);
int32_t ror16(int32_t, int32_t);
int32_t rol16(int32_t, int32_t);
int32_t rcr16(int32_t, int32_t);
int32_t rcl16(int32_t, int32_t);

int32_t shl32(int32_t, int32_t);
int32_t shr32(int32_t, int32_t);
int32_t sar32(int32_t, int32_t);
int32_t ror32(int32_t, int32_t);
int32_t rol32(int32_t, int32_t);
int32_t rcr32(int32_t, int32_t);
int32_t rcl32(int32_t, int32_t);

void idiv16(int32_t);
void div32(uint32_t);
void idiv32(int32_t);


void insb(void);
void insw(void);
void insd(void);
void outsb(void);
void outsw(void);
void outsd(void);
void movsb(void);
void movsw(void);
void movsd(void);
void cmpsb(void);
void cmpsw(void);
void cmpsd(void);
void stosb(void);
void stosw(void);
void stosd(void);
void lodsb(void);
void lodsw(void);
void lodsd(void);
void scasb(void);
void scasw(void);
void scasd(void);

void fpu_op_D8_mem(int32_t, int32_t);
void fpu_op_D8_reg(int32_t);
void fpu_op_D9_mem(int32_t, int32_t);
void fpu_op_D9_reg(int32_t);
void fpu_op_DA_mem(int32_t, int32_t);
void fpu_op_DA_reg(int32_t);
void fpu_op_DB_mem(int32_t, int32_t);
void fpu_op_DB_reg(int32_t);
void fpu_op_DC_mem(int32_t, int32_t);
void fpu_op_DC_reg(int32_t);
void fpu_op_DD_mem(int32_t, int32_t);
void fpu_op_DD_reg(int32_t);
void fpu_op_DE_mem(int32_t, int32_t);
void fpu_op_DE_reg(int32_t);
void fpu_op_DF_mem(int32_t, int32_t);
void fpu_op_DF_reg(int32_t);

int32_t test_o(void);
int32_t test_b(void);
int32_t test_z(void);
int32_t test_s(void);
int32_t test_p(void);
int32_t test_be(void);
int32_t test_l(void);
int32_t test_le(void);

void jmpcc8(bool, int32_t);

void far_jump(int32_t, int32_t, int32_t);
void far_return(int32_t, int32_t, int32_t);

void iret16();
void iret32();

void lss16(int32_t, int32_t, int32_t);
void lss32(int32_t, int32_t, int32_t);

void enter16(int32_t, int32_t);
void enter32(int32_t, int32_t);

int32_t get_seg(int32_t);
int32_t get_seg_prefix(int32_t);
void update_eflags(int32_t);
void handle_irqs(void);
int32_t get_real_eip(void);
void diverged(void);

int32_t xchg8(int32_t, int32_t);
int32_t xchg16(int32_t, int32_t);
void xchg16r(int32_t);
int32_t xchg32(int32_t, int32_t);
void xchg32r(int32_t);

int32_t loop(int32_t);
int32_t loope(int32_t);
int32_t loopne(int32_t);

void bcd_aam(int32_t);
void task_switch_test(void);
void jcxz(int32_t);
void test_privileges_for_io(int32_t, int32_t);
int32_t io_port_read8(int32_t);
int32_t io_port_read16(int32_t);
int32_t io_port_read32(int32_t);
void jmp_rel16(int32_t);
void hlt_op(void);

void io_port_write8(int32_t, int32_t);
void io_port_write16(int32_t, int32_t);
void io_port_write32(int32_t, int32_t);

int32_t modrm_resolve(int32_t);

void run_instruction0f_16(int32_t);
void run_instruction0f_32(int32_t);

void jit_instruction0f_16(int32_t);
void jit_instruction0f_32(int32_t);

void clear_prefixes(void);
void cycle_internal(void);

void fwait(void);


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


DEFINE_MODRM_INSTR_READ_WRITE_8(instr_00, add8(___, read_reg8(r)))
DEFINE_MODRM_INSTR_READ_WRITE_16(instr16_01, add16(___, read_reg16(r)))
DEFINE_MODRM_INSTR_READ_WRITE_32(instr32_01, add32(___, read_reg32(r)))
DEFINE_MODRM_INSTR_READ8(instr_02, write_reg8(r, add8(read_reg8(r), ___)))
DEFINE_MODRM_INSTR_READ16(instr16_03, write_reg16(r, add16(read_reg16(r), ___)))
DEFINE_MODRM_INSTR_READ32(instr32_03, write_reg32(r, add32(read_reg32(r), ___)))
void instr_04(int32_t imm8) { reg8[AL] = add8(reg8[AL], imm8); }
void instr16_05(int32_t imm16) { reg16[AX] = add16(reg16[AX], imm16); }
void instr32_05(int32_t imm32) { reg32s[EAX] = add32(reg32s[EAX], imm32); }

void instr16_06() { push16(sreg[ES]); }
void instr32_06() { push32(sreg[ES]); }
void instr16_07() {
    switch_seg(ES, safe_read16(get_stack_pointer(0)));
    adjust_stack_reg(2);
}
void instr32_07() {
    switch_seg(ES, safe_read32s(get_stack_pointer(0)) & 0xFFFF);
    adjust_stack_reg(4);
}

DEFINE_MODRM_INSTR_READ_WRITE_8(instr_08, or8(___, read_reg8(r)))
DEFINE_MODRM_INSTR_READ_WRITE_16(instr16_09, or16(___, read_reg16(r)))
DEFINE_MODRM_INSTR_READ_WRITE_32(instr32_09, or32(___, read_reg32(r)))
DEFINE_MODRM_INSTR_READ8(instr_0A, write_reg8(r, or8(read_reg8(r), ___)))
DEFINE_MODRM_INSTR_READ16(instr16_0B, write_reg16(r, or16(read_reg16(r), ___)))
DEFINE_MODRM_INSTR_READ32(instr32_0B, write_reg32(r, or32(read_reg32(r), ___)))
void instr_0C(int32_t imm8) { reg8[AL] = or8(reg8[AL], imm8); }
void instr16_0D(int32_t imm16) { reg16[AX] = or16(reg16[AX], imm16); }
void instr32_0D(int32_t imm32) { reg32s[EAX] = or32(reg32s[EAX], imm32); }


void instr16_0E() { push16(sreg[CS]); }
void instr32_0E() { push32(sreg[CS]); }
void instr16_0F() {
    run_instruction0f_16(read_imm8());
}
void instr32_0F() {
    run_instruction0f_32(read_imm8());
}

void instr16_0F_jit() {
    jit_instruction0f_16(read_imm8());
}
void instr32_0F_jit() {
    jit_instruction0f_32(read_imm8());
}


DEFINE_MODRM_INSTR_READ_WRITE_8(instr_10, adc8(___, read_reg8(r)))
DEFINE_MODRM_INSTR_READ_WRITE_16(instr16_11, adc16(___, read_reg16(r)))
DEFINE_MODRM_INSTR_READ_WRITE_32(instr32_11, adc32(___, read_reg32(r)))
DEFINE_MODRM_INSTR_READ8(instr_12, write_reg8(r, adc8(read_reg8(r), ___)))
DEFINE_MODRM_INSTR_READ16(instr16_13, write_reg16(r, adc16(read_reg16(r), ___)))
DEFINE_MODRM_INSTR_READ32(instr32_13, write_reg32(r, adc32(read_reg32(r), ___)))
void instr_14(int32_t imm8) { reg8[AL] = adc8(reg8[AL], imm8); }
void instr16_15(int32_t imm16) { reg16[AX] = adc16(reg16[AX], imm16); }
void instr32_15(int32_t imm32) { reg32s[EAX] = adc32(reg32s[EAX], imm32); }

void instr16_16() { push16(sreg[SS]); }
void instr32_16() { push32(sreg[SS]); }
void instr16_17() {
    switch_seg(SS, safe_read16(get_stack_pointer(0)));
    adjust_stack_reg(2);
    //clear_prefixes();
    //cycle_internal();
}
void instr32_17() {
    switch_seg(SS, safe_read32s(get_stack_pointer(0)) & 0xFFFF);
    adjust_stack_reg(4);
    //clear_prefixes();
    //cycle_internal();
}

DEFINE_MODRM_INSTR_READ_WRITE_8(instr_18, sbb8(___, read_reg8(r)))
DEFINE_MODRM_INSTR_READ_WRITE_16(instr16_19, sbb16(___, read_reg16(r)))
DEFINE_MODRM_INSTR_READ_WRITE_32(instr32_19, sbb32(___, read_reg32(r)))
DEFINE_MODRM_INSTR_READ8(instr_1A, write_reg8(r, sbb8(read_reg8(r), ___)))
DEFINE_MODRM_INSTR_READ16(instr16_1B, write_reg16(r, sbb16(read_reg16(r), ___)))
DEFINE_MODRM_INSTR_READ32(instr32_1B, write_reg32(r, sbb32(read_reg32(r), ___)))
void instr_1C(int32_t imm8) { reg8[AL] = sbb8(reg8[AL], imm8); }
void instr16_1D(int32_t imm16) { reg16[AX] = sbb16(reg16[AX], imm16); }
void instr32_1D(int32_t imm32) { reg32s[EAX] = sbb32(reg32s[EAX], imm32); }


void instr16_1E() { push16(sreg[DS]); }
void instr32_1E() { push32(sreg[DS]); }
void instr16_1F() {
    switch_seg(DS, safe_read16(get_stack_pointer(0)));
    adjust_stack_reg(2);
}
void instr32_1F() {
    switch_seg(DS, safe_read32s(get_stack_pointer(0)) & 0xFFFF);
    adjust_stack_reg(4);
}

DEFINE_MODRM_INSTR_READ_WRITE_8(instr_20, and8(___, read_reg8(r)))
DEFINE_MODRM_INSTR_READ_WRITE_16(instr16_21, and16(___, read_reg16(r)))
DEFINE_MODRM_INSTR_READ_WRITE_32(instr32_21, and32(___, read_reg32(r)))
DEFINE_MODRM_INSTR_READ8(instr_22, write_reg8(r, and8(read_reg8(r), ___)))
DEFINE_MODRM_INSTR_READ16(instr16_23, write_reg16(r, and16(read_reg16(r), ___)))
DEFINE_MODRM_INSTR_READ32(instr32_23, write_reg32(r, and32(read_reg32(r), ___)))
void instr_24(int32_t imm8) { reg8[AL] = and8(reg8[AL], imm8); }
void instr16_25(int32_t imm16) { reg16[AX] = and16(reg16[AX], imm16); }
void instr32_25(int32_t imm32) { reg32s[EAX] = and32(reg32s[EAX], imm32); }


void instr_26() { segment_prefix_op(ES); }
void instr_26_jit() { segment_prefix_op_jit(ES); }
void instr_27() { bcd_daa(); }

DEFINE_MODRM_INSTR_READ_WRITE_8(instr_28, sub8(___, read_reg8(r)))
DEFINE_MODRM_INSTR_READ_WRITE_16(instr16_29, sub16(___, read_reg16(r)))
DEFINE_MODRM_INSTR_READ_WRITE_32(instr32_29, sub32(___, read_reg32(r)))
DEFINE_MODRM_INSTR_READ8(instr_2A, write_reg8(r, sub8(read_reg8(r), ___)))
DEFINE_MODRM_INSTR_READ16(instr16_2B, write_reg16(r, sub16(read_reg16(r), ___)))
DEFINE_MODRM_INSTR_READ32(instr32_2B, write_reg32(r, sub32(read_reg32(r), ___)))
void instr_2C(int32_t imm8) { reg8[AL] = sub8(reg8[AL], imm8); }
void instr16_2D(int32_t imm16) { reg16[AX] = sub16(reg16[AX], imm16); }
void instr32_2D(int32_t imm32) { reg32s[EAX] = sub32(reg32s[EAX], imm32); }

void instr_2E() { segment_prefix_op(CS); }
void instr_2E_jit() { segment_prefix_op_jit(CS); }
void instr_2F() { bcd_das(); }

DEFINE_MODRM_INSTR_READ_WRITE_8(instr_30, xor8(___, read_reg8(r)))
DEFINE_MODRM_INSTR_READ_WRITE_16(instr16_31, xor16(___, read_reg16(r)))
DEFINE_MODRM_INSTR_READ_WRITE_32(instr32_31, xor32(___, read_reg32(r)))
DEFINE_MODRM_INSTR_READ8(instr_32, write_reg8(r, xor8(read_reg8(r), ___)))
DEFINE_MODRM_INSTR_READ16(instr16_33, write_reg16(r, xor16(read_reg16(r), ___)))
DEFINE_MODRM_INSTR_READ32(instr32_33, write_reg32(r, xor32(read_reg32(r), ___)))
void instr_34(int32_t imm8) { reg8[AL] = xor8(reg8[AL], imm8); }
void instr16_35(int32_t imm16) { reg16[AX] = xor16(reg16[AX], imm16); }
void instr32_35(int32_t imm32) { reg32s[EAX] = xor32(reg32s[EAX], imm32); }

void instr_36() { segment_prefix_op(SS); }
void instr_36_jit() { segment_prefix_op_jit(SS); }
void instr_37() { bcd_aaa(); }

DEFINE_MODRM_INSTR_READ8(instr_38, cmp8(___, read_reg8(r)))
DEFINE_MODRM_INSTR_READ16(instr16_39, cmp16(___, read_reg16(r)))
DEFINE_MODRM_INSTR_READ32(instr32_39, cmp32(___, read_reg32(r)))
DEFINE_MODRM_INSTR_READ8(instr_3A, cmp8(read_reg8(r), ___))
DEFINE_MODRM_INSTR_READ16(instr16_3B, cmp16(read_reg16(r), ___))
DEFINE_MODRM_INSTR_READ32(instr32_3B, cmp32(read_reg32(r), ___))
void instr_3C(int32_t imm8) { cmp8(reg8[AL], imm8); }
void instr16_3D(int32_t imm16) { cmp16(reg16[AX], imm16); }
void instr32_3D(int32_t imm32) { cmp32(reg32s[EAX], imm32); }

void instr_3E() { segment_prefix_op(DS); }
void instr_3E_jit() { segment_prefix_op_jit(DS); }
void instr_3F() { bcd_aas(); }


void instr16_40() { reg16[AX] = inc16(reg16[AX]); }
void instr32_40() { reg32s[EAX] = inc32(reg32s[EAX]); }
void instr16_41() { reg16[CX] = inc16(reg16[CX]); }
void instr32_41() { reg32s[ECX] = inc32(reg32s[ECX]); }
void instr16_42() { reg16[DX] = inc16(reg16[DX]); }
void instr32_42() { reg32s[EDX] = inc32(reg32s[EDX]); }
void instr16_43() { reg16[BX] = inc16(reg16[BX]); }
void instr32_43() { reg32s[EBX] = inc32(reg32s[EBX]); }
void instr16_44() { reg16[SP] = inc16(reg16[SP]); }
void instr32_44() { reg32s[ESP] = inc32(reg32s[ESP]); }
void instr16_45() { reg16[BP] = inc16(reg16[BP]); }
void instr32_45() { reg32s[EBP] = inc32(reg32s[EBP]); }
void instr16_46() { reg16[SI] = inc16(reg16[SI]); }
void instr32_46() { reg32s[ESI] = inc32(reg32s[ESI]); }
void instr16_47() { reg16[DI] = inc16(reg16[DI]); }
void instr32_47() { reg32s[EDI] = inc32(reg32s[EDI]); }


void instr16_48() { reg16[AX] = dec16(reg16[AX]); }
void instr32_48() { reg32s[EAX] = dec32(reg32s[EAX]); }
void instr16_49() { reg16[CX] = dec16(reg16[CX]); }
void instr32_49() { reg32s[ECX] = dec32(reg32s[ECX]); }
void instr16_4A() { reg16[DX] = dec16(reg16[DX]); }
void instr32_4A() { reg32s[EDX] = dec32(reg32s[EDX]); }
void instr16_4B() { reg16[BX] = dec16(reg16[BX]); }
void instr32_4B() { reg32s[EBX] = dec32(reg32s[EBX]); }
void instr16_4C() { reg16[SP] = dec16(reg16[SP]); }
void instr32_4C() { reg32s[ESP] = dec32(reg32s[ESP]); }
void instr16_4D() { reg16[BP] = dec16(reg16[BP]); }
void instr32_4D() { reg32s[EBP] = dec32(reg32s[EBP]); }
void instr16_4E() { reg16[SI] = dec16(reg16[SI]); }
void instr32_4E() { reg32s[ESI] = dec32(reg32s[ESI]); }
void instr16_4F() { reg16[DI] = dec16(reg16[DI]); }
void instr32_4F() { reg32s[EDI] = dec32(reg32s[EDI]); }


void instr16_50() { push16(reg16[AX]); }
void instr32_50() { push32(reg32s[EAX]); }
void instr16_51() { push16(reg16[CX]); }
void instr32_51() { push32(reg32s[ECX]); }
void instr16_52() { push16(reg16[DX]); }
void instr32_52() { push32(reg32s[EDX]); }
void instr16_53() { push16(reg16[BX]); }
void instr32_53() { push32(reg32s[EBX]); }
void instr16_54() { push16(reg16[SP]); }
void instr32_54() { push32(reg32s[ESP]); }
void instr16_55() { push16(reg16[BP]); }
void instr32_55() { push32(reg32s[EBP]); }
void instr16_56() { push16(reg16[SI]); }
void instr32_56() { push32(reg32s[ESI]); }
void instr16_57() { push16(reg16[DI]); }
void instr32_57() { push32(reg32s[EDI]); }

void instr16_58() { reg16[AX] = pop16(); }
void instr32_58() { reg32s[EAX] = pop32s(); }
void instr16_59() { reg16[CX] = pop16(); }
void instr32_59() { reg32s[ECX] = pop32s(); }
void instr16_5A() { reg16[DX] = pop16(); }
void instr32_5A() { reg32s[EDX] = pop32s(); }
void instr16_5B() { reg16[BX] = pop16(); }
void instr32_5B() { reg32s[EBX] = pop32s(); }
void instr16_5C() { reg16[SP] = pop16(); }
void instr32_5C() { reg32s[ESP] = pop32s(); }
void instr16_5D() { reg16[BP] = pop16(); }
void instr32_5D() { reg32s[EBP] = pop32s(); }
void instr16_5E() { reg16[SI] = pop16(); }
void instr32_5E() { reg32s[ESI] = pop32s(); }
void instr16_5F() { reg16[DI] = pop16(); }
void instr32_5F() { reg32s[EDI] = pop32s(); }


void instr16_60() { pusha16(); }
void instr32_60() { pusha32(); }
void instr16_61() { popa16(); }
void instr32_61() { popa32(); }

void instr_62_reg(int32_t r2, int32_t r) {
    // bound
    dbg_log("Unimplemented BOUND instruction");
    dbg_assert(false);
}
void instr_62_mem(int32_t addr, int32_t r) {
    dbg_log("Unimplemented BOUND instruction");
    dbg_assert(false);
}

DEFINE_MODRM_INSTR_READ_WRITE_16(instr_63, arpl(___, read_reg16(r)))

void instr_64() { segment_prefix_op(FS); }
void instr_64_jit() { segment_prefix_op_jit(FS); }
void instr_65() { segment_prefix_op(GS); }
void instr_65_jit() { segment_prefix_op_jit(GS); }

void instr_66() {
    // Operand-size override prefix
    *prefixes |= PREFIX_MASK_OPSIZE;
    run_prefix_instruction();
    *prefixes = 0;
}
void instr_66_jit() {
    // Operand-size override prefix

    // This affects both decoding and instructions at runtime, so we set
    // prefixes directly *and* in the generated code
    *prefixes |= PREFIX_MASK_OPSIZE;
    gen_add_prefix_bits(PREFIX_MASK_OPSIZE);
    jit_prefix_instruction();
    *prefixes = 0;
    gen_clear_prefixes();
}

void instr_67() {
    // Address-size override prefix
    dbg_assert(is_asize_32() == *is_32);
    *prefixes |= PREFIX_MASK_ADDRSIZE;
    run_prefix_instruction();
    *prefixes = 0;
}
void instr_67_jit() {
    // Address-size override prefix

    // This affects both decoding and instructions at runtime, so we set
    // prefixes directly *and* in the generated code
    dbg_assert(is_asize_32() == *is_32);
    *prefixes |= PREFIX_MASK_ADDRSIZE;
    gen_add_prefix_bits(PREFIX_MASK_ADDRSIZE);
    jit_prefix_instruction();
    *prefixes = 0;
    gen_clear_prefixes();
}

void instr16_68(int32_t imm16) { push16(imm16); }
void instr32_68(int32_t imm32) { push32(imm32); }

void instr16_69_mem(int32_t addr, int32_t r, int32_t imm) { write_reg16(r, imul_reg16(safe_read16(addr) << 16 >> 16, imm << 16 >> 16)); }
void instr16_69_reg(int32_t r1, int32_t r, int32_t imm) { write_reg16(r, imul_reg16(read_reg16(r1) << 16 >> 16, imm << 16 >> 16)); }
void instr32_69_mem(int32_t addr, int32_t r, int32_t imm) { write_reg32(r, imul_reg32(safe_read32s(addr), imm)); }
void instr32_69_reg(int32_t r1, int32_t r, int32_t imm) { write_reg32(r, imul_reg32(read_reg32(r1), imm)); }

void instr16_6A(int32_t imm8) { push16(imm8); }
void instr32_6A(int32_t imm8) { push32(imm8); }

void instr16_6B_mem(int32_t addr, int32_t r, int32_t imm) { write_reg16(r, imul_reg16(safe_read16(addr) << 16 >> 16, imm)); }
void instr16_6B_reg(int32_t r1, int32_t r, int32_t imm) { write_reg16(r, imul_reg16(read_reg16(r1) << 16 >> 16, imm)); }
void instr32_6B_mem(int32_t addr, int32_t r, int32_t imm) { write_reg32(r, imul_reg32(safe_read32s(addr), imm)); }
void instr32_6B_reg(int32_t r1, int32_t r, int32_t imm) { write_reg32(r, imul_reg32(read_reg32(r1), imm)); }

void instr_6C() { insb(); }
void instr16_6D() { insw(); }
void instr32_6D() { insd(); }
void instr_6E() { outsb(); }
void instr16_6F() { outsw(); }
void instr32_6F() { outsd(); }

void instr_70(int32_t imm8) { jmpcc8( test_o(), imm8); }
void instr_71(int32_t imm8) { jmpcc8(!test_o(), imm8); }
void instr_72(int32_t imm8) { jmpcc8( test_b(), imm8); }
void instr_73(int32_t imm8) { jmpcc8(!test_b(), imm8); }
void instr_74(int32_t imm8) { jmpcc8( test_z(), imm8); }
void instr_75(int32_t imm8) { jmpcc8(!test_z(), imm8); }
void instr_76(int32_t imm8) { jmpcc8( test_be(), imm8); }
void instr_77(int32_t imm8) { jmpcc8(!test_be(), imm8); }
void instr_78(int32_t imm8) { jmpcc8( test_s(), imm8); }
void instr_79(int32_t imm8) { jmpcc8(!test_s(), imm8); }
void instr_7A(int32_t imm8) { jmpcc8( test_p(), imm8); }
void instr_7B(int32_t imm8) { jmpcc8(!test_p(), imm8); }
void instr_7C(int32_t imm8) { jmpcc8( test_l(), imm8); }
void instr_7D(int32_t imm8) { jmpcc8(!test_l(), imm8); }
void instr_7E(int32_t imm8) { jmpcc8( test_le(), imm8); }
void instr_7F(int32_t imm8) { jmpcc8(!test_le(), imm8); }

DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_80_0, add8(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_80_1,  or8(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_80_2, adc8(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_80_3, sbb8(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_80_4, and8(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_80_5, sub8(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_80_6, xor8(___, imm))
void instr_80_7_reg(int32_t r, int32_t imm) { cmp8(read_reg8(r), imm); }
void instr_80_7_mem(int32_t addr, int32_t imm) { cmp8(safe_read8(addr), imm); }

DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_81_0, add16(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_81_1,  or16(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_81_2, adc16(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_81_3, sbb16(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_81_4, and16(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_81_5, sub16(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_81_6, xor16(___, imm))
void instr16_81_7_reg(int32_t r, int32_t imm) { cmp16(read_reg16(r), imm); }
void instr16_81_7_mem(int32_t addr, int32_t imm) { cmp16(safe_read16(addr), imm); }

DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_81_0, add32(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_81_1,  or32(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_81_2, adc32(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_81_3, sbb32(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_81_4, and32(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_81_5, sub32(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_81_6, xor32(___, imm))
void instr32_81_7_reg(int32_t r, int32_t imm) { cmp32(read_reg32(r), imm); }
void instr32_81_7_mem(int32_t addr, int32_t imm) { cmp32(safe_read32s(addr), imm); }

DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_82_0, add8(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_82_1,  or8(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_82_2, adc8(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_82_3, sbb8(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_82_4, and8(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_82_5, sub8(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_82_6, xor8(___, imm))
void instr_82_7_reg(int32_t r, int32_t imm) { cmp8(read_reg8(r), imm); }
void instr_82_7_mem(int32_t addr, int32_t imm) { cmp8(safe_read8(addr), imm); }

DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_83_0, add16(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_83_1,  or16(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_83_2, adc16(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_83_3, sbb16(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_83_4, and16(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_83_5, sub16(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_83_6, xor16(___, imm))
void instr16_83_7_reg(int32_t r, int32_t imm) { cmp16(read_reg16(r), imm); }
void instr16_83_7_mem(int32_t addr, int32_t imm) { cmp16(safe_read16(addr), imm); }

DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_83_0, add32(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_83_1,  or32(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_83_2, adc32(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_83_3, sbb32(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_83_4, and32(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_83_5, sub32(___, imm))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_83_6, xor32(___, imm))
void instr32_83_7_reg(int32_t r, int32_t imm) { cmp32(read_reg32(r), imm); }
void instr32_83_7_mem(int32_t addr, int32_t imm) { cmp32(safe_read32s(addr), imm); }

DEFINE_MODRM_INSTR_READ8(instr_84, test8(___, read_reg8(r)))
DEFINE_MODRM_INSTR_READ16(instr16_85, test16(___, read_reg16(r)))
DEFINE_MODRM_INSTR_READ32(instr32_85, test32(___, read_reg32(r)))

DEFINE_MODRM_INSTR_READ_WRITE_8(instr_86, xchg8(___, get_reg8_index(r)))
DEFINE_MODRM_INSTR_READ_WRITE_16(instr16_87, xchg16(___, get_reg16_index(r)))
DEFINE_MODRM_INSTR_READ_WRITE_32(instr32_87, xchg32(___, r))

void instr_88_reg(int32_t r2, int32_t r) { write_reg8(r2, read_reg8(r)); }
void instr_88_mem(int32_t addr, int32_t r) { safe_write8(addr, read_reg8(r)); }
void instr16_89_reg(int32_t r2, int32_t r) { write_reg16(r2, read_reg16(r)); }
void instr16_89_mem(int32_t addr, int32_t r) { safe_write16(addr, read_reg16(r)); }
void instr32_89_reg(int32_t r2, int32_t r) { write_reg32(r2, read_reg32(r)); }
void instr32_89_mem(int32_t addr, int32_t r) { safe_write32(addr, read_reg32(r)); }

DEFINE_MODRM_INSTR_READ8(instr_8A, write_reg8(r, ___))
DEFINE_MODRM_INSTR_READ16(instr16_8B, write_reg16(r, ___))
DEFINE_MODRM_INSTR_READ32(instr32_8B, write_reg32(r, ___))

void instr_8C_check_sreg(int32_t sreg) {
    if(sreg >= 6)
    {
        dbg_log("mov sreg #ud");
        trigger_ud();
    }
}
void instr16_8C_reg(int32_t r, int32_t seg) { instr_8C_check_sreg(seg); write_reg16(r, sreg[seg]); }
void instr16_8C_mem(int32_t addr, int32_t seg) { instr_8C_check_sreg(seg); safe_write16(addr, sreg[seg]); }
void instr32_8C_reg(int32_t r, int32_t seg) { instr_8C_check_sreg(seg); write_reg32(r, sreg[seg]); }
void instr32_8C_mem(int32_t addr, int32_t seg) { instr_8C_check_sreg(seg); safe_write32(addr, sreg[seg]); }

void instr16_8D_reg(int32_t r, int32_t r2)
{
    dbg_log("lea #ud");
    trigger_ud();
}
void instr16_8D_mem_pre()
{
    // override prefix, so modrm_resolve does not return the segment part
    *prefixes |= SEG_PREFIX_ZERO;
}
void instr16_8D_mem(int32_t addr, int32_t mod)
{
    // lea
    reg16[mod << 1] = addr;
    *prefixes = 0;
}
void instr32_8D_reg(int32_t r, int32_t r2)
{
    dbg_log("lea #ud");
    trigger_ud();
}
void instr32_8D_mem_pre()
{
    // override prefix, so modrm_resolve does not return the segment part
    *prefixes |= SEG_PREFIX_ZERO;
}
void instr32_8D_mem(int32_t addr, int32_t mod) {
    // lea
    reg32s[mod] = addr;
    *prefixes = 0;
}

void instr_8E_helper(int32_t data, int32_t mod)
{
    if(mod == ES || mod == SS || mod == DS || mod == FS || mod == GS)
    {
        switch_seg(mod, data);

        if(mod == SS)
        {
            // run next instruction, so no interrupts are handled
            clear_prefixes();
            //cycle_internal();
        }
    }
    else
    {
        dbg_log("mov sreg #ud");
    }
}
DEFINE_MODRM_INSTR_READ16(instr_8E, instr_8E_helper(___, r))

void instr16_8F_0_mem_pre()
{
    for(int32_t i = 0; i < 8; i++) { translate_address_read(*instruction_pointer + i); }; // XXX
    adjust_stack_reg(2);
}
void instr16_8F_0_mem(int32_t addr)
{
    // pop
    adjust_stack_reg(-2);
    int32_t sp = safe_read16(get_stack_pointer(0));
    safe_write16(addr, sp);
    adjust_stack_reg(2);
}
void instr16_8F_0_reg(int32_t r)
{
    write_reg16(r, pop16());
}
void instr32_8F_0_mem_pre()
{
    // prevent page faults during modrm_resolve
    for(int32_t i = 0; i < 8; i++) { translate_address_read(*instruction_pointer + i); }; // XXX

    // esp must be adjusted before calling modrm_resolved
    // The order of calls is: instr32_8F_0_mem_pre -> modrm_resolve -> instr32_8F_0_mem
    adjust_stack_reg(4);
}
void instr32_8F_0_mem(int32_t addr)
{
    // Before attempting a write that might cause a page fault,
    // we must set esp to the old value. Fuck Intel.
    adjust_stack_reg(-4);
    int32_t sp = safe_read32s(get_stack_pointer(0));

    safe_write32(addr, sp);
    adjust_stack_reg(4);
}
void instr32_8F_0_reg(int32_t r)
{
    write_reg32(r, pop32s());
}

void instr_90() { }
void instr16_91() { xchg16r(CX); }
void instr32_91() { xchg32r(ECX); }
void instr16_92() { xchg16r(DX); }
void instr32_92() { xchg32r(EDX); }
void instr16_93() { xchg16r(BX); }
void instr32_93() { xchg32r(EBX); }
void instr16_94() { xchg16r(SP); }
void instr32_94() { xchg32r(ESP); }
void instr16_95() { xchg16r(BP); }
void instr32_95() { xchg32r(EBP); }
void instr16_96() { xchg16r(SI); }
void instr32_96() { xchg32r(ESI); }
void instr16_97() { xchg16r(DI); }
void instr32_97() { xchg32r(EDI); }

void instr16_98() { /* cbw */ reg16[AX] = reg8s[AL]; }
void instr32_98() { /* cwde */ reg32s[EAX] = reg16s[AX]; }
void instr16_99() { /* cwd */ reg16[DX] = reg16s[AX] >> 15; }
void instr32_99() { /* cdq */ reg32s[EDX] = reg32s[EAX] >> 31; }

void instr16_9A(int32_t new_ip, int32_t new_cs) {
    // callf
    far_jump(new_ip, new_cs, true);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
void instr32_9A(int32_t new_ip, int32_t new_cs) {
    if(!*protected_mode || vm86_mode())
    {
        if(new_ip & 0xFFFF0000)
        {
            assert(false);
            //throw debug.unimpl("#GP handler");
        }
    }

    far_jump(new_ip, new_cs, true);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}

void instr_9B() {
    // fwait: check for pending fpu exceptions
    if((cr[0] & (CR0_MP | CR0_TS)) == (CR0_MP | CR0_TS))
    {
        // task switched and MP bit is set
        trigger_nm();
    }
    else
    {
        //if(fpu)
        {
            fwait();
        }
        //else
        //{
        //    // EM bit isn't checked
        //    // If there's no FPU, do nothing
        //}
    }
}
void instr16_9C() {
    // pushf
    if((flags[0] & FLAG_VM) && getiopl() < 3)
    {
        dbg_assert(*protected_mode);
        dbg_log("pushf #gp");
        trigger_gp(0);
    }
    else
    {
        push16(get_eflags());
    }
}
void instr32_9C() {
    // pushf
    if((flags[0] & FLAG_VM) && getiopl() < 3)
    {
        // trap to virtual 8086 monitor
        dbg_assert(*protected_mode);
        dbg_log("pushf #gp");
        trigger_gp(0);
    }
    else
    {
        // vm and rf flag are cleared in image stored on the stack
        push32(get_eflags() & 0x00FCFFFF);
    }
}
void instr16_9D() {
    // popf
    if((flags[0] & FLAG_VM) && getiopl() < 3)
    {
        dbg_log("popf #gp");
        trigger_gp(0);
    }

    update_eflags((flags[0] & ~0xFFFF) | pop16());

    if(flags[0] & FLAG_TRAP)
    {
        // XXX: Problems with fdgame
        //clear_prefixes();
        //cycle_internal();
        flags[0] &= ~FLAG_TRAP;
        //instruction_pointer = previous_ip;
        //raise_exception(1);
    }
    else
    {
        handle_irqs();
    }
}
void instr32_9D() {
    // popf
    if((flags[0] & FLAG_VM) && getiopl() < 3)
    {
        dbg_log("popf #gp");
        trigger_gp(0);
    }

    update_eflags(pop32s());
    handle_irqs();
}
void instr_9E() {
    // sahf
    flags[0] = (flags[0] & ~0xFF) | reg8[AH];
    flags[0] = (flags[0] & FLAGS_MASK) | FLAGS_DEFAULT;
    flags_changed[0] &= ~0xFF;
}
void instr_9F() {
    // lahf
    reg8[AH] = get_eflags();
}

void instr_A0(int32_t moffs) {
    // mov
    int32_t data = safe_read8(get_seg_prefix_ds(moffs));
    reg8[AL] = data;
}
void instr16_A1(int32_t moffs) {
    // mov
    int32_t data = safe_read16(get_seg_prefix_ds(moffs));
    reg16[AX] = data;
}
void instr32_A1(int32_t moffs) {
    int32_t data = safe_read32s(get_seg_prefix_ds(moffs));
    reg32s[EAX] = data;
}
void instr_A2(int32_t moffs) {
    // mov
    safe_write8(get_seg_prefix_ds(moffs), reg8[AL]);
}
void instr16_A3(int32_t moffs) {
    // mov
    safe_write16(get_seg_prefix_ds(moffs), reg16[AX]);
}
void instr32_A3(int32_t moffs) {
    safe_write32(get_seg_prefix_ds(moffs), reg32s[EAX]);
}

void instr_A4() { movsb(); }
void instr16_A5() { movsw(); }
void instr32_A5() { movsd(); }
void instr_A6() { cmpsb(); }
void instr16_A7() { cmpsw(); }
void instr32_A7() { cmpsd(); }

void instr_A8(int32_t imm8) {
    test8(reg8[AL], imm8);
}
void instr16_A9(int32_t imm16) {
    test16(reg16[AX], imm16);
}
void instr32_A9(int32_t imm32) {
    test32(reg32s[EAX], imm32);
}

void instr_AA() { stosb(); }
void instr16_AB() { stosw(); }
void instr32_AB() { stosd(); }
void instr_AC() { lodsb(); }
void instr16_AD() { lodsw(); }
void instr32_AD() { lodsd(); }
void instr_AE() { scasb(); }
void instr16_AF() { scasw(); }
void instr32_AF() { scasd(); }


void instr_B0(int32_t imm8) { reg8[AL] = imm8; }
void instr_B1(int32_t imm8) { reg8[CL] = imm8; }
void instr_B2(int32_t imm8) { reg8[DL] = imm8; }
void instr_B3(int32_t imm8) { reg8[BL] = imm8; }
void instr_B4(int32_t imm8) { reg8[AH] = imm8; }
void instr_B5(int32_t imm8) { reg8[CH] = imm8; }
void instr_B6(int32_t imm8) { reg8[DH] = imm8; }
void instr_B7(int32_t imm8) { reg8[BH] = imm8; }

void instr16_B8(int32_t imm) { reg16[AX] = imm; }
void instr32_B8(int32_t imm) { reg32s[EAX] = imm; }
void instr16_B9(int32_t imm) { reg16[CX] = imm; }
void instr32_B9(int32_t imm) { reg32s[ECX] = imm; }
void instr16_BA(int32_t imm) { reg16[DX] = imm; }
void instr32_BA(int32_t imm) { reg32s[EDX] = imm; }
void instr16_BB(int32_t imm) { reg16[BX] = imm; }
void instr32_BB(int32_t imm) { reg32s[EBX] = imm; }
void instr16_BC(int32_t imm) { reg16[SP] = imm; }
void instr32_BC(int32_t imm) { reg32s[ESP] = imm; }
void instr16_BD(int32_t imm) { reg16[BP] = imm; }
void instr32_BD(int32_t imm) { reg32s[EBP] = imm; }
void instr16_BE(int32_t imm) { reg16[SI] = imm; }
void instr32_BE(int32_t imm) { reg32s[ESI] = imm; }
void instr16_BF(int32_t imm) { reg16[DI] = imm; }
void instr32_BF(int32_t imm) { reg32s[EDI] = imm; }

DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_C0_0, rol8(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_C0_1, ror8(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_C0_2, rcl8(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_C0_3, rcr8(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_C0_4, shl8(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_C0_5, shr8(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_C0_6, shl8(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_8(instr_C0_7, sar8(___, imm & 31))

DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_C1_0, rol16(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_C1_1, ror16(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_C1_2, rcl16(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_C1_3, rcr16(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_C1_4, shl16(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_C1_5, shr16(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_C1_6, shl16(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_16(instr16_C1_7, sar16(___, imm & 31))

DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_C1_0, rol32(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_C1_1, ror32(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_C1_2, rcl32(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_C1_3, rcr32(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_C1_4, shl32(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_C1_5, shr32(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_C1_6, shl32(___, imm & 31))
DEFINE_MODRM_INSTR2_READ_WRITE_32(instr32_C1_7, sar32(___, imm & 31))

void instr16_C2(int32_t imm16) {
    // retn
    int32_t cs = get_seg(CS);

    instruction_pointer[0] = cs + pop16();
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    adjust_stack_reg(imm16);
    diverged();
}
void instr32_C2(int32_t imm16) {
    // retn
    int32_t cs = get_seg(CS);
    int32_t ip = pop32s();

    dbg_assert(is_asize_32() || ip < 0x10000);
    instruction_pointer[0] = cs + ip;
    adjust_stack_reg(imm16);
    diverged();
}
void instr16_C3() {
    // retn
    int32_t cs = get_seg(CS);
    instruction_pointer[0] = cs + pop16();
    diverged();
}
void instr32_C3() {
    // retn
    int32_t cs = get_seg(CS);
    int32_t ip = pop32s();
    dbg_assert(is_asize_32() || ip < 0x10000);
    instruction_pointer[0] = cs + ip;
    diverged();
}

void instr16_C4_reg(int32_t _unused1, int32_t _unused2) { trigger_ud(); }
void instr16_C4_mem(int32_t addr, int32_t r) {
    lss16(addr, get_reg16_index(r), ES);
}
void instr32_C4_reg(int32_t _unused1, int32_t _unused2) { trigger_ud(); }
void instr32_C4_mem(int32_t addr, int32_t r) {
    lss32(addr, r, ES);
}
void instr16_C5_reg(int32_t _unused1, int32_t _unused2) { trigger_ud(); }
void instr16_C5_mem(int32_t addr, int32_t r) {
    lss16(addr, get_reg16_index(r), DS);
}
void instr32_C5_reg(int32_t _unused1, int32_t _unused2) { trigger_ud(); }
void instr32_C5_mem(int32_t addr, int32_t r) {
    lss32(addr, r, DS);
}

void instr_C6_0_reg(int32_t r, int32_t imm) { write_reg8(r, imm); }
void instr_C6_0_mem(int32_t addr, int32_t imm) { safe_write8(addr, imm); }
void instr16_C7_0_reg(int32_t r, int32_t imm) { write_reg16(r, imm); }
void instr16_C7_0_mem(int32_t addr, int32_t imm) { safe_write16(addr, imm); }
void instr32_C7_0_reg(int32_t r, int32_t imm) { write_reg32(r, imm); }
void instr32_C7_0_mem(int32_t addr, int32_t imm) { safe_write32(addr, imm); }

void instr16_C8(int32_t size, int32_t nesting) { enter16(size, nesting); }
void instr32_C8(int32_t size, int32_t nesting) { enter32(size, nesting); }
void instr16_C9() {
    // leave
    int32_t old_vbp = *stack_size_32 ? reg32s[EBP] : reg16[BP];
    int32_t new_bp = safe_read16(get_seg(SS) + old_vbp);
    set_stack_reg(old_vbp + 2);
    reg16[BP] = new_bp;
}
void instr32_C9() {
    int32_t old_vbp = *stack_size_32 ? reg32s[EBP] : reg16[BP];
    int32_t new_ebp = safe_read32s(get_seg(SS) + old_vbp);
    set_stack_reg(old_vbp + 4);
    reg32s[EBP] = new_ebp;
}
void instr16_CA(int32_t imm16) {
    // retf
    int32_t ip = safe_read16(get_stack_pointer(0));
    int32_t cs = safe_read16(get_stack_pointer(2));

    far_return(ip, cs, imm16);
    diverged();
}
void instr32_CA(int32_t imm16) {
    // retf
    int32_t ip = safe_read32s(get_stack_pointer(0));
    int32_t cs = safe_read32s(get_stack_pointer(4)) & 0xFFFF;

    far_return(ip, cs, imm16);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
void instr16_CB() {
    // retf
    int32_t ip = safe_read16(get_stack_pointer(0));
    int32_t cs = safe_read16(get_stack_pointer(2));

    far_return(ip, cs, 0);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
void instr32_CB() {
    // retf
    int32_t ip = safe_read32s(get_stack_pointer(0));
    int32_t cs = safe_read32s(get_stack_pointer(4)) & 0xFFFF;

    far_return(ip, cs, 0);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}

void instr_CC() {
    // INT3
    // TODO: inhibit iopl checks
    dbg_log("INT3");
    call_interrupt_vector(3, true, false, 0);
    diverged();
}
void instr_CD(int32_t imm8) {
    // INT
    call_interrupt_vector(imm8, true, false, 0);
    diverged();
}
void instr_CE() {
    // INTO
    dbg_log("INTO");
    if(getof())
    {
        // TODO: inhibit iopl checks
        call_interrupt_vector(4, true, false, 0);
    }
    diverged();
}

void instr16_CF() {
    // iret
    iret16();
    diverged();
}
void instr32_CF() {
    iret32();
    diverged();
}

DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D0_0, rol8(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D0_1, ror8(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D0_2, rcl8(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D0_3, rcr8(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D0_4, shl8(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D0_5, shr8(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D0_6, shl8(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D0_7, sar8(___, 1))

DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D1_0, rol16(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D1_1, ror16(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D1_2, rcl16(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D1_3, rcr16(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D1_4, shl16(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D1_5, shr16(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D1_6, shl16(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D1_7, sar16(___, 1))

DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D1_0, rol32(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D1_1, ror32(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D1_2, rcl32(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D1_3, rcr32(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D1_4, shl32(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D1_5, shr32(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D1_6, shl32(___, 1))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D1_7, sar32(___, 1))

DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D2_0, rol8(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D2_1, ror8(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D2_2, rcl8(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D2_3, rcr8(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D2_4, shl8(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D2_5, shr8(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D2_6, shl8(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_D2_7, sar8(___, reg8[CL] & 31))

DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D3_0, rol16(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D3_1, ror16(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D3_2, rcl16(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D3_3, rcr16(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D3_4, shl16(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D3_5, shr16(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D3_6, shl16(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_D3_7, sar16(___, reg8[CL] & 31))

DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D3_0, rol32(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D3_1, ror32(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D3_2, rcl32(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D3_3, rcr32(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D3_4, shl32(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D3_5, shr32(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D3_6, shl32(___, reg8[CL] & 31))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_D3_7, sar32(___, reg8[CL] & 31))

void instr_D4(int32_t arg) {
    bcd_aam(arg);
}
void instr_D5(int32_t arg) {
    bcd_aad(arg);
}

void instr_D6() {
    // salc
    reg8[AL] = -getcf();
}
void instr_D7() {
    // xlat
    if(is_asize_32())
    {
        reg8[AL] = safe_read8(get_seg_prefix(DS) + reg32s[EBX] + reg8[AL]);
    }
    else
    {
        reg8[AL] = safe_read8(get_seg_prefix(DS) + (reg16[BX] + reg8[AL] & 0xFFFF));
    }
}

void instr_D8_mem(int32_t addr, int32_t r) { task_switch_test(); fpu_op_D8_mem(r, addr); }
void instr_D8_reg(int32_t r2, int32_t r) { task_switch_test(); fpu_op_D8_reg(0xC0 | r2 | r << 3); }
void instr_D9_mem(int32_t addr, int32_t r) { task_switch_test(); fpu_op_D9_mem(r, addr); }
void instr_D9_reg(int32_t r2, int32_t r) { task_switch_test(); fpu_op_D9_reg(0xC0 | r2 | r << 3); }
void instr_DA_mem(int32_t addr, int32_t r) { task_switch_test(); fpu_op_DA_mem(r, addr); }
void instr_DA_reg(int32_t r2, int32_t r) { task_switch_test(); fpu_op_DA_reg(0xC0 | r2 | r << 3); }
void instr_DB_mem(int32_t addr, int32_t r) { task_switch_test(); fpu_op_DB_mem(r, addr); }
void instr_DB_reg(int32_t r2, int32_t r) { task_switch_test(); fpu_op_DB_reg(0xC0 | r2 | r << 3); }
void instr_DC_mem(int32_t addr, int32_t r) { task_switch_test(); fpu_op_DC_mem(r, addr); }
void instr_DC_reg(int32_t r2, int32_t r) { task_switch_test(); fpu_op_DC_reg(0xC0 | r2 | r << 3); }
void instr_DD_mem(int32_t addr, int32_t r) { task_switch_test(); fpu_op_DD_mem(r, addr); }
void instr_DD_reg(int32_t r2, int32_t r) { task_switch_test(); fpu_op_DD_reg(0xC0 | r2 | r << 3); }
void instr_DE_mem(int32_t addr, int32_t r) { task_switch_test(); fpu_op_DE_mem(r, addr); }
void instr_DE_reg(int32_t r2, int32_t r) { task_switch_test(); fpu_op_DE_reg(0xC0 | r2 | r << 3); }
void instr_DF_mem(int32_t addr, int32_t r) { task_switch_test(); fpu_op_DF_mem(r, addr); }
void instr_DF_reg(int32_t r2, int32_t r) { task_switch_test(); fpu_op_DF_reg(0xC0 | r2 | r << 3); }


void instr_E0(int32_t off) { loopne(off); }
void instr_E1(int32_t off) { loope(off); }
void instr_E2(int32_t off) { loop(off); }
void instr_E3(int32_t off) { jcxz(off); }

void instr_E4(int32_t port) {
    test_privileges_for_io(port, 1);
    reg8[AL] = io_port_read8(port);
    diverged();
}
void instr16_E5(int32_t port) {
    test_privileges_for_io(port, 2);
    reg16[AX] = io_port_read16(port);
    diverged();
}
void instr32_E5(int32_t port) {
    test_privileges_for_io(port, 4);
    reg32s[EAX] = io_port_read32(port);
    diverged();
}
void instr_E6(int32_t port) {
    test_privileges_for_io(port, 1);
    io_port_write8(port, reg8[AL]);
    diverged();
}
void instr16_E7(int32_t port) {
    test_privileges_for_io(port, 2);
    io_port_write16(port, reg16[AX]);
    diverged();
}
void instr32_E7(int32_t port) {
    test_privileges_for_io(port, 4);
    io_port_write32(port, reg32s[EAX]);
    diverged();
}

void instr16_E8(int32_t imm16) {
    // call
    push16(get_real_eip());

    jmp_rel16(imm16);
    diverged();
}
void instr32_E8(int32_t imm32s) {
    // call
    push32(get_real_eip());

    instruction_pointer[0] = instruction_pointer[0] + imm32s;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
void instr16_E9(int32_t imm16) {
    // jmp
    jmp_rel16(imm16);
    diverged();
}
void instr32_E9(int32_t imm32s) {
    // jmp
    instruction_pointer[0] = instruction_pointer[0] + imm32s;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
void instr16_EA(int32_t new_ip, int32_t cs) {
    // jmpf
    far_jump(new_ip, cs, false);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
void instr32_EA(int32_t new_ip, int32_t cs) {
    // jmpf
    far_jump(new_ip, cs, false);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
void instr_EB(int32_t imm8) {
    // jmp near
    instruction_pointer[0] = instruction_pointer[0] + imm8;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}

void instr_EC() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 1);
    reg8[AL] = io_port_read8(port);
    diverged();
}
void instr16_ED() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 2);
    reg16[AX] = io_port_read16(port);
    diverged();
}
void instr32_ED() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 4);
    reg32s[EAX] = io_port_read32(port);
    diverged();
}
void instr_EE() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 1);
    io_port_write8(port, reg8[AL]);
    diverged();
}
void instr16_EF() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 2);
    io_port_write16(port, reg16[AX]);
    diverged();
}
void instr32_EF() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 4);
    io_port_write32(port, reg32s[EAX]);
    diverged();
}

void instr_F0() {
    // lock
    //dbg_log("lock");

    // TODO
    // This triggers UD when used with
    // some instructions that don't write to memory
    run_prefix_instruction();
}
void instr_F0_jit() {
    // lock
    //dbg_log("lock");

    // TODO
    // This triggers UD when used with
    // some instructions that don't write to memory
    jit_prefix_instruction();
}
void instr_F1() {
    // INT1
    // https://code.google.com/p/corkami/wiki/x86oddities#IceBP
    //throw debug.unimpl("int1 instruction");
    assert(false);
}

void instr_F2() {
    // repnz
    dbg_assert((*prefixes & PREFIX_MASK_REP) == 0);
    *prefixes |= PREFIX_REPNZ;
    run_prefix_instruction();
    *prefixes = 0;
}
void instr_F2_jit() {
    // repnz
    dbg_assert((*prefixes & PREFIX_MASK_REP) == 0);
    gen_add_prefix_bits(PREFIX_REPNZ);
    *prefixes |= PREFIX_REPNZ;
    jit_prefix_instruction();
    gen_clear_prefixes();
    *prefixes = 0;
}

void instr_F3() {
    // repz
    dbg_assert((*prefixes & PREFIX_MASK_REP) == 0);
    *prefixes |= PREFIX_REPZ;
    run_prefix_instruction();
    *prefixes = 0;
}

void instr_F3_jit() {
    // repz
    dbg_assert((*prefixes & PREFIX_MASK_REP) == 0);
    gen_add_prefix_bits(PREFIX_REPZ);
    *prefixes |= PREFIX_REPZ;
    jit_prefix_instruction();
    gen_clear_prefixes();
    *prefixes = 0;
}

void instr_F4() {
    hlt_op();
}

void instr_F5() {
    // cmc
    flags[0] = (flags[0] | 1) ^ getcf();
    flags_changed[0] &= ~1;
}

DEFINE_MODRM_INSTR2_READ8(instr_F6_0, test8(___, imm))
DEFINE_MODRM_INSTR2_READ8(instr_F6_1, test8(___, imm))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_F6_2, ~___)
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_F6_3, neg8(___))
DEFINE_MODRM_INSTR1_READ8(instr_F6_4, mul8(___))
DEFINE_MODRM_INSTR1_READ8(instr_F6_5, imul8(___ << 24 >> 24))
DEFINE_MODRM_INSTR1_READ8(instr_F6_6, div8(___))
DEFINE_MODRM_INSTR1_READ8(instr_F6_7, idiv8(___ << 24 >> 24))

DEFINE_MODRM_INSTR2_READ16(instr16_F7_0, test16(___, imm))
DEFINE_MODRM_INSTR2_READ16(instr16_F7_1, test16(___, imm))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_F7_2, ~___)
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_F7_3, neg16(___))
DEFINE_MODRM_INSTR1_READ16(instr16_F7_4, mul16(___))
DEFINE_MODRM_INSTR1_READ16(instr16_F7_5, imul16(___ << 16 >> 16))
DEFINE_MODRM_INSTR1_READ16(instr16_F7_6, div16(___))
DEFINE_MODRM_INSTR1_READ16(instr16_F7_7, idiv16(___ << 16 >> 16))

DEFINE_MODRM_INSTR2_READ32(instr32_F7_0, test32(___, imm))
DEFINE_MODRM_INSTR2_READ32(instr32_F7_1, test32(___, imm))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_F7_2, ~___)
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_F7_3, neg32(___))
DEFINE_MODRM_INSTR1_READ32(instr32_F7_4, mul32(___))
DEFINE_MODRM_INSTR1_READ32(instr32_F7_5, imul32(___))
DEFINE_MODRM_INSTR1_READ32(instr32_F7_6, div32(___))
DEFINE_MODRM_INSTR1_READ32(instr32_F7_7, idiv32(___))

void instr_F8() {
    // clc
    flags[0] &= ~FLAG_CARRY;
    flags_changed[0] &= ~1;
}
void instr_F9() {
    // stc
    flags[0] |= FLAG_CARRY;
    flags_changed[0] &= ~1;
}

void instr_FA() {
    // cli
    //dbg_log("interrupts off");

    if(!*protected_mode || ((flags[0] & FLAG_VM) ?
            getiopl() == 3 : getiopl() >= *cpl))
    {
        flags[0] &= ~FLAG_INTERRUPT;
    }
    else
    {
        //if(getiopl() < 3 && ((flags & FLAG_VM) ?
        //    (cr[4] & CR4_VME) :
        //    (*cpl == 3 && (cr[4] & CR4_PVI))))
        //{
        //    flags &= ~flag_vif;
        //}
        //else
        {
            dbg_log("cli #gp");
            trigger_gp(0);
        }
    }
}
void instr_FB() {
    // sti
    //dbg_log("interrupts on");

    int32_t old_if = flags[0] & FLAG_INTERRUPT;

    if(!*protected_mode || ((flags[0] & FLAG_VM) ?
            getiopl() == 3 : getiopl() >= *cpl))
    {
        flags[0] |= FLAG_INTERRUPT;

        if(old_if == 0)
        {
            //clear_prefixes();
            //cycle_internal();

            handle_irqs();
        }
    }
    else
    {
        //if(getiopl() < 3 && (flags & flag_vip) == 0 && ((flags & FLAG_VM) ?
        //    (cr[4] & CR4_VME) :
        //    (cpl == 3 && (cr[4] & CR4_PVI))))
        //{
        //    flags |= flag_vif;
        //}
        //else
        {
            dbg_log("sti #gp");
            trigger_gp(0);
        }
    }

}

void instr_FC() {
    // cld
    flags[0] &= ~FLAG_DIRECTION;
}
void instr_FD() {
    // std
    flags[0] |= FLAG_DIRECTION;
}

DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_FE_0, inc8(___))
DEFINE_MODRM_INSTR1_READ_WRITE_8(instr_FE_1, dec8(___))


DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_FF_0, inc16(___))
DEFINE_MODRM_INSTR1_READ_WRITE_16(instr16_FF_1, dec16(___))
void instr16_FF_2_helper(int32_t data)
{
    // call near
    int32_t cs = get_seg(CS);
    push16(get_real_eip());
    instruction_pointer[0] = cs + data;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
DEFINE_MODRM_INSTR1_READ16(instr16_FF_2, instr16_FF_2_helper(___))
void instr16_FF_3_reg(int32_t r)
{
    dbg_log("callf #ud");
    trigger_ud();
}
void instr16_FF_3_mem(int32_t addr)
{
    // callf
    int32_t new_ip = safe_read16(addr);
    int32_t new_cs = safe_read16(addr + 2);

    far_jump(new_ip, new_cs, true);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
void instr16_FF_4_helper(int32_t data)
{
    // jmp near
    instruction_pointer[0] = get_seg(CS) + data;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
DEFINE_MODRM_INSTR1_READ16(instr16_FF_4, instr16_FF_4_helper(___))
void instr16_FF_5_reg(int32_t r)
{
    dbg_log("jmpf #ud");
    trigger_ud();
}
void instr16_FF_5_mem(int32_t addr)
{
    // jmpf
    int32_t new_ip = safe_read16(addr);
    int32_t new_cs = safe_read16(addr + 2);

    far_jump(new_ip, new_cs, false);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
DEFINE_MODRM_INSTR1_READ16(instr16_FF_6, push16(___))

DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_FF_0, inc32(___))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_FF_1, dec32(___))
void instr32_FF_2_helper(int32_t data)
{
    // call near
    int32_t cs = get_seg(CS);
    push32(get_real_eip());
    dbg_assert(is_asize_32() || data < 0x10000);
    instruction_pointer[0] = cs + data;
    diverged();
}
DEFINE_MODRM_INSTR1_READ32(instr32_FF_2, instr32_FF_2_helper(___))
void instr32_FF_3_reg(int32_t r)
{
    dbg_log("callf #ud");
    trigger_ud();
}
void instr32_FF_3_mem(int32_t addr)
{
    // callf
    int32_t new_ip = safe_read32s(addr);
    int32_t new_cs = safe_read16(addr + 4);

    if(!*protected_mode || vm86_mode())
    {
        if(new_ip & 0xFFFF0000)
        {
            //throw debug.unimpl("#GP handler");
            assert(false);
        }
    }

    far_jump(new_ip, new_cs, true);
    dbg_assert(is_asize_32() || new_ip < 0x10000);
    diverged();
}
void instr32_FF_4_helper(int32_t data)
{
    // jmp near
    dbg_assert(is_asize_32() || data < 0x10000);
    instruction_pointer[0] = get_seg(CS) + data;
    diverged();
}
DEFINE_MODRM_INSTR1_READ32(instr32_FF_4, instr32_FF_4_helper(___))
void instr32_FF_5_reg(int32_t r)
{
    dbg_log("jmpf #ud");
    trigger_ud();
}
void instr32_FF_5_mem(int32_t addr)
{
    // jmpf
    int32_t new_ip = safe_read32s(addr);
    int32_t new_cs = safe_read16(addr + 4);

    if(!*protected_mode || vm86_mode())
    {
        if(new_ip & 0xFFFF0000)
        {
            //throw debug.unimpl("#GP handler");
            assert(false);
        }
    }

    far_jump(new_ip, new_cs, false);
    dbg_assert(is_asize_32() || new_ip < 0x10000);
    diverged();
}
DEFINE_MODRM_INSTR1_READ32(instr32_FF_6, push32(___))



void run_instruction(int32_t opcode)
{
    // XXX: This table is generated. Don't modify
switch(opcode)
{
    case 0x00:
    case 0x00|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_00_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_00_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x01:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_01_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_01_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x01|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_01_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_01_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x02:
    case 0x02|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_02_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_02_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x03:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_03_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_03_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x03|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_03_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_03_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x04:
    case 0x04|0x100:
    {
        instr_04(read_imm8());
    }
    break;
    case 0x05:
    {
        instr16_05(read_imm16());
    }
    break;
    case 0x05|0x100:
    {
        instr32_05(read_imm32s());
    }
    break;
    case 0x06:
    {
        instr16_06();
    }
    break;
    case 0x06|0x100:
    {
        instr32_06();
    }
    break;
    case 0x07:
    {
        instr16_07();
    }
    break;
    case 0x07|0x100:
    {
        instr32_07();
    }
    break;
    case 0x08:
    case 0x08|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_08_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_08_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x09:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_09_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_09_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x09|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_09_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_09_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x0A:
    case 0x0A|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_0A_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_0A_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x0B:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_0B_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_0B_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x0B|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_0B_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_0B_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x0C:
    case 0x0C|0x100:
    {
        instr_0C(read_imm8());
    }
    break;
    case 0x0D:
    {
        instr16_0D(read_imm16());
    }
    break;
    case 0x0D|0x100:
    {
        instr32_0D(read_imm32s());
    }
    break;
    case 0x0E:
    {
        instr16_0E();
    }
    break;
    case 0x0E|0x100:
    {
        instr32_0E();
    }
    break;
    case 0x0F:
    {
        instr16_0F();
    }
    break;
    case 0x0F|0x100:
    {
        instr32_0F();
    }
    break;
    case 0x10:
    case 0x10|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_10_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_10_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x11:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_11_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_11_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x11|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_11_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_11_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x12:
    case 0x12|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_12_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_12_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x13:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_13_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_13_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x13|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_13_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_13_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x14:
    case 0x14|0x100:
    {
        instr_14(read_imm8());
    }
    break;
    case 0x15:
    {
        instr16_15(read_imm16());
    }
    break;
    case 0x15|0x100:
    {
        instr32_15(read_imm32s());
    }
    break;
    case 0x16:
    {
        instr16_16();
    }
    break;
    case 0x16|0x100:
    {
        instr32_16();
    }
    break;
    case 0x17:
    {
        instr16_17();
    }
    break;
    case 0x17|0x100:
    {
        instr32_17();
    }
    break;
    case 0x18:
    case 0x18|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_18_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_18_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x19:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_19_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_19_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x19|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_19_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_19_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x1A:
    case 0x1A|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_1A_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_1A_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x1B:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_1B_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_1B_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x1B|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_1B_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_1B_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x1C:
    case 0x1C|0x100:
    {
        instr_1C(read_imm8());
    }
    break;
    case 0x1D:
    {
        instr16_1D(read_imm16());
    }
    break;
    case 0x1D|0x100:
    {
        instr32_1D(read_imm32s());
    }
    break;
    case 0x1E:
    {
        instr16_1E();
    }
    break;
    case 0x1E|0x100:
    {
        instr32_1E();
    }
    break;
    case 0x1F:
    {
        instr16_1F();
    }
    break;
    case 0x1F|0x100:
    {
        instr32_1F();
    }
    break;
    case 0x20:
    case 0x20|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_20_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_20_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x21:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_21_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_21_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x21|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_21_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_21_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x22:
    case 0x22|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_22_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_22_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x23:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_23_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_23_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x23|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_23_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_23_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x24:
    case 0x24|0x100:
    {
        instr_24(read_imm8());
    }
    break;
    case 0x25:
    {
        instr16_25(read_imm16());
    }
    break;
    case 0x25|0x100:
    {
        instr32_25(read_imm32s());
    }
    break;
    case 0x26:
    case 0x26|0x100:
    {
        instr_26();
    }
    break;
    case 0x27:
    case 0x27|0x100:
    {
        instr_27();
    }
    break;
    case 0x28:
    case 0x28|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_28_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_28_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x29:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_29_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_29_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x29|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_29_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_29_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x2A:
    case 0x2A|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_2A_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_2A_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x2B:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_2B_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_2B_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x2B|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_2B_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_2B_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x2C:
    case 0x2C|0x100:
    {
        instr_2C(read_imm8());
    }
    break;
    case 0x2D:
    {
        instr16_2D(read_imm16());
    }
    break;
    case 0x2D|0x100:
    {
        instr32_2D(read_imm32s());
    }
    break;
    case 0x2E:
    case 0x2E|0x100:
    {
        instr_2E();
    }
    break;
    case 0x2F:
    case 0x2F|0x100:
    {
        instr_2F();
    }
    break;
    case 0x30:
    case 0x30|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_30_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_30_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x31:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_31_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_31_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x31|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_31_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_31_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x32:
    case 0x32|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_32_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_32_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x33:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_33_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_33_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x33|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_33_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_33_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x34:
    case 0x34|0x100:
    {
        instr_34(read_imm8());
    }
    break;
    case 0x35:
    {
        instr16_35(read_imm16());
    }
    break;
    case 0x35|0x100:
    {
        instr32_35(read_imm32s());
    }
    break;
    case 0x36:
    case 0x36|0x100:
    {
        instr_36();
    }
    break;
    case 0x37:
    case 0x37|0x100:
    {
        instr_37();
    }
    break;
    case 0x38:
    case 0x38|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_38_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_38_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x39:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_39_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_39_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x39|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_39_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_39_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x3A:
    case 0x3A|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_3A_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_3A_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x3B:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_3B_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_3B_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x3B|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_3B_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_3B_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x3C:
    case 0x3C|0x100:
    {
        instr_3C(read_imm8());
    }
    break;
    case 0x3D:
    {
        instr16_3D(read_imm16());
    }
    break;
    case 0x3D|0x100:
    {
        instr32_3D(read_imm32s());
    }
    break;
    case 0x3E:
    case 0x3E|0x100:
    {
        instr_3E();
    }
    break;
    case 0x3F:
    case 0x3F|0x100:
    {
        instr_3F();
    }
    break;
    case 0x40:
    {
        instr16_40();
    }
    break;
    case 0x40|0x100:
    {
        instr32_40();
    }
    break;
    case 0x41:
    {
        instr16_41();
    }
    break;
    case 0x41|0x100:
    {
        instr32_41();
    }
    break;
    case 0x42:
    {
        instr16_42();
    }
    break;
    case 0x42|0x100:
    {
        instr32_42();
    }
    break;
    case 0x43:
    {
        instr16_43();
    }
    break;
    case 0x43|0x100:
    {
        instr32_43();
    }
    break;
    case 0x44:
    {
        instr16_44();
    }
    break;
    case 0x44|0x100:
    {
        instr32_44();
    }
    break;
    case 0x45:
    {
        instr16_45();
    }
    break;
    case 0x45|0x100:
    {
        instr32_45();
    }
    break;
    case 0x46:
    {
        instr16_46();
    }
    break;
    case 0x46|0x100:
    {
        instr32_46();
    }
    break;
    case 0x47:
    {
        instr16_47();
    }
    break;
    case 0x47|0x100:
    {
        instr32_47();
    }
    break;
    case 0x48:
    {
        instr16_48();
    }
    break;
    case 0x48|0x100:
    {
        instr32_48();
    }
    break;
    case 0x49:
    {
        instr16_49();
    }
    break;
    case 0x49|0x100:
    {
        instr32_49();
    }
    break;
    case 0x4A:
    {
        instr16_4A();
    }
    break;
    case 0x4A|0x100:
    {
        instr32_4A();
    }
    break;
    case 0x4B:
    {
        instr16_4B();
    }
    break;
    case 0x4B|0x100:
    {
        instr32_4B();
    }
    break;
    case 0x4C:
    {
        instr16_4C();
    }
    break;
    case 0x4C|0x100:
    {
        instr32_4C();
    }
    break;
    case 0x4D:
    {
        instr16_4D();
    }
    break;
    case 0x4D|0x100:
    {
        instr32_4D();
    }
    break;
    case 0x4E:
    {
        instr16_4E();
    }
    break;
    case 0x4E|0x100:
    {
        instr32_4E();
    }
    break;
    case 0x4F:
    {
        instr16_4F();
    }
    break;
    case 0x4F|0x100:
    {
        instr32_4F();
    }
    break;
    case 0x50:
    {
        instr16_50();
    }
    break;
    case 0x50|0x100:
    {
        instr32_50();
    }
    break;
    case 0x51:
    {
        instr16_51();
    }
    break;
    case 0x51|0x100:
    {
        instr32_51();
    }
    break;
    case 0x52:
    {
        instr16_52();
    }
    break;
    case 0x52|0x100:
    {
        instr32_52();
    }
    break;
    case 0x53:
    {
        instr16_53();
    }
    break;
    case 0x53|0x100:
    {
        instr32_53();
    }
    break;
    case 0x54:
    {
        instr16_54();
    }
    break;
    case 0x54|0x100:
    {
        instr32_54();
    }
    break;
    case 0x55:
    {
        instr16_55();
    }
    break;
    case 0x55|0x100:
    {
        instr32_55();
    }
    break;
    case 0x56:
    {
        instr16_56();
    }
    break;
    case 0x56|0x100:
    {
        instr32_56();
    }
    break;
    case 0x57:
    {
        instr16_57();
    }
    break;
    case 0x57|0x100:
    {
        instr32_57();
    }
    break;
    case 0x58:
    {
        instr16_58();
    }
    break;
    case 0x58|0x100:
    {
        instr32_58();
    }
    break;
    case 0x59:
    {
        instr16_59();
    }
    break;
    case 0x59|0x100:
    {
        instr32_59();
    }
    break;
    case 0x5A:
    {
        instr16_5A();
    }
    break;
    case 0x5A|0x100:
    {
        instr32_5A();
    }
    break;
    case 0x5B:
    {
        instr16_5B();
    }
    break;
    case 0x5B|0x100:
    {
        instr32_5B();
    }
    break;
    case 0x5C:
    {
        instr16_5C();
    }
    break;
    case 0x5C|0x100:
    {
        instr32_5C();
    }
    break;
    case 0x5D:
    {
        instr16_5D();
    }
    break;
    case 0x5D|0x100:
    {
        instr32_5D();
    }
    break;
    case 0x5E:
    {
        instr16_5E();
    }
    break;
    case 0x5E|0x100:
    {
        instr32_5E();
    }
    break;
    case 0x5F:
    {
        instr16_5F();
    }
    break;
    case 0x5F|0x100:
    {
        instr32_5F();
    }
    break;
    case 0x60:
    {
        instr16_60();
    }
    break;
    case 0x60|0x100:
    {
        instr32_60();
    }
    break;
    case 0x61:
    {
        instr16_61();
    }
    break;
    case 0x61|0x100:
    {
        instr32_61();
    }
    break;
    case 0x62:
    case 0x62|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_62_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_62_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x63:
    case 0x63|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_63_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_63_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x64:
    case 0x64|0x100:
    {
        instr_64();
    }
    break;
    case 0x65:
    case 0x65|0x100:
    {
        instr_65();
    }
    break;
    case 0x66:
    case 0x66|0x100:
    {
        instr_66();
    }
    break;
    case 0x67:
    case 0x67|0x100:
    {
        instr_67();
    }
    break;
    case 0x68:
    {
        instr16_68(read_imm16());
    }
    break;
    case 0x68|0x100:
    {
        instr32_68(read_imm32s());
    }
    break;
    case 0x69:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_69_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7, read_imm16());
        }
        else
        {
            instr16_69_reg(modrm_byte & 7, modrm_byte >> 3 & 7, read_imm16());
        }
    }
    break;
    case 0x69|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_69_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7, read_imm32s());
        }
        else
        {
            instr32_69_reg(modrm_byte & 7, modrm_byte >> 3 & 7, read_imm32s());
        }
    }
    break;
    case 0x6A:
    {
        instr16_6A(read_imm8s());
    }
    break;
    case 0x6A|0x100:
    {
        instr32_6A(read_imm8s());
    }
    break;
    case 0x6B:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_6B_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7, read_imm8s());
        }
        else
        {
            instr16_6B_reg(modrm_byte & 7, modrm_byte >> 3 & 7, read_imm8s());
        }
    }
    break;
    case 0x6B|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_6B_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7, read_imm8s());
        }
        else
        {
            instr32_6B_reg(modrm_byte & 7, modrm_byte >> 3 & 7, read_imm8s());
        }
    }
    break;
    case 0x6C:
    case 0x6C|0x100:
    {
        instr_6C();
    }
    break;
    case 0x6D:
    {
        instr16_6D();
    }
    break;
    case 0x6D|0x100:
    {
        instr32_6D();
    }
    break;
    case 0x6E:
    case 0x6E|0x100:
    {
        instr_6E();
    }
    break;
    case 0x6F:
    {
        instr16_6F();
    }
    break;
    case 0x6F|0x100:
    {
        instr32_6F();
    }
    break;
    case 0x70:
    case 0x70|0x100:
    {
        instr_70(read_imm8s());
    }
    break;
    case 0x71:
    case 0x71|0x100:
    {
        instr_71(read_imm8s());
    }
    break;
    case 0x72:
    case 0x72|0x100:
    {
        instr_72(read_imm8s());
    }
    break;
    case 0x73:
    case 0x73|0x100:
    {
        instr_73(read_imm8s());
    }
    break;
    case 0x74:
    case 0x74|0x100:
    {
        instr_74(read_imm8s());
    }
    break;
    case 0x75:
    case 0x75|0x100:
    {
        instr_75(read_imm8s());
    }
    break;
    case 0x76:
    case 0x76|0x100:
    {
        instr_76(read_imm8s());
    }
    break;
    case 0x77:
    case 0x77|0x100:
    {
        instr_77(read_imm8s());
    }
    break;
    case 0x78:
    case 0x78|0x100:
    {
        instr_78(read_imm8s());
    }
    break;
    case 0x79:
    case 0x79|0x100:
    {
        instr_79(read_imm8s());
    }
    break;
    case 0x7A:
    case 0x7A|0x100:
    {
        instr_7A(read_imm8s());
    }
    break;
    case 0x7B:
    case 0x7B|0x100:
    {
        instr_7B(read_imm8s());
    }
    break;
    case 0x7C:
    case 0x7C|0x100:
    {
        instr_7C(read_imm8s());
    }
    break;
    case 0x7D:
    case 0x7D|0x100:
    {
        instr_7D(read_imm8s());
    }
    break;
    case 0x7E:
    case 0x7E|0x100:
    {
        instr_7E(read_imm8s());
    }
    break;
    case 0x7F:
    case 0x7F|0x100:
    {
        instr_7F(read_imm8s());
    }
    break;
    case 0x80:
    case 0x80|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_80_0_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_80_0_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_80_1_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_80_1_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_80_2_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_80_2_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_80_3_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_80_3_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_80_4_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_80_4_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_80_5_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_80_5_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_80_6_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_80_6_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_80_7_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_80_7_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x81:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_81_0_mem(modrm_resolve(modrm_byte), read_imm16());
                }
                else
                {
                    instr16_81_0_reg(modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_81_1_mem(modrm_resolve(modrm_byte), read_imm16());
                }
                else
                {
                    instr16_81_1_reg(modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_81_2_mem(modrm_resolve(modrm_byte), read_imm16());
                }
                else
                {
                    instr16_81_2_reg(modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_81_3_mem(modrm_resolve(modrm_byte), read_imm16());
                }
                else
                {
                    instr16_81_3_reg(modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_81_4_mem(modrm_resolve(modrm_byte), read_imm16());
                }
                else
                {
                    instr16_81_4_reg(modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_81_5_mem(modrm_resolve(modrm_byte), read_imm16());
                }
                else
                {
                    instr16_81_5_reg(modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_81_6_mem(modrm_resolve(modrm_byte), read_imm16());
                }
                else
                {
                    instr16_81_6_reg(modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_81_7_mem(modrm_resolve(modrm_byte), read_imm16());
                }
                else
                {
                    instr16_81_7_reg(modrm_byte & 7, read_imm16());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x81|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_81_0_mem(modrm_resolve(modrm_byte), read_imm32s());
                }
                else
                {
                    instr32_81_0_reg(modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_81_1_mem(modrm_resolve(modrm_byte), read_imm32s());
                }
                else
                {
                    instr32_81_1_reg(modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_81_2_mem(modrm_resolve(modrm_byte), read_imm32s());
                }
                else
                {
                    instr32_81_2_reg(modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_81_3_mem(modrm_resolve(modrm_byte), read_imm32s());
                }
                else
                {
                    instr32_81_3_reg(modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_81_4_mem(modrm_resolve(modrm_byte), read_imm32s());
                }
                else
                {
                    instr32_81_4_reg(modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_81_5_mem(modrm_resolve(modrm_byte), read_imm32s());
                }
                else
                {
                    instr32_81_5_reg(modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_81_6_mem(modrm_resolve(modrm_byte), read_imm32s());
                }
                else
                {
                    instr32_81_6_reg(modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_81_7_mem(modrm_resolve(modrm_byte), read_imm32s());
                }
                else
                {
                    instr32_81_7_reg(modrm_byte & 7, read_imm32s());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x82:
    case 0x82|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_82_0_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_82_0_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_82_1_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_82_1_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_82_2_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_82_2_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_82_3_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_82_3_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_82_4_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_82_4_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_82_5_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_82_5_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_82_6_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_82_6_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_82_7_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_82_7_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x83:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_83_0_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr16_83_0_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_83_1_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr16_83_1_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_83_2_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr16_83_2_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_83_3_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr16_83_3_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_83_4_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr16_83_4_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_83_5_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr16_83_5_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_83_6_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr16_83_6_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_83_7_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr16_83_7_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x83|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_83_0_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr32_83_0_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_83_1_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr32_83_1_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_83_2_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr32_83_2_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_83_3_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr32_83_3_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_83_4_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr32_83_4_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_83_5_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr32_83_5_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_83_6_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr32_83_6_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_83_7_mem(modrm_resolve(modrm_byte), read_imm8s());
                }
                else
                {
                    instr32_83_7_reg(modrm_byte & 7, read_imm8s());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x84:
    case 0x84|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_84_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_84_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x85:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_85_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_85_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x85|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_85_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_85_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x86:
    case 0x86|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_86_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_86_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x87:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_87_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_87_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x87|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_87_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_87_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x88:
    case 0x88|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_88_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_88_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x89:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_89_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_89_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x89|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_89_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_89_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8A:
    case 0x8A|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_8A_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_8A_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8B:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_8B_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_8B_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8B|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_8B_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_8B_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8C:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_8C_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_8C_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8C|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_8C_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_8C_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8D:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_8D_mem_pre();
            instr16_8D_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_8D_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8D|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_8D_mem_pre();
            instr32_8D_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_8D_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8E:
    case 0x8E|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_8E_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_8E_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8F:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_8F_0_mem_pre();
                    instr16_8F_0_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_8F_0_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x8F|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_8F_0_mem_pre();
                    instr32_8F_0_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_8F_0_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x90:
    case 0x90|0x100:
    {
        instr_90();
    }
    break;
    case 0x91:
    {
        instr16_91();
    }
    break;
    case 0x91|0x100:
    {
        instr32_91();
    }
    break;
    case 0x92:
    {
        instr16_92();
    }
    break;
    case 0x92|0x100:
    {
        instr32_92();
    }
    break;
    case 0x93:
    {
        instr16_93();
    }
    break;
    case 0x93|0x100:
    {
        instr32_93();
    }
    break;
    case 0x94:
    {
        instr16_94();
    }
    break;
    case 0x94|0x100:
    {
        instr32_94();
    }
    break;
    case 0x95:
    {
        instr16_95();
    }
    break;
    case 0x95|0x100:
    {
        instr32_95();
    }
    break;
    case 0x96:
    {
        instr16_96();
    }
    break;
    case 0x96|0x100:
    {
        instr32_96();
    }
    break;
    case 0x97:
    {
        instr16_97();
    }
    break;
    case 0x97|0x100:
    {
        instr32_97();
    }
    break;
    case 0x98:
    {
        instr16_98();
    }
    break;
    case 0x98|0x100:
    {
        instr32_98();
    }
    break;
    case 0x99:
    {
        instr16_99();
    }
    break;
    case 0x99|0x100:
    {
        instr32_99();
    }
    break;
    case 0x9A:
    {
        instr16_9A(read_imm16(), read_imm16());
    }
    break;
    case 0x9A|0x100:
    {
        instr32_9A(read_imm32s(), read_imm16());
    }
    break;
    case 0x9B:
    case 0x9B|0x100:
    {
        instr_9B();
    }
    break;
    case 0x9C:
    {
        instr16_9C();
    }
    break;
    case 0x9C|0x100:
    {
        instr32_9C();
    }
    break;
    case 0x9D:
    {
        instr16_9D();
    }
    break;
    case 0x9D|0x100:
    {
        instr32_9D();
    }
    break;
    case 0x9E:
    case 0x9E|0x100:
    {
        instr_9E();
    }
    break;
    case 0x9F:
    case 0x9F|0x100:
    {
        instr_9F();
    }
    break;
    case 0xA0:
    case 0xA0|0x100:
    {
        instr_A0(read_moffs());
    }
    break;
    case 0xA1:
    {
        instr16_A1(read_moffs());
    }
    break;
    case 0xA1|0x100:
    {
        instr32_A1(read_moffs());
    }
    break;
    case 0xA2:
    case 0xA2|0x100:
    {
        instr_A2(read_moffs());
    }
    break;
    case 0xA3:
    {
        instr16_A3(read_moffs());
    }
    break;
    case 0xA3|0x100:
    {
        instr32_A3(read_moffs());
    }
    break;
    case 0xA4:
    case 0xA4|0x100:
    {
        instr_A4();
    }
    break;
    case 0xA5:
    {
        instr16_A5();
    }
    break;
    case 0xA5|0x100:
    {
        instr32_A5();
    }
    break;
    case 0xA6:
    case 0xA6|0x100:
    {
        instr_A6();
    }
    break;
    case 0xA7:
    {
        instr16_A7();
    }
    break;
    case 0xA7|0x100:
    {
        instr32_A7();
    }
    break;
    case 0xA8:
    case 0xA8|0x100:
    {
        instr_A8(read_imm8());
    }
    break;
    case 0xA9:
    {
        instr16_A9(read_imm16());
    }
    break;
    case 0xA9|0x100:
    {
        instr32_A9(read_imm32s());
    }
    break;
    case 0xAA:
    case 0xAA|0x100:
    {
        instr_AA();
    }
    break;
    case 0xAB:
    {
        instr16_AB();
    }
    break;
    case 0xAB|0x100:
    {
        instr32_AB();
    }
    break;
    case 0xAC:
    case 0xAC|0x100:
    {
        instr_AC();
    }
    break;
    case 0xAD:
    {
        instr16_AD();
    }
    break;
    case 0xAD|0x100:
    {
        instr32_AD();
    }
    break;
    case 0xAE:
    case 0xAE|0x100:
    {
        instr_AE();
    }
    break;
    case 0xAF:
    {
        instr16_AF();
    }
    break;
    case 0xAF|0x100:
    {
        instr32_AF();
    }
    break;
    case 0xB0:
    case 0xB0|0x100:
    {
        instr_B0(read_imm8());
    }
    break;
    case 0xB1:
    case 0xB1|0x100:
    {
        instr_B1(read_imm8());
    }
    break;
    case 0xB2:
    case 0xB2|0x100:
    {
        instr_B2(read_imm8());
    }
    break;
    case 0xB3:
    case 0xB3|0x100:
    {
        instr_B3(read_imm8());
    }
    break;
    case 0xB4:
    case 0xB4|0x100:
    {
        instr_B4(read_imm8());
    }
    break;
    case 0xB5:
    case 0xB5|0x100:
    {
        instr_B5(read_imm8());
    }
    break;
    case 0xB6:
    case 0xB6|0x100:
    {
        instr_B6(read_imm8());
    }
    break;
    case 0xB7:
    case 0xB7|0x100:
    {
        instr_B7(read_imm8());
    }
    break;
    case 0xB8:
    {
        instr16_B8(read_imm16());
    }
    break;
    case 0xB8|0x100:
    {
        instr32_B8(read_imm32s());
    }
    break;
    case 0xB9:
    {
        instr16_B9(read_imm16());
    }
    break;
    case 0xB9|0x100:
    {
        instr32_B9(read_imm32s());
    }
    break;
    case 0xBA:
    {
        instr16_BA(read_imm16());
    }
    break;
    case 0xBA|0x100:
    {
        instr32_BA(read_imm32s());
    }
    break;
    case 0xBB:
    {
        instr16_BB(read_imm16());
    }
    break;
    case 0xBB|0x100:
    {
        instr32_BB(read_imm32s());
    }
    break;
    case 0xBC:
    {
        instr16_BC(read_imm16());
    }
    break;
    case 0xBC|0x100:
    {
        instr32_BC(read_imm32s());
    }
    break;
    case 0xBD:
    {
        instr16_BD(read_imm16());
    }
    break;
    case 0xBD|0x100:
    {
        instr32_BD(read_imm32s());
    }
    break;
    case 0xBE:
    {
        instr16_BE(read_imm16());
    }
    break;
    case 0xBE|0x100:
    {
        instr32_BE(read_imm32s());
    }
    break;
    case 0xBF:
    {
        instr16_BF(read_imm16());
    }
    break;
    case 0xBF|0x100:
    {
        instr32_BF(read_imm32s());
    }
    break;
    case 0xC0:
    case 0xC0|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_C0_0_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_C0_0_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_C0_1_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_C0_1_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_C0_2_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_C0_2_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_C0_3_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_C0_3_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_C0_4_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_C0_4_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_C0_5_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_C0_5_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_C0_6_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_C0_6_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_C0_7_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_C0_7_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xC1:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_C1_0_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr16_C1_0_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_C1_1_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr16_C1_1_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_C1_2_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr16_C1_2_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_C1_3_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr16_C1_3_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_C1_4_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr16_C1_4_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_C1_5_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr16_C1_5_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_C1_6_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr16_C1_6_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_C1_7_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr16_C1_7_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xC1|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_C1_0_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr32_C1_0_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_C1_1_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr32_C1_1_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_C1_2_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr32_C1_2_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_C1_3_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr32_C1_3_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_C1_4_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr32_C1_4_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_C1_5_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr32_C1_5_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_C1_6_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr32_C1_6_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_C1_7_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr32_C1_7_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xC2:
    {
        instr16_C2(read_imm16());
    }
    break;
    case 0xC2|0x100:
    {
        instr32_C2(read_imm16());
    }
    break;
    case 0xC3:
    {
        instr16_C3();
    }
    break;
    case 0xC3|0x100:
    {
        instr32_C3();
    }
    break;
    case 0xC4:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_C4_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_C4_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xC4|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_C4_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_C4_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xC5:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr16_C5_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr16_C5_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xC5|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr32_C5_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr32_C5_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xC6:
    case 0xC6|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_C6_0_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_C6_0_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xC7:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_C7_0_mem(modrm_resolve(modrm_byte), read_imm16());
                }
                else
                {
                    instr16_C7_0_reg(modrm_byte & 7, read_imm16());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xC7|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_C7_0_mem(modrm_resolve(modrm_byte), read_imm32s());
                }
                else
                {
                    instr32_C7_0_reg(modrm_byte & 7, read_imm32s());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xC8:
    {
        instr16_C8(read_imm16(), read_imm8());
    }
    break;
    case 0xC8|0x100:
    {
        instr32_C8(read_imm16(), read_imm8());
    }
    break;
    case 0xC9:
    {
        instr16_C9();
    }
    break;
    case 0xC9|0x100:
    {
        instr32_C9();
    }
    break;
    case 0xCA:
    {
        instr16_CA(read_imm16());
    }
    break;
    case 0xCA|0x100:
    {
        instr32_CA(read_imm16());
    }
    break;
    case 0xCB:
    {
        instr16_CB();
    }
    break;
    case 0xCB|0x100:
    {
        instr32_CB();
    }
    break;
    case 0xCC:
    case 0xCC|0x100:
    {
        instr_CC();
    }
    break;
    case 0xCD:
    case 0xCD|0x100:
    {
        instr_CD(read_imm8());
    }
    break;
    case 0xCE:
    case 0xCE|0x100:
    {
        instr_CE();
    }
    break;
    case 0xCF:
    {
        instr16_CF();
    }
    break;
    case 0xCF|0x100:
    {
        instr32_CF();
    }
    break;
    case 0xD0:
    case 0xD0|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D0_0_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D0_0_reg(modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D0_1_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D0_1_reg(modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D0_2_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D0_2_reg(modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D0_3_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D0_3_reg(modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D0_4_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D0_4_reg(modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D0_5_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D0_5_reg(modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D0_6_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D0_6_reg(modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D0_7_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D0_7_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xD1:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D1_0_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D1_0_reg(modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D1_1_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D1_1_reg(modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D1_2_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D1_2_reg(modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D1_3_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D1_3_reg(modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D1_4_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D1_4_reg(modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D1_5_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D1_5_reg(modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D1_6_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D1_6_reg(modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D1_7_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D1_7_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xD1|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D1_0_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D1_0_reg(modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D1_1_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D1_1_reg(modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D1_2_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D1_2_reg(modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D1_3_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D1_3_reg(modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D1_4_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D1_4_reg(modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D1_5_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D1_5_reg(modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D1_6_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D1_6_reg(modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D1_7_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D1_7_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xD2:
    case 0xD2|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D2_0_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D2_0_reg(modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D2_1_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D2_1_reg(modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D2_2_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D2_2_reg(modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D2_3_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D2_3_reg(modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D2_4_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D2_4_reg(modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D2_5_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D2_5_reg(modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D2_6_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D2_6_reg(modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_D2_7_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_D2_7_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xD3:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D3_0_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D3_0_reg(modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D3_1_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D3_1_reg(modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D3_2_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D3_2_reg(modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D3_3_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D3_3_reg(modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D3_4_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D3_4_reg(modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D3_5_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D3_5_reg(modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D3_6_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D3_6_reg(modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_D3_7_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_D3_7_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xD3|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D3_0_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D3_0_reg(modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D3_1_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D3_1_reg(modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D3_2_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D3_2_reg(modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D3_3_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D3_3_reg(modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D3_4_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D3_4_reg(modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D3_5_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D3_5_reg(modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D3_6_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D3_6_reg(modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_D3_7_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_D3_7_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xD4:
    case 0xD4|0x100:
    {
        instr_D4(read_imm8());
    }
    break;
    case 0xD5:
    case 0xD5|0x100:
    {
        instr_D5(read_imm8());
    }
    break;
    case 0xD6:
    case 0xD6|0x100:
    {
        instr_D6();
    }
    break;
    case 0xD7:
    case 0xD7|0x100:
    {
        instr_D7();
    }
    break;
    case 0xD8:
    case 0xD8|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_D8_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_D8_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xD9:
    case 0xD9|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_D9_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_D9_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xDA:
    case 0xDA|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_DA_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_DA_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xDB:
    case 0xDB|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_DB_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_DB_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xDC:
    case 0xDC|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_DC_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_DC_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xDD:
    case 0xDD|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_DD_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_DD_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xDE:
    case 0xDE|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_DE_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_DE_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xDF:
    case 0xDF|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            instr_DF_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);
        }
        else
        {
            instr_DF_reg(modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xE0:
    case 0xE0|0x100:
    {
        instr_E0(read_imm8s());
    }
    break;
    case 0xE1:
    case 0xE1|0x100:
    {
        instr_E1(read_imm8s());
    }
    break;
    case 0xE2:
    case 0xE2|0x100:
    {
        instr_E2(read_imm8s());
    }
    break;
    case 0xE3:
    case 0xE3|0x100:
    {
        instr_E3(read_imm8s());
    }
    break;
    case 0xE4:
    case 0xE4|0x100:
    {
        instr_E4(read_imm8());
    }
    break;
    case 0xE5:
    {
        instr16_E5(read_imm8());
    }
    break;
    case 0xE5|0x100:
    {
        instr32_E5(read_imm8());
    }
    break;
    case 0xE6:
    case 0xE6|0x100:
    {
        instr_E6(read_imm8());
    }
    break;
    case 0xE7:
    {
        instr16_E7(read_imm8());
    }
    break;
    case 0xE7|0x100:
    {
        instr32_E7(read_imm8());
    }
    break;
    case 0xE8:
    {
        instr16_E8(read_imm16());
    }
    break;
    case 0xE8|0x100:
    {
        instr32_E8(read_imm32s());
    }
    break;
    case 0xE9:
    {
        instr16_E9(read_imm16());
    }
    break;
    case 0xE9|0x100:
    {
        instr32_E9(read_imm32s());
    }
    break;
    case 0xEA:
    {
        instr16_EA(read_imm16(), read_imm16());
    }
    break;
    case 0xEA|0x100:
    {
        instr32_EA(read_imm32s(), read_imm16());
    }
    break;
    case 0xEB:
    case 0xEB|0x100:
    {
        instr_EB(read_imm8s());
    }
    break;
    case 0xEC:
    case 0xEC|0x100:
    {
        instr_EC();
    }
    break;
    case 0xED:
    {
        instr16_ED();
    }
    break;
    case 0xED|0x100:
    {
        instr32_ED();
    }
    break;
    case 0xEE:
    case 0xEE|0x100:
    {
        instr_EE();
    }
    break;
    case 0xEF:
    {
        instr16_EF();
    }
    break;
    case 0xEF|0x100:
    {
        instr32_EF();
    }
    break;
    case 0xF0:
    case 0xF0|0x100:
    {
        instr_F0();
    }
    break;
    case 0xF1:
    case 0xF1|0x100:
    {
        instr_F1();
    }
    break;
    case 0xF2:
    case 0xF2|0x100:
    {
        instr_F2();
    }
    break;
    case 0xF3:
    case 0xF3|0x100:
    {
        instr_F3();
    }
    break;
    case 0xF4:
    case 0xF4|0x100:
    {
        instr_F4();
    }
    break;
    case 0xF5:
    case 0xF5|0x100:
    {
        instr_F5();
    }
    break;
    case 0xF6:
    case 0xF6|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_F6_0_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_F6_0_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_F6_1_mem(modrm_resolve(modrm_byte), read_imm8());
                }
                else
                {
                    instr_F6_1_reg(modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_F6_2_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_F6_2_reg(modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_F6_3_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_F6_3_reg(modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_F6_4_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_F6_4_reg(modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_F6_5_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_F6_5_reg(modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_F6_6_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_F6_6_reg(modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_F6_7_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_F6_7_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xF7:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_F7_0_mem(modrm_resolve(modrm_byte), read_imm16());
                }
                else
                {
                    instr16_F7_0_reg(modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_F7_1_mem(modrm_resolve(modrm_byte), read_imm16());
                }
                else
                {
                    instr16_F7_1_reg(modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_F7_2_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_F7_2_reg(modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_F7_3_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_F7_3_reg(modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_F7_4_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_F7_4_reg(modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_F7_5_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_F7_5_reg(modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_F7_6_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_F7_6_reg(modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_F7_7_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_F7_7_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xF7|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_F7_0_mem(modrm_resolve(modrm_byte), read_imm32s());
                }
                else
                {
                    instr32_F7_0_reg(modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_F7_1_mem(modrm_resolve(modrm_byte), read_imm32s());
                }
                else
                {
                    instr32_F7_1_reg(modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_F7_2_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_F7_2_reg(modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_F7_3_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_F7_3_reg(modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_F7_4_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_F7_4_reg(modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_F7_5_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_F7_5_reg(modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_F7_6_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_F7_6_reg(modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_F7_7_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_F7_7_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xF8:
    case 0xF8|0x100:
    {
        instr_F8();
    }
    break;
    case 0xF9:
    case 0xF9|0x100:
    {
        instr_F9();
    }
    break;
    case 0xFA:
    case 0xFA|0x100:
    {
        instr_FA();
    }
    break;
    case 0xFB:
    case 0xFB|0x100:
    {
        instr_FB();
    }
    break;
    case 0xFC:
    case 0xFC|0x100:
    {
        instr_FC();
    }
    break;
    case 0xFD:
    case 0xFD|0x100:
    {
        instr_FD();
    }
    break;
    case 0xFE:
    case 0xFE|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_FE_0_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_FE_0_reg(modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr_FE_1_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr_FE_1_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xFF:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_FF_0_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_FF_0_reg(modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_FF_1_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_FF_1_reg(modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_FF_2_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_FF_2_reg(modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_FF_3_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_FF_3_reg(modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_FF_4_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_FF_4_reg(modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_FF_5_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_FF_5_reg(modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr16_FF_6_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr16_FF_6_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xFF|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_FF_0_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_FF_0_reg(modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_FF_1_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_FF_1_reg(modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_FF_2_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_FF_2_reg(modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_FF_3_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_FF_3_reg(modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_FF_4_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_FF_4_reg(modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_FF_5_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_FF_5_reg(modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    instr32_FF_6_mem(modrm_resolve(modrm_byte));
                }
                else
                {
                    instr32_FF_6_reg(modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    default:
        assert(false);
}
}

void jit_instruction(int32_t opcode)
{
    // XXX: This table is generated. Don't modify
switch(opcode)
{
    case 0x00:
    case 0x00|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_00_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_00_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x01:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_01_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_01_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x01|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_01_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_01_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x02:
    case 0x02|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_02_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_02_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x03:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_03_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_03_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x03|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_03_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_03_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x04:
    case 0x04|0x100:
    {
        gen_fn1("instr_04", 8, read_imm8());
    }
    break;
    case 0x05:
    {
        gen_fn1("instr16_05", 10, read_imm16());
    }
    break;
    case 0x05|0x100:
    {
        gen_fn1("instr32_05", 10, read_imm32s());
    }
    break;
    case 0x06:
    {
        gen_fn0("instr16_06", 10);
    }
    break;
    case 0x06|0x100:
    {
        gen_fn0("instr32_06", 10);
    }
    break;
    case 0x07:
    {
        gen_fn0("instr16_07", 10);
    }
    break;
    case 0x07|0x100:
    {
        gen_fn0("instr32_07", 10);
    }
    break;
    case 0x08:
    case 0x08|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_08_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_08_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x09:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_09_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_09_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x09|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_09_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_09_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x0A:
    case 0x0A|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_0A_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_0A_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x0B:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_0B_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_0B_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x0B|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_0B_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_0B_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x0C:
    case 0x0C|0x100:
    {
        gen_fn1("instr_0C", 8, read_imm8());
    }
    break;
    case 0x0D:
    {
        gen_fn1("instr16_0D", 10, read_imm16());
    }
    break;
    case 0x0D|0x100:
    {
        gen_fn1("instr32_0D", 10, read_imm32s());
    }
    break;
    case 0x0E:
    {
        gen_fn0("instr16_0E", 10);
    }
    break;
    case 0x0E|0x100:
    {
        gen_fn0("instr32_0E", 10);
    }
    break;
    case 0x0F:
    {
        instr16_0F_jit();
    }
    break;
    case 0x0F|0x100:
    {
        instr32_0F_jit();
    }
    break;
    case 0x10:
    case 0x10|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_10_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_10_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x11:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_11_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_11_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x11|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_11_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_11_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x12:
    case 0x12|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_12_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_12_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x13:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_13_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_13_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x13|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_13_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_13_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x14:
    case 0x14|0x100:
    {
        gen_fn1("instr_14", 8, read_imm8());
    }
    break;
    case 0x15:
    {
        gen_fn1("instr16_15", 10, read_imm16());
    }
    break;
    case 0x15|0x100:
    {
        gen_fn1("instr32_15", 10, read_imm32s());
    }
    break;
    case 0x16:
    {
        gen_fn0("instr16_16", 10);
    }
    break;
    case 0x16|0x100:
    {
        gen_fn0("instr32_16", 10);
    }
    break;
    case 0x17:
    {
        gen_fn0("instr16_17", 10);
    }
    break;
    case 0x17|0x100:
    {
        gen_fn0("instr32_17", 10);
    }
    break;
    case 0x18:
    case 0x18|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_18_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_18_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x19:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_19_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_19_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x19|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_19_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_19_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x1A:
    case 0x1A|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_1A_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_1A_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x1B:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_1B_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_1B_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x1B|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_1B_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_1B_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x1C:
    case 0x1C|0x100:
    {
        gen_fn1("instr_1C", 8, read_imm8());
    }
    break;
    case 0x1D:
    {
        gen_fn1("instr16_1D", 10, read_imm16());
    }
    break;
    case 0x1D|0x100:
    {
        gen_fn1("instr32_1D", 10, read_imm32s());
    }
    break;
    case 0x1E:
    {
        gen_fn0("instr16_1E", 10);
    }
    break;
    case 0x1E|0x100:
    {
        gen_fn0("instr32_1E", 10);
    }
    break;
    case 0x1F:
    {
        gen_fn0("instr16_1F", 10);
    }
    break;
    case 0x1F|0x100:
    {
        gen_fn0("instr32_1F", 10);
    }
    break;
    case 0x20:
    case 0x20|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_20_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_20_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x21:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_21_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_21_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x21|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_21_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_21_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x22:
    case 0x22|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_22_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_22_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x23:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_23_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_23_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x23|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_23_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_23_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x24:
    case 0x24|0x100:
    {
        gen_fn1("instr_24", 8, read_imm8());
    }
    break;
    case 0x25:
    {
        gen_fn1("instr16_25", 10, read_imm16());
    }
    break;
    case 0x25|0x100:
    {
        gen_fn1("instr32_25", 10, read_imm32s());
    }
    break;
    case 0x26:
    case 0x26|0x100:
    {
        instr_26_jit();
    }
    break;
    case 0x27:
    case 0x27|0x100:
    {
        gen_fn0("instr_27", 8);
    }
    break;
    case 0x28:
    case 0x28|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_28_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_28_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x29:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_29_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_29_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x29|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_29_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_29_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x2A:
    case 0x2A|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_2A_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_2A_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x2B:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_2B_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_2B_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x2B|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_2B_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_2B_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x2C:
    case 0x2C|0x100:
    {
        gen_fn1("instr_2C", 8, read_imm8());
    }
    break;
    case 0x2D:
    {
        gen_fn1("instr16_2D", 10, read_imm16());
    }
    break;
    case 0x2D|0x100:
    {
        gen_fn1("instr32_2D", 10, read_imm32s());
    }
    break;
    case 0x2E:
    case 0x2E|0x100:
    {
        instr_2E_jit();
    }
    break;
    case 0x2F:
    case 0x2F|0x100:
    {
        gen_fn0("instr_2F", 8);
    }
    break;
    case 0x30:
    case 0x30|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_30_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_30_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x31:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_31_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_31_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x31|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_31_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_31_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x32:
    case 0x32|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_32_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_32_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x33:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_33_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_33_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x33|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_33_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_33_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x34:
    case 0x34|0x100:
    {
        gen_fn1("instr_34", 8, read_imm8());
    }
    break;
    case 0x35:
    {
        gen_fn1("instr16_35", 10, read_imm16());
    }
    break;
    case 0x35|0x100:
    {
        gen_fn1("instr32_35", 10, read_imm32s());
    }
    break;
    case 0x36:
    case 0x36|0x100:
    {
        instr_36_jit();
    }
    break;
    case 0x37:
    case 0x37|0x100:
    {
        gen_fn0("instr_37", 8);
    }
    break;
    case 0x38:
    case 0x38|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_38_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_38_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x39:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_39_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_39_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x39|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_39_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_39_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x3A:
    case 0x3A|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_3A_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_3A_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x3B:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_3B_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_3B_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x3B|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_3B_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_3B_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x3C:
    case 0x3C|0x100:
    {
        gen_fn1("instr_3C", 8, read_imm8());
    }
    break;
    case 0x3D:
    {
        gen_fn1("instr16_3D", 10, read_imm16());
    }
    break;
    case 0x3D|0x100:
    {
        gen_fn1("instr32_3D", 10, read_imm32s());
    }
    break;
    case 0x3E:
    case 0x3E|0x100:
    {
        instr_3E_jit();
    }
    break;
    case 0x3F:
    case 0x3F|0x100:
    {
        gen_fn0("instr_3F", 8);
    }
    break;
    case 0x40:
    {
        gen_fn0("instr16_40", 10);
    }
    break;
    case 0x40|0x100:
    {
        gen_fn0("instr32_40", 10);
    }
    break;
    case 0x41:
    {
        gen_fn0("instr16_41", 10);
    }
    break;
    case 0x41|0x100:
    {
        gen_fn0("instr32_41", 10);
    }
    break;
    case 0x42:
    {
        gen_fn0("instr16_42", 10);
    }
    break;
    case 0x42|0x100:
    {
        gen_fn0("instr32_42", 10);
    }
    break;
    case 0x43:
    {
        gen_fn0("instr16_43", 10);
    }
    break;
    case 0x43|0x100:
    {
        gen_fn0("instr32_43", 10);
    }
    break;
    case 0x44:
    {
        gen_fn0("instr16_44", 10);
    }
    break;
    case 0x44|0x100:
    {
        gen_fn0("instr32_44", 10);
    }
    break;
    case 0x45:
    {
        gen_fn0("instr16_45", 10);
    }
    break;
    case 0x45|0x100:
    {
        gen_fn0("instr32_45", 10);
    }
    break;
    case 0x46:
    {
        gen_fn0("instr16_46", 10);
    }
    break;
    case 0x46|0x100:
    {
        gen_fn0("instr32_46", 10);
    }
    break;
    case 0x47:
    {
        gen_fn0("instr16_47", 10);
    }
    break;
    case 0x47|0x100:
    {
        gen_fn0("instr32_47", 10);
    }
    break;
    case 0x48:
    {
        gen_fn0("instr16_48", 10);
    }
    break;
    case 0x48|0x100:
    {
        gen_fn0("instr32_48", 10);
    }
    break;
    case 0x49:
    {
        gen_fn0("instr16_49", 10);
    }
    break;
    case 0x49|0x100:
    {
        gen_fn0("instr32_49", 10);
    }
    break;
    case 0x4A:
    {
        gen_fn0("instr16_4A", 10);
    }
    break;
    case 0x4A|0x100:
    {
        gen_fn0("instr32_4A", 10);
    }
    break;
    case 0x4B:
    {
        gen_fn0("instr16_4B", 10);
    }
    break;
    case 0x4B|0x100:
    {
        gen_fn0("instr32_4B", 10);
    }
    break;
    case 0x4C:
    {
        gen_fn0("instr16_4C", 10);
    }
    break;
    case 0x4C|0x100:
    {
        gen_fn0("instr32_4C", 10);
    }
    break;
    case 0x4D:
    {
        gen_fn0("instr16_4D", 10);
    }
    break;
    case 0x4D|0x100:
    {
        gen_fn0("instr32_4D", 10);
    }
    break;
    case 0x4E:
    {
        gen_fn0("instr16_4E", 10);
    }
    break;
    case 0x4E|0x100:
    {
        gen_fn0("instr32_4E", 10);
    }
    break;
    case 0x4F:
    {
        gen_fn0("instr16_4F", 10);
    }
    break;
    case 0x4F|0x100:
    {
        gen_fn0("instr32_4F", 10);
    }
    break;
    case 0x50:
    {
        gen_fn0("instr16_50", 10);
    }
    break;
    case 0x50|0x100:
    {
        gen_fn0("instr32_50", 10);
    }
    break;
    case 0x51:
    {
        gen_fn0("instr16_51", 10);
    }
    break;
    case 0x51|0x100:
    {
        gen_fn0("instr32_51", 10);
    }
    break;
    case 0x52:
    {
        gen_fn0("instr16_52", 10);
    }
    break;
    case 0x52|0x100:
    {
        gen_fn0("instr32_52", 10);
    }
    break;
    case 0x53:
    {
        gen_fn0("instr16_53", 10);
    }
    break;
    case 0x53|0x100:
    {
        gen_fn0("instr32_53", 10);
    }
    break;
    case 0x54:
    {
        gen_fn0("instr16_54", 10);
    }
    break;
    case 0x54|0x100:
    {
        gen_fn0("instr32_54", 10);
    }
    break;
    case 0x55:
    {
        gen_fn0("instr16_55", 10);
    }
    break;
    case 0x55|0x100:
    {
        gen_fn0("instr32_55", 10);
    }
    break;
    case 0x56:
    {
        gen_fn0("instr16_56", 10);
    }
    break;
    case 0x56|0x100:
    {
        gen_fn0("instr32_56", 10);
    }
    break;
    case 0x57:
    {
        gen_fn0("instr16_57", 10);
    }
    break;
    case 0x57|0x100:
    {
        gen_fn0("instr32_57", 10);
    }
    break;
    case 0x58:
    {
        gen_fn0("instr16_58", 10);
    }
    break;
    case 0x58|0x100:
    {
        gen_fn0("instr32_58", 10);
    }
    break;
    case 0x59:
    {
        gen_fn0("instr16_59", 10);
    }
    break;
    case 0x59|0x100:
    {
        gen_fn0("instr32_59", 10);
    }
    break;
    case 0x5A:
    {
        gen_fn0("instr16_5A", 10);
    }
    break;
    case 0x5A|0x100:
    {
        gen_fn0("instr32_5A", 10);
    }
    break;
    case 0x5B:
    {
        gen_fn0("instr16_5B", 10);
    }
    break;
    case 0x5B|0x100:
    {
        gen_fn0("instr32_5B", 10);
    }
    break;
    case 0x5C:
    {
        gen_fn0("instr16_5C", 10);
    }
    break;
    case 0x5C|0x100:
    {
        gen_fn0("instr32_5C", 10);
    }
    break;
    case 0x5D:
    {
        gen_fn0("instr16_5D", 10);
    }
    break;
    case 0x5D|0x100:
    {
        gen_fn0("instr32_5D", 10);
    }
    break;
    case 0x5E:
    {
        gen_fn0("instr16_5E", 10);
    }
    break;
    case 0x5E|0x100:
    {
        gen_fn0("instr32_5E", 10);
    }
    break;
    case 0x5F:
    {
        gen_fn0("instr16_5F", 10);
    }
    break;
    case 0x5F|0x100:
    {
        gen_fn0("instr32_5F", 10);
    }
    break;
    case 0x60:
    {
        gen_fn0("instr16_60", 10);
    }
    break;
    case 0x60|0x100:
    {
        gen_fn0("instr32_60", 10);
    }
    break;
    case 0x61:
    {
        gen_fn0("instr16_61", 10);
    }
    break;
    case 0x61|0x100:
    {
        gen_fn0("instr32_61", 10);
    }
    break;
    case 0x62:
    case 0x62|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_62_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_62_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x63:
    case 0x63|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_63_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_63_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x64:
    case 0x64|0x100:
    {
        instr_64_jit();
    }
    break;
    case 0x65:
    case 0x65|0x100:
    {
        instr_65_jit();
    }
    break;
    case 0x66:
    case 0x66|0x100:
    {
        instr_66_jit();
    }
    break;
    case 0x67:
    case 0x67|0x100:
    {
        instr_67_jit();
    }
    break;
    case 0x68:
    {
        gen_fn1("instr16_68", 10, read_imm16());
    }
    break;
    case 0x68|0x100:
    {
        gen_fn1("instr32_68", 10, read_imm32s());
    }
    break;
    case 0x69:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_cb_fn2("instr16_69_mem", 14, modrm_byte, modrm_byte >> 3 & 7, read_imm16);
        }
        else
        {
            gen_fn3("instr16_69_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7, read_imm16());
        }
    }
    break;
    case 0x69|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_cb_fn2("instr32_69_mem", 14, modrm_byte, modrm_byte >> 3 & 7, read_imm32s);
        }
        else
        {
            gen_fn3("instr32_69_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7, read_imm32s());
        }
    }
    break;
    case 0x6A:
    {
        gen_fn1("instr16_6A", 10, read_imm8s());
    }
    break;
    case 0x6A|0x100:
    {
        gen_fn1("instr32_6A", 10, read_imm8s());
    }
    break;
    case 0x6B:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_cb_fn2("instr16_6B_mem", 14, modrm_byte, modrm_byte >> 3 & 7, read_imm8s);
        }
        else
        {
            gen_fn3("instr16_6B_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7, read_imm8s());
        }
    }
    break;
    case 0x6B|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_cb_fn2("instr32_6B_mem", 14, modrm_byte, modrm_byte >> 3 & 7, read_imm8s);
        }
        else
        {
            gen_fn3("instr32_6B_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7, read_imm8s());
        }
    }
    break;
    case 0x6C:
    case 0x6C|0x100:
    {
        gen_fn0("instr_6C", 8);
        jit_jump = true;
    }
    break;
    case 0x6D:
    {
        gen_fn0("instr16_6D", 10);
        jit_jump = true;
    }
    break;
    case 0x6D|0x100:
    {
        gen_fn0("instr32_6D", 10);
        jit_jump = true;
    }
    break;
    case 0x6E:
    case 0x6E|0x100:
    {
        gen_fn0("instr_6E", 8);
        jit_jump = true;
    }
    break;
    case 0x6F:
    {
        gen_fn0("instr16_6F", 10);
        jit_jump = true;
    }
    break;
    case 0x6F|0x100:
    {
        gen_fn0("instr32_6F", 10);
        jit_jump = true;
    }
    break;
    case 0x70:
    case 0x70|0x100:
    {
        gen_fn1("instr_70", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x71:
    case 0x71|0x100:
    {
        gen_fn1("instr_71", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x72:
    case 0x72|0x100:
    {
        gen_fn1("instr_72", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x73:
    case 0x73|0x100:
    {
        gen_fn1("instr_73", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x74:
    case 0x74|0x100:
    {
        gen_fn1("instr_74", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x75:
    case 0x75|0x100:
    {
        gen_fn1("instr_75", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x76:
    case 0x76|0x100:
    {
        gen_fn1("instr_76", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x77:
    case 0x77|0x100:
    {
        gen_fn1("instr_77", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x78:
    case 0x78|0x100:
    {
        gen_fn1("instr_78", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x79:
    case 0x79|0x100:
    {
        gen_fn1("instr_79", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x7A:
    case 0x7A|0x100:
    {
        gen_fn1("instr_7A", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x7B:
    case 0x7B|0x100:
    {
        gen_fn1("instr_7B", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x7C:
    case 0x7C|0x100:
    {
        gen_fn1("instr_7C", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x7D:
    case 0x7D|0x100:
    {
        gen_fn1("instr_7D", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x7E:
    case 0x7E|0x100:
    {
        gen_fn1("instr_7E", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x7F:
    case 0x7F|0x100:
    {
        gen_fn1("instr_7F", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0x80:
    case 0x80|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_80_0_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_80_0_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_80_1_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_80_1_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_80_2_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_80_2_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_80_3_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_80_3_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_80_4_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_80_4_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_80_5_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_80_5_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_80_6_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_80_6_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_80_7_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_80_7_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x81:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_81_0_mem", 16, modrm_byte, read_imm16);
                }
                else
                {
                    gen_fn2("instr16_81_0_reg", 16, modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_81_1_mem", 16, modrm_byte, read_imm16);
                }
                else
                {
                    gen_fn2("instr16_81_1_reg", 16, modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_81_2_mem", 16, modrm_byte, read_imm16);
                }
                else
                {
                    gen_fn2("instr16_81_2_reg", 16, modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_81_3_mem", 16, modrm_byte, read_imm16);
                }
                else
                {
                    gen_fn2("instr16_81_3_reg", 16, modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_81_4_mem", 16, modrm_byte, read_imm16);
                }
                else
                {
                    gen_fn2("instr16_81_4_reg", 16, modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_81_5_mem", 16, modrm_byte, read_imm16);
                }
                else
                {
                    gen_fn2("instr16_81_5_reg", 16, modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_81_6_mem", 16, modrm_byte, read_imm16);
                }
                else
                {
                    gen_fn2("instr16_81_6_reg", 16, modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_81_7_mem", 16, modrm_byte, read_imm16);
                }
                else
                {
                    gen_fn2("instr16_81_7_reg", 16, modrm_byte & 7, read_imm16());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x81|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_81_0_mem", 16, modrm_byte, read_imm32s);
                }
                else
                {
                    gen_fn2("instr32_81_0_reg", 16, modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_81_1_mem", 16, modrm_byte, read_imm32s);
                }
                else
                {
                    gen_fn2("instr32_81_1_reg", 16, modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_81_2_mem", 16, modrm_byte, read_imm32s);
                }
                else
                {
                    gen_fn2("instr32_81_2_reg", 16, modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_81_3_mem", 16, modrm_byte, read_imm32s);
                }
                else
                {
                    gen_fn2("instr32_81_3_reg", 16, modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_81_4_mem", 16, modrm_byte, read_imm32s);
                }
                else
                {
                    gen_fn2("instr32_81_4_reg", 16, modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_81_5_mem", 16, modrm_byte, read_imm32s);
                }
                else
                {
                    gen_fn2("instr32_81_5_reg", 16, modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_81_6_mem", 16, modrm_byte, read_imm32s);
                }
                else
                {
                    gen_fn2("instr32_81_6_reg", 16, modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_81_7_mem", 16, modrm_byte, read_imm32s);
                }
                else
                {
                    gen_fn2("instr32_81_7_reg", 16, modrm_byte & 7, read_imm32s());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x82:
    case 0x82|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_82_0_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_82_0_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_82_1_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_82_1_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_82_2_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_82_2_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_82_3_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_82_3_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_82_4_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_82_4_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_82_5_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_82_5_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_82_6_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_82_6_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_82_7_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_82_7_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x83:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_83_0_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr16_83_0_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_83_1_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr16_83_1_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_83_2_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr16_83_2_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_83_3_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr16_83_3_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_83_4_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr16_83_4_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_83_5_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr16_83_5_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_83_6_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr16_83_6_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_83_7_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr16_83_7_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x83|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_83_0_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr32_83_0_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_83_1_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr32_83_1_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_83_2_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr32_83_2_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_83_3_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr32_83_3_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_83_4_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr32_83_4_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_83_5_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr32_83_5_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_83_6_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr32_83_6_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_83_7_mem", 16, modrm_byte, read_imm8s);
                }
                else
                {
                    gen_fn2("instr32_83_7_reg", 16, modrm_byte & 7, read_imm8s());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x84:
    case 0x84|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_84_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_84_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x85:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_85_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_85_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x85|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_85_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_85_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x86:
    case 0x86|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_86_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_86_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x87:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_87_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_87_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x87|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_87_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_87_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x88:
    case 0x88|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_88_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_88_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x89:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_89_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_89_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x89|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_89_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_89_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8A:
    case 0x8A|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_8A_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_8A_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8B:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_8B_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_8B_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8B|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_8B_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_8B_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8C:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_8C_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_8C_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8C|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_8C_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_8C_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8D:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_fn0("instr16_8D_mem_pre", 18);
            gen_modrm_fn1("instr16_8D_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_8D_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8D|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_fn0("instr32_8D_mem_pre", 18);
            gen_modrm_fn1("instr32_8D_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_8D_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8E:
    case 0x8E|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_8E_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_8E_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0x8F:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_fn0("instr16_8F_0_mem_pre", 20);
                    gen_modrm_fn0("instr16_8F_0_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_8F_0_reg", 16, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x8F|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_fn0("instr32_8F_0_mem_pre", 20);
                    gen_modrm_fn0("instr32_8F_0_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_8F_0_reg", 16, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0x90:
    case 0x90|0x100:
    {
        gen_fn0("instr_90", 8);
    }
    break;
    case 0x91:
    {
        gen_fn0("instr16_91", 10);
    }
    break;
    case 0x91|0x100:
    {
        gen_fn0("instr32_91", 10);
    }
    break;
    case 0x92:
    {
        gen_fn0("instr16_92", 10);
    }
    break;
    case 0x92|0x100:
    {
        gen_fn0("instr32_92", 10);
    }
    break;
    case 0x93:
    {
        gen_fn0("instr16_93", 10);
    }
    break;
    case 0x93|0x100:
    {
        gen_fn0("instr32_93", 10);
    }
    break;
    case 0x94:
    {
        gen_fn0("instr16_94", 10);
    }
    break;
    case 0x94|0x100:
    {
        gen_fn0("instr32_94", 10);
    }
    break;
    case 0x95:
    {
        gen_fn0("instr16_95", 10);
    }
    break;
    case 0x95|0x100:
    {
        gen_fn0("instr32_95", 10);
    }
    break;
    case 0x96:
    {
        gen_fn0("instr16_96", 10);
    }
    break;
    case 0x96|0x100:
    {
        gen_fn0("instr32_96", 10);
    }
    break;
    case 0x97:
    {
        gen_fn0("instr16_97", 10);
    }
    break;
    case 0x97|0x100:
    {
        gen_fn0("instr32_97", 10);
    }
    break;
    case 0x98:
    {
        gen_fn0("instr16_98", 10);
    }
    break;
    case 0x98|0x100:
    {
        gen_fn0("instr32_98", 10);
    }
    break;
    case 0x99:
    {
        gen_fn0("instr16_99", 10);
    }
    break;
    case 0x99|0x100:
    {
        gen_fn0("instr32_99", 10);
    }
    break;
    case 0x9A:
    {
        gen_fn2("instr16_9A", 10, read_imm16(), read_imm16());
        jit_jump = true;
    }
    break;
    case 0x9A|0x100:
    {
        gen_fn2("instr32_9A", 10, read_imm32s(), read_imm16());
        jit_jump = true;
    }
    break;
    case 0x9B:
    case 0x9B|0x100:
    {
        gen_fn0("instr_9B", 8);
    }
    break;
    case 0x9C:
    {
        gen_fn0("instr16_9C", 10);
    }
    break;
    case 0x9C|0x100:
    {
        gen_fn0("instr32_9C", 10);
    }
    break;
    case 0x9D:
    {
        gen_fn0("instr16_9D", 10);
    }
    break;
    case 0x9D|0x100:
    {
        gen_fn0("instr32_9D", 10);
    }
    break;
    case 0x9E:
    case 0x9E|0x100:
    {
        gen_fn0("instr_9E", 8);
    }
    break;
    case 0x9F:
    case 0x9F|0x100:
    {
        gen_fn0("instr_9F", 8);
    }
    break;
    case 0xA0:
    case 0xA0|0x100:
    {
        gen_fn1("instr_A0", 8, read_moffs());
    }
    break;
    case 0xA1:
    {
        gen_fn1("instr16_A1", 10, read_moffs());
    }
    break;
    case 0xA1|0x100:
    {
        gen_fn1("instr32_A1", 10, read_moffs());
    }
    break;
    case 0xA2:
    case 0xA2|0x100:
    {
        gen_fn1("instr_A2", 8, read_moffs());
    }
    break;
    case 0xA3:
    {
        gen_fn1("instr16_A3", 10, read_moffs());
    }
    break;
    case 0xA3|0x100:
    {
        gen_fn1("instr32_A3", 10, read_moffs());
    }
    break;
    case 0xA4:
    case 0xA4|0x100:
    {
        gen_fn0("instr_A4", 8);
        jit_jump = true;
    }
    break;
    case 0xA5:
    {
        gen_fn0("instr16_A5", 10);
        jit_jump = true;
    }
    break;
    case 0xA5|0x100:
    {
        gen_fn0("instr32_A5", 10);
        jit_jump = true;
    }
    break;
    case 0xA6:
    case 0xA6|0x100:
    {
        gen_fn0("instr_A6", 8);
        jit_jump = true;
    }
    break;
    case 0xA7:
    {
        gen_fn0("instr16_A7", 10);
        jit_jump = true;
    }
    break;
    case 0xA7|0x100:
    {
        gen_fn0("instr32_A7", 10);
        jit_jump = true;
    }
    break;
    case 0xA8:
    case 0xA8|0x100:
    {
        gen_fn1("instr_A8", 8, read_imm8());
    }
    break;
    case 0xA9:
    {
        gen_fn1("instr16_A9", 10, read_imm16());
    }
    break;
    case 0xA9|0x100:
    {
        gen_fn1("instr32_A9", 10, read_imm32s());
    }
    break;
    case 0xAA:
    case 0xAA|0x100:
    {
        gen_fn0("instr_AA", 8);
        jit_jump = true;
    }
    break;
    case 0xAB:
    {
        gen_fn0("instr16_AB", 10);
        jit_jump = true;
    }
    break;
    case 0xAB|0x100:
    {
        gen_fn0("instr32_AB", 10);
        jit_jump = true;
    }
    break;
    case 0xAC:
    case 0xAC|0x100:
    {
        gen_fn0("instr_AC", 8);
        jit_jump = true;
    }
    break;
    case 0xAD:
    {
        gen_fn0("instr16_AD", 10);
        jit_jump = true;
    }
    break;
    case 0xAD|0x100:
    {
        gen_fn0("instr32_AD", 10);
        jit_jump = true;
    }
    break;
    case 0xAE:
    case 0xAE|0x100:
    {
        gen_fn0("instr_AE", 8);
        jit_jump = true;
    }
    break;
    case 0xAF:
    {
        gen_fn0("instr16_AF", 10);
        jit_jump = true;
    }
    break;
    case 0xAF|0x100:
    {
        gen_fn0("instr32_AF", 10);
        jit_jump = true;
    }
    break;
    case 0xB0:
    case 0xB0|0x100:
    {
        gen_fn1("instr_B0", 8, read_imm8());
    }
    break;
    case 0xB1:
    case 0xB1|0x100:
    {
        gen_fn1("instr_B1", 8, read_imm8());
    }
    break;
    case 0xB2:
    case 0xB2|0x100:
    {
        gen_fn1("instr_B2", 8, read_imm8());
    }
    break;
    case 0xB3:
    case 0xB3|0x100:
    {
        gen_fn1("instr_B3", 8, read_imm8());
    }
    break;
    case 0xB4:
    case 0xB4|0x100:
    {
        gen_fn1("instr_B4", 8, read_imm8());
    }
    break;
    case 0xB5:
    case 0xB5|0x100:
    {
        gen_fn1("instr_B5", 8, read_imm8());
    }
    break;
    case 0xB6:
    case 0xB6|0x100:
    {
        gen_fn1("instr_B6", 8, read_imm8());
    }
    break;
    case 0xB7:
    case 0xB7|0x100:
    {
        gen_fn1("instr_B7", 8, read_imm8());
    }
    break;
    case 0xB8:
    {
        gen_fn1("instr16_B8", 10, read_imm16());
    }
    break;
    case 0xB8|0x100:
    {
        gen_fn1("instr32_B8", 10, read_imm32s());
    }
    break;
    case 0xB9:
    {
        gen_fn1("instr16_B9", 10, read_imm16());
    }
    break;
    case 0xB9|0x100:
    {
        gen_fn1("instr32_B9", 10, read_imm32s());
    }
    break;
    case 0xBA:
    {
        gen_fn1("instr16_BA", 10, read_imm16());
    }
    break;
    case 0xBA|0x100:
    {
        gen_fn1("instr32_BA", 10, read_imm32s());
    }
    break;
    case 0xBB:
    {
        gen_fn1("instr16_BB", 10, read_imm16());
    }
    break;
    case 0xBB|0x100:
    {
        gen_fn1("instr32_BB", 10, read_imm32s());
    }
    break;
    case 0xBC:
    {
        gen_fn1("instr16_BC", 10, read_imm16());
    }
    break;
    case 0xBC|0x100:
    {
        gen_fn1("instr32_BC", 10, read_imm32s());
    }
    break;
    case 0xBD:
    {
        gen_fn1("instr16_BD", 10, read_imm16());
    }
    break;
    case 0xBD|0x100:
    {
        gen_fn1("instr32_BD", 10, read_imm32s());
    }
    break;
    case 0xBE:
    {
        gen_fn1("instr16_BE", 10, read_imm16());
    }
    break;
    case 0xBE|0x100:
    {
        gen_fn1("instr32_BE", 10, read_imm32s());
    }
    break;
    case 0xBF:
    {
        gen_fn1("instr16_BF", 10, read_imm16());
    }
    break;
    case 0xBF|0x100:
    {
        gen_fn1("instr32_BF", 10, read_imm32s());
    }
    break;
    case 0xC0:
    case 0xC0|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_C0_0_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_C0_0_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_C0_1_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_C0_1_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_C0_2_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_C0_2_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_C0_3_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_C0_3_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_C0_4_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_C0_4_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_C0_5_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_C0_5_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_C0_6_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_C0_6_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_C0_7_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_C0_7_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xC1:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_C1_0_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr16_C1_0_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_C1_1_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr16_C1_1_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_C1_2_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr16_C1_2_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_C1_3_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr16_C1_3_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_C1_4_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr16_C1_4_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_C1_5_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr16_C1_5_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_C1_6_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr16_C1_6_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_C1_7_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr16_C1_7_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xC1|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_C1_0_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr32_C1_0_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_C1_1_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr32_C1_1_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_C1_2_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr32_C1_2_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_C1_3_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr32_C1_3_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_C1_4_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr32_C1_4_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_C1_5_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr32_C1_5_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_C1_6_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr32_C1_6_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_C1_7_mem", 16, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr32_C1_7_reg", 16, modrm_byte & 7, read_imm8());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xC2:
    {
        gen_fn1("instr16_C2", 10, read_imm16());
        jit_jump = true;
    }
    break;
    case 0xC2|0x100:
    {
        gen_fn1("instr32_C2", 10, read_imm16());
        jit_jump = true;
    }
    break;
    case 0xC3:
    {
        gen_fn0("instr16_C3", 10);
        jit_jump = true;
    }
    break;
    case 0xC3|0x100:
    {
        gen_fn0("instr32_C3", 10);
        jit_jump = true;
    }
    break;
    case 0xC4:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_C4_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_C4_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xC4|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_C4_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_C4_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xC5:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr16_C5_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr16_C5_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xC5|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr32_C5_mem", 14, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr32_C5_reg", 14, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xC6:
    case 0xC6|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_C6_0_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_C6_0_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xC7:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_C7_0_mem", 16, modrm_byte, read_imm16);
                }
                else
                {
                    gen_fn2("instr16_C7_0_reg", 16, modrm_byte & 7, read_imm16());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xC7|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_C7_0_mem", 16, modrm_byte, read_imm32s);
                }
                else
                {
                    gen_fn2("instr32_C7_0_reg", 16, modrm_byte & 7, read_imm32s());
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xC8:
    {
        gen_fn2("instr16_C8", 10, read_imm16(), read_imm8());
    }
    break;
    case 0xC8|0x100:
    {
        gen_fn2("instr32_C8", 10, read_imm16(), read_imm8());
    }
    break;
    case 0xC9:
    {
        gen_fn0("instr16_C9", 10);
    }
    break;
    case 0xC9|0x100:
    {
        gen_fn0("instr32_C9", 10);
    }
    break;
    case 0xCA:
    {
        gen_fn1("instr16_CA", 10, read_imm16());
        jit_jump = true;
    }
    break;
    case 0xCA|0x100:
    {
        gen_fn1("instr32_CA", 10, read_imm16());
        jit_jump = true;
    }
    break;
    case 0xCB:
    {
        gen_fn0("instr16_CB", 10);
        jit_jump = true;
    }
    break;
    case 0xCB|0x100:
    {
        gen_fn0("instr32_CB", 10);
        jit_jump = true;
    }
    break;
    case 0xCC:
    case 0xCC|0x100:
    {
        gen_fn0("instr_CC", 8);
        jit_jump = true;
    }
    break;
    case 0xCD:
    case 0xCD|0x100:
    {
        gen_fn1("instr_CD", 8, read_imm8());
        jit_jump = true;
    }
    break;
    case 0xCE:
    case 0xCE|0x100:
    {
        gen_fn0("instr_CE", 8);
        jit_jump = true;
    }
    break;
    case 0xCF:
    {
        gen_fn0("instr16_CF", 10);
        jit_jump = true;
    }
    break;
    case 0xCF|0x100:
    {
        gen_fn0("instr32_CF", 10);
        jit_jump = true;
    }
    break;
    case 0xD0:
    case 0xD0|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D0_0_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D0_0_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D0_1_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D0_1_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D0_2_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D0_2_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D0_3_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D0_3_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D0_4_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D0_4_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D0_5_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D0_5_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D0_6_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D0_6_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D0_7_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D0_7_reg", 14, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xD1:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D1_0_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D1_0_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D1_1_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D1_1_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D1_2_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D1_2_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D1_3_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D1_3_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D1_4_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D1_4_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D1_5_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D1_5_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D1_6_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D1_6_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D1_7_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D1_7_reg", 16, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xD1|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D1_0_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D1_0_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D1_1_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D1_1_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D1_2_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D1_2_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D1_3_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D1_3_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D1_4_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D1_4_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D1_5_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D1_5_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D1_6_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D1_6_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D1_7_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D1_7_reg", 16, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xD2:
    case 0xD2|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D2_0_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D2_0_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D2_1_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D2_1_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D2_2_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D2_2_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D2_3_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D2_3_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D2_4_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D2_4_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D2_5_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D2_5_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D2_6_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D2_6_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_D2_7_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_D2_7_reg", 14, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xD3:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D3_0_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D3_0_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D3_1_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D3_1_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D3_2_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D3_2_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D3_3_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D3_3_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D3_4_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D3_4_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D3_5_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D3_5_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D3_6_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D3_6_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_D3_7_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_D3_7_reg", 16, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xD3|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D3_0_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D3_0_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D3_1_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D3_1_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D3_2_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D3_2_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D3_3_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D3_3_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D3_4_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D3_4_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D3_5_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D3_5_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D3_6_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D3_6_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_D3_7_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_D3_7_reg", 16, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xD4:
    case 0xD4|0x100:
    {
        gen_fn1("instr_D4", 8, read_imm8());
    }
    break;
    case 0xD5:
    case 0xD5|0x100:
    {
        gen_fn1("instr_D5", 8, read_imm8());
    }
    break;
    case 0xD6:
    case 0xD6|0x100:
    {
        gen_fn0("instr_D6", 8);
    }
    break;
    case 0xD7:
    case 0xD7|0x100:
    {
        gen_fn0("instr_D7", 8);
    }
    break;
    case 0xD8:
    case 0xD8|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_D8_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_D8_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xD9:
    case 0xD9|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_D9_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_D9_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xDA:
    case 0xDA|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_DA_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_DA_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xDB:
    case 0xDB|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_DB_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_DB_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xDC:
    case 0xDC|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_DC_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_DC_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xDD:
    case 0xDD|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_DD_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_DD_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xDE:
    case 0xDE|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_DE_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_DE_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xDF:
    case 0xDF|0x100:
    {
        int32_t modrm_byte = read_imm8();
        if(modrm_byte < 0xC0)
        {
            gen_modrm_fn1("instr_DF_mem", 12, modrm_byte, modrm_byte >> 3 & 7);
        }
        else
        {
            gen_fn2("instr_DF_reg", 12, modrm_byte & 7, modrm_byte >> 3 & 7);
        }
    }
    break;
    case 0xE0:
    case 0xE0|0x100:
    {
        gen_fn1("instr_E0", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0xE1:
    case 0xE1|0x100:
    {
        gen_fn1("instr_E1", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0xE2:
    case 0xE2|0x100:
    {
        gen_fn1("instr_E2", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0xE3:
    case 0xE3|0x100:
    {
        gen_fn1("instr_E3", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0xE4:
    case 0xE4|0x100:
    {
        gen_fn1("instr_E4", 8, read_imm8());
        jit_jump = true;
    }
    break;
    case 0xE5:
    {
        gen_fn1("instr16_E5", 10, read_imm8());
        jit_jump = true;
    }
    break;
    case 0xE5|0x100:
    {
        gen_fn1("instr32_E5", 10, read_imm8());
        jit_jump = true;
    }
    break;
    case 0xE6:
    case 0xE6|0x100:
    {
        gen_fn1("instr_E6", 8, read_imm8());
        jit_jump = true;
    }
    break;
    case 0xE7:
    {
        gen_fn1("instr16_E7", 10, read_imm8());
        jit_jump = true;
    }
    break;
    case 0xE7|0x100:
    {
        gen_fn1("instr32_E7", 10, read_imm8());
        jit_jump = true;
    }
    break;
    case 0xE8:
    {
        gen_fn1("instr16_E8", 10, read_imm16());
        jit_jump = true;
    }
    break;
    case 0xE8|0x100:
    {
        gen_fn1("instr32_E8", 10, read_imm32s());
        jit_jump = true;
    }
    break;
    case 0xE9:
    {
        gen_fn1("instr16_E9", 10, read_imm16());
        jit_jump = true;
    }
    break;
    case 0xE9|0x100:
    {
        gen_fn1("instr32_E9", 10, read_imm32s());
        jit_jump = true;
    }
    break;
    case 0xEA:
    {
        gen_fn2("instr16_EA", 10, read_imm16(), read_imm16());
        jit_jump = true;
    }
    break;
    case 0xEA|0x100:
    {
        gen_fn2("instr32_EA", 10, read_imm32s(), read_imm16());
        jit_jump = true;
    }
    break;
    case 0xEB:
    case 0xEB|0x100:
    {
        gen_fn1("instr_EB", 8, read_imm8s());
        jit_jump = true;
    }
    break;
    case 0xEC:
    case 0xEC|0x100:
    {
        gen_fn0("instr_EC", 8);
        jit_jump = true;
    }
    break;
    case 0xED:
    {
        gen_fn0("instr16_ED", 10);
        jit_jump = true;
    }
    break;
    case 0xED|0x100:
    {
        gen_fn0("instr32_ED", 10);
        jit_jump = true;
    }
    break;
    case 0xEE:
    case 0xEE|0x100:
    {
        gen_fn0("instr_EE", 8);
        jit_jump = true;
    }
    break;
    case 0xEF:
    {
        gen_fn0("instr16_EF", 10);
        jit_jump = true;
    }
    break;
    case 0xEF|0x100:
    {
        gen_fn0("instr32_EF", 10);
        jit_jump = true;
    }
    break;
    case 0xF0:
    case 0xF0|0x100:
    {
        instr_F0_jit();
    }
    break;
    case 0xF1:
    case 0xF1|0x100:
    {
        gen_fn0("instr_F1", 8);
    }
    break;
    case 0xF2:
    case 0xF2|0x100:
    {
        instr_F2_jit();
    }
    break;
    case 0xF3:
    case 0xF3|0x100:
    {
        instr_F3_jit();
    }
    break;
    case 0xF4:
    case 0xF4|0x100:
    {
        gen_fn0("instr_F4", 8);
    }
    break;
    case 0xF5:
    case 0xF5|0x100:
    {
        gen_fn0("instr_F5", 8);
    }
    break;
    case 0xF6:
    case 0xF6|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_F6_0_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_F6_0_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr_F6_1_mem", 14, modrm_byte, read_imm8);
                }
                else
                {
                    gen_fn2("instr_F6_1_reg", 14, modrm_byte & 7, read_imm8());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_F6_2_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_F6_2_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_F6_3_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_F6_3_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_F6_4_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_F6_4_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_F6_5_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_F6_5_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_F6_6_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_F6_6_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_F6_7_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_F6_7_reg", 14, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xF7:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_F7_0_mem", 16, modrm_byte, read_imm16);
                }
                else
                {
                    gen_fn2("instr16_F7_0_reg", 16, modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr16_F7_1_mem", 16, modrm_byte, read_imm16);
                }
                else
                {
                    gen_fn2("instr16_F7_1_reg", 16, modrm_byte & 7, read_imm16());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_F7_2_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_F7_2_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_F7_3_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_F7_3_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_F7_4_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_F7_4_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_F7_5_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_F7_5_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_F7_6_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_F7_6_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_F7_7_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_F7_7_reg", 16, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xF7|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_F7_0_mem", 16, modrm_byte, read_imm32s);
                }
                else
                {
                    gen_fn2("instr32_F7_0_reg", 16, modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_cb_fn1("instr32_F7_1_mem", 16, modrm_byte, read_imm32s);
                }
                else
                {
                    gen_fn2("instr32_F7_1_reg", 16, modrm_byte & 7, read_imm32s());
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_F7_2_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_F7_2_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_F7_3_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_F7_3_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_F7_4_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_F7_4_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_F7_5_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_F7_5_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_F7_6_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_F7_6_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 7:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_F7_7_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_F7_7_reg", 16, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xF8:
    case 0xF8|0x100:
    {
        gen_fn0("instr_F8", 8);
    }
    break;
    case 0xF9:
    case 0xF9|0x100:
    {
        gen_fn0("instr_F9", 8);
    }
    break;
    case 0xFA:
    case 0xFA|0x100:
    {
        gen_fn0("instr_FA", 8);
    }
    break;
    case 0xFB:
    case 0xFB|0x100:
    {
        gen_fn0("instr_FB", 8);
        jit_jump = true;
    }
    break;
    case 0xFC:
    case 0xFC|0x100:
    {
        gen_fn0("instr_FC", 8);
    }
    break;
    case 0xFD:
    case 0xFD|0x100:
    {
        gen_fn0("instr_FD", 8);
    }
    break;
    case 0xFE:
    case 0xFE|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_FE_0_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_FE_0_reg", 14, modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr_FE_1_mem", 14, modrm_byte);
                }
                else
                {
                    gen_fn1("instr_FE_1_reg", 14, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xFF:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_FF_0_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_FF_0_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_FF_1_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_FF_1_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_FF_2_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_FF_2_reg", 16, modrm_byte & 7);
                }
                jit_jump = true;
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_FF_3_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_FF_3_reg", 16, modrm_byte & 7);
                }
                jit_jump = true;
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_FF_4_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_FF_4_reg", 16, modrm_byte & 7);
                }
                jit_jump = true;
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_FF_5_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_FF_5_reg", 16, modrm_byte & 7);
                }
                jit_jump = true;
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr16_FF_6_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr16_FF_6_reg", 16, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    case 0xFF|0x100:
    {
        int32_t modrm_byte = read_imm8();
        switch(modrm_byte >> 3 & 7)
        {
            case 0:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_FF_0_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_FF_0_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 1:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_FF_1_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_FF_1_reg", 16, modrm_byte & 7);
                }
            }
            break;
            case 2:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_FF_2_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_FF_2_reg", 16, modrm_byte & 7);
                }
                jit_jump = true;
            }
            break;
            case 3:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_FF_3_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_FF_3_reg", 16, modrm_byte & 7);
                }
                jit_jump = true;
            }
            break;
            case 4:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_FF_4_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_FF_4_reg", 16, modrm_byte & 7);
                }
                jit_jump = true;
            }
            break;
            case 5:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_FF_5_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_FF_5_reg", 16, modrm_byte & 7);
                }
                jit_jump = true;
            }
            break;
            case 6:
            {
                if(modrm_byte < 0xC0)
                {
                    gen_modrm_fn0("instr32_FF_6_mem", 16, modrm_byte);
                }
                else
                {
                    gen_fn1("instr32_FF_6_reg", 16, modrm_byte & 7);
                }
            }
            break;
            default:
                assert(false);
                trigger_ud();
        }
    }
    break;
    default:
        assert(false);
}
}

#pragma clang diagnostic pop
