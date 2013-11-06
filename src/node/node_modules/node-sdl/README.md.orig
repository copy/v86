# node-sdl ( Simple DirectMedia Layer bindings for node.js )

## 0. Installation

Installation of the node-sdl package is straight-forward: first clone the
package using git, then build the C++ portion of the package with the
node-waf command.

This package depends on the SDL libraries being present on the target system.
The following command was required to install these libraries on a "stock"
Ubuntu 11.04 install:

<pre>    sudo apt-get install libsdl1.2-dev libsdl-image1.2-dev libsdl-ttf2.0-dev</pre>

Now that your library dependencies are satisfied, check out the source from
github:

<pre>    git clone https://github.com/creationix/node-sdl.git</pre>

Second, build the package:

<pre>    cd node-sdl
    node-waf configure build</pre>

You can test if the package was properly built by running one or more of the
example programs:

<pre>    cd examples
    node img.js</pre>

## 1. Usage

### 1.1. Initialization and Shutdown

Begin by requiring the node-sdl package and calling the init() function:

<pre>    var SDL = require( 'sdl' );
    SDL.init( SDL.INIT.VIDEO )</pre>

The init() function takes a numeric parameter telling the library what
subsystems to initialize. The node-sdl package defines the following
constants:

<pre>    SDL.INIT.TIMER - initializes timers (not currently supported)
    SDL.INIT.AUDIO - initialize audio subsystem (not currently supported)
    SDL.INIT.VIDEO - initialize video subsystem
    SDL.INIT.CDROM - initialize CD playback subsystem (not currently supported)
    SDL.INIT.JOYSTICK - initialize joystick support
    SDL.INIT.EVERYTHING - all of the above
    SDL.INIT.NOPARACHUTE - don't catch fatal signals
</pre>

Two or more of these parameters may be selected by or-ing them together:

<pre>    SDL.init( SDL.INIT.VIDEO | SDL.INIT.JOYSTICK );</pre>

The QUIT event signals the closure of a SDL managed window, so adding a
function that exits the application when it is received may be useful:

<pre>    SDL.events.on( 'QUIT', function( evt ) { process.exit( 0 ); } );</pre>

Exiting the application when the user presses Control-C or the Escape key
can be achieved by adding a listener to the KEYDOWN event:

<pre>    SDL.events.on( 'KEYDOWN', function ( evt ) {
      if( ( ( evt.sym === 99 ) && ( evt.mod === 64 ) ) ||
          ( ( evt.sym === 27 ) && ( evt.mod === 0  ) ) ) {
        process.exit( 0 );
      }
    } );</pre>

### 1.2. Video Functions

To create a window under SDL control, use the setVideoMode() function to 
create a "surface".

<pre>    var screen = SDL.setVideoMode( 640, 480, 32, SDL.SURFACE.SWSURFACE );</pre>

The setVideoMode() function takes four parameters: surface width, surface
height, bit depth and surface flags. The flags parameter selects options for
the video buffer:

<pre>    SDL.SURFACE.SWSURFACE - video buffer created in system memory
    SDL.SURFACE.HWSURFACE - video buffer created in video memory
    SDL.SURFACE.ASYNCBLIT - enable async updates of display surface
    SDL.SURFACE.ANYFORMAT - don't emulate unavailable BPPs with a shadow surface
    SDL.SURFACE.HWPALETTE - give SDL exclusive palette access (not supported)
    SDL.SURFACE.DOUBLEBUF - enable hardware double buffering. (only works with
                            SDL.SURFACE.HWSURFACE)
    SDL.SURFACE.FULLSCREEN - use fullscreen mode
    SDL.SURFACE.OPENGL    - create an OpenGL rendering context (not supported)
    SDL.SURFACE.RESIZABLE - create a resizable window
    SDL.SURFACE.HWACCEL   - use hardware accelerated blitter
    SDL.SURFACE.SRCCOLORKEY - use color key blitter
    SDL.SURFACE.RLEACCEL  - color key blitting is accelerated with RLE
    SDL.SURFACE.SRCALPHA  - surface blit uses alpha blending
    SDL.SURFACE.PREALLOC  - surface uses preallocated memory
</pre>

Like other numeric constants, they may be combined with the or operator:

