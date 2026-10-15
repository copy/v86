//! Runs of register-only x87 forms (FLD ST(i)/FLD1/FLDZ, arithmetic on
//! ST(i), FXCH, FST(P) ST(i), FCHS/FABS, FFREE) with their stack positions
//! known relative to the TOP at the run's start: one guard checks that every
//! slot read holds an exact cached f64 and every slot pushed is empty, then
//! the run computes in f64 locals and commits once. The results are exactly
//! those of the per-form native path (x86tpl::x87), which runs the
//! instructions one by one when the guard fails. Tier-0 and the page tier's
//! compatibility mode (docs/jit-unification-plan.md P7.2a) emit them; the
//! caller checks CR0 (#NM) and gp::x87_native_policy first.
use super::x87::X87Cache;
use crate::cpu::{fpu, global_pointers as gp};
use crate::wasmgen::wasm_builder::{Label, WasmBuilder, WasmLocalF64};
use crate::x86tpl::x87_forms::{Arithmetic, Io, Native, Source};

const C1: i32 = 0x200;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tag {
    Unknown,
    Full,
    Empty,
}
#[derive(Clone, Copy)]
enum Value {
    /// Loaded at the run's start from the slot `k` (relative to entry TOP).
    Entry(u8),
    Constant(bool),
    /// The result of step `n`.
    Step(usize),
}
#[derive(Clone, Copy)]
enum Step {
    Arithmetic(Arithmetic, Value, Value),
    Unary(bool, Value),
}

/// Compile-time stack of one run, positions relative to the entry TOP.
#[derive(Clone)]
pub struct X87Run {
    /// Current TOP relative to the entry TOP.
    top: u8,
    tags: [Tag; 8],
    values: [Option<Value>; 8],
    steps: Vec<Step>,
    need_full: u8,
    need_empty: u8,
    written: u8,
    pushed: bool,
    /// The forms in the run.
    pub length: usize,
}
impl X87Run {
    pub fn new() -> Self {
        X87Run {
            top: 0,
            tags: [Tag::Unknown; 8],
            values: [None; 8],
            steps: vec![],
            need_full: 0,
            need_empty: 0,
            written: 0,
            pushed: false,
            length: 0,
        }
    }
    fn rel(&self, r: u8) -> usize { (self.top + r) as usize & 7 }
    fn read(&mut self, r: u8) -> Option<Value> {
        let k = self.rel(r);
        match self.tags[k] {
            Tag::Empty => None,
            Tag::Full => Some(self.values[k].unwrap_or(Value::Entry(k as u8))),
            Tag::Unknown => {
                self.need_full |= 1 << k;
                self.tags[k] = Tag::Full;
                self.values[k] = Some(Value::Entry(k as u8));
                self.values[k]
            },
        }
    }
    fn write(&mut self, r: u8, value: Value) {
        let k = self.rel(r);
        self.values[k] = Some(value);
        self.written |= 1 << k;
    }
    fn pop(&mut self) {
        let k = self.rel(0);
        self.tags[k] = Tag::Empty;
        self.top = (self.top + 1) & 7;
    }
    /// Add the form `opcode` (0xD8..0xDF) `modrm`; false (run unchanged) if
    /// it cannot join the run: only register forms (crate::x86tpl::x87_forms::io's
    /// Stack) with a native form can.
    pub fn append(&mut self, opcode: u8, modrm: u8) -> bool {
        if !(0xD8..=0xDF).contains(&opcode)
            || crate::x86tpl::x87_forms::io(opcode, modrm) != Some(Io::Stack)
        {
            return false;
        }
        let Some(native) = crate::x86tpl::x87_forms::native(opcode, modrm)
        else {
            return false;
        };
        let mut next = self.clone();
        let ok = (|| {
            match native {
                Native::Push(source) => {
                    let value = match source {
                        Source::Register(r) => next.read(r)?,
                        Source::Constant(one) => Value::Constant(one),
                        Source::Memory(_) => return None,
                    };
                    let k = next.rel(7);
                    match next.tags[k] {
                        Tag::Full => return None,
                        Tag::Unknown => next.need_empty |= 1 << k,
                        Tag::Empty => {},
                    }
                    next.tags[k] = Tag::Full;
                    next.top = k as u8;
                    next.write(0, value);
                    next.pushed = true;
                },
                Native::Arithmetic {
                    op,
                    source: Source::Register(r),
                    target,
                    pops,
                } => {
                    let x = next.read(0)?;
                    let y = next.read(r)?;
                    next.steps.push(Step::Arithmetic(op, x, y));
                    next.write(target, Value::Step(next.steps.len() - 1));
                    for _ in 0..pops {
                        next.pop();
                    }
                },
                Native::Exchange(r) => {
                    let a = next.read(0)?;
                    let b = next.read(r)?;
                    next.write(0, b);
                    next.write(r, a);
                },
                Native::Copy { r, pops } => {
                    let value = next.read(0)?;
                    let k = next.rel(r);
                    next.tags[k] = Tag::Full;
                    next.write(r, value);
                    for _ in 0..pops {
                        next.pop();
                    }
                },
                Native::Unary { negate } => {
                    let value = next.read(0)?;
                    next.steps.push(Step::Unary(negate, value));
                    next.write(0, Value::Step(next.steps.len() - 1));
                },
                Native::Free { r, pops } => {
                    let k = next.rel(r);
                    next.tags[k] = Tag::Empty;
                    for _ in 0..pops {
                        next.pop();
                    }
                },
                _ => return None,
            }
            Some(())
        })();
        if ok.is_none() {
            return false;
        }
        next.length += 1;
        *self = next;
        true
    }
}

