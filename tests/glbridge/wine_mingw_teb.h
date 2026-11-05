/* Standalone MinGW declarations for the unmodified Wine D3D8 visual test.
 * Field offsets are from Wine 415a275e3844c252ad385b46023095e9401ca234,
 * include/winternl.h: TEB32.GdiBatchCount, TEB64.Peb and PEB64.LdrData.
 * Only those ABI fields are exposed. The actual Wow64 detection and branch
 * remain in the upstream test; this header does not force their result. */
#ifndef D3D_WINE_MINGW_TEB_H
#define D3D_WINE_MINGW_TEB_H
#include <windows.h>
#include <winternl.h>
#include <stddef.h>
typedef struct { BYTE reserved[0xf70]; ULONG GdiBatchCount; } WineTestTEB32;
typedef struct { BYTE reserved[0x60]; ULONG64 Peb; } TEB64;
typedef struct { BYTE reserved[0x18]; ULONG64 LdrData; } PEB64;
_Static_assert(sizeof(void *) == 4, "This standalone runner targets 32-bit XP");
_Static_assert(offsetof(WineTestTEB32, GdiBatchCount) == 0xf70, "TEB32 ABI");
_Static_assert(offsetof(TEB64, Peb) == 0x60, "TEB64 ABI");
_Static_assert(offsetof(PEB64, LdrData) == 0x18, "PEB64 ABI");
#define NtCurrentTeb() ((WineTestTEB32 *)(NtCurrentTeb)())
#endif
