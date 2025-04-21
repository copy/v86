import {
    LOG_SB16,
    MIXER_CHANNEL_BOTH, MIXER_CHANNEL_LEFT, MIXER_CHANNEL_RIGHT,
    MIXER_SRC_PCSPEAKER, MIXER_SRC_DAC, MIXER_SRC_MASTER,
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
    this.sampling_rate = 22050;
    bus.send("dac-tell-sampling-rate", this.sampling_rate);
    this.bytes_per_sample = 1;

    // DMA identification data.
    this.e2_value = 0xAA;
    this.e2_count = 0;

    // ASP data: not understood by me.
    this.asp_registers = new Uint8Array(256);

    // MPU.
    this.mpu_read_buffer = new ByteQueue(DSP_BUFSIZE);
    this.mpu_read_buffer_lastvalue = 0;

    // FM Synthesizer.
    this.fm_current_address0 = 0;
    this.fm_current_address1 = 0;
    this.fm_waveform_select_enable = false;

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

    this.lower_irq(SB_IRQ_8BIT);
    this.irq_triggered.fill(0);

    this.asp_registers.fill(0);
    this.asp_registers[5] = 0x01;
    this.asp_registers[9] = 0xF8;
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
    //state[36]

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
    //state[36];

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
    dbg_log("220 read: fm music status port (unimplemented)", LOG_SB16);
    return 0xFF;
};

SB16.prototype.port2x1_read = function()
{
    dbg_log("221 read: fm music data port (write only)", LOG_SB16);
    return 0xFF;
};

SB16.prototype.port2x2_read = function()
{
    dbg_log("222 read: advanced fm music status port (unimplemented)", LOG_SB16);
    return 0xFF;
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
    dbg_log("228 read: fm music status port (unimplemented)", LOG_SB16);
    return 0xFF;
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
    dbg_log("220 write: (unimplemented) fm register 0 address = " + h(value), LOG_SB16);
    this.fm_current_address0 = 0;
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
    dbg_log("222 write: (unimplemented) fm register 1 address = " + h(value), LOG_SB16);
    this.fm_current_address1 = 0;
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
    dbg_log("228 write: fm music register port (unimplemented)", LOG_SB16);
};

SB16.prototype.port2x9_write = function(value)
{
    dbg_log("229 write: fm music data port (unimplemented)", LOG_SB16);
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
    dbg_log("330 write: mpu data (unimplemented) : " + h(value), LOG_SB16);
};

// MPU UART Mode - Status Port
SB16.prototype.port3x1_read = function()
{
    dbg_log("331 read: mpu status", LOG_SB16);

    var status = 0;
    status |= 0x40 * 0; // Output Ready
    status |= 0x80 * !this.mpu_read_buffer.length; // Input Ready

    return status;
};

