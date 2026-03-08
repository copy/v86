/**
 * DBOPL OPL2/OPL3 FM Synthesizer — JavaScript port of DOSBox DBOPL (GPL v2+)
 * DBOPL_WAVE = WAVE_TABLEMUL, no WAVE_PRECISION
 */
/* global sampleRate, registerProcessor, AudioWorkletProcessor */


// ============ Constants ============
const WAVE_BITS = 10;
const WAVE_SH = 32 - WAVE_BITS;
const WAVE_MASK = (1 << WAVE_SH) - 1;
const LFO_SH = WAVE_SH - 10;
const LFO_MAX = 256 << LFO_SH;
const ENV_BITS = 9;
const ENV_EXTRA = ENV_BITS - 9;
const ENV_MAX = 511 << ENV_EXTRA;
const ENV_LIMIT = (12 * 256) >> (3 - ENV_EXTRA);
const RATE_SH = 24;
const RATE_MASK = (1 << RATE_SH) - 1;
const MUL_SH = 16;
const TREMOLO_TABLE = 52;
const OPLRATE = 14318180.0 / 288.0;
const SHIFT_KSLBASE = 16;
const SHIFT_KEYCODE = 24;

const OFF = 0, RELEASE = 1, SUSTAIN = 2, DECAY = 3, ATTACK = 4;
const MASK_KSR = 0x10, MASK_SUSTAIN = 0x20, MASK_VIBRATO = 0x40, MASK_TREMOLO = 0x80;
const sm2AM = 0;
const sm2FM = 1;
const sm3AM = 2;
const sm3FM = 3;
const sm4Start = 4;
const sm3FMFM = 5;
const sm3AMFM = 6;
const sm3FMAM = 7;
const sm3AMAM = 8;
const sm6Start = 9;
const sm2Percussion = 10;
const sm3Percussion = 11;

// ============ Static constant tables ============
const KslCreateTable = [64, 32, 24, 19, 16, 12, 11, 10, 8, 6, 5, 4, 3, 2, 1, 0];
const FreqCreateTable = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];
const AttackSamplesTable = [69, 55, 46, 40, 35, 29, 23, 20, 19, 15, 11, 10, 9];
const EnvelopeIncreaseTable = [4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32];
const WaveBaseTable = [0x000, 0x200, 0x200, 0x800, 0xa00, 0xc00, 0x100, 0x400];
const WaveMaskTable = [1023, 1023, 511, 511, 1023, 1023, 512, 1023];
const WaveStartTable = [512, 0, 0, 0, 0, 512, 512, 256];
const VibratoTable = new Int8Array([1, 0, 1, 30, 1 - 128, 0 - 128, 1 - 128, 30 - 128]);
const KslShiftTable = [31, 1, 2, 0];

// ============ Computed tables (filled by initTables) ============
const MulTable = new Uint16Array(384);
const WaveTable = new Int16Array(8 * 512);
const KslTable = new Uint8Array(8 * 16);
const TremoloTable = new Uint8Array(TREMOLO_TABLE);
const chanLookup = new Int8Array(32).fill(-1);
const opLookup = new Array(64).fill(null);

function envelopeSelect(val) {
    if(val < 52) return [val & 3, 12 - (val >> 2)];
    if(val < 60) return [val - 48, 0];
    return [12, 0];
}

