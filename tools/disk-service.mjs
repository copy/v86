#!/usr/bin/env node
// The disk protocol's reference service (docs/disk-persistence-plan.md
// "磁盘协议"): the images of one directory, served for v86's disks with
// disk_option "read_write" (and for plain reads), on a server or as the
// local disk service on 127.0.0.1. No dependencies.
//
//     node tools/disk-service.mjs --dir <images> [--port 8471] [--host 127.0.0.1]
//         [--origin <page origin>]... [--token <secret>] [--lease-ms 30000]
//
// Every operation goes to the image's own URL (<service>/<name>):
// - GET with Range: the sectors (206, Content-Range, ETag = the image's
//   generation), as a static server answers, so the URL also works as a
//   plain one (read_only, older v86); responses are not cached
//   (Cache-Control: no-store);
// - POST with X-V86-Disk-Op (JSON answers, X-V86-Disk-Protocol: 1):
//   open (a write session: size, sector size, identity, generation,
//   session, epoch, lease; refused while another writer's lease is valid),
//   renew, write (X-V86-Disk-Session, -Epoch, -Sequence, -Offset; the body
//   is the data; in the file before the answer), flush (fdatasync), mark
//   (flush, then the generation a snapshot records: the next write moves
//   it on before it writes), close (flush, the lease released).
// A writer's lease ends when it is not renewed; a later open takes the
// image over with a higher epoch, and the old session's late writes (or
// retries) are refused. A write of a session's sequence number applied
// already answers success again (a retry); a write older than a newer one
// it overlaps is not applied (it arrived late). The generation also moves
// on when the file changes behind the service's back. Writes are not PUT
// with Content-Range (RFC 9110 §14.5: a server that does not support it
// replaces the whole file). Requests from a browser page must come from an
// --origin given (Origin is checked; by default, the service's own); with
// --token, the session operations need Authorization: Bearer <token>.
// The state (each image's UUID, generation, epoch) is kept in
// <dir>/.v86-disk-service.json.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID as random_uuid } from "node:crypto";
import { fileURLToPath } from "node:url";

export const PROTOCOL_VERSION = "1";
const SECTOR_SIZE = 512;
const STATE_FILE = ".v86-disk-service.json";
/** (the last writes of a session, for retries and late arrivals) */
const RECENT_WRITES = 4096;

/**
 * @param {{dir: string, origins?: string[], token?: string, lease_ms?: number, log?: function(string)}} options
 */
