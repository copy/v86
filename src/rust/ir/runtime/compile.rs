//! Immutable experimental compiler entry. Deliberately separate from the live JIT cache.
use super::diagnostics::CompileScope;
use super::entry::{CpuEntryKey, EntryContract};
use crate::ir::{
    backend::wasm::{
        emit, emit_cpu_entry, emit_cpu_fused_entry, emit_cpu_page_entry, emit_cpu_shared_entry,
        Artifact, StateLayout,
    },
    frontend::{
        decode::{decode, Flow, GuestEip, LinearAddress, PhysicalAddress},
        lift::{lift, lift_cpu_with_rep_budget},
        region::{
            lift_cpu_cfg, lift_cpu_cfg_entries, lift_cpu_cfg_page, lift_cpu_cfg_sources, CfgLimits,
            CfgSource, PredictedEdge,
        },
    },
    lowering::{lower_limited, CompileError},
    passes::{licm, run, PassConfig, PassStats},
};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Tier {
    One,
    Two,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodeDependency {
    pub page: PhysicalAddress,
    pub version: u64,
}
#[derive(Clone, Debug)]
pub struct ImmutableCodeSnapshot {
    pub bytes: Vec<u8>,
    pub dependencies: Vec<CodeDependency>,
    pub mappings: Vec<CodeMapping>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CodeMapping {
    pub linear: LinearAddress,
    pub physical: PhysicalAddress,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PublicationKey {
    pub job: u64,
    pub vm_generation: u64,
    pub slot: u32,
    pub slot_generation: u64,
}
pub struct CompileRequest {
    pub key: PublicationKey,
    pub pc: GuestEip,
    pub linear: LinearAddress,
    pub default_32: bool,
    pub tier: Tier,
}
impl CompileRequest {
    pub fn cpu_entry(&self) -> CpuEntryKey {
        CpuEntryKey {
            pc: self.pc,
            linear: self.linear,
            default_32: self.default_32,
        }
    }
}
pub struct IrConfig {
    pub optimize: bool,
    pub passes: PassConfig,
    pub execution_budget: u32,
    /// Maximum REP elements per cold entry (0..=4096), distinct from block work.
    pub rep_iteration_budget: u32,
    pub max_code_bytes: usize,
    pub layout: StateLayout,
}
pub struct CompiledArtifact {
    pub key: PublicationKey,
    pub tier: Tier,
    pub dependencies: Vec<CodeDependency>,
    pub code: Artifact,
    pub passes: PassStats,
    pub mir_folds: usize,
    pub guest_bytes: usize,
    pub entry: EntryContract,
    pub mappings: Vec<CodeMapping>,
    /// Additional noncontiguous immutable sources sharing this SSA activation.
    pub fused_sources: Vec<CapturedRegion>,
    pub fused_edges: Vec<PredictedEdge>,
    /// Exact alternative PCs sharing this function, snapshot and table owner.
    pub alternate_entries: Vec<CpuEntryKey>,
    /// Linear address of the first snapshot byte when it is not the primary
    /// entry (page artifacts cover a whole code page from its base).
    pub source_origin: Option<LinearAddress>,
}
#[derive(Clone, Debug)]
pub struct CapturedRegion {
    pub entry: CpuEntryKey,
    pub source: ImmutableCodeSnapshot,
}
impl CompiledArtifact {
    pub fn cpu_entries(&self) -> impl Iterator<Item = CpuEntryKey> + '_ {
        let primary = match self.entry {
            EntryContract::Cpu(entry) => Some(entry),
            _ => None,
        };
        primary
            .into_iter()
            .chain(self.alternate_entries.iter().copied())
    }
    pub fn accepts_entry(&self, entry: CpuEntryKey) -> bool {
        self.cpu_entries().any(|key| key == entry)
    }
    /// Linear address of the first byte of the primary immutable snapshot.
    pub fn source_linear(&self) -> Option<u32> {
        match (self.source_origin, self.entry) {
            (Some(origin), _) => Some(origin.0),
            (None, EntryContract::Cpu(entry)) => Some(entry.linear.0),
            (None, EntryContract::Standalone) => None,
        }
    }
    /// Must run before installing a table slot; equality includes dependency versions and reset generation.
    /// This is a compiler-side check, not yet the production JS publication protocol.
    pub fn current(
        &self,
        key: PublicationKey,
        dependencies: &[CodeDependency],
        entry: EntryContract,
        mappings: &[CodeMapping],
    ) -> bool {
        self.key == key
            && self.dependencies == dependencies
            && self.entry == entry
            && self.mappings == mappings
    }
}
pub fn compile_region(
    request: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    config: &IrConfig,
) -> Result<CompiledArtifact, CompileError> {
    compile_inner(request, snapshot, config, false, false)
}
/// Compile a cold CPU-entry artifact. Publication/cache installation is still separate.
pub fn compile_cpu_region(
    request: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    config: &IrConfig,
) -> Result<CompiledArtifact, CompileError> {
    compile_inner(request, snapshot, config, true, false)
}
/// Compile reachable direct control flow, with bounded execution and SSA loop state.
/// The snapshot and publication validation contract is identical to the linear API.
pub fn compile_cpu_cfg_region(
    request: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    config: &IrConfig,
) -> Result<CompiledArtifact, CompileError> {
    compile_inner(request, snapshot, config, true, true)
}

/// Automatic compilation can encounter a graph budget before the decoder's
/// instruction budget (one x86 instruction may introduce several blocks).
/// Retry smaller, instruction-aligned prefixes of the same immutable snapshot.
/// Explicit compilation retains its all-or-error contract above.
pub fn compile_cpu_cfg_bounded(
    request: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    config: &IrConfig,
) -> Result<(CompiledArtifact, ImmutableCodeSnapshot, u32), CompileError> {
    validate_snapshot(request, snapshot, config)?;
    let mut selected = snapshot.clone();
    for retries in 0..8 {
        // A linear window, including its final external transfer/helper, already
        // has a single-entry lifter. Only actual internal edges require CFG SSA.
        // Building one fragment/parameter frame per instruction only to merge
        // them again costs most of cold compilation and can hit the CFG cap.
        let compiled = if linear_candidate(request, &selected.bytes) {
            match compile_cpu_region(request, &selected, config) {
                // Some decoder fallthrough forms use a terminal CPU adapter.
                // Preserve the CFG frontend's ability to stop before the tail.
                Err(CompileError::Unsupported(_)) => {
                    compile_cpu_cfg_region(request, &selected, config)
                },
                result => result,
            }
        }
        else {
            compile_cpu_cfg_region(request, &selected, config)
        };
        match compiled {
            Ok(artifact) => return Ok((artifact, selected, retries)),
            Err(error @ CompileError::Budget(_)) if retries < 7 => {
                let length = super::region::reachable_length(
                    &selected.bytes,
                    request.pc,
                    request.linear,
                    request.default_32,
                    super::region::Policy {
                        max_bytes: selected.bytes.len() / 2,
                        max_instructions: 128,
                    },
                );
                if length == 0 || length >= selected.bytes.len() {
                    return Err(error);
                }
                selected.bytes.truncate(length);
                let pages = ((request.linear.0 & 4095) as usize + length + 4095) / 4096;
                selected.mappings.truncate(pages);
                selected.dependencies.retain(|d| {
                    selected
                        .mappings
                        .iter()
                        .any(|mapping| mapping.physical == d.page)
                });
            },
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

fn linear_candidate(request: &CompileRequest, bytes: &[u8]) -> bool {
    let mut offset = 0;
    while offset < bytes.len() {
        let Ok(instruction) = decode(
            &bytes[offset..],
            GuestEip(request.pc.0.wrapping_add(offset as u32)),
            LinearAddress(request.linear.0.wrapping_add(offset as u32)),
            request.default_32,
        )
        else {
            return false;
        };
        // The shared decoder marks ordinary memory operands as Boundary.
        // As in region selection, only an actual encoding block boundary
        // terminates fallthrough; mode-changing instructions stay on CFG.
        if !matches!(instruction.flow, Flow::Next | Flow::Boundary)
            || instruction.encoding.block_boundary
        {
            if offset + instruction.length as usize != bytes.len() {
                return false;
            }
            return match instruction.flow {
                Flow::Relative {
                    displacement,
                    call: false,
                    ..
                } => {
                    let target = instruction.next_pc.0.wrapping_add(displacement as u32);
                    let target =
                        if instruction.operand_size == 16 { target & 65535 } else { target };
                    target.wrapping_sub(request.pc.0) as usize >= bytes.len()
                },
                Flow::Sti => false, // the shadow is a compound CFG fragment
                _ => true,
            };
        }
        offset += instruction.length as usize;
    }
    offset == bytes.len()
}
fn compile_inner(
    request: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    config: &IrConfig,
    cpu: bool,
    cfg: bool,
) -> Result<CompiledArtifact, CompileError> {
    let _context = super::diagnostics::CompileContext::classified(
        request.linear.0,
        if request.tier == Tier::One { 1 } else { 2 },
        1,
        0,
    );
    validate_snapshot(request, snapshot, config)?;
    let lift_clock = CompileScope::new(2);
    let region = if cfg {
        lift_cpu_cfg(
            &snapshot.bytes,
            request.pc,
            request.linear,
            request.default_32,
            config.rep_iteration_budget,
        )?
    }
    else if cpu {
        lift_cpu_with_rep_budget(
            &snapshot.bytes,
            request.pc,
            request.linear,
            request.default_32,
            config.rep_iteration_budget,
        )?
    }
    else {
        lift(
            &snapshot.bytes,
            request.pc,
            request.linear,
            request.default_32,
        )?
    };
    drop(lift_clock);
    compile_lifted(request, snapshot, config, cpu, region, vec![], vec![], None)
}
pub fn compile_cpu_fused(
    request: &CompileRequest,
    primary: &ImmutableCodeSnapshot,
    secondary: &CapturedRegion,
    predictions: &[PredictedEdge],
    config: &IrConfig,
) -> Result<CompiledArtifact, CompileError> {
    compile_cpu_fused_regions(
        request,
        primary,
        std::slice::from_ref(secondary),
        predictions,
        config,
    )
}
/// Extend only witnessed hot traces, under the same instruction/allocation budgets.
pub fn compile_cpu_fused_regions(
    request: &CompileRequest,
    primary: &ImmutableCodeSnapshot,
    peers: &[CapturedRegion],
    predictions: &[PredictedEdge],
    config: &IrConfig,
) -> Result<CompiledArtifact, CompileError> {
    let _context = super::diagnostics::CompileContext::classified(request.linear.0, 2, 3, 0);
    if peers.is_empty() || peers.len() > 3 || predictions.len() > 4 {
        return Err(CompileError::Budget("fused source count"));
    }
    if request.tier != Tier::Two
        || peers.iter().any(|p| {
            p.entry.default_32 != request.default_32
                || p.entry.cs_base() != request.cpu_entry().cs_base()
        })
    {
        return Err(CompileError::Unsupported("incompatible fused CPU entries"));
    }
    validate_snapshot(request, primary, config)?;
    let mut mappings = primary.mappings.clone();
    let mut sources = vec![CfgSource {
        bytes: &primary.bytes,
        pc: request.pc,
        linear: request.linear,
    }];
    for peer in peers {
        let peer_request = CompileRequest {
            key: request.key,
            pc: peer.entry.pc,
            linear: peer.entry.linear,
            default_32: request.default_32,
            tier: Tier::Two,
        };
        validate_snapshot(&peer_request, &peer.source, config)?;
        for mapping in &peer.source.mappings {
            if mappings
                .iter()
                .any(|m| m.linear == mapping.linear && m.physical != mapping.physical)
            {
                return Err(CompileError::InvalidIr(
                    "conflicting fused code mapping".into(),
                ));
            }
            mappings.push(*mapping);
        }
        sources.push(CfgSource {
            bytes: &peer.source.bytes,
            pc: peer.entry.pc,
            linear: peer.entry.linear,
        });
    }
    let lift_clock = CompileScope::new(2);
    let region = lift_cpu_cfg_sources(
        &sources,
        predictions,
        request.default_32,
        config.rep_iteration_budget,
    )?;
    // Extend only audited observer contracts. Interrupt-shadow, memory and host
    // callback helpers still require a stronger continuation certificate.
    if peers.len() > 1
        && region.instructions.iter().any(|inst| {
            let crate::ir::hir::Op::CallHelper(id) = inst.op
            else {
                return false;
            };
            let helper = &region.helpers[id.index()];
            !(crate::ir::helper::cpu_registry::preserves_code_on_success(&helper.name)
                || crate::ir::helper::cpu_registry::checked_scalar_continuation(&helper.name)
                || helper.name == "ir_sti_finish_continue"
                || helper.effects.is_pure()
                || matches!(
                    helper.name.as_str(),
                    "ir_sse_fp_reg_continue" | "ir_avx_fp_reg_continue"
                ) && crate::ir::helper::cpu_registry::xmm_register_operands(&region, &inst.args)
                    .is_some())
        })
    {
        return Err(CompileError::Unsupported(
            "extended fusion observer boundary",
        ));
    }
    for peer in peers {
        if !region.states.iter().any(|s| {
            s.instruction_pc.0.wrapping_sub(peer.entry.pc.0) < peer.source.bytes.len() as u32
        }) {
            return Err(CompileError::Unsupported("unreachable fused peer"));
        }
    }
    drop(lift_clock);
    let mut artifact = compile_lifted(
        request,
        primary,
        config,
        true,
        region,
        peers.to_vec(),
        vec![],
        None,
    )?;
    artifact.fused_edges = predictions.to_vec();
    Ok(artifact)
}

fn compile_lifted(
    request: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    config: &IrConfig,
    cpu: bool,
    mut region: crate::ir::hir::Region,
    fused_sources: Vec<CapturedRegion>,
    alternate_entries: Vec<CpuEntryKey>,
    // Some(origin): a page artifact whose snapshot starts at `origin`.
    page: Option<LinearAddress>,
) -> Result<CompiledArtifact, CompileError> {
    let mut limits = if page.is_some() { CfgLimits::PAGE } else { CfgLimits::REGION };
    // Only fused artifacts check the continuation epoch at instruction polls.
    // Elsewhere a poll merely bounds work, which the acyclic graph already
    // does: charge the budget at loop headers and drop per-instruction exits.
    limits.sparse_polls |= config.optimize
        && config.passes.rounds != 0
        && fused_sources.is_empty()
        && config.passes.enabled(PassConfig::SPARSE_POLLS);
    let _context = super::diagnostics::CompileContext::classified(
        request.linear.0,
        if request.tier == Tier::One { 1 } else { 2 },
        if !fused_sources.is_empty() {
            3
        }
        else if !alternate_entries.is_empty() {
            2
        }
        else {
            1
        },
        if region.blocks.len() == 1 { 1 } else { 2 },
    );
    let mut dependencies = snapshot.dependencies.clone();
    for peer in &fused_sources {
        for dependency in &peer.source.dependencies {
            if let Some(old) = dependencies.iter().find(|d| d.page == dependency.page) {
                if old.version != dependency.version {
                    return Err(CompileError::InvalidIr(
                        "conflicting fused code version".into(),
                    ));
                }
            }
            else {
                dependencies.push(dependency.clone());
            }
        }
    }
    if dependencies.len() > 8 {
        return Err(CompileError::Budget("fused code dependencies"));
    }
    let pass_clock = CompileScope::new(3);
    let mut passes = if config.optimize {
        run(&mut region, config.passes).map_err(CompileError::InvalidIr)?
    }
    else {
        PassStats::default()
    };
    // Cold Tier 1 never pays for loop discovery. The master optimization switch
    // and zero-round diagnostic configuration also disable code motion.
    if config.optimize
        && request.tier == Tier::Two
        && config.passes.rounds != 0
        && config.passes.enabled(9)
        && region.blocks.len() <= licm::MAX_BLOCKS
    {
        passes.loop_hoisted = licm::run(&mut region, licm::DEFAULT_WORK_LIMIT)
            .map_err(CompileError::InvalidIr)?
            .hoisted;
    }
    if page.is_some() {
        crate::ir::passes::strip_polls(&mut region);
    }
    else if limits.sparse_polls {
        limits.sparse_polls =
            crate::ir::passes::sparse_polls(&mut region, config.execution_budget).is_some();
    }
    let hir_dump =
        if config.passes.debug.hir() { crate::ir::dump::text(&region) } else { String::new() };

    drop(pass_clock);
    let lower_clock = CompileScope::new(4);
    let mut mir = lower_limited(&region, limits)?;
    drop(lower_clock);
    config.passes.debug.check(&mir, true)?;
    let machine_clock = CompileScope::new(5);
    drop(region);
    // Lowering already provides verified typed locals and legal value programs.
    // Tier 1 must not pay for a second machine optimization/allocation pipeline
    // on every newly hot block during OS startup.
    let optimize_machine = config.optimize && request.tier == Tier::Two;
    let mir_folds = if optimize_machine && config.passes.enabled(10) {
        let _clock = CompileScope::new(11);
        let n = mir.fold_constants()?;
        config.passes.debug.check(&mir, false)?;
        n
    }
    else {
        0
    };
    if optimize_machine {
        if config.passes.enabled(11) {
            let _clock = CompileScope::new(12);
            mir.schedule_operand_stack(262_144)?;
            config.passes.debug.check(&mir, false)?;
        }
        if config.passes.enabled(12) {
            let _clock = CompileScope::new(13);
            mir.allocate_machine_locals(4_000_000)?;
            config.passes.debug.check(&mir, false)?;
        }
    }
    if config.optimize && config.passes.rounds != 0 {
        if cpu {
            if config.passes.enabled(13) {
                let _clock = CompileScope::new(14);
                passes.state_writes_elided = if !config.passes.state_sync {
                    // Entry-equivalence only: lowering already proves
                    // unchanged entry backing without a dataflow pass.
                    mir.elide_entry_cpu_state_writes(
                        crate::ir::mir::state_elision::DEFAULT_WORK_LIMIT,
                    )?
                }
                else {
                    mir.elide_redundant_cpu_state_writes(
                        crate::ir::mir::state_elision::DEFAULT_WORK_LIMIT,
                    )?
                };
                config.passes.debug.check(&mir, false)?;
            }
            if request.tier == Tier::Two && config.passes.helper_state {
                {
                    let _clock = CompileScope::new(15);
                    passes.helper_states_elided = mir.elide_helper_state_observations(
                        crate::ir::mir::helper_state::DEFAULT_WORK_LIMIT,
                    )?;
                    config.passes.debug.check(&mir, false)?;
                }
            }
            if config.passes.flags && config.passes.enabled(5) {
                {
                    let _clock = CompileScope::new(16);
                    passes.cpu_values_elided = mir
                        .elide_dead_cpu_values(crate::ir::mir::cpu_liveness::DEFAULT_WORK_LIMIT)?;
                    config.passes.debug.check(&mir, false)?;
                }
            }
        }
    }
    if config.optimize && request.tier == Tier::Two && config.passes.rounds != 0 {
        // Loop certificates are installed first so ordinary forwarding can
        // derive a non-overlapping intra-block certificate around them.
        if config.passes.enabled(14) {
            let _clock = CompileScope::new(17);
            passes.ram_forwarded =
                mir.cache_loop_invariant_ram_reads(crate::ir::mir::forwarding::DEFAULT_WORK_LIMIT)?;
            config.passes.debug.check(&mir, false)?;
        }
        if config.passes.enabled(15) {
            let _clock = CompileScope::new(18);
            passes.ram_forwarded +=
                mir.forward_ram_reads(crate::ir::mir::forwarding::DEFAULT_WORK_LIMIT)?;
            config.passes.debug.check(&mir, false)?;
        }
        if config.passes.enabled(16) {
            let _clock = CompileScope::new(19);
            passes.ram_guards_reused =
                mir.reuse_ram_guards(crate::ir::mir::forwarding::DEFAULT_WORK_LIMIT)?;
            config.passes.debug.check(&mir, false)?;
        }
    }
    if optimize_machine && cpu && config.passes.enabled(17) {
        passes.budget_batches =
            mir.batch_pure_budget_polls(crate::ir::mir::budget::DEFAULT_WORK_LIMIT)?;
        config.passes.debug.check(&mir, false)?;
    }
    config.passes.debug.check(&mir, true)?;
    let mir_dump =
        if config.passes.debug.mir() { crate::ir::dump::mir(&mir) } else { String::new() };
    drop(machine_clock);
    let _emit_clock = CompileScope::new(6);
    let code = if cpu {
        let code_pages: Vec<u32> = dependencies.iter().map(|d| d.page.0).collect();
        if page.is_some() {
            emit_cpu_page_entry(
                &mir,
                config.execution_budget,
                request.cpu_entry(),
                &alternate_entries,
                &code_pages,
            )?
        }
        else if alternate_entries.is_empty() {
            let emit_entry =
                if fused_sources.is_empty() { emit_cpu_entry } else { emit_cpu_fused_entry };
            emit_entry(
                &mir,
                config.execution_budget,
                request.cpu_entry(),
                &code_pages,
            )?
        }
        else {
            emit_cpu_shared_entry(
                &mir,
                config.execution_budget,
                request.cpu_entry(),
                &alternate_entries,
                &code_pages,
                !fused_sources.is_empty(),
            )?
        }
    }
    else {
        emit(&mir, config.layout, config.execution_budget)?
    };
    if config.passes.debug.dump != crate::ir::debug::DumpMode::Off {
        crate::ir::debug::record(
            request.linear.0,
            if request.tier == Tier::One { 1 } else { 2 },
            hir_dump,
            mir_dump,
            if config.passes.debug.wasm() { &code.bytes } else { &[] },
        );
    }
    Ok(CompiledArtifact {
        key: request.key,
        tier: request.tier,
        dependencies,
        code,
        passes,
        mir_folds,
        guest_bytes: snapshot.bytes.len()
            + fused_sources
                .iter()
                .map(|s| s.source.bytes.len())
                .sum::<usize>(),
        mappings: snapshot.mappings.clone(),
        entry: if cpu {
            EntryContract::Cpu(request.cpu_entry())
        }
        else {
            EntryContract::Standalone
        },
        fused_sources,
        fused_edges: vec![],
        alternate_entries,
        source_origin: page,
    })
}

fn validate_snapshot(
    request: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    config: &IrConfig,
) -> Result<(), CompileError> {
    if snapshot.bytes.len() > config.max_code_bytes || snapshot.bytes.len() > 15 * 128 {
        return Err(CompileError::Budget("code snapshot"));
    }
    let max_pages = if request.tier == Tier::One { 2 } else { 8 };
    if snapshot.dependencies.is_empty() || snapshot.dependencies.len() > max_pages {
        return Err(CompileError::Budget("code dependencies"));
    }
    for (i, dependency) in snapshot.dependencies.iter().enumerate() {
        if dependency.page.0 & 4095 != 0
            || snapshot.dependencies[..i]
                .iter()
                .any(|p| p.page == dependency.page)
        {
            return Err(CompileError::InvalidIr(
                "invalid or duplicate physical code page".into(),
            ));
        }
    }
    let needed_pages = ((request.linear.0 & 4095) as usize + snapshot.bytes.len() + 4095) / 4096;
    if snapshot.mappings.len() != needed_pages || needed_pages > max_pages {
        return Err(CompileError::InvalidIr(
            "incomplete code mapping snapshot".into(),
        ));
    }
    for (index, mapping) in snapshot.mappings.iter().enumerate() {
        let expected = (request.linear.0 & !4095).wrapping_add(index as u32 * 4096);
        if mapping.linear.0 != expected
            || mapping.physical.0 & 4095 != 0
            || !snapshot
                .dependencies
                .iter()
                .any(|d| d.page == mapping.physical)
        {
            return Err(CompileError::InvalidIr("invalid code page mapping".into()));
        }
    }
    if snapshot
        .dependencies
        .iter()
        .any(|d| !snapshot.mappings.iter().any(|m| m.physical == d.page))
    {
        return Err(CompileError::InvalidIr("unused code dependency".into()));
    }
    Ok(())
}

/// A shared immutable snapshot may have several (even overlapping x86) entries.
/// Split it into separately guarded cold artifacts; never admit an unchecked
/// initial-state selector into the CPU ABI. Return no artifacts if any entry fails.
#[derive(Clone, Copy, Debug)]
pub struct CpuEntryRequest {
    pub offset: usize,
    pub key: PublicationKey,
}
pub fn compile_cpu_entries(
    origin: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    entries: &[CpuEntryRequest],
    config: &IrConfig,
) -> Result<Vec<CompiledArtifact>, CompileError> {
    Ok(
        compile_entry_batch(origin, snapshot, entries, config, false, false)?
            .into_iter()
            .map(|(artifact, _, _)| artifact)
            .collect(),
    )
}
/// Compile one shared graph/code body, not one suffix module per entry.
/// Overlapping instruction streams are deliberately declined by CFG formation;
/// the caller may retain the existing independently guarded fallback artifacts.
pub fn compile_cpu_shared_entries(
    origin: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    entries: &[CpuEntryRequest],
    config: &IrConfig,
) -> Result<CompiledArtifact, CompileError> {
    let _context = super::diagnostics::CompileContext::classified(
        origin.linear.0,
        if origin.tier == Tier::One { 1 } else { 2 },
        2,
        0,
    );
    validate_snapshot(origin, snapshot, config)?;
    if entries.is_empty() || entries.len() > 8 {
        return Err(CompileError::Budget("CPU entry batch"));
    }
    if entries[0].offset != 0 || entries[0].key != origin.key {
        return Err(CompileError::InvalidIr(
            "shared entry origin mismatch".into(),
        ));
    }
    for (i, entry) in entries.iter().enumerate() {
        if entry.offset >= snapshot.bytes.len()
            || entry.key.vm_generation != origin.key.vm_generation
            || entries[..i].iter().any(|old| {
                old.offset == entry.offset
                    || old.key.job == entry.key.job
                    || entry.key.slot != 0 && old.key.slot == entry.key.slot
            })
        {
            return Err(CompileError::InvalidIr(
                "invalid shared entry identity".into(),
            ));
        }
    }
    let keys: Vec<_> = entries
        .iter()
        .map(|entry| CpuEntryKey {
            pc: GuestEip(origin.pc.0.wrapping_add(entry.offset as u32)),
            linear: LinearAddress(origin.linear.0.wrapping_add(entry.offset as u32)),
            default_32: origin.default_32,
        })
        .collect();
    let lift_clock = CompileScope::new(2);
    let region = lift_cpu_cfg_entries(
        &[CfgSource {
            bytes: &snapshot.bytes,
            pc: origin.pc,
            linear: origin.linear,
        }],
        &[],
        &keys.iter().map(|key| key.pc).collect::<Vec<_>>(),
        origin.default_32,
        config.rep_iteration_budget,
    )?;
    drop(lift_clock);
    compile_lifted(
        origin,
        snapshot,
        config,
        true,
        region,
        vec![],
        keys[1..].to_vec(),
        None,
    )
}
/// Page-granular compilation: every instruction of one code page reachable
/// from its observed external entries, in one function with one table owner.
/// `snapshot` starts at the page base (`origin.linear & !4095`) and may extend
/// at most 16 bytes into the next page for a straddling final instruction.
/// Unsupported/undecodable instructions become interpreter exits; entries the
/// graph cannot serve are dropped. The first served entry is the primary one.
pub fn compile_cpu_page(
    origin: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    entries: &[CpuEntryKey],
    config: &IrConfig,
) -> Result<CompiledArtifact, CompileError> {
    let base = LinearAddress(origin.linear.0 & !4095);
    let base_pc = GuestEip(origin.pc.0.wrapping_sub(origin.linear.0 & 4095));
    if snapshot.bytes.len() < 4096 || snapshot.bytes.len() > CfgLimits::PAGE.source_bytes {
        return Err(CompileError::Budget("page snapshot"));
    }
    let pages = if snapshot.bytes.len() > 4096 { 2 } else { 1 };
    if snapshot.mappings.len() != pages
        || snapshot.dependencies.is_empty()
        || snapshot.dependencies.len() > pages
        || snapshot.mappings.iter().enumerate().any(|(i, m)| {
            m.linear.0 != base.0.wrapping_add(i as u32 * 4096) || m.physical.0 & 4095 != 0
        })
        || snapshot
            .dependencies
            .iter()
            .any(|d| !snapshot.mappings.iter().any(|m| m.physical == d.page))
    {
        return Err(CompileError::InvalidIr("invalid page snapshot".into()));
    }
    if entries.is_empty()
        || entries.len() > CfgLimits::PAGE.entries
        || entries.iter().enumerate().any(|(i, e)| {
            e.linear.0 & !4095 != base.0
                || e.cs_base() != origin.cpu_entry().cs_base()
                || e.default_32 != origin.default_32
                || entries[..i].contains(e)
        })
    {
        return Err(CompileError::InvalidIr("invalid page entries".into()));
    }
    let _context = super::diagnostics::CompileContext::classified(
        origin.linear.0,
        if origin.tier == Tier::One { 1 } else { 2 },
        2,
        0,
    );
    let lift_clock = CompileScope::new(2);
    let (region, served) = lift_cpu_cfg_page(
        CfgSource {
            bytes: &snapshot.bytes,
            pc: base_pc,
            linear: base,
        },
        &entries.iter().map(|e| e.pc).collect::<Vec<_>>(),
        origin.default_32,
        config.rep_iteration_budget,
        CfgLimits::PAGE,
    )?;
    drop(lift_clock);
    let keys: Vec<CpuEntryKey> = served
        .iter()
        .map(|pc| *entries.iter().find(|e| e.pc == *pc).unwrap())
        .collect();
    let request = CompileRequest {
        key: origin.key,
        pc: keys[0].pc,
        linear: keys[0].linear,
        default_32: origin.default_32,
        tier: origin.tier,
    };
    compile_lifted(
        &request,
        snapshot,
        config,
        true,
        region,
        vec![],
        keys[1..].to_vec(),
        Some(base),
    )
}
/// Automatic multi-entry work shares one immutable capture; each entry may
/// shrink independently at a graph budget. No partial batch escapes on error.
pub fn compile_cpu_entries_bounded(
    origin: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    entries: &[CpuEntryRequest],
    config: &IrConfig,
) -> Result<Vec<(CompiledArtifact, ImmutableCodeSnapshot, u32)>, CompileError> {
    compile_entry_batch(origin, snapshot, entries, config, true, false)
}
/// Online siblings are opportunistic. Preserve an already compiled primary if a
/// sibling cannot lower, instead of discarding it and compiling it a second time.
/// Batch identity validation remains atomic; explicit callers retain strict APIs.
pub fn compile_cpu_entries_available(
    origin: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    entries: &[CpuEntryRequest],
    config: &IrConfig,
) -> Result<Vec<(CompiledArtifact, ImmutableCodeSnapshot, u32)>, CompileError> {
    compile_entry_batch(origin, snapshot, entries, config, true, true)
}
fn compile_entry_batch(
    origin: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    entries: &[CpuEntryRequest],
    config: &IrConfig,
    bounded: bool,
    tolerate_siblings: bool,
) -> Result<Vec<(CompiledArtifact, ImmutableCodeSnapshot, u32)>, CompileError> {
    validate_snapshot(origin, snapshot, config)?;
    if entries.is_empty() || entries.len() > 8 {
        return Err(CompileError::Budget("CPU entry batch"));
    }
    for (i, entry) in entries.iter().enumerate() {
        if entry.offset >= snapshot.bytes.len()
            || entry.key.vm_generation != origin.key.vm_generation
            || entries[..i].iter().any(|e| {
                e.offset == entry.offset
                    || (entry.key.slot != 0 && e.key.slot == entry.key.slot)
                    || e.key.job == entry.key.job
            })
        {
            return Err(CompileError::InvalidIr(
                "invalid CPU entry batch identity".into(),
            ));
        }
    }
    let mut artifacts = Vec::with_capacity(entries.len());
    for entry in entries {
        let request = CompileRequest {
            key: entry.key,
            pc: GuestEip(origin.pc.0.wrapping_add(entry.offset as u32)),
            linear: LinearAddress(origin.linear.0.wrapping_add(entry.offset as u32)),
            default_32: origin.default_32,
            tier: origin.tier,
        };
        let first = ((origin.linear.0 & 4095) as usize + entry.offset) / 4096;
        let mappings = snapshot.mappings[first..].to_vec();
        let dependencies = snapshot
            .dependencies
            .iter()
            .filter(|d| mappings.iter().any(|m| m.physical == d.page))
            .cloned()
            .collect();
        let source = ImmutableCodeSnapshot {
            bytes: snapshot.bytes[entry.offset..].to_vec(),
            mappings,
            dependencies,
        };
        let compiled = if bounded {
            compile_cpu_cfg_bounded(&request, &source, config)
        }
        else {
            compile_cpu_cfg_region(&request, &source, config).map(|artifact| (artifact, source, 0))
        };
        match compiled {
            Ok(artifact) => artifacts.push(artifact),
            Err(_) if tolerate_siblings && !artifacts.is_empty() => {},
            Err(error) => return Err(error),
        }
    }
    Ok(artifacts)
}

#[cfg(test)]
mod cold_tests {
    use super::*;
    fn request() -> CompileRequest {
        CompileRequest {
            key: PublicationKey {
                job: 1,
                vm_generation: 1,
                slot: 0,
                slot_generation: 0,
            },
            pc: GuestEip(0x100000),
            linear: LinearAddress(0x100000),
            default_32: true,
            tier: Tier::One,
        }
    }
    #[test]
    fn linear_external_edges_and_helpers_keep_internal_branches_on_cfg() {
        let r = request();
        for bytes in [
            &[0x40, 0xFF, 0xE2][..],
            &[0x40, 0xE4, 0x80],
            &[0x40, 0x0F, 0x31],
            &[0x40, 0xF4],
            &[0x40, 0x75, 0x20],
            &[0x40, 0xEB, 0x20],
        ] {
            assert!(linear_candidate(&r, bytes), "{bytes:x?}");
        }
        for bytes in [
            &[0x40, 0x75, 0xFD][..],
            &[0x40, 0xEB, 0xFD],
            &[0xFB, 0x90],
            &[0xEB, 0x02, 0x40, 0x40, 0xF4],
        ] {
            assert!(!linear_candidate(&r, bytes), "{bytes:x?}");
        }
    }
    #[test]
    fn failed_sibling_keeps_primary_but_bad_batch_identity_is_atomic() {
        let r = request();
        let snapshot = ImmutableCodeSnapshot {
            bytes: vec![0xEB, 0xFE, 0x0F],
            mappings: vec![CodeMapping {
                linear: r.linear,
                physical: PhysicalAddress(r.linear.0),
            }],
            dependencies: vec![CodeDependency {
                page: PhysicalAddress(r.linear.0),
                version: 1,
            }],
        };
        let config = IrConfig {
            optimize: true,
            passes: crate::ir::passes::PassConfig::tier1(),
            execution_budget: 32,
            rep_iteration_budget: 8,
            max_code_bytes: 192,
            layout: StateLayout {
                gpr: 0,
                flags: 32,
                eip: 36,
                committed: 40,
                flag_operand: 44,
            },
        };
        let mut entries = [
            CpuEntryRequest {
                offset: 0,
                key: r.key,
            },
            CpuEntryRequest {
                offset: 2,
                key: PublicationKey { job: 2, ..r.key },
            },
        ];
        assert!(compile_cpu_entries_bounded(&r, &snapshot, &entries, &config).is_err());
        let artifacts = compile_cpu_entries_available(&r, &snapshot, &entries, &config).unwrap();
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].0.key, r.key);
        entries[1].key = r.key;
        assert!(compile_cpu_entries_available(&r, &snapshot, &entries, &config).is_err());
    }
}
