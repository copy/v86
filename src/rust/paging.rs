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
