import { LOG_NET } from "./const.js";
import { h, hex_dump } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";
import { PCI } from "./pci.js";
import { BusConnector } from "./bus.js";

// http://www.ethernut.de/pdf/8019asds.pdf

const NE2K_LOG_VERBOSE = false;
const NE2K_LOG_PACKETS = false;

const E8390_CMD = 0x00; /* The command register (for all pages) */

/* Page 0 register offsets. */
const EN0_CLDALO = 0x01; /* Low byte of current local dma addr RD */
const EN0_STARTPG = 0x01; /* Starting page of ring bfr WR */
const EN0_CLDAHI = 0x02; /* High byte of current local dma addr RD */
const EN0_STOPPG = 0x02; /* Ending page +1 of ring bfr WR */
const EN0_BOUNDARY = 0x03; /* Boundary page of ring bfr RD WR */
const EN0_TSR = 0x04; /* Transmit status reg RD */
const EN0_TPSR = 0x04; /* Transmit starting page WR */
const EN0_NCR = 0x05; /* Number of collision reg RD */
const EN0_TCNTLO = 0x05; /* Low byte of tx byte count WR */
const EN0_FIFO = 0x06; /* FIFO RD */
const EN0_TCNTHI = 0x06; /* High byte of tx byte count WR */
const EN0_ISR = 0x07; /* Interrupt status reg RD WR */
const EN0_CRDALO = 0x08; /* low byte of current remote dma address RD */
const EN0_RSARLO = 0x08; /* Remote start address reg 0 */
const EN0_CRDAHI = 0x09; /* high byte, current remote dma address RD */
const EN0_RSARHI = 0x09; /* Remote start address reg 1 */
const EN0_RCNTLO = 0x0a; /* Remote byte count reg WR */
const EN0_RCNTHI = 0x0b; /* Remote byte count reg WR */
const EN0_RSR = 0x0c; /* rx status reg RD */
const EN0_RXCR = 0x0c; /* RX configuration reg WR */
const EN0_TXCR = 0x0d; /* TX configuration reg WR */
const EN0_COUNTER0 = 0x0d; /* Rcv alignment error counter RD */
const EN0_DCFG = 0x0e; /* Data configuration reg WR */
const EN0_COUNTER1 = 0x0e; /* Rcv CRC error counter RD */
const EN0_IMR = 0x0f; /* Interrupt mask reg WR */
const EN0_COUNTER2 = 0x0f; /* Rcv missed frame error counter RD */

const NE_DATAPORT = 0x10; /* NatSemi-defined port window offset. */
const NE_RESET = 0x1f; /* Issue a read to reset, a write to clear. */

/* Bits in EN0_ISR - Interrupt status register */
const ENISR_RX = 0x01; /* Receiver, no error */
const ENISR_TX = 0x02; /* Transmitter, no error */
const ENISR_RX_ERR = 0x04; /* Receiver, with error */
const ENISR_TX_ERR = 0x08; /* Transmitter, with error */
const ENISR_OVER = 0x10; /* Receiver overwrote the ring */
const ENISR_COUNTERS = 0x20; /* Counters need emptying */
const ENISR_RDC = 0x40; /* remote dma complete */
const ENISR_RESET = 0x80; /* Reset completed */
const ENISR_ALL = 0x3f; /* Interrupts we will enable */

const ENRSR_RXOK = 0x01; /* Received a good packet */

const START_PAGE = 0x40;
const START_RX_PAGE = 0x40 + 12;
const STOP_PAGE = 0x80;


