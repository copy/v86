import { BusConnector } from "../bus.js";

const PLATFOM_WINDOWS = typeof window !== "undefined" && window.navigator.platform.toString().toLowerCase().search("win") >= 0;

/**
 * Map of KeyboardEvent.code strings to scancode numbers.
 * @type !Object<!string,!number>
 */
const SCANCODE =
{
    "KeyA": 0x001E,
    "KeyB": 0x0030,
    "KeyC": 0x002E,
    "KeyD": 0x0020,
    "KeyE": 0x0012,
    "KeyF": 0x0021,
    "KeyG": 0x0022,
    "KeyH": 0x0023,
    "KeyI": 0x0017,
    "KeyJ": 0x0024,
    "KeyK": 0x0025,
    "KeyL": 0x0026,
    "KeyM": 0x0032,
    "KeyN": 0x0031,
    "KeyO": 0x0018,
    "KeyP": 0x0019,
    "KeyQ": 0x0010,
    "KeyR": 0x0013,
    "KeyS": 0x001F,
    "KeyT": 0x0014,
    "KeyU": 0x0016,
    "KeyV": 0x002F,
    "KeyW": 0x0011,
    "KeyX": 0x002D,
    "KeyY": 0x0015,
    "KeyZ": 0x002C,
    "Digit0": 0x000B,
    "Digit1": 0x0002,
    "Digit2": 0x0003,
    "Digit3": 0x0004,
    "Digit4": 0x0005,
    "Digit5": 0x0006,
    "Digit6": 0x0007,
    "Digit7": 0x0008,
    "Digit8": 0x0009,
    "Digit9": 0x000A,
    "Numpad1": 0x004F,
    "Numpad2": 0x0050,
    "Numpad3": 0x0051,
    "Numpad4": 0x004B,
    "Numpad5": 0x004C,
    "Numpad6": 0x004D,
    "Numpad7": 0x0047,
    "Numpad8": 0x0048,
    "Numpad9": 0x0049,
    "Numpad0": 0x0052,
    "Quote": 0x0028,
    "Comma": 0x0033,
    "Minus": 0x000C,
    "Period": 0x0034,
    "Slash": 0x0035,
    "Semicolon": 0x0027,
    "Equal": 0x000D,
    "BracketLeft": 0x001A,
    "BracketRight": 0x001B,
    "Backquote": 0x0029,
    "Backspace": 0x000E,
    "Tab": 0x000F,
    "Space": 0x0039,
    "NumpadDecimal": 0x0053,
    "NumpadSubtract": 0x004A,
    "NumpadAdd": 0x004E,
    "Enter": 0x001C,
    "Escape": 0x0001,
    "F1": 0x003B,
    "F2": 0x003C,
    "F3": 0x003D,
    "F4": 0x003E,
    "F5": 0x003F,
    "F6": 0x0040,
    "F7": 0x0041,
    "F8": 0x0042,
    "F9": 0x0043,
    "F10": 0x0044,
    "F11": 0x0057,
    "F12": 0x0058,
    "NumpadEnter": 0xE01C,
    "NumpadDivide": 0xE035,
    "NumpadMultiply": 0x0037,
    "End": 0xE04F,
    "ArrowDown": 0xE050,
    "PageDown": 0xE051,
    "ArrowLeft": 0xE04B,
    "ArrowRight": 0xE04D,
    "Home": 0xE047,
    "ArrowUp": 0xE048,
    "PageUp": 0xE049,
    "Insert": 0xE052,
    "Delete": 0xE053,
    "ControlLeft": 0x001D,
    "ShiftLeft": 0x002A,
    "ShiftRight": 0x0036,
    "CapsLock": 0x003A,
    "NumLock": 0x0045,
    "ScrollLock": 0x0046,
    "AltLeft": 0x0038,
    "AltRight": 0xE038,
    "ControlRight": 0xE01D,
    "Pause": 0xE11D,
    "MetaLeft": 0xE05B,
    "MetaRight": 0xE05C,
    "ContextMenu": 0xE05D,
    "Backslash": 0x002B,
    "IntlBackslash": 0x0056,
    "IntlRo": 0x0035,   // equal to "Slash"
    "OSLeft": 0xE05B,   // equal to "MetaLeft"
    "OSRight": 0xE05C,  // equal to "MetaRight"
};

