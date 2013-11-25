"use strict";


// setImmediate for the browser
var next_tick, set_tick;

(function()
{
    var fn,
        host = location.protocol + "//" + location.host;

    set_tick = function(f)
    {
        fn = f;

        window.removeEventListener("message", tick_handler, false);
        window.addEventListener("message", tick_handler, false);
    };

    next_tick = function()
    {
        window.postMessage(null, host);
    };

    function tick_handler(e)
    {
        if(e.origin === host)
        {
            fn();
        }
    }
})();

function log(data)
{
    var log_element = document.getElementById("log");

    log_element.style.display = "block";
    log_element.textContent += data + "\n";
    log_element.scrollTop = 1e9;
}

function dump_text(text)
{
    var box = document.createElement("textarea");

    box.appendChild(document.createTextNode(text));
    document.body.appendChild(box);
}

function dump_file(ab, name)
{
    var blob = new Blob([ab]),
        a;

    a = document.createElement("a");
    a["download"] = name;
    a.href = window.URL.createObjectURL(blob),
    a.textContent = "Download " + name;
    a.onclick = function() { a.parentNode.removeChild(a); };

    a.dataset["downloadurl"] = ["application/octet-stream", a["download"], a.href].join(":");

    document.body.appendChild(a);
}

(function()
{

    /** @param {?=} progress */
    function load_file(filename, done, progress)
    {
        var http = new XMLHttpRequest();

        http.open("get", filename, true);
        http.responseType = "arraybuffer";

        http.onload = function(e)
        {
            if(http.readyState === 4)
            {
                if(http.status !== 200)
                {
                    log("Loading the image failed");
                }
                else if(http.response)
                {
                    done(http.response);
                }
            }
        };

        if(progress)
        {
            http.onprogress = function(e)
            {
                progress(e);
            };
        }
        
        http.send(null);
    }

    /**
     * Asynchronous access to ArrayBuffer, loading blocks lazily as needed.
     * This is just a prototype and partly incomplete.
     *
     * @constructor
     * @param {string} filename   Name of the file to download parts
     *                            from. Replaces %d with the block number (padded)
     */
    function AsyncXHRBuffer(filename, block_size, size)
    {
        var block_count = size / block_size,
            loaded_blocks,
            padding_width;

        dbg_assert(block_count === (block_count | 0));
        loaded_blocks = Array(block_count);
        
        padding_width = ("" + (block_count - 1)).length;

        this.byteLength = size;

        // warning: fn may be called synchronously or asynchronously
        this.get = function(start, len, fn)
        {
            // TODO: Unaligned read
            dbg_assert(start % block_size === 0);
            dbg_assert(len % block_size === 0);
            dbg_assert(len);

            var blocks_to_load = len / block_size,
                data,
                loaded_count = 0,
                start_block = start / block_size;

            if(blocks_to_load > 1)
            {
                // copy blocks in this buffer if there is more than one
                data = new Uint8Array(len);
            }

            for(var i = start_block; i < start_block + blocks_to_load; i++)
            {
                this.load_block(i, block_loaded);
            }

            function block_loaded(buffer, i)
            {
                var block = new Uint8Array(buffer);
                loaded_count++;

                if(blocks_to_load === 1)
                {
                    data = block;
                }
                else
                {
                    data.set(block, (i - start_block) * block_size);
                }

                if(loaded_count === blocks_to_load)
                {
                    fn(data);
                }
            }
        };

        this.load_block = function(i, fn)
        {
            var cached_block = loaded_blocks[i];

            if(cached_block === undefined)
            {
                var file = filename.replace("%d", String.pad0(i, padding_width));

                load_file(file, function(buffer)
                {
                    loaded_blocks[i] = buffer;
                    fn(buffer, i);
                });
            }
            else
            {
                fn(cached_block, i);
            }
        };

        this.get_buffer = function(fn)
        {
            // We must download all parts, unlikely a good idea for big files
            if(size > 32 * 1024 * 1024)
            {
                dbg_log("Warning: Downloading all parts of a huge file. Will probably " + 
                        "crash or never finish");
            }

            this.get(0, size, function(data)
            {
                return data.buffer;   
            });
        };

        this.set = function(start, slice, fn)
        {
            // Discard (we can't write to the server)
            // TODO: Put data into cache
        };
    }

    function lock_mouse(elem)
    {
        var fn = elem["requestPointerLock"] ||
                    elem["mozRequestPointerLock"] ||
                    elem["webkitRequestPointerLock"];

        if(fn)
        {
            fn.call(elem);
        }
    }

    function show_progress(e)
    {
        var el = $("loading");
        el.style.display = "block";

        if(e.lengthComputable)
        {
            var per50 = e.loaded / e.total * 50 | 0;

            el.textContent = "Loading: " + 2 * per50 + "% [" + 
                String.chr_repeat("#", per50) + 
                String.chr_repeat(" ", 50 - per50) + "]";
        }
        else
        {
            el.textContent = "Loading ...";
        }
    }

    function $(id)
    {
        return document.getElementById(id);
    }

    window.onload = function()
    {
        if(!("responseType" in new XMLHttpRequest))
        {
            log("Your browser is not supported because it doesn't have XMLHttpRequest.responseType");
            return;
        }

        var settings = {
            load_devices: true
        };


        $("lock_mouse").onclick = function()
        {
            lock_mouse(document.body);
            $("lock_mouse").blur();
        };

        load_file("bios/seabios.bin", function(img)
        {
            settings.bios = img;
        });

        load_file("bios/vgabios.bin", function(img)
        {
            settings.vga_bios = img;
        });

        function load_local(me, type)
        {
            if(me.files.length)
            {
                var reader = new FileReader();
                
                reader.onload = function(e)
                {
                    var buffer = new SyncBuffer(e.target.result);

                    switch(type)
                    {
                    case "floppy": 
                       settings.floppy_disk = buffer;
                       break;
                    case "hd": 
                       settings.hda_disk = buffer;
                       break;
                    case "cdrom": 
                       settings.cdrom_disk = buffer;
                       break;
                    }

                    init(settings);
                };
                
                //reader.readAsBinaryString($("file").files[0]);
                reader.readAsArrayBuffer(me.files[0]);
            }
        };

        $("floppy_image").onchange = function() 
        {
            load_local(this, "floppy"); 
        };

        $("cd_image").onchange = function() 
        {
            load_local(this, "cdrom");
        };

        $("hd_image").onchange = function() 
        {
            load_local(this, "hd");
        };

        $("start_freedos").onclick = function()
        {
            load_file("images/freedos722.img", function(buffer)
            {
                settings.floppy_disk = new SyncBuffer(buffer);
                init(settings);
            }, show_progress);

            $("start_freedos").blur();
            $("boot_options").style.display = "none";
        };

        $("start_win101").onclick = function()
        {
            load_file("images/windows101.img", function(buffer)
            {
                settings.floppy_disk = new SyncBuffer(buffer);
                init(settings);
            }, show_progress);

            $("start_win101").blur();
            $("boot_options").style.display = "none";
        };


        $("start_linux").onclick = function()
        {
            load_file("images/linux.iso", function(buffer)
            {
                settings.cdrom_disk = new SyncBuffer(buffer);
                init(settings);
            }, show_progress);

            $("start_linux").blur();
            $("boot_options").style.display = "none";
        };

        $("start_koli").onclick = function()
        {
            load_file("images/kolibri.img", function(buffer)
            {
                settings.floppy_disk = new SyncBuffer(buffer);
                init(settings);
            }, show_progress);

            $("start_koli").blur();
            $("boot_options").style.display = "none";
        };

        $("start_bsd").onclick = function()
        {
            load_file("images/openbsd.img", function(buffer)
            {
                settings.floppy_disk = new SyncBuffer(buffer);
                init(settings);
            }, show_progress);

            $("start_bsd").blur();
            $("boot_options").style.display = "none";
        };

        if(DEBUG)
        {
            $("start_test").onclick = function()
            {
                settings.floppy_disk = new AsyncXHRBuffer("images/fd/freedos.part%d.img", 512, 720 * 1024);
                init(settings);

                //settings.bios = settings.vga_bios = undefined;
                //settings.linux = {};
                ////settings.linux.cmdline = "console=ttyS0 root=/dev/hda ro init=/sbin/init notsc=1 hdb=none"
                //settings.linux.cmdline = "root=/dev/ram0 rw init=/sbin/init notsc=1";

                //load_file("images/linux/vmlinux.bin", function(buffer)
                //{
                //    settings.linux.vmlinux = buffer;
                //    load_file("images/linux/linuxstart.bin", function(buffer)
                //    {
                //        settings.linux.linuxstart = buffer;
                //        load_file("images/linux/root.bin", function(buffer)
                //        {
                //            settings.linux.root = buffer;
                //            init(settings);
                //        });
                //    });
                //});
            }
        }
    };

    // works in firefox and chromium
    if(document.readyState === "complete")
    {
        window.onload();
    }


    // load_external("https://dl.dropbox.com/example/freedos.img.js");
    function load_external(url)
    {
        window["loaded"] = function(bin_image)
        {
            var buffer = new ArrayBuffer(bin_image.length),
                buffer_array = new Uint8Array(buffer);

            for(var i = 0; i < bin_image.length; i++)
            {
                buffer_array[i] = bin_image.charCodeAt(i);
            }

            window["loaded"] = function() { 
                dbg_log("load_external: result loaded twice ?"); 
            };
        };

        var script = document.createElement("script");
        script.src = url;

        document.body.appendChild(script);
    }


    function init(settings)
    {
        var cpu = new v86(),
            screen_adapter = new ScreenAdapter();

        $("boot_options").parentNode.removeChild($("boot_options"));
        $("loading").style.display = "none";
        $("runtime_options").style.display = "block";
        document.getElementsByClassName("phone_keyboard")[0].style.display = "block";

        if(DEBUG)
        {
            $("step").onclick = function()
            { 
                debug.step();
            }

            $("run_until").onclick = function()
            {
                debug.run_until();
            };

            $("debugger").onclick = function()
            {
                debug.debugger();
            };
        }

        var running = true;

        $("run").onclick = function()
        {
            if(running)
            {
                running_time += Date.now() - last_tick;
                $("run").value = "Run";
                cpu.stop();
            }
            else
            {
                $("run").value = "Pause";
                cpu.run();
                last_tick = Date.now();
            }

            running = !running;
            $("run").blur();
        };

        var time = document.getElementById("running_time"),
            ips = document.getElementById("speed"),
            last_tick = Date.now(),
            running_time = 0,
            last_instr_counter = 0;

        function update_info()
        {
            if(running)
            {
                var now = Date.now();

                running_time += now - last_tick;
                last_tick = now;

                ips.textContent = (cpu.instr_counter - last_instr_counter) / 1000 | 0;
                time.textContent = (running_time / 1000 | 0);

                last_instr_counter = cpu.instr_counter;
            }
        }

        setInterval(update_info, 1000);

        $("reset").onclick = function()
        {
            cpu.restart();
            $("reset").blur();
        };

        $("get_floppy").onclick = function()
        {
            var buffer = cpu.dev.fdc.buffer;

            if(!buffer)
            {
                return;
            }

            buffer.get_buffer(function(b)
            {
                dump_file(b, "floppy.img");
            });

            $("get_floppy").blur();
        };

        $("ctrlaltdel").onclick = function()
        {
            var ps2 = cpu.dev.ps2;

            ps2.kbd_send_code(0x1D); // ctrl
            ps2.kbd_send_code(0x38); // alt
            ps2.kbd_send_code(0x53); // delete

            // break codes
            ps2.kbd_send_code(0x1D | 0x80); 
            ps2.kbd_send_code(0x38 | 0x80);
            ps2.kbd_send_code(0x53 | 0x80);

            $("ctrlaltdel").blur();
        };

        $("scale").onchange = function()
        {
            var n = parseFloat(this.value);

            if(n || n > 0)
            {
                screen_adapter.set_scale(n, n);
            }
            else
            {
                this.value = "1";
            }
        };

        $("fullscreen").onclick = function()
        {
            var elem = document.getElementById("screen_container"),

                // bracket notation because otherwise they get renamed by closure compiler
                fn = elem["requestFullScreen"] || 
                    elem["webkitRequestFullscreen"] || 
                    elem["mozRequestFullScreen"] || 
                    elem["msRequestFullScreen"];

            if(fn)
            {
                fn.call(elem);

                // This is necessary, because otherwise chromium keyboard doesn't work anymore.
                // Might (but doesn't seem to) break something else
                document.getElementsByClassName("phone_keyboard")[0].focus();
            }

            lock_mouse(elem);
        };

        settings.screen_adapter = screen_adapter;
        settings.keyboard_adapter = new KeyboardAdapter();
        settings.mouse_adapter = new MouseAdapter();

        cpu.init(settings);
        cpu.run();
    }

})();
