use std::collections::{BTreeMap, HashMap, HashSet};
use std::iter::FromIterator;
use std::mem;
use std::ptr::NonNull;

use analysis::AnalysisType;
use codegen;
use cpu::cpu;
use cpu::global_pointers;
use cpu::memory;
use cpu_context::CpuContext;
use jit_instructions;
use page::Page;
use profiler;
use profiler::stat;
use state_flags::CachedStateFlags;
use util::SafeToU16;
use wasmgen::wasm_builder::{WasmBuilder, WasmLocal};

type WasmTableIndex = u16;

mod unsafe_jit {
    use jit::CachedStateFlags;

    extern "C" {
        pub fn codegen_finalize(
            wasm_table_index: u16,
            phys_addr: u32,
            state_flags: CachedStateFlags,
            ptr: u32,
            len: u32,
        );
        pub fn jit_clear_func(wasm_table_index: u16);
    }
}

fn codegen_finalize(
    wasm_table_index: u16,
    phys_addr: u32,
    state_flags: CachedStateFlags,
    ptr: u32,
    len: u32,
) {
    unsafe { unsafe_jit::codegen_finalize(wasm_table_index, phys_addr, state_flags, ptr, len) }
}

pub fn jit_clear_func(wasm_table_index: u16) {
    unsafe { unsafe_jit::jit_clear_func(wasm_table_index) }
}

pub const WASM_TABLE_SIZE: u32 = 900;

pub const HASH_PRIME: u32 = 6151;

pub const CHECK_JIT_STATE_INVARIANTS: bool = false;

pub const JIT_MAX_ITERATIONS_PER_FUNCTION: u32 = 20011;

pub const JIT_ALWAYS_USE_LOOP_SAFETY: bool = true;

pub const JIT_THRESHOLD: u32 = 200 * 1000;

const MAX_INSTRUCTION_LENGTH: u32 = 16;

#[allow(non_upper_case_globals)]
static mut jit_state: NonNull<JitState> =
    unsafe { NonNull::new_unchecked(mem::align_of::<JitState>() as *mut _) };

pub fn get_jit_state() -> &'static mut JitState { unsafe { jit_state.as_mut() } }

#[no_mangle]
pub fn rust_init() {
    let x = Box::new(JitState::create_and_initialise());
    unsafe {
        jit_state = NonNull::new(Box::into_raw(x)).unwrap()
    }

    use std::panic;

    panic::set_hook(Box::new(|panic_info| {
        console_log!("{}", panic_info.to_string());
    }));
}

pub struct Entry {
    #[cfg(any(debug_assertions, feature = "profiler"))]
    pub len: u32,

    #[cfg(debug_assertions)]
    pub opcode: u32,

    pub initial_state: u16,
    pub wasm_table_index: u16,
    pub state_flags: CachedStateFlags,
}

enum PageState {
    Compiling { basic_blocks: Vec<BasicBlock> },
    CompilingWritten,
}

pub struct JitState {
    wasm_builder: WasmBuilder,

    // as an alternative to HashSet, we could use a bitmap of 4096 bits here
    // (faster, but uses much more memory)
    // or a compressed bitmap (likely faster)
    // or HashSet<u32> rather than nested
    entry_points: HashMap<Page, HashSet<u16>>,
    hot_pages: [u32; HASH_PRIME as usize],

    wasm_table_index_free_list: Vec<WasmTableIndex>,
    used_wasm_table_indices: HashMap<WasmTableIndex, HashSet<Page>>,
    // All pages from used_wasm_table_indices
    // Used to improve the performance of jit_dirty_page and jit_page_has_code
    all_pages: HashSet<Page>,
    cache: HashMap<u32, Entry>,
    compiling: Option<(WasmTableIndex, PageState)>,
}

pub fn check_jit_state_invariants(ctx: &mut JitState) {
    if !CHECK_JIT_STATE_INVARIANTS {
        return;
    }
    let mut all_pages = HashSet::new();
    for pages in ctx.used_wasm_table_indices.values() {
        all_pages.extend(pages);
    }
    dbg_assert!(ctx.all_pages == all_pages);
}

impl JitState {
    pub fn create_and_initialise() -> JitState {
        // don't assign 0 (XXX: Check)
        let wasm_table_indices = 1..=(WASM_TABLE_SIZE - 1) as u16;

        JitState {
            wasm_builder: WasmBuilder::new(),

            entry_points: HashMap::new(),
            hot_pages: [0; HASH_PRIME as usize],

            wasm_table_index_free_list: Vec::from_iter(wasm_table_indices),
            used_wasm_table_indices: HashMap::new(),
            all_pages: HashSet::new(),
            cache: HashMap::new(),
            compiling: None,
        }
    }
}

