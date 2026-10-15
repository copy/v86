//! AVX: the VEX-encoded SIMD instructions (docs/simd-xsave-plan.md, P5-P6).
//! One executor serves the 32-bit interpreter (crate::cpu::vex) and the x64
//! engine (crate::x64::vector); the IR region tiers' helper too until
//! docs/jit-unification-plan.md M11 deleted them.
//! An engine decodes the instruction (decode_rules::vex_row: the row exists,
//! has its semantics and accepts the VEX fields), calls `check` once all of
//! its bytes are fetched and before its operand's segment is checked, then
//! `execute`, which reaches memory, the general-purpose registers, FLAGS and
//! exception delivery through the engine's `Machine`. The XMM registers, the
//! upper halves of the YMM registers, MXCSR, CR0, CR4 and XCR0 are the same
//! state in every engine.
//!
//! The semantics are the legacy forms' (crate::cpu::simd_ops, simd_int, simd_fp)
//! with VEX's operands: VEX.vvvv is the first source, a VEX.128 form zeroes
//! bits 255:128 of its destination register (VMOVSS/VMOVSD between registers
//! too), and every input is read before the destination is written, so any of
//! the operands may be the same register. A VEX.256 form (execute256) runs
//! them on each 128-bit half where it works lane by lane.
use crate::cpu::cpu::{self, reg128, CR0_TS, CR4_OSXSAVE, MXCSR_MASK};
use crate::cpu::global_pointers as gp;
use crate::cpu::simd_ops::{PackedOp, ShuffleOp, TransferOp};
use crate::cpu::{simd_fp, simd_int};

/// A decoded VEX instruction
#[derive(Clone, Copy, Debug)]
pub struct Instruction {
    /// The row's catalogue key 0xC4_MM_PP_OO (decode_rules::Vex::key)
    pub key: u32,
    /// ModRM.reg (with VEX.R): a register, or a group's opcode extension
    pub reg: u8,
    /// VEX.vvvv: a register, or 0 for a form without that operand
    pub vvvv: u8,
    /// ModRM.rm (with VEX.B) of a register form; None: the memory operand
    pub rm: Option<u8>,
    /// A VEX.256 form: VEX.L1 of a row that has one (a VEX.LIG form's VEX.L
    /// is not this)
    pub l: bool,
    pub w: bool,
    pub imm8: u8,
    /// 64-bit mode: XMM8-XMM15, and the 64-bit general-purpose operands of
    /// the VEX.W1 forms
    pub long: bool,
    /// A gather's VSIB memory operand (whose address is then that of its
    /// base and displacement)
    pub vsib: Option<Vsib>,
}
/// A VSIB memory operand's indices: their vector register and the scale
/// (log2)
#[derive(Clone, Copy, Debug)]
pub struct Vsib {
    pub index: u8,
    pub scale: u8,
}

/// An exception the executor raises
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exception {
    /// #UD
    InvalidOpcode,
    /// #NM
    DeviceNotAvailable,
    /// #GP(0)
    GeneralProtection,
    /// An unmasked SIMD floating-point exception: #XM, or #UD without
    /// CR4.OSXMMEXCPT
    SimdFloatingPoint,
}

/// An engine's side of an instruction
pub trait Machine {
    /// An exception that ends the instruction (the interpreter delivers it
    /// when raised)
    type Fault;
    unsafe fn raise(&mut self, e: Exception) -> Self::Fault;
    /// `bytes` (1, 2, 4, 8 or 16) of the memory operand, zero-extended;
    /// `aligned`: #GP(0) unless the operand is aligned to 16 bytes
    unsafe fn read(&mut self, bytes: u8, aligned: bool) -> Result<u128, Self::Fault>;
    /// The low `bytes` of `value` to the memory operand
    unsafe fn write(&mut self, bytes: u8, value: u128, aligned: bool) -> Result<(), Self::Fault>;
    /// A VEX.256 form's 32-byte memory operand: its low and high halves;
    /// `aligned`: #GP(0) unless the operand is aligned to 32 bytes
    unsafe fn read256(&mut self, aligned: bool) -> Result<(u128, u128), Self::Fault>;
    /// ... `value` to it, nothing unless all of it can be written
    unsafe fn write256(&mut self, value: (u128, u128), aligned: bool) -> Result<(), Self::Fault>;
    /// VMASKMOVDQU: the bytes of `value` whose bit in `mask` is set, to
    /// (E/R)DI in DS or the segment prefix's
    unsafe fn write_masked(&mut self, value: u128, mask: u16) -> Result<(), Self::Fault>;
    /// VMASKMOVPS/PD: the `count` lanes of `size` bytes (4, 8) of the memory
    /// operand whose bit in `selected` is set, the others zero, as a value's
    /// low and high halves (bytes 16 to 31: a VEX.256 form's); only they are
    /// accessed (no fault for another)
    unsafe fn read_lanes(
        &mut self,
        size: u8,
        count: u8,
        selected: u8,
    ) -> Result<(u128, u128), Self::Fault>;
    /// VMASKMOVPS/PD: the selected lanes of `value` to the memory operand,
    /// none unless every one can be written
    unsafe fn write_lanes(
        &mut self,
        size: u8,
        count: u8,
        value: (u128, u128),
        selected: u8,
    ) -> Result<(), Self::Fault>;
    /// A gather's element: `bytes` (4, 8) at the memory operand's address
    /// plus `offset` (the element's sign-extended, scaled index), with the
    /// address size's wraparound
    unsafe fn gather(&mut self, offset: u64, bytes: u8) -> Result<u64, Self::Fault>;
    unsafe fn gpr(&mut self, r: u8) -> u64;
    /// The low 32 bits of `value` (zero-extended in 64-bit mode), or all 64
    /// with `wide`
    unsafe fn set_gpr(&mut self, r: u8, value: u64, wide: bool);
    /// OF, SF, ZF, AF, PF and CF to those of `flags`
    unsafe fn set_flags(&mut self, flags: u32);
}

/// The exceptions of every AVX instruction before its operands (SDM vol. 2,
/// 2.8, the exception types of VEX-encoded forms): #UD unless the operating
/// system enabled the AVX state (CR4.OSXSAVE and XCR0[2:1] = 11b), then #NM
/// with CR0.TS. Unlike legacy SSE, CR0.EM and CR4.OSFXSR do not matter.
pub unsafe fn check<M: Machine>(m: &mut M) -> Result<(), M::Fault> {
    if *gp::cr.add(4) & CR4_OSXSAVE == 0 || *gp::xcr0 & 6 != 6 {
        return Err(m.raise(Exception::InvalidOpcode));
    }
    if *gp::cr & CR0_TS != 0 {
        return Err(m.raise(Exception::DeviceNotAvailable));
    }
    Ok(())
}

/// The catalogue key of the legacy form whose semantics a VEX form has: 66
/// 0F 58 for VEX.66.0F 58, 66 0F 38 00 for VEX.66.0F38 00
pub fn legacy(key: u32) -> u32 {
    let prefix = [0, 0x66, 0xF3, 0xF2][(key >> 8 & 3) as usize];
    let op = key & 0xFF;
    match key >> 16 & 0xFF {
        1 => prefix << 16 | 0x0F00 | op,
        2 => prefix << 24 | 0x0F3800 | op,
        _ => prefix << 24 | 0x0F3A00 | op,
    }
}

