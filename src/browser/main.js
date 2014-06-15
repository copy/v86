"use strict";


(function()
{
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

        $("runtime_infos").appendChild(a);
    }
    function set_title(text)
    {
        document.title = text + " - Virtual x86" +  (DEBUG ? " - debug" : "");
    }

    function time2str(time)
    {
        if(time < 60)
        {
            return time + "s";
        }
        else if(time < 3600)
        {
            return (time / 60 | 0) + "m " + String.pad0(time % 60, 2) + "s";
        }
        else
        {
            return (time / 3600 | 0) + "h " + 
                String.pad0((time / 60 | 0) % 60, 2) + "m " + 
                String.pad0(time % 60, 2) + "s";
        }
    }

    function make_dom(obj)
    {
        var result;

        if(typeof obj === "string")
        {
            // create text node from string
            result = document.createTextNode(obj);
        }
        else if(typeof obj.length === "number")
        {
            // create list of elements
            result = document.createDocumentFragment();

            for(var i = 0; i < obj.length; i++)
            {
                result.appendChild(make_dom(obj[i]));
            }
        }
        else if(typeof obj === "object")
        {
            // create single element
            if(obj.tag === undefined)
            {
                throw "`tag` property required";
            }

            result = document.createElement(obj.tag);

            for(var property in obj)
            {
                switch(property)
                {
                    case "children":
                        result.appendChild(make_dom(obj.children));
                        break;
                    default:
                        result[property] = obj[property];
                }
            }
        }
        else
        {
            throw "Invalid type: " + typeof obj;
        }

        return result;
    }

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
                    log("Loading the image `" + filename + "` failed");
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

    /**
     * Synchronous access to File, loading blocks from the input type=file
     * The whole file is loaded into memory during initialisation
     *
     * @constructor
     */
    function SyncFileBuffer(file)
    {
        var PART_SIZE = 4 << 20,
            ready = false,
            me = this;

        this.byteLength = file.size;

        if(file.size > (1 << 30))
        {
            dbg_log("Warning: Allocating buffer of " + (file.size >> 20) + " MB ...");
        }

        var buffer = new ArrayBuffer(file.size),
            pointer = 0,
            filereader = new FileReader();

        // Here: Read all parts sequentially
        // Other option: Read all parts in parallel
        filereader.onload = function(e)
        {
            new Uint8Array(buffer, pointer).set(new Uint8Array(e.target.result));
            pointer += PART_SIZE;
            //dbg_log(PART_SIZE + " bytes of file read");
            next();
        };

        function next()
        {
            if(me.onprogress)
            {
                me.onprogress({
                    loaded: pointer,   
                    total: file.size,
                    lengthComputable: true,
                });
            }

            if(pointer < file.size)
            {
                filereader.readAsArrayBuffer(file.slice(pointer, Math.min(pointer + PART_SIZE, file.size)));
            }
            else
            {
                ready = true;

                if(me.onload)
                {
                    me.onload({
                        
                    });
                }
            }
        }
        next();

        this.get = function(start, len, fn)
        {
            if(ready)
            {
                dbg_assert(start + len <= buffer.byteLength);

                fn(new Uint8Array(buffer, start, len));
            }
            else
            {
                throw "SyncFileBuffer: Wait for ready";
            }
        };

        this.get_buffer = function(fn)
        {
            if(ready)
            {
                fn(buffer);
            }
            else
            {
                throw "SyncFileBuffer: Wait for ready";
            }
        };

        this.set = function(start, slice, fn)
        {
            if(ready)
            {
                dbg_assert(start + slice.length <= buffer.byteLength);

                new Uint8Array(buffer, start, slice.byteLength).set(slice);
                fn();
            }
            else
            {
                throw "SyncFileBuffer: Wait for ready";
            }
        };
    }

    /**
     * Asynchronous access to File, loading blocks from the input type=file
     *
     * @constructor
     */
    function AsyncFileBuffer(file)
    {
        var filereader = new FileReader,
            BLOCK_SIZE = 512;

        this.byteLength = file.size;

        // warning: fn may be called synchronously or asynchronously
        this.get = function(start, len, fn)
        {
            dbg_assert(!(start % BLOCK_SIZE));
            dbg_assert(!(len % BLOCK_SIZE));

            filereader.onload = function(e)
            {
                fn(new Uint8Array(e.target.result));
            };

            filereader.readAsArrayBuffer(file.slice(start, start + len));
        };

        this.get_buffer = function(fn)
        {
        };

        this.set = function(start, slice, fn)
        {
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

    function chr_repeat(chr, count)
    {
        var result = "";

        while(count-- > 0)
        {
            result += chr;
        }

        return result;
    }


    function show_progress(info, e)
    {
        var el = $("loading");
        el.style.display = "block";

        if(e.lengthComputable || (info.total && typeof e.loaded === "number"))
        {
            var per100 = e.loaded / (e.total || info.total) * 100 | 0;

            per100 = Math.min(100, Math.max(0, per100));

            el.textContent = info.msg + " " + per100 + "% [" + 
                chr_repeat("#", per100 >> 1) + 
                chr_repeat(" ", 50 - (per100 >> 1)) + "]";
        }
        else
        {
            if(!info.ticks)
                info.ticks = 0;

            el.textContent = info.msg + " " + chr_repeat(".", info.ticks++ % 50);
        }
    }

    function $(id)
    {
        if(!document.getElementById(id))
            console.log("Element with id `" + id + "` not found");

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

        function load_local(file, type, cont)
        {
            set_title(file.name);

            // SyncFileBuffer:
            // - loads the whole disk image into memory, impossible for large files (more than 1GB)
            // - can later serve get/set operations fast and synchronously 
            // - takes some time for first load, neglectable for small files (up to 100Mb)
            //
            // AsyncFileBuffer:
            // - loads slices of the file asynchronously as requested
            // - slower get/set
            // - doesn't support writing yet
            var loader = new SyncFileBuffer(file);

            loader.onprogress = show_progress.bind(this, { msg: "Loading disk image into memory" });

            loader.onload = function()
            {
                switch(type)
                {
                case "floppy": 
                   settings.fda = loader;
                   break;
                case "hd": 
                   settings.hda = loader;
                   break;
                case "cdrom": 
                   settings.cdrom = loader;
                   break;
                }
                cont();
            }
        }

        $("lock_mouse").onclick = function()
        {
            lock_mouse(document.body);
            $("lock_mouse").blur();
        };

        var biosfile;

        if(DEBUG)
        {
            biosfile = "seabios-debug.bin";
        }
        else
        {
            biosfile = "seabios.bin";
        }

        load_file("bios/" + biosfile, function(img)
        {
            settings.bios = img;
        });

        load_file("bios/vgabios.bin", function(img)
        {
            settings.vga_bios = img;
        });

        $("start_freedos").onclick = function()
        {
            load_file("images/freedos722.img", function(buffer)
            {
                settings.fda = new SyncBuffer(buffer);
                set_title("FreeDOS");
                init(settings);
            }, show_progress.bind(this, { msg: "Downloading image", total: 737280 }));

            $("start_freedos").blur();
            $("boot_options").style.display = "none";
        };

        $("start_win101").onclick = function()
        {
            load_file("images/windows101.img", function(buffer)
            {
                settings.fda = new SyncBuffer(buffer);
                set_title("Windows");
                init(settings);
            }, show_progress.bind(this, { msg: "Downloading image", total: 1474560 }));

            $("start_win101").blur();
            $("boot_options").style.display = "none";
        };


        $("start_linux").onclick = function()
        {
            load_file("images/linux.iso", function(buffer)
            {
                settings.cdrom = new SyncBuffer(buffer);
                set_title("Linux");
                init(settings);
            }, show_progress.bind(this, { msg: "Downloading image", total: 5632000 }));

            $("start_linux").blur();
            $("boot_options").style.display = "none";
        };

        $("start_koli").onclick = function()
        {
            load_file("images/kolibri.img", function(buffer)
            {
                settings.fda = new SyncBuffer(buffer);
                set_title("KolibriOS");
                init(settings);
            }, show_progress.bind(this, { msg: "Downloading image", total: 1474560 }));

            $("start_koli").blur();
            $("boot_options").style.display = "none";
        };

        $("start_bsd").onclick = function()
        {
            load_file("images/openbsd.img", function(buffer)
            {
                settings.fda = new SyncBuffer(buffer);
                set_title("OpenBSD");
                init(settings);
            }, show_progress.bind(this, { msg: "Downloading image", total: 1474560 }));

            $("start_bsd").blur();
            $("boot_options").style.display = "none";
        };

        $("start_sol").onclick = function()
        {
            load_file("images/os8.dsk", function(buffer)
            {
                settings.fda = new SyncBuffer(buffer);
                set_title("Sol OS");
                init(settings);
            }, show_progress.bind(this, { msg: "Downloading image", total: 1474560 }));

            $("start_sol").blur();
            $("boot_options").style.display = "none";
        };

        $("start_emulation").onclick = function()
        {
            $("boot_options").style.display = "none";

            var images = [];

            if($("floppy_image").files.length)
            {
                images.push({
                    file: $("floppy_image").files[0],
                    type: "floppy",
                });
            }

            if($("cd_image").files.length)
            {
                images.push({
                    file: $("cd_image").files[0],
                    type: "cdrom",
                });
            }

            if($("hd_image").files.length)
            {
                images.push({
                    file: $("hd_image").files[0],
                    type: "hd",
                });
            }

            function cont()
            {
                if(images.length === 0)
                {
                    init(settings);
                }
                else
                {
                    var obj = images.pop();

                    load_local(obj.file, obj.type, cont);
                }
            }

            cont();
        };

        if(DEBUG)
        {
            $("start_test").onclick = function()
            {
                return;
                settings.fda = new AsyncXHRBuffer("images/fd/freedos.part%d.img", 512, 720 * 1024);
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

            var log_levels = document.getElementById("log_levels"),
                count = 0,
                mask;

            for(var i in dbg_names)
            {
                mask = +i;

                if(mask == 1)
                    continue;

                var name = dbg_names[mask].toLowerCase(),
                    input = document.createElement("input"),
                    label = document.createElement("label")

                input.type = "checkbox";

                label.htmlFor = input.id = "log_" + name;

                if(LOG_LEVEL & mask)
                {
                    input.checked = true;
                }
                input.mask = mask;

                label.appendChild(input);
                label.appendChild(document.createTextNode(name + " "));
                log_levels.appendChild(label);
            }

            log_levels.onchange = function(e)
            {
                var target = e.target,
                    mask = target.mask;

                if(target.checked)
                {
                    LOG_LEVEL |= mask;
                }
                else
                {
                    LOG_LEVEL &= ~mask;
                }
            };
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
        if(!settings.bios || !settings.vga_bios)
        {
            log("The BIOS has not been loaded - reload the page to try again.");
            return;
        }

        var have_serial = true;

        var cpu = new v86(),
            screen_adapter = new ScreenAdapter();

        $("boot_options").style.display = "none";
        $("loading").style.display = "none";
        $("runtime_options").style.display = "block";
        $("runtime_infos").style.display = "block";
        document.getElementsByClassName("phone_keyboard")[0].style.display = "block";

        if($("news")) 
        {
            $("news").style.display = "none";
        }

        if(DEBUG)
        {
            $("step").onclick = function()
            { 
                cpu.debug.step();
            }

            $("run_until").onclick = function()
            {
                cpu.debug.run_until();
            };

            $("debugger").onclick = function()
            {
                cpu.debug.debugger();
            };

            $("dump_gdt").onclick = function()
            {
                cpu.debug.dump_gdt_ldt();
            };

            $("dump_idt").onclick = function()
            {
                cpu.debug.dump_idt();
            };

            $("dump_regs").onclick = function()
            {
                cpu.debug.dump_regs();
            };

            $("dump_pt").onclick = function()
            {
                cpu.debug.dump_page_directory();
            };

            $("dump_instructions").onclick = function()
            {
                cpu.debug.dump_instructions();
            };

            $("memory_dump").onclick = function()
            {
                dump_file(cpu.debug.get_memory_dump(), "memory.bin");
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

        var time = $("running_time"),
            ips = $("speed"),
            avg_ips = $("avg_speed"),
            last_tick = Date.now(),
            running_time = 0,
            summed_ips = 0,
            last_instr_counter = 0;

        function update_info()
        {
            if(!running)
            {
                return;
            }

            var now = Date.now(),
                last_ips = (cpu.timestamp_counter - last_instr_counter) / 1000 | 0;

            summed_ips += last_ips
            running_time += now - last_tick;
            last_tick = now;

            ips.textContent = last_ips;
            avg_ips.textContent = summed_ips / running_time * 1000 | 0;
            time.textContent = time2str(running_time / 1000 | 0);

            last_instr_counter = cpu.timestamp_counter;
        }

        function update_other_info()
        {
            if(!running)
            {
                return;
            }

            var vga_stats = cpu.devices.vga.stats;

            if(vga_stats.is_graphical)
            {
                $("info_vga_mode").textContent = "graphical";
                $("info_res").textContent = vga_stats.res_x + "x" + vga_stats.res_y;
                $("info_bpp").textContent = vga_stats.bpp;
            }
            else
            {
                $("info_vga_mode").textContent = "text";
                $("info_res").textContent = "-";
                $("info_bpp").textContent = "-";
            }

            if(settings.mouse_adapter)
            {
                $("info_mouse_enabled").textContent = 
                    settings.mouse_adapter.enabled ? "Yes" : "No";
            }

            if(cpu.devices.hda)
            {
                var hda_stats = cpu.devices.hda.stats;

                $("info_hda_sectors_read").textContent = hda_stats.sectors_read;
                $("info_hda_bytes_read").textContent = hda_stats.bytes_read;

                $("info_hda_sectors_written").textContent = hda_stats.sectors_written;
                $("info_hda_bytes_written").textContent = hda_stats.bytes_written;
            }
            else
            {
                $("info_hda").style.display = "none";
            }

            if(cpu.devices.cdrom)
            {
                var cdrom_stats = cpu.devices.cdrom.stats;

                $("info_cdrom_sectors_read").textContent = cdrom_stats.sectors_read;
                $("info_cdrom_bytes_read").textContent = cdrom_stats.bytes_read;
            }
            else
            {
                $("info_cdrom").style.display = "none";
            }
        }

        setInterval(update_info, 1000);
        setInterval(update_other_info, 2500);
        setTimeout(update_other_info, 100);

        $("reset").onclick = function()
        {
            cpu.restart();
            $("reset").blur();
        };

        // writable image types
        var image_types = ["hda", "hdb", "fda", "fdb"];

        for(var i = 0; i < image_types.length; i++)
        {
            var elem = $("get_" + image_types[i] + "_image");

            if(settings[image_types[i]])
            {
                elem.onclick = (function(type)
                {
                    var buffer = settings[type];

                    buffer.get_buffer(function(b)
                    {
                        dump_file(b, type + ".img");
                    });

                    this.blur();

                }).bind(elem, image_types[i]);
            }
            else
            {
                elem.style.display = "none";
            }
        }

        $("ctrlaltdel").onclick = function()
        {
            var ps2 = cpu.devices.ps2;

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

        $("screen_container").onclick = function()
        {
            document.getElementsByClassName("phone_keyboard")[0].focus();
        };

        $("take_screenshot").onclick = function()
        {
            screen_adapter.make_screenshot();

            $("take_screenshot").blur();
        };

        // avoid warnings
        settings.fdb = undefined;

        settings.screen_adapter = screen_adapter;
        settings.keyboard_adapter = new KeyboardAdapter();
        settings.mouse_adapter = new MouseAdapter();

        settings.boot_order = parseInt($("boot_order").value, 16);

        var memory_size = parseInt($("memory_size").value, 10) * 1024 * 1024;
        if(memory_size >= 16 * 1024 * 1024 && memory_size < 2048 * 1024 * 1024)
        {
            settings.memory_size = memory_size;
        }
        else
        {
            log("Invalid memory size - ignored.");
            settings.memory_size = 32 * 1024 * 1024;
        }

        var video_memory_size = parseInt($("video_memory_size").value, 10) * 1024 * 1024;
        if(video_memory_size > 64 * 1024 && video_memory_size < 2048 * 1024 * 1024)
        {
            settings.vga_memory_size = video_memory_size;
        }
        else
        {
            log("Invalid video memory size - ignored.");
            settings.vga_memory_size = 8 * 1024 * 1024;
        }

        if(have_serial)
        {
            settings.serial_adapter = new SerialAdapter($("serial"));
            $("serial").style.display = "block";
        }

        cpu.init(settings);
        cpu.run();
    }

})();
