import { LOG_FETCH } from "../const.js";
import { dbg_log } from "../log.js";

import {
    create_eth_encoder_buf,
    handle_fake_networking,
    TCPConnection,
    TCP_STATE_SYN_RECEIVED,
    fake_tcp_connect,
    fake_tcp_probe
} from "./fake_network.js";

// For Types Only
import { BusConnector } from "../bus.js";

// Module-scoped encoder/decoder singletons (avoids repeated allocations).
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const CR = 0x0D;
const LF = 0x0A;

function findCrLfCrLf(haystack)
{
    for(let i = 0; i + 3 < haystack.length; i++)
    {
        if(haystack[i] === CR && haystack[i + 1] === LF && haystack[i + 2] === CR && haystack[i + 3] === LF)
        {
            return i;
        }
    }
    return -1;
}

/**
 * @constructor
 *
 * @param {BusConnector} bus
 * @param {*=} config
 */
export function FetchNetworkAdapter(bus, config)
{
    config = config || {};
    this.bus = bus;
    this.id = config.id || 0;
    this.router_mac = new Uint8Array((config.router_mac || "52:54:0:1:2:3").split(":").map(function(x) { return parseInt(x, 16); }));
    this.router_ip = new Uint8Array((config.router_ip || "192.168.86.1").split(".").map(function(x) { return parseInt(x, 10); }));
    this.vm_ip = new Uint8Array((config.vm_ip || "192.168.86.100").split(".").map(function(x) { return parseInt(x, 10); }));
    this.masquerade = config.masquerade === undefined || !!config.masquerade;
    this.vm_mac = new Uint8Array(6);
    this.dns_method = config.dns_method || "static";
    this.doh_server = config.doh_server;
    this.tcp_conn = {};
    this.mtu = config.mtu;
    this.eth_encoder_buf = create_eth_encoder_buf(this.mtu);
    this.fetch = (...args) => fetch(...args);

    // Ex: 'https://corsproxy.io/?'
    this.cors_proxy = config.cors_proxy;

    this.bus.register("net" + this.id + "-mac", function(mac) {
        this.vm_mac = new Uint8Array(mac.split(":").map(function(x) { return parseInt(x, 16); }));
    }, this);
    this.bus.register("net" + this.id + "-send", function(data)
    {
        this.send(data);
    }, this);
    this.bus.register("tcp-connection", (conn) => {
        if(conn.sport === 80) {
            conn.on("data", on_data_http);
            conn.accept();
        }
    }, this);
}

FetchNetworkAdapter.prototype.destroy = function()
{
};

FetchNetworkAdapter.prototype.connect = function(port)
{
    return fake_tcp_connect(port, this);
};

FetchNetworkAdapter.prototype.tcp_probe = function(port)
{
    return fake_tcp_probe(port, this);
};

/**
 * HTTP data handler for port-80 TCP connections.
 *
 * Incoming TCP segments are buffered as raw bytes and searched for the
 * \r\n\r\n header/body separator.  Once found the header portion alone is
 * text-decoded and parsed; the body stays as a binary Uint8Array.
 *
 * When a POST/PUT body spans multiple TCP segments the partial body is
 * stored in this.pendingBody and subsequent segments are accumulated there until
 * Content-Length is satisfied, at which point the deferred fetch is fired.
 *
 * NOTE: Transfer-Encoding: chunked is not supported.  Requests using it
 * will not be dispatched.
 *
 * @this {TCPConnection}
 * @param {!ArrayBuffer} data
 */