#[derive(PartialEq, Eq)]
enum BasicBlockType {
    Normal {
        next_block_addr: u32,
    },
    ConditionalJump {
        next_block_addr: Option<u32>,
        next_block_branch_taken_addr: Option<u32>,
        condition: u8,
        jump_offset: i32,
        jump_offset_is_32: bool,
    },
    Exit,
}

struct BasicBlock {
    addr: u32,
    virt_addr: i32,
    last_instruction_addr: u32,
    end_addr: u32,
    is_entry_block: bool,
    ty: BasicBlockType,
    has_sti: bool,
    number_of_instructions: u32,
}

#[derive(Copy, Clone, PartialEq)]
pub struct CachedCode {
    pub wasm_table_index: u16,
    pub initial_state: u16,
}

impl CachedCode {
    pub const NONE: CachedCode = CachedCode {
        wasm_table_index: 0,
        initial_state: 0,
    };
}

pub struct JitContext<'a> {
    pub cpu: &'a mut CpuContext,
    pub builder: &'a mut WasmBuilder,
    pub register_locals: &'a mut Vec<WasmLocal>,
    pub start_of_current_instruction: u32,
    pub current_brtable_depth: u32,
    pub our_wasm_table_index: u16,
    pub basic_block_index_local: &'a WasmLocal,
    pub state_flags: CachedStateFlags,
}

pub const JIT_INSTR_BLOCK_BOUNDARY_FLAG: u32 = 1 << 0;

fn jit_hot_hash_page(page: Page) -> u32 { page.to_u32() % HASH_PRIME }

pub fn is_near_end_of_page(address: u32) -> bool {
    address & 0xFFF >= 0x1000 - MAX_INSTRUCTION_LENGTH
}

pub fn jit_find_cache_entry(phys_address: u32, state_flags: CachedStateFlags) -> CachedCode {
    if is_near_end_of_page(phys_address) {
        profiler::stat_increment(stat::RUN_INTERPRETED_NEAR_END_OF_PAGE);
    }

    let ctx = get_jit_state();

    match ctx.cache.get(&phys_address) {
        Some(entry) => {
            if entry.state_flags == state_flags {
                return CachedCode {
                    wasm_table_index: entry.wasm_table_index,
                    initial_state: entry.initial_state,
                };
            }
            else {
                profiler::stat_increment(stat::RUN_INTERPRETED_DIFFERENT_STATE);
            }
        },
        None => {},
    }

    return CachedCode::NONE;
}

#[no_mangle]
pub fn jit_find_cache_entry_in_page(
    phys_address: u32,
    wasm_table_index: u16,
    state_flags: u32,
) -> i32 {
    let state_flags = CachedStateFlags::of_u32(state_flags);
    let ctx = get_jit_state();

    match ctx.cache.get(&phys_address) {
        Some(entry) => {
            if entry.state_flags == state_flags && entry.wasm_table_index == wasm_table_index {
                return entry.initial_state as i32;
            }
        },
        None => {},
    }

    return -1;
}

pub fn record_entry_point(phys_address: u32) {
    let ctx = get_jit_state();
    if is_near_end_of_page(phys_address) {
        return;
    }
    let page = Page::page_of(phys_address);
    let offset_in_page = phys_address as u16 & 0xFFF;
    let mut is_new = false;
    ctx.entry_points
        .entry(page)
        .or_insert_with(|| {
            is_new = true;
            HashSet::new()
        })
        .insert(offset_in_page);

    if is_new {
        cpu::tlb_set_has_code(page, true);
    }
}

// Maximum number of pages per wasm module. Necessary for the following reasons:
// - There is an upper limit on the size of a single function in wasm (currently ~7MB in all browsers)
//   See https://github.com/WebAssembly/design/issues/1138
// - v8 poorly handles large br_table elements and OOMs on modules much smaller than the above limit
//   See https://bugs.chromium.org/p/v8/issues/detail?id=9697 and https://bugs.chromium.org/p/v8/issues/detail?id=9141
//   Will hopefully be fixed in the near future by generating direct control flow
const MAX_PAGES: usize = 5;

