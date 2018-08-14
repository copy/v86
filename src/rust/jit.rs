use std::collections::{HashMap, HashSet};

use analysis::AnalysisType;
use codegen;
use cpu;
use cpu_context::CpuContext;
use jit_instructions;
use page::Page;
use profiler;
use profiler::stat;
use state_flags::CachedStateFlags;
use util::SafeToU16;
use wasmgen::module_init;
use wasmgen::module_init::WasmBuilder;
use wasmgen::wasm_util::WasmBuf;

pub const WASM_TABLE_SIZE: u32 = 0x10000;

pub const HASH_PRIME: u32 = 6151;

pub const CHECK_JIT_CACHE_ARRAY_INVARIANTS: bool = false;
pub const ENABLE_JIT_NONFAULTING_OPTIMZATION: bool = true;

pub const JIT_MAX_ITERATIONS_PER_FUNCTION: u32 = 10000;

pub const JIT_ALWAYS_USE_LOOP_SAFETY: bool = false;

pub const JIT_THRESHOLD: u32 = 2500;

const CONDITION_FUNCTIONS: [&str; 16] = [
    "test_o", "test_no", "test_b", "test_nb", "test_z", "test_nz", "test_be", "test_nbe", "test_s",
    "test_ns", "test_p", "test_np", "test_l", "test_nl", "test_le", "test_nle",
];

const CODE_CACHE_SEARCH_SIZE: u32 = 8;
const MAX_INSTRUCTION_LENGTH: u32 = 16;

mod jit_cache_array {
    use page::Page;
    use state_flags::CachedStateFlags;

    // Note: For performance reasons, this is global state. See jit_find_cache_entry

    const NO_NEXT_ENTRY: u32 = 0xffff_ffff;

    pub const SIZE: u32 = 0x40000;
    pub const MASK: u32 = (SIZE - 1);

    #[derive(Copy, Clone)]
    pub struct Entry {
        pub start_addr: u32,

        #[cfg(debug_assertions)]
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

                #[cfg(debug_assertions)]
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

        #[cfg(debug_assertions)]
        len: 0,
        #[cfg(debug_assertions)]
        opcode: 0,
    };

    #[allow(non_upper_case_globals)]
    static mut jit_cache_array: [Entry; SIZE as usize] = [Entry {
        start_addr: 0,
        next_index_same_page: 0,
        wasm_table_index: 0,
        initial_state: 0,
        state_flags: CachedStateFlags::EMPTY,
        pending: false,

        #[cfg(debug_assertions)]
        len: 0,
        #[cfg(debug_assertions)]
        opcode: 0,
    }; SIZE as usize];

    #[allow(non_upper_case_globals)]
    static mut page_first_entry: [u32; 0x100000] = [0; 0x100000];

    pub fn get_page_index(page: Page) -> Option<u32> {
        let index = unsafe { page_first_entry[page.to_u32() as usize] };
        if index == NO_NEXT_ENTRY {
            None
        }
        else {
            Some(index)
        }
    }

    pub fn set_page_index(page: Page, index: Option<u32>) {
        let index = index.unwrap_or(NO_NEXT_ENTRY);
        unsafe { page_first_entry[page.to_u32() as usize] = index }
    }

    pub fn get(i: u32) -> &'static Entry { unsafe { &jit_cache_array[i as usize] } }
    pub fn get_mut(i: u32) -> &'static mut Entry { unsafe { &mut jit_cache_array[i as usize] } }

