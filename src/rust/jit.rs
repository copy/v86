use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::iter::FromIterator;
use std::mem::{self, MaybeUninit};
use std::ops::{Deref, DerefMut};
use std::ptr::NonNull;
use std::sync::{Mutex, MutexGuard};

use crate::analysis;
use crate::analysis::AnalysisType;
use crate::codegen;
use crate::control_flow;
use crate::control_flow::WasmStructure;
use crate::cpu::cpu;
use crate::cpu::global_pointers;
use crate::cpu::memory;
use crate::cpu_context::CpuContext;
use crate::jit_instructions;
use crate::opstats;
use crate::page::Page;
use crate::profiler;
use crate::profiler::stat;
use crate::state_flags::CachedStateFlags;
use crate::wasmgen::wasm_builder::{Label, WasmBuilder, WasmLocal};

#[derive(Copy, Clone, Eq, Hash, PartialEq)]
#[repr(transparent)]
pub struct WasmTableIndex(u16);
impl WasmTableIndex {
    pub fn to_u16(self) -> u16 { self.0 }
}

mod unsafe_jit {
    use super::{CachedStateFlags, WasmTableIndex};

    extern "C" {
        pub fn codegen_finalize(
            wasm_table_index: WasmTableIndex,
            phys_addr: u32,
            state_flags: CachedStateFlags,
            ptr: u32,
            len: u32,
        );
        pub fn jit_clear_func(wasm_table_index: WasmTableIndex);
    }
}

fn codegen_finalize(
    wasm_table_index: WasmTableIndex,
    phys_addr: u32,
    state_flags: CachedStateFlags,
    ptr: u32,
    len: u32,
) {
    unsafe { unsafe_jit::codegen_finalize(wasm_table_index, phys_addr, state_flags, ptr, len) }
}

pub fn jit_clear_func(wasm_table_index: WasmTableIndex) {
    unsafe { unsafe_jit::jit_clear_func(wasm_table_index) }
}

static mut JIT_DISABLED: bool = false;

// Maximum number of pages per wasm module. Necessary for the following reasons:
// - There is an upper limit on the size of a single function in wasm (currently ~7MB in all browsers)
//   See https://github.com/WebAssembly/design/issues/1138
// - v8 poorly handles large br_table elements and OOMs on modules much smaller than the above limit
//   See https://bugs.chromium.org/p/v8/issues/detail?id=9697 and https://bugs.chromium.org/p/v8/issues/detail?id=9141
//   Will hopefully be fixed in the near future by generating direct control flow
static mut MAX_PAGES: u32 = 3;

static mut JIT_USE_LOOP_SAFETY: bool = true;

pub static mut MAX_EXTRA_BASIC_BLOCKS: u32 = 250;

pub const JIT_THRESHOLD: u32 = 200 * 1000;

// less branches will generate if-else, more will generate brtable
pub const BRTABLE_CUTOFF: usize = 10;

// needs to be synced to const.js
pub const WASM_TABLE_SIZE: u32 = 900;

pub const CHECK_JIT_STATE_INVARIANTS: bool = false;

const MAX_INSTRUCTION_LENGTH: u32 = 16;

static JIT_STATE: Mutex<MaybeUninit<JitState>> = Mutex::new(MaybeUninit::uninit());
fn get_jit_state() -> JitStateRef { JitStateRef(JIT_STATE.try_lock().unwrap()) }

struct JitStateRef(MutexGuard<'static, MaybeUninit<JitState>>);

impl Deref for JitStateRef {
    type Target = JitState;
    fn deref(&self) -> &Self::Target { unsafe { self.0.assume_init_ref() } }
}
impl DerefMut for JitStateRef {
    fn deref_mut(&mut self) -> &mut Self::Target { unsafe { self.0.assume_init_mut() } }
}

#[no_mangle]
pub fn rust_init() {
    dbg_assert!(std::mem::size_of::<[Option<NonNull<cpu::Code>>; 0x100000]>() == 0x100000 * 4);

    let _ = JIT_STATE
        .try_lock()
        .unwrap()
        .write(JitState::create_and_initialise());

    use std::panic;

    panic::set_hook(Box::new(|panic_info| {
        console_log!("{}", panic_info.to_string());
    }));
}

struct PageInfo {
    wasm_table_index: WasmTableIndex,
    hidden_wasm_table_indices: Vec<WasmTableIndex>,
    entry_points: Vec<(u16, u16)>,
    state_flags: CachedStateFlags,
}

enum CompilingPageState {
    Compiling { pages: HashMap<Page, PageInfo> },
    CompilingWritten,
}

struct JitState {
    wasm_builder: WasmBuilder,

    // as an alternative to HashSet, we could use a bitmap of 4096 bits here
    // (faster, but uses much more memory)
    // or a compressed bitmap (likely faster)
    // or HashSet<u32> rather than nested
    entry_points: HashMap<Page, (u32, HashSet<u16>)>,
    pages: HashMap<Page, PageInfo>,
    wasm_table_index_free_list: Vec<WasmTableIndex>,
    compiling: Option<(WasmTableIndex, CompilingPageState)>,
}

fn check_jit_state_invariants(ctx: &mut JitState) {
    if !CHECK_JIT_STATE_INVARIANTS {
        return;
    }

    match &ctx.compiling {
        Some((_, CompilingPageState::Compiling { pages })) => {
            dbg_assert!(pages.keys().all(|page| ctx.entry_points.contains_key(page)));
        },
        _ => {},
    }

    let free: HashSet<WasmTableIndex> =
        HashSet::from_iter(ctx.wasm_table_index_free_list.iter().cloned());
    let used = HashSet::from_iter(ctx.pages.values().map(|info| info.wasm_table_index));
    let compiling = HashSet::from_iter(ctx.compiling.as_ref().map(|&(index, _)| index));
    dbg_assert!(free.intersection(&used).next().is_none());
    dbg_assert!(used.intersection(&compiling).next().is_none());
    dbg_assert!(free.len() + used.len() + compiling.len() == (WASM_TABLE_SIZE - 1) as usize);

    match &ctx.compiling {
        Some((_, CompilingPageState::Compiling { pages })) => {
            dbg_assert!(pages.keys().all(|page| ctx.entry_points.contains_key(page)));
        },
        _ => {},
    }

    for i in 0..unsafe { cpu::valid_tlb_entries_count } {
        let page = unsafe { cpu::valid_tlb_entries[i as usize] };
        let entry = unsafe { cpu::tlb_data[page as usize] };
        if 0 != entry {
            let tlb_physical_page = Page::of_u32(
                (entry as u32 >> 12 ^ page as u32) - (unsafe { memory::mem8 } as u32 >> 12),
            );
            let w = match unsafe { cpu::tlb_code[page as usize] } {
                None => None,
                Some(c) => unsafe { Some(c.as_ref().wasm_table_index) },
            };
            let tlb_has_code = entry & cpu::TLB_HAS_CODE == cpu::TLB_HAS_CODE;
            let infos = ctx.pages.get(&tlb_physical_page);
            let entry_points = ctx.entry_points.get(&tlb_physical_page);
            dbg_assert!(tlb_has_code || !w.is_some());
            dbg_assert!(tlb_has_code || !infos.is_some());
            dbg_assert!(tlb_has_code || !entry_points.is_some());
            //dbg_assert!((w.is_some() || page.is_some() || entry_points.is_some()) == tlb_has_code); // XXX: check this
        }
    }
}

impl JitState {
    pub fn create_and_initialise() -> JitState {
        // don't assign 0 (XXX: Check)
        let wasm_table_indices = (1..=(WASM_TABLE_SIZE - 1) as u16).map(|x| WasmTableIndex(x));

        JitState {
            wasm_builder: WasmBuilder::new(),

            entry_points: HashMap::new(),
            pages: HashMap::new(),

            wasm_table_index_free_list: Vec::from_iter(wasm_table_indices),
            compiling: None,
        }
    }
}

#[derive(PartialEq, Eq)]
pub enum BasicBlockType {
    Normal {
        next_block_addr: Option<u32>,
        jump_offset: i32,
        jump_offset_is_32: bool,
    },
    ConditionalJump {
        next_block_addr: Option<u32>,
        next_block_branch_taken_addr: Option<u32>,
        condition: u8,
        jump_offset: i32,
        jump_offset_is_32: bool,
    },
    // Set eip to an absolute value (ret, jmp r/m, call r/m)
    AbsoluteEip,
    Exit,
}

pub struct BasicBlock {
    pub addr: u32,
    pub virt_addr: i32,
    pub last_instruction_addr: u32,
    pub end_addr: u32,
    pub is_entry_block: bool,
    pub ty: BasicBlockType,
    pub has_sti: bool,
    pub number_of_instructions: u32,
}

#[derive(Copy, Clone, PartialEq)]
pub struct CachedCode {
    pub wasm_table_index: WasmTableIndex,
    pub initial_state: u16,
}

impl CachedCode {
    pub const NONE: CachedCode = CachedCode {
        wasm_table_index: WasmTableIndex(0),
        initial_state: 0,
    };
}

#[derive(PartialEq)]
pub enum InstructionOperandDest {
    WasmLocal(WasmLocal),
    Other,
}
#[derive(PartialEq)]
pub enum InstructionOperand {
    WasmLocal(WasmLocal),
    Immediate(i32),
    Other,
}
impl InstructionOperand {
    pub fn is_zero(&self) -> bool {
        match self {
            InstructionOperand::Immediate(0) => true,
            _ => false,
        }
    }
}
impl Into<InstructionOperand> for InstructionOperandDest {
    fn into(self: InstructionOperandDest) -> InstructionOperand {
        match self {
            InstructionOperandDest::WasmLocal(l) => InstructionOperand::WasmLocal(l),
            InstructionOperandDest::Other => InstructionOperand::Other,
        }
    }
}
pub enum Instruction {
    Cmp {
        dest: InstructionOperandDest,
        source: InstructionOperand,
        opsize: i32,
    },
    Sub {
        dest: InstructionOperandDest,
        source: InstructionOperand,
        opsize: i32,
        is_dec: bool,
    },
    Add {
        dest: InstructionOperandDest,
        source: InstructionOperand,
        opsize: i32,
        is_inc: bool,
    },
    AdcSbb {
        dest: InstructionOperandDest,
        #[allow(dead_code)]
        source: InstructionOperand,
        opsize: i32,
    },
    NonZeroShift {
        dest: InstructionOperandDest,
        opsize: i32,
    },
    Bitwise {
        dest: InstructionOperandDest,
        opsize: i32,
    },
    Other,
}

pub struct JitContext<'a> {
    pub cpu: &'a mut CpuContext,
    pub builder: &'a mut WasmBuilder,
    pub register_locals: &'a mut Vec<WasmLocal>,
    pub start_of_current_instruction: u32,
    pub exit_with_fault_label: Label,
    pub exit_label: Label,
    pub current_instruction: Instruction,
    pub previous_instruction: Instruction,
    pub instruction_counter: WasmLocal,
}
impl<'a> JitContext<'a> {
    pub fn reg(&self, i: u32) -> WasmLocal {
        match self.register_locals.get(i as usize) {
            Some(x) => x.unsafe_clone(),
            None => {
                dbg_assert!(false);
                unsafe { std::hint::unreachable_unchecked() }
            },
        }
    }
}

