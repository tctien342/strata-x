// src/kernels/cpu/tq_avx2.cpp - the trellis expert rows (TQ2_T / TQK6 / TQK7) on AVX2 + FMA (tq_cpu.hpp).
// Compiled for AVX2 only and reached behind cpu_avx2_ok(), so nothing here can fault on an older CPU.
//
// Per 128-weight block: the 32 states in scalar code (tq_states.hpp: one 32-bit read, a shift and a mask each, used
// as table indices straight away), four 8-byte state-table rows per YMM register as scalar loads, then per token
// VPMADDWD against the unpacked int16 activations and a VPHADDD tree that leaves the four exact sub-block sums
// S[k] in one XMM, so the float part is the scalar kernel's, lane for lane.  The weights are decoded once per block
// for all the tokens of the group.
//
// Measured on Zen 5 (cycles per block, one token, AVX2): ~48 with this scheme; computing the states with byte
// shuffles instead (VPSHUFB / VPSRLVD per 8 states) and moving them to GPRs or through memory was slower (60-80),
// and ggml-cpu's AVX2 vec_dot for these types (agentionai llama.cpp, the same state table) takes about 2.3x as long.
#include "strata/kernels/cpu/tq_cpu.hpp"

#include "tq_states.hpp"

#include <immintrin.h>

