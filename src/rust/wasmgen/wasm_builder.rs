use crate::leb::{write_leb_i32, write_leb_i64, write_leb_u32};
use crate::wasmgen::wasm_opcodes as op;
use std::collections::HashMap;

/// Multiplicative hashing for the builder's small keys (labels, signatures,
/// import names): SipHash showed in JIT compile profiles.
#[derive(Default)]
pub struct FastHasher(u64);
impl std::hash::Hasher for FastHasher {
    fn finish(&self) -> u64 { self.0 }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(5) ^ b as u64).wrapping_mul(0x517C_C1B7_2722_0A95);
        }
    }
    fn write_u32(&mut self, v: u32) { self.write_u64(v as u64) }
    fn write_u64(&mut self, v: u64) {
        self.0 = (self.0.rotate_left(5) ^ v).wrapping_mul(0x517C_C1B7_2722_0A95);
    }
    fn write_usize(&mut self, v: usize) { self.write_u64(v as u64) }
}
type FastMap<K, V> = HashMap<K, V, std::hash::BuildHasherDefault<FastHasher>>;

// Wasm indices and vector/section lengths are unsigned 32-bit LEBs.
fn wasm_len(n: usize) -> u32 { u32::try_from(n).expect("Wasm length exceeds u32") }
fn section(output: &mut Vec<u8>, kind: u8, contents: &[u8]) {
    output.push(kind);
    write_leb_u32(output, wasm_len(contents.len()));
    output.extend_from_slice(contents);
}
fn name(output: &mut Vec<u8>, text: &str) {
    write_leb_u32(output, wasm_len(text.len()));
    output.extend_from_slice(text.as_bytes());
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash)]
#[repr(u8)]
pub enum WasmType {
    I32 = 0x7F,
    I64 = 0x7E,
    F32 = 0x7D,
    F64 = 0x7C,
    V128 = 0x7B,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct Signature {
    pub params: Vec<WasmType>,
    pub results: Vec<WasmType>,
}
impl Signature {
    pub fn new(params: &[WasmType], results: &[WasmType]) -> Self {
        Self {
            params: params.to_vec(),
            results: results.to_vec(),
        }
    }
}
/// Signature of the module's single exported function.
#[derive(Copy, Clone, PartialEq)]
#[allow(non_camel_case_types)]
enum FunctionType {
    FN1,
    FN1_RET,
}

impl FunctionType {
    fn signature(self) -> Signature {
        use WasmType::*;
        let (params, results): (&[WasmType], &[WasmType]) = match self {
            Self::FN1 => (&[I32], &[]),
            Self::FN1_RET => (&[I32], &[I32]),
        };
        Signature::new(params, results)
    }
}

pub const WASM_MODULE_ARGUMENT_COUNT: u32 = 1;

pub struct WasmBuilder {
    output: Vec<u8>,
    instruction_body: Vec<u8>,
    signatures: Vec<Signature>,
    signature_indices: FastMap<Signature, u32>,
    imports: Vec<(String, u32)>,
    import_indices: FastMap<String, u32>,
    finished: bool,
    next_label: Label,
    label_stack: Vec<Label>,
    label_to_depth: FastMap<Label, usize>,
    free_locals_i32: Vec<WasmLocal>,
    free_locals_i64: Vec<WasmLocalI64>,
    free_locals_f32: Vec<WasmLocalF32>,
    free_locals_f64: Vec<WasmLocalF64>,
    free_locals_v128: Vec<WasmLocalV128>,
    local_types: Vec<WasmType>,
    local_live: Vec<bool>,
    pub arg_local_initial_state: WasmLocal,
    /// Imports the host's function table as ("e", "t") (tail calls).
    table_import: bool,
    /// The module's function returns an i32 (FN1_RET instead of FN1).
    entry_result: bool,
    /// Branch hints (body offset of an if/br_if, likely taken), emitted as
    /// the "metadata.code.branch_hint" section.
    branch_hints: Vec<(usize, bool)>,
    /// The module function's name in the "name" section (profiles).
    function_name: Option<String>,
    /// Functions defined after the entry function: type index and body
    /// (locals declaration, code, END), called with call_internal.
    internal_functions: Vec<(u32, Vec<u8>)>,
    /// Positions of the 5-byte targets of calls to internal functions, and
    /// which one (patched in finish, once the import count is final)
    internal_calls: Vec<(usize, u32)>,
}

#[derive(Eq, PartialEq)]
pub struct WasmLocal(u32);
impl WasmLocal {
    pub fn idx(&self) -> u32 { self.0 }
    /// Only clone locals whose owner keeps them live for the whole use interval.
    pub fn unsafe_clone(&self) -> Self { Self(self.0) }
}
pub struct WasmLocalI64(u32);
impl WasmLocalI64 {
    pub fn idx(&self) -> u32 { self.0 }
    pub fn unsafe_clone(&self) -> Self { Self(self.0) }
}
// F32 locals are exercised by the backend tests; SIMD uses V128.
#[allow(dead_code)]
pub struct WasmLocalF32(u32);
pub struct WasmLocalF64(u32);
pub struct WasmLocalV128(u32);

#[derive(Copy, Clone, Eq, Hash, PartialEq)]
pub struct Label(u32);
impl Label {
    const ZERO: Label = Label(0);
    fn next(&self) -> Label { Label(self.0.checked_add(1).expect("Wasm label overflow")) }
}

impl WasmBuilder {
    pub fn new() -> Self {
        Self {
            output: Vec::with_capacity(256),
            instruction_body: Vec::with_capacity(256),
            signatures: Vec::new(),
            signature_indices: FastMap::default(),
            imports: Vec::new(),
            import_indices: FastMap::default(),
            finished: false,
            next_label: Label::ZERO,
            label_stack: Vec::new(),
            label_to_depth: FastMap::default(),
            free_locals_i32: Vec::new(),
            free_locals_i64: Vec::new(),
            free_locals_f32: Vec::new(),
            free_locals_f64: Vec::new(),
            free_locals_v128: Vec::new(),
            local_types: Vec::new(),
            local_live: Vec::new(),
            arg_local_initial_state: WasmLocal(0),
            table_import: false,
            entry_result: false,
            branch_hints: Vec::new(),
            function_name: None,
            internal_functions: Vec::new(),
            internal_calls: Vec::new(),
        }
    }

