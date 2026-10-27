// The Intel 82540EM Gigabit Ethernet controller (PRO/1000 MT Desktop,
// 8086:100E, subsystem 8086:001E): the card Windows Vista to 11 and Linux
// drive with their own drivers (nete1g3e.inf, e1000.ko). See
// docs/modern-pc-devices-plan.md, "N1", and the PCI/PCI-X Family of Gigabit
// Ethernet Controllers Software Developer's Manual (8254x); QEMU's e1000.c
// and VirtualBox's DevE1000.cpp were the references for what drivers expect.
//
// BAR0 holds the registers (128 KiB), BAR1 the I/O window (IOADDR/IODATA).
// Transmit and receive use descriptor rings in guest memory; this model
// moves frames between them and the network bus synchronously: a write of
// TDT sends what is queued, a frame from the network goes straight into the
// receive ring. What waits (receive delay timers, interrupt throttling,
// auto-negotiation, frames that found no free descriptor) waits on the
// machine clock, through the device's timer.

import { LOG_NET } from "../../const.js";
import { h } from "../../lib.js";
import { dbg_log } from "../../log.js";
import { format_mac, random_mac, translate_mac_address } from "../../mac_address.js";
import { NetMachine } from "../machine.js";
import { CHECKSUM_BAD, CHECKSUM_GOOD, CHECKSUM_NONE, check_checksums, checksum_add, checksum_finish, checksum_fold,
    ethernet_fcs, load16, load32, store16, store32 } from "../offload.js";

const MMIO_SIZE = 0x20000;
const IO_SIZE = 0x40;

const PCI_VENDOR = 0x8086;
const PCI_DEVICE = 0x100E;
const PCI_SUBSYSTEM = 0x001E;
const PCI_REVISION = 0x02;
/** The power management capability (the 82540EM has no MSI) */
const PM_CAP = 0xDC;
const PM_PMC = 0xC822;

// registers (byte offsets in BAR0)
const CTRL = 0x0000, STATUS = 0x0008, EECD = 0x0010, EERD = 0x0014, CTRL_EXT = 0x0018, FLA = 0x001C, MDIC = 0x0020,
    FCAL = 0x0028, FCAH = 0x002C, FCT = 0x0030, VET = 0x0038,
    ICR = 0x00C0, ITR = 0x00C4, ICS = 0x00C8, IMS = 0x00D0, IMC = 0x00D8,
    RCTL = 0x0100, FCTTV = 0x0170, TXCW = 0x0178, RXCW = 0x0180, TCTL = 0x0400, TIPG = 0x0410, AIT = 0x0458,
    LEDCTL = 0x0E00, PBA = 0x1000, FCRTL = 0x2160, FCRTH = 0x2168,
    RDFH = 0x2410, RDFT = 0x2418, RDFHS = 0x2420, RDFTS = 0x2428, RDFPC = 0x2430,
    RDBAL = 0x2800, RDBAH = 0x2804, RDLEN = 0x2808, RDH = 0x2810, RDT = 0x2818, RDTR = 0x2820, RXDCTL = 0x2828, RADV = 0x282C,
    RSRPD = 0x2C00,
    TDFH = 0x3410, TDFT = 0x3418, TDFHS = 0x3420, TDFTS = 0x3428, TDFPC = 0x3430,
    TDBAL = 0x3800, TDBAH = 0x3804, TDLEN = 0x3808, TDH = 0x3810, TDT = 0x3818, TIDV = 0x3820, TXDCTL = 0x3828, TADV = 0x382C,
    RXCSUM = 0x5000, MTA = 0x5200, RA = 0x5400, VFTA = 0x5600,
    WUC = 0x5800, WUFC = 0x5808, WUS = 0x5810, MANC = 0x5820, IPAV = 0x5838, IP4AT = 0x5840, IP6AT = 0x5880,
    WUPL = 0x5900, WUPM = 0x5A00, FFLT = 0x5F00, FFMT = 0x9000, FFVT = 0x9800;

// statistics (all read to clear; a 64-bit counter clears when its high half is read)
const STATS_START = 0x4000, STATS_END = 0x4100;
const MPC = 0x4010, GPRC = 0x4074, BPRC = 0x4078, MPRC = 0x407C, GPTC = 0x4080,
    GORCL = 0x4088, GORCH = 0x408C, GOTCL = 0x4090, GOTCH = 0x4094, RNBC = 0x40A0, ROC = 0x40AC,
    TORL = 0x40C0, TORH = 0x40C4, TOTL = 0x40C8, TOTH = 0x40CC, TPR = 0x40D0, TPT = 0x40D4,
    MPTC = 0x40F0, BPTC = 0x40F4, TSCTC = 0x40F8;
const PRC_SIZES = [0x405C, 0x4060, 0x4064, 0x4068, 0x406C, 0x4070];
const PTC_SIZES = [0x40D8, 0x40DC, 0x40E0, 0x40E4, 0x40E8, 0x40EC];

// CTRL
const CTRL_FD = 1 << 0, CTRL_SLU = 1 << 6, CTRL_SPD_1000 = 2 << 8, CTRL_SWDPIN0 = 1 << 18, CTRL_SWDPIN2 = 1 << 20,
    CTRL_RST = 1 << 26, CTRL_VME = 1 << 30, CTRL_PHY_RST = 1 << 31;
// STATUS
const STATUS_FD = 1 << 0, STATUS_LU = 1 << 1, STATUS_SPEED_1000 = 2 << 6, STATUS_ASDV_1000 = 3 << 8, STATUS_MTXCKOK = 1 << 10,
    STATUS_GIO_MASTER_ENABLE = 1 << 19;
// EECD
const EECD_SK = 1 << 0, EECD_CS = 1 << 1, EECD_DI = 1 << 2, EECD_DO = 1 << 3, EECD_FWE = 3 << 4, EECD_REQ = 1 << 6,
    EECD_GNT = 1 << 7, EECD_PRES = 1 << 8;
const EECD_WRITABLE = EECD_SK | EECD_CS | EECD_DI | EECD_FWE | EECD_REQ;
const EEPROM_READ_OPCODE = 6;
// EERD
const EERD_START = 1 << 0, EERD_DONE = 1 << 4;
// MDIC
const MDIC_OP_WRITE = 1, MDIC_OP_READ = 2, MDIC_READY = 1 << 28, MDIC_INT_EN = 1 << 29, MDIC_ERROR = 1 << 30;
// interrupt causes (ICR, ICS, IMS, IMC)
const ICR_TXDW = 1 << 0, ICR_TXQE = 1 << 1, ICR_LSC = 1 << 2, ICR_RXDMT0 = 1 << 4, ICR_RXO = 1 << 6, ICR_RXT0 = 1 << 7,
    ICR_MDAC = 1 << 9;
const ICR_MASK = 0x0001F6DF;
// RCTL
const RCTL_EN = 1 << 1, RCTL_SBP = 1 << 2, RCTL_UPE = 1 << 3, RCTL_MPE = 1 << 4, RCTL_LPE = 1 << 5, RCTL_LBM = 3 << 6,
    RCTL_BAM = 1 << 15, RCTL_VFE = 1 << 18, RCTL_BSEX = 1 << 25, RCTL_SECRC = 1 << 26;
// TCTL
const TCTL_EN = 1 << 1;
// RXCSUM
const RXCSUM_IPOFL = 1 << 8, RXCSUM_TUOFL = 1 << 9;
// RAH
const RAH_AV = 1 << 31;
// (RDTR, TIDV) flush partial descriptor block: the delay ends now
const DELAY_FPD = 1 << 31;

// transmit descriptors: the command byte (bits 24-31 of the second dword)
const TXD_EOP = 1 << 24, TXD_IC = 1 << 26, TXD_TSE = 1 << 26, TXD_RS = 1 << 27, TXD_RPS = 1 << 28, TXD_DEXT = 1 << 29,
    TXD_VLE = 1 << 30, TXD_IDE = 1 << 31, TXD_DTYP_D = 1 << 20;
// a context descriptor's TUCMD
const TXD_CMD_TCP = 1 << 24, TXD_CMD_IP = 1 << 25;
// a data descriptor's POPTS
const POPTS_IXSM = 1, POPTS_TXSM = 2;
// a descriptor's status
const TXD_STAT_DD = 1;

