use std::mem;
use std::ptr::NonNull;

use util::{
    unpack_str, write_fixed_leb16_at_idx, write_fixed_leb32_at_idx, write_leb_u32, PackedStr,
    SafeToU16, SafeToU8,
};
use wasmgen::wasm_opcodes as op;

#[allow(dead_code)]
pub const FN0_TYPE_INDEX: u8 = 0;
#[allow(dead_code)]
pub const FN1_TYPE_INDEX: u8 = 1;
#[allow(dead_code)]
pub const FN2_TYPE_INDEX: u8 = 2;
#[allow(dead_code)]
pub const FN3_TYPE_INDEX: u8 = 3;

#[allow(dead_code)]
pub const FN0_RET_TYPE_INDEX: u8 = 4;
#[allow(dead_code)]
pub const FN1_RET_TYPE_INDEX: u8 = 5;
#[allow(dead_code)]
pub const FN2_RET_TYPE_INDEX: u8 = 6;

pub const NR_FN_TYPE_INDEXES: u8 = 7;

static mut MODULE_PTR: NonNull<WasmBuilder> =
    unsafe { NonNull::new_unchecked(mem::align_of::<WasmBuilder>() as *mut _) };

#[no_mangle]
pub fn wg_setup() {
    let wm = Box::new(WasmBuilder::new());
    unsafe {
        MODULE_PTR = NonNull::new(Box::into_raw(wm)).expect("assigning module ptr");
    }
    get_module().init();
}

pub fn get_module<'a>() -> &'a mut WasmBuilder {
    unsafe { MODULE_PTR.as_mut() }
}

pub struct WasmBuilder {
    pub output: Vec<u8>,
    pub code_section: Vec<u8>,
    pub instruction_body: Vec<u8>,

    idx_import_table_size: usize, // for rewriting once finished
    idx_import_count: usize,      // for rewriting once finished
    idx_import_entries: usize,    // for searching the imports

    import_table_size: usize, // the current import table size (to avoid reading 2 byte leb)
    import_count: u16,        // same as above

    initial_static_size: usize, // size of module after initialization, rest is drained on reset
}

impl WasmBuilder {
    pub fn new() -> Self {
        WasmBuilder {
            output: Vec::with_capacity(256),
            code_section: Vec::with_capacity(256),
            instruction_body: Vec::with_capacity(256),

            idx_import_table_size: 0,
            idx_import_count: 0,
            idx_import_entries: 0,

            import_table_size: 2,
            import_count: 0,

            initial_static_size: 0,
        }
    }

    pub fn init(&mut self) {
        self.output.extend("\0asm".as_bytes());

        // wasm version in leb128, 4 bytes
        self.output.push(op::WASM_VERSION);
        self.output.push(0);
        self.output.push(0);
        self.output.push(0);

        self.write_type_section();
        self.write_import_section_preamble();

        // store state of current pointers etc. so we can reset them later
        self.initial_static_size = self.output.len();
    }

    pub fn reset(&mut self) {
        self.output.drain(self.initial_static_size..);
        self.set_import_table_size(2);
        self.set_import_count(0);
        self.code_section.clear();
        self.instruction_body.clear();
    }

    pub fn finish(&mut self, no_of_locals_i32: u8) -> usize {
        self.write_memory_import();
        self.write_function_section(1);
        self.write_export_section();

        // write code section preamble
        self.output.push(op::SC_CODE);

        let idx_code_section_size = self.output.len(); // we will write to this location later
        self.output.push(0);
        self.output.push(0); // write temp val for now using 4 bytes
        self.output.push(0);
        self.output.push(0);

        self.output.push(1); // number of function bodies: just 1

        // same as above but for body size of the function
        let idx_fn_body_size = self.output.len();
        self.output.push(0);
        self.output.push(0);
        self.output.push(0);
        self.output.push(0);

        self.output.push(1); // count of local blocks
        dbg_assert!(no_of_locals_i32 < 128);
        self.output.push(no_of_locals_i32);
        self.output.push(op::TYPE_I32);

        self.output.append(&mut self.code_section);

        self.output.push(op::OP_END);

        // write the actual sizes to the pointer locations stored above. We subtract 4 from the actual
        // value because the ptr itself points to four bytes
        let fn_body_size = (self.output.len() - idx_fn_body_size - 4) as u32;
        write_fixed_leb32_at_idx(&mut self.output, idx_fn_body_size, fn_body_size);

        let code_section_size = (self.output.len() - idx_code_section_size - 4) as u32;
        write_fixed_leb32_at_idx(&mut self.output, idx_code_section_size, code_section_size);

        self.output.len()
    }

