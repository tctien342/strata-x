#pragma once
/// STRATA-X: the opt-in decode-cache telemetry of the console's MoE residency matrix.  With
/// `STRATA_EXPERT_MONITOR=1` the engine prints one bounded frame per published change:
///
///     ER <layers> <experts> <device per layer, comma separated> <state per expert, layer major>
///
/// where a state is `0` (not in a GPU's cache), `1` (cached, not routed within the last second) or `3` (routed
/// within it).  `2` is reserved; nothing in this build stages a transfer to show.  The serving layer consumes
/// frames in its engine-output pump and never forwards them: they are protocol, not log lines.
///
/// The residency map is copied only from the thread that owns the caches, at its existing mutation boundaries;
/// `routed()` is called by the pool threads and touches only this object's own mutex-protected mirror.  No CUDA
/// call, allocation or synchronisation is involved.
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <string>
#include <vector>

namespace strata::core {

class ExpertMonitor {
public:
    using Clock = std::chrono::steady_clock;

    ExpertMonitor(int64_t layers, int64_t experts, std::string devices)
        : layers_(layers), experts_(experts), devices_(std::move(devices)),
          resident_((size_t) (layers * experts), -1), seen_(resident_.size()) {}

    /// The router's pick for `layer`: `count` ids, as the pool threads see them after a dispatch.
    void routed(int64_t layer, const int32_t* ids, int64_t count, Clock::time_point now = Clock::now()) {
        if (layer < 0 || layer >= layers_) return;
        std::lock_guard<std::mutex> lk(mu_);
        for (int64_t j = 0; j < count; ++j)
            if (ids[j] >= 0 && ids[j] < experts_)
                seen_[(size_t) layer * (size_t) experts_ + (size_t) ids[j]] = now;
    }

    /// Copy the caches' `(layer, expert) -> device` map (or -1).  Call it where the caches are mutated, never
    /// from a pool thread: a map read while an eviction rewrites it would be a torn one.
    void snapshot(const std::vector<int32_t>& map) {
        std::lock_guard<std::mutex> lk(mu_);
        if (map.size() == resident_.size()) resident_ = map;
    }

    /// The frame the serving pump parses, without printing it (the test reads this).
    std::string frame(Clock::time_point now = Clock::now()) {
        std::lock_guard<std::mutex> lk(mu_);
        std::string states(resident_.size(), '0');
        for (size_t i = 0; i < states.size(); ++i) {
            if (resident_[i] < 0) continue;
            states[i] = seen_[i] != Clock::time_point{} && now - seen_[i] < std::chrono::seconds(1) ? '3' : '1';
        }
        return "ER " + std::to_string(layers_) + " " + std::to_string(experts_) + " " + devices_ + " " + states;
    }

    /// Print a frame to stdout, at most one every 250 ms unless forced (the start, the end of a request).
    void publish(bool force = false) {
        const auto now = Clock::now();
        {
            std::lock_guard<std::mutex> lk(mu_);
            if (!force && now - published_ < std::chrono::milliseconds(250)) return;
            published_ = now;
        }
        std::printf("%s\n", frame(now).c_str());
        std::fflush(stdout);
    }

private:
    int64_t layers_, experts_;
    std::string devices_;
    std::mutex mu_;
    std::vector<int32_t> resident_;                  ///< layer * experts + expert -> device stage, or -1
    std::vector<Clock::time_point> seen_;            ///< last routing of each (layer, expert)
    Clock::time_point published_{};
};

}  // namespace strata::core
