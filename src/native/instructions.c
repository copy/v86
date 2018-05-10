#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#include "arith.h"
#include "codegen/codegen.h"
#include "codegen/wasm_util.h"
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
#include "profiler/profiler.h"
#include "shared.h"
#include "string.h"

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-parameter"

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

jit_instr_flags instr16_0F_jit() {
    return jit_instruction0f_16(read_imm8());
}
jit_instr_flags instr32_0F_jit() {
    return jit_instruction0f_32(read_imm8());
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
jit_instr_flags instr_26_jit() { return segment_prefix_op_jit(ES); }
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
jit_instr_flags instr_2E_jit() { return segment_prefix_op_jit(CS); }
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
jit_instr_flags instr_36_jit() { return segment_prefix_op_jit(SS); }
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
jit_instr_flags instr_3E_jit() { return segment_prefix_op_jit(DS); }
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
void instr16_5C() { reg16[SP] = safe_read16(get_stack_pointer(0)); }
void instr32_5C() { reg32s[ESP] = safe_read32s(get_stack_pointer(0)); }
void instr16_5D() { reg16[BP] = pop16(); }
void instr32_5D() { reg32s[EBP] = pop32s(); }
void instr16_5E() { reg16[SI] = pop16(); }
void instr32_5E() { reg32s[ESI] = pop32s(); }
void instr16_5F() { reg16[DI] = pop16(); }
void instr32_5F() { reg32s[EDI] = pop32s(); }

void instr16_50_jit() { push16_reg_jit(AX); }
void instr32_50_jit() { push32_reg_jit(EAX); }
void instr16_51_jit() { push16_reg_jit(CX); }
void instr32_51_jit() { push32_reg_jit(ECX); }
void instr16_52_jit() { push16_reg_jit(DX); }
void instr32_52_jit() { push32_reg_jit(EDX); }
void instr16_53_jit() { push16_reg_jit(BX); }
void instr32_53_jit() { push32_reg_jit(EBX); }
void instr16_54_jit() { push16_reg_jit(SP); }
void instr32_54_jit() { push32_reg_jit(ESP); }
void instr16_55_jit() { push16_reg_jit(BP); }
void instr32_55_jit() { push32_reg_jit(EBP); }
void instr16_56_jit() { push16_reg_jit(SI); }
void instr32_56_jit() { push32_reg_jit(ESI); }
void instr16_57_jit() { push16_reg_jit(DI); }
void instr32_57_jit() { push32_reg_jit(EDI); }

void instr16_58_jit() { pop16_reg_jit(AX); }
void instr32_58_jit() { pop32s_reg_jit(EAX); }
void instr16_59_jit() { pop16_reg_jit(CX); }
void instr32_59_jit() { pop32s_reg_jit(ECX); }
void instr16_5A_jit() { pop16_reg_jit(DX); }
void instr32_5A_jit() { pop32s_reg_jit(EDX); }
void instr16_5B_jit() { pop16_reg_jit(BX); }
void instr32_5B_jit() { pop32s_reg_jit(EBX); }
void instr16_5D_jit() { pop16_reg_jit(BP); }
void instr32_5D_jit() { pop32s_reg_jit(EBP); }
void instr16_5E_jit() { pop16_reg_jit(SI); }
void instr32_5E_jit() { pop32s_reg_jit(ESI); }
void instr16_5F_jit() { pop16_reg_jit(DI); }
void instr32_5F_jit() { pop32s_reg_jit(EDI); }


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
jit_instr_flags instr_64_jit() { return segment_prefix_op_jit(FS); }
void instr_65() { segment_prefix_op(GS); }
jit_instr_flags instr_65_jit() { return segment_prefix_op_jit(GS); }

void instr_66() {
    // Operand-size override prefix
    *prefixes |= PREFIX_MASK_OPSIZE;
    run_prefix_instruction();
    *prefixes = 0;
}
jit_instr_flags instr_66_jit() {
    // Operand-size override prefix

    // This affects both decoding and instructions at runtime, so we set
    // prefixes directly *and* in the generated code
    *prefixes |= PREFIX_MASK_OPSIZE;
    gen_add_prefix_bits(PREFIX_MASK_OPSIZE);
    jit_instr_flags instr_flags = jit_prefix_instruction();
    *prefixes = 0;
    gen_clear_prefixes();
    return instr_flags;
}

void instr_67() {
    // Address-size override prefix
    dbg_assert(is_asize_32() == *is_32);
    *prefixes |= PREFIX_MASK_ADDRSIZE;
    run_prefix_instruction();
    *prefixes = 0;
}
jit_instr_flags instr_67_jit() {
    // Address-size override prefix

    // This affects both decoding and instructions at runtime, so we set
    // prefixes directly *and* in the generated code
    dbg_assert(is_asize_32() == *is_32);
    *prefixes |= PREFIX_MASK_ADDRSIZE;
    gen_add_prefix_bits(PREFIX_MASK_ADDRSIZE);
    jit_instr_flags instr_flags = jit_prefix_instruction();
    *prefixes = 0;
    gen_clear_prefixes();
    return instr_flags;
}

void instr16_68(int32_t imm16) { push16(imm16); }
void instr32_68(int32_t imm32) { push32(imm32); }

void instr16_68_jit(int32_t imm16) { push16_imm_jit(imm16); }
void instr32_68_jit(int32_t imm32) { push32_imm_jit(imm32); }

void instr16_69_mem(int32_t addr, int32_t r, int32_t imm) { write_reg16(r, imul_reg16(safe_read16(addr) << 16 >> 16, imm << 16 >> 16)); }
void instr16_69_reg(int32_t r1, int32_t r, int32_t imm) { write_reg16(r, imul_reg16(read_reg16(r1) << 16 >> 16, imm << 16 >> 16)); }
void instr32_69_mem(int32_t addr, int32_t r, int32_t imm) { write_reg32(r, imul_reg32(safe_read32s(addr), imm)); }
void instr32_69_reg(int32_t r1, int32_t r, int32_t imm) { write_reg32(r, imul_reg32(read_reg32(r1), imm)); }

void instr16_6A(int32_t imm8) { push16(imm8); }
void instr32_6A(int32_t imm8) { push32(imm8); }

void instr16_6A_jit(int32_t imm8) { push16_imm_jit(imm8); }
void instr32_6A_jit(int32_t imm8) { push32_imm_jit(imm8); }

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

void instr_70_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_o"); }
void instr_71_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_no"); }
void instr_72_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_b"); }
void instr_73_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_nb"); }
void instr_74_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_z"); }
void instr_75_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_nz"); }
void instr_76_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_be"); }
void instr_77_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_nbe"); }
void instr_78_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_s"); }
void instr_79_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_ns"); }
void instr_7A_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_p"); }
void instr_7B_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_np"); }
void instr_7C_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_l"); }
void instr_7D_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_nl"); }
void instr_7E_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_le"); }
void instr_7F_jit(int32_t imm8) { jit_link_block_conditional(imm8, "test_nle"); }

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

void instr16_89_reg_jit(int32_t r_dest, int32_t r_src)
{
    gen_set_reg16_r(get_reg16_index(r_dest), get_reg16_index(r_src));
}
void instr32_89_reg_jit(int32_t r_dest, int32_t r_src)
{
    gen_set_reg32_r(r_dest, r_src);
}

void instr16_89_mem_jit(int32_t modrm_byte, int32_t r)
{
    // XXX
    gen_modrm_resolve(modrm_byte); gen_modrm_fn1("instr16_89_mem", 14, modrm_byte >> 3 & 7);
}
void instr32_89_mem_jit(int32_t modrm_byte, int32_t r)
{
    // Pseudo: safe_write32(modrm_resolve(modrm_byte), reg32s[r]);
    gen_modrm_resolve(modrm_byte);
    gen_const_i32((uint32_t) &reg32s[r]);
    gen_load_aligned_i32_from_stack(0);
    gen_safe_write32();
}

DEFINE_MODRM_INSTR_READ8(instr_8A, write_reg8(r, ___))
DEFINE_MODRM_INSTR_READ16(instr16_8B, write_reg16(r, ___))
DEFINE_MODRM_INSTR_READ32(instr32_8B, write_reg32(r, ___))

void instr16_8B_reg_jit(int32_t r_src, int32_t r_dest)
{
    gen_set_reg16_r(get_reg16_index(r_dest), get_reg16_index(r_src));
}
void instr32_8B_reg_jit(int32_t r_src, int32_t r_dest)
{
    gen_set_reg32_r(r_dest, r_src);
}

void instr16_8B_mem_jit(int32_t modrm_byte, int32_t r)
{
    // XXX
    gen_modrm_resolve(modrm_byte); gen_modrm_fn1("instr16_8B_mem", 14, modrm_byte >> 3 & 7);
}
void instr32_8B_mem_jit(int32_t modrm_byte, int32_t r)
{
    // Pseudo: reg32s[r] = safe_read32s(modrm_resolve(modrm_byte));
    gen_const_i32((int32_t) &reg32s[r]);

    gen_modrm_resolve(modrm_byte);
    gen_safe_read32();

    gen_store_aligned_i32();
}

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
void instr16_8D_mem(int32_t addr, int32_t r)
{
    // lea
    write_reg16(r, addr);
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
void instr32_8D_mem(int32_t addr, int32_t r) {
    // lea
    write_reg32(r, addr);
    *prefixes = 0;
}

void instr16_8D_mem_jit(int32_t modrm_byte)
{
    int32_t loc = (int32_t) &reg16[get_reg16_index(modrm_byte >> 3 & 7)];
    push_u32(&instruction_body, loc);
    // override prefix, so modrm_resolve does not return the segment part
    *prefixes |= SEG_PREFIX_ZERO;
    gen_modrm_resolve(modrm_byte);
    store_aligned_u16(&instruction_body);
    *prefixes = 0;
}

void instr32_8D_mem_jit(int32_t modrm_byte)
{
    int32_t loc = (int32_t) &reg32s[modrm_byte >> 3 & 7];
    push_u32(&instruction_body, loc);
    // override prefix, so modrm_resolve does not return the segment part
    *prefixes |= SEG_PREFIX_ZERO;
    gen_modrm_resolve(modrm_byte);
    store_aligned_i32(&instruction_body);
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

    // esp must be adjusted before calling modrm_resolve
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

void instr16_8F_0_jit_mem(int32_t modrm_byte)
{
    gen_fn0_const("instr16_8F_0_mem_pre", 20);
    gen_modrm_resolve(modrm_byte);
    gen_modrm_fn0("instr16_8F_0_mem", 16);
}

void instr16_8F_0_jit_reg(int32_t r)
{
    gen_fn1_const("instr16_8F_0_reg", 16, r);
}

void instr32_8F_0_jit_mem(int32_t modrm_byte)
{
    gen_fn0_const("instr32_8F_0_mem_pre", 20);
    gen_modrm_resolve(modrm_byte);
    gen_modrm_fn0("instr32_8F_0_mem", 16);
}

void instr32_8F_0_jit_reg(int32_t r)
{
    gen_fn1_const("instr32_8F_0_reg", 16, r);
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
    int32_t cs = get_seg_cs();

    instruction_pointer[0] = cs + pop16();
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    adjust_stack_reg(imm16);
}
void instr32_C2(int32_t imm16) {
    // retn
    int32_t cs = get_seg_cs();
    int32_t ip = pop32s();

    dbg_assert(is_asize_32() || ip < 0x10000);
    instruction_pointer[0] = cs + ip;
    adjust_stack_reg(imm16);
}
void instr16_C3() {
    // retn
    int32_t cs = get_seg_cs();
    instruction_pointer[0] = cs + pop16();
}
void instr32_C3() {
    // retn
    int32_t cs = get_seg_cs();
    int32_t ip = pop32s();
    dbg_assert(is_asize_32() || ip < 0x10000);
    instruction_pointer[0] = cs + ip;
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
    int32_t new_bp = safe_read16(get_seg_ss() + old_vbp);
    set_stack_reg(old_vbp + 2);
    reg16[BP] = new_bp;
}
void instr32_C9() {
    int32_t old_vbp = *stack_size_32 ? reg32s[EBP] : reg16[BP];
    int32_t new_ebp = safe_read32s(get_seg_ss() + old_vbp);
    set_stack_reg(old_vbp + 4);
    reg32s[EBP] = new_ebp;
}
void instr16_CA(int32_t imm16) {
    // retf
    int32_t ip = safe_read16(get_stack_pointer(0));
    int32_t cs = safe_read16(get_stack_pointer(2));

    far_return(ip, cs, imm16);
}
void instr32_CA(int32_t imm16) {
    // retf
    int32_t ip = safe_read32s(get_stack_pointer(0));
    int32_t cs = safe_read32s(get_stack_pointer(4)) & 0xFFFF;

    far_return(ip, cs, imm16);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
}
void instr16_CB() {
    // retf
    int32_t ip = safe_read16(get_stack_pointer(0));
    int32_t cs = safe_read16(get_stack_pointer(2));

    far_return(ip, cs, 0);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
}
void instr32_CB() {
    // retf
    int32_t ip = safe_read32s(get_stack_pointer(0));
    int32_t cs = safe_read32s(get_stack_pointer(4)) & 0xFFFF;

    far_return(ip, cs, 0);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
}

void instr_CC() {
    // INT3
    // TODO: inhibit iopl checks
    dbg_log("INT3");
    call_interrupt_vector(3, true, false, 0);
}
void instr_CD(int32_t imm8) {
    // INT
    call_interrupt_vector(imm8, true, false, 0);
}
void instr_CE() {
    // INTO
    dbg_log("INTO");
    if(getof())
    {
        // TODO: inhibit iopl checks
        call_interrupt_vector(4, true, false, 0);
    }
}

void instr16_CF() {
    // iret
    iret16();
}
void instr32_CF() {
    iret32();
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

DEFINE_MODRM_INSTR_FPU_READ32(instr_D8_0, fpu_fadd(0, ___))
DEFINE_MODRM_INSTR_FPU_READ32(instr_D8_1, fpu_fmul(0, ___))
DEFINE_MODRM_INSTR_FPU_READ32(instr_D8_2, fpu_fcom(___))
DEFINE_MODRM_INSTR_FPU_READ32(instr_D8_3, fpu_fcomp(___))
DEFINE_MODRM_INSTR_FPU_READ32(instr_D8_4, fpu_fsub(0, ___))
DEFINE_MODRM_INSTR_FPU_READ32(instr_D8_5, fpu_fsubr(0, ___))
DEFINE_MODRM_INSTR_FPU_READ32(instr_D8_6, fpu_fdiv(0, ___))
DEFINE_MODRM_INSTR_FPU_READ32(instr_D8_7, fpu_fdivr(0, ___))

DEFINE_MODRM_INSTR_FPU_READ32(instr_D9_0, fpu_push(___))
void instr_D9_1_mem(int32_t addr) { task_switch_test(); dbg_log("d9/1"); trigger_ud(); }
void instr_D9_1_reg(int32_t r) { task_switch_test(); fpu_fxch(r); }
void instr_D9_2_mem(int32_t addr) { task_switch_test(); fpu_fstm32(addr); }
void instr_D9_2_reg(int32_t r) { task_switch_test(); if(r != 0) { trigger_ud(); } }
void instr_D9_3_mem(int32_t addr) { task_switch_test(); fpu_fstm32p(addr); }
void instr_D9_3_reg(int32_t r) { task_switch_test(); dbg_log("fstp1"); trigger_ud(); }
void instr_D9_4_mem(int32_t addr) { task_switch_test(); fpu_fldenv(addr); }
void instr_D9_4_reg(int32_t r)
{
    task_switch_test();
    double_t st0 = fpu_get_st0();
    switch(r)
    {
        case 0:
            // fchs
            fpu_st[*fpu_stack_ptr] = -st0;
            break;
        case 1:
            // fabs
            fpu_st[*fpu_stack_ptr] = fabs(st0);
            break;
        case 4:
            fpu_ftst(st0);
            break;
        case 5:
            fpu_fxam(st0);
            break;
        default:
            dbg_log("%x", r);
            trigger_ud();
    }
}
void instr_D9_5_mem(int32_t addr) { task_switch_test(); fpu_fldcw(addr); }
void instr_D9_5_reg(int32_t r)
{
    // fld1/fldl2t/fldl2e/fldpi/fldlg2/fldln2/fldz
    task_switch_test();
    switch(r)
    {
        case 0: fpu_push(1); break;
        case 1: fpu_push(M_LN10 / M_LN2); break;
        case 2: fpu_push(M_LOG2E); break;
        case 3: fpu_push(M_PI); break;
        case 4: fpu_push(M_LN2 / M_LN10); break;
        case 5: fpu_push(M_LN2); break;
        case 6: fpu_push(0); break;
        case 7: dbg_log("d9/5/7"); trigger_ud(); break;
    }
}
void instr_D9_6_mem(int32_t addr) { task_switch_test(); fpu_fstenv(addr); }
void instr_D9_6_reg(int32_t r)
{
    task_switch_test();
    double_t st0 = fpu_get_st0();

    switch(r)
    {
        case 0:
            // f2xm1
            fpu_st[*fpu_stack_ptr] = pow(2, st0) - 1;
            break;
        case 1:
            // fyl2x
            fpu_st[*fpu_stack_ptr + 1 & 7] = fpu_get_sti(1) * log(st0) / M_LN2;
            fpu_pop();
            break;
        case 2:
            // fptan
            fpu_st[*fpu_stack_ptr] = tan(st0);
            fpu_push(1); // no bug: push constant 1
            break;
        case 3:
            // fpatan
            fpu_st[*fpu_stack_ptr + 1 & 7] = atan2(fpu_get_sti(1), st0);
            fpu_pop();
            break;
        case 4:
            fpu_fxtract();
            break;
        case 5:
            // fprem1
            fpu_st[*fpu_stack_ptr] = fmod(st0, fpu_get_sti(1));
            break;
        case 6:
            // fdecstp
            *fpu_stack_ptr = *fpu_stack_ptr - 1 & 7;
            *fpu_status_word &= ~FPU_C1;
            break;
        case 7:
            // fincstp
            *fpu_stack_ptr = *fpu_stack_ptr + 1 & 7;
            *fpu_status_word &= ~FPU_C1;
            break;
        default:
            dbg_assert(false);
    }
}
void instr_D9_7_mem(int32_t addr) { task_switch_test(); fpu_fstcw(addr); }
void instr_D9_7_reg(int32_t r)
{
    task_switch_test();
    double_t st0 = fpu_get_st0();

    switch(r)
    {
        case 0:
            fpu_fprem();
            break;
        case 1:
            // fyl2xp1: y * log2(x+1) and pop
            fpu_st[*fpu_stack_ptr + 1 & 7] = fpu_get_sti(1) * log(st0 + 1) / M_LN2;
            fpu_pop();
            break;
        case 2:
            fpu_st[*fpu_stack_ptr] = sqrt(st0);
            break;
        case 3:
            fpu_st[*fpu_stack_ptr] = sin(st0);
            fpu_push(cos(st0));
            break;
        case 4:
            // frndint
            fpu_st[*fpu_stack_ptr] = fpu_integer_round(st0);
            break;
        case 5:
            // fscale
            fpu_st[*fpu_stack_ptr] = st0 * pow(2, trunc(fpu_get_sti(1)));
            break;
        case 6:
            fpu_st[*fpu_stack_ptr] = sin(st0);
            break;
        case 7:
            fpu_st[*fpu_stack_ptr] = cos(st0);
            break;
        default:
            dbg_assert(false);
        }
}

void instr_DA_0_mem(int32_t addr) { task_switch_test(); fpu_fadd(0, safe_read32s(addr)); }
void instr_DA_1_mem(int32_t addr) { task_switch_test(); fpu_fmul(0, safe_read32s(addr)); }
void instr_DA_2_mem(int32_t addr) { task_switch_test(); fpu_fcom(safe_read32s(addr)); }
void instr_DA_3_mem(int32_t addr) { task_switch_test(); fpu_fcomp(safe_read32s(addr)); }
void instr_DA_4_mem(int32_t addr) { task_switch_test(); fpu_fsub(0, safe_read32s(addr)); }
void instr_DA_5_mem(int32_t addr) { task_switch_test(); fpu_fsubr(0, safe_read32s(addr)); }
void instr_DA_6_mem(int32_t addr) { task_switch_test(); fpu_fdiv(0, safe_read32s(addr)); }
void instr_DA_7_mem(int32_t addr) { task_switch_test(); fpu_fdivr(0, safe_read32s(addr)); }

void instr_DA_0_reg(int32_t r) { task_switch_test(); fpu_fcmovcc(test_b(), r); }
void instr_DA_1_reg(int32_t r) { task_switch_test(); fpu_fcmovcc(test_z(), r); }
void instr_DA_2_reg(int32_t r) { task_switch_test(); fpu_fcmovcc(test_be(), r); }
void instr_DA_3_reg(int32_t r) { task_switch_test(); fpu_fcmovcc(test_p(), r); }
void instr_DA_4_reg(int32_t r) { trigger_ud(); }
void instr_DA_5_reg(int32_t r) { task_switch_test(); if(r == 1) { fpu_fucompp(); } else { trigger_ud(); } }
void instr_DA_6_reg(int32_t r) { trigger_ud(); }
void instr_DA_7_reg(int32_t r) { trigger_ud(); }

void instr_DB_0_mem(int32_t addr) { task_switch_test(); fpu_fldm32(addr); }
void instr_DB_1_mem(int32_t addr) { trigger_ud(); }
void instr_DB_2_mem(int32_t addr) { task_switch_test(); fpu_fistm32(addr); }
void instr_DB_3_mem(int32_t addr) { task_switch_test(); fpu_fistm32p(addr); }
void instr_DB_4_mem(int32_t addr) { trigger_ud(); }
void instr_DB_5_mem(int32_t addr) { task_switch_test(); fpu_fldm80(addr); }
void instr_DB_6_mem(int32_t addr) { trigger_ud(); }
void instr_DB_7_mem(int32_t addr) { task_switch_test(); fpu_fst80p(addr); }

void instr_DB_0_reg(int32_t r) { task_switch_test(); fpu_fcmovcc(!test_b(), r); }
void instr_DB_1_reg(int32_t r) { task_switch_test(); fpu_fcmovcc(!test_z(), r); }
void instr_DB_2_reg(int32_t r) { task_switch_test(); fpu_fcmovcc(!test_be(), r); }
void instr_DB_3_reg(int32_t r) { task_switch_test(); fpu_fcmovcc(!test_p(), r); }
void instr_DB_4_reg(int32_t r)
{
    task_switch_test();
    if(r == 3)
    {
        fpu_finit();
    }
    else if(r == 4 || r == 1)
    {
        // fsetpm and fdisi; treated as nop
    }
    else if(r == 2)
    {
        fpu_fclex();
    }
    else
    {
        trigger_ud();
    }
}
void instr_DB_5_reg(int32_t r) { task_switch_test(); fpu_fucomi(r); }
void instr_DB_6_reg(int32_t r) { task_switch_test(); fpu_fcomi(r); }
void instr_DB_7_reg(int32_t r) { trigger_ud(); }

void instr_DC_0_mem(int32_t addr) { task_switch_test(); fpu_fadd(0, fpu_load_m64(addr)); }
void instr_DC_1_mem(int32_t addr) { task_switch_test(); fpu_fmul(0, fpu_load_m64(addr)); }
void instr_DC_2_mem(int32_t addr) { task_switch_test(); fpu_fcom(fpu_load_m64(addr)); }
void instr_DC_3_mem(int32_t addr) { task_switch_test(); fpu_fcomp(fpu_load_m64(addr)); }
void instr_DC_4_mem(int32_t addr) { task_switch_test(); fpu_fsub(0, fpu_load_m64(addr)); }
void instr_DC_5_mem(int32_t addr) { task_switch_test(); fpu_fsubr(0, fpu_load_m64(addr)); }
void instr_DC_6_mem(int32_t addr) { task_switch_test(); fpu_fdiv(0, fpu_load_m64(addr)); }
void instr_DC_7_mem(int32_t addr) { task_switch_test(); fpu_fdivr(0, fpu_load_m64(addr)); }

void instr_DC_0_reg(int32_t r) { task_switch_test(); fpu_fadd(r, fpu_get_sti(r)); }
void instr_DC_1_reg(int32_t r) { task_switch_test(); fpu_fmul(r, fpu_get_sti(r)); }
void instr_DC_2_reg(int32_t r) { task_switch_test(); fpu_fcom(fpu_get_sti(r)); }
void instr_DC_3_reg(int32_t r) { task_switch_test(); fpu_fcomp(fpu_get_sti(r)); }
void instr_DC_4_reg(int32_t r) { task_switch_test(); fpu_fsub(r, fpu_get_sti(r)); }
void instr_DC_5_reg(int32_t r) { task_switch_test(); fpu_fsubr(r, fpu_get_sti(r)); }
void instr_DC_6_reg(int32_t r) { task_switch_test(); fpu_fdiv(r, fpu_get_sti(r)); }
void instr_DC_7_reg(int32_t r) { task_switch_test(); fpu_fdivr(r, fpu_get_sti(r)); }

void instr_DD_0_mem(int32_t addr) { task_switch_test(); fpu_fldm64(addr); }
void instr_DD_1_mem(int32_t addr) { dbg_log("fisttp"); trigger_ud(); }
void instr_DD_2_mem(int32_t addr) { task_switch_test(); fpu_fstm64(addr); }
void instr_DD_3_mem(int32_t addr) { task_switch_test(); fpu_fstm64p(addr); }
void instr_DD_4_mem(int32_t addr) { task_switch_test(); fpu_frstor(addr); }
void instr_DD_5_mem(int32_t addr) { dbg_log("dd/5"); trigger_ud(); }
void instr_DD_6_mem(int32_t addr) { task_switch_test(); fpu_fsave(addr); }
void instr_DD_7_mem(int32_t addr) { task_switch_test(); fpu_fnstsw_mem(addr); }

void instr_DD_0_reg(int32_t r) { task_switch_test(); fpu_ffree(r); }
void instr_DD_1_reg(int32_t r) { trigger_ud(); }
void instr_DD_2_reg(int32_t r) { task_switch_test(); fpu_fst(r); }
void instr_DD_3_reg(int32_t r) { task_switch_test(); fpu_fstp(r); }
void instr_DD_4_reg(int32_t r) { task_switch_test(); fpu_fucom(r); }
void instr_DD_5_reg(int32_t r) { task_switch_test(); fpu_fucomp(r); }
void instr_DD_6_reg(int32_t r) { trigger_ud(); }
void instr_DD_7_reg(int32_t r) { trigger_ud(); }

void instr_DE_0_mem(int32_t addr) { task_switch_test(); fpu_fadd(0, (int16_t) safe_read16(addr)); }
void instr_DE_1_mem(int32_t addr) { task_switch_test(); fpu_fmul(0, (int16_t) safe_read16(addr)); }
void instr_DE_2_mem(int32_t addr) { task_switch_test(); fpu_fcom((int16_t) safe_read16(addr)); }
void instr_DE_3_mem(int32_t addr) { task_switch_test(); fpu_fcomp((int16_t) safe_read16(addr)); }
void instr_DE_4_mem(int32_t addr) { task_switch_test(); fpu_fsub(0, (int16_t) safe_read16(addr)); }
void instr_DE_5_mem(int32_t addr) { task_switch_test(); fpu_fsubr(0, (int16_t) safe_read16(addr)); }
void instr_DE_6_mem(int32_t addr) { task_switch_test(); fpu_fdiv(0, (int16_t) safe_read16(addr)); }
void instr_DE_7_mem(int32_t addr) { task_switch_test(); fpu_fdivr(0, (int16_t) safe_read16(addr)); }

void instr_DE_0_reg(int32_t r) { task_switch_test(); fpu_fadd(r, fpu_get_sti(r)); fpu_pop(); }
void instr_DE_1_reg(int32_t r) { task_switch_test(); fpu_fmul(r, fpu_get_sti(r)); fpu_pop(); }
void instr_DE_2_reg(int32_t r) { task_switch_test(); fpu_fcom(fpu_get_sti(r)); fpu_pop(); }
void instr_DE_3_reg(int32_t r) { task_switch_test(); fpu_fcomp(fpu_get_sti(r)); fpu_pop(); }
void instr_DE_4_reg(int32_t r) { task_switch_test(); fpu_fsub(r, fpu_get_sti(r)); fpu_pop(); }
void instr_DE_5_reg(int32_t r) { task_switch_test(); fpu_fsubr(r, fpu_get_sti(r)); fpu_pop(); }
void instr_DE_6_reg(int32_t r) { task_switch_test(); fpu_fdiv(r, fpu_get_sti(r)); fpu_pop(); }
void instr_DE_7_reg(int32_t r) { task_switch_test(); fpu_fdivr(r, fpu_get_sti(r)); fpu_pop(); }

void instr_DF_0_mem(int32_t addr) { task_switch_test(); fpu_push((int16_t) safe_read16(addr)); }
void instr_DF_1_mem(int32_t addr) { dbg_log("df/fisttp"); trigger_ud(); }
void instr_DF_2_mem(int32_t addr) { task_switch_test(); fpu_fistm16(addr); }
void instr_DF_3_mem(int32_t addr) { task_switch_test(); fpu_fistm16p(addr); }
void instr_DF_4_mem(int32_t addr) { dbg_log("fbld"); trigger_ud(); }
void instr_DF_5_mem(int32_t addr) { task_switch_test(); fpu_fildm64(addr); }
void instr_DF_6_mem(int32_t addr) { dbg_log("fbstp"); trigger_ud(); }
void instr_DF_7_mem(int32_t addr) { task_switch_test(); fpu_fistm64p(addr); }

void instr_DF_0_reg(int32_t r) { trigger_ud(); }
void instr_DF_1_reg(int32_t r) { trigger_ud(); }
void instr_DF_2_reg(int32_t r) { trigger_ud(); }
void instr_DF_3_reg(int32_t r) { trigger_ud(); }
void instr_DF_4_reg(int32_t r) { task_switch_test(); if(r == 0) { fpu_fnstsw_reg(); } else { trigger_ud(); } }
void instr_DF_5_reg(int32_t r) { task_switch_test(); fpu_fucomip(r); }
void instr_DF_6_reg(int32_t r) { task_switch_test(); fpu_fcomip(r); }
void instr_DF_7_reg(int32_t r) { trigger_ud(); }

void instr_E0(int32_t off) { loopne(off); }
void instr_E1(int32_t off) { loope(off); }
void instr_E2(int32_t off) { loop(off); }
void instr_E3(int32_t off) { jcxz(off); }

void instr_E4(int32_t port) {
    test_privileges_for_io(port, 1);
    reg8[AL] = io_port_read8(port);
}
void instr16_E5(int32_t port) {
    test_privileges_for_io(port, 2);
    reg16[AX] = io_port_read16(port);
}
void instr32_E5(int32_t port) {
    test_privileges_for_io(port, 4);
    reg32s[EAX] = io_port_read32(port);
}
void instr_E6(int32_t port) {
    test_privileges_for_io(port, 1);
    io_port_write8(port, reg8[AL]);
}
void instr16_E7(int32_t port) {
    test_privileges_for_io(port, 2);
    io_port_write16(port, reg16[AX]);
}
void instr32_E7(int32_t port) {
    test_privileges_for_io(port, 4);
    io_port_write32(port, reg32s[EAX]);
}

void instr16_E8(int32_t imm16) {
    // call
    push16(get_real_eip());

    jmp_rel16(imm16);
}
void instr32_E8(int32_t imm32s) {
    // call
    push32(get_real_eip());

    instruction_pointer[0] = instruction_pointer[0] + imm32s;
    //dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
}
void instr16_E8_jit(int32_t imm16) {
    gen_fn1_const("instr16_E8", 10, imm16);
}

void instr32_E8_jit(int32_t imm32s) {
    gen_fn1_const("instr32_E8", 10, imm32s);
}

void instr16_E9(int32_t imm16) {
    // jmp
    jmp_rel16(imm16);
}
void instr32_E9(int32_t imm32s) {
    // jmp
    instruction_pointer[0] = instruction_pointer[0] + imm32s;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
}
void instr16_E9_jit(int32_t imm16) {
    gen_fn1_const("instr16_E9", 10, imm16);
}
void instr32_E9_jit(int32_t imm32s) {
    gen_fn1_const("instr32_E9", 10, imm32s);
}

void instr16_EA(int32_t new_ip, int32_t cs) {
    // jmpf
    far_jump(new_ip, cs, false);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
}
void instr32_EA(int32_t new_ip, int32_t cs) {
    // jmpf
    far_jump(new_ip, cs, false);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
}

void instr_EB(int32_t imm8) {
    // jmp near
    instruction_pointer[0] = instruction_pointer[0] + imm8;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
}

void instr_EB_jit(int32_t imm8s) {
    gen_fn1_const("instr_EB", 8, imm8s);
}

void instr_EC() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 1);
    reg8[AL] = io_port_read8(port);
}
void instr16_ED() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 2);
    reg16[AX] = io_port_read16(port);
}
void instr32_ED() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 4);
    reg32s[EAX] = io_port_read32(port);
}
void instr_EE() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 1);
    io_port_write8(port, reg8[AL]);
}
void instr16_EF() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 2);
    io_port_write16(port, reg16[AX]);
}
void instr32_EF() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 4);
    io_port_write32(port, reg32s[EAX]);
}

