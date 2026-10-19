#include "strata/spec/adaptive_mtp.hpp"
#include <cstdio>
using strata::spec::AdaptiveMtp;
int main() {
    int failures = 0, checks = 0;
    auto check = [&](bool ok, const char* why) { ++checks; if (!ok) { ++failures; std::printf("FAIL %s\n", why); } };
    auto full_window = [](AdaptiveMtp& p) { const int d = p.depth(); for (int n = 0; n < 3; ++n) p.observe(d, d, d, true); };
    AdaptiveMtp p, peer;
    check(p.depth() == 3, "cold depth");
    p.observe(3, 3, 2, true); p.observe(3, 3, 2, true);
    check(p.depth() == 3, "wait for three rounds");
    p.observe(3, 3, 2, true);
    check(p.depth() == 3, "six of nine stays in holding range");
    full_window(p);
    check(p.depth() == 4, "full new window grows after hold");
    p.observe(4, 4, 3, true); p.observe(4, 4, 2, true);
    check(p.depth() == 4, "no early decrease");
    p.observe(4, 4, 2, true);
    check(p.depth() == 3, "seven of twelve drops one level");
    for (int n = 0; n < 30; ++n) p.observe(3, 3, 0, true);
    check(p.depth() == 3, "minimum three");
    full_window(p); full_window(p); full_window(p);
    check(p.depth() == 6, "grow to six");
    for (int n = 0; n < 30; ++n) p.observe(6, 6, 6, true);
    check(p.depth() == 6, "six draft ceiling");
    p.observe(6, 6, 4, true); p.observe(6, 6, 4, true); p.observe(6, 5, 3, true);
    check(p.depth() == 5, "eleven of seventeen is below 65 percent");
    // Token-weighted acceptance, not the mean of per-round percentages.
    p.observe(5, 1, 1, true); p.observe(5, 1, 1, true); p.observe(5, 5, 2, true);
    check(p.depth() == 4, "four of seven drops despite high unweighted mean");
    p.observe(4, 1, 0, true); p.observe(4, 4, 4, true); p.observe(4, 4, 4, true);
    check(p.depth() == 5, "eight of nine grows despite low unweighted mean");
    for (int n = 0; n < 3; ++n) p.observe(5, 5, 4, true);
    check(p.depth() == 5, "exactly 80 percent holds");
    for (int n = 0; n < 3; ++n) p.observe(5, 0, 0, true);
    check(p.depth() == 4, "three empty confidence rounds decrease");
    check(peer.depth() == 3, "independent request");
    for (int cap = 0; cap <= 8; ++cap) check(p.limit(cap) == (cap < 4 ? cap : 4), "budget clipping");
    p.observe(4, 4, 4, true); p.observe(4, 4, 4, true);
    p.observe(3, 3, 3, true); p.observe(4, 4, 4, true);
    check(p.depth() == 4, "paired clipping resets partial window");
    p.observe(4, 4, 4, false); p.observe(4, 4, 4, true); p.observe(4, 4, 4, true);
    check(p.depth() == 4, "lookup or terminal resets partial window");
    p.observe(4, 4, 4, true);
    check(p.depth() == 5, "three fresh eligible rounds grow");
    p = AdaptiveMtp{};
    check(p.depth() == 3, "slot readmission resets");
    unsigned seed = 17;
    for (int n = 0; n < 10000; ++n) {
        seed = seed * 1664525u + 1013904223u;
        const int requested = p.limit(seed % 8);
        const int offered = requested ? (seed >> 8) % (requested + 1) : 0;
        const int accepted = offered ? (seed >> 16) % (offered + 1) : 0;
        p.observe(requested, offered, accepted, (seed & 1) != 0);
        check(p.depth() >= 3 && p.depth() <= 6, "bounded mixed sequence");
    }
    std::printf("adaptive_mtp_test: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
