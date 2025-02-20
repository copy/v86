use crate::codegen;
use crate::cpu::global_pointers;
use crate::cpu_context::CpuContext;
use crate::jit::JitContext;
use crate::prefix::{PREFIX_MASK_SEGMENT, SEG_PREFIX_ZERO};
use crate::profiler;
use crate::regs::{BP, BX, DI, SI};
use crate::regs::{CS, DS, ES, FS, GS, SS};
use crate::regs::{EAX, EBP, EBX, ECX, EDI, EDX, ESI, ESP};

pub struct ModrmByte {
    segment: u32,
    first_reg: Option<u32>,
    second_reg: Option<u32>,
    shift: u8,
    immediate: i32,
    is_16: bool,
}
impl ModrmByte {
    pub fn is_nop(&self, reg: u32) -> bool {
        self.first_reg == Some(reg)
            && self.second_reg.is_none()
            && self.shift == 0
            && self.immediate == 0
            && !self.is_16
    }
}

pub fn decode(ctx: &mut CpuContext, modrm_byte: u8) -> ModrmByte {
    if ctx.asize_32() {
        decode32(ctx, modrm_byte)
    }
    else {
        decode16(ctx, modrm_byte)
    }
}

fn decode16(ctx: &mut CpuContext, modrm_byte: u8) -> ModrmByte {
    fn mk16(
        segment: u32,
        first_reg: Option<u32>,
        second_reg: Option<u32>,
        immediate: i32,
    ) -> ModrmByte {
        ModrmByte {
            segment,
            first_reg,
            second_reg,
            shift: 0,
            immediate,
            is_16: true,
        }
    }

    match modrm_byte & !0o070 {
        0o000 => mk16(DS, Some(BX), Some(SI), 0),
        0o001 => mk16(DS, Some(BX), Some(DI), 0),
        0o002 => mk16(SS, Some(BP), Some(SI), 0),
        0o003 => mk16(SS, Some(BP), Some(DI), 0),
        0o004 => mk16(DS, Some(SI), None, 0),
        0o005 => mk16(DS, Some(DI), None, 0),
        0o006 => mk16(DS, None, None, ctx.read_imm16() as i32),
        0o007 => mk16(DS, Some(BX), None, 0),

        0o100 => mk16(DS, Some(BX), Some(SI), ctx.read_imm8s() as i32),
        0o101 => mk16(DS, Some(BX), Some(DI), ctx.read_imm8s() as i32),
        0o102 => mk16(SS, Some(BP), Some(SI), ctx.read_imm8s() as i32),
        0o103 => mk16(SS, Some(BP), Some(DI), ctx.read_imm8s() as i32),
        0o104 => mk16(DS, Some(SI), None, ctx.read_imm8s() as i32),
        0o105 => mk16(DS, Some(DI), None, ctx.read_imm8s() as i32),
        0o106 => mk16(SS, Some(BP), None, ctx.read_imm8s() as i32),
        0o107 => mk16(DS, Some(BX), None, ctx.read_imm8s() as i32),

        0o200 => mk16(DS, Some(BX), Some(SI), ctx.read_imm16() as i32),
        0o201 => mk16(DS, Some(BX), Some(DI), ctx.read_imm16() as i32),
        0o202 => mk16(SS, Some(BP), Some(SI), ctx.read_imm16() as i32),
        0o203 => mk16(SS, Some(BP), Some(DI), ctx.read_imm16() as i32),
        0o204 => mk16(DS, Some(SI), None, ctx.read_imm16() as i32),
        0o205 => mk16(DS, Some(DI), None, ctx.read_imm16() as i32),
        0o206 => mk16(SS, Some(BP), None, ctx.read_imm16() as i32),
        0o207 => mk16(DS, Some(BX), None, ctx.read_imm16() as i32),

        _ => panic!("modrm byte >= 0xC0"),
    }
}

