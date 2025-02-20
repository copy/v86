use crate::cpu::cpu::{
    tlb_data, FLAG_CARRY, FLAG_OVERFLOW, FLAG_SIGN, FLAG_ZERO, OPSIZE_16, OPSIZE_32, OPSIZE_8,
    TLB_GLOBAL, TLB_HAS_CODE, TLB_NO_USER, TLB_READONLY, TLB_VALID,
};
use crate::cpu::global_pointers;
use crate::cpu::memory;
use crate::jit::{Instruction, InstructionOperand, InstructionOperandDest, JitContext};
use crate::modrm;
use crate::modrm::ModrmByte;
use crate::opstats;
use crate::profiler;
use crate::regs;
use crate::wasmgen::wasm_builder::{WasmBuilder, WasmLocal, WasmLocalI64};

pub fn gen_add_cs_offset(ctx: &mut JitContext) {
    if !ctx.cpu.has_flat_segmentation() {
        ctx.builder
            .load_fixed_i32(global_pointers::get_seg_offset(regs::CS));
        ctx.builder.add_i32();
    }
}

pub fn gen_get_eip(builder: &mut WasmBuilder) {
    builder.load_fixed_i32(global_pointers::instruction_pointer as u32);
}

pub fn gen_set_eip_to_after_current_instruction(ctx: &mut JitContext) {
    ctx.builder
        .const_i32(global_pointers::instruction_pointer as i32);
    gen_get_eip(ctx.builder);
    ctx.builder.const_i32(!0xFFF);
    ctx.builder.and_i32();
    ctx.builder.const_i32(ctx.cpu.eip as i32 & 0xFFF);
    ctx.builder.or_i32();
    ctx.builder.store_aligned_i32(0);
}

pub fn gen_set_previous_eip_offset_from_eip_with_low_bits(
    builder: &mut WasmBuilder,
    low_bits: i32,
) {
    // previous_ip = instruction_pointer & ~0xFFF | low_bits;
    dbg_assert!(low_bits & !0xFFF == 0);
    builder.const_i32(global_pointers::previous_ip as i32);
    gen_get_eip(builder);
    builder.const_i32(!0xFFF);
    builder.and_i32();
    builder.const_i32(low_bits);
    builder.or_i32();
    builder.store_aligned_i32(0);
}

pub fn gen_set_eip_low_bits(builder: &mut WasmBuilder, low_bits: i32) {
    // instruction_pointer = instruction_pointer & ~0xFFF | low_bits;
    dbg_assert!(low_bits & !0xFFF == 0);
    builder.const_i32(global_pointers::instruction_pointer as i32);
    gen_get_eip(builder);
    builder.const_i32(!0xFFF);
    builder.and_i32();
    builder.const_i32(low_bits);
    builder.or_i32();
    builder.store_aligned_i32(0);
}

pub fn gen_set_eip_low_bits_and_jump_rel32(builder: &mut WasmBuilder, low_bits: i32, n: i32) {
    // instruction_pointer = (instruction_pointer & ~0xFFF | low_bits) + n;
    dbg_assert!(low_bits & !0xFFF == 0);
    builder.const_i32(global_pointers::instruction_pointer as i32);
    gen_get_eip(builder);
    builder.const_i32(!0xFFF);
    builder.and_i32();
    builder.const_i32(low_bits);
    builder.or_i32();
    if n != 0 {
        builder.const_i32(n);
        builder.add_i32();
    }
    builder.store_aligned_i32(0);
}

pub fn gen_relative_jump(builder: &mut WasmBuilder, n: i32) {
    // add n to instruction_pointer
    if n != 0 {
        builder.const_i32(global_pointers::instruction_pointer as i32);
        gen_get_eip(builder);
        builder.const_i32(n);
        builder.add_i32();
        builder.store_aligned_i32(0);
    }
}

pub fn gen_page_switch_check(
    ctx: &mut JitContext,
    next_block_addr: u32,
    last_instruction_addr: u32,
) {
    // After switching a page while in jitted code, check if the page mapping still holds

    gen_get_eip(ctx.builder);
    let address_local = ctx.builder.set_new_local();
    gen_get_phys_eip_plus_mem(ctx, &address_local);
    ctx.builder.free_local(address_local);

    ctx.builder
        .const_i32(next_block_addr as i32 + unsafe { memory::mem8 } as i32);
    ctx.builder.ne_i32();

    if cfg!(debug_assertions) {
        ctx.builder.if_void();
        gen_profiler_stat_increment(ctx.builder, profiler::stat::FAILED_PAGE_CHANGE);
        gen_debug_track_jit_exit(ctx.builder, last_instruction_addr);
        ctx.builder.br(ctx.exit_label);
        ctx.builder.block_end();
    }
    else {
        ctx.builder.br_if(ctx.exit_label);
    }
}

pub fn gen_update_instruction_counter(ctx: &mut JitContext) {
    ctx.builder
        .const_i32(global_pointers::instruction_counter as i32);
    ctx.builder
        .load_fixed_i32(global_pointers::instruction_counter as u32);
    ctx.builder.get_local(&ctx.instruction_counter);
    ctx.builder.add_i32();
    ctx.builder.store_aligned_i32(0);
}

pub fn gen_get_reg8(ctx: &mut JitContext, r: u32) {
    match r {
        regs::AL | regs::CL | regs::DL | regs::BL => {
            ctx.builder.get_local(&ctx.register_locals[r as usize]);
            ctx.builder.const_i32(0xFF);
            ctx.builder.and_i32();
        },
        regs::AH | regs::CH | regs::DH | regs::BH => {
            ctx.builder
                .get_local(&ctx.register_locals[(r - 4) as usize]);
            ctx.builder.const_i32(8);
            ctx.builder.shr_u_i32();
            ctx.builder.const_i32(0xFF);
            ctx.builder.and_i32();
        },
        _ => assert!(false),
    }
}

/// Return a new local referencing one of the 8 bit registers or a direct reference to one of the
/// register locals. Higher bits might be garbage (suitable for gen_cmp8 etc.). Must be freed with
/// gen_free_reg8_or_alias.
pub fn gen_get_reg8_or_alias_to_reg32(ctx: &mut JitContext, r: u32) -> WasmLocal {
    match r {
        regs::AL | regs::CL | regs::DL | regs::BL => ctx.register_locals[r as usize].unsafe_clone(),
        regs::AH | regs::CH | regs::DH | regs::BH => {
            ctx.builder
                .get_local(&ctx.register_locals[(r - 4) as usize]);
            ctx.builder.const_i32(8);
            ctx.builder.shr_u_i32();
            ctx.builder.set_new_local()
        },
        _ => panic!(),
    }
}

pub fn gen_free_reg8_or_alias(ctx: &mut JitContext, r: u32, local: WasmLocal) {
    match r {
        regs::AL | regs::CL | regs::DL | regs::BL => {},
        regs::AH | regs::CH | regs::DH | regs::BH => ctx.builder.free_local(local),
        _ => panic!(),
    }
}

pub fn gen_get_reg16(ctx: &mut JitContext, r: u32) {
    ctx.builder.get_local(&ctx.register_locals[r as usize]);
    ctx.builder.const_i32(0xFFFF);
    ctx.builder.and_i32();
}

pub fn gen_get_reg32(ctx: &mut JitContext, r: u32) {
    ctx.builder.get_local(&ctx.register_locals[r as usize]);
}

pub fn gen_set_reg8(ctx: &mut JitContext, r: u32) {
    match r {
        regs::AL | regs::CL | regs::DL | regs::BL => {
            // reg32[r] = stack_value & 0xFF | reg32[r] & ~0xFF
            ctx.builder.const_i32(0xFF);
            ctx.builder.and_i32();

            ctx.builder.get_local(&ctx.register_locals[r as usize]);
            ctx.builder.const_i32(!0xFF);
            ctx.builder.and_i32();

            ctx.builder.or_i32();
            ctx.builder.set_local(&ctx.register_locals[r as usize]);
        },
        regs::AH | regs::CH | regs::DH | regs::BH => {
            // reg32[r] = stack_value << 8 & 0xFF00 | reg32[r] & ~0xFF00
            ctx.builder.const_i32(8);
            ctx.builder.shl_i32();
            ctx.builder.const_i32(0xFF00);
            ctx.builder.and_i32();

            ctx.builder
                .get_local(&ctx.register_locals[(r - 4) as usize]);
            ctx.builder.const_i32(!0xFF00);
            ctx.builder.and_i32();

            ctx.builder.or_i32();
            ctx.builder
                .set_local(&ctx.register_locals[(r - 4) as usize]);
        },
        _ => assert!(false),
    }
}

pub fn gen_set_reg8_unmasked(ctx: &mut JitContext, r: u32) {
    if cfg!(debug_assertions) {
        let val = ctx.builder.set_new_local();
        ctx.builder.get_local(&val);
        ctx.builder.const_i32(!0xFF);
        ctx.builder.and_i32();
        ctx.builder.if_void();
        ctx.builder.unreachable();
        ctx.builder.block_end();
        ctx.builder.get_local(&val);
        ctx.builder.free_local(val);
    }

    match r {
        regs::AL | regs::CL | regs::DL | regs::BL => {
            // reg32[r] = stack_value | reg32[r] & ~0xFF
            ctx.builder.get_local(&ctx.register_locals[r as usize]);
            ctx.builder.const_i32(!0xFF);
            ctx.builder.and_i32();

            ctx.builder.or_i32();
            ctx.builder.set_local(&ctx.register_locals[r as usize]);
        },
        regs::AH | regs::CH | regs::DH | regs::BH => {
            // reg32[r] = stack_value << 8 | reg32[r] & ~0xFF00
            ctx.builder.const_i32(8);
            ctx.builder.shl_i32();
            ctx.builder.const_i32(0xFF00);
            ctx.builder.and_i32();

            ctx.builder
                .get_local(&ctx.register_locals[(r - 4) as usize]);
            ctx.builder.const_i32(!0xFF00);
            ctx.builder.and_i32();

            ctx.builder.or_i32();
            ctx.builder
                .set_local(&ctx.register_locals[(r - 4) as usize]);
        },
        _ => assert!(false),
    }
}

pub fn gen_set_reg16(ctx: &mut JitContext, r: u32) {
    gen_set_reg16_local(ctx.builder, &ctx.register_locals[r as usize]);
}

pub fn gen_set_reg16_unmasked(ctx: &mut JitContext, r: u32) {
    if cfg!(debug_assertions) {
        let val = ctx.builder.set_new_local();
        ctx.builder.get_local(&val);
        ctx.builder.const_i32(!0xFFFF);
        ctx.builder.and_i32();
        ctx.builder.if_void();
        ctx.builder.unreachable();
        ctx.builder.block_end();
        ctx.builder.get_local(&val);
        ctx.builder.free_local(val);
    }

    ctx.builder.get_local(&ctx.reg(r));
    ctx.builder.const_i32(!0xFFFF);
    ctx.builder.and_i32();
    ctx.builder.or_i32();
    ctx.builder.set_local(&ctx.reg(r));
}

