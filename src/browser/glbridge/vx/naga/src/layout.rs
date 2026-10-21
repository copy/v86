//! Matrices of explicitly laid out blocks that naga cannot read: column
//! major ones whose columns are not their natural stride apart (std140's
//! mat2, mat3x2 and mat4x2: 2-row columns 16 bytes apart; naga refuses
//! them), and row major ones (naga keeps their type and transposes on load,
//! right for square ones only). Such a member (or an array of them) becomes
//! an array of 4-component vectors at the matrix stride: the columns of a
//! column major one, the rows of a row major one, as they are in memory.
//! The accesses become:
//! - a load of the matrix: a load of the array, the matrix made of its
//!   vectors (their first components, or across them for a row major one);
//! - a load of a column: of its vector (column major), or of each row's
//!   component (row major);
//! - an element's pointer: the vector's component (column major), the row's
//!   (row major: the indices swapped);
//! - a load of a struct or array holding such members: member by member.
//!
//! Arrays of scalars and 2-component vectors 16 bytes apart (std140's
//! `float a[4]`, `vec2 b[2]`; WGSL's are 4 and 8 apart, and naga writes
//! them so) are done over the same way, as column major "matrices" whose
//! columns are the elements: arrays of 4-component vectors, an element the
//! first components of its vector.
//!
//! The blocks get copies of their structs (and arrays) with the vectors
//! (`storage_of`), the originals stay for values, without their layout. A
//! module with an access this does not do (a store, a copy of memory, such
//! a pointer passed to a function) is left as it was.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;

const OP_TYPE_INT: u32 = 21;
const OP_TYPE_FLOAT: u32 = 22;
const OP_TYPE_VECTOR: u32 = 23;
const OP_TYPE_MATRIX: u32 = 24;
const OP_TYPE_ARRAY: u32 = 28;
const OP_TYPE_RUNTIME_ARRAY: u32 = 29;
const OP_TYPE_STRUCT: u32 = 30;
const OP_TYPE_POINTER: u32 = 32;
const OP_CONSTANT: u32 = 43;
const OP_FUNCTION: u32 = 54;
const OP_VARIABLE: u32 = 59;
const OP_LOAD: u32 = 61;
const OP_ACCESS_CHAIN: u32 = 65;
const OP_IN_BOUNDS_ACCESS_CHAIN: u32 = 66;
const OP_DECORATE: u32 = 71;
const OP_MEMBER_DECORATE: u32 = 72;
const OP_VECTOR_SHUFFLE: u32 = 79;
const OP_COMPOSITE_CONSTRUCT: u32 = 80;
const OP_COMPOSITE_EXTRACT: u32 = 81;

const DECORATION_ROW_MAJOR: u32 = 4;
const DECORATION_COL_MAJOR: u32 = 5;
const DECORATION_ARRAY_STRIDE: u32 = 6;
const DECORATION_MATRIX_STRIDE: u32 = 7;
const DECORATION_BLOCK: u32 = 2;
const DECORATION_BUFFER_BLOCK: u32 = 3;
const DECORATION_OFFSET: u32 = 35;

/// The storage classes of explicitly laid out memory: Uniform, PushConstant, StorageBuffer, PhysicalStorageBuffer
fn laid_out(class: u32) -> bool { matches!(class, 2 | 9 | 12 | 5349) }

/// The opcodes before the types: the header, debug information and annotations
fn preamble(op: u32) -> bool { matches!(op, 2..=7 | 10 | 11 | 14..=17 | 71..=75 | 330..=332 | 5632 | 5633) }

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// A matrix member done over: its matrix, how it is stored, the arrays around it
#[derive(Clone)]
struct Bad {
    /// the matrix type, its column type, the float type
    matrix: u32,
    column: u32,
    float: u32,
    columns: u32,
    rows: u32,
    row_major: bool,
    /// the stored vectors: how many, their type (4 components), the array of them
    vectors: u32,
    vector: u32,
    stored: u32,
    /// the arrays around the matrix, outermost first, and their storage copies
    wrappers: Vec<u32>,
    wrapper_storage: Vec<u32>,
    /// an array of padded elements (`matrix` the array, `column` the element), not a matrix
    padded: bool,
}

/// What a pointer this pass follows points at
#[derive(Clone)]
enum Ptr {
    /// a struct or array holding such members (`ty`, the value type; the pointer itself points at its storage copy)
    Copied { ty: u32, class: u32 },
    /// into a member done over, `depth` arrays in (at the matrix when depth is the arrays' count)
    Member { bad: usize, depth: usize, class: u32 },
    /// a column of a column major one (a pointer to its stored vector)
    Column { bad: usize, class: u32 },
    /// a column of a row major one: no pointer of its own, the matrix's and the column's index
    RowColumn { bad: usize, class: u32, matrix: u32, column: u32 },
}

