import { dbg_log } from "../log.js";
import { LOG_MODEM } from "../const.js";

// For Types Only
import { BusConnector } from "../bus.js";

/*
 * Hayes-compatible Modem emulation.
 *
 * Reference:
 * - [V250] V.250: Serial asynchronous automatic dialling and control
 *   https://www.itu.int/rec/T-REC-V.250-200307-I/en
 * - [TELIT] AT Commands Reference Guide
 *   https://docs.rs-online.com/c5f6/0900766b81541066.pdf
 */

const ASCII_BEL = 0x07;     // bell character
const ASCII_WS = 0x20;      // whitespace character " "
const ASCII_ZERO = 0x30;    // "0"

/*
 * AT command sprecifications
 *
 * The standard syntax for base AT commands is:
 *     "AT" ["&"]<CMD>[<ARG>]
 * - Commands that do not expect an argument are declared below using [].
 * - Commands that do not support a default argument value are declared using [<min>, <max>],
 *   with <min> and <max> defining the integer boundaries of <ARG>, both inclusive.
 * - Commands that support a default argument value are declared using [<min>, <max>, <default>].
 * - Commands having a non-standard syntax are declared using "custom".
 */
const AT_COMMANDS =
{
    "A":   [],          // [V250] 6.3.5 Answer
    "D":   "custom",    // [V250] 6.3.1 Dial
    "E":   [0, 1, 1],   // [V250] 6.2.4 Command echo
    "H":   [0, 0, 0],   // [V250] 6.3.6 Hook control
    "I":   [3, 3],      // [V250] 6.1.3 Request identification information
    "L":   [0, 3, 1],   // [V250] 6.3.13 Monitor speaker loudness
    "M":   [0, 2, 1],   // [V250] 6.3.14 Monitor speaker mode
    "O":   [0, 0, 0],   // [V250] 6.3.7 Return to online data state
    "P":   [],          // [V250] 6.3.3 Select pulse dialling
    "Q":   [0, 1, 0],   // [V250] 6.2.5 Result code suppression
    "S":   [0, 5],      // [V250] see Modem.reset() below
    "T":   [],          // [V250] 6.3.2 Select tone dialling
    "V":   [0, 1, 0],   // [V250] 6.2.6 DCE response format
    "X":   [0, 4, 0],   // [V250] 6.2.7 Result code selection
    "Z":   [0, 0, 0],   // [V250] 6.1.1 Reset to default configuration
    "&C":  [0, 1, 1],   // [V250] 6.2.8 Received line signal (DCD) detector behaviour
    "&D":  [0, 2, 2],   // [V250] 6.2.9 Data terminal ready (DTR) behaviour
    "&F":  [0, 0, 0],   // [V250] 6.1.2 Set to factory-defined configuration
    "&K":  [0, 6, 3]    // [TELIT] 3.5.3.2.9 Flow Control
};

// AT response codes
const AT_RESP_OK = 0;
const AT_RESP_CONNECT = 1;
const AT_RESP_RING = 2;
const AT_RESP_NO_CARRIER = 3;
const AT_RESP_ERROR = 4;

const AT_RESP_NAME =
{
    [AT_RESP_OK]: "OK",
    [AT_RESP_CONNECT]: "CONNECT",
    [AT_RESP_RING]: "RING",
    [AT_RESP_NO_CARRIER]: "NO CARRIER",
    [AT_RESP_ERROR]: "ERROR"
};

// S-Register indices
const SREG_AUTOANSWER_CNT = 0;
const SREG_RING_CNT = 1;
const SREG_ESC = 2;
const SREG_CR = 3;
const SREG_LF = 4;
const SREG_BS = 5;

// what to do when DTR drops from high to low (Modem.dtr_low_behaviour)
const DTR_LOW_IGNORE = 0;
const DTR_LOW_KEEP_CONN = 1;
const DTR_LOW_DROP_CONN = 2;

