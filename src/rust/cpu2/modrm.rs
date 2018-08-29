#![allow(mutable_transmutes, unused_mut)]

use cpu2::cpu::*;
use cpu2::global_pointers::*;

pub unsafe fn resolve_modrm16(mut modrm_byte: i32) -> Result<i32, ()> {
    Ok(match modrm_byte {
        0 | 8 | 16 | 24 | 32 | 40 | 48 | 56 => get_seg_prefix_ds(
            *reg16.offset(BX as isize) as i32 + *reg16.offset(SI as isize) as i32 & 65535i32,
        ),
        64 | 72 | 80 | 88 | 96 | 104 | 112 | 120 => get_seg_prefix_ds(
            *reg16.offset(BX as isize) as i32 + *reg16.offset(SI as isize) as i32 + read_imm8s()?
                & 65535i32,
        ),
        128 | 136 | 144 | 152 | 160 | 168 | 176 | 184 => get_seg_prefix_ds(
            *reg16.offset(BX as isize) as i32 + *reg16.offset(SI as isize) as i32 + read_imm16()?
                & 65535i32,
        ),
        1 | 9 | 17 | 25 | 33 | 41 | 49 | 57 => get_seg_prefix_ds(
            *reg16.offset(BX as isize) as i32 + *reg16.offset(DI as isize) as i32 & 65535i32,
        ),
        65 | 73 | 81 | 89 | 97 | 105 | 113 | 121 => get_seg_prefix_ds(
            *reg16.offset(BX as isize) as i32 + *reg16.offset(DI as isize) as i32 + read_imm8s()?
                & 65535i32,
        ),
        129 | 137 | 145 | 153 | 161 | 169 | 177 | 185 => get_seg_prefix_ds(
            *reg16.offset(BX as isize) as i32 + *reg16.offset(DI as isize) as i32 + read_imm16()?
                & 65535i32,
        ),
        2 | 10 | 18 | 26 | 34 | 42 | 50 | 58 => get_seg_prefix_ss(
            *reg16.offset(BP as isize) as i32 + *reg16.offset(SI as isize) as i32 & 65535i32,
        ),
        66 | 74 | 82 | 90 | 98 | 106 | 114 | 122 => get_seg_prefix_ss(
            *reg16.offset(BP as isize) as i32 + *reg16.offset(SI as isize) as i32 + read_imm8s()?
                & 65535i32,
        ),
        130 | 138 | 146 | 154 | 162 | 170 | 178 | 186 => get_seg_prefix_ss(
            *reg16.offset(BP as isize) as i32 + *reg16.offset(SI as isize) as i32 + read_imm16()?
                & 65535i32,
        ),
        3 | 11 | 19 | 27 | 35 | 43 | 51 | 59 => get_seg_prefix_ss(
            *reg16.offset(BP as isize) as i32 + *reg16.offset(DI as isize) as i32 & 65535i32,
        ),
        67 | 75 | 83 | 91 | 99 | 107 | 115 | 123 => get_seg_prefix_ss(
            *reg16.offset(BP as isize) as i32 + *reg16.offset(DI as isize) as i32 + read_imm8s()?
                & 65535i32,
        ),
        131 | 139 | 147 | 155 | 163 | 171 | 179 | 187 => get_seg_prefix_ss(
            *reg16.offset(BP as isize) as i32 + *reg16.offset(DI as isize) as i32 + read_imm16()?
                & 65535i32,
        ),
        4 | 12 | 20 | 28 | 36 | 44 | 52 | 60 => {
            get_seg_prefix_ds(*reg16.offset(SI as isize) as i32 & 65535i32)
        },
        68 | 76 | 84 | 92 | 100 | 108 | 116 | 124 => {
            get_seg_prefix_ds(*reg16.offset(SI as isize) as i32 + read_imm8s()? & 65535i32)
        },
        132 | 140 | 148 | 156 | 164 | 172 | 180 | 188 => {
            get_seg_prefix_ds(*reg16.offset(SI as isize) as i32 + read_imm16()? & 65535i32)
        },
        5 | 13 | 21 | 29 | 37 | 45 | 53 | 61 => {
            get_seg_prefix_ds(*reg16.offset(DI as isize) as i32 & 65535i32)
        },
        69 | 77 | 85 | 93 | 101 | 109 | 117 | 125 => {
            get_seg_prefix_ds(*reg16.offset(DI as isize) as i32 + read_imm8s()? & 65535i32)
        },
        133 | 141 | 149 | 157 | 165 | 173 | 181 | 189 => {
            get_seg_prefix_ds(*reg16.offset(DI as isize) as i32 + read_imm16()? & 65535i32)
        },
        6 | 14 | 22 | 30 | 38 | 46 | 54 | 62 => get_seg_prefix_ds(read_imm16()?),
        70 | 78 | 86 | 94 | 102 | 110 | 118 | 126 => {
            get_seg_prefix_ss(*reg16.offset(BP as isize) as i32 + read_imm8s()? & 65535i32)
        },
        134 | 142 | 150 | 158 | 166 | 174 | 182 | 190 => {
            get_seg_prefix_ss(*reg16.offset(BP as isize) as i32 + read_imm16()? & 65535i32)
        },
        7 | 15 | 23 | 31 | 39 | 47 | 55 | 63 => {
            get_seg_prefix_ds(*reg16.offset(BX as isize) as i32 & 65535i32)
        },
        71 | 79 | 87 | 95 | 103 | 111 | 119 | 127 => {
            get_seg_prefix_ds(*reg16.offset(BX as isize) as i32 + read_imm8s()? & 65535i32)
        },
        135 | 143 | 151 | 159 | 167 | 175 | 183 | 191 => {
            get_seg_prefix_ds(*reg16.offset(BX as isize) as i32 + read_imm16()? & 65535i32)
        },
        _ => {
            dbg_assert!(0 != 0i32);
            0i32
        },
    })
}

