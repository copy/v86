import {
    MIXER_CHANNEL_BOTH, MIXER_CHANNEL_LEFT, MIXER_CHANNEL_RIGHT,
    MIXER_SRC_PCSPEAKER, MIXER_SRC_DAC, MIXER_SRC_MASTER,
} from "../const.js";
import { dbg_assert, dbg_log } from "../log.js";
import { OSCILLATOR_FREQ } from "../pit.js";
import { dump_file } from "../lib.js";

// For Types Only
import { BusConnector } from "../bus.js";

/* global registerProcessor, sampleRate */

const DAC_QUEUE_RESERVE = 0.2;

const AUDIOBUFFER_MINIMUM_SAMPLING_RATE = 8000;

/**
 * @constructor
 * @param {!BusConnector} bus
 */
export function SpeakerAdapter(bus)
{
    if(typeof window === "undefined")
    {
        return;
    }
    if(!window.AudioContext && !window["webkitAudioContext"])
    {
        console.warn("Web browser doesn't support Web Audio API");
        return;
    }

    var SpeakerDAC = window.AudioWorklet ? SpeakerWorkletDAC : SpeakerBufferSourceDAC;

    /** @const */
    this.bus = bus;

    this.audio_context = window.AudioContext ? new AudioContext() : new webkitAudioContext();

    /** @const */
    this.mixer = new SpeakerMixer(bus, this.audio_context);

    /** @const */
    this.pcspeaker = new PCSpeaker(bus, this.audio_context, this.mixer);

    this.dac = new SpeakerDAC(bus, this.audio_context, this.mixer);

    this.pcspeaker.start();

    bus.register("emulator-stopped", function()
    {
        this.audio_context.suspend();
    }, this);

    bus.register("emulator-started", function()
    {
        this.audio_context.resume();
    }, this);

    bus.register("speaker-confirm-initialized", function()
    {
        bus.send("speaker-has-initialized");
    }, this);
    bus.send("speaker-has-initialized");
}

SpeakerAdapter.prototype.destroy = function()
{
    this.audio_context && this.audio_context.close();
    this.audio_context = null;
    this.dac && this.dac.node_processor && this.dac.node_processor.port.close();
    this.dac = null;
};

/**
 * @constructor
 * @param {!BusConnector} bus
 * @param {!AudioContext} audio_context
 */