// online escape sequence timing
const ESC_MIN_PAUSE_MS = 1000;
const ESC_MAX_DELAY_MS = 200;

const CMDLINE_BUF_SIZE = 256;

const SEND_BUF_SIZE = 512;
const SEND_BUF_SAMPLE_INTERVAL_MS = 10;
const SEND_BUF_MAX_IDLE_TIME_MS = 5;

// matches all strings that start with "ws://" or "wss://" (case-insensitive)
const RE_WS_ADDR = /^ws[s]?:\/\//i;

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder();

/**
 * @constructor
 * @param {BusConnector} bus
 * @param {Object} options
 */
export function Modem(bus, options)
{
    /** @const @type {BusConnector} */
    this.bus = bus;

    /** @const @type {number} */
    this.uart = options.uart - 1;

    /** @const @type {Uint8Array} */
    this.cli_buffer = new Uint8Array(CMDLINE_BUF_SIZE);

    // state that is not defined in this.reset():
    this.dtr_state = false;
    this.rts_state = false;
    this.sreg = new Uint8Array(6);

    this.in_data_mode = false;
    this.data_mode_send_buffer = new Uint8Array(SEND_BUF_SIZE);
    this.data_mode_send_cursor = 0;
    this.data_mode_send_inverval = null;
    this.data_mode_esc_timer = null;

    this.phonebook = options.phonebook || {};

    this.socket = null;

    this.reset();

    this.bus.register("serial" + this.uart + "-data-terminal-ready-output", function(dtr_state)
    {
        dtr_state = !!dtr_state;
        if(this.dtr_state !== dtr_state)
        {
            dbg_log(`DTR=${dtr_state}`, LOG_MODEM);
            this.dtr_state = dtr_state;
            if(this.socket && !dtr_state)
            {
                if(this.dtr_low_behaviour === DTR_LOW_KEEP_CONN)
                {
                    this.enter_cli_mode();
                    this.cli_write_response_code(AT_RESP_OK);
                }
                else if(this.dtr_low_behaviour === DTR_LOW_DROP_CONN)
                {
                    this.socket.close();
                }
            }
        }
    }, this);

    this.bus.register("serial" + this.uart + "-request-to-send-output", function(rts_state)
    {
        rts_state = !!rts_state;
        if(this.rts_state !== rts_state)
        {
            dbg_log(`RTS=${rts_state}`, LOG_MODEM);
            this.rts_state = rts_state;
        }
    }, this);

    this.bus.register("serial" + this.uart + "-output-byte", function(data)
    {
        if(this.data_mode_esc_timer !== null)
        {
            clearTimeout(this.data_mode_esc_timer);
            this.data_mode_esc_timer = null;
        }
        if(this.in_data_mode)
        {
            this.data_mode_uart_recv(data);
        }
        else
        {
            this.cli_mode_uart_recv(data);
        }
    }, this);

    // must wait for CPU to be initialized before we can use the bus
    this.bus.register("emulator-ready", function()
    {
        this.uart_set_dsr(true);
        this.uart_set_cts(true);
        this.uart_set_ring(false);
        this.uart_set_dcd(false);
    }, this);

    dbg_log(`Modem at UART${this.uart} ready`, LOG_MODEM);
}

Modem.prototype.reset = function()
{
    this.do_echo = true;
    this.cli_cursor = 0;
    this.cli_overflow = false;
    this.resp_suppress = false;
    this.resp_verbose = true;
    this.use_rtscts_flowctrl = true;
    this.use_tone_dialling = false;
    this.dcd_always_on = false;
    this.dtr_low_behaviour = DTR_LOW_DROP_CONN;

    this.uart_recv_tm = 0;
    this.data_mode_esc_count = 0;
    this.reset_on_disconnect = false;

    this.sreg[SREG_AUTOANSWER_CNT] = 0; // S0: Number of RINGs before automatic answer, see [V250] 6.3.8
    this.sreg[SREG_RING_CNT] = 0;       // S1: RING counter, see [TELIT] 3.5.3.6.2
    this.sreg[SREG_ESC] = 0x2b;         // S2: DATA mode escape character "+", see [TELIT] 3.5.3.6.3
    this.sreg[SREG_CR] = 0x0d;          // S3: Command line termination character "\r" (Carriage return), see [V250] 6.2.1
    this.sreg[SREG_LF] = 0x0a;          // S4: Response formatting character "\n" (Line feed), see [V250] 6.2.2
    this.sreg[SREG_BS] = 0x08;          // S5: Command line editing character "\b" (Backspace), see [V250] 6.2.3
};

