// One time domain for the entire machine, in milliseconds. Guest clocks must
// never infer elapsed time from the number of reads or the number of vCPUs.

/**
 * @constructor
 * @param {Object=} options
 */
export function MachineClock(options)
{
    options = options || {};
    this.mode = options["mode"] || "normal";
    this.instructions_per_ms = options["instructions_per_ms"] === undefined ? 100000 : options["instructions_per_ms"];
    this.max_host_delta_ms = options["max_host_delta_ms"] === undefined ? 1000 : options["max_host_delta_ms"];
    // (normal time: guest milliseconds per host millisecond, at most 1; below
    // 1 the guest's timeouts get more host time, for a CPU much slower than
    // the guest's software expects, as Bochs's ips; the wall clock lags)
    this.rate = options["rate"] === undefined ? 1 : options["rate"];
    this.host_now = options["now"] || (() => performance.now());
    this.wall_epoch_ms = options["wall_epoch_ms"] === undefined ?
        (this.mode === "deterministic" ? 946684800000 : Date.now()) : options["wall_epoch_ms"];

    if(this.mode !== "normal" && this.mode !== "deterministic" ||
        !Number.isFinite(this.instructions_per_ms) || this.instructions_per_ms <= 0 ||
        !Number.isFinite(this.max_host_delta_ms) || this.max_host_delta_ms <= 0 ||
        !Number.isFinite(this.rate) || this.rate <= 0 || this.rate > 1 ||
        !Number.isFinite(this.wall_epoch_ms) || typeof this.host_now !== "function")
    {
        throw new Error("Invalid machine clock configuration");
    }

    this.time_ms = 0;
    this.instruction_count = 0;
    this.idle_ms = 0;
    this.paused = false;
    this.host_last = this.host_now();
    if(!Number.isFinite(this.host_last))
    {
        throw new Error("Invalid host monotonic clock reading");
    }
    this.host_pause_count = 0;
    this.discarded_host_ms = 0;
    this.host_backwards_count = 0;
    /** @type {?function():number} */
    this.instruction_source = null;
}

/**
 * Reading deterministic time consumes only already committed progress. Normal
 * time samples the host clock without artificially incrementing equal readings.
 * Long host gaps are bounded; discarded time is not repaid on later reads.
 * @return {number}
 */
MachineClock.prototype.now = function()
{
    if(!this.paused && this.mode === "deterministic" && this.instruction_source)
    {
        // A PIO read may occur inside a Wasm slice. Consume prior architectural
        // progress then, without giving the read itself any artificial ticks.
        this.commit_instructions(this.instruction_source());
    }
    if(!this.paused && this.mode === "normal")
    {
        const host = this.host_now();
        if(!Number.isFinite(host))
        {
            throw new Error("Invalid host monotonic clock reading");
        }
        const delta = host - this.host_last;
        if(delta < 0)
        {
            this.host_backwards_count++;
        }
        else
        {
            this.host_last = host;
            if(delta > this.max_host_delta_ms)
            {
                this.host_pause_count++;
                this.discarded_host_ms += delta - this.max_host_delta_ms;
            }
            this.time_ms += Math.min(delta, this.max_host_delta_ms) * this.rate;
        }
    }
    return this.time_ms;
};

/** The RTC epoch is independent of the destination host's calendar. */
MachineClock.prototype.wall_time = function()
{
    return this.wall_epoch_ms + this.now();
};

/** Called once for committed progress, never once per time read or vCPU. */
MachineClock.prototype.advance_instructions = function(count)
{
    this.commit_instructions(count);
    return this.now();
};

/** @param {number} count */
MachineClock.prototype.commit_instructions = function(count)
{
    if(!Number.isSafeInteger(count) || count < 0 ||
        !Number.isSafeInteger(this.instruction_count + count))
    {
        throw new Error("Invalid committed instruction count");
    }
    if(this.mode === "deterministic" && !this.paused)
    {
        this.instruction_count += count;
        // Use the total to avoid floating-point drift depending on slice size.
        this.time_ms = this.instruction_count / this.instructions_per_ms + this.idle_ms;
    }
};

