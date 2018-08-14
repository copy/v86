#!/usr/bin/env node
"use strict";

process.on("unhandledRejection", exn => { throw exn; });
const V86 = require("../../build/libv86-debug.js").V86;
const fs = require("fs");

const testfsjson = JSON.stringify(require('./testfs.json'));
const SHOW_LOGS = false;

function log_pass(msg, ...args)
{
    console.log(`\x1b[92m[+] ${msg}\x1b[0m`, ...args);
}

function log_warn(msg, ...args)
{
    console.error(`\x1b[93m[!] ${msg}\x1b[0m`, ...args);
}

function log_fail(msg, ...args)
{
    console.error(`\x1b[91m[-] ${msg}\x1b[0m`, ...args);
}

function assert_equal(actual, expected, message)
{
    if(actual !== expected)
    {
        log_warn("Failed assert equal (Test: %s). %s", tests[test_num].name, message || "");
        log_warn("Expected:\n" + expected);
        log_warn("Actual:\n" + actual);
        test_fail();
    }
}

function assert_not_equal(actual, expected, message)
{
    if(actual === expected)
    {
        log_warn("Failed assert not equal (Test: %s). %s", tests[test_num].name, message || "");
        log_warn("Expected something different than:\n" + expected);
        test_fail();
    }
}

// Random printable characters.
const test_file = new Uint8Array(512).map(v => 0x20 + Math.random() * 0x5e);
const test_file_string = Buffer.from(test_file).toString();
const test_file_small = new Uint8Array(16).map(v => 0x20 + Math.random() * 0x5e);
const test_file_small_string = Buffer.from(test_file_small).toString();

