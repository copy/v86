#!/usr/bin/env node

var markdox = require("markdox");

var options = {
    output: __dirname + "/api.md",
    template: __dirname + "/template.md.ejs"
};

var files = [
    __dirname + "/../src/browser/starter.js",
];

markdox.process(files, options, function() {
  console.log("Ok. %s written.", options.output);
});