pub fn gen_set_reg16_local(builder: &mut WasmBuilder, local: &WasmLocal) {
    // reg32[r] = v & 0xFFFF | reg32[r] & ~0xFFFF
    builder.const_i32(0xFFFF);
    builder.and_i32();
    builder.get_local(local);
    builder.const_i32(!0xFFFF);
    builder.and_i32();
    builder.or_i32();
    builder.set_local(local);
}

pub fn gen_set_reg32(ctx: &mut JitContext, r: u32) {
    ctx.builder.set_local(&ctx.register_locals[r as usize]);
}

pub fn decr_exc_asize(ctx: &mut JitContext) {
    gen_get_reg32(ctx, regs::ECX);
    ctx.builder.const_i32(1);
    ctx.builder.sub_i32();
    if ctx.cpu.asize_32() {
        gen_set_reg32(ctx, regs::ECX);
    }
    else {
        gen_set_reg16(ctx, regs::CX);
    }
}

pub fn gen_read_reg_xmm128_into_scratch(ctx: &mut JitContext, r: u32) {
    ctx.builder
        .const_i32(global_pointers::sse_scratch_register as i32);
    let dest = global_pointers::get_reg_xmm_offset(r);
    ctx.builder.const_i32(dest as i32);
    ctx.builder.load_aligned_i64(0);
    ctx.builder.store_aligned_i64(0);

    ctx.builder
        .const_i32(global_pointers::sse_scratch_register as i32 + 8);
    let dest = global_pointers::get_reg_xmm_offset(r) + 8;
    ctx.builder.const_i32(dest as i32);
    ctx.builder.load_aligned_i64(0);
    ctx.builder.store_aligned_i64(0);
}

pub fn gen_get_sreg(ctx: &mut JitContext, r: u32) {
    ctx.builder
        .load_fixed_u16(global_pointers::get_sreg_offset(r))
}

pub fn gen_get_ss_offset(ctx: &mut JitContext) {
    ctx.builder
        .load_fixed_i32(global_pointers::get_seg_offset(regs::SS));
}

pub fn gen_get_flags(builder: &mut WasmBuilder) {
    builder.load_fixed_i32(global_pointers::flags as u32);
}
fn gen_get_flags_changed(builder: &mut WasmBuilder) {
    builder.load_fixed_i32(global_pointers::flags_changed as u32);
}
fn gen_get_last_result(builder: &mut WasmBuilder, previous_instruction: &Instruction) {
    match previous_instruction {
        Instruction::Add {
            dest: InstructionOperandDest::WasmLocal(l),
            opsize: OPSIZE_32,
            ..
        }
        | Instruction::AdcSbb {
            dest: InstructionOperandDest::WasmLocal(l),
            opsize: OPSIZE_32,
            ..
        }
        | Instruction::Sub {
            dest: InstructionOperandDest::WasmLocal(l),
            opsize: OPSIZE_32,
            ..
        }
        | Instruction::Bitwise {
            dest: InstructionOperandDest::WasmLocal(l),
            opsize: OPSIZE_32,
        }
        | Instruction::NonZeroShift {
            dest: InstructionOperandDest::WasmLocal(l),
            opsize: OPSIZE_32,
        } => builder.get_local(&l),
        Instruction::Cmp {
            dest: InstructionOperandDest::WasmLocal(l),
            source,
            opsize: OPSIZE_32,
        } => {
            if source.is_zero() {
                builder.get_local(&l)
            }
            else {
                builder.load_fixed_i32(global_pointers::last_result as u32)
            }
        },
        _ => builder.load_fixed_i32(global_pointers::last_result as u32),
    }
}
fn gen_get_last_op_size(builder: &mut WasmBuilder) {
    builder.load_fixed_i32(global_pointers::last_op_size as u32);
}
fn gen_get_last_op1(builder: &mut WasmBuilder, previous_instruction: &Instruction) {
    match previous_instruction {
        Instruction::Cmp {
            dest: InstructionOperandDest::WasmLocal(l),
            source: _,
            opsize: OPSIZE_32,
        } => builder.get_local(&l),
        _ => builder.load_fixed_i32(global_pointers::last_op1 as u32),
    }
}

pub fn gen_get_page_fault(builder: &mut WasmBuilder) {
    builder.load_fixed_u8(global_pointers::page_fault as u32);
}

/// sign-extend a byte value on the stack and leave it on the stack
pub fn sign_extend_i8(builder: &mut WasmBuilder) {
    builder.const_i32(24);
    builder.shl_i32();
    builder.const_i32(24);
    builder.shr_s_i32();
}

/// sign-extend a two byte value on the stack and leave it on the stack
pub fn sign_extend_i16(builder: &mut WasmBuilder) {
    builder.const_i32(16);
    builder.shl_i32();
    builder.const_i32(16);
    builder.shr_s_i32();
}

pub fn gen_fn0_const(builder: &mut WasmBuilder, name: &str) { builder.call_fn0(name) }
pub fn gen_fn1_const(builder: &mut WasmBuilder, name: &str, arg0: u32) {
    builder.const_i32(arg0 as i32);
    builder.call_fn1(name);
}
pub fn gen_fn2_const(builder: &mut WasmBuilder, name: &str, arg0: u32, arg1: u32) {
    builder.const_i32(arg0 as i32);
    builder.const_i32(arg1 as i32);
    builder.call_fn2(name);
}

// helper functions for gen/generate_jit.js
pub fn gen_modrm_fn0(builder: &mut WasmBuilder, name: &str) {
    // generates: fn( _ )
    builder.call_fn1(name);
}
pub fn gen_modrm_fn1(builder: &mut WasmBuilder, name: &str, arg0: u32) {
    // generates: fn( _, arg0 )
    builder.const_i32(arg0 as i32);
    builder.call_fn2(name);
}

pub fn gen_modrm_resolve(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    modrm::gen(ctx, modrm_byte, 0)
}
pub fn gen_modrm_resolve_with_local(
    ctx: &mut JitContext,
    modrm_byte: ModrmByte,
    gen: &dyn Fn(&mut JitContext, &WasmLocal),
) {
    if let Some(r) = modrm::get_as_reg_index_if_possible(ctx, &modrm_byte) {
        gen(ctx, &ctx.reg(r));
    }
    else {
        gen_modrm_resolve(ctx, modrm_byte);
        let address = ctx.builder.set_new_local();
        gen(ctx, &address);
        ctx.builder.free_local(address);
    }
}
pub fn gen_modrm_resolve_with_esp_offset(
    ctx: &mut JitContext,
    modrm_byte: ModrmByte,
    esp_offset: i32,
) {
    modrm::gen(ctx, modrm_byte, esp_offset)
}

pub fn gen_set_reg8_r(ctx: &mut JitContext, dest: u32, src: u32) {
    // generates: reg8[r_dest] = reg8[r_src]
    if src != dest {
        gen_get_reg8(ctx, src);
        gen_set_reg8_unmasked(ctx, dest);
    }
}
pub fn gen_set_reg16_r(ctx: &mut JitContext, dest: u32, src: u32) {
    // generates: reg16[r_dest] = reg16[r_src]
    if src != dest {
        gen_get_reg16(ctx, src);
        gen_set_reg16_unmasked(ctx, dest);
    }
}
pub fn gen_set_reg32_r(ctx: &mut JitContext, dest: u32, src: u32) {
    // generates: reg32[r_dest] = reg32[r_src]
    if src != dest {
        gen_get_reg32(ctx, src);
        gen_set_reg32(ctx, dest);
    }
}

pub fn gen_modrm_resolve_safe_read8(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| gen_safe_read8(ctx, addr));
}
pub fn gen_modrm_resolve_safe_read16(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| gen_safe_read16(ctx, addr));
}
pub fn gen_modrm_resolve_safe_read32(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| gen_safe_read32(ctx, addr));
}
pub fn gen_modrm_resolve_safe_read64(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| gen_safe_read64(ctx, addr));
}
pub fn gen_modrm_resolve_safe_read128(
    ctx: &mut JitContext,
    modrm_byte: ModrmByte,
    where_to_write: u32,
) {
    gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| {
        gen_safe_read128(ctx, addr, where_to_write)
    });
}

pub fn gen_safe_read8(ctx: &mut JitContext, address_local: &WasmLocal) {
    gen_safe_read(ctx, BitSize::BYTE, address_local, None);
}
pub fn gen_safe_read16(ctx: &mut JitContext, address_local: &WasmLocal) {
    gen_safe_read(ctx, BitSize::WORD, address_local, None);
}
pub fn gen_safe_read32(ctx: &mut JitContext, address_local: &WasmLocal) {
    gen_safe_read(ctx, BitSize::DWORD, address_local, None);
}
pub fn gen_safe_read64(ctx: &mut JitContext, address_local: &WasmLocal) {
    gen_safe_read(ctx, BitSize::QWORD, &address_local, None);
}
pub fn gen_safe_read128(ctx: &mut JitContext, address_local: &WasmLocal, where_to_write: u32) {
    gen_safe_read(ctx, BitSize::DQWORD, &address_local, Some(where_to_write));
}

