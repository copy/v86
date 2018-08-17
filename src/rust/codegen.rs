use cpu::{BitSize, ImmVal};
use global_pointers;
use jit::JitContext;
use modrm;
use regs;
use tlb::{TLB_GLOBAL, TLB_NO_USER, TLB_READONLY, TLB_VALID};
use wasmgen::module_init;
use wasmgen::module_init::{WasmBuilder, WasmLocal};
use wasmgen::wasm_util::WasmBuf;

pub fn gen_set_previous_eip_offset_from_eip(builder: &mut WasmBuilder, n: u32) {
    let cs = &mut builder.code_section;
    cs.push_i32(global_pointers::PREVIOUS_IP as i32); // store address of previous ip
    cs.load_aligned_i32(global_pointers::INSTRUCTION_POINTER); // load ip
    if n != 0 {
        cs.push_i32(n as i32);
        cs.add_i32(); // add constant to ip value
    }
    cs.store_aligned_i32(); // store it as previous ip
}

pub fn gen_increment_instruction_pointer(builder: &mut WasmBuilder, n: u32) {
    let cs = &mut builder.code_section;
    cs.push_i32(global_pointers::INSTRUCTION_POINTER as i32); // store address of ip

    cs.load_aligned_i32(global_pointers::INSTRUCTION_POINTER); // load ip

    cs.push_i32(n as i32);

    cs.add_i32();
    cs.store_aligned_i32(); // store it back in
}

pub fn gen_set_previous_eip(builder: &mut WasmBuilder) {
    let cs = &mut builder.code_section;
    cs.push_i32(global_pointers::PREVIOUS_IP as i32); // store address of previous ip
    cs.load_aligned_i32(global_pointers::INSTRUCTION_POINTER); // load ip
    cs.store_aligned_i32(); // store it as previous ip
}

pub fn gen_relative_jump(builder: &mut WasmBuilder, n: i32) {
    // add n to instruction_pointer (without setting the offset as above)
    let instruction_body = &mut builder.instruction_body;
    instruction_body.push_i32(global_pointers::INSTRUCTION_POINTER as i32);
    instruction_body.load_aligned_i32(global_pointers::INSTRUCTION_POINTER);
    instruction_body.push_i32(n);
    instruction_body.add_i32();
    instruction_body.store_aligned_i32();
}

pub fn gen_increment_variable(builder: &mut WasmBuilder, variable_address: u32, n: i32) {
    builder.code_section.increment_variable(variable_address, n);
}

pub fn gen_increment_timestamp_counter(builder: &mut WasmBuilder, n: i32) {
    gen_increment_variable(builder, global_pointers::TIMESTAMP_COUNTER, n);
}

pub fn gen_increment_mem32(builder: &mut WasmBuilder, addr: u32) {
    builder.code_section.increment_mem32(addr)
}

pub fn gen_fn0_const(ctx: &mut JitContext, name: &str) {
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN0_TYPE_INDEX);
    builder.instruction_body.call_fn(fn_idx);
}

pub fn gen_fn0_const_ret(builder: &mut WasmBuilder, name: &str) {
    let fn_idx = builder.get_fn_idx(name, module_init::FN0_RET_TYPE_INDEX);
    builder.instruction_body.call_fn(fn_idx);
}

pub fn gen_fn1_const(ctx: &mut JitContext, name: &str, arg0: u32) {
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN1_TYPE_INDEX);
    builder.instruction_body.push_i32(arg0 as i32);
    builder.instruction_body.call_fn(fn_idx);
}

pub fn gen_call_fn1_ret(builder: &mut WasmBuilder, name: &str) {
    // generates: fn( _ ) where _ must be left on the stack before calling this, and fn returns a value
    let fn_idx = builder.get_fn_idx(name, module_init::FN1_RET_TYPE_INDEX);
    builder.instruction_body.call_fn(fn_idx);
}

pub fn gen_fn2_const(ctx: &mut JitContext, name: &str, arg0: u32, arg1: u32) {
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN2_TYPE_INDEX);
    builder.instruction_body.push_i32(arg0 as i32);
    builder.instruction_body.push_i32(arg1 as i32);
    builder.instruction_body.call_fn(fn_idx);
}

