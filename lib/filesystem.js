// -------------------------------------------------
// ----------------- FILESYSTEM---------------------
// -------------------------------------------------
// Implementation of a unix filesystem in memory.

"use strict";

var S_IRWXUGO = 0x1FF;
var S_IFMT = 0xF000;
var S_IFSOCK = 0xC000;
var S_IFLNK = 0xA000;
var S_IFREG = 0x8000;
var S_IFBLK = 0x6000;
var S_IFDIR = 0x4000;
var S_IFCHR = 0x2000;

//var S_IFIFO  0010000
//var S_ISUID  0004000
//var S_ISGID  0002000
//var S_ISVTX  0001000

var O_RDONLY = 0x0000; // open for reading only
var O_WRONLY = 0x0001; // open for writing only
var O_RDWR = 0x0002; // open for reading and writing
var O_ACCMODE = 0x0003; // mask for above modes

var STATUS_INVALID = -0x1;
var STATUS_OK = 0x0;
var STATUS_ON_SERVER = 0x2;
var STATUS_LOADING = 0x3;
var STATUS_UNLINKED = 0x4;
var STATUS_FORWARDING = 0x5;


/** @const */ var JSONFS_VERSION = 2;


/** @const */ var JSONFS_IDX_NAME = 0;
/** @const */ var JSONFS_IDX_SIZE = 1;
/** @const */ var JSONFS_IDX_MTIME = 2;
/** @const */ var JSONFS_IDX_MODE = 3;
/** @const */ var JSONFS_IDX_UID = 4;
/** @const */ var JSONFS_IDX_GID = 5;
/** @const */ var JSONFS_IDX_TARGET = 6;


/** @constructor */
function FS(baseurl) {
    /** @type {Array.<Inode>} */
    this.inodes = [];
    this.events = [];

    this.baseurl = baseurl;

    this.filesinloadingqueue = 0;
    this.OnLoaded = function() {};

    //this.tar = new TAR(this);

    this.inodedata = {};

    this.total_size = 256 * 1024 * 1024 * 1024;
    this.used_size = 0;

    /** @type {!Array<!FSMountInfo>} */
    this.mounts = [];

    //RegisterMessage("LoadFilesystem", this.LoadFilesystem.bind(this) );
    //RegisterMessage("MergeFile", this.MergeFile.bind(this) );
    //RegisterMessage("tar",
    //    function(data) {
    //        SendToMaster("tar", this.tar.Pack(data));
    //    }.bind(this)
    //);
    //RegisterMessage("sync",
    //    function(data) {
    //        SendToMaster("sync", this.tar.Pack(data));
    //    }.bind(this)
    //);

    // root entry
    this.CreateDirectory("", -1);
}

FS.last_qidnumber = 0;

FS.prototype.get_state = function()
{
    const state = [];

    state[0] = this.inodes;
    state[1] = FS.last_qidnumber;
    state[2] = [];
    for(let entry of Object.entries(this.inodedata))
    {
        state[2].push(entry);
    }
    state[3] = this.total_size;
    state[4] = this.used_size;
    state[5] = this.baseurl;
    state[6] = this.mounts.map(mnt => mnt.fs);

    return state;
};

FS.prototype.set_state = function(state)
{
    this.inodes = state[0].map(state => { const inode = new Inode(0); inode.set_state(state); return inode; });
    FS.last_qidnumber = state[1];
    this.inodedata = {};
    for(let [key, value] of state[2])
    {
        if(value.buffer.byteLength !== value.byteLength)
        {
            // make a copy if we didn't get one
            value = value.slice();
        }

        this.inodedata[key] = value;
    }
    this.total_size = state[3];
    this.used_size = state[4];
    this.baseurl = state[5];
    this.mounts = [];
    for(const mount_state of state[6])
    {
        const mount = new FSMountInfo(null);
        mount.set_state(mount_state);
        this.mounts.push(mount);
    }
};


// -----------------------------------------------------

FS.prototype.AddEvent = function(id, OnEvent) {
    var inode = this.GetInode(id);
    if (inode.status == STATUS_OK) {
        OnEvent();
        return;
    }
    this.events.push({id: id, OnEvent: OnEvent});
};

FS.prototype.HandleEvent = function(id) {

    if (this.filesinloadingqueue == 0) {
        this.OnLoaded();
        this.OnLoaded = function() {};
    }
    //message.Debug("number of events: " + this.events.length);
    var newevents = [];
    for(var i=0; i<this.events.length; i++) {
        if (this.events[i].id == id) {
            this.events[i].OnEvent();
        } else {
            newevents.push(this.events[i]);
        }
    }
    this.events = newevents;
};