// Search and replace MAC addresses in ethernet, arp and dhcp packets.
// Used after restoring an OS from memory dump, so that multiple instances of
// that OS can run at the same time with different external MAC addresses.
// Crude but seems to work.
function translate_mac_address(packet, search_mac, replacement_mac)
{
    if(packet[0] === search_mac[0] &&
       packet[1] === search_mac[1] &&
       packet[2] === search_mac[2] &&
       packet[3] === search_mac[3] &&
       packet[4] === search_mac[4] &&
       packet[5] === search_mac[5])
    {
        dbg_log("Replace mac in eth destination field", LOG_NET);

        packet[0] = replacement_mac[0];
        packet[1] = replacement_mac[1];
        packet[2] = replacement_mac[2];
        packet[3] = replacement_mac[3];
        packet[4] = replacement_mac[4];
        packet[5] = replacement_mac[5];
    }

    if(packet[6 + 0] === search_mac[0] &&
       packet[6 + 1] === search_mac[1] &&
       packet[6 + 2] === search_mac[2] &&
       packet[6 + 3] === search_mac[3] &&
       packet[6 + 4] === search_mac[4] &&
       packet[6 + 5] === search_mac[5])
    {
        dbg_log("Replace mac in eth source field", LOG_NET);

        packet[6 + 0] = replacement_mac[0];
        packet[6 + 1] = replacement_mac[1];
        packet[6 + 2] = replacement_mac[2];
        packet[6 + 3] = replacement_mac[3];
        packet[6 + 4] = replacement_mac[4];
        packet[6 + 5] = replacement_mac[5];
    }

    const ethertype = packet[12] << 8 | packet[13];

    if(ethertype === 0x0800)
    {
        // ipv4
        const ipv4_packet = packet.subarray(14);
        const ipv4_version = ipv4_packet[0] >> 4;

        if(ipv4_version !== 4)
        {
            dbg_log("Expected ipv4.version==4 but got: " + ipv4_version, LOG_NET);
            return;
        }

        const ipv4_ihl = ipv4_packet[0] & 0xF;
        dbg_assert(ipv4_ihl === 5, "TODO: ihl!=5");

        const ipv4_proto = ipv4_packet[9];
        if(ipv4_proto === 0x11)
        {
            // udp
            const udp_packet = ipv4_packet.subarray(5 * 4);
            const source_port = udp_packet[0] << 8 | udp_packet[1];
            const destination_port = udp_packet[2] << 8 | udp_packet[3];
            const checksum = udp_packet[6] << 8 | udp_packet[7];

            dbg_log("udp srcport=" + source_port + " dstport=" + destination_port + " checksum=" + h(checksum, 4), LOG_NET);

            if(source_port === 67 || destination_port === 67)
            {
                // dhcp
                const dhcp_packet = udp_packet.subarray(8);
                const dhcp_magic = dhcp_packet[0xEC] << 24 | dhcp_packet[0xED] << 16 | dhcp_packet[0xEE] << 8 | dhcp_packet[0xEF];

                if(dhcp_magic !== 0x63825363)
                {
                    dbg_log("dhcp packet didn't match magic: " + h(dhcp_magic, 8));
                    return;
                }

                if(dhcp_packet[28 + 0] === search_mac[0] &&
                   dhcp_packet[28 + 1] === search_mac[1] &&
                   dhcp_packet[28 + 2] === search_mac[2] &&
                   dhcp_packet[28 + 3] === search_mac[3] &&
                   dhcp_packet[28 + 4] === search_mac[4] &&
                   dhcp_packet[28 + 5] === search_mac[5])
                {
                    dbg_log("Replace mac in dhcp.chaddr", LOG_NET);

                    dhcp_packet[28 + 0] = replacement_mac[0];
                    dhcp_packet[28 + 1] = replacement_mac[1];
                    dhcp_packet[28 + 2] = replacement_mac[2];
                    dhcp_packet[28 + 3] = replacement_mac[3];
                    dhcp_packet[28 + 4] = replacement_mac[4];
                    dhcp_packet[28 + 5] = replacement_mac[5];

                    udp_packet[6] = udp_packet[7] = 0; // zero udp checksum
                }

                let offset = 0xF0;
                while(offset < dhcp_packet.length)
                {
                    const dhcp_option_type = dhcp_packet[offset++];

                    if(dhcp_option_type === 0xFF)
                    {
                        break;
                    }

                    const length = dhcp_packet[offset++];

                    if(dhcp_option_type === 0x3D && // client identifier
                       dhcp_packet[offset + 0] === 0x01 && // ethernet
                       dhcp_packet[offset + 1] === search_mac[0] &&
                       dhcp_packet[offset + 2] === search_mac[1] &&
                       dhcp_packet[offset + 3] === search_mac[2] &&
                       dhcp_packet[offset + 4] === search_mac[3] &&
                       dhcp_packet[offset + 5] === search_mac[4] &&
                       dhcp_packet[offset + 6] === search_mac[5])
                    {
                        dbg_log("Replace mac in dhcp.clientidentifier", LOG_NET);

                        dhcp_packet[offset + 1] = replacement_mac[0];
                        dhcp_packet[offset + 2] = replacement_mac[1];
                        dhcp_packet[offset + 3] = replacement_mac[2];
                        dhcp_packet[offset + 4] = replacement_mac[3];
                        dhcp_packet[offset + 5] = replacement_mac[4];
                        dhcp_packet[offset + 6] = replacement_mac[5];

                        udp_packet[6] = udp_packet[7] = 0; // zero udp checksum
                    }

                    offset += length;
                }
            }
        }
        else
        {
            // tcp, ...
        }
    }
    else if(ethertype === 0x0806)
    {
        // arp
        const arp_packet = packet.subarray(14);
        dbg_log("arp oper=" + arp_packet[7] + " " + format_mac(arp_packet.subarray(8, 8+6)) + " " + format_mac(arp_packet.subarray(18, 18+6)), LOG_NET);

        if(arp_packet[8 + 0] === search_mac[0] &&
           arp_packet[8 + 1] === search_mac[1] &&
           arp_packet[8 + 2] === search_mac[2] &&
           arp_packet[8 + 3] === search_mac[3] &&
           arp_packet[8 + 4] === search_mac[4] &&
           arp_packet[8 + 5] === search_mac[5])
        {
            dbg_log("Replace mac in arp.sha", LOG_NET);

            arp_packet[8 + 0] = replacement_mac[0];
            arp_packet[8 + 1] = replacement_mac[1];
            arp_packet[8 + 2] = replacement_mac[2];
            arp_packet[8 + 3] = replacement_mac[3];
            arp_packet[8 + 4] = replacement_mac[4];
            arp_packet[8 + 5] = replacement_mac[5];
        }
    }
    else
    {
        // TODO: ipv6, ...
    }
}

