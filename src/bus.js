"use strict";

var Bus = {};

if(typeof window === "object")
{
    window["Bus"] = Bus;
}

/** @constructor */
Bus.Connector = function()
{
    this.listeners = {};
    this.pair = undefined;
};

Bus.Connector.prototype.register = function(name, fn, thisValue)
{
    var listeners = this.listeners[name];

    if(listeners === undefined)
    {
        listeners = this.listeners[name] = [];
    }

    listeners.push({
        fn: fn,
        thisValue: thisValue,
    });
};

/**
 * Send ("emit") a message
 *
 * @param {string} name
 * @param {Object=} value
 */
Bus.Connector.prototype.send = function(name, value)
{
    dbg_assert(arguments.length === 1 || arguments.length === 2);

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
        listener.fn.call(listener.thisValue, value);
    }
};

/**
 * Send a message, guaranteeing that it is received asynchronously
 *
 * @param {string} name
 * @param {Object=} value
 */
Bus.Connector.prototype.send_async = function(name, value)
{
    dbg_assert(arguments.length === 1 || arguments.length === 2);

    setTimeout(this.send.bind(this, name, value), 0);
};


Bus.create = function()
{
    var c0 = new Bus.Connector();
    var c1 = new Bus.Connector();

    c0.pair = c1;
    c1.pair = c0;

    return [c0, c1];
};

