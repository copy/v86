#include "exception.hh"
#include <cstdio>
#include <cstring>

errno_exception::errno_exception(int errno)
    : _errno(errno)
{
}

int errno_exception::errno() const
{
    return _errno;
}

const char *errno_exception::what()
{
    std::snprintf(_buf, sizeof _buf, "error: %s (%d)",
		  std::strerror(_errno), _errno);
    return _buf;
}

int try_main(int (*main)(int argc, char** argv), int argc, char** argv,
	     int ret_on_exception)
{
    try {
        return main(argc, argv);
    } catch (std::exception& e) {
        std::fprintf(stderr, "exception: %s\n", e.what());
    } catch (...) {
        std::fprintf(stderr, "unknown exception\n");
    }
    return ret_on_exception;
}
