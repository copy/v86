#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import assert from "node:assert/strict";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const DEBUG = process.env.DEBUG || false;
// Maximum number of gdb processes to spawn in parallel
const MAX_PARALLEL_PROCS = +process.env.MAX_PARALLEL_PROCS || 32;
// Default to true for now. It's slower, but async execution occasionally gets stuck
const SYNC_GDB_EXECUTION = process.env.SYNC_GDB_EXECUTION || true;

// Usage: console.log(CYAN_FMT, "This shows up in cyan!")
const CYAN_FMT = "\x1b[36m%s\x1b[0m";
const YELLOW_FMT = "\x1b[33m%s\x1b[0m";

const TEST_DIR = __dirname + "/";
const BUILD_DIR = path.join(TEST_DIR, "build");

const GDB_DEFAULT_ARGS = [
    "-batch",
    "--eval-command=set disable-randomization off", // allow execution on docker
    `--command=${TEST_DIR}gdb-extract-def`,
    // Set a breakpoint "in the future", which all the test binaries can then share
    "--eval-command=set breakpoint pending on",
    "--eval-command=break loop",
    "--eval-command=catch signal SIGFPE",
    "--eval-command=catch signal SIGILL",
    "--eval-command=catch signal SIGSEGV",
    "--eval-command=catch signal SIGBUS",
];

/* Split up an array into semi-evenly sized chunks */
function chunk(source, num_chunks)
{
    const arr = source.slice();
    const ret = [];

    let rem_chunks = num_chunks;
    while(rem_chunks > 0)
    {
        // We guarantee that the entire array is processed because when rem_chunk=1 -> len/1 = len
        ret.push(arr.splice(0, Math.floor(arr.length / rem_chunks)));
        rem_chunks--;
    }
    return ret;
}
assert(
    JSON.stringify(chunk("0 0 1 1 2 2 2 3 3 3".split(" "), 4)) ===
        JSON.stringify([["0", "0"],
                        ["1", "1"],
                        ["2", "2", "2"],
                        ["3", "3", "3"]]),
    "Chunk"
);

const dir_files = fs.readdirSync(BUILD_DIR);
const test_files = dir_files.filter(name => {
    return name.endsWith(".img");
}).map(name => {
    return name.slice(0, -4);
}).filter(name => {
    const bin_file = path.join(BUILD_DIR, `${name}.img`);
    const fixture_file = path.join(BUILD_DIR, `${name}.fixture`);
    if(!fs.existsSync(fixture_file))
    {
        return true;
    }
    return fs.statSync(bin_file).mtime > fs.statSync(fixture_file).mtime;
});

const nr_of_cpus = Math.min(
    os.cpus().length || 1,
    test_files.length,
    MAX_PARALLEL_PROCS
);

if(SYNC_GDB_EXECUTION)
{
    console.log("[+] Generating %d fixtures", test_files.length);
}
else
{
    console.log("[+] Using %d cpus to generate %d fixtures", nr_of_cpus, test_files.length);
}

const workloads = chunk(test_files, nr_of_cpus);

function test_arg_formatter(workload)
{
    return workload.map(test => {
        const test_path = path.join(BUILD_DIR, test);
        return `--eval-command=extract-state ${test_path}.img ${test_path}.fixture`;
    });
}

function set_proc_handlers(proc, n)
{
    proc.on("close", (code) => on_proc_close(code, n));

    if(DEBUG)
    {
        proc.stdout.on("data", (data) => {
            console.log(CYAN_FMT, "stdout", `${n}: ${data}`);
        });

        proc.stderr.on("data", (data) => {
            console.log(YELLOW_FMT, "stderr", `${n}: ${data}`);
        });
    }
}

function on_proc_close(code, n)
{
    console.log(`[+] child process ${n} exited with code ${code}`);
    if(code !== 0)
    {
        process.exit(code);
    }
}

for(let i = 0; i < nr_of_cpus; i++)
{
    const gdb_args = GDB_DEFAULT_ARGS.concat(test_arg_formatter(workloads[i]));

    if(DEBUG)
    {
        console.log(CYAN_FMT, "[DEBUG]", "gdb", gdb_args.join(" "));
    }

    if(SYNC_GDB_EXECUTION || nr_of_cpus === 1)
    {
        const { status: code } = spawnSync("gdb", gdb_args);
        on_proc_close(code, i);
    }
    else
    {
        const gdb = spawn("gdb", gdb_args);
        set_proc_handlers(gdb, i);
    }
}
