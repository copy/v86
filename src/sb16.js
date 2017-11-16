"use strict";

var
/** @const */ DSP_COPYRIGHT = "COPYRIGHT (C) CREATIVE TECHNOLOGY LTD, 1992.",
/** @const */ DSP_NO_COMMAND = 0,
/** @const */ DSP_BUFSIZE = 64,
/** @const */ DSP_DACSIZE = 1024,
/** @const */ DMA_BUFSIZE = 1024,
/** @const */ DMA_CHANNEL_8BIT = 1, // (ISA DMA standard sound card channels)
/** @const */ DMA_CHANNEL_16BIT = 5,
/** @const */ SB_IRQ = 5,
/** @const */ SB_IRQ_8BIT  = 0x1,
/** @const */ SB_IRQ_16BIT = 0x2,
/** @const */ SB_IRQ_MIDI  = 0x1,
/** @const */ SB_IRQ_MPU   = 0x4;

// Probably inefficient, but it looks much nicer instead
// of having a single large unorganised table.
var DSP_command_sizes = new Uint8Array(256);
var DSP_command_handlers = [];
var mixer_read_handlers = [];
var mixer_write_handlers = [];

/**
 * Sound Blaster 16 Emulator, or so it seems.
 * Note: Uses AudioContext.createScriptProcessor, which is deprecated,
 * but which no satisfactory substitute is availble.
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 * @suppress {deprecated}
 */
function SB16(cpu, bus)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    // I/O Buffers.
    this.write_buffer = new ByteQueue(DSP_BUFSIZE);
    this.read_buffer = new ByteQueue(DSP_BUFSIZE);
    this.read_buffer_lastvalue = 0;

    // Current DSP command info.
    this.command = DSP_NO_COMMAND;
    this.command_size = 0;

    // Mixer.
    this.mixer_current_address = 0;
    this.mixer_unhandled_registers = new Uint8Array(256);

    // Dummy status and test registers.
    this.dummy_speaker_enabled = false;
    this.test_register = 0;

    // DSP state.
    this.dsp_highspeed = false;

    // Direct mode DAC buffer and DMA DAC buffer.
    // In Web Audio API representation: between -1 and 1.
    // Two channels interleaved.
    this.dac_buffer = new ByteQueue(DSP_DACSIZE);

    // Direct Memory Access transfer info.
    this.dma = cpu.devices.dma;
    this.dma_transfer_size = 0;
    this.dma_irq = 0;
    this.dma_channel = 0;
    this.dma_channel_8bit = DMA_CHANNEL_8BIT;
    this.dma_channel_16bit = DMA_CHANNEL_16BIT;
    this.dma_autoinit = false;
    this.dma_buffer = new Uint8Array(DMA_BUFSIZE);
    this.sampling_rate = 22050;

    // Interrupts.
    this.irq = SB_IRQ;
    this.irq_triggered = new Uint8Array(0x10);

    // http://homepages.cae.wisc.edu/~brodskye/sb16doc/sb16doc.html#DSPPorts

    cpu.io.register_read(0x220, this, this.port2x0_read);
    cpu.io.register_read(0x221, this, this.port2x1_read);
    cpu.io.register_read(0x222, this, this.port2x2_read);
    cpu.io.register_read(0x223, this, this.port2x3_read);
    cpu.io.register_read(0x224, this, this.port2x4_read);
    cpu.io.register_read(0x225, this, this.port2x5_read);
    cpu.io.register_read(0x226, this, this.port2x6_read);
    cpu.io.register_read(0x227, this, this.port2x7_read);
    cpu.io.register_read(0x228, this, this.port2x8_read);
    cpu.io.register_read(0x229, this, this.port2x9_read);
    cpu.io.register_read(0x22A, this, this.port2xA_read);
    cpu.io.register_read(0x22B, this, this.port2xB_read);
    cpu.io.register_read(0x22C, this, this.port2xC_read);
    cpu.io.register_read(0x22D, this, this.port2xD_read);
    cpu.io.register_read(0x22E, this, this.port2xE_read);
    cpu.io.register_read(0x22F, this, this.port2xF_read);

    cpu.io.register_write(0x220, this, this.port2x0_write);
    cpu.io.register_write(0x221, this, this.port2x1_write);
    cpu.io.register_write(0x222, this, this.port2x2_write);
    cpu.io.register_write(0x223, this, this.port2x3_write);
    cpu.io.register_write(0x224, this, this.port2x4_write);
    cpu.io.register_write(0x225, this, this.port2x5_write);
    cpu.io.register_write(0x226, this, this.port2x6_write);
    cpu.io.register_write(0x227, this, this.port2x7_write);
    cpu.io.register_write(0x228, this, this.port2x8_write);
    cpu.io.register_write(0x229, this, this.port2x9_write);
    cpu.io.register_write(0x22A, this, this.port2xA_write);
    cpu.io.register_write(0x22B, this, this.port2xB_write);
    cpu.io.register_write(0x22C, this, this.port2xC_write);
    cpu.io.register_write(0x22D, this, this.port2xD_write);
    cpu.io.register_write(0x22E, this, this.port2xE_write);
    cpu.io.register_write(0x22F, this, this.port2xF_write);

    bus.register("speaker-process", function(event)
    {
        this.audio_process(event);
    }, this);

    this.reset_dsp();
}