// only used internally for gen_safe_write
enum GenSafeWriteValue<'a> {
    I32(&'a WasmLocal),
    I64(&'a WasmLocalI64),
    TwoI64s(&'a WasmLocalI64, &'a WasmLocalI64),
}

enum GenSafeReadWriteValue {
    I32(WasmLocal),
    I64(WasmLocalI64),
}

#[derive(Copy, Clone, Eq, PartialEq)]
pub enum BitSize {
    BYTE,
    WORD,
    DWORD,
    QWORD,
    DQWORD,
}
impl BitSize {
    pub fn bytes(&self) -> u32 {
        match self {
            BitSize::BYTE => 1,
            BitSize::WORD => 2,
            BitSize::DWORD => 4,
            BitSize::QWORD => 8,
            BitSize::DQWORD => 16,
        }
    }
}

pub fn gen_safe_write8(ctx: &mut JitContext, address_local: &WasmLocal, value_local: &WasmLocal) {
    gen_safe_write(
        ctx,
        BitSize::BYTE,
        address_local,
        GenSafeWriteValue::I32(value_local),
    )
}
pub fn gen_safe_write16(ctx: &mut JitContext, address_local: &WasmLocal, value_local: &WasmLocal) {
    gen_safe_write(
        ctx,
        BitSize::WORD,
        address_local,
        GenSafeWriteValue::I32(value_local),
    )
}
pub fn gen_safe_write32(ctx: &mut JitContext, address_local: &WasmLocal, value_local: &WasmLocal) {
    gen_safe_write(
        ctx,
        BitSize::DWORD,
        address_local,
        GenSafeWriteValue::I32(value_local),
    )
}
pub fn gen_safe_write64(
    ctx: &mut JitContext,
    address_local: &WasmLocal,
    value_local: &WasmLocalI64,
) {
    gen_safe_write(
        ctx,
        BitSize::QWORD,
        address_local,
        GenSafeWriteValue::I64(value_local),
    )
}

pub fn gen_safe_write128(
    ctx: &mut JitContext,
    address_local: &WasmLocal,
    value_local_low: &WasmLocalI64,
    value_local_high: &WasmLocalI64,
) {
    gen_safe_write(
        ctx,
        BitSize::DQWORD,
        address_local,
        GenSafeWriteValue::TwoI64s(value_local_low, value_local_high),
    )
}

fn gen_safe_read(
    ctx: &mut JitContext,
    bits: BitSize,
    address_local: &WasmLocal,
    where_to_write: Option<u32>,
) {
    // Execute a virtual memory read. All slow paths (memory-mapped IO, tlb miss, page fault and
    // read across page boundary are handled in safe_read_jit_slow

    //   entry <- tlb_data[addr >> 12 << 2]
    //   if entry & MASK == TLB_VALID && (addr & 0xFFF) <= 0x1000 - bytes: goto fast
    //   entry <- safe_read_jit_slow(addr, instruction_pointer)
    //   if page_fault: goto exit-with-pagefault
    //   fast: mem[(entry & ~0xFFF) ^ addr]

    let cont = ctx.builder.block_void();
    ctx.builder.get_local(&address_local);

    ctx.builder.const_i32(12);
    ctx.builder.shr_u_i32();
    ctx.builder.const_i32(2);
    ctx.builder.shl_i32();

    ctx.builder
        .load_aligned_i32(unsafe { &tlb_data[0] as *const i32 as u32 });
    let entry_local = ctx.builder.tee_new_local();

    ctx.builder.const_i32(
        (0xFFF
            & !TLB_READONLY
            & !TLB_GLOBAL
            & !TLB_HAS_CODE
            & !(if ctx.cpu.cpl3() { 0 } else { TLB_NO_USER })) as i32,
    );
    ctx.builder.and_i32();

    ctx.builder.const_i32(TLB_VALID as i32);
    ctx.builder.eq_i32();

    if bits != BitSize::BYTE {
        ctx.builder.get_local(&address_local);
        ctx.builder.const_i32(0xFFF);
        ctx.builder.and_i32();
        ctx.builder.const_i32(0x1000 - bits.bytes() as i32);
        ctx.builder.le_i32();

        ctx.builder.and_i32();
    }

    ctx.builder.br_if(cont);

    if cfg!(feature = "profiler") {
        ctx.builder.get_local(&address_local);
        ctx.builder.get_local(&entry_local);
        ctx.builder.call_fn2("report_safe_read_jit_slow");
    }

    ctx.builder.get_local(&address_local);
    ctx.builder
        .const_i32(ctx.start_of_current_instruction as i32 & 0xFFF);
    match bits {
        BitSize::BYTE => {
            ctx.builder.call_fn2_ret("safe_read8_slow_jit");
        },
        BitSize::WORD => {
            ctx.builder.call_fn2_ret("safe_read16_slow_jit");
        },
        BitSize::DWORD => {
            ctx.builder.call_fn2_ret("safe_read32s_slow_jit");
        },
        BitSize::QWORD => {
            ctx.builder.call_fn2_ret("safe_read64s_slow_jit");
        },
        BitSize::DQWORD => {
            ctx.builder.call_fn2_ret("safe_read128s_slow_jit");
        },
    }
    ctx.builder.tee_local(&entry_local);
    ctx.builder.const_i32(1);
    ctx.builder.and_i32();

    if cfg!(feature = "profiler") {
        ctx.builder.if_void();
        gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
        ctx.builder.block_end();

        ctx.builder.get_local(&entry_local);
        ctx.builder.const_i32(1);
        ctx.builder.and_i32();
    }

    ctx.builder.br_if(ctx.exit_with_fault_label);

    ctx.builder.block_end();

    gen_profiler_stat_increment(ctx.builder, profiler::stat::SAFE_READ_FAST); // XXX: Both fast and slow

    ctx.builder.get_local(&entry_local);
    ctx.builder.const_i32(!0xFFF);
    ctx.builder.and_i32();
    ctx.builder.get_local(&address_local);
    ctx.builder.xor_i32();

    // where_to_write is only used by dqword
    dbg_assert!((where_to_write != None) == (bits == BitSize::DQWORD));

    match bits {
        BitSize::BYTE => {
            ctx.builder.load_u8(0);
        },
        BitSize::WORD => {
            ctx.builder.load_unaligned_u16(0);
        },
        BitSize::DWORD => {
            ctx.builder.load_unaligned_i32(0);
        },
        BitSize::QWORD => {
            ctx.builder.load_unaligned_i64(0);
        },
        BitSize::DQWORD => {
            let where_to_write = where_to_write.unwrap();
            let virt_address_local = ctx.builder.set_new_local();
            ctx.builder.const_i32(0);
            ctx.builder.get_local(&virt_address_local);
            ctx.builder.load_unaligned_i64(0);
            ctx.builder.store_unaligned_i64(where_to_write);

            ctx.builder.const_i32(0);
            ctx.builder.get_local(&virt_address_local);
            ctx.builder.load_unaligned_i64(8);
            ctx.builder.store_unaligned_i64(where_to_write + 8);

            ctx.builder.free_local(virt_address_local);
        },
    }

    ctx.builder.free_local(entry_local);
}

pub fn gen_get_phys_eip_plus_mem(ctx: &mut JitContext, address_local: &WasmLocal) {
    // Similar to gen_safe_read, but return the physical eip + memory::mem rather than reading from memory
    // In functions that need to use this value we need to fix it by substracting memory::mem
    // this is done in order to remove one instruction from the fast path of memory accesses (no need to add
    // memory::mem anymore ).
    // We need to account for this in gen_page_switch_check and we compare with next_block_addr + memory::mem8
    // We cannot the same while processing an AbsoluteEip flow control change so there we need to fix the value
    // by subscracting memory::mem. Overall, since AbsoluteEip is encountered less often than memory accesses so
    // this ends up improving perf.
    // Does not (need to) handle mapped memory
    // XXX: Currently does not use ctx.start_of_current_instruction, but rather assumes that eip is
    //      already correct (pointing at the current instruction)

    let cont = ctx.builder.block_void();
    ctx.builder.get_local(&address_local);

    ctx.builder.const_i32(12);
    ctx.builder.shr_u_i32();
    ctx.builder.const_i32(2);
    ctx.builder.shl_i32();

    ctx.builder
        .load_aligned_i32(unsafe { &tlb_data[0] as *const i32 as u32 });
    let entry_local = ctx.builder.tee_new_local();

    ctx.builder.const_i32(
        (0xFFF
            & !TLB_READONLY
            & !TLB_GLOBAL
            & !TLB_HAS_CODE
            & !(if ctx.cpu.cpl3() { 0 } else { TLB_NO_USER })) as i32,
    );
    ctx.builder.and_i32();

    ctx.builder.const_i32(TLB_VALID as i32);
    ctx.builder.eq_i32();

    ctx.builder.br_if(cont);

    if cfg!(feature = "profiler") {
        ctx.builder.get_local(&address_local);
        ctx.builder.get_local(&entry_local);
        ctx.builder.call_fn2("report_safe_read_jit_slow");
    }

    ctx.builder.get_local(&address_local);
    ctx.builder.call_fn1_ret("get_phys_eip_slow_jit");

    ctx.builder.tee_local(&entry_local);
    ctx.builder.const_i32(1);
    ctx.builder.and_i32();

    if cfg!(feature = "profiler") {
        ctx.builder.if_void();
        gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction); // XXX
        ctx.builder.block_end();

        ctx.builder.get_local(&entry_local);
        ctx.builder.const_i32(1);
        ctx.builder.and_i32();
    }

    ctx.builder.br_if(ctx.exit_with_fault_label);

    ctx.builder.block_end();

    gen_profiler_stat_increment(ctx.builder, profiler::stat::SAFE_READ_FAST); // XXX: Both fast and slow

    ctx.builder.get_local(&entry_local);
    ctx.builder.const_i32(!0xFFF);
    ctx.builder.and_i32();
    ctx.builder.get_local(&address_local);
    ctx.builder.xor_i32();

    ctx.builder.free_local(entry_local);
}

fn gen_safe_write(
    ctx: &mut JitContext,
    bits: BitSize,
    address_local: &WasmLocal,
    value_local: GenSafeWriteValue,
) {
    // Execute a virtual memory write. All slow paths (memory-mapped IO, tlb miss, page fault,
    // write across page boundary and page containing jitted code are handled in safe_write_jit_slow

    //   entry <- tlb_data[addr >> 12 << 2]
    //   if entry & MASK == TLB_VALID && (addr & 0xFFF) <= 0x1000 - bytes: goto fast
    //   entry <- safe_write_jit_slow(addr, value, instruction_pointer)
    //   if page_fault: goto exit-with-pagefault
    //   fast: mem[(entry & ~0xFFF) ^ addr] <- value

    let cont = ctx.builder.block_void();
    ctx.builder.get_local(&address_local);

    ctx.builder.const_i32(12);
    ctx.builder.shr_u_i32();
    ctx.builder.const_i32(2);
    ctx.builder.shl_i32();

    ctx.builder
        .load_aligned_i32(unsafe { &tlb_data[0] as *const i32 as u32 });
    let entry_local = ctx.builder.tee_new_local();

    ctx.builder
        .const_i32((0xFFF & !TLB_GLOBAL & !(if ctx.cpu.cpl3() { 0 } else { TLB_NO_USER })) as i32);
    ctx.builder.and_i32();

    ctx.builder.const_i32(TLB_VALID as i32);
    ctx.builder.eq_i32();

    if bits != BitSize::BYTE {
        ctx.builder.get_local(&address_local);
        ctx.builder.const_i32(0xFFF);
        ctx.builder.and_i32();
        ctx.builder.const_i32(0x1000 - bits.bytes() as i32);
        ctx.builder.le_i32();

        ctx.builder.and_i32();
    }

    ctx.builder.br_if(cont);

    if cfg!(feature = "profiler") {
        ctx.builder.get_local(&address_local);
        ctx.builder.get_local(&entry_local);
        ctx.builder.call_fn2("report_safe_write_jit_slow");
    }

    ctx.builder.get_local(&address_local);
    match value_local {
        GenSafeWriteValue::I32(local) => ctx.builder.get_local(local),
        GenSafeWriteValue::I64(local) => ctx.builder.get_local_i64(local),
        GenSafeWriteValue::TwoI64s(local1, local2) => {
            ctx.builder.get_local_i64(local1);
            ctx.builder.get_local_i64(local2)
        },
    }
    ctx.builder
        .const_i32(ctx.start_of_current_instruction as i32 & 0xFFF);
    match bits {
        BitSize::BYTE => {
            ctx.builder.call_fn3_ret("safe_write8_slow_jit");
        },
        BitSize::WORD => {
            ctx.builder.call_fn3_ret("safe_write16_slow_jit");
        },
        BitSize::DWORD => {
            ctx.builder.call_fn3_ret("safe_write32_slow_jit");
        },
        BitSize::QWORD => {
            ctx.builder
                .call_fn3_i32_i64_i32_ret("safe_write64_slow_jit");
        },
        BitSize::DQWORD => {
            ctx.builder
                .call_fn4_i32_i64_i64_i32_ret("safe_write128_slow_jit");
        },
    }
    ctx.builder.tee_local(&entry_local);
    ctx.builder.const_i32(1);
    ctx.builder.and_i32();

    if cfg!(feature = "profiler") {
        ctx.builder.if_void();
        gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
        ctx.builder.block_end();

        ctx.builder.get_local(&entry_local);
        ctx.builder.const_i32(1);
        ctx.builder.and_i32();
    }

    ctx.builder.br_if(ctx.exit_with_fault_label);

    ctx.builder.block_end();

    gen_profiler_stat_increment(ctx.builder, profiler::stat::SAFE_WRITE_FAST); // XXX: Both fast and slow

    ctx.builder.get_local(&entry_local);
    ctx.builder.const_i32(!0xFFF);
    ctx.builder.and_i32();
    ctx.builder.get_local(&address_local);
    ctx.builder.xor_i32();

    match value_local {
        GenSafeWriteValue::I32(local) => ctx.builder.get_local(local),
        GenSafeWriteValue::I64(local) => ctx.builder.get_local_i64(local),
        GenSafeWriteValue::TwoI64s(local1, local2) => {
            assert!(bits == BitSize::DQWORD);

            let virt_address_local = ctx.builder.tee_new_local();
            ctx.builder.get_local_i64(local1);
            ctx.builder.store_unaligned_i64(0);

            ctx.builder.get_local(&virt_address_local);
            ctx.builder.get_local_i64(local2);
            ctx.builder.store_unaligned_i64(8);
            ctx.builder.free_local(virt_address_local);
        },
    }
    match bits {
        BitSize::BYTE => {
            ctx.builder.store_u8(0);
        },
        BitSize::WORD => {
            ctx.builder.store_unaligned_u16(0);
        },
        BitSize::DWORD => {
            ctx.builder.store_unaligned_i32(0);
        },
        BitSize::QWORD => {
            ctx.builder.store_unaligned_i64(0);
        },
        BitSize::DQWORD => {}, // handled above
    }

    ctx.builder.free_local(entry_local);
}