export function format_mac(mac)
{
    return [
        mac[0].toString(16).padStart(2, "0"),
        mac[1].toString(16).padStart(2, "0"),
        mac[2].toString(16).padStart(2, "0"),
        mac[3].toString(16).padStart(2, "0"),
        mac[4].toString(16).padStart(2, "0"),
        mac[5].toString(16).padStart(2, "0"),
    ].join(":");
}

function dump_packet(packet, prefix)
{
    const ethertype = packet[12] << 8 | packet[13] << 0;
    if(ethertype === 0x0800)
    {
        const ipv4_packet = packet.subarray(14);
        const ipv4_len = ipv4_packet[2] << 8 | ipv4_packet[3];
        const ipv4_proto = ipv4_packet[9];
        if(ipv4_proto === 0x11)
        {
            const udp_packet = ipv4_packet.subarray(5 * 4);
            const source_port = udp_packet[0] << 8 | udp_packet[1];
            const destination_port = udp_packet[2] << 8 | udp_packet[3];
            const checksum = udp_packet[6] << 8 | udp_packet[7];

            if(source_port === 67 || destination_port === 67)
            {
                const dhcp_packet = udp_packet.subarray(8);
                const dhcp_chaddr = dhcp_packet.subarray(28, 28+6);
                dbg_log(prefix + " len=" + packet.length + " ethertype=" + h(ethertype) + " ipv4.len=" + ipv4_len + " ipv4.proto=" + h(packet[14 + 9]) + " udp.srcport=" + source_port + " udp.dstport=" + destination_port + " udp.chksum=" + h(checksum, 4) + " dhcp.chaddr=" + format_mac(dhcp_chaddr));
            }
            else
            {
                dbg_log(prefix + " len=" + packet.length + " ethertype=" + h(ethertype) + " ipv4.len=" + ipv4_len + " ipv4.proto=" + h(packet[14 + 9]) + " udp.srcport=" + source_port + " udp.dstport=" + destination_port + " udp.chksum=" + h(checksum, 4));
            }
        }
        else if(ipv4_proto === 0x01)
        {
        }
        else
        {
            dbg_log(prefix + " len=" + packet.length + " ethertype=" + h(ethertype) + " ipv4.len=" + ipv4_len + " ipv4.proto=" + h(packet[14 + 9]));
        }
    }
    else
    {
        const arp_packet = packet.subarray(14);
        dbg_log(prefix + " len=" + packet.length + " ethertype=" + h(ethertype) + " arp");
    }
    dbg_log(hex_dump(packet));
}

/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 * @param {Boolean} preserve_mac_from_state_image
 * @param {Boolean} mac_address_translation
 * @param {number} [id=0] id
 */
