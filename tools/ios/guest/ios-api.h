// Minimal declarations for the public iOS 6 ABI. No SDK or Apple headers.
#ifndef V86_IOS_API_H
#define V86_IOS_API_H
typedef __SIZE_TYPE__ usize;
typedef const void *CFTypeRef;
typedef const void *CFStringRef;
typedef const void *CFDictionaryRef;
typedef void *CFMutableDictionaryRef;
typedef const void *CFAllocatorRef;
typedef unsigned char Boolean;
extern CFStringRef CFStringCreateWithCString(CFAllocatorRef, const char *, unsigned);
extern Boolean CFStringGetCString(CFStringRef, char *, long, unsigned);
extern CFMutableDictionaryRef CFDictionaryCreateMutable(CFAllocatorRef, long, const void *, const void *);
extern void CFDictionarySetValue(CFMutableDictionaryRef, const void *, const void *);
extern const void *CFDictionaryGetValue(CFDictionaryRef, const void *);
extern long CFDictionaryGetCount(CFDictionaryRef);
extern void CFRelease(CFTypeRef);
extern void CFShow(CFTypeRef);
extern const char kCFTypeDictionaryKeyCallBacks[], kCFTypeDictionaryValueCallBacks[];
extern void *dlopen(const char *, int), *dlsym(void *, const char *);
extern const char *dlerror(void);
extern void *objc_getClass(const char *), *sel_registerName(const char *);
extern void *objc_allocateClassPair(void *, const char *, usize);
extern void objc_registerClassPair(void *);
extern Boolean class_addMethod(void *, void *, void (*)(void), const char *);
extern void *objc_msgSend(void *, void *, ...);
extern void *objc_autoreleasePoolPush(void);
extern void objc_autoreleasePoolPop(void *);
extern int printf(const char *, ...), snprintf(char *, usize, const char *, ...);
extern int strcmp(const char *, const char *), memcmp(const void *, const void *, usize);
extern usize strlen(const char *);
extern void *malloc(usize), *calloc(usize, usize), *memcpy(void *, const void *, usize), *memset(void *, int, usize);
extern void free(void *);
extern int open(const char *, int, ...), close(int), write(int, const void *, usize), read(int, void *, usize);
extern int fsync(int), unlink(const char *), mkdir(const char *, unsigned short), usleep(unsigned);
extern int dup2(int, int);
extern void sync(void), syslog(int, const char *, ...);
#define UTF8 0x08000100
static inline CFStringRef string(const char *s) { return CFStringCreateWithCString(0, s, UTF8); }
static inline void *send0(void *o, const char *s) { return objc_msgSend(o, sel_registerName(s)); }
static inline void *send1(void *o, const char *s, void *a) { return objc_msgSend(o, sel_registerName(s), a); }
#endif
