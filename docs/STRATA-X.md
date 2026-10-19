# Strata-X fork

This branch is the owner's fork of upstream Strata, rebuilt on **0.1.45 / `477ac13c`** with a
short, separately committed feature set. The goal is to keep upstream merges cheap: engine
defaults stay upstream-identical unless noted, and every divergence is listed here.

| Feature | Default | Control |
| --- | --- | --- |
| INT8 rotated K/V | on in the serving layer | run config `env` `STRATA_KV_ROT=0` |
| Conversation cache | 8192 MiB parked conversations | `conversation_cache_mib` (0 disables) |
| STRATA-X console | on (product UI) | static assets under `serve/web/` |
| Light-expert CPU preference | off | `--light-expert-cpu`, `--light-expert-max-mib` (2) |

## Defaults and rationale

The serving layer (`serve/server.py`) starts the engine with `STRATA_KV_ROT=1`. The engine
itself keeps upstream's opt-in default, so a stock engine invocation is unchanged. The rotated
INT8 K/V layout is the one the owner's model/profile, snapshot tests and existing 262K context
were qualified with; the unrotated layout remains one config override away.

## Rebase policy

- One feature per commit, tests and this file updated in the same commit.
- New engine behavior is opt-in unless a serving default is listed in the table above.
- Ported third-party code keeps its attribution (for example llama.cpp's MIT ngram-mod).
- No private scheduling/verifier/ownership rewrite: features plug into upstream interfaces.

`conversation_cache_mib` is a Settings key (and a run-config key). `engine_args` appends
`--conversation-cache-mib` when the config's raw args do not already carry one, so an explicit
`0` is preserved and an explicit engine argument wins. The engine-side default stays upstream's
`0` (off); only the serving layer parks conversations by default.

The console replaces upstream's index page with the STRATA-X chat/monitor shell: the
terminal layout, six gauges, conversation-cache settings card and the Three.js r180 expert
cube (vendored locally, `THREE-LICENSE.txt`). Upstream's `app.js` is retained but no longer
referenced. The upstream engine does not publish per-expert residency telemetry yet, so the
monitor keeps its honest "awaiting residency telemetry" state instead of inventing cells.

`--light-expert-cpu` reorders a static `--expert-profile` prior only: an expert is eligible when the
layer format has a native CPU kernel for this geometry AND its per-expert blob is at most
`--light-expert-max-mib` (default 2).  Eligible experts get a 0.75 demand weight, so the GPU still
takes a hot one first; routed experts, weights, quantization and budgets are unchanged.  Without a
profile there is no prior to reorder, so the flag does nothing.