    pub fn intern_signature(&mut self, signature: Signature) -> u32 {
        assert!(!self.finished, "reset builder before reuse");
        if let Some(&index) = self.signature_indices.get(&signature) {
            return index;
        }
        let index = wasm_len(self.signatures.len());
        self.signatures.push(signature.clone());
        self.signature_indices.insert(signature, index);
        index
    }

    fn get_fn_idx_signature(&mut self, fn_name: &str, signature: Signature) -> u32 {
        let ty = self.intern_signature(signature);
        if let Some(&index) = self.import_indices.get(fn_name) {
            assert_eq!(
                self.imports[index as usize].1, ty,
                "helper signature mismatch: {}",
                fn_name
            );
            return index;
        }
        let index = wasm_len(self.imports.len());
        self.imports.push((fn_name.to_owned(), ty));
        self.import_indices.insert(fn_name.to_owned(), index);
        index
    }

    /// The function index of an import (imports only grow, so it is final).
    pub fn import_index(&mut self, fn_name: &str, signature: Signature) -> u32 {
        self.get_fn_idx_signature(fn_name, signature)
    }
    /// Define a function after the entry function (`body`: locals
    /// declaration, code and END); returns its number for call_internal.
    pub fn add_internal_function(&mut self, signature: Signature, body: Vec<u8>) -> u32 {
        let ty = self.intern_signature(signature);
        self.internal_functions.push((ty, body));
        wasm_len(self.internal_functions.len() - 1)
    }
    /// Call internal function `number` (its index is patched in finish).
    pub fn call_internal(&mut self, number: u32) {
        self.instruction_body.push(op::OP_CALL);
        self.internal_calls
            .push((self.instruction_body.len(), number));
        self.instruction_body
            .extend_from_slice(&[0x80, 0x80, 0x80, 0x80, 0]);
    }

    /// Vector signatures are for Wasm-to-Wasm calls; JS helpers need a scratch-memory ABI.
    pub fn call_signature(&mut self, fn_name: &str, signature: Signature) {
        let index = self.get_fn_idx_signature(fn_name, signature);
        self.instruction_body.push(op::OP_CALL);
        write_leb_u32(&mut self.instruction_body, index);
    }

