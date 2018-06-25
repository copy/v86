use ::wasm_opcodes as op;
use ::util::{ write_fixed_leb16_at_idx, write_leb_i32, write_leb_u32 };

#[no_mangle]
pub fn wg_push_i32(buf: &mut Vec<u8>, v: i32) {
    buf.push(op::OP_I32CONST);
    write_leb_i32(buf, v);
}

#[no_mangle]
pub fn wg_push_u32(buf: &mut Vec<u8>, v: u32) {
    buf.push(op::OP_I32CONST);
    write_leb_u32(buf, v);
}

#[no_mangle]
pub fn wg_load_aligned_u16(buf: &mut Vec<u8>, addr: u32) {
    // doesn't cause a failure in the generated code, but it will be much slower
    dbg_assert!((addr & 1) == 0);

    buf.push(op::OP_I32CONST);
    write_leb_u32(buf, addr);
    buf.push(op::OP_I32LOAD16U);
    buf.push(op::MEM_ALIGN16);
    buf.push(0); // immediate offset
}

#[no_mangle]
pub fn wg_load_aligned_i32(buf: &mut Vec<u8>, addr: u32) {
    // doesn't cause a failure in the generated code, but it will be much slower
    dbg_assert!((addr & 3) == 0);

    wg_push_i32(buf, addr as i32);
    wg_load_aligned_i32_from_stack(buf, 0);
}

#[no_mangle]
pub fn wg_store_aligned_u16(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32STORE16);
    buf.push(op::MEM_ALIGN16);
    buf.push(0); // immediate offset
}

#[no_mangle]
pub fn wg_store_aligned_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32STORE);
    buf.push(op::MEM_ALIGN32);
    buf.push(0); // immediate offset
}

#[no_mangle]
pub fn wg_add_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32ADD);
}

#[no_mangle]
pub fn wg_and_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32AND);
}

#[no_mangle]
pub fn wg_or_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32OR);
}

#[no_mangle]
pub fn wg_shl_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32SHL);
}

#[no_mangle]
pub fn wg_call_fn(buf: &mut Vec<u8>, fn_idx: u16) {
    buf.push(op::OP_CALL);
    let buf_len = buf.len();
    buf.push(0); buf.push(0);
    write_fixed_leb16_at_idx(buf, buf_len, fn_idx);
}

#[no_mangle]
pub fn wg_call_fn_with_arg(buf: &mut Vec<u8>, fn_idx: u16, arg0: i32) {
    wg_push_i32(buf, arg0);
    wg_call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn wg_eq_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32EQ);
}

#[no_mangle]
pub fn wg_ne_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32NE);
}

#[no_mangle]
pub fn wg_le_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32LES);
}

#[no_mangle]
pub fn wg_lt_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32LTS);
}

#[no_mangle]
pub fn wg_ge_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32GES);
}

#[no_mangle]
pub fn wg_gt_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32GTS);
}

#[no_mangle]
pub fn wg_if_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_IF);
    buf.push(op::TYPE_I32);
}

#[no_mangle]
pub fn wg_block_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_BLOCK);
    buf.push(op::TYPE_I32);
}

#[no_mangle]
pub fn wg_tee_local(buf: &mut Vec<u8>, idx: i32) {
    buf.push(op::OP_TEELOCAL);
    write_leb_i32(buf, idx);
}

#[no_mangle]
pub fn wg_xor_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32XOR);
}

#[no_mangle]
pub fn wg_load_unaligned_i32_from_stack(buf: &mut Vec<u8>, byte_offset: u32) {
    buf.push(op::OP_I32LOAD);
    buf.push(op::MEM_NO_ALIGN);
    write_leb_u32(buf, byte_offset);
}

#[no_mangle]
pub fn wg_load_aligned_i32_from_stack(buf: &mut Vec<u8>, byte_offset: u32) {
    buf.push(op::OP_I32LOAD);
    buf.push(op::MEM_ALIGN32);
    write_leb_u32(buf, byte_offset);
}

