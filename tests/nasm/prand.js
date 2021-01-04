"use strict";
const assert = require("assert");

/**
 * Creates a pseudo-random value generator. The seed must be an integer.
 */
function Random(seed) {
    assert.equal(typeof seed, "number");
    this._seed = seed % 2147483647;
    if (this._seed <= 0) this._seed += 2147483646;
}

/**
 * Returns a 32-bit pseudo-random value.
 */
Random.prototype.next = function () {
    this._seed = (this._seed * 16807) & 0xffffffff;
    return (this._seed - 1) | 0;
};

module.exports = Random;