FS.prototype.OnJSONLoaded = function(fs)
{
    if(DEBUG)
    {
        console.assert(fs, "Invalid fs passed to OnJSONLoaded");
    }

    //console.time("parse");
    var fsdata = JSON.parse(fs);
    //console.timeEnd("parse");

    if(fsdata["version"] !== JSONFS_VERSION)
    {
        throw "The filesystem JSON format has changed. " +
              "Please update your fs2json (https://github.com/copy/fs2json) and recreate the filesystem JSON.";
    }

    var fsroot = fsdata["fsroot"];
    this.used_size = fsdata["size"];

    var me = this;

    setTimeout(function()
    {
        //console.time("Load");
        //console.profile("Load");
        for(var i = 0; i < fsroot.length; i++) {
            me.LoadRecursive(fsroot[i], 0);
        }
        //console.profileEnd("Load");
        //console.timeEnd("Load");

        //if(DEBUG)
        //{
        //    console.time("Check");
        //    me.Check();
        //    console.timeEnd("Check");
        //}

        me.OnLoaded();
        me.OnLoaded = function() {};
    }, 0);
};

FS.prototype.LoadRecursive = function(data, parentid)
{
    var inode = this.CreateInode();

    inode.name = data[JSONFS_IDX_NAME];
    inode.size = data[JSONFS_IDX_SIZE];
    inode.mtime = data[JSONFS_IDX_MTIME];
    inode.ctime = inode.mtime;
    inode.atime = inode.mtime;
    inode.mode = data[JSONFS_IDX_MODE];
    inode.uid = data[JSONFS_IDX_UID];
    inode.gid = data[JSONFS_IDX_GID];

    inode.parentid = parentid;

    this.inodes[parentid].nlinks++;

    var ifmt = inode.mode & S_IFMT;

    if(ifmt === S_IFDIR)
    {
        inode.nlinks = 2; // . and ..
        this.LoadDir(inode, data[JSONFS_IDX_TARGET]);
    }
    else if(ifmt === S_IFREG)
    {
        inode.status = STATUS_ON_SERVER;
        this.PushInode(inode);
    }
    else if(ifmt === S_IFLNK)
    {
        inode.symlink = data[JSONFS_IDX_TARGET];
        this.PushInode(inode);
    }
    else if(ifmt === S_IFSOCK)
    {
        // socket: ignore
    }
    else
    {
        dbg_log("Unexpected ifmt: " + h(ifmt) + " (" + inode.name + ")");
    }
};

FS.prototype.LoadDir = function(inode, children)
{
    inode.updatedir = true;

    var p = this.inodes.length;
    this.PushInode(inode);

    for(var i = 0; i < children.length; i++) {
        this.LoadRecursive(children[i], p);
    }
};

// Loads the data from a url for a specific inode
FS.prototype.LoadFile = function(idx) {
    var inode = this.inodes[idx];
    if (inode.status != STATUS_ON_SERVER) {
        return;
    }
    inode.status = STATUS_LOADING;
    this.filesinloadingqueue++;

    //if (inode.compressed) {
    //    inode.data = new Uint8Array(inode.size);
    //    LoadBinaryResource(inode.url + ".bz2",
    //    function(buffer){
    //        var buffer8 = new Uint8Array(buffer);
    //        var ofs = 0;
    //        bzip2.simple(buffer8, function(x){inode.data[ofs++] = x;}.bind(this) );
    //        inode.status = STATUS_OK;
    //        this.filesinloadingqueue--;
    //        this.HandleEvent(idx);
    //    }.bind(this),
    //    function(error){throw error;});
    //    return;
    //}

    if(this.baseurl)
    {
        LoadBinaryResource(this.baseurl + this.GetFullPath(inode.fid),
            function(buffer){
                var data = this.inodedata[idx] = new Uint8Array(buffer);
                inode.size = data.length; // correct size if the previous was wrong.
                inode.status = STATUS_OK;

                this.filesinloadingqueue--;
                this.HandleEvent(idx);
            }.bind(this),
            function(error){throw error;});
    }
    else
    {
        // If baseurl is not set, we started with an empty filesystem. No files
        // can be loaded
    }
};

// -----------------------------------------------------

/**
 * Non-root forwarders are not linked locally, or else we need to synchronise with the
 * corresponding mounted filesystems.
 * @private
 * @return {boolean}
 */
FS.prototype.should_be_linked = function(inode)
{
    return !this.is_forwarder(inode) || this.is_root_forwarder(inode);
};

FS.prototype.PushInode = function(inode) {
    if (inode.parentid != -1) {
        this.inodes.push(inode);
        inode.fid = this.inodes.length - 1;
        var parent_node = this.inodes[inode.parentid];
        parent_node.updatedir = true;
        inode.nextid = parent_node.firstid;
        parent_node.firstid = this.inodes.length-1;
        return;
    } else {
        if (this.inodes.length == 0) { // if root directory
            this.inodes.push(inode);
            return;
        }
    }

    message.Debug("Error in Filesystem: Pushed inode with name = "+ inode.name + " has no parent");
    message.Abort();

};

