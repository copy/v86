// Bootstrap an independent native helper from the always-running local
// lockdown service. iOS 6's cached system jobs do not discover new plists.
#include "ios-api.h"
extern int pthread_create(void *, const void *, void *(*)(void *), void *), pthread_detach(unsigned);
extern int posix_spawn(int *, const char *, const void *, const void *, char *const *, char *const *);
extern int waitpid(int, int *, int);
static void *start_agent(void *unused)
{
    (void)unused;
    int probe=open("/private/var/v86/install-probe",0);if(probe>=0)close(probe);
    char *args[] = { "/usr/lib/v86-app-agent", probe>=0?"--install-test":"--serve", probe>=0?"/private/var/mobile/Media/PublicStaging/test.ipa":0, 0 };
    char *environment[] = { 0 }; int pid = 0, status = 0;
    do {
        int error = posix_spawn(&pid, args[0], 0, 0, args, environment);
        syslog(5, "V86 agent bootstrap error=%d pid=%d", error, pid);
        if(!error) { waitpid(pid, &status, 0); syslog(5, "V86 agent exited status=%d", status); }
        if(probe<0)usleep(5000000);
    } while(probe<0);
    return 0;
}
__attribute__((constructor)) static void bootstrap(void)
{
    unsigned thread;
    if(!pthread_create(&thread, 0, start_agent, 0)) pthread_detach(thread);
}