/**
 * @param {boolean} dcd_state
 */
Modem.prototype.uart_set_dcd = function(dcd_state)
{
    dbg_log(`DCD=${dcd_state}`, LOG_MODEM);
    this.bus.send(`serial${this.uart}-carrier-detect-input`, dcd_state);
};

/**
 * @param {boolean} ring_state
 */
Modem.prototype.uart_set_ring = function(ring_state)
{
    dbg_log(`RING=${ring_state}`, LOG_MODEM);
    this.bus.send(`serial${this.uart}-ring-indicator-input`, ring_state);
};

/**
 * @param {boolean} dsr_state
 */
Modem.prototype.uart_set_dsr = function(dsr_state)
{
    dbg_log(`DSR=${dsr_state}`, LOG_MODEM);
    this.bus.send(`serial${this.uart}-data-set-ready-input`, dsr_state);
};

/**
 * @param {boolean} cts_state
 */
Modem.prototype.uart_set_cts = function(cts_state)
{
    dbg_log(`CTS=${cts_state}`, LOG_MODEM);
    this.bus.send(`serial${this.uart}-clear-to-send-input`, cts_state);
};

/**
 * @param {number} data
 */
Modem.prototype.uart_write_byte = function(data)
{
    this.bus.send(`serial${this.uart}-input`, data);
};

/**
 * @param {string} str
 */
Modem.prototype.uart_write = function(str)
{
    for(const ch of text_encoder.encode(str))
    {
        this.uart_write_byte(ch);
    }
};

Modem.prototype.enter_cli_mode = function()
{
    if(this.in_data_mode)
    {
        dbg_log(`switching to command mode`, LOG_MODEM);
        this.in_data_mode = false;
        this.data_mode_flush();
        if(this.data_mode_send_inverval !== null)
        {
            clearInterval(this.data_mode_send_inverval);
            this.data_mode_send_inverval = null;
        }

        this.uart_set_dsr(true);
        this.uart_set_cts(true);
        this.uart_set_ring(false);
        if(!this.dcd_always_on)
        {
            this.uart_set_dcd(this.socket !== null);
        }
    }
};

Modem.prototype.enter_data_mode = function()
{
    if(!this.in_data_mode)
    {
        dbg_log(`switching to data mode`, LOG_MODEM);
        this.in_data_mode = true;
        this.data_mode_send_inverval = setInterval(() => {
            if(this.data_mode_send_cursor && (performance.now() - this.uart_recv_tm) > SEND_BUF_MAX_IDLE_TIME_MS)
            {
                this.data_mode_flush();
            }
        }, SEND_BUF_SAMPLE_INTERVAL_MS);

        this.uart_set_ring(false);
        if(!this.dcd_always_on)
        {
            this.uart_set_dcd(true);
        }
    }
};

Modem.prototype.flush_escape_buffer = function()
{
    for(; this.data_mode_esc_count > 0; this.data_mode_esc_count--)
    {
        if(this.in_data_mode)
        {
            this.data_mode_send(this.sreg[SREG_ESC]);
        }
        else
        {
            this.uart_write_byte(this.sreg[SREG_ESC]);
        }
    }
};

/**
 * @param {number} data
 */
Modem.prototype.data_mode_send = function(data)
{
    if(this.socket)
    {
        this.data_mode_send_buffer[this.data_mode_send_cursor++] = data;
        if(this.data_mode_send_cursor === this.data_mode_send_buffer.byteLength)
        {
            this.data_mode_flush();
        }
    }
};

