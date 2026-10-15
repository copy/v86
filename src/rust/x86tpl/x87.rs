//! Inlined fast-math x87 against the shared f64 shadow cache (moved from the
//! region backend in docs/jit-unification-plan.md P2.2; the x64 page tier's
//! templates use it since M11 deleted the region backend).
//!
//! Semantics match `cpu::fpu`'s cached paths: operands are read only from
//! full, VALID cache slots, results are written as VALID|DIRTY f64 values
//! (F80 materializes lazily), and TOP/tags/status change as the interpreter's
//! helpers change them. Every check precedes the first CPU write; any failed
//! check runs the canonical helper (`x64_x87`) instead, from unchanged state.
use crate::cpu::{fpu, global_pointers as gp};
use crate::wasmgen::wasm_builder::{Label, WasmBuilder, WasmLocal, WasmLocalF64};
use crate::x86tpl::x87_forms::{Arithmetic, Native, Operand, Source, Stored};

const C1: i32 = 0x200;
const CONDITION_CODES: i32 = 0x4700;

/// Mutable view of the stack registers while one instruction is inlined.
struct Stack {
    top: WasmLocal,
    tags: WasmLocal,
    /// VALID & !tags at entry: slots that hold an exact cached f64.
    ready: WasmLocal,
    written: Vec<(WasmLocal, WasmLocalF64)>,
    tags_changed: bool,
    top_changed: bool,
    /// top/tags are these caller-owned locals; VALID/DIRTY live in them too.
    cache: Option<X87Cache>,
}

/// Operand words of a natively inlined x87 form: the loaded memory operand
/// (words 0 and 1) and the value to store (outputs 0 and 1).
pub trait X87Words {
    fn w(&mut self) -> &mut WasmBuilder;
    /// Push input word `k`.
    fn input(&mut self, k: usize);
    /// Pop into output word `k`.
    fn output(&mut self, k: usize);
    /// Caller-owned locals holding the CPU's x87 bookkeeping across forms,
    /// or None: the form loads and stores it itself.
    fn cache(&mut self) -> Option<X87Cache> { None }
}
/// TOP, tags (fpu_stack_empty) and the shadow cache VALID/DIRTY masks in
/// locals (Tier-0 keeps them across a run of x87 forms). The caller writes
/// them back before anything else reads the CPU state.
pub struct X87Cache {
    pub top: WasmLocal,
    pub tags: WasmLocal,
    pub valid: WasmLocal,
    pub dirty: WasmLocal,
}
impl X87Cache {
    pub fn unsafe_clone(&self) -> Self {
        Self {
            top: self.top.unsafe_clone(),
            tags: self.tags.unsafe_clone(),
            valid: self.valid.unsafe_clone(),
            dirty: self.dirty.unsafe_clone(),
        }
    }
}

