//! Wide architectural state and shared decode foundations. The public CPU
//! profile only advertises long mode after execution and OS gates pass.
pub mod debug;
pub mod decode;
pub mod execute;
pub mod extended;
pub mod helpers;
pub mod jac;
pub mod memory;
pub mod pagegen;
pub mod pages;
pub mod paging;
pub mod physical;
pub mod profile;
#[cfg(feature = "ir-test-hooks")]
pub mod replay;
pub mod state;
pub mod system;
pub mod vector;
