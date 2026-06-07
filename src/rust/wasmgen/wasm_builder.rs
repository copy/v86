use std::collections::HashMap;
use std::mem::transmute;

use crate::leb::{
    write_fixed_leb16_at_idx, write_fixed_leb32_at_idx, write_leb_i32, write_leb_i64, write_leb_u32,
};
use crate::wasmgen::wasm_opcodes as op;

pub trait SafeToU8 {
    fn safe_to_u8(self) -> u8;
}
impl SafeToU8 for usize {
    fn safe_to_u8(self) -> u8 {
        dbg_assert!(self <= ::std::u8::MAX as usize);
        self as u8
    }
}

pub trait SafeToU16 {
    fn safe_to_u16(self) -> u16;
}
impl SafeToU16 for usize {
    fn safe_to_u16(self) -> u16 {
        dbg_assert!(self <= ::std::u16::MAX as usize);
        self as u16
    }
}

#[derive(PartialEq)]
#[allow(non_camel_case_types)]
enum FunctionType {
    FN0,
    FN1,
    FN2,
    FN3,

    FN0_RET,
    FN0_RET_I64,
    FN1_RET,
    FN2_RET,

    FN1_RET_I64,
    FN1_F32_RET,
    FN1_F64_RET,

    FN2_I32_I64,
    FN2_I64_I32,
    FN2_I64_I32_RET,
    FN2_I64_I32_RET_I64,
    FN2_F32_I32,

    FN3_RET,

    FN3_I64_I32_I32,
    FN3_I32_I64_I32,
    FN3_I32_I64_I32_RET,
    FN4_I32_I64_I64_I32_RET,
    // When adding at the end, update LAST below
}

impl FunctionType {
    pub fn of_u8(x: u8) -> FunctionType {
        dbg_assert!(x <= FunctionType::LAST as u8);
        unsafe { transmute(x) }
    }
    pub fn to_u8(self: FunctionType) -> u8 { self as u8 }
    pub const LAST: FunctionType = FunctionType::FN4_I32_I64_I64_I32_RET;
}

pub const WASM_MODULE_ARGUMENT_COUNT: u8 = 1;

pub struct WasmBuilder {
    output: Vec<u8>,
    instruction_body: Vec<u8>,

    idx_import_table_size: usize, // for rewriting once finished
    idx_import_count: usize,      // for rewriting once finished
    idx_import_entries: usize,    // for searching the imports

    import_table_size: usize, // the current import table size (to avoid reading 2 byte leb)
    import_count: u16,        // same as above

    initial_static_size: usize, // size of module after initialization, rest is drained on reset

    // label for referencing block/if/loop constructs directly via branch instructions
    next_label: Label,
    label_stack: Vec<Label>,
    label_to_depth: HashMap<Label, usize>,

    free_locals_i32: Vec<WasmLocal>,
    free_locals_i64: Vec<WasmLocalI64>,
    local_count: u8,
    pub arg_local_initial_state: WasmLocal,
}

#[derive(Eq, PartialEq)]
pub struct WasmLocal(u8);
impl WasmLocal {
    pub fn idx(&self) -> u8 { self.0 }
    /// Unsafe: Can result in multiple free's. Should only be used for locals that are used during
    /// the whole module (for example, registers)
    pub fn unsafe_clone(&self) -> WasmLocal { WasmLocal(self.0) }
}

pub struct WasmLocalI64(u8);
impl WasmLocalI64 {
    pub fn idx(&self) -> u8 { self.0 }
}

#[derive(Copy, Clone, Eq, Hash, PartialEq)]
pub struct Label(u32);
impl Label {
    const ZERO: Label = Label(0);
    fn next(&self) -> Label { Label(self.0.wrapping_add(1)) }
}

impl WasmBuilder {
    pub fn new() -> Self {
        let mut b = WasmBuilder {
            output: Vec::with_capacity(256),
            instruction_body: Vec::with_capacity(256),

            idx_import_table_size: 0,
            idx_import_count: 0,
            idx_import_entries: 0,

            import_table_size: 2,
            import_count: 0,

            initial_static_size: 0,

            label_to_depth: HashMap::new(),
            label_stack: Vec::new(),
            next_label: Label::ZERO,

            free_locals_i32: Vec::with_capacity(8),
            free_locals_i64: Vec::with_capacity(8),
            local_count: 0,
            arg_local_initial_state: WasmLocal(0),
        };
        b.init();
        b
    }

