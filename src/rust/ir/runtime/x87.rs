//! Audited x87 register helper with scalar CPU state continuation.
//!
//! Register-only D8-DF forms have no guest-memory access. The helper first
//! applies the architectural CR0.EM/TS guard, then synchronizes/discards the
//! f64 x87 shadow cache so the canonical F80 CPU state is authoritative. It
//! dispatches the same instruction bodies as the interpreter. Invalid nested
//! encodings are rejected before calling those bodies so a delivered #UD can
//! never be followed by an instruction commit.
use crate::{
    cpu::{cpu, fpu, global_pointers as gp, instructions},
    ir::helper::Outcome,
};

unsafe fn commit() -> u32 {
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}

unsafe fn ud() -> u32 {
    cpu::trigger_ud();
    Outcome::ControlTransferred as u32
}

fn valid(opcode: u32, group: u32, r: u32) -> bool {
    crate::ir::x87::valid_register(opcode as u8, group as u8, r as u8)
}
#[allow(dead_code)]
fn valid_reference(opcode: u32, group: u32, r: u32) -> bool {
    match opcode {
        0xD8 | 0xDC => true,
        0xD9 => match group {
            0 | 1 | 3 | 6 | 7 => true,
            2 => r == 0,
            4 => matches!(r, 0 | 1 | 4 | 5),
            5 => r <= 6,
            _ => false,
        },
        0xDA => match group {
            0..=3 => true,
            5 => r == 1,
            _ => false,
        },
        0xDB => match group {
            0..=3 | 5 | 6 => true,
            4 => r <= 4,
            _ => false,
        },
        0xDD => group <= 5,
        0xDE => group != 3 || r == 1,
        0xDF => match group {
            0..=3 | 5 | 6 => true,
            4 => r == 0,
            _ => false,
        },
        _ => false,
    }
}

/// Shared register instruction bodies after the guard and nested #UD checks.
unsafe fn register_semantics(opcode: u32, group: u32, r: u32) {
    let r = r as i32;
    match (opcode, group) {
        (0xD8, 0) => instructions::instr_D8_0_reg(r),
        (0xD8, 1) => instructions::instr_D8_1_reg(r),
        (0xD8, 2) => instructions::instr_D8_2_reg(r),
        (0xD8, 3) => instructions::instr_D8_3_reg(r),
        (0xD8, 4) => instructions::instr_D8_4_reg(r),
        (0xD8, 5) => instructions::instr_D8_5_reg(r),
        (0xD8, 6) => instructions::instr_D8_6_reg(r),
        (0xD8, 7) => instructions::instr_D8_7_reg(r),

        (0xD9, 0) => instructions::instr16_D9_0_reg(r),
        (0xD9, 1) => instructions::instr16_D9_1_reg(r),
        (0xD9, 2) => instructions::instr16_D9_2_reg(r),
        (0xD9, 3) => instructions::instr16_D9_3_reg(r),
        (0xD9, 4) => instructions::instr16_D9_4_reg(r),
        (0xD9, 5) => instructions::instr16_D9_5_reg(r),
        (0xD9, 6) => instructions::instr16_D9_6_reg(r),
        (0xD9, 7) => instructions::instr16_D9_7_reg(r),

        (0xDA, 0) => instructions::instr_DA_0_reg(r),
        (0xDA, 1) => instructions::instr_DA_1_reg(r),
        (0xDA, 2) => instructions::instr_DA_2_reg(r),
        (0xDA, 3) => instructions::instr_DA_3_reg(r),
        (0xDA, 5) => instructions::instr_DA_5_reg(r),

        (0xDB, 0) => instructions::instr_DB_0_reg(r),
        (0xDB, 1) => instructions::instr_DB_1_reg(r),
        (0xDB, 2) => instructions::instr_DB_2_reg(r),
        (0xDB, 3) => instructions::instr_DB_3_reg(r),
        (0xDB, 4) => instructions::instr_DB_4_reg(r),
        (0xDB, 5) => instructions::instr_DB_5_reg(r),
        (0xDB, 6) => instructions::instr_DB_6_reg(r),

        (0xDC, 0) => instructions::instr_DC_0_reg(r),
        (0xDC, 1) => instructions::instr_DC_1_reg(r),
        (0xDC, 2) => instructions::instr_DC_2_reg(r),
        (0xDC, 3) => instructions::instr_DC_3_reg(r),
        (0xDC, 4) => instructions::instr_DC_4_reg(r),
        (0xDC, 5) => instructions::instr_DC_5_reg(r),
        (0xDC, 6) => instructions::instr_DC_6_reg(r),
        (0xDC, 7) => instructions::instr_DC_7_reg(r),

        (0xDD, 0) => instructions::instr16_DD_0_reg(r),
        (0xDD, 1) => instructions::instr16_DD_1_reg(r),
        (0xDD, 2) => instructions::instr16_DD_2_reg(r),
        (0xDD, 3) => instructions::instr16_DD_3_reg(r),
        (0xDD, 4) => instructions::instr16_DD_4_reg(r),
        (0xDD, 5) => instructions::instr16_DD_5_reg(r),

        (0xDE, 0) => instructions::instr_DE_0_reg(r),
        (0xDE, 1) => instructions::instr_DE_1_reg(r),
        (0xDE, 2) => instructions::instr_DE_2_reg(r),
        (0xDE, 3) => instructions::instr_DE_3_reg(r),
        (0xDE, 4) => instructions::instr_DE_4_reg(r),
        (0xDE, 5) => instructions::instr_DE_5_reg(r),
        (0xDE, 6) => instructions::instr_DE_6_reg(r),
        (0xDE, 7) => instructions::instr_DE_7_reg(r),

        (0xDF, 0) => instructions::instr_DF_0_reg(r),
        (0xDF, 1) => instructions::instr_DF_1_reg(r),
        (0xDF, 2) => instructions::instr_DF_2_reg(r),
        (0xDF, 3) => instructions::instr_DF_3_reg(r),
        (0xDF, 4) => instructions::instr_DF_4_reg(r),
        (0xDF, 5) => instructions::instr_DF_5_reg(r),
        (0xDF, 6) => instructions::instr_DF_6_reg(r),
        _ => unreachable!("validated x87 register dispatch"),
    }
}