pub fn gen_call_fn2(builder: &mut WasmBuilder, name: &str) {
    // generates: fn( _, _ ) where _ must be left on the stack before calling this
    let fn_idx = builder.get_fn_idx(name, module_init::FN2_TYPE_INDEX);
    builder.instruction_body.call_fn(fn_idx);
}

pub fn gen_fn3_const(ctx: &mut JitContext, name: &str, arg0: u32, arg1: u32, arg2: u32) {
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN3_TYPE_INDEX);
    builder.instruction_body.push_i32(arg0 as i32);
    builder.instruction_body.push_i32(arg1 as i32);
    builder.instruction_body.push_i32(arg2 as i32);
    builder.instruction_body.call_fn(fn_idx);
}

pub fn gen_modrm_fn0(ctx: &mut JitContext, name: &str) {
    // generates: fn( _ )
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN1_TYPE_INDEX);
    builder.instruction_body.call_fn(fn_idx);
}

pub fn gen_modrm_fn1(ctx: &mut JitContext, name: &str, arg0: u32) {
    // generates: fn( _, arg0 )
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN2_TYPE_INDEX);
    builder.instruction_body.push_i32(arg0 as i32);
    builder.instruction_body.call_fn(fn_idx);
}

pub fn gen_modrm_fn2(ctx: &mut JitContext, name: &str, arg0: u32, arg1: u32) {
    // generates: fn( _, arg0, arg1 )
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN3_TYPE_INDEX);
    builder.instruction_body.push_i32(arg0 as i32);
    builder.instruction_body.push_i32(arg1 as i32);
    builder.instruction_body.call_fn(fn_idx);
}

pub fn gen_modrm_resolve(ctx: &mut JitContext, modrm_byte: u8) { modrm::gen(ctx, modrm_byte) }

pub fn gen_set_reg16_r(ctx: &mut JitContext, dest: u32, src: u32) {
    // generates: reg16[r_dest] = reg16[r_src]
    let builder = &mut ctx.builder;
    builder
        .instruction_body
        .push_i32(global_pointers::get_reg16_offset(dest) as i32);
    builder
        .instruction_body
        .load_aligned_u16(global_pointers::get_reg16_offset(src));
    builder.instruction_body.store_aligned_u16();
}
pub fn gen_set_reg32_r(ctx: &mut JitContext, dest: u32, src: u32) {
    // generates: reg32s[r_dest] = reg32s[r_src]
    let builder = &mut ctx.builder;
    builder
        .instruction_body
        .push_i32(global_pointers::get_reg32_offset(dest) as i32);
    builder
        .instruction_body
        .load_aligned_i32(global_pointers::get_reg32_offset(src));
    builder.instruction_body.store_aligned_i32();
}

pub fn gen_set_reg16_fn0(ctx: &mut JitContext, name: &str, reg: u32) {
    // generates: reg16[reg] = fn()
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN0_RET_TYPE_INDEX);
    builder
        .instruction_body
        .push_i32(global_pointers::get_reg16_offset(reg) as i32);
    builder.instruction_body.call_fn(fn_idx);
    builder.instruction_body.store_aligned_u16();
}

pub fn gen_set_reg32s_fn0(ctx: &mut JitContext, name: &str, reg: u32) {
    // generates: reg32s[reg] = fn()
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN0_RET_TYPE_INDEX);
    builder
        .instruction_body
        .push_i32(global_pointers::get_reg32_offset(reg) as i32);
    builder.instruction_body.call_fn(fn_idx);
    builder.instruction_body.store_aligned_i32();
}

pub fn gen_safe_read16(ctx: &mut JitContext) { gen_safe_read(ctx, BitSize::WORD) }
pub fn gen_safe_read32(ctx: &mut JitContext) { gen_safe_read(ctx, BitSize::DWORD) }

pub fn gen_safe_write16(ctx: &mut JitContext, address_local: &WasmLocal, value_local: &WasmLocal) {
    gen_safe_write(ctx, BitSize::WORD, address_local, value_local)
}
pub fn gen_safe_write32(ctx: &mut JitContext, address_local: &WasmLocal, value_local: &WasmLocal) {
    gen_safe_write(ctx, BitSize::DWORD, address_local, value_local)
}

