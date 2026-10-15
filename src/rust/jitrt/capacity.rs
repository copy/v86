//! The table's slot budget (P5.5): each client's soft quota of the core's
//! table. A client that holds its quota evicts its own code before it takes
//! a slot; one that is under its quota while the table is full posts an
//! eviction request to the clients over theirs. Nobody evicts another's
//! code: a request is carried out by its victim at its next cold point
//! (take_request). The composition root sets the quotas: in the x86 core the
//! x64 page tier's is what it held alone (pages::MAX_FUNCTIONS, its mode
//! shares, P7.2b, within it), in the ARM core the whole table is A64Page's.

use super::ClientId;

const CLIENTS: usize = 2;
static mut QUOTA: [u32; CLIENTS] = [0; CLIENTS];
static mut REQUESTS: [u32; CLIENTS] = [0; CLIENTS];

pub fn set_quota(client: ClientId, slots: u32) { unsafe { QUOTA[client as usize] = slots } }
pub fn quota(client: ClientId) -> u32 { unsafe { QUOTA[client as usize] } }

/// Before `client`, holding `held` slots, takes another (`free` slots left
/// in the table): whether it must evict one of its own first. When the table
/// is full but `client` is under its quota, the clients over theirs get a
/// request instead (`held_by` tells how many each holds).
pub fn must_evict(
    client: ClientId,
    held: u32,
    free: u32,
    held_by: impl Fn(ClientId) -> u32,
) -> bool {
    if held >= quota(client) {
        return true;
    }
    if free == 0 {
        for other in [ClientId::X86Page, ClientId::A64Page] {
            if other != client && held_by(other) > quota(other) {
                unsafe { REQUESTS[other as usize] += 1 };
            }
        }
    }
    false
}

/// At `client`'s cold point: an eviction another client asked of it, if any
pub fn take_request(client: ClientId) -> bool {
    unsafe {
        let n = &mut REQUESTS[client as usize];
        if *n == 0 {
            return false;
        }
        *n -= 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotas_and_requests() {
        set_quota(ClientId::X86Page, 3);
        set_quota(ClientId::A64Page, 2);
        let held = |c: ClientId| if c == ClientId::X86Page { 1 } else { 4 };
        // under its quota with room: no eviction, no request
        assert!(!must_evict(ClientId::X86Page, 1, 5, held));
        assert!(!take_request(ClientId::A64Page));
        // at its quota: its own
        assert!(must_evict(ClientId::X86Page, 3, 5, held));
        // a full table while under: A64Page (4 of 2) is asked once
        assert!(!must_evict(ClientId::X86Page, 1, 0, held));
        assert!(take_request(ClientId::A64Page));
        assert!(!take_request(ClientId::A64Page));
        assert!(!take_request(ClientId::X86Page));
    }
}