pub fn gen_safe_read_write(
    ctx: &mut JitContext,
    bits: BitSize,
    address_local: &WasmLocal,
    f: &dyn Fn(&mut JitContext),
) {
    // Execute a virtual memory read+write. All slow paths (memory-mapped IO, tlb miss, page fault,
    // write across page boundary and page containing jitted code are handled in
    // safe_read_write_jit_slow

    //   entry <- tlb_data[addr >> 12 << 2]
    //   can_use_fast_path <- entry & MASK == TLB_VALID && (addr & 0xFFF) <= 0x1000 - bytes
    //   if can_use_fast_path: goto fast
    //   entry <- safe_read_write_jit_slow(addr, instruction_pointer)
    //   if page_fault: goto exit-with-pagefault
    //   fast: value <- f(mem[(entry & ~0xFFF) ^ addr])
    //   if !can_use_fast_path { safe_write_jit_slow(addr, value, instruction_pointer) }
    //   mem[(entry & ~0xFFF) ^ addr] <- value

    let cont = ctx.builder.block_void();
    ctx.builder.get_local(address_local);

    ctx.builder.const_i32(12);
    ctx.builder.shr_u_i32();
    ctx.builder.const_i32(2);
    ctx.builder.shl_i32();

    ctx.builder
        .load_aligned_i32(unsafe { &tlb_data[0] as *const i32 as u32 });
    let entry_local = ctx.builder.tee_new_local();

    ctx.builder
        .const_i32((0xFFF & !TLB_GLOBAL & !(if ctx.cpu.cpl3() { 0 } else { TLB_NO_USER })) as i32);
    ctx.builder.and_i32();

    ctx.builder.const_i32(TLB_VALID as i32);
    ctx.builder.eq_i32();

    if bits != BitSize::BYTE {
        ctx.builder.get_local(&address_local);
        ctx.builder.const_i32(0xFFF);
        ctx.builder.and_i32();
        ctx.builder.const_i32(0x1000 - bits.bytes() as i32);
        ctx.builder.le_i32();
        ctx.builder.and_i32();
    }

    let can_use_fast_path_local = ctx.builder.tee_new_local();

    ctx.builder.br_if(cont);

    if cfg!(feature = "profiler") {
        ctx.builder.get_local(&address_local);
        ctx.builder.get_local(&entry_local);
        ctx.builder.call_fn2("report_safe_read_write_jit_slow");
    }

    ctx.builder.get_local(&address_local);
    ctx.builder
        .const_i32(ctx.start_of_current_instruction as i32 & 0xFFF);

    match bits {
        BitSize::BYTE => {
            ctx.builder.call_fn2_ret("safe_read_write8_slow_jit");
        },
        BitSize::WORD => {
            ctx.builder.call_fn2_ret("safe_read_write16_slow_jit");
        },
        BitSize::DWORD => {
            ctx.builder.call_fn2_ret("safe_read_write32s_slow_jit");
        },
        BitSize::QWORD => {
            ctx.builder.call_fn2_ret("safe_read_write64_slow_jit");
        },
        BitSize::DQWORD => {
            dbg_assert!(false);
        },
    }
    ctx.builder.tee_local(&entry_local);
    ctx.builder.const_i32(1);
    ctx.builder.and_i32();

    if cfg!(feature = "profiler") {
        ctx.builder.if_void();
        gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
        ctx.builder.block_end();

        ctx.builder.get_local(&entry_local);
        ctx.builder.const_i32(1);
        ctx.builder.and_i32();
    }

    ctx.builder.br_if(ctx.exit_with_fault_label);

    ctx.builder.block_end();

    gen_profiler_stat_increment(ctx.builder, profiler::stat::SAFE_READ_WRITE_FAST); // XXX: Also slow

    ctx.builder.get_local(&entry_local);
    ctx.builder.const_i32(!0xFFF);
    ctx.builder.and_i32();
    ctx.builder.get_local(&address_local);
    ctx.builder.xor_i32();

    ctx.builder.free_local(entry_local);
    let phys_addr_local = ctx.builder.tee_new_local();

    match bits {
        BitSize::BYTE => {
            ctx.builder.load_u8(0);
        },
        BitSize::WORD => {
            ctx.builder.load_unaligned_u16(0);
        },
        BitSize::DWORD => {
            ctx.builder.load_unaligned_i32(0);
        },
        BitSize::QWORD => {
            ctx.builder.load_unaligned_i64(0);
        },
        BitSize::DQWORD => assert!(false), // not used
    }

    // value is now on stack

    f(ctx);

    // TODO: Could get rid of this local by returning one from f
    let value_local = if bits == BitSize::QWORD {
        GenSafeReadWriteValue::I64(ctx.builder.set_new_local_i64())
    }
    else {
        GenSafeReadWriteValue::I32(ctx.builder.set_new_local())
    };

    ctx.builder.get_local(&can_use_fast_path_local);

    ctx.builder.eqz_i32();
    ctx.builder.if_void();
    {
        ctx.builder.get_local(&address_local);

        match &value_local {
            GenSafeReadWriteValue::I32(l) => ctx.builder.get_local(l),
            GenSafeReadWriteValue::I64(l) => ctx.builder.get_local_i64(l),
        }

        ctx.builder
            .const_i32(ctx.start_of_current_instruction as i32 & 0xFFF);

        match bits {
            BitSize::BYTE => {
                ctx.builder.call_fn3_ret("safe_write8_slow_jit");
            },
            BitSize::WORD => {
                ctx.builder.call_fn3_ret("safe_write16_slow_jit");
            },
            BitSize::DWORD => {
                ctx.builder.call_fn3_ret("safe_write32_slow_jit");
            },
            BitSize::QWORD => {
                ctx.builder
                    .call_fn3_i32_i64_i32_ret("safe_write64_slow_jit");
            },
            BitSize::DQWORD => {
                dbg_assert!(false);
            },
        }

        if cfg!(debug_assertions) {
            ctx.builder.const_i32(1);
            ctx.builder.and_i32();

            ctx.builder.if_void();
            {
                // handled above
                ctx.builder.const_i32(match bits {
                    BitSize::BYTE => 8,
                    BitSize::WORD => 16,
                    BitSize::DWORD => 32,
                    BitSize::QWORD => 64,
                    _ => {
                        dbg_assert!(false);
                        0
                    },
                });
                ctx.builder.get_local(&address_local);
                ctx.builder.call_fn2("bug_gen_safe_read_write_page_fault");
            }
            ctx.builder.block_end();
        }
        else {
            ctx.builder.drop_();
        }
    }
    ctx.builder.block_end();

    ctx.builder.get_local(&phys_addr_local);
    match &value_local {
        GenSafeReadWriteValue::I32(l) => ctx.builder.get_local(l),
        GenSafeReadWriteValue::I64(l) => ctx.builder.get_local_i64(l),
    }

    match bits {
        BitSize::BYTE => {
            ctx.builder.store_u8(0);
        },
        BitSize::WORD => {
            ctx.builder.store_unaligned_u16(0);
        },
        BitSize::DWORD => {
            ctx.builder.store_unaligned_i32(0);
        },
        BitSize::QWORD => {
            ctx.builder.store_unaligned_i64(0);
        },
        BitSize::DQWORD => {
            dbg_assert!(false);
        },
    }

    match value_local {
        GenSafeReadWriteValue::I32(l) => ctx.builder.free_local(l),
        GenSafeReadWriteValue::I64(l) => ctx.builder.free_local_i64(l),
    }
    ctx.builder.free_local(can_use_fast_path_local);
    ctx.builder.free_local(phys_addr_local);
}

#[cfg(debug_assertions)]
#[no_mangle]
pub fn bug_gen_safe_read_write_page_fault(bits: i32, addr: u32) {
    dbg_log!("bug: gen_safe_read_write_page_fault {} {:x}", bits, addr);
    dbg_assert!(false);
}

pub fn gen_jmp_rel16(builder: &mut WasmBuilder, rel16: u16) {
    let cs_offset_addr = global_pointers::get_seg_offset(regs::CS);
    builder.load_fixed_i32(cs_offset_addr);
    let local = builder.set_new_local();

    // generate:
    // *instruction_pointer = cs_offset + ((*instruction_pointer - cs_offset + rel16) & 0xFFFF);
    {
        builder.const_i32(global_pointers::instruction_pointer as i32);

        gen_get_eip(builder);
        builder.get_local(&local);
        builder.sub_i32();

        builder.const_i32(rel16 as i32);
        builder.add_i32();

        builder.const_i32(0xFFFF);
        builder.and_i32();

        builder.get_local(&local);
        builder.add_i32();

        builder.store_aligned_i32(0);
    }
    builder.free_local(local);
}

pub fn gen_pop16_ss16(ctx: &mut JitContext) {
    // sp = segment_offsets[SS] + reg16[SP] (or just reg16[SP] if has_flat_segmentation)
    gen_get_reg16(ctx, regs::SP);

    if !ctx.cpu.has_flat_segmentation() {
        gen_get_ss_offset(ctx);
        ctx.builder.add_i32();
    }

    // result = safe_read16(sp)
    let address_local = ctx.builder.set_new_local();
    gen_safe_read16(ctx, &address_local);
    ctx.builder.free_local(address_local);

    // reg16[SP] += 2;
    gen_get_reg16(ctx, regs::SP);
    ctx.builder.const_i32(2);
    ctx.builder.add_i32();
    gen_set_reg16(ctx, regs::SP);

    // return value is already on stack
}