fn gen_safe_read(ctx: &mut JitContext, bits: BitSize) {
    // Assumes virtual address has been pushed to the stack, and generates safe_readXX's fast-path
    // inline, bailing to safe_readXX_slow if necessary
    let builder = &mut ctx.builder;

    let address_local = builder.tee_new_local();

    // Pseudo: base_on_stack = (uint32_t)address >> 12;
    builder.instruction_body.push_i32(12);
    builder.instruction_body.shr_u32();

    // scale index
    builder.instruction_body.push_i32(2);
    builder.instruction_body.shl_i32();

    // Pseudo: entry = tlb_data[base_on_stack];
    builder
        .instruction_body
        .load_aligned_i32_from_stack(global_pointers::TLB_DATA);
    let entry_local = builder.tee_new_local();

    // Pseudo: bool can_use_fast_path = (entry & 0xFFF & ~TLB_READONLY & ~TLB_GLOBAL & ~(cpl == 3 ? 0 : TLB_NO_USER) == TLB_VALID &&
    //                                   (address & 0xFFF) <= (0x1000 - (bitsize / 8));
    builder.instruction_body.push_i32(
        (0xFFF & !TLB_READONLY & !TLB_GLOBAL & !(if ctx.cpu.cpl3() { 0 } else { TLB_NO_USER }))
            as i32,
    );
    builder.instruction_body.and_i32();

    builder.instruction_body.push_i32(TLB_VALID as i32);
    builder.instruction_body.eq_i32();

    builder.instruction_body.get_local(&address_local);
    builder.instruction_body.push_i32(0xFFF);
    builder.instruction_body.and_i32();
    builder
        .instruction_body
        .push_i32(0x1000 - if bits == BitSize::WORD { 2 } else { 4 });
    builder.instruction_body.le_i32();

    builder.instruction_body.and_i32();

    // Pseudo:
    // if(can_use_fast_path) leave_on_stack(mem8[entry & ~0xFFF ^ address]);
    builder.instruction_body.if_i32();
    builder.instruction_body.get_local(&entry_local);
    builder.instruction_body.push_i32(!0xFFF);
    builder.instruction_body.and_i32();
    builder.instruction_body.get_local(&address_local);
    builder.instruction_body.xor_i32();

    match bits {
        BitSize::WORD => {
            builder
                .instruction_body
                .load_unaligned_u16_from_stack(global_pointers::MEMORY);
        },
        BitSize::DWORD => {
            builder
                .instruction_body
                .load_unaligned_i32_from_stack(global_pointers::MEMORY);
        },
    }

    // Pseudo:
    // else { leave_on_stack(safe_read16_slow(address)); }
    builder.instruction_body.else_();
    builder.instruction_body.get_local(&address_local);
    match bits {
        BitSize::WORD => {
            gen_call_fn1_ret(builder, "safe_read16_slow");
        },
        BitSize::DWORD => {
            gen_call_fn1_ret(builder, "safe_read32s_slow");
        },
    }
    builder.instruction_body.block_end();

    builder.free_local(address_local);
    builder.free_local(entry_local);
}

