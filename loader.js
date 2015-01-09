// load all files to run v86 in browser, uncompiled

(function()
{
    var CORE_FILES = "const.js io.js main.js lib.js ide.js fpu.js pci.js floppy.js " +
                     "memory.js dma.js pit.js vga.js ps2.js pic.js rtc.js uart.js acpi.js hpet.js " +
                     "ne2k.js state.js virtio.js bus.js log.js";
    var BROWSER_FILES = "main.js screen.js keyboard.js mouse.js serial.js lib.js network.js starter.js";
    var LIB_FILES = "esprima.js walk.js";

    // jor1k stuff
    LIB_FILES += " jor1k.js 9p.js filesystem.js marshall.js utf8.js";

    load_scripts("cpu.js", "build/");
    load_scripts(CORE_FILES, "src/");
    load_scripts(BROWSER_FILES, "src/browser/");
    load_scripts(LIB_FILES, "lib/");

    function load_scripts(resp, path)
    {
        var files = resp.split(" "),
            script;

        for(var i = 0; i < files.length; i++)
        {
            // this may be a bad idea, if someone tries to 
            // load this script after the document has loaded,
            // but it's necessary to ensure that scripts are 
            // loaded in order
            document.write('<script src="' + path + files[i] + '"></script>');

            //script = document.createElement("script");
            //script.src = PATH + files[i] + "?" + Math.random();
            //script.defer = "defer";
            //document.body.appendChild(script);
        }
    }
})();