    pub fn finish(&mut self) -> usize {
        assert!(!self.finished, "reset builder before reuse");
        assert!(
            self.label_stack.is_empty() && self.label_to_depth.is_empty(),
            "unclosed Wasm blocks"
        );
        assert!(
            self.local_live.iter().all(|&live| !live),
            "all locals must be freed"
        );
        let entry_type = self.intern_signature(self.entry_signature());
        self.output.extend_from_slice(b"\0asm\x01\0\0\0");
        let mut body = Vec::new();
        write_leb_u32(&mut body, wasm_len(self.signatures.len()));
        for signature in &self.signatures {
            body.push(op::TYPE_FUNC);
            write_leb_u32(&mut body, wasm_len(signature.params.len()));
            body.extend(signature.params.iter().map(|t| *t as u8));
            write_leb_u32(&mut body, wasm_len(signature.results.len()));
            body.extend(signature.results.iter().map(|t| *t as u8));
        }
        section(&mut self.output, op::SC_TYPE, &body);
        body.clear();
        write_leb_u32(
            &mut body,
            wasm_len(self.imports.len())
                .checked_add(1 + self.table_import as u32)
                .expect("import overflow"),
        );
        for (fn_name, ty) in &self.imports {
            name(&mut body, "e");
            name(&mut body, fn_name);
            body.push(op::EXT_FUNCTION);
            write_leb_u32(&mut body, *ty);
        }
        name(&mut body, "e");
        name(&mut body, "m");
        #[cfg(not(feature = "parallel"))]
        {
            body.extend_from_slice(&[op::EXT_MEMORY, 0]);
            write_leb_u32(&mut body, 64);
        }
        #[cfg(feature = "parallel")]
        {
            // shared, minimum 64 pages, maximum 4 GiB (the imported memory of tools/parallel_wasm.js)
            body.extend_from_slice(&[op::EXT_MEMORY, 3]);
            write_leb_u32(&mut body, 64);
            write_leb_u32(&mut body, 65536);
        }
        if self.table_import {
            name(&mut body, "e");
            name(&mut body, "t");
            // funcref, no maximum, minimum 0 (indices are checked at run time)
            body.extend_from_slice(&[op::EXT_TABLE, op::TYPE_ANYFUNC, 0, 0]);
        }
        section(&mut self.output, op::SC_IMPORT, &body);
        body.clear();
        write_leb_u32(&mut body, wasm_len(1 + self.internal_functions.len()));
        write_leb_u32(&mut body, entry_type);
        for (ty, _) in &self.internal_functions {
            write_leb_u32(&mut body, *ty);
        }
        section(&mut self.output, op::SC_FUNCTION, &body);
        // internal function k is function imports + 1 + k: 5-byte LEB targets
        let first_internal = wasm_len(self.imports.len() + 1);
        for &(at, number) in &self.internal_calls {
            let index = first_internal + number;
            for i in 0..5 {
                self.instruction_body[at + i] =
                    (index >> (7 * i) & 0x7F) as u8 | if i < 4 { 0x80 } else { 0 };
            }
        }
        body.clear();
        body.push(1);
        name(&mut body, "f");
        body.push(op::EXT_FUNCTION);
        write_leb_u32(&mut body, wasm_len(self.imports.len()));
        section(&mut self.output, op::SC_EXPORT, &body);
        let mut groups: Vec<(WasmType, u32)> = Vec::new();
        for &ty in &self.local_types {
            if let Some((last, count)) = groups.last_mut() {
                if *last == ty {
                    *count = count.checked_add(1).expect("local group overflow");
                    continue;
                }
            }
            groups.push((ty, 1));
        }
        body.clear();
        write_leb_u32(&mut body, wasm_len(groups.len()));
        for (ty, count) in groups {
            write_leb_u32(&mut body, count);
            body.push(ty as u8);
        }
        if !self.branch_hints.is_empty() {
            // Offsets from the start of the function body (its locals).
            let mut hints = Vec::new();
            name(&mut hints, "metadata.code.branch_hint");
            hints.push(1);
            write_leb_u32(&mut hints, wasm_len(self.imports.len()));
            write_leb_u32(&mut hints, wasm_len(self.branch_hints.len()));
            for &(offset, likely) in &self.branch_hints {
                write_leb_u32(&mut hints, wasm_len(body.len() + offset));
                hints.push(1);
                hints.push(likely as u8);
            }
            section(&mut self.output, 0, &hints);
        }
        body.extend_from_slice(&self.instruction_body);
        body.push(op::OP_END);
        let mut code = Vec::new();
        write_leb_u32(&mut code, wasm_len(1 + self.internal_functions.len()));
        write_leb_u32(&mut code, wasm_len(body.len()));
        code.extend_from_slice(&body);
        for (_, internal) in &self.internal_functions {
            write_leb_u32(&mut code, wasm_len(internal.len()));
            code.extend_from_slice(internal);
        }
        section(&mut self.output, op::SC_CODE, &code);
        if let Some(function_name) = &self.function_name {
            let mut names = Vec::new();
            write_leb_u32(&mut names, 1);
            write_leb_u32(&mut names, wasm_len(self.imports.len()));
            name(&mut names, function_name);
            let mut contents = Vec::new();
            name(&mut contents, "name");
            contents.push(1);
            write_leb_u32(&mut contents, wasm_len(names.len()));
            contents.extend_from_slice(&names);
            section(&mut self.output, 0, &contents);
        }
        self.finished = true;
        self.output.len()
    }

    pub fn output(&self) -> &[u8] { &self.output }
    /// Bytes of instructions emitted so far (for size statistics).
    pub fn body_len(&self) -> usize { self.instruction_body.len() }
    /// Declared locals excluding parameters, including temporary staging slots.
    #[cfg(test)]
    pub fn declared_local_count(&self) -> usize { self.local_types.len() }

    /// Declared locals excluding parameters, including temporary staging slots.

    fn new_local_index(&mut self, ty: WasmType) -> u32 {
        assert!(!self.finished, "reset builder before reuse");
        let index = wasm_len(self.local_types.len())
            .checked_add(WASM_MODULE_ARGUMENT_COUNT)
            .expect("local overflow");
        self.local_types.push(ty);
        self.local_live.push(true);
        index
    }
    fn reuse_local_index(&mut self, index: u32, ty: WasmType) {
        let i = (index - WASM_MODULE_ARGUMENT_COUNT) as usize;
        assert_eq!(self.local_types[i], ty);
        assert!(!self.local_live[i], "reusing live local");
        self.local_live[i] = true;
    }
    fn release_local_index(&mut self, index: u32, ty: WasmType) {
        let i = index
            .checked_sub(WASM_MODULE_ARGUMENT_COUNT)
            .expect("cannot free argument") as usize;
        assert_eq!(self.local_types[i], ty);
        assert!(self.local_live[i], "local freed twice");
        self.local_live[i] = false;
    }
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