    pub fn write_type_section(&mut self) {
        self.output.push(op::SC_TYPE);

        let idx_section_size = self.output.len();
        self.output.push(0);

        self.output.push(NR_FN_TYPE_INDEXES); // number of type descriptors

        // FN0
        self.output.push(op::TYPE_FUNC);
        self.output.push(0); // no args
        self.output.push(0); // no return val

        // FN1
        self.output.push(op::TYPE_FUNC);
        self.output.push(1);
        self.output.push(op::TYPE_I32);
        self.output.push(0);

        // FN2
        self.output.push(op::TYPE_FUNC);
        self.output.push(2);
        self.output.push(op::TYPE_I32);
        self.output.push(op::TYPE_I32);
        self.output.push(0);

        // FN3
        self.output.push(op::TYPE_FUNC);
        self.output.push(3);
        self.output.push(op::TYPE_I32);
        self.output.push(op::TYPE_I32);
        self.output.push(op::TYPE_I32);
        self.output.push(0);

        // FN0_RET
        self.output.push(op::TYPE_FUNC);
        self.output.push(0);
        self.output.push(1);
        self.output.push(op::TYPE_I32);

        // FN1_RET
        self.output.push(op::TYPE_FUNC);
        self.output.push(1);
        self.output.push(op::TYPE_I32);
        self.output.push(1);
        self.output.push(op::TYPE_I32);

        // FN2_RET
        self.output.push(op::TYPE_FUNC);
        self.output.push(2);
        self.output.push(op::TYPE_I32);
        self.output.push(op::TYPE_I32);
        self.output.push(1);
        self.output.push(op::TYPE_I32);

        let new_len = self.output.len();
        let size = (new_len - 1) - idx_section_size;
        self.output[idx_section_size] = size.safe_to_u8();
    }

    /// Goes over the import block to find index of an import entry by function name
    pub fn get_import_index(&self, fn_name: PackedStr) -> Option<u16> {
        let fn_name = unpack_str(fn_name);
        let mut offset = self.idx_import_entries;
        for i in 0..self.import_count {
            offset += 1; // skip length of module name
            offset += 1; // skip module name itself
            let len = self.output[offset] as usize;
            offset += 1;
            let name = self
                .output
                .get(offset..(offset + len))
                .expect("get function name");
            if name == fn_name.as_bytes() {
                return Some(i);
            }
            offset += len; // skip the string
            offset += 1; // skip import kind
            offset += 1; // skip type index
        }
        None
    }

    pub fn set_import_count(&mut self, count: u16) {
        dbg_assert!(count < 0x4000);
        self.import_count = count;
        let idx_import_count = self.idx_import_count;
        write_fixed_leb16_at_idx(&mut self.output, idx_import_count, count);
    }

    pub fn set_import_table_size(&mut self, size: usize) {
        dbg_assert!(size < 0x4000);
        self.import_table_size = size;
        let idx_import_table_size = self.idx_import_table_size;
        write_fixed_leb16_at_idx(&mut self.output, idx_import_table_size, size.safe_to_u16());
    }

