//! PSCI 1.1 over HVC (docs/arm64-virt-android16-plan.md: the emulator takes
//! HVC as PSCI/SMCCC, as QEMU does without EL2): the functions QEMU 9.2
//! implements (target/arm/tcg/psci.c), with the same results; any other
//! function ID, SMCCC_VERSION included, returns NOT_SUPPORTED.

use crate::aarch64::cpu;

pub const PSCI_VERSION: u64 = 0x8400_0000;
pub const CPU_SUSPEND: u64 = 0x8400_0001;
pub const CPU_OFF: u64 = 0x8400_0002;
pub const CPU_ON: u64 = 0x8400_0003;
pub const AFFINITY_INFO: u64 = 0x8400_0004;
pub const MIGRATE: u64 = 0x8400_0005;
pub const MIGRATE_INFO_TYPE: u64 = 0x8400_0006;
pub const SYSTEM_OFF: u64 = 0x8400_0008;
pub const SYSTEM_RESET: u64 = 0x8400_0009;
pub const PSCI_FEATURES: u64 = 0x8400_000A;
const FN64: u64 = 0x4000_0000;
// PSCI 0.1's function IDs (QEMU's, from KVM)
const V01_CPU_SUSPEND: u64 = 0x95C1_BA5E;
const V01_CPU_OFF: u64 = 0x95C1_BA5F;
const V01_CPU_ON: u64 = 0x95C1_BA60;
const V01_MIGRATE: u64 = 0x95C1_BA61;

pub const SUCCESS: i64 = 0;
pub const NOT_SUPPORTED: i64 = -1;
pub const INVALID_PARAMETERS: i64 = -2;
pub const ALREADY_ON: i64 = -4;
pub const ON_PENDING_RESULT: i64 = -5;

// the cores' power states (AFFINITY_INFO's values)
pub const ON: u8 = 0;
pub const OFF: u8 = 1;
pub const ON_PENDING: u8 = 2;

/// The cores' power states: 0 on, 1 off, 2 on pending (AFFINITY_INFO)
pub static mut POWER: [u8; crate::isa::MAX_CORES] = [0, 1, 1, 1, 1, 1, 1, 1];
/// A core started by CPU_ON: its entry point and context ID (the scheduler starts it, crate::aarch64::smp)
pub static mut START: [(u64, u64); crate::isa::MAX_CORES] = [(0, 0); crate::isa::MAX_CORES];
/// SYSTEM_OFF (1) or SYSTEM_RESET (2) was called
pub static mut REQUEST: u32 = 0;

#[repr(C)]
struct PowerState {
    power: [u8; crate::isa::MAX_CORES],
    start: [(u64, u64); crate::isa::MAX_CORES],
    request: u32,
}

/// (snapshots) the cores' power states as bytes: copied out of and into a scratch area
static mut SNAPSHOT: PowerState = PowerState {
    power: [0; crate::isa::MAX_CORES],
    start: [(0, 0); crate::isa::MAX_CORES],
    request: 0,
};

/// (snapshots) the power states: their bytes (an area filled now; read back by `restored`)
pub fn state_bytes() -> (u32, u32) {
    unsafe {
        SNAPSHOT = PowerState {
            power: POWER,
            start: START,
            request: REQUEST,
        };
        (
            &raw const SNAPSHOT as u32,
            core::mem::size_of::<PowerState>() as u32,
        )
    }
}

/// (snapshots) take the power states written into the scratch area
#[no_mangle]
pub fn a64_psci_restored() {
    unsafe {
        POWER = SNAPSHOT.power;
        START = SNAPSHOT.start;
        REQUEST = SNAPSHOT.request;
    }
}

/// What the calling core does after the call
pub enum After {
    Continue,
    /// CPU_SUSPEND: wait for an interrupt (as WFI)
    Wait,
    /// CPU_OFF, SYSTEM_OFF, SYSTEM_RESET: this core stops
    Off,
}

fn core_of(mpidr: u64) -> Option<usize> {
    // (Aff0 is the core; Aff1-3 are 0)
    let core = (mpidr & 0xFF_00FF_FFFF) as usize;
    (core < crate::isa::core_count()).then_some(core)
}

/// A PSCI call: x0 the function, x1-x3 its arguments; the result goes to x0
pub fn call() -> After {
    let function = cpu::xr(0);
    let (a1, a2, a3) = (cpu::xr(1), cpu::xr(2), cpu::xr(3));
    let mut after = After::Continue;
    let result: i64 = unsafe {
        match function {
            PSCI_VERSION => 0x1_0001,
            MIGRATE_INFO_TYPE => 2, // no trusted OS
            f if f == AFFINITY_INFO || f == AFFINITY_INFO | FN64 => {
                if a2 != 0 {
                    0 // (levels above 0 are always on)
                }
                else {
                    match core_of(a1) {
                        Some(core) => POWER[core] as i64,
                        None => INVALID_PARAMETERS,
                    }
                }
            },
            SYSTEM_RESET => {
                REQUEST = 2;
                after = After::Off;
                0
            },
            SYSTEM_OFF => {
                REQUEST = 1;
                after = After::Off;
                0
            },
            f if f == CPU_ON || f == CPU_ON | FN64 || f == V01_CPU_ON => match core_of(a1) {
                None => INVALID_PARAMETERS,
                Some(core) if POWER[core] == ON => ALREADY_ON,
                Some(core) if POWER[core] == ON_PENDING => ON_PENDING_RESULT,
                Some(core) => {
                    POWER[core] = ON_PENDING;
                    START[core] = (a2, a3);
                    SUCCESS
                },
            },
            CPU_OFF | V01_CPU_OFF => {
                POWER[crate::isa::current_core()] = OFF;
                after = After::Off;
                0
            },
            f if f == CPU_SUSPEND || f == CPU_SUSPEND | FN64 || f == V01_CPU_SUSPEND => {
                if a1 & 0xFFFE_0000 != 0 {
                    INVALID_PARAMETERS
                }
                else {
                    after = After::Wait;
                    0
                }
            },
            PSCI_FEATURES => match a1 {
                PSCI_VERSION | MIGRATE_INFO_TYPE | SYSTEM_RESET | SYSTEM_OFF | CPU_OFF
                | PSCI_FEATURES | V01_CPU_ON | V01_CPU_OFF | V01_CPU_SUSPEND => 0,
                f if f == AFFINITY_INFO || f == AFFINITY_INFO | FN64 => 0,
                f if f == CPU_ON || f == CPU_ON | FN64 => 0,
                f if f == CPU_SUSPEND || f == CPU_SUSPEND | FN64 => 0,
                _ => NOT_SUPPORTED,
            },
            MIGRATE | V01_MIGRATE => NOT_SUPPORTED,
            _ => NOT_SUPPORTED,
        }
    };
    cpu::set_x(0, result as u64);
    after
}

/// Whether the guest turned the machine off (the machine's power hook)
#[no_mangle]
pub fn a64_powered_off() -> bool { unsafe { REQUEST == 1 } }
/// SYSTEM_RESET was called (and is taken)
#[no_mangle]
pub fn a64_take_reset_request() -> bool {
    unsafe {
        let reset = REQUEST == 2;
        if reset {
            REQUEST = 0;
        }
        reset
    }
}
