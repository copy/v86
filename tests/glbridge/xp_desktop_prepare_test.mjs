import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync}from'node:child_process';
const source=fs.readFileSync(new URL('./wine_xp_desktop_prepare.c',import.meta.url),'utf8'),at=source.indexOf('int main(');assert(at>=0);const body=source.slice(at).replace('int main(','static int prepare_main('),dir=fs.mkdtempSync(path.join(os.tmpdir(),'xp-prepare-policy-'));
const code=`#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
typedef uint32_t DWORD;typedef void*HWND;typedef intptr_t LPARAM;typedef int BOOL;typedef struct{HWND restart,wizard;}Boot;typedef DWORD(*PendingInstall)(DWORD);
#define WAIT_OBJECT_0 0u
#define WAIT_TIMEOUT 258u
#define FALSE 0
static int trace(const char*format,...){(void)format;return 0;}
#define printf trace
static DWORD ticks;static unsigned scenario,actions;static BOOL popup;
static DWORD GetTickCount(void){return ticks;}static void Sleep(DWORD ms){ticks+=ms;}static void flush_log(void){fflush(stdout);}static int lstrcmpA(const char*a,const char*b){return strcmp(a,b);}static DWORD GetLastError(void){return 42;}
static DWORD query(DWORD ignored){(void)ignored;if(scenario==3)return 0xffffffffu;if(scenario==0||scenario==4)return ticks<70000?WAIT_TIMEOUT:0;if(scenario==1)return WAIT_TIMEOUT;return 0;}
static PendingInstall pending_install(void){return query;}static BOOL boot_window(HWND w,LPARAM p){(void)w;(void)p;return 1;}static BOOL EnumWindows(BOOL(*f)(HWND,LPARAM),LPARAM p){(void)f;Boot*b=(void*)p;b->wizard=popup?(void*)1:NULL;return 1;}static BOOL IsWindow(HWND w){return w&&popup;}static BOOL IsWindowVisible(HWND w){return w&&popup;}static BOOL close_known(HWND w,BOOL restart){(void)w;(void)restart;actions++;if(scenario==5)return 0;if(scenario==7)popup=0;return 1;}
${body}
#define MUST(x) do{if(!(x)){fprintf(stderr,"XP prepare policy line %u: %s\\n",__LINE__,#x);return 1;}}while(0)
int main(void){char*a[]={"prepare",NULL},*check[]={"prepare","--check-only",NULL};for(scenario=0;scenario<9;scenario++){ticks=actions=0;popup=scenario>=5;int hr=prepare_main(scenario==4||scenario==8?2:1,scenario==4||scenario==8?check:a);switch(scenario){case 0:if(XP_PREPARE_TIMEOUT_MS==60000u)MUST(hr==1&&ticks==60000);else MUST(!hr&&ticks>=79900&&ticks<=80100);break;case 1:MUST(hr==1&&ticks==XP_PREPARE_TIMEOUT_MS);break;case 2:MUST(!hr&&ticks==10000);break;case 3:MUST(hr==1&&!ticks);break;case 4:MUST(hr==1&&!ticks);break;case 5:MUST(hr==1&&actions==1&&!ticks);break;case 6:MUST(hr==1&&actions==3&&ticks==6000);break;case 7:MUST(!hr&&actions==1&&ticks==10000);break;case 8:MUST(hr==1&&!ticks&&!actions);break;}}
puts("PASS XP preparation readiness invariants");return 0;}
`;
try{fs.writeFileSync(dir+'/policy.c',code);for(const timeout of[60000,180000]){const exe=dir+'/policy'+timeout,r=spawnSync(process.env.HOST_CC||'cc',['-std=c11','-O1','-Wall','-Wextra','-Werror','-DXP_PREPARE_TIMEOUT_MS='+timeout+'u',dir+'/policy.c','-o',exe],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);const run=spawnSync(exe,[],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS XP preparation readiness invariants/);}console.log('PASS actual XP prepare C: default/extended deadlines, late PnP readiness, busy/error rejection, ten-second quiet requirement, unknown/stuck popup rejection and strict immediate postcheck');}finally{fs.rmSync(dir,{recursive:true,force:true});}
