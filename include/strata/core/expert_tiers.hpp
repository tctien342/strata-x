// include/strata/core/expert_tiers.hpp - Strata-X: a soft placement preference for experts a CPU computes well.
//
// The demand prior is a ranking (layer, expert) hottest first.  An eligible expert's score is scaled by 0.75,
// so it moves behind an equally hot ineligible one but a hot eligible expert still wins GPU space.  Eligibility
// is the caller's predicate: this file only orders; it never changes routed experts, weights or quantization.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <utility>
#include <vector>

namespace strata::core {

template<class Eligible>
std::vector<std::pair<int32_t, int32_t>> rank_light_experts(
    const std::vector<std::pair<int32_t, int32_t>>& prior, Eligible eligible, bool enabled, double weight = 0.75) {
    if (!enabled) return prior;
    struct Ranked { size_t rank; double score; };
    std::vector<Ranked> ranked;
    ranked.reserve(prior.size());
    for (size_t i = 0; i < prior.size(); ++i)
        ranked.push_back({i, (eligible(prior[i].first) ? weight : 1.0) * std::pow(double(i + 1), -1.2)});
    std::sort(ranked.begin(), ranked.end(), [](const Ranked& a, const Ranked& b) {
        return a.score != b.score ? a.score > b.score : a.rank < b.rank;
    });
    std::vector<std::pair<int32_t, int32_t>> result;
    result.reserve(prior.size());
    for (const auto& row : ranked) result.push_back(prior[row.rank]);
    return result;
}

} // namespace strata::core
