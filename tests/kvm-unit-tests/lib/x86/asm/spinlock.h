#ifndef __ASM_SPINLOCK_H
#define __ASM_SPINLOCK_H

struct spinlock {
    int v;
};

void spin_lock(struct spinlock *lock);
void spin_unlock(struct spinlock *lock);

#endif