Modem.prototype.data_mode_flush = function()
{
    if(this.data_mode_send_cursor && this.socket)
    {
        this.socket.send(this.data_mode_send_buffer.slice(0, this.data_mode_send_cursor));
        this.data_mode_send_cursor = 0;
    }
};

/**
 * @param {number} uart_byte
 */
Modem.prototype.data_mode_uart_recv = function(uart_byte)
{
    if(uart_byte === this.sreg[SREG_ESC] &&
        this.data_mode_esc_count < 3 &&
        (this.data_mode_esc_count > 0 || (performance.now() - this.uart_recv_tm) > ESC_MIN_PAUSE_MS))
    {
        // received an escape character (default "+", escape sequence: pause +++ pause)
        // - if it's the 1st in the sequence of 3 then a minimum pause of ESC_MIN_PAUSE_MS has passed before
        // - if it's the 2nd or 3rd then at most ESC_MAX_DELAY_MS have passed since the previous escape character
        // - if, after the 3rd, no other byte was received for a time of ESC_MIN_PAUSE_MS, accept the escape sequence
        // - in all other cases abort and send the 1..3 buffered escape characters
        if(++this.data_mode_esc_count < 3)
        {
            this.data_mode_esc_timer = setTimeout(() => {
                this.data_mode_esc_timer = null;
                this.flush_escape_buffer();
            }, ESC_MAX_DELAY_MS);
        }
        else
        {
            this.data_mode_esc_timer = setTimeout(() => {
                this.data_mode_esc_timer = null;
                this.enter_cli_mode();
                this.flush_escape_buffer();
                this.cli_write_response_code(AT_RESP_OK);
            }, ESC_MIN_PAUSE_MS);
        }
    }
    else
    {
        this.uart_recv_tm = performance.now();
        this.flush_escape_buffer();
        this.data_mode_send(uart_byte);
    }
};

/**
 * @param {number} uart_byte
 */
Modem.prototype.cli_mode_uart_recv = function(uart_byte)
{
    if(this.do_echo)
    {
        this.uart_write_byte(uart_byte);
        if(uart_byte === this.sreg[SREG_BS])
        {
            this.uart_write_byte(ASCII_WS);
            this.uart_write_byte(this.sreg[SREG_BS]);
        }
    }
    switch(uart_byte)
    {
        case this.sreg[SREG_BS]:
            if(this.cli_cursor > 0)
            {
                this.cli_cursor--;
            }
            break;
        case this.sreg[SREG_CR]:
            if(this.cli_overflow)
            {
                const data = text_decoder.decode(this.cli_buffer.buffer);
                dbg_log(`error: AT command buffer overflow: "${data}"`, LOG_MODEM);
                this.cli_overflow = false;
                // do NOT send any response when clearing buffer after overflow
            }
            else
            {
                this.cli_exec(text_decoder.decode(this.cli_buffer.slice(0, this.cli_cursor)).replace(/\s/g, ""));
            }
            this.cli_cursor = 0;
            break;
        case this.sreg[SREG_LF]:
            break;
        default:
            if(this.cli_cursor < this.cli_buffer.length)
            {
                this.cli_buffer[this.cli_cursor++] = uart_byte;
            }
            else
            {
                this.cli_overflow = true;
                this.uart_write_byte(ASCII_BEL);
            }
            break;
    }
};

/**
 * @param {Array} cmd_spec
 * @param {number|undefined} arg
 */
Modem.prototype.cli_decode_arg = function(cmd_spec, arg)
{
    if(arg === undefined)
    {
        if(cmd_spec.length)
        {
            if(cmd_spec.length > 2)
            {
                return cmd_spec[2];  // use default argument value
            }
            else
            {
                return false;  // error: missing required argument
            }
        }
    }
    else if(cmd_spec.length < 2 || arg < cmd_spec[0] || arg > cmd_spec[1])
    {
        return false;  // error: unexpected argument or value out of bounds
    }
    return arg;
};

