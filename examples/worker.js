importScripts("../build/libv86.js");

/* global V86 */

var emulator = new V86({
    wasm_path: "../build/v86.wasm",
    memory_size: 32 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    bios: {
        url: "../bios/seabios.bin",
    },
    vga_bios: {
        url: "../bios/vgabios.bin",
    },
    cdrom: {
        url: "../images/linux4.iso",
    },
    autostart: true,
});


emulator.add_listener("serial0-output-byte", function(byte)
{
    var chr = String.fromCharCode(byte);
    this.postMessage(chr);
}.bind(this));

this.onmessage = function(e)
{
    emulator.serial0_send(e.data);
};
