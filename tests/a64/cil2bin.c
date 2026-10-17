/* Compile a CIL policy to a binary one with libsepol's CIL compiler (Alpine
 * 3.24 has libsepol but no checkpolicy or secilc): tools/a64_kernel.mjs runs it
 * in its VM for tests/a64/minimal.cil (docs/arm64-virt-android16-plan.md P9.2).
 *
 *   cil2bin in.cil out.bin [policy version, 33] */
#include <stdio.h>
#include <stdlib.h>
#include <sepol/cil/cil.h>
#include <sepol/policydb.h>

int main(int argc, char **argv)
{
    if(argc < 3) { fprintf(stderr, "usage: cil2bin in.cil out.bin [version]\n"); return 2; }
    FILE *in = fopen(argv[1], "rb");
    if(!in) { perror(argv[1]); return 1; }
    fseek(in, 0, SEEK_END);
    long size = ftell(in);
    fseek(in, 0, SEEK_SET);
    char *text = malloc(size + 1);
    if(fread(text, 1, size, in) != (size_t)size) { perror("read"); return 1; }
    fclose(in);
    struct cil_db *db = NULL;
    cil_db_init(&db);
    cil_set_policy_version(db, argc > 3 ? atoi(argv[3]) : 33);
    if(cil_add_file(db, argv[1], text, size) != SEPOL_OK) { fprintf(stderr, "cil_add_file failed\n"); return 1; }
    if(cil_compile(db) != SEPOL_OK) { fprintf(stderr, "cil_compile failed\n"); return 1; }
    sepol_policydb_t *policy = NULL;
    if(cil_build_policydb(db, &policy) != SEPOL_OK) { fprintf(stderr, "cil_build_policydb failed\n"); return 1; }
    FILE *out = fopen(argv[2], "wb");
    if(!out) { perror(argv[2]); return 1; }
    struct sepol_policy_file *file = NULL;
    if(sepol_policy_file_create(&file) < 0) return 1;
    sepol_policy_file_set_fp(file, out);
    if(sepol_policydb_write(policy, file) < 0) { fprintf(stderr, "sepol_policydb_write failed\n"); return 1; }
    fclose(out);
    printf("cil2bin: %s, version %d\n", argv[2], argc > 3 ? atoi(argv[3]) : 33);
    return 0;
}
