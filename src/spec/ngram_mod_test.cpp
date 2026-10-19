#include "strata/spec/ngram_mod.hpp"
#include <cstdio>
#include <numeric>
#include <vector>

using strata::spec::NgramMod;

int main() {
    int failed = 0, checks = 0;
    auto check = [&](bool ok, const char* what) {
        ++checks;
        if (!ok) { ++failed; std::printf("FAIL %s\n", what); }
    };
    auto sequence = [](int start, int n) {
        std::vector<int32_t> v((size_t) n);
        std::iota(v.begin(), v.end(), start);
        return v;
    };
    NgramMod pool(1000000);
    const auto full = sequence(100, 128), key = sequence(100, 24);
    NgramMod::State trainer, a, b;
    pool.begin(trainer, full);
    pool.begin(a, key);
    int32_t out[8] = {};
    check(pool.propose(a, key, 6, out) == 6 && out[0] == 124 && out[5] == 129,
          "a new session reuses another session's continuation from its 24-token key");
    pool.begin(b, key);
    check(pool.propose(b, key, 3, out) == 3 && out[2] == 126, "a second slot shares the pool and its own budget");
    check(pool.size_bytes() == 16 * 1024 * 1024, "one fixed 16 MiB CPU pool");
    for (int cap = 0; cap <= 7; ++cap) {
        std::fill_n(out, 8, -9);
        const int n = pool.propose(a, key, cap, out);
        check(n == cap && out[cap] == -9, "a proposal writes only the owner's capacity");
    }
    {
        // a key this table never learned proposes nothing (the pool is 16 MiB, so the miss is a real miss)
        NgramMod::State s;
        pool.begin(s, full);
        const auto other = sequence(500, 24);
        check(pool.propose(s, other, 8, out) == 0, "a key without the chain proposes nothing");
    }
    {
        // `learned` counts the history beyond one match window: a key of exactly 24 tokens has nothing to learn
        NgramMod::State s;
        const auto key40 = sequence(100, 40);
        pool.begin(s, key40);
        for (int n = 0; n < 4; ++n) pool.observe(s, 0, 4);
        check(s.low == 4 && s.learned != 0, "four weak rounds keep the table");
        pool.observe(s, 0, 4);
        check(s.low == 0 && s.learned == 0, "the fifth weak round clears this slot's feedback");
    }
    std::printf("ngram_mod_test: %d checks, %d failures\n", checks, failed);
    return failed ? 1 : 0;
}
