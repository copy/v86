#ifndef _ERRATA_H_
#define _ERRATA_H_

#define _ERRATA(erratum) errata("ERRATA_" # erratum)
#define ERRATA(erratum) _ERRATA(erratum)

#define _ERRATA_RELAXED(erratum) errata_relaxed("ERRATA_" # erratum)
#define ERRATA_RELAXED(erratum) _ERRATA_RELAXED(erratum)

static inline bool errata(const char *erratum)
{
	char *s = getenv(erratum);

	return s && (*s == '1' || *s == 'y' || *s == 'Y');
}

static inline bool errata_relaxed(const char *erratum)
{
	char *s = getenv(erratum);

	return !(s && (*s == '0' || *s == 'n' || *s == 'N'));
}

#endif
