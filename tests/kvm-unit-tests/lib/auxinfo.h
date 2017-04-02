#ifndef _AUXINFO_H_
#define _AUXINFO_H_
struct auxinfo {
	const char *progname;
};

/* No extern!  Define a common symbol.  */
struct auxinfo auxinfo;
#endif