/// Emit the run's fast path: to `slow` unless the guard holds, else the
/// run's effect on the open x87 cache `c` and the f64 shadow values.
pub fn x87_run(w: &mut WasmBuilder, c: &X87Cache, plan: &X87Run, slow: Label) {
    let [values, _, _] = fpu::x87_cache_addresses();
    // Masks relative to TOP: rotate right by TOP (8 bits).
    let rotate = |w: &mut WasmBuilder, mask: &dyn Fn(&mut WasmBuilder)| {
        mask(w);
        w.get_local(&c.top);
        w.shr_u_i32();
        mask(w);
        w.const_i32(8);
        w.get_local(&c.top);
        w.sub_i32();
        w.shl_i32();
        w.or_i32();
        w.const_i32(255);
        w.and_i32();
    };
    if plan.need_full != 0 {
        // Every slot read: nonempty and an exact cached value.
        rotate(w, &|w: &mut WasmBuilder| {
            w.get_local(&c.valid);
            w.const_i32(-1);
            w.xor_i32();
            w.get_local(&c.tags);
            w.or_i32();
            w.const_i32(255);
            w.and_i32();
        });
        w.const_i32(plan.need_full as i32);
        w.and_i32();
        w.hint(false);
        w.br_if(slow);
    }
    if plan.need_empty != 0 {
        rotate(w, &|w: &mut WasmBuilder| w.get_local(&c.tags));
        w.const_i32(plan.need_empty as i32);
        w.and_i32();
        w.const_i32(plan.need_empty as i32);
        w.ne_i32();
        w.hint(false);
        w.br_if(slow);
    }
    let slot = |w: &mut WasmBuilder, k: u8| {
        w.get_local(&c.top);
        w.const_i32(k as i32);
        w.add_i32();
        w.const_i32(7);
        w.and_i32();
    };
    let mut entry: [Option<WasmLocalF64>; 8] = Default::default();
    for k in 0..8u8 {
        if plan.need_full & 1 << k != 0 {
            slot(w, k);
            w.const_i32(3);
            w.shl_i32();
            w.load_aligned_f64(values);
            entry[k as usize] = Some(w.set_new_local_f64());
        }
    }
    let mut results: Vec<WasmLocalF64> = vec![];
    let push = |w: &mut WasmBuilder,
                v: Value,
                results: &[WasmLocalF64],
                entry: &[Option<WasmLocalF64>; 8]| match v {
        Value::Entry(k) => w.get_local_f64(entry[k as usize].as_ref().unwrap()),
        Value::Constant(one) => w.const_f64(if one { 1.0 } else { 0.0 }),
        Value::Step(n) => w.get_local_f64(&results[n]),
    };
    for step in &plan.steps {
        match *step {
            Step::Arithmetic(op, x, y) => {
                let (a, b) = match op {
                    Arithmetic::SubR | Arithmetic::DivR => (y, x),
                    _ => (x, y),
                };
                push(w, a, &results, &entry);
                push(w, b, &results, &entry);
                w.arithmetic_f64(match op {
                    Arithmetic::Add => 0,
                    Arithmetic::Sub | Arithmetic::SubR => 1,
                    Arithmetic::Mul => 2,
                    Arithmetic::Div | Arithmetic::DivR => 3,
                });
            },
            Step::Unary(negate, v) => {
                push(w, v, &results, &entry);
                w.unary_f64(negate);
            },
        }
        results.push(w.set_new_local_f64());
    }
    // Commit: values of written slots (VALID|DIRTY), tags, TOP, C1.
    for k in 0..8u8 {
        if plan.written & 1 << k == 0 {
            continue;
        }
        slot(w, k);
        w.const_i32(3);
        w.shl_i32();
        push(w, plan.values[k as usize].unwrap(), &results, &entry);
        w.store_aligned_f64(values);
    }
    let mut full = 0u8;
    let mut empty = 0u8;
    for k in 0..8 {
        match plan.tags[k] {
            // Pushed/copied slots were set full; read slots stay full.
            Tag::Full if plan.written & 1 << k != 0 || plan.need_empty & 1 << k != 0 => {
                full |= 1 << k
            },
            Tag::Empty => empty |= 1 << k,
            _ => {},
        }
    }
    // Rotate compile-time relative masks left by TOP into physical bits.
    let physical = |w: &mut WasmBuilder, mask: u8| {
        w.const_i32(mask as i32);
        w.get_local(&c.top);
        w.shl_i32();
        w.const_i32(mask as i32);
        w.const_i32(8);
        w.get_local(&c.top);
        w.sub_i32();
        w.shr_u_i32();
        w.or_i32();
        w.const_i32(255);
        w.and_i32();
    };
    if plan.written != 0 {
        for local in [&c.valid, &c.dirty] {
            w.get_local(local);
            physical(w, plan.written);
            w.or_i32();
            w.set_local(local);
        }
    }
    if full != 0 || empty != 0 {
        w.get_local(&c.tags);
        physical(w, empty);
        w.or_i32();
        physical(w, full);
        w.const_i32(-1);
        w.xor_i32();
        w.and_i32();
        w.set_local(&c.tags);
    }
    if plan.top != 0 {
        w.get_local(&c.top);
        w.const_i32(plan.top as i32);
        w.add_i32();
        w.const_i32(7);
        w.and_i32();
        w.set_local(&c.top);
    }
    if plan.pushed {
        w.const_i32(gp::fpu_status_word as i32);
        w.load_fixed_u16(gp::fpu_status_word as u32);
        w.const_i32(!C1);
        w.and_i32();
        w.store_aligned_u16(0);
    }
    for local in entry.into_iter().flatten().chain(results) {
        w.free_local_f64(local);
    }
}