// receive descriptor status and errors
const RXD_STAT_DD = 1 << 0, RXD_STAT_EOP = 1 << 1, RXD_STAT_IXSM = 1 << 2, RXD_STAT_VP = 1 << 3, RXD_STAT_TCPCS = 1 << 5,
    RXD_STAT_IPCS = 1 << 6;
const RXD_ERR_TCPE = 1 << 5, RXD_ERR_IPE = 1 << 6;

// the PHY (Marvell 88E1011, as on the 82540EM), at MDIO address 1
const PHY_ADDRESS = 1;
const MII_BMCR = 0, MII_BMSR = 1, MII_PHYID1 = 2, MII_PHYID2 = 3, MII_ANAR = 4, MII_ANLPAR = 5, MII_ANER = 6,
    MII_CTRL1000 = 9, MII_STAT1000 = 10, MII_EXTSTAT = 15,
    M88_PHY_SPEC_CTRL = 0x10, M88_PHY_SPEC_STATUS = 0x11, M88_INT_STATUS = 0x13, M88_EXT_PHY_SPEC_CTRL = 0x14,
    M88_RX_ERR_CNTR = 0x15;
const BMCR_RESET = 1 << 15, BMCR_LOOPBACK = 1 << 14, BMCR_AUTOEN = 1 << 12, BMCR_ANRESTART = 1 << 9;
const BMSR_LINK = 1 << 2, BMSR_AN_COMP = 1 << 5;
const ANLPAR_ACK = 1 << 14;
const M88_STATUS_LINK = 1 << 10;
const PHY_READ_ONLY = [MII_BMSR, MII_PHYID1, MII_PHYID2, MII_ANLPAR, MII_ANER, MII_STAT1000, MII_EXTSTAT,
    M88_PHY_SPEC_STATUS, M88_INT_STATUS, M88_RX_ERR_CNTR];
const PHY_INIT = new Map([
    [MII_BMCR, 0x1140], [MII_BMSR, 0x796D], [MII_PHYID1, 0x0141], [MII_PHYID2, 0x0C20], [MII_ANAR, 0x0DE1],
    [MII_ANLPAR, 0x01E0 | ANLPAR_ACK], [MII_ANER, 0x0001], [MII_CTRL1000, 0x0E00], [MII_STAT1000, 0x3C00], [MII_EXTSTAT, 0x3000],
    [M88_PHY_SPEC_CTRL, 0x0360], [M88_PHY_SPEC_STATUS, 0xAC00], [M88_EXT_PHY_SPEC_CTRL, 0x0D60],
]);
/** How long auto-negotiation takes after a restart */
const AUTONEG_MS = 100;

/** The EEPROM's 64 words (QEMU's template); the address, IDs and checksum are filled in */
const EEPROM_TEMPLATE = [
    0x0000, 0x0000, 0x0000, 0x0000, 0xFFFF, 0x0000, 0x0000, 0x0000,
    0x3000, 0x1000, 0x6403, PCI_SUBSYSTEM, PCI_VENDOR, PCI_DEVICE, PCI_VENDOR, 0x3040,
    0x0008, 0x2000, 0x7E14, 0x0048, 0x1000, 0x00D8, 0x0000, 0x2700,
    0x6CC9, 0x3150, 0x0722, 0x040B, 0x0984, 0x0000, 0xC000, 0x0706,
    0x1008, 0x0000, 0x0F04, 0x7FFF, 0x4D01, 0xFFFF, 0xFFFF, 0xFFFF,
    0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF,
    0x0100, 0x4000, 0x121C, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF,
    0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0x0000,
];
const EEPROM_WORDS = 64;
const EEPROM_CHECKSUM = 0xBABA;

/** A transmitted frame is gathered here (and a TSO segment); longer ones are cut */
const TX_BUFFER_SIZE = 0x10000;
/** Per round: descriptors and bytes, the rest in the next (the timer's) */
const TX_DESCRIPTOR_BUDGET = 256;
const TX_BYTE_BUDGET = 1 << 20;

/** The 802.3 limits: a frame without its FCS */
const MIN_FRAME = 60;
const MAX_FRAME = 1518;
const MAX_LONG_FRAME = 16384 - 4;

/** The machine clock is in milliseconds: ITR counts 256 ns, the delay timers 1.024 µs */
const ITR_UNIT = 256e-6;
const DELAY_UNIT = 1.024e-3;

// a context's fields (Int32Array)
const P_IPCSS = 0, P_IPCSO = 1, P_IPCSE = 2, P_TUCSS = 3, P_TUCSO = 4, P_TUCSE = 5, P_PAYLEN = 6, P_HDRLEN = 7, P_MSS = 8,
    P_IP = 9, P_TCP = 10, PROPS_SIZE = 11;

// deadlines (Float64Array, machine time; 0 when not set)
const T_AUTONEG = 0, T_RX_PACKET = 1, T_RX_ABSOLUTE = 2, T_TX_PACKET = 3, T_TX_ABSOLUTE = 4, T_ITR = 5, T_COUNT = 6;

// What the registers are, by dword: plain storage, a statistic, or handled
// in read/write (everything else reads 0 and ignores writes)
const REG_PLAIN = 1, REG_STAT = 2, REG_STAT_LOW = 3, REG_STAT_HIGH = 4, REG_SPECIAL = 5;
const REG_KIND = new Uint8Array(MMIO_SIZE >> 2);
{
    const mark = (offset, kind, count = 1) => REG_KIND.fill(kind, offset >> 2, (offset >> 2) + count);
    for(const offset of [CTRL_EXT, FLA, FCAL, FCAH, FCT, VET, FCTTV, TXCW, RXCW, TIPG, AIT, LEDCTL, PBA, FCRTL, FCRTH,
        RDFH, RDFT, RDFHS, RDFTS, RDFPC, RDBAL, RDBAH, RXDCTL, RSRPD, TDFH, TDFT, TDFHS, TDFTS, TDFPC, TDBAL, TDBAH, TXDCTL,
        RXCSUM, WUC, WUFC, MANC, IPAV, WUPL])
    {
        mark(offset, REG_PLAIN);
    }
    mark(MTA, REG_PLAIN, 128);
    mark(VFTA, REG_PLAIN, 128);
    mark(IP4AT, REG_PLAIN, 7);
    mark(IP6AT, REG_PLAIN, 4);
    mark(WUPM, REG_PLAIN, 32);
    mark(FFLT, REG_PLAIN, 8);
    mark(FFMT, REG_PLAIN, 256);
    mark(FFVT, REG_PLAIN, 256);
    mark(STATS_START, REG_STAT, (STATS_END - STATS_START) >> 2);
    for(const low of [GORCL, GOTCL, TORL, TOTL])
    {
        mark(low, REG_STAT_LOW);
        mark(low + 4, REG_STAT_HIGH);
    }
    for(const offset of [CTRL, STATUS, EECD, EERD, MDIC, ICR, ITR, ICS, IMS, IMC, RCTL, TCTL, RDLEN, RDH, RDT, RDTR, RADV,
        TDLEN, TDH, TDT, TIDV, TADV, WUS])
    {
        mark(offset, REG_SPECIAL);
    }
    mark(RA, REG_SPECIAL, 32);
}

/** The values after a reset (the rest is 0) */
const REG_INIT = new Map([
    [CTRL, CTRL_SWDPIN2 | CTRL_SWDPIN0 | CTRL_SPD_1000 | CTRL_SLU | CTRL_FD],
    [STATUS, STATUS_GIO_MASTER_ENABLE | STATUS_ASDV_1000 | STATUS_MTXCKOK | STATUS_SPEED_1000 | STATUS_FD | STATUS_LU],
    [EECD, EECD_PRES | EECD_GNT],
    [PBA, 0x00100030],
    [LEDCTL, 0x07068302],
    [TIPG, 0x00602008],
    [RXCSUM, RXCSUM_IPOFL | RXCSUM_TUOFL],
    [TXDCTL, 0x00010000],
    [RXDCTL, 0x00010000],
    [MANC, 0x00222300],
]);

/**
 * @constructor
 * @param {!Object} handle the machine handle (src/device_plugin.js)
 * @param {!Object} options "preserve_mac_from_state_image", "mac_address_translation"
 */