pub fn x87_native<T: X87Words>(t: &mut T, native: Native, slow: Label) {
    let [_, valid_address, _] = fpu::x87_cache_addresses();
    let cache = t.cache();
    let (top, tags) = match &cache {
        Some(c) => (c.top.unsafe_clone(), c.tags.unsafe_clone()),
        None => {
            t.w().load_fixed_u8(gp::fpu_stack_ptr as u32);
            let top = t.w().set_new_local();
            t.w().load_fixed_u8(gp::fpu_stack_empty as u32);
            (top, t.w().set_new_local())
        },
    };
    match &cache {
        Some(c) => t.w().get_local(&c.valid),
        None => t.w().load_fixed_i32(valid_address),
    }
    t.w().get_local(&tags);
    t.w().const_i32(-1);
    t.w().xor_i32();
    t.w().and_i32();
    let ready = t.w().set_new_local();
    let mut s = Stack {
        top,
        tags,
        ready,
        written: vec![],
        tags_changed: false,
        top_changed: false,
        cache,
    };
    // Phase 1: checks and results in locals. Phase 2 (commit) writes CPU state.
    let mut status: Option<WasmLocal> = None;
    let mut pops = 0;
    let mut clear_c1 = false;
    match native {
        Native::Push(source) => {
            let value = x87_source(t, &s, source, slow);
            let slot = x87_slot(t, &s, 7);
            // The destination must be empty: overflow sets flags in F80.
            t.w().get_local(&s.tags);
            t.w().get_local(&slot);
            t.w().shr_u_i32();
            t.w().const_i32(1);
            t.w().and_i32();
            t.w().eqz_i32();
            t.w().hint(false);
            t.w().br_if(slow);
            t.w().get_local(&slot);
            t.w().set_local(&s.top);
            s.top_changed = true;
            x87_clear_tag(t, &mut s, &slot);
            s.written.push((slot, value));
            clear_c1 = true;
        },
        Native::Arithmetic {
            op,
            source,
            target,
            pops: n,
        } => {
            let x = x87_read(t, &s, 0, slow);
            let y = x87_source(t, &s, source, slow);
            let (a, b) = match op {
                Arithmetic::SubR | Arithmetic::DivR => (&y, &x),
                _ => (&x, &y),
            };
            t.w().get_local_f64(a);
            t.w().get_local_f64(b);
            t.w().arithmetic_f64(match op {
                Arithmetic::Add => 0,
                Arithmetic::Sub | Arithmetic::SubR => 1,
                Arithmetic::Mul => 2,
                Arithmetic::Div | Arithmetic::DivR => 3,
            });
            let result = t.w().set_new_local_f64();
            t.w().free_local_f64(x);
            t.w().free_local_f64(y);
            let slot = x87_slot(t, &s, target);
            s.written.push((slot, result));
            pops = n;
        },
        Native::Compare { source, pops: n } => {
            let x = x87_read(t, &s, 0, slow);
            let y = x87_source(t, &s, source, slow);
            // Unordered compares raise #IA in F80; leave NaNs to it.
            for v in [&x, &y] {
                t.w().get_local_f64(v);
                t.w().get_local_f64(v);
                t.w().ne_f64();
                t.w().hint(false);
                t.w().br_if(slow);
            }
            t.w().load_fixed_u16(gp::fpu_status_word as u32);
            t.w().const_i32(!CONDITION_CODES);
            t.w().and_i32();
            t.w().get_local_f64(&x);
            t.w().get_local_f64(&y);
            t.w().compare_f64(1); // C0: x < y
            t.w().const_i32(8);
            t.w().shl_i32();
            t.w().or_i32();
            t.w().get_local_f64(&x);
            t.w().get_local_f64(&y);
            t.w().compare_f64(2); // C3: x == y
            t.w().const_i32(14);
            t.w().shl_i32();
            t.w().or_i32();
            status = Some(t.w().set_new_local());
            t.w().free_local_f64(x);
            t.w().free_local_f64(y);
            pops = n;
        },
        Native::Exchange(r) => {
            let a = x87_read(t, &s, 0, slow);
            let b = x87_read(t, &s, r, slow);
            let slot = x87_slot(t, &s, 0);
            s.written.push((slot, b));
            let slot = x87_slot(t, &s, r);
            s.written.push((slot, a));
        },
        Native::Copy { r, pops: n } => {
            let value = x87_read(t, &s, 0, slow);
            let slot = x87_slot(t, &s, r);
            x87_clear_tag(t, &mut s, &slot);
            s.written.push((slot, value));
            pops = n;
        },
        Native::Unary { negate } => {
            let value = x87_read(t, &s, 0, slow);
            t.w().get_local_f64(&value);
            t.w().unary_f64(negate);
            t.w().set_local_f64(&value);
            let slot = x87_slot(t, &s, 0);
            s.written.push((slot, value));
        },
        Native::Free { r, pops: n } => {
            let slot = x87_slot(t, &s, r);
            t.w().get_local(&s.tags);
            t.w().const_i32(1);
            t.w().get_local(&slot);
            t.w().shl_i32();
            t.w().or_i32();
            t.w().set_local(&s.tags);
            s.tags_changed = true;
            t.w().free_local(slot);
            pops = n;
        },
        Native::Store { to, pops: n } => {
            let value = x87_read(t, &s, 0, slow);
            x87_store(t, to, &value, slow);
            t.w().free_local_f64(value);
            pops = n;
        },
        Native::StoreControl => {
            t.w().load_fixed_u16(gp::fpu_control_word as u32);
            t.output(0);
            t.w().const_i32(0);
            t.output(1);
        },
        Native::StoreStatus => {
            t.w().load_fixed_u16(gp::fpu_status_word as u32);
            t.w().const_i32(!(7 << 11));
            t.w().and_i32();
            t.w().get_local(&s.top);
            t.w().const_i32(11);
            t.w().shl_i32();
            t.w().or_i32();
            t.output(0);
            t.w().const_i32(0);
            t.output(1);
        },
    }
    for _ in 0..pops {
        // fpu_pop: tag the old TOP empty, then TOP += 1.
        t.w().get_local(&s.tags);
        t.w().const_i32(1);
        t.w().get_local(&s.top);
        t.w().shl_i32();
        t.w().or_i32();
        t.w().set_local(&s.tags);
        t.w().get_local(&s.top);
        t.w().const_i32(1);
        t.w().add_i32();
        t.w().const_i32(7);
        t.w().and_i32();
        t.w().set_local(&s.top);
        s.tags_changed = true;
        s.top_changed = true;
    }
    x87_commit(t, s, status, clear_c1);
}

