import { dbg_assert, dbg_log } from "../log.js";

// For Types Only
import { BusConnector } from "../bus.js";

/**
 * @constructor
 *
 * @param {HTMLTextAreaElement} element
 */
function TextAreaAdapter(element)
{
    var serial = this;

    this.enabled = true;
    this.text = "";
    this.text_new_line = false;

    this.last_update = 0;

    this.destroy = function()
    {
        this.enabled = false;

        element.removeEventListener("keypress", keypress_handler, false);
        element.removeEventListener("keydown", keydown_handler, false);
        element.removeEventListener("paste", paste_handler, false);
        window.removeEventListener("mousedown", window_click_handler, false);
    };

    this.init = function()
    {
        this.destroy();
        this.enabled = true;

        element.style.display = "block";
        element.addEventListener("keypress", keypress_handler, false);
        element.addEventListener("keydown", keydown_handler, false);
        element.addEventListener("paste", paste_handler, false);
        window.addEventListener("mousedown", window_click_handler, false);
    };
    this.init();

    this.show_char = function(chr)
    {
        if(chr === "\x08")
        {
            this.text = this.text.slice(0, -1);
            this.update();
        }
        else if(chr === "\r")
        {
            // do nothing
        }
        else
        {
            this.text += chr;

            if(chr === "\n")
            {
                this.text_new_line = true;
            }

            this.update();
        }
    };

    this.update = function()
    {
        var now = Date.now();
        var delta = now - this.last_update;

        if(delta < 16)
        {
            if(this.update_timer === undefined)
            {
                this.update_timer = setTimeout(() => {
                    this.update_timer = undefined;
                    var now = Date.now();
                    dbg_assert(now - this.last_update >= 15);
                    this.last_update = now;
                    this.render();
                }, 16 - delta);
            }
        }
        else
        {
            if(this.update_timer !== undefined)
            {
                clearTimeout(this.update_timer);
                this.update_timer = undefined;
            }

            this.last_update = now;
            this.render();
        }
    };

    this.render = function()
    {
        element.value = this.text;

        if(this.text_new_line)
        {
            this.text_new_line = false;
            element.scrollTop = 1e9;
        }
    };

    /**
     * @param {number} chr_code
     */
    this.send_char = function(chr_code)
    {
        // placeholder
    };

    function may_handle(e)
    {
        if(!serial.enabled)
        {
            return false;
        }

        // Something here?

        return true;
    }

    function keypress_handler(e)
    {
        if(!may_handle(e))
        {
            return;
        }

        var chr = e.which;

        serial.send_char(chr);
        e.preventDefault();
    }

    function keydown_handler(e)
    {
        var chr = e.which;

        if(chr === 8)
        {
            // supress backspace
            serial.send_char(127);
            e.preventDefault();
        }
        else if(chr === 9)
        {
            // tab
            serial.send_char(9);
            e.preventDefault();
        }
    }

    function paste_handler(e)
    {
        if(!may_handle(e))
        {
            return;
        }

        var data = e.clipboardData.getData("text/plain");

        for(var i = 0; i < data.length; i++)
        {
            serial.send_char(data.charCodeAt(i));
        }

        e.preventDefault();
    }

    function window_click_handler(e)
    {
        if(e.target !== element)
        {
            element.blur();
        }
    }
}

/**
 * @constructor
 *
 * @param {HTMLTextAreaElement} element
 * @param {BusConnector} bus
 */
export function SerialAdapter(element, bus)
{
    var adapter = Reflect.construct(TextAreaAdapter, [element], SerialAdapter);

    adapter.send_char = function(chr_code)
    {
        bus.send("serial0-input", chr_code);
    };

    bus.register("serial0-output-byte", function(byte)
    {
        var chr = String.fromCharCode(byte);
        adapter.show_char && adapter.show_char(chr);
    }, adapter);

    return adapter;
}

Reflect.setPrototypeOf(SerialAdapter.prototype, TextAreaAdapter.prototype);
Reflect.setPrototypeOf(SerialAdapter, TextAreaAdapter);