struct Lowering {
    instructions: Vec<Vec<u32>>,
    bound: u32,
    /// type and constant declarations by id
    types: BTreeMap<u32, Vec<u32>>,
    constants: BTreeMap<u32, (u32, u32)>,
    member_decorations: BTreeMap<(u32, u32), Vec<Vec<u32>>>,
    decorations: BTreeMap<u32, Vec<Vec<u32>>>,
    /// the members done over, by (struct, member)
    bads: Vec<Bad>,
    bad_of: BTreeMap<(u32, u32), usize>,
    copy_memo: BTreeMap<u32, bool>,
    storage_memo: BTreeMap<u32, u32>,
    /// new declarations and annotations
    new_globals: Vec<Vec<u32>>,
    new_annotations: Vec<Vec<u32>>,
    /// pointer types (class, pointee) and vector types, existing or new
    pointers: BTreeMap<(u32, u32), u32>,
    vectors: BTreeMap<(u32, u32), u32>,
    uint: Option<u32>,
}

impl Lowering {
    fn op(w: &[u32]) -> u32 { w[0] & 0xFFFF }

    fn fresh(&mut self) -> u32 {
        let id = self.bound;
        self.bound += 1;
        id
    }

    fn new(words: &[u32]) -> Option<Lowering> {
        if words.len() < 5 {
            return None;
        }
        let mut instructions = Vec::new();
        let mut at = 5;
        while at < words.len() {
            let count = (words[at] >> 16) as usize;
            if count == 0 || at + count > words.len() {
                return None;
            }
            instructions.push(words[at..at + count].to_vec());
            at += count;
        }
        let mut l = Lowering {
            instructions,
            bound: words[3],
            types: BTreeMap::new(),
            constants: BTreeMap::new(),
            member_decorations: BTreeMap::new(),
            decorations: BTreeMap::new(),
            bads: Vec::new(),
            bad_of: BTreeMap::new(),
            copy_memo: BTreeMap::new(),
            storage_memo: BTreeMap::new(),
            new_globals: Vec::new(),
            new_annotations: Vec::new(),
            pointers: BTreeMap::new(),
            vectors: BTreeMap::new(),
            uint: None,
        };
        for w in &l.instructions {
            match Lowering::op(w) {
                op @ 19..=39 if w.len() >= 2 => {
                    l.types.insert(w[1], w.clone());
                    if op == OP_TYPE_POINTER && w.len() >= 4 {
                        l.pointers.entry((w[2], w[3])).or_insert(w[1]);
                    }
                    if op == OP_TYPE_VECTOR && w.len() >= 4 {
                        l.vectors.entry((w[2], w[3])).or_insert(w[1]);
                    }
                    if op == OP_TYPE_INT && w.len() >= 4 && w[2] == 32 && w[3] == 0 {
                        l.uint = Some(w[1]);
                    }
                },
                OP_CONSTANT if w.len() == 4 => {
                    l.constants.insert(w[2], (w[1], w[3]));
                },
                OP_DECORATE if w.len() >= 3 => l.decorations.entry(w[1]).or_default().push(w.clone()),
                OP_MEMBER_DECORATE if w.len() >= 4 => l.member_decorations.entry((w[1], w[2])).or_default().push(w.clone()),
                _ => {},
            }
        }
        Some(l)
    }

    fn type_op(&self, id: u32) -> u32 { self.types.get(&id).map_or(0, |w| Lowering::op(w)) }

    fn member_decoration(&self, s: u32, m: u32, decoration: u32) -> Option<u32> {
        self.member_decorations.get(&(s, m))?.iter().find(|w| w[3] == decoration).map(|w| *w.get(4).unwrap_or(&0))
    }

    fn array_stride(&self, id: u32) -> Option<u32> {
        self.decorations.get(&id)?.iter().find(|w| w[2] == DECORATION_ARRAY_STRIDE).and_then(|w| w.get(3).copied())
    }

    /// An integer constant's value
    fn constant_value(&self, id: u32) -> Option<u32> {
        let (ty, value) = *self.constants.get(&id)?;
        if self.type_op(ty) == OP_TYPE_INT && self.types[&ty][2] == 32 { Some(value) } else { None }
    }