export function E1000(handle, options)
{
    const machine = new NetMachine(handle);
    /** @const @type {NetMachine} */
    this.machine = machine;
    this.name = "e1000";

    this.preserve_mac_from_state_image = !!options["preserve_mac_from_state_image"];
    this.mac_address_translation = !!options["mac_address_translation"];

    /** The card's own address (the one the network knows) */
    this.mac = random_mac();
    /** After restoring with mac_address_translation: the address the guest has */
    this.mac_in_state = null;

    this.regs = new Int32Array(MMIO_SIZE >> 2);
    this.phy = new Uint16Array(32);
    this.eeprom = new Uint16Array(EEPROM_WORDS);
    this.write_eeprom_address();

    // the EEPROM's serial interface (EECD): bits shifted in, the word shifted out
    this.eecd_bits = 0;
    this.eecd_in = 0;
    this.eecd_in_count = 0;
    this.eecd_out = 0;
    this.eecd_reading = false;

    // the transmit side: the frame being gathered, the contexts of offload
    this.tx_data = new Uint8Array(TX_BUFFER_SIZE);
    this.tx_header = new Uint8Array(256);
    this.tx_size = 0;
    this.tx_props = new Int32Array(PROPS_SIZE);
    this.tx_tso_props = new Int32Array(PROPS_SIZE);
    this.tx_sum_needed = 0;
    this.tx_vlan_tag = -1;
    this.tx_tse = false;
    this.tx_tso_frames = 0;
    /** a legacy descriptor's checksum (IC): [CSO, CSS], or null */
    this.tx_legacy_sum = null;
    /** the ring has more than one round's budget: the timer goes on */
    this.tx_more = false;
    /** the descriptors since the last TXDW had IDE (the delay timers apply) */
    this.tx_ide = false;
    /** what this round sent (TX_BYTE_BUDGET) */
    this.tx_bytes = 0;

    /** Frames that found no free descriptor (the receive FIFO, PBA's size) */
    this.rx_fifo = [];
    this.rx_fifo_bytes = 0;

    this.deadlines = new Float64Array(T_COUNT);
    /** INTA as the card drives it */
    this.irq_level = false;
    /** a rising edge waits for ITR's interval */
    this.irq_held = false;

    this.io_base = machine.allocate_io(IO_SIZE);
    this.io_address = 0;
    /** Where BAR0 is decoded, or -1 */
    this.mmio = -1;
    this.bar0 = 0;

    this.reset_registers();
    this.reset_phy();

    this.register_ports();
    machine.register_pci({
        pci_space: this.create_pci_space(),
        pci_bars: [
            { size: MMIO_SIZE, on_move: base => { this.bar0 = base; this.update_decode(); } },
            { size: IO_SIZE, on_move: undefined },
        ],
        on_command_change: () => { this.update_decode(); this.resume_dma(); },
        on_config_restore: () => this.update_decode(),
        on_upstream_change: () => { this.update_decode(); this.resume_dma(); },
        on_config_write: (offset, size) => this.config_written(offset, size),
    });

    machine.on_receive(frame => this.receive(frame));
    machine.add_timer(now => this.timer(now));
    machine.set_mac(format_mac(this.mac));
    dbg_log("e1000: MAC " + format_mac(this.mac), LOG_NET);
}

E1000.prototype.create_pci_space = function()
{
    const space = new Array(256).fill(0);
    const put16 = (offset, value) => { space[offset] = value & 0xFF; space[offset + 1] = value >> 8 & 0xFF; };
    const put32 = (offset, value) => { put16(offset, value & 0xFFFF); put16(offset + 2, value >>> 16); };
    put16(0x00, PCI_VENDOR);
    put16(0x02, PCI_DEVICE);
    // status: a capabilities list, medium DEVSEL timing
    put16(0x06, 0x0210);
    // revision, class 02/00/00 (Ethernet)
    put32(0x08, PCI_REVISION | 0x02000000);
    put32(0x10, 0);
    put32(0x14, this.io_base | 1);
    put16(0x2C, PCI_VENDOR);
    put16(0x2E, PCI_SUBSYSTEM);
    space[0x34] = PM_CAP;
    // INTA, MIN_GNT
    space[0x3D] = 1;
    space[0x3E] = 0xFF;
    space[PM_CAP] = 0x01;
    put16(PM_CAP + 2, PM_PMC);
    return space;
};

/**
 * A write beyond the header: the power management capability keeps its
 * read-only bytes; PMCSR has its power state and PME enable
 */
E1000.prototype.config_written = function(offset, size)
{
    if(offset + size <= PM_CAP || offset >= PM_CAP + 8) return;
    const space = this.machine.pci_config();
    const pmcsr = (space[PM_CAP + 4] | space[PM_CAP + 5] << 8) & 0x0103;
    space.set([0x01, 0x00, PM_PMC & 0xFF, PM_PMC >> 8, pmcsr & 0xFF, pmcsr >> 8, 0, 0], PM_CAP);
};

/** BAR0 is mapped where it is decoded (memory space on, the bridges upstream forward it) */
E1000.prototype.update_decode = function()
{
    const base = this.bar0 && this.machine.memory_decoded(this.bar0, MMIO_SIZE) ? this.bar0 : -1;
    if(base === this.mmio) return;
    if(this.mmio !== -1)
    {
        this.machine.mmap_unregister_range(this.mmio, MMIO_SIZE);
    }
    dbg_log("e1000: registers " + (base === -1 ? "not decoded" : "at " + h(base >>> 0, 8)), LOG_NET);
    this.mmio = base;
    if(base !== -1)
    {
        this.machine.mmap_register_range(base, MMIO_SIZE,
            address => this.peek(address - this.mmio & ~3) >>> ((address & 3) << 3) & 0xFF,
            (address, value) => this.write_byte(address - this.mmio, value),
            address => this.read(address - this.mmio),
            (address, value) => this.write(address - this.mmio, value));
    }
};

E1000.prototype.register_ports = function()
{
    const machine = this.machine;
    // IOADDR: the register IODATA reaches
    machine.register_read(this.io_base, this,
        function(port) { return this.io_address >>> ((port & 3) << 3) & 0xFF; }, undefined,
        function(port) { return this.io_address; });
    machine.register_write(this.io_base, this, undefined, undefined,
        function(value) { this.io_address = value & 0x1FFFC; });
    machine.register_read(this.io_base + 4, this,
        function(port) { return this.peek(this.io_address) >>> ((port & 3) << 3) & 0xFF; }, undefined,
        function(port) { return this.read(this.io_address); });
    machine.register_write(this.io_base + 4, this, undefined, undefined,
        function(value) { this.write(this.io_address, value); });
};

/** The address in the EEPROM's first words (and its checksum) */
E1000.prototype.write_eeprom_address = function()
{
    this.eeprom.set(EEPROM_TEMPLATE);
    const mac = this.mac;
    this.eeprom[0] = mac[0] | mac[1] << 8;
    this.eeprom[1] = mac[2] | mac[3] << 8;
    this.eeprom[2] = mac[4] | mac[5] << 8;
    this.update_eeprom_checksum();
};

E1000.prototype.update_eeprom_checksum = function()
{
    let sum = 0;
    for(let i = 0; i < EEPROM_WORDS - 1; i++) sum += this.eeprom[i];
    this.eeprom[EEPROM_WORDS - 1] = EEPROM_CHECKSUM - sum & 0xFFFF;
};

/** The address in the EEPROM */
E1000.prototype.eeprom_mac = function()
{
    const e = this.eeprom;
    return new Uint8Array([e[0] & 0xFF, e[0] >> 8, e[1] & 0xFF, e[1] >> 8, e[2] & 0xFF, e[2] >> 8]);
};

/** The address the guest gave receive address 0 (or the EEPROM's) */
E1000.prototype.guest_mac = function()
{
    const low = this.regs[RA >> 2], high = this.regs[RA + 4 >> 2];
    if(!(high & RAH_AV)) return this.eeprom_mac();
    return new Uint8Array([low & 0xFF, low >>> 8 & 0xFF, low >>> 16 & 0xFF, low >>> 24, high & 0xFF, high >>> 8 & 0xFF]);
};

