"use strict";


/** @constructor */
function ACPI(cpu)
{
    if(!ENABLE_ACPI)
    {
        return;
    }

    var io = cpu.io;

    var acpi = {
        pci_id: 0x07 << 3,
        pci_space: [
            0x86, 0x80, 0x13, 0x71, 0x07, 0x00, 0x80, 0x02, 0x08, 0x00, 0x80, 0x06, 0x00, 0x00, 0x80, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x09, 0x01, 0x00, 0x00,
        ],
        pci_bars: [],
    };

    // 00:07.0 Bridge: Intel Corporation 82371AB/EB/MB PIIX4 ACPI (rev 08)
    cpu.devices.pci.register_device(acpi);

    var elcr = 0;

    // ACPI, ELCR register
    io.register_write(0x4d0, function(data)
    {
        elcr = elcr & 0xFF00 | data;
    });
    io.register_write(0x4d1, function(data)
    {
        elcr = elcr & 0xFF | data << 8;
    });

    io.register_read(0xb3, function()
    {
        return 0;
    });

    // ACPI, pmtimer
    io.register_read(0xb008, function()
    {
        return 0;
    });
    io.register_read(0xb009, function()
    {
        return 0;
    });
    io.register_read(0xb00a, function()
    {
        return 0;
    });
    io.register_read(0xb00b, function()
    {
        return 0;
    });

    // ACPI status
    io.register_read(0xb004, function(data)
    {
        dbg_log("b004 read");
        return 1;
    });
    io.register_read(0xb005, function(data)
    {
        dbg_log("b005 read");
        return 0;
    });


    io.mmap_register(0xFEE00000, 0x100000, 
        function(addr)
        {
            addr = addr - 0xFEE00000 | 0;
            dbg_log("APIC read " + h(addr), LOG_CPU);
            return 0;
        },
        function(addr, value)
        {
            addr = addr - 0xFEE00000 | 0;
            dbg_log("APIC write " + h(addr), LOG_CPU);
        });
}
