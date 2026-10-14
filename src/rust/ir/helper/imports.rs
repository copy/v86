//! Audited low-level CPU imports. Generic helper descriptors cannot shadow these.
//! Unlike CpuReload, continuing memory calls do not reload SSA architectural state.
//! Their callbacks must preserve registers/flags/mode; terminal calls own CPU state.
use crate::ir::{
    lowering::CompileError,
    mir::{
        effect::EffectPlan,
        memory::{RuntimeCall, SlowResult},
        MirData,
    },
    types::Type,
};
use crate::wasmgen::wasm_builder::{Signature, WasmType};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    Pure,
    Entry,
    InterruptFinish,
    Fault,
    Packed,
    Ticket,
    TicketValue,
    TicketCommit,
    Check,
    CpuExit,
    X87,
}
#[derive(Clone, Copy, Debug)]
pub struct Contract {
    pub name: &'static str,
    pub params: &'static [WasmType],
    pub results: &'static [WasmType],
    pub protocol: Protocol,
    /// Hidden inputs/outputs are deliberately explicit; they are not pure ABI arguments.
    pub state: &'static str,
}
macro_rules! imports {
    ($($name:literal: [$($p:ident),*] -> [$($r:ident),*], $protocol:ident, $state:literal;)*) => {
        pub const NAMES: &[&str] = &[$($name),*];
        pub const CONTRACTS: &[Contract] = &[$(Contract {name:$name,params:&[$(WasmType::$p),*],results:&[$(WasmType::$r),*],protocol:Protocol::$protocol,state:$state}),*];
    }
}
imports! {
    "ir_diagnostic_address": [] -> [I32], Pure, "address of CPU-local diagnostic sampling flag and exit reason; no guest state";
    "ir_diagnostic_begin": [I32] -> [], Entry, "sampled exclusive timing scope; no guest state or admission epoch changes";
    "ir_diagnostic_end": [] -> [], Entry, "close sampled timing scope; no guest state or admission epoch changes";
    "ir_enter": [] -> [], Entry, "writes previous_ip and REP result";
    "ir_enter_checked": [I32,I32,I32] -> [I32], Entry, "exact context guard then entry initialization; false preserves all CPU/REP state; no source/mapping authority";
    "ir_enter_page": [I32,I32] -> [I32], Entry, "context guard except the PC (checked inline against every page entry) then entry initialization; false preserves all CPU/REP state";
    "ir_request_link": [] -> [], Entry, "sets cold continuation request; no guest state change or dispatch";
    "ir_request_poll_exit": [] -> [], Entry, "marks a recovered non-observing poll exit; never requests chaining or refreshes an epoch";
    "ir_request_observer_link": [] -> [], Entry, "requests cold admission after committed observation; never an SSA fusion edge";
    "ir_admission_barrier": [] -> [], Entry, "revokes synchronous entry-validation certificates before observers; no guest state change";
    "ir_admission_epoch_address": [] -> [I32], Pure, "address of non-shared admission epoch for fused-region recovery polls";
    "ir_sti_no_pending_irq": [] -> [I32], Pure, "read-only conservative PIC/APIC pending check; no CPU state observation, acknowledge or callback";
    "ir_sti_finish": [I32] -> [], InterruptFinish, "IRQ delivery owns CPU state; terminal shadow unwind";
    "ir_sti_finish_link": [I32] -> [], InterruptFinish, "completed shadow unwinds IRQs, revokes admission and requests a cold successor only if control context survives";
    "ir_entry_matches": [I32,I32,I32] -> [I32], Pure, "reads prefixes, mode, CS, IP and halt; no writes";
    "ir_tlb_base": [] -> [I32], Pure, "TLB array address";
    "ir_memory_base": [] -> [I32], Pure, "RAM base address";
    "get_eflags": [] -> [I32], Pure, "reads concrete and lazy flag backing; no writes";
    "ir_read_cf": [] -> [I32], Pure, "reads CF backing; returns bit 0; no writes or callbacks";
    "ir_read_pf": [] -> [I32], Pure, "reads PF backing; returns bit 2; no writes or callbacks";
    "ir_read_af": [] -> [I32], Pure, "reads AF backing; returns bit 4; no writes or callbacks";
    "ir_read_zf": [] -> [I32], Pure, "reads ZF backing; returns bit 6; no writes or callbacks";
    "ir_read_sf": [] -> [I32], Pure, "reads SF backing; returns bit 7; no writes or callbacks";
    "ir_read_of": [] -> [I32], Pure, "reads OF backing; returns bit 11; no writes or callbacks";
    "ir_divide_fault": [] -> [], Fault, "CPU owns #DE delivery; no success continuation";
    "ir_segment_address": [I32,I32] -> [I64], Packed, "segment/null check; high32=0 or 2; CPU owns fault";
    "ir_pop_address": [I32,I32,I32] -> [I64], Packed, "segment/null check; fault also unwinds temporary SP";
    "ir_memory_read": [I32,I32] -> [I64], Packed, "translation, A/D bits and device read; high32=0 or 2";
    "ir_memory_check": [I32,I32,I32] -> [I32], Check, "translation preflight; no device read; returns 0 or 2";
    "ir_alignment_fault": [I32] -> [I32], Check, "raises #GP(0) for a misaligned legacy SSE m128 operand (the address); returns CPU-owned fault 2";
    "ir_sse_guard": [] -> [I32], Check, "reads CR0 TS/EM and CR4.OSFXSR (XMM forms); returns 0 or CPU-owned fault 2";
    "ir_fpu_guard": [] -> [I32], Check, "reads CR0 TS/EM; x87 #NM; returns 0 or CPU-owned fault 2";
    "ir_avx_guard": [] -> [I32], Check, "reads the mode, CR4.OSXSAVE, XCR0 and CR0.TS (VEX forms); returns 0 or CPU-owned fault 2";
    "ir_ymm_zero": [I32] -> [I32], Check, "zeroes bits 255:128 of a YMM register (Op::YmmZero, emitted inline); returns 0";
    "x64_x87": [I32,I32,I32] -> [I64], X87, "the x64 page tier's ir_x87_op: compile-time form and transfer kind, no f64 mirroring";
    "x64_sse_fp": [I32,I32] -> [I32], Check, "the x64 page tier (x64_sse_fast_check): exact SSE floating point on its operand block; MXCSR flags; 1 = would fault, nothing changed";
    "x64_fma": [I32] -> [I32], Check, "the x64 page tier: exact FMA (VEX.128 and scalar) on x64_sse_fp's operand block; MXCSR flags; 1 = would fault, nothing changed";
    "ir_x87_op": [I32,I32,I32,I32] -> [I64], X87, "x87 stack/status/control and f64 shadow cache only; operand words in, stored words out; no fault, exit, GPR/FLAGS or memory access";
    "ir_memory_write": [I32,I32,I32] -> [I32], CpuExit, "ordered write, callbacks, code invalidation; returns 2 or 4; caller retires";
    "ir_memory_write_unmasked_word": [I32,I32,I32] -> [I32], CpuExit, "ENTER16 MMIO compatibility; returns 2 or 4; caller retires";
    "ir_rmw_read": [I32,I32] -> [I64], Ticket, "preflights both write pages before read; publishes RMW_VALUE; MAX=fault";
    "ir_rmw_value": [] -> [I32], TicketValue, "immediate read of RMW_VALUE; no intervening effect permitted";
    "ir_rmw_write": [I64,I32,I32] -> [], TicketCommit, "consumes affine pretranslated ticket; callbacks and invalidation; caller retires";
    "ir_cmpxchg8b": [I32] -> [I32], CpuExit, "reads/writes EAX/EDX/EBX/ECX and ZF; helper retires success; returns 2 or 4";
    "ir_xmm_load": [I32,I32,I32] -> [I32], CpuExit, "reads memory, writes XMM; helper retires; returns 2 or 4";
    "ir_xmm_store": [I32,I32,I32,I32] -> [I32], CpuExit, "reads XMM, writes memory; helper retires; returns 2 or 4";
    "ir_xmm_binary": [I32,I32,I32,I32] -> [I32], CpuExit, "reads memory/XMM, writes XMM; helper retires; returns 2 or 4";
    "ir_xmm_shuffle": [I32,I32,I32,I32] -> [I32], CpuExit, "reads memory/XMM, writes XMM; helper retires; returns 2 or 4";
    "ir_xmm_transfer_load": [I32,I32,I32] -> [I32], CpuExit, "reads memory/XMM, writes XMM; helper retires; returns 2 or 4";
    "ir_xmm_insert_word": [I32,I32,I32] -> [I32], CpuExit, "reads memory/XMM, writes XMM; helper retires; returns 2 or 4";
    "ir_xmm_masked_store": [I32,I32,I32] -> [I32], CpuExit, "reads XMM/mask, ordered partial memory writes; helper retires; returns 2 or 4";
}
fn invalid() -> CompileError {
    CompileError::InvalidIr("low-level CPU import contract mismatch".into())
}
pub fn contract(name: &str) -> Result<&'static Contract, CompileError> {
    CONTRACTS
        .iter()
        .find(|c| c.name == name)
        .ok_or_else(invalid)
}
pub fn signature(name: &str) -> Signature {
    let c = contract(name).expect("registered CPU import");
    Signature::new(c.params, c.results)
}
pub fn validate(name: &str, signature: &Signature, protocol: Protocol) -> Result<(), CompileError> {
    let c = contract(name)?;
    if c.params != signature.params || c.results != signature.results || c.protocol != protocol {
        return Err(invalid());
    }
    Ok(())
}
fn check(call: &RuntimeCall, types: &[Type], protocol: Protocol) -> Result<(), CompileError> {
    use crate::ir::mir::memory::Argument;
    validate(call.name, &call.signature, protocol)?;
    if call.args.len() != call.signature.params.len() {
        return Err(invalid());
    }
    for (arg, param) in call.args.iter().zip(&call.signature.params) {
        let actual = match arg {
            Argument::I32(_) => WasmType::I32,
            Argument::Value(id) => match types.get(id.index()).ok_or_else(invalid)? {
                Type::I1 | Type::I8 | Type::I16 | Type::I32 | Type::LinearAddress => WasmType::I32,
                Type::I64 | Type::RmwTicket => WasmType::I64,
                Type::V128 => WasmType::V128,
                _ => return Err(invalid()),
            },
        };
        if actual != *param {
            return Err(invalid());
        }
    }
    Ok(())
}
pub(crate) fn verify(data: &MirData) -> Result<(), CompileError> {
    for p in data.memory.iter().flatten() {
        let protocol = match &p.result {
            SlowResult::Packed { .. } => Protocol::Packed,
            SlowResult::Rmw { read_value, .. } => {
                check(read_value, &data.value_types, Protocol::TicketValue)?;
                Protocol::Ticket
            },
            SlowResult::Store { .. } | SlowResult::CpuExit { .. } => Protocol::CpuExit,
        };
        check(&p.call, &data.value_types, protocol)?;
    }
    for p in data.effects.iter().flatten() {
        use crate::ir::mir::arithmetic::ArithmeticPlan;
        let protocol = match p {
            EffectPlan::Address { .. } => Protocol::Packed,
            EffectPlan::Check { .. } => Protocol::Check,
            EffectPlan::RmwCommit { .. } => Protocol::TicketCommit,
            EffectPlan::Arithmetic(ArithmeticPlan::Division(_)) => Protocol::Fault,
            EffectPlan::Arithmetic(ArithmeticPlan::CompareExchange(_)) => Protocol::CpuExit,
            EffectPlan::X87 { .. } => Protocol::X87,
            EffectPlan::ZeroState { .. } => Protocol::Check,
        };
        check(p.call(), &data.value_types, protocol)?;
    }
    for p in data.values.iter().flatten() {
        for step in &p.steps {
            use crate::ir::mir::value::{Reading, Step};
            if let Step::Read { cpu, standalone } = step {
                for r in [cpu, standalone] {
                    if let Reading::Call { name, signature } = r {
                        validate(name, signature, Protocol::Pure)?;
                    }
                }
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_registry_rejects_abi_and_outcome_forgery() {
        for (i, c) in CONTRACTS.iter().enumerate() {
            assert!(!c.state.is_empty());
            assert!(!NAMES[..i].contains(&c.name));
            let s = signature(c.name);
            validate(c.name, &s, c.protocol).unwrap();
            let mut broken = s.clone();
            broken.params.push(WasmType::I64);
            assert!(validate(c.name, &broken, c.protocol).is_err());
            let mut broken = s.clone();
            broken.results.push(WasmType::I32);
            assert!(validate(c.name, &broken, c.protocol).is_err());
            let other =
                if c.protocol == Protocol::Pure { Protocol::CpuExit } else { Protocol::Pure };
            assert!(validate(c.name, &s, other).is_err());
        }
        assert!(contract("unregistered_cpu_import").is_err());
    }
}