    /// A 32-bit integer constant of `value`, existing or new
    fn constant(&mut self, value: u32) -> u32 {
        if let Some((&id, _)) = self.constants.iter().find(|(&id, &(ty, v))| v == value && self.constant_value(id).is_some() && {
            let w = &self.types[&ty];
            w[3] == 0
        }) {
            return id;
        }
        let uint = match self.uint {
            Some(id) => id,
            None => {
                let id = self.fresh();
                self.new_globals.push(instruction(OP_TYPE_INT, &[id, 32, 0]));
                self.types.insert(id, instruction(OP_TYPE_INT, &[id, 32, 0]));
                self.uint = Some(id);
                id
            },
        };
        let id = self.fresh();
        self.new_globals.push(instruction(OP_CONSTANT, &[uint, id, value]));
        self.constants.insert(id, (uint, value));
        id
    }

    fn pointer(&mut self, class: u32, pointee: u32) -> u32 {
        if let Some(&id) = self.pointers.get(&(class, pointee)) {
            return id;
        }
        let id = self.fresh();
        let w = instruction(OP_TYPE_POINTER, &[id, class, pointee]);
        self.new_globals.push(w.clone());
        self.types.insert(id, w);
        self.pointers.insert((class, pointee), id);
        id
    }

    fn vector(&mut self, component: u32, count: u32) -> u32 {
        if let Some(&id) = self.vectors.get(&(component, count)) {
            return id;
        }
        let id = self.fresh();
        let w = instruction(OP_TYPE_VECTOR, &[id, component, count]);
        self.new_globals.push(w.clone());
        self.types.insert(id, w);
        self.vectors.insert((component, count), id);
        id
    }

    fn array(&mut self, element: u32, length: u32, stride: u32) -> u32 {
        let id = self.fresh();
        let w = instruction(OP_TYPE_ARRAY, &[id, element, length]);
        self.new_globals.push(w.clone());
        self.types.insert(id, w);
        self.new_annotations.push(instruction(OP_DECORATE, &[id, DECORATION_ARRAY_STRIDE, stride]));
        id
    }

    /// The member `m` of struct `s` done over, if it is one of those matrices (or arrays of them)
    fn find_bad(&mut self, s: u32, m: u32, member_type: u32) -> Option<usize> {
        if let Some(&b) = self.bad_of.get(&(s, m)) {
            return Some(b);
        }
        if let Some(b) = self.find_padded(s, m, member_type) {
            return Some(b);
        }
        let stride = self.member_decoration(s, m, DECORATION_MATRIX_STRIDE)?;
        let row_major = self.member_decoration(s, m, DECORATION_ROW_MAJOR).is_some();
        let mut wrappers = Vec::new();
        let mut ty = member_type;
        while self.type_op(ty) == OP_TYPE_ARRAY {
            wrappers.push(ty);
            ty = self.types[&ty][2];
        }
        if self.type_op(ty) != OP_TYPE_MATRIX {
            return None;
        }
        let (column, columns) = (self.types[&ty][2], self.types[&ty][3]);
        if self.type_op(column) != OP_TYPE_VECTOR {
            return None;
        }
        let (float, rows) = (self.types[&column][2], self.types[&column][3]);
        if self.type_op(float) != OP_TYPE_FLOAT || self.types[&float][2] != 32 {
            return None;
        }
        let natural = if rows == 2 { 8 } else { 16 };
        if !row_major && stride == natural {
            return None;
        }
        // (the stored vectors: 4 components a stride of 16, each needing at most 4)
        if stride != 16 || (if row_major { columns } else { rows }) > 4 || wrappers.iter().any(|&w| self.array_stride(w).is_none()) {
            return None;
        }
        let vectors = if row_major { rows } else { columns };
        let vector = self.vector(float, 4);
        let length = self.constant(vectors);
        let stored = self.array(vector, length, stride);
        // the arrays around it, innermost first
        let mut wrapper_storage = Vec::new();
        let mut inner = stored;
        for &w in wrappers.iter().rev() {
            let (length, stride) = (self.types[&w][3], self.array_stride(w).unwrap_or(0));
            inner = self.array(inner, length, stride);
            wrapper_storage.push(inner);
        }
        wrapper_storage.reverse();
        let b = self.bads.len();
        self.bads.push(Bad { matrix: ty, column, float, columns, rows, row_major, vectors, vector, stored, wrappers, wrapper_storage, padded: false });
        self.bad_of.insert((s, m), b);
        Some(b)
    }

