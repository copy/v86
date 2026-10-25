//! Long-mode SIMD/x87 front end. Addressing and register banks stay wide;
//! packed integer semantics are shared with the legacy interpreter. Floating
//! arithmetic uses SoftFloat with per-instruction MXCSR exception commit.
use super::{
    decode::Decoded,
    execute::address,
    memory::{self, Fault},
    state,
};
use crate::cpu::{
    avx, cpu, fpu, global_pointers as gp, instructions_0f as sem, instructions_0f38 as sem38,
    instructions_0f3a as sem3a, simd_fp, simd_int, xstate,
};
use crate::softfloat::F80;

extern "C" {
    fn extF80M_to_i32(a: *const F80, rounding: u8, exact: bool) -> i32;
    fn extF80M_to_i64(a: *const F80, rounding: u8, exact: bool) -> i64;
    fn extF80M_to_f32(a: *const F80) -> i32;
    fn extF80M_to_f64(a: *const F80) -> u64;
    static mut softfloat_roundingMode: u8;
    static mut softfloat_exceptionFlags: u8;
}
fn fault(vector: u8) -> Fault {
    Fault {
        vector,
        error: None,
        address: None,
    }
}
unsafe fn guard(sse: bool) -> Result<(), Fault> {
    if state::read_cr(0) & 4 != 0 || sse && state::read_cr(4) & 0x200 == 0 {
        return Err(Fault::ud());
    }
    if state::read_cr(0) & 8 != 0 {
        return Err(fault(7));
    }
    Ok(())
}
unsafe fn xmm(r: u8) -> u128 { std::mem::transmute(state::read_xmm(r as usize)) }
unsafe fn put_xmm(r: u8, v: u128) { state::write_xmm(r as usize, std::mem::transmute(v)); }
fn alignment(a: u64, stack: bool, align: u64) -> Result<(), Fault> {
    if !state::canonical(a, 48) {
        return Err(Fault {
            vector: if stack { 12 } else { 13 },
            error: Some(0),
            address: None,
        });
    }
    if a & (align - 1) != 0 {
        return Err(Fault::gp());
    }
    Ok(())
}
unsafe fn source(d: &Decoded, width: u8, aligned: bool, mmx: bool) -> Result<u128, Fault> {
    if let Some(r) = d.rm_register {
        return Ok(if mmx { cpu::read_mmx64s((r & 7) as i32) as u128 } else { xmm(r) });
    }
    let (a, stack) = address(d);
    if aligned {
        alignment(a, stack, 16)?;
    }
    if width == 128 {
        memory::read128(a, stack)
    }
    else {
        memory::read(a, width, stack).map(|v| v as u128)
    }
}
unsafe fn store(
    d: &Decoded,
    width: u8,
    value: u128,
    aligned: bool,
    mmx: bool,
) -> Result<(), Fault> {
    if let Some(r) = d.rm_register {
        if mmx {
            cpu::write_mmx_reg64((r & 7) as i32, value as u64);
        }
        else {
            put_xmm(r, value);
        }
        return Ok(());
    }
    let (a, stack) = address(d);
    if aligned {
        alignment(a, stack, 16)?;
    }
    if width == 128 {
        memory::write128(a, value, stack)
    }
    else {
        memory::write(a, width, value as u64, stack)
    }
}
unsafe fn gpr_source(d: &Decoded, width: u8) -> Result<u64, Fault> {
    if let Some(r) = d.rm_register {
        Ok(state::read_gpr(r as usize))
    }
    else {
        let (a, s) = address(d);
        memory::read(a, width, s)
    }
}
unsafe fn gpr_store(d: &Decoded, width: u8, v: u64) -> Result<(), Fault> {
    if let Some(r) = d.rm_register {
        state::write_gpr(r as usize, v, width);
        Ok(())
    }
    else {
        let (a, s) = address(d);
        memory::write(a, width, v, s)
    }
}
/// An unmasked SIMD floating-point exception: #XM, or #UD without CR4.OSXMMEXCPT
unsafe fn simd_fault(_: simd_fp::Unmasked) -> Fault {
    fault(if state::read_cr(4) & 0x400 != 0 { 19 } else { 6 })
}
unsafe fn arithmetic(d: &Decoded) -> Result<bool, Fault> {
    let op = d.base_opcode() as u8;
    if !matches!(
        op,
        0x51 | 0x58 | 0x59 | 0x5C..=0x5F | 0xC2 | 0x2E | 0x2F | 0x7C | 0x7D | 0xD0
    ) {
        return Ok(false);
    }
    let prefix = d.opcode >> 16;
    if matches!(op, 0x7C | 0x7D | 0xD0) && !matches!(prefix, 0x66 | 0xF2) {
        return Ok(false);
    }
    if matches!(op, 0x2E | 0x2F) && !matches!(prefix, 0 | 0x66) {
        return Ok(false);
    }
    guard(true)?;
    let scalar = matches!(prefix, 0xF2 | 0xF3) && !matches!(op, 0x7C | 0x7D | 0xD0)
        || matches!(op, 0x2E | 0x2F);
    let double = matches!(prefix, 0x66 | 0xF2) && !matches!(op, 0x7C | 0x7D | 0xD0)
        || matches!(op, 0x7C | 0x7D | 0xD0) && prefix == 0x66;
    let width = if double { 64 } else { 32 };
    let src = source(d, if scalar { width } else { 128 }, !scalar, false)?;
    let r = d.reg.unwrap();
    if matches!(op, 0x2E | 0x2F) {
        let flags = simd_fp::compare_flags(d.opcode, xmm(r), src).map_err(|e| simd_fault(e))?;
        state::write_flags64(state::read_flags64() & !0x8D5 | flags as u64);
        return Ok(true);
    }
    let imm8 = d.immediate.map_or(0, |i| i.value as u8);
    let result = simd_fp::arithmetic(d.opcode, xmm(r), src, imm8).map_err(|e| simd_fault(e))?;
    put_xmm(r, result);
    Ok(true)
}

unsafe fn conversion(d: &Decoded) -> Result<bool, Fault> {
    let op = d.opcode;
    let p = op >> 16;
    let low = op as u8;
    if !matches!(
        op,
        0x0F2A
            | 0x660F2A
            | 0xF20F2A
            | 0xF30F2A
            | 0x0F2C
            | 0x660F2C
            | 0xF20F2C
            | 0xF30F2C
            | 0x0F2D
            | 0x660F2D
            | 0xF20F2D
            | 0xF30F2D
            | 0x0F5A
            | 0x660F5A
            | 0xF20F5A
            | 0xF30F5A
            | 0x0F5B
            | 0x660F5B
            | 0xF30F5B
            | 0x660FE6
            | 0xF20FE6
            | 0xF30FE6
    ) {
        return Ok(false);
    }
    guard(true)?;
    let r = d.reg.unwrap();
    let wide = d.prefixes.w();
    let scalar = matches!(p, 0xF2 | 0xF3) && matches!(low, 0x2A | 0x2C | 0x2D | 0x5A);
    let size = if scalar {
        if p == 0xF2 {
            64
        }
        else {
            32
        }
    }
    else if matches!(op, 0x0F2A | 0x660F2A | 0x0F2C | 0x0F2D | 0x0F5A | 0xF30FE6) {
        64
    }
    else {
        128
    };
    let src = if low == 0x2A && scalar {
        gpr_source(d, if wide { 64 } else { 32 })? as u128
    }
    else {
        source(d, size, size == 128, low == 0x2A)?
    };
    let result = simd_fp::convert(op, wide, xmm(r), src).map_err(|e| simd_fault(e))?;
    if matches!(low, 0x2C | 0x2D) {
        if scalar {
            state::write_gpr(r as usize, result as u64, if wide { 64 } else { 32 });
        }
        else {
            cpu::write_mmx_reg64((r & 7) as i32, result as u64);
            cpu::transition_fpu_to_mmx();
        }
        return Ok(true);
    }
    put_xmm(r, result);
    // (CVTPI2PS/CVTPI2PD: only from an MMX register, not from memory)
    if low == 0x2A && !scalar && d.rm_register.is_some() {
        cpu::transition_fpu_to_mmx();
    }
    Ok(true)
}

