"use strict";

var Bus = {};

/** @constructor */
Bus.Connector = function()
{
    this.listeners = {};
    this.pair = undefined;
};

/**
 * @param {string} name
 * @param {function(*=)} fn
 * @param {Object} this_value
 */
Bus.Connector.prototype.register = function(name, fn, this_value)
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
 * @param {function()} fn
 */
Bus.Connector.prototype.unregister = function(name, fn)
{
    var listeners = this.listeners[name];

    if(listeners === undefined)
    {
        return;
    }

    this.listeners[name] = listeners.filter(function(l)
    {
        return l.fn !== fn
    });
};

/**
 * Send ("emit") a message
 *
 * @param {string} name
 * @param {*=} value
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
        listener.fn.call(listener.this_value, value);
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

/**
 * Return true if a message with the given name should be sent. That is, if
 * there are any listeners for this message
 *
 * @param {string} name
 * @return {boolean}
 */
Bus.Connector.prototype.should_send = function(name)
{
    if(!this.pair)
    {
        return false;
    }

    var listeners = this.pair.listeners[name];

    return listeners !== undefined && listeners.length > 0;
};

Bus.create = function()
{
    var c0 = new Bus.Connector();
    var c1 = new Bus.Connector();

    c0.pair = c1;
    c1.pair = c0;

    return [c0, c1];
};

