import dgram from "node:dgram";
import { V86, FetchNetworkAdapter } from "../nodejs-loader.mjs";

//  qemu-system-i386 -m 2G -nographic -hda ~/disk.qcow2 -netdev dgram,id=net0,remote.type=inet,remote.host=127.0.0.1,remote.port=6677,local.host=127.0.0.1,local.port=7744,local.type=inet -device e1000,netdev=net0

const server = dgram.createSocket("udp4");
const events = {};

const bus = {
    register: (name, fn, bind) => events[name] = fn.bind(bind),
    send: (name, data) => events[name](data)
};

const a = new FetchNetworkAdapter(bus);

server.on("error", (err) => {
  console.error(`server error:\n${err.stack}`);
  server.close();
});

server.on("message", (msg, rinfo) => {
  //console.log(`server got: ${msg.toString("hex")} from ${rinfo.address}:${rinfo.port}`);
  events["net0-receive"] = (data) => {
    //console.log(`sending: ${Buffer.from(data).toString("hex")} to ${rinfo.address}:${rinfo.port}`);
    server.send(Buffer.from(data), rinfo.port);
  };
  bus.send("net0-send", new Uint8Array(msg));
});

server.on("listening", () => {
  const address = server.address();

  console.log(`server listening ${address.address}:${address.port}`);
});

server.bind(6677);