function SpeakerMixer(bus, audio_context)
{
    /** @const */
    this.audio_context = audio_context;

    this.sources = new Map();

    // States

    this.volume_both = 1;
    this.volume_left = 1;
    this.volume_right = 1;
    this.gain_left = 1;
    this.gain_right = 1;

    // Nodes
    // TODO: Find / calibrate / verify the filter frequencies

    this.node_treble_left = this.audio_context.createBiquadFilter();
    this.node_treble_right = this.audio_context.createBiquadFilter();
    this.node_treble_left.type = "highshelf";
    this.node_treble_right.type = "highshelf";
    this.node_treble_left.frequency.setValueAtTime(2000, this.audio_context.currentTime);
    this.node_treble_right.frequency.setValueAtTime(2000, this.audio_context.currentTime);

    this.node_bass_left = this.audio_context.createBiquadFilter();
    this.node_bass_right = this.audio_context.createBiquadFilter();
    this.node_bass_left.type = "lowshelf";
    this.node_bass_right.type = "lowshelf";
    this.node_bass_left.frequency.setValueAtTime(200, this.audio_context.currentTime);
    this.node_bass_right.frequency.setValueAtTime(200, this.audio_context.currentTime);

    this.node_gain_left = this.audio_context.createGain();
    this.node_gain_right = this.audio_context.createGain();

    this.node_merger = this.audio_context.createChannelMerger(2);

    // Graph

    this.input_left = this.node_treble_left;
    this.input_right = this.node_treble_right;

    this.node_treble_left.connect(this.node_bass_left);
    this.node_bass_left.connect(this.node_gain_left);
    this.node_gain_left.connect(this.node_merger, 0, 0);

    this.node_treble_right.connect(this.node_bass_right);
    this.node_bass_right.connect(this.node_gain_right);
    this.node_gain_right.connect(this.node_merger, 0, 1);

    this.node_merger.connect(this.audio_context.destination);

    // Interface

    bus.register("mixer-connect", function(data)
    {
        var source_id = data[0];
        var channel = data[1];
        this.connect_source(source_id, channel);
    }, this);

    bus.register("mixer-disconnect", function(data)
    {
        var source_id = data[0];
        var channel = data[1];
        this.disconnect_source(source_id, channel);
    }, this);

    bus.register("mixer-volume", function(data)
    {
        var source_id = data[0];
        var channel = data[1];
        var decibels = data[2];

        var gain = Math.pow(10, decibels / 20);

        var source = source_id === MIXER_SRC_MASTER ? this : this.sources.get(source_id);

        if(source === undefined)
        {
            dbg_assert(false, "Mixer set volume - cannot set volume for undefined source: " + source_id);
            return;
        }

        source.set_volume(gain, channel);
    }, this);

    bus.register("mixer-gain-left", function(/** number */ decibels)
    {
        this.gain_left = Math.pow(10, decibels / 20);
        this.update();
    }, this);

    bus.register("mixer-gain-right", function(/** number */ decibels)
    {
        this.gain_right = Math.pow(10, decibels / 20);
        this.update();
    }, this);

    function create_gain_handler(audio_node)
    {
        return function(decibels)
        {
            audio_node.gain.setValueAtTime(decibels, this.audio_context.currentTime);
        };
    }
    bus.register("mixer-treble-left", create_gain_handler(this.node_treble_left), this);
    bus.register("mixer-treble-right", create_gain_handler(this.node_treble_right), this);
    bus.register("mixer-bass-left", create_gain_handler(this.node_bass_left), this);
    bus.register("mixer-bass-right", create_gain_handler(this.node_bass_right), this);
}

/**
 * @param {!AudioNode} source_node
 * @param {number} source_id
 * @return {SpeakerMixerSource}
 */
SpeakerMixer.prototype.add_source = function(source_node, source_id)
{
    var source = new SpeakerMixerSource(
        this.audio_context,
        source_node,
        this.input_left,
        this.input_right
    );

    dbg_assert(!this.sources.has(source_id), "Mixer add source - overwritting source: " + source_id);

    this.sources.set(source_id, source);
    return source;
};

/**
 * @param {number} source_id
 * @param {number=} channel
 */
SpeakerMixer.prototype.connect_source = function(source_id, channel)
{
    var source = this.sources.get(source_id);

    if(source === undefined)
    {
        dbg_assert(false, "Mixer connect - cannot connect undefined source: " + source_id);
        return;
    }

    source.connect(channel);
};

/**
 * @param {number} source_id
 * @param {number=} channel
 */
SpeakerMixer.prototype.disconnect_source = function(source_id, channel)
{
    var source = this.sources.get(source_id);

    if(source === undefined)
    {
        dbg_assert(false, "Mixer disconnect - cannot disconnect undefined source: " + source_id);
        return;
    }

    source.disconnect(channel);
};

/**
 * @param {number} value
 * @param {number=} channel
 */
SpeakerMixer.prototype.set_volume = function(value, channel)
{
    if(channel === undefined)
    {
        channel = MIXER_CHANNEL_BOTH;
    }

    switch(channel)
    {
        case MIXER_CHANNEL_LEFT:
            this.volume_left = value;
            break;
        case MIXER_CHANNEL_RIGHT:
            this.volume_right = value;
            break;
        case MIXER_CHANNEL_BOTH:
            this.volume_both = value;
            break;
        default:
            dbg_assert(false, "Mixer set master volume - unknown channel: " + channel);
            return;
    }

    this.update();
};