#[no_mangle]
pub unsafe fn ir_x87_reg_continue(opcode: u32, group: u32, r: u32, operand_size: u32) -> u32 {
    assert!((0xD8..=0xDF).contains(&opcode));
    assert!(group < 8 && r < 8 && matches!(operand_size, 16 | 32));

    // x87 (unlike SSE/MMX) raises #NM for either CR0.EM or CR0.TS.
    if !cpu::task_switch_test() {
        return Outcome::ControlTransferred as u32;
    }

    // Compiled code may have left exact-enough f64 shadow values live. IR x87
    // always executes against canonical F80 state; synchronize only after the
    // task-switch guard so a faulting instruction does not observe/mutate FPU
    // state before #NM.
    fpu::fpu_cache_barrier();

    if !valid(opcode, group, r) {
        return ud();
    }

    register_semantics(opcode, group, r);
    // Register semantics cannot observe host/guest memory or change execution
    // context. F80 remains CPU-owned; CpuReload makes FNSTSW AX and FCOMI's
    // architectural outputs available to following SSA without retiring here.
    Outcome::Normal as u32
}

#[no_mangle]
pub unsafe fn ir_x87_reg(opcode: u32, group: u32, r: u32, operand_size: u32) -> u32 {
    let outcome = ir_x87_reg_continue(opcode, group, r, operand_size);
    if outcome == Outcome::Normal as u32 {
        commit()
    }
    else {
        outcome
    }
}

#[cfg(feature = "ir-test-hooks")]
#[no_mangle]
pub unsafe fn ir_test_x87_seed() {
    use crate::softfloat::F80;

    fpu::fpu_discard_cache();
    F80::clear_exception_flags();
    fpu::fpu_finit();
    *gp::fpu_stack_ptr = 0;
    *gp::fpu_stack_empty = 0;
    *gp::fpu_status_word = 0;
    for index in 0..8 {
        fpu::fpu_write_st(index, F80::of_i32(index + 1));
    }
}

