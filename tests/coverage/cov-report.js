#!/usr/bin/env node
"use strict";

const Buffer = require("buffer").Buffer;
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const DATA_PATH = path.join(__dirname, "..", "..", "build");
const REPORT_PATH = path.join(__dirname, "build");

const data_regex = /^cov_data_(.*)_([0-9]+)$/;
const data_files = fs.readdirSync(DATA_PATH);
const report_files = fs.readdirSync(REPORT_PATH);
const report_regex = /^report_([0-9]+)$/;
const report_num = report_files.filter(name => {
    // Only report_* files
    return report_regex.test(name);
}).map(
    // report_{0,1} -> [0,1]
    report => Number(report.match(report_regex)[1])
).reduce(
    // reduce to max report_num (1 in example), defaulting to 0
    (a, b) => (a > b ? a : b),
    0
);

const first_report = report_num === 0;
const prev_report_file = path.join(REPORT_PATH, `report_${report_num}`);
const prev_report_compare = path.join(REPORT_PATH, `report_{${report_num},${report_num + 1}}`);
const report_file = path.join(REPORT_PATH, `report_${report_num + 1}`);

if(!first_report)
{
    // May fail if parsed Number != text number, such as report_001 vs. report_1
    assert.ok(
        fs.existsSync(prev_report_file),
        `Report filename format inconsistent. Expected latest: ${prev_report_file}`
    );
}

let count_fns = 0;
const seen_fns = [];
for(let file of data_files)
{
    const data_filename_fmt = file.match(data_regex);
    if(!data_filename_fmt || data_filename_fmt.length !== 3)
    {
        continue;
    }

    count_fns++;
    const data = {
        fn_name: data_filename_fmt[1],
        total_blocks: data_filename_fmt[2],
        untouched: [],
    };

    // When old cov_data is not deleted, and the number of conditional blocks in a function change,
    // this may trigger
    assert.ok(seen_fns.indexOf(data.fn_name) === -1, `Function from ${file} seen already`);
    seen_fns.push(data.fn_name);

    const buffer = fs.readFileSync(path.join(DATA_PATH, file));
    for(let block_index = 0; block_index < data.total_blocks; block_index++)
    {
        if(buffer.indexOf(block_index) === -1)
        {
            assert.ok(block_index !== 0, `0th block untouched in ${file}`);
            data.untouched.push(block_index);
        }
    }

    // llvm logs the 0th block (function entry), which we don't want to consider
    // XXX: The 0th block also implies an `else` block sometimes, which we miss
    data.total_blocks--;

    const touched = data.total_blocks - data.untouched.length;
    const total = data.total_blocks;
    const untouched = data.untouched.length;
    const percent = total === 0 ? 100 : (touched / total * 100).toFixed(0);
    const log_str = `${percent}% | ${touched} / ${total}\ttouched in ${data.fn_name}; ` +
              `untouched: ${data.untouched}\n`;

    fs.appendFileSync(report_file, log_str);
}

console.log("[+] Writing to", report_file);
console.log("[+] Total functions:", count_fns);
console.log("[+] Helpful commands:");

console.log(`\tsort -n ${report_file} | less`);
if(!first_report)
{
    console.log(`\tgit diff --no-index ${prev_report_compare}`);
}