<pre>    var screen = SDL.setVideoMode( 640, 480, 32, SDL.SURFACE.HWSURFACE | SDL.SURFACE.HWACCEL );</pre>

The surface created with the setVideoMode() call represents the contents of
the displayed window. It's common practice to create a buffer surface to hold
video contents in preparation for drawing on the screen. To create a buffer,
use the createRGBSurface() call.

<pre>    var surface = SDL.createRGBSurface( SDL.SURFACE.SWSURFACE, 24, 24 );</pre>

The first parameter describes the type of surface to create, and the remaining
parameters are x and y sizes.

After you're done using a surface, you *should* free it. The freeSurface()
function takes a surface (like one returned from the createRGBSurface()
function above) and frees memory associated with it:

<pre>    SDL.freeSurface( surface );</pre>

The displayFormat() function copies a surface into a new surface suitable
for blitting into the frame buffer. It takes a surface as it's first (and only)
parameter and returns a new surface conformable with the system's frame buffer.
This call is extremely useful in conjunction with the SDL.IMG.load() call:

<pre>    var tempSheet = SDL.IMG.load( __dirname + "/sprites.png" );
var sheet = SDL.displayFormat( tempSheet );
SDL.freeSurface( tempSheet );</pre>

SDL surfaces may have an Alpha value associated with them. This is a value from
0 to 255 and sets the transparency of the surface's contents when blitted into
another surface (like the frame buffer).

<pre>    SDL.setAlpha( sheet, SDL.SURFACE.SRCALPHA | SRC.SURFACE.RLEACCEL, 192 );</pre>

Options to the setAlpha() function include:

<pre>    SDL.SURFACE.SRCALPHA - specifies that alpha blending should be used
    SLD.SURFACE.RLEACCEL - specifies that RLE acceleration should be used for blitting</pre>

You can set a specific color to be transparent (i.e. - the color key) using the
setColorKey() function. After setting this value, when the surface's contents
are blitted to another surface, pixels with the color key value won't be copied.

<pre>    SDL.setColorKey( sheet, SDL.SURFACE.SRCCOLORKEY, 0x01010100 );</pre>

The first parameter is the surface whose color key you're setting. The second
is a set of flags that may be or'd together. The third is a 32 bit integer
representing the value of the color key you want to use. Values for the flags
include:

<pre>    SDL.SURFACE.SRCCOLORKEY - means you're setting the surface's color key
    SDL.SURFACE.RLEACCEL    - you want to enable RLE accleration
    0                       - means you want to clear the surface's color key
</pre>

It can sometimes be tricky to get the precise color key value if you're using
multiple surface geometries. Fortunately, you can use the mapRGB() function
to return a color value, modified to account for a surface's color geometry.
In other words, do this when you want to set the color key:

<pre>    var colorKey = [ 255, 0, 0 ]; // setting the color key to red
    SDL.setColorKey( sheet,
                     SDL.SURFACE.SRCCOLORKEY | SDL.SURFACE.RLEACCEL,
                     SDL.mapRGB( sheet.format,
                                 colorKey[0],
                                 colorKey[1],
                                 colorKey[2] ) );</pre>

To fill a rectangle with a particular color, use the fillRect() function.

<pre>    SDL.fillRect( surface, [0, 0, 24, 24], 0xFF8080AF );</pre>

To blit (copy) a portion of one surface into anotehr, use the blitSurface()
function. It takes as it's parameters: the source surface, a rectangle
describing the origin and extent of the pixels to be copied, the destination
surface, and a point in the destination you're copying pixels to.

So the following example copies an 8x16 rectangle from position (10,25) in the
spriteSource surface into position (128,15) in the screen surface:

<pre>    SDL.blitSurface( spriteSource, [10, 25, 8, 16], screen, [128, 15] );</pre>

After making changes to a surface, you use the flip() function to instruct
the system to make the changes apparent. In systems that support hardware
double-buffering, this call "does the right thing" and waits for a vertical
retrace to flip between video screens. On systems with a software surface, it
simply makes sure that the contents of the surface are made visible.

It's very useful to call this command after you make updates to the screen. For
example:

<pre>    var screen = SDL.setVideoMode( 640, 480, 32, SDL.SURFACE.SWSURFACE );
    SDL.fillRect( surface, [0, 0, 24, 24], 0xFF8080AF );
    SDL.flip( screen );
