"use strict";

const assert = require("assert");
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

function mkdirpSync(dir)
{
    path.normalize(dir).split(path.sep).reduce((accum_path, dir) => {
        const new_dir = accum_path + dir + path.sep;
        if(!fs.existsSync(new_dir)) fs.mkdirSync(new_dir);
        return new_dir;
    }, "");
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

function create_backup_file(src, dest)
{
    try
    {
        fs.copyFileSync(src, dest);
    }
    catch(e)
    {
        if(e.code !== "ENOENT") throw e;
        fs.writeFileSync(dest, "");
    }
}

function create_diff_file(in1, in2, out)
{
    const diff = child_process.spawnSync("git", ["diff", "--no-index", in1, in2]).stdout;
    fs.writeFileSync(out, diff);
}

function finalize_table(out_dir, name, contents)
{
    const file_path = path.join(out_dir, `${name}.c`);
    const backup_file_path = path.join(out_dir, `${name}.c.bak`);
    const diff_file_path = path.join(out_dir, `${name}.c.diff`);

    create_backup_file(file_path, backup_file_path);
    fs.writeFileSync(file_path, contents);
    create_diff_file(backup_file_path, file_path, diff_file_path);

    console.log(CYAN_FMT, `[+] Wrote table ${name}. Remember to check ${diff_file_path}`);
}

module.exports = {
    hex,
    mkdirpSync,
    get_switch_value,
    get_switch_exist,
    finalize_table,
};
