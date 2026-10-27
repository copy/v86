// The HD Audio codec behind the controller (src/audio_devices/hd_audio/
// controller.js): a generic output codec, as QEMU's hda-output
// (hw/audio/hda-codec.c) is, which the drivers that come with Windows
// (hdaudio.inf, HDAUDIO\FUNC_01) and Linux (the generic codec parser)
// accept without codec-specific setup. Its nodes: the root, the audio
// function group, a stereo DAC with an output amplifier (mute and 74 steps
// of 1 dB, a volume control for the guest's mixer) and a line out pin
// connected to it. See the High Definition Audio Specification 1.0a,
// sections 7.3 (verbs and parameters).

// codec IDs (QEMU's: vendor 1AF4, its output codec with a mixer)
const VENDOR_ID = 0x1AF40012;
const REVISION_ID = 0x00100101;

const NID_ROOT = 0, NID_AFG = 1, NID_DAC = 2, NID_PIN = 3;

// parameters (GET_PARAMETERS)
const PAR_VENDOR_ID = 0x00, PAR_SUBSYSTEM_ID = 0x01, PAR_REV_ID = 0x02, PAR_NODE_COUNT = 0x04, PAR_FUNCTION_TYPE = 0x05,
    PAR_AUDIO_FG_CAP = 0x08, PAR_AUDIO_WIDGET_CAP = 0x09, PAR_PCM = 0x0A, PAR_STREAM = 0x0B, PAR_PIN_CAP = 0x0C,
    PAR_AMP_IN_CAP = 0x0D, PAR_CONNLIST_LEN = 0x0E, PAR_POWER_STATE = 0x0F, PAR_PROC_CAP = 0x10, PAR_GPIO_CAP = 0x11,
    PAR_AMP_OUT_CAP = 0x12, PAR_VOL_KNB_CAP = 0x13;

// widget capabilities
const WCAP_STEREO = 1 << 0, WCAP_OUT_AMP = 1 << 2, WCAP_AMP_OVRD = 1 << 3, WCAP_FORMAT_OVRD = 1 << 4, WCAP_CONN_LIST = 1 << 8;
const WID_AUD_OUT = 0, WID_PIN = 4;
const WCAP_TYPE_SHIFT = 20;

/**
 * The formats: 16-bit PCM at 44.1 and 48 kHz (bits 5 and 6), what the
 * controller's streams play (PCM_RATES of controller.js)
 */
export const PCM_FORMATS = 1 << 17 | 1 << 5 | 1 << 6;
const SUPFMT_PCM = 1;
const PINCAP_OUT = 1 << 4;
// the DAC's amplifier: mute, 74 steps of 1 dB (step size 3: (3 + 1) / 4 dB), 0 dB at step 74
export const AMP_STEPS = 0x4A;
const AMP_CAPS = 1 << 31 | 3 << 16 | AMP_STEPS << 8 | AMP_STEPS;
// line out, a jack, green, association 1 (QEMU's)
const PIN_CONFIG = 0x00004010;
const PINCTL_OUT_EN = 1 << 6;

// verbs with 8-bit payloads (12-bit verbs)
const VERB_PARAMETERS = 0xF00, VERB_GET_CONNECT_SEL = 0xF01, VERB_GET_CONNECT_LIST = 0xF02, VERB_GET_POWER_STATE = 0xF05,
    VERB_GET_CONV = 0xF06, VERB_GET_PIN_WIDGET_CONTROL = 0xF07, VERB_GET_UNSOLICITED = 0xF08, VERB_GET_PIN_SENSE = 0xF09,
    VERB_GET_EAPD_BTLENABLE = 0xF0C, VERB_GET_DIGI_CONVERT = 0xF0D, VERB_GET_CONFIG_DEFAULT = 0xF1C,
    VERB_GET_SUBSYSTEM_ID = 0xF20, VERB_GET_CVT_CHAN_COUNT = 0xF2D,
    VERB_SET_CONNECT_SEL = 0x701, VERB_SET_POWER_STATE = 0x705, VERB_SET_CHANNEL_STREAMID = 0x706,
    VERB_SET_PIN_WIDGET_CONTROL = 0x707, VERB_SET_UNSOLICITED = 0x708, VERB_SET_EAPD_BTLENABLE = 0x70C,
    VERB_SET_DIGI_CONVERT_1 = 0x70D, VERB_SET_CONFIG_DEFAULT_0 = 0x71C, VERB_SET_CONFIG_DEFAULT_3 = 0x71F,
    VERB_SET_SUBSYSTEM_ID_0 = 0x720, VERB_SET_SUBSYSTEM_ID_3 = 0x723, VERB_SET_CVT_CHAN_COUNT = 0x72D, VERB_RESET = 0x7FF;
