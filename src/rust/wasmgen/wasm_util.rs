use leb::{write_fixed_leb16_at_idx, write_fixed_leb32_at_idx, write_leb_i32, write_leb_u32};
use wasmgen::module_init::WasmLocal;
use wasmgen::wasm_opcodes as op;

pub trait WasmBuf {
    fn write_leb_i32(&mut self, v: i32);
    fn write_leb_u32(&mut self, v: u32);
    fn write_fixed_leb16_at_idx(&mut self, idx: usize, x: u16);
    fn write_fixed_leb32_at_idx(&mut self, idx: usize, x: u32);
    fn push_i32(&mut self, v: i32);
    fn load_aligned_u16(&mut self, addr: u32);
    fn load_aligned_i32(&mut self, addr: u32);
    fn store_aligned_u16(&mut self);
    fn store_aligned_i32(&mut self);
    fn add_i32(&mut self);
    fn sub_i32(&mut self);
    fn and_i32(&mut self);
    fn or_i32(&mut self);
    fn shl_i32(&mut self);
    fn call_fn(&mut self, fn_idx: u16);
    fn eq_i32(&mut self);
    fn ne_i32(&mut self);
    fn le_i32(&mut self);
    fn lt_i32(&mut self);
    fn ge_i32(&mut self);
    fn gt_i32(&mut self);
    fn if_i32(&mut self);
    fn block_i32(&mut self);
    fn xor_i32(&mut self);
    fn load_unaligned_i32_from_stack(&mut self, byte_offset: u32);
    fn load_unaligned_u16_from_stack(&mut self, byte_offset: u32);
    fn load_aligned_i32_from_stack(&mut self, byte_offset: u32);
    fn load_u8(&mut self, addr: u32);
    fn load_u8_from_stack(&mut self, byte_offset: u32);
    fn store_unaligned_i32(&mut self, byte_offset: u32);
    fn store_unaligned_u16(&mut self, byte_offset: u32);
    fn store_u8(&mut self, byte_offset: u32);
    fn shr_u32(&mut self);
    fn shr_i32(&mut self);
    fn eqz_i32(&mut self);
    fn if_void(&mut self);
    fn else_(&mut self);
    fn loop_void(&mut self);
    fn block_void(&mut self);
    fn block_end(&mut self);
    fn return_(&mut self);
    fn drop(&mut self);
    fn brtable_and_cases(&mut self, cases_count: u32);
    fn br(&mut self, depth: u32);
    fn get_local(&mut self, local: &WasmLocal);
    fn set_local(&mut self, local: &WasmLocal);
    fn tee_local(&mut self, local: &WasmLocal);
    fn unreachable(&mut self);
    fn increment_mem32(&mut self, addr: u32);
    fn increment_variable(&mut self, addr: u32, n: i32);
    fn load_aligned_u16_from_stack(&mut self, byte_offset: u32);
}

impl WasmBuf for Vec<u8> {
    fn write_leb_i32(&mut self, v: i32) { write_leb_i32(self, v) }

    fn write_leb_u32(&mut self, v: u32) { write_leb_u32(self, v) }

    fn write_fixed_leb16_at_idx(&mut self, idx: usize, x: u16) {
        write_fixed_leb16_at_idx(self, idx, x)
    }

    fn write_fixed_leb32_at_idx(&mut self, idx: usize, x: u32) {
        write_fixed_leb32_at_idx(self, idx, x)
    }

    fn push_i32(&mut self, v: i32) {
        self.push(op::OP_I32CONST);
        self.write_leb_i32(v);
    }

    fn load_aligned_u16(&mut self, addr: u32) {
        // doesn't cause a failure in the generated code, but it will be much slower
        dbg_assert!((addr & 1) == 0);

        self.push(op::OP_I32CONST);
        self.write_leb_u32(addr);
        self.push(op::OP_I32LOAD16U);
        self.push(op::MEM_ALIGN16);
        self.push(0); // immediate offset
    }

    fn load_aligned_i32(&mut self, addr: u32) {
        // doesn't cause a failure in the generated code, but it will be much slower
        dbg_assert!((addr & 3) == 0);

        self.push_i32(addr as i32);
        self.load_aligned_i32_from_stack(0);
    }

    fn load_u8_from_stack(&mut self, byte_offset: u32) {
        self.push(op::OP_I32LOAD8U);
        self.push(op::MEM_NO_ALIGN);
        self.write_leb_u32(byte_offset);
    }

    fn load_u8(&mut self, addr: u32) {
        self.push_i32(addr as i32);
        self.load_u8_from_stack(0);
    }

    fn store_aligned_u16(&mut self) {
        self.push(op::OP_I32STORE16);
        self.push(op::MEM_ALIGN16);
        self.push(0); // immediate offset
    }

    fn store_aligned_i32(&mut self) {
        self.push(op::OP_I32STORE);
        self.push(op::MEM_ALIGN32);
        self.push(0); // immediate offset
    }

    fn add_i32(&mut self) { self.push(op::OP_I32ADD); }
    fn sub_i32(&mut self) { self.push(op::OP_I32SUB); }

    fn and_i32(&mut self) { self.push(op::OP_I32AND); }

