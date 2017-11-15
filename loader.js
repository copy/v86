// load all files to run v86 in browser, uncompiled

(function()
{
    "use strict";

    var CORE_FILES =
        "const.js config.js log.js cpu.js debug.js translate.js modrm.js string.js arith.js misc_instr.js instructions.js " +
        "io.js main.js lib.js ide.js fpu.js pci.js floppy.js " +
        "memory.js dma.js pit.js vga.js ps2.js pic.js rtc.js uart.js acpi.js apic.js ioapic.js hpet.js sb16.js " +
        "ne2k.js state.js virtio.js bus.js elf.js";

    var BROWSER_FILES = "main.js screen.js keyboard.js mouse.js speaker.js serial.js lib.js network.js starter.js worker_bus.js";
    //var LIB_FILES = "esprima.js walk.js";
    var LIB_FILES = "";

    // jor1k stuff
    LIB_FILES += " jor1k.js 9p.js filesystem.js marshall.js utf8.js";

    var to_load = [];

    load_scripts(CORE_FILES, "src/");
    load_scripts(BROWSER_FILES, "src/browser/");
    load_scripts(LIB_FILES, "lib/");

    function load_scripts(resp, path)
    {
        var files = resp.split(" ");

        for(var i = 0; i < files.length; i++)
        {
            if(!files[i])
            {
                continue;
            }

            to_load.push(path + files[i]);
        }
    }

    load_next();

    function load_next()
    {
        var s = to_load.shift();

        if(!s)
        {
            return;
        }

        var script = document.createElement("script");
        script.src = s;
        script.onload = load_next;
        document.head.appendChild(script);
    }
})();
