import { dbg_assert } from "./log.js";

export var Bus = {};

/** @constructor */
export function BusConnector()
{
    this.listeners = {};
    this.pair = undefined;
}

/**
 * @param {string} name
 * @param {function(?)} fn
 * @param {Object} this_value
 */
BusConnector.prototype.register = function(name, fn, this_value)
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
 * Unregister one message with the given name and callback
 *
 * @param {string} name
 * @param {function(?)} fn
 */
BusConnector.prototype.unregister = function(name, fn)
{
    var listeners = this.listeners[name];

    if(listeners === undefined)
    {
        return;
    }

    this.listeners[name] = listeners.filter(function(l)
    {
        return l.fn !== fn;
    });
};

/**
 * Send ("emit") a message
 *
 * @param {string} name
 * @param {*=} value
 * @param {*=} unused_transfer
 */
BusConnector.prototype.send = function(name, value, unused_transfer)
{
    if(!this.pair)
    {
        return;
    }

    var listeners = this.pair.listeners[name];

    if(listeners === undefined)
    {
        return;
    }

    for(var i = 0; i < listeners.length; i++)
    {
        var listener = listeners[i];
        listener.fn.call(listener.this_value, value);
    }
};

/**
 * Send a message, guaranteeing that it is received asynchronously
 *
 * @param {string} name
 * @param {Object=} value
 */
BusConnector.prototype.send_async = function(name, value)
{
    dbg_assert(arguments.length === 1 || arguments.length === 2);

    setTimeout(this.send.bind(this, name, value), 0);
};

Bus.create = function()
{
    var c0 = new BusConnector();
    var c1 = new BusConnector();

    c0.pair = c1;
    c1.pair = c0;

    return [c0, c1];
};
