use ::util::*;
use ::wasm_util::*;
use ::module_init::*;

// for functions using the global module singleton

#[no_mangle]
pub fn wg_fn0_const(buf: &mut Vec<u8>, fn_name: PackedStr) {
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN0_TYPE_INDEX);
    wg_call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn wg_fn0_const_ret(buf: &mut Vec<u8>, fn_name: PackedStr) {
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN0_RET_TYPE_INDEX);
    wg_call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn wg_fn1_const(buf: &mut Vec<u8>, fn_name: PackedStr, arg0: i32) {
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN1_TYPE_INDEX);
    wg_push_i32(buf, arg0);
    wg_call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn wg_fn1_const_ret(buf: &mut Vec<u8>, fn_name: PackedStr, arg0: i32) {
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN1_RET_TYPE_INDEX);
    wg_push_i32(buf, arg0);
    wg_call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn wg_fn2_const(buf: &mut Vec<u8>, fn_name: PackedStr, arg0: i32, arg1: i32) {
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN2_TYPE_INDEX);
    wg_push_i32(buf, arg0);
    wg_push_i32(buf, arg1);
    wg_call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn wg_fn3_const(buf: &mut Vec<u8>, fn_name: PackedStr, arg0: i32, arg1: i32, arg2: i32) {
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN3_TYPE_INDEX);
    wg_push_i32(buf, arg0);
    wg_push_i32(buf, arg1);
    wg_push_i32(buf, arg2);
    wg_call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn wg_call_fn1_ret(buf: &mut Vec<u8>, fn_name: PackedStr) {
    // generates: fn( _ ) where _ must be left on the stack before calling this, and fn returns a value
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN1_RET_TYPE_INDEX);
    wg_call_fn(buf, fn_idx);
}

#[no_mangle]
pub fn wg_call_fn2(buf: &mut Vec<u8>, fn_name: PackedStr) {
    // generates: fn( _, _ ) where _, _ must be left on the stack before calling this
    let m = get_module();
    let fn_idx = m.get_fn_index(fn_name, FN2_TYPE_INDEX);
    wg_call_fn(buf, fn_idx);
}