/** @constructor */
function Inode(qidnumber)
{
    this.updatedir = false; // did the directory listing changed?
    this.parentid = -1;
    this.firstid = -1; // first file id in directory
    this.nextid = -1; // next id in directory
    this.status = 0;
    this.name = "";
    this.size = 0x0;
    this.uid = 0x0;
    this.gid = 0x0;
    this.fid = 0;
    this.ctime = 0;
    this.atime = 0;
    this.mtime = 0;
    this.major = 0x0;
    this.minor = 0x0;
    this.symlink = "";
    this.mode = 0x01ED;
    this.qid = {
        type: 0,
        version: 0,
        path: qidnumber,
    };
    this.caps = undefined;
    this.nlinks = 1;
    this.dirty = false; // has this file changed?

    // For forwarders:
    this.mount_id = -1; // which fs in this.mounts does this inode forward to?
    this.foreign_id = -1; // which foreign inode id does it represent?

    //this.qid_type = 0;
    //this.qid_version = 0;
    //this.qid_path = qidnumber;
}

Inode.prototype.get_state = function()
{
    const state = [];
    state[0] = this.updatedir;
    state[1] = this.parentid;
    state[2] = this.firstid;
    state[3] = this.nextid;
    state[4] = this.status;
    state[5] = this.name;
    state[6] = this.size;
    state[7] = this.uid;
    state[8] = this.gid;
    state[9] = this.fid;
    state[10] = this.ctime;
    state[11] = this.atime;
    state[12] = this.mtime;
    state[13] = this.major;
    state[14] = this.minor;
    state[15] = this.symlink;
    state[16] = this.mode;
    state[17] = this.qid.type;
    state[18] = this.qid.version;
    state[19] = this.qid.path;
    state[20] = this.caps;
    state[21] = this.nlinks;
    state[22] = this.dirty;
    state[23] = this.mount_id;
    state[24] = this.foreign_id;
    return state;
};

Inode.prototype.set_state = function(state)
{
    this.updatedir = state[0];
    this.parentid = state[1];
    this.firstid = state[2];
    this.nextid = state[3];
    this.status = state[4];
    this.name = state[5];
    this.size = state[6];
    this.uid = state[7];
    this.gid = state[8];
    this.fid = state[9];
    this.ctime = state[10];
    this.atime = state[11];
    this.mtime = state[12];
    this.major = state[13];
    this.minor = state[14];
    this.symlink = state[15];
    this.mode = state[16];
    this.qid.type = state[17];
    this.qid.version = state[18];
    this.qid.path = state[19];
    this.caps = state[20];
    this.nlinks = state[21];
    this.dirty = state[22];
    this.mount_id = state[23];
    this.foreign_id = state[24];
};

FS.prototype.CreateInode = function() {
    //console.log("CreateInode", Error().stack);
    const now = Math.round(Date.now() / 1000);
    const inode = new Inode(++FS.last_qidnumber);
    inode.atime = inode.ctime = inode.mtime = now;
    return inode;
};


FS.prototype.CreateDirectory = function(name, parentid) {
    var x = this.CreateInode();
    x.name = name;
    x.parentid = parentid;
    x.mode = 0x01FF | S_IFDIR;
    x.updatedir = true;
    x.nlinks = 2; // . and ..
    if (parentid >= 0) {
        x.uid = this.inodes[parentid].uid;
        x.gid = this.inodes[parentid].gid;
        x.mode = (this.inodes[parentid].mode & 0x1FF) | S_IFDIR;
        this.inodes[parentid].nlinks++;
    }
    x.qid.type = S_IFDIR >> 8;
    this.PushInode(x);
    this.NotifyListeners(this.inodes.length-1, 'newdir');
    return this.inodes.length-1;
};

FS.prototype.CreateFile = function(filename, parentid) {
    var x = this.CreateInode();
    x.dirty = true;
    x.name = filename;
    x.parentid = parentid;
    x.uid = this.inodes[parentid].uid;
    x.gid = this.inodes[parentid].gid;
    this.inodes[parentid].nlinks++;
    x.qid.type = S_IFREG >> 8;
    x.mode = (this.inodes[parentid].mode & 0x1B6) | S_IFREG;
    this.PushInode(x);
    this.NotifyListeners(this.inodes.length-1, 'newfile');
    return this.inodes.length-1;
};


FS.prototype.CreateNode = function(filename, parentid, major, minor) {
    var x = this.CreateInode();
    x.name = filename;
    x.parentid = parentid;
    x.major = major;
    x.minor = minor;
    x.uid = this.inodes[parentid].uid;
    x.gid = this.inodes[parentid].gid;
    this.inodes[parentid].nlinks++;
    x.qid.type = S_IFSOCK >> 8;
    x.mode = (this.inodes[parentid].mode & 0x1B6);
    this.PushInode(x);
    return this.inodes.length-1;
};