/**
 * Reserved scancode bit 8: signals keyup event if set, else keydown.
 */
const SCANCODE_RELEASE = 0x80;

/**
 * Set of modifier keys.
 * @type !Set<!number>
 */
const MODIFIER_SCANCODES = new Set([
    SCANCODE["ShiftLeft"],
    SCANCODE["ShiftRight"],
    SCANCODE["ControlLeft"],
    SCANCODE["ControlRight"],
    SCANCODE["AltLeft"],
    SCANCODE["AltRight"]
]);

// ---------------------------------------------------------------------------
// class DesktopKeyboard
// ---------------------------------------------------------------------------

class DesktopKeyboard
{
    /**
     * @param {Object} bus
     */
    constructor(bus)
    {
        this.bus = bus;                // system bus
        this.data_keyboard = null;     // DataKeyboard, assigned in KeyboardAdapter()
        this.keys_pressed = new Set(); // Set<number>, the set of pressed key scancodes
        this.muted = false;            // boolean, do not send any scancodes to bus if true

        /**
         * Deferred KeyboardEvent or null (Windows AltGr-Filter)
         * @type {KeyboardEvent|Object|null}
         */
        this.deferred_event = null;

        /**
         * Deferred keydown state (Windows AltGr-Filter)
         * @type {boolean}
         */
        this.deferred_keydown = false;

        /**
         * Timeout-ID returned by setTimeout() or 0 (Windows AltGr-Filter)
         * @type {number}
         */
        this.deferred_timeout_id = 0;
    }

    reset()
    {
        this.keys_pressed.clear();
        this.muted = false;
        this.deferred_event = null;
        this.deferred_keydown = false;
        this.deferred_timeout_id = 0;
    }

    shutdown()
    {
        if(this.deferred_event)
        {
            clearTimeout(this.deferred_timeout_id);
            this.deferred_event = null;
        }
    }

    /**
     * @param {boolean} do_mute
     */
    mute(do_mute)
    {
        this.muted = do_mute;
    }

    release_pressed_keys()
    {
        for(const scancode of new Set(this.keys_pressed))
        {
            this.send_scancode(scancode, false);
        }
    }

    /**
     * @param {KeyboardEvent|Object} e
     * @param {boolean} keydown
     */
    handle_event(e, keydown)
    {
        if(e.code === "" || e.key === "Process" || e.key === "Unidentified" || e.keyCode === 229)   // TODO: which key has keyCode 229?
        {
            // Handling mobile browsers and virtual keyboards
            return;
        }

        e.preventDefault && e.preventDefault();

        if(!e.altKey && this.keys_pressed.has(SCANCODE["AltLeft"]))
        {
            // trigger ALT keyup manually - some browsers don't
            // see issue #165
            this.send_scancode(SCANCODE["AltLeft"], false);
        }

        if(PLATFOM_WINDOWS)
        {
            // Remove ControlLeft from key sequence [ControlLeft, AltRight] when
            // AltGraph-key is pressed or released.
            //
            // NOTE: AltGraph is false for the 1st key (ControlLeft-Down), becomes
            // true with the 2nd (AltRight-Down) and stays true until key AltGraph
            // is released (AltRight-Up).
            if(this.deferred_event)
            {
                clearTimeout(this.deferred_timeout_id);
                if(!(e.getModifierState && e.getModifierState("AltGraph") &&
                        this.deferred_keydown === keydown &&
                        this.deferred_event.code === "ControlLeft" && e.code === "AltRight"))
                {
                    this.send_keyboard_event(this.deferred_event, this.deferred_keydown);
                }
                this.deferred_event = null;
            }

            if(e.code === "ControlLeft")
            {
                // defer ControlLeft-Down/-Up until the next invocation of this method or 10ms have passed, whichever comes first
                this.deferred_event = e;
                this.deferred_keydown = keydown;
                this.deferred_timeout_id = setTimeout(() => {
                    this.send_keyboard_event(this.deferred_event, this.deferred_keydown);
                    this.deferred_event = null;
                }, 10);
                return false;
            }
        }

        this.send_keyboard_event(e, keydown);
        return false;
    }

