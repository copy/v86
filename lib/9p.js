// -------------------------------------------------
// --------------------- 9P ------------------------
// -------------------------------------------------
// Implementation of the 9p filesystem device following the
// 9P2000.L protocol ( https://code.google.com/p/diod/wiki/protocol )

"use strict";

// Feature bit (bit position) for mount tag.
const VIRTIO_9P_F_MOUNT_TAG = 0;
// Assumed max tag length in bytes.
const VIRTIO_9P_MAX_TAGLEN = 254;

// TODO
// flush

var EPERM = 1;       /* Operation not permitted */
var ENOENT = 2;      /* No such file or directory */
var EEXIST = 17;      /* File exists */
var EINVAL = 22;     /* Invalid argument */
var EOPNOTSUPP = 95;  /* Operation is not supported */
var ENOTEMPTY = 39;  /* Directory not empty */
var EPROTO    = 71;  /* Protocol error */

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

const P9_LOCK_TYPE_RDLCK = 0;
const P9_LOCK_TYPE_WRLCK = 1;
const P9_LOCK_TYPE_UNLCK = 2;
const P9_LOCK_TYPES = Object.freeze(["shared", "exclusive", "unlock"]);

const P9_LOCK_FLAGS_BLOCK = 1;
const P9_LOCK_FLAGS_RECLAIM = 2;

const P9_LOCK_SUCCESS = 0;
const P9_LOCK_BLOCKED = 1;
const P9_LOCK_ERROR = 2;
const P9_LOCK_GRACE = 3;

var FID_NONE = -1;
var FID_INODE = 1;
var FID_XATTR = 2;

/**
 * @constructor
 *
 * @param {FS} filesystem
 * @param {CPU} cpu
 */
function Virtio9p(filesystem, cpu, bus) {
    /** @type {FS} */
    this.fs = filesystem;

    /** @const @type {BusConnector} */
    this.bus = bus;

    //this.configspace = [0x0, 0x4, 0x68, 0x6F, 0x73, 0x74]; // length of string and "host" string
    //this.configspace = [0x0, 0x9, 0x2F, 0x64, 0x65, 0x76, 0x2F, 0x72, 0x6F, 0x6F, 0x74 ]; // length of string and "/dev/root" string
    this.configspace_tagname = [0x68, 0x6F, 0x73, 0x74, 0x39, 0x70]; // "host9p" string
    this.configspace_taglen = this.configspace_tagname.length; // num bytes
    this.VERSION = "9P2000.L";
    this.BLOCKSIZE = 8192; // Let's define one page.
    this.msize = 8192; // maximum message size
    this.replybuffer = new Uint8Array(this.msize*2); // Twice the msize to stay on the safe site
    this.replybuffersize = 0;

    this.fids = [];

    /** @type {VirtIO} */
    this.virtio = new VirtIO(cpu,
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
                    while(this.virtqueue.has_request())
                    {
                        const bufchain = this.virtqueue.pop_request();
                        this.ReceiveRequest(bufchain);
                    }
                    this.virtqueue.notify_me_after(0);
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
                    read: () => this.configspace_taglen,
                    write: data => { /* read only */ },
                },
            ].concat(v86util.range(VIRTIO_9P_MAX_TAGLEN).map(index =>
                ({
                    bytes: 1,
                    name: "mount tag name " + index,
                    // Note: configspace_tagname may have changed after set_state
                    read: () => this.configspace_tagname[index] || 0,
                    write: data => { /* read only */ },
                })
            )),
        },
    });
    this.virtqueue = this.virtio.queues[0];
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
// Set TRACK_FILENAMES = true (in config.js) to sync dbg_name during 9p renames.
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

Virtio9p.prototype.Reset = function() {
    this.fids = [];
};


