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

mod unsafe_jit {
    use ::jit::CachedStateFlags;

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

pub const CHECK_JIT_CACHE_ARRAY_INVARIANTS: bool = false;

pub const JIT_MAX_ITERATIONS_PER_FUNCTION: u32 = 10000;

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
    // as an alternative to HashSet, we could use a bitmap of 4096 bits here
    // (faster, but uses much more memory)
    // or a compressed bitmap (likely faster)
    hot_pages: [u32; HASH_PRIME as usize],
    wasm_table_index_free_list: Vec<u16>,
    entry_points: HashMap<Page, HashSet<u16>>,
    wasm_builder: WasmBuilder,

    cache: BTreeMap<u32, Entry>,
    page_has_pending_code: HashMap<Page, (u16, PageState)>,
}

impl JitState {
    pub fn create_and_initialise() -> JitState {
        // don't assign 0 (XXX: Check)
        let wasm_table_indices = 1..=(WASM_TABLE_SIZE - 1) as u16;

        JitState {
            hot_pages: [0; HASH_PRIME as usize],
            wasm_table_index_free_list: Vec::from_iter(wasm_table_indices),
            entry_points: HashMap::new(),
            wasm_builder: WasmBuilder::new(),
            cache: BTreeMap::new(),
            page_has_pending_code: HashMap::new(),
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

fn is_near_end_of_page(address: u32) -> bool { address & 0xFFF >= 0x1000 - MAX_INSTRUCTION_LENGTH }

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
                if entry.state_flags != state_flags {
                    profiler::stat_increment(stat::RUN_INTERPRETED_DIFFERENT_STATE);
                }
            }
        },
        None => {},
    }

    return CachedCode::NONE;
}

