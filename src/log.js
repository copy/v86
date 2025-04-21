if(typeof DEBUG === "undefined")
{
    globalThis.DEBUG = true;
}

import { LOG_NAMES } from "./const.js";
import { pad0, pads } from "./lib.js";
import {
    LOG_ALL, LOG_PS2, LOG_PIT, LOG_9P, LOG_PIC, LOG_DMA, LOG_NET, LOG_FLOPPY, LOG_DISK,
    LOG_SERIAL, LOG_VGA, LOG_SB16, LOG_VIRTIO
} from "./const.js";

/** @const */
export var LOG_TO_FILE = false;

export var LOG_LEVEL = LOG_ALL & ~LOG_PS2 & ~LOG_PIT & ~LOG_VIRTIO & ~LOG_9P & ~LOG_PIC &
                          ~LOG_DMA & ~LOG_SERIAL & ~LOG_NET & ~LOG_FLOPPY & ~LOG_DISK & ~LOG_VGA & ~LOG_SB16;

export function set_log_level(level) {
    LOG_LEVEL = level;
}

export var log_data = [];

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
 */
export const dbg_log = (function()
{
    if(!DEBUG)
    {
        return function() {};
    }

    /** @type {Object.<number, string>} */
    const dbg_names = LOG_NAMES.reduce(function(a, x)
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
                message = "[" + pads(level_name, 4) + "] " + stuff;

            if(message === log_last_message)
            {
                log_message_repetitions++;

                if(log_message_repetitions < 2048)
                {
                    return;
                }
            }

            var now = new Date();
            var time_str = pad0(now.getHours(), 2) + ":" +
                           pad0(now.getMinutes(), 2) + ":" +
                           pad0(now.getSeconds(), 2) + "+" +
                           pad0(now.getMilliseconds(), 3) + " ";

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

/**
 * @param {number=} level
 */
export function dbg_trace(level)
{
    if(!DEBUG) return;

    dbg_log(Error().stack, level);
}

/**
 * console.assert is fucking slow
 * @param {string=} msg
 * @param {number=} level
 */
export function dbg_assert(cond, msg, level)
{
    if(!DEBUG) return;

    if(!cond)
    {
        dbg_assert_failed(msg);
    }
}


export function dbg_assert_failed(msg)
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