pub const JIT_INSTR_BLOCK_BOUNDARY_FLAG: u32 = 1 << 0;

pub fn is_near_end_of_page(address: u32) -> bool {
    address & 0xFFF >= 0x1000 - MAX_INSTRUCTION_LENGTH
}

pub fn jit_find_cache_entry(phys_address: u32, state_flags: CachedStateFlags) -> CachedCode {
    // TODO: dedup with jit_find_cache_entry_in_page?
    // NOTE: This is currently only used for invariant/missed-entry-point checking
    let ctx = get_jit_state();

    match ctx.pages.get(&Page::page_of(phys_address)) {
        Some(PageInfo {
            wasm_table_index,
            state_flags: s,
            entry_points,
            hidden_wasm_table_indices: _,
        }) => {
            if *s == state_flags {
                let page_offset = phys_address as u16 & 0xFFF;
                if let Some(&(_, initial_state)) =
                    entry_points.iter().find(|(p, _)| p == &page_offset)
                {
                    return CachedCode {
                        wasm_table_index: *wasm_table_index,
                        initial_state,
                    };
                }
            }
        },
        None => {},
    }

    return CachedCode::NONE;
}

#[no_mangle]
pub fn jit_find_cache_entry_in_page(
    virt_address: u32,
    wasm_table_index: WasmTableIndex,
    state_flags: u32,
) -> i32 {
    // TODO: generate code for this
    profiler::stat_increment(stat::INDIRECT_JUMP);

    let state_flags = CachedStateFlags::of_u32(state_flags);

    unsafe {
        match cpu::tlb_code[(virt_address >> 12) as usize] {
            None => {},
            Some(c) => {
                let c = c.as_ref();
                if state_flags == c.state_flags && wasm_table_index == c.wasm_table_index {
                    let state = c.state_table[virt_address as usize & 0xFFF];
                    if state != u16::MAX {
                        return state.into();
                    }
                }
            },
        }
    }

    profiler::stat_increment(stat::INDIRECT_JUMP_NO_ENTRY);

    return -1;
}

fn jit_find_basic_blocks(
    ctx: &mut JitState,
    entry_points: HashSet<i32>,
    cpu: CpuContext,
) -> Vec<BasicBlock> {
    fn follow_jump(
        virt_target: i32,
        ctx: &mut JitState,
        pages: &mut HashSet<Page>,
        page_blacklist: &mut HashSet<Page>,
        max_pages: u32,
        marked_as_entry: &mut HashSet<i32>,
        to_visit_stack: &mut Vec<i32>,
    ) -> Option<u32> {
        if is_near_end_of_page(virt_target as u32) {
            return None;
        }
        let phys_target = match cpu::translate_address_read_no_side_effects(virt_target) {
            Err(()) => {
                dbg_log!("Not analysing {:x} (page not mapped)", virt_target);
                return None;
            },
            Ok(t) => t,
        };

        let phys_page = Page::page_of(phys_target);

        if !pages.contains(&phys_page) && pages.len() as u32 == max_pages
            || page_blacklist.contains(&phys_page)
        {
            return None;
        }

        if !pages.contains(&phys_page) {
            // page seen for the first time, handle entry points
            if let Some((hotness, entry_points)) = ctx.entry_points.get_mut(&phys_page) {
                let existing_entry_points = match ctx.pages.get(&phys_page) {
                    Some(PageInfo { entry_points, .. }) => {
                        HashSet::from_iter(entry_points.iter().map(|x| x.0))
                    },
                    None => HashSet::new(),
                };

                if entry_points
                    .iter()
                    .all(|entry_point| existing_entry_points.contains(entry_point))
                {
                    page_blacklist.insert(phys_page);
                    return None;
                }

                // XXX: Remove this paragraph
                //let old_length = entry_points.len();
                //entry_points.extend(existing_entry_points);
                //dbg_assert!(
                //    entry_points.union(&existing_entry_points).count() == entry_points.len()
                //);

                *hotness = 0;

                for &addr_low in entry_points.iter() {
                    let addr = virt_target & !0xFFF | addr_low as i32;
                    to_visit_stack.push(addr);
                    marked_as_entry.insert(addr);
                }
            }
            else {
                // no entry points: ignore this page?
                page_blacklist.insert(phys_page);
                return None;
            }

            pages.insert(phys_page);
            dbg_assert!(pages.len() as u32 <= max_pages);
        }

        to_visit_stack.push(virt_target);
        Some(phys_target)
    }

    let mut to_visit_stack: Vec<i32> = Vec::new();
    let mut marked_as_entry: HashSet<i32> = HashSet::new();
    let mut basic_blocks: BTreeMap<u32, BasicBlock> = BTreeMap::new();
    let mut pages: HashSet<Page> = HashSet::new();
    let mut page_blacklist = HashSet::new();

    // 16-bit doesn't not work correctly, most likely due to instruction pointer wrap-around
    let max_pages = if cpu.state_flags.is_32() { unsafe { MAX_PAGES } } else { 1 };

    for virt_addr in entry_points {
        let ok = follow_jump(
            virt_addr,
            ctx,
            &mut pages,
            &mut page_blacklist,
            max_pages,
            &mut marked_as_entry,
            &mut to_visit_stack,
        );
        dbg_assert!(ok.is_some());
        dbg_assert!(marked_as_entry.contains(&virt_addr));
    }

    while let Some(to_visit) = to_visit_stack.pop() {
        let phys_addr = match cpu::translate_address_read_no_side_effects(to_visit) {
            Err(()) => {
                dbg_log!("Not analysing {:x} (page not mapped)", to_visit);
                continue;
            },
            Ok(phys_addr) => phys_addr,
        };

        if basic_blocks.contains_key(&phys_addr) {
            continue;
        }

        if is_near_end_of_page(phys_addr) {
            // Empty basic block, don't insert
            profiler::stat_increment(stat::COMPILE_CUT_OFF_AT_END_OF_PAGE);
            continue;
        }

        let mut current_address = phys_addr;
        let mut current_block = BasicBlock {
            addr: current_address,
            virt_addr: to_visit,
            last_instruction_addr: 0,
            end_addr: 0,
            ty: BasicBlockType::Exit,
            is_entry_block: false,
            has_sti: false,
            number_of_instructions: 0,
        };
        loop {
            let addr_before_instruction = current_address;
            let mut cpu = &mut CpuContext {
                eip: current_address,
                ..cpu
            };
            let analysis = analysis::analyze_step(&mut cpu);
            current_block.number_of_instructions += 1;
            let has_next_instruction = !analysis.no_next_instruction;
            current_address = cpu.eip;

            dbg_assert!(Page::page_of(current_address) == Page::page_of(addr_before_instruction));
            let current_virt_addr = to_visit & !0xFFF | current_address as i32 & 0xFFF;

            match analysis.ty {
                AnalysisType::Normal | AnalysisType::STI => {
                    dbg_assert!(has_next_instruction);
                    dbg_assert!(!analysis.absolute_jump);

                    if current_block.has_sti {
                        // Convert next instruction after STI (i.e., the current instruction) into block boundary

                        marked_as_entry.insert(current_virt_addr);
                        to_visit_stack.push(current_virt_addr);

                        current_block.last_instruction_addr = addr_before_instruction;
                        current_block.end_addr = current_address;
                        break;
                    }

                    if analysis.ty == AnalysisType::STI {
                        current_block.has_sti = true;

                        dbg_assert!(
                            !is_near_end_of_page(current_address),
                            "TODO: Handle STI instruction near end of page"
                        );
                    }
                    else {
                        // Only split non-STI blocks (one instruction needs to run after STI before
                        // handle_irqs may be called)

                        if basic_blocks.contains_key(&current_address) {
                            current_block.last_instruction_addr = addr_before_instruction;
                            current_block.end_addr = current_address;
                            dbg_assert!(!is_near_end_of_page(current_address));
                            current_block.ty = BasicBlockType::Normal {
                                next_block_addr: Some(current_address),
                                jump_offset: 0,
                                jump_offset_is_32: true,
                            };
                            break;
                        }
                    }
                },
                AnalysisType::Jump {
                    offset,
                    is_32,
                    condition: Some(condition),
                } => {
                    dbg_assert!(!analysis.absolute_jump);
                    // conditional jump: continue at next and continue at jump target

                    let jump_target = if is_32 {
                        current_virt_addr + offset
                    }
                    else {
                        cpu.cs_offset as i32
                            + (current_virt_addr - cpu.cs_offset as i32 + offset & 0xFFFF)
                    };

                    dbg_assert!(has_next_instruction);
                    to_visit_stack.push(current_virt_addr);

                    let next_block_addr = if is_near_end_of_page(current_address) {
                        None
                    }
                    else {
                        Some(current_address)
                    };

                    current_block.ty = BasicBlockType::ConditionalJump {
                        next_block_addr,
                        next_block_branch_taken_addr: follow_jump(
                            jump_target,
                            ctx,
                            &mut pages,
                            &mut page_blacklist,
                            max_pages,
                            &mut marked_as_entry,
                            &mut to_visit_stack,
                        ),
                        condition,
                        jump_offset: offset,
                        jump_offset_is_32: is_32,
                    };

                    current_block.last_instruction_addr = addr_before_instruction;
                    current_block.end_addr = current_address;

                    break;
                },
                AnalysisType::Jump {
                    offset,
                    is_32,
                    condition: None,
                } => {
                    dbg_assert!(!analysis.absolute_jump);
                    // non-conditional jump: continue at jump target

                    let jump_target = if is_32 {
                        current_virt_addr + offset
                    }
                    else {
                        cpu.cs_offset as i32
                            + (current_virt_addr - cpu.cs_offset as i32 + offset & 0xFFFF)
                    };

                    if has_next_instruction {
                        // Execution will eventually come back to the next instruction (CALL)
                        marked_as_entry.insert(current_virt_addr);
                        to_visit_stack.push(current_virt_addr);
                    }

                    current_block.ty = BasicBlockType::Normal {
                        next_block_addr: follow_jump(
                            jump_target,
                            ctx,
                            &mut pages,
                            &mut page_blacklist,
                            max_pages,
                            &mut marked_as_entry,
                            &mut to_visit_stack,
                        ),
                        jump_offset: offset,
                        jump_offset_is_32: is_32,
                    };
                    current_block.last_instruction_addr = addr_before_instruction;
                    current_block.end_addr = current_address;

                    break;
                },
                AnalysisType::BlockBoundary => {
                    // a block boundary but not a jump, get out

                    if has_next_instruction {
                        // block boundary, but execution will eventually come back
                        // to the next instruction. Create a new basic block
                        // starting at the next instruction and register it as an
                        // entry point
                        marked_as_entry.insert(current_virt_addr);
                        to_visit_stack.push(current_virt_addr);
                    }

                    if analysis.absolute_jump {
                        current_block.ty = BasicBlockType::AbsoluteEip;
                    }

                    current_block.last_instruction_addr = addr_before_instruction;
                    current_block.end_addr = current_address;
                    break;
                },
            }

            if is_near_end_of_page(current_address) {
                current_block.last_instruction_addr = addr_before_instruction;
                current_block.end_addr = current_address;
                profiler::stat_increment(stat::COMPILE_CUT_OFF_AT_END_OF_PAGE);
                break;
            }
        }

        let previous_block = basic_blocks
            .range(..current_block.addr)
            .next_back()
            .filter(|(_, previous_block)| !previous_block.has_sti)
            .map(|(_, previous_block)| previous_block);

        if let Some(previous_block) = previous_block {
            if current_block.addr < previous_block.end_addr {
                // If this block overlaps with the previous block, re-analyze the previous block
                to_visit_stack.push(previous_block.virt_addr);

                let addr = previous_block.addr;
                let old_block = basic_blocks.remove(&addr);
                dbg_assert!(old_block.is_some());

                // Note that this does not ensure the invariant that two consecutive blocks don't
                // overlay. For that, we also need to check the following block.
            }
        }

        dbg_assert!(current_block.addr < current_block.end_addr);
        dbg_assert!(current_block.addr <= current_block.last_instruction_addr);
        dbg_assert!(current_block.last_instruction_addr < current_block.end_addr);

        basic_blocks.insert(current_block.addr, current_block);
    }

    dbg_assert!(pages.len() as u32 <= max_pages);

    for block in basic_blocks.values_mut() {
        if marked_as_entry.contains(&block.virt_addr) {
            block.is_entry_block = true;
        }
    }

    let basic_blocks: Vec<BasicBlock> = basic_blocks.into_iter().map(|(_, block)| block).collect();

    for i in 0..basic_blocks.len() - 1 {
        let next_block_addr = basic_blocks[i + 1].addr;
        let next_block_end_addr = basic_blocks[i + 1].end_addr;
        let next_block_is_entry = basic_blocks[i + 1].is_entry_block;
        let block = &basic_blocks[i];
        dbg_assert!(block.addr < next_block_addr);
        if next_block_addr < block.end_addr {
            dbg_log!(
                "Overlapping first=[from={:x} to={:x} is_entry={}] second=[from={:x} to={:x} is_entry={}]",
                block.addr,
                block.end_addr,
                block.is_entry_block as u8,
                next_block_addr,
                next_block_end_addr,
                next_block_is_entry as u8
            );
        }
    }

    basic_blocks
}