function initTables() {
    for(let i = 0; i < 384; i++) {
        MulTable[i] = 0.5 + Math.pow(2, -1 + (255 - i * 8) / 256) * (1 << MUL_SH);
    }
    for(let i = 0; i < 512; i++) {
        WaveTable[0x200 + i] = Math.trunc(Math.sin((i + 0.5) * Math.PI / 512) * 4084);
        WaveTable[0x000 + i] = -WaveTable[0x200 + i];
    }
    for(let i = 0; i < 256; i++) {
        WaveTable[0x700 + i] = Math.trunc(0.5 + Math.pow(2, -1 + (255 - i * 8) / 256) * 4085);
        WaveTable[0x6ff - i] = -WaveTable[0x700 + i];
    }
    for(let i = 0; i < 256; i++) {
        WaveTable[0x400 + i] = WaveTable[0];
        WaveTable[0x500 + i] = WaveTable[0];
        WaveTable[0x900 + i] = WaveTable[0];
        WaveTable[0xc00 + i] = WaveTable[0];
        WaveTable[0xd00 + i] = WaveTable[0];
        WaveTable[0x800 + i] = WaveTable[0x200 + i];
        WaveTable[0xa00 + i] = WaveTable[0x200 + i * 2];
        WaveTable[0xb00 + i] = WaveTable[0x000 + i * 2];
        WaveTable[0xe00 + i] = WaveTable[0x200 + i * 2];
        WaveTable[0xf00 + i] = WaveTable[0x200 + i * 2];
    }
    for(let oct = 0; oct < 8; oct++) {
        const base = oct * 8;
        for(let i = 0; i < 16; i++) {
            let val = base - KslCreateTable[i];
            if(val < 0) val = 0;
            KslTable[oct * 16 + i] = val * 4;
        }
    }
    for(let i = 0; i < (TREMOLO_TABLE >> 1); i++) {
        TremoloTable[i] = i << ENV_EXTRA;
        TremoloTable[TREMOLO_TABLE - 1 - i] = i << ENV_EXTRA;
    }
    for(let i = 0; i < 32; i++) {
        let idx = i & 0xf;
        if(idx >= 9) { chanLookup[i] = -1; continue; }
        if(idx < 6) idx = (idx % 3) * 2 + ((idx / 3) | 0);
        if(i >= 16) idx += 9;
        chanLookup[i] = idx;
    }
    for(let i = 0; i < 64; i++) {
        if(i % 8 >= 6 || ((i / 8 | 0) % 4 === 3)) { opLookup[i] = null; continue; }
        let chNum = ((i / 8) | 0) * 3 + (i % 8) % 3;
        if(chNum >= 12) chNum += 4;
        const opNum = ((i % 8) / 3) | 0;
        const chanIdx = chanLookup[chNum];
        opLookup[i] = chanIdx >= 0 ? [chanIdx, opNum] : null;
    }
}

// ============ Operator ============
class Operator {
    constructor() {
        this.waveBaseIdx = 0;
        this.waveMask = 0;
        this.waveStart = 0;
        this.waveIndex = 0;
        this.waveAdd = 0;
        this.waveCurrent = 0;
        this.chanData = 0;
        this.freqMul = 0;
        this.vibrato = 0;
        this.sustainLevel = ENV_MAX;
        this.totalLevel = ENV_MAX;
        this.currentLevel = ENV_MAX;
        this.volume = ENV_MAX;
        this.attackAdd = 0;
        this.decayAdd = 0;
        this.releaseAdd = 0;
        this.rateIndex = 0;
        this.rateZero = 1 << OFF;
        this.keyOn = 0;
        this.reg20 = 0;
        this.reg40 = 0;
        this.reg60 = 0;
        this.reg80 = 0;
        this.regE0 = 0;
        this.state = OFF;
        this.tremoloMask = 0;
        this.vibStrength = 0;
        this.ksr = 0;
    }

    updateAttack(chip) {
        const rate = this.reg60 >> 4;
        if(rate) {
            this.attackAdd = chip.attackRates[(rate << 2) + this.ksr];
            this.rateZero &= ~(1 << ATTACK);
        } else {
            this.attackAdd = 0;
            this.rateZero |= 1 << ATTACK;
        }
    }

    updateDecay(chip) {
        const rate = this.reg60 & 0xf;
        if(rate) {
            this.decayAdd = chip.linearRates[(rate << 2) + this.ksr];
            this.rateZero &= ~(1 << DECAY);
        } else {
            this.decayAdd = 0;
            this.rateZero |= 1 << DECAY;
        }
    }

    updateRelease(chip) {
        const rate = this.reg80 & 0xf;
        if(rate) {
            this.releaseAdd = chip.linearRates[(rate << 2) + this.ksr];
            this.rateZero &= ~(1 << RELEASE);
            if(!(this.reg20 & MASK_SUSTAIN)) this.rateZero &= ~(1 << SUSTAIN);
        } else {
            this.releaseAdd = 0;
            this.rateZero |= 1 << RELEASE;
            if(!(this.reg20 & MASK_SUSTAIN)) this.rateZero |= 1 << SUSTAIN;
        }
    }

    updateAttenuation() {
        const kslBase = (this.chanData >>> SHIFT_KSLBASE) & 0xff;
        const tl = this.reg40 & 0x3f;
        const kslShift = KslShiftTable[this.reg40 >> 6];
        this.totalLevel = tl << (ENV_BITS - 7);
        this.totalLevel += (kslBase << ENV_EXTRA) >> kslShift;
    }

    updateFrequency() {
        const freq = this.chanData & 0x3ff;
        const block = (this.chanData >> 10) & 0xff;
        this.waveAdd = ((freq << block) * this.freqMul) >>> 0;
        if(this.reg20 & MASK_VIBRATO) {
            this.vibStrength = (freq >> 7) & 0xff;
            this.vibrato = ((this.vibStrength << block) * this.freqMul) >>> 0;
        } else {
            this.vibStrength = 0;
            this.vibrato = 0;
        }
    }