// MPU UART Mode - Command Port
SB16.prototype.port3x1_write = function(value)
{
    dbg_log("331 write: mpu command: " + h(value), LOG_SB16);
    if(value === 0xFF)
    {
        // Command acknowledge.
        this.mpu_read_buffer.clear();
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

// ASP set register
register_dsp_command([0x0E], 2, function()
{
    this.asp_registers[this.write_buffer.shift()] = this.write_buffer.shift();
});

// ASP get register
register_dsp_command([0x0F], 1, function()
{
    this.read_buffer.clear();
    this.read_buffer.push(this.asp_registers[this.write_buffer.shift()]);
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
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Creative 8-bit to 2-bit ADPCM single-cycle DMA mode digitized sound output.
register_dsp_command([0x16], 2);

// Creative 8-bit to 2-bit ADPCM single-cycle DMA mode digitzed sound output
// with reference byte.
register_dsp_command([0x17], 2);

// 8-bit auto-init DMA mode digitized sound output.
register_dsp_command([0x1C], 0, function()
{
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = true;
    this.dsp_signed = false;
    this.dsp_16bit = false;
    this.dsp_highspeed = false;
    this.dma_transfer_start();
});

// Creative 8-bit to 2-bit ADPCM auto-init DMA mode digitized sound output
// with reference byte.
register_dsp_command([0x1F], 0);

// 8-bit direct mode single byte digitized sound input.
register_dsp_command([0x20], 0, function()
{
    // Fake silent input.
    this.read_buffer.clear();
    this.read_buffer.push(0x7f);
});

// 8-bit single-cycle DMA mode digitized sound input.
register_dsp_command([0x24], 2);

// 8-bit auto-init DMA mode digitized sound input.
register_dsp_command([0x2C], 0);

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

// MIDI output.
register_dsp_command([0x38], 0);

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
register_dsp_command([0x74], 2);

// Creative 8-bit to 4-bit ADPCM single-cycle DMA mode digitized sound output
// with referene byte.
register_dsp_command([0x75], 2);

// Creative 8-bit to 3-bit ADPCM single-cycle DMA mode digitized sound output.
register_dsp_command([0x76], 2);

// Creative 8-bit to 3-bit ADPCM single-cycle DMA mode digitized sound output
// with referene byte.
register_dsp_command([0x77], 2);

// Creative 8-bit to 4-bit ADPCM auto-init DMA mode digitized sound output
// with reference byte.
register_dsp_command([0x7D], 0);

// Creative 8-bit to 3-bit ADPCM auto-init DMA mode digitized sound output
// with reference byte.
register_dsp_command([0x7F], 0);

// Pause DAC for a duration.
register_dsp_command([0x80], 2);

// 8-bit high-speed auto-init DMA mode digitized sound output.
register_dsp_command([0x90], 0, function()
{
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = true;
    this.dsp_signed = false;
    this.dsp_highspeed = true;
    this.dsp_16bit = false;
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
    this.mixer_registers[0x0A] = 0;
    this.mixer_registers[0x30] = 24 << 3;
    this.mixer_registers[0x31] = 24 << 3;
    this.mixer_registers[0x32] = 24 << 3;
    this.mixer_registers[0x33] = 24 << 3;
    this.mixer_registers[0x34] = 24 << 3;
    this.mixer_registers[0x35] = 24 << 3;
    this.mixer_registers[0x36] = 0;
    this.mixer_registers[0x37] = 0;
    this.mixer_registers[0x38] = 0;
    this.mixer_registers[0x39] = 0;
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
        this.bus.send("mixer-volume",
        [
            mixer_source,
            channel,
            (data >>> 2) - 62
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

// Legacy Mic Volume. TODO.
//register_mixer_read(0x0A);
//register_mixer_write(0x0A, function(data)
//{
//    this.mixer_registers[0x0A] = data;
//    var prev = this.mixer_registers[0x3A];
//    this.mixer_write(0x3A, data << 5 | (prev & 0x0F));
//});

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
// MIDI Volume Left. TODO.
//register_mixer_volume(0x34, MIXER_SRC_SYNTH, MIXER_CHANNEL_LEFT);
// MIDI Volume Right. TODO.
//register_mixer_volume(0x35, MIXER_SRC_SYNTH, MIXER_CHANNEL_RIGHT);
// CD Volume Left. TODO.
//register_mixer_volume(0x36, MIXER_SRC_CD, MIXER_CHANNEL_LEFT);
// CD Volume Right. TODO.
//register_mixer_volume(0x37, MIXER_SRC_CD, MIXER_CHANNEL_RIGHT);
// Line Volume Left. TODO.
//register_mixer_volume(0x38, MIXER_SRC_LINE, MIXER_CHANNEL_LEFT);
// Line Volume Right. TODO.
//register_mixer_volume(0x39, MIXER_SRC_LINE, MIXER_CHANNEL_RIGHT);
// Mic Volume. TODO.
//register_mixer_volume(0x3A, MIXER_SRC_MIC, MIXER_CHANNEL_BOTH);

// PC Speaker Volume.
register_mixer_read(0x3B);
register_mixer_write(0x3B, function(data)
{
    this.mixer_registers[0x3B] = data;
    this.bus.send("mixer-volume", [MIXER_SRC_PCSPEAKER, MIXER_CHANNEL_BOTH, (data >>> 6) * 6 - 18]);
});

// Output Mixer Switches. TODO.
//register_mixer_read(0x3C);
//register_mixer_write(0x3C, function(data)
//{
//    this.mixer_registers[0x3C] = data;
//
//    if(data & 0x01) this.bus.send("mixer-connect", [MIXER_SRC_MIC, MIXER_CHANNEL_BOTH]);
//    else this.bus.send("mixer-disconnect", [MIXER_SRC_MIC, MIXER_CHANNEL_BOTH]);
//
//    if(data & 0x02) this.bus.send("mixer-connect", [MIXER_SRC_CD, MIXER_CHANNEL_RIGHT]);
//    else this.bus.send("mixer-disconnect", [MIXER_SRC_CD, MIXER_CHANNEL_RIGHT]);
//
//    if(data & 0x04) this.bus.send("mixer-connect", [MIXER_SRC_CD, MIXER_CHANNEL_LEFT]);
//    else this.bus.send("mixer-disconnect", [MIXER_SRC_CD, MIXER_CHANNEL_LEFT]);
//
//    if(data & 0x08) this.bus.send("mixer-connect", [MIXER_SRC_LINE, MIXER_CHANNEL_RIGHT]);
//    else this.bus.send("mixer-disconnect", [MIXER_SRC_LINE, MIXER_CHANNEL_RIGHT]);
//
//    if(data & 0x10) this.bus.send("mixer-connect", [MIXER_SRC_LINE, MIXER_CHANNEL_LEFT]);
//    else this.bus.send("mixer-disconnect", [MIXER_SRC_LINE, MIXER_CHANNEL_LEFT]);
//});

// Input Mixer Left Switches. TODO.
//register_mixer_read(0x3D);
//register_mixer_write(0x3D);

// Input Mixer Right Switches. TODO.
//register_mixer_read(0x3E);
//register_mixer_write(0x3E);

// Input Gain Left. TODO.
//register_mixer_read(0x3F);
//register_mixer_write(0x3F);

// Input Gain Right. TODO.
//register_mixer_read(0x40);
//register_mixer_write(0x40);

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

// Mic AGC. TODO.
//register_mixer_read(0x43);
//register_mixer_write(0x43);

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
    this.fm_waveform_select_enable[register] = bits & 0x20 > 0;
    this.fm_update_waveforms();
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
            // if(bits & 0x80)
            // {
            //     // IQR Reset
            // }
            // else
            // {
            //     // Timer masks and on/off
            // }
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
    // Composite sine wave on/off
    // Note select (keyboard split selection method)
});

register_fm_write(between(0x20, 0x35), function(bits, register, address)
{
    var operator = get_fm_operator(register, address - 0x20);
    // Tremolo
    // Vibrato
    // Sustain
    // KSR Envelope Scaling
    // Frequency Multiplication Factor
});

register_fm_write(between(0x40, 0x55), function(bits, register, address)
{
    var operator = get_fm_operator(register, address - 0x40);
    // Key Scale Level
    // Output Level
});

register_fm_write(between(0x60, 0x75), function(bits, register, address)
{
    var operator = get_fm_operator(register, address - 0x60);
    // Attack Rate
    // Decay Rate
});

register_fm_write(between(0x80, 0x95), function(bits, register, address)
{
    var operator = get_fm_operator(register, address - 0x80);
    // Sustain Level
    // Release Rate
});

register_fm_write(between(0xA0, 0xA8), function(bits, register, address)
{
    var channel = address - 0xA0;
    // Frequency Number (Lower 8 bits)
});

register_fm_write(between(0xB0, 0xB8), function(bits, register, address)
{
    // Key-On
    // Block Number
    // Frequency Number (Higher 2 bits)
});

register_fm_write([0xBD], function(bits, register, address)
{
    // Tremelo Depth
    // Vibrato Depth
    // Percussion Mode
    // Bass Drum Key-On
    // Snare Drum Key-On
    // Tom-Tom Key-On
    // Cymbal Key-On
    // Hi-Hat Key-On
});

register_fm_write(between(0xC0, 0xC8), function(bits, register, address)
{
    // Right Speaker Enable
    // Left Speaker Enable
    // Feedback Modulation Factor
    // Synthesis Type
});

register_fm_write(between(0xE0, 0xF5), function(bits, register, address)
{
    var operator = get_fm_operator(register, address - 0xE0);
    // Waveform Select
});

//
// FM behaviours
//

SB16.prototype.fm_update_waveforms = function()
{
    // To be implemented.
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
