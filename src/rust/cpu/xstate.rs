//! XSAVE-managed state (docs/simd-xsave-plan.md 6.1-6.2): XCR0, IA32_XSS,
//! the upper halves of YMM0-YMM15, and the standard format of the XSAVE area.
//! The 32-bit interpreter, the IR's helpers and the x64 engine share the
//! encoding of the state components (encode, decode, in_use) and the rules
//! (XSETBV, XGETBV, the XSAVE header); each checks an instruction's
//! preconditions and address and moves the bytes with its own memory accesses
//! (xsave, xrstor, fxsave and fxrstor here are the 32-bit engines').

use crate::cpu::cpu::{self, MXCSR_MASK};
use crate::cpu::features;
use crate::cpu::global_pointers as gp;

/// State components (XCR0 bits)
pub const X87: u64 = 1 << 0;
pub const SSE: u64 = 1 << 1;
pub const YMM: u64 = 1 << 2;

/// The XSAVE header and the YMM_Hi128 component in the standard format
pub const HEADER: u32 = 512;
pub const YMM_OFFSET: u32 = 576;
/// XCOMP_BV's bit 63: the compacted form (XSAVEC, XSAVES). Its extended
/// region holds the components of XCOMP_BV[62:0] in order from 576, so with
/// YMM_Hi128 the only extended component here (its size 256, no 64-byte
/// alignment: CPUID.(EAX=0DH,ECX=2)) it is at the standard offset.
pub const COMPACTED: u64 = 1 << 63;
/// The standard-format area with every component of this implementation
pub const AREA_SIZE: usize = 832;

/// The XCR0 bits this machine supports (CPUID.(EAX=0DH,ECX=0):EDX:EAX)
pub fn supported() -> u64 {
    use crate::cpu::features::{AVX, XSAVE};
    if !features::has(XSAVE) {
        0
    }
    else if features::has(AVX) {
        X87 | SSE | YMM
    }
    else {
        X87 | SSE
    }
}
/// The size of a standard-format area holding the components `mask`
pub fn standard_size(mask: u64) -> u32 {
    if mask & YMM != 0 {
        832
    }
    else {
        576
    }
}

/// The size of a compacted-form area holding the components `mask`
pub fn compacted_size(mask: u64) -> u32 { standard_size(mask) }

/// The XSAVE-managed registers
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Registers {
    pub fcw: u16,
    /// with TOP
    pub fsw: u16,
    /// the abridged tag word: bit i set when physical register i is not empty
    pub ftw: u8,
    pub fop: u16,
    pub fip: u64,
    pub fcs: u16,
    pub fdp: u64,
    pub fds: u16,
    /// ST(0)..ST(7), counted from the top of the stack: 80 bits each
    pub st: [[u8; 10]; 8],
    pub mxcsr: u32,
    pub xmm: [u128; 16],
    pub ymm_hi: [u128; 16],
}
/// How an instruction lays out and reaches the state
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Format {
    /// REX.W: 64-bit FIP and FDP, without FCS and FDS
    pub wide: bool,
    /// 64-bit mode: XMM8-XMM15 and YMM8_H-YMM15_H, which other modes leave alone
    pub long: bool,
}
impl Format {
    pub fn registers(self) -> usize {
        if self.long {
            16
        }
        else {
            8
        }
    }
}

/// The fields an instruction stores for the components `mask`, and MXCSR
/// with MXCSR_MASK if `with_mxcsr`: (offset, length), adjacent ones merged.
/// Reserved and unused bytes are not stored (nor bytes 464-511).
pub fn fields(mask: u64, with_mxcsr: bool, format: Format) -> Vec<(u32, u32)> {
    let mut fields = Vec::new();
    if mask & X87 != 0 {
        // FCW, FSW, the abridged FTW; FOP and FIP (FCS); FDP (FDS)
        fields.extend([(0, 5), (6, if format.wide { 10 } else { 8 })]);
        fields.push((16, if format.wide { 8 } else { 6 }));
    }
    if with_mxcsr {
        fields.push((24, 8));
    }
    if mask & X87 != 0 {
        fields.extend((0..8).map(|i| (32 + 16 * i, 10)));
    }
    let n = 16 * format.registers() as u32;
    if mask & SSE != 0 {
        fields.push((160, n));
    }
    if mask & YMM != 0 {
        fields.push((YMM_OFFSET, n));
    }
    let mut merged: Vec<(u32, u32)> = Vec::new();
    for (offset, length) in fields {
        match merged.last_mut() {
            Some(last) if last.0 + last.1 == offset => last.1 += length,
            _ => merged.push((offset, length)),
        }
    }
    merged
}