export function Ne2k(cpu, bus, preserve_mac_from_state_image, mac_address_translation, id)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    /** @const @type {PCI} */
    this.pci = cpu.devices.pci;

    this.id = id || 0;
    this.preserve_mac_from_state_image = preserve_mac_from_state_image;
    this.mac_address_translation = mac_address_translation;

    /** @const @type {BusConnector} */
    this.bus = bus;
    this.bus.register("net" + this.id + "-receive", function(data)
    {
        this.receive(data);
    }, this);

    this.port = 0x300 + 0x100 * this.id;

    this.name = "ne2k";

    const use_pci = true;

    if(use_pci)
    {
        this.pci_space = [
            0xec, 0x10, 0x29, 0x80, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00,
            this.port & 0xFF | 1, this.port >> 8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf4, 0x1a, 0x00, 0x11,
            0x00, 0x00, 0xb8, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
        ];
        this.pci_id = (this.id === 0 ? 0x05 : (0x07 + this.id)) << 3;
        this.pci_bars = [
            {
                size: 32,
            },
        ];
    }

    this.isr = 0;
    this.imr = 0; // interrupt mask register

    this.cr = 1;

    this.dcfg = 0;

    this.rcnt = 0;

    this.tcnt = 0;
    this.tpsr = 0;
    this.memory = new Uint8Array(256 * 0x80);

    this.rxcr = 0;
    this.txcr = 0;
    this.tsr = 1;

    // mac address
    this.mac = new Uint8Array([
        0x00, 0x22, 0x15,
        Math.random() * 255 | 0,
        Math.random() * 255 | 0,
        Math.random() * 255 | 0,
    ]);

    this.bus.send("net" + this.id + "-mac", format_mac(this.mac));

    // multicast addresses
    this.mar = Uint8Array.of(0xFF, 0xFF, 0xFF, 0xFF,  0xFF, 0xFF, 0xFF, 0xFF);

    // Used for mac address translation
    // The mac the OS thinks it has
    this.mac_address_in_state = null;

    for(var i = 0; i < 6; i++)
    {
        this.memory[i << 1] = this.memory[i << 1 | 1] = this.mac[i];
    }

    // the PROM signature of 0x57, 0x57 is also doubled
    // resulting in setting the 4 bytes at the end, 28, 29, 30 and 31 to 0x57
    this.memory[14 << 1] = this.memory[14 << 1 | 1] = 0x57;
    this.memory[15 << 1] = this.memory[15 << 1 | 1] = 0x57;

    dbg_log("Mac: " + format_mac(this.mac), LOG_NET);

    this.rsar = 0;

    this.pstart = START_PAGE;
    this.pstop = STOP_PAGE;

    this.curpg = START_RX_PAGE;
    this.boundary = START_RX_PAGE;

    var io = cpu.io;

    io.register_read(this.port | E8390_CMD, this, function()
    {
        dbg_log("Read cmd", LOG_NET);
        return this.cr;
    }, function()
    {
        dbg_log("Read16 cmd", LOG_NET);
        return this.cr;
    }
    );

    io.register_write(this.port | E8390_CMD, this, function(data_byte)
    {
        this.cr = data_byte;
        dbg_log("Write command: " + h(data_byte, 2) + " newpg=" + (this.cr >> 6) + " txcr=" + h(this.txcr, 2), LOG_NET);

        if(this.cr & 1)
        {
            return;
        }

        if((data_byte & 0x18) && this.rcnt === 0)
        {
            this.do_interrupt(ENISR_RDC);
        }

        if(data_byte & 4)
        {
            var start = this.tpsr << 8;
            var data = this.memory.subarray(start, start + this.tcnt);

            if(NE2K_LOG_PACKETS)
            {
                dump_packet(data, "send");
            }

            if(this.mac_address_in_state)
            {
                data = new Uint8Array(data); // make a copy
                translate_mac_address(data, this.mac_address_in_state, this.mac);
            }

            this.bus.send("net" + this.id + "-send", data);
            this.bus.send("eth-transmit-end", [data.length]);
            this.cr &= ~4;
            this.do_interrupt(ENISR_TX);

            dbg_log("Command: Transfer. length=" + h(data.byteLength), LOG_NET);
        }
    });

    io.register_read(this.port | EN0_COUNTER0, this, function()
    {
        var pg = this.get_page();
        if(pg === 1)
        {
            dbg_log("Read mar5", LOG_NET);
            return this.mar[5];
        }
        else
        {
            dbg_log("Read counter0 pg=" + pg, LOG_NET);
            return 0;
        }
    });

    io.register_read(this.port | EN0_COUNTER1, this, function()
    {
        var pg = this.get_page();
        if(pg === 1)
        {
            dbg_log("Read mar6", LOG_NET);
            return this.mar[6];
        }
        else
        {
            dbg_log("Read8 counter1 pg=" + pg, LOG_NET);
            return 0;
        }
    }, function()
    {
        dbg_log("Read16 counter1 pg=" + this.get_page(), LOG_NET);
        // openbsd
        return 0;
    }
    );

    io.register_read(this.port | EN0_COUNTER2, this, function()
    {
        var pg = this.get_page();
        if(pg === 1)
        {
            dbg_log("Read mar7", LOG_NET);
            return this.mar[7];
        }
        else
        {
            dbg_log("Read counter2 pg=" + pg, LOG_NET);
            return 0;
        }
    });

    io.register_read(this.port | NE_RESET, this, function()
    {
        var pg = this.get_page();
        dbg_log("Read reset", LOG_NET);
        this.do_interrupt(ENISR_RESET);
        return 0;
    });

    io.register_write(this.port | NE_RESET, this, function(data_byte)
    {
        var pg = this.get_page();
        dbg_log("Write reset: " + h(data_byte, 2), LOG_NET);
        //this.isr &= ~ENISR_RESET;
    });

    io.register_read(this.port | EN0_STARTPG, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            return this.pstart;
        }
        else if(pg === 1)
        {
            dbg_log("Read pg1/01 (mac[0])", LOG_NET);
            return this.mac[0];
        }
        else if(pg === 2)
        {
            return this.pstart;
        }
        else
        {
            dbg_log("Read pg" + pg + "/01");
            dbg_assert(false);
            return 0;
        }
    });

    io.register_write(this.port | EN0_STARTPG, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("start page: " + h(data_byte, 2), LOG_NET);
            this.pstart = data_byte;
        }
        else if(pg === 1)
        {
            dbg_log("mac[0] = " + h(data_byte), LOG_NET);
            this.mac[0] = data_byte;
        }
        else if(pg === 3)
        {
            dbg_log("Unimplemented: Write pg3/01 (9346CR): " + h(data_byte), LOG_NET);
        }
        else
        {
            dbg_log("Write pg" + pg + "/01: " + h(data_byte), LOG_NET);
            dbg_assert(false);
        }
    });


    io.register_read(this.port | EN0_STOPPG, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            return this.pstop;
        }
        else if(pg === 1)
        {
            dbg_log("Read pg1/02 (mac[1])", LOG_NET);
            return this.mac[1];
        }
        else if(pg === 2)
        {
            return this.pstop;
        }
        else
        {
            dbg_log("Read pg" + pg + "/02", LOG_NET);
            dbg_assert(false);
            return 0;
        }
    });

    io.register_write(this.port | EN0_STOPPG, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("stop page: " + h(data_byte, 2), LOG_NET);
            if(data_byte > (this.memory.length >> 8))
            {
                data_byte = this.memory.length >> 8;
                dbg_log("XXX: Adjusting stop page to " + h(data_byte), LOG_NET);
            }
            this.pstop = data_byte;
        }
        else if(pg === 1)
        {
            dbg_log("mac[1] = " + h(data_byte), LOG_NET);
            this.mac[1] = data_byte;
        }
        else
        {
            dbg_log("Write pg" + pg + "/02: " + h(data_byte), LOG_NET);
            dbg_assert(false);
        }
    });

    io.register_read(this.port | EN0_ISR, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Read isr: " + h(this.isr, 2), LOG_NET);
            return this.isr;
        }
        else if(pg === 1)
        {
            dbg_log("Read curpg: " + h(this.curpg, 2), LOG_NET);
            return this.curpg;
        }
        else
        {
            dbg_assert(false);
            return 0;
        }
    });

    io.register_write(this.port | EN0_ISR, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            // acknowledge interrupts where bit is set
            dbg_log("Write isr: " + h(data_byte, 2), LOG_NET);
            this.isr &= ~data_byte;
            this.update_irq();
        }
        else if(pg === 1)
        {
            dbg_log("Write curpg: " + h(data_byte, 2), LOG_NET);
            this.curpg = data_byte;
        }
        else
        {
            dbg_assert(false);
        }
    });

    io.register_write(this.port | EN0_TXCR, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            this.txcr = data_byte;
            dbg_log("Write tx config: " + h(data_byte, 2), LOG_NET);
        }
        else
        {
            dbg_log("Unimplemented: Write pg" + pg + "/0d " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_write(this.port | EN0_DCFG, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write data configuration: " + h(data_byte, 2), LOG_NET);
            this.dcfg = data_byte;
        }
        else
        {
            dbg_log("Unimplemented: Write pg" + pg + "/0e " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_read(this.port | EN0_RCNTLO, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Read pg0/0a", LOG_NET);
            return 0x50;
        }
        else if(pg === 1)
        {
            dbg_log("Read mar2", LOG_NET);
            return this.mar[2];
        }
        else
        {
            dbg_assert(false, "TODO");
            return 0;
        }
    });

    io.register_write(this.port | EN0_RCNTLO, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write remote byte count low: " + h(data_byte, 2), LOG_NET);
            this.rcnt = this.rcnt & 0xFF00 | data_byte & 0xFF;
        }
        else
        {
            dbg_log("Unimplemented: Write pg" + pg + "/0a " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_read(this.port | EN0_RCNTHI, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Read pg0/0b", LOG_NET);
            return 0x43;
        }
        else if(pg === 1)
        {
            dbg_log("Read mar3", LOG_NET);
            return this.mar[3];
        }
        else
        {
            dbg_assert(false, "TODO");
            return 0;
        }
    });

    io.register_write(this.port | EN0_RCNTHI, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write remote byte count high: " + h(data_byte, 2), LOG_NET);
            this.rcnt = this.rcnt & 0xFF | data_byte << 8 & 0xFF00;
        }
        else
        {
            dbg_log("Unimplemented: Write pg" + pg + "/0b " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_read(this.port | EN0_RSARLO, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Read remote start address low", LOG_NET);
            return this.rsar & 0xFF;
        }
        else if(pg === 1)
        {
            dbg_log("Read mar0", LOG_NET);
            return this.mar[0];
        }
        else
        {
            dbg_log("Unimplemented: Read pg" + pg + "/08", LOG_NET);
            dbg_assert(false);
            return 0;
        }
    });

    io.register_write(this.port | EN0_RSARLO, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write remote start address low: " + h(data_byte, 2), LOG_NET);
            this.rsar = this.rsar & 0xFF00 | data_byte & 0xFF;
        }
        else
        {
            dbg_log("Unimplemented: Write pg" + pg + "/08 " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_read(this.port | EN0_RSARHI, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Read remote start address high", LOG_NET);
            return this.rsar >> 8 & 0xFF;
        }
        else if(pg === 1)
        {
            dbg_log("Read mar1", LOG_NET);
            return this.mar[1];
        }
        else
        {
            dbg_log("Unimplemented: Read pg" + pg + "/09", LOG_NET);
            dbg_assert(false);
            return 0;
        }
    });

    io.register_write(this.port | EN0_RSARHI, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write remote start address low: " + h(data_byte, 2), LOG_NET);
            this.rsar = this.rsar & 0xFF | data_byte << 8 & 0xFF00;
        }
        else
        {
            dbg_log("Unimplemented: Write pg" + pg + "/09 " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_write(this.port | EN0_IMR, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write interrupt mask register: " + h(data_byte, 2) + " isr=" + h(this.isr, 2), LOG_NET);
            this.imr = data_byte;
            this.update_irq();
        }
        else
        {
            dbg_log("Unimplemented: Write pg" + pg + "/0f " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_read(this.port | EN0_BOUNDARY, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Read boundary: " + h(this.boundary, 2), LOG_NET);
            return this.boundary;
        }
        else if(pg === 1)
        {
            dbg_log("Read pg1/03 (mac[2])", LOG_NET);
            return this.mac[2];
        }
        else if(pg === 3)
        {
            dbg_log("Unimplemented: Read pg3/03 (CONFIG0)", LOG_NET);
            return 0;
        }
        else
        {
            dbg_log("Read pg" + pg + "/03", LOG_NET);
            dbg_assert(false);
            return 0;
        }
    });

    io.register_write(this.port | EN0_BOUNDARY, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write boundary: " + h(data_byte, 2), LOG_NET);
            this.boundary = data_byte;
        }
        else if(pg === 1)
        {
            dbg_log("mac[2] = " + h(data_byte), LOG_NET);
            this.mac[2] = data_byte;
        }
        else
        {
            dbg_log("Write pg" + pg + "/03: " + h(data_byte), LOG_NET);
            dbg_assert(false);
        }
    });

    io.register_read(this.port | EN0_TSR, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            return this.tsr;
        }
        else if(pg === 1)
        {
            dbg_log("Read pg1/04 (mac[3])", LOG_NET);
            return this.mac[3];
        }
        else
        {
            dbg_log("Read pg" + pg + "/04", LOG_NET);
            dbg_assert(false);
            return 0;
        }
    });

    io.register_write(this.port | EN0_TPSR, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write tpsr: " + h(data_byte, 2), LOG_NET);
            this.tpsr = data_byte;
        }
        else if(pg === 1)
        {
            dbg_log("mac[3] = " + h(data_byte), LOG_NET);
            this.mac[3] = data_byte;
        }
        else
        {
            dbg_log("Write pg" + pg + "/04: " + h(data_byte), LOG_NET);
            dbg_assert(false);
        }
    });

    io.register_read(this.port | EN0_TCNTLO, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Unimplemented: Read pg0/05 (NCR: Number of Collisions Register)", LOG_NET);
            return 0;
        }
        else if(pg === 1)
        {
            dbg_log("Read pg1/05 (mac[4])", LOG_NET);
            return this.mac[4];
        }
        else if(pg === 3)
        {
            dbg_log("Unimplemented: Read pg3/05 (CONFIG2)", LOG_NET);
            return 0;
        }
        else
        {
            dbg_log("Read pg" + pg + "/05", LOG_NET);
            dbg_assert(false);
            return 0;
        }
    });

    io.register_write(this.port | EN0_TCNTLO, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write tcnt low: " + h(data_byte, 2), LOG_NET);
            this.tcnt = this.tcnt & ~0xFF | data_byte;
        }
        else if(pg === 1)
        {
            dbg_log("mac[4] = " + h(data_byte), LOG_NET);
            this.mac[4] = data_byte;
        }
        else if(pg === 3)
        {
            dbg_log("Unimplemented: Write pg3/05 (CONFIG2): " + h(data_byte), LOG_NET);
        }
        else
        {
            dbg_log("Write pg" + pg + "/05: " + h(data_byte), LOG_NET);
            dbg_assert(false);
        }
    });

    io.register_read(this.port | EN0_TCNTHI, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_assert(false, "TODO");
            return 0;
        }
        else if(pg === 1)
        {
            dbg_log("Read pg1/06 (mac[5])", LOG_NET);
            return this.mac[5];
        }
        else if(pg === 3)
        {
            dbg_log("Unimplemented: Read pg3/06 (CONFIG3)", LOG_NET);
            return 0;
        }
        else
        {
            dbg_log("Read pg" + pg + "/06", LOG_NET);
            dbg_assert(false);
            return 0;
        }
    });

    io.register_write(this.port | EN0_TCNTHI, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write tcnt high: " + h(data_byte, 2), LOG_NET);
            this.tcnt = this.tcnt & 0xFF | data_byte << 8;
        }
        else if(pg === 1)
        {
            dbg_log("mac[5] = " + h(data_byte), LOG_NET);
            this.mac[5] = data_byte;
        }
        else if(pg === 3)
        {
            dbg_log("Unimplemented: Write pg3/06 (CONFIG3): " + h(data_byte), LOG_NET);
        }
        else
        {
            dbg_log("Write pg" + pg + "/06: " + h(data_byte), LOG_NET);
            dbg_assert(false);
        }
    });

    io.register_read(this.port | EN0_RSR, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            return 1 | 1 << 3; // receive status ok
        }
        else if(pg === 1)
        {
            dbg_log("Read mar4", LOG_NET);
            return this.mar[4];
        }
        else
        {
            dbg_log("Unimplemented: Read pg" + pg + "/0c", LOG_NET);
            dbg_assert(false);
            return 0;
        }
    });

    io.register_write(this.port | EN0_RXCR, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("RX configuration reg write: " + h(data_byte, 2), LOG_NET);
            this.rxcr = data_byte;
        }
        else
        {
            dbg_log("Unimplemented: Write pg" + pg + "/0c: " + h(data_byte), LOG_NET);
        }
    });

    io.register_read(this.port | NE_DATAPORT | 0, this,
            this.data_port_read8,
            this.data_port_read16,
            this.data_port_read32);
    io.register_write(this.port | NE_DATAPORT | 0, this,
            this.data_port_write16,
            this.data_port_write16,
            this.data_port_write32);

    if(use_pci)
    {
        cpu.devices.pci.register_device(this);
    }
}

