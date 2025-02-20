#![allow(non_snake_case)]

use crate::codegen;
use crate::codegen::{BitSize, ConditionNegate};
use crate::cpu::cpu::{
    FLAGS_ALL, FLAGS_DEFAULT, FLAGS_MASK, FLAG_ADJUST, FLAG_CARRY, FLAG_DIRECTION, FLAG_INTERRUPT,
    FLAG_IOPL, FLAG_OVERFLOW, FLAG_SUB, FLAG_VM, FLAG_ZERO, OPSIZE_16, OPSIZE_32, OPSIZE_8,
};
use crate::cpu::global_pointers;
use crate::gen;
use crate::jit::{Instruction, InstructionOperand, InstructionOperandDest, JitContext};
use crate::modrm::{jit_add_seg_offset, jit_add_seg_offset_no_override, ModrmByte};
use crate::prefix::{PREFIX_66, PREFIX_67, PREFIX_F2, PREFIX_F3};
use crate::prefix::{PREFIX_MASK_SEGMENT, SEG_PREFIX_ZERO};
use crate::regs;
use crate::regs::{AX, BP, BX, CX, DI, DX, SI, SP};
use crate::regs::{CS, DS, ES, FS, GS, SS};
use crate::regs::{EAX, EBP, EBX, ECX, EDI, EDX, ESI, ESP};
use crate::wasmgen::wasm_builder::{WasmBuilder, WasmLocal};

enum LocalOrImmediate<'a> {
    WasmLocal(&'a WasmLocal),
    Immediate(i32),
}

impl<'a> LocalOrImmediate<'a> {
    pub fn gen_get(&self, builder: &mut WasmBuilder) {
        match self {
            LocalOrImmediate::WasmLocal(l) => builder.get_local(l),
            LocalOrImmediate::Immediate(i) => builder.const_i32(*i),
        }
    }
    pub fn gen_get_mask255(&self, builder: &mut WasmBuilder) {
        match self {
            LocalOrImmediate::WasmLocal(l) => {
                builder.get_local(l);
                builder.const_i32(0xFF);
                builder.and_i32()
            },
            LocalOrImmediate::Immediate(i) => builder.const_i32(*i & 0xFF),
        }
    }
    pub fn eq_local(&self, other_local: &WasmLocal) -> bool {
        match self {
            &LocalOrImmediate::WasmLocal(local) => local == other_local,
            LocalOrImmediate::Immediate(_) => false,
        }
    }
    pub fn is_zero(&self) -> bool {
        match self {
            LocalOrImmediate::Immediate(0) => true,
            _ => false,
        }
    }

    fn to_instruction_operand(&self, ctx: &mut JitContext) -> InstructionOperand {
        match self {
            &LocalOrImmediate::WasmLocal(source) => {
                local_to_instruction_operand(ctx, source).into()
            },
            &LocalOrImmediate::Immediate(i) => InstructionOperand::Immediate(i),
        }
    }
}

fn local_to_instruction_operand(ctx: &mut JitContext, local: &WasmLocal) -> InstructionOperandDest {
    if ctx.register_locals.iter().any(|l| l == local) {
        // safe because register locals are alive for the duration of the entire function
        InstructionOperandDest::WasmLocal(local.unsafe_clone())
    }
    else {
        InstructionOperandDest::Other
    }
}

pub fn jit_instruction(ctx: &mut JitContext, instr_flags: &mut u32) {
    ctx.cpu.prefixes = 0;
    ctx.start_of_current_instruction = ctx.cpu.eip;
    gen::jit::jit(
        ctx.cpu.read_imm8() as u32 | (ctx.cpu.osize_32() as u32) << 8,
        ctx,
        instr_flags,
    );
}

pub fn jit_handle_prefix(ctx: &mut JitContext, instr_flags: &mut u32) {
    gen::jit::jit(
        ctx.cpu.read_imm8() as u32 | (ctx.cpu.osize_32() as u32) << 8,
        ctx,
        instr_flags,
    );
}

pub fn jit_handle_segment_prefix(segment: u32, ctx: &mut JitContext, instr_flags: &mut u32) {
    dbg_assert!(segment <= 5);
    ctx.cpu.prefixes |= segment as u8 + 1;
    jit_handle_prefix(ctx, instr_flags)
}

pub fn instr16_0F_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    gen::jit0f::jit(ctx.cpu.read_imm8() as u32, ctx, instr_flags)
}
pub fn instr32_0F_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    gen::jit0f::jit(ctx.cpu.read_imm8() as u32 | 0x100, ctx, instr_flags)
}
pub fn instr_26_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    jit_handle_segment_prefix(ES, ctx, instr_flags)
}
pub fn instr_2E_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    jit_handle_segment_prefix(CS, ctx, instr_flags)
}
pub fn instr_36_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    jit_handle_segment_prefix(SS, ctx, instr_flags)
}
pub fn instr_3E_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    jit_handle_segment_prefix(DS, ctx, instr_flags)
}

pub fn instr_64_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    jit_handle_segment_prefix(FS, ctx, instr_flags)
}
pub fn instr_65_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    jit_handle_segment_prefix(GS, ctx, instr_flags)
}

pub fn instr_66_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    ctx.cpu.prefixes |= PREFIX_66;
    jit_handle_prefix(ctx, instr_flags)
}
pub fn instr_67_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    ctx.cpu.prefixes |= PREFIX_67;
    jit_handle_prefix(ctx, instr_flags)
}
pub fn instr_F0_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    // lock: Ignore
    jit_handle_prefix(ctx, instr_flags)
}
pub fn instr_F2_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    ctx.cpu.prefixes |= PREFIX_F2;
    jit_handle_prefix(ctx, instr_flags)
}
pub fn instr_F3_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    ctx.cpu.prefixes |= PREFIX_F3;
    jit_handle_prefix(ctx, instr_flags)
}

fn sse_read_f32_xmm_mem(ctx: &mut JitContext, name: &str, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    ctx.builder.reinterpret_i32_as_f32();
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn2_f32_i32(name);
}
fn sse_read_f32_xmm_xmm(ctx: &mut JitContext, name: &str, r1: u32, r2: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r1) as i32);
    ctx.builder.load_aligned_f32(0);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.call_fn2_f32_i32(name);
}

fn sse_read64_xmm_mem(ctx: &mut JitContext, name: &str, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read64(ctx, modrm_byte);
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn2_i64_i32(name);
}
fn sse_read64_xmm_xmm(ctx: &mut JitContext, name: &str, r1: u32, r2: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r1) as i32);
    ctx.builder.load_aligned_i64(0);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.call_fn2_i64_i32(name);
}

fn sse_read128_xmm_mem(ctx: &mut JitContext, name: &str, modrm_byte: ModrmByte, r: u32) {
    let dest = global_pointers::sse_scratch_register as u32;
    codegen::gen_modrm_resolve_safe_read128(ctx, modrm_byte, dest);
    ctx.builder.const_i32(dest as i32);
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn2(name);
}
fn sse_read128_xmm_mem_imm(
    ctx: &mut JitContext,
    name: &str,
    modrm_byte: ModrmByte,
    r: u32,
    imm: u32,
) {
    let dest = global_pointers::sse_scratch_register as u32;
    codegen::gen_modrm_resolve_safe_read128(ctx, modrm_byte, dest);
    ctx.builder.const_i32(dest as i32);
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm as i32);
    ctx.builder.call_fn3(name);
}
fn sse_read128_xmm_xmm(ctx: &mut JitContext, name: &str, r1: u32, r2: u32) {
    // Make a copy to avoid aliasing problems: Called function expects a reg128, which must not
    // alias with memory
    codegen::gen_read_reg_xmm128_into_scratch(ctx, r1);
    let dest = global_pointers::sse_scratch_register;
    ctx.builder.const_i32(dest as i32);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.call_fn2(name);
}
fn sse_read128_xmm_xmm_imm(ctx: &mut JitContext, name: &str, r1: u32, r2: u32, imm: u32) {
    // Make a copy to avoid aliasing problems: Called function expects a reg128, which must not
    // alias with memory
    codegen::gen_read_reg_xmm128_into_scratch(ctx, r1);
    let dest = global_pointers::sse_scratch_register;
    ctx.builder.const_i32(dest as i32);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.const_i32(imm as i32);
    ctx.builder.call_fn3(name);
}
fn sse_mov_xmm_xmm(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r2) as i32);
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r1) as i32);
    ctx.builder.load_aligned_i64(0);
    ctx.builder.store_aligned_i64(0);

    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r2) as i32 + 8);
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r1) as i32 + 8);
    ctx.builder.load_aligned_i64(0);
    ctx.builder.store_aligned_i64(0);
}

fn mmx_read64_mm_mem32(ctx: &mut JitContext, name: &str, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn2(name)
}
fn mmx_read64_mm_mm32(ctx: &mut JitContext, name: &str, r1: u32, r2: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_mmx_offset(r1) as i32);
    ctx.builder.load_aligned_i32(0);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.call_fn2(name);
}
fn mmx_read64_mm_mem(ctx: &mut JitContext, name: &str, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read64(ctx, modrm_byte);
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn2_i64_i32(name)
}
fn mmx_read64_mm_mm(ctx: &mut JitContext, name: &str, r1: u32, r2: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_mmx_offset(r1) as i32);
    ctx.builder.load_aligned_i64(0);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.call_fn2_i64_i32(name);
}

fn push16_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg16(ctx, r);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &value_local);
    ctx.builder.free_local(value_local);
}
fn push32_reg_jit(ctx: &mut JitContext, r: u32) {
    let reg = ctx.reg(r);
    codegen::gen_push32(ctx, &reg);
}
fn push16_imm_jit(ctx: &mut JitContext, imm: u32) {
    ctx.builder.const_i32(imm as i32);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &value_local);
    ctx.builder.free_local(value_local);
}
fn push32_imm_jit(ctx: &mut JitContext, imm: u32) {
    ctx.builder.const_i32(imm as i32);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push32(ctx, &value_local);
    ctx.builder.free_local(value_local);
}
fn push16_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &value_local);
    ctx.builder.free_local(value_local);
}
fn push32_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push32(ctx, &value_local);
    ctx.builder.free_local(value_local);
}

fn pop16_reg_jit(ctx: &mut JitContext, reg: u32) {
    codegen::gen_pop16(ctx);
    codegen::gen_set_reg16_unmasked(ctx, reg);
}

fn pop32_reg_jit(ctx: &mut JitContext, reg: u32) {
    codegen::gen_pop32s(ctx);
    codegen::gen_set_reg32(ctx, reg);
}

fn group_arith_al_imm8(
    ctx: &mut JitContext,
    op: &dyn Fn(&mut JitContext, &WasmLocal, &LocalOrImmediate),
    imm8: u32,
) {
    op(
        ctx,
        &ctx.reg(regs::EAX),
        &LocalOrImmediate::Immediate(imm8 as i32),
    );
    codegen::gen_set_reg8_unmasked(ctx, regs::EAX);
}

fn group_arith_ax_imm16(ctx: &mut JitContext, op: &str, imm16: u32) {
    codegen::gen_get_reg16(ctx, regs::AX);
    ctx.builder.const_i32(imm16 as i32);
    ctx.builder.call_fn2_ret(op);
    codegen::gen_set_reg16(ctx, regs::AX);
}

fn group_arith_eax_imm32(
    ctx: &mut JitContext,
    op: &dyn Fn(&mut JitContext, &WasmLocal, &LocalOrImmediate),
    imm32: u32,
) {
    op(
        ctx,
        &ctx.reg(regs::EAX),
        &LocalOrImmediate::Immediate(imm32 as i32),
    );
}

macro_rules! define_instruction_read8(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
            codegen::gen_modrm_resolve_safe_read8(ctx, modrm_byte);
            let dest_operand = ctx.builder.set_new_local();
            let source_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r);
            $fn(ctx, &dest_operand, &LocalOrImmediate::WasmLocal(&source_operand));
            ctx.builder.free_local(dest_operand);
            codegen::gen_free_reg8_or_alias(ctx, r, source_operand);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            let dest_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r1);
            let source_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r2);
            $fn(ctx, &dest_operand, &LocalOrImmediate::WasmLocal(&source_operand));
            codegen::gen_free_reg8_or_alias(ctx, r1, dest_operand);
            codegen::gen_free_reg8_or_alias(ctx, r2, source_operand);
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, imm: u32) {
            codegen::gen_modrm_resolve_safe_read8(ctx, modrm_byte);
            let dest_operand = ctx.builder.set_new_local();
            let imm = mask_imm!(imm, $imm);
            $fn(ctx, &dest_operand, &LocalOrImmediate::Immediate(imm as i32));
            ctx.builder.free_local(dest_operand);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, imm: u32) {
            let imm = mask_imm!(imm, $imm);
            let dest_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r1);
            $fn(ctx, &dest_operand, &LocalOrImmediate::Immediate(imm as i32));
            codegen::gen_free_reg8_or_alias(ctx, r1, dest_operand);
        }
    );
);

macro_rules! define_instruction_read16(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
            codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
            let dest_operand = ctx.builder.set_new_local();
            $fn(
                ctx,
                &dest_operand,
                &LocalOrImmediate::WasmLocal(&ctx.reg(r)),
            );
            ctx.builder.free_local(dest_operand);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            $fn(
                ctx,
                &ctx.reg(r1),
                &LocalOrImmediate::WasmLocal(&ctx.reg(r2))
            );
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, imm: u32) {
            codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
            let dest_operand = ctx.builder.set_new_local();
            let imm = mask_imm!(imm, $imm);
            $fn(
                ctx,
                &dest_operand,
                &LocalOrImmediate::Immediate(imm as i32),
            );
            ctx.builder.free_local(dest_operand);
        }

        pub fn $name_reg(ctx: &mut JitContext, r: u32, imm: u32) {
            let imm = mask_imm!(imm, $imm);
            $fn(
                ctx,
                &ctx.reg(r),
                &LocalOrImmediate::Immediate(imm as i32),
            );
        }
    );
);

macro_rules! define_instruction_read32(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
            codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
            let dest_operand = ctx.builder.set_new_local();
            $fn(
                ctx,
                &dest_operand,
                &LocalOrImmediate::WasmLocal(&ctx.reg(r)),
            );
            ctx.builder.free_local(dest_operand);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            $fn(
                ctx,
                &ctx.reg(r1),
                &LocalOrImmediate::WasmLocal(&ctx.reg(r2))
            );
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, imm: u32) {
            codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
            let dest_operand = ctx.builder.set_new_local();
            let imm = mask_imm!(imm, $imm);
            $fn(
                ctx,
                &dest_operand,
                &LocalOrImmediate::Immediate(imm as i32),
            );
            ctx.builder.free_local(dest_operand);
        }

        pub fn $name_reg(ctx: &mut JitContext, r: u32, imm: u32) {
            let imm = mask_imm!(imm, $imm);
            $fn(
                ctx,
                &ctx.reg(r),
                &LocalOrImmediate::Immediate(imm as i32),
            );
        }
    );
);

macro_rules! define_instruction_write_reg8(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
            codegen::gen_modrm_resolve_safe_read8(ctx, modrm_byte);
            let source_operand = ctx.builder.set_new_local();
            let dest_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r);
            $fn(ctx, &dest_operand, &LocalOrImmediate::WasmLocal(&source_operand));
            codegen::gen_set_reg8_unmasked(ctx, r);
            ctx.builder.free_local(source_operand);
            codegen::gen_free_reg8_or_alias(ctx, r, dest_operand);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            let source_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r1);
            let dest_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r2);
            $fn(ctx, &dest_operand, &LocalOrImmediate::WasmLocal(&source_operand));
            codegen::gen_set_reg8_unmasked(ctx, r2);
            codegen::gen_free_reg8_or_alias(ctx, r1, source_operand);
            codegen::gen_free_reg8_or_alias(ctx, r2, dest_operand);
        }
    )
);

macro_rules! define_instruction_write_reg16(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
            codegen::gen_get_reg16(ctx, r);
            codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
            ctx.builder.call_fn2_ret($fn);
            codegen::gen_set_reg16(ctx, r);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_get_reg16(ctx, r2);
            codegen::gen_get_reg16(ctx, r1);
            ctx.builder.call_fn2_ret($fn);
            codegen::gen_set_reg16(ctx, r2);
        }
    )
);

macro_rules! define_instruction_write_reg32(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
            codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
            let source_operand = ctx.builder.set_new_local();
            $fn(
                ctx,
                &ctx.reg(r),
                &LocalOrImmediate::WasmLocal(&source_operand),
            );
            ctx.builder.free_local(source_operand);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            $fn(
                ctx,
                &ctx.reg(r2),
                &LocalOrImmediate::WasmLocal(&ctx.reg(r1)),
            );
        }
    );
);

macro_rules! mask_imm(
    ($imm:expr, imm8_5bits) => { $imm & 31 };
    ($imm:expr, imm8) => { $imm };
    ($imm:expr, imm8s) => { $imm };
    ($imm:expr, imm8s_16bits) => { $imm & 0xFFFF };
    ($imm:expr, imm16) => { $imm };
    ($imm:expr, imm32) => { $imm };
);

macro_rules! define_instruction_read_write_mem8(
    ($fn:expr, $name_mem:ident, $name_reg:ident, reg) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::BYTE, &addr, &|ref mut ctx| {
                    let dest_operand = ctx.builder.set_new_local();
                    let source_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r);
                    $fn(ctx, &dest_operand, &LocalOrImmediate::WasmLocal(&source_operand));
                    codegen::gen_free_reg8_or_alias(ctx, r, source_operand);
                    ctx.builder.free_local(dest_operand);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            let source_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r2);
            let dest_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r1);
            $fn(ctx, &dest_operand, &LocalOrImmediate::WasmLocal(&source_operand));
            codegen::gen_set_reg8_unmasked(ctx, r1);
            codegen::gen_free_reg8_or_alias(ctx, r2, source_operand);
            codegen::gen_free_reg8_or_alias(ctx, r1, dest_operand);
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, constant_one) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::BYTE, &addr, &|ref mut ctx| {
                    ctx.builder.const_i32(1);
                    ctx.builder.call_fn2_ret($fn);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            codegen::gen_get_reg8(ctx, r1);
            ctx.builder.const_i32(1);
            ctx.builder.call_fn2_ret($fn);
            codegen::gen_set_reg8(ctx, r1);
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, cl) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::BYTE, &addr, &|ref mut ctx| {
                    codegen::gen_get_reg8(ctx, regs::CL);
                    ctx.builder.const_i32(31);
                    ctx.builder.and_i32();
                    ctx.builder.call_fn2_ret($fn);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            codegen::gen_get_reg8(ctx, r1);
            codegen::gen_get_reg8(ctx, regs::CL);
            ctx.builder.const_i32(31);
            ctx.builder.and_i32();
            ctx.builder.call_fn2_ret($fn);
            codegen::gen_set_reg8(ctx, r1);
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, none) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::BYTE, &addr, &|ref mut ctx| {
                    ctx.builder.call_fn1_ret($fn);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            codegen::gen_get_reg8(ctx, r1);
            ctx.builder.call_fn1_ret($fn);
            codegen::gen_set_reg8(ctx, r1);
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, ximm8) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, imm: u32) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::BYTE, &addr, &|ref mut ctx| {
                    let dest_operand = ctx.builder.set_new_local();
                    $fn(ctx, &dest_operand, &LocalOrImmediate::Immediate(imm as i32));
                    ctx.builder.free_local(dest_operand);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, imm: u32) {
            let dest_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r1);
            $fn(ctx, &dest_operand, &LocalOrImmediate::Immediate(imm as i32));
            codegen::gen_set_reg8_unmasked(ctx, r1);
            codegen::gen_free_reg8_or_alias(ctx, r1, dest_operand);
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, imm: u32) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                let imm = mask_imm!(imm, $imm) as i32;
                codegen::gen_safe_read_write(ctx, BitSize::BYTE, &addr, &|ref mut ctx| {
                    ctx.builder.const_i32(imm as i32);
                    ctx.builder.call_fn2_ret($fn);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, imm: u32) {
            let imm = mask_imm!(imm, $imm);
            codegen::gen_get_reg8(ctx, r1);
            ctx.builder.const_i32(imm as i32);
            ctx.builder.call_fn2_ret($fn);
            codegen::gen_set_reg8(ctx, r1);
        }
    );
);