/** The registers of a reset (power on, CTRL.RST): RA[0] from the EEPROM */
E1000.prototype.reset_registers = function()
{
    this.regs.fill(0);
    for(const [offset, value] of REG_INIT) this.regs[offset >> 2] = value;
    const e = this.eeprom;
    this.regs[RA >> 2] = e[0] | e[1] << 16;
    this.regs[RA + 4 >> 2] = e[2] | RAH_AV;
    if(!this.mac_in_state && format_mac(this.mac) !== format_mac(this.eeprom_mac()))
    {
        // (the guest had given the card another address)
        this.mac = this.eeprom_mac();
        this.machine.set_mac(format_mac(this.mac));
    }
    this.eecd_bits = 0;
    this.eecd_reading = false;
    this.io_address = 0;
    this.tx_size = 0;
    this.tx_props.fill(0);
    this.tx_tso_props.fill(0);
    this.tx_sum_needed = 0;
    this.tx_vlan_tag = -1;
    this.tx_tse = false;
    this.tx_tso_frames = 0;
    this.tx_legacy_sum = null;
    this.tx_more = false;
    this.tx_ide = false;
    this.rx_fifo = [];
    this.rx_fifo_bytes = 0;
    const autoneg = this.deadlines[T_AUTONEG];
    this.deadlines.fill(0);
    // (CTRL.RST leaves the PHY as it is)
    this.deadlines[T_AUTONEG] = autoneg;
    this.irq_held = false;
    this.update_irq();
};

E1000.prototype.reset_phy = function()
{
    this.phy.fill(0);
    for(const [reg, value] of PHY_INIT) this.phy[reg] = value;
    this.deadlines[T_AUTONEG] = 0;
    this.set_link(true);
};

/** A machine reset (PCIRST#) */
E1000.prototype.reset = function()
{
    this.reset_registers();
    this.reset_phy();
    this.update_decode();
};

/**
 * The link as the MAC and the PHY report it
 * @param {boolean} up
 */
E1000.prototype.set_link = function(up)
{
    const status = this.regs[STATUS >> 2];
    this.regs[STATUS >> 2] = up ? status | STATUS_LU : status & ~STATUS_LU;
    if(up)
    {
        this.phy[MII_BMSR] |= BMSR_LINK | BMSR_AN_COMP;
        this.phy[M88_PHY_SPEC_STATUS] |= M88_STATUS_LINK;
        this.phy[MII_ANLPAR] |= ANLPAR_ACK;
    }
    else
    {
        this.phy[MII_BMSR] &= ~(BMSR_LINK | BMSR_AN_COMP);
        this.phy[M88_PHY_SPEC_STATUS] &= ~M88_STATUS_LINK;
        this.phy[MII_ANLPAR] &= ~ANLPAR_ACK;
    }
};

E1000.prototype.link_up = function()
{
    return !!(this.regs[STATUS >> 2] & STATUS_LU);
};

// registers

/**
 * A register's value without the side effects of reading it
 * @param {number} offset
 * @return {number}
 */
E1000.prototype.peek = function(offset)
{
    offset &= MMIO_SIZE - 4;
    switch(offset)
    {
        case EECD:
            return this.read_eecd();
        case IMC:
            return 0;
        case ICS:
            return this.regs[ICR >> 2];
    }
    return REG_KIND[offset >> 2] ? this.regs[offset >> 2] : 0;
};

/**
 * @param {number} offset
 * @return {number}
 */
E1000.prototype.read = function(offset)
{
    offset &= MMIO_SIZE - 4;
    const kind = REG_KIND[offset >> 2];
    if(kind === REG_STAT || kind === REG_STAT_HIGH)
    {
        const value = this.regs[offset >> 2];
        this.regs[offset >> 2] = 0;
        if(kind === REG_STAT_HIGH) this.regs[offset - 4 >> 2] = 0;
        return value;
    }
    if(offset === ICR)
    {
        const value = this.regs[ICR >> 2];
        this.regs[ICR >> 2] = 0;
        this.update_irq();
        return value;
    }
    if(!kind)
    {
        dbg_log("e1000: read of unknown register " + h(offset, 5), LOG_NET);
    }
    return this.peek(offset);
};

/**
 * A byte write: the register's other bytes as they are
 * @param {number} offset
 * @param {number} value
 */
E1000.prototype.write_byte = function(offset, value)
{
    const shift = (offset & 3) << 3;
    const old = offset === ICR || offset === ICS || offset === IMS || offset === IMC ? 0 : this.peek(offset & ~3);
    this.write(offset & ~3, old & ~(0xFF << shift) | (value & 0xFF) << shift);
};

/**
 * @param {number} offset
 * @param {number} value
 */
E1000.prototype.write = function(offset, value)
{
    offset &= MMIO_SIZE - 4;
    const index = offset >> 2;
    const kind = REG_KIND[index];
    if(kind === REG_PLAIN)
    {
        this.regs[index] = value;
        return;
    }
    if(kind !== REG_SPECIAL)
    {
        if(!kind) dbg_log("e1000: write of unknown register " + h(offset, 5) + ": " + h(value >>> 0, 8), LOG_NET);
        return;
    }
    if(offset >= RA && offset < RA + 0x80)
    {
        this.regs[index] = value;
        if(offset === RA + 4) this.receive_address_written();
        return;
    }
    switch(offset)
    {
        case CTRL:
            if(value & CTRL_RST)
            {
                dbg_log("e1000: reset", LOG_NET);
                this.reset_registers();
                return;
            }
            if(value & CTRL_PHY_RST && !(this.regs[index] & CTRL_PHY_RST))
            {
                this.reset_phy();
            }
            this.regs[index] = value;
            break;
        case STATUS:
            break;
        case EECD:
            this.write_eecd(value);
            break;
        case EERD:
            this.regs[index] = value & EERD_START ? this.read_eerd(value) : value & ~EERD_DONE;
            break;
        case MDIC:
            this.regs[index] = this.mdio(value);
            if(value & MDIC_INT_EN) this.interrupt(ICR_MDAC);
            break;
        case ICR:
            this.regs[ICR >> 2] &= ~value;
            this.update_irq();
            break;
        case ICS:
            this.interrupt(value & ICR_MASK);
            break;
        case IMS:
            this.regs[index] |= value & ICR_MASK;
            this.update_irq();
            break;
        case IMC:
            this.regs[IMS >> 2] &= ~value;
            this.update_irq();
            break;
        case ITR:
            this.regs[index] = value & 0xFFFF;
            if(!(value & 0xFFFF))
            {
                // (no throttling: what waits goes now)
                this.deadlines[T_ITR] = 0;
                this.update_irq();
            }
            break;
        case RCTL:
            this.regs[index] = value;
            this.drain_rx_fifo();
            break;
        case TCTL:
            this.regs[index] = value;
            this.transmit();
            break;
        case RDLEN:
        case TDLEN:
            this.regs[index] = value & 0xFFF80;
            break;
        case RDH:
        case TDH:
            this.regs[index] = value & 0xFFFF;
            break;
        case RDT:
            this.regs[index] = value & 0xFFFF;
            this.drain_rx_fifo();
            break;
        case TDT:
            this.regs[index] = value & 0xFFFF;
            this.transmit();
            break;
        case RDTR:
            this.regs[index] = value & 0xFFFF;
            if(value & DELAY_FPD) this.end_rx_delay();
            break;
        case TIDV:
            this.regs[index] = value & 0xFFFF;
            if(value & DELAY_FPD) this.end_tx_delay();
            break;
        case RADV:
        case TADV:
            this.regs[index] = value & 0xFFFF;
            break;
        case WUS:
            this.regs[index] &= ~value;
            break;
    }
};

/**
 * The guest set receive address 0: the network learns it (with address
 * translation, the guest's address is the one translated)
 */
E1000.prototype.receive_address_written = function()
{
    if(!(this.regs[RA + 4 >> 2] & RAH_AV)) return;
    const mac = this.guest_mac();
    if(this.mac_in_state)
    {
        this.mac_in_state = mac;
    }
    else if(format_mac(mac) !== format_mac(this.mac))
    {
        this.mac = mac;
        this.machine.set_mac(format_mac(mac));
    }
};

// the EEPROM

/**
 * EERD: a word read in one step
 * @param {number} value
 * @return {number}
 */
E1000.prototype.read_eerd = function(value)
{
    const address = value >>> 8 & 0xFF;
    const word = address < EEPROM_WORDS ? this.eeprom[address] : 0;
    return word << 16 | address << 8 | EERD_DONE;
};

