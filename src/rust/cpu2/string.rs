extern "C" {
    #[no_mangle]
    pub fn io_port_read8(port: i32) -> i32;
    #[no_mangle]
    pub fn io_port_read16(port: i32) -> i32;
    #[no_mangle]
    pub fn io_port_read32(port: i32) -> i32;

    #[no_mangle]
    pub fn io_port_write8(port: i32, value: i32);
    #[no_mangle]
    pub fn io_port_write16(port: i32, value: i32);
    #[no_mangle]
    pub fn io_port_write32(port: i32, value: i32);
}

// string operations
//
//       cmp  si  di
// movs   0    1   1/w    A4
// cmps   1    1   1/r    A6
// stos   0    0   1/w    AA
// lods   0    1   0      AC
// scas   1    0   1/r    AE
// ins    0    0   1/w
// outs   0    1   0

use cpu2::arith::{cmp8, cmp16, cmp32};
use cpu2::cpu::*;
use cpu2::global_pointers::*;
use cpu2::memory::{
    in_mapped_range, read8, read_aligned16, read_aligned32, write8, write8_no_mmap_or_dirty_check,
    write_aligned16, write_aligned32, write_aligned32_no_mmap_or_dirty_check,
};
use cpu2::misc_instr::getzf;
use page::Page;

const CX: i32 = ::regs::CX as i32;
const SI: i32 = ::regs::SI as i32;
const DI: i32 = ::regs::DI as i32;

const MAX_COUNT_PER_CYCLE: i32 = 4096;

#[no_mangle]
pub unsafe fn string_get_cycle_count(mut size: i32, mut address: i32) -> i32 {
    dbg_assert!(0 != size && size <= 4 && size >= -4);
    if size < 0 {
        size = -size;
        address = 0x1000 - address - size
    }
    dbg_assert!(address & size - 1 == 0);
    // 1 -> 0; 2 -> 1; 4 -> 2
    let shift = size >> 1;
    return 0x1000 - (address & 0xFFF) >> shift;
}

#[no_mangle]
pub unsafe fn string_get_cycle_count2(size: i32, addr1: i32, addr2: i32) -> i32 {
    let c1 = string_get_cycle_count(size, addr1);
    let c2 = string_get_cycle_count(size, addr2);
    return if c1 < c2 { c1 } else { c2 };
}

#[derive(Copy, Clone)]
enum Instruction {
    Movs,
    Lods,
    Stos,
    Scas,
    Cmps,
    Ins,
    Outs,
}
#[derive(PartialEq)]
enum Size {
    B,
    W,
    D,
}
enum Rep {
    None,
    Z,
    NZ,
}

