use cpu2::cpu::{
    FLAG_CARRY, FLAG_OVERFLOW, FLAG_SIGN, FLAG_ZERO, TLB_GLOBAL, TLB_HAS_CODE, TLB_NO_USER,
    TLB_READONLY, TLB_VALID,
};
use cpu2::imports::mem8;
use cpu2::memory;
use global_pointers;
use jit::JitContext;
use modrm;
use profiler;
use regs;
use wasmgen::wasm_builder::{WasmBuilder, WasmLocal, WasmLocalI64};

pub fn gen_add_cs_offset(ctx: &mut JitContext) {
    ctx.builder
        .load_fixed_i32(global_pointers::get_seg_offset(regs::CS));
    ctx.builder.add_i32();
}

fn gen_get_eip(builder: &mut WasmBuilder) {
    builder.load_fixed_i32(global_pointers::INSTRUCTION_POINTER);
}

pub fn gen_set_previous_eip_offset_from_eip(builder: &mut WasmBuilder, n: u32) {
    // previous_ip = instruction_pointer + n
    builder.const_i32(global_pointers::PREVIOUS_IP as i32);
    gen_get_eip(builder);
    if n != 0 {
        builder.const_i32(n as i32);
        builder.add_i32();
    }
    builder.store_aligned_i32(0);
}

pub fn gen_set_eip_to_after_current_instruction(ctx: &mut JitContext) {
    ctx.builder
        .const_i32(global_pointers::INSTRUCTION_POINTER as i32);
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
    builder.const_i32(global_pointers::PREVIOUS_IP as i32);
    gen_get_eip(builder);
    builder.const_i32(!0xFFF);
    builder.and_i32();
    builder.const_i32(low_bits);
    builder.or_i32();
    builder.store_aligned_i32(0);
}

pub fn gen_increment_instruction_pointer(builder: &mut WasmBuilder, n: u32) {
    builder.const_i32(global_pointers::INSTRUCTION_POINTER as i32);
    gen_get_eip(builder);
    builder.const_i32(n as i32);
    builder.add_i32();
    builder.store_aligned_i32(0);
}

pub fn gen_relative_jump(builder: &mut WasmBuilder, n: i32) {
    // add n to instruction_pointer (without setting the offset as above)
    builder.const_i32(global_pointers::INSTRUCTION_POINTER as i32);
    gen_get_eip(builder);
    builder.const_i32(n);
    builder.add_i32();
    builder.store_aligned_i32(0);
}

pub fn gen_absolute_indirect_jump(ctx: &mut JitContext, new_eip: WasmLocal) {
    ctx.builder
        .const_i32(global_pointers::INSTRUCTION_POINTER as i32);
    ctx.builder.get_local(&new_eip);
    ctx.builder.store_aligned_i32(0);

    ctx.builder.get_local(&new_eip);
    ctx.builder.load_fixed_i32(global_pointers::PREVIOUS_IP);
    ctx.builder.xor_i32();
    ctx.builder.const_i32(!0xFFF);
    ctx.builder.and_i32();
    ctx.builder.eqz_i32();
    ctx.builder.if_void();
    {
        // try staying in same page
        ctx.builder.get_local(&new_eip);
        ctx.builder.free_local(new_eip);
        ctx.builder
            .const_i32(ctx.start_of_current_instruction as i32);
        ctx.builder.const_i32(ctx.our_wasm_table_index as i32);
        ctx.builder.const_i32(ctx.state_flags.to_u32() as i32);
        ctx.builder.call_fn4_ret("jit_find_cache_entry_in_page");
        let new_basic_block_index = ctx.builder.tee_new_local();
        ctx.builder.const_i32(0);
        ctx.builder.ge_i32();
        ctx.builder.if_void();
        ctx.builder.get_local(&new_basic_block_index);
        ctx.builder.set_local(ctx.basic_block_index_local);
        ctx.builder.br(ctx.current_brtable_depth + 2); // to the loop
        ctx.builder.block_end();
        ctx.builder.free_local(new_basic_block_index);
    }
    ctx.builder.block_end();
}

