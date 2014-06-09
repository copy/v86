#include <v8.h>
#include <node.h>
#include <node_buffer.h>
#include "SDL.h"
#include "SDL_ttf.h"

#include "helpers.h"
#include "struct_wrappers.h"

using namespace v8;
using namespace node;

namespace sdl {

    // Helper for formatting error exceptions
  Handle<Value> ThrowSDLException(const char* name) {
    return ThrowException(MakeSDLException(name));
  }

  Local<Value> MakeSDLException(const char* name) {
    return Exception::Error(String::Concat(
      String::Concat(String::New(name), String::New(": ")),
      String::New(SDL_GetError())
      ));
  }

  char* BufferData(Buffer *b) {
    return Buffer::Data(b->handle_);
  }

  size_t BufferLength(Buffer *b) {
    return Buffer::Length(b->handle_);
  }

  char* BufferData(Local<Object> buf_obj) {
    return Buffer::Data(buf_obj);
  }

  size_t BufferLength(Local<Object> buf_obj) {
    return Buffer::Length(buf_obj);
  }

  Local<Object> SDLEventToJavascriptObject(const SDL_Event& event) {
    Local<Object> evt = Object::New();

    switch (event.type) {
      case SDL_KEYDOWN:
      case SDL_KEYUP:
        evt->Set(String::New("type"), String::New(event.type == SDL_KEYDOWN ? "KEYDOWN" : "KEYUP"));
        evt->Set(String::New("scancode"), Number::New(event.key.keysym.scancode));
        evt->Set(String::New("sym"), Number::New(event.key.keysym.sym));
        evt->Set(String::New("mod"), Number::New(event.key.keysym.mod));
        evt->Set(String::New("repeat"), Boolean::New(event.key.repeat > 0 ? true : false));
      break;
      case SDL_MOUSEMOTION:
        evt->Set(String::New("type"), String::New("MOUSEMOTION"));
        evt->Set(String::New("state"), Number::New(event.motion.state));
        evt->Set(String::New("which"), Number::New(event.motion.which));
        evt->Set(String::New("x"), Number::New(event.motion.x));
        evt->Set(String::New("y"), Number::New(event.motion.y));
        evt->Set(String::New("xrel"), Number::New(event.motion.xrel));
        evt->Set(String::New("yrel"), Number::New(event.motion.yrel));
      break;
      case SDL_MOUSEBUTTONDOWN:
      case SDL_MOUSEBUTTONUP:
        evt->Set(String::New("type"), String::New(event.type == SDL_MOUSEBUTTONDOWN ? "MOUSEBUTTONDOWN" : "MOUSEBUTTONUP"));
        evt->Set(String::New("button"), Number::New(event.button.button));
        evt->Set(String::New("which"), Number::New(event.button.which));
        evt->Set(String::New("x"), Number::New(event.button.x));
        evt->Set(String::New("y"), Number::New(event.button.y));
      break;
      case SDL_JOYAXISMOTION:
        evt->Set(String::New("type"), String::New("JOYAXISMOTION"));
        evt->Set(String::New("which"), Number::New(event.jaxis.which));
        evt->Set(String::New("axis"), Number::New(event.jaxis.axis));
        evt->Set(String::New("value"), Number::New(event.jaxis.value));
      break;
      case SDL_JOYBALLMOTION:
        evt->Set(String::New("type"), String::New("JOYBALLMOTION"));
        evt->Set(String::New("which"), Number::New(event.jball.which));
        evt->Set(String::New("ball"), Number::New(event.jball.ball));
        evt->Set(String::New("xrel"), Number::New(event.jball.xrel));
        evt->Set(String::New("yrel"), Number::New(event.jball.yrel));
      break;
      case SDL_JOYHATMOTION:
        evt->Set(String::New("type"), String::New("JOYHATMOTION"));
        evt->Set(String::New("which"), Number::New(event.jhat.which));
        evt->Set(String::New("hat"), Number::New(event.jhat.hat));
        evt->Set(String::New("value"), Number::New(event.jhat.value));
      break;
      case SDL_JOYBUTTONDOWN:
      case SDL_JOYBUTTONUP:
        evt->Set(String::New("type"), String::New(event.type == SDL_JOYBUTTONDOWN ? "JOYBUTTONDOWN" : "JOYBUTTONUP"));
        evt->Set(String::New("which"), Number::New(event.jbutton.which));
        evt->Set(String::New("button"), Number::New(event.jbutton.button));
      break;
      case SDL_QUIT:
        evt->Set(String::New("type"), String::New("QUIT"));
      break;
      default:
        evt->Set(String::New("type"), String::New("UNKNOWN"));
        evt->Set(String::New("typeCode"), Number::New(event.type));
      break;
    }

    return evt;
  }

  Local<Object> SDLDisplayModeToJavascriptObject(const SDL_DisplayMode& mode) {
    Local<Object> jsMode = Object::New();
    jsMode->Set(String::New("format"), Number::New(mode.format));
    jsMode->Set(String::New("w"), Number::New(mode.w));
    jsMode->Set(String::New("h"), Number::New(mode.h));
    jsMode->Set(String::New("refreshRate"), Number::New(mode.refresh_rate));
    return jsMode;
  }

} // node_sdl
