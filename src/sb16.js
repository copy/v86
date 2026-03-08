import {
    LOG_SB16,
    MIXER_CHANNEL_BOTH, MIXER_CHANNEL_LEFT, MIXER_CHANNEL_RIGHT,
    MIXER_SRC_PCSPEAKER, MIXER_SRC_DAC, MIXER_SRC_MASTER, MIXER_SRC_OPL,
} from "./const.js";
import { h } from "./lib.js";
import { dbg_log } from "./log.js";
import { SyncBuffer } from "./buffer.js";

// For Types Only
import { CPU } from "./cpu.js";
import { DMA } from "./dma.js";
import { IO } from "./io.js";
import { BusConnector } from "./bus.js";
import { ByteQueue, FloatQueue } from "./lib.js";

// Useful documentation, articles, and source codes for reference:
// ===============================================================
//
// Official Hardware Programming Guide
// -> https://pdos.csail.mit.edu/6.828/2011/readings/hardware/SoundBlaster.pdf
//
// Official Yamaha YMF262 Manual
// -> http://map.grauw.nl/resources/sound/yamaha_ymf262.pdf
//
// OPL3 Programming Guide
// -> http://www.fit.vutbr.cz/~arnost/opl/opl3.html
//
// DOSBox
// -> https://sourceforge.net/p/dosbox/code-0/HEAD/tree/dosbox/branches/mamesound/src/hardware/sblaster.cpp
// -> https://github.com/duganchen/dosbox/blob/master/src/hardware/sblaster.cpp
// -> https://github.com/joncampbell123/dosbox-x/blob/master/src/hardware/sblaster.cpp
//
// QEMU
// -> https://github.com/qemu/qemu/blob/master/hw/audio/sb16.c
// -> https://github.com/hackndev/qemu/blob/master/hw/sb16.c
//
// VirtualBox
// -> https://www.virtualbox.org/svn/vbox/trunk/src/VBox/Devices/Audio/DevSB16.cpp
// -> https://github.com/mdaniel/virtualbox-org-svn-vbox-trunk/blob/master/src/VBox/Devices/Audio/DevSB16.cpp

const
    // Used for drivers to identify device (DSP command 0xE3).
    DSP_COPYRIGHT = "COPYRIGHT (C) CREATIVE TECHNOLOGY LTD, 1992.",

    // Value of the current DSP command that indicates that the
    // next command/data write in port 2xC should be interpreted
    // as a command number.
    DSP_NO_COMMAND = 0,

    // Size (bytes) of the DSP write/read buffers
    DSP_BUFSIZE = 64,

    // Size (bytes) of the buffers containing floating point linear PCM audio.
    DSP_DACSIZE = 65536,

    // Size (bytes) of the buffer in which DMA transfers are temporarily
    // stored before being processed.
    SB_DMA_BUFSIZE = 65536,

    // Number of samples to attempt to retrieve per transfer.
    SB_DMA_BLOCK_SAMPLES = 1024,

    // Usable DMA channels.
    SB_DMA0 = 0,
    SB_DMA1 = 1,
    SB_DMA3 = 3,
    SB_DMA5 = 5,
    SB_DMA6 = 6,
    SB_DMA7 = 7,

    // Default DMA channels.
    SB_DMA_CHANNEL_8BIT = SB_DMA1,
    SB_DMA_CHANNEL_16BIT = SB_DMA5,

    // Usable IRQ channels.
    SB_IRQ2 = 2,
    SB_IRQ5 = 5,
    SB_IRQ7 = 7,
    SB_IRQ10 = 10,

    // Default IRQ channel.
    SB_IRQ = SB_IRQ5,

    // Indices to the irq_triggered register.
    SB_IRQ_8BIT = 0x1,
    SB_IRQ_16BIT = 0x2,
    SB_IRQ_MIDI = 0x1,
    SB_IRQ_MPU = 0x4;

// Creative ADPCM lookup tables
// ADPCM 4-bit (nybble compressed): each byte → 2 output samples
const ADPCM4_SCALE_MAP = new Int8Array([
     0,  1,  2,  3,  4,  5,  6,  7,  0, -1, -2, -3, -4, -5, -6, -7,
     1,  3,  5,  7,  9, 11, 13, 15, -1, -3, -5, -7, -9,-11,-13,-15,
     2,  6, 10, 14, 18, 22, 26, 30, -2, -6,-10,-14,-18,-22,-26,-30,
     4, 12, 20, 28, 36, 44, 52, 60, -4,-12,-20,-28,-36,-44,-52,-60
]);
const ADPCM4_ADJUST_MAP = new Uint8Array([
      0,  0,  0,  0,  0, 16, 16, 16,   0,  0,  0,  0,  0, 16, 16, 16,
    240,  0,  0,  0,  0, 16, 16, 16, 240,  0,  0,  0,  0, 16, 16, 16,
    240,  0,  0,  0,  0, 16, 16, 16, 240,  0,  0,  0,  0, 16, 16, 16,
    240,  0,  0,  0,  0,  0,  0,  0, 240,  0,  0,  0,  0,  0,  0,  0
]);

// ADPCM 2-bit (pairs packed 4 per byte): each byte → 4 output samples
const ADPCM2_SCALE_MAP = new Int8Array([
     0,  1,  0, -1,  1,  3, -1, -3,
     2,  6, -2, -6,  4, 12, -4,-12,
     8, 24, -8,-24,  6, 48,-16,-48
]);
const ADPCM2_ADJUST_MAP = new Uint8Array([
      0,  4,   0,  4,
    252,  4, 252,  4, 252,  4, 252,  4,
    252,  4, 252,  4, 252,  4, 252,  4,
    252,  0, 252,  0
]);

// ADPCM 3-bit (packed 3 per byte, 2.6-bit resolution): each byte → 3 output samples
const ADPCM3_SCALE_MAP = new Int8Array([
     0,  1,  2,  3,  0, -1, -2, -3,
     1,  3,  5,  7, -1, -3, -5, -7,
     2,  6, 10, 14, -2, -6,-10,-14,
     4, 12, 20, 28, -4,-12,-20,-28,
     5, 15, 25, 35, -5,-15,-25,-35
]);
const ADPCM3_ADJUST_MAP = new Uint8Array([
      0,  0,  0,  8,   0,  0,  0,  8,
    248,  0,  0,  8, 248,  0,  0,  8,
    248,  0,  0,  8, 248,  0,  0,  8,
    248,  0,  0,  8, 248,  0,  0,  8,
    248,  0,  0,  0, 248,  0,  0,  0
]);

// Probably less efficient, but it's more maintainable, instead
// of having a single large unorganised and decoupled table.
var DSP_COMMAND_SIZES = new Uint8Array(256);
var DSP_COMMAND_HANDLERS = [];
var MIXER_READ_HANDLERS = [];
var MIXER_WRITE_HANDLERS = [];
var MIXER_REGISTER_IS_LEGACY = new Uint8Array(256);
var FM_HANDLERS = [];