/** @return {number} */
E1000.prototype.read_eecd = function()
{
    let value = EECD_PRES | EECD_GNT | this.eecd_bits;
    if(!this.eecd_reading || this.eeprom[this.eecd_out >> 4 & (EEPROM_WORDS - 1)] >> (~this.eecd_out & 0xF) & 1)
    {
        value |= EECD_DO;
    }
    return value;
};

/**
 * EECD: Microwire, bit by bit. The read opcode (110) and six address bits go
 * in on rising edges of SK, the word comes out most significant bit first,
 * advancing on falling edges
 * @param {number} value
 */
E1000.prototype.write_eecd = function(value)
{
    const old = this.eecd_bits;
    this.eecd_bits = value & EECD_WRITABLE;
    if(!(value & EECD_CS)) return;
    if(!(old & EECD_CS))
    {
        this.eecd_in = 0;
        this.eecd_in_count = 0;
        this.eecd_out = 0;
        this.eecd_reading = false;
    }
    if(!((old ^ value) & EECD_SK)) return;
    if(!(value & EECD_SK))
    {
        this.eecd_out++;
        return;
    }
    this.eecd_in = this.eecd_in << 1 | (value & EECD_DI ? 1 : 0);
    if(++this.eecd_in_count === 9 && !this.eecd_reading)
    {
        this.eecd_out = ((this.eecd_in & 0x3F) << 4) - 1;
        this.eecd_reading = (this.eecd_in >> 6 & 7) === EEPROM_READ_OPCODE;
    }
};

// the PHY

/**
 * An MDIO transaction (MDIC): done at once
 * @param {number} value
 * @return {number} MDIC afterwards
 */
E1000.prototype.mdio = function(value)
{
    const address = value >>> 21 & 0x1F, reg = value >>> 16 & 0x1F, op = value >>> 26 & 3;
    if(address !== PHY_ADDRESS)
    {
        return value | MDIC_READY | MDIC_ERROR;
    }
    if(op === MDIC_OP_READ)
    {
        return value & ~0xFFFF | this.phy[reg] | MDIC_READY;
    }
    if(op === MDIC_OP_WRITE)
    {
        this.phy_write(reg, value & 0xFFFF);
    }
    return value | MDIC_READY;
};

/**
 * @param {number} reg
 * @param {number} value
 */
E1000.prototype.phy_write = function(reg, value)
{
    if(PHY_READ_ONLY.includes(reg)) return;
    if(reg !== MII_BMCR)
    {
        this.phy[reg] = value;
        return;
    }
    if(value & BMCR_RESET)
    {
        this.reset_phy();
    }
    this.phy[MII_BMCR] = value & ~(BMCR_RESET | BMCR_ANRESTART);
    if(value & BMCR_AUTOEN && value & BMCR_ANRESTART)
    {
        // the link goes down while the PHY negotiates again
        this.set_link(false);
        this.deadlines[T_AUTONEG] = this.machine.now() + AUTONEG_MS;
    }
};

// interrupts

/**
 * Set interrupt causes
 * @param {number} causes
 */
E1000.prototype.interrupt = function(causes)
{
    this.regs[ICR >> 2] |= causes;
    this.update_irq();
};

/**
 * INTA follows ICR & IMS; a rising edge waits for the interval ITR sets
 * since the last one
 */
E1000.prototype.update_irq = function()
{
    const pending = (this.regs[ICR >> 2] & this.regs[IMS >> 2]) !== 0;
    if(pending === this.irq_level)
    {
        if(!pending) this.irq_held = false;
        return;
    }
    if(!pending)
    {
        this.irq_level = false;
        this.irq_held = false;
        this.machine.lower_irq();
        return;
    }
    const now = this.machine.now();
    if(this.deadlines[T_ITR] > now)
    {
        // (the timer raises it; from a frame of the network, a halted
        // machine wakes for that)
        if(!this.irq_held) this.machine.wake();
        this.irq_held = true;
        return;
    }
    this.irq_held = false;
    this.irq_level = true;
    const interval = this.regs[ITR >> 2] & 0xFFFF;
    this.deadlines[T_ITR] = interval ? now + interval * ITR_UNIT : 0;
    this.machine.raise_irq();
};

/** The receive delay ended (RDTR, RADV, a flush): RXT0 */
E1000.prototype.end_rx_delay = function()
{
    if(!this.deadlines[T_RX_PACKET] && !this.deadlines[T_RX_ABSOLUTE]) return;
    this.deadlines[T_RX_PACKET] = this.deadlines[T_RX_ABSOLUTE] = 0;
    this.interrupt(ICR_RXT0);
};

/** The transmit delay ended (TIDV, TADV, a flush): TXDW */
E1000.prototype.end_tx_delay = function()
{
    if(!this.deadlines[T_TX_PACKET] && !this.deadlines[T_TX_ABSOLUTE]) return;
    this.deadlines[T_TX_PACKET] = this.deadlines[T_TX_ABSOLUTE] = 0;
    this.interrupt(ICR_TXDW);
};

/**
 * The machine's timers run: deadlines that passed, the ring work that waits
 * @param {number} now
 * @return {number} milliseconds until it needs to run again
 */
E1000.prototype.timer = function(now)
{
    const d = this.deadlines;
    if(d[T_AUTONEG] && now >= d[T_AUTONEG])
    {
        d[T_AUTONEG] = 0;
        this.set_link(true);
        this.interrupt(ICR_LSC);
        this.drain_rx_fifo();
    }
    if(d[T_RX_PACKET] && now >= d[T_RX_PACKET] || d[T_RX_ABSOLUTE] && now >= d[T_RX_ABSOLUTE])
    {
        this.end_rx_delay();
    }
    if(d[T_TX_PACKET] && now >= d[T_TX_PACKET] || d[T_TX_ABSOLUTE] && now >= d[T_TX_ABSOLUTE])
    {
        this.end_tx_delay();
    }
    if(this.irq_held && now >= d[T_ITR])
    {
        this.update_irq();
    }
    if(this.tx_more)
    {
        this.transmit();
    }
    if(this.rx_fifo.length)
    {
        this.drain_rx_fifo();
    }

    if(this.tx_more) return 0;
    let next = 100;
    for(let i = 0; i < T_COUNT; i++)
    {
        if(d[i] && (i !== T_ITR || this.irq_held)) next = Math.min(next, Math.max(0, d[i] - now));
    }
    return next;
};

// DMA

/** Whether the card may use guest memory (bus mastering, also upstream) */
E1000.prototype.can_dma = function()
{
    return this.machine.is_bus_master();
};

/**
 * @param {number} address
 * @param {number} length
 * @return {Uint8Array} null where it is not memory
 */
E1000.prototype.dma_read = function(address, length)
{
    try
    {
        return this.machine.read_physical(address, length);
    }
    catch(e)
    {
        dbg_log("e1000: DMA read outside memory at " + h(address, 9) + " (" + e.message + ")", LOG_NET);
        return null;
    }
};

/**
 * @param {!Uint8Array} bytes
 * @param {number} address
 * @return {boolean} whether it was memory
 */
E1000.prototype.dma_write = function(bytes, address)
{
    try
    {
        this.machine.write_physical(bytes, address);
        return true;
    }
    catch(e)
    {
        dbg_log("e1000: DMA write outside memory at " + h(address, 9) + " (" + e.message + ")", LOG_NET);
        return false;
    }
};

/** Bus mastering or decode came back: work that waited for it */
E1000.prototype.resume_dma = function()
{
    if(!this.can_dma()) return;
    this.transmit();
    this.drain_rx_fifo();
};

/**
 * A ring's base address (16-byte aligned, 64 bits)
 * @param {number} low_register
 * @return {number}
 */
E1000.prototype.ring_base = function(low_register)
{
    return (this.regs[low_register + 4 >> 2] >>> 0) * 0x100000000 + ((this.regs[low_register >> 2] & ~0xF) >>> 0);
};

// transmit