unsafe fn packed_arithmetic(d: &Decoded) -> Result<bool, Fault> {
    let r = d.reg.unwrap_or(0);
    let imm = d.immediate.map_or(0, |i| i.value as i32);
    match d.opcode {
        0x0F54 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_0F54(std::mem::transmute(v), r as i32);
        },
        0x660F54 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F54(std::mem::transmute(v), r as i32);
        },
        0x0F55 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_0F55(std::mem::transmute(v), r as i32);
        },
        0x660F55 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F55(std::mem::transmute(v), r as i32);
        },
        0x0F56 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_0F56(std::mem::transmute(v), r as i32);
        },
        0x660F56 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F56(std::mem::transmute(v), r as i32);
        },
        0x0F57 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_0F57(std::mem::transmute(v), r as i32);
        },
        0x660F57 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F57(std::mem::transmute(v), r as i32);
        },
        0x0F60 => {
            guard(false)?;
            let v = source(d, 32, false, true)?;
            sem::instr_0F60(v as i32, (r & 7) as i32);
        },
        0x660F60 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F60(std::mem::transmute(v), r as i32);
        },
        0x0F61 => {
            guard(false)?;
            let v = source(d, 32, false, true)?;
            sem::instr_0F61(v as i32, (r & 7) as i32);
        },
        0x660F61 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F61(std::mem::transmute(v), r as i32);
        },
        0x0F62 => {
            guard(false)?;
            let v = source(d, 32, false, true)?;
            sem::instr_0F62(v as i32, (r & 7) as i32);
        },
        0x660F62 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F62(std::mem::transmute(v), r as i32);
        },
        0x0F63 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0F63(v as u64, (r & 7) as i32);
        },
        0x660F63 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F63(std::mem::transmute(v), r as i32);
        },
        0x0F64 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0F64(v as u64, (r & 7) as i32);
        },
        0x660F64 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F64(std::mem::transmute(v), r as i32);
        },
        0x0F65 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0F65(v as u64, (r & 7) as i32);
        },
        0x660F65 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F65(std::mem::transmute(v), r as i32);
        },
        0x0F66 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0F66(v as u64, (r & 7) as i32);
        },
        0x660F66 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F66(std::mem::transmute(v), r as i32);
        },
        0x0F67 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0F67(v as u64, (r & 7) as i32);
        },
        0x660F67 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F67(std::mem::transmute(v), r as i32);
        },
        0x0F68 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0F68(v as u64, (r & 7) as i32);
        },
        0x660F68 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F68(std::mem::transmute(v), r as i32);
        },
        0x0F69 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0F69(v as u64, (r & 7) as i32);
        },
        0x660F69 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F69(std::mem::transmute(v), r as i32);
        },
        0x0F6A => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0F6A(v as u64, (r & 7) as i32);
        },
        0x660F6A => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F6A(std::mem::transmute(v), r as i32);
        },
        0x0F6B => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0F6B(v as u64, (r & 7) as i32);
        },
        0x660F6B => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F6B(std::mem::transmute(v), r as i32);
        },
        0x660F6C => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F6C(std::mem::transmute(v), r as i32);
        },
        0x660F6D => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F6D(std::mem::transmute(v), r as i32);
        },
        0x0F70 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0F70(v as u64, (r & 7) as i32, imm);
        },
        0x660F70 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F70(std::mem::transmute(v), r as i32, imm);
        },
        0xF20F70 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_F20F70(std::mem::transmute(v), r as i32, imm);
        },
        0xF30F70 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_F30F70(std::mem::transmute(v), r as i32, imm);
        },
        0x0F74 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0F74(v as u64, (r & 7) as i32);
        },
        0x660F74 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F74(std::mem::transmute(v), r as i32);
        },
        0x0F75 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0F75(v as u64, (r & 7) as i32);
        },
        0x660F75 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F75(std::mem::transmute(v), r as i32);
        },
        0x0F76 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0F76(v as u64, (r & 7) as i32);
        },
        0x660F76 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660F76(std::mem::transmute(v), r as i32);
        },
        0x0FC6 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_0FC6(std::mem::transmute(v), r as i32, imm);
        },
        0x660FC6 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FC6(std::mem::transmute(v), r as i32, imm);
        },
        0x0FD1 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FD1(v as u64, (r & 7) as i32);
        },
        0x660FD1 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FD1(std::mem::transmute(v), r as i32);
        },
        0x0FD2 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FD2(v as u64, (r & 7) as i32);
        },
        0x660FD2 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FD2(std::mem::transmute(v), r as i32);
        },
        0x0FD3 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FD3(v as u64, (r & 7) as i32);
        },
        0x660FD3 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FD3(std::mem::transmute(v), r as i32);
        },
        0x0FD4 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FD4(v as u64, (r & 7) as i32);
        },
        0x660FD4 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FD4(std::mem::transmute(v), r as i32);
        },
        0x0FD5 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FD5(v as u64, (r & 7) as i32);
        },
        0x660FD5 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FD5(std::mem::transmute(v), r as i32);
        },
        0x0FD8 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FD8(v as u64, (r & 7) as i32);
        },
        0x660FD8 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FD8(std::mem::transmute(v), r as i32);
        },
        0x0FD9 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FD9(v as u64, (r & 7) as i32);
        },
        0x660FD9 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FD9(std::mem::transmute(v), r as i32);
        },
        0x0FDA => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FDA(v as u64, (r & 7) as i32);
        },
        0x660FDA => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FDA(std::mem::transmute(v), r as i32);
        },
        0x0FDB => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FDB(v as u64, (r & 7) as i32);
        },
        0x660FDB => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FDB(std::mem::transmute(v), r as i32);
        },
        0x0FDC => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FDC(v as u64, (r & 7) as i32);
        },
        0x660FDC => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FDC(std::mem::transmute(v), r as i32);
        },
        0x0FDD => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FDD(v as u64, (r & 7) as i32);
        },
        0x660FDD => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FDD(std::mem::transmute(v), r as i32);
        },
        0x0FDE => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FDE(v as u64, (r & 7) as i32);
        },
        0x660FDE => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FDE(std::mem::transmute(v), r as i32);
        },
        0x0FDF => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FDF(v as u64, (r & 7) as i32);
        },
        0x660FDF => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FDF(std::mem::transmute(v), r as i32);
        },
        0x0FE0 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FE0(v as u64, (r & 7) as i32);
        },
        0x660FE0 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FE0(std::mem::transmute(v), r as i32);
        },
        0x0FE1 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FE1(v as u64, (r & 7) as i32);
        },
        0x660FE1 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FE1(std::mem::transmute(v), r as i32);
        },
        0x0FE2 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FE2(v as u64, (r & 7) as i32);
        },
        0x660FE2 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FE2(std::mem::transmute(v), r as i32);
        },
        0x0FE3 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FE3(v as u64, (r & 7) as i32);
        },
        0x660FE3 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FE3(std::mem::transmute(v), r as i32);
        },
        0x0FE4 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FE4(v as u64, (r & 7) as i32);
        },
        0x660FE4 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FE4(std::mem::transmute(v), r as i32);
        },
        0x0FE5 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FE5(v as u64, (r & 7) as i32);
        },
        0x660FE5 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FE5(std::mem::transmute(v), r as i32);
        },
        0x0FE8 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FE8(v as u64, (r & 7) as i32);
        },
        0x660FE8 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FE8(std::mem::transmute(v), r as i32);
        },
        0x0FE9 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FE9(v as u64, (r & 7) as i32);
        },
        0x660FE9 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FE9(std::mem::transmute(v), r as i32);
        },
        0x0FEA => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FEA(v as u64, (r & 7) as i32);
        },
        0x660FEA => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FEA(std::mem::transmute(v), r as i32);
        },
        0x0FEB => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FEB(v as u64, (r & 7) as i32);
        },
        0x660FEB => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FEB(std::mem::transmute(v), r as i32);
        },
        0x0FEC => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FEC(v as u64, (r & 7) as i32);
        },
        0x660FEC => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FEC(std::mem::transmute(v), r as i32);
        },
        0x0FED => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FED(v as u64, (r & 7) as i32);
        },
        0x660FED => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FED(std::mem::transmute(v), r as i32);
        },
        0x0FEE => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FEE(v as u64, (r & 7) as i32);
        },
        0x660FEE => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FEE(std::mem::transmute(v), r as i32);
        },
        0x0FEF => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FEF(v as u64, (r & 7) as i32);
        },
        0x660FEF => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FEF(std::mem::transmute(v), r as i32);
        },
        0x0FF1 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FF1(v as u64, (r & 7) as i32);
        },
        0x660FF1 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FF1(std::mem::transmute(v), r as i32);
        },
        0x0FF2 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FF2(v as u64, (r & 7) as i32);
        },
        0x660FF2 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FF2(std::mem::transmute(v), r as i32);
        },
        0x0FF3 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FF3(v as u64, (r & 7) as i32);
        },
        0x660FF3 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FF3(std::mem::transmute(v), r as i32);
        },
        0x0FF4 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FF4(v as u64, (r & 7) as i32);
        },
        0x660FF4 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FF4(std::mem::transmute(v), r as i32);
        },
        0x0FF5 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FF5(v as u64, (r & 7) as i32);
        },
        0x660FF5 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FF5(std::mem::transmute(v), r as i32);
        },
        0x0FF6 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FF6(v as u64, (r & 7) as i32);
        },
        0x660FF6 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FF6(std::mem::transmute(v), r as i32);
        },
        0x0FF8 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FF8(v as u64, (r & 7) as i32);
        },
        0x660FF8 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FF8(std::mem::transmute(v), r as i32);
        },
        0x0FF9 => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FF9(v as u64, (r & 7) as i32);
        },
        0x660FF9 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FF9(std::mem::transmute(v), r as i32);
        },
        0x0FFA => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FFA(v as u64, (r & 7) as i32);
        },
        0x660FFA => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FFA(std::mem::transmute(v), r as i32);
        },
        0x0FFB => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FFB(v as u64, (r & 7) as i32);
        },
        0x660FFB => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FFB(std::mem::transmute(v), r as i32);
        },
        0x0FFC => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FFC(v as u64, (r & 7) as i32);
        },
        0x660FFC => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FFC(std::mem::transmute(v), r as i32);
        },
        0x0FFD => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FFD(v as u64, (r & 7) as i32);
        },
        0x660FFD => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FFD(std::mem::transmute(v), r as i32);
        },
        0x0FFE => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            sem::instr_0FFE(v as u64, (r & 7) as i32);
        },
        0x660FFE => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            sem::instr_660FFE(std::mem::transmute(v), r as i32);
        },
        _ => return Ok(false),
    }
    Ok(true)
}

