use std::collections::{BTreeMap, HashMap, HashSet};
use std::iter::FromIterator;
use std::mem;
use std::ptr::NonNull;

use analysis::AnalysisType;
use codegen;
use cpu;
use cpu_context::CpuContext;
use global_pointers;
use jit_instructions;
use page::Page;
use profiler;
use profiler::stat;
use state_flags::CachedStateFlags;
use util::SafeToU16;
use wasmgen::wasm_builder::{WasmBuilder, WasmLocal};

pub const WASM_TABLE_SIZE: u32 = 900;

pub const HASH_PRIME: u32 = 6151;

pub const CHECK_JIT_CACHE_ARRAY_INVARIANTS: bool = false;

pub const JIT_MAX_ITERATIONS_PER_FUNCTION: u32 = 10000;

pub const JIT_ALWAYS_USE_LOOP_SAFETY: bool = true;

pub const JIT_THRESHOLD: u32 = 200 * 1000;

const CODE_CACHE_SEARCH_SIZE: u32 = 8;
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

mod jit_cache_array {
    use page::Page;
    use state_flags::CachedStateFlags;

    // Note: For performance reasons, this is global state. See jit_find_cache_entry

    const NO_NEXT_ENTRY: u32 = 0xffff_ffff;

    // When changing this, you also need to bump global-base
    pub const SIZE: u32 = 0x40000;
    pub const MASK: u32 = SIZE - 1;

    #[derive(Copy, Clone)]
    pub struct Entry {
        pub start_addr: u32,

        #[cfg(any(debug_assertions, feature = "profiler"))]
        pub len: u32,

        #[cfg(debug_assertions)]
        pub opcode: u32,

        // an index into jit_cache_array for the next code_cache entry within the same physical page
        next_index_same_page: u32,

        pub initial_state: u16,
        pub wasm_table_index: u16,
        pub state_flags: CachedStateFlags,
        pub pending: bool,
    }

    impl Entry {
        pub fn create(
            start_addr: u32,
            next_index_same_page: Option<u32>,
            wasm_table_index: u16,
            initial_state: u16,
            state_flags: CachedStateFlags,
            pending: bool,
        ) -> Entry {
            let next_index_same_page = next_index_same_page.unwrap_or(NO_NEXT_ENTRY);
            Entry {
                start_addr,
                next_index_same_page,
                wasm_table_index,
                initial_state,
                state_flags,
                pending,

                #[cfg(any(debug_assertions, feature = "profiler"))]
                len: 0,

                #[cfg(debug_assertions)]
                opcode: 0,
            }
        }
        pub fn next_index_same_page(&self) -> Option<u32> {
            if self.next_index_same_page == NO_NEXT_ENTRY {
                None
            }
            else {
                Some(self.next_index_same_page)
            }
        }

        pub fn set_next_index_same_page(&mut self, next_index: Option<u32>) {
            if let Some(i) = next_index {
                self.next_index_same_page = i
            }
            else {
                self.next_index_same_page = NO_NEXT_ENTRY
            }
        }
    }

    const DEFAULT_ENTRY: Entry = Entry {
        start_addr: 0,
        next_index_same_page: NO_NEXT_ENTRY,
        wasm_table_index: 0,
        initial_state: 0,
        state_flags: CachedStateFlags::EMPTY,
        pending: false,

        #[cfg(any(debug_assertions, feature = "profiler"))]
        len: 0,
        #[cfg(debug_assertions)]
        opcode: 0,
    };

    #[allow(non_upper_case_globals)]
    pub const jit_cache_array: *mut Entry = ::global_pointers::JIT_CACHE_ARRAY as *mut Entry;

    #[allow(unreachable_code)]
    #[cfg(debug_assertions)]
    unsafe fn _static_assert() { std::mem::transmute::<Entry, [u8; 24]>(panic!()); }

    #[allow(unreachable_code)]
    #[cfg(all(not(debug_assertions), not(feature = "profiler")))]
    unsafe fn _static_assert() { std::mem::transmute::<Entry, [u8; 16]>(panic!()); }

    // XXX: Probably doesn't need to be statically allocated
    #[allow(non_upper_case_globals)]
    pub const page_first_entry: *mut u32 = ::global_pointers::JIT_PAGE_FIRST_ENTRY as *mut u32;

    pub fn get_page_index(page: Page) -> Option<u32> {
        let index = unsafe { *page_first_entry.offset(page.to_u32() as isize) };
        if index == NO_NEXT_ENTRY { None } else { Some(index) }
    }