/** Send what the ring holds between TDH and TDT (within a round's budget) */
E1000.prototype.transmit = function()
{
    this.tx_more = false;
    if(!(this.regs[TCTL >> 2] & TCTL_EN) || !this.can_dma()) return;
    const count = this.regs[TDLEN >> 2] >> 4;
    const start = this.regs[TDH >> 2];
    if(!count || start >= count)
    {
        if(start !== this.regs[TDT >> 2]) dbg_log("e1000: bad transmit ring: TDH " + start + ", TDLEN " + h(this.regs[TDLEN >> 2]), LOG_NET);
        return;
    }
    const base = this.ring_base(TDBAL);
    let causes = 0, descriptors = 0;
    this.tx_bytes = 0;
    while(this.regs[TDH >> 2] !== this.regs[TDT >> 2])
    {
        if(descriptors === TX_DESCRIPTOR_BUDGET || this.tx_bytes >= TX_BYTE_BUDGET)
        {
            this.tx_more = true;
            break;
        }
        const head = this.regs[TDH >> 2];
        const address = base + head * 16;
        const descriptor = this.dma_read(address, 16);
        if(!descriptor) break;
        this.process_tx_descriptor(descriptor);
        const lower = descriptor[8] | descriptor[9] << 8 | descriptor[10] << 16 | descriptor[11] << 24;
        if(lower & (TXD_RS | TXD_RPS))
        {
            // write back: done (DD), no collisions or underrun
            const upper = (descriptor[12] | TXD_STAT_DD) & ~0xE;
            this.dma_write(Uint8Array.of(upper), address + 12);
            causes |= ICR_TXDW;
            if(lower & TXD_IDE) this.tx_ide = true;
        }
        descriptors++;
        const next = head + 1 === count ? 0 : head + 1;
        this.regs[TDH >> 2] = next;
        if(next === start)
        {
            dbg_log("e1000: transmit ring wrapped (TDT " + this.regs[TDT >> 2] + " beyond the ring)", LOG_NET);
            break;
        }
    }
    if(this.regs[TDH >> 2] === this.regs[TDT >> 2]) causes |= ICR_TXQE;
    if(causes & ICR_TXDW && this.tx_ide)
    {
        // delayed (TIDV after the last one, TADV after the first)
        causes &= ~ICR_TXDW;
        this.tx_ide = false;
        const now = this.machine.now();
        const tidv = this.regs[TIDV >> 2] & 0xFFFF, tadv = this.regs[TADV >> 2] & 0xFFFF;
        if(!tidv)
        {
            causes |= ICR_TXDW;
        }
        else
        {
            this.deadlines[T_TX_PACKET] = now + tidv * DELAY_UNIT;
            if(tadv && !this.deadlines[T_TX_ABSOLUTE]) this.deadlines[T_TX_ABSOLUTE] = now + tadv * DELAY_UNIT;
        }
    }
    if(causes) this.interrupt(causes);
};

/**
 * One transmit descriptor: a context for offload, or a buffer of the frame
 * @param {!Uint8Array} d its 16 bytes
 */
E1000.prototype.process_tx_descriptor = function(d)
{
    const lower = d[8] | d[9] << 8 | d[10] << 16 | d[11] << 24;
    const type = lower & (TXD_DEXT | TXD_DTYP_D);
    let length = lower & 0xFFFF;

    if(type === TXD_DEXT)
    {
        // a context: TSE's for segmentation, the other for checksums
        const props = lower & TXD_TSE ? this.tx_tso_props : this.tx_props;
        props[P_IPCSS] = d[0];
        props[P_IPCSO] = d[1];
        props[P_IPCSE] = d[2] | d[3] << 8;
        props[P_TUCSS] = d[4];
        props[P_TUCSO] = d[5];
        props[P_TUCSE] = d[6] | d[7] << 8;
        props[P_PAYLEN] = lower & 0xFFFFF;
        props[P_HDRLEN] = d[13];
        props[P_MSS] = d[14] | d[15] << 8;
        props[P_IP] = lower & TXD_CMD_IP ? 1 : 0;
        props[P_TCP] = lower & TXD_CMD_TCP ? 1 : 0;
        if(lower & TXD_TSE) this.tx_tso_frames = 0;
        return;
    }
    if(type === (TXD_DEXT | TXD_DTYP_D))
    {
        // data: POPTS of a frame's first descriptor
        if(this.tx_size === 0) this.tx_sum_needed = d[13];
        this.tx_tse = !!(lower & TXD_TSE);
        length = lower & 0xFFFFF;
    }
    else
    {
        // legacy: CSO and CSS of the frame's last descriptor
        this.tx_tse = false;
        if(lower & TXD_EOP) this.tx_legacy_sum = lower & TXD_IC ? [d[10], d[13]] : null;
    }

    if(this.regs[CTRL >> 2] & CTRL_VME && lower & TXD_VLE && (this.tx_tse || lower & TXD_EOP))
    {
        this.tx_vlan_tag = d[14] | d[15] << 8;
    }

    let address = (d[4] | d[5] << 8 | d[6] << 16 | d[7] << 24) >>> 0;
    address = address * 0x100000000 + ((d[0] | d[1] << 8 | d[2] << 16 | d[3] << 24) >>> 0);

    if(this.tx_tse)
    {
        const props = this.tx_tso_props;
        const hdr_len = props[P_HDRLEN];
        const segment = hdr_len + props[P_MSS];
        while(length > 0 && this.tx_size < segment)
        {
            const bytes = Math.min(length, segment - this.tx_size, TX_BUFFER_SIZE - this.tx_size);
            if(!bytes) break;
            const data = this.dma_read(address, bytes);
            if(!data) break;
            this.tx_data.set(data, this.tx_size);
            const size = this.tx_size + bytes;
            if(size >= hdr_len && this.tx_size < hdr_len)
            {
                this.tx_header.set(this.tx_data.subarray(0, hdr_len));
            }
            this.tx_size = size;
            address += bytes;
            length -= bytes;
            if(size === segment)
            {
                this.transmit_segment();
                this.tx_data.set(this.tx_header.subarray(0, hdr_len));
                this.tx_size = hdr_len;
            }
        }
    }
    else
    {
        const bytes = Math.min(length, TX_BUFFER_SIZE - this.tx_size);
        const data = bytes ? this.dma_read(address, bytes) : null;
        if(data)
        {
            this.tx_data.set(data, this.tx_size);
            this.tx_size += bytes;
        }
    }

    if(!(lower & TXD_EOP)) return;
    if(!(this.tx_tse && this.tx_size < this.tx_tso_props[P_HDRLEN]))
    {
        this.transmit_segment();
    }
    this.tx_tso_frames = 0;
    this.tx_sum_needed = 0;
    this.tx_vlan_tag = -1;
    this.tx_size = 0;
    this.tx_tse = false;
    this.tx_legacy_sum = null;
};

/**
 * Send the frame gathered (or one TSO segment of it): headers of the
 * segment, checksums, the VLAN tag
 */
E1000.prototype.transmit_segment = function()
{
    const data = this.tx_data;
    const size = this.tx_size;
    const props = this.tx_tse ? this.tx_tso_props : this.tx_props;

    if(this.tx_tse)
    {
        const frames = this.tx_tso_frames;
        let css = props[P_IPCSS];
        if(props[P_IP])
        {
            // IPv4: total length, identification + the segment's number
            store16(data, css + 2, size - css);
            store16(data, css + 4, load16(data, css + 4) + frames);
        }
        else
        {
            // IPv6: payload length
            store16(data, css + 4, size - css - 40);
        }
        css = props[P_TUCSS];
        const length = size - css;
        if(props[P_TCP])
        {
            const sofar = frames * props[P_MSS];
            store32(data, css + 4, load32(data, css + 4) + sofar);
            if(props[P_PAYLEN] - sofar > props[P_MSS])
            {
                // not the last segment: no PSH, no FIN
                data[css + 13] &= ~9;
            }
            else if(frames)
            {
                this.count(TSCTC);
            }
        }
        else
        {
            store16(data, css + 4, length);
        }
        if(this.tx_sum_needed & POPTS_TXSM)
        {
            // the driver's pseudo header sum has no length: add the segment's
            const at = props[P_TUCSO];
            store16(data, at, checksum_fold(load16(data, at) + length));
        }
        this.tx_tso_frames++;
    }

    if(this.tx_sum_needed & POPTS_TXSM)
    {
        insert_checksum(data, size, props[P_TUCSO], props[P_TUCSS], props[P_TUCSE]);
    }
    if(this.tx_sum_needed & POPTS_IXSM)
    {
        insert_checksum(data, size, props[P_IPCSO], props[P_IPCSS], props[P_IPCSE]);
    }
    if(this.tx_legacy_sum)
    {
        insert_checksum(data, size, this.tx_legacy_sum[0], this.tx_legacy_sum[1], 0);
    }

    let frame;
    if(this.tx_vlan_tag >= 0)
    {
        frame = new Uint8Array(size + 4);
        frame.set(data.subarray(0, 12));
        store16(frame, 12, this.regs[VET >> 2] & 0xFFFF);
        store16(frame, 14, this.tx_vlan_tag);
        frame.set(data.subarray(12, size), 16);
    }
    else
    {
        frame = data.slice(0, size);
    }
    this.tx_bytes += frame.length;
    this.send_frame(frame);
};

