#ifndef KVMXX_H
#define KVMXX_H

#include <string>
#include <signal.h>
#include <unistd.h>
#include <vector>
#include <errno.h>
#include <linux/kvm.h>
#include <stdint.h>

namespace kvm {

class system;
class vm;
class vcpu;
class fd;

class fd {
public:
    explicit fd(int n);
    explicit fd(std::string path, int flags);
    fd(const fd& other);
    ~fd() { ::close(_fd); }
    int get() { return _fd; }
    long ioctl(unsigned nr, long arg);
    long ioctlp(unsigned nr, void *arg) {
	return ioctl(nr, reinterpret_cast<long>(arg));
    }
private:
    int _fd;
};

class vcpu {
public:
    vcpu(vm& vm, int fd);
    ~vcpu();
    void run();
    kvm_run *shared();
    kvm_regs regs();
    void set_regs(const kvm_regs& regs);
    kvm_sregs sregs();
    void set_sregs(const kvm_sregs& sregs);
    std::vector<kvm_msr_entry> msrs(std::vector<uint32_t> indices);
    void set_msrs(const std::vector<kvm_msr_entry>& msrs);
    void set_debug(uint64_t dr[8], bool enabled, bool singlestep);
private:
    class kvm_msrs_ptr;
private:
    vm& _vm;
    fd _fd;
    kvm_run *_shared;
    unsigned _mmap_size;
    friend class vm;
};

class vm {
public:
    explicit vm(system& system);
    void set_memory_region(int slot, void *addr, uint64_t gpa, size_t len,
                           uint32_t flags = 0);
    void get_dirty_log(int slot, void *log);
    void set_tss_addr(uint32_t addr);
    void set_ept_identity_map_addr(uint64_t addr);
    system& sys() { return _system; }
private:
    system& _system;
    fd _fd;
    friend class system;
    friend class vcpu;
};

class system {
public:
    explicit system(std::string device_node = "/dev/kvm");
    bool check_extension(int extension);
    int get_extension_int(int extension);
private:
    fd _fd;
    friend class vcpu;
    friend class vm;
};

};

#endif
