/*
 * Test result reporting
 *
 * Copyright (c) Siemens AG, 2014
 *
 * Authors:
 *  Jan Kiszka <jan.kiszka@siemens.com>
 *  Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */

#include "libcflat.h"
#include "asm/spinlock.h"

static unsigned int tests, failures, xfailures, skipped;
static char prefixes[256];
static struct spinlock lock;

void report_prefix_push(const char *prefix)
{
	spin_lock(&lock);
	strcat(prefixes, prefix);
	strcat(prefixes, ": ");
	spin_unlock(&lock);
}

void report_prefix_pop(void)
{
	char *p, *q;

	spin_lock(&lock);

	if (!*prefixes)
		return;

	for (p = prefixes, q = strstr(p, ": ") + 2;
			*q;
			p = q, q = strstr(p, ": ") + 2)
		;
	*p = '\0';

	spin_unlock(&lock);
}

static void va_report(const char *msg_fmt,
		bool pass, bool xfail, bool skip, va_list va)
{
	char *prefix = skip ? "SKIP"
	                    : xfail ? (pass ? "XPASS" : "XFAIL")
	                            : (pass ? "PASS"  : "FAIL");

	spin_lock(&lock);

	tests++;
	printf("%s: ", prefix);
	puts(prefixes);
	vprintf(msg_fmt, va);
	puts("\n");
	if (skip)
		skipped++;
	else if (xfail && !pass)
		xfailures++;
	else if (xfail || !pass)
		failures++;

	spin_unlock(&lock);
}

void report(const char *msg_fmt, bool pass, ...)
{
	va_list va;
	va_start(va, pass);
	va_report(msg_fmt, pass, false, false, va);
	va_end(va);
}

void report_xfail(const char *msg_fmt, bool xfail, bool pass, ...)
{
	va_list va;
	va_start(va, pass);
	va_report(msg_fmt, pass, xfail, false, va);
	va_end(va);
}

void report_skip(const char *msg_fmt, ...)
{
	va_list va;
	va_start(va, msg_fmt);
	va_report(msg_fmt, false, false, true, va);
	va_end(va);
}

void report_info(const char *msg_fmt, ...)
{
	va_list va;

	spin_lock(&lock);
	puts("INFO: ");
	puts(prefixes);
	va_start(va, msg_fmt);
	vprintf(msg_fmt, va);
	va_end(va);
	puts("\n");
	spin_unlock(&lock);
}

int report_summary(void)
{
	spin_lock(&lock);

	printf("SUMMARY: %d tests", tests);
	if (failures)
		printf(", %d unexpected failures", failures);
	if (xfailures)
		printf(", %d expected failures", xfailures);
	if (skipped)
		printf(", %d skipped", skipped);
	printf("\n");

	if (tests == skipped)
		/* Blame AUTOTOOLS for using 77 for skipped test and QEMU for
		 * mangling error codes in a way that gets 77 if we ... */
		return 77 >> 1;

	return failures > 0 ? 1 : 0;

	spin_unlock(&lock);
}

void report_abort(const char *msg_fmt, ...)
{
	va_list va;

	spin_lock(&lock);
	puts("ABORT: ");
	puts(prefixes);
	va_start(va, msg_fmt);
	vprintf(msg_fmt, va);
	va_end(va);
	puts("\n");
	spin_unlock(&lock);
	report_summary();
	abort();
}