/// Memory x87 stays in canonical F80 state. A successful data access is required
/// before committing the instruction; fault delivery is owned by safe_*.
#[no_mangle]
pub unsafe fn ir_x87_mem(opcode: u32, group: u32, offset: u32, segment: u32, width: u32) -> u32 {
    assert!(
        (0xD8..=0xDF).contains(&opcode) && group < 8 && segment < 6 && matches!(width, 16 | 32)
    );
    if !cpu::task_switch_test() {
        return Outcome::ControlTransferred as u32;
    }
    let Ok(base) = cpu::get_seg(segment as i32)
    else {
        return Outcome::ControlTransferred as u32;
    };
    let address = offset.wrapping_add(base as u32) as i32;
    fpu::fpu_cache_barrier();
    if matches!((opcode, group), (0xD9, 1) | (0xDB, 4 | 6) | (0xDD, 5)) {
        return ud();
    }
    // These are explicitly unsupported in the pinned CPU, including its debug
    // assertion. Preserve that baseline behavior rather than invent new ISA.
    if opcode == 0xDF && group == 4 || opcode == 0xDD && matches!(group, 4 | 6) && width == 16 {
        fpu::fpu_unimpl();
        return Outcome::ControlTransferred as u32;
    }
    if memory_semantics(opcode, group, address, width).is_err() {
        Outcome::ControlTransferred as u32
    }
    else {
        commit()
    }
}

unsafe fn memory_semantics(opcode: u32, group: u32, address: i32, width: u32) -> Result<(), ()> {
    use crate::cpu::fpu::*;
    if matches!(opcode, 0xD8 | 0xDA | 0xDC | 0xDE) {
        let value = match opcode {
            0xD8 => fpu_load_m32(address)?,
            0xDA => fpu_load_i32(address)?,
            0xDC => fpu_load_m64(address)?,
            0xDE => fpu_load_i16(address)?,
            _ => unreachable!(),
        };
        match group {
            0 => fpu_fadd(0, value),
            1 => fpu_fmul(0, value),
            2 => fpu_fcom(value),
            3 => fpu_fcomp(value),
            4 => fpu_fsub(0, value),
            5 => fpu_fsubr(0, value),
            6 => fpu_fdiv(0, value),
            7 => fpu_fdivr(0, value),
            _ => unreachable!(),
        }
        return Ok(());
    }
    match (opcode, group) {
        (0xD9, 0) => {
            crate::softfloat::F80::clear_exception_flags();
            fpu_push_m32_bits(cpu::safe_read32s(address)?);
        },
        (0xDD, 0) => {
            crate::softfloat::F80::clear_exception_flags();
            fpu_push_m64_bits(cpu::safe_read64s(address)?);
        },
        (0xDB, 0) => fpu_push(fpu_load_i32(address)?),
        (0xDF, 0) => fpu_push(fpu_load_i16(address)?),
        (0xDF, 5) => fpu_push(fpu_load_i64(address)?),
        (0xDB, 5) => {
            cpu::readable_or_pagefault(address, 10)?;
            fpu_push(fpu_load_m80(address)?);
        },
        (0xD9, 2 | 3) => {
            fpu_store_m32(address, fpu_get_st0())?;
            if group == 3 {
                fpu_pop();
            }
        },
        (0xDD, 2 | 3) => {
            fpu_store_m64(address, fpu_get_st0())?;
            if group == 3 {
                fpu_pop();
            }
        },
        (0xDB, 7) => {
            cpu::writable_or_pagefault(address, 10)?;
            fpu_store_m80(address, fpu_get_st0());
            fpu_pop();
        },
        (0xDB | 0xDF, 1..=3) | (0xDD, 1) | (0xDF, 7) => {
            let bytes = match opcode {
                0xDB => 4,
                0xDD => 8,
                _ if group == 7 => 8,
                _ => 2,
            };
            cpu::writable_or_pagefault(address, bytes)?;
            let value = fpu_get_st0();
            match bytes {
                2 => {
                    let v = if group == 1 {
                        fpu_truncate_to_i16(value)
                    }
                    else {
                        fpu_convert_to_i16(value)
                    };
                    cpu::safe_write16(address, v as i32 & 65535).unwrap();
                },
                4 => {
                    let v = if group == 1 {
                        fpu_truncate_to_i32(value)
                    }
                    else {
                        fpu_convert_to_i32(value)
                    };
                    cpu::safe_write32(address, v).unwrap();
                },
                8 => {
                    let v = if group == 1 {
                        fpu_truncate_to_i64(value)
                    }
                    else {
                        fpu_convert_to_i64(value)
                    };
                    cpu::safe_write64(address, v as u64).unwrap();
                },
                _ => unreachable!(),
            }
            if group != 2 {
                fpu_pop();
            }
        },
        (0xD9, 4) => {
            cpu::readable_or_pagefault(address, if width == 16 { 14 } else { 28 })?;
            if width == 16 {
                fpu_fldenv16(address);
            }
            else {
                fpu_fldenv32(address);
            }
        },
        (0xD9, 5) => set_control_word(cpu::safe_read16(address)? as u16),
        (0xD9, 6) => {
            cpu::writable_or_pagefault(address, if width == 16 { 14 } else { 28 })?;
            if width == 16 {
                fpu_fstenv16(address);
            }
            else {
                fpu_fstenv32(address);
            }
        },
        (0xD9, 7) => cpu::safe_write16(address, (*gp::fpu_control_word).into())?,
        (0xDD, 4) => fpu_frstor32_checked(address)?,
        (0xDD, 6) => fpu_fsave32_checked(address)?,
        (0xDD, 7) => cpu::safe_write16(address, fpu_load_status_word().into())?,
        (0xDF, 6) => {
            cpu::writable_or_pagefault(address, 10)?;
            fpu_fbstp(address);
        },
        _ => unreachable!(),
    }
    Ok(())
}