SpeakerMixer.prototype.update = function()
{
    var net_gain_left = this.volume_both * this.volume_left * this.gain_left;
    var net_gain_right = this.volume_both * this.volume_right * this.gain_right;

    this.node_gain_left.gain.setValueAtTime(net_gain_left, this.audio_context.currentTime);
    this.node_gain_right.gain.setValueAtTime(net_gain_right, this.audio_context.currentTime);
};

/**
 * @constructor
 * @param {!AudioContext} audio_context
 * @param {!AudioNode} source_node
 * @param {!AudioNode} destination_left
 * @param {!AudioNode} destination_right
 */
function SpeakerMixerSource(audio_context, source_node, destination_left, destination_right)
{
    /** @const */
    this.audio_context = audio_context;

    // States

    this.connected_left = true;
    this.connected_right = true;
    this.gain_hidden = 1;
    this.volume_both = 1;
    this.volume_left = 1;
    this.volume_right = 1;

    // Nodes

    this.node_splitter = audio_context.createChannelSplitter(2);
    this.node_gain_left = audio_context.createGain();
    this.node_gain_right = audio_context.createGain();

    // Graph

    source_node.connect(this.node_splitter);

    this.node_splitter.connect(this.node_gain_left, 0);
    this.node_gain_left.connect(destination_left);

    this.node_splitter.connect(this.node_gain_right, 1);
    this.node_gain_right.connect(destination_right);
}

SpeakerMixerSource.prototype.update = function()
{
    var net_gain_left = this.connected_left * this.gain_hidden * this.volume_both * this.volume_left;
    var net_gain_right = this.connected_right * this.gain_hidden * this.volume_both * this.volume_right;

    this.node_gain_left.gain.setValueAtTime(net_gain_left, this.audio_context.currentTime);
    this.node_gain_right.gain.setValueAtTime(net_gain_right, this.audio_context.currentTime);
};

/** @param {number=} channel */
SpeakerMixerSource.prototype.connect = function(channel)
{
    var both = !channel || channel === MIXER_CHANNEL_BOTH;
    if(both || channel === MIXER_CHANNEL_LEFT)
    {
        this.connected_left = true;
    }
    if(both || channel === MIXER_CHANNEL_RIGHT)
    {
        this.connected_right = true;
    }
    this.update();
};

/** @param {number=} channel */
SpeakerMixerSource.prototype.disconnect = function(channel)
{
    var both = !channel || channel === MIXER_CHANNEL_BOTH;
    if(both || channel === MIXER_CHANNEL_LEFT)
    {
        this.connected_left = false;
    }
    if(both || channel === MIXER_CHANNEL_RIGHT)
    {
        this.connected_right = false;
    }
    this.update();
};

/**
 * @param {number} value
 * @param {number=} channel
 */
SpeakerMixerSource.prototype.set_volume = function(value, channel)
{
    if(channel === undefined)
    {
        channel = MIXER_CHANNEL_BOTH;
    }

    switch(channel)
    {
        case MIXER_CHANNEL_LEFT:
            this.volume_left = value;
            break;
        case MIXER_CHANNEL_RIGHT:
            this.volume_right = value;
            break;
        case MIXER_CHANNEL_BOTH:
            this.volume_both = value;
            break;
        default:
            dbg_assert(false, "Mixer set volume - unknown channel: " + channel);
            return;
    }

    this.update();
};

SpeakerMixerSource.prototype.set_gain_hidden = function(value)
{
    this.gain_hidden = value;
};

/**
 * @constructor
 * @param {!BusConnector} bus
 * @param {!AudioContext} audio_context
 * @param {!SpeakerMixer} mixer
 */
