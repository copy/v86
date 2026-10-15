//! The clients' statistics through one export (P5.10): jit_stat(client,
//! field) is the client's own counter `field` (the x64 page tier's are
//! x64_page_stat's fields, src/rust/x64/pages.rs), NaN for a client the core
//! does not have. CPU.get_jit_info reads the page tier's through it.

use super::ClientId;

pub type Stat = fn(field: u32) -> f64;
static mut STATS: [Option<Stat>; 2] = [None, None];

/// By the composition root, once per client
pub fn register(client: ClientId, stat: Stat) {
    unsafe { (*(&raw mut STATS))[client as usize] = Some(stat) }
}

#[no_mangle]
pub fn jit_stat(client: u32, field: u32) -> f64 {
    match ClientId::of(client).and_then(|c| unsafe { (*(&raw const STATS))[c as usize] }) {
        Some(stat) => stat(field),
        None => f64::NAN,
    }
}