/// ST(r)'s physical slot: (TOP + r) & 7.
fn x87_slot<T: X87Words>(t: &mut T, s: &Stack, r: u8) -> WasmLocal {
    t.w().get_local(&s.top);
    t.w().const_i32(r as i32);
    t.w().add_i32();
    t.w().const_i32(7);
    t.w().and_i32();
    t.w().set_new_local()
}

/// ST(r) from a full, exactly cached slot; anything else takes `slow`.
fn x87_read<T: X87Words>(t: &mut T, s: &Stack, r: u8, slow: Label) -> WasmLocalF64 {
    let [values, _, _] = fpu::x87_cache_addresses();
    let slot = x87_slot(t, s, r);
    t.w().get_local(&s.ready);
    t.w().get_local(&slot);
    t.w().shr_u_i32();
    t.w().const_i32(1);
    t.w().and_i32();
    t.w().eqz_i32();
    t.w().hint(false);
    t.w().br_if(slow);
    t.w().get_local(&slot);
    t.w().const_i32(3);
    t.w().shl_i32();
    t.w().load_aligned_f64(values);
    t.w().free_local(slot);
    t.w().set_new_local_f64()
}

fn x87_clear_tag<T: X87Words>(t: &mut T, s: &mut Stack, slot: &WasmLocal) {
    t.w().get_local(&s.tags);
    t.w().const_i32(1);
    t.w().get_local(slot);
    t.w().shl_i32();
    t.w().const_i32(-1);
    t.w().xor_i32();
    t.w().and_i32();
    t.w().set_local(&s.tags);
    s.tags_changed = true;
}

/// A memory operand, register or constant as an f64. NaN memory operands
/// take `slow` (the F80 conversion may quiet them and raise #IA).
fn x87_source<T: X87Words>(t: &mut T, s: &Stack, source: Source, slow: Label) -> WasmLocalF64 {
    match source {
        Source::Register(r) => return x87_read(t, s, r, slow),
        Source::Constant(one) => {
            t.w().const_f64(if one { 1.0 } else { 0.0 });
            return t.w().set_new_local_f64();
        },
        Source::Memory(operand) => match operand {
            Operand::F32 => {
                t.input(0);
                t.w().reinterpret_i32_as_f32();
                t.w().promote_f32_to_f64();
            },
            Operand::F64 | Operand::I64 => {
                t.input(1);
                t.w().extend_unsigned_i32_to_i64();
                t.w().const_i64(32);
                t.w().shl_i64();
                t.input(0);
                t.w().extend_unsigned_i32_to_i64();
                t.w().or_i64();
                if operand == Operand::F64 {
                    t.w().reinterpret_i64_as_f64();
                }
                else {
                    // Only |v| <= 2^53 converts exactly to binary64.
                    let integer = t.w().set_new_local_i64();
                    t.w().get_local_i64(&integer);
                    t.w().const_i64(1 << 53);
                    t.w().add_i64();
                    t.w().const_i64(1 << 54);
                    t.w().gtu_i64();
                    t.w().hint(false);
                    t.w().br_if(slow);
                    t.w().get_local_i64(&integer);
                    t.w().convert_i64_to_f64();
                    t.w().free_local_i64(integer);
                }
            },
            Operand::I32 => {
                t.input(0);
                t.w().convert_i32_to_f64();
            },
            Operand::I16 => {
                t.input(0);
                t.w().const_i32(16);
                t.w().shl_i32();
                t.w().const_i32(16);
                t.w().shr_s_i32();
                t.w().convert_i32_to_f64();
            },
        },
    }
    let value = t.w().set_new_local_f64();
    if matches!(source, Source::Memory(Operand::F32 | Operand::F64)) {
        t.w().get_local_f64(&value);
        t.w().get_local_f64(&value);
        t.w().ne_f64();
        t.w().hint(false);
        t.w().br_if(slow);
    }
    value
}

