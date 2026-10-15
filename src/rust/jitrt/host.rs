//! What the runtime needs of its host (P5.1), filled once at initialisation
//! by the core's composition root (crate::jit::rust_init): the table's
//! geometry and the host's services, which jitrt may not import itself.
//! (The ARM64 plan's P1.0 moves the host imports that both cores use out of
//! crate::cpu; until then the composition root passes the CPU's.)

use crate::page::Page;

// (the geometry and services that the ARM core's client uses too, which the
// x86 client takes from crate::cpu directly until the ARM64 plan's P1.0)
#[allow(dead_code)]
pub struct Env {
    /// The Wasm table: slots 1..table_size are handed out (slot 0 never),
    /// at table_offset in the host's table
    pub table_size: u32,
    pub table_offset: u32,
    /// The CPU state block's address (its fields are at fixed offsets)
    pub state_base: u32,
    /// Guest memory's base in the Wasm memory
    pub mem8: fn() -> *mut u8,
    /// The host's clock, in milliseconds
    pub now: fn() -> f64,
    /// The core this instance runs (0 without cores in workers)
    pub core: fn() -> usize,
    /// Clears a table slot (the host import jit_clear_func)
    pub clear_slot: fn(u32),
    /// A page's code changed: whether stores to it must notify, for the
    /// translations that cache it (TLB fills)
    pub page_has_code: fn(Page, bool),
    /// Code was compiled from these pages: they gain code, and cached write
    /// translations to them retire
    pub pages_gain_code: fn(&std::collections::HashSet<Page>),
    /// This instance watches a page from now on (true) or no longer (false):
    /// with cores in workers, the other cores must hear of its writes
    pub claim: fn(u32, bool),
    /// Every page released at once (a reset)
    pub release_all: fn(),
}

static mut ENV: Option<Env> = None;

pub(super) fn set(env: Env) { unsafe { ENV = Some(env) } }

/// The environment (after super::init)
#[inline(always)]
pub fn env() -> &'static Env { unsafe { (*(&raw const ENV)).as_ref().unwrap() } }
