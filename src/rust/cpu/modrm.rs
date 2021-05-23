use cpu::cpu::*;
use paging::OrPageFault;

pub unsafe fn resolve_modrm16(modrm_byte: i32) -> OrPageFault<i32> {
    Ok(match modrm_byte {
        0 | 8 | 16 | 24 | 32 | 40 | 48 | 56 => {
            get_seg_prefix_ds(read_reg16(BX) + read_reg16(SI) & 0xFFFF)?
        },
        64 | 72 | 80 | 88 | 96 | 104 | 112 | 120 => {
            get_seg_prefix_ds(read_reg16(BX) + read_reg16(SI) + read_imm8s()? & 0xFFFF)?
        },
        128 | 136 | 144 | 152 | 160 | 168 | 176 | 184 => {
            get_seg_prefix_ds(read_reg16(BX) + read_reg16(SI) + read_imm16()? & 0xFFFF)?
        },
        1 | 9 | 17 | 25 | 33 | 41 | 49 | 57 => {
            get_seg_prefix_ds(read_reg16(BX) + read_reg16(DI) & 0xFFFF)?
        },
        65 | 73 | 81 | 89 | 97 | 105 | 113 | 121 => {
            get_seg_prefix_ds(read_reg16(BX) + read_reg16(DI) + read_imm8s()? & 0xFFFF)?
        },
        129 | 137 | 145 | 153 | 161 | 169 | 177 | 185 => {
            get_seg_prefix_ds(read_reg16(BX) + read_reg16(DI) + read_imm16()? & 0xFFFF)?
        },
        2 | 10 | 18 | 26 | 34 | 42 | 50 | 58 => {
            get_seg_prefix_ss(read_reg16(BP) + read_reg16(SI) & 0xFFFF)?
        },
        66 | 74 | 82 | 90 | 98 | 106 | 114 | 122 => {
            get_seg_prefix_ss(read_reg16(BP) + read_reg16(SI) + read_imm8s()? & 0xFFFF)?
        },
        130 | 138 | 146 | 154 | 162 | 170 | 178 | 186 => {
            get_seg_prefix_ss(read_reg16(BP) + read_reg16(SI) + read_imm16()? & 0xFFFF)?
        },
        3 | 11 | 19 | 27 | 35 | 43 | 51 | 59 => {
            get_seg_prefix_ss(read_reg16(BP) + read_reg16(DI) & 0xFFFF)?
        },
        67 | 75 | 83 | 91 | 99 | 107 | 115 | 123 => {
            get_seg_prefix_ss(read_reg16(BP) + read_reg16(DI) + read_imm8s()? & 0xFFFF)?
        },
        131 | 139 | 147 | 155 | 163 | 171 | 179 | 187 => {
            get_seg_prefix_ss(read_reg16(BP) + read_reg16(DI) + read_imm16()? & 0xFFFF)?
        },
        4 | 12 | 20 | 28 | 36 | 44 | 52 | 60 => get_seg_prefix_ds(read_reg16(SI) & 0xFFFF)?,
        68 | 76 | 84 | 92 | 100 | 108 | 116 | 124 => {
            get_seg_prefix_ds(read_reg16(SI) + read_imm8s()? & 0xFFFF)?
        },
        132 | 140 | 148 | 156 | 164 | 172 | 180 | 188 => {
            get_seg_prefix_ds(read_reg16(SI) + read_imm16()? & 0xFFFF)?
        },
        5 | 13 | 21 | 29 | 37 | 45 | 53 | 61 => get_seg_prefix_ds(read_reg16(DI) & 0xFFFF)?,
        69 | 77 | 85 | 93 | 101 | 109 | 117 | 125 => {
            get_seg_prefix_ds(read_reg16(DI) + read_imm8s()? & 0xFFFF)?
        },
        133 | 141 | 149 | 157 | 165 | 173 | 181 | 189 => {
            get_seg_prefix_ds(read_reg16(DI) + read_imm16()? & 0xFFFF)?
        },
        6 | 14 | 22 | 30 | 38 | 46 | 54 | 62 => get_seg_prefix_ds(read_imm16()?)?,
        70 | 78 | 86 | 94 | 102 | 110 | 118 | 126 => {
            get_seg_prefix_ss(read_reg16(BP) + read_imm8s()? & 0xFFFF)?
        },
        134 | 142 | 150 | 158 | 166 | 174 | 182 | 190 => {
            get_seg_prefix_ss(read_reg16(BP) + read_imm16()? & 0xFFFF)?
        },
        7 | 15 | 23 | 31 | 39 | 47 | 55 | 63 => get_seg_prefix_ds(read_reg16(BX) & 0xFFFF)?,
        71 | 79 | 87 | 95 | 103 | 111 | 119 | 127 => {
            get_seg_prefix_ds(read_reg16(BX) + read_imm8s()? & 0xFFFF)?
        },
        135 | 143 | 151 | 159 | 167 | 175 | 183 | 191 => {
            get_seg_prefix_ds(read_reg16(BX) + read_imm16()? & 0xFFFF)?
        },
        _ => {
            dbg_assert!(false);
            0
        },
    })
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
unsafe fn resolve_sib(mod_0: bool) -> OrPageFault<i32> {
    let s;
    let sib_byte = read_imm8()? as u8;
    let r = (sib_byte as i32 & 7) as u8;
    let m = (sib_byte as i32 >> 3 & 7) as u8;
    let base;
    let seg;
    if r as i32 == 4 {
        base = read_reg32(ESP);
        seg = SS
    }
    else if r as i32 == 5 {
        if mod_0 {
            base = read_reg32(EBP);
            seg = SS
        }
        else {
            base = read_imm32s()?;
            seg = DS
        }
    }
    else {
        base = read_reg32(r as i32);
        seg = DS
    }
    let offset;
    if m as i32 == 4 {
        offset = 0
    }
    else {
        s = (sib_byte as i32 >> 6 & 3) as u8;
        offset = read_reg32(m as i32) << s as i32
    }
    Ok(get_seg_prefix(seg)? + base + offset)
}

pub unsafe fn resolve_modrm32(modrm_byte: i32) -> OrPageFault<i32> {
    Ok(match modrm_byte {
        0 | 8 | 16 | 24 | 32 | 40 | 48 | 56 => get_seg_prefix_ds(read_reg32(EAX))?,
        64 | 72 | 80 | 88 | 96 | 104 | 112 | 120 => {
            get_seg_prefix_ds(read_reg32(EAX) + read_imm8s()?)?
        },
        128 | 136 | 144 | 152 | 160 | 168 | 176 | 184 => {
            get_seg_prefix_ds(read_reg32(EAX) + read_imm32s()?)?
        },
        1 | 9 | 17 | 25 | 33 | 41 | 49 | 57 => get_seg_prefix_ds(read_reg32(ECX))?,
        65 | 73 | 81 | 89 | 97 | 105 | 113 | 121 => {
            get_seg_prefix_ds(read_reg32(ECX) + read_imm8s()?)?
        },
        129 | 137 | 145 | 153 | 161 | 169 | 177 | 185 => {
            get_seg_prefix_ds(read_reg32(ECX) + read_imm32s()?)?
        },
        2 | 10 | 18 | 26 | 34 | 42 | 50 | 58 => get_seg_prefix_ds(read_reg32(EDX))?,
        66 | 74 | 82 | 90 | 98 | 106 | 114 | 122 => {
            get_seg_prefix_ds(read_reg32(EDX) + read_imm8s()?)?
        },
        130 | 138 | 146 | 154 | 162 | 170 | 178 | 186 => {
            get_seg_prefix_ds(read_reg32(EDX) + read_imm32s()?)?
        },
        3 | 11 | 19 | 27 | 35 | 43 | 51 | 59 => get_seg_prefix_ds(read_reg32(EBX))?,
        67 | 75 | 83 | 91 | 99 | 107 | 115 | 123 => {
            get_seg_prefix_ds(read_reg32(EBX) + read_imm8s()?)?
        },
        131 | 139 | 147 | 155 | 163 | 171 | 179 | 187 => {
            get_seg_prefix_ds(read_reg32(EBX) + read_imm32s()?)?
        },
        4 | 12 | 20 | 28 | 36 | 44 | 52 | 60 => resolve_sib(false)?,
        68 | 76 | 84 | 92 | 100 | 108 | 116 | 124 => resolve_sib(true)? + read_imm8s()?,
        132 | 140 | 148 | 156 | 164 | 172 | 180 | 188 => resolve_sib(true)? + read_imm32s()?,
        5 | 13 | 21 | 29 | 37 | 45 | 53 | 61 => get_seg_prefix_ds(read_imm32s()?)?,
        69 | 77 | 85 | 93 | 101 | 109 | 117 | 125 => {
            get_seg_prefix_ss(read_reg32(EBP) + read_imm8s()?)?
        },
        133 | 141 | 149 | 157 | 165 | 173 | 181 | 189 => {
            get_seg_prefix_ss(read_reg32(EBP) + read_imm32s()?)?
        },
        6 | 14 | 22 | 30 | 38 | 46 | 54 | 62 => get_seg_prefix_ds(read_reg32(ESI))?,
        70 | 78 | 86 | 94 | 102 | 110 | 118 | 126 => {
            get_seg_prefix_ds(read_reg32(ESI) + read_imm8s()?)?
        },
        134 | 142 | 150 | 158 | 166 | 174 | 182 | 190 => {
            get_seg_prefix_ds(read_reg32(ESI) + read_imm32s()?)?
        },
        7 | 15 | 23 | 31 | 39 | 47 | 55 | 63 => get_seg_prefix_ds(read_reg32(EDI))?,
        71 | 79 | 87 | 95 | 103 | 111 | 119 | 127 => {
            get_seg_prefix_ds(read_reg32(EDI) + read_imm8s()?)?
        },
        135 | 143 | 151 | 159 | 167 | 175 | 183 | 191 => {
            get_seg_prefix_ds(read_reg32(EDI) + read_imm32s()?)?
        },
        _ => {
            dbg_assert!(false);
            0
        },
    })
}
