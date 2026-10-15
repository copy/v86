//! The step profile (docs/jit-unification-plan.md P0.5): which instructions
//! compiled code leaves to the interpreter (the x64 page tier's; IR Tier-0's
//! too until P7.5), keyed by StepKey v1. Off by default (the JIT switch
//! step_profile); while it is on, every step decodes its instruction's
//! prefixes and opcode into a hash table, so measure in rounds that are not
//! timed (tests/bench/run.mjs --fallbacks). tools/step_profile.mjs names keys.
//!
//! StepKey v1, a u32:
//!
//! | bits  | field |
//! | ----- | ----- |
//! | 0-7   | the opcode byte (after the prefixes, VEX and the escape bytes) |
//! | 8-9   | the opcode map: 0 one-byte, 1 0F, 2 0F 38, 3 0F 3A |
//! | 10-11 | VEX.pp: 0 none, 1 66, 2 F3, 3 F2 |
//! | 12    | VEX.L |
//! | 14    | VEX encoded |
//! | 16    | an F2 or F3 prefix (REP, REPNE, or SSE's mandatory prefix) |
//! | 17    | a retry: compiled code refused an access of the instruction (the x64 page tier) |
//! | 18-20 | ModRM.reg, for an opcode it extends (groups, x87) |
//! | 21    | bits 18-20 are valid |
//! | 22    | a 66 prefix |
//! | 23    | the last F2 or F3 prefix was F2 |
//! | 24    | REX.W |
//! | 25-27 | the mode (x64::state::ExecutionMode: 0 real, 1 virtual-8086, 2 and 3 16- and 32-bit protected, 4 and 5 16- and 32-bit compatibility, 6 64-bit) |
//! | 28-29 | the stepper (Stepper) |
//! | 30-31 | the ISA: 0 x86 (A64 is to take 1, ARM64 plan appendix D item 12) |
//!
//! Bits 13 and 15 are 0. Bits 0-17 alone are the x64 page tier's earlier key,
//! which x64_page_profile_get still reads (x64::pages).
//!
//! Events that are not steps share the store (docs/jit-unification-plan.md
//! P4.0) with the stepper Event: bits 0-7 the event (the `event` module),
//! 8-15 its detail, 25-27 the mode; note_event counts them while the profile
//! is on.

use crate::x64::state::ExecutionMode;
use std::collections::HashMap;

pub const MAP_SHIFT: u32 = 8;
pub const VEX_PP_SHIFT: u32 = 10;
pub const VEX_L: u32 = 1 << 12;
pub const VEX: u32 = 1 << 14;
pub const REP: u32 = 1 << 16;
pub const RETRY: u32 = 1 << 17;
pub const REG_SHIFT: u32 = 18;
pub const GROUP: u32 = 1 << 21;
pub const OPERAND_SIZE: u32 = 1 << 22;
pub const REPNE: u32 = 1 << 23;
pub const REX_W: u32 = 1 << 24;
pub const MODE_SHIFT: u32 = 25;
pub const STEPPER_SHIFT: u32 = 28;
pub const ISA_SHIFT: u32 = 30;
/// The bits of the x64 page tier's earlier key
pub const X64_LEGACY_BITS: u32 = 0x3_5FFF;

/// Who stepped the instruction (Event: not a step, see `event`; 0 was IR
/// Tier-0's until P7.5 deleted it)
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stepper {
    X64Page = 1,
    Event = 2,
}

