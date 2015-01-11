# V86Starter
- [`run()`](#run)
- [`stop()`](#stop)
- [`restart()`](#restart)
- [`add_listener(string event, function(*) listener)`](#add_listenerstring-event-function-listener)
- [`remove_listener(string event, function(*) listener)`](#remove_listenerstring-event-function-listener)
- [`restore_state(ArrayBuffer state)`](#restore_statearraybuffer-state)
- [`save_state(function(Object, ArrayBuffer) callback)`](#save_statefunctionobject-arraybuffer-callback)
- [`get_statistics() -> Object`](#get_statistics---object)
- [`is_running() -> boolean`](#is_running---boolean)
- [`keyboard_send_scancodes(Array.<number> codes)`](#keyboard_send_scancodesarraynumber-codes)
- [`mouse_set_status(boolean enabled)`](#mouse_set_statusboolean-enabled)
- [`keyboard_set_status(boolean enabled)`](#keyboard_set_statusboolean-enabled)
- [`serial0_send(string data)`](#serial0_sendstring-data)

***
## `V86Starter`
Constructor for emulator instances.

Usage: `var emulator = new V86Starter(options);`

Options can have the following properties (all optional, default in parenthesis):

- `memory_size number` (16 * 1024 * 1024) - The memory size in bytes, should
  be a power of 2.
- `vga_memory_size number` (8 * 1024 * 1024) - VGA memory size in bytes.
- `autostart boolean` (false) - If emulation should be started when emulator
  is ready.
- `disable_keyboard boolean` (false) - If the keyboard should be disabled.
- `disable_mouse boolean` (false) - If the mouse should be disabled.
- `network_relay_url string` (No network card) - The url of a server running
  websockproxy. See
  https://github.com/copy/v86/blob/master/docs/networking.md.
- `bios Object` (No bios) - Either a url pointing to a bios or an
  ArrayBuffer, see below.
- `vga_bios Object` (No VGA bios) - VGA bios, see below.
- `hda Object` (No hard drive) - First hard disk, see below.
- `fda Object` (No floppy disk) - First floppy disk, see below.
- `cdrom Object` (No cd drive) - CD disk, see below.
- `initial_state Object` (Normal boot) - An initial state to load, see
  [`restore_state`](#restore_statearraybuffer-state) and below.
- `serial_container HTMLTextAreaElement` (No serial terminal) - A textarea
  that will receive and send data to the emulated serial terminal.
  Alternatively the serial terminal can also be accessed programatically,
  see https://github.com/copy/v86/blob/master/docs/samples/serial.html.
- `screen_container HTMLElement` (No screen) - An HTMLElement. This should
  have a certain structure, see
  https://github.com/copy/v86/blob/master/docs/samples/basic.html.

There are two ways to load images (`bios`, `vga_bios`, `cdrom`, `hda`, ...):

- Pass an object that has a url: `options.bios = { url:
  "http://copy.sh/v86/bios/seabios.bin" }`. Optionally, `async: true` can be
  added to the object, so that sectors of the image are loaded on demand
  instead of being loaded before boot (slower, but strongly recommended for
  big files).
- Pass an `ArrayBuffer` or `File` object, for instance `options.hda = {
  buffer: new ArrayBuffer(512 * 1024) }` to add an empty hard drive.

**Parameters:**

1. **`Object`** options – Options to initialize the emulator with.

***
#### `run()`
Start emulation. Do nothing if emulator is running already. Can be
asynchronous.

***
#### `stop()`
Stop emulation. Do nothing if emulator is not running. Can be asynchronous.

***
#### `restart()`
Restart (force a reboot).

***
#### `add_listener(string event, function(*) listener)`
Add an event listener (the emulator is an event emitter). A list of events
can be found at https://github.com/copy/v86/blob/master/docs/events.md.

The callback function gets a single argument which depends on the event.

**Parameters:**

1. **`string`** event – Name of the event.
2. **`function(*)`** listener – The callback function.

***
#### `remove_listener(string event, function(*) listener)`
Remove an event listener. 

**Parameters:**

1. **`string`** event 
2. **`function(*)`** listener 

***
#### `restore_state(ArrayBuffer state)`
Restore the emulator state from the given state, which must be an
ArrayBuffer returned by
[`save_state`](#save_statefunctionobject-arraybuffer-callback). 

Note that the state can only be restored correctly if this constructor has
been created with the same options as the original instance (e.g., same disk
images, memory size, etc.). 

Different versions of the emulator might use a different format for the
state buffer.

**Parameters:**

1. **`ArrayBuffer`** state 

***
#### `save_state(function(Object, ArrayBuffer) callback)`
Asynchronously save the current state of the emulator. The first argument to
the callback is an Error object if something went wrong and is null
otherwise.

**Parameters:**

1. **`function(Object, ArrayBuffer)`** callback 

***
#### `get_statistics() -> Object`
Return an object with several statistics. Return value looks similar to
(but can be subject to change in future versions or different
configurations, so use defensively):

```
{
    "cpu": {
        "instruction_counter": 2821610069
    },
    "hda": {
        "sectors_read": 95240,
        "sectors_written": 952,
        "bytes_read": 48762880,
        "bytes_written": 487424,
        "loading": false
    },
    "cdrom": {
        "sectors_read": 0,
        "sectors_written": 0,
        "bytes_read": 0,
        "bytes_written": 0,
        "loading": false
    },
    "mouse": {
        "enabled": true
    },
    "vga": {
        "is_graphical": true,
        "res_x": 800,
        "res_y": 600,
        "bpp": 32
    }
}
```

**Returns:**

* **`Object`** 

***
#### `is_running() -> boolean`

**Returns:**

* **`boolean`** 

***
#### `keyboard_send_scancodes(Array.<number> codes)`
Send a sequence of scan codes to the emulated PS2 controller. A list of
codes can be found at http://stanislavs.org/helppc/make_codes.html.
Do nothing if there is not keyboard controller.

**Parameters:**

1. **`Array.<number>`** codes 

***
#### `mouse_set_status(boolean enabled)`
Enable or disable sending mouse events to the emulated PS2 controller.

**Parameters:**

1. **`boolean`** enabled 

***
#### `keyboard_set_status(boolean enabled)`
Enable or disable sending keyboard events to the emulated PS2 controller.

**Parameters:**

1. **`boolean`** enabled 

***
#### `serial0_send(string data)`
Send a string to the first emulated serial terminal.

**Parameters:**

1. **`string`** data 

<!-- src/browser/starter.js-->

<!--  vim: set tabstop=2 shiftwidth=2 softtabstop=2: -->