    fn alloc_local(&mut self) -> WasmLocal {
        if let Some(local) = self.free_locals_i32.pop() {
            self.reuse_local_index(local.0, WasmType::I32);
            local
        }
        else {
            WasmLocal(self.new_local_index(WasmType::I32))
        }
    }
    /// A fresh declaration starts at zero on every function entry. Never reuse
    /// a freed local: its previous runtime value may survive on this CFG path.
    #[must_use]
    pub fn declare_zeroed_local(&mut self) -> WasmLocal {
        WasmLocal(self.new_local_index(WasmType::I32))
    }
    pub fn free_local(&mut self, local: WasmLocal) {
        self.release_local_index(local.0, WasmType::I32);
        self.free_locals_i32.push(local);
    }
    #[must_use]
    pub fn set_new_local(&mut self) -> WasmLocal {
        let local = self.alloc_local();
        self.set_local(&local);
        local
    }
    pub fn set_local(&mut self, local: &WasmLocal) {
        self.instruction_body.push(op::OP_SETLOCAL);
        write_leb_u32(&mut self.instruction_body, local.0);
    }
    pub fn get_local(&mut self, local: &WasmLocal) {
        self.instruction_body.push(op::OP_GETLOCAL);
        write_leb_u32(&mut self.instruction_body, local.idx());
    }
    pub fn tee_local(&mut self, local: &WasmLocal) {
        self.instruction_body.push(op::OP_TEELOCAL);
        write_leb_u32(&mut self.instruction_body, local.0);
    }
    fn alloc_local_i64(&mut self) -> WasmLocalI64 {
        if let Some(local) = self.free_locals_i64.pop() {
            self.reuse_local_index(local.0, WasmType::I64);
            local
        }
        else {
            WasmLocalI64(self.new_local_index(WasmType::I64))
        }
    }
    #[must_use]
    pub fn declare_zeroed_local_i64(&mut self) -> WasmLocalI64 {
        WasmLocalI64(self.new_local_index(WasmType::I64))
    }
    pub fn free_local_i64(&mut self, local: WasmLocalI64) {
        self.release_local_index(local.0, WasmType::I64);
        self.free_locals_i64.push(local);
    }
    #[must_use]
    pub fn set_new_local_i64(&mut self) -> WasmLocalI64 {
        let local = self.alloc_local_i64();
        self.set_local_i64(&local);
        local
    }
    pub fn set_local_i64(&mut self, local: &WasmLocalI64) {
        self.instruction_body.push(op::OP_SETLOCAL);
        write_leb_u32(&mut self.instruction_body, local.0);
    }
    pub fn get_local_i64(&mut self, local: &WasmLocalI64) {
        self.instruction_body.push(op::OP_GETLOCAL);
        write_leb_u32(&mut self.instruction_body, local.idx());
    }
    #[allow(dead_code)]
    fn alloc_local_f32(&mut self) -> WasmLocalF32 {
        if let Some(local) = self.free_locals_f32.pop() {
            self.reuse_local_index(local.0, WasmType::F32);
            local
        }
        else {
            WasmLocalF32(self.new_local_index(WasmType::F32))
        }
    }
    #[allow(dead_code)]
    pub fn free_local_f32(&mut self, local: WasmLocalF32) {
        self.release_local_index(local.0, WasmType::F32);
        self.free_locals_f32.push(local);
    }
    #[must_use]
    #[allow(dead_code)]
    pub fn set_new_local_f32(&mut self) -> WasmLocalF32 {
        let local = self.alloc_local_f32();
        self.set_local_f32(&local);
        local
    }
    #[allow(dead_code)]
    pub fn set_local_f32(&mut self, local: &WasmLocalF32) {
        self.instruction_body.push(op::OP_SETLOCAL);
        write_leb_u32(&mut self.instruction_body, local.0);
    }
    #[allow(dead_code)]
    pub fn get_local_f32(&mut self, local: &WasmLocalF32) {
        self.instruction_body.push(op::OP_GETLOCAL);
        write_leb_u32(&mut self.instruction_body, local.0);
    }
    fn alloc_local_f64(&mut self) -> WasmLocalF64 {
        if let Some(local) = self.free_locals_f64.pop() {
            self.reuse_local_index(local.0, WasmType::F64);
            local
        }
        else {
            WasmLocalF64(self.new_local_index(WasmType::F64))
        }
    }
    pub fn free_local_f64(&mut self, local: WasmLocalF64) {
        self.release_local_index(local.0, WasmType::F64);
        self.free_locals_f64.push(local);
    }
    #[must_use]
    pub fn set_new_local_f64(&mut self) -> WasmLocalF64 {
        let local = self.alloc_local_f64();
        self.set_local_f64(&local);
        local
    }
    pub fn set_local_f64(&mut self, local: &WasmLocalF64) {
        self.instruction_body.push(op::OP_SETLOCAL);
        write_leb_u32(&mut self.instruction_body, local.0);
    }
    pub fn get_local_f64(&mut self, local: &WasmLocalF64) {
        self.instruction_body.push(op::OP_GETLOCAL);
        write_leb_u32(&mut self.instruction_body, local.0);
    }
    fn alloc_local_v128(&mut self) -> WasmLocalV128 {
        if let Some(local) = self.free_locals_v128.pop() {
            self.reuse_local_index(local.0, WasmType::V128);
            local
        }
        else {
            WasmLocalV128(self.new_local_index(WasmType::V128))
        }
    }
    #[must_use]
    pub fn declare_zeroed_local_v128(&mut self) -> WasmLocalV128 {
        WasmLocalV128(self.new_local_index(WasmType::V128))
    }
    pub fn free_local_v128(&mut self, local: WasmLocalV128) {
        self.release_local_index(local.0, WasmType::V128);
        self.free_locals_v128.push(local);
    }
    #[must_use]
    pub fn set_new_local_v128(&mut self) -> WasmLocalV128 {
        let local = self.alloc_local_v128();
        self.set_local_v128(&local);
        local
    }
    pub fn set_local_v128(&mut self, local: &WasmLocalV128) {
        self.instruction_body.push(op::OP_SETLOCAL);
        write_leb_u32(&mut self.instruction_body, local.0);
    }
    pub fn get_local_v128(&mut self, local: &WasmLocalV128) {
        self.instruction_body.push(op::OP_GETLOCAL);
        write_leb_u32(&mut self.instruction_body, local.0);
    }
    pub fn unary_f64(&mut self, negative: bool) {
        self.instruction_body
            .push(if negative { op::OP_F64NEG } else { op::OP_F64ABS });
    }

