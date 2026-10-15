//! Side-effect-free decoding over caller-owned code bytes. Never reads live CPU memory.
#[path = "encodings.rs"]
mod generated;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GuestEip(pub u32);
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LinearAddress(pub u32);
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PhysicalAddress(pub u32);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Prefixes {
    pub operand: bool,
    pub address: bool,
    pub lock: bool,
    // Baseline accumulates F2/F3 and chooses F2 first if both are present.
    pub repne: bool,
    pub rep: bool,
    pub segment: Option<u8>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImmediateKind {
    None,
    Byte,
    SignedByte,
    Word,
    Operand,
    Address,
}
#[derive(Debug)]
pub struct Encoding {
    pub id: u32,
    pub opcode: u32,
    pub group: i8,
    pub immediate: ImmediateKind,
    pub extra_bytes: u8,
    // Interpreter dispatch fetches ModRM before selecting the mandatory-prefix form.
    pub fetch_modrm: bool,
    pub group_ud: bool,
    pub task_switch_test: bool,
    pub custom: bool,
    pub e: bool,
    pub ignore_mod: bool,
    pub reg_ud: bool,
    pub mem_ud: bool,
    pub os: bool,
    pub block_boundary: bool,
    pub no_next_instruction: bool,
    pub absolute_jump: bool,
    pub jump_offset_imm: bool,
    pub conditional_jump: bool,
    pub custom_sti: bool,
    pub is_fpu: bool,
    pub sse: bool,
    /// An SSE row whose register operands are MMX registers (gen/x86_table.js
    /// mmx_form): its task checks ignore CR4.OSFXSR
    pub mmx: bool,
    /// The prefixes that select instructions in this opcode (decode_rules::
    /// mandatory_variant): REFINING_ALL in the SSE maps
    pub refining: u8,
    /// The CPUID feature without which the row does not exist (crate::cpu::
    /// features; 0: always)
    pub feature: u32,
    /// #UD even with the feature (docs/simd-xsave-plan.md: semantics later)
    pub unimplemented: bool,
    /// A VEX row: the VEX fields it accepts (decode_rules::vex; 0: a legacy row)
    pub vex: u16,
    pub is_string: bool,
}
impl Encoding {
    /// A legacy SSE m128 operand of this form, read or written with `bytes`,
    /// must be 16-byte aligned (#GP(0), SDM vol. 2, Table 2-21): of every XMM
    /// form accessing 16 bytes but MOVUPS, MOVUPD, MOVDQU, LDDQU and PCMPxSTRx,
    /// and of UNPCKLPS/UNPCKLPD, which read its low quadword
    pub fn aligned_m128(&self, bytes: u8) -> bool {
        self.sse
            && !self.mmx
            && !matches!(
                self.opcode,
                0x0F10 | 0x660F10 | 0xF30F6F | 0x0F11 | 0x660F11 | 0xF30F7F | 0xF20FF0 | 0x660F3A60
                    ..=0x660F3A63
            )
            && (bytes == 16 || matches!(self.opcode, 0x0F14 | 0x660F14))
    }
    /// The row exists on this machine (its feature is present)
    pub fn exists(&self) -> bool { self.feature == 0 || crate::cpu::features::has(self.feature) }
    /// The row has its semantics (not Encoding::unimplemented). cargo test
    /// may decode the others as if it had (TEST_DECODE_UNIMPLEMENTED).
    pub fn implemented(&self) -> bool {
        #[cfg(test)]
        if TEST_DECODE_UNIMPLEMENTED.with(|t| t.get()) {
            return true;
        }
        !self.unimplemented
    }
}
#[cfg(test)]
thread_local! {
    /// cargo test: decode rows whose semantics come later as if they had
    /// them, for their length, operands and the encodings they refuse
    pub static TEST_DECODE_UNIMPLEMENTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EffectiveAddress {
    pub base: Option<u8>,
    /// (a vector register for a VSIB operand, Encoding::vex)
    pub index: Option<u8>,
    pub scale: u8,
    pub displacement: u32,
    pub address_size: u8,
    pub segment: u8,
}
impl EffectiveAddress {
    /// Offset arithmetic only. Segmentation and translation belong to runtime lowering.
    pub fn offset(&self, gpr: &[u32; 8]) -> u32 {
        let result = self
            .displacement
            .wrapping_add(self.base.map_or(0, |r| gpr[r as usize]))
            .wrapping_add(
                self.index
                    .map_or(0, |r| gpr[r as usize].wrapping_shl(self.scale as u32)),
            );
        if self.address_size == 16 {
            result & 0xFFFF
        }
        else {
            result
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Flow {
    Next,
    Boundary,
    Stop,
    Sti,
    Relative {
        displacement: i32,
        conditional: bool,
        call: bool,
    },
}
#[derive(Clone, Debug)]
pub struct DecodedInstruction {
    pub encoding: &'static Encoding,
    pub instruction_pc: GuestEip,
    pub next_pc: GuestEip,
    pub linear_pc: LinearAddress,
    pub bytes: [u8; 15],
    pub length: u8,
    pub operand_size: u8,
    pub address_size: u8,
    pub prefixes: Prefixes,
    pub modrm: Option<u8>,
    pub modrm_offset: Option<u8>,
    pub ea: Option<EffectiveAddress>,
    pub immediate: Option<u32>,
    pub extra_immediate: Option<u16>,
    pub baseline_ud: bool,
    /// #UD right after the ModRM byte, before EA, immediate and task-switch
    /// guards: a mandatory prefix without a row of its own (decode_rules::
    /// Variant::Undefined), a row whose CPUID feature is absent, or one whose
    /// semantics come later (Encoding::unimplemented). For VEX: also no row
    /// accepting the VEX fields (decode_rules::vex_row, vex_valid), and a
    /// 66/F2/F3/LOCK prefix, which is #UD right after the first VEX byte.
    pub early_ud: bool,
    /// The VEX prefix (C4/C5 with a register ModRM byte, decode_rules::is_vex)
    pub vex: Option<crate::decode_rules::Vex>,
    pub flow: Flow,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecodeStop {
    Incomplete { available: usize },
    TooLong,
    UnknownEncoding { opcode: u32 },
}

struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl Cursor<'_> {
    fn read(&mut self) -> Result<u8, DecodeStop> {
        if self.position == 15 {
            return Err(DecodeStop::TooLong);
        }
        let byte = *self
            .bytes
            .get(self.position)
            .ok_or(DecodeStop::Incomplete {
                available: self.bytes.len(),
            })?;
        self.position += 1;
        Ok(byte)
    }
    /// The next byte, which the instruction includes whatever it is
    fn peek(&self) -> Result<u8, DecodeStop> {
        if self.position == 15 {
            return Err(DecodeStop::TooLong);
        }
        self.bytes
            .get(self.position)
            .copied()
            .ok_or(DecodeStop::Incomplete {
                available: self.bytes.len(),
            })
    }
    fn integer(&mut self, bytes: u8) -> Result<u32, DecodeStop> {
        let mut value = 0;
        for shift in 0..bytes {
            value |= (self.read()? as u32) << (shift * 8);
        }
        Ok(value)
    }
}

pub fn encodings() -> &'static [Encoding] { generated::ENCODINGS }
/// The iced-x86 form (gen/isa_forms.json) of a VEX row
#[cfg(test)]
pub fn form(e: &Encoding) -> &'static str {
    let i = generated::FORMS
        .binary_search_by_key(&e.id, |&(id, _)| id)
        .unwrap();
    generated::FORMS[i].1
}
/// The rows of a catalogue key
pub fn candidates(opcode: u32) -> &'static [Encoding] {
    match generated::OPCODES.binary_search_by_key(&opcode, |&(key, _, _)| key) {
        Ok(i) => {
            let (_, start, end) = generated::OPCODES[i];
            &generated::ENCODINGS[start..end]
        },
        Err(_) => &[],
    }
}

/// `bytes` is a logical contiguous instruction snapshot; it may span physical pages.
/// Missing bytes return a compile stop. The caller must deliver fetch faults during execution.
pub fn decode(
    bytes: &[u8],
    pc: GuestEip,
    linear: LinearAddress,
    default_32: bool,
) -> Result<DecodedInstruction, DecodeStop> {
    let mut c = Cursor { bytes, position: 0 };
    let mut prefixes = Prefixes::default();
    let first = loop {
        let byte = c.read()?;
        use crate::decode_rules::{prefix, Prefix};
        match prefix(byte) {
            Some(Prefix::Segment(s)) => prefixes.segment = Some(s),
            Some(Prefix::Operand) => prefixes.operand = true,
            Some(Prefix::Address) => prefixes.address = true,
            Some(Prefix::Lock) => prefixes.lock = true,
            // of F2 and F3 the last one counts (decode_rules::apply_prefix)
            Some(Prefix::Repne) => {
                prefixes.rep = false;
                prefixes.repne = true;
            },
            Some(Prefix::Rep) => {
                prefixes.repne = false;
                prefixes.rep = true;
            },
            None => break byte,
        }
    };
    // C4/C5 with a register ModRM byte: a VEX prefix. This decoder does not
    // know the mode; in real and virtual-8086 mode, which have no VEX, the
    // interpreter raises #UD for the register form of LES/LDS instead, so a
    // VEX row needs that guard when it gets semantics.
    if (first == 0xC4 || first == 0xC5) && crate::decode_rules::is_vex(c.peek()?, false) {
        return decode_vex(c, bytes, pc, linear, default_32, prefixes, first);
    }
    // 0F 38 and 0F 3A lead to the three-byte maps (key 0x0F38xx, 0x0F3Axx)
    let base_opcode = if first == 0x0F {
        let second = c.read()?;
        if second == 0x38 || second == 0x3A {
            0x0F0000 | (second as u32) << 8 | c.read()? as u32
        }
        else {
            0x0F00 | second as u32
        }
    }
    else {
        first as u32
    };
    let operand_size = if default_32 != prefixes.operand { 32 } else { 16 };
    let address_size = if default_32 != prefixes.address { 32 } else { 16 };
    let mut available = 0;
    let variants = [
        (0x66, crate::prefix::PREFIX_66),
        (0xF2, crate::prefix::PREFIX_F2),
        (0xF3, crate::prefix::PREFIX_F3),
    ];
    let shift = if base_opcode > 0xFFFF {
        24
    }
    else if first == 0x0F {
        16
    }
    else {
        8
    };
    // the prefixes select instructions where a row of the opcode says so; a
    // row whose feature is absent is not available
    let mut refining = candidates(base_opcode)
        .iter()
        .fold(0, |m, row| m | row.refining);
    let mut family = candidates(base_opcode).first();
    for (prefix, mask) in variants {
        if prefix != 0x66 || first == 0x0F {
            let rows = candidates(prefix << shift | base_opcode);
            refining |= rows.iter().fold(0, |m, row| m | row.refining);
            family = family.or(rows.first());
            if rows.iter().any(Encoding::exists) {
                available |= mask;
            }
        }
    }
    let flags = if prefixes.operand { crate::prefix::PREFIX_66 } else { 0 }
        | if prefixes.repne { crate::prefix::PREFIX_F2 } else { 0 }
        | if prefixes.rep { crate::prefix::PREFIX_F3 } else { 0 };
    use crate::decode_rules::{Variant, REFINING_REP};
    let variant = crate::decode_rules::mandatory_variant(flags, available, refining);
    let refused = if flags & REFINING_REP != 0 {
        flags & REFINING_REP
    }
    else {
        flags & crate::prefix::PREFIX_66
    };
    let opcode = match variant {
        Variant::Prefixed(selected) => variants
            .iter()
            .find(|(_, mask)| *mask == selected)
            .map_or(base_opcode, |(prefix, _)| prefix << shift | base_opcode),
        // (undefined: the rows of the refused prefix, when it has some)
        Variant::Undefined => variants
            .iter()
            .find(|(_, mask)| *mask == refused)
            .map(|(prefix, _)| prefix << shift | base_opcode)
            .filter(|key| !candidates(*key).is_empty())
            .unwrap_or(base_opcode),
        Variant::Plain => base_opcode,
    };
    let rows = candidates(opcode);
    // (an opcode without a row in any variant is unknown: the interpreter
    // raises #UD at its last opcode byte)
    let first = family.ok_or(DecodeStop::UnknownEncoding { opcode })?;
    let modrm_offset = if first.fetch_modrm { Some(c.position as u8) } else { None };
    let modrm = if first.fetch_modrm { Some(c.read()?) } else { None };
    let row = rows
        .iter()
        .find(|row| row.group < 0 || modrm.map(|m| (m >> 3 & 7) as i8) == Some(row.group));
    let early_ud = variant == Variant::Undefined
        || rows.is_empty()
        || row.is_some_and(|row| !row.exists() || !row.implemented());
    let encoding = if early_ud {
        row.unwrap_or(first)
    }
    else {
        row.ok_or(DecodeStop::UnknownEncoding { opcode })?
    };
    let ea = match modrm {
        Some(m) if encoding.e && m < 0xC0 && !encoding.ignore_mod && !early_ud => {
            Some(decode_ea(&mut c, m, address_size, prefixes.segment)?)
        },
        _ => None,
    };
    let immediate = match if early_ud { ImmediateKind::None } else { encoding.immediate } {
        ImmediateKind::None => None,
        ImmediateKind::Byte => Some(c.integer(1)?),
        ImmediateKind::SignedByte => Some(c.read()? as i8 as i32 as u32),
        ImmediateKind::Word => Some(c.integer(2)?),
        ImmediateKind::Operand => Some(c.integer(operand_size / 8)?),
        ImmediateKind::Address => Some(c.integer(address_size / 8)?),
    };
    let extra_immediate = if encoding.extra_bytes > 0 && !early_ud {
        Some(c.integer(encoding.extra_bytes)? as u16)
    }
    else {
        None
    };
    let baseline_ud = early_ud
        || (if ea.is_some() { encoding.mem_ud } else { encoding.reg_ud })
        || prefixes.lock && !crate::decode_rules::lock_allowed(base_opcode, modrm);
    let flow = if encoding.jump_offset_imm {
        Flow::Relative {
            displacement: immediate.unwrap() as i32,
            conditional: encoding.conditional_jump,
            call: base_opcode == 0xE8,
        }
    }
    else if encoding.custom_sti {
        Flow::Sti
    }
    else if encoding.no_next_instruction {
        Flow::Stop
    }
    else if encoding.block_boundary || !encoding.custom && encoding.e || baseline_ud {
        Flow::Boundary
    }
    else {
        Flow::Next
    };
    let mut raw = [0; 15];
    raw[..c.position].copy_from_slice(&bytes[..c.position]);
    Ok(DecodedInstruction {
        encoding,
        instruction_pc: pc,
        next_pc: GuestEip(pc.0.wrapping_add(c.position as u32)),
        linear_pc: linear,
        bytes: raw,
        length: c.position as u8,
        operand_size,
        address_size,
        prefixes,
        modrm,
        modrm_offset,
        ea,
        immediate,
        extra_immediate,
        baseline_ud,
        early_ud,
        vex: None,
        flow,
    })
}

/// A VEX instruction: `first` (C4 or C5) and its prefixes are read
fn decode_vex(
    mut c: Cursor<'_>,
    bytes: &[u8],
    pc: GuestEip,
    linear: LinearAddress,
    default_32: bool,
    prefixes: Prefixes,
    first: u8,
) -> Result<DecodedInstruction, DecodeStop> {
    use crate::decode_rules::{vex_prefixes_ud, vex_row, vex_valid, Vex};
    let address_size = if default_32 != prefixes.address { 32 } else { 16 };
    let byte1 = c.read()?;
    let flags = if prefixes.operand { crate::prefix::PREFIX_66 } else { 0 }
        | if prefixes.repne { crate::prefix::PREFIX_F2 } else { 0 }
        | if prefixes.rep { crate::prefix::PREFIX_F3 } else { 0 }
        | if prefixes.lock { crate::prefix::PREFIX_LOCK } else { 0 };
    let instruction = |c: &Cursor<'_>,
                       encoding,
                       modrm,
                       modrm_offset,
                       ea,
                       immediate,
                       baseline_ud,
                       early_ud,
                       vex| {
        let mut raw = [0; 15];
        raw[..c.position].copy_from_slice(&bytes[..c.position]);
        DecodedInstruction {
            encoding,
            instruction_pc: pc,
            next_pc: GuestEip(pc.0.wrapping_add(c.position as u32)),
            linear_pc: linear,
            bytes: raw,
            length: c.position as u8,
            // (VEX instructions on general-purpose registers are 32-bit
            // outside 64-bit mode)
            operand_size: 32,
            address_size,
            prefixes,
            modrm,
            modrm_offset,
            ea,
            immediate,
            extra_immediate: None,
            baseline_ud,
            early_ud,
            vex,
            flow: if baseline_ud { Flow::Boundary } else { Flow::Next },
        }
    };
    // 66, F2, F3 or LOCK before VEX: #UD at the first VEX byte, where the
    // interpreter's LES/LDS (whose ModRM byte it is) checks LOCK
    if vex_prefixes_ud(flags) {
        let les = &candidates(first as u32)[0];
        return Ok(instruction(
            &c, les, None, None, None, None, true, true, None,
        ));
    }
    let v =
        if first == 0xC4 { Vex::three(byte1, c.read()?, false) } else { Vex::two(byte1, false) };
    let key = v.key(c.read()?);
    let rows = candidates(key);
    // (a key without rows, including the reserved maps, is unknown: #UD at
    // the opcode byte when run)
    let family = rows
        .first()
        .ok_or(DecodeStop::UnknownEncoding { opcode: key })?;
    let modrm_offset = if family.fetch_modrm { Some(c.position as u8) } else { None };
    let modrm = if family.fetch_modrm { Some(c.read()?) } else { None };
    let Some(row) = vex_row(rows, v, modrm, false)
        .filter(|row| row.exists() && row.implemented() && vex_valid(row, v, modrm, address_size))
    else {
        let row = vex_row(rows, v, modrm, false).unwrap_or(family);
        return Ok(instruction(
            &c,
            row,
            modrm,
            modrm_offset,
            None,
            None,
            true,
            true,
            Some(v),
        ));
    };
    use crate::decode_rules::vex;
    // (a VSIB index names a vector register, xmm4/ymm4 included)
    let vsib_index = || bytes[modrm_offset.unwrap() as usize + 1] >> 3 & 7;
    let vsib = row.vex & vex::VSIB != 0;
    let ea = match modrm {
        Some(m) if m < 0xC0 => {
            let mut ea = decode_ea(&mut c, m, address_size, prefixes.segment)?;
            if vsib {
                ea.index = Some(vsib_index());
            }
            Some(ea)
        },
        _ => None,
    };
    let immediate = match row.immediate {
        ImmediateKind::Byte => Some(c.read()? as u32),
        ImmediateKind::None => None,
        _ => unreachable!("VEX rows have no other immediates"),
    };
    // destination, index and mask registers differ (gathers)
    let baseline_ud = row.vex & vex::UNIQUE != 0 && {
        let (reg, mask, index) = (modrm.unwrap() >> 3 & 7, v.vvvv, vsib_index());
        reg == index || mask == index || reg == mask
    };
    Ok(instruction(
        &c,
        row,
        modrm,
        modrm_offset,
        ea,
        immediate,
        baseline_ud,
        false,
        Some(v),
    ))
}

fn decode_ea(
    c: &mut Cursor<'_>,
    modrm: u8,
    size: u8,
    segment: Option<u8>,
) -> Result<EffectiveAddress, DecodeStop> {
    let sib = if size == 32 && modrm & 7 == 4 { Some(c.read()?) } else { None };
    let form = crate::decode_rules::address_form(modrm, size, sib);
    let displacement = if form.displacement_bytes == 1 {
        c.read()? as i8 as i32 as u32
    }
    else {
        c.integer(form.displacement_bytes)?
    };
    Ok(EffectiveAddress {
        base: form.base,
        index: form.index,
        scale: form.scale,
        displacement,
        address_size: size,
        segment: segment.unwrap_or(form.segment),
    })
}

#[cfg(test)]
#[path = "../../../tests/decode/decode.rs"]
mod tests;
