#![allow(non_snake_case)]

use codegen;
use cpu::BitSize;
use cpu_context::CpuContext;
use global_pointers;
use jit::JitContext;
use modrm;
use modrm::jit_add_seg_offset;
use prefix::SEG_PREFIX_ZERO;
use prefix::{PREFIX_66, PREFIX_67, PREFIX_F2, PREFIX_F3};
use regs;
use regs::{AX, BP, BX, CX, DI, DX, SI, SP};
use regs::{CS, DS, ES, FS, GS, SS};
use regs::{EAX, EBP, EBX, ECX, EDI, EDX, ESI, ESP};
use wasmgen::module_init::WasmBuilder;
use wasmgen::wasm_util::WasmBuf;

pub fn jit_instruction(cpu: &mut CpuContext, builder: &mut WasmBuilder, instr_flags: &mut u32) {
    cpu.prefixes = 0;
    let start_of_current_instruction = cpu.eip;
    let ctx = &mut JitContext {
        cpu,
        builder,
        start_of_current_instruction,
    };
    ::gen::jit::jit(
        ctx.cpu.read_imm8() as u32 | (ctx.cpu.osize_32() as u32) << 8,
        ctx,
        instr_flags,
    );
}

pub fn jit_handle_prefix(ctx: &mut JitContext, instr_flags: &mut u32) {
    ::gen::jit::jit(
        ctx.cpu.read_imm8() as u32 | (ctx.cpu.osize_32() as u32) << 8,
        ctx,
        instr_flags,
    );
    codegen::gen_clear_prefixes(ctx);
}

pub fn jit_handle_segment_prefix(segment: u32, ctx: &mut JitContext, instr_flags: &mut u32) {
    dbg_assert!(segment <= 5);
    ctx.cpu.prefixes |= segment + 1;
    // TODO: Could merge multiple prefix updates into one
    codegen::gen_add_prefix_bits(ctx, segment + 1);
    jit_handle_prefix(ctx, instr_flags)
}

pub fn instr16_0F_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    ::gen::jit0f_16::jit(ctx.cpu.read_imm8(), ctx, instr_flags)
}
pub fn instr32_0F_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    ::gen::jit0f_32::jit(ctx.cpu.read_imm8(), ctx, instr_flags)
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
    // TODO: Could merge multiple prefix updates into one
    codegen::gen_add_prefix_bits(ctx, PREFIX_66);
    jit_handle_prefix(ctx, instr_flags)
}
pub fn instr_67_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    ctx.cpu.prefixes |= PREFIX_67;
    // TODO: Could merge multiple prefix updates into one
    codegen::gen_add_prefix_bits(ctx, PREFIX_67);
    jit_handle_prefix(ctx, instr_flags)
}
pub fn instr_F0_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    // lock: Ignore
    jit_handle_prefix(ctx, instr_flags)
}
pub fn instr_F2_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    ctx.cpu.prefixes |= PREFIX_F2;
    // string/sse prefix: Don't generate code to update prefixes at runtime. This means runtime
    // instructions can't inspect the prefixes for this flags
    jit_handle_prefix(ctx, instr_flags)
}
pub fn instr_F3_jit(ctx: &mut JitContext, instr_flags: &mut u32) {
    ctx.cpu.prefixes |= PREFIX_F3;
    // string/sse prefix: Don't generate code to update prefixes at runtime. This means runtime
    // instructions can't inspect the prefixes for this flags
    jit_handle_prefix(ctx, instr_flags)
}

fn push16_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg16(ctx, r);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &value_local);
    ctx.builder.free_local(value_local);
}
fn push32_reg_jit(ctx: &mut JitContext, r: u32) {
    ctx.builder
        .instruction_body
        .load_aligned_i32(global_pointers::get_reg32_offset(r));
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push32(ctx, &value_local);
    ctx.builder.free_local(value_local);
}
fn push16_imm_jit(ctx: &mut JitContext, imm: u32) {
    ctx.builder.instruction_body.const_i32(imm as i32);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &value_local);
    ctx.builder.free_local(value_local);
}
fn push32_imm_jit(ctx: &mut JitContext, imm: u32) {
    ctx.builder.instruction_body.const_i32(imm as i32);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push32(ctx, &value_local);
    ctx.builder.free_local(value_local);
}
fn push16_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &value_local);
    ctx.builder.free_local(value_local);
}
fn push32_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read32(ctx);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push32(ctx, &value_local);
    ctx.builder.free_local(value_local);
}

fn pop16_reg_jit(ctx: &mut JitContext, reg: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(reg) as i32);
    codegen::gen_pop16(ctx);
    ctx.builder.instruction_body.store_aligned_u16(0);
}

fn pop32_reg_jit(ctx: &mut JitContext, reg: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(reg) as i32);
    codegen::gen_pop32s(ctx);
    ctx.builder.instruction_body.store_aligned_i32(0);
}

fn group_arith_al_imm8(ctx: &mut JitContext, op: &str, imm8: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg8_offset(0) as i32);
    codegen::gen_get_reg8(ctx, 0);
    ctx.builder.instruction_body.const_i32(imm8 as i32);
    codegen::gen_call_fn2_ret(ctx.builder, op);
    ctx.builder.instruction_body.store_u8(0);
}

fn group_arith_ax_imm16(ctx: &mut JitContext, op: &str, imm16: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(0) as i32);
    codegen::gen_get_reg16(ctx, 0);
    ctx.builder.instruction_body.const_i32(imm16 as i32);
    codegen::gen_call_fn2_ret(ctx.builder, op);
    ctx.builder.instruction_body.store_aligned_u16(0);
}

fn group_arith_eax_imm32(ctx: &mut JitContext, op: &str, imm32: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(0) as i32);
    codegen::gen_get_reg32(ctx, 0);
    ctx.builder.instruction_body.const_i32(imm32 as i32);
    codegen::gen_call_fn2_ret(ctx.builder, op);
    ctx.builder.instruction_body.store_aligned_i32(0);
}

macro_rules! define_instruction_read8(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read8(ctx);
            codegen::gen_get_reg8(ctx, r);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_get_reg8(ctx, r1);
            codegen::gen_get_reg8(ctx, r2);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read8(ctx);
            ctx.builder.instruction_body.const_i32(make_imm_read!(ctx, $imm) as i32);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, imm: u32) {
            codegen::gen_get_reg8(ctx, r1);
            ctx.builder.instruction_body.const_i32(imm as i32);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }
    );
);

macro_rules! define_instruction_read16(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read16(ctx);
            codegen::gen_get_reg16(ctx, r);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_get_reg16(ctx, r1);
            codegen::gen_get_reg16(ctx, r2);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read16(ctx);
            ctx.builder.instruction_body.const_i32(make_imm_read!(ctx, $imm) as i32);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, imm: u32) {
            codegen::gen_get_reg16(ctx, r1);
            ctx.builder.instruction_body.const_i32(imm as i32);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }
    );
);

macro_rules! define_instruction_read32(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read32(ctx);
            codegen::gen_get_reg32(ctx, r);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_get_reg32(ctx, r1);
            codegen::gen_get_reg32(ctx, r2);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }
    );

    ($fn:expr, $name_mem:ident, $name_reg:ident, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read32(ctx);
            ctx.builder.instruction_body.const_i32(make_imm_read!(ctx, $imm) as i32);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, imm: u32) {
            codegen::gen_get_reg32(ctx, r1);
            ctx.builder.instruction_body.const_i32(imm as i32);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }
    );
);

macro_rules! define_instruction_write_reg8(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg8_offset(r) as i32);
            codegen::gen_get_reg8(ctx, r);
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read8(ctx);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_u8(0);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg8_offset(r2) as i32);
            codegen::gen_get_reg8(ctx, r2);
            codegen::gen_get_reg8(ctx, r1);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_u8(0);
        }
    )
);

macro_rules! define_instruction_write_reg16(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r) as i32);
            codegen::gen_get_reg16(ctx, r);
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read16(ctx);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_u16(0);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r2) as i32);
            codegen::gen_get_reg16(ctx, r2);
            codegen::gen_get_reg16(ctx, r1);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_u16(0);
        }
    )
);

macro_rules! define_instruction_write_reg32(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r) as i32);
            codegen::gen_get_reg32(ctx, r);
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read32(ctx);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_i32(0);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r2) as i32);
            codegen::gen_get_reg32(ctx, r2);
            codegen::gen_get_reg32(ctx, r1);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_i32(0);
        }
    )
);

macro_rules! mask_imm(
    ($imm:expr, imm8_5bits) => { $imm & 31 };
    ($imm:expr, imm8) => { $imm };
    ($imm:expr, imm8s) => { $imm };
    ($imm:expr, imm16) => { $imm };
    ($imm:expr, imm32) => { $imm };
);

macro_rules! make_imm_read(
    ($ctx:expr, imm8_5bits) => { $ctx.cpu.read_imm8() & 31 };
    ($ctx:expr, imm8) => { $ctx.cpu.read_imm8() };
    ($ctx:expr, imm8s) => { $ctx.cpu.read_imm8s() };
    ($ctx:expr, imm16) => { $ctx.cpu.read_imm16() };
    ($ctx:expr, imm32) => { $ctx.cpu.read_imm32() };
);

macro_rules! define_instruction_read_write_mem8(
    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, reg) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            codegen::gen_safe_read_write(ctx, BitSize::BYTE, &address_local, &|ref mut ctx| {
                codegen::gen_get_reg8(ctx, r);
                codegen::gen_call_fn2_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(r as i32);
                codegen::gen_call_fn2(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg8_offset(r1) as i32);
            codegen::gen_get_reg8(ctx, r1);
            codegen::gen_get_reg8(ctx, r2);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_u8(0);
        }
    );

    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            let imm = make_imm_read!(ctx, $imm) as i32;
            codegen::gen_safe_read_write(ctx, BitSize::BYTE, &address_local, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(imm as i32);
                codegen::gen_call_fn2_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(imm as i32);
                codegen::gen_call_fn2(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, imm: u32) {
            let imm = mask_imm!(imm, $imm);
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg8_offset(r1) as i32);
            codegen::gen_get_reg8(ctx, r1);
            ctx.builder.instruction_body.const_i32(imm as i32);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_u8(0);
        }
    );
);