pub fn gen_increment_timestamp_counter(builder: &mut WasmBuilder, n: i32) {
    builder.increment_fixed_i32(global_pointers::TIMESTAMP_COUNTER, n)
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

pub fn gen_set_reg16(ctx: &mut JitContext, r: u32) {
    gen_set_reg16_local(ctx.builder, &ctx.register_locals[r as usize]);
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

pub fn gen_get_sreg(ctx: &mut JitContext, r: u32) {
    ctx.builder
        .load_fixed_u16(global_pointers::get_sreg_offset(r))
}

pub fn gen_get_ss_offset(ctx: &mut JitContext) {
    ctx.builder
        .load_fixed_i32(global_pointers::get_seg_offset(regs::SS));
}

pub fn gen_get_flags(builder: &mut WasmBuilder) { builder.load_fixed_i32(global_pointers::FLAGS); }
pub fn gen_get_flags_changed(builder: &mut WasmBuilder) {
    builder.load_fixed_i32(global_pointers::FLAGS_CHANGED);
}
pub fn gen_get_last_result(builder: &mut WasmBuilder) {
    builder.load_fixed_i32(global_pointers::LAST_RESULT);
}
pub fn gen_get_last_op_size(builder: &mut WasmBuilder) {
    builder.load_fixed_i32(global_pointers::LAST_OP_SIZE);
}
pub fn gen_get_last_op1(builder: &mut WasmBuilder) {
    builder.load_fixed_i32(global_pointers::LAST_OP1);
}

pub fn gen_get_page_fault(builder: &mut WasmBuilder) {
    builder.load_fixed_u8(global_pointers::PAGE_FAULT);
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
pub fn gen_fn3_const(builder: &mut WasmBuilder, name: &str, arg0: u32, arg1: u32, arg2: u32) {
    builder.const_i32(arg0 as i32);
    builder.const_i32(arg1 as i32);
    builder.const_i32(arg2 as i32);
    builder.call_fn3(name);
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
pub fn gen_modrm_fn2(builder: &mut WasmBuilder, name: &str, arg0: u32, arg1: u32) {
    // generates: fn( _, arg0, arg1 )
    builder.const_i32(arg0 as i32);
    builder.const_i32(arg1 as i32);
    builder.call_fn3(name);
}

pub fn gen_modrm_resolve(ctx: &mut JitContext, modrm_byte: u8) { modrm::gen(ctx, modrm_byte) }

pub fn gen_set_reg8_r(ctx: &mut JitContext, dest: u32, src: u32) {
    // generates: reg8[r_dest] = reg8[r_src]
    gen_get_reg8(ctx, src);
    gen_set_reg8(ctx, dest);
}
pub fn gen_set_reg16_r(ctx: &mut JitContext, dest: u32, src: u32) {
    // generates: reg16[r_dest] = reg16[r_src]
    gen_get_reg16(ctx, src);
    gen_set_reg16(ctx, dest);
}
pub fn gen_set_reg32_r(ctx: &mut JitContext, dest: u32, src: u32) {
    // generates: reg32[r_dest] = reg32[r_src]
    gen_get_reg32(ctx, src);
    gen_set_reg32(ctx, dest);
}

pub fn gen_modrm_resolve_safe_read8(ctx: &mut JitContext, modrm_byte: u8) {
    gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    gen_safe_read8(ctx, &address_local);
    ctx.builder.free_local(address_local);
}
pub fn gen_modrm_resolve_safe_read16(ctx: &mut JitContext, modrm_byte: u8) {
    gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    gen_safe_read16(ctx, &address_local);
    ctx.builder.free_local(address_local);
}
pub fn gen_modrm_resolve_safe_read32(ctx: &mut JitContext, modrm_byte: u8) {
    gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    gen_safe_read32(ctx, &address_local);
    ctx.builder.free_local(address_local);
}
pub fn gen_modrm_resolve_safe_read64(ctx: &mut JitContext, modrm_byte: u8) {
    gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    gen_safe_read64(ctx, &address_local);
    ctx.builder.free_local(address_local);
}
pub fn gen_modrm_resolve_safe_read128(ctx: &mut JitContext, modrm_byte: u8, where_to_write: u32) {
    gen_modrm_resolve(ctx, modrm_byte);
    let address_local = ctx.builder.set_new_local();
    gen_safe_read128(ctx, &address_local, where_to_write);
    ctx.builder.free_local(address_local);
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

    ctx.builder.block_void();
    ctx.builder.get_local(&address_local);

    ctx.builder.const_i32(12);
    ctx.builder.shr_u_i32();
    ctx.builder.const_i32(2);
    ctx.builder.shl_i32();

    ctx.builder.load_aligned_i32(global_pointers::TLB_DATA);
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

    ctx.builder.br_if(0);

    if cfg!(feature = "profiler") && cfg!(feature = "profiler_instrument") {
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

    if cfg!(feature = "profiler") && cfg!(feature = "profiler_instrument") {
        ctx.builder.if_void();
        gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
        ctx.builder.block_end();

        ctx.builder.get_local(&entry_local);
        ctx.builder.const_i32(1);
        ctx.builder.and_i32();
    }

    // -2 for the exit-with-pagefault block, +1 for leaving the nested if from this function
    ctx.builder.br_if(ctx.current_brtable_depth - 2 + 1);

    ctx.builder.block_end();

    gen_profiler_stat_increment(ctx.builder, profiler::stat::SAFE_READ_FAST); // XXX: Both fast and slow

    ctx.builder.get_local(&entry_local);
    ctx.builder.const_i32(!0xFFF);
    ctx.builder.and_i32();
    ctx.builder.get_local(&address_local);
    ctx.builder.xor_i32();

    // where_to_write is only used by dqword
    dbg_assert!((where_to_write != None) == (bits == BitSize::DQWORD));

    ctx.builder.const_i32(unsafe { mem8 } as i32);
    ctx.builder.add_i32();

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

    ctx.builder.block_void();
    ctx.builder.get_local(&address_local);

    ctx.builder.const_i32(12);
    ctx.builder.shr_u_i32();
    ctx.builder.const_i32(2);
    ctx.builder.shl_i32();

    ctx.builder.load_aligned_i32(global_pointers::TLB_DATA);
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

    ctx.builder.br_if(0);

    if cfg!(feature = "profiler") && cfg!(feature = "profiler_instrument") {
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

    if cfg!(feature = "profiler") && cfg!(feature = "profiler_instrument") {
        ctx.builder.if_void();
        gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
        ctx.builder.block_end();

        ctx.builder.get_local(&entry_local);
        ctx.builder.const_i32(1);
        ctx.builder.and_i32();
    }

    // -2 for the exit-with-pagefault block, +1 for leaving the nested if from this function
    ctx.builder.br_if(ctx.current_brtable_depth - 2 + 1);

    ctx.builder.block_end();

    gen_profiler_stat_increment(ctx.builder, profiler::stat::SAFE_WRITE_FAST); // XXX: Both fast and slow

    ctx.builder.get_local(&entry_local);
    ctx.builder.const_i32(!0xFFF);
    ctx.builder.and_i32();
    ctx.builder.get_local(&address_local);
    ctx.builder.xor_i32();

    ctx.builder.const_i32(unsafe { mem8 } as i32);
    ctx.builder.add_i32();

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

    ctx.builder.block_void();
    ctx.builder.get_local(address_local);

    ctx.builder.const_i32(12);
    ctx.builder.shr_u_i32();
    ctx.builder.const_i32(2);
    ctx.builder.shl_i32();

    ctx.builder.load_aligned_i32(global_pointers::TLB_DATA);
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

    ctx.builder.br_if(0);

    if cfg!(feature = "profiler") && cfg!(feature = "profiler_instrument") {
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
        BitSize::QWORD => dbg_assert!(false),
        BitSize::DQWORD => dbg_assert!(false),
    }
    ctx.builder.tee_local(&entry_local);
    ctx.builder.const_i32(1);
    ctx.builder.and_i32();

    if cfg!(feature = "profiler") && cfg!(feature = "profiler_instrument") {
        ctx.builder.if_void();
        gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
        ctx.builder.block_end();

        ctx.builder.get_local(&entry_local);
        ctx.builder.const_i32(1);
        ctx.builder.and_i32();
    }

    // -2 for the exit-with-pagefault block, +1 for leaving the two nested ifs from this function
    ctx.builder.br_if(ctx.current_brtable_depth - 2 + 1);

    ctx.builder.block_end();

    gen_profiler_stat_increment(ctx.builder, profiler::stat::SAFE_READ_WRITE_FAST); // XXX: Also slow

    ctx.builder.get_local(&entry_local);
    ctx.builder.const_i32(!0xFFF);
    ctx.builder.and_i32();
    ctx.builder.get_local(&address_local);
    ctx.builder.xor_i32();

    ctx.builder.const_i32(unsafe { mem8 } as i32);
    ctx.builder.add_i32();

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
        BitSize::QWORD => assert!(false),  // not used
        BitSize::DQWORD => assert!(false), // not used
    }

    // value is now on stack

    f(ctx);
    let value_local = ctx.builder.set_new_local(); // TODO: Could get rid of this local by returning one from f

    ctx.builder.get_local(&can_use_fast_path_local);

    ctx.builder.eqz_i32();
    ctx.builder.if_void();
    {
        ctx.builder.get_local(&address_local);
        ctx.builder.get_local(&value_local);

        ctx.builder
            .const_i32(ctx.start_of_current_instruction as i32);

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
            BitSize::QWORD => dbg_assert!(false),
            BitSize::DQWORD => dbg_assert!(false),
        }

        ctx.builder.const_i32(1);
        ctx.builder.and_i32();

        ctx.builder.if_void();
        {
            // handled above
            if cfg!(debug_assertions) {
                ctx.builder.const_i32(match bits {
                    BitSize::BYTE => 8,
                    BitSize::WORD => 16,
                    BitSize::DWORD => 32,
                    _ => {
                        dbg_assert!(false);
                        0
                    },
                });
                ctx.builder.get_local(&address_local);
                ctx.builder.call_fn2("bug_gen_safe_read_write_page_fault");
            }
            else {
                ctx.builder.unreachable();
            }
        }
        ctx.builder.block_end();
    }
    ctx.builder.block_end();

    ctx.builder.get_local(&phys_addr_local);
    ctx.builder.get_local(&value_local);

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
        BitSize::QWORD => dbg_assert!(false),
        BitSize::DQWORD => dbg_assert!(false),
    }

    ctx.builder.free_local(value_local);
    ctx.builder.free_local(can_use_fast_path_local);
    ctx.builder.free_local(phys_addr_local);
}

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
        builder.const_i32(global_pointers::INSTRUCTION_POINTER as i32);

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
    // generate if(cr[0] & (CR0_EM | CR0_TS)) { task_switch_test_void(); return; }
    let cr0_offset = global_pointers::get_creg_offset(0);

    dbg_assert!(regs::CR0_EM | regs::CR0_TS <= 0xFF);
    ctx.builder.load_fixed_u8(cr0_offset);
    ctx.builder.const_i32((regs::CR0_EM | regs::CR0_TS) as i32);
    ctx.builder.and_i32();

    ctx.builder.if_void();

    gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);

    gen_set_previous_eip_offset_from_eip_with_low_bits(
        ctx.builder,
        ctx.start_of_current_instruction as i32 & 0xFFF,
    );

    gen_move_registers_from_locals_to_memory(ctx);
    gen_fn0_const(ctx.builder, "task_switch_test_jit");

    ctx.builder.return_();

    ctx.builder.block_end();
}

pub fn gen_task_switch_test_mmx(ctx: &mut JitContext) {
    // generate if(cr[0] & (CR0_EM | CR0_TS)) { task_switch_test_mmx_void(); return; }
    let cr0_offset = global_pointers::get_creg_offset(0);

    dbg_assert!(regs::CR0_EM | regs::CR0_TS <= 0xFF);
    ctx.builder.load_fixed_u8(cr0_offset);
    ctx.builder.const_i32((regs::CR0_EM | regs::CR0_TS) as i32);
    ctx.builder.and_i32();

    ctx.builder.if_void();

    gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);

    gen_set_previous_eip_offset_from_eip_with_low_bits(
        ctx.builder,
        ctx.start_of_current_instruction as i32 & 0xFFF,
    );

    gen_move_registers_from_locals_to_memory(ctx);
    gen_fn0_const(ctx.builder, "task_switch_test_mmx_jit");

    ctx.builder.return_();

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

pub fn gen_get_real_eip(ctx: &mut JitContext) {
    gen_get_eip(ctx.builder);
    ctx.builder
        .load_fixed_i32(global_pointers::get_seg_offset(regs::CS));
    ctx.builder.sub_i32();
}

pub fn gen_set_last_op1(builder: &mut WasmBuilder, source: &WasmLocal) {
    builder.const_i32(global_pointers::LAST_OP1 as i32);
    builder.get_local(&source);
    builder.store_aligned_i32(0);
}

pub fn gen_set_last_result(builder: &mut WasmBuilder, source: &WasmLocal) {
    builder.const_i32(global_pointers::LAST_RESULT as i32);
    builder.get_local(&source);
    builder.store_aligned_i32(0);
}

pub fn gen_set_last_op_size(builder: &mut WasmBuilder, value: i32) {
    builder.const_i32(global_pointers::LAST_OP_SIZE as i32);
    builder.const_i32(value);
    builder.store_aligned_i32(0);
}

pub fn gen_set_flags_changed(builder: &mut WasmBuilder, value: i32) {
    builder.const_i32(global_pointers::FLAGS_CHANGED as i32);
    builder.const_i32(value);
    builder.store_aligned_i32(0);
}

pub fn gen_set_flags_bits(builder: &mut WasmBuilder, bits_to_set: i32) {
    builder.const_i32(global_pointers::FLAGS as i32);
    gen_get_flags(builder);
    builder.const_i32(bits_to_set);
    builder.or_i32();
    builder.store_aligned_i32(0);
}

pub fn gen_clear_flags_bits(builder: &mut WasmBuilder, bits_to_clear: i32) {
    builder.const_i32(global_pointers::FLAGS as i32);
    gen_get_flags(builder);
    builder.const_i32(!bits_to_clear);
    builder.and_i32();
    builder.store_aligned_i32(0);
}

pub fn gen_getzf(builder: &mut WasmBuilder) {
    gen_get_flags_changed(builder);
    builder.const_i32(FLAG_ZERO);
    builder.and_i32();
    builder.if_i32();

    gen_get_last_result(builder);
    let last_result = builder.tee_new_local();
    builder.const_i32(-1);
    builder.xor_i32();
    builder.get_local(&last_result);
    builder.free_local(last_result);
    builder.const_i32(1);
    builder.sub_i32();
    builder.and_i32();
    gen_get_last_op_size(builder);
    builder.shr_u_i32();
    builder.const_i32(1);
    builder.and_i32();

    builder.else_();
    gen_get_flags(builder);
    builder.const_i32(FLAG_ZERO);
    builder.and_i32();
    builder.block_end();
}

pub fn gen_getcf(builder: &mut WasmBuilder) {
    gen_get_flags_changed(builder);
    let flags_changed = builder.tee_new_local();
    builder.const_i32(FLAG_CARRY);
    builder.and_i32();
    builder.if_i32();

    builder.get_local(&flags_changed);
    builder.const_i32(31);
    builder.shr_s_i32();
    builder.free_local(flags_changed);
    let sub_mask = builder.set_new_local();

    gen_get_last_result(builder);
    builder.get_local(&sub_mask);
    builder.xor_i32();

    gen_get_last_op1(builder);
    builder.get_local(&sub_mask);
    builder.xor_i32();

    builder.ltu_i32();

    builder.else_();
    gen_get_flags(builder);
    builder.const_i32(FLAG_CARRY);
    builder.and_i32();
    builder.block_end();

    builder.free_local(sub_mask);
}

pub fn gen_getsf(builder: &mut WasmBuilder) {
    gen_get_flags_changed(builder);
    builder.const_i32(FLAG_SIGN);
    builder.and_i32();
    builder.if_i32();
    {
        gen_get_last_result(builder);
        gen_get_last_op_size(builder);
        builder.shr_u_i32();
        builder.const_i32(1);
        builder.and_i32();
    }
    builder.else_();
    {
        gen_get_flags(builder);
        builder.const_i32(FLAG_SIGN);
        builder.and_i32();
    }
    builder.block_end();
}

pub fn gen_getof(builder: &mut WasmBuilder) {
    gen_get_flags_changed(builder);
    let flags_changed = builder.tee_new_local();
    builder.const_i32(FLAG_OVERFLOW);
    builder.and_i32();
    builder.if_i32();
    {
        gen_get_last_op1(builder);
        let last_op1 = builder.tee_new_local();
        gen_get_last_result(builder);
        let last_result = builder.tee_new_local();
        builder.xor_i32();

        builder.get_local(&last_result);
        builder.get_local(&last_op1);
        builder.sub_i32();
        gen_get_flags_changed(builder);
        builder.const_i32(31);
        builder.shr_u_i32();
        builder.sub_i32();

        builder.get_local(&last_result);
        builder.xor_i32();

        builder.and_i32();

        gen_get_last_op_size(builder);
        builder.shr_u_i32();
        builder.const_i32(1);
        builder.and_i32();

        builder.free_local(last_op1);
        builder.free_local(last_result);
    }
    builder.else_();
    {
        gen_get_flags(builder);
        builder.const_i32(FLAG_OVERFLOW);
        builder.and_i32();
    }
    builder.block_end();
    builder.free_local(flags_changed);
}

pub fn gen_test_be(builder: &mut WasmBuilder) {
    // TODO: A more efficient implementation is possible
    gen_getcf(builder);
    gen_getzf(builder);
    builder.or_i32();
}

pub fn gen_test_l(builder: &mut WasmBuilder) {
    // TODO: A more efficient implementation is possible
    gen_getsf(builder);
    builder.eqz_i32();
    gen_getof(builder);
    builder.eqz_i32();
    builder.xor_i32();
}

pub fn gen_test_le(builder: &mut WasmBuilder) {
    // TODO: A more efficient implementation is possible
    gen_test_l(builder);
    gen_getzf(builder);
    builder.or_i32();
}

pub fn gen_test_loopnz(ctx: &mut JitContext, is_asize_32: bool) {
    gen_test_loop(ctx, is_asize_32);
    ctx.builder.eqz_i32();
    gen_getzf(&mut ctx.builder);
    ctx.builder.or_i32();
    ctx.builder.eqz_i32();
}
pub fn gen_test_loopz(ctx: &mut JitContext, is_asize_32: bool) {
    gen_test_loop(ctx, is_asize_32);
    ctx.builder.eqz_i32();
    gen_getzf(&mut ctx.builder);
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
    ctx.builder.const_i32(i as i32);
    ctx.builder.call_fn1_ret_f64("fpu_get_sti");
}

pub fn gen_fpu_load_m32(ctx: &mut JitContext, modrm_byte: u8) {
    gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    ctx.builder.reinterpret_i32_as_f32();
    ctx.builder.promote_f32_to_f64();
}

pub fn gen_fpu_load_m64(ctx: &mut JitContext, modrm_byte: u8) {
    gen_modrm_resolve_safe_read64(ctx, modrm_byte);
    ctx.builder.reinterpret_i64_as_f64();
}

pub fn gen_trigger_de(ctx: &mut JitContext) {
    gen_move_registers_from_locals_to_memory(ctx);
    gen_set_previous_eip_offset_from_eip_with_low_bits(
        ctx.builder,
        ctx.start_of_current_instruction as i32 & 0xFFF,
    );
    gen_fn0_const(ctx.builder, "trigger_de");
    gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.return_();
}

pub fn gen_trigger_ud(ctx: &mut JitContext) {
    gen_move_registers_from_locals_to_memory(ctx);
    gen_set_previous_eip_offset_from_eip_with_low_bits(
        ctx.builder,
        ctx.start_of_current_instruction as i32 & 0xFFF,
    );
    gen_fn0_const(ctx.builder, "trigger_ud");
    gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.return_();
}

pub fn gen_trigger_gp(ctx: &mut JitContext, error_code: u32) {
    gen_move_registers_from_locals_to_memory(ctx);
    gen_set_previous_eip_offset_from_eip_with_low_bits(
        ctx.builder,
        ctx.start_of_current_instruction as i32 & 0xFFF,
    );
    gen_fn1_const(ctx.builder, "trigger_gp", error_code);
    gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.return_();
}

pub fn gen_condition_fn(ctx: &mut JitContext, condition: u8) {
    if condition & 0xF0 == 0x00 || condition & 0xF0 == 0x70 || condition & 0xF0 == 0x80 {
        match condition & 0xF {
            0x0 => {
                gen_getof(ctx.builder);
            },
            0x1 => {
                gen_getof(ctx.builder);
                ctx.builder.eqz_i32();
            },
            0x2 => {
                gen_getcf(ctx.builder);
            },
            0x3 => {
                gen_getcf(ctx.builder);
                ctx.builder.eqz_i32();
            },
            0x4 => {
                gen_getzf(ctx.builder);
            },
            0x5 => {
                gen_getzf(ctx.builder);
                ctx.builder.eqz_i32();
            },
            0x6 => {
                gen_test_be(ctx.builder);
            },
            0x7 => {
                gen_test_be(ctx.builder);
                ctx.builder.eqz_i32();
            },
            0x8 => {
                gen_getsf(ctx.builder);
            },
            0x9 => {
                gen_getsf(ctx.builder);
                ctx.builder.eqz_i32();
            },
            0xA => ctx.builder.call_fn0_ret("test_p"),
            0xB => ctx.builder.call_fn0_ret("test_np"),
            0xC => {
                gen_test_l(ctx.builder);
            },
            0xD => {
                gen_test_l(ctx.builder);
                ctx.builder.eqz_i32();
            },
            0xE => {
                gen_test_le(ctx.builder);
            },
            0xF => {
                gen_test_le(ctx.builder);
                ctx.builder.eqz_i32();
            },
            _ => dbg_assert!(false),
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

const RECORD_LOCAL_MEMORY_MOVES_AT_COMPILE_TIME: bool = false;

pub fn gen_move_registers_from_locals_to_memory(ctx: &mut JitContext) {
    let instruction = memory::read32s(ctx.start_of_current_instruction) as u32;
    if RECORD_LOCAL_MEMORY_MOVES_AT_COMPILE_TIME {
        ::opstats::record_opstat_unguarded_register(instruction);
    }
    else {
        ::opstats::gen_opstat_unguarded_register(ctx.builder, instruction);
    }

    for i in 0..8 {
        ctx.builder
            .const_i32(global_pointers::get_reg32_offset(i as u32) as i32);
        ctx.builder.get_local(&ctx.register_locals[i]);
        ctx.builder.store_aligned_i32(0);
    }
}
pub fn gen_move_registers_from_memory_to_locals(ctx: &mut JitContext) {
    let instruction = memory::read32s(ctx.start_of_current_instruction) as u32;
    if RECORD_LOCAL_MEMORY_MOVES_AT_COMPILE_TIME {
        ::opstats::record_opstat_unguarded_register(instruction);
    }
    else {
        ::opstats::gen_opstat_unguarded_register(ctx.builder, instruction);
    }

    for i in 0..8 {
        ctx.builder
            .const_i32(global_pointers::get_reg32_offset(i as u32) as i32);
        ctx.builder.load_aligned_i32(0);
        ctx.builder.set_local(&ctx.register_locals[i]);
    }
}

pub fn gen_profiler_stat_increment(builder: &mut WasmBuilder, stat: profiler::stat) {
    if !cfg!(feature = "profiler") || !cfg!(feature = "profiler_instrument") {
        return;
    }
    let addr = unsafe { profiler::stat_array.as_mut_ptr().offset(stat as isize) } as u32;
    builder.increment_fixed_i32(addr, 1)
}

pub fn gen_debug_track_jit_exit(builder: &mut WasmBuilder, address: u32) {
    if cfg!(feature = "profiler") && cfg!(feature = "profiler_instrument") {
        gen_fn1_const(builder, "track_jit_exit", address);
    }
}
