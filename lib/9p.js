// -------------------------------------------------
// --------------------- 9P ------------------------
// -------------------------------------------------
// Implementation of the 9p filesystem device following the
// 9P2000.L protocol ( https://code.google.com/p/diod/wiki/protocol )

import { LOG_9P } from "./../src/const.js";
import { VirtIO, VIRTIO_F_VERSION_1, VIRTIO_F_RING_EVENT_IDX, VIRTIO_F_RING_INDIRECT_DESC } from "../src/virtio.js";
import { S_IFREG, S_IFDIR, STATUS_UNLINKED } from "./filesystem.js";
import * as marshall from "../lib/marshall.js";
import { dbg_log, dbg_assert } from "../src/log.js";
import { h } from "../src/lib.js";

// For Types Only
import { CPU } from "../src/cpu.js";
import { BusConnector } from "../src/bus.js";
import { FS } from "./filesystem.js";

/**
 * @const
 * More accurate filenames in 9p debug messages at the cost of performance.
 */
const TRACK_FILENAMES = false;

// Feature bit (bit position) for mount tag.
const VIRTIO_9P_F_MOUNT_TAG = 0;
// Assumed max tag length in bytes.
const VIRTIO_9P_MAX_TAGLEN = 254;

const MAX_REPLYBUFFER_SIZE = 16 * 1024 * 1024;

// TODO
// flush

export const EPERM = 1;       /* Operation not permitted */
export const ENOENT = 2;      /* No such file or directory */
export const EEXIST = 17;      /* File exists */
export const EINVAL = 22;     /* Invalid argument */
export const EOPNOTSUPP = 95;  /* Operation is not supported */
export const ENOTEMPTY = 39;  /* Directory not empty */
export const EPROTO    = 71;  /* Protocol error */

var P9_SETATTR_MODE = 0x00000001;
var P9_SETATTR_UID = 0x00000002;
var P9_SETATTR_GID = 0x00000004;
var P9_SETATTR_SIZE = 0x00000008;
var P9_SETATTR_ATIME = 0x00000010;
var P9_SETATTR_MTIME = 0x00000020;
var P9_SETATTR_CTIME = 0x00000040;
var P9_SETATTR_ATIME_SET = 0x00000080;
var P9_SETATTR_MTIME_SET = 0x00000100;

var P9_STAT_MODE_DIR = 0x80000000;
var P9_STAT_MODE_APPEND = 0x40000000;
var P9_STAT_MODE_EXCL = 0x20000000;
var P9_STAT_MODE_MOUNT = 0x10000000;
var P9_STAT_MODE_AUTH = 0x08000000;
var P9_STAT_MODE_TMP = 0x04000000;
var P9_STAT_MODE_SYMLINK = 0x02000000;
var P9_STAT_MODE_LINK = 0x01000000;
var P9_STAT_MODE_DEVICE = 0x00800000;
var P9_STAT_MODE_NAMED_PIPE = 0x00200000;
var P9_STAT_MODE_SOCKET = 0x00100000;
var P9_STAT_MODE_SETUID = 0x00080000;
var P9_STAT_MODE_SETGID = 0x00040000;
var P9_STAT_MODE_SETVTX = 0x00010000;

export const P9_LOCK_TYPE_RDLCK = 0;
export const P9_LOCK_TYPE_WRLCK = 1;
export const P9_LOCK_TYPE_UNLCK = 2;
const P9_LOCK_TYPES = ["shared", "exclusive", "unlock"];

const P9_LOCK_FLAGS_BLOCK = 1;
const P9_LOCK_FLAGS_RECLAIM = 2;

export const P9_LOCK_SUCCESS = 0;
export const P9_LOCK_BLOCKED = 1;
export const P9_LOCK_ERROR = 2;
export const P9_LOCK_GRACE = 3;

var FID_NONE = -1;
var FID_INODE = 1;
var FID_XATTR = 2;

function range(size)
{
    return Array.from(Array(size).keys());
}

/**
 * @param {CPU} cpu
 * @param {Function} receive
 */
function init_virtio(cpu, configspace_taglen, configspace_tagname, receive)
{
    const virtio = new VirtIO(cpu,
    {
        name: "virtio-9p",
        pci_id: 0x06 << 3,
        device_id: 0x1049,
        subsystem_device_id: 9,
        common:
        {
            initial_port: 0xA800,
            queues:
            [
                {
                    size_supported: 32,
                    notify_offset: 0,
                },
            ],
            features:
            [
                VIRTIO_9P_F_MOUNT_TAG,
                VIRTIO_F_VERSION_1,
                VIRTIO_F_RING_EVENT_IDX,
                VIRTIO_F_RING_INDIRECT_DESC,
            ],
            on_driver_ok: () => {},
        },
        notification:
        {
            initial_port: 0xA900,
            single_handler: false,
            handlers:
            [
                (queue_id) =>
                {
                    if(queue_id !== 0)
                    {
                        dbg_assert(false, "Virtio9P Notified for non-existent queue: " + queue_id +
                            " (expected queue_id of 0)");
                        return;
                    }
                    const virtqueue = virtio.queues[0];
                    while(virtqueue.has_request())
                    {
                        const bufchain = virtqueue.pop_request();
                        receive(bufchain);
                    }
                    virtqueue.notify_me_after(0);
                    // Don't flush replies here: async replies are not completed yet.
                },
            ],
        },
        isr_status:
        {
            initial_port: 0xA700,
        },
        device_specific:
        {
            initial_port: 0xA600,
            struct:
            [
                {
                    bytes: 2,
                    name: "mount tag length",
                    read: () => configspace_taglen,
                    write: data => { /* read only */ },
                },
            ].concat(range(VIRTIO_9P_MAX_TAGLEN).map(index =>
                ({
                    bytes: 1,
                    name: "mount tag name " + index,
                    // Note: configspace_tagname may have changed after set_state
                    read: () => configspace_tagname[index] || 0,
                    write: data => { /* read only */ },
                })
            )),
        },
    });
    return virtio;
}

