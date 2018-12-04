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
    codegen::gen_get_reg16(ctx.builder, r);
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

macro_rules! define_instruction_read8(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read8(ctx);
            codegen::gen_get_reg8(ctx.builder, r);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_get_reg8(ctx.builder, r1);
            codegen::gen_get_reg8(ctx.builder, r2);
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
            codegen::gen_get_reg8(ctx.builder, r1);
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
            codegen::gen_get_reg16(ctx.builder, r);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_get_reg16(ctx.builder, r1);
            codegen::gen_get_reg16(ctx.builder, r2);
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
            codegen::gen_get_reg16(ctx.builder, r1);
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
            codegen::gen_get_reg32(ctx.builder, r);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_get_reg32(ctx.builder, r1);
            codegen::gen_get_reg32(ctx.builder, r2);
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
            codegen::gen_get_reg32(ctx.builder, r1);
            ctx.builder.instruction_body.const_i32(imm as i32);
            codegen::gen_call_fn2(ctx.builder, $fn)
        }
    )
);

macro_rules! define_instruction_write_reg8(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg8_offset(r) as i32);
            codegen::gen_get_reg8(ctx.builder, r);
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read8(ctx);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_u8(0);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg8_offset(r2) as i32);
            codegen::gen_get_reg8(ctx.builder, r2);
            codegen::gen_get_reg8(ctx.builder, r1);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_u8(0);
        }
    )
);

macro_rules! define_instruction_write_reg16(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r) as i32);
            codegen::gen_get_reg16(ctx.builder, r);
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read16(ctx);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_u16(0);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r2) as i32);
            codegen::gen_get_reg16(ctx.builder, r2);
            codegen::gen_get_reg16(ctx.builder, r1);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_u16(0);
        }
    )
);

macro_rules! define_instruction_write_reg32(
    ($fn:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r) as i32);
            codegen::gen_get_reg32(ctx.builder, r);
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read32(ctx);
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
            ctx.builder.instruction_body.store_aligned_i32(0);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r2) as i32);
            codegen::gen_get_reg32(ctx.builder, r2);
            codegen::gen_get_reg32(ctx.builder, r1);
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
                codegen::gen_get_reg8(ctx.builder, r);
                codegen::gen_call_fn2_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(r as i32);
                codegen::gen_call_fn2(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg8_offset(r1) as i32);
            codegen::gen_get_reg8(ctx.builder, r1);
            codegen::gen_get_reg8(ctx.builder, r2);
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
            codegen::gen_get_reg8(ctx.builder, r1);
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
                codegen::gen_get_reg16(ctx.builder, r);
                codegen::gen_call_fn2_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(r as i32);
                codegen::gen_call_fn2(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg16_offset(r1) as i32);
            codegen::gen_get_reg16(ctx.builder, r1);
            codegen::gen_get_reg16(ctx.builder, r2);
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
            codegen::gen_get_reg16(ctx.builder, r1);
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
                codegen::gen_get_reg8(ctx.builder, regs::CL);
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
            codegen::gen_get_reg16(ctx.builder, r1);
            codegen::gen_get_reg8(ctx.builder, regs::CL);
                ctx.builder.instruction_body.const_i32(31);
                ctx.builder.instruction_body.and_i32();
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
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
            codegen::gen_get_reg16(ctx.builder, r1);
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
            codegen::gen_get_reg16(ctx.builder, r1);
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
                codegen::gen_get_reg32(ctx.builder, r);
                codegen::gen_call_fn2_ret(ctx.builder, $fn);
            }, &|ref mut ctx| {
                ctx.builder.instruction_body.const_i32(r as i32);
                codegen::gen_call_fn2(ctx.builder, $fallback_fn)
            });
            ctx.builder.free_local(address_local);
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            ctx.builder.instruction_body.const_i32(global_pointers::get_reg32_offset(r1) as i32);
            codegen::gen_get_reg32(ctx.builder, r1);
            codegen::gen_get_reg32(ctx.builder, r2);
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
            codegen::gen_get_reg32(ctx.builder, r1);
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
                codegen::gen_get_reg8(ctx.builder, regs::CL);
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
            codegen::gen_get_reg32(ctx.builder, r1);
            codegen::gen_get_reg8(ctx.builder, regs::CL);
                ctx.builder.instruction_body.const_i32(31);
                ctx.builder.instruction_body.and_i32();
            codegen::gen_call_fn2_ret(ctx.builder, $fn);
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
            codegen::gen_get_reg32(ctx.builder, r1);
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
            codegen::gen_get_reg32(ctx.builder, r1);
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