macro_rules! define_instruction_read_write_mem16(
    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, reg) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            codegen::gen_safe_read_write(ctx, BitSize::WORD, &address_local, &|ref mut ctx| {
                codegen::gen_get_reg16(ctx, r);
                codegen::gen_call_fn2_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(r as i32);
                codegen::gen_call_fn2(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r1) as i32);
            codegen::gen_get_reg16(ctx, r1);
            codegen::gen_get_reg16(ctx, r2);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_u16(0);
        }
    );

    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, constant_one) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            codegen::gen_safe_read_write(ctx, BitSize::WORD, &address_local, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(1);
                codegen::gen_call_fn2_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                codegen::gen_call_fn1(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r1) as i32);
            codegen::gen_get_reg16(ctx, r1);
            ctx.builder.instruction_body.const_i32(1);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_u16(0);
        }
    );

    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, cl) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            codegen::gen_safe_read_write(ctx, BitSize::WORD, &address_local, &|ref mut ctx| {
                codegen::gen_get_reg8(ctx, regs::CL);
                ctx.builder.instruction_body.const_i32(31);
                ctx.builder.instruction_body.and_i32();
                codegen::gen_call_fn2_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                codegen::gen_call_fn1(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r1) as i32);
            codegen::gen_get_reg16(ctx, r1);
            codegen::gen_get_reg8(ctx, regs::CL);
                ctx.builder.instruction_body.const_i32(31);
                ctx.builder.instruction_body.and_i32();
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_u16(0);
        }
    );

    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, reg, cl) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            codegen::gen_safe_read_write(ctx, BitSize::WORD, &address_local, &|ref mut ctx| {
                codegen::gen_get_reg16(ctx, r);
                codegen::gen_get_reg8(ctx, regs::CL);
                ctx.builder.instruction_body.const_i32(31);
                ctx.builder.instruction_body.and_i32();
                codegen::gen_call_fn3_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(r as i32);
                codegen::gen_call_fn2(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r1) as i32);
            codegen::gen_get_reg16(ctx, r1);
            codegen::gen_get_reg16(ctx, r2);
            codegen::gen_get_reg8(ctx, regs::CL);
            ctx.builder.instruction_body.const_i32(31);
            ctx.builder.instruction_body.and_i32();
            codegen::gen_call_fn3_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_u16(0);
        }
    );

    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, reg, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            let imm = make_imm_read!(ctx, $imm) as i32;
            codegen::gen_safe_read_write(ctx, BitSize::WORD, &address_local, &|ref mut ctx| {
                codegen::gen_get_reg16(ctx, r);
                ctx.builder.instruction_body.const_i32(imm as i32);
                codegen::gen_call_fn3_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(r as i32);
                ctx.builder.instruction_body.const_i32(imm as i32);
                codegen::gen_call_fn3(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32, imm: u32) {
            let imm = mask_imm!(imm, $imm);
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r1) as i32);
            codegen::gen_get_reg16(ctx, r1);
            codegen::gen_get_reg16(ctx, r2);
            ctx.builder.instruction_body.const_i32(imm as i32);
            codegen::gen_call_fn3_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_u16(0);
        }
    );

    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, none) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            codegen::gen_safe_read_write(ctx, BitSize::WORD, &address_local, &|ref mut ctx| {
                codegen::gen_call_fn1_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                codegen::gen_call_fn1(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r1) as i32);
            codegen::gen_get_reg16(ctx, r1);
            codegen::gen_call_fn1_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_u16(0);
        }
    );

    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            let imm = make_imm_read!(ctx, $imm) as i32;
            codegen::gen_safe_read_write(ctx, BitSize::WORD, &address_local, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(imm as i32);
                codegen::gen_call_fn2_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(imm as i32);
                codegen::gen_call_fn2(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, imm: u32) {
            let imm = mask_imm!(imm, $imm);
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r1) as i32);
            codegen::gen_get_reg16(ctx, r1);
            ctx.builder.instruction_body.const_i32(imm as i32);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_u16(0);
        }
    );
);

macro_rules! define_instruction_read_write_mem32(
    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, reg) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            codegen::gen_safe_read_write(ctx, BitSize::DWORD, &address_local, &|ref mut ctx| {
                codegen::gen_get_reg32(ctx, r);
                codegen::gen_call_fn2_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(r as i32);
                codegen::gen_call_fn2(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r1) as i32);
            codegen::gen_get_reg32(ctx, r1);
            codegen::gen_get_reg32(ctx, r2);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_i32(0);
        }
    );

    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, constant_one) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            codegen::gen_safe_read_write(ctx, BitSize::DWORD, &address_local, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(1);
                codegen::gen_call_fn2_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                codegen::gen_call_fn1(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r1) as i32);
            codegen::gen_get_reg32(ctx, r1);
            ctx.builder.instruction_body.const_i32(1);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_i32(0);
        }
    );

    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, cl) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            codegen::gen_safe_read_write(ctx, BitSize::DWORD, &address_local, &|ref mut ctx| {
                codegen::gen_get_reg8(ctx, regs::CL);
                ctx.builder.instruction_body.const_i32(31);
                ctx.builder.instruction_body.and_i32();
                codegen::gen_call_fn2_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                codegen::gen_call_fn1(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r1) as i32);
            codegen::gen_get_reg32(ctx, r1);
            codegen::gen_get_reg8(ctx, regs::CL);
                ctx.builder.instruction_body.const_i32(31);
                ctx.builder.instruction_body.and_i32();
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_i32(0);
        }
    );

    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, reg, cl) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            codegen::gen_safe_read_write(ctx, BitSize::DWORD, &address_local, &|ref mut ctx| {
                codegen::gen_get_reg32(ctx, r);
                codegen::gen_get_reg8(ctx, regs::CL);
                ctx.builder.instruction_body.const_i32(31);
                ctx.builder.instruction_body.and_i32();
                codegen::gen_call_fn3_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(r as i32);
                codegen::gen_call_fn2(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r1) as i32);
            codegen::gen_get_reg32(ctx, r1);
            codegen::gen_get_reg32(ctx, r2);
            codegen::gen_get_reg8(ctx, regs::CL);
            ctx.builder.instruction_body.const_i32(31);
            ctx.builder.instruction_body.and_i32();
            codegen::gen_call_fn3_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_i32(0);
        }
    );

    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, reg, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            let imm = make_imm_read!(ctx, $imm) as i32;
            codegen::gen_safe_read_write(ctx, BitSize::DWORD, &address_local, &|ref mut ctx| {
                codegen::gen_get_reg32(ctx, r);
                ctx.builder.instruction_body.const_i32(imm as i32);
                codegen::gen_call_fn3_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(r as i32);
                ctx.builder.instruction_body.const_i32(imm as i32);
                codegen::gen_call_fn3(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32, imm: u32) {
            let imm = mask_imm!(imm, $imm);
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r1) as i32);
            codegen::gen_get_reg32(ctx, r1);
            codegen::gen_get_reg32(ctx, r2);
            ctx.builder.instruction_body.const_i32(imm as i32);
            codegen::gen_call_fn3_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_i32(0);
        }
    );

    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, none) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            codegen::gen_safe_read_write(ctx, BitSize::DWORD, &address_local, &|ref mut ctx| {
                codegen::gen_call_fn1_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                codegen::gen_call_fn1(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r1) as i32);
            codegen::gen_get_reg32(ctx, r1);
            codegen::gen_call_fn1_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_i32(0);
        }
    );

    ($fn:expr, $fallback_fn:expr, $name_mem:ident, $name_reg:ident, $imm:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            let imm = make_imm_read!(ctx, $imm) as i32;
            codegen::gen_safe_read_write(ctx, BitSize::DWORD, &address_local, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(imm as i32);
                codegen::gen_call_fn2_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(imm as i32);
                codegen::gen_call_fn2(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, imm: u32) {
            let imm = mask_imm!(imm, $imm);
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r1) as i32);
            codegen::gen_get_reg32(ctx, r1);
            ctx.builder.instruction_body.const_i32(imm as i32);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_i32(0);
        }
    );
);

define_instruction_read_write_mem8!(
    "add8",
    "instr_00_mem",
    instr_00_mem_jit,
    instr_00_reg_jit,
    reg
);
define_instruction_read_write_mem16!(
    "add16",
    "instr16_01_mem",
    instr16_01_mem_jit,
    instr16_01_reg_jit,
    reg
);
define_instruction_read_write_mem32!(
    "add32",
    "instr32_01_mem",
    instr32_01_mem_jit,
    instr32_01_reg_jit,
    reg
);

define_instruction_write_reg8!("add8", instr_02_mem_jit, instr_02_reg_jit);
define_instruction_write_reg16!("add16", instr16_03_mem_jit, instr16_03_reg_jit);
define_instruction_write_reg32!("add32", instr32_03_mem_jit, instr32_03_reg_jit);

pub fn instr_04_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, "add8", imm8); }
pub fn instr16_05_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "add16", imm16);
}
pub fn instr32_05_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, "add32", imm32);
}

define_instruction_read_write_mem8!(
    "or8",
    "instr_08_mem",
    instr_08_mem_jit,
    instr_08_reg_jit,
    reg
);
define_instruction_read_write_mem16!(
    "or16",
    "instr16_09_mem",
    instr16_09_mem_jit,
    instr16_09_reg_jit,
    reg
);
define_instruction_read_write_mem32!(
    "or32",
    "instr32_09_mem",
    instr32_09_mem_jit,
    instr32_09_reg_jit,
    reg
);

define_instruction_write_reg8!("or8", instr_0A_mem_jit, instr_0A_reg_jit);
define_instruction_write_reg16!("or16", instr16_0B_mem_jit, instr16_0B_reg_jit);
define_instruction_write_reg32!("or32", instr32_0B_mem_jit, instr32_0B_reg_jit);

pub fn instr_0C_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, "or8", imm8); }
pub fn instr16_0D_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "or16", imm16);
}
pub fn instr32_0D_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, "or32", imm32);
}

define_instruction_read_write_mem8!(
    "adc8",
    "instr_10_mem",
    instr_10_mem_jit,
    instr_10_reg_jit,
    reg
);
define_instruction_read_write_mem16!(
    "adc16",
    "instr16_11_mem",
    instr16_11_mem_jit,
    instr16_11_reg_jit,
    reg
);
define_instruction_read_write_mem32!(
    "adc32",
    "instr32_11_mem",
    instr32_11_mem_jit,
    instr32_11_reg_jit,
    reg
);

define_instruction_write_reg8!("adc8", instr_12_mem_jit, instr_12_reg_jit);
define_instruction_write_reg16!("adc16", instr16_13_mem_jit, instr16_13_reg_jit);
define_instruction_write_reg32!("adc32", instr32_13_mem_jit, instr32_13_reg_jit);

pub fn instr_14_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, "adc8", imm8); }
pub fn instr16_15_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "adc16", imm16);
}
pub fn instr32_15_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, "adc32", imm32);
}

define_instruction_read_write_mem8!(
    "sbb8",
    "instr_18_mem",
    instr_18_mem_jit,
    instr_18_reg_jit,
    reg
);
define_instruction_read_write_mem16!(
    "sbb16",
    "instr16_19_mem",
    instr16_19_mem_jit,
    instr16_19_reg_jit,
    reg
);
define_instruction_read_write_mem32!(
    "sbb32",
    "instr32_19_mem",
    instr32_19_mem_jit,
    instr32_19_reg_jit,
    reg
);

