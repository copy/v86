/*
 * Copyright (C) 2016, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include <libcflat.h>

int parse_keyval(char *s, long *val)
{
	char *p;

	p = strchr(s, '=');
	if (!p)
		return -1;

	*val = atol(p+1);
	return p - s;
}
