// audio_device "hd_audio": an Intel High Definition Audio controller, ICH6's
// (8086:2668) on i440FX, ICH9's (8086:293E) on Q35, as QEMU's intel-hda and
// ich9-intel-hda; Windows binds hdaudbus.inf by its class (PCI\CC_0403),
// Linux snd-hda-intel by both IDs. One codec (codec.js) and one output
// stream; INTA. See the High Definition Audio Specification 1.0a, chapters 3
// (registers) and 4 (programming model).
//
// The codec's commands go through the CORB and RIRB in guest memory (or the
// immediate command registers) and are answered at once. An output stream
// plays at its format's rate on the machine clock: its buffer descriptor
// list is read as the time to play it comes, LPIB, the DMA position buffer
// and the completion interrupts follow, and the samples go to the speaker
// whether or not the page can play them (docs/modern-pc-devices-plan.md,
// H1).

import { LOG_DMA } from "../../const.js";
import { h } from "../../lib.js";
import { dbg_log } from "../../log.js";
import { AudioMachine } from "../machine.js";
import { HDACodec } from "./codec.js";

const MMIO_SIZE = 0x4000;

/** The controller of each machine: [device, revision] */
const IDENTITY = { "i440fx": [0x2668, 0x01], "q35": [0x293E, 0x03] };
const PCI_VENDOR = 0x8086;
// (QEMU's subsystem, as its intel-hda has)
const PCI_SUBSYSTEM_VENDOR = 0x1AF4, PCI_SUBSYSTEM = 0x1100;
const PM_CAP = 0x50;
const PM_PMC = 0xC842;

const INPUT_STREAMS = 0, OUTPUT_STREAMS = 1;
const STREAMS = INPUT_STREAMS + OUTPUT_STREAMS;
/** GCAP: output and input streams, 64-bit addresses */
const GCAP = OUTPUT_STREAMS << 12 | INPUT_STREAMS << 8 | 1;

// registers (byte offsets in BAR0)
const R_GCAP = 0x00, R_VMIN = 0x02, R_VMAJ = 0x03, R_OUTPAY = 0x04, R_INPAY = 0x06, R_GCTL = 0x08, R_WAKEEN = 0x0C,
    R_STATESTS = 0x0E, R_GSTS = 0x10, R_OUTSTRMPAY = 0x18, R_INSTRMPAY = 0x1A, R_INTCTL = 0x20, R_INTSTS = 0x24,
    R_WALCLK = 0x30, R_SSYNC_OLD = 0x34, R_SSYNC = 0x38,
    R_CORBLBASE = 0x40, R_CORBUBASE = 0x44, R_CORBWP = 0x48, R_CORBRP = 0x4A, R_CORBCTL = 0x4C, R_CORBSTS = 0x4D,
    R_CORBSIZE = 0x4E, R_RIRBLBASE = 0x50, R_RIRBUBASE = 0x54, R_RIRBWP = 0x58, R_RINTCNT = 0x5A, R_RIRBCTL = 0x5C,
    R_RIRBSTS = 0x5D, R_RIRBSIZE = 0x5E, R_ICOI = 0x60, R_ICII = 0x64, R_ICIS = 0x68, R_DPLBASE = 0x70, R_DPUBASE = 0x74,
    R_STREAMS = 0x80, STREAM_SIZE = 0x20, R_WALCLK_ALIAS = 0x2030, R_LPIB_ALIAS = 0x2084;
// a stream descriptor's registers (from its base)
const SD_CTL = 0x00, SD_STS = 0x03, SD_LPIB = 0x04, SD_CBL = 0x08, SD_LVI = 0x0C, SD_FIFOW = 0x0E, SD_FIFOS = 0x10,
    SD_FMT = 0x12, SD_BDPL = 0x18, SD_BDPU = 0x1C;

const GCTL_CRST = 1 << 0, GCTL_FCNTRL = 1 << 1, GCTL_UNSOL = 1 << 8;
const INT_GIE = 1 << 31, INT_CIE = 1 << 30;
const CORBRP_RST = 1 << 15;
const CORBCTL_CMEIE = 1 << 0, CORBCTL_RUN = 1 << 1;
const RIRBWP_RST = 1 << 15;
const RIRBCTL_RINTCTL = 1 << 0, RIRBCTL_DMAEN = 1 << 1;
const RIRBSTS_RINTFL = 1 << 0, RIRBSTS_OIS = 1 << 2;
/** 256 entries (the only size), and that it is the only one */
const RING_SIZE = 0x42;
const ICIS_ICB = 1 << 0, ICIS_IRV = 1 << 1;
const DPLBASE_ENABLE = 1 << 0;

