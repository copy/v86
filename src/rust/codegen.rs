use global_pointers;
use jit::JitContext;
use modrm;
use regs;
use tlb::{TLB_GLOBAL, TLB_NO_USER, TLB_READONLY, TLB_VALID};
use wasmgen::module_init::{WasmBuilder, WasmLocal};
use wasmgen::{module_init, wasm_util};

pub fn gen_set_previous_eip_offset_from_eip(builder: &mut WasmBuilder, n: u32) {
    let cs = &mut builder.code_section;
    wasm_util::push_i32(cs, global_pointers::PREVIOUS_IP as i32); // store address of previous ip
    wasm_util::load_aligned_i32(cs, global_pointers::INSTRUCTION_POINTER); // load ip
    if n != 0 {
        wasm_util::push_i32(cs, n as i32);
        wasm_util::add_i32(cs); // add constant to ip value
    }
    wasm_util::store_aligned_i32(cs); // store it as previous ip
}

pub fn gen_increment_instruction_pointer(builder: &mut WasmBuilder, n: u32) {
    let cs = &mut builder.code_section;
    wasm_util::push_i32(cs, global_pointers::INSTRUCTION_POINTER as i32); // store address of ip

    wasm_util::load_aligned_i32(cs, global_pointers::INSTRUCTION_POINTER); // load ip

    wasm_util::push_i32(cs, n as i32);

    wasm_util::add_i32(cs);
    wasm_util::store_aligned_i32(cs); // store it back in
}

pub fn gen_set_previous_eip(builder: &mut WasmBuilder) {
    let cs = &mut builder.code_section;
    wasm_util::push_i32(cs, global_pointers::PREVIOUS_IP as i32); // store address of previous ip
    wasm_util::load_aligned_i32(cs, global_pointers::INSTRUCTION_POINTER); // load ip
    wasm_util::store_aligned_i32(cs); // store it as previous ip
}

pub fn gen_relative_jump(builder: &mut WasmBuilder, n: i32) {
    // add n to instruction_pointer (without setting the offset as above)
    let instruction_body = &mut builder.instruction_body;
    wasm_util::push_i32(
        instruction_body,
        global_pointers::INSTRUCTION_POINTER as i32,
    );
    wasm_util::load_aligned_i32(instruction_body, global_pointers::INSTRUCTION_POINTER);
    wasm_util::push_i32(instruction_body, n);
    wasm_util::add_i32(instruction_body);
    wasm_util::store_aligned_i32(instruction_body);
}

pub fn gen_increment_variable(builder: &mut WasmBuilder, variable_address: u32, n: i32) {
    wasm_util::increment_variable(&mut builder.code_section, variable_address, n);
}

pub fn gen_increment_timestamp_counter(builder: &mut WasmBuilder, n: i32) {
    gen_increment_variable(builder, global_pointers::TIMESTAMP_COUNTER, n);
}

pub fn gen_increment_mem32(builder: &mut WasmBuilder, addr: u32) {
    wasm_util::increment_mem32(&mut builder.code_section, addr)
}

pub fn gen_fn0_const(ctx: &mut JitContext, name: &str) {
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN0_TYPE_INDEX);
    wasm_util::call_fn(&mut builder.instruction_body, fn_idx);
}

pub fn gen_fn0_const_ret(builder: &mut WasmBuilder, name: &str) {
    let fn_idx = builder.get_fn_idx(name, module_init::FN0_RET_TYPE_INDEX);
    wasm_util::call_fn(&mut builder.instruction_body, fn_idx);
}

pub fn gen_fn1_const(ctx: &mut JitContext, name: &str, arg0: u32) {
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN1_TYPE_INDEX);
    wasm_util::push_i32(&mut builder.instruction_body, arg0 as i32);
    wasm_util::call_fn(&mut builder.instruction_body, fn_idx);
}

pub fn gen_call_fn1_ret(builder: &mut WasmBuilder, name: &str) {
    // generates: fn( _ ) where _ must be left on the stack before calling this, and fn returns a value
    let fn_idx = builder.get_fn_idx(name, module_init::FN1_RET_TYPE_INDEX);
    wasm_util::call_fn(&mut builder.instruction_body, fn_idx);
}

