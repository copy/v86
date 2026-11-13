#include "ios-api.h"
struct app_identity { char version[128], executable[1024]; unsigned char cdhash[20]; };
int app_native_load(void);
int app_native_ready(void);
void app_native_diagnostics(void);
void app_native_start_diagnostics(void);
int app_native_install(const char *, void (*)(CFDictionaryRef));
int app_native_lookup(const char *, struct app_identity *);
int app_native_launch(const char *,char *,unsigned);
unsigned long long app_native_free(void);
int app_service(void);