/// Exact F80 special values and mode setup, isolated from production exports.
#[cfg(feature = "ir-test-hooks")]
#[no_mangle]
pub unsafe fn ir_test_x87_pattern(sample: u32, control: u32) {
    use crate::softfloat::F80;
    const VALUES: [(u64, u16); 12] = [
        (0, 0),
        (0, 0x8000),
        (1, 0),
        (0x7FFFFFFFFFFFFFFF, 0),
        (0x8000000000000000, 1),
        (u64::MAX, 0x7FFE),
        (0x8000000000000000, 0x7FFF),
        (0x8000000000000000, 0xFFFF),
        (0xC000000000012345, 0x7FFF),
        (0x8000000000054321, 0xFFFF),
        (0xA000000000000000, 0x4000),
        (0xA000000000000000, 0xC000),
    ];
    assert!(sample < 12 && control <= 65535);
    ir_test_x87_seed();
    fpu::set_control_word(control as u16);
    for i in 0..8 {
        let (mantissa, sign_exponent) = VALUES[(sample as usize + i) % VALUES.len()];
        fpu::fpu_write_st(
            i as i32,
            F80 {
                mantissa,
                sign_exponent,
            },
        );
    }
}

/// #NM guard of continuing x87 forms, called only when CR0.EM or CR0.TS is set.
#[no_mangle]
pub unsafe fn ir_fpu_guard() -> u32 {
    if cpu::task_switch_test() {
        0
    }
    else {
        2
    }
}

