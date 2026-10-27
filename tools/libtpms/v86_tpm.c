// The TPM 2.0 behind v86's TPM device (docs/tpm.md): libtpms (its TPM 2.0
// state machine and OpenSSL's cryptography) built for WebAssembly by
// tools/libtpms/build.sh, with this interface for src/tpm/. The host keeps
// the TPM's state: it hands the permanent and volatile state in before
// v86_tpm_init and is told of every store of them (tpm_nv_store); a command
// is a buffer in, a buffer out. No files: the NV callbacks keep the data in
// memory. Entropy is the host's (WASI random_get: crypto.getRandomValues).

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <libtpms/tpm_library.h>
#include <libtpms/tpm_error.h>
#include <libtpms/tpm_nvfilename.h>

#define IMPORT(name) __attribute__((import_module("env"), import_name(name)))

/** The TPM stored a state blob (0: permanent, 1: volatile, 2: save state) */
IMPORT("tpm_nv_store") void js_nv_store(uint32_t kind, const unsigned char *data, uint32_t length);
/** The locality of the command being processed (CRB's active locality) */
IMPORT("tpm_locality") uint32_t js_locality(void);

/** The state blobs handed in before init: permanent, volatile, save state */
static unsigned char *blobs[3];
static uint32_t blob_lengths[3];

static int kind_of(const char *name)
{
    if(strcmp(name, TPM_PERMANENT_ALL_NAME) == 0) return 0;
    if(strcmp(name, TPM_VOLATILESTATE_NAME) == 0) return 1;
    if(strcmp(name, TPM_SAVESTATE_NAME) == 0) return 2;
    return -1;
}

static TPM_RESULT nvram_init(void) { return TPM_SUCCESS; }

static TPM_RESULT nvram_loaddata(unsigned char **data, uint32_t *length, uint32_t tpm_number, const char *name)
{
    (void)tpm_number;
    int kind = kind_of(name);
    if(kind < 0 || !blobs[kind])
    {
        // (no state: a TPM that manufactures itself, or nothing to resume)
        return TPM_RETRY;
    }
    *data = malloc(blob_lengths[kind]);
    if(!*data) return TPM_FAIL;
    memcpy(*data, blobs[kind], blob_lengths[kind]);
    *length = blob_lengths[kind];
    return TPM_SUCCESS;
}

static TPM_RESULT nvram_storedata(const unsigned char *data, uint32_t length, uint32_t tpm_number, const char *name)
{
    (void)tpm_number;
    int kind = kind_of(name);
    if(kind < 0) return TPM_FAIL;
    // (a load after the store returns it, as a file would: libtpms reads
    // the permanent state back after manufacturing it)
    unsigned char *copy = malloc(length ? length : 1);
    if(!copy) return TPM_FAIL;
    memcpy(copy, data, length);
    free(blobs[kind]);
    blobs[kind] = copy;
    blob_lengths[kind] = length;
    js_nv_store(kind, data, length);
    return TPM_SUCCESS;
}

static TPM_RESULT nvram_deletename(uint32_t tpm_number, const char *name, TPM_BOOL must_exist)
{
    (void)tpm_number;
    (void)must_exist;
    int kind = kind_of(name);
    if(kind >= 0)
    {
        free(blobs[kind]);
        blobs[kind] = NULL;
        blob_lengths[kind] = 0;
        js_nv_store(kind, NULL, 0);
    }
    return TPM_SUCCESS;
}

static TPM_RESULT io_init(void) { return TPM_SUCCESS; }

static TPM_RESULT io_getlocality(TPM_MODIFIER_INDICATOR *locality, uint32_t tpm_number)
{
    (void)tpm_number;
    *locality = js_locality();
    return TPM_SUCCESS;
}

static TPM_RESULT io_getphysicalpresence(TPM_BOOL *physical_presence, uint32_t tpm_number)
{
    (void)tpm_number;
    *physical_presence = FALSE;
    return TPM_SUCCESS;
}

static struct libtpms_callbacks callbacks = {
    .sizeOfStruct = sizeof(struct libtpms_callbacks),
    .tpm_nvram_init = nvram_init,
    .tpm_nvram_loaddata = nvram_loaddata,
    .tpm_nvram_storedata = nvram_storedata,
    .tpm_nvram_deletename = nvram_deletename,
    .tpm_io_init = io_init,
    .tpm_io_getlocality = io_getlocality,
    .tpm_io_getphysicalpresence = io_getphysicalpresence,
};

static unsigned char *response;
static uint32_t response_length, response_size;

/** Memory for the host's buffers */
void *v86_tpm_alloc(uint32_t size) { return malloc(size); }
void v86_tpm_free(void *pointer) { free(pointer); }

/** A state blob for init (kind 0, 1, 2; the TPM takes the bytes over) */
void v86_tpm_set_blob(uint32_t kind, unsigned char *data, uint32_t length)
{
    if(kind > 2) return;
    free(blobs[kind]);
    blobs[kind] = data;
    blob_lengths[kind] = length;
}

/** Power on: the TPM from its blobs, or manufactured; 0 or a TPM_RESULT */
uint32_t v86_tpm_init(uint32_t buffer_size)
{
    TPM_RESULT result = TPMLIB_RegisterCallbacks(&callbacks);
    if(result != TPM_SUCCESS) return result;
    result = TPMLIB_ChooseTPMVersion(TPMLIB_TPM_VERSION_2);
    if(result != TPM_SUCCESS) return result;
    TPMLIB_SetBufferSize(buffer_size, NULL, NULL);
    result = TPMLIB_MainInit();
    // (the volatile state is read once, at this power-on)
    free(blobs[1]);
    blobs[1] = NULL;
    blob_lengths[1] = 0;
    return result;
}

/** Power off: the TPM's memory released (the permanent state is stored already) */
void v86_tpm_terminate(void) { TPMLIB_Terminate(); }

/** A command (length bytes at command): the response's length (v86_tpm_response) */
uint32_t v86_tpm_process(const unsigned char *command, uint32_t length)
{
    response_length = 0;
    TPM_RESULT result = TPMLIB_Process(&response, &response_length, &response_size, (unsigned char *)command, length);
    if(result != TPM_SUCCESS) return 0;
    return response_length;
}

const unsigned char *v86_tpm_response(void) { return response; }

/** Cancel the command running (another thread's; here a no-op beyond the flag) */
void v86_tpm_cancel(void) { TPMLIB_CancelCommand(); }

static unsigned char *state;
static uint32_t state_length;

/**
 * A state blob of the TPM as it is (1: permanent, 2: volatile), for a
 * snapshot: its length (v86_tpm_state)
 */
uint32_t v86_tpm_get_state(uint32_t type)
{
    free(state);
    state = NULL;
    state_length = 0;
    if(type == 2)
    {
        // (the volatile state of a running TPM)
        if(TPMLIB_VolatileAll_Store(&state, &state_length) != TPM_SUCCESS) return 0;
        return state_length;
    }
    if(TPMLIB_GetState(TPMLIB_STATE_PERMANENT, &state, &state_length) != TPM_SUCCESS) return 0;
    return state_length;
}

const unsigned char *v86_tpm_state(void) { return state; }