unsafe fn xmm(r: u8) -> u128 { cpu::read_xmm128s(r as i32).bits() }
/// A VEX.128 destination register: bits 255:128 zeroed
unsafe fn set_xmm(r: u8, value: u128) {
    cpu::write_xmm_reg128(r as i32, reg128::of_bits(value));
    *gp::ymm_hi.add(r as usize) = reg128::of_bits(0);
}
/// YMM register `r`: bits 127:0 and 255:128
unsafe fn ymm(r: u8) -> (u128, u128) { (xmm(r), (*gp::ymm_hi.add(r as usize)).bits()) }
/// A VEX.256 destination register
unsafe fn set_ymm(r: u8, (low, high): (u128, u128)) {
    cpu::write_xmm_reg128(r as i32, reg128::of_bits(low));
    *gp::ymm_hi.add(r as usize) = reg128::of_bits(high);
}
/// A VEX.256 form's r/m operand: a register, or 32 bytes of memory
unsafe fn source256<M: Machine>(
    m: &mut M,
    i: &Instruction,
    aligned: bool,
) -> Result<(u128, u128), M::Fault> {
    match i.rm {
        Some(r) => Ok(ymm(r)),
        None => m.read256(aligned),
    }
}
/// The lane at byte `offset` of `size` bytes of a 256-bit value
pub fn lane256(v: (u128, u128), offset: u32, size: u32) -> u64 {
    let half = if offset < 16 { v.0 } else { v.1 };
    (half >> (offset % 16 * 8)) as u64 & (u64::MAX >> (64 - size * 8))
}
/// The r/m operand: a register, or `bytes` of memory
unsafe fn source<M: Machine>(
    m: &mut M,
    i: &Instruction,
    bytes: u8,
    aligned: bool,
) -> Result<u128, M::Fault> {
    match i.rm {
        Some(r) => Ok(xmm(r)),
        None => m.read(bytes, aligned),
    }
}
/// The shifts by imm8 (`op` 71, 72 or 73, `group` its ModRM.reg) of 128
/// bits: PSRLW/PSRAW/PSLLW, PSRLD/PSRAD/PSLLD, PSRLQ/PSRLDQ/PSLLQ/PSLLDQ
fn shift_imm(op: u8, group: u8, v: u128, count: u32) -> u128 {
    match (op, group) {
        (0x73, 3) => {
            if count < 16 {
                v >> (8 * count)
            }
            else {
                0
            }
        },
        (0x73, 7) => {
            if count < 16 {
                v << (8 * count)
            }
            else {
                0
            }
        },
        (_, group) => {
            let id = [0xD1, 0xE1, 0xF1][(group / 2 - 1) as usize] + (op as u32 - 0x71);
            packed(PackedOp::from_id(id).unwrap(), v, count as u128)
        },
    }
}
/// The element size of VBROADCASTSS/SD (18, 19), VPBROADCASTD/Q (58, 59) and
/// VPBROADCASTB/W (78, 79)
fn broadcast_size(op: u8) -> u32 {
    match op {
        0x78 => 1,
        0x79 => 2,
        0x18 | 0x58 => 4,
        _ => 8,
    }
}
/// `v` (`size` bytes) in each lane of 128 bits
fn splat(v: u128, size: u32) -> u128 {
    let mut r = v;
    let mut bits = size * 8;
    while bits < 128 {
        r |= r << bits;
        bits *= 2;
    }
    r
}
/// A broadcast's element: `size` bytes of memory, or the low lane of the r/m
/// register
unsafe fn element<M: Machine>(m: &mut M, i: &Instruction, size: u32) -> Result<u128, M::Fault> {
    Ok(match i.rm {
        Some(r) => xmm(r) & u128::MAX >> (128 - 8 * size),
        None => m.read(size as u8, false)?,
    })
}
/// VPBLENDD of 128 bits: dword n from `b` where bit n of `select` is set,
/// else from `a`
fn blend_dwords(a: u128, b: u128, select: u8) -> u128 {
    let mut mask = 0;
    for n in 0..4 {
        if select >> n & 1 != 0 {
            mask |= 0xFFFF_FFFF << (32 * n);
        }
    }
    a & !mask | b & mask
}
/// VPSRLVD/Q (45), VPSRAVD (46), VPSLLVD/Q (47) of 128 bits: each element of
/// `a` (`qword`: quadwords, else dwords) shifted by the unsigned count in the
/// same element of `b`; from the element's width on, the logical shifts give
/// 0, VPSRAVD the sign
fn shift_variable(op: u8, qword: bool, a: u128, b: u128) -> u128 {
    let bits = if qword { 64 } else { 32 };
    let mask = u128::MAX >> (128 - bits);
    let mut r = 0;
    for at in (0..128).step_by(bits as usize) {
        let (x, count) = (a >> at & mask, b >> at & mask);
        let v = match op {
            0x45 if count < bits as u128 => x >> count,
            0x47 if count < bits as u128 => x << count & mask,
            0x46 => (x as u32 as i32 >> count.min(31)) as u32 as u128,
            _ => 0,
        };
        r |= v << at;
    }
    r
}
/// The lanes of `v` (`size` 4 or 8 bytes) at the indices `index(n)` of the
/// result's lane n, over 256 bits (VPERMD/PS/Q/PD)
fn permute256(v: (u128, u128), size: u32, index: impl Fn(u32) -> u32) -> (u128, u128) {
    let mut r = [0; 2];
    for n in 0..32 / size {
        let at = n * size * 8;
        r[(at / 128) as usize] |= (lane256(v, size * index(n), size) as u128) << (at % 128);
    }
    (r[0], r[1])
}
/// VPGATHERDD/DQ/QD/QQ, VGATHERDPS/DPD/QPS/QPD (90 to 93; VEX.W1: quadword
/// data; 91 and 93: quadword indices). As the SDM's operation: the mask
/// (VEX.vvvv) first, each element all ones or zero by its sign and zero
/// beyond the elements; then each element in turn, loaded into the
/// destination if selected, its mask cleared (a fault leaves the elements
/// before it done, so the instruction restarts with the rest); last, the
/// destination zero beyond the elements
unsafe fn gather<M: Machine>(m: &mut M, i: &Instruction) -> Result<(), M::Fault> {
    let vsib = i.vsib.unwrap();
    let data = if i.w { 8 } else { 4 };
    let index_size = if i.key & 1 != 0 { 8 } else { 4 };
    let count = if i.l { 32 } else { 16 } / data.max(index_size);
    let bytes = |v: (u128, u128)| {
        let mut b = [0u8; 32];
        b[..16].copy_from_slice(&v.0.to_le_bytes());
        b[16..].copy_from_slice(&v.1.to_le_bytes());
        b
    };
    let halves = |b: &[u8; 32]| {
        (
            u128::from_le_bytes(b[..16].try_into().unwrap()),
            u128::from_le_bytes(b[16..].try_into().unwrap()),
        )
    };
    let (mut mask, mut destination, index) = (
        bytes(ymm(i.vvvv)),
        bytes(ymm(i.reg)),
        bytes(ymm(vsib.index)),
    );
    for n in 0..count {
        let sign = mask[(n + 1) * data - 1] >> 7;
        mask[n * data..(n + 1) * data].fill(if sign != 0 { 0xFF } else { 0 });
    }
    mask[count * data..].fill(0);
    set_ymm(i.vvvv, halves(&mask));
    for n in 0..count {
        if mask[n * data] != 0 {
            let mut raw = [0u8; 8];
            raw[..index_size].copy_from_slice(&index[n * index_size..(n + 1) * index_size]);
            let raw = u64::from_le_bytes(raw);
            let element = if index_size == 4 { raw as u32 as i32 as i64 as u64 } else { raw };
            let value = m.gather(element.wrapping_shl(vsib.scale as u32), data as u8)?;
            destination[n * data..(n + 1) * data].copy_from_slice(&value.to_le_bytes()[..data]);
            set_ymm(i.reg, halves(&destination));
        }
        mask[n * data..(n + 1) * data].fill(0);
        set_ymm(i.vvvv, halves(&mask));
    }
    destination[count * data..].fill(0);
    set_ymm(i.reg, halves(&destination));
    Ok(())
}
fn packed(op: PackedOp, a: u128, b: u128) -> u128 {
    u128::from_le_bytes(op.apply(a.to_le_bytes(), b.to_le_bytes()))
}
/// A function of byte vectors on 128-bit values
fn bytes(f: impl FnOnce([u8; 16]) -> [u8; 16], v: u128) -> u128 {
    u128::from_le_bytes(f(v.to_le_bytes()))
}
/// The low `bytes` bytes
fn low(bytes: u32) -> u128 { u128::MAX >> (128 - 8 * bytes) }
/// VPERMILPS, VPERMILPD: the lanes of `v` (`size` 4 or 8 bytes) at the
/// indices of `index`
fn permute(v: u128, size: u32, index: impl Fn(u32) -> u32) -> u128 {
    (0..16 / size).fold(0, |r, n| {
        r | (v >> (index(n) * size * 8) & low(size)) << (n * size * 8)
    })
}
/// The sign bits of `v`'s lanes of `lane` bytes
fn sign_mask(v: u128, lane: u32) -> u64 {
    (0..16 / lane).fold(0, |mask, n| {
        mask | ((v >> (n * lane * 8 + lane * 8 - 1)) as u64 & 1) << n
    })
}
/// ... of a 256-bit value's lanes
fn sign_mask256(v: (u128, u128), lane: u32) -> u64 {
    sign_mask(v.0, lane) | sign_mask(v.1, lane) << (16 / lane)
}

