"use strict";

(function()
{
    // based on https://github.com/Raynos/after
    // All the flow control you'll ever need
    function after(count, callback) 
    {
        proxy.count = count;
        var result = {};

        return (count === 0) ? callback() : proxy;

        function proxy(data) {
            if(proxy.count <= 0) 
            {
                throw new Error("after called too many times");
            }
            proxy.count--;

            if(data)
            {
                var keys = Object.keys(data);
                for(var i = 0; i < keys.length; i++)
                {
                    result[keys[i]] = data[keys[i]];
                }
            }

            if(proxy.count === 0) 
            {
                callback(result);
            }
        }
    }

    function dump_file(ab, name)
    {
        var blob = new Blob([ab]);

        var a = document.createElement("a");
        a["download"] = name;
        a.href = window.URL.createObjectURL(blob),
        a.dataset["downloadurl"] = ["application/octet-stream", a["download"], a.href].join(":");
        
        if(document.createEvent)
        {
            var ev = document.createEvent("MouseEvent");
            ev.initMouseEvent("click", true, true, window, 0, 0, 0, 0, 0, false, false, false, false, 0, null);
            a.dispatchEvent(ev);
        }
        else
        {
            a.click();
        }
    }

    /** 
     * @return {Object.<string, string>}
     */
    function get_query_arguments()
    {
        var query = location.search.substr(1).split("&");
        var parameters = {};

        for(var i = 0; i < query.length; i++)
        {
            var param = query[i].split("=");
            parameters[param[0]] = decodeURIComponent(param[1]);
        }

        return parameters;
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
        var el = document.getElementById(id);

        if(!el)
        {
            console.log("Element with id `" + id + "` not found");
        }

        return el;
    }

    function onload()
    {
        if(!("responseType" in new XMLHttpRequest))
        {
            alert("Your browser is not supported because it doesn't have XMLHttpRequest.responseType");
            return;
        }

        var settings = {
            load_devices: true
        };

        function load_local(file, type, cb)
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

            // Heuristics: If file is smaller than 64M, use SyncFileBuffer
            if(file.size < 64 * 1024 * 1024)
            {
                var loader = new v86util.SyncFileBuffer(file);
                loader.onprogress = show_progress.bind(this, { msg: "Loading disk image into memory" });
            }
            else
            {
                var loader = new v86util.AsyncFileBuffer(file);
            }

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
                cb();
            }

            loader.load();
        }

        $("toggle_mouse").onclick = function()
        {
            var mouse_adapter = settings.mouse_adapter;

            if(mouse_adapter)
            {
                var state = mouse_adapter.emu_enabled = !mouse_adapter.emu_enabled;

                $("toggle_mouse").value = (state ? "Dis" : "En") + "able mouse";
            }
        };

        $("lock_mouse").onclick = function()
        {
            var mouse_adapter = settings.mouse_adapter;

            if(mouse_adapter && !mouse_adapter.emu_enabled)
            {
                $("toggle_mouse").onclick();
            }

            lock_mouse(document.body);
            $("lock_mouse").blur();
        };

        var biosfile = DEBUG ? "seabios-debug.bin" : "seabios.bin";
        var vgabiosfile = DEBUG ? "vgabios-0.7a.debug.bin" : "bochs-vgabios-0.7a.bin";

        v86util.load_file("bios/" + biosfile, function(img)
        {
            settings.bios = img;
            start_emulation();
        });

        v86util.load_file("bios/" + vgabiosfile, function(img)
        {
            settings.vga_bios = img;
            start_emulation();
        });

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

            var cont = after(images.length, function(result)
            {
                start_emulation({ 
                    settings: settings,
                    done: function(e) { e.run(); },
                });
            });

            images.forEach(function(image)
            {
                load_local(image.file, image.type, cont);
            });
        };

        if(DEBUG)
        {
            debug_onload(settings);
        }

        var oses = [
            //{
            //    id: "archlinux",
            //    state: "http://localhost/v86-images/v86state.bin",
            //    //size: 137 * 1024 * 1024,
            //    size: 75550474,
            //    name: "Arch Linux",
            //    memory_size: 64 * 1024 * 1024,
            //    vga_memory_size: 8 * 1024 * 1024,
            //    async_hda: "http://localhost/v86-images/arch3.img",
            //    async_hda_size: 8 * 1024 * 1024 * 1024,
            //    filesystem: {
            //        basefs: "http://localhost/v86-images/fs.json",
            //        baseurl: "http://localhost/v86-images/arch/",
            //    },
            //},
            {
                id: "freedos",
                fda: "images/freedos722.img",
                size: 737280,
                name: "FreeDOS",
            },
            {
                id: "windows1",
                fda: "images/windows101.img",
                size: 1474560,
                name: "Windows",
            },
            {
                id: "linux26",
                cdrom: "images/linux.iso",
                size: 5666816,
                name: "Linux",
            },
            //{
            //    id: "nanolinux",
            //    cdrom: "images/nanolinux-1.2.iso",
            //    size: 14047232,
            //    name: "Nanolinux",
            //},
            {
                id: "kolibrios",
                fda: "images/kolibri.img",
                size: 1474560,
                name: "KolibriOS",
            },
            {
                id: "openbsd",
                fda: "images/openbsd.img",
                size: 1474560,
                name: "OpenBSD",
            },
            {
                id: "solos",
                fda: "images/os8.dsk",
                size: 1474560,
                name: "Sol OS",
            },
        ];

        var query_args = get_query_arguments();
        var profile = query_args["profile"];

        for(var i = 0; i < oses.length; i++)
        {
            var infos = oses[i];
            var dom_id = "start_" + infos.id;

            $(dom_id).onclick = function(infos, dom_id)
            {
                if(window.history.pushState)
                {
                    window.history.pushState({ profile: infos.id }, "", "?profile=" + infos.id);
                }

                $(dom_id).blur();

                start_profile(infos);
            }.bind(this, infos, dom_id);

            if(profile === infos.id)
            {
                start_profile(infos);
                return;
            }
        }

        function start_profile(infos)
        {
            var message = { msg: "Downloading image", total: infos.size };
            var image = infos.state || infos.fda || infos.cdrom;

            var start = after(1, function(result)
            {
                loaded(infos, settings, result.buffer);
            });

            v86util.load_file(
                image, 
                function(buffer)
                {
                    start({ buffer: buffer });
                },
                show_progress.bind(this, message)
            );

            if(infos.filesystem)
            {
                settings.fs9p = new FS(infos.filesystem.baseurl);

                if(infos.filesystem.basefs)
                {
                    start.count++;
                    settings.fs9p.OnLoaded = start;

                    settings.fs9p.LoadFilesystem({
                        lazyloadimages: [],
                        earlyload: [],
                        basefsURL: infos.filesystem.basefs,
                    });
                }
            }

            set_title(infos.name);
            $("boot_options").style.display = "none";
        }

        function loaded(infos, settings, buffer)
        {
            settings.memory_size = infos.memory_size;
            settings.vga_memory_size = infos.vga_memory_size;

            if(infos.async_hda)
            {
                settings.hda = new v86util.AsyncXHRBuffer(
                    infos.async_hda,
                    512, 
                    infos.async_hda_size
                );
            }

            if(infos.fda)
            {
                settings.fda = new SyncBuffer(buffer);
            }
            else if(infos.cdrom)
            {
                settings.cdrom = new SyncBuffer(buffer);
            }

            start_emulation({ 
                settings: settings, 
                done: function(emulator)
                {
                    if(infos.state)
                    {
                        $("reset").style.display = "none";
                        emulator.restore_state(buffer);
                    }

                    //emulator.send("cpu-run");
                    emulator.run();

                    if(query_args["c"])
                    {
                        var cmd = query_args["c"] + "\n";

                        for(var i = 0; i < cmd.length; i++)
                        {
                            settings.serial_adapter.send_char(cmd.charCodeAt(i));
                        }
                    }
                }
            });
        }
    }

    function debug_onload(settings)
    {
        // called on window.onload, in debug mode

        //settings.fs9p = new FS("http://localhost/v86-images/arch/");
        //settings.fs9p.LoadFilesystem({
        //    lazyloadimages: [],
        //    earlyload: [],
        //    basefsURL: "http://localhost/v86-images/fs.json",
        //});

        $("restore_state").onchange = function()
        {
        };

        $("start_test").onclick = function()
        {
        };

        var log_levels = document.getElementById("log_levels");

        for(var i = 0; i < LOG_NAMES.length; i++)
        {
            var mask = LOG_NAMES[i][0];

            if(mask === 1)
                continue;

            var name = LOG_NAMES[i][1].toLowerCase(),
                input = document.createElement("input"),
                label = document.createElement("label");

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

    window.addEventListener("load", onload, false);

    // old webkit fires popstate on every load, fuck webkit
    // https://code.google.com/p/chromium/issues/detail?id=63040
    window.addEventListener("load", function() 
    {
        setTimeout(function() 
        {
            window.addEventListener("popstate", onpopstate);
        }, 0);
    });

    // works in firefox and chromium
    if(document.readyState === "complete")
    {
        onload();
    }

    var start_emulation = after(3, function(result)
    {
        var settings = result.settings;
        dbg_assert(settings.bios && settings.vga_bios);

        //var worker = new Worker("src/browser/worker.js");
        //var adapter_bus = WorkerBus.init(worker);
        var bus = Bus.create();
        var adapter_bus = bus[0];
        var device_bus = bus[1];

        var emulator = new v86(device_bus);

        if(DEBUG)
        {
            debug_start(emulator);
        }

        // avoid warnings
        settings.fdb = undefined;

        settings.screen_adapter = new ScreenAdapter($("screen_container"));;
        settings.keyboard_adapter = new KeyboardAdapter();
        settings.mouse_adapter = new MouseAdapter();

        settings.boot_order = parseInt($("boot_order").value, 16);
        settings.serial_adapter = new SerialAdapter($("serial"));
        //settings.serial_adapter = new ModemAdapter();
        //settings.network_adapter = new NetworkAdapter("ws://localhost:8001/");
        //settings.network_adapter = new NetworkAdapter("ws://relay.widgetry.org/");

        if(!settings.memory_size)
        {
            var memory_size = parseInt($("memory_size").value, 10) * 1024 * 1024;
            if(memory_size >= 16 * 1024 * 1024 && memory_size < 2048 * 1024 * 1024)
            {
                settings.memory_size = memory_size;
            }
            else
            {
                alert("Invalid memory size - ignored.");
                settings.memory_size = 32 * 1024 * 1024;
            }
        }

        if(!settings.vga_memory_size)
        {
            var video_memory_size = parseInt($("video_memory_size").value, 10) * 1024 * 1024;
            if(video_memory_size > 64 * 1024 && video_memory_size < 2048 * 1024 * 1024)
            {
                settings.vga_memory_size = video_memory_size;
            }
            else
            {
                alert("Invalid video memory size - ignored.");
                settings.vga_memory_size = 8 * 1024 * 1024;
            }
        }

        init_ui(settings, emulator);
        
        if(settings.mouse_adapter)
        {
            settings.mouse_adapter.register(adapter_bus);
        }
        if(settings.keyboard_adapter)
        {
            settings.keyboard_adapter.register(adapter_bus);
        }
        if(settings.serial_adapter)
        {
            settings.serial_adapter.register(adapter_bus);
        }
        if(settings.screen_adapter)
        {
            settings.screen_adapter.register(adapter_bus);
        }
        if(settings.network_adapter)
        {
            settings.network_adapter.register(adapter_bus);
        }

        emulator.init(settings);
        
        //settings.fs9p = undefined;
        //settings.fda = undefined;
        //adapter_bus.send("cpu-init", settings);

        //setTimeout(function()
        //{
            result.done(emulator);
        //}, 100);
    });

    function init_ui(settings, emulator)
    {
        $("boot_options").style.display = "none";
        $("loading").style.display = "none";
        $("runtime_options").style.display = "block";
        $("runtime_infos").style.display = "block";
        document.getElementsByClassName("phone_keyboard")[0].style.display = "block";

        if($("news")) 
        {
            $("news").style.display = "none";
        }

        var running = true;

        $("run").onclick = function()
        {
            if(running)
            {
                running_time += Date.now() - last_tick;
                $("run").value = "Run";
                emulator.stop();
            }
            else
            {
                $("run").value = "Pause";
                emulator.run();
                last_tick = Date.now();
            }

            running = !running;
            $("run").blur();
        };

        $("exit").onclick = function()
        {
            location.href = location.pathname;
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
                setTimeout(update_info, 1000);
                return;
            }

            var now = Date.now(),
                last_ips = (emulator.cpu.timestamp_counter - last_instr_counter) / 1000 | 0;

            summed_ips += last_ips
            running_time += now - last_tick;
            last_tick = now;

            ips.textContent = last_ips;
            avg_ips.textContent = summed_ips / running_time * 1000 | 0;
            time.textContent = time2str(running_time / 1000 | 0);

            last_instr_counter = emulator.cpu.timestamp_counter;

            setTimeout(update_info, 1000);
        }

        function update_other_info()
        {
            if(!running)
            {
                setTimeout(update_other_info, 1000);
                return;
            }

            var devices = emulator.cpu.devices;
            var vga_stats = devices.vga.stats;

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
                $("info_mouse_enabled").textContent = settings.mouse_adapter.enabled ? "Yes" : "No";
            }

            if(devices.hda)
            {
                var hda_stats = devices.hda.stats;

                $("info_hda_sectors_read").textContent = hda_stats.sectors_read;
                $("info_hda_bytes_read").textContent = hda_stats.bytes_read;

                $("info_hda_sectors_written").textContent = hda_stats.sectors_written;
                $("info_hda_bytes_written").textContent = hda_stats.bytes_written;
                $("info_hda_status").textContent = hda_stats.loading ? "Loading ..." : "Idle";
            }
            else
            {
                $("info_hda").style.display = "none";
            }

            if(devices.cdrom)
            {
                var cdrom_stats = devices.cdrom.stats;

                $("info_cdrom_sectors_read").textContent = cdrom_stats.sectors_read;
                $("info_cdrom_bytes_read").textContent = cdrom_stats.bytes_read;
                $("info_cdrom_status").textContent = cdrom_stats.loading ? "Loading ..." : "Idle";
            }
            else
            {
                $("info_cdrom").style.display = "none";
            }

            setTimeout(update_other_info, 1000);
        }

        setTimeout(update_info, 1000);
        setTimeout(update_other_info, 0);

        $("reset").onclick = function()
        {
            emulator.restart();
            $("reset").blur();
        };

        // writable image types
        var image_types = ["hda", "hdb", "fda", "fdb"];

        for(var i = 0; i < image_types.length; i++)
        {
            var elem = $("get_" + image_types[i] + "_image");
            var obj = settings[image_types[i]];

            if(obj && obj.byteLength < 16 * 1024 * 1024)
            {
                elem.onclick = (function(type)
                {
                    obj.get_buffer(function(b)
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
            var ps2 = emulator.cpu.devices.ps2;

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
                settings.screen_adapter.set_scale(n, n);
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
            // allow text selection
            if(window.getSelection().isCollapsed)
            {
                document.getElementsByClassName("phone_keyboard")[0].focus();
            }
        };

        $("take_screenshot").onclick = function()
        {
            settings.screen_adapter.make_screenshot();

            $("take_screenshot").blur();
        };

        if(settings.serial_adapter)
        {
            $("serial").style.display = "block";
        }

        window.addEventListener("keydown", ctrl_w_rescue, false);
        window.addEventListener("keyup", ctrl_w_rescue, false);
        window.addEventListener("blur", ctrl_w_rescue, false);

        function ctrl_w_rescue(e)
        {
            if(e.ctrlKey)
            {
                window.onbeforeunload = function()
                {
                    window.onbeforeunload = null;
                    return "CTRL-W cannot be sent to the emulator.";
                }
            }
            else
            {
                window.onbeforeunload = null;
            }
        }
    }

    function debug_start(emulator)
    {
        // called as soon as soon as emulation is started, in debug mode
        var debug = emulator.cpu.debug;

        $("step").onclick = debug.step.bind(debug);
        $("run_until").onclick = debug.run_until.bind(debug);
        $("debugger").onclick = debug.debugger.bind(debug);
        $("dump_gdt").onclick = debug.dump_gdt_ldt.bind(debug);
        $("dump_idt").onclick = debug.dump_idt.bind(debug);
        $("dump_regs").onclick = debug.dump_regs.bind(debug);
        $("dump_pt").onclick = debug.dump_page_directory.bind(debug);
        $("dump_instructions").onclick = debug.dump_instructions.bind(debug);

        $("memory_dump").onclick = function()
        {
            dump_file(debug.get_memory_dump(), "v86-memory.bin");
            $("memory_dump").blur();
        };

        $("save_state").onclick = function()
        {
            dump_file(emulator.save_state(), "v86-state.bin");
            $("save_state").blur();
        };

        window.emulator = emulator;
    }

    function onpopstate(e)
    {
        location.reload();
    }
})();
