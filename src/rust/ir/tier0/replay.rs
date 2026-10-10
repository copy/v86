//! Record and replay of Tier-0 compilations (docs/jit-unification-plan.md
//! P2.0, cross-phase rule 4), in test builds (ir-test-hooks). A record holds
//! every input of compile_page_with but the addresses: replaying it compiles
//! under CompileEnv::replay's fixed pseudo addresses, so two builds that
//! emit alike give the same bytes. tools/replay_check.mjs compares a base
//! build's bytes with the working tree's, for records of real workloads and
//! for a synthetic corpus of every SIMD form the templates take.
//!
//! A record, little-endian: "T0R1"; flags (bit 0: the recording build's
//! parallel memory, bit 1: relaxed FMA); state flags; link (0 iterative,
//! 1 nested, 2 tail); the request's pc, linear and default_32; the mappings
//! (count, then linear and physical each) and their bytes (4096 each); the
//! entries (count u16, then pc, linear, default_32 each); the extra block
//! starts (count u16, then each); since P3.0a, Tier-0's features (u32) and
//! whether the kind profile counts (u8). Records without the last two have
//! neither, and builds before them ignore the bytes.

use super::{compile_page_with, CompileEnv};
use crate::ir::frontend::decode::{decode, GuestEip, LinearAddress, PhysicalAddress};
use crate::ir::runtime::compile::{
    CodeDependency, CodeMapping, CompileRequest, ImmutableCodeSnapshot, PublicationKey, Tier,
};
use crate::ir::runtime::entry::CpuEntryKey;
use crate::ir::runtime::tier0::Link;
use crate::state_flags::CachedStateFlags;
use crate::wasmgen::wasm_builder::WasmBuilder;

const MAGIC: &[u8; 4] = b"T0R1";

/// Compilations recorded since ir_t0_record_start (None: not recording)
static mut RECORDS: Option<Vec<Vec<u8>>> = None;
/// What each recorded compilation made, as it ran (empty for a failed one):
/// tools/page_profile.mjs maps profiler ticks onto it
static mut OUTPUTS: Option<Vec<Vec<u8>>> = None;
/// The input of ir_t0_replay and its output
static mut INPUT: Vec<u8> = Vec::new();
static mut OUTPUT: Vec<u8> = Vec::new();

fn link_code(link: Link) -> u8 {
    match link {
        Link::Iterative => 0,
        Link::Nested => 1,
        Link::Tail => 2,
    }
}

fn encode(
    env: &CompileEnv,
    origin: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    entries: &[CpuEntryKey],
    extra: &[u32],
) -> Vec<u8> {
    let mut r = Vec::with_capacity(32 + snapshot.bytes.len());
    let u32 = |r: &mut Vec<u8>, v: u32| r.extend_from_slice(&v.to_le_bytes());
    r.extend_from_slice(MAGIC);
    r.push(WasmBuilder::ATOMIC_GUEST_MEMORY as u8 | (env.relaxed_fma as u8) << 1);
    r.push(env.state_flags.to_u32() as u8);
    r.push(link_code(env.link));
    u32(&mut r, origin.pc.0);
    u32(&mut r, origin.linear.0);
    r.push(origin.default_32 as u8);
    r.push(snapshot.mappings.len() as u8);
    for m in &snapshot.mappings {
        u32(&mut r, m.linear.0);
        u32(&mut r, m.physical.0);
    }
    r.extend_from_slice(&snapshot.bytes);
    r.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for e in entries {
        u32(&mut r, e.pc.0);
        u32(&mut r, e.linear.0);
        r.push(e.default_32 as u8);
    }
    r.extend_from_slice(&(extra.len() as u16).to_le_bytes());
    for &x in extra {
        u32(&mut r, x);
    }
    u32(&mut r, env.features);
    r.push(env.kind_profile.is_some() as u8);
    r
}

struct Reader<'a>(&'a [u8]);
impl Reader<'_> {
    fn bytes(&mut self, n: usize) -> Option<&[u8]> {
        let (head, rest) = (self.0.get(..n)?, self.0.get(n..)?);
        self.0 = rest;
        Some(head)
    }
    fn u8(&mut self) -> Option<u8> { Some(self.bytes(1)?[0]) }
    fn u16(&mut self) -> Option<u16> { Some(u16::from_le_bytes(self.bytes(2)?.try_into().ok()?)) }
    fn u32(&mut self) -> Option<u32> { Some(u32::from_le_bytes(self.bytes(4)?.try_into().ok()?)) }
}