#[no_mangle]
#[cfg(debug_assertions)]
pub fn jit_force_generate_unsafe(virt_addr: i32) {
    dbg_assert!(
        !is_near_end_of_page(virt_addr as u32),
        "cannot force compile near end of page"
    );
    jit_increase_hotness_and_maybe_compile(
        virt_addr,
        cpu::translate_address_read(virt_addr).unwrap(),
        cpu::get_seg_cs() as u32,
        cpu::get_state_flags(),
        JIT_THRESHOLD,
    );
    dbg_assert!(get_jit_state().compiling.is_some());
}

#[inline(never)]
fn jit_analyze_and_generate(
    ctx: &mut JitState,
    virt_entry_point: i32,
    phys_entry_point: u32,
    cs_offset: u32,
    state_flags: CachedStateFlags,
) {
    let page = Page::page_of(phys_entry_point);

    dbg_assert!(ctx.compiling.is_none());

    let (_, entry_points) = match ctx.entry_points.get(&page) {
        None => return,
        Some(entry_points) => entry_points,
    };

    let existing_entry_points = match ctx.pages.get(&page) {
        Some(PageInfo { entry_points, .. }) => HashSet::from_iter(entry_points.iter().map(|x| x.0)),
        None => HashSet::new(),
    };

    if entry_points
        .iter()
        .all(|entry_point| existing_entry_points.contains(entry_point))
    {
        profiler::stat_increment(stat::COMPILE_SKIPPED_NO_NEW_ENTRY_POINTS);
        return;
    }

    // XXX: check and remove
    //let old_length = entry_points.len();
    //entry_points.extend(existing_entry_points);
    //dbg_log!(
    //    "{} + {} = {}",
    //    entry_points.len(),
    //    existing_entry_points.len(),
    //    entry_points.union(&existing_entry_points).count()
    //);
    //dbg_assert!(entry_points.union(&existing_entry_points).count() == entry_points.len());

    profiler::stat_increment(stat::COMPILE);

    let cpu = CpuContext {
        eip: 0,
        prefixes: 0,
        cs_offset,
        state_flags,
    };

    dbg_assert!(
        cpu::translate_address_read_no_side_effects(virt_entry_point).unwrap() == phys_entry_point
    );
    let virt_page = Page::page_of(virt_entry_point as u32);
    let entry_points: HashSet<i32> = entry_points
        .iter()
        .map(|e| virt_page.to_address() as i32 | *e as i32)
        .collect();
    let basic_blocks = jit_find_basic_blocks(ctx, entry_points, cpu.clone());

    let mut pages = HashSet::new();

    for b in basic_blocks.iter() {
        // Remove this assertion once page-crossing jit is enabled
        dbg_assert!(Page::page_of(b.addr) == Page::page_of(b.end_addr));
        pages.insert(Page::page_of(b.addr));
    }

    let print = false;

    for b in basic_blocks.iter() {
        if !print {
            break;
        }
        let last_instruction_opcode = memory::read32s(b.last_instruction_addr);
        let op = opstats::decode(last_instruction_opcode as u32);
        dbg_log!(
            "BB: 0x{:x} {}{:02x} {} {}",
            b.addr,
            if op.is_0f { "0f" } else { "" },
            op.opcode,
            if b.is_entry_block { "entry" } else { "noentry" },
            match &b.ty {
                BasicBlockType::ConditionalJump {
                    next_block_addr: Some(next_block_addr),
                    next_block_branch_taken_addr: Some(next_block_branch_taken_addr),
                    ..
                } => format!(
                    "0x{:x} 0x{:x}",
                    next_block_addr, next_block_branch_taken_addr
                ),
                BasicBlockType::ConditionalJump {
                    next_block_addr: None,
                    next_block_branch_taken_addr: Some(next_block_branch_taken_addr),
                    ..
                } => format!("0x{:x}", next_block_branch_taken_addr),
                BasicBlockType::ConditionalJump {
                    next_block_addr: Some(next_block_addr),
                    next_block_branch_taken_addr: None,
                    ..
                } => format!("0x{:x}", next_block_addr),
                BasicBlockType::ConditionalJump {
                    next_block_addr: None,
                    next_block_branch_taken_addr: None,
                    ..
                } => format!(""),
                BasicBlockType::Normal {
                    next_block_addr: Some(next_block_addr),
                    ..
                } => format!("0x{:x}", next_block_addr),
                BasicBlockType::Normal {
                    next_block_addr: None,
                    ..
                } => format!(""),
                BasicBlockType::Exit => format!(""),
                BasicBlockType::AbsoluteEip => format!(""),
            }
        );
    }

    let graph = control_flow::make_graph(&basic_blocks);
    let mut structure = control_flow::loopify(&graph);

    if print {
        dbg_log!("before blockify:");
        for group in &structure {
            dbg_log!("=> Group");
            group.print(0);
        }
    }

    control_flow::blockify(&mut structure, &graph);

    if cfg!(debug_assertions) {
        control_flow::assert_invariants(&structure);
    }

    if print {
        dbg_log!("after blockify:");
        for group in &structure {
            dbg_log!("=> Group");
            group.print(0);
        }
    }

    if ctx.wasm_table_index_free_list.is_empty() {
        dbg_log!("wasm_table_index_free_list empty, clearing cache");

        // When no free slots are available, delete all cached modules. We could increase the
        // size of the table, but this way the initial size acts as an upper bound for the
        // number of wasm modules that we generate, which we want anyway to avoid getting our
        // tab killed by browsers due to memory constraints.
        jit_clear_cache(ctx);

        profiler::stat_increment(stat::INVALIDATE_ALL_MODULES_NO_FREE_WASM_INDICES);

        dbg_log!(
            "after jit_clear_cache: {} free",
            ctx.wasm_table_index_free_list.len(),
        );

        // This assertion can fail if all entries are pending (not possible unless
        // WASM_TABLE_SIZE is set very low)
        dbg_assert!(!ctx.wasm_table_index_free_list.is_empty());
    }

    // allocate an index in the wasm table
    let wasm_table_index = ctx
        .wasm_table_index_free_list
        .pop()
        .expect("allocate wasm table index");
    dbg_assert!(wasm_table_index != WasmTableIndex(0));

    dbg_assert!(!pages.is_empty());
    dbg_assert!(pages.len() <= unsafe { MAX_PAGES } as usize);

    let basic_block_by_addr: HashMap<u32, BasicBlock> =
        basic_blocks.into_iter().map(|b| (b.addr, b)).collect();

    let entries = jit_generate_module(
        structure,
        &basic_block_by_addr,
        cpu,
        &mut ctx.wasm_builder,
        wasm_table_index,
        state_flags,
    );
    dbg_assert!(!entries.is_empty());

    let mut page_info = HashMap::new();
    for &(addr, state) in &entries {
        let code = page_info
            .entry(Page::page_of(addr))
            .or_insert_with(|| PageInfo {
                wasm_table_index,
                state_flags,
                entry_points: Vec::new(),
                hidden_wasm_table_indices: Vec::new(),
            });
        code.entry_points.push((addr as u16 & 0xFFF, state));
    }

    profiler::stat_increment_by(
        stat::COMPILE_WASM_TOTAL_BYTES,
        ctx.wasm_builder.get_output_len() as u64,
    );
    profiler::stat_increment_by(stat::COMPILE_PAGE, pages.len() as u64);

    for &p in &pages {
        ctx.entry_points
            .entry(p)
            .or_insert_with(|| (0, HashSet::new()));
    }

    cpu::tlb_set_has_code_multiple(&pages, true);

    dbg_assert!(ctx.compiling.is_none());
    ctx.compiling = Some((
        wasm_table_index,
        CompilingPageState::Compiling { pages: page_info },
    ));

    let phys_addr = page.to_address();

    // will call codegen_finalize_finished asynchronously when finished
    codegen_finalize(
        wasm_table_index,
        phys_addr,
        state_flags,
        ctx.wasm_builder.get_output_ptr() as u32,
        ctx.wasm_builder.get_output_len(),
    );

    check_jit_state_invariants(ctx);
}

