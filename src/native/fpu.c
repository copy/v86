#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#include "const.h"
#include "cpu.h"
#include "fpu.h"
#include "global_pointers.h"
#include "js_imports.h"
#include "log.h"
#include "misc_instr.h"

const int32_t
    FPU_C0 = 0x100,
    FPU_C1 = 0x200,
    FPU_C2 = 0x400,
    FPU_C3 = 0x4000,
    FPU_RESULT_FLAGS = FPU_C0 | FPU_C1 | FPU_C2 | FPU_C3,
    FPU_STACK_TOP = 0x3800;

// precision, round & infinity control
const int32_t
    FPU_PC = 3 << 8,
    FPU_RC = 3 << 10,
    FPU_IF = 1 << 12;

// exception bits in the status word
const int32_t
    FPU_EX_SF = 1 << 6,
    FPU_EX_P = 1 << 5,
    FPU_EX_U = 1 << 4,
    FPU_EX_O = 1 << 3,
    FPU_EX_Z = 1 << 2,
    FPU_EX_D = 1 << 1,
    FPU_EX_I = 1 << 0;

const double_t TWO_POW_63 =  0x8000000000000000;
const double_t INDEFINITE_NAN = NAN;

union f64_int {
    uint8_t u8[8];
    int32_t i32[2];
    double_t f64;
};

union f32_int {
    uint8_t u8[4];
    int32_t i32;
    float_t f32;
};

void fpu_set_tag_word(int32_t tag_word)
{
    *fpu_stack_empty = 0;

    for(int i = 0; i < 8; i++)
    {
        *fpu_stack_empty |= (tag_word >> i) & (tag_word >> (i + 1)) & 1 << i;
    }
}

void fpu_fcomi(int32_t r)
{
    double y = fpu_get_sti(r);
    double_t x = fpu_st[*fpu_stack_ptr];
    *flags_changed &= ~(1 | FLAG_PARITY | FLAG_ZERO);
    *flags &= ~(1 | FLAG_PARITY | FLAG_ZERO);

    if(x > y)
    {
    }
    else if(y > x)
    {
        *flags |= 1;
    }
    else if(x == y)
    {
        *flags |= FLAG_ZERO;
    }
    else
    {
        *flags |= 1 | FLAG_PARITY | FLAG_ZERO;
    }
}

int32_t fpu_load_status_word()
{
    return *fpu_status_word & ~(7 << 11) | *fpu_stack_ptr << 11;
}

void fpu_set_status_word(int32_t sw)
{
    *fpu_status_word = sw & ~(7 << 11);
    *fpu_stack_ptr = sw >> 11 & 7;
}

// sign of a number on the stack
int32_t fpu_sign(int32_t i)
{
    return fpu_st8[(*fpu_stack_ptr + i & 7) << 3 | 7] >> 7;
}

void fpu_store_m80(uint32_t addr, double_t n)
{
    union f64_int double_int_view = { .f64 = n };

    uint8_t sign = double_int_view.u8[7] & 0x80;
    int32_t exponent = (double_int_view.u8[7] & 0x7f) << 4 | double_int_view.u8[6] >> 4;
    int32_t low, high;

    if(exponent == 0x7FF)
    {
        // all bits set (NaN and infinity)
        exponent = 0x7FFF;
        low = 0;
        high = 0x80000000 | (double_int_view.i32[1] & 0x80000) << 11;
    }
    else if(exponent == 0)
    {
        // zero and denormal numbers
        // Just assume zero for now
        low = 0;
        high = 0;
    }
    else
    {
        exponent += 0x3FFF - 0x3FF;

        // does the mantissa need to be adjusted?
        low = double_int_view.i32[0] << 11;
        high = 0x80000000 | (double_int_view.i32[1] & 0xFFFFF) << 11 | (((uint32_t)(double_int_view.i32[0])) >> 21);
    }

    dbg_assert(exponent >= 0 && exponent < 0x8000);

    // writable_or_pagefault must have checked called by the caller!
    safe_write32(addr, low);
    safe_write32(addr + 4, high);
    safe_write16(addr + 8, sign << 8 | exponent);
}