    updateRates(chip) {
        let newKsr = (this.chanData >>> SHIFT_KEYCODE) & 0xff;
        if(!(this.reg20 & MASK_KSR)) newKsr >>= 2;
        if(this.ksr === newKsr) return;
        this.ksr = newKsr;
        this.updateAttack(chip);
        this.updateDecay(chip);
        this.updateRelease(chip);
    }

    rateForward(add) {
        this.rateIndex += add;
        const ret = this.rateIndex >>> RATE_SH;
        this.rateIndex &= RATE_MASK;
        return ret;
    }

    templateVolume() {
        let vol = this.volume;
        switch(this.state) {
            case OFF: return ENV_MAX;
            case ATTACK: {
                const change = this.rateForward(this.attackAdd);
                if(!change) return vol;
                vol += ((~vol) * change) >> 3;
                if(vol < 0) {
                    this.volume = 0;
                    this.rateIndex = 0;
                    this.state = DECAY;
                    return 0;
                }
                break;
            }
            case DECAY:
                vol += this.rateForward(this.decayAdd);
                if(vol >= this.sustainLevel) {
                    if(vol >= ENV_MAX) {
                        this.volume = ENV_MAX;
                        this.state = OFF;
                        return ENV_MAX;
                    }
                    this.rateIndex = 0;
                    this.state = SUSTAIN;
                }
                break;
            case SUSTAIN:
                if(this.reg20 & MASK_SUSTAIN) return vol;
                // fall through to release
            case RELEASE:
                vol += this.rateForward(this.releaseAdd);
                if(vol >= ENV_MAX) {
                    this.volume = ENV_MAX;
                    this.state = OFF;
                    return ENV_MAX;
                }
                break;
        }
        this.volume = vol;
        return vol;
    }

    forwardVolume() {
        return this.currentLevel + this.templateVolume();
    }

    forwardWave() {
        this.waveIndex = (this.waveIndex + this.waveCurrent) >>> 0;
        return this.waveIndex >>> WAVE_SH;
    }

    getWave(index, vol) {
        return (WaveTable[this.waveBaseIdx + (index & this.waveMask)] * MulTable[vol]) >> MUL_SH;
    }

    getSample(modulation) {
        const vol = this.forwardVolume();
        if(vol >= ENV_LIMIT) {
            this.waveIndex = (this.waveIndex + this.waveCurrent) >>> 0;
            return 0;
        }
        const index = this.forwardWave();
        return this.getWave(index + modulation, vol);
    }

    silent() {
        if(this.totalLevel + this.volume < ENV_LIMIT) return false;
        if(!(this.rateZero & (1 << this.state))) return false;
        return true;
    }

    prepare(chip) {
        this.currentLevel = this.totalLevel + (chip.tremoloValue & this.tremoloMask);
        this.waveCurrent = this.waveAdd;
        if((this.vibStrength >>> chip.vibratoShift) !== 0) {
            let add = (this.vibrato >>> chip.vibratoShift) | 0;
            const neg = chip.vibratoSign;
            add = (add ^ neg) - neg;
            this.waveCurrent = (this.waveCurrent + add) | 0;
        }
    }

    keyOnAction(mask) {
        if(!this.keyOn) {
            this.waveIndex = this.waveStart;
            this.rateIndex = 0;
            this.state = ATTACK;
        }
        this.keyOn |= mask;
    }

    keyOffAction(mask) {
        this.keyOn &= ~mask;
        if(!this.keyOn && this.state !== OFF) {
            this.state = RELEASE;
        }
    }

    write20(chip, val) {
        const change = this.reg20 ^ val;
        if(!change) return;
        this.reg20 = val;
        this.tremoloMask = (val << 24) >> 31;
        this.tremoloMask &= ~((1 << ENV_EXTRA) - 1);
        if(change & MASK_KSR) this.updateRates(chip);
        if((this.reg20 & MASK_SUSTAIN) || !this.releaseAdd) {
            this.rateZero |= 1 << SUSTAIN;
        } else {
            this.rateZero &= ~(1 << SUSTAIN);
        }
        if(change & (0xf | MASK_VIBRATO)) {
            this.freqMul = chip.freqMul[val & 0xf];
            this.updateFrequency();
        }
    }

    write40(chip, val) {
        if(this.reg40 === val) return;
        this.reg40 = val;
        this.updateAttenuation();
    }

    write60(chip, val) {
        const change = this.reg60 ^ val;
        this.reg60 = val;
        if(change & 0x0f) this.updateDecay(chip);
        if(change & 0xf0) this.updateAttack(chip);
    }

    write80(chip, val) {
        const change = this.reg80 ^ val;
        if(!change) return;
        this.reg80 = val;
        let sustain = val >> 4;
        sustain |= (sustain + 1) & 0x10;
        this.sustainLevel = sustain << (ENV_BITS - 5);
        if(change & 0x0f) this.updateRelease(chip);
    }

