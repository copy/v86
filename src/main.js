"use strict";

/** @constructor */
function v86(bus)
{
    /** @type {boolean} */
    this.running = false;

    /** @type {boolean} */
    this.stopped = false;

    /** @type {CPU} */
    this.cpu = new CPU(bus);

    this.bus = bus;
    bus.register("cpu-init", this.init, this);
    bus.register("cpu-run", this.run, this);
    bus.register("cpu-stop", this.stop, this);
    bus.register("cpu-restart", this.restart, this);

    this.register_tick();
}

v86.prototype.run = function()
{
    if(!this.running)
    {
        this.bus.send("emulator-started");
        this.fast_next_tick();
    }
};

v86.prototype.do_tick = function()
{
    if(this.stopped)
    {
        this.stopped = this.running = false;
        this.bus.send("emulator-stopped");
        return;
    }

    this.running = true;
    var dt = this.cpu.main_run();

    if(dt <= 0)
    {
        this.fast_next_tick();
    }
    else
    {
        this.next_tick(dt);
    }
};

v86.prototype.stop = function()
{
    if(this.running)
    {
        this.stopped = true;
    }
};

v86.prototype.restart = function()
{
    this.cpu.reset();
    this.cpu.load_bios();
};

v86.prototype.init = function(settings)
{
    this.cpu.init(settings, this.bus);
    this.bus.send("emulator-ready");
};

if(typeof setImmediate !== "undefined")
{
    /** @this {v86} */
    var fast_next_tick = function()
    {
        setImmediate(() => { this.do_tick(); });
    };

    /** @this {v86} */
    var register_tick = function() {};
}
else if(typeof window !== "undefined" && typeof postMessage !== "undefined")
{
    // setImmediate shim for the browser.
    // TODO: Make this deactivatable, for other applications
    //       using postMessage

    /** @const */
    let MAGIC_POST_MESSAGE = 0xAA55;

    /** @this {v86} */
    fast_next_tick = function()
    {
        window.postMessage(MAGIC_POST_MESSAGE, "*");
    };

    /** @this {v86} */
    register_tick = function()
    {
        window.addEventListener("message", (e) =>
        {
            if(e.source === window && e.data === MAGIC_POST_MESSAGE)
            {
                this.do_tick();
            }
        }, false);
    };
}
else
{
    /** @this {v86} */
    fast_next_tick = function()
    {
        setTimeout(() => { this.do_tick(); }, 0);
    };

    /** @this {v86} */
    register_tick = function() {};
}

v86.prototype.fast_next_tick = fast_next_tick;
v86.prototype.register_tick = register_tick;

if(typeof document !== "undefined" && typeof document.hidden === "boolean")
{
    /** @this {v86} */
    var next_tick = function(t)
    {
        if(t < 4 || document.hidden)
        {
            // Avoid sleeping for 1 second (happens if page is not
            // visible), it can break boot processes. Also don't try to
            // sleep for less than 4ms, since the value is clamped up
            this.fast_next_tick();
        }
        else
        {
            setTimeout(() => { this.do_tick(); }, t);
        }
    };
}
else
{
    // In environments that aren't browsers, we might as well use setTimeout
    /** @this {v86} */
    next_tick = function(t)
    {
        setTimeout(() => { this.do_tick(); }, t);
    };
}

v86.prototype.next_tick = next_tick;

v86.prototype.save_state = function()
{
    // TODO: Should be implemented here, not on cpu
    return this.cpu.save_state();
};

v86.prototype.restore_state = function(state)
{
    // TODO: Should be implemented here, not on cpu
    return this.cpu.restore_state(state);
};


if(typeof performance === "object" && performance.now)
{
    v86.microtick = function()
    {
        return performance.now();
    };
}
//else if(typeof process === "object" && process.hrtime)
//{
//    v86.microtick = function()
//    {
//        var t = process.hrtime();
//        return t[0] * 1000 + t[1] / 1e6;
//    };
//}
else
{
    v86.microtick = Date.now;
}