    pub fn get_unchecked(i: u32) -> &'static Entry {
        unsafe { jit_cache_array.get_unchecked(i as usize) }
    }

    fn set(i: u32, entry: Entry) { unsafe { jit_cache_array[i as usize] = entry }; }

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
        let page = Page::page_of(get(index).start_addr);

        let mut page_index = get_page_index(page);
        let mut did_remove = false;

        if page_index == Some(index) {
            set_page_index(page, get(index).next_index_same_page());
            did_remove = true;
        }
        else {
            while let Some(page_index_ok) = page_index {
                let next_index = get(page_index_ok).next_index_same_page();
                if next_index == Some(index) {
                    get_mut(page_index_ok)
                        .set_next_index_same_page(get(index).next_index_same_page());
                    did_remove = true;
                    break;
                }
                page_index = next_index;
            }
        }

        get_mut(index).set_next_index_same_page(None);

        dbg_assert!(did_remove);
    }

    pub fn iter() -> ::std::slice::Iter<'static, Entry> { unsafe { jit_cache_array.iter() } }

    pub fn clear() {
        unsafe {
            for (i, _) in jit_cache_array.iter().enumerate() {
                jit_cache_array[i] = DEFAULT_ENTRY;
            }

            for (i, _) in page_first_entry.iter().enumerate() {
                page_first_entry[i] = NO_NEXT_ENTRY;
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
                fast = get(fast_ok).next_index_same_page();
                slow = get(slow.unwrap()).next_index_same_page();

                if let Some(fast_ok) = fast {
                    fast = get(fast_ok).next_index_same_page();
                }
                else {
                    break;
                }

                dbg_assert!(slow != fast);
            }
        }

        let mut wasm_table_index_to_jit_cache_index = [0; ::jit::WASM_TABLE_SIZE as usize];

        for (i, entry) in iter().enumerate() {
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
    hot_code_addresses: [u32; HASH_PRIME as usize],
    wasm_table_index_free_list: Vec<u16>,
    wasm_table_index_pending_free: Vec<u16>,
    entry_points: HashMap<Page, HashSet<u16>>,
    wasm_builder: WasmBuilder,
}

impl JitState {
    pub fn create_and_initialise() -> JitState {
        let mut wasm_builder = WasmBuilder::new();
        wasm_builder.init();
        let mut c = JitState {
            hot_code_addresses: [0; HASH_PRIME as usize],
            wasm_table_index_free_list: vec![],
            wasm_table_index_pending_free: vec![],
            entry_points: HashMap::new(),
            wasm_builder,
        };
        jit_empty_cache(&mut c);
        c
    }
}

#[derive(PartialEq, Eq)]
enum BasicBlockType {
    Normal {
        next_block_addr: u32,
    },
    ConditionalJump {
        next_block_addr: u32,
        next_block_branch_taken_addr: Option<u32>,
        condition: u8,
        jump_offset: i32,
        jump_offset_is_32: bool,
    },
    Exit,
}

struct BasicBlock {
    addr: u32,
    end_addr: u32,
    is_entry_block: bool,
    ty: BasicBlockType,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct cached_code {
    pub wasm_table_index: u16,
    pub initial_state: u16,
}

impl cached_code {
    const NONE: cached_code = cached_code {
        wasm_table_index: 0,
        initial_state: 0,
    };
}

pub struct JitContext<'a> {
    pub cpu: &'a mut CpuContext,
    pub builder: &'a mut WasmBuilder,
}

pub const JIT_INSTR_BLOCK_BOUNDARY_FLAG: u32 = 1 << 0;
pub const JIT_INSTR_NONFAULTING_FLAG: u32 = 1 << 1;

pub const FN_GET_SEG_IDX: u16 = 0;

fn jit_hot_hash_page(page: Page) -> u32 { page.to_u32() % HASH_PRIME }

fn is_near_end_of_page(address: u32) -> bool { address & 0xFFF >= 0x1000 - MAX_INSTRUCTION_LENGTH }

pub fn jit_find_cache_entry(phys_address: u32, state_flags: CachedStateFlags) -> cached_code {
    for i in 0..CODE_CACHE_SEARCH_SIZE {
        let index = (phys_address + i) & jit_cache_array::MASK;
        let entry = jit_cache_array::get_unchecked(index);

        #[cfg(debug_assertions)]
        {
            if entry.start_addr == phys_address {
                if entry.pending {
                    profiler::stat_increment(stat::S_RUN_INTERPRETED_PENDING)
                }
                if entry.state_flags != state_flags {
                    profiler::stat_increment(stat::S_RUN_INTERPRETED_DIFFERENT_STATE)
                }
            }

            if is_near_end_of_page(phys_address) {
                dbg_assert!(entry.start_addr != phys_address);
                profiler::stat_increment(stat::S_RUN_INTERPRETED_NEAR_END_OF_PAGE);
            }
        }

        if !entry.pending && entry.start_addr == phys_address && entry.state_flags == state_flags {
            #[cfg(debug_assertions)]
            {
                dbg_assert!(cpu::read32(entry.start_addr) == entry.opcode)
            }
            return cached_code {
                wasm_table_index: entry.wasm_table_index,
                initial_state: entry.initial_state,
            };
        }
    }

    cached_code::NONE
}

fn record_entry_point(ctx: &mut JitState, phys_address: u32) {
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
        }).insert(offset_in_page);

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
    let mut basic_blocks: HashMap<u32, BasicBlock> = HashMap::new();
    let mut requires_loop_limit = false;

    while let Some(to_visit_offset) = to_visit_stack.pop() {
        let to_visit = to_visit_offset as u32 | page_high_bits;
        if basic_blocks.contains_key(&to_visit) {
            continue;
        }
        let mut current_address = to_visit;
        let mut current_block = BasicBlock {
            addr: current_address,
            end_addr: 0,
            ty: BasicBlockType::Exit,
            is_entry_block: false,
        };
        loop {
            if is_near_end_of_page(current_address) {
                // TODO: Don't insert this block if empty
                current_block.end_addr = current_address;
                profiler::stat_increment(stat::S_COMPILE_CUT_OFF_AT_END_OF_PAGE);
                break;
            }
            let mut ctx = &mut CpuContext {
                eip: current_address,
                ..cpu
            };
            let analysis = ::analysis::analyze_step(&mut ctx);
            let has_next_instruction = !analysis.no_next_instruction;
            current_address = ctx.eip;

            match analysis.ty {
                AnalysisType::Normal => {
                    dbg_assert!(has_next_instruction);

                    if basic_blocks.contains_key(&current_address) {
                        current_block.end_addr = current_address;
                        current_block.ty = BasicBlockType::Normal {
                            next_block_addr: current_address,
                        };
                    }
                },
                AnalysisType::Jump {
                    offset,
                    is_32,
                    condition,
                } => {
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

                    if let Some(condition) = condition {
                        // conditional jump: continue at next and continue at jump target

                        dbg_assert!(has_next_instruction);
                        to_visit_stack.push(current_address as u16 & 0xFFF);

                        let next_block_branch_taken_addr;

                        if Page::page_of(jump_target) == page {
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

                        current_block.ty = BasicBlockType::ConditionalJump {
                            next_block_addr: current_address,
                            next_block_branch_taken_addr,
                            condition,
                            jump_offset: offset,
                            jump_offset_is_32: is_32,
                        };

                        current_block.end_addr = current_address;

                        break;
                    }
                    else {
                        // non-conditional jump: continue at jump target

                        if has_next_instruction {
                            // Execution will eventually come back to the next instruction (CALL)
                            marked_as_entry.insert(current_address as u16 & 0xFFF);
                            to_visit_stack.push(current_address as u16 & 0xFFF);
                        }

                        if Page::page_of(jump_target) == page {
                            current_block.ty = BasicBlockType::Normal {
                                next_block_addr: jump_target,
                            };
                            to_visit_stack.push(jump_target as u16 & 0xFFF);
                        }
                        else {
                            current_block.ty = BasicBlockType::Exit;
                        }

                        current_block.end_addr = current_address;

                        break;
                    }
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

                    current_block.end_addr = current_address;
                    break;
                },
            }
        }

        basic_blocks.insert(to_visit, current_block);
    }

    for block in basic_blocks.values_mut() {
        if marked_as_entry.contains(&(block.addr as u16 & 0xFFF)) {
            block.is_entry_block = true;
        }
    }

    let mut basic_blocks: Vec<BasicBlock> =
        basic_blocks.into_iter().map(|(_, block)| block).collect();

    basic_blocks.sort_by_key(|block| block.addr);

    for i in 0..basic_blocks.len() - 1 {
        let next_block_addr = basic_blocks[i + 1].addr;
        let block = &mut basic_blocks[i];
        if next_block_addr < block.end_addr {
            block.ty = BasicBlockType::Normal { next_block_addr };
            block.end_addr = next_block_addr;

            // TODO: assert that the old type is equal to the type of the following block?
        }
    }

    (basic_blocks, requires_loop_limit)
}

