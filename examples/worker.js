importScripts("../../build/libv86.js");

var worker = this;

var emulator = new V86Starter({
    memory_size: 32 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    bios: {
        url: "../../bios/seabios.bin",
    },
    vga_bios: {
        url: "../../bios/vgabios.bin",
    },
    cdrom: {
        url: "../../images/linux.iso",
    },
    autostart: true,
});


emulator.add_listener("serial0-output-char", function(chr)
{
    worker.postMessage(chr);
});