fn gen_safe_write(
    ctx: &mut JitContext,
    bits: BitSize,
    address_local: &WasmLocal,
    value_local: &WasmLocal,
) {
    // Generates safe_writeXX' fast-path inline, bailing to safe_writeXX_slow if necessary.

    let builder = &mut ctx.builder;

    builder.instruction_body.get_local(&address_local);

    // Pseudo: base_on_stack = (uint32_t)address >> 12;
    builder.instruction_body.push_i32(12);
    builder.instruction_body.shr_u32();

    // scale index
    builder.instruction_body.push_i32(2);
    builder.instruction_body.shl_i32();

    // Pseudo: entry = tlb_data[base_on_stack];
    builder
        .instruction_body
        .load_aligned_i32_from_stack(global_pointers::TLB_DATA);
    let entry_local = builder.tee_new_local();

    // Pseudo: bool can_use_fast_path = (entry & 0xFFF & ~TLB_GLOBAL & ~(cpl == 3 ? 0 : TLB_NO_USER) == TLB_VALID &&
    //                                   (address & 0xFFF) <= (0x1000 - bitsize / 8));
    builder
        .instruction_body
        .push_i32((0xFFF & !TLB_GLOBAL & !(if ctx.cpu.cpl3() { 0 } else { TLB_NO_USER })) as i32);
    builder.instruction_body.and_i32();

    builder.instruction_body.push_i32(TLB_VALID as i32);
    builder.instruction_body.eq_i32();

    builder.instruction_body.get_local(&address_local);
    builder.instruction_body.push_i32(0xFFF);
    builder.instruction_body.and_i32();
    builder
        .instruction_body
        .push_i32(0x1000 - if bits == BitSize::WORD { 2 } else { 4 });
    builder.instruction_body.le_i32();

    builder.instruction_body.and_i32();

    // Pseudo:
    // if(can_use_fast_path)
    // {
    //     phys_addr = entry & ~0xFFF ^ address;
    builder.instruction_body.if_void();

    builder.instruction_body.get_local(&entry_local);
    builder.instruction_body.push_i32(!0xFFF);
    builder.instruction_body.and_i32();
    builder.instruction_body.get_local(&address_local);
    builder.instruction_body.xor_i32();

    builder.free_local(entry_local);

    // Pseudo:
    //     /* continued within can_use_fast_path branch */
    //     mem8[phys_addr] = value;

    builder.instruction_body.get_local(&value_local);
    match bits {
        BitSize::WORD => {
            builder
                .instruction_body
                .store_unaligned_u16(global_pointers::MEMORY);
        },
        BitSize::DWORD => {
            builder
                .instruction_body
                .store_unaligned_i32(global_pointers::MEMORY);
        },
    }

    // Pseudo:
    // else { safe_write16_slow(address, value); }
    builder.instruction_body.else_();
    builder.instruction_body.get_local(&address_local);
    builder.instruction_body.get_local(&value_local);
    match bits {
        BitSize::WORD => {
            gen_call_fn2(builder, "safe_write16_slow");
        },
        BitSize::DWORD => {
            gen_call_fn2(builder, "safe_write32_slow");
        },
    }
    builder.instruction_body.block_end();
}

pub fn gen_fn1_reg16(ctx: &mut JitContext, name: &str, r: u32) {
    let fn_idx = ctx.builder.get_fn_idx(name, module_init::FN1_TYPE_INDEX);
    ctx.builder
        .instruction_body
        .load_aligned_u16(global_pointers::get_reg16_offset(r));
    ctx.builder.instruction_body.call_fn(fn_idx)
}

pub fn gen_fn1_reg32(ctx: &mut JitContext, name: &str, r: u32) {
    let fn_idx = ctx.builder.get_fn_idx(name, module_init::FN1_TYPE_INDEX);
    ctx.builder
        .instruction_body
        .load_aligned_i32(global_pointers::get_reg32_offset(r));
    ctx.builder.instruction_body.call_fn(fn_idx)
}

pub fn gen_clear_prefixes(ctx: &mut JitContext) {
    let instruction_body = &mut ctx.builder.instruction_body;
    instruction_body.push_i32(global_pointers::PREFIXES as i32); // load address of prefixes
    instruction_body.push_i32(0);
    instruction_body.store_aligned_i32();
}

pub fn gen_add_prefix_bits(ctx: &mut JitContext, mask: u32) {
    dbg_assert!(mask < 0x100);

    let instruction_body = &mut ctx.builder.instruction_body;
    instruction_body.push_i32(global_pointers::PREFIXES as i32); // load address of prefixes

    instruction_body.load_aligned_i32(global_pointers::PREFIXES); // load old value
    instruction_body.push_i32(mask as i32);
    instruction_body.or_i32();

    instruction_body.store_aligned_i32();
}

pub fn gen_jmp_rel16(ctx: &mut JitContext, rel16: u16) {
    let cs_offset_addr = global_pointers::get_seg_offset(regs::CS);
    ctx.builder
        .instruction_body
        .load_aligned_i32(cs_offset_addr);
    let local = ctx.builder.set_new_local();

    // generate:
    // *instruction_pointer = cs_offset + ((*instruction_pointer - cs_offset + rel16) & 0xFFFF);
    {
        let instruction_body = &mut ctx.builder.instruction_body;

        instruction_body.push_i32(global_pointers::INSTRUCTION_POINTER as i32);

        instruction_body.load_aligned_i32(global_pointers::INSTRUCTION_POINTER);
        instruction_body.get_local(&local);
        instruction_body.sub_i32();

        instruction_body.push_i32(rel16 as i32);
        instruction_body.add_i32();

        instruction_body.push_i32(0xFFFF);
        instruction_body.and_i32();

        instruction_body.get_local(&local);
        instruction_body.add_i32();

        instruction_body.store_aligned_i32();
    }
    ctx.builder.free_local(local);
}

