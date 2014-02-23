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
        enable_keyboard_stream = false,

        /** @type {boolean} */
        next_is_mouse_command = false,

        /** @type {boolean} */
        next_read_sample = false,

        /** @type {boolean} */
        next_read_led = false,

        /** @type {boolean} */
        next_handle_scan_code_set = false,

        /** @type {boolean} */
        next_read_rate = false,

        /** @type {boolean} */
        next_read_resolution = false,

        /** 
         * @type {ByteQueue} 
         */
        kbd_buffer = new ByteQueue(32),

        /** @type {number} */
        sample_rate = 100,

        /** @type {number} */
        resolution = 4,

        /** @type {boolean} */
        scaling2 = false,

        /** @type {number} */
        last_mouse_packet = -1,

        /** 
         * @type {ByteQueue} 
         */
        mouse_buffer = new ByteQueue(32);


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
        if(enable_keyboard_stream)
        {
            kbd_buffer.push(code);
            kbd_irq();
        }
    }
    this.kbd_send_code = kbd_send_code;

    function mouse_send_delta(delta_x, delta_y)
    {
        if(!have_mouse || !enable_mouse)
        {
            return;
        }

        // note: delta_x or delta_y can be floating point numbers

        mouse_delta_x += delta_x * resolution;
        mouse_delta_y += delta_y * resolution;

        if(enable_mouse_stream)
        {
            var change_x = Math.ceil(mouse_delta_x),
                change_y = Math.ceil(mouse_delta_y);

            if(change_x || change_y)
            {
                var now = Date.now();

                if(now - last_mouse_packet < 1000 / sample_rate)
                {
                    // TODO: set timeout
                    return;
                }

                mouse_delta_x -= change_x;
                mouse_delta_y -= change_y;

                send_mouse_packet(change_x, change_y);
            }
        }
    }

    function mouse_send_click(left, middle, right)
    {
        if(!have_mouse || !enable_mouse)
        {
            return;
        }

        mouse_clicks = left | right << 1 | middle << 2;

        if(enable_mouse_stream)
        {
            send_mouse_packet(0, 0);
        }
    }

    function send_mouse_packet(dx, dy)
    {
        var info_byte = 
                (dy < 0) << 5 |
                (dx < 0) << 4 |
                1 << 3 | 
                mouse_clicks,
            delta_x = dx,
            delta_y = dy;

        last_mouse_packet = Date.now();

        if(scaling2)
        {
            // only in automatic packets, not 0xEB requests
            delta_x = apply_scaling2(delta_x);
            delta_y = apply_scaling2(delta_y);
        }

        mouse_buffer.push(info_byte);
        mouse_buffer.push(delta_x);
        mouse_buffer.push(delta_y);

        dbg_log("adding mouse packets:" + [info_byte, dx, dy], LOG_PS2);

        mouse_irq();
    }

    function apply_scaling2(n)
    {
        // http://www.computer-engineering.org/ps2mouse/#Inputs.2C_Resolution.2C_and_Scaling
        var abs = Math.abs(n),
            sign = n >> 31;

        switch(abs)
        {
            case 0:
            case 1:
            case 3:
                return n;
            case 2:
                return sign;
            case 4: 
                return 6 * sign;
            case 5:
                return 9 * sign;
            default:
                return n << 1;
        }
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
            //do_mouse_buffer = false;
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
            kbd_irq();
            command_register = write_byte;
            read_command_register = false;
            kbd_buffer.push(0xFA);

            dbg_log("Keyboard command register = " + h(command_register), LOG_PS2);
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
                resolution = 4;
                dbg_log("invalid resolution, resetting to 4", LOG_PS2);
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
        else if(next_handle_scan_code_set)
        {
            next_handle_scan_code_set = false;

            kbd_buffer.push(0xFA);
            kbd_irq();

            if(write_byte)
            {
                // set scan code set
            }
            else
            {
                kbd_buffer.push(2);
            }
        }
        else if(next_read_rate)
        {
            // nope
            next_read_rate = false;
            kbd_buffer.push(0xFA);
            kbd_irq();
        }
        else if(next_is_mouse_command)
        {
            next_is_mouse_command = false;
            dbg_log("Port 60 data register write: " + h(write_byte), LOG_PS2); 

            if(!have_mouse)
            {
                return;
            }

            // send ack
            mouse_buffer.clear();
            mouse_buffer.push(0xFA);

            switch(write_byte)
            {
            case 0xE6:
                // set scaling to 1:1
                dbg_log("Scaling 1:1", LOG_PS2);
                scaling2 = false;
                break;
            case 0xE7:
                // set scaling to 2:1
                dbg_log("Scaling 2:1", LOG_PS2);
                scaling2 = true;
                break;
            case 0xE8:
                // set mouse resolution
                next_read_resolution = true;
                break;
            case 0xE9:
                // status request - send one packet
                send_mouse_packet(0, 0);
                break;
            case 0xEB:
                // request single packet
                dbg_log("unimplemented request single packet", LOG_PS2);
                break;
            case 0xF2:
                //  MouseID Byte
                mouse_buffer.push(0);
                mouse_buffer.push(0);
                break;
            case 0xF3:
                // sample rate
                next_read_sample = true;
                break;
            case 0xF4:
                // enable streaming
                enable_mouse_stream = true;
                enable_mouse = true;
                mouse.enabled = true;
                break;
            case 0xF5:
                // disable streaming
                enable_mouse_stream = false;
                break;
            case 0xF6:
                // reset defaults 
                enable_mouse_stream = false;
                sample_rate = 100;
                scaling2 = false;
                resolution = 4;
                break;
            case 0xFF:
                // reset, send completion code
                mouse_buffer.push(0xAA);
                mouse_buffer.push(0);

                enable_mouse = true;
                mouse.enabled = true;
                break;

            default:
                dbg_log("Unimplemented mouse command: " + h(write_byte), LOG_PS2);
            }

            mouse_irq();
        }
        else 
        {
            dbg_log("Port 60 data register write: " + h(write_byte), LOG_PS2); 

            // send ack
            kbd_buffer.push(0xFA);

            switch(write_byte)
            {
            case 0xED:
                next_read_led = true;
                break;
            case 0xF0:
                // get/set scan code set
                next_handle_scan_code_set = true;
                break;
            case 0xF2:
                // identify
                kbd_buffer.push(0xAB);
                kbd_buffer.push(83);
                break;
            case 0xF3:
                //  Set typematic rate and delay 
                next_read_rate = true;
                break;
            case 0xF4:
                // enable scanning
                dbg_log("kbd enable scanning", LOG_PS2);
                enable_keyboard_stream = true;
                break;
            case 0xF5:
                // disable scanning
                dbg_log("kbd disable scanning", LOG_PS2);
                enable_keyboard_stream = false;
                break;
            case 0xF6:
                // reset defaults
                //enable_keyboard_stream = false;
                break;
            case 0xFF:
                kbd_buffer.clear();
                kbd_buffer.push(0xFA);
                kbd_buffer.push(0xAA);
                break;
            default:
                dbg_log("Unimplemented keyboard command: " + h(write_byte), LOG_PS2);
            }
            
            kbd_irq();
        }
    };

    function port64_write(write_byte)
    {
        dbg_log("port 64 write: " + h(write_byte), LOG_PS2);

        switch(write_byte)
        {
        case 0x20:
            kbd_buffer.clear();
            mouse_buffer.clear();
            kbd_buffer.push(command_register);
            break;
        case 0x60:
            read_command_register = true;
            break;
        case 0xD3:
            read_output_register = true;
            break;
        case 0xD4:
            next_is_mouse_command = true;
            break;
        case 0xA7:
            // Disable second port
            dbg_log("Disable second port", LOG_PS2);
            command_register |= 0x20;
            break;
        case 0xA8:
            // Enable second port
            dbg_log("Enable second port", LOG_PS2);
            command_register &= ~0x20;
            break;
        case 0xA9:
            // test second ps/2 port
            kbd_buffer.clear();
            mouse_buffer.clear();
            kbd_buffer.push(0);
            break;
        case 0xAA:
            kbd_buffer.clear();
            mouse_buffer.clear();
            kbd_buffer.push(0x55);
            break;
        case 0xAB:
            // Test first PS/2 port 
            kbd_buffer.clear();
            mouse_buffer.clear();
            kbd_buffer.push(0);
            break;
        case 0xAD:
            // Disable Keyboard
            dbg_log("Disable Keyboard", LOG_PS2);
            command_register |= 0x10;
            break;
        case 0xAE:
            // Enable Keyboard
            dbg_log("Enable Keyboard", LOG_PS2);
            command_register &= ~0x10;
            break;
        case 0xFE:
            dbg_log("CPU reboot via PS2");
            dev.reboot();
            break;
        default:
            dbg_log("port 64: Unimplemented command byte: " + h(write_byte), LOG_PS2);
        }
    };
}