FS.prototype.CreateSymlink = function(filename, parentid, symlink) {
    var x = this.CreateInode();
    x.name = filename;
    x.parentid = parentid;
    x.uid = this.inodes[parentid].uid;
    x.gid = this.inodes[parentid].gid;
    this.inodes[parentid].nlinks++;
    x.qid.type = S_IFLNK >> 8;
    x.symlink = symlink;
    x.mode = S_IFLNK;
    this.PushInode(x);
    return this.inodes.length-1;
};

FS.prototype.CreateTextFile = function(filename, parentid, str) {
    var id = this.CreateFile(filename, parentid);
    var x = this.inodes[id];
    var data = this.inodedata[id] = new Uint8Array(str.length);
    x.dirty = true;
    x.size = str.length;
    for (var j = 0; j < str.length; j++) {
        data[j] = str.charCodeAt(j);
    }
    return id;
};

/**
 * @param {Uint8Array} buffer
 */
FS.prototype.CreateBinaryFile = function(filename, parentid, buffer) {
    var id = this.CreateFile(filename, parentid);
    var x = this.inodes[id];
    var data = this.inodedata[id] = new Uint8Array(buffer.length);
    x.dirty = true;
    data.set(buffer);
    x.size = buffer.length;
    return id;
};


FS.prototype.OpenInode = function(id, mode) {
    var inode = this.GetInode(id);
    if ((inode.mode&S_IFMT) == S_IFDIR) {
        this.FillDirectory(id);
    }
    /*
    var type = "";
    switch(inode.mode&S_IFMT) {
        case S_IFREG: type = "File"; break;
        case S_IFBLK: type = "Block Device"; break;
        case S_IFDIR: type = "Directory"; break;
        case S_IFCHR: type = "Character Device"; break;
    }
    */
    //message.Debug("open:" + this.GetFullPath(id) +  " type: " + inode.mode + " status:" + inode.status);
    if (inode.status == STATUS_ON_SERVER) {
        this.LoadFile(id);
        return false;
    }
    return true;
};

FS.prototype.CloseInode = function(id) {
    //message.Debug("close: " + this.GetFullPath(id));
    var inode = this.GetInode(id);
    if (inode.status == STATUS_UNLINKED) {
        //message.Debug("Filesystem: Delete unlinked file");
        inode.status = STATUS_INVALID;
        delete this.inodedata[id];
        inode.size = 0;
    }
};

FS.prototype.Rename = function(olddirid, oldname, newdirid, newname) {
    // message.Debug("Rename " + oldname + " to " + newname);
    if ((olddirid == newdirid) && (oldname == newname)) {
        return true;
    }
    var oldid = this.Search(olddirid, oldname);
    var oldpath = this.GetFullPath(oldid);
    if (oldid == -1) {
        return false;
    }
    var newid = this.Search(newdirid, newname);
    if (newid != -1) {
        this.Unlink(newid);
    }

    var idx = oldid; // idx contains the id which we want to rename
    var inode = this.inodes[idx];

    // remove inode ids
    if (this.inodes[inode.parentid].firstid == idx) {
        this.inodes[inode.parentid].firstid = inode.nextid;
    } else {
        var id = this.FindPreviousID(idx);
        if (id == -1) {
            message.Debug("Error in Filesystem: Cannot find previous id of inode");
            message.Abort();
        }
        this.inodes[id].nextid = inode.nextid;
    }

    inode.parentid = newdirid;
    inode.name = newname;
    inode.qid.version++;

    inode.nextid = this.inodes[inode.parentid].firstid;
    this.inodes[inode.parentid].firstid = idx;

    this.inodes[olddirid].updatedir = true;
    this.inodes[newdirid].updatedir = true;
    this.inodes[olddirid].nlinks--;
    this.inodes[newdirid].nlinks++;

    this.NotifyListeners(idx, "rename", {oldpath: oldpath});

    return true;
};

FS.prototype.Write = function(id, offset, count, buffer) {
    this.NotifyListeners(id, 'write');
    var inode = this.inodes[id];
    inode.dirty = true;
    var data = this.inodedata[id];

    if (!data || data.length < (offset+count)) {
        this.ChangeSize(id, Math.floor(((offset+count)*3)/2) );
        inode.size = offset + count;
        data = this.inodedata[id];
    } else
    if (inode.size < (offset+count)) {
        inode.size = offset + count;
    }
    data.set(buffer.subarray(0, count), offset);
};

FS.prototype.Read = function(inodeid, offset, count)
{
    if(!this.inodedata[inodeid])
    {
        return null;
    }
    else
    {
        return this.inodedata[inodeid].subarray(offset, offset + count);
    }
};

