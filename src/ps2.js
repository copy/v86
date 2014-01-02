"use strict";

/**
 * @constructor
 */
function PS2(dev, keyboard, mouse)
{
    var 
        io = dev.io,
        pic = dev.pic,

        me = this,

        /** @type {boolean} */
        enable_mouse_stream = false,
        /** @type {boolean} */
        enable_mouse = false,

        /** @type {boolean} */
        have_mouse = false,

        /** @type {number} */
        mouse_delta_x = 0,
        /** @type {number} */
        mouse_delta_y = 0,
        /** @type {number} */
        mouse_clicks = 0,

        /** @type {boolean} */
        have_keyboard = false,

        /** @type {boolean} */
        next_is_mouse_command = false,

        /** @type {boolean} */
        next_read_sample = false,

        /** @type {boolean} */
        next_read_led = false,

        next_read_resolution = false,

        /** 
         * @type {Queue} 
         */
        kbd_buffer = new Queue(32),

        /** @type {number} */
        sample_rate = 100,

        /** @type {number} */
        resolution = 1,

        /** @type {number} */
        last_mouse_packet = -1,

        /** 
         * @type {Queue} 
         */
        mouse_buffer = new Queue(32);


    if(keyboard)
    {
        have_keyboard = true;
        keyboard.init(kbd_send_code);
    }

    if(mouse)
    {
        have_mouse = true;
        mouse.init(mouse_send_click, mouse_send_delta);

        // TODO: Mouse Wheel
        // http://www.computer-engineering.org/ps2mouse/
    }

    /** @constructor */
    function Queue(size)
    {
        var data = new Uint8Array(size),
            start,
            end;

        dbg_assert((size & size - 1) === 0);

        this.length = 0;

        this.push = function(item)
        {
            if(this.length === size)
            {
                dbg_log("Queue full", LOG_PS2);
            }
            else
            {
                this.length++;
            }

            data[end] = item;
            end = end + 1 & size - 1;
        };

        this.shift = function()
        {
            if(!this.length)
            {
                dbg_log("Queue empty", LOG_PS2);
                return 0;
            }
            else
            {
                var item = data[start];

                start = start + 1 & size - 1
                this.length--;

                return item;
            }
        };

        this.peek = function()
        {
            if(!this.length)
            {
                dbg_log("Queue empty", LOG_PS2);
                return 0;
            }
            else
            {
                return data[start];
            }
        };

        this.clear = function()
        {
            start = 0;
            end = 0;
            this.length = 0;
        };

        this.clear();
    }


    function mouse_irq()
    {
        if(command_register & 2)
        {
            pic.push_irq(12);
        }
    }

    function kbd_irq()
    {
        if(command_register & 1)
        {
            pic.push_irq(1);
        }
    }

    function kbd_send_code(code)
    {
        kbd_buffer.push(code);
        kbd_irq();
    }
    this.kbd_send_code = kbd_send_code;

    function mouse_send_delta(delta_x, delta_y)
    {
        if(have_mouse && enable_mouse)
        {
            mouse_delta_x += delta_x;
            mouse_delta_y += delta_y;

            if(enable_mouse_stream)
            {
                var now = Date.now();

                if(now - last_mouse_packet < 1000 / sample_rate)
                {
                    // TODO: set timeout
                    return;
                }

                last_mouse_packet = now;

                send_mouse_packet();
            }
        }
    }

    function mouse_send_click(left, middle, right)
    {
        if(have_mouse && enable_mouse)
        {
            mouse_clicks = left | right << 1 | middle << 2;

            if(enable_mouse_stream)
            {
                send_mouse_packet();
            }
        }
    }

    function send_mouse_packet()
    {
        if(!mouse_delta_x && !mouse_delta_y && !mouse_clicks)
        {
            // Move along, nothing to see here
            return;
        }

        var info_byte = 
                (mouse_delta_y < 0) << 5 |
                (mouse_delta_x < 0) << 4 |
                1 << 3 | 
                mouse_clicks;

        mouse_buffer.push(info_byte);
        mouse_buffer.push(mouse_delta_x);
        mouse_buffer.push(mouse_delta_y);

        dbg_log("adding mouse packets:" + [info_byte, mouse_delta_x, mouse_delta_y], LOG_PS2);

        mouse_delta_x = 0;
        mouse_delta_y = 0;

        mouse_irq();
    }

    this.destroy = function()
    {
        if(have_keyboard)
        {
            keyboard.destroy();
        }

        if(have_mouse)
        {
            mouse.destroy();
        }
    };
        

    var command_register = 1 | 4,
        read_output_register = false,
        read_command_register = false;


    io.register_read(0x60, port60_read);
    io.register_read(0x64, port64_read);

    io.register_write(0x60, port60_write);
    io.register_write(0x64, port64_write);

    function port60_read()
    {
        //log("port 60 read: " + (buffer[0] || "(none)"));

        if(!kbd_buffer.length && !mouse_buffer.length)
        {
            // should not happen
            dbg_log("Port 60 read: Empty", LOG_PS2);
            return 0xFF;
        }

        var do_mouse_buffer;

        if(kbd_buffer.length && mouse_buffer.length)
        {
            // tough decision, let's ask the PIC
            do_mouse_buffer = (pic.get_isr() & 2) === 0;
        }
        else if(kbd_buffer.length)
        {
            do_mouse_buffer = false;
        }
        else
        {
            do_mouse_buffer = true;
        }


        if(do_mouse_buffer)
        {
            dbg_log("Port 60 read (mouse): " + h(mouse_buffer.peek()), LOG_PS2);

            if(mouse_buffer.length > 1)
            {
                mouse_irq();
            }

            return mouse_buffer.shift();
        }
        else
        {
            dbg_log("Port 60 read (kbd)  : " + h(kbd_buffer.peek()), LOG_PS2);

            if(kbd_buffer.length > 1)
            {
                kbd_irq();
            }

            return kbd_buffer.shift();
        }
    };

    function port64_read()
    {
        // status port 

        var status_byte = 0x10;

        if(mouse_buffer.length || kbd_buffer.length)
        {
            status_byte |= 1;
        }
        if(mouse_buffer.length)
        {
            status_byte |= 0x20;
        }

        dbg_log("port 64 read: " + h(status_byte), LOG_PS2);

        return status_byte;
    };

    function port60_write(write_byte)
    {
        dbg_log("port 60 write: " + h(write_byte), LOG_PS2);
        
        if(read_command_register)
        {
            command_register = write_byte;
            read_command_register = false;
            kbd_buffer.push(0xFA);

            dbg_log("Keyboard command register = " + h(command_register), LOG_PS2);
            kbd_irq();
        }
        else if(read_output_register)
        {
            read_output_register = false;

            mouse_buffer.clear();
            mouse_buffer.push(write_byte);
            mouse_irq();
        }
        else if(next_read_sample)
        {
            next_read_sample = false;
            mouse_buffer.clear();
            mouse_buffer.push(0xFA);

            sample_rate = write_byte;
            dbg_log("mouse sample rate: " + h(write_byte), LOG_PS2);
            mouse_irq();
        }
        else if(next_read_resolution)
        {
            next_read_resolution = false;
            mouse_buffer.clear();
            mouse_buffer.push(0xFA);

            if(write_byte > 3)
            {
                dbg_log("invalid resolution, resetting to 1", LOG_PS2);
            }
            else
            {
                resolution = 1 << write_byte;
                dbg_log("resolution: " + resolution, LOG_PS2);
            }
            mouse_irq();
        }
        else if(next_read_led)
        {
            // nope
            next_read_led = false;
            kbd_buffer.push(0xFA);
            kbd_irq();
        }
        else if(next_is_mouse_command)
        {
            dbg_log("Port 60 data register write: " + h(write_byte), LOG_PS2); 

            if(!have_mouse)
            {
                return;
            }

            // send ack
            mouse_buffer.clear();
            mouse_buffer.push(0xFA);

            if(write_byte === 0xFF)
            {
                // reset, send completion code
                mouse_buffer.push(0xAA);
                mouse_buffer.push(0);

                enable_mouse = true;
                mouse.enabled = true;
            }
            else if(write_byte === 0xF2)
            {
                //  MouseID Byte
                mouse_buffer.push(0);
                mouse_buffer.push(0);
            }
            else if(write_byte === 0xF3)
            {
                // sample rate
                next_read_sample = true;
            }
            else if(write_byte === 0xF4)
            {
                // enable streaming

                enable_mouse_stream = true;
                enable_mouse = true;

                mouse.enabled = true;
            }
            else if(write_byte === 0xF5)
            {
                // disable streaming
                enable_mouse_stream = true;
            }
            else if(write_byte === 0xF6)
            {
                // reset defaults 
                enable_mouse_stream = false;
                sample_rate = 100;

                // ... resolution, scaling
            }
            else if(write_byte === 0xE8)
            {
                // set mouse resolution
                next_read_resolution = true;
            }
            else if(write_byte === 0xEB)
            {
                // request single packet
                dbg_log("unimplemented request single packet", LOG_PS2);
            }
            else 
            {
                dbg_log("new mouse command: " + h(write_byte), LOG_PS2);
            }

            mouse_irq();
        }
        else 
        {
            dbg_log("Port 60 data register write: " + h(write_byte), LOG_PS2); 

            // send ack
            kbd_buffer.push(0xFA);

            if(write_byte === 0xFF)
            {
                //kbd_buffer.push(0xAA, 0x00);
                kbd_buffer.clear();
                kbd_buffer.push(0xFA);
                kbd_buffer.push(0xAA);
            }
            else if(write_byte === 0xF2)
            {
                // identify
                kbd_buffer.push(0xAB);
                kbd_buffer.push(83);
            }
            else if(write_byte === 0xF4)
            {
                // enable scanning
                dbg_log("kbd enable scanning", LOG_PS2);
            }
            else if(write_byte === 0xF5)
            {
                // disable scanning
                dbg_log("kbd disable scanning", LOG_PS2);
            }
            else if(write_byte === 0xED)
            {
                next_read_led = true;
            }
            else 
            {
                dbg_log("new kbd command: " + h(write_byte), LOG_PS2);
            }
            
            kbd_irq();
        }
    };

    function port64_write(write_byte)
    {
        dbg_log("port 64 write: " + h(write_byte), LOG_PS2);

        if(write_byte === 0xFE)
        {
            dbg_log("CPU reboot via PS2");
            dev.reboot();
        }
        else if(write_byte === 0x20)
        {
            kbd_buffer.push(command_register);
        }
        else if(write_byte === 0x60)
        {
            read_command_register = true;
        }
        else if(write_byte === 0xD3)
        {
            read_output_register = true;
        }
        else if(write_byte === 0xD4)
        {
            next_is_mouse_command = true;
        }
        else if(write_byte === 0xA9)
        {
            // test second ps/2 port
            kbd_buffer.clear();
            kbd_buffer.push(0);
        }
        else if(write_byte === 0xAA)
        {
            kbd_buffer.clear();
            kbd_buffer.push(0x55);
        }
        else if(write_byte === 0xAB)
        {
            // Test first PS/2 port 
            kbd_buffer.clear();
            kbd_buffer.push(0);
        }
        else if(write_byte === 0xAE)
        {
            // Enable Keyboard
            dbg_log("Enable Keyboard", LOG_PS2);
        }
        else if(write_byte === 0xA7)
        {
            // Disable second port
            dbg_log("Disable second port", LOG_PS2);
        }
        else
        {
            dbg_log("port 64: New command byte: " + h(write_byte), LOG_PS2);
        }
    };
}