    /// The member `m` of struct `s` done over if it is an array of padded elements (or arrays of them)
    fn find_padded(&mut self, s: u32, m: u32, member_type: u32) -> Option<usize> {
        // the arrays around the innermost one
        let mut wrappers = Vec::new();
        let mut ty = member_type;
        while self.type_op(ty) == OP_TYPE_ARRAY && self.type_op(self.types[&ty][2]) == OP_TYPE_ARRAY {
            wrappers.push(ty);
            ty = self.types[&ty][2];
        }
        if self.type_op(ty) != OP_TYPE_ARRAY || self.array_stride(ty) != Some(16) {
            return None;
        }
        let element = self.types[&ty][2];
        let (scalar, rows) = match self.type_op(element) {
            OP_TYPE_INT | OP_TYPE_FLOAT => (element, 1),
            OP_TYPE_VECTOR if self.types[&element][3] == 2 => (self.types[&element][2], 2),
            _ => return None,
        };
        if !matches!(self.type_op(scalar), OP_TYPE_INT | OP_TYPE_FLOAT) || self.types[&scalar][2] != 32 || wrappers.iter().any(|&w| self.array_stride(w).is_none()) {
            return None;
        }
        let columns = self.constant_value(self.types[&ty][3])?;
        let vector = self.vector(scalar, 4);
        let stored = self.array(vector, self.types[&ty][3], 16);
        let mut wrapper_storage = Vec::new();
        let mut inner = stored;
        for &w in wrappers.iter().rev() {
            let (length, stride) = (self.types[&w][3], self.array_stride(w).unwrap_or(0));
            inner = self.array(inner, length, stride);
            wrapper_storage.push(inner);
        }
        wrapper_storage.reverse();
        let b = self.bads.len();
        self.bads.push(Bad { matrix: ty, column: element, float: scalar, columns, rows, row_major: false, vectors: columns, vector, stored, wrappers,
            wrapper_storage, padded: true });
        self.bad_of.insert((s, m), b);
        Some(b)
    }

    /// Whether a type holds members done over (so its blocks get a copy of it)
    fn needs_copy(&mut self, ty: u32) -> bool {
        if let Some(&n) = self.copy_memo.get(&ty) {
            return n;
        }
        self.copy_memo.insert(ty, false);
        let n = match self.type_op(ty) {
            OP_TYPE_STRUCT => {
                let members = self.types[&ty][2..].to_vec();
                let mut any = false;
                for (m, &mt) in members.iter().enumerate() {
                    if self.find_bad(ty, m as u32, mt).is_some() || self.needs_copy(mt) {
                        any = true;
                    }
                }
                any
            },
            OP_TYPE_ARRAY | OP_TYPE_RUNTIME_ARRAY => {
                let element = self.types[&ty][2];
                self.needs_copy(element)
            },
            _ => false,
        };
        self.copy_memo.insert(ty, n);
        n
    }

    /// The storage copy of a type that needs one
    fn storage_of(&mut self, ty: u32) -> u32 {
        if let Some(&id) = self.storage_memo.get(&ty) {
            return id;
        }
        let w = self.types[&ty].clone();
        let id = self.fresh();
        self.storage_memo.insert(ty, id);
        match Lowering::op(&w) {
            OP_TYPE_STRUCT => {
                let mut members = Vec::new();
                for (m, &mt) in w[2..].iter().enumerate() {
                    let m = m as u32;
                    members.push(if let Some(b) = self.find_bad(ty, m, mt) {
                        self.bads[b].wrapper_storage.first().copied().unwrap_or(self.bads[b].stored)
                    }
                    else if self.needs_copy(mt) {
                        self.storage_of(mt)
                    }
                    else {
                        mt
                    });
                    // the member's decorations: those of the matrix go with it
                    let bad = self.bad_of.contains_key(&(ty, m));
                    for d in self.member_decorations.get(&(ty, m)).cloned().unwrap_or_default() {
                        if bad && matches!(d[3], DECORATION_ROW_MAJOR | DECORATION_COL_MAJOR | DECORATION_MATRIX_STRIDE) {
                            continue;
                        }
                        let mut d = d.clone();
                        d[1] = id;
                        self.new_annotations.push(d);
                    }
                }
                let mut operands = Vec::from([id]);
                operands.extend(members);
                let s = instruction(OP_TYPE_STRUCT, &operands);
                self.new_globals.push(s.clone());
                self.types.insert(id, s);
                for d in self.decorations.get(&ty).cloned().unwrap_or_default() {
                    let mut d = d.clone();
                    d[1] = id;
                    self.new_annotations.push(d);
                }
            },
            op => {
                let element = self.storage_of(w[2]);
                let a = if op == OP_TYPE_ARRAY { instruction(OP_TYPE_ARRAY, &[id, element, w[3]]) } else { instruction(OP_TYPE_RUNTIME_ARRAY, &[id, element]) };
                self.new_globals.push(a.clone());
                self.types.insert(id, a);
                if let Some(stride) = self.array_stride(ty) {
                    self.new_annotations.push(instruction(OP_DECORATE, &[id, DECORATION_ARRAY_STRIDE, stride]));
                }
            },
        }
        id
    }

    /// The type a pointer into member `b` points at, `depth` arrays in
    fn member_storage(&self, b: usize, depth: usize) -> u32 {
        let bad = &self.bads[b];
        bad.wrapper_storage.get(depth).copied().unwrap_or(bad.stored)
    }