const SD_CTL_SRST = 1 << 0, SD_CTL_RUN = 1 << 1, SD_CTL_IOCE = 1 << 2, SD_CTL_FEIE = 1 << 3, SD_CTL_DEIE = 1 << 4;
const SD_STS_BCIS = 1 << 2, SD_STS_FIFOE = 1 << 3, SD_STS_DESE = 1 << 4, SD_STS_FIFORDY = 1 << 5;
/** The FIFO's size in bytes, less one (SDnFIFOS) */
const FIFO_SIZE = 0xFF;

/** The wall clock: 24 MHz, in ticks per millisecond of the machine clock */
const WALLCLK_PER_MS = 24000;
/** Per round of the timer at most this much is played; the rest when it is due again */
const MAX_PLAY_MS = 100;

/** The formats the codec announces (codec.js PCM_FORMATS): rate and sample size of a stream */
const PCM_RATES = [44100, 48000];

/**
 * A stream's format register (SDnFMT, the codec's converter format)
 * @param {number} fmt
 * @return {{rate: number, bytes: number, channels: number}}
 */
export function decode_format(fmt)
{
    const base = fmt & 1 << 14 ? 44100 : 48000;
    const rate = base * ((fmt >> 11 & 7) + 1) / ((fmt >> 8 & 7) + 1);
    // 8 bits in a byte, 16 in two, 20, 24 and 32 in four
    const bytes = [1, 2, 4, 4, 4, 4, 4, 4][fmt >> 4 & 7];
    return { rate, bytes, channels: (fmt & 0xF) + 1 };
}

/**
 * @constructor
 * @param {!Object} handle the machine handle (src/device_plugin.js)
 */
export function HDAController(handle)
{
    const machine = new AudioMachine(handle);
    /** @const @type {AudioMachine} */
    this.machine = machine;
    this.name = "hd_audio";

    this.codec = new HDACodec(0);
    this.streams = [];
    for(let i = 0; i < STREAMS; i++) this.streams.push(new_stream(i));

    this.bar0 = 0;
    /** Where BAR0 is decoded, or -1 */
    this.mmio = -1;
    this.irq_level = false;
    /** The rate the speaker was last told */
    this.speaker_rate = 0;

    this.reset_controller();
    this.gctl = 0;

    const [device, revision] = IDENTITY[machine.machine_type] || IDENTITY["i440fx"];
    machine.register_pci({
        pci_space: create_pci_space(device, revision),
        pci_bars: [{ size: MMIO_SIZE, on_move: base => { this.bar0 = base; this.update_decode(); } }],
        on_command_change: () => { this.update_decode(); this.update_irq(); },
        on_config_restore: () => this.update_decode(),
        on_upstream_change: () => this.update_decode(),
        on_config_write: (offset, size) => this.config_written(offset, size),
    });
    machine.add_timer(now => this.timer(now));
}

/**
 * @param {number} index
 */
function new_stream(index)
{
    return {
        index,
        output: index >= INPUT_STREAMS,
        ctl: 0, sts: 0, lpib: 0, cbl: 0, lvi: 0, fifow: 0, fmt: 0, bdpl: 0, bdpu: 0,
        // while it runs: the buffer descriptor and the offset in it, and
        // the frames played since `started` (machine time)
        entry: 0, offset: 0, started: 0, played: 0, running: false,
    };
}

/**
 * @param {number} device
 * @param {number} revision
 * @return {!Array<number>}
 */
function create_pci_space(device, revision)
{
    const space = new Array(256).fill(0);
    const put16 = (offset, value) => { space[offset] = value & 0xFF; space[offset + 1] = value >> 8 & 0xFF; };
    put16(0x00, PCI_VENDOR);
    put16(0x02, device);
    // status: a capabilities list
    put16(0x06, 0x0010);
    space[0x08] = revision;
    // class 04/03/00: an HD Audio controller
    space[0x0A] = 0x03;
    space[0x0B] = 0x04;
    put16(0x2C, PCI_SUBSYSTEM_VENDOR);
    put16(0x2E, PCI_SUBSYSTEM);
    space[0x34] = PM_CAP;
    space[0x3D] = 1;
    // HDCTL: HD Audio, not AC '97
    space[0x40] = 0x01;
    space[PM_CAP] = 0x01;
    put16(PM_CAP + 2, PM_PMC);
    return space;
}

/** The power management capability keeps its read-only bytes */
HDAController.prototype.config_written = function(offset, size)
{
    if(offset + size <= PM_CAP || offset >= PM_CAP + 8) return;
    const space = this.machine.pci_config();
    const pmcsr = (space[PM_CAP + 4] | space[PM_CAP + 5] << 8) & 0x0103;
    space.set([0x01, 0x00, PM_PMC & 0xFF, PM_PMC >> 8, pmcsr & 0xFF, pmcsr >> 8, 0, 0], PM_CAP);
};