fn jit_find_basic_blocks(
    ctx: &mut JitState,
    entry_points: HashSet<i32>,
    cpu: CpuContext,
) -> Vec<BasicBlock> {
    let mut to_visit_stack: Vec<i32> = entry_points.iter().map(|e| *e).collect();
    let mut marked_as_entry: HashSet<i32> = entry_points.clone();

    let mut basic_blocks: BTreeMap<u32, BasicBlock> = BTreeMap::new();
    let mut pages: HashSet<Page> = HashSet::new();

    // 16-bit doesn't not work correctly, most likely due to instruction pointer wrap-around
    let max_pages = if cpu.state_flags.is_32() { MAX_PAGES } else { 1 };

    while let Some(to_visit) = to_visit_stack.pop() {
        let phys_addr = match cpu::translate_address_read_no_side_effects(to_visit) {
            None => {
                dbg_log!("Not analysing {:x} (page not mapped)", to_visit);
                continue;
            },
            Some(phys_addr) => phys_addr,
        };

        if basic_blocks.contains_key(&phys_addr) {
            continue;
        }

        pages.insert(Page::page_of(phys_addr));
        dbg_assert!(pages.len() <= max_pages);

        let may_include_page = |page| pages.contains(&page) || pages.len() < max_pages;

        if let Some(entry_points) = ctx.entry_points.remove(&Page::page_of(phys_addr)) {
            let address_hash = jit_hot_hash_page(Page::page_of(phys_addr)) as usize;
            ctx.hot_pages[address_hash] = 0;

            for addr_low in entry_points {
                let addr = to_visit & !0xFFF | addr_low as i32;
                to_visit_stack.push(addr);
                marked_as_entry.insert(addr);
            }
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
            let mut ctx = &mut CpuContext {
                eip: current_address,
                ..cpu
            };
            let analysis = ::analysis::analyze_step(&mut ctx);
            current_block.number_of_instructions += 1;
            let has_next_instruction = !analysis.no_next_instruction;
            current_address = ctx.eip;

            dbg_assert!(Page::page_of(current_address) == Page::page_of(addr_before_instruction));
            let current_virt_addr = to_visit & !0xFFF | current_address as i32 & 0xFFF;

            match analysis.ty {
                AnalysisType::Normal | AnalysisType::STI => {
                    dbg_assert!(has_next_instruction);

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
                                next_block_addr: current_address,
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
                    // conditional jump: continue at next and continue at jump target

                    let jump_target = if is_32 {
                        current_virt_addr + offset
                    }
                    else {
                        ctx.cs_offset as i32
                            + (current_virt_addr - ctx.cs_offset as i32 + offset & 0xFFFF)
                    };

                    dbg_assert!(has_next_instruction);
                    to_visit_stack.push(current_virt_addr);

                    let next_block_branch_taken_addr;

                    if let Some(phys_jump_target) =
                        cpu::translate_address_read_no_side_effects(jump_target as i32)
                    {
                        if !is_near_end_of_page(jump_target as u32)
                            && may_include_page(Page::page_of(phys_jump_target))
                        {
                            pages.insert(Page::page_of(phys_jump_target));
                            to_visit_stack.push(jump_target);
                            next_block_branch_taken_addr = Some(phys_jump_target);
                        }
                        else {
                            next_block_branch_taken_addr = None;
                        }
                    }
                    else {
                        next_block_branch_taken_addr = None;
                    }

                    let next_block_addr = if is_near_end_of_page(current_address) {
                        None
                    }
                    else {
                        Some(current_address)
                    };

                    current_block.ty = BasicBlockType::ConditionalJump {
                        next_block_addr,
                        next_block_branch_taken_addr,
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
                    // non-conditional jump: continue at jump target

                    let jump_target = if is_32 {
                        current_virt_addr + offset
                    }
                    else {
                        ctx.cs_offset as i32
                            + (current_virt_addr - ctx.cs_offset as i32 + offset & 0xFFFF)
                    };

                    if has_next_instruction {
                        // Execution will eventually come back to the next instruction (CALL)
                        marked_as_entry.insert(current_virt_addr);
                        to_visit_stack.push(current_virt_addr);
                    }

                    if let Some(phys_jump_target) =
                        cpu::translate_address_read_no_side_effects(jump_target as i32)
                    {
                        if !is_near_end_of_page(jump_target as u32)
                            && may_include_page(Page::page_of(phys_jump_target))
                        {
                            pages.insert(Page::page_of(phys_jump_target));
                            to_visit_stack.push(jump_target);
                            current_block.ty = BasicBlockType::Normal {
                                next_block_addr: phys_jump_target,
                            };
                        }
                        else {
                            current_block.ty = BasicBlockType::Exit;
                        }
                    }
                    else {
                        current_block.ty = BasicBlockType::Exit;
                    }

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
            .filter(|(_, previous_block)| (!previous_block.has_sti))
            .map(|(_, previous_block)| previous_block.clone());

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

    dbg_assert!(pages.len() <= max_pages);

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
    let ctx = get_jit_state();
    let phys_addr = cpu::translate_address_read(virt_addr).unwrap();
    record_entry_point(phys_addr);
    let cs_offset = cpu::get_seg_cs() as u32;
    let state_flags = cpu::pack_current_state_flags();
    jit_analyze_and_generate(ctx, virt_addr, phys_addr, cs_offset, state_flags);
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

    if ctx.compiling.is_some() {
        return;
    }

    let entry_points = ctx.entry_points.remove(&page);

    if let Some(entry_points) = entry_points {
        dbg_log!("Compile code for page at {:x}", page.to_address());
        profiler::stat_increment(stat::COMPILE);

        let cpu = CpuContext {
            eip: 0,
            prefixes: 0,
            cs_offset,
            state_flags,
        };

        dbg_assert!(
            cpu::translate_address_read_no_side_effects(virt_entry_point).unwrap()
                == phys_entry_point
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

        if ctx.wasm_table_index_free_list.is_empty() {
            dbg_log!("wasm_table_index_free_list empty, clearing cache",);

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
        dbg_assert!(wasm_table_index != 0);

        dbg_assert!(!pages.is_empty());
        dbg_assert!(pages.len() <= MAX_PAGES);
        ctx.used_wasm_table_indices
            .insert(wasm_table_index, pages.clone());
        ctx.all_pages.extend(pages.clone());

        jit_generate_module(
            &basic_blocks,
            cpu.clone(),
            &mut ctx.wasm_builder,
            wasm_table_index,
            state_flags,
        );

        profiler::stat_increment_by(
            stat::COMPILE_WASM_TOTAL_BYTES,
            ctx.wasm_builder.get_output_len() as u64,
        );
        profiler::stat_increment_by(stat::COMPILE_PAGE, pages.len() as u64);

        for &p in &pages {
            cpu::tlb_set_has_code(p, true);
        }

        dbg_assert!(ctx.compiling.is_none());
        ctx.compiling = Some((wasm_table_index, PageState::Compiling { basic_blocks }));

        let phys_addr = page.to_address();

        // will call codegen_finalize_finished asynchronously when finished
        codegen_finalize(
            wasm_table_index,
            phys_addr,
            state_flags,
            ctx.wasm_builder.get_output_ptr() as u32,
            ctx.wasm_builder.get_output_len(),
        );

        profiler::stat_increment(stat::COMPILE_SUCCESS);
    }
    else {
        //dbg_log!("No basic blocks, not generating code");
        // Nothing to do
    }

    check_jit_state_invariants(ctx);
}

#[no_mangle]
pub fn codegen_finalize_finished(
    wasm_table_index: u16,
    phys_addr: u32,
    state_flags: CachedStateFlags,
) {
    let ctx = get_jit_state();

    dbg_assert!(wasm_table_index != 0);

    dbg_log!(
        "Finished compiling for page at {:x}",
        Page::page_of(phys_addr).to_address()
    );

    let basic_blocks = match mem::replace(&mut ctx.compiling, None) {
        None => {
            dbg_assert!(false);
            return;
        },
        Some((in_progress_wasm_table_index, PageState::CompilingWritten)) => {
            dbg_assert!(wasm_table_index == in_progress_wasm_table_index);

            profiler::stat_increment(stat::INVALIDATE_MODULE_WRITTEN_WHILE_COMPILED);
            free_wasm_table_index(ctx, wasm_table_index);
            return;
        },
        Some((in_progress_wasm_table_index, PageState::Compiling { basic_blocks })) => {
            dbg_assert!(wasm_table_index == in_progress_wasm_table_index);
            basic_blocks
        },
    };

    // create entries for each basic block that is marked as an entry point
    let mut entry_point_count = 0;

    let mut check_for_unused_wasm_table_index = HashSet::new();

    for (i, block) in basic_blocks.iter().enumerate() {
        profiler::stat_increment(stat::COMPILE_BASIC_BLOCK);

        dbg_assert!(block.addr < block.end_addr);
        if block.is_entry_block {
            let initial_state = i.safe_to_u16();

            let entry = Entry {
                wasm_table_index,
                initial_state,
                state_flags,

                #[cfg(any(debug_assertions, feature = "profiler"))]
                len: block.end_addr - block.addr,

                #[cfg(debug_assertions)]
                opcode: memory::read32s(block.addr) as u32,
            };

            let maybe_old_entry = ctx.cache.insert(block.addr, entry);

            if let Some(old_entry) = maybe_old_entry {
                check_for_unused_wasm_table_index.insert(old_entry.wasm_table_index);

                if old_entry.state_flags == state_flags {
                    // TODO: stat
                }
                else {
                    // TODO: stat
                }
            }

            entry_point_count += 1;
            profiler::stat_increment(stat::COMPILE_ENTRY_POINT);
        }
    }

    dbg_assert!(entry_point_count > 0);

    for index in check_for_unused_wasm_table_index {
        let pages = ctx.used_wasm_table_indices.get(&index).unwrap();

        let mut is_used = false;
        'outer: for p in pages {
            for addr in p.address_range() {
                if let Some(entry) = ctx.cache.get(&addr) {
                    if entry.wasm_table_index == index {
                        is_used = true;
                        break 'outer;
                    }
                }
            }
        }

        if !is_used {
            profiler::stat_increment(stat::INVALIDATE_MODULE_UNUSED_AFTER_OVERWRITE);
            free_wasm_table_index(ctx, index);
        }

        if !is_used {
            for (_, entry) in &ctx.cache {
                dbg_assert!(entry.wasm_table_index != index);
            }
        }
        else {
            let mut ok = false;
            for (_, entry) in &ctx.cache {
                if entry.wasm_table_index == index {
                    ok = true;
                    break;
                }
            }
            dbg_assert!(ok);
        }
    }

    check_jit_state_invariants(ctx);
}

fn jit_generate_module(
    basic_blocks: &Vec<BasicBlock>,
    mut cpu: CpuContext,
    builder: &mut WasmBuilder,
    wasm_table_index: u16,
    state_flags: CachedStateFlags,
) {
    builder.reset();

    let basic_block_indices: HashMap<u32, u32> = basic_blocks
        .iter()
        .enumerate()
        .map(|(index, block)| (block.addr, index as u32))
        .collect();

    // set state local variable to the initial state passed as the first argument
    builder.get_local(&builder.arg_local_initial_state.unsafe_clone());
    let gen_local_state = builder.set_new_local();

    // initialise max_iterations
    let gen_local_iteration_counter = if JIT_ALWAYS_USE_LOOP_SAFETY {
        builder.const_i32(JIT_MAX_ITERATIONS_PER_FUNCTION as i32);
        Some(builder.set_new_local())
    }
    else {
        None
    };

    let mut register_locals = (0..8)
        .map(|i| {
            builder.load_fixed_i32(global_pointers::get_reg32_offset(i));
            builder.set_new_local()
        })
        .collect();

    let ctx = &mut JitContext {
        cpu: &mut cpu,
        builder,
        register_locals: &mut register_locals,
        start_of_current_instruction: 0,
        current_brtable_depth: 0,
        our_wasm_table_index: wasm_table_index,
        basic_block_index_local: &gen_local_state,
        state_flags,
    };

    // main state machine loop
    ctx.builder.loop_void();

    if let Some(gen_local_iteration_counter) = gen_local_iteration_counter.as_ref() {
        profiler::stat_increment(stat::COMPILE_WITH_LOOP_SAFETY);

        // decrement max_iterations
        ctx.builder.get_local(gen_local_iteration_counter);
        ctx.builder.const_i32(-1);
        ctx.builder.add_i32();
        ctx.builder.set_local(gen_local_iteration_counter);

        // if max_iterations == 0: return
        ctx.builder.get_local(gen_local_iteration_counter);
        ctx.builder.eqz_i32();
        ctx.builder.if_void();
        codegen::gen_debug_track_jit_exit(ctx.builder, 0);
        codegen::gen_move_registers_from_locals_to_memory(ctx);
        ctx.builder.return_();
        ctx.builder.block_end();
    }

    ctx.builder.block_void(); // for the default case

    ctx.builder.block_void(); // for the exit-with-pagefault case

    // generate the opening blocks for the cases

    for _ in 0..basic_blocks.len() {
        ctx.builder.block_void();
    }

    ctx.builder.get_local(&gen_local_state);
    ctx.builder.brtable_and_cases(basic_blocks.len() as u32 + 1); // plus one for the exit-with-pagefault case

    for (i, block) in basic_blocks.iter().enumerate() {
        // Case [i] will jump after the [i]th block, so we first generate the
        // block end opcode and then the code for that block
        ctx.builder.block_end();

        ctx.current_brtable_depth = basic_blocks.len() as u32 + 1 - i as u32;

        dbg_assert!(block.addr < block.end_addr);

        jit_generate_basic_block(ctx, block);

        let invalid_connection_to_next_block = block.end_addr != ctx.cpu.eip;
        dbg_assert!(!invalid_connection_to_next_block);

        if block.has_sti {
            match block.ty {
                BasicBlockType::ConditionalJump {
                    condition,
                    jump_offset,
                    jump_offset_is_32,
                    ..
                } => {
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
                BasicBlockType::Normal { .. } => {},
                BasicBlockType::Exit => {},
            };
            codegen::gen_debug_track_jit_exit(ctx.builder, block.last_instruction_addr);
            codegen::gen_move_registers_from_locals_to_memory(ctx);
            codegen::gen_fn0_const(ctx.builder, "handle_irqs");
            ctx.builder.return_();
            continue;
        }

        match &block.ty {
            BasicBlockType::Exit => {
                // Exit this function
                codegen::gen_debug_track_jit_exit(ctx.builder, block.last_instruction_addr);
                codegen::gen_move_registers_from_locals_to_memory(ctx);
                ctx.builder.return_();
            },
            BasicBlockType::Normal { next_block_addr } => {
                // Unconditional jump to next basic block
                // - All instructions that don't change eip
                // - Unconditional jump

                if Page::page_of(*next_block_addr) != Page::page_of(block.addr) {
                    codegen::gen_page_switch_check(
                        ctx,
                        *next_block_addr,
                        block.last_instruction_addr,
                    );

                    #[cfg(debug_assertions)]
                    codegen::gen_fn2_const(
                        ctx.builder,
                        "check_page_switch",
                        block.addr,
                        *next_block_addr,
                    );
                }

                let next_basic_block_index = *basic_block_indices
                    .get(&next_block_addr)
                    .expect("basic_block_indices.get (Normal)");

                if next_basic_block_index == (i as u32) + 1 {
                    // fallthru
                }
                else {
                    // set state variable to next basic block
                    ctx.builder.const_i32(next_basic_block_index as i32);
                    ctx.builder.set_local(&gen_local_state);

                    ctx.builder.br(ctx.current_brtable_depth); // to the loop
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

                codegen::gen_condition_fn(ctx, condition);
                ctx.builder.if_void();

                // Branch taken

                if jump_offset_is_32 {
                    codegen::gen_relative_jump(ctx.builder, jump_offset);
                }
                else {
                    codegen::gen_jmp_rel16(ctx.builder, jump_offset as u16);
                }

                if let Some(next_block_branch_taken_addr) = next_block_branch_taken_addr {
                    let next_basic_block_branch_taken_index = *basic_block_indices
                        .get(&next_block_branch_taken_addr)
                        .expect("basic_block_indices.get (branch taken)");

                    dbg_assert!(
                        (block.end_addr + jump_offset as u32) & 0xFFF
                            == next_block_branch_taken_addr & 0xFFF
                    );

                    if Page::page_of(next_block_branch_taken_addr) != Page::page_of(block.addr) {
                        ctx.current_brtable_depth += 1;
                        codegen::gen_page_switch_check(
                            ctx,
                            next_block_branch_taken_addr,
                            block.last_instruction_addr,
                        );
                        ctx.current_brtable_depth -= 1;

                        #[cfg(debug_assertions)]
                        codegen::gen_fn2_const(
                            ctx.builder,
                            "check_page_switch",
                            block.addr,
                            next_block_branch_taken_addr,
                        );
                    }

                    ctx.builder
                        .const_i32(next_basic_block_branch_taken_index as i32);
                    ctx.builder.set_local(&gen_local_state);

                    ctx.builder.br(basic_blocks.len() as u32 + 2 - i as u32); // to the loop
                }
                else {
                    // Jump to different page
                    codegen::gen_debug_track_jit_exit(ctx.builder, block.last_instruction_addr);
                    codegen::gen_move_registers_from_locals_to_memory(ctx);
                    ctx.builder.return_();
                }

                if let Some(next_block_addr) = next_block_addr {
                    dbg_assert!(Page::page_of(next_block_addr) == Page::page_of(block.addr));
                    // Branch not taken

                    let next_basic_block_index = *basic_block_indices
                        .get(&next_block_addr)
                        .expect("basic_block_indices.get (branch not taken)");

                    if next_basic_block_index == (i as u32) + 1 {
                        // fallthru
                        ctx.builder.block_end();
                    }
                    else {
                        ctx.builder.else_();

                        ctx.builder.const_i32(next_basic_block_index as i32);
                        ctx.builder.set_local(&gen_local_state);

                        ctx.builder.br(basic_blocks.len() as u32 + 2 - i as u32); // to the loop

                        ctx.builder.block_end();
                    }
                }
                else {
                    ctx.builder.else_();

                    // End of this page
                    codegen::gen_debug_track_jit_exit(ctx.builder, block.last_instruction_addr);
                    codegen::gen_move_registers_from_locals_to_memory(ctx);
                    ctx.builder.return_();

                    ctx.builder.block_end();
                }
            },
        }
    }

    {
        // exit-with-pagefault case
        ctx.builder.block_end();
        codegen::gen_move_registers_from_locals_to_memory(ctx);
        codegen::gen_fn0_const(ctx.builder, "trigger_pagefault_end_jit");
        ctx.builder.return_();
    }

    ctx.builder.block_end(); // default case
    ctx.builder.unreachable();

    ctx.builder.block_end(); // loop

    ctx.builder.free_local(gen_local_state.unsafe_clone());
    if let Some(local) = gen_local_iteration_counter {
        ctx.builder.free_local(local);
    }

    for local in ctx.register_locals.drain(..) {
        ctx.builder.free_local(local);
    }

    ctx.builder.finish();
}

fn jit_generate_basic_block(ctx: &mut JitContext, block: &BasicBlock) {
    let start_addr = block.addr;
    let last_instruction_addr = block.last_instruction_addr;
    let stop_addr = block.end_addr;

    // First iteration of do-while assumes the caller confirms this condition
    dbg_assert!(!is_near_end_of_page(start_addr));

    codegen::gen_increment_timestamp_counter(ctx.builder, block.number_of_instructions as i32);
    ctx.cpu.eip = start_addr;

    loop {
        let mut instruction = 0;
        if cfg!(feature = "profiler") {
            instruction = memory::read32s(ctx.cpu.eip) as u32;
            ::opstats::gen_opstats(ctx.builder, instruction);
            ::opstats::record_opstat_compiled(instruction);
        }

        if ctx.cpu.eip == last_instruction_addr {
            // Before the last instruction:
            // - Set eip to *after* the instruction
            // - Set previous_eip to *before* the instruction
            codegen::gen_set_previous_eip_offset_from_eip(
                ctx.builder,
                last_instruction_addr - start_addr,
            );
            codegen::gen_increment_instruction_pointer(ctx.builder, stop_addr - start_addr);
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
        ::opstats::record_opstat_size_wasm(instruction, wasm_length as u32);

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
    }
}

#[no_mangle]
pub fn jit_increase_hotness_and_maybe_compile(
    virt_address: i32,
    phys_address: u32,
    cs_offset: u32,
    state_flags: CachedStateFlags,
    hotness: u32,
) {
    let ctx = get_jit_state();
    let page = Page::page_of(phys_address);
    let address_hash = jit_hot_hash_page(page) as usize;
    ctx.hot_pages[address_hash] += hotness;
    if ctx.hot_pages[address_hash] >= JIT_THRESHOLD {
        if ctx.compiling.is_some() {
            return;
        }
        // only try generating if we're in the correct address space
        if cpu::translate_address_read_no_side_effects(virt_address) == Some(phys_address) {
            ctx.hot_pages[address_hash] = 0;
            jit_analyze_and_generate(ctx, virt_address, phys_address, cs_offset, state_flags)
        }
        else {
            profiler::stat_increment(stat::COMPILE_WRONG_ADDRESS_SPACE);
        }
    };
}

fn free_wasm_table_index(ctx: &mut JitState, wasm_table_index: u16) {
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
    }

    match ctx.used_wasm_table_indices.remove(&wasm_table_index) {
        None => dbg_assert!(false),
        Some(_pages) => {
            //dbg_assert!(!pages.is_empty()); // only if CompilingWritten
        },
    }
    ctx.wasm_table_index_free_list.push(wasm_table_index);

    dbg_assert!(
        ctx.wasm_table_index_free_list.len() + ctx.used_wasm_table_indices.len()
            == WASM_TABLE_SIZE as usize - 1
    );

    // It is not strictly necessary to clear the function, but it will fail more predictably if we
    // accidentally use the function and may garbage collect unused modules earlier
    jit_clear_func(wasm_table_index);

    rebuild_all_pages(ctx);

    check_jit_state_invariants(ctx);
}

pub fn rebuild_all_pages(ctx: &mut JitState) {
    // rebuild ctx.all_pages
    let mut all_pages = HashSet::new();
    for pages in ctx.used_wasm_table_indices.values() {
        all_pages.extend(pages);
    }
    ctx.all_pages = all_pages;
}

/// Register a write in this page: Delete all present code
pub fn jit_dirty_page(ctx: &mut JitState, page: Page) {
    let mut did_have_code = false;

    if ctx.all_pages.contains(&page) {
        profiler::stat_increment(stat::INVALIDATE_PAGE_HAD_CODE);
        did_have_code = true;
        let mut index_to_free = HashSet::new();

        let compiling = match &ctx.compiling {
            Some((wasm_table_index, _)) => Some(*wasm_table_index),
            None => None,
        };

        for (&wasm_table_index, pages) in &ctx.used_wasm_table_indices {
            if Some(wasm_table_index) != compiling && pages.contains(&page) {
                index_to_free.insert(wasm_table_index);
            }
        }

        match &ctx.compiling {
            None => {},
            Some((_, PageState::CompilingWritten)) => {},
            Some((wasm_table_index, PageState::Compiling { .. })) => {
                let pages = ctx
                    .used_wasm_table_indices
                    .get_mut(wasm_table_index)
                    .unwrap();
                if pages.contains(&page) {
                    pages.clear();
                    ctx.compiling = Some((*wasm_table_index, PageState::CompilingWritten));
                    rebuild_all_pages(ctx);
                }
            },
        }

        for index in &index_to_free {
            match ctx.used_wasm_table_indices.get(&index) {
                None => dbg_assert!(false),
                Some(pages) => {
                    for &p in pages {
                        for addr in p.address_range() {
                            if let Some(e) = ctx.cache.get(&addr) {
                                if index_to_free.contains(&e.wasm_table_index) {
                                    ctx.cache.remove(&addr);
                                }
                            }
                        }
                    }
                },
            }
        }

        for index in index_to_free {
            profiler::stat_increment(stat::INVALIDATE_MODULE_DIRTY_PAGE);
            free_wasm_table_index(ctx, index)
        }
    }

    match ctx.entry_points.remove(&page) {
        None => {},
        Some(_entry_points) => {
            profiler::stat_increment(stat::INVALIDATE_PAGE_HAD_ENTRY_POINTS);
            did_have_code = true;

            // don't try to compile code in this page anymore until it's hot again
            ctx.hot_pages[jit_hot_hash_page(page) as usize] = 0;
        },
    }

    for pages in ctx.used_wasm_table_indices.values() {
        dbg_assert!(!pages.contains(&page));
    }

    check_jit_state_invariants(ctx);

    dbg_assert!(!ctx.all_pages.contains(&page));
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
        jit_dirty_page(get_jit_state(), Page::page_of(page << 12));
    }
}

/// dirty pages in the range of start_addr and end_addr, which must span at most two pages
pub fn jit_dirty_cache_small(start_addr: u32, end_addr: u32) {
    dbg_assert!(start_addr < end_addr);

    let start_page = Page::page_of(start_addr);
    let end_page = Page::page_of(end_addr - 1);

    let ctx = get_jit_state();
    jit_dirty_page(ctx, start_page);

    // Note: This can't happen when paging is enabled, as writes across
    //       boundaries are split up on two pages
    if start_page != end_page {
        dbg_assert!(start_page.to_u32() + 1 == end_page.to_u32());
        jit_dirty_page(ctx, end_page);
    }
}

#[no_mangle]
pub fn jit_clear_cache_js() { jit_clear_cache(get_jit_state()) }

pub fn jit_clear_cache(ctx: &mut JitState) {
    let mut pages_with_code = HashSet::new();

    for page in ctx.entry_points.keys() {
        pages_with_code.insert(*page);
    }
    for &p in &ctx.all_pages {
        pages_with_code.insert(p);
    }
    for addr in ctx.cache.keys() {
        dbg_assert!(pages_with_code.contains(&Page::page_of(*addr)));
    }
    for pages in ctx.used_wasm_table_indices.values() {
        dbg_assert!(pages_with_code.is_superset(pages));
    }

    for page in pages_with_code {
        jit_dirty_page(ctx, page);
    }
}

pub fn jit_page_has_code(page: Page) -> bool { jit_page_has_code_ctx(get_jit_state(), page) }

pub fn jit_page_has_code_ctx(ctx: &mut JitState, page: Page) -> bool {
    ctx.all_pages.contains(&page) || ctx.entry_points.contains_key(&page)
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

#[cfg(feature = "profiler")]
pub fn check_missed_entry_points(phys_address: u32, state_flags: CachedStateFlags) {
    let ctx = get_jit_state();

    // backwards until beginning of page
    for offset in 0..=(phys_address & 0xFFF) {
        let addr = phys_address - offset;
        dbg_assert!(phys_address >= addr);

        if let Some(entry) = ctx.cache.get(&addr) {
            if entry.state_flags != state_flags || phys_address >= addr + entry.len {
                // give up search on first entry that is not a match
                break;
            }

            profiler::stat_increment(stat::RUN_INTERPRETED_MISSED_COMPILED_ENTRY_LOOKUP);

            let last_jump_type = unsafe { cpu::debug_last_jump.name() };
            let last_jump_addr = unsafe { cpu::debug_last_jump.phys_address() }.unwrap_or(0);
            let last_jump_opcode =
                if last_jump_addr != 0 { memory::read32s(last_jump_addr) } else { 0 };

            let opcode = memory::read32s(phys_address);
            dbg_log!(
                "Compiled exists, but no entry point, \
                 start={:x} end={:x} phys_addr={:x} opcode={:02x} {:02x} {:02x} {:02x}. \
                 Last jump at {:x} ({}) opcode={:02x} {:02x} {:02x} {:02x}",
                addr,
                addr + entry.len,
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
}