namespace strata::kernels::cpu::tq_detail {
namespace {

// four state-table rows (8 bytes each) into one YMM: a load and three broadcast loads blended in.  Broadcast loads
// and VPBLENDD avoid the shuffle port that VPINSRQ / VINSERTI128 need (the two measure the same on Zen 5).
inline __m256i rows4(const long long* tab, uint32_t s0, uint32_t s1, uint32_t s2, uint32_t s3) {
    __m256i v = _mm256_castsi128_si256(_mm_loadl_epi64((const __m128i*) (tab + s0)));
    v = _mm256_blend_epi32(v, _mm256_set1_epi64x(tab[s1]), 0x0C);
    v = _mm256_blend_epi32(v, _mm256_set1_epi64x(tab[s2]), 0x30);
    return _mm256_blend_epi32(v, _mm256_set1_epi64x(tab[s3]), 0xC0);
}

template <int KB>
void rows_t(const uint8_t* w, size_t row_bytes, int n, const TqAct* const* a, int nt, float* const* out, int r0,
            int r1) {
    const int nb = n / 128;
    constexpr size_t bsz = 2 + 4 * KB;
    const long long* tab = (const long long*) tq_state_table();
    for (int r = r0; r < r1; ++r) {
        const uint8_t* x = w + (size_t) r * row_bytes;
        __m128 acc[kTqMaxTokens];
        for (int t = 0; t < nt; ++t) acc[t] = _mm_setzero_ps();
        for (int i = 0; i < nb; ++i) {
            const uint8_t* blk = x + (size_t) i * bsz;
            const uint8_t* qs = blk + 2;
            const uint64_t wr = tq_wrap<KB>(qs);
            __m256i wv[8];   // wv[m] = weights 16m .. 16m+15 (states 4m .. 4m+3)
#if defined(__GNUC__)
#pragma GCC unroll 8
#endif
            for (int m = 0; m < 8; ++m)
                wv[m] = rows4(tab, tq_state<KB>(qs, wr, 4 * m), tq_state<KB>(qs, wr, 4 * m + 1),
                              tq_state<KB>(qs, wr, 4 * m + 2), tq_state<KB>(qs, wr, 4 * m + 3));
            const __m128 dx = _mm_set1_ps(tq_half_to_float(tq_ld16(blk)));
            for (int t = 0; t < nt; ++t) {
                const __m256i* q = (const __m256i*) (a[t]->q + 128 * i);
                const __m256i p0 = _mm256_add_epi32(_mm256_madd_epi16(wv[0], _mm256_load_si256(q + 0)),
                                                    _mm256_madd_epi16(wv[1], _mm256_load_si256(q + 1)));
                const __m256i p1 = _mm256_add_epi32(_mm256_madd_epi16(wv[2], _mm256_load_si256(q + 2)),
                                                    _mm256_madd_epi16(wv[3], _mm256_load_si256(q + 3)));
                const __m256i p2 = _mm256_add_epi32(_mm256_madd_epi16(wv[4], _mm256_load_si256(q + 4)),
                                                    _mm256_madd_epi16(wv[5], _mm256_load_si256(q + 5)));
                const __m256i p3 = _mm256_add_epi32(_mm256_madd_epi16(wv[6], _mm256_load_si256(q + 6)),
                                                    _mm256_madd_epi16(wv[7], _mm256_load_si256(q + 7)));
                // per 128-bit lane [p0, p1, p2, p3] partial sums, then the two lanes added: S[0..3], exact
                const __m256i h = _mm256_hadd_epi32(_mm256_hadd_epi32(p0, p1), _mm256_hadd_epi32(p2, p3));
                const __m128i s = _mm_add_epi32(_mm256_castsi256_si128(h), _mm256_extracti128_si256(h, 1));
                const __m128 sc = _mm_mul_ps(dx, _mm_loadu_ps(a[t]->d + 4 * i));
                acc[t] = _mm_fmadd_ps(_mm_cvtepi32_ps(s), sc, acc[t]);
            }
        }
        for (int t = 0; t < nt; ++t) {
            alignas(16) float v[4];
            _mm_store_ps(v, acc[t]);
            out[t][r] = ((v[0] + v[1]) + (v[2] + v[3])) * (1.0f / 8192.0f);
        }
    }
}

// Pinned Agention TQP pair decoder, reused across all tokens instead of decoding per token.
// Keep the upstream eight FMA lanes/reduction order so single/grouped rows have identical bits.
template <int KB>
inline __m256i pair_lane(const int32_t* cb, const uint8_t* qs, int lane) {
    auto ld64 = [](const uint8_t* p) { uint64_t v; std::memcpy(&v, p, 8); return v; };
    const uint64_t w = lane == 0 ? (ld64(qs + 8 * KB - 8) >> (8 * (8 - KB))) | (ld64(qs) << (8 * KB))
                                : ld64(qs + (7 - lane) * KB);
    auto pair = [&](int j) { return cb[(((uint32_t) (w >> ((7 - j) * KB)) & kTqStateMask) * 0x9e3779b1u) >> 21]; };
    __m256i v = _mm256_castsi128_si256(_mm_cvtsi32_si128(pair(0)));
    v = _mm256_blend_epi32(v, _mm256_set1_epi32(pair(1)), 0x02);
    v = _mm256_blend_epi32(v, _mm256_set1_epi32(pair(2)), 0x04);
    v = _mm256_blend_epi32(v, _mm256_set1_epi32(pair(3)), 0x08);
    v = _mm256_blend_epi32(v, _mm256_set1_epi32(pair(4)), 0x10);
    v = _mm256_blend_epi32(v, _mm256_set1_epi32(pair(5)), 0x20);
    v = _mm256_blend_epi32(v, _mm256_set1_epi32(pair(6)), 0x40);
    return _mm256_blend_epi32(v, _mm256_set1_epi32(pair(7)), 0x80);
}

template <int KB>
void pair_rows(const uint8_t* w, size_t rb, int n, const TqAct* const* a, int nt, float* const* out, int r0, int r1) {
    const int32_t* cb = tq_pair_table();
    for (int r = r0; r < r1; ++r) {
        __m256 acc[kTqMaxTokens];
        for (int t = 0; t < nt; ++t) acc[t] = _mm256_setzero_ps();
        for (int b = 0; b < n / 128; ++b) {
            const uint8_t* blk = w + (size_t) r * rb + (size_t) b * (2 + 8 * KB);
            const float dx = _cvtsh_ss(tq_ld16(blk));
            for (int k = 0; k < 4; ++k) {
                const __m256i w0 = pair_lane<KB>(cb, blk + 2, 2 * k);
                const __m256i w1 = pair_lane<KB>(cb, blk + 2, 2 * k + 1);
                for (int t = 0; t < nt; ++t) {
                    const __m256i* q = (const __m256i*) (a[t]->q + 128 * b + 32 * k);
                    const __m256i dot = _mm256_add_epi32(_mm256_madd_epi16(w0, _mm256_load_si256(q)),
                                                        _mm256_madd_epi16(w1, _mm256_load_si256(q + 1)));
                    acc[t] = _mm256_fmadd_ps(_mm256_cvtepi32_ps(dot), _mm256_set1_ps(dx * a[t]->d[4 * b + k]), acc[t]);
                }
            }
        }
        for (int t = 0; t < nt; ++t) {
            __m128 v = _mm_add_ps(_mm256_extractf128_ps(acc[t], 1), _mm256_castps256_ps128(acc[t]));
            v = _mm_add_ps(v, _mm_movehl_ps(v, v));
            v = _mm_add_ss(v, _mm_movehdup_ps(v));
            out[t][r] = _mm_cvtss_f32(v) / 8192.f;
        }
    }
}

}  // namespace

void tqp_rows_avx2(int kb, const uint8_t* w, size_t rb, int n, const TqAct* const* a, int nt,
                   float* const* out, int r0, int r1) {
    if (kb == 5) pair_rows<5>(w, rb, n, a, nt, out, r0, r1);
    else if (kb == 6) pair_rows<6>(w, rb, n, a, nt, out, r0, r1);
    else pair_rows<7>(w, rb, n, a, nt, out, r0, r1);
}

void tq_rows_avx2(int kb, const uint8_t* w, size_t row_bytes, int n, const TqAct* const* a, int nt,
                  float* const* out, int r0, int r1) {
    if (kb == 8) rows_t<8>(w, row_bytes, n, a, nt, out, r0, r1);
    else if (kb == 6) rows_t<6>(w, row_bytes, n, a, nt, out, r0, r1);
    else rows_t<7>(w, row_bytes, n, a, nt, out, r0, r1);
}

}  // namespace strata::kernels::cpu::tq_detail
