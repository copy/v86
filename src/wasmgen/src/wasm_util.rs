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
    buf.push(MEM_IMM_OFFSET);
}

#[no_mangle]
pub fn load_aligned_i32(buf: &mut Vec<u8>, addr: u32) {
    // doesn't cause a failure in the generated code, but it will be much slower
    dbg_assert!((addr & 3) == 0);

    buf.push(OP_I32CONST);
    write_leb_u32(buf, addr);
    buf.push(OP_I32LOAD);
    buf.push(MEM_ALIGN32);
    buf.push(MEM_IMM_OFFSET);
}

#[no_mangle]
pub fn store_aligned_u16(buf: &mut Vec<u8>) {
    buf.push(OP_I32STORE16);
    buf.push(MEM_ALIGN16);
    buf.push(MEM_IMM_OFFSET);
}

#[no_mangle]
pub fn store_aligned_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32STORE);
    buf.push(MEM_ALIGN32);
    buf.push(MEM_IMM_OFFSET);
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
pub fn call_fn(buf: &mut Vec<u8>, fn_idx: u8) {
    buf.push(OP_CALL);
    buf.push(fn_idx);
}

#[no_mangle]
pub fn call_fn_with_arg(buf: &mut Vec<u8>, fn_idx: u8, arg0: i32) {
    push_i32(buf, arg0);
    call_fn(buf, fn_idx);
}
