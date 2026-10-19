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
| Adaptive MTP drafts | off | `--mtp-adaptive` (needs `--batch-mtp`) |
| Shared ngram-mod | off | `--ngram-mod` (needs `--batch-mtp`) |
| Disk prefix persistence | off | `--prefix-cache-dir`, `--prefix-cache-mib` (10240), `--prefix-cache-host-mib` (2048) |

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

`--mtp-adaptive` starts every batch slot at 3 drafts and moves one level between 3 and 6 after
three eligible windows: above 80% token-weighted acceptance grows, below 65% shrinks, and clipped,
lookup, EOS, cancel or terminal rounds discard the partial window.  The window is 8 rows, so two
active slots get at most 3 drafts each and a single active slot gets up to 6.  `STRATA_MTP_ADAPTIVE=1`
(and the private-fork alias `STRATA_SLOT_MTP_ADAPTIVE=1`) does the same.

`--ngram-mod` allocates one 16 MiB CPU hash table for the whole engine.  Each batch slot keeps its
own cursor and feedback and proposes 48-64-token chains from its own history; the target verifies
every token, a chain shorter than 48 tokens falls back to MTP, and five rounds below 25% accepted
clear that slot's feedback.  `STRATA_NGRAM_MOD=1` and the private alias `STRATA_SLOT_NGRAM_MOD=1`
select it.  Ported from llama.cpp ngram-mod (MIT).

`--prefix-cache-dir` (needs `--serve` and `--conversation-cache-mib`) writes every parked conversation to that
directory through the upstream session-file format: atomic rename, identity+config fingerprint, payload hash.
Startup reads the newest files first into the same RAM conversation cache, bounded by
`--prefix-cache-host-mib` and the existing memory-admission floor; the disk budget evicts the oldest files.
Reuse semantics are the upstream cache's (including borrowing a shared system prefix); corrupt, foreign or
tampered files are refused by the reader and skipped.
