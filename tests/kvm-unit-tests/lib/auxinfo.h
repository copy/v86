/*
 * This code is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Library General Public License version 2.
 */
#ifndef _AUXINFO_H_
#define _AUXINFO_H_
struct auxinfo {
	const char *progname;
};

/* No extern!  Define a common symbol.  */
struct auxinfo auxinfo;
#endif