pub fn gen_fn2_const(ctx: &mut JitContext, name: &str, arg0: u32, arg1: u32) {
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN2_TYPE_INDEX);
    wasm_util::push_i32(&mut builder.instruction_body, arg0 as i32);
    wasm_util::push_i32(&mut builder.instruction_body, arg1 as i32);
    wasm_util::call_fn(&mut builder.instruction_body, fn_idx);
}

pub fn gen_call_fn2(builder: &mut WasmBuilder, name: &str) {
    // generates: fn( _, _ ) where _ must be left on the stack before calling this
    let fn_idx = builder.get_fn_idx(name, module_init::FN2_TYPE_INDEX);
    wasm_util::call_fn(&mut builder.instruction_body, fn_idx);
}

pub fn gen_fn3_const(ctx: &mut JitContext, name: &str, arg0: u32, arg1: u32, arg2: u32) {
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN3_TYPE_INDEX);
    wasm_util::push_i32(&mut builder.instruction_body, arg0 as i32);
    wasm_util::push_i32(&mut builder.instruction_body, arg1 as i32);
    wasm_util::push_i32(&mut builder.instruction_body, arg2 as i32);
    wasm_util::call_fn(&mut builder.instruction_body, fn_idx);
}

pub fn gen_modrm_fn0(ctx: &mut JitContext, name: &str) {
    // generates: fn( _ )
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN1_TYPE_INDEX);
    wasm_util::call_fn(&mut builder.instruction_body, fn_idx);
}

pub fn gen_modrm_fn1(ctx: &mut JitContext, name: &str, arg0: u32) {
    // generates: fn( _, arg0 )
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN2_TYPE_INDEX);
    wasm_util::push_i32(&mut builder.instruction_body, arg0 as i32);
    wasm_util::call_fn(&mut builder.instruction_body, fn_idx);
}

pub fn gen_modrm_fn2(ctx: &mut JitContext, name: &str, arg0: u32, arg1: u32) {
    // generates: fn( _, arg0, arg1 )
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN3_TYPE_INDEX);
    wasm_util::push_i32(&mut builder.instruction_body, arg0 as i32);
    wasm_util::push_i32(&mut builder.instruction_body, arg1 as i32);
    wasm_util::call_fn(&mut builder.instruction_body, fn_idx);
}

pub fn gen_modrm_resolve(ctx: &mut JitContext, modrm_byte: u8) { modrm::gen(ctx, modrm_byte) }

pub fn gen_set_reg16_r(ctx: &mut JitContext, dest: u32, src: u32) {
    // generates: reg16[r_dest] = reg16[r_src]
    let builder = &mut ctx.builder;
    wasm_util::push_i32(
        &mut builder.instruction_body,
        global_pointers::get_reg16_offset(dest) as i32,
    );
    wasm_util::load_aligned_u16(
        &mut builder.instruction_body,
        global_pointers::get_reg16_offset(src),
    );
    wasm_util::store_aligned_u16(&mut builder.instruction_body);
}
pub fn gen_set_reg32_r(ctx: &mut JitContext, dest: u32, src: u32) {
    // generates: reg32s[r_dest] = reg32s[r_src]
    let builder = &mut ctx.builder;
    wasm_util::push_i32(
        &mut builder.instruction_body,
        global_pointers::get_reg32_offset(dest) as i32,
    );
    wasm_util::load_aligned_i32(
        &mut builder.instruction_body,
        global_pointers::get_reg32_offset(src),
    );
    wasm_util::store_aligned_i32(&mut builder.instruction_body);
}

pub fn gen_set_reg16_fn0(ctx: &mut JitContext, name: &str, reg: u32) {
    // generates: reg16[reg] = fn()
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN0_RET_TYPE_INDEX);
    wasm_util::push_i32(
        &mut builder.instruction_body,
        global_pointers::get_reg16_offset(reg) as i32,
    );
    wasm_util::call_fn(&mut builder.instruction_body, fn_idx);
    wasm_util::store_aligned_u16(&mut builder.instruction_body);
}

