/*
 * Copyright (C) 2006 Vitaliy Margolen
 * Copyright (C) 2006 Chris Robinson
 * Copyright (C) 2006 Louis Lenders
 * Copyright 2006-2007 Henri Verbeet
 * Copyright 2006-2007, 2011-2013 Stefan Dösinger for CodeWeavers
 * Copyright 2013 Henri Verbeet for CodeWeavers
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301, USA
 */

/* Independent XP User32 foreground launch reference; no Direct3D API/imports.
 * flush_events is copied unchanged from pinned Wine d3d8_device.c (LGPL-2.1+),
 * Copyright 2006-2007 Henri Verbeet et al.; see vendored source for license.
 * The two-window/thread sequence precedes CreateDevice in its test_wndproc. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>
static void flush_events(void)
{
    MSG msg;
    int diff = 200;
    int min_timeout = 100;
    DWORD time = GetTickCount() + diff;
    while (diff > 0)
    {
        if (MsgWaitForMultipleObjects( 0, NULL, FALSE, min_timeout, QS_ALLINPUT ) == WAIT_TIMEOUT) break;
        while (PeekMessageA(&msg, 0, 0, 0, PM_REMOVE)) DispatchMessageA(&msg);
        diff = time - GetTickCount();
    }
}
static HWND dummy;
static HANDLE created,finished;
static DWORD WINAPI window_thread(void *unused)
{
    (void)unused;
    dummy=CreateWindowA("static","d3d9_test",WS_VISIBLE|WS_CAPTION,100,100,200,200,0,0,0,0);
    flush_events();SetEvent(created);
    for(;;){MSG m;while(PeekMessageA(&m,0,0,0,PM_REMOVE))DispatchMessageA(&m);if(WaitForSingleObject(finished,100)==WAIT_OBJECT_0)break;}
    DestroyWindow(dummy);return 0;
}
static void identity(const char *phase)
{
    HWND foreground=GetForegroundWindow();DWORD process=0;DWORD thread=GetWindowThreadProcessId(foreground,&process);char name[128]={0},klass[128]={0};
    GetWindowTextA(foreground,name,sizeof(name));GetClassNameA(foreground,klass,sizeof(klass));
    printf("FOREGROUND phase=%s hwnd=%p thread=%lu process=%lu self=%lu class=%s title=%s console=%p\n",phase,foreground,thread,process,GetCurrentProcessId(),klass,name,GetConsoleWindow());
}
int main(int argc,char **argv)
{
    setvbuf(stdout,NULL,_IONBF,0);identity("entry");
    if(argc==2&&!strcmp(argv[1],"--background")){SetForegroundWindow(GetShellWindow());flush_events();identity("background");}
    WNDCLASSA wc={0};wc.lpfnWndProc=DefWindowProcA;wc.lpszClassName="wine_foreground_control";if(!RegisterClassA(&wc))return 2;
    HWND a=CreateWindowA(wc.lpszClassName,"focus_test",WS_MAXIMIZE|WS_VISIBLE|WS_CAPTION,0,0,800,600,0,0,0,0);
    HWND b=CreateWindowA(wc.lpszClassName,"device_test",WS_MAXIMIZE|WS_VISIBLE|WS_CAPTION,0,0,800,600,0,0,0,0);flush_events();
    created=CreateEventA(NULL,FALSE,FALSE,NULL);finished=CreateEventA(NULL,FALSE,FALSE,NULL);DWORD id;HANDLE thread=CreateThread(NULL,0,window_thread,NULL,0,&id);if(!thread||WaitForSingleObject(created,10000)!=WAIT_OBJECT_0)return 3;flush_events();
    HWND focus=GetFocus(),foreground=GetForegroundWindow();identity("before-device");
    printf("CHECK focus=%p expected_focus=%p foreground=%p expected_foreground=%p failures=%u\n",focus,(void*)NULL,foreground,dummy,(focus!=NULL)+(foreground!=dummy));
    SetEvent(finished);WaitForSingleObject(thread,10000);CloseHandle(thread);CloseHandle(created);CloseHandle(finished);DestroyWindow(b);DestroyWindow(a);
    printf("COMPLETE User32 foreground reference\n");return 0;
}