/// Execute `i` (after `check`)
pub unsafe fn execute<M: Machine>(m: &mut M, i: &Instruction) -> Result<(), M::Fault> {
    if i.l {
        return execute256(m, i);
    }
    const LOW: u128 = u64::MAX as u128;
    let (map, pp, op) = (i.key >> 16 & 0xFF, i.key >> 8 & 3, i.key as u8);
    // (the general-purpose operands of VEX.W1 forms, in 64-bit mode)
    let wide = i.long && i.w;
    // VMOVSS and VMOVSD: the bytes of the scalar and its lanes' mask
    let scalar = if pp == 2 { (4, 0xFFFF_FFFF) } else { (8, LOW) };
    match (map, pp, op) {
        // VMOVUPS, VMOVUPD, VMOVAPS, VMOVAPD, VMOVDQA, VMOVDQU, VLDDQU and
        // VMOVNTDQA, the aligned ones #GP(0) otherwise
        (1, 0 | 1, 0x10 | 0x28) | (1, 1 | 2, 0x6F) | (1, 3, 0xF0) | (2, 1, 0x2A) => {
            let aligned = matches!(op, 0x28 | 0x2A) || op == 0x6F && pp == 1;
            let v = source(m, i, 16, aligned)?;
            set_xmm(i.reg, v);
        },
        // their stores, and VMOVNTPS, VMOVNTPD, VMOVNTDQ
        (1, 0 | 1, 0x11 | 0x29 | 0x2B) | (1, 1 | 2, 0x7F) | (1, 1, 0xE7) => {
            let aligned = matches!(op, 0x29 | 0x2B | 0xE7) || op == 0x7F && pp == 1;
            let v = xmm(i.reg);
            match i.rm {
                Some(r) => set_xmm(r, v),
                None => m.write(16, v, aligned)?,
            }
        },
        // VMOVSS, VMOVSD: from memory zero-extended; between registers the
        // other lanes from the first source
        (1, 2 | 3, 0x10) => {
            let v = match i.rm {
                Some(r) => xmm(i.vvvv) & !scalar.1 | xmm(r) & scalar.1,
                None => m.read(scalar.0, false)?,
            };
            set_xmm(i.reg, v);
        },
        (1, 2 | 3, 0x11) => match i.rm {
            Some(r) => set_xmm(r, xmm(i.vvvv) & !scalar.1 | xmm(i.reg) & scalar.1),
            None => m.write(scalar.0, xmm(i.reg) & scalar.1, false)?,
        },
        // VMOVHLPS, VMOVLPS, VMOVLPD: the low quadword from the source's
        // high one or memory, the high one from the first source
        (1, 0 | 1, 0x12) => {
            let low = match i.rm {
                Some(r) => xmm(r) >> 64,
                None => m.read(8, false)?,
            };
            set_xmm(i.reg, xmm(i.vvvv) & !LOW | low);
        },
        // VMOVLHPS, VMOVHPS, VMOVHPD: the high quadword from the source's
        // low one or memory, the low one from the first source
        (1, 0 | 1, 0x16) => {
            let high = match i.rm {
                Some(r) => xmm(r) & LOW,
                None => m.read(8, false)?,
            };
            set_xmm(i.reg, xmm(i.vvvv) & LOW | high << 64);
        },
        // VMOVLPS, VMOVLPD, VMOVHPS, VMOVHPD m64, xmm
        (1, 0 | 1, 0x13) => m.write(8, xmm(i.reg) & LOW, false)?,
        (1, 0 | 1, 0x17) => m.write(8, xmm(i.reg) >> 64, false)?,
        // VMOVSLDUP, VMOVSHDUP, VMOVDDUP (from 64 bits of memory)
        (1, 2, 0x12 | 0x16) | (1, 3, 0x12) => {
            let v = source(m, i, if pp == 3 { 8 } else { 16 }, false)?;
            let t = TransferOp::from_encoding(legacy(i.key)).unwrap();
            set_xmm(
                i.reg,
                u128::from_le_bytes(t.apply([0; 16], v.to_le_bytes())),
            );
        },
        // VUNPCKLPS, VUNPCKLPD, VUNPCKHPS, VUNPCKHPD; VANDPS, VANDPD,
        // VANDNPS, VANDNPD, VORPS, VORPD, VXORPS, VXORPD; the packed integer
        // operations of 66 0F: unpacks, packs, compares, shifts by xmm/m128
        // (the count in its low quadword), arithmetic and logic
        (1, 0 | 1, 0x14 | 0x15 | 0x54..=0x57)
        | (
            1,
            1,
            0x60..=0x6D
            | 0x74..=0x76
            | 0xD1..=0xD5
            | 0xD8..=0xDF
            | 0xE0..=0xE5
            | 0xE8..=0xEF
            | 0xF1..=0xF6
            | 0xF8..=0xFE,
        ) => {
            let b = source(m, i, 16, false)?;
            let p = PackedOp::from_encoding(legacy(i.key)).unwrap();
            set_xmm(i.reg, packed(p, xmm(i.vvvv), b));
        },
        // VPSRLW/VPSRAW/VPSLLW, VPSRLD/VPSRAD/VPSLLD, VPSRLQ/VPSRLDQ/VPSLLQ/
        // VPSLLDQ by imm8: VEX.vvvv is the destination, the r/m register the
        // source
        (1, 1, 0x71..=0x73) => {
            let v = xmm(i.rm.unwrap());
            set_xmm(i.vvvv, shift_imm(op, i.reg & 7, v, i.imm8 as u32));
        },
        // VSQRT, VADD, VMUL, VSUB, VMIN, VDIV, VMAX PS/PD/SS/SD, VHADDPS/PD,
        // VHSUBPS/PD, VADDSUBPS/PD; VCMP* with 32 predicates: a scalar
        // form's other lanes from the first source (VSQRTPS/PD: one source)
        (1, 0..=3, 0x51 | 0x58 | 0x59 | 0x5C..=0x5F | 0xC2) | (1, 1 | 3, 0x7C | 0x7D | 0xD0) => {
            let scalar = pp >= 2 && !matches!(op, 0x7C | 0x7D | 0xD0);
            let bytes = match (scalar, pp) {
                (false, _) => 16,
                (true, 2) => 4,
                _ => 8,
            };
            let b = source(m, i, bytes, false)?;
            let r = if op == 0xC2 {
                simd_fp::compare(legacy(i.key), xmm(i.vvvv), b, i.imm8)
            }
            else {
                simd_fp::arithmetic(legacy(i.key), xmm(i.vvvv), b, 0)
            };
            let r = r.map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_xmm(i.reg, r);
        },
        // VRSQRTPS/SS, VRCPPS/SS: no exceptions
        (1, 0 | 2, 0x52 | 0x53) => {
            let b = source(m, i, if pp == 2 { 4 } else { 16 }, false)?;
            set_xmm(i.reg, simd_fp::reciprocal(legacy(i.key), xmm(i.vvvv), b));
        },
        // VUCOMISS/SD, VCOMISS/SD: ZF, PF and CF
        (1, 0 | 1, 0x2E | 0x2F) => {
            let b = source(m, i, if pp == 0 { 4 } else { 8 }, false)?;
            let flags = simd_fp::compare_flags(legacy(i.key), xmm(i.reg), b)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            m.set_flags(flags);
        },
        // VCVTSI2SS/SD: from a general-purpose register or memory (64 bits
        // with VEX.W1 in 64-bit mode) into the first source's low lane
        (1, 2 | 3, 0x2A) => {
            let value = match i.rm {
                Some(r) => m.gpr(r),
                None => m.read(if wide { 8 } else { 4 }, false)? as u64,
            };
            let value = if wide { value } else { value & 0xFFFF_FFFF };
            let r = simd_fp::convert(legacy(i.key), wide, xmm(i.vvvv), value as u128)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_xmm(i.reg, r);
        },
        // VCVTSS2SI, VCVTTSS2SI, VCVTSD2SI, VCVTTSD2SI: to a general-purpose
        // register (64-bit with VEX.W1 in 64-bit mode)
        (1, 2 | 3, 0x2C | 0x2D) => {
            let b = source(m, i, if pp == 2 { 4 } else { 8 }, false)?;
            let r = simd_fp::convert(legacy(i.key), wide, 0, b)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            m.set_gpr(i.reg, r as u64, wide);
        },
        // VCVTPS2PD (m64), VCVTPD2PS, VCVTSS2SD (m32), VCVTSD2SS (m64);
        // VCVTDQ2PS, VCVTPS2DQ, VCVTTPS2DQ; VCVTTPD2DQ, VCVTDQ2PD (m64),
        // VCVTPD2DQ: a scalar form's other lanes from the first source
        (1, 0..=3, 0x5A) | (1, 0..=2, 0x5B) | (1, 1..=3, 0xE6) => {
            let bytes = match (op, pp) {
                (0x5A, 0) | (0x5A, 3) | (0xE6, 2) => 8,
                (0x5A, 2) => 4,
                _ => 16,
            };
            let b = source(m, i, bytes, false)?;
            let r = simd_fp::convert(legacy(i.key), false, xmm(i.vvvv), b)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_xmm(i.reg, r);
        },
        // VROUNDPS/PD (one source), VROUNDSS/SD
        (3, 1, 0x08..=0x0B) => {
            let b = source(m, i, [16, 16, 4, 8][(op - 8) as usize], false)?;
            let r = simd_fp::round(legacy(i.key), xmm(i.vvvv), b, i.imm8)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_xmm(i.reg, r);
        },
        // VDPPS, VDPPD
        (3, 1, 0x40 | 0x41) => {
            let b = source(m, i, 16, false)?;
            let r = simd_fp::dot_product(op == 0x41, xmm(i.vvvv), b, i.imm8)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_xmm(i.reg, r);
        },
        // VBLENDVPS, VBLENDVPD: the mask register is imm8[7:4] (bit 7
        // ignored outside 64-bit mode)
        (3, 1, 0x4A | 0x4B) => {
            let b = source(m, i, 16, false)?;
            let selector = xmm(i.imm8 >> 4 & if i.long { 15 } else { 7 }).to_le_bytes();
            let a = xmm(i.vvvv).to_le_bytes();
            let legacy = if op == 0x4A { 0x14 } else { 0x15 };
            set_xmm(i.reg, bytes(|b| simd_int::sse4(legacy, a, b, selector), b));
        },
        // VBROADCASTSS xmm, m32 (AVX2: also xmm); VPBROADCASTB, VPBROADCASTW,
        // VPBROADCASTD, VPBROADCASTQ (AVX2): an element of memory or of the
        // r/m register's low lane in each lane
        (2, 1, 0x18 | 0x58 | 0x59 | 0x78 | 0x79) => {
            let size = broadcast_size(op);
            let v = element(m, i, size)?;
            set_xmm(i.reg, splat(v, size));
        },
        // VPGATHERDD/DQ/QD/QQ, VGATHERDPS/DPD/QPS/QPD (AVX2, P8)
        (2, 1, 0x90..=0x93) => gather(m, i)?,
        // VPSRLVD/Q, VPSRAVD, VPSLLVD/Q (AVX2; VEX.W1: quadwords): each
        // element by the count in the same element of the second source
        (2, 1, 0x45..=0x47) => {
            let b = source(m, i, 16, false)?;
            set_xmm(i.reg, shift_variable(op, i.w, xmm(i.vvvv), b));
        },
        // VPBLENDD (AVX2): the dwords imm8 selects from the second source,
        // the others from the first
        (3, 1, 0x02) => {
            let b = source(m, i, 16, false)?;
            set_xmm(i.reg, blend_dwords(xmm(i.vvvv), b, i.imm8));
        },
        // VPERMILPS, VPERMILPD: the first source's lanes at the indices of
        // the second's lanes (bits 1:0 of each dword, bit 1 of each quadword)
        (2, 1, 0x0C | 0x0D) => {
            let index = source(m, i, 16, false)?;
            let a = xmm(i.vvvv);
            let r = if op == 0x0C {
                permute(a, 4, |n| (index >> (32 * n)) as u32 & 3)
            }
            else {
                permute(a, 8, |n| (index >> (64 * n + 1)) as u32 & 1)
            };
            set_xmm(i.reg, r);
        },
        // ... and at the indices of imm8 (two bits per dword, one per quadword)
        (3, 1, 0x04 | 0x05) => {
            let v = source(m, i, 16, false)?;
            let r = if op == 0x04 {
                permute(v, 4, |n| (i.imm8 >> (2 * n)) as u32 & 3)
            }
            else {
                permute(v, 8, |n| (i.imm8 >> n) as u32 & 1)
            };
            set_xmm(i.reg, r);
        },
        // VTESTPS, VTESTPD: ZF and CF of the lanes' sign bits, AF, OF, PF,
        // SF cleared
        (2, 1, 0x0E | 0x0F) => {
            let b = source(m, i, 16, false)?;
            let signs: u128 = if op == 0x0E {
                0x8000_0000_8000_0000_8000_0000_8000_0000
            }
            else {
                0x8000_0000_0000_0000_8000_0000_0000_0000
            };
            let a = xmm(i.reg);
            let (zf, cf) = (a & b & signs == 0, !a & b & signs == 0);
            m.set_flags((zf as u32) << 6 | cf as u32);
        },
        // VMASKMOVPS, VMASKMOVPD; AVX2: VPMASKMOVD, VPMASKMOVQ (VEX.W1)
        // xmm, xmm, m128: the lanes of memory the first source's sign bits
        // select, the others zero
        (2, 1, 0x2C | 0x2D | 0x8C) => {
            let size = if op == 0x2C || op == 0x8C && !i.w { 4 } else { 8 };
            let selected = sign_mask(xmm(i.vvvv), size as u32) as u8;
            let v = m.read_lanes(size, 16 / size, selected)?;
            set_xmm(i.reg, v.0);
        },
        // ... m128, xmm, xmm: ModRM.reg's lanes that VEX.vvvv's sign bits
        // select
        (2, 1, 0x2E | 0x2F | 0x8E) => {
            let size = if op == 0x2E || op == 0x8E && !i.w { 4 } else { 8 };
            let selected = sign_mask(xmm(i.vvvv), size as u32) as u8;
            m.write_lanes(size, 16 / size, (xmm(i.reg), 0), selected)?;
        },
        // VSHUFPS, VSHUFPD: the low lanes from the first source, the high
        // ones from the second, as imm8 selects
        (1, 0 | 1, 0xC6) => {
            let b = source(m, i, 16, false)?;
            let shuffle = ShuffleOp::from_encoding(legacy(i.key)).unwrap();
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(i.reg, bytes(|b| shuffle.apply(a, b, i.imm8), b));
        },
        // VPSHUFD, VPSHUFHW, VPSHUFLW: the source's lanes as imm8 selects
        (1, 1..=3, 0x70) => {
            let v = source(m, i, 16, false)?;
            let shuffle = ShuffleOp::from_encoding(legacy(i.key)).unwrap();
            set_xmm(i.reg, bytes(|v| shuffle.apply([0; 16], v, i.imm8), v));
        },
        // VPINSRW: a general-purpose register's low word or an m16 into the
        // first source's word imm8[2:0]
        (1, 1, 0xC4) => {
            let value = match i.rm {
                Some(r) => m.gpr(r) as u128 & 0xFFFF,
                None => m.read(2, false)?,
            };
            let at = (i.imm8 as u32 & 7) * 16;
            set_xmm(i.reg, xmm(i.vvvv) & !(0xFFFF << at) | value << at);
        },
        // VPEXTRW (C5): word imm8[2:0] to a general-purpose register
        (1, 1, 0xC5) => {
            let v = xmm(i.rm.unwrap()) >> ((i.imm8 as u32 & 7) * 16) & 0xFFFF;
            m.set_gpr(i.reg, v as u64, wide);
        },
        // SSSE3: VPSHUFB, VPHADDW/D/SW, VPMADDUBSW, VPHSUBW/D/SW,
        // VPSIGNB/W/D, VPMULHRSW; VPABSB/W/D (of the source alone)
        (2, 1, 0x00..=0x0B | 0x1C..=0x1E) => {
            let b = source(m, i, 16, false)?;
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(i.reg, bytes(|b| simd_int::ssse3(op, a, b), b));
        },
        // VPTEST: ZF and CF
        (2, 1, 0x17) => {
            let b = source(m, i, 16, false)?;
            let (zf, cf) = simd_int::ptest(xmm(i.reg).to_le_bytes(), b.to_le_bytes());
            m.set_flags((zf as u32) << 6 | cf as u32);
        },
        // VPMOVSX*, VPMOVZX*: the source's low lanes extended (from memory,
        // those bytes only)
        (2, 1, 0x20..=0x25 | 0x30..=0x35) => {
            let b = source(m, i, [8, 4, 2, 8, 4, 8][(op & 7) as usize], false)?;
            set_xmm(i.reg, bytes(|b| simd_int::sse4(op, [0; 16], b, [0; 16]), b));
        },
        // VPMULDQ, VPCMPEQQ, VPACKUSDW, VPCMPGTQ, VPMINSB/SD/UW/UD,
        // VPMAXSB/SD/UW/UD, VPMULLD; VPHMINPOSUW (of the source alone)
        (2, 1, 0x28 | 0x29 | 0x2B | 0x37..=0x41) => {
            let b = source(m, i, 16, false)?;
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(i.reg, bytes(|b| simd_int::sse4(op, a, b, [0; 16]), b));
        },
        // VBLENDPS, VBLENDPD, VPBLENDW, VMPSADBW
        (3, 1, 0x0C..=0x0E | 0x42) => {
            let b = source(m, i, 16, false)?;
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(i.reg, bytes(|b| simd_int::sse4_imm(op, a, b, i.imm8), b));
        },
        // VPALIGNR
        (3, 1, 0x0F) => {
            let b = source(m, i, 16, false)?;
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(i.reg, bytes(|b| simd_int::palignr(a, b, i.imm8), b));
        },
        // VPEXTRB, VPEXTRW, VPEXTRD/VPEXTRQ, VEXTRACTPS: an element to a
        // general-purpose register (zero-extended) or memory
        (3, 1, 0x14..=0x17) => {
            let size = match op {
                0x14 => 1,
                0x15 => 2,
                0x16 if wide => 8,
                _ => 4,
            };
            let v = xmm(i.reg) >> ((i.imm8 as u32 & (16 / size - 1)) * size * 8) & low(size);
            match i.rm {
                Some(r) => m.set_gpr(r, v as u64, wide),
                None => m.write(size as u8, v, false)?,
            }
        },
        // VPINSRB, VPINSRD/VPINSRQ: a general-purpose register's low bytes or
        // memory into the first source's element imm8
        (3, 1, 0x20 | 0x22) => {
            let size = if op == 0x20 {
                1
            }
            else if wide {
                8
            }
            else {
                4
            };
            let value = match i.rm {
                Some(r) => m.gpr(r) as u128 & low(size),
                None => m.read(size as u8, false)?,
            };
            let at = (i.imm8 as u32 & (16 / size - 1)) * size * 8;
            set_xmm(i.reg, xmm(i.vvvv) & !(low(size) << at) | value << at);
        },
        // VINSERTPS: the source register's dword imm8[7:6], or the m32
        (3, 1, 0x21) => {
            let value = match i.rm {
                Some(r) => (xmm(r) >> ((i.imm8 >> 6) * 32)) as u32,
                None => m.read(4, false)? as u32,
            };
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(
                i.reg,
                u128::from_le_bytes(simd_int::insertps(a, value, i.imm8)),
            );
        },
        // VPBLENDVB: the mask register is imm8[7:4] (bit 7 ignored outside
        // 64-bit mode)
        (3, 1, 0x4C) => {
            let b = source(m, i, 16, false)?;
            let selector = xmm(i.imm8 >> 4 & if i.long { 15 } else { 7 }).to_le_bytes();
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(i.reg, bytes(|b| simd_int::sse4(0x10, a, b, selector), b));
        },
        // VPCMPESTRM, VPCMPESTRI, VPCMPISTRM, VPCMPISTRI: the explicit
        // lengths in EAX and EDX (RAX and RDX with VEX.W1 in 64-bit mode); the
        // index to ECX (zero-extended) or the mask to XMM0
        (3, 1, 0x60..=0x63) => {
            let b = source(m, i, 16, false)?;
            let length = |m: &mut M, r| {
                let v = m.gpr(r);
                if wide {
                    v as i64
                }
                else {
                    v as i32 as i64
                }
            };
            let (la, lb) =
                if op < 0x62 { (Some(length(m, 0)), Some(length(m, 2))) } else { (None, None) };
            let r = simd_int::compare_strings(
                i.imm8,
                xmm(i.reg).to_le_bytes(),
                b.to_le_bytes(),
                la,
                lb,
            );
            if op & 1 != 0 {
                m.set_gpr(1, r.index as u64, false);
            }
            else {
                set_xmm(0, u128::from_le_bytes(r.xmm0));
            }
            m.set_flags(r.flags as u32);
        },
        // VMOVMSKPS, VMOVMSKPD, VPMOVMSKB: the lanes' sign bits
        (1, 0 | 1, 0x50) | (1, 1, 0xD7) => {
            let lane = if op == 0xD7 {
                1
            }
            else if pp == 0 {
                4
            }
            else {
                8
            };
            let mask = sign_mask(xmm(i.rm.unwrap()), lane);
            m.set_gpr(i.reg, mask, wide);
        },
        // VMOVD, VMOVQ xmm, r/m32 or r/m64: zero-extended
        (1, 1, 0x6E) => {
            let v = match i.rm {
                Some(r) => m.gpr(r) & if wide { u64::MAX } else { 0xFFFF_FFFF },
                None => m.read(if wide { 8 } else { 4 }, false)? as u64,
            };
            set_xmm(i.reg, v as u128);
        },
        // VMOVD, VMOVQ r/m32 or r/m64, xmm
        (1, 1, 0x7E) => {
            let v = xmm(i.reg) as u64 & if wide { u64::MAX } else { 0xFFFF_FFFF };
            match i.rm {
                Some(r) => m.set_gpr(r, v, wide),
                None => m.write(if wide { 8 } else { 4 }, v as u128, false)?,
            }
        },
        // VMOVQ xmm, xmm/m64 and xmm/m64, xmm: the low quadword, zero-extended
        (1, 2, 0x7E) => {
            let v = source(m, i, 8, false)? & LOW;
            set_xmm(i.reg, v);
        },
        (1, 1, 0xD6) => {
            let v = xmm(i.reg) & LOW;
            match i.rm {
                Some(r) => set_xmm(r, v),
                None => m.write(8, v, false)?,
            }
        },
        // VZEROUPPER: bits 255:128 of YMM0-YMM7, in 64-bit mode of YMM0-YMM15
        (1, 0, 0x77) => {
            for r in 0..if i.long { 16 } else { 8 } {
                *gp::ymm_hi.add(r) = reg128::of_bits(0);
            }
        },
        // VLDMXCSR (#GP(0) for a reserved bit), VSTMXCSR
        (1, 0, 0xAE) if i.reg & 7 == 2 => {
            let v = m.read(4, false)? as i32;
            if v & !MXCSR_MASK != 0 {
                return Err(m.raise(Exception::GeneralProtection));
            }
            cpu::set_mxcsr(v);
        },
        (1, 0, 0xAE) if i.reg & 7 == 3 => m.write(4, *gp::mxcsr as u32 as u128, false)?,
        // VMASKMOVDQU: the bytes whose mask byte (in the r/m register) has
        // its top bit set
        (1, 1, 0xF7) => {
            let mask = sign_mask(xmm(i.rm.unwrap()), 1);
            m.write_masked(xmm(i.reg), mask as u16)?;
        },
        // FMA (P11): VFMADD/VFMSUB/VFNMADD/VFNMSUB 132/213/231 PS/PD/SS/SD,
        // VFMADDSUB/VFMSUBADD 132/213/231 PS/PD, rounded once
        // (simd_fp::fused); a scalar form's other lanes are the destination's
        (2, 1, 0x96..=0x9F | 0xA6..=0xAF | 0xB6..=0xBF) => {
            let scalar = op & 0xF >= 9 && op & 1 == 1;
            let c = source(
                m,
                i,
                if !scalar {
                    16
                }
                else if i.w {
                    8
                }
                else {
                    4
                },
                false,
            )?;
            let [r] = simd_fp::fused(op, i.w, [xmm(i.reg)], [xmm(i.vvvv)], [c])
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_xmm(i.reg, r);
        },
        // F16C (P11): VCVTPH2PS xmm, xmm/m64
        (2, 1, 0x13) => {
            let v = source(m, i, 8, false)?;
            let (r, _) =
                simd_fp::half_to_single(v, 4).map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_xmm(i.reg, r);
        },
        // VCVTPS2PH xmm/m64, xmm, imm8 (a register destination's other bits
        // zeroed)
        (3, 1, 0x1D) => {
            let r = simd_fp::single_to_half((xmm(i.reg), 0), 4, i.imm8)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            match i.rm {
                Some(rm) => set_xmm(rm, r),
                None => m.write(8, r, false)?,
            }
        },
        _ => {
            dbg_assert!(false, "VEX form {:x} without semantics", i.key);
            return Err(m.raise(Exception::InvalidOpcode));
        },
    }
    Ok(())
}