/// The state of the components `mask` (and MXCSR if `with_mxcsr`) at their places
/// in a standard-format area; the other bytes are 0
pub fn encode(r: &Registers, mask: u64, with_mxcsr: bool, format: Format) -> [u8; AREA_SIZE] {
    let mut area = [0; AREA_SIZE];
    let mut put =
        |offset: usize, bytes: &[u8]| area[offset..offset + bytes.len()].copy_from_slice(bytes);
    if mask & X87 != 0 {
        put(0, &r.fcw.to_le_bytes());
        put(2, &r.fsw.to_le_bytes());
        put(4, &[r.ftw]);
        put(6, &r.fop.to_le_bytes());
        if format.wide {
            put(8, &r.fip.to_le_bytes());
            put(16, &r.fdp.to_le_bytes());
        }
        else {
            put(8, &(r.fip as u32).to_le_bytes());
            put(12, &r.fcs.to_le_bytes());
            put(16, &(r.fdp as u32).to_le_bytes());
            put(20, &r.fds.to_le_bytes());
        }
        for i in 0..8 {
            put(32 + 16 * i, &r.st[i]);
        }
    }
    if with_mxcsr {
        put(24, &r.mxcsr.to_le_bytes());
        put(28, &(MXCSR_MASK as u32).to_le_bytes());
    }
    for i in 0..format.registers() {
        if mask & SSE != 0 {
            put(160 + 16 * i, &r.xmm[i].to_le_bytes());
        }
        if mask & YMM != 0 {
            put(YMM_OFFSET as usize + 16 * i, &r.ymm_hi[i].to_le_bytes());
        }
    }
    area
}

/// Load the components `load` from `area`, give the components `init` their
/// initial configuration, and load MXCSR if `with_mxcsr` (the caller checked its
/// reserved bits); other state is left alone. FCS and FDS (FIP and FDP's
/// upper halves) become 0 when the format does not hold them.
pub fn decode(
    r: &mut Registers,
    area: &[u8; AREA_SIZE],
    load: u64,
    init: u64,
    with_mxcsr: bool,
    format: Format,
) {
    let u16_at = |at: usize| u16::from_le_bytes(area[at..at + 2].try_into().unwrap());
    let u32_at = |at: usize| u32::from_le_bytes(area[at..at + 4].try_into().unwrap());
    let u64_at = |at: usize| u64::from_le_bytes(area[at..at + 8].try_into().unwrap());
    let u128_at = |at: usize| u128::from_le_bytes(area[at..at + 16].try_into().unwrap());
    if load & X87 != 0 {
        r.fcw = u16_at(0);
        r.fsw = u16_at(2);
        r.ftw = area[4];
        r.fop = u16_at(6) & 0x7FF;
        if format.wide {
            (r.fip, r.fcs, r.fdp, r.fds) = (u64_at(8), 0, u64_at(16), 0);
        }
        else {
            (r.fip, r.fcs, r.fdp, r.fds) =
                (u32_at(8) as u64, u16_at(12), u32_at(16) as u64, u16_at(20));
        }
        for i in 0..8 {
            r.st[i].copy_from_slice(&area[32 + 16 * i..42 + 16 * i]);
        }
    }
    else if init & X87 != 0 {
        (r.fcw, r.fsw, r.ftw, r.fop, r.fip, r.fcs, r.fdp, r.fds) = (0x37F, 0, 0, 0, 0, 0, 0, 0);
        r.st = [[0; 10]; 8];
    }
    if with_mxcsr {
        r.mxcsr = u32_at(24);
    }
    for i in 0..format.registers() {
        if load & SSE != 0 {
            r.xmm[i] = u128_at(160 + 16 * i);
        }
        else if init & SSE != 0 {
            r.xmm[i] = 0;
        }
        if load & YMM != 0 {
            r.ymm_hi[i] = u128_at(YMM_OFFSET as usize + 16 * i);
        }
        else if init & YMM != 0 {
            r.ymm_hi[i] = 0;
        }
    }
}

/// The components not known to be in their initial configuration (XINUSE,
/// SDM Vol. 1 13.6), here exactly those that are not
pub fn in_use(r: &Registers, format: Format) -> u64 {
    let n = format.registers();
    let x87 = r.fcw != 0x37F
        || r.fsw != 0
        || r.ftw != 0
        || r.fcs != 0
        || r.fds != 0
        || r.fip != 0
        || r.fdp != 0
        || r.st.iter().any(|st| *st != [0; 10]);
    (x87 as u64) * X87
        | (r.xmm[..n].iter().any(|x| *x != 0) as u64) * SSE
        | (r.ymm_hi[..n].iter().any(|x| *x != 0) as u64) * YMM
}

/// XRSTOR's checks of the header (otherwise #GP(0)): Some(false) for a
/// valid standard form (XSTATE_BV within `allowed`, XCR0; bytes 23:8, XCOMP_BV
/// and 8 reserved bytes, zero), Some(true) for a valid compacted one
/// (XCOMP_BV[63], which needs XSAVEC; XCOMP_BV[62:0] within `allowed`,
/// XSTATE_BV within XCOMP_BV, bytes 63:16 zero)
pub fn header_form(header: &[u8; 64], allowed: u64) -> Option<bool> {
    let at = |offset: usize| u64::from_le_bytes(header[offset..offset + 8].try_into().unwrap());
    let (xstate_bv, xcomp_bv) = (at(0), at(8));
    if xcomp_bv & COMPACTED == 0 {
        (xstate_bv & !allowed == 0 && header[8..24].iter().all(|&b| b == 0)).then_some(false)
    }
    else {
        let format = xcomp_bv & !COMPACTED;
        (features::has(features::XSAVEC)
            && format & !allowed == 0
            && xstate_bv & !format == 0
            && header[16..].iter().all(|&b| b == 0))
        .then_some(true)
    }
}