/**
 * Sound Blaster 16 Emulator, or so it seems.
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 */
export function SB16(cpu, bus)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    /** @const @type {BusConnector} */
    this.bus = bus;

    // I/O Buffers.
    this.write_buffer = new ByteQueue(DSP_BUFSIZE);
    this.read_buffer = new ByteQueue(DSP_BUFSIZE);
    this.read_buffer_lastvalue = 0;

    // Current DSP command info.
    this.command = DSP_NO_COMMAND;
    this.command_size = 0;

    // Mixer.
    this.mixer_current_address = 0;
    this.mixer_registers = new Uint8Array(256);
    this.mixer_reset();

    // Dummy status and test registers.
    this.dummy_speaker_enabled = false;
    this.test_register = 0;

    // DSP state.
    this.dsp_highspeed = false;
    this.dsp_stereo = false;
    this.dsp_16bit = false;
    this.dsp_signed = false;

    // DAC buffer.
    // The final destination for audio data before being sent off
    // to Web Audio APIs.
    // Format:
    // Floating precision linear PCM, nominal between -1 and 1.
    this.dac_buffers = [
      new FloatQueue(DSP_DACSIZE),
      new FloatQueue(DSP_DACSIZE),
    ];

    // Direct Memory Access transfer info.
    this.dma = cpu.devices.dma;
    this.dma_sample_count = 0;
    this.dma_bytes_count = 0;
    this.dma_bytes_left = 0;
    this.dma_bytes_block = 0;
    this.dma_irq = 0;
    this.dma_channel = 0;
    this.dma_channel_8bit = SB_DMA_CHANNEL_8BIT;
    this.dma_channel_16bit = SB_DMA_CHANNEL_16BIT;
    this.dma_autoinit = false;
    this.dma_buffer = new ArrayBuffer(SB_DMA_BUFSIZE);
    this.dma_buffer_int8 = new Int8Array(this.dma_buffer);
    this.dma_buffer_uint8 = new Uint8Array(this.dma_buffer);
    this.dma_buffer_int16 = new Int16Array(this.dma_buffer);
    this.dma_buffer_uint16 = new Uint16Array(this.dma_buffer);
    this.dma_syncbuffer = new SyncBuffer(this.dma_buffer);
    this.dma_waiting_transfer = false;
    this.dma_paused = false;
    // Pending 8-bit single-cycle ADC (0x24) byte count; 0 = no transfer pending.
    this.dma_adc_left = 0;
    this.sampling_rate = 22050;
    bus.send("dac-tell-sampling-rate", this.sampling_rate);
    this.bytes_per_sample = 1;

    // DMA identification data.
    this.e2_value = 0xAA;
    this.e2_count = 0;

    // ASP data: not understood by me.
    this.asp_registers = new Uint8Array(256);
    // Whether ASP chip initialisation sequence is in progress (used by 0x0F reg-toggle).
    this.asp_init_in_progress = false;

    // MPU.
    this.mpu_read_buffer = new ByteQueue(DSP_BUFSIZE);
    this.mpu_read_buffer_lastvalue = 0;
    // MPU-401 mode: 0=intelligent, 1=UART
    this.mpu_uart_mode = false;

    // Creative ADPCM decoder state.
    // dma_transfer_type: 0=PCM, 2=ADPCM-2bit, 3=ADPCM-3bit, 4=ADPCM-4bit
    this.dma_transfer_type = 0;
    this.adpcm_reference = 0;
    this.adpcm_stepsize = 0;
    this.adpcm_haveref = false;

    // FM Synthesizer.
    this.fm_current_address0 = 0;
    this.fm_current_address1 = 0;
    this.fm_waveform_select_enable = [false, false];

    // OPL Timer state (needed for OPL detection).
    this.fm_timer1_expired = false;
    this.fm_timer2_expired = false;
    this.fm_timer1_counter = -1;
    this.fm_timer2_counter = -1;

    // Interrupts.
    this.irq = SB_IRQ;
    this.irq_triggered = new Uint8Array(0x10);

    // IO Ports.
    // http://homepages.cae.wisc.edu/~brodskye/sb16doc/sb16doc.html#DSPPorts
    // https://pdos.csail.mit.edu/6.828/2011/readings/hardware/SoundBlaster.pdf

    cpu.io.register_read_consecutive(0x220, this,
        this.port2x0_read, this.port2x1_read, this.port2x2_read, this.port2x3_read);
    cpu.io.register_read_consecutive(0x388, this,
        this.port2x0_read, this.port2x1_read);

    cpu.io.register_read_consecutive(0x224, this,
        this.port2x4_read, this.port2x5_read);

    cpu.io.register_read(0x226, this, this.port2x6_read);
    cpu.io.register_read(0x227, this, this.port2x7_read);
    cpu.io.register_read(0x228, this, this.port2x8_read);
    cpu.io.register_read(0x229, this, this.port2x9_read);

    cpu.io.register_read(0x22A, this, this.port2xA_read);
    cpu.io.register_read(0x22B, this, this.port2xB_read);
    cpu.io.register_read(0x22C, this, this.port2xC_read);
    cpu.io.register_read(0x22D, this, this.port2xD_read);

    cpu.io.register_read_consecutive(0x22E, this,
        this.port2xE_read, this.port2xF_read);

    cpu.io.register_write_consecutive(0x220, this,
        this.port2x0_write, this.port2x1_write, this.port2x2_write, this.port2x3_write);
    cpu.io.register_write_consecutive(0x388, this,
        this.port2x0_write, this.port2x1_write);

    cpu.io.register_write_consecutive(0x224, this,
        this.port2x4_write, this.port2x5_write);

    cpu.io.register_write(0x226, this, this.port2x6_write);
    cpu.io.register_write(0x227, this, this.port2x7_write);

    cpu.io.register_write_consecutive(0x228, this,
        this.port2x8_write, this.port2x9_write);

    cpu.io.register_write(0x22A, this, this.port2xA_write);
    cpu.io.register_write(0x22B, this, this.port2xB_write);
    cpu.io.register_write(0x22C, this, this.port2xC_write);
    cpu.io.register_write(0x22D, this, this.port2xD_write);
    cpu.io.register_write(0x22E, this, this.port2xE_write);
    cpu.io.register_write(0x22F, this, this.port2xF_write);

    cpu.io.register_read_consecutive(0x330, this, this.port3x0_read, this.port3x1_read);
    cpu.io.register_write_consecutive(0x330, this, this.port3x0_write, this.port3x1_write);

    this.dma.on_unmask(this.dma_on_unmask, this);

    bus.register("dac-request-data", function()
    {
        this.dac_handle_request();
    }, this);
    bus.register("speaker-has-initialized", function()
    {
        this.mixer_reset();
    }, this);
    bus.send("speaker-confirm-initialized");

    this.dsp_reset();
}

//
// General
//

SB16.prototype.dsp_reset = function()
{
    this.write_buffer.clear();
    this.read_buffer.clear();

    this.command = DSP_NO_COMMAND;
    this.command_size = 0;

    this.dummy_speaker_enabled = false;
    this.test_register = 0;

    this.dsp_highspeed = false;
    this.dsp_stereo = false;
    this.dsp_16bit = false;
    this.dsp_signed = false;

    this.dac_buffers[0].clear();
    this.dac_buffers[1].clear();

    this.dma_sample_count = 0;
    this.dma_bytes_count = 0;
    this.dma_bytes_left = 0;
    this.dma_bytes_block = 0;
    this.dma_irq = 0;
    this.dma_channel = 0;
    this.dma_autoinit = false;
    this.dma_buffer_uint8.fill(0);
    this.dma_waiting_transfer = false;
    this.dma_paused = false;

    this.e2_value = 0xAA;
    this.e2_count = 0;

    this.sampling_rate = 22050;
    this.bytes_per_sample = 1;

    this.dma_transfer_type = 0;
    this.adpcm_reference = 0;
    this.adpcm_stepsize = 0;
    this.adpcm_haveref = false;

    this.lower_irq(SB_IRQ_8BIT);
    this.irq_triggered.fill(0);

    this.asp_registers.fill(0);
    this.asp_registers[5] = 0x01;
    this.asp_registers[9] = 0xF8;
    this.asp_init_in_progress = false;
};

SB16.prototype.get_state = function()
{
    var state = [];

    // state[0] = this.write_buffer;
    // state[1] = this.read_buffer;
    state[2] = this.read_buffer_lastvalue;

    state[3] = this.command;
    state[4] = this.command_size;

    state[5] = this.mixer_current_address;
    state[6] = this.mixer_registers;

    state[7] = this.dummy_speaker_enabled;
    state[8] = this.test_register;

    state[9] = this.dsp_highspeed;
    state[10] = this.dsp_stereo;
    state[11] = this.dsp_16bit;
    state[12] = this.dsp_signed;

    // state[13] = this.dac_buffers;
    //state[14]

    state[15] = this.dma_sample_count;
    state[16] = this.dma_bytes_count;
    state[17] = this.dma_bytes_left;
    state[18] = this.dma_bytes_block;
    state[19] = this.dma_irq;
    state[20] = this.dma_channel;
    state[21] = this.dma_channel_8bit;
    state[22] = this.dma_channel_16bit;
    state[23] = this.dma_autoinit;
    state[24] = this.dma_buffer_uint8;
    state[25] = this.dma_waiting_transfer;
    state[26] = this.dma_paused;
    state[27] = this.sampling_rate;
    state[28] = this.bytes_per_sample;

    state[29] = this.e2_value;
    state[30] = this.e2_count;

    state[31] = this.asp_registers;

    // state[32] = this.mpu_read_buffer;
    state[33] = this.mpu_read_buffer_last_value;

    state[34] = this.irq;
    state[35] = this.irq_triggered;
    state[36] = this.dma_adc_left;

    return state;
};

SB16.prototype.set_state = function(state)
{
    // this.write_buffer = state[0];
    // this.read_buffer = state[1];
    this.read_buffer_lastvalue = state[2];

    this.command = state[3];
    this.command_size = state[4];

    this.mixer_current_address = state[5];
    this.mixer_registers = state[6];
    this.mixer_full_update();

    this.dummy_speaker_enabled = state[7];
    this.test_register = state[8];

    this.dsp_highspeed = state[9];
    this.dsp_stereo = state[10];
    this.dsp_16bit = state[11];
    this.dsp_signed = state[12];

    // this.dac_buffers = state[13];
    //state[14]

    this.dma_sample_count = state[15];
    this.dma_bytes_count = state[16];
    this.dma_bytes_left = state[17];
    this.dma_bytes_block = state[18];
    this.dma_irq = state[19];
    this.dma_channel = state[20];
    this.dma_channel_8bit = state[21];
    this.dma_channel_16bit = state[22];
    this.dma_autoinit = state[23];
    this.dma_buffer_uint8 = state[24];
    this.dma_waiting_transfer = state[25];
    this.dma_paused = state[26];
    this.sampling_rate = state[27];
    this.bytes_per_sample = state[28];

    this.e2_value = state[29];
    this.e2_count = state[30];

    this.asp_registers = state[31];

    // this.mpu_read_buffer = state[32];
    this.mpu_read_buffer_last_value = state[33];

    this.irq = state[34];
    this.irq_triggered = state[35];
    this.dma_adc_left = state[36] || 0;

    this.dma_buffer = this.dma_buffer_uint8.buffer;
    this.dma_buffer_int8 = new Int8Array(this.dma_buffer);
    this.dma_buffer_int16 = new Int16Array(this.dma_buffer);
    this.dma_buffer_uint16 = new Uint16Array(this.dma_buffer);
    this.dma_syncbuffer = new SyncBuffer(this.dma_buffer);

    if(this.dma_paused)
    {
        this.bus.send("dac-disable");
    }
    else
    {
        this.bus.send("dac-enable");
    }
};

//
// I/O handlers
//

SB16.prototype.port2x0_read = function()
{
    dbg_log("220 read: fm music status port", LOG_SB16);
    // Decrement timer counters on each status read
    if(this.fm_timer1_counter > 0)
    {
        this.fm_timer1_counter--;
        if(this.fm_timer1_counter === 0) this.fm_timer1_expired = true;
    }
    if(this.fm_timer2_counter > 0)
    {
        this.fm_timer2_counter--;
        if(this.fm_timer2_counter === 0) this.fm_timer2_expired = true;
    }
    // OPL status register: bit 7 = IRQ, bit 6 = Timer 1, bit 5 = Timer 2
    var status = 0;
    if(this.fm_timer1_expired) status |= 0xC0;
    if(this.fm_timer2_expired) status |= 0xA0;
    return status;
};

