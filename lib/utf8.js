// -------------------------------------------------
// ------------------ UTF8 Helpers -----------------
// -------------------------------------------------

"use strict";

const textde = new TextDecoder();
const texten = new TextEncoder();

function utf8_len(s) {
    return texten.encode(s).length;
}
