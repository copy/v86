"use strict";

if(typeof module !== "undefined")
{
    module.exports = Codegen;
}

/** @constructor */
function Codegen(wm)
{
    this.wm = wm;
    this.wm.exports["_gen_init"]();
}

Codegen.prototype.reset = function()
{
    this.wm.exports["_gen_reset"]();
};

Codegen.OUTPUT_OFFSET = 0x1000;
Codegen.STR_INPUT_OFFSET = 0x4000;

Codegen.prototype.str_input = function(str)
{
    if (str.length > 32) {
        throw new Error("Max string length for crossing boundary is 32");
    }
    const view = new Uint8Array(this.wm.memory.buffer, Codegen.STR_INPUT_OFFSET, 32);
    for (let i = 0; i < str.length; i++)
    {
        view[i] = str.charCodeAt(i);
    }
};

Codegen.prototype.fn0 = function(fn)
{
    this.str_input(fn);
    this.wm.exports["_gen_fn0"](Codegen.STR_INPUT_OFFSET, fn.length);
};

Codegen.prototype.fn1 = function(fn, arg0)
{
    this.str_input(fn);
    this.wm.exports["_gen_fn1"](Codegen.STR_INPUT_OFFSET, fn.length, arg0);
};

Codegen.prototype.fn2 = function(fn, arg0, arg1)
{
    this.str_input(fn);
    this.wm.exports["_gen_fn2"](Codegen.STR_INPUT_OFFSET, fn.length, arg0, arg1);
};

Codegen.prototype.modrm_fn1 = function(fn, modrm_byte, arg)
{
    this.str_input(fn);
    this.wm.exports["_gen_modrm_fn1"](Codegen.STR_INPUT_OFFSET, fn.length, modrm_byte, arg);
};

Codegen.prototype.modrm_fn0 = function(fn, modrm_byte)
{
    this.str_input(fn);
    this.wm.exports["_gen_modrm_fn1"](Codegen.STR_INPUT_OFFSET, fn.length, modrm_byte);
};

Codegen.prototype.resolve_modrm16 = function(modrm_byte)
{
    this.wm.exports["_gen_resolve_modrm16"](modrm_byte);
};

Codegen.prototype.resolve_modrm32 = function(modrm_byte)
{
    this.wm.exports["_gen_resolve_modrm32"](modrm_byte);
};

Codegen.prototype.increment_instruction_pointer = function(n)
{
    this.wm.exports["_gen_increment_instruction_pointer"](n);
};

Codegen.prototype.set_previous_eip = function()
{
    this.wm.exports["_gen_set_previous_eip"]();
};

Codegen.prototype.finish = function()
{
    return this.wm.exports["_gen_finish"]();
};

Codegen.prototype.commit_instruction_body_to_cs = function()
{
    return this.wm.exports["_gen_commit_instruction_body_to_cs"]();
};

Codegen.prototype.get_module_code = function()
{
    const end = this.wm.exports["_gen_get_final_offset"]() - Codegen.OUTPUT_OFFSET;

    // extract wasm module
    const output_buffer_view = new Uint8Array(this.wm.memory.buffer, Codegen.OUTPUT_OFFSET, end);
    return output_buffer_view;
};
