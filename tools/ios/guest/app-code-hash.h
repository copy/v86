// Read the SHA-1 CodeDirectory identity of a prepared thin ARMv7 image.
extern long long lseek(int, long long, int);
extern unsigned char *CC_SHA1(const void *, unsigned, unsigned char *);
static unsigned code_le(const unsigned char *b) { return b[0] | b[1]<<8 | b[2]<<16 | (unsigned)b[3]<<24; }
static unsigned code_be(const unsigned char *b) { return (unsigned)b[0]<<24 | b[1]<<16 | b[2]<<8 | b[3]; }
static int code_read_at(int fd, unsigned at, void *data, unsigned n)
{
    if(lseek(fd, at, 0) != at) return 0;
    unsigned done = 0;
    while(done < n) { int count = read(fd, (char *)data+done, n-done); if(count <= 0) return 0; done += count; }
    return 1;
}
static int app_code_hash(const char *path, unsigned char digest[20])
{
    unsigned char header[28]; int ok=0, fd=open(path,0); if(fd<0)return 0;
    if(!code_read_at(fd,0,header,28) || code_le(header)!=0xFEEDFACE || code_le(header+4)!=12 || code_le(header+20)>65536)goto done;
    unsigned at=28,end=28+code_le(header+20),count=code_le(header+16),sig=0,length=0;
    if(count>(end-28)/8)goto done;
    for(unsigned i=0;i<count;i++)
    {
        unsigned char cmd[16];if(at+8>end || !code_read_at(fd,at,cmd,8))goto done;
        unsigned size=code_le(cmd+4);if(size<8 || at+size>end)goto done;
        if(code_le(cmd)==29){if(size<16 || !code_read_at(fd,at,cmd,16))goto done;sig=code_le(cmd+8);length=code_le(cmd+12);}at+=size;
    }
    if(!sig || length<12 || length>2097152)goto done;
    unsigned char *blob=malloc(length);if(!blob)goto done;
    if(!code_read_at(fd,sig,blob,length) || code_be(blob)!=0xFADE0CC0 || code_be(blob+4)>length)goto cleanup;
    count=code_be(blob+8);if(count>(length-12)/8)goto cleanup;
    for(unsigned i=0;i<count;i++)
    {
        if(code_be(blob+12+i*8)!=0)continue;unsigned off=code_be(blob+16+i*8);
        if(off>length-44 || code_be(blob+off)!=0xFADE0C02 || code_be(blob+off+4)<44 || code_be(blob+off+4)>length-off ||
            blob[off+36]!=20 || blob[off+37]!=1)goto cleanup;
        CC_SHA1(blob+off,code_be(blob+off+4),digest);ok=1;break;
    }
cleanup:free(blob);
done:close(fd);return ok;
}
