#ifndef _UTIL_H_
#define _UTIL_H_
/*
 * Collection of utility functions to share between unit tests.
 *
 * Copyright (C) 2016, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */

/*
 * parse_keyval extracts the integer from a string formatted as
 * string=integer. This is useful for passing expected values to
 * the unit test on the command line, i.e. it helps parse QEMU
 * command lines that include something like -append var1=1 var2=2
 * @s is the input string, likely a command line parameter, and
 * @val is a pointer to where the integer will be stored.
 *
 * Returns the offset of the '=', or -1 if no keyval pair is found.
 */
extern int parse_keyval(char *s, long *val);

#endif
