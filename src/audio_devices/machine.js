// A sound card plugin's view of the machine (audio_device "sb16", "hd_audio"): the
// device handle of src/device_machine.js plus the speaker, the dac-* messages
// of the bus (src/browser/speaker.js; src/cpu.js, create_audio_plugin).
// Built into each card's plugin file.

import { DeviceMachine, register_device_plugin } from "../device_machine.js";

/**
 * Make a card known to v86 (its plugin file calls this when it loads)
 * @param {!Object} descriptor { "name", "create": function(handle, options) }
 */
export function register_audio_device(descriptor)
{
    register_device_plugin("V86AudioDevices", descriptor);
}

/**
 * @constructor
 * @extends {DeviceMachine}
 * @param {!Object} handle
 */
export function AudioMachine(handle)
{
    DeviceMachine.call(this, handle);

    /** @const @type {!Object} */
    this.audio = handle["audio"];
}

AudioMachine.prototype = Object.create(DeviceMachine.prototype);

/**
 * Samples played: to the speaker (two channels in [-1, 1)), and as the
 * stream's own bytes to "hd-audio-pcm" listeners (tests)
 * @param {!Float32Array} left
 * @param {!Float32Array} right
 * @param {!Object} pcm { "stream", "format", "tag", "chunks" }
 */
AudioMachine.prototype.output = function(left, right, pcm)
{
    this.audio["send"](left, right);
    this.audio["pcm"](pcm);
};

/** @param {number} rate the samples' rate from now on */
AudioMachine.prototype.set_sampling_rate = function(rate)
{
    this.audio["set_sampling_rate"](rate);
};

/** A stream plays: the speaker takes samples */
AudioMachine.prototype.enable_output = function()
{
    this.audio["enable"]();
};

/** No stream plays */
AudioMachine.prototype.disable_output = function()
{
    this.audio["disable"]();
};

/**
 * A message to the speaker (src/browser/speaker.js: dac-*, mixer-*), for a
 * card that speaks its protocol itself (the SB16)
 * @param {string} name
 * @param {*=} data
 * @param {!Array=} transfer
 */
AudioMachine.prototype.bus_send = function(name, data, transfer)
{
    this.audio["bus_send"](name, data, transfer);
};

/**
 * The speaker's messages to the card (dac-request-data, speaker-has-initialized)
 * @param {string} name
 * @param {function(*)} handler
 */
AudioMachine.prototype.bus_register = function(name, handler)
{
    this.audio["bus_register"](name, handler);
};