HDAController.prototype.update_decode = function()
{
    const base = this.bar0 && this.machine.memory_decoded(this.bar0, MMIO_SIZE) ? this.bar0 : -1;
    if(base === this.mmio) return;
    if(this.mmio !== -1) this.machine.mmap_unregister_range(this.mmio, MMIO_SIZE);
    this.mmio = base;
    if(base !== -1)
    {
        this.machine.mmap_register_range(base, MMIO_SIZE,
            address => this.read(address - this.mmio, 1),
            (address, value) => this.write(address - this.mmio, 1, value),
            address => this.read(address - this.mmio, 4),
            (address, value) => this.write(address - this.mmio, 4, value));
    }
};

/** Everything but GCTL to its reset value (GCTL.CRST cleared, or a machine reset) */
HDAController.prototype.reset_controller = function()
{
    for(const stream of this.streams) this.stop(stream);
    this.streams = this.streams.map(stream => new_stream(stream.index));
    this.wakeen = 0;
    this.statests = 0;
    this.gsts = 0;
    this.intctl = 0;
    this.ssync = 0;
    this.corb_base = [0, 0];
    this.corb_wp = 0;
    this.corb_rp = 0;
    this.corb_rp_reset = false;
    this.corbctl = 0;
    this.corbsts = 0;
    this.rirb_base = [0, 0];
    this.rirb_wp = 0;
    this.rintcnt = 0;
    this.rirbctl = 0;
    this.rirbsts = 0;
    /** responses since RINTFL was last set (RINTCNT) */
    this.rirb_count = 0;
    this.icoi = 0;
    this.icii = 0;
    this.icis = 0;
    this.dplbase = 0;
    this.dpubase = 0;
    this.wall_base = this.machine.now();
    this.codec.reset();
    this.update_irq();
};

/** A machine reset (PCIRST#) */
HDAController.prototype.reset = function()
{
    this.reset_controller();
    this.gctl = 0;
    this.update_decode();
};

// registers

/**
 * A register's value
 * @param {number} offset its first byte
 * @return {number}
 */
HDAController.prototype.register = function(offset)
{
    if(offset >= R_STREAMS && offset < R_STREAMS + STREAMS * STREAM_SIZE)
    {
        const stream = this.streams[offset - R_STREAMS >> 5];
        switch(offset - R_STREAMS & 0x1F)
        {
            case SD_CTL: return stream.ctl;
            case SD_STS: return stream.sts | (stream.running ? SD_STS_FIFORDY : 0);
            case SD_LPIB: return stream.lpib;
            case SD_CBL: return stream.cbl;
            case SD_LVI: return stream.lvi;
            case SD_FIFOW: return stream.fifow;
            case SD_FIFOS: return FIFO_SIZE;
            case SD_FMT: return stream.fmt;
            case SD_BDPL: return stream.bdpl;
            case SD_BDPU: return stream.bdpu;
        }
        return 0;
    }
    if(offset >= R_LPIB_ALIAS && offset < R_LPIB_ALIAS + STREAMS * STREAM_SIZE && !(offset - R_LPIB_ALIAS & 0x1F))
    {
        return this.streams[offset - R_LPIB_ALIAS >> 5].lpib;
    }
    switch(offset)
    {
        case R_GCAP: return GCAP;
        case R_VMIN: return 0;
        case R_VMAJ: return 1;
        case R_OUTPAY: return 0x3C;
        case R_INPAY: return 0x1D;
        case R_GCTL: return this.gctl;
        case R_WAKEEN: return this.wakeen;
        case R_STATESTS: return this.statests;
        case R_GSTS: return this.gsts;
        case R_OUTSTRMPAY: return 0x30;
        case R_INSTRMPAY: return 0x18;
        case R_INTCTL: return this.intctl;
        case R_INTSTS: return this.interrupt_status();
        case R_WALCLK: case R_WALCLK_ALIAS: return this.wallclock();
        case R_SSYNC: case R_SSYNC_OLD: return this.ssync;
        case R_CORBLBASE: return this.corb_base[0];
        case R_CORBUBASE: return this.corb_base[1];
        case R_CORBWP: return this.corb_wp;
        case R_CORBRP: return this.corb_rp | (this.corb_rp_reset ? CORBRP_RST : 0);
        case R_CORBCTL: return this.corbctl;
        case R_CORBSTS: return this.corbsts;
        case R_CORBSIZE: return RING_SIZE;
        case R_RIRBLBASE: return this.rirb_base[0];
        case R_RIRBUBASE: return this.rirb_base[1];
        case R_RIRBWP: return this.rirb_wp;
        case R_RINTCNT: return this.rintcnt;
        case R_RIRBCTL: return this.rirbctl;
        case R_RIRBSTS: return this.rirbsts;
        case R_RIRBSIZE: return RING_SIZE;
        case R_ICOI: return this.icoi;
        case R_ICII: return this.icii;
        case R_ICIS: return this.icis;
        case R_DPLBASE: return this.dplbase;
        case R_DPUBASE: return this.dpubase;
    }
    return 0;
};

