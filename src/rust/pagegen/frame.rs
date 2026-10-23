//! The neutral skeleton of a page function (docs/jit-unification-plan.md
//! P5.9): one Wasm function serves the compiled block starts of a guest code
//! page (or a span of consecutive pages). Its frame, from the outside in:
//!
//! - exit: the function's way out (the ISA writes its state back and
//!   returns the instructions retired)
//! - leave: the PC left the function's pages (the ISA may chain to the new
//!   page's function, P5.8)
//! - retry: a template refused before any of its effects (the runtime
//!   interprets the instruction)
//! - dispatch: a loop over the page's units, entered at the head (the
//!   budget) and the dispatch on the PC's offset (a table, or buckets of
//!   compares, PageEmitter::page_dispatch)
//! - step: the instruction at the PC is interpreted in place (jitrt::step),
//!   then the function dispatches again
//!
//! The units are the structured layout of the block graph (P4.16,
//! crate::pagegen::loops): each cycle a Wasm loop with its own head and
//! dispatch over its members, so back edges re-enter the loop, not the page
//! dispatch; `goto` continues at a later block of a level directly, at an
//! earlier one through its level's head. The skeleton also emits the access
//! cache lookups (jitrt::access, P4.14: the module's outlined lookup
//! function and the inline lookup) and the chaining lookup (jitrt::chain).
//! Flags, the PC's representation, the state's write-back, the single-step
//! context and the choice of the memory access path stay with the ISA
//! (crate::x64::pagegen for x86), which implements PageEmitter.
//!
//! Imports: std, crate::wasmgen, crate::leb, crate::jitrt and itself; no ISA
//! and no `feature = "aarch64"` (tools/check_x86tpl_imports.mjs).

use super::loops::{flatten, units, visit_loops, Unit, MAX_LOOP_TABLE, MAX_LOOP_TABLES};
use crate::jitrt::{access, chain};
use crate::wasmgen::wasm_builder::{
    Label, Signature, WasmBuilder, WasmLocal, WasmLocalI64, WasmType,
};
use crate::wasmgen::wasm_opcodes as op;
use std::collections::{BTreeMap, HashMap};

/// The function's labels (see the module's comment)
#[derive(Clone, Copy)]
pub struct Frame {
    pub exit: Label,
    /// the PC left the function's pages (normal exit): chain or return
    pub leave: Label,
    pub retry: Label,
    pub step: Label,
    pub dispatch: Label,
}

/// One level of a page function's structured layout (P4.16): the page's
/// units, or a loop's (each a block or a loop, in address order)
pub struct Level {
    /// re-enters the level: its loop's head (the page level: Frame::dispatch)
    pub repeat: Label,
    /// per block: its unit at this level, or u32::MAX
    pub unit_of: Vec<u32>,
    /// per unit: its label (the unit's code follows the label's end)
    pub labels: Vec<Label>,
    /// per unit: Some(block) for a single block
    pub single: Vec<Option<u32>>,
    /// the unit being emitted (those before it: emitted)
    pub current: usize,
    /// a loop of its header alone, whose head does not dispatch on the PC
    /// (PageEmitter::loop_unit): what continues at the PC goes further out
    pub direct: bool,
}
impl Level {
    /// The level of `units` (no labels yet), re-entered at `repeat`
    pub fn of(units: &[Unit], blocks: usize, repeat: Label) -> Level {
        let mut unit_of = vec![u32::MAX; blocks];
        let mut single = vec![];
        for (u, unit) in units.iter().enumerate() {
            let mut members = vec![];
            unit.blocks(&mut members);
            for k in members {
                unit_of[k as usize] = u as u32;
            }
            single.push(match unit {
                Unit::Block(k) => Some(*k),
                Unit::Loop { .. } => None,
            });
        }
        Level {
            repeat,
            unit_of,
            labels: vec![],
            single,
            current: 0,
            direct: false,
        }
    }
}

/// The offset of `target` in a function covering `span` bytes, if it is in it
pub fn in_page(span: u64, target: u64) -> Option<u16> { (target < span).then_some(target as u16) }

