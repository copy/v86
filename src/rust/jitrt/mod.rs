//! The ISA-neutral runtime of compiled code (docs/jit-unification-plan.md
//! P5, J1a): the Wasm table's slots and their owners (table), the guest
//! pages compiled code was made from and the listeners that hear of writes
//! to them (watch), publication (publish), the slot budget (capacity),
//! execution heat (heat) and the clients' statistics (stat); J1b: single
//! steps (step).
//!
//! Its clients are the ISAs' page tiers: `X86Page` (crate::x64::pages, the
//! only x86 compiler since M11 deleted the IR region tiers) in the x86 core,
//! `A64Page` in the ARM core (docs/arm64-virt-android16-plan.md). Each core
//! registers only its own ISA's clients; its composition root (crate::jit
//! for x86) fills host::Env and registers the listeners. The hot-path
//! compositions (crate::jit::page_watched) stay in the composition root.
//!
//! Imports: std, crate::page, crate::wasmgen and crate::leb only, nothing of
//! an ISA, the CPU or the host's modules; no `feature = "aarch64"`: ISA
//! differences come through host::Env or type parameters
//! (tools/check_x86tpl_imports.mjs checks it, in make jit-gate).

pub mod access;
pub mod capacity;
pub mod chain;
pub mod heat;
pub mod host;
pub mod page;
pub mod publish;
pub mod stat;
pub mod step;
pub mod table;
pub mod watch;

use std::mem::MaybeUninit;
use std::ops::{Deref, DerefMut};
use std::sync::{Mutex, MutexGuard};

/// A client of the runtime: an ISA's page tier
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
#[repr(u8)]
pub enum ClientId {
    X86Page = 0,
    // (the ARM core's: docs/arm64-virt-android16-plan.md, J2)
    #[allow(dead_code)]
    A64Page = 1,
}
impl ClientId {
    pub fn of(n: u32) -> Option<ClientId> {
        match n {
            0 => Some(ClientId::X86Page),
            1 => Some(ClientId::A64Page),
            _ => None,
        }
    }
}

/// The table and the watched pages of one core instance
pub struct State {
    pub table: table::Table,
    pub watch: watch::Watch,
}

static STATE: Mutex<MaybeUninit<State>> = Mutex::new(MaybeUninit::uninit());

pub struct StateRef(MutexGuard<'static, MaybeUninit<State>>);
impl Deref for StateRef {
    type Target = State;
    fn deref(&self) -> &State { unsafe { self.0.assume_init_ref() } }
}
impl DerefMut for StateRef {
    fn deref_mut(&mut self) -> &mut State { unsafe { self.0.assume_init_mut() } }
}
/// The runtime's state (init first)
pub fn state() -> StateRef { StateRef(STATE.try_lock().unwrap()) }

/// Once, with the host's environment: an empty table of its size, nothing
/// watched
pub fn init(env: host::Env) {
    let size = env.table_size;
    host::set(env);
    let _ = STATE.try_lock().unwrap().write(State {
        table: table::Table::new(size),
        watch: watch::Watch::new(),
    });
}