    writeE0(chip, val) {
        if(this.regE0 === val) return;
        const waveForm = val & ((0x3 & chip.waveFormMask) | (0x7 & chip.opl3Active));
        this.regE0 = val;
        this.waveBaseIdx = WaveBaseTable[waveForm];
        this.waveStart = WaveStartTable[waveForm] << WAVE_SH;
        this.waveMask = WaveMaskTable[waveForm];
    }
}

// ============ Channel ============
class Channel {
    constructor(index, chip) {
        this.index = index;
        this.chip = chip;
        this.op = [new Operator(), new Operator()];
        this.old = [0, 0];
        this.chanData = 0;
        this.feedback = 31;
        this.regB0 = 0;
        this.regC0 = 0;
        this.fourMask = 0;
        this.maskLeft = -1;
        this.maskRight = -1;
        this.synthMode = sm2FM;
    }

    Op(idx) {
        return this.chip.chan[this.index + (idx >> 1)].op[idx & 1];
    }

    setChanData(chip, data) {
        const change = this.chanData ^ data;
        this.chanData = data;
        this.op[0].chanData = data;
        this.op[1].chanData = data;
        this.op[0].updateFrequency();
        this.op[1].updateFrequency();
        if(change & (0xff << SHIFT_KSLBASE)) {
            this.op[0].updateAttenuation();
            this.op[1].updateAttenuation();
        }
        if(change & (0xff << SHIFT_KEYCODE)) {
            this.op[0].updateRates(chip);
            this.op[1].updateRates(chip);
        }
    }

    updateFrequency(chip, fourOp) {
        let data = this.chanData & 0xffff;
        const kslBase = KslTable[data >> 6];
        let keyCode = (data & 0x1c00) >> 9;
        if(chip.reg08 & 0x40) {
            keyCode |= (data & 0x100) >> 8;
        } else {
            keyCode |= (data & 0x200) >> 9;
        }
        data |= (keyCode << SHIFT_KEYCODE) | (kslBase << SHIFT_KSLBASE);
        this.setChanData(chip, data);
        if(fourOp & 0x3f) {
            this.chip.chan[this.index + 1].setChanData(chip, data);
        }
    }

    writeA0(chip, val) {
        const fourOp = chip.reg104 & chip.opl3Active & this.fourMask;
        if(fourOp > 0x80) return;
        const change = (this.chanData ^ val) & 0xff;
        if(change) {
            this.chanData ^= change;
            this.updateFrequency(chip, fourOp);
        }
    }

    writeB0(chip, val) {
        const fourOp = chip.reg104 & chip.opl3Active & this.fourMask;
        if(fourOp > 0x80) return;
        const change = (this.chanData ^ (val << 8)) & 0x1f00;
        if(change) {
            this.chanData ^= change;
            this.updateFrequency(chip, fourOp);
        }
        if(!((val ^ this.regB0) & 0x20)) return;
        this.regB0 = val;
        if(val & 0x20) {
            this.op[0].keyOnAction(0x1);
            this.op[1].keyOnAction(0x1);
            if(fourOp & 0x3f) {
                this.chip.chan[this.index + 1].op[0].keyOnAction(1);
                this.chip.chan[this.index + 1].op[1].keyOnAction(1);
            }
        } else {
            this.op[0].keyOffAction(0x1);
            this.op[1].keyOffAction(0x1);
            if(fourOp & 0x3f) {
                this.chip.chan[this.index + 1].op[0].keyOffAction(1);
                this.chip.chan[this.index + 1].op[1].keyOffAction(1);
            }
        }
    }

    writeC0(chip, val) {
        if(!(val ^ this.regC0)) return;
        this.regC0 = val;
        this.feedback = (this.regC0 >> 1) & 7;
        this.feedback = this.feedback ? 9 - this.feedback : 31;
        this.updateSynth(chip);
    }

    updateSynth(chip) {
        if(chip.opl3Active) {
            if((chip.reg104 & this.fourMask) & 0x3f) {
                let chan0, chan1;
                if(!(this.fourMask & 0x80)) {
                    chan0 = this;
                    chan1 = chip.chan[this.index + 1];
                } else {
                    chan0 = chip.chan[this.index - 1];
                    chan1 = this;
                }
                const synth = ((chan0.regC0 & 1) << 0) | ((chan1.regC0 & 1) << 1);
                switch(synth) {
                case 0: chan0.synthMode = sm3FMFM; break;
                case 1: chan0.synthMode = sm3AMFM; break;
                case 2: chan0.synthMode = sm3FMAM; break;
                case 3: chan0.synthMode = sm3AMAM; break;
                }
            } else if((this.fourMask & 0x40) && (chip.regBD & 0x20)) {
                // Percussion - don't update
            } else if(this.regC0 & 1) {
                this.synthMode = sm3AM;
            } else {
                this.synthMode = sm3FM;
            }
            this.maskLeft = (this.regC0 & 0x10) ? -1 : 0;
            this.maskRight = (this.regC0 & 0x20) ? -1 : 0;
        } else {
            if((this.fourMask & 0x40) && (chip.regBD & 0x20)) {
                // Percussion - don't update
            } else if(this.regC0 & 1) {
                this.synthMode = sm2AM;
            } else {
                this.synthMode = sm2FM;
            }
        }
    }