/// The structured layout of a page function (P4.16): each cycle of its
/// block graph a loop, nested (crate::pagegen::loops); with `loops` false
/// every block is a unit of the page level. `successors`: each block's
/// static successors in the function (its dynamic targets dispatch);
/// `start`: a block's offset. Loops whose dispatch table would span too much
/// of the page are flattened (MAX_LOOP_TABLE, and MAX_LOOP_TABLES for all).
pub fn structured(successors: &[Vec<u32>], start: &dyn Fn(u32) -> usize, loops: bool) -> Vec<Unit> {
    let blocks = successors.len() as u32;
    if !loops {
        return (0..blocks).map(Unit::Block).collect();
    }
    let all: Vec<u32> = (0..blocks).collect();
    let mut layout = units(&all, successors, None);
    let range = |unit: &Unit| {
        let mut members = vec![];
        unit.blocks(&mut members);
        members.iter().map(|&k| start(k)).max().unwrap() - start(unit.first()) + 1
    };
    flatten(&mut layout, &|unit| range(unit) > MAX_LOOP_TABLE);
    loop {
        let (mut total, mut widest) = (0, 0);
        visit_loops(&layout, &mut |unit| {
            total += range(unit);
            widest = widest.max(range(unit));
        });
        if total <= MAX_LOOP_TABLES {
            break;
        }
        flatten(&mut layout, &|unit| range(unit) == widest);
    }
    layout
}

/// Block starts in buckets of 2^DISPATCH_SHIFT bytes (DispatchKind::Buckets)
pub const DISPATCH_SHIFT: u32 = 4;
/// The widest span of block starts a DispatchKind::SpanTable covers
pub const SPAN_TABLE: usize = 1024;

/// How the page dispatches on the PC's offset
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DispatchKind {
    /// a table over the span of the block starts (low..=high)
    SpanTable { low: u16, high: u16 },
    /// a table over 16-byte buckets of the page, then the block starts in
    /// the bucket compared (a page-sized table is most of a small function
    /// and slow to compile)
    Buckets,
    /// a table over every offset of the function's pages
    Full,
}

// ---- the access cache's lookups (jitrt::access; P4.14)

/// The access cache's side of a page function: the globals its lookups read
/// (addresses the composition root resolved) and the runtime's lookup
pub struct AccessAbi {
    /// The running core's epoch bits (u64): what tags hold above the page
    pub epoch: u32,
    /// The address (i32) of the read supervisor table of the activation's
    /// privilege (the module's lookup function reads it)
    pub base: u32,
    /// Entries per table
    pub entries: u32,
    /// The runtime's lookup on a miss: (address: i64, kind: i32) -> host
    /// (i32), 0 when refused; kind: the size, bit 8 a write, bit 9 a write
    /// whose code takes an unaligned host, bit 10 the second bounce slot
    pub slow: &'static str,
    /// (cores in workers) the buffer unaligned reads are copied to: 32
    /// bytes, or with kind bit 10 the next 32 (an access whose first
    /// lookup's copy must survive a second, the ARM core's pairs)
    pub bounce: u32,
}

/// The locals an inline lookup works in (the ISA's): the address and the
/// epoch bits (i64); scratch: the tag (i64), the table base, the entry, the
/// page offset and the host (i32)
pub struct LookupLocals {
    pub addr: WasmLocalI64,
    pub epoch: WasmLocalI64,
    pub tag: WasmLocalI64,
    pub tables: WasmLocal,
    pub entry: WasmLocal,
    pub offset: WasmLocal,
    pub host: WasmLocal,
}

