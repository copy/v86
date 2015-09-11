importScripts("../build/libv86.js");

var emulator = new V86Starter({
    memory_size: 32 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    bios: {
        url: "../bios/seabios.bin",
    },
    vga_bios: {
        url: "../bios/vgabios.bin",
    },
    cdrom: {
        url: "../images/linux.iso",
    },
    autostart: true,
});


emulator.add_listener("serial0-output-char", function(chr)
{
    this.postMessage(chr);
}.bind(this));

this.onmessage = function(e)
{
    emulator.serial0_send(e.data);
};