    /**
     * @param {KeyboardEvent|Object} e
     * @param {boolean} keydown
     */
    send_keyboard_event(e, keydown)
    {
        const scancode = SCANCODE[e.code];
        if(scancode === undefined)
        {
            console.log("Missing code in scancode map: code=" + e.code + " key=" + e.key + " keyCode=" + (e.keyCode || -1).toString(16));
        }
        else
        {
            this.send_scancode(scancode, keydown, e.repeat);
        }
    }

    /**
     * @param {number} scancode
     * @param {boolean} keydown
     * @param {boolean=} is_repeat
     */
    send_scancode(scancode, keydown, is_repeat)
    {
        if(keydown)
        {
            if(this.keys_pressed.has(scancode) && !is_repeat)
            {
                this.send_scancode(scancode, false);
            }
            this.keys_pressed.add(scancode);
        }
        else
        {
            if(!this.keys_pressed.has(scancode))
            {
                // stray keyup
                return;
            }
            this.keys_pressed.delete(scancode);
            scancode |= SCANCODE_RELEASE;
        }

        if(!this.muted)
        {
            if(scancode > 0xff)
            {
                this.bus.send("keyboard-code", scancode >> 8);
            }
            this.bus.send("keyboard-code", scancode & 0xff);
        }
        else if(scancode === (SCANCODE["Escape"] | SCANCODE_RELEASE))
        {
            this.data_keyboard.abort();
        }
    }
}

// ---------------------------------------------------------------------------
// class DataKeyboard
// ---------------------------------------------------------------------------

class Aborted extends Error
{
    constructor()
    {
        super("aborted");
        this.name = this.constructor.name;
    }
}

/**
 * Return true if set_a and set_b contain the same elements.
 * @param {!Set} set_a
 * @param {!Set} set_b
 * @return {boolean}
 */
function set_is_identical(set_a, set_b)
{
    if(set_a.size !== set_b.size)
    {
        return false;
    }
    for(const elem of set_a)
    {
        if(!set_b.has(elem))
        {
            return false;
        }
    }
    return true;
}

/**
 * Return a new set containing the elements contained in set_a but not in set_b.
 * @param {!Set} set_a
 * @param {!Set} set_b
 * @return {!Set}
 */
function set_difference(set_a, set_b)
{
    const result = new Set(set_a);
    for(const elem of set_b)
    {
        result.delete(elem);
    }
    return result;
}

/**
 * Return two disjunct sets where the first returned set contains all elements
 * of set that are also element of set_include, and the second returned set
 * contains all remaining elements of set.
 * @param {!Set} set
 * @param {!Set} set_include
 * @return {!Array<!Set>}
 */
function set_split_group(set, set_include)
{
    const result_incl = new Set(), result_excl = new Set();
    for(const elem of set)
    {
        if(set_include.has(elem))
        {
            result_incl.add(elem);
        }
        else
        {
            result_excl.add(elem);
        }
    }
    return [result_incl, result_excl];
}

// Modifier key bits as used by KEYMAPS
const MODIFIER_NONE     = 0x00;
const MODIFIER_SHIFT    = 0x01;
const MODIFIER_CTRL     = 0x02;
const MODIFIER_ALT      = 0x04;
const MODIFIER_ALTGR    = 0x08;
const MODIFIER_CTRL_ALT = MODIFIER_CTRL | MODIFIER_ALT;

