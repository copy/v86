"use strict";


function hex(n, pad)
{
    pad = pad || 0;
    let s = n.toString(16).toUpperCase();
    while(s.length < pad) s = "0" + s;
    return s;
}

module.exports = {
    hex,
};