//
// General:
//



SB16.prototype.reset_dsp = function()
{
    this.write_buffer.clear();
    this.read_buffer.clear();

    this.command = DSP_NO_COMMAND;
    this.command_size = 0;

    this.dummy_speaker_enabled = false;
    this.test_register = 0;

    this.dsp_highspeed = false;

    this.dac_buffer.clear();

    this.dma_transfer_size = 0;
    this.dma_irq = 0;
    this.dma_channel = 0;
    this.dma_autoinit = false;
    this.dma_buffer.clear();

    this.sampling_rate = 22050;

    this.lower_irq(SB_IRQ_8BIT);
    this.irq_triggered.fill(0);
}



//
// I/O handlers:
//



SB16.prototype.port2x0_read = function()
{
    dbg_log("220 read: fm music status port (unimplemented)", LOG_SB16);
    return 0xFF;
}
SB16.prototype.port2x1_read = function()
{
    dbg_log("221 read: fm music data port (write only)", LOG_SB16);
    return 0xFF;
}
SB16.prototype.port2x2_read = function()
{
    dbg_log("222 read: advanced fm music status port (unimplemented)", LOG_SB16);
    return 0xFF;
}
SB16.prototype.port2x3_read = function()
{
    dbg_log("223 read: advanced music data port (write only)", LOG_SB16);
    return 0xFF;
}

// Mixer Address Port.
SB16.prototype.port2x4_read = function()
{
    dbg_log("224 read: mixer address port", LOG_SB16);
    return this.mixer_current_address;
}

// Mixer Data Port.
SB16.prototype.port2x5_read = function()
{
    dbg_log("225 read: mixer data port", LOG_SB16);
    var handler = mixer_read_handlers[this.mixer_current_address];
    if(!handler)
    {
        handler = this.mixer_default_read;
    }
    return handler.call(this);
}

SB16.prototype.port2x6_read = function()
{
    dbg_log("226 read: (write only)", LOG_SB16);
    return 0xFF;
}
SB16.prototype.port2x7_read = function()
{
    dbg_log("227 read: undocumented", LOG_SB16);
    return 0xFF;
}
SB16.prototype.port2x8_read = function()
{
    dbg_log("228 read: fm music status port (unimplemented)", LOG_SB16);
    return 0xFF;
}
SB16.prototype.port2x9_read = function()
{
    dbg_log("229 read: fm music data port (write only)", LOG_SB16);
    return 0xFF;
}

// Read Data.
// Used to acces in-bound DSP data.
SB16.prototype.port2xA_read = function()
{
    dbg_log("22A read: read data", LOG_SB16);
    if(this.read_buffer.length)
    {
        this.read_buffer_lastvalue = this.read_buffer.shift();
    }
    dbg_log(" <- " + this.read_buffer_lastvalue + " " + h(this.read_buffer_lastvalue) + " '" + String.fromCharCode(this.read_buffer_lastvalue) + "'", LOG_SB16);
    return this.read_buffer_lastvalue;
}

SB16.prototype.port2xB_read = function()
{
    dbg_log("22B read: undocumented", LOG_SB16);
    return 0xFF;
}

