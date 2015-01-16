"use strict";

/**
 * @constructor
 */
function KeyboardAdapter(bus)
{
    var 
        /**
         * @type {!Object.<boolean>}
         */
        keys_pressed = {},

        keyboard = this;

    /** 
     * Set by emulator
     * @type {boolean}
     */
    this.emu_enabled = true;

    /** 
     * Format:
     * Javascript event.keyCode -> make code
     * @const 
     */
    var charmap = new Uint16Array([
        0, 0, 0, 0,  0, 0, 0, 0,
        // 0x08: backspace, tab, enter
        0x0E, 0x0F, 0, 0,  0, 0x1C, 0, 0,

        // 0x10: shift, ctrl, alt, pause, caps lock
        0x2A, 0x1D, 0x38, 0,  0x3A, 0, 0, 0,

        // 0x18: escape
        0, 0, 0, 0x01,  0, 0, 0, 0,

        // 0x20: spacebar, page down/up, end, home, arrow keys, ins, del
        0x39, 0xE049, 0xE051, 0xE04F,  0xE047, 0xE04B, 0xE048, 0xE04D,
        0x50, 0, 0, 0,  0, 0x52, 0x53, 0,

        // 0x30: numbers
        0x0B, 0x02, 0x03, 0x04,  0x05, 0x06, 0x07, 0x08, 
        0x09, 0x0A,

        // 0x3B: ;= (firefox only)
        0, 0x27, 0, 0x0D, 0, 0, 
            
        // 0x40
        0,

        // 0x41: letters
        0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 
        0x31, 0x18, 0x19, 0x10, 0x13, 0x1F, 0x14, 0x16, 0x2F, 0x11, 0x2D, 0x15, 0x2C,

        // 0x5B: Left Win, Right Win, Menu
        0xE05B, 0xE05C, 0xE05D, 0, 0,

        // 0x60: keypad
        0x52, 0x4F, 0x50, 0x51, 0x4B, 0x4C, 0x4D, 0x47,
        0x48, 0x49, 0, 0, 0, 0, 0, 0,

        // 0x70: F1 to F12
        0x3B, 0x3C, 0x3D, 0x3E, 0x3F, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58,

        0, 0, 0, 0,

        // 0x80
        0, 0, 0, 0,  0, 0, 0, 0,
        0, 0, 0, 0,  0, 0, 0, 0,

        // 0x90: Numlock
        0x45, 0, 0, 0,  0, 0, 0, 0,
        0, 0, 0, 0,     0, 0, 0, 0,

        // 0xA0: - (firefox only)
        0, 0, 0, 0,  0, 0, 0, 0,
        0, 0, 0, 0,  0, 0x0C, 0, 0,

        // 0xB0
        // ,
        0, 0, 0, 0,  0, 0, 0, 0,
        0, 0, 0x27, 0x0D,  0x33, 0x0C, 0x34, 0x35,
        
        // 0xC0
        // `
        0x29, 0, 0, 0,  0, 0, 0, 0,
        0, 0, 0, 0,     0, 0, 0, 0,

        // 0xD0
        // [']\
        0, 0, 0, 0,     0, 0, 0, 0,
        0, 0, 0, 0x1A,  0x2B, 0x1B, 0x28, 0,

        // 0xE0
        // Apple key on Gecko, Right alt
        0xE05B, 0xE038, 0, 0,  0, 0, 0, 0,
        0, 0, 0, 0,            0, 0, 0, 0,
    ]);

    this.bus = bus;

    this.destroy = function() 
    {
        window.removeEventListener("keyup", keyup_handler, false);
        window.removeEventListener("keydown", keydown_handler, false);
        window.removeEventListener("blur", blur_handler, false);
    };

    this.init = function()
    {
        if(typeof window === "undefined")
        {
            return;
        }
        this.destroy();

        window.addEventListener("keyup", keyup_handler, false);
        window.addEventListener("keydown", keydown_handler, false);
        window.addEventListener("blur", blur_handler, false);
    };
    this.init();


    function may_handle(e)
    {
        if(e.shiftKey && e.ctrlKey && e.keyCode === 74) 
        {
              // don't prevent opening chromium dev tools
              // maybe add other important combinations here, too
              return false;
        }

        if(!keyboard.emu_enabled)
        {
            return false;
        }

        if(e.target)
        {
            // className shouldn't be hardcoded here
            return e.target.className === "phone_keyboard" ||
                (e.target.nodeName !== "INPUT" && e.target.nodeName !== "TEXTAREA");
        }
        else
        {
            return true;
        }
    }

    function keyup_handler(e)
    {
        if(!may_handle(e))
        {
            return;
        }

        var code = e.keyCode;

        if(!keys_pressed[code])
        {
            // stray keyup
            return false;
        }

        keys_pressed[code] = false;

        if(!handler(code, false))
        {
            e.preventDefault();
        }
    }

    function keydown_handler(e)
    {
        if(!may_handle(e))
        {
            return;
        }

        var code = e.keyCode;

        if(keys_pressed[code])
        {
            handler(code, false);
        }

        keys_pressed[code] = true;


        if(!handler(code, true))
        {
            e.preventDefault();
        }
    }

    function blur_handler(e)
    {
        // trigger keyup for all pressed keys
        var keys = Object.keys(keys_pressed),
            key;

        for(var i = 0; i < keys.length; i++)
        {
            key = +keys[i];

            if(keys_pressed[key])
            {
                handler(key, false);
            }
        }

        keys_pressed = {};
    }

    /**
     * @param {number} chr
     * @param {boolean} keydown
     */
    function handler(chr, keydown)
    {
        if(!keyboard.bus)
        {
            return;
        }

        if(chr >= charmap.length || charmap[chr] === 0)
        {
            console.log("Missing char in map: " + chr.toString(16));
            return true;
        }

        var code = charmap[chr];

        if(!keydown)
        {
            code |= 0x80;
        }
        //console.log("Key: " + code.toString(16) + " from " + chr.toString(16) + " down=" + keydown);

        if(code > 0xFF)
        {
            // prefix
            send_to_controller(code >> 8);
            send_to_controller(code & 0xFF);
        }
        else
        {
            send_to_controller(code);
        }

        return false;
    }

    function send_to_controller(code)
    {
        keyboard.bus.send("keyboard-code", code);
    }
}