pub fn gen_pop16_ss32(ctx: &mut JitContext) {
    // esp = segment_offsets[SS] + reg32[ESP] (or just reg32[ESP] if has_flat_segmentation)
    gen_get_reg32(ctx, regs::ESP);

    if !ctx.cpu.has_flat_segmentation() {
        gen_get_ss_offset(ctx);
        ctx.builder.add_i32();
    }

    // result = safe_read16(esp)
    let address_local = ctx.builder.set_new_local();
    gen_safe_read16(ctx, &address_local);
    ctx.builder.free_local(address_local);

    // reg32[ESP] += 2;
    gen_get_reg32(ctx, regs::ESP);
    ctx.builder.const_i32(2);
    ctx.builder.add_i32();
    gen_set_reg32(ctx, regs::ESP);

    // return value is already on stack
}

pub fn gen_pop16(ctx: &mut JitContext) {
    if ctx.cpu.ssize_32() {
        gen_pop16_ss32(ctx);
    }
    else {
        gen_pop16_ss16(ctx);
    }
}

pub fn gen_pop32s_ss16(ctx: &mut JitContext) {
    // sp = reg16[SP]
    gen_get_reg16(ctx, regs::SP);

    // result = safe_read32s(segment_offsets[SS] + sp) (or just sp if has_flat_segmentation)
    if !ctx.cpu.has_flat_segmentation() {
        gen_get_ss_offset(ctx);
        ctx.builder.add_i32();
    }

    let address_local = ctx.builder.set_new_local();
    gen_safe_read32(ctx, &address_local);
    ctx.builder.free_local(address_local);

    // reg16[SP] = sp + 4;
    gen_get_reg16(ctx, regs::SP);
    ctx.builder.const_i32(4);
    ctx.builder.add_i32();
    gen_set_reg16(ctx, regs::SP);

    // return value is already on stack
}

pub fn gen_pop32s_ss32(ctx: &mut JitContext) {
    if !ctx.cpu.has_flat_segmentation() {
        gen_get_reg32(ctx, regs::ESP);
        gen_get_ss_offset(ctx);
        ctx.builder.add_i32();
        let address_local = ctx.builder.set_new_local();
        gen_safe_read32(ctx, &address_local);
        ctx.builder.free_local(address_local);
    }
    else {
        let reg = ctx.register_locals[regs::ESP as usize].unsafe_clone();
        gen_safe_read32(ctx, &reg);
    }

    gen_get_reg32(ctx, regs::ESP);
    ctx.builder.const_i32(4);
    ctx.builder.add_i32();
    gen_set_reg32(ctx, regs::ESP);

    // return value is already on stack
}

pub fn gen_pop32s(ctx: &mut JitContext) {
    if ctx.cpu.ssize_32() {
        gen_pop32s_ss32(ctx);
    }
    else {
        gen_pop32s_ss16(ctx);
    }
}

pub fn gen_adjust_stack_reg(ctx: &mut JitContext, offset: u32) {
    if ctx.cpu.ssize_32() {
        gen_get_reg32(ctx, regs::ESP);
        ctx.builder.const_i32(offset as i32);
        ctx.builder.add_i32();
        gen_set_reg32(ctx, regs::ESP);
    }
    else {
        gen_get_reg16(ctx, regs::SP);
        ctx.builder.const_i32(offset as i32);
        ctx.builder.add_i32();
        gen_set_reg16(ctx, regs::SP);
    }
}

pub fn gen_leave(ctx: &mut JitContext, os32: bool) {
    // [e]bp = safe_read{16,32}([e]bp)

    if ctx.cpu.ssize_32() {
        gen_get_reg32(ctx, regs::EBP);
    }
    else {
        gen_get_reg16(ctx, regs::BP);
    }

    let old_vbp = ctx.builder.tee_new_local();

    if !ctx.cpu.has_flat_segmentation() {
        gen_get_ss_offset(ctx);
        ctx.builder.add_i32();
    }
    if os32 {
        let address_local = ctx.builder.set_new_local();
        gen_safe_read32(ctx, &address_local);
        ctx.builder.free_local(address_local);
        gen_set_reg32(ctx, regs::EBP);
    }
    else {
        let address_local = ctx.builder.set_new_local();
        gen_safe_read16(ctx, &address_local);
        ctx.builder.free_local(address_local);
        gen_set_reg16(ctx, regs::BP);
    }

    // [e]sp = [e]bp + (os32 ? 4 : 2)

    if ctx.cpu.ssize_32() {
        ctx.builder.get_local(&old_vbp);
        ctx.builder.const_i32(if os32 { 4 } else { 2 });
        ctx.builder.add_i32();
        gen_set_reg32(ctx, regs::ESP);
    }
    else {
        ctx.builder.get_local(&old_vbp);
        ctx.builder.const_i32(if os32 { 4 } else { 2 });
        ctx.builder.add_i32();
        gen_set_reg16(ctx, regs::SP);
    }

    ctx.builder.free_local(old_vbp);
}

pub fn gen_task_switch_test(ctx: &mut JitContext) {
    // generate if(cr[0] & (CR0_EM | CR0_TS)) { task_switch_test_jit(); goto exit_with_fault; }
    let cr0_offset = global_pointers::get_creg_offset(0);

    dbg_assert!(regs::CR0_EM | regs::CR0_TS <= 0xFF);
    ctx.builder.load_fixed_u8(cr0_offset);
    ctx.builder.const_i32((regs::CR0_EM | regs::CR0_TS) as i32);
    ctx.builder.and_i32();

    ctx.builder.if_void();
    {
        gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
        gen_fn1_const(
            ctx.builder,
            "task_switch_test_jit",
            ctx.start_of_current_instruction & 0xFFF,
        );
        ctx.builder.br(ctx.exit_with_fault_label);
    }
    ctx.builder.block_end();
}

pub fn gen_task_switch_test_mmx(ctx: &mut JitContext) {
    // generate if(cr[0] & (CR0_EM | CR0_TS)) { task_switch_test_mmx_jit(); goto exit_with_fault; }
    let cr0_offset = global_pointers::get_creg_offset(0);

    dbg_assert!(regs::CR0_EM | regs::CR0_TS <= 0xFF);
    ctx.builder.load_fixed_u8(cr0_offset);
    ctx.builder.const_i32((regs::CR0_EM | regs::CR0_TS) as i32);
    ctx.builder.and_i32();

    ctx.builder.if_void();
    {
        gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
        gen_fn1_const(
            ctx.builder,
            "task_switch_test_mmx_jit",
            ctx.start_of_current_instruction & 0xFFF,
        );
        ctx.builder.br(ctx.exit_with_fault_label);
    }
    ctx.builder.block_end();
}

pub fn gen_push16(ctx: &mut JitContext, value_local: &WasmLocal) {
    if ctx.cpu.ssize_32() {
        gen_get_reg32(ctx, regs::ESP);
    }
    else {
        gen_get_reg16(ctx, regs::SP);
    };

    ctx.builder.const_i32(2);
    ctx.builder.sub_i32();

    let reg_updated_local = if !ctx.cpu.ssize_32() || !ctx.cpu.has_flat_segmentation() {
        let reg_updated_local = ctx.builder.tee_new_local();
        if !ctx.cpu.ssize_32() {
            ctx.builder.const_i32(0xFFFF);
            ctx.builder.and_i32();
        }

        if !ctx.cpu.has_flat_segmentation() {
            gen_get_ss_offset(ctx);
            ctx.builder.add_i32();
        }

        let sp_local = ctx.builder.set_new_local();
        gen_safe_write16(ctx, &sp_local, &value_local);
        ctx.builder.free_local(sp_local);

        ctx.builder.get_local(&reg_updated_local);
        reg_updated_local
    }
    else {
        // short path: The address written to is equal to ESP/SP minus two
        let reg_updated_local = ctx.builder.tee_new_local();
        gen_safe_write16(ctx, &reg_updated_local, &value_local);
        reg_updated_local
    };

    if ctx.cpu.ssize_32() {
        gen_set_reg32(ctx, regs::ESP);
    }
    else {
        gen_set_reg16(ctx, regs::SP);
    };
    ctx.builder.free_local(reg_updated_local);
}

pub fn gen_push32(ctx: &mut JitContext, value_local: &WasmLocal) {
    if ctx.cpu.ssize_32() {
        gen_get_reg32(ctx, regs::ESP);
    }
    else {
        gen_get_reg16(ctx, regs::SP);
    };

    ctx.builder.const_i32(4);
    ctx.builder.sub_i32();

    let new_sp_local = if !ctx.cpu.ssize_32() || !ctx.cpu.has_flat_segmentation() {
        let new_sp_local = ctx.builder.tee_new_local();
        if !ctx.cpu.ssize_32() {
            ctx.builder.const_i32(0xFFFF);
            ctx.builder.and_i32();
        }

        if !ctx.cpu.has_flat_segmentation() {
            gen_get_ss_offset(ctx);
            ctx.builder.add_i32();
        }

        let sp_local = ctx.builder.set_new_local();

        gen_safe_write32(ctx, &sp_local, &value_local);
        ctx.builder.free_local(sp_local);

        ctx.builder.get_local(&new_sp_local);
        new_sp_local
    }
    else {
        // short path: The address written to is equal to ESP/SP minus four
        let new_sp_local = ctx.builder.tee_new_local();
        gen_safe_write32(ctx, &new_sp_local, &value_local);
        new_sp_local
    };

    if ctx.cpu.ssize_32() {
        gen_set_reg32(ctx, regs::ESP);
    }
    else {
        gen_set_reg16(ctx, regs::SP);
    };
    ctx.builder.free_local(new_sp_local);
}

pub fn gen_push32_sreg(ctx: &mut JitContext, reg: u32) {
    gen_get_sreg(ctx, reg);
    let value_local = ctx.builder.set_new_local();

    if ctx.cpu.ssize_32() {
        gen_get_reg32(ctx, regs::ESP);
    }
    else {
        gen_get_reg16(ctx, regs::SP);
    };

    ctx.builder.const_i32(4);
    ctx.builder.sub_i32();

    let new_sp_local = if !ctx.cpu.ssize_32() || !ctx.cpu.has_flat_segmentation() {
        let new_sp_local = ctx.builder.tee_new_local();
        if !ctx.cpu.ssize_32() {
            ctx.builder.const_i32(0xFFFF);
            ctx.builder.and_i32();
        }

        if !ctx.cpu.has_flat_segmentation() {
            gen_get_ss_offset(ctx);
            ctx.builder.add_i32();
        }

        let sp_local = ctx.builder.set_new_local();

        gen_safe_write16(ctx, &sp_local, &value_local);
        ctx.builder.free_local(sp_local);

        ctx.builder.get_local(&new_sp_local);
        new_sp_local
    }
    else {
        // short path: The address written to is equal to ESP/SP minus four
        let new_sp_local = ctx.builder.tee_new_local();
        gen_safe_write16(ctx, &new_sp_local, &value_local);
        new_sp_local
    };

    if ctx.cpu.ssize_32() {
        gen_set_reg32(ctx, regs::ESP);
    }
    else {
        gen_set_reg16(ctx, regs::SP);
    };
    ctx.builder.free_local(new_sp_local);
    ctx.builder.free_local(value_local);
}