    pub fn set_page_index(page: Page, index: Option<u32>) {
        let index = index.unwrap_or(NO_NEXT_ENTRY);
        unsafe { *page_first_entry.offset(page.to_u32() as isize) = index }
    }

    pub fn get(i: u32) -> &'static Entry { unsafe { &*jit_cache_array.offset(i as isize) } }
    pub fn get_mut(i: u32) -> &'static mut Entry {
        unsafe { &mut *jit_cache_array.offset(i as isize) }
    }

    fn set(i: u32, entry: Entry) {
        unsafe {
            *jit_cache_array.offset(i as isize) = entry
        };
    }

    pub fn insert(index: u32, mut entry: Entry) {
        let page = Page::page_of(entry.start_addr);

        let previous_entry_index = get_page_index(page);

        if let Some(previous_entry_index) = previous_entry_index {
            let previous_entry = get(previous_entry_index);

            if previous_entry.start_addr != 0 {
                dbg_assert!(
                    Page::page_of(previous_entry.start_addr) == Page::page_of(entry.start_addr)
                );
            }
        }

        set_page_index(page, Some(index));
        entry.set_next_index_same_page(previous_entry_index);

        set(index, entry);
    }

    pub fn remove(index: u32) {
        let page = Page::page_of((get(index)).start_addr);

        let mut page_index = get_page_index(page);
        let mut did_remove = false;

        if page_index == Some(index) {
            set_page_index(page, (get(index)).next_index_same_page());
            did_remove = true;
        }
        else {
            while let Some(page_index_ok) = page_index {
                let next_index = (get(page_index_ok)).next_index_same_page();
                if next_index == Some(index) {
                    (get_mut(page_index_ok))
                        .set_next_index_same_page((get(index)).next_index_same_page());
                    did_remove = true;
                    break;
                }
                page_index = next_index;
            }
        }

        (get_mut(index)).set_next_index_same_page(None);

        dbg_assert!(did_remove);
    }

    pub fn clear() {
        unsafe {
            for i in 0..SIZE {
                *jit_cache_array.offset(i as isize) = DEFAULT_ENTRY;
            }

            for i in 0..0x100000 {
                *page_first_entry.offset(i) = NO_NEXT_ENTRY;
            }
        }
    }

    pub fn check_invariants() {
        if !::jit::CHECK_JIT_CACHE_ARRAY_INVARIANTS {
            return;
        }

        // there are no loops in the linked lists
        // https://en.wikipedia.org/wiki/Cycle_detection#Floyd's_Tortoise_and_Hare
        for i in 0..(1 << 20) {
            let mut slow = get_page_index(Page::page_of(i << 12));
            let mut fast = slow;

            while let Some(fast_ok) = fast {
                fast = (get(fast_ok)).next_index_same_page();
                slow = (get(slow.unwrap())).next_index_same_page();

                if let Some(fast_ok) = fast {
                    fast = (get(fast_ok)).next_index_same_page();
                }
                else {
                    break;
                }

                dbg_assert!(slow != fast);
            }
        }

        let mut wasm_table_index_to_jit_cache_index = [0; ::jit::WASM_TABLE_SIZE as usize];

        for i in 0..SIZE {
            let entry = get(i);
            dbg_assert!(entry.next_index_same_page().map_or(true, |i| i < SIZE));

            if entry.pending {
                dbg_assert!(entry.start_addr != 0);
                dbg_assert!(entry.wasm_table_index != 0);
            }
            else {
                // an invalid entry has both its start_addr and wasm_table_index set to 0
                // neither start_addr nor wasm_table_index are 0 for any valid entry

                dbg_assert!((entry.start_addr == 0) == (entry.wasm_table_index == 0));
            }

            // having a next entry implies validity
            dbg_assert!(entry.next_index_same_page() == None || entry.start_addr != 0);

            // any valid wasm_table_index can only be used within a single page
            if entry.wasm_table_index != 0 {
                let j = wasm_table_index_to_jit_cache_index[entry.wasm_table_index as usize];

                if j != 0 {
                    let other_entry = get(j);
                    dbg_assert!(other_entry.wasm_table_index == entry.wasm_table_index);
                    dbg_assert!(
                        Page::page_of(other_entry.start_addr) == Page::page_of(entry.start_addr)
                    );
                }
                else {
                    wasm_table_index_to_jit_cache_index[entry.wasm_table_index as usize] = i as u32;
                }
            }

            if entry.start_addr != 0 {
                // valid entries can be reached from page_first_entry
                let mut reached = false;

                let page = Page::page_of(entry.start_addr);
                let mut cache_array_index = get_page_index(page);

                while let Some(index) = cache_array_index {
                    let other_entry = get(index);

                    if i as u32 == index {
                        reached = true;
                        break;
                    }

                    cache_array_index = other_entry.next_index_same_page();
                }

                dbg_assert!(reached);
            }
        }
    }
}