</pre>

### 1.3. Image Related Functions

This package uses a supplimentary image library intended to make it easy for
node-sdl applications to load and use JPG, PNG or TIFF images. Before using
Image functions, you should initalize them with the image init() function:

<pre>    SDL.IMG.init( 0 );</pre>

To load an image into memory, use the image load() function. It takes a file
path as a parameter and returns a reference to it. The following line loads
a PNG file called "foo.png" into the variable foo.

<pre>    var foo = SDL.IMG.load( __dirname + '/foo.png' );</pre>

The foo variable can now be used as a surface blit calls (see below.)

After you are finished using the image functions, be sure to use the image
quit() function:

<pre>    SDL.IMG.quit();</pre>

### 1.4. Joystick Functions

If you are developing an application that uses joysticks, you'll need to pass
the SDL.INIT.JOYSTICK option along to the SDL.init() call:

<pre>    SDL.init( SDL.INIT.VIDEO | SDL.INIT.JOYSTICK );</pre>

Now that your app knows you want to use joysticks, you can detect the number of
joysticks present with the numJoysticks() function. The following code checks
to see if there's at least one joystick and complains if there's not:

<pre>    var numPlayers = SDL.numJoysticks();
    if( numPlayers &lt; 1 ) {
        console.log( 'Blargh! At least one joystick is required!' );
        process.exit( 2 );
    }</pre>

On systems with multiple joysticks, it might be useful to offer a player a
selection of which joystick to use. The system assigns a human readable name
for a joystick which the app can query with the joystickName() function. The
following code prints out the name of each joystick:

<pre>    SDL.init( SDL.INIT.VIDEO | SDL.INIT.JOYSTICK );
    var stickCount = SDL.numJoysticks();

    for( var i = 0; i &lt; stickCount; i ++ ) {
        console.log( 'joystick ' + i + ': ' + SDL.joystickName( i ) );
    }

    // etc</pre>

Now you must explicitly open each joystick you want to receive inputs from. Do
this with the joystickOpen() function. This function takes an integer as a
parameter and represents the index of the joystick you want to open. Here is
some code that opens joystick number zero:

<pre>    SDL.joystickOpen( 0 );</pre>

After the joystick is opened, it will start to generate events. You can register
event handlers with the SDL.events.on() function. Joystick related events are
described in the events section below.

### 1.5. Window Manager Functions

node-sdl is capable of setting window manager related info with the SDL.WM.*
functions.

To set the title of a SDL window, use the setCaption() function. This fragment
sets the window's title to "Window Title" and (if supported by your window
manager) sets the name of the minimized icon to "Icon Title"

<pre>    SDL.WM.setCaption( 'Window Title', 'Icon Title' );</pre>

To set the application's icon, use the setIcon() function. It expects an image
to be passed as it's parameter, so it's common practice to use the image load()
function. The following example loads an icon from the file 'eight.png' and
uses it as the app's icon:

<pre>    SDL.WM.setIcon( SDL.IMG.load( __dirname + '/eight.png' ) );</pre>

## 2. Events

node-sdl uses javascript events to communicate certain conditions. The
events.on() function is used to set handlers for these events. Event handlers
are passed an object describing the event as a parameter.

### 2.1. Quit

As described above, the QUIT event is called when the user closes a SDL window.
The proper response is to free buffers, and exit:

<pre>    SDL.events.on( 'QUIT', function ( evt ) {
        SDL.IMG.quit();
       process.exit( 0 );
    } );</pre>

### 2.2. KEYDOWN & KEYUP

The KEYDOWN and KEYUP events signal the app that the user has pressed (or
released) a key. The event passed to the handler includes the following
properties:

<pre>    scancode - the scancode of the key pressed
    sym      - the symbol of the key pressed
    mod      - key modifier</pre>

Key scancodes are hardware and locale dependent; it's recommended they be
left alone unless you really are targeting a specific piece of hardware. Key
symbols are numbers representing keyboard glyphs. Key modifiers represent
shift, meta, alt and control keys. As you might expect, it's possible for
multiple modifiers to be pressed simultaneously, so the mod value is a bit
field with the following definitions:

