// Convert an offline raw test NAND to the same packed medium OPFS uses.
import fs from "node:fs";
import { open_sparse_nand } from "../../src/ios/sparse_nand.js";
import { NAND_BYTES,NAND_SLOT } from "../../src/apple/nand_geometry.js";
const [source,target]=process.argv.slice(2);
if(!source||!target)throw new Error("usage: pack-nand.mjs raw-nand.img new-packed.img (phone powered off)");
const input=fs.openSync(source,"r"),output=fs.openSync(target,"wx+");
try{
    if(fs.fstatSync(input).size!==NAND_BYTES)throw new Error("Expected the complete raw N90 NAND geometry");
    const access={read:(b,{at})=>fs.readSync(output,b,0,b.length,at),write:(b,{at})=>fs.writeSync(output,b,0,b.length,at),
        truncate:n=>fs.ftruncateSync(output,n),getSize:()=>fs.fstatSync(output).size};
    const packed=open_sparse_nand(access,true),chunk=Buffer.alloc(NAND_SLOT*16),erased=Buffer.alloc(chunk.length);
    for(let at=0;at<NAND_BYTES;at+=chunk.length){
        if(fs.readSync(input,chunk,0,chunk.length,at)!==chunk.length)throw new Error("Short raw NAND read");
        if(Buffer.compare(chunk,erased))packed.write(at,chunk);
    }
    fs.fsyncSync(output);console.log("Packed NAND: "+fs.fstatSync(output).size+" bytes");
}finally{fs.closeSync(input);fs.closeSync(output);}