    /// The value type there
    fn member_value(&self, b: usize, depth: usize) -> u32 {
        let bad = &self.bads[b];
        bad.wrappers.get(depth).copied().unwrap_or(bad.matrix)
    }

    fn run(mut self) -> Option<(Vec<u32>, u32)> {
        // the variables of laid out memory, and the pointer types to redirect
        let mut ptrs: BTreeMap<u32, Ptr> = BTreeMap::new();
        let mut redirect: BTreeMap<u32, u32> = BTreeMap::new();
        let pointer_types: Vec<(u32, u32, u32)> = self.types.values().filter(|w| Lowering::op(w) == OP_TYPE_POINTER && w.len() >= 4)
            .map(|w| (w[1], w[2], w[3])).collect();
        for (id, class, pointee) in pointer_types {
            if laid_out(class) && self.needs_copy(pointee) {
                let storage = self.storage_of(pointee);
                let p = self.pointer(class, storage);
                redirect.insert(id, p);
            }
        }
        if self.bads.is_empty() {
            return None;
        }
        let pointer_info = |types: &BTreeMap<u32, Vec<u32>>, ty: u32| types.get(&ty).filter(|w| Lowering::op(w) == OP_TYPE_POINTER).map(|w| (w[2], w[3]));
        for w in &self.instructions {
            if Lowering::op(w) == OP_VARIABLE && w.len() >= 4 {
                if let Some((class, pointee)) = pointer_info(&self.types, w[1]) {
                    if laid_out(class) && *self.copy_memo.get(&pointee).unwrap_or(&false) {
                        ptrs.insert(w[2], Ptr::Copied { ty: pointee, class });
                    }
                }
            }
        }
        // the functions
        let first_function = self.instructions.iter().position(|w| Lowering::op(w) == OP_FUNCTION).unwrap_or(self.instructions.len());
        let mut body = Vec::new();
        let instructions = core::mem::take(&mut self.instructions);
        for w in &instructions[first_function..] {
            let op = Lowering::op(w);
            match op {
                OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN if w.len() >= 4 && ptrs.contains_key(&w[3]) => {
                    self.chain(w, &mut ptrs, &mut body)?;
                },
                OP_LOAD if w.len() >= 4 && ptrs.contains_key(&w[3]) => {
                    if w.len() > 4 && w[4] != 0 && w[4] != 2 {
                        // (memory operands other than Aligned: not done)
                        return None;
                    }
                    let info = ptrs[&w[3]].clone();
                    self.load(w[1], w[2], w[3], &info, &mut body)?;
                },
                _ => {
                    // another use of a pointer followed here: not done
                    if w[1..].iter().any(|id| ptrs.contains_key(id)) {
                        return None;
                    }
                    let mut w = w.clone();
                    if w.len() >= 3 && matches!(op, 1 | 55 | 59 | 83 | 169 | 245) {
                        if let Some(&p) = redirect.get(&w[1]) {
                            w[1] = p;
                        }
                    }
                    body.push(w);
                },
            }
        }
        let out = self.assemble(&instructions[..first_function], &redirect, body);
        Some((out, self.bound))
    }