macro_rules! define_instruction_read_write_mem16(
    ($fn:expr, $name_mem:ident, $name_reg:ident, reg) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::WORD, &addr, &|ref mut ctx| {
                    codegen::gen_get_reg16(ctx, r);
                    ctx.builder.call_fn2_ret($fn);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_get_reg16(ctx, r1);
            codegen::gen_get_reg16(ctx, r2);
            ctx.builder.call_fn2_ret($fn);
            codegen::gen_set_reg16(ctx, r1);
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, constant_one) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::WORD, &addr, &|ref mut ctx| {
                    ctx.builder.const_i32(1);
                    ctx.builder.call_fn2_ret($fn);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            codegen::gen_get_reg16(ctx, r1);
            ctx.builder.const_i32(1);
            ctx.builder.call_fn2_ret($fn);
            codegen::gen_set_reg16(ctx, r1);
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, cl) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::WORD, &addr, &|ref mut ctx| {
                    codegen::gen_get_reg8(ctx, regs::CL);
                    ctx.builder.const_i32(31);
                    ctx.builder.and_i32();
                    ctx.builder.call_fn2_ret($fn);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            codegen::gen_get_reg16(ctx, r1);
            codegen::gen_get_reg8(ctx, regs::CL);
                ctx.builder.const_i32(31);
                ctx.builder.and_i32();
            ctx.builder.call_fn2_ret($fn);
            codegen::gen_set_reg16(ctx, r1);
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, reg, cl) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::WORD, &addr, &|ref mut ctx| {
                    codegen::gen_get_reg16(ctx, r);
                    codegen::gen_get_reg8(ctx, regs::CL);
                    ctx.builder.const_i32(31);
                    ctx.builder.and_i32();
                    ctx.builder.call_fn3_ret($fn);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_get_reg16(ctx, r1);
            codegen::gen_get_reg16(ctx, r2);
            codegen::gen_get_reg8(ctx, regs::CL);
            ctx.builder.const_i32(31);
            ctx.builder.and_i32();
            ctx.builder.call_fn3_ret($fn);
            codegen::gen_set_reg16(ctx, r1);
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, reg, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm: u32) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                let imm = mask_imm!(imm, $imm);
                codegen::gen_safe_read_write(ctx, BitSize::WORD, &addr, &|ref mut ctx| {
                    codegen::gen_get_reg16(ctx, r);
                    ctx.builder.const_i32(imm as i32);
                    ctx.builder.call_fn3_ret($fn);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32, imm: u32) {
            let imm = mask_imm!(imm, $imm);
            codegen::gen_get_reg16(ctx, r1);
            codegen::gen_get_reg16(ctx, r2);
            ctx.builder.const_i32(imm as i32);
            ctx.builder.call_fn3_ret($fn);
            codegen::gen_set_reg16(ctx, r1);
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, none) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::WORD, &addr, &|ref mut ctx| {
                    let mut dest_operand = ctx.builder.set_new_local();
                    $fn(ctx, &mut dest_operand);
                    ctx.builder.get_local(&dest_operand);
                    ctx.builder.free_local(dest_operand);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            $fn(ctx, &mut ctx.reg(r1));
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, imm: u32) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                let imm = mask_imm!(imm, $imm) as i32;
                codegen::gen_safe_read_write(ctx, BitSize::WORD, &addr, &|ref mut ctx| {
                    ctx.builder.const_i32(imm as i32);
                    ctx.builder.call_fn2_ret($fn);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, imm: u32) {
            let imm = mask_imm!(imm, $imm);
            codegen::gen_get_reg16(ctx, r1);
            ctx.builder.const_i32(imm as i32);
            ctx.builder.call_fn2_ret($fn);
            codegen::gen_set_reg16(ctx, r1);
        }
    );
);

macro_rules! define_instruction_read_write_mem32(
    ($fn:expr, $name_mem:ident, $name_reg:ident, reg) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::DWORD, &addr, &|ref mut ctx| {
                    let dest_operand = ctx.builder.set_new_local();
                    $fn(
                        ctx,
                        &dest_operand,
                        &LocalOrImmediate::WasmLocal(&ctx.reg(r)),
                    );
                    ctx.builder.get_local(&dest_operand);
                    ctx.builder.free_local(dest_operand);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            $fn(
                ctx,
                &ctx.reg(r1),
                &LocalOrImmediate::WasmLocal(&ctx.reg(r2)),
            );
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, constant_one) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::DWORD, &addr, &|ref mut ctx| {
                    let dest_operand = ctx.builder.set_new_local();
                    $fn(ctx, &dest_operand, &LocalOrImmediate::Immediate(1));
                    ctx.builder.get_local(&dest_operand);
                    ctx.builder.free_local(dest_operand);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            $fn(ctx, &ctx.reg(r1), &LocalOrImmediate::Immediate(1));
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, cl) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::DWORD, &addr, &|ref mut ctx| {
                    let dest_operand = ctx.builder.set_new_local();
                    $fn(
                        ctx,
                        &dest_operand,
                        &LocalOrImmediate::WasmLocal(&ctx.reg(regs::ECX)),
                    );
                    ctx.builder.get_local(&dest_operand);
                    ctx.builder.free_local(dest_operand);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            $fn(
                ctx,
                &ctx.reg(r1),
                &LocalOrImmediate::WasmLocal(&ctx.reg(regs::ECX)),
            );
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, reg, cl) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::DWORD, &addr, &|ref mut ctx| {
                    codegen::gen_get_reg32(ctx, r);
                    codegen::gen_get_reg8(ctx, regs::CL);
                    ctx.builder.const_i32(31);
                    ctx.builder.and_i32();
                    ctx.builder.call_fn3_ret($fn);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_get_reg32(ctx, r1);
            codegen::gen_get_reg32(ctx, r2);
            codegen::gen_get_reg8(ctx, regs::CL);
            ctx.builder.const_i32(31);
            ctx.builder.and_i32();
            ctx.builder.call_fn3_ret($fn);
            codegen::gen_set_reg32(ctx, r1);
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, reg, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm: u32) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                let imm = mask_imm!(imm, $imm) as i32;
                codegen::gen_safe_read_write(ctx, BitSize::DWORD, &addr, &|ref mut ctx| {
                    codegen::gen_get_reg32(ctx, r);
                    ctx.builder.const_i32(imm as i32);
                    ctx.builder.call_fn3_ret($fn);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32, imm: u32) {
            let imm = mask_imm!(imm, $imm);
            codegen::gen_get_reg32(ctx, r1);
            codegen::gen_get_reg32(ctx, r2);
            ctx.builder.const_i32(imm as i32);
            ctx.builder.call_fn3_ret($fn);
            codegen::gen_set_reg32(ctx, r1);
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, none) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_safe_read_write(ctx, BitSize::DWORD, &addr, &|ref mut ctx| {
                    let mut dest_operand = ctx.builder.set_new_local();
                    $fn(ctx, &mut dest_operand);
                    ctx.builder.get_local(&dest_operand);
                    ctx.builder.free_local(dest_operand);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            $fn(ctx, &mut ctx.reg(r1));
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, imm: u32) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                let imm = mask_imm!(imm, $imm);
                codegen::gen_safe_read_write(ctx, BitSize::DWORD, &addr, &|ref mut ctx| {
                    let dest_operand = ctx.builder.set_new_local();
                    $fn(
                        ctx,
                        &dest_operand,
                        &LocalOrImmediate::Immediate(imm as i32),
                    );
                    ctx.builder.get_local(&dest_operand);
                    ctx.builder.free_local(dest_operand);
                });
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, imm: u32) {
            let imm = mask_imm!(imm, $imm);
            $fn(
                ctx,
                &ctx.reg(r1),
                &LocalOrImmediate::Immediate(imm as i32),
            );
        }
    );
);

fn gen_add8(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.current_instruction = Instruction::Add {
        opsize: OPSIZE_8,
        dest: local_to_instruction_operand(ctx, dest_operand),
        source: if source_operand.eq_local(dest_operand) {
            InstructionOperand::Other // aliasing
        }
        else {
            source_operand.to_instruction_operand(ctx)
        },
        is_inc: false,
    };

    ctx.builder.const_i32(global_pointers::last_op1 as i32);
    ctx.builder.get_local(dest_operand);
    ctx.builder.const_i32(0xFF);
    ctx.builder.and_i32();
    ctx.builder.store_aligned_i32(0);

    ctx.builder.const_i32(global_pointers::last_result as i32);
    ctx.builder.get_local(dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.add_i32();
    ctx.builder.const_i32(0xFF);
    ctx.builder.and_i32();
    ctx.builder.store_aligned_i32(0);

    codegen::gen_set_last_op_size_and_flags_changed(ctx.builder, OPSIZE_8, FLAGS_ALL);

    ctx.builder
        .load_fixed_u8(global_pointers::last_result as u32);
}
fn gen_add32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.current_instruction = Instruction::Add {
        opsize: OPSIZE_32,
        dest: local_to_instruction_operand(ctx, dest_operand),
        source: if source_operand.eq_local(dest_operand) {
            InstructionOperand::Other // aliasing
        }
        else {
            source_operand.to_instruction_operand(ctx)
        },
        is_inc: false,
    };

    codegen::gen_set_last_op1(ctx.builder, &dest_operand);

    ctx.builder.get_local(&dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.add_i32();
    ctx.builder.set_local(dest_operand);

    codegen::gen_set_last_result(ctx.builder, &dest_operand);
    codegen::gen_set_last_op_size_and_flags_changed(ctx.builder, OPSIZE_32, FLAGS_ALL);
}

fn gen_sub8(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.current_instruction = Instruction::Sub {
        opsize: OPSIZE_8,
        dest: local_to_instruction_operand(ctx, dest_operand),
        source: if source_operand.eq_local(dest_operand) {
            InstructionOperand::Other // aliasing
        }
        else {
            source_operand.to_instruction_operand(ctx)
        },
        is_dec: false,
    };

    ctx.builder.const_i32(global_pointers::last_op1 as i32);
    ctx.builder.get_local(dest_operand);
    ctx.builder.const_i32(0xFF);
    ctx.builder.and_i32();
    ctx.builder.store_aligned_i32(0);

    ctx.builder.const_i32(global_pointers::last_result as i32);
    ctx.builder.get_local(dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.sub_i32();
    ctx.builder.const_i32(0xFF);
    ctx.builder.and_i32();
    ctx.builder.store_aligned_i32(0);

    codegen::gen_set_last_op_size_and_flags_changed(ctx.builder, OPSIZE_8, FLAGS_ALL | FLAG_SUB);

    ctx.builder
        .load_fixed_u8(global_pointers::last_result as u32);
}
fn gen_sub32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.current_instruction = Instruction::Sub {
        opsize: OPSIZE_32,
        dest: local_to_instruction_operand(ctx, dest_operand),
        source: if source_operand.eq_local(dest_operand) {
            InstructionOperand::Other // aliasing
        }
        else {
            source_operand.to_instruction_operand(ctx)
        },
        is_dec: false,
    };

    codegen::gen_set_last_op1(ctx.builder, &dest_operand);

    ctx.builder.get_local(&dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.sub_i32();
    ctx.builder.set_local(dest_operand);

    codegen::gen_set_last_result(ctx.builder, &dest_operand);
    codegen::gen_set_last_op_size_and_flags_changed(ctx.builder, OPSIZE_32, FLAGS_ALL | FLAG_SUB);
}

fn gen_cmp(
    ctx: &mut JitContext,
    dest_operand: &WasmLocal,
    source_operand: &LocalOrImmediate,
    size: i32,
) {
    ctx.current_instruction = Instruction::Cmp {
        dest: local_to_instruction_operand(ctx, dest_operand),
        source: source_operand.to_instruction_operand(ctx),
        opsize: size,
    };

    ctx.builder.const_i32(global_pointers::last_result as i32);
    if source_operand.is_zero() {
        ctx.builder.get_local(&dest_operand);
    }
    else {
        ctx.builder.get_local(&dest_operand);
        source_operand.gen_get(ctx.builder);
        ctx.builder.sub_i32();
    }
    if size == OPSIZE_8 || size == OPSIZE_16 {
        ctx.builder
            .const_i32(if size == OPSIZE_8 { 0xFF } else { 0xFFFF });
        ctx.builder.and_i32();
    }
    ctx.builder.store_aligned_i32(0);

    ctx.builder.const_i32(global_pointers::last_op1 as i32);
    ctx.builder.get_local(&dest_operand);
    if size == OPSIZE_8 || size == OPSIZE_16 {
        ctx.builder
            .const_i32(if size == OPSIZE_8 { 0xFF } else { 0xFFFF });
        ctx.builder.and_i32();
    }
    ctx.builder.store_aligned_i32(0);
    codegen::gen_set_last_op_size_and_flags_changed(ctx.builder, size, FLAGS_ALL | FLAG_SUB);
}
fn gen_cmp8(ctx: &mut JitContext, dest: &WasmLocal, source: &LocalOrImmediate) {
    gen_cmp(ctx, dest, source, OPSIZE_8)
}
fn gen_cmp16(ctx: &mut JitContext, dest: &WasmLocal, source: &LocalOrImmediate) {
    gen_cmp(ctx, dest, source, OPSIZE_16)
}
fn gen_cmp32(ctx: &mut JitContext, dest: &WasmLocal, source: &LocalOrImmediate) {
    gen_cmp(ctx, dest, source, OPSIZE_32)
}

fn gen_adc8(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.builder.get_local(dest_operand);
    ctx.builder.const_i32(0xFF);
    ctx.builder.and_i32();
    source_operand.gen_get_mask255(ctx.builder);
    ctx.builder.call_fn2_ret("adc8");
    ctx.builder.const_i32(0xFF);
    ctx.builder.and_i32();

    ctx.current_instruction = Instruction::AdcSbb {
        opsize: OPSIZE_8,
        dest: local_to_instruction_operand(ctx, dest_operand),
        source: if source_operand.eq_local(dest_operand) {
            InstructionOperand::Other // aliasing
        }
        else {
            source_operand.to_instruction_operand(ctx)
        },
    };
}
fn gen_adc32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.builder.get_local(&dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.add_i32();
    codegen::gen_getcf(ctx, ConditionNegate::False);
    ctx.builder.add_i32();
    let res = ctx.builder.set_new_local();

    codegen::gen_set_last_result(ctx.builder, &res);
    codegen::gen_set_last_op_size_and_flags_changed(
        ctx.builder,
        OPSIZE_32,
        FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW & !FLAG_ADJUST,
    );

    ctx.builder.const_i32(global_pointers::flags as i32);
    codegen::gen_get_flags(ctx.builder);
    ctx.builder
        .const_i32(!FLAG_CARRY & !FLAG_ADJUST & !FLAG_OVERFLOW);
    ctx.builder.and_i32();

    // cf: (dest_operand ^ ((dest_operand ^ source_operand) & (source_operand ^ res))) >> op_size & FLAG_CARRY
    ctx.builder.get_local(&dest_operand);
    ctx.builder.get_local(&dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.xor_i32();
    source_operand.gen_get(ctx.builder);
    ctx.builder.get_local(&res);
    ctx.builder.xor_i32();
    ctx.builder.and_i32();
    ctx.builder.xor_i32();
    ctx.builder.const_i32(31);
    ctx.builder.shr_u_i32();
    ctx.builder.const_i32(FLAG_CARRY);
    ctx.builder.and_i32();
    ctx.builder.or_i32();

    // af: (dest_operand ^ source_operand ^ res) & FLAG_ADJUST
    ctx.builder.get_local(&dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.get_local(&res);
    ctx.builder.xor_i32();
    ctx.builder.xor_i32();
    ctx.builder.const_i32(FLAG_ADJUST);
    ctx.builder.and_i32();
    ctx.builder.or_i32();

    // of: ((source_operand ^ res) & (dest_operand ^ res)) >> op_size << 11 & FLAG_OVERFLOW
    source_operand.gen_get(ctx.builder);
    ctx.builder.get_local(&res);
    ctx.builder.xor_i32();
    ctx.builder.get_local(&dest_operand);
    ctx.builder.get_local(&res);
    ctx.builder.xor_i32();
    ctx.builder.and_i32();
    ctx.builder.const_i32(31 - 11);
    ctx.builder.shr_u_i32();
    ctx.builder.const_i32(FLAG_OVERFLOW);
    ctx.builder.and_i32();
    ctx.builder.or_i32();

    ctx.builder.store_aligned_i32(0);

    ctx.builder.get_local(&res);
    ctx.builder.set_local(dest_operand);
    ctx.builder.free_local(res);

    ctx.current_instruction = Instruction::AdcSbb {
        opsize: OPSIZE_32,
        dest: local_to_instruction_operand(ctx, dest_operand),
        source: if source_operand.eq_local(dest_operand) {
            InstructionOperand::Other // aliasing
        }
        else {
            source_operand.to_instruction_operand(ctx)
        },
    };
}

fn gen_sbb8(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.builder.get_local(dest_operand);
    ctx.builder.const_i32(0xFF);
    ctx.builder.and_i32();
    source_operand.gen_get_mask255(ctx.builder);
    ctx.builder.call_fn2_ret("sbb8");
    ctx.builder.const_i32(0xFF);
    ctx.builder.and_i32();

    ctx.current_instruction = Instruction::AdcSbb {
        opsize: OPSIZE_8,
        dest: local_to_instruction_operand(ctx, dest_operand),
        source: if source_operand.eq_local(dest_operand) {
            InstructionOperand::Other // aliasing
        }
        else {
            source_operand.to_instruction_operand(ctx)
        },
    };
}
fn gen_sbb32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.builder.get_local(&dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.sub_i32();
    codegen::gen_getcf(ctx, ConditionNegate::False);
    ctx.builder.sub_i32();
    let res = ctx.builder.set_new_local();

    codegen::gen_set_last_result(ctx.builder, &res);
    codegen::gen_set_last_op_size_and_flags_changed(
        ctx.builder,
        OPSIZE_32,
        FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW & !FLAG_ADJUST,
    );

    ctx.builder.const_i32(global_pointers::flags as i32);
    codegen::gen_get_flags(ctx.builder);
    ctx.builder
        .const_i32(!FLAG_CARRY & !FLAG_ADJUST & !FLAG_OVERFLOW);
    ctx.builder.and_i32();

    // cf: (res ^ ((res ^ source_operand) & (source_operand ^ dest_operand))) >> op_size & FLAG_CARRY
    ctx.builder.get_local(&res);
    ctx.builder.get_local(&res);
    source_operand.gen_get(ctx.builder);
    ctx.builder.xor_i32();
    source_operand.gen_get(ctx.builder);
    ctx.builder.get_local(&dest_operand);
    ctx.builder.xor_i32();
    ctx.builder.and_i32();
    ctx.builder.xor_i32();
    ctx.builder.const_i32(31);
    ctx.builder.shr_u_i32();
    ctx.builder.const_i32(FLAG_CARRY);
    ctx.builder.and_i32();
    ctx.builder.or_i32();

    // af: (dest_operand ^ source_operand ^ res) & FLAG_ADJUST
    ctx.builder.get_local(&dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.get_local(&res);
    ctx.builder.xor_i32();
    ctx.builder.xor_i32();
    ctx.builder.const_i32(FLAG_ADJUST);
    ctx.builder.and_i32();
    ctx.builder.or_i32();

    // of: ((source_operand ^ dest_operand) & (res ^ dest_operand)) >> op_size << 11 & FLAG_OVERFLOW
    source_operand.gen_get(ctx.builder);
    ctx.builder.get_local(&dest_operand);
    ctx.builder.xor_i32();
    ctx.builder.get_local(&res);
    ctx.builder.get_local(&dest_operand);
    ctx.builder.xor_i32();
    ctx.builder.and_i32();
    ctx.builder.const_i32(31 - 11);
    ctx.builder.shr_u_i32();
    ctx.builder.const_i32(FLAG_OVERFLOW);
    ctx.builder.and_i32();
    ctx.builder.or_i32();

    ctx.builder.store_aligned_i32(0);

    ctx.builder.get_local(&res);
    ctx.builder.set_local(dest_operand);
    ctx.builder.free_local(res);

    ctx.current_instruction = Instruction::AdcSbb {
        opsize: OPSIZE_32,
        dest: local_to_instruction_operand(ctx, dest_operand),
        source: if source_operand.eq_local(dest_operand) {
            InstructionOperand::Other // aliasing
        }
        else {
            source_operand.to_instruction_operand(ctx)
        },
    };
}

fn gen_and8(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.current_instruction = Instruction::Bitwise {
        opsize: OPSIZE_8,
        dest: local_to_instruction_operand(ctx, dest_operand),
    };

    ctx.builder.const_i32(global_pointers::last_result as i32);
    ctx.builder.get_local(dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.and_i32();
    ctx.builder.store_aligned_i32(0);

    codegen::gen_set_last_op_size_and_flags_changed(
        ctx.builder,
        OPSIZE_8,
        FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW & !FLAG_ADJUST,
    );
    codegen::gen_clear_flags_bits(ctx.builder, FLAG_CARRY | FLAG_OVERFLOW | FLAG_ADJUST);

    ctx.builder
        .load_fixed_u8(global_pointers::last_result as u32);
}
fn gen_and32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.current_instruction = Instruction::Bitwise {
        opsize: OPSIZE_32,
        dest: local_to_instruction_operand(ctx, dest_operand),
    };

    ctx.builder.get_local(&dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.and_i32();
    ctx.builder.set_local(dest_operand);

    codegen::gen_set_last_result(ctx.builder, &dest_operand);
    codegen::gen_set_last_op_size_and_flags_changed(
        ctx.builder,
        OPSIZE_32,
        FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW & !FLAG_ADJUST,
    );
    codegen::gen_clear_flags_bits(ctx.builder, FLAG_CARRY | FLAG_OVERFLOW | FLAG_ADJUST);
}

fn gen_test(
    ctx: &mut JitContext,
    dest_operand: &WasmLocal,
    source_operand: &LocalOrImmediate,
    size: i32,
) {
    let is_self_test = source_operand.eq_local(dest_operand);
    ctx.current_instruction = Instruction::Bitwise {
        opsize: size,
        dest: if is_self_test {
            local_to_instruction_operand(ctx, dest_operand)
        }
        else {
            InstructionOperandDest::Other
        },
    };

    ctx.builder.const_i32(global_pointers::last_result as i32);
    if is_self_test {
        ctx.builder.get_local(&dest_operand);
    }
    else {
        ctx.builder.get_local(&dest_operand);
        source_operand.gen_get(ctx.builder);
        ctx.builder.and_i32();
    }
    ctx.builder.store_aligned_i32(0);

    codegen::gen_set_last_op_size_and_flags_changed(
        ctx.builder,
        size,
        FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW & !FLAG_ADJUST,
    );
    codegen::gen_clear_flags_bits(ctx.builder, FLAG_CARRY | FLAG_OVERFLOW | FLAG_ADJUST);
}
fn gen_test8(ctx: &mut JitContext, dest: &WasmLocal, source: &LocalOrImmediate) {
    gen_test(ctx, dest, source, OPSIZE_8)
}
fn gen_test16(ctx: &mut JitContext, dest: &WasmLocal, source: &LocalOrImmediate) {
    gen_test(ctx, dest, source, OPSIZE_16)
}
fn gen_test32(ctx: &mut JitContext, dest: &WasmLocal, source: &LocalOrImmediate) {
    gen_test(ctx, dest, source, OPSIZE_32)
}

fn gen_or8(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.current_instruction = Instruction::Bitwise {
        opsize: OPSIZE_8,
        dest: local_to_instruction_operand(ctx, dest_operand),
    };

    ctx.builder.const_i32(global_pointers::last_result as i32);
    ctx.builder.get_local(dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.or_i32();
    ctx.builder.store_aligned_i32(0);

    codegen::gen_set_last_op_size_and_flags_changed(
        ctx.builder,
        OPSIZE_8,
        FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW & !FLAG_ADJUST,
    );
    codegen::gen_clear_flags_bits(ctx.builder, FLAG_CARRY | FLAG_OVERFLOW | FLAG_ADJUST);

    ctx.builder
        .load_fixed_u8(global_pointers::last_result as u32);
}
fn gen_or32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.current_instruction = Instruction::Bitwise {
        opsize: OPSIZE_32,
        dest: local_to_instruction_operand(ctx, dest_operand),
    };

    ctx.builder.get_local(&dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.or_i32();
    ctx.builder.set_local(dest_operand);

    codegen::gen_set_last_result(ctx.builder, &dest_operand);
    codegen::gen_set_last_op_size_and_flags_changed(
        ctx.builder,
        OPSIZE_32,
        FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW & !FLAG_ADJUST,
    );
    codegen::gen_clear_flags_bits(ctx.builder, FLAG_CARRY | FLAG_OVERFLOW | FLAG_ADJUST);
}

fn gen_xor8(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.current_instruction = Instruction::Bitwise {
        opsize: OPSIZE_8,
        dest: local_to_instruction_operand(ctx, dest_operand),
    };

    ctx.builder.const_i32(global_pointers::last_result as i32);
    ctx.builder.get_local(dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.xor_i32();
    ctx.builder.store_aligned_i32(0);

    codegen::gen_set_last_op_size_and_flags_changed(
        ctx.builder,
        OPSIZE_8,
        FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW & !FLAG_ADJUST,
    );
    codegen::gen_clear_flags_bits(ctx.builder, FLAG_CARRY | FLAG_OVERFLOW | FLAG_ADJUST);

    ctx.builder
        .load_fixed_u8(global_pointers::last_result as u32);
}
fn gen_xor32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.current_instruction = Instruction::Bitwise {
        opsize: OPSIZE_32,
        dest: local_to_instruction_operand(ctx, dest_operand),
    };

    if source_operand.eq_local(dest_operand) {
        ctx.builder.const_i32(0);
        ctx.builder.set_local(dest_operand);
    // TODO:
    // - Set last_result to zero rather than reading from local
    // - Skip setting opsize (not relevant for SF, ZF, and PF on zero)
    }
    else {
        ctx.builder.get_local(&dest_operand);
        source_operand.gen_get(ctx.builder);
        ctx.builder.xor_i32();
        ctx.builder.set_local(dest_operand);
    }

    codegen::gen_set_last_result(ctx.builder, &dest_operand);
    codegen::gen_set_last_op_size_and_flags_changed(
        ctx.builder,
        OPSIZE_32,
        FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW & !FLAG_ADJUST,
    );
    codegen::gen_clear_flags_bits(ctx.builder, FLAG_CARRY | FLAG_OVERFLOW | FLAG_ADJUST);
}

fn gen_rol32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    let builder = &mut ctx.builder;
    builder.get_local(dest_operand);
    match source_operand {
        LocalOrImmediate::WasmLocal(l) => {
            builder.get_local(l);
            builder.const_i32(31);
            builder.and_i32();
        },
        LocalOrImmediate::Immediate(i) => {
            builder.const_i32(*i & 31);
        },
    }
    builder.const_i32(31);
    builder.and_i32();
    builder.call_fn2_ret("rol32");
    builder.set_local(dest_operand);
}
fn gen_ror32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    let builder = &mut ctx.builder;
    builder.get_local(dest_operand);
    match source_operand {
        LocalOrImmediate::WasmLocal(l) => {
            builder.get_local(l);
            builder.const_i32(31);
            builder.and_i32();
        },
        LocalOrImmediate::Immediate(i) => {
            builder.const_i32(*i & 31);
        },
    }
    builder.const_i32(31);
    builder.and_i32();
    builder.call_fn2_ret("ror32");
    builder.set_local(dest_operand);
}

fn gen_rcl32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    let builder = &mut ctx.builder;
    builder.get_local(dest_operand);
    match source_operand {
        LocalOrImmediate::WasmLocal(l) => {
            builder.get_local(l);
            builder.const_i32(31);
            builder.and_i32();
        },
        LocalOrImmediate::Immediate(i) => {
            builder.const_i32(*i & 31);
        },
    }
    builder.const_i32(31);
    builder.and_i32();
    builder.call_fn2_ret("rcl32");
    builder.set_local(dest_operand);
}
fn gen_rcr32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    let builder = &mut ctx.builder;
    builder.get_local(dest_operand);
    match source_operand {
        LocalOrImmediate::WasmLocal(l) => {
            builder.get_local(l);
            builder.const_i32(31);
            builder.and_i32();
        },
        LocalOrImmediate::Immediate(i) => {
            builder.const_i32(*i & 31);
        },
    }
    builder.const_i32(31);
    builder.and_i32();
    builder.call_fn2_ret("rcr32");
    builder.set_local(dest_operand);
}

enum ShiftCount {
    Local(WasmLocal),
    Immediate(i32),
}
impl ShiftCount {
    pub fn gen_get(builder: &mut WasmBuilder, count: &ShiftCount) {
        match &count {
            ShiftCount::Local(l) => builder.get_local(l),
            ShiftCount::Immediate(i) => builder.const_i32(*i),
        }
    }
    pub fn gen_get_thirtytwo_minus(builder: &mut WasmBuilder, count: &ShiftCount) {
        match &count {
            ShiftCount::Local(l) => {
                builder.const_i32(32);
                builder.get_local(l);
                builder.sub_i32();
            },
            ShiftCount::Immediate(i) => builder.const_i32(32 - *i),
        }
    }
    pub fn gen_get_minus_one(builder: &mut WasmBuilder, count: &ShiftCount) {
        match &count {
            ShiftCount::Local(l) => {
                builder.get_local(l);
                builder.const_i32(1);
                builder.sub_i32()
            },
            ShiftCount::Immediate(i) => builder.const_i32(*i - 1),
        }
    }
}

fn gen_shl32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    if let &LocalOrImmediate::Immediate(1..=31) = source_operand {
        ctx.current_instruction = Instruction::NonZeroShift {
            dest: local_to_instruction_operand(ctx, dest_operand),
            opsize: OPSIZE_32,
        };
    }
    let builder = &mut ctx.builder;
    let count = match source_operand {
        LocalOrImmediate::WasmLocal(l) => {
            let exit = builder.block_void();
            builder.get_local(l);
            builder.const_i32(31); // Note: mask can probably be avoided since wasm has the same semantics on shl_i32
            builder.and_i32();
            let count = builder.tee_new_local();
            builder.eqz_i32();
            builder.br_if(exit);
            ShiftCount::Local(count)
        },
        LocalOrImmediate::Immediate(i) => {
            if *i & 31 == 0 {
                return;
            }
            ShiftCount::Immediate(*i & 31)
        },
    };

    builder.get_local(&dest_operand);
    ShiftCount::gen_get_thirtytwo_minus(builder, &count);
    builder.shr_u_i32();
    builder.const_i32(1);
    builder.and_i32();
    let b = builder.set_new_local();

    builder.get_local(dest_operand);
    ShiftCount::gen_get(builder, &count);
    builder.shl_i32();
    builder.set_local(dest_operand);

    codegen::gen_set_last_result(builder, dest_operand);
    codegen::gen_set_last_op_size_and_flags_changed(
        builder,
        OPSIZE_32,
        FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW,
    );

    builder.const_i32(global_pointers::flags as i32);
    codegen::gen_get_flags(builder);
    builder.const_i32(!(FLAG_CARRY | FLAG_OVERFLOW));
    builder.and_i32();
    builder.get_local(&b);
    builder.or_i32();
    {
        builder.get_local(&b);
        builder.get_local(&dest_operand);
        builder.const_i32(31);
        builder.shr_u_i32();
        builder.xor_i32();
        builder.const_i32(11);
        builder.shl_i32();
        builder.const_i32(FLAG_OVERFLOW);
        builder.and_i32();
        builder.or_i32();
    }
    builder.store_aligned_i32(0);

    builder.free_local(b);

    if let ShiftCount::Local(l) = count {
        builder.block_end();
        builder.free_local(l);
    }
}
fn gen_shr32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    if let &LocalOrImmediate::Immediate(1..=31) = source_operand {
        ctx.current_instruction = Instruction::NonZeroShift {
            dest: local_to_instruction_operand(ctx, dest_operand),
            opsize: OPSIZE_32,
        };
    }
    let builder = &mut ctx.builder;
    let count = match source_operand {
        LocalOrImmediate::WasmLocal(l) => {
            let exit = builder.block_void();
            builder.get_local(l);
            builder.const_i32(31); // Note: mask can probably be avoided since wasm has the same semantics on shl_i32
            builder.and_i32();
            let count = builder.tee_new_local();
            builder.eqz_i32();
            builder.br_if(exit);
            ShiftCount::Local(count)
        },
        LocalOrImmediate::Immediate(i) => {
            if *i & 31 == 0 {
                return;
            }
            ShiftCount::Immediate(*i & 31)
        },
    };

    builder.const_i32(global_pointers::flags as i32);
    codegen::gen_get_flags(builder);
    builder.const_i32(!(FLAG_CARRY | FLAG_OVERFLOW));
    builder.and_i32();
    {
        builder.get_local(dest_operand);
        ShiftCount::gen_get_minus_one(builder, &count);
        builder.shr_u_i32();
        builder.const_i32(1);
        builder.and_i32();
        builder.or_i32()
    }
    {
        builder.get_local(dest_operand);
        builder.const_i32(20);
        builder.shr_u_i32();
        builder.const_i32(FLAG_OVERFLOW);
        builder.and_i32();
        builder.or_i32()
    }
    builder.store_aligned_i32(0);

    builder.get_local(dest_operand);
    ShiftCount::gen_get(builder, &count);
    builder.shr_u_i32();
    builder.set_local(dest_operand);

    codegen::gen_set_last_result(builder, dest_operand);
    codegen::gen_set_last_op_size_and_flags_changed(
        builder,
        OPSIZE_32,
        FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW,
    );

    if let ShiftCount::Local(l) = count {
        builder.block_end();
        builder.free_local(l);
    }
}
fn gen_sar32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    if let &LocalOrImmediate::Immediate(1..=31) = source_operand {
        ctx.current_instruction = Instruction::NonZeroShift {
            dest: local_to_instruction_operand(ctx, dest_operand),
            opsize: OPSIZE_32,
        };
    }
    let builder = &mut ctx.builder;
    let count = match source_operand {
        LocalOrImmediate::WasmLocal(l) => {
            let exit = builder.block_void();
            builder.get_local(l);
            builder.const_i32(31); // Note: mask can probably be avoided since wasm has the same semantics on shl_i32
            builder.and_i32();
            let count = builder.tee_new_local();
            builder.eqz_i32();
            builder.br_if(exit);
            ShiftCount::Local(count)
        },
        LocalOrImmediate::Immediate(i) => {
            if *i & 31 == 0 {
                return;
            }
            ShiftCount::Immediate(*i & 31)
        },
    };

    builder.const_i32(global_pointers::flags as i32);
    codegen::gen_get_flags(builder);
    builder.const_i32(!(FLAG_CARRY | FLAG_OVERFLOW));
    builder.and_i32();
    {
        builder.get_local(dest_operand);
        ShiftCount::gen_get_minus_one(builder, &count);
        builder.shr_u_i32();
        builder.const_i32(1);
        builder.and_i32();
        builder.or_i32()
    }
    builder.store_aligned_i32(0);

    builder.get_local(dest_operand);
    ShiftCount::gen_get(builder, &count);
    builder.shr_s_i32();
    builder.set_local(dest_operand);

    codegen::gen_set_last_result(builder, dest_operand);
    codegen::gen_set_last_op_size_and_flags_changed(
        builder,
        OPSIZE_32,
        FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW,
    );

    if let ShiftCount::Local(l) = count {
        builder.block_end();
        builder.free_local(l);
    }
}

fn gen_xadd32(ctx: &mut JitContext, dest_operand: &WasmLocal, r: u32) {
    ctx.builder.get_local(&ctx.register_locals[r as usize]);
    let tmp = ctx.builder.set_new_local();

    ctx.builder.get_local(&dest_operand);
    codegen::gen_set_reg32(ctx, r);

    gen_add32(ctx, &dest_operand, &LocalOrImmediate::WasmLocal(&tmp));

    ctx.builder.free_local(tmp);
}

fn gen_cmpxchg32(ctx: &mut JitContext, r: u32) {
    let source = ctx.builder.set_new_local();

    ctx.builder.const_i32(global_pointers::last_result as i32);
    codegen::gen_get_reg32(ctx, regs::EAX);
    ctx.builder.get_local(&source);
    ctx.builder.sub_i32();
    ctx.builder.store_aligned_i32(0);

    ctx.builder.const_i32(global_pointers::last_op1 as i32);
    codegen::gen_get_reg32(ctx, regs::EAX);
    ctx.builder.store_aligned_i32(0);
    codegen::gen_set_last_op_size_and_flags_changed(ctx.builder, OPSIZE_32, FLAGS_ALL | FLAG_SUB);

    codegen::gen_get_reg32(ctx, regs::EAX);
    ctx.builder.get_local(&source);
    ctx.builder.eq_i32();
    ctx.builder.if_i32();
    codegen::gen_get_reg32(ctx, r);
    ctx.builder.else_();
    ctx.builder.get_local(&source);
    codegen::gen_set_reg32(ctx, regs::EAX);
    ctx.builder.get_local(&source);
    ctx.builder.block_end();

    ctx.builder.free_local(source);
}

fn gen_mul32(ctx: &mut JitContext) {
    ctx.builder.extend_unsigned_i32_to_i64();

    codegen::gen_get_reg32(ctx, regs::EAX);
    ctx.builder.extend_unsigned_i32_to_i64();
    ctx.builder.mul_i64();

    let result = ctx.builder.tee_new_local_i64();
    ctx.builder.const_i64(32);
    ctx.builder.shr_u_i64();
    ctx.builder.wrap_i64_to_i32();
    codegen::gen_set_reg32(ctx, regs::EDX);

    ctx.builder.get_local_i64(&result);
    ctx.builder.free_local_i64(result);
    ctx.builder.wrap_i64_to_i32();
    codegen::gen_set_reg32(ctx, regs::EAX);

    codegen::gen_get_reg32(ctx, regs::EDX);
    ctx.builder.if_void();
    codegen::gen_set_flags_bits(ctx.builder, 1 | FLAG_OVERFLOW);
    ctx.builder.else_();
    codegen::gen_clear_flags_bits(ctx.builder, 1 | FLAG_OVERFLOW);
    ctx.builder.block_end();

    codegen::gen_set_last_result(ctx.builder, &ctx.register_locals[regs::EAX as usize]);
    codegen::gen_set_last_op_size_and_flags_changed(
        ctx.builder,
        OPSIZE_32,
        FLAGS_ALL & !1 & !FLAG_OVERFLOW,
    );
}

fn gen_imul32(ctx: &mut JitContext) {
    ctx.builder.extend_signed_i32_to_i64();

    codegen::gen_get_reg32(ctx, regs::EAX);
    ctx.builder.extend_signed_i32_to_i64();
    ctx.builder.mul_i64();

    let result = ctx.builder.tee_new_local_i64();
    ctx.builder.const_i64(32);
    ctx.builder.shr_u_i64();
    ctx.builder.wrap_i64_to_i32();
    codegen::gen_set_reg32(ctx, regs::EDX);

    ctx.builder.get_local_i64(&result);
    ctx.builder.free_local_i64(result);
    ctx.builder.wrap_i64_to_i32();
    codegen::gen_set_reg32(ctx, regs::EAX);

    codegen::gen_get_reg32(ctx, regs::EDX);
    codegen::gen_get_reg32(ctx, regs::EAX);
    ctx.builder.const_i32(31);
    ctx.builder.shr_s_i32();
    ctx.builder.eq_i32();
    ctx.builder.if_void();
    codegen::gen_clear_flags_bits(ctx.builder, 1 | FLAG_OVERFLOW);
    ctx.builder.else_();
    codegen::gen_set_flags_bits(ctx.builder, 1 | FLAG_OVERFLOW);
    ctx.builder.block_end();

    codegen::gen_set_last_result(ctx.builder, &ctx.register_locals[regs::EAX as usize]);
    codegen::gen_set_last_op_size_and_flags_changed(
        ctx.builder,
        OPSIZE_32,
        FLAGS_ALL & !1 & !FLAG_OVERFLOW,
    );
}

fn gen_imul_reg32(
    ctx: &mut JitContext,
    dest_operand: &WasmLocal,
    source_operand: &LocalOrImmediate,
) {
    gen_imul3_reg32(ctx.builder, dest_operand, dest_operand, source_operand);
}

fn gen_imul3_reg32(
    builder: &mut WasmBuilder,
    dest_operand: &WasmLocal,
    source_operand1: &WasmLocal,
    source_operand2: &LocalOrImmediate,
) {
    builder.get_local(&source_operand1);
    builder.extend_signed_i32_to_i64();
    source_operand2.gen_get(builder);
    builder.extend_signed_i32_to_i64();
    builder.mul_i64();

    let result = builder.tee_new_local_i64();
    builder.wrap_i64_to_i32();
    builder.set_local(&dest_operand);

    codegen::gen_set_last_result(builder, &dest_operand);
    codegen::gen_set_last_op_size_and_flags_changed(
        builder,
        OPSIZE_32,
        FLAGS_ALL & !1 & !FLAG_OVERFLOW,
    );

    builder.const_i32(global_pointers::flags as i32);
    builder.get_local_i64(&result);
    builder.wrap_i64_to_i32();
    builder.extend_signed_i32_to_i64();
    builder.get_local_i64(&result);
    builder.ne_i64();
    builder.const_i32(1 | FLAG_OVERFLOW);
    builder.mul_i32();
    codegen::gen_get_flags(builder);
    builder.const_i32(!1 & !FLAG_OVERFLOW);
    builder.and_i32();
    builder.or_i32();
    builder.store_aligned_i32(0);

    builder.free_local_i64(result);
}

fn gen_div32(ctx: &mut JitContext, source: &WasmLocal) {
    let done = ctx.builder.block_void();
    {
        let exception = ctx.builder.block_void();
        {
            ctx.builder.get_local(source);
            ctx.builder.eqz_i32();
            ctx.builder.br_if(exception);

            codegen::gen_get_reg32(ctx, regs::EDX);
            ctx.builder.extend_unsigned_i32_to_i64();
            ctx.builder.const_i64(32);
            ctx.builder.shl_i64();
            codegen::gen_get_reg32(ctx, regs::EAX);
            ctx.builder.extend_unsigned_i32_to_i64();
            ctx.builder.or_i64();
            let dest_operand = ctx.builder.tee_new_local_i64();

            ctx.builder.get_local(source);
            ctx.builder.extend_unsigned_i32_to_i64();
            ctx.builder.div_i64();
            let result = ctx.builder.tee_new_local_i64();
            ctx.builder.const_i64(0xFFFF_FFFF);
            ctx.builder.gtu_i64();
            ctx.builder.br_if(exception);

            ctx.builder.get_local_i64(&dest_operand);
            ctx.builder.get_local(source);
            ctx.builder.extend_unsigned_i32_to_i64();
            ctx.builder.rem_i64();
            ctx.builder.wrap_i64_to_i32();
            codegen::gen_set_reg32(ctx, regs::EDX);

            ctx.builder.get_local_i64(&result);
            ctx.builder.wrap_i64_to_i32();
            codegen::gen_set_reg32(ctx, regs::EAX);
            ctx.builder.br(done);

            ctx.builder.free_local_i64(dest_operand);
            ctx.builder.free_local_i64(result);
        }
        ctx.builder.block_end();

        codegen::gen_trigger_de(ctx);
    }
    ctx.builder.block_end();
}

fn gen_bt(
    builder: &mut WasmBuilder,
    bit_base: &WasmLocal,
    bit_offset: &LocalOrImmediate,
    offset_mask: u32,
) {
    builder.const_i32(global_pointers::flags as i32);
    codegen::gen_get_flags(builder);
    builder.const_i32(!1);
    builder.and_i32();
    builder.get_local(bit_base);
    match bit_offset {
        LocalOrImmediate::WasmLocal(l) => {
            builder.get_local(l);
            builder.const_i32(offset_mask as i32);
            builder.and_i32();
        },
        LocalOrImmediate::Immediate(imm) => builder.const_i32(imm & offset_mask as i32),
    }
    builder.shr_u_i32();
    builder.const_i32(1);
    builder.and_i32();
    builder.or_i32();
    builder.store_aligned_i32(0);

    codegen::gen_clear_flags_changed_bits(builder, 1);
}
fn gen_bts(
    builder: &mut WasmBuilder,
    dest_bit_base: &WasmLocal,
    bit_offset: &LocalOrImmediate,
    offset_mask: u32,
) {
    gen_bt(builder, dest_bit_base, bit_offset, offset_mask);

    builder.get_local(dest_bit_base);
    match bit_offset {
        LocalOrImmediate::WasmLocal(l) => {
            builder.const_i32(1);
            builder.get_local(l);
            builder.const_i32(offset_mask as i32);
            builder.and_i32();
            builder.shl_i32();
        },
        LocalOrImmediate::Immediate(imm) => builder.const_i32(1 << (imm & offset_mask as i32)),
    }
    builder.or_i32();
    builder.set_local(dest_bit_base);
}
fn gen_btc(
    builder: &mut WasmBuilder,
    dest_bit_base: &WasmLocal,
    bit_offset: &LocalOrImmediate,
    offset_mask: u32,
) {
    gen_bt(builder, dest_bit_base, bit_offset, offset_mask);

    builder.get_local(dest_bit_base);
    match bit_offset {
        LocalOrImmediate::WasmLocal(l) => {
            builder.const_i32(1);
            builder.get_local(l);
            builder.const_i32(offset_mask as i32);
            builder.and_i32();
            builder.shl_i32();
        },
        LocalOrImmediate::Immediate(imm) => builder.const_i32(1 << (imm & offset_mask as i32)),
    }
    builder.xor_i32();
    builder.set_local(dest_bit_base);
}
fn gen_btr(
    builder: &mut WasmBuilder,
    dest_bit_base: &WasmLocal,
    bit_offset: &LocalOrImmediate,
    offset_mask: u32,
) {
    gen_bt(builder, dest_bit_base, bit_offset, offset_mask);

    builder.get_local(dest_bit_base);
    match bit_offset {
        LocalOrImmediate::WasmLocal(l) => {
            builder.const_i32(1);
            builder.get_local(l);
            builder.const_i32(offset_mask as i32);
            builder.and_i32();
            builder.shl_i32();
            builder.const_i32(-1);
            builder.xor_i32();
        },
        LocalOrImmediate::Immediate(imm) => builder.const_i32(!(1 << (imm & offset_mask as i32))),
    }
    builder.and_i32();
    builder.set_local(dest_bit_base);
}

fn gen_bit_rmw(
    ctx: &mut JitContext,
    modrm_byte: ModrmByte,
    op: &dyn Fn(&mut WasmBuilder, &WasmLocal, &LocalOrImmediate, u32),
    source_operand: &LocalOrImmediate,
    opsize: i32,
) {
    dbg_assert!(opsize == 16 || opsize == 32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    match source_operand {
        LocalOrImmediate::WasmLocal(l) => {
            ctx.builder.get_local(l);
            if opsize == 16 {
                codegen::sign_extend_i16(ctx.builder);
            }
            ctx.builder.const_i32(3);
            ctx.builder.shr_s_i32();
            ctx.builder.add_i32();
        },
        &LocalOrImmediate::Immediate(imm8) => {
            let offset = (imm8 as i32 & (opsize - 1)) >> 3;
            if offset != 0 {
                ctx.builder.const_i32(offset);
                ctx.builder.add_i32();
            }
        },
    }
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read_write(ctx, BitSize::BYTE, &address_local, &|ref mut ctx| {
        let value_local = ctx.builder.set_new_local();
        op(ctx.builder, &value_local, source_operand, 7);
        ctx.builder.get_local(&value_local);
        ctx.builder.free_local(value_local);
    });
    ctx.builder.free_local(address_local);
}

fn gen_bsf32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.builder.get_local(&dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.call_fn2_ret("bsf32");
    ctx.builder.set_local(dest_operand);
}

fn gen_bsr32(ctx: &mut JitContext, dest_operand: &WasmLocal, source_operand: &LocalOrImmediate) {
    ctx.builder.get_local(&dest_operand);
    source_operand.gen_get(ctx.builder);
    ctx.builder.call_fn2_ret("bsr32");
    ctx.builder.set_local(dest_operand);
}

fn gen_bswap(ctx: &mut JitContext, reg: i32) {
    let l = &ctx.register_locals[reg as usize];

    ctx.builder.get_local(l);
    ctx.builder.const_i32(8);
    ctx.builder.rotl_i32();
    ctx.builder.const_i32(0xFF00FF);
    ctx.builder.and_i32();

    ctx.builder.get_local(l);
    ctx.builder.const_i32(24);
    ctx.builder.rotl_i32();
    ctx.builder.const_i32(0xFF00FF00u32 as i32);
    ctx.builder.and_i32();

    ctx.builder.or_i32();

    ctx.builder.set_local(l);
}

define_instruction_read_write_mem8!(gen_add8, instr_00_mem_jit, instr_00_reg_jit, reg);
define_instruction_read_write_mem16!("add16", instr16_01_mem_jit, instr16_01_reg_jit, reg);
define_instruction_read_write_mem32!(gen_add32, instr32_01_mem_jit, instr32_01_reg_jit, reg);

define_instruction_write_reg8!(gen_add8, instr_02_mem_jit, instr_02_reg_jit);
define_instruction_write_reg16!("add16", instr16_03_mem_jit, instr16_03_reg_jit);
define_instruction_write_reg32!(gen_add32, instr32_03_mem_jit, instr32_03_reg_jit);

pub fn instr_04_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, &gen_add8, imm8); }
pub fn instr16_05_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "add16", imm16);
}
pub fn instr32_05_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, &gen_add32, imm32);
}

