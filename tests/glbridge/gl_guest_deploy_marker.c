/* A successful deployment reaches this process only after all copies/probes.
 * Its Unicode 17x19 window and green swap are observed by the browser harness. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <GL/gl.h>
static LRESULT CALLBACK proc(HWND hwnd,UINT message,WPARAM w,LPARAM l){return DefWindowProcW(hwnd,message,w,l);}
void WINAPI entry(void){
 WNDCLASSW wc;PIXELFORMATDESCRIPTOR pfd;ZeroMemory(&wc,sizeof(wc));wc.lpfnWndProc=proc;wc.hInstance=GetModuleHandleW(NULL);wc.lpszClassName=L"GLF6Deployment";if(!RegisterClassW(&wc))ExitProcess(1);
 HWND window=CreateWindowW(wc.lpszClassName,L"F6 verified",WS_POPUP|WS_VISIBLE,10,10,17,19,NULL,NULL,wc.hInstance,NULL);if(!window)ExitProcess(2);HDC dc=GetDC(window);ZeroMemory(&pfd,sizeof(pfd));pfd.nSize=sizeof(pfd);pfd.nVersion=1;pfd.dwFlags=PFD_DRAW_TO_WINDOW|PFD_SUPPORT_OPENGL|PFD_DOUBLEBUFFER;pfd.iPixelType=PFD_TYPE_RGBA;pfd.cColorBits=24;
 if(!SetPixelFormat(dc,ChoosePixelFormat(dc,&pfd),&pfd)){ExitProcess(3);}
 HGLRC context=wglCreateContext(dc);if(!context||!wglMakeCurrent(dc,context))ExitProcess(4);
 const GLubyte* version=glGetString(GL_VERSION);if(!version||lstrcmpA((const char*)version,"2.1 v86gl (WebGPU)"))ExitProcess(5);
 glViewport(0,0,17,19);glClearColor(0,1,0,1);glClear(GL_COLOR_BUFFER_BIT);if(!SwapBuffers(dc)||glGetError())ExitProcess(6);Sleep(1000);wglMakeCurrent(NULL,NULL);wglDeleteContext(context);ExitProcess(0);
}
