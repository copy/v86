"use strict";

/** @const */
var DAC_QUEUE_RESERVE = 0.2;
var DAC_MINIMUM_SAMPLING_RATE = 8000;

/**
 * @constructor
 * @param {!BusConnector} bus
 */
function SpeakerAdapter(bus)
{
    if(typeof window === "undefined")
    {
        return;
    }
    if(!window.AudioContext && !window.webkitAudioContext)
    {
        console.warn("Web browser doesn't support Web Audio API");
        return;
    }

    /** @const */
    this.bus = bus;

    /** @const */
    this.audio_context = new (window.AudioContext || window.webkitAudioContext)();

    /** @const */
    this.mixer = new SpeakerMixer(bus, this.audio_context);

    /** @const */
    this.pcspeaker = new PCSpeaker(bus, this.audio_context, this.mixer);

    /** @const */
    this.dac = new SpeakerDAC(bus, this.audio_context, this.mixer);

    bus.register("emulator-stopped", function()
    {
        this.audio_context.suspend();
    }, this);

    bus.register("emulator-started", function()
    {
        this.audio_context.resume();
    }, this);

}

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

    this.node_treble_left
        .connect(this.node_bass_left)
        .connect(this.node_gain_left)
        .connect(this.node_merger, 0, 0);
    this.node_treble_right
        .connect(this.node_bass_right)
        .connect(this.node_gain_right)
        .connect(this.node_merger, 0, 1);
    this.node_merger
        .connect(this.audio_context.destination);

    // Interface

    bus.register("mixer-connect", function(data)
    {
        var source_name = data[0];
        var channel = data[1];
        this.connect_source(source_name, channel);
    }, this);

    bus.register("mixer-disconnect", function(data)
    {
        var source_name = data[0];
        var channel = data[1];
        this.disconnect_source(source_name, channel);
    }, this);

    bus.register("mixer-volume", function(data)
    {
        var source_name = data[0];
        var channel = data[1];
        var decibels = data[2];

        var gain = Math.pow(10, decibels / 20);

        var source;
        if(source_name === "master")
        {
            source = this;
        }
        else
        {
            source = this.sources.get(source_name);
        }

        if(typeof source === "undefined")
        {
            console.warn("Mixer set volume - cannot set volume for undefined source: " + source_name);
            return;
        }

        source.set_volume(gain);
    }, this);

    bus.register("mixer-gain-left", function(decibels)
    {
        decibels = /** @type{number} */(decibels);
        this.gain_left = Math.pow(10, decibels / 20);
        this.update();
    }, this);

    bus.register("mixer-gain-right", function(decibels)
    {
        decibels = /** @type{number} */(decibels);
        this.gain_right = Math.pow(10, decibels / 20);
        this.update();
    }, this);

    function create_gain_handler(audio_node)
    {
        return function(decibels)
        {
            audio_node.gain.setValueAtTime(decibels, this.audio_context.currentTime);
        };
    };
    bus.register("mixer-treble-left", create_gain_handler(this.node_treble_left), this);
    bus.register("mixer-treble-right", create_gain_handler(this.node_treble_right), this);
    bus.register("mixer-bass-left", create_gain_handler(this.node_bass_left), this);
    bus.register("mixer-bass-right", create_gain_handler(this.node_bass_right), this);
}

/**
 * @param {!AudioNode} source_node
 * @param {string} source_name
 * @return {SpeakerMixerSource}
 */
SpeakerMixer.prototype.add_source = function(source_node, source_name)
{
    var source = new SpeakerMixerSource(
        this.audio_context,
        source_node,
        this.input_left,
        this.input_right
    );

    if(this.sources.has(source_name))
    {
        console.warn("Mixer add source - overwritting source: " + source_name);
    }

    this.sources.set(source_name, source);
    return source;
};

/**
 * @param {string} source_name
 * @param {string=} channel
 */
SpeakerMixer.prototype.connect_source = function(source_name, channel)
{
    var source = this.sources.get(source_name);

    if(typeof source === "undefined")
    {
        console.warn("Mixer connect - cannot connect undefined source: " + source_name);
        return;
    }

    source.connect(channel);
};

/**
 * @param {string} source_name
 * @param {string=} channel
 */
SpeakerMixer.prototype.disconnect_source = function(source_name, channel)
{
    var source = this.sources.get(source_name);

    if(typeof source === "undefined")
    {
        console.warn("Mixer disconnect - cannot disconnect undefined source: " + source_name);
        return;
    }

    source.disconnect(channel);
};