define_instruction_read8!("cmp8", instr_38_mem_jit, instr_38_reg_jit);
define_instruction_read16!("cmp16", instr16_39_mem_jit, instr16_39_reg_jit);
define_instruction_read32!("cmp32", instr32_39_mem_jit, instr32_39_reg_jit);

pub fn instr_3A_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    codegen::gen_get_reg8(ctx.builder, r);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read8(ctx);
    codegen::gen_call_fn2(ctx.builder, "cmp8")
}

pub fn instr_3A_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg8(ctx.builder, r2);
    codegen::gen_get_reg8(ctx.builder, r1);
    codegen::gen_call_fn2(ctx.builder, "cmp8")
}

pub fn instr16_3B_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    codegen::gen_get_reg16(ctx.builder, r);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read16(ctx);
    codegen::gen_call_fn2(ctx.builder, "cmp16")
}

pub fn instr16_3B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg16(ctx.builder, r2);
    codegen::gen_get_reg16(ctx.builder, r1);
    codegen::gen_call_fn2(ctx.builder, "cmp16")
}

pub fn instr32_3B_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    codegen::gen_get_reg32(ctx.builder, r);
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read32(ctx);
    codegen::gen_call_fn2(ctx.builder, "cmp32")
}

pub fn instr32_3B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_get_reg32(ctx.builder, r2);
    codegen::gen_get_reg32(ctx.builder, r1);
    codegen::gen_call_fn2(ctx.builder, "cmp32")
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
// hole for pop esp
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
    codegen::gen_get_reg16(ctx.builder, r1);
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
    codegen::gen_get_reg32(ctx.builder, r1);
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
    codegen::gen_get_reg16(ctx.builder, r1);
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
    codegen::gen_get_reg32(ctx.builder, r1);
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

    codegen::gen_get_reg16(ctx.builder, r);
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
    codegen::gen_get_reg16(ctx.builder, regs::SP);
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
    codegen::gen_get_reg32(ctx.builder, regs::ESP);
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
    codegen::gen_get_reg8(ctx.builder, r);
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
    codegen::gen_get_reg16(ctx.builder, r);
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
    codegen::gen_get_reg32(ctx.builder, r);
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
    codegen::gen_get_reg8(ctx.builder, regs::AL);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write8(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr16_A3_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder.instruction_body.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_get_reg16(ctx.builder, regs::AX);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write16(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}
pub fn instr32_A3_jit(ctx: &mut JitContext, immaddr: u32) {
    ctx.builder.instruction_body.const_i32(immaddr as i32);
    jit_add_seg_offset(ctx, regs::DS);
    let address_local = ctx.builder.set_new_local();
    codegen::gen_get_reg32(ctx.builder, regs::EAX);
    let value_local = ctx.builder.set_new_local();
    codegen::gen_safe_write32(ctx, &address_local, &value_local);
    ctx.builder.free_local(address_local);
    ctx.builder.free_local(value_local);
}

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

pub fn instr16_0FB6_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    let builder = &mut ctx.builder;
    builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r2) as i32);
    codegen::gen_get_reg8(builder, r1);
    builder.instruction_body.store_aligned_u16(0);
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
    let builder = &mut ctx.builder;
    builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r2) as i32);
    codegen::gen_get_reg8(builder, r1);
    builder.instruction_body.store_aligned_i32(0);
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
    let builder = &mut ctx.builder;
    builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r2) as i32);
    codegen::gen_get_reg16(builder, r1);
    builder.instruction_body.store_aligned_u16(0);
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
    let builder = &mut ctx.builder;
    builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r2) as i32);
    codegen::gen_get_reg16(builder, r1);
    builder.instruction_body.store_aligned_i32(0);
}