/// Events counted in the step profile's store (P4.0), with their details;
/// tools/step_profile.mjs names them
pub mod event {
    /// The x64 page tier did not run a function at RIP: MISS_*
    pub const MISS: u32 = 1;
    pub const MISS_DISABLED: u32 = 1;
    pub const MISS_NO_CODE: u32 = 2;
    pub const MISS_COLD: u32 = 3;
    pub const MISS_COMPILING: u32 = 4;
    /// (attempts that compile: the page got hot, an unserved offset is due)
    pub const MISS_COMPILE: u32 = 5;
    pub const MISS_RECOMPILE: u32 = 6;
    /// a function entered at an offset it does not serve, which steps to its
    /// next block start
    pub const MISS_UNSERVED: u32 = 7;
    /// (not allowed, x64::pages::allowed: MISS_DISABLED is the tier or the
    /// JIT off, deterministic execution or no budget) an interrupt
    /// shadow; TF or RF; DR7 breakpoints; core events, an NMI or an SMI
    /// pending; HLT
    pub const MISS_SHADOW: u32 = 8;
    pub const MISS_TRAP_FLAGS: u32 = 9;
    pub const MISS_BREAKPOINTS: u32 = 10;
    pub const MISS_EVENTS: u32 = 11;
    pub const MISS_HALT: u32 = 12;
    /// Why a page function returned: EXIT_*
    pub const EXIT: u32 = 2;
    pub const EXIT_RETRY: u32 = 1;
    pub const EXIT_UNKNOWN: u32 = 2;
    /// a step ended the activation (STEP_EXIT says why)
    pub const EXIT_STEP: u32 = 3;
    pub const EXIT_BUDGET: u32 = 4;
    /// it left the code it serves (a target outside, not chained)
    pub const EXIT_LEAVE: u32 = 5;
    /// Why a step ended its activation (x64::pages::x64_page_step): the
    /// first of STEP_EXIT_*; CHAINABLE: only the CPL, CS, CR3, the epoch, IF,
    /// IOPL or AC changed (P4.3's STEP_CHAIN could continue)
    pub const STEP_EXIT: u32 = 3;
    pub const STEP_EXIT_HALT: u32 = 1;
    pub const STEP_EXIT_YIELD: u32 = 2;
    pub const STEP_EXIT_SHADOW: u32 = 3;
    pub const STEP_EXIT_CORE_EVENT: u32 = 4;
    pub const STEP_EXIT_CODE_WRITE: u32 = 5;
    pub const STEP_EXIT_IRQ: u32 = 6;
    pub const STEP_EXIT_NMI: u32 = 7;
    /// the mode, CR0, CR4, EFER, DR7, TF, VM or RF changed
    pub const STEP_EXIT_BARRIER: u32 = 8;
    pub const STEP_EXIT_CHAINABLE: u32 = 9;
    /// Each part of a step's context that changed: STEP_CONTEXT_*
    pub const STEP_CONTEXT: u32 = 4;
    pub const STEP_CONTEXT_CPL: u32 = 1;
    pub const STEP_CONTEXT_CS: u32 = 2;
    pub const STEP_CONTEXT_MODE: u32 = 3;
    pub const STEP_CONTEXT_CR0: u32 = 4;
    pub const STEP_CONTEXT_CR3: u32 = 5;
    pub const STEP_CONTEXT_CR4: u32 = 6;
    pub const STEP_CONTEXT_EFER: u32 = 7;
    pub const STEP_CONTEXT_IF: u32 = 8;
    pub const STEP_CONTEXT_TF: u32 = 9;
    pub const STEP_CONTEXT_AC: u32 = 10;
    pub const STEP_CONTEXT_VM: u32 = 11;
    pub const STEP_CONTEXT_RF: u32 = 12;
    pub const STEP_CONTEXT_IOPL: u32 = 13;
    pub const STEP_CONTEXT_DR7: u32 = 14;
    pub const STEP_CONTEXT_EPOCH: u32 = 15;
    // (5 was STARVED: P4.6's long-mode frames with IR Tier-0 pages ready,
    // deleted with Tier-0 by P7.5)
    /// #NM delivered; CLTS; a MOV to CR0 that changed TS (the plan's open
    /// question 5: lazy FPU switching)
    pub const NM: u32 = 6;
    pub const CLTS: u32 = 7;
    pub const CR0_TS: u32 = 8;
    /// FXSAVE (detail 0), FXRSTOR (1), the XSAVE family (2) and XRSTOR (3)
    pub const FXSTATE: u32 = 9;
    /// A read of the HPET's registers; of the ACPI PM timer (open question 4:
    /// what QueryPerformanceCounter reads)
    pub const HPET_READ: u32 = 10;
    pub const PM_TIMER_READ: u32 = 11;
    // (12 was FRAME: a CPU frame began, begin_cpu_frame's, deleted with the
    // region scheduler in M11)
    // (src/hpet.js and src/acpi.js pass these numbers)
    const _: () = assert!(HPET_READ == 10 && PM_TIMER_READ == 11);
}

