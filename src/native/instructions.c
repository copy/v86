#include <stdint.h>
#include <math.h>
#include <assert.h>
#include <stdbool.h>

#include <stdio.h>

#include "const.h"
#include "global_pointers.h"

int32_t translate_address_write(int32_t);
int32_t resolve_modrm(int32_t);

/*
int32_t phys_read8(int32_t);
int32_t phys_write8(int32_t, int32_t);


#define RE8 reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]
#define E8 e8
#define G8 reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1]

#define IDX_E8 (modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1)
#define IDX_G8 (modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1)

#define READ_WRITE_E8_(f)\
{\
    int32_t modrm_byte = read_modrm_byte();\
    if(modrm_byte < 0xC0) {\
        int32_t phys_addr = translate_address_write(resolve_modrm(modrm_byte));\
        int32_t e8 = phys_read8(phys_addr);\
        phys_write8(phys_addr, f);\
    }\
    else {\
        int32_t e8 = RE8;\
        RE8 = f;\
    }\
}

#define READ_WRITE_E8(f)\
{\
    int32_t modrm_byte = read_modrm_byte();\
    if(modrm_byte < 0xC0) {\
        int32_t virt_addr = resolve_modrm(modrm_byte);\
        f ## _rm(virt_addr, IDX_G8);\
    }\
    else {\
        f ## _rr(IDX_E8, IDX_G8);\
    }\
}
*/


// XXX: Remove these declarations when they are implemented in C
int32_t read_write_e8(void);
int32_t read_write_e16(void);
int32_t read_write_e32(void);
int32_t read_g8(void);
int32_t read_g16(void);
int32_t read_g32s(void);

int32_t read_e8(void);
int32_t read_e8s(void);
int32_t read_e16(void);
int32_t read_e16s(void);
int32_t read_e32(void);
int32_t read_e32s(void);

void write_e8(int32_t);
void write_e16(int32_t);
void write_e32(int32_t);

void write_reg_e16(int32_t);
void write_reg_e32(int32_t);

void set_e8(int32_t);
void set_e16(int32_t);
void set_e32(int32_t);

void write_g8(int32_t);
void write_g16(int32_t);
void write_g32(int32_t);

int32_t read_op8(void);
int32_t read_op8s(void);
int32_t read_op16(void);
int32_t read_op32s(void);

int32_t read_disp8(void);
int32_t read_disp16(void);

int32_t read_moffs(void);

void push16(int32_t);
void push32(int32_t);

void pusha16(void);
void pusha32(void);
void popa16(void);
void popa32(void);
int32_t arpl(int32_t, int32_t);

void trigger_ud(void);
void trigger_nm(void);
static void run_prefix_instruction(void);

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

int32_t idiv16(int32_t);
int32_t div32(int32_t);
int32_t idiv32(int32_t);


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

void jmpcc8(bool);

void far_jump(int32_t, int32_t, int32_t);
void far_return(int32_t, int32_t, int32_t);

void iret16();
void iret32();

void lss16(int32_t);
void lss32(int32_t);

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
int32_t xchg16r(int32_t);
int32_t xchg32(int32_t, int32_t);
int32_t xchg32r(int32_t);

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

static void run_instruction0f_16(int32_t);
static void run_instruction0f_32(int32_t);

void clear_prefixes(void);
void cycle_internal(void);


void fwait(void);


static void instr_00() { read_modrm_byte(); write_e8(add8(read_write_e8(), read_g8())); }
static void instr16_01() { read_modrm_byte(); write_e16(add16(read_write_e16(), read_g16())); }
static void instr32_01() { read_modrm_byte(); write_e32(add32(read_write_e32(), read_g32s())); }
static void instr_02() { read_modrm_byte(); write_g8(add8(read_g8(), read_e8())); }
static void instr16_03() { read_modrm_byte(); write_g16(add16(read_g16(), read_e16())); }
static void instr32_03() { read_modrm_byte(); write_g32(add32(read_g32s(), read_e32s())); }
static void instr_04() { reg8[AL] = add8(reg8[AL], read_op8()); }
static void instr16_05() { reg16[AX] = add16(reg16[AX], read_op16()); }
static void instr32_05() { reg32s[EAX] = add32(reg32s[EAX], read_op32s()); }

static void instr16_06() { push16(sreg[ES]); }
static void instr32_06() { push32(sreg[ES]); }
static void instr16_07() {
    switch_seg(ES, safe_read16(get_stack_pointer(0)));
    adjust_stack_reg(2);
}
static void instr32_07() {
    switch_seg(ES, safe_read32s(get_stack_pointer(0)) & 0xFFFF);
    adjust_stack_reg(4);
}

static void instr_08() { read_modrm_byte(); write_e8(or8(read_write_e8(), read_g8())); }
static void instr16_09() { read_modrm_byte(); write_e16(or16(read_write_e16(), read_g16())); }
static void instr32_09() { read_modrm_byte(); write_e32(or32(read_write_e32(), read_g32s())); }
static void instr_0A() { read_modrm_byte(); write_g8(or8(read_g8(), read_e8())); }
static void instr16_0B() { read_modrm_byte(); write_g16(or16(read_g16(), read_e16())); }
static void instr32_0B() { read_modrm_byte(); write_g32(or32(read_g32s(), read_e32s())); }
static void instr_0C() { reg8[AL] = or8(reg8[AL], read_op8()); }
static void instr16_0D() { reg16[AX] = or16(reg16[AX], read_op16()); }
static void instr32_0D() { reg32s[EAX] = or32(reg32s[EAX], read_op32s()); }


static void instr16_0E() { push16(sreg[CS]); }
static void instr32_0E() { push32(sreg[CS]); }
static void instr16_0F() {
    run_instruction0f_16(read_imm8());
}
static void instr32_0F() {
    run_instruction0f_32(read_imm8());
}

static void instr_10() { read_modrm_byte(); write_e8(adc8(read_write_e8(), read_g8())); }
static void instr16_11() { read_modrm_byte(); write_e16(adc16(read_write_e16(), read_g16())); }
static void instr32_11() { read_modrm_byte(); write_e32(adc32(read_write_e32(), read_g32s())); }
static void instr_12() { read_modrm_byte(); write_g8(adc8(read_g8(), read_e8())); }
static void instr16_13() { read_modrm_byte(); write_g16(adc16(read_g16(), read_e16())); }
static void instr32_13() { read_modrm_byte(); write_g32(adc32(read_g32s(), read_e32s())); }
static void instr_14() { reg8[AL] = adc8(reg8[AL], read_op8()); }
static void instr16_15() { reg16[AX] = adc16(reg16[AX], read_op16()); }
static void instr32_15() { reg32s[EAX] = adc32(reg32s[EAX], read_op32s()); }

static void instr16_16() { push16(sreg[SS]); }
static void instr32_16() { push32(sreg[SS]); }
static void instr16_17() {
    switch_seg(SS, safe_read16(get_stack_pointer(0)));
    adjust_stack_reg(2);
    clear_prefixes();
    cycle_internal();
}
static void instr32_17() {
    switch_seg(SS, safe_read32s(get_stack_pointer(0)) & 0xFFFF);
    adjust_stack_reg(4);
    clear_prefixes();
    cycle_internal();
}

static void instr_18() { read_modrm_byte(); write_e8(sbb8(read_write_e8(), read_g8())); }
static void instr16_19() { read_modrm_byte(); write_e16(sbb16(read_write_e16(), read_g16())); }
static void instr32_19() { read_modrm_byte(); write_e32(sbb32(read_write_e32(), read_g32s())); }
static void instr_1A() { read_modrm_byte(); write_g8(sbb8(read_g8(), read_e8())); }
static void instr16_1B() { read_modrm_byte(); write_g16(sbb16(read_g16(), read_e16())); }
static void instr32_1B() { read_modrm_byte(); write_g32(sbb32(read_g32s(), read_e32s())); }
static void instr_1C() { reg8[AL] = sbb8(reg8[AL], read_op8()); }
static void instr16_1D() { reg16[AX] = sbb16(reg16[AX], read_op16()); }
static void instr32_1D() { reg32s[EAX] = sbb32(reg32s[EAX], read_op32s()); }


static void instr16_1E() { push16(sreg[DS]); }
static void instr32_1E() { push32(sreg[DS]); }
static void instr16_1F() {
    switch_seg(DS, safe_read16(get_stack_pointer(0)));
    adjust_stack_reg(2);
}
static void instr32_1F() {
    switch_seg(DS, safe_read32s(get_stack_pointer(0)) & 0xFFFF);
    adjust_stack_reg(4);
}

static void instr_20() { read_modrm_byte(); write_e8(and8(read_write_e8(), read_g8())); }
static void instr16_21() { read_modrm_byte(); write_e16(and16(read_write_e16(), read_g16())); }
static void instr32_21() { read_modrm_byte(); write_e32(and32(read_write_e32(), read_g32s())); }
static void instr_22() { read_modrm_byte(); write_g8(and8(read_g8(), read_e8())); }
static void instr16_23() { read_modrm_byte(); write_g16(and16(read_g16(), read_e16())); }
static void instr32_23() { read_modrm_byte(); write_g32(and32(read_g32s(), read_e32s())); }
static void instr_24() { reg8[AL] = and8(reg8[AL], read_op8()); }
static void instr16_25() { reg16[AX] = and16(reg16[AX], read_op16()); }
static void instr32_25() { reg32s[EAX] = and32(reg32s[EAX], read_op32s()); }


static void instr_26() { segment_prefix_op(ES); }
static void instr_27() { bcd_daa(); }

