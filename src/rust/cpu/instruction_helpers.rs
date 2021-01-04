macro_rules! SAFE_READ_WRITE8 {
    ($value:ident, $addr:expr, $instruction:expr) => {{
        use cpu::cpu::translate_address_write_and_can_skip_dirty;
        use cpu::memory;
        use page::Page;
        let (phys_addr, can_skip_dirty_page) =
            return_on_pagefault!(translate_address_write_and_can_skip_dirty($addr));
        let $value = memory::read8(phys_addr);
        let value = $instruction;
        if memory::in_mapped_range(phys_addr) {
            memory::mmap_write8(phys_addr, value);
        }
        else {
            if !can_skip_dirty_page {
                ::jit::jit_dirty_page(::jit::get_jit_state(), Page::page_of(phys_addr));
            }
            else {
                dbg_assert!(!::jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
            }
            memory::write8_no_mmap_or_dirty_check(phys_addr, value);
        }
    }};
}
macro_rules! SAFE_READ_WRITE16 {
    ($value:ident, $addr:expr, $instruction:expr) => {{
        use cpu::cpu::{
            translate_address_write_and_can_skip_dirty, virt_boundary_read16, virt_boundary_write16,
        };
        use cpu::memory;
        use page::Page;
        let (phys_addr, can_skip_dirty_page) =
            return_on_pagefault!(translate_address_write_and_can_skip_dirty($addr));
        if phys_addr & 0xFFF == 0xFFF {
            let phys_addr_high = return_on_pagefault!(translate_address_write($addr + 1));
            let $value = virt_boundary_read16(phys_addr, phys_addr_high);
            virt_boundary_write16(phys_addr, phys_addr_high, $instruction);
        }
        else {
            let $value = memory::read16(phys_addr);
            let value = $instruction;
            if memory::in_mapped_range(phys_addr) {
                memory::mmap_write16(phys_addr, value);
            }
            else {
                if !can_skip_dirty_page {
                    ::jit::jit_dirty_page(::jit::get_jit_state(), Page::page_of(phys_addr));
                }
                else {
                    dbg_assert!(!::jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
                }
                memory::write16_no_mmap_or_dirty_check(phys_addr, value);
            };
        }
    }};
}
macro_rules! SAFE_READ_WRITE32 {
    ($value:ident, $addr:expr, $instruction:expr) => {{
        use cpu::cpu::{
            translate_address_write_and_can_skip_dirty, virt_boundary_read32s,
            virt_boundary_write32,
        };
        use cpu::memory;
        use page::Page;
        let (phys_addr, can_skip_dirty_page) =
            return_on_pagefault!(translate_address_write_and_can_skip_dirty($addr));
        if phys_addr & 0xFFF >= 0xFFD {
            let phys_addr_high = return_on_pagefault!(translate_address_write($addr + 3 & !3));
            let phys_addr_high = phys_addr_high | ($addr as u32) + 3 & 3;
            let $value = virt_boundary_read32s(phys_addr, phys_addr_high);
            virt_boundary_write32(phys_addr, phys_addr_high, $instruction);
        }
        else {
            let $value = memory::read32s(phys_addr);
            let value = $instruction;
            if memory::in_mapped_range(phys_addr) {
                memory::mmap_write32(phys_addr, value);
            }
            else {
                if !can_skip_dirty_page {
                    ::jit::jit_dirty_page(::jit::get_jit_state(), Page::page_of(phys_addr));
                }
                else {
                    dbg_assert!(!::jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
                }
                memory::write32_no_mmap_or_dirty_check(phys_addr, value);
            };
        }
    }};
}
