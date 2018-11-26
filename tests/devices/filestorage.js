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

function mock_indexeddb()
{
    const db = new Map();
    return {
        transaction(store_name, mode) {
            const transaction = {
                objectStore(store_name) {
                    return {
                        get(key) {
                            assert_transaction_active(`get ${key}`);
                            const result = db.get(key);
                            const request = { result };
                            mock_request_completion(request);
                            return request;
                        },
                        put(value) {
                            assert_transaction_active(`put ${value}`);
                            const key = value["sha256sum"];
                            db.set(key, value);
                            const request = {};
                            mock_request_completion(request);
                            return request;
                        },
                    };
                },
            };

            let completed = false;
            let pending_requests = 0;

            function assert_transaction_active(verb)
            {
                if(completed)
                {
                    log_fail(`Attempted to ${verb} after transaction expired`);
                    process.exit(1);
                }
            }
            function mock_request_completion(request)
            {
                pending_requests++;
                setTimeout(() =>
                {
                    pending_requests--;

                    setTimeout(() =>
                    {
                        if(!pending_requests)
                        {
                            completed = true;
                            if(transaction.oncomplete)
                            {
                                transaction.oncomplete();
                            }
                        }
                    }, 0);

                    if(request.onsuccess)
                    {
                        request.onsuccess();
                    }
                }, 0);
            }
            return transaction;
        },
    };
}

async function test_read(oracle, iut, key, offset, count) // jshint ignore:line
{
    const expected = await oracle.read(key, offset, count); // jshint ignore:line
    const actual = await iut.read(key, offset, count); // jshint ignore:line
    return assert_uint8array_equal(actual, expected);
}

async function test_with_file(oracle, iut, key, file_data) // jshint ignore:line
{
    console.log("Testing file with size: %d", file_data.length);
    await oracle.set(key, file_data); // jshint ignore:line
    await iut.set(key, file_data); // jshint ignore:line

    // Some boundary values.
    if(!await test_read(oracle, iut, key, 0, 0)) return false; // jshint ignore:line
    if(!await test_read(oracle, iut, key, 0, 1)) return false; // jshint ignore:line
    if(!await test_read(oracle, iut, key, 0, 4096)) return false; // jshint ignore:line
    if(!await test_read(oracle, iut, key, 0, 4097)) return false; // jshint ignore:line
    if(!await test_read(oracle, iut, key, 4095, 2)) return false; // jshint ignore:line
    if(!await test_read(oracle, iut, key, 4096, 1)) return false; // jshint ignore:line
    if(!await test_read(oracle, iut, key, 4096, 4096)) return false; // jshint ignore:line
    if(!await test_read(oracle, iut, key, 4097, 1)) return false; // jshint ignore:line
    if(!await test_read(oracle, iut, key, 4097, 4095)) return false; // jshint ignore:line

    // Random ranges.
    for(let i = 0; i < NUMBER_OF_TESTREADS; i++)
    {
        const offset = Math.floor(Math.random() * MAX_TESTFILE_SIZE);
        const count = Math.floor(Math.random() * MAX_TESTFILE_SIZE);
        const pass = await test_read(oracle, iut, key, offset, count); // jshint ignore:line
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
    // Test oracle without chunking.
    const oracle = new MemoryFileStorage();

    // Implementation under test with chunking.
    const iut = new IndexedDBFileStorage(mock_indexeddb());

    if(!await test_with_file(oracle, iut, "empty", new Uint8Array(0))) return false; // jshint ignore:line
    if(!await test_with_file(oracle, iut, "single", new Uint8Array(1).map(v => Math.random() * 0xFF))) return false; // jshint ignore:line
    if(!await test_with_file(oracle, iut, "1block", new Uint8Array(4096).map(v => Math.random() * 0xFF))) return false; // jshint ignore:line

    for(let i = 0; i < NUMBER_OF_TESTFILES; i++)
    {
        const size = Math.floor(Math.random() * MAX_TESTFILE_SIZE);
        const file_data = new Uint8Array(size).map(v => Math.random() * 0xFF);
        const pass = await test_with_file(oracle, iut, i.toString(), file_data); // jshint ignore:line
        if(!pass) return false;
    }

    log_pass("All tests passed!");
    return true;
}

test_start().then(pass => pass || process.exit(1));