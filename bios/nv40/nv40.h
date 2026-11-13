// v86 NV40 SeaVGABIOS backend. SPDX-License-Identifier: LGPL-3.0-or-later
#ifndef V86_NV40_H
#define V86_NV40_H
#include "types.h"
struct vgamode_s;
struct vgamode_s *nv40_find_mode(int mode);
void nv40_list_modes(u16 seg,u16 *dest,u16 *last);
int nv40_setup(void);
int nv40_set_mode(struct vgamode_s *mode,int flags);
int nv40_get_window(struct vgamode_s *mode,int window);
int nv40_set_window(struct vgamode_s *mode,int window,int val);
int nv40_get_linelength(struct vgamode_s *mode);
int nv40_set_linelength(struct vgamode_s *mode,int val);
int nv40_get_displaystart(struct vgamode_s *mode);
int nv40_set_displaystart(struct vgamode_s *mode,int val);
int nv40_get_dacformat(struct vgamode_s *mode);
int nv40_set_dacformat(struct vgamode_s *mode,int val);
int nv40_save_restore(int cmd,u16 seg,void *data);
#endif
