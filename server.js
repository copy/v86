#!/usr/bin/env node
/**
 * server.js - Static file server for v86 Render deployment
 *
 * Required headers for SharedArrayBuffer (needed by v86's JIT):
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * For OS images not present locally, the server proxies requests to i.copy.sh.
 * This covers the large chunked images (Windows, FreeBSD, etc.) that are too
 * large to include in the repository.
 */

import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const PORT = parseInt(process.env.PORT || "3000", 10);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CDN_HOST = "i.copy.sh";

// MIME types for v86 assets
const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".mjs":  "application/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".json": "application/json; charset=utf-8",
    ".bin":  "application/octet-stream",
    ".img":  "application/octet-stream",
    ".iso":  "application/octet-stream",
    ".zst":  "application/octet-stream",
    ".gz":   "application/octet-stream",
    ".ico":  "image/x-icon",
    ".png":  "image/png",
    ".svg":  "image/svg+xml",
};

// Required headers for SharedArrayBuffer support in browsers
const SECURITY_HEADERS = {
    "Cross-Origin-Opener-Policy":    "same-origin",
    "Cross-Origin-Embedder-Policy":  "require-corp",
    "Cross-Origin-Resource-Policy":  "cross-origin",
    "Access-Control-Allow-Origin":   "*",
    "Access-Control-Allow-Headers":  "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type",
};

function getMime(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || "application/octet-stream";
}

function applySecurityHeaders(res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        res.setHeader(k, v);
    }
}

/**
 * Proxy a request to i.copy.sh CDN.
 * Used for large chunked images not stored locally.
 */
function proxyCDN(req, res, cdnPath) {
    const options = {
        hostname: CDN_HOST,
        port: 443,
        path: cdnPath,
        method: req.method,
        headers: {
            "User-Agent": "v86-render-proxy/1.0",
            "Accept": "*/*",
        },
    };

    // Forward Range header for chunked image loading
    if (req.headers["range"]) {
        options.headers["Range"] = req.headers["range"];
    }

    console.log(`  [proxy] https://${CDN_HOST}${cdnPath}`);

    const proxyReq = https.request(options, (proxyRes) => {
        applySecurityHeaders(res);

        // Forward relevant headers from upstream
        const forwardHeaders = [
            "content-type", "content-length", "content-range",
            "accept-ranges", "last-modified", "etag",
        ];
        for (const h of forwardHeaders) {
            if (proxyRes.headers[h]) {
                res.setHeader(h, proxyRes.headers[h]);
            }
        }

        res.writeHead(proxyRes.statusCode || 200);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (err) => {
        console.error(`  [proxy error] ${err.message}`);
        if (!res.headersSent) {
            res.writeHead(502);
            res.end("Bad gateway");
        }
    });

    proxyReq.end();
}

/**
 * Serve a local file with range request support.
 */
function serveFile(req, res, filePath) {
    fs.stat(filePath, (err, stat) => {
        if (err) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }

        applySecurityHeaders(res);

        const mime = getMime(filePath);
        const total = stat.size;
        const rangeHeader = req.headers["range"];

        if (rangeHeader) {
            // Handle Range requests (needed for async chunked image loading)
            const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (!match) {
                res.writeHead(416, { "Content-Range": `bytes */${total}` });
                res.end();
                return;
            }
            const start = parseInt(match[1], 10);
            const end = match[2] ? parseInt(match[2], 10) : total - 1;
            const chunkSize = end - start + 1;

            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${total}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunkSize,
                "Content-Type": mime,
            });

            const stream = fs.createReadStream(filePath, { start, end });
            stream.pipe(res, { end: true });
        } else {
            res.writeHead(200, {
                "Content-Length": total,
                "Content-Type": mime,
                "Accept-Ranges": "bytes",
            });

            if (req.method === "HEAD") {
                res.end();
                return;
            }

            const stream = fs.createReadStream(filePath);
            stream.pipe(res, { end: true });
        }
    });
}

const server = http.createServer((req, res) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        applySecurityHeaders(res);
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    let reqPath = decodeURIComponent(parsedUrl.pathname || "/");

    // Normalize: strip double slashes, prevent directory traversal
    reqPath = reqPath.replace(/\/+/g, "/");
    if (reqPath.includes("..")) {
        res.writeHead(400);
        res.end("Bad request");
        return;
    }

    // Default to index.html
    if (reqPath === "/") reqPath = "/index.html";

    const filePath = path.join(ROOT, reqPath);
    const normalizedPath = path.normalize(filePath);

    // Ensure the resolved path is within the root directory
    if (!normalizedPath.startsWith(path.normalize(ROOT))) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    // Check if file exists locally
    if (fs.existsSync(normalizedPath) && fs.statSync(normalizedPath).isFile()) {
        console.log(`[local] ${reqPath}`);
        serveFile(req, res, normalizedPath);
        return;
    }

    // For /images/* requests, proxy to i.copy.sh if not found locally
    if (reqPath.startsWith("/images/")) {
        const cdnPath = reqPath.replace(/^\/images\//, "/");
        proxyCDN(req, res, cdnPath);
        return;
    }

    // 404 for everything else not found
    console.log(`[404] ${reqPath}`);
    applySecurityHeaders(res);
    res.writeHead(404);
    res.end(`Not found: ${reqPath}`);
});

server.listen(PORT, () => {
    console.log(`v86 server running on port ${PORT}`);
    console.log(`  Root: ${ROOT}`);
    console.log(`  CDN fallback: https://${CDN_HOST}/`);
    console.log(`  COOP/COEP headers: enabled`);
    console.log(`  WISP relay: ws://localhost:${PORT}/wisp/`);
});

// Handle WebSocket upgrade requests for the WISP relay at /wisp/
// The WISP backend lets v86 guests make real TCP connections through the server.
server.on("upgrade", (req, socket, head) => {
    const url = req.url || "";
    if (url.startsWith("/wisp/")) {
        wisp.routeRequest(req, socket, head);
    } else {
        // Unknown upgrade path — reject cleanly
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
    }
});
