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

    this.beep_gain = this.audio_context.createGain();
    this.beep_gain.gain.value = 0;
    this.beep_gain.connect(this.audio_context.destination);

    this.beep_oscillator = this.audio_context.createOscillator();
    this.beep_oscillator.type = 'square';
    this.beep_oscillator.frequency.value = 440;
    this.beep_oscillator.connect(this.beep_gain);
    this.beep_oscillator.start();

    this.beep_playing = false;
    this.beep_enable = false;
    this.beep_frequency = 440;
    this.pit_enabled = false;

    this.dac_processor = this.audio_context.createScriptProcessor(2048, 0, 2);
    this.dac_processor.onaudioprocess = this.dac_process.bind(this);
    this.dac_processor.connect(this.audio_context.destination);

    bus.register("pcspeaker-enable", function(yesplease)
    {
        this.beep_enable = yesplease;
        this.beep_update();
    }, this);

    bus.register("pcspeaker-update", function(data)
    {
        var counter_mode = data[0];
        var counter_reload = data[1];
        this.pit_enabled = counter_mode == 3;
        this.beep_frequency = OSCILLATOR_FREQ * 1000 / counter_reload;
        this.beep_update();
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
}

SpeakerAdapter.prototype.beep_update = function()
{
    var current_time = this.audio_context.currentTime;

    if(this.pit_enabled && this.beep_enable)
    {
        this.beep_oscillator.frequency.setValueAtTime(this.beep_frequency, current_time);
        if(!this.beep_playing)
        {
            this.beep_gain.gain.setValueAtTime(1, current_time);
            this.beep_playing = true;
        }
    }
    else if(this.beep_playing)
    {
        this.beep_gain.gain.setValueAtTime(0, current_time);
        this.beep_playing = false;
    }
};

SpeakerAdapter.prototype.dac_process = function(event)
{
    this.bus.send("speaker-tell-samplerate", this.audio_context.sampleRate);
    this.bus.send("speaker-process", event);

    if(DEBUG)
    {
        if(this.debug_dac)
        {
            this.debug_dac_out.push(event.outputBuffer.getChannelData(0).slice());
        }
    }
};
