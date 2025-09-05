#!/usr/bin/env node

import url from "node:url";
import fs from "node:fs";

process.on("unhandledRejection", exn => { throw exn; });

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const testfsjson = JSON.parse(fs.readFileSync(__dirname + "/testfs.json", "utf-8"));
const SHOW_LOGS = false;
const STOP_ON_FIRST_FAILURE = false;

function assert_equal(actual, expected, message)
{
    if(actual !== expected)
    {
        console.warn("Failed assert equal (Test: %s). %s", tests[test_num].name, message || "");
        console.warn("Expected:\n" + expected);
        console.warn("Actual:\n" + actual);
        test_fail();
    }
}

function assert_not_equal(actual, expected, message)
{
    if(actual === expected)
    {
        console.warn("Failed assert not equal (Test: %s). %s", tests[test_num].name, message || "");
        console.warn("Expected something different than:\n" + expected);
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
        name: "Read Existing",
        timeout: 60,
        start: () =>
        {
            emulator.serial0_send("cp /etc/profile /mnt/read-existing\n");
            emulator.serial0_send("echo start-capture; cat /etc/profile; echo done-read-existing\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-read-existing",
        end: async (capture, done) =>
        {
            const data = await emulator.read_file("read-existing");
            assert_equal(capture, Buffer.from(data).toString());
            done();
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
        end: async (capture, done) =>
        {
            const data = await emulator.read_file("read-new");
            assert_equal(data.length, 512 * 1024);
            if(data.find(v => v !== 0))
            {
                console.warn("Fail: Incorrect data. Expected all zeros.");
                test_fail();
            }
            done();
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
        end: async (capture, done) =>
        {
            assert_equal(capture, "bar\n");
            const data = await emulator.read_file("foo");
            assert_equal(Buffer.from(data).toString(), "bar\n");
            done();
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
        end: async (capture, done) =>
        {
            const data = await emulator.read_file("testfifo-output");
            assert_equal(Buffer.from(data).toString(), "fifomessage\n");
            done();
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
        end: async (capture, done) =>
        {
            const data = await emulator.read_file("a-dir/e-file");
            assert_equal(Buffer.from(data).toString(), "mkdirfoobar\n");
            done();
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
                console.warn("Wrong format: %s", capture);
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
                console.warn("Wrong format (expected 3 rows): %s", capture);
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
            emulator.serial0_send("setfattr --remove=security.capability /mnt/file;");

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
            emulator.serial0_send("setfattr --remove=security.capability /mnt/file\n");

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
            emulator.serial0_send("sleep 0.1\n");
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
            emulator.serial0_send("rm /mnt/stress-files/file-*\n");
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
        baseurl: __dirname + "/testfs/",
    },
    disable_jit: +process.env.DISABLE_JIT,
    log_level: SHOW_LOGS ? 0x400000 : 0,
});

let ran_command = false;
let line = "";
let capturing = false;
let capture = "";
let next_trigger;
let next_trigger_handler;

async function prepare_test()
{
    console.log("\nPreparing test #%d: %s", test_num, tests[test_num].name);

    if(tests[test_num].timeout)
    {
        test_timeout = setTimeout(() =>
        {
            console.error("[-] Test #%d (%s) took longer than %s sec. Timing out and terminating.", test_num, tests[test_num].name, tests[test_num].timeout);
            process.exit(1);
        }, tests[test_num].timeout * 1000);
    }

    console.log("    Nuking /mnt");
    emulator.fs9p.RecursiveDelete("");

    if(tests[test_num].use_fsjson)
    {
        console.log("    Reloading files from json");
        emulator.fs9p.load_from_json(testfsjson);
    }

    console.log("    Loading additional files");
    if(tests[test_num].files)
    {
        let remaining = tests[test_num].files.length;
        for(const f of tests[test_num].files)
        {
            await emulator.create_file(f.file, f.data);
        }
    }

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
        console.log("[+] Test #%d passed: %s", test_num, tests[test_num].name);
    }
    else
    {
        if(tests[test_num].allow_failure)
        {
            console.warn("Test #%d failed: %s (failure allowed)", test_num, tests[test_num].name);
        }
        else
        {
            console.error("[-] Test #%d failed: %s", test_num, tests[test_num].name);

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
        prepare_test();
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
    if(failed_tests.length === 0)
    {
        console.log("All tests passed");
    }
    else
    {
        let unallowed_failure = false;

        console.error("[-] Failed %d out of %d tests:", failed_tests.length, tests.length);
        for(const num of failed_tests)
        {
            if(tests[num].allow_failure)
            {
                console.warn("#%d %s (failure allowed)", num, tests[num].name);
            }
            else
            {
                unallowed_failure = true;
                console.error("[-] #%d %s", num, tests[num].name);
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
    console.log("Booting now, please stand by");
});

emulator.add_listener("serial0-output-byte", function(byte)
{
    var chr = String.fromCharCode(byte);
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
        prepare_test();
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
