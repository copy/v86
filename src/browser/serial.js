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
    this.text = "";
    this.text_new_line = false;
    this.control_mode = false;
    this.control_buffer = "";

    this.last_update = 0;


    this.bus.register("serial0-output-char", function(chr)
    {
        this.show_char(chr);
    }, this);


    this.destroy = function()
    {
        element.removeEventListener("keypress", keypress_handler, false);
        element.removeEventListener("keydown", keydown_handler, false);
        element.removeEventListener("paste", paste_handler, false);
        window.removeEventListener("mousedown", window_click_handler, false);
    };

    this.init = function()
    {
        this.destroy();

        element.addEventListener("keypress", keypress_handler, false);
        element.addEventListener("keydown", keydown_handler, false);
        element.addEventListener("paste", paste_handler, false);
        window.addEventListener("mousedown", window_click_handler, false);
    };
    this.init();

    this.show_char = function(chr)
    {
        if(this.control_mode === false)
        {
            if(chr === "\x08")
            {
                this.text = this.text.slice(0, -1);
                this.update();
            }
            else if(chr === "\x1b")
            {
               this.control_mode = true;
               this.control_buffer = "";
            }
            else if(chr === "\r")
            {
                // do nothing
            }
            else
            {
               this.text += chr;

               if(chr === "\n")
               {
                  this.text_new_line = true;
               }

               this.update();
            }
        }
        else
        {
            this.control_buffer += chr;
            var cmds = {
                bksp: /^\[[0-2]?J$/,
                clr: /^\[[0-9;]{0,5}H\x1b\[[0-2]?J$/,
                invalid: /[hl=>0-2M-OmrA-Efg3-8KnRc8qy]/
            };
            if(cmds.bksp.test(this.control_buffer))
            {
                //just ignore it, backspace handled above
                this.control_mode = false;
            }
            else if(cmds.clr.test(this.control_buffer))
            {
                this.text = "";
                this.control_mode = false;
                this.update();
            }
            else if(cmds.invalid.test(this.control_buffer.substr(this.control_buffer.length - 1)))
            {
                this.text = this.text + "^" + this.control_buffer;
                this.control_mode = false;
            }
        }
    };

    this.update = function()
    {
        var now = Date.now();
        var delta = now - this.last_update;

        if(delta < 16)
        {
            if(this.update_timer === undefined)
            {
                this.update_timer = setTimeout(() => {
                    this.update_timer = undefined;
                    var now = Date.now();
                    dbg_assert(now - this.last_update >= 16);
                    this.last_update = now;
                    this.render();
                }, 16 - delta);
            }
        }
        else
        {
            if(this.update_timer !== undefined)
            {
                clearTimeout(this.update_timer);
                this.update_timer = undefined;
            }

            this.last_update = now;
            this.render();
        }
    };

    this.render = function()
    {
        element.value = this.text;

        if(this.text_new_line)
        {
            this.text_new_line = false;
            element.scrollTop = 1e9;
        }
    }

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
        else if(chr === 9)
        {
            // tab
            serial.send_char(9);
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

    function window_click_handler(e)
    {
        if(e.target !== element)
        {
            element.blur();
        }
    }
}