/// An XSETBV of `value` into XCR `index` is valid (otherwise #GP(0)): XCR0
/// only, supported components, x87 always, AVX state only with SSE state
pub fn xsetbv_valid(index: u32, value: u64) -> bool {
    index == 0
        && value & !supported() == 0
        && value & X87 != 0
        && (value & YMM == 0 || value & SSE != 0)
}

/// The XSAVE feature set is enabled (CR4.OSXSAVE, which needs XSAVE)
pub unsafe fn enabled() -> bool { *gp::cr.add(4) & cpu::CR4_OSXSAVE != 0 }

/// At reset: XCR0 has x87 state only (an INIT keeps all of this: cpu.js)
pub unsafe fn reset() {
    *gp::xcr0 = X87;
    *gp::xss = 0;
    for i in 0..16 {
        *gp::ymm_hi.add(i) = cpu::reg128 { u64: [0, 0] };
    }
}

/// CPUID: OSXSAVE (CR4) in leaf 1, the XSAVE feature set in leaf 0xD
/// (the features in leaf 0xD, subleaf 1: crate::cpu::features)
pub unsafe fn cpuid(leaf: u32, subleaf: u32, registers: &mut [u32; 4]) {
    let supported = supported();
    if supported == 0 {
        return;
    }
    match (leaf, subleaf) {
        (1, _) if enabled() => registers[2] |= 1 << 27,
        (0xD, 0) => {
            *registers = [
                supported as u32,
                standard_size(*gp::xcr0),
                standard_size(supported),
                (supported >> 32) as u32,
            ]
        },
        // (with the compacted form: the size of an area of XCR0 and
        // IA32_XSS's components; IA32_XSS supports none, ECX and EDX)
        (0xD, 1) if features::has(features::XSAVEC) => {
            registers[1] = compacted_size(*gp::xcr0 | *gp::xss)
        },
        (0xD, 2) if supported & YMM != 0 => *registers = [256, YMM_OFFSET, 0, 0],
        _ => {},
    }
}

/// XGETBV: XCR `index` (1: XCR0 AND XINUSE, with XGETBV1; `long`: the
/// registers of 64-bit mode count), or None for #GP(0)
pub unsafe fn xgetbv(index: u32, long: bool) -> Option<u64> {
    match index {
        0 => Some(*gp::xcr0),
        1 if features::has(features::XGETBV1) => {
            Some(*gp::xcr0 & in_use(&registers(), Format { wide: false, long }))
        },
        _ => None,
    }
}
/// XSETBV: false for #GP(0), which also comes for CPL > 0 (the caller's)
pub unsafe fn xsetbv(index: u32, value: u64) -> bool {
    if !xsetbv_valid(index, value) {
        return false;
    }
    *gp::xcr0 = value;
    true
}

/// The registers of this core, its x87 cache written back
pub unsafe fn registers() -> Registers {
    crate::cpu::fpu::fpu_sync_all();
    let pair = |lo: i32, hi: u32| lo as u32 as u64 | (hi as u64) << 32;
    let mut r = Registers {
        fcw: *gp::fpu_control_word,
        fsw: crate::cpu::fpu::fpu_load_status_word(),
        ftw: !*gp::fpu_stack_empty,
        fop: *gp::fpu_opcode as u16,
        fip: pair(*gp::fpu_ip, *gp::x64_fpu_ip_hi),
        fcs: *gp::fpu_ip_selector as u16,
        fdp: pair(*gp::fpu_dp, *gp::x64_fpu_dp_hi),
        fds: *gp::fpu_dp_selector as u16,
        mxcsr: *gp::mxcsr as u32,
        ..Registers::default()
    };
    for i in 0..8 {
        let st = *gp::fpu_st.add((i + *gp::fpu_stack_ptr as usize) & 7);
        r.st[i][..8].copy_from_slice(&st.mantissa.to_le_bytes());
        r.st[i][8..].copy_from_slice(&st.sign_exponent.to_le_bytes());
    }
    for i in 0..16 {
        r.xmm[i] = std::mem::transmute(crate::x64::state::read_xmm(i));
        r.ymm_hi[i] = std::mem::transmute(*gp::ymm_hi.add(i));
    }
    r
}
/// Write back the components `mask` of `r`, and MXCSR if `with_mxcsr`
pub unsafe fn set_registers(r: &Registers, mask: u64, with_mxcsr: bool, format: Format) {
    if mask & X87 != 0 {
        crate::cpu::fpu::fpu_cache_barrier();
        crate::cpu::fpu::set_control_word(r.fcw);
        crate::cpu::fpu::fpu_set_status_word(r.fsw);
        *gp::fpu_stack_empty = !r.ftw;
        *gp::fpu_opcode = r.fop as i32;
        *gp::fpu_ip = r.fip as i32;
        *gp::x64_fpu_ip_hi = (r.fip >> 32) as u32;
        *gp::fpu_ip_selector = r.fcs as i32;
        *gp::fpu_dp = r.fdp as i32;
        *gp::x64_fpu_dp_hi = (r.fdp >> 32) as u32;
        *gp::fpu_dp_selector = r.fds as i32;
        for i in 0..8 {
            let st = crate::softfloat::F80 {
                mantissa: u64::from_le_bytes(r.st[i][..8].try_into().unwrap()),
                sign_exponent: u16::from_le_bytes(r.st[i][8..].try_into().unwrap()),
            };
            crate::cpu::fpu::fpu_write_st(((i + *gp::fpu_stack_ptr as usize) & 7) as i32, st);
        }
    }
    if with_mxcsr {
        cpu::set_mxcsr(r.mxcsr as i32);
    }
    for i in 0..format.registers() {
        if mask & SSE != 0 {
            crate::x64::state::write_xmm(i, std::mem::transmute(r.xmm[i]));
        }
        if mask & YMM != 0 {
            *gp::ymm_hi.add(i) = std::mem::transmute(r.ymm_hi[i]);
        }
    }
}