unsafe fn moves(d: &Decoded) -> Result<bool, Fault> {
    let r = d.reg.unwrap_or(0);
    let op = d.opcode;
    let b = op as u8;
    let p = op >> 16;
    let register_only = matches!(
        op,
        0xF20FD6
            | 0xF30FD6
            | 0x0F50
            | 0x660F50
            | 0x0FD7
            | 0x660FD7
            | 0x0FC5
            | 0x660FC5
            | 0x0FF7
            | 0x660FF7
    );
    let memory_only = matches!(
        op,
        0x0F2B
            | 0x660F2B
            | 0x660FE7
            | 0x0FE7
            | 0x0F13
            | 0x660F13
            | 0x0F17
            | 0x660F17
            | 0x660F12
            | 0x660F16
            | 0xF20FF0
    );
    if register_only && d.rm_register.is_none() || memory_only && d.address.is_none() {
        return Err(Fault::ud());
    }
    match op {
        0x0F10 | 0x660F10 | 0x0F28 | 0x660F28 | 0x660F6F | 0xF30F6F | 0xF20FF0 => {
            guard(true)?;
            let v = source(d, 128, matches!(b, 0x28 | 0x6F) && p != 0xF3, false)?;
            put_xmm(r, v);
        },
        0x0F11 | 0x660F11 | 0x0F29 | 0x660F29 | 0x660F7F | 0xF30F7F | 0x0F2B | 0x660F2B
        | 0x660FE7 => {
            guard(true)?;
            store(
                d,
                128,
                xmm(r),
                matches!(b, 0x29 | 0x2B | 0xE7) || op == 0x660F7F,
                false,
            )?;
        },
        0xF20F10 | 0xF30F10 => {
            guard(true)?;
            let width = if p == 0xF2 { 64 } else { 32 };
            let mask = (1u128 << width) - 1;
            let v = source(d, width, false, false)? & mask;
            put_xmm(
                r,
                if d.rm_register.is_some() { xmm(r) & !mask | v } else { v },
            );
        },
        0xF20F11 | 0xF30F11 => {
            guard(true)?;
            let width = if p == 0xF2 { 64 } else { 32 };
            let mask = (1u128 << width) - 1;
            let v = xmm(r) & mask;
            if let Some(dst) = d.rm_register {
                put_xmm(dst, xmm(dst) & !mask | v);
            }
            else {
                store(d, width, v, false, false)?;
            }
        },
        0x0F12 | 0x660F12 | 0x0F16 | 0x660F16 | 0xF20F12 => {
            guard(true)?;
            let src = source(d, 64, false, false)?;
            let value = if op == 0x0F12 && d.rm_register.is_some() {
                src >> 64
            }
            else {
                src & u64::MAX as u128
            };
            let old = xmm(r);
            put_xmm(
                r,
                if op == 0xF20F12 {
                    value | value << 64
                }
                else if b == 0x16 {
                    old & u64::MAX as u128 | value << 64
                }
                else {
                    old & !(u64::MAX as u128) | value
                },
            );
        },
        0x0F13 | 0x660F13 | 0x0F17 | 0x660F17 => {
            guard(true)?;
            store(
                d,
                64,
                xmm(r) >> if b == 0x17 { 64 } else { 0 },
                false,
                false,
            )?;
        },
        0xF30F12 | 0xF30F16 => {
            // MOVSLDUP/MOVSHDUP: an aligned m128 (SDM exception type 4; QEMU
            // too), unlike MOVDDUP's m64
            guard(true)?;
            let v = source(d, 128, true, false)?;
            let first = if b == 0x12 { 0 } else { 32 };
            let lo = (v >> first) & u32::MAX as u128;
            let hi = (v >> (first + 64)) & u32::MAX as u128;
            put_xmm(r, lo | lo << 32 | hi << 64 | hi << 96);
        },
        0x0F14 | 0x660F14 | 0x0F15 | 0x660F15 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            let a = xmm(r);
            let width = if p == 0x66 { 64 } else { 32 };
            let n = 128 / width;
            let base = if b == 0x15 { n / 2 } else { 0 };
            let mask = (1u128 << width) - 1;
            let mut out = 0;
            for i in 0..n / 2 {
                out |= ((a >> ((base + i) * width)) & mask) << (i * 2 * width);
                out |= ((v >> ((base + i) * width)) & mask) << ((i * 2 + 1) * width);
            }
            put_xmm(r, out);
        },
        0x0F6E | 0x660F6E => {
            guard(p == 0x66)?;
            let v = gpr_source(d, if d.prefixes.w() { 64 } else { 32 })?
                & if d.prefixes.w() { u64::MAX } else { u32::MAX as u64 };
            if p == 0x66 {
                put_xmm(r, v as u128);
            }
            else {
                cpu::write_mmx_reg64((r & 7) as i32, v);
                cpu::transition_fpu_to_mmx();
            }
        },
        0x0F7E | 0x660F7E => {
            guard(p == 0x66)?;
            let v = if p == 0x66 { xmm(r) as u64 } else { cpu::read_mmx64s((r & 7) as i32) };
            gpr_store(d, if d.prefixes.w() { 64 } else { 32 }, v)?;
            if p == 0 {
                cpu::transition_fpu_to_mmx();
            }
        },
        0xF30F7E => {
            guard(true)?;
            let v = source(d, 64, false, false)?;
            put_xmm(r, v & u64::MAX as u128);
        },
        0x660FD6 => {
            guard(true)?;
            let v = xmm(r) & u64::MAX as u128;
            store(d, 64, v, false, false)?;
        },
        0xF20FD6 => {
            guard(true)?;
            cpu::write_mmx_reg64((r & 7) as i32, xmm(d.rm_register.unwrap()) as u64);
            cpu::transition_fpu_to_mmx();
        },
        0xF30FD6 => {
            guard(true)?;
            put_xmm(
                r,
                cpu::read_mmx64s((d.rm_register.unwrap() & 7) as i32) as u128,
            );
            cpu::transition_fpu_to_mmx();
        },
        0x0F6F => {
            guard(false)?;
            let v = source(d, 64, false, true)?;
            cpu::write_mmx_reg64((r & 7) as i32, v as u64);
            cpu::transition_fpu_to_mmx();
        },
        0x0F7F | 0x0FE7 => {
            guard(false)?;
            if b == 0xE7 && address(d).0 & 7 != 0 {
                return Err(Fault::gp());
            }
            store(d, 64, cpu::read_mmx64s((r & 7) as i32) as u128, false, true)?;
            cpu::transition_fpu_to_mmx();
        },
        0x0F50 | 0x660F50 | 0x0FD7 | 0x660FD7 => {
            let mmx = op == 0x0FD7;
            guard(!mmx)?;
            let v = source(d, if mmx { 64 } else { 128 }, false, mmx)?;
            let width = if b == 0xD7 {
                8
            }
            else if p == 0x66 {
                64
            }
            else {
                32
            };
            let n = if mmx { 64 } else { 128 } / width;
            let mut out = 0;
            for i in 0..n {
                out |= ((v >> (i * width + width - 1)) as u64 & 1) << i;
            }
            state::write_gpr(r as usize, out, 32);
            if mmx {
                cpu::transition_fpu_to_mmx();
            }
        },
        0x0FC4 | 0x660FC4 => {
            let mmx = p == 0;
            guard(!mmx)?;
            let v = gpr_source(d, 16)? as u16 as u128;
            let at = (d.immediate.unwrap().value & if mmx { 3 } else { 7 }) * 16;
            let old = if mmx { cpu::read_mmx64s((r & 7) as i32) as u128 } else { xmm(r) };
            let out = old & !(0xFFFFu128 << at) | v << at;
            if mmx {
                cpu::write_mmx_reg64((r & 7) as i32, out as u64);
                cpu::transition_fpu_to_mmx();
            }
            else {
                put_xmm(r, out);
            }
        },
        0x0FC5 | 0x660FC5 => {
            let mmx = p == 0;
            guard(!mmx)?;
            let v = source(d, if mmx { 64 } else { 128 }, false, mmx)?;
            let at = (d.immediate.unwrap().value & if mmx { 3 } else { 7 }) * 16;
            state::write_gpr(r as usize, (v >> at) as u64 & 0xFFFF, 32);
            if mmx {
                cpu::transition_fpu_to_mmx();
            }
        },
        0x0FF7 | 0x660FF7 => {
            let mmx = p == 0;
            guard(!mmx)?;
            let mask = source(d, if mmx { 64 } else { 128 }, false, mmx)?;
            let value = if mmx { cpu::read_mmx64s((r & 7) as i32) as u128 } else { xmm(r) };
            let seg = d.prefixes.segment.unwrap_or(3);
            let base = if seg >= 4 { state::read_segment_base(seg as usize) } else { 0 };
            let off = state::read_gpr(7);
            let off = if d.address_size == 32 { off as u32 as u64 } else { off };
            let a = off.wrapping_add(base);
            for i in 0..if mmx { 8 } else { 16 } {
                if mask >> (i * 8 + 7) & 1 != 0 {
                    memory::probe_write(a.wrapping_add(i), 8, false)?;
                }
            }
            for i in 0..if mmx { 8 } else { 16 } {
                if mask >> (i * 8 + 7) & 1 != 0 {
                    memory::write(a.wrapping_add(i), 8, (value >> (i * 8)) as u64, false)?;
                }
            }
            if mmx {
                cpu::transition_fpu_to_mmx();
            }
        },
        0x0F77 => {
            guard(false)?;
            *gp::fpu_stack_empty = 0xFF;
        },
        0x0F52 | 0x0F53 | 0xF30F52 | 0xF30F53 => {
            guard(true)?;
            let scalar = p == 0xF3;
            let src = source(d, if scalar { 32 } else { 128 }, !scalar, false)?;
            put_xmm(r, simd_fp::reciprocal(d.opcode, xmm(r), src));
        },
        _ => return Ok(false),
    }
    Ok(true)
}
unsafe fn immediate_shift(d: &Decoded) -> Result<bool, Fault> {
    if !matches!(
        d.opcode,
        0x0F71 | 0x0F72 | 0x0F73 | 0x660F71 | 0x660F72 | 0x660F73
    ) {
        return Ok(false);
    }
    let mmx = d.opcode >> 16 == 0;
    guard(!mmx)?;
    let r = d.rm_register.ok_or_else(Fault::ud)?;
    let group = d.modrm.unwrap() >> 3 & 7;
    let n = d.immediate.unwrap().value;
    let op = d.opcode as u8;
    let mut value = if mmx { cpu::read_mmx64s((r & 7) as i32) as u128 } else { xmm(r) };
    if op == 0x73 && matches!(group, 3 | 7) && !mmx {
        value = if n >= 16 {
            0
        }
        else if group == 3 {
            value >> (n * 8)
        }
        else {
            value << (n * 8)
        };
    }
    else {
        let width = match op {
            0x71 => 16,
            0x72 => 32,
            _ => 64,
        };
        let count = if mmx { 64 } else { 128 } / width;
        let mask = (1u128 << width) - 1;
        let mut out = 0;
        for i in 0..count {
            let lane = (value >> (i * width)) & mask;
            let shifted = match group {
                2 => {
                    if n >= width {
                        0
                    }
                    else {
                        lane >> n
                    }
                },
                6 => {
                    if n >= width {
                        0
                    }
                    else {
                        lane << n
                    }
                },
                4 if width < 64 => {
                    let signed = ((lane as u64) << (64 - width)) as i64 >> (64 - width);
                    (signed >> (n.min(width - 1))) as u64 as u128
                },
                _ => return Err(Fault::ud()),
            };
            out |= (shifted & mask) << (i * width);
        }
        value = out;
    }
    if mmx {
        cpu::write_mmx_reg64((r & 7) as i32, value as u64);
        cpu::transition_fpu_to_mmx();
    }
    else {
        put_xmm(r, value);
    }
    Ok(true)
}

