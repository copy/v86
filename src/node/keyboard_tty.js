"use strict";

/**
 * @constructor
 */
function NodeKeyboardTTY()
{
    var stdin = process.stdin;
    var send_code;

    var charmap = [
        // TODO: Fill this in or get it from somewhere
    ];

    //stdin.setRawMode(true);
    stdin.resume();


    stdin.setEncoding('utf8');

    this.enabled = true;
    this.destroy = function()
    {

    };
    this.init = function(send_code_fn)
    {
        send_code = send_code_fn;
    };

    stdin.on("data", function(c)
    {
        if(c === '\u0003')
        {
            process.exit();
        }

        var str = "";

        for(var i = 0; i < c.length; i++)
        {
            str += c.charCodeAt(i);   
        }

        //dbg_log(str);
        dbg_log("2 " + JSON.stringify(arguments));
    });

    stdin.on("keypress", function(c)
    {
        if(c === '\u0003')
        {
            process.exit();
        }

        dbg_log("keypress: " + JSON.stringify(arguments));

        var code = charmap[c.charCodeAt(0)];

        send_code(code);
        //send_code(code | 0x80);
    });
}
