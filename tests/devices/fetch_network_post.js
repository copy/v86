#!/usr/bin/env node
/**
 * Test: multi-segment HTTP POST/PUT body buffering in fetch_network adapter.
 *
 * Verifies that a POST body split across multiple TCP segments is fully
 * buffered and dispatched, rather than truncated at the first segment.
 *
 * Run:  node tests/devices/fetch_network_post.js
 */

import assert from "node:assert/strict";
import { FetchNetworkAdapter } from "../../src/browser/fetch_network.js";

const text_encoder = new TextEncoder();

let tests_passed = 0;
let tests_failed = 0;

function test(name, fn) {
    process.stdout.write(name + " ... ");
    try {
        fn();
        console.log("PASS");
        tests_passed++;
    } catch(e) {
        console.log("FAIL");
        console.log("  " + e.message);
        tests_failed++;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock BusConnector and FetchNetworkAdapter, returning
 *  the captured `on_data_http` handler and the adapter itself. */
function setup() {
    // Capture fetch() calls so we can inspect them.
    let fetch_calls = [];
    let bus_handler = null;

    const bus = {
        register(event, handler, ctx) {
            if(event === "tcp-connection") bus_handler = handler.bind(ctx);
        },
        send(event, data) { /* noop */ },
    };

    const adapter = new FetchNetworkAdapter(bus, {});
    // Override adapter.fetch to capture rather than actually fetching.
    adapter.fetch = (url, opts) => {
        fetch_calls.push({ url, opts });
        // Return a promise that resolves with a mock response.
        return Promise.resolve([
            { status: 200, statusText: "OK", headers: new Headers() },
            new ArrayBuffer(0),
        ]);
    };

    // The connection's write/close methods need to exist; make them no-ops.
    const connection = {
        sport: 80,
        handlers: {},
        on(event, handler) {
            this.handlers[event] = handler;
        },
        accept() {},
        write() {},
        writev() {},
        close() {},
        net: adapter,
    };

    // Trigger the bus handler to register on_data_http.
    bus_handler(connection);

    const on_data = connection.handlers["data"];
    if(!on_data) throw new Error("on_data_http not registered");

    // Wrap so `this` inside on_data_http is bound to the mock connection.
    const dispatch = (buf) => on_data.call(connection, buf);

    return { dispatch, adapter, fetch_calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Small POST body fits in one segment", () => {
    const { dispatch, fetch_calls } = setup();

    const body = "hello world";
    const request = "POST /api HTTP/1.1\r\nHost: example.com\r\nContent-Length: 11\r\n\r\n" + body;
    dispatch(text_encoder.encode(request).buffer);

    assert.equal(fetch_calls.length, 1, "fetch should be called once");
    const { opts } = fetch_calls[0];
    assert.ok(opts.body instanceof Uint8Array, "body should be Uint8Array");
    assert.equal(opts.body.length, 11, "body length should be 11");
});

test("Large POST body split across three segments", () => {
    const { dispatch, fetch_calls } = setup();

    const big_body = new Uint8Array(4000);
    big_body.fill(0x42); // 'B'

    const headers = "POST /api HTTP/1.1\r\nHost: example.com\r\nContent-Length: 4000\r\n\r\n";
    const hdr_bytes = text_encoder.encode(headers);

    // Segment 1: headers + first 1000 bytes of body
    const seg1 = new Uint8Array(hdr_bytes.length + 1000);
    seg1.set(hdr_bytes);
    seg1.set(big_body.slice(0, 1000), hdr_bytes.length);
    dispatch(seg1.buffer);
    assert.equal(fetch_calls.length, 0, "no fetch yet — body incomplete");

    // Segment 2: next 1500 bytes
    dispatch(big_body.slice(1000, 2500).buffer);
    assert.equal(fetch_calls.length, 0, "still no fetch");

    // Segment 3: final 1500 bytes
    dispatch(big_body.slice(2500, 4000).buffer);
    assert.equal(fetch_calls.length, 1, "fetch called now");

    const body = fetch_calls[0].opts.body;
    assert.ok(body instanceof Uint8Array, "body should be Uint8Array");
    assert.equal(body.length, 4000, "all 4000 bytes present");
    assert.equal(body[0], 0x42, "first byte preserved");
    assert.equal(body[3999], 0x42, "last byte preserved");
});

test("Binary body with embedded CRLFCRLF is not corrupted", () => {
    const { dispatch, fetch_calls } = setup();

    // Body contains the byte sequence 0x0D 0x0A 0x0D 0x0A (\r\n\r\n) inside it
    const bin_body = new Uint8Array([0xAA, 0x0D, 0x0A, 0x0D, 0x0A, 0xBB]);
    const headers = "POST /api HTTP/1.1\r\nHost: example.com\r\nContent-Length: 6\r\n\r\n";
    const hdr_bytes = text_encoder.encode(headers);

    const full = new Uint8Array(hdr_bytes.length + bin_body.length);
    full.set(hdr_bytes);
    full.set(bin_body, hdr_bytes.length);
    dispatch(full.buffer);

    assert.equal(fetch_calls.length, 1);
    const body = fetch_calls[0].opts.body;
    assert.equal(body.length, 6, "body length should be 6");
    assert.equal(body[0], 0xAA);
    assert.equal(body[1], 0x0D);
    assert.equal(body[5], 0xBB);
});

test("GET request (no body) is dispatched immediately", () => {
    const { dispatch, fetch_calls } = setup();

    const request = "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n";
    dispatch(text_encoder.encode(request).buffer);

    assert.equal(fetch_calls.length, 1, "fetch called once");
    assert.equal(fetch_calls[0].opts.method, "GET");
});

test("Headers split across two segments", () => {
    const { dispatch, fetch_calls } = setup();

    const body = "hi";
    const request = "POST /api HTTP/1.1\r\nHost: example.com\r\nContent-Length: 2\r\n\r\n" + body;

    // Split in the middle of a header line
    const bytes = text_encoder.encode(request);
    const mid = Math.floor(bytes.length * 0.4);

    dispatch(bytes.slice(0, mid).buffer);
    assert.equal(fetch_calls.length, 0, "no fetch — headers incomplete");

    dispatch(bytes.slice(mid).buffer);
    assert.equal(fetch_calls.length, 1, "fetch called after second segment");
    assert.equal(fetch_calls[0].opts.body.length, 2);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${tests_passed} passed, ${tests_failed} failed`);
process.exit(tests_failed > 0 ? 1 : 0);