    fn or_i32(&mut self) { self.push(op::OP_I32OR); }

    fn shl_i32(&mut self) { self.push(op::OP_I32SHL); }

    fn call_fn(&mut self, fn_idx: u16) {
        self.push(op::OP_CALL);
        let buf_len = self.len();
        self.push(0);
        self.push(0);
        self.write_fixed_leb16_at_idx(buf_len, fn_idx);
    }

    fn eq_i32(&mut self) { self.push(op::OP_I32EQ); }

    fn ne_i32(&mut self) { self.push(op::OP_I32NE); }

    fn le_i32(&mut self) { self.push(op::OP_I32LES); }

    fn lt_i32(&mut self) { self.push(op::OP_I32LTS); }

    fn ge_i32(&mut self) { self.push(op::OP_I32GES); }

    fn gt_i32(&mut self) { self.push(op::OP_I32GTS); }

    fn if_i32(&mut self) {
        self.push(op::OP_IF);
        self.push(op::TYPE_I32);
    }

    fn block_i32(&mut self) {
        self.push(op::OP_BLOCK);
        self.push(op::TYPE_I32);
    }

    fn xor_i32(&mut self) { self.push(op::OP_I32XOR); }

    fn load_unaligned_i32_from_stack(&mut self, byte_offset: u32) {
        self.push(op::OP_I32LOAD);
        self.push(op::MEM_NO_ALIGN);
        self.write_leb_u32(byte_offset);
    }

    fn load_unaligned_u16_from_stack(&mut self, byte_offset: u32) {
        self.push(op::OP_I32LOAD16U);
        self.push(op::MEM_NO_ALIGN);
        self.write_leb_u32(byte_offset);
    }

    fn load_aligned_i32_from_stack(&mut self, byte_offset: u32) {
        self.push(op::OP_I32LOAD);
        self.push(op::MEM_ALIGN32);
        self.write_leb_u32(byte_offset);
    }

    // XXX: Function naming should be consistent regarding both alignment and accepting an
    // offset. Leaving as-is for the Rust port to cleanup
    fn store_unaligned_i32(&mut self, byte_offset: u32) {
        self.push(op::OP_I32STORE);
        self.push(op::MEM_NO_ALIGN);
        self.write_leb_u32(byte_offset);
    }

    fn store_unaligned_u16(&mut self, byte_offset: u32) {
        self.push(op::OP_I32STORE16);
        self.push(op::MEM_NO_ALIGN);
        self.write_leb_u32(byte_offset);
    }

    fn store_u8(&mut self, byte_offset: u32) {
        self.push(op::OP_I32STORE8);
        self.push(op::MEM_NO_ALIGN);
        self.write_leb_u32(byte_offset);
    }

    fn shr_u32(&mut self) { self.push(op::OP_I32SHRU); }

    fn shr_i32(&mut self) { self.push(op::OP_I32SHRS); }

    fn eqz_i32(&mut self) { self.push(op::OP_I32EQZ); }

    fn if_void(&mut self) {
        self.push(op::OP_IF);
        self.push(op::TYPE_VOID_BLOCK);
    }

    fn else_(&mut self) { self.push(op::OP_ELSE); }

    fn loop_void(&mut self) {
        self.push(op::OP_LOOP);
        self.push(op::TYPE_VOID_BLOCK);
    }

    fn block_void(&mut self) {
        self.push(op::OP_BLOCK);
        self.push(op::TYPE_VOID_BLOCK);
    }

    fn block_end(&mut self) { self.push(op::OP_END); }

    fn return_(&mut self) { self.push(op::OP_RETURN); }

    fn drop(&mut self) { self.push(op::OP_DROP); }

    // Generate a br_table where an input of [i] will branch [i]th outer block,
    // where [i] is passed on the wasm stack
    fn brtable_and_cases(&mut self, cases_count: u32) {
        self.push(op::OP_BRTABLE);
        self.write_leb_u32(cases_count);

        for i in 0..(cases_count + 1) {
            self.write_leb_u32(i);
        }
    }

    fn br(&mut self, depth: u32) {
        self.push(op::OP_BR);
        self.write_leb_u32(depth);
    }

    fn get_local(&mut self, local: &WasmLocal) {
        self.push(op::OP_GETLOCAL);
        self.push(local.idx());
    }

    fn set_local(&mut self, local: &WasmLocal) {
        self.push(op::OP_SETLOCAL);
        self.push(local.idx());
    }

    fn tee_local(&mut self, local: &WasmLocal) {
        self.push(op::OP_TEELOCAL);
        self.push(local.idx());
    }

    fn unreachable(&mut self) { self.push(op::OP_UNREACHABLE); }

    fn increment_mem32(&mut self, addr: u32) { self.increment_variable(addr, 1) }

    fn increment_variable(&mut self, addr: u32, n: i32) {
        self.push_i32(addr as i32);
        self.load_aligned_i32(addr);
        self.push_i32(n);
        self.add_i32();
        self.store_aligned_i32();
    }

    fn load_aligned_u16_from_stack(&mut self, byte_offset: u32) {
        self.push(op::OP_I32LOAD16U);
        self.push(op::MEM_ALIGN16);
        self.write_leb_u32(byte_offset);
    }
}
