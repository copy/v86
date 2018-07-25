#![allow(non_snake_case)]

use codegen;
use cpu_context::CpuContext;
use global_pointers;
use jit::JitContext;
use jit::{GEN_LOCAL_SCRATCH0, GEN_LOCAL_SCRATCH1};
use modrm;
use prefix::SEG_PREFIX_ZERO;
use prefix::{PREFIX_66, PREFIX_67, PREFIX_F2, PREFIX_F3};
use regs::{AX, BP, BX, CX, DI, DX, SI, SP};
use regs::{CS, DS, ES, FS, GS, SS};
use regs::{EAX, EBP, EBX, ECX, EDI, EDX, ESI, ESP};
use wasmgen::module_init::WasmBuilder;
use wasmgen::wasm_util;

pub fn jit_instruction(cpu: &mut CpuContext, builder: &mut WasmBuilder, instr_flags: &mut u32) {
    cpu.prefixes = 0;
    let ctx = &mut JitContext { cpu, builder };
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
    let name = if ctx.cpu.ssize_32() {
        "push16_ss32"
    }
    else {
        "push16_ss16"
    };
    codegen::gen_fn1_reg16(ctx, name, r);
}

fn push32_reg_jit(ctx: &mut JitContext, r: u32) {
    let name = if ctx.cpu.ssize_32() {
        "push32_ss32"
    }
    else {
        "push32_ss16"
    };
    codegen::gen_fn1_reg32(ctx, name, r);
}

fn push16_imm_jit(ctx: &mut JitContext, imm: u32) {
    let name = if ctx.cpu.ssize_32() {
        "push16_ss32"
    }
    else {
        "push16_ss16"
    };
    codegen::gen_fn1_const(ctx, name, imm)
}

fn push32_imm_jit(ctx: &mut JitContext, imm: u32) {
    let name = if ctx.cpu.ssize_32() {
        "push32_ss32"
    }
    else {
        "push32_ss16"
    };
    codegen::gen_fn1_const(ctx, name, imm)
}

fn push16_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let name = if ctx.cpu.ssize_32() {
        "push16_ss32_mem"
    }
    else {
        "push16_ss16_mem"
    };
    codegen::gen_modrm_fn0(ctx, name)
}

fn push32_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let name = if ctx.cpu.ssize_32() {
        "push32_ss32_mem"
    }
    else {
        "push32_ss16_mem"
    };
    codegen::gen_modrm_fn0(ctx, name)
}

fn pop16_reg_jit(ctx: &mut JitContext, reg: u32) {
    if ctx.cpu.ssize_32() {
        codegen::gen_set_reg16_fn0(ctx, "pop16_ss32", reg);
    }
    else {
        codegen::gen_set_reg16_fn0(ctx, "pop16_ss16", reg);
    }
}

fn pop32_reg_jit(ctx: &mut JitContext, reg: u32) {
    if ctx.cpu.ssize_32() {
        codegen::gen_set_reg32s_fn0(ctx, "pop32s_ss32", reg);
    }
    else {
        codegen::gen_set_reg32s_fn0(ctx, "pop32s_ss16", reg);
    }
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

pub fn instr16_89_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    // TODO: Inlining
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_modrm_fn1(ctx, "instr16_89_mem", r);
}
pub fn instr16_89_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg16_r(ctx, r1, r2);
}
pub fn instr32_89_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    // Pseudo: safe_write32(modrm_resolve(modrm_byte), reg32s[r]);
    let address_local = GEN_LOCAL_SCRATCH0;
    let value_local = GEN_LOCAL_SCRATCH1;

    codegen::gen_modrm_resolve(ctx, modrm_byte);
    wasm_util::set_local(&mut ctx.builder.instruction_body, address_local);

    wasm_util::push_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg32_offset(r) as i32,
    );
    wasm_util::load_aligned_i32_from_stack(&mut ctx.builder.instruction_body, 0);
    wasm_util::set_local(&mut ctx.builder.instruction_body, value_local);

    codegen::gen_safe_write32(ctx, address_local, value_local);
}
pub fn instr32_89_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg32_r(ctx, r1, r2);
}

pub fn instr16_8B_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    // TODO: Inlining
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_modrm_fn1(ctx, "instr16_8B_mem", r);
}
pub fn instr16_8B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg16_r(ctx, r2, r1);
}
pub fn instr32_8B_mem_jit(ctx: &mut JitContext, modrm_byte: u8, r: u32) {
    // Pseudo: reg32s[r] = safe_read32s(modrm_resolve(modrm_byte));
    wasm_util::push_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg32_offset(r) as i32,
    );

    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_safe_read32(ctx);

    wasm_util::store_aligned_i32(&mut ctx.builder.instruction_body);
}
pub fn instr32_8B_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_set_reg32_r(ctx, r2, r1);
}