    generatePercussion(chip, output, outIdx, opl3Mode) {
        let mod = (this.old[0] + this.old[1]) >>> this.feedback;
        this.old[0] = this.old[1];
        this.old[1] = this.Op(0).getSample(mod);

        if(this.regC0 & 1) { mod = 0; } else { mod = this.old[0]; }
        let sample = this.Op(1).getSample(mod);

        const noiseBit = chip.forwardNoise() & 0x1;
        const c2 = this.Op(2).forwardWave();
        const c5 = this.Op(5).forwardWave();
        const phaseBit = (((c2 & 0x88) ^ ((c2 << 5) & 0x80)) | ((c5 ^ (c5 << 2)) & 0x20)) ? 0x02 : 0x00;

        const hhVol = this.Op(2).forwardVolume();
        if(hhVol < ENV_LIMIT) {
            sample += this.Op(2).getWave((phaseBit << 8) | (0x34 << (phaseBit ^ (noiseBit << 1))), hhVol);
        }
        const sdVol = this.Op(3).forwardVolume();
        if(sdVol < ENV_LIMIT) {
            sample += this.Op(3).getWave((0x100 + (c2 & 0x100)) ^ (noiseBit << 8), sdVol);
        }
        sample += this.Op(4).getSample(0);
        const tcVol = this.Op(5).forwardVolume();
        if(tcVol < ENV_LIMIT) {
            sample += this.Op(5).getWave((1 + phaseBit) << 8, tcVol);
        }

        sample <<= 1;
        if(opl3Mode) {
            output[outIdx] += sample;
            output[outIdx + 1] += sample;
        } else {
            output[outIdx] += sample;
        }
    }

    blockTemplate(chip, samples, output, outIdx) {
        const mode = this.synthMode;
        switch(mode) {
        case sm2AM:
        case sm3AM:
            if(this.Op(0).silent() && this.Op(1).silent()) {
                this.old[0] = this.old[1] = 0;
                return this.index + 1;
            }
            break;
        case sm2FM:
        case sm3FM:
            if(this.Op(1).silent()) {
                this.old[0] = this.old[1] = 0;
                return this.index + 1;
            }
            break;
        case sm3FMFM:
            if(this.Op(3).silent()) {
                this.old[0] = this.old[1] = 0;
                return this.index + 2;
            }
            break;
        case sm3AMFM:
            if(this.Op(0).silent() && this.Op(3).silent()) {
                this.old[0] = this.old[1] = 0;
                return this.index + 2;
            }
            break;
        case sm3FMAM:
            if(this.Op(1).silent() && this.Op(3).silent()) {
                this.old[0] = this.old[1] = 0;
                return this.index + 2;
            }
            break;
        case sm3AMAM:
            if(this.Op(0).silent() && this.Op(2).silent() && this.Op(3).silent()) {
                this.old[0] = this.old[1] = 0;
                return this.index + 2;
            }
            break;
        }

        this.Op(0).prepare(chip);
        this.Op(1).prepare(chip);
        if(mode > sm4Start) {
            this.Op(2).prepare(chip);
            this.Op(3).prepare(chip);
        }
        if(mode > sm6Start) {
            this.Op(4).prepare(chip);
            this.Op(5).prepare(chip);
        }

        for(let i = 0; i < samples; i++) {
            if(mode === sm2Percussion) {
                this.generatePercussion(chip, output, outIdx + i, false);
                continue;
            } else if(mode === sm3Percussion) {
                this.generatePercussion(chip, output, outIdx + i * 2, true);
                continue;
            }
            const mod = (this.old[0] + this.old[1]) >>> this.feedback;
            this.old[0] = this.old[1];
            this.old[1] = this.Op(0).getSample(mod);
            let sample;
            const out0 = this.old[0];

            if(mode === sm2AM || mode === sm3AM) {
                sample = out0 + this.Op(1).getSample(0);
            } else if(mode === sm2FM || mode === sm3FM) {
                sample = this.Op(1).getSample(out0);
            } else if(mode === sm3FMFM) {
                let next = this.Op(1).getSample(out0);
                next = this.Op(2).getSample(next);
                sample = this.Op(3).getSample(next);
            } else if(mode === sm3AMFM) {
                sample = out0;
                let next = this.Op(1).getSample(0);
                next = this.Op(2).getSample(next);
                sample += this.Op(3).getSample(next);
            } else if(mode === sm3FMAM) {
                sample = this.Op(1).getSample(out0);
                const next = this.Op(2).getSample(0);
                sample += this.Op(3).getSample(next);
            } else if(mode === sm3AMAM) {
                sample = out0;
                const next = this.Op(1).getSample(0);
                sample += this.Op(2).getSample(next);
                sample += this.Op(3).getSample(0);
            }

            switch(mode) {
            case sm2AM:
            case sm2FM:
                output[outIdx + i] += sample;
                break;
            case sm3AM:
            case sm3FM:
            case sm3FMFM:
            case sm3AMFM:
            case sm3FMAM:
            case sm3AMAM:
                output[outIdx + i * 2 + 0] += sample & this.maskLeft;
                output[outIdx + i * 2 + 1] += sample & this.maskRight;
                break;
            }
        }

        switch(mode) {
        case sm2AM:
        case sm2FM:
        case sm3AM:
        case sm3FM:
            return this.index + 1;
        case sm3FMFM:
        case sm3AMFM:
        case sm3FMAM:
        case sm3AMAM:
            return this.index + 2;
        case sm2Percussion:
        case sm3Percussion:
            return this.index + 3;
        }
        return this.index;
    }
}