/**
 * @param {number} value
 * @param {string=} channel
 */
SpeakerMixer.prototype.set_volume = function(value, channel)
{
    if(!channel)
    {
        channel = "both";
    }

    switch(channel)
    {
        case "left":
            this.volume_left = value;
            break;
        case "right":
            this.volume_right = value;
            break;
        case "both":
            this.volume_both = value;
            break;
        default:
            console.warn("Mixer set master volume - unknown channel: " + channel);
            return;
    }

    this.update();
};

SpeakerMixer.prototype.update = function()
{
    var net_gain_left =
        this.volume_both *
        this.volume_left *
        this.gain_left;

    var net_gain_right =
        this.volume_both *
        this.volume_right *
        this.gain_right;

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

    source_node
        .connect(this.node_splitter);
    this.node_splitter
        .connect(this.node_gain_left, 0)
        .connect(destination_left);
    this.node_splitter
        .connect(this.node_gain_right, 1)
        .connect(destination_right);
}

SpeakerMixerSource.prototype.update = function()
{
    var net_gain_left =
        this.connected_left *
        this.gain_hidden *
        this.volume_both *
        this.volume_left;

    var net_gain_right =
        this.connected_right *
        this.gain_hidden *
        this.volume_both *
        this.volume_right;

    this.node_gain_left.gain.setValueAtTime(net_gain_left, this.audio_context.currentTime);
    this.node_gain_right.gain.setValueAtTime(net_gain_right, this.audio_context.currentTime);
};

/** @param {string=} channel */
SpeakerMixerSource.prototype.connect = function(channel)
{
    var both = !channel || channel === "both";
    if(both || channel === "left")
    {
        this.connected_left = true;
    }
    if(both || channel === "right")
    {
        this.connected_right = true;
    }
    this.update();
};

/** @param {string=} channel */
SpeakerMixerSource.prototype.disconnect = function(channel)
{
    var both = !channel || channel === "both";
    if(both || channel === "left")
    {
        this.connected_left = false;
    }
    if(both || channel === "right")
    {
        this.connected_right = false;
    }
    this.update();
};

/**
 * @param {number} value
 * @param {string=} channel
 */