pub fn instr16_8D_mem_jit(ctx: &mut JitContext, modrm_byte: u8, reg: u32) {
    let loc = global_pointers::get_reg16_offset(reg);
    wasm_util::push_i32(&mut ctx.builder.instruction_body, loc as i32);
    ctx.cpu.prefixes |= SEG_PREFIX_ZERO;
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    wasm_util::store_aligned_u16(&mut ctx.builder.instruction_body);
}
pub fn instr32_8D_mem_jit(ctx: &mut JitContext, modrm_byte: u8, reg: u32) {
    let loc = global_pointers::get_reg32_offset(reg);
    wasm_util::push_i32(&mut ctx.builder.instruction_body, loc as i32);
    ctx.cpu.prefixes |= SEG_PREFIX_ZERO;
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    wasm_util::store_aligned_i32(&mut ctx.builder.instruction_body);
}

pub fn instr16_8D_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_fn2_const(ctx, "instr16_8D_reg", r1, r2);
}

pub fn instr32_8D_reg_jit(ctx: &mut JitContext, r1: u32, r2: u32) {
    codegen::gen_fn2_const(ctx, "instr32_8D_reg", r1, r2);
}

pub fn instr16_8F_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_fn0_const(ctx, "instr16_8F_0_mem_pre");
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_modrm_fn0(ctx, "instr16_8F_0_mem");
}
pub fn instr16_8F_0_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx, "instr16_8F_0_reg", r);
}
pub fn instr32_8F_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_fn0_const(ctx, "instr32_8F_0_mem_pre");
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    codegen::gen_modrm_fn0(ctx, "instr32_8F_0_mem");
}
pub fn instr32_8F_0_reg_jit(ctx: &mut JitContext, r: u32) {
    codegen::gen_fn1_const(ctx, "instr32_8F_0_reg", r);
}

pub fn instr16_E8_jit(ctx: &mut JitContext, imm: u32) {
    codegen::gen_fn1_const(ctx, "instr16_E8", imm);
}
pub fn instr32_E8_jit(ctx: &mut JitContext, imm: u32) {
    codegen::gen_fn1_const(ctx, "instr32_E8", imm);
}

pub fn instr16_E9_jit(ctx: &mut JitContext, imm: u32) { codegen::gen_jmp_rel16(ctx, imm as u16); }
pub fn instr32_E9_jit(ctx: &mut JitContext, imm: u32) {
    codegen::gen_relative_jump(ctx.builder, imm as i32);
}

pub fn instr16_C3_jit(ctx: &mut JitContext) {
    let cs_addr = global_pointers::get_seg_offset(CS);

    wasm_util::push_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::INSTRUCTION_POINTER as i32,
    );

    wasm_util::load_aligned_i32(&mut ctx.builder.instruction_body, cs_addr);
    codegen::gen_pop16(ctx);
    wasm_util::add_i32(&mut ctx.builder.instruction_body);

    wasm_util::store_aligned_i32(&mut ctx.builder.instruction_body);
}

pub fn instr32_C3_jit(ctx: &mut JitContext) {
    wasm_util::push_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::INSTRUCTION_POINTER as i32,
    );

    // cs = segment_offsets[CS]
    wasm_util::load_aligned_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_seg_offset(CS),
    );

    // ip = pop32s()
    codegen::gen_pop32s(ctx);

    // cs + ip
    wasm_util::add_i32(&mut ctx.builder.instruction_body);

    // dbg_assert(is_asize_32() || ip < 0x10000);

    wasm_util::store_aligned_i32(&mut ctx.builder.instruction_body);
}

pub fn instr16_EB_jit(ctx: &mut JitContext, imm8: u32) {
    codegen::gen_jmp_rel16(ctx, imm8 as u16);
    // dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
}

pub fn instr32_EB_jit(ctx: &mut JitContext, imm8: u32) {
    // jmp near
    codegen::gen_relative_jump(ctx.builder, imm8 as i32);
    // dbg_assert(is_asize_32() || get_real_eip() < 0x10000);
}

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

pub fn instr16_C7_0_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    // reg16[r] = imm;
    wasm_util::push_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg16_offset(r) as i32,
    );
    wasm_util::push_i32(&mut ctx.builder.instruction_body, imm as i32);
    wasm_util::store_aligned_u16(&mut ctx.builder.instruction_body);
}

pub fn instr16_C7_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    let imm = ctx.cpu.read_imm16() as u32;
    // XXX: inline called function
    codegen::gen_modrm_fn1(ctx, "instr16_C7_0_mem", imm);
}

pub fn instr32_C7_0_reg_jit(ctx: &mut JitContext, r: u32, imm: u32) {
    // reg32s[r] = imm;
    wasm_util::push_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg32_offset(r) as i32,
    );
    wasm_util::push_i32(&mut ctx.builder.instruction_body, imm as i32);
    wasm_util::store_aligned_i32(&mut ctx.builder.instruction_body);
}

pub fn instr32_C7_0_mem_jit(ctx: &mut JitContext, modrm_byte: u8) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);
    wasm_util::set_local(&mut ctx.builder.instruction_body, GEN_LOCAL_SCRATCH0);
    let imm = ctx.cpu.read_imm32();
    wasm_util::push_i32(&mut ctx.builder.instruction_body, imm as i32);
    wasm_util::set_local(&mut ctx.builder.instruction_body, GEN_LOCAL_SCRATCH1);
    codegen::gen_safe_write32(ctx, GEN_LOCAL_SCRATCH0, GEN_LOCAL_SCRATCH1);
}