define_instruction_read_write_mem8!(gen_or8, instr_08_mem_jit, instr_08_reg_jit, reg);
define_instruction_read_write_mem16!("or16", instr16_09_mem_jit, instr16_09_reg_jit, reg);
define_instruction_read_write_mem32!(gen_or32, instr32_09_mem_jit, instr32_09_reg_jit, reg);

define_instruction_write_reg8!(gen_or8, instr_0A_mem_jit, instr_0A_reg_jit);
define_instruction_write_reg16!("or16", instr16_0B_mem_jit, instr16_0B_reg_jit);
define_instruction_write_reg32!(gen_or32, instr32_0B_mem_jit, instr32_0B_reg_jit);

pub fn instr_0C_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, &gen_or8, imm8); }
pub fn instr16_0D_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "or16", imm16);
}
pub fn instr32_0D_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, &gen_or32, imm32);
}

define_instruction_read_write_mem8!(gen_adc8, instr_10_mem_jit, instr_10_reg_jit, reg);
define_instruction_read_write_mem16!("adc16", instr16_11_mem_jit, instr16_11_reg_jit, reg);
define_instruction_read_write_mem32!(gen_adc32, instr32_11_mem_jit, instr32_11_reg_jit, reg);

define_instruction_write_reg8!(gen_adc8, instr_12_mem_jit, instr_12_reg_jit);
define_instruction_write_reg16!("adc16", instr16_13_mem_jit, instr16_13_reg_jit);
define_instruction_write_reg32!(gen_adc32, instr32_13_mem_jit, instr32_13_reg_jit);

pub fn instr_14_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, &gen_adc8, imm8); }
pub fn instr16_15_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "adc16", imm16);
}
pub fn instr32_15_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, &gen_adc32, imm32);
}

define_instruction_read_write_mem8!(gen_sbb8, instr_18_mem_jit, instr_18_reg_jit, reg);
define_instruction_read_write_mem16!("sbb16", instr16_19_mem_jit, instr16_19_reg_jit, reg);
define_instruction_read_write_mem32!(gen_sbb32, instr32_19_mem_jit, instr32_19_reg_jit, reg);

define_instruction_write_reg8!(gen_sbb8, instr_1A_mem_jit, instr_1A_reg_jit);
define_instruction_write_reg16!("sbb16", instr16_1B_mem_jit, instr16_1B_reg_jit);
define_instruction_write_reg32!(gen_sbb32, instr32_1B_mem_jit, instr32_1B_reg_jit);

pub fn instr_1C_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, &gen_sbb8, imm8); }
pub fn instr16_1D_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "sbb16", imm16);
}
pub fn instr32_1D_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, &gen_sbb32, imm32);
}

define_instruction_read_write_mem8!(gen_and8, instr_20_mem_jit, instr_20_reg_jit, reg);
define_instruction_read_write_mem16!("and16", instr16_21_mem_jit, instr16_21_reg_jit, reg);
define_instruction_read_write_mem32!(gen_and32, instr32_21_mem_jit, instr32_21_reg_jit, reg);

define_instruction_write_reg8!(gen_and8, instr_22_mem_jit, instr_22_reg_jit);
define_instruction_write_reg16!("and16", instr16_23_mem_jit, instr16_23_reg_jit);
define_instruction_write_reg32!(gen_and32, instr32_23_mem_jit, instr32_23_reg_jit);

pub fn instr_24_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, &gen_and8, imm8); }
pub fn instr16_25_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "and16", imm16);
}
pub fn instr32_25_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, &gen_and32, imm32);
}

define_instruction_read_write_mem8!(gen_sub8, instr_28_mem_jit, instr_28_reg_jit, reg);
define_instruction_read_write_mem16!("sub16", instr16_29_mem_jit, instr16_29_reg_jit, reg);
define_instruction_read_write_mem32!(gen_sub32, instr32_29_mem_jit, instr32_29_reg_jit, reg);

define_instruction_write_reg8!(gen_sub8, instr_2A_mem_jit, instr_2A_reg_jit);
define_instruction_write_reg16!("sub16", instr16_2B_mem_jit, instr16_2B_reg_jit);
define_instruction_write_reg32!(gen_sub32, instr32_2B_mem_jit, instr32_2B_reg_jit);

pub fn instr_2C_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, &gen_sub8, imm8); }
pub fn instr16_2D_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "sub16", imm16);
}
pub fn instr32_2D_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, &gen_sub32, imm32);
}

define_instruction_read_write_mem8!(gen_xor8, instr_30_mem_jit, instr_30_reg_jit, reg);
define_instruction_read_write_mem16!("xor16", instr16_31_mem_jit, instr16_31_reg_jit, reg);
define_instruction_read_write_mem32!(gen_xor32, instr32_31_mem_jit, instr32_31_reg_jit, reg);

define_instruction_write_reg8!(gen_xor8, instr_32_mem_jit, instr_32_reg_jit);
define_instruction_write_reg16!("xor16", instr16_33_mem_jit, instr16_33_reg_jit);
define_instruction_write_reg32!(gen_xor32, instr32_33_mem_jit, instr32_33_reg_jit);

pub fn instr_34_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, &gen_xor8, imm8); }
pub fn instr16_35_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "xor16", imm16);
}
pub fn instr32_35_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, &gen_xor32, imm32);
}

define_instruction_read8!(gen_cmp8, instr_38_mem_jit, instr_38_reg_jit);
define_instruction_read16!(gen_cmp16, instr16_39_mem_jit, instr16_39_reg_jit);
define_instruction_read32!(gen_cmp32, instr32_39_mem_jit, instr32_39_reg_jit);

pub fn instr_3A_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    let dest_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r);
    codegen::gen_modrm_resolve_safe_read8(ctx, modrm_byte);
    let source_operand = ctx.builder.set_new_local();
    gen_cmp8(
        ctx,
        &dest_operand,
        &LocalOrImmediate::WasmLocal(&source_operand),
    );
    codegen::gen_free_reg8_or_alias(ctx, r, dest_operand);
    ctx.builder.free_local(source_operand);
}

pub fn instr_3A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    let dest_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r2);
    let source_operand = codegen::gen_get_reg8_or_alias_to_reg32(ctx, r1);
    gen_cmp8(
        ctx,
        &dest_operand,
        &LocalOrImmediate::WasmLocal(&source_operand),
    );
    codegen::gen_free_reg8_or_alias(ctx, r2, dest_operand);
    codegen::gen_free_reg8_or_alias(ctx, r1, source_operand);
}

pub fn instr16_3B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    let source_operand = ctx.builder.set_new_local();
    gen_cmp16(
        ctx,
        &ctx.reg(r),
        &LocalOrImmediate::WasmLocal(&source_operand),
    );
    ctx.builder.free_local(source_operand);
}

pub fn instr16_3B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    gen_cmp16(
        ctx,
        &ctx.reg(r2),
        &LocalOrImmediate::WasmLocal(&ctx.reg(r1)),
    );
}

pub fn instr32_3B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    let source_operand = ctx.builder.set_new_local();
    gen_cmp32(
        ctx,
        &ctx.reg(r),
        &LocalOrImmediate::WasmLocal(&source_operand),
    );
    ctx.builder.free_local(source_operand);
}

pub fn instr32_3B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    gen_cmp32(
        ctx,
        &ctx.reg(r2),
        &LocalOrImmediate::WasmLocal(&ctx.reg(r1)),
    );
}

pub fn instr_3C_jit(ctx: &mut JitContext, imm8: u32) {
    gen_cmp8(ctx, &ctx.reg(0), &LocalOrImmediate::Immediate(imm8 as i32));
}

pub fn instr16_3D_jit(ctx: &mut JitContext, imm16: u32) {
    gen_cmp16(ctx, &ctx.reg(0), &LocalOrImmediate::Immediate(imm16 as i32));
}

pub fn instr32_3D_jit(ctx: &mut JitContext, imm32: u32) {
    gen_cmp32(ctx, &ctx.reg(0), &LocalOrImmediate::Immediate(imm32 as i32));
}

fn gen_inc(ctx: &mut JitContext, dest_operand: &WasmLocal, size: i32) {
    ctx.builder.const_i32(global_pointers::flags as i32);
    codegen::gen_get_flags(ctx.builder);
    ctx.builder.const_i32(!1);
    ctx.builder.and_i32();
    codegen::gen_getcf(ctx, ConditionNegate::False);
    ctx.builder.or_i32();
    ctx.builder.store_aligned_i32(0);

    ctx.builder.const_i32(global_pointers::last_op1 as i32);
    ctx.builder.get_local(&dest_operand);
    if size == OPSIZE_8 || size == OPSIZE_16 {
        ctx.builder
            .const_i32(if size == OPSIZE_8 { 0xFF } else { 0xFFFF });
        ctx.builder.and_i32();
    }
    ctx.builder.store_aligned_i32(0);

    ctx.builder.get_local(dest_operand);
    ctx.builder.const_i32(1);
    ctx.builder.add_i32();
    if size == OPSIZE_16 {
        codegen::gen_set_reg16_local(ctx.builder, dest_operand);
    }
    else {
        ctx.builder.set_local(dest_operand);
    }

    ctx.builder.const_i32(global_pointers::last_result as i32);
    ctx.builder.get_local(&dest_operand);
    if size == OPSIZE_16 {
        ctx.builder.const_i32(0xFFFF);
        ctx.builder.and_i32();
    }
    ctx.builder.store_aligned_i32(0);
    codegen::gen_set_last_op_size_and_flags_changed(ctx.builder, size, FLAGS_ALL & !1);
    ctx.current_instruction = Instruction::Add {
        opsize: size,
        dest: local_to_instruction_operand(ctx, dest_operand),
        source: InstructionOperand::Immediate(1),
        is_inc: true,
    };
}
fn gen_inc16(ctx: &mut JitContext, dest_operand: &WasmLocal) {
    gen_inc(ctx, dest_operand, OPSIZE_16);
}
fn gen_inc32(ctx: &mut JitContext, dest_operand: &WasmLocal) {
    gen_inc(ctx, dest_operand, OPSIZE_32);
}

fn gen_dec(ctx: &mut JitContext, dest_operand: &WasmLocal, size: i32) {
    ctx.builder.const_i32(global_pointers::flags as i32);
    codegen::gen_get_flags(ctx.builder);
    ctx.builder.const_i32(!1);
    ctx.builder.and_i32();
    codegen::gen_getcf(ctx, ConditionNegate::False);
    ctx.builder.or_i32();
    ctx.builder.store_aligned_i32(0);

    ctx.builder.const_i32(global_pointers::last_op1 as i32);
    ctx.builder.get_local(&dest_operand);
    if size == OPSIZE_8 || size == OPSIZE_16 {
        ctx.builder
            .const_i32(if size == OPSIZE_8 { 0xFF } else { 0xFFFF });
        ctx.builder.and_i32();
    }
    ctx.builder.store_aligned_i32(0);

    ctx.builder.get_local(dest_operand);
    ctx.builder.const_i32(1);
    ctx.builder.sub_i32();
    if size == OPSIZE_16 {
        codegen::gen_set_reg16_local(ctx.builder, dest_operand);
    }
    else {
        ctx.builder.set_local(dest_operand);
    }

    ctx.builder.const_i32(global_pointers::last_result as i32);
    ctx.builder.get_local(&dest_operand);
    if size == OPSIZE_16 {
        ctx.builder.const_i32(0xFFFF);
        ctx.builder.and_i32();
    }
    ctx.builder.store_aligned_i32(0);
    codegen::gen_set_last_op_size_and_flags_changed(ctx.builder, size, FLAGS_ALL & !1 | FLAG_SUB);
    ctx.current_instruction = Instruction::Sub {
        opsize: size,
        dest: local_to_instruction_operand(ctx, dest_operand),
        source: InstructionOperand::Immediate(1),
        is_dec: true,
    };
}
fn gen_dec16(ctx: &mut JitContext, dest_operand: &WasmLocal) {
    gen_dec(ctx, dest_operand, OPSIZE_16)
}
fn gen_dec32(ctx: &mut JitContext, dest_operand: &WasmLocal) {
    gen_dec(ctx, dest_operand, OPSIZE_32)
}

fn gen_inc16_r(ctx: &mut JitContext, r: u32) { gen_inc16(ctx, &mut ctx.reg(r)) }
fn gen_inc32_r(ctx: &mut JitContext, r: u32) { gen_inc32(ctx, &mut ctx.reg(r)) }
fn gen_dec16_r(ctx: &mut JitContext, r: u32) { gen_dec16(ctx, &mut ctx.reg(r)) }
fn gen_dec32_r(ctx: &mut JitContext, r: u32) { gen_dec32(ctx, &mut ctx.reg(r)) }

fn gen_not16(ctx: &mut JitContext, dest_operand: &WasmLocal) {
    let builder = &mut ctx.builder;
    builder.get_local(dest_operand);
    builder.const_i32(-1);
    builder.xor_i32();
    codegen::gen_set_reg16_local(builder, dest_operand);
}
fn gen_not32(ctx: &mut JitContext, dest_operand: &WasmLocal) {
    let builder = &mut ctx.builder;
    builder.get_local(dest_operand);
    builder.const_i32(-1);
    builder.xor_i32();
    builder.set_local(dest_operand);
}

fn gen_neg16(ctx: &mut JitContext, dest_operand: &WasmLocal) {
    let builder = &mut ctx.builder;
    builder.get_local(dest_operand);
    builder.call_fn1_ret("neg16");
    codegen::gen_set_reg16_local(builder, dest_operand);
}
fn gen_neg32(ctx: &mut JitContext, dest_operand: &WasmLocal) {
    let builder = &mut ctx.builder;
    builder.const_i32(global_pointers::last_op1 as i32);
    builder.const_i32(0);
    builder.store_aligned_i32(0);

    builder.const_i32(0);
    builder.get_local(&dest_operand);
    builder.sub_i32();
    builder.set_local(dest_operand);

    codegen::gen_set_last_result(builder, &dest_operand);
    codegen::gen_set_last_op_size_and_flags_changed(builder, OPSIZE_32, FLAGS_ALL | FLAG_SUB);
}

pub fn instr16_06_jit(ctx: &mut JitContext) {
    codegen::gen_get_sreg(ctx, regs::ES);
    let sreg = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &sreg);
    ctx.builder.free_local(sreg);
}
pub fn instr32_06_jit(ctx: &mut JitContext) { codegen::gen_push32_sreg(ctx, regs::ES) }

pub fn instr16_0E_jit(ctx: &mut JitContext) {
    codegen::gen_get_sreg(ctx, regs::CS);
    let sreg = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &sreg);
    ctx.builder.free_local(sreg);
}
pub fn instr32_0E_jit(ctx: &mut JitContext) { codegen::gen_push32_sreg(ctx, regs::CS) }

pub fn instr16_16_jit(ctx: &mut JitContext) {
    codegen::gen_get_sreg(ctx, regs::SS);
    let sreg = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &sreg);
    ctx.builder.free_local(sreg);
}
pub fn instr32_16_jit(ctx: &mut JitContext) { codegen::gen_push32_sreg(ctx, regs::SS) }

pub fn instr16_1E_jit(ctx: &mut JitContext) {
    codegen::gen_get_sreg(ctx, regs::DS);
    let sreg = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &sreg);
    ctx.builder.free_local(sreg);
}
pub fn instr32_1E_jit(ctx: &mut JitContext) { codegen::gen_push32_sreg(ctx, regs::DS) }

pub fn instr16_40_jit(ctx: &mut JitContext) { gen_inc16_r(ctx, AX); }
pub fn instr32_40_jit(ctx: &mut JitContext) { gen_inc32_r(ctx, EAX); }
pub fn instr16_41_jit(ctx: &mut JitContext) { gen_inc16_r(ctx, CX); }
pub fn instr32_41_jit(ctx: &mut JitContext) { gen_inc32_r(ctx, ECX); }
pub fn instr16_42_jit(ctx: &mut JitContext) { gen_inc16_r(ctx, DX); }
pub fn instr32_42_jit(ctx: &mut JitContext) { gen_inc32_r(ctx, EDX); }
pub fn instr16_43_jit(ctx: &mut JitContext) { gen_inc16_r(ctx, BX); }
pub fn instr32_43_jit(ctx: &mut JitContext) { gen_inc32_r(ctx, EBX); }
pub fn instr16_44_jit(ctx: &mut JitContext) { gen_inc16_r(ctx, SP); }
pub fn instr32_44_jit(ctx: &mut JitContext) { gen_inc32_r(ctx, ESP); }
pub fn instr16_45_jit(ctx: &mut JitContext) { gen_inc16_r(ctx, BP); }
pub fn instr32_45_jit(ctx: &mut JitContext) { gen_inc32_r(ctx, EBP); }
pub fn instr16_46_jit(ctx: &mut JitContext) { gen_inc16_r(ctx, SI); }
pub fn instr32_46_jit(ctx: &mut JitContext) { gen_inc32_r(ctx, ESI); }
pub fn instr16_47_jit(ctx: &mut JitContext) { gen_inc16_r(ctx, DI); }
pub fn instr32_47_jit(ctx: &mut JitContext) { gen_inc32_r(ctx, EDI); }

pub fn instr16_48_jit(ctx: &mut JitContext) { gen_dec16_r(ctx, AX); }
pub fn instr32_48_jit(ctx: &mut JitContext) { gen_dec32_r(ctx, EAX); }
pub fn instr16_49_jit(ctx: &mut JitContext) { gen_dec16_r(ctx, CX); }
pub fn instr32_49_jit(ctx: &mut JitContext) { gen_dec32_r(ctx, ECX); }
pub fn instr16_4A_jit(ctx: &mut JitContext) { gen_dec16_r(ctx, DX); }
pub fn instr32_4A_jit(ctx: &mut JitContext) { gen_dec32_r(ctx, EDX); }
pub fn instr16_4B_jit(ctx: &mut JitContext) { gen_dec16_r(ctx, BX); }
pub fn instr32_4B_jit(ctx: &mut JitContext) { gen_dec32_r(ctx, EBX); }
pub fn instr16_4C_jit(ctx: &mut JitContext) { gen_dec16_r(ctx, SP); }
pub fn instr32_4C_jit(ctx: &mut JitContext) { gen_dec32_r(ctx, ESP); }
pub fn instr16_4D_jit(ctx: &mut JitContext) { gen_dec16_r(ctx, BP); }
pub fn instr32_4D_jit(ctx: &mut JitContext) { gen_dec32_r(ctx, EBP); }
pub fn instr16_4E_jit(ctx: &mut JitContext) { gen_dec16_r(ctx, SI); }
pub fn instr32_4E_jit(ctx: &mut JitContext) { gen_dec32_r(ctx, ESI); }
pub fn instr16_4F_jit(ctx: &mut JitContext) { gen_dec16_r(ctx, DI); }
pub fn instr32_4F_jit(ctx: &mut JitContext) { gen_dec32_r(ctx, EDI); }

pub fn instr16_50_jit(ctx: &mut JitContext) { push16_reg_jit(ctx, AX); }
pub fn instr32_50_jit(ctx: &mut JitContext) { push32_reg_jit(ctx, EAX); }
pub fn instr16_51_jit(ctx: &mut JitContext) { push16_reg_jit(ctx, CX); }
pub fn instr32_51_jit(ctx: &mut JitContext) { push32_reg_jit(ctx, ECX); }
pub fn instr16_52_jit(ctx: &mut JitContext) { push16_reg_jit(ctx, DX); }
pub fn instr32_52_jit(ctx: &mut JitContext) { push32_reg_jit(ctx, EDX); }
pub fn instr16_53_jit(ctx: &mut JitContext) { push16_reg_jit(ctx, BX); }
pub fn instr32_53_jit(ctx: &mut JitContext) { push32_reg_jit(ctx, EBX); }
pub fn instr16_54_jit(ctx: &mut JitContext) { push16_reg_jit(ctx, SP); }
pub fn instr32_54_jit(ctx: &mut JitContext) { push32_reg_jit(ctx, ESP); }
pub fn instr16_55_jit(ctx: &mut JitContext) { push16_reg_jit(ctx, BP); }
pub fn instr32_55_jit(ctx: &mut JitContext) { push32_reg_jit(ctx, EBP); }
pub fn instr16_56_jit(ctx: &mut JitContext) { push16_reg_jit(ctx, SI); }
pub fn instr32_56_jit(ctx: &mut JitContext) { push32_reg_jit(ctx, ESI); }
pub fn instr16_57_jit(ctx: &mut JitContext) { push16_reg_jit(ctx, DI); }
pub fn instr32_57_jit(ctx: &mut JitContext) { push32_reg_jit(ctx, EDI); }

pub fn instr16_58_jit(ctx: &mut JitContext) { pop16_reg_jit(ctx, AX); }
pub fn instr32_58_jit(ctx: &mut JitContext) { pop32_reg_jit(ctx, EAX); }
pub fn instr16_59_jit(ctx: &mut JitContext) { pop16_reg_jit(ctx, CX); }
pub fn instr32_59_jit(ctx: &mut JitContext) { pop32_reg_jit(ctx, ECX); }
pub fn instr16_5A_jit(ctx: &mut JitContext) { pop16_reg_jit(ctx, DX); }
pub fn instr32_5A_jit(ctx: &mut JitContext) { pop32_reg_jit(ctx, EDX); }
pub fn instr16_5B_jit(ctx: &mut JitContext) { pop16_reg_jit(ctx, BX); }
pub fn instr32_5B_jit(ctx: &mut JitContext) { pop32_reg_jit(ctx, EBX); }
pub fn instr16_5C_jit(ctx: &mut JitContext) { pop16_reg_jit(ctx, SP); }
pub fn instr32_5C_jit(ctx: &mut JitContext) { pop32_reg_jit(ctx, ESP); }
pub fn instr16_5D_jit(ctx: &mut JitContext) { pop16_reg_jit(ctx, BP); }
pub fn instr32_5D_jit(ctx: &mut JitContext) { pop32_reg_jit(ctx, EBP); }
pub fn instr16_5E_jit(ctx: &mut JitContext) { pop16_reg_jit(ctx, SI); }
pub fn instr32_5E_jit(ctx: &mut JitContext) { pop32_reg_jit(ctx, ESI); }
pub fn instr16_5F_jit(ctx: &mut JitContext) { pop16_reg_jit(ctx, DI); }
pub fn instr32_5F_jit(ctx: &mut JitContext) { pop32_reg_jit(ctx, EDI); }

pub fn instr16_68_jit(ctx: &mut JitContext, imm16: u32) { push16_imm_jit(ctx, imm16) }
pub fn instr32_68_jit(ctx: &mut JitContext, imm32: u32) { push32_imm_jit(ctx, imm32) }
pub fn instr16_6A_jit(ctx: &mut JitContext, imm16: u32) { push16_imm_jit(ctx, imm16) }
pub fn instr32_6A_jit(ctx: &mut JitContext, imm32: u32) { push32_imm_jit(ctx, imm32) }

pub fn instr16_69_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm16: u32) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    ctx.builder.const_i32(imm16 as i32);
    ctx.builder.call_fn2_ret("imul_reg16");
    codegen::gen_set_reg16(ctx, r);
}
pub fn instr16_69_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm16: u32) {
    codegen::gen_get_reg16(ctx, r1);
    ctx.builder.const_i32(imm16 as i32);
    ctx.builder.call_fn2_ret("imul_reg16");
    codegen::gen_set_reg16(ctx, r2);
}

pub fn instr32_69_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm32: u32) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    let value_local = ctx.builder.set_new_local();
    gen_imul3_reg32(
        ctx.builder,
        &ctx.register_locals[r as usize],
        &value_local,
        &LocalOrImmediate::Immediate(imm32 as i32),
    );
    ctx.builder.free_local(value_local);
}
pub fn instr32_69_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm32: u32) {
    gen_imul3_reg32(
        ctx.builder,
        &ctx.register_locals[r2 as usize],
        &ctx.register_locals[r1 as usize],
        &LocalOrImmediate::Immediate(imm32 as i32),
    );
}

pub fn instr16_6B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8s: u32) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    ctx.builder.const_i32(imm8s as i32);
    ctx.builder.call_fn2_ret("imul_reg16");
    codegen::gen_set_reg16(ctx, r);
}
pub fn instr16_6B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8s: u32) {
    codegen::gen_get_reg16(ctx, r1);
    ctx.builder.const_i32(imm8s as i32);
    ctx.builder.call_fn2_ret("imul_reg16");
    codegen::gen_set_reg16(ctx, r2);
}

pub fn instr32_6B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8s: u32) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    let value_local = ctx.builder.set_new_local();
    gen_imul3_reg32(
        ctx.builder,
        &ctx.register_locals[r as usize],
        &value_local,
        &LocalOrImmediate::Immediate(imm8s as i32),
    );
    ctx.builder.free_local(value_local);
}
pub fn instr32_6B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8s: u32) {
    gen_imul3_reg32(
        ctx.builder,
        &ctx.register_locals[r2 as usize],
        &ctx.register_locals[r1 as usize],
        &LocalOrImmediate::Immediate(imm8s as i32),
    );
}

// Code for conditional jumps is generated automatically by the basic block codegen
pub fn instr16_70_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_70_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_71_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_71_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_72_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_72_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_73_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_73_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_74_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_74_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_75_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_75_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_76_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_76_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_77_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_77_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_78_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_78_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_79_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_79_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_7A_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_7A_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_7B_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_7B_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_7C_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_7C_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_7D_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_7D_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_7E_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_7E_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_7F_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_7F_jit(_ctx: &mut JitContext, _imm: u32) {}

// loop/loopz/loopnz/jcxz: Conditional jump is generated in main loop
pub fn instr16_E0_jit(ctx: &mut JitContext, _imm: u32) { codegen::decr_exc_asize(ctx) }
pub fn instr32_E0_jit(ctx: &mut JitContext, _imm: u32) { codegen::decr_exc_asize(ctx) }
pub fn instr16_E1_jit(ctx: &mut JitContext, _imm: u32) { codegen::decr_exc_asize(ctx) }
pub fn instr32_E1_jit(ctx: &mut JitContext, _imm: u32) { codegen::decr_exc_asize(ctx) }
pub fn instr16_E2_jit(ctx: &mut JitContext, _imm: u32) { codegen::decr_exc_asize(ctx) }
pub fn instr32_E2_jit(ctx: &mut JitContext, _imm: u32) { codegen::decr_exc_asize(ctx) }
pub fn instr16_E3_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_E3_jit(_ctx: &mut JitContext, _imm: u32) {}

define_instruction_read_write_mem8!(gen_add8, instr_80_0_mem_jit, instr_80_0_reg_jit, ximm8);
define_instruction_read_write_mem8!(gen_or8, instr_80_1_mem_jit, instr_80_1_reg_jit, ximm8);
define_instruction_read_write_mem8!(gen_adc8, instr_80_2_mem_jit, instr_80_2_reg_jit, ximm8);
define_instruction_read_write_mem8!(gen_sbb8, instr_80_3_mem_jit, instr_80_3_reg_jit, ximm8);
define_instruction_read_write_mem8!(gen_and8, instr_80_4_mem_jit, instr_80_4_reg_jit, ximm8);
define_instruction_read_write_mem8!(gen_sub8, instr_80_5_mem_jit, instr_80_5_reg_jit, ximm8);
define_instruction_read_write_mem8!(gen_xor8, instr_80_6_mem_jit, instr_80_6_reg_jit, ximm8);

define_instruction_read_write_mem8!(gen_add8, instr_82_0_mem_jit, instr_82_0_reg_jit, ximm8);
define_instruction_read_write_mem8!(gen_or8, instr_82_1_mem_jit, instr_82_1_reg_jit, ximm8);
define_instruction_read_write_mem8!(gen_adc8, instr_82_2_mem_jit, instr_82_2_reg_jit, ximm8);
define_instruction_read_write_mem8!(gen_sbb8, instr_82_3_mem_jit, instr_82_3_reg_jit, ximm8);
define_instruction_read_write_mem8!(gen_and8, instr_82_4_mem_jit, instr_82_4_reg_jit, ximm8);
define_instruction_read_write_mem8!(gen_sub8, instr_82_5_mem_jit, instr_82_5_reg_jit, ximm8);
define_instruction_read_write_mem8!(gen_xor8, instr_82_6_mem_jit, instr_82_6_reg_jit, ximm8);