const KEYMAPS =
{
    "kbdus": {
        has_altgr: false, charset: {" ": [[57, 0]], "!": [[2,
        1]], "\"": [[40, 1]], "#": [[4, 1]], "$": [[5, 1]], "%": [[6,
        1]], "&": [[8, 1]], "'": [[40, 0]], "(": [[10, 1]], ")": [[11,
        1]], "*": [[9, 1]], "+": [[13, 1]], ",": [[51, 0]], "-": [[12,
        0]], ".": [[52, 0]], "/": [[53, 0]], "0": [[11, 0]], "1": [[2,
        0]], "2": [[3, 0]], "3": [[4, 0]], "4": [[5, 0]], "5": [[6,
        0]], "6": [[7, 0]], "7": [[8, 0]], "8": [[9, 0]], "9": [[10,
        0]], ":": [[39, 1]], ";": [[39, 0]], "<": [[51, 1]], "=":
        [[13, 0]], ">": [[52, 1]], "?": [[53, 1]], "@": [[3, 1]], "A":
        [[30, 1]], "B": [[48, 1]], "C": [[46, 1]], "D": [[32, 1]],
        "E": [[18, 1]], "F": [[33, 1]], "G": [[34, 1]], "H": [[35,
        1]], "I": [[23, 1]], "J": [[36, 1]], "K": [[37, 1]], "L":
        [[38, 1]], "M": [[50, 1]], "N": [[49, 1]], "O": [[24, 1]],
        "P": [[25, 1]], "Q": [[16, 1]], "R": [[19, 1]], "S": [[31,
        1]], "T": [[20, 1]], "U": [[22, 1]], "V": [[47, 1]], "W":
        [[17, 1]], "X": [[45, 1]], "Y": [[21, 1]], "Z": [[44, 1]],
        "[": [[26, 0]], "\\": [[43, 0]], "]": [[27, 0]], "^": [[7,
        1]], "_": [[12, 1]], "`": [[41, 0]], "a": [[30, 0]], "b":
        [[48, 0]], "c": [[46, 0]], "d": [[32, 0]], "e": [[18, 0]],
        "f": [[33, 0]], "g": [[34, 0]], "h": [[35, 0]], "i": [[23,
        0]], "j": [[36, 0]], "k": [[37, 0]], "l": [[38, 0]], "m":
        [[50, 0]], "n": [[49, 0]], "o": [[24, 0]], "p": [[25, 0]],
        "q": [[16, 0]], "r": [[19, 0]], "s": [[31, 0]], "t": [[20,
        0]], "u": [[22, 0]], "v": [[47, 0]], "w": [[17, 0]], "x":
        [[45, 0]], "y": [[21, 0]], "z": [[44, 0]], "{": [[26, 1]],
        "|": [[43, 1]], "}": [[27, 1]], "~": [[41, 1]]}},

    "kbdgr": {
        has_altgr: true, charset: {"\"": [[3, 1]], "#": [[43, 0]],
        "&": [[7, 1]], "'": [[43, 1]], "(": [[9, 1]], ")": [[10, 1]],
        "*": [[27, 1]], "+": [[27, 0]], "-": [[53, 0]], "/": [[8, 1]],
        ":": [[52, 1]], ";": [[51, 1]], "<": [[86, 0]], "=": [[11,
        1]], ">": [[86, 1]], "?": [[12, 1]], "@": [[16, 6]], "Y":
        [[44, 1]], "Z": [[21, 1]], "[": [[9, 6]], "\\": [[12, 6]],
        "]": [[10, 6]], "^": [[41, 0], [57, 0]], "_": [[53, 1]], "`":
        [[13, 1], [57, 0]], "y": [[44, 0]], "z": [[21, 0]], "{": [[8,
        6]], "|": [[86, 6]], "}": [[11, 6]], "~": [[27, 6]], "§": [[4,
        1]], "°": [[41, 1]], "²": [[3, 6]], "³": [[4, 6]], "´": [[13,
        0], [57, 0]], "µ": [[50, 6]], "À": [[13, 1], [30, 1]], "Á":
        [[13, 0], [30, 1]], "Â": [[41, 0], [30, 1]], "Ä": [[40, 1]],
        "È": [[13, 1], [18, 1]], "É": [[13, 0], [18, 1]], "Ê": [[41,
        0], [18, 1]], "Ì": [[13, 1], [23, 1]], "Í": [[13, 0], [23,
        1]], "Î": [[41, 0], [23, 1]], "Ò": [[13, 1], [24, 1]], "Ó":
        [[13, 0], [24, 1]], "Ô": [[41, 0], [24, 1]], "Ö": [[39, 1]],
        "Ù": [[13, 1], [22, 1]], "Ú": [[13, 0], [22, 1]], "Û": [[41,
        0], [22, 1]], "Ü": [[26, 1]], "Ý": [[13, 0], [44, 1]], "ß":
        [[12, 0]], "à": [[13, 1], [30, 0]], "á": [[13, 0], [30, 0]],
        "â": [[41, 0], [30, 0]], "ä": [[40, 0]], "è": [[13, 1], [18,
        0]], "é": [[13, 0], [18, 0]], "ê": [[41, 0], [18, 0]], "ì":
        [[13, 1], [23, 0]], "í": [[13, 0], [23, 0]], "î": [[41, 0],
        [23, 0]], "ò": [[13, 1], [24, 0]], "ó": [[13, 0], [24, 0]],
        "ô": [[41, 0], [24, 0]], "ö": [[39, 0]], "ù": [[13, 1], [22,
        0]], "ú": [[13, 0], [22, 0]], "û": [[41, 0], [22, 0]], "ü":
        [[26, 0]], "ý": [[13, 0], [44, 0]], "ẞ": [[12, 7]], "€": [[18,
        6]]}},

    "kbduk": {
        has_altgr: true, charset: {"\"": [[3, 1]], "#": [[43,
        0]], "@": [[40, 1]], "\\": [[86, 0]], "|": [[86, 1]], "~":
        [[43, 1]], "£": [[4, 1]], "¦": [[41, 6]], "¬": [[41, 1]], "Á":
        [[30, 7]], "É": [[18, 7]], "Í": [[23, 7]], "Ó": [[24, 7]],
        "Ú": [[22, 7]], "á": [[30, 6]], "é": [[18, 6]], "í": [[23,
        6]], "ó": [[24, 6]], "ú": [[22, 6]], "€": [[5, 6]]}}
};

