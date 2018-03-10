"use strict";

/** @const */
var DAC_QUEUE_RESERVE = 0.2;
var DAC_MINIMUM_SAMPLING_RATE = 8000;

/**
 * @constructor
 * @param {BusConnector} bus
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

    /** @const @type {BusConnector} */
    this.bus = bus;

    this.audio_context = new (window.AudioContext || window.webkitAudioContext)();

    // TODO: Find / calibrate / verify the filter frequencies

    this.beep_oscillator = this.audio_context.createOscillator();
    this.beep_oscillator.type = "square";
    this.beep_oscillator.frequency.setValueAtTime(440, this.audio_context.currentTime);
    this.beep_gain = this.audio_context.createGain();
    this.beep_gain.gain.setValueAtTime(0, this.audio_context.currentTime);

    this.dac_gain_left = this.audio_context.createGain();
    this.dac_gain_left.gain.setValueAtTime(1, this.audio_context.currentTime);
    this.dac_gain_right = this.audio_context.createGain();
    this.dac_gain_right.gain.setValueAtTime(1, this.audio_context.currentTime);
    this.dac_splitter = this.audio_context.createChannelSplitter(2);
    this.dac_lowpass = this.audio_context.createBiquadFilter();
    this.dac_lowpass.type = "lowpass";
    this.dac_enabled = false;
    this.dac_sampling_rate = 22050;
    this.dac_buffered_time = 0;
    this.dac_rate_ratio = 1;

    this.master_splitter = this.audio_context.createChannelSplitter(2);

    this.master_volume_left = this.audio_context.createGain();
    this.master_volume_right = this.audio_context.createGain();

    this.master_treble_left = this.audio_context.createBiquadFilter();
    this.master_treble_right = this.audio_context.createBiquadFilter();
    this.master_treble_left.type = "highshelf";
    this.master_treble_right.type = "highshelf";
    this.master_treble_left.frequency.setValueAtTime(2000, this.audio_context.currentTime);
    this.master_treble_right.frequency.setValueAtTime(2000, this.audio_context.currentTime);

    this.master_bass_left = this.audio_context.createBiquadFilter();
    this.master_bass_right = this.audio_context.createBiquadFilter();
    this.master_bass_left.type = "lowshelf";
    this.master_bass_right.type = "lowshelf";
    this.master_bass_left.frequency.setValueAtTime(200, this.audio_context.currentTime);
    this.master_bass_right.frequency.setValueAtTime(200, this.audio_context.currentTime);

    this.master_gain_left = this.audio_context.createGain();
    this.master_gain_right = this.audio_context.createGain();

    this.master_merger = this.audio_context.createChannelMerger(2);

    // Mixer Graph
    // Don't initially connect beep oscillator
    this.beep_gain
        .connect(this.master_splitter);
    this.dac_lowpass
        .connect(this.dac_splitter);
    this.dac_splitter
        .connect(this.dac_gain_left, 0)
        .connect(this.master_volume_left);
    this.dac_splitter
        .connect(this.dac_gain_right, 1)
        .connect(this.master_volume_right);
    this.master_splitter
        .connect(this.master_volume_left, 0)
    /* Treble and bass disabled: leads to lag and noise
        .connect(this.master_treble_left)
        .connect(this.master_bass_left)
        .connect(this.master_gain_left)
    */
        .connect(this.master_merger, 0, 0);
    this.master_splitter
        .connect(this.master_volume_right, 1)
    /* Treble and bass disabled: leads to lag and noise
        .connect(this.master_treble_right)
        .connect(this.master_bass_right)
        .connect(this.master_gain_right)
    */
        .connect(this.master_merger, 0, 1);
    this.master_merger
        .connect(this.audio_context.destination);

    // Mixer Switches
    bus.register("mixer-pcspeaker-connect", function()
    {
        this.beep_gain.connect(this.master_splitter);
    }, this);
    bus.register("mixer-pcspeaker-disconnect", function()
    {
        this.beep_gain.disconnect();
    }, this);
    bus.register("mixer-dac-connect", function()
    {
        this.dac_gain_left.connect(this.master_volume_right);
        this.dac_gain_right.connect(this.master_volume_right);
    }, this);
    bus.register("mixer-dac-disconnect", function()
    {
        this.dac_gain_left.disconnect();
        this.dac_gain_right.disconnect();
    }, this);

    // Mixer Levels
    function create_volume_handler(audio_node, scaling, in_decibels)
    {
        if(in_decibels)
        {
            return function(decibels)
            {
                audio_node.gain.setValueAtTime(decibels, this.audio_context.currentTime);
            };
        }
        else
        {
            return function(decibels)
            {
                var gain = Math.pow(10, decibels / 20) * scaling;
                audio_node.gain.setValueAtTime(gain, this.audio_context.currentTime);
            };
        }
    };

    bus.register("mixer-pcspeaker-volume",
        create_volume_handler(this.beep_gain, 1, false), this);

    bus.register("mixer-dac-volume-left",
        create_volume_handler(this.dac_gain_left, 3, false), this);

    bus.register("mixer-dac-volume-right",
        create_volume_handler(this.dac_gain_right, 1, false), this);

    bus.register("mixer-master-volume-left",
        create_volume_handler(this.master_volume_left, 1, false), this);

    bus.register("mixer-master-volume-right",
        create_volume_handler(this.master_volume_right, 1, false), this);

    bus.register("mixer-master-gain-left",
        create_volume_handler(this.master_gain_left, 1, false), this);

    bus.register("mixer-master-gain-right",
        create_volume_handler(this.master_gain_right, 1, false), this);

    bus.register("mixer-master-treble-left",
        create_volume_handler(this.master_treble_left, 1, true), this);

    bus.register("mixer-master-treble-right",
        create_volume_handler(this.master_treble_right, 1, true), this);

    bus.register("mixer-master-bass-left",
        create_volume_handler(this.master_bass_left, 1, true), this);

    bus.register("mixer-master-bass-right",
        create_volume_handler(this.master_bass_right, 1, true), this);

    // Emulator Events
    bus.register("emulator-stopped", function()
    {
        this.audio_context.suspend();
    }, this);
    bus.register("emulator-started", function()
    {
        this.audio_context.resume();
    }, this);

    // PC Speaker
    bus.register("pcspeaker-enable", function()
    {
        this.beep_oscillator.connect(this.beep_gain);
    }, this);
    bus.register("pcspeaker-disable", function()
    {
        this.beep_oscillator.disconnect();
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
            frequency = Math.min(frequency, this.beep_oscillator.frequency.maxValue);
            frequency = Math.max(frequency, 0);
        }

        this.beep_oscillator.frequency.setValueAtTime(frequency, this.audio_context.currentTime);
    }, this);

    // DAC
    bus.register("dac-send-data", function(data)
    {
        this.dac_queue(data);
    }, this);
    bus.register("dac-enable", function(enabled)
    {
        this.dac_enabled = true;
        this.dac_pump();
    }, this);
    bus.register("dac-disable", function()
    {
        this.dac_enabled = false;
    }, this);
    bus.register("dac-tell-sampling-rate", function(data)
    {
        this.dac_sampling_rate = data[0];
        this.dac_rate_ratio = Math.ceil(DAC_MINIMUM_SAMPLING_RATE / data[0]);
        this.dac_lowpass.frequency.setValueAtTime(data[0] / 2, this.audio_context.currentTime);
    }, this);

    // Start Nodes
    this.beep_oscillator.start();

    if(DEBUG)
    {
        this.debug_dac = false;
        this.debug_dac_queued_history = [];
        this.debug_dac_output_history = [];
    }
}

