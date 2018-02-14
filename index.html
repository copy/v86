<!doctype html>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">

<title>Virtual x86</title>
<meta name="viewport" content="width=device-width,minimum-scale=1.0,maximum-scale=1.0,user-scalable=no">

<script src="build/v86_all.js"></script>
<link rel="stylesheet" href="v86.css">

<div>
    <div id="boot_options">
        <h4>Quickstart</h4>
        <input type="button" value="ReactOS (32 MB)" id="start_reactos">
        - Restored from snapshot<br>
        <input type="button" value="Windows 95 (6.7 MB)" id="start_windows95">
        - Restored from snapshot<br>
        <input type="button" value="FreeBSD 10.2 (13.0 MB)" id="start_freebsd">
        - Restored from snapshot<br>
        <input type="button" value="Oberon (16.0 MB)" id="start_oberon">
        - Native Oberon 2.3.6 (<a href="https://lists.inf.ethz.ch/pipermail/oberon/2013/006844.html">via</a>)<br>
        <input type="button" value="Windows 98 (12.0 MB)" id="start_windows98">
        - Including Minesweeper and audio, additional sectors are loaded as needed<br>
        <input type="button" value="Arch Linux (10.1 MB)" id="start_archlinux">
        - A complete Arch Linux restored from a snapshot, additional files are loaded as needed<br>
        <input type="button" value="KolibriOS (1.4 MB)" id="start_kolibrios">
        - Graphical OS, takes about 60 seconds to boot<br>
        <input type="button" value="Linux 2.6 (5.4 MB)" id="start_linux26">
        - With busybox, Lua interpreter and test cases, takes about 20 seconds to boot<br>
        <input type="button" value="Linux 3.18 (8.3 MB)" id="start_linux3">
        - With internet access, telnet, ping, wget and links. Takes about 60 seconds to boot. Run <code>udhcpc</code> for networking. Exchange files through <code>/mnt/</code>.<br>
        <input type="button" value="Windows 1.01 (1.4 MB)" id="start_windows1">
        - Takes 1 second to boot<br>
        <input type="button" value="MS-DOS 6.22 (3.4 MB)" id="start_msdos">
        - Takes 10 seconds to boot. With Enhanced Tools, QBasic and everything from the FreeDOS image<br>
        <input type="button" value="FreeDOS (0.7 MB)" id="start_freedos">
        - With nasm, vim, debug.com, some games and demos, takes 1 second to boot<br>
        <input type="button" value="OpenBSD (1.4 MB)" id="start_openbsd">
        - Random boot floppy, takes about 60 seconds<br>
        <input type="button" value="Solar OS (1.4 MB)" id="start_solos">
        - Simple graphical OS<br>
        <input type="button" value="Bootchess (0.2 MB)" id="start_bootchess">
        - A tiny chess program written in the boot sector

        <br>
        <hr>
        <h4>Setup</h4>
        <table>
            <tr>
                <td width="350">CD image</td>
                <td>
                    <input type="file" id="cd_image">
                </td>
            </tr>

            <tr>
                <td>Floppy disk image</td>
                <td> <input type="file" id="floppy_image"><br></td>
            </tr>

            <tr>
                <td>Hard drive disk image</td>
                <td><input type="file" id="hd_image"><br></td>
            </tr>

            <!--
            <tr>
                <td>Multiboot kernel image (experimental)</td>
                <td><input type="file" id="multiboot_image"><br></td>
            </tr>
            -->


            <tr>
                <td colspan="2"><small><small>Disk images are not uploaded to the server</small></small><hr></td>
            </tr>

            <tr>
                <td>Memory size</td>
                <td>
                    <input id="memory_size" type="number" value="128" min="16" max="2048" step="16"> MB<br>
                </td>
            </tr>

            <tr>
                <td>Video Memory size</td>
                <td>
                    <input id="video_memory_size" type="number" value="8" min="1" max="128" step="1"> MB<br>
                </td>
            </tr>

            <tr>
                <td colspan="2"><hr></td>
            </tr>

            <tr>
                <td>Boot order</td>
                <td>
                    <select id="boot_order">
                        <option value="213">CD / Floppy / Hard Disk</option>
                        <option value="123">CD / Hard Disk / Floppy</option>
                        <option value="231">Floppy / CD / Hard Disk</option>
                        <option value="321">Floppy / Hard Disk / CD</option>
                        <option value="312">Hard Disk / Floppy / CD</option>
                        <option value="132">Hard Disk / CD / Floppy</option>
                    </select>
                 </td>
            </tr>
        </table>

        <br>
        <button id="start_emulation">Start Emulation</button>
    </div>

    <div id="runtime_options" style="display: none">
        <input type="button" value="Pause" id="run">
        <input type="button" value="Reset" id="reset">
        <input type="button" value="Exit" id="exit">
        <input type="button" value="Send Ctrl-Alt-Del" id="ctrlaltdel">
        <input type="button" value="Send Alt-Tab" id="alttab">
        <input type="button" value="Get floppy image" id="get_fda_image">
        <input type="button" value="Get second floppy image" id="get_fdb_image">
        <input type="button" value="Get hard disk image" id="get_hda_image">
        <input type="button" value="Get second hard disk image" id="get_hdb_image">
        <input type="button" value="Get cdrom image" id="get_cdrom_image">
        <input type="button" value="Save State" id="save_state">
        <input type="button" value="Load State" id="load_state"> <input type="file" style="display: none" id="load_state_input">
        <input type="button" value="Memory Dump" id="memory_dump">
        <input type="button" value="Disable mouse" id="toggle_mouse">
        <input type="button" value="Lock mouse" id="lock_mouse">
        <input type="button" value="Go fullscreen" id="fullscreen">
        <input type="button" value="Take screenshot (only graphic modes)" id="take_screenshot">

        <label>
            Scale:
            <input type="number" min="0.25" step="0.25" value="1.0" id="scale" style="width: 50px">
        </label>

        <br>
        <label id="change_fda" style="display: none">
            Change floppy:
            <input type="file">
        </label>

        <label id="change_cdrom" style="display: none">
            Change CD:
            <input type="file">
        </label>

        <br>

    </div>
    <pre style="display: none" id="loading"></pre>