// ============ Chip ============
class Chip {
    constructor() {
        this.chan = [];
        for(let i = 0; i < 18; i++) this.chan[i] = new Channel(i, this);

        this.lfoCounter = 0;
        this.lfoAdd = 0;
        this.noiseCounter = 0;
        this.noiseAdd = 0;
        this.noiseValue = 1;

        this.freqMul = new Uint32Array(16);
        this.linearRates = new Uint32Array(76);
        this.attackRates = new Uint32Array(76);

        this.reg104 = 0;
        this.reg08 = 0;
        this.reg04 = 0;
        this.regBD = 0;
        this.vibratoIndex = 0;
        this.tremoloIndex = 0;
        this.vibratoSign = 0;
        this.vibratoShift = 0;
        this.tremoloValue = 0;
        this.vibratoStrength = 0;
        this.tremoloStrength = 0;
        this.waveFormMask = 0;
        this.opl3Active = 0;
    }

    forwardNoise() {
        this.noiseCounter += this.noiseAdd;
        let count = this.noiseCounter >>> LFO_SH;
        this.noiseCounter &= WAVE_MASK;
        for(; count > 0; --count) {
            this.noiseValue ^= 0x800302 & (0 - (this.noiseValue & 1));
            this.noiseValue >>>= 1;
        }
        return this.noiseValue;
    }

    forwardLFO(samples) {
        this.vibratoSign = VibratoTable[this.vibratoIndex >> 2] >> 7;
        this.vibratoShift = (VibratoTable[this.vibratoIndex >> 2] & 7) + this.vibratoStrength;
        this.tremoloValue = TremoloTable[this.tremoloIndex] >> this.tremoloStrength;

        const todo = LFO_MAX - this.lfoCounter;
        let count = ((todo + this.lfoAdd - 1) / this.lfoAdd) | 0;
        if(count > samples) {
            count = samples;
            this.lfoCounter += count * this.lfoAdd;
        } else {
            this.lfoCounter += count * this.lfoAdd;
            this.lfoCounter &= LFO_MAX - 1;
            this.vibratoIndex = (this.vibratoIndex + 1) & 31;
            if(this.tremoloIndex + 1 < TREMOLO_TABLE) ++this.tremoloIndex;
            else this.tremoloIndex = 0;
        }
        return count;
    }

    writeBD(val) {
        const change = this.regBD ^ val;
        if(!change) return;
        this.regBD = val;
        this.vibratoStrength = (val & 0x40) ? 0x00 : 0x01;
        this.tremoloStrength = (val & 0x80) ? 0x00 : 0x02;

        if(val & 0x20) {
            if(change & 0x20) {
                if(this.opl3Active) {
                    this.chan[6].synthMode = sm3Percussion;
                } else {
                    this.chan[6].synthMode = sm2Percussion;
                }
            }
            if(val & 0x10) { this.chan[6].op[0].keyOnAction(0x2); this.chan[6].op[1].keyOnAction(0x2); }
            else { this.chan[6].op[0].keyOffAction(0x2); this.chan[6].op[1].keyOffAction(0x2); }
            if(val & 0x01) this.chan[7].op[0].keyOnAction(0x2);
            else this.chan[7].op[0].keyOffAction(0x2);
            if(val & 0x08) this.chan[7].op[1].keyOnAction(0x2);
            else this.chan[7].op[1].keyOffAction(0x2);
            if(val & 0x04) this.chan[8].op[0].keyOnAction(0x2);
            else this.chan[8].op[0].keyOffAction(0x2);
            if(val & 0x02) this.chan[8].op[1].keyOnAction(0x2);
            else this.chan[8].op[1].keyOffAction(0x2);
        } else if(change & 0x20) {
            this.chan[6].updateSynth(this);
            this.chan[6].op[0].keyOffAction(0x2);
            this.chan[6].op[1].keyOffAction(0x2);
            this.chan[7].op[0].keyOffAction(0x2);
            this.chan[7].op[1].keyOffAction(0x2);
            this.chan[8].op[0].keyOffAction(0x2);
            this.chan[8].op[1].keyOffAction(0x2);
        }
    }