/// The module's internal function (addr: i64, kind: i32) -> i32: the host
/// address for a `kind & 255`-byte access (bit 8: write) at virtual address
/// addr from the access cache, else the runtime's lookup; 0 when refused.
/// The same lookup PageEmitter::inline_lookup otherwise inlines.
pub fn lookup_function(b: &mut WasmBuilder, abi: &AccessAbi) -> u32 {
    use crate::leb::{write_leb_i32, write_leb_u32};
    // (write tables: 2 * entries * 16 bytes on)
    let write_shift = 15 + (abi.entries / 1024).trailing_zeros() as i32;
    debug_assert!(abi.entries.is_power_of_two() && access::ENTRY_BYTES == 16);
    let slow = b.import_index(
        abi.slow,
        Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
    );
    // locals: tag (i64), entry, offset, host, the bounce slot (i32)
    let mut c: Vec<u8> = vec![2, 1, op::TYPE_I64, 4, op::TYPE_I32];
    let i32c = |c: &mut Vec<u8>, v: i32| {
        c.push(op::OP_I32CONST);
        write_leb_i32(c, v);
    };
    // tag = addr >> 12 | epoch bits (local 2)
    c.extend_from_slice(&[op::OP_GETLOCAL, 0, op::OP_I64CONST, 12, op::OP_I64SHRU]);
    i32c(&mut c, abi.epoch as i32);
    c.extend_from_slice(&[op::OP_I64LOAD, 3, 0, op::OP_I64OR, op::OP_TEELOCAL, 2]);
    // entry = table base + (tag & (ENTRIES - 1)) * 16 (+ write tables) (local 3)
    c.push(op::OP_I32WRAPI64);
    i32c(&mut c, abi.entries as i32 - 1);
    c.push(op::OP_I32AND);
    i32c(&mut c, 4);
    c.push(op::OP_I32SHL);
    i32c(&mut c, abi.base as i32);
    c.extend_from_slice(&[op::OP_I32LOAD, 2, 0, op::OP_I32ADD, op::OP_GETLOCAL, 1]);
    i32c(&mut c, 8);
    c.push(op::OP_I32SHRU);
    i32c(&mut c, 1);
    c.push(op::OP_I32AND);
    i32c(&mut c, write_shift);
    c.extend_from_slice(&[op::OP_I32SHL, op::OP_I32ADD, op::OP_SETLOCAL, 3]);
    // offset in the page (local 4)
    c.extend_from_slice(&[op::OP_GETLOCAL, 0, op::OP_I32WRAPI64]);
    i32c(&mut c, 4095);
    c.extend_from_slice(&[op::OP_I32AND, op::OP_SETLOCAL, 4]);
    // hit: tag matches and the access stays in the page
    c.extend_from_slice(&[
        op::OP_GETLOCAL,
        3,
        op::OP_I64LOAD,
        3,
        0,
        op::OP_GETLOCAL,
        2,
        op::OP_I64EQ,
    ]);
    c.extend_from_slice(&[op::OP_GETLOCAL, 4]);
    i32c(&mut c, 4096);
    c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
    i32c(&mut c, 255);
    c.extend_from_slice(&[op::OP_I32AND, op::OP_I32SUB, op::OP_I32LEU, op::OP_I32AND]);
    c.extend_from_slice(&[op::OP_IF, op::TYPE_I32]);
    c.extend_from_slice(&[
        op::OP_GETLOCAL,
        3,
        op::OP_I32LOAD,
        2,
        8,
        op::OP_GETLOCAL,
        4,
        op::OP_I32ADD,
    ]);
    if WasmBuilder::ATOMIC_GUEST_MEMORY {
        // Cores in workers access guest memory with atomics, which need
        // natural alignment (min(size, 8)). An unaligned read is copied
        // with plain loads, then a fence (x86 orders it before later
        // loads), to an aligned buffer (pages::BOUNCE) the caller reads.
        // An unaligned write host is returned as it is when the caller
        // stores unaligned itself (kind bit 9: host_store), else the
        // slow path refuses it (retried).
        c.extend_from_slice(&[op::OP_TEELOCAL, 5, op::OP_GETLOCAL, 1]);
        i32c(&mut c, 255);
        c.push(op::OP_I32AND);
        i32c(&mut c, 8);
        c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
        i32c(&mut c, 255);
        c.push(op::OP_I32AND);
        i32c(&mut c, 8);
        c.extend_from_slice(&[op::OP_I32LTU, op::OP_SELECT]);
        i32c(&mut c, 1);
        c.extend_from_slice(&[op::OP_I32SUB, op::OP_I32AND, op::OP_IF, op::TYPE_I32]);
        c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
        i32c(&mut c, 0x100);
        c.extend_from_slice(&[op::OP_I32AND, op::OP_IF, op::TYPE_I32]);
        // (a write whose code handles unaligned hosts, bit 9: store)
        c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
        i32c(&mut c, 0x200);
        c.extend_from_slice(&[
            op::OP_I32AND,
            op::OP_IF,
            op::TYPE_I32,
            op::OP_GETLOCAL,
            5,
            op::OP_ELSE,
        ]);
        c.extend_from_slice(&[op::OP_GETLOCAL, 0, op::OP_GETLOCAL, 1, op::OP_CALL]);
        write_leb_u32(&mut c, slow);
        c.push(op::OP_END);
        c.push(op::OP_ELSE);
        // (the slot: bounce, or with kind bit 10 bounce + 32; local 6)
        i32c(&mut c, abi.bounce as i32);
        c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
        i32c(&mut c, 5);
        c.push(op::OP_I32SHRU);
        i32c(&mut c, 32);
        c.push(op::OP_I32AND);
        c.extend_from_slice(&[op::OP_I32ADD, op::OP_SETLOCAL, 6]);
        // (sizes 2, 4, 8, 16, 32: the first 8 bytes or fewer, then the
        // rest; 32: a VEX.256 load's)
        let copy = |c: &mut Vec<u8>, load: u8, store: u8, align: u8, offset: u32| {
            c.extend_from_slice(&[op::OP_GETLOCAL, 6]);
            c.extend_from_slice(&[op::OP_GETLOCAL, 5, load, 0]);
            write_leb_u32(c, offset);
            c.extend_from_slice(&[store, align]);
            write_leb_u32(c, offset);
        };
        c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
        i32c(&mut c, 255);
        c.push(op::OP_I32AND);
        i32c(&mut c, 4);
        c.extend_from_slice(&[op::OP_I32LTU, op::OP_IF, op::TYPE_VOID_BLOCK]);
        copy(&mut c, op::OP_I32LOAD16U, op::OP_I32STORE16, 1, 0);
        c.push(op::OP_ELSE);
        c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
        i32c(&mut c, 255);
        c.push(op::OP_I32AND);
        i32c(&mut c, 4);
        c.extend_from_slice(&[op::OP_I32EQ, op::OP_IF, op::TYPE_VOID_BLOCK]);
        copy(&mut c, op::OP_I32LOAD, op::OP_I32STORE, 2, 0);
        c.push(op::OP_ELSE);
        copy(&mut c, op::OP_I64LOAD, op::OP_I64STORE, 3, 0);
        c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
        i32c(&mut c, 255);
        c.push(op::OP_I32AND);
        i32c(&mut c, 16);
        c.extend_from_slice(&[op::OP_I32GEU, op::OP_IF, op::TYPE_VOID_BLOCK]);
        copy(&mut c, op::OP_I64LOAD, op::OP_I64STORE, 3, 8);
        c.extend_from_slice(&[op::OP_END]);
        c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
        i32c(&mut c, 255);
        c.push(op::OP_I32AND);
        i32c(&mut c, 32);
        c.extend_from_slice(&[op::OP_I32EQ, op::OP_IF, op::TYPE_VOID_BLOCK]);
        copy(&mut c, op::OP_I64LOAD, op::OP_I64STORE, 3, 16);
        copy(&mut c, op::OP_I64LOAD, op::OP_I64STORE, 3, 24);
        c.extend_from_slice(&[op::OP_END, op::OP_END, op::OP_END]);
        c.extend_from_slice(&[0xFE, 0x03, 0x00]); // atomic.fence
        c.extend_from_slice(&[op::OP_GETLOCAL, 6]);
        c.extend_from_slice(&[op::OP_END, op::OP_ELSE, op::OP_GETLOCAL, 5, op::OP_END]);
    }
    c.extend_from_slice(&[
        op::OP_ELSE,
        op::OP_GETLOCAL,
        0,
        op::OP_GETLOCAL,
        1,
        op::OP_CALL,
    ]);
    write_leb_u32(&mut c, slow);
    c.extend_from_slice(&[op::OP_END, op::OP_END]);
    b.add_internal_function(
        Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
        c,
    )
}

