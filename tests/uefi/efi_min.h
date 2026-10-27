/* The few UEFI tables, protocols and GUIDs the test applications use
 * (tests/uefi/sb_app.c, vars_app.c): x86_64-w64-mingw32-gcc, no EFI headers.
 * Only the members they call are named. */
typedef unsigned long long u64;
typedef unsigned int u32;
typedef unsigned short u16;
typedef unsigned char u8;
typedef u64 status_t;
typedef void *handle_t;
typedef struct { u32 a; u16 b, c; u8 d[8]; } guid_t;
#define API __attribute__((ms_abi))

typedef struct { u64 signature; u32 revision, size, crc, reserved; } table_header;
typedef struct text_out
{
    void *reset;
    API status_t (*output)(struct text_out *, const u16 *);
} text_out;
typedef struct
{
    table_header hdr;
    void *get_time, *set_time, *get_wakeup, *set_wakeup, *set_virtual, *convert;
    API status_t (*get_variable)(const u16 *, const guid_t *, u32 *, u64 *, void *);
    void *next_name;
    API status_t (*set_variable)(const u16 *, const guid_t *, u32, u64, const void *);
    void *next_count;
    API void (*reset)(u32, status_t, u64, void *);
} runtime_services;
typedef struct
{
    table_header hdr;
    void *raise, *restore, *allocate_pages, *free_pages, *memory_map;
    API status_t (*allocate_pool)(u32, u64, void **);
    API status_t (*free_pool)(void *);
    void *create_event, *set_timer, *wait, *signal, *close_event, *check_event;
    void *install, *reinstall, *uninstall;
    API status_t (*handle_protocol)(handle_t, const guid_t *, void **);
    void *reserved, *notify, *locate_handle, *locate_path, *install_table;
    API status_t (*load_image)(u8, handle_t, void *, void *, u64, handle_t *);
    API status_t (*start_image)(handle_t, u64 *, u16 **);
    void *exit;
    API status_t (*unload_image)(handle_t);
    void *exit_boot_services, *next_monotonic, *stall;
    API status_t (*set_watchdog)(u64, u64, u64, u16 *);
} boot_services;
typedef struct
{
    table_header hdr;
    u16 *vendor;
    u32 revision;
    handle_t in_handle;
    void *in;
    handle_t out_handle;
    text_out *out;
    handle_t err_handle;
    void *err;
    runtime_services *rt;
    boot_services *bs;
} system_table;
typedef struct
{
    u32 revision;
    handle_t parent;
    system_table *system;
    handle_t device;
    void *path;
    void *reserved;
    u32 options_size;
    void *options;
} loaded_image;
typedef struct file
{
    u64 revision;
    API status_t (*open)(struct file *, struct file **, const u16 *, u64, u64);
    API status_t (*close)(struct file *);
    void *remove;
    API status_t (*read)(struct file *, u64 *, void *);
    void *write;
    API status_t (*get_position)(struct file *, u64 *);
    API status_t (*set_position)(struct file *, u64);
} file;
typedef struct
{
    u64 revision;
    API status_t (*open_volume)(void *, file **);
} file_system;

static const guid_t LOADED_IMAGE = {0x5B1B31A1, 0x9562, 0x11d2, {0x8E, 0x3F, 0x00, 0xA0, 0xC9, 0x69, 0x72, 0x3B}};
static const guid_t FILE_SYSTEM = {0x964E5B22, 0x6459, 0x11d2, {0x8E, 0x39, 0x00, 0xA0, 0xC9, 0x69, 0x72, 0x3B}};
static const guid_t DEVICE_PATH = {0x09576E91, 0x6D3F, 0x11d2, {0x8E, 0x39, 0x00, 0xA0, 0xC9, 0x69, 0x72, 0x3B}};