double_t fpu_load_m80(uint32_t addr)
{
    int32_t exponent = safe_read16(addr + 8);
    uint32_t low = ((uint32_t)(safe_read32s(addr)));
    uint32_t high = ((uint32_t)(safe_read32s(addr + 4)));

    int32_t sign = exponent >> 15;
    exponent &= ~0x8000;

    if(exponent == 0)
    {
        // TODO: denormal numbers
        return 0;
    }

    if(exponent < 0x7FFF)
    {
        exponent -= 0x3FFF;
    }
    else
    {
        // TODO: NaN, Infinity
        //dbg_log("Load m80 TODO", LOG_FPU);

        union f64_int double_int_view;

        double_int_view.u8[7] = 0x7F | sign << 7;
        double_int_view.u8[6] = 0xF0 | high >> 30 << 3 & 0x08;

        double_int_view.u8[5] = 0;
        double_int_view.u8[4] = 0;

        double_int_view.i32[0] = 0;

        return double_int_view.f64;
    }

    // Note: some bits might be lost at this point
    double_t mantissa = ((double_t)(low)) + 0x100000000 * ((double_t)(high));

    if(sign)
    {
        mantissa = -mantissa;
    }

    // Simply compute the 64 bit floating point number.
    // An alternative write the mantissa, sign and exponent in the
    // float64_byte and return float64[0]

    return mantissa * pow(2, exponent - 63);
}

void fpu_stack_fault()
{
    // TODO: Interrupt
    *fpu_status_word |= FPU_EX_SF | FPU_EX_I;
}

void fpu_invalid_arithmetic()
{
    *fpu_status_word |= FPU_EX_I;
}

double_t fpu_get_st0()
{
    if(*fpu_stack_empty >> *fpu_stack_ptr & 1)
    {
        *fpu_status_word &= ~FPU_C1;
        fpu_stack_fault();
        return INDEFINITE_NAN;
    }
    else
    {
        return fpu_st[*fpu_stack_ptr];
    }
}

void fpu_fcom(double_t y)
{
    double_t x = fpu_get_st0();

    *fpu_status_word &= ~FPU_RESULT_FLAGS;

    if(x > y)
    {
    }
    else if(y > x)
    {
        *fpu_status_word |= FPU_C0;
    }
    else if(x == y)
    {
        *fpu_status_word |= FPU_C3;
    }
    else
    {
        *fpu_status_word |= FPU_C0 | FPU_C2 | FPU_C3;
    }
}

void fucom(double_t y)
{
    // TODO
    fpu_fcom(y);
}


void fpu_fucomi(int32_t r)
{
    // TODO
    fpu_fcomi(r);
}

void ftst(double_t x)
{
    *fpu_status_word &= ~FPU_RESULT_FLAGS;

    if(isnan(x))
    {
        *fpu_status_word |= FPU_C3 | FPU_C2 | FPU_C0;
    }
    else if(x == 0)
    {
        *fpu_status_word |= FPU_C3;
    }
    else if(x < 0)
    {
        *fpu_status_word |= FPU_C0;
    }

    // TODO: unordered (x is nan, etc)
}

void fxam(double_t x)
{
    *fpu_status_word &= ~FPU_RESULT_FLAGS;
    *fpu_status_word |= fpu_sign(0) << 9;

    if(*fpu_stack_empty >> *fpu_stack_ptr & 1)
    {
        *fpu_status_word |= FPU_C3 | FPU_C0;
    }
    else if(isnan(x))
    {
        *fpu_status_word |= FPU_C0;
    }
    else if(x == 0)
    {
        *fpu_status_word |= FPU_C3;
    }
    else if(x == INFINITY || x == -INFINITY)
    {
        *fpu_status_word |= FPU_C2 | FPU_C0;
    }
    else
    {
        *fpu_status_word |= FPU_C2;
    }
    // TODO:
    // Unsupported, Denormal
}

void fpu_finit(void)
{
    *fpu_control_word = 0x37F;
    *fpu_status_word = 0;
    fpu_ip[0] = 0;
    fpu_dp[0] = 0;
    fpu_opcode[0] = 0;

    *fpu_stack_empty = 0xFF;
    *fpu_stack_ptr = 0;
}