SB16.prototype.port2x1_read = function()
{
    dbg_log("221 read: fm music data port (write only)", LOG_SB16);
    return 0xFF;
};

SB16.prototype.port2x2_read = function()
{
    dbg_log("222 read: advanced fm music status port (OPL3 bank1)", LOG_SB16);
    // OPL3 (YMF262): bank-1 address port read returns 0x00.
    // Bits 1-2 are always LOW on OPL3 (vs HIGH on OPL2), used for chip detection.
    // verified on real YMF262 hardware.
    return 0x00;
};

SB16.prototype.port2x3_read = function()
{
    dbg_log("223 read: advanced music data port (write only)", LOG_SB16);
    return 0xFF;
};

// Mixer Address Port.
SB16.prototype.port2x4_read = function()
{
    dbg_log("224 read: mixer address port", LOG_SB16);
    return this.mixer_current_address;
};

// Mixer Data Port.
SB16.prototype.port2x5_read = function()
{
    dbg_log("225 read: mixer data port", LOG_SB16);
    return this.mixer_read(this.mixer_current_address);
};

SB16.prototype.port2x6_read = function()
{
    dbg_log("226 read: (write only)", LOG_SB16);
    return 0xFF;
};

SB16.prototype.port2x7_read = function()
{
    dbg_log("227 read: undocumented", LOG_SB16);
    return 0xFF;
};

SB16.prototype.port2x8_read = function()
{
    dbg_log("228 read: fm music status port (OPL2 AdLib compat)", LOG_SB16);
    // 0x228 is the OPL2-compatible status port on SB16 (base+8).
    // DOSBox adlib.cpp: PortRead, MODE_OPL3, port & 3 == 0 => chip[0].Read().
    // Shares the same timer state as 0x220.
    return this.port2x0_read();
};

SB16.prototype.port2x9_read = function()
{
    dbg_log("229 read: fm music data port (write only)", LOG_SB16);
    return 0xFF;
};

// Read Data.
// Used to access in-bound DSP data.
SB16.prototype.port2xA_read = function()
{
    dbg_log("22A read: read data", LOG_SB16);
    if(this.read_buffer.length)
    {
        this.read_buffer_lastvalue = this.read_buffer.shift();
    }
    dbg_log(" <- " + this.read_buffer_lastvalue + " " + h(this.read_buffer_lastvalue) + " '" + String.fromCharCode(this.read_buffer_lastvalue) + "'", LOG_SB16);
    return this.read_buffer_lastvalue;
};

SB16.prototype.port2xB_read = function()
{
    dbg_log("22B read: undocumented", LOG_SB16);
    return 0xFF;
};

// Write-Buffer Status.
// Indicates whether the DSP is ready to accept commands or data.
SB16.prototype.port2xC_read = function()
{
    dbg_log("22C read: write-buffer status", LOG_SB16);
    // Always return ready (bit-7 set to low)
    return 0x7F;
};

SB16.prototype.port2xD_read = function()
{
    dbg_log("22D read: undocumented", LOG_SB16);
    return 0xFF;
};

// Read-Buffer Status.
// Indicates whether there is any in-bound data available for reading.
// Also used to acknowledge DSP 8-bit interrupt.
SB16.prototype.port2xE_read = function()
{
    dbg_log("22E read: read-buffer status / irq 8bit ack.", LOG_SB16);
    if(this.irq_triggered[SB_IRQ_8BIT])
    {
        this.lower_irq(SB_IRQ_8BIT);
    }
    var ready = this.read_buffer.length && !this.dsp_highspeed;
    return (ready << 7) | 0x7F;
};

// DSP 16-bit interrupt acknowledgement.
SB16.prototype.port2xF_read = function()
{
    dbg_log("22F read: irq 16bit ack", LOG_SB16);
    this.lower_irq(SB_IRQ_16BIT);
    return 0;
};


// FM Address Port - primary register.
SB16.prototype.port2x0_write = function(value)
{
    dbg_log("220 write: fm register 0 address = " + h(value), LOG_SB16);
    this.fm_current_address0 = value;
};

// FM Data Port - primary register.
SB16.prototype.port2x1_write = function(value)
{
    dbg_log("221 write: (unimplemented) fm register 0 data = " + h(value), LOG_SB16);
    var handler = FM_HANDLERS[this.fm_current_address0];
    if(!handler)
    {
        handler = this.fm_default_write;
    }
    handler.call(this, value, 0, this.fm_current_address0);
};

// FM Address Port - secondary register.
SB16.prototype.port2x2_write = function(value)
{
    dbg_log("222 write: fm register 1 address = " + h(value), LOG_SB16);
    this.fm_current_address1 = value;
};

// FM Data Port - secondary register.
SB16.prototype.port2x3_write = function(value)
{
    dbg_log("223 write: (unimplemented) fm register 1 data =" + h(value), LOG_SB16);
    var handler = FM_HANDLERS[this.fm_current_address1];
    if(!handler)
    {
        handler = this.fm_default_write;
    }
    handler.call(this, value, 1, this.fm_current_address1);
};

// Mixer Address Port.
SB16.prototype.port2x4_write = function(value)
{
    dbg_log("224 write: mixer address = " + h(value), LOG_SB16);
    this.mixer_current_address = value;
};

// Mixer Data Port.
SB16.prototype.port2x5_write = function(value)
{
    dbg_log("225 write: mixer data = " + h(value), LOG_SB16);
    this.mixer_write(this.mixer_current_address, value);
};

// Reset.
// Used to reset the DSP to its default state and to exit highspeed mode.
SB16.prototype.port2x6_write = function(yesplease)
{
    dbg_log("226 write: reset = " + h(yesplease), LOG_SB16);

    if(this.dsp_highspeed)
    {
        dbg_log(" -> exit highspeed", LOG_SB16);
        this.dsp_highspeed = false;
    }
    else if(yesplease)
    {
        dbg_log(" -> reset", LOG_SB16);
        this.dsp_reset();
    }

    // Signal completion.
    this.read_buffer.clear();
    this.read_buffer.push(0xAA);
};

SB16.prototype.port2x7_write = function(value)
{
    dbg_log("227 write: undocumented", LOG_SB16);
};

SB16.prototype.port2x8_write = function(value)
{
    // OPL2 AdLib compatible address register (base+8), mirrors bank-0 address.
    // DOSBox adlib.cpp PortWrite: reg.normal = handler->WriteAddr(port, val) & 0xff
    dbg_log("228 write: fm register 0 address (AdLib compat) = " + h(value), LOG_SB16);
    this.fm_current_address0 = value;
};

SB16.prototype.port2x9_write = function(value)
{
    // OPL2 AdLib compatible data register (base+9), mirrors bank-0 data.
    // DOSBox adlib.cpp PortWrite: handler->WriteReg(reg.normal, val)
    dbg_log("229 write: fm register 0 data (AdLib compat) = " + h(value), LOG_SB16);
    var handler = FM_HANDLERS[this.fm_current_address0];
    if(!handler)
    {
        handler = this.fm_default_write;
    }
    handler.call(this, value, 0, this.fm_current_address0);
};

SB16.prototype.port2xA_write = function(value)
{
    dbg_log("22A write: dsp read data port (read only)", LOG_SB16);
};

SB16.prototype.port2xB_write = function(value)
{
    dbg_log("22B write: undocumented", LOG_SB16);
};

// Write Command/Data.
// Used to send commands or data to the DSP.
SB16.prototype.port2xC_write = function(value)
{
    dbg_log("22C write: write command/data", LOG_SB16);

    if(this.command === DSP_NO_COMMAND)
    {
        // New command.
        dbg_log("22C write: command = " + h(value), LOG_SB16);
        this.command = value;
        this.write_buffer.clear();
        this.command_size = DSP_COMMAND_SIZES[value];
    }
    else
    {
        // More data for current command.
        dbg_log("22C write: data: " + h(value), LOG_SB16);
        this.write_buffer.push(value);
    }

    // Perform command when we have all the needed data.
    if(this.write_buffer.length >= this.command_size)
    {
        this.command_do();
    }
};

SB16.prototype.port2xD_write = function(value)
{
    dbg_log("22D write: undocumented", LOG_SB16);
};

SB16.prototype.port2xE_write = function(value)
{
    dbg_log("22E write: dsp read buffer status (read only)", LOG_SB16);
};

SB16.prototype.port2xF_write = function(value)
{
    dbg_log("22F write: undocumented", LOG_SB16);
};


// MPU UART Mode - Data Port
SB16.prototype.port3x0_read = function()
{
    dbg_log("330 read: mpu data", LOG_SB16);

    if(this.mpu_read_buffer.length)
    {
        this.mpu_read_buffer_lastvalue = this.mpu_read_buffer.shift();
    }
    dbg_log(" <- " + h(this.mpu_read_buffer_lastvalue), LOG_SB16);

    return this.mpu_read_buffer_lastvalue;
};
SB16.prototype.port3x0_write = function(value)
{
    dbg_log("330 write: mpu data " + h(value), LOG_SB16);
    // MIDI data discarded (no external MIDI output supported).
};

// MPU UART Mode - Status Port
SB16.prototype.port3x1_read = function()
{
    dbg_log("331 read: mpu status", LOG_SB16);

    // Bits 0-5 always set per hardware spec.
    // Bit 6: 0 = output ready, 1 = not ready.
    // Bit 7: 0 = input data available, 1 = no data.
    var status = 0x3F;
    status |= 0x80 * !this.mpu_read_buffer.length;
    return status;
};

