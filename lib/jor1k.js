"use strict";

import { LOG_9P } from "../src/const.js";
import { h } from "../src/lib.js";
import { dbg_log } from "../src/log.js";


// jor1k compatibility

export function hex8(n)
{
    return h(n);
}

export var message = {};

/** @param {...string} log */
message.Debug = function(log)
{
    dbg_log([].slice.apply(arguments).join(" "), LOG_9P);
};

message.Abort = function()
{
    if(DEBUG)
    {
        throw new Error("message.Abort()");
    }
};


// XXX: Should go through emulator interface
var LoadBinaryResource;

if(typeof XMLHttpRequest !== "undefined")
{
    LoadBinaryResource = function(url, OnSuccess, OnError) {
        var req = new XMLHttpRequest();
        req.open("GET", url, true);
        req.responseType = "arraybuffer";
        req.onreadystatechange = function () {
            if(req.readyState !== 4) {
                return;
            }
            if((req.status !== 200) && (req.status !== 0)) {
                OnError("Error: Could not load file " + url);
                return;
            }
            var arrayBuffer = req.response;
            if(arrayBuffer) {
                OnSuccess(arrayBuffer);
            } else {
                OnError("Error: No data received from: " + url);
            }
        };
        /*
            req.onload = function(e)
            {
                    var arrayBuffer = req.response;
                    if (arrayBuffer) {
                        OnLoadFunction(arrayBuffer);
                    }
            };
        */
        req.send(null);
    };
}
else
{
    LoadBinaryResource = function(url, OnSuccess, OnError)
    {
        //console.log(url);
        import("node:" + "fs").then(fs => fs["readFile"](url, function(err, data)
        {
            if(err)
            {
                OnError(err);
            }
            else
            {
                OnSuccess(data.buffer);
            }
        }));
    };
}