int32_t fpu_load_tag_word()
{
    int32_t tag_word = 0;

    for(int32_t i = 0; i < 8; i++)
    {
        double_t value = fpu_st[i];

        if(*fpu_stack_empty >> i & 1)
        {
            tag_word |= 3 << (i << 1);
        }
        else if(value == 0)
        {
            tag_word |= 1 << (i << 1);
        }
        else if(!isfinite(value))
        {
            tag_word |= 2 << (i << 1);
        }
    }

    //dbg_log("load  tw=" + h(tag_word) + " se=" + h(*fpu_stack_empty) + " sp=" + *fpu_stack_ptr, LOG_FPU);

    return tag_word;
}

void fpu_unimpl()
{
    if(DEBUG)
    {
        assert(false);
    }
    else
    {
        trigger_ud();
    }
}

void fpu_fstenv(int32_t addr)
{
    if(is_osize_32())
    {
        writable_or_pagefault(addr, 26);

        safe_write16(addr, *fpu_control_word);

        safe_write16(addr + 4, fpu_load_status_word());
        safe_write16(addr + 8, fpu_load_tag_word());

        safe_write32(addr + 12, fpu_ip[0]);
        safe_write16(addr + 16, fpu_ip_selector[0]);
        safe_write16(addr + 18, fpu_opcode[0]);
        safe_write32(addr + 20, fpu_dp[0]);
        safe_write16(addr + 24, fpu_dp_selector[0]);
    }
    else
    {
        dbg_log("fstenv16");
        fpu_unimpl();
    }
}

void fpu_fldenv(int32_t addr)
{
    if(is_osize_32())
    {
        *fpu_control_word = safe_read16(addr);

        fpu_set_status_word(safe_read16(addr + 4));
        fpu_set_tag_word(safe_read16(addr + 8));

        fpu_ip[0] = safe_read32s(addr + 12);
        fpu_ip_selector[0] = safe_read16(addr + 16);
        fpu_opcode[0] = safe_read16(addr + 18);
        fpu_dp[0] = safe_read32s(addr + 20);
        fpu_dp_selector[0] = safe_read16(addr + 24);
    }
    else
    {
        dbg_log("fldenv16");
        fpu_unimpl();
    }
}

void fsave(int32_t addr)
{
    writable_or_pagefault(addr, 108);

    fpu_fstenv(addr);
    addr += 28;

    for(int32_t i = 0; i < 8; i++)
    {
        fpu_store_m80(addr, fpu_st[*fpu_stack_ptr + i & 7]);
        addr += 10;
    }

    //dbg_log("save st=" + *fpu_stack_ptr + " " + [].slice.call(this.st), LOG_FPU);

    fpu_finit();
}

void frstor(int32_t addr)
{
    fpu_fldenv(addr);
    addr += 28;

    for(int32_t i = 0; i < 8; i++)
    {
        fpu_st[(i + *fpu_stack_ptr) & 7] = fpu_load_m80(addr);
        addr += 10;
    }

    //dbg_log("rstor st=" + *fpu_stack_ptr + " " + [].slice.call(this.st), LOG_FPU);
}

void fpu_push(double_t x)
{
    *fpu_stack_ptr = *fpu_stack_ptr - 1 & 7;

    if(*fpu_stack_empty >> *fpu_stack_ptr & 1)
    {
        *fpu_status_word &= ~FPU_C1;
        *fpu_stack_empty &= ~(1 << *fpu_stack_ptr);
        fpu_st[*fpu_stack_ptr] = x;
    }
    else
    {
        *fpu_status_word |= FPU_C1;
        fpu_stack_fault();
        fpu_st[*fpu_stack_ptr] = INDEFINITE_NAN;
    }
}

void fpu_pop()
{
    *fpu_stack_empty |= 1 << *fpu_stack_ptr;
    *fpu_stack_ptr = *fpu_stack_ptr + 1 & 7;
}

double_t fpu_get_sti(int32_t i)
{
    dbg_assert(i >= 0 && i < 8);

    i = i + *fpu_stack_ptr & 7;

    if(*fpu_stack_empty >> i & 1)
    {
        *fpu_status_word &= ~FPU_C1;
        fpu_stack_fault();
        return INDEFINITE_NAN;
    }
    else
    {
        return fpu_st[i];
    }
}