    pub fn round_f64(&mut self, rc: u8) {
        self.instruction_body.push(match rc {
            0 => op::OP_F64NEAREST,
            1 => op::OP_F64FLOOR,
            2 => op::OP_F64CEIL,
            3 => op::OP_F64TRUNC,
            _ => unreachable!(),
        });
    }

    pub fn compare_f64(&mut self, operation: u8) {
        self.instruction_body.push(match operation {
            0 => op::OP_F64GT,
            1 => op::OP_F64LT,
            2 => op::OP_F64EQ,
            _ => unreachable!(),
        });
    }

    pub fn arithmetic_f64(&mut self, operation: u8) {
        self.instruction_body.push(match operation {
            0 => op::OP_F64ADD,
            1 => op::OP_F64SUB,
            2 => op::OP_F64MUL,
            3 => op::OP_F64DIV,
            _ => unreachable!(),
        });
    }
    pub fn reinterpret_f64_as_i64(&mut self) {
        self.instruction_body.push(op::OP_I64REINTERPRETF64);
    }

    // Standard SIMD binary encoding: 0xfd, unsigned LEB opcode, immediates.
    pub fn simd(&mut self, opcode: u32) {
        self.instruction_body.push(0xFD);
        write_leb_u32(&mut self.instruction_body, opcode);
    }
    pub fn simd_lane(&mut self, opcode: u32, lane: u8) {
        self.simd(opcode);
        self.instruction_body.push(lane);
    }
    pub fn simd_memory(&mut self, opcode: u32, alignment: u8) {
        self.simd(opcode);
        self.instruction_body.push(alignment);
        self.instruction_body.push(0);
    }
    pub fn simd_shuffle(&mut self, lanes: [u8; 16]) {
        dbg_assert!(lanes.iter().all(|&x| x < 32));
        self.simd(0x0D);
        self.instruction_body.extend_from_slice(&lanes);
    }
    pub fn simd_zero(&mut self) {
        self.simd(0x0C);
        self.instruction_body.extend_from_slice(&[0; 16]);
    }
    /// v128.const
    pub fn const_v128(&mut self, bytes: [u8; 16]) {
        self.simd(0x0C);
        self.instruction_body.extend_from_slice(&bytes);
    }
    pub fn if_v128(&mut self) {
        self.open_block();
        self.instruction_body.push(op::OP_IF);
        self.instruction_body.push(0x7B);
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

    pub fn load_aligned_f64(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_F64LOAD);
        self.instruction_body.push(op::MEM_ALIGN64);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_aligned_i32(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD);
        self.instruction_body.push(op::MEM_ALIGN32);
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

    pub fn store_unaligned_i64(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I64STORE);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn add_i32(&mut self) { self.instruction_body.push(op::OP_I32ADD); }
    pub fn clz_i32(&mut self) { self.instruction_body.push(op::OP_I32CLZ); }
    pub fn ctz_i32(&mut self) { self.instruction_body.push(op::OP_I32CTZ); }
    pub fn popcnt_i32(&mut self) { self.instruction_body.push(op::OP_I32POPCNT); }
    pub fn clz_i64(&mut self) { self.instruction_body.push(op::OP_I64CLZ); }
    pub fn ctz_i64(&mut self) { self.instruction_body.push(op::OP_I64CTZ); }
    pub fn popcnt_i64(&mut self) { self.instruction_body.push(op::OP_I64POPCNT); }
    pub fn sub_i64(&mut self) { self.instruction_body.push(op::OP_I64SUB); }
    pub fn shr_s_i64(&mut self) { self.instruction_body.push(op::OP_I64SHRS); }
    pub fn ltu_i64(&mut self) { self.instruction_body.push(op::OP_I64LTU); }
    pub fn add_i64(&mut self) { self.instruction_body.push(op::OP_I64ADD); }
    pub fn sub_i32(&mut self) { self.instruction_body.push(op::OP_I32SUB); }
    pub fn and_i32(&mut self) { self.instruction_body.push(op::OP_I32AND); }
    pub fn and_i64(&mut self) { self.instruction_body.push(op::OP_I64AND); }
    pub fn or_i32(&mut self) { self.instruction_body.push(op::OP_I32OR); }
    pub fn or_i64(&mut self) { self.instruction_body.push(op::OP_I64OR); }
    pub fn xor_i32(&mut self) { self.instruction_body.push(op::OP_I32XOR); }
    pub fn xor_i64(&mut self) { self.instruction_body.push(op::OP_I64XOR); }
    pub fn mul_i32(&mut self) { self.instruction_body.push(op::OP_I32MUL); }
    pub fn mul_i64(&mut self) { self.instruction_body.push(op::OP_I64MUL); }

    pub fn rotl_i32(&mut self) { self.instruction_body.push(op::OP_I32ROTL); }
    pub fn rotr_i32(&mut self) { self.instruction_body.push(op::OP_I32ROTR); }
    pub fn rotr_i64(&mut self) { self.instruction_body.push(op::OP_I64ROTR); }

    pub fn shl_i32(&mut self) { self.instruction_body.push(op::OP_I32SHL); }
    pub fn shl_i64(&mut self) { self.instruction_body.push(op::OP_I64SHL); }
    pub fn shr_u_i32(&mut self) { self.instruction_body.push(op::OP_I32SHRU); }
    pub fn shr_u_i64(&mut self) { self.instruction_body.push(op::OP_I64SHRU); }
    pub fn shr_s_i32(&mut self) { self.instruction_body.push(op::OP_I32SHRS); }

    pub fn eq_i32(&mut self) { self.instruction_body.push(op::OP_I32EQ); }
    pub fn eq_i64(&mut self) { self.instruction_body.push(op::OP_I64EQ); }
    pub fn ne_i32(&mut self) { self.instruction_body.push(op::OP_I32NE); }
    pub fn ne_i64(&mut self) { self.instruction_body.push(op::OP_I64NE); }

    pub fn gtu_i32(&mut self) { self.instruction_body.push(op::OP_I32GTU); }
    pub fn geu_i32(&mut self) { self.instruction_body.push(op::OP_I32GEU); }
    pub fn ltu_i32(&mut self) { self.instruction_body.push(op::OP_I32LTU); }
    pub fn leu_i32(&mut self) { self.instruction_body.push(op::OP_I32LEU); }

    pub fn gtu_i64(&mut self) { self.instruction_body.push(op::OP_I64GTU); }

    pub fn reinterpret_i32_as_f32(&mut self) {
        self.instruction_body.push(op::OP_F32REINTERPRETI32);
    }
    /// 0 add, 1 sub, 2 mul, 3 div (as arithmetic_f64)
    pub fn arithmetic_f32(&mut self, operation: u8) {
        self.instruction_body.push(match operation {
            0 => op::OP_F32ADD,
            1 => op::OP_F32SUB,
            2 => op::OP_F32MUL,
            3 => op::OP_F32DIV,
            _ => unreachable!(),
        });
    }
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

    /// Hint the next instruction (an if or br_if) as likely or unlikely
    /// taken (Wasm branch hinting; engines without it ignore the section).
    pub fn hint(&mut self, likely: bool) {
        self.branch_hints
            .push((self.instruction_body.len(), likely));
    }
    /// Name the module function (shown by profilers).
    pub fn set_function_name(&mut self, function_name: String) {
        self.function_name = Some(function_name);
    }
    /// The module function returns an i32 (every return leaves one).
    pub fn set_entry_result(&mut self) { self.entry_result = true; }
    fn entry_signature(&self) -> Signature {
        if self.entry_result {
            FunctionType::FN1_RET.signature()
        }
        else {
            FunctionType::FN1.signature()
        }
    }
    /// Tail call (Wasm tail-call proposal) of the table entry on the stack,
    /// with the module entry signature; the table is the host's ("e", "t").
    pub fn return_call_indirect_fn1(&mut self) {
        let ty = self.intern_signature(self.entry_signature());
        self.table_import = true;
        self.instruction_body.push(op::OP_RETURN_CALL_INDIRECT);
        write_leb_u32(&mut self.instruction_body, ty);
        self.instruction_body.push(0);
    }

    #[allow(dead_code)]
    pub fn drop_(&mut self) { self.instruction_body.push(op::OP_DROP); }

    pub fn brtable(
        &mut self,
        default_case: Label,
        cases: &mut dyn std::iter::ExactSizeIterator<Item = &Label>,
    ) {
        self.instruction_body.push(op::OP_BRTABLE);
        write_leb_u32(&mut self.instruction_body, wasm_len(cases.len()));
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
            wasm_len(self.label_stack.len() - depth),
        );
    }