// MPU UART Mode - Command Port
SB16.prototype.port3x1_write = function(value)
{
    dbg_log("331 write: mpu command: " + h(value), LOG_SB16);
    if(value === 0xFF)
    {
        // Reset: clear buffer, send ACK.
        this.mpu_read_buffer.clear();
        this.mpu_uart_mode = false;
        this.mpu_read_buffer.push(0xFE);
    }
    else if(value === 0x3F)
    {
        // Switch to UART mode (most programs use this).
        this.mpu_uart_mode = true;
        this.mpu_read_buffer.push(0xFE);
    }
    else
    {
        // Send ACK for any other command to avoid hanging programs.
        this.mpu_read_buffer.push(0xFE);
    }
};

//
// DSP command handlers
//

SB16.prototype.command_do = function()
{
    var handler = DSP_COMMAND_HANDLERS[this.command];
    if(!handler)
    {
        handler = this.dsp_default_handler;
    }
    handler.call(this);

    // Reset Inputs.
    this.command = DSP_NO_COMMAND;
    this.command_size = 0;
    this.write_buffer.clear();
};

SB16.prototype.dsp_default_handler = function()
{
    dbg_log("Unhandled command: " + h(this.command), LOG_SB16);
};

/**
 * @param {Array} commands
 * @param {number} size
 * @param {function()=} handler
 */
function register_dsp_command(commands, size, handler)
{
    if(!handler)
    {
        handler = SB16.prototype.dsp_default_handler;
    }
    for(var i = 0; i < commands.length; i++)
    {
        DSP_COMMAND_SIZES[commands[i]] = size;
        DSP_COMMAND_HANDLERS[commands[i]] = handler;
    }
}

function any_first_digit(base)
{
    var commands = [];
    for(var i = 0; i < 16; i++)
    {
        commands.push(base + i);
    }
    return commands;
}

// SB16 ASP set mode register.
// Controls whether the ASP chip initialisation sequence is in progress.
register_dsp_command([0x04], 1, function()
{
    var data = this.write_buffer.shift();
    this.asp_init_in_progress = (data & 0xF1) === 0xF1;
    dbg_log("DSP 0x04: ASP set mode register 0x" + h(data), LOG_SB16);
});

// SB16 ASP set codec parameter (no-op, as in DOSBox).
register_dsp_command([0x05], 2, function()
{
    this.write_buffer.shift();
    this.write_buffer.shift();
    dbg_log("DSP 0x05: ASP set codec parameter (unimplemented)", LOG_SB16);
});

// SB16 ASP get version.
// Sub-command 0x03 returns version ID 0x18 (as in DOSBox).
register_dsp_command([0x08], 1, function()
{
    var sub = this.write_buffer.shift();
    dbg_log("DSP 0x08: ASP get version sub=0x" + h(sub), LOG_SB16);
    if(sub === 0x03)
    {
        this.read_buffer.clear();
        this.read_buffer.push(0x18);
    }
});

// ASP set register
register_dsp_command([0x0E], 2, function()
{
    this.asp_registers[this.write_buffer.shift()] = this.write_buffer.shift();
});

// ASP get register
// When initialisation is in progress, reading register 0x83 toggles its value (DOSBox behaviour).
register_dsp_command([0x0F], 1, function()
{
    var reg = this.write_buffer.shift();
    if(this.asp_init_in_progress && reg === 0x83)
    {
        this.asp_registers[0x83] = (~this.asp_registers[0x83]) & 0xFF;
    }
    this.read_buffer.clear();
    this.read_buffer.push(this.asp_registers[reg]);
});

// 8-bit direct mode single byte digitized sound output.
register_dsp_command([0x10], 1, function()
{
    var value = audio_normalize(this.write_buffer.shift(), 127.5, -1);

    this.dac_buffers[0].push(value);
    this.dac_buffers[1].push(value);
    this.bus.send("dac-enable");
});