static void instr_28() { read_modrm_byte(); write_e8(sub8(read_write_e8(), read_g8())); }
static void instr16_29() { read_modrm_byte(); write_e16(sub16(read_write_e16(), read_g16())); }
static void instr32_29() { read_modrm_byte(); write_e32(sub32(read_write_e32(), read_g32s())); }
static void instr_2A() { read_modrm_byte(); write_g8(sub8(read_g8(), read_e8())); }
static void instr16_2B() { read_modrm_byte(); write_g16(sub16(read_g16(), read_e16())); }
static void instr32_2B() { read_modrm_byte(); write_g32(sub32(read_g32s(), read_e32s())); }
static void instr_2C() { reg8[AL] = sub8(reg8[AL], read_op8()); }
static void instr16_2D() { reg16[AX] = sub16(reg16[AX], read_op16()); }
static void instr32_2D() { reg32s[EAX] = sub32(reg32s[EAX], read_op32s()); }

static void instr_2E() { segment_prefix_op(CS); }
static void instr_2F() { bcd_das(); }

static void instr_30() { read_modrm_byte(); write_e8(xor8(read_write_e8(), read_g8())); }
static void instr16_31() { read_modrm_byte(); write_e16(xor16(read_write_e16(), read_g16())); }
static void instr32_31() { read_modrm_byte(); write_e32(xor32(read_write_e32(), read_g32s())); }
static void instr_32() { read_modrm_byte(); write_g8(xor8(read_g8(), read_e8())); }
static void instr16_33() { read_modrm_byte(); write_g16(xor16(read_g16(), read_e16())); }
static void instr32_33() { read_modrm_byte(); write_g32(xor32(read_g32s(), read_e32s())); }
static void instr_34() { reg8[AL] = xor8(reg8[AL], read_op8()); }
static void instr16_35() { reg16[AX] = xor16(reg16[AX], read_op16()); }
static void instr32_35() { reg32s[EAX] = xor32(reg32s[EAX], read_op32s()); }

static void instr_36() { segment_prefix_op(SS); }
static void instr_37() { bcd_aaa(); }

static void instr_38() { read_modrm_byte(); cmp8(read_e8(), read_g8()); }
static void instr16_39() { read_modrm_byte(); cmp16(read_e16(), read_g16()); }
static void instr32_39() { read_modrm_byte(); cmp32(read_e32s(), read_g32s()); }
static void instr_3A() { read_modrm_byte(); cmp8(read_g8(), read_e8()); }
static void instr16_3B() { read_modrm_byte(); cmp16(read_g16(), read_e16()); }
static void instr32_3B() { read_modrm_byte(); cmp32(read_g32s(), read_e32s()); }
static void instr_3C() { cmp8(reg8[AL], read_op8()); }
static void instr16_3D() { cmp16(reg16[AX], read_op16()); }
static void instr32_3D() { cmp32(reg32s[EAX], read_op32s()); }

static void instr_3E() { segment_prefix_op(DS); }
static void instr_3F() { bcd_aas(); }


static void instr16_40() { reg16[AX] = inc16(reg16[AX]); }
static void instr32_40() { reg32s[EAX] = inc32(reg32s[EAX]); }
static void instr16_41() { reg16[CX] = inc16(reg16[CX]); }
static void instr32_41() { reg32s[ECX] = inc32(reg32s[ECX]); }
static void instr16_42() { reg16[DX] = inc16(reg16[DX]); }
static void instr32_42() { reg32s[EDX] = inc32(reg32s[EDX]); }
static void instr16_43() { reg16[BX] = inc16(reg16[BX]); }
static void instr32_43() { reg32s[EBX] = inc32(reg32s[EBX]); }
static void instr16_44() { reg16[SP] = inc16(reg16[SP]); }
static void instr32_44() { reg32s[ESP] = inc32(reg32s[ESP]); }
static void instr16_45() { reg16[BP] = inc16(reg16[BP]); }
static void instr32_45() { reg32s[EBP] = inc32(reg32s[EBP]); }
static void instr16_46() { reg16[SI] = inc16(reg16[SI]); }
static void instr32_46() { reg32s[ESI] = inc32(reg32s[ESI]); }
static void instr16_47() { reg16[DI] = inc16(reg16[DI]); }
static void instr32_47() { reg32s[EDI] = inc32(reg32s[EDI]); }


static void instr16_48() { reg16[AX] = dec16(reg16[AX]); }
static void instr32_48() { reg32s[EAX] = dec32(reg32s[EAX]); }
static void instr16_49() { reg16[CX] = dec16(reg16[CX]); }
static void instr32_49() { reg32s[ECX] = dec32(reg32s[ECX]); }
static void instr16_4A() { reg16[DX] = dec16(reg16[DX]); }
static void instr32_4A() { reg32s[EDX] = dec32(reg32s[EDX]); }
static void instr16_4B() { reg16[BX] = dec16(reg16[BX]); }
static void instr32_4B() { reg32s[EBX] = dec32(reg32s[EBX]); }
static void instr16_4C() { reg16[SP] = dec16(reg16[SP]); }
static void instr32_4C() { reg32s[ESP] = dec32(reg32s[ESP]); }
static void instr16_4D() { reg16[BP] = dec16(reg16[BP]); }
static void instr32_4D() { reg32s[EBP] = dec32(reg32s[EBP]); }
static void instr16_4E() { reg16[SI] = dec16(reg16[SI]); }
static void instr32_4E() { reg32s[ESI] = dec32(reg32s[ESI]); }
static void instr16_4F() { reg16[DI] = dec16(reg16[DI]); }
static void instr32_4F() { reg32s[EDI] = dec32(reg32s[EDI]); }


static void instr16_50() { push16(reg16[AX]); }
static void instr32_50() { push32(reg32s[EAX]); }
static void instr16_51() { push16(reg16[CX]); }
static void instr32_51() { push32(reg32s[ECX]); }
static void instr16_52() { push16(reg16[DX]); }
static void instr32_52() { push32(reg32s[EDX]); }
static void instr16_53() { push16(reg16[BX]); }
static void instr32_53() { push32(reg32s[EBX]); }
static void instr16_54() { push16(reg16[SP]); }
static void instr32_54() { push32(reg32s[ESP]); }
static void instr16_55() { push16(reg16[BP]); }
static void instr32_55() { push32(reg32s[EBP]); }
static void instr16_56() { push16(reg16[SI]); }
static void instr32_56() { push32(reg32s[ESI]); }
static void instr16_57() { push16(reg16[DI]); }
static void instr32_57() { push32(reg32s[EDI]); }

static void instr16_58() { reg16[AX] = pop16(); }
static void instr32_58() { reg32s[EAX] = pop32s(); }
static void instr16_59() { reg16[CX] = pop16(); }
static void instr32_59() { reg32s[ECX] = pop32s(); }
static void instr16_5A() { reg16[DX] = pop16(); }
static void instr32_5A() { reg32s[EDX] = pop32s(); }
static void instr16_5B() { reg16[BX] = pop16(); }
static void instr32_5B() { reg32s[EBX] = pop32s(); }
static void instr16_5C() { reg16[SP] = pop16(); }
static void instr32_5C() { reg32s[ESP] = pop32s(); }
static void instr16_5D() { reg16[BP] = pop16(); }
static void instr32_5D() { reg32s[EBP] = pop32s(); }
static void instr16_5E() { reg16[SI] = pop16(); }
static void instr32_5E() { reg32s[ESI] = pop32s(); }
static void instr16_5F() { reg16[DI] = pop16(); }
static void instr32_5F() { reg32s[EDI] = pop32s(); }


static void instr16_60() { pusha16(); }
static void instr32_60() { pusha32(); }
static void instr16_61() { popa16(); }
static void instr32_61() { popa32(); }

static void instr_62() {
    // bound
    dbg_log("Unimplemented BOUND instruction");
    dbg_assert(false);
}
static void instr_63() { read_modrm_byte();
    // arpl
    //dbg_log("arpl");
    if(*protected_mode && !vm86_mode())
    {
        write_e16(arpl(read_write_e16(), modrm_byte[0] >> 2 & 14));
    }
    else
    {
        dbg_log("arpl #ud");
        trigger_ud();
    }
}

static void instr_64() { segment_prefix_op(FS); }
static void instr_65() { segment_prefix_op(GS); }

static void instr_66() {
    // Operand-size override prefix
    *prefixes |= PREFIX_MASK_OPSIZE;
    run_prefix_instruction();
    *prefixes = 0;
}

static void instr_67() {
    // Address-size override prefix
    dbg_assert(is_asize_32() == *is_32);

    *prefixes |= PREFIX_MASK_ADDRSIZE;
    run_prefix_instruction();
    *prefixes = 0;
}

static void instr16_68() { push16(read_op16()); }
static void instr32_68() { push32(read_op32s()); }

static void instr16_69() { read_modrm_byte();
    write_g16(imul_reg16(read_e16s(), read_op16() << 16 >> 16));
}
static void instr32_69() { read_modrm_byte();
    write_g32(imul_reg32(read_e32s(), read_op32s()));
}

static void instr16_6A() { push16(read_op8s()); }
static void instr32_6A() { push32(read_op8s()); }

static void instr16_6B() { read_modrm_byte();
    write_g16(imul_reg16(read_e16s(), read_op8s()));
}
static void instr32_6B() { read_modrm_byte();
    write_g32(imul_reg32(read_e32s(), read_op8s()));
}

static void instr_6C() { insb(); }
static void instr16_6D() { insw(); }
static void instr32_6D() { insd(); }
static void instr_6E() { outsb(); }
static void instr16_6F() { outsw(); }
static void instr32_6F() { outsd(); }

static void instr_70() { jmpcc8( test_o()); }
static void instr_71() { jmpcc8(!test_o()); }
static void instr_72() { jmpcc8( test_b()); }
static void instr_73() { jmpcc8(!test_b()); }
static void instr_74() { jmpcc8( test_z()); }
static void instr_75() { jmpcc8(!test_z()); }
static void instr_76() { jmpcc8( test_be()); }
static void instr_77() { jmpcc8(!test_be()); }
static void instr_78() { jmpcc8( test_s()); }
static void instr_79() { jmpcc8(!test_s()); }
static void instr_7A() { jmpcc8( test_p()); }
static void instr_7B() { jmpcc8(!test_p()); }
static void instr_7C() { jmpcc8( test_l()); }
static void instr_7D() { jmpcc8(!test_l()); }
static void instr_7E() { jmpcc8( test_le()); }
static void instr_7F() { jmpcc8(!test_le()); }

