use leb::{write_fixed_leb16_at_idx, write_leb_i32, write_leb_u32};
use wasmgen::module_init::WasmLocal;
use wasmgen::wasm_opcodes as op;

pub fn push_i32(buf: &mut Vec<u8>, v: i32) {
    buf.push(op::OP_I32CONST);
    write_leb_i32(buf, v);
}

pub fn load_aligned_u16(buf: &mut Vec<u8>, addr: u32) {
    // doesn't cause a failure in the generated code, but it will be much slower
    dbg_assert!((addr & 1) == 0);

    buf.push(op::OP_I32CONST);
    write_leb_u32(buf, addr);
    buf.push(op::OP_I32LOAD16U);
    buf.push(op::MEM_ALIGN16);
    buf.push(0); // immediate offset
}

pub fn load_aligned_i32(buf: &mut Vec<u8>, addr: u32) {
    // doesn't cause a failure in the generated code, but it will be much slower
    dbg_assert!((addr & 3) == 0);

    push_i32(buf, addr as i32);
    load_aligned_i32_from_stack(buf, 0);
}

pub fn store_aligned_u16(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32STORE16);
    buf.push(op::MEM_ALIGN16);
    buf.push(0); // immediate offset
}

pub fn store_aligned_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_I32STORE);
    buf.push(op::MEM_ALIGN32);
    buf.push(0); // immediate offset
}

pub fn add_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32ADD); }
pub fn sub_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32SUB); }

pub fn and_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32AND); }

pub fn or_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32OR); }

pub fn shl_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32SHL); }

pub fn call_fn(buf: &mut Vec<u8>, fn_idx: u16) {
    buf.push(op::OP_CALL);
    let buf_len = buf.len();
    buf.push(0);
    buf.push(0);
    write_fixed_leb16_at_idx(buf, buf_len, fn_idx);
}

pub fn eq_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32EQ); }

pub fn ne_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32NE); }

pub fn le_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32LES); }

pub fn lt_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32LTS); }

pub fn ge_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32GES); }

pub fn gt_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32GTS); }

pub fn if_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_IF);
    buf.push(op::TYPE_I32);
}

pub fn block_i32(buf: &mut Vec<u8>) {
    buf.push(op::OP_BLOCK);
    buf.push(op::TYPE_I32);
}

pub fn xor_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32XOR); }

pub fn load_unaligned_i32_from_stack(buf: &mut Vec<u8>, byte_offset: u32) {
    buf.push(op::OP_I32LOAD);
    buf.push(op::MEM_NO_ALIGN);
    write_leb_u32(buf, byte_offset);
}

pub fn load_aligned_i32_from_stack(buf: &mut Vec<u8>, byte_offset: u32) {
    buf.push(op::OP_I32LOAD);
    buf.push(op::MEM_ALIGN32);
    write_leb_u32(buf, byte_offset);
}

// XXX: Function naming should be consistent regarding both alignment and accepting an
// offset. Leaving as-is for the Rust port to cleanup
pub fn store_unaligned_i32(buf: &mut Vec<u8>, byte_offset: u32) {
    buf.push(op::OP_I32STORE);
    buf.push(op::MEM_NO_ALIGN);
    write_leb_u32(buf, byte_offset);
}

pub fn shr_u32(buf: &mut Vec<u8>) { buf.push(op::OP_I32SHRU); }

pub fn shr_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32SHRS); }

pub fn eqz_i32(buf: &mut Vec<u8>) { buf.push(op::OP_I32EQZ); }

pub fn if_void(buf: &mut Vec<u8>) {
    buf.push(op::OP_IF);
    buf.push(op::TYPE_VOID_BLOCK);
}

pub fn else_(buf: &mut Vec<u8>) { buf.push(op::OP_ELSE); }

pub fn loop_void(buf: &mut Vec<u8>) {
    buf.push(op::OP_LOOP);
    buf.push(op::TYPE_VOID_BLOCK);
}

pub fn block_void(buf: &mut Vec<u8>) {
    buf.push(op::OP_BLOCK);
    buf.push(op::TYPE_VOID_BLOCK);
}

pub fn block_end(buf: &mut Vec<u8>) { buf.push(op::OP_END); }

pub fn return_(buf: &mut Vec<u8>) { buf.push(op::OP_RETURN); }

pub fn drop(buf: &mut Vec<u8>) { buf.push(op::OP_DROP); }

// Generate a br_table where an input of [i] will branch [i]th outer block,
// where [i] is passed on the wasm stack
pub fn brtable_and_cases(buf: &mut Vec<u8>, cases_count: u32) {
    buf.push(op::OP_BRTABLE);
    write_leb_u32(buf, cases_count);

    for i in 0..(cases_count + 1) {
        write_leb_u32(buf, i);
    }
}

pub fn br(buf: &mut Vec<u8>, depth: u32) {
    buf.push(op::OP_BR);
    write_leb_u32(buf, depth);
}

pub fn get_local(buf: &mut Vec<u8>, local: &WasmLocal) {
    buf.push(op::OP_GETLOCAL);
    buf.push(local.idx());
}

pub fn set_local(buf: &mut Vec<u8>, local: &WasmLocal) {
    buf.push(op::OP_SETLOCAL);
    buf.push(local.idx());
}

pub fn tee_local(buf: &mut Vec<u8>, local: &WasmLocal) {
    buf.push(op::OP_TEELOCAL);
    buf.push(local.idx());
}

pub fn unreachable(buf: &mut Vec<u8>) { buf.push(op::OP_UNREACHABLE); }

pub fn increment_mem32(buf: &mut Vec<u8>, addr: u32) { increment_variable(buf, addr, 1) }

pub fn increment_variable(buf: &mut Vec<u8>, addr: u32, n: i32) {
    push_i32(buf, addr as i32);
    load_aligned_i32(buf, addr);
    push_i32(buf, n);
    add_i32(buf);
    store_aligned_i32(buf);
}

pub fn load_aligned_u16_from_stack(buf: &mut Vec<u8>, byte_offset: u32) {
    buf.push(op::OP_I32LOAD16U);
    buf.push(op::MEM_ALIGN16);
    write_leb_u32(buf, byte_offset);
}