export function create_disk_service(options)
{
    const dir = fs.realpathSync(options.dir);
    const origins = new Set(options.origins || []);
    const lease_ms = options.lease_ms || 30000;
    const log = options.log || (() => {});
    const state_file = path.join(dir, STATE_FILE);
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(state_file, "utf8")); } catch(e) { saved = {}; }
    /** @type {!Map<string, !Object>} the images by name */
    const images = new Map();
    const stats = { requests: 0, writes: 0, flushes: 0, refused: 0 };

    const persist = () =>
    {
        const out = {};
        for(const [name, image] of images)
        {
            out[name] = { uuid: image.uuid, generation: image.generation, epoch: image.epoch, size: image.size, mtime_ns: image.mtime_ns };
        }
        for(const [name, entry] of Object.entries(saved)) if(!out[name]) out[name] = entry;
        const temp = state_file + ".tmp";
        fs.writeFileSync(temp, JSON.stringify(out, null, 1));
        const fd = fs.openSync(temp, "r");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fs.renameSync(temp, state_file);
    };

    /** The image of a name in the directory, or null */
    const image_of = name =>
    {
        if(!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) return null;
        const file = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(file, { bigint: true }); } catch(e) { return null; }
        if(!stat.isFile()) return null;
        let image = images.get(name);
        if(!image)
        {
            const entry = saved[name] || {};
            image = { name, file, uuid: entry.uuid || random_uuid(), generation: entry.generation || 1, epoch: entry.epoch || 0,
                size: Number(stat.size), mtime_ns: String(stat.mtimeNs), fd: -1, writer: null, marked: null, recent: [], lease_timer: 0, dirty: false };
            // (changed while the service did not run)
            if(entry.uuid && (entry.size !== image.size || entry.mtime_ns !== image.mtime_ns)) image.generation++;
            images.set(name, image);
            persist();
        }
        else if(String(stat.mtimeNs) !== image.mtime_ns || Number(stat.size) !== image.size)
        {
            // changed behind the service's back: another generation
            image.generation++;
            image.size = Number(stat.size);
            image.mtime_ns = String(stat.mtimeNs);
            persist();
        }
        return image;
    };
    const restat = image =>
    {
        const stat = fs.fstatSync(image.fd, { bigint: true });
        image.size = Number(stat.size);
        image.mtime_ns = String(stat.mtimeNs);
    };
    const flush = image =>
    {
        if(image.fd >= 0 && image.dirty)
        {
            fs.fdatasyncSync(image.fd);
            image.dirty = false;
            stats.flushes++;
        }
    };
    const writer_valid = image => image.writer && image.writer.expires > Date.now();
    const arm_lease = image =>
    {
        clearTimeout(image.lease_timer);
        // (a lease that ends: what was written is flushed)
        image.lease_timer = setTimeout(() => { try { flush(image); } catch(e) { log(image.name + ": flush failed: " + e.message); } }, lease_ms + 10);
        image.lease_timer.unref?.();
    };

    const cors = (req, res) =>
    {
        const origin = req.headers["origin"];
        if(origin && origins.has(origin))
        {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Range, X-Accept-Encoding, Authorization, Content-Type, " +
                "X-V86-Disk-Op, X-V86-Disk-Session, X-V86-Disk-Epoch, X-V86-Disk-Sequence, X-V86-Disk-Offset");
            res.setHeader("Access-Control-Expose-Headers", "ETag, Content-Range, Content-Length, X-V86-Disk-Protocol");
        }
    };
    const origin_allowed = req =>
    {
        const origin = req.headers["origin"];
        if(!origin) return true;
        if(origins.has(origin)) return true;
        // (a page of the service itself)
        return origin === "http://" + req.headers["host"] || origin === "https://" + req.headers["host"];
    };
    const answer = (res, status, body, headers = {}) =>
    {
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-V86-Disk-Protocol": PROTOCOL_VERSION, ...headers });
        res.end(JSON.stringify(body));
    };
    const refuse = (res, status, code, message) =>
    {
        stats.refused++;
        answer(res, status, { code, error: message });
    };
    const etag = image => "\"" + image.uuid + ":" + image.generation + "\"";

    const read = (req, res, image) =>
    {
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers["range"] || "");
        const headers = { "Accept-Ranges": "bytes", "ETag": etag(image), "Cache-Control": "no-store", "Content-Type": "application/octet-stream" };
        if(!range)
        {
            res.writeHead(200, { ...headers, "Content-Length": image.size });
            if(req.method === "HEAD") { res.end(); return; }
            fs.createReadStream(image.file).pipe(res);
            return;
        }
        const start = +range[1], end = Math.min(+range[2], image.size - 1);
        if(start >= image.size || end < start)
        {
            res.writeHead(416, { ...headers, "Content-Range": "bytes */" + image.size }).end();
            return;
        }
        const buffer = Buffer.alloc(end - start + 1);
        const fd = image.fd >= 0 ? image.fd : fs.openSync(image.file, "r");
        try { fs.readSync(fd, buffer, 0, buffer.length, start); }
        finally { if(fd !== image.fd) fs.closeSync(fd); }
        res.writeHead(206, { ...headers, "Content-Range": "bytes " + start + "-" + end + "/" + image.size, "Content-Length": buffer.length });
        res.end(req.method === "HEAD" ? undefined : buffer);
    };

    const operate = (req, res, image, body) =>
    {
        const op = req.headers["x-v86-disk-op"];
        if(options.token && req.headers["authorization"] !== "Bearer " + options.token)
        {
            refuse(res, 401, "token", "the disk service needs its token (Authorization: Bearer)");
            return;
        }
        const session = req.headers["x-v86-disk-session"], epoch = Number(req.headers["x-v86-disk-epoch"]);
        const own = image.writer && image.writer.session === session && image.writer.epoch === epoch;
        if(op === "open")
        {
            if(writer_valid(image))
            {
                refuse(res, 409, "writer", image.name + " has a writer already (its lease ends in " + (image.writer.expires - Date.now()) + " ms)");
                return;
            }
            if(image.fd < 0)
            {
                try { image.fd = fs.openSync(image.file, "r+"); }
                catch(e) { refuse(res, 403, "read_only", image.name + " cannot be written (" + e.message + ")"); return; }
            }
            // (a writer before whose lease ended: its writes are flushed, its epoch is gone)
            flush(image);
            image.epoch++;
            image.writer = { session: random_uuid(), epoch: image.epoch, expires: Date.now() + lease_ms };
            image.recent = [];
            image.marked = null;
            restat(image);
            persist();
            arm_lease(image);
            log(image.name + ": opened by epoch " + image.epoch);
            answer(res, 200, { size: image.size, sector_size: SECTOR_SIZE, identity: { uuid: image.uuid, name: image.name },
                generation: String(image.generation), session: image.writer.session, epoch: image.epoch, lease_ms });
            return;
        }
        if(!own)
        {
            const lost = image.writer && image.writer.session === session;
            refuse(res, 409, lost ? "lease" : "epoch", image.name + ": " + (lost ? "the lease of this session ended" :
                "the session (epoch " + epoch + ") is not the image's writer (epoch " + (image.writer ? image.writer.epoch : "none") + ")"));
            return;
        }
        if(op === "renew")
        {
            image.writer.expires = Date.now() + lease_ms;
            arm_lease(image);
            answer(res, 200, { generation: String(image.generation), lease_ms });
            return;
        }
        if(op === "write")
        {
            const sequence = Number(req.headers["x-v86-disk-sequence"]), offset = Number(req.headers["x-v86-disk-offset"]);
            if(!Number.isSafeInteger(sequence) || !Number.isSafeInteger(offset) || offset % SECTOR_SIZE || body.length % SECTOR_SIZE ||
                !body.length || offset + body.length > image.size)
            {
                refuse(res, 400, "request", image.name + ": a write must be whole sectors inside the image");
                return;
            }
            const end = offset + body.length;
            const applied = image.recent.find(w => w.sequence === sequence);
            if(applied)
            {
                answer(res, 200, { generation: String(image.generation), repeated: true });
                return;
            }
            // (a write that arrives after a newer one it overlaps is superseded)
            const superseded = image.recent.some(w => w.sequence > sequence && w.offset < end && offset < w.end);
            if(!superseded)
            {
                if(image.marked === image.generation)
                {
                    // the first write after a snapshot: the generation moves on first
                    image.generation++;
                    image.marked = null;
                    persist();
                }
                else
                {
                    image.generation++;
                }
                try
                {
                    for(let done = 0; done < body.length;) done += fs.writeSync(image.fd, body, done, body.length - done, offset + done);
                }
                catch(e)
                {
                    refuse(res, e.code === "ENOSPC" || e.code === "EDQUOT" ? 507 : 500, e.code === "ENOSPC" || e.code === "EDQUOT" ? "no_space" : "io",
                        image.name + ": the write failed (" + e.message + ")");
                    return;
                }
                image.dirty = true;
                restat(image);
                stats.writes++;
            }
            image.recent.push({ sequence, offset, end });
            if(image.recent.length > RECENT_WRITES) image.recent.splice(0, image.recent.length - RECENT_WRITES);
            image.writer.expires = Date.now() + lease_ms;
            answer(res, 200, { generation: String(image.generation) });
            return;
        }
        if(op === "flush" || op === "mark" || op === "close")
        {
            try { flush(image); }
            catch(e) { refuse(res, 500, "io", image.name + ": the flush failed (" + e.message + ")"); return; }
            if(op === "mark")
            {
                image.marked = image.generation;
                persist();
            }
            if(op === "close")
            {
                image.writer = null;
                clearTimeout(image.lease_timer);
                persist();
                log(image.name + ": closed by epoch " + epoch);
            }
            answer(res, 200, { generation: String(image.generation) });
            return;
        }
        refuse(res, 400, "request", "unknown operation " + JSON.stringify(op));
    };

    const server = http.createServer((req, res) =>
    {
        stats.requests++;
        cors(req, res);
        if(req.method === "OPTIONS")
        {
            res.writeHead(origin_allowed(req) ? 204 : 403).end();
            return;
        }
        const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname.slice(1));
        const image = image_of(name);
        if(!image)
        {
            res.writeHead(404, { "Cache-Control": "no-store" }).end();
            return;
        }
        if(req.method === "GET" || req.method === "HEAD")
        {
            read(req, res, image);
            return;
        }
        if(req.method !== "POST")
        {
            res.writeHead(405, { "Allow": "GET, HEAD, POST, OPTIONS" }).end();
            return;
        }
        if(!origin_allowed(req))
        {
            refuse(res, 403, "origin", "requests from " + req.headers["origin"] + " are not accepted (start the service with --origin)");
            return;
        }
        const chunks = [];
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () =>
        {
            try { operate(req, res, image, Buffer.concat(chunks)); }
            catch(e) { refuse(res, 500, "io", e.message); }
        });
    });

    return {
        server, images, stats,
        /** close the service: every image flushed and closed */
        close()
        {
            for(const image of images.values())
            {
                clearTimeout(image.lease_timer);
                if(image.fd >= 0)
                {
                    try { flush(image); } catch(e) {}
                    fs.closeSync(image.fd);
                    image.fd = -1;
                }
            }
            persist();
            const closed = new Promise(resolve => server.close(resolve));
            // (keep-alive connections too)
            server.closeAllConnections?.();
            return closed;
        },
    };
}

