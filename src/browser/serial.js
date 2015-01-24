"use strict";

/**
 * @constructor
 */
function SerialAdapter(element, bus)
{
    var serial = this;

    this.enabled = true;
    this.bus = bus;

    this.bus.register("serial0-output-char", function(chr)
    {
        this.show_char(chr);
    }, this);


    this.destroy = function() 
    {
        element.removeEventListener("keypress", keypress_handler, false);
        element.removeEventListener("keydown", keydown_handler, false);
        element.removeEventListener("paste", paste_handler, false);
    };

    this.init = function()
    {
        this.destroy();

        element.addEventListener("keypress", keypress_handler, false);
        element.addEventListener("keydown", keydown_handler, false);
        element.addEventListener("paste", paste_handler, false);
    };
    this.init();


    this.show_char = function(chr)
    {
        if(chr === "\x08")
        {
            var text = element.value;
            element.value = text.substr(0, text.length - 1);
        }
        else if(chr === "\r")
        {
            // do nothing 
        }
        else
        {
            element.value += chr;

            if(chr === "\n")
            {
                element.scrollTop = 1e9;
            }
        }
    };

    /**
     * @param {number} chr_code
     */
    this.send_char = function(chr_code)
    {
        if(serial.bus)
        {
            serial.bus.send("serial0-input", chr_code);
        }
    };

    function may_handle(e)
    {
        if(!serial.enabled)
        {
            return false;
        }

        // Something here?

        return true;
    }

    function keypress_handler(e)
    {
        if(!serial.bus)
        {
            return;
        }
        if(!may_handle(e))
        {
            return;
        }

        var chr = e.which;

        serial.send_char(chr);
        e.preventDefault();
    }

    function keydown_handler(e)
    {
        var chr = e.which;

        if(chr === 8)
        {
            // supress backspace
            serial.send_char(127);
            e.preventDefault();
        }
    }

    function paste_handler(e)
    {
        var data = e.clipboardData.getData("text/plain");

        for(var i = 0; i < data.length; i++)
        {
            serial.send_char(data.charCodeAt(i));
        }

        e.preventDefault();
    }
}