pub fn instr16_0FBE_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    let builder = &mut ctx.builder;
    builder
        .instruction_body
        .const_i32(global_pointers::get_reg16_offset(r2) as i32);
    codegen::gen_get_reg8(builder, r1);
    codegen::sign_extend_i8(builder);
    builder.instruction_body.store_aligned_u16(0);
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
    let builder = &mut ctx.builder;
    builder
        .instruction_body
        .const_i32(global_pointers::get_reg32_offset(r2) as i32);
    codegen::gen_get_reg8(builder, r1);
    codegen::sign_extend_i8(builder);
    builder.instruction_body.store_aligned_i32(0);
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
    codegen::gen_get_reg16(ctx.builder, r1);
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
    codegen::gen_get_reg16(ctx.builder, r1);
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
            codegen::gen_fn0_const_ret(ctx.builder, $cond);
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read16(ctx);
            ctx.builder.instruction_body.const_i32(r as i32);
            codegen::gen_call_fn3(ctx.builder, "cmovcc16")
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_fn0_const_ret(ctx.builder, $cond);
            codegen::gen_get_reg16(ctx.builder, r1);
            ctx.builder.instruction_body.const_i32(r2 as i32);
            codegen::gen_call_fn3(ctx.builder, "cmovcc16")
        }
    );
);

macro_rules! define_cmovcc32(
    ($cond:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
            codegen::gen_fn0_const_ret(ctx.builder, $cond);
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            codegen::gen_safe_read32(ctx);
            ctx.builder.instruction_body.const_i32(r as i32);
            codegen::gen_call_fn3(ctx.builder, "cmovcc32")
        }

        pub fn $name_reg(ctx: &mut JitContext, r1: u32, r2: u32) {
            codegen::gen_fn0_const_ret(ctx.builder, $cond);
            codegen::gen_get_reg32(ctx.builder, r1);
            ctx.builder.instruction_body.const_i32(r2 as i32);
            codegen::gen_call_fn3(ctx.builder, "cmovcc32")
        }
    );
);

define_cmovcc16!("test_o", instr16_0F40_mem_jit, instr16_0F40_reg_jit);
define_cmovcc16!("test_no", instr16_0F41_mem_jit, instr16_0F41_reg_jit);
define_cmovcc16!("test_b", instr16_0F42_mem_jit, instr16_0F42_reg_jit);
define_cmovcc16!("test_nb", instr16_0F43_mem_jit, instr16_0F43_reg_jit);
define_cmovcc16!("test_z", instr16_0F44_mem_jit, instr16_0F44_reg_jit);
define_cmovcc16!("test_nz", instr16_0F45_mem_jit, instr16_0F45_reg_jit);
define_cmovcc16!("test_be", instr16_0F46_mem_jit, instr16_0F46_reg_jit);
define_cmovcc16!("test_nbe", instr16_0F47_mem_jit, instr16_0F47_reg_jit);

define_cmovcc16!("test_s", instr16_0F48_mem_jit, instr16_0F48_reg_jit);
define_cmovcc16!("test_ns", instr16_0F49_mem_jit, instr16_0F49_reg_jit);
define_cmovcc16!("test_p", instr16_0F4A_mem_jit, instr16_0F4A_reg_jit);
define_cmovcc16!("test_np", instr16_0F4B_mem_jit, instr16_0F4B_reg_jit);
define_cmovcc16!("test_l", instr16_0F4C_mem_jit, instr16_0F4C_reg_jit);
define_cmovcc16!("test_nl", instr16_0F4D_mem_jit, instr16_0F4D_reg_jit);
define_cmovcc16!("test_le", instr16_0F4E_mem_jit, instr16_0F4E_reg_jit);
define_cmovcc16!("test_nle", instr16_0F4F_mem_jit, instr16_0F4F_reg_jit);