// We implement all string instructions here and rely on the inliner on doing its job of optimising
// away anything known at compile time (check with `wasm-dis build/v86.wasm`)
#[inline(always)]
unsafe fn string_instruction(
    is_asize_32: bool,
    ds: i32,
    instruction: Instruction,
    size: Size,
    rep: Rep,
) {
    let asize_mask = if is_asize_32 { -1 } else { 0xFFFF };

    let count = match rep {
        Rep::Z | Rep::NZ => {
            let c = read_reg32(ECX) & asize_mask;
            if c == 0 {
                return;
            };
            c
        },
        Rep::None => 0,
    };

    let src = match instruction {
        Instruction::Movs | Instruction::Cmps | Instruction::Lods | Instruction::Outs => {
            read_reg32(ESI) & asize_mask
        },
        _ => 0,
    };
    let (es, dst) = match instruction {
        Instruction::Movs
        | Instruction::Cmps
        | Instruction::Stos
        | Instruction::Scas
        | Instruction::Ins => (
            return_on_pagefault!(get_seg(ES)),
            read_reg32(EDI) & asize_mask,
        ),
        _ => (0, 0),
    };
    let direction = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };

    let size_bytes = match size {
        Size::B => 1,
        Size::W => 2,
        Size::D => 4,
    };
    let size_mask = match size {
        Size::B => 0xFF,
        Size::W => 0xFFFF,
        Size::D => -1,
    };

    let port = match instruction {
        Instruction::Ins | Instruction::Outs => {
            let port = *reg16.offset(DX as isize) as i32;
            if !test_privileges_for_io(port, size_bytes) {
                return;
            }
            port
        },
        _ => 0,
    };

    let data = match instruction {
        Instruction::Stos | Instruction::Scas => *reg32.offset(EAX as isize),
        _ => 0,
    };

    match instruction {
        Instruction::Ins => {
            // check fault *before* reading from port
            return_on_pagefault!(writable_or_pagefault(es + dst, size_bytes));
        },
        _ => {},
    };
    let src_val = match instruction {
        Instruction::Movs | Instruction::Cmps | Instruction::Lods | Instruction::Outs => {
            return_on_pagefault!(match size {
                Size::B => safe_read8(ds + src),
                Size::W => safe_read16(ds + src),
                Size::D => safe_read32s(ds + src),
            })
        },
        Instruction::Scas | Instruction::Stos => data & size_mask,
        Instruction::Ins => match size {
            Size::B => io_port_read8(port),
            Size::W => io_port_read16(port),
            Size::D => io_port_read32(port),
        },
    };

    match instruction {
        Instruction::Cmps | Instruction::Scas => match size {
            Size::B => cmp8(src_val, return_on_pagefault!(safe_read8(es + dst))),
            Size::W => cmp16(src_val, return_on_pagefault!(safe_read16(es + dst))),
            Size::D => cmp32(src_val, return_on_pagefault!(safe_read32s(es + dst))),
        },
        Instruction::Outs => match size {
            Size::B => io_port_write8(port, src_val),
            Size::W => io_port_write16(port, src_val),
            Size::D => io_port_write32(port, src_val),
        },
        Instruction::Lods => match size {
            Size::B => *reg8.offset(AL as isize) = src_val as u8,
            Size::W => *reg16.offset(AX as isize) = src_val as u16,
            Size::D => *reg32.offset(EAX as isize) = src_val,
        },
        Instruction::Movs | Instruction::Stos | Instruction::Ins => match size {
            Size::B => return_on_pagefault!(safe_write8(es + dst, src_val)),
            Size::W => return_on_pagefault!(safe_write16(es + dst, src_val)),
            Size::D => return_on_pagefault!(safe_write32(es + dst, src_val)),
        },
    };

    match instruction {
        Instruction::Movs
        | Instruction::Cmps
        | Instruction::Stos
        | Instruction::Scas
        | Instruction::Ins => add_reg_asize(is_asize_32, EDI, direction * size_bytes),
        _ => {},
    }
    match instruction {
        Instruction::Movs | Instruction::Cmps | Instruction::Lods | Instruction::Outs => {
            add_reg_asize(is_asize_32, ESI, direction * size_bytes)
        },
        _ => {},
    };

    match rep {
        Rep::Z | Rep::NZ => {
            let rep_cmp = match (rep, instruction) {
                (Rep::Z, Instruction::Scas | Instruction::Cmps) => getzf(),
                (Rep::NZ, Instruction::Scas | Instruction::Cmps) => !getzf(),
                _ => true,
            };
            add_reg_asize(is_asize_32, ECX, -1);
            if count != 1 && rep_cmp {
                *instruction_pointer = *previous_ip
            }
        },
        Rep::None => {},
    }
}

#[no_mangle]
pub unsafe fn movsb_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Movs, Size::B, Rep::Z)
}
#[no_mangle]
pub unsafe fn movsw_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Movs, Size::W, Rep::Z)
}
#[no_mangle]
pub unsafe fn movsd_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Movs, Size::D, Rep::Z)
}
#[no_mangle]
pub unsafe fn movsb_no_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Movs, Size::B, Rep::None)
}
#[no_mangle]
pub unsafe fn movsw_no_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Movs, Size::W, Rep::None)
}
#[no_mangle]
pub unsafe fn movsd_no_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Movs, Size::D, Rep::None)
}

#[no_mangle]
pub unsafe fn lodsb_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Lods, Size::B, Rep::Z)
}
#[no_mangle]
pub unsafe fn lodsw_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Lods, Size::W, Rep::Z)
}
#[no_mangle]
pub unsafe fn lodsd_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Lods, Size::D, Rep::Z)
}
#[no_mangle]
pub unsafe fn lodsb_no_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Lods, Size::B, Rep::None)
}
#[no_mangle]
pub unsafe fn lodsw_no_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Lods, Size::W, Rep::None)
}
#[no_mangle]
pub unsafe fn lodsd_no_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Lods, Size::D, Rep::None)
}

