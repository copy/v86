"use strict";

// jor1k compatibility

var VIRTIO_MAGIC_REG = 0x0;
var VIRTIO_VERSION_REG = 0x4;
var VIRTIO_DEVICE_REG = 0x8;
var VIRTIO_VENDOR_REG = 0xc;
var VIRTIO_HOSTFEATURES_REG = 0x10;
var VIRTIO_HOSTFEATURESSEL_REG = 0x14;
var VIRTIO_GUESTFEATURES_REG = 0x20;
var VIRTIO_GUESTFEATURESSEL_REG = 0x24;
var VIRTIO_GUEST_PAGE_SIZE_REG = 0x28;
var VIRTIO_QUEUESEL_REG = 0x30;
var VIRTIO_QUEUENUMMAX_REG = 0x34;
var VIRTIO_QUEUENUM_REG = 0x38;
var VIRTIO_QUEUEALIGN_REG = 0x3C;
var VIRTIO_QUEUEPFN_REG = 0x40;
var VIRTIO_QUEUENOTIFY_REG = 0x50;
var VIRTIO_INTERRUPTSTATUS_REG = 0x60;
var VIRTIO_INTERRUPTACK_REG = 0x64;
var VIRTIO_STATUS_REG = 0x70;

/** @const */
var VRING_DESC_F_NEXT =      1; /* This marks a buffer as continuing via the next field. */
/** @const */
var VRING_DESC_F_WRITE =     2; /* This marks a buffer as write-only (otherwise read-only). */
/** @const */
var VRING_DESC_F_INDIRECT =  4; /* This means the buffer contains a list of buffer descriptors. */


function hex8(n)
{
    return h(n);
}

var message = {};

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
        req.open('GET', url, true);
        req.responseType = "arraybuffer";
        req.onreadystatechange = function () {
            if (req.readyState != 4) {
                return;
            }
            if ((req.status != 200) && (req.status != 0)) {
                OnError("Error: Could not load file " + url);
                return;
            }
            var arrayBuffer = req.response;
            if (arrayBuffer) {
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
        require("fs")["readFile"](url, function(err, data)
        {
            if(err)
            {
                OnError(err);
            }
            else
            {
                OnSuccess(data.buffer);
            }
        });
    };
}