FS.prototype.Search = function(parentid, name) {
    const parent_inode = this.inodes[parentid];

    if(this.is_forwarder(parent_inode))
    {
        const foreign_parentid = parent_inode.foreign_id;
        const foreign_id = this.follow_fs(parent_inode).Search(foreign_parentid, name);
        if(foreign_id === -1) return -1;
        return this.get_forwarder(parent_inode.mount_id, foreign_id);
    }

    var id = parent_inode.firstid;
    while(id != -1) {
        dbg_assert(this.GetParent(id) === parentid,
            "Error in Filesystem: Found inode (" + this.inodes[id].name + ") with wrong parent id. " +
            "Expected: " + parentid + ", Actual: " + this.GetParent(id));
        if (this.inodes[id].name == name) return id;
        id = this.inodes[id].nextid;
    }
    return -1;
};

FS.prototype.CountUsedInodes = function()
{
    return this.inodes.length;
};

FS.prototype.CountFreeInodes = function()
{
    return 1024 * 1024;
};

FS.prototype.GetTotalSize = function() {
    return this.used_size;
    //var size = 0;
    //for(var i=0; i<this.inodes.length; i++) {
    //    var d = this.inodes[i].data;
    //    size += d ? d.length : 0;
    //}
    //return size;
};

FS.prototype.GetSpace = function() {
    return this.total_size;
};

FS.prototype.GetFullPath = function(idx) {
    var path = "";

    while(idx != 0) {
        path = "/" + this.inodes[idx].name + path;
        idx = this.inodes[idx].parentid;
    }
    return path.substring(1);
};

// no double linked list. So, we need this
FS.prototype.FindPreviousID = function(idx) {
    var inode = this.GetInode(idx);
    var id = this.inodes[inode.parentid].firstid;
    while(id != -1) {
        if (this.inodes[id].nextid == idx) return id;
        id = this.inodes[id].nextid;
    }
    return id;
};

// XXX: just copying
FS.prototype.Link = function(targetid, name, parentid)
{
    var inode = this.CreateInode();
    var inodetarget = this.GetInode(targetid);
    const targetdata = this.Read(targetid, 0, inodetarget.size);
    //inode = inodetarget;
    inode.dirty = true;
    inode.mode = inodetarget.mode;
    inode.size = inodetarget.size;
    inode.symlink = inodetarget.symlink;
    var data = this.inodedata[this.inodes.length] = new Uint8Array(inode.size);
    if(targetdata)
    {
        data.set(targetdata, 0);
    }
    inode.name = name;
    inode.parentid = parentid;
    this.PushInode(inode);
    //inode.uid = inodetarget.uid;
    //inode.gid = inodetarget.gid;
    //inode.mode = inodetarget.mode | S_IFLNK;
};

FS.prototype.Unlink = function(idx) {
    this.NotifyListeners(idx, 'delete');
    if (idx == 0) return false; // root node cannot be deleted
    var inode = this.GetInode(idx);
    //message.Debug("Unlink " + inode.name);

    // check if directory is not empty
    if ((inode.mode&S_IFMT) == S_IFDIR) {
       if (inode.firstid != -1) return false;
    }

    // update ids
    if (this.inodes[inode.parentid].firstid == idx) {
        this.inodes[inode.parentid].firstid = inode.nextid;
    } else {
        var id = this.FindPreviousID(idx);
        if (id == -1) {
            message.Debug("Error in Filesystem: Cannot find previous id of inode");
            message.Abort();
        }
        this.inodes[id].nextid = inode.nextid;
    }
    // don't delete the content. The file is still accessible
    this.inodes[inode.parentid].updatedir = true;
    this.inodes[inode.parentid].nlinks--;
    inode.status = STATUS_UNLINKED;
    inode.nextid = -1;
    inode.firstid = -1;
    inode.parentid = -1;
    inode.nlinks--;
    return true;
};

FS.prototype.GetInode = function(idx)
{
    dbg_assert(!isNaN(idx), "Filesystem GetInode: NaN idx");
    dbg_assert(idx >= 0 && idx < this.inodes.length, "Filesystem GetInode: out of range idx:" + idx);

    const inode = this.inodes[idx];
    if(this.is_forwarder(inode))
    {
        return this.follow_fs(inode).GetInode(inode.foreign_id);
    }

    return inode;
};

FS.prototype.ChangeSize = function(idx, newsize)
{
    var inode = this.GetInode(idx);
    var temp = this.inodedata[idx];
    inode.dirty = true;
    //message.Debug("change size to: " + newsize);
    if (newsize == inode.size) return;
    var data = this.inodedata[idx] = new Uint8Array(newsize);
    inode.size = newsize;
    if(!temp) return;
    var size = Math.min(temp.length, inode.size);
    data.set(temp.subarray(0, size), 0);
};