    /// An access chain from a pointer followed here
    fn chain(&mut self, w: &[u32], ptrs: &mut BTreeMap<u32, Ptr>, body: &mut Vec<Vec<u32>>) -> Option<()> {
        let (result, base) = (w[2], w[3]);
        let mut state = Some(ptrs[&base].clone());
        // the chain to emit: its base and indices
        let mut root = base;
        if let Some(Ptr::RowColumn { matrix, .. }) = state {
            root = matrix;
        }
        let mut emitted: Vec<u32> = Vec::new();
        for &index in &w[4..] {
            // (None: out of the kinds followed here, a plain pointer)
            let Some(current) = state.clone() else {
                emitted.push(index);
                continue;
            };
            state = match current {
                Ptr::Copied { ty, class } => {
                    emitted.push(index);
                    let t = self.types[&ty].clone();
                    if Lowering::op(&t) == OP_TYPE_STRUCT {
                        let m = self.constant_value(index)?;
                        let mt = *t.get(2 + m as usize)?;
                        if let Some(&bad) = self.bad_of.get(&(ty, m)) {
                            Some(Ptr::Member { bad, depth: 0, class })
                        }
                        else if *self.copy_memo.get(&mt).unwrap_or(&false) {
                            Some(Ptr::Copied { ty: mt, class })
                        }
                        else {
                            None
                        }
                    }
                    else if *self.copy_memo.get(&t[2]).unwrap_or(&false) {
                        Some(Ptr::Copied { ty: t[2], class })
                    }
                    else {
                        None
                    }
                },
                Ptr::Member { bad, depth, class } => {
                    if depth < self.bads[bad].wrappers.len() {
                        emitted.push(index);
                        Some(Ptr::Member { bad, depth: depth + 1, class })
                    }
                    else if self.bads[bad].row_major {
                        // (a column of a row major one: its index goes after the row's)
                        Some(Ptr::RowColumn { bad, class, matrix: 0, column: index })
                    }
                    else {
                        emitted.push(index);
                        Some(Ptr::Column { bad, class })
                    }
                },
                Ptr::Column { .. } => {
                    emitted.push(index);
                    None
                },
                Ptr::RowColumn { column, .. } => {
                    // an element: the row's component
                    emitted.push(index);
                    emitted.push(column);
                    None
                },
            };
        }
        let chain_op = Lowering::op(w);
        let emit = |ty: u32, id: u32, root: u32, emitted: &[u32], body: &mut Vec<Vec<u32>>| {
            let mut operands = Vec::from([ty, id, root]);
            operands.extend_from_slice(emitted);
            body.push(instruction(chain_op, &operands));
        };
        match state {
            // (a pointer of the type the chain had)
            None => emit(w[1], result, root, &emitted, body),
            Some(Ptr::Copied { ty, class }) => {
                let storage = self.storage_of(ty);
                let p = self.pointer(class, storage);
                emit(p, result, root, &emitted, body);
                ptrs.insert(result, Ptr::Copied { ty, class });
            },
            Some(Ptr::Member { bad, depth, class }) => {
                let storage = self.member_storage(bad, depth);
                let p = self.pointer(class, storage);
                emit(p, result, root, &emitted, body);
                ptrs.insert(result, Ptr::Member { bad, depth, class });
            },
            Some(Ptr::Column { bad, class }) => {
                let vector = self.bads[bad].vector;
                let p = self.pointer(class, vector);
                emit(p, result, root, &emitted, body);
                ptrs.insert(result, Ptr::Column { bad, class });
            },
            Some(Ptr::RowColumn { bad, class, column, .. }) => {
                // the matrix's pointer, the column for the loads
                let stored = self.bads[bad].stored;
                let p = self.pointer(class, stored);
                let matrix = self.fresh();
                emit(p, matrix, root, &emitted, body);
                ptrs.insert(result, Ptr::RowColumn { bad, class, matrix, column });
            },
        }
        Some(())
    }

    /// A load through a pointer followed here, into `result` of type `ty`
    fn load(&mut self, ty: u32, result: u32, pointer: u32, info: &Ptr, body: &mut Vec<Vec<u32>>) -> Option<()> {
        match *info {
            Ptr::Copied { ty: value, class } => self.load_value(pointer, value, class, ty, result, body),
            Ptr::Member { bad, depth, class } => self.load_member(pointer, bad, depth, class, result, body),
            Ptr::Column { bad, .. } => {
                let (vector, rows) = (self.bads[bad].vector, self.bads[bad].rows);
                let loaded = if rows == 4 { result } else { self.fresh() };
                body.push(instruction(OP_LOAD, &[vector, loaded, pointer]));
                if rows == 1 {
                    // (a padded scalar: the vector's first component)
                    body.push(instruction(OP_COMPOSITE_EXTRACT, &[ty, result, loaded, 0]));
                }
                else if rows != 4 {
                    let mut operands = Vec::from([ty, result, loaded, loaded]);
                    operands.extend(0..rows);
                    body.push(instruction(OP_VECTOR_SHUFFLE, &operands));
                }
                Some(())
            },
            Ptr::RowColumn { bad, class, matrix, column } => {
                let (float, rows) = (self.bads[bad].float, self.bads[bad].rows);
                let p = self.pointer(class, float);
                let mut components = Vec::new();
                for r in 0..rows {
                    let (index, at, value) = (self.constant(r), self.fresh(), self.fresh());
                    body.push(instruction(OP_ACCESS_CHAIN, &[p, at, matrix, index, column]));
                    body.push(instruction(OP_LOAD, &[float, value, at]));
                    components.push(value);
                }
                let mut operands = Vec::from([ty, result]);
                operands.extend(components);
                body.push(instruction(OP_COMPOSITE_CONSTRUCT, &operands));
                Some(())
            },
        }
    }

