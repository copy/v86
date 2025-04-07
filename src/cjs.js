"use strict";

/* global module, self */

var goog = goog || {};
goog.exportSymbol = function(name, sym) {
    if(typeof module !== "undefined" && typeof module.exports !== "undefined")
    {
        module.exports[name] = sym;
    }
    else if(typeof window !== "undefined")
    {
        window[name] = sym;
    }
    else if(typeof importScripts === "function")
    {
        // web worker
        self[name] = sym;
    }
};
goog.exportProperty = function() {};

/**
 * @define {boolean}
 * Overridden for production by closure compiler
 */
var DEBUG = true;