/// An engine's access to an XSAVE area at an aligned address: `check` makes
/// sure the bytes can be read or written (a page fault comes from there), and
/// the instructions call it for every field before any byte moves, so a
/// fault leaves memory and state alone
pub trait Area {
    type Fault;
    unsafe fn check(&mut self, offset: u32, length: u32, write: bool) -> Result<(), Self::Fault>;
    /// 8 bytes, or 1 (after check)
    unsafe fn read(&mut self, offset: u32, bytes: &mut [u8]);
    unsafe fn write(&mut self, offset: u32, bytes: &[u8]);
    /// #GP(0)
    unsafe fn gp(&mut self) -> Self::Fault;
}
unsafe fn write_fields<A: Area>(
    m: &mut A,
    area: &[u8; AREA_SIZE],
    fields: &[(u32, u32)],
) -> Result<(), A::Fault> {
    for &(offset, length) in fields {
        m.check(offset, length, true)?;
    }
    for &(offset, length) in fields {
        let (mut at, end) = (offset as usize, (offset + length) as usize);
        while at < end {
            let n = if at + 8 <= end { 8 } else { 1 };
            m.write(at as u32, &area[at..at + n]);
            at += n;
        }
    }
    Ok(())
}
unsafe fn read_fields<A: Area>(
    m: &mut A,
    area: &mut [u8; AREA_SIZE],
    fields: &[(u32, u32)],
) -> Result<(), A::Fault> {
    for &(offset, length) in fields {
        m.check(offset, length, false)?;
    }
    for &(offset, length) in fields {
        let (mut at, end) = (offset as usize, (offset + length) as usize);
        while at < end {
            let n = if at + 8 <= end { 8 } else { 1 };
            m.read(at as u32, &mut area[at..at + n]);
            at += n;
        }
    }
    Ok(())
}
fn mxcsr_valid(area: &[u8; AREA_SIZE]) -> bool {
    u32::from_le_bytes(area[24..28].try_into().unwrap()) & !(MXCSR_MASK as u32) == 0
}