    pub fn write_import_section_preamble(&mut self) {
        self.output.push(op::SC_IMPORT);

        self.idx_import_table_size = self.output.len();
        self.output.push(1 | 0b10000000);
        self.output.push(2); // 2 in 2 byte leb

        self.idx_import_count = self.output.len();
        self.output.push(1 | 0b10000000);
        self.output.push(0); // 0 in 2 byte leb

        // here after starts the actual list of imports
        self.idx_import_entries = self.output.len();
    }

    pub fn write_memory_import(&mut self) {
        self.output.push(1);
        self.output.push('e' as u8);
        self.output.push(1);
        self.output.push('m' as u8);

        self.output.push(op::EXT_MEMORY);

        self.output.push(0); // memory flag, 0 for no maximum memory limit present
        write_leb_u32(&mut self.output, 256); // initial memory length of 256 pages, takes 2 bytes in leb128

        let new_import_count = self.import_count + 1;
        self.set_import_count(new_import_count);

        let new_table_size = self.import_table_size + 8;
        self.set_import_table_size(new_table_size);
    }

    pub fn write_import_entry(&mut self, fn_name: PackedStr, type_index: u8) -> u16 {
        self.output.push(1); // length of module name
        self.output.push('e' as u8); // module name
        let fn_name = unpack_str(fn_name);
        self.output.push(fn_name.len().safe_to_u8());
        self.output.extend(fn_name.as_bytes());
        self.output.push(op::EXT_FUNCTION);
        self.output.push(type_index);

        let new_import_count = self.import_count + 1;
        self.set_import_count(new_import_count);

        let new_table_size = self.import_table_size + 1 + 1 + 1 + fn_name.len() + 1 + 1;
        self.set_import_table_size(new_table_size);

        self.import_count - 1
    }

    pub fn write_function_section(&mut self, count: u8) {
        self.output.push(op::SC_FUNCTION);
        self.output.push(1 + count); // length of this section
        self.output.push(count); // count of signature indices
        for _ in 0..count {
            self.output.push(FN1_TYPE_INDEX);
        }
    }

    pub fn write_export_section(&mut self) {
        self.output.push(op::SC_EXPORT);
        self.output.push(1 + 1 + 1 + 1 + 2); // size of this section
        self.output.push(1); // count of table: just one function exported

        self.output.push(1); // length of exported function name
        self.output.push('f' as u8); // function name
        self.output.push(op::EXT_FUNCTION);

        // index of the exported function
        // function space starts with imports. index of last import is import count - 1
        // the last import however is a memory, so we subtract one from that
        let next_op_idx = self.output.len();
        self.output.push(0);
        self.output.push(0); // add 2 bytes for writing 16 byte val
        write_fixed_leb16_at_idx(&mut self.output, next_op_idx, self.import_count - 1);
    }

    pub fn get_fn_idx(&mut self, fn_name: PackedStr, type_index: u8) -> u16 {
        match self.get_import_index(fn_name) {
            Some(idx) => idx,
            None => {
                let idx = self.write_import_entry(fn_name, type_index);
                idx
            }
        }
    }

    pub fn get_op_ptr(&self) -> *const u8 {
        self.output.as_ptr()
    }

    pub fn get_op_len(&self) -> usize {
        self.output.len()
    }

    pub fn commit_instruction_body_cs(&mut self) {
        self.code_section.append(&mut self.instruction_body);
    }
}

#[cfg(test)]
mod tests {
    use util::pack_str;
    use wasmgen::module_init::*;

    #[test]
    fn import_table_management() {
        let mut w = WasmBuilder::new();
        w.init();
        assert_eq!(0, w.get_fn_idx(pack_str("foo"), FN0_TYPE_INDEX));
        assert_eq!(1, w.get_fn_idx(pack_str("bar"), FN1_TYPE_INDEX));
        assert_eq!(0, w.get_fn_idx(pack_str("foo"), FN0_TYPE_INDEX));
        assert_eq!(2, w.get_fn_idx(pack_str("baz"), FN2_TYPE_INDEX));
    }

}
