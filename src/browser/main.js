"use strict";

(function()
{
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
            return (time / 60 | 0) + "m " + v86util.pad0(time % 60, 2) + "s";
        }
        else
        {
            return (time / 3600 | 0) + "h " + 
                v86util.pad0((time / 60 | 0) % 60, 2) + "m " + 
                v86util.pad0(time % 60, 2) + "s";
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

    var progress_ticks = 0;

    function show_progress(message, e)
    {
        var el = $("loading");
        el.style.display = "block";

        var line = message + " ";

        if(typeof e.file_index === "number" && e.file_count)
        {
            line += "[" + (e.file_index + 1) + "/" + e.file_count + "] ";
        }

        if(e.total && typeof e.loaded === "number")
        {
            var per100 = Math.floor(e.loaded / e.total * 100);
            per100 = Math.min(100, Math.max(0, per100));

            var per50 = Math.floor(per100 / 2);

            line += per100 + "% [";
            line += chr_repeat("#", per50);
            line += chr_repeat(" ", 50 - per50) + "]";
        }
        else
        {
            line += chr_repeat(".", progress_ticks++ % 50);
        }

        el.textContent = line;
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

        var settings = {};

        $("start_emulation").onclick = function()
        {
            $("boot_options").style.display = "none";
            set_profile("custom");

            var images = [];
            var last_file;

            var floppy_file = $("floppy_image").files[0];
            if(floppy_file)
            {
                last_file = floppy_file;
                settings.fda = { buffer: floppy_file };
            }

            var cd_file = $("cd_image").files[0];
            if(cd_file)
            {
                last_file = cd_file;
                settings.cdrom = { buffer: cd_file };
            }

            var hd_file = $("hd_image").files[0];
            if(hd_file)
            {
                last_file = hd_file;
                settings.hda = { buffer: hd_file };
            }

            if(last_file)
            {
                set_title(last_file.name);
            }

            start_emulation({ 
                settings: settings,
                done: function(emulator) { 
                    emulator.run(); 
                },
            });
        };

        if(DEBUG)
        {
            debug_onload(settings);
        }

        var oses = [
            {
                id: "archlinux",
                state: "http://localhost/v86-images/v86state.bin",
                //state: "http://104.131.53.7:8086/v86state.bin",
                //size: 137 * 1024 * 1024,
                size: 75550474,
                name: "Arch Linux",
                memory_size: 64 * 1024 * 1024,
                vga_memory_size: 8 * 1024 * 1024,
                async_hda: "http://localhost/v86-images/arch3.img",
                //async_hda: "https://dl.dropboxusercontent.com/u/61029208/arch3.img", 
                //async_hda: "http://104.131.53.7:8086/arch3.img", 
                async_hda_size: 8 * 1024 * 1024 * 1024,

                filesystem: {
                    basefs: "http://localhost/v86-images/fs.json",
                    baseurl: "http://localhost/v86-images/arch/",
                    //basefs: "http://104.131.53.7:8086/fs.json",
                    //baseurl: "http://104.131.53.7:8086/arch/",
                },
            },
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
                set_profile(infos.id);
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
            $("boot_options").style.display = "none";
            set_title(infos.name);

            settings.filesystem = infos.filesystem;

            if(infos.state)
            {
                $("reset").style.display = "none";
                settings.initial_state = {
                    url: infos.state,
                };
            }

            settings.fda = {
                url: infos.fda,
            };
            settings.cdrom = {
                url: infos.cdrom,
            };
            
            if(infos.hda)
            {
                settings.hda = {
                    url: infos.hda,
                };
            }
            else if(infos.async_hda)
            {
                settings.hda = {
                    url: infos.async_hda,
                    async: true,
                    size: infos.async_hda_size,
                };
            }

            settings.memory_size = infos.memory_size;
            settings.vga_memory_size = infos.vga_memory_size;

            //if(infos.async_hda)
            //{
            //    settings.hda = new v86util.AsyncXHRBuffer(
            //        infos.async_hda,
            //        512, 
            //        infos.async_hda_size
            //    );
            //}

            start_emulation({ 
                settings: settings, 
                done: function(emulator)
                {
                    emulator.run();

                    if(query_args["c"])
                    {
                        emulator.serial0_send(query_args["c"] + "\n");
                    }
                }
            });
        }
    }

    function debug_onload(settings)
    {
        // called on window.onload, in debug mode

        //settings.filesystem = {
        //    baseurl: "http://localhost/v86-images/arch/",
        //    basefs: "http://localhost/v86-images/fs.json",
        //};

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

    function start_emulation(result)
    {
        /** @const */
        var MB = 1024 * 1024;

        var settings = result.settings;
        var memory_size = settings.memory_size;

        if(!memory_size)
        {
            memory_size = parseInt($("memory_size").value, 10) * MB;

            if(memory_size < 16 * MB || memory_size >= 2048 * MB)
            {
                alert("Invalid memory size - ignored.");
                memory_size = 32 * MB;
            }
        }
        
        var vga_memory_size = settings.vga_memory_size;

        if(!vga_memory_size)
        {
            vga_memory_size = parseInt($("video_memory_size").value, 10) * MB;

            if(vga_memory_size <= 64 * 1024 || vga_memory_size >= 2048 * MB)
            {
                alert("Invalid video memory size - ignored.");
                vga_memory_size = 8 * MB;
            }
        }

        var BIOSPATH = "bios/";
        var biosfile = DEBUG ? "seabios-debug.bin" : "seabios.bin";
        var vgabiosfile = DEBUG ? "vgabios-0.7a.debug.bin" : "bochs-vgabios-0.7a.bin";

        
        var emulator = new V86Starter({
            memory_size: memory_size,
            vga_memory_size: vga_memory_size,

            screen_container: $("screen_container"),
            serial_container: $("serial"),

            boot_order: parseInt($("boot_order").value, 16) || 0,

            network_relay_url: "ws://relay.widgetry.org/",
            //network_relay_url: "ws://localhost:8001/",

            bios: {
                url: BIOSPATH + biosfile,
            },
            vga_bios: {
                url: BIOSPATH + vgabiosfile,
            },

            fda: settings.fda,
            hda: settings.hda,
            cdrom: settings.cdrom,

            initial_state: settings.initial_state,
            filesystem: settings.filesystem,
        });

        emulator.add_listener("emulator-ready", function()
        {
            if(DEBUG)
            {
                debug_start(emulator);
            }

            init_ui({}, emulator);

            result.done(emulator);
        });

        emulator.add_listener("download-progress", function(e)
        {
            show_progress("Downloading images", e);
        });
    };

    function init_ui(settings, emulator)
    {
        $("boot_options").style.display = "none";
        $("loading").style.display = "none";
        $("runtime_options").style.display = "block";
        $("runtime_infos").style.display = "block";
        document.getElementsByClassName("phone_keyboard")[0].style.display = "block";

        var news_element = $("news");
        if(news_element) 
        {
            news_element.style.display = "none";
        }

        $("run").onclick = function()
        {
            if(emulator.is_running())
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

            $("run").blur();
        };

        $("exit").onclick = function()
        {
            location.href = location.pathname;
        };

        $("lock_mouse").onclick = function()
        {
            if(!mouse_is_enabled)
            {
                $("toggle_mouse").onclick();
            }

            emulator.lock_mouse();
            $("lock_mouse").blur();
        };

        var mouse_is_enabled = true;

        $("toggle_mouse").onclick = function()
        {
            mouse_is_enabled = !mouse_is_enabled;

            emulator.mouse_set_status(mouse_is_enabled);
            $("toggle_mouse").value = (mouse_is_enabled ? "Dis" : "En") + "able mouse";
            $("toggle_mouse").blur();
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
            if(!emulator.is_running())
            {
                setTimeout(update_info, 1000);
                return;
            }

            var stats = emulator.get_statistics();

            var now = Date.now();
            var last_ips = stats.cpu.instruction_counter - last_instr_counter;

            summed_ips += last_ips;
            running_time += now - last_tick;
            last_tick = now;

            ips.textContent = last_ips / 1000 | 0;
            avg_ips.textContent = summed_ips / running_time | 0;
            time.textContent = time2str(running_time / 1000 | 0);

            last_instr_counter = stats.cpu.instruction_counter;

            $("info_mouse_enabled").textContent = stats.mouse.enabled ? "Yes" : "No";

            if(stats.hda)
            {
                $("info_hda_sectors_read").textContent = stats.hda.sectors_read;
                $("info_hda_bytes_read").textContent = stats.hda.bytes_read;

                $("info_hda_sectors_written").textContent = stats.hda.sectors_written;
                $("info_hda_bytes_written").textContent = stats.hda.bytes_written;
                $("info_hda_status").textContent = stats.hda.loading ? "Loading ..." : "Idle";
            }
            else
            {
                $("info_hda").style.display = "none";
            }

            if(stats.cdrom)
            {
                $("info_cdrom_sectors_read").textContent = stats.cdrom.sectors_read;
                $("info_cdrom_bytes_read").textContent = stats.cdrom.bytes_read;
                $("info_cdrom_status").textContent = stats.cdrom.loading ? "Loading ..." : "Idle";
            }
            else
            {
                $("info_cdrom").style.display = "none";
            }

            if(stats.vga.is_graphical)
            {
                $("info_vga_mode").textContent = "Graphical";
                $("info_res").textContent = stats.vga.res_x + "x" + stats.vga.res_y;
                $("info_bpp").textContent = stats.vga.bpp;
            }
            else
            {
                $("info_vga_mode").textContent = "Text";
                $("info_res").textContent = "-";
                $("info_bpp").textContent = "-";
            }

            setTimeout(update_info, 1000);
        }

        setTimeout(update_info, 1000);

        var stats = emulator.get_statistics();

        if(!stats.cdrom)
        {
            $("info_cdrom").style.display = "none";
        }
        if(!stats.hda)
        {
            $("info_hda").style.display = "none";
        }


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
            emulator.keyboard_send_scancodes([
                0x1D, // ctrl
                0x38, // alt
                0x53, // delete

                // break codes
                0x1D | 0x80, 
                0x38 | 0x80,
                0x53 | 0x80,
            ]);

            $("ctrlaltdel").blur();
        };

        $("alttab").onclick = function()
        {
            emulator.keyboard_send_scancodes([
                0x38, // alt
                0x0F, // tab
                0x38 | 0x80,
                0x0F | 0x80,
            ]);

            $("alttab").blur();
        };

        $("scale").onchange = function()
        {
            var n = parseFloat(this.value);

            if(n || n > 0)
            {
                emulator.screen_set_scale(n, n);
            }
        };

        $("fullscreen").onclick = function()
        {
            emulator.screen_go_fullscreen();
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
            emulator.screen_make_screenshot();

            $("take_screenshot").blur();
        };

        $("serial").style.display = "block";

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
        var debug = emulator.v86.cpu.debug;

        $("step").onclick = debug.step.bind(debug);
        $("run_until").onclick = debug.run_until.bind(debug);
        $("debugger").onclick = debug.debugger.bind(debug);
        $("dump_gdt").onclick = debug.dump_gdt_ldt.bind(debug);
        $("dump_idt").onclick = debug.dump_idt.bind(debug);
        $("dump_regs").onclick = debug.dump_regs.bind(debug);
        $("dump_pt").onclick = debug.dump_page_directory.bind(debug);
        $("dump_instructions").onclick = debug.dump_instructions.bind(debug);

        $("dump_instructions_file").onclick = function()
        {
            var ins = debug.get_instructions();

            if(ins)
            {
                dump_file(ins, "trace.txt");
            }
        };

        $("memory_dump").onclick = function()
        {
            dump_file(debug.get_memory_dump(), "v86-memory.bin");
            $("memory_dump").blur();
        };

        $("save_state").onclick = function()
        {
            emulator.save_state(function(error, result)
            {
                if(error)
                {
                    console.log("Couldn't save state: ", error);
                }
                else
                {
                    dump_file(result, "v86state.bin");
                }
            });

            $("save_state").blur();
        };

        // helps debugging
        window.emulator = emulator;
        window.cpu = emulator.v86.cpu;
    }

    function onpopstate(e)
    {
        location.reload();
    }

    function set_profile(prof)
    {
        if(window.history.pushState)
        {
            window.history.pushState({ profile: prof }, "", "?profile=" + prof);
        }

    }

})();
