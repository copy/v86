// -------------------------------------------------
// --------------------- 9P ------------------------
// -------------------------------------------------
// Ported to newer v86 from https://github.com/humphd/v86/tree/filer-9p-lastknowngood
// Implementation of the 9p filesystem wrapping Filer.js
// based on https://github.com/copy/v86/blob/master/lib/9p.js 
// which in turn is based on the 9P2000.L protocol:
// https://code.google.com/p/diod/wiki/protocol

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

// Mapping from Filer.js to POSIX
const POSIX_ERR_CODE_MAP = {
    'EPERM': 1,
    'ENOENT': 2,
    'EBADF': 9,
    'EBUSY': 11,
    'EINVAL': 22,
    'ENOTDIR': 20,
    'EISDIR': 21,
    'EEXIST': 17,
    'ELOOP': 40,
    'ENOTEMPTY': 39,
    'EIO': 5,
    'EOPNOTSUPP': 95 // r58Playz: I don't think this exists in Filer, only used as a filler for the new code that uses this
};

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


// https://github.com/darkskyapp/string-hash
function hash32(string) {
    var hash = 5381;
    var i = string.length;

    while(i) {
        hash = (hash * 33) ^ string.charCodeAt(--i);
    }

    /* JavaScript does bitwise operations (like XOR, above) on 32-bit signed
    * integers. Since we want the results to be always positive, convert the
    * signed int to an unsigned by doing an unsigned bitshift. */
    return hash >>> 0;
}

function getQType(type) {
    switch(type) {
        case 'FILE':
            return 0x00;
        case 'DIRECTORY':
            return 0x80;
        case 'SYMLINK':
            return 0x02;
        default:
            return 0x00;
    }
}

function formatQid(path, stats) {
    return {
        type: getQType(stats.type),
        version: stats.version != undefined ? stats.version : 0,
        path: hash32(stats.node)
    };
}

/**
 * @constructor
 *
 * @param {FS} filesystem
 * @param {CPU} cpu
 */
function Virtio9p(filesystem, cpu, bus) {
    // Pass in filesystem = { fs, sh, Path, Buffer }
    this.fs = filesystem.fs;
    this.sh = filesystem.sh;
    this.Path = filesystem.Path;
    this.Buffer = filesystem.Buffer;

    /** @const @type {BusConnector} */
    this.bus = bus;

    //this.configspace = [0x0, 0x4, 0x68, 0x6F, 0x73, 0x74]; // length of string and "host" string
    //this.configspace = [0x0, 0x9, 0x2F, 0x64, 0x65, 0x76, 0x2F, 0x72, 0x6F, 0x6F, 0x74 ]; // length of string and "/dev/root" string
    this.configspace_tagname = [0x68, 0x6F, 0x73, 0x74, 0x39, 0x70]; // [0x66, 0x69, 0x6C, 0x65, 0x72, 0x39, 0x70]; // "filer9p" string
    this.configspace_taglen = this.configspace_tagname.length; // num bytes
    this.VERSION = "9P2000.L";
    this.BLOCKSIZE = 8192; // Let's define one page.
    this.msize = 8192; // maximum message size
    this.replybuffer = new Uint8Array(this.msize*2); // Twice the msize to stay on the safe side
    this.replybuffersize = 0;

    this.fids = {};

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
                        dbg_assert(false, "Virtio-Filer-9P Notified for non-existent queue: " + queue_id +
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
    this.pendingTags = {};
}

Virtio9p.prototype.shouldAbortRequest = function(tag) {
    var shouldAbort = !this.pendingTags[tag];
    if(shouldAbort) {
        message.Debug("Request can be aborted tag=" + tag);
    }
    return shouldAbort;
};

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
    state[10] = this.sh;
    state[11] = this.Path;
    state[12] = this.Buffer;

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
    // TODO: (r58Playz) is this proper?
    this.sh = state[10];
    this.Path = state[11];
    this.Buffer = state[12];
};


Virtio9p.prototype.Createfid = function(path, type, uid) {
    return {path, type, uid};
};


Virtio9p.prototype.Reset = function() {
    this.fids = {};
};