async function on_data_http(data)
{
    // If we're buffering a partial request body, accumulate chunks until
    // Content-Length is satisfied, then fire the deferred fetch.
    if(this.pendingBody)
    {
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
        const combined = new Uint8Array(this.pendingBody.buf.length + chunk.length);
        combined.set(this.pendingBody.buf);
        combined.set(chunk, this.pendingBody.buf.length);
        this.pendingBody.buf = combined;
        if(this.pendingBody.buf.length >= this.pendingBody.cl)
        {
            const body = this.pendingBody.buf;
            const done = this.pendingBody.done;
            this.pendingBody = null;
            done(body);
        }
        return;
    }

    // Accumulate raw bytes (not text) so binary body data is preserved.
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
    if(this.rawBuffer)
    {
        const combined = new Uint8Array(this.rawBuffer.length + chunk.length);
        combined.set(this.rawBuffer);
        combined.set(chunk, this.rawBuffer.length);
        this.rawBuffer = combined;
    }
    else
    {
        this.rawBuffer = chunk;
    }

    const sep_index = findCrLfCrLf(this.rawBuffer);
    if(sep_index === -1) return;

    // Split into header (text) and body (binary).
    const headerBytes = this.rawBuffer.slice(0, sep_index);
    const bodyBytes = this.rawBuffer.slice(sep_index + 4);
    this.rawBuffer = null;

    const headerText = textDecoder.decode(headerBytes);
    const headerLines = headerText.split(/\r\n/);

    const first_line = headerLines[0].split(" ");
    let target;
    if(/^https?:/.test(first_line[1]))
    {
        // HTTP proxy
        target = new URL(first_line[1]);
    }
    else
    {
        target = new URL("http://host" + first_line[1]);
    }
    if(typeof window !== "undefined" && target.protocol === "http:" && window.location.protocol === "https:")
    {
        // fix "Mixed Content" errors
        target.protocol = "https:";
    }

    const req_headers = new Headers();
    for(let i = 1; i < headerLines.length; ++i)
    {
        const header = this.net.parse_http_header(headerLines[i]);
        if(!header)
        {
            console.warn('The request contains an invalid header: "%s"', headerLines[i]);
            this.net.respond_text_and_close(this, 400, "Bad Request", `Invalid header in request: ${headerLines[i]}`);
            return;
        }
        if(header.key.toLowerCase() === "host") target.host = header.value;
        else req_headers.append(header.key, header.value);
    }

    if(!this.net.cors_proxy && /^\d+\.external$/.test(target.hostname))
    {
        dbg_log("Request to localhost: " + target.href, LOG_FETCH);
        const localport = parseInt(target.hostname.split(".")[0], 10);
        if(!isNaN(localport) && localport > 0 && localport < 65536)
        {
            target.protocol = "http:";
            target.hostname = "localhost";
            target.port = localport.toString(10);
        }
        else
        {
            console.warn('Unknown port for localhost: "%s"', target.href);
            this.net.respond_text_and_close(this, 400, "Bad Request", `Unknown port for localhost: ${target.href}`);
            return;
        }
    }

    dbg_log("HTTP Dispatch: " + target.href, LOG_FETCH);
    this.name = target.href;

    const opts = {
        method: first_line[0],
        headers: req_headers,
    };

    const fetch_url = this.net.cors_proxy
        ? this.net.cors_proxy + encodeURIComponent(target.href)
        : target.href;

    if(["put", "post"].indexOf(opts.method.toLowerCase()) !== -1)
    {
        // The body may span multiple TCP segments.
        // If Content-Length is present and larger than what we have so far,
        // buffer the partial body and wait for remaining chunks.
        const content_length = parseInt(req_headers.get("content-length") || "0", 10);
        if(content_length > 0 && bodyBytes.length < content_length)
        {
            this.pendingBody = {
                buf: bodyBytes,
                cl: content_length,
                done: (body) => {
                    opts.body = body;
                    dispatch_fetch(this, fetch_url, opts);
                },
            };
            return;
        }
        opts.body = bodyBytes;
    }

    dispatch_fetch(this, fetch_url, opts);
}

/**
 * Execute the HTTP fetch and pipe the response back to the guest.
 *
 * @param {TCPConnection} conn
 * @param {string} fetch_url
 * @param {!Object} opts
 */
