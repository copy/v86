use ::util::PackedStr;

pub use ::module_init::{ setup, get_module };

#[no_mangle]
pub fn get_cs() -> *mut Vec<u8> {
    &mut get_module().cs
}

#[no_mangle]
pub fn get_instruction_body() -> *mut Vec<u8> {
    &mut get_module().instruction_body
}

#[no_mangle]
pub fn reset() {
    let m = get_module();
    m.reset();
}

#[no_mangle]
pub fn finish(no_of_locals_i32: u8) {
    let m = get_module();
    m.finish(no_of_locals_i32);
}

#[no_mangle]
pub fn get_fn_idx(fn_name: PackedStr, type_idx: u8) -> u16 {
    let m = get_module();
    m.get_fn_index(fn_name, type_idx)
}

#[no_mangle]
pub fn get_op_ptr() -> *const u8 {
    let m = get_module();
    m.get_op_ptr()
}

#[no_mangle]
pub fn get_op_len() -> usize {
    let m = get_module();
    m.get_op_len()
}

#[no_mangle]
pub fn commit_instruction_body_to_cs() {
    let m = get_module();
    m.commit_instruction_body_cs();
}

#[cfg(test)]
mod tests {
    use std::io::prelude::*;
    use std::fs::File;
    use ::codegen::*;
    use ::c_api::*;
    use ::util::*;
    use ::wasm_util::*;

    #[test]
    fn c_api_test() {
        setup();
        let cs = &mut get_module().cs;
        let instruction_body = &mut get_module().instruction_body;

        wg_fn0_const_ret(cs, pack_str("foo"));
        wg_fn0_const_ret(cs, pack_str("bar"));

        finish(2);
        reset();

        wg_push_i32(cs, 2);
        wg_call_fn1_ret(instruction_body, pack_str("baz"));
        wg_drop(instruction_body);

        commit_instruction_body_to_cs();

        finish(1);

        let op_ptr = get_op_ptr();
        let op_len = get_op_len();
        dbg_log!("op_ptr: {:?}, op_len: {:?}", op_ptr, op_len);

        // XXX: move file path
        let mut f = File::create("c_api_test.wasm").expect("creating c_api_test.wasm");
        f.write_all(&get_module().op).expect("write c_api_test.wasm");
    }

}