define_instruction_write_reg8!("sbb8", instr_1A_mem_jit, instr_1A_reg_jit);
define_instruction_write_reg16!("sbb16", instr16_1B_mem_jit, instr16_1B_reg_jit);
define_instruction_write_reg32!("sbb32", instr32_1B_mem_jit, instr32_1B_reg_jit);

pub fn instr_1C_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, "sbb8", imm8); }
pub fn instr16_1D_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "sbb16", imm16);
}
pub fn instr32_1D_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, "sbb32", imm32);
}

define_instruction_read_write_mem8!(
    "and8",
    "instr_20_mem",
    instr_20_mem_jit,
    instr_20_reg_jit,
    reg
);
define_instruction_read_write_mem16!(
    "and16",
    "instr16_21_mem",
    instr16_21_mem_jit,
    instr16_21_reg_jit,
    reg
);
define_instruction_read_write_mem32!(
    "and32",
    "instr32_21_mem",
    instr32_21_mem_jit,
    instr32_21_reg_jit,
    reg
);

define_instruction_write_reg8!("and8", instr_22_mem_jit, instr_22_reg_jit);
define_instruction_write_reg16!("and16", instr16_23_mem_jit, instr16_23_reg_jit);
define_instruction_write_reg32!("and32", instr32_23_mem_jit, instr32_23_reg_jit);

pub fn instr_24_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, "and8", imm8); }
pub fn instr16_25_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "and16", imm16);
}
pub fn instr32_25_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, "and32", imm32);
}

define_instruction_read_write_mem8!(
    "sub8",
    "instr_28_mem",
    instr_28_mem_jit,
    instr_28_reg_jit,
    reg
);
define_instruction_read_write_mem16!(
    "sub16",
    "instr16_29_mem",
    instr16_29_mem_jit,
    instr16_29_reg_jit,
    reg
);
define_instruction_read_write_mem32!(
    "sub32",
    "instr32_29_mem",
    instr32_29_mem_jit,
    instr32_29_reg_jit,
    reg
);

define_instruction_write_reg8!("sub8", instr_2A_mem_jit, instr_2A_reg_jit);
define_instruction_write_reg16!("sub16", instr16_2B_mem_jit, instr16_2B_reg_jit);
define_instruction_write_reg32!("sub32", instr32_2B_mem_jit, instr32_2B_reg_jit);

pub fn instr_2C_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, "sub8", imm8); }
pub fn instr16_2D_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "sub16", imm16);
}
pub fn instr32_2D_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, "sub32", imm32);
}

define_instruction_read_write_mem8!(
    "xor8",
    "instr_30_mem",
    instr_30_mem_jit,
    instr_30_reg_jit,
    reg
);
define_instruction_read_write_mem16!(
    "xor16",
    "instr16_31_mem",
    instr16_31_mem_jit,
    instr16_31_reg_jit,
    reg
);
define_instruction_read_write_mem32!(
    "xor32",
    "instr32_31_mem",
    instr32_31_mem_jit,
    instr32_31_reg_jit,
    reg
);

define_instruction_write_reg8!("xor8", instr_32_mem_jit, instr_32_reg_jit);
define_instruction_write_reg16!("xor16", instr16_33_mem_jit, instr16_33_reg_jit);
define_instruction_write_reg32!("xor32", instr32_33_mem_jit, instr32_33_reg_jit);

pub fn instr_34_jit(ctx: &mut JitContext, imm8: u32) { group_arith_al_imm8(ctx, "xor8", imm8); }
pub fn instr16_35_jit(ctx: &mut JitContext, imm16: u32) {
    group_arith_ax_imm16(ctx, "xor16", imm16);
}
pub fn instr32_35_jit(ctx: &mut JitContext, imm32: u32) {
    group_arith_eax_imm32(ctx, "xor32", imm32);
}

define_instruction_read8!("cmp8", instr_38_mem_jit, instr_38_reg_jit);
define_instruction_read16!("cmp16", instr16_39_mem_jit, instr16_39_reg_jit);
define_instruction_read32!("cmp32", instr32_39_mem_jit, instr32_39_reg_jit);

pub fn instr_3A_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    codegen::gen_get_reg8(ctx, r);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read8(ctx);
    codegen::gen_call_fn2(ctx.builder, "cmp8")
}

pub fn instr_3A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg8(ctx, r2);
    codegen::gen_get_reg8(ctx, r1);
    codegen::gen_call_fn2(ctx.builder, "cmp8")
}

pub fn instr16_3B_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    codegen::gen_get_reg16(ctx, r);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    codegen::gen_call_fn2(ctx.builder, "cmp16")
}

pub fn instr16_3B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg16(ctx, r2);
    codegen::gen_get_reg16(ctx, r1);
    codegen::gen_call_fn2(ctx.builder, "cmp16")
}

pub fn instr32_3B_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    codegen::gen_get_reg32(ctx, r);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read32(ctx);
    codegen::gen_call_fn2(ctx.builder, "cmp32")
}

pub fn instr32_3B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg32(ctx, r2);
    codegen::gen_get_reg32(ctx, r1);
    codegen::gen_call_fn2(ctx.builder, "cmp32")
}

pub fn instr_3C_jit(ctx: &mut JitContext, imm8: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg8_offset(0) as i32);
    codegen::gen_get_reg8(ctx, 0);
    ctx.builder.instruction_body.const_i32(imm8 as i32);
    codegen::gen_call_fn2(ctx.builder, "cmp8");
}

pub fn instr16_3D_jit(ctx: &mut JitContext, imm16: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(0) as i32);
    codegen::gen_get_reg16(ctx, 0);
    ctx.builder.instruction_body.const_i32(imm16 as i32);
    codegen::gen_call_fn2(ctx.builder, "cmp16");
}

pub fn instr32_3D_jit(ctx: &mut JitContext, imm32: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(0) as i32);
    codegen::gen_get_reg32(ctx, 0);
    ctx.builder.instruction_body.const_i32(imm32 as i32);
    codegen::gen_call_fn2(ctx.builder, "cmp32");
}

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

pub fn instr16_69_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r) as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    let imm16 = ctx.cpu.read_imm16();
    ctx.builder.instruction_body.const_i32(imm16 as i32);
    codegen::gen_call_fn2_ret(ctx.builder, "imul_reg16");
    ctx.builder.instruction_body.store_aligned_u16(0);
}
pub fn instr16_69_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm16: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r2) as i32);
    codegen::gen_get_reg16(ctx, r1);
    ctx.builder.instruction_body.const_i32(imm16 as i32);
    codegen::gen_call_fn2_ret(ctx.builder, "imul_reg16");
    ctx.builder.instruction_body.store_aligned_u16(0);
}

pub fn instr32_69_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r) as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read32(ctx);
    let imm32 = ctx.cpu.read_imm32();
    ctx.builder.instruction_body.const_i32(imm32 as i32);
    codegen::gen_call_fn2_ret(ctx.builder, "imul_reg32");
    ctx.builder.instruction_body.store_aligned_i32(0);
}
pub fn instr32_69_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm32: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r2) as i32);
    codegen::gen_get_reg32(ctx, r1);
    ctx.builder.instruction_body.const_i32(imm32 as i32);
    codegen::gen_call_fn2_ret(ctx.builder, "imul_reg32");
    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr16_6B_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r) as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    let imm8s = ctx.cpu.read_imm8s();
    ctx.builder.instruction_body.const_i32(imm8s as i32);
    codegen::gen_call_fn2_ret(ctx.builder, "imul_reg16");
    ctx.builder.instruction_body.store_aligned_u16(0);
}
pub fn instr16_6B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8s: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r2) as i32);
    codegen::gen_get_reg16(ctx, r1);
    ctx.builder.instruction_body.const_i32(imm8s as i32);
    codegen::gen_call_fn2_ret(ctx.builder, "imul_reg16");
    ctx.builder.instruction_body.store_aligned_u16(0);
}

pub fn instr32_6B_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r) as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read32(ctx);
    let imm8s = ctx.cpu.read_imm8s();
    ctx.builder.instruction_body.const_i32(imm8s as i32);
    codegen::gen_call_fn2_ret(ctx.builder, "imul_reg32");
    ctx.builder.instruction_body.store_aligned_i32(0);
}
pub fn instr32_6B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32, imm8s: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r2) as i32);
    codegen::gen_get_reg32(ctx, r1);
    ctx.builder.instruction_body.const_i32(imm8s as i32);
    codegen::gen_call_fn2_ret(ctx.builder, "imul_reg32");
    ctx.builder.instruction_body.store_aligned_i32(0);
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

define_instruction_read_write_mem8!(
    "add8",
    "instr_80_0_mem",
    instr_80_0_mem_jit,
    instr_80_0_reg_jit,
    imm8
);
define_instruction_read_write_mem8!(
    "or8",
    "instr_80_1_mem",
    instr_80_1_mem_jit,
    instr_80_1_reg_jit,
    imm8
);
define_instruction_read_write_mem8!(
    "adc8",
    "instr_80_2_mem",
    instr_80_2_mem_jit,
    instr_80_2_reg_jit,
    imm8
);
define_instruction_read_write_mem8!(
    "sbb8",
    "instr_80_3_mem",
    instr_80_3_mem_jit,
    instr_80_3_reg_jit,
    imm8
);
define_instruction_read_write_mem8!(
    "and8",
    "instr_80_4_mem",
    instr_80_4_mem_jit,
    instr_80_4_reg_jit,
    imm8
);
define_instruction_read_write_mem8!(
    "sub8",
    "instr_80_5_mem",
    instr_80_5_mem_jit,
    instr_80_5_reg_jit,
    imm8
);
define_instruction_read_write_mem8!(
    "xor8",
    "instr_80_6_mem",
    instr_80_6_mem_jit,
    instr_80_6_reg_jit,
    imm8
);

define_instruction_read_write_mem16!(
    "add16",
    "instr16_81_0_mem",
    instr16_81_0_mem_jit,
    instr16_81_0_reg_jit,
    imm16
);
define_instruction_read_write_mem32!(
    "add32",
    "instr32_81_0_mem",
    instr32_81_0_mem_jit,
    instr32_81_0_reg_jit,
    imm32
);

define_instruction_read_write_mem16!(
    "or16",
    "instr16_81_1_mem",
    instr16_81_1_mem_jit,
    instr16_81_1_reg_jit,
    imm16
);
define_instruction_read_write_mem32!(
    "or32",
    "instr32_81_1_mem",
    instr32_81_1_mem_jit,
    instr32_81_1_reg_jit,
    imm32
);

define_instruction_read_write_mem16!(
    "adc16",
    "instr16_81_2_mem",
    instr16_81_2_mem_jit,
    instr16_81_2_reg_jit,
    imm16
);
define_instruction_read_write_mem32!(
    "adc32",
    "instr32_81_2_mem",
    instr32_81_2_mem_jit,
    instr32_81_2_reg_jit,
    imm32
);

