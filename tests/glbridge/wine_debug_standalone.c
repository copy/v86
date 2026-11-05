/* Host CRT bridge for Wine's diagnostic string helpers only. */
#include <string.h>
#include "wine/test.h"
const char *__cdecl __wine_dbg_strdup(const char *text)
{
    struct winetest_thread_data *data = winetest_get_thread_data();
    size_t size = strlen(text) + 1;
    if (size > sizeof(data->strings)) return "<oversized diagnostic>";
    if (data->str_pos + size > data->strings + sizeof(data->strings))
        data->str_pos = data->strings;
    char *out = data->str_pos;
    memcpy(out, text, size);
    data->str_pos += size;
    return out;
}