#[no_mangle]
pub fn codegen_finalize_finished(
    wasm_table_index: WasmTableIndex,
    phys_addr: u32,
    state_flags: CachedStateFlags,
) {
    let mut ctx = get_jit_state();

    dbg_assert!(wasm_table_index != WasmTableIndex(0));

    dbg_log!(
        "Finished compiling for page at {:x}",
        Page::page_of(phys_addr).to_address()
    );

    let pages = match mem::replace(&mut ctx.compiling, None) {
        None => {
            dbg_assert!(false);
            return;
        },
        Some((in_progress_wasm_table_index, CompilingPageState::CompilingWritten)) => {
            dbg_assert!(wasm_table_index == in_progress_wasm_table_index);

            profiler::stat_increment(stat::INVALIDATE_MODULE_WRITTEN_WHILE_COMPILED);
            free_wasm_table_index(&mut ctx, wasm_table_index);
            check_jit_state_invariants(&mut ctx);
            return;
        },
        Some((in_progress_wasm_table_index, CompilingPageState::Compiling { pages })) => {
            dbg_assert!(wasm_table_index == in_progress_wasm_table_index);
            dbg_assert!(!pages.is_empty());
            pages
        },
    };

    for i in 0..unsafe { cpu::valid_tlb_entries_count } {
        let page = unsafe { cpu::valid_tlb_entries[i as usize] };
        let entry = unsafe { cpu::tlb_data[page as usize] };
        if 0 != entry {
            let tlb_physical_page = Page::of_u32(
                (entry as u32 >> 12 ^ page as u32) - (unsafe { memory::mem8 } as u32 >> 12),
            );
            if let Some(info) = pages.get(&tlb_physical_page) {
                set_tlb_code(
                    Page::of_u32(page as u32),
                    wasm_table_index,
                    &info.entry_points,
                    state_flags,
                );
            }
        }
    }

    let mut check_for_unused_wasm_table_index = HashSet::new();

    for (page, mut info) in pages {
        if let Some(old_entry) = ctx.pages.remove(&page) {
            info.hidden_wasm_table_indices
                .extend(old_entry.hidden_wasm_table_indices);
            info.hidden_wasm_table_indices
                .push(old_entry.wasm_table_index);
            check_for_unused_wasm_table_index.insert(old_entry.wasm_table_index);
        }
        ctx.pages.insert(page, info);
    }

    let unused: Vec<&WasmTableIndex> = check_for_unused_wasm_table_index
        .iter()
        .filter(|&&i| ctx.pages.values().all(|page| page.wasm_table_index != i))
        .collect();

    for &index in unused {
        for p in ctx.pages.values_mut() {
            p.hidden_wasm_table_indices.retain(|&w| w != index);
        }

        dbg_log!("unused after overwrite {}", index.to_u16());
        profiler::stat_increment(stat::INVALIDATE_MODULE_UNUSED_AFTER_OVERWRITE);
        free_wasm_table_index(&mut ctx, index);
    }

    check_jit_state_invariants(&mut ctx);
}

pub fn update_tlb_code(virt_page: Page, phys_page: Page) {
    let ctx = get_jit_state();

    match ctx.pages.get(&phys_page) {
        Some(PageInfo {
            wasm_table_index,
            entry_points,
            state_flags,
            hidden_wasm_table_indices: _,
        }) => set_tlb_code(virt_page, *wasm_table_index, entry_points, *state_flags),
        None => cpu::clear_tlb_code(phys_page.to_u32() as i32),
    };
}

pub fn set_tlb_code(
    virt_page: Page,
    wasm_table_index: WasmTableIndex,
    entries: &Vec<(u16, u16)>,
    state_flags: CachedStateFlags,
) {
    let c = match unsafe { cpu::tlb_code[virt_page.to_u32() as usize] } {
        None => {
            let state_table = [u16::MAX; 0x1000];
            unsafe {
                let mut c = NonNull::new_unchecked(Box::into_raw(Box::new(cpu::Code {
                    wasm_table_index,
                    state_flags,
                    state_table,
                })));
                cpu::tlb_code[virt_page.to_u32() as usize] = Some(c);
                c.as_mut()
            }
        },
        Some(mut c) => unsafe {
            let c = c.as_mut();
            c.state_table.fill(u16::MAX);
            c.state_flags = state_flags;
            c.wasm_table_index = wasm_table_index;
            c
        },
    };

    for &(addr, state) in entries {
        dbg_assert!(state != u16::MAX);
        c.state_table[addr as usize] = state;
    }
}