pub unsafe fn resolve_modrm32_(mut modrm_byte: i32) -> Result<i32, ()> {
    let mut r: u8 = (modrm_byte & 7i32) as u8;
    dbg_assert!(modrm_byte < 192i32);
    Ok(if r as i32 == 4i32 {
        if modrm_byte < 64i32 {
            resolve_sib(0 != 0i32)?
        }
        else {
            resolve_sib(0 != 1i32)? + if modrm_byte < 128i32 {
                read_imm8s()?
            }
            else {
                read_imm32s()?
            }
        }
    }
    else if r as i32 == 5i32 {
        if modrm_byte < 64i32 {
            get_seg_prefix_ds(read_imm32s()?)
        }
        else {
            get_seg_prefix_ss(
                *reg32s.offset(EBP as isize) + if modrm_byte < 128i32 {
                    read_imm8s()?
                }
                else {
                    read_imm32s()?
                },
            )
        }
    }
    else if modrm_byte < 64i32 {
        get_seg_prefix_ds(*reg32s.offset(r as isize))
    }
    else {
        get_seg_prefix_ds(
            *reg32s.offset(r as isize) + if modrm_byte < 128i32 {
                read_imm8s()?
            }
            else {
                read_imm32s()?
            },
        )
    })
}
unsafe fn resolve_sib(mut mod_0: bool) -> Result<i32, ()> {
    let mut s: u8 = 0;
    let mut sib_byte: u8 = read_imm8()? as u8;
    let mut r: u8 = (sib_byte as i32 & 7i32) as u8;
    let mut m: u8 = (sib_byte as i32 >> 3i32 & 7i32) as u8;
    let mut base: i32 = 0;
    let mut seg: i32 = 0;
    if r as i32 == 4i32 {
        base = *reg32s.offset(ESP as isize);
        seg = SS
    }
    else if r as i32 == 5i32 {
        if mod_0 {
            base = *reg32s.offset(EBP as isize);
            seg = SS
        }
        else {
            base = read_imm32s()?;
            seg = DS
        }
    }
    else {
        base = *reg32s.offset(r as isize);
        seg = DS
    }
    let mut offset: i32 = 0;
    if m as i32 == 4i32 {
        offset = 0i32
    }
    else {
        s = (sib_byte as i32 >> 6i32 & 3i32) as u8;
        offset = *reg32s.offset(m as isize) << s as i32
    }
    Ok(get_seg_prefix(seg) + base + offset)
}

