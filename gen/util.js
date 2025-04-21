import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const CYAN_FMT = "\x1b[36m%s\x1b[0m";

export function hex(n, pad)
{
    pad = pad || 0;
    let s = n.toString(16).toUpperCase();
    while(s.length < pad) s = "0" + s;
    return s;
}

export function get_switch_value(arg_switch)
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

export function get_switch_exist(arg_switch)
{
    return process.argv.includes(arg_switch);
}

export function finalize_table_rust(out_dir, name, contents)
{
    const file_path = path.join(out_dir, name);
    fs.writeFileSync(file_path, contents);
    console.log(CYAN_FMT, `[+] Wrote table ${name}.`);
}
