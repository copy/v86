use codegen::gen_increment_mem32;
use cpu2;
use global_pointers;
use wasmgen::module_init::WasmBuilder;

struct Instruction {
    prefixes: Vec<u8>,
    opcode: u8,
    is_0f: bool,
}

fn decode(mut instruction: u32) -> Instruction {
    let mut is_0f = false;
    let mut prefixes = vec![];
    let mut final_opcode = 0;

    for _ in 0..4 {
        let opcode = (instruction & 0xFF) as u8;
        instruction >>= 8;

        // TODO:
        // - If instruction depends on middle bits of modrm_byte, split
        // - Split depending on memory or register variant
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

    Instruction {
        prefixes,
        opcode: final_opcode,
        is_0f,
    }
}

pub fn gen_opstats(builder: &mut WasmBuilder, opcode: u32) {
    if !cfg!(feature = "profiler") {
        return;
    }

    let instruction = decode(opcode);

    for prefix in instruction.prefixes {
        gen_increment_mem32(builder, global_pointers::OPSTATS_BUFFER + 4 * prefix as u32);
    }

    if instruction.is_0f {
        gen_increment_mem32(
            builder,
            global_pointers::OPSTATS_BUFFER_0F + 4 * instruction.opcode as u32,
        );
    }
    else {
        gen_increment_mem32(
            builder,
            global_pointers::OPSTATS_BUFFER + 4 * instruction.opcode as u32,
        );
    }
}

pub fn record_opstat_compiled(opcode: u32) {
    let instruction = decode(opcode);

    for prefix in instruction.prefixes {
        unsafe { *cpu2::global_pointers::opstats_compiled_buffer.offset(prefix as isize) += 1 }
    }

    if instruction.is_0f {
        unsafe {
            *cpu2::global_pointers::opstats_compiled_buffer_0f
                .offset(instruction.opcode as isize) += 1
        }
    }
    else {
        unsafe {
            *cpu2::global_pointers::opstats_compiled_buffer.offset(instruction.opcode as isize) += 1
        }
    }
}
