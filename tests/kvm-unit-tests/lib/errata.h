/*
 * errata functions
 *
 * This code is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Library General Public License version 2.
 */
#ifndef _ERRATA_H_
#define _ERRATA_H_

#define _ERRATA(erratum) errata("ERRATA_" # erratum)
#define ERRATA(erratum) _ERRATA(erratum)

#define _ERRATA_RELAXED(erratum) errata_relaxed("ERRATA_" # erratum)
#define ERRATA_RELAXED(erratum) _ERRATA_RELAXED(erratum)

static inline bool errata_force(void)
{
	char *s = getenv("ERRATA_FORCE");

	return s && (*s == '1' || *s == 'y' || *s == 'Y');
}

static inline bool errata(const char *erratum)
{
	char *s;

	if (errata_force())
		return true;

	s = getenv(erratum);

	return s && (*s == '1' || *s == 'y' || *s == 'Y');
}

static inline bool errata_relaxed(const char *erratum)
{
	char *s;

	if (errata_force())
		return true;

	s = getenv(erratum);

	return !(s && (*s == '0' || *s == 'n' || *s == 'N'));
}

#endif
