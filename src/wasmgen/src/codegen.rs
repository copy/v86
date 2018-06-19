use ::wasm_opcodes::*;
use ::util::*;
use ::wasm_util::*;
use ::module_init::*;

#[no_mangle]
pub fn gen_fn0_const(buf: &mut Vec<u8>, fn_name: PackedStr) {
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN0_TYPE_INDEX);
    call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn gen_fn0_const_ret(buf: &mut Vec<u8>, fn_name: PackedStr) {
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN0_RET_TYPE_INDEX);
    call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn gen_fn1_const(buf: &mut Vec<u8>, fn_name: PackedStr, arg0: i32) {
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN1_TYPE_INDEX);
    push_i32(buf, arg0);
    call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn gen_fn1_const_ret(buf: &mut Vec<u8>, fn_name: PackedStr, arg0: i32) {
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN1_RET_TYPE_INDEX);
    push_i32(buf, arg0);
    call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn gen_fn2_const(buf: &mut Vec<u8>, fn_name: PackedStr, arg0: i32, arg1: i32) {
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN2_TYPE_INDEX);
    push_i32(buf, arg0);
    push_i32(buf, arg1);
    call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn gen_fn3_const(buf: &mut Vec<u8>, fn_name: PackedStr, arg0: i32, arg1: i32, arg2: i32) {
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN3_TYPE_INDEX);
    push_i32(buf, arg0);
    push_i32(buf, arg1);
    push_i32(buf, arg2);
    call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn gen_call_fn1_ret(buf: &mut Vec<u8>, fn_name: PackedStr) {
    // generates: fn( _ ) where _ must be left on the stack before calling this, and fn returns a value
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN1_RET_TYPE_INDEX);
    call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn gen_call_fn2(buf: &mut Vec<u8>, fn_name: PackedStr) {
    // generates: fn( _, _ ) where _, _ must be left on the stack before calling this
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN2_TYPE_INDEX);
    call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn gen_eqz_i32(buf: &mut Vec<u8>) {
    buf.push(OP_I32EQZ);
}

#[no_mangle]
pub fn gen_if_void(buf: &mut Vec<u8>) {
    buf.push(OP_IF);
    buf.push(TYPE_VOID_BLOCK);
}

#[no_mangle]
pub fn gen_else(buf: &mut Vec<u8>) {
    buf.push(OP_ELSE);
}

#[no_mangle]
pub fn gen_loop_void(buf: &mut Vec<u8>) {
    buf.push(OP_LOOP);
    buf.push(TYPE_VOID_BLOCK);
}

#[no_mangle]
pub fn gen_block_void(buf: &mut Vec<u8>) {
    buf.push(OP_BLOCK);
    buf.push(TYPE_VOID_BLOCK);
}

#[no_mangle]
pub fn gen_block_end(buf: &mut Vec<u8>) {
    buf.push(OP_END);
}

#[no_mangle]
pub fn gen_return(buf: &mut Vec<u8>) {
    buf.push(OP_RETURN);
}

#[no_mangle]
pub fn gen_drop(buf: &mut Vec<u8>) {
    buf.push(OP_DROP);
}

// Generate a br_table where an input of [i] will branch [i]th outer block,
// where [i] is passed on the wasm stack
#[no_mangle]
pub fn gen_brtable_and_cases(buf: &mut Vec<u8>, cases_count: i32) {
    assert!(cases_count >= 0);

    buf.push(OP_BRTABLE);
    write_leb_u32(buf, cases_count as u32);

    for i in 0..(cases_count + 1) {
        write_leb_u32(buf, i as u32);
    }
}

#[no_mangle]
pub fn gen_br(buf: &mut Vec<u8>, depth: i32) {
    buf.push(OP_BR);
    write_leb_i32(buf, depth);
}

#[no_mangle]
pub fn gen_get_local(buf: &mut Vec<u8>, idx: i32) {
    buf.push(OP_GETLOCAL);
    write_leb_i32(buf, idx);
}

#[no_mangle]
pub fn gen_set_local(buf: &mut Vec<u8>, idx: i32) {
    buf.push(OP_SETLOCAL);
    write_leb_i32(buf, idx);
}

#[no_mangle]
pub fn gen_const_i32(buf: &mut Vec<u8>, v: i32) {
    push_i32(buf, v);
}

#[no_mangle]
pub fn gen_unreachable(buf: &mut Vec<u8>) {
    buf.push(OP_UNREACHABLE);
}

#[no_mangle]
pub fn gen_increment_mem32(buf: &mut Vec<u8>, addr: u32) {
    push_i32(buf, addr as i32);
    load_aligned_i32(buf, addr);
    push_i32(buf, 1);
    add_i32(buf);
    store_aligned_i32(buf);
}

#[no_mangle]
pub fn gen_increment_variable(buf: &mut Vec<u8>, variable_address: u32, n: i32) {
    push_i32(buf, variable_address as i32);
    load_aligned_i32(buf, variable_address as u32);
    push_i32(buf, n);
    add_i32(buf);
    store_aligned_i32(buf);
}