pub fn gen_get_real_eip(ctx: &mut JitContext) {
    gen_get_eip(ctx.builder);
    ctx.builder.const_i32(!0xFFF);
    ctx.builder.and_i32();
    ctx.builder.const_i32(ctx.cpu.eip as i32 & 0xFFF);
    ctx.builder.or_i32();
    if !ctx.cpu.has_flat_segmentation() {
        ctx.builder
            .load_fixed_i32(global_pointers::get_seg_offset(regs::CS));
        ctx.builder.sub_i32();
    }
}

pub fn gen_set_last_op1(builder: &mut WasmBuilder, source: &WasmLocal) {
    builder.const_i32(global_pointers::last_op1 as i32);
    builder.get_local(&source);
    builder.store_aligned_i32(0);
}

pub fn gen_set_last_result(builder: &mut WasmBuilder, source: &WasmLocal) {
    builder.const_i32(global_pointers::last_result as i32);
    builder.get_local(&source);
    builder.store_aligned_i32(0);
}

pub fn gen_clear_flags_changed_bits(builder: &mut WasmBuilder, bits_to_clear: i32) {
    builder.const_i32(global_pointers::flags_changed as i32);
    gen_get_flags_changed(builder);
    builder.const_i32(!bits_to_clear);
    builder.and_i32();
    builder.store_aligned_i32(0);
}

pub fn gen_set_last_op_size_and_flags_changed(
    builder: &mut WasmBuilder,
    last_op_size: i32,
    flags_changed: i32,
) {
    dbg_assert!(last_op_size == OPSIZE_8 || last_op_size == OPSIZE_16 || last_op_size == OPSIZE_32);
    dbg_assert!(global_pointers::last_op_size as i32 % 8 == 0);
    dbg_assert!(global_pointers::last_op_size as i32 + 4 == global_pointers::flags_changed as i32);
    builder.const_i32(global_pointers::last_op_size as i32);
    builder.const_i64(last_op_size as u32 as i64 | (flags_changed as u32 as i64) << 32);
    builder.store_aligned_i64(0);
}

pub fn gen_set_flags_bits(builder: &mut WasmBuilder, bits_to_set: i32) {
    builder.const_i32(global_pointers::flags as i32);
    gen_get_flags(builder);
    builder.const_i32(bits_to_set);
    builder.or_i32();
    builder.store_aligned_i32(0);
}

pub fn gen_clear_flags_bits(builder: &mut WasmBuilder, bits_to_clear: i32) {
    builder.const_i32(global_pointers::flags as i32);
    gen_get_flags(builder);
    builder.const_i32(!bits_to_clear);
    builder.and_i32();
    builder.store_aligned_i32(0);
}

#[derive(PartialEq)]
pub enum ConditionNegate {
    True,
    False,
}

pub fn gen_getzf(ctx: &mut JitContext, negate: ConditionNegate) {
    match &ctx.previous_instruction {
        Instruction::Cmp {
            dest: InstructionOperandDest::WasmLocal(dest),
            source: InstructionOperand::WasmLocal(source),
            opsize: OPSIZE_32,
        } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            ctx.builder.get_local(dest);
            ctx.builder.get_local(source);
            if negate == ConditionNegate::False {
                ctx.builder.eq_i32();
            }
            else {
                ctx.builder.ne_i32();
            }
        },
        Instruction::Cmp {
            dest: InstructionOperandDest::WasmLocal(dest),
            source: InstructionOperand::Immediate(0),
            opsize: OPSIZE_32,
        } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            ctx.builder.get_local(dest);
            if negate == ConditionNegate::False {
                ctx.builder.eqz_i32();
            }
        },
        Instruction::Cmp {
            dest: InstructionOperandDest::WasmLocal(dest),
            source: InstructionOperand::Immediate(i),
            opsize: OPSIZE_32,
        } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            ctx.builder.get_local(dest);
            ctx.builder.const_i32(*i);
            if negate == ConditionNegate::False {
                ctx.builder.eq_i32();
            }
            else {
                ctx.builder.ne_i32();
            }
        },
        Instruction::Cmp { .. }
        | Instruction::Sub { .. }
        | Instruction::Add { .. }
        | Instruction::AdcSbb { .. }
        | Instruction::NonZeroShift { .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            gen_get_last_result(ctx.builder, &ctx.previous_instruction);
            if negate == ConditionNegate::False {
                ctx.builder.eqz_i32();
            }
        },
        Instruction::Bitwise { opsize, .. } => {
            let &opsize = opsize;
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            // Note: Necessary because test{8,16} don't mask either last_result or any of their operands
            // TODO: Use local instead of last_result for 8-bit/16-bit
            if opsize == OPSIZE_32 {
                gen_get_last_result(ctx.builder, &ctx.previous_instruction);
            }
            else if opsize == OPSIZE_16 {
                ctx.builder
                    .load_fixed_u16(global_pointers::last_result as u32);
            }
            else if opsize == OPSIZE_8 {
                ctx.builder
                    .load_fixed_u8(global_pointers::last_result as u32);
            }
            if negate == ConditionNegate::False {
                ctx.builder.eqz_i32();
            }
        },
        &Instruction::Other => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_UNOPTIMISED);
            gen_get_flags_changed(ctx.builder);
            ctx.builder.const_i32(FLAG_ZERO);
            ctx.builder.and_i32();
            ctx.builder.if_i32();

            gen_get_last_result(ctx.builder, &ctx.previous_instruction);
            let last_result = ctx.builder.tee_new_local();
            ctx.builder.const_i32(-1);
            ctx.builder.xor_i32();
            ctx.builder.get_local(&last_result);
            ctx.builder.free_local(last_result);
            ctx.builder.const_i32(1);
            ctx.builder.sub_i32();
            ctx.builder.and_i32();
            gen_get_last_op_size(ctx.builder);
            ctx.builder.shr_u_i32();
            ctx.builder.const_i32(1);
            ctx.builder.and_i32();

            ctx.builder.else_();
            gen_get_flags(ctx.builder);
            ctx.builder.const_i32(FLAG_ZERO);
            ctx.builder.and_i32();
            ctx.builder.block_end();

            if negate == ConditionNegate::True {
                ctx.builder.eqz_i32();
            }
        },
    }
}

pub fn gen_getcf(ctx: &mut JitContext, negate: ConditionNegate) {
    match &ctx.previous_instruction {
        Instruction::Cmp { source, opsize, .. }
        | Instruction::Sub {
            source,
            opsize,
            is_dec: false,
            ..
        } => {
            // Note: x < y and x < x - y can be used interchangeably (see getcf)
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
            match (opsize, source) {
                (&OPSIZE_32, InstructionOperand::WasmLocal(l)) => ctx.builder.get_local(l),
                (_, &InstructionOperand::Immediate(i)) => ctx.builder.const_i32(i),
                _ => gen_get_last_result(ctx.builder, &ctx.previous_instruction),
            }
            if negate == ConditionNegate::True {
                ctx.builder.geu_i32();
            }
            else {
                ctx.builder.ltu_i32();
            }
        },
        Instruction::Add {
            source,
            opsize,
            is_inc: false,
            ..
        } => {
            gen_get_last_result(ctx.builder, &ctx.previous_instruction);
            match (opsize, source) {
                (&OPSIZE_32, InstructionOperand::WasmLocal(l)) => ctx.builder.get_local(l),
                (_, &InstructionOperand::Immediate(i)) => ctx.builder.const_i32(i),
                _ => gen_get_last_op1(ctx.builder, &ctx.previous_instruction),
            }
            if negate == ConditionNegate::True {
                ctx.builder.geu_i32();
            }
            else {
                ctx.builder.ltu_i32();
            }
        },
        Instruction::Add { is_inc: true, .. } | Instruction::Sub { is_dec: true, .. } => {
            gen_get_flags(ctx.builder);
            ctx.builder.const_i32(FLAG_CARRY);
            ctx.builder.and_i32();
            if negate == ConditionNegate::True {
                ctx.builder.eqz_i32();
            }
        },
        Instruction::Bitwise { .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            ctx.builder
                .const_i32(if negate == ConditionNegate::True { 1 } else { 0 });
        },
        Instruction::NonZeroShift { .. } | Instruction::AdcSbb { .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            gen_get_flags(ctx.builder);
            ctx.builder.const_i32(FLAG_CARRY);
            ctx.builder.and_i32();
            if negate == ConditionNegate::True {
                ctx.builder.eqz_i32();
            }
        },
        &Instruction::Other => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_UNOPTIMISED);

            gen_get_flags_changed(ctx.builder);
            let flags_changed = ctx.builder.tee_new_local();
            ctx.builder.const_i32(FLAG_CARRY);
            ctx.builder.and_i32();
            ctx.builder.if_i32();

            ctx.builder.get_local(&flags_changed);
            ctx.builder.const_i32(31);
            ctx.builder.shr_s_i32();
            ctx.builder.free_local(flags_changed);
            let sub_mask = ctx.builder.set_new_local();

            gen_get_last_result(ctx.builder, &ctx.previous_instruction);
            ctx.builder.get_local(&sub_mask);
            ctx.builder.xor_i32();

            gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
            ctx.builder.get_local(&sub_mask);
            ctx.builder.xor_i32();

            ctx.builder.ltu_i32();

            ctx.builder.else_();
            gen_get_flags(ctx.builder);
            ctx.builder.const_i32(FLAG_CARRY);
            ctx.builder.and_i32();
            ctx.builder.block_end();

            ctx.builder.free_local(sub_mask);

            if negate == ConditionNegate::True {
                ctx.builder.eqz_i32();
            }
        },
    }
}

pub fn gen_getsf(ctx: &mut JitContext, negate: ConditionNegate) {
    match &ctx.previous_instruction {
        Instruction::Cmp { opsize, .. }
        | Instruction::Sub { opsize, .. }
        | Instruction::Add { opsize, .. }
        | Instruction::AdcSbb { opsize, .. }
        | Instruction::Bitwise { opsize, .. }
        | Instruction::NonZeroShift { opsize, .. } => {
            let &opsize = opsize;
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            gen_get_last_result(ctx.builder, &ctx.previous_instruction);
            if opsize == OPSIZE_32 {
                ctx.builder.const_i32(0);
                if negate == ConditionNegate::True {
                    ctx.builder.ge_i32();
                }
                else {
                    ctx.builder.lt_i32();
                }
            }
            else {
                // TODO: use register (see get_last_result)
                ctx.builder
                    .const_i32(if opsize == OPSIZE_16 { 0x8000 } else { 0x80 });
                ctx.builder.and_i32();
                if negate == ConditionNegate::True {
                    ctx.builder.eqz_i32();
                }
            }
        },
        &Instruction::Other => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_UNOPTIMISED);
            gen_get_flags_changed(ctx.builder);
            ctx.builder.const_i32(FLAG_SIGN);
            ctx.builder.and_i32();
            ctx.builder.if_i32();
            {
                gen_get_last_result(ctx.builder, &ctx.previous_instruction);
                gen_get_last_op_size(ctx.builder);
                ctx.builder.shr_u_i32();
                ctx.builder.const_i32(1);
                ctx.builder.and_i32();
            }
            ctx.builder.else_();
            {
                gen_get_flags(ctx.builder);
                ctx.builder.const_i32(FLAG_SIGN);
                ctx.builder.and_i32();
            }
            ctx.builder.block_end();
            if negate == ConditionNegate::True {
                ctx.builder.eqz_i32();
            }
        },
    }
}