// ---- chaining (jitrt::chain)

/// Where a chaining lookup takes the epoch bits from
pub enum ChainEpoch<'l> {
    Global(u32),
    Local(&'l WasmLocalI64),
}

/// The chaining lookup of the page of the PC in `pc` (i64) in the table
/// whose address is in global `table_base` (i32), `tag` (i64) and `entry`
/// (i32) scratch: it opens an `if` taken when the entry is the page's in the
/// current epoch, in which the ISA writes its state back and calls
/// chain_call, then closes it
pub fn chain_lookup(
    b: &mut WasmBuilder,
    pc: &WasmLocalI64,
    tag: &WasmLocalI64,
    entry: &WasmLocal,
    table_base: u32,
    epoch: ChainEpoch,
) {
    b.get_local_i64(pc);
    b.const_i64(12);
    b.shr_u_i64();
    b.set_local_i64(tag);
    b.get_local_i64(tag);
    b.wrap_i64_to_i32();
    b.const_i32(chain::ENTRIES as i32 - 1);
    b.and_i32();
    b.const_i32(chain::ENTRY_BYTES.trailing_zeros() as i32);
    b.shl_i32();
    b.load_fixed_i32(table_base);
    b.add_i32();
    b.set_local(entry);
    b.get_local(entry);
    b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
    b.get_local_i64(tag);
    match epoch {
        ChainEpoch::Global(address) => {
            b.const_i32(address as i32);
            b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
        },
        ChainEpoch::Local(local) => b.get_local_i64(local),
    }
    b.or_i64();
    b.eq_i64();
    b.if_void();
}
/// The tail call to the entry's function (the budget, its argument, pushed)
pub fn chain_call(b: &mut WasmBuilder, entry: &WasmLocal) {
    b.get_local(entry);
    b.load_aligned_i32(chain::TABLE_INDEX_OFFSET);
    b.return_call_indirect_fn1();
}