/// FST(P) m32/m64 and FIST(P)/FISTTP bits. Results needing F80 rounding
/// flags (tiny f32, NaN, integer overflow) or directed f32 rounding take `slow`.
fn x87_store<T: X87Words>(t: &mut T, to: Stored, value: &WasmLocalF64, slow: Label) {
    match to {
        Stored::F64 => {
            t.w().get_local_f64(value);
            t.w().reinterpret_f64_as_i64();
            x87_set_wide(t);
        },
        Stored::F32 => {
            t.w().load_fixed_u16(gp::fpu_control_word as u32);
            t.w().const_i32(0xC00);
            t.w().and_i32();
            t.w().hint(false);
            t.w().br_if(slow);
            t.w().get_local_f64(value);
            t.w().demote_f64_to_f32();
            t.w().reinterpret_f32_as_i32();
            let bits = t.w().set_new_local();
            // Accept zero or a strictly normal/infinite result: no underflow.
            t.w().get_local(&bits);
            t.w().const_i32(0x7FFFFFFF);
            t.w().and_i32();
            t.w().const_i32(0x00800000);
            t.w().gtu_i32();
            t.w().get_local_f64(value);
            t.w().const_f64(0.0);
            t.w().compare_f64(2);
            t.w().or_i32();
            t.w().get_local(&bits);
            t.w().const_i32(0x7FFFFFFF);
            t.w().and_i32();
            t.w().const_i32(0x7F800000);
            t.w().leu_i32();
            t.w().and_i32();
            t.w().eqz_i32();
            t.w().hint(false);
            t.w().br_if(slow);
            t.w().get_local(&bits);
            t.output(0);
            t.w().const_i32(0);
            t.output(1);
            t.w().free_local(bits);
        },
        Stored::Integer { bytes, truncate } => {
            if truncate {
                t.w().get_local_f64(value);
                t.w().round_f64(3);
            }
            else {
                // RC 0..3: nearest, down, up, toward zero.
                t.w().load_fixed_u16(gp::fpu_control_word as u32);
                t.w().const_i32(10);
                t.w().shr_u_i32();
                t.w().const_i32(3);
                t.w().and_i32();
                let rc = t.w().set_new_local();
                t.w().get_local_f64(value);
                t.w().round_f64(0);
                let rounded = t.w().set_new_local_f64();
                for mode in 1..4 {
                    // select(a, b, c) = c ? a : b
                    t.w().get_local_f64(value);
                    t.w().round_f64(mode);
                    t.w().get_local_f64(&rounded);
                    t.w().get_local(&rc);
                    t.w().const_i32(mode as i32);
                    t.w().eq_i32();
                    t.w().select();
                    t.w().set_local_f64(&rounded);
                }
                t.w().get_local_f64(&rounded);
                t.w().free_local_f64(rounded);
                t.w().free_local(rc);
            }
            let rounded = t.w().set_new_local_f64();
            // In range after rounding; NaN fails both comparisons.
            let (low, high, below) = match bytes {
                2 => (-32768.0, 32767.0, false),
                4 => (-2147483648.0, 2147483647.0, false),
                _ => (-9223372036854775808.0, 9223372036854775808.0, true),
            };
            t.w().get_local_f64(&rounded);
            t.w().const_f64(low);
            t.w().ge_f64();
            t.w().get_local_f64(&rounded);
            t.w().const_f64(high);
            if below {
                t.w().compare_f64(1);
            }
            else {
                t.w().le_f64();
            }
            t.w().and_i32();
            t.w().eqz_i32();
            t.w().hint(false);
            t.w().br_if(slow);
            t.w().get_local_f64(&rounded);
            if bytes == 8 {
                t.w().trunc_f64_to_i64();
                x87_set_wide(t);
            }
            else {
                t.w().trunc_f64_to_i32();
                if bytes == 2 {
                    t.w().const_i32(0xFFFF);
                    t.w().and_i32();
                }
                t.output(0);
                t.w().const_i32(0);
                t.output(1);
            }
            t.w().free_local_f64(rounded);
        },
    }
}

