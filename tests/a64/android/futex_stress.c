// Condition variables across cores (docs/aarch64.md's known defects: Android
// stalled after a restore with Launcher3's RenderThread waiting for good in
// ANGLE's AsyncWaitableEvent::wait): bionic's pthread mutexes and condition
// variables used the way ANGLE's worker pool uses them (src/common/
// WorkerThread.cpp: a queue of tasks under one mutex and condition
// variable, each task's event its own mutex, condition variable and flag),
// and ping-pong pairs, while the host saves and restores the machine.
//
// Built with the NDK as a static executable (it runs on Android and on
// Alpine's kernel alike):
//   futex_stress <seconds> [pairs] [workers] [tasks]
// Every second a line "FS <second> pp=<round trips> pool=<batches> ..."; a
// group that made no progress for 10 s is reported once on a line
// "FS_STALL ..." with the waiters' places, and the run ends with
// "FS_DONE stalls=<n>".
//   futex_stress clock <cpus>
// On each CPU in turn, CLOCK_MONOTONIC read for 200 ms of its own time: the
// largest step between two readings, "FS_CLOCK cpu=<n> reads=<n>
// max_step_us=<n>" (a core whose counter only moves when another core
// reads it steps by up to the machine's idle sleep).
#define _GNU_SOURCE
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MAX_PAIRS 16
#define MAX_WORKERS 16
#define MAX_TASKS 64

static atomic_int stop;

static double now(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}

// ---- ping-pong pairs: one mutex, one condition variable, a turn

struct pair
{
    pthread_mutex_t mutex;
    pthread_cond_t cond;
    int turn;
    atomic_long rounds;
    atomic_int where[2];        // 0 running, 1 waiting
};
static struct pair pairs[MAX_PAIRS];

struct side { struct pair *p; int me; };

static void *pair_thread(void *arg)
{
    struct side *s = arg;
    struct pair *p = s->p;
    while(!atomic_load(&stop))
    {
        pthread_mutex_lock(&p->mutex);
        while(p->turn != s->me && !atomic_load(&stop))
        {
            atomic_store(&p->where[s->me], 1);
            pthread_cond_wait(&p->cond, &p->mutex);
            atomic_store(&p->where[s->me], 0);
        }
        p->turn = !s->me;
        if(s->me) atomic_fetch_add(&p->rounds, 1);
        pthread_cond_signal(&p->cond);
        pthread_mutex_unlock(&p->mutex);
    }
    return NULL;
}

// ---- ANGLE's worker pool: tasks in a queue, an event per task

struct event
{
    pthread_mutex_t mutex;
    pthread_cond_t cond;
    int ready;
};

static struct
{
    pthread_mutex_t mutex;
    pthread_cond_t cond;
    int queue[MAX_TASKS];
    int head, tail;
} pool = { PTHREAD_MUTEX_INITIALIZER, PTHREAD_COND_INITIALIZER };

static struct event events[MAX_TASKS];
static atomic_long work[MAX_TASKS];
static atomic_long batches;
static atomic_int worker_where[MAX_WORKERS];    // 0 running a task, 1 waiting for one
static atomic_int producer_waits = -1;          // the task whose event the producer waits for
static int tasks = 8;

static void *worker_thread(void *arg)
{
    int me = (int)(long)arg;
    for(;;)
    {
        pthread_mutex_lock(&pool.mutex);
        while(pool.head == pool.tail && !atomic_load(&stop))
        {
            atomic_store(&worker_where[me], 1);
            pthread_cond_wait(&pool.cond, &pool.mutex);
            atomic_store(&worker_where[me], 0);
        }
        if(pool.head == pool.tail)
        {
            pthread_mutex_unlock(&pool.mutex);
            return NULL;
        }
        int task = pool.queue[pool.head++ % MAX_TASKS];
        pthread_mutex_unlock(&pool.mutex);
        // (a little work: ANGLE's tasks compile and create pipelines)
        volatile unsigned x = task;
        for(int i = 0; i < 2000; i++) x = x * 1103515245 + 12345;
        atomic_fetch_add(&work[task], 1);
        struct event *e = &events[task];
        pthread_mutex_lock(&e->mutex);
        e->ready = 1;
        pthread_cond_broadcast(&e->cond);
        pthread_mutex_unlock(&e->mutex);
    }
}

static void *producer_thread(void *arg)
{
    (void)arg;
    while(!atomic_load(&stop))
    {
        for(int t = 0; t < tasks; t++)
        {
            pthread_mutex_lock(&events[t].mutex);
            events[t].ready = 0;
            pthread_mutex_unlock(&events[t].mutex);
            pthread_mutex_lock(&pool.mutex);
            pool.queue[pool.tail++ % MAX_TASKS] = t;
            pthread_cond_signal(&pool.cond);
            pthread_mutex_unlock(&pool.mutex);
        }
        for(int t = 0; t < tasks; t++)
        {
            struct event *e = &events[t];
            pthread_mutex_lock(&e->mutex);
            atomic_store(&producer_waits, t);
            while(!e->ready) pthread_cond_wait(&e->cond, &e->mutex);
            atomic_store(&producer_waits, -1);
            pthread_mutex_unlock(&e->mutex);
        }
        atomic_fetch_add(&batches, 1);
    }
    return NULL;
}

