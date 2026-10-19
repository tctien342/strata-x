// llama.cpp ngram-mod (MIT), common/ngram-mod.cpp b000431a and common/speculative.cpp 9aa51ce4.
// One bounded CPU pool per engine; only the per-request cursor/feedback belongs to a slot.
#pragma once
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <mutex>
#include <vector>

namespace strata::spec {
class NgramMod {
public:
    static constexpr size_t kMatch = 24, kMin = 48, kMax = 64;
    struct State { size_t learned = 0; int low = 0; };
    explicit NgramMod(int32_t vocab, size_t entries = 4 * 1024 * 1024)
        : vocab_(vocab), entries_(entries, -1) { assert(vocab > 0 && entries > 0); }

    void begin(State& state, const std::vector<int32_t>& history) {
        std::lock_guard<std::mutex> lock(mutex_);
        state = {};
        if (history.size() < kMatch) return;
        learn(history, 0);
        state.learned = history.size() - kMatch;
        if (used_ > entries_.size() / 4) clear();
    }

    // History is prompt + target-committed output, including the current input token.
    // Prove a 48..64-token chain as upstream, then copy only the owner's bounded prefix.
    int propose(State& state, const std::vector<int32_t>& history, int budget, int32_t* out) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (budget <= 0 || history.size() < kMatch) return 0;
        if (state.learned + 32 < history.size()) {
            learn(history, state.learned);
            state.learned = history.size() - kMatch;
        }
        std::array<int32_t, kMatch + kMax> chain{};
        std::copy_n(history.end() - kMatch, kMatch, chain.begin());
        size_t n = 0;
        for (; n < kMax; ++n) {
            const size_t i = index(chain.data() + n);
            const int32_t token = i < entries_.size() ? entries_[i] : -1;
            if (token < 0) break;
            chain[kMatch + n] = token;
        }
        if (n < kMin) return 0;
        const int count = std::min(budget, (int) n);
        std::copy_n(chain.data() + kMatch, count, out);
        return count;
    }

    // Feedback denominator is the actually verified prefix, not the unverified 64-token chain.
    void observe(State& state, int accepted, int offered) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (offered <= 0) return;
        if (accepted * 4 < offered) {
            if (++state.low >= 5) { clear(); state = {}; }
        } else state.low = 0;
    }
    size_t used() const { std::lock_guard<std::mutex> lock(mutex_); return used_; }
    size_t size_bytes() const { return entries_.size() * sizeof(int32_t); }

private:
    size_t index(const int32_t* tokens) const {
        uint64_t hash = 0;
        for (size_t j = 0; j < kMatch; ++j) {
            if (tokens[j] < 0 || tokens[j] >= vocab_) return entries_.size();
            hash = hash * 6364136223846793005ULL + (uint32_t) tokens[j];
        }
        return (size_t) (hash % entries_.size());
    }
    void learn(const std::vector<int32_t>& history, size_t start) {
        for (size_t j = start; j + kMatch < history.size(); ++j) {
            const int32_t token = history[j + kMatch];
            if (token < 0 || token >= vocab_) continue;
            const size_t i = index(history.data() + j);
            if (i == entries_.size()) continue;
            used_ += entries_[i] == -1;
            entries_[i] = token;
        }
    }
    void clear() { std::fill(entries_.begin(), entries_.end(), -1); used_ = 0; }
    int32_t vocab_;
    std::vector<int32_t> entries_;
    size_t used_ = 0;
    mutable std::mutex mutex_;
};
}  // namespace strata::spec