    /// A load of a whole struct or array holding members done over: member by member
    fn load_value(&mut self, pointer: u32, value: u32, class: u32, ty: u32, result: u32, body: &mut Vec<Vec<u32>>) -> Option<()> {
        let t = self.types[&value].clone();
        let mut parts = Vec::new();
        match Lowering::op(&t) {
            OP_TYPE_STRUCT => {
                for (m, &mt) in t[2..].iter().enumerate() {
                    let m = m as u32;
                    let index = self.constant(m);
                    let (at, part) = (self.fresh(), self.fresh());
                    if let Some(&b) = self.bad_of.get(&(value, m)) {
                        let p = { let s = self.member_storage(b, 0); self.pointer(class, s) };
                        body.push(instruction(OP_ACCESS_CHAIN, &[p, at, pointer, index]));
                        self.load_member(at, b, 0, class, part, body)?;
                    }
                    else if *self.copy_memo.get(&mt).unwrap_or(&false) {
                        let p = { let s = self.storage_of(mt); self.pointer(class, s) };
                        body.push(instruction(OP_ACCESS_CHAIN, &[p, at, pointer, index]));
                        self.load_value(at, mt, class, mt, part, body)?;
                    }
                    else {
                        let p = self.pointer(class, mt);
                        body.push(instruction(OP_ACCESS_CHAIN, &[p, at, pointer, index]));
                        body.push(instruction(OP_LOAD, &[mt, part, at]));
                    }
                    parts.push(part);
                }
            },
            OP_TYPE_ARRAY => {
                let element = t[2];
                let length = self.constant_value(t[3])?;
                for i in 0..length {
                    let index = self.constant(i);
                    let (at, part) = (self.fresh(), self.fresh());
                    let p = { let s = self.storage_of(element); self.pointer(class, s) };
                    body.push(instruction(OP_ACCESS_CHAIN, &[p, at, pointer, index]));
                    self.load_value(at, element, class, element, part, body)?;
                    parts.push(part);
                }
            },
            _ => return None,
        }
        let mut operands = Vec::from([ty, result]);
        operands.extend(parts);
        body.push(instruction(OP_COMPOSITE_CONSTRUCT, &operands));
        Some(())
    }

    /// A load of a member done over (`depth` arrays in): the arrays element by element, the matrix of its vectors
    fn load_member(&mut self, pointer: u32, b: usize, depth: usize, class: u32, result: u32, body: &mut Vec<Vec<u32>>) -> Option<()> {
        let bad = self.bads[b].clone();
        if depth < bad.wrappers.len() {
            let length = self.constant_value(self.types[&bad.wrappers[depth]][3])?;
            let p = { let s = self.member_storage(b, depth + 1); self.pointer(class, s) };
            let mut parts = Vec::new();
            for i in 0..length {
                let index = self.constant(i);
                let (at, part) = (self.fresh(), self.fresh());
                body.push(instruction(OP_ACCESS_CHAIN, &[p, at, pointer, index]));
                self.load_member(at, b, depth + 1, class, part, body)?;
                parts.push(part);
            }
            let mut operands = Vec::from([self.member_value(b, depth), result]);
            operands.extend(parts);
            body.push(instruction(OP_COMPOSITE_CONSTRUCT, &operands));
            return Some(());
        }
        let array = self.fresh();
        body.push(instruction(OP_LOAD, &[bad.stored, array, pointer]));
        let mut vectors = Vec::new();
        for k in 0..bad.vectors {
            let v = self.fresh();
            body.push(instruction(OP_COMPOSITE_EXTRACT, &[bad.vector, v, array, k]));
            vectors.push(v);
        }
        let mut columns = Vec::new();
        for c in 0..bad.columns {
            let column = self.fresh();
            if bad.row_major {
                // across the rows
                let mut operands = Vec::from([bad.column, column]);
                for &row in &vectors {
                    let x = self.fresh();
                    body.push(instruction(OP_COMPOSITE_EXTRACT, &[bad.float, x, row, c]));
                    operands.push(x);
                }
                body.push(instruction(OP_COMPOSITE_CONSTRUCT, &operands));
            }
            else if bad.rows == 1 {
                body.push(instruction(OP_COMPOSITE_EXTRACT, &[bad.column, column, vectors[c as usize], 0]));
            }
            else {
                let v = vectors[c as usize];
                let mut operands = Vec::from([bad.column, column, v, v]);
                operands.extend(0..bad.rows);
                body.push(instruction(OP_VECTOR_SHUFFLE, &operands));
            }
            columns.push(column);
        }
        let mut operands = Vec::from([bad.matrix, result]);
        operands.extend(columns);
        body.push(instruction(OP_COMPOSITE_CONSTRUCT, &operands));
        Some(())
    }

