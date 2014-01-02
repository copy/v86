// Run with d8, not node

var path = "../../src/";

load(path + "const.js");
load(path + "io.js");
load(path + "cpu.js");
load(path + "main.js");
load(path + "pci.js");
load(path + "memory.js");
load(path + "dma.js");
load(path + "pit.js");
load(path + "pic.js");


if(typeof console === "undefined")
{
    var console = {
        log: print,
    }
}

var log = print;

DEBUG = false;

var cpu = new v86();

cpu.init({});

// defines file
load("test-asm.js");

for(var i = 0; i < file.length; i++)
{
    cpu.memory.mem8[i] = file[i];
}

function run()
{
    for(var i = 0; i < count; i++)
    {
        cpu.cycle();
    }
}

var count = 1e7;

var start = Date.now();

run();

var end = Date.now(),
    duration = (end - start) / 1e3;

console.log("Finished in " + duration + " seconds, " + (count / duration / 1e6).toFixed(2) + " mips");

