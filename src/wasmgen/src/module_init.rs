use std::ptr;

use ::util::*;
use ::wasm_opcodes::*;

pub const FN0_TYPE_INDEX: u8 = 0;
pub const FN1_TYPE_INDEX: u8 = 1;
pub const FN2_TYPE_INDEX: u8 = 2;
pub const FN3_TYPE_INDEX: u8 = 3;

pub const FN0_RET_TYPE_INDEX: u8 = 4;
pub const FN1_RET_TYPE_INDEX: u8 = 5;

#[allow(dead_code)]
pub const FN2_RET_TYPE_INDEX: u8 = 6;

pub const NR_FN_TYPE_INDEXES: u8 = 7;

static mut MODULE_PTR: *mut WasmBuilder = ptr::null_mut();

#[no_mangle]
pub fn setup() {
    let wm = Box::new(WasmBuilder::new());
    unsafe {
        MODULE_PTR = Box::into_raw(wm);
    }
    get_module().init();
}

#[no_mangle]
pub fn get_module<'a>() -> &'a mut WasmBuilder {
    unsafe {
        MODULE_PTR.as_mut().expect("getting module")
    }
}

pub struct WasmBuilder {
    pub op: Vec<u8>,
    pub buffers: Vec<*mut Vec<u8>>,

    idx_import_table_size: usize, // for rewriting once finished
    idx_import_count: usize, // for rewriting once finished
    idx_import_entries: usize, // for searching the imports

    import_table_size: usize, // the current import table size (to avoid reading 2 byte leb)

    initial_static_size: usize, // size of module after initialization, rest is drained on reset
}

impl WasmBuilder {
    pub fn new() -> Self {
        WasmBuilder {
            op: Vec::with_capacity(256),
            buffers: Vec::with_capacity(64),

            idx_import_table_size: 0,
            idx_import_count: 0,
            idx_import_entries: 0,

            import_table_size: 1,

            initial_static_size: 0,
        }
    }

    pub fn init(&mut self) {
        self.op.extend("\0asm".as_bytes());

        // wasm version in leb128, 4 bytes
        self.op.push(WASM_VERSION); self.op.push(0); self.op.push(0); self.op.push(0);

        self.write_type_section();
        self.write_import_section_preamble();

        // store state of current pointers etc. so we can reset them later
        self.initial_static_size = self.op.len();
    }

    pub fn reset(&mut self) {
        self.op.drain(self.initial_static_size..);
        self.set_import_table_size(1);
        self.set_import_count(0);
        self.buffers.drain(..);
    }

    pub fn include_buffer(&mut self, buf: *mut Vec<u8>) {
        self.buffers.push(buf);
    }

    pub fn finish(&mut self, no_of_locals_i32: u8) -> usize {
        self.write_memory_import();
        self.write_function_section(1);
        self.write_export_section();

        // write code section preamble
        self.op.push(SC_CODE);

        let idx_code_section_size = self.op.len(); // we will write to this location later
        self.op.push(0); self.op.push(0); // write temp val for now using 4 bytes
        self.op.push(0); self.op.push(0);

        self.op.push(1); // number of function bodies: just 1

        // same as above but for body size of the function
        let idx_fn_body_size = self.op.len();
        self.op.push(0); self.op.push(0);
        self.op.push(0); self.op.push(0);

        self.op.push(1); // count of local blocks
        self.op.push(no_of_locals_i32); self.op.push(TYPE_I32);

        for buf_ptr in &mut self.buffers {
            self.op.append(unsafe { buf_ptr.as_mut().expect("unloading buffer") });
        }

        self.op.push(OP_END);

        // write the actual sizes to the pointer locations stored above. We subtract 4 from the actual
        // value because the ptr itself points to four bytes
        let fn_body_size = (self.op.len() - idx_fn_body_size - 4) as u32;
        write_fixed_leb32_to_buf(&mut self.op, idx_fn_body_size, fn_body_size);

        let code_section_size = (self.op.len() - idx_code_section_size - 4) as u32;
        write_fixed_leb32_to_buf(&mut self.op, idx_code_section_size, code_section_size);

        self.op.len()
    }

    pub fn write_type_section(&mut self) {
        self.op.push(SC_TYPE);

        let idx_section_size = self.op.len();
        self.op.push(0);

        self.op.push(NR_FN_TYPE_INDEXES); // number of type descriptors

        // FN0
        self.op.push(TYPE_FUNC);
        self.op.push(0); // no args
        self.op.push(0); // no return val

        // FN1
        self.op.push(TYPE_FUNC);
        self.op.push(1);
        self.op.push(TYPE_I32);
        self.op.push(0);

        // FN2
        self.op.push(TYPE_FUNC);
        self.op.push(2);
        self.op.push(TYPE_I32);
        self.op.push(TYPE_I32);
        self.op.push(0);

        // FN3
        self.op.push(TYPE_FUNC);
        self.op.push(3);
        self.op.push(TYPE_I32);
        self.op.push(TYPE_I32);
        self.op.push(TYPE_I32);
        self.op.push(0);

        // FN0_RET
        self.op.push(TYPE_FUNC);
        self.op.push(0);
        self.op.push(1);
        self.op.push(TYPE_I32);

        // FN1_RET
        self.op.push(TYPE_FUNC);
        self.op.push(1);
        self.op.push(TYPE_I32);
        self.op.push(1);
        self.op.push(TYPE_I32);

        // FN2_RET
        self.op.push(TYPE_FUNC);
        self.op.push(2);
        self.op.push(TYPE_I32);
        self.op.push(TYPE_I32);
        self.op.push(1);
        self.op.push(TYPE_I32);

        let new_len = self.op.len();
        let size = (new_len - 1) - idx_section_size;
        self.op[idx_section_size] = size as u8;
    }