#[no_mangle]
pub unsafe fn stosb_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Stos, Size::B, Rep::Z)
}
#[no_mangle]
pub unsafe fn stosw_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Stos, Size::W, Rep::Z)
}
#[no_mangle]
pub unsafe fn stosd_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Stos, Size::D, Rep::Z)
}
#[no_mangle]
pub unsafe fn stosb_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Stos, Size::B, Rep::None)
}
#[no_mangle]
pub unsafe fn stosw_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Stos, Size::W, Rep::None)
}
#[no_mangle]
pub unsafe fn stosd_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Stos, Size::D, Rep::None)
}

#[no_mangle]
pub unsafe fn cmpsb_repz(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Cmps, Size::B, Rep::Z)
}
#[no_mangle]
pub unsafe fn cmpsw_repz(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Cmps, Size::W, Rep::Z)
}
#[no_mangle]
pub unsafe fn cmpsd_repz(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Cmps, Size::D, Rep::Z)
}
#[no_mangle]
pub unsafe fn cmpsb_repnz(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Cmps, Size::B, Rep::NZ)
}
#[no_mangle]
pub unsafe fn cmpsw_repnz(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Cmps, Size::W, Rep::NZ)
}
#[no_mangle]
pub unsafe fn cmpsd_repnz(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Cmps, Size::D, Rep::NZ)
}
#[no_mangle]
pub unsafe fn cmpsb_no_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Cmps, Size::B, Rep::None)
}
#[no_mangle]
pub unsafe fn cmpsw_no_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Cmps, Size::W, Rep::None)
}
#[no_mangle]
pub unsafe fn cmpsd_no_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Cmps, Size::D, Rep::None)
}

#[no_mangle]
pub unsafe fn scasb_repz(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Scas, Size::B, Rep::Z)
}
#[no_mangle]
pub unsafe fn scasw_repz(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Scas, Size::W, Rep::Z)
}
#[no_mangle]
pub unsafe fn scasd_repz(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Scas, Size::D, Rep::Z)
}
#[no_mangle]
pub unsafe fn scasb_repnz(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Scas, Size::B, Rep::NZ)
}
#[no_mangle]
pub unsafe fn scasw_repnz(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Scas, Size::W, Rep::NZ)
}
#[no_mangle]
pub unsafe fn scasd_repnz(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Scas, Size::D, Rep::NZ)
}
#[no_mangle]
pub unsafe fn scasb_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Scas, Size::B, Rep::None)
}
#[no_mangle]
pub unsafe fn scasw_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Scas, Size::W, Rep::None)
}
#[no_mangle]
pub unsafe fn scasd_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Scas, Size::D, Rep::None)
}

#[no_mangle]
pub unsafe fn outsb_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Outs, Size::B, Rep::Z)
}
#[no_mangle]
pub unsafe fn outsw_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Outs, Size::W, Rep::Z)
}
#[no_mangle]
pub unsafe fn outsd_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Outs, Size::D, Rep::Z)
}
#[no_mangle]
pub unsafe fn outsb_no_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Outs, Size::B, Rep::None)
}
#[no_mangle]
pub unsafe fn outsw_no_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Outs, Size::W, Rep::None)
}
#[no_mangle]
pub unsafe fn outsd_no_rep(is_asize_32: bool, ds: i32) {
    string_instruction(is_asize_32, ds, Instruction::Outs, Size::D, Rep::None)
}

#[no_mangle]
pub unsafe fn insb_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Ins, Size::B, Rep::Z)
}
#[no_mangle]
pub unsafe fn insw_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Ins, Size::W, Rep::Z)
}
#[no_mangle]
pub unsafe fn insd_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Ins, Size::D, Rep::Z)
}
#[no_mangle]
pub unsafe fn insb_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Ins, Size::B, Rep::None)
}
#[no_mangle]
pub unsafe fn insw_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Ins, Size::W, Rep::None)
}
#[no_mangle]
pub unsafe fn insd_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Ins, Size::D, Rep::None)
}