define_instruction_read_write_mem16!(
    "sbb16",
    "instr16_81_3_mem",
    instr16_81_3_mem_jit,
    instr16_81_3_reg_jit,
    imm16
);
define_instruction_read_write_mem32!(
    "sbb32",
    "instr32_81_3_mem",
    instr32_81_3_mem_jit,
    instr32_81_3_reg_jit,
    imm32
);

define_instruction_read_write_mem16!(
    "and16",
    "instr16_81_4_mem",
    instr16_81_4_mem_jit,
    instr16_81_4_reg_jit,
    imm16
);
define_instruction_read_write_mem32!(
    "and32",
    "instr32_81_4_mem",
    instr32_81_4_mem_jit,
    instr32_81_4_reg_jit,
    imm32
);

define_instruction_read_write_mem16!(
    "sub16",
    "instr16_81_5_mem",
    instr16_81_5_mem_jit,
    instr16_81_5_reg_jit,
    imm16
);
define_instruction_read_write_mem32!(
    "sub32",
    "instr32_81_5_mem",
    instr32_81_5_mem_jit,
    instr32_81_5_reg_jit,
    imm32
);

define_instruction_read_write_mem16!(
    "xor16",
    "instr16_81_6_mem",
    instr16_81_6_mem_jit,
    instr16_81_6_reg_jit,
    imm16
);
define_instruction_read_write_mem32!(
    "xor32",
    "instr32_81_6_mem",
    instr32_81_6_mem_jit,
    instr32_81_6_reg_jit,
    imm32
);

define_instruction_read_write_mem16!(
    "add16",
    "instr16_83_0_mem",
    instr16_83_0_mem_jit,
    instr16_83_0_reg_jit,
    imm8s
);
define_instruction_read_write_mem32!(
    "add32",
    "instr32_83_0_mem",
    instr32_83_0_mem_jit,
    instr32_83_0_reg_jit,
    imm8s
);

define_instruction_read_write_mem16!(
    "or16",
    "instr16_83_1_mem",
    instr16_83_1_mem_jit,
    instr16_83_1_reg_jit,
    imm8s
);
define_instruction_read_write_mem32!(
    "or32",
    "instr32_83_1_mem",
    instr32_83_1_mem_jit,
    instr32_83_1_reg_jit,
    imm8s
);

define_instruction_read_write_mem16!(
    "adc16",
    "instr16_83_2_mem",
    instr16_83_2_mem_jit,
    instr16_83_2_reg_jit,
    imm8s
);
define_instruction_read_write_mem32!(
    "adc32",
    "instr32_83_2_mem",
    instr32_83_2_mem_jit,
    instr32_83_2_reg_jit,
    imm8s
);

define_instruction_read_write_mem16!(
    "sbb16",
    "instr16_83_3_mem",
    instr16_83_3_mem_jit,
    instr16_83_3_reg_jit,
    imm8s
);
define_instruction_read_write_mem32!(
    "sbb32",
    "instr32_83_3_mem",
    instr32_83_3_mem_jit,
    instr32_83_3_reg_jit,
    imm8s
);

define_instruction_read_write_mem16!(
    "and16",
    "instr16_83_4_mem",
    instr16_83_4_mem_jit,
    instr16_83_4_reg_jit,
    imm8s
);
define_instruction_read_write_mem32!(
    "and32",
    "instr32_83_4_mem",
    instr32_83_4_mem_jit,
    instr32_83_4_reg_jit,
    imm8s
);

define_instruction_read_write_mem16!(
    "sub16",
    "instr16_83_5_mem",
    instr16_83_5_mem_jit,
    instr16_83_5_reg_jit,
    imm8s
);
define_instruction_read_write_mem32!(
    "sub32",
    "instr32_83_5_mem",
    instr32_83_5_mem_jit,
    instr32_83_5_reg_jit,
    imm8s
);

define_instruction_read_write_mem16!(
    "xor16",
    "instr16_83_6_mem",
    instr16_83_6_mem_jit,
    instr16_83_6_reg_jit,
    imm8s
);
define_instruction_read_write_mem32!(
    "xor32",
    "instr32_83_6_mem",
    instr32_83_6_mem_jit,
    instr32_83_6_reg_jit,
    imm8s
);

define_instruction_read8!("cmp8", instr_80_7_mem_jit, instr_80_7_reg_jit, imm8);
define_instruction_read16!("cmp16", instr16_81_7_mem_jit, instr16_81_7_reg_jit, imm16);
define_instruction_read32!("cmp32", instr32_81_7_mem_jit, instr32_81_7_reg_jit, imm32);

define_instruction_read16!("cmp16", instr16_83_7_mem_jit, instr16_83_7_reg_jit, imm8s);
define_instruction_read32!("cmp32", instr32_83_7_mem_jit, instr32_83_7_reg_jit, imm8s);

define_instruction_read8!("test8", instr_84_mem_jit, instr_84_reg_jit);
define_instruction_read16!("test16", instr16_85_mem_jit, instr16_85_reg_jit);
define_instruction_read32!("test32", instr32_85_mem_jit, instr32_85_reg_jit);

pub fn instr_88_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);

    let address_local = ctx.builder.set_new_local();

    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg8_offset(r) as i32);
    ctx.builder.instruction_body.load_u8_from_stack(0);
    let value_local = ctx.builder.set_new_local();

    codegen::gen_safe_write8(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr_88_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg8_r(ctx, r1, r2);
}

pub fn instr16_89_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);

    let address_local = ctx.builder.set_new_local();

    codegen::gen_get_reg16(ctx, r);
    let value_local = ctx.builder.set_new_local();

    codegen::gen_safe_write16(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr16_89_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg16_r(ctx, r1, r2);
}
pub fn instr32_89_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    // Pseudo: safe_write32(modrm_resolve(modrm_byte), reg32s[r]);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();

    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r) as i32);
    ctx.builder.instruction_body.load_aligned_i32_from_stack(0);
    let value_local = ctx.builder.set_new_local();

    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr32_89_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg32_r(ctx, r1, r2);
}

pub fn instr_8A_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    // Pseudo: reg8[r] = safe_read8(modrm_resolve(modrm_byte));
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg8_offset(r) as i32);

    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read8(ctx);

    ctx.builder.instruction_body.store_u8(0);
}
pub fn instr_8A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg8_r(ctx, r2, r1);
}

pub fn instr16_8B_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    // Pseudo: reg16[r] = safe_read16(modrm_resolve(modrm_byte));
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r) as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);

    ctx.builder.instruction_body.store_aligned_u16(0);
}
pub fn instr16_8B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg16_r(ctx, r2, r1);
}
pub fn instr32_8B_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    // Pseudo: reg32s[r] = safe_read32s(modrm_resolve(modrm_byte));
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r) as i32);

    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read32(ctx);

    ctx.builder.instruction_body.store_aligned_i32(0);
}
pub fn instr32_8B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg32_r(ctx, r2, r1);
}

pub fn instr16_8D_mem_jit(ctx: &mut JitContext, modrm_byte: u8, reg: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(reg) as i32);
    ctx.cpu.prefixes |= SEG_PREFIX_ZERO;
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    ctx.builder.instruction_body.store_aligned_u16(0);
}
pub fn instr32_8D_mem_jit(ctx: &mut JitContext, modrm_byte: u8, reg: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(reg) as i32);
    ctx.cpu.prefixes |= SEG_PREFIX_ZERO;
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr16_8D_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_fn2_const(ctx.builder, "instr16_8D_reg", r1, r2);
}

pub fn instr32_8D_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_fn2_const(ctx.builder, "instr32_8D_reg", r1, r2);
}

pub fn instr16_8F_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(regs::SP) as i32);
    codegen::gen_get_reg16(ctx, regs::SP);
    ctx.builder.instruction_body.const_i32(2);
    ctx.builder.instruction_body.add_i32();
    ctx.builder.instruction_body.store_aligned_u16(0);

    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_modrm_fn0(ctx.builder, "instr16_8F_0_mem_jit");
}
pub fn instr16_8F_0_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr16_8F_0_reg", r);
}
pub fn instr32_8F_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(regs::ESP) as i32);
    codegen::gen_get_reg32(ctx, regs::ESP);
    ctx.builder.instruction_body.const_i32(4);
    ctx.builder.instruction_body.add_i32();
    ctx.builder.instruction_body.store_aligned_i32(0);

    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_modrm_fn0(ctx.builder, "instr32_8F_0_mem_jit");
}
pub fn instr32_8F_0_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr32_8F_0_reg", r);
}

define_instruction_read_write_mem16!(
    "rol16",
    "instr16_C1_0_mem",
    instr16_C1_0_mem_jit,
    instr16_C1_0_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    "rol32",
    "instr32_C1_0_mem",
    instr32_C1_0_mem_jit,
    instr32_C1_0_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "ror16",
    "instr16_C1_1_mem",
    instr16_C1_1_mem_jit,
    instr16_C1_1_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    "ror32",
    "instr32_C1_1_mem",
    instr32_C1_1_mem_jit,
    instr32_C1_1_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "rcl16",
    "instr16_C1_2_mem",
    instr16_C1_2_mem_jit,
    instr16_C1_2_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    "rcl32",
    "instr32_C1_2_mem",
    instr32_C1_2_mem_jit,
    instr32_C1_2_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "rcr16",
    "instr16_C1_3_mem",
    instr16_C1_3_mem_jit,
    instr16_C1_3_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    "rcr32",
    "instr32_C1_3_mem",
    instr32_C1_3_mem_jit,
    instr32_C1_3_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "shl16",
    "instr16_C1_4_mem",
    instr16_C1_4_mem_jit,
    instr16_C1_4_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    "shl32",
    "instr32_C1_4_mem",
    instr32_C1_4_mem_jit,
    instr32_C1_4_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "shr16",
    "instr16_C1_5_mem",
    instr16_C1_5_mem_jit,
    instr16_C1_5_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    "shr32",
    "instr32_C1_5_mem",
    instr32_C1_5_mem_jit,
    instr32_C1_5_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "shl16",
    "instr16_C1_6_mem",
    instr16_C1_6_mem_jit,
    instr16_C1_6_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    "shl32",
    "instr32_C1_6_mem",
    instr32_C1_6_mem_jit,
    instr32_C1_6_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "sar16",
    "instr16_C1_7_mem",
    instr16_C1_7_mem_jit,
    instr16_C1_7_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    "sar32",
    "instr32_C1_7_mem",
    instr32_C1_7_mem_jit,
    instr32_C1_7_reg_jit,
    imm8_5bits
);