/// XSAVE of the components `rfbm` (XCR0 AND EDX:EAX)
pub unsafe fn xsave<A: Area>(m: &mut A, rfbm: u64, format: Format) -> Result<(), A::Fault> {
    crate::step_profile::note_event(crate::step_profile::event::FXSTATE, 2);
    save_standard(m, rfbm, format, false)
}
/// XSAVEOPT: XSAVE's but for the components in their initial configuration
/// (XINUSE), which it does not store (the init optimization). It has no
/// modified optimization (the SDM lets XSAVEOPT also skip components
/// unmodified since an XRSTOR from the same area; not doing so is allowed).
pub unsafe fn xsaveopt<A: Area>(m: &mut A, rfbm: u64, format: Format) -> Result<(), A::Fault> {
    crate::step_profile::note_event(crate::step_profile::event::FXSTATE, 2);
    save_standard(m, rfbm, format, true)
}
/// The standard form's save: the components `rfbm`, or with
/// `init_optimization` those of them in use; MXCSR and MXCSR_MASK with
/// RFBM[1] or RFBM[2] (whatever XINUSE says); XSTATE_BV's bits of `rfbm`
/// from XINUSE, the others kept, and no other header byte
unsafe fn save_standard<A: Area>(
    m: &mut A,
    rfbm: u64,
    format: Format,
    init_optimization: bool,
) -> Result<(), A::Fault> {
    let with_mxcsr = rfbm & (SSE | YMM) != 0;
    let r = registers();
    let in_use = in_use(&r, format);
    let saved = if init_optimization { rfbm & in_use } else { rfbm };
    m.check(HEADER, 8, false)?;
    m.check(HEADER, 8, true)?;
    let mut old = [0; 8];
    m.read(HEADER, &mut old);
    write_fields(
        m,
        &encode(&r, saved, with_mxcsr, format),
        &fields(saved, with_mxcsr, format),
    )?;
    let xstate_bv = u64::from_le_bytes(old) & !rfbm | in_use & rfbm;
    m.write(HEADER, &xstate_bv.to_le_bytes());
    Ok(())
}
/// XSAVEC of the components `rfbm`: the compacted form. It stores the
/// components in use (the init optimization), and SSE state also when MXCSR
/// is not 1F80H (MXCSR, part of SSE state, does not count in XINUSE[1]);
/// MXCSR and MXCSR_MASK with SSE state only. XSTATE_BV: the components
/// stored; XCOMP_BV: `rfbm` with bit 63. No other header byte, nor bytes
/// 464-511.
pub unsafe fn xsavec<A: Area>(m: &mut A, rfbm: u64, format: Format) -> Result<(), A::Fault> {
    crate::step_profile::note_event(crate::step_profile::event::FXSTATE, 2);
    let r = registers();
    let mut saved = rfbm & in_use(&r, format);
    if rfbm & SSE != 0 && r.mxcsr != 0x1F80 {
        saved |= SSE;
    }
    let with_mxcsr = saved & SSE != 0;
    m.check(HEADER, 16, true)?;
    write_fields(
        m,
        &encode(&r, saved, with_mxcsr, format),
        &fields(saved, with_mxcsr, format),
    )?;
    m.write(HEADER, &saved.to_le_bytes());
    m.write(HEADER + 8, &(rfbm | COMPACTED).to_le_bytes());
    Ok(())
}
/// XSAVES of the components `rfbm` ((XCR0 OR IA32_XSS) AND EDX:EAX; CPL 0
/// checked): XSAVEC's (no modified optimization, which the SDM allows XSAVES
/// too)
pub unsafe fn xsaves<A: Area>(m: &mut A, rfbm: u64, format: Format) -> Result<(), A::Fault> {
    // (xsavec counts it in the step profile)
    xsavec(m, rfbm, format)
}
/// XRSTORS of the components `rfbm` ((XCR0 OR IA32_XSS) AND EDX:EAX; CPL 0
/// checked): the compacted form only (#GP(0) for the standard form), its
/// XCOMP_BV within XCR0 OR IA32_XSS
pub unsafe fn xrstors<A: Area>(m: &mut A, rfbm: u64, format: Format) -> Result<(), A::Fault> {
    crate::step_profile::note_event(crate::step_profile::event::FXSTATE, 3);
    let mut area = [0; AREA_SIZE];
    read_fields(m, &mut area, &[(HEADER, 64)])?;
    let header = area[HEADER as usize..][..64].try_into().unwrap();
    if header_form(header, *gp::xcr0 | *gp::xss) != Some(true) {
        return Err(m.gp());
    }
    restore(m, &mut area, rfbm, true, format)
}
/// XRSTOR of the components `rfbm`, from either form
pub unsafe fn xrstor<A: Area>(m: &mut A, rfbm: u64, format: Format) -> Result<(), A::Fault> {
    crate::step_profile::note_event(crate::step_profile::event::FXSTATE, 3);
    let mut area = [0; AREA_SIZE];
    read_fields(m, &mut area, &[(HEADER, 64)])?;
    let Some(compacted) = header_form(area[HEADER as usize..][..64].try_into().unwrap(), *gp::xcr0)
    else {
        return Err(m.gp());
    };
    restore(m, &mut area, rfbm, compacted, format)
}
/// The components `rfbm` from `area`, whose header was read and checked:
/// those XSTATE_BV marks loaded, the others initialized. MXCSR: the standard
/// form loads it with RFBM[1] or RFBM[2] whatever XSTATE_BV says; the
/// compacted form with SSE state only, and initializes it to 1F80H with SSE
/// state. Reserved MXCSR bits loaded are #GP(0), before any state changes.
unsafe fn restore<A: Area>(
    m: &mut A,
    area: &mut [u8; AREA_SIZE],
    rfbm: u64,
    compacted: bool,
    format: Format,
) -> Result<(), A::Fault> {
    let xstate_bv = u64::from_le_bytes(area[HEADER as usize..][..8].try_into().unwrap());
    let (load, init) = (rfbm & xstate_bv, rfbm & !xstate_bv);
    let with_mxcsr = if compacted { load & SSE != 0 } else { rfbm & (SSE | YMM) != 0 };
    read_fields(m, area, &fields(load, with_mxcsr, format))?;
    if with_mxcsr && !mxcsr_valid(area) {
        return Err(m.gp());
    }
    let mut r = registers();
    decode(&mut r, area, load, init, with_mxcsr, format);
    let initial_mxcsr = compacted && init & SSE != 0;
    if initial_mxcsr {
        r.mxcsr = 0x1F80;
    }
    set_registers(&r, load | init, with_mxcsr || initial_mxcsr, format);
    Ok(())
}
/// FXSAVE: the x87 and SSE state with MXCSR (bytes 288-511 only in 64-bit
/// mode, and never 416-511)
pub unsafe fn fxsave<A: Area>(m: &mut A, format: Format) -> Result<(), A::Fault> {
    crate::step_profile::note_event(crate::step_profile::event::FXSTATE, 0);
    let r = registers();
    write_fields(
        m,
        &encode(&r, X87 | SSE, true, format),
        &fields(X87 | SSE, true, format),
    )
}
/// FXRSTOR: #GP(0) for reserved MXCSR bits
pub unsafe fn fxrstor<A: Area>(m: &mut A, format: Format) -> Result<(), A::Fault> {
    crate::step_profile::note_event(crate::step_profile::event::FXSTATE, 1);
    let mut area = [0; AREA_SIZE];
    read_fields(m, &mut area, &fields(X87 | SSE, true, format))?;
    if !mxcsr_valid(&area) {
        return Err(m.gp());
    }
    let mut r = registers();
    decode(&mut r, &area, X87 | SSE, 0, true, format);
    set_registers(&r, X87 | SSE, true, format);
    Ok(())
}