fn jit_generate_module(
    structure: Vec<WasmStructure>,
    basic_blocks: &HashMap<u32, BasicBlock>,
    mut cpu: CpuContext,
    builder: &mut WasmBuilder,
    wasm_table_index: WasmTableIndex,
    state_flags: CachedStateFlags,
) -> Vec<(u32, u16)> {
    builder.reset();

    let mut register_locals = (0..8)
        .map(|i| {
            builder.load_fixed_i32(global_pointers::get_reg32_offset(i));
            builder.set_new_local()
        })
        .collect();

    builder.const_i32(0);
    let instruction_counter = builder.set_new_local();

    let exit_label = builder.block_void();
    let exit_with_fault_label = builder.block_void();
    let main_loop_label = builder.loop_void();
    if unsafe { JIT_USE_LOOP_SAFETY } {
        builder.get_local(&instruction_counter);
        builder.const_i32(cpu::LOOP_COUNTER);
        builder.geu_i32();
        if cfg!(feature = "profiler") {
            builder.if_void();
            codegen::gen_debug_track_jit_exit(builder, 0);
            builder.br(exit_label);
            builder.block_end();
        }
        else {
            builder.br_if(exit_label);
        }
    }
    let brtable_default = builder.block_void();

    let ctx = &mut JitContext {
        cpu: &mut cpu,
        builder,
        register_locals: &mut register_locals,
        start_of_current_instruction: 0,
        exit_with_fault_label,
        exit_label,
        current_instruction: Instruction::Other,
        previous_instruction: Instruction::Other,
        instruction_counter,
    };

    let entry_blocks = {
        let mut nodes = &structure;
        let result;
        loop {
            match &nodes[0] {
                WasmStructure::Dispatcher(e) => {
                    result = e.clone();
                    break;
                },
                WasmStructure::Loop { .. } => {
                    dbg_assert!(false);
                },
                WasmStructure::BasicBlock(_) => {
                    dbg_assert!(false);
                },
                // Note: We could use these blocks as entry points, which will yield
                // more entries for free, but it requires adding those to the dispatcher
                // It's to be investigated if this yields a performance improvement
                // See also the comment at the bottom of this function when creating entry
                // points
                WasmStructure::Block(children) => {
                    nodes = children;
                },
            }
        }
        result
    };

    let mut index_for_addr = HashMap::new();
    for (i, &addr) in entry_blocks.iter().enumerate() {
        dbg_assert!(i < 0x10000);
        index_for_addr.insert(addr, i as u16);
    }
    for b in basic_blocks.values() {
        if !index_for_addr.contains_key(&b.addr) {
            let i = index_for_addr.len();
            dbg_assert!(i < 0x10000);
            index_for_addr.insert(b.addr, i as u16);
        }
    }

    let mut label_for_addr: HashMap<u32, (Label, Option<u16>)> = HashMap::new();

    enum Work {
        WasmStructure(WasmStructure),
        BlockEnd {
            label: Label,
            targets: Vec<u32>,
            olds: HashMap<u32, (Label, Option<u16>)>,
        },
        LoopEnd {
            label: Label,
            entries: Vec<u32>,
            olds: HashMap<u32, (Label, Option<u16>)>,
        },
    }
    let mut work: VecDeque<Work> = structure
        .into_iter()
        .map(|x| Work::WasmStructure(x))
        .collect();

    while let Some(block) = work.pop_front() {
        let next_addr: Option<Vec<u32>> = work.iter().find_map(|x| match x {
            Work::WasmStructure(l) => Some(l.head().collect()),
            _ => None,
        });
        let target_block = &ctx.builder.arg_local_initial_state.unsafe_clone();

        match block {
            Work::WasmStructure(WasmStructure::BasicBlock(addr)) => {
                let block = basic_blocks.get(&addr).unwrap();
                jit_generate_basic_block(ctx, block);

                if block.has_sti {
                    match block.ty {
                        BasicBlockType::ConditionalJump {
                            condition,
                            jump_offset,
                            jump_offset_is_32,
                            ..
                        } => {
                            codegen::gen_set_eip_low_bits(
                                ctx.builder,
                                block.end_addr as i32 & 0xFFF,
                            );
                            codegen::gen_condition_fn(ctx, condition);
                            ctx.builder.if_void();
                            if jump_offset_is_32 {
                                codegen::gen_relative_jump(ctx.builder, jump_offset);
                            }
                            else {
                                codegen::gen_jmp_rel16(ctx.builder, jump_offset as u16);
                            }
                            ctx.builder.block_end();
                        },
                        BasicBlockType::Normal {
                            jump_offset,
                            jump_offset_is_32,
                            ..
                        } => {
                            if jump_offset_is_32 {
                                codegen::gen_set_eip_low_bits_and_jump_rel32(
                                    ctx.builder,
                                    block.end_addr as i32 & 0xFFF,
                                    jump_offset,
                                );
                            }
                            else {
                                codegen::gen_set_eip_low_bits(
                                    ctx.builder,
                                    block.end_addr as i32 & 0xFFF,
                                );
                                codegen::gen_jmp_rel16(ctx.builder, jump_offset as u16);
                            }
                        },
                        BasicBlockType::Exit => {},
                        BasicBlockType::AbsoluteEip => {},
                    };
                    codegen::gen_debug_track_jit_exit(ctx.builder, block.last_instruction_addr);
                    codegen::gen_move_registers_from_locals_to_memory(ctx);
                    codegen::gen_fn0_const(ctx.builder, "handle_irqs");
                    codegen::gen_update_instruction_counter(ctx);
                    ctx.builder.return_();
                    continue;
                }

                match &block.ty {
                    BasicBlockType::Exit => {
                        // Exit this function
                        codegen::gen_debug_track_jit_exit(ctx.builder, block.last_instruction_addr);
                        codegen::gen_profiler_stat_increment(ctx.builder, stat::DIRECT_EXIT);
                        ctx.builder.br(ctx.exit_label);
                    },
                    BasicBlockType::AbsoluteEip => {
                        // Check if we can stay in this module, if not exit
                        codegen::gen_get_eip(ctx.builder);
                        ctx.builder.const_i32(wasm_table_index.to_u16() as i32);
                        ctx.builder.const_i32(state_flags.to_u32() as i32);
                        ctx.builder.call_fn3_ret("jit_find_cache_entry_in_page");
                        ctx.builder.tee_local(target_block);
                        ctx.builder.const_i32(0);
                        ctx.builder.ge_i32();
                        // TODO: Could make this unconditional by including exit_label in the main br_table
                        ctx.builder.br_if(main_loop_label);

                        codegen::gen_debug_track_jit_exit(ctx.builder, block.last_instruction_addr);
                        ctx.builder.br(ctx.exit_label);
                    },
                    &BasicBlockType::Normal {
                        next_block_addr: None,
                        jump_offset,
                        jump_offset_is_32,
                    } => {
                        if jump_offset_is_32 {
                            codegen::gen_set_eip_low_bits_and_jump_rel32(
                                ctx.builder,
                                block.end_addr as i32 & 0xFFF,
                                jump_offset,
                            );
                        }
                        else {
                            codegen::gen_set_eip_low_bits(
                                ctx.builder,
                                block.end_addr as i32 & 0xFFF,
                            );
                            codegen::gen_jmp_rel16(ctx.builder, jump_offset as u16);
                        }

                        codegen::gen_debug_track_jit_exit(ctx.builder, block.last_instruction_addr);
                        codegen::gen_profiler_stat_increment(ctx.builder, stat::DIRECT_EXIT);
                        ctx.builder.br(ctx.exit_label);
                    },
                    &BasicBlockType::Normal {
                        next_block_addr: Some(next_block_addr),
                        jump_offset,
                        jump_offset_is_32,
                    } => {
                        // Unconditional jump to next basic block
                        // - All instructions that don't change eip
                        // - Unconditional jumps

                        if Page::page_of(next_block_addr) != Page::page_of(block.addr) {
                            if jump_offset_is_32 {
                                codegen::gen_set_eip_low_bits_and_jump_rel32(
                                    ctx.builder,
                                    block.end_addr as i32 & 0xFFF,
                                    jump_offset,
                                );
                            }
                            else {
                                codegen::gen_set_eip_low_bits(
                                    ctx.builder,
                                    block.end_addr as i32 & 0xFFF,
                                );
                                codegen::gen_jmp_rel16(ctx.builder, jump_offset as u16);
                            }

                            codegen::gen_profiler_stat_increment(
                                ctx.builder,
                                stat::NORMAL_PAGE_CHANGE,
                            );

                            codegen::gen_page_switch_check(
                                ctx,
                                next_block_addr,
                                block.last_instruction_addr,
                            );

                            #[cfg(debug_assertions)]
                            codegen::gen_fn2_const(
                                ctx.builder,
                                "check_page_switch",
                                block.addr,
                                next_block_addr,
                            );
                        }

                        if next_addr
                            .as_ref()
                            .map_or(false, |n| n.contains(&next_block_addr))
                        {
                            // Blocks are consecutive
                            if next_addr.unwrap().len() > 1 {
                                let target_index = *index_for_addr.get(&next_block_addr).unwrap();
                                if cfg!(feature = "profiler") {
                                    ctx.builder.const_i32(target_index.into());
                                    ctx.builder.call_fn1("debug_set_dispatcher_target");
                                }
                                ctx.builder.const_i32(target_index.into());
                                ctx.builder.set_local(target_block);
                                codegen::gen_profiler_stat_increment(
                                    ctx.builder,
                                    stat::NORMAL_FALLTHRU_WITH_TARGET_BLOCK,
                                );
                            }
                            else {
                                codegen::gen_profiler_stat_increment(
                                    ctx.builder,
                                    stat::NORMAL_FALLTHRU,
                                );
                            }
                        }
                        else {
                            let &(br, target_index) = label_for_addr.get(&next_block_addr).unwrap();
                            if let Some(target_index) = target_index {
                                if cfg!(feature = "profiler") {
                                    ctx.builder.const_i32(target_index.into());
                                    ctx.builder.call_fn1("debug_set_dispatcher_target");
                                }
                                ctx.builder.const_i32(target_index.into());
                                ctx.builder.set_local(target_block);
                                codegen::gen_profiler_stat_increment(
                                    ctx.builder,
                                    stat::NORMAL_BRANCH_WITH_TARGET_BLOCK,
                                );
                            }
                            else {
                                codegen::gen_profiler_stat_increment(
                                    ctx.builder,
                                    stat::NORMAL_BRANCH,
                                );
                            }
                            ctx.builder.br(br);
                        }
                    },
                    &BasicBlockType::ConditionalJump {
                        next_block_addr,
                        next_block_branch_taken_addr,
                        condition,
                        jump_offset,
                        jump_offset_is_32,
                    } => {
                        // Conditional jump to next basic block
                        // - jnz, jc, loop, jcxz, etc.

                        // Generate:
                        // (1) condition()
                        // (2) br_if()
                        // (3) br()
                        // Except:
                        // If we need to update eip in case (2), it's replaced by if { update_eip(); br() }
                        // If case (3) can fall through to the next basic block, the branch is eliminated
                        // Dispatcher target writes can be generated in either case
                        // Condition may be inverted if it helps generate a fallthrough instead of the second branch

                        codegen::gen_profiler_stat_increment(ctx.builder, stat::CONDITIONAL_JUMP);

                        #[derive(PartialEq)]
                        enum Case {
                            BranchTaken,
                            BranchNotTaken,
                        }

                        let mut handle_case = |case: Case, is_first| {
                            // first case generates condition and *has* to branch away,
                            // second case branches unconditionally or falls through

                            if is_first {
                                if case == Case::BranchNotTaken {
                                    codegen::gen_condition_fn_negated(ctx, condition);
                                }
                                else {
                                    codegen::gen_condition_fn(ctx, condition);
                                }
                            }

                            let next_block_addr = if case == Case::BranchTaken {
                                next_block_branch_taken_addr
                            }
                            else {
                                next_block_addr
                            };

                            if let Some(next_block_addr) = next_block_addr {
                                if Page::page_of(next_block_addr) != Page::page_of(block.addr) {
                                    dbg_assert!(case == Case::BranchTaken); // currently not possible in other case
                                    if is_first {
                                        ctx.builder.if_i32();
                                    }
                                    if jump_offset_is_32 {
                                        codegen::gen_set_eip_low_bits_and_jump_rel32(
                                            ctx.builder,
                                            block.end_addr as i32 & 0xFFF,
                                            jump_offset,
                                        );
                                    }
                                    else {
                                        codegen::gen_set_eip_low_bits(
                                            ctx.builder,
                                            block.end_addr as i32 & 0xFFF,
                                        );
                                        codegen::gen_jmp_rel16(ctx.builder, jump_offset as u16);
                                    }

                                    codegen::gen_profiler_stat_increment(
                                        ctx.builder,
                                        stat::CONDITIONAL_JUMP_PAGE_CHANGE,
                                    );
                                    codegen::gen_page_switch_check(
                                        ctx,
                                        next_block_addr,
                                        block.last_instruction_addr,
                                    );

                                    #[cfg(debug_assertions)]
                                    codegen::gen_fn2_const(
                                        ctx.builder,
                                        "check_page_switch",
                                        block.addr,
                                        next_block_addr,
                                    );

                                    if is_first {
                                        ctx.builder.const_i32(1);
                                        ctx.builder.else_();
                                        ctx.builder.const_i32(0);
                                        ctx.builder.block_end();
                                    }
                                }

                                if next_addr
                                    .as_ref()
                                    .map_or(false, |n| n.contains(&next_block_addr))
                                {
                                    // blocks are consecutive

                                    // fallthrough, has to be second
                                    dbg_assert!(!is_first);

                                    if next_addr.as_ref().unwrap().len() > 1 {
                                        let target_index =
                                            *index_for_addr.get(&next_block_addr).unwrap();
                                        if cfg!(feature = "profiler") {
                                            ctx.builder.const_i32(target_index.into());
                                            ctx.builder.call_fn1("debug_set_dispatcher_target");
                                        }
                                        ctx.builder.const_i32(target_index.into());
                                        ctx.builder.set_local(target_block);
                                        codegen::gen_profiler_stat_increment(
                                            ctx.builder,
                                            stat::CONDITIONAL_JUMP_FALLTHRU_WITH_TARGET_BLOCK,
                                        );
                                    }
                                    else {
                                        codegen::gen_profiler_stat_increment(
                                            ctx.builder,
                                            stat::CONDITIONAL_JUMP_FALLTHRU,
                                        );
                                    }
                                }
                                else {
                                    let &(br, target_index) =
                                        label_for_addr.get(&next_block_addr).unwrap();
                                    if let Some(target_index) = target_index {
                                        if cfg!(feature = "profiler") {
                                            // Note: Currently called unconditionally, even if the
                                            // br_if below doesn't branch
                                            ctx.builder.const_i32(target_index.into());
                                            ctx.builder.call_fn1("debug_set_dispatcher_target");
                                        }
                                        ctx.builder.const_i32(target_index.into());
                                        ctx.builder.set_local(target_block);
                                    }

                                    if is_first {
                                        if cfg!(feature = "profiler") {
                                            ctx.builder.if_void();
                                            codegen::gen_profiler_stat_increment(
                                                ctx.builder,
                                                if target_index.is_some() {
                                                    stat::CONDITIONAL_JUMP_BRANCH_WITH_TARGET_BLOCK
                                                }
                                                else {
                                                    stat::CONDITIONAL_JUMP_BRANCH
                                                },
                                            );
                                            ctx.builder.br(br);
                                            ctx.builder.block_end();
                                        }
                                        else {
                                            ctx.builder.br_if(br);
                                        }
                                    }
                                    else {
                                        codegen::gen_profiler_stat_increment(
                                            ctx.builder,
                                            if target_index.is_some() {
                                                stat::CONDITIONAL_JUMP_BRANCH_WITH_TARGET_BLOCK
                                            }
                                            else {
                                                stat::CONDITIONAL_JUMP_BRANCH
                                            },
                                        );
                                        ctx.builder.br(br);
                                    }
                                }
                            }
                            else {
                                // target is outside of this module, update eip and exit
                                if is_first {
                                    ctx.builder.if_void();
                                }

                                if case == Case::BranchTaken {
                                    if jump_offset_is_32 {
                                        codegen::gen_set_eip_low_bits_and_jump_rel32(
                                            ctx.builder,
                                            block.end_addr as i32 & 0xFFF,
                                            jump_offset,
                                        );
                                    }
                                    else {
                                        codegen::gen_set_eip_low_bits(
                                            ctx.builder,
                                            block.end_addr as i32 & 0xFFF,
                                        );
                                        codegen::gen_jmp_rel16(ctx.builder, jump_offset as u16);
                                    }
                                }
                                else {
                                    codegen::gen_set_eip_low_bits(
                                        ctx.builder,
                                        block.end_addr as i32 & 0xFFF,
                                    );
                                }

                                codegen::gen_debug_track_jit_exit(
                                    ctx.builder,
                                    block.last_instruction_addr,
                                );
                                codegen::gen_profiler_stat_increment(
                                    ctx.builder,
                                    stat::CONDITIONAL_JUMP_EXIT,
                                );
                                ctx.builder.br(ctx.exit_label);

                                if is_first {
                                    ctx.builder.block_end();
                                }
                            }
                        };

                        let branch_taken_is_fallthrough = next_block_branch_taken_addr
                            .map_or(false, |addr| {
                                next_addr.as_ref().map_or(false, |n| n.contains(&addr))
                            });
                        let branch_not_taken_is_fallthrough = next_block_addr
                            .map_or(false, |addr| {
                                next_addr.as_ref().map_or(false, |n| n.contains(&addr))
                            });

                        if branch_not_taken_is_fallthrough && branch_taken_is_fallthrough {
                            let next_block_addr = next_block_addr.unwrap();
                            let next_block_branch_taken_addr =
                                next_block_branch_taken_addr.unwrap();

                            dbg_log!(
                                "Conditional control flow: fallthrough in both cases, page_switch={} next_is_multi={}",
                                Page::page_of(next_block_branch_taken_addr)
                                    != Page::page_of(block.addr),
                                next_addr.as_ref().unwrap().len() > 1,
                            );

                            dbg_assert!(
                                Page::page_of(next_block_addr) == Page::page_of(block.addr)
                            ); // currently not possible

                            if Page::page_of(next_block_branch_taken_addr)
                                != Page::page_of(block.addr)
                            {
                                codegen::gen_condition_fn(ctx, condition);
                                ctx.builder.if_void();

                                if jump_offset_is_32 {
                                    codegen::gen_set_eip_low_bits_and_jump_rel32(
                                        ctx.builder,
                                        block.end_addr as i32 & 0xFFF,
                                        jump_offset,
                                    );
                                }
                                else {
                                    codegen::gen_set_eip_low_bits(
                                        ctx.builder,
                                        block.end_addr as i32 & 0xFFF,
                                    );
                                    codegen::gen_jmp_rel16(ctx.builder, jump_offset as u16);
                                }

                                codegen::gen_profiler_stat_increment(
                                    ctx.builder,
                                    stat::CONDITIONAL_JUMP_PAGE_CHANGE,
                                );
                                codegen::gen_page_switch_check(
                                    ctx,
                                    next_block_branch_taken_addr,
                                    block.last_instruction_addr,
                                );

                                #[cfg(debug_assertions)]
                                codegen::gen_fn2_const(
                                    ctx.builder,
                                    "check_page_switch",
                                    block.addr,
                                    next_block_branch_taken_addr,
                                );

                                dbg_assert!(next_addr.unwrap().len() > 1);

                                let target_index_taken =
                                    *index_for_addr.get(&next_block_branch_taken_addr).unwrap();
                                let target_index_not_taken =
                                    *index_for_addr.get(&next_block_addr).unwrap();

                                ctx.builder.const_i32(target_index_taken.into());
                                ctx.builder.set_local(target_block);

                                ctx.builder.else_();
                                ctx.builder.const_i32(target_index_not_taken.into());
                                ctx.builder.set_local(target_block);

                                ctx.builder.block_end();
                            }
                            else if next_addr.unwrap().len() > 1 {
                                let target_index_taken =
                                    *index_for_addr.get(&next_block_branch_taken_addr).unwrap();
                                let target_index_not_taken =
                                    *index_for_addr.get(&next_block_addr).unwrap();

                                codegen::gen_condition_fn(ctx, condition);
                                ctx.builder.if_i32();
                                ctx.builder.const_i32(target_index_taken.into());
                                ctx.builder.else_();
                                ctx.builder.const_i32(target_index_not_taken.into());
                                ctx.builder.block_end();
                                ctx.builder.set_local(target_block);
                            }
                        }
                        else if branch_taken_is_fallthrough {
                            handle_case(Case::BranchNotTaken, true);
                            handle_case(Case::BranchTaken, false);
                        }
                        else {
                            handle_case(Case::BranchTaken, true);
                            handle_case(Case::BranchNotTaken, false);
                        }
                    },
                }
            },
            Work::WasmStructure(WasmStructure::Dispatcher(entries)) => {
                profiler::stat_increment(stat::COMPILE_DISPATCHER);

                if cfg!(feature = "profiler") {
                    ctx.builder.get_local(target_block);
                    ctx.builder.const_i32(index_for_addr.len() as i32);
                    ctx.builder.call_fn2("check_dispatcher_target");
                }

                if entries.len() > BRTABLE_CUTOFF {
                    // generate a brtable
                    codegen::gen_profiler_stat_increment(ctx.builder, stat::DISPATCHER_LARGE);
                    let mut cases = Vec::new();
                    for &addr in &entries {
                        let &(label, target_index) = label_for_addr.get(&addr).unwrap();
                        let &index = index_for_addr.get(&addr).unwrap();
                        dbg_assert!(target_index.is_none() || target_index == Some(index));
                        while index as usize >= cases.len() {
                            cases.push(brtable_default);
                        }
                        cases[index as usize] = label;
                    }
                    ctx.builder.get_local(target_block);
                    ctx.builder.brtable(brtable_default, &mut cases.iter());
                }
                else {
                    // generate a if target == block.addr then br block.label ...
                    codegen::gen_profiler_stat_increment(ctx.builder, stat::DISPATCHER_SMALL);
                    let nexts: HashSet<u32> = next_addr
                        .as_ref()
                        .map_or(HashSet::new(), |nexts| nexts.iter().copied().collect());
                    for &addr in &entries {
                        if nexts.contains(&addr) {
                            continue;
                        }
                        let index = *index_for_addr.get(&addr).unwrap();
                        let &(label, _) = label_for_addr.get(&addr).unwrap();
                        ctx.builder.get_local(target_block);
                        ctx.builder.const_i32(index.into());
                        ctx.builder.eq_i32();
                        ctx.builder.br_if(label);
                    }
                }
            },
            Work::WasmStructure(WasmStructure::Loop(children)) => {
                profiler::stat_increment(stat::COMPILE_WASM_LOOP);

                let entries: Vec<u32> = children[0].head().collect();
                let label = ctx.builder.loop_void();
                codegen::gen_profiler_stat_increment(ctx.builder, stat::LOOP);

                if entries.len() == 1 {
                    let addr = entries[0];
                    codegen::gen_set_eip_low_bits(ctx.builder, addr as i32 & 0xFFF);
                    profiler::stat_increment(stat::COMPILE_WITH_LOOP_SAFETY);
                    codegen::gen_profiler_stat_increment(ctx.builder, stat::LOOP_SAFETY);
                    if unsafe { JIT_USE_LOOP_SAFETY } {
                        ctx.builder.get_local(&ctx.instruction_counter);
                        ctx.builder.const_i32(cpu::LOOP_COUNTER);
                        ctx.builder.geu_i32();
                        if cfg!(feature = "profiler") {
                            ctx.builder.if_void();
                            codegen::gen_debug_track_jit_exit(ctx.builder, addr);
                            ctx.builder.br(exit_label);
                            ctx.builder.block_end();
                        }
                        else {
                            ctx.builder.br_if(exit_label);
                        }
                    }
                }

                let mut olds = HashMap::new();
                for &target in entries.iter() {
                    let index = if entries.len() == 1 {
                        None
                    }
                    else {
                        Some(*index_for_addr.get(&target).unwrap())
                    };
                    let old = label_for_addr.insert(target, (label, index));
                    if let Some(old) = old {
                        olds.insert(target, old);
                    }
                }

                work.push_front(Work::LoopEnd {
                    label,
                    entries,
                    olds,
                });
                for c in children.into_iter().rev() {
                    work.push_front(Work::WasmStructure(c));
                }
            },
            Work::LoopEnd {
                label,
                entries,
                olds,
            } => {
                for target in entries {
                    let old = label_for_addr.remove(&target);
                    dbg_assert!(old.map(|(l, _)| l) == Some(label));
                }
                for (target, old) in olds {
                    let old = label_for_addr.insert(target, old);
                    dbg_assert!(old.is_none());
                }

                ctx.builder.block_end();
            },
            Work::WasmStructure(WasmStructure::Block(children)) => {
                profiler::stat_increment(stat::COMPILE_WASM_BLOCK);

                let targets = next_addr.clone().unwrap();
                let label = ctx.builder.block_void();
                let mut olds = HashMap::new();
                for &target in targets.iter() {
                    let index = if targets.len() == 1 {
                        None
                    }
                    else {
                        Some(*index_for_addr.get(&target).unwrap())
                    };
                    let old = label_for_addr.insert(target, (label, index));
                    if let Some(old) = old {
                        olds.insert(target, old);
                    }
                }

                work.push_front(Work::BlockEnd {
                    label,
                    targets,
                    olds,
                });
                for c in children.into_iter().rev() {
                    work.push_front(Work::WasmStructure(c));
                }
            },
            Work::BlockEnd {
                label,
                targets,
                olds,
            } => {
                for target in targets {
                    let old = label_for_addr.remove(&target);
                    dbg_assert!(old.map(|(l, _)| l) == Some(label));
                }
                for (target, old) in olds {
                    let old = label_for_addr.insert(target, old);
                    dbg_assert!(old.is_none());
                }

                ctx.builder.block_end();
            },
        }
    }

    dbg_assert!(label_for_addr.is_empty());

    {
        ctx.builder.block_end(); // default case for the brtable
        ctx.builder.unreachable();
    }
    {
        ctx.builder.block_end(); // main loop
    }
    {
        // exit-with-fault case
        ctx.builder.block_end();
        codegen::gen_move_registers_from_locals_to_memory(ctx);
        codegen::gen_fn0_const(ctx.builder, "trigger_fault_end_jit");
        codegen::gen_update_instruction_counter(ctx);
        ctx.builder.return_();
    }
    {
        // exit
        ctx.builder.block_end();
        codegen::gen_move_registers_from_locals_to_memory(ctx);
        codegen::gen_update_instruction_counter(ctx);
    }

    for local in ctx.register_locals.drain(..) {
        ctx.builder.free_local(local);
    }
    ctx.builder
        .free_local(ctx.instruction_counter.unsafe_clone());

    ctx.builder.finish();

    let entries = Vec::from_iter(entry_blocks.iter().map(|addr| {
        let block = basic_blocks.get(&addr).unwrap();
        let index = *index_for_addr.get(&addr).unwrap();

        profiler::stat_increment(stat::COMPILE_ENTRY_POINT);

        dbg_assert!(block.addr < block.end_addr);
        // Note: We also insert blocks that weren't originally marked as entries here
        //       This doesn't have any downside, besides making the hash table slightly larger

        (block.addr, index)
    }));

    for b in basic_blocks.values() {
        if b.is_entry_block {
            dbg_assert!(entries.iter().find(|(addr, _)| *addr == b.addr).is_some());
        }
    }

    return entries;
}