// verbs with 16-bit payloads (4-bit verbs)
const VERB4_SET_STREAM_FORMAT = 0x2, VERB4_SET_AMP_GAIN_MUTE = 0x3, VERB4_GET_STREAM_FORMAT = 0xA, VERB4_GET_AMP_GAIN_MUTE = 0xB;

/**
 * @constructor
 * @param {number} address the codec's address on the link (SDIN), 0
 */
export function HDACodec(address)
{
    this.address = address;
    this.reset();
}

/** Power on, a link reset or the function group's reset verb */
HDACodec.prototype.reset = function()
{
    /** The DAC's stream (tag) and channel; tag 0: not playing */
    this.stream = 0;
    this.channel = 0;
    /** The DAC's format (the stream format register's encoding) */
    this.format = 0x0011;
    /** The DAC's output amplifier: [left, right] gain steps and mute */
    this.gain = [AMP_STEPS, AMP_STEPS];
    this.mute = [false, false];
    this.pin_control = PINCTL_OUT_EN;
    this.pin_config = PIN_CONFIG;
    this.eapd = 0;
    this.unsolicited = 0;
    this.power = [0, 0, 0, 0];
    this.subsystem_id = VENDOR_ID;
    this.digital = 0;
};

/**
 * A node's parameter (GET_PARAMETERS)
 * @param {number} nid
 * @param {number} id
 * @return {number}
 */
HDACodec.prototype.parameter = function(nid, id)
{
    switch(nid)
    {
        case NID_ROOT:
            switch(id)
            {
                case PAR_VENDOR_ID: return VENDOR_ID;
                case PAR_SUBSYSTEM_ID: return this.subsystem_id;
                case PAR_REV_ID: return REVISION_ID;
                // one node from 1: the function group
                case PAR_NODE_COUNT: return 1 << 16 | 1;
            }
            return 0;
        case NID_AFG:
            switch(id)
            {
                case PAR_FUNCTION_TYPE: return 0x01;
                case PAR_SUBSYSTEM_ID: return this.subsystem_id;
                // two widgets from 2: the DAC and the pin
                case PAR_NODE_COUNT: return 2 << 16 | 2;
                case PAR_AUDIO_FG_CAP: return 0x00000808;
                case PAR_PCM: return PCM_FORMATS;
                case PAR_STREAM: return SUPFMT_PCM;
            }
            return 0;
        case NID_DAC:
            switch(id)
            {
                case PAR_AUDIO_WIDGET_CAP:
                    return WID_AUD_OUT << WCAP_TYPE_SHIFT | WCAP_FORMAT_OVRD | WCAP_AMP_OVRD | WCAP_OUT_AMP | WCAP_STEREO;
                case PAR_PCM: return PCM_FORMATS;
                case PAR_STREAM: return SUPFMT_PCM;
                case PAR_AMP_OUT_CAP: return AMP_CAPS;
            }
            return 0;
        case NID_PIN:
            switch(id)
            {
                case PAR_AUDIO_WIDGET_CAP: return WID_PIN << WCAP_TYPE_SHIFT | WCAP_CONN_LIST | WCAP_STEREO;
                case PAR_PIN_CAP: return PINCAP_OUT;
                case PAR_CONNLIST_LEN: return 1;
            }
            return 0;
    }
    return 0;
};

/**
 * A command from the controller (CORB or the immediate command): the
 * response (0 for nodes and verbs it does not have, as QEMU's codec answers)
 * @param {number} command the 32-bit verb
 * @return {number}
 */
HDACodec.prototype.command = function(command)
{
    const nid = command >>> 20 & 0x7F;
    if(nid > NID_PIN) return 0;
    // 4-bit verbs carry a 16-bit payload, 12-bit verbs (7xx, Fxx) an 8-bit one
    if((command >>> 16 & 7) !== 7)
    {
        return this.verb4(nid, command >>> 16 & 0xF, command & 0xFFFF);
    }
    return this.verb12(nid, command >>> 8 & 0xFFF, command & 0xFF);
};

/**
 * @param {number} nid
 * @param {number} verb
 * @param {number} payload
 * @return {number}
 */
HDACodec.prototype.verb4 = function(nid, verb, payload)
{
    if(nid !== NID_DAC) return 0;
    switch(verb)
    {
        case VERB4_SET_STREAM_FORMAT:
            this.format = payload;
            return 0;
        case VERB4_GET_STREAM_FORMAT:
            return this.format;
        case VERB4_SET_AMP_GAIN_MUTE:
            // output amplifier (bit 15), left (13) and right (12)
            if(payload & 1 << 15)
            {
                for(const [bit, side] of [[13, 0], [12, 1]])
                {
                    if(payload & 1 << bit)
                    {
                        this.gain[side] = Math.min(payload & 0x7F, AMP_STEPS);
                        this.mute[side] = !!(payload & 0x80);
                    }
                }
            }
            return 0;
        case VERB4_GET_AMP_GAIN_MUTE:
        {
            if(!(payload & 1 << 15)) return 0;
            const side = payload & 1 << 13 ? 0 : 1;
            return (this.mute[side] ? 0x80 : 0) | this.gain[side];
        }
    }
    return 0;
};

