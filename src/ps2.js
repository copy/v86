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

        /** 
         * @type {Array.<number>} 
         */
        kbd_buffer = [],

        /** @type {number} */
        sample_rate = 100,

        /** @type {number} */
        last_mouse_packet = -1,

        /** 
         * @type {Array.<number>} 
         */
        mouse_buffer = [];


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


    function mouse_irq()
    {
        pic.push_irq(12);
    }

    function kbd_irq()
    {
        pic.push_irq(1);
    }


    function kbd_send_code(code)
    {
        //console.log(h(code));
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
        var info_byte = 
                (mouse_delta_y < 0) << 5 |
                (mouse_delta_x < 0) << 4 |
                1 << 3 | 
                mouse_clicks;

        mouse_buffer.push(
            info_byte, 
            mouse_delta_x & 0xFF,
            mouse_delta_y & 0xFF
        );

        if(mouse_buffer.length > 15)
        {
            var off = mouse_buffer.length % 3;
            mouse_buffer = mouse_buffer.slice(0, off).concat(mouse_buffer.slice(off + 3));
        }

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
        

    var command_register = 0,
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
            dbg_log("Port 60 read (mouse): " + h(mouse_buffer[0]), LOG_PS2);

            if(mouse_buffer.length > 1)
            {
                mouse_irq();
            }

            return mouse_buffer.shift();
        }
        else
        {
            dbg_log("Port 60 read (kbd)  : " + h(kbd_buffer[0]), LOG_PS2);

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
        //dbg_log("port 64 read", LOG_PS2);

        var status_byte = 0x10;

        if(mouse_buffer.length || kbd_buffer.length)
        {
            status_byte |= 1;
        }
        if(mouse_buffer.length)
        {
            status_byte |= 0x20;
        }

        return status_byte;
    };

    function port60_write(write_byte)
    {
        if(read_command_register)
        {
            command_register = write_byte;
            read_command_register = false;

            dbg_log("Keyboard command register = " + h(command_register), LOG_PS2);
        }
        else if(read_output_register)
        {
            read_output_register = false;
            mouse_buffer = [write_byte];
            mouse_irq();
        }
        else if(next_read_sample)
        {
            next_read_sample = false;
            mouse_buffer = [0xFA];

            sample_rate = write_byte;
            mouse_irq();
        }
        else if(next_read_led)
        {
            // nope
            next_read_led = false;
        }
        else if(next_is_mouse_command)
        {
            dbg_log("Port 60 data register write: " + h(write_byte), LOG_PS2); 

            if(!have_mouse)
            {
                return;
            }

            // send ack
            mouse_buffer = [0xFA];

            if(write_byte === 0xFF)
            {
                // reset, send completion code
                mouse_buffer.push(0xAA, 0x00);

                enable_mouse = true;
                mouse.enabled = true;
            }
            else if(write_byte === 0xF2)
            {
                //  MouseID Byte
                mouse_buffer.push(0, 0);
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
            else if(write_byte === 0xEB)
            {
                // request single packet
                dbg_log("unimplemented request single packet");
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
                kbd_buffer.push(0xAA, 0x00);
            }
            else if(write_byte === 0xF2)
            {
                // identify
                kbd_buffer.push(0xAB, 83);
            }
            else if(write_byte === 0xF4)
            {
                // enable scanning
            }
            else if(write_byte === 0xF5)
            {
                // disable scanning
            }
            else if(write_byte === 0xED)
            {
                next_read_led = true;
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
            kbd_irq();
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
            kbd_buffer = [0];
            kbd_irq();
        }
        else if(write_byte === 0xAA)
        {
            kbd_buffer = [0x55];
            kbd_irq();
        }
        else if(write_byte === 0xAB)
        {
            kbd_buffer = [0];
            kbd_irq();
        }
        /*else if(write_byte === 0xAE)
        {
            // not sure if right ...
            kbd_buffer =[];
        }*/
        else
        {
            dbg_log("port 64: New command byte: " + h(write_byte), LOG_PS2);
        }
    };
}