/** The registers' sizes, by first byte (the rest are a stream's, register_size) */
const SIZES = new Map([
    [R_GCAP, 2], [R_VMIN, 1], [R_VMAJ, 1], [R_OUTPAY, 2], [R_INPAY, 2], [R_GCTL, 4], [R_WAKEEN, 2], [R_STATESTS, 2],
    [R_GSTS, 2], [R_OUTSTRMPAY, 2], [R_INSTRMPAY, 2], [R_INTCTL, 4], [R_INTSTS, 4], [R_WALCLK, 4], [R_SSYNC_OLD, 4],
    [R_SSYNC, 4], [R_CORBLBASE, 4], [R_CORBUBASE, 4], [R_CORBWP, 2], [R_CORBRP, 2], [R_CORBCTL, 1], [R_CORBSTS, 1],
    [R_CORBSIZE, 1], [R_RIRBLBASE, 4], [R_RIRBUBASE, 4], [R_RIRBWP, 2], [R_RINTCNT, 2], [R_RIRBCTL, 1], [R_RIRBSTS, 1],
    [R_RIRBSIZE, 1], [R_ICOI, 4], [R_ICII, 4], [R_ICIS, 2], [R_DPLBASE, 4], [R_DPUBASE, 4], [R_WALCLK_ALIAS, 4],
]);
const STREAM_SIZES = new Map([[SD_CTL, 3], [SD_STS, 1], [SD_LPIB, 4], [SD_CBL, 4], [SD_LVI, 2], [SD_FIFOW, 2], [SD_FIFOS, 2],
    [SD_FMT, 2], [SD_BDPL, 4], [SD_BDPU, 4]]);

/**
 * The register a byte belongs to: [its first byte, its size], or null
 * @param {number} offset
 * @return {Array<number>}
 */
function register_at(offset)
{
    const stream_area = (base, sizes) =>
    {
        const local = offset - base & 0x1F;
        for(const [start, size] of sizes)
        {
            if(local >= start && local < start + size) return [offset - local + start, size];
        }
        return null;
    };
    if(offset >= R_STREAMS && offset < R_STREAMS + STREAMS * STREAM_SIZE) return stream_area(R_STREAMS, STREAM_SIZES);
    if(offset >= R_LPIB_ALIAS && offset < R_LPIB_ALIAS + STREAMS * STREAM_SIZE) return stream_area(R_LPIB_ALIAS, new Map([[0, 4]]));
    for(const [start, size] of SIZES)
    {
        if(offset >= start && offset < start + size) return [start, size];
    }
    return null;
}

/**
 * An access of 1, 2 or 4 bytes: each register it covers, its bytes merged
 * @param {number} offset
 * @param {number} size
 * @return {number}
 */
HDAController.prototype.read = function(offset, size)
{
    let value = 0;
    for(let i = 0; i < size;)
    {
        const at = register_at(offset + i);
        if(!at) { i++; continue; }
        const [start, length] = at;
        const register = this.register(start) >>> 0;
        for(; i < size && offset + i < start + length; i++)
        {
            value |= (register >>> ((offset + i - start) << 3) & 0xFF) << (i << 3);
        }
    }
    return value >>> 0;
};

/**
 * @param {number} offset
 * @param {number} size
 * @param {number} value
 */
HDAController.prototype.write = function(offset, size, value)
{
    for(let i = 0; i < size;)
    {
        const at = register_at(offset + i);
        if(!at) { i++; continue; }
        const [start, length] = at;
        let mask = 0, bits = 0;
        for(; i < size && offset + i < start + length; i++)
        {
            const shift = (offset + i - start) << 3;
            mask |= 0xFF << shift;
            bits |= (value >>> (i << 3) & 0xFF) << shift;
        }
        this.write_register(start, bits >>> 0, mask >>> 0);
    }
};

/**
 * A write of the bytes `mask` covers
 * @param {number} offset the register's first byte
 * @param {number} bits
 * @param {number} mask
 */
