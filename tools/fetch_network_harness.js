const dgram = require('node:dgram');
const server = dgram.createSocket('udp4');
const fs = require('node:fs');
const path = require('node:path');

//  qemu-system-i386 -m 2G -nographic -hda ~/disk.qcow2 -netdev dgram,id=net0,remote.type=inet,remote.host=127.0.0.1,remote.port=6677,local.host=127.0.0.1,local.port=7744,local.type=inet -device e1000,netdev=net0

globalThis.dbg_assert = require('node:assert');
globalThis.dbg_log = (what, level) => console.log(what);
globalThis.LOG_NET = 0;

let FetchNetworkAdapter = require(path.join(__dirname, '..', 'src', 'browser', 'fetch_network.js'));

let events = {};

let bus = {
    register: (name, fn, bind) => events[name] = fn.bind(bind),
    send: (name, data) => events[name](data)
};

let a = new FetchNetworkAdapter(bus);

server.on('error', (err) => {
  console.error(`server error:\n${err.stack}`);
  server.close();
});

server.on('message', (msg, rinfo) => {
  //console.log(`server got: ${msg.toString("hex")} from ${rinfo.address}:${rinfo.port}`);
  events["net0-receive"] = (data) => {
    //console.log(`sending: ${Buffer.from(data).toString("hex")} to ${rinfo.address}:${rinfo.port}`);
    server.send(Buffer.from(data), rinfo.port);
  };
  bus.send('net0-send', new Uint8Array(msg));
});

server.on('listening', () => {
  const address = server.address();
  
  console.log(`server listening ${address.address}:${address.port}`);
});

server.bind(6677);
