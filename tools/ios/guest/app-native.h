#include "ios-api.h"
struct app_identity { char version[128], executable[1024]; unsigned char cdhash[20]; };
int app_native_load(void);
int app_native_ready(void);
int app_native_install(const char *, void (*)(CFDictionaryRef));
int app_native_lookup(const char *, struct app_identity *);
unsigned long long app_native_free(void);
int app_service(void);
