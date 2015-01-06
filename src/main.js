"use strict";

/** @define {boolean} */
var IN_NODE = false;

/** @define {boolean} */
var IN_WORKER = false;

/** @define {boolean} */
var IN_BROWSER = true;


if(IN_BROWSER + IN_NODE + IN_WORKER !== 1)
{
    throw "Invalid environment";
}

/** @constructor */
function v86(bus)
{
    /** @type {boolean} */
    this.first_init = true;

    /** @type {boolean} */
    this.running = false;

    /** @type {boolean} */
    this.stopped = false;

    /** @type {CPU} */
    this.cpu = new CPU();

    this.bus = bus;
    bus.register("cpu-init", this.init, this);
    bus.register("cpu-run", this.run, this);
    bus.register("cpu-stop", this.stop, this);

    this.fast_next_tick = function() { console.assert(false); };
    this.next_tick = function(time) { console.assert(false); };
}

v86.prototype.run = function() 
{
    if(!this.running)
    {
        this.fast_next_tick();
    }
};

v86.prototype.do_tick = function() 
{
    if(this.stopped)
    {
        this.stopped = this.running = false;
        return;
    }

    this.running = true;
    var dt = this.cpu.main_run();

    //this.next_tick(dt);
    var me = this;
    setTimeout(function() { me.do_tick(); }, dt);
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
    if(this.first_init)
    {
        this.first_init = false;
        this.lazy_init();
    }

    this.cpu.init(settings, this.bus);
};

// initialization that only needs to be once
v86.prototype.lazy_init = function()
{
    var emulator = this;

    if(typeof setImmediate !== "undefined")
    {
        this.fast_next_tick = function()
        {
            setImmediate(function() { emulator.do_tick(); });
        };
    }
    else if(typeof window !== "undefined" && typeof postMessage !== "undefined")
    {
        // setImmediate shim for the browser.
        // TODO: Make this deactivatable, for other applications
        //       using postMessage

        /** @const */
        var MAGIC_POST_MESSAGE = 0xAA55;

        window.addEventListener("message", function(e)
        {
            if(e.source === window && e.data === MAGIC_POST_MESSAGE)
            {
                emulator.do_tick();
            }
        }, false);

        this.fast_next_tick = function()
        {
            window.postMessage(MAGIC_POST_MESSAGE, "*");
        };
    }
    else
    {
        this.fast_next_tick = function()
        {
            setTimeout(function() { emulator.do_tick(); }, 0);
        };
    }

    if(typeof document !== "undefined" && typeof document.hidden === "boolean")
    {
        this.next_tick = function(t)
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
                setTimeout(function() { emulator.do_tick(); }, t);
            }
        };
    }
    else
    {
        // In environments that aren't browsers, we might as well use setTimeout
        this.next_tick = function(t)
        {
            setTimeout(function() { emulator.do_tick(); }, t);
        };
    }
};

v86.prototype.save_state = function()
{
    return this.cpu.save_state();
};

v86.prototype.restore_state = function(state)
{
    return this.cpu.restore_state(state);
};


if(typeof performance === "object" && performance.now)
{
    v86.microtick = function()
    {
        return performance.now();
    };
}
else
{
    v86.microtick = Date.now;
}