</div>


<div id="screen_container" style="display: none">
    <div id="screen"></div>
    <canvas id="vga"></canvas>
    <div style="position: absolute; top: 0; z-index: 10">
        <textarea class="phone_keyboard"></textarea>
    </div>
</div>


<div id="runtime_infos" style="display: none">
    Running: <span id="running_time">0s</span> <br>
    Speed: <span id="speed">0</span>kIPS<br>
    Avg speed: <span id="avg_speed">0</span>kIPS<br>
    <br>
    <div id="info_storage" style="display: none">
        <b>IDE device (HDA or CDROM)</b><br>
        Sectors read: <span id="info_storage_sectors_read">0</span><br>
        Bytes read: <span id="info_storage_bytes_read">0</span><br>
        Sectors written: <span id="info_storage_sectors_written">0</span><br>
        Bytes written: <span id="info_storage_bytes_written">0</span><br>
        Status: <span id="info_storage_status"></span><br>
        <br>
    </div>
    <div id="info_filesystem" style="display: none">
        <b>9p Filesystem</b><br>
        Bytes read: <span id="info_filesystem_bytes_read">0</span><br>
        Bytes written: <span id="info_filesystem_bytes_written">0</span><br>
        Last file: <span id="info_filesystem_last_file" style="word-wrap: break-word"></span><br>
        Status: <span id="info_filesystem_status"></span><br>
        <br>
    </div>
    <div id="info_network" style="display: none">
        <b>Network</b><br>
        Bytes received: <span id="info_network_bytes_received">0</span><br>
        Bytes transmitted: <span id="info_network_bytes_transmitted">0</span><br>
        <br>
    </div>
    <b>VGA</b><br>
    Mode: <span id="info_vga_mode"></span><br>
    Resolution: <span id="info_res">-</span><br>
    BPP: <span id="info_bpp">-</span><br>
    <br>
    Mouse: <span id="info_mouse_enabled">No</span><br>
    <!-- Keyboard: <span id="info_keyboard_enabled">-</span><br> -->

    <div id="description" style="display: none"></div>
</div>

<div id="filesystem_panel" style="display: none">
    <label title="Files will appear in / of the 9p filesystem">
        Send files to emulator<br>
        <input type="file" id="filesystem_send_file" multiple>
    </label>
    <br><br>
    <label>
        Get file from emulator<br>
        <input type="text" id="filesystem_get_file" placeholder="Absolute path">
    </label>
</div>

<br style="clear:both"><br>

<textarea cols="40" rows="12" id="serial" style="display: none">This is the serial console. Whatever you type or paste here will be sent to COM1.

In Linux it can be accessed with `cat /dev/ttyS0`
</textarea>

<br style="clear:both">
<code>Version: <a href="https://github.com/copy/v86/commits/53caefc">53caefc</a> (Jan 22, 2016 23:01)</a></code>

<hr>
<a href="debug.html">Enable debug</a>
&mdash;
<a href="https://github.com/copy/v86/blob/master/Readme.md">Readme</a>
&mdash;
<a href="https://github.com/copy/v86">Project on Github</a>
&mdash;
<a href="https://github.com/copy/v86#compatibility">Compatibility</a>
&mdash;
<a href="./screenshots/">Screenshots</a>


