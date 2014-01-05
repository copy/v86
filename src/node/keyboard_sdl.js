"use strict";

/**
 * @constructor
 */
function NodeKeyboardSDL(sdl)
{
    var send_code;

    sdl.events.on("KEYDOWN", onkeydown);
    sdl.events.on("KEYUP", onkeyup);

    this.enabled = true;

    this.destroy = function()
    {

    };

    this.init = function(send_code_fn)
    {
        send_code = send_code_fn;
    };

    function onkeydown(e)
    {
        //console.log("d", e);
        send_code(e.scancode - 8);
    }

    function onkeyup(e)
    {
        //console.log("u", e);
        send_code(e.scancode - 8 | 0x80);
    }
}