static int clock_steps(int cpus)
{
    for(int cpu = 0; cpu < cpus; cpu++)
    {
        cpu_set_t set;
        CPU_ZERO(&set);
        CPU_SET(cpu, &set);
        if(sched_setaffinity(0, sizeof set, &set)) { printf("FS_CLOCK cpu=%d affinity failed\n", cpu); continue; }
        double start = now(), last = start, max_step = 0;
        long reads = 0;
        for(double t = start; t < start + 0.2; t = now())
        {
            reads++;
            if(t - last > max_step) max_step = t - last;
            last = t;
        }
        printf("FS_CLOCK cpu=%d reads=%ld max_step_us=%.0f\n", cpu, reads, max_step * 1e6);
    }
    return 0;
}

int main(int argc, char **argv)
{
    if(argc > 2 && !strcmp(argv[1], "clock")) return clock_steps(atoi(argv[2]));
    int seconds = argc > 1 ? atoi(argv[1]) : 60;
    int npairs = argc > 2 ? atoi(argv[2]) : 4;
    int workers = argc > 3 ? atoi(argv[3]) : 4;
    if(argc > 4) tasks = atoi(argv[4]);
    if(npairs > MAX_PAIRS) npairs = MAX_PAIRS;
    if(workers > MAX_WORKERS) workers = MAX_WORKERS;
    if(tasks > MAX_TASKS) tasks = MAX_TASKS;
    setvbuf(stdout, NULL, _IOLBF, 0);

    static struct side sides[MAX_PAIRS][2];
    pthread_t threads[2 * MAX_PAIRS + MAX_WORKERS + 1];
    int n = 0;
    for(int i = 0; i < npairs; i++)
    {
        pthread_mutex_init(&pairs[i].mutex, NULL);
        pthread_cond_init(&pairs[i].cond, NULL);
        for(int me = 0; me < 2; me++)
        {
            sides[i][me] = (struct side){ &pairs[i], me };
            pthread_create(&threads[n++], NULL, pair_thread, &sides[i][me]);
        }
    }
    for(int t = 0; t < MAX_TASKS; t++)
    {
        pthread_mutex_init(&events[t].mutex, NULL);
        pthread_cond_init(&events[t].cond, NULL);
    }
    for(int w = 0; w < workers; w++) pthread_create(&threads[n++], NULL, worker_thread, (void *)(long)w);
    pthread_create(&threads[n++], NULL, producer_thread, NULL);

    long last_pp[MAX_PAIRS] = { 0 }, last_pool = 0;
    double since_pp[MAX_PAIRS], since_pool, start = now();
    int stalled_pp[MAX_PAIRS] = { 0 }, stalled_pool = 0, stalls = 0;
    for(int i = 0; i < npairs; i++) since_pp[i] = start;
    since_pool = start;
    for(int second = 1; second <= seconds; second++)
    {
        while(now() < start + second) usleep(50000);
        double t = now();
        char line[512];
        int at = snprintf(line, sizeof line, "FS %d pp=", second);
        for(int i = 0; i < npairs; i++)
        {
            long r = atomic_load(&pairs[i].rounds);
            at += snprintf(line + at, sizeof line - at, "%s%ld", i ? "," : "", r);
            if(r != last_pp[i]) { last_pp[i] = r; since_pp[i] = t; stalled_pp[i] = 0; }
            else if(t - since_pp[i] >= 10 && !stalled_pp[i])
            {
                stalled_pp[i] = 1;
                stalls++;
                printf("FS_STALL pair=%d rounds=%ld turn=%d waiting=%d,%d\n", i, r, pairs[i].turn,
                    atomic_load(&pairs[i].where[0]), atomic_load(&pairs[i].where[1]));
            }
        }
        long b = atomic_load(&batches);
        snprintf(line + at, sizeof line - at, " pool=%ld", b);
        puts(line);
        if(b != last_pool) { last_pool = b; since_pool = t; stalled_pool = 0; }
        else if(t - since_pool >= 10 && !stalled_pool)
        {
            stalled_pool = 1;
            stalls++;
            int task = atomic_load(&producer_waits);
            char where[128] = "";
            for(int w = 0, a = 0; w < workers; w++) a += snprintf(where + a, sizeof where - a, "%d", atomic_load(&worker_where[w]));
            printf("FS_STALL pool batches=%ld producer_waits=%d ready=%d work=%ld queue=%d..%d workers_waiting=%s\n", b, task,
                task >= 0 ? events[task].ready : -1, task >= 0 ? atomic_load(&work[task]) : -1L, pool.head, pool.tail, where);
        }
    }
    printf("FS_DONE stalls=%d\n", stalls);
    // (the threads may be stuck: no joins)
    _exit(stalls ? 1 : 0);
}
