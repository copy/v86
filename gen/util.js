"use strict";

const assert = require("assert");
const fs = require("fs");
const process = require("process");

function hex(n, pad)
{
    pad = pad || 0;
    let s = n.toString(16).toUpperCase();
    while(s.length < pad) s = "0" + s;
    return s;
}

function get_switch_value(arg_switch)
{
    const argv = process.argv;
    const switch_i = argv.indexOf(arg_switch);
    const val_i = switch_i + 1;
    if(switch_i > -1 && val_i < argv.length)
    {
        return argv[switch_i + 1];
    }
    return false;
}

function get_switch_exist(arg_switch)
{
    return process.argv.indexOf(arg_switch) > -1;
}

module.exports = {
    hex,
    get_switch_value,
    get_switch_exist,
};
