const is_env_node = v86util.check_env_node();
const fs = is_env_node && require("fs");
const path = is_env_node && require("path");
const Buffer = is_env_node && require("buffer")["Buffer"];

/** @constructor */
function CoverageLogger()
{
    this.ENABLED = DEBUG && is_env_node;
    if(!this.ENABLED)
    {
        return;
    }
    this.should_log_coverage = false;
    this.memory_base = 0;
}

CoverageLogger.prototype.log_start = function()
{
    if(!this.ENABLED)
    {
        return;
    }
    this.should_log_coverage = true;
};

CoverageLogger.prototype.log_end = function()
{
    if(!this.ENABLED)
    {
        return;
    }
    this.should_log_coverage = false;
};

CoverageLogger.prototype.init = function(wm)
{
    if(!this.ENABLED)
    {
        return;
    }

    this.coverage_map = {};
    this.memory_base = wm.imports.env["memoryBase"];
    this.COVERAGE_DATA_PATH = path.join(__dirname, "coverage");

    for(let name of Object.keys(wm.exports))
    {
        if(name.startsWith(COVERAGE_EXPORT_PREFIX))
        {
            const fn_id = wm.exports[name];
            this.coverage_map[fn_id] = {};

            const coverage_data = this.coverage_map[fn_id];
            // fn_id -> func_name
            coverage_data.fn_name = name.slice(COVERAGE_EXPORT_PREFIX.length);
            // fn_id -> block_covered ([0,2,3])
            coverage_data.visit_logs = new Uint8Array(8);
            // Position within visit_logs from where to append data
            coverage_data.pos = 0;
            // Total number of conditional blocks in fn_id
            coverage_data.total_blocks = 0;
        }
    }
};

CoverageLogger.prototype.log = function(fn_name_offset, num_blocks, visited_block)
{
    if(!this.ENABLED || !this.should_log_coverage)
    {
        return;
    }

    // fn_name_offset is an offset in the data section to where the string of the function
    // name is stored, so it varies by memoryBase, whereas the __profn exported fn_id doesn't
    const fn_id = fn_name_offset - this.memory_base;
    const coverage_data = this.coverage_map[fn_id];
    if(!coverage_data)
    {
        // Static functions may not be "discovered" in coverage_init - we currently simply
        // skip them
        return;
    }

    const log_pos = coverage_data.pos;
    const existing_entry = coverage_data.visit_logs.indexOf(visited_block);
    if((existing_entry > -1 && existing_entry < log_pos) || num_blocks > 0xFF)
    {
        // If we'd like to profile frequency of code visited, we should be using counters
        // instead. This approach was simply faster to measure coverage.
        return;
    }

    coverage_data.total_blocks = num_blocks;
    coverage_data.visit_logs[log_pos] = visited_block;
    coverage_data.pos++;

    if(log_pos >= coverage_data.visit_logs.length - 1)
    {
        this.dump_to_files();
        coverage_data.pos = 0;
    }
};

CoverageLogger.prototype.dump_to_files = function()
{
    if(!this.ENABLED)
    {
        return;
    }

    for(let fn_id of Object.keys(this.coverage_map))
    {
        const coverage_data = this.coverage_map[fn_id];
        if(coverage_data.pos)
        {
            const fn_name = coverage_data.fn_name;
            const total_blocks = coverage_data.total_blocks;
            const filename = path.join(
                this.COVERAGE_DATA_PATH,
                `${COVERAGE_FILE_PREFIX}_${fn_name}_${total_blocks}`
            );
            // XXX: Experiment more with async I/O - preliminarily it seemed to choke the nasm test
            // even when limiting max files open simultaneously
            fs["appendFileSync"](
                filename,
                Buffer.from(coverage_data.visit_logs.buffer, 0, coverage_data.pos)
            );
            coverage_data.pos = 0;
        }
    }
};
