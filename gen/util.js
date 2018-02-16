"use strict";

const assert = require("assert");
const fs = require("fs");

function hex(n, pad)
{
    pad = pad || 0;
    let s = n.toString(16).toUpperCase();
    while(s.length < pad) s = "0" + s;
    return s;
}

function write_sync_if_changed(filename, contents)
{
    assert.ok(typeof contents === "string", "Contents must be a string for comparison");

    let existing_contents = null;
    try
    {
        existing_contents = fs.readFileSync(filename).toString();
    }
    catch(e)
    {
        if(e.code !== "ENOENT") throw e;
    }

    const contents_changed = existing_contents !== contents;
    if(contents_changed)
    {
        fs.writeFileSync(filename, contents);
        console.log("[+] Writing", filename);
    }
}

module.exports = {
    hex,
    write_sync_if_changed
};