Ne2k.prototype.get_state = function()
{
    var state = [];

    state[0] = this.isr;
    state[1] = this.imr;
    state[2] = this.cr;
    state[3] = this.dcfg;
    state[4] = this.rcnt;
    state[5] = this.tcnt;
    state[6] = this.tpsr;
    state[7] = this.rsar;
    state[8] = this.pstart;
    state[9] = this.curpg;
    state[10] = this.boundary;
    state[11] = this.pstop;
    state[12] = this.rxcr;
    state[13] = this.txcr;
    state[14] = this.tsr;
    state[15] = this.mac;
    state[16] = this.memory;

    return state;
};

Ne2k.prototype.set_state = function(state)
{
    this.isr = state[0];
    this.imr = state[1];
    this.cr = state[2];
    this.dcfg = state[3];
    this.rcnt = state[4];
    this.tcnt = state[5];
    this.tpsr = state[6];
    this.rsar = state[7];
    this.pstart = state[8];
    this.curpg = state[9];
    this.boundary = state[10];
    this.pstop = state[11];
    this.rxcr = state[12];
    this.txcr = state[13];
    this.tsr = state[14];

    if(this.preserve_mac_from_state_image)
    {
        this.mac = state[15];
        this.memory = state[16];
    }
    else if(this.mac_address_translation)
    {
        this.mac_address_in_state = state[15];
        this.memory = state[16];

        dbg_log("Using mac address translation" +
            " guest_os_mac=" + format_mac(this.mac_address_in_state) +
            " real_mac=" + format_mac(this.mac), LOG_NET);
    }
    this.bus.send("net" + this.id + "-mac", format_mac(this.mac));
};