unsafe fn bytes_read(a: u64, n: usize, stack: bool) -> Result<Vec<u8>, Fault> {
    for i in 0..n {
        memory::probe_read(a.wrapping_add(i as u64), 8, stack)?;
    }
    let mut v = vec![0; n];
    for (i, b) in v.iter_mut().enumerate() {
        *b = memory::read(a.wrapping_add(i as u64), 8, stack)? as u8;
    }
    Ok(v)
}
unsafe fn bytes_write(a: u64, data: &[u8], stack: bool) -> Result<(), Fault> {
    for i in 0..data.len() {
        memory::probe_write(a.wrapping_add(i as u64), 8, stack)?;
    }
    for (i, b) in data.iter().enumerate() {
        memory::write(a.wrapping_add(i as u64), 8, *b as u64, stack)?;
    }
    Ok(())
}
fn u16_at(v: &[u8], at: usize) -> u16 { u16::from_le_bytes(v[at..at + 2].try_into().unwrap()) }
fn u32_at(v: &[u8], at: usize) -> u32 { u32::from_le_bytes(v[at..at + 4].try_into().unwrap()) }
fn u64_at(v: &[u8], at: usize) -> u64 { u64::from_le_bytes(v[at..at + 8].try_into().unwrap()) }
/// An XSAVE or FXSAVE area at a checked linear address (cpu::xstate::Area)
struct Area {
    a: u64,
    stack: bool,
}
impl xstate::Area for Area {
    type Fault = Fault;
    unsafe fn check(&mut self, offset: u32, length: u32, write: bool) -> Result<(), Fault> {
        // (a field is shorter than a page: its first byte and, when it
        // crosses into the next page, that page's first byte cover it, which
        // a page fault reports in CR2)
        let first = self.a.wrapping_add(offset as u64);
        let last = first.wrapping_add(length as u64 - 1);
        let next = (last >> 12 != first >> 12).then_some(last & !0xFFF);
        for at in std::iter::once(first).chain(next) {
            if write {
                memory::probe_write(at, 8, self.stack)?;
            }
            else {
                memory::probe_read(at, 8, self.stack)?;
            }
        }
        Ok(())
    }
    unsafe fn read(&mut self, offset: u32, bytes: &mut [u8]) {
        let value = memory::read(
            self.a.wrapping_add(offset as u64),
            bytes.len() as u8 * 8,
            self.stack,
        )
        .unwrap();
        bytes.copy_from_slice(&value.to_le_bytes()[..bytes.len()]);
    }
    unsafe fn write(&mut self, offset: u32, bytes: &[u8]) {
        let mut value = [0; 8];
        value[..bytes.len()].copy_from_slice(bytes);
        let at = self.a.wrapping_add(offset as u64);
        memory::write(
            at,
            bytes.len() as u8 * 8,
            u64::from_le_bytes(value),
            self.stack,
        )
        .unwrap();
    }
    unsafe fn gp(&mut self) -> Fault { Fault::gp() }
}
unsafe fn fxstate(d: &Decoded) -> Result<bool, Fault> {
    if d.base_opcode() != 0x0FAE {
        return Ok(false);
    }
    let group = d.modrm.unwrap() >> 3 & 7;
    if d.rm_register.is_some() {
        // LFENCE, MFENCE, SFENCE ignore the r/m field
        return Ok(group >= 5);
    }
    if group == 7 {
        let (a, s) = address(d);
        memory::probe_read(a, 8, s)?;
        return Ok(true); // CLFLUSH: guest caches share the coherent RAM image.
    }
    // (XSAVEOPT: CPUID.(EAX=0DH,ECX=1):EAX[0])
    if group == 6 && !crate::cpu::features::has(crate::cpu::features::XSAVEOPT) {
        return Ok(false);
    }
    // XSAVE and XRSTOR: #UD without CR4.OSXSAVE before #NM
    if group >= 4 && !xstate::enabled() {
        return Err(Fault::ud());
    }
    if state::read_cr(0) & 8 != 0 {
        return Err(fault(7));
    }
    let (a, s) = address(d);
    if group == 2 || group == 3 {
        guard(true)?;
        if group == 2 {
            let v = memory::read(a, 32, s)? as u32;
            if v & !(cpu::MXCSR_MASK as u32) != 0 {
                return Err(Fault::gp());
            }
            *gp::mxcsr = v as i32;
        }
        else {
            memory::write(a, 32, *gp::mxcsr as u32 as u64, s)?;
        }
        return Ok(true);
    }
    alignment(a, s, if group >= 4 { 64 } else { 16 })?;
    // the 64-bit format with REX.W; XMM8-15 and YMM8-15 in 64-bit mode
    let format = xstate::Format {
        wide: d.prefixes.w(),
        long: d.mode.is_long(),
    };
    let area = &mut Area { a, stack: s };
    let rfbm = || xstate::requested(state::read_gpr(2) as u32, state::read_gpr(0) as u32);
    match group {
        0 => xstate::fxsave(area, format)?,
        1 => xstate::fxrstor(area, format)?,
        4 => xstate::xsave(area, rfbm(), format)?,
        6 => xstate::xsaveopt(area, rfbm(), format)?,
        _ => xstate::xrstor(area, rfbm(), format)?,
    }
    Ok(true)
}
/// XRSTORS (0F C7 /3), XSAVEC (/4) and XSAVES (/5) on memory, without a
/// mandatory prefix: XSAVE's checks and their order (#UD without
/// CR4.OSXSAVE, #NM, #GP(0) unless aligned to 64 bytes), and #GP(0) for CPL
/// > 0 before the operand for XRSTORS and XSAVES; the 64-bit forms with REX.W
pub(super) unsafe fn compacted_state(d: &Decoded, group: u8) -> Result<(), Fault> {
    if d.rm_register.is_some() || d.prefixes.operand || d.prefixes.rep.is_some() {
        return Err(Fault::ud());
    }
    if !xstate::enabled() {
        return Err(Fault::ud());
    }
    if state::read_cr(0) & 8 != 0 {
        return Err(fault(7));
    }
    if group != 4 && *gp::cpl != 0 {
        return Err(Fault::gp());
    }
    let (a, s) = address(d);
    alignment(a, s, 64)?;
    let format = xstate::Format {
        wide: d.prefixes.w(),
        long: d.mode.is_long(),
    };
    let area = &mut Area { a, stack: s };
    let (edx, eax) = (state::read_gpr(2) as u32, state::read_gpr(0) as u32);
    match group {
        3 => xstate::xrstors(area, xstate::requested_supervisor(edx, eax), format),
        4 => xstate::xsavec(area, xstate::requested(edx, eax), format),
        _ => xstate::xsaves(area, xstate::requested_supervisor(edx, eax), format),
    }
}
unsafe fn x87_environment(d: &Decoded, restore: bool, registers: bool) -> Result<(), Fault> {
    let (a, s) = address(d);
    let short = d.prefixes.operand;
    let env = if short { 14 } else { 28 };
    let size = env + if registers { 80 } else { 0 };
    fpu::fpu_cache_barrier();
    if restore {
        let v = bytes_read(a, size, s)?;
        let step = if short { 2 } else { 4 };
        fpu::set_control_word(u16_at(&v, 0));
        fpu::fpu_set_status_word(u16_at(&v, step));
        fpu::fpu_set_tag_word(u16_at(&v, step * 2) as i32);
        *gp::fpu_ip = if short { u16_at(&v, 6) as i32 } else { u32_at(&v, 12) as i32 };
        *gp::fpu_dp = if short { u16_at(&v, 10) as i32 } else { u32_at(&v, 20) as i32 };
        *gp::x64_fpu_ip_hi = 0;
        *gp::x64_fpu_dp_hi = 0;
        *gp::fpu_ip_selector = u16_at(&v, if short { 8 } else { 16 }) as i32;
        *gp::fpu_dp_selector = u16_at(&v, if short { 12 } else { 24 }) as i32;
        if !short {
            *gp::fpu_opcode = u16_at(&v, 18) as i32 & 0x7FF;
        }
        if registers {
            for i in 0..8 {
                fpu::fpu_write_st(
                    ((i + *gp::fpu_stack_ptr as usize) & 7) as i32,
                    F80 {
                        mantissa: u64_at(&v, env + i * 10),
                        sign_exponent: u16_at(&v, env + i * 10 + 8),
                    },
                );
            }
        }
    }
    else {
        let mut v = vec![0xFF; size];
        let step = if short { 2 } else { 4 };
        v[0..2].copy_from_slice(&(*gp::fpu_control_word).to_le_bytes());
        v[step..step + 2].copy_from_slice(&fpu::fpu_load_status_word().to_le_bytes());
        v[step * 2..step * 2 + 2].copy_from_slice(&(fpu::fpu_load_tag_word() as u16).to_le_bytes());
        if short {
            v[6..8].copy_from_slice(&(*gp::fpu_ip as u16).to_le_bytes());
            v[8..10].copy_from_slice(&(*gp::fpu_ip_selector as u16).to_le_bytes());
            v[10..12].copy_from_slice(&(*gp::fpu_dp as u16).to_le_bytes());
            v[12..14].copy_from_slice(&(*gp::fpu_dp_selector as u16).to_le_bytes());
        }
        else {
            v[12..16].copy_from_slice(&(*gp::fpu_ip as u32).to_le_bytes());
            v[16..18].copy_from_slice(&(*gp::fpu_ip_selector as u16).to_le_bytes());
            v[18..20].copy_from_slice(&(*gp::fpu_opcode as u16).to_le_bytes());
            v[20..24].copy_from_slice(&(*gp::fpu_dp as u32).to_le_bytes());
            v[24..26].copy_from_slice(&(*gp::fpu_dp_selector as u16).to_le_bytes());
        }
        if registers {
            for i in 0..8 {
                let f = *gp::fpu_st.add((i + *gp::fpu_stack_ptr as usize) & 7);
                v[env + i * 10..env + i * 10 + 8].copy_from_slice(&f.mantissa.to_le_bytes());
                v[env + i * 10 + 8..env + i * 10 + 10]
                    .copy_from_slice(&f.sign_exponent.to_le_bytes());
            }
        }
        bytes_write(a, &v, s)?;
        if registers {
            fpu::fpu_finit();
        }
        else {
            fpu::set_control_word(*gp::fpu_control_word | 63);
        }
    }
    Ok(())
}