pub fn gen_set_reg32s_fn0(ctx: &mut JitContext, name: &str, reg: u32) {
    // generates: reg32s[reg] = fn()
    let builder = &mut ctx.builder;
    let fn_idx = builder.get_fn_idx(name, module_init::FN0_RET_TYPE_INDEX);
    wasm_util::push_i32(
        &mut builder.instruction_body,
        global_pointers::get_reg32_offset(reg) as i32,
    );
    wasm_util::call_fn(&mut builder.instruction_body, fn_idx);
    wasm_util::store_aligned_i32(&mut builder.instruction_body);
}

pub fn gen_safe_read32(ctx: &mut JitContext) {
    // Assumes virtual address has been pushed to the stack, and generates safe_read32s' fast-path
    // inline, bailing to safe_read32s_slow if necessary
    let builder = &mut ctx.builder;
    //let instruction_body = &mut ctx.builder.instruction_body;
    //let cpu = &mut ctx.cpu;

    let address_local = builder.alloc_local();
    wasm_util::tee_local(&mut builder.instruction_body, &address_local);

    // Pseudo: base_on_stack = (uint32_t)address >> 12;
    wasm_util::push_i32(&mut builder.instruction_body, 12);
    wasm_util::shr_u32(&mut builder.instruction_body);

    // scale index
    wasm_util::push_i32(&mut builder.instruction_body, 2);
    wasm_util::shl_i32(&mut builder.instruction_body);

    // Pseudo: entry = tlb_data[base_on_stack];
    let entry_local = builder.alloc_local();
    wasm_util::load_aligned_i32_from_stack(
        &mut builder.instruction_body,
        global_pointers::TLB_DATA,
    );
    wasm_util::tee_local(&mut builder.instruction_body, &entry_local);

    // Pseudo: bool can_use_fast_path = (entry & 0xFFF & ~TLB_READONLY & ~TLB_GLOBAL & ~(cpl == 3 ? 0 : TLB_NO_USER) == TLB_VALID &&
    //                                   (address & 0xFFF) <= (0x1000 - 4));
    wasm_util::push_i32(
        &mut builder.instruction_body,
        (0xFFF & !TLB_READONLY & !TLB_GLOBAL & !(if ctx.cpu.cpl3() { 0 } else { TLB_NO_USER }))
            as i32,
    );
    wasm_util::and_i32(&mut builder.instruction_body);

    wasm_util::push_i32(&mut builder.instruction_body, TLB_VALID as i32);
    wasm_util::eq_i32(&mut builder.instruction_body);

    wasm_util::get_local(&mut builder.instruction_body, &address_local);
    wasm_util::push_i32(&mut builder.instruction_body, 0xFFF);
    wasm_util::and_i32(&mut builder.instruction_body);
    wasm_util::push_i32(&mut builder.instruction_body, 0x1000 - 4);
    wasm_util::le_i32(&mut builder.instruction_body);

    wasm_util::and_i32(&mut builder.instruction_body);

    // Pseudo:
    // if(can_use_fast_path) leave_on_stack(mem8[entry & ~0xFFF ^ address]);
    wasm_util::if_i32(&mut builder.instruction_body);
    wasm_util::get_local(&mut builder.instruction_body, &entry_local);
    wasm_util::push_i32(&mut builder.instruction_body, !0xFFF);
    wasm_util::and_i32(&mut builder.instruction_body);
    wasm_util::get_local(&mut builder.instruction_body, &address_local);
    wasm_util::xor_i32(&mut builder.instruction_body);

    wasm_util::load_unaligned_i32_from_stack(
        &mut builder.instruction_body,
        global_pointers::MEMORY,
    );

    // Pseudo:
    // else { leave_on_stack(safe_read32s_slow(address)); }
    wasm_util::else_(&mut builder.instruction_body);
    wasm_util::get_local(&mut builder.instruction_body, &address_local);
    gen_call_fn1_ret(builder, "safe_read32s_slow");
    wasm_util::block_end(&mut builder.instruction_body);

    builder.free_local(address_local);
    builder.free_local(entry_local);
}

