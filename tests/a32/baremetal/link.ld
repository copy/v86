/* The bare-metal AArch32 guests' layout (tests/a32/baremetal/include/a32.h):
   the image at RAM + 0x10000, the heap after it, the stacks below the
   result block (a64.h's). */
ENTRY(_start)
SECTIONS
{
    . = 0x40010000;
    .text : { KEEP(*(.text.head)) *(.text .text.*) }
    .rodata : { *(.rodata .rodata.*) }
    .ARM.exidx : { *(.ARM.exidx*) }
    .data : { *(.data .data.*) }
    . = ALIGN(16);
    __bss_start = .;
    .bss : { *(.bss .bss.*) *(COMMON) }
    . = ALIGN(16);
    _end = .;
    __stack_top = 0x40800000;
    ASSERT(_end <= 0x40400000, "the image overlaps the heap")
}