FS.prototype.SearchPath = function(path) {
    //path = path.replace(/\/\//g, "/");
    path = path.replace("//", "/");
    var walk = path.split("/");
    if (walk.length > 0 && walk[walk.length - 1].length === 0) walk.pop();
    if (walk.length > 0 && walk[0].length === 0) walk.shift();
    const n = walk.length;

    var parentid = -1;
    var id = 0;
    let forward_path = null;
    for(var i=0; i<n; i++) {
        parentid = id;
        id = this.Search(parentid, walk[i]);
        if(!forward_path && this.is_forwarder(this.inodes[parentid]))
        {
            forward_path = "/" + walk.slice(i).join("/");
        }
        if (id == -1) {
            if (i < n-1) return {id: -1, parentid: -1, name: walk[i], forward_path }; // one name of the path cannot be found
            return {id: -1, parentid: parentid, name: walk[i], forward_path}; // the last element in the path does not exist, but the parent
        }
    }
    return {id: id, parentid: parentid, name: walk[i], forward_path};
};
// -----------------------------------------------------

FS.prototype.GetRecursiveList = function(dirid, list) {
    var id = this.inodes[dirid].firstid;
    while(id != -1) {
        list.push(id);
        if ((this.inodes[id].mode&S_IFMT) == S_IFDIR) {
            this.GetRecursiveList(id, list);
        }
        id = this.inodes[id].nextid;
    }
};

FS.prototype.RecursiveDelete = function(path) {
    var toDelete = [];
    var ids = this.SearchPath(path);
    if (ids.parentid == -1 || ids.id == -1) return;

    this.GetRecursiveList(ids.id, toDelete);

    for(var i=toDelete.length-1; i>=0; i--)
        this.Unlink(toDelete[i]);

};

FS.prototype.DeleteNode = function(path) {
    var ids = this.SearchPath(path);
    if (ids.parentid == -1 || ids.id == -1) return;

    if ((this.inodes[ids.id].mode&S_IFMT) == S_IFREG){
        this.Unlink(ids.id);
        return;
    }
    if ((this.inodes[ids.id].mode&S_IFMT) == S_IFDIR){
        var toDelete = [];
        this.GetRecursiveList(ids.id, toDelete);
        for(var i=toDelete.length-1; i>=0; i--)
            this.Unlink(toDelete[i]);
        this.Unlink(ids.id);
        return;
    }
};

/** @param {*=} info */
FS.prototype.NotifyListeners = function(id, action, info) {
    //if(info==undefined)
    //    info = {};

    //var path = this.GetFullPath(id);
    //if (this.watchFiles[path] == true && action=='write') {
    //  message.Send("WatchFileEvent", path);
    //}
    //for (var directory in this.watchDirectories) {
    //    if (this.watchDirectories.hasOwnProperty(directory)) {
    //        var indexOf = path.indexOf(directory)
    //        if(indexOf == 0 || indexOf == 1)
    //            message.Send("WatchDirectoryEvent", {path: path, event: action, info: info});
    //    }
    //}
};


FS.prototype.Check = function() {
    for(var i=1; i<this.inodes.length; i++)
    {
        if (this.inodes[i].status == STATUS_INVALID) continue;
        if (this.inodes[i].nextid == i) {
            message.Debug("Error in filesystem: file points to itself");
            message.Abort();
        }

        var inode = this.GetInode(i);
        if (inode.parentid < 0) {
            message.Debug("Error in filesystem: negative parent id " + i);
        }
        var n = inode.name.length;
        if (n == 0) {
            message.Debug("Error in filesystem: inode with no name and id " + i);
        }

        for (var j in inode.name) {
            var c = inode.name.charCodeAt(j);
            if (c < 32) {
                message.Debug("Error in filesystem: Unallowed char in filename");
            }
        }
    }

};


FS.prototype.FillDirectory = function(dirid) {
    var inode = this.GetInode(dirid);
    if (!inode.updatedir) return;
    var parentid = inode.parentid;
    if (parentid == -1) parentid = 0; // if root directory point to the root directory

    // first get size
    var size = 0;
    var id = this.inodes[dirid].firstid;
    while(id != -1) {
        size += 13 + 8 + 1 + 2 + UTF8.UTF8Length(this.inodes[id].name);
        id = this.inodes[id].nextid;
    }

    size += 13 + 8 + 1 + 2 + 1; // "." entry
    size += 13 + 8 + 1 + 2 + 2; // ".." entry
    //message.Debug("size of dir entry: " + size);
    var data = this.inodedata[dirid] = new Uint8Array(size);
    inode.size = size;

    var offset = 0x0;
    offset += marshall.Marshall(
        ["Q", "d", "b", "s"],
        [this.inodes[dirid].qid,
        offset+13+8+1+2+1,
        this.inodes[dirid].mode >> 12,
        "."],
        data, offset);

    offset += marshall.Marshall(
        ["Q", "d", "b", "s"],
        [this.inodes[parentid].qid,
        offset+13+8+1+2+2,
        this.inodes[parentid].mode >> 12,
        ".."],
        data, offset);

    id = this.inodes[dirid].firstid;
    while(id != -1) {
        offset += marshall.Marshall(
        ["Q", "d", "b", "s"],
        [this.inodes[id].qid,
        offset+13+8+1+2+UTF8.UTF8Length(this.inodes[id].name),
        this.inodes[id].mode >> 12,
        this.inodes[id].name],
        data, offset);
        id = this.inodes[id].nextid;
    }
    inode.updatedir = false;
};

