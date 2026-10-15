//! The x87 forms the page tier inlines or hands to its helper (x86tpl::x87
//! and x87run; x64::helpers::x64_x87): which register forms are valid, how
//! each form moves its memory operand, and the f64 forms inlined against the
//! shadow cache. (ir::x87 until docs/jit-unification-plan.md M11 deleted
//! the region tiers, which split continuing x87 instructions the same way.)

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Io {
    /// Consumes the loaded operand as (low, high) 32-bit words.
    Load { bytes: u8 },
    /// Produces the operand to store as (low, high) 32-bit words.
    Store { bytes: u8 },
    /// Register form: stack/status only.
    Stack,
}

/// The register encoding is architecturally defined (no nested #UD).
pub fn valid_register(opcode: u8, group: u8, r: u8) -> bool {
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

/// FCMOVcc reads FLAGS; FCOMI/FUCOMI(P) write FLAGS; FNSTSW AX writes AX.
fn register_touches_cpu(opcode: u8, group: u8) -> bool {
    matches!(
        (opcode, group),
        (0xDA, 0..=3) | (0xDB, 0..=3 | 5 | 6) | (0xDF, 4..=6)
    )
}

/// Operand transfer of a continuing form, or None for forms that keep helpers.
pub fn io(opcode: u8, modrm: u8) -> Option<Io> {
    let group = modrm >> 3 & 7;
    if modrm >= 0xC0 {
        let r = modrm & 7;
        return (valid_register(opcode, group, r) && !register_touches_cpu(opcode, group))
            .then_some(Io::Stack);
    }
    Some(match (opcode, group) {
        (0xD8 | 0xDA, _) | (0xD9 | 0xDB, 0) => Io::Load { bytes: 4 },
        (0xDC, _) | (0xDD, 0) | (0xDF, 5) => Io::Load { bytes: 8 },
        (0xDE, _) | (0xDF, 0) | (0xD9, 5) => Io::Load { bytes: 2 },
        (0xD9, 2 | 3) | (0xDB, 1..=3) => Io::Store { bytes: 4 },
        (0xDD, 1..=3) | (0xDF, 7) => Io::Store { bytes: 8 },
        (0xDF, 1..=3) | (0xD9, 7) | (0xDD, 7) => Io::Store { bytes: 2 },
        _ => return None,
    })
}

/// Memory operand encodings of an inlined form.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Operand {
    F32,
    F64,
    I16,
    I32,
    I64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Source {
    Memory(Operand),
    /// ST(r), relative to TOP before the instruction.
    Register(u8),
    /// FLD1/FLDZ.
    Constant(bool),
}
/// `x` is ST(0), `y` the source: Sub = x - y, SubR = y - x, likewise Div.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Arithmetic {
    Add,
    Mul,
    Sub,
    SubR,
    Div,
    DivR,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stored {
    F32,
    F64,
    Integer { bytes: u8, truncate: bool },
}
/// Fast-math semantics that generated code may inline against the shared f64
/// shadow cache, falling back to the helper (`x64_x87`) whenever an operand is not an
/// exact cached value, a result needs F80 flags, or the stack would fault.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Native {
    Push(Source),
    /// ST(target) = op(ST(0), source), then `pops`.
    Arithmetic {
        op: Arithmetic,
        source: Source,
        target: u8,
        pops: u8,
    },
    /// C0/C3 from ST(0) ? source (C1/C2 cleared), then `pops`.
    Compare {
        source: Source,
        pops: u8,
    },
    Exchange(u8),
    /// FST(P) ST(r).
    Copy {
        r: u8,
        pops: u8,
    },
    Unary {
        negate: bool,
    },
    Free {
        r: u8,
        pops: u8,
    },
    Store {
        to: Stored,
        pops: u8,
    },
    StoreControl,
    StoreStatus,
}
fn arithmetic(group: u8) -> Option<Arithmetic> {
    Some(match group {
        0 => Arithmetic::Add,
        1 => Arithmetic::Mul,
        4 => Arithmetic::Sub,
        5 => Arithmetic::SubR,
        6 => Arithmetic::Div,
        7 => Arithmetic::DivR,
        _ => return None,
    })
}
pub fn native(opcode: u8, modrm: u8) -> Option<Native> {
    io(opcode, modrm)?;
    let group = modrm >> 3 & 7;
    let r = modrm & 7;
    if modrm < 0xC0 {
        let operand = |opcode| match opcode {
            0xD8 => Operand::F32,
            0xDA => Operand::I32,
            0xDC => Operand::F64,
            _ => Operand::I16,
        };
        return Some(match (opcode, group) {
            (0xD8 | 0xDA | 0xDC | 0xDE, 2 | 3) => Native::Compare {
                source: Source::Memory(operand(opcode)),
                pops: group - 2,
            },
            (0xD8 | 0xDA | 0xDC | 0xDE, _) => Native::Arithmetic {
                op: arithmetic(group)?,
                source: Source::Memory(operand(opcode)),
                target: 0,
                pops: 0,
            },
            (0xD9, 0) => Native::Push(Source::Memory(Operand::F32)),
            (0xDD, 0) => Native::Push(Source::Memory(Operand::F64)),
            (0xDB, 0) => Native::Push(Source::Memory(Operand::I32)),
            (0xDF, 0) => Native::Push(Source::Memory(Operand::I16)),
            (0xDF, 5) => Native::Push(Source::Memory(Operand::I64)),
            (0xD9, 2 | 3) => Native::Store {
                to: Stored::F32,
                pops: group - 2,
            },
            (0xDD, 2 | 3) => Native::Store {
                to: Stored::F64,
                pops: group - 2,
            },
            (0xDB | 0xDD | 0xDF, 1..=3) | (0xDF, 7) => Native::Store {
                to: Stored::Integer {
                    bytes: match (opcode, group) {
                        (0xDB, _) => 4,
                        (0xDD, _) | (_, 7) => 8,
                        _ => 2,
                    },
                    truncate: group == 1,
                },
                pops: (group != 2) as u8,
            },
            (0xD9, 7) => Native::StoreControl,
            (0xDD, 7) => Native::StoreStatus,
            _ => return None,
        });
    }
    let register = Source::Register(r);
    Some(match (opcode, group) {
        (0xD8 | 0xDC, 2 | 3) => Native::Compare {
            source: register,
            pops: group - 2,
        },
        (0xDE, 2) => Native::Compare {
            source: register,
            pops: 1,
        },
        (0xDE, 3) | (0xDA, 5) => Native::Compare {
            source: Source::Register(1),
            pops: 2,
        },
        (0xDD, 4 | 5) => Native::Compare {
            source: register,
            pops: group - 4,
        },
        (0xD8 | 0xDC | 0xDE, _) => Native::Arithmetic {
            op: arithmetic(group)?,
            source: register,
            target: if opcode == 0xD8 { 0 } else { r },
            pops: (opcode == 0xDE) as u8,
        },
        (0xD9, 0) => Native::Push(register),
        (0xD9 | 0xDD | 0xDF, 1) => Native::Exchange(r),
        (0xD9, 3) | (0xDD, 3) | (0xDF, 2 | 3) => Native::Copy { r, pops: 1 },
        (0xDD, 2) => Native::Copy { r, pops: 0 },
        (0xD9, 4) if r <= 1 => Native::Unary { negate: r == 0 },
        (0xD9, 5) if r == 0 || r == 6 => Native::Push(Source::Constant(r == 0)),
        (0xDD, 0) => Native::Free { r, pops: 0 },
        (0xDF, 0) => Native::Free { r, pops: 1 },
        _ => return None,
    })
}