    updateSynths() {
        for(let i = 0; i < 18; i++) this.chan[i].updateSynth(this);
    }

    writeReg(reg, val) {
        switch((reg & 0xf0) >> 4) {
            case 0:
                if(reg === 0x01) this.waveFormMask = (val & 0x20) ? 0x7 : 0x0;
                else if(reg === 0x104) {
                    if(!((this.reg104 ^ val) & 0x3f)) return;
                    this.reg104 = 0x80 | (val & 0x3f);
                    this.updateSynths();
                }
                else if(reg === 0x105) {
                    if(!((this.opl3Active ^ val) & 1)) return;
                    this.opl3Active = (val & 1) ? 0xff : 0;
                    this.updateSynths();
                }
                else if(reg === 0x08) this.reg08 = val;
                // fall through
            case 1: break;
            case 2: case 3: {
                const e = opLookup[((reg >> 3) & 0x20) | (reg & 0x1f)];
                if(e) this.chan[e[0]].op[e[1]].write20(this, val);
                break;
            }
            case 4: case 5: {
                const e = opLookup[((reg >> 3) & 0x20) | (reg & 0x1f)];
                if(e) this.chan[e[0]].op[e[1]].write40(this, val);
                break;
            }
            case 6: case 7: {
                const e = opLookup[((reg >> 3) & 0x20) | (reg & 0x1f)];
                if(e) this.chan[e[0]].op[e[1]].write60(this, val);
                break;
            }
            case 8: case 9: {
                const e = opLookup[((reg >> 3) & 0x20) | (reg & 0x1f)];
                if(e) this.chan[e[0]].op[e[1]].write80(this, val);
                break;
            }
            case 0xa: {
                const ch = chanLookup[((reg >> 4) & 0x10) | (reg & 0xf)];
                if(ch >= 0) this.chan[ch].writeA0(this, val);
                break;
            }
            case 0xb:
                if(reg === 0xbd) this.writeBD(val);
                else {
                    const ch = chanLookup[((reg >> 4) & 0x10) | (reg & 0xf)];
                    if(ch >= 0) this.chan[ch].writeB0(this, val);
                }
                break;
            case 0xc: {
                const ch = chanLookup[((reg >> 4) & 0x10) | (reg & 0xf)];
                if(ch >= 0) this.chan[ch].writeC0(this, val);
                break;
            }
            case 0xd: break;
            case 0xe: case 0xf: {
                const e = opLookup[((reg >> 3) & 0x20) | (reg & 0x1f)];
                if(e) this.chan[e[0]].op[e[1]].writeE0(this, val);
                break;
            }
        }
    }

    writeAddr(port, val) {
        switch(port & 3) {
        case 0:
            return val;
        case 2:
            if(this.opl3Active || (val === 0x05))
                return 0x100 | val;
            else
                return val;
        }
        return 0;
    }

    generateBlock2(total, output) {
        let outIdx = 0;
        while(total > 0) {
            const samples = this.forwardLFO(total);
            for(let i = outIdx; i < outIdx + samples; i++) output[i] = 0;
            let chIdx = 0;
            while(chIdx < 9) {
                chIdx = this.chan[chIdx].blockTemplate(this, samples, output, outIdx);
            }
            total -= samples;
            outIdx += samples;
        }
    }

    generateBlock3(total, output) {
        let outIdx = 0;
        while(total > 0) {
            const samples = this.forwardLFO(total);
            for(let i = outIdx; i < outIdx + samples * 2; i++) output[i] = 0;
            let chIdx = 0;
            while(chIdx < 18) {
                chIdx = this.chan[chIdx].blockTemplate(this, samples, output, outIdx);
            }
            total -= samples;
            outIdx += samples * 2;
        }
    }