/// StepKeys and how often they were stepped; None while the profile is off
static mut PROFILE: Option<HashMap<u32, u32>> = None;
/// A sample of each key of a step: the last stepped instruction's linear
/// address and first 8 bytes (step_profile_sample: what the key's steps
/// were, such as a template's refused access)
static mut SAMPLES: Option<HashMap<u32, (u32, [u8; 8])>> = None;
/// The profile sorted by count, most stepped first (step_profile_snapshot)
static mut SNAPSHOT: Vec<(u32, u32)> = Vec::new();
/// The x64 page tier's earlier keys summed from the profile
/// (x64_legacy_count), and whether a step came since
static mut X64_LEGACY: Vec<u32> = Vec::new();
static mut X64_LEGACY_STALE: bool = true;

#[inline(always)]
pub fn enabled() -> bool { unsafe { (*(&raw const PROFILE)).is_some() } }

/// Off: the profile is dropped; on: an empty one unless it was on
/// (step_profile_reset empties it)
pub unsafe fn set_enabled(on: bool) {
    if on != enabled() {
        PROFILE = on.then(HashMap::new);
        SAMPLES = None;
        PAIRS = Vec::new();
        PAIRS_FROZEN = false;
        X64_LEGACY_STALE = true;
    }
}

#[no_mangle]
pub unsafe fn step_profile_reset() {
    if let Some(profile) = (*(&raw mut PROFILE)).as_mut() {
        profile.clear();
    }
    SAMPLES = None;
    PAIRS = Vec::new();
    PAIRS_FROZEN = false;
    X64_LEGACY_STALE = true;
}

/// Count `event` with `detail` (the `event` module) while the profile is on
pub unsafe fn note_event(event: u32, detail: u32) {
    if enabled() {
        note(
            (Stepper::Event as u32) << STEPPER_SHIFT
                | (crate::x64::state::mode() as u32) << MODE_SHIFT
                | (detail & 255) << 8
                | event & 255,
        );
    }
}
/// note_event for devices in JS (the HPET, the ACPI PM timer)
#[no_mangle]
pub unsafe fn step_profile_note_event(event: u32, detail: u32) { note_event(event, detail) }

pub unsafe fn note(key: u32) {
    if let Some(profile) = (*(&raw mut PROFILE)).as_mut() {
        *profile.entry(key).or_default() += 1;
        X64_LEGACY_STALE = true;
    }
}

/// Sort the profile into a snapshot, most stepped first: its length
#[no_mangle]
pub unsafe fn step_profile_snapshot() -> u32 {
    let snapshot = &mut *(&raw mut SNAPSHOT);
    snapshot.clear();
    if let Some(profile) = (*(&raw const PROFILE)).as_ref() {
        snapshot.extend(profile.iter().map(|(&key, &count)| (key, count)));
    }
    snapshot.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    snapshot.len() as u32
}
/// The StepKey of the snapshot's entry `index`
#[no_mangle]
pub unsafe fn step_profile_key(index: u32) -> u32 {
    (&*(&raw const SNAPSHOT))
        .get(index as usize)
        .map_or(0, |e| e.0)
}
/// The count of the snapshot's entry `index`
#[no_mangle]
pub unsafe fn step_profile_count(index: u32) -> u32 {
    (&*(&raw const SNAPSHOT))
        .get(index as usize)
        .map_or(0, |e| e.1)
}
/// The count of `key` now
#[no_mangle]
pub unsafe fn step_profile_get(key: u32) -> u32 {
    (*(&raw const PROFILE))
        .as_ref()
        .and_then(|p| p.get(&key).copied())
        .unwrap_or(0)
}