    fn init(&mut self) {
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
        self.instruction_body.clear();
        self.free_locals_i32.clear();
        self.free_locals_i64.clear();
        self.local_count = 0;

        dbg_assert!(self.label_to_depth.is_empty());
        dbg_assert!(self.label_stack.is_empty());
        self.next_label = Label::ZERO;
    }

    pub fn finish(&mut self) -> usize {
        dbg_assert!(self.label_to_depth.is_empty());
        dbg_assert!(self.label_stack.is_empty());

        self.write_memory_import();
        self.write_function_section();
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

        dbg_assert!(
            self.local_count as usize == self.free_locals_i32.len() + self.free_locals_i64.len(),
            "All locals should have been freed"
        );

        let free_locals_i32 = &self.free_locals_i32;
        let free_locals_i64 = &self.free_locals_i64;

        let locals = (0..self.local_count).map(|i| {
            let local_index = WASM_MODULE_ARGUMENT_COUNT + i;
            if free_locals_i64.iter().any(|v| v.idx() == local_index) {
                op::TYPE_I64
            }
            else {
                dbg_assert!(free_locals_i32.iter().any(|v| v.idx() == local_index));
                op::TYPE_I32
            }
        });
        let mut groups = vec![];
        for local_type in locals {
            if let Some(last) = groups.last_mut() {
                let (last_type, last_count) = *last;
                if last_type == local_type {
                    *last = (local_type, last_count + 1);
                    continue;
                }
            }
            groups.push((local_type, 1));
        }
        dbg_assert!(groups.len() < 128);
        self.output.push(groups.len().safe_to_u8());
        for (local_type, count) in groups {
            dbg_assert!(count < 128);
            self.output.push(count);
            self.output.push(local_type);
        }

        self.output.append(&mut self.instruction_body);

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
        self.output.push(0);

        let nr_of_function_types = FunctionType::to_u8(FunctionType::LAST) + 1;
        dbg_assert!(nr_of_function_types < 128);
        self.output.push(nr_of_function_types);

        for i in 0..(nr_of_function_types) {
            match FunctionType::of_u8(i) {
                FunctionType::FN0 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(0); // no args
                    self.output.push(0); // no return val
                },
                FunctionType::FN1 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN2 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN3 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(3);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN0_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(0);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN0_RET_I64 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(0);
                    self.output.push(1);
                    self.output.push(op::TYPE_I64);
                },
                FunctionType::FN1_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN2_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN1_RET_I64 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I64);
                },
                FunctionType::FN1_F32_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(1);
                    self.output.push(op::TYPE_F32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN1_F64_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(1);
                    self.output.push(op::TYPE_F64);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN2_I32_I64 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I64);
                    self.output.push(0);
                },
                FunctionType::FN2_I64_I32 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN2_I64_I32_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN2_I64_I32_RET_I64 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I64);
                },
                FunctionType::FN2_F32_I32 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_F32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN3_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(3);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN3_I64_I32_I32 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(3);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN3_I32_I64_I32 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(3);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN3_I32_I64_I32_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(3);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN4_I32_I64_I64_I32_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(4);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
            }
        }

        let new_len = self.output.len();
        let size = (new_len - 2) - idx_section_size;
        write_fixed_leb16_at_idx(&mut self.output, idx_section_size, size.safe_to_u16());
    }

    /// Goes over the import block to find index of an import entry by function name
    pub fn get_import_index(&self, fn_name: &str) -> Option<u16> {
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
        write_leb_u32(&mut self.output, 64); // initial memory length of 64 pages, takes 1 bytes in leb128

        let new_import_count = self.import_count + 1;
        self.set_import_count(new_import_count);

        let new_table_size = self.import_table_size + 7;
        self.set_import_table_size(new_table_size);
    }

    fn write_import_entry(&mut self, fn_name: &str, type_index: FunctionType) -> u16 {
        self.output.push(1); // length of module name
        self.output.push('e' as u8); // module name
        self.output.push(fn_name.len().safe_to_u8());
        self.output.extend(fn_name.as_bytes());
        self.output.push(op::EXT_FUNCTION);
        self.output.push(type_index.to_u8());

        let new_import_count = self.import_count + 1;
        self.set_import_count(new_import_count);

        let new_table_size = self.import_table_size + 1 + 1 + 1 + fn_name.len() + 1 + 1;
        self.set_import_table_size(new_table_size);

        self.import_count - 1
    }

    pub fn write_function_section(&mut self) {
        self.output.push(op::SC_FUNCTION);
        self.output.push(2); // length of this section
        self.output.push(1); // count of signature indices
        self.output.push(FunctionType::FN1.to_u8());
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

    fn get_fn_idx(&mut self, fn_name: &str, type_index: FunctionType) -> u16 {
        match self.get_import_index(fn_name) {
            Some(idx) => idx,
            None => {
                let idx = self.write_import_entry(fn_name, type_index);
                idx
            },
        }
    }

    pub fn get_output_ptr(&self) -> *const u8 { self.output.as_ptr() }
    pub fn get_output_len(&self) -> u32 { self.output.len() as u32 }

    fn open_block(&mut self) -> Label {
        let label = self.next_label;
        self.next_label = self.next_label.next();
        self.label_to_depth
            .insert(label, self.label_stack.len() + 1);
        self.label_stack.push(label);
        label
    }
    fn close_block(&mut self) {
        let label = self.label_stack.pop().unwrap();
        let old_depth = self.label_to_depth.remove(&label).unwrap();
        dbg_assert!(self.label_to_depth.len() + 1 == old_depth);
    }

    #[must_use = "local allocated but not used"]
    fn alloc_local(&mut self) -> WasmLocal {
        match self.free_locals_i32.pop() {
            Some(local) => local,
            None => {
                let new_idx = self.local_count + WASM_MODULE_ARGUMENT_COUNT;
                self.local_count = self.local_count.checked_add(1).unwrap();
                WasmLocal(new_idx)
            },
        }
    }
    pub fn free_local(&mut self, local: WasmLocal) {
        dbg_assert!(
            (WASM_MODULE_ARGUMENT_COUNT..self.local_count + WASM_MODULE_ARGUMENT_COUNT)
                .contains(&local.0)
        );
        self.free_locals_i32.push(local)
    }

    #[must_use = "local allocated but not used"]
    pub fn set_new_local(&mut self) -> WasmLocal {
        let local = self.alloc_local();
        self.instruction_body.push(op::OP_SETLOCAL);
        self.instruction_body.push(local.idx());
        local
    }
    #[must_use = "local allocated but not used"]
    pub fn tee_new_local(&mut self) -> WasmLocal {
        let local = self.alloc_local();
        self.instruction_body.push(op::OP_TEELOCAL);
        self.instruction_body.push(local.idx());
        local
    }
    pub fn set_local(&mut self, local: &WasmLocal) {
        self.instruction_body.push(op::OP_SETLOCAL);
        self.instruction_body.push(local.idx());
    }
    pub fn tee_local(&mut self, local: &WasmLocal) {
        self.instruction_body.push(op::OP_TEELOCAL);
        self.instruction_body.push(local.idx());
    }
    pub fn get_local(&mut self, local: &WasmLocal) {
        self.instruction_body.push(op::OP_GETLOCAL);
        self.instruction_body.push(local.idx());
    }

    #[must_use = "local allocated but not used"]
    fn alloc_local_i64(&mut self) -> WasmLocalI64 {
        match self.free_locals_i64.pop() {
            Some(local) => local,
            None => {
                let new_idx = self.local_count + WASM_MODULE_ARGUMENT_COUNT;
                self.local_count += 1;
                WasmLocalI64(new_idx)
            },
        }
    }
    pub fn free_local_i64(&mut self, local: WasmLocalI64) {
        dbg_assert!(
            (WASM_MODULE_ARGUMENT_COUNT..self.local_count + WASM_MODULE_ARGUMENT_COUNT)
                .contains(&local.0)
        );
        self.free_locals_i64.push(local)
    }
    #[must_use = "local allocated but not used"]
    pub fn set_new_local_i64(&mut self) -> WasmLocalI64 {
        let local = self.alloc_local_i64();
        self.instruction_body.push(op::OP_SETLOCAL);
        self.instruction_body.push(local.idx());
        local
    }
    #[must_use = "local allocated but not used"]
    pub fn tee_new_local_i64(&mut self) -> WasmLocalI64 {
        let local = self.alloc_local_i64();
        self.instruction_body.push(op::OP_TEELOCAL);
        self.instruction_body.push(local.idx());
        local
    }
    pub fn get_local_i64(&mut self, local: &WasmLocalI64) {
        self.instruction_body.push(op::OP_GETLOCAL);
        self.instruction_body.push(local.idx());
    }

    pub fn const_i32(&mut self, v: i32) {
        self.instruction_body.push(op::OP_I32CONST);
        write_leb_i32(&mut self.instruction_body, v);
    }
    pub fn const_i64(&mut self, v: i64) {
        self.instruction_body.push(op::OP_I64CONST);
        write_leb_i64(&mut self.instruction_body, v);
    }

    pub fn load_fixed_u8(&mut self, addr: u32) {
        self.const_i32(addr as i32);
        self.load_u8(0);
    }
    pub fn load_fixed_u16(&mut self, addr: u32) {
        // doesn't cause a failure in the generated code, but it will be much slower
        dbg_assert!((addr & 1) == 0);

        self.const_i32(addr as i32);
        self.instruction_body.push(op::OP_I32LOAD16U);
        self.instruction_body.push(op::MEM_ALIGN16);
        self.instruction_body.push(0); // immediate offset
    }
    pub fn load_fixed_i32(&mut self, addr: u32) {
        // doesn't cause a failure in the generated code, but it will be much slower
        dbg_assert!((addr & 3) == 0);

        self.const_i32(addr as i32);
        self.load_aligned_i32(0);
    }
    pub fn load_fixed_i64(&mut self, addr: u32) {
        // doesn't cause a failure in the generated code, but it will be much slower
        dbg_assert!((addr & 7) == 0);

        self.const_i32(addr as i32);
        self.load_aligned_i64(0);
    }

    pub fn load_u8(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD8U);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_unaligned_i64(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I64LOAD);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_unaligned_i32(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_unaligned_u16(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD16U);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_aligned_f64(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_F64LOAD);
        self.instruction_body.push(op::MEM_ALIGN64);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_aligned_i64(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I64LOAD);
        self.instruction_body.push(op::MEM_ALIGN64);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_aligned_f32(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_F32LOAD);
        self.instruction_body.push(op::MEM_ALIGN32);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_aligned_i32(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD);
        self.instruction_body.push(op::MEM_ALIGN32);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_aligned_u16(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD16U);
        self.instruction_body.push(op::MEM_ALIGN16);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_u8(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32STORE8);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_aligned_u16(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32STORE16);
        self.instruction_body.push(op::MEM_ALIGN16);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_aligned_i32(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32STORE);
        self.instruction_body.push(op::MEM_ALIGN32);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_aligned_i64(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I64STORE);
        self.instruction_body.push(op::MEM_ALIGN64);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_unaligned_u16(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32STORE16);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_unaligned_i32(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32STORE);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_unaligned_i64(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I64STORE);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn increment_fixed_i64(&mut self, byte_offset: u32, n: i64) {
        self.const_i32(byte_offset as i32);
        self.load_fixed_i64(byte_offset);
        self.const_i64(n);
        self.add_i64();
        self.store_aligned_i64(0);
    }

    pub fn add_i32(&mut self) { self.instruction_body.push(op::OP_I32ADD); }
    pub fn add_i64(&mut self) { self.instruction_body.push(op::OP_I64ADD); }
    pub fn sub_i32(&mut self) { self.instruction_body.push(op::OP_I32SUB); }
    pub fn and_i32(&mut self) { self.instruction_body.push(op::OP_I32AND); }
    pub fn or_i32(&mut self) { self.instruction_body.push(op::OP_I32OR); }
    pub fn or_i64(&mut self) { self.instruction_body.push(op::OP_I64OR); }
    pub fn xor_i32(&mut self) { self.instruction_body.push(op::OP_I32XOR); }
    pub fn mul_i32(&mut self) { self.instruction_body.push(op::OP_I32MUL); }
    pub fn mul_i64(&mut self) { self.instruction_body.push(op::OP_I64MUL); }
    pub fn div_i64(&mut self) { self.instruction_body.push(op::OP_I64DIVU); }
    pub fn rem_i64(&mut self) { self.instruction_body.push(op::OP_I64REMU); }

    pub fn rotl_i32(&mut self) { self.instruction_body.push(op::OP_I32ROTL); }

    pub fn shl_i32(&mut self) { self.instruction_body.push(op::OP_I32SHL); }
    pub fn shl_i64(&mut self) { self.instruction_body.push(op::OP_I64SHL); }
    pub fn shr_u_i32(&mut self) { self.instruction_body.push(op::OP_I32SHRU); }
    pub fn shr_u_i64(&mut self) { self.instruction_body.push(op::OP_I64SHRU); }
    pub fn shr_s_i32(&mut self) { self.instruction_body.push(op::OP_I32SHRS); }

    pub fn eq_i32(&mut self) { self.instruction_body.push(op::OP_I32EQ); }
    pub fn eq_i64(&mut self) { self.instruction_body.push(op::OP_I64EQ); }
    pub fn ne_i32(&mut self) { self.instruction_body.push(op::OP_I32NE); }
    pub fn ne_i64(&mut self) { self.instruction_body.push(op::OP_I64NE); }

    pub fn le_i32(&mut self) { self.instruction_body.push(op::OP_I32LES); }
    pub fn lt_i32(&mut self) { self.instruction_body.push(op::OP_I32LTS); }
    pub fn ge_i32(&mut self) { self.instruction_body.push(op::OP_I32GES); }
    pub fn gt_i32(&mut self) { self.instruction_body.push(op::OP_I32GTS); }

    pub fn gtu_i32(&mut self) { self.instruction_body.push(op::OP_I32GTU); }
    pub fn geu_i32(&mut self) { self.instruction_body.push(op::OP_I32GEU); }
    pub fn ltu_i32(&mut self) { self.instruction_body.push(op::OP_I32LTU); }
    pub fn leu_i32(&mut self) { self.instruction_body.push(op::OP_I32LEU); }

    pub fn gtu_i64(&mut self) { self.instruction_body.push(op::OP_I64GTU); }

    pub fn reinterpret_i32_as_f32(&mut self) {
        self.instruction_body.push(op::OP_F32REINTERPRETI32);
    }
    //pub fn reinterpret_f32_as_i32(&mut self) {
    //    self.instruction_body.push(op::OP_I32REINTERPRETF32);
    //}
    pub fn reinterpret_i64_as_f64(&mut self) {
        self.instruction_body.push(op::OP_F64REINTERPRETI64);
    }
    //pub fn reinterpret_f64_as_i64(&mut self) {
    //    self.instruction_body.push(op::OP_I64REINTERPRETF64);
    //}
    //pub fn promote_f32_to_f64(&mut self) { self.instruction_body.push(op::OP_F64PROMOTEF32); }
    //pub fn demote_f64_to_f32(&mut self) { self.instruction_body.push(op::OP_F32DEMOTEF64); }
    //pub fn convert_i32_to_f64(&mut self) { self.instruction_body.push(op::OP_F64CONVERTSI32); }
    //pub fn convert_i64_to_f64(&mut self) { self.instruction_body.push(op::OP_F64CONVERTSI64); }
    pub fn extend_unsigned_i32_to_i64(&mut self) {
        self.instruction_body.push(op::OP_I64EXTENDUI32);
    }
    pub fn extend_signed_i32_to_i64(&mut self) { self.instruction_body.push(op::OP_I64EXTENDSI32); }
    pub fn wrap_i64_to_i32(&mut self) { self.instruction_body.push(op::OP_I32WRAPI64); }

    pub fn eqz_i32(&mut self) { self.instruction_body.push(op::OP_I32EQZ); }

    pub fn select(&mut self) { self.instruction_body.push(op::OP_SELECT); }

    pub fn if_i32(&mut self) {
        self.open_block();
        self.instruction_body.push(op::OP_IF);
        self.instruction_body.push(op::TYPE_I32);
    }
    #[allow(dead_code)]
    pub fn if_i64(&mut self) {
        self.open_block();
        self.instruction_body.push(op::OP_IF);
        self.instruction_body.push(op::TYPE_I64);
    }
    #[allow(dead_code)]
    pub fn block_i32(&mut self) {
        self.open_block();
        self.instruction_body.push(op::OP_BLOCK);
        self.instruction_body.push(op::TYPE_I32);
    }

    pub fn if_void(&mut self) {
        self.open_block();
        self.instruction_body.push(op::OP_IF);
        self.instruction_body.push(op::TYPE_VOID_BLOCK);
    }

    pub fn else_(&mut self) {
        dbg_assert!(!self.label_stack.is_empty());
        self.instruction_body.push(op::OP_ELSE);
    }

    pub fn loop_void(&mut self) -> Label {
        self.instruction_body.push(op::OP_LOOP);
        self.instruction_body.push(op::TYPE_VOID_BLOCK);
        self.open_block()
    }

    pub fn block_void(&mut self) -> Label {
        self.instruction_body.push(op::OP_BLOCK);
        self.instruction_body.push(op::TYPE_VOID_BLOCK);
        self.open_block()
    }

    pub fn block_end(&mut self) {
        self.close_block();
        self.instruction_body.push(op::OP_END);
    }

    pub fn return_(&mut self) { self.instruction_body.push(op::OP_RETURN); }

    #[allow(dead_code)]
    pub fn drop_(&mut self) { self.instruction_body.push(op::OP_DROP); }

    pub fn brtable(
        &mut self,
        default_case: Label,
        cases: &mut dyn std::iter::ExactSizeIterator<Item = &Label>,
    ) {
        self.instruction_body.push(op::OP_BRTABLE);
        write_leb_u32(&mut self.instruction_body, cases.len() as u32);
        for case in cases {
            self.write_label(*case);
        }
        self.write_label(default_case);
    }

    pub fn br(&mut self, label: Label) {
        self.instruction_body.push(op::OP_BR);
        self.write_label(label);
    }
    pub fn br_if(&mut self, label: Label) {
        self.instruction_body.push(op::OP_BRIF);
        self.write_label(label);
    }

    fn write_label(&mut self, label: Label) {
        let depth = *self.label_to_depth.get(&label).unwrap();
        dbg_assert!(depth <= self.label_stack.len());
        write_leb_u32(
            &mut self.instruction_body,
            (self.label_stack.len() - depth) as u32,
        );
    }

    fn call_fn(&mut self, name: &str, function: FunctionType) {
        let i = self.get_fn_idx(name, function);
        self.instruction_body.push(op::OP_CALL);
        write_leb_u32(&mut self.instruction_body, i as u32);
    }

    pub fn call_fn0(&mut self, name: &str) { self.call_fn(name, FunctionType::FN0) }
    pub fn call_fn0_ret(&mut self, name: &str) { self.call_fn(name, FunctionType::FN0_RET) }
    pub fn call_fn0_ret_i64(&mut self, name: &str) { self.call_fn(name, FunctionType::FN0_RET_I64) }
    pub fn call_fn1(&mut self, name: &str) { self.call_fn(name, FunctionType::FN1) }
    pub fn call_fn1_ret(&mut self, name: &str) { self.call_fn(name, FunctionType::FN1_RET) }
    pub fn call_fn1_ret_i64(&mut self, name: &str) { self.call_fn(name, FunctionType::FN1_RET_I64) }
    pub fn call_fn1_f32_ret(&mut self, name: &str) { self.call_fn(name, FunctionType::FN1_F32_RET) }
    pub fn call_fn1_f64_ret(&mut self, name: &str) { self.call_fn(name, FunctionType::FN1_F64_RET) }
    pub fn call_fn2(&mut self, name: &str) { self.call_fn(name, FunctionType::FN2) }
    pub fn call_fn2_i32_i64(&mut self, name: &str) { self.call_fn(name, FunctionType::FN2_I32_I64) }
    pub fn call_fn2_i64_i32(&mut self, name: &str) { self.call_fn(name, FunctionType::FN2_I64_I32) }
    pub fn call_fn2_i64_i32_ret(&mut self, name: &str) {
        self.call_fn(name, FunctionType::FN2_I64_I32_RET)
    }
    pub fn call_fn2_i64_i32_ret_i64(&mut self, name: &str) {
        self.call_fn(name, FunctionType::FN2_I64_I32_RET_I64)
    }
    pub fn call_fn2_f32_i32(&mut self, name: &str) { self.call_fn(name, FunctionType::FN2_F32_I32) }
    pub fn call_fn2_ret(&mut self, name: &str) { self.call_fn(name, FunctionType::FN2_RET) }
    pub fn call_fn3(&mut self, name: &str) { self.call_fn(name, FunctionType::FN3) }
    pub fn call_fn3_ret(&mut self, name: &str) { self.call_fn(name, FunctionType::FN3_RET) }
    pub fn call_fn3_i64_i32_i32(&mut self, name: &str) {
        self.call_fn(name, FunctionType::FN3_I64_I32_I32)
    }
    pub fn call_fn3_i32_i64_i32(&mut self, name: &str) {
        self.call_fn(name, FunctionType::FN3_I32_I64_I32)
    }
    pub fn call_fn3_i32_i64_i32_ret(&mut self, name: &str) {
        self.call_fn(name, FunctionType::FN3_I32_I64_I32_RET)
    }
    pub fn call_fn4_i32_i64_i64_i32_ret(&mut self, name: &str) {
        self.call_fn(name, FunctionType::FN4_I32_I64_I64_I32_RET)
    }

    pub fn unreachable(&mut self) { self.instruction_body.push(op::OP_UNREACHABLE) }

    pub fn instruction_body_length(&self) -> u32 { self.instruction_body.len() as u32 }
}

#[cfg(test)]
mod tests {
    use super::{FunctionType, WasmBuilder, WASM_MODULE_ARGUMENT_COUNT};
    use std::fs::File;
    use std::io::Write;

    #[test]
    fn import_table_management() {
        let mut w = WasmBuilder::new();

        assert_eq!(0, w.get_fn_idx("foo", FunctionType::FN0));
        assert_eq!(1, w.get_fn_idx("bar", FunctionType::FN1));
        assert_eq!(0, w.get_fn_idx("foo", FunctionType::FN0));
        assert_eq!(2, w.get_fn_idx("baz", FunctionType::FN2));
    }

    #[test]
    fn builder_test() {
        let mut m = WasmBuilder::new();

        m.call_fn("foo", FunctionType::FN0);
        m.call_fn("bar", FunctionType::FN0);

        let local0 = m.alloc_local(); // for ensuring that reset clears previous locals
        m.free_local(local0);

        m.finish();
        m.reset();

        m.const_i32(2);

        m.call_fn("baz", FunctionType::FN1_RET);
        m.call_fn("foo", FunctionType::FN1);

        m.const_i32(10);
        let local1 = m.alloc_local();
        m.tee_local(&local1); // local1 = 10

        m.const_i32(20);
        m.add_i32();
        let local2 = m.alloc_local();
        m.tee_local(&local2); // local2 = 30

        m.free_local(local1);

        let local3 = m.alloc_local();
        assert_eq!(local3.idx(), WASM_MODULE_ARGUMENT_COUNT);

        m.free_local(local2);
        m.free_local(local3);

        m.const_i32(30);
        m.ne_i32();
        m.if_void();
        m.unreachable();
        m.block_end();

        m.finish();

        let op_ptr = m.get_output_ptr();
        let op_len = m.get_output_len();
        dbg_log!("op_ptr: {:?}, op_len: {:?}", op_ptr, op_len);

        let mut f = File::create("build/dummy_output.wasm").expect("creating dummy_output.wasm");
        f.write_all(&m.output).expect("write dummy_output.wasm");
    }
}