define_instruction_read_write_mem16!("add16", instr16_81_0_mem_jit, instr16_81_0_reg_jit, imm16);
define_instruction_read_write_mem32!(gen_add32, instr32_81_0_mem_jit, instr32_81_0_reg_jit, imm32);

define_instruction_read_write_mem16!("or16", instr16_81_1_mem_jit, instr16_81_1_reg_jit, imm16);
define_instruction_read_write_mem32!(gen_or32, instr32_81_1_mem_jit, instr32_81_1_reg_jit, imm32);

define_instruction_read_write_mem16!("adc16", instr16_81_2_mem_jit, instr16_81_2_reg_jit, imm16);
define_instruction_read_write_mem32!(gen_adc32, instr32_81_2_mem_jit, instr32_81_2_reg_jit, imm32);

define_instruction_read_write_mem16!("sbb16", instr16_81_3_mem_jit, instr16_81_3_reg_jit, imm16);
define_instruction_read_write_mem32!(gen_sbb32, instr32_81_3_mem_jit, instr32_81_3_reg_jit, imm32);

define_instruction_read_write_mem16!("and16", instr16_81_4_mem_jit, instr16_81_4_reg_jit, imm16);
define_instruction_read_write_mem32!(gen_and32, instr32_81_4_mem_jit, instr32_81_4_reg_jit, imm32);

define_instruction_read_write_mem16!("sub16", instr16_81_5_mem_jit, instr16_81_5_reg_jit, imm16);
define_instruction_read_write_mem32!(gen_sub32, instr32_81_5_mem_jit, instr32_81_5_reg_jit, imm32);

define_instruction_read_write_mem16!("xor16", instr16_81_6_mem_jit, instr16_81_6_reg_jit, imm16);
define_instruction_read_write_mem32!(gen_xor32, instr32_81_6_mem_jit, instr32_81_6_reg_jit, imm32);

define_instruction_read_write_mem16!(
    "add16",
    instr16_83_0_mem_jit,
    instr16_83_0_reg_jit,
    imm8s_16bits
);
define_instruction_read_write_mem32!(gen_add32, instr32_83_0_mem_jit, instr32_83_0_reg_jit, imm8s);

define_instruction_read_write_mem16!(
    "or16",
    instr16_83_1_mem_jit,
    instr16_83_1_reg_jit,
    imm8s_16bits
);
define_instruction_read_write_mem32!(gen_or32, instr32_83_1_mem_jit, instr32_83_1_reg_jit, imm8s);

define_instruction_read_write_mem16!(
    "adc16",
    instr16_83_2_mem_jit,
    instr16_83_2_reg_jit,
    imm8s_16bits
);
define_instruction_read_write_mem32!(gen_adc32, instr32_83_2_mem_jit, instr32_83_2_reg_jit, imm8s);

define_instruction_read_write_mem16!(
    "sbb16",
    instr16_83_3_mem_jit,
    instr16_83_3_reg_jit,
    imm8s_16bits
);
define_instruction_read_write_mem32!(gen_sbb32, instr32_83_3_mem_jit, instr32_83_3_reg_jit, imm8s);

define_instruction_read_write_mem16!(
    "and16",
    instr16_83_4_mem_jit,
    instr16_83_4_reg_jit,
    imm8s_16bits
);
define_instruction_read_write_mem32!(gen_and32, instr32_83_4_mem_jit, instr32_83_4_reg_jit, imm8s);

define_instruction_read_write_mem16!(
    "sub16",
    instr16_83_5_mem_jit,
    instr16_83_5_reg_jit,
    imm8s_16bits
);
define_instruction_read_write_mem32!(gen_sub32, instr32_83_5_mem_jit, instr32_83_5_reg_jit, imm8s);

define_instruction_read_write_mem16!(
    "xor16",
    instr16_83_6_mem_jit,
    instr16_83_6_reg_jit,
    imm8s_16bits
);
define_instruction_read_write_mem32!(gen_xor32, instr32_83_6_mem_jit, instr32_83_6_reg_jit, imm8s);

define_instruction_read8!(gen_cmp8, instr_80_7_mem_jit, instr_80_7_reg_jit, imm8);
define_instruction_read16!(gen_cmp16, instr16_81_7_mem_jit, instr16_81_7_reg_jit, imm16);
define_instruction_read32!(gen_cmp32, instr32_81_7_mem_jit, instr32_81_7_reg_jit, imm32);

define_instruction_read8!(gen_cmp8, instr_82_7_mem_jit, instr_82_7_reg_jit, imm8);

define_instruction_read16!(
    gen_cmp16,
    instr16_83_7_mem_jit,
    instr16_83_7_reg_jit,
    imm8s_16bits
);
define_instruction_read32!(gen_cmp32, instr32_83_7_mem_jit, instr32_83_7_reg_jit, imm8s);

define_instruction_read8!(gen_test8, instr_84_mem_jit, instr_84_reg_jit);
define_instruction_read16!(gen_test16, instr16_85_mem_jit, instr16_85_reg_jit);
define_instruction_read32!(gen_test32, instr32_85_mem_jit, instr32_85_reg_jit);

pub fn instr_86_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
        codegen::gen_safe_read_write(ctx, BitSize::BYTE, &addr, &|ref mut ctx| {
            codegen::gen_get_reg8(ctx, r);
            let tmp = ctx.builder.set_new_local();
            codegen::gen_set_reg8(ctx, r);
            ctx.builder.get_local(&tmp);
            ctx.builder.free_local(tmp);
        });
    });
}
pub fn instr_86_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg8(ctx, r2);
    let tmp = ctx.builder.set_new_local();
    codegen::gen_get_reg8(ctx, r1);
    codegen::gen_set_reg8(ctx, r2);
    ctx.builder.get_local(&tmp);
    codegen::gen_set_reg8(ctx, r1);
    ctx.builder.free_local(tmp);
}
pub fn instr16_87_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
        codegen::gen_safe_read_write(ctx, BitSize::WORD, &addr, &|ref mut ctx| {
            codegen::gen_get_reg16(ctx, r);
            let tmp = ctx.builder.set_new_local();
            codegen::gen_set_reg16(ctx, r);
            ctx.builder.get_local(&tmp);
            ctx.builder.free_local(tmp);
        });
    });
}
pub fn instr32_87_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
        codegen::gen_safe_read_write(ctx, BitSize::DWORD, &addr, &|ref mut ctx| {
            codegen::gen_get_reg32(ctx, r);
            let tmp = ctx.builder.set_new_local();
            codegen::gen_set_reg32(ctx, r);
            ctx.builder.get_local(&tmp);
            ctx.builder.free_local(tmp);
        });
    });
}
pub fn instr16_87_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg16(ctx, r2);
    let tmp = ctx.builder.set_new_local();
    codegen::gen_get_reg16(ctx, r1);
    codegen::gen_set_reg16(ctx, r2);
    ctx.builder.get_local(&tmp);
    codegen::gen_set_reg16(ctx, r1);
    ctx.builder.free_local(tmp);
}
pub fn instr32_87_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg32(ctx, r2);
    let tmp = ctx.builder.set_new_local();
    codegen::gen_get_reg32(ctx, r1);
    codegen::gen_set_reg32(ctx, r2);
    ctx.builder.get_local(&tmp);
    codegen::gen_set_reg32(ctx, r1);
    ctx.builder.free_local(tmp);
}

pub fn instr_88_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
        codegen::gen_get_reg8(ctx, r);
        let value_local = ctx.builder.set_new_local();
        codegen::gen_safe_write8(ctx, &addr, &value_local);
        ctx.builder.free_local(value_local);
    });
}
pub fn instr_88_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg8_r(ctx, r1, r2);
}

pub fn instr16_89_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
        codegen::gen_safe_write16(ctx, addr, &ctx.reg(r));
    });
}
pub fn instr16_89_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg16_r(ctx, r1, r2);
}
pub fn instr32_89_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
        codegen::gen_safe_write32(ctx, &addr, &ctx.reg(r));
    });
}
pub fn instr32_89_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg32_r(ctx, r1, r2);
}

pub fn instr_8A_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    // Pseudo: reg8[r] = safe_read8(modrm_resolve(modrm_byte));
    codegen::gen_modrm_resolve_safe_read8(ctx, modrm_byte);
    codegen::gen_set_reg8_unmasked(ctx, r);
}
pub fn instr_8A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg8_r(ctx, r2, r1);
}

pub fn instr16_8B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    codegen::gen_set_reg16_unmasked(ctx, r);
}
pub fn instr16_8B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg16_r(ctx, r2, r1);
}
pub fn instr32_8B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    codegen::gen_set_reg32(ctx, r);
}
pub fn instr32_8B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg32_r(ctx, r2, r1);
}

pub fn instr16_8C_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    if r >= 6 {
        codegen::gen_trigger_ud(ctx);
    }
    else {
        codegen::gen_get_sreg(ctx, r);
        let value_local = ctx.builder.set_new_local();
        codegen::gen_safe_write16(ctx, &address_local, &value_local);
        ctx.builder.free_local(value_local);
    }
    ctx.builder.free_local(address_local);
}
pub fn instr32_8C_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    if r >= 6 {
        codegen::gen_trigger_ud(ctx);
    }
    else {
        codegen::gen_get_sreg(ctx, r);
        let value_local = ctx.builder.set_new_local();
        codegen::gen_safe_write16(ctx, &address_local, &value_local);
        ctx.builder.free_local(value_local);
    }
    ctx.builder.free_local(address_local);
}
pub fn instr16_8C_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    if r2 >= 6 {
        codegen::gen_trigger_ud(ctx);
    }
    else {
        codegen::gen_get_sreg(ctx, r2);
        codegen::gen_set_reg16(ctx, r1);
    }
}
pub fn instr32_8C_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    if r2 >= 6 {
        codegen::gen_trigger_ud(ctx);
    }
    else {
        codegen::gen_get_sreg(ctx, r2);
        codegen::gen_set_reg32(ctx, r1);
    }
}

pub fn instr16_8D_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, reg: u32) {
    ctx.cpu.prefixes |= SEG_PREFIX_ZERO;
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_set_reg16(ctx, reg);
}
pub fn instr32_8D_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, reg: u32) {
    if !modrm_byte.is_nop(reg) {
        ctx.cpu.prefixes |= SEG_PREFIX_ZERO;
        codegen::gen_modrm_resolve(ctx, modrm_byte);
        codegen::gen_set_reg32(ctx, reg);
    }
}

pub fn instr16_8D_reg_jit(ctx: &mut JitContext, _r1: u32, _r2: u32) {
    codegen::gen_trigger_ud(ctx);
}

pub fn instr32_8D_reg_jit(ctx: &mut JitContext, _r1: u32, _r2: u32) {
    codegen::gen_trigger_ud(ctx);
}

pub fn instr16_8F_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_with_esp_offset(ctx, modrm_byte, 2);
    let address_local = ctx.builder.set_new_local();

    codegen::gen_pop16(ctx);
    let value_local = ctx.builder.set_new_local();

    // undo the esp change of pop, as safe_write16 can fail
    codegen::gen_adjust_stack_reg(ctx, (-2i32) as u32);

    codegen::gen_safe_write16(ctx, &address_local, &value_local);

    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);

    // finally, actually update esp
    codegen::gen_adjust_stack_reg(ctx, 2);
}
pub fn instr16_8F_0_reg_jit(ctx: &mut JitContext, r: u32) { pop16_reg_jit(ctx, r); }
pub fn instr32_8F_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_with_esp_offset(ctx, modrm_byte, 4);
    let address_local = ctx.builder.set_new_local();

    codegen::gen_pop32s(ctx);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_adjust_stack_reg(ctx, (-4i32) as u32);

    codegen::gen_safe_write32(ctx, &address_local, &value_local);

    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);

    codegen::gen_adjust_stack_reg(ctx, 4);
}
pub fn instr32_8F_0_reg_jit(ctx: &mut JitContext, r: u32) { pop32_reg_jit(ctx, r); }

define_instruction_read_write_mem16!(
    "rol16",
    instr16_C1_0_mem_jit,
    instr16_C1_0_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    gen_rol32,
    instr32_C1_0_mem_jit,
    instr32_C1_0_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "ror16",
    instr16_C1_1_mem_jit,
    instr16_C1_1_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    gen_ror32,
    instr32_C1_1_mem_jit,
    instr32_C1_1_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "rcl16",
    instr16_C1_2_mem_jit,
    instr16_C1_2_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    gen_rcl32,
    instr32_C1_2_mem_jit,
    instr32_C1_2_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "rcr16",
    instr16_C1_3_mem_jit,
    instr16_C1_3_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    gen_rcr32,
    instr32_C1_3_mem_jit,
    instr32_C1_3_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "shl16",
    instr16_C1_4_mem_jit,
    instr16_C1_4_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    gen_shl32,
    instr32_C1_4_mem_jit,
    instr32_C1_4_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "shr16",
    instr16_C1_5_mem_jit,
    instr16_C1_5_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    gen_shr32,
    instr32_C1_5_mem_jit,
    instr32_C1_5_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "shl16",
    instr16_C1_6_mem_jit,
    instr16_C1_6_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    gen_shl32,
    instr32_C1_6_mem_jit,
    instr32_C1_6_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "sar16",
    instr16_C1_7_mem_jit,
    instr16_C1_7_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    gen_sar32,
    instr32_C1_7_mem_jit,
    instr32_C1_7_reg_jit,
    imm8_5bits
);

pub fn instr16_E8_jit(ctx: &mut JitContext, _imm: u32) {
    codegen::gen_get_real_eip(ctx);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &value_local);
    ctx.builder.free_local(value_local);
}
pub fn instr32_E8_jit(ctx: &mut JitContext, _imm: u32) {
    codegen::gen_get_real_eip(ctx);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push32(ctx, &value_local);
    ctx.builder.free_local(value_local);
}

pub fn instr16_E9_jit(_ctx: &mut JitContext, _imm: u32) {
    //
}
pub fn instr32_E9_jit(_ctx: &mut JitContext, _imm: u32) {
    //
}

pub fn instr16_C2_jit(ctx: &mut JitContext, imm16: u32) {
    ctx.builder.const_i32(0);
    codegen::gen_pop16(ctx);
    codegen::gen_add_cs_offset(ctx);
    ctx.builder
        .store_aligned_i32(global_pointers::instruction_pointer as u32);
    codegen::gen_adjust_stack_reg(ctx, imm16);
}

pub fn instr32_C2_jit(ctx: &mut JitContext, imm16: u32) {
    ctx.builder.const_i32(0);
    codegen::gen_pop32s(ctx);
    codegen::gen_add_cs_offset(ctx);
    ctx.builder
        .store_aligned_i32(global_pointers::instruction_pointer as u32);
    codegen::gen_adjust_stack_reg(ctx, imm16);
}

pub fn instr16_C3_jit(ctx: &mut JitContext) {
    ctx.builder.const_i32(0);
    codegen::gen_pop16(ctx);
    codegen::gen_add_cs_offset(ctx);
    ctx.builder
        .store_aligned_i32(global_pointers::instruction_pointer as u32);
}

pub fn instr32_C3_jit(ctx: &mut JitContext) {
    ctx.builder.const_i32(0);
    codegen::gen_pop32s(ctx);
    codegen::gen_add_cs_offset(ctx);
    ctx.builder
        .store_aligned_i32(global_pointers::instruction_pointer as u32);
}

pub fn instr16_C9_jit(ctx: &mut JitContext) { codegen::gen_leave(ctx, false); }
pub fn instr32_C9_jit(ctx: &mut JitContext) { codegen::gen_leave(ctx, true); }

pub fn gen_mov_reg8_imm(ctx: &mut JitContext, r: u32, imm: u32) {
    ctx.builder.const_i32(imm as i32);
    codegen::gen_set_reg8_unmasked(ctx, r);
}

pub fn instr_B0_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg8_imm(ctx, 0, imm) }
pub fn instr_B1_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg8_imm(ctx, 1, imm) }
pub fn instr_B2_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg8_imm(ctx, 2, imm) }
pub fn instr_B3_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg8_imm(ctx, 3, imm) }
pub fn instr_B4_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg8_imm(ctx, 4, imm) }
pub fn instr_B5_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg8_imm(ctx, 5, imm) }
pub fn instr_B6_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg8_imm(ctx, 6, imm) }
pub fn instr_B7_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg8_imm(ctx, 7, imm) }

pub fn gen_mov_reg16_imm(ctx: &mut JitContext, r: u32, imm: u32) {
    ctx.builder.const_i32(imm as i32);
    codegen::gen_set_reg16_unmasked(ctx, r);
}

pub fn instr16_B8_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg16_imm(ctx, 0, imm) }
pub fn instr16_B9_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg16_imm(ctx, 1, imm) }
pub fn instr16_BA_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg16_imm(ctx, 2, imm) }
pub fn instr16_BB_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg16_imm(ctx, 3, imm) }
pub fn instr16_BC_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg16_imm(ctx, 4, imm) }
pub fn instr16_BD_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg16_imm(ctx, 5, imm) }
pub fn instr16_BE_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg16_imm(ctx, 6, imm) }
pub fn instr16_BF_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg16_imm(ctx, 7, imm) }

pub fn gen_mov_reg32_imm(ctx: &mut JitContext, r: u32, imm: u32) {
    ctx.builder.const_i32(imm as i32);
    codegen::gen_set_reg32(ctx, r);
}

pub fn instr32_B8_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 0, imm) }
pub fn instr32_B9_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 1, imm) }
pub fn instr32_BA_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 2, imm) }
pub fn instr32_BB_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 3, imm) }
pub fn instr32_BC_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 4, imm) }
pub fn instr32_BD_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 5, imm) }
pub fn instr32_BE_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 6, imm) }
pub fn instr32_BF_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 7, imm) }

define_instruction_read_write_mem8!("rol8", instr_C0_0_mem_jit, instr_C0_0_reg_jit, imm8_5bits);
define_instruction_read_write_mem8!("ror8", instr_C0_1_mem_jit, instr_C0_1_reg_jit, imm8_5bits);
define_instruction_read_write_mem8!("rcl8", instr_C0_2_mem_jit, instr_C0_2_reg_jit, imm8_5bits);
define_instruction_read_write_mem8!("rcr8", instr_C0_3_mem_jit, instr_C0_3_reg_jit, imm8_5bits);
define_instruction_read_write_mem8!("shl8", instr_C0_4_mem_jit, instr_C0_4_reg_jit, imm8_5bits);
define_instruction_read_write_mem8!("shr8", instr_C0_5_mem_jit, instr_C0_5_reg_jit, imm8_5bits);
define_instruction_read_write_mem8!("shl8", instr_C0_6_mem_jit, instr_C0_6_reg_jit, imm8_5bits);
define_instruction_read_write_mem8!("sar8", instr_C0_7_mem_jit, instr_C0_7_reg_jit, imm8_5bits);

define_instruction_read_write_mem8!("rol8", instr_D0_0_mem_jit, instr_D0_0_reg_jit, constant_one);
define_instruction_read_write_mem8!("ror8", instr_D0_1_mem_jit, instr_D0_1_reg_jit, constant_one);
define_instruction_read_write_mem8!("rcl8", instr_D0_2_mem_jit, instr_D0_2_reg_jit, constant_one);
define_instruction_read_write_mem8!("rcr8", instr_D0_3_mem_jit, instr_D0_3_reg_jit, constant_one);
define_instruction_read_write_mem8!("shl8", instr_D0_4_mem_jit, instr_D0_4_reg_jit, constant_one);
define_instruction_read_write_mem8!("shr8", instr_D0_5_mem_jit, instr_D0_5_reg_jit, constant_one);
define_instruction_read_write_mem8!("shl8", instr_D0_6_mem_jit, instr_D0_6_reg_jit, constant_one);
define_instruction_read_write_mem8!("sar8", instr_D0_7_mem_jit, instr_D0_7_reg_jit, constant_one);

define_instruction_read_write_mem16!(
    "rol16",
    instr16_D1_0_mem_jit,
    instr16_D1_0_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    gen_rol32,
    instr32_D1_0_mem_jit,
    instr32_D1_0_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "ror16",
    instr16_D1_1_mem_jit,
    instr16_D1_1_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    gen_ror32,
    instr32_D1_1_mem_jit,
    instr32_D1_1_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "rcl16",
    instr16_D1_2_mem_jit,
    instr16_D1_2_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    gen_rcl32,
    instr32_D1_2_mem_jit,
    instr32_D1_2_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "rcr16",
    instr16_D1_3_mem_jit,
    instr16_D1_3_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    gen_rcr32,
    instr32_D1_3_mem_jit,
    instr32_D1_3_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "shl16",
    instr16_D1_4_mem_jit,
    instr16_D1_4_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    gen_shl32,
    instr32_D1_4_mem_jit,
    instr32_D1_4_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "shr16",
    instr16_D1_5_mem_jit,
    instr16_D1_5_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    gen_shr32,
    instr32_D1_5_mem_jit,
    instr32_D1_5_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "shl16",
    instr16_D1_6_mem_jit,
    instr16_D1_6_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    gen_shl32,
    instr32_D1_6_mem_jit,
    instr32_D1_6_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "sar16",
    instr16_D1_7_mem_jit,
    instr16_D1_7_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    gen_sar32,
    instr32_D1_7_mem_jit,
    instr32_D1_7_reg_jit,
    constant_one
);

define_instruction_read_write_mem8!("rol8", instr_D2_0_mem_jit, instr_D2_0_reg_jit, cl);
define_instruction_read_write_mem8!("ror8", instr_D2_1_mem_jit, instr_D2_1_reg_jit, cl);
define_instruction_read_write_mem8!("rcl8", instr_D2_2_mem_jit, instr_D2_2_reg_jit, cl);
define_instruction_read_write_mem8!("rcr8", instr_D2_3_mem_jit, instr_D2_3_reg_jit, cl);
define_instruction_read_write_mem8!("shl8", instr_D2_4_mem_jit, instr_D2_4_reg_jit, cl);
define_instruction_read_write_mem8!("shr8", instr_D2_5_mem_jit, instr_D2_5_reg_jit, cl);
define_instruction_read_write_mem8!("shl8", instr_D2_6_mem_jit, instr_D2_6_reg_jit, cl);
define_instruction_read_write_mem8!("sar8", instr_D2_7_mem_jit, instr_D2_7_reg_jit, cl);

define_instruction_read_write_mem16!("rol16", instr16_D3_0_mem_jit, instr16_D3_0_reg_jit, cl);
define_instruction_read_write_mem32!(gen_rol32, instr32_D3_0_mem_jit, instr32_D3_0_reg_jit, cl);

define_instruction_read_write_mem16!("ror16", instr16_D3_1_mem_jit, instr16_D3_1_reg_jit, cl);
define_instruction_read_write_mem32!(gen_ror32, instr32_D3_1_mem_jit, instr32_D3_1_reg_jit, cl);

define_instruction_read_write_mem16!("rcl16", instr16_D3_2_mem_jit, instr16_D3_2_reg_jit, cl);
define_instruction_read_write_mem32!(gen_rcl32, instr32_D3_2_mem_jit, instr32_D3_2_reg_jit, cl);

define_instruction_read_write_mem16!("rcr16", instr16_D3_3_mem_jit, instr16_D3_3_reg_jit, cl);
define_instruction_read_write_mem32!(gen_rcr32, instr32_D3_3_mem_jit, instr32_D3_3_reg_jit, cl);

define_instruction_read_write_mem16!("shl16", instr16_D3_4_mem_jit, instr16_D3_4_reg_jit, cl);
define_instruction_read_write_mem32!(gen_shl32, instr32_D3_4_mem_jit, instr32_D3_4_reg_jit, cl);

define_instruction_read_write_mem16!("shr16", instr16_D3_5_mem_jit, instr16_D3_5_reg_jit, cl);
define_instruction_read_write_mem32!(gen_shr32, instr32_D3_5_mem_jit, instr32_D3_5_reg_jit, cl);

define_instruction_read_write_mem16!("shl16", instr16_D3_6_mem_jit, instr16_D3_6_reg_jit, cl);
define_instruction_read_write_mem32!(gen_shl32, instr32_D3_6_mem_jit, instr32_D3_6_reg_jit, cl);

define_instruction_read_write_mem16!("sar16", instr16_D3_7_mem_jit, instr16_D3_7_reg_jit, cl);
define_instruction_read_write_mem32!(gen_sar32, instr32_D3_7_mem_jit, instr32_D3_7_reg_jit, cl);

pub fn instr_D7_jit(ctx: &mut JitContext) {
    if ctx.cpu.asize_32() {
        codegen::gen_get_reg32(ctx, regs::EBX);
    }
    else {
        codegen::gen_get_reg16(ctx, regs::BX);
    }
    codegen::gen_get_reg8(ctx, regs::AL);
    ctx.builder.add_i32();
    if !ctx.cpu.asize_32() {
        ctx.builder.const_i32(0xFFFF);
        ctx.builder.and_i32();
    }
    jit_add_seg_offset(ctx, regs::DS);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read8(ctx, &address_local);
    ctx.builder.free_local(address_local);
    codegen::gen_set_reg8(ctx, regs::AL);
}

fn instr_group_D8_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, op: &str) {
    ctx.builder.const_i32(0);
    codegen::gen_fpu_load_m32(ctx, modrm_byte);
    ctx.builder.call_fn3_i32_i64_i32(op)
}
fn instr_group_D8_reg_jit(ctx: &mut JitContext, r: u32, op: &str) {
    ctx.builder.const_i32(0);
    codegen::gen_fpu_get_sti(ctx, r);
    ctx.builder.call_fn3_i32_i64_i32(op)
}

pub fn instr_D8_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_D8_mem_jit(ctx, modrm_byte, "fpu_fadd")
}
pub fn instr_D8_0_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_D8_reg_jit(ctx, r, "fpu_fadd")
}
pub fn instr_D8_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_D8_mem_jit(ctx, modrm_byte, "fpu_fmul")
}
pub fn instr_D8_1_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_D8_reg_jit(ctx, r, "fpu_fmul")
}
pub fn instr_D8_2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_fpu_load_m32(ctx, modrm_byte);
    ctx.builder.call_fn2_i64_i32("fpu_fcom")
}
pub fn instr_D8_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fpu_get_sti(ctx, r);
    ctx.builder.call_fn2_i64_i32("fpu_fcom")
}
pub fn instr_D8_3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_fpu_load_m32(ctx, modrm_byte);
    ctx.builder.call_fn2_i64_i32("fpu_fcomp")
}
pub fn instr_D8_3_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fpu_get_sti(ctx, r);
    ctx.builder.call_fn2_i64_i32("fpu_fcomp")
}
pub fn instr_D8_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_D8_mem_jit(ctx, modrm_byte, "fpu_fsub")
}
pub fn instr_D8_4_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_D8_reg_jit(ctx, r, "fpu_fsub")
}
pub fn instr_D8_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_D8_mem_jit(ctx, modrm_byte, "fpu_fsubr")
}
pub fn instr_D8_5_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_D8_reg_jit(ctx, r, "fpu_fsubr")
}
pub fn instr_D8_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_D8_mem_jit(ctx, modrm_byte, "fpu_fdiv")
}
pub fn instr_D8_6_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_D8_reg_jit(ctx, r, "fpu_fdiv")
}
pub fn instr_D8_7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_D8_mem_jit(ctx, modrm_byte, "fpu_fdivr")
}
pub fn instr_D8_7_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_D8_reg_jit(ctx, r, "fpu_fdivr")
}

pub fn instr16_D9_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_fpu_load_m32(ctx, modrm_byte);
    ctx.builder.call_fn2_i64_i32("fpu_push");
}
pub fn instr16_D9_0_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fpu_get_sti(ctx, r);
    ctx.builder.call_fn2_i64_i32("fpu_push");
}
pub fn instr32_D9_0_reg_jit(ctx: &mut JitContext, r: u32) { instr16_D9_0_reg_jit(ctx, r) }
pub fn instr32_D9_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_D9_0_mem_jit(ctx, modrm_byte)
}

pub fn instr16_D9_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_trigger_ud(ctx);
}
pub fn instr16_D9_1_reg_jit(ctx: &mut JitContext, r: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn1("fpu_fxch");
}
pub fn instr32_D9_1_reg_jit(ctx: &mut JitContext, r: u32) { instr16_D9_1_reg_jit(ctx, r) }
pub fn instr32_D9_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_D9_1_mem_jit(ctx, modrm_byte)
}

pub fn instr16_D9_2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.call_fn2_i64_i32_ret("f80_to_f32");
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr16_D9_2_reg_jit(ctx: &mut JitContext, r: u32) {
    if r != 0 {
        codegen::gen_trigger_ud(ctx);
    }
}
pub fn instr32_D9_2_reg_jit(ctx: &mut JitContext, r: u32) { instr16_D9_2_reg_jit(ctx, r) }
pub fn instr32_D9_2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_D9_2_mem_jit(ctx, modrm_byte)
}

pub fn instr16_D9_3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.call_fn2_i64_i32_ret("f80_to_f32");
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop");
}
pub fn instr16_D9_3_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fstp", r);
}
pub fn instr32_D9_3_reg_jit(ctx: &mut JitContext, r: u32) { instr16_D9_3_reg_jit(ctx, r) }
pub fn instr32_D9_3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_D9_3_mem_jit(ctx, modrm_byte)
}

pub fn instr16_D9_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);

    codegen::gen_set_previous_eip_offset_from_eip_with_low_bits(
        ctx.builder,
        ctx.start_of_current_instruction as i32 & 0xFFF,
    );

    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1("fpu_fldenv32");
    codegen::gen_move_registers_from_memory_to_locals(ctx);

    codegen::gen_get_page_fault(ctx.builder);
    ctx.builder.if_void();
    codegen::gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.br(ctx.exit_label);
    ctx.builder.block_end();
}
pub fn instr16_D9_4_reg_jit(ctx: &mut JitContext, r: u32) {
    match r {
        0 | 1 | 4 | 5 => {
            ctx.builder.const_i32(r as i32);
            ctx.builder.call_fn1("instr16_D9_4_reg");
        },
        _ => codegen::gen_trigger_ud(ctx),
    }
}
pub fn instr32_D9_4_reg_jit(ctx: &mut JitContext, r: u32) { instr16_D9_4_reg_jit(ctx, r) }
pub fn instr32_D9_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_D9_4_mem_jit(ctx, modrm_byte)
}

pub fn instr16_D9_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    ctx.builder.call_fn1("set_control_word");
}
pub fn instr16_D9_5_reg_jit(ctx: &mut JitContext, r: u32) {
    if r == 7 {
        codegen::gen_trigger_ud(ctx);
    }
    else {
        codegen::gen_fn1_const(ctx.builder, "instr16_D9_5_reg", r);
    }
}
pub fn instr32_D9_5_reg_jit(ctx: &mut JitContext, r: u32) { instr16_D9_5_reg_jit(ctx, r) }
pub fn instr32_D9_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_D9_5_mem_jit(ctx, modrm_byte)
}

pub fn instr16_D9_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);

    codegen::gen_set_previous_eip_offset_from_eip_with_low_bits(
        ctx.builder,
        ctx.start_of_current_instruction as i32 & 0xFFF,
    );

    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1("fpu_fstenv32");
    codegen::gen_move_registers_from_memory_to_locals(ctx);

    codegen::gen_get_page_fault(ctx.builder);
    ctx.builder.if_void();
    codegen::gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.br(ctx.exit_label);
    ctx.builder.block_end();
}
pub fn instr16_D9_6_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr16_D9_6_reg", r);
}
pub fn instr32_D9_6_reg_jit(ctx: &mut JitContext, r: u32) { instr16_D9_6_reg_jit(ctx, r) }
pub fn instr32_D9_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_D9_6_mem_jit(ctx, modrm_byte)
}

pub fn instr16_D9_7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    ctx.builder
        .const_i32(global_pointers::fpu_control_word as i32);
    ctx.builder.load_aligned_u16(0);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write16(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr16_D9_7_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr16_D9_7_reg", r);
}
pub fn instr32_D9_7_reg_jit(ctx: &mut JitContext, r: u32) { instr16_D9_7_reg_jit(ctx, r) }
pub fn instr32_D9_7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_D9_7_mem_jit(ctx, modrm_byte)
}