/// The x64 page tier's steps of its earlier key `legacy` (bits 0-17 of
/// StepKey), summed over the other fields
pub unsafe fn x64_legacy_count(legacy: u32) -> u32 {
    let sums = &mut *(&raw mut X64_LEGACY);
    if X64_LEGACY_STALE {
        sums.clear();
        sums.resize(1 << 18, 0);
        if let Some(profile) = (*(&raw const PROFILE)).as_ref() {
            for (&key, &count) in profile {
                if key >> STEPPER_SHIFT & 3 == Stepper::X64Page as u32 && key >> ISA_SHIFT == 0 {
                    let slot = &mut sums[(key & X64_LEGACY_BITS) as usize];
                    *slot = slot.wrapping_add(count);
                }
            }
        }
        X64_LEGACY_STALE = false;
    }
    sums.get(legacy as usize).copied().unwrap_or(0)
}

/// Opcodes whose ModRM.reg field selects the operation: `map` as in
/// StepKey, `vex` for the VEX-encoded forms
fn extends_opcode(map: u32, opcode: u8, vex: bool) -> bool {
    match (map, vex) {
        (0, false) => matches!(
            opcode,
            0x80..=0x83 | 0x8F | 0xC0 | 0xC1 | 0xC6 | 0xC7 | 0xD0..=0xD3 | 0xD8..=0xDF | 0xF6 | 0xF7 | 0xFE | 0xFF
        ),
        (1, false) => matches!(
            opcode,
            0x00 | 0x01 | 0x0D | 0x18 | 0x1F | 0x71..=0x73 | 0xAE | 0xB9 | 0xBA | 0xC7
        ),
        (1, true) => matches!(opcode, 0x71..=0x73 | 0xAE),
        (2, true) => opcode == 0xF3,
        _ => false,
    }
}

/// The StepKey of the x86 instruction whose first bytes are `bytes` (fewer
/// than 15 when the rest could not be read without side effects)
pub fn x86_key(bytes: &[u8], mode: ExecutionMode, stepper: Stepper, retry: bool) -> u32 {
    let mut key = (mode as u32) << MODE_SHIFT
        | (stepper as u32) << STEPPER_SHIFT
        | if retry { RETRY } else { 0 };
    let long = mode == ExecutionMode::Long64;
    let mut at = 0;
    while let Some(&b) = bytes.get(at) {
        match b {
            0x26 | 0x2E | 0x36 | 0x3E | 0x64 | 0x65 | 0x67 | 0xF0 => {},
            0x66 => key |= OPERAND_SIZE,
            0xF2 => key |= REP | REPNE,
            0xF3 => key = key & !REPNE | REP,
            // (REX counts only right before the opcode)
            0x40..=0x4F if long => {
                key &= !REX_W;
                if b & 8 != 0 && !matches!(bytes.get(at + 1), Some(0x40..=0x4F)) {
                    key |= REX_W;
                }
            },
            _ => break,
        }
        at += 1;
    }
    let byte = |i: usize| bytes.get(at + i).copied();
    let Some(first) = byte(0)
    else {
        return key;
    };
    // C4 and C5 are LES and LDS in real and virtual-8086 mode, and outside
    // 64-bit mode unless their next byte would be a register ModRM
    let vex = matches!(first, 0xC4 | 0xC5)
        && (long
            || !matches!(mode, ExecutionMode::Real | ExecutionMode::Vm86)
                && byte(1).is_some_and(|b| b >> 6 == 3));
    let (map, opcode, modrm) = if vex {
        let Some(b1) = byte(1)
        else {
            return key;
        };
        let (map, b, rest) = if first == 0xC5 {
            (1, b1, 2)
        }
        else {
            let Some(b2) = byte(2)
            else {
                return key;
            };
            if b2 & 0x80 != 0 {
                key |= REX_W;
            }
            ((b1 & 3) as u32, b2, 3)
        };
        key |= VEX | (b as u32 & 3) << VEX_PP_SHIFT | if b & 4 != 0 { VEX_L } else { 0 };
        (map, byte(rest), byte(rest + 1))
    }
    else if first == 0x0F {
        match byte(1) {
            Some(0x38) => (2, byte(2), byte(3)),
            Some(0x3A) => (3, byte(2), byte(3)),
            b => (1, b, byte(2)),
        }
    }
    else {
        (0, Some(first), byte(1))
    };
    key |= map << MAP_SHIFT;
    let Some(opcode) = opcode
    else {
        return key;
    };
    key |= opcode as u32;
    if let Some(modrm) = modrm.filter(|_| extends_opcode(map, opcode, vex)) {
        key |= GROUP | (modrm as u32 >> 3 & 7) << REG_SHIFT;
    }
    key
}