/**
 * @param {string} kbdid
 * @return {!Object<!string,!Array<!Array<!number>>>}
 */
function get_keymap(kbdid)
{
    const keyboard = kbdid && KEYMAPS[kbdid] ? KEYMAPS[kbdid] : KEYMAPS["kbdus"];

    if(!keyboard.keyboard_initialized)
    {
        if(kbdid !== "kbdus")
        {
            // Unpack non-US charset: insert all US-codepoint mappings into keyboard.charset that are
            // a) not defined in keyboard.charset and
            // b) not element of keyboard.charset_missing
            // NOTE: Not all keyboard charsets are an exact superset of the US-keyboard's,
            //       for example the Italian keyboard "kbdit" lacks "~" and "`".
            const charset = keyboard.charset;
            const charset_missing = keyboard.charset_missing ? keyboard.charset_missing : [];
            for(const [codepoint_str, us_keys] of Object.entries(KEYMAPS["kbdus"].charset))
            {
                const codepoint = codepoint_str.codePointAt(0);
                if(charset[codepoint_str] === undefined && !charset_missing.includes(codepoint))
                {
                    // deep copy us_keys: array(array(scancode, modifier), ...)
                    charset[codepoint_str] = JSON.parse(JSON.stringify(us_keys));
                }
            }

            // Non-US keyboards may feature an AltGr-key, translate Ctrl+Alt modifier to AltGr
            if(keyboard.has_altgr)
            {
                for(const keys of Object.values(charset))
                {
                    for(const key of keys)
                    {
                        if((key[1] & MODIFIER_CTRL_ALT) === MODIFIER_CTRL_ALT)
                        {
                            key[1] = (key[1] & ~MODIFIER_CTRL_ALT) | MODIFIER_ALTGR;
                        }
                    }
                }
            }
        }

        // Add scancodes of universal non-visible characters below 0x20
        keyboard.charset["\t"] = [[SCANCODE["Tab"], MODIFIER_NONE]];
        keyboard.charset["\n"] = [[SCANCODE["Enter"], MODIFIER_NONE]];
        keyboard.charset["\b"] = [[SCANCODE["Backspace"], MODIFIER_NONE]];

        keyboard.kbdid = kbdid;
        keyboard.keyboard_initialized = true;
    }

    return keyboard.charset;
}

