//! Record and replay of x64 page tier compilations
//! (docs/jit-unification-plan.md P2.0, cross-phase rule 4), in test builds
//! (ir-test-hooks), as ir::tier0::replay for Tier-0: a record holds every
//! input of pagegen::compile_with but the addresses, which replay pins
//! (pagegen::CompileEnv::replay). tools/replay_check.mjs compares a base
//! build's bytes with the working tree's.
//!
//! A record, little-endian: "X6R1"; flags (bit 0: the recording build's
//! parallel memory, then bucket dispatch, block counts, outlined accesses,
//! chaining, relaxed FMA, the conversion templates, the STI shadow); the
//! entries (count u16, then each offset u16, bit 15 a guess:
//! pagegen::GUESSED); the next page's first bytes
//! (count u16, then them); the page (4096 bytes); the function's name
//! (length u16, then it); a trailer that older records lack (u8: the
//! execution counter, loops, XMM locals, the fast SSE checks, 32-bit
//! operations in i32, the fast lookups, the chained GPRs, EFLAGS by what
//! observes them; u16: the access cache's entries; u8: the code's mode, 1
//! for 32-bit compatibility mode, bit 1 its lookups in the 32-bit TLB).

use super::pagegen::{compile_with, CompileEnv};
use crate::wasmgen::wasm_builder::WasmBuilder;

const MAGIC: &[u8; 4] = b"X6R1";

static mut RECORDS: Option<Vec<Vec<u8>>> = None;
/// What each recorded compilation made, as it ran (its own addresses, not
/// replay's pinned ones; empty for a failed one): tools/page_profile.mjs
/// maps profiler ticks onto it
static mut OUTPUTS: Option<Vec<Vec<u8>>> = None;
static mut INPUT: Vec<u8> = Vec::new();
static mut OUTPUT: Vec<u8> = Vec::new();

fn encode(env: &CompileEnv, bytes: &[u8], next: &[u8], entries: &[u16], name: &str) -> Vec<u8> {
    let mut r = Vec::with_capacity(4200);
    r.extend_from_slice(MAGIC);
    r.push(
        WasmBuilder::ATOMIC_GUEST_MEMORY as u8
            | (env.bucket_dispatch as u8) << 1
            | (env.block_count as u8) << 2
            | (env.outline as u8) << 3
            | (env.chaining as u8) << 4
            | (env.relaxed_fma as u8) << 5
            | (env.cvt as u8) << 6
            | (env.sti_shadow as u8) << 7,
    );
    r.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for &e in entries {
        r.extend_from_slice(&e.to_le_bytes());
    }
    r.extend_from_slice(&(next.len() as u16).to_le_bytes());
    r.extend_from_slice(next);
    r.extend_from_slice(bytes);
    r.extend_from_slice(&(name.len() as u16).to_le_bytes());
    r.extend_from_slice(name.as_bytes());
    // (a trailer, absent from older records: the execution counter, P4.14;
    // loops, P4.16; XMM locals, P4.17; the fast SSE checks, P4.18; 32-bit
    // operations in i32, P4.20; the fast lookups, P4.21; the chained
    // GPRs, P4.22; EFLAGS by what observes them, P4.23; the access cache's
    // entries, P4.15)
    r.push(
        env.counter.is_some() as u8
            | (env.loops as u8) << 1
            | (env.xmm_locals as u8) << 2
            | (env.sse_fast_check as u8) << 3
            | (env.i32_ops as u8) << 4
            | (env.fast_lookup as u8) << 5
            | (env.fast_chain as u8) << 6
            | (env.exit_flags as u8) << 7,
    );
    r.extend_from_slice(&(env.jac_entries as u16).to_le_bytes());
    // (P7.2: the code's mode, absent from older records; bit 1: its
    // lookups in the 32-bit TLB, x64_compat_tlb)
    r.push(env.compat as u8 | (env.compat_tlb as u8) << 1);
    r
}

struct Reader<'a>(&'a [u8]);
impl Reader<'_> {
    fn bytes(&mut self, n: usize) -> Option<&[u8]> {
        let (head, rest) = (self.0.get(..n)?, self.0.get(n..)?);
        self.0 = rest;
        Some(head)
    }
    fn u16(&mut self) -> Option<u16> { Some(u16::from_le_bytes(self.bytes(2)?.try_into().ok()?)) }
}

/// The page function's bytes for a record under CompileEnv::replay, or None
pub fn replay(record: &[u8]) -> Option<Vec<u8>> {
    let mut r = Reader(record);
    if r.bytes(4)? != MAGIC {
        return None;
    }
    let flags = r.bytes(1)?[0];
    if flags & 1 != WasmBuilder::ATOMIC_GUEST_MEMORY as u8 {
        return None;
    }
    let bit = |n: u8| flags & 1 << n != 0;
    let mut entries = Vec::new();
    for _ in 0..r.u16()? {
        entries.push(r.u16()?);
    }
    let count = r.u16()? as usize;
    let next = r.bytes(count)?.to_vec();
    let bytes = r.bytes(4096)?.to_vec();
    let count = r.u16()? as usize;
    let name = String::from_utf8(r.bytes(count)?.to_vec()).ok()?;
    let trailer = r.bytes(1).map_or(0, |b| b[0]);
    let (counting, loops, xmm_locals, sse_fast_check, i32_ops, fast_lookup, fast_chain) = (
        trailer & 1 != 0,
        trailer & 2 != 0,
        trailer & 4 != 0,
        trailer & 8 != 0,
        trailer & 16 != 0,
        trailer & 32 != 0,
        trailer & 64 != 0,
    );
    let exit_flags = trailer & 128 != 0;
    let jac_entries = r.u16().map_or(1024, u32::from);
    let mode = r.bytes(1).map_or(0, |b| b[0]);
    let (compat, compat_tlb) = (mode & 1 != 0, mode & 2 != 0);
    let env = CompileEnv::replay(
        bit(1),
        bit(2),
        bit(3),
        bit(4),
        bit(5),
        bit(6),
        bit(7),
        counting,
        jac_entries,
        loops,
        xmm_locals,
        sse_fast_check,
        i32_ops,
        fast_lookup,
        fast_chain,
        exit_flags,
        compat,
        compat_tlb,
    );
    compile_with(&env, &bytes, &next, &entries, name).map(|compiled| compiled.bytes)
}

