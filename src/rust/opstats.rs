use crate::wasmgen::wasm_builder::WasmBuilder;

const SIZE: usize = if cfg!(feature = "profiler") { 8192 } else { 0 };

#[allow(non_upper_case_globals)]
pub static mut opstats_buffer: [u64; SIZE] = [0; SIZE];
#[allow(non_upper_case_globals)]
pub static mut opstats_compiled_buffer: [u64; SIZE] = [0; SIZE];
#[allow(non_upper_case_globals)]
pub static mut opstats_jit_exit_buffer: [u64; SIZE] = [0; SIZE];
#[allow(non_upper_case_globals)]
pub static mut opstats_unguarded_register_buffer: [u64; SIZE] = [0; SIZE];
#[allow(non_upper_case_globals)]
pub static mut opstats_wasm_size: [u64; SIZE] = [0; SIZE];

pub struct Instruction {
    pub prefixes: Vec<u8>,
    pub opcode: u8,
    pub fixed_g: u8,
    pub is_mem: bool,
    pub is_0f: bool,
}

pub fn decode(mut instruction: u32) -> Instruction {
    let mut is_0f = false;
    let mut prefixes = vec![];
    let mut final_opcode = 0;

    for _ in 0..4 {
        let opcode = (instruction & 0xFF) as u8;
        instruction >>= 8;

        // TODO:
        // - If the instruction uses 4 or more prefixes, only the prefixes will be counted

        if is_0f {
            final_opcode = opcode;
            break;
        }
        else {
            if opcode == 0x0F {
                is_0f = true;
            }
            else if opcode == 0x26
                || opcode == 0x2E
                || opcode == 0x36
                || opcode == 0x3E
                || opcode == 0x64
                || opcode == 0x65
                || opcode == 0x66
                || opcode == 0x67
                || opcode == 0xF0
                || opcode == 0xF2
                || opcode == 0xF3
            {
                prefixes.push(opcode);
            }
            else {
                final_opcode = opcode;
                break;
            }
        }
    }

    let has_modrm_byte = if is_0f {
        match final_opcode {
            0x0 | 0x1 | 0x2 | 0x3 | 0x10 | 0x11 | 0x12 | 0x13 | 0x14 | 0x15 | 0x16 | 0x17
            | 0x18 | 0x19 | 0x20 | 0x21 | 0x22 | 0x23 | 0x28 | 0x29 | 0x40 | 0x41 | 0x42 | 0x43
            | 0x44 | 0x45 | 0x46 | 0x47 | 0x48 | 0x49 | 0x50 | 0x51 | 0x52 | 0x53 | 0x54 | 0x55
            | 0x56 | 0x57 | 0x58 | 0x59 | 0x60 | 0x61 | 0x62 | 0x63 | 0x64 | 0x65 | 0x66 | 0x67
            | 0x68 | 0x69 | 0x70 | 0x71 | 0x72 | 0x73 | 0x74 | 0x75 | 0x76 | 0x90 | 0x91 | 0x92
            | 0x93 | 0x94 | 0x95 | 0x96 | 0x97 | 0x98 | 0x99 | 0x1c | 0x1d | 0x1e | 0x1f | 0x2a
            | 0x2b | 0x2c | 0x2d | 0x2e | 0x2f | 0x4a | 0x4b | 0x4c | 0x4d | 0x4e | 0x4f | 0x5a
            | 0x5b | 0x5c | 0x5d | 0x5e | 0x5f | 0x6a | 0x6b | 0x6c | 0x6d | 0x6e | 0x6f | 0x7e
            | 0x7f | 0x9a | 0x9b | 0x9c | 0x9d | 0x9e | 0x9f | 0xa3 | 0xa4 | 0xa5 | 0xab | 0xac
            | 0xad | 0xae | 0xaf | 0xb0 | 0xb1 | 0xb2 | 0xb3 | 0xb4 | 0xb5 | 0xb6 | 0xb7 | 0xb8
            | 0xba | 0xbb | 0xbc | 0xbd | 0xbe | 0xbf | 0xc0 | 0xc1 | 0xc2 | 0xc3 | 0xc4 | 0xc5
            | 0xc6 | 0xc7 | 0xd1 | 0xd2 | 0xd3 | 0xd4 | 0xd5 | 0xd6 | 0xd7 | 0xd8 | 0xd9 | 0xda
            | 0xdb | 0xdc | 0xdd | 0xde | 0xdf | 0xe0 | 0xe1 | 0xe2 | 0xe3 | 0xe4 | 0xe5 | 0xe6
            | 0xe7 | 0xe8 | 0xe9 | 0xea | 0xeb | 0xec | 0xed | 0xee | 0xef | 0xf1 | 0xf2 | 0xf3
            | 0xf4 | 0xf5 | 0xf6 | 0xf7 | 0xf8 | 0xf9 | 0xfa | 0xfb | 0xfc | 0xfd | 0xfe => true,
            _ => false,
        }
    }
    else {
        match final_opcode {
            0x0 | 0x1 | 0x2 | 0x3 | 0x8 | 0x9 | 0x10 | 0x11 | 0x12 | 0x13 | 0x18 | 0x19 | 0x20
            | 0x21 | 0x22 | 0x23 | 0x28 | 0x29 | 0x30 | 0x31 | 0x32 | 0x33 | 0x38 | 0x39 | 0x62
            | 0x63 | 0x69 | 0x80 | 0x81 | 0x82 | 0x83 | 0x84 | 0x85 | 0x86 | 0x87 | 0x88 | 0x89
            | 0xa | 0xb | 0x1a | 0x1b | 0x2a | 0x2b | 0x3a | 0x3b | 0x6b | 0x8a | 0x8b | 0x8c
            | 0x8d | 0x8e | 0x8f | 0xc0 | 0xc1 | 0xc4 | 0xc5 | 0xc6 | 0xc7 | 0xd0 | 0xd1 | 0xd2
            | 0xd3 | 0xd8 | 0xd9 | 0xda | 0xdb | 0xdc | 0xdd | 0xde | 0xdf | 0xf6 | 0xf7 | 0xfe
            | 0xff => true,
            _ => false,
        }
    };

    let has_fixed_g = if is_0f {
        final_opcode == 0x71
            || final_opcode == 0x72
            || final_opcode == 0x73
            || final_opcode == 0xAE
            || final_opcode == 0xBA
            || final_opcode == 0xC7
    }
    else {
        final_opcode >= 0x80 && final_opcode < 0x84
            || final_opcode >= 0xC0 && final_opcode < 0xC2
            || final_opcode >= 0xD0 && final_opcode < 0xD4
            || final_opcode >= 0xD8 && final_opcode < 0xE0
            || final_opcode >= 0xF6 && final_opcode < 0xF8
            || final_opcode == 0xFE
            || final_opcode == 0xFF
    };

    let mut is_mem = false;
    let mut fixed_g = 0;

    if has_fixed_g {
        dbg_assert!(has_modrm_byte);
        let modrm_byte = (instruction & 0xFF) as u8;
        fixed_g = modrm_byte >> 3 & 7;
        is_mem = modrm_byte < 0xC0
    }
    if has_modrm_byte {
        let modrm_byte = (instruction & 0xFF) as u8;
        is_mem = modrm_byte < 0xC0
    }

    Instruction {
        prefixes,
        opcode: final_opcode,
        is_mem,
        fixed_g,
        is_0f,
    }
}