// DataKeyboard.state values
const DK_STATE_IDLE = 0;
const DK_STATE_BUSY = 1;
const DK_STATE_ABORTED = 2;
const DK_STATE_FINISHING = 3;

class DataKeyboard
{
    /**
     * @param {Object} bus
     * @param {DesktopKeyboard} desktop_keyboard
     * @param {string} kbdid
     * @param {number} burst_size
     * @param {number} burst_delay
     */
    constructor(bus, desktop_keyboard, kbdid, burst_size, burst_delay)
    {
        burst_size = burst_size !== undefined ? burst_size : 15;
        burst_delay = burst_delay !== undefined ? burst_delay : 100;
        if(!burst_size || !burst_delay)
        {
            burst_size = burst_delay = 0;
        }

        this.bus = bus;                           // system bus
        this.desktop_keyboard = desktop_keyboard; // DesktopKeyboard
        this.keymap = get_keymap(kbdid);          // keyboard layout map, maps characters to scancode sequences
        this.burst_size = burst_size;             // burst size in bytes (ignored of burst_delay is 0)
        this.burst_delay = burst_delay;           // inter-burst delay in milliseconds or 0 to send unthrottled
        this.destroyed = false;                   // if true, shutdown() has been called
        this.state = DK_STATE_IDLE;               // main state
        this.keys_pressed = new Set();            // Set<number>, the set of pressed key scancodes
        this.bytes_sent = 0;                      // number of bytes sent in the current burst
    }

    reset()
    {
        this.destroyed = false;
        this.state = DK_STATE_IDLE;
        this.keys_pressed.clear();
        this.bytes_sent = 0;
    }

    shutdown()
    {
        if(!this.destroyed && this.state !== DK_STATE_IDLE)
        {
            this.destroyed = true;
            this.state = DK_STATE_ABORTED;
        }
    }

    abort()
    {
        if(this.state === DK_STATE_BUSY)
        {
            this.state = DK_STATE_ABORTED;
        }
    }

    /**
     * @param {!Array<!number>} scancodes
     */
    async send_scancodes(scancodes)
    {
        if(scancodes.length)
        {
            await this.send_data(async () => await this.send_scancode(...scancodes));
        }
    }

    /**
     * @param {!Array<!string>} keys
     * @param {number=} hold_time
     */
    async send_keypress(keys, hold_time)
    {
        if(keys.length)
        {
            await this.send_data(async () => {
                for(const code of keys)
                {
                    if(code.length === 1)
                    {
                        const ch_keys = this.keymap[code];
                        if(ch_keys !== undefined)
                        {
                            await this.send_scancode(ch_keys[ch_keys.length-1][0]);
                        }
                        else
                        {
                            console.log("Missing char in keyboard layout map: char=\"" + code + "\"");
                        }
                    }
                    else
                    {
                        const scancode = SCANCODE[code];
                        if(scancode !== undefined)
                        {
                            await this.send_scancode(scancode);
                        }
                        else
                        {
                            console.log("Missing code in scancode map: code=" + code);
                        }
                    }
                }
                if(hold_time)
                {
                    await new Promise(resolve => setTimeout(resolve, hold_time));
                }
            });
        }
    }