// Legacy callers may select approximate x87 host arithmetic. Long mode keeps
// architectural rounding and exception delivery irrespective of that policy.
struct X87Strict {
    old_fast: bool,
    old_flags: u8,
}
impl X87Strict {
    unsafe fn new() -> Self {
        let old_fast = crate::softfloat::x87_fast_math();
        let old_flags = softfloat_exceptionFlags;
        if old_fast {
            crate::softfloat::set_x87_fast_math(false);
        }
        softfloat_exceptionFlags = 0;
        Self {
            old_fast,
            old_flags,
        }
    }
}
impl Drop for X87Strict {
    fn drop(&mut self) {
        unsafe {
            softfloat_exceptionFlags = self.old_flags;
            if self.old_fast {
                crate::softfloat::set_x87_fast_math(true);
            }
        }
    }
}
unsafe fn x87_exception_flags() -> u16 {
    let f = softfloat_exceptionFlags as u16;
    (f >> 4 & 1) | (f >> 1 & 4) | (f << 1 & 8) | (f << 3 & 16) | (f << 5 & 32)
}
unsafe fn x87_pending() -> bool { *gp::fpu_status_word & !*gp::fpu_control_word & 63 != 0 }
unsafe fn x87_memory(d: &Decoded, group: u8) -> Result<(), Fault> {
    let op = d.base_opcode() as u8;
    let (a, s) = address(d);
    if matches!(op, 0xD8 | 0xDA | 0xDC | 0xDE) {
        let width = match op {
            0xD8 | 0xDA => 32,
            0xDC => 64,
            _ => 16,
        };
        let raw = memory::read(a, width, s)?;
        F80::clear_exception_flags();
        let value = match op {
            0xD8 => F80::of_f32(raw as i32),
            0xDC => F80::of_f64(raw),
            0xDA => F80::of_i32(raw as i32),
            _ => F80::of_i32(raw as i16 as i32),
        };
        *gp::fpu_status_word |= x87_exception_flags();
        match group {
            0 => fpu::fpu_fadd(0, value),
            1 => fpu::fpu_fmul(0, value),
            2 => fpu::fpu_fcom(value),
            3 => fpu::fpu_fcomp(value),
            4 => fpu::fpu_fsub(0, value),
            5 => fpu::fpu_fsubr(0, value),
            6 => fpu::fpu_fdiv(0, value),
            7 => fpu::fpu_fdivr(0, value),
            _ => unreachable!(),
        }
        return Ok(());
    }
    if op == 0xD9 && matches!(group, 4 | 6) {
        return x87_environment(d, group == 4, false);
    }
    if op == 0xDD && matches!(group, 4 | 6) {
        return x87_environment(d, group == 4, true);
    }
    if op == 0xD9 && group == 5 {
        let cw = memory::read(a, 16, s)?;
        fpu::set_control_word(cw as u16);
        return Ok(());
    }
    if op == 0xD9 && group == 7 {
        return memory::write(a, 16, *gp::fpu_control_word as u64, s);
    }
    if op == 0xDD && group == 7 {
        return memory::write(a, 16, fpu::fpu_load_status_word() as u64, s);
    }
    let load = group == 0 || op == 0xDB && group == 5 || op == 0xDF && matches!(group, 4 | 5);
    if load {
        let value = if op == 0xDB && group == 5 {
            let v = bytes_read(a, 10, s)?;
            F80 {
                mantissa: u64_at(&v, 0),
                sign_exponent: u16_at(&v, 8),
            }
        }
        else if op == 0xDF && group == 4 {
            let v = bytes_read(a, 10, s)?;
            let mut n = 0i64;
            for i in (0..9).rev() {
                n = n * 100 + (v[i] >> 4) as i64 * 10 + (v[i] & 15) as i64;
            }
            if v[9] & 128 != 0 {
                n = -n;
            }
            F80::of_i64(n)
        }
        else {
            let width = match (op, group) {
                (0xD9, _) | (0xDB, _) => 32,
                (0xDD, _) | (0xDF, 5) => 64,
                _ => 16,
            };
            let raw = memory::read(a, width, s)?;
            F80::clear_exception_flags();
            let v = match op {
                0xD9 => F80::of_f32(raw as i32),
                0xDD => F80::of_f64(raw),
                0xDB => F80::of_i32(raw as i32),
                _ => F80::of_i64(if width == 16 { raw as i16 as i64 } else { raw as i64 }),
            };
            *gp::fpu_status_word |= x87_exception_flags();
            v
        };
        fpu::fpu_push(value);
        return Ok(());
    }
    let width = match (op, group) {
        (0xD9, 2 | 3) | (0xDB, 1..=3) => 32,
        (0xDD, 1..=3) | (0xDF, 7) => 64,
        (0xDF, 1..=3) => 16,
        (0xDB, 7) | (0xDF, 6) => 80,
        _ => return Err(Fault::ud()),
    };
    for i in 0..width / 8 {
        memory::probe_write(a.wrapping_add(i as u64), 8, s)?;
    }
    let v = fpu::fpu_get_st0();
    F80::clear_exception_flags();
    let raw = if op == 0xD9 {
        extF80M_to_f32(&v) as u32 as u64
    }
    else if op == 0xDD && group != 1 {
        extF80M_to_f64(&v)
    }
    else if width == 80 {
        0
    }
    else {
        let rounding = if group == 1 { 1 } else { softfloat_roundingMode };
        if width == 64 {
            extF80M_to_i64(&v, rounding, true) as u64
        }
        else {
            let integer = extF80M_to_i32(&v, rounding, true);
            if width == 16 && (integer < i16::MIN as i32 || integer > i16::MAX as i32) {
                softfloat_exceptionFlags |= 16;
                0x8000
            }
            else {
                integer as u32 as u64
            }
        }
    };
    *gp::fpu_status_word |= x87_exception_flags();
    if width == 80 {
        let mut data = vec![0; 10];
        if op == 0xDF {
            let integer = extF80M_to_i64(&v, softfloat_roundingMode, true);
            *gp::fpu_status_word |= x87_exception_flags();
            let mut n = integer.unsigned_abs();
            if n > 999_999_999_999_999_999 {
                *gp::fpu_status_word |= 1;
                data[7] = 0xC0;
                data[8] = 0xFF;
                data[9] = 0xFF;
            }
            else {
                for byte in &mut data[..9] {
                    *byte = (n % 10) as u8;
                    n /= 10;
                    *byte |= ((n % 10) as u8) << 4;
                    n /= 10;
                }
                data[9] = if integer < 0 { 128 } else { 0 };
            }
        }
        else {
            data[..8].copy_from_slice(&v.mantissa.to_le_bytes());
            data[8..].copy_from_slice(&v.sign_exponent.to_le_bytes());
        }
        if !x87_pending() {
            bytes_write(a, &data, s)?;
        }
    }
    else if !x87_pending() {
        memory::write(a, width, raw, s)?;
    }
    if !x87_pending() && (group == 1 || group == 3 || width == 80 || op == 0xDF && group == 7) {
        fpu::fpu_pop();
    }
    Ok(())
}
unsafe fn x87(d: &Decoded) -> Result<bool, Fault> {
    let op = d.base_opcode();
    if op == 0x9B {
        if state::read_cr(0) & 10 == 10 {
            return Err(fault(7));
        }
        if x87_pending() {
            return Err(fault(16));
        }
        return Ok(true);
    }
    if !(0xD8..=0xDF).contains(&op) {
        return Ok(false);
    }
    if state::read_cr(0) & 12 != 0 {
        return Err(fault(7));
    }
    let m = d.modrm.unwrap();
    let group = m >> 3 & 7;
    let r = (m & 7) as i32;
    let no_wait = op == 0xDB && matches!(m, 0xE2 | 0xE3)
        || d.address.is_some()
            && (op == 0xD9 && matches!(group, 6 | 7) || op == 0xDD && matches!(group, 6 | 7))
        || op == 0xDF && m == 0xE0;
    if !no_wait && x87_pending() {
        return Err(fault(16));
    }
    let _strict = X87Strict::new();
    fpu::fpu_cache_barrier();
    let old_top = *gp::fpu_stack_ptr;
    let old_status = *gp::fpu_status_word;
    let old_empty = *gp::fpu_stack_empty;
    let old_flags = state::read_flags64();
    let old_regs = std::ptr::read(gp::fpu_st as *const [F80; 8]);
    if d.address.is_some() {
        x87_memory(d, group)?;
    }
    else {
        let valid = match op {
            0xD9 => match group {
                2 => r == 0,
                4 => matches!(r, 0 | 1 | 4 | 5),
                5 => r < 7,
                _ => true,
            },
            0xDA => group < 4 || group == 5 && r == 1,
            0xDB => group < 4 || group == 4 && r < 5 || matches!(group, 5 | 6),
            0xDD => group < 6,
            0xDE => group != 3 || r == 1,
            0xDF => group < 4 || group == 4 && r == 0 || matches!(group, 5 | 6),
            _ => true,
        };
        if !valid {
            return Err(Fault::ud());
        }
        use crate::cpu::instructions as ins;
        match (op, group) {
            (0xD8, 0) => ins::instr_D8_0_reg(r),
            (0xD8, 1) => ins::instr_D8_1_reg(r),
            (0xD8, 2) => ins::instr_D8_2_reg(r),
            (0xD8, 3) => ins::instr_D8_3_reg(r),
            (0xD8, 4) => ins::instr_D8_4_reg(r),
            (0xD8, 5) => ins::instr_D8_5_reg(r),
            (0xD8, 6) => ins::instr_D8_6_reg(r),
            (0xD8, 7) => ins::instr_D8_7_reg(r),
            (0xD9, 0) => ins::instr32_D9_0_reg(r),
            (0xD9, 1) => ins::instr32_D9_1_reg(r),
            (0xD9, 2) => ins::instr32_D9_2_reg(r),
            (0xD9, 3) => ins::instr32_D9_3_reg(r),
            (0xD9, 4) => ins::instr32_D9_4_reg(r),
            (0xD9, 5) => ins::instr32_D9_5_reg(r),
            (0xD9, 6) => ins::instr32_D9_6_reg(r),
            (0xD9, 7) => ins::instr32_D9_7_reg(r),
            (0xDA, 0) => ins::instr_DA_0_reg(r),
            (0xDA, 1) => ins::instr_DA_1_reg(r),
            (0xDA, 2) => ins::instr_DA_2_reg(r),
            (0xDA, 3) => ins::instr_DA_3_reg(r),
            (0xDA, 4) => ins::instr_DA_4_reg(r),
            (0xDA, 5) => ins::instr_DA_5_reg(r),
            (0xDA, 6) => ins::instr_DA_6_reg(r),
            (0xDA, 7) => ins::instr_DA_7_reg(r),
            (0xDB, 0) => ins::instr_DB_0_reg(r),
            (0xDB, 1) => ins::instr_DB_1_reg(r),
            (0xDB, 2) => ins::instr_DB_2_reg(r),
            (0xDB, 3) => ins::instr_DB_3_reg(r),
            (0xDB, 4) => ins::instr_DB_4_reg(r),
            (0xDB, 5) => ins::instr_DB_5_reg(r),
            (0xDB, 6) => ins::instr_DB_6_reg(r),
            (0xDB, 7) => ins::instr_DB_7_reg(r),
            (0xDC, 0) => ins::instr_DC_0_reg(r),
            (0xDC, 1) => ins::instr_DC_1_reg(r),
            (0xDC, 2) => ins::instr_DC_2_reg(r),
            (0xDC, 3) => ins::instr_DC_3_reg(r),
            (0xDC, 4) => ins::instr_DC_4_reg(r),
            (0xDC, 5) => ins::instr_DC_5_reg(r),
            (0xDC, 6) => ins::instr_DC_6_reg(r),
            (0xDC, 7) => ins::instr_DC_7_reg(r),
            (0xDD, 0) => ins::instr32_DD_0_reg(r),
            (0xDD, 1) => ins::instr32_DD_1_reg(r),
            (0xDD, 2) => ins::instr32_DD_2_reg(r),
            (0xDD, 3) => ins::instr32_DD_3_reg(r),
            (0xDD, 4) => ins::instr32_DD_4_reg(r),
            (0xDD, 5) => ins::instr32_DD_5_reg(r),
            (0xDD, 6) => ins::instr32_DD_6_reg(r),
            (0xDD, 7) => ins::instr32_DD_7_reg(r),
            (0xDE, 0) => ins::instr_DE_0_reg(r),
            (0xDE, 1) => ins::instr_DE_1_reg(r),
            (0xDE, 2) => ins::instr_DE_2_reg(r),
            (0xDE, 3) => ins::instr_DE_3_reg(r),
            (0xDE, 4) => ins::instr_DE_4_reg(r),
            (0xDE, 5) => ins::instr_DE_5_reg(r),
            (0xDE, 6) => ins::instr_DE_6_reg(r),
            (0xDE, 7) => ins::instr_DE_7_reg(r),
            (0xDF, 0) => ins::instr_DF_0_reg(r),
            (0xDF, 1) => ins::instr_DF_1_reg(r),
            (0xDF, 2) => ins::instr_DF_2_reg(r),
            (0xDF, 3) => ins::instr_DF_3_reg(r),
            (0xDF, 4) => ins::instr_DF_4_reg(r),
            (0xDF, 5) => ins::instr_DF_5_reg(r),
            (0xDF, 6) => ins::instr_DF_6_reg(r),
            (0xDF, 7) => ins::instr_DF_7_reg(r),
            _ => unreachable!(),
        }
    }
    *gp::fpu_status_word |= x87_exception_flags();
    if op == 0xDB && m == 0xE2 {
        *gp::fpu_status_word = old_status & !0x80FF;
    }
    if x87_pending() {
        for i in 0..8 {
            fpu::fpu_write_st(i as i32, old_regs[i]);
        }
        *gp::fpu_stack_ptr = old_top;
        *gp::fpu_stack_empty = old_empty;
        state::write_flags64(old_flags);
        *gp::fpu_status_word |= 0x8080;
    }
    let control = op == 0xDB && group == 4
        || op == 0xD9 && d.address.is_some() && group >= 4
        || op == 0xDD && d.address.is_some() && group >= 4
        || op == 0xDF && m == 0xE0;
    if !control {
        *gp::fpu_ip = d.start.0 as i32;
        *gp::x64_fpu_ip_hi = (d.start.0 >> 32) as u32;
        *gp::fpu_ip_selector = 0;
        *gp::fpu_opcode = ((op & 7) << 8 | m as u32) as i32;
        if d.address.is_some() {
            let (a, _) = address(d);
            *gp::fpu_dp = a as i32;
            *gp::x64_fpu_dp_hi = (a >> 32) as u32;
            *gp::fpu_dp_selector = 0;
        }
    }
    Ok(true)
}