function PCSpeaker(bus, audio_context, mixer)
{
    // Nodes

    this.node_oscillator = audio_context.createOscillator();
    this.node_oscillator.type = "square";
    this.node_oscillator.frequency.setValueAtTime(440, audio_context.currentTime);

    // Interface

    this.mixer_connection = mixer.add_source(this.node_oscillator, MIXER_SRC_PCSPEAKER);
    this.mixer_connection.disconnect();

    bus.register("pcspeaker-enable", function()
    {
        mixer.connect_source(MIXER_SRC_PCSPEAKER);
    }, this);

    bus.register("pcspeaker-disable", function()
    {
        mixer.disconnect_source(MIXER_SRC_PCSPEAKER);
    }, this);

    bus.register("pcspeaker-update", function(data)
    {
        var counter_mode = data[0];
        var counter_reload = data[1];

        var frequency = 0;
        var beep_enabled = counter_mode === 3;

        if(beep_enabled)
        {
            frequency = OSCILLATOR_FREQ * 1000 / counter_reload;
            frequency = Math.min(frequency, this.node_oscillator.frequency.maxValue);
            frequency = Math.max(frequency, 0);
        }

        this.node_oscillator.frequency.setValueAtTime(frequency, audio_context.currentTime);
    }, this);
}

PCSpeaker.prototype.start = function()
{
    this.node_oscillator.start();
};

/**
 * @constructor
 * @param {!BusConnector} bus
 * @param {!AudioContext} audio_context
 * @param {!SpeakerMixer} mixer
 */