FS.prototype.RoundToDirentry = function(dirid, offset_target)
{
    const data = this.inodedata[dirid];
    dbg_assert(data, `FS directory data for dirid=${dirid} should be generated`);
    dbg_assert(data.length, "FS directory should have at least an entry");

    if(offset_target >= data.length)
    {
        return data.length;
    }

    let offset = 0;
    while(true)
    {
        const next_offset = marshall.Unmarshall(["Q", "d"], data, { offset })[1];
        if(next_offset > offset_target) break;
        offset = next_offset;
    }

    return offset;
};

/**
 * @param {number} idx
 * @return {boolean}
 */
FS.prototype.IsDirectory = function(idx)
{
    const inode = this.inodes[idx];
    if(this.is_forwarder(inode))
    {
        return this.follow_fs(inode).IsDirectory(inode.foreign_id);
    }
    return (inode.mode & S_IFMT) === S_IFDIR;
};

/**
 * @param {number} idx
 * @return {!Array<string>} List of children names
 */
FS.prototype.GetChildren = function(idx)
{
    const inode = this.inodes[idx];
    const children = [];

    if(this.is_forwarder(inode))
    {
        return this.follow_fs(inode).GetChildren(inode.foreign_id);
    }

    let child_id = this.inodes[idx].firstid;

    while(child_id !== -1)
    {
        children.push(this.inodes[child_id].name);
        child_id = this.inodes[child_id].nextid;
    }

    return children;
};

/**
 * @param {number} idx
 * @return {number} Local idx of parent
 */
FS.prototype.GetParent = function(idx)
{
    const inode = this.inodes[idx];

    if(this.should_be_linked(inode))
    {
        return inode.parentid;
    }
    else
    {
        const foreign_dirid = this.follow_fs(inode).GetParent(inode.foreign_id);
        if(foreign_dirid === -1)
        {
            return -1;
        }
        return this.get_forwarder(inode.mount_id, foreign_dirid);
    }
};


// -----------------------------------------------------

// only support for security.capabilities
// should return a  "struct vfs_cap_data" defined in
// linux/capability for format
// check also:
//   sys/capability.h
//   http://lxr.free-electrons.com/source/security/commoncap.c#L376
//   http://man7.org/linux/man-pages/man7/capabilities.7.html
//   http://man7.org/linux/man-pages/man8/getcap.8.html
//   http://man7.org/linux/man-pages/man3/libcap.3.html
FS.prototype.PrepareCAPs = function(id) {
    var inode = this.GetInode(id);
    if (inode.caps) return inode.caps.length;
    inode.caps = new Uint8Array(20);
    // format is little endian
    // note: getxattr returns -EINVAL if using revision 1 format.
    // note: getxattr presents revision 3 as revision 2 when revision 3 is not needed.
    // magic_etc (revision=0x02: 20 bytes)
    inode.caps[0]  = 0x00;
    inode.caps[1]  = 0x00;
    inode.caps[2]  = 0x00;
    inode.caps[3]  = 0x02;

    // lower
    // permitted (first 32 capabilities)
    inode.caps[4]  = 0xFF;
    inode.caps[5]  = 0xFF;
    inode.caps[6]  = 0xFF;
    inode.caps[7]  = 0xFF;
    // inheritable (first 32 capabilities)
    inode.caps[8]  = 0xFF;
    inode.caps[9]  = 0xFF;
    inode.caps[10] = 0xFF;
    inode.caps[11] = 0xFF;

    // higher
    // permitted (last 6 capabilities)
    inode.caps[12] = 0x3F;
    inode.caps[13] = 0x00;
    inode.caps[14] = 0x00;
    inode.caps[15] = 0x00;
    // inheritable (last 6 capabilities)
    inode.caps[16] = 0x3F;
    inode.caps[17] = 0x00;
    inode.caps[18] = 0x00;
    inode.caps[19] = 0x00;

    return inode.caps.length;
};

// -----------------------------------------------------

/**
 * @constructor
 * @param {FS} filesystem
 */
