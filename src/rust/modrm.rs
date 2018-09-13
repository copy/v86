use codegen;
use cpu_context::CpuContext;
use jit::JitContext;
use prefix::{PREFIX_MASK_SEGMENT, SEG_PREFIX_ZERO};
use regs::{BP, BX, DI, SI};
use regs::{DS, SS};
use regs::{EAX, EBP, EBX, ECX, EDI, EDX, ESI, ESP};
use wasmgen::wasm_util::WasmBuf;

pub fn skip(ctx: &mut CpuContext, modrm_byte: u8) {
    if ctx.asize_32() {
        skip32(ctx, modrm_byte)
    }
    else {
        skip16(ctx, modrm_byte)
    }
}

fn skip16(ctx: &mut CpuContext, modrm_byte: u8) {
    dbg_assert!(modrm_byte < 0xC0);
    let r = modrm_byte & 7;

    if modrm_byte < 0x40 {
        if r == 6 {
            ctx.advance16()
        }
    }
    else if modrm_byte < 0x80 {
        ctx.advance8()
    }
    else {
        ctx.advance16()
    }
}

fn skip32(ctx: &mut CpuContext, modrm_byte: u8) {
    dbg_assert!(modrm_byte < 0xC0);
    let r = modrm_byte & 7;

    if r == 4 {
        let sib = ctx.read_imm8();
        if modrm_byte < 0x40 {
            if sib & 7 == 5 {
                ctx.advance32()
            }
        }
        else if modrm_byte < 0x80 {
            ctx.advance8()
        }
        else {
            ctx.advance32()
        }
    }
    else if r == 5 && modrm_byte < 0x40 {
        ctx.advance32();
    }
    else {
        if modrm_byte < 0x40 {
            // Nothing
        }
        else if modrm_byte < 0x80 {
            ctx.advance8()
        }
        else {
            ctx.advance32()
        }
    }
}

pub fn gen(ctx: &mut JitContext, modrm_byte: u8) {
    if ctx.cpu.asize_32() {
        gen32(ctx, modrm_byte)
    }
    else {
        gen16(ctx, modrm_byte)
    }
}

enum Imm16 {
    None,
    Imm8,
    Imm16,
}

enum Offset16 {
    Zero,
    One(u32),
    Two(u32, u32),
}

fn gen16_case(ctx: &mut JitContext, seg: u32, offset: Offset16, imm: Imm16) {
    // Generates one of:
    // - add_segment(reg)
    // - add_segment(imm)
    // - add_segment(reg1 + reg2 & 0xFFFF)
    // - add_segment(reg1 + imm & 0xFFFF)
    // - add_segment(reg1 + reg2 + imm & 0xFFFF)

    let immediate_value = match imm {
        Imm16::None => 0,
        Imm16::Imm8 => ctx.cpu.read_imm8s() as i32,
        Imm16::Imm16 => ctx.cpu.read_imm16s() as i32,
    };

    match offset {
        Offset16::Zero => {
            ctx.builder
                .instruction_body
                .const_i32(immediate_value & 0xFFFF);
        },
        Offset16::One(r) => {
            codegen::gen_get_reg16(ctx.builder, r);

            if immediate_value != 0 {
                ctx.builder.instruction_body.const_i32(immediate_value);
                ctx.builder.instruction_body.add_i32();

                ctx.builder.instruction_body.const_i32(0xFFFF);
                ctx.builder.instruction_body.and_i32();
            }
        },
        Offset16::Two(r1, r2) => {
            codegen::gen_get_reg16(ctx.builder, r1);
            codegen::gen_get_reg16(ctx.builder, r2);
            ctx.builder.instruction_body.add_i32();

            if immediate_value != 0 {
                ctx.builder.instruction_body.const_i32(immediate_value);
                ctx.builder.instruction_body.add_i32();
            }

            ctx.builder.instruction_body.const_i32(0xFFFF);
            ctx.builder.instruction_body.and_i32();
        },
    }

    jit_add_seg_offset(ctx, seg);
}

