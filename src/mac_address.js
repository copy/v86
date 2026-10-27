// MAC addresses of the network cards (src/virtio_net.js and the card
// plugins, src/net_adapters/: the NE2000, the e1000): their notation, a new card's random
// address, and the translation between the address a restored guest has and
// the card's own.

import { LOG_NET } from "./const.js";
import { h } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";

/**
 * A new card's address: 00:22:15 and three random bytes
 * @return {!Uint8Array}
 */
export function random_mac()
{
    return new Uint8Array([
        0x00, 0x22, 0x15,
        Math.random() * 255 | 0,
        Math.random() * 255 | 0,
        Math.random() * 255 | 0,
    ]);
}

// Search and replace MAC addresses in ethernet, arp and dhcp packets.
// Used after restoring an OS from memory dump, so that multiple instances of
// that OS can run at the same time with different external MAC addresses.
// Crude but seems to work.
export function translate_mac_address(packet, search_mac, replacement_mac)
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
