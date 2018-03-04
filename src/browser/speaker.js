"use strict";

/**
 * Note: Uses AudioContext.createScriptProcessor, which is deprecated,
 * but which no satisfactory substitute is availble.
 * @constructor
 * @param {BusConnector} bus
 * @suppress {deprecated}
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

    this.dac_processor = this.audio_context.createScriptProcessor(2048, 0, 2);
    this.dac_processor.onaudioprocess = this.dac_process.bind(this);
    this.dac_gain_left = this.audio_context.createGain();
    this.dac_gain_left.gain.setValueAtTime(1, this.audio_context.currentTime);
    this.dac_gain_right = this.audio_context.createGain();
    this.dac_gain_right.gain.setValueAtTime(1, this.audio_context.currentTime);
    this.dac_splitter = this.audio_context.createChannelSplitter(2);
    this.dac_buffer0 = new Float32Array(this.dac_processor.bufferSize);
    this.dac_buffer1 = new Float32Array(this.dac_processor.bufferSize);

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
    this.dac_processor
        .connect(this.dac_splitter);
    this.dac_splitter
        .connect(this.dac_gain_left, 0)
        .connect(this.master_volume_left);
    this.dac_splitter
        .connect(this.dac_gain_right, 1)
        .connect(this.master_volume_right);
    this.master_splitter
        .connect(this.master_volume_left, 0)
    /* Treble and bass disabled: leads not lag and noise
        .connect(this.master_treble_left)
        .connect(this.master_bass_left)
        .connect(this.master_gain_left)
    */
        .connect(this.master_merger, 0, 0);
    this.master_splitter
        .connect(this.master_volume_right, 1)
    /* Treble and bass disabled: leads not lag and noise
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
    bus.register("dac-update-data", function(data)
    {
        this.dac_buffer0 = data[0];
        this.dac_buffer1 = data[1];
    }, this);
    bus.register("dac-request-samplerate", function()
    {
        bus.send("dac-tell-samplerate", this.audio_context.sampleRate);
    }, this);
    bus.send("dac-tell-samplerate", this.audio_context.sampleRate);
    bus.register("dac-enable", function(enabled)
    {
        this.dac_processor.connect(this.dac_splitter);
    }, this);
    bus.register("dac-disable", function()
    {
        this.dac_processor.disconnect();
    }, this);

    if(DEBUG)
    {
        this.debug_dac = false;
        this.debug_dac_out = [];
        window["speaker_debug_dac_out"] = this.debug_dac_out;
        window["speaker_debug_start"] = () =>
        {
            this.debug_dac = true;
            setTimeout(() =>
            {
                this.debug_dac = false;
            },250);
        }
    }

    // Start Nodes
    this.beep_oscillator.start();
}

SpeakerAdapter.prototype.dac_process = function(event)
{
    var out = event.outputBuffer;

    out.copyToChannel(this.dac_buffer0, 0);
    out.copyToChannel(this.dac_buffer1, 1);

    this.bus.send("dac-request-data", out.length);

    if(DEBUG)
    {
        if(this.debug_dac)
        {
            this.debug_dac_out.push(event.outputBuffer.getChannelData(0).slice());
        }
    }
};
