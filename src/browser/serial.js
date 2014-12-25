"use strict";

/**
 * @constructor
 */
function SerialAdapter(element)
{
    var serial = this;

    this.enabled = true;
    this.bus = undefined;

    this.register = function(bus)
    {
        this.destroy();
        this.bus = bus;

        bus.register("serial0-output", function(chr)
        {
            this.put_chr(chr);
        }, this);

        element.addEventListener("keypress", keypress_handler, false);
        element.addEventListener("keydown", keydown_handler, false);
        element.addEventListener("paste", paste_handler, false);
    };

    this.destroy = function() 
    {
        element.removeEventListener("keypress", keypress_handler, false);
        element.removeEventListener("keydown", keydown_handler, false);
        element.removeEventListener("paste", paste_handler, false);
    };

    this.put_chr = function(chr)
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
    }

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

        var chr = e.keyCode;

        serial.bus.send("serial0-input", chr);
        e.preventDefault();
    }

    function keydown_handler(e)
    {
        if(!serial.bus)
        {
            return;
        }
        var chr = e.keyCode;

        if(chr === 8)
        {
            // supress backspace
            serial.bus.send("serial0-input", 127);
            e.preventDefault();
        }
    }

    function paste_handler(e)
    {
        //console.log(e.clipboardData.getData('text/plain'));
        if(!serial.bus)
        {
            return;
        }

        var data = e.clipboardData.getData('text/plain');

        for(var i = 0; i < data.length; i++)
        {
            serial.bus.send("serial0-input", data.charCodeAt(i));
        }

        e.preventDefault();
    }
}