/// pagegen::compile's inputs into the recording, when recording
pub fn record(env: &CompileEnv, bytes: &[u8], next: &[u8], entries: &[u16], name: &str) {
    if let Some(records) = unsafe { (*(&raw mut RECORDS)).as_mut() } {
        records.push(encode(env, bytes, next, entries, name));
    }
}
/// What the compilation just recorded made (OUTPUTS)
pub fn record_output(module: &[u8]) {
    if let Some(outputs) = unsafe { (*(&raw mut OUTPUTS)).as_mut() } {
        outputs.push(module.to_vec());
    }
}

#[no_mangle]
pub unsafe fn x64_page_record_start() {
    RECORDS = Some(Vec::new());
    OUTPUTS = Some(Vec::new());
}
#[no_mangle]
pub unsafe fn x64_page_record_stop() {
    RECORDS = None;
    OUTPUTS = None;
}
/// The module record `index`'s compilation made (OUTPUTS; not for the
/// corpus, which has no outputs): its address and length
#[no_mangle]
pub unsafe fn x64_page_record_output_address(index: u32) -> u32 {
    (*(&raw const OUTPUTS))
        .as_ref()
        .and_then(|o| o.get(index as usize))
        .map_or(0, |o| o.as_ptr() as u32)
}
#[no_mangle]
pub unsafe fn x64_page_record_output_length(index: u32) -> u32 {
    (*(&raw const OUTPUTS))
        .as_ref()
        .and_then(|o| o.get(index as usize))
        .map_or(0, |o| o.len() as u32)
}
#[no_mangle]
pub unsafe fn x64_page_record_count() -> u32 {
    (*(&raw const RECORDS))
        .as_ref()
        .map_or(0, |r| r.len() as u32)
}
#[no_mangle]
pub unsafe fn x64_page_record_address(index: u32) -> u32 {
    (*(&raw const RECORDS))
        .as_ref()
        .and_then(|r| r.get(index as usize))
        .map_or(0, |r| r.as_ptr() as u32)
}
#[no_mangle]
pub unsafe fn x64_page_record_length(index: u32) -> u32 {
    (*(&raw const RECORDS))
        .as_ref()
        .and_then(|r| r.get(index as usize))
        .map_or(0, |r| r.len() as u32)
}
/// Replace the records by the synthetic corpus: one page per form the SSE
/// templates take. Returns their number.
#[no_mangle]
pub unsafe fn x64_page_record_corpus() -> u32 {
    let records = corpus();
    let n = records.len() as u32;
    RECORDS = Some(records);
    n
}
#[no_mangle]
pub unsafe fn x64_page_replay_input(length: u32) -> u32 {
    let input = &mut *(&raw mut INPUT);
    input.clear();
    input.resize(length as usize, 0);
    input.as_ptr() as u32
}
#[no_mangle]
pub unsafe fn x64_page_replay() -> u32 {
    let output = &mut *(&raw mut OUTPUT);
    *output = replay(&*(&raw const INPUT)).unwrap_or_default();
    output.len() as u32
}
#[no_mangle]
pub unsafe fn x64_page_replay_output() -> u32 { (*(&raw const OUTPUT)).as_ptr() as u32 }

/// One record per form the SSE templates take (pagegen::sse): the
/// instruction at the start of a page, then RET. Candidates: the 0F, 0F 38
/// and 0F 3A maps with no, 66, F2 or F3 prefix and with no REX, REX.W or
/// REX.R, and the VEX maps with each pp, L and W; each opcode with a
/// register and a memory ([rcx]) operand, ModRM reg 0 and 2 (all eight for
/// opcode groups), and an immediate byte.
pub fn corpus() -> Vec<Vec<u8>> {
    // (the templates of every switch, so that their bytes are pinned)
    let env = CompileEnv::replay(
        true, true, true, false, false, true, false, false, 1024, false, false, true, false, false,
        false, false, false, false,
    );
    let mut records = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut take = |instruction: Vec<u8>| {
        let Some(length) = super::pagegen::sse_template(&instruction)
        else {
            return;
        };
        if !seen.insert(instruction[..length].to_vec()) {
            return;
        }
        let mut page = vec![0xCC; 4096];
        page[..length].copy_from_slice(&instruction[..length]);
        page[length] = 0xC3;
        records.push(encode(&env, &page, &[], &[0], "x64_corpus"));
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
            for rex in [None, Some(0x48u8), Some(0x44)] {
                for opcode in 0..=255u8 {
                    let regs: &[u8] = if groups(map, opcode, false) {
                        &[0, 1, 2, 3, 4, 5, 6, 7]
                    }
                    else {
                        &[0, 2]
                    };
                    for &reg in regs {
                        for modrm in [0xC1 | reg << 3, 0x01 | reg << 3] {
                            let mut i: Vec<u8> = prefix.into_iter().chain(rex).collect();
                            i.extend_from_slice(escape);
                            i.extend_from_slice(&[opcode, modrm, 0x05, 0x90, 0x90, 0x90]);
                            take(i);
                        }
                    }
                }
            }
        }
    }
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