fn jit_generate_basic_block(ctx: &mut JitContext, block: &BasicBlock) {
    let needs_eip_updated = match block.ty {
        BasicBlockType::Exit => true,
        _ => false,
    };

    profiler::stat_increment(stat::COMPILE_BASIC_BLOCK);

    let start_addr = block.addr;
    let last_instruction_addr = block.last_instruction_addr;
    let stop_addr = block.end_addr;

    // First iteration of do-while assumes the caller confirms this condition
    dbg_assert!(!is_near_end_of_page(start_addr));

    if cfg!(feature = "profiler") {
        ctx.builder.const_i32(start_addr as i32);
        ctx.builder.call_fn1("enter_basic_block");
    }

    ctx.builder.get_local(&ctx.instruction_counter);
    ctx.builder.const_i32(block.number_of_instructions as i32);
    ctx.builder.add_i32();
    ctx.builder.set_local(&ctx.instruction_counter);

    ctx.cpu.eip = start_addr;
    ctx.current_instruction = Instruction::Other;
    ctx.previous_instruction = Instruction::Other;

    loop {
        let mut instruction = 0;
        if cfg!(feature = "profiler") {
            instruction = memory::read32s(ctx.cpu.eip) as u32;
            opstats::gen_opstats(ctx.builder, instruction);
            opstats::record_opstat_compiled(instruction);
        }

        if ctx.cpu.eip == last_instruction_addr {
            // Before the last instruction:
            // - Set eip to *after* the instruction
            // - Set previous_eip to *before* the instruction
            if needs_eip_updated {
                codegen::gen_set_previous_eip_offset_from_eip_with_low_bits(
                    ctx.builder,
                    last_instruction_addr as i32 & 0xFFF,
                );
                codegen::gen_set_eip_low_bits(ctx.builder, stop_addr as i32 & 0xFFF);
            }
        }

        let wasm_length_before = ctx.builder.instruction_body_length();

        ctx.start_of_current_instruction = ctx.cpu.eip;
        let start_eip = ctx.cpu.eip;
        let mut instruction_flags = 0;
        jit_instructions::jit_instruction(ctx, &mut instruction_flags);
        let end_eip = ctx.cpu.eip;

        let instruction_length = end_eip - start_eip;
        let was_block_boundary = instruction_flags & JIT_INSTR_BLOCK_BOUNDARY_FLAG != 0;

        let wasm_length = ctx.builder.instruction_body_length() - wasm_length_before;
        opstats::record_opstat_size_wasm(instruction, wasm_length as u64);

        dbg_assert!((end_eip == stop_addr) == (start_eip == last_instruction_addr));
        dbg_assert!(instruction_length < MAX_INSTRUCTION_LENGTH);

        let end_addr = ctx.cpu.eip;

        if end_addr == stop_addr {
            // no page was crossed
            dbg_assert!(Page::page_of(end_addr) == Page::page_of(start_addr));
            break;
        }

        if was_block_boundary || is_near_end_of_page(end_addr) || end_addr > stop_addr {
            dbg_log!(
                "Overlapping basic blocks start={:x} expected_end={:x} end={:x} was_block_boundary={} near_end_of_page={}",
                start_addr,
                stop_addr,
                end_addr,
                was_block_boundary,
                is_near_end_of_page(end_addr)
            );
            dbg_assert!(false);
            break;
        }

        ctx.previous_instruction = mem::replace(&mut ctx.current_instruction, Instruction::Other);
    }
}