void fxtract()
{
    union f64_int double_int_view = { .f64 = fpu_get_st0() };

    double_t exponent = ((double_int_view.u8[7] & 0x7F) << 4 | double_int_view.u8[6] >> 4) - 0x3FF;

    double_int_view.u8[7] = 0x3F | (double_int_view.u8[7] & 0x80);
    double_int_view.u8[6] |= 0xF0;

    fpu_st[*fpu_stack_ptr] = exponent;
    fpu_push(double_int_view.f64);
}

double_t fpu_integer_round(double_t f)
{
    int32_t rc = *fpu_control_word >> 10 & 3;

    // XXX: See https://en.wikipedia.org/wiki/C_mathematical_functions

    if(rc == 0)
    {
        // Round to nearest, or even if equidistant
        double_t rounded = round(f);

        if(rounded - f == 0.5 && (fmod(rounded, 2)))
        {
            // Special case: Math.round rounds to positive infinity
            // if equidistant
            rounded--;
        }

        return rounded;
    }
        // rc=3 is truncate -> floor for positive numbers
    else if(rc == 1 || (rc == 3 && f > 0))
    {
        return floor(f);
    }
    else
    {
        return ceil(f);
    }
}

double_t fpu_truncate(double_t x)
{
    return x > 0 ? floor(x) : ceil(x);
}

double_t fpu_load_m64(int32_t addr)
{
    // XXX: Use safe_read64s
    int32_t low = safe_read32s(addr);
    int32_t high = safe_read32s(addr + 4);

    union f64_int v = { .i32 = { low, high } };

    return v.f64;
}

void fpu_store_m64(int32_t addr, int32_t i)
{
    // XXX: Use safe_write64
    writable_or_pagefault(addr, 8);

    union f64_int v = { .f64 = fpu_get_sti(i) };

    safe_write32(addr, v.i32[0]);
    safe_write32(addr + 4, v.i32[1]);
}

double_t fpu_load_m32(int32_t addr)
{
    union f32_int v = { .i32 = safe_read32s(addr) };
    return v.f32;
}

void fpu_store_m32(int32_t addr, double_t x)
{
    union f32_int v = { .f32 = x };
    safe_write32(addr, v.i32);
}


void dbg_log_fpu_op(int32_t op, int32_t imm8)
{
    UNUSED(op);
    UNUSED(imm8);
#if 0
    if(!FPU_LOG_OP)
    {
        return;
    }

    if(imm8 >= 0xC0)
    {
        dbg_log(h(op, 2) + " " + h(imm8, 2) + "/" + (imm8 >> 3 & 7) + "/" + (imm8 & 7) +
                " @" + h(this.cpu.instruction_pointer[0], 8) + " sp=" + *fpu_stack_ptr + " st=" + h(*fpu_stack_empty, 2), LOG_FPU);
    }
    else
    {
        dbg_log(h(op, 2) + " /" + imm8 +
                "     @" + h(this.cpu.instruction_pointer[0], 8) + " sp=" + *fpu_stack_ptr + " st=" + h(*fpu_stack_empty, 2), LOG_FPU);
    }
#endif
}


void fwait()
{
    // NOP unless FPU instructions run in parallel with CPU instructions
}

void fpu_fadd(double_t val)
{
    double_t st0 = fpu_get_st0();
    fpu_st[*fpu_stack_ptr] = st0 + val;
}

void fpu_fmul(double_t val)
{
    double_t st0 = fpu_get_st0();
    fpu_st[*fpu_stack_ptr] = st0 * val;
}

void fpu_fcomp(double_t val)
{
    fpu_fcom(val);
    fpu_pop();
}

void fpu_fsub(double_t val)
{
    double_t st0 = fpu_get_st0();
    fpu_st[*fpu_stack_ptr] = st0 - val;
}

void fpu_fsubr(double_t val)
{
    double_t st0 = fpu_get_st0();
    fpu_st[*fpu_stack_ptr] = val - st0;
}

void fpu_fdiv(double_t val)
{
    double_t st0 = fpu_get_st0();
    fpu_st[*fpu_stack_ptr] = st0 / val;
}

void fpu_fdivr(double_t val)
{
    double_t st0 = fpu_get_st0();
    fpu_st[*fpu_stack_ptr] = val / st0;
}

void fpu_fxch(int32_t i)
{
    double_t sti = fpu_get_sti(i);
    fpu_st[*fpu_stack_ptr + i] = fpu_get_st0();
    fpu_st[*fpu_stack_ptr] = sti;
}