// Write-Buffer Status.
// Indicates whether the DSP is ready to accept commands or data.
SB16.prototype.port2xC_read = function()
{
    dbg_log("22C read: write-buffer status", LOG_SB16);
    // Always return ready (bit-7 set to low)
    return 0x7F;
}

SB16.prototype.port2xD_read = function()
{
    dbg_log("22D read: undocumented", LOG_SB16);
    return 0xFF;
}

// Read-Buffer Status.
// Indicates whether there is any in-bound data available for reading.
// Also used to acknowledge DSP 8-bit interrupt.
SB16.prototype.port2xE_read = function()
{
    dbg_log("22E read: read-buffer status / irq 8bit ack.", LOG_SB16);
    if(this.irq_triggered_8bit)
    {
        this.lower_irq(SB_IRQ_8BIT);
    }
    var ready = this.read_buffer.length && !this.dsp_highspeed;
    return (ready << 7) | 0x7F;
}

// DSP 16-bit interrupt acknowledgement.
SB16.prototype.port2xF_read = function()
{
    dbg_log("22F read: irq 16bit ack", LOG_SB16);
    this.irq_triggered_16bit = false;
    this.lower_irq(SB_IRQ_16BIT);
    return 0;
}


SB16.prototype.port2x0_write = function(value)
{
    dbg_log("220 write: fm music register address port (unimplemented)", LOG_SB16);
}
SB16.prototype.port2x1_write = function(value)
{
    dbg_log("221 write: fm music data port (unimplemented)", LOG_SB16);
}
SB16.prototype.port2x2_write = function(value)
{
    dbg_log("222 write: advanced fm music register address port (unimplemented)", LOG_SB16);
}
SB16.prototype.port2x3_write = function(value)
{
    dbg_log("223 write: advanced fm music data port (unimplemented)", LOG_SB16);
}

// Mixer Address Port.
SB16.prototype.port2x4_write = function(value)
{
    dbg_log("224 write: mixer address = " + h(value), LOG_SB16);
    this.mixer_current_address = value;
}

// Mixer Data Port.
SB16.prototype.port2x5_write = function(value)
{
    dbg_log("225 write: mixer data = " + h(value), LOG_SB16);
    var handler = mixer_write_handlers[this.mixer_current_address];
    if(!handler)
    {
        handler = this.mixer_default_write;
    }
    handler.call(this, value);
}

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
        this.reset_dsp();
    }

    // Signal completion.
    this.read_buffer.clear();
    this.read_buffer.push(0xAA);
}

SB16.prototype.port2x7_write = function(value)
{
    dbg_log("227 write: undocumented", LOG_SB16);
}
SB16.prototype.port2x8_write = function(value)
{
    dbg_log("228 write: fm music register port (unimplemented)", LOG_SB16);
}
SB16.prototype.port2x9_write = function(value)
{
    dbg_log("229 write: fm music data port (unimplemented)", LOG_SB16);
}
SB16.prototype.port2xA_write = function(value)
{
    dbg_log("22A write: dsp read data port (read only)", LOG_SB16);
}
SB16.prototype.port2xB_write = function(value)
{
    dbg_log("22B write: undocumented", LOG_SB16);
}

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
        this.command_size = DSP_command_sizes[value];
    }
    else
    {
        dbg_log("22C write: data: " + h(value), LOG_SB16);
        this.write_buffer.push(value);
    }

    // Perform command when we have all the needed data.
    if(this.write_buffer.length >= this.command_size)
    {
        this.command_do();
    }
}
SB16.prototype.port2xD_write = function(value)
{
    dbg_log("22D write: undocumented", LOG_SB16);
}
SB16.prototype.port2xE_write = function(value)
{
    dbg_log("22E write: dsp read buffer status (read only)", LOG_SB16);
}
SB16.prototype.port2xF_write = function(value)
{
    dbg_log("22F write: undocumented", LOG_SB16);
}



//
// DSP command handlers
//



SB16.prototype.command_do = function()
{
    var handler = DSP_command_handlers[this.command];
    if (!handler)
    {
        handler = this.dsp_default_handler;
    }
    handler.call(this);

    // Reset Inputs.
    this.command = DSP_NO_COMMAND;
    this.command_size = 0;
    this.write_buffer.clear();
}

