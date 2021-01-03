#ifndef MEMMAP_HH
#define MEMMAP_HH

#include "kvmxx.hh"
#include <stdint.h>
#include <vector>
#include <stack>

class mem_map;
class mem_slot;

class mem_slot {
public:
    mem_slot(mem_map& map, uint64_t gpa, uint64_t size, void *hva);
    ~mem_slot();
    void set_dirty_logging(bool enabled);
    bool dirty_logging() const;
    int update_dirty_log();
    bool is_dirty(uint64_t gpa) const;
private:
    void update();
private:
    typedef unsigned long ulong;
    static const int bits_per_word = sizeof(ulong) * 8;
    mem_map& _map;
    int _slot;
    uint64_t _gpa;
    uint64_t _size;
    void *_hva;
    bool _dirty_log_enabled;
    std::vector<ulong> _log;
};

class mem_map {
public:
    mem_map(kvm::vm& vm);
private:
    kvm::vm& _vm;
    std::stack<int> _free_slots;
    friend class mem_slot;
};

#endif
