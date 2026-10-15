/*
 * A QEMU 9.2 TCG plugin for docs/arm64-virt-android16-plan.md P2.10 (built
 * and run by tests/a64/trace_replay.mjs): on qemu-system-aarch64 with one
 * vCPU, it samples instructions the guest runs at EL0 and writes for each
 * one the state before it, the memory it read or wrote (address, size,
 * value), and the state before the next instruction (the state after, when
 * that one runs at EL0 too: an exception or interrupt in between discards
 * the sample). It also collects the corpus: every distinct instruction word
 * translated, with whether it ran at EL0 in a sample.
 *
 * The PC: aarch64 TCG translates position-independent blocks (CF_PCREL),
 * shared by every virtual address of the same physical page (each process
 * maps libc elsewhere), so the address seen at translation may be another
 * process's; and an instruction callback reads the "pc" register as TCG last
 * synced it in the running block (its start, or a later instruction of it).
 * The instruction's PC is the page of that register (or the next page: a
 * block spans two at most) with the page offset from the translation,
 * whichever holds the instruction's word; a sample neither does is dropped.
 *
 * Arguments: out=PATH (the records; a FIFO is fine), corpus=PATH, period=N
 * (instructions between samples on average, default 16), seed=N, limit=N
 * (samples, 0 for no limit).
 *
 * A record (little-endian): u32 magic 0x53343641 ("A64S"), u32 word, u32
 * memory accesses, u32 flags (bit 0: V0-V31 follow each register block);
 * the registers before: X0-X30, SP, PC, CPSR, FPSR, FPCR, TPIDR_EL0,
 * TPIDRRO_EL0 (38 u64), then V0-V31 (32 x 16 bytes) if flagged; the same
 * after; then each access: u64 address, u64 value low, u64 value high,
 * u32 size in bytes, u32 store.
 */
#include <glib.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <qemu-plugin.h>

QEMU_PLUGIN_EXPORT int qemu_plugin_version = QEMU_PLUGIN_VERSION;

enum { NAMED = 38, VECTORS = 32, MAX_ACCESSES = 64 };
static const char *const NAMES[NAMED] = {
    "x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "x10", "x11", "x12", "x13", "x14", "x15",
    "x16", "x17", "x18", "x19", "x20", "x21", "x22", "x23", "x24", "x25", "x26", "x27", "x28", "x29", "x30",
    "sp", "pc", "cpsr", "fpsr", "fpcr", "TPIDR_EL0", "TPIDRRO_EL0",
};
static struct qemu_plugin_register *named[NAMED];
static struct qemu_plugin_register *vectors[VECTORS];

struct access { uint64_t address, low, high; uint32_t size, store; };
/* what a translated instruction's callback knows of it */
struct insn_info { uint64_t vaddr; uint32_t word; };
struct state { uint64_t named[NAMED]; uint8_t v[VECTORS][16]; };

static FILE *out;
static char *corpus_path;
static uint64_t period = 16, limit, samples, discarded, rng = 0x9E3779B97F4A7C15ull;
static struct qemu_plugin_scoreboard *scoreboard;
static qemu_plugin_u64 counter;

/* the sample in flight: 0 none, 1 its instruction is running */
static int armed;
static uint32_t armed_word;
static struct state before, after;
static struct access accesses[MAX_ACCESSES];
static unsigned access_count, access_overflow;

static GHashTable *corpus;
static GMutex corpus_lock;

static uint64_t next_random(void)
{
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng;
}

static uint64_t read_u64(struct qemu_plugin_register *reg, GByteArray *buffer)
{
    uint64_t value = 0;
    if(!reg) return 0;
    g_byte_array_set_size(buffer, 0);
    int n = qemu_plugin_read_register(reg, buffer);
    memcpy(&value, buffer->data, n < 8 ? n : 8);
    return value;
}

static void capture(struct state *s, int with_vectors)
{
    GByteArray *buffer = g_byte_array_new();
    for(int i = 0; i < NAMED; i++) s->named[i] = read_u64(named[i], buffer);
    if(with_vectors)
    {
        for(int i = 0; i < VECTORS; i++)
        {
            g_byte_array_set_size(buffer, 0);
            int n = vectors[i] ? qemu_plugin_read_register(vectors[i], buffer) : 0;
            memset(s->v[i], 0, 16);
            memcpy(s->v[i], buffer->data, n < 16 ? n : 16);
        }
    }
    g_byte_array_free(buffer, TRUE);
}