    /**
     * @param {!string} text
     */
    async send_text(text)
    {
        if(text.length)
        {
            await this.send_data(async () => {
                let shift_pressed = false, altgr_pressed = false;
                for(const ch of text)
                {
                    const ch_keys = this.keymap[ch];
                    if(ch_keys !== undefined)
                    {
                        for(const [scancode, modifier] of ch_keys)
                        {
                            if(!!(modifier & MODIFIER_SHIFT) !== shift_pressed)
                            {
                                shift_pressed = !shift_pressed;
                                await this.send_scancode(SCANCODE["ShiftLeft"] | (shift_pressed ? 0 : SCANCODE_RELEASE));
                            }
                            if(!!(modifier & MODIFIER_ALTGR) !== altgr_pressed)
                            {
                                altgr_pressed = !altgr_pressed;
                                await this.send_scancode(SCANCODE["AltRight"] | (altgr_pressed ? 0 : SCANCODE_RELEASE));
                            }
                            await this.send_scancode(scancode, scancode | SCANCODE_RELEASE);
                        }
                    }
                    else
                    {
                        console.log("Missing char in keyboard layout map: char=\"" + ch + "\"");
                    }
                }
            });
        }
    }

    /**
     * @param {!function()} data_function
     */
    async send_data(data_function)
    {
        if(this.state === DK_STATE_IDLE)
        {
            // initial keyboard state is a copy of desktop_keyboard
            this.desktop_keyboard.mute(true);
            this.keys_pressed = new Set(this.desktop_keyboard.keys_pressed);
            this.state = DK_STATE_BUSY;
            this.bytes_sent = 0;

            try
            {
                // bring keyboard into the idle state
                await this.send_sync_scancodes(new Set());
                await data_function();
            }
            catch(e)
            {
                if(!(e instanceof Aborted))
                {
                    throw new Error(e.message, {cause: e});
                }
            }

            if(!this.destroyed)
            {
                // bring keyboard into the current state of desktop_keyboard
                this.state = DK_STATE_FINISHING;
                await this.send_sync_scancodes(this.desktop_keyboard.keys_pressed);
            }

            this.desktop_keyboard.mute(false);
            this.state = DK_STATE_IDLE;
        }
    }

    /**
     * @param {!Set<!number>} new_keys
     */
    async send_sync_scancodes(new_keys)
    {
        const curr_keys = new Set(this.keys_pressed);
        if(!set_is_identical(curr_keys, new_keys))
        {
            // find, group and send scancodes of keys that need to be released
            const release_keys = set_difference(curr_keys, new_keys);
            if(release_keys.size)
            {
                const [release_mod_keys, release_alnum_keys] = set_split_group(release_keys, MODIFIER_SCANCODES);
                // 1. release alphanumeric keys
                await this.send_scancode(...[...release_alnum_keys].map(scancode => scancode | SCANCODE_RELEASE));
                // 2. release modifier keys
                await this.send_scancode(...[...release_mod_keys].map(scancode => scancode | SCANCODE_RELEASE));
            }
            // find, group and send scancodes of keys that need to be pressed
            const press_keys = set_difference(new_keys, curr_keys);
            if(press_keys.size)
            {
                const [press_mod_keys, press_alnum_keys] = set_split_group(press_keys, MODIFIER_SCANCODES);
                // 3. press modifier keys
                await this.send_scancode(...press_mod_keys);
                // 4. press alphanumeric keys
                await this.send_scancode(...press_alnum_keys);
            }
        }
    }