fn gen16(ctx: &mut JitContext, modrm_byte: u8) {
    match modrm_byte & !0o070 {
        0o000 => gen16_case(ctx, DS, Offset16::Two(BX, SI), Imm16::None),
        0o001 => gen16_case(ctx, DS, Offset16::Two(BX, DI), Imm16::None),
        0o002 => gen16_case(ctx, SS, Offset16::Two(BP, SI), Imm16::None),
        0o003 => gen16_case(ctx, SS, Offset16::Two(BP, DI), Imm16::None),
        0o004 => gen16_case(ctx, DS, Offset16::One(SI), Imm16::None),
        0o005 => gen16_case(ctx, DS, Offset16::One(DI), Imm16::None),
        0o006 => gen16_case(ctx, DS, Offset16::Zero, Imm16::Imm16),
        0o007 => gen16_case(ctx, DS, Offset16::One(BX), Imm16::None),

        0o100 => gen16_case(ctx, DS, Offset16::Two(BX, SI), Imm16::Imm8),
        0o101 => gen16_case(ctx, DS, Offset16::Two(BX, DI), Imm16::Imm8),
        0o102 => gen16_case(ctx, SS, Offset16::Two(BP, SI), Imm16::Imm8),
        0o103 => gen16_case(ctx, SS, Offset16::Two(BP, DI), Imm16::Imm8),
        0o104 => gen16_case(ctx, DS, Offset16::One(SI), Imm16::Imm8),
        0o105 => gen16_case(ctx, DS, Offset16::One(DI), Imm16::Imm8),
        0o106 => gen16_case(ctx, SS, Offset16::One(BP), Imm16::Imm8),
        0o107 => gen16_case(ctx, DS, Offset16::One(BX), Imm16::Imm8),

        0o200 => gen16_case(ctx, DS, Offset16::Two(BX, SI), Imm16::Imm16),
        0o201 => gen16_case(ctx, DS, Offset16::Two(BX, DI), Imm16::Imm16),
        0o202 => gen16_case(ctx, SS, Offset16::Two(BP, SI), Imm16::Imm16),
        0o203 => gen16_case(ctx, SS, Offset16::Two(BP, DI), Imm16::Imm16),
        0o204 => gen16_case(ctx, DS, Offset16::One(SI), Imm16::Imm16),
        0o205 => gen16_case(ctx, DS, Offset16::One(DI), Imm16::Imm16),
        0o206 => gen16_case(ctx, SS, Offset16::One(BP), Imm16::Imm16),
        0o207 => gen16_case(ctx, DS, Offset16::One(BX), Imm16::Imm16),

        _ => assert!(false),
    }
}

#[derive(PartialEq)]
enum Imm32 {
    None,
    Imm8,
    Imm32,
}

enum Offset {
    Reg(u32),
    Sib,
    None,
}

fn gen32_case(ctx: &mut JitContext, seg: u32, offset: Offset, imm: Imm32) {
    match offset {
        Offset::Sib => {
            gen_sib(ctx, imm != Imm32::None);

            let immediate_value = match imm {
                Imm32::None => 0,
                Imm32::Imm8 => ctx.cpu.read_imm8s() as i32,
                Imm32::Imm32 => ctx.cpu.read_imm32() as i32,
            };

            if immediate_value != 0 {
                ctx.builder.instruction_body.const_i32(immediate_value);
                ctx.builder.instruction_body.add_i32();
            }
        },
        Offset::Reg(r) => {
            let immediate_value = match imm {
                Imm32::None => 0,
                Imm32::Imm8 => ctx.cpu.read_imm8s() as i32,
                Imm32::Imm32 => ctx.cpu.read_imm32() as i32,
            };
            codegen::gen_get_reg32(ctx.builder, r);
            if immediate_value != 0 {
                ctx.builder.instruction_body.const_i32(immediate_value);
                ctx.builder.instruction_body.add_i32();
            }
            jit_add_seg_offset(ctx, seg);
        },
        Offset::None => {
            let immediate_value = match imm {
                Imm32::None => 0,
                Imm32::Imm8 => ctx.cpu.read_imm8s() as i32,
                Imm32::Imm32 => ctx.cpu.read_imm32() as i32,
            };
            ctx.builder.instruction_body.const_i32(immediate_value);
            jit_add_seg_offset(ctx, seg);
        },
    }
}

