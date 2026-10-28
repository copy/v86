//! The GLES backdoor of AArch32 user code (docs/gles-proxy-plan.md "iOS
//! 传输", E6): UDF #0x8664 (A32 0xE7F866F4, T32 0xF7F8 0xA664) executed at
//! PL0 with r0's top half 0x8664 is a call of the machine's backdoor device
//! (src/arm/backdoor_a32.js) with r0 to r3: its answer goes to r0 and the
//! PC to the next instruction. Any other UDF, one at PL1, one whose r0 is
//! not a call, or one while the machine has no backdoor (the device answers
//! NOT_HANDLED) is the undefined instruction it always was.
//!
//! The interpreter's undefined path checks for it (crate::aarch64::a32::
//! interpret_one): the page tier's helper of a UDF fails and the instruction
//! is retried there, so compiled code reaches it too.

/// r0's top half for a call
pub const CALL: u32 = 0x8664;
/// The device's answer when there is no backdoor: the UDF stays undefined
pub const NOT_HANDLED: i32 = i32::MIN;

#[cfg(target_arch = "wasm32")]
mod js {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn a32_backdoor(r0: u32, r1: u32, r2: u32, r3: u32) -> i32;
    }
}
// (cargo test: no machine, no backdoor)
#[cfg(not(target_arch = "wasm32"))]
mod js {
    pub unsafe fn a32_backdoor(_r0: u32, _r1: u32, _r2: u32, _r3: u32) -> i32 { super::NOT_HANDLED }
}

/// Whether the undefined instruction `word` (`length` bytes; T32's two
/// halfwords first << 16 | second) is a backdoor call; if it is, the call
/// was made and r0 holds its answer
pub fn call(word: u32, length: u32, thumb: bool) -> bool {
    let encoding = if thumb { length == 4 && word == 0xF7F8_A664 } else { word == 0xE7F8_66F4 };
    if !encoding || crate::aarch64::cpu::el() != 0 {
        return false;
    }
    let reg = crate::aarch64::a32::reg;
    let r0 = reg(0);
    if r0 >> 16 != CALL {
        return false;
    }
    let answer = unsafe { js::a32_backdoor(r0, reg(1), reg(2), reg(3)) };
    if answer == NOT_HANDLED {
        return false;
    }
    crate::aarch64::a32::set_reg(0, answer as u32);
    true
}

/// (the backdoor device) The physical address of user address `va` for a
/// read or a `write` by PL0 code, as the running core translates it; -1: a
/// fault (not mapped, or not allowed), which the guest library resolves by
/// touching the page and calling again
#[no_mangle]
pub fn a32_backdoor_translate(va: u32, write: bool) -> f64 {
    use crate::aarch64::memory::Access;
    if crate::aarch64::cpu::sctlr() & crate::aarch64::cpu::SCTLR_M == 0 {
        return va as f64;
    }
    match crate::aarch64::mmu::translate(va as u64, if write { Access::Write } else { Access::Read }, true, 1) {
        Ok(t) if !t.device => t.pa as f64,
        _ => -1.0,
    }
}