pub unsafe fn resolve_modrm32(mut modrm_byte: i32) -> Result<i32, ()> {
    Ok(match modrm_byte {
        0 | 8 | 16 | 24 | 32 | 40 | 48 | 56 => get_seg_prefix_ds(*reg32s.offset(EAX as isize)),
        64 | 72 | 80 | 88 | 96 | 104 | 112 | 120 => {
            get_seg_prefix_ds(*reg32s.offset(EAX as isize) + read_imm8s()?)
        },
        128 | 136 | 144 | 152 | 160 | 168 | 176 | 184 => {
            get_seg_prefix_ds(*reg32s.offset(EAX as isize) + read_imm32s()?)
        },
        1 | 9 | 17 | 25 | 33 | 41 | 49 | 57 => get_seg_prefix_ds(*reg32s.offset(ECX as isize)),
        65 | 73 | 81 | 89 | 97 | 105 | 113 | 121 => {
            get_seg_prefix_ds(*reg32s.offset(ECX as isize) + read_imm8s()?)
        },
        129 | 137 | 145 | 153 | 161 | 169 | 177 | 185 => {
            get_seg_prefix_ds(*reg32s.offset(ECX as isize) + read_imm32s()?)
        },
        2 | 10 | 18 | 26 | 34 | 42 | 50 | 58 => get_seg_prefix_ds(*reg32s.offset(EDX as isize)),
        66 | 74 | 82 | 90 | 98 | 106 | 114 | 122 => {
            get_seg_prefix_ds(*reg32s.offset(EDX as isize) + read_imm8s()?)
        },
        130 | 138 | 146 | 154 | 162 | 170 | 178 | 186 => {
            get_seg_prefix_ds(*reg32s.offset(EDX as isize) + read_imm32s()?)
        },
        3 | 11 | 19 | 27 | 35 | 43 | 51 | 59 => get_seg_prefix_ds(*reg32s.offset(EBX as isize)),
        67 | 75 | 83 | 91 | 99 | 107 | 115 | 123 => {
            get_seg_prefix_ds(*reg32s.offset(EBX as isize) + read_imm8s()?)
        },
        131 | 139 | 147 | 155 | 163 | 171 | 179 | 187 => {
            get_seg_prefix_ds(*reg32s.offset(EBX as isize) + read_imm32s()?)
        },
        4 | 12 | 20 | 28 | 36 | 44 | 52 | 60 => resolve_sib(0 != 0i32)?,
        68 | 76 | 84 | 92 | 100 | 108 | 116 | 124 => resolve_sib(0 != 1i32)? + read_imm8s()?,
        132 | 140 | 148 | 156 | 164 | 172 | 180 | 188 => resolve_sib(0 != 1i32)? + read_imm32s()?,
        5 | 13 | 21 | 29 | 37 | 45 | 53 | 61 => get_seg_prefix_ds(read_imm32s()?),
        69 | 77 | 85 | 93 | 101 | 109 | 117 | 125 => {
            get_seg_prefix_ss(*reg32s.offset(EBP as isize) + read_imm8s()?)
        },
        133 | 141 | 149 | 157 | 165 | 173 | 181 | 189 => {
            get_seg_prefix_ss(*reg32s.offset(EBP as isize) + read_imm32s()?)
        },
        6 | 14 | 22 | 30 | 38 | 46 | 54 | 62 => get_seg_prefix_ds(*reg32s.offset(ESI as isize)),
        70 | 78 | 86 | 94 | 102 | 110 | 118 | 126 => {
            get_seg_prefix_ds(*reg32s.offset(ESI as isize) + read_imm8s()?)
        },
        134 | 142 | 150 | 158 | 166 | 174 | 182 | 190 => {
            get_seg_prefix_ds(*reg32s.offset(ESI as isize) + read_imm32s()?)
        },
        7 | 15 | 23 | 31 | 39 | 47 | 55 | 63 => get_seg_prefix_ds(*reg32s.offset(EDI as isize)),
        71 | 79 | 87 | 95 | 103 | 111 | 119 | 127 => {
            get_seg_prefix_ds(*reg32s.offset(EDI as isize) + read_imm8s()?)
        },
        135 | 143 | 151 | 159 | 167 | 175 | 183 | 191 => {
            get_seg_prefix_ds(*reg32s.offset(EDI as isize) + read_imm32s()?)
        },
        _ => {
            dbg_assert!(0 != 0i32);
            0i32
        },
    })
}