/// Returns false only for instructions outside this semantic family. A true
/// result commits RIP; exceptions leave the faulting RIP and destination intact.
/// SSSE3 (0F 38 and PALIGNR, 0F 3A 0F): the MMX forms without prefix, the
/// XMM forms with 66. The semantics are crate::cpu::simd_int's.
unsafe fn ssse3(d: &Decoded) -> Result<bool, Fault> {
    let base = d.base_opcode();
    if !matches!(base, 0x0F3800..=0x0F380B | 0x0F381C..=0x0F381E | 0x0F3A0F)
        || !matches!(d.opcode >> 24, 0 | 0x66)
    {
        return Ok(false);
    }
    let xmm = d.opcode >> 24 == 0x66;
    let r = d.reg.unwrap_or(0);
    let imm = d.immediate.map_or(0, |i| i.value as i32);
    guard(xmm)?;
    if xmm {
        let v = std::mem::transmute(source(d, 128, true, false)?);
        if base == 0x0F3A0F {
            sem3a::instr_660F3A0F(v, r as i32, imm);
        }
        else {
            sem38::ssse3_xmm(base as u8, v, r as i32);
        }
    }
    else {
        let v = source(d, 64, false, true)? as u64;
        if base == 0x0F3A0F {
            sem3a::instr_0F3A0F(v, (r & 7) as i32, imm);
        }
        else {
            sem38::ssse3_mmx(base as u8, v, (r & 7) as i32);
        }
    }
    Ok(true)
}