/// #UD without CR4.OSXSAVE, then #NM with CR0.TS if `nm`: XSAVE, XRSTOR,
/// XGETBV and XSETBV check these before their operands. False: the fault was
/// delivered (32-bit engines).
pub unsafe fn usable(nm: bool) -> bool {
    if !enabled() {
        cpu::trigger_ud();
        return false;
    }
    if nm && *gp::cr & cpu::CR0_TS != 0 {
        cpu::trigger_nm();
        return false;
    }
    true
}
/// XCR0 AND EDX:EAX: the components an instruction asks for (RFBM)
pub unsafe fn requested(edx: u32, eax: u32) -> u64 { *gp::xcr0 & ((edx as u64) << 32 | eax as u64) }
/// XSAVES and XRSTORS's RFBM: (XCR0 OR IA32_XSS) AND EDX:EAX
pub unsafe fn requested_supervisor(edx: u32, eax: u32) -> u64 {
    (*gp::xcr0 | *gp::xss) & ((edx as u64) << 32 | eax as u64)
}
/// The IA32_XSS bits this machine supports: no supervisor state component
pub const XSS_SUPPORTED: u64 = 0;
/// IA32_XSS (MSR 0DA0H, with XSAVES): None for an absent MSR
pub unsafe fn read_xss() -> Option<u64> { features::has(features::XSAVES).then(|| *gp::xss) }
/// WRMSR to IA32_XSS: None for an absent MSR, Some(false) for unsupported
/// bits (#GP(0))
pub unsafe fn write_xss(value: u64) -> Option<bool> {
    if !features::has(features::XSAVES) {
        return None;
    }
    if value & !XSS_SUPPORTED != 0 {
        return Some(false);
    }
    *gp::xss = value;
    Some(true)
}

/// The 32-bit engines (the interpreter, also in compatibility mode, and the
/// IR's helpers): a linear address, faults delivered as they come
struct Linear(i32);
impl Area for Linear {
    type Fault = ();
    unsafe fn check(&mut self, offset: u32, length: u32, write: bool) -> Result<(), ()> {
        let at = self.0.wrapping_add(offset as i32);
        if write {
            cpu::writable_or_pagefault(at, length as i32)
        }
        else {
            cpu::readable_or_pagefault(at, length as i32)
        }
    }
    unsafe fn read(&mut self, offset: u32, bytes: &mut [u8]) {
        let at = self.0.wrapping_add(offset as i32);
        if bytes.len() == 8 {
            bytes.copy_from_slice(&cpu::safe_read64s(at).unwrap().to_le_bytes());
        }
        else {
            bytes[0] = cpu::safe_read8(at).unwrap() as u8;
        }
    }
    unsafe fn write(&mut self, offset: u32, bytes: &[u8]) {
        let at = self.0.wrapping_add(offset as i32);
        if bytes.len() == 8 {
            cpu::safe_write64(at, u64::from_le_bytes(bytes.try_into().unwrap())).unwrap();
        }
        else {
            cpu::safe_write8(at, bytes[0] as i32).unwrap();
        }
    }
    unsafe fn gp(&mut self) { cpu::trigger_gp(0); }
}
const NARROW: Format = Format {
    wide: false,
    long: false,
};
unsafe fn eax_edx() -> (u32, u32) {
    (
        cpu::read_reg32(cpu::EDX) as u32,
        cpu::read_reg32(cpu::EAX) as u32,
    )
}

