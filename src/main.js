import { CPU } from "./cpu.js";
import { save_state, restore_state } from "./state.js";
export { V86 } from "./browser/starter.js";

/**
 * @constructor
 * @param {Object=} wasm
 */
export function v86(bus, wasm)
{
    /** @type {boolean} */
    this.running = false;

    /** @type {boolean} */
    this.stopping = false;

    /** @type {boolean} */
    this.idle = true;

    this.tick_counter = 0;
    this.worker = null;

    /** @type {CPU} */
    this.cpu = new CPU(bus, wasm, () => { this.idle && this.next_tick(0); });

    this.bus = bus;

    this.register_yield();
}

v86.prototype.run = function()
{
    this.stopping = false;

    if(!this.running)
    {
        this.running = true;
        this.bus.send("emulator-started");
    }

    this.next_tick(0);
};

v86.prototype.do_tick = function()
{
    if(this.stopping || !this.running)
    {
        this.stopping = this.running = false;
        this.bus.send("emulator-stopped");
        return;
    }

    this.idle = false;
    const t = this.cpu.main_loop();

    this.next_tick(t);
};

v86.prototype.next_tick = function(t)
{
    const tick = ++this.tick_counter;
    this.idle = true;
    this.yield(t, tick);
};

v86.prototype.yield_callback = function(tick)
{
    if(tick === this.tick_counter)
    {
        this.do_tick();
    }
};

v86.prototype.stop = function()
{
    if(this.running)
    {
        this.stopping = true;
    }
};

v86.prototype.destroy = function()
{
    this.unregister_yield();
};

v86.prototype.restart = function()
{
    this.cpu.reset_cpu();
    this.cpu.load_bios();
};

v86.prototype.init = function(settings)
{
    this.cpu.init(settings, this.bus);
    this.bus.send("emulator-ready");
};

if(typeof process !== "undefined")
{
    v86.prototype.yield = function(t, tick)
    {
        /* global global */
        if(t < 1)
        {
            global.setImmediate(tick => this.yield_callback(tick), tick);
        }
        else
        {
            setTimeout(tick => this.yield_callback(tick), t, tick);
        }
    };

    v86.prototype.register_yield = function() {};
    v86.prototype.unregister_yield = function() {};
}
else if(globalThis["scheduler"] && typeof globalThis["scheduler"]["postTask"] === "function" && location.href.includes("use-scheduling-api"))
{
    v86.prototype.yield = function(t, tick)
    {
        t = Math.max(0, t);
        globalThis["scheduler"]["postTask"](() => this.yield_callback(tick), { delay: t });
    };

    v86.prototype.register_yield = function() {};
    v86.prototype.unregister_yield = function() {};
}
else if(typeof Worker !== "undefined")
{
    // XXX: This has a slightly lower throughput compared to window.postMessage

    function the_worker()
    {
        let timeout;
        globalThis.onmessage = function(e)
        {
            const t = e.data.t;
            timeout = timeout && clearTimeout(timeout);
            if(t < 1) postMessage(e.data.tick);
            else timeout = setTimeout(() => postMessage(e.data.tick), t);
        };
    }

    v86.prototype.register_yield = function()
    {
        const url = URL.createObjectURL(new Blob(["(" + the_worker.toString() + ")()"], { type: "text/javascript" }));
        this.worker = new Worker(url);
        this.worker.onmessage = e => this.yield_callback(e.data);
        URL.revokeObjectURL(url);
    };

    v86.prototype.yield = function(t, tick)
    {
        this.worker.postMessage({ t, tick });
    };

    v86.prototype.unregister_yield = function()
    {
        this.worker && this.worker.terminate();
        this.worker = null;
    };
}
//else if(typeof window !== "undefined" && typeof postMessage !== "undefined")
//{
//    // setImmediate shim for the browser.
//    // TODO: Make this deactivatable, for other applications
//    //       using postMessage
//
//    const MAGIC_POST_MESSAGE = 0xAA55;
//
//    v86.prototype.yield = function(t)
//    {
//        // XXX: Use t
//        window.postMessage(MAGIC_POST_MESSAGE, "*");
//    };
//
//    let tick;
//
//    v86.prototype.register_yield = function()
//    {
//        tick = e =>
//        {
//            if(e.source === window && e.data === MAGIC_POST_MESSAGE)
//            {
//                this.do_tick();
//            }
//        };
//
//        window.addEventListener("message", tick, false);
//    };
//
//    v86.prototype.unregister_yield = function()
//    {
//        window.removeEventListener("message", tick);
//        tick = null;
//    };
//}
else
{
    v86.prototype.yield = function(t)
    {
        setTimeout(() => { this.do_tick(); }, t);
    };

    v86.prototype.register_yield = function() {};
    v86.prototype.unregister_yield = function() {};
}

v86.prototype.save_state = function()
{
    // TODO: Should be implemented here, not on cpu
    return save_state(this.cpu);
};

v86.prototype.restore_state = function(state)
{
    // TODO: Should be implemented here, not on cpu
    return restore_state(this.cpu, state);
};

/* global require */
if(typeof performance === "object" && performance.now)
{
    v86.microtick = performance.now.bind(performance);
}
else if(typeof require === "function")
{
    const { performance } = require("perf_hooks");
    v86.microtick = performance.now.bind(performance);
}
else if(typeof process === "object" && process.hrtime)
{
    v86.microtick = function()
    {
        var t = process.hrtime();
        return t[0] * 1000 + t[1] / 1e6;
    };
}
else
{
    v86.microtick = Date.now;
}