const tests =
[
    {
        name: "API SearchPath",
        timeout: 60,
        mounts:
        [
            { path: "/x/fs2" },
        ],
        start: () =>
        {
            emulator.serial0_send("mkdir -p /mnt/a/b/c\n");
            emulator.serial0_send("touch /mnt/a/b/c/file1\n");
            emulator.serial0_send("touch /mnt/file2\n");
            emulator.serial0_send("mkdir -p /mnt/x/fs2/y/z\n");
            emulator.serial0_send("echo done-searchpath\n");
        },
        end_trigger: "done-searchpath",
        end: (capture, done) =>
        {
            const root1 = emulator.fs9p.SearchPath("");
            assert_equal(root1.id, 0, "root1 id");
            assert_equal(root1.parentid, -1, "root1 parentid");

            const root2 = emulator.fs9p.SearchPath("/");
            assert_equal(root2.id, 0, "root2 / id");
            assert_equal(root2.parentid, -1, "root2 / parentid");

            const notfound1 = emulator.fs9p.SearchPath("c");
            assert_equal(notfound1.id, -1, "notfound1 c id");
            assert_equal(notfound1.parentid, 0, "notfound1 c parentid");

            const notfound2 = emulator.fs9p.SearchPath("c/d");
            assert_equal(notfound2.id, -1, "notfound2 c/d id");
            assert_equal(notfound2.parentid, -1, "notfound2 c/d parentid");

            const notfound3 = emulator.fs9p.SearchPath("a/d");
            assert_equal(notfound3.id, -1, "notfound3 a/d id");
            assert_equal(emulator.fs9p.GetInode(notfound3.parentid).name, "a", "notfound3 a/d parent name");
            const idx_a = notfound3.parentid;

            const notfound4 = emulator.fs9p.SearchPath("a/d/e");
            assert_equal(notfound4.id, -1, "notfound4 a/d/e id");
            assert_equal(notfound4.parentid, -1, "notfound4 a/d/e parentid");

            const dir1 = emulator.fs9p.SearchPath("a");
            assert_equal(dir1.id, idx_a, "dir1 a id");
            assert_equal(dir1.parentid, 0, "dir1 a parentid");

            const dir2 = emulator.fs9p.SearchPath("a/b/c");
            assert_equal(emulator.fs9p.GetInode(dir2.id).name, "c", "dir2 a/b/c name");
            assert_equal(emulator.fs9p.GetInode(dir2.parentid).name, "b", "dir2 a/b/c parent name");
            const idx_b = dir2.parentid;
            const idx_c = dir2.id;

            const file1 = emulator.fs9p.SearchPath("a/b/c/file1");
            assert_equal(emulator.fs9p.GetInode(file1.id).name, "file1", "file1 a/b/c/file1 name");
            assert_equal(file1.parentid, idx_c, "file1 a/b/c/file1 parentid");

            const file2 = emulator.fs9p.SearchPath("file2");
            assert_equal(emulator.fs9p.GetInode(file2.id).name, "file2", "file2 name");
            assert_equal(file2.parentid, 0, "file2 parentid");

            const fwdpath1 = emulator.fs9p.SearchPath("x/fs2");
            assert_equal(fwdpath1.forward_path, null, "fwdpath1 x/fs2");

            const fwdpath2 = emulator.fs9p.SearchPath("x/fs2/y");
            assert_equal(fwdpath2.forward_path, "/y", "fwdpath2 x/fs2/y");

            const fwdpath3 = emulator.fs9p.SearchPath("x/fs2/y/z");
            assert_equal(fwdpath3.forward_path, "/y/z", "fwdpath3 x/fs2/y/z");

            const fwdpath4 = emulator.fs9p.SearchPath("x/fs2/nonexistent");
            assert_equal(fwdpath4.forward_path, "/nonexistent", "fwdpath4 x/fs2/nonexistent");

            done();
        },
    },
    {
        name: "Read Existing",
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("cp /etc/profile /mnt/read-existing\n");
            emulator.serial0_send("echo start-capture; cat /etc/profile; echo done-read-existing\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-read-existing",
        end: (capture, done) =>
        {
            emulator.read_file("read-existing", function(err, data)
            {
                if(err)
                {
                    log_warn("Reading read-existing failed: %s",  err);
                    test_fail();
                    done();
                    return;
                }
                assert_equal(capture, Buffer.from(data).toString());
                done();
            });
        },
    },
    {
        name: "Read New",
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("dd if=/dev/zero of=/mnt/read-new bs=1k count=512\n");
            emulator.serial0_send("echo done-read-new\n");
        },
        end_trigger: "done-read-new",
        end: (capture, done) =>
        {
            emulator.read_file("read-new", function(err, data)
            {
                if(err)
                {
                    log_warn("Reading read-new failed: %s", err);
                    test_fail();
                    done();
                    return;
                }
                assert_equal(data.length, 512 * 1024);
                if(data.find(v => v !== 0))
                {
                    log_warn("Fail: Incorrect data. Expected all zeros.");
                    test_fail();
                }
                done();
            });
        },
    },
    {
        name: "Read Async",
        use_fsjson: true,
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("echo start-capture;");

            // "foo" is from ./testfs/foo
            emulator.serial0_send("cat /mnt/foo;");

            emulator.serial0_send("echo done-read-async\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-read-async",
        end: (capture, done) =>
        {
            assert_equal(capture, "bar\n");
            emulator.read_file("foo", function(err, data)
            {
                if(err)
                {
                    log_warn("Reading foo failed: %s", err);
                    test_fail();
                    done();
                    return;
                }
                assert_equal(Buffer.from(data).toString(), "bar\n");
                done();
            });
        },
    },
    {
        name: "Write New",
        timeout: 60,
        files:
        [
            {
                file: "write-new",
                data: test_file,
            },
        ],
        start: () =>
        {
            emulator.serial0_send("echo start-capture; cat /mnt/write-new; echo; echo done-write-new\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-write-new",
        end: (capture, done)  =>
        {
            // Handle word wrapping.
            const lines = capture.split("\n");
            let pos = 0;
            for(const line of lines)
            {
                assert_equal(line, test_file_string.slice(pos, line.length));
                pos += line.length;
            }
            done();
        },
    },
    {
        name: "New file time",
        timeout: 10,
        start: () =>
        {
            emulator.serial0_send("echo start-capture; echo foo > /mnt/bar; ls  -l --full-time --color=never /mnt/bar; echo; echo done-write-new\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-write-new",
        end: (capture, done)  =>
        {
            const outputs = capture.split("\n").map(output => output.split(/\s+/));

            // atime: Should be fresh
            const [year, month, day] = outputs[0][5].split("-");
            assert_not_equal(year, "1970");

            done();
        },
    },
    {
        name: "Move",
        timeout: 60,
        files:
        [
            {
                file: "test-file",
                data: test_file,
            },
        ],
        start: () =>
        {
            emulator.serial0_send("echo start-capture;");
            emulator.serial0_send("cat /mnt/test-file;");
            emulator.serial0_send("find /mnt;");

            // Rename. Verify updated directory.
            emulator.serial0_send("mv /mnt/test-file /mnt/renamed;");
            emulator.serial0_send("cat /mnt/renamed;");
            emulator.serial0_send("find /mnt;");

            // Move between folders. Verify directories.
            emulator.serial0_send("mkdir /mnt/somedir;");
            emulator.serial0_send("mv /mnt/renamed /mnt/somedir/file;");
            emulator.serial0_send("cat /mnt/somedir/file;");
            emulator.serial0_send("find /mnt;");

            // Rename folder.
            emulator.serial0_send("mv /mnt/somedir /mnt/otherdir;");
            emulator.serial0_send("cat /mnt/otherdir/file;");
            emulator.serial0_send("find /mnt;");

            // Move folder.
            emulator.serial0_send("mkdir /mnt/thirddir;");
            emulator.serial0_send("mv /mnt/otherdir /mnt/thirddir;");
            emulator.serial0_send("cat /mnt/thirddir/otherdir/file;");
            emulator.serial0_send("find /mnt;");

            // Move folder outside /mnt. Should be removed from 9p filesystem.
            emulator.serial0_send("mv /mnt/thirddir/otherdir /root/movedoutside;");
            emulator.serial0_send("cat /root/movedoutside/file;");
            emulator.serial0_send("find /mnt;");

            // Cleanup.
            emulator.serial0_send("rm -rf /root/movedoutside;");
            emulator.serial0_send("echo done-move\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-move",
        end: (capture, done)  =>
        {
            assert_equal(capture,
                test_file_string +
                "/mnt\n" +
                "/mnt/test-file\n" +
                test_file_string +
                "/mnt\n" +
                "/mnt/renamed\n" +
                test_file_string +
                "/mnt\n" +
                "/mnt/somedir\n" +
                "/mnt/somedir/file\n" +
                test_file_string +
                "/mnt\n" +
                "/mnt/otherdir\n" +
                "/mnt/otherdir/file\n" +
                test_file_string +
                "/mnt\n" +
                "/mnt/thirddir\n" +
                "/mnt/thirddir/otherdir\n" +
                "/mnt/thirddir/otherdir/file\n" +
                test_file_string +
                "/mnt\n" +
                "/mnt/thirddir\n");
            done();
        },
    },
    {
        name: "Unlink",
        timeout: 60,
        files:
        [
            {
                file: "existing-file",
                data: test_file,
            },
        ],
        start: () =>
        {
            emulator.serial0_send("touch /mnt/new-file\n");
            emulator.serial0_send("mkdir /mnt/new-dir\n");
            emulator.serial0_send("touch /mnt/new-dir/file\n");

            emulator.serial0_send("echo start-capture;");

            emulator.serial0_send("rm /mnt/new-file;");
            emulator.serial0_send("test ! -e /mnt/new-file && echo new-file-unlinked;");
            emulator.serial0_send("cat /mnt/new-file 2>/dev/null || echo read-failed;");

            emulator.serial0_send("rm /mnt/existing-file;");
            emulator.serial0_send("test ! -e /mnt/existing-file && echo existing-file-unlinked;");
            emulator.serial0_send("cat /mnt/existing-file 2>/dev/null || echo read-failed;");

            emulator.serial0_send("rmdir /mnt/new-dir 2>/dev/null || echo rmdir-failed;");
            emulator.serial0_send("test -e /mnt/new-dir && echo new-dir-exist;");

            emulator.serial0_send("rm /mnt/new-dir/file;");
            emulator.serial0_send("rmdir /mnt/new-dir;");
            emulator.serial0_send("test ! -e /mnt/new-dir/file && echo new-dir-file-unlinked;");
            emulator.serial0_send("test ! -e /mnt/new-dir && echo new-dir-unlinked;");
            emulator.serial0_send("ls /mnt/new-dir 2>/dev/null || echo read-failed;");

            emulator.serial0_send("echo done-unlink\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-unlink",
        end: (capture, done)  =>
        {
            assert_equal(capture,
                "new-file-unlinked\n" +
                "read-failed\n" +
                "existing-file-unlinked\n" +
                "read-failed\n" +
                "rmdir-failed\n" +
                "new-dir-exist\n" +
                "new-dir-file-unlinked\n" +
                "new-dir-unlinked\n" +
                "read-failed\n");
            done();
        },
    },
    {
        name: "Hard Links",
        timeout: 60,
        allow_failure: true,
        files:
        [
            {
                file: "target",
                data: test_file_small,
            },
        ],
        start: () =>
        {
            emulator.serial0_send("ln /mnt/target /mnt/link\n");
            emulator.serial0_send("echo foo >> /mnt/link\n");

            emulator.serial0_send("echo start-capture;");

            // "foo" should be added to the target.
            emulator.serial0_send("cat /mnt/target;");

            // Both should have the same inode number
            emulator.serial0_send("test /mnt/target -ef /mnt/link && echo same-inode;");

            // File should still exist after one is renamed.
            emulator.serial0_send("mv /mnt/target /mnt/renamed;");
            emulator.serial0_send("echo bar >> /mnt/renamed;");
            emulator.serial0_send("cat /mnt/link;");

            // File should still exist after one of the names are unlinked.
            emulator.serial0_send("rm /mnt/renamed;");
            emulator.serial0_send("cat /mnt/link;");

            emulator.serial0_send("echo done-hard-links\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-hard-links",
        end: (capture, done) =>
        {
            assert_equal(capture,
                test_file_small_string + "foo\n" +
                "same-inode\n" +
                test_file_small_string + "foo\nbar\n" +
                test_file_small_string + "foo\nbar\n");
            done();
        },
    },
    {
        name: "Symlinks",
        timeout: 60,
        files:
        [
            {
                file: "target",
                data: test_file_small,
            },
        ],
        start: () =>
        {
            emulator.serial0_send("echo otherdata > /mnt/target2\n");
            emulator.serial0_send("ln -s /mnt/target /mnt/symlink\n");
            emulator.serial0_send("echo appended >> /mnt/symlink\n");

            emulator.serial0_send("echo start-capture;");

            // Should output same file data.
            emulator.serial0_send("cat /mnt/target;");
            emulator.serial0_send("cat /mnt/symlink;");

            // Swap target with the other file.
            emulator.serial0_send("rm /mnt/target;");
            emulator.serial0_send("mv /mnt/target2 /mnt/target;");

            // Symlink should now read from that file.
            emulator.serial0_send("cat /mnt/symlink;");

            emulator.serial0_send("rm /mnt/target;");
            emulator.serial0_send("rm /mnt/symlink;");
            emulator.serial0_send("echo done-symlinks\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-symlinks",
        end: (capture, done) =>
        {
            assert_equal(capture,
                test_file_small_string + "appended\n" +
                test_file_small_string + "appended\n" +
                "otherdata\n");
            done();
        },
    },
    {
        name: "Mknod - fifo",
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("mkfifo /mnt/testfifo\n");
            emulator.serial0_send('(cat /mnt/testfifo > /mnt/testfifo-output;echo "\ndone-fifo") &\n');
            emulator.serial0_send("echo fifomessage > /mnt/testfifo\n");
        },
        end_trigger: "done-fifo",
        end: (capture, done) =>
        {
            emulator.read_file("testfifo-output", function(err, data)
            {
                if(err)
                {
                    log_warn("Reading testfifo-output failed: %s", err);
                    test_fail();
                    done();
                    return;
                }
                assert_equal(Buffer.from(data).toString(), "fifomessage\n");
                done();
            });
        },
    },
    {
        name: "Readlink",
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("touch /mnt/target\n");
            emulator.serial0_send("ln -s /mnt/target /mnt/link\n");
            emulator.serial0_send("echo start-capture;");
            emulator.serial0_send("readlink /mnt/link;");
            emulator.serial0_send("echo done-readlink\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-readlink",
        end: (capture, done) =>
        {
            assert_equal(capture, "/mnt/target\n");
            done();
        },
    },
    {
        name: "Mkdir",
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("echo notfoobar > /mnt/e-file\n");
            emulator.serial0_send("mkdir /mnt/a-dir\n");
            emulator.serial0_send("mkdir /mnt/a-dir/b-dir\n");
            emulator.serial0_send("mkdir /mnt/a-dir/c-dir\n");
            emulator.serial0_send("touch /mnt/a-dir/d-file\n");
            emulator.serial0_send("echo mkdirfoobar > /mnt/a-dir/e-file\n");
            emulator.serial0_send("echo done-mkdir\n");
        },
        end_trigger: "done-mkdir",
        end: (capture, done) =>
        {
            emulator.read_file("a-dir/e-file", function(err, data)
            {
                if(err)
                {
                    log_warn("Reading a-dir/e-file failed: %s", err);
                    test_fail();
                    done();
                    return;
                }
                assert_equal(Buffer.from(data).toString(), "mkdirfoobar\n");
                done();
            });
        },
    },
    {
        name: "Walk",
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("mkdir -p /mnt/walk/a/aa/aaa/aaaa\n");
            emulator.serial0_send("mkdir -p /mnt/walk/a/aa/aaa/aaaa\n");
            emulator.serial0_send("mkdir -p /mnt/walk/b/ba\n");
            emulator.serial0_send("mkdir -p /mnt/walk/a/aa/aab\n");
            emulator.serial0_send("mkdir -p /mnt/walk/a/aa/aac\n");
            emulator.serial0_send("touch /mnt/walk/a/aa/aab/aabfile\n");
            emulator.serial0_send("touch /mnt/walk/b/bfile\n");
            emulator.serial0_send("echo start-capture;");
            emulator.serial0_send("find /mnt/walk | sort;"); // order agnostic
            emulator.serial0_send("echo done-walk\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-walk",
        end: (capture, done) =>
        {
            const actual = capture;
            const expected =
                "/mnt/walk\n" +
                "/mnt/walk/a\n" +
                "/mnt/walk/a/aa\n" +
                "/mnt/walk/a/aa/aaa\n" +
                "/mnt/walk/a/aa/aaa/aaaa\n" +
                "/mnt/walk/a/aa/aab\n" +
                "/mnt/walk/a/aa/aab/aabfile\n" +
                "/mnt/walk/a/aa/aac\n" +
                "/mnt/walk/b\n" +
                "/mnt/walk/b/ba\n" +
                "/mnt/walk/b/bfile\n";
            assert_equal(actual, expected);
            done();
        },
    },
    {
        name: "Statfs",
        timeout: 60,
        allow_failure: true,
        start: () =>
        {
            emulator.serial0_send("echo start-capture;");
            emulator.serial0_send("touch /mnt/file;");
            emulator.serial0_send("df -PTk /mnt | tail -n 1;");

            // Grow file and verify space usage.
            emulator.serial0_send("dd if=/dev/zero of=/mnt/file bs=1k count=4 status=none;");
            emulator.serial0_send("df -PTk /mnt | tail -n 1;");

            // Shrink file and verify space usage.
            emulator.serial0_send("truncate -s 0 /mnt/file;");
            emulator.serial0_send("df -PTk /mnt | tail -n 1;");

            emulator.serial0_send("echo done-statfs\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-statfs",
        end: (capture, done) =>
        {
            const outputs = capture.split("\n").map(output => output.split(/\s+/));
            if(outputs.length < 3)
            {
                log_warn("Wrong format: %s", capture);
                test_fail();
                done();
                return;
            }

            const before = outputs[0];
            const after_add = outputs[1];
            const after_rm = outputs[2];

            // mount tag
            assert_equal(before[0], "host9p");

            // fs type
            assert_equal(before[1], "9p");

            // total size in 1024 blocks
            assert_equal(after_add[2], before[2]);
            assert_equal(after_rm[2], before[2]);

            // used size in 1024 blocks
            assert_equal(+after_add[3], (+before[3]) + 4);
            assert_equal(after_rm[3], before[3]);

            // free size in 1024 blocks
            assert_equal(+after_add[4], (+before[4]) - 4);
            assert_equal(after_rm[4], before[4]);

            // Entry [5] is percentage used.

            // mount path
            assert_equal(before[6], "/mnt");

            done();
        },
    },
    {
        name: "File Attributes",
        timeout: 60,
        allow_failure: true,
        start: () =>
        {
            emulator.serial0_send("echo start-capture;");

            emulator.serial0_send("dd if=/dev/zero of=/mnt/file bs=1 count=137 status=none;");
            emulator.serial0_send("touch -t 200002022222 /mnt/file;");
            emulator.serial0_send("chmod =rw /mnt/file;");
            emulator.serial0_send("ls -l --full-time --color=never /mnt/file;");

            emulator.serial0_send("chmod +x /mnt/file;");
            emulator.serial0_send("chmod -w /mnt/file;");
            emulator.serial0_send("ls -l --full-time --color=never /mnt/file;");

            emulator.serial0_send("chmod -x /mnt/file;");
            emulator.serial0_send("truncate -s 100 /mnt/file;");
            emulator.serial0_send("touch -t 201011220344 /mnt/file;");
            emulator.serial0_send("ln /mnt/file /mnt/file-link;");
            emulator.serial0_send("ls -l --full-time --color=never /mnt/file;");

            emulator.serial0_send("echo done-file-attr\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-file-attr",
        end: (capture, done) =>
        {
            const outputs = capture.split("\n").map(output => output.split(/\s+/));

            if(outputs.length < 3)
            {
                log_warn("Wrong format (expected 3 rows): %s", capture);
                test_fail();
                done();
                return;
            }

            // mode
            assert_equal(outputs[0][0], "-rw-r--r--");
            // nlinks
            assert_equal(outputs[0][1], "1");
            // user
            assert_equal(outputs[0][2], "root");
            // group
            assert_equal(outputs[0][3], "root");
            // size
            assert_equal(outputs[0][4], "137");
            // atime
            assert_equal(outputs[0][5], "2000-02-02");
            assert_equal(outputs[0][6], "22:22:00");
            assert_equal(outputs[0][7], "+0000");
            // pathname
            assert_equal(outputs[0][8], "/mnt/file");

            // mode
            assert_equal(outputs[1][0], "-r-xr-xr-x");
            // nlinks
            assert_equal(outputs[1][1], "1");
            // user
            assert_equal(outputs[1][2], "root");
            // group
            assert_equal(outputs[1][3], "root");
            // size
            assert_equal(outputs[1][4], "137");
            // atime
            assert_equal(outputs[1][5], "2000-02-02");
            assert_equal(outputs[1][6], "22:22:00");
            assert_equal(outputs[1][7], "+0000");
            // pathname
            assert_equal(outputs[1][8], "/mnt/file");

            // mode
            assert_equal(outputs[2][0], "-r--r--r--");
            // nlinks
            assert_equal(outputs[2][1], "2");
            // user
            assert_equal(outputs[2][2], "root");
            // group
            assert_equal(outputs[2][3], "root");
            // size
            assert_equal(outputs[2][4], "100");
            // atime
            assert_equal(outputs[2][5], "2010-11-22");
            assert_equal(outputs[2][6], "03:44:00");
            assert_equal(outputs[2][7], "+0000");
            // pathname
            assert_equal(outputs[2][8], "/mnt/file");

            done();
        },
    },
    {
        name: "Xattrwalk and Listxattr",
        timeout: 60,
        allow_failure: true,
        start: () =>
        {
            emulator.serial0_send("echo originalvalue > /mnt/file\n");
            emulator.serial0_send("echo start-capture;");

            emulator.serial0_send('setfattr --name=user.attr1 --value="val1" /mnt/file;');
            emulator.serial0_send('setfattr --name=user.attr2 --value="val2" /mnt/file;');
            emulator.serial0_send('setfattr --name=user.mime_type --value="text/plain" /mnt/file;');
            emulator.serial0_send('setfattr --name=user.nested.attr --value="foobar" /mnt/file;');

            // Unrecognized attribute name under other namespaces should be allowed.
            emulator.serial0_send('setfattr --name=security.not_an_attr --value="val3" /mnt/file;');

            // Remove the caps attribute we've automatically put in. Tested later.
            emulator.serial0_send('setfattr --remove=security.capability /mnt/file;');

            emulator.serial0_send("getfattr --encoding=text --absolute-names --dump /mnt/file | sort;");
            emulator.serial0_send("getfattr --encoding=text --absolute-names --name=user.nested.attr /mnt/file;");
            emulator.serial0_send("getfattr --encoding=text --absolute-names --name=security.not_an_attr /mnt/file;");
            emulator.serial0_send("getfattr --encoding=text --absolute-names --name=user.attr2 /mnt/file;");
            emulator.serial0_send("echo done-listxattr\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-listxattr",
        end: (capture, done) =>
        {
            assert_equal(capture,
                "# file: /mnt/file\n" +
                'security.not_an_attr="val3"\n' +
                'user.attr1="val1"\n' +
                'user.attr2="val2"\n' +
                'user.mime_type="text/plain"\n' +
                'user.nested.attr="foobar"\n' +
                "\n" +
                "# file: /mnt/file\n" +
                'user.nested.attr="foobar"\n' +
                "\n" +
                "# file: /mnt/file\n" +
                'security.not_an_attr="val3"\n' +
                "\n" +
                "# file: /mnt/file\n" +
                'user.attr2="val2"\n');
            done();
        },
    },
    {
        name: "Xattrcreate",
        timeout: 60,
        allow_failure: true,
        start: () =>
        {
            emulator.serial0_send("echo originalvalue > /mnt/file\n");
            // Remove the caps attribute we've automatically put in. Tested later.
            emulator.serial0_send('setfattr --remove=security.capability /mnt/file\n');

            emulator.serial0_send("echo start-capture;");

            // Creation of new xattr using xattrcreate.
            emulator.serial0_send("setfattr --name=user.foo --value=bar /mnt/file;");
            // File contents should not be overriden.
            emulator.serial0_send("cat /mnt/file;");
            emulator.serial0_send("getfattr --encoding=hex --absolute-names --name=user.foo /mnt/file;");

            // Overwriting of xattr using xattrcreate.
            emulator.serial0_send("setfattr --name=user.foo --value=baz /mnt/file;");
            // File contents should not be overriden.
            emulator.serial0_send("cat /mnt/file;");
            emulator.serial0_send("getfattr --encoding=hex --absolute-names --name=user.foo /mnt/file;");

            emulator.serial0_send("echo done-xattrcreate\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-xattrcreate",
        end: (capture, done) =>
        {
            assert_equal(capture,
                "originalvalue\n" +
                "# file: /mnt/file\n" +
                'user.foo="bar"\n' +
                "\n" +
                "originalvalue\n" +
                "# file: /mnt/file\n" +
                'user.foo="baz"\n' +
                "\n");
            done();
        },
    },
    {
        name: "Report All Security Capabilities",
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("touch /mnt/file\n");
            emulator.serial0_send("echo start-capture;");
            emulator.serial0_send("getfattr --encoding=hex --absolute-names --name=security.capability /mnt/file;");
            emulator.serial0_send("echo done-xattr\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-xattr",
        end: (capture, done) =>
        {
            assert_equal(capture,
                "# file: /mnt/file\n" +
                "security.capability=0x" +
                // magic and revision number
                "00000002" +
                // lower permitted
                "ffffffff" +
                // lower inheritable
                "ffffffff" +
                // higher permitted
                "3f000000" +
                // higher inheritable
                "3f000000" +
                "\n\n");
            done();
        },
    },
    {
        name: "Stress Files",
        timeout: 360,
        start: () =>
        {
            emulator.serial0_send("mkdir /mnt/stress-files\n");

            emulator.serial0_send('cat << "EOF" | sh\n');

            // Create files.
            // Ensure directory inode data exceeds maximum message size for 9p.
            emulator.serial0_send("for f in $(seq -w 0 999)\n");
            emulator.serial0_send("do\n");
            emulator.serial0_send('    echo "$f" > "/mnt/stress-files/file-$f"\n');
            emulator.serial0_send("done\n");

            emulator.serial0_send("echo start-capture\n");

            // Read some of them.
            emulator.serial0_send("for f in $(seq -w 0 31 999)\n");
            emulator.serial0_send("do\n");
            emulator.serial0_send('    cat "/mnt/stress-files/file-$f"\n');
            emulator.serial0_send("done\n");

            // Walk.
            emulator.serial0_send("find /mnt/stress-files | sort\n");

            // Delete and verify.
            // Using glob checks readdir.
            emulator.serial0_send('rm /mnt/stress-files/file-*\n');
            emulator.serial0_send('test -z "$(ls /mnt/stress-files)" && echo delete-success\n');

            emulator.serial0_send("echo done-stress-files\n");
            emulator.serial0_send("EOF\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-stress-files",
        end: (capture, done) =>
        {
            let expected = "";
            for(let i = 0; i < 1000; i += 31)
            {
                expected += i.toString().padStart(3, "0") + "\n";
            }
            expected += "/mnt/stress-files\n";
            for(let i = 0; i < 1000; i ++)
            {
                expected += "/mnt/stress-files/file-" + i.toString().padStart(3, "0") + "\n";
            }
            expected += "delete-success\n";
            assert_equal(capture, expected);
            done();
        },
    },
    {
        name: "Stress Directories",
        timeout: 360,
        start: () =>
        {
            emulator.serial0_send('cat << "EOF" | sh\n');

            emulator.serial0_send("p=/mnt/stress-dirs\n");
            emulator.serial0_send('mkdir "$p"\n');

            // Create deep folder structure
            emulator.serial0_send("for i in $(seq 0 99)\n");
            emulator.serial0_send("do\n");
            emulator.serial0_send('    p="$p/$i"\n');
            emulator.serial0_send('    mkdir "$p"\n');
            emulator.serial0_send('    echo "$i" > "$p/file"\n');
            emulator.serial0_send("done\n");

            // Try accessing deep files
            emulator.serial0_send("p=/mnt/stress-dirs\n");
            emulator.serial0_send("echo start-capture\n");
            // Skip first 80 - otherwise too slow
            emulator.serial0_send("for i in $(seq 0 79)\n");
            emulator.serial0_send("do\n");
            emulator.serial0_send('    p="$p/$i"\n');
            emulator.serial0_send("done\n");
            emulator.serial0_send("for i in $(seq 80 99)\n");
            emulator.serial0_send("do\n");
            emulator.serial0_send('    p="$p/$i"\n');
            emulator.serial0_send('    cat "$p/file"\n');
            emulator.serial0_send("done\n");

            // Delete and verify
            emulator.serial0_send("rm -rf /mnt/stress-dirs/0\n");
            emulator.serial0_send('test -z "$(ls /mnt/stress-dirs)" && echo delete-success\n');

            emulator.serial0_send("echo done-stress-dirs\n");
            emulator.serial0_send("EOF\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-stress-dirs",
        end: (capture, done) =>
        {
            const outputs = capture.split("\n");
            for(let i = 0; i < 20; i++)
            {
                assert_equal(outputs[i], `${i + 80}`);
            }
            assert_equal(outputs[20], "delete-success");
            done();
        },
    },
    {
        name: "Read Past Available",
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("echo a > /mnt/small-file\n");
            emulator.serial0_send("echo start-capture;");

            // Reading from offsets > size of file should not read anything.
            emulator.serial0_send("dd if=/mnt/small-file bs=1 count=1 skip=10;");
            emulator.serial0_send("dd if=/mnt/small-file bs=1 count=1 skip=100;");
            emulator.serial0_send("dd if=/mnt/small-file bs=1 count=1 skip=1000;");

            emulator.serial0_send("echo done-read-exceed\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-read-exceed",
        end: (capture, done) =>
        {
            const outputs = capture.split("\n");
            assert_equal(outputs[0], "0+0 records in");
            assert_equal(outputs[1], "0+0 records out");
            assert_equal(outputs[2], "0+0 records in");
            assert_equal(outputs[3], "0+0 records out");
            assert_equal(outputs[4], "0+0 records in");
            assert_equal(outputs[5], "0+0 records out");
            done();
        },
    },
    {
        name: "Read Mounted",
        timeout: 60,
        mounts:
        [
            { path: "/a/b/fs2", baseurl: __dirname + "/testfs/", basefs: testfsjson },
        ],
        start: () =>
        {
            emulator.serial0_send("echo start-capture;");
            emulator.serial0_send("cat /mnt/a/b/fs2/foo;");
            emulator.serial0_send("cat /mnt/a/b/fs2/dir/bar;");
            emulator.serial0_send("echo done-read-mounted\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-read-mounted",
        end: (capture, done) =>
        {
            assert_equal(capture, "bar\nfoobaz\n");
            emulator.read_file("/a/b/fs2/dir/bar", function(err, data)
            {
                if(err)
                {
                    log_warn("Reading /a/b/fs2/dir/bar failed: %s", err);
                    test_fail();
                    done();
                    return;
                }
                assert_equal(Buffer.from(data).toString(), "foobaz\n");
                done();
            });
        },
    },
    {
        name: "Write Mounted",
        timeout: 60,
        mounts:
        [
            { path: "/a/b/fs2" },
        ],
        files:
        [
            {
                file: "/a/b/fs2/write-new-host",
                data: test_file,
            },
        ],
        start: () =>
        {
            emulator.serial0_send("mkdir /mnt/a/b/fs2/c\n");
            emulator.serial0_send("echo foobar > /mnt/a/b/fs2/c/write-new-guest\n");

            emulator.serial0_send("echo start-capture;");
            emulator.serial0_send("cat /mnt/a/b/fs2/c/write-new-guest;");
            emulator.serial0_send("cat /mnt/a/b/fs2/write-new-host; echo;");
            emulator.serial0_send("echo done-write-mounted\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-write-mounted",
        end: (capture, done) =>
        {
            const lines = capture.split("\n");
            assert_equal(lines.shift(), "foobar");
            let pos = 0;
            for(const line of lines)
            {
                assert_equal(line, test_file_string.slice(pos, line.length));
                pos += line.length;
            }
            emulator.read_file("a/b/fs2/c/write-new-guest", function(err, data)
            {
                if(err)
                {
                    log_warn("Reading a/b/fs2/c/write-new-guest failed: %s", err);
                    test_fail();
                    done();
                    return;
                }
                assert_equal(Buffer.from(data).toString(), "foobar\n");
                done();
            });
        },
    },
    {
        name: "Walk Mounted",
        timeout: 180,
        mounts:
        [
            { path: "/a/fs2" },
            { path: "/fs3" },
            { path: "/fs3/fs4" },
        ],
        start: () =>
        {
            emulator.serial0_send("echo start-capture;");
            emulator.serial0_send("mkdir -p /mnt/a/fs2/aa/aaa/aaaa;");
            emulator.serial0_send("mkdir -p /mnt/a/fs2/aa/aab;");
            emulator.serial0_send("mkdir -p /mnt/a/fs2/ab/aba;");
            emulator.serial0_send("touch /mnt/a/fs2/ab/aba/abafile;");
            emulator.serial0_send("mkdir -p /mnt/a/fs2/ab/abb;");
            emulator.serial0_send("mkdir -p /mnt/fs3/a/aa/aaa;");
            emulator.serial0_send("mkdir -p /mnt/fs3/a/ab/aba;");
            emulator.serial0_send("touch /mnt/fs3/a/afile;");
            emulator.serial0_send("mkdir -p /mnt/fs3/b;");
            emulator.serial0_send("mkdir -p /mnt/fs3/fs4/a/aa/aaa;");
            emulator.serial0_send("mkdir -p /mnt/fs3/fs4/a/ab/;");
            emulator.serial0_send("mkdir -p /mnt/fs3/fs4/a/ac/aca;");
            emulator.serial0_send("touch /mnt/fs3/fs4/a/ac/aca/acafile;");
            emulator.serial0_send("find /mnt | sort;"); // order agnostic
            emulator.serial0_send("echo done-walk-mounted\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-walk-mounted",
        end: (capture, done) =>
        {
            const lines = capture.split("\n");
            const expected_lines =
            [
                "/mnt",
                "/mnt/a",
                "/mnt/a/fs2",
                "/mnt/a/fs2/aa",
                "/mnt/a/fs2/aa/aaa",
                "/mnt/a/fs2/aa/aaa/aaaa",
                "/mnt/a/fs2/aa/aab",
                "/mnt/a/fs2/ab",
                "/mnt/a/fs2/ab/aba",
                "/mnt/a/fs2/ab/aba/abafile",
                "/mnt/a/fs2/ab/abb",
                "/mnt/fs3",
                "/mnt/fs3/a",
                "/mnt/fs3/a/aa",
                "/mnt/fs3/a/aa/aaa",
                "/mnt/fs3/a/ab",
                "/mnt/fs3/a/ab/aba",
                "/mnt/fs3/a/afile",
                "/mnt/fs3/b",
                "/mnt/fs3/fs4",
                "/mnt/fs3/fs4/a",
                "/mnt/fs3/fs4/a/aa",
                "/mnt/fs3/fs4/a/aa/aaa",
                "/mnt/fs3/fs4/a/ab",
                "/mnt/fs3/fs4/a/ac",
                "/mnt/fs3/fs4/a/ac/aca",
                "/mnt/fs3/fs4/a/ac/aca/acafile",
            ];
            for(const expected of expected_lines)
            {
                assert_equal(lines.shift(), expected);
            }
            done();
        },
    },
    {
        name: "Move Mounted",
        timeout: 60,
        mounts:
        [
            { path: "/a/b/fs2" },
            { path: "/fs3" },
            { path: "/fs3/fs4" },
            { path: "/fs3/fs4/fs5" },
        ],
        start: () =>
        {
            emulator.serial0_send("echo foobar > /mnt/file\n");
            emulator.serial0_send("mkdir /mnt/a/b/fs2/dir\n");
            emulator.serial0_send("echo contents > /mnt/a/b/fs2/dir/child\n");

            // Using tail -f to keep 'file' open for modification in bg while it is being moved.
            // Using fifo to send data from fg job to bg job to write to file.
            emulator.serial0_send("mkfifo /mnt/fs3/fifo\n");
            emulator.serial0_send("mkfifo /mnt/fs3/fifo_intermediate\n");
            emulator.serial0_send("tail -f /mnt/fs3/fifo > /mnt/fs3/fifo_intermediate &\n");
            emulator.serial0_send('echo "$!" > /mnt/tailpid\n');
            emulator.serial0_send('{ sed "/EOF/q" < /mnt/fs3/fifo_intermediate && kill "$(cat /mnt/tailpid)"; } >> /mnt/file &\n');

            emulator.serial0_send("echo start-capture; \\\n");
            emulator.serial0_send("echo untouched > /mnt/fs3/fifo; \\\n");

            emulator.serial0_send("{ mv /mnt/file /mnt/renamed && ");
            emulator.serial0_send("  echo renamed > /mnt/fs3/fifo; }; \\\n");

            emulator.serial0_send("{ mv /mnt/renamed /mnt/fs3/file &&");
            emulator.serial0_send("  echo file jump filesystems > /mnt/fs3/fifo; }; \\\n");

            emulator.serial0_send("{ mv /mnt/fs3/file /mnt/a/b/fs2/dir/file && ");
            emulator.serial0_send("  echo moved to dir > /mnt/fs3/fifo; }; \\\n");

            emulator.serial0_send("{ mv /mnt/a/b/fs2/dir /mnt/fs3/fs4/fs5/dir && ");
            emulator.serial0_send("  echo dir jump filesystems > /mnt/fs3/fifo; }; \\\n");

            emulator.serial0_send("{ mv /mnt/fs3/fs4 /mnt/a/b/fs2/fs4 2>/dev/null || ");
            emulator.serial0_send("  echo move mount point across - fails > /mnt/fs3/fifo; }; \\\n");

            emulator.serial0_send("{ mv /mnt/fs3/fs4/fs5 /mnt/fs5 2>/dev/null || ");
            emulator.serial0_send("  echo move mount point upwards - fails > /mnt/fs3/fifo; }; \\\n");

            emulator.serial0_send("{ mv /mnt/fs3/fs4/fs5/dir /mnt/dir && ");
            emulator.serial0_send("  echo jump to root > /mnt/fs3/fifo; }; \\\n");

            emulator.serial0_send('printf "EOF\\n\\n" > /mnt/fs3/fifo & wait "$(cat /mnt/tailpid)" 2>/dev/null; \\\n');
            emulator.serial0_send("cat /mnt/dir/file; \\\n");
            emulator.serial0_send("cat /mnt/dir/child; \\\n");
            emulator.serial0_send("find /mnt | sort; \\\n");
            emulator.serial0_send("echo done-move-mounted\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-move-mounted",
        end: (capture, done) =>
        {
            assert_equal(capture,
                "foobar\n" +
                "untouched\n" +
                "renamed\n" +
                "file jump filesystems\n" +
                "moved to dir\n" +
                "dir jump filesystems\n" +
                "move mount point across - fails\n" +
                "move mount point upwards - fails\n" +
                "jump to root\n" +
                "EOF\n" +
                "contents\n" +
                "/mnt\n" +
                "/mnt/a\n" +
                "/mnt/a/b\n" +
                "/mnt/a/b/fs2\n" +
                "/mnt/dir\n" +
                "/mnt/dir/child\n" +
                "/mnt/dir/file\n" +
                "/mnt/fs3\n" +
                "/mnt/fs3/fifo\n" +
                "/mnt/fs3/fifo_intermediate\n" +
                "/mnt/fs3/fs4\n" +
                "/mnt/fs3/fs4/fs5\n" +
                "/mnt/tailpid\n");
            done();
        },
    },
];

let test_num = 0;
let test_timeout = 0;
let test_has_failed = false;
const failed_tests = [];

function test_fail()
{
    if(!test_has_failed)
    {
        test_has_failed = true;
        failed_tests.push(test_num);
    }
}

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso" },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {
        "baseurl": __dirname + "/testfs/",
    },
    log_level: SHOW_LOGS ? 0x400000 : 0,
});

let ran_command = false;
let line = "";
let capturing = false;
let capture = "";
let next_trigger;
let next_trigger_handler;

function start_timeout()
{
    if(tests[test_num].timeout)
    {
        test_timeout = setTimeout(() =>
        {
            log_fail("Test #%d (%s) took longer than %s sec. Timing out and terminating.", test_num, tests[test_num].name, tests[test_num].timeout);
            process.exit(1);
        }, tests[test_num].timeout * 1000);
    }
}

function nuke_fs()
{
    start_timeout();

    console.log("\nPreparing test #%d: %s", test_num, tests[test_num].name);
    console.log("    Nuking /mnt");

    emulator.fs9p.RecursiveDelete("");
    reload_fsjson();
}

function reload_fsjson()
{
    if(tests[test_num].use_fsjson)
    {
        console.log("    Reloading files from json");
        emulator.fs9p.OnJSONLoaded(testfsjson);
        emulator.fs9p.OnLoaded = () =>
        {
            do_mounts();
        };
    }
    else
    {
        do_mounts();
    }
}

function do_mounts()
{
    console.log("    Configuring mounts");
    if(tests[test_num].mounts && tests[test_num].mounts.length > 0)
    {
        premount(0);

        function premount(mount_num)
        {
            const path = tests[test_num].mounts[mount_num].path;
            emulator.serial0_send("mkdir -p /mnt" +  path + "\n");
            emulator.serial0_send("rmdir /mnt" +  path + "\n");
            emulator.serial0_send("echo done-premount\n");
            next_trigger = "done-premount";
            next_trigger_handler = () => mount(mount_num);
        }

        function mount(mount_num)
        {
            const { path, baseurl, basefs } = tests[test_num].mounts[mount_num];
            emulator.mount_fs(path, baseurl, basefs, err =>
            {
                if(err)
                {
                    log_warn("Failed to mount fs required for test %s: %s",
                        tests[test_num].name, err);
                    test_fail();
                }
                if(mount_num + 1 < tests[test_num].mounts.length)
                {
                    premount(mount_num + 1);
                }
                else
                {
                    if(test_has_failed)
                    {
                        report_test();
                    }
                    else
                    {
                        load_files();
                    }
                }
            });
        }
    }
    else
    {
        load_files();
    }
}

function load_files()
{
    console.log("    Loading additional files");
    if(tests[test_num].files)
    {
        let remaining = tests[test_num].files.length;
        for(const f of tests[test_num].files)
        {
            emulator.create_file(f.file, f.data, function(err)
            {
                if(err)
                {
                    log_warn("Failed to add file required for test %s: %s",
                        tests[test_num].name, err);
                    test_fail();
                }
                remaining--;
                if(!remaining)
                {
                    if(test_has_failed)
                    {
                        report_test();
                    }
                    else
                    {
                        start_test();
                    }
                }
            });
        }
    }
    else
    {
        start_test();
    }
}

function start_test()
{
    console.log("Starting test #%d: %s", test_num, tests[test_num].name);

    capture = "";

    tests[test_num].start();

    if(tests[test_num].capture_trigger)
    {
        next_trigger = tests[test_num].capture_trigger;
        next_trigger_handler = start_capture;
    }
    else
    {
        next_trigger = tests[test_num].end_trigger;
        next_trigger_handler = end_test;
    }
}

function start_capture()
{
    console.log("Capturing...");
    capture = "";
    capturing = true;

    next_trigger = tests[test_num].end_trigger;
    next_trigger_handler = end_test;
}

function end_test()
{
    capturing = false;

    if(tests[test_num].timeout)
    {
        clearTimeout(test_timeout);
    }

    tests[test_num].end(capture, report_test);
}

function report_test()
{
    if(!test_has_failed)
    {
        log_pass("Test #%d passed: %s", test_num, tests[test_num].name);
    }
    else
    {
        if(tests[test_num].allow_failure)
        {
            log_warn("Test #%d failed: %s (failure allowed)", test_num, tests[test_num].name);
        }
        else
        {
            log_fail("Test #%d failed: %s", test_num, tests[test_num].name);
        }
        test_has_failed = false;
    }

    test_num++;

    if(test_num < tests.length)
    {
        nuke_fs();
    }
    else
    {
        finish_tests();
    }
}

function finish_tests()
{
    emulator.stop();

    console.log("\nTests finished.");
    if(failed_tests.length == 0)
    {
        console.log("All tests passed");
    }
    else
    {
        let unallowed_failure = false;

        console.error("Failed %d out of %d tests:", failed_tests.length, tests.length);
        for(const num of failed_tests)
        {
            if(tests[num].allow_failure)
            {
                log_warn("#%d %s (failure allowed)", num, tests[num].name);
            }
            else
            {
                unallowed_failure = true;
                log_fail("#%d %s", num, tests[num].name);
            }
        }
        if(unallowed_failure)
        {
            process.exit(1);
        }
    }
}

emulator.bus.register("emulator-started", function()
{
    console.error("Booting now, please stand by");
});

emulator.add_listener("serial0-output-char", function(chr)
{
    if(chr < " " && chr !== "\n" && chr !== "\t" || chr > "~")
    {
        return;
    }

    let new_line = "";
    let is_new_line = false;
    if(chr === "\n")
    {
        is_new_line = true;
        new_line = line;
        line = "";
    }
    else
    {
        line += chr;
    }

    if(!ran_command && line.endsWith("~% "))
    {
        ran_command = true;
        nuke_fs();
    }
    else if(new_line === next_trigger)
    {
        next_trigger_handler();
    }
    else if(is_new_line && capturing)
    {
        capture += new_line + "\n";
        console.log("    Captured: %s", new_line);
    }
    else if(is_new_line)
    {
        console.log("    Serial: %s", new_line);
    }
});