/// The page function's bytes for a record under CompileEnv::replay, or None:
/// a malformed record, one from a build of the other memory kind, or a
/// compilation that fails
pub fn replay(record: &[u8]) -> Option<Vec<u8>> {
    let mut r = Reader(record);
    if r.bytes(4)? != MAGIC {
        return None;
    }
    let flags = r.u8()?;
    if flags & 1 != WasmBuilder::ATOMIC_GUEST_MEMORY as u8 {
        return None;
    }
    let state_flags = CachedStateFlags::of_u32(r.u8()? as u32);
    let link = match r.u8()? {
        0 => Link::Iterative,
        1 => Link::Nested,
        2 => Link::Tail,
        _ => return None,
    };
    let (pc, linear, default_32) = (r.u32()?, r.u32()?, r.u8()? != 0);
    let mut mappings = Vec::new();
    for _ in 0..r.u8()? {
        mappings.push(CodeMapping {
            linear: LinearAddress(r.u32()?),
            physical: PhysicalAddress(r.u32()?),
        });
    }
    let bytes = r.bytes(mappings.len() * 4096)?.to_vec();
    let mut entries = Vec::new();
    for _ in 0..r.u16()? {
        entries.push(CpuEntryKey {
            pc: GuestEip(r.u32()?),
            linear: LinearAddress(r.u32()?),
            default_32: r.u8()? != 0,
        });
    }
    let mut extra = Vec::new();
    for _ in 0..r.u16()? {
        extra.push(r.u32()?);
    }
    // (absent before P3.0a)
    let features = r.u32().unwrap_or(0);
    let kind_profile = r.u8().unwrap_or(0) != 0;
    let env = CompileEnv::replay(state_flags, link, flags & 2 != 0, features, kind_profile);
    let origin = CompileRequest {
        key: PublicationKey {
            job: 0,
            vm_generation: 0,
            slot: 0,
            slot_generation: 0,
        },
        pc: GuestEip(pc),
        linear: LinearAddress(linear),
        default_32,
        tier: Tier::One,
    };
    let snapshot = ImmutableCodeSnapshot {
        bytes,
        dependencies: mappings
            .iter()
            .map(|m| CodeDependency {
                page: m.physical,
                version: 0,
            })
            .collect(),
        mappings,
    };
    compile_page_with(&env, &origin, &snapshot, &entries, &extra)
        .ok()
        .map(|artifact| artifact.code.bytes)
}

/// compile_page's inputs into the recording, when recording
pub fn record(
    env: &CompileEnv,
    origin: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    entries: &[CpuEntryKey],
    extra: &[u32],
) {
    if let Some(records) = unsafe { (*(&raw mut RECORDS)).as_mut() } {
        records.push(encode(env, origin, snapshot, entries, extra));
    }
}

/// What the compilation just recorded made (OUTPUTS)
pub fn record_output(module: &[u8]) {
    if let Some(outputs) = unsafe { (*(&raw mut OUTPUTS)).as_mut() } {
        outputs.push(module.to_vec());
    }
}
/// The module record `index`'s compilation made: its address and length
#[no_mangle]
pub unsafe fn ir_t0_record_output_address(index: u32) -> u32 {
    (*(&raw const OUTPUTS))
        .as_ref()
        .and_then(|o| o.get(index as usize))
        .map_or(0, |o| o.as_ptr() as u32)
}
#[no_mangle]
pub unsafe fn ir_t0_record_output_length(index: u32) -> u32 {
    (*(&raw const OUTPUTS))
        .as_ref()
        .and_then(|o| o.get(index as usize))
        .map_or(0, |o| o.len() as u32)
}

/// Record every compilation from now on (the records so far are dropped)
#[no_mangle]
pub unsafe fn ir_t0_record_start() {
    RECORDS = Some(Vec::new());
    OUTPUTS = Some(Vec::new());
}
#[no_mangle]
pub unsafe fn ir_t0_record_stop() {
    RECORDS = None;
    OUTPUTS = None;
}
#[no_mangle]
pub unsafe fn ir_t0_record_count() -> u32 {
    (*(&raw const RECORDS))
        .as_ref()
        .map_or(0, |r| r.len() as u32)
}
/// The address and length of record `index`
#[no_mangle]
pub unsafe fn ir_t0_record_address(index: u32) -> u32 {
    (*(&raw const RECORDS))
        .as_ref()
        .and_then(|r| r.get(index as usize))
        .map_or(0, |r| r.as_ptr() as u32)
}
#[no_mangle]
pub unsafe fn ir_t0_record_length(index: u32) -> u32 {
    (*(&raw const RECORDS))
        .as_ref()
        .and_then(|r| r.get(index as usize))
        .map_or(0, |r| r.len() as u32)
}
/// Replace the records by the synthetic corpus: one page per form the SIMD
/// templates take. Returns their number.
#[no_mangle]
pub unsafe fn ir_t0_record_corpus() -> u32 {
    let records = corpus();
    let n = records.len() as u32;
    RECORDS = Some(records);
    n
}
/// A buffer of `length` bytes for the record ir_t0_replay compiles
#[no_mangle]
pub unsafe fn ir_t0_replay_input(length: u32) -> u32 {
    let input = &mut *(&raw mut INPUT);
    input.clear();
    input.resize(length as usize, 0);
    input.as_ptr() as u32
}
/// Replay the record in the input buffer: the length of the page function's
/// bytes (ir_t0_replay_output), or 0 when it does not compile
#[no_mangle]
pub unsafe fn ir_t0_replay() -> u32 {
    let output = &mut *(&raw mut OUTPUT);
    *output = replay(&*(&raw const INPUT)).unwrap_or_default();
    output.len() as u32
}
#[no_mangle]
pub unsafe fn ir_t0_replay_output() -> u32 { (*(&raw const OUTPUT)).as_ptr() as u32 }

