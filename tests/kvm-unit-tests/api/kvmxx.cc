#include "kvmxx.hh"
#include "exception.hh"
#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <stdlib.h>
#include <memory>
#include <algorithm>

namespace kvm {

static long check_error(long r)
{
    if (r == -1) {
	throw errno_exception(errno);
    }
    return r;
}

fd::fd(int fd)
    : _fd(fd)
{
}

fd::fd(const fd& other)
    : _fd(::dup(other._fd))
{
    check_error(_fd);
}

fd::fd(std::string device_node, int flags)
    : _fd(::open(device_node.c_str(), flags))
{
    check_error(_fd);
}

long fd::ioctl(unsigned nr, long arg)
{
    return check_error(::ioctl(_fd, nr, arg));
}

vcpu::vcpu(vm& vm, int id)
    : _vm(vm), _fd(vm._fd.ioctl(KVM_CREATE_VCPU, id)), _shared(NULL)
    , _mmap_size(_vm._system._fd.ioctl(KVM_GET_VCPU_MMAP_SIZE, 0))

{
    kvm_run *shared = static_cast<kvm_run*>(::mmap(NULL, _mmap_size,
						   PROT_READ | PROT_WRITE,
						   MAP_SHARED,
						   _fd.get(), 0));
    if (shared == MAP_FAILED) {
	throw errno_exception(errno);
    }
    _shared = shared;
}

vcpu::~vcpu()
{
    munmap(_shared, _mmap_size);
}

void vcpu::run()
{
    _fd.ioctl(KVM_RUN, 0);
}

kvm_regs vcpu::regs()
{
    kvm_regs regs;
    _fd.ioctlp(KVM_GET_REGS, &regs);
    return regs;
}

void vcpu::set_regs(const kvm_regs& regs)
{
    _fd.ioctlp(KVM_SET_REGS, const_cast<kvm_regs*>(&regs));
}

kvm_sregs vcpu::sregs()
{
    kvm_sregs sregs;
    _fd.ioctlp(KVM_GET_SREGS, &sregs);
    return sregs;
}

void vcpu::set_sregs(const kvm_sregs& sregs)
{
    _fd.ioctlp(KVM_SET_SREGS, const_cast<kvm_sregs*>(&sregs));
}

class vcpu::kvm_msrs_ptr {
public:
    explicit kvm_msrs_ptr(size_t nmsrs);
    ~kvm_msrs_ptr() { ::free(_kvm_msrs); }
    kvm_msrs* operator->() { return _kvm_msrs; }
    kvm_msrs* get() { return _kvm_msrs; }
private:
    kvm_msrs* _kvm_msrs;
};

vcpu::kvm_msrs_ptr::kvm_msrs_ptr(size_t nmsrs)
    : _kvm_msrs(0)
{
    size_t size = sizeof(kvm_msrs) + sizeof(kvm_msr_entry) * nmsrs;
    _kvm_msrs = static_cast<kvm_msrs*>(::malloc(size));
    if (!_kvm_msrs) {
	throw std::bad_alloc();
    }
}

std::vector<kvm_msr_entry> vcpu::msrs(std::vector<uint32_t> indices)
{
    kvm_msrs_ptr msrs(indices.size());
    msrs->nmsrs = indices.size();
    for (unsigned i = 0; i < msrs->nmsrs; ++i) {
	msrs->entries[i].index = indices[i];
    }
    _fd.ioctlp(KVM_GET_MSRS, msrs.get());
    return std::vector<kvm_msr_entry>(msrs->entries,
				      msrs->entries + msrs->nmsrs);
}

void vcpu::set_msrs(const std::vector<kvm_msr_entry>& msrs)
{
    kvm_msrs_ptr _msrs(msrs.size());
    _msrs->nmsrs = msrs.size();
    std::copy(msrs.begin(), msrs.end(), _msrs->entries);
    _fd.ioctlp(KVM_SET_MSRS, _msrs.get());
}

void vcpu::set_debug(uint64_t dr[8], bool enabled, bool singlestep)
{
    kvm_guest_debug gd;

    gd.control = 0;
    if (enabled) {
	gd.control |= KVM_GUESTDBG_ENABLE;
    }
    if (singlestep) {
	gd.control |= KVM_GUESTDBG_SINGLESTEP;
    }
    for (int i = 0; i < 8; ++i) {
	gd.arch.debugreg[i] = dr[i];
    }
    _fd.ioctlp(KVM_SET_GUEST_DEBUG, &gd);
}

vm::vm(system& system)
    : _system(system), _fd(system._fd.ioctl(KVM_CREATE_VM, 0))
{
}

void vm::set_memory_region(int slot, void *addr, uint64_t gpa, size_t len,
                           uint32_t flags)
{
    struct kvm_userspace_memory_region umr;

    umr.slot = slot;
    umr.flags = flags;
    umr.guest_phys_addr = gpa;
    umr.memory_size = len;
    umr.userspace_addr = reinterpret_cast<uintptr_t>(addr);
    _fd.ioctlp(KVM_SET_USER_MEMORY_REGION, &umr);
}

void vm::get_dirty_log(int slot, void *log)
{
    struct kvm_dirty_log kdl;
    kdl.slot = slot;
    kdl.dirty_bitmap = log;
    _fd.ioctlp(KVM_GET_DIRTY_LOG, &kdl);
}

void vm::set_tss_addr(uint32_t addr)
{
    _fd.ioctl(KVM_SET_TSS_ADDR, addr);
}

void vm::set_ept_identity_map_addr(uint64_t addr)
{
    _fd.ioctlp(KVM_SET_IDENTITY_MAP_ADDR, &addr);
}

system::system(std::string device_node)
    : _fd(device_node, O_RDWR)
{
}

bool system::check_extension(int extension)
{
    return _fd.ioctl(KVM_CHECK_EXTENSION, extension);
}

int system::get_extension_int(int extension)
{
    return _fd.ioctl(KVM_CHECK_EXTENSION, extension);
}

};