/**
 * @constructor
 *
 * @param {FS} filesystem
 * @param {CPU} cpu
 */
export function Virtio9p(filesystem, cpu, bus) {
    /** @type {FS} */
    this.fs = filesystem;

    /** @const @type {BusConnector} */
    this.bus = bus;

    this.configspace_tagname = [0x68, 0x6F, 0x73, 0x74, 0x39, 0x70]; // "host9p" string
    this.configspace_taglen = this.configspace_tagname.length; // num bytes

    this.virtio = init_virtio(cpu, this.configspace_taglen, this.configspace_tagname, this.ReceiveRequest.bind(this));
    this.virtqueue = this.virtio.queues[0];

    this.VERSION = "9P2000.L";
    this.BLOCKSIZE = 8192; // Let's define one page.
    this.msize = 8192; // maximum message size
    this.replybuffer = new Uint8Array(this.msize*2); // Twice the msize to stay on the safe site
    this.replybuffersize = 0;
    this.fids = [];
}

Virtio9p.prototype.get_state = function()
{
    var state = [];

    state[0] = this.configspace_tagname;
    state[1] = this.configspace_taglen;
    state[2] = this.virtio;
    state[3] = this.VERSION;
    state[4] = this.BLOCKSIZE;
    state[5] = this.msize;
    state[6] = this.replybuffer;
    state[7] = this.replybuffersize;
    state[8] = this.fids.map(function(f) { return [f.inodeid, f.type, f.uid, f.dbg_name]; });
    state[9] = this.fs;

    return state;
};

Virtio9p.prototype.set_state = function(state)
{
    this.configspace_tagname = state[0];
    this.configspace_taglen = state[1];
    this.virtio.set_state(state[2]);
    this.virtqueue = this.virtio.queues[0];
    this.VERSION = state[3];
    this.BLOCKSIZE = state[4];
    this.msize = state[5];
    this.replybuffer = state[6];
    this.replybuffersize = state[7];
    this.fids = state[8].map(function(f)
    {
        return { inodeid: f[0], type: f[1], uid: f[2], dbg_name: f[3] };
    });
    this.fs.set_state(state[9]);
};

// Note: dbg_name is only used for debugging messages and may not be the same as the filename,
// since it is not synchronised with renames done outside of 9p. Hard-links, linking and unlinking
// operations also mean that having a single filename no longer makes sense.
// Set TRACK_FILENAMES = true to sync dbg_name during 9p renames.
Virtio9p.prototype.Createfid = function(inodeid, type, uid, dbg_name) {
    return {inodeid, type, uid, dbg_name};
};

Virtio9p.prototype.update_dbg_name = function(idx, newname)
{
    for(const fid of this.fids)
    {
        if(fid.inodeid === idx) fid.dbg_name = newname;
    }
};

Virtio9p.prototype.reset = function()
{
    this.fids = [];
    this.virtio.reset();
};

Virtio9p.prototype.BuildReply = function(id, tag, payloadsize) {
    dbg_assert(payloadsize >= 0, "9P: Negative payload size");
    marshall.Marshall(["w", "b", "h"], [payloadsize+7, id+1, tag], this.replybuffer, 0);
    if((payloadsize+7) >= this.replybuffer.length) {
        dbg_log("Error in 9p: payloadsize exceeds maximum length", LOG_9P);
    }
    //for(var i=0; i<payload.length; i++)
    //    this.replybuffer[7+i] = payload[i];
    this.replybuffersize = payloadsize+7;
};

Virtio9p.prototype.SendError = function (tag, errormsg, errorcode) {
    //var size = marshall.Marshall(["s", "w"], [errormsg, errorcode], this.replybuffer, 7);
    var size = marshall.Marshall(["w"], [errorcode], this.replybuffer, 7);
    this.BuildReply(6, tag, size);
};

Virtio9p.prototype.SendReply = function (bufchain) {
    dbg_assert(this.replybuffersize >= 0, "9P: Negative replybuffersize");
    bufchain.set_next_blob(this.replybuffer.subarray(0, this.replybuffersize));
    this.virtqueue.push_reply(bufchain);
    this.virtqueue.flush_replies();
};