pub fn gen_opstats(builder: &mut WasmBuilder, opcode: u32) {
    if !cfg!(feature = "profiler") {
        return;
    }

    let instruction = decode(opcode);

    for prefix in instruction.prefixes {
        let index = (prefix as u32) << 4;
        builder.increment_fixed_i64(
            unsafe { &mut opstats_buffer[index as usize] as *mut _ } as u32,
            1,
        );
    }

    let index = (instruction.is_0f as u32) << 12
        | (instruction.opcode as u32) << 4
        | (instruction.is_mem as u32) << 3
        | instruction.fixed_g as u32;

    builder.increment_fixed_i64(
        unsafe { &mut opstats_buffer[index as usize] as *mut _ } as u32,
        1,
    );
}

pub fn record_opstat_compiled(opcode: u32) {
    if !cfg!(feature = "profiler") {
        return;
    }

    let instruction = decode(opcode);

    for prefix in instruction.prefixes {
        let index = (prefix as u32) << 4;
        unsafe { opstats_compiled_buffer[index as usize] += 1 }
    }

    let index = (instruction.is_0f as u32) << 12
        | (instruction.opcode as u32) << 4
        | (instruction.is_mem as u32) << 3
        | instruction.fixed_g as u32;

    unsafe { opstats_compiled_buffer[index as usize] += 1 }
}

pub fn record_opstat_jit_exit(opcode: u32) {
    if !cfg!(feature = "profiler") {
        return;
    }

    let instruction = decode(opcode);

    for prefix in instruction.prefixes {
        let index = (prefix as u32) << 4;
        unsafe { opstats_jit_exit_buffer[index as usize] += 1 }
    }

    let index = (instruction.is_0f as u32) << 12
        | (instruction.opcode as u32) << 4
        | (instruction.is_mem as u32) << 3
        | instruction.fixed_g as u32;

    unsafe { opstats_jit_exit_buffer[index as usize] += 1 }
}

pub fn gen_opstat_unguarded_register(builder: &mut WasmBuilder, opcode: u32) {
    if !cfg!(feature = "profiler") {
        return;
    }

    let instruction = decode(opcode);

    for prefix in instruction.prefixes {
        let index = (prefix as u32) << 4;
        builder.increment_fixed_i64(
            unsafe { &mut opstats_unguarded_register_buffer[index as usize] as *mut _ } as u32,
            1,
        );
    }

    let index = (instruction.is_0f as u32) << 12
        | (instruction.opcode as u32) << 4
        | (instruction.is_mem as u32) << 3
        | instruction.fixed_g as u32;

    builder.increment_fixed_i64(
        unsafe { &mut opstats_unguarded_register_buffer[index as usize] as *mut _ } as u32,
        1,
    );
}

pub fn record_opstat_size_wasm(opcode: u32, size: u64) {
    if !cfg!(feature = "profiler") {
        return;
    }

    let instruction = decode(opcode);

    for prefix in instruction.prefixes {
        let index = (prefix as u32) << 4;
        unsafe { opstats_wasm_size[index as usize] += size }
    }

    let index = (instruction.is_0f as u32) << 12
        | (instruction.opcode as u32) << 4
        | (instruction.is_mem as u32) << 3
        | instruction.fixed_g as u32;

    unsafe { opstats_wasm_size[index as usize] += size }
}