function SpeakerWorkletDAC(bus, audio_context, mixer)
{
    /** @const */
    this.bus = bus;

    /** @const */
    this.audio_context = audio_context;

    // State

    this.enabled = false;
    this.sampling_rate = 48000;

    // Worklet

    function worklet()
    {
        const RENDER_QUANTUM = 128;
        const MINIMUM_BUFFER_SIZE = 2 * RENDER_QUANTUM;
        const QUEUE_RESERVE = 1024;

        function sinc(x)
        {
            if(x === 0) return 1;
            x *= Math.PI;
            return Math.sin(x) / x;
        }

        var EMPTY_BUFFER =
        [
            new Float32Array(MINIMUM_BUFFER_SIZE),
            new Float32Array(MINIMUM_BUFFER_SIZE),
        ];

        /**
         * @constructor
         * @extends AudioWorkletProcessor
         */
        function DACProcessor()
        {
            var self = Reflect.construct(AudioWorkletProcessor, [], DACProcessor);

            // Params

            self.kernel_size = 3;

            // States

            // Buffers waiting for their turn to be consumed
            self.queue_data = new Array(1024);
            self.queue_start = 0;
            self.queue_end = 0;
            self.queue_length = 0;
            self.queue_size = self.queue_data.length;
            self.queued_samples = 0;

            // Buffers being actively consumed
            /** @type{Array<Float32Array>} */
            self.source_buffer_previous = EMPTY_BUFFER;
            /** @type{Array<Float32Array>} */
            self.source_buffer_current = EMPTY_BUFFER;

            // Ratio of alienland sample rate to homeland sample rate.
            self.source_samples_per_destination = 1.0;

            // Integer representing the position of the first destination sample
            // for the current block, relative to source_buffer_current.
            self.source_block_start = 0;

            // Real number representing the position of the current destination
            // sample relative to source_buffer_current, since source_block_start.
            self.source_time = 0.0;

            // Same as source_time but rounded down to an index.
            self.source_offset = 0;

            // Interface

            self.port.onmessage = (event) =>
            {
                switch(event.data.type)
                {
                    case "queue":
                        self.queue_push(event.data.value);
                        break;
                    case "sampling-rate":
                        self.source_samples_per_destination = event.data.value / sampleRate;
                        break;
                }
            };

            return self;
        }

        Reflect.setPrototypeOf(DACProcessor.prototype, AudioWorkletProcessor.prototype);
        Reflect.setPrototypeOf(DACProcessor, AudioWorkletProcessor);

        DACProcessor.prototype["process"] =
        DACProcessor.prototype.process = function(inputs, outputs, parameters)
        {
            for(var i = 0; i < outputs[0][0].length; i++)
            {
                // Lanczos resampling
                var sum0 = 0;
                var sum1 = 0;

                var start = this.source_offset - this.kernel_size + 1;
                var end = this.source_offset + this.kernel_size;

                for(var j = start; j <= end; j++)
                {
                    var convolute_index = this.source_block_start + j;
                    sum0 += this.get_sample(convolute_index, 0) * this.kernel(this.source_time - j);
                    sum1 += this.get_sample(convolute_index, 1) * this.kernel(this.source_time - j);
                }

                if(isNaN(sum0) || isNaN(sum1))
                {
                    // NaN values cause entire audio graph to cease functioning.
                    sum0 = sum1 = 0;
                    this.dbg_log("ERROR: NaN values! Ignoring for now.");
                }

                outputs[0][0][i] = sum0;
                outputs[0][1][i] = sum1;

                this.source_time += this.source_samples_per_destination;
                this.source_offset = Math.floor(this.source_time);
            }

            // +2 to safeguard against rounding variations
            var samples_needed_per_block = this.source_offset;
            samples_needed_per_block += this.kernel_size + 2;

            this.source_time -= this.source_offset;
            this.source_block_start += this.source_offset;
            this.source_offset = 0;

            // Note: This needs to be done after source_block_start is updated.
            this.ensure_enough_data(samples_needed_per_block);

            return true;
        };

        DACProcessor.prototype.kernel = function(x)
        {
            return sinc(x) * sinc(x / this.kernel_size);
        };

        DACProcessor.prototype.get_sample = function(index, channel)
        {
            if(index < 0)
            {
                // -ve index represents previous buffer
                //          <-------|
                // [Previous buffer][Current buffer]
                index += this.source_buffer_previous[0].length;
                return this.source_buffer_previous[channel][index];
            }
            else
            {
                return this.source_buffer_current[channel][index];
            }
        };

        DACProcessor.prototype.ensure_enough_data = function(needed)
        {
            var current_length = this.source_buffer_current[0].length;
            var remaining = current_length - this.source_block_start;

            if(remaining < needed)
            {
                this.prepare_next_buffer();
                this.source_block_start -= current_length;
            }
        };

        DACProcessor.prototype.prepare_next_buffer = function()
        {
            if(this.queued_samples < MINIMUM_BUFFER_SIZE && this.queue_length)
            {
                this.dbg_log("Not enough samples - should not happen during midway of playback");
            }

            this.source_buffer_previous = this.source_buffer_current;
            this.source_buffer_current = this.queue_shift();

            var sample_count = this.source_buffer_current[0].length;

            if(sample_count < MINIMUM_BUFFER_SIZE)
            {
                // Unfortunately, this single buffer is too small :(

                var queue_pos = this.queue_start;
                var buffer_count = 0;

                // Figure out how many small buffers to combine.
                while(sample_count < MINIMUM_BUFFER_SIZE && buffer_count < this.queue_length)
                {
                    sample_count += this.queue_data[queue_pos][0].length;

                    queue_pos = queue_pos + 1 & this.queue_size - 1;
                    buffer_count++;
                }

                // Note: if not enough buffers, this will be end-padded with zeros:
                var new_big_buffer_size = Math.max(sample_count, MINIMUM_BUFFER_SIZE);
                var new_big_buffer =
                [
                    new Float32Array(new_big_buffer_size),
                    new Float32Array(new_big_buffer_size),
                ];

                // Copy the first, already-shifted, small buffer into the new buffer.
                new_big_buffer[0].set(this.source_buffer_current[0]);
                new_big_buffer[1].set(this.source_buffer_current[1]);
                var new_big_buffer_pos = this.source_buffer_current[0].length;

                // Copy the rest.
                for(var i = 0; i < buffer_count; i++)
                {
                    var small_buffer = this.queue_shift();
                    new_big_buffer[0].set(small_buffer[0], new_big_buffer_pos);
                    new_big_buffer[1].set(small_buffer[1], new_big_buffer_pos);
                    new_big_buffer_pos += small_buffer[0].length;
                }

                // Pretend that everything's just fine.
                this.source_buffer_current = new_big_buffer;
            }

            this.pump();
        };

        DACProcessor.prototype.pump = function()
        {
            if(this.queued_samples / this.source_samples_per_destination < QUEUE_RESERVE)
            {
                this.port.postMessage(
                {
                    type: "pump",
                });
            }
        };

        DACProcessor.prototype.queue_push = function(item)
        {
            if(this.queue_length < this.queue_size)
            {
                this.queue_data[this.queue_end] = item;
                this.queue_end = this.queue_end + 1 & this.queue_size - 1;
                this.queue_length++;

                this.queued_samples += item[0].length;

                this.pump();
            }
        };

        DACProcessor.prototype.queue_shift = function()
        {
            if(!this.queue_length)
            {
                return EMPTY_BUFFER;
            }

            var item = this.queue_data[this.queue_start];

            this.queue_data[this.queue_start] = null;
            this.queue_start = this.queue_start + 1 & this.queue_size - 1;
            this.queue_length--;

            this.queued_samples -= item[0].length;

            return item;
        };

        DACProcessor.prototype.dbg_log = function(message)
        {
            if(DEBUG)
            {
                this.port.postMessage(
                {
                    type: "debug-log",
                    value: message,
                });
            }
        };

        registerProcessor("dac-processor", DACProcessor);
    }

    var worklet_string = worklet.toString();

    var worklet_code_start = worklet_string.indexOf("{") + 1;
    var worklet_code_end = worklet_string.lastIndexOf("}");
    var worklet_code = worklet_string.substring(worklet_code_start, worklet_code_end);

    if(DEBUG)
    {
        worklet_code = "var DEBUG = true;\n" + worklet_code;
    }

    var worklet_blob = new Blob([worklet_code], { type: "application/javascript" });
    var worklet_url = URL.createObjectURL(worklet_blob);

    /** @type {AudioWorkletNode} */
    this.node_processor = null;

    // Placeholder pass-through node to connect to, when worklet node is not ready yet.
    this.node_output = this.audio_context.createGain();

    this.audio_context
        .audioWorklet
        .addModule(worklet_url)
        .then(() =>
    {
        URL.revokeObjectURL(worklet_url);

        this.node_processor = new AudioWorkletNode(this.audio_context, "dac-processor",
        {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            parameterData: {},
            processorOptions: {},
        });

        this.node_processor.port.postMessage(
        {
            type: "sampling-rate",
            value: this.sampling_rate,
        });

        this.node_processor.port.onmessage = (event) =>
        {
            switch(event.data.type)
            {
                case "pump":
                    this.pump();
                    break;
                case "debug-log":
                    dbg_log("SpeakerWorkletDAC - Worklet: " + event.data.value);
                    break;
            }
        };

        // Graph

        this.node_processor.connect(this.node_output);
    });

    // Interface

    this.mixer_connection = mixer.add_source(this.node_output, MIXER_SRC_DAC);
    this.mixer_connection.set_gain_hidden(3);

    bus.register("dac-send-data", function(data)
    {
        this.queue(data);
    }, this);

    bus.register("dac-enable", function(enabled)
    {
        this.enabled = true;
    }, this);

    bus.register("dac-disable", function()
    {
        this.enabled = false;
    }, this);

    bus.register("dac-tell-sampling-rate", function(/** number */ rate)
    {
        dbg_assert(rate > 0, "Sampling rate should be nonzero");
        this.sampling_rate = rate;

        if(!this.node_processor)
        {
            return;
        }

        this.node_processor.port.postMessage(
        {
            type: "sampling-rate",
            value: rate,
        });
    }, this);

    if(DEBUG)
    {
        this.debugger = new SpeakerDACDebugger(this.audio_context, this.node_output);
    }
}