HDAController.prototype.write_register = function(offset, bits, mask)
{
    const merge = old => (old & ~mask | bits & mask) >>> 0;
    const clear = old => (old & ~(bits & mask)) >>> 0;
    if(offset === R_GCTL)
    {
        this.write_gctl(merge(this.gctl));
        return;
    }
    // (in reset only GCTL is written)
    if(!(this.gctl & GCTL_CRST)) return;

    if(offset >= R_STREAMS && offset < R_STREAMS + STREAMS * STREAM_SIZE)
    {
        this.write_stream(this.streams[offset - R_STREAMS >> 5], offset - R_STREAMS & 0x1F, bits, mask);
        return;
    }
    switch(offset)
    {
        case R_WAKEEN:
            this.wakeen = merge(this.wakeen) & 0x7FFF;
            this.update_irq();
            break;
        case R_STATESTS:
            this.statests = clear(this.statests);
            this.update_irq();
            break;
        case R_GSTS:
            this.gsts = clear(this.gsts);
            break;
        case R_INTCTL:
            this.intctl = merge(this.intctl);
            this.update_irq();
            break;
        case R_SSYNC:
        case R_SSYNC_OLD:
            this.ssync = merge(this.ssync) & (1 << STREAMS) - 1;
            for(const stream of this.streams) this.update_running(stream);
            break;
        case R_CORBLBASE:
            this.corb_base[0] = merge(this.corb_base[0]) & ~0x7F;
            break;
        case R_CORBUBASE:
            this.corb_base[1] = merge(this.corb_base[1]);
            break;
        case R_CORBWP:
            this.corb_wp = merge(this.corb_wp) & 0xFF;
            this.run_corb();
            break;
        case R_CORBRP:
            if(merge(0) & CORBRP_RST)
            {
                this.corb_rp = 0;
                this.corb_rp_reset = true;
            }
            else
            {
                this.corb_rp_reset = false;
            }
            break;
        case R_CORBCTL:
            this.corbctl = merge(this.corbctl) & (CORBCTL_CMEIE | CORBCTL_RUN);
            this.run_corb();
            break;
        case R_CORBSTS:
            this.corbsts = clear(this.corbsts);
            this.update_irq();
            break;
        case R_RIRBLBASE:
            this.rirb_base[0] = merge(this.rirb_base[0]) & ~0x7F;
            break;
        case R_RIRBUBASE:
            this.rirb_base[1] = merge(this.rirb_base[1]);
            break;
        case R_RIRBWP:
            if(merge(0) & RIRBWP_RST) this.rirb_wp = 0;
            break;
        case R_RINTCNT:
            this.rintcnt = merge(this.rintcnt) & 0xFF;
            break;
        case R_RIRBCTL:
            this.rirbctl = merge(this.rirbctl) & 7;
            this.update_irq();
            this.run_corb();
            break;
        case R_RIRBSTS:
            this.rirbsts = clear(this.rirbsts);
            this.update_irq();
            break;
        case R_ICOI:
            this.icoi = merge(this.icoi);
            break;
        case R_ICIS:
        {
            const written = merge(0);
            if(written & ICIS_IRV) this.icis &= ~ICIS_IRV;
            if(written & ICIS_ICB && !(this.icis & ICIS_ICB))
            {
                // the immediate command: its response at once (without a
                // codec at that address it stays busy, the driver times out)
                this.icis |= ICIS_ICB;
                const response = this.send_command(this.icoi);
                if(response !== null)
                {
                    this.icii = response;
                    this.icis = this.icis & ~ICIS_ICB | ICIS_IRV;
                }
            }
            break;
        }
        case R_DPLBASE:
            this.dplbase = merge(this.dplbase) & ~0x7E;
            this.write_positions();
            break;
        case R_DPUBASE:
            this.dpubase = merge(this.dpubase);
            break;
    }
};

/**
 * GCTL: CRST leaves or enters the reset, the codec then asks for its
 * address (STATESTS)
 * @param {number} value
 */
HDAController.prototype.write_gctl = function(value)
{
    const was = this.gctl & GCTL_CRST;
    if(!(value & GCTL_CRST))
    {
        if(was) dbg_log("hd_audio: controller reset", LOG_DMA);
        this.reset_controller();
        this.gctl = 0;
        return;
    }
    this.gctl = value & (GCTL_CRST | GCTL_UNSOL);
    if(!was)
    {
        this.statests |= 1 << this.codec.address;
        this.update_irq();
    }
};

// commands to the codec

/**
 * @param {number} command
 * @return {?number} the response, null without a codec at that address
 */
HDAController.prototype.send_command = function(command)
{
    if(command >>> 28 !== this.codec.address) return null;
    return this.codec.command(command) >>> 0;
};

/** The CORB's commands up to CORBWP, their responses into the RIRB */
HDAController.prototype.run_corb = function()
{
    while(this.corbctl & CORBCTL_RUN && this.corb_rp !== this.corb_wp)
    {
        if(!this.machine.is_bus_master()) return;
        const rp = this.corb_rp + 1 & 0xFF;
        const command = this.dma_read32(ring_address(this.corb_base) + 4 * rp);
        this.corb_rp = rp;
        const response = command === null ? null : this.send_command(command);
        if(response !== null) this.respond(response);
    }
};

/**
 * A response into the RIRB; RINTFL when RINTCNT responses are there or the
 * CORB is empty
 * @param {number} response
 */
HDAController.prototype.respond = function(response)
{
    if(!(this.rirbctl & RIRBCTL_DMAEN)) return;
    const wp = this.rirb_wp + 1 & 0xFF;
    const address = ring_address(this.rirb_base) + 8 * wp;
    const entry = new Uint8Array(8);
    new DataView(entry.buffer).setUint32(0, response, true);
    // (the extended response: the codec's address, solicited)
    entry[4] = this.codec.address;
    this.dma_write(entry, address);
    this.rirb_wp = wp;
    this.rirb_count++;
    if(this.rirb_count >= (this.rintcnt || 256) || this.corb_rp === this.corb_wp)
    {
        this.rirb_count = 0;
        if(this.rirbctl & RIRBCTL_RINTCTL)
        {
            this.rirbsts |= RIRBSTS_RINTFL;
            this.update_irq();
        }
    }
};

