var performance = {};



var global = {};
var require = function(module) {};
var process = {};
var __dirname = "";

var esprima = { tokenize: {}, parse: {} };
var acorn = { walk: { simple: {} } };

var exports = {};
var define = {};
var module = {};

// New Web Audio API

/**
 * @constructor
 * @extends {AudioNode}
 * @param {Object=} options
 */
var AudioWorkletNode = function(context, name, options)
{
    this.port =
    {
        /**
         * @param {Object} data
         * @param {Object=} transfer
         */
        postMessage: function(data, transfer) {}
    };
};

/**
 * @constructor
 */
var AudioWorkletProcessor = function()
{
    this.port =
    {
        /**
         * @param {Object} data
         * @param {Object=} transfer
         */
        postMessage: function(data, transfer) {}
    };
}

var AudioWorklet = function() {};

AudioContext.prototype.audioWorklet =
{
    /** @return {Promise} */
    addModule: function(file) {}
};

/**
 * @param {string} name
 * @param {function()} processor
 */
var registerProcessor = function(name, processor) {}

/** @const */
var currentTime = 0;

/** @const */
var sampleRate = 0;