void instr_F0() {
    // lock
    //dbg_log("lock");

    // TODO
    // This triggers UD when used with
    // some instructions that don't write to memory
    run_prefix_instruction();
}
jit_instr_flags instr_F0_jit() {
    // lock
    //dbg_log("lock");

    // TODO
    // This triggers UD when used with
    // some instructions that don't write to memory
    return jit_prefix_instruction();
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
jit_instr_flags instr_F2_jit() {
    // repnz
    dbg_assert((*prefixes & PREFIX_MASK_REP) == 0);
    gen_add_prefix_bits(PREFIX_REPNZ);
    *prefixes |= PREFIX_REPNZ;
    jit_instr_flags instr_flags = jit_prefix_instruction();
    gen_clear_prefixes();
    *prefixes = 0;
    return instr_flags;
}

void instr_F3() {
    // repz
    dbg_assert((*prefixes & PREFIX_MASK_REP) == 0);
    *prefixes |= PREFIX_REPZ;
    run_prefix_instruction();
    *prefixes = 0;
}

jit_instr_flags instr_F3_jit() {
    // repz
    dbg_assert((*prefixes & PREFIX_MASK_REP) == 0);
    gen_add_prefix_bits(PREFIX_REPZ);
    *prefixes |= PREFIX_REPZ;
    jit_instr_flags instr_flags = jit_prefix_instruction();
    gen_clear_prefixes();
    *prefixes = 0;
    return instr_flags;
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
    int32_t cs = get_seg_cs();
    push16(get_real_eip());
    instruction_pointer[0] = cs + data;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
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
}
void instr16_FF_4_helper(int32_t data)
{
    // jmp near
    instruction_pointer[0] = get_seg_cs() + data;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
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
}
DEFINE_MODRM_INSTR1_READ16(instr16_FF_6, push16(___))
void instr16_FF_6_jit_reg(int32_t reg) { push16_reg_jit(reg); }
void instr16_FF_6_jit_mem(int32_t modrm_byte) { push16_mem_jit(modrm_byte); }

DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_FF_0, inc32(___))
DEFINE_MODRM_INSTR1_READ_WRITE_32(instr32_FF_1, dec32(___))
void instr32_FF_2_helper(int32_t data)
{
    // call near
    int32_t cs = get_seg_cs();
    push32(get_real_eip());
    dbg_assert(is_asize_32() || data < 0x10000);
    instruction_pointer[0] = cs + data;
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
}
void instr32_FF_4_helper(int32_t data)
{
    // jmp near
    dbg_assert(is_asize_32() || data < 0x10000);
    instruction_pointer[0] = get_seg_cs() + data;
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
}
DEFINE_MODRM_INSTR1_READ32(instr32_FF_6, push32(___))
void instr32_FF_6_jit_reg(int32_t reg) { push32_reg_jit(reg); }
void instr32_FF_6_jit_mem(int32_t modrm_byte) { push32_mem_jit(modrm_byte); }

void run_instruction(int32_t opcode)
{
#include "../../build/interpreter.c"
}

jit_instr_flags jit_instruction(int32_t opcode)
{
    jit_instr_flags instr_flags = 0;
#include "../../build/jit.c"
    return instr_flags;
}

#pragma clang diagnostic pop
