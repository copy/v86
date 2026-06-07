import { dbg_assert } from "../log.js";

/** @constructor */
export var Connector = function(pair)
{
    this.listeners = {};
    this.pair = pair;

    pair.addEventListener("message", function(e)
    {
        var data = e.data;
        var listeners = this.listeners[data[0]];

        for(var i = 0; i < listeners.length; i++)
        {
            var listener = listeners[i];
            listener.fn.call(listener.this_value, data[1]);
        }
    }.bind(this), false);

};

Connector.prototype.register = function(name, fn, this_value)
{
    var listeners = this.listeners[name];

    if(listeners === undefined)
    {
        listeners = this.listeners[name] = [];
    }

    listeners.push({
        fn: fn,
        this_value: this_value,
    });
};

/**
 * Send ("emit") a message
 *
 * @param {string} name
 * @param {*=} value
 * @param {*=} transfer_list
 */
Connector.prototype.send = function(name, value, transfer_list)
{
    dbg_assert(arguments.length >= 1);

    if(!this.pair)
    {
        return;
    }

    this.pair.postMessage([name, value], transfer_list);
};


export var init = function(worker)
{
    return new Connector(worker);
};