    pub fn unreachable(&mut self) { self.instruction_body.push(op::OP_UNREACHABLE) }

    /// An instruction without immediates (x64 page tier: i64 compares,
    /// rotates, extensions). The caller keeps the operand stack typed.
    pub fn op(&mut self, opcode: u8) { self.instruction_body.push(opcode); }
    /// A load or store with an explicit alignment hint and offset immediate.
    pub fn memory_op(&mut self, opcode: u8, align: u8, byte_offset: u32) {
        self.instruction_body.push(opcode);
        self.instruction_body.push(align);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }
}

/// Guest RAM accesses of generated code. In the parallel build (cores in
/// workers, crate::parallel) they are sequentially consistent atomics, which
/// keep x86's load/store order on weakly ordered hosts; the address must then
/// be naturally aligned (the RAM guards check it and take the slow path
/// otherwise). In the normal build they are the plain unaligned accesses.
impl WasmBuilder {
    pub const ATOMIC_GUEST_MEMORY: bool = cfg!(feature = "parallel");

    fn atomic_op(&mut self, opcode: u8, align: u8, byte_offset: u32) {
        self.instruction_body.push(0xFE);
        self.instruction_body.push(opcode);
        self.instruction_body.push(align);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }
    /// A full barrier (MFENCE and the like); nothing in the normal build
    pub fn guest_fence(&mut self) {
        if Self::ATOMIC_GUEST_MEMORY {
            self.instruction_body.extend_from_slice(&[0xFE, 0x03, 0x00]);
        }
    }
    pub fn guest_load_u8(&mut self, byte_offset: u32) {
        if Self::ATOMIC_GUEST_MEMORY {
            self.atomic_op(0x12, 0, byte_offset)
        }
        else {
            self.load_u8(byte_offset)
        }
    }
    pub fn guest_load_i32(&mut self, byte_offset: u32) {
        if Self::ATOMIC_GUEST_MEMORY {
            self.atomic_op(0x10, 2, byte_offset)
        }
        else {
            self.load_unaligned_i32(byte_offset)
        }
    }
    pub fn guest_load_i64(&mut self, byte_offset: u32) {
        if Self::ATOMIC_GUEST_MEMORY {
            self.atomic_op(0x11, 3, byte_offset)
        }
        else {
            self.load_unaligned_i64(byte_offset)
        }
    }
    /// i64 loads of 8/16/32 zero-extended bits (the x64 page tier)
    pub fn guest_load_i64_bits(&mut self, bits: u32, byte_offset: u32) {
        if Self::ATOMIC_GUEST_MEMORY {
            match bits {
                8 => self.atomic_op(0x14, 0, byte_offset),
                16 => self.atomic_op(0x15, 1, byte_offset),
                32 => self.atomic_op(0x16, 2, byte_offset),
                _ => self.atomic_op(0x11, 3, byte_offset),
            }
        }
        else {
            match bits {
                8 => self.memory_op(op::OP_I64LOAD8U, op::MEM_NO_ALIGN, byte_offset),
                16 => self.memory_op(op::OP_I64LOAD16U, op::MEM_NO_ALIGN, byte_offset),
                32 => self.memory_op(op::OP_I64LOAD32U, op::MEM_NO_ALIGN, byte_offset),
                _ => self.memory_op(op::OP_I64LOAD, op::MEM_NO_ALIGN, byte_offset),
            }
        }
    }
    pub fn guest_store_i64(&mut self, byte_offset: u32) {
        if Self::ATOMIC_GUEST_MEMORY {
            self.atomic_op(0x18, 3, byte_offset)
        }
        else {
            self.store_unaligned_i64(byte_offset)
        }
    }
    /// i64 stores of the low 8/16/32/64 bits (the x64 page tier)
    pub fn guest_store_i64_bits(&mut self, bits: u32, byte_offset: u32) {
        if Self::ATOMIC_GUEST_MEMORY {
            match bits {
                8 => self.atomic_op(0x1B, 0, byte_offset),
                16 => self.atomic_op(0x1C, 1, byte_offset),
                32 => self.atomic_op(0x1D, 2, byte_offset),
                _ => self.atomic_op(0x18, 3, byte_offset),
            }
        }
        else {
            match bits {
                8 => self.memory_op(op::OP_I64STORE8, op::MEM_NO_ALIGN, byte_offset),
                16 => self.memory_op(op::OP_I64STORE16, op::MEM_NO_ALIGN, byte_offset),
                32 => self.memory_op(op::OP_I64STORE32, op::MEM_NO_ALIGN, byte_offset),
                _ => self.memory_op(op::OP_I64STORE, op::MEM_NO_ALIGN, byte_offset),
            }
        }
    }
    /// A v128 guest load: two ordered 8-byte halves in the parallel build
    /// (address 8-aligned), one v128.load otherwise. [address] -> v128
    pub fn guest_load_v128(&mut self, scratch: &WasmLocal) {
        if Self::ATOMIC_GUEST_MEMORY {
            self.tee_local(scratch);
            self.guest_load_i64(0);
            self.simd(0x12); // i64x2.splat
            self.get_local(scratch);
            self.guest_load_i64(8);
            self.simd_lane(0x1E, 1); // i64x2.replace_lane
        }
        else {
            self.simd_memory(0x00, 0);
        }
    }
    /// A v128 guest store. [address, value] ->
    pub fn guest_store_v128(&mut self, address: &WasmLocal, value: &WasmLocalV128) {
        if Self::ATOMIC_GUEST_MEMORY {
            self.get_local(address);
            self.get_local_v128(value);
            self.simd_lane(0x1D, 0); // i64x2.extract_lane
            self.guest_store_i64(0);
            self.get_local(address);
            self.get_local_v128(value);
            self.simd_lane(0x1D, 1);
            self.guest_store_i64(8);
        }
        else {
            self.get_local(address);
            self.get_local_v128(value);
            self.simd_memory(0x0B, 0);
        }
    }
}

/// Scalar floating-point forms used by the experimental IR backend's x87 path.
#[allow(dead_code)]
impl WasmBuilder {
    pub fn reinterpret_f32_as_i32(&mut self) {
        self.instruction_body.push(op::OP_I32REINTERPRETF32);
    }
    pub fn promote_f32_to_f64(&mut self) { self.instruction_body.push(op::OP_F64PROMOTEF32); }
    pub fn demote_f64_to_f32(&mut self) { self.instruction_body.push(op::OP_F32DEMOTEF64); }
    pub fn convert_i32_to_f64(&mut self) { self.instruction_body.push(op::OP_F64CONVERTSI32); }
    pub fn convert_i64_to_f64(&mut self) { self.instruction_body.push(op::OP_F64CONVERTSI64); }
    /// Traps outside the i32 range: callers range-check first.
    pub fn trunc_f64_to_i32(&mut self) { self.instruction_body.push(op::OP_I32TRUNCSF64); }
    /// Traps outside the i64 range: callers range-check first.
    pub fn trunc_f64_to_i64(&mut self) { self.instruction_body.push(op::OP_I64TRUNCSF64); }
    pub fn const_f32(&mut self, v: f32) {
        self.instruction_body.push(op::OP_F32CONST);
        self.instruction_body.extend_from_slice(&v.to_le_bytes());
    }
    pub fn const_f64(&mut self, v: f64) {
        self.instruction_body.push(op::OP_F64CONST);
        self.instruction_body.extend_from_slice(&v.to_le_bytes());
    }
    pub fn ge_f64(&mut self) { self.instruction_body.push(op::OP_F64GE); }
    pub fn le_f64(&mut self) { self.instruction_body.push(op::OP_F64LE); }
    pub fn ne_f64(&mut self) { self.instruction_body.push(op::OP_F64NE); }
    pub fn store_aligned_f64(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_F64STORE);
        self.instruction_body.push(op::MEM_ALIGN64);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }
}