pub fn gen_safe_write32(ctx: &mut JitContext, address_local: &WasmLocal, value_local: &WasmLocal) {
    // Generates safe_write32' fast-path inline, bailing to safe_write32_slow if necessary.

    let builder = &mut ctx.builder;
    //let instruction_body = &mut ctx.builder.instruction_body;
    //let cpu = &mut ctx.cpu;

    wasm_util::get_local(&mut builder.instruction_body, &address_local);

    // Pseudo: base_on_stack = (uint32_t)address >> 12;
    wasm_util::push_i32(&mut builder.instruction_body, 12);
    wasm_util::shr_u32(&mut builder.instruction_body);

    // scale index
    wasm_util::push_i32(&mut builder.instruction_body, 2);
    wasm_util::shl_i32(&mut builder.instruction_body);

    // Pseudo: entry = tlb_data[base_on_stack];
    let entry_local = builder.alloc_local();
    wasm_util::load_aligned_i32_from_stack(
        &mut builder.instruction_body,
        global_pointers::TLB_DATA,
    );
    wasm_util::tee_local(&mut builder.instruction_body, &entry_local);

    // Pseudo: bool can_use_fast_path = (entry & 0xFFF & ~TLB_GLOBAL & ~(cpl == 3 ? 0 : TLB_NO_USER) == TLB_VALID &&
    //                                   (address & 0xFFF) <= (0x1000 - 4));
    wasm_util::push_i32(
        &mut builder.instruction_body,
        (0xFFF & !TLB_GLOBAL & !(if ctx.cpu.cpl3() { 0 } else { TLB_NO_USER })) as i32,
    );
    wasm_util::and_i32(&mut builder.instruction_body);

    wasm_util::push_i32(&mut builder.instruction_body, TLB_VALID as i32);
    wasm_util::eq_i32(&mut builder.instruction_body);

    wasm_util::get_local(&mut builder.instruction_body, &address_local);
    wasm_util::push_i32(&mut builder.instruction_body, 0xFFF);
    wasm_util::and_i32(&mut builder.instruction_body);
    wasm_util::push_i32(&mut builder.instruction_body, 0x1000 - 4);
    wasm_util::le_i32(&mut builder.instruction_body);

    wasm_util::and_i32(&mut builder.instruction_body);

    // Pseudo:
    // if(can_use_fast_path)
    // {
    //     phys_addr = entry & ~0xFFF ^ address;
    wasm_util::if_void(&mut builder.instruction_body);

    wasm_util::get_local(&mut builder.instruction_body, &entry_local);
    wasm_util::push_i32(&mut builder.instruction_body, !0xFFF);
    wasm_util::and_i32(&mut builder.instruction_body);
    wasm_util::get_local(&mut builder.instruction_body, &address_local);
    wasm_util::xor_i32(&mut builder.instruction_body);

    builder.free_local(entry_local);

    let phys_addr_local = builder.alloc_local();
    // Pseudo:
    //     /* continued within can_use_fast_path branch */
    //     mem8[phys_addr] = value;

    wasm_util::tee_local(&mut builder.instruction_body, &phys_addr_local);
    wasm_util::get_local(&mut builder.instruction_body, &value_local);
    wasm_util::store_unaligned_i32(&mut builder.instruction_body, global_pointers::MEMORY);

    // Pseudo:
    // else { safe_read32_slow(address, value); }
    wasm_util::else_(&mut builder.instruction_body);
    wasm_util::get_local(&mut builder.instruction_body, &address_local);
    wasm_util::get_local(&mut builder.instruction_body, &value_local);
    gen_call_fn2(builder, "safe_write32_slow");
    wasm_util::block_end(&mut builder.instruction_body);

    builder.free_local(phys_addr_local);
}