pub fn instr_DA_0_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr_DA_0_reg", r);
}
pub fn instr_DA_1_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr_DA_1_reg", r);
}
pub fn instr_DA_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr_DA_2_reg", r);
}
pub fn instr_DA_3_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr_DA_3_reg", r);
}
pub fn instr_DA_4_reg_jit(ctx: &mut JitContext, _r: u32) { codegen::gen_trigger_ud(ctx) }
pub fn instr_DA_5_reg_jit(ctx: &mut JitContext, r: u32) {
    if r == 1 {
        codegen::gen_fn0_const(ctx.builder, "fpu_fucompp")
    }
    else {
        codegen::gen_trigger_ud(ctx)
    }
}
pub fn instr_DA_6_reg_jit(ctx: &mut JitContext, _r: u32) { codegen::gen_trigger_ud(ctx) }
pub fn instr_DA_7_reg_jit(ctx: &mut JitContext, _r: u32) { codegen::gen_trigger_ud(ctx) }

pub fn instr_group_DA_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, op: &str) {
    ctx.builder.const_i32(0);
    codegen::gen_fpu_load_i32(ctx, modrm_byte);
    ctx.builder.call_fn3_i32_i64_i32(op)
}
pub fn instr_DA_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DA_mem_jit(ctx, modrm_byte, "fpu_fadd")
}
pub fn instr_DA_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DA_mem_jit(ctx, modrm_byte, "fpu_fmul")
}
pub fn instr_DA_2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_fpu_load_i32(ctx, modrm_byte);
    ctx.builder.call_fn2_i64_i32("fpu_fcom")
}
pub fn instr_DA_3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_fpu_load_i32(ctx, modrm_byte);
    ctx.builder.call_fn2_i64_i32("fpu_fcomp")
}
pub fn instr_DA_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DA_mem_jit(ctx, modrm_byte, "fpu_fsub")
}
pub fn instr_DA_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DA_mem_jit(ctx, modrm_byte, "fpu_fsubr")
}
pub fn instr_DA_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DA_mem_jit(ctx, modrm_byte, "fpu_fdiv")
}
pub fn instr_DA_7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DA_mem_jit(ctx, modrm_byte, "fpu_fdivr")
}

pub fn instr_DB_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_fpu_load_i32(ctx, modrm_byte);
    ctx.builder.call_fn2_i64_i32("fpu_push");
}
pub fn instr_DB_0_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr_DB_0_reg", r);
}

pub fn instr_DB_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.call_fn2_i64_i32_ret("fpu_truncate_to_i32");
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop");
}
pub fn instr_DB_1_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr_DB_1_reg", r);
}

pub fn instr_DB_2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.call_fn2_i64_i32_ret("fpu_convert_to_i32");
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr_DB_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr_DB_2_reg", r);
}
pub fn instr_DB_3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.call_fn2_i64_i32_ret("fpu_convert_to_i32");
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop");
}
pub fn instr_DB_3_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr_DB_3_reg", r);
}

pub fn instr_DB_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);

    codegen::gen_set_previous_eip_offset_from_eip_with_low_bits(
        ctx.builder,
        ctx.start_of_current_instruction as i32 & 0xFFF,
    );

    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1("fpu_fldm80");
    codegen::gen_move_registers_from_memory_to_locals(ctx);

    codegen::gen_get_page_fault(ctx.builder);
    ctx.builder.if_void();
    codegen::gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.br(ctx.exit_label);
    ctx.builder.block_end();
}
pub fn instr_DB_5_reg_jit(ctx: &mut JitContext, r: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn1("fpu_fucomi");
}

pub fn instr_DB_6_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_DB_6_reg_jit(ctx: &mut JitContext, r: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn1("fpu_fcomi");
}

fn instr_group_DC_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, op: &str) {
    ctx.builder.const_i32(0);
    codegen::gen_fpu_load_m64(ctx, modrm_byte);
    ctx.builder.call_fn3_i32_i64_i32(op)
}
fn instr_group_DC_reg_jit(ctx: &mut JitContext, r: u32, op: &str) {
    ctx.builder.const_i32(r as i32);
    codegen::gen_fpu_get_sti(ctx, r);
    ctx.builder.call_fn3_i32_i64_i32(op)
}

pub fn instr_DC_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DC_mem_jit(ctx, modrm_byte, "fpu_fadd")
}
pub fn instr_DC_0_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DC_reg_jit(ctx, r, "fpu_fadd")
}
pub fn instr_DC_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DC_mem_jit(ctx, modrm_byte, "fpu_fmul")
}
pub fn instr_DC_1_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DC_reg_jit(ctx, r, "fpu_fmul")
}
pub fn instr_DC_2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_fpu_load_m64(ctx, modrm_byte);
    ctx.builder.call_fn2_i64_i32("fpu_fcom")
}
pub fn instr_DC_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fpu_get_sti(ctx, r);
    ctx.builder.call_fn2_i64_i32("fpu_fcom")
}
pub fn instr_DC_3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_fpu_load_m64(ctx, modrm_byte);
    ctx.builder.call_fn2_i64_i32("fpu_fcomp")
}
pub fn instr_DC_3_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fpu_get_sti(ctx, r);
    ctx.builder.call_fn2_i64_i32("fpu_fcomp")
}
pub fn instr_DC_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DC_mem_jit(ctx, modrm_byte, "fpu_fsub")
}
pub fn instr_DC_4_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DC_reg_jit(ctx, r, "fpu_fsub")
}
pub fn instr_DC_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DC_mem_jit(ctx, modrm_byte, "fpu_fsubr")
}
pub fn instr_DC_5_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DC_reg_jit(ctx, r, "fpu_fsubr")
}
pub fn instr_DC_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DC_mem_jit(ctx, modrm_byte, "fpu_fdiv")
}
pub fn instr_DC_6_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DC_reg_jit(ctx, r, "fpu_fdiv")
}
pub fn instr_DC_7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DC_mem_jit(ctx, modrm_byte, "fpu_fdivr")
}
pub fn instr_DC_7_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DC_reg_jit(ctx, r, "fpu_fdivr")
}

pub fn instr16_DD_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_fpu_load_m64(ctx, modrm_byte);
    ctx.builder.call_fn2_i64_i32("fpu_push");
}
pub fn instr16_DD_0_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_ffree", r);
}
pub fn instr32_DD_0_reg_jit(ctx: &mut JitContext, r: u32) { instr16_DD_0_reg_jit(ctx, r) }
pub fn instr32_DD_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_DD_0_mem_jit(ctx, modrm_byte)
}

pub fn instr16_DD_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.call_fn2_i64_i32_ret_i64("fpu_truncate_to_i64");
    let value_local = ctx.builder.set_new_local_i64();
    codegen::gen_safe_write64(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local_i64(value_local);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop");
}
pub fn instr16_DD_1_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fxch", r);
}
pub fn instr32_DD_1_reg_jit(ctx: &mut JitContext, r: u32) { instr16_DD_1_reg_jit(ctx, r) }
pub fn instr32_DD_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_DD_1_mem_jit(ctx, modrm_byte)
}

pub fn instr16_DD_2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.call_fn2_i64_i32_ret_i64("f80_to_f64");
    let value_local = ctx.builder.set_new_local_i64();
    codegen::gen_safe_write64(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local_i64(value_local);
}
pub fn instr16_DD_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fst", r);
}
pub fn instr32_DD_2_reg_jit(ctx: &mut JitContext, r: u32) { instr16_DD_2_reg_jit(ctx, r) }
pub fn instr32_DD_2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_DD_2_mem_jit(ctx, modrm_byte)
}

pub fn instr16_DD_3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.call_fn2_i64_i32_ret_i64("f80_to_f64");
    let value_local = ctx.builder.set_new_local_i64();
    codegen::gen_safe_write64(ctx, &address_local, &value_local);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop");
    ctx.builder.free_local(address_local);
    ctx.builder.free_local_i64(value_local);
}
pub fn instr16_DD_3_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fstp", r);
}
pub fn instr32_DD_3_reg_jit(ctx: &mut JitContext, r: u32) { instr16_DD_3_reg_jit(ctx, r) }
pub fn instr32_DD_3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_DD_3_mem_jit(ctx, modrm_byte)
}

pub fn instr16_DD_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_trigger_ud(ctx);
}
pub fn instr16_DD_5_reg_jit(ctx: &mut JitContext, r: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn1("fpu_fucomp");
}
pub fn instr32_DD_5_reg_jit(ctx: &mut JitContext, r: u32) { instr16_DD_5_reg_jit(ctx, r) }
pub fn instr32_DD_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_DD_5_mem_jit(ctx, modrm_byte)
}

fn instr_group_DE_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, op: &str) {
    ctx.builder.const_i32(0);
    codegen::gen_fpu_load_i16(ctx, modrm_byte);
    ctx.builder.call_fn3_i32_i64_i32(op)
}
fn instr_group_DE_reg_jit(ctx: &mut JitContext, r: u32, op: &str) {
    ctx.builder.const_i32(r as i32);
    codegen::gen_fpu_get_sti(ctx, r);
    ctx.builder.call_fn3_i32_i64_i32(op);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop")
}

pub fn instr_DE_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DE_mem_jit(ctx, modrm_byte, "fpu_fadd")
}
pub fn instr_DE_0_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DE_reg_jit(ctx, r, "fpu_fadd")
}
pub fn instr_DE_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DE_mem_jit(ctx, modrm_byte, "fpu_fmul")
}
pub fn instr_DE_1_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DE_reg_jit(ctx, r, "fpu_fmul")
}
pub fn instr_DE_2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_fpu_load_i16(ctx, modrm_byte);
    ctx.builder.call_fn2_i64_i32("fpu_fcom")
}
pub fn instr_DE_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fpu_get_sti(ctx, r);
    ctx.builder.call_fn2_i64_i32("fpu_fcom");
    codegen::gen_fn0_const(ctx.builder, "fpu_pop")
}
pub fn instr_DE_3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_fpu_load_i16(ctx, modrm_byte);
    ctx.builder.call_fn2_i64_i32("fpu_fcomp")
}
pub fn instr_DE_3_reg_jit(ctx: &mut JitContext, r: u32) {
    if r == 1 {
        codegen::gen_fpu_get_sti(ctx, r);
        ctx.builder.call_fn2_i64_i32("fpu_fcomp");
        codegen::gen_fn0_const(ctx.builder, "fpu_pop")
    }
    else {
        codegen::gen_trigger_ud(ctx);
    }
}
pub fn instr_DE_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DE_mem_jit(ctx, modrm_byte, "fpu_fsub")
}
pub fn instr_DE_4_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DE_reg_jit(ctx, r, "fpu_fsub")
}
pub fn instr_DE_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DE_mem_jit(ctx, modrm_byte, "fpu_fsubr")
}
pub fn instr_DE_5_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DE_reg_jit(ctx, r, "fpu_fsubr")
}
pub fn instr_DE_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DE_mem_jit(ctx, modrm_byte, "fpu_fdiv")
}
pub fn instr_DE_6_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DE_reg_jit(ctx, r, "fpu_fdiv")
}
pub fn instr_DE_7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr_group_DE_mem_jit(ctx, modrm_byte, "fpu_fdivr")
}
pub fn instr_DE_7_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DE_reg_jit(ctx, r, "fpu_fdivr")
}

pub fn instr_DF_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.call_fn2_i64_i32_ret("fpu_truncate_to_i16");
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write16(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop");
}
pub fn instr_DF_1_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fxch", r);
}

pub fn instr_DF_2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.call_fn2_i64_i32_ret("fpu_convert_to_i16");
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write16(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr_DF_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fstp", r);
}
pub fn instr_DF_3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.call_fn2_i64_i32_ret("fpu_convert_to_i16");
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write16(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop");
}
pub fn instr_DF_3_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fstp", r);
}

pub fn instr_DF_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    dbg_log!("fbld");
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_DF_4_reg_jit(ctx: &mut JitContext, r: u32) {
    if r == 0 {
        ctx.builder.call_fn0_ret("fpu_load_status_word");
        codegen::gen_set_reg16(ctx, regs::AX);
    }
    else {
        codegen::gen_trigger_ud(ctx);
    };
}

pub fn instr_DF_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_fpu_load_i64(ctx, modrm_byte);
    ctx.builder.call_fn2_i64_i32("fpu_push");
}
pub fn instr_DF_5_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fucomip", r);
}

pub fn instr_DF_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);

    codegen::gen_set_previous_eip_offset_from_eip_with_low_bits(
        ctx.builder,
        ctx.start_of_current_instruction as i32 & 0xFFF,
    );

    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1("fpu_fbstp");
    codegen::gen_move_registers_from_memory_to_locals(ctx);

    codegen::gen_get_page_fault(ctx.builder);
    ctx.builder.if_void();
    codegen::gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.br(ctx.exit_label);
    ctx.builder.block_end();
}
pub fn instr_DF_6_reg_jit(ctx: &mut JitContext, r: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn1("fpu_fcomip");
}

pub fn instr_DF_7_reg_jit(ctx: &mut JitContext, _r: u32) { codegen::gen_trigger_ud(ctx); }
pub fn instr_DF_7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.call_fn2_i64_i32_ret_i64("fpu_convert_to_i64");
    let value_local = ctx.builder.set_new_local_i64();
    codegen::gen_safe_write64(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local_i64(value_local);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop");
}

pub fn instr16_EB_jit(_ctx: &mut JitContext, _imm8: u32) {
    //
}

pub fn instr32_EB_jit(_ctx: &mut JitContext, _imm8: u32) {
    // jmp near
}

define_instruction_read8!(gen_test8, instr_F6_0_mem_jit, instr_F6_0_reg_jit, imm8);
define_instruction_read16!(
    gen_test16,
    instr16_F7_0_mem_jit,
    instr16_F7_0_reg_jit,
    imm16
);
define_instruction_read32!(
    gen_test32,
    instr32_F7_0_mem_jit,
    instr32_F7_0_reg_jit,
    imm32
);

pub fn instr_F6_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm: u32) {
    instr_F6_0_mem_jit(ctx, modrm_byte, imm)
}
pub fn instr_F6_1_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    instr_F6_0_reg_jit(ctx, r, imm)
}
pub fn instr16_F7_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm: u32) {
    instr16_F7_0_mem_jit(ctx, modrm_byte, imm)
}
pub fn instr16_F7_1_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    instr16_F7_0_reg_jit(ctx, r, imm)
}
pub fn instr32_F7_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm: u32) {
    instr32_F7_0_mem_jit(ctx, modrm_byte, imm)
}
pub fn instr32_F7_1_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    instr32_F7_0_reg_jit(ctx, r, imm)
}

define_instruction_read_write_mem8!("not8", instr_F6_2_mem_jit, instr_F6_2_reg_jit, none);
define_instruction_read_write_mem8!("neg8", instr_F6_3_mem_jit, instr_F6_3_reg_jit, none);

define_instruction_read_write_mem16!(gen_not16, instr16_F7_2_mem_jit, instr16_F7_2_reg_jit, none);
define_instruction_read_write_mem32!(gen_not32, instr32_F7_2_mem_jit, instr32_F7_2_reg_jit, none);
define_instruction_read_write_mem16!(gen_neg16, instr16_F7_3_mem_jit, instr16_F7_3_reg_jit, none);
define_instruction_read_write_mem32!(gen_neg32, instr32_F7_3_mem_jit, instr32_F7_3_reg_jit, none);

pub fn instr16_F7_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1("mul16");
    codegen::gen_move_registers_from_memory_to_locals(ctx);
}
pub fn instr16_F7_4_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg16(ctx, r);
    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1("mul16");
    codegen::gen_move_registers_from_memory_to_locals(ctx);
}
pub fn instr32_F7_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    gen_mul32(ctx);
}
pub fn instr32_F7_4_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg32(ctx, r);
    gen_mul32(ctx);
}

pub fn instr16_F7_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    codegen::sign_extend_i16(ctx.builder);
    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1("imul16");
    codegen::gen_move_registers_from_memory_to_locals(ctx);
}
pub fn instr16_F7_5_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg16(ctx, r);
    codegen::sign_extend_i16(ctx.builder);
    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1("imul16");
    codegen::gen_move_registers_from_memory_to_locals(ctx);
}
pub fn instr32_F7_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    gen_imul32(ctx);
}
pub fn instr32_F7_5_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg32(ctx, r);
    gen_imul32(ctx);
}

pub fn instr16_F7_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1_ret("div16_without_fault");
    codegen::gen_move_registers_from_memory_to_locals(ctx);
    ctx.builder.eqz_i32();
    ctx.builder.if_void();
    codegen::gen_trigger_de(ctx);
    ctx.builder.block_end();
}
pub fn instr16_F7_6_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg16(ctx, r);
    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1_ret("div16_without_fault");
    codegen::gen_move_registers_from_memory_to_locals(ctx);
    ctx.builder.eqz_i32();
    ctx.builder.if_void();
    codegen::gen_trigger_de(ctx);
    ctx.builder.block_end();
}

pub fn instr32_F7_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    if false {
        codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
        codegen::gen_move_registers_from_locals_to_memory(ctx);
        ctx.builder.call_fn1_ret("div32_without_fault");
        codegen::gen_move_registers_from_memory_to_locals(ctx);
        ctx.builder.eqz_i32();
        ctx.builder.if_void();
        codegen::gen_trigger_de(ctx);
        ctx.builder.block_end();
    }
    else {
        codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
        let source_operand = ctx.builder.set_new_local();
        gen_div32(ctx, &source_operand);
        ctx.builder.free_local(source_operand);
    }
}
pub fn instr32_F7_6_reg_jit(ctx: &mut JitContext, r: u32) {
    if false {
        codegen::gen_get_reg32(ctx, r);
        codegen::gen_move_registers_from_locals_to_memory(ctx);
        ctx.builder.call_fn1_ret("div32_without_fault");
        codegen::gen_move_registers_from_memory_to_locals(ctx);
        ctx.builder.eqz_i32();
        ctx.builder.if_void();
        codegen::gen_trigger_de(ctx);
        ctx.builder.block_end();
    }
    else {
        gen_div32(ctx, &ctx.reg(r));
    }
}

pub fn instr16_F7_7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    codegen::sign_extend_i16(ctx.builder);
    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1_ret("idiv16_without_fault");
    codegen::gen_move_registers_from_memory_to_locals(ctx);
    ctx.builder.eqz_i32();
    ctx.builder.if_void();
    codegen::gen_trigger_de(ctx);
    ctx.builder.block_end();
}
pub fn instr16_F7_7_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg16(ctx, r);
    codegen::sign_extend_i16(ctx.builder);
    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1_ret("idiv16_without_fault");
    codegen::gen_move_registers_from_memory_to_locals(ctx);
    ctx.builder.eqz_i32();
    ctx.builder.if_void();
    codegen::gen_trigger_de(ctx);
    ctx.builder.block_end();
}
pub fn instr32_F7_7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1_ret("idiv32_without_fault");
    codegen::gen_move_registers_from_memory_to_locals(ctx);
    ctx.builder.eqz_i32();
    ctx.builder.if_void();
    codegen::gen_trigger_de(ctx);
    ctx.builder.block_end();
}
pub fn instr32_F7_7_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg32(ctx, r);
    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1_ret("idiv32_without_fault");
    codegen::gen_move_registers_from_memory_to_locals(ctx);
    ctx.builder.eqz_i32();
    ctx.builder.if_void();
    codegen::gen_trigger_de(ctx);
    ctx.builder.block_end();
}

pub fn instr_F8_jit(ctx: &mut JitContext) {
    codegen::gen_clear_flags_changed_bits(ctx.builder, 1);
    codegen::gen_clear_flags_bits(ctx.builder, 1);
}
pub fn instr_F9_jit(ctx: &mut JitContext) {
    codegen::gen_clear_flags_changed_bits(ctx.builder, 1);
    codegen::gen_set_flags_bits(ctx.builder, 1);
}

pub fn instr_FA_jit(ctx: &mut JitContext) {
    ctx.builder.call_fn0_ret("instr_FA_without_fault");
    ctx.builder.eqz_i32();
    ctx.builder.if_void();
    codegen::gen_trigger_gp(ctx, 0);
    ctx.builder.block_end();
}

pub fn instr_FB_jit(ctx: &mut JitContext) {
    ctx.builder.call_fn0_ret("instr_FB_without_fault");
    ctx.builder.eqz_i32();
    ctx.builder.if_void();
    codegen::gen_trigger_gp(ctx, 0);
    ctx.builder.block_end();
    // handle_irqs is specially handled in jit to be called one instruction after this one
}

pub fn instr_FC_jit(ctx: &mut JitContext) {
    ctx.builder.const_i32(global_pointers::flags as i32);
    codegen::gen_get_flags(ctx.builder);
    ctx.builder.const_i32(!FLAG_DIRECTION);
    ctx.builder.and_i32();
    ctx.builder.store_aligned_i32(0);
}

pub fn instr_FD_jit(ctx: &mut JitContext) {
    ctx.builder.const_i32(global_pointers::flags as i32);
    codegen::gen_get_flags(ctx.builder);
    ctx.builder.const_i32(FLAG_DIRECTION);
    ctx.builder.or_i32();
    ctx.builder.store_aligned_i32(0);
}

define_instruction_read_write_mem8!("inc8", instr_FE_0_mem_jit, instr_FE_0_reg_jit, none);
define_instruction_read_write_mem8!("dec8", instr_FE_1_mem_jit, instr_FE_1_reg_jit, none);

define_instruction_read_write_mem16!(gen_inc16, instr16_FF_0_mem_jit, instr16_FF_0_reg_jit, none);
define_instruction_read_write_mem32!(gen_inc32, instr32_FF_0_mem_jit, instr32_FF_0_reg_jit, none);

define_instruction_read_write_mem16!(gen_dec16, instr16_FF_1_mem_jit, instr16_FF_1_reg_jit, none);
define_instruction_read_write_mem32!(gen_dec32, instr32_FF_1_mem_jit, instr32_FF_1_reg_jit, none);

pub fn instr16_FF_2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    codegen::gen_add_cs_offset(ctx);
    let new_eip = ctx.builder.set_new_local();

    codegen::gen_get_real_eip(ctx);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &value_local);
    ctx.builder.free_local(value_local);

    ctx.builder.const_i32(0);
    ctx.builder.get_local(&new_eip);
    ctx.builder
        .store_aligned_i32(global_pointers::instruction_pointer as u32);
    ctx.builder.free_local(new_eip);
}
pub fn instr16_FF_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_real_eip(ctx);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &value_local);
    ctx.builder.free_local(value_local);

    ctx.builder.const_i32(0);
    codegen::gen_get_reg16(ctx, r);
    codegen::gen_add_cs_offset(ctx);
    ctx.builder
        .store_aligned_i32(global_pointers::instruction_pointer as u32);
}
pub fn instr32_FF_2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    codegen::gen_add_cs_offset(ctx);
    let new_eip = ctx.builder.set_new_local();

    codegen::gen_get_real_eip(ctx);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push32(ctx, &value_local);
    ctx.builder.free_local(value_local);

    ctx.builder.const_i32(0);
    ctx.builder.get_local(&new_eip);
    ctx.builder
        .store_aligned_i32(global_pointers::instruction_pointer as u32);
    ctx.builder.free_local(new_eip);
}
pub fn instr32_FF_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_real_eip(ctx);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push32(ctx, &value_local);
    ctx.builder.free_local(value_local);

    ctx.builder.const_i32(0);
    codegen::gen_get_reg32(ctx, r);
    codegen::gen_add_cs_offset(ctx);
    ctx.builder
        .store_aligned_i32(global_pointers::instruction_pointer as u32);
}

pub fn instr16_FF_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    ctx.builder.const_i32(0);
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    codegen::gen_add_cs_offset(ctx);
    ctx.builder
        .store_aligned_i32(global_pointers::instruction_pointer as u32);
}
pub fn instr16_FF_4_reg_jit(ctx: &mut JitContext, r: u32) {
    ctx.builder.const_i32(0);
    codegen::gen_get_reg16(ctx, r);
    codegen::gen_add_cs_offset(ctx);
    ctx.builder
        .store_aligned_i32(global_pointers::instruction_pointer as u32);
}
pub fn instr32_FF_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    ctx.builder.const_i32(0);
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    codegen::gen_add_cs_offset(ctx);
    ctx.builder
        .store_aligned_i32(global_pointers::instruction_pointer as u32);
}
pub fn instr32_FF_4_reg_jit(ctx: &mut JitContext, r: u32) {
    ctx.builder.const_i32(0);
    codegen::gen_get_reg32(ctx, r);
    codegen::gen_add_cs_offset(ctx);
    ctx.builder
        .store_aligned_i32(global_pointers::instruction_pointer as u32);
}

pub fn instr16_FF_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    push16_mem_jit(ctx, modrm_byte)
}
pub fn instr16_FF_6_reg_jit(ctx: &mut JitContext, r: u32) { push16_reg_jit(ctx, r) }
pub fn instr32_FF_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    push32_mem_jit(ctx, modrm_byte)
}
pub fn instr32_FF_6_reg_jit(ctx: &mut JitContext, r: u32) { push32_reg_jit(ctx, r) }

// Code for conditional jumps is generated automatically by the basic block codegen
pub fn instr16_0F80_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F81_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F82_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F83_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F84_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F85_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F86_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F87_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F88_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F89_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F8A_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F8B_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F8C_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F8D_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F8E_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr16_0F8F_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F80_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F81_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F82_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F83_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F84_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F85_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F86_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F87_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F88_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F89_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F8A_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F8B_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F8C_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F8D_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F8E_jit(_ctx: &mut JitContext, _imm: u32) {}
pub fn instr32_0F8F_jit(_ctx: &mut JitContext, _imm: u32) {}

pub fn instr_90_jit(_ctx: &mut JitContext) {}

fn gen_xchg_reg16(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg16(ctx, r);
    let tmp = ctx.builder.set_new_local();
    codegen::gen_get_reg16(ctx, regs::AX);
    codegen::gen_set_reg16(ctx, r);
    ctx.builder.get_local(&tmp);
    codegen::gen_set_reg16(ctx, regs::AX);
    ctx.builder.free_local(tmp);
}

fn gen_xchg_reg32(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg32(ctx, r);
    let tmp = ctx.builder.set_new_local();
    codegen::gen_get_reg32(ctx, regs::EAX);
    codegen::gen_set_reg32(ctx, r);
    ctx.builder.get_local(&tmp);
    codegen::gen_set_reg32(ctx, regs::EAX);
    ctx.builder.free_local(tmp);
}

pub fn instr16_91_jit(ctx: &mut JitContext) { gen_xchg_reg16(ctx, regs::CX); }
pub fn instr16_92_jit(ctx: &mut JitContext) { gen_xchg_reg16(ctx, regs::DX); }
pub fn instr16_93_jit(ctx: &mut JitContext) { gen_xchg_reg16(ctx, regs::BX); }
pub fn instr16_94_jit(ctx: &mut JitContext) { gen_xchg_reg16(ctx, regs::SP); }
pub fn instr16_95_jit(ctx: &mut JitContext) { gen_xchg_reg16(ctx, regs::BP); }
pub fn instr16_96_jit(ctx: &mut JitContext) { gen_xchg_reg16(ctx, regs::SI); }
pub fn instr16_97_jit(ctx: &mut JitContext) { gen_xchg_reg16(ctx, regs::DI); }

pub fn instr32_91_jit(ctx: &mut JitContext) { gen_xchg_reg32(ctx, regs::CX); }
pub fn instr32_92_jit(ctx: &mut JitContext) { gen_xchg_reg32(ctx, regs::DX); }
pub fn instr32_93_jit(ctx: &mut JitContext) { gen_xchg_reg32(ctx, regs::BX); }
pub fn instr32_94_jit(ctx: &mut JitContext) { gen_xchg_reg32(ctx, regs::SP); }
pub fn instr32_95_jit(ctx: &mut JitContext) { gen_xchg_reg32(ctx, regs::BP); }
pub fn instr32_96_jit(ctx: &mut JitContext) { gen_xchg_reg32(ctx, regs::SI); }
pub fn instr32_97_jit(ctx: &mut JitContext) { gen_xchg_reg32(ctx, regs::DI); }

pub fn instr16_98_jit(ctx: &mut JitContext) {
    codegen::gen_get_reg32(ctx, regs::EAX);
    codegen::sign_extend_i8(ctx.builder);
    codegen::gen_set_reg16(ctx, regs::AX);
}
pub fn instr32_98_jit(ctx: &mut JitContext) {
    codegen::gen_get_reg32(ctx, regs::EAX);
    codegen::sign_extend_i16(ctx.builder);
    codegen::gen_set_reg32(ctx, regs::EAX);
}

pub fn instr16_99_jit(ctx: &mut JitContext) {
    codegen::gen_get_reg16(ctx, regs::AX);
    ctx.builder.const_i32(16);
    ctx.builder.shl_i32();
    ctx.builder.const_i32(31);
    ctx.builder.shr_s_i32();
    codegen::gen_set_reg16(ctx, regs::DX);
}
pub fn instr32_99_jit(ctx: &mut JitContext) {
    codegen::gen_get_reg32(ctx, regs::EAX);
    ctx.builder.const_i32(31);
    ctx.builder.shr_s_i32();
    codegen::gen_set_reg32(ctx, regs::EDX);
}

fn gen_pushf_popf_check(ctx: &mut JitContext) {
    // 0 != *flags & FLAG_VM && getiopl() < 3
    codegen::gen_get_flags(ctx.builder);
    ctx.builder.const_i32(FLAG_VM);
    ctx.builder.and_i32();
    ctx.builder.const_i32(FLAG_VM);
    ctx.builder.eq_i32();
    codegen::gen_get_flags(ctx.builder);
    ctx.builder.const_i32(FLAG_IOPL);
    ctx.builder.and_i32();
    ctx.builder.const_i32(FLAG_IOPL);
    ctx.builder.ne_i32();
    ctx.builder.and_i32();
}

pub fn instr16_9C_jit(ctx: &mut JitContext) {
    gen_pushf_popf_check(ctx);
    ctx.builder.if_void();
    codegen::gen_trigger_gp(ctx, 0);
    ctx.builder.else_();
    ctx.builder.call_fn0_ret("get_eflags");
    let value = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &value);
    ctx.builder.block_end();
    ctx.builder.free_local(value);
}
pub fn instr32_9C_jit(ctx: &mut JitContext) {
    gen_pushf_popf_check(ctx);
    ctx.builder.if_void();
    codegen::gen_trigger_gp(ctx, 0);
    ctx.builder.else_();
    ctx.builder.call_fn0_ret("get_eflags");
    ctx.builder.const_i32(0xFCFFFF);
    ctx.builder.and_i32();
    let value = ctx.builder.set_new_local();
    codegen::gen_push32(ctx, &value);
    ctx.builder.block_end();
    ctx.builder.free_local(value);
}

fn gen_popf(ctx: &mut JitContext, is_32: bool) {
    gen_pushf_popf_check(ctx);
    ctx.builder.if_void();
    codegen::gen_trigger_gp(ctx, 0);
    ctx.builder.else_();

    codegen::gen_get_flags(ctx.builder);
    let old_eflags = ctx.builder.set_new_local();

    if is_32 {
        codegen::gen_pop32s(ctx);
    }
    else {
        ctx.builder.get_local(&old_eflags);
        ctx.builder.const_i32(!0xFFFF);
        ctx.builder.and_i32();
        codegen::gen_pop16(ctx);
        ctx.builder.or_i32();
    }

    ctx.builder.call_fn1("update_eflags");

    ctx.builder.get_local(&old_eflags);
    ctx.builder.free_local(old_eflags);
    ctx.builder.const_i32(FLAG_INTERRUPT);
    ctx.builder.and_i32();
    ctx.builder.eqz_i32();

    codegen::gen_get_flags(ctx.builder);
    ctx.builder.const_i32(FLAG_INTERRUPT);
    ctx.builder.and_i32();
    ctx.builder.eqz_i32();
    ctx.builder.eqz_i32();

    ctx.builder.and_i32();
    ctx.builder.if_void();
    {
        codegen::gen_set_eip_to_after_current_instruction(ctx);
        codegen::gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
        codegen::gen_move_registers_from_locals_to_memory(ctx);
        codegen::gen_fn0_const(ctx.builder, "handle_irqs");

        codegen::gen_update_instruction_counter(ctx);
        ctx.builder.return_();
    }
    ctx.builder.block_end();

    ctx.builder.block_end();
}

pub fn instr16_9D_jit(ctx: &mut JitContext) { gen_popf(ctx, false) }
pub fn instr32_9D_jit(ctx: &mut JitContext) { gen_popf(ctx, true) }

