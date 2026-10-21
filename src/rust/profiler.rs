// Keep in sync with print_stats.js.
#[allow(non_camel_case_types)]
pub enum stat {
    RUN_INTERPRETED,
    RUN_INTERPRETED_STEPS,

    DIRTY_PAGE_DID_NOT_HAVE_CODE,

    PAGE_FAULT,
    TLB_MISS,

    MAIN_LOOP,
    MAIN_LOOP_IDLE,
    DO_MANY_CYCLES,
    CYCLE_INTERNAL,

    CLEAR_TLB,
    FULL_CLEAR_TLB,
    TLB_FULL,
    TLB_GLOBAL_FULL,

    // the path of an F80 add, sub, mul or div (src/rust/softfloat.rs): exact
    // in binary64, SoftFloat, native f64 (fast math)
    X87_EXACT,
    X87_SOFTFLOAT,
    X87_NATIVE_F64,
}

#[allow(non_upper_case_globals)]
pub static mut stat_array: [u64; 500] = [0; 500];

pub fn stat_increment(stat: stat) { stat_increment_by(stat, 1); }

pub fn stat_increment_by(stat: stat, by: u64) {
    if cfg!(feature = "profiler") {
        unsafe { stat_array[stat as usize] += by }
    }
}

#[no_mangle]
pub fn profiler_init() {
    unsafe {
        #[allow(static_mut_refs)]
        for x in stat_array.iter_mut() {
            *x = 0
        }
    }
}

#[no_mangle]
pub fn profiler_stat_get(stat: stat) -> f64 {
    if cfg!(feature = "profiler") {
        unsafe { stat_array[stat as usize] as f64 }
    }
    else {
        0.0
    }
}

#[no_mangle]
pub fn profiler_is_enabled() -> bool { cfg!(feature = "profiler") }
