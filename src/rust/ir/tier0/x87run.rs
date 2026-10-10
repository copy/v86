//! Tier-0's runs of register-only x87 forms (x86tpl::x87run): the checks
//! the per-form path makes, then the shared run.
use super::{Instruction, Page};
use crate::cpu::global_pointers as gp;
use crate::wasmgen::wasm_builder::Label;
use crate::x86tpl::x87run::{x87_run, X87Run};

/// Add `i` to `run` (X87Run::append)
pub(super) fn append(run: &mut X87Run, i: &Instruction) -> bool {
    let d = &i.decoded;
    let (opcode, Some(modrm)) = (d.encoding.opcode, d.modrm)
    else {
        return false;
    };
    d.ea.is_none() && (0xD8..=0xDF).contains(&opcode) && run.append(opcode as u8, modrm)
}

impl Page {
    /// Emit the run's fast path: to `slow` unless the guard holds, else the
    /// run's effect on the (open) x87 cache and the f64 shadow values.
    pub(super) fn x87_run(&mut self, plan: &X87Run, slow: Label) {
        // #NM/#UD and the native policy: the per-form path decides.
        self.w.load_fixed_i32(gp::cr as u32);
        self.w
            .const_i32(crate::cpu::cpu::CR0_EM | crate::cpu::cpu::CR0_TS);
        self.w.and_i32();
        self.w.hint(false);
        self.w.br_if(slow);
        self.w.load_fixed_u8(gp::x87_native_policy as u32);
        self.w.eqz_i32();
        self.w.hint(false);
        self.w.br_if(slow);
        let c = self.x87.unsafe_clone();
        x87_run(&mut self.w, &c, plan, slow);
    }
}