static void instr_80_0() { write_e8(add8(read_write_e8(), read_op8())); }
static void instr_80_1() { write_e8( or8(read_write_e8(), read_op8())); }
static void instr_80_2() { write_e8(adc8(read_write_e8(), read_op8())); }
static void instr_80_3() { write_e8(sbb8(read_write_e8(), read_op8())); }
static void instr_80_4() { write_e8(and8(read_write_e8(), read_op8())); }
static void instr_80_5() { write_e8(sub8(read_write_e8(), read_op8())); }
static void instr_80_6() { write_e8(xor8(read_write_e8(), read_op8())); }
static void instr_80_7() { cmp8(read_e8(), read_op8()); }

static void instr16_81_0() { write_e16(add16(read_write_e16(), read_op16())); }
static void instr16_81_1() { write_e16( or16(read_write_e16(), read_op16())); }
static void instr16_81_2() { write_e16(adc16(read_write_e16(), read_op16())); }
static void instr16_81_3() { write_e16(sbb16(read_write_e16(), read_op16())); }
static void instr16_81_4() { write_e16(and16(read_write_e16(), read_op16())); }
static void instr16_81_5() { write_e16(sub16(read_write_e16(), read_op16())); }
static void instr16_81_6() { write_e16(xor16(read_write_e16(), read_op16())); }
static void instr16_81_7() { cmp16(read_e16(), read_op16()); }

static void instr32_81_0() { write_e32(add32(read_write_e32(), read_op32s())); }
static void instr32_81_1() { write_e32( or32(read_write_e32(), read_op32s())); }
static void instr32_81_2() { write_e32(adc32(read_write_e32(), read_op32s())); }
static void instr32_81_3() { write_e32(sbb32(read_write_e32(), read_op32s())); }
static void instr32_81_4() { write_e32(and32(read_write_e32(), read_op32s())); }
static void instr32_81_5() { write_e32(sub32(read_write_e32(), read_op32s())); }
static void instr32_81_6() { write_e32(xor32(read_write_e32(), read_op32s())); }
static void instr32_81_7() { cmp32(read_e32s(), read_op32s()); }

static void instr_82_0() { write_e8(add8(read_write_e8(), read_op8())); }
static void instr_82_1() { write_e8( or8(read_write_e8(), read_op8())); }
static void instr_82_2() { write_e8(adc8(read_write_e8(), read_op8())); }
static void instr_82_3() { write_e8(sbb8(read_write_e8(), read_op8())); }
static void instr_82_4() { write_e8(and8(read_write_e8(), read_op8())); }
static void instr_82_5() { write_e8(sub8(read_write_e8(), read_op8())); }
static void instr_82_6() { write_e8(xor8(read_write_e8(), read_op8())); }
static void instr_82_7() { cmp8(read_e8(), read_op8()); }

static void instr16_83_0() { write_e16(add16(read_write_e16(), read_op8s())); }
static void instr16_83_1() { write_e16( or16(read_write_e16(), read_op8s())); }
static void instr16_83_2() { write_e16(adc16(read_write_e16(), read_op8s())); }
static void instr16_83_3() { write_e16(sbb16(read_write_e16(), read_op8s())); }
static void instr16_83_4() { write_e16(and16(read_write_e16(), read_op8s())); }
static void instr16_83_5() { write_e16(sub16(read_write_e16(), read_op8s())); }
static void instr16_83_6() { write_e16(xor16(read_write_e16(), read_op8s())); }
static void instr16_83_7() { cmp16(read_e16s(), read_op8s()); }

static void instr32_83_0() { write_e32(add32(read_write_e32(), read_op8s())); }
static void instr32_83_1() { write_e32( or32(read_write_e32(), read_op8s())); }
static void instr32_83_2() { write_e32(adc32(read_write_e32(), read_op8s())); }
static void instr32_83_3() { write_e32(sbb32(read_write_e32(), read_op8s())); }
static void instr32_83_4() { write_e32(and32(read_write_e32(), read_op8s())); }
static void instr32_83_5() { write_e32(sub32(read_write_e32(), read_op8s())); }
static void instr32_83_6() { write_e32(xor32(read_write_e32(), read_op8s())); }
static void instr32_83_7() { cmp32(read_e32s(), read_op8s()); }

static void instr_84() { read_modrm_byte(); int32_t data = read_e8(); test8(data, read_g8()); }
static void instr16_85() { read_modrm_byte(); int32_t data = read_e16(); test16(data, read_g16()); }
static void instr32_85() { read_modrm_byte(); int32_t data = read_e32s(); test32(data, read_g32s()); }


static void instr_86() { read_modrm_byte(); int32_t data = read_write_e8(); write_e8(xchg8(data, modrm_byte[0])); }
static void instr16_87() { read_modrm_byte();
    int32_t data = read_write_e16(); write_e16(xchg16(data, modrm_byte[0]));
}
static void instr32_87() { read_modrm_byte();
    int32_t data = read_write_e32(); write_e32(xchg32(data, modrm_byte[0]));
}

static void instr_88() { read_modrm_byte(); set_e8(read_g8()); }
static void instr16_89() { read_modrm_byte(); set_e16(read_g16()); }
static void instr32_89() { read_modrm_byte(); set_e32(read_g32s()); }

static void instr_8A() { read_modrm_byte();
    int32_t data = read_e8();
    write_g8(data);
}
static void instr16_8B() { read_modrm_byte();
    int32_t data = read_e16();
    write_g16(data);
}
static void instr32_8B() { read_modrm_byte();
    int32_t data = read_e32s();
    write_g32(data);
}

static void instr16_8C() { read_modrm_byte();
    set_e16(sreg[modrm_byte[0] >> 3 & 7]);
}
static void instr32_8C() { read_modrm_byte();
    set_e32(sreg[modrm_byte[0] >> 3 & 7]);
}

static void instr16_8D() { read_modrm_byte();
    // lea
    if(modrm_byte[0] >= 0xC0)
    {
        dbg_log("lea #ud");
        trigger_ud();
    }
    int32_t mod = modrm_byte[0] >> 3 & 7;

    // override prefix, so modrm_resolve does not return the segment part
    *prefixes |= SEG_PREFIX_ZERO;
    reg16[mod << 1] = modrm_resolve(modrm_byte[0]);
    *prefixes = 0;
}
static void instr32_8D() { read_modrm_byte();
    if(modrm_byte[0] >= 0xC0)
    {
        dbg_log("lea #ud");
        trigger_ud();
    }
    int32_t mod = modrm_byte[0] >> 3 & 7;

    *prefixes |= SEG_PREFIX_ZERO;
    reg32s[mod] = modrm_resolve(modrm_byte[0]);
    *prefixes = 0;
}

static void instr_8E() { read_modrm_byte();
    int32_t mod = modrm_byte[0] >> 3 & 7;
    int32_t data = read_e16();
    switch_seg(mod, data);

    if(mod == SS)
    {
        // run next instruction, so no interrupts are handled
        clear_prefixes();
        cycle_internal();
    }
}

static void instr16_8F() { read_modrm_byte();
    // pop
    int32_t sp = safe_read16(get_stack_pointer(0));

    adjust_stack_reg(2);

    if(modrm_byte[0] < 0xC0) {
        int32_t addr = modrm_resolve(modrm_byte[0]);
        adjust_stack_reg(-2);
        safe_write16(addr, sp);
        adjust_stack_reg(2);
    } else {
        write_reg_e16(sp);
    }
}
static void instr32_8F() { read_modrm_byte();
    int32_t sp = safe_read32s(get_stack_pointer(0));

    // change esp first, then resolve modrm address
    adjust_stack_reg(4);

    if(modrm_byte[0] < 0xC0) {
        int32_t addr = modrm_resolve(modrm_byte[0]);

        // Before attempting a write that might cause a page fault,
        // we must set esp to the old value. Fuck Intel.
        adjust_stack_reg(-4);
        safe_write32(addr, sp);
        adjust_stack_reg(4);
    } else {
        write_reg_e32(sp);
    }
}

static void instr_90() { }
static void instr16_91() { xchg16r(CX); }
static void instr32_91() { xchg32r(ECX); }
static void instr16_92() { xchg16r(DX); }
static void instr32_92() { xchg32r(EDX); }
static void instr16_93() { xchg16r(BX); }
static void instr32_93() { xchg32r(EBX); }
static void instr16_94() { xchg16r(SP); }
static void instr32_94() { xchg32r(ESP); }
static void instr16_95() { xchg16r(BP); }
static void instr32_95() { xchg32r(EBP); }
static void instr16_96() { xchg16r(SI); }
static void instr32_96() { xchg32r(ESI); }
static void instr16_97() { xchg16r(DI); }
static void instr32_97() { xchg32r(EDI); }

static void instr16_98() { /* cbw */ reg16[AX] = reg8s[AL]; }
static void instr32_98() { /* cwde */ reg32s[EAX] = reg16s[AX]; }
static void instr16_99() { /* cwd */ reg16[DX] = reg16s[AX] >> 15; }
static void instr32_99() { /* cdq */ reg32s[EDX] = reg32s[EAX] >> 31; }

