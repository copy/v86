"use strict";

var Bus = {};

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

Bus.Connector.prototype.send = function(name, value)
{
    dbg_assert(arguments.length === 2);

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


Bus.create = function()
{
    var c0 = new Bus.Connector();
    var c1 = new Bus.Connector();

    c0.pair = c1;
    c1.pair = c0;

    return [c0, c1];
};

