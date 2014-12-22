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
function v86()
{
    /** @type {boolean} */
    this.first_init = true;

    /** @type {boolean} */
    this.running = false;

    /** @type {boolean} */
    this.stopped = false;

    /** @type {CPU} */
    this.cpu = new CPU();

    this.next_tick = function() {};
    this.microtick = function() {};
}

v86.prototype.run = function() 
{
    if(!this.running)
    {
        this.next_tick();
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
    this.cpu.main_run();

    this.next_tick();
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

    this.cpu.init(settings);
};

// initialization that only needs to be once
v86.prototype.lazy_init = function()
{
    var emulator = this;

    if(typeof setImmediate !== "undefined")
    {
        this.next_tick = function()
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

        this.next_tick = function()
        {
            window.postMessage(MAGIC_POST_MESSAGE, "*");
        };
    }
    else
    {
        this.next_tick = function()
        {
            setTimeout(function() { emulator.do_tick(); }, 0);
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

