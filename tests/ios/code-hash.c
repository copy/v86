// Exercise the guest's bounded signature reader with the host SHA-1 API.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>
#else
#include <openssl/sha.h>
static unsigned char *CC_SHA1(const void *data,unsigned size,unsigned char *out) { return SHA1(data,size,out); }
#endif
static long long signature_lseek(int fd,long long at,int whence) { return lseek(fd,at,whence); }
#define lseek signature_lseek
#include "../../tools/ios/guest/app-code-hash.h"
int main(int argc,char **argv)
{
    unsigned char digest[20];if(argc!=2 || !app_code_hash(argv[1],digest))return 1;
    for(unsigned i=0;i<20;i++)printf("%02x",digest[i]);puts("");return 0;
}