SB16.prototype.dsp_default_handler = function()
{
    dbg_log("Unhandled command: " + h(this.command), LOG_SB16);
}

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
        DSP_command_sizes[commands[i]] = size;
        DSP_command_handlers[commands[i]] = handler;
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

// 8-bit direct mode single byte digitized sound output.
register_dsp_command([0x10], 1, function()
{
    var value = audio_from_8bit(this.write_buffer.shift());

    // Push twice for both channels.
    this.dac_buffer.push(value);
    this.dac_buffer.push(value);
});

// 8-bit single-cycle DMA mode digitized sound output.
register_dsp_command([0x14, 0x15], 2, function()
{
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = false;
    this.dma_signed = false;
    this.dsp_highspeed = false;
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Creative 8-bit to 2-bit ADPCM single-cycle DMA mode digitzed sound output.
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
    this.dma_signed = false;
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
    this.sampling_rate_change(
        1000000
        / (256 - this.write_buffer.shift())
        / this.get_channel_count()
    );
});

// Set digitized sound output sampling rate.
// Set digitized sound input sampling rate.
register_dsp_command([0x41, 0x42], 2, function()
{
    this.sampling_rate_change(
        (this.write_buffer.shift() << 8)
        | this.write_buffer.shift()
    );
});

// Set DSP block transfer size.
register_dsp_command([0x48], 2, function()
{
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
    this.dma_signed = false;
    this.dsp_highspeed = true;
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
    if (this.command & (1 << 3))
    {
        // Analogue to digital not implemented.
        this.dsp_default_handler();
        return;
    }
    var mode = this.write_buffer.shift();
    this.dma_irq = SB_IRQ_16BIT;
    this.dma_channel = this.dma_channel_16bit;
    this.dma_autoinit = !!(this.command & (1 << 2));
    this.dma_signed = !!(mode & (1 << 4));
    this.dsp_stereo = !!(mode & (1 << 5));
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Program 8-bit DMA mode digitized sound I/O.
register_dsp_command(any_first_digit(0xC0), 3, function()
{
    if (this.command & (1 << 3))
    {
        // Analogue to digital not implemented.
        this.dsp_default_handler();
        return;
    }
    var mode = this.write_buffer.shift();
    this.dma_irq = SB_IRQ_8BIT;
    this.dma_channel = this.dma_channel_8bit;
    this.dma_autoinit = !!(this.command & (1 << 2));
    this.dma_signed = !!(mode & (1 << 4));
    this.dsp_stereo = !!(mode & (1 << 5));
    this.dma_transfer_size_set();
    this.dma_transfer_start();
});

// Pause 8-bit DMA mode digitized sound I/O.
register_dsp_command([0xD0], 0);

// Turn on speaker.
register_dsp_command([0xD1], 0, function()
{
    this.dummy_speaker_enabled = true;
});

// Turn off speaker.
register_dsp_command([0xD3], 0, function()
{
    this.dummy_speaker_enabled = false;
});

// Continue 8-bit DMA mode digitized sound I/O.
register_dsp_command([0xD4], 0);

// Pause 16-bit DMA mode digitized sound I/O.
register_dsp_command([0xD5], 0);

// Continue 16-bit DMA mode digitized sound I/O.
register_dsp_command([0xD6], 0);

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

// Get DSP version number.
register_dsp_command([0xE1], 0, function()
{
    this.read_buffer.clear();
    this.read_buffer.push(4);
    this.read_buffer.push(5);
});

// Get DSP copyright.
register_dsp_command([0xE3], 0, function()
{
    this.read_buffer.clear();
    for(var i = 0; i < DSP_COPYRIGHT.length; i++)
    {
        this.read_buffer.push(DSP_COPYRIGHT.charCodeAt(i));
    }
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



//
// Mixer Handlers
//



SB16.prototype.mixer_default_read = function()
{
    dbg_log("unhandled mixer register read. addr:" + h(this.mixer_current_address), LOG_SB16);
    return this.mixer_unhandled_registers[this.mixer_current_address];
}

SB16.prototype.mixer_default_write = function(data)
{
    dbg_log("unhandled mixer register write. addr:" + h(this.mixer_current_address) + " data:" + h(data), LOG_SB16);
    this.mixer_unhandled_registers[this.mixer_current_address] = data;
}

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
    mixer_read_handlers[address] = handler;
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
    mixer_write_handlers[address] = handler;
}

// Reset.
register_mixer_read(0x00, function()
{
    return 0;
});
register_mixer_write(0x00);

// IRQ Select.
register_mixer_read(0x80, function()
{
    switch(this.irq)
    {
        case 2: return 0x1;
        case 5: return 0x2;
        case 7: return 0x4;
        case 10: return 0x8;
        default: return 0x0;
    }
});
register_mixer_write(0x80, function(bits)
{
    if(bits & 0x1) this.irq = 2;
    if(bits & 0x2) this.irq = 5;
    if(bits & 0x4) this.irq = 7;
    if(bits & 0x8) this.irq = 10;
});

// DMA Select.
register_mixer_read(0x81, function()
{
    var ret = 0;
    switch(this.dma_channel_8bit)
    {
        case 0: ret |= 0x1; break;
        case 1: ret |= 0x2; break;
        case 3: ret |= 0x8; break;
    }
    switch(this.dma_channel_16bit)
    {
        case 5: ret |= 0x20; break;
        case 6: ret |= 0x40; break;
        case 7: ret |= 0x80; break;
    }
    return ret;
});
register_mixer_write(0x81, function(bits)
{
    if(bits & 0x1)  this.dma_channel_8bit  = 0;
    if(bits & 0x2)  this.dma_channel_8bit  = 1;
    if(bits & 0x8)  this.dma_channel_8bit  = 3;
    if(bits & 0x20) this.dma_channel_16bit = 5;
    if(bits & 0x40) this.dma_channel_16bit = 6;
    if(bits & 0x80) this.dma_channel_16bit = 7;
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
// General behaviours
//



SB16.prototype.sampling_rate_change = function(rate)
{
    this.sampling_rate = rate;
}

SB16.prototype.get_channel_count = function()
{
    return this.dsp_stereo? 2 : 1;
}

SB16.prototype.dma_transfer_size_set = function()
{
    this.dma_transfer_size = 1
        + (this.write_buffer.shift() << 0)
        + (this.write_buffer.shift() << 8);
}

SB16.prototype.dma_transfer_start = function()
{
    dbg_log("begin dma transfer", LOG_SB16);
    var irq = this.dma_irq;
    this.dma.do_read(this.dma_buffer, 0, this.dma_transfer_size, this.dma_channel, function(error)
    {
        this.dma_to_dac();
        this.raise_irq(irq);
    });
}

SB16.prototype.dma_to_dac = function()
{
    for(var i = 0; i < this.dma_buffer.length; i++)
    {
        var value = this.dma_buffer[i];

        if (this.dma_signed)
        {
            value = audio_from_16bit(value);
        }
        else
        {
            value = audio_from_8bit(value);
        }

        this.dac_buffer.push(value);

        if (!this.dsp_stereo)
        {
            // Again for both channels.
            this.dac_buffer.push(value);
        }
    }
}

SB16.prototype.audio_process = function(event)
{
    var out = event.outputBuffer;
    var out0 = event.outputBuffer.getChannelData(0);
    var out1 = event.outputBuffer.getChannelData(1);

    for(var i = 0; i < out.length; i++)
    {
        out0[i] = (!!this.dac_buffer.length) * this.dac_buffer.shift();
        out1[i] = (!!this.dac_buffer.length) * this.dac_buffer.shift();
    }

    if(this.dma_autoinit)
    {
        // Resend. Emulate DMA autoinit mode.
        this.dma_to_dac();
    }
    else
    {
        // Clear.
        this.dma_buffer.fill(0);
    }
}

SB16.prototype.raise_irq = function(type)
{
    this.irq_triggered[type] = 1;
    this.cpu.device_raise_irq(this.irq);
}

SB16.prototype.lower_irq = function(type)
{
    this.irq_triggered[type] = 0;
    this.cpu.device_lower_irq(this.irq);
}

function audio_from_8bit(value)
{
    return audio_clip(value / 255 - 0.5, -1, 1);
}

function audio_from_16bit(value)
{
    return audio_clip(value / (1 << 16), -1, 1);
}

function audio_clip(value, low, high)
{
    return (value < low) * low + (value > high) * high + (low <= value && value <= high) * value;
}