fn decode32(ctx: &mut CpuContext, modrm_byte: u8) -> ModrmByte {
    fn mk32(segment: u32, first_reg: Option<u32>, immediate: i32) -> ModrmByte {
        ModrmByte {
            segment,
            first_reg,
            second_reg: None,
            shift: 0,
            immediate,
            is_16: false,
        }
    }

    match modrm_byte & !0o070 {
        0o000 => mk32(DS, Some(EAX), 0),
        0o001 => mk32(DS, Some(ECX), 0),
        0o002 => mk32(DS, Some(EDX), 0),
        0o003 => mk32(DS, Some(EBX), 0),
        0o004 => decode_sib(ctx, Imm32::None),
        0o005 => mk32(DS, None, ctx.read_imm32() as i32),
        0o006 => mk32(DS, Some(ESI), 0),
        0o007 => mk32(DS, Some(EDI), 0),

        0o100 => mk32(DS, Some(EAX), ctx.read_imm8s() as i32),
        0o101 => mk32(DS, Some(ECX), ctx.read_imm8s() as i32),
        0o102 => mk32(DS, Some(EDX), ctx.read_imm8s() as i32),
        0o103 => mk32(DS, Some(EBX), ctx.read_imm8s() as i32),
        0o104 => decode_sib(ctx, Imm32::Imm8),
        0o105 => mk32(SS, Some(EBP), ctx.read_imm8s() as i32),
        0o106 => mk32(DS, Some(ESI), ctx.read_imm8s() as i32),
        0o107 => mk32(DS, Some(EDI), ctx.read_imm8s() as i32),

        0o200 => mk32(DS, Some(EAX), ctx.read_imm32() as i32),
        0o201 => mk32(DS, Some(ECX), ctx.read_imm32() as i32),
        0o202 => mk32(DS, Some(EDX), ctx.read_imm32() as i32),
        0o203 => mk32(DS, Some(EBX), ctx.read_imm32() as i32),
        0o204 => decode_sib(ctx, Imm32::Imm32),
        0o205 => mk32(SS, Some(EBP), ctx.read_imm32() as i32),
        0o206 => mk32(DS, Some(ESI), ctx.read_imm32() as i32),
        0o207 => mk32(DS, Some(EDI), ctx.read_imm32() as i32),

        _ => panic!("modrm byte >= 0xC0"),
    }
}

fn decode_sib(ctx: &mut CpuContext, immediate: Imm32) -> ModrmByte {
    let sib_byte = ctx.read_imm8();
    let r = sib_byte & 7;
    let m = sib_byte >> 3 & 7;
    let shift = sib_byte >> 6 & 3;

    let second_reg = if m == 4 { None } else { Some(m as u32) };

    let segment;
    let reg;

    if r == 4 {
        segment = SS;
        reg = ESP;
    }
    else if r == 5 {
        if immediate == Imm32::None {
            return ModrmByte {
                segment: DS,
                first_reg: None,
                second_reg,
                shift,
                immediate: ctx.read_imm32() as i32,
                is_16: false,
            };
        }
        else {
            segment = SS;
            reg = EBP;
        }
    }
    else {
        segment = DS;
        reg = r as u32;
    }

    let immediate = match immediate {
        Imm32::None => 0,
        Imm32::Imm8 => ctx.read_imm8s() as i32,
        Imm32::Imm32 => ctx.read_imm32() as i32,
    };

    ModrmByte {
        segment,
        first_reg: Some(reg),
        second_reg,
        shift,
        immediate,
        is_16: false,
    }
}