/**
 * @param {string} dial_address
 * @param {boolean} use_wss_protocol
 */
Modem.prototype.cli_translate_dial_address = function(dial_address, use_wss_protocol)
{
    let ws_address;
    if(dial_address in this.phonebook)
    {
        ws_address = this.phonebook[dial_address];
    }
    else if(dial_address.length)
    {
        const m = dial_address.match(/(\d{1,3})[^\d]*(\d{1,3})[^\d]*(\d{1,3})[^\d]*(\d{1,3})[^\d]*(\d{0,5})/);
        if(m)
        {
            const num = (index, limit) => {
                if(m[index].length) {
                    const n = Number(m[index]);
                    return n < limit ? n : -1;
                }
                return undefined;
            };
            const n1 = num(1, 256), n2 = num(2, 256), n3 = num(3, 256), n4 = num(4, 256), n5 = num(5, 65536);
            if(n1 >= 0 && n2 >= 0 && n3 >= 0 && n4 >= 0 && (n5 === undefined || n5 >= 0))
            {
                ws_address = n5 === undefined ? `${n1}.${n2}.${n3}.${n4}` : `${n1}.${n2}.${n3}.${n4}:${n5}`;
            }
        }
        if(ws_address === undefined)
        {
            ws_address = dial_address;
        }
        if(!RE_WS_ADDR.test(ws_address))
        {
            ws_address = (use_wss_protocol ? "wss://" : "ws://") + ws_address;
        }
    }
    return ws_address;
};

/**
 * @param {string} dial_address
 * @param {number} offset
 */
Modem.prototype.cli_exec_dial = function(dial_address, offset)
{
    // strip prefix "T" or "P", quotes and trailing ";" from dial_address
    let enter_data_mode = true;
    let use_wss_protocol = this.use_tone_dialling;
    const index_semi = dial_address.lastIndexOf(";");
    if(index_semi >= 0)
    {
        enter_data_mode = false;
        dial_address = dial_address.substring(0, index_semi);
    }
    if(offset < dial_address.length)
    {
        const dial_method = dial_address[offset].toUpperCase();
        if(dial_method === "T" || dial_method === "P")
        {
            offset++;
            use_wss_protocol = dial_method === "T";
        }
    }
    if(offset < dial_address.length && dial_address[offset] === "\"")
    {
        offset++;
        const index_quot = dial_address.indexOf("\"", offset);
        if(index_quot >= 0)
        {
            dial_address = dial_address.substring(0, index_quot);
        }
    }
    dial_address = dial_address.substring(offset);

    // translate remaining dial address into a fully-qualified WebSocket address
    const ws_address = this.cli_translate_dial_address(dial_address, use_wss_protocol);
    if(ws_address === undefined)
    {
        dbg_log(`error: invalid dial address "${dial_address}"`, LOG_MODEM);
        this.cli_write_response_code(AT_RESP_ERROR);
        return;
    }

    // create and connect client WebSocket
    dbg_log(`connecting "${ws_address}"`, LOG_MODEM);
    try
    {
        this.socket = new WebSocket(ws_address);
    }
    catch(e)
    {
        dbg_log(`error: WebSocket constructor failed using address "${ws_address}"`, LOG_MODEM);
        this.cli_write_response_code(AT_RESP_ERROR);
        return;
    }

    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", (event) => {
        this.data_mode_send_cursor = 0;
        if(enter_data_mode)
        {
            this.enter_data_mode();
            this.cli_write_response_code(AT_RESP_CONNECT);
        }
        else
        {
            this.cli_write_response_code(AT_RESP_OK);
        }
    });
    this.socket.addEventListener("message", (event) => {
        if(this.in_data_mode && (!this.use_rtscts_flowctrl || this.rts_state))
        {
            const bytes = new Uint8Array(event.data);
            for(let i=0; i<event.data.byteLength; i++)
            {
                this.uart_write_byte(bytes[i]);
            }
        }
    });
    this.socket.addEventListener("close", (event) => {
        this.socket = null;
        this.enter_cli_mode();
        if(this.reset_on_disconnect)
        {
            this.reset();
            this.reset_on_disconnect = false;
        }
        this.cli_write_response_code(AT_RESP_NO_CARRIER);
    });
};