fn create_cache_entry(ctx: &mut JitState, entry: jit_cache_array::Entry) {
    let mut found_entry_index = None;
    let phys_addr = entry.start_addr;

    for i in 0..CODE_CACHE_SEARCH_SIZE {
        let addr_index = (phys_addr + i) & jit_cache_array::MASK;
        let entry = jit_cache_array::get(addr_index);

        if entry.start_addr == 0 {
            found_entry_index = Some(addr_index);
            break;
        }
    }

    let found_entry_index = match found_entry_index {
        Some(i) => i,
        None => {
            profiler::stat_increment(stat::S_CACHE_MISMATCH);

            // no free slots, overwrite the first one
            let found_entry_index = phys_addr & jit_cache_array::MASK;

            let old_entry = jit_cache_array::get_mut(found_entry_index);

            // if we're here, we expect to overwrite a valid index
            dbg_assert!(old_entry.start_addr != 0);
            dbg_assert!(old_entry.wasm_table_index != 0);

            if old_entry.wasm_table_index == entry.wasm_table_index {
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

#[cfg(debug_assertions)]
pub fn jit_force_generate_unsafe(
    ctx: &mut JitState,
    phys_addr: u32,
    cs_offset: u32,
    state_flags: CachedStateFlags,
) {
    record_entry_point(ctx, phys_addr);
    jit_analyze_and_generate(ctx, Page::page_of(phys_addr), cs_offset, state_flags);
}

#[inline(never)]
fn jit_analyze_and_generate(
    ctx: &mut JitState,
    page: Page,
    cs_offset: u32,
    state_flags: CachedStateFlags,
) {
    profiler::stat_increment(stat::S_COMPILE);

    let entry_points = ctx.entry_points.remove(&page);
    let cpu = CpuContext {
        eip: 0,
        prefixes: 0,
        cs_offset,
        state_flags,
    };

    if let Some(entry_points) = entry_points {
        let (mut basic_blocks, requires_loop_limit) =
            jit_find_basic_blocks(page, &entry_points, cpu.clone());

        //for b in basic_blocks.iter() {
        //    dbg_log!(
        //        "> Basic block from {:x} to {:x}, is_entry={}",
        //        b.addr,
        //        b.end_addr,
        //        b.is_entry_block
        //    );
        //}

        jit_generate_module(
            &basic_blocks,
            requires_loop_limit,
            cpu.clone(),
            &mut ctx.wasm_builder,
        );

        // allocate an index in the wasm table
        let wasm_table_index = ctx
            .wasm_table_index_free_list
            .pop()
            .expect("allocate wasm table index");
        dbg_assert!(wasm_table_index != 0);

        // create entries for each basic block that is marked as an entry point
        let mut entry_point_count = 0;

        for (i, block) in basic_blocks.iter().enumerate() {
            profiler::stat_increment(stat::S_COMPILE_BASIC_BLOCK);

            if block.is_entry_block && block.addr != block.end_addr {
                dbg_assert!(block.addr != 0);

                let initial_state = i.safe_to_u16();

                let mut entry = jit_cache_array::Entry::create(
                    block.addr,
                    None, // to be filled in by create_cache_entry
                    wasm_table_index,
                    initial_state,
                    state_flags,
                    true,
                );

                #[cfg(debug_assertions)]
                {
                    entry.len = block.end_addr - block.addr;
                    entry.opcode = cpu::read32(block.addr);
                }

                create_cache_entry(ctx, entry);

                entry_point_count += 1;
                profiler::stat_increment(stat::S_COMPILE_ENTRY_POINT);
            }
        }

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

        profiler::stat_increment(stat::S_COMPILE_SUCCESS);
    }
    else {
        //dbg_log("No basic blocks, not generating code");
        // Nothing to do
    }
}

pub fn codegen_finalize_finished(
    ctx: &mut JitState,
    wasm_table_index: u16,
    phys_addr: u32,
    _end_addr: u32,
    _first_opcode: u32,
    _state_flags: CachedStateFlags,
) {
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

                if entry.wasm_table_index == wasm_table_index {
                    dbg_assert!(entry.pending);
                    entry.pending = false;
                }

                cache_array_index = entry.next_index_same_page();
            }
        },
    }

    jit_cache_array::check_invariants();

    if CHECK_JIT_CACHE_ARRAY_INVARIANTS {
        // sanity check that the above iteration marked all entries as not pending

        for entry in jit_cache_array::iter() {
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

    let fn_get_seg_idx = builder.get_fn_idx("get_seg", module_init::FN1_RET_TYPE_INDEX);
    dbg_assert!(fn_get_seg_idx == FN_GET_SEG_IDX);

    let basic_block_indices: HashMap<u32, u32> = basic_blocks
        .iter()
        .enumerate()
        .map(|(index, block)| (block.addr, index as u32))
        .collect();

    // set state local variable to the initial state passed as the first argument
    builder
        .instruction_body
        .get_local(&builder.arg_local_initial_state);
    let gen_local_state = builder.set_new_local();

    // initialise max_iterations
    let gen_local_iteration_counter = if JIT_ALWAYS_USE_LOOP_SAFETY || requires_loop_limit {
        builder
            .instruction_body
            .push_i32(JIT_MAX_ITERATIONS_PER_FUNCTION as i32);
        Some(builder.set_new_local())
    }
    else {
        None
    };

    // main state machine loop
    builder.instruction_body.loop_void();

    if let Some(gen_local_iteration_counter) = gen_local_iteration_counter.as_ref() {
        profiler::stat_increment(stat::S_COMPILE_WITH_LOOP_SAFETY);

        // decrement max_iterations
        builder
            .instruction_body
            .get_local(gen_local_iteration_counter);
        builder.instruction_body.push_i32(-1);
        builder.instruction_body.add_i32();
        builder
            .instruction_body
            .set_local(gen_local_iteration_counter);

        // if max_iterations == 0: return
        builder
            .instruction_body
            .get_local(gen_local_iteration_counter);
        builder.instruction_body.eqz_i32();
        builder.instruction_body.if_void();
        builder.instruction_body.return_();
        builder.instruction_body.block_end();
    }

    builder.instruction_body.block_void(); // for the default case

    // generate the opening blocks for the cases

    for _ in 0..basic_blocks.len() {
        builder.instruction_body.block_void();
    }

    builder.instruction_body.get_local(&gen_local_state);
    builder
        .instruction_body
        .brtable_and_cases(basic_blocks.len() as u32);

    for (i, block) in basic_blocks.iter().enumerate() {
        // Case [i] will jump after the [i]th block, so we first generate the
        // block end opcode and then the code for that block
        builder.instruction_body.block_end();

        if block.addr == block.end_addr {
            // Empty basic block, generate no code (for example, jump to block
            // that is near end of page)
            dbg_assert!(block.ty == BasicBlockType::Exit);
        }
        else {
            builder.commit_instruction_body_to_cs();
            jit_generate_basic_block(&mut cpu, builder, block.addr, block.end_addr);
            builder.commit_instruction_body_to_cs();
        }

        let invalid_connection_to_next_block = block.end_addr != cpu.eip;

        match (&block.ty, invalid_connection_to_next_block) {
            (_, true) | (BasicBlockType::Exit, _) => {
                // Exit this function
                builder.instruction_body.return_();
            },
            (BasicBlockType::Normal { next_block_addr }, _) => {
                // Unconditional jump to next basic block
                // - All instructions that don't change eip
                // - Unconditional jump

                let next_bb_index = *basic_block_indices.get(&next_block_addr).expect("");

                // set state variable to next basic block
                builder.instruction_body.push_i32(next_bb_index as i32);
                builder.instruction_body.set_local(&gen_local_state);

                builder
                    .instruction_body
                    .br(basic_blocks.len() as u32 - i as u32); // to the loop
            },
            (
                &BasicBlockType::ConditionalJump {
                    next_block_addr,
                    next_block_branch_taken_addr,
                    condition,
                    jump_offset,
                    jump_offset_is_32,
                },
                _,
            ) => {
                // Conditional jump to next basic block
                // - jnz, jc, etc.

                dbg_assert!(condition < 16);
                let condition = CONDITION_FUNCTIONS[condition as usize];

                codegen::gen_fn0_const_ret(builder, condition);

                builder.instruction_body.if_void();

                // Branch taken

                if jump_offset_is_32 {
                    codegen::gen_relative_jump(builder, jump_offset);
                }
                else {
                    // TODO: Is this necessary?
                    let ctx = &mut JitContext {
                        cpu: &mut cpu.clone(),
                        builder,
                    };
                    codegen::gen_fn1_const(ctx, "jmp_rel16", jump_offset as u32);
                }

                if let Some(next_block_branch_taken_addr) = next_block_branch_taken_addr {
                    let next_basic_block_branch_taken_index = *basic_block_indices
                        .get(&next_block_branch_taken_addr)
                        .expect("");

                    builder
                        .instruction_body
                        .push_i32(next_basic_block_branch_taken_index as i32);
                    builder.instruction_body.set_local(&gen_local_state);
                }
                else {
                    // Jump to different page
                    builder.instruction_body.return_();
                }

                builder.instruction_body.else_();

                {
                    // Branch not taken
                    // TODO: Could use fall-through here
                    let next_basic_block_index =
                        *basic_block_indices.get(&next_block_addr).expect("");

                    builder
                        .instruction_body
                        .push_i32(next_basic_block_index as i32);
                    builder.instruction_body.set_local(&gen_local_state);
                }

                builder.instruction_body.block_end();

                builder
                    .instruction_body
                    .br(basic_blocks.len() as u32 - i as u32); // to the loop
            },
        }
    }

    builder.instruction_body.block_end(); // default case
    builder.instruction_body.unreachable();

    builder.instruction_body.block_end(); // loop

    builder.commit_instruction_body_to_cs();
    builder.finish();
}

fn jit_generate_basic_block(
    mut cpu: &mut CpuContext,
    builder: &mut WasmBuilder,
    start_addr: u32,
    stop_addr: u32,
) {
    let mut len = 0;

    let mut end_addr;
    let mut was_block_boundary;
    let mut eip_delta = 0;

    // First iteration of do-while assumes the caller confirms this condition
    dbg_assert!(!is_near_end_of_page(start_addr));

    cpu.eip = start_addr;

    loop {
        if false {
            ::opstats::gen_opstats(builder, cpu::read32(cpu.eip));
        }
        let start_eip = cpu.eip;
        let mut instruction_flags = 0;
        jit_instructions::jit_instruction(&mut cpu, builder, &mut instruction_flags);
        let end_eip = cpu.eip;

        #[cfg(debug_assertions)]
        {
            if ::config::CHECK_CPU_EXCEPTIONS {
                // only the last instruction in each basic block is allowed to raise
                if end_eip < stop_addr {
                    let fn_idx =
                        builder.get_fn_idx("assert_no_cpu_exception", module_init::FN0_TYPE_INDEX);
                    builder.instruction_body.call_fn(fn_idx);
                }
            }
        }

        let instruction_length = end_eip - start_eip;
        was_block_boundary = instruction_flags & JIT_INSTR_BLOCK_BOUNDARY_FLAG != 0;

        dbg_assert!(instruction_length < MAX_INSTRUCTION_LENGTH);

        if ENABLE_JIT_NONFAULTING_OPTIMZATION {
            // There are a few conditions to keep in mind to optimize the update of previous_ip and
            // instruction_pointer:
            // - previous_ip MUST be updated just before a faulting instruction
            // - instruction_pointer MUST be updated before jump instructions (since they use the EIP
            //   value for instruction logic)
            // - Nonfaulting instructions don't need either to be updated
            if was_block_boundary {
                // prev_ip = eip + eip_delta, so that previous_ip points to the start of this instruction
                codegen::gen_set_previous_eip_offset_from_eip(builder, eip_delta);

                // eip += eip_delta + len(jump) so instruction logic uses the correct eip
                codegen::gen_increment_instruction_pointer(builder, eip_delta + instruction_length);
                builder.commit_instruction_body_to_cs();

                eip_delta = 0;
            }
            else if instruction_flags & JIT_INSTR_NONFAULTING_FLAG == 0 {
                // Faulting instruction

                // prev_ip = eip + eip_delta, so that previous_ip points to the start of this instruction
                codegen::gen_set_previous_eip_offset_from_eip(builder, eip_delta);
                builder.commit_instruction_body_to_cs();

                // Leave this instruction's length to be updated in the next batch, whatever it may be
                eip_delta += instruction_length;
            }
            else {
                // Non-faulting, so we skip setting previous_ip and simply queue the instruction length
                // for whenever eip is updated next
                profiler::stat_increment(stat::S_NONFAULTING_OPTIMIZATION);
                eip_delta += instruction_length;
            }
        }
        else {
            codegen::gen_set_previous_eip(builder);
            codegen::gen_increment_instruction_pointer(builder, instruction_length);
            builder.commit_instruction_body_to_cs();
        }
        end_addr = cpu.eip;
        len += 1;

        if end_addr == stop_addr {
            break;
        }

        if was_block_boundary || is_near_end_of_page(end_addr) || end_addr > stop_addr {
            dbg_log!("Overlapping basic blocks start={:x} expected_end={:x} end={:x} was_block_boundary={} near_end_of_page={}",
                     start_addr, stop_addr, end_addr, was_block_boundary, is_near_end_of_page(end_addr));
            break;
        }
    }

    if ENABLE_JIT_NONFAULTING_OPTIMZATION {
        // When the block ends in a non-jump instruction, we may have uncommitted updates still
        if eip_delta > 0 {
            builder.commit_instruction_body_to_cs();
            codegen::gen_increment_instruction_pointer(builder, eip_delta);
        }
    }

    codegen::gen_increment_timestamp_counter(builder, len);

    // no page was crossed
    dbg_assert!(Page::page_of(end_addr) == Page::page_of(start_addr));
}

pub fn jit_increase_hotness_and_maybe_compile(
    ctx: &mut JitState,
    phys_address: u32,
    cs_offset: u32,
    state_flags: CachedStateFlags,
) {
    return;
    record_entry_point(ctx, phys_address);
    let page = Page::page_of(phys_address);
    let address_hash = jit_hot_hash_page(page) as usize;
    ctx.hot_code_addresses[address_hash] += 1;
    if ctx.hot_code_addresses[address_hash] >= JIT_THRESHOLD {
        ctx.hot_code_addresses[address_hash] = 0;
        jit_analyze_and_generate(ctx, page, cs_offset, state_flags)
    };
}

fn free_wasm_table_index(ctx: &mut JitState, wasm_table_index: u16) {
    if CHECK_JIT_CACHE_ARRAY_INVARIANTS {
        dbg_assert!(!ctx.wasm_table_index_free_list.contains(&wasm_table_index));
    }
    ctx.wasm_table_index_free_list.push(wasm_table_index)

    // It is not strictly necessary to clear the function, but it will fail
    // more predictably if we accidentally use the function
    // XXX: This fails in Chromium:
    //   RangeError: WebAssembly.Table.set(): Modifying existing entry in table not supported.
    //jit_clear_func(wasm_table_index);
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

    if !jit_page_has_code(ctx, page) {
        cpu::tlb_set_has_code(page, false);
    }

    if CHECK_JIT_CACHE_ARRAY_INVARIANTS {
        // sanity check that the above iteration deleted all entries

        for entry in jit_cache_array::iter() {
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
        profiler::stat_increment(stat::S_INVALIDATE_PAGE);

        loop {
            profiler::stat_increment(stat::S_INVALIDATE_CACHE_ENTRY);
            let entry = jit_cache_array::get_mut(cache_array_index);
            let wasm_table_index = entry.wasm_table_index;

            dbg_assert!(page == Page::page_of(entry.start_addr));

            let next_cache_array_index = entry.next_index_same_page();

            entry.set_next_index_same_page(None);
            entry.start_addr = 0;
            entry.wasm_table_index = 0;

            if entry.pending {
                entry.pending = false;

                index_to_pending_free.insert(wasm_table_index);
            }
            else {
                index_to_free.insert(wasm_table_index);
            }

            if let Some(i) = next_cache_array_index {
                cache_array_index = i;
            }
            else {
                break;
            }
        }

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
            ctx.hot_code_addresses[jit_hot_hash_page(page) as usize] = 0;
        },
    }

    if did_have_code {
        cpu::tlb_set_has_code(page, false);
    }
}

pub fn jit_dirty_cache(ctx: &mut JitState, start_addr: u32, end_addr: u32) {
    dbg_assert!(start_addr < end_addr);

    let start_page = Page::page_of(start_addr);
    let end_page = Page::page_of(end_addr - 1);

    for page in start_page.to_u32()..end_page.to_u32() + 1 {
        jit_dirty_page(ctx, Page::page_of(page << 12));
    }
}

pub fn jit_dirty_cache_small(ctx: &mut JitState, start_addr: u32, end_addr: u32) {
    dbg_assert!(start_addr < end_addr);

    let start_page = Page::page_of(start_addr);
    let end_page = Page::page_of(end_addr - 1);

    jit_dirty_page(ctx, start_page);

    // Note: This can't happen when paging is enabled, as writes across
    //       boundaries are split up on two pages
    if start_page != end_page {
        dbg_assert!(start_page.to_u32() + 1 == end_page.to_u32());
        jit_dirty_page(ctx, end_page);
    }
}

pub fn jit_dirty_cache_single(ctx: &mut JitState, addr: u32) {
    jit_dirty_page(ctx, Page::page_of(addr));
}

pub fn jit_empty_cache(ctx: &mut JitState) {
    jit_cache_array::clear();

    ctx.entry_points.clear();

    ctx.wasm_table_index_pending_free.clear();
    ctx.wasm_table_index_free_list.clear();

    for i in 0..0xFFFF {
        // don't assign 0 (XXX: Check)
        ctx.wasm_table_index_free_list.push(i as u16 + 1);
    }
}

pub fn jit_page_has_code(ctx: &JitState, page: Page) -> bool {
    (jit_cache_array::get_page_index(page) != None || ctx.entry_points.contains_key(&page))
}

#[cfg(debug_assertions)]
pub fn jit_unused_cache_stat() -> u32 {
    jit_cache_array::iter()
        .filter(|e| e.start_addr == 0)
        .count() as u32
}
#[cfg(debug_assertions)]
pub fn jit_get_entry_length(i: u32) -> u32 { jit_cache_array::get(i).len }
#[cfg(debug_assertions)]
pub fn jit_get_entry_address(i: u32) -> u32 { jit_cache_array::get(i).start_addr }
#[cfg(debug_assertions)]
pub fn jit_get_entry_pending(i: u32) -> bool { jit_cache_array::get(i).pending }
#[cfg(debug_assertions)]
pub fn jit_get_wasm_table_index_free_list_count(ctx: &JitState) -> u32 {
    ctx.wasm_table_index_free_list.len() as u32
}

pub fn jit_get_op_len(ctx: &JitState) -> u32 { ctx.wasm_builder.get_op_len() }
pub fn jit_get_op_ptr(ctx: &JitState) -> *const u8 { ctx.wasm_builder.get_op_ptr() }