/// XSAVE at the linear address `addr` (usable() checked): #GP(0) unless
/// aligned to 64 bytes. False if a fault was delivered.
pub unsafe fn xsave_32(addr: i32) -> bool {
    if addr & 63 != 0 {
        cpu::trigger_gp(0);
        return false;
    }
    let (edx, eax) = eax_edx();
    xsave(&mut Linear(addr), requested(edx, eax), NARROW).is_ok()
}
/// XSAVEOPT at `addr` (usable() checked), like xsave_32
pub unsafe fn xsaveopt_32(addr: i32) -> bool {
    if addr & 63 != 0 {
        cpu::trigger_gp(0);
        return false;
    }
    let (edx, eax) = eax_edx();
    xsaveopt(&mut Linear(addr), requested(edx, eax), NARROW).is_ok()
}
/// XSAVEC at `addr` (usable() checked), like xsave_32
pub unsafe fn xsavec_32(addr: i32) -> bool {
    if addr & 63 != 0 {
        cpu::trigger_gp(0);
        return false;
    }
    let (edx, eax) = eax_edx();
    xsavec(&mut Linear(addr), requested(edx, eax), NARROW).is_ok()
}
/// XSAVES at `addr` (usable() and CPL 0 checked), like xsave_32
pub unsafe fn xsaves_32(addr: i32) -> bool {
    if addr & 63 != 0 {
        cpu::trigger_gp(0);
        return false;
    }
    let (edx, eax) = eax_edx();
    xsaves(&mut Linear(addr), requested_supervisor(edx, eax), NARROW).is_ok()
}
/// XRSTORS from `addr` (usable() and CPL 0 checked), like xsave_32
pub unsafe fn xrstors_32(addr: i32) -> bool {
    if addr & 63 != 0 {
        cpu::trigger_gp(0);
        return false;
    }
    let (edx, eax) = eax_edx();
    xrstors(&mut Linear(addr), requested_supervisor(edx, eax), NARROW).is_ok()
}
/// XRSTOR from `addr` (usable() checked), like xsave_32
pub unsafe fn xrstor_32(addr: i32) -> bool {
    if addr & 63 != 0 {
        cpu::trigger_gp(0);
        return false;
    }
    let (edx, eax) = eax_edx();
    xrstor(&mut Linear(addr), requested(edx, eax), NARROW).is_ok()
}
/// FXSAVE at `addr` (#NM checked): #GP(0) unless aligned to 16 bytes
pub unsafe fn fxsave_32(addr: i32) -> bool {
    if addr & 15 != 0 {
        cpu::trigger_gp(0);
        return false;
    }
    fxsave(&mut Linear(addr), NARROW).is_ok()
}
/// FXRSTOR from `addr` (#NM checked), like fxsave_32
pub unsafe fn fxrstor_32(addr: i32) -> bool {
    if addr & 15 != 0 {
        cpu::trigger_gp(0);
        return false;
    }
    fxrstor(&mut Linear(addr), NARROW).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Registers {
        let mut r = Registers {
            fcw: 0x27F,
            fsw: 0x3800 | 0x41,
            ftw: 0x81,
            fop: 0x5D9,
            fip: 0x1234_5678_9ABC_DEF0,
            fcs: 0x23,
            fdp: 0x0FED_CBA9_8765_4321,
            fds: 0x2B,
            mxcsr: 0x1FA0,
            ..Registers::default()
        };
        for i in 0..8 {
            r.st[i] = [i as u8 + 1; 10];
        }
        for i in 0..16 {
            r.xmm[i] = 0x0101_0101_0101_0101_0101_0101_0101_0101 * (i as u128 + 1);
            r.ymm_hi[i] = !r.xmm[i];
        }
        r
    }
    #[test]
    fn layout_follows_the_standard_format() {
        let r = sample();
        let narrow = Format {
            wide: false,
            long: false,
        };
        let area = encode(&r, X87 | SSE | YMM, true, narrow);
        assert_eq!(&area[0..8], &[0x7F, 0x02, 0x41, 0x38, 0x81, 0, 0xD9, 0x05]);
        assert_eq!(
            &area[8..24],
            &[0xF0, 0xDE, 0xBC, 0x9A, 0x23, 0, 0, 0, 0x21, 0x43, 0x65, 0x87, 0x2B, 0, 0, 0]
        );
        assert_eq!(&area[24..32], &[0xA0, 0x1F, 0, 0, 0xFF, 0xFF, 0, 0]);
        assert_eq!(
            &area[32..48],
            &[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(area[160], 1);
        assert_eq!(&area[288..416], &[0; 128], "XMM8-15 only in 64-bit mode");
        assert_eq!(area[576], 0xFE);
        assert_eq!(&area[704..832], &[0; 128]);
        let wide = encode(
            &r,
            X87,
            false,
            Format {
                wide: true,
                long: true,
            },
        );
        assert_eq!(u64::from_le_bytes(wide[8..16].try_into().unwrap()), r.fip);
        assert_eq!(u64::from_le_bytes(wide[16..24].try_into().unwrap()), r.fdp);
        assert_eq!(&wide[24..32], &[0; 8], "MXCSR only when asked");
        // the fields stored: no reserved bytes, nothing from 416 on but YMM_Hi128
        assert_eq!(
            fields(X87 | SSE | YMM, true, narrow),
            vec![
                (0, 5),
                (6, 8),
                (16, 6),
                (24, 18),
                (48, 10),
                (64, 10),
                (80, 10),
                (96, 10),
                (112, 10),
                (128, 10),
                (144, 10),
                (160, 128),
                (576, 128)
            ]
        );
        assert_eq!(
            fields(
                X87 | SSE,
                true,
                Format {
                    wide: true,
                    long: true
                }
            ),
            vec![
                (0, 5),
                (6, 36),
                (48, 10),
                (64, 10),
                (80, 10),
                (96, 10),
                (112, 10),
                (128, 10),
                (144, 10),
                (160, 256)
            ]
        );
        assert_eq!(fields(YMM, true, narrow), vec![(24, 8), (576, 128)]);
        assert_eq!(fields(0, false, narrow), vec![]);
    }
    #[test]
    fn round_trip_init_and_partial_restores() {
        for format in [
            Format {
                wide: false,
                long: false,
            },
            Format {
                wide: true,
                long: true,
            },
            Format {
                wide: false,
                long: true,
            },
        ] {
            let r = sample();
            let area = encode(&r, X87 | SSE | YMM, true, format);
            let mut back = Registers::default();
            decode(&mut back, &area, X87 | SSE | YMM, 0, true, format);
            let n = format.registers();
            assert_eq!(
                (back.fcw, back.fsw, back.ftw, back.fop, back.mxcsr),
                (r.fcw, r.fsw, r.ftw, r.fop, r.mxcsr)
            );
            assert_eq!(back.st, r.st);
            assert_eq!(&back.xmm[..n], &r.xmm[..n]);
            assert_eq!(&back.ymm_hi[..n], &r.ymm_hi[..n]);
            assert!(
                back.xmm[n..]
                    .iter()
                    .chain(&back.ymm_hi[n..])
                    .all(|x| *x == 0),
                "other modes leave XMM8-15 alone"
            );
            if format.wide {
                assert_eq!(
                    (back.fip, back.fdp, back.fcs, back.fds),
                    (r.fip, r.fdp, 0, 0)
                );
            }
            else {
                assert_eq!(
                    (back.fip, back.fdp, back.fcs, back.fds),
                    (r.fip as u32 as u64, r.fdp as u32 as u64, r.fcs, r.fds)
                );
            }
            // components not asked for are left alone; init gives FNINIT's x87
            // state and zero registers, not MXCSR
            let mut partial = sample();
            decode(&mut partial, &[0; AREA_SIZE], 0, X87 | YMM, false, format);
            assert_eq!(
                (partial.fcw, partial.fsw, partial.ftw, partial.st),
                (0x37F, 0, 0, [[0; 10]; 8])
            );
            assert_eq!((partial.xmm, partial.mxcsr), (r.xmm, r.mxcsr));
            assert!(partial.ymm_hi[..n].iter().all(|x| *x == 0));
            assert_eq!(in_use(&partial, format), SSE);
        }
    }
    #[test]
    fn in_use_header_and_xsetbv_rules() {
        let narrow = Format {
            wide: false,
            long: false,
        };
        let mut r = Registers {
            fcw: 0x37F,
            mxcsr: 0x1F80,
            ..Registers::default()
        };
        assert_eq!(in_use(&r, narrow), 0);
        r.mxcsr = 0x1FA0;
        assert_eq!(in_use(&r, narrow), 0, "MXCSR is not part of XINUSE[1]");
        r.xmm[9] = 1;
        r.ymm_hi[15] = 1;
        assert_eq!(in_use(&r, narrow), 0, "XMM8-15 count only in 64-bit mode");
        assert_eq!(
            in_use(
                &r,
                Format {
                    wide: false,
                    long: true
                }
            ),
            SSE | YMM
        );
        r.fop = 1;
        assert_eq!(
            in_use(&r, narrow),
            0,
            "FOP is not part of the x87 init configuration"
        );
        r.ftw = 1;
        assert_eq!(in_use(&r, narrow), X87);

        let mut header = [0; 64];
        header[0] = 3;
        assert!(header_form(&header, 3) == Some(false) && header_form(&header, 1).is_none());
        header[15] = 0x80;
        assert!(
            header_form(&header, 3).is_none(),
            "the compacted form needs XSAVEC"
        );
        header[15] = 0;
        header[23] = 1;
        assert!(header_form(&header, 3).is_none());
        header[23] = 0;
        header[24] = 1;
        assert_eq!(
            header_form(&header, 3),
            Some(false),
            "bytes 63:24 are not checked by the standard form"
        );
        // the compacted form: XCOMP_BV within XCR0, XSTATE_BV within XCOMP_BV,
        // bytes 63:16 zero
        use crate::cpu::features::XSAVEC;
        TEST_FEATURES.with(|f| f.set(XSAVE | XSAVEC));
        let compacted = |xstate_bv: u64, xcomp_bv: u64, byte: Option<usize>| {
            let mut h = [0; 64];
            h[..8].copy_from_slice(&xstate_bv.to_le_bytes());
            h[8..16].copy_from_slice(&xcomp_bv.to_le_bytes());
            if let Some(at) = byte {
                h[at] = 1;
            }
            header_form(&h, 7)
        };
        assert_eq!(compacted(5, COMPACTED | 7, None), Some(true));
        assert_eq!(compacted(0, COMPACTED, None), Some(true));
        assert_eq!(
            compacted(4, COMPACTED | 3, None),
            None,
            "XSTATE_BV beyond XCOMP_BV"
        );
        assert_eq!(
            compacted(1, COMPACTED | 9, None),
            None,
            "XCOMP_BV beyond XCR0"
        );
        assert_eq!(compacted(1, COMPACTED | 1, Some(16)), None, "bytes 63:16");
        assert_eq!(compacted(1, COMPACTED | 1, Some(63)), None, "bytes 63:16");
        assert_eq!(compacted(0, 1, None), None, "XCOMP_BV without bit 63");
        TEST_FEATURES.with(|f| f.set(0));

        use crate::cpu::features::{ALL, AVX, SSE4_1, SSE4_2, SSSE3, TEST_FEATURES, XSAVE};
        for (features, all) in [
            (0, 0),
            (XSAVE, X87 | SSE),
            (XSAVE | AVX | SSSE3 | SSE4_1 | SSE4_2, X87 | SSE | YMM),
            (ALL, X87 | SSE | YMM),
        ] {
            TEST_FEATURES.with(|f| f.set(features));
            assert_eq!(supported(), all);
            for value in 0..16u64 {
                let valid = all != 0
                    && value & !all == 0
                    && value & 1 != 0
                    && (value & 4 == 0 || value & 2 != 0);
                assert_eq!(xsetbv_valid(0, value), valid, "{features:x} {value:x}");
                assert!(!xsetbv_valid(1, value));
            }
        }
        TEST_FEATURES.with(|f| f.set(0));
        assert_eq!(
            (standard_size(X87 | SSE), standard_size(X87 | SSE | YMM)),
            (576, 832)
        );
    }
}
