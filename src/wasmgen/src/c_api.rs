use ::util::PackedStr;

pub use ::module_init::{ setup, get_module };

#[no_mangle]
pub fn new_buf() -> *mut Vec<u8> {
    let b = Box::new(Vec::with_capacity(256));
    Box::into_raw(b)
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
pub fn include_buffer(buf: *mut Vec<u8>) {
    let m = get_module();
    m.include_buffer(buf);
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
        let buf1 = unsafe { new_buf().as_mut().expect("get buf1") };
        let buf2 = unsafe { new_buf().as_mut().expect("get buf2") };

        gen_fn0_const_ret(buf1, pack_str("foo"));
        gen_fn0_const_ret(buf1, pack_str("bar"));

        include_buffer(buf1);

        finish(2);
        reset();

        push_i32(buf1, 2);
        gen_call_fn1_ret(buf2, pack_str("baz"));
        gen_drop(buf2);

        include_buffer(buf1);
        include_buffer(buf2);

        finish(1);

        let op_ptr = get_op_ptr();
        let op_len = get_op_len();
        dbg_log!("op_ptr: {:?}, op_len: {:?}", op_ptr, op_len);

        // XXX: move file path
        let mut f = File::create("c_api_test.wasm").expect("creating c_api_test.wasm");
        f.write_all(&get_module().op).expect("write c_api_test.wasm");
    }

}