/// The bytes of the instruction at linear `address` in legacy and
/// compatibility mode, whose first byte is at `physical` (a RAM address): as
/// many as translate without side effects to RAM, at most 15
pub unsafe fn read_legacy(address: u32, physical: u32, bytes: &mut [u8; 15]) -> usize {
    use crate::cpu::{cpu, memory};
    let mut page = (address & !0xFFF, physical & !0xFFF);
    for i in 0..15 {
        let linear = address.wrapping_add(i as u32);
        if linear & !0xFFF != page.0 {
            let Ok(next) = cpu::translate_address_read_no_side_effects(linear as i32)
            else {
                return i;
            };
            if memory::in_mapped_range(next) {
                return i;
            }
            page = (linear & !0xFFF, next & !0xFFF);
        }
        bytes[i] = *memory::mem8.add((page.1 | linear & 0xFFF) as usize);
    }
    15
}

/// Steps by their first two bytes (little-endian, as IR Tier-0 counted
/// them before P7.5): the ISA tests' check that a form ran as a template
static mut PAIRS: Vec<u32> = Vec::new();
/// x64_page_steps_freeze: PAIRS keep their counts until the next reset
static mut PAIRS_FROZEN: bool = false;
pub unsafe fn freeze_pairs() { PAIRS_FROZEN = true; }
pub unsafe fn pair_count(pair: u32) -> u32 {
    (&*(&raw const PAIRS))
        .get(pair as usize & 0xFFFF)
        .copied()
        .unwrap_or(0)
}

