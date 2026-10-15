/* The bare-metal guests' layout (tests/a64/baremetal/a64.h): the image at
   RAM + 0x80000, the heap after it, the stacks below the result block. */
ENTRY(_start)
SECTIONS
{
    . = 0x40080000;
    .text : { KEEP(*(.text.head)) *(.text .text.*) }
    .rodata : { *(.rodata .rodata.*) }
    .data : { *(.data .data.*) }
    . = ALIGN(16);
    __bss_start = .;
    .bss : { *(.bss .bss.*) *(COMMON) }
    . = ALIGN(16);
    _end = .;
    __image_size = _end - 0x40080000;
    __stack_top = 0x40800000;
    ASSERT(_end <= 0x40400000, "the image overlaps the heap")
}
