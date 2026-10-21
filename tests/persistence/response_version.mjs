#!/usr/bin/env node
// check_response_version (src/buffer.js; docs/disk-persistence-plan.md
// "一致读取"): the first response's ETag, or without one its Last-Modified,
// is the version every later response of the file must have; responses
// without either (a cross-origin server that does not expose them) are not
// checked. The browser test (tests/persistence/browser_runner.mjs) covers
// the disks themselves.
import assert from "node:assert/strict";

const { check_response_version } = await import("../../src/buffer.js");
const response = headers => ({ getResponseHeader: name => headers[name] ?? null });
// (an XMLHttpRequest of a cross-origin response that exposes no ETag: getResponseHeader("ETag") would log
// "Refused to get unsafe header"; getAllResponseHeaders lists only what the page may read)
const cross_origin = headers => ({
    getAllResponseHeaders: () => Object.entries(headers).map(([name, value]) => name.toLowerCase() + ": " + value + "\r\n").join(""),
    getResponseHeader: name => { throw new Error("getResponseHeader(" + name + ") on a cross-origin response"); },
});

let versions = new Map();
assert.equal(check_response_version(versions, "a.img", response({ "ETag": "\"1\"", "Last-Modified": "Mon" })), undefined, "the first");
assert.equal(check_response_version(versions, "a.img", response({ "ETag": "\"1\"", "Last-Modified": "Tue" })), undefined,
    "the same ETag (Last-Modified is not compared when there is one)");
assert.equal(check_response_version(versions, "a.img", response({})), undefined, "a response without either: not checked");
const changed = check_response_version(versions, "a.img", response({ "ETag": "\"2\"" }));
assert.match(changed.message, /a\.img changed while it was read \(ETag "1", now "2"\)/);
assert.equal(changed.kind, "changed");
assert.equal(changed.retryable, false, "not retried");
assert.equal(check_response_version(versions, "b.img", response({ "ETag": "\"9\"" })), undefined, "each file its own (image parts)");
console.log("ok - the ETag of the first response is the version");

versions = new Map();
check_response_version(versions, "a.img", response({ "Last-Modified": "Mon" }));
assert.equal(check_response_version(versions, "a.img", response({ "Last-Modified": "Mon", "ETag": "\"5\"" })), undefined);
assert.match(check_response_version(versions, "a.img", response({ "Last-Modified": "Tue" })).message, /Last-Modified Mon, now Tue/);
console.log("ok - without an ETag: Last-Modified");

versions = new Map();
assert.equal(check_response_version(versions, "a.img", undefined), undefined, "Node: no response headers");
assert.equal(check_response_version(versions, "a.img", response({})), undefined);
assert.equal(check_response_version(versions, "a.img", response({ "ETag": "\"1\"" })), undefined, "the first with a version");
assert.equal(versions.get("a.img").etag, "\"1\"");
console.log("ok - responses without a version are not checked");

// a cross-origin response that exposes Last-Modified (always readable) but not ETag: the headers are read
// without getResponseHeader, Last-Modified is the version
versions = new Map();
assert.equal(check_response_version(versions, "c.img", cross_origin({ "Last-Modified": "Mon", "Content-Length": "1048576" })), undefined);
assert.deepEqual(versions.get("c.img"), { etag: null, last_modified: "Mon" });
assert.equal(check_response_version(versions, "c.img", cross_origin({ "Last-Modified": "Mon" })), undefined);
assert.match(check_response_version(versions, "c.img", cross_origin({ "Last-Modified": "Tue" })).message, /Last-Modified Mon, now Tue/);
versions = new Map();
check_response_version(versions, "d.img", cross_origin({ "ETag": "\"7\"", "Last-Modified": "Mon" }));
assert.equal(versions.get("d.img").etag, "\"7\"", "an exposed ETag is read (any case)");
console.log("ok - cross-origin responses: no getResponseHeader of headers they do not expose; Last-Modified then");
console.log("response version tests passed");