    /// Goes over the import block to find index of an import entry by function name
    pub fn get_import_index(&self, fn_name: PackedStr) -> Option<u8> {
        let fn_name = unpack_str(fn_name);
        let mut offset = self.idx_import_entries;
        for i in 0..self.get_import_count() {
            offset += 1; // skip length of module name
            offset += 1; // skip module name itself
            let len = self.op[offset];
            offset += 1;
            let name = self.op.get(offset..(offset + len as usize)).expect("get function name");
            if name == fn_name.as_bytes() {
                return Some(i);
            }
            offset += len as usize; // skip the string
            offset += 1; // skip import kind
            offset += 1; // skip type index
        }
        None
    }

    pub fn get_import_count(&self) -> u8 {
        dbg_assert!(self.idx_import_count < self.op.len());
        self.op[self.idx_import_count]
    }

    pub fn set_import_count(&mut self, count: u8) {
        self.op[self.idx_import_count] = count;
    }

    pub fn set_import_table_size(&mut self, size: usize) {
        self.import_table_size = size;
        let idx_import_table_size = self.idx_import_table_size;
        write_fixed_leb16_to_buf(&mut self.op, idx_import_table_size, size as u16);
    }

    pub fn write_import_section_preamble(&mut self) {
        self.op.push(SC_IMPORT);

        self.idx_import_table_size = self.op.len();
        self.op.push(1 | 0b10000000); self.op.push(0); // 1 in 2 byte leb

        self.idx_import_count = self.op.len();
        self.op.push(0);

        // here after starts the actual list of imports
        self.idx_import_entries = self.op.len();
    }

    pub fn write_memory_import(&mut self) {
        self.op.push(1);
        self.op.push('e' as u8);
        self.op.push(1);
        self.op.push('m' as u8);

        self.op.push(EXT_MEMORY);

        self.op.push(0); // memory flag, 0 for no maximum memory limit present
        write_leb_u32(&mut self.op, 256); // initial memory length of 256 pages, takes 2 bytes in leb128

        let idx_import_count = self.idx_import_count;
        self.op[idx_import_count] += 1;

        let new_table_size = self.import_table_size + 8;
        self.set_import_table_size(new_table_size);
    }

    pub fn write_import_entry(&mut self, fn_name: PackedStr, type_index: u8) -> u8 {
        self.op.push(1); // length of module name
        self.op.push('e' as u8); // module name
        let fn_name = unpack_str(fn_name);
        self.op.push(fn_name.len() as u8);
        self.op.extend(fn_name.as_bytes());
        self.op.push(EXT_FUNCTION);
        self.op.push(type_index);

        let idx_import_count = self.idx_import_count;
        self.op[idx_import_count] += 1;

        let new_table_size = self.import_table_size + 1 + 1 + 1 + fn_name.len() + 1 + 1;
        self.set_import_table_size(new_table_size);

        return self.op[idx_import_count] - 1;
    }

    pub fn write_function_section(&mut self, count: u8) {
        self.op.push(SC_FUNCTION);
        self.op.push(1 + count); // length of this section
        self.op.push(count); // count of signature indices
        for _ in 0..count {
            self.op.push(FN0_TYPE_INDEX);
        }
    }

    pub fn write_export_section(&mut self) {
        self.op.push(SC_EXPORT);
        self.op.push(1 + 1 + 1 + 1 + 1); // size of this section
        self.op.push(1); // count of table: just one function exported

        self.op.push(1); // length of exported function name
        self.op.push('f' as u8); // function name
        self.op.push(EXT_FUNCTION);

        // index of the exported function
        // function space starts with imports. index of last import is import count - 1
        // the last import however is a memory, so we subtract one from that
        let import_count = self.get_import_count();
        self.op.push(import_count - 1);
    }

    pub fn get_fn_index(&mut self, fn_name: PackedStr, type_index: u8) -> u8 {
        dbg_log!("getting fn idx for '{}'", unpack_str(fn_name));
        match self.get_import_index(fn_name) {
            Some(idx) => {
                dbg_log!("found existing entry at idx {}", idx);
                idx
            },
            None => {
                let idx = self.write_import_entry(fn_name, type_index);
                dbg_log!("wrote new import entry at idx {}", idx);
                idx
            },
        }
    }

    pub fn get_op_ptr(&self) -> *const u8 {
        self.op.as_ptr()
    }

    pub fn get_op_len(&self) -> usize {
        self.op.len()
    }

}

#[cfg(test)]
mod tests {
    use ::module_init::*;

    #[test]
    fn import_table_management() {
        let mut w = WasmBuilder::new();
        w.init();
        assert_eq!(0, w.get_fn_index(pack_str("foo"), FN0_TYPE_INDEX));
        assert_eq!(1, w.get_fn_index(pack_str("bar"), FN1_TYPE_INDEX));
        assert_eq!(0, w.get_fn_index(pack_str("foo"), FN0_TYPE_INDEX));
        assert_eq!(2, w.get_fn_index(pack_str("baz"), FN2_TYPE_INDEX));
    }

}
