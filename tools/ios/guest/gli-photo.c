// Convert the legacy opaque PhotoLibrary bitmaps to a format the native
// Core Animation compositor can upload through the v86 graphics bridge.
typedef __SIZE_TYPE__ size_t;
typedef void *ref;
typedef struct { float x, y, width, height; } rect;
typedef void (*image_setter)(ref, ref, ref);

extern ref objc_getClass(const char *), sel_registerName(const char *);
extern ref class_getInstanceMethod(ref, ref), objc_msgSend(ref, ref, ...);
extern image_setter method_setImplementation(ref, image_setter);
extern unsigned long CFGetTypeID(ref), CGImageGetTypeID(void);
extern size_t CGImageGetWidth(ref), CGImageGetHeight(ref);
extern unsigned CGImageGetBitmapInfo(ref);
extern ref CGColorSpaceCreateDeviceRGB(void);
extern ref CGBitmapContextCreate(void *, size_t, size_t, size_t, size_t, ref, unsigned);
extern ref CGBitmapContextCreateImage(ref);
extern void CGContextDrawImage(ref, rect, ref);
extern void CGColorSpaceRelease(ref), CGContextRelease(ref), CGImageRelease(ref);
extern const char *getprogname(void);
extern int strcmp(const char *, const char *);
extern void syslog(int, const char *, ...);

// CGImageAlphaNoneSkipLast, with either the default or 16-bit little-endian byte order.
enum { RGB_OPAQUE = 6, RGB555_LE_OPAQUE = 0x1006, BGRA_PREMULTIPLIED = 0x2002 };

static image_setter native_set_image, native_set_contents;
static ref cg_image, image_scale, image_orientation, image_with_cg_image, ui_image;
static unsigned long cg_image_type;

static ref copy_bgra_image(ref source)
{
    const size_t width = CGImageGetWidth(source), height = CGImageGetHeight(source);
    // Bound the temporary bitmap while allowing an original N90 camera image.
    if(!width || !height || (unsigned long long)width * height > (1u << 23)) return 0;
    ref space = CGColorSpaceCreateDeviceRGB();
    if(!space) return 0;
    ref bitmap = CGBitmapContextCreate(0, width, height, 8, width * 4, space, BGRA_PREMULTIPLIED);
    CGColorSpaceRelease(space);
    if(!bitmap) return 0;
    CGContextDrawImage(bitmap, (rect){ 0, 0, (float)width, (float)height }, source);
    ref image = CGBitmapContextCreateImage(bitmap);
    CGContextRelease(bitmap);
    return image;
}

static void set_photo_image(ref view, ref selector, ref image)
{
    ref source = objc_msgSend(image, cg_image), replacement = 0;
    if(source)
    {
        const unsigned info = CGImageGetBitmapInfo(source);
        if(info == RGB_OPAQUE || info == RGB555_LE_OPAQUE)
        {
            ref converted = copy_bgra_image(source);
            if(converted)
            {
                const float scale = ((float (*)(ref, ref))objc_msgSend)(image, image_scale);
                const unsigned orientation = ((unsigned (*)(ref, ref))objc_msgSend)(image, image_orientation);
                replacement = ((ref (*)(ref, ref, ref, float, unsigned))objc_msgSend)
                    (ui_image, image_with_cg_image, converted, scale, orientation);
                CGImageRelease(converted);
            }
        }
    }
    native_set_image(view, selector, replacement ? replacement : image);
}

static void set_photo_contents(ref layer, ref selector, ref contents)
{
    // The album grid can send its packed thumbnail directly to a layer.
    ref converted = contents && CFGetTypeID(contents) == cg_image_type &&
        CGImageGetBitmapInfo(contents) == RGB555_LE_OPAQUE ? copy_bgra_image(contents) : 0;
    native_set_contents(layer, selector, converted ? converted : contents);
    if(converted) CGImageRelease(converted);
}

void n90_install_photo_images(void)
{
    const char *program = getprogname();
    if(!program || strcmp(program, "MobileSlideShow")) return;
    ref photo_view = objc_getClass("PLImageView"), layer = objc_getClass("CALayer");
    ui_image = objc_getClass("UIImage");
    if(!photo_view || !layer || !ui_image) return;
    ref set_image = class_getInstanceMethod(photo_view, sel_registerName("setImage:"));
    ref set_contents = class_getInstanceMethod(layer, sel_registerName("setContents:"));
    if(!set_image || !set_contents) return;
    cg_image = sel_registerName("CGImage");
    image_scale = sel_registerName("scale");
    image_orientation = sel_registerName("imageOrientation");
    image_with_cg_image = sel_registerName("imageWithCGImage:scale:orientation:");
    cg_image_type = CGImageGetTypeID();
    native_set_image = method_setImplementation(set_image, set_photo_image);
    native_set_contents = method_setImplementation(set_contents, set_photo_contents);
    syslog(5, "V86 Photos bitmap adapter installed");
}
