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
- [`create_file(string file, Uint8Array data, function(Object) callback)`](#create_filestring-file-uint8array-data-functionobject-callback)
- [`read_file(string file, function(Object, Uint8Array) callback)`](#read_filestring-file-functionobject-uint8array-callback)

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
  websockproxy. See [networking.md](networking.md). Setting this will
  enable an emulated network card.

- `bios Object` (No bios) - Either a url pointing to a bios or an
  ArrayBuffer, see below.
- `vga_bios Object` (No VGA bios) - VGA bios, see below.
- `hda Object` (No hard drive) - First hard disk, see below.
- `fda Object` (No floppy disk) - First floppy disk, see below.
- `cdrom Object` (No CD) - See below.
- `initial_state Object` (Normal boot) - An initial state to load, see
  [`restore_state`](#restore_statearraybuffer-state) and below.

- `filesystem Object` (No 9p filesystem) - A 9p filesystem, see
  [filesystem.md](filesystem.md).

- `serial_container HTMLTextAreaElement` (No serial terminal) - A textarea
  that will receive and send data to the emulated serial terminal.
  Alternatively the serial terminal can also be accessed programatically,
  see [serial.html](../examples/serial.html).

- `screen_container HTMLElement` (No screen) - An HTMLElement. This should
  have a certain structure, see [basic.html](../examples/basic.html).

***

There are two ways to load images (`bios`, `vga_bios`, `cdrom`, `hda`, ...):

- Pass an object that has a url. Optionally, `async: true` and `size:
  size_in_bytes` can be added to the object, so that sectors of the image
  are loaded on demand instead of being loaded before boot (slower, but
  strongly recommended for big files). In that case, the `Range: bytes=...`
  header must be supported on the server. Note: the python SimpleHTTPServer 
  does not support this, so it won't work with the default webserver used
  by `make run`.

  ```javascript
  // download file before boot
  bios: { 
      url: "bios/seabios.bin" 
  }
  // download file sectors as requested, size is required
  hda: { 
      url: "disk/linux.iso",
      async: true,
      size: 16 * 1024 * 1024 
  }
  ```

- Pass an `ArrayBuffer` or `File` object as `buffer` property.

  ```javascript
  // use <input type=file>
  bios: { 
      buffer: document.all.hd_image.files[0]
  }
  // start with empty hard drive
  hda: { 
      buffer: new ArrayBuffer(16 * 1024 * 1024)
  }
  ```

***

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
can be found at [events.md](events.md).

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

**Deprecated - Might be removed in a later release.**

Return an object with several statistics. Return value looks similar to
(but can be subject to change in future versions or different
configurations, so use defensively):

```javascript
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
Do nothing if there is no keyboard controller.

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

***
#### `create_file(string file, Uint8Array data, function(Object) callback)`
Write to a file in the 9p filesystem. Nothing happens if no filesystem has
been initialized. First argument to the callback is an error object if
something went wrong and null otherwise.

**Parameters:**

1. **`string`** file 
2. **`Uint8Array`** data 
3. **`function(Object)`** (optional) callback 

***
#### `read_file(string file, function(Object, Uint8Array) callback)`
Read a file in the 9p filesystem. Nothing happens if no filesystem has been
initialized.

**Parameters:**

1. **`string`** file 
2. **`function(Object, Uint8Array)`** callback 

<!-- ../src/browser/starter.js-->

<!--  vim: set tabstop=2 shiftwidth=2 softtabstop=2: -->