pub fn gen_pop16_ss16(ctx: &mut JitContext) {
    // sp = segment_offsets[SS] + reg16[SP] (or just reg16[SP] if has_flat_segmentation)
    ctx.builder
        .instruction_body
        .load_aligned_i32(global_pointers::get_reg16_offset(regs::SP));
    let sp_local = ctx.builder.tee_new_local();

    if !ctx.cpu.has_flat_segmentation() {
        ctx.builder
            .instruction_body
            .load_aligned_i32(global_pointers::get_seg_offset(regs::SS));
        ctx.builder.instruction_body.add_i32();
    }

    // result = safe_read16(sp)
    gen_safe_read16(ctx);

    // reg16[SP] += 2;
    ctx.builder
        .instruction_body
        .push_i32(global_pointers::get_reg16_offset(regs::SP) as i32);
    ctx.builder.instruction_body.get_local(&sp_local);
    ctx.builder.instruction_body.push_i32(2);
    ctx.builder.instruction_body.add_i32();
    ctx.builder.instruction_body.store_aligned_i32();

    ctx.builder.free_local(sp_local);

    // return value is already on stack
}

pub fn gen_pop16_ss32(ctx: &mut JitContext) {
    // esp = segment_offsets[SS] + reg32s[ESP] (or just reg32s[ESP] if has_flat_segmentation)
    ctx.builder
        .instruction_body
        .load_aligned_i32(global_pointers::get_reg32_offset(regs::ESP));
    let esp_local = ctx.builder.tee_new_local();

    if !ctx.cpu.has_flat_segmentation() {
        ctx.builder
            .instruction_body
            .load_aligned_i32(global_pointers::get_seg_offset(regs::SS));
        ctx.builder.instruction_body.add_i32();
    }

    // result = safe_read16(esp)
    gen_safe_read16(ctx);

    // reg32s[ESP] += 2;
    ctx.builder
        .instruction_body
        .push_i32(global_pointers::get_reg32_offset(regs::ESP) as i32);
    ctx.builder.instruction_body.get_local(&esp_local);
    ctx.builder.instruction_body.push_i32(2);
    ctx.builder.instruction_body.add_i32();
    ctx.builder.instruction_body.store_aligned_i32();
    ctx.builder.free_local(esp_local);

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
    ctx.builder
        .instruction_body
        .load_aligned_i32(global_pointers::get_reg16_offset(regs::SP));
    let local_sp = ctx.builder.tee_new_local();

    // result = safe_read32s(segment_offsets[SS] + sp) (or just sp if has_flat_segmentation)
    if !ctx.cpu.has_flat_segmentation() {
        ctx.builder
            .instruction_body
            .load_aligned_i32(global_pointers::get_seg_offset(regs::SS));
        ctx.builder.instruction_body.add_i32();
    }

    gen_safe_read32(ctx);

    // reg16[SP] = sp + 4;
    ctx.builder
        .instruction_body
        .push_i32(global_pointers::get_reg16_offset(regs::SP) as i32);
    ctx.builder.instruction_body.get_local(&local_sp);
    ctx.builder.instruction_body.push_i32(4);
    ctx.builder.instruction_body.add_i32();
    ctx.builder.instruction_body.store_aligned_i32();

    ctx.builder.free_local(local_sp);

    // return value is already on stack
}

