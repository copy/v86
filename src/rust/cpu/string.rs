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

use crate::cpu::arith::{cmp16, cmp32, cmp8};
use crate::cpu::cpu::{
    get_seg, io_port_read16, io_port_read32, io_port_read8, io_port_write16, io_port_write32,
    io_port_write8, read_reg16, read_reg32, safe_read16, safe_read32s, safe_read8, safe_write16,
    safe_write32, safe_write8, set_reg_asize, test_privileges_for_io, translate_address_read,
    translate_address_write_and_can_skip_dirty, writable_or_pagefault, write_reg16, write_reg32,
    write_reg8, AL, AX, DX, EAX, ECX, EDI, ES, ESI, FLAG_DIRECTION,
};
use crate::cpu::global_pointers::{flags, instruction_pointer, previous_ip};
use crate::cpu::memory;
use crate::jit;
use crate::page::Page;

fn count_until_end_of_page(direction: i32, size: i32, addr: u32) -> u32 {
    (if direction == 1 {
        (0x1000 - (addr & 0xFFF)) / size as u32
    }
    else {
        (addr & 0xFFF) / size as u32 + 1
    }) as u32
}

#[derive(Copy, Clone, PartialEq)]
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
#[derive(Copy, Clone)]
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
    ds_or_prefix: i32,
    instruction: Instruction,
    size: Size,
    rep: Rep,
) {
    let asize_mask = if is_asize_32 { -1 } else { 0xFFFF };

    let direction = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };

    let mut count = match rep {
        Rep::Z | Rep::NZ => {
            let c = (read_reg32(ECX) & asize_mask) as u32;
            if c == 0 {
                return;
            };
            c
        },
        Rep::None => 0,
    };

    let es = match instruction {
        Instruction::Movs
        | Instruction::Cmps
        | Instruction::Stos
        | Instruction::Scas
        | Instruction::Ins => return_on_pagefault!(get_seg(ES)),
        _ => 0,
    };
    let ds = match instruction {
        Instruction::Movs
        | Instruction::Cmps
        | Instruction::Lods
        | Instruction::Scas
        | Instruction::Outs => return_on_pagefault!(get_seg(ds_or_prefix)),
        _ => 0,
    };

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

    let increment = direction * size_bytes;

    let data = match instruction {
        Instruction::Stos | Instruction::Scas => read_reg32(EAX),
        _ => 0,
    };

    let mut src = match instruction {
        Instruction::Movs | Instruction::Cmps | Instruction::Lods | Instruction::Outs => {
            read_reg32(ESI) & asize_mask
        },
        _ => 0,
    };
    let mut dst = match instruction {
        Instruction::Movs
        | Instruction::Cmps
        | Instruction::Stos
        | Instruction::Scas
        | Instruction::Ins => read_reg32(EDI) & asize_mask,
        _ => 0,
    };

    let port = match instruction {
        Instruction::Ins | Instruction::Outs => {
            let port = read_reg16(DX);
            if !test_privileges_for_io(port, size_bytes) {
                return;
            }
            port
        },
        _ => 0,
    };

    let is_aligned = (ds + src) & (size_bytes - 1) == 0 && (es + dst) & (size_bytes - 1) == 0;

    // unaligned movs is properly handled in the fast path
    let mut rep_fast = (instruction == Instruction::Movs || is_aligned)
        && is_asize_32 // 16-bit address wraparound
        && match rep {
            Rep::NZ | Rep::Z => true,
            Rep::None => false,
        };

    let mut phys_dst = 0;
    let mut phys_src = 0;
    let mut skip_dirty_page = false;

    let mut movs_into_svga_lfb = false;
    let mut movs_reenter_fast_path = false;

    let count_until_end_of_page = if rep_fast {
        match instruction {
            Instruction::Movs => {
                let (addr, skip) =
                    return_on_pagefault!(translate_address_write_and_can_skip_dirty(es + dst));
                movs_into_svga_lfb = memory::in_svga_lfb(addr);
                rep_fast = rep_fast && (!memory::in_mapped_range(addr) || movs_into_svga_lfb);
                phys_dst = addr;
                skip_dirty_page = skip;
            },
            Instruction::Stos | Instruction::Ins => {
                let (addr, skip) =
                    return_on_pagefault!(translate_address_write_and_can_skip_dirty(es + dst));
                rep_fast = rep_fast && !memory::in_mapped_range(addr);
                phys_dst = addr;
                skip_dirty_page = skip;
            },
            Instruction::Cmps | Instruction::Scas => {
                let addr = return_on_pagefault!(translate_address_read(es + dst));
                rep_fast = rep_fast && !memory::in_mapped_range(addr);
                phys_dst = addr;
                skip_dirty_page = true;
            },
            _ => {},
        };

        match instruction {
            Instruction::Movs | Instruction::Cmps | Instruction::Lods | Instruction::Outs => {
                let addr = return_on_pagefault!(translate_address_read(ds + src));
                rep_fast = rep_fast && !memory::in_mapped_range(addr);
                phys_src = addr;
            },
            _ => {},
        };

        let count_until_end_of_page = u32::min(
            count,
            match instruction {
                Instruction::Movs | Instruction::Cmps => u32::min(
                    count_until_end_of_page(direction, size_bytes, phys_src),
                    count_until_end_of_page(direction, size_bytes, phys_dst),
                ),
                Instruction::Stos | Instruction::Ins | Instruction::Scas => {
                    count_until_end_of_page(direction, size_bytes, phys_dst)
                },
                Instruction::Lods | Instruction::Outs => {
                    count_until_end_of_page(direction, size_bytes, phys_src)
                },
            },
        );

        match instruction {
            Instruction::Movs => {
                let c = count_until_end_of_page * size_bytes as u32;

                let overlap_interferes = if phys_src < phys_dst {
                    // backward moves may overlap at the front of the destination string
                    phys_dst - phys_src < c && direction == 1
                }
                else if phys_src > phys_dst {
                    // forward moves may overlap at the front of the source string
                    phys_src - phys_dst < c && direction == -1
                }
                else {
                    false
                };
                rep_fast = rep_fast && !overlap_interferes;

                // In case the following page-boundary check fails, re-enter instruction after
                // one iteration of the slow path
                movs_reenter_fast_path = rep_fast;
                rep_fast = rep_fast
                    && (phys_src & 0xFFF <= 0x1000 - size_bytes as u32)
                    && (phys_dst & 0xFFF <= 0x1000 - size_bytes as u32);
            },
            _ => {},
        }

        count_until_end_of_page
    }
    else {
        0 // not used
    };

    if rep_fast {
        dbg_assert!(count_until_end_of_page > 0);

        if !skip_dirty_page {
            jit::jit_dirty_page(Page::page_of(phys_dst));
        }

        let mut rep_cmp_finished = false;

        let mut i = 0;
        while i < count_until_end_of_page {
            i += 1;

            let src_val = match instruction {
                Instruction::Movs | Instruction::Cmps | Instruction::Lods | Instruction::Outs => {
                    match size {
                        Size::B => memory::read8_no_mmap_check(phys_src),
                        Size::W => memory::read16_no_mmap_check(phys_src),
                        Size::D => memory::read32_no_mmap_check(phys_src),
                    }
                },
                Instruction::Scas | Instruction::Stos => data & size_mask,
                Instruction::Ins => match size {
                    Size::B => io_port_read8(port),
                    Size::W => io_port_read16(port),
                    Size::D => io_port_read32(port),
                },
            };

            let mut dst_val = 0;

            match instruction {
                Instruction::Cmps | Instruction::Scas => match size {
                    Size::B => dst_val = memory::read8_no_mmap_check(phys_dst),
                    Size::W => dst_val = memory::read16_no_mmap_check(phys_dst),
                    Size::D => dst_val = memory::read32_no_mmap_check(phys_dst),
                },
                Instruction::Outs => match size {
                    Size::B => io_port_write8(port, src_val),
                    Size::W => io_port_write16(port, src_val),
                    Size::D => io_port_write32(port, src_val),
                },
                Instruction::Lods => match size {
                    Size::B => write_reg8(AL, src_val),
                    Size::W => write_reg16(AX, src_val),
                    Size::D => write_reg32(EAX, src_val),
                },
                Instruction::Ins => match size {
                    Size::B => memory::write8_no_mmap_or_dirty_check(phys_dst, src_val),
                    Size::W => memory::write16_no_mmap_or_dirty_check(phys_dst, src_val),
                    Size::D => memory::write32_no_mmap_or_dirty_check(phys_dst, src_val),
                },
                Instruction::Movs => {
                    if direction == -1 {
                        phys_src -= (count_until_end_of_page - 1) * size_bytes as u32;
                        phys_dst -= (count_until_end_of_page - 1) * size_bytes as u32;
                    }
                    if movs_into_svga_lfb {
                        memory::memcpy_into_svga_lfb(
                            phys_src,
                            phys_dst,
                            count_until_end_of_page * size_bytes as u32,
                        );
                    }
                    else {
                        memory::memcpy_no_mmap_or_dirty_check(
                            phys_src,
                            phys_dst,
                            count_until_end_of_page * size_bytes as u32,
                        );
                    }
                    i = count_until_end_of_page;
                    break;
                },
                Instruction::Stos => match size {
                    Size::B => {
                        if direction == -1 {
                            phys_dst -= count_until_end_of_page - 1
                        }
                        memory::memset_no_mmap_or_dirty_check(
                            phys_dst,
                            src_val as u8,
                            count_until_end_of_page,
                        );
                        i = count_until_end_of_page;
                        break;
                    },
                    Size::W => memory::write16_no_mmap_or_dirty_check(phys_dst, src_val),
                    Size::D => memory::write32_no_mmap_or_dirty_check(phys_dst, src_val),
                },
            };

            match instruction {
                Instruction::Movs
                | Instruction::Cmps
                | Instruction::Stos
                | Instruction::Scas
                | Instruction::Ins => {
                    phys_dst += increment as u32;
                },
                _ => {},
            }
            match instruction {
                Instruction::Movs | Instruction::Cmps | Instruction::Lods | Instruction::Outs => {
                    phys_src += increment as u32;
                },
                _ => {},
            };

            match instruction {
                Instruction::Scas | Instruction::Cmps => {
                    let rep_cmp = match rep {
                        Rep::Z => src_val == dst_val,
                        Rep::NZ => src_val != dst_val,
                        Rep::None => {
                            dbg_assert!(false);
                            true
                        },
                    };
                    if !rep_cmp || count == i {
                        match size {
                            Size::B => cmp8(src_val, dst_val),
                            Size::W => cmp16(src_val, dst_val),
                            Size::D => cmp32(src_val, dst_val),
                        };
                        rep_cmp_finished = true;
                        break;
                    }
                },
                _ => {},
            }
        }

        dbg_assert!(i <= count);
        count -= i;

        if !rep_cmp_finished && count != 0 {
            // go back to the current instruction, since this loop just handles a single page
            *instruction_pointer = *previous_ip;
        }

        src += i as i32 * increment;
        dst += i as i32 * increment;
    }
    else {
        loop {
            match instruction {
                Instruction::Ins => {
                    // check fault *before* reading from port
                    // (technically not necessary according to Intel manuals)
                    break_on_pagefault!(writable_or_pagefault(es + dst, size_bytes));
                },
                _ => {},
            };
            let src_val = match instruction {
                Instruction::Movs | Instruction::Cmps | Instruction::Lods | Instruction::Outs => {
                    break_on_pagefault!(match size {
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

            let mut dst_val = 0;

            match instruction {
                Instruction::Cmps | Instruction::Scas => match size {
                    Size::B => dst_val = break_on_pagefault!(safe_read8(es + dst)),
                    Size::W => dst_val = break_on_pagefault!(safe_read16(es + dst)),
                    Size::D => dst_val = break_on_pagefault!(safe_read32s(es + dst)),
                },
                Instruction::Outs => match size {
                    Size::B => io_port_write8(port, src_val),
                    Size::W => io_port_write16(port, src_val),
                    Size::D => io_port_write32(port, src_val),
                },
                Instruction::Lods => match size {
                    Size::B => write_reg8(AL, src_val),
                    Size::W => write_reg16(AX, src_val),
                    Size::D => write_reg32(EAX, src_val),
                },
                Instruction::Movs | Instruction::Stos | Instruction::Ins => match size {
                    Size::B => break_on_pagefault!(safe_write8(es + dst, src_val)),
                    Size::W => break_on_pagefault!(safe_write16(es + dst, src_val)),
                    Size::D => break_on_pagefault!(safe_write32(es + dst, src_val)),
                },
            };

            match instruction {
                Instruction::Movs
                | Instruction::Cmps
                | Instruction::Stos
                | Instruction::Scas
                | Instruction::Ins => dst = dst + increment & asize_mask,
                _ => {},
            }
            match instruction {
                Instruction::Movs | Instruction::Cmps | Instruction::Lods | Instruction::Outs => {
                    src = src + increment & asize_mask
                },
                _ => {},
            };

            count -= 1;

            let finished = match rep {
                Rep::Z | Rep::NZ => match (rep, instruction) {
                    (Rep::Z, Instruction::Cmps) => src_val != dst_val || count == 0,
                    (Rep::Z, Instruction::Scas) => src_val != dst_val || count == 0,
                    (Rep::NZ, Instruction::Cmps) => src_val == dst_val || count == 0,
                    (Rep::NZ, Instruction::Scas) => src_val == dst_val || count == 0,
                    (Rep::NZ | Rep::Z, Instruction::Movs) => {
                        if count == 0 {
                            true
                        }
                        else if movs_reenter_fast_path {
                            *instruction_pointer = *previous_ip;
                            true
                        }
                        else {
                            false
                        }
                    },
                    _ => count == 0,
                },
                Rep::None => true,
            };

            if finished {
                match instruction {
                    Instruction::Scas | Instruction::Cmps => match size {
                        Size::B => cmp8(src_val, dst_val),
                        Size::W => cmp16(src_val, dst_val),
                        Size::D => cmp32(src_val, dst_val),
                    },
                    _ => {},
                }
                break;
            }
        }
    }

    match instruction {
        Instruction::Movs
        | Instruction::Cmps
        | Instruction::Stos
        | Instruction::Scas
        | Instruction::Ins => set_reg_asize(is_asize_32, EDI, dst),
        _ => {},
    }
    match instruction {
        Instruction::Movs | Instruction::Cmps | Instruction::Lods | Instruction::Outs => {
            set_reg_asize(is_asize_32, ESI, src)
        },
        _ => {},
    };

    match rep {
        Rep::Z | Rep::NZ => {
            set_reg_asize(is_asize_32, ECX, count as i32);
        },
        Rep::None => {},
    }
}

#[no_mangle]
pub unsafe fn movsb_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Movs, Size::B, Rep::Z)
}
#[no_mangle]
pub unsafe fn movsw_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Movs, Size::W, Rep::Z)
}
#[no_mangle]
pub unsafe fn movsd_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Movs, Size::D, Rep::Z)
}
pub unsafe fn movsb_no_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Movs, Size::B, Rep::None)
}
pub unsafe fn movsw_no_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Movs, Size::W, Rep::None)
}
pub unsafe fn movsd_no_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Movs, Size::D, Rep::None)
}