/**
 * @constructor
 *
 * @param {HTMLTextAreaElement} element
 * @param {BusConnector} bus
 */
export function VirtioConsoleAdapter(element, bus)
{
    var adapter = Reflect.construct(TextAreaAdapter, [element], VirtioConsoleAdapter);

    adapter.send_char = function(chr_code)
    {
        bus.send("virtio-console0-input-bytes", new Uint8Array([chr_code]));
    };

    const decoder = new TextDecoder();
    bus.register("virtio-console0-output-bytes", function(bytes)
    {
        for(const chr of decoder.decode(bytes))
        {
            adapter.show_char && adapter.show_char(chr);
        }
    }, adapter);

    return adapter;
}

Reflect.setPrototypeOf(VirtioConsoleAdapter.prototype, TextAreaAdapter.prototype);
Reflect.setPrototypeOf(VirtioConsoleAdapter, TextAreaAdapter);

/**
 * @constructor
 *
 * @param {BusConnector} bus
 */
function SerialRecordingAdapter(bus)
{
    var serial = this;
    this.text = "";

    bus.register("serial0-output-byte", function(byte)
    {
        var chr = String.fromCharCode(byte);
        this.text += chr;
    }, this);
}

/**
 * @constructor
 *
 * @param {HTMLElement} element
 * @param {Function} xterm_lib
 */
function XtermJSAdapter(element, xterm_lib)
{
    this.element = element;

    var term = this.term = new xterm_lib({
        "logLevel": "off",
        "convertEol": "true",
    });

    this.destroy = function() {
        this.on_data_disposable && this.on_data_disposable["dispose"]();
        term["dispose"]();
    };
}

XtermJSAdapter.prototype.show = function()
{
    this.term && this.term.open(this.element);
};

/**
 * @constructor
 *
 * @extends XtermJSAdapter
 * @param {HTMLElement} element
 * @param {BusConnector} bus
 * @param {Function} xterm_lib
 */
export function SerialAdapterXtermJS(element, bus, xterm_lib)
{
    if(!xterm_lib)
    {
        return;
    }

    var adapter = Reflect.construct(XtermJSAdapter, [element, xterm_lib], SerialAdapterXtermJS);

    bus.register("serial0-output-byte", function(utf8_byte)
    {
        adapter.term.write(Uint8Array.of(utf8_byte));
    }, adapter);

    const utf8_encoder = new TextEncoder();
    adapter.on_data_disposable = adapter.term["onData"](function(data_str) {
        for(const utf8_byte of utf8_encoder.encode(data_str))
        {
            bus.send("serial0-input", utf8_byte);
        }
    });

    return adapter;
}

Reflect.setPrototypeOf(SerialAdapterXtermJS.prototype, XtermJSAdapter.prototype);
Reflect.setPrototypeOf(SerialAdapterXtermJS, XtermJSAdapter);

/**
 * @constructor
 *
 * @extends XtermJSAdapter
 * @param {HTMLElement} element
 * @param {BusConnector} bus
 * @param {Function} xterm_lib
 */
export function VirtioConsoleAdapterXtermJS(element, bus, xterm_lib)
{
    if(!xterm_lib)
    {
        return;
    }

    var adapter = Reflect.construct(XtermJSAdapter, [element, xterm_lib], VirtioConsoleAdapterXtermJS);

    bus.register("virtio-console0-output-bytes", function(utf8_bytes)
    {
        adapter.term.write(utf8_bytes);
    }, adapter);

    const utf8_encoder = new TextEncoder();
    adapter.on_data_disposable = adapter.term["onData"](function(data_str) {
        bus.send("virtio-console0-input-bytes", utf8_encoder.encode(data_str));
    });

    return adapter;
}

Reflect.setPrototypeOf(VirtioConsoleAdapterXtermJS.prototype, XtermJSAdapter.prototype);
Reflect.setPrototypeOf(VirtioConsoleAdapterXtermJS, XtermJSAdapter);