/**
 * @param {!Array<number>} base [low, high]
 * @return {number}
 */
function ring_address(base)
{
    return (base[1] >>> 0) * 0x100000000 + (base[0] >>> 0);
}

// interrupts

/** INTSTS: the streams' bits, the controller's (CIS), and GIS */
HDAController.prototype.interrupt_status = function()
{
    let status = 0;
    if(this.rirbsts & (RIRBSTS_RINTFL | RIRBSTS_OIS) || this.statests & this.wakeen || this.corbsts & this.corbctl & CORBCTL_CMEIE)
    {
        status |= INT_CIE;
    }
    for(const stream of this.streams)
    {
        const enabled = (stream.ctl & SD_CTL_IOCE ? SD_STS_BCIS : 0) | (stream.ctl & SD_CTL_FEIE ? SD_STS_FIFOE : 0) |
            (stream.ctl & SD_CTL_DEIE ? SD_STS_DESE : 0);
        if(stream.sts & enabled) status |= 1 << stream.index;
    }
    if(status & this.intctl) status |= INT_GIE;
    return status >>> 0;
};

HDAController.prototype.update_irq = function()
{
    const level = !!(this.interrupt_status() & INT_GIE && this.intctl & INT_GIE);
    if(level === this.irq_level) return;
    this.irq_level = level;
    if(level) this.machine.raise_irq();
    else this.machine.lower_irq();
};

// streams

/**
 * @param {Object} stream
 * @param {number} local the register's offset in the descriptor
 * @param {number} bits
 * @param {number} mask
 */
HDAController.prototype.write_stream = function(stream, local, bits, mask)
{
    const merge = old => (old & ~mask | bits & mask) >>> 0;
    switch(local)
    {
        case SD_CTL:
        {
            const value = merge(stream.ctl) & 0xFF001F;
            if(value & SD_CTL_SRST)
            {
                // in reset: the descriptor to its defaults, SRST reads 1
                this.stop(stream);
                Object.assign(stream, new_stream(stream.index), { ctl: SD_CTL_SRST });
                this.update_irq();
                return;
            }
            stream.ctl = value;
            this.update_running(stream);
            this.update_irq();
            break;
        }
        case SD_STS:
            stream.sts &= ~(bits & mask & (SD_STS_BCIS | SD_STS_FIFOE | SD_STS_DESE));
            this.update_irq();
            break;
        case SD_CBL:
            if(!stream.running) stream.cbl = merge(stream.cbl);
            break;
        case SD_LVI:
            if(!stream.running) stream.lvi = merge(stream.lvi) & 0xFF;
            break;
        case SD_FIFOW:
            stream.fifow = merge(stream.fifow) & 7;
            break;
        case SD_FMT:
            if(!stream.running) stream.fmt = merge(stream.fmt) & 0x7F7F;
            break;
        case SD_BDPL:
            if(!stream.running) stream.bdpl = merge(stream.bdpl) & ~0x7F;
            break;
        case SD_BDPU:
            if(!stream.running) stream.bdpu = merge(stream.bdpu);
            break;
    }
};

/**
 * The stream runs while RUN is set and SSYNC does not hold it
 * @param {Object} stream
 */
HDAController.prototype.update_running = function(stream)
{
    const run = !!(stream.ctl & SD_CTL_RUN) && !(this.ssync & 1 << stream.index);
    if(run === stream.running) return;
    if(run)
    {
        stream.running = true;
        stream.started = this.machine.now();
        stream.played = 0;
        if(stream.output)
        {
            const { rate } = decode_format(stream.fmt);
            if(rate !== this.speaker_rate)
            {
                this.speaker_rate = rate;
                this.machine.set_sampling_rate(rate);
            }
            this.machine.enable_output();
        }
        dbg_log("hd_audio: stream " + stream.index + " runs: format " + h(stream.fmt, 4) + ", " + stream.cbl + " bytes in " +
            (stream.lvi + 1) + " descriptors", LOG_DMA);
        // (what is due now: nothing yet; the timer plays it)
        this.machine.wake();
    }
    else
    {
        this.play(stream, this.machine.now());
        this.stop(stream);
    }
};

/** @param {Object} stream */
HDAController.prototype.stop = function(stream)
{
    if(!stream.running) return;
    stream.running = false;
    if(stream.output && !this.streams.some(other => other !== stream && other.running && other.output))
    {
        this.machine.disable_output();
    }
};

/**
 * The machine's timers run: each running stream plays what is due
 * @param {number} now
 * @return {number} milliseconds until it needs to run again
 */
