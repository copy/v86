#!/usr/bin/env node
"use strict";

process.on("unhandledRejection", exn => { throw exn; });
const V86 = require("../../build/libv86-debug.js").V86;
const fs = require("fs");

const testfsjson = require('./testfs.json');

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

function assert_equal(actual, expected)
{
    if(actual !== expected)
    {
        log_warn("Failed assert equal (Test: %s)", tests[test_num].name);
        log_warn("Expected:\n" + expected);
        log_warn("Actual:\n" + actual);
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
        timeout: 10,
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
        timeout: 10,
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
        timeout: 10,
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
        timeout: 10,
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
        name: "Move",
        timeout: 10,
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
        timeout: 10,
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
        timeout: 10,
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
        timeout: 10,
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
        timeout: 10,
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
        timeout: 10,
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
        timeout: 10,
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
        timeout: 10,
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
        timeout: 10,
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
        timeout: 10,
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
        name: "Support for Full Security Capabilities",
        timeout: 10,
        allow_failure: true,
        // TODO: Delete the following. Better to use getfattr or getcap commands if available.
        // The following doesn't work with linux4.img yet.
        // Host machine also requires package libcap-dev:i386 to compile this.
        //files:
        //[
        //    {
        //        file: "test",
        //        data: new Uint8Array(child_process.execSync("gcc -xc -m32 -o /dev/stdout -static - -lcap",
        //            {
        //                input: `
        //                    #include <sys/capability.h>
        //                    #include <stdio.h>
        //                    int main(int argc, char *argv[])
        //                    {
        //                        cap_t cap = cap_get_file(argv[1]);
        //                        if(cap == NULL)
        //                        {
        //                            perror("Error accessing capabilities");
        //                            return 1;
        //                        }
        //                        char *text = cap_to_text(cap, NULL);
        //                        puts(text);
        //                        cap_free(cap);
        //                        cap_free(text);
        //                        return 0;
        //                    }
        //                `,
        //            }).buffer),
        //    },
        //],
        start: () =>
        {
            emulator.serial0_send("touch /mnt/file\n");
            emulator.serial0_send("chmod +x /mnt/test\n");
            emulator.serial0_send("echo start-capture;");
            emulator.serial0_send("/mnt/test /mnt/file;");
            emulator.serial0_send("echo done-xattr\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-xattr",
        end: (capture, done) =>
        {
            const EXPECTED_CAPABILITIES =
            [
                // In order of their values defined in linux/capability.h
                "cap_chown",
                "cap_dac_override",
                "cap_dac_read_search",
                "cap_fowner",
                "cap_fsetid",
                "cap_kill",
                "cap_setgid",
                "cap_setuid",
                "cap_setcap",
                "cap_linux_immutable",
                "cap_net_bind_service",
                "cap_net_broadcast",
                "cap_net_admin",
                "cap_net_raw",
                "cap_ipc_lock",
                "cap_ipc_owner",
                "cap_sys_module",
                "cap_sys_rawio",
                "cap_sys_chroot",
                "cap_sys_ptrace",
                "cap_sys_pacct",
                "cap_sys_admin",
                "cap_sys_boot",
                "cap_sys_nice",
                "cap_sys_resource",
                "cap_sys_time",
                "cap_sys_tty_config",
                "cap_mknod",
                "cap_lease",
                "cap_audit_write",
                "cap_audit_control",
                "cap_setfcap",

                // VFS_CAP_REVISION_1 can only set the first 32 capabilities
                // The rest is accessible via VFS_CAP_REVISION_2 or 3

                //"cap_mac_override",
                //"cap_mac_admin",
                //"cap_syslog",
                //"cap_wake_alarm",
                //"cap_block_suspend",
                //"cap_audit_read",
            ];
            const expected = "= " + EXPECTED_CAPABILITIES.join(",") + "+ip";
            assert_equal(capture, expected);
            done();
        },
    },
    {
        name: "Stress Files",
        timeout: 120,
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
        timeout: 120,
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
        timeout: 10,
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
    memory_size: 32 * 1024 * 1024,
    filesystem: {
        "baseurl": __dirname + "/testfs/",
    },
    log_level: 0,
});

let ran_command = false;
let line = "";
let capturing = false;
let capture = "";
let next_trigger;
let next_trigger_handler;

function nuke_fs()
{
    console.log("\nPreparing test #%d: %s", test_num, tests[test_num].name);
    console.log("    Nuking /mnt");
    emulator.serial0_send("rm -rf /mnt/*\n");
    emulator.serial0_send("echo prep-nuke-done\n");

    next_trigger = "prep-nuke-done";
    next_trigger_handler = tests[test_num].use_fsjson ? reload_fsjson : load_files;
}

function reload_fsjson()
{
    console.log("    Reloading files from json");
    emulator.fs9p.OnJSONLoaded(JSON.stringify(testfsjson));
    emulator.fs9p.OnLoaded = () =>
    {
        emulator.serial0_send("echo prep-fs-loaded\n");
    };

    next_trigger = "prep-fs-loaded";
    next_trigger_handler = load_files;
}

function load_files()
{
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
                    process.exit(1);
                }
                remaining--;
                if(!remaining)
                {
                    start_test();
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

    if(tests[test_num].timeout)
    {
        test_timeout = setTimeout(() =>
        {
            log_fail("Test #%d (%s) took longer than %s sec. Timing out and terminating.", test_num, tests[test_num].name, tests[test_num].timeout);
            process.exit(1);
        }, tests[test_num].timeout * 1000);
    }

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

    tests[test_num].end(capture, () =>
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
    });
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