if(process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const args = process.argv.slice(2);
    const options = { dir: "", origins: [], token: undefined, lease_ms: 30000, port: 8471, host: "127.0.0.1" };
    for(let i = 0; i < args.length; i++)
    {
        const value = args[i + 1];
        switch(args[i])
        {
            case "--dir": options.dir = value; i++; break;
            case "--port": options.port = +value; i++; break;
            case "--host": options.host = value; i++; break;
            case "--origin": options.origins.push(value); i++; break;
            case "--token": options.token = value; i++; break;
            case "--lease-ms": options.lease_ms = +value; i++; break;
            default:
                console.error("usage: node tools/disk-service.mjs --dir <images> [--port 8471] [--host 127.0.0.1] " +
                    "[--origin <page origin>]... [--token <secret>] [--lease-ms 30000]");
                process.exit(2);
        }
    }
    if(!options.dir) { console.error("--dir is needed"); process.exit(2); }
    const service = create_disk_service({ ...options, log: message => console.log(message) });
    service.server.listen(options.port, options.host, () =>
    {
        console.log("disk service: " + fs.realpathSync(options.dir) + " at http://" + options.host + ":" + service.server.address().port + "/" +
            (options.origins.length ? " for " + options.origins.join(", ") : " (pages of other origins refused: --origin)"));
    });
    const stop = () => { service.close().then(() => process.exit(0)); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
}
