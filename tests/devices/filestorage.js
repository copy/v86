#!/usr/bin/env node
"use strict";

process.on("unhandledRejection", exn => { throw exn; });
const util = require("util");
const { MemoryFileStorage, IndexedDBFileStorage } = require("../../build/libv86-debug.js");

const MAX_TESTFILE_SIZE = 16384;
const NUMBER_OF_TESTFILES = 16;
const NUMBER_OF_TESTREADS = 64;

function log_pass(msg, ...args)
{
    console.log(`\x1b[92m[+] ${msg}\x1b[0m`, ...args);
}

function log_fail(msg, ...args)
{
    console.error(`\x1b[91m[-] ${msg}\x1b[0m`, ...args);
}

function assert_uint8array_equal(actual, expected)
{
    if(actual === null || expected === null)
    {
        if(actual !== null || expected !== null)
        {
            const the_null = actual ? "expected" : "actual";
            const not_null = actual ? "actual" : "expected";
            log_fail("Failed assert equal. %s is null but %s is not", the_null, not_null);
            return false;
        }
        else
        {
            return true;
        }
    }
    if(actual.length !== expected.length)
    {
        log_fail("Failed assert equal - lengths differ. Actual length: %d, Expected length: %d",
            actual.length, expected.length);
        return false;
    }
    for(let i = 0; i < actual.length; i++)
    {
        if(actual[i] !== expected[i])
        {
            log_fail("Failed assert equal at position %d. Actual: %d, Expected %d",
                i, actual[i], expected[i]);
            return false;
        }
    }
    return true;
}

const db = new Map();
function mock_indexeddb()
{
    return {
        transaction(store_name, mode) {
            return {
                objectStore(store_name) {
                    return {
                        get(key) {
                            const result = db.get(key);
                            const request = { result };
                            setTimeout(() => request.onsuccess(), 0);
                            return request;
                        },
                        put(value) {
                            const key = value["sha256sum"];
                            db.set(key, value);
                            const request = {};
                            setTimeout(() => request.onsuccess(), 0);
                            return request;
                        },
                    };
                },
            };
        },
    };
}

// Oracle without chunking.
const memory_file_storage = new MemoryFileStorage();

// IUT with chunking.
const indexeddb_file_storage = new IndexedDBFileStorage(mock_indexeddb());

async function test_read(key, offset, count) // jshint ignore:line
{
    const expected = await memory_file_storage.read(key, offset, count); // jshint ignore:line
    const actual = await indexeddb_file_storage.read(key, offset, count); // jshint ignore:line
    return assert_uint8array_equal(actual, expected);
}

async function test_with_file(key, file_data) // jshint ignore:line
{
    console.log("Testing file with size: %d", file_data.length);
    await memory_file_storage.set(key, file_data); // jshint ignore:line
    await indexeddb_file_storage.set(key, file_data); // jshint ignore:line

    // Some boundary values.
    if(!await test_read(key, 0, 0)) return; // jshint ignore:line
    if(!await test_read(key, 0, 1)) return; // jshint ignore:line
    if(!await test_read(key, 0, 4096)) return; // jshint ignore:line
    if(!await test_read(key, 0, 4097)) return; // jshint ignore:line
    if(!await test_read(key, 4095, 2)) return; // jshint ignore:line
    if(!await test_read(key, 4096, 1)) return; // jshint ignore:line
    if(!await test_read(key, 4096, 4096)) return; // jshint ignore:line
    if(!await test_read(key, 4097, 1)) return; // jshint ignore:line
    if(!await test_read(key, 4097, 4095)) return; // jshint ignore:line

    // Random ranges.
    for(let i = 0; i < NUMBER_OF_TESTREADS; i++)
    {
        const offset = Math.floor(Math.random() * MAX_TESTFILE_SIZE);
        const count = Math.floor(Math.random() * MAX_TESTFILE_SIZE);
        const pass = await test_read(key, offset, count); // jshint ignore:line
        if(!pass)
        {
            log_fail("Test case offset=%d, count=%d", offset, count);
            return false;
        }
    }

    return true;
}

async function test_start() // jshint ignore:line
{
    if(!await test_with_file("empty", new Uint8Array(0))) return; // jshint ignore:line
    if(!await test_with_file("single", new Uint8Array(1).map(v => Math.random() * 0xFF))) return; // jshint ignore:line
    if(!await test_with_file("1block", new Uint8Array(4096).map(v => Math.random() * 0xFF))) return; // jshint ignore:line

    for(let i = 0; i < NUMBER_OF_TESTFILES; i++)
    {
        const size = Math.floor(Math.random() * MAX_TESTFILE_SIZE);
        const file_data = new Uint8Array(size).map(v => Math.random() * 0xFF);
        const pass = await test_with_file(i.toString(), file_data); // jshint ignore:line
        if(!pass) return;
    }
    log_pass("All tests passed!");
}

test_start();
