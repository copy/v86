"use strict";

const assert = require("assert").strict || require("assert"); // Strict mode added in: V8.13.0
const fs = require("fs");
const path = require("path");
const process = require("process");
const child_process = require("child_process");

const CYAN_FMT = "\x1b[36m%s\x1b[0m";

function hex(n, pad)
{
    pad = pad || 0;
    let s = n.toString(16).toUpperCase();
    while(s.length < pad) s = "0" + s;
    return s;
}

function mkdirpSync(dir) {
    dir = dir.split('\\').join('/'); // replace to standard delimiter
    let dirParts = dir.split('/'); // split by folders delimiter
    let dirTmp = '';
    while (dirParts.length > 0) {
        dirTmp += dirParts.shift() + '/';
        if (!fs.existsSync(dirTmp)) {
            fs.mkdirSync(dirTmp);
        }
    }
    ///fs.mkdirSync(dir, { recursive: true });
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
    return null;
}

function get_switch_exist(arg_switch)
{
    return process.argv.includes(arg_switch);
}

function finalize_table_rust(out_dir, name, contents)
{
    const file_path = path.join(out_dir, name);
    fs.writeFileSync(file_path, contents);
    console.log(CYAN_FMT, `[+] Wrote table ${name}.`);
}

module.exports = {
    hex,
    mkdirpSync,
    get_switch_value,
    get_switch_exist,
    finalize_table_rust,
};