pub fn gen(ctx: &mut JitContext, modrm_byte: ModrmByte, esp_offset: i32) {
    codegen::gen_profiler_stat_increment(
        ctx.builder,
        match modrm_byte {
            ModrmByte {
                first_reg: None,
                second_reg: None,
                ..
            } => profiler::stat::MODRM_SIMPLE_CONST_OFFSET,
            ModrmByte {
                first_reg: Some(_),
                second_reg: None,
                ..
            }
            | ModrmByte {
                first_reg: None,
                second_reg: Some(_),
                shift: 0,
                ..
            } => {
                if modrm_byte.immediate == 0 {
                    profiler::stat::MODRM_SIMPLE_REG
                }
                else {
                    profiler::stat::MODRM_SIMPLE_REG_WITH_OFFSET
                }
            },
            _ => profiler::stat::MODRM_COMPLEX,
        },
    );

    let mut have_something_on_stack = false;

    if let Some(reg) = modrm_byte.first_reg {
        codegen::gen_get_reg32(ctx, reg);
        if reg == ESP && esp_offset != 0 {
            ctx.builder.const_i32(esp_offset);
            ctx.builder.add_i32();
        }
        have_something_on_stack = true;
    }

    if let Some(reg) = modrm_byte.second_reg {
        codegen::gen_get_reg32(ctx, reg);
        dbg_assert!(reg != ESP); // second reg cannot be esp, no need to handle esp_offset
        if modrm_byte.shift != 0 {
            ctx.builder.const_i32(modrm_byte.shift.into());
            ctx.builder.shl_i32();
        }
        if have_something_on_stack {
            ctx.builder.add_i32();
        }
        have_something_on_stack = true;
    }

    if modrm_byte.immediate != 0 || !have_something_on_stack {
        ctx.builder.const_i32(modrm_byte.immediate);
        if have_something_on_stack {
            ctx.builder.add_i32();
        }
    }

    if modrm_byte.is_16 {
        ctx.builder.const_i32(0xFFFF);
        ctx.builder.and_i32();
    }
    jit_add_seg_offset(ctx, modrm_byte.segment);
}

pub fn get_as_reg_index_if_possible(ctx: &mut JitContext, modrm_byte: &ModrmByte) -> Option<u32> {
    let prefix = ctx.cpu.prefixes & PREFIX_MASK_SEGMENT;
    let seg = if prefix != 0 { (prefix - 1) as u32 } else { modrm_byte.segment };
    if can_optimize_get_seg(ctx, seg)
        && modrm_byte.second_reg.is_none()
        && modrm_byte.immediate == 0
        && !modrm_byte.is_16
        && modrm_byte.shift == 0
    {
        modrm_byte.first_reg
    }
    else {
        None
    }
}

pub fn skip(ctx: &mut CpuContext, modrm_byte: u8) { let _ = decode(ctx, modrm_byte); }

#[derive(PartialEq)]
enum Imm32 {
    None,
    Imm8,
    Imm32,
}

fn can_optimize_get_seg(ctx: &mut JitContext, segment: u32) -> bool {
    (segment == DS || segment == SS || segment == CS) && ctx.cpu.has_flat_segmentation()
}

pub fn jit_add_seg_offset(ctx: &mut JitContext, default_segment: u32) {
    let prefix = ctx.cpu.prefixes & PREFIX_MASK_SEGMENT;

    if prefix == SEG_PREFIX_ZERO {
        return;
    }

    let seg = if prefix != 0 { (prefix - 1) as u32 } else { default_segment };
    jit_add_seg_offset_no_override(ctx, seg);
}

pub fn jit_add_seg_offset_no_override(ctx: &mut JitContext, seg: u32) {
    if can_optimize_get_seg(ctx, seg) {
        codegen::gen_profiler_stat_increment(ctx.builder, profiler::stat::SEG_OFFSET_OPTIMISED);
        return;
    }
    codegen::gen_profiler_stat_increment(ctx.builder, profiler::stat::SEG_OFFSET_NOT_OPTIMISED);
    codegen::gen_profiler_stat_increment(
        ctx.builder,
        if seg == ES {
            profiler::stat::SEG_OFFSET_NOT_OPTIMISED_ES
        }
        else if seg == FS {
            profiler::stat::SEG_OFFSET_NOT_OPTIMISED_FS
        }
        else if seg == GS {
            profiler::stat::SEG_OFFSET_NOT_OPTIMISED_GS
        }
        else {
            profiler::stat::SEG_OFFSET_NOT_OPTIMISED_NOT_FLAT
        },
    );

    if seg != CS && seg != SS {
        if cfg!(feature = "profiler") {
            ctx.builder.const_i32(seg as i32);
            ctx.builder.call_fn1("log_segment_null");
        }

        ctx.builder
            .load_fixed_u8(global_pointers::get_segment_is_null_offset(seg));
        ctx.builder.if_void();
        codegen::gen_trigger_gp(ctx, 0);
        ctx.builder.block_end();
    }

    ctx.builder
        .load_fixed_i32(global_pointers::get_seg_offset(seg));
    ctx.builder.add_i32();
}
