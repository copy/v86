"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), {spawnSync} = require("node:child_process");
(async () => {
    const {site_directory} = await import("../lib/site.mjs"), site = site_directory(path.resolve(__dirname, "../.."));
    const source = fs.readFileSync(process.env.D9WG_HOST_FEATURES_TRANSPORT_SOURCE || site + "/glbridge/runtime/d9wg_transport.c", "utf8"), start = source.indexOf("uint32_t d9wg_transport_host_features("), end = source.indexOf("\n}\n", start) + 3; assert(start >= 0 && end > start);
    const code = `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "${site}/glbridge/runtime/d9wg_host_caps.h"
#include "${site}/glbridge/runtime/d9wg_runtime.h"
typedef uint32_t DWORD;typedef int BOOL;
#define TRUE 1
#define FALSE 0
#define D9WG_HOST_CAPS_WAIT_MS 1000u
typedef struct {DWORD caps_retry_tick;BOOL caps_retry_armed,mapped;uint32_t session_id_low,session_id_high;} D9WGProcess;
static uint32_t region[D9WG_RESPONSE_REGION_BYTES/4];static D9WGHello hello;
static DWORD tick;static unsigned opens,reserves,flushes,sleeps,delay,mask;static BOOL open_ok,reserve_ok,flush_ok;
static void publish(void){D9WGHostCapabilities *p=(void *)((uint8_t *)region+D9WG_HOST_CAPS_OFFSET);p->feature_bits=mask;p->version=1;p->magic=0x50414348;}
static DWORD GetTickCount(void){return tick;}
static void Sleep(DWORD ms){tick+=ms;if(++sleeps>1200){fputs("host caps transport line: unbounded optional wait\\n",stderr);exit(1);}if(sleeps==delay)publish();}
static void *d9wg_transport_response(D9WGProcess *p){return p->mapped?region:0;}
static BOOL d9wg_transport_open(D9WGProcess *p){++opens;p->mapped=open_ok;return open_ok;}
static BOOL d9wg_transport_reserve(D9WGProcess *p,uint16_t op,uint32_t size,uint32_t extra,D9WGCommandHeader **command,uint8_t **payload,uint8_t **blob,BOOL (*flush)(BOOL)){
 (void)p;(void)command;(void)blob;(void)flush;++reserves;if(op!=D9WG_OP_HELLO||size!=sizeof(hello)||extra){fputs("host caps transport line: wrong reservation\\n",stderr);exit(1);}*payload=(void *)&hello;return reserve_ok;}
static BOOL flush(BOOL present){++flushes;if(present||hello.guest_pointer_bits!=32||hello.feature_bits!=3||hello.session_id_low!=0x12345678||hello.session_id_high!=0x87654321){fputs("host caps transport line: wrong HELLO\\n",stderr);exit(1);}if(flush_ok&&!delay)publish();return flush_ok;}
${source.slice(start, end)}
#define CHECK(x) do{if(!(x)){fprintf(stderr,"host caps transport line %u: %s\\n",__LINE__,#x);return 1;}}while(0)
static void reset(D9WGProcess *p){memset(region,0,sizeof(region));memset(p,0,sizeof(*p));p->session_id_low=0x12345678;p->session_id_high=0x87654321;opens=reserves=flushes=sleeps=delay=mask=0;open_ok=reserve_ok=flush_ok=TRUE;tick=100;}
int main(void){D9WGProcess p;
 for(mask=0;mask<16;){unsigned expected=mask;reset(&p);mask=expected;CHECK(d9wg_transport_host_features(&p,3,flush)==expected&&opens==1&&reserves==1&&flushes==1&&!sleeps);CHECK(d9wg_transport_host_features(&p,3,flush)==expected&&opens==1&&reserves==1&&flushes==1);mask=expected+1;}
 reset(&p);delay=20;mask=3;CHECK(d9wg_transport_host_features(&p,3,flush)==3&&sleeps==20&&flushes==1);
 for(unsigned wrap=0;wrap<2;++wrap){reset(&p);delay=2000;if(wrap)tick=0xfffffff0u;DWORD start=tick;CHECK(d9wg_transport_host_features(&p,3,flush)==0&&sleeps==1000&&(DWORD)(tick-start)==1000);CHECK(d9wg_transport_host_features(&p,3,flush)==0&&sleeps==1000&&flushes==1);tick+=1000;delay=0;mask=2;CHECK(d9wg_transport_host_features(&p,3,flush)==2&&flushes==2&&sleeps==1000);}
 reset(&p);open_ok=FALSE;CHECK(!d9wg_transport_host_features(&p,3,flush)&&opens==1&&!reserves&&!flushes&&!sleeps);CHECK(!d9wg_transport_host_features(&p,3,flush)&&opens==1);
 reset(&p);reserve_ok=FALSE;CHECK(!d9wg_transport_host_features(&p,3,flush)&&reserves==1&&!flushes&&!sleeps);
 reset(&p);flush_ok=FALSE;CHECK(!d9wg_transport_host_features(&p,3,flush)&&flushes==1&&!sleeps);
 CHECK(!d9wg_transport_host_features(0,3,flush)&&!d9wg_transport_host_features(&p,3,0));
 puts("PASS actual host-feature C transport: 16 masks, exact HELLO, fast cached reply, delayed response, bounded/limited retry across clock wrap and atomic open/reserve/flush failures");return 0;}
`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "d9wg-host-feature-transport-"));
    try {
        const file = path.join(directory, "caps.c"), binary = path.join(directory, "caps"); fs.writeFileSync(file, code);
        const build = spawnSync(process.env.HOST_CC || "cc", ["-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", file, site + "/glbridge/runtime/d9wg_runtime.c", "-o", binary], {encoding: "utf8"}); assert.equal(build.status, 0, build.stderr);
        const run = spawnSync(binary, [], {encoding: "utf8"}); assert.equal(run.status, 0, run.stderr); process.stdout.write(run.stdout);
    } finally {fs.rmSync(directory, {recursive: true, force: true});}
})().catch(error => {console.error(error); process.exitCode = 1;});