#[cfg(test)]
mod tests {
    use super::{Signature, WasmBuilder, WasmType, WASM_MODULE_ARGUMENT_COUNT};
    use std::fs::File;
    use std::io::Write;

    #[test]
    fn import_table_management() {
        let mut w = WasmBuilder::new();
        let none = Signature::new(&[], &[]);
        let one = Signature::new(&[WasmType::I32], &[]);
        let two = Signature::new(&[WasmType::I32, WasmType::I32], &[]);

        assert_eq!(0, w.get_fn_idx_signature("foo", none.clone()));
        assert_eq!(1, w.get_fn_idx_signature("bar", one));
        assert_eq!(0, w.get_fn_idx_signature("foo", none));
        assert_eq!(2, w.get_fn_idx_signature("baz", two));
    }

    // tests/rust/verify-wasmgen-dummy-output.js instantiates and runs this module.
    #[test]
    fn builder_test() {
        let mut m = WasmBuilder::new();

        m.const_i32(2);

        m.call_signature("baz", Signature::new(&[WasmType::I32], &[WasmType::I32]));
        m.call_signature("foo", Signature::new(&[WasmType::I32], &[]));

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

        let mut f = File::create("build/dummy_output.wasm").expect("creating dummy_output.wasm");
        f.write_all(&m.output).expect("write dummy_output.wasm");
    }
}

#[cfg(test)]
#[path = "../../../tests/wasmgen/builder.rs"]
mod capacity_tests;
