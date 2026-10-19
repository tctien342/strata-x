# Terminal monitor assets

Purpose: same-origin Chat, fullscreen STRATA-X Monitor, About/settings and separate /api-monitor.
Structure: index.html selects content-versioned app/console/cube modules; app.js owns authentication/chat/preferences and existing one-second /metrics poll. Console assets preserve events, three-card telemetry, private-slot/context cards and merged residency accounting. expert-cube module owns browser-only WebGL; pinned Three.js r180 module/core/bloom helpers are local assets with THREE-LICENSE.txt. Existing CSS/fonts/sprite and separate monitor.html/js remain.
Dependencies: vanilla browser API, Three.js r180, read-only /metrics. Per-expert residency
telemetry is optional: the upstream engine on this branch does not publish it yet, and the
monitor then shows its empty state instead of inventing cells. No CDN requests, backend changes, new polling or inference actions.
Rules: static assets first, atomic index last; never restart inference for UI. Matrix counts each layer/expert once across main/auxiliary states, draft excluded. Physical capacity counts copies separately. Other panels retain their existing meanings: all-card hardware sums/mean/max, fresh-work prefill, actual finish outcomes and context=prompt+generated.
Entry points: /#monitor and StrataMonitor.render/unavailable/visibility. All6,144 unique groups contain four experts for48×512, packed into a19³ lattice including interior. Full Routing Map canvas with corner HUD, four real states, gentle color/opacity/glow transitions (95% toward the new state in about750ms; interruption retargets from the current appearance) with fixed cell size in idle/decode, visible blue-gray absent cells and clearer amber loading/evicting cells. The Routing Map uses the same dark panel tone with a subtle stationary blueprint grid. Translucent faces reveal interior cells; bright neon outlines preserve per-cell bloom. Bloom/emission are softened for dense activity; absent cells retain dim visible outlines during prefill. Active fraction increases emission; prefill wave amplitude increases emission as cells expand. Prefill triggers decorative radial cell-scale and brightness wave whenever either slot reads; decode/idle ease that wave out and restore constant cell scale; active-expert fraction changes light/glow only.
State: client-local WebGL instance matrices/colors, bounded events, rotation/selection/zoom. Drag orbit, wheel or+/− zoom (.55–2.5×), reset, Space pause, arrows exact group inspection. Hidden/offline suspends rendering; reduced motion freezes rotation and scaling waves; unsupported initial WebGL retains 2D grouped fallback. Rendering capped around30fps and1.5DPR; no engine utilization claim.
Deployment and rollback are retained in Strata-upstream-catchup-20261007/cube-monitor and project PROGRESS. Static rollback restores previous index/README, leaving unreferenced versioned files. Native binary/config/service PID must remain unchanged.

Expert capacity label: `TOTAL EXPERTS SLOTS (+AUX LITE)`. Values and copy-count semantics are unchanged.

Telemetry gauges: six compact SVG semicircles replace the history chart (decode, prefill, GPU load, VRAM, temperature, power). Small numbered labels, 60 fine radial ticks per gauge and gentle opacity transitions retain the terminal style. Main speed readouts stay; duplicated hardware readouts now live in the gauges. Three GPU rows use fixed-width stats fields, identical expanding meters and one line of utilization, VRAM, temperature, power and PCIe RX. Hardware retains three-card mean load, total VRAM/power and hottest temperature; missing values remain unavailable. Prefill waves ease in/out, with simultaneous decode activity glow and a mixed-phase HUD when the other slot reads. Local mixed and phase-cycle fixtures do not submit requests.

Full lattice:715 decorative cells fill unused positions in the19³ grid alongside6,144 real groups. Each takes color/alpha/active glow and prefill-wave scale from its nearest real neighbor (six adjacent positions first, Euclidean fallback for sparse layouts). Decorative cells do not enter expert totals, group bins, capacity or keyboard/pointer inspection. All6,859 positions are unique; the2D fallback remains real groups only.

Model display: the current qwen3.8-flash-next-iq3_s identifier is labeled QWEN3.8-FLASH-NEXT-GSQ-RCO-IQ3_S in the Routing Map. This is display-only; other model labels and the backend/API identifier stay unchanged.


## 2026-10-08 upstream 0.1.40.4 integration

Upstream6674a006 app.js compatibility fixes are merged; the STRATA-X terminal console/cube and all pinned versioned static assets remain byte-identical. No monitor polling, shader, layout or native telemetry behavior changes in this catch-up.


## Conversation RAM cache candidate

The existing generated Model settings form gains conversation_cache_mib from GET /config. It displays the configured RAM budget in MiB (8192 = 8 GiB), validates through the existing same-origin POST /config path, and retains the next-server-start apply semantics. The existing terminal assets and polling are preserved; a small versioned settings loader and desktop input-width override make the budget control usable. RAM and disk cache runtime qualification is separate from settings rendering.

The actual content-versioned terminal app lacked the upstream /config loader. A standalone cache-settings script now renders the existing Model settings form, sends only changed keys through the same-origin validated API, uses the API-key field, and states server-restart application. Its content-addressed asset is installed before index.html. Terminal/chat/monitor scripts and polling remain unchanged.

Cache budget UI verified in the actual browser:8192MiB visible, unchanged save is inert, negative values are rejected without persistence. A scoped versioned CSS asset gives the numeric field a readable desktop column; the existing ≤1000px single-column layout remains. Native and installed RAM/disk restart gates pass; see /root/Strata/Strata-ram-cache-20261013/deployment.json.