// 8-bit single-cycle DMA mode digitized sound output.
register_dsp_command([0x14, 0x15], 2, function()
{
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = false;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dsp_highspeed = false;
    this.dma_transfer_type = 0;
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Creative 8-bit to 2-bit ADPCM single-cycle DMA mode digitized sound output.
register_dsp_command([0x16], 2, function()
{
    this.adpcm_haveref = false;
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = false;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dma_transfer_type = 2;
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Creative 8-bit to 2-bit ADPCM single-cycle DMA mode digitized sound output
// with reference byte.
register_dsp_command([0x17], 2, function()
{
    this.adpcm_haveref = true;
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = false;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dma_transfer_type = 2;
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// 8-bit auto-init DMA mode digitized sound output.
register_dsp_command([0x1C], 0, function()
{
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = true;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dsp_highspeed = false;
    this.dma_transfer_type = 0;
    this.dma_transfer_start();
});

// Creative 8-bit to 2-bit ADPCM auto-init DMA mode digitized sound output
// with reference byte.
register_dsp_command([0x1F], 0, function()
{
    this.adpcm_haveref = true;
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = true;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dma_transfer_type = 2;
    this.dma_transfer_start();
});

// 8-bit direct mode single byte digitized sound input.
register_dsp_command([0x20], 0, function()
{
    // Fake silent input.
    this.read_buffer.clear();
    this.read_buffer.push(0x7f);
});

// 8-bit single-cycle DMA mode digitized sound input.
// Faked: fills the DMA buffer with silence (0x80) then raises the 8-bit IRQ.
// Mirrors DOSBox DSP_ADC_CallBack: wait for the DMA8 channel to be unmasked,
// then write 0x80 for dma.left bytes and fire SB_IRQ_8.
register_dsp_command([0x24], 2, function()
{
    var low = this.write_buffer.shift();
    var high = this.write_buffer.shift();
    this.dma_adc_left = 1 + low + (high << 8);
    dbg_log("DSP 0x24: Faked 8-bit DMA ADC for " + this.dma_adc_left + " bytes", LOG_SB16);
    if(!this.dma.channel_mask[this.dma_channel_8bit])
    {
        // DMA channel already unmasked — transfer immediately.
        this.dma_adc_do_transfer();
    }
    // else: dma_on_unmask fires dma_adc_do_transfer when the channel is unmasked.
});

// 8-bit auto-init DMA mode digitized sound input.
// DOSBox logs "DSP:Unimplemented input command" and does nothing; same here.
register_dsp_command([0x2C], 0, function()
{
    dbg_log("DSP 0x2C: Unimplemented input command", LOG_SB16);
});

// Polling mode MIDI input.
register_dsp_command([0x30], 0);

// Interrupt mode MIDI input.
register_dsp_command([0x31], 0);

// UART polling mode MIDI I/O.
register_dsp_command([0x34], 0);

// UART interrupt mode MIDI I/O.
register_dsp_command([0x35], 0);

// UART polling mode MIDI I/O with time stamping.
register_dsp_command([0x36], 0);

// UART interrupt mode MIDI I/O with time stamping.
register_dsp_command([0x37], 0);

// MIDI output single byte.
// DOSBox: MIDI_RawOutByte(data) when sb.midi == true.
// TODO: implement real MIDI output via Web MIDI API (navigator.requestMIDIAccess)
// — skipped to avoid the permission popup and because Web MIDI is not universally
// available. Data is silently discarded.
register_dsp_command([0x38], 1, function()
{
    this.write_buffer.shift();
    dbg_log("DSP 0x38: MIDI output byte discarded (no MIDI support)", LOG_SB16);
});

// Set digitized sound transfer Time Constant.
register_dsp_command([0x40], 1, function()
{
    // Note: bTimeConstant = 256 * time constant
    this.sampling_rate_change(
        1000000 / (256 - this.write_buffer.shift()) / this.get_channel_count()
    );
});

// Set digitized sound output sampling rate.
// Set digitized sound input sampling rate.
register_dsp_command([0x41, 0x42], 2, function()
{
    this.sampling_rate_change((this.write_buffer.shift() << 8) | this.write_buffer.shift());
});

// Set DSP block transfer size.
register_dsp_command([0x48], 2, function()
{
    // TODO: should be in bytes, but if this is only used
    // for 8 bit transfers, then this number is the same
    // as number of samples?
    // Wrong: e.g. stereo requires two bytes per sample.
    this.dma_transfer_size_set();
});

// Creative 8-bit to 4-bit ADPCM single-cycle DMA mode digitized sound output.
register_dsp_command([0x74], 2, function()
{
    this.adpcm_haveref = false;
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = false;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dma_transfer_type = 4;
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Creative 8-bit to 4-bit ADPCM single-cycle DMA mode digitized sound output
// with reference byte.
register_dsp_command([0x75], 2, function()
{
    this.adpcm_haveref = true;
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = false;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dma_transfer_type = 4;
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Creative 8-bit to 3-bit ADPCM single-cycle DMA mode digitized sound output.
register_dsp_command([0x76], 2, function()
{
    this.adpcm_haveref = false;
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = false;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dma_transfer_type = 3;
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Creative 8-bit to 3-bit ADPCM single-cycle DMA mode digitized sound output
// with reference byte.
register_dsp_command([0x77], 2, function()
{
    this.adpcm_haveref = true;
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = false;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dma_transfer_type = 3;
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Creative 8-bit to 4-bit ADPCM auto-init DMA mode digitized sound output
// with reference byte.
register_dsp_command([0x7D], 0, function()
{
    this.adpcm_haveref = true;
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = true;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dma_transfer_type = 4;
    this.dma_transfer_start();
});

// Creative 8-bit to 3-bit ADPCM auto-init DMA mode digitized sound output
// with reference byte.
register_dsp_command([0x7F], 0, function()
{
    this.adpcm_haveref = true;
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = true;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dma_transfer_type = 3;
    this.dma_transfer_start();
});

// Pause DAC for a duration.
// Raises the 8-bit IRQ after the silence period expires, matching DOSBox behaviour.
register_dsp_command([0x80], 2, function()
{
    var low = this.write_buffer.shift();
    var high = this.write_buffer.shift();
    var count = 1 + low + (high << 8);
    var delay_ms = count * 1000 / this.sampling_rate;
    dbg_log("DSP 0x80: Silence DAC for " + count + " samples (" + delay_ms.toFixed(2) + " ms)", LOG_SB16);
    setTimeout(() => { this.raise_irq(SB_IRQ_8BIT); }, delay_ms);
});

// 8-bit high-speed auto-init DMA mode digitized sound output.
register_dsp_command([0x90], 0, function()
{
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = true;
    this.dsp_signed = false;
    this.dsp_highspeed = true;
    this.dsp_16bit = false;
    this.dma_transfer_type = 0;
    this.dma_transfer_start();
});

// 8-bit high-speed single-cycle DMA mode digitized sound input.
register_dsp_command([0x91], 0);

// 8-bit high-speed auto-init DMA mode digitized sound input.
register_dsp_command([0x98], 0);

// 8-bit high-speed single-cycle DMA mode digitized sound input.
register_dsp_command([0x99], 0);

// Set input mode to mono.
register_dsp_command([0xA0], 0);

// Set input mode to stereo.
register_dsp_command([0xA8], 0);

// Program 16-bit DMA mode digitized sound I/O.
register_dsp_command(any_first_digit(0xB0), 3, function()
{
    if(this.command & (1 << 3))
    {
        // Analogue to digital not implemented.
        this.dsp_default_handler();
        return;
    }
    var mode = this.write_buffer.shift();
    this.dma_irq = SB_IRQ_16BIT;
    this.dma_channel = this.dma_channel_16bit;
    this.dma_autoinit = !!(this.command & (1 << 2));
    this.dsp_signed = !!(mode & (1 << 4));
    this.dsp_stereo = !!(mode & (1 << 5));
    this.dsp_16bit = true;
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Program 8-bit DMA mode digitized sound I/O.
register_dsp_command(any_first_digit(0xC0), 3, function()
{
    if(this.command & (1 << 3))
    {
        // Analogue to digital not implemented.
        this.dsp_default_handler();
        return;
    }
    var mode = this.write_buffer.shift();
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = !!(this.command & (1 << 2));
    this.dsp_signed = !!(mode & (1 << 4));
    this.dsp_stereo = !!(mode & (1 << 5));
    this.dsp_16bit = false;
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Pause 8-bit DMA mode digitized sound I/O.
register_dsp_command([0xD0], 0, function()
{
    this.dma_paused = true;
    this.bus.send("dac-disable");
});

// Turn on speaker.
// Documented to have no effect on SB16.
register_dsp_command([0xD1], 0, function()
{
    this.dummy_speaker_enabled = true;
});

// Turn off speaker.
// Documented to have no effect on SB16.
register_dsp_command([0xD3], 0, function()
{
    this.dummy_speaker_enabled = false;
});

// Continue 8-bit DMA mode digitized sound I/O.
register_dsp_command([0xD4], 0, function()
{
    this.dma_paused = false;
    this.bus.send("dac-enable");
});

// Pause 16-bit DMA mode digitized sound I/O.
register_dsp_command([0xD5], 0, function()
{
    this.dma_paused = true;
    this.bus.send("dac-disable");
});

// Continue 16-bit DMA mode digitized sound I/O.
register_dsp_command([0xD6], 0, function()
{
    this.dma_paused = false;
    this.bus.send("dac-enable");
});

// Get speaker status.
register_dsp_command([0xD8], 0, function()
{
    this.read_buffer.clear();
    this.read_buffer.push(this.dummy_speaker_enabled * 0xFF);
});

// Exit 16-bit auto-init DMA mode digitized sound I/O.
// Exit 8-bit auto-init mode digitized sound I/O.
register_dsp_command([0xD9, 0xDA], 0, function()
{
    this.dma_autoinit = false;
});

// DSP identification
register_dsp_command([0xE0], 1, function()
{
    this.read_buffer.clear();
    this.read_buffer.push(~this.write_buffer.shift());
});

// Get DSP version number.
register_dsp_command([0xE1], 0, function()
{
    this.read_buffer.clear();
    this.read_buffer.push(4);
    this.read_buffer.push(5);
});

// DMA identification.
register_dsp_command([0xE2], 1);

// Get DSP copyright.
register_dsp_command([0xE3], 0, function()
{
    this.read_buffer.clear();
    for(var i = 0; i < DSP_COPYRIGHT.length; i++)
    {
        this.read_buffer.push(DSP_COPYRIGHT.charCodeAt(i));
    }
    // Null terminator.
    this.read_buffer.push(0);
});

// Write test register.
register_dsp_command([0xE4], 1, function()
{
    this.test_register = this.write_buffer.shift();
});

// Read test register.
register_dsp_command([0xE8], 0, function()
{
    this.read_buffer.clear();
    this.read_buffer.push(this.test_register);
});

// Trigger IRQ
register_dsp_command([0xF2, 0xF3], 0, function()
{
    this.raise_irq();
});

// Undocumented pre-SB16 command: returns 0x00 (matches DOSBox).
register_dsp_command([0xF8], 0, function()
{
    this.read_buffer.clear();
    this.read_buffer.push(0x00);
});

// ASP - unknown function
var SB_F9 = new Uint8Array(256);
SB_F9[0x0E] = 0xFF;
SB_F9[0x0F] = 0x07;
SB_F9[0x37] = 0x38;
register_dsp_command([0xF9], 1, function()
{
    var input = this.write_buffer.shift();
    dbg_log("dsp 0xf9: unknown function. input: " + input, LOG_SB16);

    this.read_buffer.clear();
    this.read_buffer.push(SB_F9[input]);
});

//
// Mixer Handlers (CT1745)
//

SB16.prototype.mixer_read = function(address)
{
    var handler = MIXER_READ_HANDLERS[address];
    var data;
    if(handler)
    {
        data = handler.call(this);
    }
    else
    {
        data = this.mixer_registers[address];
        dbg_log("unhandled mixer register read. addr:" + h(address) + " data:" + h(data), LOG_SB16);
    }
    return data;
};

SB16.prototype.mixer_write = function(address, data)
{
    var handler = MIXER_WRITE_HANDLERS[address];
    if(handler)
    {
        handler.call(this, data);
    }
    else
    {
        dbg_log("unhandled mixer register write. addr:" + h(address) + " data:" + h(data), LOG_SB16);
    }
};

SB16.prototype.mixer_default_read = function()
{
    dbg_log("mixer register read. addr:" + h(this.mixer_current_address), LOG_SB16);
    return this.mixer_registers[this.mixer_current_address];
};

SB16.prototype.mixer_default_write = function(data)
{
    dbg_log("mixer register write. addr:" + h(this.mixer_current_address) + " data:" + h(data), LOG_SB16);
    this.mixer_registers[this.mixer_current_address] = data;
};

SB16.prototype.mixer_reset = function()
{
    // Values intentionally in decimal.
    // Default values available at
    // https://pdos.csail.mit.edu/6.828/2011/readings/hardware/SoundBlaster.pdf
    this.mixer_registers[0x04] = 12 << 4 | 12;
    this.mixer_registers[0x22] = 12 << 4 | 12;
    this.mixer_registers[0x26] = 12 << 4 | 12;
    this.mixer_registers[0x28] = 0;
    this.mixer_registers[0x2E] = 0;
    // 0x0A and 0x3A share the same internal mic field (mixer_registers[0x3A] stores 0-31 raw value)
    // DOSBox CTMIXER_Reset() does NOT reset mic, so we leave it as-is during reset.
    this.mixer_registers[0x30] = 31 << 3;
    this.mixer_registers[0x31] = 31 << 3;
    this.mixer_registers[0x32] = 31 << 3;
    this.mixer_registers[0x33] = 31 << 3;
    this.mixer_registers[0x34] = 31 << 3;
    this.mixer_registers[0x35] = 31 << 3;
    this.mixer_registers[0x36] = 0;
    this.mixer_registers[0x37] = 0;
    this.mixer_registers[0x38] = 0;
    this.mixer_registers[0x39] = 0;
    this.mixer_registers[0x3A] = 0;
    this.mixer_registers[0x3B] = 0;
    this.mixer_registers[0x3C] = 0x1F;
    this.mixer_registers[0x3D] = 0x15;
    this.mixer_registers[0x3E] = 0x0B;
    this.mixer_registers[0x3F] = 0;
    this.mixer_registers[0x40] = 0;
    this.mixer_registers[0x41] = 0;
    this.mixer_registers[0x42] = 0;
    this.mixer_registers[0x43] = 0;
    this.mixer_registers[0x44] = 8 << 4;
    this.mixer_registers[0x45] = 8 << 4;
    this.mixer_registers[0x46] = 8 << 4;
    this.mixer_registers[0x47] = 8 << 4;

    this.mixer_full_update();
};

SB16.prototype.mixer_full_update = function()
{
    // Start at 1. Don't re-reset.
    for(var i = 1; i < this.mixer_registers.length; i++)
    {
        if(MIXER_REGISTER_IS_LEGACY[i])
        {
            // Legacy registers are actually mapped to other register locations. Update
            // using the new registers rather than the legacy registers.
            continue;
        }
        this.mixer_write(i, this.mixer_registers[i]);
    }
};

/**
 * @param{number} address
 * @param{function():number=} handler
 */
function register_mixer_read(address, handler)
{
    if(!handler)
    {
        handler = SB16.prototype.mixer_default_read;
    }
    MIXER_READ_HANDLERS[address] = handler;
}

/**
 * @param{number} address
 * @param{function(number)=} handler
 */
function register_mixer_write(address, handler)
{
    if(!handler)
    {
        handler = SB16.prototype.mixer_default_write;
    }
    MIXER_WRITE_HANDLERS[address] = handler;
}

// Legacy registers map each nibble to the last 4 bits of the new registers
function register_mixer_legacy(address_old, address_new_left, address_new_right)
{
    MIXER_REGISTER_IS_LEGACY[address_old] = 1;

    /** @this {SB16} */
    MIXER_READ_HANDLERS[address_old] = function()
    {
        var left = this.mixer_registers[address_new_left] & 0xF0;
        var right = this.mixer_registers[address_new_right] >>> 4;
        return left | right;
    };

    /** @this {SB16} */
    MIXER_WRITE_HANDLERS[address_old] = function(data)
    {
        this.mixer_registers[address_old] = data;
        var prev_left = this.mixer_registers[address_new_left];
        var prev_right = this.mixer_registers[address_new_right];
        var left = (data & 0xF0) | (prev_left & 0x0F);
        var right = (data << 4 & 0xF0) | (prev_right & 0x0F);

        this.mixer_write(address_new_left, left);
        this.mixer_write(address_new_right, right);
    };
}

/**
 * @param {number} address
 * @param {number} mixer_source
 * @param {number} channel
 */
function register_mixer_volume(address, mixer_source, channel)
{
    MIXER_READ_HANDLERS[address] = SB16.prototype.mixer_default_read;

    /** @this {SB16} */
    MIXER_WRITE_HANDLERS[address] = function(data)
    {
        this.mixer_registers[address] = data;
        // Volume formula: amount = data>>3, count = 31-amount, db = count*2 - (count>20?1:0)
        var amount = data >>> 3;
        var count = 31 - amount;
        var db = count * 2 - (count > 20 ? 1 : 0);
        this.bus.send("mixer-volume",
        [
            mixer_source,
            channel,
            -db
        ]);
    };
}

// Reset.
register_mixer_read(0x00, function()
{
    this.mixer_reset();
    return 0;
});
register_mixer_write(0x00);

// Legacy Voice Volume Left/Right.
register_mixer_legacy(0x04, 0x32, 0x33);

// Mic Level (SBPro, 3-bit at bits 2:0; SB16 uses 3-bit too but shares storage with 0x3A).
// DOSBox: mic = (val & 0x7)<<2 | 1 [SB16]; read: (mic>>2) & 7.
// mixer_registers[0x3A] stores the raw 5-bit mic value (same as DOSBox sb.mixer.mic).
register_mixer_read(0x0A, function()
{
    return (this.mixer_registers[0x3A] >> 2) & 7;
});
register_mixer_write(0x0A, function(data)
{
    // SB16 mode: mic = (val & 0x7)<<2 | 1  (low bit = 1 for SB16, 3 for SBPro)
    this.mixer_registers[0x3A] = ((data & 0x7) << 2) | 1;
});

// Stereo/Filter Select (SBPro). Bit 1 = stereo output; bit 5 = filter (not applied in v86).
// On SB16 stereo is set per-command, but this register is honoured for SBPro compatibility.
// DOSBox: stereo=(val&0x2)>0; filtered=(val&0x20)>0; read: 0x11|(stereo?0x02:0)|(filtered?0x20:0).
register_mixer_read(0x0E, function()
{
    return 0x11 | (this.dsp_stereo ? 0x02 : 0x00) | (this.mixer_registers[0x0E] & 0x20);
});
register_mixer_write(0x0E, function(data)
{
    this.mixer_registers[0x0E] = data;
    this.dsp_stereo = (data & 0x02) !== 0;
});

// Legacy Master Volume Left/Right.
register_mixer_legacy(0x22, 0x30, 0x31);
// Legacy Midi Volume Left/Right.
register_mixer_legacy(0x26, 0x34, 0x35);
// Legacy CD Volume Left/Right.
register_mixer_legacy(0x28, 0x36, 0x37);
// Legacy Line Volume Left/Right.
register_mixer_legacy(0x2E, 0x38, 0x39);

// Master Volume Left.
register_mixer_volume(0x30, MIXER_SRC_MASTER, MIXER_CHANNEL_LEFT);
// Master Volume Right.
register_mixer_volume(0x31, MIXER_SRC_MASTER, MIXER_CHANNEL_RIGHT);
// Voice Volume Left.
register_mixer_volume(0x32, MIXER_SRC_DAC, MIXER_CHANNEL_LEFT);
// Voice Volume Right.
register_mixer_volume(0x33, MIXER_SRC_DAC, MIXER_CHANNEL_RIGHT);
// MIDI/FM Volume Left.
register_mixer_volume(0x34, MIXER_SRC_OPL, MIXER_CHANNEL_LEFT);
// MIDI/FM Volume Right.
register_mixer_volume(0x35, MIXER_SRC_OPL, MIXER_CHANNEL_RIGHT);
// CD Volume Left (SB16). Bits 7:3. No CD audio source in v86; stored for read-back.
// DOSBox: cda[0] = val>>3; read: cda[0]<<3 (bits 2:0 always zero).
register_mixer_read(0x36);
register_mixer_write(0x36, function(data)
{
    this.mixer_registers[0x36] = data & 0xF8;
});
// CD Volume Right (SB16). Bits 7:3.
register_mixer_read(0x37);
register_mixer_write(0x37, function(data)
{
    this.mixer_registers[0x37] = data & 0xF8;
});
// Line-in Volume Left (SB16). Bits 7:3. No line-in source in v86; stored for read-back.
// DOSBox: lin[0] = val>>3; read: lin[0]<<3.
register_mixer_read(0x38);
register_mixer_write(0x38, function(data)
{
    this.mixer_registers[0x38] = data & 0xF8;
});
// Line-in Volume Right (SB16). Bits 7:3.
register_mixer_read(0x39);
register_mixer_write(0x39, function(data)
{
    this.mixer_registers[0x39] = data & 0xF8;
});
// Mic Volume (SB16). Bits 7:3. No mic input in v86; stored for read-back.
// DOSBox: mic = val>>3; read: mic<<3.
// mixer_registers[0x3A] stores the raw 5-bit value (same field as 0x0A above).
register_mixer_read(0x3A, function()
{
    return this.mixer_registers[0x3A] << 3;
});
register_mixer_write(0x3A, function(data)
{
    this.mixer_registers[0x3A] = data >> 3;
});

// PC Speaker Volume.
register_mixer_read(0x3B);
register_mixer_write(0x3B, function(data)
{
    this.mixer_registers[0x3B] = data;
    this.bus.send("mixer-volume", [MIXER_SRC_PCSPEAKER, MIXER_CHANNEL_BOTH, (data >>> 6) * 6 - 18]);
});

// Output Mixer Switches (SB16). Bits 4:0: bit0=Mic, bit1=CD-R, bit2=CD-L, bit3=Line-R, bit4=Line-L.
// DOSBox stores to unhandled[0x3C]; v86 has no CD/Line/Mic sources, stored for read-back.
register_mixer_read(0x3C);
register_mixer_write(0x3C, function(data)
{
    this.mixer_registers[0x3C] = data;
});

// Input Mixer Left Switches (SB16). Bits 5:0: bit0=Mic, bit1=CD-R, bit2=CD-L, bit3=Line-R, bit4=Line-L, bit5=MIDI.
// DOSBox stores to unhandled[0x3D]; stored for read-back.
register_mixer_read(0x3D);
register_mixer_write(0x3D, function(data)
{
    this.mixer_registers[0x3D] = data;
});

// Input Mixer Right Switches (SB16). Bits 5:0 (same layout as 0x3D).
register_mixer_read(0x3E);
register_mixer_write(0x3E, function(data)
{
    this.mixer_registers[0x3E] = data;
});

// Input Gain Left (SB16). Bits 7:6: 0=0 dB, 1=+1.5 dB, 2=+3 dB, 3=+4.5 dB.
// DOSBox stores to unhandled[0x3F]; stored for read-back.
register_mixer_read(0x3F);
register_mixer_write(0x3F, function(data)
{
    this.mixer_registers[0x3F] = data;
});

// Input Gain Right (SB16). Bits 7:6.
register_mixer_read(0x40);
register_mixer_write(0x40, function(data)
{
    this.mixer_registers[0x40] = data;
});

// Output Gain Left.
register_mixer_read(0x41);
register_mixer_write(0x41, function(data)
{
    this.mixer_registers[0x41] = data;
    this.bus.send("mixer-gain-left", (data >>> 6) * 6);
});

// Output Gain Right.
register_mixer_read(0x42);
register_mixer_write(0x42, function(data)
{
    this.mixer_registers[0x42] = data;
    this.bus.send("mixer-gain-right", (data >>> 6) * 6);
});

// Mic AGC (SB16). Bit 0: 0 = AGC enabled, 1 = fixed gain.
// DOSBox stores to unhandled[0x43]; stored for read-back.
register_mixer_read(0x43);
register_mixer_write(0x43, function(data)
{
    this.mixer_registers[0x43] = data;
});

// Treble Left.
register_mixer_read(0x44);
register_mixer_write(0x44, function(data)
{
    this.mixer_registers[0x44] = data;
    data >>>= 3;
    this.bus.send("mixer-treble-left", data - (data < 16 ? 14 : 16));
});

// Treble Right.
register_mixer_read(0x45);
register_mixer_write(0x45, function(data)
{
    this.mixer_registers[0x45] = data;
    data >>>= 3;
    this.bus.send("mixer-treble-right", data - (data < 16 ? 14 : 16));
});

// Bass Left.
register_mixer_read(0x46);
register_mixer_write(0x46, function(data)
{
    this.mixer_registers[0x46] = data;
    data >>>= 3;
    this.bus.send("mixer-bass-right", data - (data < 16 ? 14 : 16));
});

// Bass Right.
register_mixer_read(0x47);
register_mixer_write(0x47, function(data)
{
    this.mixer_registers[0x47] = data;
    data >>>= 3;
    this.bus.send("mixer-bass-right", data - (data < 16 ? 14 : 16));
});

// IRQ Select.
register_mixer_read(0x80, function()
{
    switch(this.irq)
    {
        case SB_IRQ2: return 0x1;
        case SB_IRQ5: return 0x2;
        case SB_IRQ7: return 0x4;
        case SB_IRQ10: return 0x8;
        default: return 0x0;
    }
});
register_mixer_write(0x80, function(bits)
{
    if(bits & 0x1) this.irq = SB_IRQ2;
    if(bits & 0x2) this.irq = SB_IRQ5;
    if(bits & 0x4) this.irq = SB_IRQ7;
    if(bits & 0x8) this.irq = SB_IRQ10;
});

// DMA Select.
register_mixer_read(0x81, function()
{
    var ret = 0;
    switch(this.dma_channel_8bit)
    {
        case SB_DMA0: ret |= 0x1; break;
        case SB_DMA1: ret |= 0x2; break;
        // Channel 2 is hardwired to floppy disk.
        case SB_DMA3: ret |= 0x8; break;
    }
    switch(this.dma_channel_16bit)
    {
        // Channel 4 cannot be used.
        case SB_DMA5: ret |= 0x20; break;
        case SB_DMA6: ret |= 0x40; break;
        case SB_DMA7: ret |= 0x80; break;
    }
    return ret;
});
register_mixer_write(0x81, function(bits)
{
    if(bits & 0x1) this.dma_channel_8bit = SB_DMA0;
    if(bits & 0x2) this.dma_channel_8bit = SB_DMA1;
    if(bits & 0x8) this.dma_channel_8bit = SB_DMA3;
    if(bits & 0x20) this.dma_channel_16bit = SB_DMA5;
    if(bits & 0x40) this.dma_channel_16bit = SB_DMA6;
    if(bits & 0x80) this.dma_channel_16bit = SB_DMA7;
});

// IRQ Status.
register_mixer_read(0x82, function()
{
    var ret = 0x20;
    for(var i = 0; i < 16; i++)
    {
        ret |= i * this.irq_triggered[i];
    }
    return ret;
});

//
// FM Handlers
//

SB16.prototype.fm_default_write = function(data, register, address)
{
    dbg_log("unhandled fm register write. addr:" + register + "|" + h(address) + " data:" + h(data), LOG_SB16);
    // No need to save into a dummy register as the registers are write-only.
};

/**
 * @param{Array} addresses
 * @param{function(number, number, number)=} handler
 */
function register_fm_write(addresses, handler)
{
    if(!handler)
    {
        handler = SB16.prototype.fm_default_write;
    }
    for(var i = 0; i < addresses.length; i++)
    {
        FM_HANDLERS[addresses[i]] = handler;
    }
}

function between(start, end)
{
    var a = [];
    for(var i = start; i <= end; i++)
    {
        a.push(i);
    }
    return a;
}

const SB_FM_OPERATORS_BY_OFFSET = new Uint8Array(32);
SB_FM_OPERATORS_BY_OFFSET[0x00] = 0;
SB_FM_OPERATORS_BY_OFFSET[0x01] = 1;
SB_FM_OPERATORS_BY_OFFSET[0x02] = 2;
SB_FM_OPERATORS_BY_OFFSET[0x03] = 3;
SB_FM_OPERATORS_BY_OFFSET[0x04] = 4;
SB_FM_OPERATORS_BY_OFFSET[0x05] = 5;
SB_FM_OPERATORS_BY_OFFSET[0x08] = 6;
SB_FM_OPERATORS_BY_OFFSET[0x09] = 7;
SB_FM_OPERATORS_BY_OFFSET[0x0A] = 8;
SB_FM_OPERATORS_BY_OFFSET[0x0B] = 9;
SB_FM_OPERATORS_BY_OFFSET[0x0C] = 10;
SB_FM_OPERATORS_BY_OFFSET[0x0D] = 11;
SB_FM_OPERATORS_BY_OFFSET[0x10] = 12;
SB_FM_OPERATORS_BY_OFFSET[0x11] = 13;
SB_FM_OPERATORS_BY_OFFSET[0x12] = 14;
SB_FM_OPERATORS_BY_OFFSET[0x13] = 15;
SB_FM_OPERATORS_BY_OFFSET[0x14] = 16;
SB_FM_OPERATORS_BY_OFFSET[0x15] = 17;

function get_fm_operator(register, offset)
{
    return register * 18 + SB_FM_OPERATORS_BY_OFFSET[offset];
}

register_fm_write([0x01], function(bits, register, address)
{
    this.fm_waveform_select_enable[register] = (bits & 0x20) > 0;
    this.bus.send("opl2-reg-write", [address, bits]);
});

// Timer 1 Count.
register_fm_write([0x02]);

// Timer 2 Count.
register_fm_write([0x03]);

register_fm_write([0x04], function(bits, register, address)
{
    switch(register)
    {
        case 0:
            if(bits & 0x80)
            {
                // IRQ Reset / Timer flag reset
                this.fm_timer1_expired = false;
                this.fm_timer2_expired = false;
                this.fm_timer1_counter = -1;
                this.fm_timer2_counter = -1;
            }
            // Timer 1 start (bit 0), masked by bit 6
            if((bits & 0x01) && !(bits & 0x40))
            {
                // Start countdown: expire after ~10 status reads
                this.fm_timer1_counter = 10;
            }
            // Timer 2 start (bit 1), masked by bit 5
            if((bits & 0x02) && !(bits & 0x20))
            {
                // Start countdown: expire after ~40 status reads
                this.fm_timer2_counter = 40;
            }
            break;
        case 1:
            // Four-operator enable
            break;
    }
});

register_fm_write([0x05], function(bits, register, address)
{
    if(register === 0)
    {
        // No registers documented here.
        this.fm_default_write(bits, register, address);
    }
    else
    {
        // OPL3 Mode Enable
    }
});

register_fm_write([0x08], function(bits, register, address)
{
    this.bus.send("opl2-reg-write", [address, bits]);
});

register_fm_write(between(0x20, 0x35), function(bits, register, address)
{
    this.bus.send("opl2-reg-write", [address, bits]);
});

register_fm_write(between(0x40, 0x55), function(bits, register, address)
{
    this.bus.send("opl2-reg-write", [address, bits]);
});

register_fm_write(between(0x60, 0x75), function(bits, register, address)
{
    this.bus.send("opl2-reg-write", [address, bits]);
});

register_fm_write(between(0x80, 0x95), function(bits, register, address)
{
    this.bus.send("opl2-reg-write", [address, bits]);
});

register_fm_write(between(0xA0, 0xA8), function(bits, register, address)
{
    if(register === 0)
    {
        this.bus.send("opl2-reg-write", [address, bits]);
    }
});

register_fm_write(between(0xB0, 0xB8), function(bits, register, address)
{
    if(register === 0)
    {
        this.bus.send("opl2-reg-write", [address, bits]);
    }
});

register_fm_write([0xBD], function(bits, register, address)
{
    this.bus.send("opl2-reg-write", [address, bits]);
});

register_fm_write(between(0xC0, 0xC8), function(bits, register, address)
{
    this.bus.send("opl2-reg-write", [address, bits]);
});

register_fm_write(between(0xE0, 0xF5), function(bits, register, address)
{
    this.bus.send("opl2-reg-write", [address, bits]);
});

//
// FM behaviours
//

SB16.prototype.fm_update_waveforms = function()
{
    // Waveform select enable changed; no action needed for current synthesis.
};

//
// General behaviours
//

SB16.prototype.sampling_rate_change = function(rate)
{
    this.sampling_rate = rate;
    this.bus.send("dac-tell-sampling-rate", rate);
};

SB16.prototype.get_channel_count = function()
{
    return this.dsp_stereo ? 2 : 1;
};

SB16.prototype.dma_transfer_size_set = function()
{
    this.dma_sample_count = 1 + (this.write_buffer.shift() << 0) + (this.write_buffer.shift() << 8);
};

SB16.prototype.dma_transfer_start = function()
{
    dbg_log("begin dma transfer", LOG_SB16);

    // (1) Setup appropriate settings.

    this.bytes_per_sample = 1;
    if(this.dsp_16bit) this.bytes_per_sample *= 2;

    // Don't count stereo interleaved bits apparently.
    // Disabling this line is needed for sounds to work correctly,
    // especially double buffering autoinit mode.
    // Learnt the hard way.
    // if(this.dsp_stereo) this.bytes_per_sample *= 2;

    this.dma_bytes_count = this.dma_sample_count * this.bytes_per_sample;
    this.dma_bytes_block = SB_DMA_BLOCK_SAMPLES * this.bytes_per_sample;

    // Ensure block size is small enough but not too small, and is divisible by 4
    var max_bytes_block = Math.max(this.dma_bytes_count >> 2 & ~0x3, 32);
    this.dma_bytes_block = Math.min(max_bytes_block, this.dma_bytes_block);

    // (2) Wait until channel is unmasked (if not already)
    this.dma_waiting_transfer = true;
    if(!this.dma.channel_mask[this.dma_channel])
    {
        this.dma_on_unmask(this.dma_channel);
    }
};

SB16.prototype.dma_on_unmask = function(channel)
{
    // Handle pending single-cycle ADC transfer (0x24), mirroring DOSBox DSP_ADC_CallBack.
    if(channel === this.dma_channel_8bit && this.dma_adc_left > 0)
    {
        this.dma_adc_do_transfer();
        // ADC and DAC cannot be active simultaneously; skip DAC path.
        return;
    }

    if(channel !== this.dma_channel || !this.dma_waiting_transfer)
    {
        return;
    }

    // (3) Configure amount of bytes left to transfer and tell speaker adapter
    // to start requesting transfers
    this.dma_waiting_transfer = false;
    this.dma_bytes_left = this.dma_bytes_count;
    this.dma_paused = false;
    this.bus.send("dac-enable");
};

// Perform a faked single-cycle ADC DMA transfer: fill memory with silence (0x80)
// for dma_adc_left bytes and raise SB_IRQ_8BIT, matching DOSBox DSP_ADC_CallBack.
SB16.prototype.dma_adc_do_transfer = function()
{
    var left = this.dma_adc_left;
    this.dma_adc_left = 0;
    this.dma_buffer_uint8.fill(0x80, 0, Math.min(left, SB_DMA_BUFSIZE));
    this.dma.do_read(this.dma_syncbuffer, 0, left, this.dma_channel_8bit, (error) =>
    {
        if(!error) this.raise_irq(SB_IRQ_8BIT);
    });
};

SB16.prototype.dma_transfer_next = function()
{
    dbg_log("dma transfering next block", LOG_SB16);

    var size = Math.min(this.dma_bytes_left, this.dma_bytes_block);
    var samples = Math.floor(size / this.bytes_per_sample);

    this.dma.do_write(this.dma_syncbuffer, 0, size, this.dma_channel, (error) =>
    {
        dbg_log("dma block transfer " + (error ? "unsuccessful" : "successful"), LOG_SB16);
        if(error) return;

        this.dma_to_dac(samples);
        this.dma_bytes_left -= size;

        if(!this.dma_bytes_left)
        {
            // Completed requested transfer of given size.
            this.raise_irq(this.dma_irq);

            if(this.dma_autoinit)
            {
                // Restart the transfer.
                this.dma_bytes_left = this.dma_bytes_count;
            }
        }
    });
};

SB16.prototype.dma_to_dac = function(sample_count)
{
    // Route ADPCM modes to dedicated decoder.
    if(this.dma_transfer_type !== 0)
    {
        this.dma_to_dac_adpcm(sample_count);
        return;
    }

    var amplitude = this.dsp_16bit ? 32767.5 : 127.5;
    var offset = this.dsp_signed ? 0 : -1;
    var repeats = this.dsp_stereo ? 1 : 2;

    var buffer;
    if(this.dsp_16bit)
    {
        buffer = this.dsp_signed ? this.dma_buffer_int16 : this.dma_buffer_uint16;
    }
    else
    {
        buffer = this.dsp_signed ? this.dma_buffer_int8 : this.dma_buffer_uint8;
    }

    var channel = 0;
    for(var i = 0; i < sample_count; i++)
    {
        var sample = audio_normalize(buffer[i], amplitude, offset);
        for(var j = 0; j < repeats; j++)
        {
            this.dac_buffers[channel].push(sample);
            channel ^= 1;
        }
    }

    this.dac_send();
};

/**
 * Decode Creative ADPCM compressed DMA data into the DAC buffers.
 * sample_count = number of compressed bytes read from DMA.
 * All ADPCM modes are mono; each compressed byte expands to 2/3/4 PCM samples.
 */
SB16.prototype.dma_to_dac_adpcm = function(byte_count)
{
    var i, b, s;
    var start = 0;

    // Handle reference byte (first byte of a "with reference" transfer).
    if(this.adpcm_haveref && byte_count > 0)
    {
        this.adpcm_haveref = false;
        this.adpcm_reference = this.dma_buffer_uint8[0];
        this.adpcm_stepsize = 0; // MIN_ADAPTIVE_STEP_SIZE = 0
        start = 1;
    }

    if(this.dma_transfer_type === 4)
    {
        // 4-bit ADPCM: each byte → 2 samples (high nybble first).
        for(i = start; i < byte_count; i++)
        {
            b = this.dma_buffer_uint8[i];
            s = audio_normalize(this.decode_adpcm_4(b >> 4), 127.5, -1);
            this.dac_buffers[0].push(s);
            this.dac_buffers[1].push(s);
            s = audio_normalize(this.decode_adpcm_4(b & 0xF), 127.5, -1);
            this.dac_buffers[0].push(s);
            this.dac_buffers[1].push(s);
        }
    }
    else if(this.dma_transfer_type === 3)
    {
        // 3-bit (2.6-bit) ADPCM: each byte → 3 samples.
        // bits [7:5], bits [4:2], then bits [1:0] left-shifted to form 3-bit value.
        for(i = start; i < byte_count; i++)
        {
            b = this.dma_buffer_uint8[i];
            s = audio_normalize(this.decode_adpcm_3((b >> 5) & 0x7), 127.5, -1);
            this.dac_buffers[0].push(s);
            this.dac_buffers[1].push(s);
            s = audio_normalize(this.decode_adpcm_3((b >> 2) & 0x7), 127.5, -1);
            this.dac_buffers[0].push(s);
            this.dac_buffers[1].push(s);
            s = audio_normalize(this.decode_adpcm_3((b & 0x3) << 1), 127.5, -1);
            this.dac_buffers[0].push(s);
            this.dac_buffers[1].push(s);
        }
    }
    else if(this.dma_transfer_type === 2)
    {
        // 2-bit ADPCM: each byte → 4 samples (bits 7:6, 5:4, 3:2, 1:0).
        for(i = start; i < byte_count; i++)
        {
            b = this.dma_buffer_uint8[i];
            s = audio_normalize(this.decode_adpcm_2((b >> 6) & 0x3), 127.5, -1);
            this.dac_buffers[0].push(s);
            this.dac_buffers[1].push(s);
            s = audio_normalize(this.decode_adpcm_2((b >> 4) & 0x3), 127.5, -1);
            this.dac_buffers[0].push(s);
            this.dac_buffers[1].push(s);
            s = audio_normalize(this.decode_adpcm_2((b >> 2) & 0x3), 127.5, -1);
            this.dac_buffers[0].push(s);
            this.dac_buffers[1].push(s);
            s = audio_normalize(this.decode_adpcm_2((b >> 0) & 0x3), 127.5, -1);
            this.dac_buffers[0].push(s);
            this.dac_buffers[1].push(s);
        }
    }

    this.dac_send();
};

/** Creative ADPCM 4-bit sample decoder. */
SB16.prototype.decode_adpcm_4 = function(sample)
{
    var samp = sample + this.adpcm_stepsize;
    if(samp < 0) samp = 0;
    else if(samp > 63) samp = 63;
    var ref = this.adpcm_reference + ADPCM4_SCALE_MAP[samp];
    if(ref > 0xFF) this.adpcm_reference = 0xFF;
    else if(ref < 0) this.adpcm_reference = 0;
    else this.adpcm_reference = ref & 0xFF;
    this.adpcm_stepsize = (this.adpcm_stepsize + ADPCM4_ADJUST_MAP[samp]) & 0xFF;
    return this.adpcm_reference;
};

/** Creative ADPCM 2-bit sample decoder. */
SB16.prototype.decode_adpcm_2 = function(sample)
{
    var samp = sample + this.adpcm_stepsize;
    if(samp < 0) samp = 0;
    else if(samp > 23) samp = 23;
    var ref = this.adpcm_reference + ADPCM2_SCALE_MAP[samp];
    if(ref > 0xFF) this.adpcm_reference = 0xFF;
    else if(ref < 0) this.adpcm_reference = 0;
    else this.adpcm_reference = ref & 0xFF;
    this.adpcm_stepsize = (this.adpcm_stepsize + ADPCM2_ADJUST_MAP[samp]) & 0xFF;
    return this.adpcm_reference;
};

/** Creative ADPCM 3-bit (2.6-bit) sample decoder. */
SB16.prototype.decode_adpcm_3 = function(sample)
{
    var samp = sample + this.adpcm_stepsize;
    if(samp < 0) samp = 0;
    else if(samp > 39) samp = 39;
    var ref = this.adpcm_reference + ADPCM3_SCALE_MAP[samp];
    if(ref > 0xFF) this.adpcm_reference = 0xFF;
    else if(ref < 0) this.adpcm_reference = 0;
    else this.adpcm_reference = ref & 0xFF;
    this.adpcm_stepsize = (this.adpcm_stepsize + ADPCM3_ADJUST_MAP[samp]) & 0xFF;
    return this.adpcm_reference;
};

SB16.prototype.dac_handle_request = function()
{
    if(!this.dma_bytes_left || this.dma_paused)
    {
        // No more data to transfer or is paused. Send whatever is in the buffers.
        this.dac_send();
    }
    else
    {
        this.dma_transfer_next();
    }
};

SB16.prototype.dac_send = function()
{
    if(!this.dac_buffers[0].length)
    {
        return;
    }

    var out0 = this.dac_buffers[0].shift_block(this.dac_buffers[0].length);
    var out1 = this.dac_buffers[1].shift_block(this.dac_buffers[1].length);
    this.bus.send("dac-send-data", [out0, out1], [out0.buffer, out1.buffer]);
};

SB16.prototype.raise_irq = function(type)
{
    dbg_log("raise irq", LOG_SB16);
    this.irq_triggered[type] = 1;
    this.cpu.device_raise_irq(this.irq);
};

SB16.prototype.lower_irq = function(type)
{
    dbg_log("lower irq", LOG_SB16);
    this.irq_triggered[type] = 0;
    this.cpu.device_lower_irq(this.irq);
};

//
// Helpers
//

function audio_normalize(value, amplitude, offset)
{
    return audio_clip(value / amplitude + offset, -1, 1);
}

function audio_clip(value, low, high)
{
    return (value < low) * low + (value > high) * high + (low <= value && value <= high) * value;
}