pub fn instr_9E_jit(ctx: &mut JitContext) {
    ctx.builder.const_i32(global_pointers::flags as i32);
    codegen::gen_get_flags(ctx.builder);
    ctx.builder.const_i32(!0xFF);
    ctx.builder.and_i32();
    codegen::gen_get_reg8(ctx, regs::AH);
    ctx.builder.or_i32();
    ctx.builder.const_i32(FLAGS_MASK);
    ctx.builder.and_i32();
    ctx.builder.const_i32(FLAGS_DEFAULT);
    ctx.builder.or_i32();
    ctx.builder.store_aligned_i32(0);

    codegen::gen_clear_flags_changed_bits(ctx.builder, 0xFF);
}

pub fn instr_9F_jit(ctx: &mut JitContext) {
    ctx.builder.call_fn0_ret("get_eflags");
    codegen::gen_set_reg8(ctx, regs::AH);
}

pub fn instr_A0_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read8(ctx, &address_local);
    ctx.builder.free_local(address_local);
    codegen::gen_set_reg8(ctx, regs::AL);
}
pub fn instr16_A1_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read16(ctx, &address_local);
    ctx.builder.free_local(address_local);
    codegen::gen_set_reg16(ctx, regs::AX);
}
pub fn instr32_A1_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read32(ctx, &address_local);
    ctx.builder.free_local(address_local);
    codegen::gen_set_reg32(ctx, regs::EAX);
}

pub fn instr_A2_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_write8(ctx, &address_local, &ctx.reg(regs::EAX));
    ctx.builder.free_local(address_local);
}
pub fn instr16_A3_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_write16(ctx, &address_local, &ctx.reg(regs::EAX));
    ctx.builder.free_local(address_local);
}
pub fn instr32_A3_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &ctx.reg(regs::EAX));
    ctx.builder.free_local(address_local);
}

pub fn instr_A8_jit(ctx: &mut JitContext, imm8: u32) {
    gen_test8(ctx, &ctx.reg(0), &LocalOrImmediate::Immediate(imm8 as i32));
}

pub fn instr16_A9_jit(ctx: &mut JitContext, imm16: u32) {
    gen_test16(ctx, &ctx.reg(0), &LocalOrImmediate::Immediate(imm16 as i32));
}

pub fn instr32_A9_jit(ctx: &mut JitContext, imm32: u32) {
    gen_test32(ctx, &ctx.reg(0), &LocalOrImmediate::Immediate(imm32 as i32));
}

#[derive(PartialEq)]
enum String {
    INS,
    OUTS,
    MOVS,
    CMPS,
    STOS,
    LODS,
    SCAS,
}
fn gen_string_ins(ctx: &mut JitContext, ins: String, size: u8, prefix: u8) {
    dbg_assert!(prefix == 0 || prefix == 0xF2 || prefix == 0xF3);
    dbg_assert!(size == 8 || size == 16 || size == 32);

    if prefix == 0 {
        fn get_direction(ctx: &mut JitContext, size: u8) {
            let bytes: i32 = (size / 8).into();
            dbg_assert!(bytes == 1 || bytes == 2 || bytes == 4);
            ctx.builder.const_i32(-bytes);
            ctx.builder.const_i32(bytes);
            codegen::gen_get_flags(ctx.builder);
            ctx.builder.const_i32(FLAG_DIRECTION);
            ctx.builder.and_i32();
            ctx.builder.select();
        }

        match &ins {
            String::LODS => {
                if ctx.cpu.asize_32() {
                    codegen::gen_get_reg32(ctx, regs::ESI);
                }
                else {
                    codegen::gen_get_reg16(ctx, regs::ESI);
                }
                jit_add_seg_offset(ctx, regs::DS);
                let address_local = ctx.builder.set_new_local();
                if size == 8 {
                    codegen::gen_safe_read8(ctx, &address_local);
                    ctx.builder.free_local(address_local);
                    codegen::gen_set_reg8_unmasked(ctx, regs::AL);
                }
                else if size == 16 {
                    codegen::gen_safe_read16(ctx, &address_local);
                    ctx.builder.free_local(address_local);
                    codegen::gen_set_reg16(ctx, regs::AX);
                }
                else {
                    codegen::gen_safe_read32(ctx, &address_local);
                    ctx.builder.free_local(address_local);
                    codegen::gen_set_reg32(ctx, regs::EAX);
                }

                codegen::gen_get_reg32(ctx, regs::ESI);
                get_direction(ctx, size);
                ctx.builder.add_i32();
                if ctx.cpu.asize_32() {
                    codegen::gen_set_reg32(ctx, regs::ESI);
                }
                else {
                    codegen::gen_set_reg16(ctx, regs::ESI);
                }
                return;
            },
            String::SCAS => {
                if ctx.cpu.asize_32() {
                    codegen::gen_get_reg32(ctx, regs::EDI);
                }
                else {
                    codegen::gen_get_reg16(ctx, regs::EDI);
                }
                jit_add_seg_offset_no_override(ctx, regs::ES);
                let address_local = ctx.builder.set_new_local();
                if size == 8 {
                    codegen::gen_safe_read8(ctx, &address_local);
                    ctx.builder.free_local(address_local);
                    let value = ctx.builder.set_new_local();
                    gen_cmp8(
                        ctx,
                        &ctx.reg(regs::EAX),
                        &LocalOrImmediate::WasmLocal(&value),
                    );
                    ctx.builder.free_local(value);
                }
                else if size == 16 {
                    codegen::gen_safe_read16(ctx, &address_local);
                    ctx.builder.free_local(address_local);
                    let value = ctx.builder.set_new_local();
                    gen_cmp16(
                        ctx,
                        &ctx.reg(regs::EAX),
                        &LocalOrImmediate::WasmLocal(&value),
                    );
                    ctx.builder.free_local(value);
                }
                else {
                    codegen::gen_safe_read32(ctx, &address_local);
                    ctx.builder.free_local(address_local);
                    let value = ctx.builder.set_new_local();
                    gen_cmp32(
                        ctx,
                        &ctx.reg(regs::EAX),
                        &LocalOrImmediate::WasmLocal(&value),
                    );
                    ctx.builder.free_local(value);
                }

                codegen::gen_get_reg32(ctx, regs::EDI);
                get_direction(ctx, size);
                ctx.builder.add_i32();
                if ctx.cpu.asize_32() {
                    codegen::gen_set_reg32(ctx, regs::EDI);
                }
                else {
                    codegen::gen_set_reg16(ctx, regs::EDI);
                }
                return;
            },
            String::STOS => {
                if ctx.cpu.asize_32() {
                    codegen::gen_get_reg32(ctx, regs::EDI);
                }
                else {
                    codegen::gen_get_reg16(ctx, regs::EDI);
                }
                jit_add_seg_offset_no_override(ctx, regs::ES);
                let address_local = ctx.builder.set_new_local();
                if size == 8 {
                    codegen::gen_safe_write8(ctx, &address_local, &ctx.reg(regs::AL));
                    ctx.builder.free_local(address_local);
                }
                else if size == 16 {
                    codegen::gen_safe_write16(ctx, &address_local, &ctx.reg(regs::AX));
                    ctx.builder.free_local(address_local);
                }
                else {
                    codegen::gen_safe_write32(ctx, &address_local, &ctx.reg(regs::EAX));
                    ctx.builder.free_local(address_local);
                }

                codegen::gen_get_reg32(ctx, regs::EDI);
                get_direction(ctx, size);
                ctx.builder.add_i32();
                if ctx.cpu.asize_32() {
                    codegen::gen_set_reg32(ctx, regs::EDI);
                }
                else {
                    codegen::gen_set_reg16(ctx, regs::EDI);
                }
                return;
            },
            String::MOVS => {
                if ctx.cpu.asize_32() {
                    codegen::gen_get_reg32(ctx, regs::EDI);
                }
                else {
                    codegen::gen_get_reg16(ctx, regs::EDI);
                }
                jit_add_seg_offset_no_override(ctx, regs::ES);
                let dest_address = ctx.builder.set_new_local();

                if ctx.cpu.asize_32() {
                    codegen::gen_get_reg32(ctx, regs::ESI);
                }
                else {
                    codegen::gen_get_reg16(ctx, regs::ESI);
                }
                jit_add_seg_offset(ctx, regs::DS);
                let source_address = ctx.builder.set_new_local();

                if size == 8 {
                    codegen::gen_safe_read8(ctx, &source_address);
                    ctx.builder.free_local(source_address);
                    let value = ctx.builder.set_new_local();
                    codegen::gen_safe_write8(ctx, &dest_address, &value);
                    ctx.builder.free_local(value);
                }
                else if size == 16 {
                    codegen::gen_safe_read16(ctx, &source_address);
                    ctx.builder.free_local(source_address);
                    let value = ctx.builder.set_new_local();
                    codegen::gen_safe_write16(ctx, &dest_address, &value);
                    ctx.builder.free_local(value);
                }
                else {
                    codegen::gen_safe_read32(ctx, &source_address);
                    ctx.builder.free_local(source_address);
                    let value = ctx.builder.set_new_local();
                    codegen::gen_safe_write32(ctx, &dest_address, &value);
                    ctx.builder.free_local(value);
                }

                ctx.builder.free_local(dest_address);

                codegen::gen_get_reg32(ctx, regs::EDI);
                get_direction(ctx, size);
                ctx.builder.add_i32();
                if ctx.cpu.asize_32() {
                    codegen::gen_set_reg32(ctx, regs::EDI);
                }
                else {
                    codegen::gen_set_reg16(ctx, regs::EDI);
                }

                codegen::gen_get_reg32(ctx, regs::ESI);
                get_direction(ctx, size);
                ctx.builder.add_i32();
                if ctx.cpu.asize_32() {
                    codegen::gen_set_reg32(ctx, regs::ESI);
                }
                else {
                    codegen::gen_set_reg16(ctx, regs::ESI);
                }
                return;
            },
            _ => {},
        }
    }

    let mut args = 0;
    args += 1;
    ctx.builder.const_i32(ctx.cpu.asize_32() as i32);

    if ins == String::OUTS || ins == String::CMPS || ins == String::LODS || ins == String::MOVS {
        // TODO: check es/ds is null (only if rep && count!=0)
        args += 1;
        let prefix = ctx.cpu.prefixes & PREFIX_MASK_SEGMENT;
        dbg_assert!(prefix != SEG_PREFIX_ZERO);
        let seg = if prefix != 0 { (prefix - 1) as u32 } else { regs::DS };
        ctx.builder.const_i32(seg as i32);
    }

    let name = format!(
        "{}{}{}",
        match ins {
            String::INS => "ins",
            String::OUTS => "outs",
            String::MOVS => "movs",
            String::CMPS => "cmps",
            String::STOS => "stos",
            String::LODS => "lods",
            String::SCAS => "scas",
        },
        if size == 8 {
            "b"
        }
        else if size == 16 {
            "w"
        }
        else {
            "d"
        },
        if prefix == 0xF2 || prefix == 0xF3 {
            match ins {
                String::CMPS | String::SCAS => {
                    if prefix == 0xF2 {
                        "_repnz"
                    }
                    else {
                        "_repz"
                    }
                },
                _ => "_rep",
            }
        }
        else {
            "_no_rep"
        }
    );

    codegen::gen_move_registers_from_locals_to_memory(ctx);
    if args == 1 {
        ctx.builder.call_fn1(&name)
    }
    else if args == 2 {
        ctx.builder.call_fn2(&name)
    }
    else {
        dbg_assert!(false);
    }
    codegen::gen_move_registers_from_memory_to_locals(ctx);
}

pub fn instr_6C_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::INS, 8, 0) }
pub fn instr_F26C_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::INS, 8, 0xF2) }
pub fn instr_F36C_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::INS, 8, 0xF3) }
pub fn instr16_6D_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::INS, 16, 0) }
pub fn instr16_F26D_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::INS, 16, 0xF2) }
pub fn instr16_F36D_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::INS, 16, 0xF3) }
pub fn instr32_6D_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::INS, 32, 0) }
pub fn instr32_F26D_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::INS, 32, 0xF2) }
pub fn instr32_F36D_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::INS, 32, 0xF3) }
pub fn instr_6E_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::OUTS, 8, 0) }
pub fn instr_F26E_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::OUTS, 8, 0xF2) }
pub fn instr_F36E_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::OUTS, 8, 0xF3) }
pub fn instr16_6F_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::OUTS, 16, 0) }
pub fn instr16_F26F_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::OUTS, 16, 0xF2) }
pub fn instr16_F36F_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::OUTS, 16, 0xF3) }
pub fn instr32_6F_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::OUTS, 32, 0) }
pub fn instr32_F26F_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::OUTS, 32, 0xF2) }
pub fn instr32_F36F_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::OUTS, 32, 0xF3) }
pub fn instr_A4_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::MOVS, 8, 0) }
pub fn instr_F2A4_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::MOVS, 8, 0xF2) }
pub fn instr_F3A4_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::MOVS, 8, 0xF3) }
pub fn instr16_A5_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::MOVS, 16, 0) }
pub fn instr16_F2A5_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::MOVS, 16, 0xF2) }
pub fn instr16_F3A5_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::MOVS, 16, 0xF3) }
pub fn instr32_A5_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::MOVS, 32, 0) }
pub fn instr32_F2A5_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::MOVS, 32, 0xF2) }
pub fn instr32_F3A5_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::MOVS, 32, 0xF3) }
pub fn instr_A6_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::CMPS, 8, 0) }
pub fn instr_F2A6_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::CMPS, 8, 0xF2) }
pub fn instr_F3A6_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::CMPS, 8, 0xF3) }
pub fn instr16_A7_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::CMPS, 16, 0) }
pub fn instr16_F2A7_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::CMPS, 16, 0xF2) }
pub fn instr16_F3A7_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::CMPS, 16, 0xF3) }
pub fn instr32_A7_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::CMPS, 32, 0) }
pub fn instr32_F2A7_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::CMPS, 32, 0xF2) }
pub fn instr32_F3A7_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::CMPS, 32, 0xF3) }
pub fn instr_AA_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::STOS, 8, 0) }
pub fn instr_F2AA_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::STOS, 8, 0xF2) }
pub fn instr_F3AA_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::STOS, 8, 0xF3) }
pub fn instr16_AB_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::STOS, 16, 0) }
pub fn instr16_F2AB_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::STOS, 16, 0xF2) }
pub fn instr16_F3AB_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::STOS, 16, 0xF3) }
pub fn instr32_AB_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::STOS, 32, 0) }
pub fn instr32_F2AB_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::STOS, 32, 0xF2) }
pub fn instr32_F3AB_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::STOS, 32, 0xF3) }
pub fn instr_AC_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::LODS, 8, 0) }
pub fn instr_F2AC_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::LODS, 8, 0xF2) }
pub fn instr_F3AC_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::LODS, 8, 0xF3) }
pub fn instr16_AD_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::LODS, 16, 0) }
pub fn instr16_F2AD_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::LODS, 16, 0xF2) }
pub fn instr16_F3AD_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::LODS, 16, 0xF3) }
pub fn instr32_AD_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::LODS, 32, 0) }
pub fn instr32_F2AD_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::LODS, 32, 0xF2) }
pub fn instr32_F3AD_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::LODS, 32, 0xF3) }
pub fn instr_AE_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::SCAS, 8, 0) }
pub fn instr_F2AE_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::SCAS, 8, 0xF2) }
pub fn instr_F3AE_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::SCAS, 8, 0xF3) }
pub fn instr16_AF_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::SCAS, 16, 0) }
pub fn instr16_F2AF_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::SCAS, 16, 0xF2) }
pub fn instr16_F3AF_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::SCAS, 16, 0xF3) }
pub fn instr32_AF_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::SCAS, 32, 0) }
pub fn instr32_F2AF_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::SCAS, 32, 0xF2) }
pub fn instr32_F3AF_jit(ctx: &mut JitContext) { gen_string_ins(ctx, String::SCAS, 32, 0xF3) }

pub fn instr_0F31_jit(ctx: &mut JitContext) {
    ctx.builder.load_fixed_u8(global_pointers::cpl as u32);
    ctx.builder.eqz_i32();

    dbg_assert!(regs::CR4_TSD < 0x100);
    ctx.builder
        .load_fixed_u8(global_pointers::get_creg_offset(4));
    ctx.builder.const_i32(regs::CR4_TSD as i32);
    ctx.builder.and_i32();
    ctx.builder.eqz_i32();

    ctx.builder.or_i32();
    ctx.builder.if_void();
    ctx.builder.call_fn0_ret_i64("read_tsc");

    let tsc = ctx.builder.tee_new_local_i64();
    ctx.builder.wrap_i64_to_i32();
    codegen::gen_set_reg32(ctx, regs::EAX);

    ctx.builder.get_local_i64(&tsc);
    ctx.builder.const_i64(32);
    ctx.builder.shr_u_i64();
    ctx.builder.wrap_i64_to_i32();
    codegen::gen_set_reg32(ctx, regs::EDX);

    ctx.builder.free_local_i64(tsc);
    ctx.builder.else_();
    codegen::gen_trigger_gp(ctx, 0);
    ctx.builder.block_end();
}

pub fn instr_0F0B_jit(ctx: &mut JitContext) { codegen::gen_trigger_ud(ctx) }

pub fn instr_0F18_mem_jit(_ctx: &mut JitContext, _modrm_byte: ModrmByte, _reg: u32) {}
pub fn instr_0F18_reg_jit(_ctx: &mut JitContext, _r1: u32, _r2: u32) {}

pub fn instr_0F19_mem_jit(_ctx: &mut JitContext, _modrm_byte: ModrmByte, _reg: u32) {}
pub fn instr_0F19_reg_jit(_ctx: &mut JitContext, _r1: u32, _r2: u32) {}

pub fn instr_0F1C_mem_jit(_ctx: &mut JitContext, _modrm_byte: ModrmByte, _reg: u32) {}
pub fn instr_0F1C_reg_jit(_ctx: &mut JitContext, _r1: u32, _r2: u32) {}
pub fn instr_0F1D_mem_jit(_ctx: &mut JitContext, _modrm_byte: ModrmByte, _reg: u32) {}
pub fn instr_0F1D_reg_jit(_ctx: &mut JitContext, _r1: u32, _r2: u32) {}
pub fn instr_0F1E_mem_jit(_ctx: &mut JitContext, _modrm_byte: ModrmByte, _reg: u32) {}
pub fn instr_0F1E_reg_jit(_ctx: &mut JitContext, _r1: u32, _r2: u32) {}
pub fn instr_0F1F_mem_jit(_ctx: &mut JitContext, _modrm_byte: ModrmByte, _reg: u32) {}
pub fn instr_0F1F_reg_jit(_ctx: &mut JitContext, _r1: u32, _r2: u32) {}

define_instruction_read_write_mem16!(
    "shld16",
    instr16_0FA4_mem_jit,
    instr16_0FA4_reg_jit,
    reg,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    "shld32",
    instr32_0FA4_mem_jit,
    instr32_0FA4_reg_jit,
    reg,
    imm8_5bits
);
define_instruction_read_write_mem16!(
    "shld16",
    instr16_0FA5_mem_jit,
    instr16_0FA5_reg_jit,
    reg,
    cl
);
define_instruction_read_write_mem32!(
    "shld32",
    instr32_0FA5_mem_jit,
    instr32_0FA5_reg_jit,
    reg,
    cl
);

define_instruction_read_write_mem16!(
    "shrd16",
    instr16_0FAC_mem_jit,
    instr16_0FAC_reg_jit,
    reg,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    "shrd32",
    instr32_0FAC_mem_jit,
    instr32_0FAC_reg_jit,
    reg,
    imm8_5bits
);
define_instruction_read_write_mem16!(
    "shrd16",
    instr16_0FAD_mem_jit,
    instr16_0FAD_reg_jit,
    reg,
    cl
);
define_instruction_read_write_mem32!(
    "shrd32",
    instr32_0FAD_mem_jit,
    instr32_0FAD_reg_jit,
    reg,
    cl
);

pub fn instr16_0FB1_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg16(ctx, r1);
    ctx.builder.const_i32(r2 as i32);
    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn2_ret("cmpxchg16");
    codegen::gen_move_registers_from_memory_to_locals(ctx);
    codegen::gen_set_reg16(ctx, r1);
}
pub fn instr16_0FB1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read_write(ctx, BitSize::WORD, &address_local, &|ref mut ctx| {
        ctx.builder.const_i32(r as i32);
        codegen::gen_move_registers_from_locals_to_memory(ctx);
        ctx.builder.call_fn2_ret("cmpxchg16");
        codegen::gen_move_registers_from_memory_to_locals(ctx);
    });
    ctx.builder.free_local(address_local);
}

pub fn instr32_0FB1_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg32(ctx, r1);
    gen_cmpxchg32(ctx, r2);
    codegen::gen_set_reg32(ctx, r1);
}
pub fn instr32_0FB1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read_write(ctx, BitSize::DWORD, &address_local, &|ref mut ctx| {
        gen_cmpxchg32(ctx, r);
    });
    ctx.builder.free_local(address_local);
}

pub fn instr16_0FB6_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg8(ctx, r1);
    codegen::gen_set_reg16_unmasked(ctx, r2);
}
pub fn instr16_0FB6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read8(ctx, modrm_byte);
    codegen::gen_set_reg16_unmasked(ctx, r);
}

pub fn instr32_0FB6_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg8(ctx, r1);
    codegen::gen_set_reg32(ctx, r2);
}
pub fn instr32_0FB6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read8(ctx, modrm_byte);
    codegen::gen_set_reg32(ctx, r);
}

pub fn instr16_0FB7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    codegen::gen_set_reg16(ctx, r);
}
pub fn instr16_0FB7_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg16(ctx, r1);
    codegen::gen_set_reg16(ctx, r2);
}
pub fn instr32_0FB7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    codegen::gen_set_reg32(ctx, r);
}
pub fn instr32_0FB7_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg16(ctx, r1);
    codegen::gen_set_reg32(ctx, r2);
}

pub fn instr16_F30FB8_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    ctx.builder.call_fn1_ret("popcnt");
    codegen::gen_set_reg16(ctx, r);
}
pub fn instr16_F30FB8_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg16(ctx, r1);
    ctx.builder.call_fn1_ret("popcnt");
    codegen::gen_set_reg16(ctx, r2);
}
pub fn instr32_F30FB8_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    ctx.builder.call_fn1_ret("popcnt");
    codegen::gen_set_reg32(ctx, r);
}
pub fn instr32_F30FB8_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg32(ctx, r1);
    ctx.builder.call_fn1_ret("popcnt");
    codegen::gen_set_reg32(ctx, r2);
}

define_instruction_write_reg16!("bsf16", instr16_0FBC_mem_jit, instr16_0FBC_reg_jit);
define_instruction_write_reg32!(gen_bsf32, instr32_0FBC_mem_jit, instr32_0FBC_reg_jit);
define_instruction_write_reg16!("bsr16", instr16_0FBD_mem_jit, instr16_0FBD_reg_jit);
define_instruction_write_reg32!(gen_bsr32, instr32_0FBD_mem_jit, instr32_0FBD_reg_jit);

pub fn instr16_0FBE_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg8(ctx, r1);
    codegen::sign_extend_i8(ctx.builder);
    codegen::gen_set_reg16(ctx, r2);
}
pub fn instr16_0FBE_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read8(ctx, modrm_byte); // TODO: Could use sign-extended read
    codegen::sign_extend_i8(ctx.builder);
    codegen::gen_set_reg16(ctx, r);
}

pub fn instr32_0FBE_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    match r1 {
        regs::AL | regs::CL | regs::DL | regs::BL => {
            ctx.builder.get_local(&ctx.register_locals[r1 as usize]);
            ctx.builder.const_i32(24);
            ctx.builder.shl_i32();
        },
        regs::AH | regs::CH | regs::DH | regs::BH => {
            ctx.builder
                .get_local(&ctx.register_locals[(r1 - 4) as usize]);
            ctx.builder.const_i32(16);
            ctx.builder.shl_i32();
        },
        _ => assert!(false),
    }
    ctx.builder.const_i32(24);
    ctx.builder.shr_s_i32();
    codegen::gen_set_reg32(ctx, r2);
}
pub fn instr32_0FBE_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read8(ctx, modrm_byte); // TODO: Could use sign-extended read
    codegen::sign_extend_i8(ctx.builder);
    codegen::gen_set_reg32(ctx, r);
}

pub fn instr16_0FBF_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg16(ctx, r1);
    codegen::gen_set_reg16_unmasked(ctx, r2);
}
pub fn instr16_0FBF_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    codegen::gen_set_reg16_unmasked(ctx, r);
}

pub fn instr32_0FBF_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg32(ctx, r1);
    codegen::sign_extend_i16(ctx.builder);
    codegen::gen_set_reg32(ctx, r2);
}
pub fn instr32_0FBF_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte); // TODO: Could use sign-extended read
    codegen::sign_extend_i16(ctx.builder);
    codegen::gen_set_reg32(ctx, r);
}

pub fn instr16_0FC1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read_write(ctx, BitSize::WORD, &address_local, &|ref mut ctx| {
        ctx.builder.const_i32(r as i32);
        codegen::gen_move_registers_from_locals_to_memory(ctx);
        ctx.builder.call_fn2_ret("xadd16");
        codegen::gen_move_registers_from_memory_to_locals(ctx);
    });
    ctx.builder.free_local(address_local);
}
pub fn instr16_0FC1_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg16(ctx, r1);
    ctx.builder.const_i32(r2 as i32);
    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn2_ret("xadd16");
    codegen::gen_move_registers_from_memory_to_locals(ctx);
    codegen::gen_set_reg16(ctx, r1);
}

pub fn instr32_0FC1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read_write(ctx, BitSize::DWORD, &address_local, &|ref mut ctx| {
        let dest_operand = ctx.builder.set_new_local();
        gen_xadd32(ctx, &dest_operand, r);
        ctx.builder.get_local(&dest_operand);
        ctx.builder.free_local(dest_operand);
    });
    ctx.builder.free_local(address_local);
}
pub fn instr32_0FC1_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg32(ctx, r1);
    let dest_operand = ctx.builder.set_new_local();
    gen_xadd32(ctx, &dest_operand, r2);
    ctx.builder.get_local(&dest_operand);
    codegen::gen_set_reg32(ctx, r1);
    ctx.builder.free_local(dest_operand);
}

pub fn instr_0FC3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &ctx.reg(r));
    ctx.builder.free_local(address_local);
}
pub fn instr_0FC3_reg_jit(ctx: &mut JitContext, _r1: u32, _r2: u32) { codegen::gen_trigger_ud(ctx) }

pub fn instr_0FC4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read16(ctx, &address_local);
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn3("instr_0FC4");
    ctx.builder.free_local(address_local);
}
pub fn instr_0FC4_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    codegen::gen_get_reg32(ctx, r1);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn3("instr_0FC4");
}

pub fn instr_660FC4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8: u32) {
    ctx.builder.const_i32(0);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read16(ctx, &address_local);
    ctx.builder
        .store_aligned_u16(global_pointers::get_reg_xmm_offset(r) + ((imm8 & 7) << 1));
    ctx.builder.free_local(address_local);
}
pub fn instr_660FC4_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    ctx.builder.const_i32(0);
    codegen::gen_get_reg32(ctx, r1);
    ctx.builder
        .store_aligned_u16(global_pointers::get_reg_xmm_offset(r2) + ((imm8 & 7) << 1));
}

pub fn instr_0FC5_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _r: u32, _imm8: u32) {
    codegen::gen_trigger_ud(ctx)
}
pub fn instr_0FC5_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.const_i32(r1 as i32);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn3("instr_0FC5_reg");
    codegen::gen_move_registers_from_memory_to_locals(ctx);
}

pub fn instr_660FC5_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _r: u32, _imm8: u32) {
    codegen::gen_trigger_ud(ctx)
}
pub fn instr_660FC5_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    ctx.builder
        .load_fixed_u16(global_pointers::get_reg_xmm_offset(r1) + ((imm8 & 7) << 1));
    codegen::gen_set_reg32(ctx, r2);
}

pub fn instr16_0FC7_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    // cmpxchg8b
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read_write(ctx, BitSize::QWORD, &address_local, &|ref mut ctx| {
        let dest_operand = ctx.builder.tee_new_local_i64();
        codegen::gen_get_reg32(ctx, regs::EDX);
        ctx.builder.extend_unsigned_i32_to_i64();
        ctx.builder.const_i64(32);
        ctx.builder.shl_i64();
        codegen::gen_get_reg32(ctx, regs::EAX);
        ctx.builder.extend_unsigned_i32_to_i64();
        ctx.builder.or_i64();
        ctx.builder.eq_i64();
        ctx.builder.if_i64();
        {
            codegen::gen_set_flags_bits(ctx.builder, FLAG_ZERO);
            codegen::gen_get_reg32(ctx, regs::ECX);
            ctx.builder.extend_unsigned_i32_to_i64();
            ctx.builder.const_i64(32);
            ctx.builder.shl_i64();
            codegen::gen_get_reg32(ctx, regs::EBX);
            ctx.builder.extend_unsigned_i32_to_i64();
            ctx.builder.or_i64();
        }
        ctx.builder.else_();
        {
            codegen::gen_clear_flags_bits(ctx.builder, FLAG_ZERO);
            ctx.builder.get_local_i64(&dest_operand);
            ctx.builder.wrap_i64_to_i32();
            codegen::gen_set_reg32(ctx, regs::EAX);
            ctx.builder.get_local_i64(&dest_operand);
            ctx.builder.const_i64(32);
            ctx.builder.shr_u_i64();
            ctx.builder.wrap_i64_to_i32();
            codegen::gen_set_reg32(ctx, regs::EDX);
            ctx.builder.get_local_i64(&dest_operand);
        }
        ctx.builder.block_end();
        codegen::gen_clear_flags_changed_bits(ctx.builder, FLAG_ZERO);
        ctx.builder.free_local_i64(dest_operand);
    });
    ctx.builder.free_local(address_local);
}
pub fn instr16_0FC7_1_reg_jit(ctx: &mut JitContext, _r: u32) { codegen::gen_trigger_ud(ctx); }
pub fn instr32_0FC7_1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    instr16_0FC7_1_mem_jit(ctx, modrm_byte);
}
pub fn instr32_0FC7_1_reg_jit(ctx: &mut JitContext, _r: u32) { codegen::gen_trigger_ud(ctx); }

pub fn instr_0FC2_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    sse_read128_xmm_xmm_imm(ctx, "instr_0FC2", r1, r2, imm8)
}
pub fn instr_0FC2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8: u32) {
    sse_read128_xmm_mem_imm(ctx, "instr_0FC2", modrm_byte, r, imm8)
}
pub fn instr_660FC2_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    sse_read128_xmm_xmm_imm(ctx, "instr_660FC2", r1, r2, imm8)
}
pub fn instr_660FC2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8: u32) {
    sse_read128_xmm_mem_imm(ctx, "instr_660FC2", modrm_byte, r, imm8)
}
pub fn instr_F20FC2_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r1) as i32);
    ctx.builder.load_aligned_i64(0);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn3_i64_i32_i32("instr_F20FC2");
}
pub fn instr_F20FC2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8: u32) {
    codegen::gen_modrm_resolve_safe_read64(ctx, modrm_byte);
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn3_i64_i32_i32("instr_F20FC2");
}
pub fn instr_F30FC2_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r1) as i32);
    ctx.builder.load_aligned_i32(0);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn3("instr_F30FC2");
}
pub fn instr_F30FC2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8: u32) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn3("instr_F30FC2");
}

pub fn instr_0FC6_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    sse_read128_xmm_xmm_imm(ctx, "instr_0FC6", r1, r2, imm8)
}
pub fn instr_0FC6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8: u32) {
    sse_read128_xmm_mem_imm(ctx, "instr_0FC6", modrm_byte, r, imm8)
}
pub fn instr_660FC6_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    sse_read128_xmm_xmm_imm(ctx, "instr_660FC6", r1, r2, imm8)
}
pub fn instr_660FC6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8: u32) {
    sse_read128_xmm_mem_imm(ctx, "instr_660FC6", modrm_byte, r, imm8)
}

pub fn instr_C6_0_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    // reg8[r] = imm;
    ctx.builder.const_i32(imm as i32);
    codegen::gen_set_reg8_unmasked(ctx, r);
}

pub fn instr_C6_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm: u32) {
    codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
        ctx.builder.const_i32(imm as i32);
        let value_local = ctx.builder.set_new_local();
        codegen::gen_safe_write8(ctx, &addr, &value_local);
        ctx.builder.free_local(value_local);
    });
}