#[no_mangle]
pub fn jit_find_cache_entry_in_page(
    virt_eip: i32,
    phys_eip: u32,
    wasm_table_index: u16,
    state_flags: u32,
) -> i32 {
    let state_flags = CachedStateFlags::of_u32(state_flags);
    let phys_address = virt_eip as u32 & 0xFFF | phys_eip & !0xFFF;

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

            match analysis.ty {
                AnalysisType::Normal | AnalysisType::STI => {
                    dbg_assert!(has_next_instruction);

                    if current_block.has_sti {
                        // Convert next instruction after STI (i.e., the current instruction) into block boundary
                        marked_as_entry.insert(current_address as u16 & 0xFFF);
                        to_visit_stack.push(current_address as u16 & 0xFFF);

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
            .filter(|(_, previous_block)| (!previous_block.has_sti))
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

#[no_mangle]
#[cfg(debug_assertions)]
pub fn jit_force_generate_unsafe(phys_addr: u32) {
    let ctx = get_jit_state();
    record_entry_point(phys_addr);
    let cs_offset = cpu::get_seg_cs() as u32;
    let state_flags = cpu::pack_current_state_flags();
    jit_analyze_and_generate(ctx, Page::page_of(phys_addr), cs_offset, state_flags);
}

#[inline(never)]
fn jit_analyze_and_generate(
    ctx: &mut JitState,
    page: Page,
    cs_offset: u32,
    state_flags: CachedStateFlags,
) {
    if ctx.page_has_pending_code.contains_key(&page) {
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

        jit_generate_module(
            &basic_blocks,
            requires_loop_limit,
            cpu.clone(),
            &mut ctx.wasm_builder,
            wasm_table_index,
            state_flags,
        );

        profiler::stat_increment_by(
            stat::COMPILE_WASM_TOTAL_BYTES,
            ctx.wasm_builder.get_output_len() as u64,
        );

        cpu::tlb_set_has_code(page, true);

        let previous_state = ctx.page_has_pending_code.insert(
            page,
            (wasm_table_index, PageState::Compiling { basic_blocks }),
        );
        dbg_assert!(previous_state.is_none());

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
        //dbg_log("No basic blocks, not generating code");
        // Nothing to do
    }
}

#[no_mangle]
pub fn codegen_finalize_finished(
    wasm_table_index: u16,
    phys_addr: u32,
    state_flags: CachedStateFlags,
) {
    let ctx = get_jit_state();

    dbg_assert!(wasm_table_index != 0);

    let page = Page::page_of(phys_addr);

    let basic_blocks = match ctx.page_has_pending_code.remove(&page) {
        None => {
            dbg_assert!(false);
            return;
        },
        Some((in_progress_wasm_table_index, PageState::CompilingWritten)) => {
            dbg_assert!(wasm_table_index == in_progress_wasm_table_index);
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

        if block.is_entry_block && block.addr != block.end_addr {
            dbg_assert!(block.addr != 0);

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

            let old_entry = ctx.cache.insert(block.addr, entry);

            if let Some(old_entry) = old_entry {
                check_for_unused_wasm_table_index.insert(old_entry.wasm_table_index);
            }

            entry_point_count += 1;
            profiler::stat_increment(stat::COMPILE_ENTRY_POINT);
        }
    }

    dbg_assert!(entry_point_count > 0);

    for (_, entry) in ctx.cache.range(page.address_range()) {
        check_for_unused_wasm_table_index.remove(&entry.wasm_table_index);
    }

    for index in check_for_unused_wasm_table_index {
        free_wasm_table_index(ctx, index);
    }
}

fn jit_generate_module(
    basic_blocks: &Vec<BasicBlock>,
    requires_loop_limit: bool,
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
    let gen_local_iteration_counter = if JIT_ALWAYS_USE_LOOP_SAFETY || requires_loop_limit {
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
                _ => {},
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
    jit_clear_func(wasm_table_index);
}

/// Register a write in this page: Delete all present code
pub fn jit_dirty_page(ctx: &mut JitState, page: Page) {
    let mut did_have_code = false;

    let entries: Vec<u32> = ctx
        .cache
        .range(page.address_range())
        .map(|(i, _)| *i)
        .collect();

    let mut index_to_free = HashSet::new();

    for phys_addr in entries {
        let entry = ctx.cache.remove(&phys_addr).unwrap();
        did_have_code = true;
        index_to_free.insert(entry.wasm_table_index);
    }

    for index in index_to_free {
        free_wasm_table_index(ctx, index)
    }

    match ctx.entry_points.remove(&page) {
        None => {},
        Some(_entry_points) => {
            did_have_code = true;

            // don't try to compile code in this page anymore until it's hot again
            ctx.hot_pages[jit_hot_hash_page(page) as usize] = 0;
        },
    }

    match ctx.page_has_pending_code.get(&page) {
        None => {},
        Some((_, PageState::CompilingWritten)) => {},
        Some((wasm_table_index, PageState::Compiling { .. })) => {
            let wasm_table_index = *wasm_table_index;
            did_have_code = true;
            ctx.page_has_pending_code
                .insert(page, (wasm_table_index, PageState::CompilingWritten));
        },
    }

    dbg_assert!(!jit_page_has_code(page));

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
    let mut pages_with_code = HashSet::new();

    for page in ctx.entry_points.keys() {
        pages_with_code.insert(*page);
    }
    for addr in ctx.cache.keys() {
        pages_with_code.insert(Page::page_of(*addr));
    }
    for page in ctx.page_has_pending_code.keys() {
        pages_with_code.insert(*page);
    }

    for page in pages_with_code {
        jit_dirty_page(ctx, page);
    }
}

pub fn jit_page_has_code(page: Page) -> bool {
    let ctx = get_jit_state();
    let mut entries = ctx.cache.range(page.address_range());
    // Does the page have compiled code
    entries.next().is_some() ||
    // Or are there any entry points that need to be removed on write to the page
    // (this function is used to mark the has_code bit in the tlb to optimise away calls jit_dirty_page)
    ctx.entry_points.contains_key(&page) ||
    match ctx.page_has_pending_code.get(&page) { Some(&(_, PageState::Compiling { .. })) => true, _ => false }
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

            let last_jump_type = unsafe { cpu::debug_last_jump.name() };
            let last_jump_addr = unsafe { cpu::debug_last_jump.phys_address() }.unwrap_or(0);
            let last_jump_opcode =
                if last_jump_addr != 0 { memory::read32s(last_jump_addr) } else { 0 };

            let opcode = memory::read32s(phys_address);
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