void fpu_fstm32(int32_t addr)
{
    fpu_store_m32(addr, fpu_get_st0());
}

void fpu_fstm32p(int32_t addr)
{
    fpu_fstm32(addr);
    fpu_pop();
}

void fpu_op_D9_4_reg(int32_t r)
{
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
            ftst(st0);
            break;
        case 5:
            fxam(st0);
            break;
        default:
            dbg_log("%x", r);
            fpu_unimpl();
    }

}

void fpu_op_D9_5_reg(int32_t r)
{
    // fld1/fldl2t/fldl2e/fldpi/fldlg2/fldln2/fldz
    switch(r)
    {
        case 0: fpu_push(1); break;
        case 1: fpu_push(M_LN10 / M_LN2); break;
        case 2: fpu_push(M_LOG2E); break;
        case 3: fpu_push(M_PI); break;
        case 4: fpu_push(M_LN2 / M_LN10); break;
        case 5: fpu_push(M_LN2); break;
        case 6: fpu_push(0); break;
        case 7: dbg_log("d9/5/7"); fpu_unimpl(); break;
    }
}

void fpu_op_D9_6_reg(int32_t r)
{
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
            fxtract();
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

void fpu_op_D9_7_reg(int32_t r)
{
    {
        double_t st0 = fpu_get_st0();

        switch(r)
        {
            case 0:
                // fprem
            {
                double_t st1 = fpu_get_sti(1);
                int32_t fprem_quotient = trunc(st0 / st1);
                fpu_st[*fpu_stack_ptr] = fmod(st0, st1);

                *fpu_status_word &= ~(FPU_C0 | FPU_C1 | FPU_C3);
                if (fprem_quotient & 1) {
                    *fpu_status_word |= FPU_C1;
                }
                if (fprem_quotient & (1 << 1)) {
                    *fpu_status_word |= FPU_C3;
                }
                if (fprem_quotient & (1 << 2)) {
                    *fpu_status_word |= FPU_C0;
                }

                *fpu_status_word &= ~FPU_C2;
            }
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
                fpu_st[*fpu_stack_ptr] = st0 * pow(2, fpu_truncate(fpu_get_sti(1)));
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
}

void fpu_fldcw(int32_t addr)
{
    int32_t word = safe_read16(addr);
    *fpu_control_word = word;
}

void fpu_fstcw(int32_t addr)
{
    safe_write16(addr, *fpu_control_word);
}

void fpu_fcmovcc(bool condition, int32_t r)
{
    if(condition)
    {
        fpu_st[*fpu_stack_ptr] = fpu_get_sti(r);
        *fpu_stack_empty &= ~(1 << *fpu_stack_ptr);
    }
}

void fpu_fucompp(void)
{
    fucom(fpu_get_sti(1));
    fpu_pop();
    fpu_pop();
}

void fpu_fclex(void) { *fpu_status_word = 0; }

void fpu_fistm32(int32_t addr)
{
    double_t st0 = fpu_integer_round(fpu_get_st0());
    int32_t i = convert_f64_to_i32(st0);
    if(i == (int32_t)0x80000000)
    {
        // XXX: Probably not correct if st0 == 0x80000000
        //      (input fits, but same value as error value)
        fpu_invalid_arithmetic();
    }
    safe_write32(addr, i);
}

void fpu_fistm32p(int32_t addr) { fpu_fistm32(addr); fpu_pop(); }

void fpu_fst80p(int32_t addr)
{
    writable_or_pagefault(addr, 10);
    fpu_store_m80(addr, fpu_get_st0());
    fpu_pop();
}

void fpu_op_DB_reg(int32_t imm8)
{
    dbg_log_fpu_op(0xDB, imm8);

    int32_t mod = imm8 >> 3 & 7;
    int32_t low = imm8 & 7;

    switch(mod)
    {
        case 0:
            // fcmovnb
            if(!test_b())
            {
                fpu_st[*fpu_stack_ptr] = fpu_get_sti(low);
                *fpu_stack_empty &= ~(1 << *fpu_stack_ptr);
            }
            break;
        case 1:
            // fcmovne
            if(!test_z())
            {
                fpu_st[*fpu_stack_ptr] = fpu_get_sti(low);
                *fpu_stack_empty &= ~(1 << *fpu_stack_ptr);
            }
            break;
        case 2:
            // fcmovnbe
            if(!test_be())
            {
                fpu_st[*fpu_stack_ptr] = fpu_get_sti(low);
                *fpu_stack_empty &= ~(1 << *fpu_stack_ptr);
            }
            break;
        case 3:
            // fcmovnu
            if(!test_p())
            {
                fpu_st[*fpu_stack_ptr] = fpu_get_sti(low);
                *fpu_stack_empty &= ~(1 << *fpu_stack_ptr);
            }
            break;
        case 4:
            if(imm8 == 0xE3)
            {
                fpu_finit();
            }
            else if(imm8 == 0xE4)
            {
                // fsetpm
                // treat as nop
            }
            else if(imm8 == 0xE1)
            {
                // fdisi
                // also treat as nop
            }
            else if(imm8 == 0xE2)
            {
                // fclex
                *fpu_status_word = 0;
            }
            else
            {
                dbg_log("%x", imm8);
                fpu_unimpl();
            }
            break;
        case 5:
            fpu_fucomi(low);
            break;
        case 6:
            fpu_fcomi(low);
            break;
        default:
            dbg_log("%x", mod);
            fpu_unimpl();
    }
}

void fpu_op_DB_mem(int32_t mod, int32_t addr)
{
    dbg_log_fpu_op(0xDB, mod);

    switch(mod)
    {
        case 0:
            // fild
            {
                int32_t data = safe_read32s(addr);
                fpu_push(data);
            }
            break;
        case 2:
            // fist
            {
                double_t st0 = fpu_integer_round(fpu_get_st0());
                int32_t i = convert_f64_to_i32(st0);
                if(i == (int32_t)0x80000000)
                {
                    // XXX: Probably not correct if st0 == 0x80000000
                    fpu_invalid_arithmetic();
                }
                safe_write32(addr, i);
            }
            break;
        case 3:
            // fistp
            {
                double_t st0 = fpu_integer_round(fpu_get_st0());
                int32_t i = convert_f64_to_i32(st0);
                if(i == (int32_t)0x80000000)
                {
                    // XXX: Probably not correct if st0 == 0x80000000
                    //      (input fits, but same value as error value)
                    fpu_invalid_arithmetic();
                }
                safe_write32(addr, i);
                fpu_pop();
            }
            break;
        case 5:
            // fld
            fpu_push(fpu_load_m80(addr));
            break;
        case 7:
            // fstp
            writable_or_pagefault(addr, 10);
            fpu_store_m80(addr, fpu_get_st0());
            fpu_pop();
            break;
        default:
            dbg_log("%x", mod);
            fpu_unimpl();
    }
}

void fpu_op_DC_reg(int32_t imm8)
{
    dbg_log_fpu_op(0xDC, imm8);

    int32_t mod = imm8 >> 3 & 7;
    int32_t low = imm8 & 7;
    int32_t low_ptr = *fpu_stack_ptr + low & 7;
    double_t sti = fpu_get_sti(low);
    double_t st0 = fpu_get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            fpu_st[low_ptr] = sti + st0;
            break;
        case 1:
            // fmul
            fpu_st[low_ptr] = sti * st0;
            break;
        case 2:
            // fcom
            fpu_fcom(sti);
            break;
        case 3:
            // fcomp
            fpu_fcom(sti);
            fpu_pop();
            break;
        case 4:
            // fsubr
            fpu_st[low_ptr] = st0 - sti;
            break;
        case 5:
            // fsub
            fpu_st[low_ptr] = sti - st0;
            break;
        case 6:
            // fdivr
            fpu_st[low_ptr] = st0 / sti;
            break;
        case 7:
            // fdiv
            fpu_st[low_ptr] = sti / st0;
            break;
        default:
            dbg_assert(false);
    }
}

void fpu_op_DC_mem(int32_t mod, int32_t addr)
{
    dbg_log_fpu_op(0xDC, mod);

    double_t m64 = fpu_load_m64(addr);
    double_t st0 = fpu_get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            fpu_st[*fpu_stack_ptr] = st0 + m64;
            break;
        case 1:
            // fmul
            fpu_st[*fpu_stack_ptr] = st0 * m64;
            break;
        case 2:
            // fcom
            fpu_fcom(m64);
            break;
        case 3:
            // fcomp
            fpu_fcom(m64);
            fpu_pop();
            break;
        case 4:
            // fsub
            fpu_st[*fpu_stack_ptr] = st0 - m64;
            break;
        case 5:
            // fsubr
            fpu_st[*fpu_stack_ptr] = m64 - st0;
            break;
        case 6:
            // fdiv
            fpu_st[*fpu_stack_ptr] = st0 / m64;
            break;
        case 7:
            // fdivr
            fpu_st[*fpu_stack_ptr] = m64 / st0;
            break;
        default:
            dbg_assert(false);
    }
}

void fpu_op_DD_reg(int32_t imm8)
{
    dbg_log_fpu_op(0xDD, imm8);

    int32_t mod = imm8 >> 3 & 7;
    int32_t low = imm8 & 7;

    switch(mod)
    {
        case 0:
            // ffree
            *fpu_stack_empty |= 1 << (*fpu_stack_ptr + low & 7);
            break;
        case 2:
            // fst
            fpu_st[*fpu_stack_ptr + low & 7] = fpu_get_st0();
            break;
        case 3:
            // fstp
            if(low == 0)
            {
                fpu_pop();
            }
            else
            {
                fpu_st[*fpu_stack_ptr + low & 7] = fpu_get_st0();
                fpu_pop();
            }
            break;
        case 4:
            fucom(fpu_get_sti(low));
            break;
        case 5:
            // fucomp
            fucom(fpu_get_sti(low));
            fpu_pop();
            break;
        default:
            dbg_log("%x", mod);
            fpu_unimpl();
    }
}

void fpu_op_DD_mem(int32_t mod, int32_t addr)
{
    dbg_log_fpu_op(0xDD, mod);

    switch(mod)
    {
        case 0:
            // fld
            {
                double_t data = fpu_load_m64(addr);
                fpu_push(data);
            }
            break;
        case 1:
            // fisttp
            dbg_log("dd/fisttp");
            fpu_unimpl();
            break;
        case 2:
            // fst
            fpu_store_m64(addr, 0);
            break;
        case 3:
            // fstp
            fpu_store_m64(addr, 0);
            fpu_pop();
            break;
        case 4:
            frstor(addr);
            break;
        case 5:
            // nothing
            dbg_log("dd/5");
            fpu_unimpl();
            break;
        case 6:
            // fsave
            fsave(addr);
            break;
        case 7:
            // fnstsw / store status word
            safe_write16(addr, fpu_load_status_word());
            break;
        default:
            dbg_assert(false);
    }
}


void fpu_op_DE_reg(int32_t imm8)
{
    dbg_log_fpu_op(0xDE, imm8);

    int32_t mod = imm8 >> 3 & 7;
    int32_t low = imm8 & 7;
    int32_t low_ptr = *fpu_stack_ptr + low & 7;
    double_t sti = fpu_get_sti(low);
    double_t st0 = fpu_get_st0();

    switch(mod)
    {
        case 0:
            // faddp
            fpu_st[low_ptr] = sti + st0;
            break;
        case 1:
            // fmulp
            fpu_st[low_ptr] = sti * st0;
            break;
        case 2:
            // fcomp
            fpu_fcom(sti);
            break;
        case 3:
            // fcompp
            if(low == 1)
            {
                fpu_fcom(fpu_st[low_ptr]);
                fpu_pop();
            }
            else
            {
                // not a valid encoding
                dbg_log("%x", mod);
                fpu_unimpl();
            }
            break;
        case 4:
            // fsubrp
            fpu_st[low_ptr] = st0 - sti;
            break;
        case 5:
            // fsubp
            fpu_st[low_ptr] = sti - st0;
            break;
        case 6:
            // fdivrp
            fpu_st[low_ptr] = st0 / sti;
            break;
        case 7:
            // fdivp
            fpu_st[low_ptr] = sti / st0;
            break;
        default:
            dbg_assert(false);
    }

    fpu_pop();
}

void fpu_op_DE_mem(int32_t mod, int32_t addr)
{
    dbg_log_fpu_op(0xDE, mod);

    int32_t m16 = safe_read16(addr) << 16 >> 16;
    double_t st0 = fpu_get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            fpu_st[*fpu_stack_ptr] = st0 + m16;
            break;
        case 1:
            // fmul
            fpu_st[*fpu_stack_ptr] = st0 * m16;
            break;
        case 2:
            // fcom
            fpu_fcom(m16);
            break;
        case 3:
            // fcomp
            fpu_fcom(m16);
            fpu_pop();
            break;
        case 4:
            // fsub
            fpu_st[*fpu_stack_ptr] = st0 - m16;
            break;
        case 5:
            // fsubr
            fpu_st[*fpu_stack_ptr] = m16 - st0;
            break;
        case 6:
            // fdiv
            fpu_st[*fpu_stack_ptr] = st0 / m16;
            break;
        case 7:
            // fdivr
            fpu_st[*fpu_stack_ptr] = m16 / st0;
            break;
        default:
            dbg_assert(false);
    }
}

