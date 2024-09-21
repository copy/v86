use cpu::cpu::*;
use paging::OrPageFault;

pub unsafe fn resolve_modrm16(modrm_byte: i32) -> OrPageFault<i32> {
    match modrm_byte & !0o070 {
        0o000 => get_seg_prefix_ds(read_reg16(BX) + read_reg16(SI) & 0xFFFF),
        0o100 => get_seg_prefix_ds(read_reg16(BX) + read_reg16(SI) + read_imm8s()? & 0xFFFF),
        0o200 => get_seg_prefix_ds(read_reg16(BX) + read_reg16(SI) + read_imm16()? & 0xFFFF),
        0o001 => get_seg_prefix_ds(read_reg16(BX) + read_reg16(DI) & 0xFFFF),
        0o101 => get_seg_prefix_ds(read_reg16(BX) + read_reg16(DI) + read_imm8s()? & 0xFFFF),
        0o201 => get_seg_prefix_ds(read_reg16(BX) + read_reg16(DI) + read_imm16()? & 0xFFFF),
        0o002 => get_seg_prefix_ss(read_reg16(BP) + read_reg16(SI) & 0xFFFF),
        0o102 => get_seg_prefix_ss(read_reg16(BP) + read_reg16(SI) + read_imm8s()? & 0xFFFF),
        0o202 => get_seg_prefix_ss(read_reg16(BP) + read_reg16(SI) + read_imm16()? & 0xFFFF),
        0o003 => get_seg_prefix_ss(read_reg16(BP) + read_reg16(DI) & 0xFFFF),
        0o103 => get_seg_prefix_ss(read_reg16(BP) + read_reg16(DI) + read_imm8s()? & 0xFFFF),
        0o203 => get_seg_prefix_ss(read_reg16(BP) + read_reg16(DI) + read_imm16()? & 0xFFFF),
        0o004 => get_seg_prefix_ds(read_reg16(SI) & 0xFFFF),
        0o104 => get_seg_prefix_ds(read_reg16(SI) + read_imm8s()? & 0xFFFF),
        0o204 => get_seg_prefix_ds(read_reg16(SI) + read_imm16()? & 0xFFFF),
        0o005 => get_seg_prefix_ds(read_reg16(DI) & 0xFFFF),
        0o105 => get_seg_prefix_ds(read_reg16(DI) + read_imm8s()? & 0xFFFF),
        0o205 => get_seg_prefix_ds(read_reg16(DI) + read_imm16()? & 0xFFFF),
        0o006 => get_seg_prefix_ds(read_imm16()?),
        0o106 => get_seg_prefix_ss(read_reg16(BP) + read_imm8s()? & 0xFFFF),
        0o206 => get_seg_prefix_ss(read_reg16(BP) + read_imm16()? & 0xFFFF),
        0o007 => get_seg_prefix_ds(read_reg16(BX) & 0xFFFF),
        0o107 => get_seg_prefix_ds(read_reg16(BX) + read_imm8s()? & 0xFFFF),
        0o207 => get_seg_prefix_ds(read_reg16(BX) + read_imm16()? & 0xFFFF),
        _ => {
            dbg_assert!(false);
            std::hint::unreachable_unchecked()
        },
    }
}

pub unsafe fn resolve_modrm32_(modrm_byte: i32) -> OrPageFault<i32> {
    let r = (modrm_byte & 7) as u8;
    dbg_assert!(modrm_byte < 192);
    Ok(if r as i32 == 4 {
        if modrm_byte < 64 {
            resolve_sib(false)?
        }
        else {
            resolve_sib(true)? + if modrm_byte < 128 { read_imm8s()? } else { read_imm32s()? }
        }
    }
    else if r as i32 == 5 {
        if modrm_byte < 64 {
            get_seg_prefix_ds(read_imm32s()?)?
        }
        else {
            get_seg_prefix_ss(
                read_reg32(EBP) + if modrm_byte < 128 { read_imm8s()? } else { read_imm32s()? },
            )?
        }
    }
    else if modrm_byte < 64 {
        get_seg_prefix_ds(read_reg32(r as i32))?
    }
    else {
        get_seg_prefix_ds(
            read_reg32(r as i32) + if modrm_byte < 128 { read_imm8s()? } else { read_imm32s()? },
        )?
    })
}
unsafe fn resolve_sib(with_imm: bool) -> OrPageFault<i32> {
    let sib_byte = read_imm8()?;
    let r = sib_byte & 7;
    let m = sib_byte >> 3 & 7;
    let base;
    let seg;
    if r == 4 {
        base = read_reg32(ESP);
        seg = SS
    }
    else if r == 5 {
        if with_imm {
            base = read_reg32(EBP);
            seg = SS
        }
        else {
            base = read_imm32s()?;
            seg = DS
        }
    }
    else {
        base = read_reg32(r);
        seg = DS
    }
    let offset;
    if m == 4 {
        offset = 0
    }
    else {
        let s = sib_byte >> 6 & 3;
        offset = read_reg32(m) << s
    }
    Ok(get_seg_prefix(seg)? + base + offset)
}

pub unsafe fn resolve_modrm32(modrm_byte: i32) -> OrPageFault<i32> {
    match modrm_byte & !0o070 {
        0o000 => get_seg_prefix_ds(read_reg32(EAX)),
        0o100 => get_seg_prefix_ds(read_reg32(EAX) + read_imm8s()?),
        0o200 => get_seg_prefix_ds(read_reg32(EAX) + read_imm32s()?),
        0o001 => get_seg_prefix_ds(read_reg32(ECX)),
        0o101 => get_seg_prefix_ds(read_reg32(ECX) + read_imm8s()?),
        0o201 => get_seg_prefix_ds(read_reg32(ECX) + read_imm32s()?),
        0o002 => get_seg_prefix_ds(read_reg32(EDX)),
        0o102 => get_seg_prefix_ds(read_reg32(EDX) + read_imm8s()?),
        0o202 => get_seg_prefix_ds(read_reg32(EDX) + read_imm32s()?),
        0o003 => get_seg_prefix_ds(read_reg32(EBX)),
        0o103 => get_seg_prefix_ds(read_reg32(EBX) + read_imm8s()?),
        0o203 => get_seg_prefix_ds(read_reg32(EBX) + read_imm32s()?),
        0o004 => resolve_sib(false),
        0o104 => Ok(resolve_sib(true)? + read_imm8s()?),
        0o204 => Ok(resolve_sib(true)? + read_imm32s()?),
        0o005 => get_seg_prefix_ds(read_imm32s()?),
        0o105 => get_seg_prefix_ss(read_reg32(EBP) + read_imm8s()?),
        0o205 => get_seg_prefix_ss(read_reg32(EBP) + read_imm32s()?),
        0o006 => get_seg_prefix_ds(read_reg32(ESI)),
        0o106 => get_seg_prefix_ds(read_reg32(ESI) + read_imm8s()?),
        0o206 => get_seg_prefix_ds(read_reg32(ESI) + read_imm32s()?),
        0o007 => get_seg_prefix_ds(read_reg32(EDI)),
        0o107 => get_seg_prefix_ds(read_reg32(EDI) + read_imm8s()?),
        0o207 => get_seg_prefix_ds(read_reg32(EDI) + read_imm32s()?),
        _ => {
            dbg_assert!(false);
            std::hint::unreachable_unchecked()
        },
    }
}
