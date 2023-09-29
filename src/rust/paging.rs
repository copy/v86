use std::num::NonZeroU32;

#[derive(Eq, PartialEq, Copy, Clone)]
pub struct PhysAddr(NonZeroU32);
impl PhysAddr {
    pub fn create(addr: u32) -> PhysAddr {
        dbg_assert!(addr != u32::MAX);
        let addr = addr + 1;
        if cfg!(debug_assertions) {
            PhysAddr(NonZeroU32::new(addr).unwrap())
        } else {
            unsafe { PhysAddr(NonZeroU32::new_unchecked(addr)) }
        }
    }
    pub fn get(self) -> u32 {
        let PhysAddr(x) = self;
        x.get() - 1
    }
}

pub type OrPageFault<T> = Result<T, ()>;

macro_rules! return_on_pagefault {
    ($expr:expr) => {
        match $expr {
            Ok(v) => v,
            Err(()) => return,
        }
    };
    ($expr:expr, $ret:expr) => {
        match $expr {
            Ok(v) => v,
            Err(()) => return $ret,
        }
    };
}

macro_rules! break_on_pagefault {
    ($expr:expr) => {
        match $expr {
            Ok(v) => v,
            Err(()) => break,
        }
    };
}