SpeakerWorkletDAC.prototype.queue = function(data)
{
    if(!this.node_processor)
    {
        return;
    }

    if(DEBUG)
    {
        this.debugger.push_queued_data(data);
    }

    this.node_processor.port.postMessage(
    {
        type: "queue",
        value: data,
    }, [data[0].buffer, data[1].buffer]);
};

SpeakerWorkletDAC.prototype.pump = function()
{
    if(!this.enabled)
    {
        return;
    }
    this.bus.send("dac-request-data");
};

/**
 * @constructor
 * @param {!BusConnector} bus
 * @param {!AudioContext} audio_context
 * @param {!SpeakerMixer} mixer
 */
function SpeakerBufferSourceDAC(bus, audio_context, mixer)
{
    /** @const */
    this.bus = bus;

    /** @const */
    this.audio_context = audio_context;

    // States

    this.enabled = false;
    this.sampling_rate = 22050;
    this.buffered_time = 0;
    this.rate_ratio = 1;

    // Nodes

    this.node_lowpass = this.audio_context.createBiquadFilter();
    this.node_lowpass.type = "lowpass";

    // Interface

    this.node_output = this.node_lowpass;

    this.mixer_connection = mixer.add_source(this.node_output, MIXER_SRC_DAC);
    this.mixer_connection.set_gain_hidden(3);

    bus.register("dac-send-data", function(data)
    {
        this.queue(data);
    }, this);

    bus.register("dac-enable", function(enabled)
    {
        this.enabled = true;
        this.pump();
    }, this);

    bus.register("dac-disable", function()
    {
        this.enabled = false;
    }, this);

    bus.register("dac-tell-sampling-rate", function(/** number */ rate)
    {
        dbg_assert(rate > 0, "Sampling rate should be nonzero");
        this.sampling_rate = rate;
        this.rate_ratio = Math.ceil(AUDIOBUFFER_MINIMUM_SAMPLING_RATE / rate);
        this.node_lowpass.frequency.setValueAtTime(rate / 2, this.audio_context.currentTime);
    }, this);

    if(DEBUG)
    {
        this.debugger = new SpeakerDACDebugger(this.audio_context, this.node_output);
    }
}