    /// The module again: the new annotations after the old (the value
    /// types' layout dropped), the declarations each after what it uses,
    /// the variables' pointer types redirected, the functions
    fn assemble(&mut self, globals: &[Vec<u32>], redirect: &BTreeMap<u32, u32>, body: Vec<Vec<u32>>) -> Vec<u32> {
        let copied: BTreeSet<u32> = self.copy_memo.iter().filter(|(_, &n)| n).map(|(&id, _)| id).collect();
        // (and a padded array's own type: a value type now)
        let wrappers: BTreeSet<u32> = self.bads.iter().flat_map(|b| b.wrappers.iter().copied().chain(b.padded.then_some(b.matrix))).collect();
        let bad_members: BTreeSet<(u32, u32)> = self.bad_of.keys().copied().collect();
        let mut out: Vec<u32> = Vec::new();
        let header = globals.iter().position(|w| !preamble(Lowering::op(w))).unwrap_or(globals.len());
        for w in &globals[..header] {
            let op = Lowering::op(w);
            // the value types: no layout
            if op == OP_DECORATE && w.len() >= 3 && ((copied.contains(&w[1]) && matches!(w[2], DECORATION_ARRAY_STRIDE | DECORATION_BLOCK | DECORATION_BUFFER_BLOCK))
                || wrappers.contains(&w[1]) && w[2] == DECORATION_ARRAY_STRIDE) {
                continue;
            }
            if op == OP_MEMBER_DECORATE && w.len() >= 4 && (copied.contains(&w[1]) || bad_members.contains(&(w[1], w[2])))
                && matches!(w[3], DECORATION_OFFSET | DECORATION_MATRIX_STRIDE | DECORATION_ROW_MAJOR | DECORATION_COL_MAJOR) {
                continue;
            }
            out.extend_from_slice(w);
        }
        for a in &self.new_annotations {
            out.extend_from_slice(a);
        }
        // the declarations, each after the ids it uses
        let mut declarations: Vec<Vec<u32>> = globals[header..].to_vec();
        for w in declarations.iter_mut() {
            if Lowering::op(w) == OP_VARIABLE && w.len() >= 3 {
                if let Some(&p) = redirect.get(&w[1]) {
                    w[1] = p;
                }
            }
        }
        let original = declarations.len();
        declarations.extend(self.new_globals.iter().cloned());
        let defined = |w: &[u32]| -> Option<u32> {
            match Lowering::op(w) {
                19..=38 | 322 | 4456 | 5341 | 6086 => w.get(1).copied(),
                39 => None,
                _ => w.get(2).copied(),
            }
        };
        let mut by_id: BTreeMap<u32, usize> = BTreeMap::new();
        for (i, w) in declarations.iter().enumerate() {
            if let Some(id) = defined(w) {
                by_id.entry(id).or_insert(i);
            }
        }
        let uses = |w: &[u32]| -> Vec<u32> {
            match Lowering::op(w) {
                OP_TYPE_INT | OP_TYPE_FLOAT | 19 | 20 => Vec::new(),
                OP_TYPE_VECTOR | OP_TYPE_MATRIX | 27 | 25 => w.get(2).copied().into_iter().collect(),
                OP_TYPE_POINTER => w.get(3).copied().into_iter().collect(),
                OP_CONSTANT | 50 | 41 | 42 | 46 | 1 => w.get(1).copied().into_iter().collect(),
                OP_VARIABLE => { let mut u = Vec::from([w[1]]); u.extend(w.get(4).copied()); u },
                op if (19..=39).contains(&op) => w[2..].to_vec(),
                _ => { let mut u = Vec::from([w[1]]); u.extend_from_slice(w.get(3..).unwrap_or(&[])); u },
            }
        };
        let mut state = Vec::from_iter(core::iter::repeat(0u8).take(declarations.len()));
        let mut order = Vec::new();
        fn visit(i: usize, declarations: &[Vec<u32>], by_id: &BTreeMap<u32, usize>, uses: &dyn Fn(&[u32]) -> Vec<u32>, state: &mut Vec<u8>, order: &mut Vec<usize>) {
            if state[i] != 0 {
                return;
            }
            state[i] = 1;
            for id in uses(&declarations[i]) {
                if let Some(&j) = by_id.get(&id) {
                    if j != i {
                        visit(j, declarations, by_id, uses, state, order);
                    }
                }
            }
            state[i] = 2;
            order.push(i);
        }
        for i in 0..declarations.len() {
            if i < original || state[i] == 0 {
                visit(i, &declarations, &by_id, &uses, &mut state, &mut order);
            }
        }
        for i in order {
            out.extend_from_slice(&declarations[i]);
        }
        for w in body {
            out.extend_from_slice(&w);
        }
        out
    }
}

/// The module with those matrices done over, or the words as they were
pub fn lower(words: &[u32]) -> Vec<u32> {
    match Lowering::new(words).and_then(|l| l.run()) {
        Some((rest, bound)) => {
            let mut out = words[..5].to_vec();
            out[3] = bound;
            out.extend(rest);
            out
        },
        None => words.to_vec(),
    }
}