/**
 * @param {number} nid
 * @param {number} verb
 * @param {number} payload
 * @return {number}
 */
HDACodec.prototype.verb12 = function(nid, verb, payload)
{
    switch(verb)
    {
        case VERB_PARAMETERS:
            return this.parameter(nid, payload);
        case VERB_GET_SUBSYSTEM_ID:
            return this.subsystem_id;
        case VERB_GET_CONNECT_LIST:
            // the pin's one entry, the DAC
            return nid === NID_PIN && payload === 0 ? NID_DAC : 0;
        case VERB_GET_CONNECT_SEL:
        case VERB_SET_CONNECT_SEL:
            return 0;
        case VERB_GET_POWER_STATE:
            // (the state set, also as the actual state)
            return this.power[nid] << 4 | this.power[nid];
        case VERB_SET_POWER_STATE:
            this.power[nid] = payload & 0xF;
            return 0;
        case VERB_GET_CONV:
            return nid === NID_DAC ? this.stream << 4 | this.channel : 0;
        case VERB_SET_CHANNEL_STREAMID:
            if(nid === NID_DAC)
            {
                this.stream = payload >> 4;
                this.channel = payload & 0xF;
            }
            return 0;
        case VERB_GET_PIN_WIDGET_CONTROL:
            return nid === NID_PIN ? this.pin_control : 0;
        case VERB_SET_PIN_WIDGET_CONTROL:
            if(nid === NID_PIN) this.pin_control = payload;
            return 0;
        case VERB_GET_UNSOLICITED:
            return this.unsolicited;
        case VERB_SET_UNSOLICITED:
            this.unsolicited = payload;
            return 0;
        case VERB_GET_PIN_SENSE:
            // (nothing to sense: no presence detect in the pin's caps)
            return 0;
        case VERB_GET_EAPD_BTLENABLE:
            return this.eapd;
        case VERB_SET_EAPD_BTLENABLE:
            this.eapd = payload;
            return 0;
        case VERB_GET_DIGI_CONVERT:
            return this.digital;
        case VERB_SET_DIGI_CONVERT_1:
            this.digital = this.digital & ~0xFF | payload;
            return 0;
        case VERB_GET_CONFIG_DEFAULT:
            return nid === NID_PIN ? this.pin_config : 0;
        case VERB_GET_CVT_CHAN_COUNT:
            return nid === NID_DAC ? 1 : 0;
        case VERB_SET_CVT_CHAN_COUNT:
            return 0;
        case VERB_RESET:
            if(nid === NID_AFG) this.reset();
            return 0;
    }
    if(verb >= VERB_SET_CONFIG_DEFAULT_0 && verb <= VERB_SET_CONFIG_DEFAULT_3)
    {
        if(nid === NID_PIN)
        {
            const shift = (verb - VERB_SET_CONFIG_DEFAULT_0) << 3;
            this.pin_config = (this.pin_config & ~(0xFF << shift) | payload << shift) >>> 0;
        }
        return 0;
    }
    if(verb >= VERB_SET_SUBSYSTEM_ID_0 && verb <= VERB_SET_SUBSYSTEM_ID_3)
    {
        const shift = (verb - VERB_SET_SUBSYSTEM_ID_0) << 3;
        this.subsystem_id = (this.subsystem_id & ~(0xFF << shift) | payload << shift) >>> 0;
        return 0;
    }
    // other verbs: no state, the response 0 (as QEMU's codec answers)
    return 0;
};

/**
 * The DAC's output: whether stream `tag` plays through it, and its gains
 * (linear, per channel; 0 when muted or the pin is off)
 * @param {number} tag
 * @return {?Array<number>}
 */
HDACodec.prototype.output_for = function(tag)
{
    if(!tag || this.stream !== tag) return null;
    const on = !!(this.pin_control & PINCTL_OUT_EN);
    return [0, 1].map(side => on && !this.mute[side] ? Math.pow(10, (this.gain[side] - AMP_STEPS) / 20) : 0);
};

HDACodec.prototype.get_state = function()
{
    return [this.stream, this.channel, this.format, this.gain[0], this.gain[1], +this.mute[0], +this.mute[1],
        this.pin_control, this.pin_config, this.eapd, this.unsolicited, this.power.slice(), this.subsystem_id, this.digital];
};

HDACodec.prototype.set_state = function(state)
{
    [this.stream, this.channel, this.format] = state;
    this.gain = [state[3], state[4]];
    this.mute = [!!state[5], !!state[6]];
    [this.pin_control, this.pin_config, this.eapd, this.unsolicited] = state.slice(7, 11);
    this.power = state[11].slice();
    this.subsystem_id = state[12];
    this.digital = state[13];
};
