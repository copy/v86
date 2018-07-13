// -------------------------------------------------
// ------------------ UTF8 Helpers -----------------
// -------------------------------------------------

"use strict";

var UTF8 = {};

/** @constructor */
function UTF8StreamToUnicode() {

    this.stream = new Uint8Array(5);
    this.ofs = 0;

    this.Put = function(key) {
        this.stream[this.ofs] = key;
        this.ofs++;
        switch(this.ofs) {
            case 1:
                if (this.stream[0] < 128) {
                    this.ofs = 0;
                    return this.stream[0];
                }
                break;

            case 2:
                if ((this.stream[0]&0xE0) == 0xC0)
                if ((this.stream[1]&0xC0) == 0x80) {
                    this.ofs = 0;
                    return ((this.stream[0]&0x1F)<<6) | (this.stream[1]&0x3F);
                }
                break;

            case 3:
                break;

            case 4:
                break;

            default:
                return -1;
                //this.ofs = 0;
                //break;
        }
        return -1;
    };
}

function UnicodeToUTF8Stream(key)
{
        if (key < 0x80)  return [key];
        if (key < 0x800) return [0xC0|((key>>6)&0x1F), 0x80|(key&0x3F)];
}

UTF8.UTF8Length = function(s)
{
    var length = 0;
    for(var i=0; i<s.length; i++) {
        var c = s.charCodeAt(i);
        length += c<128?1:2;
    }
    return length;
};
