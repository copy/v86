// ARM user-mode transport used by the N90 guest. A write is one emugl packet.
#include "gles-opcodes.h"

static int gles_trap(unsigned operation, const void *buffer, unsigned size, unsigned connection)
{
    register unsigned r0 __asm__("r0") = 0x86640000 | operation;
    register __UINTPTR_TYPE__ r1 __asm__("r1") = (__UINTPTR_TYPE__)buffer;
    register unsigned r2 __asm__("r2") = size;
    register unsigned r3 __asm__("r3") = connection;
#ifdef __thumb__
    __asm__ volatile(".inst.w 0xf7f8a664" : "+r"(r0) : "r"(r1), "r"(r2), "r"(r3) : "memory");
#else
    __asm__ volatile(".word 0xe7f866f4" : "+r"(r0) : "r"(r1), "r"(r2), "r"(r3) : "memory");
#endif
    return (int)r0;
}

// On FAULT the host consumed no bytes. Fault in each guest page using the
// original access direction (including copy-on-write output pages), then retry.
static int gles_call(unsigned op, const void *buffer, unsigned size, unsigned conn)
{
    int result = gles_trap(op, buffer, size, conn);
    if(result != -1 || !size) return result;
    volatile unsigned char *p = (volatile unsigned char *)buffer;
    for(unsigned at = 0; at < size;)
    {
        unsigned char byte = p[at];
        if(op == 3) p[at] = byte;
        unsigned remaining = 4096 - ((__UINTPTR_TYPE__)(p + at) & 4095);
        if(remaining >= size - at) break;
        at += remaining;
    }
    return gles_trap(op, buffer, size, conn);
}

static int gles_open(void)
{
    if(gles_call(0, 0, 0, 0) != 1) return -1;
    int conn = gles_call(1, "opengles", 8, 0);
    if(conn <= 0) return -1;
    unsigned flags = 0;
    if(gles_call(2, &flags, sizeof(flags), conn) == sizeof(flags)) return conn;
    gles_call(5, 0, 0, conn);
    return -1;
}

static int gles_read(int conn, void *out, unsigned length)
{
    unsigned char *p = out;
    while(length)
    {
        int n = gles_call(3, p, length, conn);
        if(n == -2) continue; // waiting for the renderer
        if(n <= 0 || (unsigned)n > length) return 0;
        p += n;
        length -= n;
    }
    return 1;
}

static int gles_send(unsigned conn, unsigned *packet, unsigned size)
{
    packet[1] = size;
    return gles_call(2, packet, size, conn) == (int)size;
}

#define SEND(conn, op, ...) gles_send(conn, (unsigned[]){op, 0, __VA_ARGS__}, sizeof((unsigned[]){op, 0, __VA_ARGS__}))
