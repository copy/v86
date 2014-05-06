"use strict";

/** @constructor */
function MouseAdapter()
{
    /** @const */
    var SPEED_FACTOR = 0.15;

    var left_down = false,
        right_down = false,
        middle_down = false,

        last_x = 0,
        last_y = 0,

        // callback to call on a mouse click
        send_click,

        // callback to call on a mouse move
        send_delta,

        mouse = this;

    this.enabled = false;

    function may_handle(e)
    {
        return mouse.enabled && 
            (!e.target || e.type === "mousemove" || (e.target.nodeName !== "INPUT" && e.target.nodeName !== "TEXTAREA"));
    }

    this.destroy = function()
    {
        window.removeEventListener("mousemove", mousemove_handler, false);
        document.removeEventListener("contextmenu", contextmenu_handler, false);
        window.removeEventListener("mousedown", mousedown_handler, false);
        window.removeEventListener("mouseup", mouseup_handler, false);
    };

    this.init = function(click_fn, delta_fn, wheel_fn)
    {
        this.destroy();

        send_click = click_fn;
        send_delta = delta_fn;

        // TODO: wheel_fn

        window.addEventListener("mousemove", mousemove_handler, false);
        document.addEventListener("contextmenu", contextmenu_handler, false);
        window.addEventListener("mousedown", mousedown_handler, false);
        window.addEventListener("mouseup", mouseup_handler, false);
    };

    function mousemove_handler(e)
    {
        if(!may_handle(e))
        {
            return;
        }

        var delta_x, delta_y;

        if(true)
        {
            delta_x = e["webkitMovementX"] || e["mozMovementX"] || 0;
            delta_y = e["webkitMovementY"] || e["mozMovementY"] || 0;
        }
        else
        {
            // Fallback for other browsers?
            delta_x = e.clientX - last_x;
            delta_y = e.clientY - last_y;

            last_x = e.clientX;
            last_y = e.clientY;
        }

        if(SPEED_FACTOR !== 1)
        {
            delta_x = delta_x * SPEED_FACTOR;
            delta_y = delta_y * SPEED_FACTOR;
        }

        if(Math.abs(delta_x) > 100 || Math.abs(delta_y) > 100)
        {
            dbg_log("Large mouse delta: x=" + delta_x + " y=" + delta_y + " (drop?)");
        }

        send_delta(delta_x, -delta_y);

    }

    function contextmenu_handler(e)
    {
        if(may_handle(e))
        {
            e.preventDefault();
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
            dbg_log("Unknown event.which: " + e.which, LOG_MOUSE);
        }
        send_click(left_down, middle_down, right_down);

        e.preventDefault();
    }
}