Virtio9p.prototype.ReceiveRequest = async function (bufchain) {
    // TODO: split into header + data blobs to avoid unnecessary copying.
    const buffer = new Uint8Array(bufchain.length_readable);
    bufchain.get_next_blob(buffer);

    const state = { offset : 0 };
    var header = marshall.Unmarshall(["w", "b", "h"], buffer, state);
    var size = header[0];
    var id = header[1];
    var tag = header[2];
    //dbg_log("size:" + size + " id:" + id + " tag:" + tag, LOG_9P);

    switch(id)
    {
        case 8: // statfs
            size = this.fs.GetTotalSize(); // size used by all files
            var space = this.fs.GetSpace();
            var req = [];
            req[0] = 0x01021997;
            req[1] = this.BLOCKSIZE; // optimal transfer block size
            req[2] = Math.floor(space/req[1]); // free blocks
            req[3] = req[2] - Math.floor(size/req[1]); // free blocks in fs
            req[4] = req[2] - Math.floor(size/req[1]); // free blocks avail to non-superuser
            req[5] = this.fs.CountUsedInodes(); // total number of inodes
            req[6] = this.fs.CountFreeInodes();
            req[7] = 0; // file system id?
            req[8] = 256; // maximum length of filenames

            size = marshall.Marshall(["w", "w", "d", "d", "d", "d", "d", "d", "w"], req, this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(bufchain);
            break;

        case 112: // topen
        case 12: // tlopen
            var req = marshall.Unmarshall(["w", "w"], buffer, state);
            var fid = req[0];
            var mode = req[1];
            dbg_log("[open] fid=" + fid + ", mode=" + mode, LOG_9P);
            var idx = this.fids[fid].inodeid;
            var inode = this.fs.GetInode(idx);
            dbg_log("file open " + this.fids[fid].dbg_name + " tag:"+tag, LOG_9P);
            await this.fs.OpenInode(idx, mode);

            req = [];
            req[0] = inode.qid;
            req[1] = this.msize - 24;
            marshall.Marshall(["Q", "w"], req, this.replybuffer, 7);
            this.BuildReply(id, tag, 13+4);
            this.SendReply(bufchain);
            break;

        case 70: // link
            var req = marshall.Unmarshall(["w", "w", "s"], buffer, state);
            var dfid = req[0];
            var fid = req[1];
            var name = req[2];
            dbg_log("[link] dfid=" + dfid + ", name=" + name, LOG_9P);

            var ret = this.fs.Link(this.fids[dfid].inodeid, this.fids[fid].inodeid, name);

            if(ret < 0)
            {
                let error_message = "";
                if(ret === -EPERM) error_message = "Operation not permitted";
                else
                {
                    error_message = "Unknown error: " + (-ret);
                    dbg_assert(false, "[link]: Unexpected error code: " + (-ret));
                }
                this.SendError(tag, error_message, -ret);
                this.SendReply(bufchain);
                break;
            }

            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;

        case 16: // symlink
            var req = marshall.Unmarshall(["w", "s", "s", "w"], buffer, state);
            var fid = req[0];
            var name = req[1];
            var symgt = req[2];
            var gid = req[3];
            dbg_log("[symlink] fid=" + fid + ", name=" + name + ", symgt=" + symgt + ", gid=" + gid, LOG_9P);
            var idx = this.fs.CreateSymlink(name, this.fids[fid].inodeid, symgt);
            var inode = this.fs.GetInode(idx);
            inode.uid = this.fids[fid].uid;
            inode.gid = gid;
            marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
            this.BuildReply(id, tag, 13);
            this.SendReply(bufchain);
            break;

        case 18: // mknod
            var req = marshall.Unmarshall(["w", "s", "w", "w", "w", "w"], buffer, state);
            var fid = req[0];
            var name = req[1];
            var mode = req[2];
            var major = req[3];
            var minor = req[4];
            var gid = req[5];
            dbg_log("[mknod] fid=" + fid + ", name=" + name + ", major=" + major + ", minor=" + minor+ "", LOG_9P);
            var idx = this.fs.CreateNode(name, this.fids[fid].inodeid, major, minor);
            var inode = this.fs.GetInode(idx);
            inode.mode = mode;
            //inode.mode = mode | S_IFCHR; // XXX: fails "Mknod - fifo" test
            inode.uid = this.fids[fid].uid;
            inode.gid = gid;
            marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
            this.BuildReply(id, tag, 13);
            this.SendReply(bufchain);
            break;


        case 22: // TREADLINK
            var req = marshall.Unmarshall(["w"], buffer, state);
            var fid = req[0];
            var inode = this.fs.GetInode(this.fids[fid].inodeid);
            dbg_log("[readlink] fid=" + fid + " name=" + this.fids[fid].dbg_name + " target=" + inode.symlink, LOG_9P);
            size = marshall.Marshall(["s"], [inode.symlink], this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(bufchain);
            break;


        case 72: // tmkdir
            var req = marshall.Unmarshall(["w", "s", "w", "w"], buffer, state);
            var fid = req[0];
            var name = req[1];
            var mode = req[2];
            var gid = req[3];
            dbg_log("[mkdir] fid=" + fid + ", name=" + name + ", mode=" + mode + ", gid=" + gid, LOG_9P);
            var idx = this.fs.CreateDirectory(name, this.fids[fid].inodeid);
            var inode = this.fs.GetInode(idx);
            inode.mode = mode | S_IFDIR;
            inode.uid = this.fids[fid].uid;
            inode.gid = gid;
            marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
            this.BuildReply(id, tag, 13);
            this.SendReply(bufchain);
            break;

        case 14: // tlcreate
            var req = marshall.Unmarshall(["w", "s", "w", "w", "w"], buffer, state);
            var fid = req[0];
            var name = req[1];
            var flags = req[2];
            var mode = req[3];
            var gid = req[4];
            this.bus.send("9p-create", [name, this.fids[fid].inodeid]);
            dbg_log("[create] fid=" + fid + ", name=" + name + ", flags=" + flags + ", mode=" + mode + ", gid=" + gid, LOG_9P);
            var idx = this.fs.CreateFile(name, this.fids[fid].inodeid);
            this.fids[fid].inodeid = idx;
            this.fids[fid].type = FID_INODE;
            this.fids[fid].dbg_name = name;
            var inode = this.fs.GetInode(idx);
            inode.uid = this.fids[fid].uid;
            inode.gid = gid;
            inode.mode = mode | S_IFREG;
            marshall.Marshall(["Q", "w"], [inode.qid, this.msize - 24], this.replybuffer, 7);
            this.BuildReply(id, tag, 13+4);
            this.SendReply(bufchain);
            break;

        case 52: // lock
            var req = marshall.Unmarshall(["w", "b", "w", "d", "d", "w", "s"], buffer, state);
            var fid = req[0];
            var flags = req[2];
            var lock_length = req[4] === 0 ? Infinity : req[4];
            var lock_request = this.fs.DescribeLock(req[1], req[3], lock_length, req[5], req[6]);
            dbg_log("[lock] fid=" + fid +
                ", type=" + P9_LOCK_TYPES[lock_request.type] + ", start=" + lock_request.start +
                ", length=" + lock_request.length + ", proc_id=" + lock_request.proc_id);

            var ret = this.fs.Lock(this.fids[fid].inodeid, lock_request, flags);

            marshall.Marshall(["b"], [ret], this.replybuffer, 7);
            this.BuildReply(id, tag, 1);
            this.SendReply(bufchain);
            break;

        case 54: // getlock
            var req = marshall.Unmarshall(["w", "b", "d", "d", "w", "s"], buffer, state);
            var fid = req[0];
            var lock_length = req[3] === 0 ? Infinity : req[3];
            var lock_request = this.fs.DescribeLock(req[1], req[2], lock_length, req[4], req[5]);
            dbg_log("[getlock] fid=" + fid +
                ", type=" + P9_LOCK_TYPES[lock_request.type] + ", start=" + lock_request.start +
                ", length=" + lock_request.length + ", proc_id=" + lock_request.proc_id);

            var ret = this.fs.GetLock(this.fids[fid].inodeid, lock_request);

            if(!ret)
            {
                ret = lock_request;
                ret.type = P9_LOCK_TYPE_UNLCK;
            }

            var ret_length = ret.length === Infinity ? 0 : ret.length;

            size = marshall.Marshall(["b", "d", "d", "w", "s"],
                [ret.type, ret.start, ret_length, ret.proc_id, ret.client_id],
                this.replybuffer, 7);

            this.BuildReply(id, tag, size);
            this.SendReply(bufchain);
            break;

        case 24: // getattr
            var req = marshall.Unmarshall(["w", "d"], buffer, state);
            var fid = req[0];
            var inode = this.fs.GetInode(this.fids[fid].inodeid);
            dbg_log("[getattr]: fid=" + fid + " name=" + this.fids[fid].dbg_name + " request mask=" + req[1], LOG_9P);
            if(!inode || inode.status === STATUS_UNLINKED)
            {
                dbg_log("getattr: unlinked", LOG_9P);
                this.SendError(tag, "No such file or directory", ENOENT);
                this.SendReply(bufchain);
                break;
            }
            req[0] = req[1]; // request mask
            req[1] = inode.qid;

            req[2] = inode.mode;
            req[3] = inode.uid; // user id
            req[4] = inode.gid; // group id

            req[5] = inode.nlinks; // number of hard links
            req[6] = (inode.major<<8) | (inode.minor); // device id low
            req[7] = inode.size; // size low
            req[8] = this.BLOCKSIZE;
            req[9] = Math.floor(inode.size/512+1); // blk size low
            req[10] = inode.atime; // atime
            req[11] = 0x0;
            req[12] = inode.mtime; // mtime
            req[13] = 0x0;
            req[14] = inode.ctime; // ctime
            req[15] = 0x0;
            req[16] = 0x0; // btime
            req[17] = 0x0;
            req[18] = 0x0; // st_gen
            req[19] = 0x0; // data_version
            marshall.Marshall([
            "d", "Q",
            "w",
            "w", "w",
            "d", "d",
            "d", "d", "d",
            "d", "d", // atime
            "d", "d", // mtime
            "d", "d", // ctime
            "d", "d", // btime
            "d", "d",
            ], req, this.replybuffer, 7);
            this.BuildReply(id, tag, 8 + 13 + 4 + 4+ 4 + 8*15);
            this.SendReply(bufchain);
            break;

        case 26: // setattr
            var req = marshall.Unmarshall(["w", "w",
                "w", // mode
                "w", "w", // uid, gid
                "d", // size
                "d", "d", // atime
                "d", "d", // mtime
            ], buffer, state);
            var fid = req[0];
            var inode = this.fs.GetInode(this.fids[fid].inodeid);
            dbg_log("[setattr]: fid=" + fid + " request mask=" + req[1] + " name=" + this.fids[fid].dbg_name, LOG_9P);
            if(req[1] & P9_SETATTR_MODE) {
                // XXX: check mode (S_IFREG or S_IFDIR or similar should be set)
                inode.mode = req[2];
            }
            if(req[1] & P9_SETATTR_UID) {
                inode.uid = req[3];
            }
            if(req[1] & P9_SETATTR_GID) {
                inode.gid = req[4];
            }
            if(req[1] & P9_SETATTR_ATIME) {
                inode.atime = Math.floor((new Date()).getTime()/1000);
            }
            if(req[1] & P9_SETATTR_MTIME) {
                inode.mtime = Math.floor((new Date()).getTime()/1000);
            }
            if(req[1] & P9_SETATTR_CTIME) {
                inode.ctime = Math.floor((new Date()).getTime()/1000);
            }
            if(req[1] & P9_SETATTR_ATIME_SET) {
                inode.atime = req[6];
            }
            if(req[1] & P9_SETATTR_MTIME_SET) {
                inode.mtime = req[8];
            }
            if(req[1] & P9_SETATTR_SIZE) {
                await this.fs.ChangeSize(this.fids[fid].inodeid, req[5]);
            }
            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;

        case 50: // fsync
            var req = marshall.Unmarshall(["w", "d"], buffer, state);
            var fid = req[0];
            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;

        case 40: // TREADDIR
        case 116: // read
            var req = marshall.Unmarshall(["w", "d", "w"], buffer, state);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var inode = this.fs.GetInode(this.fids[fid].inodeid);
            if(id === 40) dbg_log("[treaddir]: fid=" + fid + " offset=" + offset + " count=" + count, LOG_9P);
            if(id === 116) dbg_log("[read]: fid=" + fid + " (" + this.fids[fid].dbg_name + ") offset=" + offset + " count=" + count + " fidtype=" + this.fids[fid].type, LOG_9P);
            if(!inode || inode.status === STATUS_UNLINKED)
            {
                dbg_log("read/treaddir: unlinked", LOG_9P);
                this.SendError(tag, "No such file or directory", ENOENT);
                this.SendReply(bufchain);
                break;
            }
            if(this.fids[fid].type === FID_XATTR) {
                if(inode.caps.length < offset+count) count = inode.caps.length - offset;
                for(var i=0; i<count; i++)
                    this.replybuffer[7+4+i] = inode.caps[offset+i];
                marshall.Marshall(["w"], [count], this.replybuffer, 7);
                this.BuildReply(id, tag, 4 + count);
                this.SendReply(bufchain);
            } else {
                await this.fs.OpenInode(this.fids[fid].inodeid, undefined);
                const inodeid = this.fids[fid].inodeid;

                count = Math.min(count, this.replybuffer.length - (7 + 4));

                if(inode.size < offset+count) count = inode.size - offset;
                else if(id === 40)
                {
                    // for directories, return whole number of dir-entries.
                    count = this.fs.RoundToDirentry(inodeid, offset + count) - offset;
                }
                if(offset > inode.size)
                {
                    // offset can be greater than available - should return count of zero.
                    // See http://ericvh.github.io/9p-rfc/rfc9p2000.html#anchor30
                    count = 0;
                }

                this.bus.send("9p-read-start", [this.fids[fid].dbg_name]);

                const data = await this.fs.Read(inodeid, offset, count);

                this.bus.send("9p-read-end", [this.fids[fid].dbg_name, count]);

                if(data) {
                    this.replybuffer.set(data, 7 + 4);
                }
                marshall.Marshall(["w"], [count], this.replybuffer, 7);
                this.BuildReply(id, tag, 4 + count);
                this.SendReply(bufchain);
            }
            break;

        case 118: // write
            var req = marshall.Unmarshall(["w", "d", "w"], buffer, state);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];

            const filename = this.fids[fid].dbg_name;

            dbg_log("[write]: fid=" + fid + " (" + filename + ") offset=" + offset + " count=" + count + " fidtype=" + this.fids[fid].type, LOG_9P);
            if(this.fids[fid].type === FID_XATTR)
            {
                // XXX: xattr not supported yet. Ignore write.
                this.SendError(tag, "Setxattr not supported", EOPNOTSUPP);
                this.SendReply(bufchain);
                break;
            }
            else
            {
                // XXX: Size of the subarray is unchecked
                await this.fs.Write(this.fids[fid].inodeid, offset, count, buffer.subarray(state.offset));
            }

            this.bus.send("9p-write-end", [filename, count]);

            marshall.Marshall(["w"], [count], this.replybuffer, 7);
            this.BuildReply(id, tag, 4);
            this.SendReply(bufchain);
            break;

        case 74: // RENAMEAT
            var req = marshall.Unmarshall(["w", "s", "w", "s"], buffer, state);
            var olddirfid = req[0];
            var oldname = req[1];
            var newdirfid = req[2];
            var newname = req[3];
            dbg_log("[renameat]: oldname=" + oldname + " newname=" + newname, LOG_9P);
            var ret = await this.fs.Rename(this.fids[olddirfid].inodeid, oldname, this.fids[newdirfid].inodeid, newname);
            if(ret < 0) {
                let error_message = "";
                if(ret === -ENOENT) error_message = "No such file or directory";
                else if(ret === -EPERM) error_message = "Operation not permitted";
                else if(ret === -ENOTEMPTY) error_message = "Directory not empty";
                else
                {
                    error_message = "Unknown error: " + (-ret);
                    dbg_assert(false, "[renameat]: Unexpected error code: " + (-ret));
                }
                this.SendError(tag, error_message, -ret);
                this.SendReply(bufchain);
                break;
            }
            if(TRACK_FILENAMES)
            {
                const newidx = this.fs.Search(this.fids[newdirfid].inodeid, newname);
                this.update_dbg_name(newidx, newname);
            }
            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;

        case 76: // TUNLINKAT
            var req = marshall.Unmarshall(["w", "s", "w"], buffer, state);
            var dirfd = req[0];
            var name = req[1];
            var flags = req[2];
            dbg_log("[unlink]: dirfd=" + dirfd + " name=" + name + " flags=" + flags, LOG_9P);
            var fid = this.fs.Search(this.fids[dirfd].inodeid, name);
            if(fid === -1) {
                   this.SendError(tag, "No such file or directory", ENOENT);
                   this.SendReply(bufchain);
                   break;
            }
            var ret = this.fs.Unlink(this.fids[dirfd].inodeid, name);
            if(ret < 0) {
                let error_message = "";
                if(ret === -ENOTEMPTY) error_message = "Directory not empty";
                else if(ret === -EPERM) error_message = "Operation not permitted";
                else
                {
                    error_message = "Unknown error: " + (-ret);
                    dbg_assert(false, "[unlink]: Unexpected error code: " + (-ret));
                }
                this.SendError(tag, error_message, -ret);
                this.SendReply(bufchain);
                break;
            }
            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;

        case 100: // version
            var version = marshall.Unmarshall(["w", "s"], buffer, state);
            dbg_log("[version]: msize=" + version[0] + " version=" + version[1], LOG_9P);
            if(this.msize !== version[0])
            {
                this.msize = version[0];
                this.replybuffer = new Uint8Array(Math.min(MAX_REPLYBUFFER_SIZE, this.msize*2));
            }
            size = marshall.Marshall(["w", "s"], [this.msize, this.VERSION], this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(bufchain);
            break;

        case 104: // attach
            // return root directorie's QID
            var req = marshall.Unmarshall(["w", "w", "s", "s", "w"], buffer, state);
            var fid = req[0];
            var uid = req[4];
            dbg_log("[attach]: fid=" + fid + " afid=" + h(req[1]) + " uname=" + req[2] + " aname=" + req[3], LOG_9P);
            this.fids[fid] = this.Createfid(0, FID_INODE, uid, "");
            var inode = this.fs.GetInode(this.fids[fid].inodeid);
            marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
            this.BuildReply(id, tag, 13);
            this.SendReply(bufchain);
            this.bus.send("9p-attach");
            break;

        case 108: // tflush
            var req = marshall.Unmarshall(["h"], buffer, state);
            var oldtag = req[0];
            dbg_log("[flush] " + tag, LOG_9P);
            //marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;


        case 110: // walk
            var req = marshall.Unmarshall(["w", "w", "h"], buffer, state);
            var fid = req[0];
            var nwfid = req[1];
            var nwname = req[2];
            dbg_log("[walk]: fid=" + req[0] + " nwfid=" + req[1] + " nwname=" + nwname, LOG_9P);
            if(nwname === 0) {
                this.fids[nwfid] = this.Createfid(this.fids[fid].inodeid, FID_INODE, this.fids[fid].uid, this.fids[fid].dbg_name);
                //this.fids[nwfid].inodeid = this.fids[fid].inodeid;
                marshall.Marshall(["h"], [0], this.replybuffer, 7);
                this.BuildReply(id, tag, 2);
                this.SendReply(bufchain);
                break;
            }
            var wnames = [];
            for(var i=0; i<nwname; i++) {
                wnames.push("s");
            }
            var walk = marshall.Unmarshall(wnames, buffer, state);
            var idx = this.fids[fid].inodeid;
            var offset = 7+2;
            var nwidx = 0;
            //console.log(idx, this.fs.GetInode(idx));
            dbg_log("walk in dir " + this.fids[fid].dbg_name  + " to: " + walk.toString(), LOG_9P);
            for(var i=0; i<nwname; i++) {
                idx = this.fs.Search(idx, walk[i]);

                if(idx === -1) {
                   dbg_log("Could not find: " + walk[i], LOG_9P);
                   break;
                }
                offset += marshall.Marshall(["Q"], [this.fs.GetInode(idx).qid], this.replybuffer, offset);
                nwidx++;
                //dbg_log(this.fids[nwfid].inodeid, LOG_9P);
                //this.fids[nwfid].inodeid = idx;
                //this.fids[nwfid].type = FID_INODE;
                this.fids[nwfid] = this.Createfid(idx, FID_INODE, this.fids[fid].uid, walk[i]);
            }
            marshall.Marshall(["h"], [nwidx], this.replybuffer, 7);
            this.BuildReply(id, tag, offset-7);
            this.SendReply(bufchain);
            break;

        case 120: // clunk
            var req = marshall.Unmarshall(["w"], buffer, state);
            dbg_log("[clunk]: fid=" + req[0], LOG_9P);
            if(this.fids[req[0]] && this.fids[req[0]].inodeid >=  0) {
                await this.fs.CloseInode(this.fids[req[0]].inodeid);
                this.fids[req[0]].inodeid = -1;
                this.fids[req[0]].type = FID_NONE;
            }
            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;

        case 32: // txattrcreate
            var req = marshall.Unmarshall(["w", "s", "d", "w"], buffer, state);
            var fid = req[0];
            var name = req[1];
            var attr_size = req[2];
            var flags = req[3];
            dbg_log("[txattrcreate]: fid=" + fid + " name=" + name + " attr_size=" + attr_size + " flags=" + flags, LOG_9P);

            // XXX: xattr not supported yet. E.g. checks corresponding to the flags needed.
            this.fids[fid].type = FID_XATTR;

            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            //this.SendError(tag, "Operation i not supported",  EINVAL);
            //this.SendReply(bufchain);
            break;

        case 30: // xattrwalk
            var req = marshall.Unmarshall(["w", "w", "s"], buffer, state);
            var fid = req[0];
            var newfid = req[1];
            var name = req[2];
            dbg_log("[xattrwalk]: fid=" + req[0] + " newfid=" + req[1] + " name=" + req[2], LOG_9P);

            // Workaround for Linux restarts writes until full blocksize
            this.SendError(tag, "Setxattr not supported", EOPNOTSUPP);
            this.SendReply(bufchain);
            /*
            this.fids[newfid] = this.Createfid(this.fids[fid].inodeid, FID_NONE, this.fids[fid].uid, this.fids[fid].dbg_name);
            //this.fids[newfid].inodeid = this.fids[fid].inodeid;
            //this.fids[newfid].type = FID_NONE;
            var length = 0;
            if (name === "security.capability") {
                length = this.fs.PrepareCAPs(this.fids[fid].inodeid);
                this.fids[newfid].type = FID_XATTR;
            }
            marshall.Marshall(["d"], [length], this.replybuffer, 7);
            this.BuildReply(id, tag, 8);
            this.SendReply(bufchain);
            */
            break;

        default:
            dbg_log("Error in Virtio9p: Unknown id " + id + " received", LOG_9P);
            dbg_assert(false);
            //this.SendError(tag, "Operation i not supported",  EOPNOTSUPP);
            //this.SendReply(bufchain);
            break;
    }

    //consistency checks if there are problems with the filesystem
    //this.fs.Check();
};

/** @typedef {function(Uint8Array, function(Uint8Array):void):void} */
let P9Handler;

/**
 * @constructor
 *
 * @param {P9Handler} handle_fn
 * @param {CPU} cpu
 */
export function Virtio9pHandler(handle_fn, cpu) {
    /** @type {P9Handler} */
    this.handle_fn = handle_fn;
    this.tag_bufchain = new Map();

    this.configspace_tagname = [0x68, 0x6F, 0x73, 0x74, 0x39, 0x70]; // "host9p" string
    this.configspace_taglen = this.configspace_tagname.length; // num bytes

    this.virtio = init_virtio(
        cpu,
        this.configspace_taglen,
        this.configspace_tagname,
        async (bufchain) => {
            // TODO: split into header + data blobs to avoid unnecessary copying.
            const reqbuf = new Uint8Array(bufchain.length_readable);
            bufchain.get_next_blob(reqbuf);

            var reqheader = marshall.Unmarshall(["w", "b", "h"], reqbuf, { offset : 0 });
            var reqtag = reqheader[2];

            this.tag_bufchain.set(reqtag, bufchain);
            this.handle_fn(reqbuf, (replybuf) => {
                var replyheader = marshall.Unmarshall(["w", "b", "h"], replybuf, { offset: 0 });
                var replytag = replyheader[2];

                const bufchain = this.tag_bufchain.get(replytag);
                if(!bufchain)
                {
                    console.error("No bufchain found for tag: " + replytag);
                    return;
                }

                bufchain.set_next_blob(replybuf);
                this.virtqueue.push_reply(bufchain);
                this.virtqueue.flush_replies();

                this.tag_bufchain.delete(replytag);
            });
        }
    );
    this.virtqueue = this.virtio.queues[0];
}

Virtio9pHandler.prototype.get_state = function()
{
    var state = [];

    state[0] = this.configspace_tagname;
    state[1] = this.configspace_taglen;
    state[2] = this.virtio;
    state[3] = this.tag_bufchain;

    return state;
};

Virtio9pHandler.prototype.set_state = function(state)
{
    this.configspace_tagname = state[0];
    this.configspace_taglen = state[1];
    this.virtio.set_state(state[2]);
    this.virtqueue = this.virtio.queues[0];
    this.tag_bufchain = state[3];
};


Virtio9pHandler.prototype.reset = function()
{
    this.virtio.reset();
};


/**
 * @constructor
 *
 * @param {string} url
 * @param {CPU} cpu
 */
export function Virtio9pProxy(url, cpu)
{
    this.socket = undefined;
    this.cpu = cpu;

    // TODO: circular buffer?
    this.send_queue = [];
    this.url = url;

    this.reconnect_interval = 10000;
    this.last_connect_attempt = Date.now() - this.reconnect_interval;
    this.send_queue_limit = 64;
    this.destroyed = false;

    this.tag_bufchain = new Map();

    this.configspace_tagname = [0x68, 0x6F, 0x73, 0x74, 0x39, 0x70]; // "host9p" string
    this.configspace_taglen = this.configspace_tagname.length; // num bytes

    this.virtio = init_virtio(
        cpu,
        this.configspace_taglen,
        this.configspace_tagname,
        async (bufchain) => {
            // TODO: split into header + data blobs to avoid unnecessary copying.
            const reqbuf = new Uint8Array(bufchain.length_readable);
            bufchain.get_next_blob(reqbuf);

            const reqheader = marshall.Unmarshall(["w", "b", "h"], reqbuf, { offset : 0 });
            const reqtag = reqheader[2];

            this.tag_bufchain.set(reqtag, bufchain);
            this.send(reqbuf);
        }
    );
    this.virtqueue = this.virtio.queues[0];
}

Virtio9pProxy.prototype.get_state = function()
{
    var state = [];

    state[0] = this.configspace_tagname;
    state[1] = this.configspace_taglen;
    state[2] = this.virtio;
    state[3] = this.tag_bufchain;

    return state;
};

Virtio9pProxy.prototype.set_state = function(state)
{
    this.configspace_tagname = state[0];
    this.configspace_taglen = state[1];
    this.virtio.set_state(state[2]);
    this.virtqueue = this.virtio.queues[0];
    this.tag_bufchain = state[3];
};

Virtio9pProxy.prototype.reset = function() {
    this.virtio.reset();
};

Virtio9pProxy.prototype.handle_message = function(e)
{
    const replybuf = new Uint8Array(e.data);
    const replyheader = marshall.Unmarshall(["w", "b", "h"], replybuf, { offset: 0 });
    const replytag = replyheader[2];

    const bufchain = this.tag_bufchain.get(replytag);
    if(!bufchain)
    {
        console.error("Virtio9pProxy: No bufchain found for tag: " + replytag);
        return;
    }

    bufchain.set_next_blob(replybuf);
    this.virtqueue.push_reply(bufchain);
    this.virtqueue.flush_replies();

    this.tag_bufchain.delete(replytag);
};

Virtio9pProxy.prototype.handle_close = function(e)
{
    //console.log("onclose", e);

    if(!this.destroyed)
    {
        this.connect();
        setTimeout(this.connect.bind(this), this.reconnect_interval);
    }
};

Virtio9pProxy.prototype.handle_open = function(e)
{
    //console.log("open", e);

    for(var i = 0; i < this.send_queue.length; i++)
    {
        this.send(this.send_queue[i]);
    }

    this.send_queue = [];
};

Virtio9pProxy.prototype.handle_error = function(e)
{
    //console.log("onerror", e);
};

Virtio9pProxy.prototype.destroy = function()
{
    this.destroyed = true;
    if(this.socket)
    {
        this.socket.close();
    }
};

Virtio9pProxy.prototype.connect = function()
{
    if(typeof WebSocket === "undefined")
    {
        return;
    }

    if(this.socket)
    {
        var state = this.socket.readyState;

        if(state === 0 || state === 1)
        {
            // already or almost there
            return;
        }
    }

    var now = Date.now();

    if(this.last_connect_attempt + this.reconnect_interval > now)
    {
        return;
    }

    this.last_connect_attempt = Date.now();

    try
    {
        this.socket = new WebSocket(this.url);
    }
    catch(e)
    {
        console.error(e);
        return;
    }

    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = this.handle_open.bind(this);
    this.socket.onmessage = this.handle_message.bind(this);
    this.socket.onclose = this.handle_close.bind(this);
    this.socket.onerror = this.handle_error.bind(this);
};

Virtio9pProxy.prototype.send = function(data)
{
    //console.log("send", data);

    if(!this.socket || this.socket.readyState !== 1)
    {
        this.send_queue.push(data);

        if(this.send_queue.length > 2 * this.send_queue_limit)
        {
            this.send_queue = this.send_queue.slice(-this.send_queue_limit);
        }

        this.connect();
    }
    else
    {
        this.socket.send(data);
    }
};

Virtio9pProxy.prototype.change_proxy = function(url)
{
    this.url = url;

    if(this.socket)
    {
        this.socket.onclose = function() {};
        this.socket.onerror = function() {};
        this.socket.close();
        this.socket = undefined;
    }
};