/// SSE4.1 and SSE4.2 forms with 66 (0F 38 and 0F 3A), with the semantics of
/// crate::cpu::simd_int and simd_fp (ROUND, DPPS/DPPD). REX.W selects PEXTRQ and PINSRQ; a
/// register destination of PEXTRB/PEXTRW/PEXTRD/EXTRACTPS is zero-extended.
/// PCMPESTRx take their lengths from EAX and EDX (RAX and RDX with REX.W).
unsafe fn sse4(d: &Decoded) -> Result<bool, Fault> {
    let base = d.base_opcode();
    if d.opcode >> 24 != 0x66 {
        return Ok(false);
    }
    let r = d.reg.unwrap_or(0);
    let imm = d.immediate.map_or(0, |i| i.value as u8);
    let vector = |v: u128| v.to_le_bytes();
    match base {
        0x0F3810
        | 0x0F3814
        | 0x0F3815
        | 0x0F3820..=0x0F3825
        | 0x0F3828
        | 0x0F3829
        | 0x0F382B
        | 0x0F3830..=0x0F3835
        | 0x0F3837..=0x0F3841 => {
            guard(true)?;
            let op = base as u8;
            let bytes = sem38::sse4_source_bytes(op);
            let v = source(d, bytes * 8, bytes == 16, false)?;
            let result = simd_int::sse4(op, vector(xmm(r)), vector(v), vector(xmm(0)));
            put_xmm(r, u128::from_le_bytes(result));
        },
        0x0F3817 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            let (zero, carry) = simd_int::ptest(vector(xmm(r)), vector(v));
            state::write_flags64(
                state::read_flags64() & !0x8D5 | (zero as u64) << 6 | carry as u64,
            );
        },
        0x0F382A => {
            guard(true)?;
            if d.rm_register.is_some() {
                return Err(Fault::ud());
            }
            put_xmm(r, source(d, 128, true, false)?);
        },
        0x0F3A08..=0x0F3A0B => {
            guard(true)?;
            let v = match base {
                0x0F3A0A => source(d, 32, false, false)?,
                0x0F3A0B => source(d, 64, false, false)?,
                _ => source(d, 128, true, false)?,
            };
            put_xmm(
                r,
                simd_fp::round(base, xmm(r), v, imm).map_err(|e| simd_fault(e))?,
            );
        },
        0x0F3A40 | 0x0F3A41 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            put_xmm(
                r,
                simd_fp::dot_product(base == 0x0F3A41, xmm(r), v, imm)
                    .map_err(|e| simd_fault(e))?,
            );
        },
        // PCMPESTRM, PCMPESTRI, PCMPISTRM, PCMPISTRI: the index to ECX (RCX
        // zero-extended) or the mask to XMM0, and the flags; the m128 needs no
        // alignment (SDM, exception type 4)
        0x0F3A60..=0x0F3A63 => {
            guard(true)?;
            let v = source(d, 128, false, false)?;
            let explicit = base & 2 == 0;
            let length = |r: usize| {
                let value = state::read_gpr(r);
                explicit.then(|| {
                    if d.prefixes.w() {
                        value as i64
                    }
                    else {
                        value as i32 as i64
                    }
                })
            };
            let result =
                simd_int::compare_strings(imm, vector(xmm(r)), vector(v), length(0), length(2));
            if base & 1 != 0 {
                state::write_gpr(1, result.index as u64, 32);
            }
            else {
                put_xmm(0, u128::from_le_bytes(result.xmm0));
            }
            state::write_flags64(state::read_flags64() & !0x8D5 | result.flags as u64);
        },
        0x0F3A0C..=0x0F3A0E | 0x0F3A42 => {
            guard(true)?;
            let v = source(d, 128, true, false)?;
            put_xmm(
                r,
                u128::from_le_bytes(simd_int::sse4_imm(
                    base as u8,
                    vector(xmm(r)),
                    vector(v),
                    imm,
                )),
            );
        },
        // PEXTRB, PEXTRW, PEXTRD/PEXTRQ, EXTRACTPS
        0x0F3A14..=0x0F3A17 => {
            guard(true)?;
            let bytes = match base {
                0x0F3A14 => 1,
                0x0F3A15 => 2,
                0x0F3A16 if d.prefixes.w() => 8,
                _ => 4,
            };
            let at = (imm as u32 & (16 / bytes - 1)) * bytes * 8;
            let value = (xmm(r) >> at) as u64 & (u64::MAX >> (64 - bytes * 8));
            if let Some(rm) = d.rm_register {
                state::write_gpr(rm as usize, value, if bytes == 8 { 64 } else { 32 });
            }
            else {
                let (a, stack) = address(d);
                memory::write(a, bytes as u8 * 8, value, stack)?;
            }
        },
        // PINSRB, INSERTPS, PINSRD/PINSRQ
        0x0F3A20..=0x0F3A22 => {
            guard(true)?;
            if base == 0x0F3A21 {
                let value = match d.rm_register {
                    Some(rm) => (xmm(rm) >> ((imm >> 6 & 3) * 32)) as u32,
                    None => source(d, 32, false, false)? as u32,
                };
                put_xmm(
                    r,
                    u128::from_le_bytes(simd_int::insertps(vector(xmm(r)), value, imm)),
                );
            }
            else {
                let bytes = if base == 0x0F3A20 {
                    1
                }
                else if d.prefixes.w() {
                    8
                }
                else {
                    4
                };
                let value =
                    gpr_source(d, bytes as u8 * 8)? as u128 & (u128::MAX >> (128 - bytes * 8));
                let at = (imm as u32 & (16 / bytes - 1)) * bytes * 8;
                put_xmm(
                    r,
                    xmm(r) & !((u128::MAX >> (128 - bytes * 8)) << at) | value << at,
                );
            }
        },
        _ => return Ok(false),
    }
    Ok(true)
}