pub fn instr16_C7_0_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    // reg16[r] = imm;
    ctx.builder.const_i32(imm as i32);
    codegen::gen_set_reg16_unmasked(ctx, r);
}

pub fn instr16_C7_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm: u32) {
    codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
        ctx.builder.const_i32(imm as i32);
        let value_local = ctx.builder.set_new_local();
        codegen::gen_safe_write16(ctx, &addr, &value_local);
        ctx.builder.free_local(value_local);
    });
}

pub fn instr32_C7_0_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    // reg32[r] = imm;
    ctx.builder.const_i32(imm as i32);
    codegen::gen_set_reg32(ctx, r);
}

pub fn instr32_C7_0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm: u32) {
    codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
        ctx.builder.const_i32(imm as i32);
        let value_local = ctx.builder.set_new_local();
        codegen::gen_safe_write32(ctx, &addr, &value_local);
        ctx.builder.free_local(value_local);
    });
}

pub fn instr_0FC8_jit(ctx: &mut JitContext) { gen_bswap(ctx, 0) }
pub fn instr_0FC9_jit(ctx: &mut JitContext) { gen_bswap(ctx, 1) }
pub fn instr_0FCA_jit(ctx: &mut JitContext) { gen_bswap(ctx, 2) }
pub fn instr_0FCB_jit(ctx: &mut JitContext) { gen_bswap(ctx, 3) }
pub fn instr_0FCC_jit(ctx: &mut JitContext) { gen_bswap(ctx, 4) }
pub fn instr_0FCD_jit(ctx: &mut JitContext) { gen_bswap(ctx, 5) }
pub fn instr_0FCE_jit(ctx: &mut JitContext) { gen_bswap(ctx, 6) }
pub fn instr_0FCF_jit(ctx: &mut JitContext) { gen_bswap(ctx, 7) }

define_instruction_write_reg16!("imul_reg16", instr16_0FAF_mem_jit, instr16_0FAF_reg_jit);
define_instruction_write_reg32!(gen_imul_reg32, instr32_0FAF_mem_jit, instr32_0FAF_reg_jit);

macro_rules! define_cmovcc16(
    ($cond:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
            codegen::gen_modrm_resolve_safe_read16(ctx, modrm_byte);
            let value = ctx.builder.set_new_local();
            codegen::gen_condition_fn(ctx, $cond);
            ctx.builder.if_void();
            ctx.builder.get_local(&value);
            codegen::gen_set_reg16(ctx, r);
            ctx.builder.block_end();
            ctx.builder.free_local(value);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_condition_fn(ctx, $cond);
            ctx.builder.if_void();
            codegen::gen_get_reg16(ctx, r1);
            codegen::gen_set_reg16(ctx, r2);
            ctx.builder.block_end();
        }
    );
);

macro_rules! define_cmovcc32(
    ($cond:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
            codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
            let value = ctx.builder.set_new_local();
            codegen::gen_condition_fn(ctx, $cond);
            ctx.builder.if_void();
            ctx.builder.get_local(&value);
            codegen::gen_set_reg32(ctx, r);
            ctx.builder.block_end();
            ctx.builder.free_local(value);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_condition_fn(ctx, $cond);
            ctx.builder.if_void();
            codegen::gen_get_reg32(ctx, r1);
            codegen::gen_set_reg32(ctx, r2);
            ctx.builder.block_end();
        }
    );
);

define_cmovcc16!(0x0, instr16_0F40_mem_jit, instr16_0F40_reg_jit);
define_cmovcc16!(0x1, instr16_0F41_mem_jit, instr16_0F41_reg_jit);
define_cmovcc16!(0x2, instr16_0F42_mem_jit, instr16_0F42_reg_jit);
define_cmovcc16!(0x3, instr16_0F43_mem_jit, instr16_0F43_reg_jit);
define_cmovcc16!(0x4, instr16_0F44_mem_jit, instr16_0F44_reg_jit);
define_cmovcc16!(0x5, instr16_0F45_mem_jit, instr16_0F45_reg_jit);
define_cmovcc16!(0x6, instr16_0F46_mem_jit, instr16_0F46_reg_jit);
define_cmovcc16!(0x7, instr16_0F47_mem_jit, instr16_0F47_reg_jit);

define_cmovcc16!(0x8, instr16_0F48_mem_jit, instr16_0F48_reg_jit);
define_cmovcc16!(0x9, instr16_0F49_mem_jit, instr16_0F49_reg_jit);
define_cmovcc16!(0xA, instr16_0F4A_mem_jit, instr16_0F4A_reg_jit);
define_cmovcc16!(0xB, instr16_0F4B_mem_jit, instr16_0F4B_reg_jit);
define_cmovcc16!(0xC, instr16_0F4C_mem_jit, instr16_0F4C_reg_jit);
define_cmovcc16!(0xD, instr16_0F4D_mem_jit, instr16_0F4D_reg_jit);
define_cmovcc16!(0xE, instr16_0F4E_mem_jit, instr16_0F4E_reg_jit);
define_cmovcc16!(0xF, instr16_0F4F_mem_jit, instr16_0F4F_reg_jit);

define_cmovcc32!(0x0, instr32_0F40_mem_jit, instr32_0F40_reg_jit);
define_cmovcc32!(0x1, instr32_0F41_mem_jit, instr32_0F41_reg_jit);
define_cmovcc32!(0x2, instr32_0F42_mem_jit, instr32_0F42_reg_jit);
define_cmovcc32!(0x3, instr32_0F43_mem_jit, instr32_0F43_reg_jit);
define_cmovcc32!(0x4, instr32_0F44_mem_jit, instr32_0F44_reg_jit);
define_cmovcc32!(0x5, instr32_0F45_mem_jit, instr32_0F45_reg_jit);
define_cmovcc32!(0x6, instr32_0F46_mem_jit, instr32_0F46_reg_jit);
define_cmovcc32!(0x7, instr32_0F47_mem_jit, instr32_0F47_reg_jit);

define_cmovcc32!(0x8, instr32_0F48_mem_jit, instr32_0F48_reg_jit);
define_cmovcc32!(0x9, instr32_0F49_mem_jit, instr32_0F49_reg_jit);
define_cmovcc32!(0xA, instr32_0F4A_mem_jit, instr32_0F4A_reg_jit);
define_cmovcc32!(0xB, instr32_0F4B_mem_jit, instr32_0F4B_reg_jit);
define_cmovcc32!(0xC, instr32_0F4C_mem_jit, instr32_0F4C_reg_jit);
define_cmovcc32!(0xD, instr32_0F4D_mem_jit, instr32_0F4D_reg_jit);
define_cmovcc32!(0xE, instr32_0F4E_mem_jit, instr32_0F4E_reg_jit);
define_cmovcc32!(0xF, instr32_0F4F_mem_jit, instr32_0F4F_reg_jit);

macro_rules! define_setcc(
    ($cond:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: ModrmByte, _r: u32) {
            codegen::gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
                codegen::gen_condition_fn(ctx, $cond);
                ctx.builder.const_i32(0);
                ctx.builder.ne_i32();
                let value_local = ctx.builder.set_new_local();
                codegen::gen_safe_write8(ctx, &addr, &value_local);
                ctx.builder.free_local(value_local);
            });
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, _r2: u32) {
            codegen::gen_condition_fn(ctx, $cond);
            ctx.builder.const_i32(0);
            ctx.builder.ne_i32();
            codegen::gen_set_reg8_unmasked(ctx, r1);
        }
    );
);

define_setcc!(0x0, instr_0F90_mem_jit, instr_0F90_reg_jit);
define_setcc!(0x1, instr_0F91_mem_jit, instr_0F91_reg_jit);
define_setcc!(0x2, instr_0F92_mem_jit, instr_0F92_reg_jit);
define_setcc!(0x3, instr_0F93_mem_jit, instr_0F93_reg_jit);
define_setcc!(0x4, instr_0F94_mem_jit, instr_0F94_reg_jit);
define_setcc!(0x5, instr_0F95_mem_jit, instr_0F95_reg_jit);
define_setcc!(0x6, instr_0F96_mem_jit, instr_0F96_reg_jit);
define_setcc!(0x7, instr_0F97_mem_jit, instr_0F97_reg_jit);

define_setcc!(0x8, instr_0F98_mem_jit, instr_0F98_reg_jit);
define_setcc!(0x9, instr_0F99_mem_jit, instr_0F99_reg_jit);
define_setcc!(0xA, instr_0F9A_mem_jit, instr_0F9A_reg_jit);
define_setcc!(0xB, instr_0F9B_mem_jit, instr_0F9B_reg_jit);
define_setcc!(0xC, instr_0F9C_mem_jit, instr_0F9C_reg_jit);
define_setcc!(0xD, instr_0F9D_mem_jit, instr_0F9D_reg_jit);
define_setcc!(0xE, instr_0F9E_mem_jit, instr_0F9E_reg_jit);
define_setcc!(0xF, instr_0F9F_mem_jit, instr_0F9F_reg_jit);

pub fn instr_0F10_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    let dest = global_pointers::get_reg_xmm_offset(r);
    codegen::gen_modrm_resolve_safe_read128(ctx, modrm_byte, dest);
}
pub fn instr_0F10_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) { sse_mov_xmm_xmm(ctx, r1, r2) }
pub fn instr_660F10_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    let dest = global_pointers::get_reg_xmm_offset(r);
    codegen::gen_modrm_resolve_safe_read128(ctx, modrm_byte, dest);
}
pub fn instr_660F10_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) { sse_mov_xmm_xmm(ctx, r1, r2) }
pub fn instr_F20F10_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_F30F7E_mem_jit(ctx, modrm_byte, r)
}
pub fn instr_F20F10_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.const_i32(0);
    ctx.builder
        .load_fixed_i64(global_pointers::get_reg_xmm_offset(r1));
    ctx.builder
        .store_aligned_i64(global_pointers::get_reg_xmm_offset(r2));
}
pub fn instr_F30F10_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_660F6E_mem_jit(ctx, modrm_byte, r)
}
pub fn instr_F30F10_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.const_i32(0);
    ctx.builder
        .load_fixed_i32(global_pointers::get_reg_xmm_offset(r1));
    ctx.builder
        .store_aligned_i32(global_pointers::get_reg_xmm_offset(r2));
}

pub fn instr_0F11_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_0F29_mem_jit(ctx, modrm_byte, r)
}
pub fn instr_0F11_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) { sse_mov_xmm_xmm(ctx, r2, r1) }
pub fn instr_660F11_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_660F29_mem_jit(ctx, modrm_byte, r)
}
pub fn instr_660F11_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) { sse_mov_xmm_xmm(ctx, r2, r1) }
pub fn instr_F20F11_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_660FD6_mem_jit(ctx, modrm_byte, r)
}
pub fn instr_F20F11_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.const_i32(0);
    ctx.builder
        .load_fixed_i64(global_pointers::get_reg_xmm_offset(r2));
    ctx.builder
        .store_aligned_i64(global_pointers::get_reg_xmm_offset(r1));
}
pub fn instr_F30F11_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_660F7E_mem_jit(ctx, modrm_byte, r)
}
pub fn instr_F30F11_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.const_i32(0);
    ctx.builder
        .load_fixed_i32(global_pointers::get_reg_xmm_offset(r2));
    ctx.builder
        .store_aligned_i32(global_pointers::get_reg_xmm_offset(r1));
}

pub fn instr_0F12_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r) as i32);
    codegen::gen_modrm_resolve_safe_read64(ctx, modrm_byte);
    ctx.builder.store_aligned_i64(0);
}
pub fn instr_0F12_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r2) as i32);
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r1) as i32 + 8);
    ctx.builder.load_aligned_i64(0);
    ctx.builder.store_aligned_i64(0);
}
pub fn instr_660F12_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r) as i32);
    codegen::gen_modrm_resolve_safe_read64(ctx, modrm_byte);
    ctx.builder.store_aligned_i64(0);
}
pub fn instr_660F12_reg_jit(ctx: &mut JitContext, _r1: u32, _r2: u32) {
    codegen::gen_trigger_ud(ctx);
}

pub fn instr_F20F12_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_F20F12", modrm_byte, r);
}
pub fn instr_F20F12_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_F20F12", r1, r2);
}
pub fn instr_F30F12_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_F30F12", modrm_byte, r);
}
pub fn instr_F30F12_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_F30F12", r1, r2);
}

pub fn instr_0F13_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_660FD6_mem_jit(ctx, modrm_byte, r)
}
pub fn instr_0F13_reg_jit(ctx: &mut JitContext, _r1: u32, _r2: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_660F13_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_660FD6_mem_jit(ctx, modrm_byte, r)
}
pub fn instr_660F13_reg_jit(ctx: &mut JitContext, _r1: u32, _r2: u32) {
    codegen::gen_trigger_ud(ctx);
}

pub fn instr_0F14_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_0F14", modrm_byte, r);
}
pub fn instr_0F14_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_0F14", r1, r2);
}
pub fn instr_660F14_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_660F14", modrm_byte, r);
}
pub fn instr_660F14_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_660F14", r1, r2);
}

pub fn instr_0F15_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F15", modrm_byte, r);
}
pub fn instr_0F15_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F15", r1, r2);
}
pub fn instr_660F15_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F15", modrm_byte, r);
}
pub fn instr_660F15_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F15", r1, r2);
}

pub fn instr_0F16_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_0F16", modrm_byte, r);
}
pub fn instr_0F16_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_0F16", r1, r2);
}
pub fn instr_660F16_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_0F16", modrm_byte, r);
}
pub fn instr_660F16_reg_jit(ctx: &mut JitContext, _r1: u32, _r2: u32) {
    codegen::gen_trigger_ud(ctx);
}

pub fn instr_F30F16_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_F30F16", modrm_byte, r);
}
pub fn instr_F30F16_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_F30F16", r1, r2);
}

pub fn instr_0F17_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r) as i32);
    ctx.builder.load_aligned_i64(8);
    let value_local = ctx.builder.set_new_local_i64();
    codegen::gen_safe_write64(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local_i64(value_local);
}
pub fn instr_0F17_reg_jit(ctx: &mut JitContext, _r1: u32, _r2: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_660F17_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_0F17_mem_jit(ctx, modrm_byte, r);
}
pub fn instr_660F17_reg_jit(ctx: &mut JitContext, _r1: u32, _r2: u32) {
    codegen::gen_trigger_ud(ctx);
}

pub fn instr_0F28_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    let dest = global_pointers::get_reg_xmm_offset(r);
    codegen::gen_modrm_resolve_safe_read128(ctx, modrm_byte, dest);
}
pub fn instr_0F28_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) { sse_mov_xmm_xmm(ctx, r1, r2) }
pub fn instr_660F28_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    let dest = global_pointers::get_reg_xmm_offset(r);
    codegen::gen_modrm_resolve_safe_read128(ctx, modrm_byte, dest);
}
pub fn instr_660F28_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) { sse_mov_xmm_xmm(ctx, r1, r2) }

pub fn instr_0F29_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    // XXX: Aligned write or #gp
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r) as i32);
    ctx.builder.load_aligned_i64(0);
    let value_local_low = ctx.builder.set_new_local_i64();
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r) as i32 + 8);
    ctx.builder.load_aligned_i64(0);
    let value_local_high = ctx.builder.set_new_local_i64();
    codegen::gen_safe_write128(ctx, &address_local, &value_local_low, &value_local_high);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local_i64(value_local_low);
    ctx.builder.free_local_i64(value_local_high);
}
pub fn instr_0F29_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) { sse_mov_xmm_xmm(ctx, r2, r1) }

pub fn instr_660F29_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_0F29_mem_jit(ctx, modrm_byte, r);
}
pub fn instr_660F29_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) { sse_mov_xmm_xmm(ctx, r2, r1) }

pub fn instr_0F2A_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0F2A", modrm_byte, r);
}
pub fn instr_0F2A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0F2A", r1, r2);
}
pub fn instr_660F2A_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_660F2A", modrm_byte, r);
}
pub fn instr_660F2A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_660F2A", r1, r2);
}
pub fn instr_F20F2A_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn2("instr_F20F2A")
}
pub fn instr_F20F2A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg32(ctx, r1);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.call_fn2("instr_F20F2A")
}
pub fn instr_F30F2A_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn2("instr_F30F2A")
}
pub fn instr_F30F2A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg32(ctx, r1);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.call_fn2("instr_F30F2A")
}

pub fn instr_0F2B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_0F29_mem_jit(ctx, modrm_byte, r)
}
pub fn instr_0F2B_reg_jit(ctx: &mut JitContext, _r1: u32, _r2: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_660F2B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_0F29_mem_jit(ctx, modrm_byte, r)
}
pub fn instr_660F2B_reg_jit(ctx: &mut JitContext, _r1: u32, _r2: u32) {
    codegen::gen_trigger_ud(ctx);
}

pub fn instr_F20F2C_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read64(ctx, modrm_byte);
    ctx.builder.reinterpret_i64_as_f64();
    ctx.builder
        .call_fn1_f64_ret("sse_convert_with_truncation_f64_to_i32");
    codegen::gen_set_reg32(ctx, r);
}
pub fn instr_F20F2C_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r1) as i32);
    ctx.builder.load_aligned_f64(0);
    ctx.builder
        .call_fn1_f64_ret("sse_convert_with_truncation_f64_to_i32");
    codegen::gen_set_reg32(ctx, r2);
}
pub fn instr_F30F2C_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    ctx.builder.reinterpret_i32_as_f32();
    ctx.builder
        .call_fn1_f32_ret("sse_convert_with_truncation_f32_to_i32");
    codegen::gen_set_reg32(ctx, r);
}
pub fn instr_F30F2C_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r1) as i32);
    ctx.builder.load_aligned_f32(0);
    ctx.builder
        .call_fn1_f32_ret("sse_convert_with_truncation_f32_to_i32");
    codegen::gen_set_reg32(ctx, r2);
}

pub fn instr_F20F2D_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read64(ctx, modrm_byte);
    ctx.builder.reinterpret_i64_as_f64();
    ctx.builder.call_fn1_f64_ret("sse_convert_f64_to_i32");
    codegen::gen_set_reg32(ctx, r);
}
pub fn instr_F20F2D_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r1) as i32);
    ctx.builder.load_aligned_f64(0);
    ctx.builder.call_fn1_f64_ret("sse_convert_f64_to_i32");
    codegen::gen_set_reg32(ctx, r2);
}
pub fn instr_F30F2D_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    ctx.builder.reinterpret_i32_as_f32();
    ctx.builder.call_fn1_f32_ret("sse_convert_f32_to_i32");
    codegen::gen_set_reg32(ctx, r);
}
pub fn instr_F30F2D_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r1) as i32);
    ctx.builder.load_aligned_f32(0);
    ctx.builder.call_fn1_f32_ret("sse_convert_f32_to_i32");
    codegen::gen_set_reg32(ctx, r2);
}

pub fn instr_0F2E_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read_f32_xmm_mem(ctx, "instr_0F2E", modrm_byte, r);
}
pub fn instr_0F2E_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read_f32_xmm_xmm(ctx, "instr_0F2E", r1, r2);
}
pub fn instr_660F2E_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_660F2E", modrm_byte, r);
}
pub fn instr_660F2E_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_660F2E", r1, r2);
}

pub fn instr_0F2F_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read_f32_xmm_mem(ctx, "instr_0F2F", modrm_byte, r);
}
pub fn instr_0F2F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read_f32_xmm_xmm(ctx, "instr_0F2F", r1, r2);
}
pub fn instr_660F2F_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_660F2F", modrm_byte, r);
}
pub fn instr_660F2F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_660F2F", r1, r2);
}

pub fn instr_0F51_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F51", modrm_byte, r);
}
pub fn instr_0F51_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F51", r1, r2);
}
pub fn instr_660F51_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F51", modrm_byte, r);
}
pub fn instr_660F51_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F51", r1, r2);
}
pub fn instr_F20F51_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_F20F51", modrm_byte, r);
}
pub fn instr_F20F51_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_F20F51", r1, r2);
}
pub fn instr_F30F51_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read_f32_xmm_mem(ctx, "instr_F30F51", modrm_byte, r);
}
pub fn instr_F30F51_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read_f32_xmm_xmm(ctx, "instr_F30F51", r1, r2);
}

pub fn instr_0F52_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F52", modrm_byte, r);
}
pub fn instr_0F52_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F52", r1, r2);
}
pub fn instr_F30F52_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read_f32_xmm_mem(ctx, "instr_F30F52", modrm_byte, r);
}
pub fn instr_F30F52_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read_f32_xmm_xmm(ctx, "instr_F30F52", r1, r2);
}

pub fn instr_0F53_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F53", modrm_byte, r);
}
pub fn instr_0F53_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F53", r1, r2);
}
pub fn instr_F30F53_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read_f32_xmm_mem(ctx, "instr_F30F53", modrm_byte, r);
}
pub fn instr_F30F53_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read_f32_xmm_xmm(ctx, "instr_F30F53", r1, r2);
}

pub fn instr_0F54_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F54", modrm_byte, r);
}
pub fn instr_0F54_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F54", r1, r2);
}
pub fn instr_660F54_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F54", modrm_byte, r);
}
pub fn instr_660F54_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F54", r1, r2);
}

pub fn instr_0F55_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F55", modrm_byte, r);
}
pub fn instr_0F55_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F55", r1, r2);
}
pub fn instr_660F55_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F55", modrm_byte, r);
}
pub fn instr_660F55_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F55", r1, r2);
}

pub fn instr_0F56_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F56", modrm_byte, r);
}
pub fn instr_0F56_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F56", r1, r2);
}
pub fn instr_660F56_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F56", modrm_byte, r);
}
pub fn instr_660F56_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F56", r1, r2);
}

pub fn instr_0F57_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F57", modrm_byte, r);
}
pub fn instr_0F57_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F57", r1, r2);
}
pub fn instr_660F57_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F57", modrm_byte, r);
}
pub fn instr_660F57_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F57", r1, r2);
}

pub fn instr_0F58_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F58", modrm_byte, r);
}
pub fn instr_0F58_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F58", r1, r2);
}
pub fn instr_660F58_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F58", modrm_byte, r);
}
pub fn instr_660F58_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F58", r1, r2);
}
pub fn instr_F20F58_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_F20F58", modrm_byte, r);
}
pub fn instr_F20F58_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_F20F58", r1, r2);
}
pub fn instr_F30F58_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read_f32_xmm_mem(ctx, "instr_F30F58", modrm_byte, r);
}
pub fn instr_F30F58_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read_f32_xmm_xmm(ctx, "instr_F30F58", r1, r2);
}

pub fn instr_0F59_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F59", modrm_byte, r);
}
pub fn instr_0F59_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F59", r1, r2);
}
pub fn instr_660F59_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F59", modrm_byte, r);
}
pub fn instr_660F59_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F59", r1, r2);
}
pub fn instr_F20F59_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_F20F59", modrm_byte, r);
}
pub fn instr_F20F59_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_F20F59", r1, r2);
}
pub fn instr_F30F59_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read_f32_xmm_mem(ctx, "instr_F30F59", modrm_byte, r);
}
pub fn instr_F30F59_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read_f32_xmm_xmm(ctx, "instr_F30F59", r1, r2);
}

pub fn instr_0F5A_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_0F5A", modrm_byte, r);
}
pub fn instr_0F5A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_0F5A", r1, r2);
}
pub fn instr_660F5A_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F5A", modrm_byte, r);
}
pub fn instr_660F5A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F5A", r1, r2);
}
pub fn instr_F20F5A_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_F20F5A", modrm_byte, r);
}
pub fn instr_F20F5A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_F20F5A", r1, r2);
}
pub fn instr_F30F5A_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read_f32_xmm_mem(ctx, "instr_F30F5A", modrm_byte, r);
}
pub fn instr_F30F5A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read_f32_xmm_xmm(ctx, "instr_F30F5A", r1, r2);
}

pub fn instr_0F5B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F5B", modrm_byte, r);
}
pub fn instr_0F5B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F5B", r1, r2);
}
pub fn instr_660F5B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F5B", modrm_byte, r);
}
pub fn instr_660F5B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F5B", r1, r2);
}
pub fn instr_F30F5B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_F30F5B", modrm_byte, r);
}
pub fn instr_F30F5B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_F30F5B", r1, r2);
}

pub fn instr_0F5C_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F5C", modrm_byte, r);
}
pub fn instr_0F5C_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F5C", r1, r2);
}
pub fn instr_660F5C_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F5C", modrm_byte, r);
}
pub fn instr_660F5C_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F5C", r1, r2);
}
pub fn instr_F20F5C_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_F20F5C", modrm_byte, r);
}
pub fn instr_F20F5C_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_F20F5C", r1, r2);
}
pub fn instr_F30F5C_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read_f32_xmm_mem(ctx, "instr_F30F5C", modrm_byte, r);
}
pub fn instr_F30F5C_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read_f32_xmm_xmm(ctx, "instr_F30F5C", r1, r2);
}

pub fn instr_0F5D_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F5D", modrm_byte, r);
}
pub fn instr_0F5D_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F5D", r1, r2);
}
pub fn instr_660F5D_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F5D", modrm_byte, r);
}
pub fn instr_660F5D_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F5D", r1, r2);
}
pub fn instr_F20F5D_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_F20F5D", modrm_byte, r);
}
pub fn instr_F20F5D_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_F20F5D", r1, r2);
}
pub fn instr_F30F5D_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read_f32_xmm_mem(ctx, "instr_F30F5D", modrm_byte, r);
}
pub fn instr_F30F5D_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read_f32_xmm_xmm(ctx, "instr_F30F5D", r1, r2);
}

pub fn instr_0F5E_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F5E", modrm_byte, r);
}
pub fn instr_0F5E_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F5E", r1, r2);
}
pub fn instr_660F5E_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F5E", modrm_byte, r);
}
pub fn instr_660F5E_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F5E", r1, r2);
}
pub fn instr_F20F5E_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_F20F5E", modrm_byte, r);
}
pub fn instr_F20F5E_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_F20F5E", r1, r2);
}
pub fn instr_F30F5E_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read_f32_xmm_mem(ctx, "instr_F30F5E", modrm_byte, r);
}
pub fn instr_F30F5E_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read_f32_xmm_xmm(ctx, "instr_F30F5E", r1, r2);
}

pub fn instr_0F5F_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_0F5F", modrm_byte, r);
}
pub fn instr_0F5F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_0F5F", r1, r2);
}
pub fn instr_660F5F_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F5F", modrm_byte, r);
}
pub fn instr_660F5F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F5F", r1, r2);
}
pub fn instr_F20F5F_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_F20F5F", modrm_byte, r);
}
pub fn instr_F20F5F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_F20F5F", r1, r2);
}
pub fn instr_F30F5F_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read_f32_xmm_mem(ctx, "instr_F30F5F", modrm_byte, r);
}
pub fn instr_F30F5F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read_f32_xmm_xmm(ctx, "instr_F30F5F", r1, r2);
}

pub fn instr_0F60_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem32(ctx, "instr_0F60", modrm_byte, r);
}
pub fn instr_0F60_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm32(ctx, "instr_0F60", r1, r2);
}
pub fn instr_0F61_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem32(ctx, "instr_0F61", modrm_byte, r);
}
pub fn instr_0F61_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm32(ctx, "instr_0F61", r1, r2);
}
pub fn instr_0F62_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem32(ctx, "instr_0F62", modrm_byte, r);
}
pub fn instr_0F62_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm32(ctx, "instr_0F62", r1, r2);
}

pub fn instr_0F63_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0F63", modrm_byte, r);
}
pub fn instr_0F63_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0F63", r1, r2);
}
pub fn instr_0F64_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0F64", modrm_byte, r);
}
pub fn instr_0F64_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0F64", r1, r2);
}
pub fn instr_0F65_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0F65", modrm_byte, r);
}
pub fn instr_0F65_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0F65", r1, r2);
}
pub fn instr_0F66_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0F66", modrm_byte, r);
}
pub fn instr_0F66_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0F66", r1, r2);
}
pub fn instr_0F67_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0F67", modrm_byte, r);
}
pub fn instr_0F67_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0F67", r1, r2);
}
pub fn instr_0F68_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0F68", modrm_byte, r);
}
pub fn instr_0F68_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0F68", r1, r2);
}
pub fn instr_0F69_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0F69", modrm_byte, r);
}
pub fn instr_0F69_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0F69", r1, r2);
}
pub fn instr_0F6A_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0F6A", modrm_byte, r);
}
pub fn instr_0F6A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0F6A", r1, r2);
}
pub fn instr_0F6B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0F6B", modrm_byte, r);
}
pub fn instr_0F6B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0F6B", r1, r2);
}

pub fn instr_660F60_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    // Note: Only requires 64-bit read, but is allowed to do 128-bit read
    sse_read128_xmm_mem(ctx, "instr_660F60", modrm_byte, r);
}
pub fn instr_660F60_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F60", r1, r2);
}
pub fn instr_660F61_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    // Note: Only requires 64-bit read, but is allowed to do 128-bit read
    sse_read128_xmm_mem(ctx, "instr_660F61", modrm_byte, r);
}
pub fn instr_660F61_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F61", r1, r2);
}
pub fn instr_660F62_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    let src = global_pointers::sse_scratch_register as u32;
    codegen::gen_modrm_resolve_safe_read128(ctx, modrm_byte, src);
    ctx.builder.const_i32(0);
    ctx.builder.load_fixed_i32(src + 4);
    ctx.builder
        .store_aligned_i32(global_pointers::get_reg_xmm_offset(r) + 12);

    ctx.builder.const_i32(0);
    ctx.builder
        .load_fixed_i32(global_pointers::get_reg_xmm_offset(r) + 4);
    ctx.builder
        .store_aligned_i32(global_pointers::get_reg_xmm_offset(r) + 8);

    ctx.builder.const_i32(0);
    ctx.builder.load_fixed_i32(src + 0);
    ctx.builder
        .store_aligned_i32(global_pointers::get_reg_xmm_offset(r) + 4);
}
pub fn instr_660F62_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.const_i32(0);
    ctx.builder
        .load_fixed_i32(global_pointers::get_reg_xmm_offset(r1) + 4);
    ctx.builder
        .store_aligned_i32(global_pointers::get_reg_xmm_offset(r2) + 12);

    ctx.builder.const_i32(0);
    ctx.builder
        .load_fixed_i32(global_pointers::get_reg_xmm_offset(r2) + 4);
    ctx.builder
        .store_aligned_i32(global_pointers::get_reg_xmm_offset(r2) + 8);

    ctx.builder.const_i32(0);
    ctx.builder
        .load_fixed_i32(global_pointers::get_reg_xmm_offset(r1) + 0);
    ctx.builder
        .store_aligned_i32(global_pointers::get_reg_xmm_offset(r2) + 4);
}
pub fn instr_660F63_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F63", modrm_byte, r);
}
pub fn instr_660F63_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F63", r1, r2);
}
pub fn instr_660F64_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F64", modrm_byte, r);
}
pub fn instr_660F64_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F64", r1, r2);
}
pub fn instr_660F65_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F65", modrm_byte, r);
}
pub fn instr_660F65_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F65", r1, r2);
}
pub fn instr_660F66_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F66", modrm_byte, r);
}
pub fn instr_660F66_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F66", r1, r2);
}
pub fn instr_660F67_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F67", modrm_byte, r);
}
pub fn instr_660F67_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F67", r1, r2);
}
pub fn instr_660F68_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F68", modrm_byte, r);
}
pub fn instr_660F68_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F68", r1, r2);
}
pub fn instr_660F69_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F69", modrm_byte, r);
}
pub fn instr_660F69_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F69", r1, r2);
}
pub fn instr_660F6A_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F6A", modrm_byte, r);
}
pub fn instr_660F6A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F6A", r1, r2);
}
pub fn instr_660F6B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F6B", modrm_byte, r);
}
pub fn instr_660F6B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F6B", r1, r2);
}
pub fn instr_660F6C_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F6C", modrm_byte, r);
}
pub fn instr_660F6C_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F6C", r1, r2);
}
pub fn instr_660F6D_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F6D", modrm_byte, r);
}
pub fn instr_660F6D_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F6D", r1, r2);
}

pub fn instr_0F6E_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn2("instr_0F6E")
}
pub fn instr_0F6E_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg32(ctx, r1);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.call_fn2("instr_0F6E")
}