<pre>
0x0000 - No modifiers pressed
0x0001 - Left Shift
0x0002 - Right Shift
0x0040 - Left Control Key
0x0080 - Right Control Key
0x0100 - Left Alt Key
0x0200 - Right Alt Key
0x0400 - Left Meta Key (for hardware that has a meta key)
0x0800 - Right Meta Key (for hardware that has a meta key)
0x1000 - Num Lock on
0x2000 - Caps Lock on
0x4000 - Mode Key Pressed (bonus points if you can find hardware with a mode key)
</pre>

It should probably be noted that SDL keysyms are not exactly ASCII. Most
importantly, the system will not return a capital letter ASCII code when the
user hits a letter key and the shift key. Instead, you must manually check
for the shift key being pressed, check the modifier bits and adjust the key
code accordingly.

The following code converts the modifier and symbol to an ascii value:

<pre>    SDL.events.on( 'KEYDOWN', function( evt ) {
        var ascii = evt.sym;
        
        if( ( ascii &lt; 123 ) && ( ascii &gt; 96 ) ) {
            if( 0 != ( evt.mod && 0x2003 ) ) {
                ascii -= 32;
            }
        }
    
        console.log( 'ascii: ' + ascii );
    } );</pre>

### 2.3. MOUSEMOTION

When the user moves a mouse over an SDL screen, the system will generate
MOUSEMOTION events. If you create a handler for these events, every time the
mouse moves, you'll receive an event with the following properties:

<pre>    state - button state (as described above)
    x     - x position of the mouse pointer
    y     - y position of the mouse pointer
    xrel  - relative motion of the mouse pointer along the x axis
    yrel  - relative motion of the mouse pointer along the y axis</pre>

The button state is a bit field with the following values:

<pre>    0x0000 - no mouse button pressed
    0x0001 - left mouse button pressed
    0x0002 - middle mouse button pressed
    0x0004 - right mouse button pressed</pre>

Take mouse chords with a grain of salt, some systems may be configured to 
emulate a 3 button mouse. In these systems, pressing the left and right button
together will generate a middle button press (code 0x0002) instead of the
mouse chord you might be expecting (code 0x0005).

### 2.4. MOUSEBUTTONDOWN & MOUSEBUTTONUP

The MOUSEBUTTONUP and MOUSEBUTTONDOWN events report more data and have
slightly different semantics than the button state in the MOUSEMOTION event.
Handlers for these events are passed an object with the following properties:

<pre>    button - mouse button clicked
    x      - x position of the mouse
    y      - y position of the mouse</pre>

The button property IS NOT a bit field, but an integer. Instead of detecting
mouse chords, it reports multiple button clicks. Here is the list of mouse
buttons supported:

<pre>    1 - left button
    2 - middle button
    3 - right button
    4 - scroll wheel up
    5 - scroll wheel down</pre>

### 2.5. JOYAXISMOTION (Joystick Axis Motion)

The JOYAXISMOTION event reports movement of the joystick device along one of
its axes. Handlers for this event are passed an object with the following
properties:

<pre>    which - which joystick generated the event
    axis  - which axis (x or y) the event is reporting movement upon
    value - a value from -32768 to 32767 describing the logical position of the joystick</pre>

### 2.6. JOYBALLMOTION (Joystick Trackball Motion)

If a user's joystick is equipped with a trackball, it may generate these events
when motion along the trackball is detected. Handlers assigned to listen for
these events will receive an object with the following properties:

<pre>    which - which joystick generated the event
    ball  - which trackball generated the event
    xrel  - relative trackball motion along the x axis
    yrel  - relative trackball motion along the y axis</pre>

### 2.7. JOYHATMOTION (Joystick Hat Motion)

If a user's joystick is equipped with a hat, it may generate these events when
hat motion is detected. Handlers for this event will be passed an object with
the following properties:

<pre>    which - which joystick generated the event
    hat   - which hat on the joystick generated the event
    value - the position of the hat</pre>

### 2.8. JOYBUTTONDOWN & JOYBUTTONUP

If a user's joystick is equipped with buttons, it may generate these events when
a button press is detected. Handlers for these events will be passed an object
with the following properties:

<pre>    which  - which joystick generated the event
    button - which button was pressed</pre>

