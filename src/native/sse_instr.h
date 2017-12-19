#ifndef _SSE_H
#define _SSE_H

void mov_r_m64(int32_t addr, int32_t r);
void movl_r128_m64(int32_t addr, int32_t r);
void mov_r_r128(int32_t r1, int32_t r2);
void mov_r_m128(int32_t addr, int32_t r);
void mov_rm_r128(union reg128 source, int32_t r);
void movh_m64_r128(int32_t addr, int32_t r);
void movh_r128_m64(int32_t addr, int32_t r);

void pand_r128(union reg128 source, int32_t r);
void pxor_r128(union reg128 source, int32_t r);

void psrlw_r64(int32_t r, uint32_t shift);
void psraw_r64(int32_t r, uint32_t shift);
void psllw_r64(int32_t r, uint32_t shift);
void psrld_r64(int32_t r, uint32_t shift);
void psrad_r64(int32_t r, uint32_t shift);
void pslld_r64(int32_t r, uint32_t shift);
void psrlq_r64(int32_t r, uint32_t shift);
void psllq_r64(int32_t r, uint32_t shift);

void psrlw_r128(int32_t r, uint32_t shift);
void psraw_r128(int32_t r, uint32_t shift);
void psllw_r128(int32_t r, uint32_t shift);
void psrld_r128(int32_t r, uint32_t shift);
void psrad_r128(int32_t r, uint32_t shift);
void pslld_r128(int32_t r, uint32_t shift);
void psrlq_r128(int32_t r, uint32_t shift);
void psllq_r128(int32_t r, uint32_t shift);

#endif
