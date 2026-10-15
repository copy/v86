//! Execution heat of code pages (P5.7): what a page tier knows of a code page
//! it has no function for, or one that serves too little of it, and the
//! batch of interpreted execution's heat (P4.5b's HeatBatch, moved here as it
//! was). The thresholds and what a page's state means for compiling are
//! the client's (the x64 page tier's HOT, LEGACY_HEAT and recompile rules).

/// A code page's state; `x` is the client's own
pub struct PageState<X> {
    /// interpreted instructions on it since its last compile
    pub heat: u32,
    /// the offsets it was entered at (far transfers: block starts)
    pub entries: [u64; 64],
    /// entries a function did not serve, seen once
    pub seen: [u64; 64],
    pub entry_count: u32,
    pub misses: u32,
    pub compiles: u32,
    pub x: X,
}
impl<X: Default> Default for PageState<X> {
    fn default() -> Self {
        Self {
            heat: 0,
            entries: [0; 64],
            seen: [0; 64],
            entry_count: 0,
            misses: 0,
            compiles: 0,
            x: X::default(),
        }
    }
}

/// Compiles of a page free of backoff; each one after doubles the heat or
/// misses the next waits for, up to 2^16 times
pub const FREE_RECOMPILES: u32 = 4;
pub fn backoff(compiles: u32) -> u32 { compiles.saturating_sub(FREE_RECOMPILES).min(16) }

/// Interpreted execution's heat, batched (docs/jit-unification-plan.md
/// P4.5b): instructions run outside compiled code on a code page without a
/// function, not yet added to the page's PageState. While the runtime's
/// functions are unchanged (`generation`) a miss on that page needs neither
/// the function nor the page lookup; it is added at the next miss of another
/// page, and at HEAT_BATCH_LIMIT.
#[derive(Clone, Copy)]
pub struct HeatBatch {
    pub page: u32,
    pub count: u32,
    pub generation: u32,
}
impl HeatBatch {
    pub const NONE: HeatBatch = HeatBatch {
        page: u32::MAX,
        count: 0,
        generation: 0,
    };
    pub fn holds(self, page: u32, generation: u32) -> bool {
        self.page == page && self.generation == generation
    }
}
pub const HEAT_BATCH_LIMIT: u32 = 256;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_and_batch() {
        assert_eq!(backoff(0), 0);
        assert_eq!(backoff(FREE_RECOMPILES), 0);
        assert_eq!(backoff(FREE_RECOMPILES + 3), 3);
        assert_eq!(backoff(1000), 16);
        let b = HeatBatch {
            page: 5,
            count: 1,
            generation: 2,
        };
        assert!(b.holds(5, 2) && !b.holds(5, 3) && !b.holds(6, 2));
        assert!(!HeatBatch::NONE.holds(u32::MAX, 1));
        let s: PageState<u8> = PageState::default();
        assert_eq!((s.heat, s.compiles, s.x), (0, 0, 0));
    }
}
