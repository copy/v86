// -------------------------------------------------
// --------------------- 9P ------------------------
// -------------------------------------------------
// Implementation of the 9p filesystem device following the 
// 9P2000.L protocol ( https://code.google.com/p/diod/wiki/protocol )

"use strict";

// TODO
// flush
// lock?
// correct hard links

var EPERM = 1;       /* Operation not permitted */
var ENOENT = 2;      /* No such file or directory */
var EINVAL = 22;     /* Invalid argument */
var ENOTSUPP = 524;  /* Operation is not supported */
var ENOTEMPTY = 39;  /* Directory not empty */
var EPROTO    = 71   /* Protocol error */

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

var FID_NONE = -1;
var FID_INODE = 1;
var FID_XATTR = 2;

/** 
 * @constructor 
 *
 * @param {FS} filesystem
 */
function Virtio9p(filesystem, bus) {
    /** @const @type {FS} */
    this.fs = filesystem;

    /** @const @type {BusConnector} */
    this.bus = bus;

    this.SendReply = function(x, y) {};
    this.deviceid = 0x9; // 9p filesystem
    this.hostfeature = 0x1; // mountpoint
    //this.configspace = [0x0, 0x4, 0x68, 0x6F, 0x73, 0x74]; // length of string and "host" string
    //this.configspace = [0x0, 0x9, 0x2F, 0x64, 0x65, 0x76, 0x2F, 0x72, 0x6F, 0x6F, 0x74 ]; // length of string and "/dev/root" string

    this.configspace = new Uint8Array([0x6, 0x0, 0x68, 0x6F, 0x73, 0x74, 0x39, 0x70]); // length of string and "host9p" string
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

    state[0] = this.deviceid;
    state[1] = this.hostfeature;
    state[2] = this.configspace;
    state[3] = this.VERSION;
    state[4] = this.BLOCKSIZE;
    state[5] = this.msize;
    state[6] = this.replybuffer;
    state[7] = this.replybuffersize;
    state[8] = this.fids.map(function(f) { return [f.inodeid, f.type, f.uid] });

    return state;
};

Virtio9p.prototype.set_state = function(state)
{
    this.deviceid = state[0];
    this.hostfeature = state[1];
    this.configspace = state[2];
    this.VERSION = state[3];
    this.BLOCKSIZE = state[4];
    this.msize = state[5];
    this.replybuffer = state[6];
    this.replybuffersize = state[7];
    this.fids = state[8].map(function(f) { return { inodeid: f[0], type: f[1], uid: f[2] } });
};

Virtio9p.prototype.Createfid = function(inode, type, uid) {
    return {inodeid: inode, type: type, uid: uid};
}

Virtio9p.prototype.Reset = function() {
    this.fids = [];
}


Virtio9p.prototype.BuildReply = function(id, tag, payloadsize) {
    marshall.Marshall(["w", "b", "h"], [payloadsize+7, id+1, tag], this.replybuffer, 0);
    if ((payloadsize+7) >= this.replybuffer.length) {
        message.Debug("Error in 9p: payloadsize exceeds maximum length");
    }
    //for(var i=0; i<payload.length; i++)
    //    this.replybuffer[7+i] = payload[i];
    this.replybuffersize = payloadsize+7;
    return;
}

Virtio9p.prototype.SendError = function (tag, errormsg, errorcode) {
    //var size = marshall.Marshall(["s", "w"], [errormsg, errorcode], this.replybuffer, 7);
    var size = marshall.Marshall(["w"], [errorcode], this.replybuffer, 7);
    this.BuildReply(6, tag, size);
}