// XXX: Function naming should be consistent regarding both alignment and accepting an
// offset. Leaving as-is for the Rust port to cleanup
#[no_mangle]
pub fn wg_store_unaligned_i32(buf: &mut Vec<u8>, byte_offset: u32) {
    buf.push(op::OP_I32STORE);
    buf.push(op::MEM_NO_ALIGN);
    write_leb_u32(buf, byte_offset);
}

#[no_mangle]
pub fn wg_shr_u32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32SHRU);
}

#[no_mangle]
pub fn wg_shr_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32SHRS);
}

#[no_mangle]
pub fn wg_eqz_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32EQZ);
}

#[no_mangle]
pub fn wg_if_void(buf: &mut Vec<u8>) {
    buf.push(op::OP_IF);
    buf.push(op::TYPE_VOID_BLOCK);
}

#[no_mangle]
pub fn wg_else(buf: &mut Vec<u8>) {
    buf.push(op::OP_ELSE);
}

#[no_mangle]
pub fn wg_loop_void(buf: &mut Vec<u8>) {
    buf.push(op::OP_LOOP);
    buf.push(op::TYPE_VOID_BLOCK);
}

#[no_mangle]
pub fn wg_block_void(buf: &mut Vec<u8>) {
    buf.push(op::OP_BLOCK);
    buf.push(op::TYPE_VOID_BLOCK);
}

#[no_mangle]
pub fn wg_block_end(buf: &mut Vec<u8>) {
    buf.push(op::OP_END);
}

#[no_mangle]
pub fn wg_return(buf: &mut Vec<u8>) {
    buf.push(op::OP_RETURN);
}

#[no_mangle]
pub fn wg_drop(buf: &mut Vec<u8>) {
    buf.push(op::OP_DROP);
}

// Generate a br_table where an input of [i] will branch [i]th outer block,
// where [i] is passed on the wasm stack
#[no_mangle]
pub fn wg_brtable_and_cases(buf: &mut Vec<u8>, cases_count: i32) {
    assert!(cases_count >= 0);

    buf.push(op::OP_BRTABLE);
    write_leb_u32(buf, cases_count as u32);

    for i in 0..(cases_count + 1) {
        write_leb_u32(buf, i as u32);
    }
}

#[no_mangle]
pub fn wg_br(buf: &mut Vec<u8>, depth: i32) {
    buf.push(op::OP_BR);
    write_leb_i32(buf, depth);
}

#[no_mangle]
pub fn wg_get_local(buf: &mut Vec<u8>, idx: i32) {
    buf.push(op::OP_GETLOCAL);
    write_leb_i32(buf, idx);
}

#[no_mangle]
pub fn wg_set_local(buf: &mut Vec<u8>, idx: i32) {
    buf.push(op::OP_SETLOCAL);
    write_leb_i32(buf, idx);
}

#[no_mangle]
pub fn wg_unreachable(buf: &mut Vec<u8>) {
    buf.push(op::OP_UNREACHABLE);
}

#[no_mangle]
pub fn wg_increment_mem32(buf: &mut Vec<u8>, addr: i32) {
    wg_increment_variable(buf, addr, 1)
}

#[no_mangle]
pub fn wg_increment_variable(buf: &mut Vec<u8>, addr: i32, n: i32) {
    wg_push_i32(buf, addr);
    wg_load_aligned_i32(buf, addr as u32);
    wg_push_i32(buf, n);
    wg_add_i32(buf);
    wg_store_aligned_i32(buf);
}

#[no_mangle]
pub fn wg_load_aligned_u16_from_stack(buf: &mut Vec<u8>, byte_offset: u32) {
    buf.push(op::OP_I32LOAD16U);
    buf.push(op::MEM_ALIGN16);
    write_leb_u32(buf, byte_offset);
}