// Before we begin any async file i/o, mark the tag as being pending
Virtio9p.prototype.addTag = function(tag) {
    this.pendingTags[tag] = {};
};

// Flush an inflight async request
Virtio9p.prototype.flushTag = function(tag) {
    delete this.pendingTags[tag];
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

Virtio9p.prototype.SendError = function (tag, err) {
    //var size = marshall.Marshall(["s", "w"], [errormsg, errorcode], this.replybuffer, 7);
    var errorcode = POSIX_ERR_CODE_MAP[err.code];
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
    var self = this;
    var Path = this.Path;
    var Buffer = this.buffer;
    var fs = this.fs;
    var sh = this.sh;

    // TODO: split into header + data blobs to avoid unnecessary copying.
    const buffer = new Uint8Array(bufchain.length_readable);
    bufchain.get_next_blob(buffer);

    const state = { offset : 0 };
    var header = marshall.Unmarshall(["w", "b", "h"], buffer, state);
    var size = header[0];
    var id = header[1];
    var tag = header[2];

    this.addTag(tag);
    //message.Debug("size:" + size + " id:" + id + " tag:" + tag);
    switch(id)
    {
        case 8: // statfs
            size = 1024 ; // this.fs.GetTotalSize(); // size used by all files
            var space = 1024 * 1024 * 1024; // this.fs.GetSpace();
            var req = [];
            req[0] = 0x01021997; // fs type
            req[1] = this.BLOCKSIZE; // optimal transfer block size
            req[2] = Math.floor(space/req[1]); // free blocks
            req[3] = req[2] - Math.floor(size/req[1]); // free blocks in fs
            req[4] = req[2] - Math.floor(size/req[1]); // free blocks avail to non-superuser
            req[5] = 1024 * 1024 * 1024; // total number of inodes
            req[6] = 1024 * 1024; // free inodes
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
            var path = this.fids[fid].path;

            console.error(fid, this.fids[fid])

            message.Debug("[open] fid=" + fid + ", mode=" + mode);
            message.Debug("file open " + this.fids[fid].dbg_name);

            fs.stat(path, function (err, stats) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                    return;
                }

                req[0] = formatQid(path, stats);
                req[1] = self.msize - 24;
                marshall.Marshall(["Q", "w"], req, self.replybuffer, 7);
                self.BuildReply(id, tag, 13+4);
                self.SendReply(bufchain);
            });

            break;

        case 70: // link
            var req = marshall.Unmarshall(["w", "w", "s"], buffer, state);
            var dfid = req[0];
            var dirPath = self.fids[dfid].path;
            var fid = req[1];
            var existingPath = self.fids[fid].path;
            var name = req[2];
            var newPath = Path.join(dirPath, name);

            message.Debug("[link] dfid=" + dfid + ", name=" + name);

            fs.link(existingPath, newPath, function(err) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                }

                self.BuildReply(id, tag, 0);
                self.SendReply(bufchain);
            });

            break;

        case 16: // symlink
            var req = marshall.Unmarshall(["w", "s", "s", "w"], buffer, state);
            var fid = req[0];
            var path = self.fids[fid].path;
            var name = req[1];
            var newPath = Path.join(path, name);
            var symtgt = req[2];
            // TODO: deal with gid
            var gid = req[3];
            
            message.Debug("[symlink] fid=" + fid + ", name=" + name + ", symtgt=" + symtgt + ", gid=" + gid);
            
            fs.symlink(symtgt, newPath, function(err) {
                if(self.shouldAbortRequest(tag)) return;
                
                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                    return;
                }
                fs.stat(newPath, function(err, stats) {
                    if(self.shouldAbortRequest(tag)) return;
                    
                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(bufchain);
                    }

                    var qid = formatQid(newPath, stats);

                    marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
                    self.BuildReply(id, tag, 13);
                    self.SendReply(bufchain);
                });
            });
            break;

        case 18: // mknod
            var req = marshall.Unmarshall(["w", "s", "w", "w", "w", "w"], buffer, state);
            var fid = req[0];
            var filePath = self.fids[fid].path;
            var name = req[1];
            var mode = req[2];
            var major = req[3];
            var minor = req[4];
            var gid = req[5];
            message.Debug("[mknod] fid=" + fid + ", name=" + name + ", major=" + major + ", minor=" + minor+ "");
            
            // TODO: deal with mode properly in filer
            fs.mknod(filePath, 'FILE', function(err) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                    return;
                }
                fs.stat(filePath, function(err, stats) {
                    if(self.shouldAbortRequest(tag)) return;

                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(bufchain);
                        return;
                    }

                    var qid = formatQid(filePath, stats);

                    marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
                    self.BuildReply(id, tag, 13);
                    self.SendReply(bufchain);
                });
            });
            break;


        case 22: // TREADLINK
            var req = marshall.Unmarshall(["w"], buffer, state);
            var fid = req[0];
            var path = self.fids[fid].path;

            message.Debug("[readlink] fid=" + fid + " name=" + this.fids[fid].dbg_name + " target=" + "idk");
            fs.readlink(path, function(err, contents) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.sendReply(bufchain);
                    return;
                }

                size = marshall.Marshall(["s"], [contents], self.replybuffer, 7);
                self.BuildReply(id, tag, size);
                self.SendReply(bufchain);
            });
            break;


        case 72: // tmkdir
            var req = marshall.Unmarshall(["w", "s", "w", "w"], buffer, state);
            var fid = req[0];
            var name = req[1];
            var mode = req[2];
            var gid = req[3];
            var parentPath = self.fids[fid].path;
            var newDir = Path.join(parentPath, name);

            message.Debug("[mkdir] fid=" + fid + ", name=" + name + ", mode=" + mode + ", gid=" + gid);

            fs.mkdir(newDir, mode, function(err) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                }

                fs.stat(newDir, function(err, stats) {
                    if(self.shouldAbortRequest(tag)) return;

                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(bufchain);
                    }

                    var qid = formatQid(newDir, stats);

                    marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
                    self.BuildReply(id, tag, 13);
                    self.SendReply(bufchain);
                });
            });
            break;

        case 14: // tlcreate
            var req = marshall.Unmarshall(["w", "s", "w", "w", "w"], buffer, state);
            var fid = req[0];
            var name = req[1];
            var flags = req[2];
            var mode = req[3];
            var gid = req[4];

            var newFilePath = Path.join(self.fids[fid].path, name);

            // the old code doesn't have this line? 
            this.bus.send("9p-create", [name, this.fids[fid].inodeid]);
            
            message.Debug("[create] fid=" + fid + ", name=" + name + ", flags=" + flags + ", mode=" + mode + ", gid=" + gid);
            
            fs.open(newFilePath, 'w+', mode, function(err, fd) {
                if(self.shouldAbortRequest(tag)) {
                    if(fd) fs.close(fd);
                    return;
                }

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                }

                fs.fstat(fd, function(err, stats) {
                    if(self.shouldAbortRequest(tag)) {
                        if(fd) fs.close(fd)
                        return;
                    }

                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(bufchain);
                    }

                    self.fids[fid] = self.Createfid(newFilePath, FID_INODE, uid);
                    fs.close(fd);
                    var qid = formatQid(newFilePath, stats);

                    marshall.Marshall(["Q", "w"], [qid, self.msize - 24], self.replybuffer, 7);
                    self.BuildReply(id, tag, 13+4);
                    self.SendReply(bufchain);
                });
            });
            break;

        case 52: // lock
            // always succeeds
            marshall.Marshall(["b"], [0], this.replybuffer, 7);
            this.BuildReply(id, tag, 1);
            this.SendReply(bufchain);
            break;

        case 54: // getlock
            // apparently does nothing?
            break;

        case 24: // getattr
            var req = marshall.Unmarshall(["w", "d"], buffer, state);
            var fid = req[0];
            var path = this.fids[fid].path;

            message.Debug("[getattr]: fid=" + fid + " name=" + this.fids[fid].dbg_name + " request mask=" + req[1]);

            // We ignore the request_mask, and always send back all fields except btime, gen, data_version 
            function statsToFileAttributes(stats) {
                // P9_GETATTR_BASIC 0x000007ffULL - Mask for all fields except btime, gen, data_version */
                var valid = 0x000007ff;
                var qid = formatQid(path, stats);
                var mode = stats.mode;
                var uid = stats.uid;
                var gid = stats.gid;
                var nlink = stats.nlinks;
                var rdev = (0x0<<8) | (0x0);
                var size = stats.size;
                var blksize = self.BLOCKSIZE;
                var blocks = Math.floor(size/512+1);
                var atime_sec = Math.round(stats.atimeMs / 1000);
                var atime_nsec = stats.atimeMs * 1000000;
                var mtime_sec = Math.round(stats.mtimeMs / 1000);
                var mtime_nsec = stats.mtimeMs * 1000000;
                var ctime_sec = Math.round(stats.ctimeMs / 1000);
                var ctime_nsec = stats.ctimeMs * 1000000;
                // Reserved for future use, not supported by us.
                var btime_sec = 0x0;
                var btime_nsec = 0x0;
                var gen = 0x0;
                var data_version = 0x0;

                return [
                    valid, qid, mode, uid, gid, nlink, rdev, size, blksize,
                    blocks, atime_sec, atime_nsec, mtime_sec, mtime_nsec,
                    ctime_sec, ctime_nsec, btime_sec, btime_nsec, gen,
                    data_version
                ];
            }

            fs.lstat(path, function (err, stats) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                }

                var p9stats = statsToFileAttributes(stats);

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
                ], p9stats, self.replybuffer, 7);
                self.BuildReply(id, tag, 8 + 13 + 4 + 4+ 4 + 8*15);
                self.SendReply(bufchain);
            });
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
            var path = this.fids[fid].path;
            message.Debug("[setattr]: fid=" + fid + " request mask=" + req[1]);
            
            var promises = [];

            if (req[1] & P9_SETATTR_MODE) {
                promises.push(
                    new Promise(function(resolve, reject) {
                        var mode = req[2];

                        message.Debug("[setattr]: mode=" + mode);

                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }

                        fs.chmod(path, mode, function(err) {
                            if(err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    })
                );
            }

            // TODO: what if I only get one of uid/gid instead of both?
            if ((req[1] & P9_SETATTR_UID) && (req[1] & P9_SETATTR_GID)) {
                promises.push(
                    new Promise(function(resolve, reject) {
                        var uid = req[3];
                        var gid = req[4];

                        message.Debug("[setattr]: uid=" + uid + " gid=" + gid);

                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }

                        fs.chown(path, uid, gid, function(err) {
                            if(err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    })
                );
            }

            var atime;
            var mtime;
            var now = Date.now();

            if (req[1] & P9_SETATTR_ATIME) {
                atime = now;
            }
            if (req[1] & P9_SETATTR_MTIME) {
                mtime = now;
            }
            // TODO: currently have no way to change CTIME via the Filer API.
            if (req[1] & P9_SETATTR_CTIME) {
                message.Debug('[TODO] requested to SETATTR for CTIME, ignoring');
            }
            // TODO: need to confirm the unit for these times (sec vs nsec).
            if (req[1] & P9_SETATTR_ATIME_SET) {
                atime = req[6] * 1000; // assuming it will be sec, convert to ms
            }
            if (req[1] & P9_SETATTR_MTIME_SET) {
                mtime = req[8]* 1000; // assuming it will be sec, convert to ms
            }

            // TODO: deal with only having one of atime/mtime, currently assuming both
            if(atime || mtime) {
                promises.push(
                    new Promise(function(resolve, reject) {
                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }

                        message.Debug("[setattr]: atime=" + atime + " mtime=" + mtime);

                        fs.utimes(path, atime, mtime, function(err) {
                            if(err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    })
                );
            }

            if (req[1] & P9_SETATTR_SIZE) {
                promises.push(
                    new Promise(function(resolve, reject) {
                        var size = req[5];

                        message.Debug("[setattr]: size=" + size);

                        fs.truncate(path, size, function(err) {
                            if(err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    })
                );
            }
            Promise.all(promises)
                .then(function() {
                    self.BuildReply(id, tag, 0);
                    self.SendReply(bufchain);
                })
                .catch(function(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                })
            break;

        case 50: // fsync
            var req = marshall.Unmarshall(["w", "d"], buffer, state);
            var fid = req[0];
            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;

        case 40: // TREADDIR
            var req = marshall.Unmarshall(["w", "d", "w"], buffer, state);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var path = this.fids[fid].path;
            // Directory entries are represented as variable-length records:
            // qid[13] offset[8] type[1] name[s]
            sh.ls(path, {recursive: false} , function(err, entries) {
                if(self.shouldAbortRequest(tag)) {
                    return;
                }
                
                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                    return;
                }

                // first get size
                var size = entries.reduce(function(currentValue, entry) {
                    return currentValue + 13 + 8 + 1 + 2 + UTF8.UTF8Length(entry.name);
                }, 0);

                // Deal with . and ..
                size += 13 + 8 + 1 + 2 + 1; // "." entry
                size += 13 + 8 + 1 + 2 + 2; // ".." entry
                var data = new Uint8Array(size);

                // Get info for '.'
                fs.stat(path, function(err, stats) {
                    if(self.shouldAbortRequest(tag)) {
                        return;
                    }
                    
                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(bufchain);
                        return;
                    }
                            
                    var dataOffset = 0x0;

                    dataOffset += marshall.Marshall(
                        ["Q", "d", "b", "s"],
                        [
                            formatQid(path, stats), 
                            dataOffset+13+8+1+2+1, 
                            stats.mode >> 12, 
                            "."
                        ],
                        data, dataOffset);
    
                    // Get info for '..'
                    var parentDirPath = Path.resolve("..", path);
                    fs.stat(parentDirPath, function(err, stats) {
                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }
    
                        if(err) {
                            self.SendError(tag, err);
                            self.SendReply(bufchain);
                            return;
                        }
        
                        dataOffset += marshall.Marshall(
                            ["Q", "d", "b", "s"],
                            [
                                formatQid(parentDirPath, stats),
                                dataOffset+13+8+1+2+2, 
                                stats.mode >> 12, 
                                ".."
                            ],
                            data, dataOffset);
    
                        entries.forEach(function(entry) {
                            var entryPath = Path.join(path, entry.name);
                            dataOffset += marshall.Marshall(
                                ["Q", "d", "b", "s"],
                                [
                                    formatQid(entryPath, entry),
                                    dataOffset+13+8+1+2+UTF8.UTF8Length(entry.name),
                                    entry.mode >> 12,
                                    entry.name
                                ],
                                data, dataOffset);
                        });

                        // sometimes seems to break stuff but is in old code? 
                        // as a VERY HACKY fix I have used Math.abs but this definitely should NOT be happening
                        if (size < offset+count) {
                            console.warn("size<offset+count !", "size="+size, "offset="+offset, "count="+count);
                            if(size > offset) {
                                count = size - offset;
                            } else {
                                count = 0;
                            }
                        }
                        if(data) {
                            for(var i=0; i<count; i++)
                                self.replybuffer[7+4+i] = data[offset+i];
                        }

                        marshall.Marshall(["w"], [count], self.replybuffer, 7);
                        self.BuildReply(id, tag, 4 + count);
                        self.SendReply(bufchain);
                    });
                });
            });
            break;
        case 116: // read
            var req = marshall.Unmarshall(["w", "d", "w"], buffer, state);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var path = this.fids[fid].path;

            message.Debug("[read]: fid=" + fid + " offset=" + offset + " count=" + count);

            function _read(data) {
                var size = data.length;

                if(offset + count > size) {
                    count = size - offset;
                }

                for(var i=0; i<count; i++)
                    self.replybuffer[7+4+i] = data[offset+i];

                marshall.Marshall(["w"], [count], self.replybuffer, 7);
                self.BuildReply(id, tag, 4 + count);
                self.SendReply(bufchain);
            }
            
            var data = self.pendingTags[tag].data;

            if(data) {
                _read(data);
                return;
            }

            fs.readFile(path, function(err, data) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain)
                    return;
                }

                self.pendingTags[tag].data = data;
                _read(data);
            });

            break;
        case 118: // write
            var req = marshall.Unmarshall(["w", "d", "w"], buffer, state);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var path = self.fids[fid].path;

            message.Debug("[write]: fid=" + fid + " offset=" + offset + " count=" + count + " fidtype=" + this.fids[fid].type);
            fs.open(path, 'w', function(err, fd){
                if(self.shouldAbortRequest(tag)) {
                    if(fd) fs.close(fd);
                    return;
                }

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                }

                var data = self.Buffer.from(buffer.subarray(state.offset));

                fs.write(fd, data, 0, count, offset, function(err, nbytes) {
                    if(self.shouldAbortRequest(tag)) {
                        if(fd) fs.close(fd);
                        return;
                    }

                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(bufchain);
                    }

                    fs.close(fd);

                    marshall.Marshall(["w"], [nbytes], self.replybuffer, 7);
                    self.BuildReply(id, tag, 4);
                    self.SendReply(bufchain);
                });
            });
            break;

        case 74: // RENAMEAT
            var req = marshall.Unmarshall(["w", "s", "w", "s"], buffer, state);
            var olddirfid = req[0];
            var oldname = req[1];
            var oldPath = Path.join(self.fids[olddirfid].path, oldname);
            var newdirfid = req[2];
            var newname = req[3];
            var newPath = Path.join(self.fids[newdirfid].path, newname);
            message.Debug("[renameat]: oldname=" + oldname + " newname=" + newname);

            fs.rename(oldPath, newPath, function(err) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                }


                self.BuildReply(id, tag, 0);
                self.SendReply(bufchain);
            });

            break;

        case 76: // TUNLINKAT
            var req = marshall.Unmarshall(["w", "s", "w"], buffer, state);
            var dirfd = req[0];
            var name = req[1];
            var flags = req[2];
            var path = Path.join(self.fids[dirfd].path, name);

            message.Debug("[unlink]: dirfd=" + dirfd + " name=" + name + " flags=" + flags);

            fs.stat(path, function(err, stats) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                    return;
                }

                var op = stats.type === 'DIRECTORY' ? 'rmdir' : 'unlink'

                fs[op](path, function (err) {
                    if(self.shouldAbortRequest(tag)) return;

                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(bufchain);
                        return;
                    }

                    self.BuildReply(id, tag, 0);
                    self.SendReply(bufchain);
                });
            });

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
            this.fids[fid] = this.Createfid('/', FID_INODE, uid);
            fs.stat('/', function(err, stats) {
                if(self.shouldAbortRequest(tag)) return;

                if(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                    return;
                }

                var qid = formatQid('/', stats);

                marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
                self.BuildReply(id, tag, 13);
                self.SendReply(bufchain);
                self.bus.send("9p-attach");
            });
            break;

        case 108: // tflush
            var req = marshall.Unmarshall(["h"], buffer, state);
            var oldtag = req[0];
            this.flushTag(oldtag);
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
                this.fids[nwfid] = this.Createfid(this.fids[fid].path, FID_INODE, this.fids[fid].uid);
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
            var path = this.fids[fid].path;

            var offset = 7+2;
            var nwidx = 0;
            
            message.Debug("walk in dir " + this.fids[fid].dbg_name  + " to: " + walk.toString());
            function _walk(path, pathParts) {
                var part = pathParts.shift();

                if(!part) {
                    marshall.Marshall(["h"], [nwidx], self.replybuffer, 7);
                    self.BuildReply(id, tag, offset-7);
                    self.SendReply(bufchain);
                    return;
                }

                path = Path.join(path, part);
                fs.stat(path, function (err, stats) {
                    if(self.shouldAbortRequest(tag)) {
                        return;
                    }

                    if(err) {
                        self.SendError(tag, err);
                        self.SendReply(bufchain);
                        return;
                    }
    
                    var qid = formatQid(path, stats);

                    self.fids[nwfid] = self.Createfid(path, FID_INODE, stats.uid);
                    offset += marshall.Marshall(["Q"], [qid], self.replybuffer, offset);
                    nwidx++;
                    _walk(path, pathParts);
                });
            }
            
            _walk(path, walk);
            break;

        case 120: // clunk
            var req = marshall.Unmarshall(["w"], buffer, state);
            message.Debug("[clunk]: fid=" + req[0]);
            delete self.fids[fid];
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
            this.SendError(tag, {code: "EOPNOTSUPP"});
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
