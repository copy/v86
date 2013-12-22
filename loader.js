// load all files to run v86 in browser, uncompiled

(function()
{
    var PATH = "src/",
        CORE_FILES="const.js io.js cpu.js main.js ide.js pci.js floppy.js memory.js dma.js pit.js vga.js ps2.js pic.js rtc.js uart.js hpet.js"
        BROWSER_FILES="browser/main.js browser/screen.js browser/keyboard.js browser/mouse.js"

    load_scripts(CORE_FILES);
    load_scripts(BROWSER_FILES);

    function load_scripts(resp)
    {
        var files = resp.split(" "),
            script;

        for(var i = 0; i < files.length; i++)
        {
            // this may be a bad idea, if someone tries to 
            // load this script after the document has loaded,
            // but it's necessary to ensure that scripts are 
            // loaded in order
            document.write('<script src="' + PATH + files[i] + "?" + Math.random() + '"></script>');

            //script = document.createElement("script");
            //script.src = PATH + files[i] + "?" + Math.random();
            //script.defer = "defer";
            //document.body.appendChild(script);
        }
    }
})();