pub fn instr_660F6E_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    ctx.builder.const_i32(0);
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    ctx.builder.extend_unsigned_i32_to_i64();
    ctx.builder
        .store_aligned_i64(global_pointers::get_reg_xmm_offset(r));
    ctx.builder.const_i32(0);
    ctx.builder.const_i64(0);
    ctx.builder
        .store_aligned_i64(global_pointers::get_reg_xmm_offset(r) + 8);
}
pub fn instr_660F6E_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.const_i32(0);
    codegen::gen_get_reg32(ctx, r1);
    ctx.builder.extend_unsigned_i32_to_i64();
    ctx.builder
        .store_aligned_i64(global_pointers::get_reg_xmm_offset(r2));
    ctx.builder.const_i32(0);
    ctx.builder.const_i64(0);
    ctx.builder
        .store_aligned_i64(global_pointers::get_reg_xmm_offset(r2) + 8);
}

pub fn instr_0F6F_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    // XXX: Aligned read or #gp
    codegen::gen_modrm_resolve_safe_read64(ctx, modrm_byte);
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn2_i64_i32("instr_0F6F")
}
pub fn instr_0F6F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.const_i32(r1 as i32);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.call_fn2("instr_0F6F_reg")
}

pub fn instr_660F6F_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    // XXX: Aligned read or #gp
    let dest = global_pointers::get_reg_xmm_offset(r);
    codegen::gen_modrm_resolve_safe_read128(ctx, modrm_byte, dest);
}
pub fn instr_660F6F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) { sse_mov_xmm_xmm(ctx, r1, r2) }
pub fn instr_F30F6F_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    let dest = global_pointers::get_reg_xmm_offset(r);
    codegen::gen_modrm_resolve_safe_read128(ctx, modrm_byte, dest);
}
pub fn instr_F30F6F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) { sse_mov_xmm_xmm(ctx, r1, r2) }

pub fn instr_0F70_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8: u32) {
    codegen::gen_modrm_resolve_safe_read64(ctx, modrm_byte);
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn3_i64_i32_i32("instr_0F70");
}
pub fn instr_0F70_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_mmx_offset(r1) as i32);
    ctx.builder.load_aligned_i64(0);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn3_i64_i32_i32("instr_0F70");
}
pub fn instr_660F70_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8: u32) {
    let src = global_pointers::sse_scratch_register as u32;
    codegen::gen_modrm_resolve_safe_read128(ctx, modrm_byte, src);
    for i in 0..4 {
        ctx.builder.const_i32(0);
        ctx.builder.load_fixed_i32(src + 4 * (imm8 >> 2 * i & 3));
        ctx.builder
            .store_aligned_i32(global_pointers::get_reg_xmm_offset(r) + 4 * i);
    }
}
pub fn instr_660F70_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    codegen::gen_read_reg_xmm128_into_scratch(ctx, r1);
    // TODO: perf: copy less (handle aliased src/dst), use 64-bit loads/stores if possible
    let src = global_pointers::sse_scratch_register as u32;
    for i in 0..4 {
        ctx.builder.const_i32(0);
        ctx.builder.load_fixed_i32(src + 4 * (imm8 >> 2 * i & 3));
        ctx.builder
            .store_aligned_i32(global_pointers::get_reg_xmm_offset(r2) + 4 * i);
    }
}
pub fn instr_F20F70_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8: u32) {
    sse_read128_xmm_mem_imm(ctx, "instr_F20F70", modrm_byte, r, imm8)
}
pub fn instr_F20F70_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    sse_read128_xmm_xmm_imm(ctx, "instr_F20F70", r1, r2, imm8)
}
pub fn instr_F30F70_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32, imm8: u32) {
    sse_read128_xmm_mem_imm(ctx, "instr_F30F70", modrm_byte, r, imm8)
}
pub fn instr_F30F70_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8: u32) {
    sse_read128_xmm_xmm_imm(ctx, "instr_F30F70", r1, r2, imm8)
}

pub fn instr_0F71_2_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_0F71_2_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_0F71_2_reg");
}
pub fn instr_0F71_4_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_0F71_4_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_0F71_4_reg");
}
pub fn instr_0F71_6_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_0F71_6_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_0F71_6_reg");
}

pub fn instr_0F72_2_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_0F72_2_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_0F72_2_reg");
}
pub fn instr_0F72_4_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_0F72_4_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_0F72_4_reg");
}
pub fn instr_0F72_6_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_0F72_6_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_0F72_6_reg");
}

pub fn instr_0F73_2_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_0F73_2_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_0F73_2_reg");
}
pub fn instr_0F73_6_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_0F73_6_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_0F73_6_reg");
}

pub fn instr_660F71_2_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_660F71_2_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_660F71_2_reg");
}
pub fn instr_660F71_4_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_660F71_4_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_660F71_4_reg");
}
pub fn instr_660F71_6_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_660F71_6_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_660F71_6_reg");
}

pub fn instr_660F72_2_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_660F72_2_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_660F72_2_reg");
}
pub fn instr_660F72_4_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_660F72_4_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_660F72_4_reg");
}
pub fn instr_660F72_6_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_660F72_6_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_660F72_6_reg");
}

pub fn instr_660F73_2_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_660F73_2_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_660F73_2_reg");
}
pub fn instr_660F73_3_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_660F73_3_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_660F73_3_reg");
}
pub fn instr_660F73_6_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_660F73_6_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_660F73_6_reg");
}
pub fn instr_660F73_7_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _imm: u32) {
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_660F73_7_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    ctx.builder.const_i32(r as i32);
    ctx.builder.const_i32(imm8 as i32);
    ctx.builder.call_fn2("instr_660F73_7_reg");
}

pub fn instr_0F74_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0F74", modrm_byte, r);
}
pub fn instr_0F74_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0F74", r1, r2);
}
pub fn instr_0F75_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0F75", modrm_byte, r);
}
pub fn instr_0F75_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0F75", r1, r2);
}
pub fn instr_0F76_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0F76", modrm_byte, r);
}
pub fn instr_0F76_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0F76", r1, r2);
}

pub fn instr_660F74_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F74", modrm_byte, r);
}
pub fn instr_660F74_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F74", r1, r2);
}
pub fn instr_660F75_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F75", modrm_byte, r);
}
pub fn instr_660F75_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F75", r1, r2);
}
pub fn instr_660F76_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F76", modrm_byte, r);
}
pub fn instr_660F76_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F76", r1, r2);
}

pub fn instr_660F7C_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F7C", modrm_byte, r);
}
pub fn instr_660F7C_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F7C", r1, r2);
}
pub fn instr_F20F7C_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_F20F7C", modrm_byte, r);
}
pub fn instr_F20F7C_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_F20F7C", r1, r2);
}
pub fn instr_660F7D_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660F7D", modrm_byte, r);
}
pub fn instr_660F7D_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660F7D", r1, r2);
}
pub fn instr_F20F7D_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_F20F7D", modrm_byte, r);
}
pub fn instr_F20F7D_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_F20F7D", r1, r2);
}

pub fn instr_0F7E_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn1_ret("instr_0F7E");
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr_0F7E_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.call_fn1_ret("instr_0F7E");
    codegen::gen_set_reg32(ctx, r1);
}

pub fn instr_660F7E_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    ctx.builder
        .load_fixed_i32(global_pointers::get_reg_xmm_offset(r));
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr_660F7E_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .load_fixed_i32(global_pointers::get_reg_xmm_offset(r2));
    codegen::gen_set_reg32(ctx, r1);
}

pub fn instr_0F7F_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    ctx.builder.const_i32(r as i32);
    ctx.builder.call_fn1_ret_i64("instr_0F7F");
    let value_local = ctx.builder.set_new_local_i64();
    codegen::gen_safe_write64(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local_i64(value_local);
}
pub fn instr_0F7F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.const_i32(r1 as i32);
    ctx.builder.const_i32(r2 as i32);
    ctx.builder.call_fn2("instr_0F7F_reg")
}

pub fn instr_F30F7E_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r) as i32);
    codegen::gen_modrm_resolve_safe_read64(ctx, modrm_byte);
    ctx.builder.store_aligned_i64(0);

    ctx.builder
        .const_i32(global_pointers::get_reg_xmm_offset(r) as i32 + 8);
    ctx.builder.const_i64(0);
    ctx.builder.store_aligned_i64(0);
}
pub fn instr_F30F7E_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    instr_660FD6_reg_jit(ctx, r2, r1)
}

pub fn instr_660F7F_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_0F29_mem_jit(ctx, modrm_byte, r);
}
pub fn instr_660F7F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) { sse_mov_xmm_xmm(ctx, r2, r1) }
pub fn instr_F30F7F_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_0F29_mem_jit(ctx, modrm_byte, r);
}
pub fn instr_F30F7F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) { sse_mov_xmm_xmm(ctx, r2, r1) }

pub fn instr16_0FA0_jit(ctx: &mut JitContext) {
    codegen::gen_get_sreg(ctx, regs::FS);
    let sreg = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &sreg);
    ctx.builder.free_local(sreg);
}
pub fn instr32_0FA0_jit(ctx: &mut JitContext) { codegen::gen_push32_sreg(ctx, regs::FS) }
pub fn instr16_0FA8_jit(ctx: &mut JitContext) {
    codegen::gen_get_sreg(ctx, regs::GS);
    let sreg = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &sreg);
    ctx.builder.free_local(sreg);
}
pub fn instr32_0FA8_jit(ctx: &mut JitContext) { codegen::gen_push32_sreg(ctx, regs::GS) }

pub fn instr16_0FA3_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    gen_bt(
        &mut ctx.builder,
        &ctx.register_locals[r1 as usize],
        &LocalOrImmediate::WasmLocal(&ctx.register_locals[r2 as usize]),
        15,
    )
}
pub fn instr16_0FA3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_get_reg16(ctx, r);
    codegen::sign_extend_i16(ctx.builder);
    ctx.builder.const_i32(3);
    ctx.builder.shr_s_i32();
    ctx.builder.add_i32();
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read8(ctx, &address_local);
    ctx.builder.free_local(address_local);
    let value = ctx.builder.set_new_local();
    gen_bt(
        &mut ctx.builder,
        &value,
        &LocalOrImmediate::WasmLocal(&ctx.register_locals[r as usize]),
        7,
    );
    ctx.builder.free_local(value);
}
pub fn instr32_0FA3_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    gen_bt(
        &mut ctx.builder,
        &ctx.register_locals[r1 as usize],
        &LocalOrImmediate::WasmLocal(&ctx.register_locals[r2 as usize]),
        31,
    )
}
pub fn instr32_0FA3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_get_reg32(ctx, r);
    ctx.builder.const_i32(3);
    ctx.builder.shr_s_i32();
    ctx.builder.add_i32();
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read8(ctx, &address_local);
    ctx.builder.free_local(address_local);
    let value = ctx.builder.set_new_local();
    gen_bt(
        &mut ctx.builder,
        &value,
        &LocalOrImmediate::WasmLocal(&ctx.register_locals[r as usize]),
        7,
    );
    ctx.builder.free_local(value);
}

pub fn instr16_0FAB_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    gen_bts(
        &mut ctx.builder,
        &ctx.register_locals[r1 as usize],
        &LocalOrImmediate::WasmLocal(&ctx.register_locals[r2 as usize]),
        15,
    )
}
pub fn instr16_0FAB_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    gen_bit_rmw(
        ctx,
        modrm_byte,
        &gen_bts,
        &LocalOrImmediate::WasmLocal(&ctx.reg(r)),
        16,
    );
}
pub fn instr32_0FAB_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    gen_bts(
        &mut ctx.builder,
        &ctx.register_locals[r1 as usize],
        &LocalOrImmediate::WasmLocal(&ctx.register_locals[r2 as usize]),
        31,
    )
}
pub fn instr32_0FAB_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    gen_bit_rmw(
        ctx,
        modrm_byte,
        &gen_bts,
        &LocalOrImmediate::WasmLocal(&ctx.reg(r)),
        32,
    );
}

pub fn instr16_0FB3_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    gen_btr(
        &mut ctx.builder,
        &ctx.register_locals[r1 as usize],
        &LocalOrImmediate::WasmLocal(&ctx.register_locals[r2 as usize]),
        15,
    )
}
pub fn instr16_0FB3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    gen_bit_rmw(
        ctx,
        modrm_byte,
        &gen_btr,
        &LocalOrImmediate::WasmLocal(&ctx.reg(r)),
        16,
    );
}
pub fn instr32_0FB3_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    gen_btr(
        &mut ctx.builder,
        &ctx.register_locals[r1 as usize],
        &LocalOrImmediate::WasmLocal(&ctx.register_locals[r2 as usize]),
        31,
    )
}
pub fn instr32_0FB3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    gen_bit_rmw(
        ctx,
        modrm_byte,
        &gen_btr,
        &LocalOrImmediate::WasmLocal(&ctx.reg(r)),
        32,
    );
}

pub fn instr16_0FBB_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    gen_btc(
        &mut ctx.builder,
        &ctx.register_locals[r1 as usize],
        &LocalOrImmediate::WasmLocal(&ctx.register_locals[r2 as usize]),
        15,
    )
}
pub fn instr16_0FBB_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    gen_bit_rmw(
        ctx,
        modrm_byte,
        &gen_btc,
        &LocalOrImmediate::WasmLocal(&ctx.reg(r)),
        16,
    );
}
pub fn instr32_0FBB_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    gen_btc(
        &mut ctx.builder,
        &ctx.register_locals[r1 as usize],
        &LocalOrImmediate::WasmLocal(&ctx.register_locals[r2 as usize]),
        31,
    )
}
pub fn instr32_0FBB_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    gen_bit_rmw(
        ctx,
        modrm_byte,
        &gen_btc,
        &LocalOrImmediate::WasmLocal(&ctx.reg(r)),
        32,
    );
}

pub fn instr16_0FBA_4_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    gen_bt(
        &mut ctx.builder,
        &ctx.register_locals[r as usize],
        &LocalOrImmediate::Immediate(imm8 as i32),
        15,
    )
}
pub fn instr16_0FBA_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm8: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let offset = (imm8 as i32 & 15) >> 3;
    if offset != 0 {
        ctx.builder.const_i32(offset);
        ctx.builder.add_i32();
    }
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read8(ctx, &address_local);
    ctx.builder.free_local(address_local);
    let value = ctx.builder.set_new_local();
    gen_bt(
        &mut ctx.builder,
        &value,
        &LocalOrImmediate::Immediate(imm8 as i32),
        7,
    );
    ctx.builder.free_local(value);
}
pub fn instr32_0FBA_4_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    gen_bt(
        &mut ctx.builder,
        &ctx.register_locals[r as usize],
        &LocalOrImmediate::Immediate(imm8 as i32),
        31,
    )
}
pub fn instr32_0FBA_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm8: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let offset = (imm8 as i32 & 31) >> 3;
    if offset != 0 {
        ctx.builder.const_i32(offset);
        ctx.builder.add_i32();
    }
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read8(ctx, &address_local);
    ctx.builder.free_local(address_local);
    let value = ctx.builder.set_new_local();
    gen_bt(
        &mut ctx.builder,
        &value,
        &LocalOrImmediate::Immediate(imm8 as i32),
        7,
    );
    ctx.builder.free_local(value);
}

pub fn instr16_0FBA_5_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    gen_bts(
        &mut ctx.builder,
        &ctx.register_locals[r as usize],
        &LocalOrImmediate::Immediate(imm8 as i32),
        15,
    )
}
pub fn instr16_0FBA_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm8: u32) {
    gen_bit_rmw(
        ctx,
        modrm_byte,
        &gen_bts,
        &LocalOrImmediate::Immediate(imm8 as i32),
        16,
    );
}
pub fn instr32_0FBA_5_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    gen_bts(
        &mut ctx.builder,
        &ctx.register_locals[r as usize],
        &LocalOrImmediate::Immediate(imm8 as i32),
        31,
    )
}
pub fn instr32_0FBA_5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm8: u32) {
    gen_bit_rmw(
        ctx,
        modrm_byte,
        &gen_bts,
        &LocalOrImmediate::Immediate(imm8 as i32),
        32,
    );
}

pub fn instr16_0FBA_6_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    gen_btr(
        &mut ctx.builder,
        &ctx.register_locals[r as usize],
        &LocalOrImmediate::Immediate(imm8 as i32),
        15,
    )
}
pub fn instr16_0FBA_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm8: u32) {
    gen_bit_rmw(
        ctx,
        modrm_byte,
        &gen_btr,
        &LocalOrImmediate::Immediate(imm8 as i32),
        16,
    );
}
pub fn instr32_0FBA_6_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    gen_btr(
        &mut ctx.builder,
        &ctx.register_locals[r as usize],
        &LocalOrImmediate::Immediate(imm8 as i32),
        31,
    )
}
pub fn instr32_0FBA_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm8: u32) {
    gen_bit_rmw(
        ctx,
        modrm_byte,
        &gen_btr,
        &LocalOrImmediate::Immediate(imm8 as i32),
        32,
    );
}

pub fn instr16_0FBA_7_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    gen_btc(
        &mut ctx.builder,
        &ctx.register_locals[r as usize],
        &LocalOrImmediate::Immediate(imm8 as i32),
        15,
    )
}
pub fn instr16_0FBA_7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm8: u32) {
    gen_bit_rmw(
        ctx,
        modrm_byte,
        &gen_btc,
        &LocalOrImmediate::Immediate(imm8 as i32),
        16,
    );
}
pub fn instr32_0FBA_7_reg_jit(ctx: &mut JitContext, r: u32, imm8: u32) {
    gen_btc(
        &mut ctx.builder,
        &ctx.register_locals[r as usize],
        &LocalOrImmediate::Immediate(imm8 as i32),
        31,
    )
}
pub fn instr32_0FBA_7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, imm8: u32) {
    gen_bit_rmw(
        ctx,
        modrm_byte,
        &gen_btc,
        &LocalOrImmediate::Immediate(imm8 as i32),
        32,
    );
}

pub fn instr_0FAE_5_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte) {
    dbg_log!("Generating #ud for unimplemented instruction: instr_0FAE_5_mem_jit");
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_0FAE_5_reg_jit(_ctx: &mut JitContext, _r: u32) {
    // For this instruction, the processor ignores the r/m field of the ModR/M byte.
}

pub fn instr_0FD1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FD1", modrm_byte, r);
}
pub fn instr_0FD1_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FD1", r1, r2);
}
pub fn instr_0FD2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FD2", modrm_byte, r);
}
pub fn instr_0FD2_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FD2", r1, r2);
}
pub fn instr_0FD3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FD3", modrm_byte, r);
}
pub fn instr_0FD3_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FD3", r1, r2);
}
pub fn instr_0FD4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FD4", modrm_byte, r);
}
pub fn instr_0FD4_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FD4", r1, r2);
}
pub fn instr_0FD5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FD5", modrm_byte, r);
}
pub fn instr_0FD5_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FD5", r1, r2);
}

pub fn instr_0FD7_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _r: u32) {
    codegen::gen_trigger_ud(ctx)
}
pub fn instr_0FD7_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.const_i32(r1 as i32);
    ctx.builder.call_fn1_ret("instr_0FD7");
    codegen::gen_set_reg32(ctx, r2);
}

pub fn instr_0FD8_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FD8", modrm_byte, r);
}
pub fn instr_0FD8_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FD8", r1, r2);
}
pub fn instr_0FD9_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FD9", modrm_byte, r);
}
pub fn instr_0FD9_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FD9", r1, r2);
}
pub fn instr_0FDA_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FDA", modrm_byte, r);
}
pub fn instr_0FDA_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FDA", r1, r2);
}
pub fn instr_0FDB_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FDB", modrm_byte, r);
}
pub fn instr_0FDB_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FDB", r1, r2);
}
pub fn instr_0FDC_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FDC", modrm_byte, r);
}
pub fn instr_0FDC_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FDC", r1, r2);
}
pub fn instr_0FDD_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FDD", modrm_byte, r);
}
pub fn instr_0FDD_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FDD", r1, r2);
}
pub fn instr_0FDE_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FDE", modrm_byte, r);
}
pub fn instr_0FDE_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FDE", r1, r2);
}
pub fn instr_0FDF_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FDF", modrm_byte, r);
}
pub fn instr_0FDF_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FDF", r1, r2);
}

pub fn instr_660FD1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FD1", modrm_byte, r);
}
pub fn instr_660FD1_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FD1", r1, r2);
}
pub fn instr_660FD2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FD2", modrm_byte, r);
}
pub fn instr_660FD2_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FD2", r1, r2);
}
pub fn instr_660FD3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FD3", modrm_byte, r);
}
pub fn instr_660FD3_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FD3", r1, r2);
}
pub fn instr_660FD4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FD4", modrm_byte, r);
}
pub fn instr_660FD4_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FD4", r1, r2);
}
pub fn instr_660FD5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FD5", modrm_byte, r);
}
pub fn instr_660FD5_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FD5", r1, r2);
}

pub fn instr_660FD6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    ctx.builder
        .load_fixed_i64(global_pointers::get_reg_xmm_offset(r));
    let value_local = ctx.builder.set_new_local_i64();
    codegen::gen_safe_write64(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local_i64(value_local);
}
pub fn instr_660FD6_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.const_i32(0);
    ctx.builder
        .load_fixed_i64(global_pointers::get_reg_xmm_offset(r2));
    ctx.builder
        .store_aligned_i64(global_pointers::get_reg_xmm_offset(r1));
    ctx.builder.const_i32(0);
    ctx.builder.const_i64(0);
    ctx.builder
        .store_aligned_i64(global_pointers::get_reg_xmm_offset(r1) + 8);
}

pub fn instr_660FD7_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _r: u32) {
    codegen::gen_trigger_ud(ctx)
}
pub fn instr_660FD7_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.const_i32(r1 as i32);
    ctx.builder.call_fn1_ret("instr_660FD7");
    codegen::gen_set_reg32(ctx, r2);
}

pub fn instr_660FD8_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FD8", modrm_byte, r);
}
pub fn instr_660FD8_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FD8", r1, r2);
}
pub fn instr_660FD9_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FD9", modrm_byte, r);
}
pub fn instr_660FD9_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FD9", r1, r2);
}
pub fn instr_660FDA_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FDA", modrm_byte, r);
}
pub fn instr_660FDA_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FDA", r1, r2);
}
pub fn instr_660FDB_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FDB", modrm_byte, r);
}
pub fn instr_660FDB_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FDB", r1, r2);
}
pub fn instr_660FDC_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FDC", modrm_byte, r);
}
pub fn instr_660FDC_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FDC", r1, r2);
}
pub fn instr_660FDD_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FDD", modrm_byte, r);
}
pub fn instr_660FDD_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FDD", r1, r2);
}
pub fn instr_660FDE_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FDE", modrm_byte, r);
}
pub fn instr_660FDE_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FDE", r1, r2);
}
pub fn instr_660FDF_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FDF", modrm_byte, r);
}
pub fn instr_660FDF_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FDF", r1, r2);
}

pub fn instr_0FE0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FE0", modrm_byte, r);
}
pub fn instr_0FE0_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FE0", r1, r2);
}
pub fn instr_0FE1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FE1", modrm_byte, r);
}
pub fn instr_0FE1_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FE1", r1, r2);
}
pub fn instr_0FE2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FE2", modrm_byte, r);
}
pub fn instr_0FE2_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FE2", r1, r2);
}
pub fn instr_0FE3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FE3", modrm_byte, r);
}
pub fn instr_0FE3_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FE3", r1, r2);
}
pub fn instr_0FE4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FE4", modrm_byte, r);
}
pub fn instr_0FE4_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FE4", r1, r2);
}
pub fn instr_0FE5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FE5", modrm_byte, r);
}
pub fn instr_0FE5_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FE5", r1, r2);
}

pub fn instr_0FE8_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FE8", modrm_byte, r);
}
pub fn instr_0FE8_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FE8", r1, r2);
}
pub fn instr_0FE9_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FE9", modrm_byte, r);
}
pub fn instr_0FE9_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FE9", r1, r2);
}
pub fn instr_0FEA_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FEA", modrm_byte, r);
}
pub fn instr_0FEA_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FEA", r1, r2);
}
pub fn instr_0FEB_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FEB", modrm_byte, r);
}
pub fn instr_0FEB_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FEB", r1, r2);
}
pub fn instr_0FEC_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FEC", modrm_byte, r);
}
pub fn instr_0FEC_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FEC", r1, r2);
}
pub fn instr_0FED_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FED", modrm_byte, r);
}
pub fn instr_0FED_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FED", r1, r2);
}
pub fn instr_0FEE_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FEE", modrm_byte, r);
}
pub fn instr_0FEE_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FEE", r1, r2);
}
pub fn instr_0FEF_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FEF", modrm_byte, r);
}
pub fn instr_0FEF_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FEF", r1, r2);
}

pub fn instr_660FE0_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FE0", modrm_byte, r);
}
pub fn instr_660FE0_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FE0", r1, r2);
}
pub fn instr_660FE1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FE1", modrm_byte, r);
}
pub fn instr_660FE1_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FE1", r1, r2);
}
pub fn instr_660FE2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FE2", modrm_byte, r);
}
pub fn instr_660FE2_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FE2", r1, r2);
}
pub fn instr_660FE3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FE3", modrm_byte, r);
}
pub fn instr_660FE3_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FE3", r1, r2);
}
pub fn instr_660FE4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FE4", modrm_byte, r);
}
pub fn instr_660FE4_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FE4", r1, r2);
}
pub fn instr_660FE5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FE5", modrm_byte, r);
}
pub fn instr_660FE5_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FE5", r1, r2);
}

pub fn instr_660FE6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FE6", modrm_byte, r);
}
pub fn instr_660FE6_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FE6", r1, r2);
}
pub fn instr_F20FE6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_F20FE6", modrm_byte, r);
}
pub fn instr_F20FE6_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_F20FE6", r1, r2);
}
pub fn instr_F30FE6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read64_xmm_mem(ctx, "instr_F30FE6", modrm_byte, r);
}
pub fn instr_F30FE6_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read64_xmm_xmm(ctx, "instr_F30FE6", r1, r2);
}

pub fn instr_660FE7_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    instr_0F29_mem_jit(ctx, modrm_byte, r);
}
pub fn instr_660FE7_reg_jit(ctx: &mut JitContext, _r1: u32, _r2: u32) {
    codegen::gen_trigger_ud(ctx);
}

pub fn instr_660FE8_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FE8", modrm_byte, r);
}
pub fn instr_660FE8_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FE8", r1, r2);
}
pub fn instr_660FE9_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FE9", modrm_byte, r);
}
pub fn instr_660FE9_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FE9", r1, r2);
}
pub fn instr_660FEA_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FEA", modrm_byte, r);
}
pub fn instr_660FEA_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FEA", r1, r2);
}
pub fn instr_660FEB_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FEB", modrm_byte, r);
}
pub fn instr_660FEB_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FEB", r1, r2);
}
pub fn instr_660FEC_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FEC", modrm_byte, r);
}
pub fn instr_660FEC_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FEC", r1, r2);
}
pub fn instr_660FED_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FED", modrm_byte, r);
}
pub fn instr_660FED_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FED", r1, r2);
}
pub fn instr_660FEE_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FEE", modrm_byte, r);
}
pub fn instr_660FEE_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FEE", r1, r2);
}
pub fn instr_660FEF_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FEF", modrm_byte, r);
}
pub fn instr_660FEF_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FEF", r1, r2);
}

pub fn instr_0FF1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FF1", modrm_byte, r);
}
pub fn instr_0FF1_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FF1", r1, r2);
}
pub fn instr_0FF2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FF2", modrm_byte, r);
}
pub fn instr_0FF2_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FF2", r1, r2);
}
pub fn instr_0FF3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FF3", modrm_byte, r);
}
pub fn instr_0FF3_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FF3", r1, r2);
}
pub fn instr_0FF4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FF4", modrm_byte, r);
}
pub fn instr_0FF4_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FF4", r1, r2);
}
pub fn instr_0FF5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FF5", modrm_byte, r);
}
pub fn instr_0FF5_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FF5", r1, r2);
}
pub fn instr_0FF6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FF6", modrm_byte, r);
}
pub fn instr_0FF6_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FF6", r1, r2);
}

pub fn instr_0FF7_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _r: u32) {
    codegen::gen_trigger_ud(ctx)
}
pub fn instr_0FF7_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_previous_eip_offset_from_eip_with_low_bits(
        ctx.builder,
        ctx.start_of_current_instruction as i32 & 0xFFF,
    );

    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.const_i32(r1 as i32);
    ctx.builder.const_i32(r2 as i32);
    if ctx.cpu.asize_32() {
        codegen::gen_get_reg32(ctx, regs::EDI);
    }
    else {
        codegen::gen_get_reg16(ctx, regs::DI);
    }
    jit_add_seg_offset(ctx, regs::DS);
    ctx.builder.call_fn3("maskmovq");
    codegen::gen_move_registers_from_memory_to_locals(ctx);

    codegen::gen_get_page_fault(ctx.builder);
    ctx.builder.if_void();
    codegen::gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.br(ctx.exit_label);
    ctx.builder.block_end();
}

pub fn instr_0FF8_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FF8", modrm_byte, r);
}
pub fn instr_0FF8_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FF8", r1, r2);
}
pub fn instr_0FF9_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FF9", modrm_byte, r);
}
pub fn instr_0FF9_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FF9", r1, r2);
}
pub fn instr_0FFA_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FFA", modrm_byte, r);
}
pub fn instr_0FFA_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FFA", r1, r2);
}
pub fn instr_0FFB_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FFB", modrm_byte, r);
}
pub fn instr_0FFB_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FFB", r1, r2);
}
pub fn instr_0FFC_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FFC", modrm_byte, r);
}
pub fn instr_0FFC_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FFC", r1, r2);
}
pub fn instr_0FFD_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FFD", modrm_byte, r);
}
pub fn instr_0FFD_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FFD", r1, r2);
}
pub fn instr_0FFE_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    mmx_read64_mm_mem(ctx, "instr_0FFE", modrm_byte, r);
}
pub fn instr_0FFE_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    mmx_read64_mm_mm(ctx, "instr_0FFE", r1, r2);
}

pub fn instr_660FF1_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FF1", modrm_byte, r);
}
pub fn instr_660FF1_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FF1", r1, r2);
}
pub fn instr_660FF2_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FF2", modrm_byte, r);
}
pub fn instr_660FF2_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FF2", r1, r2);
}
pub fn instr_660FF3_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FF3", modrm_byte, r);
}
pub fn instr_660FF3_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FF3", r1, r2);
}
pub fn instr_660FF4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FF4", modrm_byte, r);
}
pub fn instr_660FF4_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FF4", r1, r2);
}
pub fn instr_660FF5_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FF5", modrm_byte, r);
}
pub fn instr_660FF5_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FF5", r1, r2);
}
pub fn instr_660FF6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FF6", modrm_byte, r);
}
pub fn instr_660FF6_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FF6", r1, r2);
}

pub fn instr_660FF7_mem_jit(ctx: &mut JitContext, _modrm_byte: ModrmByte, _r: u32) {
    codegen::gen_trigger_ud(ctx)
}
pub fn instr_660FF7_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_previous_eip_offset_from_eip_with_low_bits(
        ctx.builder,
        ctx.start_of_current_instruction as i32 & 0xFFF,
    );

    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.const_i32(r1 as i32);
    ctx.builder.const_i32(r2 as i32);
    if ctx.cpu.asize_32() {
        codegen::gen_get_reg32(ctx, regs::EDI);
    }
    else {
        codegen::gen_get_reg16(ctx, regs::DI);
    }
    jit_add_seg_offset(ctx, regs::DS);
    ctx.builder.call_fn3("maskmovdqu");
    codegen::gen_move_registers_from_memory_to_locals(ctx);

    codegen::gen_get_page_fault(ctx.builder);
    ctx.builder.if_void();
    codegen::gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.br(ctx.exit_label);
    ctx.builder.block_end();
}

pub fn instr_660FF8_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FF8", modrm_byte, r);
}
pub fn instr_660FF8_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FF8", r1, r2);
}
pub fn instr_660FF9_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FF9", modrm_byte, r);
}
pub fn instr_660FF9_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FF9", r1, r2);
}
pub fn instr_660FFA_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FFA", modrm_byte, r);
}
pub fn instr_660FFA_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FFA", r1, r2);
}
pub fn instr_660FFB_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FFB", modrm_byte, r);
}
pub fn instr_660FFB_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FFB", r1, r2);
}
pub fn instr_660FFC_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FFC", modrm_byte, r);
}
pub fn instr_660FFC_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FFC", r1, r2);
}
pub fn instr_660FFD_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FFD", modrm_byte, r);
}
pub fn instr_660FFD_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FFD", r1, r2);
}
pub fn instr_660FFE_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    sse_read128_xmm_mem(ctx, "instr_660FFE", modrm_byte, r);
}
pub fn instr_660FFE_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    sse_read128_xmm_xmm(ctx, "instr_660FFE", r1, r2);
}