void fpu_op_DF_reg(int32_t imm8)
{
    dbg_log_fpu_op(0xDF, imm8);

    int32_t mod = imm8 >> 3 & 7;
    int32_t low = imm8 & 7;

    switch(mod)
    {
        case 4:
            if(imm8 == 0xE0)
            {
                // fnstsw
                reg16[AX] = fpu_load_status_word();
            }
            else
            {
                dbg_log("%x", imm8);
                fpu_unimpl();
            }
            break;
        case 5:
            // fucomip
            fpu_fucomi(low);
            fpu_pop();
            break;
        case 6:
            // fcomip
            fpu_fcomi(low);
            fpu_pop();
            break;
        default:
            dbg_log("%x", mod);
            fpu_unimpl();
    }
}

void fpu_op_DF_mem(int32_t mod, int32_t addr)
{
    dbg_log_fpu_op(0xDF, mod);

    switch(mod)
    {
        case 0:
            {
                int32_t m16 = safe_read16(addr) << 16 >> 16;
                fpu_push(m16);
            }
            break;
        case 1:
            // fisttp
            dbg_log("df/fisttp");
            fpu_unimpl();
            break;
        case 2:
            // fist
            {
                double_t st0 = fpu_integer_round(fpu_get_st0());
                if(st0 <= 0x7FFF && st0 >= -0x8000)
                {
                    safe_write16(addr, st0);
                }
                else
                {
                    fpu_invalid_arithmetic();
                    safe_write16(addr, 0x8000);
                }
            }
            break;
        case 3:
            // fistp
            {
                double_t st0 = fpu_integer_round(fpu_get_st0());
                if(st0 <= 0x7FFF && st0 >= -0x8000)
                {
                    safe_write16(addr, st0);
                }
                else
                {
                    fpu_invalid_arithmetic();
                    safe_write16(addr, 0x8000);
                }
                fpu_pop();
            }
            break;
        case 4:
            // fbld
            dbg_log("fbld");
            fpu_unimpl();
            break;
        case 5:
            // fild
            // XXX: Use safe_read64s
            {
                uint32_t low = safe_read32s(addr);
                int32_t high = safe_read32s(addr + 4);

                double_t m64 = (double_t)low + 0x100000000 * (double_t)high;

                fpu_push(m64);
            }
            break;
        case 6:
            // fbstp
            dbg_log("fbstp");
            fpu_unimpl();
            break;
        case 7:
            {
                // fistp
                writable_or_pagefault(addr, 8);

                double_t st0 = fpu_integer_round(fpu_get_st0());

                //union f64_int v = { .f64 = st0 };
                //dbg_log("fistp %x %x", v.i32[0], v.i32[1]);

                int32_t st0_low;
                int32_t st0_high;

                if(st0 < TWO_POW_63 && st0 >= -TWO_POW_63)
                {
                    int64_t st0_int = st0;
                    st0_low = st0_int;
                    st0_high = st0_int >> 32;
                }
                else
                {
                    // write 0x8000000000000000
                    st0_low  = 0;
                    st0_high = 0x80000000;
                    fpu_invalid_arithmetic();
                }

                // XXX: Use safe_write64
                safe_write32(addr, st0_low);
                safe_write32(addr + 4, st0_high);

                fpu_pop();
            }
            break;
        default:
            dbg_assert(false);
    }
}