HDAController.prototype.timer = function(now)
{
    let next = 100;
    for(const stream of this.streams)
    {
        if(!stream.running) continue;
        this.play(stream, now);
        next = Math.min(next, this.time_to_boundary(stream, now));
    }
    return next;
};

/**
 * Until the current descriptor's end (its completion interrupt), at most
 * 10 ms (the speaker's next samples)
 * @param {Object} stream
 * @param {number} now
 * @return {number}
 */
HDAController.prototype.time_to_boundary = function(stream, now)
{
    const { rate, bytes, channels } = decode_format(stream.fmt);
    const entry = this.descriptor(stream, stream.entry);
    const left = entry ? Math.max(0, entry.length - stream.offset) / (bytes * channels) : 0;
    const due_at = stream.started + (stream.played + left) / rate * 1000;
    return Math.max(0.5, Math.min(10, due_at - now));
};

/**
 * A buffer descriptor: address, length, IOC
 * @param {Object} stream
 * @param {number} index
 * @return {?{address: number, length: number, ioc: boolean}}
 */
HDAController.prototype.descriptor = function(stream, index)
{
    const base = (stream.bdpu >>> 0) * 0x100000000 + (stream.bdpl >>> 0);
    const bytes = this.dma_read(base + 16 * index, 16);
    if(!bytes) return null;
    const view = new DataView(bytes.buffer);
    return {
        address: view.getUint32(4, true) * 0x100000000 + view.getUint32(0, true),
        length: view.getUint32(8, true),
        ioc: !!(view.getUint32(12, true) & 1),
    };
};

/**
 * Read (output) what the stream's time has come for, from its descriptors
 * in order: LPIB, the completion interrupts, the samples to the speaker
 * @param {Object} stream
 * @param {number} now
 */
HDAController.prototype.play = function(stream, now)
{
    if(!stream.running || !stream.output) return;
    if(!this.machine.is_bus_master()) return;
    const { rate, bytes, channels } = decode_format(stream.fmt);
    const frame_bytes = bytes * channels;
    let due = Math.floor((now - stream.started) / 1000 * rate) - stream.played;
    if(due <= 0) return;
    if(due > rate * MAX_PLAY_MS / 1000)
    {
        // (the host stalled: the stream's clock goes on, the samples of the gap are not kept)
        const skip = due - Math.floor(rate * MAX_PLAY_MS / 1000);
        stream.started += skip / rate * 1000;
        due -= skip;
    }
    const chunks = [];
    let interrupt = false, guard = 0;
    while(due > 0 && guard++ < 1024)
    {
        const entry = this.descriptor(stream, stream.entry);
        if(!entry || entry.length < frame_bytes)
        {
            // a bad list: descriptor error, the stream stops
            stream.sts |= SD_STS_DESE;
            stream.ctl &= ~SD_CTL_RUN;
            this.stop(stream);
            interrupt = true;
            break;
        }
        const take = Math.min(due * frame_bytes, entry.length - stream.offset);
        const count = take - take % frame_bytes;
        if(count > 0)
        {
            const data = this.dma_read(entry.address + stream.offset, count);
            chunks.push(data || new Uint8Array(count));
            stream.offset += count;
            stream.played += count / frame_bytes;
            due -= count / frame_bytes;
            stream.lpib += count;
            if(stream.lpib >= stream.cbl) stream.lpib = stream.cbl ? stream.lpib % stream.cbl : 0;
        }
        if(stream.offset + frame_bytes > entry.length)
        {
            // the descriptor is done
            if(entry.ioc)
            {
                stream.sts |= SD_STS_BCIS;
                interrupt = true;
            }
            stream.offset = 0;
            stream.entry = stream.entry >= stream.lvi ? 0 : stream.entry + 1;
        }
    }
    this.write_positions();
    if(chunks.length) this.output(stream, chunks, bytes, channels);
    if(interrupt) this.update_irq();
};

/** The DMA position buffer: each stream's LPIB (DPLBASE.enable) */
HDAController.prototype.write_positions = function()
{
    if(!(this.dplbase & DPLBASE_ENABLE) || !this.machine.is_bus_master()) return;
    const base = (this.dpubase >>> 0) * 0x100000000 + ((this.dplbase & ~0x7F) >>> 0);
    const bytes = new Uint8Array(8 * STREAMS);
    const view = new DataView(bytes.buffer);
    for(const stream of this.streams) view.setUint32(8 * stream.index, stream.lpib, true);
    this.dma_write(bytes, base);
};

/**
 * Samples to the speaker, through the codec's DAC: its stream, gains, the pin
 * @param {Object} stream
 * @param {!Array<!Uint8Array>} chunks
 * @param {number} bytes per sample
 * @param {number} channels
 */
