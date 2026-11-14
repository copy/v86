'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../src/browser/glbridge/d3d9-webgpu'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'ddraw-xrgb-'));
const rows=[
 ['upload loses native X','formats','a = format === D3DFMT_A8R8G8B8 || preserveXrgbBits','a = format === D3DFMT_A8R8G8B8',1],
 ['readback loses native X','formats','format === D3DFMT_A8R8G8B8 || preserveXrgbBits\n                    ? unorm(a, 255)','format === D3DFMT_A8R8G8B8\n                    ? unorm(a, 255)',1],
 ['fill ignores native X','formats','converted, 0, null, preserveXrgbBits);','converted, 0, null, false);',1],
 ['sampling exposes unused byte as alpha','formats','if (format === D3DFMT_X8R8G8B8) return "rgb1";','if (format === D3DFMT_X8R8G8B8) return "";',1],
 ['2D creation omits opt-in','resources','ddXrgbBits: (usage & D9WG_USAGE_DDRAW_XRGB_BITS) !== 0 && format === 22,','ddXrgbBits: false,',1],
 ['cube creation omits opt-in','resources','ddXrgbBits: (usage & D9WG_USAGE_DDRAW_XRGB_BITS) !== 0 && format === 22,','ddXrgbBits: false,',2],
 ['ordinary D3D9 storage wrongly opts in','resources','ddXrgbBits: (usage & D9WG_USAGE_DDRAW_XRGB_BITS) !== 0 && format === 22,','ddXrgbBits: format === 22,',1],
];
try{for(const[label,kind,from,to,which]of rows){const source=fs.readFileSync(root+'/d9wg_'+kind+'.js','utf8');let at=-1;for(let i=0;i<which;i++){at=source.indexOf(from,at+1);assert(at>=0,label);}const file=dir+'/mutated.js';fs.writeFileSync(file,source.slice(0,at)+to+source.slice(at+from.length));const r=spawnSync(process.execPath,[__dirname+'/ddraw_xrgb_bits_test.js'],{encoding:'utf8',env:{...process.env,[kind==='formats'?'DDRAW_XRGB_FORMATS_SOURCE':'DDRAW_XRGB_RESOURCES_SOURCE']:file}});assert.notEqual(r.status,0,label);assert.match(r.stderr,/AssertionError/,label+': runtime contract assertion required');assert(!/Cannot find module|SyntaxError|TypeError/.test(r.stderr),r.stderr);console.log('KILL '+label);}console.log('PASS XRGB mutations '+rows.length+'/'+rows.length+' executed implementations rejected');}finally{fs.rmSync(dir,{recursive:true,force:true});}
