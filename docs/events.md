Here is a list of events that can be listened to using
[`add_listener`](api.md#add_listenerstring-event-function-listener). These
can be used to programmatically control the emulator. Events cannot be sent to
the emulator (although it is internally implemented that way), use the
[API](api.md) methods for that.

### Serial terminal

See also: [serial.js](../src/browser/serial.js).

- `serial0-output-char` - `string chr`

### Network

See also: [network.js](../src/browser/network.js).

- `net0-receive` - `Uint8Array buffer`

### Screen

See also: [screen.js](../src/browser/screen.js).

- `screen-set-mode` - `boolean is_graphic`
- `screen-put-char` - `[number row, number col, number chr, number bg_color, number fg_color]`
- `screen-put-pixel-linear` - `[number addr, number value]`
- `screen-put-pixel-linear32` - `[number addr, number value]`
- `screen-set-size-text` - `[number cols_count, number rows_count]`
- `screen-set-size-graphical` - `[number width, number height, number virtual_width, number virtual_height, number bpp]`
- `screen-update-cursor` - `[number row, number col]`
- `screen-update-cursor-scanline` - `[number cursor_scanline_start, number cursor_scanline_end]`