function dispatch_fetch(conn, fetch_url, opts)
{
    let response_started = false;
    let handler = (resp) => {
        let resp_headers = new Headers(resp.headers);
        resp_headers.delete("content-encoding");
        resp_headers.delete("keep-alive");
        resp_headers.delete("content-length");
        resp_headers.delete("transfer-encoding");
        resp_headers.set("x-was-fetch-redirected", `${!!resp.redirected}`);
        resp_headers.set("x-fetch-resp-url", resp.url);
        resp_headers.set("connection", "close");

        conn.write(conn.net.form_response_head(resp.status, resp.statusText, resp_headers));
        response_started = true;

        if(resp.body && resp.body.getReader)
        {
            const resp_reader = resp.body.getReader();
            const pump = ({ value, done }) => {
                if(value)
                {
                    conn.write(value);
                }
                if(done)
                {
                    conn.close();
                }
                else
                {
                    return resp_reader.read().then(pump);
                }
            };
            resp_reader.read().then(pump);
        }
        else
        {
            resp.arrayBuffer().then(buffer => {
                conn.write(new Uint8Array(buffer));
                conn.close();
            });
        }
    };

    conn.net.fetch(fetch_url, opts).then(handler)
    .catch((e) => {
        console.warn("Fetch Failed: " + fetch_url + "\n" + e);
        if(!response_started)
        {
            conn.net.respond_text_and_close(conn, 502, "Fetch Error", `Fetch ${fetch_url} failed:\n\n${e.stack || e.message}`);
        }
        conn.close();
    });
}

FetchNetworkAdapter.prototype.fetch = async function(url, options)
{
    if(this.cors_proxy) url = this.cors_proxy + encodeURIComponent(url);

    try
    {
        const resp = await fetch(url, options);
        const ab = await resp.arrayBuffer();
        return [resp, ab];
    }
    catch(e)
    {
        console.warn("Fetch Failed: " + url + "\n" + e);
        return [
            {
                status: 502,
                statusText: "Fetch Error",
                headers: new Headers({ "Content-Type": "text/plain" }),
            },
            textEncoder.encode(`Fetch ${url} failed:\n\n${e.stack}`).buffer
        ];
    }
};

FetchNetworkAdapter.prototype.form_response_head = function(status_code, status_text, headers)
{
    let lines = [
        `HTTP/1.1 ${status_code} ${status_text}`
    ];

    for(const [key, value] of headers.entries())
    {
        lines.push(`${key}: ${value}`);
    }

    return textEncoder.encode(lines.join("\r\n") + "\r\n\r\n");
};

FetchNetworkAdapter.prototype.respond_text_and_close = function(conn, status_code, status_text, body)
{
    const headers = new Headers({
        "content-type": "text/plain",
        "content-length": body.length.toString(10),
        "connection": "close"
    });
    conn.writev([this.form_response_head(status_code, status_text, headers), textEncoder.encode(body)]);
    conn.close();
};

FetchNetworkAdapter.prototype.parse_http_header = function(header)
{
    const parts = header.match(/^([^:]*):(.*)$/);
    if(!parts)
    {
        dbg_log("Unable to parse HTTP header", LOG_FETCH);
        return;
    }

    const key = parts[1];
    const value = parts[2].trim();

    if(key.length === 0)
    {
        dbg_log("Header key is empty, raw header", LOG_FETCH);
        return;
    }
    if(value.length === 0)
    {
        dbg_log("Header value is empty", LOG_FETCH);
        return;
    }
    if(!/^[\w-]+$/.test(key))
    {
        dbg_log("Header key contains forbidden characters", LOG_FETCH);
        return;
    }
    if(!/^[\x20-\x7E]+$/.test(value))
    {
        dbg_log("Header value contains forbidden characters", LOG_FETCH);
        return;
    }

    return { key, value };
};

/**
 * @param {Uint8Array} data
 */
FetchNetworkAdapter.prototype.send = function(data)
{
    handle_fake_networking(data, this);
};

/**
 * @param {Uint8Array} data
 */
FetchNetworkAdapter.prototype.receive = function(data)
{
    this.bus.send("net" + this.id + "-receive", new Uint8Array(data));
};