SpeakerBufferSourceDAC.prototype.queue = function(data)
{
    if(DEBUG)
    {
        this.debugger.push_queued_data(data);
    }

    var sample_count = data[0].length;
    var block_duration = sample_count / this.sampling_rate;

    var buffer;
    if(this.rate_ratio > 1)
    {
        var new_sample_count = sample_count * this.rate_ratio;
        var new_sampling_rate = this.sampling_rate * this.rate_ratio;
        buffer = this.audio_context.createBuffer(2, new_sample_count, new_sampling_rate);
        var buffer_data0 = buffer.getChannelData(0);
        var buffer_data1 = buffer.getChannelData(1);

        var buffer_index = 0;
        for(var i = 0; i < sample_count; i++)
        {
            for(var j = 0; j < this.rate_ratio; j++, buffer_index++)
            {
                buffer_data0[buffer_index] = data[0][i];
                buffer_data1[buffer_index] = data[1][i];
            }
        }
    }
    else
    {
        // Allocating new AudioBuffer every block
        // - Memory profiles show insignificant improvements if recycling old buffers.
        buffer = this.audio_context.createBuffer(2, sample_count, this.sampling_rate);
        if(buffer.copyToChannel)
        {
            buffer.copyToChannel(data[0], 0);
            buffer.copyToChannel(data[1], 1);
        }
        else
        {
            // Safari doesn't support copyToChannel yet. See #286
            buffer.getChannelData(0).set(data[0]);
            buffer.getChannelData(1).set(data[1]);
        }
    }

    var source = this.audio_context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.node_lowpass);
    source.addEventListener("ended", this.pump.bind(this));

    var current_time = this.audio_context.currentTime;

    if(this.buffered_time < current_time)
    {
        dbg_log("Speaker DAC - Creating/Recreating reserve - shouldn't occur frequently during playback");

        // Schedule pump() to queue evenly, starting from current time
        this.buffered_time = current_time;
        var target_silence_duration = DAC_QUEUE_RESERVE - block_duration;
        var current_silence_duration = 0;
        while(current_silence_duration <= target_silence_duration)
        {
            current_silence_duration += block_duration;
            this.buffered_time += block_duration;
            setTimeout(() => this.pump(), current_silence_duration * 1000);
        }
    }

    source.start(this.buffered_time);
    this.buffered_time += block_duration;

    // Chase the schedule - ensure reserve is full
    setTimeout(() => this.pump(), 0);
};