define_cmovcc32!("test_o", instr32_0F40_mem_jit, instr32_0F40_reg_jit);
define_cmovcc32!("test_no", instr32_0F41_mem_jit, instr32_0F41_reg_jit);
define_cmovcc32!("test_b", instr32_0F42_mem_jit, instr32_0F42_reg_jit);
define_cmovcc32!("test_nb", instr32_0F43_mem_jit, instr32_0F43_reg_jit);
define_cmovcc32!("test_z", instr32_0F44_mem_jit, instr32_0F44_reg_jit);
define_cmovcc32!("test_nz", instr32_0F45_mem_jit, instr32_0F45_reg_jit);
define_cmovcc32!("test_be", instr32_0F46_mem_jit, instr32_0F46_reg_jit);
define_cmovcc32!("test_nbe", instr32_0F47_mem_jit, instr32_0F47_reg_jit);

define_cmovcc32!("test_s", instr32_0F48_mem_jit, instr32_0F48_reg_jit);
define_cmovcc32!("test_ns", instr32_0F49_mem_jit, instr32_0F49_reg_jit);
define_cmovcc32!("test_p", instr32_0F4A_mem_jit, instr32_0F4A_reg_jit);
define_cmovcc32!("test_np", instr32_0F4B_mem_jit, instr32_0F4B_reg_jit);
define_cmovcc32!("test_l", instr32_0F4C_mem_jit, instr32_0F4C_reg_jit);
define_cmovcc32!("test_nl", instr32_0F4D_mem_jit, instr32_0F4D_reg_jit);
define_cmovcc32!("test_le", instr32_0F4E_mem_jit, instr32_0F4E_reg_jit);
define_cmovcc32!("test_nle", instr32_0F4F_mem_jit, instr32_0F4F_reg_jit);

macro_rules! define_setcc(
    ($cond:expr, $name_mem:ident, $name_reg:ident) => (
        pub fn $name_mem(ctx: &mut JitContext, modrm_byte: u8, _r: u32) {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address_local = ctx.builder.set_new_local();
            codegen::gen_fn0_const_ret(ctx.builder, $cond);
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
            codegen::gen_fn0_const_ret(ctx.builder, $cond);
            ctx.builder.instruction_body.const_i32(0);
            ctx.builder.instruction_body.ne_i32();
            ctx.builder.instruction_body.store_u8(0);
        }
    );
);

define_setcc!("test_o", instr_0F90_mem_jit, instr_0F90_reg_jit);
define_setcc!("test_no", instr_0F91_mem_jit, instr_0F91_reg_jit);
define_setcc!("test_b", instr_0F92_mem_jit, instr_0F92_reg_jit);
define_setcc!("test_nb", instr_0F93_mem_jit, instr_0F93_reg_jit);
define_setcc!("test_z", instr_0F94_mem_jit, instr_0F94_reg_jit);
define_setcc!("test_nz", instr_0F95_mem_jit, instr_0F95_reg_jit);
define_setcc!("test_be", instr_0F96_mem_jit, instr_0F96_reg_jit);
define_setcc!("test_nbe", instr_0F97_mem_jit, instr_0F97_reg_jit);

define_setcc!("test_s", instr_0F98_mem_jit, instr_0F98_reg_jit);
define_setcc!("test_ns", instr_0F99_mem_jit, instr_0F99_reg_jit);
define_setcc!("test_p", instr_0F9A_mem_jit, instr_0F9A_reg_jit);
define_setcc!("test_np", instr_0F9B_mem_jit, instr_0F9B_reg_jit);
define_setcc!("test_l", instr_0F9C_mem_jit, instr_0F9C_reg_jit);
define_setcc!("test_nl", instr_0F9D_mem_jit, instr_0F9D_reg_jit);
define_setcc!("test_le", instr_0F9E_mem_jit, instr_0F9E_reg_jit);
define_setcc!("test_nle", instr_0F9F_mem_jit, instr_0F9F_reg_jit);