HDAController.prototype.output = function(stream, chunks, bytes, channels)
{
    const tag = stream.ctl >>> 20 & 0xF;
    const gains = this.codec.output_for(tag) || [0, 0];
    let frames = 0;
    for(const chunk of chunks) frames += chunk.length / (bytes * channels);
    const left = new Float32Array(frames), right = new Float32Array(frames);
    // (the DAC's first channel and the next)
    const first = Math.min(this.codec.channel, channels - 1), second = Math.min(this.codec.channel + 1, channels - 1);
    let at = 0;
    for(const chunk of chunks)
    {
        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for(let offset = 0; offset < chunk.length; offset += bytes * channels, at++)
        {
            left[at] = sample(view, offset + first * bytes, bytes) * gains[0];
            right[at] = sample(view, offset + second * bytes, bytes) * gains[1];
        }
    }
    this.machine.output(left, right, { "stream": stream.index, "format": stream.fmt, "tag": tag, "chunks": chunks });
};

/**
 * @param {!DataView} view
 * @param {number} offset
 * @param {number} bytes
 * @return {number} in [-1, 1)
 */
function sample(view, offset, bytes)
{
    if(bytes === 2) return view.getInt16(offset, true) / 32768;
    if(bytes === 4) return view.getInt32(offset, true) / 2147483648;
    return (view.getUint8(offset) - 128) / 128;
}

// DMA

/**
 * @param {number} address
 * @param {number} length
 * @return {Uint8Array}
 */
HDAController.prototype.dma_read = function(address, length)
{
    try
    {
        return this.machine.read_physical(address, length);
    }
    catch(e)
    {
        dbg_log("hd_audio: DMA read outside memory at " + h(address, 9), LOG_DMA);
        return null;
    }
};

/**
 * @param {number} address
 * @return {?number}
 */
HDAController.prototype.dma_read32 = function(address)
{
    const bytes = this.dma_read(address, 4);
    return bytes ? (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0 : null;
};

/**
 * @param {!Uint8Array} bytes
 * @param {number} address
 */
HDAController.prototype.dma_write = function(bytes, address)
{
    try
    {
        this.machine.write_physical(bytes, address);
    }
    catch(e)
    {
        dbg_log("hd_audio: DMA write outside memory at " + h(address, 9), LOG_DMA);
    }
};

/** The wall clock (24 MHz) since the controller's reset */
HDAController.prototype.wallclock = function()
{
    return Math.floor((this.machine.now() - this.wall_base) * WALLCLK_PER_MS) >>> 0;
};

// snapshots

HDAController.prototype.get_state = function()
{
    const now = this.machine.now();
    return [
        new Int32Array([this.gctl, this.wakeen, this.statests, this.gsts, this.intctl, this.ssync,
            this.corb_base[0], this.corb_base[1], this.corb_wp, this.corb_rp, +this.corb_rp_reset, this.corbctl, this.corbsts,
            this.rirb_base[0], this.rirb_base[1], this.rirb_wp, this.rintcnt, this.rirbctl, this.rirbsts, this.rirb_count,
            this.icoi, this.icii, this.icis, this.dplbase, this.dpubase, this.bar0, +this.irq_level, this.speaker_rate]),
        // (times relative to now: the machine clock is restored with the snapshot)
        now - this.wall_base,
        this.streams.map(s => [s.ctl, s.sts, s.lpib, s.cbl, s.lvi, s.fifow, s.fmt, s.bdpl, s.bdpu,
            s.entry, s.offset, now - s.started, s.played, +s.running]),
        this.codec.get_state(),
    ];
};

HDAController.prototype.set_state = function(state)
{
    const r = state[0];
    [this.gctl, this.wakeen, this.statests, this.gsts, this.intctl, this.ssync] = r;
    this.corb_base = [r[6], r[7]];
    [this.corb_wp, this.corb_rp] = [r[8], r[9]];
    this.corb_rp_reset = !!r[10];
    [this.corbctl, this.corbsts] = [r[11], r[12]];
    this.rirb_base = [r[13], r[14]];
    [this.rirb_wp, this.rintcnt, this.rirbctl, this.rirbsts, this.rirb_count] = r.slice(15, 20);
    [this.icoi, this.icii, this.icis, this.dplbase, this.dpubase] = r.slice(20, 25);
    this.bar0 = r[25] >>> 0;
    this.irq_level = !!r[26];
    this.speaker_rate = r[27];
    const now = this.machine.now();
    this.wall_base = now - state[1];
    this.streams = state[2].map((s, index) => Object.assign(new_stream(index), {
        ctl: s[0], sts: s[1], lpib: s[2], cbl: s[3], lvi: s[4], fifow: s[5], fmt: s[6], bdpl: s[7], bdpu: s[8],
        entry: s[9], offset: s[10], started: now - s[11], played: s[12], running: !!s[13],
    }));
    this.codec.set_state(state[3]);
    // (the speaker starts again with the stream's samples from now on)
    if(this.streams.some(s => s.running && s.output))
    {
        this.machine.set_sampling_rate(this.speaker_rate);
        this.machine.enable_output();
    }
    if(this.irq_level) this.machine.raise_irq();
    else this.machine.lower_irq();
    this.update_decode();
};
