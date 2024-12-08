"use strict";

/**
 * @constructor
 *
 * @param {BusConnector} bus
 * @param {*=} config
 */
function FetchNetworkAdapter(bus, config)
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
    this.eth_encoder_buf = create_eth_encoder_buf();

    // Ex: 'https://corsproxy.io/?'
    this.cors_proxy = config.cors_proxy;

    this.bus.register("net" + this.id + "-mac", function(mac) {
        this.vm_mac = new Uint8Array(mac.split(":").map(function(x) { return parseInt(x, 16); }));
    }, this);
    this.bus.register("net" + this.id + "-send", function(data)
    {
        this.send(data);
    }, this);

    //Object.seal(this);
}

FetchNetworkAdapter.prototype.destroy = function()
{
};

FetchNetworkAdapter.prototype.on_tcp_connection = function(packet, tuple)
{
    if(packet.tcp.dport === 80) {
        let conn = new TCPConnection();
        conn.state = TCP_STATE_SYN_RECEIVED;
        conn.net = this;
        conn.on_data = on_data_http;
        conn.tuple = tuple;
        conn.accept(packet);
        this.tcp_conn[tuple] = conn;
        return true;
    }
    return false;
};

/**
 * @this {TCPConnection}
 * @param {!ArrayBuffer} data
 */
async function on_data_http(data)
{
    this.read = this.read || "";
    this.read += new TextDecoder().decode(data);
    if(this.read && this.read.indexOf("\r\n\r\n") !== -1) {
        let offset = this.read.indexOf("\r\n\r\n");
        let headers = this.read.substring(0, offset).split(/\r\n/);
        let data = this.read.substring(offset + 4);
        this.read = "";

        let first_line = headers[0].split(" ");
        let target;
        if(/^https?:/.test(first_line[1])) {
            // HTTP proxy
            target = new URL(first_line[1]);
        }
        else {
            target = new URL("http://host" + first_line[1]);
        }
        if(typeof window !== "undefined" && target.protocol === "http:" && window.location.protocol === "https:") {
            // fix "Mixed Content" errors
            target.protocol = "https:";
        }

        let req_headers = new Headers();
        for(let i = 1; i < headers.length; ++i) {
            const header = this.net.parse_http_header(headers[i]);
            if(!header) {
                console.warn('The request contains an invalid header: "%s"', headers[i]);
                this.write(new TextEncoder().encode("HTTP/1.1 400 Bad Request\r\nContent-Length: 0"));
                return;
            }
            if( header.key.toLowerCase() === "host" ) target.host = header.value;
            else req_headers.append(header.key, header.value);
        }

        dbg_log("HTTP Dispatch: " + target.href, LOG_FETCH);
        this.name = target.href;
        let opts = {
            method: first_line[0],
            headers: req_headers,
        };
        if(["put", "post"].indexOf(opts.method.toLowerCase()) !== -1) {
            opts.body = data;
        }
/*
        const [resp, ab] = await this.net.fetch(target.href, opts);
        const lines = [
            `HTTP/1.1 ${resp.status} ${resp.statusText}`,
            "connection: Closed",
            "content-length: " + ab.byteLength
        ];

        lines.push("x-was-fetch-redirected: " + String(resp.redirected));
        lines.push("x-fetch-resp-url: " + String(resp.url));

        resp.headers.forEach(function (value, key) {
            if([
                "content-encoding", "connection", "content-length", "transfer-encoding"
            ].indexOf(key.toLowerCase()) === -1 ) {
                lines.push(key + ": " + value);
            }
        });

        lines.push("");
        lines.push("");

        this.write(new TextEncoder().encode(lines.join("\r\n")));
        this.write(new Uint8Array(ab));
        this.close();
*/
        const fetch_url = this.net.cors_proxy ? this.net.cors_proxy + encodeURIComponent(target.href) : target.href;
        const encoder = new TextEncoder();
        let response_started = false;
        fetch(fetch_url, opts).then((resp) => {
            const header_lines = [
                `HTTP/1.1 ${resp.status} ${resp.statusText}`,
                `x-was-fetch-redirected: ${!!resp.redirected}`,
                `x-fetch-resp-url: ${resp.url}`,
                "Connection: closed"
            ];
            for(const [key, value] of resp.headers.entries()) {
                if(!["content-encoding", "connection", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
                    header_lines.push(`${key}:  ${value}`);
                }
            }
            this.write(encoder.encode(header_lines.join("\r\n") + "\r\n\r\n"));
            response_started = true;

            const resp_reader = resp.body.getReader();
            const pump = ({ value, done }) => {
                if(value) {
                    this.write(value);
                }
                if(done) {
                    this.close();
                }
                else {
                    return resp_reader.read().then(pump);
                }
            };
            resp_reader.read().then(pump);
        })
        .catch((e) => {
            console.warn("Fetch Failed: " + fetch_url + "\n" + e);
            if(!response_started) {
                const body = encoder.encode(`Fetch ${fetch_url} failed:\n\n${e.stack || e.message}`);
                const header_lines = [
                    "HTTP/1.1 502 Fetch Error",
                    "Content-Type: text/plain",
                    `Content-Length: ${body.length}`,
                    "Connection: closed"
                ];
                this.writev([encoder.encode(header_lines.join("\r\n") + "\r\n\r\n"), body]);
            }
            this.close();
        });
    }
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
        let headers = new Headers();
        headers.set("Content-Type", "text/plain");
        return [
            {
                status: 502,
                statusText: "Fetch Error",
                headers: headers,
            },
            new TextEncoder().encode(`Fetch ${url} failed:\n\n${e.stack}`).buffer
        ];
    }
};

FetchNetworkAdapter.prototype.parse_http_header = function(header)
{
    const parts = header.match(/^([^:]*):(.*)$/);
    if(!parts) {
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

if(typeof module !== "undefined" && typeof module.exports !== "undefined")
{
    // only for testing
    module.exports["FetchNetworkAdapter"] = FetchNetworkAdapter;
}
