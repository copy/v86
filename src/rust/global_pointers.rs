pub const REG: u32 = 64;
pub const LAST_OP1: u32 = 96;
pub const LAST_OP2: u32 = 100;
pub const LAST_OP_SIZE: u32 = 104;
pub const LAST_ADD_RESULT: u32 = 108;
pub const LAST_RESULT: u32 = 112;
pub const FLAGS_CHANGED: u32 = 116;
pub const FLAGS: u32 = 120;

pub const PAGE_FAULT: u32 = 540;
pub const INSTRUCTION_POINTER: u32 = 556;
pub const PREVIOUS_IP: u32 = 560;
pub const CR: u32 = 580;
pub const PREFIXES: u32 = 648;
pub const TIMESTAMP_COUNTER: u32 = 664;
pub const SREG: u32 = 668;
pub const SEGMENT_OFFSETS: u32 = 736;
pub const REG_XMM: u32 = 832;
pub const FPU_CONTROL_WORD: u32 = 1036;
pub const OPSTATS_BUFFER: u32 = 0x08000;
pub const OPSTATS_UNGUARDED_REGISTER_BUFFER: u32 = 0x20000;
pub const TLB_DATA: u32 = 0x400000;

pub fn get_reg32_offset(r: u32) -> u32 {
    dbg_assert!(r < 8);
    REG + 4 * r
}

pub fn get_reg_xmm_low_offset(r: u32) -> u32 {
    dbg_assert!(r < 8);
    REG_XMM + 16 * r
}
pub fn get_reg_xmm_high_offset(r: u32) -> u32 {
    dbg_assert!(r < 8);
    REG_XMM + 16 * r + 8
}

pub fn get_sreg_offset(s: u32) -> u32 {
    dbg_assert!(s < 6);
    SREG + 2 * s
}

pub fn get_seg_offset(s: u32) -> u32 {
    dbg_assert!(s < 8);
    SEGMENT_OFFSETS + 4 * s
}

pub fn get_creg_offset(cr: u32) -> u32 {
    dbg_assert!(cr < 8);
    CR + 4 * cr
}
