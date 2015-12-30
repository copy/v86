"use strict";

/**
 * @constructor
 *
 * @param {BusConnector} bus
 */
function SerialAdapter(element, bus)
{
    var serial = this;

    this.enabled = true;
    this.bus = bus;
    this.text = [];
    this.text_changed = false;
    this.text_new_line = false;


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

        setInterval(function()
        {
            if(this.text_changed)
            {
                this.text_changed = false;
                element.value = this.text.join("");

                if(this.text_new_line)
                {
                    this.text_new_line = false;
                    element.scrollTop = 1e9;
                }
            }
        }.bind(this), 16);
    };
    this.init();


    this.show_char = function(chr)
    {
        if(chr === "\x08")
        {
            this.text.pop();
            this.text_changed = true;
        }
        else if(chr === "\r")
        {
            // do nothing
        }
        else
        {
            this.text_changed = true;
            this.text.push(chr);

            if(chr === "\n")
            {
                this.text_new_line = true;
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
        if(!may_handle(e))
        {
            return;
        }

        var data = e.clipboardData.getData("text/plain");

        for(var i = 0; i < data.length; i++)
        {
            serial.send_char(data.charCodeAt(i));
        }

        e.preventDefault();
    }
}
