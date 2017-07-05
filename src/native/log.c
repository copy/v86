#include <stdint.h>
#include <math.h>
#include <assert.h>
#include <stdbool.h>

#include <stdio.h>

#include "const.h"
#include "global_pointers.h"

#define dbg_log(...) { if(DEBUG) { printf(__VA_ARGS__); } }
#define dbg_assert(condition) { if(DEBUG) { assert(condition); } }
#define dbg_assert_message(condition, message) { if(DEBUG && !(condition)) { dbg_log(message); assert(false); } }
