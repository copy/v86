SECTIONS
{
    . = 16K;
    stext = .;
    .text : { *(.init) *(.text) }
    . = ALIGN(4K);
    .data : { *(.data) *(.rodata*) }
    . = ALIGN(16);
    .bss : { *(.bss) }
    edata = .;
}
ENTRY(start)