pub fn gen_safe_read16(ctx: &mut JitContext) {
    // Assumes virtual address has been pushed to the stack, and generates safe_read16's fast-path
    // inline, bailing to safe_read16_slow if necessary
    let builder = &mut ctx.builder;

    let address_local = builder.alloc_local();
    wasm_util::tee_local(&mut builder.instruction_body, &address_local);

    // Pseudo: base_on_stack = (uint32_t)address >> 12;
    wasm_util::push_i32(&mut builder.instruction_body, 12);
    wasm_util::shr_u32(&mut builder.instruction_body);

    // scale index
    wasm_util::push_i32(&mut builder.instruction_body, 2);
    wasm_util::shl_i32(&mut builder.instruction_body);

    // Pseudo: entry = tlb_data[base_on_stack];
    let entry_local = builder.alloc_local();
    wasm_util::load_aligned_i32_from_stack(
        &mut builder.instruction_body,
        global_pointers::TLB_DATA,
    );
    wasm_util::tee_local(&mut builder.instruction_body, &entry_local);

    // Pseudo: bool can_use_fast_path = (entry & 0xFFF & ~TLB_READONLY & ~TLB_GLOBAL & ~(cpl == 3 ? 0 : TLB_NO_USER) == TLB_VALID &&
    //                                   (address & 0xFFF) <= (0x1000 - 2));
    wasm_util::push_i32(
        &mut builder.instruction_body,
        (0xFFF & !TLB_READONLY & !TLB_GLOBAL & !(if ctx.cpu.cpl3() { 0 } else { TLB_NO_USER }))
            as i32,
    );
    wasm_util::and_i32(&mut builder.instruction_body);

    wasm_util::push_i32(&mut builder.instruction_body, TLB_VALID as i32);
    wasm_util::eq_i32(&mut builder.instruction_body);

    wasm_util::get_local(&mut builder.instruction_body, &address_local);
    wasm_util::push_i32(&mut builder.instruction_body, 0xFFF);
    wasm_util::and_i32(&mut builder.instruction_body);
    wasm_util::push_i32(&mut builder.instruction_body, 0x1000 - 2);
    wasm_util::le_i32(&mut builder.instruction_body);

    wasm_util::and_i32(&mut builder.instruction_body);

    // Pseudo:
    // if(can_use_fast_path) leave_on_stack(mem8[entry & ~0xFFF ^ address]);
    wasm_util::if_i32(&mut builder.instruction_body);
    wasm_util::get_local(&mut builder.instruction_body, &entry_local);
    wasm_util::push_i32(&mut builder.instruction_body, !0xFFF);
    wasm_util::and_i32(&mut builder.instruction_body);
    wasm_util::get_local(&mut builder.instruction_body, &address_local);
    wasm_util::xor_i32(&mut builder.instruction_body);

    wasm_util::load_unaligned_u16_from_stack(
        &mut builder.instruction_body,
        global_pointers::MEMORY,
    );

    // Pseudo:
    // else { leave_on_stack(safe_read16_slow(address)); }
    wasm_util::else_(&mut builder.instruction_body);
    wasm_util::get_local(&mut builder.instruction_body, &address_local);
    gen_call_fn1_ret(builder, "safe_read16_slow");
    wasm_util::block_end(&mut builder.instruction_body);

    builder.free_local(address_local);
    builder.free_local(entry_local);
}

