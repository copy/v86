macro_rules! SAFE_READ_WRITE8 {
    ($value:ident, $addr:expr, $instruction:expr) => {{
        use cpu2::cpu::translate_address_write;
        use cpu2::memory::{read8, write8};
        let phys_addr = return_on_pagefault!(translate_address_write($addr));
        let $value = read8(phys_addr);
        write8(phys_addr, $instruction);
    }};
}
macro_rules! SAFE_READ_WRITE16 {
    ($value:ident, $addr:expr, $instruction:expr) => {{
        use cpu2::cpu::{translate_address_write, virt_boundary_read16, virt_boundary_write16};
        use cpu2::memory::{read16, write16};
        let phys_addr = return_on_pagefault!(translate_address_write($addr));
        if phys_addr & 0xFFF == 0xFFF {
            let phys_addr_high = return_on_pagefault!(translate_address_write($addr + 1));
            let $value = virt_boundary_read16(phys_addr, phys_addr_high);
            virt_boundary_write16(phys_addr, phys_addr_high, $instruction);
        }
        else {
            let $value = read16(phys_addr);
            write16(phys_addr, $instruction);
        }
    }};
}
macro_rules! SAFE_READ_WRITE32 {
    ($value:ident, $addr:expr, $instruction:expr) => {{
        use cpu2::cpu::{translate_address_write, virt_boundary_read32s, virt_boundary_write32};
        use cpu2::memory::{read32s, write32};
        let phys_addr = return_on_pagefault!(translate_address_write($addr));
        if phys_addr & 0xFFF >= 0xFFD {
            let phys_addr_high = return_on_pagefault!(translate_address_write($addr + 3 & !3));
            let phys_addr_high = phys_addr_high | ($addr as u32) + 3 & 3;
            let $value = virt_boundary_read32s(phys_addr, phys_addr_high);
            virt_boundary_write32(phys_addr, phys_addr_high, $instruction);
        }
        else {
            let $value = read32s(phys_addr);
            write32(phys_addr, $instruction);
        }
    }};
}
