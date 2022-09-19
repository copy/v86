"use strict";

(function()
{
    if(typeof XMLHttpRequest === "undefined")
    {
        v86util.load_file = load_file_nodejs;
    }
    else
    {
        v86util.load_file = load_file;
    }

    // Reads len characters at offset from Memory object mem as a JS string
    v86util.read_sized_string_from_mem = function read_sized_string_from_mem(mem, offset, len)
    {
        offset >>>= 0;
        len >>>= 0;
        return String.fromCharCode(...new Uint8Array(mem.buffer, offset, len));
    };

    /**
     * @param {string} filename
     * @param {Object} options
     * @param {number=} n_tries
     */
    function load_file(filename, options, n_tries)
    {
        var http = new XMLHttpRequest();

        http.open(options.method || "get", filename, true);

        if(options.as_json)
        {
            http.responseType = "json";
        }
        else
        {
            http.responseType = "arraybuffer";
        }

        if(options.headers)
        {
            var header_names = Object.keys(options.headers);

            for(var i = 0; i < header_names.length; i++)
            {
                var name = header_names[i];
                http.setRequestHeader(name, options.headers[name]);
            }
        }

        if(options.range)
        {
            let start = options.range.start;
            let end = start + options.range.length - 1;
            http.setRequestHeader("Range", "bytes=" + start + "-" + end);

            // Abort if server responds with complete file in response to range
            // request, to prevent downloading large files from broken http servers
            http.onreadystatechange = function()
            {
                if(http.status === 200)
                {
                    http.abort();
                }
            };
        }

        http.onload = function(e)
        {
            if(http.readyState === 4)
            {
                if(http.status !== 200 && http.status !== 206)
                {
                    console.error("Loading the image " + filename + " failed (status %d)", http.status);
                    if(http.status >= 500 && http.status < 600)
                    {
                        retry();
                    }
                }
                else if(http.response)
                {
                    options.done && options.done(http.response, http);
                }
            }
        };

        http.onerror = function(e)
        {
            console.error("Loading the image " + filename + " failed", e);
            retry();
        };

        if(options.progress)
        {
            http.onprogress = function(e)
            {
                options.progress(e);
            };
        }

        http.send(null);

        function retry()
        {
            const number_of_tries = n_tries || 0;
            const timeout = [1, 1, 2, 3, 5, 8, 13, 21][number_of_tries] || 34;
            setTimeout(() => {
                load_file(filename, options, number_of_tries + 1);
            }, 1000 * timeout);
        }
    }

    function load_file_nodejs(filename, options)
    {
        let fs = require("fs");

        if(options.range)
        {
            dbg_assert(!options.as_json);

            fs["open"](filename, "r", (err, fd) =>
            {
                if(err) throw err;

                let length = options.range.length;
                var buffer = Buffer.allocUnsafe(length);

                fs["read"](fd, buffer, 0, length, options.range.start, (err, bytes_read) =>
                {
                    if(err) throw err;

                    dbg_assert(bytes_read === length);
                    options.done && options.done(new Uint8Array(buffer));

                    fs["close"](fd, (err) => {
                        if(err) throw err;
                    });
                });
            });
        }
        else
        {
            var o = {
                encoding: options.as_json ? "utf-8" : null,
            };

            fs["readFile"](filename, o, function(err, data)
            {
                if(err)
                {
                    console.log("Could not read file:", filename, err);
                }
                else
                {
                    var result = data;

                    if(options.as_json)
                    {
                        result = JSON.parse(result);
                    }
                    else
                    {
                        result = new Uint8Array(result).buffer;
                    }

                    options.done(result);
                }
            });
        }
    }
})();