pub fn gen_safe_write16(ctx: &mut JitContext, address_local: &WasmLocal, value_local: &WasmLocal) {
    // Generates safe_write16' fast-path inline, bailing to safe_write16_slow if necessary.

    let builder = &mut ctx.builder;
    //let instruction_body = &mut ctx.builder.instruction_body;
    //let cpu = &mut ctx.cpu;

    wasm_util::get_local(&mut builder.instruction_body, &address_local);

    // Pseudo: base_on_stack = (uint32_t)address >> 12;
    wasm_util::push_i32(&mut builder.instruction_body, 12);
    wasm_util::shr_u32(&mut builder.instruction_body);

    // scale index
    wasm_util::push_i32(&mut builder.instruction_body, 2);
    wasm_util::shl_i32(&mut builder.instruction_body);

    // Pseudo: entry = tlb_data[base_on_stack];
    let entry_local = builder.alloc_local();
    wasm_util::load_aligned_i32_from_stack(
        &mut builder.instruction_body,
        global_pointers::TLB_DATA,
    );
    wasm_util::tee_local(&mut builder.instruction_body, &entry_local);

    // Pseudo: bool can_use_fast_path = (entry & 0xFFF & ~TLB_GLOBAL & ~(cpl == 3 ? 0 : TLB_NO_USER) == TLB_VALID &&
    //                                   (address & 0xFFF) <= (0x1000 - 2));
    wasm_util::push_i32(
        &mut builder.instruction_body,
        (0xFFF & !TLB_GLOBAL & !(if ctx.cpu.cpl3() { 0 } else { TLB_NO_USER })) as i32,
    );
    wasm_util::and_i32(&mut builder.instruction_body);

    wasm_util::push_i32(&mut builder.instruction_body, TLB_VALID as i32);
    wasm_util::eq_i32(&mut builder.instruction_body);

    wasm_util::get_local(&mut builder.instruction_body, &address_local);
    wasm_util::push_i32(&mut builder.instruction_body, 0xFFF);
    wasm_util::and_i32(&mut builder.instruction_body);
    wasm_util::push_i32(&mut builder.instruction_body, 0x1000 - 2);
    wasm_util::le_i32(&mut builder.instruction_body);

    wasm_util::and_i32(&mut builder.instruction_body);

    // Pseudo:
    // if(can_use_fast_path)
    // {
    //     phys_addr = entry & ~0xFFF ^ address;
    wasm_util::if_void(&mut builder.instruction_body);

    wasm_util::get_local(&mut builder.instruction_body, &entry_local);
    wasm_util::push_i32(&mut builder.instruction_body, !0xFFF);
    wasm_util::and_i32(&mut builder.instruction_body);
    wasm_util::get_local(&mut builder.instruction_body, &address_local);
    wasm_util::xor_i32(&mut builder.instruction_body);

    builder.free_local(entry_local);

    let phys_addr_local = builder.alloc_local();
    // Pseudo:
    //     /* continued within can_use_fast_path branch */
    //     mem8[phys_addr] = value;

    wasm_util::tee_local(&mut builder.instruction_body, &phys_addr_local);
    wasm_util::get_local(&mut builder.instruction_body, &value_local);
    wasm_util::store_unaligned_u16(&mut builder.instruction_body, global_pointers::MEMORY);

    // Pseudo:
    // else { safe_read16_slow(address, value); }
    wasm_util::else_(&mut builder.instruction_body);
    wasm_util::get_local(&mut builder.instruction_body, &address_local);
    wasm_util::get_local(&mut builder.instruction_body, &value_local);
    gen_call_fn2(builder, "safe_write16_slow");
    wasm_util::block_end(&mut builder.instruction_body);

    builder.free_local(phys_addr_local);
}

pub fn gen_fn1_reg16(ctx: &mut JitContext, name: &str, r: u32) {
    let fn_idx = ctx.builder.get_fn_idx(name, module_init::FN1_TYPE_INDEX);
    wasm_util::load_aligned_u16(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg16_offset(r),
    );
    wasm_util::call_fn(&mut ctx.builder.instruction_body, fn_idx)
}

pub fn gen_fn1_reg32(ctx: &mut JitContext, name: &str, r: u32) {
    let fn_idx = ctx.builder.get_fn_idx(name, module_init::FN1_TYPE_INDEX);
    wasm_util::load_aligned_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg32_offset(r),
    );
    wasm_util::call_fn(&mut ctx.builder.instruction_body, fn_idx)
}

pub fn gen_clear_prefixes(ctx: &mut JitContext) {
    let instruction_body = &mut ctx.builder.instruction_body;
    wasm_util::push_i32(instruction_body, global_pointers::PREFIXES as i32); // load address of prefixes
    wasm_util::push_i32(instruction_body, 0);
    wasm_util::store_aligned_i32(instruction_body);
}

