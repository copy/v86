/*
 * Set up arguments for main() and prepare environment variables
 *
 * This code is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Library General Public License version 2.
 */

#include "libcflat.h"
#include "argv.h"
#include "auxinfo.h"

int __argc;
const char *__args;
char *__argv[100];
char *__environ[200];

char **environ = __environ;

static char args_copy[1000];
static char *copy_ptr = args_copy;

#define isblank(c) ((c) == ' ' || (c) == '\t')
#define isalpha(c) (((c) >= 'A' && (c) <= 'Z') || ((c) >= 'a' && (c) <= 'z') || (c) == '_')
#define isalnum(c) (isalpha(c) || ((c) >= '0' && (c) <= '9'))

static const char *skip_blanks(const char *p)
{
	while (isblank(*p))
		++p;
	return p;
}

void __setup_args(void)
{
	const char *args = __args;
	char **argv = __argv + __argc;

	while (*(args = skip_blanks(args)) != '\0') {
		*argv++ = copy_ptr;
		while (*args != '\0' && !isblank(*args))
			*copy_ptr++ = *args++;
		*copy_ptr++ = '\0';
	}
	__argc = argv - __argv;
}

static void setup_args(const char *args)
{
	if (!args)
		return;

	__args = args;
	__setup_args();
}

void setup_args_progname(const char *args)
{
	__argv[0] = copy_ptr;
	strcpy(__argv[0], auxinfo.progname);
	copy_ptr += strlen(auxinfo.progname) + 1;
	++__argc;
	setup_args(args);
}

static char *env_eol(char *env)
{
	while (*env && *env != '\n')
		++env;
	return env;
}

static char *env_invalid_eol(char *env)
{
	char *eol = env_eol(env);
	char eol_old = *eol;

	*eol = '\0';
	printf("Invalid environment variable: %s\n", env);
	*eol = eol_old;
	return eol;
}

static char *env_next(char *env)
{
	char *p;

	if (!*env)
		return env;

	if (isalpha(*env)) {
		bool invalid = false;

		p = env + 1;
		while (*p && *p != '=' && *p != '\n') {
			if (!isalnum(*p))
				invalid = true;
			++p;
		}

		if (*p != '=')
			invalid = true;

		if (invalid) {
			env = env_invalid_eol(env);
			return *env ? env_next(env + 1) : env;
		}
		return env;
	}

	p = env;
	while (isblank(*p))
		++p;

	if (*p == '\n')
		return env_next(p + 1);

	if (*p == '#')
		env = env_eol(env);
	else
		env = env_invalid_eol(env);

	return *env ? env_next(env + 1) : env;
}

void setup_env(char *env, int size)
{
	char *eof = env + size, *p = env;
	bool newline = false;
	int i = 0;

	while (*p)
		++p;
	if (p == eof)
		newline = true;

	while (env < eof) {
		if (newline)
			env = env_next(env);
		if (!*env || env >= eof)
			break;
		__environ[i++] = env;
		while (env < eof && *env && !(newline && *env == '\n'))
			++env;
		*env++ = '\0';
	}
}
