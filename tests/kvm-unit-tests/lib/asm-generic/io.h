#ifndef _ASM_GENERIC_IO_H_
#define _ASM_GENERIC_IO_H_
/*
 * asm-generic/io.h
 *  adapted from the Linux kernel's include/asm-generic/io.h
 *  and arch/arm/include/asm/io.h
 *
 * Copyright (C) 2014, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"
#include "asm/page.h"
#include "asm/barrier.h"

#ifndef __raw_readb
static inline u8 __raw_readb(const volatile void *addr)
{
	return *(const volatile u8 *)addr;
}
#endif

#ifndef __raw_readw
static inline u16 __raw_readw(const volatile void *addr)
{
	return *(const volatile u16 *)addr;
}
#endif

#ifndef __raw_readl
static inline u32 __raw_readl(const volatile void *addr)
{
	return *(const volatile u32 *)addr;
}
#endif

#ifndef __raw_readq
static inline u64 __raw_readq(const volatile void *addr)
{
	assert(sizeof(unsigned long) == sizeof(u64));
	return *(const volatile u64 *)addr;
}
#endif

#ifndef __raw_writeb
static inline void __raw_writeb(u8 b, volatile void *addr)
{
	*(volatile u8 *)addr = b;
}
#endif

#ifndef __raw_writew
static inline void __raw_writew(u16 b, volatile void *addr)
{
	*(volatile u16 *)addr = b;
}
#endif

#ifndef __raw_writel
static inline void __raw_writel(u32 b, volatile void *addr)
{
	*(volatile u32 *)addr = b;
}
#endif

#ifndef __raw_writeq
static inline void __raw_writeq(u64 b, volatile void *addr)
{
	assert(sizeof(unsigned long) == sizeof(u64));
	*(volatile u64 *)addr = b;
}
#endif

#ifndef __bswap16
static inline u16 __bswap16(u16 x)
{
	return ((x >> 8) & 0xff) | ((x & 0xff) << 8);
}
#endif

#ifndef __bswap32
static inline u32 __bswap32(u32 x)
{
	return ((x & 0xff000000) >> 24) | ((x & 0x00ff0000) >>  8) |
	       ((x & 0x0000ff00) <<  8) | ((x & 0x000000ff) << 24);
}
#endif

#ifndef __bswap64
static inline u64 __bswap64(u64 x)
{
	return ((x & 0x00000000000000ffULL) << 56) |
	       ((x & 0x000000000000ff00ULL) << 40) |
	       ((x & 0x0000000000ff0000ULL) << 24) |
	       ((x & 0x00000000ff000000ULL) <<  8) |
	       ((x & 0x000000ff00000000ULL) >>  8) |
	       ((x & 0x0000ff0000000000ULL) >> 24) |
	       ((x & 0x00ff000000000000ULL) >> 40) |
	       ((x & 0xff00000000000000ULL) >> 56);
}
#endif

#ifndef __cpu_is_be
#define __cpu_is_be() (0)
#endif

#define le16_to_cpu(x) \
	({ u16 __r = __cpu_is_be() ? __bswap16(x) : ((u16)x); __r; })
#define cpu_to_le16 le16_to_cpu

#define le32_to_cpu(x) \
	({ u32 __r = __cpu_is_be() ? __bswap32(x) : ((u32)x); __r; })
#define cpu_to_le32 le32_to_cpu

#define le64_to_cpu(x) \
	({ u64 __r = __cpu_is_be() ? __bswap64(x) : ((u64)x); __r; })
#define cpu_to_le64 le64_to_cpu

#define be16_to_cpu(x) \
	({ u16 __r = !__cpu_is_be() ? __bswap16(x) : ((u16)x); __r; })
#define cpu_to_be16 be16_to_cpu

#define be32_to_cpu(x) \
	({ u32 __r = !__cpu_is_be() ? __bswap32(x) : ((u32)x); __r; })
#define cpu_to_be32 be32_to_cpu

#define be64_to_cpu(x) \
	({ u64 __r = !__cpu_is_be() ? __bswap64(x) : ((u64)x); __r; })
#define cpu_to_be64 be64_to_cpu

#define readb(addr) \
	({ u8 __r = __raw_readb(addr); rmb(); __r; })
#define readw(addr) \
	({ u16 __r = le16_to_cpu(__raw_readw(addr)); rmb(); __r; })
#define readl(addr) \
	({ u32 __r = le32_to_cpu(__raw_readl(addr)); rmb(); __r; })
#define readq(addr) \
	({ u64 __r = le64_to_cpu(__raw_readq(addr)); rmb(); __r; })

#define writeb(b, addr) \
	({ wmb(); __raw_writeb(b, addr); })
#define writew(b, addr) \
	({ wmb(); __raw_writew(cpu_to_le16(b), addr); })
#define writel(b, addr) \
	({ wmb(); __raw_writel(cpu_to_le32(b), addr); })
#define writeq(b, addr) \
	({ wmb(); __raw_writeq(cpu_to_le64(b), addr); })

#ifndef inb
static inline uint8_t inb(unsigned long port)
{
	return readb((const volatile void __iomem *)port);
}
#endif

#ifndef inw
static inline uint16_t inw(unsigned long port)
{
	return readw((const volatile void __iomem *)port);
}
#endif

#ifndef inl
static inline uint32_t inl(unsigned long port)
{
	return readl((const volatile void __iomem *)port);
}
#endif

#ifndef outb
static inline void outb(uint8_t value, unsigned long port)
{
	writeb(value, (volatile void __iomem *)port);
}
#endif

#ifndef outw
static inline void outw(uint16_t value, unsigned long port)
{
	writew(value, (volatile void __iomem *)port);
}
#endif

#ifndef outl
static inline void outl(uint32_t value, unsigned long port)
{
	writel(value, (volatile void __iomem *)port);
}
#endif

#ifndef ioremap
static inline void __iomem *ioremap(phys_addr_t phys_addr, size_t size __unused)
{
	assert(sizeof(long) == 8 || !(phys_addr >> 32));
	return (void __iomem *)(unsigned long)phys_addr;
}
#endif

#ifndef virt_to_phys
static inline unsigned long virt_to_phys(volatile void *address)
{
	return __pa((unsigned long)address);
}
#endif

#ifndef phys_to_virt
static inline void *phys_to_virt(unsigned long address)
{
	return __va(address);
}
#endif

#endif /* _ASM_GENERIC_IO_H_ */