Ne2k.prototype.do_interrupt = function(ir_mask)
{
    dbg_log("Do interrupt " + h(ir_mask, 2), LOG_NET);
    this.isr |= ir_mask;
    this.update_irq();
};

Ne2k.prototype.update_irq = function()
{
    if(this.imr & this.isr)
    {
        this.pci.raise_irq(this.pci_id);
    }
    else
    {
        this.pci.lower_irq(this.pci_id);
    }
};

Ne2k.prototype.data_port_write = function(data_byte)
{
    if(NE2K_LOG_VERBOSE)
    {
        dbg_log("Write data port: data=" + h(data_byte & 0xFF, 2) +
                                " rsar=" + h(this.rsar, 4) +
                                " rcnt=" + h(this.rcnt, 4), LOG_NET);
    }

    if(this.rsar <= 0x10 || this.rsar >= (START_PAGE << 8) && this.rsar < (STOP_PAGE << 8))
    {
        this.memory[this.rsar] = data_byte;
    }

    this.rsar++;
    this.rcnt--;

    if(this.rsar >= (this.pstop << 8))
    {
        this.rsar += (this.pstart - this.pstop) << 8;
    }

    if(this.rcnt === 0)
    {
        this.do_interrupt(ENISR_RDC);
    }
};

Ne2k.prototype.data_port_write16 = function(data)
{
    this.data_port_write(data);

    if(this.dcfg & 1)
    {
        this.data_port_write(data >> 8);
    }
};