pub fn instr16_E8_jit(ctx: &mut JitContext, imm: u32) {
    codegen::gen_get_real_eip(ctx);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push16(ctx, &value_local);
    ctx.builder.free_local(value_local);
    codegen::gen_jmp_rel16(ctx.builder, imm as u16);
}
pub fn instr32_E8_jit(ctx: &mut JitContext, imm: u32) {
    codegen::gen_get_real_eip(ctx);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_push32(ctx, &value_local);
    ctx.builder.free_local(value_local);
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::INSTRUCTION_POINTER as i32);
    ctx.builder
        .instruction_body
        .load_aligned_i32(global_pointers::INSTRUCTION_POINTER);
    ctx.builder.instruction_body.const_i32(imm as i32);
    ctx.builder.instruction_body.add_i32();
    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr16_E9_jit(ctx: &mut JitContext, imm: u32) {
    codegen::gen_jmp_rel16(ctx.builder, imm as u16);
}
pub fn instr32_E9_jit(ctx: &mut JitContext, imm: u32) {
    codegen::gen_relative_jump(ctx.builder, imm as i32);
}

pub fn instr16_C2_jit(ctx: &mut JitContext, imm16: u32) {
    let cs_addr = global_pointers::get_seg_offset(CS);
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::INSTRUCTION_POINTER as i32);
    ctx.builder.instruction_body.load_aligned_i32(cs_addr);
    codegen::gen_pop16(ctx);
    codegen::gen_adjust_stack_reg(ctx, imm16);
    ctx.builder.instruction_body.add_i32();
    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr32_C2_jit(ctx: &mut JitContext, imm16: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::INSTRUCTION_POINTER as i32);
    ctx.builder
        .instruction_body
        .load_aligned_i32(global_pointers::get_seg_offset(CS));
    codegen::gen_pop32s(ctx);
    codegen::gen_adjust_stack_reg(ctx, imm16);
    ctx.builder.instruction_body.add_i32();
    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr16_C3_jit(ctx: &mut JitContext) {
    let cs_addr = global_pointers::get_seg_offset(CS);

    ctx.builder
        .instruction_body
        .const_i32(global_pointers::INSTRUCTION_POINTER as i32);

    ctx.builder.instruction_body.load_aligned_i32(cs_addr);
    codegen::gen_pop16(ctx);
    ctx.builder.instruction_body.add_i32();

    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr32_C3_jit(ctx: &mut JitContext) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::INSTRUCTION_POINTER as i32);

    // cs = segment_offsets[CS]
    ctx.builder
        .instruction_body
        .load_aligned_i32(global_pointers::get_seg_offset(CS));

    // ip = pop32s()
    codegen::gen_pop32s(ctx);

    // cs + ip
    ctx.builder.instruction_body.add_i32();

    // dbg_assert(is_asize_32() || ip < 0x10000);

    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr16_C9_jit(ctx: &mut JitContext) { codegen::gen_leave(ctx, false); }
pub fn instr32_C9_jit(ctx: &mut JitContext) { codegen::gen_leave(ctx, true); }

pub fn gen_mov_reg8_imm(ctx: &mut JitContext, r: u32, imm: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg8_offset(r) as i32);
    ctx.builder.instruction_body.const_i32(imm as i32);
    ctx.builder.instruction_body.store_u8(0);
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
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r) as i32);
    ctx.builder.instruction_body.const_i32(imm as i32);
    ctx.builder.instruction_body.store_aligned_u16(0);
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
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r) as i32);
    ctx.builder.instruction_body.const_i32(imm as i32);
    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr32_B8_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 0, imm) }
pub fn instr32_B9_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 1, imm) }
pub fn instr32_BA_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 2, imm) }
pub fn instr32_BB_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 3, imm) }
pub fn instr32_BC_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 4, imm) }
pub fn instr32_BD_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 5, imm) }
pub fn instr32_BE_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 6, imm) }
pub fn instr32_BF_jit(ctx: &mut JitContext, imm: u32) { gen_mov_reg32_imm(ctx, 7, imm) }

define_instruction_read_write_mem8!(
    "rol8",
    "instr_C0_0_mem",
    instr_C0_0_mem_jit,
    instr_C0_0_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem8!(
    "ror8",
    "instr_C0_1_mem",
    instr_C0_1_mem_jit,
    instr_C0_1_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem8!(
    "rcl8",
    "instr_C0_2_mem",
    instr_C0_2_mem_jit,
    instr_C0_2_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem8!(
    "rcr8",
    "instr_C0_3_mem",
    instr_C0_3_mem_jit,
    instr_C0_3_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem8!(
    "shl8",
    "instr_C0_4_mem",
    instr_C0_4_mem_jit,
    instr_C0_4_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem8!(
    "shr8",
    "instr_C0_5_mem",
    instr_C0_5_mem_jit,
    instr_C0_5_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem8!(
    "shl8",
    "instr_C0_6_mem",
    instr_C0_6_mem_jit,
    instr_C0_6_reg_jit,
    imm8_5bits
);
define_instruction_read_write_mem8!(
    "sar8",
    "instr_C0_7_mem",
    instr_C0_7_mem_jit,
    instr_C0_7_reg_jit,
    imm8_5bits
);

define_instruction_read_write_mem16!(
    "rol16",
    "instr16_D1_0_mem",
    instr16_D1_0_mem_jit,
    instr16_D1_0_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    "rol32",
    "instr32_D1_0_mem",
    instr32_D1_0_mem_jit,
    instr32_D1_0_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "ror16",
    "instr16_D1_1_mem",
    instr16_D1_1_mem_jit,
    instr16_D1_1_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    "ror32",
    "instr32_D1_1_mem",
    instr32_D1_1_mem_jit,
    instr32_D1_1_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "rcl16",
    "instr16_D1_2_mem",
    instr16_D1_2_mem_jit,
    instr16_D1_2_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    "rcl32",
    "instr32_D1_2_mem",
    instr32_D1_2_mem_jit,
    instr32_D1_2_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "rcr16",
    "instr16_D1_3_mem",
    instr16_D1_3_mem_jit,
    instr16_D1_3_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    "rcr32",
    "instr32_D1_3_mem",
    instr32_D1_3_mem_jit,
    instr32_D1_3_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "shl16",
    "instr16_D1_4_mem",
    instr16_D1_4_mem_jit,
    instr16_D1_4_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    "shl32",
    "instr32_D1_4_mem",
    instr32_D1_4_mem_jit,
    instr32_D1_4_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "shr16",
    "instr16_D1_5_mem",
    instr16_D1_5_mem_jit,
    instr16_D1_5_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    "shr32",
    "instr32_D1_5_mem",
    instr32_D1_5_mem_jit,
    instr32_D1_5_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "shl16",
    "instr16_D1_6_mem",
    instr16_D1_6_mem_jit,
    instr16_D1_6_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    "shl32",
    "instr32_D1_6_mem",
    instr32_D1_6_mem_jit,
    instr32_D1_6_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "sar16",
    "instr16_D1_7_mem",
    instr16_D1_7_mem_jit,
    instr16_D1_7_reg_jit,
    constant_one
);
define_instruction_read_write_mem32!(
    "sar32",
    "instr32_D1_7_mem",
    instr32_D1_7_mem_jit,
    instr32_D1_7_reg_jit,
    constant_one
);

define_instruction_read_write_mem16!(
    "rol16",
    "instr16_D3_0_mem",
    instr16_D3_0_mem_jit,
    instr16_D3_0_reg_jit,
    cl
);
define_instruction_read_write_mem32!(
    "rol32",
    "instr32_D3_0_mem",
    instr32_D3_0_mem_jit,
    instr32_D3_0_reg_jit,
    cl
);

define_instruction_read_write_mem16!(
    "ror16",
    "instr16_D3_1_mem",
    instr16_D3_1_mem_jit,
    instr16_D3_1_reg_jit,
    cl
);
define_instruction_read_write_mem32!(
    "ror32",
    "instr32_D3_1_mem",
    instr32_D3_1_mem_jit,
    instr32_D3_1_reg_jit,
    cl
);

define_instruction_read_write_mem16!(
    "rcl16",
    "instr16_D3_2_mem",
    instr16_D3_2_mem_jit,
    instr16_D3_2_reg_jit,
    cl
);
define_instruction_read_write_mem32!(
    "rcl32",
    "instr32_D3_2_mem",
    instr32_D3_2_mem_jit,
    instr32_D3_2_reg_jit,
    cl
);

define_instruction_read_write_mem16!(
    "rcr16",
    "instr16_D3_3_mem",
    instr16_D3_3_mem_jit,
    instr16_D3_3_reg_jit,
    cl
);
define_instruction_read_write_mem32!(
    "rcr32",
    "instr32_D3_3_mem",
    instr32_D3_3_mem_jit,
    instr32_D3_3_reg_jit,
    cl
);

define_instruction_read_write_mem16!(
    "shl16",
    "instr16_D3_4_mem",
    instr16_D3_4_mem_jit,
    instr16_D3_4_reg_jit,
    cl
);
define_instruction_read_write_mem32!(
    "shl32",
    "instr32_D3_4_mem",
    instr32_D3_4_mem_jit,
    instr32_D3_4_reg_jit,
    cl
);

define_instruction_read_write_mem16!(
    "shr16",
    "instr16_D3_5_mem",
    instr16_D3_5_mem_jit,
    instr16_D3_5_reg_jit,
    cl
);
define_instruction_read_write_mem32!(
    "shr32",
    "instr32_D3_5_mem",
    instr32_D3_5_mem_jit,
    instr32_D3_5_reg_jit,
    cl
);

define_instruction_read_write_mem16!(
    "shl16",
    "instr16_D3_6_mem",
    instr16_D3_6_mem_jit,
    instr16_D3_6_reg_jit,
    cl
);
define_instruction_read_write_mem32!(
    "shl32",
    "instr32_D3_6_mem",
    instr32_D3_6_mem_jit,
    instr32_D3_6_reg_jit,
    cl
);

define_instruction_read_write_mem16!(
    "sar16",
    "instr16_D3_7_mem",
    instr16_D3_7_mem_jit,
    instr16_D3_7_reg_jit,
    cl
);
define_instruction_read_write_mem32!(
    "sar32",
    "instr32_D3_7_mem",
    instr32_D3_7_mem_jit,
    instr32_D3_7_reg_jit,
    cl
);

fn instr_group_D8_mem_jit(ctx: &mut JitContext, modrm_byte: u8, op: &str) {
    ctx.builder.instruction_body.const_i32(0);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_fpu_load_m32(ctx);
    codegen::gen_call_fn2_i32_f64(ctx.builder, op)
}
fn instr_group_D8_reg_jit(ctx: &mut JitContext, r: u32, op: &str) {
    ctx.builder.instruction_body.const_i32(0);
    codegen::gen_fpu_get_sti(ctx, r);
    codegen::gen_call_fn2_i32_f64(ctx.builder, op)
}

pub fn instr_D8_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_D8_mem_jit(ctx, modrm_byte, "fpu_fadd")
}
pub fn instr_D8_0_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_D8_reg_jit(ctx, r, "fpu_fadd")
}
pub fn instr_D8_1_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_D8_mem_jit(ctx, modrm_byte, "fpu_fmul")
}
pub fn instr_D8_1_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_D8_reg_jit(ctx, r, "fpu_fmul")
}
pub fn instr_D8_2_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_fpu_load_m32(ctx);
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_fcom")
}
pub fn instr_D8_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fpu_get_sti(ctx, r);
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_fcom")
}
pub fn instr_D8_3_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_fpu_load_m32(ctx);
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_fcomp")
}
pub fn instr_D8_3_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fpu_get_sti(ctx, r);
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_fcomp")
}
pub fn instr_D8_4_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_D8_mem_jit(ctx, modrm_byte, "fpu_fsub")
}
pub fn instr_D8_4_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_D8_reg_jit(ctx, r, "fpu_fsub")
}
pub fn instr_D8_5_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_D8_mem_jit(ctx, modrm_byte, "fpu_fsubr")
}
pub fn instr_D8_5_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_D8_reg_jit(ctx, r, "fpu_fsubr")
}
pub fn instr_D8_6_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_D8_mem_jit(ctx, modrm_byte, "fpu_fdiv")
}
pub fn instr_D8_6_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_D8_reg_jit(ctx, r, "fpu_fdiv")
}
pub fn instr_D8_7_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_D8_mem_jit(ctx, modrm_byte, "fpu_fdivr")
}
pub fn instr_D8_7_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_D8_reg_jit(ctx, r, "fpu_fdivr")
}