#[no_mangle]
pub unsafe fn lodsb_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Lods, Size::B, Rep::Z)
}
#[no_mangle]
pub unsafe fn lodsw_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Lods, Size::W, Rep::Z)
}
#[no_mangle]
pub unsafe fn lodsd_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Lods, Size::D, Rep::Z)
}
pub unsafe fn lodsb_no_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Lods, Size::B, Rep::None)
}
pub unsafe fn lodsw_no_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Lods, Size::W, Rep::None)
}
pub unsafe fn lodsd_no_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Lods, Size::D, Rep::None)
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
pub unsafe fn stosb_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Stos, Size::B, Rep::None)
}
pub unsafe fn stosw_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Stos, Size::W, Rep::None)
}
pub unsafe fn stosd_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Stos, Size::D, Rep::None)
}

#[no_mangle]
pub unsafe fn cmpsb_repz(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Cmps, Size::B, Rep::Z)
}
#[no_mangle]
pub unsafe fn cmpsw_repz(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Cmps, Size::W, Rep::Z)
}
#[no_mangle]
pub unsafe fn cmpsd_repz(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Cmps, Size::D, Rep::Z)
}
#[no_mangle]
pub unsafe fn cmpsb_repnz(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Cmps, Size::B, Rep::NZ)
}
#[no_mangle]
pub unsafe fn cmpsw_repnz(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Cmps, Size::W, Rep::NZ)
}
#[no_mangle]
pub unsafe fn cmpsd_repnz(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Cmps, Size::D, Rep::NZ)
}
#[no_mangle]
pub unsafe fn cmpsb_no_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Cmps, Size::B, Rep::None)
}
#[no_mangle]
pub unsafe fn cmpsw_no_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Cmps, Size::W, Rep::None)
}
#[no_mangle]
pub unsafe fn cmpsd_no_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Cmps, Size::D, Rep::None)
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
pub unsafe fn scasb_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Scas, Size::B, Rep::None)
}
pub unsafe fn scasw_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Scas, Size::W, Rep::None)
}
pub unsafe fn scasd_no_rep(is_asize_32: bool) {
    string_instruction(is_asize_32, 0, Instruction::Scas, Size::D, Rep::None)
}

#[no_mangle]
pub unsafe fn outsb_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Outs, Size::B, Rep::Z)
}
#[no_mangle]
pub unsafe fn outsw_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Outs, Size::W, Rep::Z)
}
#[no_mangle]
pub unsafe fn outsd_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Outs, Size::D, Rep::Z)
}
#[no_mangle]
pub unsafe fn outsb_no_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Outs, Size::B, Rep::None)
}
#[no_mangle]
pub unsafe fn outsw_no_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Outs, Size::W, Rep::None)
}
#[no_mangle]
pub unsafe fn outsd_no_rep(is_asize_32: bool, seg: i32) {
    string_instruction(is_asize_32, seg, Instruction::Outs, Size::D, Rep::None)
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
