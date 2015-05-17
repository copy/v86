"use strict";

/** 
 * @type {function((string|number), number=)}
 * @const 
 */
var dbg_log = (function()
{
    /** @const */
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
                           v86util.pad0(now.getSeconds(), 2) + " ";

            if(log_message_repetitions)
            {
                if(log_message_repetitions === 1)
                {
                    console.log(time_str + log_last_message);
                }
                else 
                {
                    console.log("Previous message repeated " + log_message_repetitions + " times");
                }

                log_message_repetitions = 0;
            }

            console.log(time_str + message);

            log_last_message = message;
        }
    }

    return dbg_log_;
})();

/** 
 * @param {number=} level
 */
function dbg_trace(level)
{
    if(!DEBUG) return;

    dbg_log(Error().stack, level);
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
};

