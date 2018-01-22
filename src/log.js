"use strict";

var log_data = [];

function do_the_log(message)
{
    if(LOG_TO_FILE)
    {
        log_data.push(message, "\n");
    }
    else
    {
        console.log(message);
    }
}

/**
 * @type {function((string|number), number=)}
 * @const
 */
var dbg_log = (function()
{
    if(!DEBUG)
    {
        return function() {};
    }

    /** @const @type {Object.<number, string>} */
    var dbg_names = LOG_NAMES.reduce(function(a, x)
    {
        a[x[0]] = x[1];
        return a;
    }, {});

    var log_last_message = "";
    var log_message_repetitions = 0;

    /**
     * @param {number=} level
     */
    function dbg_log_(stuff, level)
    {
        if(!DEBUG) return;

        level = level || 1;

        if(level & LOG_LEVEL)
        {
            var level_name = dbg_names[level] || "",
                message = "[" + v86util.pads(level_name, 4) + "] " + stuff;

            if(message === log_last_message)
            {
                log_message_repetitions++;

                if(log_message_repetitions < 2048)
                {
                    return;
                }
            }

            var now = new Date();
            var time_str = v86util.pad0(now.getHours(), 2) + ":" +
                           v86util.pad0(now.getMinutes(), 2) + ":" +
                           v86util.pad0(now.getSeconds(), 2) + "+" +
                           v86util.pad0(now.getMilliseconds(), 3) + " ";

            if(log_message_repetitions)
            {
                if(log_message_repetitions === 1)
                {
                    do_the_log(time_str + log_last_message);
                }
                else
                {
                    do_the_log("Previous message repeated " + log_message_repetitions + " times");
                }

                log_message_repetitions = 0;
            }

            do_the_log(time_str + message);
            log_last_message = message;
        }
    }

    return dbg_log_;
})();

function dbg_log_wasm(memory, format_string_offset, stack)
{
    if(!DEBUG || !(LOG_LEVEL & LOG_CPU))
    {
        return;
    }

    let s = new Uint8Array(memory, format_string_offset);

    const length = s.indexOf(0);
    if(length !== -1)
    {
        s = new Uint8Array(memory, format_string_offset, length);
    }

    function pop_arg()
    {
        const arg = new Int32Array(memory, stack, 1)[0];
        stack += 4;
        return arg;
    }

    let format_string = String.fromCharCode.apply(String, s);
    format_string = format_string.replace(/%([xd%])/g, function(full_match, identifier)
        {
            if(identifier === "x")
            {
                return (pop_arg() >>> 0).toString(16);
            }
            else if(identifier === "d")
            {
                return pop_arg().toString(10);
            }
            else if(identifier === "%")
            {
                return "%";
            }
            else
            {
                console.assert(false);
            }
        });

    dbg_log(format_string, LOG_CPU);
}

/**
 * @param {number=} level
 */
function dbg_trace(level)
{
    if(!DEBUG) return;

    dbg_log(Error().stack.replace(/(?:(?:t|t16|t32)\.\(anonymous function\)\.)+/g, "t.(anonymous function)."), level);
}

/**
 * console.assert is fucking slow
 * @param {string=} msg
 * @param {number=} level
 */
function dbg_assert(cond, msg, level)
{
    if(!DEBUG) return;

    if(!cond)
    {
        dbg_assert_failed(msg);
    }
}


function dbg_assert_failed(msg)
{
    debugger;
    console.trace();

    if(msg)
    {
        throw "Assert failed: " + msg;
    }
    else
    {
        throw "Assert failed";
    }
}
