CC=gcc
CC_I386=$(CC) -m32
CFLAGS=-Wall -g -fno-strict-aliasing -fPIC -static
LDFLAGS=


test-jit: test-jit.c
	$(CC_I386) $(CFLAGS) $(LDFLAGS) -o $@ $(<D)/test-jit.c
test-jit-smc: test-jit-smc.c
	$(CC_I386) $(CFLAGS) $(LDFLAGS) -o $@ $(<D)/test-jit-smc.c
test-jit-smc-fstenv: test-jit-smc-fstenv.c
	$(CC_I386) $(CFLAGS) $(LDFLAGS) -o $@ $(<D)/test-jit-smc-fstenv.c

clean:
	rm -f test-jit test-jit-smc test-jit-smc-fstenv