/**
 * @param {!Uint8Array} frame
 */
E1000.prototype.send_frame = function(frame)
{
    const fcs_size = frame.length + 4;
    this.count(TPT);
    this.count(GPTC);
    this.count64(TOTL, fcs_size);
    this.count64(GOTCL, fcs_size);
    this.count_size(PTC_SIZES, fcs_size);
    if(is_broadcast(frame)) this.count(BPTC);
    else if(frame[0] & 1) this.count(MPTC);

    if(this.phy[MII_BMCR] & BMCR_LOOPBACK || (this.regs[RCTL >> 2] & RCTL_LBM) === 1 << 6)
    {
        this.receive(frame);
        return;
    }
    if(this.mac_in_state)
    {
        translate_mac_address(frame, this.mac_in_state, this.mac);
    }
    this.machine.send(frame);
};

/**
 * Store a checksum: bytes [css, cse] (cse 0: to the end) at sloc
 * @param {!Uint8Array} data
 * @param {number} size
 * @param {number} sloc
 * @param {number} css
 * @param {number} cse
 */
function insert_checksum(data, size, sloc, css, cse)
{
    let end = size;
    if(cse && cse < end) end = cse + 1;
    if(sloc < end - 1 && css < end)
    {
        store16(data, sloc, checksum_finish(checksum_add(data, css, end)));
    }
}

/** @param {!Uint8Array} frame */
function is_broadcast(frame)
{
    return frame[0] === 0xFF && frame[1] === 0xFF && frame[2] === 0xFF && frame[3] === 0xFF && frame[4] === 0xFF && frame[5] === 0xFF;
}

// statistics

/** @param {number} offset a counter: one more, up to its maximum */
E1000.prototype.count = function(offset)
{
    if(this.regs[offset >> 2] !== -1) this.regs[offset >> 2]++;
};

/**
 * @param {number} offset the low half of a 64-bit counter
 * @param {number} value
 */
E1000.prototype.count64 = function(offset, value)
{
    const low = (this.regs[offset >> 2] >>> 0) + value;
    const high = (this.regs[offset + 4 >> 2] >>> 0) + Math.floor(low / 0x100000000);
    if(high > 0xFFFFFFFF)
    {
        this.regs[offset >> 2] = this.regs[offset + 4 >> 2] = -1;
        return;
    }
    this.regs[offset >> 2] = low;
    this.regs[offset + 4 >> 2] = high;
};

/**
 * @param {!Array<number>} counters 64, 127, 255, 511, 1023, 1522 bytes
 * @param {number} size with the FCS
 */
E1000.prototype.count_size = function(counters, size)
{
    this.count(counters[size > 1023 ? 5 : size > 511 ? 4 : size > 255 ? 3 : size > 127 ? 2 : size > 64 ? 1 : 0]);
};

// receive

/** The receive buffers' size (RCTL.BSIZE, BSEX) */
E1000.prototype.rx_buffer_size = function()
{
    const rctl = this.regs[RCTL >> 2];
    const bsize = rctl >>> 16 & 3;
    if(rctl & RCTL_BSEX) return [2048, 16384, 8192, 4096][bsize];
    return [2048, 1024, 512, 256][bsize];
};

/**
 * A frame from the network
 * @param {!Uint8Array} frame without FCS
 * @return {boolean} whether the card took it
 */
E1000.prototype.receive = function(frame)
{
    const rctl = this.regs[RCTL >> 2];
    if(!(rctl & RCTL_EN) || !this.link_up()) return false;

    if(frame.length < MIN_FRAME)
    {
        const padded = new Uint8Array(MIN_FRAME);
        padded.set(frame);
        frame = padded;
    }
    if(frame.length > MAX_LONG_FRAME || frame.length > MAX_FRAME && !(rctl & RCTL_LPE))
    {
        if(!(rctl & RCTL_SBP))
        {
            this.count(ROC);
            return false;
        }
    }
    if(this.mac_in_state)
    {
        frame = new Uint8Array(frame);
        translate_mac_address(frame, this.mac, this.mac_in_state);
    }
    if(!this.accepts(frame)) return false;

    if(!this.rx_fifo.length && this.deliver(frame))
    {
        return true;
    }
    // no free descriptor (or no bus mastering): the frame waits in the FIFO
    this.count(RNBC);
    const fifo_size = (this.regs[PBA >> 2] & 0xFFFF) << 10;
    if(this.rx_fifo_bytes + frame.length > fifo_size)
    {
        this.count(MPC);
        this.interrupt(ICR_RXO);
        return false;
    }
    this.rx_fifo.push(new Uint8Array(frame));
    this.rx_fifo_bytes += frame.length;
    return true;
};

/** Frames from the FIFO into descriptors the guest has given since */
E1000.prototype.drain_rx_fifo = function()
{
    while(this.rx_fifo.length)
    {
        const rctl = this.regs[RCTL >> 2];
        if(!(rctl & RCTL_EN) || !this.deliver(this.rx_fifo[0])) return;
        this.rx_fifo_bytes -= this.rx_fifo.shift().length;
    }
};

/**
 * The receive filter: VLAN, broadcast, multicast, unicast addresses
 * @param {!Uint8Array} frame
 * @return {boolean}
 */
E1000.prototype.accepts = function(frame)
{
    const regs = this.regs;
    const rctl = regs[RCTL >> 2];
    if(this.vlan_frame(frame) && rctl & RCTL_VFE)
    {
        const vid = load16(frame, 14) & 0xFFF;
        if(!(regs[(VFTA >> 2) + (vid >> 5)] >>> (vid & 0x1F) & 1)) return false;
    }
    if(is_broadcast(frame))
    {
        if(rctl & RCTL_BAM) return true;
    }
    else if(frame[0] & 1)
    {
        if(rctl & RCTL_MPE) return true;
    }
    else if(rctl & RCTL_UPE)
    {
        return true;
    }
    const low = frame[0] | frame[1] << 8 | frame[2] << 16 | frame[3] << 24;
    const high = frame[4] | frame[5] << 8;
    for(let i = 0; i < 16; i++)
    {
        const rah = regs[(RA >> 2) + 2 * i + 1];
        if(rah & RAH_AV && regs[(RA >> 2) + 2 * i] === low && (rah & 0xFFFF) === high) return true;
    }
    // the multicast table: 12 bits of the address, at RCTL.MO's offset
    const shift = [4, 3, 2, 0][rctl >>> 12 & 3];
    const hash = (frame[5] << 8 | frame[4]) >> shift & 0xFFF;
    return !!(regs[(MTA >> 2) + (hash >> 5)] >>> (hash & 0x1F) & 1);
};

/**
 * @param {!Uint8Array} frame
 * @return {boolean}
 */
E1000.prototype.vlan_frame = function(frame)
{
    return frame.length >= 18 && load16(frame, 12) === (this.regs[VET >> 2] & 0xFFFF);
};

/**
 * Write a frame into the receive ring
 * @param {!Uint8Array} frame
 * @return {boolean} false when it does not fit (yet): too few descriptors, no bus mastering
 */