/**
 * @param {string} cmdline
 */
Modem.prototype.cli_exec = function(cmdline)
{
    const length = cmdline.length;
    if(length === 0)
    {
        dbg_log(`received empty AT command line`, LOG_MODEM);
        if(this.socket && this.socket.readyState === WebSocket.CONNECTING)
        {
            // abort dial command, exit parser without response (delayed in "close" socket event)
            this.socket.close();
        }
        else
        {
            this.cli_write_response_code(AT_RESP_OK);
        }
        return;
    }
    let offset = cmdline.search(/(at|AT)/);
    if(offset < 0)
    {
        // do NOT send any response for non-empty lines without AT command (Trumpet Winsock trips over this)
        dbg_log(`error: missing AT command in "${cmdline}"`, LOG_MODEM);
        return;
    }
    offset += 2;

    const decode_uint = () => {
        const start_offset = offset;
        let acc = 0;
        while(offset < length)
        {
            const digit = cmdline.charCodeAt(offset) - ASCII_ZERO;
            if(digit < 0 || digit > 9)
            {
                break;
            }
            else
            {
                acc = acc * 10 + digit;
                offset++;
            }
        }
        return offset === start_offset ? undefined : acc;
    };

    dbg_log(`executing command line "${cmdline}"`, LOG_MODEM);

    let response_code = true;
    while(offset < length && response_code === true)
    {
        let cmd = cmdline[offset++].toUpperCase();
        if(offset < length && cmd === "&")
        {
            cmd += cmdline[offset++].toUpperCase();
        }
        if(!(cmd in AT_COMMANDS))
        {
            dbg_log(`error: unknown command "${cmd}"`, LOG_MODEM);
            response_code = AT_RESP_ERROR;
            break;
        }
        const cmd_spec = AT_COMMANDS[cmd];

        let arg;
        if(cmd_spec !== "custom")
        {
            arg = this.cli_decode_arg(cmd_spec, decode_uint());
            if(arg === false)
            {
                dbg_log(`error: bad argument for command "${cmd}"`, LOG_MODEM);
                response_code = AT_RESP_ERROR;
                break;
            }
        }

        if(DEBUG)
        {
            if(arg !== undefined)
            {
                dbg_log(`AT command: "${cmd}${arg}"`, LOG_MODEM);
            }
            else
            {
                dbg_log(`AT command: "${cmd}"`, LOG_MODEM);
            }
        }

        switch(cmd)
        {
            case "D":   // D[T|P](.*)[;]: Dial
                if(this.socket)
                {
                    response_code = AT_RESP_ERROR;
                }
                else
                {
                    this.cli_exec_dial(cmdline, offset);
                    response_code = false; // exit parser without response (delayed in dial command)
                }
                break;
            case "E":   // E[0..1]: Command echo
                this.do_echo = arg === 1;
                break;
            case "H":   // H[0]: Hook control
                if(this.socket)
                {
                    this.socket.close();
                    response_code = false; // exit parser without response (delayed in "close" socket event)
                }
                else
                {
                    response_code = AT_RESP_ERROR;
                }
                break;
            case "I":   // I3: Request identification information
                this.cli_write_info_text("V86 Modem Emulation");
                break;
            case "L":   // L[0..3]: Monitor speaker loudness
                break;
            case "M":   // M[0..3]: Monitor speaker mode
                break;
            case "O":   // O: Switch to online data mode
                if(this.socket)
                {
                    this.enter_data_mode();
                    response_code = AT_RESP_CONNECT;
                }
                else
                {
                    response_code = AT_RESP_ERROR;
                }
                break;
            case "P":   // P: Select pulse dialling
                this.use_tone_dialling = false;
                break;
            case "Q":   // Q[0..1]: Result code suppression
                this.resp_suppress = arg === 1;
                break;
            case "S":   // S(0..5) [?|=<n>]: Read or write register S<n>
                if(offset < length && cmdline[offset] === "?")
                {
                    offset++;
                    this.cli_write_info_text(this.sreg[arg].toString().padStart(3, "0"));
                }
                else if(offset < length && cmdline[offset] === "=")
                {
                    offset++;
                    const val = decode_uint();
                    if(val !== undefined && val < 256)
                    {
                        this.sreg[arg] = val;
                    }
                    else
                    {
                        response_code = AT_RESP_ERROR;
                    }
                }
                else
                {
                    response_code = AT_RESP_ERROR;
                }
                break;
            case "T":   // T: Select tone dialling
                this.use_tone_dialling = true;
                break;
            case "V":   // V[0..1]: DCE response format
                this.resp_verbose = arg === 1;
                break;
            case "X":   // X[0..4]: Result code selection
                break;
            case "Z":   // Z[0]: Reset to default configuration
            case "&F":  // &F[0]: Set to factory-defined configuration (same as Z, but continue command line evaluation)
                if(this.socket)
                {
                    this.reset_on_disconnect = true;
                    this.socket.close();
                    response_code = false; // exit parser without response (delayed in "close" socket event)
                }
                else
                {
                    this.reset();
                }
                break;
            case "&C":  // &C[0..1]: Received line signal (DCD) detector behaviour
                this.dcd_always_on = arg === 0;
                if(this.dcd_always_on)
                {
                    this.uart_set_dcd(true);
                }
                else
                {
                    this.uart_set_dcd(this.socket !== null);
                }
                break;
            case "&D":  // &D(0..2): Data terminal ready (DTR) behaviour
                this.dtr_low_behaviour = arg;
                break;
            case "&K":  // &K[0..6]: Flow Control
                if(arg === 0 || arg === 3)
                {
                    this.use_rtscts_flowctrl = arg === 3;
                }
                else
                {
                    response_code = AT_RESP_ERROR;
                }
                break;
            default:
                dbg_log(`error: command "${cmd}" is without implementation`, LOG_MODEM);
                response_code = AT_RESP_ERROR;
                break;
        }
    }

    if(response_code === true)
    {
        this.cli_write_response_code(AT_RESP_OK);
    }
    else if(typeof(response_code) === "number")
    {
        this.cli_write_response_code(response_code);
    }
};