pub fn gen_add_prefix_bits(ctx: &mut JitContext, mask: u32) {
    dbg_assert!(mask < 0x100);

    let instruction_body = &mut ctx.builder.instruction_body;
    wasm_util::push_i32(instruction_body, global_pointers::PREFIXES as i32); // load address of prefixes

    wasm_util::load_aligned_i32(instruction_body, global_pointers::PREFIXES); // load old value
    wasm_util::push_i32(instruction_body, mask as i32);
    wasm_util::or_i32(instruction_body);

    wasm_util::store_aligned_i32(instruction_body);
}

pub fn gen_jmp_rel16(ctx: &mut JitContext, rel16: u16) {
    let cs_offset_addr = global_pointers::get_seg_offset(regs::CS);
    let local = ctx.builder.alloc_local();

    // generate:
    // *instruction_pointer = cs_offset + ((*instruction_pointer - cs_offset + rel16) & 0xFFFF);
    {
        let instruction_body = &mut ctx.builder.instruction_body;

        wasm_util::load_aligned_i32(instruction_body, cs_offset_addr);
        wasm_util::set_local(instruction_body, &local);

        wasm_util::push_i32(
            instruction_body,
            global_pointers::INSTRUCTION_POINTER as i32,
        );

        wasm_util::load_aligned_i32(instruction_body, global_pointers::INSTRUCTION_POINTER);
        wasm_util::get_local(instruction_body, &local);
        wasm_util::sub_i32(instruction_body);

        wasm_util::push_i32(instruction_body, rel16 as i32);
        wasm_util::add_i32(instruction_body);

        wasm_util::push_i32(instruction_body, 0xFFFF);
        wasm_util::and_i32(instruction_body);

        wasm_util::get_local(instruction_body, &local);
        wasm_util::add_i32(instruction_body);

        wasm_util::store_aligned_i32(instruction_body);
    }
    ctx.builder.free_local(local);
}

pub fn gen_pop16_ss16(ctx: &mut JitContext) {
    let sp_local = ctx.builder.alloc_local();

    // sp = segment_offsets[SS] + reg16[SP] (or just reg16[SP] if has_flat_segmentation)
    wasm_util::load_aligned_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg16_offset(regs::SP),
    );
    wasm_util::tee_local(&mut ctx.builder.instruction_body, &sp_local);

    if !ctx.cpu.has_flat_segmentation() {
        wasm_util::load_aligned_i32(
            &mut ctx.builder.instruction_body,
            global_pointers::get_seg_offset(regs::SS),
        );
        wasm_util::add_i32(&mut ctx.builder.instruction_body);
    }

    // result = safe_read16(sp)
    gen_safe_read16(ctx);

    // reg16[SP] += 2;
    wasm_util::push_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg16_offset(regs::SP) as i32,
    );
    wasm_util::get_local(&mut ctx.builder.instruction_body, &sp_local);
    wasm_util::push_i32(&mut ctx.builder.instruction_body, 2);
    wasm_util::add_i32(&mut ctx.builder.instruction_body);
    wasm_util::store_aligned_i32(&mut ctx.builder.instruction_body);

    ctx.builder.free_local(sp_local);

    // return value is already on stack
}