static int el_of(uint64_t cpsr) { return cpsr >> 2 & 3; }

/* the PC of the instruction running now (see above); 1 if it cannot be found */
static uint64_t current_pc(const struct insn_info *insn)
{
    GByteArray *buffer = g_byte_array_new();
    uint64_t synced = read_u64(named[32], buffer);
    uint64_t result = 1;
    for(int page = 0; page < 2 && result == 1; page++)
    {
        uint64_t candidate = ((synced & ~0xFFFull) + 0x1000ull * page) | (insn->vaddr & 0xFFF);
        g_byte_array_set_size(buffer, 0);
        if(qemu_plugin_read_memory_vaddr(candidate, buffer, 4) && buffer->len == 4)
        {
            uint32_t word;
            memcpy(&word, buffer->data, 4);
            if(word == insn->word) result = candidate;
        }
    }
    g_byte_array_free(buffer, TRUE);
    return result;
}

static uint64_t unresolved;

static void write_state(const struct state *s, int with_vectors)
{
    fwrite(s->named, 8, NAMED, out);
    if(with_vectors) fwrite(s->v, 16, VECTORS, out);
}

/* before each instruction the counter reaches: a sample's start, or its end */
static void on_insn(unsigned int vcpu, void *data)
{
    const struct insn_info *insn = data;
    uint32_t word = insn->word;
    if(limit && samples >= limit)
    {
        qemu_plugin_u64_set(counter, vcpu, 0);
        return;
    }
    GByteArray *buffer = g_byte_array_new();
    uint64_t cpsr = read_u64(named[33], buffer);
    g_byte_array_free(buffer, TRUE);
    int with_vectors = armed_word >> 26 & 1;
    if(armed)
    {
        armed = 0;
        uint64_t pc = el_of(cpsr) == 0 && !access_overflow ? current_pc(insn) : 1;
        if(pc == 1 && el_of(cpsr) == 0 && !access_overflow) unresolved++;
        if(pc != 1)
        {
            capture(&after, with_vectors);
            after.named[32] = pc;
            uint32_t header[4] = { 0x53343641, armed_word, access_count, (uint32_t)with_vectors };
            fwrite(header, 4, 4, out);
            write_state(&before, with_vectors);
            write_state(&after, with_vectors);
            fwrite(accesses, sizeof(struct access), access_count, out);
            samples++;
            if(limit && samples >= limit) fflush(out);
        }
        else
        {
            discarded++;
        }
        /* (the next sample a random distance away, period on average) */
        qemu_plugin_u64_set(counter, vcpu, next_random() % period);
        return;
    }
    if(el_of(cpsr) != 0)
    {
        qemu_plugin_u64_set(counter, vcpu, next_random() % period);
        return;
    }
    uint64_t pc = current_pc(insn);
    if(pc == 1)
    {
        unresolved++;
        qemu_plugin_u64_set(counter, vcpu, next_random() % period);
        return;
    }
    capture(&before, word >> 26 & 1);
    before.named[32] = pc;
    armed = 1;
    armed_word = word;
    access_count = 0;
    access_overflow = 0;
    /* (the next instruction ends the sample) */
    qemu_plugin_u64_set(counter, vcpu, period);
}

static void on_memory(unsigned int vcpu, qemu_plugin_meminfo_t info, uint64_t address, void *data)
{
    if(!armed) return;
    if(access_count == MAX_ACCESSES) { access_overflow = 1; return; }
    qemu_plugin_mem_value value = qemu_plugin_mem_get_value(info);
    struct access *a = &accesses[access_count++];
    a->address = address;
    a->size = 1u << qemu_plugin_mem_size_shift(info);
    a->store = qemu_plugin_mem_is_store(info);
    a->high = 0;
    switch(value.type)
    {
        case QEMU_PLUGIN_MEM_VALUE_U8: a->low = value.data.u8; break;
        case QEMU_PLUGIN_MEM_VALUE_U16: a->low = value.data.u16; break;
        case QEMU_PLUGIN_MEM_VALUE_U32: a->low = value.data.u32; break;
        case QEMU_PLUGIN_MEM_VALUE_U64: a->low = value.data.u64; break;
        case QEMU_PLUGIN_MEM_VALUE_U128: a->low = value.data.u128.low; a->high = value.data.u128.high; break;
    }
}

