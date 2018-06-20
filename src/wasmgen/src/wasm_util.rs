use ::wasm_opcodes::*;
use ::util::*;

#[no_mangle]
pub fn push_i32(buf: &mut Vec<u8>, v: i32) {
    buf.push(OP_I32CONST);
    write_leb_i32(buf, v);
}

#[no_mangle]
pub fn push_u32(buf: &mut Vec<u8>, v: u32) {
    buf.push(OP_I32CONST);
    write_leb_u32(buf, v);
}

#[no_mangle]
pub fn load_aligned_u16(buf: &mut Vec<u8>, addr: u32) {
    // doesn't cause a failure in the generated code, but it will be much slower
    dbg_assert!((addr & 1) == 0);

    buf.push(OP_I32CONST);
    write_leb_u32(buf, addr);
    buf.push(OP_I32LOAD16U);
    buf.push(MEM_ALIGN16);
    buf.push(0); // immediate offset
}

#[no_mangle]
pub fn load_aligned_i32(buf: &mut Vec<u8>, addr: u32) {
    // doesn't cause a failure in the generated code, but it will be much slower
    dbg_assert!((addr & 3) == 0);

    push_i32(buf, addr as i32);
    load_aligned_i32_from_stack(buf, 0);
}

#[no_mangle]
pub fn store_aligned_u16(buf: &mut Vec<u8>) {
    buf.push(OP_I32STORE16);
    buf.push(MEM_ALIGN16);
    buf.push(0); // immediate offset
}

#[no_mangle]
pub fn store_aligned_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32STORE);
    buf.push(MEM_ALIGN32);
    buf.push(0); // immediate offset
}

#[no_mangle]
pub fn add_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32ADD);
}

#[no_mangle]
pub fn and_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32AND);
}

#[no_mangle]
pub fn or_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32OR);
}

#[no_mangle]
pub fn shl_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32SHL);
}

#[no_mangle]
pub fn call_fn(buf: &mut Vec<u8>, fn_idx: u16) {
    buf.push(OP_CALL);
    let buf_len = buf.len();
    buf.push(0); buf.push(0);
    write_fixed_leb16_at_idx(buf, buf_len, fn_idx);
}

#[no_mangle]
pub fn call_fn_with_arg(buf: &mut Vec<u8>, fn_idx: u16, arg0: i32) {
    push_i32(buf, arg0);
    call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn eq_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32EQ);
}

#[no_mangle]
pub fn ne_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32NE);
}

#[no_mangle]
pub fn le_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32LES);
}

#[no_mangle]
pub fn lt_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32LTS);
}

#[no_mangle]
pub fn ge_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32GES);
}

#[no_mangle]
pub fn gt_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32GTS);
}

#[no_mangle]
pub fn if_i32(buf: &mut Vec<u8>) {
    buf.push(OP_IF);
    buf.push(TYPE_I32);
}

#[no_mangle]
pub fn block_i32(buf: &mut Vec<u8>) {
    buf.push(OP_BLOCK);
    buf.push(TYPE_I32);
}

#[no_mangle]
pub fn tee_local(buf: &mut Vec<u8>, idx: i32) {
    buf.push(OP_TEELOCAL);
    write_leb_i32(buf, idx);
}

#[no_mangle]
pub fn xor_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32XOR);
}

#[no_mangle]
pub fn load_unaligned_i32_from_stack(buf: &mut Vec<u8>, byte_offset: u32) {
    buf.push(OP_I32LOAD);
    buf.push(MEM_NO_ALIGN);
    write_leb_u32(buf, byte_offset);
}

#[no_mangle]
pub fn load_aligned_i32_from_stack(buf: &mut Vec<u8>, byte_offset: u32) {
    buf.push(OP_I32LOAD);
    buf.push(MEM_ALIGN32);
    write_leb_u32(buf, byte_offset);
}

// XXX: Function naming should be consistent regarding both alignment and accepting an
// offset. Leaving as-is for the Rust port to cleanup
#[no_mangle]
pub fn store_unaligned_i32(buf: &mut Vec<u8>, byte_offset: u32) {
    buf.push(OP_I32STORE);
    buf.push(MEM_NO_ALIGN);
    write_leb_u32(buf, byte_offset);
}

#[no_mangle]
pub fn shr_u32(buf: &mut Vec<u8>) {
    buf.push(OP_I32SHRU);
}

#[no_mangle]
pub fn shr_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32SHRS);
}
