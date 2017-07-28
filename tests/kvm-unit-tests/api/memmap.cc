
#include "memmap.hh"
#include <numeric>

mem_slot::mem_slot(mem_map& map, uint64_t gpa, uint64_t size, void* hva)
    : _map(map)
    , _slot(map._free_slots.top())
    , _gpa(gpa)
    , _size(size)
    , _hva(hva)
    , _dirty_log_enabled(false)
    , _log()
{
    map._free_slots.pop();
    if (_size) {
        update();
    }
}

mem_slot::~mem_slot()
{
    if (!_size) {
        return;
    }
    _size = 0;
    try {
        update();
        _map._free_slots.push(_slot);
    } catch (...) {
        // can't do much if we can't undo slot registration - leak the slot
    }
}

void mem_slot::set_dirty_logging(bool enabled)
{
    if (_dirty_log_enabled != enabled) {
        _dirty_log_enabled = enabled;
        if (enabled) {
            int logsize = ((_size >> 12) + bits_per_word - 1) / bits_per_word;
            _log.resize(logsize);
        } else {
            _log.resize(0);
        }
        if (_size) {
            update();
        }
    }
}

void mem_slot::update()
{
    uint32_t flags = 0;
    if (_dirty_log_enabled) {
        flags |= KVM_MEM_LOG_DIRTY_PAGES;
    }
    _map._vm.set_memory_region(_slot, _hva, _gpa, _size, flags);
}

bool mem_slot::dirty_logging() const
{
    return _dirty_log_enabled;
}

static inline int hweight(uint64_t w)
{
    w -= (w >> 1) & 0x5555555555555555;
    w =  (w & 0x3333333333333333) + ((w >> 2) & 0x3333333333333333);
    w =  (w + (w >> 4)) & 0x0f0f0f0f0f0f0f0f;
    return (w * 0x0101010101010101) >> 56;
}

int mem_slot::update_dirty_log()
{
    _map._vm.get_dirty_log(_slot, &_log[0]);
    return std::accumulate(_log.begin(), _log.end(), 0,
                           [] (int prev, ulong elem) -> int {
                               return prev + hweight(elem);
                           });
}

bool mem_slot::is_dirty(uint64_t gpa) const
{
    uint64_t pagenr = (gpa - _gpa) >> 12;
    ulong wordnr = pagenr / bits_per_word;
    ulong bit = 1ULL << (pagenr % bits_per_word);
    return _log[wordnr] & bit;
}

mem_map::mem_map(kvm::vm& vm)
    : _vm(vm)
{
    int nr_slots = vm.sys().get_extension_int(KVM_CAP_NR_MEMSLOTS);
    for (int i = 0; i < nr_slots; ++i) {
        _free_slots.push(i);
    }
}
