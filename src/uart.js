/** 
 * No full implementation, just dumping serial output
 * to console
 *
 * @constructor 
 */
function UART(dev)
{
    var 
        io = dev.io,
        line = "";

    io.register_write(0x3F8, function(out_byte) 
    {
        if(out_byte === 0x0A)
        {
            log(line);
            dbg_log(line, LOG_SERIAL);
            line = "";
        }
        else
        {
            line += String.fromCharCode(out_byte);
        }
    });
}
