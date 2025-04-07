// -------------------------------------------------
// ------------------ Marshall ---------------------
// -------------------------------------------------
// helper functions for virtio and 9p.

import { dbg_log } from "./../src/log.js";

const textde = new TextDecoder();
const texten = new TextEncoder();

// Inserts data from an array to a byte aligned struct in memory
export function Marshall(typelist, input, struct, offset) {
    var item;
    var size = 0;
    for(var i=0; i < typelist.length; i++) {
        item = input[i];
        switch(typelist[i]) {
            case "w":
                struct[offset++] = item & 0xFF;
                struct[offset++] = (item >> 8) & 0xFF;
                struct[offset++] = (item >> 16) & 0xFF;
                struct[offset++] = (item >> 24) & 0xFF;
                size += 4;
                break;
            case "d": // double word
                struct[offset++] = item & 0xFF;
                struct[offset++] = (item >> 8) & 0xFF;
                struct[offset++] = (item >> 16) & 0xFF;
                struct[offset++] = (item >> 24) & 0xFF;
                struct[offset++] = 0x0;
                struct[offset++] = 0x0;
                struct[offset++] = 0x0;
                struct[offset++] = 0x0;
                size += 8;
                break;
            case "h":
                struct[offset++] = item & 0xFF;
                struct[offset++] = item >> 8;
                size += 2;
                break;
            case "b":
                struct[offset++] = item;
                size += 1;
                break;
            case "s":
                var lengthoffset = offset;
                var length = 0;
                struct[offset++] = 0; // set the length later
                struct[offset++] = 0;
                size += 2;

                var stringBytes = texten.encode(item);
                size += stringBytes.byteLength;
                length += stringBytes.byteLength;
                struct.set(stringBytes, offset);
                offset += stringBytes.byteLength;

                struct[lengthoffset+0] = length & 0xFF;
                struct[lengthoffset+1] = (length >> 8) & 0xFF;
                break;
            case "Q":
                Marshall(["b", "w", "d"], [item.type, item.version, item.path], struct, offset);
                offset += 13;
                size += 13;
                break;
            default:
                dbg_log("Marshall: Unknown type=" + typelist[i]);
                break;
        }
    }
    return size;
}


// Extracts data from a byte aligned struct in memory to an array
export function Unmarshall(typelist, struct, state) {
    let offset = state.offset;
    var output = [];
    for(var i=0; i < typelist.length; i++) {
        switch(typelist[i]) {
            case "w":
                var val = struct[offset++];
                val += struct[offset++] << 8;
                val += struct[offset++] << 16;
                val += (struct[offset++] << 24) >>> 0;
                output.push(val);
                break;
            case "d":
                var val = struct[offset++];
                val += struct[offset++] << 8;
                val += struct[offset++] << 16;
                val += (struct[offset++] << 24) >>> 0;
                offset += 4;
                output.push(val);
                break;
            case "h":
                var val = struct[offset++];
                output.push(val + (struct[offset++] << 8));
                break;
            case "b":
                output.push(struct[offset++]);
                break;
            case "s":
                var len = struct[offset++];
                len += struct[offset++] << 8;

                var stringBytes = struct.slice(offset, offset + len);
                offset += len;
                output.push(textde.decode(stringBytes));
                break;
            case "Q":
                state.offset = offset;
                const qid = Unmarshall(["b", "w", "d"], struct, state);
                offset = state.offset;
                output.push({
                    type: qid[0],
                    version: qid[1],
                    path: qid[2],
                });
                break;
            default:
                dbg_log("Error in Unmarshall: Unknown type=" + typelist[i]);
                break;
        }
    }
    state.offset = offset;
    return output;
}