Virtio9p.prototype.ReceiveRequest = function (index, GetByte) {
    var header = marshall.Unmarshall2(["w", "b", "h"], GetByte);
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
            req[5] = this.fs.inodes.length; // total number of inodes
            req[6] = 1024*1024;
            req[7] = 0; // file system id?
            req[8] = 256; // maximum length of filenames

            size = marshall.Marshall(["w", "w", "d", "d", "d", "d", "d", "d", "w"], req, this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(0, index);
            break;

        case 112: // topen
        case 12: // tlopen
            var req = marshall.Unmarshall2(["w", "w"], GetByte);
            var fid = req[0];
            var mode = req[1];
            message.Debug("[open] fid=" + fid + ", mode=" + mode);
            var idx = this.fids[fid].inodeid;
            var inode = this.fs.GetInode(idx);
            message.Debug("file open " + inode.name);
            //if (inode.status == STATUS_LOADING) return;
            var ret = this.fs.OpenInode(idx, mode);

            this.fs.AddEvent(this.fids[fid].inodeid,
                function() {
                    message.Debug("file opened " + inode.name + " tag:"+tag);
                    req[0] = inode.qid;
                    req[1] = this.msize - 24;
                    marshall.Marshall(["Q", "w"], req, this.replybuffer, 7);
                    this.BuildReply(id, tag, 13+4);
                    this.SendReply(0, index);
                }.bind(this)
            );
            break;

        case 70: // link (just copying)
            var req = marshall.Unmarshall2(["w", "w", "s"], GetByte);
            var dfid = req[0];
            var fid = req[1];
            var name = req[2];
            message.Debug("[link] dfid=" + dfid + ", name=" + name);
            var inode = this.fs.CreateInode();
            var inodetarget = this.fs.GetInode(this.fids[fid].inodeid);
            var targetdata = this.fs.inodedata[this.fids[fid].inodeid];
            //inode = inodetarget;
            inode.mode = inodetarget.mode;
            inode.size = inodetarget.size;
            inode.symlink = inodetarget.symlink;
            var data = this.fs.inodedata[this.fs.inodes.length] = new Uint8Array(inode.size);
            for(var i=0; i<inode.size; i++) {
                data[i] = targetdata[i];
            }
            inode.name = name;
            inode.parentid = this.fids[dfid].inodeid;
            this.fs.PushInode(inode);
            
            //inode.uid = inodetarget.uid;
            //inode.gid = inodetarget.gid;
            //inode.mode = inodetarget.mode | S_IFLNK;
            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);       
            break;

        case 16: // symlink
            var req = marshall.Unmarshall2(["w", "s", "s", "w"], GetByte);
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
            this.SendReply(0, index);
            break;

        case 18: // mknod
            var req = marshall.Unmarshall2(["w", "s", "w", "w", "w", "w"], GetByte);
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
            this.SendReply(0, index);
            break;


        case 22: // TREADLINK
            var req = marshall.Unmarshall2(["w"], GetByte);
            var fid = req[0];
            message.Debug("[readlink] fid=" + fid);
            var inode = this.fs.GetInode(this.fids[fid].inodeid);
            size = marshall.Marshall(["s"], [inode.symlink], this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(0, index);
            break;


        case 72: // tmkdir
            var req = marshall.Unmarshall2(["w", "s", "w", "w"], GetByte);
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
            this.SendReply(0, index);
            break;

        case 14: // tlcreate
            var req = marshall.Unmarshall2(["w", "s", "w", "w", "w"], GetByte);
            var fid = req[0];
            var name = req[1];
            var flags = req[2];
            var mode = req[3];
            var gid = req[4];
            message.Debug("[create] fid=" + fid + ", name=" + name + ", flags=" + flags + ", mode=" + mode + ", gid=" + gid); 
            var idx = this.fs.CreateFile(name, this.fids[fid].inodeid);
            this.fids[fid].inodeid = idx;
            this.fids[fid].type = FID_INODE;
            var inode = this.fs.GetInode(idx);
            inode.uid = this.fids[fid].uid;
            inode.gid = gid;
            inode.mode = mode;
            marshall.Marshall(["Q", "w"], [inode.qid, this.msize - 24], this.replybuffer, 7);
            this.BuildReply(id, tag, 13+4);
            this.SendReply(0, index);
            break;

        case 52: // lock always suceed
            message.Debug("lock file\n");
            marshall.Marshall(["w"], [0], this.replybuffer, 7);
            this.BuildReply(id, tag, 1);
            this.SendReply(0, index);
            break;

        /*
        case 54: // getlock
            break;        
        */

        case 24: // getattr
            var req = marshall.Unmarshall2(["w", "d"], GetByte);
            var fid = req[0];
            var inode = this.fs.GetInode(this.fids[fid].inodeid);
            message.Debug("[getattr]: fid=" + fid + " name=" + inode.name + " request mask=" + req[1]);
            if(!inode || inode.status === STATUS_UNLINKED)
            {
                message.Debug("getattr: unlinked");
                this.SendError(tag, "No such file or directory", ENOENT);
                this.SendReply(0, index);
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
            req[9] = Math.floor(inode.size/512+1);; // blk size low
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
            this.SendReply(0, index);
            break;

        case 26: // setattr
            var req = marshall.Unmarshall2(["w", "w", 
                "w", // mode 
                "w", "w", // uid, gid
                "d", // size
                "d", "d", // atime
                "d", "d"] // mtime
            , GetByte);
            var fid = req[0];
            var inode = this.fs.GetInode(this.fids[fid].inodeid);
            message.Debug("[setattr]: fid=" + fid + " request mask=" + req[1] + " name=" +inode.name);
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
                this.fs.ChangeSize(this.fids[fid].inodeid, req[5]);
            }
            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);
            break;

        case 50: // fsync
            var req = marshall.Unmarshall2(["w", "d"], GetByte);
            var fid = req[0];
            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);
            break;

        case 40: // TREADDIR
        case 116: // read
            var req = marshall.Unmarshall2(["w", "d", "w"], GetByte);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var inode = this.fs.GetInode(this.fids[fid].inodeid);
            if (id == 40) message.Debug("[treaddir]: fid=" + fid + " offset=" + offset + " count=" + count);
            if (id == 116) message.Debug("[read]: fid=" + fid + " (" + inode.name + ") offset=" + offset + " count=" + count + " fidtype=" + this.fids[fid].type);
            if(!inode || inode.status === STATUS_UNLINKED)
            {
                message.Debug("read/treaddir: unlinked");
                this.SendError(tag, "No such file or directory", ENOENT);
                this.SendReply(0, index);
                break;
            }
            if (this.fids[fid].type == FID_XATTR) {
                if (inode.caps.length < offset+count) count = inode.caps.length - offset;
                for(var i=0; i<count; i++)
                    this.replybuffer[7+4+i] = inode.caps[offset+i];
                marshall.Marshall(["w"], [count], this.replybuffer, 7);
                this.BuildReply(id, tag, 4 + count);
                this.SendReply(0, index);
            } else {
                var file = this.fs.inodes[this.fids[fid].inodeid];
                this.bus.send("9p-read-start");

                this.fs.OpenInode(this.fids[fid].inodeid, undefined);
                this.fs.AddEvent(this.fids[fid].inodeid,
                    function() {
                        this.bus.send("9p-read-end", [file.name, count]);

                        if (inode.size < offset+count) count = inode.size - offset;
                        var data = this.fs.inodedata[this.fids[fid].inodeid];
                        if(data) {
                            for(var i=0; i<count; i++)
                                this.replybuffer[7+4+i] = data[offset+i];
                        }
                        marshall.Marshall(["w"], [count], this.replybuffer, 7);
                        this.BuildReply(id, tag, 4 + count);
                        this.SendReply(0, index);
                    }.bind(this)
                );
            }
            break;

        case 118: // write
            var req = marshall.Unmarshall2(["w", "d", "w"], GetByte);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            message.Debug("[write]: fid=" + fid + " (" + this.fs.inodes[this.fids[fid].inodeid].name + ") offset=" + offset + " count=" + count);
            this.fs.Write(this.fids[fid].inodeid, offset, count, GetByte);

            var file = this.fs.inodes[this.fids[fid].inodeid];
            this.bus.send("9p-write-end", [file.name, count]);

            marshall.Marshall(["w"], [count], this.replybuffer, 7);
            this.BuildReply(id, tag, 4);
            this.SendReply(0, index);
            break;

        case 74: // RENAMEAT
            var req = marshall.Unmarshall2(["w", "s", "w", "s"], GetByte);
            var olddirfid = req[0];
            var oldname = req[1];
            var newdirfid = req[2];
            var newname = req[3];
            message.Debug("[renameat]: oldname=" + oldname + " newname=" + newname);
            var ret = this.fs.Rename(this.fids[olddirfid].inodeid, oldname, this.fids[newdirfid].inodeid, newname);
            if (ret == false) {
                this.SendError(tag, "No such file or directory", ENOENT);                   
                this.SendReply(0, index);
                break;
            }
            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);
            break;

        case 76: // TUNLINKAT
            var req = marshall.Unmarshall2(["w", "s", "w"], GetByte);
            var dirfd = req[0];
            var name = req[1];
            var flags = req[2];
            message.Debug("[unlink]: dirfd=" + dirfd + " name=" + name + " flags=" + flags);
            var fid = this.fs.Search(this.fids[dirfd].inodeid, name);
            if (fid == -1) {
                   this.SendError(tag, "No such file or directory", ENOENT);
                   this.SendReply(0, index);
                   break;
            }
            var ret = this.fs.Unlink(fid);
            if (!ret) {
                this.SendError(tag, "Directory not empty", ENOTEMPTY);
                this.SendReply(0, index);
                break;
            }
            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);
            break;

        case 100: // version
            var version = marshall.Unmarshall2(["w", "s"], GetByte);
            message.Debug("[version]: msize=" + version[0] + " version=" + version[1]);
            this.msize = version[0];
            size = marshall.Marshall(["w", "s"], [this.msize, this.VERSION], this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(0, index);
            break;

        case 104: // attach
            // return root directorie's QID
            var req = marshall.Unmarshall2(["w", "w", "s", "s", "w"], GetByte);
            var fid = req[0];
            var uid = req[4];
            message.Debug("[attach]: fid=" + fid + " afid=" + hex8(req[1]) + " uname=" + req[2] + " aname=" + req[3]);
            this.fids[fid] = this.Createfid(0, FID_INODE, uid);
            var inode = this.fs.GetInode(this.fids[fid].inodeid);
            marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
            this.BuildReply(id, tag, 13);
            this.SendReply(0, index);
            break;

        case 108: // tflush
            var req = marshall.Unmarshall2(["h"], GetByte);
            var oldtag = req[0];
            message.Debug("[flush] " + tag);
            //marshall.Marshall(["Q"], [inode.qid], this.replybuffer, 7);
            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);
            break;


        case 110: // walk
            var req = marshall.Unmarshall2(["w", "w", "h"], GetByte);
            var fid = req[0];
            var nwfid = req[1];
            var nwname = req[2];
            message.Debug("[walk]: fid=" + req[0] + " nwfid=" + req[1] + " nwname=" + nwname);
            if (nwname == 0) {
                this.fids[nwfid] = this.Createfid(this.fids[fid].inodeid, FID_INODE, this.fids[fid].uid);
                //this.fids[nwfid].inodeid = this.fids[fid].inodeid;
                marshall.Marshall(["h"], [0], this.replybuffer, 7);
                this.BuildReply(id, tag, 2);
                this.SendReply(0, index);
                break;
            }
            var wnames = [];
            for(var i=0; i<nwname; i++) {
                wnames.push("s");
            }
            var walk = marshall.Unmarshall2(wnames, GetByte);
            var idx = this.fids[fid].inodeid;
            var offset = 7+2;
            var nwidx = 0;
            //console.log(idx, this.fs.inodes[idx]);
            message.Debug("walk in dir " + this.fs.inodes[idx].name  + " to: " + walk.toString());
            for(var i=0; i<nwname; i++) {
                idx = this.fs.Search(idx, walk[i]);

                if (idx == -1) {
                   message.Debug("Could not find: " + walk[i]);
                   break;
                }
                offset += marshall.Marshall(["Q"], [this.fs.inodes[idx].qid], this.replybuffer, offset);
                nwidx++;
                //message.Debug(this.fids[nwfid].inodeid);
                //this.fids[nwfid].inodeid = idx;
                //this.fids[nwfid].type = FID_INODE;
                this.fids[nwfid] = this.Createfid(idx, FID_INODE, this.fids[fid].uid);
            }
            marshall.Marshall(["h"], [nwidx], this.replybuffer, 7);
            this.BuildReply(id, tag, offset-7);
            this.SendReply(0, index);
            break;

        case 120: // clunk
            var req = marshall.Unmarshall2(["w"], GetByte);
            message.Debug("[clunk]: fid=" + req[0]);
            if (this.fids[req[0]] && this.fids[req[0]].inodeid >=  0) {
                this.fs.CloseInode(this.fids[req[0]].inodeid);
                this.fids[req[0]].inodeid = -1;
                this.fids[req[0]].type = FID_NONE;
            }
            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);
            break;

        case 32: // txattrcreate
            var req = marshall.Unmarshall2(["w", "s", "d", "w"], GetByte);
            var fid = req[0];
            var name = req[1];
            var attr_size = req[2];
            var flags = req[3];
            message.Debug("[txattrcreate]: fid=" + fid + " name=" + name + " attr_size=" + attr_size + " flags=" + flags);
            this.BuildReply(id, tag, 0);
            this.SendReply(0, index);
            //this.SendError(tag, "Operation i not supported",  EINVAL);
            //this.SendReply(0, index);
            break;

        case 30: // xattrwalk
            var req = marshall.Unmarshall2(["w", "w", "s"], GetByte);
            var fid = req[0];
            var newfid = req[1];
            var name = req[2];
            message.Debug("[xattrwalk]: fid=" + req[0] + " newfid=" + req[1] + " name=" + req[2]);
            this.fids[newfid] = this.Createfid(this.fids[fid].inodeid, FID_NONE, this.fids[fid].uid);
            //this.fids[newfid].inodeid = this.fids[fid].inodeid;
            //this.fids[newfid].type = FID_NONE;
            var length = 0;
            if (name == "security.capability") {
                length = this.fs.PrepareCAPs(this.fids[fid].inodeid);
                this.fids[newfid].type = FID_XATTR;
            }
            marshall.Marshall(["d"], [length], this.replybuffer, 7);
            this.BuildReply(id, tag, 8);
            this.SendReply(0, index);
            break;

        default:
            message.Debug("Error in Virtio9p: Unknown id " + id + " received");
            message.Abort();
            //this.SendError(tag, "Operation i not supported",  ENOTSUPP);
            //this.SendReply(0, index);
            break;
    }

    //consistency checks if there are problems with the filesystem
    //this.fs.Check();
}