pub fn instr_D9_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_fpu_load_m32(ctx);
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_push");
}
pub fn instr_D9_0_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fpu_get_sti(ctx, r);
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_push");
}

pub fn instr_D9_1_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_D9_1_reg_jit(ctx: &mut JitContext, r: u32) {
    ctx.builder.instruction_body.const_i32(r as i32);
    codegen::gen_call_fn1(ctx.builder, "fpu_fxch");
}

pub fn instr_D9_2_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.instruction_body.demote_f64_to_f32();
    ctx.builder.instruction_body.reinterpret_f32_as_i32();
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr_D9_2_reg_jit(ctx: &mut JitContext, r: u32) {
    if r != 0 {
        codegen::gen_trigger_ud(ctx);
    }
}
pub fn instr_D9_3_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.instruction_body.demote_f64_to_f32();
    ctx.builder.instruction_body.reinterpret_f32_as_i32();
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop");
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr_D9_3_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fstp", r);
}

pub fn instr_D9_4_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_call_fn1(ctx.builder, "fpu_fldenv");
    // XXX: generated because fldenv might page-fault, but doesn't generate a proper block boundary
    codegen::gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.instruction_body.return_();
}
pub fn instr_D9_4_reg_jit(ctx: &mut JitContext, r: u32) {
    ctx.builder.instruction_body.const_i32(r as i32);
    codegen::gen_call_fn1(ctx.builder, "instr_D9_4_reg");
}

pub fn instr_D9_5_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::FPU_CONTROL_WORD as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    ctx.builder.instruction_body.store_aligned_u16(0);
}
pub fn instr_D9_5_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr_D9_5_reg", r);
}
pub fn instr_D9_7_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::FPU_CONTROL_WORD as i32);
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::FPU_CONTROL_WORD as i32);
    ctx.builder.instruction_body.load_aligned_u16_from_stack(0);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write16(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr_D9_7_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr_D9_7_reg", r);
}

pub fn instr_DB_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read32(ctx);
    ctx.builder.instruction_body.convert_i32_to_f64();
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_push");
}
pub fn instr_DB_0_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr_DB_0_reg", r);
}

pub fn instr_DB_2_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    codegen::gen_call_fn1_f64_ret_i32(ctx.builder, "fpu_convert_to_i32");
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr_DB_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr_DB_2_reg", r);
}
pub fn instr_DB_3_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    codegen::gen_call_fn1_f64_ret_i32(ctx.builder, "fpu_convert_to_i32");
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop");
}
pub fn instr_DB_3_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "instr_DB_3_reg", r);
}

pub fn instr_DB_5_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_call_fn1(ctx.builder, "fpu_fldm80");
    // XXX: generated because fpu_fldm80 might page-fault, but doesn't generate a proper block boundary
    codegen::gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.instruction_body.return_();
}
pub fn instr_DB_5_reg_jit(ctx: &mut JitContext, r: u32) {
    ctx.builder.instruction_body.const_i32(r as i32);
    codegen::gen_call_fn1(ctx.builder, "fpu_fucomi");
}

fn instr_group_DC_mem_jit(ctx: &mut JitContext, modrm_byte: u8, op: &str) {
    ctx.builder.instruction_body.const_i32(0);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_fpu_load_m64(ctx);
    codegen::gen_call_fn2_i32_f64(ctx.builder, op)
}
fn instr_group_DC_reg_jit(ctx: &mut JitContext, r: u32, op: &str) {
    ctx.builder.instruction_body.const_i32(r as i32);
    codegen::gen_fpu_get_sti(ctx, r);
    codegen::gen_call_fn2_i32_f64(ctx.builder, op)
}

pub fn instr_DC_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_DC_mem_jit(ctx, modrm_byte, "fpu_fadd")
}
pub fn instr_DC_0_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DC_reg_jit(ctx, r, "fpu_fadd")
}
pub fn instr_DC_1_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_DC_mem_jit(ctx, modrm_byte, "fpu_fmul")
}
pub fn instr_DC_1_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DC_reg_jit(ctx, r, "fpu_fmul")
}
pub fn instr_DC_2_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_fpu_load_m64(ctx);
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_fcom")
}
pub fn instr_DC_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fpu_get_sti(ctx, r);
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_fcom")
}
pub fn instr_DC_3_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_fpu_load_m64(ctx);
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_fcomp")
}
pub fn instr_DC_3_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fpu_get_sti(ctx, r);
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_fcomp")
}
pub fn instr_DC_4_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_DC_mem_jit(ctx, modrm_byte, "fpu_fsub")
}
pub fn instr_DC_4_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DC_reg_jit(ctx, r, "fpu_fsub")
}
pub fn instr_DC_5_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_DC_mem_jit(ctx, modrm_byte, "fpu_fsubr")
}
pub fn instr_DC_5_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DC_reg_jit(ctx, r, "fpu_fsubr")
}
pub fn instr_DC_6_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_DC_mem_jit(ctx, modrm_byte, "fpu_fdiv")
}
pub fn instr_DC_6_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DC_reg_jit(ctx, r, "fpu_fdiv")
}
pub fn instr_DC_7_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_DC_mem_jit(ctx, modrm_byte, "fpu_fdivr")
}
pub fn instr_DC_7_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DC_reg_jit(ctx, r, "fpu_fdivr")
}

pub fn instr_DD_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_fpu_load_m64(ctx);
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_push");
}
pub fn instr_DD_0_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_ffree", r);
}

pub fn instr_DD_2_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.instruction_body.reinterpret_f64_as_i64();
    let value_local = ctx.builder.set_new_local_i64();
    codegen::gen_safe_write64(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local_i64(value_local);
}
pub fn instr_DD_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fst", r);
}
pub fn instr_DD_3_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    ctx.builder.instruction_body.reinterpret_f64_as_i64();
    let value_local = ctx.builder.set_new_local_i64();
    codegen::gen_safe_write64(ctx, &address_local, &value_local);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop");
    ctx.builder.free_local(address_local);
    ctx.builder.free_local_i64(value_local);
}
pub fn instr_DD_3_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fstp", r);
}

pub fn instr_DD_5_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_DD_5_reg_jit(ctx: &mut JitContext, r: u32) {
    ctx.builder.instruction_body.const_i32(r as i32);
    codegen::gen_call_fn1(ctx.builder, "fpu_fucomp");
}

fn instr_group_DE_mem_jit(ctx: &mut JitContext, modrm_byte: u8, op: &str) {
    ctx.builder.instruction_body.const_i32(0);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    codegen::sign_extend_i16(ctx.builder);
    ctx.builder.instruction_body.convert_i32_to_f64();
    codegen::gen_call_fn2_i32_f64(ctx.builder, op)
}
fn instr_group_DE_reg_jit(ctx: &mut JitContext, r: u32, op: &str) {
    ctx.builder.instruction_body.const_i32(r as i32);
    codegen::gen_fpu_get_sti(ctx, r);
    codegen::gen_call_fn2_i32_f64(ctx.builder, op);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop")
}

pub fn instr_DE_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_DE_mem_jit(ctx, modrm_byte, "fpu_fadd")
}
pub fn instr_DE_0_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DE_reg_jit(ctx, r, "fpu_fadd")
}
pub fn instr_DE_1_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_DE_mem_jit(ctx, modrm_byte, "fpu_fmul")
}
pub fn instr_DE_1_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DE_reg_jit(ctx, r, "fpu_fmul")
}
pub fn instr_DE_2_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    codegen::sign_extend_i16(ctx.builder);
    ctx.builder.instruction_body.convert_i32_to_f64();
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_fcom")
}
pub fn instr_DE_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fpu_get_sti(ctx, r);
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_fcom");
    codegen::gen_fn0_const(ctx.builder, "fpu_pop")
}
pub fn instr_DE_3_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    codegen::sign_extend_i16(ctx.builder);
    ctx.builder.instruction_body.convert_i32_to_f64();
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_fcomp")
}
pub fn instr_DE_3_reg_jit(ctx: &mut JitContext, r: u32) {
    if r == 1 {
        codegen::gen_fpu_get_sti(ctx, r);
        codegen::gen_call_fn1_f64(ctx.builder, "fpu_fcomp");
        codegen::gen_fn0_const(ctx.builder, "fpu_pop")
    }
    else {
        codegen::gen_trigger_ud(ctx);
    }
}
pub fn instr_DE_4_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_DE_mem_jit(ctx, modrm_byte, "fpu_fsub")
}
pub fn instr_DE_4_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DE_reg_jit(ctx, r, "fpu_fsub")
}
pub fn instr_DE_5_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_DE_mem_jit(ctx, modrm_byte, "fpu_fsubr")
}
pub fn instr_DE_5_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DE_reg_jit(ctx, r, "fpu_fsubr")
}
pub fn instr_DE_6_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_DE_mem_jit(ctx, modrm_byte, "fpu_fdiv")
}
pub fn instr_DE_6_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DE_reg_jit(ctx, r, "fpu_fdiv")
}
pub fn instr_DE_7_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_group_DE_mem_jit(ctx, modrm_byte, "fpu_fdivr")
}
pub fn instr_DE_7_reg_jit(ctx: &mut JitContext, r: u32) {
    instr_group_DE_reg_jit(ctx, r, "fpu_fdivr")
}