pub fn gen_getof(ctx: &mut JitContext) {
    match &ctx.previous_instruction {
        Instruction::Cmp { opsize, .. } | Instruction::Sub { opsize, .. } => {
            // TODO: a better formula might be possible
            let &opsize = opsize;
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
            gen_get_last_result(ctx.builder, &ctx.previous_instruction);
            ctx.builder.xor_i32();

            gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
            gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
            gen_get_last_result(ctx.builder, &ctx.previous_instruction);
            ctx.builder.sub_i32();
            ctx.builder.xor_i32();
            ctx.builder.and_i32();

            ctx.builder.const_i32(if opsize == OPSIZE_32 {
                0x8000_0000u32 as i32
            }
            else if opsize == OPSIZE_16 {
                0x8000
            }
            else {
                0x80
            });
            ctx.builder.and_i32();
        },
        Instruction::Add { opsize, .. } => {
            // TODO: a better formula might be possible
            let &opsize = opsize;
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
            gen_get_last_result(ctx.builder, &ctx.previous_instruction);
            ctx.builder.xor_i32();

            gen_get_last_result(ctx.builder, &ctx.previous_instruction);
            gen_get_last_result(ctx.builder, &ctx.previous_instruction);
            gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
            ctx.builder.sub_i32();
            ctx.builder.xor_i32();
            ctx.builder.and_i32();

            ctx.builder.const_i32(if opsize == OPSIZE_32 {
                0x8000_0000u32 as i32
            }
            else if opsize == OPSIZE_16 {
                0x8000
            }
            else {
                0x80
            });
            ctx.builder.and_i32();
        },
        Instruction::Bitwise { .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            ctx.builder.const_i32(0);
        },
        Instruction::NonZeroShift { .. } | Instruction::AdcSbb { .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            gen_get_flags(ctx.builder);
            ctx.builder.const_i32(FLAG_OVERFLOW);
            ctx.builder.and_i32();
        },
        &Instruction::Other => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_UNOPTIMISED);
            gen_get_flags_changed(ctx.builder);
            let flags_changed = ctx.builder.tee_new_local();
            ctx.builder.const_i32(FLAG_OVERFLOW);
            ctx.builder.and_i32();
            ctx.builder.if_i32();
            {
                gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
                let last_op1 = ctx.builder.tee_new_local();
                gen_get_last_result(ctx.builder, &ctx.previous_instruction);
                let last_result = ctx.builder.tee_new_local();
                ctx.builder.xor_i32();

                ctx.builder.get_local(&last_result);
                ctx.builder.get_local(&last_op1);
                ctx.builder.sub_i32();
                gen_get_flags_changed(ctx.builder);
                ctx.builder.const_i32(31);
                ctx.builder.shr_u_i32();
                ctx.builder.sub_i32();

                ctx.builder.get_local(&last_result);
                ctx.builder.xor_i32();

                ctx.builder.and_i32();

                gen_get_last_op_size(ctx.builder);
                ctx.builder.shr_u_i32();
                ctx.builder.const_i32(1);
                ctx.builder.and_i32();

                ctx.builder.free_local(last_op1);
                ctx.builder.free_local(last_result);
            }
            ctx.builder.else_();
            {
                gen_get_flags(ctx.builder);
                ctx.builder.const_i32(FLAG_OVERFLOW);
                ctx.builder.and_i32();
            }
            ctx.builder.block_end();
            ctx.builder.free_local(flags_changed);
        },
    }
}

pub fn gen_test_be(ctx: &mut JitContext, negate: ConditionNegate) {
    match &ctx.previous_instruction {
        Instruction::Cmp {
            dest,
            source,
            opsize,
        } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            match dest {
                InstructionOperandDest::WasmLocal(l) => {
                    ctx.builder.get_local(l);
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 0xFF } else { 0xFFFF });
                        ctx.builder.and_i32();
                    }
                },
                InstructionOperandDest::Other => {
                    gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
                },
            }
            match source {
                InstructionOperand::WasmLocal(l) => {
                    ctx.builder.get_local(l);
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 0xFF } else { 0xFFFF });
                        ctx.builder.and_i32();
                    }
                },
                InstructionOperand::Other => {
                    gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
                    gen_get_last_result(ctx.builder, &ctx.previous_instruction);
                    ctx.builder.sub_i32();
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 0xFF } else { 0xFFFF });
                        ctx.builder.and_i32();
                    }
                },
                &InstructionOperand::Immediate(i) => {
                    dbg_assert!(*opsize != OPSIZE_8 || i >= 0 && i < 0x100);
                    dbg_assert!(*opsize != OPSIZE_16 || i >= 0 && i < 0x10000);
                    ctx.builder.const_i32(i);
                },
            }

            if negate == ConditionNegate::True {
                ctx.builder.gtu_i32();
            }
            else {
                ctx.builder.leu_i32();
            }
        },
        Instruction::Sub {
            opsize,
            source,
            is_dec: false,
            ..
        } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);

            gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
            match (opsize, source) {
                (&OPSIZE_32, InstructionOperand::WasmLocal(l)) => ctx.builder.get_local(l),
                (_, &InstructionOperand::Immediate(i)) => ctx.builder.const_i32(i),
                _ => {
                    gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
                    gen_get_last_result(ctx.builder, &ctx.previous_instruction);
                    ctx.builder.sub_i32();
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 0xFF } else { 0xFFFF });
                        ctx.builder.and_i32();
                    }
                },
            }

            if negate == ConditionNegate::True {
                ctx.builder.gtu_i32();
            }
            else {
                ctx.builder.leu_i32();
            }
        },
        &Instruction::Bitwise { .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            gen_getzf(ctx, negate);
        },
        &Instruction::Add { .. } | &Instruction::Sub { is_dec: true, .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            // not the best code generation, but reasonable for this fairly uncommon case
            gen_getcf(ctx, ConditionNegate::False);
            gen_getzf(ctx, ConditionNegate::False);
            ctx.builder.or_i32();
            if negate == ConditionNegate::True {
                ctx.builder.eqz_i32();
            }
        },
        Instruction::Other | Instruction::NonZeroShift { .. } | Instruction::AdcSbb { .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_UNOPTIMISED);
            gen_getcf(ctx, ConditionNegate::False);
            gen_getzf(ctx, ConditionNegate::False);
            ctx.builder.or_i32();
            if negate == ConditionNegate::True {
                ctx.builder.eqz_i32();
            }
        },
    }
}

pub fn gen_test_l(ctx: &mut JitContext, negate: ConditionNegate) {
    match &ctx.previous_instruction {
        Instruction::Cmp {
            dest,
            source,
            opsize,
        } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            match dest {
                InstructionOperandDest::WasmLocal(l) => {
                    ctx.builder.get_local(l);
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                        ctx.builder.shl_i32();
                    }
                },
                InstructionOperandDest::Other => {
                    gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                        ctx.builder.shl_i32();
                    }
                },
            }
            match source {
                InstructionOperand::WasmLocal(l) => {
                    ctx.builder.get_local(l);
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                        ctx.builder.shl_i32();
                    }
                },
                InstructionOperand::Other => {
                    gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
                    gen_get_last_result(ctx.builder, &ctx.previous_instruction);
                    ctx.builder.sub_i32();
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                        ctx.builder.shl_i32();
                    }
                },
                &InstructionOperand::Immediate(i) => {
                    ctx.builder.const_i32(i);
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                        ctx.builder.shl_i32();
                    }
                },
            }
            if negate == ConditionNegate::True {
                ctx.builder.ge_i32();
            }
            else {
                ctx.builder.lt_i32();
            }
        },
        Instruction::Sub { opsize, source, .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
            if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                ctx.builder
                    .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                ctx.builder.shl_i32();
            }
            match (opsize, source) {
                (&OPSIZE_32, InstructionOperand::WasmLocal(l)) => ctx.builder.get_local(l),
                (_, &InstructionOperand::Immediate(i)) => ctx.builder.const_i32(
                    i << if *opsize == OPSIZE_32 {
                        0
                    }
                    else if *opsize == OPSIZE_16 {
                        16
                    }
                    else {
                        24
                    },
                ),
                _ => {
                    gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
                    gen_get_last_result(ctx.builder, &ctx.previous_instruction);
                    ctx.builder.sub_i32();
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                        ctx.builder.shl_i32();
                    }
                },
            }
            if negate == ConditionNegate::True {
                ctx.builder.ge_i32();
            }
            else {
                ctx.builder.lt_i32();
            }
        },
        &Instruction::Bitwise { .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            gen_getsf(ctx, negate);
        },
        &Instruction::Other
        | Instruction::Add { .. }
        | Instruction::NonZeroShift { .. }
        | Instruction::AdcSbb { .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_UNOPTIMISED);
            if let Instruction::Add { .. } = ctx.previous_instruction {
                gen_profiler_stat_increment(
                    ctx.builder,
                    profiler::stat::CONDITION_UNOPTIMISED_UNHANDLED_L,
                );
            }
            gen_getsf(ctx, ConditionNegate::False);
            ctx.builder.eqz_i32();
            gen_getof(ctx);
            ctx.builder.eqz_i32();
            ctx.builder.xor_i32();
            if negate == ConditionNegate::True {
                ctx.builder.eqz_i32();
            }
        },
    }
}

