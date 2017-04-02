/*
 * Initialize machine setup information
 *
 * Copyright (C) 2017, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"

#define MBI_MODS_COUNT	20
#define MBI_MODS_ADDR	24
#define MB_MOD_START	 0
#define MB_MOD_END	 4

#define ENV_SIZE 16384

extern void setup_env(char *env, int size);

char *initrd;
u32 initrd_size;

static char env[ENV_SIZE];

void setup_get_initrd(u8 *bootinfo)
{
	u32 *mods_addr, *mod_start, *mod_end;

	if (*((u32 *)&bootinfo[MBI_MODS_COUNT]) != 1)
		return;

	mods_addr = (u32 *)&bootinfo[MBI_MODS_ADDR];
	mod_start = (u32 *)(ulong)(*mods_addr + MB_MOD_START);
	mod_end = (u32 *)(ulong)(*mods_addr + MB_MOD_END);

	initrd = (char *)(ulong)*mod_start;
	initrd_size = *mod_end - *mod_start;
}

void setup_environ(void)
{
	if (initrd) {
		/* environ is currently the only file in the initrd */
		u32 size = MIN(initrd_size, ENV_SIZE);
		memcpy(env, initrd, size);
		setup_env(env, size);
	}
}
