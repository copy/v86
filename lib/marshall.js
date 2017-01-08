// -------------------------------------------------
// ------------------ Marshall ---------------------
// -------------------------------------------------
// helper functions for virtio and 9p.

var marshall = {};


// Inserts data from an array to a byte aligned struct in memory
marshall.Marshall = function(typelist, input, struct, offset) {
    var item;
    var size = 0;
    for (var i=0; i < typelist.length; i++) {
        item = input[i];
        switch (typelist[i]) {
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
                for (var j in item) {
                    var utf8 = UnicodeToUTF8Stream(item.charCodeAt(j));
                    utf8.forEach( function(c) {
                        struct[offset++] = c;
                        size += 1;
                        length++;
                    });
                }
                struct[lengthoffset+0] = length & 0xFF;
                struct[lengthoffset+1] = (length >> 8) & 0xFF;
                break;
            case "Q":
                marshall.Marshall(["b", "w", "d"], [item.type, item.version, item.path], struct, offset)
                offset += 13;
                size += 13;
                break;
            default:
                message.Debug("Marshall: Unknown type=" + typelist[i]);
                break;
        }
    }
    return size;
};


// Extracts data from a byte aligned struct in memory to an array
marshall.Unmarshall = function(typelist, struct, offset) {
    var output = [];
    for (var i=0; i < typelist.length; i++) {
        switch (typelist[i]) {
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
                var str = '';
                var utf8converter = new UTF8StreamToUnicode();
                for (var j=0; j < len; j++) {
                    var c = utf8converter.Put(struct[offset++])
                    if (c == -1) continue;
                    str += String.fromCharCode(c);
                }
                output.push(str);
                break;
            default:
                message.Debug("Error in Unmarshall: Unknown type=" + typelist[i]);
                break;
        }
    }
    return output;
};


// Extracts data from a byte aligned struct in memory to an array
marshall.Unmarshall2 = function(typelist, GetByte) {
    var output = [];
    for (var i=0; i < typelist.length; i++) {
        switch (typelist[i]) {
            case "w":
                var val = GetByte();
                val += GetByte() << 8;
                val += GetByte() << 16;
                val += (GetByte() << 24) >>> 0;
                output.push(val);
                break;
            case "d":
                var val = GetByte();
                val += GetByte() << 8;
                val += GetByte() << 16;
                val += (GetByte() << 24) >>> 0;
                GetByte();GetByte();GetByte();GetByte();
                output.push(val);
                break;
            case "h":
                var val = GetByte();
                output.push(val + (GetByte() << 8));
                break;
            case "b":
                output.push(GetByte());
                break;
            case "s":
                var len = GetByte();
                len += GetByte() << 8;
                var str = '';
                var utf8converter = new UTF8StreamToUnicode();
                for (var j=0; j < len; j++) {
                    var c = utf8converter.Put(GetByte())
                    if (c == -1) continue;
                    str += String.fromCharCode(c);
                }
                output.push(str);
                break;
            default:
                message.Debug("Error in Unmarshall2: Unknown type=" + typelist[i]);
                break;
        }
    }
    return output;
};