SpeakerMixerSource.prototype.set_volume = function(value, channel)
{
    if(!channel)
    {
        channel = "both";
    }

    switch(channel)
    {
        case "left":
            this.volume_left = value;
            break;
        case "right":
            this.volume_right = value;
            break;
        case "both":
            this.volume_both = value;
            break;
        default:
            console.warn("Mixer set volume - unknown channel: " + channel);
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
 */
function PCSpeaker(bus, audio_context, mixer)
{
    // Nodes

    this.node_oscillator = audio_context.createOscillator();
    this.node_oscillator.type = "square";
    this.node_oscillator.frequency.setValueAtTime(440, audio_context.currentTime);

    // Interface

    this.mixer_connection = mixer.add_source(this.node_oscillator, "pcspeaker");
    this.mixer_connection.disconnect();

    bus.register("pcspeaker-enable", function()
    {
        mixer.connect_source("pcspeaker");
    }, this);

    bus.register("pcspeaker-disable", function()
    {
        mixer.disconnect_source("pcspeaker");
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

    // Start after configuration
    setTimeout(() => this.node_oscillator.start(), 0);
}

/**
 * @constructor
 * @param {!BusConnector} bus
 * @param {!AudioContext} audio_context
 */
function SpeakerDAC(bus, audio_context, mixer)
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
    this.free_buffers_of_length = new Map();

    // Nodes

    this.node_lowpass = this.audio_context.createBiquadFilter();
    this.node_lowpass.type = "lowpass";

    // Interface

    this.mixer_connection = mixer.add_source(this.node_lowpass, "dac");
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

        // Prevent growth if block size changes
        this.free_buffers_of_length.clear();
    }, this);
    bus.register("dac-tell-sampling-rate", function(rate)
    {
        rate = /** @type{number} */(rate);
        this.sampling_rate = rate;
        this.rate_ratio = Math.ceil(DAC_MINIMUM_SAMPLING_RATE / rate);
        this.buffer_sampling_rate = rate * this.rate_ratio;
        this.node_lowpass.frequency.setValueAtTime(rate / 2, this.audio_context.currentTime);

        // Previous buffers were only valid for a given sample rate
        this.free_buffers_of_length.clear();
    }, this);

    if(DEBUG)
    {
        this.debug = false;
        this.debug_queued_history = [];
        this.debug_output_history = [];
    }
}

SpeakerDAC.prototype.get_audio_buffer = function(sample_count)
{
    var buffers = this.free_buffers_of_length.get(sample_count);

    if(!buffers)
    {
        buffers = [];
        this.free_buffers_of_length.set(sample_count, buffers);
    }

    if(!buffers.length)
    {
        return this.audio_context.createBuffer(2, sample_count, this.buffer_sampling_rate);
    }
    else
    {
        return buffers.pop();
    }
};

SpeakerDAC.prototype.queue = function(data)
{
    if(DEBUG)
    {
        if(this.debug)
        {
            this.debug_queued[0].push(data[0].slice());
            this.debug_queued[1].push(data[1].slice());
        }
    }

    var sample_count = data[0].length;
    var block_duration = sample_count / this.sampling_rate;
    var buffer_sample_count = sample_count * this.rate_ratio;

    var buffer = this.get_audio_buffer(buffer_sample_count);
    if(this.rate_ratio > 1)
    {
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
        buffer.copyToChannel(data[0], 0);
        buffer.copyToChannel(data[1], 1);
    }

    var source = this.audio_context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.node_lowpass);
    source.addEventListener("ended", () =>
    {
        var buffers = this.free_buffers_of_length.get(buffer_sample_count);

        if(buffers)
        {
            buffers.push(buffer);
        }
        buffer = null;

        this.pump();
    });

    var current_time = this.audio_context.currentTime;

    if(this.buffered_time < current_time)
    {
        if(DEBUG)
        {
            console.log("Speaker DAC - Creating/Recreating reserve - shouldn't occur frequently during playback");
        }

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

SpeakerDAC.prototype.pump = function()
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

if(DEBUG)
{
    /** @suppress {deprecated} */
    SpeakerDAC.prototype.debug_start = function(durationMs)
    {
        this.debug = true;
        this.debug_queued = [[], []];
        this.debug_output = [[], []];
        this.debug_queued_history.push(this.debug_queued);
        this.debug_output_history.push(this.debug_output);

        this.debug_processor = this.audio_context.createScriptProcessor(1024, 2, 2);
        this.debug_processor.onaudioprocess = (event) =>
        {
            this.debug_output[0].push(event.inputBuffer.getChannelData(0).slice());
            this.debug_output[1].push(event.inputBuffer.getChannelData(1).slice());
        };

        this.debug_gain = this.audio_context.createGain();
        this.debug_gain.gain.setValueAtTime(0, this.audio_context.currentTime);

        this.node_lowpass
            .connect(this.debug_processor)
            .connect(this.debug_gain)
            .connect(this.audio_context.destination);

        setTimeout(() =>
        {
            this.debug_stop();
        }, durationMs);
    };

    SpeakerDAC.prototype.debug_stop = function()
    {
        this.debug = false;
        this.node_lowpass.disconnect(this.debug_processor);
        this.debug_processor.disconnect();
        this.debug_processor = null;
    };

    // Useful for Audacity imports
    SpeakerDAC.prototype.debug_download_txt = function(history_id, channel)
    {
        var txt = this.debug_output_history[history_id][channel]
            .map((v) => v.join(" "))
            .join(" ");

        this.debug_download(txt, "dacdata.txt", "text/plain");
    };

    // Useful for general plotting
    SpeakerDAC.prototype.debug_download_csv = function(history_id)
    {
        var buffers = this.debug_output_history[history_id];
        var csv_rows = [];
        for(var buffer_id = 0; buffer_id < buffers[0].length; buffer_id++)
        {
            for(var i = 0; i < buffers[0][buffer_id].length; i++)
            {
                csv_rows.push(`${buffers[0][buffer_id][i]},${buffers[1][buffer_id][i]}`);
            }
        }
        this.debug_download(csv_rows.join("\n"), "dacdata.csv", "text/csv");
    };

    SpeakerDAC.prototype.debug_download = function(str, filename, mime)
    {
        var blob = new Blob([str], { type: mime });
        var a = document.createElement("a");
        a["download"] = filename;
        a.href = window.URL.createObjectURL(blob);
        a.dataset["downloadurl"] = [mime, a["download"], a.href].join(":");
        a.click();
        window.URL.revokeObjectURL(a.href);
    };
}
