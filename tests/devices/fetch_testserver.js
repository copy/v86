"use strict";

/**
 * Endpoints:
 * GET / - same as mocked.example.org
 * GET /bench - large file for benchmark (tests/bench/fetch_download.js)
 * GET /redirect - redirect to root endpoint
 * GET /header - gets "x-client-test" header and returns "x-server-test" header
 * todo: POST endpoints with JSON
*/

import { createServer } from "node:http";
import { workerData } from "node:worker_threads";

const { port, benchsize } = workerData;
const benchfile = Buffer.alloc(benchsize);

function get_handler(request, response) {
    if(request.url === "/") {
        response.write("This text is from the local server");
    } else if(request.url === "/bench") {
        response.setHeader("content-type", "application/octet-stream");
        response.setHeader("content-length", benchsize.toString(10));
        response.write(benchfile);
    } else if(request.url === "/header") {
        response.setHeader("x-server-test", request.headers["x-client-test"].split("").join("_") || "none");
    } else if(request.url === "/redirect") {
        response.writeHead(307, { "location": "/" });
    } else {
        response.write("Unknown endpoint");
    }
}

createServer(function(request, response) {
    switch(request.method) {
        case "GET":
            get_handler(request, response);
            break;
        default:
            response.write("Unknown method");
            break;
    }
    response.end();
}).listen(port);
