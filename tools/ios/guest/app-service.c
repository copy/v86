// Independent, authenticated iOS 6 installation transport. Files on the
// mounted data volume are written only here, through native filesystem APIs.
#include "app-native.h"
#include "app-code-hash.h"
extern int rename(const char *,const char *), chown(const char *,unsigned,unsigned), chmod(const char *,unsigned short);
extern int flock(int,int);
extern int CC_SHA256_Init(void *), CC_SHA256_Update(void *,const void *,unsigned), CC_SHA256_Final(unsigned char *,void *);
extern void CCHmac(unsigned,const void *,usize,const void *,usize,void *);
#define ROOT "/private/var/v86/"
// installd clears PublicStaging during its first initialization. Keep
// verified uploads outside that directory, including across cold boots.
#define STAGING "/private/var/mobile/Media/v86-staging/"
#define FRAME_MAX (65536+8192)
#define JOB_MAX (548+189*20)
static unsigned char token[32],nonce[32],job[JOB_MAX],packet[FRAME_MAX+16];
static unsigned job_size,offset,generation,phase,sequence;
static int native_percent=-1;
static int connection=-1,callback_error;
static char last_error[512],ipa[256],reported_version[128];
enum { IDLE,TRANSFERRING,STAGED,INSTALLING,VERIFYING,INSTALLED,FAILED,CANCELLED,INTERRUPTED };
static const char *phases[]={"idle","transferring","staged","installing","verifying","installed","failed","cancelled","interrupted"};
static void put32(unsigned char *p,unsigned v){p[0]=v;p[1]=v>>8;p[2]=v>>16;p[3]=v>>24;}
static int full_write(int fd,const void *bytes,unsigned size)
{
    const char *p=bytes;while(size){int n=write(fd,p,size);if(n<=0)return 0;p+=n;size-=n;}return 1;
}
static int atomic_file(const char *path,const void *bytes,unsigned size,unsigned short mode)
{
    char tmp[256];if(snprintf(tmp,sizeof(tmp),"%s.tmp",path)>=(int)sizeof(tmp))return 0;
    int fd=open(tmp,0x601,mode);if(fd<0)return 0;
    int ok=full_write(fd,bytes,size)&&!fsync(fd);close(fd);
    if(!ok || rename(tmp,path)){unlink(tmp);return 0;}
    fd=open(ROOT,0);if(fd<0)return 0;ok=!fsync(fd);close(fd);return ok;
}
static int persist(void)
{
    unsigned char saved[16+JOB_MAX+512];put32(saved,0x32533856);put32(saved+4,phase);put32(saved+8,offset);put32(saved+12,job_size);
    memcpy(saved+16,job,job_size);memcpy(saved+16+job_size,last_error,512);
    return atomic_file(ROOT "install-job",saved,16+job_size+512,0600);
}
static void json_string(char *out,unsigned cap,const char *in)
{
    unsigned n=0;for(;*in && n+7<cap;in++){
        unsigned char c=*in;if(c=='"'||c=='\\'){out[n++]='\\';out[n++]=c;}
        else if(c<32){out[n++]=' ';}else out[n++]=c;
    }out[n]=0;
}
static int trap(unsigned op,const void *buffer,unsigned size,unsigned conn)
{
    register unsigned r0 __asm__("r0")=0x86640000|op;
    register __UINTPTR_TYPE__ r1 __asm__("r1")=(__UINTPTR_TYPE__)buffer;
    register unsigned r2 __asm__("r2")=size,r3 __asm__("r3")=conn;
    __asm__ volatile(".word 0xe7f866f4":"+r"(r0):"r"(r1),"r"(r2),"r"(r3):"memory");return (int)r0;
}
static int call(unsigned op,const void *buffer,unsigned size,unsigned conn)
{
    int n=trap(op,buffer,size,conn);if(n!=-1 || !size)return n;
    volatile unsigned char *p=(volatile unsigned char *)buffer;
    for(unsigned at=0;at<size;){unsigned char c=p[at];if(op==3)p[at]=c;unsigned step=4096-((__UINTPTR_TYPE__)(p+at)&4095);if(step>=size-at)break;at+=step;}
    return trap(op,buffer,size,conn);
}
static int receive(void *data,unsigned length)
{
    unsigned char *p=data;while(length){int n=call(3,p,length,connection);if(n==-2){usleep(10000);continue;}if(n<=0 || (unsigned)n>length)return 0;p+=n;length-=n;}return 1;
}
static int reply(unsigned op,unsigned seq,int ok,const char *detail,int installed)
{
    char error[1024],status[256],version[256];json_string(error,sizeof(error),last_error);json_string(status,sizeof(status),detail?detail:"");json_string(version,sizeof(version),reported_version);
    char *body=(char *)packet+48;
    int n=snprintf(body,4096,"{\"protocol\":1,\"build\":\"10B329\",\"ok\":%s,\"phase\":\"%s\",\"install_id\":\"%s\",\"bundle_id\":\"%s\",\"job_generation\":%u,\"offset\":%u,\"total\":%u,\"native_percent\":%d,\"status\":\"%s\",\"error\":\"%s\",\"version\":\"%s\",\"installed\":%s}",
        ok?"true":"false",phases[phase],job_size?(char *)job+32:"",job_size?(char *)job+112:"",job_size?code_le(job+8):0,offset,job_size?code_le(job+4):0,native_percent,status,error,version,installed?"true":"false");
    if(n<0 || n>=4096)return 0;
    unsigned char auth[40+4096];memcpy(auth,nonce,32);put32(auth+32,op);put32(auth+36,seq);memcpy(auth+40,body,n);
    CCHmac(2,token,32,auth,40+n,packet+16);
    put32(packet,0x49363856);put32(packet+4,op);put32(packet+8,seq);put32(packet+12,32+n);
    return call(2,packet,48+n,connection)==48+n;
}
static int valid_job(const unsigned char *b,unsigned n)
{
    return n>=548 && code_le(b)==0x314A3856 && code_le(b+4)>0 && code_le(b+4)<=0x80000000U && code_le(b+16)<=189 &&
        n==548+20*code_le(b+16) && b[32] && b[111]==0 && b[112] && b[367]==0 && b[368] && b[495]==0;
}
static int verify_installed(void)
{
    struct app_identity app;
    int ok=job_size && app_native_lookup((char *)job+112,&app) && !strcmp(app.version,(char *)job+368) && !memcmp(app.cdhash,job+528,20);
    if(ok)snprintf(reported_version,sizeof(reported_version),"%s",app.version);return ok;
}
static void fail(const char *message)
{
    snprintf(last_error,sizeof(last_error),"%s",message);phase=FAILED;persist();
}
static void native_status(CFDictionaryRef info)
{
    CFStringRef percent_key=string("PercentComplete");CFTypeRef percent=CFDictionaryGetValue(info,percent_key);
    if(percent){long value=(long)send0((void *)percent,"intValue");native_percent=value>=0&&value<=100?(int)value:-1;}CFRelease(percent_key);
    CFStringRef k=string("Status");CFTypeRef value=CFDictionaryGetValue(info,k);char message[256]="";
    if(value)CFStringGetCString(value,message,sizeof(message),UTF8);CFRelease(k);
    k=string("Error");value=CFDictionaryGetValue(info,k);if(value){callback_error=1;CFStringGetCString(value,last_error,sizeof(last_error),UTF8);}CFRelease(k);
    if(callback_error){k=string("ErrorDescription");value=CFDictionaryGetValue(info,k);if(value)CFStringGetCString(value,last_error,sizeof(last_error),UTF8);CFRelease(k);}
    k=string("ErrorDetail");value=CFDictionaryGetValue(info,k);
    if(value){char detail[512];unsigned code=(unsigned)(usize)send0((void *)value,"unsignedIntValue");
        snprintf(detail,sizeof(detail),"%s (0x%08x)",last_error,code);memcpy(last_error,detail,sizeof(last_error));last_error[511]=0;}CFRelease(k);
    reply(30,sequence,1,message,0);
}
static int hash_ipa(unsigned char digest[32])
{
    int fd=open(ipa,0);if(fd<0)return 0;
    unsigned char buffer[65536];unsigned total=0;unsigned long long context[32];CC_SHA256_Init(context);int n;
    while((n=read(fd,buffer,sizeof(buffer)))>0){if((unsigned)n>code_le(job+4)-total){close(fd);return 0;}total+=n;CC_SHA256_Update(context,buffer,n);}
    close(fd);if(n<0 || total!=code_le(job+4))return 0;CC_SHA256_Final(digest,context);return 1;
}
static void restore(void)
{
    unsigned char saved[16+JOB_MAX+512];int fd=open(ROOT "install-job",0);if(fd<0)return;
    int n=read(fd,saved,sizeof(saved));close(fd);
    if(n<16 || (code_le(saved)!=0x31533856 && code_le(saved)!=0x32533856) || code_le(saved+4)>INTERRUPTED)return;
    unsigned length=code_le(saved+12),error_size=code_le(saved)==0x32533856?512:0;
    if(length>JOB_MAX || n!=16+length+error_size || !valid_job(saved+16,length))return;
    phase=code_le(saved+4);offset=code_le(saved+8);job_size=length;memcpy(job,saved+16,job_size);
    if(error_size){memcpy(last_error,saved+16+job_size,512);last_error[511]=0;}
    snprintf(ipa,sizeof(ipa),STAGING "%s.ipa",(char *)job+32);
    if(phase==INSTALLING || phase==VERIFYING){phase=verify_installed()?INSTALLED:INTERRUPTED;persist();}
    else if(phase==TRANSFERRING){phase=INTERRUPTED;persist();}
    if(phase==INTERRUPTED)snprintf(last_error,sizeof(last_error),"The previous installation was interrupted; select the IPA again to retry");
}
static void command(unsigned op,unsigned char *b,unsigned n)
{
    if(op==3){if(n==4)generation=code_le(b);return;}
    int ok=0;last_error[0]=0;
    if(op==10)
    {
        if(phase==TRANSFERRING || phase==STAGED || phase==INSTALLING || phase==VERIFYING){snprintf(last_error,sizeof(last_error),"An installation is already active");goto answer;}
        if(!valid_job(b,n)){snprintf(last_error,sizeof(last_error),"Invalid prepared application metadata");goto answer;}
        unsigned long long expanded=(unsigned long long)code_le(b+20)|((unsigned long long)code_le(b+24)<<32);
        if(!expanded || expanded>0x100000000ULL || app_native_free()<expanded*2+code_le(b+4)+(64<<20))
            {snprintf(last_error,sizeof(last_error),"The iPhone has insufficient free space for staging and installation");goto answer;}
        for(unsigned i=32;i<112 && b[i];i++)if(!((b[i]>='a'&&b[i]<='z')||(b[i]>='A'&&b[i]<='Z')||(b[i]>='0'&&b[i]<='9')||b[i]=='-')){snprintf(last_error,sizeof(last_error),"Invalid installation identity");goto answer;}
        if(job_size)unlink(ipa);
        job_size=n;memcpy(job,b,n);offset=0;native_percent=-1;phase=TRANSFERRING;snprintf(ipa,sizeof(ipa),STAGING "%s.ipa",(char *)job+32);
        int fd=open(ipa,0xA01,0600);if(fd<0){fail("Cannot create the native IPA staging file");goto answer;}
        ok=!chown(ipa,501,501)&&!fsync(fd);close(fd);if(ok)ok=persist();if(!ok)fail("Cannot persist the installation task");
    }
    else if(op==11)
    {
        if(phase!=TRANSFERRING || n<5 || n>65540 || code_le(b)!=offset || n-4>code_le(job+4)-offset){snprintf(last_error,sizeof(last_error),"Unexpected IPA upload offset");goto answer;}
        int fd=open(ipa,1);if(fd<0 || lseek(fd,offset,0)!=offset){if(fd>=0)close(fd);fail("Cannot open the IPA upload");goto answer;}
        ok=full_write(fd,b+4,n-4);close(fd);if(ok)offset+=n-4;else fail("The native IPA staging write failed");
    }
    else if(op==12)
    {
        if(phase!=TRANSFERRING || offset!=code_le(job+4)){snprintf(last_error,sizeof(last_error),"The IPA upload is incomplete");goto answer;}
        unsigned char digest[32];int fd=open(ipa,0);ok=fd>=0&&!fsync(fd);if(fd>=0)close(fd);
        if(!ok || !hash_ipa(digest) || memcmp(digest,job+496,32)){fail("The staged IPA checksum did not match");ok=0;goto answer;}
        phase=STAGED;ok=persist();if(!ok)fail("Cannot persist the verified IPA");
    }
    else if(op==13)
    {
        if(phase!=STAGED || generation!=code_le(job+8)){snprintf(last_error,sizeof(last_error),"Application code trust is not committed for this boot");goto answer;}
        unsigned char digest[32];
        if(!hash_ipa(digest) || memcmp(digest,job+496,32)){fail("The staged IPA changed before installation");goto answer;}
        unsigned char list[12+189*20];memcpy(list,"V86T",4);put32(list+4,1);put32(list+8,code_le(job+16));memcpy(list+12,job+548,job_size-548);
        if(!atomic_file(ROOT "install-trust.bin",list,12+job_size-548,0644)){fail("Cannot persist the native code validation policy");goto answer;}
        phase=INSTALLING;if(!persist()){fail("Cannot persist the installation start");goto answer;}
        callback_error=0;reply(30,sequence,1,"Calling the native iOS installer",0);
        int result=app_native_install(ipa,native_status);if(result || callback_error)app_native_diagnostics();
        phase=VERIFYING;persist();reply(30,sequence,1,"Checking the installed application",0);
        ok=!result && !callback_error && verify_installed();
        if(ok){phase=INSTALLED;sync();ok=persist();unlink(ipa);}
        else {if(!last_error[0])snprintf(last_error,sizeof(last_error),"Native installation failed or the installed application's identity did not match (%d)",result);phase=FAILED;sync();persist();}
    }
    else if(op==14)
    {
        if(phase!=TRANSFERRING && phase!=STAGED && phase!=INTERRUPTED){snprintf(last_error,sizeof(last_error),"Installation cannot be cancelled in this phase");goto answer;}
        unlink(ipa);phase=CANCELLED;ok=persist();
    }
    else if(op==15)
    {
        if(!n || n>=256){snprintf(last_error,sizeof(last_error),"Invalid application identifier");goto answer;}
        char bundle[256];memcpy(bundle,b,n);bundle[n]=0;struct app_identity app;int found=app_native_lookup(bundle,&app);
        snprintf(reported_version,sizeof(reported_version),"%s",found?app.version:"");
        // A job is installed only when its bundle, version and main code hash match.
        if(job_size && !strcmp(bundle,(char *)job+112) && found && verify_installed()){phase=INSTALLED;persist();}
        ok=1;reply(31,sequence,1,found?"Application registered":"Application not registered",found);return;
    }
    else {snprintf(last_error,sizeof(last_error),"Unknown native installation command");}
answer:reply(31,sequence,ok,"",phase==INSTALLED);
}
int app_service(void)
{
    mkdir(ROOT,0755);int lock=open(ROOT "install-lock",0x201,0600);if(lock<0 || flock(lock,6))return 4;
    int fd=open(ROOT "install-token",0);if(fd<0)return 5;int got=read(fd,token,32);close(fd);if(got!=32)return 5;
    mkdir("/private/var/mobile/Media/PublicStaging",0755);mkdir(STAGING,0700);chown(STAGING,501,501);chmod(STAGING,0700);
    if(!app_native_load())return 3;
    while(!app_native_ready())usleep(1000000);
    restore();
    for(;;)
    {
        connection=call(1,"v86.ios.install",15,0);if(connection<=0){usleep(1000000);continue;}
        unsigned char header[16];if(!receive(header,16) || code_le(header)!=0x49363856 || code_le(header+4)!=1 || code_le(header+12)!=32 || !receive(nonce,32))goto reconnect;
        if(!reply(2,0,1,"Native installer ready",phase==INSTALLED))goto reconnect;
        for(;;)
        {
            if(!receive(header,16) || code_le(header)!=0x49363856 || code_le(header+12)>FRAME_MAX)break;
            unsigned n=code_le(header+12);if(!receive(packet,n))break;sequence=code_le(header+8);
            // command() may emit progress into packet, so retain its input separately.
            unsigned char *body=malloc(n?n:1);if(!body)break;memcpy(body,packet,n);command(code_le(header+4),body,n);free(body);
        }
reconnect:call(5,0,0,connection);connection=-1;usleep(100000);
    }
}
