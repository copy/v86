// v86 NV40 VGA/VBE backend. SPDX-License-Identifier: LGPL-3.0-or-later
// Original implementation of NV register layouts documented by envytools and
// Nouveau. Uses SeaVGABIOS's mode descriptors and legacy VGA helper functions.
#include "biosvar.h"
#include "hw/pci.h"
#include "hw/pci_regs.h"
#include "nv40.h"
#include "std/vbe.h"
#include "stdvga.h"
#include "string.h"
#include "svgamodes.h"
#include "vgabios.h"
#include "vgautil.h"
#include "x86.h"

static u8 cr(u8 at) { return stdvga_crtc_read(0x3d4,at); }
static void cw(u8 at,u8 val) { stdvga_crtc_write(0x3d4,at,val); }
static u32 nr(u32 at)
{
    u8 unlocked=cr(0x1f);cw(0x1f,0x57);
    u8 saved=cr(0x38);cw(0x38,3);outl(at,0x3d0);cw(0x38,5);
    u32 value=inl(0x3d0);cw(0x38,saved);if(!unlocked)cw(0x1f,0x99);return value;
}
static void nw(u32 at,u32 value)
{
    u8 unlocked=cr(0x1f);cw(0x1f,0x57);
    u8 saved=cr(0x38);cw(0x38,3);outl(at,0x3d0);cw(0x38,7);outl(value,0x3d0);cw(0x38,saved);if(!unlocked)cw(0x1f,0x99);
}
static int extended(struct vgamode_s *mode)
{
    return mode>=&svga_modes[0].info && mode<=&svga_modes[GET_GLOBAL(svga_mcount)-1].info;
}
static int valid(struct vgamode_s *mode)
{
    int depth=GET_GLOBAL(mode->depth), width=GET_GLOBAL(mode->width), height=GET_GLOBAL(mode->height);
    return (depth==8 || depth==15 || depth==16 || depth==32) &&
        (width==640 && height==480 || width==800 && height==600 || width==1024 && height==768 || width==1280 && height==1024);
}
struct vgamode_s *nv40_find_mode(int mode)
{
    unsigned int i;
    for(i=0;i<GET_GLOBAL(svga_mcount);i++)
        if(GET_GLOBAL(svga_modes[i].mode)==mode && valid(&svga_modes[i].info)) return &svga_modes[i].info;
    return stdvga_find_mode(mode);
}
void nv40_list_modes(u16 seg,u16 *dest,u16 *last)
{
    unsigned int i;
    for(i=0;i<GET_GLOBAL(svga_mcount) && dest<last;i++)
        if(valid(&svga_modes[i].info)) { SET_FARVAR(seg,*dest,GET_GLOBAL(svga_modes[i].mode));dest++; }
    stdvga_list_modes(seg,dest,last);
}
int nv40_get_window(struct vgamode_s *mode,int window)
{
    if(!extended(mode)) return stdvga_get_window(mode,window);
    return window ? -1 : cr(0x1d);
}
int nv40_set_window(struct vgamode_s *mode,int window,int val)
{
    if(!extended(mode)) return stdvga_set_window(mode,window,val);
    if(window || val<0 || val>255) return -1;
    cw(0x1d,val);cw(0x1e,val);return 0;
}
int nv40_get_linelength(struct vgamode_s *mode)
{
    if(!extended(mode)) return stdvga_get_linelength(mode);
    return (cr(0x13)|((cr(0x19)&0xe0)<<3))*8;
}
int nv40_set_linelength(struct vgamode_s *mode,int val)
{
    if(!extended(mode)) return stdvga_set_linelength(mode,val);
    if(val<=0 || val>16376) return -1;
    val=(val+7)/8;cw(0x13,val);cw(0x19,(cr(0x19)&0x1f)|((val>>3)&0xe0));return 0;
}
int nv40_get_displaystart(struct vgamode_s *mode)
{
    return extended(mode)?nr(0x600800):stdvga_get_displaystart(mode);
}
int nv40_set_displaystart(struct vgamode_s *mode,int val)
{
    if(!extended(mode)) return stdvga_set_displaystart(mode,val);
    if(val<0 || (u32)val>=GET_GLOBAL(VBE_total_memory) || val&3) return -1;
    nw(0x600800,val);return 0;
}
int nv40_get_dacformat(struct vgamode_s *mode) { return nr(0x680600)&0x100000?8:6; }
int nv40_set_dacformat(struct vgamode_s *mode,int val)
{
    if(val!=6 && val!=8) return -1;
    nw(0x680600,(nr(0x680600)&~0x100000)|(val==8?0x100000:0));return 0;
}
// The VBE state block supplements standard VGA/BDA/DAC state with extended
// CRTC bytes and the registers required to restore the selected scanout.
static u32 regs[] VAR16={0x600800,0x600804,0x600810,0x680508,0x68050c,0x680578,0x680600};
int nv40_save_restore(int cmd,u16 seg,void *data)
{
    if((cmd&(SR_RESTORE|SR_REGISTERS))==(SR_RESTORE|SR_REGISTERS))
    {
        int bytes=stdvga_save_restore(cmd&~(SR_SAVE|SR_RESTORE),seg,data);
        if(bytes<0)return bytes;
        // Restore DAC precision before the standard helper writes palette data.
        nw(0x680600,GET_FARVAR(seg,*(u32*)((u8*)data+bytes+0x60)));
    }
    int size=stdvga_save_restore(cmd,seg,data),i;
    if(size<0 || !(cmd&SR_REGISTERS)) return size;
    u8 *extra=data+size;
    if(cmd&SR_SAVE)
    {
        for(i=0x19;i<0x60;i++) SET_FARVAR(seg,extra[i-0x19],cr(i));
        for(i=0;i<7;i++) SET_FARVAR(seg,*(u32*)(extra+0x48+i*4),nr(GET_GLOBAL(regs[i])));
    }
    if(cmd&SR_RESTORE)
    {
        cw(0x1f,0x57);
        for(i=0x19;i<0x60;i++) if(i!=0x1f) cw(i,GET_FARVAR(seg,extra[i-0x19]));
        for(i=0;i<7;i++) nw(GET_GLOBAL(regs[i]),GET_FARVAR(seg,*(u32*)(extra+0x48+i*4)));
    }
    return size+0x64;
}
static u32 pll(u32 target)
{
    u32 best=0,error=~0u;int p,m;
    for(p=0;p<5;p++) for(m=1;m<=31;m++)
    {
        int n=((target/1000)*m*(1<<p)+6750)/13500;
        if(n<1 || n>255) continue;
        u32 vco=13500000u*n/m;
        if(vco<100000000 || vco>500000000) continue;
        u32 clock=13500000u*n/(m<<p),diff=clock>target?clock-target:target-clock;
        if(diff<error){error=diff;best=p<<16|n<<8|m;}
    }
    return best;
}
int nv40_set_mode(struct vgamode_s *mode,int flags)
{
    cw(0x1f,0x57);cw(0x28,0);cw(0x38,0);
    if(!extended(mode))
    {
        nw(0x680600,nr(0x680600)&~0x101000);nw(0x600810,0);cw(0x31,0);
        int ret=stdvga_set_mode(mode,flags);cw(0x1f,0x99);return ret;
    }
    if(!valid(mode) || flags&MF_CUSTOMCRTC) return -1;
    stdvga_set_mode(stdvga_find_mode(0x13),MF_NOCLEARMEM);
    cw(0x1f,0x57);
    int width=GET_GLOBAL(mode->width),height=GET_GLOBAL(mode->height),depth=GET_GLOBAL(mode->depth);
    int ht,hs,he,vt,vs,ve;u32 clock;
    if(width==640){ht=800;hs=656;he=752;vt=525;vs=490;ve=492;clock=25175000;}
    else if(width==800){ht=1056;hs=840;he=968;vt=628;vs=601;ve=605;clock=40000000;}
    else if(width==1024){ht=1344;hs=1048;he=1184;vt=806;vs=771;ve=777;clock=65000000;}
    else{ht=1688;hs=1328;he=1440;vt=1066;vs=1025;ve=1028;clock=108000000;}
    int total=vt-2,end=height-1,blank=height,hb=ht/8-1;
    cw(0x11,0);cw(0,ht/8-5);cw(1,width/8-1);cw(2,width/8);cw(3,0x80|(hb&31));
    cw(4,hs/8);cw(5,((he/8)&31)|((hb&32)<<2));cw(6,total);
    cw(7,((total>>8)&1)|((end>>7)&2)|((vs>>6)&4)|((blank>>5)&8)|0x10|
        ((total>>4)&0x20)|((end>>3)&0x40)|((vs>>2)&0x80));
    cw(8,0);cw(9,0x40|((blank>>4)&0x20));cw(0x10,vs);cw(0x11,ve&15);cw(0x12,end);
    cw(0x14,0);cw(0x15,blank);cw(0x16,vt-1);cw(0x17,0xe3);cw(0x18,255);
    cw(0x25,((total>>10)&1)|((end>>9)&2)|((vs>>8)&4)|((blank>>7)&8)|((hb>>2)&0x10));
    cw(0x2d,0);cw(0x41,0);cw(0x42,0);cw(0x19,0);cw(0x1d,0);cw(0x1e,0);
    nv40_set_linelength(mode,width*((depth+7)/8));
    nw(0x680508,pll(clock));nw(0x680578,0);nw(0x68050c,0x200);nw(0x600800,0);nw(0x600804,1);nw(0x600810,0);
    nw(0x680600,depth==8?0:0x100000|(depth==16?0x1000:0));
    // Identity gamma; packed modes retain the normal VGA color palette.
    if(depth==8) stdvga_set_packed_palette();
    else {outb(0,0x3c8);int i;for(i=0;i<256;i++){outb(i,0x3c9);outb(i,0x3c9);outb(i,0x3c9);}}
    cw(0x28,depth==8?1:depth==32?3:2);
    if(!(flags&MF_NOCLEARMEM))
    {
        u32 remaining=(u32)width*height*((depth+7)/8);int bank=0;
        while(remaining){u32 count=remaining>65536?65536:remaining;nv40_set_window(mode,0,bank);memset16_far(0xa000,0,0,count);remaining-=count;bank+=2;}
        nv40_set_window(mode,0,0);
    }
    return 0;
}
int nv40_setup(void)
{
    int ret=stdvga_setup();if(ret) return ret;
    cw(0x1f,0x57);
    if(GET_GLOBAL(HaveRunInit)) return 0;
    int bdf=GET_GLOBAL(VgaBDF);
    u32 address=bdf>=0?pci_config_readl(bdf,PCI_BASE_ADDRESS_1)&PCI_BASE_ADDRESS_MEM_MASK:0xe0000000;
    SET_VGA(VBE_framebuffer,address);SET_VGA(VBE_total_memory,nr(0x10020c));
    SET_VGA(VBE_win_granularity,32);SET_VGA(VBE_capabilities,VBE_CAPABILITY_8BIT_DAC);
    cw(0x1f,0x99);
    return 0;
}
