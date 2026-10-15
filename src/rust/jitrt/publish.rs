//! Publication of compiled code (P5.4): a client hands a module's bytes to
//! the host with publish(); the host instantiates it (at once when it can)
//! and asks jit_install whether the code is still wanted, sets the table
//! slot and calls jit_ready, or calls jit_cancel when either failed. Each
//! piece of code goes Pending -> Ready -> Dead (Phase), Dead from any phase
//! when the client retires it; its slot is freed at the client's next cold
//! point. (The x64 page tier's own import and exports of before J1a,
//! x64_page_publish, x64_page_install, x64_page_ready and x64_page_cancel,
//! were removed at vJ2: cross-phase rule 10.)

use super::ClientId;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Pending,
    Ready,
    Dead,
}
impl Phase {
    /// Pending -> Ready: false in any other phase
    pub fn ready(&mut self) -> bool {
        if *self != Phase::Pending {
            return false;
        }
        *self = Phase::Ready;
        true
    }
    /// -> Dead: false if it was dead
    pub fn kill(&mut self) -> bool {
        if *self == Phase::Dead {
            return false;
        }
        *self = Phase::Dead;
        true
    }
}

/// A client's answers to the host, by the client's id of the code and its
/// slot
pub struct Client {
    /// Before the host sets the slot: whether the code is still wanted
    pub install: fn(id: u64, slot: u32) -> bool,
    /// The slot is set: the code may run
    pub ready: fn(id: u64, slot: u32) -> bool,
    /// The host could not instantiate or install it
    pub cancel: fn(id: u64, slot: u32),
}

static mut CLIENTS: [Option<Client>; 2] = [None, None];

/// By the composition root, once per client
pub fn register(client: ClientId, answers: Client) {
    unsafe { (*(&raw mut CLIENTS))[client as usize] = Some(answers) }
}
fn client(n: u32) -> Option<&'static Client> {
    unsafe { (*(&raw const CLIENTS)).get(n as usize)?.as_ref() }
}

mod js {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn jit_publish(client: u32, id: u64, slot: u32, pointer: u32, length: u32);
    }
}

/// Hands the module `bytes` for `slot` to the host (the code `id` of
/// `client`, Pending until jit_ready)
pub fn publish(client: ClientId, id: u64, slot: u32, bytes: &[u8]) {
    unsafe {
        js::jit_publish(
            client as u32,
            id,
            slot,
            bytes.as_ptr() as u32,
            bytes.len() as u32,
        )
    }
}

#[no_mangle]
pub fn jit_install(client_id: u32, id: u64, slot: u32) -> bool {
    client(client_id).is_some_and(|c| (c.install)(id, slot))
}
#[no_mangle]
pub fn jit_ready(client_id: u32, id: u64, slot: u32) -> bool {
    client(client_id).is_some_and(|c| (c.ready)(id, slot))
}
#[no_mangle]
pub fn jit_cancel(client_id: u32, id: u64, slot: u32) {
    if let Some(c) = client(client_id) {
        (c.cancel)(id, slot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases() {
        let mut p = Phase::Pending;
        assert!(p.ready());
        assert!(!p.ready());
        assert!(p.kill());
        assert!(!p.kill());
        assert!(!p.ready());
        let mut q = Phase::Pending;
        assert!(q.kill());
        assert_eq!(q, Phase::Dead);
    }
}