if(DEBUG)
{
    /** @suppress {deprecated} */
    SpeakerAdapter.prototype.debug_dac_start = function()
    {
        this.debug_dac = true;
        this.debug_dac_queued = [[], []];
        this.debug_dac_output = [[], []];
        this.debug_dac_queued_history.push(this.debug_dac_queued);
        this.debug_dac_output_history.push(this.debug_dac_output);

        this.debug_dac_processor = this.audio_context.createScriptProcessor(1024, 2, 2);
        this.debug_dac_processor.onaudioprocess = (event) =>
        {
            this.debug_dac_output[0].push(event.inputBuffer.getChannelData(0).slice());
            this.debug_dac_output[1].push(event.inputBuffer.getChannelData(1).slice());
        };

        this.debug_dac_gain = this.audio_context.createGain();
        this.debug_dac_gain.gain.value = 0;

        this.dac_lowpass
            .connect(this.debug_dac_processor)
            .connect(this.debug_dac_gain)
            .connect(this.audio_context.destination);

        setTimeout(() =>
        {
            this.debug_dac_stop();
        }, 1000);
    };

    SpeakerAdapter.prototype.debug_dac_stop = function()
    {
        this.debug_dac = false;
        this.dac_lowpass.disconnect(this.debug_dac_processor);
        this.debug_dac_processor.disconnect();
        this.debug_dac_processor = null;
    };

    // Useful for Audacity imports
    SpeakerAdapter.prototype.debug_dac_download_txt = function(history_id, channel)
    {
        var txt = this.debug_dac_output_history[history_id][channel]
            .map((v) => v.join(" "))
            .join(" ");

        this.debug_download(txt, "dacdata.txt", "text/plain");
    };

    // Useful for general plotting
    SpeakerAdapter.prototype.debug_dac_download_csv = function(history_id)
    {
        var buffers = this.debug_dac_output_history[history_id];
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

    SpeakerAdapter.prototype.debug_download = function(str, filename, mime)
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

SpeakerAdapter.prototype.dac_queue = function(data)
{
    if(DEBUG)
    {
        if(this.debug_dac)
        {
            this.debug_dac_queued[0].push(data[0].slice());
            this.debug_dac_queued[1].push(data[1].slice());
        }
    }

    var sample_count = data[0].length;
    var block_duration = sample_count / this.dac_sampling_rate;

    var buffer;
    if(this.dac_rate_ratio > 1)
    {
        var new_sample_count = sample_count * this.dac_rate_ratio;
        var new_sampling_rate = this.dac_sampling_rate * this.dac_rate_ratio;
        buffer = this.audio_context.createBuffer(2, new_sample_count, new_sampling_rate);
        var buffer_data0 = buffer.getChannelData(0);
        var buffer_data1 = buffer.getChannelData(1);
        for(var i = 0; i < sample_count; i++)
        {
            buffer_data0[i << 1] = buffer_data0[(i << 1) + 1] = data[0][i];
            buffer_data1[i << 1] = buffer_data1[(i << 1) + 1] = data[1][i];
        }
    }
    else
    {
        buffer = this.audio_context.createBuffer(2, sample_count, this.dac_sampling_rate);
        buffer.copyToChannel(data[0], 0);
        buffer.copyToChannel(data[1], 1);
    }

    var source = this.audio_context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.dac_lowpass);
    source.addEventListener("ended", this.dac_pump.bind(this));

    var current_time = this.audio_context.currentTime;

    if(this.dac_buffered_time < current_time)
    {
        if(DEBUG)
        {
            console.log("Speaker DAC - Creating/Recreating reserve - shouldn't occur frequently during playback");
        }

        // Schedule pump() to queue evenly, starting from current time
        this.dac_buffered_time = current_time;
        var target_silence_duration = DAC_QUEUE_RESERVE - block_duration;
        var current_silence_duration = 0;
        while(current_silence_duration <= target_silence_duration)
        {
            current_silence_duration += block_duration;
            this.dac_buffered_time += block_duration;
            setTimeout(() => this.dac_pump(), current_silence_duration * 1000);
        }
    }

    source.start(this.dac_buffered_time);
    this.dac_buffered_time += block_duration;

    // Chase the schedule - ensure reserve is full
    setTimeout(() => this.dac_pump(), 0);
};

SpeakerAdapter.prototype.dac_pump = function()
{
    if(!this.dac_enabled)
    {
        return;
    }
    if(this.dac_buffered_time - this.audio_context.currentTime > DAC_QUEUE_RESERVE)
    {
        return;
    }
    this.bus.send("dac-request-data");
};