Virtio9p.prototype.BuildReply = function(id, tag, payloadsize) {
    dbg_assert(payloadsize >= 0, "9P: Negative payload size");
    marshall.Marshall(["w", "b", "h"], [payloadsize+7, id+1, tag], this.replybuffer, 0);
    if ((payloadsize+7) >= this.replybuffer.length) {
        message.Debug("Error in 9p: payloadsize exceeds maximum length");
    }
    //for(var i=0; i<payload.length; i++)
    //    this.replybuffer[7+i] = payload[i];
    this.replybuffersize = payloadsize+7;
    return;
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
    //message.Debug("size:" + size + " id:" + id + " tag:" + tag);

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
            message.Debug("[open] fid=" + fid + ", mode=" + mode);
            var idx = this.fids[fid].inodeid;
            var inode = this.fs.GetInode(idx);
            message.Debug("file open " + this.fids[fid].dbg_name);
            //if (inode.status == STATUS_LOADING) return;
            var ret = this.fs.OpenInode(idx, mode);

            this.fs.AddEvent(this.fids[fid].inodeid,
                function() {
                    message.Debug("file opened " + this.fids[fid].dbg_name + " tag:"+tag);
                    var req = [];
                    req[0] = inode.qid;
                    req[1] = this.msize - 24;
                    marshall.Marshall(["Q", "w"], req, this.replybuffer, 7);
                    this.BuildReply(id, tag, 13+4);
                    this.SendReply(bufchain);
                }.bind(this)
            );
            break;

        case 70: // link
            var req = marshall.Unmarshall(["w", "w", "s"], buffer, state);
            var dfid = req[0];
            var fid = req[1];
            var name = req[2];
            message.Debug("[link] dfid=" + dfid + ", name=" + name);

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
            message.Debug("[symlink] fid=" + fid + ", name=" + name + ", symgt=" + symgt + ", gid=" + gid);
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
            message.Debug("[mknod] fid=" + fid + ", name=" + name + ", major=" + major + ", minor=" + minor+ "");
            var idx = this.fs.CreateNode(name, this.fids[fid].inodeid, major, minor);
            var inode = this.fs.GetInode(idx);
            inode.mode = mode;
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
            message.Debug("[readlink] fid=" + fid + " name=" + this.fids[fid].dbg_name + " target=" + inode.symlink);
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
            message.Debug("[mkdir] fid=" + fid + ", name=" + name + ", mode=" + mode + ", gid=" + gid);
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
            message.Debug("[create] fid=" + fid + ", name=" + name + ", flags=" + flags + ", mode=" + mode + ", gid=" + gid);
            var idx = this.fs.CreateFile(name, this.fids[fid].inodeid);
            this.fids[fid].inodeid = idx;
            this.fids[fid].type = FID_INODE;
            this.fids[fid].dbg_name = name;
            var inode = this.fs.GetInode(idx);
            inode.uid = this.fids[fid].uid;
            inode.gid = gid;
            inode.mode = mode;
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
            message.Debug("[lock] fid=" + fid +
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
            message.Debug("[getlock] fid=" + fid +
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
            message.Debug("[getattr]: fid=" + fid + " name=" + this.fids[fid].dbg_name + " request mask=" + req[1]);
            if(!inode || inode.status === STATUS_UNLINKED)
            {
                message.Debug("getattr: unlinked");
                this.SendError(tag, "No such file or directory", ENOENT);
                this.SendReply(bufchain);
                break;
            }
            req[0] |= 0x1000; // P9_STATS_GEN

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
            message.Debug("[setattr]: fid=" + fid + " request mask=" + req[1] + " name=" + this.fids[fid].dbg_name);
            if (req[1] & P9_SETATTR_MODE) {
                inode.mode = req[2];
            }
            if (req[1] & P9_SETATTR_UID) {
                inode.uid = req[3];
            }
            if (req[1] & P9_SETATTR_GID) {
                inode.gid = req[4];
            }
            if (req[1] & P9_SETATTR_ATIME) {
                inode.atime = Math.floor((new Date()).getTime()/1000);
            }
            if (req[1] & P9_SETATTR_MTIME) {
                inode.mtime = Math.floor((new Date()).getTime()/1000);
            }
            if (req[1] & P9_SETATTR_CTIME) {
                inode.ctime = Math.floor((new Date()).getTime()/1000);
            }
            if (req[1] & P9_SETATTR_ATIME_SET) {
                inode.atime = req[6];
            }
            if (req[1] & P9_SETATTR_MTIME_SET) {
                inode.mtime = req[8];
            }
            if (req[1] & P9_SETATTR_SIZE) {
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
            if (id == 40) message.Debug("[treaddir]: fid=" + fid + " offset=" + offset + " count=" + count);
            if (id == 116) message.Debug("[read]: fid=" + fid + " (" + this.fids[fid].dbg_name + ") offset=" + offset + " count=" + count + " fidtype=" + this.fids[fid].type);
            if(!inode || inode.status === STATUS_UNLINKED)
            {
                message.Debug("read/treaddir: unlinked");
                this.SendError(tag, "No such file or directory", ENOENT);
                this.SendReply(bufchain);
                break;
            }
            if (this.fids[fid].type == FID_XATTR) {
                if (inode.caps.length < offset+count) count = inode.caps.length - offset;
                for(var i=0; i<count; i++)
                    this.replybuffer[7+4+i] = inode.caps[offset+i];
                marshall.Marshall(["w"], [count], this.replybuffer, 7);
                this.BuildReply(id, tag, 4 + count);
                this.SendReply(bufchain);
            } else {
                this.fs.OpenInode(this.fids[fid].inodeid, undefined);
                const inodeid = this.fids[fid].inodeid;

                if (inode.size < offset+count) count = inode.size - offset;
                else if(id == 40)
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

            message.Debug("[write]: fid=" + fid + " (" + filename + ") offset=" + offset + " count=" + count + " fidtype=" + this.fids[fid].type);
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
            message.Debug("[renameat]: oldname=" + oldname + " newname=" + newname);
            var ret = await this.fs.Rename(this.fids[olddirfid].inodeid, oldname, this.fids[newdirfid].inodeid, newname);
            if (ret < 0) {
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
            message.Debug("[unlink]: dirfd=" + dirfd + " name=" + name + " flags=" + flags);
            var fid = this.fs.Search(this.fids[dirfd].inodeid, name);
            if (fid == -1) {
                   this.SendError(tag, "No such file or directory", ENOENT);
                   this.SendReply(bufchain);
                   break;
            }
            var ret = this.fs.Unlink(this.fids[dirfd].inodeid, name);
            if (ret < 0) {
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
            message.Debug("[version]: msize=" + version[0] + " version=" + version[1]);
            this.msize = version[0];
            size = marshall.Marshall(["w", "s"], [this.msize, this.VERSION], this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(bufchain);
            break;

        case 104: // attach
            // return root directorie's QID
            var req = marshall.Unmarshall(["w", "w", "s", "s", "w"], buffer, state);
            var fid = req[0];
            var uid = req[4];
            message.Debug("[attach]: fid=" + fid + " afid=" + hex8(req[1]) + " uname=" + req[2] + " aname=" + req[3]);
            this.fids[fid] = this.Createfid(0, FID_INODE, uid, "");
            var inode = this.fs.GetInode(this.fids[fid].inodeid);
            marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
            this.BuildReply(id, tag, 13);
            this.SendReply(bufchain);
            break;

        case 108: // tflush
            var req = marshall.Unmarshall(["h"], buffer, state);
            var oldtag = req[0];
            message.Debug("[flush] " + tag);
            //marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;


        case 110: // walk
            var req = marshall.Unmarshall(["w", "w", "h"], buffer, state);
            var fid = req[0];
            var nwfid = req[1];
            var nwname = req[2];
            message.Debug("[walk]: fid=" + req[0] + " nwfid=" + req[1] + " nwname=" + nwname);
            if (nwname == 0) {
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
            message.Debug("walk in dir " + this.fids[fid].dbg_name  + " to: " + walk.toString());
            for(var i=0; i<nwname; i++) {
                idx = this.fs.Search(idx, walk[i]);

                if (idx == -1) {
                   message.Debug("Could not find: " + walk[i]);
                   break;
                }
                offset += marshall.Marshall(["Q"], [this.fs.GetInode(idx).qid], this.replybuffer, offset);
                nwidx++;
                //message.Debug(this.fids[nwfid].inodeid);
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
            message.Debug("[clunk]: fid=" + req[0]);
            if (this.fids[req[0]] && this.fids[req[0]].inodeid >=  0) {
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
            message.Debug("[txattrcreate]: fid=" + fid + " name=" + name + " attr_size=" + attr_size + " flags=" + flags);

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
            message.Debug("[xattrwalk]: fid=" + req[0] + " newfid=" + req[1] + " name=" + req[2]);

            // Workaround for Linux restarts writes until full blocksize
            this.SendError(tag, "Setxattr not supported", EOPNOTSUPP);
            this.SendReply(bufchain);
            /*
            this.fids[newfid] = this.Createfid(this.fids[fid].inodeid, FID_NONE, this.fids[fid].uid, this.fids[fid].dbg_name);
            //this.fids[newfid].inodeid = this.fids[fid].inodeid;
            //this.fids[newfid].type = FID_NONE;
            var length = 0;
            if (name == "security.capability") {
                length = this.fs.PrepareCAPs(this.fids[fid].inodeid);
                this.fids[newfid].type = FID_XATTR;
            }
            marshall.Marshall(["d"], [length], this.replybuffer, 7);
            this.BuildReply(id, tag, 8);
            this.SendReply(bufchain);
            */
            break;

        default:
            message.Debug("Error in Virtio9p: Unknown id " + id + " received");
            message.Abort();
            //this.SendError(tag, "Operation i not supported",  EOPNOTSUPP);
            //this.SendReply(bufchain);
            break;
    }

    //consistency checks if there are problems with the filesystem
    //this.fs.Check();
};
