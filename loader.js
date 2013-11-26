// load all files to run v86 in browser, uncompiled

(function()
{
    var PATH = "src/",
        CORE_FILES="const.js io.js cpu.js main.js ide.js pci.js floppy.js memory.js dma.js pit.js vga.js ps2.js pic.js rtc.js uart.js"
        BROWSER_FILES="browser/main.js browser/screen.js browser/keyboard.js browser/mouse.js"

    window.onload = function()
    {
        load_scripts(CORE_FILES);
        load_scripts(BROWSER_FILES);

        function load_scripts(resp)
        {
            var files = resp.split(" "),
                script;

            for(var i = 0; i < files.length; i++)
            {
                script = document.createElement("script");
                script.src = PATH + files[i] + "?" + Math.random();
                document.body.appendChild(script);
            }
        }
    };

})();
