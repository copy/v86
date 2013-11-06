

Adapters are used to communicate between virtual hardware and the browser (or
nodejs, or anything else). Currently, there are 3 adapters: Keyboard, Mouse and
Screen. Adapters are passed through `settings.keyboard_adapter`,
`settings.mouse_adapter` and `settings.screen_adapter` respectively, but they
can also be undefined. 

Here is a list of functions that must be implemented by adapters:

**ScreenAdapter:**

- `put_pixel(x, y, color)`
- `put_pixel_linear(offset, color_part)`
- `put_char(row, col, chr, bg_color, fg_color)`
- `update_cursor(row, col)`
- `update_cursor_scanline(start, end)`
- `clear_screen()`
- `timer_graphical()`
- `timer_text()`
- `set_mode(is_graphical)`
- `set_size_graphical(width, height)`
- `set_size_text(rows, cols)`
- `destroy()`

**KeyboardAdapter:**

- `init(send_code_fn)`
- `destroy()`
- `enabled`

**MouseAdapter:**

- `init(click_fn, move_fn, wheel_fn)`
- `destroy()`
- `enabled`

**More**

In addition to adapters, the following functions must be provided in global
scope (TODO: Improve that).

- `next_tick()`
- `set_tick(fn)`
- `log(str)` - only in debug modes


<br>
Everything on this page may be subject to change.