fn gen32(ctx: &mut JitContext, modrm_byte: u8) {
    match modrm_byte & !0o070 {
        0o000 => gen32_case(ctx, DS, Offset::Reg(EAX), Imm32::None),
        0o001 => gen32_case(ctx, DS, Offset::Reg(ECX), Imm32::None),
        0o002 => gen32_case(ctx, DS, Offset::Reg(EDX), Imm32::None),
        0o003 => gen32_case(ctx, DS, Offset::Reg(EBX), Imm32::None),
        0o004 => gen32_case(ctx, DS, Offset::Sib, Imm32::None),
        0o005 => gen32_case(ctx, DS, Offset::None, Imm32::Imm32),
        0o006 => gen32_case(ctx, DS, Offset::Reg(ESI), Imm32::None),
        0o007 => gen32_case(ctx, DS, Offset::Reg(EDI), Imm32::None),

        0o100 => gen32_case(ctx, DS, Offset::Reg(EAX), Imm32::Imm8),
        0o101 => gen32_case(ctx, DS, Offset::Reg(ECX), Imm32::Imm8),
        0o102 => gen32_case(ctx, DS, Offset::Reg(EDX), Imm32::Imm8),
        0o103 => gen32_case(ctx, DS, Offset::Reg(EBX), Imm32::Imm8),
        0o104 => gen32_case(ctx, DS, Offset::Sib, Imm32::Imm8),
        0o105 => gen32_case(ctx, SS, Offset::Reg(EBP), Imm32::Imm8),
        0o106 => gen32_case(ctx, DS, Offset::Reg(ESI), Imm32::Imm8),
        0o107 => gen32_case(ctx, DS, Offset::Reg(EDI), Imm32::Imm8),

        0o200 => gen32_case(ctx, DS, Offset::Reg(EAX), Imm32::Imm32),
        0o201 => gen32_case(ctx, DS, Offset::Reg(ECX), Imm32::Imm32),
        0o202 => gen32_case(ctx, DS, Offset::Reg(EDX), Imm32::Imm32),
        0o203 => gen32_case(ctx, DS, Offset::Reg(EBX), Imm32::Imm32),
        0o204 => gen32_case(ctx, DS, Offset::Sib, Imm32::Imm32),
        0o205 => gen32_case(ctx, SS, Offset::Reg(EBP), Imm32::Imm32),
        0o206 => gen32_case(ctx, DS, Offset::Reg(ESI), Imm32::Imm32),
        0o207 => gen32_case(ctx, DS, Offset::Reg(EDI), Imm32::Imm32),

        _ => assert!(false),
    }
}

fn gen_sib(ctx: &mut JitContext, mod_is_nonzero: bool) {
    let sib_byte = ctx.cpu.read_imm8();
    let r = sib_byte & 7;
    let m = sib_byte >> 3 & 7;

    let seg;

    // Generates: get_seg_prefix(seg) + base
    // Where base is a register or constant

    if r == 4 {
        seg = SS;
        codegen::gen_get_reg32(ctx.builder, ESP);
    }
    else if r == 5 {
        if mod_is_nonzero {
            seg = SS;
            codegen::gen_get_reg32(ctx.builder, EBP);
        }
        else {
            seg = DS;
            let base = ctx.cpu.read_imm32();
            ctx.builder.instruction_body.const_i32(base as i32);
        }
    }
    else {
        seg = DS;
        codegen::gen_get_reg32(ctx.builder, r as u32);
    }

    jit_add_seg_offset(ctx, seg);

    // We now have to generate an offset value to add

    if m == 4 {
        // offset is 0, we don't need to add anything
        return;
    }

    // Offset is reg32s[m] << s, where s is:

    let s = sib_byte >> 6 & 3;

    codegen::gen_get_reg32(ctx.builder, m as u32);
    ctx.builder.instruction_body.const_i32(s as i32);
    ctx.builder.instruction_body.shl_i32();

    ctx.builder.instruction_body.add_i32();
}

fn can_optimize_get_seg(ctx: &mut JitContext, segment: u32) -> bool {
    (segment == DS || segment == SS) && ctx.cpu.has_flat_segmentation()
}

pub fn jit_add_seg_offset(ctx: &mut JitContext, default_segment: u32) {
    let prefix = ctx.cpu.prefixes & PREFIX_MASK_SEGMENT;
    let seg = if prefix != 0 {
        prefix - 1
    }
    else {
        default_segment
    };

    if can_optimize_get_seg(ctx, seg) || prefix == SEG_PREFIX_ZERO {
        return;
    }

    ctx.builder.instruction_body.const_i32(seg as i32);
    ctx.builder.instruction_body.call_fn(::jit::FN_GET_SEG_IDX);
    ctx.builder.instruction_body.add_i32();
}