fn x87_set_wide<T: X87Words>(t: &mut T) {
    let wide = t.w().set_new_local_i64();
    t.w().get_local_i64(&wide);
    t.w().wrap_i64_to_i32();
    t.output(0);
    t.w().get_local_i64(&wide);
    t.w().const_i64(32);
    t.w().shr_u_i64();
    t.w().wrap_i64_to_i32();
    t.output(1);
    t.w().free_local_i64(wide);
}

fn x87_commit<T: X87Words>(t: &mut T, s: Stack, status: Option<WasmLocal>, clear_c1: bool) {
    let [values, valid, dirty] = fpu::x87_cache_addresses();
    if !s.written.is_empty() {
        let mut mask: Option<WasmLocal> = None;
        for (slot, value) in &s.written {
            t.w().get_local(slot);
            t.w().const_i32(3);
            t.w().shl_i32();
            t.w().get_local_f64(value);
            t.w().store_aligned_f64(values);
            t.w().const_i32(1);
            t.w().get_local(slot);
            t.w().shl_i32();
            if let Some(mask) = &mask {
                t.w().get_local(mask);
                t.w().or_i32();
                t.w().set_local(mask);
            }
            else {
                mask = Some(t.w().set_new_local());
            }
        }
        let mask = mask.unwrap();
        match &s.cache {
            Some(c) => {
                for local in [&c.valid, &c.dirty] {
                    t.w().get_local(local);
                    t.w().get_local(&mask);
                    t.w().or_i32();
                    t.w().set_local(local);
                }
            },
            None => {
                for address in [valid, dirty] {
                    t.w().const_i32(address as i32);
                    t.w().load_fixed_i32(address);
                    t.w().get_local(&mask);
                    t.w().or_i32();
                    t.w().store_aligned_i32(0);
                }
            },
        }
        t.w().free_local(mask);
    }
    for (slot, value) in s.written {
        t.w().free_local(slot);
        t.w().free_local_f64(value);
    }
    if s.top_changed && s.cache.is_none() {
        t.w().const_i32(gp::fpu_stack_ptr as i32);
        t.w().get_local(&s.top);
        t.w().store_u8(0);
    }
    if s.tags_changed && s.cache.is_none() {
        t.w().const_i32(gp::fpu_stack_empty as i32);
        t.w().get_local(&s.tags);
        t.w().store_u8(0);
    }
    if let Some(status) = status {
        t.w().const_i32(gp::fpu_status_word as i32);
        t.w().get_local(&status);
        t.w().store_aligned_u16(0);
        t.w().free_local(status);
    }
    else if clear_c1 {
        t.w().const_i32(gp::fpu_status_word as i32);
        t.w().load_fixed_u16(gp::fpu_status_word as u32);
        t.w().const_i32(!C1);
        t.w().and_i32();
        t.w().store_aligned_u16(0);
    }
    if s.cache.is_none() {
        t.w().free_local(s.top);
        t.w().free_local(s.tags);
    }
    t.w().free_local(s.ready);
}