pub fn jit_increase_hotness_and_maybe_compile(
    virt_address: i32,
    phys_address: u32,
    cs_offset: u32,
    state_flags: CachedStateFlags,
    heat: u32,
) {
    if unsafe { JIT_DISABLED } {
        return;
    }

    let mut ctx = get_jit_state();
    let is_compiling = ctx.compiling.is_some();
    let page = Page::page_of(phys_address);
    let (hotness, entry_points) = ctx.entry_points.entry(page).or_insert_with(|| {
        cpu::tlb_set_has_code(page, true);
        profiler::stat_increment(stat::RUN_INTERPRETED_NEW_PAGE);
        (0, HashSet::new())
    });

    if !is_near_end_of_page(phys_address) {
        entry_points.insert(phys_address as u16 & 0xFFF);
    }

    *hotness += heat;
    if *hotness >= JIT_THRESHOLD {
        if is_compiling {
            return;
        }
        // only try generating if we're in the correct address space
        if cpu::translate_address_read_no_side_effects(virt_address) == Ok(phys_address) {
            *hotness = 0;
            jit_analyze_and_generate(&mut ctx, virt_address, phys_address, cs_offset, state_flags)
        }
        else {
            profiler::stat_increment(stat::COMPILE_WRONG_ADDRESS_SPACE);
        }
    }
}