function FSMountInfo(filesystem)
{
    /** @type {FS}*/
    this.fs = filesystem;

    /** @type {!Map<number,number>} */
    this.backtrack = new Map();
}

FSMountInfo.prototype.get_state = function()
{
    const state = [];

    state[0] = this.fs;
    state[1] = [];
    for(const entry of this.backtrack.entries())
    {
        state[1].push(entry);
    }

    return state;
};

FSMountInfo.prototype.set_state = function(state)
{
    this.fs = new FS(undefined);
    fs.set_state(state[0]);
    this.backtrack = new Map(state[1]);
};

/**
 * @private
 * @param {number} idx Local idx of inode.
 * @param {number} mount_id Mount number of the destination fs.
 * @param {number} foreign_id Foreign idx of destination inode.
 */
FS.prototype.set_forwarder = function(idx, mount_id, foreign_id)
{
    const inode = this.inodes[idx];

    if(this.is_forwarder(inode))
    {
        this.mounts[inode.mount_id].backtrack.delete(inode.foreign_id);
    }

    inode.status = STATUS_FORWARDING;
    inode.mount_id = mount_id;
    inode.foreign_id = foreign_id;

    this.mounts[mount_id].backtrack.set(foreign_id, idx);
};

/**
 * @private
 * @param {number} mount_id Mount number of the destination fs.
 * @param {number} foreign_id Foreign idx of destination inode.
 * @return {number} Local idx of newly created forwarder.
 */
FS.prototype.create_forwarder = function(mount_id, foreign_id)
{
    dbg_assert(foreign_id !== 0, "Filesystem: root forwarder should not be created.");

    const inode = this.CreateInode();

    const idx = this.inodes.length;
    this.inodes.push(inode);
    inode.fid = idx;

    this.set_forwarder(idx, mount_id, foreign_id);
    return idx;
};

/**
 * @private
 * @param {Inode} inode
 * @return {boolean}
 */
FS.prototype.is_forwarder = function(inode)
{
    return inode.status === STATUS_FORWARDING;
};

/**
 * @private
 * @param {Inode} inode
 * @return {boolean}
 */
FS.prototype.is_root_forwarder = function(inode)
{
    // Note: Non-root forwarder inode could still have a non-forwarder parent, so don't use
    // parent inode to check.
    return this.is_forwarder(inode) && inode.foreign_id === 0;
};

/**
 * Ensures forwarder exists, and returns such forwarder, for the described foreign inode.
 * @private
 * @param {number} mount_id
 * @param {number} foreign_id
 * @return {number} Local idx of a forwarder to described inode.
 */
FS.prototype.get_forwarder = function(mount_id, foreign_id)
{
    const mount = this.mounts[mount_id];

    dbg_assert(foreign_id >= 0, "Filesystem get_forwarder: invalid foreign_id: " + foreign_id);
    dbg_assert(mount, "Filesystem get_forwarder: invalid mount number: " + mount_id);

    const result = mount.backtrack.get(foreign_id);

    if(result === undefined)
    {
        // Create if not already exists.
        return this.create_forwarder(mount_id, foreign_id);
    }

    return result;
};

/**
 * @private
 * @param {Inode} inode
 */
FS.prototype.delete_forwarder = function(inode)
{
    dbg_assert(this.is_forwarder(inode), "Filesystem delete_forwarder: expected forwarder");

    inode.status = STATUS_INVALID;
    this.mounts[inode.mount_id].backtrack.delete(inode.foreign_id);
};

/**
 * @private
 * @param {Inode} inode
 * @return {FS}
 */
FS.prototype.follow_fs = function(inode)
{
    const mount = this.mounts[inode.mount_id];

    dbg_assert(this.is_forwarder(inode),
        "Filesystem follow_fs: inode should be a forwarding inode");
    dbg_assert(mount, "Filesystem follow_fs: inode<id=" + inode.fid + ", name=" +
        inode.name + "> should point to valid mounted FS");

    return mount.fs;
};

/**
 * Mount another filesystem onto an existing directory.
 * @param {string} path Path to existing directrory relative to this filesystem.
 * @param {FS} fs
 */
FS.prototype.Mount = function(path, fs)
{
    const path_infos = this.SearchPath(path);

    if(path_infos.id === -1)
    {
        dbg_log("Mount failed: path not found: " + path, LOG_9P);
        return -1;
    }
    if(path_infos.forward_path)
    {
        const parent = this.inodes[path_infos.parentid];
        this.follow_fs(parent).Mount(path_infos.forward_path, fs);
        return;
    }

    const mount_id = this.mounts.length;
    this.mounts.push(new FSMountInfo(fs));

    // Existing inode is already linked. Just set forwarding information.
    this.set_forwarder(path_infos.id, mount_id, 0);

    return path_infos.id;
};
