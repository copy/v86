import { dbg_log } from "../log.js";

// For Types Only
import { BusConnector } from "../bus.js";

/**
 * @constructor
 *
 * @param {BusConnector} bus
 */
export function MouseAdapter(bus, screen_container)
{
    const SPEED_FACTOR = 1;

    var left_down = false,
        right_down = false,
        middle_down = false,

        last_x = 0,
        last_y = 0,

        mouse = this;

    // set by controller
    this.enabled = false;

    // set by emulator
    this.emu_enabled = true;

    this.bus = bus;

    this.bus.register("mouse-enable", function(enabled)
    {
        this.enabled = enabled;
    }, this);

    // TODO: Should probably not use bus for this
    this.is_running = false;
    this.bus.register("emulator-stopped", function()
    {
        this.is_running = false;
    }, this);
    this.bus.register("emulator-started", function()
    {
        this.is_running = true;
    }, this);

    this.destroy = function()
    {
        if(typeof window === "undefined")
        {
            return;
        }
        window.removeEventListener("touchstart", touch_start_handler, false);
        window.removeEventListener("touchend", touch_end_handler, false);
        window.removeEventListener("touchmove", mousemove_handler, false);
        window.removeEventListener("mousemove", mousemove_handler, false);
        window.removeEventListener("mousedown", mousedown_handler, false);
        window.removeEventListener("mouseup", mouseup_handler, false);
        window.removeEventListener("wheel", mousewheel_handler, { passive: false });
    };

    this.init = function()
    {
        if(typeof window === "undefined")
        {
            return;
        }
        this.destroy();

        window.addEventListener("touchstart", touch_start_handler, false);
        window.addEventListener("touchend", touch_end_handler, false);
        window.addEventListener("touchmove", mousemove_handler, false);
        window.addEventListener("mousemove", mousemove_handler, false);
        window.addEventListener("mousedown", mousedown_handler, false);
        window.addEventListener("mouseup", mouseup_handler, false);
        window.addEventListener("wheel", mousewheel_handler, { passive: false });
    };
    this.init();

    function is_child(child, parent)
    {
        while(child.parentNode)
        {
            if(child === parent)
            {
                return true;
            }
            child = child.parentNode;
        }

        return false;
    }

    function may_handle(e)
    {
        if(!mouse.enabled || !mouse.emu_enabled)
        {
            return false;
        }

        const MOVE_MOUSE_WHEN_OVER_SCREEN_ONLY = true;

        if(MOVE_MOUSE_WHEN_OVER_SCREEN_ONLY)
        {
            var parent = screen_container || document.body;
            return document.pointerLockElement || is_child(e.target, parent);
        }
        else
        {
            if(e.type === "mousemove" || e.type === "touchmove")
            {
                return true;
            }

            if(e.type === "mousewheel" || e.type === "DOMMouseScroll")
            {
                return is_child(e.target, parent);
            }

            return !e.target || e.target.nodeName !== "INPUT" && e.target.nodeName !== "TEXTAREA";
        }
    }

    function touch_start_handler(e)
    {
        if(may_handle(e))
        {
            var touches = e["changedTouches"];

            if(touches && touches.length)
            {
                var touch = touches[touches.length - 1];
                last_x = touch.clientX;
                last_y = touch.clientY;
            }
        }
    }

    function touch_end_handler(e)
    {
        if(left_down || middle_down || right_down)
        {
            mouse.bus.send("mouse-click", [false, false, false]);
            left_down = middle_down = right_down = false;
        }
    }

    function mousemove_handler(e)
    {
        if(!mouse.bus)
        {
            return;
        }

        if(!may_handle(e))
        {
            return;
        }

        if(!mouse.is_running)
        {
            return;
        }

        var delta_x = 0;
        var delta_y = 0;

        var touches = e["changedTouches"];

        if(touches)
        {
            if(touches.length)
            {
                var touch = touches[touches.length - 1];
                delta_x = touch.clientX - last_x;
                delta_y = touch.clientY - last_y;

                last_x = touch.clientX;
                last_y = touch.clientY;

                e.preventDefault();
            }
        }
        else
        {
            if(typeof e["movementX"] === "number")
            {
                delta_x = e["movementX"];
                delta_y = e["movementY"];
            }
            else if(typeof e["webkitMovementX"] === "number")
            {
                delta_x = e["webkitMovementX"];
                delta_y = e["webkitMovementY"];
            }
            else if(typeof e["mozMovementX"] === "number")
            {
                delta_x = e["mozMovementX"];
                delta_y = e["mozMovementY"];
            }
            else
            {
                // Fallback for other browsers?
                delta_x = e.clientX - last_x;
                delta_y = e.clientY - last_y;

                last_x = e.clientX;
                last_y = e.clientY;
            }
        }

        delta_x *= SPEED_FACTOR;
        delta_y *= SPEED_FACTOR;

        //if(Math.abs(delta_x) > 100 || Math.abs(delta_y) > 100)
        //{
        //    // Large mouse delta, drop?
        //}

        delta_y = -delta_y;

        // NOTE: affected by https://issues.chromium.org/issues/40737979
        //       Causes cursor jumps on multi-monitor and/or 120+ HZ monitors

        mouse.bus.send("mouse-delta", [delta_x, delta_y]);

        if(screen_container)
        {
            const absolute_x = e.pageX - screen_container.offsetLeft;
            const absolute_y = e.pageY - screen_container.offsetTop;
            mouse.bus.send("mouse-absolute", [
                absolute_x, absolute_y, screen_container.offsetWidth, screen_container.offsetHeight]);
        }
    }

    function mousedown_handler(e)
    {
        if(may_handle(e))
        {
            click_event(e, true);
        }
    }

    function mouseup_handler(e)
    {
        if(may_handle(e))
        {
            click_event(e, false);
        }
    }

    function click_event(e, down)
    {
        if(!mouse.bus)
        {
            return;
        }

        if(e.which === 1)
        {
            left_down = down;
        }
        else if(e.which === 2)
        {
            middle_down = down;
        }
        else if(e.which === 3)
        {
            right_down = down;
        }
        else
        {
            dbg_log("Unknown event.which: " + e.which);
        }
        mouse.bus.send("mouse-click", [left_down, middle_down, right_down]);
        e.preventDefault();
    }

    function mousewheel_handler(e)
    {
        if(!may_handle(e))
        {
            return;
        }

        var delta_x = e.wheelDelta || -e.detail;
        var delta_y = 0;

        if(delta_x < 0)
        {
            delta_x = -1;
        }
        else if(delta_x > 0)
        {
            delta_x = 1;
        }

        mouse.bus.send("mouse-wheel", [delta_x, delta_y]);
        e.preventDefault();
    }
}