pub struct JitState {
    // as an alternative to HashSet, we could use a bitmap of 4096 bits here
    // (faster, but uses much more memory)
    // or a compressed bitmap (likely faster)
    hot_pages: [u32; HASH_PRIME as usize],
    wasm_table_index_free_list: Vec<u16>,
    wasm_table_index_pending_free: Vec<u16>,
    entry_points: HashMap<Page, HashSet<u16>>,
    wasm_builder: WasmBuilder,
}

impl JitState {
    pub fn create_and_initialise() -> JitState {
        jit_cache_array::clear();

        // don't assign 0 (XXX: Check)
        let wasm_table_indices = 1..=(WASM_TABLE_SIZE - 1) as u16;

        JitState {
            hot_pages: [0; HASH_PRIME as usize],
            wasm_table_index_free_list: Vec::from_iter(wasm_table_indices),
            wasm_table_index_pending_free: vec![],
            entry_points: HashMap::new(),
            wasm_builder: WasmBuilder::new(),
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
    last_instruction_addr: u32,
    end_addr: u32,
    is_entry_block: bool,
    ty: BasicBlockType,
    number_of_instructions: u32,
}

#[repr(C)]
#[derive(Copy, Clone, PartialEq)]
pub struct cached_code {
    pub wasm_table_index: u16,
    pub initial_state: u16,
}

impl cached_code {
    pub const NONE: cached_code = cached_code {
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
}

pub const JIT_INSTR_BLOCK_BOUNDARY_FLAG: u32 = 1 << 0;

fn jit_hot_hash_page(page: Page) -> u32 { page.to_u32() % HASH_PRIME }

fn is_near_end_of_page(address: u32) -> bool { address & 0xFFF >= 0x1000 - MAX_INSTRUCTION_LENGTH }

pub fn jit_find_cache_entry(phys_address: u32, state_flags: CachedStateFlags) -> cached_code {
    if is_near_end_of_page(phys_address) {
        profiler::stat_increment(stat::RUN_INTERPRETED_NEAR_END_OF_PAGE);
    }

    let mut run_interpreted_reason = None;

    for i in 0..CODE_CACHE_SEARCH_SIZE {
        let index = (phys_address + i) & jit_cache_array::MASK;
        let entry = jit_cache_array::get(index);

        if entry.start_addr == phys_address {
            if entry.pending {
                run_interpreted_reason = Some(stat::RUN_INTERPRETED_PENDING)
            }
            if entry.state_flags != state_flags {
                run_interpreted_reason = Some(stat::RUN_INTERPRETED_DIFFERENT_STATE)
            }
        }

        if is_near_end_of_page(phys_address) {
            dbg_assert!(entry.start_addr != phys_address);
        }

        if !entry.pending && entry.start_addr == phys_address && entry.state_flags == state_flags {
            #[cfg(debug_assertions)] // entry.opcode is not defined otherwise
            {
                dbg_assert!(cpu::read32(entry.start_addr) == entry.opcode);
            }
            return cached_code {
                wasm_table_index: entry.wasm_table_index,
                initial_state: entry.initial_state,
            };
        }
    }

    if let Some(reason) = run_interpreted_reason {
        profiler::stat_increment(reason);
    }

    cached_code::NONE
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

fn jit_find_basic_blocks(
    page: Page,
    entry_points: &HashSet<u16>,
    cpu: CpuContext,
) -> (Vec<BasicBlock>, bool) {
    let mut to_visit_stack: Vec<u16> = entry_points.iter().cloned().collect();
    let mut marked_as_entry: HashSet<u16> = entry_points.clone();
    let page_high_bits = page.to_address();
    let mut basic_blocks: BTreeMap<u32, BasicBlock> = BTreeMap::new();
    let mut requires_loop_limit = false;

    while let Some(to_visit_offset) = to_visit_stack.pop() {
        let to_visit = to_visit_offset as u32 | page_high_bits;
        if basic_blocks.contains_key(&to_visit) {
            continue;
        }
        if is_near_end_of_page(to_visit) {
            // Empty basic block, don't insert
            profiler::stat_increment(stat::COMPILE_CUT_OFF_AT_END_OF_PAGE);
            continue;
        }

        let mut current_address = to_visit;
        let mut current_block = BasicBlock {
            addr: current_address,
            last_instruction_addr: 0,
            end_addr: 0,
            ty: BasicBlockType::Exit,
            is_entry_block: false,
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

            match analysis.ty {
                AnalysisType::Normal => {
                    dbg_assert!(has_next_instruction);

                    if basic_blocks.contains_key(&current_address) {
                        current_block.last_instruction_addr = addr_before_instruction;
                        current_block.end_addr = current_address;
                        dbg_assert!(!is_near_end_of_page(current_address));
                        current_block.ty = BasicBlockType::Normal {
                            next_block_addr: current_address,
                        };
                        break;
                    }
                },
                AnalysisType::Jump {
                    offset,
                    is_32,
                    condition: Some(condition),
                } => {
                    // conditional jump: continue at next and continue at jump target

                    let jump_target = if is_32 {
                        current_address.wrapping_add(offset as u32)
                    }
                    else {
                        ctx.cs_offset.wrapping_add(
                            (current_address
                                .wrapping_sub(ctx.cs_offset)
                                .wrapping_add(offset as u32))
                                & 0xFFFF,
                        )
                    };

                    dbg_assert!(has_next_instruction);
                    to_visit_stack.push(current_address as u16 & 0xFFF);

                    let next_block_branch_taken_addr;

                    if Page::page_of(jump_target) == page && !is_near_end_of_page(jump_target) {
                        to_visit_stack.push(jump_target as u16 & 0xFFF);

                        next_block_branch_taken_addr = Some(jump_target);

                        // Very simple heuristic for "infinite loops": This
                        // detects Linux's "calibrating delay loop"
                        if jump_target == current_block.addr {
                            dbg_log!("Basic block looping back to front");
                            requires_loop_limit = true;
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
                        current_address.wrapping_add(offset as u32)
                    }
                    else {
                        ctx.cs_offset.wrapping_add(
                            (current_address
                                .wrapping_sub(ctx.cs_offset)
                                .wrapping_add(offset as u32))
                                & 0xFFFF,
                        )
                    };

                    if has_next_instruction {
                        // Execution will eventually come back to the next instruction (CALL)
                        marked_as_entry.insert(current_address as u16 & 0xFFF);
                        to_visit_stack.push(current_address as u16 & 0xFFF);
                    }

                    if Page::page_of(jump_target) == page && !is_near_end_of_page(jump_target) {
                        current_block.ty = BasicBlockType::Normal {
                            next_block_addr: jump_target,
                        };
                        to_visit_stack.push(jump_target as u16 & 0xFFF);
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
                        marked_as_entry.insert(current_address as u16 & 0xFFF);
                        to_visit_stack.push(current_address as u16 & 0xFFF);
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
            .map(|(_, previous_block)| (previous_block.addr, previous_block.end_addr));

        if let Some((start_addr, end_addr)) = previous_block {
            if current_block.addr < end_addr {
                // If this block overlaps with the previous block, re-analyze the previous block
                let old_block = basic_blocks.remove(&start_addr);
                dbg_assert!(old_block.is_some());
                to_visit_stack.push(start_addr as u16 & 0xFFF);

                // Note that this does not ensure the invariant that two consecutive blocks don't
                // overlay. For that, we also need to check the following block.
            }
        }

        dbg_assert!(current_block.addr < current_block.end_addr);
        dbg_assert!(current_block.addr <= current_block.last_instruction_addr);
        dbg_assert!(current_block.last_instruction_addr < current_block.end_addr);

        basic_blocks.insert(current_block.addr, current_block);
    }

    for block in basic_blocks.values_mut() {
        if marked_as_entry.contains(&(block.addr as u16 & 0xFFF)) {
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

    (basic_blocks, requires_loop_limit)
}

fn create_cache_entry(ctx: &mut JitState, entry: jit_cache_array::Entry) {
    let mut found_entry_index = None;
    let phys_addr = entry.start_addr;

    for i in 0..CODE_CACHE_SEARCH_SIZE {
        let addr_index = (phys_addr + i) & jit_cache_array::MASK;
        let existing_entry = jit_cache_array::get(addr_index);

        if existing_entry.start_addr == entry.start_addr
            && existing_entry.state_flags == entry.state_flags
        {
            profiler::stat_increment(stat::COMPILE_DUPLICATE_ENTRY);
        }

        if existing_entry.start_addr == 0 {
            found_entry_index = Some(addr_index);
            break;
        }
    }

    let found_entry_index = match found_entry_index {
        Some(i) => i,
        None => {
            profiler::stat_increment(stat::CACHE_MISMATCH);

            // no free slots, overwrite the first one
            let found_entry_index = phys_addr & jit_cache_array::MASK;

            let old_entry = jit_cache_array::get_mut(found_entry_index);

            // if we're here, we expect to overwrite a valid index
            dbg_assert!(old_entry.start_addr != 0);
            dbg_assert!(old_entry.wasm_table_index != 0);

            if old_entry.wasm_table_index == entry.wasm_table_index {
                profiler::stat_increment(stat::INVALIDATE_SINGLE_ENTRY_CACHE_FULL);

                dbg_assert!(old_entry.pending);
                dbg_assert!(Page::page_of(old_entry.start_addr) == Page::page_of(phys_addr));

                // The old entry belongs to the same wasm table index as this entry.
                // *Don't* free the wasm table index, instead just delete the old entry
                // and use its slot for this entry.
                // TODO: Optimally, we should pick another slot instead of dropping
                // an entry has just been created.
                jit_cache_array::remove(found_entry_index);

                dbg_assert!(old_entry.next_index_same_page() == None);
                old_entry.pending = false;
                old_entry.start_addr = 0;
            }
            else {
                profiler::stat_increment(stat::INVALIDATE_MODULE_CACHE_FULL);

                let old_wasm_table_index = old_entry.wasm_table_index;
                let old_page = Page::page_of(old_entry.start_addr);

                remove_jit_cache_wasm_index(ctx, old_page, old_wasm_table_index);

                //jit_cache_array::check_invariants();

                // old entry should be removed after calling remove_jit_cache_wasm_index

                dbg_assert!(!old_entry.pending);
                dbg_assert!(old_entry.start_addr == 0);
                dbg_assert!(old_entry.wasm_table_index == 0);
                dbg_assert!(old_entry.next_index_same_page() == None);
            }

            found_entry_index
        },
    };

    jit_cache_array::insert(found_entry_index, entry);
}

#[no_mangle]
#[cfg(debug_assertions)]
pub fn jit_force_generate_unsafe(phys_addr: u32, cs_offset: u32, state_flags: CachedStateFlags) {
    let ctx = get_jit_state();
    record_entry_point(phys_addr);
    jit_analyze_and_generate(ctx, Page::page_of(phys_addr), cs_offset, state_flags);
}

#[inline(never)]
fn jit_analyze_and_generate(
    ctx: &mut JitState,
    page: Page,
    cs_offset: u32,
    state_flags: CachedStateFlags,
) {
    dbg_log!("Compile code for page at {:x}", page.to_address());
    profiler::stat_increment(stat::COMPILE);

    let entry_points = ctx.entry_points.remove(&page);

    if let Some(entry_points) = entry_points {
        if jit_page_has_pending_code(ctx, page) {
            return;
        }

        let cpu = CpuContext {
            eip: 0,
            prefixes: 0,
            cs_offset,
            state_flags,
        };

        let (basic_blocks, requires_loop_limit) =
            jit_find_basic_blocks(page, &entry_points, cpu.clone());

        //for b in basic_blocks.iter() {
        //    dbg_log!(
        //        "> Basic block from {:x} to {:x}, is_entry={}",
        //        b.addr,
        //        b.end_addr,
        //        b.is_entry_block
        //    );
        //}

        if ctx.wasm_table_index_free_list.is_empty() {
            dbg_log!(
                "wasm_table_index_free_list empty ({} pending_free), clearing cache",
                ctx.wasm_table_index_pending_free.len(),
            );

            // When no free slots are available, delete all cached modules. We could increase the
            // size of the table, but this way the initial size acts as an upper bound for the
            // number of wasm modules that we generate, which we want anyway to avoid getting our
            // tab killed by browsers due to memory constraints.
            jit_clear_cache(ctx);

            profiler::stat_increment(stat::INVALIDATE_ALL_MODULES_NO_FREE_WASM_INDICES);

            dbg_log!(
                "after jit_clear_cache: {} pending_free {} free",
                ctx.wasm_table_index_pending_free.len(),
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

        jit_generate_module(
            &basic_blocks,
            requires_loop_limit,
            cpu.clone(),
            &mut ctx.wasm_builder,
        );

        // create entries for each basic block that is marked as an entry point
        let mut entry_point_count = 0;

        for (i, block) in basic_blocks.iter().enumerate() {
            profiler::stat_increment(stat::COMPILE_BASIC_BLOCK);

            if block.is_entry_block && block.addr != block.end_addr {
                dbg_assert!(block.addr != 0);

                let initial_state = i.safe_to_u16();

                #[allow(unused_mut)]
                let mut entry = jit_cache_array::Entry::create(
                    block.addr,
                    None, // to be filled in by create_cache_entry
                    wasm_table_index,
                    initial_state,
                    state_flags,
                    true,
                );

                #[cfg(any(debug_assertions, feature = "profiler"))]
                {
                    entry.len = block.end_addr - block.addr;
                }

                #[cfg(debug_assertions)]
                {
                    entry.opcode = cpu::read32(block.addr);
                }

                create_cache_entry(ctx, entry);

                entry_point_count += 1;
                profiler::stat_increment(stat::COMPILE_ENTRY_POINT);
            }
        }

        profiler::stat_increment_by(stat::COMPILE_WASM_TOTAL_BYTES, jit_get_op_len() as u64);

        dbg_assert!(entry_point_count > 0);

        cpu::tlb_set_has_code(page, true);

        jit_cache_array::check_invariants();
        cpu::check_tlb_invariants();

        let end_addr = 0;
        let first_opcode = 0;
        let phys_addr = page.to_address();

        // will call codegen_finalize_finished asynchronously when finished
        cpu::codegen_finalize(
            wasm_table_index,
            phys_addr,
            end_addr,
            first_opcode,
            state_flags,
        );

        profiler::stat_increment(stat::COMPILE_SUCCESS);
    }
    else {
        //dbg_log("No basic blocks, not generating code");
        // Nothing to do
    }
}

#[no_mangle]
pub fn codegen_finalize_finished(
    wasm_table_index: u16,
    phys_addr: u32,
    _end_addr: u32,
    _first_opcode: u32,
    _state_flags: CachedStateFlags,
) {
    let ctx = get_jit_state();

    dbg_assert!(wasm_table_index != 0);

    match ctx
        .wasm_table_index_pending_free
        .iter()
        .position(|i| *i == wasm_table_index)
    {
        Some(i) => {
            ctx.wasm_table_index_pending_free.swap_remove(i);
            free_wasm_table_index(ctx, wasm_table_index);
        },
        None => {
            let page = Page::page_of(phys_addr);
            let mut cache_array_index = jit_cache_array::get_page_index(page);

            while let Some(index) = cache_array_index {
                let mut entry = jit_cache_array::get_mut(index);

                if (*entry).wasm_table_index == wasm_table_index {
                    dbg_assert!((*entry).pending);
                    (*entry).pending = false;
                }

                cache_array_index = (*entry).next_index_same_page();
            }
        },
    }

    jit_cache_array::check_invariants();

    if CHECK_JIT_CACHE_ARRAY_INVARIANTS {
        // sanity check that the above iteration marked all entries as not pending

        for i in 0..jit_cache_array::SIZE {
            let entry = jit_cache_array::get(i);
            if entry.wasm_table_index == wasm_table_index {
                dbg_assert!(!entry.pending);
            }
        }
    }
}

fn jit_generate_module(
    basic_blocks: &Vec<BasicBlock>,
    requires_loop_limit: bool,
    mut cpu: CpuContext,
    builder: &mut WasmBuilder,
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
    let gen_local_iteration_counter = if JIT_ALWAYS_USE_LOOP_SAFETY || requires_loop_limit {
        builder.const_i32(JIT_MAX_ITERATIONS_PER_FUNCTION as i32);
        Some(builder.set_new_local())
    }
    else {
        None
    };

    let mut register_locals = (0..8)
        .map(|i| {
            builder.const_i32(global_pointers::get_reg32_offset(i) as i32);
            builder.load_aligned_i32_from_stack(0);
            let local = builder.set_new_local();
            local
        })
        .collect();

    let ctx = &mut JitContext {
        cpu: &mut cpu,
        builder,
        register_locals: &mut register_locals,
        start_of_current_instruction: 0,
        current_brtable_depth: 0,
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

    ctx.builder.free_local(gen_local_state);
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
            instruction = cpu::read32(ctx.cpu.eip);
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
        ctx.hot_pages[address_hash] = 0;
        jit_analyze_and_generate(ctx, page, cs_offset, state_flags)
    };
}

fn free_wasm_table_index(ctx: &mut JitState, wasm_table_index: u16) {
    if CHECK_JIT_CACHE_ARRAY_INVARIANTS {
        dbg_assert!(!ctx.wasm_table_index_free_list.contains(&wasm_table_index));
    }
    ctx.wasm_table_index_free_list.push(wasm_table_index);

    // It is not strictly necessary to clear the function, but it will fail more predictably if we
    // accidentally use the function and may garbage collect unused modules earlier
    cpu::jit_clear_func(wasm_table_index);
}

/// Remove all entries with the given wasm_table_index in page
fn remove_jit_cache_wasm_index(ctx: &mut JitState, page: Page, wasm_table_index: u16) {
    let mut cache_array_index = jit_cache_array::get_page_index(page).unwrap();

    let mut pending = false;

    loop {
        let entry = jit_cache_array::get_mut(cache_array_index);
        let next_cache_array_index = entry.next_index_same_page();

        if entry.wasm_table_index == wasm_table_index {
            // if one entry is pending, all must be pending
            dbg_assert!(!pending || entry.pending);

            pending = entry.pending;

            jit_cache_array::remove(cache_array_index);

            dbg_assert!(entry.next_index_same_page() == None);
            entry.wasm_table_index = 0;
            entry.start_addr = 0;
            entry.pending = false;
        }

        if let Some(i) = next_cache_array_index {
            cache_array_index = i;
        }
        else {
            break;
        }
    }

    if pending {
        ctx.wasm_table_index_pending_free.push(wasm_table_index);
    }
    else {
        free_wasm_table_index(ctx, wasm_table_index);
    }

    if !jit_page_has_code(page) {
        cpu::tlb_set_has_code(page, false);
    }

    if CHECK_JIT_CACHE_ARRAY_INVARIANTS {
        // sanity check that the above iteration deleted all entries

        for i in 0..jit_cache_array::SIZE {
            let entry = jit_cache_array::get(i);
            dbg_assert!(entry.wasm_table_index != wasm_table_index);
        }
    }
}

/// Register a write in this page: Delete all present code
pub fn jit_dirty_page(ctx: &mut JitState, page: Page) {
    let mut did_have_code = false;

    if let Some(mut cache_array_index) = jit_cache_array::get_page_index(page) {
        did_have_code = true;

        let mut index_to_free = HashSet::new();
        let mut index_to_pending_free = HashSet::new();

        jit_cache_array::set_page_index(page, None);
        profiler::stat_increment(stat::INVALIDATE_PAGE);

        loop {
            profiler::stat_increment(stat::INVALIDATE_CACHE_ENTRY);
            let entry = jit_cache_array::get_mut(cache_array_index);
            let wasm_table_index = entry.wasm_table_index;

            dbg_assert!(page == Page::page_of(entry.start_addr));

            let next_cache_array_index = entry.next_index_same_page();

            entry.set_next_index_same_page(None);
            entry.start_addr = 0;
            entry.wasm_table_index = 0;

            if entry.pending {
                dbg_assert!(!index_to_free.contains(&wasm_table_index));

                entry.pending = false;

                index_to_pending_free.insert(wasm_table_index);
            }
            else {
                dbg_assert!(!index_to_pending_free.contains(&wasm_table_index));
                index_to_free.insert(wasm_table_index);
            }

            if let Some(i) = next_cache_array_index {
                cache_array_index = i;
            }
            else {
                break;
            }
        }

        profiler::stat_increment_by(
            stat::INVALIDATE_MODULE,
            index_to_pending_free.len() as u64 + index_to_free.len() as u64,
        );

        for index in index_to_free.iter().cloned() {
            free_wasm_table_index(ctx, index)
        }

        for index in index_to_pending_free {
            ctx.wasm_table_index_pending_free.push(index);
        }
    }

    match ctx.entry_points.remove(&page) {
        None => {},
        Some(_entry_points) => {
            did_have_code = true;

            // don't try to compile code in this page anymore until it's hot again
            ctx.hot_pages[jit_hot_hash_page(page) as usize] = 0;
        },
    }

    if did_have_code {
        cpu::tlb_set_has_code(page, false);
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

    jit_dirty_page(get_jit_state(), start_page);

    // Note: This can't happen when paging is enabled, as writes across
    //       boundaries are split up on two pages
    if start_page != end_page {
        dbg_assert!(start_page.to_u32() + 1 == end_page.to_u32());
        jit_dirty_page(get_jit_state(), end_page);
    }
}

#[no_mangle]
pub fn jit_clear_cache_js() { jit_clear_cache(get_jit_state()) }

pub fn jit_clear_cache(ctx: &mut JitState) {
    ctx.entry_points.clear();

    for page_index in 0..0x100000 {
        jit_dirty_page(ctx, Page::page_of(page_index << 12))
    }

    cpu::jit_clear_all_funcs();
}

pub fn jit_page_has_code(page: Page) -> bool {
    let ctx = get_jit_state();
    // Does the page have compiled code
    jit_cache_array::get_page_index(page) != None ||
        // Or are there any entry points that need to be removed on write to the page
        // (this function is used to mark the has_code bit in the tlb to optimise away calls jit_dirty_page)
        ctx.entry_points.contains_key(&page)
}

pub fn jit_page_has_pending_code(_ctx: &JitState, page: Page) -> bool {
    if let Some(mut cache_array_index) = jit_cache_array::get_page_index(page) {
        loop {
            let entry = jit_cache_array::get(cache_array_index);
            dbg_assert!(page == Page::page_of(entry.start_addr));

            if entry.pending {
                return true;
            }

            if let Some(i) = entry.next_index_same_page() {
                cache_array_index = i;
            }
            else {
                break;
            }
        }
    }

    return false;
}

#[no_mangle]
pub fn jit_unused_cache_stat() -> u32 {
    let mut count = 0;
    if cfg!(debug_assertions) {
        for i in 0..jit_cache_array::SIZE {
            if (jit_cache_array::get(i)).start_addr == 0 {
                count += 1
            }
        }
    }
    return count;
}
#[no_mangle]
pub fn jit_get_entry_length(i: u32) -> u32 {
    #[allow(unused_variables)]
    let entry = jit_cache_array::get(i);
    #[cfg(debug_assertions)]
    return entry.len;
    #[cfg(not(debug_assertions))]
    0
}
#[no_mangle]
pub fn jit_get_entry_address(i: u32) -> u32 {
    if cfg!(debug_assertions) { jit_cache_array::get(i).start_addr } else { 0 }
}
#[no_mangle]
pub fn jit_get_entry_pending(i: u32) -> bool {
    if cfg!(debug_assertions) { jit_cache_array::get(i).pending } else { false }
}
#[no_mangle]
pub fn jit_get_wasm_table_index_free_list_count() -> u32 {
    if cfg!(debug_assertions) {
        get_jit_state().wasm_table_index_free_list.len() as u32
    }
    else {
        0
    }
}

#[no_mangle]
pub fn jit_get_op_len() -> u32 { get_jit_state().wasm_builder.get_op_len() }
#[no_mangle]
pub fn jit_get_op_ptr() -> *const u8 { get_jit_state().wasm_builder.get_op_ptr() }

#[cfg(feature = "profiler")]
pub fn check_missed_entry_points(phys_address: u32, state_flags: CachedStateFlags) {
    let page = Page::page_of(phys_address);

    for i in page.to_address()..page.to_address() + 4096 {
        // No need to check [CODE_CACHE_SEARCH_SIZE] entries here as we look at consecutive
        // addresses anyway
        let index = i & jit_cache_array::MASK;
        let entry = jit_cache_array::get(index);

        if !entry.pending
            && entry.state_flags == state_flags
            && phys_address >= entry.start_addr
            && phys_address < entry.start_addr + entry.len
        {
            profiler::stat_increment(stat::RUN_INTERPRETED_MISSED_COMPILED_ENTRY_LOOKUP);

            let last_jump_type = unsafe { ::cpu2::cpu::debug_last_jump.name() };
            let last_jump_addr =
                unsafe { ::cpu2::cpu::debug_last_jump.phys_address() }.unwrap_or(0);
            let last_jump_opcode =
                if last_jump_addr != 0 { cpu::read32(last_jump_addr) } else { 0 };

            let opcode = cpu::read32(phys_address);
            dbg_log!(
                "Compiled exists, but no entry point, \
                 start={:x} end={:x} phys_addr={:x} opcode={:02x} {:02x} {:02x} {:02x}. \
                 Last jump at {:x} ({}) opcode={:02x} {:02x} {:02x} {:02x}",
                entry.start_addr,
                entry.start_addr + entry.len,
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