/**
 * @param {string} text
 */
Modem.prototype.cli_write_info_text = function(text)
{
    dbg_log(`AT info response: "${text}"`, LOG_MODEM);
    if(this.resp_verbose)
    {
        this.uart_write_byte(this.sreg[SREG_CR]);
        this.uart_write_byte(this.sreg[SREG_LF]);
    }
    this.uart_write(text);
    this.uart_write_byte(this.sreg[SREG_CR]);
    this.uart_write_byte(this.sreg[SREG_LF]);
};

/**
 * @param {number} code
 */
Modem.prototype.cli_write_response_code = function(code)
{
    if(!this.resp_suppress)
    {
        const text = AT_RESP_NAME[code in AT_RESP_NAME ? code : AT_RESP_ERROR];
        if(this.resp_verbose)
        {
            dbg_log(`AT response: "${text}"`, LOG_MODEM);
            this.uart_write_byte(this.sreg[SREG_CR]);
            this.uart_write_byte(this.sreg[SREG_LF]);
            this.uart_write(text);
            this.uart_write_byte(this.sreg[SREG_CR]);
            this.uart_write_byte(this.sreg[SREG_LF]);
        }
        else
        {
            dbg_log(`AT response code: "${code} (${text})"`, LOG_MODEM);
            this.uart_write(code.toString());
            this.uart_write_byte(this.sreg[SREG_CR]);
        }
    }
};
