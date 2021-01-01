pub const REG: u32 = 64;
pub const LAST_OP1: u32 = 96;
pub const LAST_OP_SIZE: u32 = 104;
pub const LAST_RESULT: u32 = 112;
pub const FLAGS_CHANGED: u32 = 116;
pub const FLAGS: u32 = 120;

pub const PAGE_FAULT: u32 = 540;
pub const INSTRUCTION_POINTER: u32 = 556;
pub const PREVIOUS_IP: u32 = 560;
pub const CR: u32 = 580;
pub const CPL: u32 = 612;

pub const TIMESTAMP_COUNTER: u32 = 664;
pub const SREG: u32 = 668;
pub const SEGMENT_IS_NULL: u32 = 724;
pub const SEGMENT_OFFSETS: u32 = 736;
pub const REG_XMM: u32 = 832;
pub const FPU_CONTROL_WORD: u32 = 1036;
pub const REG_MMX: u32 = 1064;
pub const SSE_SCRATCH_REGISTER: u32 = 1136;
pub const OPSTATS_BUFFER: u32 = 0x08000;
pub const OPSTATS_UNGUARDED_REGISTER_BUFFER: u32 = 0x20000;
pub const TLB_DATA: u32 = 0x400000; // 2**20 32-bit words = 4MB

pub const JIT_PAGE_FIRST_ENTRY: u32 = 0x800000; // 2**20 32-bit words = 4MB
pub const JIT_CACHE_ARRAY: u32 = 0xC00000; // jit_cache_array::SIZE * sizeof(jit_cache_array::Entry) = 0x40000 * 24 = 6MB

pub fn get_reg32_offset(r: u32) -> u32 {
    dbg_assert!(r < 8);
    REG + 4 * r
}

pub fn get_reg_mmx_offset(r: u32) -> u32 {
    dbg_assert!(r < 8);
    REG_MMX + 8 * r
}

pub fn get_reg_xmm_offset(r: u32) -> u32 {
    dbg_assert!(r < 8);
    REG_XMM + 16 * r
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