pub fn gen_pop32s_ss32(ctx: &mut JitContext) {
    // esp = reg32s[ESP]
    ctx.builder
        .instruction_body
        .load_aligned_i32(global_pointers::get_reg32_offset(regs::ESP));
    let local_esp = ctx.builder.tee_new_local();

    // result = safe_read32s(segment_offsets[SS] + esp) (or just esp if has_flat_segmentation)
    if !ctx.cpu.has_flat_segmentation() {
        ctx.builder
            .instruction_body
            .load_aligned_i32(global_pointers::get_seg_offset(regs::SS));
        ctx.builder.instruction_body.add_i32();
    }
    gen_safe_read32(ctx);

    // reg32s[ESP] = esp + 4;
    ctx.builder
        .instruction_body
        .push_i32(global_pointers::get_reg32_offset(regs::ESP) as i32);
    ctx.builder.instruction_body.get_local(&local_esp);
    ctx.builder.instruction_body.push_i32(4);
    ctx.builder.instruction_body.add_i32();
    ctx.builder.instruction_body.store_aligned_i32();

    ctx.builder.free_local(local_esp);

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

pub fn gen_task_switch_test(ctx: &mut JitContext) {
    // generate if(cr[0] & (CR0_EM | CR0_TS)) { task_switch_test_void(); return; }

    let cr0_offset = global_pointers::get_creg_offset(0);

    ctx.builder.instruction_body.load_aligned_i32(cr0_offset);
    ctx.builder
        .instruction_body
        .push_i32((regs::CR0_EM | regs::CR0_TS) as i32);
    ctx.builder.instruction_body.and_i32();

    ctx.builder.instruction_body.if_void();

    gen_fn0_const(ctx, "task_switch_test_void");
    ctx.builder.instruction_body.return_();

    ctx.builder.instruction_body.block_end();
}

pub fn gen_task_switch_test_mmx(ctx: &mut JitContext) {
    // generate if(cr[0] & (CR0_EM | CR0_TS)) { task_switch_test_mmx_void(); return; }
    let cr0_offset = global_pointers::get_creg_offset(0);

    ctx.builder.instruction_body.load_aligned_i32(cr0_offset);
    ctx.builder
        .instruction_body
        .push_i32((regs::CR0_EM | regs::CR0_TS) as i32);
    ctx.builder.instruction_body.and_i32();

    ctx.builder.instruction_body.if_void();

    gen_fn0_const(ctx, "task_switch_test_mmx_void");
    ctx.builder.instruction_body.return_();

    ctx.builder.instruction_body.block_end();
}

pub fn gen_push16_ss16(ctx: &mut JitContext, imm: ImmVal) {
    match imm {
        ImmVal::REG(r) => {
            ctx.builder
                .instruction_body
                .load_aligned_u16(global_pointers::get_reg16_offset(r));
        },
        ImmVal::CONST(imm) => {
            ctx.builder.instruction_body.push_i32(imm as i32);
        },
        ImmVal::MEM => {
            // NOTE: It's important that this match stays atop so gen_safe_read16 gets called early enough
            gen_safe_read16(ctx);
        },
    };
    let value_local = ctx.builder.set_new_local();

    ctx.builder
        .instruction_body
        .load_aligned_i32(global_pointers::get_reg16_offset(regs::SP));
    ctx.builder.instruction_body.push_i32(2);
    ctx.builder.instruction_body.sub_i32();
    let reg16_updated_local = ctx.builder.tee_new_local();
    ctx.builder.instruction_body.push_i32(0xFFFF);
    ctx.builder.instruction_body.and_i32();

    if !ctx.cpu.has_flat_segmentation() {
        ctx.builder
            .instruction_body
            .load_aligned_i32(global_pointers::get_seg_offset(regs::SS));
        ctx.builder.instruction_body.add_i32();
    }

    let sp_local = ctx.builder.set_new_local();
    gen_safe_write16(ctx, &sp_local, &value_local);
    ctx.builder.free_local(sp_local);
    ctx.builder.free_local(value_local);
    ctx.builder
        .instruction_body
        .push_i32(global_pointers::get_reg16_offset(regs::SP) as i32);
    ctx.builder.instruction_body.get_local(&reg16_updated_local);
    ctx.builder.instruction_body.store_aligned_u16();
    ctx.builder.free_local(reg16_updated_local);
}

pub fn gen_push16_ss32(ctx: &mut JitContext, imm: ImmVal) {
    match imm {
        ImmVal::REG(r) => {
            ctx.builder
                .instruction_body
                .load_aligned_u16(global_pointers::get_reg16_offset(r));
        },
        ImmVal::CONST(imm) => {
            ctx.builder.instruction_body.push_i32(imm as i32);
        },
        ImmVal::MEM => {
            // NOTE: It's important that this match stays atop so gen_safe_read16 gets called early enough
            gen_safe_read16(ctx);
        },
    };
    let value_local = ctx.builder.set_new_local();

    ctx.builder
        .instruction_body
        .load_aligned_i32(global_pointers::get_reg32_offset(regs::ESP));
    ctx.builder.instruction_body.push_i32(2);
    ctx.builder.instruction_body.sub_i32();
    let reg32_updated_local = ctx.builder.tee_new_local();

    if !ctx.cpu.has_flat_segmentation() {
        ctx.builder
            .instruction_body
            .load_aligned_i32(global_pointers::get_seg_offset(regs::SS));
        ctx.builder.instruction_body.add_i32();
    }

    let sp_local = ctx.builder.set_new_local();
    gen_safe_write16(ctx, &sp_local, &value_local);
    ctx.builder.free_local(sp_local);
    ctx.builder.free_local(value_local);
    ctx.builder
        .instruction_body
        .push_i32(global_pointers::get_reg32_offset(regs::ESP) as i32);
    ctx.builder.instruction_body.get_local(&reg32_updated_local);
    ctx.builder.instruction_body.store_aligned_i32();
    ctx.builder.free_local(reg32_updated_local);
}

pub fn gen_push32_ss16(ctx: &mut JitContext, imm: ImmVal) {
    match imm {
        ImmVal::REG(r) => {
            ctx.builder
                .instruction_body
                .load_aligned_i32(global_pointers::get_reg32_offset(r));
        },
        ImmVal::CONST(imm) => {
            ctx.builder.instruction_body.push_i32(imm as i32);
        },
        ImmVal::MEM => {
            gen_safe_read32(ctx);
        },
    };
    let value_local = ctx.builder.set_new_local();

    ctx.builder
        .instruction_body
        .load_aligned_u16(global_pointers::get_reg16_offset(regs::SP));
    ctx.builder.instruction_body.push_i32(4);
    ctx.builder.instruction_body.sub_i32();
    ctx.builder.instruction_body.push_i32(0xFFFF);
    ctx.builder.instruction_body.and_i32();
    let new_sp_local = ctx.builder.tee_new_local();

    if !ctx.cpu.has_flat_segmentation() {
        ctx.builder
            .instruction_body
            .load_aligned_i32(global_pointers::get_seg_offset(regs::SS));
        ctx.builder.instruction_body.add_i32();
    }

    let sp_local = ctx.builder.set_new_local();

    gen_safe_write32(ctx, &sp_local, &value_local);
    ctx.builder.free_local(value_local);
    ctx.builder.free_local(sp_local);

    ctx.builder
        .instruction_body
        .push_i32(global_pointers::get_reg16_offset(regs::SP) as i32);
    ctx.builder.instruction_body.get_local(&new_sp_local);
    ctx.builder.instruction_body.store_aligned_u16();
    ctx.builder.free_local(new_sp_local);
}

pub fn gen_push32_ss32(ctx: &mut JitContext, imm: ImmVal) {
    match imm {
        ImmVal::REG(r) => {
            ctx.builder
                .instruction_body
                .load_aligned_i32(global_pointers::get_reg32_offset(r));
        },
        ImmVal::CONST(imm) => {
            ctx.builder.instruction_body.push_i32(imm as i32);
        },
        ImmVal::MEM => {
            gen_safe_read32(ctx);
        },
    };
    let value_local = ctx.builder.set_new_local();

    ctx.builder
        .instruction_body
        .load_aligned_i32(global_pointers::get_reg32_offset(regs::ESP));
    ctx.builder.instruction_body.push_i32(4);
    ctx.builder.instruction_body.sub_i32();
    let new_esp_local = ctx.builder.tee_new_local();

    if !ctx.cpu.has_flat_segmentation() {
        ctx.builder
            .instruction_body
            .load_aligned_i32(global_pointers::get_seg_offset(regs::SS));
        ctx.builder.instruction_body.add_i32();
    }

    let sp_local = ctx.builder.set_new_local();

    gen_safe_write32(ctx, &sp_local, &value_local);
    ctx.builder.free_local(value_local);
    ctx.builder.free_local(sp_local);

    ctx.builder
        .instruction_body
        .push_i32(global_pointers::get_reg32_offset(regs::ESP) as i32);
    ctx.builder.instruction_body.get_local(&new_esp_local);
    ctx.builder.instruction_body.store_aligned_i32();
    ctx.builder.free_local(new_esp_local);
}
