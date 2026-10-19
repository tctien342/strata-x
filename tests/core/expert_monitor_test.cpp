// STRATA-X: the residency telemetry's frame, states and bounds (no CUDA: this is the pure mirror).
#include "strata/core/expert_monitor.hpp"

#include <cstdio>
#include <string>
#include <vector>

using strata::core::ExpertMonitor;

static int failures = 0;

static void check(bool ok, const char* what) {
    if (!ok) {
        std::printf("FAIL %s\n", what);
        ++failures;
    }
}

int main() {
    ExpertMonitor m(2, 3, "0,1");
    std::vector<int32_t> map = {0, -1, 1, -1, 1, -1};    // (l0,e0) stage0, (l0,e2) stage1, (l1,e1) stage1
    m.snapshot(map);
    const auto t0 = ExpertMonitor::Clock::now();
    std::string f = m.frame(t0);
    check(f == "ER 2 3 0,1 101010", "absent/cached states and the device per layer");
    check(m.frame(t0).substr(0, 7) == "ER 2 3 ", "frame prefix");

    const int32_t ids[2] = {0, 2};
    m.routed(0, ids, 2, t0);
    f = m.frame(t0);
    check(f == "ER 2 3 0,1 303010", "a routed expert is active, the rest cached/absent");
    f = m.frame(t0 + std::chrono::milliseconds(900));
    check(f == "ER 2 3 0,1 303010", "active within the second");
    f = m.frame(t0 + std::chrono::seconds(1));
    check(f == "ER 2 3 0,1 101010", "cached again after the second");

    m.routed(0, ids, 2, t0);
    f = m.frame(t0);
    check(f.size() == std::string("ER 2 3 0,1 101010").size(), "frame size is layers*experts");
    m.routed(9, ids, 2, t0);                              // a bad layer is ignored
    m.routed(0, (const int32_t[]){-1, 7}, 2, t0);         // a bad id is ignored
    check(m.frame(t0) == f, "out-of-range routing changes nothing");

    m.snapshot(std::vector<int32_t>{-1, -1});             // a wrong-sized map is ignored, not shrunk
    check(m.frame(t0) == f, "a bad map leaves the mirror alone");

    if (failures) {
        std::printf("%d failure(s)\n", failures);
        return 1;
    }
    std::puts("expert monitor ok");
    return 0;
}