/// Flat 32-bit protected mode, ring 0
const FLAT_32: u32 = 0b1011;
const BASE: u32 = 0x40_0000;

/// One record per form the SIMD templates take: the instruction at the
/// start of a page, then RET. Candidates: the 0F, 0F 38 and 0F 3A maps with
/// no, 66, F2 or F3 prefix, and the VEX maps with each pp, L and W; each
/// opcode with a register (xmm1 or mm1) and a memory ([ecx]) operand, ModRM
/// reg 0 and 2 (all eight for opcode groups), and an immediate byte that
/// forms without one leave in the next instruction's place.
pub fn corpus() -> Vec<Vec<u8>> {
    let mut records = Vec::new();
    let env = CompileEnv::replay(
        CachedStateFlags::of_u32(FLAT_32),
        Link::Iterative,
        false,
        0,
        false,
    );
    let mut seen = std::collections::HashSet::new();
    let mut take = |instruction: Vec<u8>| {
        let Ok(decoded) = decode(&instruction, GuestEip(BASE), LinearAddress(BASE), true)
        else {
            return;
        };
        if !super::emit::simd_template(&decoded) {
            return;
        }
        let length = decoded.length as usize;
        if !seen.insert(instruction[..length].to_vec()) {
            return;
        }
        let mut page = vec![0xCC; 4096];
        page[..length].copy_from_slice(&instruction[..length]);
        page[length] = 0xC3;
        let origin = CompileRequest {
            key: PublicationKey {
                job: 0,
                vm_generation: 0,
                slot: 0,
                slot_generation: 0,
            },
            pc: GuestEip(BASE),
            linear: LinearAddress(BASE),
            default_32: true,
            tier: Tier::One,
        };
        let mapping = CodeMapping {
            linear: LinearAddress(BASE),
            physical: PhysicalAddress(BASE),
        };
        let snapshot = ImmutableCodeSnapshot {
            bytes: page,
            dependencies: vec![CodeDependency {
                page: mapping.physical,
                version: 0,
            }],
            mappings: vec![mapping],
        };
        records.push(encode(&env, &origin, &snapshot, &[origin.cpu_entry()], &[]));
    };
    let groups = |map: u8, opcode: u8, vex: bool| match (map, vex) {
        (1, _) => matches!(opcode, 0x71..=0x73 | 0xAE | 0xC7),
        (2, true) => opcode == 0xF3,
        _ => false,
    };
    for map in 1..=3u8 {
        let escape: &[u8] = match map {
            1 => &[0x0F],
            2 => &[0x0F, 0x38],
            _ => &[0x0F, 0x3A],
        };
        for prefix in [None, Some(0x66u8), Some(0xF2), Some(0xF3)] {
            for opcode in 0..=255u8 {
                let regs: &[u8] =
                    if groups(map, opcode, false) { &[0, 1, 2, 3, 4, 5, 6, 7] } else { &[0, 2] };
                for &reg in regs {
                    for modrm in [0xC1 | reg << 3, 0x01 | reg << 3] {
                        let mut i: Vec<u8> = prefix.into_iter().collect();
                        i.extend_from_slice(escape);
                        i.extend_from_slice(&[opcode, modrm, 0x05, 0x90, 0x90, 0x90]);
                        take(i);
                    }
                }
            }
        }
    }
    // VEX: C4 with the map, W and vvvv (xmm2), L and pp
    for map in 1..=3u8 {
        for w in 0..2u8 {
            for l in 0..2u8 {
                for pp in 0..4u8 {
                    let byte1 = 0xE0 | map;
                    let byte2 = w << 7 | (!2u8 & 15) << 3 | l << 2 | pp;
                    for opcode in 0..=255u8 {
                        let regs: &[u8] = if groups(map, opcode, true) {
                            &[0, 1, 2, 3, 4, 5, 6, 7]
                        }
                        else {
                            &[0, 2]
                        };
                        for &reg in regs {
                            for modrm in [0xC1 | reg << 3, 0x01 | reg << 3] {
                                take(vec![0xC4, byte1, byte2, opcode, modrm, 0x05, 0x90, 0x90]);
                            }
                        }
                    }
                }
            }
        }
    }
    records
}