/// The x64 engine's side of an AVX instruction (crate::cpu::avx)
struct Avx<'a>(&'a Decoded);
impl avx::Machine for Avx<'_> {
    type Fault = Fault;
    /// (the address without its index, plus `offset`, wrapped to the
    /// address size; FS and GS bases)
    unsafe fn gather(&mut self, offset: u64, bytes: u8) -> Result<u64, Fault> {
        let mut a = self.0.address.unwrap();
        a.index = None;
        a.displacement = a.displacement.wrapping_add(offset as i64);
        let mut regs = [0; 16];
        for (r, value) in regs.iter_mut().enumerate() {
            *value = state::read_gpr(r);
        }
        let base = if a.segment >= 4 { state::read_segment_base(a.segment as usize) } else { 0 };
        memory::read(
            a.offset(&regs, self.0.next).wrapping_add(base),
            bytes * 8,
            a.segment == 2,
        )
    }
    unsafe fn raise(&mut self, e: avx::Exception) -> Fault {
        match e {
            avx::Exception::InvalidOpcode => Fault::ud(),
            avx::Exception::DeviceNotAvailable => fault(7),
            avx::Exception::GeneralProtection => Fault::gp(),
            avx::Exception::SimdFloatingPoint => simd_fault(simd_fp::Unmasked),
        }
    }
    unsafe fn read(&mut self, bytes: u8, aligned: bool) -> Result<u128, Fault> {
        let (a, stack) = address(self.0);
        if aligned {
            alignment(a, stack, 16)?;
        }
        if bytes == 16 {
            memory::read128(a, stack)
        }
        else {
            memory::read(a, bytes * 8, stack).map(|v| v as u128)
        }
    }
    unsafe fn write(&mut self, bytes: u8, value: u128, aligned: bool) -> Result<(), Fault> {
        let (a, stack) = address(self.0);
        if aligned {
            alignment(a, stack, 16)?;
        }
        if bytes == 16 {
            memory::write128(a, value, stack)
        }
        else {
            memory::write(a, bytes * 8, value as u64, stack)
        }
    }
    /// (as MASKMOVDQU: the selected bytes writable first)
    unsafe fn write_masked(&mut self, value: u128, mask: u16) -> Result<(), Fault> {
        let d = self.0;
        let seg = d.prefixes.segment.unwrap_or(3);
        let base = if seg >= 4 { state::read_segment_base(seg as usize) } else { 0 };
        let off = state::read_gpr(7);
        let off = if d.address_size == 32 { off as u32 as u64 } else { off };
        let a = off.wrapping_add(base);
        for i in 0..16 {
            if mask >> i & 1 != 0 {
                memory::probe_write(a.wrapping_add(i), 8, false)?;
            }
        }
        for i in 0..16 {
            if mask >> i & 1 != 0 {
                memory::write(a.wrapping_add(i), 8, (value >> (i * 8)) as u64, false)?;
            }
        }
        Ok(())
    }
    unsafe fn read256(&mut self, aligned: bool) -> Result<(u128, u128), Fault> {
        let (a, stack) = address(self.0);
        if aligned {
            alignment(a, stack, 32)?;
        }
        let low = memory::read128(a, stack)?;
        Ok((low, memory::read128(a.wrapping_add(16), stack)?))
    }
    unsafe fn write256(&mut self, value: (u128, u128), aligned: bool) -> Result<(), Fault> {
        let (a, stack) = address(self.0);
        if aligned {
            alignment(a, stack, 32)?;
        }
        memory::probe_write(a, 128, stack)?;
        memory::probe_write(a.wrapping_add(16), 128, stack)?;
        memory::write128(a, value.0, stack)?;
        memory::write128(a.wrapping_add(16), value.1, stack)
    }
    unsafe fn read_lanes(
        &mut self,
        size: u8,
        count: u8,
        selected: u8,
    ) -> Result<(u128, u128), Fault> {
        let (a, stack) = address(self.0);
        let mut v = (0, 0);
        for n in 0..count {
            if selected >> n & 1 != 0 {
                let lane =
                    memory::read(a.wrapping_add((n * size) as u64), size * 8, stack)? as u128;
                let offset = n as u32 * size as u32;
                if offset < 16 {
                    v.0 |= lane << (offset * 8);
                }
                else {
                    v.1 |= lane << ((offset - 16) * 8);
                }
            }
        }
        Ok(v)
    }
    unsafe fn write_lanes(
        &mut self,
        size: u8,
        count: u8,
        value: (u128, u128),
        selected: u8,
    ) -> Result<(), Fault> {
        let (a, stack) = address(self.0);
        let lanes = (0..count).filter(|n| selected >> n & 1 != 0);
        for n in lanes.clone() {
            memory::probe_write(a.wrapping_add((n * size) as u64), size * 8, stack)?;
        }
        for n in lanes {
            let lane = avx::lane256(value, n as u32 * size as u32, size as u32);
            memory::write(a.wrapping_add((n * size) as u64), size * 8, lane, stack)?;
        }
        Ok(())
    }
    unsafe fn gpr(&mut self, r: u8) -> u64 { state::read_gpr(r as usize) }
    unsafe fn set_gpr(&mut self, r: u8, value: u64, wide: bool) {
        state::write_gpr(r as usize, value, if wide { 64 } else { 32 });
    }
    unsafe fn set_flags(&mut self, flags: u32) {
        state::write_flags64(state::read_flags64() & !0x8D5 | flags as u64);
    }
}
/// The x64 engine's operands of a BMI1 or BMI2 instruction (cpu::bmi)
struct Bmi<'a>(&'a Decoded);
impl crate::cpu::bmi::Machine for Bmi<'_> {
    type Fault = Fault;
    unsafe fn source(&mut self, bits: u32) -> Result<u64, Fault> {
        match self.0.rm_register {
            Some(r) => Ok(state::read_gpr(r as usize) & u64::MAX >> (64 - bits)),
            None => {
                let (a, stack) = address(self.0);
                memory::read(a, bits as u8, stack)
            },
        }
    }
    unsafe fn gpr(&mut self, r: u8) -> u64 { state::read_gpr(r as usize) }
    unsafe fn set_gpr(&mut self, r: u8, value: u64, bits: u32) {
        state::write_gpr(r as usize, value, bits as u8);
    }
    unsafe fn set_flags(&mut self, flags: u32) {
        state::write_flags64(state::read_flags64() & !0x8D5 | flags as u64);
    }
}
pub unsafe fn execute(d: &Decoded) -> Result<bool, Fault> {
    // BMI1 and BMI2 (exception type 13): general-purpose registers, without
    // the AVX state's requirements; 64-bit operands with VEX.W1 in 64-bit
    // mode, otherwise 32-bit
    if let Some(v) = d
        .vex
        .filter(|_| d.encoding.vex & crate::decode_rules::vex::GPR != 0)
    {
        use crate::cpu::bmi;
        let long = d.mode.is_long();
        let group = d.modrm.map_or(0, |m| m >> 3 & 7);
        let i = bmi::Instruction {
            op: bmi::Vex::of(d.opcode, group).ok_or(Fault::ud())?,
            reg: d.reg.unwrap_or(0),
            vvvv: v.vvvv & if long { 15 } else { 7 },
            bits: if long && v.w { 64 } else { 32 },
            imm8: d.immediate.map_or(0, |i| i.value as u8),
        };
        bmi::execute(&mut Bmi(d), &i)?;
        state::write_rip(d.next.0);
        return Ok(true);
    }
    if let Some(v) = d.vex {
        let mut machine = Avx(d);
        avx::check(&mut machine)?;
        let i = avx::Instruction {
            key: d.opcode,
            reg: d.reg.unwrap_or(0),
            vvvv: v.vvvv,
            rm: d.rm_register,
            // (a VEX.256 form: not a VEX.LIG one's VEX.L)
            l: v.l && d.encoding.vex & crate::decode_rules::vex::L1 != 0,
            w: v.w,
            imm8: d.immediate.map_or(0, |i| i.value as u8),
            long: true,
            // (a gather's VSIB operand: the address's index is its vector
            // register)
            vsib: (d.encoding.vex & crate::decode_rules::vex::VSIB != 0).then(|| {
                let a = d.address.unwrap();
                avx::Vsib {
                    index: a.index.unwrap(),
                    scale: a.scale,
                }
            }),
        };
        avx::execute(&mut machine, &i)?;
        state::write_rip(d.next.0);
        return Ok(true);
    }
    if x87(d)? {
        state::write_rip(d.next.0);
        return Ok(true);
    }
    if matches!(d.base_opcode() >> 8, 0x0F38 | 0x0F3A) {
        if !ssse3(d)? && !sse4(d)? {
            return Ok(false);
        }
        state::write_rip(d.next.0);
        return Ok(true);
    }
    if d.base_opcode() & 0xFF00 != 0x0F00 {
        return Ok(false);
    }
    if fxstate(d)?
        || arithmetic(d)?
        || conversion(d)?
        || moves(d)?
        || immediate_shift(d)?
        || packed_arithmetic(d)?
    {
        state::write_rip(d.next.0);
        Ok(true)
    }
    else {
        Ok(false)
    }
}
