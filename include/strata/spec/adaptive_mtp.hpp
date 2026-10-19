// Per-request draft depth. Counts drafts, excluding the verifier's current-token row.
#pragma once
#include <algorithm>

namespace strata::spec {
class AdaptiveMtp {
public:
    int depth() const { return depth_; }
    int limit(int budget) const { return std::min(depth_, std::max(0, budget)); }

    // Three consecutive eligible pure-MTP rounds form one acceptance window.
    // Clipped budgets, lookup/EOS/cancel rounds discard partial feedback.
    void observe(int requested, int offered, int accepted, bool eligible) {
        if (!eligible || requested != depth_) { rounds_ = offered_ = accepted_ = 0; return; }
        offered_ += offered;
        accepted_ += accepted;
        if (++rounds_ < 3) return;
        if (offered_ == 0 || accepted_ * 100 < offered_ * 65) depth_ = std::max(3, depth_ - 1);
        else if (accepted_ * 100 > offered_ * 80) depth_ = std::min(6, depth_ + 1);
        rounds_ = offered_ = accepted_ = 0;
    }
private:
    int depth_ = 3, rounds_ = 0, offered_ = 0, accepted_ = 0;
};
} // namespace strata::spec