/// What the skeleton needs of an ISA's emitter, and what it provides
pub trait PageEmitter {
    fn b(&mut self) -> &mut WasmBuilder;
    fn frame(&self) -> Frame;
    fn set_frame(&mut self, frame: Frame);
    fn levels(&mut self) -> &mut Vec<Level>;
    fn levels_ref(&self) -> &[Level];
    /// The bytes the function's offsets cover
    fn span_bytes(&self) -> u64;
    /// Push the i32 offset of the PC in the function's pages
    fn pc_offset(&mut self);
    /// The i32 local the dispatches keep an offset in: tee it, get it
    fn tee_offset(&mut self);
    fn get_offset(&mut self);
    /// The head of the page's and each loop's dispatch: count a round and
    /// leave (Frame::exit) when the budget is spent
    fn head(&mut self);
    /// Emit block `k`
    fn emit_block(&mut self, k: u32, index: &BTreeMap<u16, usize>);
    /// Block `k`'s offset
    fn block_start(&self, k: u32) -> u16;
    /// Branch to `label` with the PC at offset `target` (and what the label
    /// expects in memory)
    fn leave_to(&mut self, label: Label, target: u64);
    /// Before a branch straight into a block's code: what blocks expect in
    /// memory at their start
    fn before_branch(&mut self);
    /// Control passes to `target` in the function's pages (a function of
    /// several pages checks the page)
    fn span_check(&mut self, target: u64);
    /// A loop of its header alone is entered and repeated at the header,
    /// without a dispatch on the PC
    fn direct_loops(&self) -> bool;

    // the frame's ISA parts, in the order the function has them
    /// After the exit block opened: checks of the function's entry that leave
    fn entry_checks(&mut self, _exit: Label) {}
    /// After the page's head: the PC out of the function's pages leaves
    fn bounds(&mut self, leave: Label);
    /// The PC is no compiled block start (Frame::step or Frame::exit)
    fn unknown_offset(&mut self);
    /// Before the units' code
    fn before_units(&mut self) {}
    /// The step block's code: interpret one instruction, dispatch again
    fn step_tail(&mut self);
    /// The retry block's code
    fn retry_tail(&mut self);
    /// The leave block's code (chaining)
    fn leave_tail(&mut self);
    /// The exit block's code, the function's last
    fn exit_tail(&mut self);
    /// (the statistics of where the bytes go)
    fn note_size(&mut self, _what: &str, _bytes: usize) {}
    /// The module's lookup function (lookup_function; made once, the ISA
    /// keeps its index)
    fn lookup_function(&mut self) -> u32;