    setup(rate) {
        const scale = OPLRATE / rate;

        this.noiseAdd = Math.round(scale * (1 << LFO_SH));
        this.noiseCounter = 0;
        this.noiseValue = 1;
        this.lfoAdd = Math.round(scale * (1 << LFO_SH));
        this.lfoCounter = 0;
        this.vibratoIndex = 0;
        this.tremoloIndex = 0;

        const freqScale = Math.round(scale * (1 << (WAVE_SH - 1 - 10)));
        for(let i = 0; i < 16; i++) this.freqMul[i] = freqScale * FreqCreateTable[i];

        for(let i = 0; i < 76; i++) {
            const [index, shift] = envelopeSelect(i);
            this.linearRates[i] = Math.trunc(scale * (EnvelopeIncreaseTable[index] << (RATE_SH + ENV_EXTRA - shift - 3)));
        }

        for(let i = 0; i < 62; i++) {
            const [index, shift] = envelopeSelect(i);
            const origSamples = Math.trunc((AttackSamplesTable[index] << shift) / scale);
            let guessAdd = Math.trunc(scale * (EnvelopeIncreaseTable[index] << (RATE_SH - shift - 3)));
            let bestAdd = guessAdd, bestDiff = 1 << 30;
            for(let passes = 0; passes < 16; passes++) {
                let volume = ENV_MAX, samples = 0, count = 0;
                while(volume > 0 && samples < origSamples * 2) {
                    count += guessAdd;
                    const change = count >> RATE_SH;
                    count &= RATE_MASK;
                    if(change) volume += ((~volume) * change) >> 3;
                    samples++;
                }
                const diff = origSamples - samples;
                const lDiff = Math.abs(diff);
                if(lDiff < bestDiff) {
                    bestDiff = lDiff;
                    bestAdd = guessAdd;
                    if(!bestDiff) break;
                }
                guessAdd = Math.trunc(guessAdd * ((origSamples - diff) / origSamples));
                if(diff < 0) guessAdd++;
            }
            this.attackRates[i] = bestAdd;
        }
        for(let i = 62; i < 76; i++) this.attackRates[i] = 8 << RATE_SH;

        this.chan[0].fourMask = 0x00 | (1 << 0);
        this.chan[1].fourMask = 0x80 | (1 << 0);
        this.chan[2].fourMask = 0x00 | (1 << 1);
        this.chan[3].fourMask = 0x80 | (1 << 1);
        this.chan[4].fourMask = 0x00 | (1 << 2);
        this.chan[5].fourMask = 0x80 | (1 << 2);
        this.chan[9].fourMask = 0x00 | (1 << 3);
        this.chan[10].fourMask = 0x80 | (1 << 3);
        this.chan[11].fourMask = 0x00 | (1 << 4);
        this.chan[12].fourMask = 0x80 | (1 << 4);
        this.chan[13].fourMask = 0x00 | (1 << 5);
        this.chan[14].fourMask = 0x80 | (1 << 5);
        this.chan[6].fourMask = 0x40;
        this.chan[7].fourMask = 0x40;
        this.chan[8].fourMask = 0x40;

        this.writeReg(0x105, 0x1);
        for(let i = 0; i < 512; i++) {
            if(i === 0x105) continue;
            this.writeReg(i, 0xff);
            this.writeReg(i, 0x0);
        }
        this.writeReg(0x105, 0x0);
        for(let i = 0; i < 255; i++) {
            this.writeReg(i, 0xff);
            this.writeReg(i, 0x0);
        }
    }
}

// ============ AudioWorklet Processor ============
class OPL2Processor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.chip = new Chip();
        this.chip.setup(sampleRate);
        this.buf = new Int32Array(128);
        this.port.onmessage = (e) => {
            const msg = e.data;
            if(msg.t === "w") this.chip.writeReg(msg.r, msg.v);
        };
    }

    process(inputs, outputs) {
        const outL = outputs[0][0];
        if(!outL) return true;
        const outR = outputs[0][1];
        const len = outL.length;
        if(!this.chip.opl3Active) {
            if(this.buf.length < len) this.buf = new Int32Array(len);
            this.chip.generateBlock2(len, this.buf);
            for(let i = 0; i < len; i++) outL[i] = this.buf[i] / 32768;
            // OPL2 is mono: copy left to right so both speakers get audio.
            if(outR) for(let i = 0; i < len; i++) outR[i] = outL[i];
        } else {
            if(this.buf.length < len * 2) this.buf = new Int32Array(len * 2);
            this.chip.generateBlock3(len, this.buf);
            for(let i = 0; i < len; i++) {
                outL[i] = this.buf[i * 2] / 32768;
                if(outR) outR[i] = this.buf[i * 2 + 1] / 32768;
            }
        }
        return true;
    }
}

initTables();
registerProcessor("opl2", OPL2Processor);
