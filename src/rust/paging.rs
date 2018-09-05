pub type OrPageFault<T> = Result<T, ()>;

macro_rules! return_on_pagefault {
    ($expr:expr) => {
        match $expr {
            Ok(v) => v,
            Err(()) => return,
        }
    };
}
