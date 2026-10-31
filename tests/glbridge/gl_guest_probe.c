/* CRT-free XP probe. The acceptance CD carries the current proxy beside it.
 * It checks the guest DLL/driver/worker before a real game is launched. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <GL/gl.h>

static void report(const char* text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL);
}
static int failed;
#define CHECK(condition, message) do { if (!(condition)) { report("FAIL " message "\r\n"); failed = 1; goto done; } } while (0)
static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM w, LPARAM l) {
    return DefWindowProcA(window, message, w, l);
}
static LRESULT CALLBACK application_subclass(HWND window,UINT message,WPARAM w,LPARAM l){return window_proc(window,message,w,l);}
void WINAPI entry(void) {
    WNDCLASSA wc; PIXELFORMATDESCRIPTOR pfd; HWND window; HDC dc; HGLRC context = NULL;
    GLuint vertex, fragment, program,pbo; GLint status;HFONT font=NULL,old_font=NULL;GLYPHMETRICS metrics;static BYTE glyph[4096],pixels[4096];const MAT2 identity={{0,1},{0,0},{0,0},{0,1}};DWORD glyph_size; static char line[4096]; GLenum error;
    const char* vs = "#version 120\nvoid main(){gl_Position=gl_Vertex;gl_FrontColor=gl_Color;}";
    const char* fs = "#version 120\nvoid main(){gl_FragColor=gl_Color;}";
    GLuint (APIENTRY *create_shader)(GLenum);
    void (APIENTRY *shader_source)(GLuint,GLsizei,const char**,const GLint*);
    void (APIENTRY *compile_shader)(GLuint);
    void (APIENTRY *shader_iv)(GLuint,GLenum,GLint*);
    GLuint (APIENTRY *create_program)(void);
    void (APIENTRY *attach_shader)(GLuint,GLuint);
    void (APIENTRY *link_program)(GLuint);
    void (APIENTRY *program_iv)(GLuint,GLenum,GLint*);
    void (APIENTRY *use_program)(GLuint);
    void (APIENTRY *gen_buffers)(GLsizei,GLuint*);void (APIENTRY *bind_buffer)(GLenum,GLuint);void (APIENTRY *buffer_data)(GLenum,int,const void*,GLenum);
    ZeroMemory(&wc,sizeof(wc)); wc.lpfnWndProc=window_proc; wc.hInstance=GetModuleHandleA(NULL); wc.lpszClassName="GLGuestProbe";
    CHECK(RegisterClassA(&wc), "RegisterClass");
    window=CreateWindowA(wc.lpszClassName,"CPU GL worker acceptance probe",WS_OVERLAPPEDWINDOW|WS_VISIBLE,30,30,320,240,NULL,NULL,wc.hInstance,NULL);
    CHECK(window, "CreateWindow"); dc=GetDC(window);
    ZeroMemory(&pfd,sizeof(pfd)); pfd.nSize=sizeof(pfd);pfd.nVersion=1;pfd.dwFlags=PFD_DRAW_TO_WINDOW|PFD_SUPPORT_OPENGL|PFD_DOUBLEBUFFER;pfd.iPixelType=PFD_TYPE_RGBA;pfd.cColorBits=32;pfd.cDepthBits=24;pfd.cStencilBits=8;
    CHECK(SetPixelFormat(dc,ChoosePixelFormat(dc,&pfd),&pfd), "SetPixelFormat");
    context=wglCreateContext(dc); CHECK(context && wglMakeCurrent(dc,context), "MakeCurrent");
    CHECK((WNDPROC)(ULONG_PTR)GetWindowLongA(window,GWL_WNDPROC)==window_proc,"window procedure modified");
    CHECK(glGetString(GL_VERSION), "GetString");
    wsprintfA(line,"GL_VERSION=%s\r\nGL_VENDOR=%s\r\n",glGetString(GL_VERSION),glGetString(GL_VENDOR));report(line);
    CHECK(lstrcmpA((const char*)glGetString(GL_VENDOR),"VMware, Inc.")==0,"wrong DLL vendor");
    CHECK(lstrcmpA((const char*)glGetString(GL_VERSION),"2.1 v86gl (WebGPU)")==0,"old DLL version");
#define LOAD(variable, name) do { *(PROC*)&variable=wglGetProcAddress(name);CHECK(variable,name); } while (0)
    LOAD(create_shader,"glCreateShader"); LOAD(shader_source,"glShaderSource"); LOAD(compile_shader,"glCompileShader"); LOAD(shader_iv,"glGetShaderiv");
    LOAD(create_program,"glCreateProgram"); LOAD(attach_shader,"glAttachShader");LOAD(link_program,"glLinkProgram");LOAD(program_iv,"glGetProgramiv");LOAD(use_program,"glUseProgram");
    vertex=create_shader(0x8B31);shader_source(vertex,1,&vs,NULL);compile_shader(vertex);shader_iv(vertex,0x8B81,&status);CHECK(status,"vertex compile");
    fragment=create_shader(0x8B30);shader_source(fragment,1,&fs,NULL);compile_shader(fragment);shader_iv(fragment,0x8B81,&status);CHECK(status,"fragment compile");
    program=create_program();attach_shader(program,vertex);attach_shader(program,fragment);link_program(program);program_iv(program,0x8B82,&status);CHECK(status,"program link");use_program(program);
    glViewport(0,0,300,200);glClearColor(0.1f,0.2f,0.3f,1);glClear(GL_COLOR_BUFFER_BIT);
    glBegin(GL_TRIANGLES);glColor3f(1,0,0);glVertex2f(-0.8f,-0.8f);glColor3f(0,1,0);glVertex2f(0.8f,-0.8f);glColor3f(0,0,1);glVertex2f(0,0.8f);glEnd();SwapBuffers(dc);glFinish();
    error=glGetError();wsprintfA(line,"GL_ERROR=%lu\r\n",(unsigned long)error);report(line);CHECK(error==GL_NO_ERROR,"GL error");
    use_program(0);font=CreateFontW(-24,0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_TT_PRECIS,CLIP_DEFAULT_PRECIS,NONANTIALIASED_QUALITY,DEFAULT_PITCH,L"Arial");CHECK(font,"CreateFont");old_font=SelectObject(dc,font);
    glyph_size=GetGlyphOutlineW(dc,0x3A9,GGO_BITMAP,&metrics,sizeof(glyph),glyph,&identity);CHECK(glyph_size!=GDI_ERROR&&glyph_size<=sizeof(glyph)&&metrics.gmBlackBoxX>0&&metrics.gmBlackBoxX<=32&&metrics.gmBlackBoxY>0&&metrics.gmBlackBoxY<=32,"GDI Unicode reference");
    LOAD(gen_buffers,"glGenBuffers");LOAD(bind_buffer,"glBindBuffer");LOAD(buffer_data,"glBufferData");gen_buffers(1,&pbo);bind_buffer(0x88EC,pbo);buffer_data(0x88EC,128,NULL,0x88E4);
    glPixelStorei(GL_UNPACK_ALIGNMENT,1);glPixelStorei(GL_UNPACK_LSB_FIRST,1);glPixelStorei(GL_UNPACK_ROW_LENGTH,17);glPixelStorei(GL_UNPACK_SKIP_ROWS,1);glPixelStorei(GL_UNPACK_SKIP_PIXELS,1);
    CHECK(wglUseFontBitmapsW(dc,0x3A9,1,700),"Unicode font bitmap");glGetIntegerv(0x88EF,&status);CHECK(status==(GLint)pbo,"font restored unpack PBO");glGetIntegerv(GL_UNPACK_ROW_LENGTH,&status);CHECK(status==17,"font restored unpack rows");
    glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glColor3f(1,1,1);glRasterPos2i(0,0);glCallList(700);glPixelStorei(GL_PACK_ALIGNMENT,1);
    glReadPixels(150+metrics.gmptGlyphOrigin.x,100+metrics.gmptGlyphOrigin.y-(GLint)metrics.gmBlackBoxY,metrics.gmBlackBoxX,metrics.gmBlackBoxY,GL_RGB,GL_UNSIGNED_BYTE,pixels);
    for(DWORD y=0;y<metrics.gmBlackBoxY;y++)for(DWORD x=0;x<metrics.gmBlackBoxX;x++){DWORD stride=((metrics.gmBlackBoxX+31)/32)*4;BYTE expected=(glyph[(metrics.gmBlackBoxY-1-y)*stride+x/8]&(0x80>>(x&7)))?255:0;for(DWORD c=0;c<3;c++)CHECK(pixels[(y*metrics.gmBlackBoxX+x)*3+c]==expected,"Unicode font exact GDI pixels");}
    CHECK(glGetError()==GL_NO_ERROR,"font GL error");report("GL_FONT_BITMAP_PASS\r\n");SelectObject(dc,old_font);old_font=NULL;DeleteObject(font);font=NULL;
    CHECK((WNDPROC)(ULONG_PTR)SetWindowLongA(window,GWL_WNDPROC,(LONG)(ULONG_PTR)application_subclass)==window_proc,"application subclass predecessor");CHECK(wglMakeCurrent(NULL,NULL)&&wglDeleteContext(context),"context teardown");context=NULL;
    CHECK((WNDPROC)(ULONG_PTR)GetWindowLongA(window,GWL_WNDPROC)==application_subclass,"application subclass removed");report("GL_WINDOW_CHAIN_PASS\r\n");
    report("GL_GUEST_PROBE_PASS\r\n");
    Sleep(2000);
done:
    if(old_font) {SelectObject(dc,old_font);}
    if(font) {DeleteObject(font);}
    if(context) {wglMakeCurrent(NULL,NULL);wglDeleteContext(context);}
    ExitProcess(failed?1:0);
}
