#!/usr/bin/env node
"use strict";

process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;

var V86 = require(`../../build/${TEST_RELEASE_BUILD ? "libv86" : "libv86-debug"}.js`).V86;
const fs = require("fs");

const testfsjson = require("./testfs.json");
const SHOW_LOGS = false;
const STOP_ON_FIRST_FAILURE = false;

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
            assert_not_equal(notfound3.parentid, -1, "notfound3 a/d parent id");
            const idx_a = notfound3.parentid;

            const notfound4 = emulator.fs9p.SearchPath("a/d/e");
            assert_equal(notfound4.id, -1, "notfound4 a/d/e id");
            assert_equal(notfound4.parentid, -1, "notfound4 a/d/e parentid");

            const dir1 = emulator.fs9p.SearchPath("a");
            assert_equal(dir1.id, idx_a, "dir1 a id");
            assert_equal(dir1.parentid, 0, "dir1 a parentid");

            const dir2 = emulator.fs9p.SearchPath("a/b/c");
            assert_not_equal(dir2.id, -1, "dir2 a/b/c id");
            assert_not_equal(dir2.parentid, -1, "dir2 a/b/c parentid");
            const idx_b = dir2.parentid;
            const idx_c = dir2.id;

            const file1 = emulator.fs9p.SearchPath("a/b/c/file1");
            assert_not_equal(file1.id, -1, "file1 a/b/c/file1 id");
            assert_equal(file1.parentid, idx_c, "file1 a/b/c/file1 parentid");

            const file2 = emulator.fs9p.SearchPath("file2");
            assert_not_equal(file2.id, -1, "file2 id");
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
        files:
        [
            {
                file: "target",
                data: test_file_small,
            },
        ],
        start: () =>
        {
            // Helper that prints filename followed by nlinks.
            emulator.serial0_send("nlinks() {\n");
            emulator.serial0_send(`  ls -dli $@ | awk '{ print "'$@' "$3 }'\n`);
            emulator.serial0_send("}\n");

            // Check nlinks before mkdir.
            emulator.serial0_send("nlinks /mnt | tee -a /mnt/target\n");

            emulator.serial0_send("mkdir /mnt/dir\n");
            emulator.serial0_send("echo other > /mnt/target2\n");

            // Check nlinks after mkdir.
            emulator.serial0_send("nlinks /mnt | tee -a /mnt/target\n");
            emulator.serial0_send("nlinks /mnt/dir | tee -a /mnt/target\n");
            emulator.serial0_send("nlinks /mnt/target | tee -a /mnt/target\n");

            // Create hard links.
            emulator.serial0_send("ln /mnt/target /mnt/link1\n");
            emulator.serial0_send("ln /mnt/link1 /mnt/dir/link2\n");
            emulator.serial0_send("ln /mnt/dir/link2 /mnt/dir/link3\n");
            emulator.serial0_send("ln /mnt/target2 /mnt/link-other\n");

            // Test inode numbers.
            emulator.serial0_send("{ test /mnt/target -ef /mnt/link1 && \n");
            emulator.serial0_send("  test /mnt/link1 -ef /mnt/dir/link2 && \n");
            emulator.serial0_send("  test /mnt/target -ef /mnt/dir/link3 && \n");
            emulator.serial0_send("  echo same inode | tee -a /mnt/target; }\n");
            emulator.serial0_send("{ test /mnt/link-other -ef /mnt/dir/link3 || \n");
            emulator.serial0_send("  echo different inode | tee -a /mnt/link1; }\n");

            // Check nlinks after hard links.
            emulator.serial0_send("nlinks /mnt | tee -a /mnt/dir/link2\n");
            emulator.serial0_send("nlinks /mnt/dir | tee -a /mnt/dir/link2\n");
            emulator.serial0_send("nlinks /mnt/target | tee -a /mnt/dir/link2\n");
            emulator.serial0_send("nlinks /mnt/dir/link2 | tee -a /mnt/dir/link2\n");
            emulator.serial0_send("nlinks /mnt/target2 | tee -a /mnt/dir/link2\n");
            emulator.serial0_send("nlinks /mnt/link-other | tee -a /mnt/dir/link2\n");

            // Movement and unlink.
            emulator.serial0_send("mv /mnt/link1 /mnt/link1-renamed\n");
            emulator.serial0_send("echo renamed | tee -a /mnt/link1-renamed\n");
            emulator.serial0_send("mv /mnt/dir/link2 /mnt/link2-moved\n");
            emulator.serial0_send("echo moved | tee -a /mnt/link2-moved\n");
            emulator.serial0_send("rm /mnt/target\n");
            emulator.serial0_send("echo unlinked original | tee -a /mnt/dir/link3\n");

            // Test inode numbers after movement and unlinking.
            emulator.serial0_send("{ test /mnt/link1-renamed -ef /mnt/link2-moved && \n");
            emulator.serial0_send("  test /mnt/link2-moved -ef /mnt/dir/link3 && \n");
            emulator.serial0_send("  echo same inode after mv | tee -a /mnt/link1-renamed; }\n");

            // Check nlinks after movement and unlinking.
            emulator.serial0_send("nlinks /mnt | tee -a /mnt/link2-moved\n");
            emulator.serial0_send("nlinks /mnt/dir | tee -a /mnt/link2-moved\n");
            emulator.serial0_send("nlinks /mnt/link1-renamed | tee -a /mnt/link2-moved\n");

            emulator.serial0_send("echo start-capture;\\\n");

            // Unlink the rest and output the above messages.
            emulator.serial0_send("rm /mnt/link1-renamed;\\\n");
            emulator.serial0_send("echo unlinked link1 >> /mnt/link2-moved;\\\n");
            emulator.serial0_send("nlinks /mnt/link2-moved >> /mnt/link2-moved;\\\n");
            emulator.serial0_send("rm /mnt/link2-moved;\\\n");
            emulator.serial0_send("echo unlinked link2 >> /mnt/dir/link3;\\\n");
            emulator.serial0_send("nlinks /mnt/dir/link3 >> /mnt/dir/link3;\\\n");
            emulator.serial0_send("cat /mnt/dir/link3;\\\n");
            emulator.serial0_send("rm /mnt/dir/link3;\\\n");

            // Verify nlinks of directories after unlinking hardlinks.
            emulator.serial0_send("nlinks /mnt;\\\n");
            emulator.serial0_send("nlinks /mnt/dir;\\\n");

            // Verify nlinks of root directory after subdirectory is unlinked.
            emulator.serial0_send("rmdir /mnt/dir;\\\n");
            emulator.serial0_send("nlinks /mnt;\\\n");

            emulator.serial0_send("echo done-hard-links\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-hard-links",
        end: (capture, done) =>
        {
            assert_equal(capture,
                test_file_small_string +
                "/mnt 2\n" +
                "/mnt 3\n" +
                "/mnt/dir 2\n" +
                "/mnt/target 1\n" +
                "same inode\n" +
                "different inode\n" +
                "/mnt 3\n" +
                "/mnt/dir 2\n" +
                "/mnt/target 4\n" +
                "/mnt/dir/link2 4\n" +
                "/mnt/target2 2\n" +
                "/mnt/link-other 2\n" +
                "renamed\n" +
                "moved\n" +
                "unlinked original\n" +
                "same inode after mv\n" +
                "/mnt 3\n" +
                "/mnt/dir 2\n" +
                "/mnt/link1-renamed 3\n" +
                "unlinked link1\n" +
                "/mnt/link2-moved 2\n" +
                "unlinked link2\n" +
                "/mnt/dir/link3 1\n" +
                "/mnt 3\n" +
                "/mnt/dir 2\n" +
                "/mnt 2\n");
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
        start: () =>
        {
            emulator.serial0_send("echo start-capture;");

            emulator.serial0_send("dd if=/dev/zero of=/mnt/file bs=1 count=137 status=none;");
            emulator.serial0_send("touch -t 200002022222 /mnt/file;");
            emulator.serial0_send("chmod =rw /mnt/file;");
            emulator.serial0_send("ls -l --full-time --color=never /mnt/file;");

            emulator.serial0_send("chmod +x /mnt/file;");
            emulator.serial0_send("chmod -w /mnt/file;");
            emulator.serial0_send("ln /mnt/file /mnt/file-link;");
            emulator.serial0_send("ls -l --full-time --color=never /mnt/file;");

            emulator.serial0_send("chmod -x /mnt/file;");
            emulator.serial0_send("truncate -s 100 /mnt/file;");
            emulator.serial0_send("touch -t 201011220344 /mnt/file;");
            emulator.serial0_send("rm /mnt/file-link;");
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
            assert_equal(outputs[1][1], "2");
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
            assert_equal(outputs[2][1], "1");
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
        allow_failure: true,
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
        name: "File Locks",
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("touch /mnt/file\n");
            emulator.serial0_send("touch /mnt/logs\n");
            emulator.serial0_send("mkfifo /mnt/fifo1\n");
            emulator.serial0_send("mkfifo /mnt/fifo2\n");

            emulator.serial0_send("flock -s /mnt/file -c 'cat /mnt/fifo1 >> /mnt/file' &\n");
            emulator.serial0_send("flock -s /mnt/file -c 'echo lock-shared-2 >> /mnt/file' \n");
            emulator.serial0_send("flock -xn /mnt/file -c 'echo lock unblocked! >> /mnt/logs' \n");
            emulator.serial0_send("echo lock-shared-1 > /mnt/fifo1\n");

            emulator.serial0_send("flock -x /mnt/file -c 'cat /mnt/fifo1 >> /mnt/file' &\n");
            emulator.serial0_send("flock -x /mnt/file -c 'echo lock-exclusive-2 >> /mnt/file' &\n");
            emulator.serial0_send("flock -sn /mnt/file -c 'echo lock unblocked! >> /mnt/logs' \n");
            emulator.serial0_send("echo lock-exclusive-1 > /mnt/fifo1\n");

            emulator.serial0_send("flock -sn /mnt/file -c 'cat /mnt/fifo1 >> /mnt/file' &\n");
            emulator.serial0_send("flock -s /mnt/file -c 'cat /mnt/fifo2 >> /mnt/file' &\n");
            emulator.serial0_send("flock -x /mnt/file -c 'echo lock-exclusive-3 >> /mnt/file' &\n");
            emulator.serial0_send("echo lock-shared-4 > /mnt/fifo2\n");
            emulator.serial0_send("echo lock-shared-3 > /mnt/fifo1\n");

            emulator.serial0_send("echo start-capture;\\\n");
            emulator.serial0_send("cat /mnt/file;\\\n");
            emulator.serial0_send("cat /mnt/logs;\\\n");
            emulator.serial0_send("echo done-locks\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-locks",
        end: (capture, done) =>
        {
            assert_equal(capture,
                "lock-shared-2\n" +
                "lock-shared-1\n" +
                "lock-exclusive-1\n" +
                "lock-exclusive-2\n" +
                "lock-shared-4\n" +
                "lock-shared-3\n" +
                "lock-exclusive-3\n");

            const idx = emulator.fs9p.Search(0, "file");

            const P9_LOCK_TYPE_RDLCK = 0;
            const P9_LOCK_TYPE_WRLCK = 1;
            const P9_LOCK_TYPE_UNLCK = 2;
            const P9_LOCK_SUCCESS = 0;
            const P9_LOCK_BLOCKED = 1;
            const CLIENT_ID = "under test";

            function test_getlock(num, type, pos, proc_id, locked)
            {
                const lock = emulator.fs9p.DescribeLock(type, pos, 1, proc_id, CLIENT_ID);
                const ret = emulator.fs9p.GetLock(idx, lock, 0);
                assert_equal(ret !== null, locked,
                    `getlock ${num}: type=${type}, pos=${pos}, proc_id=${proc_id}. Wrong state:`);
            }

            function test_lock(num, type, start, length, proc_id, status, lock_state)
            {
                console.log(`    Lock ${num}: type=${type}, start=${start}, length=${length} ` +
                    ` proc_id=${proc_id}, expected state=${lock_state}`);

                const lock = emulator.fs9p.DescribeLock(type, start, length, proc_id, CLIENT_ID);
                assert_equal(emulator.fs9p.Lock(idx, lock, 0), status, "Wrong status:");

                for(const [i, state] of [...lock_state].entries())
                {
                    switch(state)
                    {
                        case "1":
                            test_getlock(num, P9_LOCK_TYPE_WRLCK, i, 1, false);
                            test_getlock(num, P9_LOCK_TYPE_RDLCK, i, 2, false);
                            test_getlock(num, P9_LOCK_TYPE_WRLCK, i, 2, true);
                            break;
                        case "2":
                            test_getlock(num, P9_LOCK_TYPE_WRLCK, i, 2, false);
                            test_getlock(num, P9_LOCK_TYPE_RDLCK, i, 1, false);
                            test_getlock(num, P9_LOCK_TYPE_WRLCK, i, 1, true);
                            break;
                        case "3":
                            test_getlock(num, P9_LOCK_TYPE_RDLCK, i, 1, false);
                            test_getlock(num, P9_LOCK_TYPE_WRLCK, i, 1, true);
                            test_getlock(num, P9_LOCK_TYPE_RDLCK, i, 2, false);
                            test_getlock(num, P9_LOCK_TYPE_WRLCK, i, 2, true);
                            break;
                        case "e":
                            test_getlock(num, P9_LOCK_TYPE_RDLCK, i, 1, false);
                            test_getlock(num, P9_LOCK_TYPE_RDLCK, i, 2, true);
                            break;
                        case "E":
                            test_getlock(num, P9_LOCK_TYPE_RDLCK, i, 1, true);
                            test_getlock(num, P9_LOCK_TYPE_RDLCK, i, 2, false);
                            break;
                        case "-":
                            test_getlock(num, P9_LOCK_TYPE_WRLCK, i, 1, false);
                            test_getlock(num, P9_LOCK_TYPE_WRLCK, i, 2, false);
                            break;
                    }
                }
            }

            // Key:
            // 1/2/3 = shared lock by process 1/2/both
            // e/E   = exclusive lock by process 1/2
            // -     = no locks
            const I = Infinity;
            test_lock(0, P9_LOCK_TYPE_RDLCK, 0, 1, 1, P9_LOCK_SUCCESS, "1-------"); // First lock.
            test_lock(1, P9_LOCK_TYPE_RDLCK, 0, 2, 1, P9_LOCK_SUCCESS, "11------"); // Replace.
            test_lock(2, P9_LOCK_TYPE_RDLCK, 1, 1, 2, P9_LOCK_SUCCESS, "13------");
            test_lock(3, P9_LOCK_TYPE_RDLCK, 2, 2, 1, P9_LOCK_SUCCESS, "1311----"); // Skip. Merge before.
            test_lock(4, P9_LOCK_TYPE_WRLCK, 0, 1, 1, P9_LOCK_SUCCESS, "e311----"); // Shrink left.
            test_lock(5, P9_LOCK_TYPE_WRLCK, 1, 1, 1, P9_LOCK_BLOCKED, "e311----");
            test_lock(6, P9_LOCK_TYPE_UNLCK, 0, 4, 1, P9_LOCK_SUCCESS, "-2------"); // Delete.
            test_lock(7, P9_LOCK_TYPE_WRLCK, 1, 2, 1, P9_LOCK_BLOCKED, "-2------");
            test_lock(8, P9_LOCK_TYPE_UNLCK, 1, 3, 2, P9_LOCK_SUCCESS, "--------"); // Delete.
            test_lock(9, P9_LOCK_TYPE_WRLCK, 1, 1, 1, P9_LOCK_SUCCESS, "-e------");
            test_lock(10, P9_LOCK_TYPE_RDLCK, 3, 3, 1, P9_LOCK_SUCCESS, "-e-111--"); // Skip.
            test_lock(11, P9_LOCK_TYPE_RDLCK, 2, 1, 2, P9_LOCK_SUCCESS, "-e2111--"); // Skip past.
            test_lock(12, P9_LOCK_TYPE_UNLCK, 2, 1, 2, P9_LOCK_SUCCESS, "-e-111--"); // Delete.
            test_lock(13, P9_LOCK_TYPE_WRLCK, 0, 1, 1, P9_LOCK_SUCCESS, "ee-111--");
            test_lock(14, P9_LOCK_TYPE_WRLCK, 1, 4, 1, P9_LOCK_SUCCESS, "eeeee1--"); // Merge before. Shrink both ways.
            test_lock(15, P9_LOCK_TYPE_WRLCK, 1, 2, 2, P9_LOCK_BLOCKED, "eeeee1--");
            test_lock(16, P9_LOCK_TYPE_RDLCK, 4, 5, 2, P9_LOCK_BLOCKED, "eeeee1--");
            test_lock(17, P9_LOCK_TYPE_RDLCK, 5, I, 2, P9_LOCK_SUCCESS, "eeeee322");
            test_lock(18, P9_LOCK_TYPE_UNLCK, 0, I, 1, P9_LOCK_SUCCESS, "-----222"); // Replace.
            test_lock(19, P9_LOCK_TYPE_RDLCK, 4, I, 2, P9_LOCK_SUCCESS, "----2222"); // Replace.
            test_lock(20, P9_LOCK_TYPE_WRLCK, 2, I, 2, P9_LOCK_SUCCESS, "--EEEEEE"); // Replace.
            test_lock(21, P9_LOCK_TYPE_WRLCK, 0, 1, 2, P9_LOCK_SUCCESS, "E-EEEEEE");
            test_lock(22, P9_LOCK_TYPE_WRLCK, 1, 3, 2, P9_LOCK_SUCCESS, "EEEEEEEE"); // Merge both. Shrink left.
            test_lock(23, P9_LOCK_TYPE_RDLCK, 3, 4, 2, P9_LOCK_SUCCESS, "EEE2222E"); // Split.
            test_lock(24, P9_LOCK_TYPE_RDLCK, 1, 2, 2, P9_LOCK_SUCCESS, "E222222E"); // Merge after. Shrink right.
            test_lock(25, P9_LOCK_TYPE_RDLCK, 2, 3, 2, P9_LOCK_SUCCESS, "E222222E"); // No-op.

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
            emulator.serial0_send("echo foobar > /mnt/fs3/file\n");
            emulator.serial0_send("mkdir /mnt/a/b/fs2/dir\n");
            emulator.serial0_send("mkdir /mnt/fs3/fs4/fs5/otherdir\n");
            emulator.serial0_send("echo contents > /mnt/a/b/fs2/dir/child\n");

            // Using tail -f to keep 'file' open for modification in bg while it is being moved.
            // Using fifo to send data from fg job to bg job to write to file.
            emulator.serial0_send("mkfifo /mnt/fs3/fifo\n");
            emulator.serial0_send("mkfifo /mnt/fs3/fifo_intermediate\n");
            emulator.serial0_send("tail -f /mnt/fs3/fifo > /mnt/fs3/fifo_intermediate &\n");
            emulator.serial0_send('echo "$!" > /mnt/tailpid\n');
            emulator.serial0_send('{ sed "/EOF/q" < /mnt/fs3/fifo_intermediate && kill "$(cat /mnt/tailpid)"; } >> /mnt/fs3/file &\n');

            emulator.serial0_send("echo start-capture; \\\n");
            emulator.serial0_send("echo untouched > /mnt/fs3/fifo; \\\n");

            // File from forwarder to non-forwarder. Divert forwarder file.
            emulator.serial0_send("{ mv /mnt/fs3/file /mnt/file1 &&");
            emulator.serial0_send("  echo file jump to root > /mnt/fs3/fifo; }; \\\n");

            // File from non-forwarder to forwarder. Divert non-forwarder file.
            emulator.serial0_send("{ mv /mnt/file1 /mnt/fs3/file2 &&");
            emulator.serial0_send("  echo file jump filesystems > /mnt/fs3/fifo; }; \\\n");

            // File rename within the same foreign filesystem. Divert non-forwarder file.
            emulator.serial0_send("{ mv /mnt/fs3/file2 /mnt/fs3/file3 && ");
            emulator.serial0_send("  echo file renamed > /mnt/fs3/fifo; }; \\\n");

            // File from forwarder to forwarder under directory. Divert forwarder file.
            emulator.serial0_send("{ mv /mnt/fs3/file3 /mnt/a/b/fs2/dir/file4 && ");
            emulator.serial0_send("  echo file move to dir > /mnt/fs3/fifo; }; \\\n");

            // Directory from forwarder to forwarder.
            emulator.serial0_send("{ mv /mnt/a/b/fs2/dir /mnt/fs3/fs4/fs5/dir1 && ");
            emulator.serial0_send("  echo dir jump filesystems > /mnt/fs3/fifo; }; \\\n");

            // Moving mountpoint across filesystems.
            emulator.serial0_send("{ mv /mnt/fs3/fs4 /mnt/a/b/fs2/fs4 2>/dev/null || ");
            emulator.serial0_send("  echo move mount point across - fails > /mnt/fs3/fifo; }; \\\n");
            emulator.serial0_send("{ mv /mnt/fs3/fs4/fs5 /mnt/fs5 2>/dev/null || ");
            emulator.serial0_send("  echo move mount point upwards - fails > /mnt/fs3/fifo; }; \\\n");

            // Directory move within the same foreign filesystem.
            emulator.serial0_send("{ mv /mnt/fs3/fs4/fs5/dir1 /mnt/fs3/fs4/fs5/otherdir/dir2 && ");
            emulator.serial0_send("  echo dir move > /mnt/fs3/fifo; }; \\\n");

            // Directory from forwarder to non-forwarder. Divert forwarder directory.
            emulator.serial0_send("{ mv /mnt/fs3/fs4/fs5/otherdir/dir2 /mnt/dir3 && ");
            emulator.serial0_send("  echo dir jump to root > /mnt/fs3/fifo; }; \\\n");

            // Directory from non-forwarder to forwarder. Divert non-forwarder directory.
            emulator.serial0_send("{ mv /mnt/dir3 /mnt/fs3/fs4/dir4 && ");
            emulator.serial0_send("  echo dir jump back > /mnt/fs3/fifo; }; \\\n");

            // Moving empty file (treated differently when rewriting data.
            emulator.serial0_send("touch /mnt/a/b/fs2/emptyfile; \\\n");
            emulator.serial0_send("{ mv /mnt/a/b/fs2/emptyfile /mnt/fs3/fs4/dir4/emptyfile && ");
            emulator.serial0_send("  echo move empty file > /mnt/fs3/fifo; }; \\\n");
            emulator.serial0_send("cat /mnt/fs3/fs4/dir4/emptyfile; \\\n");

            emulator.serial0_send('printf "EOF\\n\\n" > /mnt/fs3/fifo & wait "$(cat /mnt/tailpid)" 2>/dev/null; \\\n');
            emulator.serial0_send("cat /mnt/fs3/fs4/dir4/file4; \\\n");
            emulator.serial0_send("cat /mnt/fs3/fs4/dir4/child; \\\n");
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
                "file jump to root\n" +
                "file jump filesystems\n" +
                "file renamed\n" +
                "file move to dir\n" +
                "dir jump filesystems\n" +
                "move mount point across - fails\n" +
                "move mount point upwards - fails\n" +
                "dir move\n" +
                "dir jump to root\n" +
                "dir jump back\n" +
                "move empty file\n" +
                "EOF\n" +
                "contents\n" +
                "/mnt\n" +
                "/mnt/a\n" +
                "/mnt/a/b\n" +
                "/mnt/a/b/fs2\n" +
                "/mnt/fs3\n" +
                "/mnt/fs3/fifo\n" +
                "/mnt/fs3/fifo_intermediate\n" +
                "/mnt/fs3/fs4\n" +
                "/mnt/fs3/fs4/dir4\n" +
                "/mnt/fs3/fs4/dir4/child\n" +
                "/mnt/fs3/fs4/dir4/emptyfile\n" +
                "/mnt/fs3/fs4/dir4/file4\n" +
                "/mnt/fs3/fs4/fs5\n" +
                "/mnt/fs3/fs4/fs5/otherdir\n" +
                "/mnt/tailpid\n");
            done();
        },
    },
    {
        name: "Hard Links Mounted",
        timeout: 60,
        mounts:
        [
            { path: "/fs1a" },
            { path: "/fs1a/fs2" },
            { path: "/fs1b" },
        ],
        start: () =>
        {
            emulator.serial0_send("echo foobar > /mnt/fs1a/file\n");

            emulator.serial0_send("echo start-capture;\\\n");

            emulator.serial0_send("{ ln /mnt/fs1a/file /mnt/fs1a/fs2/link-child 2>/dev/null || \n");
            emulator.serial0_send("  echo link at child fs - fails >> /mnt/fs1a/file; };\\\n");

            emulator.serial0_send("{ ln /mnt/fs1a/file /mnt/link-parent 2>/dev/null || \n");
            emulator.serial0_send("  echo link at parent fs - fails >> /mnt/fs1a/file; };\\\n");

            emulator.serial0_send("ln /mnt/fs1a/file /mnt/fs1a/link;\\\n");
            emulator.serial0_send("echo link at common fs >> /mnt/fs1a/link;\\\n");

            emulator.serial0_send("mv /mnt/fs1a/link /mnt/fs1a/link2;\\\n");
            emulator.serial0_send("echo rename >> /mnt/fs1a/link2;\\\n");

            emulator.serial0_send("{ mv /mnt/fs1a/link2 /mnt/link3 2>/dev/null || \n");
            emulator.serial0_send("  echo jump to parent - fails >> /mnt/fs1a/link2; };\\\n");

            emulator.serial0_send("{ mv /mnt/fs1a/link2 /mnt/fs1b/link3 2>/dev/null || \n");
            emulator.serial0_send("  echo jump outside - fails >> /mnt/fs1a/link2; };\\\n");

            emulator.serial0_send("cat /mnt/fs1a/file;\\\n");
            emulator.serial0_send("echo done-hard-links-mounted\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-hard-links-mounted",
        end: (capture, done) =>
        {
            assert_equal(capture,
                "foobar\n" +
                "link at child fs - fails\n" +
                "link at parent fs - fails\n" +
                "link at common fs\n" +
                "rename\n" +
                "jump to parent - fails\n" +
                "jump outside - fails\n");
            done();
        },
    },
    {
        name: "Using '..' across filesystems",
        timeout: 60,
        mounts:
        [
            { path: "/a/fs2" },
        ],
        start: () =>
        {
            emulator.serial0_send("mkdir /mnt/a/fs2/c\n");
            emulator.serial0_send("echo foobar > /mnt/a/fs2/../file\n");
            emulator.serial0_send("cd /mnt/a/fs2/c\n");
            emulator.serial0_send("echo baz >> ../../file\n");
            emulator.serial0_send("mv /mnt/a/file ../../renamed\n");
            emulator.serial0_send("cp /mnt/a/renamed ../../file\n");

            emulator.serial0_send("echo start-capture;\\\n");

            emulator.serial0_send("cat /mnt/a/file;\\\n");
            emulator.serial0_send("cat /mnt/a/renamed;\\\n");
            emulator.serial0_send("rm ../../renamed;\\\n");
            emulator.serial0_send("test ! -e /mnt/a/renamed && echo removed;\\\n");

            emulator.serial0_send("cd /;\\\n");
            emulator.serial0_send("echo done-readdir-parent-mount\n");
        },
        capture_trigger: "start-capture",
        end_trigger:"done-readdir-parent-mount",
        end: (capture, done) =>
        {
            assert_equal(capture,
                "foobar\n" +
                "baz\n" +
                "foobar\n" +
                "baz\n" +
                "removed\n");
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
    memory_size: 64 * 1024 * 1024,
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
        emulator.fs9p.load_from_json(testfsjson, () => do_mounts());
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

            if(STOP_ON_FIRST_FAILURE)
            {
                finish_tests();
            }
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