pub fn instr_DF_2_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    codegen::gen_call_fn1_f64_ret_i32(ctx.builder, "fpu_convert_to_i16");
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write16(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr_DF_2_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fstp", r);
}
pub fn instr_DF_3_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    codegen::gen_call_fn1_f64_ret_i32(ctx.builder, "fpu_convert_to_i16");
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write16(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop");
}
pub fn instr_DF_3_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fstp", r);
}

pub fn instr_DF_4_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    dbg_log!("fbld");
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_trigger_ud(ctx);
}
pub fn instr_DF_4_reg_jit(ctx: &mut JitContext, r: u32) {
    if r == 0 {
        codegen::gen_fn0_const(ctx.builder, "fpu_fnstsw_reg");
    }
    else {
        codegen::gen_trigger_ud(ctx);
    };
}

pub fn instr_DF_5_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read64(ctx);
    ctx.builder.instruction_body.convert_i64_to_f64();
    codegen::gen_call_fn1_f64(ctx.builder, "fpu_push");
}
pub fn instr_DF_5_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx.builder, "fpu_fucomip", r);
}

pub fn instr_DF_7_reg_jit(ctx: &mut JitContext, _r: u32) { codegen::gen_trigger_ud(ctx); }
pub fn instr_DF_7_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_fpu_get_sti(ctx, 0);
    codegen::gen_call_fn1_f64_ret_i64(ctx.builder, "fpu_convert_to_i64");
    let value_local = ctx.builder.set_new_local_i64();
    codegen::gen_safe_write64(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local_i64(value_local);
    codegen::gen_fn0_const(ctx.builder, "fpu_pop");
}

pub fn instr16_EB_jit(ctx: &mut JitContext, imm8: u32) {
    codegen::gen_jmp_rel16(ctx.builder, imm8 as u16);
    // dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
}

pub fn instr32_EB_jit(ctx: &mut JitContext, imm8: u32) {
    // jmp near
    codegen::gen_relative_jump(ctx.builder, imm8 as i32);
    // dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
}

pub fn instr_F6_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read8(ctx);
    let imm = ctx.cpu.read_imm8();
    ctx.builder.instruction_body.const_i32(imm as i32);
    codegen::gen_call_fn2(ctx.builder, "test8")
}

pub fn instr_F6_0_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    codegen::gen_get_reg8(ctx, r);
    ctx.builder.instruction_body.const_i32(imm as i32);
    codegen::gen_call_fn2(ctx.builder, "test8")
}

pub fn instr_F6_1_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr_F6_0_mem_jit(ctx, modrm_byte)
}
pub fn instr_F6_1_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    instr_F6_0_reg_jit(ctx, r, imm)
}

pub fn instr16_F7_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    let imm = ctx.cpu.read_imm16();
    ctx.builder.instruction_body.const_i32(imm as i32);
    codegen::gen_call_fn2(ctx.builder, "test16")
}

pub fn instr16_F7_0_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    codegen::gen_get_reg16(ctx, r);
    ctx.builder.instruction_body.const_i32(imm as i32);
    codegen::gen_call_fn2(ctx.builder, "test16")
}

pub fn instr16_F7_1_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr16_F7_0_mem_jit(ctx, modrm_byte)
}
pub fn instr16_F7_1_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    instr16_F7_0_reg_jit(ctx, r, imm)
}

pub fn instr32_F7_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read32(ctx);
    let imm = ctx.cpu.read_imm32();
    ctx.builder.instruction_body.const_i32(imm as i32);
    codegen::gen_call_fn2(ctx.builder, "test32")
}

pub fn instr32_F7_0_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    codegen::gen_get_reg32(ctx, r);
    ctx.builder.instruction_body.const_i32(imm as i32);
    codegen::gen_call_fn2(ctx.builder, "test32")
}

pub fn instr32_F7_1_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    instr32_F7_0_mem_jit(ctx, modrm_byte)
}
pub fn instr32_F7_1_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    instr32_F7_0_reg_jit(ctx, r, imm)
}

define_instruction_read_write_mem16!(
    "not16",
    "instr16_F7_2_mem",
    instr16_F7_2_mem_jit,
    instr16_F7_2_reg_jit,
    none
);
define_instruction_read_write_mem32!(
    "not32",
    "instr32_F7_2_mem",
    instr32_F7_2_mem_jit,
    instr32_F7_2_reg_jit,
    none
);
define_instruction_read_write_mem16!(
    "neg16",
    "instr16_F7_3_mem",
    instr16_F7_3_mem_jit,
    instr16_F7_3_reg_jit,
    none
);
define_instruction_read_write_mem32!(
    "neg32",
    "instr32_F7_3_mem",
    instr32_F7_3_mem_jit,
    instr32_F7_3_reg_jit,
    none
);

pub fn instr16_F7_4_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    codegen::gen_call_fn1(ctx.builder, "mul16")
}
pub fn instr16_F7_4_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg16(ctx, r);
    codegen::gen_call_fn1(ctx.builder, "mul16")
}
pub fn instr32_F7_4_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read32(ctx);
    codegen::gen_call_fn1(ctx.builder, "mul32")
}
pub fn instr32_F7_4_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg32(ctx, r);
    codegen::gen_call_fn1(ctx.builder, "mul32")
}

pub fn instr16_F7_5_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    codegen::sign_extend_i16(ctx.builder);
    codegen::gen_call_fn1(ctx.builder, "imul16")
}
pub fn instr16_F7_5_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg16(ctx, r);
    codegen::sign_extend_i16(ctx.builder);
    codegen::gen_call_fn1(ctx.builder, "imul16")
}
pub fn instr32_F7_5_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read32(ctx);
    codegen::gen_call_fn1(ctx.builder, "imul32")
}
pub fn instr32_F7_5_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_get_reg32(ctx, r);
    codegen::gen_call_fn1(ctx.builder, "imul32")
}

define_instruction_read_write_mem16!(
    "inc16",
    "instr16_FF_0_mem",
    instr16_FF_0_mem_jit,
    instr16_FF_0_reg_jit,
    none
);
define_instruction_read_write_mem32!(
    "inc32",
    "instr32_FF_0_mem",
    instr32_FF_0_mem_jit,
    instr32_FF_0_reg_jit,
    none
);

define_instruction_read_write_mem16!(
    "dec16",
    "instr16_FF_1_mem",
    instr16_FF_1_mem_jit,
    instr16_FF_1_reg_jit,
    none
);
define_instruction_read_write_mem32!(
    "dec32",
    "instr32_FF_1_mem",
    instr32_FF_1_mem_jit,
    instr32_FF_1_reg_jit,
    none
);

pub fn instr16_FF_6_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    push16_mem_jit(ctx, modrm_byte)
}
pub fn instr16_FF_6_reg_jit(ctx: &mut JitContext, r: u32) { push16_reg_jit(ctx, r) }
pub fn instr32_FF_6_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
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

pub fn instr_A0_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg8_offset(regs::AL) as i32);
    ctx.builder.instruction_body.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    codegen::gen_safe_read8(ctx);
    ctx.builder.instruction_body.store_u8(0);
}
pub fn instr16_A1_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(regs::AX) as i32);
    ctx.builder.instruction_body.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    codegen::gen_safe_read16(ctx);
    ctx.builder.instruction_body.store_aligned_u16(0);
}
pub fn instr32_A1_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(regs::EAX) as i32);
    ctx.builder.instruction_body.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    codegen::gen_safe_read32(ctx);
    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr_A2_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder.instruction_body.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_get_reg8(ctx, regs::AL);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write8(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr16_A3_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder.instruction_body.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_get_reg16(ctx, regs::AX);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write16(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr32_A3_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder.instruction_body.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_get_reg32(ctx, regs::EAX);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}

pub fn instr_A8_jit(ctx: &mut JitContext, imm8: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg8_offset(0) as i32);
    codegen::gen_get_reg8(ctx, 0);
    ctx.builder.instruction_body.const_i32(imm8 as i32);
    codegen::gen_call_fn2(ctx.builder, "test8");
}

pub fn instr16_A9_jit(ctx: &mut JitContext, imm16: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(0) as i32);
    codegen::gen_get_reg16(ctx, 0);
    ctx.builder.instruction_body.const_i32(imm16 as i32);
    codegen::gen_call_fn2(ctx.builder, "test16");
}

pub fn instr32_A9_jit(ctx: &mut JitContext, imm32: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(0) as i32);
    codegen::gen_get_reg32(ctx, 0);
    ctx.builder.instruction_body.const_i32(imm32 as i32);
    codegen::gen_call_fn2(ctx.builder, "test32");
}

pub fn instr_0F18_mem_jit(ctx: &mut JitContext, modrm_byte: u8, _reg: u32) {
    modrm::skip(ctx.cpu, modrm_byte);
}
pub fn instr_0F18_reg_jit(_ctx: &mut JitContext, _r1: u32, _r2: u32) {}

pub fn instr_0F19_mem_jit(ctx: &mut JitContext, modrm_byte: u8, _reg: u32) {
    modrm::skip(ctx.cpu, modrm_byte);
}
pub fn instr_0F19_reg_jit(_ctx: &mut JitContext, _r1: u32, _r2: u32) {}

pub fn instr_0F1C_mem_jit(ctx: &mut JitContext, modrm_byte: u8, _reg: u32) {
    modrm::skip(ctx.cpu, modrm_byte);
}
pub fn instr_0F1C_reg_jit(_ctx: &mut JitContext, _r1: u32, _r2: u32) {}
pub fn instr_0F1D_mem_jit(ctx: &mut JitContext, modrm_byte: u8, _reg: u32) {
    modrm::skip(ctx.cpu, modrm_byte);
}
pub fn instr_0F1D_reg_jit(_ctx: &mut JitContext, _r1: u32, _r2: u32) {}
pub fn instr_0F1E_mem_jit(ctx: &mut JitContext, modrm_byte: u8, _reg: u32) {
    modrm::skip(ctx.cpu, modrm_byte);
}
pub fn instr_0F1E_reg_jit(_ctx: &mut JitContext, _r1: u32, _r2: u32) {}
pub fn instr_0F1F_mem_jit(ctx: &mut JitContext, modrm_byte: u8, _reg: u32) {
    modrm::skip(ctx.cpu, modrm_byte);
}
pub fn instr_0F1F_reg_jit(_ctx: &mut JitContext, _r1: u32, _r2: u32) {}