/**
 * The callback consumes a delta of committed instructions/REP elements.
 * @param {?function():number} source
 */
MachineClock.prototype.set_instruction_source = function(source)
{
    if(source !== null && typeof source !== "function")
    {
        throw new Error("Invalid committed instruction source");
    }
    this.now();
    this.instruction_source = source;
};

/** Only the scheduler may jump a fully halted machine to its next event. */
MachineClock.prototype.advance_to = function(deadline_ms)
{
    this.now();
    if(!Number.isFinite(deadline_ms) || deadline_ms < 0)
    {
        throw new Error("Invalid machine clock deadline");
    }
    if(this.mode === "deterministic" && !this.paused && deadline_ms > this.time_ms)
    {
        this.idle_ms += deadline_ms - this.time_ms;
        this.time_ms = deadline_ms;
    }
    return this.now();
};

/**
 * The host milliseconds until `ms` of the machine's time have passed (the
 * run loop's waits)
 * @param {number} ms
 * @return {number}
 */
MachineClock.prototype.to_host_ms = function(ms)
{
    return this.mode === "normal" ? ms / this.rate : ms;
};

MachineClock.prototype.pause = function()
{
    this.now();
    this.paused = true;
};

MachineClock.prototype.resume = function()
{
    if(this.paused)
    {
        this.host_last = this.host_now();
        this.paused = false;
    }
};

/**
 * Go on from `time_ms` (a vCPU worker's clock when it leaves a stop: the
 * machine's time, which a restore may have set anywhere)
 * @param {number} time_ms
 */
MachineClock.prototype.set_time = function(time_ms)
{
    this.time_ms = time_ms;
    this.host_last = this.host_now();
};

MachineClock.prototype.get_diagnostics = function()
{
    return {
        "host_pause_count": this.host_pause_count,
        "discarded_host_ms": this.discarded_host_ms,
        "host_backwards_count": this.host_backwards_count,
        "committed_instructions": this.instruction_count,
        "idle_ms": this.idle_ms,
    };
};

MachineClock.prototype.get_state = function()
{
    return [1, this.mode, this.now(), this.wall_epoch_ms, this.instructions_per_ms,
        this.max_host_delta_ms, this.instruction_count, this.idle_ms,
        this.host_pause_count, this.discarded_host_ms, this.host_backwards_count];
};

MachineClock.prototype.set_state = function(state)
{
    if(state[0] !== 1 || state[1] !== "normal" && state[1] !== "deterministic" ||
        !Number.isFinite(state[2]) || state[2] < 0 || !Number.isFinite(state[3]) ||
        !Number.isFinite(state[4]) || state[4] <= 0 || !Number.isFinite(state[5]) || state[5] <= 0 ||
        !Number.isSafeInteger(state[6]) || state[6] < 0 || !Number.isFinite(state[7]) || state[7] < 0 ||
        !Number.isSafeInteger(state[8]) || state[8] < 0 || !Number.isFinite(state[9]) || state[9] < 0 ||
        !Number.isSafeInteger(state[10]) || state[10] < 0)
    {
        throw new Error("Invalid machine clock snapshot");
    }
    this.mode = state[1];
    this.time_ms = state[2];
    this.wall_epoch_ms = state[3];
    this.instructions_per_ms = state[4];
    this.max_host_delta_ms = state[5];
    this.instruction_count = state[6];
    this.idle_ms = state[7];
    this.host_pause_count = state[8];
    this.discarded_host_ms = state[9];
    this.host_backwards_count = state[10];
    this.host_last = this.host_now();
    // Pause/run belongs to the destination emulator's lifecycle. Restoring a
    // running snapshot into a stopped emulator must not start its clocks.
};