/// Canonical (non-inlined) semantics of one continuing x87 form after its #NM
/// guard: operands arrive already loaded and stores leave through the returned
/// (high << 32 | low) word after a successful write preflight. Mirrors the
/// interpreter's instruction bodies, including the shared f64 shadow cache.
#[no_mangle]
pub unsafe fn ir_x87_op(opcode: u32, modrm: u32, low: u32, high: u32) -> u64 {
    let (opcode, modrm) = (opcode as u8, modrm as u8);
    // The next execution of the inlined form finds exact operands mirrored.
    crate::cpu::fpu::fpu_mirror_exact_slots();
    let io = crate::ir::x87::io(opcode, modrm).expect("continuing x87 form");
    x87_semantics(opcode, modrm, io, low, high)
}
/// ir_x87_op for the x64 page tier's functions (IR Tier-0's until P7.5
/// deleted it, ir_t0_x87), which never inline f64 forms (no mirroring) and
/// classify at compile time: `form` is opcode | modrm << 8 | kind << 16 (0
/// stack, 1 load, 2 store; the transfer width is implied).
#[no_mangle]
pub unsafe fn x64_x87(form: u32, low: u32, high: u32) -> u64 {
    use crate::ir::x87::Io;
    let (opcode, modrm) = (form as u8, (form >> 8) as u8);
    let io = match form >> 16 {
        0 => Io::Stack,
        1 => Io::Load { bytes: 0 },
        _ => Io::Store { bytes: 0 },
    };
    x87_semantics(opcode, modrm, io, low, high)
}
#[inline(always)]
unsafe fn x87_semantics(opcode: u8, modrm: u8, io: crate::ir::x87::Io, low: u32, high: u32) -> u64 {
    use crate::{cpu::fpu::*, ir::x87::Io, softfloat::F80};
    let group = modrm >> 3 & 7;
    let wide = (high as u64) << 32 | low as u64;
    match io {
        Io::Stack => register_semantics(opcode.into(), group.into(), (modrm & 7).into()),
        Io::Load { .. } => {
            let value = match opcode {
                0xD8 => f32_to_f80(low as i32),
                0xDA => i32_to_f80(low as i32),
                0xDC => f64_to_f80(wide),
                0xDE => i32_to_f80(low as i16 as i32),
                _ => {
                    match (opcode, group) {
                        (0xD9, 0) => {
                            F80::clear_exception_flags();
                            fpu_push_m32_bits(low as i32);
                        },
                        (0xDD, 0) => {
                            F80::clear_exception_flags();
                            fpu_push_m64_bits(wide);
                        },
                        (0xDB, 0) => fpu_push(i32_to_f80(low as i32)),
                        (0xDF, 0) => fpu_push(i32_to_f80(low as i16 as i32)),
                        (0xDF, 5) => fpu_push(i64_to_f80(wide as i64)),
                        (0xD9, 5) => set_control_word(low as u16),
                        _ => unreachable!(),
                    }
                    return 0;
                },
            };
            match group {
                0 => fpu_fadd(0, value),
                1 => fpu_fmul(0, value),
                2 => fpu_fcom(value),
                3 => fpu_fcomp(value),
                4 => fpu_fsub(0, value),
                5 => fpu_fsubr(0, value),
                6 => fpu_fdiv(0, value),
                7 => fpu_fdivr(0, value),
                _ => unreachable!(),
            }
        },
        Io::Store { .. } => {
            let bits = match (opcode, group) {
                (0xD9, 7) => (*gp::fpu_control_word).into(),
                (0xDD, 7) => fpu_load_status_word().into(),
                (0xD9, 2 | 3) => {
                    let value = fpu_get_st0();
                    F80::clear_exception_flags();
                    let bits = value.to_f32() as u32 as u64;
                    *gp::fpu_status_word |= F80::get_exception_flags() as u16;
                    bits
                },
                (0xDD, 2 | 3) => {
                    if let Some(value) = fpu_cached_st0() {
                        F80::clear_exception_flags();
                        value
                    }
                    else {
                        let value = fpu_get_st0();
                        F80::clear_exception_flags();
                        let bits = value.to_f64();
                        *gp::fpu_status_word |= F80::get_exception_flags() as u16;
                        bits
                    }
                },
                (0xDB, _) => {
                    let value = fpu_get_st0();
                    (if group == 1 {
                        fpu_truncate_to_i32(value)
                    }
                    else {
                        fpu_convert_to_i32(value)
                    }) as u32 as u64
                },
                (0xDD, 1) => fpu_truncate_to_i64(fpu_get_st0()) as u64,
                (0xDF, 7) => fpu_convert_to_i64(fpu_get_st0()) as u64,
                (0xDF, _) => {
                    let value = fpu_get_st0();
                    (if group == 1 {
                        fpu_truncate_to_i16(value)
                    }
                    else {
                        fpu_convert_to_i16(value)
                    }) as u16 as u64
                },
                _ => unreachable!(),
            };
            let pops = match (opcode, group) {
                (0xD9 | 0xDD, 7) => false,
                (0xD9 | 0xDD, 2) | (0xDB | 0xDF, 2) => false,
                _ => true,
            };
            if pops {
                fpu_pop();
            }
            return bits;
        },
    }
    0
}
