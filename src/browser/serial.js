"use strict";

/**
 * @constructor
 */
function SerialAdapter(element)
{
    var 
        serial = this,
        send_char;

    this.enabled = true;

    this.init = function(code_fn)
    {
        this.destroy();

        send_char = code_fn;

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

    this.put_str = function(str)
    {
        if(str === "\x08")
        {
            var text = element.value;
            element.value = text.substr(0, text.length - 1);
        }
        else if(str === "\r")
        {
            // do nothing 
        }
        else
        {
            element.value += str;

            if(str === "\n")
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
        if(!may_handle(e))
        {
            return;
        }

        var chr = e.keyCode;

        send_char(chr);
        e.preventDefault();
    }

    function keydown_handler(e)
    {
        var chr = e.keyCode;

        if(chr === 8)
        {
            // supress backspace
            send_char(127);
            e.preventDefault();
        }
    }

    function paste_handler(e)
    {
        //console.log(e.clipboardData.getData('text/plain'));

        var data = e.clipboardData.getData('text/plain');

        for(var i = 0; i < data.length; i++)
        {
            send_char(data.charCodeAt(i));
        }

        e.preventDefault();
    }
}