static void on_translation(qemu_plugin_id_t id, struct qemu_plugin_tb *tb)
{
    size_t n = qemu_plugin_tb_n_insns(tb);
    for(size_t i = 0; i < n; i++)
    {
        struct qemu_plugin_insn *insn = qemu_plugin_tb_get_insn(tb, i);
        uint32_t word = 0;
        qemu_plugin_insn_data(insn, &word, sizeof(word));
        struct insn_info *info = g_new(struct insn_info, 1);
        info->vaddr = qemu_plugin_insn_vaddr(insn);
        info->word = word;
        g_mutex_lock(&corpus_lock);
        g_hash_table_add(corpus, GUINT_TO_POINTER(word + 1)); /* (+1: a key may not be 0) */
        g_mutex_unlock(&corpus_lock);
        qemu_plugin_register_vcpu_insn_exec_inline_per_vcpu(insn, QEMU_PLUGIN_INLINE_ADD_U64, counter, 1);
        qemu_plugin_register_vcpu_insn_exec_cond_cb(insn, on_insn, QEMU_PLUGIN_CB_R_REGS, QEMU_PLUGIN_COND_GE,
            counter, period, info);
        qemu_plugin_register_vcpu_mem_cb(insn, on_memory, QEMU_PLUGIN_CB_NO_REGS, QEMU_PLUGIN_MEM_RW, NULL);
    }
}

static void on_vcpu_init(qemu_plugin_id_t id, unsigned int vcpu)
{
    GArray *registers = qemu_plugin_get_registers();
    for(guint i = 0; i < registers->len; i++)
    {
        qemu_plugin_reg_descriptor *r = &g_array_index(registers, qemu_plugin_reg_descriptor, i);
        for(int k = 0; k < NAMED; k++) if(!strcmp(r->name, NAMES[k])) named[k] = r->handle;
        if(r->name[0] == 'v' && r->name[1] >= '0' && r->name[1] <= '9')
        {
            int k = atoi(r->name + 1);
            if(k >= 0 && k < VECTORS) vectors[k] = r->handle;
        }
    }
    g_array_free(registers, TRUE);
    for(int k = 0; k < NAMED; k++)
    {
        if(!named[k]) fprintf(stderr, "trace_sample: no register %s\n", NAMES[k]);
    }
}

static void on_exit(qemu_plugin_id_t id, void *data)
{
    fflush(out);
    fclose(out);
    FILE *c = fopen(corpus_path, "w");
    GList *keys = g_hash_table_get_keys(corpus);
    for(GList *k = keys; k; k = k->next) fprintf(c, "%08x\n", GPOINTER_TO_UINT(k->data) - 1);
    g_list_free(keys);
    fclose(c);
    fprintf(stderr, "trace_sample: %" PRIu64 " samples, %" PRIu64 " discarded, %" PRIu64 " PCs not found, %u corpus words\n",
        samples, discarded, unresolved, g_hash_table_size(corpus));
}

QEMU_PLUGIN_EXPORT int qemu_plugin_install(qemu_plugin_id_t id, const qemu_info_t *info, int argc, char **argv)
{
    const char *out_path = NULL;
    for(int i = 0; i < argc; i++)
    {
        char *value = strchr(argv[i], '=');
        if(!value) continue;
        *value++ = 0;
        if(!strcmp(argv[i], "out")) out_path = value;
        else if(!strcmp(argv[i], "corpus")) corpus_path = g_strdup(value);
        else if(!strcmp(argv[i], "period")) period = strtoull(value, NULL, 0);
        else if(!strcmp(argv[i], "seed")) rng ^= strtoull(value, NULL, 0) * 0x2545F4914F6CDD1Dull;
        else if(!strcmp(argv[i], "limit")) limit = strtoull(value, NULL, 0);
    }
    if(!out_path || !corpus_path || period < 2) return -1;
    out = fopen(out_path, "wb");
    if(!out) return -1;
    setvbuf(out, NULL, _IOFBF, 1 << 20);
    corpus = g_hash_table_new(g_direct_hash, g_direct_equal);
    scoreboard = qemu_plugin_scoreboard_new(sizeof(uint64_t));
    counter = qemu_plugin_scoreboard_u64(scoreboard);
    qemu_plugin_register_vcpu_init_cb(id, on_vcpu_init);
    qemu_plugin_register_vcpu_tb_trans_cb(id, on_translation);
    qemu_plugin_register_atexit_cb(id, on_exit, NULL);
    return 0;
}
