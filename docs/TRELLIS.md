# Trellis experts (TQP5 / TQP6 / TQP7) and Hadamard-folded packs

Strata-X reads the trellis-coded expert formats of the Gyro models — GGML types
147 `TQP5`, 148 `TQP6`, 149 `TQP7` (5/6/7 bits per step, 128 values per block,
15-bit trellis states, 8 KiB pair codebook) — on the CPU (AVX2, AVX-512, scalar)
and on CUDA (sm 86 and sm 120 in this build). TQ2_T / TQK6 / TQK7 (144–146) come
along, since the formats share the trellis machinery.

Provenance: the formats and kernels come from the Agention llama.cpp fork
(`gitlab.com/agentionai-group/llama.cpp`, commit `9aa51ce4`; ggml CPU reference
`50f7a8a`, AVX2 `vec_dot` `0f76b3d`, CUDA `e6ab9d5`), ported onto Strata's
native-expert pipeline. A pack is refused, never run wrong, when its
`native_experts.txt` is v5 (Hadamard-folded) and `hadamard.txt` is missing.

## Building

The trellis types need a ggml checkout that has them (the upstream llama.cpp
snapshot pinned by Strata does not). Point the build at the Agention fork:

    cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DSTRATA_NATIVE_EXPERTS=ON -DSTRATA_ENABLE_CUDA=ON \
      -DCMAKE_CUDA_ARCHITECTURES="86;120" \
      -DSTRATA_GGML_DIR=/path/to/agention-llama

Without the types the engine still builds; the MMQ instances and the trellis
parity tests are then skipped, and a pack whose experts are trellis types is
refused at start (no kernel).

## Paths

- Decode (one token): ggml-cpu's `vec_dot` for the type, through
  `native_expert.cpp`, exactly as before.
- Batched verification (2–8 tokens): Strata's own kernels
  (`tq_cpu.hpp`, `tq_avx2.cpp`, `tq_avx512.cpp`) decode a weight part once.
- Prompt: `moe_mmq.cu` with the fork's MMQ instances when ggml provides them
  (`STRATA_MMQ_TQ`), otherwise the FP16 dequant path.
- CUDA decode: decode-once per-entry kernels in `iq_kernels.cu` with the int8
  lane codebook (`tq_lut_i8.cuh`); bitwise equal to the per-entry kernels, and
  within the 3e-2 relative-L1 bound of ggml's float dequantizer.

## Switches

| env | effect |
|---|---|
| `STRATA_TQ_ISA=scalar\|avx2\|avx512` | cap the CPU kernel choice (tests, A/B) |
| `STRATA_NO_TQ_KERNELS=1` | use ggml-cpu's `vec_dot` for every trellis row (the pre-port path) |

The ggml-side A/B switches of the fork (`GGML_CUDA_TQ_MMVQ_ROWS`,
`GGML_CUDA_TQ_MMVQ_WIDE`, `GGML_CUDA_TQ_MMQ`) apply to llama.cpp's own kernels,
not to Strata's; on Blackwell (cc 12.0+) the fork's defaults turn the two
mat-vec layouts off.

## Tests

- `tq_cpu_parity` (also `... _avx2`): scalar vs AVX2 vs AVX-512 bit for bit,
  against ggml's `vec_dot`/`to_float`, plain and Hadamard-folded, 1–8 tokens.
- `native_hadamard_test`: a synthetic folded expert through Strata's CPU path
  against llama.cpp's graph (tq2_t/tqk6/tqk7/tqp5/tqp6/tqp7). ~8 min.
- `native_expert_parity --synthetic <gu>/<down>` and
  `--synthetic-hadamard <gu>/<down>` for the same pairs: CPU and both GPUs
  against the float reference, GPU dequantizers against `to_float`.

## Where the rotation is applied

A v5 pack stores gate/up rows as `H (s * x)` and down rows as `H (s * h)`,
so every reader of an activation must rotate it first. The pieces:

| reader | rotation |
|---|---|
| CPU experts (`native_expert.cpp`) | `native_quant_act` / `native_quant_h` rotate before quantizing |
| batched verification (`core/verify.cpp`) | `nat_xr_` holds the rotated `xm` for its q8_1 image (the shared expert keeps `xm`); `had_block`/`d_signs` in the layout make the grouped kernel rotate `h` |
| prompt (`prefill.cpp`) | `Xr` holds the rotated `mixed` for the MMQ `Xq`; the f16 `Xs` gather, the peer copies and `H` before the mmq/f16 down products are rotated too; the fused int8 route is skipped for a folded layer |
| peer GPU prefill | refused for a folded layer (no P2P pair has been qualified) |

`Xr`/`nat_xr_` and the device sign vectors are allocated only when the pack
has a folded layer, so an IQ pack keeps its old footprint. Rotating the
wrong copy (or forgetting one) shows up immediately: the model loads and
runs but emits garbage, which is how this wiring was found.
