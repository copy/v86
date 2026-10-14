//! Reachable bytecode CFGs composed from the existing single-instruction lifter.
use super::{
    decode::{decode, DecodedInstruction, GuestEip, LinearAddress},
    integer::IntegerBuilder,
    lift::lift_cpu_with_rep_budget,
};
use crate::ir::{
    hir::*,
    ids::*,
    lowering::CompileError,
    state::{FlagState, ResumeKind, StateMap},
    types::Type,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone)]
struct Frame {
    gpr: [ValueId; 8],
    flags: FlagState,
    xmm: Vec<ValueId>,
    count: ValueId,
    effect: ValueId,
}
impl Frame {
    fn params(r: &mut Region, block: BlockId, xmm: bool) -> Self {
        Self {
            gpr: std::array::from_fn(|_| r.param(block, Type::I32)),
            flags: FlagState {
                arithmetic: std::array::from_fn(|_| r.param(block, Type::I1)),
                system: r.param(block, Type::I32),
                last_op1: Some(r.param(block, Type::I32)),
                raw_zero: Some(r.param(block, Type::I1)),
                zero_is_lazy: Some(r.param(block, Type::I1)),
                raw_flags: Some(r.param(block, Type::I32)),
                lazy_mask: Some(r.param(block, Type::I32)),
                last_result: Some(r.param(block, Type::I32)),
                last_op_size: Some(r.param(block, Type::I32)),
                backing_valid: Some(r.param(block, Type::I1)),
            },
            xmm: if xmm { (0..8).map(|_| r.param(block, Type::V128)).collect() } else { vec![] },
            count: r.param(block, Type::I32),
            effect: r.param(block, Type::Effect),
        }
    }
    fn args(&self) -> Vec<ValueId> {
        let mut args = self.gpr.to_vec();
        args.extend(self.flags.arithmetic);
        args.push(self.flags.system);
        args.push(self.flags.last_op1.unwrap());
        args.push(self.flags.raw_zero.unwrap());
        args.push(self.flags.zero_is_lazy.unwrap());
        args.push(self.flags.raw_flags.unwrap());
        args.push(self.flags.lazy_mask.unwrap());
        args.push(self.flags.last_result.unwrap());
        args.push(self.flags.last_op_size.unwrap());
        args.push(self.flags.backing_valid.unwrap());
        args.extend(&self.xmm);
        args.extend([self.count, self.effect]);
        args
    }
    fn recovery(&self, i: &DecodedInstruction) -> StateMap {
        StateMap {
            instruction_pc: i.instruction_pc,
            next_pc: i.next_pc,
            next_value: None,
            resume: ResumeKind::BeforeInstruction,
            gpr: self.gpr,
            flags: self.flags.clone(),
            xmm: self.xmm.clone(),
            x87: vec![],
            committed_instructions: 0,
            count_base: Some(self.count),
            rep_progress: None,
        }
    }
}
struct Fragment {
    decoded: DecodedInstruction,
    span: usize,
    ir: Region,
    stop: bool,
}
fn offset(pc: GuestEip, start: GuestEip, len: usize) -> Option<usize> {
    let n = pc.0.wrapping_sub(start.0) as usize;
    (n < len).then_some(n)
}
#[derive(Clone, Copy)]
pub struct CfgSource<'a> {
    pub bytes: &'a [u8],
    pub pc: GuestEip,
    pub linear: LinearAddress,
}
#[derive(Clone, Copy, Debug)]
pub struct PredictedEdge {
    pub from: GuestEip,
    pub target: GuestEip,
}
fn locate<'a>(sources: &'a [CfgSource<'a>], pc: GuestEip) -> Option<(CfgSource<'a>, usize)> {
    sources
        .iter()
        .find_map(|s| offset(pc, s.pc, s.bytes.len()).map(|at| (*s, at)))
}
fn successor(state: &StateMap, sources: &[CfgSource<'_>]) -> Option<usize> {
    (state.resume == ResumeKind::AfterInstruction && state.next_value.is_none())
        .then(|| locate(sources, state.next_pc).map(|_| state.next_pc.0 as usize))
        .flatten()
}
fn predicted(
    state: &StateMap,
    sources: &[CfgSource<'_>],
    edges: &[PredictedEdge],
) -> Option<usize> {
    if state.resume != ResumeKind::AfterInstruction || state.next_value.is_none() {
        return None;
    }
    edges
        .iter()
        .find(|e| e.from == state.instruction_pc && locate(sources, e.target).is_some())
        .map(|e| e.target.0 as usize)
}
/// A direct near CALL pushes a constant target (32-bit operand size only).
fn constant_target(ir: &Region, value: ValueId) -> Option<u32> {
    let Definition::Instruction(id, 0) = ir.values[value.index()].definition
    else {
        return None;
    };
    match ir.instructions[id.index()].op {
        Op::Const(target) if ir.values[value.index()].ty == Type::I32 => Some(target as u32),
        _ => None,
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Transfer {
    Other,
    Call,
    Return,
}
/// Classify a committed dynamic-target exit by re-decoding its own bytes.
/// Coalesced fragments end in the transfer, so the decoded leader cannot tell.
fn transfer_kind(state: &StateMap, sources: &[CfgSource<'_>], default_32: bool) -> Transfer {
    if state.resume != ResumeKind::AfterInstruction || state.next_value.is_none() {
        return Transfer::Other;
    }
    let Some((source, at)) = locate(sources, state.instruction_pc)
    else {
        return Transfer::Other;
    };
    let Ok(i) = decode(
        &source.bytes[at..],
        state.instruction_pc,
        LinearAddress(source.linear.0.wrapping_add(at as u32)),
        default_32,
    )
    else {
        return Transfer::Other;
    };
    match i.encoding.opcode {
        0xE8 => Transfer::Call,
        0xFF if i.modrm.is_some_and(|m| m >> 3 & 7 == 2) => Transfer::Call,
        0xC2 | 0xC3 => Transfer::Return,
        _ => Transfer::Other,
    }
}
/// Return sites a near RET in this graph may reach without leaving generated
/// code. Each remains a guarded candidate: any other popped target exits.
const RETURN_CANDIDATES: usize = 4;
/// Every in-graph successor of one exit. A static fallthrough is unguarded;
/// all dynamic candidates (profile prediction, direct CALL target, known
/// return sites for RET) keep an exact target comparison in `graft`.
fn exit_targets(
    ir: &Region,
    state: &StateMap,
    sources: &[CfgSource<'_>],
    predictions: &[PredictedEdge],
    default_32: bool,
    return_sites: &[usize],
) -> Vec<usize> {
    if let Some(next) = successor(state, sources) {
        return vec![next];
    }
    if state.resume != ResumeKind::AfterInstruction {
        return vec![];
    }
    let Some(value) = state.next_value
    else {
        return vec![];
    };
    let mut targets = vec![];
    if let Some(target) = predicted(state, sources, predictions) {
        targets.push(target);
    }
    if let Some(target) = constant_target(ir, value) {
        if locate(sources, GuestEip(target)).is_some() {
            targets.push(target as usize);
        }
    }
    if transfer_kind(state, sources, default_32) == Transfer::Return {
        targets.extend(return_sites.iter().take(RETURN_CANDIDATES));
    }
    let mut unique = vec![];
    for target in targets {
        if !unique.contains(&target) {
            unique.push(target);
        }
    }
    unique
}
/// The instruction after a direct near CALL whose callee is in the captured
/// code. After a far or indirect call the return site is only reachable from
/// the callee's own region, so it would be dead code here.
fn return_site(
    ir: &Region,
    state: &StateMap,
    sources: &[CfgSource<'_>],
    default_32: bool,
) -> Option<usize> {
    let callee = constant_target(ir, state.next_value?)?;
    (transfer_kind(state, sources, default_32) == Transfer::Call
        && locate(sources, GuestEip(callee)).is_some()
        && locate(sources, state.next_pc).is_some())
    .then_some(state.next_pc.0 as usize)
}
fn exit_states(ir: &Region) -> impl Iterator<Item = &StateMap> {
    ir.blocks
        .iter()
        .filter_map(move |block| match block.terminator {
            Some(Terminator::Exit(state)) => Some(&ir.states[state.index()]),
            _ => None,
        })
}
fn invalid(message: &'static str) -> CompileError { CompileError::Unsupported(message) }

/// Graph-size limits of one reachable CFG. REGION is the historical bounded
/// hot-window shape; PAGE covers every reachable instruction of one code page
/// from all of its observed external entries (the legacy JIT's granularity).
#[derive(Clone, Copy, Debug)]
pub struct CfgLimits {
    pub sources: usize,
    pub source_bytes: usize,
    pub entries: usize,
    pub fragments: usize,
    pub blocks: usize,
    pub instructions: usize,
    pub values: usize,
    /// Page mode: an undecodable, unsupported or overlapping reachable
    /// instruction (or discovery beyond the fragment budget) becomes an exit
    /// to the interpreter instead of rejecting the whole graph.
    pub tolerant: bool,
    /// Charge the execution budget only at loop headers instead of at every
    /// guest instruction (PollBudget). Acyclic code is bounded by the graph.
    pub sparse_polls: bool,
}
impl CfgLimits {
    pub const REGION: Self = Self {
        sources: 4,
        source_bytes: 15 * 128,
        entries: 8,
        fragments: 128,
        blocks: 64,
        instructions: 8192,
        values: 16384,
        tolerant: false,
        sparse_polls: false,
    };
    pub const PAGE: Self = Self {
        sources: 1,
        source_bytes: 4096 + 16,
        entries: 64,
        fragments: 1024,
        blocks: 512,
        instructions: 65536,
        values: 131072,
        tolerant: true,
        sparse_polls: true,
    };
}

pub fn lift_cpu_cfg(
    bytes: &[u8],
    pc: GuestEip,
    linear: LinearAddress,
    default_32: bool,
    rep_budget: u32,
) -> Result<Region, CompileError> {
    lift_cpu_cfg_sources(
        &[CfgSource { bytes, pc, linear }],
        &[],
        default_32,
        rep_budget,
    )
}
/// Compose separately captured hot regions into one SSA graph. Predictions only
/// discover candidate edges; every dynamic edge retains an exact target guard.
pub fn lift_cpu_cfg_sources(
    sources: &[CfgSource<'_>],
    predictions: &[PredictedEdge],
    default_32: bool,
    rep_budget: u32,
) -> Result<Region, CompileError> {
    let entries: Vec<_> = sources.first().map(|s| vec![s.pc]).unwrap_or_default();
    lift_cpu_cfg_sources_inner(
        sources,
        predictions,
        &entries,
        default_32,
        rep_budget,
        true,
        CfgLimits::REGION,
    )
}
/// Every instruction of one page reachable from its observed entries.
/// Returns the graph and the external entries it actually serves, in
/// dispatch order; a tolerant graph may leave some entries to the interpreter.
pub fn lift_cpu_cfg_page(
    source: CfgSource<'_>,
    entries: &[GuestEip],
    default_32: bool,
    rep_budget: u32,
    limits: CfgLimits,
) -> Result<(Region, Vec<GuestEip>), CompileError> {
    lift_cfg_graph(
        &[source],
        &[],
        entries,
        default_32,
        rep_budget,
        true,
        limits,
    )
}
/// One SSA graph with a shared cold prologue and exact-PC dispatch. External
/// entries remain CFG leaders, even when a fallthrough predecessor exists.
pub fn lift_cpu_cfg_entries(
    sources: &[CfgSource<'_>],
    predictions: &[PredictedEdge],
    entries: &[GuestEip],
    default_32: bool,
    rep_budget: u32,
) -> Result<Region, CompileError> {
    lift_cpu_cfg_sources_inner(
        sources,
        predictions,
        entries,
        default_32,
        rep_budget,
        true,
        CfgLimits::REGION,
    )
}
#[cfg(test)]
pub(crate) fn lift_cpu_cfg_uncoalesced(
    bytes: &[u8],
    pc: GuestEip,
    linear: LinearAddress,
    default_32: bool,
    rep_budget: u32,
) -> Result<Region, CompileError> {
    lift_cpu_cfg_sources_inner(
        &[CfgSource { bytes, pc, linear }],
        &[],
        &[pc],
        default_32,
        rep_budget,
        false,
        CfgLimits::REGION,
    )
}
fn lift_cpu_cfg_sources_inner(
    sources: &[CfgSource<'_>],
    predictions: &[PredictedEdge],
    entries: &[GuestEip],
    default_32: bool,
    rep_budget: u32,
    compact: bool,
    limits: CfgLimits,
) -> Result<Region, CompileError> {
    let (region, served) = lift_cfg_graph(
        sources,
        predictions,
        entries,
        default_32,
        rep_budget,
        compact,
        limits,
    )?;
    debug_assert_eq!(served, entries);
    Ok(region)
}
fn lift_cfg_graph(
    sources: &[CfgSource<'_>],
    predictions: &[PredictedEdge],
    entries: &[GuestEip],
    default_32: bool,
    rep_budget: u32,
    compact: bool,
    limits: CfgLimits,
) -> Result<(Region, Vec<GuestEip>), CompileError> {
    if sources.is_empty() || sources.iter().any(|s| s.bytes.is_empty()) {
        return Err(invalid("empty CFG snapshot"));
    }
    if sources.len() > limits.sources
        || sources.iter().any(|s| s.bytes.len() > limits.source_bytes)
        || predictions.len() > 4
    {
        return Err(CompileError::Budget("CFG code snapshot"));
    }
    if entries.is_empty() || entries.len() > limits.entries {
        return Err(CompileError::Budget("CFG external entries"));
    }
    for (i, pc) in entries.iter().enumerate() {
        if locate(sources, *pc).is_none() || entries[..i].contains(pc) {
            return Err(invalid("invalid CFG external entry"));
        }
    }
    let entry_pc = sources[0].pc;
    for (i, source) in sources.iter().enumerate() {
        if source.linear.0.wrapping_sub(source.pc.0) != sources[0].linear.0.wrapping_sub(entry_pc.0)
        {
            return Err(invalid("incompatible CFG sources"));
        }
        // Overlapping immutable windows are common for hot side entries. Share
        // identical bytes, but still reject conflicting snapshots and later
        // reject targets entering the middle of an already decoded instruction.
        for old in &sources[..i] {
            for (at, byte) in source.bytes.iter().enumerate() {
                if let Some(other) = offset(
                    GuestEip(source.pc.0.wrapping_add(at as u32)),
                    old.pc,
                    old.bytes.len(),
                ) {
                    if *byte != old.bytes[other] {
                        return Err(invalid("conflicting CFG source bytes"));
                    }
                }
            }
        }
    }
    let mut fragments: BTreeMap<usize, Fragment> = BTreeMap::new();
    let mut pending: BTreeSet<_> = entries.iter().map(|pc| pc.0 as usize).collect();
    // Page mode only: addresses left to the interpreter (never CFG targets).
    let mut declined = BTreeSet::new();
    while let Some(address) = pending.pop_first() {
        if fragments.contains_key(&address) || declined.contains(&address) {
            continue;
        }
        let (source, at) = locate(sources, GuestEip(address as u32))
            .ok_or_else(|| invalid("missing CFG source"))?;
        let CfgSource { bytes, pc, linear } = source;
        if fragments.len() >= limits.fragments {
            if limits.tolerant {
                declined.insert(address);
                continue;
            }
            return Err(CompileError::Budget("CFG decoded instructions"));
        }
        let lifted = (|| {
            let decoded = decode(
                &bytes[at..],
                GuestEip(pc.0.wrapping_add(at as u32)),
                LinearAddress(linear.0.wrapping_add(at as u32)),
                default_32,
            )
            .map_err(|_| invalid("CFG decode stop"))?;
            let span = if decoded.encoding.opcode == 0xFB {
                super::sti::extent(
                    &bytes[at..],
                    decoded.instruction_pc,
                    decoded.linear_pc,
                    default_32,
                )?
            }
            else {
                decoded.length as usize
            };
            if fragments.iter().any(|(&other, f)| {
                (address as u32).wrapping_sub(other as u32) < f.span as u32
                    || (other as u32).wrapping_sub(address as u32) < span as u32
            }) {
                return Err(invalid("overlapping guest instruction streams"));
            }
            let ir = lift_cpu_with_rep_budget(
                &bytes[at..at + span],
                decoded.instruction_pc,
                decoded.linear_pc,
                default_32,
                rep_budget,
            )?;
            Ok((decoded, span, ir))
        })();
        let (decoded, span, ir) = match lifted {
            Ok(lifted) => lifted,
            Err(_) if limits.tolerant => {
                declined.insert(address);
                continue;
            },
            Err(error) => return Err(error),
        };
        let end = at + span;
        // Scalar and vector stores can continue through the guarded RAM path.
        // Cold/MMIO writes and aliases of any immutable code dependency still
        // commit then exit there. Other commit-bearing adapters own their exit.
        let incomplete_tail = end < bytes.len()
            && decode(
                &bytes[end..],
                decoded.next_pc,
                LinearAddress(linear.0.wrapping_add(end as u32)),
                default_32,
            )
            .is_err();
        let stop = ir.instructions.iter().any(|i| {
            (i.commit.is_some()
                && (incomplete_tail
                    || !matches!(
                        i.op,
                        Op::GuestStore { .. }
                            | Op::RmwStore { .. }
                            | Op::XmmStore { .. }
                            | Op::XmmMaskedStore { .. }
                    )))
                || matches!(i.op, Op::CompareExchange8B { .. })
                || match i.op {
                    Op::CallHelper(id) => matches!(
                        ir.helpers[id.index()].abi,
                        crate::ir::helper::HelperAbi::CpuExit
                            | crate::ir::helper::HelperAbi::CpuRep
                    ),
                    _ => false,
                }
        });
        if !stop {
            for state in exit_states(&ir) {
                pending.extend(exit_targets(
                    &ir,
                    state,
                    sources,
                    predictions,
                    default_32,
                    &[],
                ));
                // A return site is reached by the callee's RET, not by an edge
                // of the CALL itself; discover it so the RET can be guarded to it.
                pending.extend(return_site(&ir, state, sources, default_32));
            }
        }
        fragments.insert(
            address,
            Fragment {
                decoded,
                span,
                ir,
                stop,
            },
        );
    }
    // MOV Sreg in real or VM86 mode continues (ir_mov_segment_continue), but
    // graft reads each selector once, at the region's entry: a MOV Sreg of a
    // selector the region also reads (MOV r/m16, Sreg; PUSH Sreg) ends the
    // region, so no read follows it. (SeaVGABIOS's INT 10h entry loads DS
    // and copies it to SS: SS kept the caller's, and the Linux boot failed)
    let read = fragments.values().fold(0u8, |mask, f| {
        f.ir.instructions.iter().fold(mask, |mask, i| match i.op {
            Op::ReadSegment(segment) => mask | 1 << segment,
            _ => mask,
        })
    });
    for fragment in fragments.values_mut() {
        let i = &fragment.decoded;
        if i.encoding.opcode == 0x8E && read >> (i.modrm.unwrap() >> 3 & 7) & 1 != 0 {
            fragment.stop = true;
        }
    }
    let entries: Vec<GuestEip> = entries
        .iter()
        .copied()
        .filter(|pc| fragments.contains_key(&(pc.0 as usize)))
        .collect();
    if entries.is_empty() {
        return Err(invalid("no lifted CFG external entry"));
    }
    let entries = &entries[..];
    // Pay CFG/block-parameter costs per straight-line run, not per x86
    // instruction. Branch destinations and externally callable entries remain
    // leaders; a failed compound lift keeps the original precise fragments.
    if compact {
        coalesce_fragments(
            &mut fragments,
            sources,
            predictions,
            entries,
            default_32,
            rep_budget,
        );
    }
    let mut return_sites = vec![];
    for fragment in fragments.values().filter(|f| !f.stop) {
        for state in exit_states(&fragment.ir) {
            if let Some(site) = return_site(&fragment.ir, state, sources, default_32) {
                if fragments.contains_key(&site) && !return_sites.contains(&site) {
                    return_sites.push(site);
                }
            }
        }
    }
    // A return site is entered only through a guarded RET. When the callee
    // leaves the graph before returning, the site has no predecessor: keep
    // only fragments reachable from the entries along the edges graft wires.
    let mut reachable = BTreeSet::new();
    let mut work: Vec<usize> = entries.iter().map(|pc| pc.0 as usize).collect();
    while let Some(at) = work.pop() {
        if !reachable.insert(at) {
            continue;
        }
        let fragment = &fragments[&at];
        if fragment.stop {
            continue;
        }
        for state in exit_states(&fragment.ir) {
            work.extend(
                exit_targets(
                    &fragment.ir,
                    state,
                    sources,
                    predictions,
                    default_32,
                    &return_sites,
                )
                .into_iter()
                .filter(|next| fragments.contains_key(next)),
            );
        }
    }
    fragments.retain(|at, _| reachable.contains(at));
    return_sites.retain(|site| reachable.contains(site));
    let block_count = entries.len() + fragments.values().map(|f| f.ir.blocks.len()).sum::<usize>();
    if block_count > limits.blocks {
        return Err(CompileError::Budget("CFG block count"));
    }
    let xmm = fragments.values().any(|f| {
        f.ir.states.iter().any(|s| !s.xmm.is_empty())
            || f.ir
                .instructions
                .iter()
                .any(|i| matches!(i.op, Op::ReadXmm(_)))
    });
    let seed = IntegerBuilder::new();
    let mut b = IntegerBuilder::new();
    // Mode/selector-changing adapters terminate the region, as does a MOV Sreg
    // of a selector read here (above). These reads therefore remain invariant
    // until exit, including across guest backedges.
    let mut entry_reads: Vec<(Op, ValueId)> = vec![];
    for fragment in fragments.values() {
        for inst in &fragment.ir.instructions {
            if matches!(inst.op, Op::ReadSegment(_) | Op::ReadStack32)
                && !entry_reads.iter().any(|(op, _)| *op == inst.op)
            {
                let value = b.node(
                    inst.op.clone(),
                    vec![],
                    fragment.ir.values[inst.results[0].index()].ty,
                );
                entry_reads.push((inst.op.clone(), value));
            }
        }
    }
    if xmm {
        b.xmm = (0..8)
            .map(|r| b.node(Op::ReadXmm(r), vec![], Type::V128))
            .collect();
    }
    let zero = b.constant(0, Type::I32);
    let initial = Frame {
        gpr: b.gpr,
        flags: b.flags.clone(),
        xmm: b.xmm.clone(),
        count: zero,
        effect: b.effect,
    };
    let mut roots = BTreeMap::new();
    for (&at, fragment) in &fragments {
        let block = b.region.block(false);
        let frame = Frame::params(&mut b.region, block, xmm);
        let state = b.region.state(frame.recovery(&fragment.decoded));
        b.region.blocks[block.index()].entry_state = Some(state);
        roots.insert(at, (block, frame));
    }
    // All architectural reads dominate every cold entry. No entry selector is
    // trusted: the emitter first validates the actual CPU PC against this list.
    let tests = if entries.len() > 1 {
        let current = b.node(Op::ReadEntryLinear, vec![], Type::I32);
        let cs_base = sources[0].linear.0.wrapping_sub(entry_pc.0);
        entries[..entries.len() - 1]
            .iter()
            .map(|pc| {
                let target = b.constant(cs_base.wrapping_add(pc.0), Type::I32);
                b.node(Op::Binary(Binary::Eq), vec![current, target], Type::I1)
            })
            .collect::<Vec<_>>()
    }
    else {
        Vec::new()
    };
    let mut dispatch = b.block;
    let mut dispatch_effect = initial.effect;
    for (index, &pc) in entries.iter().enumerate() {
        let mut args = initial.args();
        *args.last_mut().unwrap() = dispatch_effect;
        let edge = Edge {
            target: roots[&(pc.0 as usize)].0,
            args,
        };
        if index + 1 == entries.len() {
            b.region.terminate(dispatch, Terminator::Branch(edge));
        }
        else {
            let next = b.region.block(false);
            let effect = b.region.param(next, Type::Effect);
            b.region.terminate(
                dispatch,
                Terminator::CondBranch {
                    condition: tests[index],
                    taken: edge,
                    not_taken: Edge {
                        target: next,
                        args: vec![dispatch_effect],
                    },
                },
            );
            dispatch = next;
            dispatch_effect = effect;
        }
    }
    for (&at, fragment) in &fragments {
        graft(
            &mut b.region,
            fragment,
            &seed,
            &roots,
            &entry_reads,
            at,
            sources,
            predictions,
            default_32,
            &return_sites,
        )?;
        if b.region.instructions.len() > limits.instructions
            || b.region.values.len() > limits.values
            || b.region.blocks.len() > limits.blocks
        {
            return Err(CompileError::Budget("CFG IR size"));
        }
    }
    // The one release verification before passes; lowering checks again.
    crate::ir::verify::verify(&b.region).map_err(|e| CompileError::InvalidIr(e.0))?;
    Ok((b.region, entries.to_vec()))
}
/// Collapse only uniquely reached, contiguous fallthrough chains. This happens
/// before the graph budget: otherwise 64 ordinary instructions exhaust the
/// block cap even though they need just one machine block. Guest instruction
/// counts and every fault/commit StateMap still come from the audited lifter.
fn coalesce_fragments(
    fragments: &mut BTreeMap<usize, Fragment>,
    sources: &[CfgSource<'_>],
    predictions: &[PredictedEdge],
    entries: &[GuestEip],
    default_32: bool,
    rep_budget: u32,
) {
    let mut incoming = BTreeMap::<usize, usize>::new();
    for fragment in fragments.values().filter(|f| !f.stop) {
        for state in exit_states(&fragment.ir) {
            for next in exit_targets(&fragment.ir, state, sources, predictions, default_32, &[]) {
                *incoming.entry(next).or_default() += 1;
            }
            // Return sites are RET targets: never fold them into a predecessor.
            if let Some(site) = return_site(&fragment.ir, state, sources, default_32) {
                *incoming.entry(site).or_default() += 2;
            }
        }
    }
    let mut considered = BTreeSet::new();
    let starts: Vec<_> = fragments.keys().copied().collect();
    for start in starts {
        if !considered.insert(start) || !fragments.contains_key(&start) {
            continue;
        }
        let mut chain = vec![start];
        let mut at = start;
        loop {
            let fragment = &fragments[&at];
            if fragment.stop
                || fragment.decoded.encoding.opcode == 0xFB
                || !matches!(
                    fragment.decoded.flow,
                    super::decode::Flow::Next | super::decode::Flow::Boundary
                )
                || chain.len() == 32
            {
                break;
            }
            let next = (at as u32).wrapping_add(fragment.span as u32) as usize;
            if entries.iter().any(|pc| pc.0 as usize == next)
                || incoming.get(&next) != Some(&1)
                || considered.contains(&next)
                || !fragments.contains_key(&next)
                || fragments[&next].decoded.encoding.opcode == 0xFB
            {
                break;
            }
            // Only one fallthrough exit may feed the next fragment. A helper
            // fault/conditional exit must never be turned into fallthrough.
            let exits: Vec<_> = fragment
                .ir
                .blocks
                .iter()
                .filter_map(|block| {
                    if let Some(Terminator::Exit(id)) = block.terminator {
                        Some(&fragment.ir.states[id.index()])
                    }
                    else {
                        None
                    }
                })
                .collect();
            if exits.len() != 1 || successor(exits[0], sources) != Some(next) {
                break;
            }
            considered.insert(next);
            chain.push(next);
            at = next;
        }
        if chain.len() == 1 {
            continue;
        }
        let mut bytes = Vec::new();
        for &address in &chain {
            let fragment = &fragments[&address];
            let Some((source, offset)) = locate(sources, GuestEip(address as u32))
            else {
                bytes.clear();
                break;
            };
            let Some(part) = source.bytes.get(offset..offset + fragment.span)
            else {
                bytes.clear();
                break;
            };
            bytes.extend_from_slice(part);
        }
        if bytes.is_empty() || bytes.len() > 15 * 128 {
            continue;
        }
        let first = &fragments[&start];
        let Ok(ir) = super::lift::lift_cpu_with_polls(
            &bytes,
            first.decoded.instruction_pc,
            first.decoded.linear_pc,
            default_32,
            rep_budget,
        )
        else {
            continue;
        };
        let stop = fragments[chain.last().unwrap()].stop;
        let first = fragments.get_mut(&start).unwrap();
        first.ir = ir;
        first.span = bytes.len();
        first.stop = stop;
        for &address in &chain[1..] {
            fragments.remove(&address);
        }
    }
}

fn graft(
    out: &mut Region,
    fragment: &Fragment,
    seed: &IntegerBuilder,
    roots: &BTreeMap<usize, (BlockId, Frame)>,
    entry_reads: &[(Op, ValueId)],
    at: usize,
    sources: &[CfgSource<'_>],
    predictions: &[PredictedEdge],
    default_32: bool,
    return_sites: &[usize],
) -> Result<(), CompileError> {
    let src = &fragment.ir;
    let (root, frame) = &roots[&at];
    if src.entries != vec![BlockId(0)]
        || src.blocks[0].instructions.len() < seed.region.instructions.len()
    {
        return Err(invalid("CFG fragment entry shape"));
    }
    for (old, expected) in src.instructions.iter().zip(&seed.region.instructions) {
        if old.op != expected.op || old.args != expected.args || old.results != expected.results {
            return Err(invalid("CFG fragment input contract"));
        }
    }
    let mut values = vec![None; src.values.len()];
    for (&old, &new) in seed.gpr.iter().zip(&frame.gpr) {
        values[old.index()] = Some(new);
    }
    for (&old, &new) in seed.flags.arithmetic.iter().zip(&frame.flags.arithmetic) {
        values[old.index()] = Some(new);
    }
    for (old, new) in [
        (seed.flags.system, frame.flags.system),
        (seed.flags.last_op1.unwrap(), frame.flags.last_op1.unwrap()),
        (seed.flags.raw_zero.unwrap(), frame.flags.raw_zero.unwrap()),
        (
            seed.flags.zero_is_lazy.unwrap(),
            frame.flags.zero_is_lazy.unwrap(),
        ),
        (
            seed.flags.raw_flags.unwrap(),
            frame.flags.raw_flags.unwrap(),
        ),
        (
            seed.flags.lazy_mask.unwrap(),
            frame.flags.lazy_mask.unwrap(),
        ),
        (
            seed.flags.last_result.unwrap(),
            frame.flags.last_result.unwrap(),
        ),
        (
            seed.flags.last_op_size.unwrap(),
            frame.flags.last_op_size.unwrap(),
        ),
        (
            seed.flags.backing_valid.unwrap(),
            frame.flags.backing_valid.unwrap(),
        ),
        (seed.effect, frame.effect),
    ] {
        values[old.index()] = Some(new);
    }
    let mut blocks = vec![*root];
    let mut effects = vec![frame.effect];
    let mut extra_effect = vec![false];
    for old in src.blocks.iter().skip(1) {
        let block = out.block(false);
        blocks.push(block);
        let mut effect = None;
        for &param in &old.params {
            let ty = src.values[param.index()].ty;
            let new = out.param(block, ty);
            values[param.index()] = Some(new);
            if ty == Type::Effect {
                effect = Some(new);
            }
        }
        extra_effect.push(effect.is_none());
        effects.push(effect.unwrap_or_else(|| out.param(block, Type::Effect)));
    }
    let helper_base = out.helpers.len() as u32;
    out.helpers.extend(src.helpers.clone());
    let mut instructions = vec![None; src.instructions.len()];
    let get = |map: &[Option<ValueId>], v: ValueId| {
        map.get(v.index())
            .copied()
            .flatten()
            .ok_or_else(|| invalid("unmapped CFG value"))
    };
    for (index, old_block) in src.blocks.iter().enumerate() {
        for id in &old_block.instructions {
            if id.index() < seed.region.instructions.len() {
                continue;
            }
            let inst = &src.instructions[id.index()];
            if let Some((_, value)) = entry_reads.iter().find(|(op, _)| *op == inst.op) {
                values[inst.results[0].index()] = Some(*value);
                continue;
            }
            if let Op::ReadXmm(reg) = inst.op {
                values[inst.results[0].index()] = Some(frame.xmm[reg as usize]);
                continue;
            }
            let mut op = inst.op.clone();
            if let Op::CallHelper(ref mut helper) = op {
                helper.0 += helper_base;
            }
            let args = inst
                .args
                .iter()
                .map(|&v| get(&values, v))
                .collect::<Result<Vec<_>, _>>()?;
            let types: Vec<_> = inst
                .results
                .iter()
                .map(|v| src.values[v.index()].ty)
                .collect();
            let new = out.append(blocks[index], op, args, &types, None);
            let new_id = *out.blocks[blocks[index].index()]
                .instructions
                .last()
                .unwrap();
            instructions[id.index()] = Some(new_id);
            for (&old, &new) in inst.results.iter().zip(&new) {
                values[old.index()] = Some(new);
            }
            if inst.op.ordered() {
                effects[index] = *new.last().unwrap();
            }
        }
    }
    let mut states = vec![];
    for old in &src.states {
        let mut state = old.clone();
        for value in &mut state.gpr {
            *value = get(&values, *value)?;
        }
        for value in &mut state.flags.arithmetic {
            *value = get(&values, *value)?;
        }
        state.flags.system = get(&values, state.flags.system)?;
        for v in [
            &mut state.flags.last_op1,
            &mut state.flags.raw_zero,
            &mut state.flags.zero_is_lazy,
            &mut state.flags.raw_flags,
            &mut state.flags.lazy_mask,
            &mut state.flags.last_result,
            &mut state.flags.last_op_size,
            &mut state.flags.backing_valid,
            &mut state.next_value,
        ] {
            if let Some(value) = v {
                *value = get(&values, *value)?;
            }
        }
        if state.xmm.is_empty() {
            state.xmm = frame.xmm.clone();
        }
        else {
            for value in &mut state.xmm {
                *value = get(&values, *value)?;
            }
        }
        if !state.x87.is_empty() {
            return Err(invalid("CFG extended state pending"));
        }
        if let Some(rep) = &mut state.rep_progress {
            for value in rep {
                *value = get(&values, *value)?;
            }
        }
        state.count_base = Some(frame.count);
        states.push(out.state(state));
    }
    for (index, id) in instructions.iter().enumerate() {
        if let Some(id) = id {
            let old = &src.instructions[index];
            let inst = &mut out.instructions[id.index()];
            inst.state = old.state.map(|id| states[id.index()]);
            inst.commit = old.commit.map(|id| states[id.index()]);
            inst.trap_after_fault = old.trap_after_fault;
            inst.unmasked_word_store = old.unmasked_word_store;
        }
    }
    for (index, block) in src.blocks.iter().enumerate() {
        let destination = blocks[index];
        if index != 0 {
            out.blocks[destination.index()].entry_state =
                block.entry_state.map(|id| states[id.index()]);
        }
        let edge = |edge: &Edge| -> Result<Edge, CompileError> {
            let mut args = edge
                .args
                .iter()
                .map(|&v| get(&values, v))
                .collect::<Result<Vec<_>, _>>()?;
            if extra_effect[edge.target.index()] {
                args.push(effects[index]);
            }
            Ok(Edge {
                target: blocks[edge.target.index()],
                args,
            })
        };
        let term = match block.terminator.as_ref().unwrap() {
            Terminator::Branch(next) => Terminator::Branch(edge(next)?),
            Terminator::CondBranch {
                condition,
                taken,
                not_taken,
            } => Terminator::CondBranch {
                condition: get(&values, *condition)?,
                taken: edge(taken)?,
                not_taken: edge(not_taken)?,
            },
            Terminator::Exit(old) => {
                let id = states[old.index()];
                let state = out.states[id.index()].clone();
                let targets: Vec<usize> = if fragment.stop {
                    vec![]
                }
                else {
                    exit_targets(
                        src,
                        &src.states[old.index()],
                        sources,
                        predictions,
                        default_32,
                        return_sites,
                    )
                }
                .into_iter()
                .filter(|next| roots.contains_key(next))
                .collect();
                if targets.is_empty() {
                    Terminator::Exit(id)
                }
                else {
                    if fragment.decoded.encoding.opcode == 0xFB {
                        // Only a normally completed compound shadow can reach
                        // this edge. Keep fault/terminal paths on their original
                        // unwind; the fast finish may not observe stale SSA state.
                        let depth = src
                            .helpers
                            .iter()
                            .filter(|h| h.name == "ir_sti_check")
                            .count();
                        let depth = out.append(
                            destination,
                            Op::Const(depth as u64),
                            vec![],
                            &[Type::I32],
                            None,
                        )[0];
                        let helper = HelperId(out.helpers.len() as u32);
                        out.helpers.push(
                            crate::ir::helper::cpu_registry::descriptor(
                                "ir_sti_finish_continue",
                                vec![Type::I32],
                            )
                            .unwrap(),
                        );
                        effects[index] = out.append(
                            destination,
                            Op::CallHelper(helper),
                            vec![depth, effects[index]],
                            &[Type::Effect],
                            Some(id),
                        )[0];
                    }
                    let offset = out.append(
                        destination,
                        Op::Const(state.committed_instructions as u64),
                        vec![],
                        &[Type::I32],
                        None,
                    )[0];
                    let count = out.append(
                        destination,
                        Op::Binary(Binary::Add),
                        vec![frame.count, offset],
                        &[Type::I32],
                        None,
                    )[0];
                    let next_frame = Frame {
                        gpr: state.gpr,
                        flags: state.flags,
                        xmm: state.xmm,
                        count,
                        effect: effects[index],
                    };
                    let edge_to = |target: usize| Edge {
                        target: roots[&target].0,
                        args: next_frame.args(),
                    };
                    if let Some(value) = state.next_value {
                        // Exact guards in candidate order; any other dynamic
                        // target commits through the original exit.
                        let fallback = out.block(false);
                        out.blocks[fallback.index()].entry_state = Some(id);
                        out.terminate(fallback, Terminator::Exit(id));
                        let tests: Vec<BlockId> = std::iter::once(destination)
                            .chain((1..targets.len()).map(|_| out.block(false)))
                            .collect();
                        let mut first = None;
                        for (k, &target) in targets.iter().enumerate() {
                            let block = tests[k];
                            let expected = out.append(
                                block,
                                Op::Const(target as u64),
                                vec![],
                                &[Type::I32],
                                None,
                            )[0];
                            let condition = out.append(
                                block,
                                Op::Binary(Binary::Eq),
                                vec![value, expected],
                                &[Type::I1],
                                None,
                            )[0];
                            let not_taken = Edge {
                                target: tests.get(k + 1).copied().unwrap_or(fallback),
                                args: vec![],
                            };
                            let test = Terminator::CondBranch {
                                condition,
                                taken: edge_to(target),
                                not_taken,
                            };
                            if k == 0 {
                                first = Some(test);
                            }
                            else {
                                out.terminate(block, test);
                            }
                        }
                        first.unwrap()
                    }
                    else {
                        Terminator::Branch(edge_to(targets[0]))
                    }
                }
            },
        };
        out.terminate(destination, term);
    }
    Ok(())
}

#[cfg(test)]
mod formation_tests {
    use super::*;

    #[test]
    fn long_fallthrough_is_not_one_cfg_block_per_instruction() {
        // The old per-instruction graph exceeds the 64-block budget here.
        let bytes = vec![0x40; 96];
        let region =
            lift_cpu_cfg(&bytes, GuestEip(0x1000), LinearAddress(0x2000), true, 64).unwrap();
        assert!(region.blocks.len() < 8, "{} blocks", region.blocks.len());
        assert_eq!(
            region.states.iter().map(|s| s.committed_instructions).max(),
            Some(32)
        );
        crate::ir::lowering::lower(&region).unwrap();
    }

    #[test]
    fn near_call_and_return_stay_inside_the_graph() {
        // CALL f; DEC ECX; JNZ entry; HLT; f: ADD EAX,EBX; RET.
        let bytes = [0xE8, 4, 0, 0, 0, 0x49, 0x75, 0xF8, 0xF4, 0x01, 0xD8, 0xC3];
        let region =
            lift_cpu_cfg(&bytes, GuestEip(0x1000), LinearAddress(0x2000), true, 64).unwrap();
        crate::ir::verify::verify(&region).unwrap();
        let entry_pcs: Vec<u32> = region
            .blocks
            .iter()
            .filter_map(|b| {
                b.entry_state
                    .map(|s| region.states[s.index()].instruction_pc.0)
            })
            .collect();
        // Callee and return site are graph blocks, not exits to the dispatcher.
        assert!(entry_pcs.contains(&0x1009), "{entry_pcs:x?}");
        assert!(entry_pcs.contains(&0x1005), "{entry_pcs:x?}");
        crate::ir::lowering::lower(&region).unwrap();
    }

    #[test]
    fn return_site_without_a_returning_callee_is_dropped() {
        // CALL f; INC EAX; HLT; f: JMP far away (the callee leaves the graph).
        let bytes = [0xE8, 2, 0, 0, 0, 0x40, 0xF4, 0xE9, 0, 0x10, 0, 0];
        let region =
            lift_cpu_cfg(&bytes, GuestEip(0x1000), LinearAddress(0x2000), true, 64).unwrap();
        crate::ir::verify::verify(&region).unwrap();
        crate::ir::lowering::lower(&region).unwrap();
    }

    #[test]
    fn mov_sreg_of_a_selector_the_region_reads_ends_it() {
        // (16-bit) PUSH DS; MOV DS,AX; MOV DX,DS; HLT: the region reads DS at
        // its entry, so it ends after MOV DS,AX
        let bytes = [0x1E, 0x8E, 0xD8, 0x8C, 0xDA, 0xF4];
        let region =
            lift_cpu_cfg(&bytes, GuestEip(0x1000), LinearAddress(0x2000), false, 64).unwrap();
        crate::ir::verify::verify(&region).unwrap();
        crate::ir::lowering::lower(&region).unwrap();
        assert_eq!(
            region.states.iter().map(|s| s.committed_instructions).max(),
            Some(2)
        );
        // MOV DS,AX; MOV DX,ES; HLT: no read of DS, the region continues
        let bytes = [0x8E, 0xD8, 0x8C, 0xC2, 0xF4];
        let region =
            lift_cpu_cfg(&bytes, GuestEip(0x1000), LinearAddress(0x2000), false, 64).unwrap();
        assert!(region.states.iter().map(|s| s.committed_instructions).max() >= Some(2));
    }

    #[test]
    fn loop_entry_and_branch_join_stay_leaders() {
        // INC; DEC ECX; JNZ entry; INC EBX. The shared loop carries SSA state.
        let region = lift_cpu_cfg(
            &[0x40, 0x49, 0x75, 0xFC, 0x43],
            GuestEip(0x1000),
            LinearAddress(0x2000),
            true,
            64,
        )
        .unwrap();
        crate::ir::verify::verify(&region).unwrap();
        crate::ir::lowering::lower(&region).unwrap();
        assert!(region
            .states
            .iter()
            .any(|s| s.instruction_pc == GuestEip(0x1000)));
    }
}