define_instruction_read_write_mem16!(
    "shld16",
    "instr16_0FA4_mem",
    instr16_0FA4_mem_jit,
    instr16_0FA4_reg_jit,
    reg,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    "shld32",
    "instr32_0FA4_mem",
    instr32_0FA4_mem_jit,
    instr32_0FA4_reg_jit,
    reg,
    imm8_5bits
);
define_instruction_read_write_mem16!(
    "shld16",
    "instr16_0FA5_mem",
    instr16_0FA5_mem_jit,
    instr16_0FA5_reg_jit,
    reg,
    cl
);
define_instruction_read_write_mem32!(
    "shld32",
    "instr32_0FA5_mem",
    instr32_0FA5_mem_jit,
    instr32_0FA5_reg_jit,
    reg,
    cl
);

define_instruction_read_write_mem16!(
    "shrd16",
    "instr16_0FAC_mem",
    instr16_0FAC_mem_jit,
    instr16_0FAC_reg_jit,
    reg,
    imm8_5bits
);
define_instruction_read_write_mem32!(
    "shrd32",
    "instr32_0FAC_mem",
    instr32_0FAC_mem_jit,
    instr32_0FAC_reg_jit,
    reg,
    imm8_5bits
);
define_instruction_read_write_mem16!(
    "shrd16",
    "instr16_0FAD_mem",
    instr16_0FAD_mem_jit,
    instr16_0FAD_reg_jit,
    reg,
    cl
);
define_instruction_read_write_mem32!(
    "shrd32",
    "instr32_0FAD_mem",
    instr32_0FAD_mem_jit,
    instr32_0FAD_reg_jit,
    reg,
    cl
);

pub fn instr16_0FB6_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r2) as i32);
    codegen::gen_get_reg8(ctx, r1);
    ctx.builder.instruction_body.store_aligned_u16(0);
}
pub fn instr16_0FB6_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r) as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read8(ctx);
    ctx.builder.instruction_body.store_aligned_u16(0);
}

pub fn instr32_0FB6_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r2) as i32);
    codegen::gen_get_reg8(ctx, r1);
    ctx.builder.instruction_body.store_aligned_i32(0);
}
pub fn instr32_0FB6_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r) as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read8(ctx);
    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr16_0FB7_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r) as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    ctx.builder.instruction_body.store_aligned_u16(0);
}
pub fn instr16_0FB7_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r2) as i32);
    codegen::gen_get_reg16(ctx, r1);
    ctx.builder.instruction_body.store_aligned_u16(0);
}
pub fn instr32_0FB7_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r) as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    ctx.builder.instruction_body.store_aligned_i32(0);
}
pub fn instr32_0FB7_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r2) as i32);
    codegen::gen_get_reg16(ctx, r1);
    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr16_0FBE_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r2) as i32);
    codegen::gen_get_reg8(ctx, r1);
    codegen::sign_extend_i8(ctx.builder);
    ctx.builder.instruction_body.store_aligned_u16(0);
}
pub fn instr16_0FBE_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r) as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read8(ctx);
    codegen::sign_extend_i8(ctx.builder);
    ctx.builder.instruction_body.store_aligned_u16(0);
}

pub fn instr32_0FBE_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r2) as i32);
    codegen::gen_get_reg8(ctx, r1);
    codegen::sign_extend_i8(ctx.builder);
    ctx.builder.instruction_body.store_aligned_i32(0);
}
pub fn instr32_0FBE_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r) as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read8(ctx);
    codegen::sign_extend_i8(ctx.builder);
    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr16_0FBF_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r2) as i32);
    codegen::gen_get_reg16(ctx, r1);
    codegen::sign_extend_i16(ctx.builder);
    ctx.builder.instruction_body.store_aligned_u16(0);
}
pub fn instr16_0FBF_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r) as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    codegen::sign_extend_i16(ctx.builder);
    ctx.builder.instruction_body.store_aligned_u16(0);
}

pub fn instr32_0FBF_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r2) as i32);
    codegen::gen_get_reg16(ctx, r1);
    codegen::sign_extend_i16(ctx.builder);
    ctx.builder.instruction_body.store_aligned_i32(0);
}
pub fn instr32_0FBF_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r) as i32);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    codegen::sign_extend_i16(ctx.builder);
    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr16_0FC1_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read_write(
        ctx,
        BitSize::WORD,
        &address_local,
        &|ref mut ctx| {
            ctx.builder
                .instruction_body
                .const_i32(::cpu2::cpu::get_reg16_index(r as i32));
            codegen::gen_call_fn2_ret(ctx.builder, "xadd16");
        },
        &|ref mut ctx| {
            ctx.builder
                .instruction_body
                .const_i32(::cpu2::cpu::get_reg16_index(r as i32));
            codegen::gen_call_fn2(ctx.builder, "instr16_0FC1_mem")
        },
    );
    ctx.builder.free_local(address_local);
}
pub fn instr16_0FC1_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r1) as i32);
    codegen::gen_get_reg16(ctx, r1);
    ctx.builder
        .instruction_body
        .const_i32(::cpu2::cpu::get_reg16_index(r2 as i32));
    codegen::gen_call_fn2_ret(ctx.builder, "xadd16");
    ctx.builder.instruction_body.store_aligned_u16(0);
}

pub fn instr32_0FC1_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_safe_read_write(
        ctx,
        BitSize::DWORD,
        &address_local,
        &|ref mut ctx| {
            ctx.builder.instruction_body.const_i32(r as i32);
            codegen::gen_call_fn2_ret(ctx.builder, "xadd32");
        },
        &|ref mut ctx| {
            ctx.builder.instruction_body.const_i32(r as i32);
            codegen::gen_call_fn2(ctx.builder, "instr32_0FC1_mem")
        },
    );
    ctx.builder.free_local(address_local);
}
pub fn instr32_0FC1_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r1) as i32);
    codegen::gen_get_reg32(ctx, r1);
    ctx.builder.instruction_body.const_i32(r2 as i32);
    codegen::gen_call_fn2_ret(ctx.builder, "xadd32");
    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr_C6_0_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    // reg8[r] = imm;
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg8_offset(r) as i32);
    ctx.builder.instruction_body.const_i32(imm as i32);
    ctx.builder.instruction_body.store_u8(0);
}

pub fn instr_C6_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    let imm = ctx.cpu.read_imm8();
    ctx.builder.instruction_body.const_i32(imm as i32);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write8(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}

pub fn instr16_C7_0_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    // reg16[r] = imm;
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r) as i32);
    ctx.builder.instruction_body.const_i32(imm as i32);
    ctx.builder.instruction_body.store_aligned_u16(0);
}

pub fn instr16_C7_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    let imm = ctx.cpu.read_imm16();
    ctx.builder.instruction_body.const_i32(imm as i32);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write16(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}

pub fn instr32_C7_0_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    // reg32s[r] = imm;
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r) as i32);
    ctx.builder.instruction_body.const_i32(imm as i32);
    ctx.builder.instruction_body.store_aligned_i32(0);
}

pub fn instr32_C7_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    let imm = ctx.cpu.read_imm32();
    ctx.builder.instruction_body.const_i32(imm as i32);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}

define_instruction_write_reg16!("imul_reg16", instr16_0FAF_mem_jit, instr16_0FAF_reg_jit);
define_instruction_write_reg32!("imul_reg32", instr32_0FAF_mem_jit, instr32_0FAF_reg_jit);

macro_rules! define_cmovcc16(
    ($cond:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read16(ctx);
            let value = ctx.builder.set_new_local();
            codegen::gen_condition_fn(ctx.builder, $cond);
            ctx.builder.instruction_body.if_void();
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r) as i32);
            ctx.builder.instruction_body.get_local(&value);
            ctx.builder.instruction_body.store_aligned_u16(0);
            ctx.builder.instruction_body.block_end();
            ctx.builder.free_local(value);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_condition_fn(ctx.builder, $cond);
            ctx.builder.instruction_body.if_void();
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r2) as i32);
            codegen::gen_get_reg16(ctx, r1);
            ctx.builder.instruction_body.store_aligned_u16(0);
            ctx.builder.instruction_body.block_end();
        }
    );
);

macro_rules! define_cmovcc32(
    ($cond:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read32(ctx);
            let value = ctx.builder.set_new_local();
            codegen::gen_condition_fn(ctx.builder, $cond);
            ctx.builder.instruction_body.if_void();
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r) as i32);
            ctx.builder.instruction_body.get_local(&value);
            ctx.builder.instruction_body.store_aligned_i32(0);
            ctx.builder.instruction_body.block_end();
            ctx.builder.free_local(value);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_condition_fn(ctx.builder, $cond);
            ctx.builder.instruction_body.if_void();
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r2) as i32);
            codegen::gen_get_reg32(ctx, r1);
            ctx.builder.instruction_body.store_aligned_i32(0);
            ctx.builder.instruction_body.block_end();
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
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, _r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            codegen::gen_condition_fn(&mut ctx.builder, $cond);
            ctx.builder.instruction_body.const_i32(0);
            ctx.builder.instruction_body.ne_i32();
            let value_local = ctx.builder.set_new_local();
            codegen::gen_safe_write8(ctx, &address_local, &value_local);
            ctx.builder.free_local(address_local);
            ctx.builder.free_local(value_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, _r2: u32) {
            ctx.builder
                .instruction_body
                .const_i32(global_pointers::get_reg8_offset(r1) as i32);
            codegen::gen_condition_fn(&mut ctx.builder, $cond);
            ctx.builder.instruction_body.const_i32(0);
            ctx.builder.instruction_body.ne_i32();
            ctx.builder.instruction_body.store_u8(0);
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

pub fn instr_0F29_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    // XXX: Aligned write or #gp
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg_xmm_low_offset(r) as i32);
    ctx.builder.instruction_body.load_aligned_i64_from_stack(0);
    let value_local_low = ctx.builder.set_new_local_i64();
    ctx.builder
        .instruction_body
        .const_i32(global_pointers::get_reg_xmm_high_offset(r) as i32);
    ctx.builder.instruction_body.load_aligned_i64_from_stack(0);
    let value_local_high = ctx.builder.set_new_local_i64();
    codegen::gen_safe_write128(ctx, &address_local, &value_local_low, &value_local_high);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local_i64(value_local_low);
    ctx.builder.free_local_i64(value_local_high);
}
pub fn instr_0F29_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.instruction_body.const_i32(r1 as i32);
    ctx.builder.instruction_body.const_i32(r2 as i32);
    codegen::gen_call_fn2(ctx.builder, "instr_0F29_reg")
}

pub fn instr_F30F6F_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let dest = global_pointers::get_reg_xmm_low_offset(r);
    codegen::gen_safe_read128(ctx, dest);
}
pub fn instr_F30F6F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    ctx.builder.instruction_body.const_i32(r1 as i32);
    ctx.builder.instruction_body.const_i32(r2 as i32);
    codegen::gen_call_fn2(ctx.builder, "instr_F30F6F_reg")
}

pub fn instr_660F7F_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    instr_0F29_mem_jit(ctx, modrm_byte, r);
}
pub fn instr_660F7F_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    instr_0F29_reg_jit(ctx, r1, r2)
}