    /// Push the host address of a `size`-byte access at the address in
    /// `l.addr` through the module's lookup function, with its kind `bits`;
    /// refused: leave for `fallback` with the PC at offset `start`
    fn outlined_lookup(
        &mut self,
        l: &LookupLocals,
        size: u32,
        bits: u32,
        start: u64,
        fallback: Label,
    ) {
        let f = self.lookup_function();
        self.b().get_local_i64(&l.addr);
        self.b().const_i32((size | bits) as i32);
        self.b().call_internal(f);
        self.b().tee_local(&l.host);
        self.b().eqz_i32();
        self.b().if_void();
        self.leave_to(fallback, start);
        self.b().block_end();
        self.b().get_local(&l.host);
    }
    /// The same, inline: the entry's tag compared, the access in the page
    /// (unless `aligned` to its size), naturally aligned with cores in
    /// workers; a miss calls the runtime (with cores in workers the module's
    /// lookup, which takes unaligned accesses the runtime refuses)
    fn inline_lookup(
        &mut self,
        l: &LookupLocals,
        abi: &AccessAbi,
        (size, aligned): (u32, bool),
        bits: u32,
        start: u64,
        fallback: Label,
    ) {
        let write = bits & 0x100 != 0;
        let table = if write { 2 * abi.entries * access::ENTRY_BYTES } else { 0 };
        let b = self.b();
        b.get_local_i64(&l.addr);
        b.const_i64(12);
        b.shr_u_i64();
        b.get_local_i64(&l.epoch);
        b.or_i64();
        b.set_local_i64(&l.tag);
        b.get_local_i64(&l.tag);
        b.wrap_i64_to_i32();
        b.const_i32(abi.entries as i32 - 1);
        b.and_i32();
        b.const_i32(access::ENTRY_BYTES.trailing_zeros() as i32);
        b.shl_i32();
        b.get_local(&l.tables);
        b.add_i32();
        b.set_local(&l.entry);
        b.get_local_i64(&l.addr);
        b.wrap_i64_to_i32();
        b.const_i32(4095);
        b.and_i32();
        b.set_local(&l.offset);
        b.get_local(&l.entry);
        b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, table);
        b.get_local_i64(&l.tag);
        b.eq_i64();
        if !aligned {
            b.get_local(&l.offset);
            b.const_i32((4096 - size) as i32);
            b.leu_i32();
            b.and_i32();
        }
        if WasmBuilder::ATOMIC_GUEST_MEMORY && size > 1 && !aligned {
            // atomic accesses (cores in workers) need natural alignment; the
            // runtime's lookup refuses unaligned ones
            b.get_local(&l.offset);
            b.const_i32(size.min(8) as i32 - 1);
            b.and_i32();
            b.eqz_i32();
            b.and_i32();
        }
        b.hint(true);
        b.if_i32();
        b.get_local(&l.entry);
        b.load_aligned_i32(table + 8);
        b.get_local(&l.offset);
        b.add_i32();
        b.else_();
        b.get_local_i64(&l.addr);
        if WasmBuilder::ATOMIC_GUEST_MEMORY {
            let f = self.lookup_function();
            self.b().const_i32((size | bits) as i32);
            self.b().call_internal(f);
        }
        else {
            let b = self.b();
            b.const_i32(size as i32 | (write as i32) << 8);
            b.call_signature(
                abi.slow,
                Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
            );
        }
        self.b().tee_local(&l.host);
        self.b().eqz_i32();
        self.b().if_void();
        self.leave_to(fallback, start);
        self.b().block_end();
        self.b().get_local(&l.host);
        self.b().block_end();
    }

    /// The function's body from the frame's blocks on (the ISA emitted its
    /// prologue): `units` the structured layout of its `blocks`, `index`
    /// block starts to blocks
    fn page(
        &mut self,
        units: &[Unit],
        blocks: usize,
        index: &BTreeMap<u16, usize>,
        kind: DispatchKind,
    ) {
        let exit = self.b().block_void();
        self.entry_checks(exit);
        let leave = self.b().block_void();
        let retry = self.b().block_void();
        let dispatch = self.b().loop_void();
        let step = self.b().block_void();
        self.set_frame(Frame {
            exit,
            leave,
            retry,
            step,
            dispatch,
        });
        // Budget (native instructions and steps), then the page.
        self.head();
        self.bounds(leave);
        // The structured layout (P4.16): the page level's units, each with
        // its label; a block in a loop dispatches to the loop's
        let mut level = Level::of(units, blocks, dispatch);
        level.labels = units.iter().map(|_| self.b().block_void()).collect();
        level.labels.reverse();
        let bad = self.b().block_void();
        let mark = self.b().body_len();
        self.page_dispatch(index, &level, bad, kind);
        let bytes = self.b().body_len() - mark;
        self.note_size("[dispatch br_table]", bytes);
        self.b().block_end();
        // Not a block start (the ISA steps it in place, or leaves)
        self.unknown_offset();
        self.levels().push(level);
        self.before_units();
        self.units(units, index);
        let mark = self.b().body_len();
        self.b().unreachable();
        self.b().block_end(); // step
        self.step_tail();
        self.b().block_end(); // dispatch loop
        self.b().unreachable();
        self.b().block_end(); // retry
        self.retry_tail();
        self.b().block_end(); // leave
        self.leave_tail();
        self.b().block_end(); // exit
        self.exit_tail();
        let bytes = self.b().body_len() - mark;
        self.note_size("[step, retry, chain, exit]", bytes);
    }

    /// The page level's dispatch on the PC's offset to the units' labels
    /// (`bad`: no block start there)
    fn page_dispatch(
        &mut self,
        index: &BTreeMap<u16, usize>,
        level: &Level,
        bad: Label,
        kind: DispatchKind,
    ) {
        let label_of = |level: &Level, i: usize| level.labels[level.unit_of[i] as usize];
        match kind {
            DispatchKind::SpanTable { low, high } => {
                self.pc_offset();
                if low != 0 {
                    self.b().const_i32(low as i32);
                    self.b().sub_i32();
                }
                let targets: Vec<Label> = (low..=high)
                    .map(|o| index.get(&o).map_or(bad, |&i| label_of(level, i)))
                    .collect();
                self.b().brtable(bad, &mut targets.iter());
            },
            DispatchKind::Buckets => {
                let mut buckets: BTreeMap<u16, Vec<(u16, usize)>> = BTreeMap::new();
                for (&o, &i) in index {
                    buckets.entry(o >> DISPATCH_SHIFT).or_default().push((o, i));
                }
                let order: Vec<u16> = buckets.keys().copied().collect();
                let mut bucket_labels: HashMap<u16, Label> = HashMap::new();
                for &b in order.iter().rev() {
                    let label = self.b().block_void();
                    bucket_labels.insert(b, label);
                }
                self.pc_offset();
                self.tee_offset();
                self.b().const_i32(DISPATCH_SHIFT as i32);
                self.b().shr_u_i32();
                let targets: Vec<Label> = (0..(self.span_bytes() >> DISPATCH_SHIFT) as u16)
                    .map(|b| bucket_labels.get(&b).copied().unwrap_or(bad))
                    .collect();
                self.b().brtable(bad, &mut targets.iter());
                for b in order {
                    self.b().block_end();
                    for &(o, i) in &buckets[&b] {
                        self.get_offset();
                        self.b().const_i32(o as i32);
                        self.b().eq_i32();
                        self.b().br_if(label_of(level, i));
                    }
                    self.b().br(bad);
                }
            },
            DispatchKind::Full => {
                self.pc_offset();
                let targets: Vec<Label> = (0..self.span_bytes() as u32)
                    .map(|o| index.get(&(o as u16)).map_or(bad, |&i| label_of(level, i)))
                    .collect();
                self.b().brtable(bad, &mut targets.iter());
            },
        }
    }

    /// Continue at offset `target`: a later block of this function directly,
    /// an earlier one through dispatch (and its budget check), else leave.
    fn goto(&mut self, target: u64, index: &BTreeMap<u16, usize>) {
        let Some(o) = in_page(self.span_bytes(), target)
        else {
            return self.leave_to(self.frame().leave, target);
        };
        self.span_check(target);
        let Some(&k) = index.get(&o)
        else {
            return self.leave_to(self.frame().dispatch, target);
        };
        let Some((emitted, single, label, repeat)) = self.unit_holding(k)
        else {
            return self.leave_to(self.frame().dispatch, target);
        };
        if emitted {
            return self.leave_to(repeat, target);
        }
        if single == Some(k as u32) {
            self.before_branch();
            return self.b().br(label);
        }
        self.leave_to(label, target)
    }
    /// Block `k`'s unit at the innermost level holding it: whether it was
    /// emitted (at or before the one being emitted), the block if the unit
    /// is that one alone, the unit's label and the level's head. A unit
    /// after the one being emitted is reached by its label (a single block
    /// directly), an emitted one by the level's head, which dispatches on
    /// the PC (P4.16; the page level: Frame::dispatch).
    fn unit_holding(&self, k: usize) -> Option<(bool, Option<u32>, Label, Label)> {
        let level = self
            .levels_ref()
            .iter()
            .rev()
            .find(|level| level.unit_of[k] != u32::MAX)?;
        let u = level.unit_of[k] as usize;
        Some((
            u <= level.current,
            level.single[u],
            level.labels[u],
            level.repeat,
        ))
    }
    /// The label that continues straight into the code of the block at `o`
    /// from here, with the PC already there (goto's direct case: a later
    /// single block of its level; the caller checks the span's page)
    fn direct_label(&self, o: u16, index: &BTreeMap<u16, usize>) -> Option<Label> {
        let &k = index.get(&o)?;
        match self.unit_holding(k)? {
            (false, Some(single), label, _) if single == k as u32 => Some(label),
            _ => None,
        }
    }
    /// Whether the block at `o` is the next unit of the innermost level, a
    /// single block, whose code follows (no branch needed)
    fn falls_into(&self, o: u16, index: &BTreeMap<u16, usize>) -> bool {
        let level = self.levels_ref().last().unwrap();
        index
            .get(&o)
            .is_some_and(|&k| level.single.get(level.current + 1) == Some(&Some(k as u32)))
    }
    /// The units of a level, after its labels and dispatch: each one's code
    /// after its label's end
    fn units(&mut self, units: &[Unit], index: &BTreeMap<u16, usize>) {
        for (u, unit) in units.iter().enumerate() {
            self.b().block_end();
            self.levels().last_mut().unwrap().current = u;
            match unit {
                Unit::Block(k) => self.emit_block(*k, index),
                Unit::Loop { header, units } => self.loop_unit(*header, units, index),
            }
        }
    }
    /// A loop (P4.16): its head (budget) and a dispatch on the PC over its
    /// members, the header first; an offset it does not hold goes to the
    /// page dispatch. Back edges re-enter the head instead of the page
    /// dispatch.
    fn loop_unit(&mut self, header: u32, units: &[Unit], index: &BTreeMap<u16, usize>) {
        let repeat = self.b().loop_void();
        self.head();
        let blocks = self.levels_ref()[0].unit_of.len();
        let mut level = Level::of(units, blocks, repeat);
        level.labels = units.iter().map(|_| self.b().block_void()).collect();
        level.labels.reverse();
        let mut members = vec![];
        for unit in units {
            unit.blocks(&mut members);
        }
        let (low, high) = (
            members.iter().map(|&k| self.block_start(k)).min().unwrap(),
            members.iter().map(|&k| self.block_start(k)).max().unwrap(),
        );
        // (a loop of its header alone is entered and repeated at it: no
        // dispatch on the PC each iteration)
        if self.direct_loops() && members.len() == 1 && units.len() == 1 {
            level.direct = true;
            self.levels().push(level);
            self.units(units, index);
            self.levels().pop();
            self.b().block_end();
            return;
        }
        self.pc_offset();
        self.tee_offset();
        let start = self.block_start(header);
        self.b().const_i32(start as i32);
        self.b().eq_i32();
        self.b().br_if(level.labels[0]);
        let dispatch = self.frame().dispatch;
        let table: Vec<Label> = (low..=high)
            .map(|o| match index.get(&o) {
                Some(&k) if level.unit_of[k] != u32::MAX => level.labels[level.unit_of[k] as usize],
                _ => dispatch,
            })
            .collect();
        self.get_offset();
        if low != 0 {
            self.b().const_i32(low as i32);
            self.b().sub_i32();
        }
        self.b().brtable(dispatch, &mut table.iter());
        self.levels().push(level);
        self.units(units, index);
        self.levels().pop();
        self.b().block_end();
    }
}
