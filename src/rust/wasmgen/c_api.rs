use util::PackedStr;

pub use wasmgen::module_init::wg_setup;
use wasmgen::module_init::get_module;

#[no_mangle]
pub fn wg_get_code_section() -> *mut Vec<u8> {
    &mut get_module().code_section
}

#[no_mangle]
pub fn wg_get_instruction_body() -> *mut Vec<u8> {
    &mut get_module().instruction_body
}

#[no_mangle]
pub fn wg_reset() {
    let m = get_module();
    m.reset();
}

#[no_mangle]
pub fn wg_finish(no_of_locals_i32: u8) {
    let m = get_module();
    m.finish(no_of_locals_i32);
}

#[no_mangle]
pub fn wg_get_fn_idx(fn_name_a: u64, fn_name_b: u64, fn_name_c: u64, type_idx: u8) -> u16 {
    let fn_name: PackedStr = (fn_name_a, fn_name_b, fn_name_c);
    let m = get_module();
    m.get_fn_idx(fn_name, type_idx)
}

#[no_mangle]
pub fn wg_get_op_ptr() -> *const u8 {
    let m = get_module();
    m.get_op_ptr()
}

#[no_mangle]
pub fn wg_get_op_len() -> usize {
    let m = get_module();
    m.get_op_len()
}

#[no_mangle]
pub fn wg_commit_instruction_body_to_cs() {
    let m = get_module();
    m.commit_instruction_body_cs();
}

#[cfg(test)]
mod tests {
    use std::io::prelude::*;
    use std::fs::File;
    use util::*;
    use wasmgen::c_api::*;
    use wasmgen::wasm_util::*;
    use wasmgen::module_init::*;

    #[test]
    fn c_api_test() {
        wg_setup();
        let m = get_module();
        let cs = &mut get_module().code_section;
        let instruction_body = &mut get_module().instruction_body;

        wg_call_fn(cs, m.get_fn_idx(pack_str("foo"), FN0_TYPE_INDEX));
        wg_call_fn(cs, m.get_fn_idx(pack_str("bar"), FN0_TYPE_INDEX));

        wg_finish(2);
        wg_reset();

        wg_push_i32(cs, 2);
        wg_call_fn(instruction_body, m.get_fn_idx(pack_str("baz"), FN1_RET_TYPE_INDEX));
        wg_call_fn(instruction_body, m.get_fn_idx(pack_str("foo"), FN1_TYPE_INDEX));

        wg_commit_instruction_body_to_cs();

        wg_finish(0);

        let op_ptr = wg_get_op_ptr();
        let op_len = wg_get_op_len();
        dbg_log!("op_ptr: {:?}, op_len: {:?}", op_ptr, op_len);

        let mut f = File::create("build/wg_dummy_output.wasm").expect("creating wg_dummy_output.wasm");
        f.write_all(&get_module().output).expect("write wg_dummy_output.wasm");
    }

}