/// note(key) of a step at linear `address`, whose bytes begin with `bytes`:
/// they are the key's sample (step_profile_sample)
pub unsafe fn note_sampled(key: u32, address: u32, bytes: &[u8]) {
    note(key);
    if let Some(&b0) = bytes.first().filter(|_| !PAIRS_FROZEN) {
        let pairs = &mut *(&raw mut PAIRS);
        pairs.resize(0x10000, 0);
        let pair = b0 as usize | (*bytes.get(1).unwrap_or(&0) as usize) << 8;
        pairs[pair] = pairs[pair].wrapping_add(1);
    }
    let mut first = [0; 8];
    let n = bytes.len().min(8);
    first[..n].copy_from_slice(&bytes[..n]);
    (*(&raw mut SAMPLES))
        .get_or_insert_with(HashMap::new)
        .insert(key, (address, first));
}
/// The sample of the snapshot's entry `index`: 0, the linear
/// address; 1 and 2, the instruction's bytes 0-3 and 4-7 (little-endian);
/// 0 without one
#[no_mangle]
pub unsafe fn step_profile_sample(index: u32, which: u32) -> u32 {
    let Some(&(key, _)) = (&*(&raw const SNAPSHOT)).get(index as usize)
    else {
        return 0;
    };
    let Some(&(address, bytes)) = (*(&raw const SAMPLES)).as_ref().and_then(|s| s.get(&key))
    else {
        return 0;
    };
    match which {
        0 => address,
        1 => u32::from_le_bytes(bytes[..4].try_into().unwrap()),
        _ => u32::from_le_bytes(bytes[4..].try_into().unwrap()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ExecutionMode::*;

    fn key(bytes: &[u8], mode: ExecutionMode) -> u32 {
        x86_key(bytes, mode, Stepper::X64Page, false) & ((1 << MODE_SHIFT) - 1)
    }

    #[test]
    fn opcodes_maps_and_prefixes() {
        assert_eq!(key(&[0x0F, 0xA2], Protected32), 1 << MAP_SHIFT | 0xA2);
        assert_eq!(key(&[0xF3, 0xA5], Protected32), REP | 0xA5);
        assert_eq!(key(&[0xF3, 0xF2, 0xA6], Protected32), REP | REPNE | 0xA6);
        assert_eq!(key(&[0xF2, 0xF3, 0xA6], Protected32), REP | 0xA6);
        assert_eq!(
            key(&[0x66, 0x0F, 0x38, 0x00, 0xC1], Protected32),
            OPERAND_SIZE | 2 << MAP_SHIFT
        );
        assert_eq!(
            key(&[0x0F, 0x3A, 0x0F, 0xC1, 1], Protected32),
            3 << MAP_SHIFT | 0x0F
        );
        // group opcodes carry ModRM.reg: FF /2 (CALL), 0F AE /5 (LFENCE)
        assert_eq!(
            key(&[0xFF, 0xD0], Protected32),
            GROUP | 2 << REG_SHIFT | 0xFF
        );
        assert_eq!(
            key(&[0x0F, 0xAE, 0xE8], Protected32),
            GROUP | 5 << REG_SHIFT | 1 << MAP_SHIFT | 0xAE
        );
        assert_eq!(key(&[0x8B, 0xC0], Protected32), 0x8B);
    }

    #[test]
    fn rex_and_vex() {
        // REX is a prefix in 64-bit mode only, and only right before the opcode
        assert_eq!(
            key(&[0x48, 0x0F, 0xA2], Long64),
            REX_W | 1 << MAP_SHIFT | 0xA2
        );
        assert_eq!(key(&[0x48, 0x40, 0x99], Long64), 0x99);
        assert_eq!(key(&[0x48, 0x99], Protected32), 0x48);
        // VEX.256.66.0F38 18 (VBROADCASTSS) and VEX.128.F2.0F 10, W1
        assert_eq!(
            key(&[0xC4, 0xE2, 0x7D, 0x18, 0xC1], Long64),
            VEX | VEX_L | 1 << VEX_PP_SHIFT | 2 << MAP_SHIFT | 0x18
        );
        assert_eq!(
            key(&[0xC4, 0xE1, 0xFB, 0x10, 0xC1], Long64),
            VEX | REX_W | 3 << VEX_PP_SHIFT | 1 << MAP_SHIFT | 0x10
        );
        assert_eq!(
            key(&[0xC5, 0xF8, 0x77], Protected32),
            VEX | 1 << MAP_SHIFT | 0x77
        );
        // LES and LDS: a memory operand outside 64-bit mode, and in real mode
        assert_eq!(key(&[0xC4, 0x06, 0x00, 0x10], Protected32), 0xC4);
        assert_eq!(key(&[0xC5, 0xF8, 0x77], Real), 0xC5);
        // BLSR (VEX.0F38 F3 /1) is a group
        assert_eq!(
            key(&[0xC4, 0xE2, 0x78, 0xF3, 0xC9], Protected32),
            VEX | GROUP | 1 << REG_SHIFT | 2 << MAP_SHIFT | 0xF3
        );
    }

    #[test]
    fn header_fields() {
        let k = x86_key(&[0x90], Compatibility32, Stepper::X64Page, true);
        assert_eq!(k >> MODE_SHIFT & 7, Compatibility32 as u32);
        assert_eq!(k >> STEPPER_SHIFT & 3, Stepper::X64Page as u32);
        assert_eq!(k >> ISA_SHIFT, 0);
        assert_eq!(k & X64_LEGACY_BITS, RETRY | 0x90);
        // a truncated read keeps the prefixes
        assert_eq!(key(&[0xF3], Protected32), REP);
        assert_eq!(key(&[0x0F], Protected32), 1 << MAP_SHIFT);
    }
}
