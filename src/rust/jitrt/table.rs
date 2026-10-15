//! The Wasm table's slots (P5.2): which are free and who owns each (a
//! client, the signature of the function in it, the client's id of the
//! code). One table per core instance, of host::Env's size. (The IR's
//! Tier-0 kept slots apart in T0_SLOTS until P7.5; the region tiers shared
//! this table until M11.)

use super::ClientId;
use std::collections::HashMap;

/// The type of a slot's function
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Signature {
    /// (i32) -> () (A64Page's dispatch stubs, ARM64 plan P6.0)
    #[allow(dead_code)]
    Fn1,
    /// (i32) -> i32: page functions (budget in, retired instructions out)
    Fn1Ret,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Owner {
    pub client: ClientId,
    pub signature: Signature,
    pub id: u64,
}

pub struct Table {
    size: u32,
    /// handed out from the end: the highest slot first
    free: Vec<u16>,
    owners: HashMap<u16, Owner>,
    /// the fewest free slots since reset_free_low (P0.10)
    free_low: u32,
}

impl Table {
    /// Slots 1..size, all free (0 is never handed out)
    pub fn new(size: u32) -> Table {
        dbg_assert!(size >= 2 && size <= 0x10000);
        Table {
            size,
            free: (1..size).map(|slot| slot as u16).collect(),
            owners: HashMap::new(),
            free_low: size - 1,
        }
    }
    pub fn reserve(&mut self, owner: Owner) -> Option<u32> {
        let slot = self.free.pop()?;
        self.free_low = self.free_low.min(self.free.len() as u32);
        self.owners.insert(slot, owner);
        self.check();
        Some(slot as u32)
    }
    /// Frees `slot` if `client` owns it with code `id`; called only at the
    /// client's cold point (the client guards a reused slot against late
    /// callbacks by the id)
    pub fn release(&mut self, slot: u32, client: ClientId, id: u64) -> bool {
        if slot == 0 || slot >= self.size {
            return false;
        }
        let slot = slot as u16;
        if !self
            .owners
            .get(&slot)
            .is_some_and(|o| o.client == client && o.id == id)
        {
            return false;
        }
        self.owners.remove(&slot);
        self.free.push(slot);
        self.check();
        true
    }
    #[allow(dead_code)]
    pub fn owner(&self, slot: u32) -> Option<Owner> {
        u16::try_from(slot)
            .ok()
            .and_then(|slot| self.owners.get(&slot).copied())
    }
    /// The slots `client` owns
    pub fn owned_by(&self, client: ClientId) -> usize {
        self.owners.values().filter(|o| o.client == client).count()
    }
    pub fn free_count(&self) -> u32 { self.free.len() as u32 }
    pub fn free_low(&self) -> u32 { self.free_low }
    pub fn reset_free_low(&mut self) { self.free_low = self.free.len() as u32 }

    fn check(&self) {
        if !cfg!(debug_assertions) {
            return;
        }
        dbg_assert!(self.free.iter().all(|slot| !self.owners.contains_key(slot)));
        dbg_assert!(self.free.len() + self.owners.len() == (self.size - 1) as usize);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const X86: Owner = Owner {
        client: ClientId::X86Page,
        signature: Signature::Fn1Ret,
        id: 7,
    };

    #[test]
    fn slots_from_the_top_owned_and_released() {
        let mut t = Table::new(4);
        assert_eq!(t.reserve(X86), Some(3));
        assert_eq!(t.reserve(Owner { id: 8, ..X86 }), Some(2));
        assert_eq!(t.owner(3), Some(X86));
        assert_eq!(t.owned_by(ClientId::X86Page), 2);
        assert_eq!(t.owned_by(ClientId::A64Page), 0);
        // (another id or client: not the owner)
        assert!(!t.release(3, ClientId::X86Page, 8));
        assert!(!t.release(3, ClientId::A64Page, 7));
        assert!(!t.release(0, ClientId::X86Page, 7));
        assert!(t.release(3, ClientId::X86Page, 7));
        assert_eq!(t.owner(3), None);
        assert_eq!(t.free_low(), 1);
        t.reset_free_low();
        assert_eq!(t.free_low(), 2);
        assert_eq!(t.reserve(X86), Some(3));
        assert_eq!(t.reserve(X86), Some(1));
        assert_eq!(t.reserve(X86), None);
    }
}