E1000.prototype.deliver = function(frame)
{
    if(!this.can_dma()) return false;
    const regs = this.regs;
    const rctl = regs[RCTL >> 2];
    const count = regs[RDLEN >> 2] >> 4;
    const head = regs[RDH >> 2], tail = regs[RDT >> 2];
    if(!count || head >= count) return false;
    const free = tail >= head ? tail - head : count - head + tail;

    // a VLAN tag goes into the descriptor (with CTRL.VME)
    let special = 0, status = 0;
    if(regs[CTRL >> 2] & CTRL_VME && this.vlan_frame(frame))
    {
        special = load16(frame, 14);
        status |= RXD_STAT_VP;
        const untagged = new Uint8Array(frame.length - 4);
        untagged.set(frame.subarray(0, 12));
        untagged.set(frame.subarray(16), 12);
        frame = untagged;
    }
    const size = frame.length;
    const fcs = rctl & RCTL_SECRC ? 0 : 4;
    const total = size + fcs;
    const buffer_size = this.rx_buffer_size();
    if(free * buffer_size < total) return false;

    let data = frame;
    if(fcs)
    {
        data = new Uint8Array(total);
        data.set(frame);
        const crc = ethernet_fcs(frame, 0, size);
        data[size] = crc;
        data[size + 1] = crc >>> 8;
        data[size + 2] = crc >>> 16;
        data[size + 3] = crc >>> 24;
    }

    // receive checksum offload
    const rxcsum = regs[RXCSUM >> 2];
    let errors = 0;
    if(rxcsum & (RXCSUM_IPOFL | RXCSUM_TUOFL))
    {
        const sums = check_checksums(frame, size);
        if(rxcsum & RXCSUM_IPOFL && sums.ip !== CHECKSUM_NONE)
        {
            status |= RXD_STAT_IPCS;
            if(sums.ip === CHECKSUM_BAD) errors |= RXD_ERR_IPE;
        }
        if(rxcsum & RXCSUM_TUOFL && sums.l4 !== CHECKSUM_NONE)
        {
            status |= RXD_STAT_TCPCS;
            if(sums.l4 === CHECKSUM_BAD) errors |= RXD_ERR_TCPE;
        }
    }
    if(!(status & (RXD_STAT_IPCS | RXD_STAT_TCPCS))) status |= RXD_STAT_IXSM;
    // the packet checksum (from RXCSUM.PCSS)
    const packet_sum = checksum_fold(checksum_add(frame, Math.min(rxcsum & 0xFF, size), size));

    const base = this.ring_base(RDBAL);
    let offset = 0, index = head;
    const descriptor = new Uint8Array(16);
    while(offset < total)
    {
        const address = base + index * 16;
        const old = this.dma_read(address, 16);
        if(!old) return false;
        const buffer = (old[4] | old[5] << 8 | old[6] << 16 | old[7] << 24) >>> 0;
        const buffer_address = buffer * 0x100000000 + ((old[0] | old[1] << 8 | old[2] << 16 | old[3] << 24) >>> 0);
        descriptor.set(old.subarray(0, 8));
        let length = 0;
        if(buffer_address)
        {
            length = Math.min(total - offset, buffer_size);
            this.dma_write(data.subarray(offset, offset + length), buffer_address);
            offset += length;
        }
        // (a descriptor without a buffer is skipped, as the manual says)
        const last = offset >= total;
        descriptor[8] = length;
        descriptor[9] = length >> 8;
        descriptor[10] = last ? packet_sum : 0;
        descriptor[11] = last ? packet_sum >> 8 : 0;
        descriptor[12] = status | RXD_STAT_DD | (last ? RXD_STAT_EOP : 0);
        descriptor[13] = last ? errors : 0;
        descriptor[14] = special;
        descriptor[15] = special >> 8;
        this.dma_write(descriptor, address);
        index = index + 1 === count ? 0 : index + 1;
        if(index === tail && !last) return false;
    }
    regs[RDH >> 2] = index;

    this.count(TPR);
    this.count(GPRC);
    this.count64(TORL, size + 4);
    this.count64(GORCL, size + 4);
    this.count_size(PRC_SIZES, size + 4);
    if(is_broadcast(frame)) this.count(BPRC);
    else if(frame[0] & 1) this.count(MPRC);

    let causes = 0;
    // few free descriptors left (RCTL.RDMTS: 1/2, 1/4, 1/8 of the ring)
    const left = tail >= index ? tail - index : count - index + tail;
    if(left * 16 <= regs[RDLEN >> 2] >> ((rctl >>> 8 & 3) + 1)) causes |= ICR_RXDMT0;
    const rdtr = regs[RDTR >> 2] & 0xFFFF;
    if(!rdtr)
    {
        causes |= ICR_RXT0;
    }
    else
    {
        // RXT0 after RDTR without a frame, at most RADV after the first
        const now = this.machine.now();
        this.deadlines[T_RX_PACKET] = now + rdtr * DELAY_UNIT;
        const radv = regs[RADV >> 2] & 0xFFFF;
        if(radv && !this.deadlines[T_RX_ABSOLUTE]) this.deadlines[T_RX_ABSOLUTE] = now + radv * DELAY_UNIT;
        this.machine.wake();
    }
    if(causes) this.interrupt(causes);
    return true;
};

// snapshots

E1000.prototype.get_state = function()
{
    return [
        this.regs,
        this.phy,
        this.eeprom,
        new Int32Array([this.eecd_bits, this.eecd_in, this.eecd_in_count, this.eecd_out, +this.eecd_reading, this.io_address]),
        this.tx_data.slice(0, this.tx_size),
        this.tx_header,
        this.tx_props,
        this.tx_tso_props,
        new Int32Array([this.tx_sum_needed, this.tx_vlan_tag, +this.tx_tse, this.tx_tso_frames, +this.tx_more, +this.tx_ide,
            this.tx_legacy_sum ? 1 : 0, this.tx_legacy_sum ? this.tx_legacy_sum[0] : 0, this.tx_legacy_sum ? this.tx_legacy_sum[1] : 0]),
        this.rx_fifo,
        this.deadlines,
        new Int32Array([+this.irq_level, +this.irq_held, this.bar0]),
        this.mac,
    ];
};

E1000.prototype.set_state = function(state)
{
    this.regs.set(state[0]);
    this.phy.set(state[1]);
    this.eeprom.set(state[2]);
    [this.eecd_bits, this.eecd_in, this.eecd_in_count, this.eecd_out] = state[3];
    this.eecd_reading = !!state[3][4];
    this.io_address = state[3][5];
    this.tx_data.set(state[4]);
    this.tx_size = state[4].length;
    this.tx_header.set(state[5]);
    this.tx_props.set(state[6]);
    this.tx_tso_props.set(state[7]);
    const tx = state[8];
    this.tx_sum_needed = tx[0];
    this.tx_vlan_tag = tx[1];
    this.tx_tse = !!tx[2];
    this.tx_tso_frames = tx[3];
    this.tx_more = !!tx[4];
    this.tx_ide = !!tx[5];
    this.tx_legacy_sum = tx[6] ? [tx[7], tx[8]] : null;
    this.rx_fifo = Array.from(state[9], frame => new Uint8Array(frame));
    this.rx_fifo_bytes = this.rx_fifo.reduce((sum, frame) => sum + frame.length, 0);
    this.deadlines.set(state[10]);
    this.irq_level = !!state[11][0];
    this.irq_held = !!state[11][1];
    this.bar0 = state[11][2] >>> 0;

    const saved_mac = new Uint8Array(state[12]);
    this.mac_in_state = null;
    if(this.preserve_mac_from_state_image)
    {
        this.mac = saved_mac;
    }
    else if(this.mac_address_translation)
    {
        // the guest keeps the address it has; frames are translated to ours
        this.mac_in_state = this.guest_mac();
        dbg_log("e1000: address translation, guest " + format_mac(this.mac_in_state) + ", card " + format_mac(this.mac), LOG_NET);
    }
    else
    {
        // the card keeps its own address: in the EEPROM and receive address
        // 0, unless the guest gave it another one
        const guest = this.guest_mac();
        const saved_eeprom = this.eeprom_mac();
        this.write_eeprom_address();
        if(format_mac(guest) === format_mac(saved_eeprom))
        {
            const e = this.eeprom;
            this.regs[RA >> 2] = e[0] | e[1] << 16;
            this.regs[RA + 4 >> 2] = this.regs[RA + 4 >> 2] & ~0xFFFF | e[2];
        }
    }
    if(!this.mac_in_state && this.regs[RA + 4 >> 2] & RAH_AV)
    {
        this.mac = this.guest_mac();
    }
    this.machine.set_mac(format_mac(this.mac));

    if(this.irq_level) this.machine.raise_irq();
    else this.machine.lower_irq();
    this.update_decode();
};
