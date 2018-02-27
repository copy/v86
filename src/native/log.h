#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "const.h"

extern void logop(int32_t, int32_t);
extern void dbg_trace(void);

#define dbg_log(...) { if(DEBUG) { printf(__VA_ARGS__); } }
#define dbg_trace(...) { if(DEBUG) { dbg_trace(__VA_ARGS__); } }
#define dbg_assert(condition) { if(DEBUG) { if(!(condition)) dbg_log(#condition); assert(condition); } }
#define dbg_assert_message(condition, message) { if(DEBUG && !(condition)) { dbg_log(message); assert(false); } }