SpeakerBufferSourceDAC.prototype.pump = function()
{
    if(!this.enabled)
    {
        return;
    }
    if(this.buffered_time - this.audio_context.currentTime > DAC_QUEUE_RESERVE)
    {
        return;
    }
    this.bus.send("dac-request-data");
};

/**
 * @constructor
 */
function SpeakerDACDebugger(audio_context, source_node)
{
    /** @const */
    this.audio_context = audio_context;

    /** @const */
    this.node_source = source_node;

    this.node_processor = null;

    this.node_gain = this.audio_context.createGain();
    this.node_gain.gain.setValueAtTime(0, this.audio_context.currentTime);

    this.node_gain.connect(this.audio_context.destination);

    this.is_active = false;
    this.queued_history = [];
    this.output_history = [];
    this.queued = [[], []];
    this.output = [[], []];
}

/** @suppress {deprecated} */
SpeakerDACDebugger.prototype.start = function(duration_ms)
{
    this.is_active = true;
    this.queued = [[], []];
    this.output = [[], []];
    this.queued_history.push(this.queued);
    this.output_history.push(this.output);

    this.node_processor = this.audio_context.createScriptProcessor(1024, 2, 2);
    this.node_processor.onaudioprocess = (event) =>
    {
        this.output[0].push(event.inputBuffer.getChannelData(0).slice());
        this.output[1].push(event.inputBuffer.getChannelData(1).slice());
    };

    this.node_source.connect(this.node_processor);
    this.node_processor.connect(this.node_gain);

    setTimeout(() =>
    {
        this.stop();
    }, duration_ms);
};

SpeakerDACDebugger.prototype.stop = function()
{
    this.is_active = false;
    this.node_source.disconnect(this.node_processor);
    this.node_processor.disconnect();
    this.node_processor = null;
};

SpeakerDACDebugger.prototype.push_queued_data = function(data)
{
    if(this.is_active)
    {
        this.queued[0].push(data[0].slice());
        this.queued[1].push(data[1].slice());
    }
};

// Useful for Audacity imports
SpeakerDACDebugger.prototype.download_txt = function(history_id, channel)
{
    var txt = this.output_history[history_id][channel]
        .map((v) => v.join(" "))
        .join(" ");

    dump_file(txt, "dacdata.txt");
};

// Useful for general plotting
SpeakerDACDebugger.prototype.download_csv = function(history_id)
{
    var buffers = this.output_history[history_id];
    var csv_rows = [];
    for(var buffer_id = 0; buffer_id < buffers[0].length; buffer_id++)
    {
        for(var i = 0; i < buffers[0][buffer_id].length; i++)
        {
            csv_rows.push(`${buffers[0][buffer_id][i]},${buffers[1][buffer_id][i]}`);
        }
    }
    dump_file(csv_rows.join("\n"), "dacdata.csv");
};