fn free_wasm_table_index(ctx: &mut JitState, wasm_table_index: WasmTableIndex) {
    if CHECK_JIT_STATE_INVARIANTS {
        dbg_assert!(!ctx.wasm_table_index_free_list.contains(&wasm_table_index));

        match &ctx.compiling {
            Some((wasm_table_index_compiling, _)) => {
                dbg_assert!(
                    *wasm_table_index_compiling != wasm_table_index,
                    "Attempt to free wasm table index that is currently being compiled"
                );
            },
            _ => {},
        }

        dbg_assert!(!ctx
            .pages
            .values()
            .any(|info| info.wasm_table_index == wasm_table_index));

        dbg_assert!(!ctx
            .pages
            .values()
            .any(|info| info.hidden_wasm_table_indices.contains(&wasm_table_index)));

        for i in 0..unsafe { cpu::valid_tlb_entries_count } {
            let page = unsafe { cpu::valid_tlb_entries[i as usize] };
            unsafe {
                match cpu::tlb_code[page as usize] {
                    None => {},
                    Some(c) => {
                        let c = c.as_ref();
                        dbg_assert!(c.wasm_table_index != wasm_table_index);
                    },
                }
            }
        }
    }

    ctx.wasm_table_index_free_list.push(wasm_table_index);

    // It is not strictly necessary to clear the function, but it will fail more predictably if we
    // accidentally use the function and may garbage collect unused modules earlier
    jit_clear_func(wasm_table_index);
}

/// Register a write in this page: Delete all present code
fn jit_dirty_page_ctx(ctx: &mut JitState, page: Page) {
    let mut did_have_code = false;

    if let Some(PageInfo {
        wasm_table_index,
        hidden_wasm_table_indices,
        state_flags: _,
        entry_points: _,
    }) = ctx.pages.remove(&page)
    {
        profiler::stat_increment(stat::INVALIDATE_PAGE_HAD_CODE);
        did_have_code = true;

        free(ctx, wasm_table_index);
        for wasm_table_index in hidden_wasm_table_indices {
            free(ctx, wasm_table_index);
        }

        fn free(ctx: &mut JitState, wasm_table_index: WasmTableIndex) {
            for i in 0..unsafe { cpu::valid_tlb_entries_count } {
                let page = unsafe { cpu::valid_tlb_entries[i as usize] };
                let entry = unsafe { cpu::tlb_data[page as usize] };
                if 0 != entry {
                    let tlb_physical_page = Page::of_u32(
                        (entry as u32 >> 12 ^ page as u32) - (unsafe { memory::mem8 } as u32 >> 12),
                    );
                    match unsafe { cpu::tlb_code[page as usize] } {
                        None => {},
                        Some(c) => unsafe {
                            let w = c.as_ref().wasm_table_index;
                            if wasm_table_index == w {
                                drop(Box::from_raw(c.as_ptr()));
                                cpu::tlb_code[page as usize] = None;
                                if !ctx.entry_points.contains_key(&tlb_physical_page) {
                                    // XXX
                                    cpu::tlb_data[page as usize] &= !cpu::TLB_HAS_CODE;
                                }
                            }
                        },
                    }
                }
            }

            ctx.pages.retain(
                |_,
                 &mut PageInfo {
                     wasm_table_index: w,
                     ..
                 }| w != wasm_table_index,
            );

            for info in ctx.pages.values_mut() {
                info.hidden_wasm_table_indices
                    .retain(|&w| w != wasm_table_index)
            }

            free_wasm_table_index(ctx, wasm_table_index);
        }
    }

    match ctx.entry_points.remove(&page) {
        None => {},
        Some(_) => {
            profiler::stat_increment(stat::INVALIDATE_PAGE_HAD_ENTRY_POINTS);
            did_have_code = true;

            match &ctx.compiling {
                Some((index, CompilingPageState::Compiling { pages })) => {
                    if pages.contains_key(&page) {
                        ctx.compiling = Some((*index, CompilingPageState::CompilingWritten));
                    }
                },
                _ => {},
            }
        },
    }

    match &ctx.compiling {
        Some((_, CompilingPageState::Compiling { pages })) => {
            dbg_assert!(!pages.contains_key(&page));
        },
        _ => {},
    }

    check_jit_state_invariants(ctx);

    dbg_assert!(!jit_page_has_code_ctx(ctx, page));

    if did_have_code {
        cpu::tlb_set_has_code(page, false);
    }

    if !did_have_code {
        profiler::stat_increment(stat::DIRTY_PAGE_DID_NOT_HAVE_CODE);
    }
}

#[no_mangle]
pub fn jit_dirty_cache(start_addr: u32, end_addr: u32) {
    dbg_assert!(start_addr < end_addr);

    let start_page = Page::page_of(start_addr);
    let end_page = Page::page_of(end_addr - 1);

    for page in start_page.to_u32()..end_page.to_u32() + 1 {
        jit_dirty_page_ctx(&mut get_jit_state(), Page::page_of(page << 12));
    }
}

#[no_mangle]
pub fn jit_dirty_page(page: Page) { jit_dirty_page_ctx(&mut get_jit_state(), page) }

/// dirty pages in the range of start_addr and end_addr, which must span at most two pages
pub fn jit_dirty_cache_small(start_addr: u32, end_addr: u32) {
    dbg_assert!(start_addr < end_addr);

    let start_page = Page::page_of(start_addr);
    let end_page = Page::page_of(end_addr - 1);

    let mut ctx = get_jit_state();
    jit_dirty_page_ctx(&mut ctx, start_page);

    // Note: This can't happen when paging is enabled, as writes across
    //       boundaries are split up on two pages
    if start_page != end_page {
        dbg_assert!(start_page.to_u32() + 1 == end_page.to_u32());
        jit_dirty_page_ctx(&mut ctx, end_page);
    }
}

#[no_mangle]
pub fn jit_clear_cache_js() { jit_clear_cache(&mut get_jit_state()) }

fn jit_clear_cache(ctx: &mut JitState) {
    let mut pages_with_code = HashSet::new();

    for &p in ctx.entry_points.keys() {
        pages_with_code.insert(p);
    }
    for &p in ctx.pages.keys() {
        pages_with_code.insert(p);
    }

    for page in pages_with_code {
        jit_dirty_page_ctx(ctx, page);
    }
}

pub fn jit_page_has_code(page: Page) -> bool { jit_page_has_code_ctx(&mut get_jit_state(), page) }

fn jit_page_has_code_ctx(ctx: &mut JitState, page: Page) -> bool {
    ctx.pages.contains_key(&page) || ctx.entry_points.contains_key(&page)
}

#[no_mangle]
pub fn jit_get_wasm_table_index_free_list_count() -> u32 {
    if cfg!(feature = "profiler") {
        get_jit_state().wasm_table_index_free_list.len() as u32
    }
    else {
        0
    }
}
#[no_mangle]
pub fn jit_get_cache_size() -> u32 {
    if cfg!(feature = "profiler") {
        get_jit_state()
            .pages
            .values()
            .map(|p| p.entry_points.len() as u32)
            .sum()
    }
    else {
        0
    }
}

#[cfg(feature = "profiler")]
pub fn check_missed_entry_points(phys_address: u32, state_flags: CachedStateFlags) {
    let ctx = get_jit_state();

    if let Some(infos) = ctx.pages.get(&Page::page_of(phys_address)) {
        if infos.state_flags != state_flags {
            return;
        }

        #[allow(static_mut_refs)]
        let last_jump_type = unsafe { cpu::debug_last_jump.name() };
        #[allow(static_mut_refs)]
        let last_jump_addr = unsafe { cpu::debug_last_jump.phys_address() }.unwrap_or(0);
        let last_jump_opcode =
            if last_jump_addr != 0 { memory::read32s(last_jump_addr) } else { 0 };

        let opcode = memory::read32s(phys_address);
        dbg_log!(
            "Compiled exists, but no entry point, \
                 phys_addr={:x} opcode={:02x} {:02x} {:02x} {:02x}. \
                 Last jump at {:x} ({}) opcode={:02x} {:02x} {:02x} {:02x}",
            phys_address,
            opcode & 0xFF,
            opcode >> 8 & 0xFF,
            opcode >> 16 & 0xFF,
            opcode >> 16 & 0xFF,
            last_jump_addr,
            last_jump_type,
            last_jump_opcode & 0xFF,
            last_jump_opcode >> 8 & 0xFF,
            last_jump_opcode >> 16 & 0xFF,
            last_jump_opcode >> 16 & 0xFF,
        );
    }
}

#[no_mangle]
#[cfg(feature = "profiler")]
pub fn debug_set_dispatcher_target(_target_index: i32) {
    //dbg_log!("About to call dispatcher target_index={}", target_index);
}

#[no_mangle]
#[cfg(feature = "profiler")]
pub fn check_dispatcher_target(target_index: i32, max: i32) {
    //dbg_log!("Dispatcher called target={}", target_index);
    dbg_assert!(target_index >= 0);
    dbg_assert!(target_index < max);
}

#[no_mangle]
#[cfg(feature = "profiler")]
pub fn enter_basic_block(phys_eip: u32) {
    let eip =
        unsafe { cpu::translate_address_read(*global_pointers::instruction_pointer).unwrap() };
    if Page::page_of(eip) != Page::page_of(phys_eip) {
        dbg_log!(
            "enter basic block failed block=0x{:x} actual eip=0x{:x}",
            phys_eip,
            eip
        );
        panic!();
    }
}

#[no_mangle]
pub unsafe fn set_jit_config(index: u32, value: u32) {
    match index {
        0 => JIT_DISABLED = value != 0,
        1 => MAX_PAGES = value,
        2 => JIT_USE_LOOP_SAFETY = value != 0,
        3 => MAX_EXTRA_BASIC_BLOCKS = value,
        _ => dbg_assert!(false),
    }
}

#[no_mangle]
pub unsafe fn get_jit_config(index: u32) -> u32 {
    match index {
        0 => JIT_DISABLED as u32,
        1 => MAX_PAGES as u32,
        2 => JIT_USE_LOOP_SAFETY as u32,
        3 => MAX_EXTRA_BASIC_BLOCKS as u32,
        _ => 0,
    }
}