pub fn gen_pop16_ss32(ctx: &mut JitContext) {
    let esp_local = ctx.builder.alloc_local();

    // esp = segment_offsets[SS] + reg32s[ESP] (or just reg32s[ESP] if has_flat_segmentation)
    wasm_util::load_aligned_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg32_offset(regs::ESP),
    );
    wasm_util::tee_local(&mut ctx.builder.instruction_body, &esp_local);

    if !ctx.cpu.has_flat_segmentation() {
        wasm_util::load_aligned_i32(
            &mut ctx.builder.instruction_body,
            global_pointers::get_seg_offset(regs::SS),
        );
        wasm_util::add_i32(&mut ctx.builder.instruction_body);
    }

    // result = safe_read16(esp)
    gen_safe_read16(ctx);

    // reg32s[ESP] += 2;
    wasm_util::push_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg32_offset(regs::ESP) as i32,
    );
    wasm_util::get_local(&mut ctx.builder.instruction_body, &esp_local);
    wasm_util::push_i32(&mut ctx.builder.instruction_body, 2);
    wasm_util::add_i32(&mut ctx.builder.instruction_body);
    wasm_util::store_aligned_i32(&mut ctx.builder.instruction_body);
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
    let local_sp = ctx.builder.alloc_local();

    // sp = reg16[SP]
    wasm_util::load_aligned_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg16_offset(regs::SP),
    );
    wasm_util::tee_local(&mut ctx.builder.instruction_body, &local_sp);

    // result = safe_read32s(segment_offsets[SS] + sp) (or just sp if has_flat_segmentation)
    if !ctx.cpu.has_flat_segmentation() {
        wasm_util::load_aligned_i32(
            &mut ctx.builder.instruction_body,
            global_pointers::get_seg_offset(regs::SS),
        );
        wasm_util::add_i32(&mut ctx.builder.instruction_body);
    }

    gen_safe_read32(ctx);

    // reg16[SP] = sp + 4;
    wasm_util::push_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg16_offset(regs::SP) as i32,
    );
    wasm_util::get_local(&mut ctx.builder.instruction_body, &local_sp);
    wasm_util::push_i32(&mut ctx.builder.instruction_body, 4);
    wasm_util::add_i32(&mut ctx.builder.instruction_body);
    wasm_util::store_aligned_i32(&mut ctx.builder.instruction_body);

    ctx.builder.free_local(local_sp);

    // return value is already on stack
}

pub fn gen_pop32s_ss32(ctx: &mut JitContext) {
    let local_esp = ctx.builder.alloc_local();

    // esp = reg32s[ESP]
    wasm_util::load_aligned_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg32_offset(regs::ESP),
    );
    wasm_util::tee_local(&mut ctx.builder.instruction_body, &local_esp);

    // result = safe_read32s(segment_offsets[SS] + esp) (or just esp if has_flat_segmentation)
    if !ctx.cpu.has_flat_segmentation() {
        wasm_util::load_aligned_i32(
            &mut ctx.builder.instruction_body,
            global_pointers::get_seg_offset(regs::SS),
        );
        wasm_util::add_i32(&mut ctx.builder.instruction_body);
    }
    gen_safe_read32(ctx);

    // reg32s[ESP] = esp + 4;
    wasm_util::push_i32(
        &mut ctx.builder.instruction_body,
        global_pointers::get_reg32_offset(regs::ESP) as i32,
    );
    wasm_util::get_local(&mut ctx.builder.instruction_body, &local_esp);
    wasm_util::push_i32(&mut ctx.builder.instruction_body, 4);
    wasm_util::add_i32(&mut ctx.builder.instruction_body);
    wasm_util::store_aligned_i32(&mut ctx.builder.instruction_body);

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

    wasm_util::load_aligned_i32(&mut ctx.builder.instruction_body, cr0_offset);
    wasm_util::push_i32(
        &mut ctx.builder.instruction_body,
        (regs::CR0_EM | regs::CR0_TS) as i32,
    );
    wasm_util::and_i32(&mut ctx.builder.instruction_body);

    wasm_util::if_void(&mut ctx.builder.instruction_body);

    gen_fn0_const(ctx, "task_switch_test_void");
    wasm_util::return_(&mut ctx.builder.instruction_body);

    wasm_util::block_end(&mut ctx.builder.instruction_body);
}

pub fn gen_task_switch_test_mmx(ctx: &mut JitContext) {
    // generate if(cr[0] & (CR0_EM | CR0_TS)) { task_switch_test_mmx_void(); return; }
    let cr0_offset = global_pointers::get_creg_offset(0);

    wasm_util::load_aligned_i32(&mut ctx.builder.instruction_body, cr0_offset);
    wasm_util::push_i32(
        &mut ctx.builder.instruction_body,
        (regs::CR0_EM | regs::CR0_TS) as i32,
    );
    wasm_util::and_i32(&mut ctx.builder.instruction_body);

    wasm_util::if_void(&mut ctx.builder.instruction_body);

    gen_fn0_const(ctx, "task_switch_test_mmx_void");
    wasm_util::return_(&mut ctx.builder.instruction_body);

    wasm_util::block_end(&mut ctx.builder.instruction_body);
}
