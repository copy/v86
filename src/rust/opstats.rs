use codegen::gen_increment_mem32;
use global_pointers;
use wasmgen::module_init::WasmBuilder;

pub fn gen_opstats(builder: &mut WasmBuilder, mut instruction: u32) {
    if !cfg!(debug_assertions) {
        return;
    }
    let mut is_0f = false;

    for _ in 0..4 {
        let opcode = instruction & 0xFF;
        instruction >>= 8;

        // TODO:
        // - If instruction depends on middle bits of modrm_byte, split
        // - Split depending on memory or register variant
        // - If the instruction uses 4 or more prefixes, only the prefixes will be counted

        if is_0f {
            gen_increment_mem32(builder, global_pointers::OPSTATS_BUFFER_0F + 4 * opcode);
            break;
        }
        else {
            gen_increment_mem32(builder, global_pointers::OPSTATS_BUFFER + 4 * opcode);

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
                // prefix
            }
            else {
                break;
            }
        }
    }
}