Ne2k.prototype.data_port_write32 = function(data)
{
    this.data_port_write(data);
    this.data_port_write(data >> 8);
    this.data_port_write(data >> 16);
    this.data_port_write(data >> 24);
};

Ne2k.prototype.data_port_read = function()
{
    let data = 0;

    if(this.rsar < (STOP_PAGE << 8))
    {
        data = this.memory[this.rsar];
    }

    if(NE2K_LOG_VERBOSE)
    {
        dbg_log("Read data port: data=" + h(data, 2) +
                               " rsar=" + h(this.rsar, 4) +
                               " rcnt=" + h(this.rcnt, 4), LOG_NET);
    }

    this.rsar++;
    this.rcnt--;

    if(this.rsar >= (this.pstop << 8))
    {
        this.rsar += (this.pstart - this.pstop) << 8;
    }

    if(this.rcnt === 0)
    {
        this.do_interrupt(ENISR_RDC);
    }

    return data;
};

Ne2k.prototype.data_port_read8 = function()
{
    return this.data_port_read16() & 0xFF;
};

Ne2k.prototype.data_port_read16 = function()
{
    if(this.dcfg & 1)
    {
        return this.data_port_read() | this.data_port_read() << 8;
    }
    else
    {
        return this.data_port_read();
    }
};