    /**
     * @param {...number} scancodes
     */
    async send_scancode(...scancodes)
    {
        for(const scancode of scancodes)
        {
            // delay if scancode exceeds burst size
            const n_bytes = scancode < 0x100 ? 1 : 2;
            if(this.burst_delay && this.bytes_sent + n_bytes > this.burst_size)
            {
                await new Promise(resolve => setTimeout(resolve, this.burst_delay));
                this.bytes_sent = 0;
            }

            // if aborted, throw an exception to unwind stack, caught by send_data()
            if(this.state === DK_STATE_ABORTED)
            {
                throw new Aborted();
            }

            // send scancode to bus
            if(n_bytes === 2)
            {
                this.bus.send("keyboard-code", scancode >> 8);
            }
            this.bus.send("keyboard-code", scancode & 0xff);
            this.bytes_sent += n_bytes;

            // update keyboard state
            if(scancode & SCANCODE_RELEASE)
            {
                this.keys_pressed.delete(scancode & ~SCANCODE_RELEASE);
            }
            else
            {
                this.keys_pressed.add(scancode);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// class KeyboardAdapter
// ---------------------------------------------------------------------------

/**
 * @constructor
 *
 * @param {BusConnector} bus
 * @param {Object=} options
 */
export function KeyboardAdapter(bus, options)
{
    this.bus = bus;

    /**
     * Set by emulator
     * @type {boolean}
     */
    this.emu_enabled = true;

    const keyboard = this;
    const desktop_keyboard = new DesktopKeyboard(bus);
    const data_keyboard = new DataKeyboard(bus, desktop_keyboard, options?.kbdid, options?.burst_size, options?.burst_delay);

    desktop_keyboard.data_keyboard = data_keyboard;

    this.destroy = function()
    {
        desktop_keyboard.shutdown();
        data_keyboard.shutdown();
        if(typeof window !== "undefined")
        {
            window.removeEventListener("keydown", keydown_handler, false);
            window.removeEventListener("keyup", keyup_handler, false);
            window.removeEventListener("blur", blur_handler, false);
            window.removeEventListener("input", input_handler, false);
        }
    };

    this.init = function()
    {
        this.destroy();

        desktop_keyboard.reset();
        data_keyboard.reset();
        if(typeof window !== "undefined")
        {
            window.addEventListener("keydown", keydown_handler, false);
            window.addEventListener("keyup", keyup_handler, false);
            window.addEventListener("blur", blur_handler, false);
            window.addEventListener("input", input_handler, false);
        }
    };
    this.init();

    /**
     * @param {!Event} e
     */
    function may_handle(e)
    {
        if(e.shiftKey && e.ctrlKey && (e.key === "I" || e.key === "J" || e.key === "K"))
        {
            // don't prevent opening chromium dev tools
            // maybe add other important combinations here, too
            return false;
        }

        if(!keyboard.emu_enabled)
        {
            return false;
        }

        if(!keyboard.bus)
        {
            return false;
        }

        if(e.target)
        {
            // TODO: className shouldn't be hardcoded here
            return e.target.classList.contains("phone_keyboard") ||
                (e.target.nodeName !== "INPUT" && e.target.nodeName !== "TEXTAREA");
        }
        else
        {
            return true;
        }
    }

    /**
     * @param {!Event} e
     */
    function keydown_handler(e)
    {
        if(may_handle(e))
        {
            return desktop_keyboard.handle_event(e, true);
        }
    }

    /**
     * @param {!Event} e
     */
    function keyup_handler(e)
    {
        if(may_handle(e))
        {
            return desktop_keyboard.handle_event(e, false);
        }
    }

    /**
     * @param {!Event} e
     */
    function blur_handler(e)
    {
        desktop_keyboard.release_pressed_keys();
    }

    /**
     * @param {!Event} e
     */
    function input_handler(e)
    {
        if(may_handle(e))
        {
            switch(e.inputType)
            {
                case "insertText":
                    data_keyboard.send_text(e.data);
                    break;
                case "insertLineBreak":
                    data_keyboard.send_keypress(["Enter"]);
                    break;
                case "deleteContentBackward":
                    data_keyboard.send_keypress(["Backspace"]);
                    break;
            }
        }
    }

    /**
     * @param {!Array<!number>} scancodes
     */
    this.simulate_scancodes = async function(scancodes)
    {
        await data_keyboard.send_scancodes(scancodes);
    };

    /**
     * @param {!Array<!string>} keys
     * @param {number=} hold_time
     */
    this.simulate_keypress = async function(keys, hold_time)
    {
        await data_keyboard.send_keypress(keys, hold_time);
    };

    /**
     * @param {!string} text
     */
    this.simulate_text = async function(text)
    {
        await data_keyboard.send_text(text);
    };
}