pub fn gen_test_le(ctx: &mut JitContext, negate: ConditionNegate) {
    match &ctx.previous_instruction {
        Instruction::Cmp {
            dest,
            source,
            opsize,
        } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            match dest {
                InstructionOperandDest::WasmLocal(l) => {
                    ctx.builder.get_local(l);
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                        ctx.builder.shl_i32();
                    }
                },
                InstructionOperandDest::Other => {
                    gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                        ctx.builder.shl_i32();
                    }
                },
            }
            match source {
                InstructionOperand::WasmLocal(l) => {
                    ctx.builder.get_local(l);
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                        ctx.builder.shl_i32();
                    }
                },
                InstructionOperand::Other => {
                    gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
                    gen_get_last_result(ctx.builder, &ctx.previous_instruction);
                    ctx.builder.sub_i32();
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                        ctx.builder.shl_i32();
                    }
                },
                &InstructionOperand::Immediate(i) => {
                    ctx.builder.const_i32(i);
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                        ctx.builder.shl_i32();
                    }
                },
            }
            if negate == ConditionNegate::True {
                ctx.builder.gt_i32();
            }
            else {
                ctx.builder.le_i32();
            }
        },
        Instruction::Sub { opsize, source, .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
            if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                ctx.builder
                    .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                ctx.builder.shl_i32();
            }
            match (opsize, source) {
                (&OPSIZE_32, InstructionOperand::WasmLocal(l)) => ctx.builder.get_local(l),
                (_, &InstructionOperand::Immediate(i)) => ctx.builder.const_i32(
                    i << if *opsize == OPSIZE_32 {
                        0
                    }
                    else if *opsize == OPSIZE_16 {
                        16
                    }
                    else {
                        24
                    },
                ),
                _ => {
                    gen_get_last_op1(ctx.builder, &ctx.previous_instruction);
                    gen_get_last_result(ctx.builder, &ctx.previous_instruction);
                    ctx.builder.sub_i32();
                    if *opsize == OPSIZE_8 || *opsize == OPSIZE_16 {
                        ctx.builder
                            .const_i32(if *opsize == OPSIZE_8 { 24 } else { 16 });
                        ctx.builder.shl_i32();
                    }
                },
            }
            if negate == ConditionNegate::True {
                ctx.builder.gt_i32();
            }
            else {
                ctx.builder.le_i32();
            }
        },
        &Instruction::Bitwise { .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_OPTIMISED);
            // TODO: Could probably be improved (<= 0)
            gen_test_l(ctx, ConditionNegate::False);
            gen_getzf(ctx, ConditionNegate::False);
            ctx.builder.or_i32();
            if negate == ConditionNegate::True {
                ctx.builder.eqz_i32();
            }
        },
        Instruction::Other
        | Instruction::Add { .. }
        | Instruction::NonZeroShift { .. }
        | Instruction::AdcSbb { .. } => {
            gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_UNOPTIMISED);
            if let Instruction::Add { .. } = ctx.previous_instruction {
                gen_profiler_stat_increment(
                    ctx.builder,
                    profiler::stat::CONDITION_UNOPTIMISED_UNHANDLED_LE,
                );
            }
            gen_test_l(ctx, ConditionNegate::False);
            gen_getzf(ctx, ConditionNegate::False);
            ctx.builder.or_i32();
            if negate == ConditionNegate::True {
                ctx.builder.eqz_i32();
            }
        },
    }
}

pub fn gen_test_loopnz(ctx: &mut JitContext, is_asize_32: bool) {
    gen_test_loop(ctx, is_asize_32);
    ctx.builder.eqz_i32();
    gen_getzf(ctx, ConditionNegate::False);
    ctx.builder.or_i32();
    ctx.builder.eqz_i32();
}
pub fn gen_test_loopz(ctx: &mut JitContext, is_asize_32: bool) {
    gen_test_loop(ctx, is_asize_32);
    ctx.builder.eqz_i32();
    gen_getzf(ctx, ConditionNegate::False);
    ctx.builder.eqz_i32();
    ctx.builder.or_i32();
    ctx.builder.eqz_i32();
}
pub fn gen_test_loop(ctx: &mut JitContext, is_asize_32: bool) {
    if is_asize_32 {
        gen_get_reg32(ctx, regs::ECX);
    }
    else {
        gen_get_reg16(ctx, regs::CX);
    }
}
pub fn gen_test_jcxz(ctx: &mut JitContext, is_asize_32: bool) {
    if is_asize_32 {
        gen_get_reg32(ctx, regs::ECX);
    }
    else {
        gen_get_reg16(ctx, regs::CX);
    }
    ctx.builder.eqz_i32();
}

pub fn gen_fpu_get_sti(ctx: &mut JitContext, i: u32) {
    ctx.builder
        .const_i32(global_pointers::sse_scratch_register as i32);
    ctx.builder.const_i32(i as i32);
    ctx.builder.call_fn2("fpu_get_sti_jit");
    ctx.builder
        .load_fixed_i64(global_pointers::sse_scratch_register as u32);
    ctx.builder
        .load_fixed_u16(global_pointers::sse_scratch_register as u32 + 8);
}

pub fn gen_fpu_load_m32(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    ctx.builder
        .const_i32(global_pointers::sse_scratch_register as i32);
    gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    ctx.builder.call_fn2("f32_to_f80_jit");
    ctx.builder
        .load_fixed_i64(global_pointers::sse_scratch_register as u32);
    ctx.builder
        .load_fixed_u16(global_pointers::sse_scratch_register as u32 + 8);
}

pub fn gen_fpu_load_m64(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    ctx.builder
        .const_i32(global_pointers::sse_scratch_register as i32);
    gen_modrm_resolve_safe_read64(ctx, modrm_byte);
    ctx.builder.call_fn2_i32_i64("f64_to_f80_jit");
    ctx.builder
        .load_fixed_i64(global_pointers::sse_scratch_register as u32);
    ctx.builder
        .load_fixed_u16(global_pointers::sse_scratch_register as u32 + 8);
}

pub fn gen_fpu_load_i16(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    ctx.builder
        .const_i32(global_pointers::sse_scratch_register as i32);
    gen_modrm_resolve_safe_read16(ctx, modrm_byte);
    sign_extend_i16(ctx.builder);
    ctx.builder.call_fn2("i32_to_f80_jit");
    ctx.builder
        .load_fixed_i64(global_pointers::sse_scratch_register as u32);
    ctx.builder
        .load_fixed_u16(global_pointers::sse_scratch_register as u32 + 8);
}
pub fn gen_fpu_load_i32(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    ctx.builder
        .const_i32(global_pointers::sse_scratch_register as i32);
    gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    ctx.builder.call_fn2("i32_to_f80_jit");
    ctx.builder
        .load_fixed_i64(global_pointers::sse_scratch_register as u32);
    ctx.builder
        .load_fixed_u16(global_pointers::sse_scratch_register as u32 + 8);
}
pub fn gen_fpu_load_i64(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    ctx.builder
        .const_i32(global_pointers::sse_scratch_register as i32);
    gen_modrm_resolve_safe_read64(ctx, modrm_byte);
    ctx.builder.call_fn2_i32_i64("i64_to_f80_jit");
    ctx.builder
        .load_fixed_i64(global_pointers::sse_scratch_register as u32);
    ctx.builder
        .load_fixed_u16(global_pointers::sse_scratch_register as u32 + 8);
}

pub fn gen_trigger_de(ctx: &mut JitContext) {
    gen_fn1_const(
        ctx.builder,
        "trigger_de_jit",
        ctx.start_of_current_instruction & 0xFFF,
    );
    gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.br(ctx.exit_with_fault_label);
}

pub fn gen_trigger_ud(ctx: &mut JitContext) {
    gen_fn1_const(
        ctx.builder,
        "trigger_ud_jit",
        ctx.start_of_current_instruction & 0xFFF,
    );
    gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.br(ctx.exit_with_fault_label);
}

pub fn gen_trigger_gp(ctx: &mut JitContext, error_code: u32) {
    gen_fn2_const(
        ctx.builder,
        "trigger_gp_jit",
        error_code,
        ctx.start_of_current_instruction & 0xFFF,
    );
    gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.br(ctx.exit_with_fault_label);
}

pub fn gen_condition_fn_negated(ctx: &mut JitContext, condition: u8) {
    gen_condition_fn(ctx, condition ^ 1)
}

pub fn gen_condition_fn(ctx: &mut JitContext, condition: u8) {
    if condition & 0xF0 == 0x00 || condition & 0xF0 == 0x70 || condition & 0xF0 == 0x80 {
        match condition & 0xF {
            0x0 => {
                gen_getof(ctx);
            },
            0x1 => {
                gen_getof(ctx);
                ctx.builder.eqz_i32();
            },
            0x2 => {
                gen_getcf(ctx, ConditionNegate::False);
            },
            0x3 => {
                gen_getcf(ctx, ConditionNegate::True);
            },
            0x4 => {
                gen_getzf(ctx, ConditionNegate::False);
            },
            0x5 => {
                gen_getzf(ctx, ConditionNegate::True);
            },
            0x6 => {
                gen_test_be(ctx, ConditionNegate::False);
            },
            0x7 => {
                gen_test_be(ctx, ConditionNegate::True);
            },
            0x8 => {
                gen_getsf(ctx, ConditionNegate::False);
            },
            0x9 => {
                gen_getsf(ctx, ConditionNegate::True);
            },
            0xA => {
                gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_UNOPTIMISED);
                gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_UNOPTIMISED_PF);
                ctx.builder.call_fn0_ret("test_p");
            },
            0xB => {
                gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_UNOPTIMISED);
                gen_profiler_stat_increment(ctx.builder, profiler::stat::CONDITION_UNOPTIMISED_PF);
                ctx.builder.call_fn0_ret("test_np");
            },
            0xC => {
                gen_test_l(ctx, ConditionNegate::False);
            },
            0xD => {
                gen_test_l(ctx, ConditionNegate::True);
            },
            0xE => {
                gen_test_le(ctx, ConditionNegate::False);
            },
            0xF => {
                gen_test_le(ctx, ConditionNegate::True);
            },
            _ => {
                dbg_assert!(false);
            },
        }
    }
    else {
        // loop, loopnz, loopz, jcxz
        dbg_assert!(condition & !0x3 == 0xE0);
        if condition == 0xE0 {
            gen_test_loopnz(ctx, ctx.cpu.asize_32());
        }
        else if condition == 0xE1 {
            gen_test_loopz(ctx, ctx.cpu.asize_32());
        }
        else if condition == 0xE2 {
            gen_test_loop(ctx, ctx.cpu.asize_32());
        }
        else if condition == 0xE3 {
            gen_test_jcxz(ctx, ctx.cpu.asize_32());
        }
    }
}

pub fn gen_move_registers_from_locals_to_memory(ctx: &mut JitContext) {
    if cfg!(feature = "profiler") {
        let instruction = memory::read32s(ctx.start_of_current_instruction) as u32;
        opstats::gen_opstat_unguarded_register(ctx.builder, instruction);
    }

    for i in 0..8 {
        ctx.builder
            .const_i32(global_pointers::get_reg32_offset(i as u32) as i32);
        ctx.builder.get_local(&ctx.register_locals[i]);
        ctx.builder.store_aligned_i32(0);
    }
}
pub fn gen_move_registers_from_memory_to_locals(ctx: &mut JitContext) {
    if cfg!(feature = "profiler") {
        let instruction = memory::read32s(ctx.start_of_current_instruction) as u32;
        opstats::gen_opstat_unguarded_register(ctx.builder, instruction);
    }

    for i in 0..8 {
        ctx.builder
            .const_i32(global_pointers::get_reg32_offset(i as u32) as i32);
        ctx.builder.load_aligned_i32(0);
        ctx.builder.set_local(&ctx.register_locals[i]);
    }
}

pub fn gen_profiler_stat_increment(builder: &mut WasmBuilder, stat: profiler::stat) {
    if !cfg!(feature = "profiler") {
        return;
    }
    let addr = unsafe { &raw mut profiler::stat_array[stat as usize] } as u32;
    builder.increment_fixed_i64(addr, 1)
}

pub fn gen_debug_track_jit_exit(builder: &mut WasmBuilder, address: u32) {
    if cfg!(feature = "profiler") {
        gen_fn1_const(builder, "track_jit_exit", address);
    }
}