Ne2k.prototype.data_port_read32 = function()
{
    return this.data_port_read() | this.data_port_read() << 8 |
            this.data_port_read() << 16 | this.data_port_read() << 24;
};

Ne2k.prototype.receive = function(data)
{
    // called from the adapter when data is received over the network

    if(this.cr & 1)
    {
        // stop bit set
        return;
    }

    if(NE2K_LOG_PACKETS)
    {
        dump_packet(data, "receive");
    }

    this.bus.send("eth-receive-end", [data.length]);

    if(this.rxcr & 0x10)
    {
        // promiscuous
    }
    else if((this.rxcr & 4) &&
            data[0] === 0xFF && data[1] === 0xFF && data[2] === 0xFF &&
            data[3] === 0xFF && data[4] === 0xFF && data[5] === 0xFF)
    {
        // broadcast
    }
    else if((this.rxcr & 8) && (data[0] & 1) === 1)
    {
        // multicast
        // XXX
        return;
    }
    else if(data[0] === this.mac[0] && data[1] === this.mac[1] &&
            data[2] === this.mac[2] && data[3] === this.mac[3] &&
            data[4] === this.mac[4] && data[5] === this.mac[5])
    {
    }
    else
    {
        return;
    }

    if(this.mac_address_in_state)
    {
        data = new Uint8Array(data); // make a copy
        translate_mac_address(data, this.mac, this.mac_address_in_state);
    }

    var packet_length = Math.max(60, data.length);

    var offset = this.curpg << 8;
    var total_length = packet_length + 4;
    var data_start = offset + 4;
    var next = this.curpg + 1 + (total_length >> 8);

    var end = offset + total_length;

    const needed = 1 + (total_length >> 8);

    // boundary == curpg interpreted as ringbuffer empty
    const available = this.boundary > this.curpg ?
        this.boundary - this.curpg :
        this.pstop - this.curpg + this.boundary - this.pstart;

    if(available < needed &&
        this.boundary !== 0 // XXX: ReactOS sets this to 0 initially and never updates it unless it receives a packet
    )
    {
        dbg_log("Buffer full, dropping packet pstart=" + h(this.pstart) + " pstop=" + h(this.pstop) +
            " curpg=" + h(this.curpg) + " needed=" + h(needed) + " boundary=" + h(this.boundary) + " available=" + h(available), LOG_NET);
        return;
    }

    if(end > (this.pstop << 8))
    {
        // Shouldn't happen because at this size it can't cross a page,
        // so we can skip filling with zeroes
        dbg_assert(data.length >= 60);

        var cut = (this.pstop << 8) - data_start;
        dbg_assert(cut >= 0);

        this.memory.set(data.subarray(0, cut), data_start);
        this.memory.set(data.subarray(cut), this.pstart << 8);
        dbg_log("rcv cut=" + h(cut), LOG_NET);
    }
    else
    {
        this.memory.set(data, data_start);

        if(data.length < 60)
        {
            this.memory.fill(0, data_start + data.length, data_start + 60);
        }
    }

    if(next >= this.pstop)
    {
        next += this.pstart - this.pstop;
    }

    // write packet header
    this.memory[offset] = ENRSR_RXOK; // status
    this.memory[offset + 1] = next;
    this.memory[offset + 2] = total_length;
    this.memory[offset + 3] = total_length >> 8;

    this.curpg = next;

    dbg_log("rcv offset=" + h(offset) + " len=" + h(total_length) + " next=" + h(next), LOG_NET);

    this.do_interrupt(ENISR_RX);
};

Ne2k.prototype.get_page = function()
{
    return this.cr >> 6 & 3;
};