static void instr16_9A() {
    // callf
    int32_t new_ip = read_op16();
    int32_t new_cs = read_disp16();

    far_jump(new_ip, new_cs, true);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
static void instr32_9A() {
    int32_t new_ip = read_op32s();
    int32_t new_cs = read_disp16();

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

static void instr_9B() {
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
static void instr16_9C() {
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
static void instr32_9C() {
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
static void instr16_9D() {
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
static void instr32_9D() {
    // popf
    if((flags[0] & FLAG_VM) && getiopl() < 3)
    {
        dbg_log("popf #gp");
        trigger_gp(0);
    }

    update_eflags(pop32s());
    handle_irqs();
}
static void instr_9E() {
    // sahf
    flags[0] = (flags[0] & ~0xFF) | reg8[AH];
    flags[0] = (flags[0] & FLAGS_MASK) | FLAGS_DEFAULT;
    flags_changed[0] = 0;
}
static void instr_9F() {
    // lahf
    reg8[AH] = get_eflags();
}

static void instr_A0() {
    // mov
    int32_t data = safe_read8(read_moffs());
    reg8[AL] = data;
}
static void instr16_A1() {
    // mov
    int32_t data = safe_read16(read_moffs());
    reg16[AX] = data;
}
static void instr32_A1() {
    int32_t data = safe_read32s(read_moffs());
    reg32s[EAX] = data;
}
static void instr_A2() {
    // mov
    safe_write8(read_moffs(), reg8[AL]);
}
static void instr16_A3() {
    // mov
    safe_write16(read_moffs(), reg16[AX]);
}
static void instr32_A3() {
    safe_write32(read_moffs(), reg32s[EAX]);
}

static void instr_A4() { movsb(); }
static void instr16_A5() { movsw(); }
static void instr32_A5() { movsd(); }
static void instr_A6() { cmpsb(); }
static void instr16_A7() { cmpsw(); }
static void instr32_A7() { cmpsd(); }

static void instr_A8() {
    test8(reg8[AL], read_op8());
}
static void instr16_A9() {
    test16(reg16[AX], read_op16());
}
static void instr32_A9() {
    test32(reg32s[EAX], read_op32s());
}

static void instr_AA() { stosb(); }
static void instr16_AB() { stosw(); }
static void instr32_AB() { stosd(); }
static void instr_AC() { lodsb(); }
static void instr16_AD() { lodsw(); }
static void instr32_AD() { lodsd(); }
static void instr_AE() { scasb(); }
static void instr16_AF() { scasw(); }
static void instr32_AF() { scasd(); }


static void instr_B0() { reg8[AL] = read_op8(); }
static void instr_B1() { reg8[CL] = read_op8(); }
static void instr_B2() { reg8[DL] = read_op8(); }
static void instr_B3() { reg8[BL] = read_op8(); }
static void instr_B4() { reg8[AH] = read_op8(); }
static void instr_B5() { reg8[CH] = read_op8(); }
static void instr_B6() { reg8[DH] = read_op8(); }
static void instr_B7() { reg8[BH] = read_op8(); }

static void instr16_B8() { reg16[AX] = read_op16(); }
static void instr32_B8() { reg32s[EAX] = read_op32s(); }
static void instr16_B9() { reg16[CX] = read_op16(); }
static void instr32_B9() { reg32s[ECX] = read_op32s(); }
static void instr16_BA() { reg16[DX] = read_op16(); }
static void instr32_BA() { reg32s[EDX] = read_op32s(); }
static void instr16_BB() { reg16[BX] = read_op16(); }
static void instr32_BB() { reg32s[EBX] = read_op32s(); }
static void instr16_BC() { reg16[SP] = read_op16(); }
static void instr32_BC() { reg32s[ESP] = read_op32s(); }
static void instr16_BD() { reg16[BP] = read_op16(); }
static void instr32_BD() { reg32s[EBP] = read_op32s(); }
static void instr16_BE() { reg16[SI] = read_op16(); }
static void instr32_BE() { reg32s[ESI] = read_op32s(); }
static void instr16_BF() { reg16[DI] = read_op16(); }
static void instr32_BF() { reg32s[EDI] = read_op32s(); }


static void instr_C0_0() { write_e8(rol8(read_write_e8(), read_op8() & 31)); }
static void instr_C0_1() { write_e8(ror8(read_write_e8(), read_op8() & 31)); }
static void instr_C0_2() { write_e8(rcl8(read_write_e8(), read_op8() & 31)); }
static void instr_C0_3() { write_e8(rcr8(read_write_e8(), read_op8() & 31)); }
static void instr_C0_4() { write_e8(shl8(read_write_e8(), read_op8() & 31)); }
static void instr_C0_5() { write_e8(shr8(read_write_e8(), read_op8() & 31)); }
static void instr_C0_6() { write_e8(shl8(read_write_e8(), read_op8() & 31)); }
static void instr_C0_7() { write_e8(sar8(read_write_e8(), read_op8() & 31)); }

static void instr16_C1_0() { write_e16(rol16(read_write_e16(), read_op8() & 31)); }
static void instr16_C1_1() { write_e16(ror16(read_write_e16(), read_op8() & 31)); }
static void instr16_C1_2() { write_e16(rcl16(read_write_e16(), read_op8() & 31)); }
static void instr16_C1_3() { write_e16(rcr16(read_write_e16(), read_op8() & 31)); }
static void instr16_C1_4() { write_e16(shl16(read_write_e16(), read_op8() & 31)); }
static void instr16_C1_5() { write_e16(shr16(read_write_e16(), read_op8() & 31)); }
static void instr16_C1_6() { write_e16(shl16(read_write_e16(), read_op8() & 31)); }
static void instr16_C1_7() { write_e16(sar16(read_write_e16(), read_op8() & 31)); }

static void instr32_C1_0() { write_e32(rol32(read_write_e32(), read_op8() & 31)); }
static void instr32_C1_1() { write_e32(ror32(read_write_e32(), read_op8() & 31)); }
static void instr32_C1_2() { write_e32(rcl32(read_write_e32(), read_op8() & 31)); }
static void instr32_C1_3() { write_e32(rcr32(read_write_e32(), read_op8() & 31)); }
static void instr32_C1_4() { write_e32(shl32(read_write_e32(), read_op8() & 31)); }
static void instr32_C1_5() { write_e32(shr32(read_write_e32(), read_op8() & 31)); }
static void instr32_C1_6() { write_e32(shl32(read_write_e32(), read_op8() & 31)); }
static void instr32_C1_7() { write_e32(sar32(read_write_e32(), read_op8() & 31)); }

static void instr16_C2() {
    // retn
    int32_t imm16 = read_op16();

    instruction_pointer[0] = get_seg(CS) + pop16();
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    adjust_stack_reg(imm16);
    diverged();
}
static void instr32_C2() {
    // retn
    int32_t imm16 = read_op16();
    int32_t ip = pop32s();

    dbg_assert(is_asize_32() || ip < 0x10000);
    instruction_pointer[0] = get_seg(CS) + ip;
    adjust_stack_reg(imm16);
    diverged();
}
static void instr16_C3() {
    // retn
    instruction_pointer[0] = get_seg(CS) + pop16();
    diverged();
}
static void instr32_C3() {
    // retn
    int32_t ip = pop32s();
    dbg_assert(is_asize_32() || ip < 0x10000);
    instruction_pointer[0] = get_seg(CS) + ip;
    diverged();
}

static void instr16_C4() { read_modrm_byte();
    lss16(ES);
}
static void instr32_C4() { read_modrm_byte();
    lss32(ES);
}
static void instr16_C5() { read_modrm_byte();
    lss16(DS);
}
static void instr32_C5() { read_modrm_byte();
    lss32(DS);
}

static void instr_C6() { read_modrm_byte();
    if(modrm_byte[0] < 0xC0) {
        safe_write8(modrm_resolve(modrm_byte[0]), read_op8());
    } else {
        reg8[modrm_byte[0] << 2 & 0xC | modrm_byte[0] >> 2 & 1] = read_op8();
    }
}
static void instr16_C7() { read_modrm_byte();
    if(modrm_byte[0] < 0xC0) {
        safe_write16(modrm_resolve(modrm_byte[0]), read_op16());
    } else {
        reg16[modrm_byte[0] << 1 & 14] = read_op16();
    }
}
static void instr32_C7() { read_modrm_byte();
    if(modrm_byte[0] < 0xC0) {
        safe_write32(modrm_resolve(modrm_byte[0]), read_op32s());
    } else {
        reg32s[modrm_byte[0] & 7] = read_op32s();
    }
}

static void instr16_C8() { enter16(read_op16(), read_disp8()); }
static void instr32_C8() { enter32(read_op16(), read_disp8()); }
static void instr16_C9() {
    // leave
    int32_t old_vbp = *stack_size_32 ? reg32s[EBP] : reg16[BP];
    int32_t new_bp = safe_read16(get_seg(SS) + old_vbp);
    set_stack_reg(old_vbp + 2);
    reg16[BP] = new_bp;
}
static void instr32_C9() {
    int32_t old_vbp = *stack_size_32 ? reg32s[EBP] : reg16[BP];
    int32_t new_ebp = safe_read32s(get_seg(SS) + old_vbp);
    set_stack_reg(old_vbp + 4);
    reg32s[EBP] = new_ebp;
}
static void instr16_CA() {
    // retf
    int32_t imm16 = read_op16();
    int32_t ip = safe_read16(get_stack_pointer(0));
    int32_t cs = safe_read16(get_stack_pointer(2));

    far_return(ip, cs, imm16);
    diverged();
}
static void instr32_CA() {
    // retf
    int32_t imm16 = read_op16();
    int32_t ip = safe_read32s(get_stack_pointer(0));
    int32_t cs = safe_read32s(get_stack_pointer(4)) & 0xFFFF;

    far_return(ip, cs, imm16);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
static void instr16_CB() {
    // retf
    int32_t ip = safe_read16(get_stack_pointer(0));
    int32_t cs = safe_read16(get_stack_pointer(2));

    far_return(ip, cs, 0);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
static void instr32_CB() {
    // retf
    int32_t ip = safe_read32s(get_stack_pointer(0));
    int32_t cs = safe_read32s(get_stack_pointer(4)) & 0xFFFF;

    far_return(ip, cs, 0);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}

static void instr_CC() {
    // INT3
    // TODO: inhibit iopl checks
    dbg_log("INT3");
    call_interrupt_vector(3, true, false, 0);
    diverged();
}
static void instr_CD() {
    // INT
    int32_t imm8 = read_op8();
    call_interrupt_vector(imm8, true, false, 0);
    diverged();
}
static void instr_CE() {
    // INTO
    dbg_log("INTO");
    if(getof())
    {
        // TODO: inhibit iopl checks
        call_interrupt_vector(4, true, false, 0);
    }
    diverged();
}

static void instr16_CF() {
    // iret
    iret16();
    diverged();
}
static void instr32_CF() {
    iret32();
    diverged();
}


static void instr_D0_0() { write_e8(rol8(read_write_e8(), 1)); }
static void instr_D0_1() { write_e8(ror8(read_write_e8(), 1)); }
static void instr_D0_2() { write_e8(rcl8(read_write_e8(), 1)); }
static void instr_D0_3() { write_e8(rcr8(read_write_e8(), 1)); }
static void instr_D0_4() { write_e8(shl8(read_write_e8(), 1)); }
static void instr_D0_5() { write_e8(shr8(read_write_e8(), 1)); }
static void instr_D0_6() { write_e8(shl8(read_write_e8(), 1)); }
static void instr_D0_7() { write_e8(sar8(read_write_e8(), 1)); }

static void instr16_D1_0() { write_e16(rol16(read_write_e16(), 1)); }
static void instr16_D1_1() { write_e16(ror16(read_write_e16(), 1)); }
static void instr16_D1_2() { write_e16(rcl16(read_write_e16(), 1)); }
static void instr16_D1_3() { write_e16(rcr16(read_write_e16(), 1)); }
static void instr16_D1_4() { write_e16(shl16(read_write_e16(), 1)); }
static void instr16_D1_5() { write_e16(shr16(read_write_e16(), 1)); }
static void instr16_D1_6() { write_e16(shl16(read_write_e16(), 1)); }
static void instr16_D1_7() { write_e16(sar16(read_write_e16(), 1)); }

static void instr32_D1_0() { write_e32(rol32(read_write_e32(), 1)); }
static void instr32_D1_1() { write_e32(ror32(read_write_e32(), 1)); }
static void instr32_D1_2() { write_e32(rcl32(read_write_e32(), 1)); }
static void instr32_D1_3() { write_e32(rcr32(read_write_e32(), 1)); }
static void instr32_D1_4() { write_e32(shl32(read_write_e32(), 1)); }
static void instr32_D1_5() { write_e32(shr32(read_write_e32(), 1)); }
static void instr32_D1_6() { write_e32(shl32(read_write_e32(), 1)); }
static void instr32_D1_7() { write_e32(sar32(read_write_e32(), 1)); }

static void instr_D2_0() { write_e8(rol8(read_write_e8(), reg8[CL] & 31)); }
static void instr_D2_1() { write_e8(ror8(read_write_e8(), reg8[CL] & 31)); }
static void instr_D2_2() { write_e8(rcl8(read_write_e8(), reg8[CL] & 31)); }
static void instr_D2_3() { write_e8(rcr8(read_write_e8(), reg8[CL] & 31)); }
static void instr_D2_4() { write_e8(shl8(read_write_e8(), reg8[CL] & 31)); }
static void instr_D2_5() { write_e8(shr8(read_write_e8(), reg8[CL] & 31)); }
static void instr_D2_6() { write_e8(shl8(read_write_e8(), reg8[CL] & 31)); }
static void instr_D2_7() { write_e8(sar8(read_write_e8(), reg8[CL] & 31)); }

static void instr16_D3_0() { write_e16(rol16(read_write_e16(), reg8[CL] & 31)); }
static void instr16_D3_1() { write_e16(ror16(read_write_e16(), reg8[CL] & 31)); }
static void instr16_D3_2() { write_e16(rcl16(read_write_e16(), reg8[CL] & 31)); }
static void instr16_D3_3() { write_e16(rcr16(read_write_e16(), reg8[CL] & 31)); }
static void instr16_D3_4() { write_e16(shl16(read_write_e16(), reg8[CL] & 31)); }
static void instr16_D3_5() { write_e16(shr16(read_write_e16(), reg8[CL] & 31)); }
static void instr16_D3_6() { write_e16(shl16(read_write_e16(), reg8[CL] & 31)); }
static void instr16_D3_7() { write_e16(sar16(read_write_e16(), reg8[CL] & 31)); }

static void instr32_D3_0() { write_e32(rol32(read_write_e32(), reg8[CL] & 31)); }
static void instr32_D3_1() { write_e32(ror32(read_write_e32(), reg8[CL] & 31)); }
static void instr32_D3_2() { write_e32(rcl32(read_write_e32(), reg8[CL] & 31)); }
static void instr32_D3_3() { write_e32(rcr32(read_write_e32(), reg8[CL] & 31)); }
static void instr32_D3_4() { write_e32(shl32(read_write_e32(), reg8[CL] & 31)); }
static void instr32_D3_5() { write_e32(shr32(read_write_e32(), reg8[CL] & 31)); }
static void instr32_D3_6() { write_e32(shl32(read_write_e32(), reg8[CL] & 31)); }
static void instr32_D3_7() { write_e32(sar32(read_write_e32(), reg8[CL] & 31)); }

static void instr_D4() {
    bcd_aam(read_op8());
}
static void instr_D5() {
    bcd_aad(read_op8());
}

static void instr_D6() {
    // salc
    reg8[AL] = -getcf();
}
static void instr_D7() {
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

static void instr_D8() { read_modrm_byte();
    task_switch_test();
    if(modrm_byte[0] < 0xC0)
        fpu_op_D8_mem(modrm_byte[0], modrm_resolve(modrm_byte[0]));
    else
        fpu_op_D8_reg(modrm_byte[0]);
}
static void instr_D9() { read_modrm_byte();
    task_switch_test();
    if(modrm_byte[0] < 0xC0)
        fpu_op_D9_mem(modrm_byte[0], modrm_resolve(modrm_byte[0]));
    else
        fpu_op_D9_reg(modrm_byte[0]);
}
static void instr_DA() { read_modrm_byte();
    task_switch_test();
    if(modrm_byte[0] < 0xC0)
        fpu_op_DA_mem(modrm_byte[0], modrm_resolve(modrm_byte[0]));
    else
        fpu_op_DA_reg(modrm_byte[0]);
}
static void instr_DB() { read_modrm_byte();
    task_switch_test();
    if(modrm_byte[0] < 0xC0)
        fpu_op_DB_mem(modrm_byte[0], modrm_resolve(modrm_byte[0]));
    else
        fpu_op_DB_reg(modrm_byte[0]);
}
static void instr_DC() { read_modrm_byte();
    task_switch_test();
    if(modrm_byte[0] < 0xC0)
        fpu_op_DC_mem(modrm_byte[0], modrm_resolve(modrm_byte[0]));
    else
        fpu_op_DC_reg(modrm_byte[0]);
}
static void instr_DD() { read_modrm_byte();
    task_switch_test();
    if(modrm_byte[0] < 0xC0)
        fpu_op_DD_mem(modrm_byte[0], modrm_resolve(modrm_byte[0]));
    else
        fpu_op_DD_reg(modrm_byte[0]);
}
static void instr_DE() { read_modrm_byte();
    task_switch_test();
    if(modrm_byte[0] < 0xC0)
        fpu_op_DE_mem(modrm_byte[0], modrm_resolve(modrm_byte[0]));
    else
        fpu_op_DE_reg(modrm_byte[0]);
}
static void instr_DF() { read_modrm_byte();
    task_switch_test();
    if(modrm_byte[0] < 0xC0)
        fpu_op_DF_mem(modrm_byte[0], modrm_resolve(modrm_byte[0]));
    else
        fpu_op_DF_reg(modrm_byte[0]);
}

static void instr_E0() { loopne(read_op8s()); }
static void instr_E1() { loope(read_op8s()); }
static void instr_E2() { loop(read_op8s()); }
static void instr_E3() { jcxz(read_op8s()); }

static void instr_E4() {
    int32_t port = read_op8();
    test_privileges_for_io(port, 1);
    reg8[AL] = io_port_read8(port);
    diverged();
}
static void instr16_E5() {
    int32_t port = read_op8();
    test_privileges_for_io(port, 2);
    reg16[AX] = io_port_read16(port);
    diverged();
}
static void instr32_E5() {
    int32_t port = read_op8();
    test_privileges_for_io(port, 4);
    reg32s[EAX] = io_port_read32(port);
    diverged();
}
static void instr_E6() {
    int32_t port = read_op8();
    test_privileges_for_io(port, 1);
    io_port_write8(port, reg8[AL]);
    diverged();
}
static void instr16_E7() {
    int32_t port = read_op8();
    test_privileges_for_io(port, 2);
    io_port_write16(port, reg16[AX]);
    diverged();
}
static void instr32_E7() {
    int32_t port = read_op8();
    test_privileges_for_io(port, 4);
    io_port_write32(port, reg32s[EAX]);
    diverged();
}

static void instr16_E8() {
    // call
    int32_t imm16 = read_op16();
    push16(get_real_eip());

    jmp_rel16(imm16);
    diverged();
}
static void instr32_E8() {
    // call
    int32_t imm32s = read_op32s();
    push32(get_real_eip());

    instruction_pointer[0] = instruction_pointer[0] + imm32s;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
static void instr16_E9() {
    // jmp
    int32_t imm16 = read_op16();
    jmp_rel16(imm16);
    diverged();
}
static void instr32_E9() {
    // jmp
    int32_t imm32s = read_op32s();
    instruction_pointer[0] = instruction_pointer[0] + imm32s;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
static void instr16_EA() {
    // jmpf
    int32_t ip = read_op16();
    int32_t cs = read_disp16();
    far_jump(ip, cs, false);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
static void instr32_EA() {
    // jmpf
    int32_t new_ip = read_op32s();
    int32_t cs = read_disp16();
    far_jump(new_ip, cs, false);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
static void instr_EB() {
    // jmp near
    int32_t imm8 = read_op8s();
    instruction_pointer[0] = instruction_pointer[0] + imm8;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}

static void instr_EC() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 1);
    reg8[AL] = io_port_read8(port);
    diverged();
}
static void instr16_ED() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 2);
    reg16[AX] = io_port_read16(port);
    diverged();
}
static void instr32_ED() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 4);
    reg32s[EAX] = io_port_read32(port);
    diverged();
}
static void instr_EE() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 1);
    io_port_write8(port, reg8[AL]);
    diverged();
}
static void instr16_EF() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 2);
    io_port_write16(port, reg16[AX]);
    diverged();
}
static void instr32_EF() {
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 4);
    io_port_write32(port, reg32s[EAX]);
    diverged();
}

static void instr_F0() {
    // lock
    //dbg_log("lock");

    // TODO
    // This triggers UD when used with
    // some instructions that don't write to memory
    run_prefix_instruction();
}
static void instr_F1() {
    // INT1
    // https://code.google.com/p/corkami/wiki/x86oddities#IceBP
    //throw debug.unimpl("int1 instruction");
    assert(false);
}

static void instr_F2() {
    // repnz
    dbg_assert((*prefixes & PREFIX_MASK_REP) == 0);
    *prefixes |= PREFIX_REPNZ;
    run_prefix_instruction();
    *prefixes = 0;
}
static void instr_F3() {
    // repz
    dbg_assert((*prefixes & PREFIX_MASK_REP) == 0);
    *prefixes |= PREFIX_REPZ;
    run_prefix_instruction();
    *prefixes = 0;
}

static void instr_F4() {
    hlt_op();
}

static void instr_F5() {
    // cmc
    flags[0] = (flags[0] | 1) ^ getcf();
    flags_changed[0] &= ~1;
}

static void instr_F6_0() { test8(read_e8(), read_op8()); }
static void instr_F6_1() { test8(read_e8(), read_op8()); }
static void instr_F6_2() { write_e8(~read_write_e8()); }
static void instr_F6_3() { write_e8(neg8(read_write_e8())); }
static void instr_F6_4() { mul8(read_e8()); }
static void instr_F6_5() { imul8(read_e8s()); }
static void instr_F6_6() { div8(read_e8()); }
static void instr_F6_7() { idiv8(read_e8s()); }

static void instr16_F7_0() { test16(read_e16(), read_op16()); }
static void instr16_F7_1() { test16(read_e16(), read_op16()); }
static void instr16_F7_2() { write_e16(~read_write_e16()); }
static void instr16_F7_3() { write_e16(neg16(read_write_e16())); }
static void instr16_F7_4() { mul16(read_e16()); }
static void instr16_F7_5() { imul16(read_e16s()); }
static void instr16_F7_6() { div16(read_e16()); }
static void instr16_F7_7() { idiv16(read_e16s()); }

static void instr32_F7_0() { test32(read_e32s(), read_op32s()); }
static void instr32_F7_1() { test32(read_e32s(), read_op32s()); }
static void instr32_F7_2() { write_e32(~read_write_e32()); }
static void instr32_F7_3() { write_e32(neg32(read_write_e32())); }
static void instr32_F7_4() { mul32(read_e32s()); }
static void instr32_F7_5() { imul32(read_e32s()); }
static void instr32_F7_6() { div32(read_e32s()); }
static void instr32_F7_7() { idiv32(read_e32s()); }

static void instr_F8() {
    // clc
    flags[0] &= ~FLAG_CARRY;
    flags_changed[0] &= ~1;
}
static void instr_F9() {
    // stc
    flags[0] |= FLAG_CARRY;
    flags_changed[0] &= ~1;
}

static void instr_FA() {
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
static void instr_FB() {
    // sti
    //dbg_log("interrupts on");

    if(!*protected_mode || ((flags[0] & FLAG_VM) ?
            getiopl() == 3 : getiopl() >= *cpl))
    {
        flags[0] |= FLAG_INTERRUPT;

        clear_prefixes();
        cycle_internal();

        handle_irqs();
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

static void instr_FC() {
    // cld
    flags[0] &= ~FLAG_DIRECTION;
}
static void instr_FD() {
    // std
    flags[0] |= FLAG_DIRECTION;
}

static void instr_FE_0() { int32_t data = read_write_e8(); write_e8(inc8(data)); }
static void instr_FE_1() { int32_t data = read_write_e8(); write_e8(dec8(data)); }

static void instr16_FF_0() { write_e16(inc16(read_write_e16())); }
static void instr16_FF_1() { write_e16(dec16(read_write_e16())); }
static void instr16_FF_2()
{
    // call near
    int32_t data = read_e16();
    push16(get_real_eip());
    instruction_pointer[0] = get_seg(CS) + data;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
static void instr16_FF_3()
{
    // callf
    if(modrm_byte[0] >= 0xC0)
    {
        dbg_log("callf #ud");
        trigger_ud();
        dbg_assert_message(false, "unreachable");
    }

    int32_t virt_addr = modrm_resolve(modrm_byte[0]);
    int32_t new_ip = safe_read16(virt_addr);
    int32_t new_cs = safe_read16(virt_addr + 2);

    far_jump(new_ip, new_cs, true);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
static void instr16_FF_4()
{
    // jmp near
    int32_t data = read_e16();
    instruction_pointer[0] = get_seg(CS) + data;
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
static void instr16_FF_5()
{
    // jmpf
    if(modrm_byte[0] >= 0xC0)
    {
        dbg_log("jmpf #ud");
        trigger_ud();
        dbg_assert_message(false, "unreachable");
    }

    int32_t virt_addr = modrm_resolve(modrm_byte[0]);
    int32_t new_ip = safe_read16(virt_addr);
    int32_t new_cs = safe_read16(virt_addr + 2);

    far_jump(new_ip, new_cs, false);
    dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
    diverged();
}
static void instr16_FF_6() { push16(read_e16()); }

static void instr32_FF_0() { write_e32(inc32(read_write_e32())); }
static void instr32_FF_1() { write_e32(dec32(read_write_e32())); }
static void instr32_FF_2()
{
    // call near
    int32_t data = read_e32s();
    push32(get_real_eip());
    dbg_assert(is_asize_32() || data < 0x10000);
    instruction_pointer[0] = get_seg(CS) + data;
    diverged();
}
static void instr32_FF_3()
{
    // callf
    if(modrm_byte[0] >= 0xC0)
    {
        dbg_log("callf #ud");
        trigger_ud();
        dbg_assert_message(false, "unreachable");
    }

    int32_t virt_addr = modrm_resolve(modrm_byte[0]);
    int32_t new_ip = safe_read32s(virt_addr);
    int32_t new_cs = safe_read16(virt_addr + 4);

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
static void instr32_FF_4()
{
    // jmp near
    int32_t data = read_e32s();
    dbg_assert(is_asize_32() || data < 0x10000);
    instruction_pointer[0] = get_seg(CS) + data;
    diverged();
}
static void instr32_FF_5()
{
    // jmpf
    if(modrm_byte[0] >= 0xC0)
    {
        dbg_log("jmpf #ud");
        trigger_ud();
        dbg_assert_message(false, "unreachable");
    }

    int32_t virt_addr = modrm_resolve(modrm_byte[0]);
    int32_t new_ip = safe_read32s(virt_addr);
    int32_t new_cs = safe_read16(virt_addr + 4);

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
static void instr32_FF_6() { push32(read_e32s()); }



static void run_instruction(int32_t opcode)
{
    //dbg_log(opcode);
    // XXX: This table is generated. Don't modify
    switch(opcode)
    {
case 0x00:
case 0x00|0x100:
{
    instr_00();
}
break;
case 0x01:
{
    instr16_01();
}
break;
case 0x01|0x100:
{
    instr32_01();
}
break;
case 0x02:
case 0x02|0x100:
{
    instr_02();
}
break;
case 0x03:
{
    instr16_03();
}
break;
case 0x03|0x100:
{
    instr32_03();
}
break;
case 0x04:
case 0x04|0x100:
{
    instr_04();
}
break;
case 0x05:
{
    instr16_05();
}
break;
case 0x05|0x100:
{
    instr32_05();
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
    instr_08();
}
break;
case 0x09:
{
    instr16_09();
}
break;
case 0x09|0x100:
{
    instr32_09();
}
break;
case 0x0A:
case 0x0A|0x100:
{
    instr_0A();
}
break;
case 0x0B:
{
    instr16_0B();
}
break;
case 0x0B|0x100:
{
    instr32_0B();
}
break;
case 0x0C:
case 0x0C|0x100:
{
    instr_0C();
}
break;
case 0x0D:
{
    instr16_0D();
}
break;
case 0x0D|0x100:
{
    instr32_0D();
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
    instr_10();
}
break;
case 0x11:
{
    instr16_11();
}
break;
case 0x11|0x100:
{
    instr32_11();
}
break;
case 0x12:
case 0x12|0x100:
{
    instr_12();
}
break;
case 0x13:
{
    instr16_13();
}
break;
case 0x13|0x100:
{
    instr32_13();
}
break;
case 0x14:
case 0x14|0x100:
{
    instr_14();
}
break;
case 0x15:
{
    instr16_15();
}
break;
case 0x15|0x100:
{
    instr32_15();
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
    instr_18();
}
break;
case 0x19:
{
    instr16_19();
}
break;
case 0x19|0x100:
{
    instr32_19();
}
break;
case 0x1A:
case 0x1A|0x100:
{
    instr_1A();
}
break;
case 0x1B:
{
    instr16_1B();
}
break;
case 0x1B|0x100:
{
    instr32_1B();
}
break;
case 0x1C:
case 0x1C|0x100:
{
    instr_1C();
}
break;
case 0x1D:
{
    instr16_1D();
}
break;
case 0x1D|0x100:
{
    instr32_1D();
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
    instr_20();
}
break;
case 0x21:
{
    instr16_21();
}
break;
case 0x21|0x100:
{
    instr32_21();
}
break;
case 0x22:
case 0x22|0x100:
{
    instr_22();
}
break;
case 0x23:
{
    instr16_23();
}
break;
case 0x23|0x100:
{
    instr32_23();
}
break;
case 0x24:
case 0x24|0x100:
{
    instr_24();
}
break;
case 0x25:
{
    instr16_25();
}
break;
case 0x25|0x100:
{
    instr32_25();
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
    instr_28();
}
break;
case 0x29:
{
    instr16_29();
}
break;
case 0x29|0x100:
{
    instr32_29();
}
break;
case 0x2A:
case 0x2A|0x100:
{
    instr_2A();
}
break;
case 0x2B:
{
    instr16_2B();
}
break;
case 0x2B|0x100:
{
    instr32_2B();
}
break;
case 0x2C:
case 0x2C|0x100:
{
    instr_2C();
}
break;
case 0x2D:
{
    instr16_2D();
}
break;
case 0x2D|0x100:
{
    instr32_2D();
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
    instr_30();
}
break;
case 0x31:
{
    instr16_31();
}
break;
case 0x31|0x100:
{
    instr32_31();
}
break;
case 0x32:
case 0x32|0x100:
{
    instr_32();
}
break;
case 0x33:
{
    instr16_33();
}
break;
case 0x33|0x100:
{
    instr32_33();
}
break;
case 0x34:
case 0x34|0x100:
{
    instr_34();
}
break;
case 0x35:
{
    instr16_35();
}
break;
case 0x35|0x100:
{
    instr32_35();
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
    instr_38();
}
break;
case 0x39:
{
    instr16_39();
}
break;
case 0x39|0x100:
{
    instr32_39();
}
break;
case 0x3A:
case 0x3A|0x100:
{
    instr_3A();
}
break;
case 0x3B:
{
    instr16_3B();
}
break;
case 0x3B|0x100:
{
    instr32_3B();
}
break;
case 0x3C:
case 0x3C|0x100:
{
    instr_3C();
}
break;
case 0x3D:
{
    instr16_3D();
}
break;
case 0x3D|0x100:
{
    instr32_3D();
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
    instr_62();
}
break;
case 0x63:
case 0x63|0x100:
{
    instr_63();
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
    instr16_68();
}
break;
case 0x68|0x100:
{
    instr32_68();
}
break;
case 0x69:
{
    instr16_69();
}
break;
case 0x69|0x100:
{
    instr32_69();
}
break;
case 0x6A:
{
    instr16_6A();
}
break;
case 0x6A|0x100:
{
    instr32_6A();
}
break;
case 0x6B:
{
    instr16_6B();
}
break;
case 0x6B|0x100:
{
    instr32_6B();
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
    instr_70();
}
break;
case 0x71:
case 0x71|0x100:
{
    instr_71();
}
break;
case 0x72:
case 0x72|0x100:
{
    instr_72();
}
break;
case 0x73:
case 0x73|0x100:
{
    instr_73();
}
break;
case 0x74:
case 0x74|0x100:
{
    instr_74();
}
break;
case 0x75:
case 0x75|0x100:
{
    instr_75();
}
break;
case 0x76:
case 0x76|0x100:
{
    instr_76();
}
break;
case 0x77:
case 0x77|0x100:
{
    instr_77();
}
break;
case 0x78:
case 0x78|0x100:
{
    instr_78();
}
break;
case 0x79:
case 0x79|0x100:
{
    instr_79();
}
break;
case 0x7A:
case 0x7A|0x100:
{
    instr_7A();
}
break;
case 0x7B:
case 0x7B|0x100:
{
    instr_7B();
}
break;
case 0x7C:
case 0x7C|0x100:
{
    instr_7C();
}
break;
case 0x7D:
case 0x7D|0x100:
{
    instr_7D();
}
break;
case 0x7E:
case 0x7E|0x100:
{
    instr_7E();
}
break;
case 0x7F:
case 0x7F|0x100:
{
    instr_7F();
}
break;
case 0x80:
case 0x80|0x100:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr_80_0();
        }
        break;
        case 1:
        {
            instr_80_1();
        }
        break;
        case 2:
        {
            instr_80_2();
        }
        break;
        case 3:
        {
            instr_80_3();
        }
        break;
        case 4:
        {
            instr_80_4();
        }
        break;
        case 5:
        {
            instr_80_5();
        }
        break;
        case 6:
        {
            instr_80_6();
        }
        break;
        case 7:
        {
            instr_80_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0x81:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr16_81_0();
        }
        break;
        case 1:
        {
            instr16_81_1();
        }
        break;
        case 2:
        {
            instr16_81_2();
        }
        break;
        case 3:
        {
            instr16_81_3();
        }
        break;
        case 4:
        {
            instr16_81_4();
        }
        break;
        case 5:
        {
            instr16_81_5();
        }
        break;
        case 6:
        {
            instr16_81_6();
        }
        break;
        case 7:
        {
            instr16_81_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0x81|0x100:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr32_81_0();
        }
        break;
        case 1:
        {
            instr32_81_1();
        }
        break;
        case 2:
        {
            instr32_81_2();
        }
        break;
        case 3:
        {
            instr32_81_3();
        }
        break;
        case 4:
        {
            instr32_81_4();
        }
        break;
        case 5:
        {
            instr32_81_5();
        }
        break;
        case 6:
        {
            instr32_81_6();
        }
        break;
        case 7:
        {
            instr32_81_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0x82:
case 0x82|0x100:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr_82_0();
        }
        break;
        case 1:
        {
            instr_82_1();
        }
        break;
        case 2:
        {
            instr_82_2();
        }
        break;
        case 3:
        {
            instr_82_3();
        }
        break;
        case 4:
        {
            instr_82_4();
        }
        break;
        case 5:
        {
            instr_82_5();
        }
        break;
        case 6:
        {
            instr_82_6();
        }
        break;
        case 7:
        {
            instr_82_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0x83:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr16_83_0();
        }
        break;
        case 1:
        {
            instr16_83_1();
        }
        break;
        case 2:
        {
            instr16_83_2();
        }
        break;
        case 3:
        {
            instr16_83_3();
        }
        break;
        case 4:
        {
            instr16_83_4();
        }
        break;
        case 5:
        {
            instr16_83_5();
        }
        break;
        case 6:
        {
            instr16_83_6();
        }
        break;
        case 7:
        {
            instr16_83_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0x83|0x100:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr32_83_0();
        }
        break;
        case 1:
        {
            instr32_83_1();
        }
        break;
        case 2:
        {
            instr32_83_2();
        }
        break;
        case 3:
        {
            instr32_83_3();
        }
        break;
        case 4:
        {
            instr32_83_4();
        }
        break;
        case 5:
        {
            instr32_83_5();
        }
        break;
        case 6:
        {
            instr32_83_6();
        }
        break;
        case 7:
        {
            instr32_83_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0x84:
case 0x84|0x100:
{
    instr_84();
}
break;
case 0x85:
{
    instr16_85();
}
break;
case 0x85|0x100:
{
    instr32_85();
}
break;
case 0x86:
case 0x86|0x100:
{
    instr_86();
}
break;
case 0x87:
{
    instr16_87();
}
break;
case 0x87|0x100:
{
    instr32_87();
}
break;
case 0x88:
case 0x88|0x100:
{
    instr_88();
}
break;
case 0x89:
{
    instr16_89();
}
break;
case 0x89|0x100:
{
    instr32_89();
}
break;
case 0x8A:
case 0x8A|0x100:
{
    instr_8A();
}
break;
case 0x8B:
{
    instr16_8B();
}
break;
case 0x8B|0x100:
{
    instr32_8B();
}
break;
case 0x8C:
{
    instr16_8C();
}
break;
case 0x8C|0x100:
{
    instr32_8C();
}
break;
case 0x8D:
{
    instr16_8D();
}
break;
case 0x8D|0x100:
{
    instr32_8D();
}
break;
case 0x8E:
case 0x8E|0x100:
{
    instr_8E();
}
break;
case 0x8F:
{
    instr16_8F();
}
break;
case 0x8F|0x100:
{
    instr32_8F();
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
    instr16_9A();
}
break;
case 0x9A|0x100:
{
    instr32_9A();
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
    instr_A0();
}
break;
case 0xA1:
{
    instr16_A1();
}
break;
case 0xA1|0x100:
{
    instr32_A1();
}
break;
case 0xA2:
case 0xA2|0x100:
{
    instr_A2();
}
break;
case 0xA3:
{
    instr16_A3();
}
break;
case 0xA3|0x100:
{
    instr32_A3();
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
    instr_A8();
}
break;
case 0xA9:
{
    instr16_A9();
}
break;
case 0xA9|0x100:
{
    instr32_A9();
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
    instr_B0();
}
break;
case 0xB1:
case 0xB1|0x100:
{
    instr_B1();
}
break;
case 0xB2:
case 0xB2|0x100:
{
    instr_B2();
}
break;
case 0xB3:
case 0xB3|0x100:
{
    instr_B3();
}
break;
case 0xB4:
case 0xB4|0x100:
{
    instr_B4();
}
break;
case 0xB5:
case 0xB5|0x100:
{
    instr_B5();
}
break;
case 0xB6:
case 0xB6|0x100:
{
    instr_B6();
}
break;
case 0xB7:
case 0xB7|0x100:
{
    instr_B7();
}
break;
case 0xB8:
{
    instr16_B8();
}
break;
case 0xB8|0x100:
{
    instr32_B8();
}
break;
case 0xB9:
{
    instr16_B9();
}
break;
case 0xB9|0x100:
{
    instr32_B9();
}
break;
case 0xBA:
{
    instr16_BA();
}
break;
case 0xBA|0x100:
{
    instr32_BA();
}
break;
case 0xBB:
{
    instr16_BB();
}
break;
case 0xBB|0x100:
{
    instr32_BB();
}
break;
case 0xBC:
{
    instr16_BC();
}
break;
case 0xBC|0x100:
{
    instr32_BC();
}
break;
case 0xBD:
{
    instr16_BD();
}
break;
case 0xBD|0x100:
{
    instr32_BD();
}
break;
case 0xBE:
{
    instr16_BE();
}
break;
case 0xBE|0x100:
{
    instr32_BE();
}
break;
case 0xBF:
{
    instr16_BF();
}
break;
case 0xBF|0x100:
{
    instr32_BF();
}
break;
case 0xC0:
case 0xC0|0x100:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr_C0_0();
        }
        break;
        case 1:
        {
            instr_C0_1();
        }
        break;
        case 2:
        {
            instr_C0_2();
        }
        break;
        case 3:
        {
            instr_C0_3();
        }
        break;
        case 4:
        {
            instr_C0_4();
        }
        break;
        case 5:
        {
            instr_C0_5();
        }
        break;
        case 6:
        {
            instr_C0_6();
        }
        break;
        case 7:
        {
            instr_C0_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0xC1:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr16_C1_0();
        }
        break;
        case 1:
        {
            instr16_C1_1();
        }
        break;
        case 2:
        {
            instr16_C1_2();
        }
        break;
        case 3:
        {
            instr16_C1_3();
        }
        break;
        case 4:
        {
            instr16_C1_4();
        }
        break;
        case 5:
        {
            instr16_C1_5();
        }
        break;
        case 6:
        {
            instr16_C1_6();
        }
        break;
        case 7:
        {
            instr16_C1_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0xC1|0x100:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr32_C1_0();
        }
        break;
        case 1:
        {
            instr32_C1_1();
        }
        break;
        case 2:
        {
            instr32_C1_2();
        }
        break;
        case 3:
        {
            instr32_C1_3();
        }
        break;
        case 4:
        {
            instr32_C1_4();
        }
        break;
        case 5:
        {
            instr32_C1_5();
        }
        break;
        case 6:
        {
            instr32_C1_6();
        }
        break;
        case 7:
        {
            instr32_C1_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0xC2:
{
    instr16_C2();
}
break;
case 0xC2|0x100:
{
    instr32_C2();
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
    instr16_C4();
}
break;
case 0xC4|0x100:
{
    instr32_C4();
}
break;
case 0xC5:
{
    instr16_C5();
}
break;
case 0xC5|0x100:
{
    instr32_C5();
}
break;
case 0xC6:
case 0xC6|0x100:
{
    instr_C6();
}
break;
case 0xC7:
{
    instr16_C7();
}
break;
case 0xC7|0x100:
{
    instr32_C7();
}
break;
case 0xC8:
{
    instr16_C8();
}
break;
case 0xC8|0x100:
{
    instr32_C8();
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
    instr16_CA();
}
break;
case 0xCA|0x100:
{
    instr32_CA();
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
    instr_CD();
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
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr_D0_0();
        }
        break;
        case 1:
        {
            instr_D0_1();
        }
        break;
        case 2:
        {
            instr_D0_2();
        }
        break;
        case 3:
        {
            instr_D0_3();
        }
        break;
        case 4:
        {
            instr_D0_4();
        }
        break;
        case 5:
        {
            instr_D0_5();
        }
        break;
        case 6:
        {
            instr_D0_6();
        }
        break;
        case 7:
        {
            instr_D0_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0xD1:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr16_D1_0();
        }
        break;
        case 1:
        {
            instr16_D1_1();
        }
        break;
        case 2:
        {
            instr16_D1_2();
        }
        break;
        case 3:
        {
            instr16_D1_3();
        }
        break;
        case 4:
        {
            instr16_D1_4();
        }
        break;
        case 5:
        {
            instr16_D1_5();
        }
        break;
        case 6:
        {
            instr16_D1_6();
        }
        break;
        case 7:
        {
            instr16_D1_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0xD1|0x100:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr32_D1_0();
        }
        break;
        case 1:
        {
            instr32_D1_1();
        }
        break;
        case 2:
        {
            instr32_D1_2();
        }
        break;
        case 3:
        {
            instr32_D1_3();
        }
        break;
        case 4:
        {
            instr32_D1_4();
        }
        break;
        case 5:
        {
            instr32_D1_5();
        }
        break;
        case 6:
        {
            instr32_D1_6();
        }
        break;
        case 7:
        {
            instr32_D1_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0xD2:
case 0xD2|0x100:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr_D2_0();
        }
        break;
        case 1:
        {
            instr_D2_1();
        }
        break;
        case 2:
        {
            instr_D2_2();
        }
        break;
        case 3:
        {
            instr_D2_3();
        }
        break;
        case 4:
        {
            instr_D2_4();
        }
        break;
        case 5:
        {
            instr_D2_5();
        }
        break;
        case 6:
        {
            instr_D2_6();
        }
        break;
        case 7:
        {
            instr_D2_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0xD3:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr16_D3_0();
        }
        break;
        case 1:
        {
            instr16_D3_1();
        }
        break;
        case 2:
        {
            instr16_D3_2();
        }
        break;
        case 3:
        {
            instr16_D3_3();
        }
        break;
        case 4:
        {
            instr16_D3_4();
        }
        break;
        case 5:
        {
            instr16_D3_5();
        }
        break;
        case 6:
        {
            instr16_D3_6();
        }
        break;
        case 7:
        {
            instr16_D3_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0xD3|0x100:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr32_D3_0();
        }
        break;
        case 1:
        {
            instr32_D3_1();
        }
        break;
        case 2:
        {
            instr32_D3_2();
        }
        break;
        case 3:
        {
            instr32_D3_3();
        }
        break;
        case 4:
        {
            instr32_D3_4();
        }
        break;
        case 5:
        {
            instr32_D3_5();
        }
        break;
        case 6:
        {
            instr32_D3_6();
        }
        break;
        case 7:
        {
            instr32_D3_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0xD4:
case 0xD4|0x100:
{
    instr_D4();
}
break;
case 0xD5:
case 0xD5|0x100:
{
    instr_D5();
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
    instr_D8();
}
break;
case 0xD9:
case 0xD9|0x100:
{
    instr_D9();
}
break;
case 0xDA:
case 0xDA|0x100:
{
    instr_DA();
}
break;
case 0xDB:
case 0xDB|0x100:
{
    instr_DB();
}
break;
case 0xDC:
case 0xDC|0x100:
{
    instr_DC();
}
break;
case 0xDD:
case 0xDD|0x100:
{
    instr_DD();
}
break;
case 0xDE:
case 0xDE|0x100:
{
    instr_DE();
}
break;
case 0xDF:
case 0xDF|0x100:
{
    instr_DF();
}
break;
case 0xE0:
case 0xE0|0x100:
{
    instr_E0();
}
break;
case 0xE1:
case 0xE1|0x100:
{
    instr_E1();
}
break;
case 0xE2:
case 0xE2|0x100:
{
    instr_E2();
}
break;
case 0xE3:
case 0xE3|0x100:
{
    instr_E3();
}
break;
case 0xE4:
case 0xE4|0x100:
{
    instr_E4();
}
break;
case 0xE5:
{
    instr16_E5();
}
break;
case 0xE5|0x100:
{
    instr32_E5();
}
break;
case 0xE6:
case 0xE6|0x100:
{
    instr_E6();
}
break;
case 0xE7:
{
    instr16_E7();
}
break;
case 0xE7|0x100:
{
    instr32_E7();
}
break;
case 0xE8:
{
    instr16_E8();
}
break;
case 0xE8|0x100:
{
    instr32_E8();
}
break;
case 0xE9:
{
    instr16_E9();
}
break;
case 0xE9|0x100:
{
    instr32_E9();
}
break;
case 0xEA:
{
    instr16_EA();
}
break;
case 0xEA|0x100:
{
    instr32_EA();
}
break;
case 0xEB:
case 0xEB|0x100:
{
    instr_EB();
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
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr_F6_0();
        }
        break;
        case 1:
        {
            instr_F6_1();
        }
        break;
        case 2:
        {
            instr_F6_2();
        }
        break;
        case 3:
        {
            instr_F6_3();
        }
        break;
        case 4:
        {
            instr_F6_4();
        }
        break;
        case 5:
        {
            instr_F6_5();
        }
        break;
        case 6:
        {
            instr_F6_6();
        }
        break;
        case 7:
        {
            instr_F6_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0xF7:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr16_F7_0();
        }
        break;
        case 1:
        {
            instr16_F7_1();
        }
        break;
        case 2:
        {
            instr16_F7_2();
        }
        break;
        case 3:
        {
            instr16_F7_3();
        }
        break;
        case 4:
        {
            instr16_F7_4();
        }
        break;
        case 5:
        {
            instr16_F7_5();
        }
        break;
        case 6:
        {
            instr16_F7_6();
        }
        break;
        case 7:
        {
            instr16_F7_7();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0xF7|0x100:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr32_F7_0();
        }
        break;
        case 1:
        {
            instr32_F7_1();
        }
        break;
        case 2:
        {
            instr32_F7_2();
        }
        break;
        case 3:
        {
            instr32_F7_3();
        }
        break;
        case 4:
        {
            instr32_F7_4();
        }
        break;
        case 5:
        {
            instr32_F7_5();
        }
        break;
        case 6:
        {
            instr32_F7_6();
        }
        break;
        case 7:
        {
            instr32_F7_7();
        }
        break;
        default:
            assert(false);
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
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr_FE_0();
        }
        break;
        case 1:
        {
            instr_FE_1();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0xFF:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr16_FF_0();
        }
        break;
        case 1:
        {
            instr16_FF_1();
        }
        break;
        case 2:
        {
            instr16_FF_2();
        }
        break;
        case 3:
        {
            instr16_FF_3();
        }
        break;
        case 4:
        {
            instr16_FF_4();
        }
        break;
        case 5:
        {
            instr16_FF_5();
        }
        break;
        case 6:
        {
            instr16_FF_6();
        }
        break;
        default:
            assert(false);
    }
}
break;
case 0xFF|0x100:
{
    read_modrm_byte();
    switch(*modrm_byte >> 3 & 7)
    {
        case 0:
        {
            instr32_FF_0();
        }
        break;
        case 1:
        {
            instr32_FF_1();
        }
        break;
        case 2:
        {
            instr32_FF_2();
        }
        break;
        case 3:
        {
            instr32_FF_3();
        }
        break;
        case 4:
        {
            instr32_FF_4();
        }
        break;
        case 5:
        {
            instr32_FF_5();
        }
        break;
        case 6:
        {
            instr32_FF_6();
        }
        break;
        default:
            assert(false);
    }
}
break;
default:
    assert(false);
    }
}
