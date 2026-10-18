// A minimal ADB client (docs/arm64-virt-android16-plan.md P10.7): the
// transport protocol of system/adb/protocol.txt over any byte stream with
// write(bytes) and an on_data callback (a TCP socket to QEMU's forwarded
// port, or a connection through v86's network adapter to the guest's
// 5555). Without authentication: the guest's adbd runs with ro.adb.secure=0
// (the debug vendor ramdisk, tools/a64_android.mjs). Version 0x01000001, so
// neither side checks the data checksum; no features (no delayed acks).
//
//   const adb = new AdbClient(stream); await adb.connect();
//   const output = await adb.shell("getprop sys.boot_completed");

const A_CNXN = 0x4e584e43, A_OPEN = 0x4e45504f, A_OKAY = 0x59414b4f, A_CLSE = 0x45534c43, A_WRTE = 0x45545257, A_AUTH = 0x48545541;
const VERSION = 0x01000001;
const MAX_DATA = 256 * 1024;

function message(command, arg0, arg1, data = Buffer.alloc(0))
{
    const header = Buffer.alloc(24);
    header.writeUInt32LE(command, 0);
    header.writeUInt32LE(arg0 >>> 0, 4);
    header.writeUInt32LE(arg1 >>> 0, 8);
    header.writeUInt32LE(data.length, 12);
    header.writeUInt32LE(data.reduce((sum, byte) => sum + byte, 0) >>> 0, 16);
    header.writeUInt32LE((command ^ 0xFFFFFFFF) >>> 0, 20);
    return Buffer.concat([header, data]);
}

export class AdbClient
{
    /** @param {{write: function(!Buffer), on_data: ?function(!Buffer), close?: function()}} stream */
    constructor(stream)
    {
        this.stream = stream;
        this.input = Buffer.alloc(0);
        this.next_id = 1;
        /** local id -> { on_message } */
        this.streams = new Map();
        this.on_connect = null;
        this.banner = null;
        stream.on_data = bytes => this.receive(bytes);
    }

    receive(bytes)
    {
        this.input = Buffer.concat([this.input, bytes]);
        while(this.input.length >= 24)
        {
            const length = this.input.readUInt32LE(12);
            if(this.input.length < 24 + length) break;
            const command = this.input.readUInt32LE(0), arg0 = this.input.readUInt32LE(4), arg1 = this.input.readUInt32LE(8);
            const data = this.input.subarray(24, 24 + length);
            this.input = this.input.subarray(24 + length);
            if(command === A_CNXN)
            {
                this.banner = data.toString("latin1");
                this.max_data = Math.min(arg1, MAX_DATA);
                this.on_connect?.(this.banner);
            }
            else if(command === A_AUTH)
            {
                this.on_connect?.(null, new Error("adbd asks for authentication (ro.adb.secure=1)"));
            }
            else
            {
                // OKAY, WRTE, CLSE: arg1 is our id
                this.streams.get(arg1)?.on_message(command, arg0, data);
            }
        }
    }

    /** @return {!Promise<string>} the device's banner */
    connect(timeout_ms = 30000)
    {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("no CNXN from adbd")), timeout_ms);
            this.on_connect = (banner, error) => { clearTimeout(timer); error ? reject(error) : resolve(banner); };
            this.stream.write(message(A_CNXN, VERSION, MAX_DATA, Buffer.from("host::\0")));
        });
    }

    /** a service's whole output (e.g. "shell:getprop"), until the device closes it */
    run(service, timeout_ms = 60000)
    {
        const id = this.next_id++;
        return new Promise((resolve, reject) => {
            const chunks = [];
            const timer = setTimeout(() => { this.streams.delete(id); reject(new Error(`${service}: no answer`)); }, timeout_ms);
            this.streams.set(id, { on_message: (command, remote, data) => {
                if(command === A_WRTE)
                {
                    chunks.push(Buffer.from(data));
                    this.stream.write(message(A_OKAY, id, remote));
                }
                else if(command === A_CLSE)
                {
                    clearTimeout(timer);
                    this.streams.delete(id);
                    this.stream.write(message(A_CLSE, id, remote));
                    resolve(Buffer.concat(chunks).toString("utf8"));
                }
            } });
            this.stream.write(message(A_OPEN, id, 0, Buffer.from(service + "\0")));
        });
    }

    shell(command, timeout_ms)
    {
        return this.run("shell:" + command, timeout_ms);
    }
}