/// Execute VEX.256 form `i` (Instruction::l): the forms that work lane by
/// lane run their VEX.128 semantics on each 128-bit half, with a 32-byte
/// memory operand
unsafe fn execute256<M: Machine>(m: &mut M, i: &Instruction) -> Result<(), M::Fault> {
    let (map, pp, op) = (i.key >> 16 & 0xFF, i.key >> 8 & 3, i.key as u8);
    match (map, pp, op) {
        // VMOVUPS, VMOVUPD, VMOVAPS, VMOVAPD, VMOVDQA, VMOVDQU, VLDDQU, the
        // aligned ones #GP(0) unless 32-byte aligned
        (1, 0 | 1, 0x10 | 0x28) | (1, 1 | 2, 0x6F) | (1, 3, 0xF0) => {
            let aligned = op == 0x28 || op == 0x6F && pp == 1;
            let v = source256(m, i, aligned)?;
            set_ymm(i.reg, v);
        },
        // their stores, and VMOVNTPS, VMOVNTPD, VMOVNTDQ
        (1, 0 | 1, 0x11 | 0x29 | 0x2B) | (1, 1 | 2, 0x7F) | (1, 1, 0xE7) => {
            let aligned = matches!(op, 0x29 | 0x2B | 0xE7) || op == 0x7F && pp == 1;
            let v = ymm(i.reg);
            match i.rm {
                Some(r) => set_ymm(r, v),
                None => m.write256(v, aligned)?,
            }
        },
        // VMOVSLDUP, VMOVSHDUP, VMOVDDUP: in each half (VMOVDDUP from 32
        // bytes of memory, as the others)
        (1, 2, 0x12 | 0x16) | (1, 3, 0x12) => {
            let v = source256(m, i, false)?;
            let t = TransferOp::from_encoding(legacy(i.key)).unwrap();
            let f = |v: u128| u128::from_le_bytes(t.apply([0; 16], v.to_le_bytes()));
            set_ymm(i.reg, (f(v.0), f(v.1)));
        },
        // VUNPCKLPS, VUNPCKLPD, VUNPCKHPS, VUNPCKHPD, VANDPS, VANDPD, VANDNPS,
        // VANDNPD, VORPS, VORPD, VXORPS, VXORPD: in each half
        (1, 0 | 1, 0x14 | 0x15 | 0x54..=0x57) => {
            let b = source256(m, i, false)?;
            let p = PackedOp::from_encoding(legacy(i.key)).unwrap();
            let a = ymm(i.vvvv);
            set_ymm(i.reg, (packed(p, a.0, b.0), packed(p, a.1, b.1)));
        },
        // VSHUFPS (imm8 for each half), VSHUFPD (imm8[1:0] for the low
        // half, imm8[3:2] for the high one)
        (1, 0 | 1, 0xC6) => {
            let b = source256(m, i, false)?;
            let shuffle = ShuffleOp::from_encoding(legacy(i.key)).unwrap();
            let a = ymm(i.vvvv);
            let high = if pp == 1 { i.imm8 >> 2 } else { i.imm8 };
            set_ymm(
                i.reg,
                (
                    bytes(|b| shuffle.apply(a.0.to_le_bytes(), b, i.imm8), b.0),
                    bytes(|b| shuffle.apply(a.1.to_le_bytes(), b, high), b.1),
                ),
            );
        },
        // VBLENDPS (imm8[3:0] for the low half's dwords, imm8[7:4] for the
        // high one's), VBLENDPD (imm8[1:0], imm8[3:2]); AVX2: VPBLENDW (imm8
        // for each half), VMPSADBW (imm8[2:0], imm8[5:3])
        (3, 1, 0x0C..=0x0E | 0x42) => {
            let b = source256(m, i, false)?;
            let a = ymm(i.vvvv);
            let high = i.imm8
                >> match op {
                    0x0C => 4,
                    0x0D => 2,
                    0x0E => 0,
                    _ => 3,
                };
            set_ymm(
                i.reg,
                (
                    bytes(
                        |b| simd_int::sse4_imm(op, a.0.to_le_bytes(), b, i.imm8),
                        b.0,
                    ),
                    bytes(|b| simd_int::sse4_imm(op, a.1.to_le_bytes(), b, high), b.1),
                ),
            );
        },
        // VBLENDVPS, VBLENDVPD; AVX2: VPBLENDVB. The mask register is
        // imm8[7:4] (bit 7 ignored outside 64-bit mode)
        (3, 1, 0x4A..=0x4C) => {
            let b = source256(m, i, false)?;
            let selector = ymm(i.imm8 >> 4 & if i.long { 15 } else { 7 });
            let a = ymm(i.vvvv);
            let legacy = [0x14, 0x15, 0x10][(op - 0x4A) as usize];
            let blend = |a: u128, b: u128, s: u128| {
                bytes(
                    |b| simd_int::sse4(legacy, a.to_le_bytes(), b, s.to_le_bytes()),
                    b,
                )
            };
            set_ymm(
                i.reg,
                (blend(a.0, b.0, selector.0), blend(a.1, b.1, selector.1)),
            );
        },
        // VPERMILPS, VPERMILPD by the second source's lanes: in each half
        (2, 1, 0x0C | 0x0D) => {
            let index = source256(m, i, false)?;
            let a = ymm(i.vvvv);
            let f = |a: u128, index: u128| {
                if op == 0x0C {
                    permute(a, 4, |n| (index >> (32 * n)) as u32 & 3)
                }
                else {
                    permute(a, 8, |n| (index >> (64 * n + 1)) as u32 & 1)
                }
            };
            set_ymm(i.reg, (f(a.0, index.0), f(a.1, index.1)));
        },
        // ... by imm8: VPERMILPS the same for each half, VPERMILPD imm8[1:0]
        // for the low half and imm8[3:2] for the high one
        (3, 1, 0x04 | 0x05) => {
            let v = source256(m, i, false)?;
            let f = |v: u128, imm8: u8| {
                if op == 0x04 {
                    permute(v, 4, |n| (imm8 >> (2 * n)) as u32 & 3)
                }
                else {
                    permute(v, 8, |n| (imm8 >> n) as u32 & 1)
                }
            };
            let high = if op == 0x05 { i.imm8 >> 2 } else { i.imm8 };
            set_ymm(i.reg, (f(v.0, i.imm8), f(v.1, high)));
        },
        // VBROADCASTSS ymm, m32; VBROADCASTSD ymm, m64 (AVX2: also from an
        // XMM register); VPBROADCASTB/W/D/Q (AVX2): an element in each lane;
        // VBROADCASTF128, VBROADCASTI128 (AVX2): m128 in each half
        (2, 1, 0x18..=0x1A | 0x58..=0x5A | 0x78 | 0x79) => {
            let v = if op == 0x1A || op == 0x5A {
                m.read(16, false)?
            }
            else {
                let size = broadcast_size(op);
                splat(element(m, i, size)?, size)
            };
            set_ymm(i.reg, (v, v));
        },
        // VINSERTF128, VINSERTI128 (AVX2): the first source with half
        // imm8[0] from xmm/m128
        (3, 1, 0x18 | 0x38) => {
            let v = source(m, i, 16, false)?;
            let a = ymm(i.vvvv);
            set_ymm(i.reg, if i.imm8 & 1 == 0 { (v, a.1) } else { (a.0, v) });
        },
        // VEXTRACTF128, VEXTRACTI128 (AVX2): half imm8[0] to an XMM
        // register (bits 255:128 of its YMM register zeroed) or to m128
        (3, 1, 0x19 | 0x39) => {
            let a = ymm(i.reg);
            let v = if i.imm8 & 1 == 0 { a.0 } else { a.1 };
            match i.rm {
                Some(r) => set_xmm(r, v),
                None => m.write(16, v, false)?,
            }
        },
        // VPERM2F128, VPERM2I128 (AVX2): each half one of the sources'
        // halves (imm8[1:0] for the low half, imm8[5:4] for the high one) or
        // zero (imm8[3], imm8[7])
        (3, 1, 0x06 | 0x46) => {
            let b = source256(m, i, false)?;
            let a = ymm(i.vvvv);
            let select = |control: u8| {
                if control & 8 != 0 {
                    0
                }
                else {
                    [a.0, a.1, b.0, b.1][(control & 3) as usize]
                }
            };
            set_ymm(i.reg, (select(i.imm8), select(i.imm8 >> 4)));
        },
        // VZEROALL: YMM0-YMM7, in 64-bit mode YMM0-YMM15
        (1, 0, 0x77) => {
            for r in 0..if i.long { 16 } else { 8 } {
                set_ymm(r, (0, 0));
            }
        },
        // VPTEST: ZF and CF over both halves
        (2, 1, 0x17) => {
            let b = source256(m, i, false)?;
            let a = ymm(i.reg);
            let low = simd_int::ptest(a.0.to_le_bytes(), b.0.to_le_bytes());
            let high = simd_int::ptest(a.1.to_le_bytes(), b.1.to_le_bytes());
            m.set_flags(((low.0 && high.0) as u32) << 6 | (low.1 && high.1) as u32);
        },
        // VTESTPS, VTESTPD: ZF and CF of all lanes' sign bits, AF, OF, PF,
        // SF cleared
        (2, 1, 0x0E | 0x0F) => {
            let b = source256(m, i, false)?;
            let signs: u128 = if op == 0x0E {
                0x8000_0000_8000_0000_8000_0000_8000_0000
            }
            else {
                0x8000_0000_0000_0000_8000_0000_0000_0000
            };
            let a = ymm(i.reg);
            let zf = (a.0 & b.0 | a.1 & b.1) & signs == 0;
            let cf = (!a.0 & b.0 | !a.1 & b.1) & signs == 0;
            m.set_flags((zf as u32) << 6 | cf as u32);
        },
        // VMOVMSKPS, VMOVMSKPD: all lanes' sign bits
        (1, 0 | 1, 0x50) => {
            let lane = if pp == 0 { 4 } else { 8 };
            m.set_gpr(i.reg, sign_mask256(ymm(i.rm.unwrap()), lane), i.long && i.w);
        },
        // VSQRT, VADD, VMUL, VSUB, VMIN, VDIV, VMAX PS/PD, VHADDPS/PD,
        // VHSUBPS/PD, VADDSUBPS/PD, VCMPPS/PD with 32 predicates: the lanes of
        // both halves with one exception context (VSQRTPS/PD: one source)
        (1, 0 | 1, 0x51 | 0x58 | 0x59 | 0x5C..=0x5F | 0xC2) | (1, 1 | 3, 0x7C | 0x7D | 0xD0) => {
            let b = source256(m, i, false)?;
            let r = simd_fp::arithmetic256(legacy(i.key), ymm(i.vvvv), b, i.imm8)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_ymm(i.reg, r);
        },
        // VRSQRTPS, VRCPPS: no exceptions
        (1, 0, 0x52 | 0x53) => {
            let b = source256(m, i, false)?;
            let key = legacy(i.key);
            set_ymm(
                i.reg,
                (
                    simd_fp::reciprocal(key, 0, b.0),
                    simd_fp::reciprocal(key, 0, b.1),
                ),
            );
        },
        // VROUNDPS, VROUNDPD
        (3, 1, 0x08 | 0x09) => {
            let b = source256(m, i, false)?;
            let r = simd_fp::round256(legacy(i.key), b, i.imm8)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_ymm(i.reg, r);
        },
        // VDPPS: in each half, the low one first (its unmasked exception
        // faults before the high one's operations)
        (3, 1, 0x40) => {
            let b = source256(m, i, false)?;
            let a = ymm(i.vvvv);
            let low = simd_fp::dot_product(false, a.0, b.0, i.imm8)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            let high = simd_fp::dot_product(false, a.1, b.1, i.imm8)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_ymm(i.reg, (low, high));
        },
        // VCVTDQ2PS, VCVTPS2DQ, VCVTTPS2DQ: eight lanes
        (1, 0..=2, 0x5B) => {
            let b = source256(m, i, false)?;
            let r = simd_fp::convert256(legacy(i.key), b)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_ymm(i.reg, r);
        },
        // VCVTPS2PD, VCVTDQ2PD: xmm/m128's four lanes into four doubles
        (1, 0, 0x5A) | (1, 2, 0xE6) => {
            let b = source(m, i, 16, false)?;
            let r = simd_fp::convert256(legacy(i.key), (b, 0))
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_ymm(i.reg, r);
        },
        // VCVTPD2PS, VCVTPD2DQ, VCVTTPD2DQ: ymm/m256's four doubles into an
        // XMM register (bits 255:128 of its YMM register zeroed)
        (1, 1, 0x5A) | (1, 1 | 3, 0xE6) => {
            let b = source256(m, i, false)?;
            let r = simd_fp::convert256(legacy(i.key), b)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_xmm(i.reg, r.0);
        },
        // VMASKMOVPS, VMASKMOVPD; AVX2: VPMASKMOVD, VPMASKMOVQ (VEX.W1)
        // ymm, ymm, m256: the lanes of memory the first source's sign bits
        // select, the others zero
        (2, 1, 0x2C | 0x2D | 0x8C) => {
            let size = if op == 0x2C || op == 0x8C && !i.w { 4 } else { 8 };
            let selected = sign_mask256(ymm(i.vvvv), size as u32) as u8;
            let v = m.read_lanes(size, 32 / size, selected)?;
            set_ymm(i.reg, v);
        },
        // ... m256, ymm, ymm: ModRM.reg's lanes that VEX.vvvv's sign bits
        // select
        (2, 1, 0x2E | 0x2F | 0x8E) => {
            let size = if op == 0x2E || op == 0x8E && !i.w { 4 } else { 8 };
            let selected = sign_mask256(ymm(i.vvvv), size as u32) as u8;
            m.write_lanes(size, 32 / size, ymm(i.reg), selected)?;
        },
        // AVX2 (P7 part 1): the packed integer forms on each half. 66 0F:
        // unpacks, packs, compares, arithmetic and logic
        (
            1,
            1,
            0x60..=0x6D
            | 0x74..=0x76
            | 0xD4
            | 0xD5
            | 0xD8..=0xE0
            | 0xE3..=0xE5
            | 0xE8..=0xEF
            | 0xF4..=0xF6
            | 0xF8..=0xFE,
        ) => {
            let b = source256(m, i, false)?;
            let p = PackedOp::from_encoding(legacy(i.key)).unwrap();
            let a = ymm(i.vvvv);
            set_ymm(i.reg, (packed(p, a.0, b.0), packed(p, a.1, b.1)));
        },
        // the shifts by xmm/m128: one count (its low quadword) for both
        (1, 1, 0xD1..=0xD3 | 0xE1 | 0xE2 | 0xF1..=0xF3) => {
            let count = source(m, i, 16, false)?;
            let p = PackedOp::from_encoding(legacy(i.key)).unwrap();
            let a = ymm(i.vvvv);
            set_ymm(i.reg, (packed(p, a.0, count), packed(p, a.1, count)));
        },
        // the shifts by imm8 (VEX.vvvv the destination; VPSRLDQ, VPSLLDQ:
        // within each half)
        (1, 1, 0x71..=0x73) => {
            let v = ymm(i.rm.unwrap());
            let f = |v| shift_imm(op, i.reg & 7, v, i.imm8 as u32);
            set_ymm(i.vvvv, (f(v.0), f(v.1)));
        },
        // VPSHUFD, VPSHUFHW, VPSHUFLW: each half's lanes as imm8 selects
        (1, 1..=3, 0x70) => {
            let v = source256(m, i, false)?;
            let shuffle = ShuffleOp::from_encoding(legacy(i.key)).unwrap();
            let f = |v| bytes(|v| shuffle.apply([0; 16], v, i.imm8), v);
            set_ymm(i.reg, (f(v.0), f(v.1)));
        },
        // VPMOVMSKB: the sign bits of all 32 bytes
        (1, 1, 0xD7) => {
            m.set_gpr(i.reg, sign_mask256(ymm(i.rm.unwrap()), 1), i.long && i.w);
        },
        // VPSHUFB (indices within each half), VPHADDW/D/SW, VPMADDUBSW,
        // VPHSUBW/D/SW, VPSIGNB/W/D, VPMULHRSW; VPABSB/W/D (of the source
        // alone)
        (2, 1, 0x00..=0x0B | 0x1C..=0x1E) => {
            let b = source256(m, i, false)?;
            let a = ymm(i.vvvv);
            let f = |a: u128, b| bytes(|b| simd_int::ssse3(op, a.to_le_bytes(), b), b);
            set_ymm(i.reg, (f(a.0, b.0), f(a.1, b.1)));
        },
        // VPMULDQ, VPCMPEQQ, VPACKUSDW, VPCMPGTQ, VPMINSB/SD/UW/UD,
        // VPMAXSB/SD/UW/UD, VPMULLD
        (2, 1, 0x28 | 0x29 | 0x2B | 0x37..=0x40) => {
            let b = source256(m, i, false)?;
            let a = ymm(i.vvvv);
            let f = |a: u128, b| bytes(|b| simd_int::sse4(op, a.to_le_bytes(), b, [0; 16]), b);
            set_ymm(i.reg, (f(a.0, b.0), f(a.1, b.1)));
        },
        // VMOVNTDQA: 32-byte aligned
        (2, 1, 0x2A) => {
            let v = source256(m, i, true)?;
            set_ymm(i.reg, v);
        },
        // VPALIGNR: within each half
        (3, 1, 0x0F) => {
            let b = source256(m, i, false)?;
            let a = ymm(i.vvvv);
            let f = |a: u128, b| bytes(|b| simd_int::palignr(a.to_le_bytes(), b, i.imm8), b);
            set_ymm(i.reg, (f(a.0, b.0), f(a.1, b.1)));
        },
        // VPGATHERDD/DQ/QD/QQ, VGATHERDPS/DPD/QPS/QPD (AVX2, P8)
        (2, 1, 0x90..=0x93) => gather(m, i)?,
        // AVX2 (P7 part 2): VPERMD, VPERMPS: the dwords of the second source
        // at the indices in the first's (bits 2:0 of each)
        (2, 1, 0x16 | 0x36) => {
            let data = source256(m, i, false)?;
            let index = ymm(i.vvvv);
            set_ymm(
                i.reg,
                permute256(data, 4, |n| lane256(index, 4 * n, 4) as u32 & 7),
            );
        },
        // VPERMQ, VPERMPD: the source's quadwords at the indices of imm8
        // (two bits each)
        (3, 1, 0x00 | 0x01) => {
            let v = source256(m, i, false)?;
            set_ymm(i.reg, permute256(v, 8, |n| (i.imm8 >> (2 * n)) as u32 & 3));
        },
        // VPBLENDD: imm8[3:0] for the low half's dwords, imm8[7:4] for the
        // high one's
        (3, 1, 0x02) => {
            let b = source256(m, i, false)?;
            let a = ymm(i.vvvv);
            set_ymm(
                i.reg,
                (
                    blend_dwords(a.0, b.0, i.imm8),
                    blend_dwords(a.1, b.1, i.imm8 >> 4),
                ),
            );
        },
        // VPSRLVD/Q, VPSRAVD, VPSLLVD/Q (VEX.W1: quadwords)
        (2, 1, 0x45..=0x47) => {
            let b = source256(m, i, false)?;
            let a = ymm(i.vvvv);
            let f = |a, b| shift_variable(op, i.w, a, b);
            set_ymm(i.reg, (f(a.0, b.0), f(a.1, b.1)));
        },
        // VPMOVSX*, VPMOVZX*: the source's lanes extended over 256 bits (from
        // memory, those bytes only)
        (2, 1, 0x20..=0x25 | 0x30..=0x35) => {
            let half = [8, 4, 2, 8, 4, 8][(op & 7) as usize];
            let b = source(m, i, 2 * half, false)?;
            let f = |b: u128| bytes(|b| simd_int::sse4(op, [0; 16], b, [0; 16]), b);
            set_ymm(i.reg, (f(b), f(b >> (8 * half))));
        },
        // FMA's packed forms (P11) on all eight or four lanes, one exception
        // context
        (2, 1, 0x96..=0x98 | 0x9A | 0x9C | 0x9E | 0xA6..=0xA8 | 0xAA | 0xAC | 0xAE)
        | (2, 1, 0xB6..=0xB8 | 0xBA | 0xBC | 0xBE) => {
            let c = source256(m, i, false)?;
            let (a, b) = (ymm(i.reg), ymm(i.vvvv));
            let [low, high] = simd_fp::fused(op, i.w, [a.0, a.1], [b.0, b.1], [c.0, c.1])
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_ymm(i.reg, (low, high));
        },
        // F16C (P11): VCVTPH2PS ymm, xmm/m128
        (2, 1, 0x13) => {
            let v = source(m, i, 16, false)?;
            let r =
                simd_fp::half_to_single(v, 8).map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_ymm(i.reg, r);
        },
        // VCVTPS2PH xmm/m128, ymm, imm8 (a register destination's bits
        // 255:128 zeroed)
        (3, 1, 0x1D) => {
            let r = simd_fp::single_to_half(ymm(i.reg), 8, i.imm8)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            match i.rm {
                Some(rm) => set_xmm(rm, r),
                None => m.write(16, r, false)?,
            }
        },
        _ => {
            dbg_assert!(false, "VEX.256 form {:x} without semantics", i.key);
            return Err(m.raise(Exception::InvalidOpcode));
        },
    }
    Ok(())
}

/// The 32-bit interpreter's and the IR helper's side: `address` is the
/// memory operand's linear address (VMASKMOVDQU's destination), which the
/// caller computes after `check`
pub struct Interpreter {
    pub address: i32,
}
impl Machine for Interpreter {
    type Fault = ();
    /// (32-bit addressing: the offset wraps at 32 bits, so does the linear
    /// address with the segment's base)
    unsafe fn gather(&mut self, offset: u64, bytes: u8) -> Result<u64, ()> {
        let a = self.address.wrapping_add(offset as i32);
        Ok(match bytes {
            4 => cpu::safe_read32s(a)? as u32 as u64,
            _ => cpu::safe_read64s(a)?,
        })
    }
    unsafe fn raise(&mut self, e: Exception) {
        match e {
            Exception::InvalidOpcode => cpu::trigger_ud(),
            Exception::DeviceNotAvailable => cpu::trigger_nm(),
            Exception::GeneralProtection => cpu::trigger_gp(0),
            Exception::SimdFloatingPoint => cpu::trigger_simd_fp(),
        }
    }
    unsafe fn read(&mut self, bytes: u8, aligned: bool) -> Result<u128, ()> {
        let a = self.address;
        if aligned {
            cpu::aligned16(a)?;
        }
        Ok(match bytes {
            1 => cpu::safe_read8(a)? as u8 as u128,
            2 => cpu::safe_read16(a)? as u16 as u128,
            4 => cpu::safe_read32s(a)? as u32 as u128,
            8 => cpu::safe_read64s(a)? as u128,
            16 => cpu::safe_read128s(a)?.bits(),
            _ => unreachable!(),
        })
    }
    unsafe fn write(&mut self, bytes: u8, value: u128, aligned: bool) -> Result<(), ()> {
        let a = self.address;
        if aligned {
            cpu::aligned16(a)?;
        }
        match bytes {
            1 => cpu::safe_write8(a, value as u8 as i32),
            2 => cpu::safe_write16(a, value as u16 as i32),
            4 => cpu::safe_write32(a, value as i32),
            8 => cpu::safe_write64(a, value as u64),
            16 => cpu::safe_write128(a, reg128::of_bits(value)),
            _ => unreachable!(),
        }
    }
    unsafe fn read256(&mut self, aligned: bool) -> Result<(u128, u128), ()> {
        let a = self.address;
        if aligned && a & 31 != 0 {
            cpu::trigger_gp(0);
            return Err(());
        }
        let low = cpu::safe_read128s(a)?.bits();
        Ok((low, cpu::safe_read128s(a.wrapping_add(16))?.bits()))
    }
    unsafe fn write256(&mut self, value: (u128, u128), aligned: bool) -> Result<(), ()> {
        let a = self.address;
        if aligned && a & 31 != 0 {
            cpu::trigger_gp(0);
            return Err(());
        }
        cpu::writable_or_pagefault(a, 32)?;
        cpu::safe_write128(a, reg128::of_bits(value.0)).unwrap();
        cpu::safe_write128(a.wrapping_add(16), reg128::of_bits(value.1)).unwrap();
        Ok(())
    }
    /// (as MASKMOVDQU: the whole range writable first, whatever the mask)
    unsafe fn write_masked(&mut self, value: u128, mask: u16) -> Result<(), ()> {
        let a = self.address;
        cpu::writable_or_pagefault(a, 16)?;
        for n in 0..16 {
            if mask >> n & 1 != 0 {
                cpu::safe_write8(a.wrapping_add(n), (value >> (n * 8)) as u8 as i32).unwrap();
            }
        }
        Ok(())
    }
    unsafe fn read_lanes(&mut self, size: u8, count: u8, selected: u8) -> Result<(u128, u128), ()> {
        let mut v = (0, 0);
        for n in 0..count {
            if selected >> n & 1 != 0 {
                let a = self.address.wrapping_add((n * size) as i32);
                let lane = if size == 4 {
                    cpu::safe_read32s(a)? as u32 as u128
                }
                else {
                    cpu::safe_read64s(a)? as u128
                };
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
    ) -> Result<(), ()> {
        let lanes = (0..count).filter(|n| selected >> n & 1 != 0);
        for n in lanes.clone() {
            cpu::writable_or_pagefault(self.address.wrapping_add((n * size) as i32), size as i32)?;
        }
        for n in lanes {
            let a = self.address.wrapping_add((n * size) as i32);
            let lane = lane256(value, n as u32 * size as u32, size as u32);
            if size == 4 {
                cpu::safe_write32(a, lane as i32).unwrap();
            }
            else {
                cpu::safe_write64(a, lane).unwrap();
            }
        }
        Ok(())
    }
    unsafe fn gpr(&mut self, r: u8) -> u64 { cpu::read_reg32(r as i32) as u32 as u64 }
    unsafe fn set_gpr(&mut self, r: u8, value: u64, _wide: bool) {
        cpu::write_reg32(r as i32, value as i32);
    }
    unsafe fn set_flags(&mut self, flags: u32) {
        *gp::flags = *gp::flags & !cpu::FLAGS_ALL | flags as i32;
        *gp::flags_changed = 0;
    }
}
