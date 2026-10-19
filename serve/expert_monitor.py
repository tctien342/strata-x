"""Bounded, process-owned decode-cache telemetry; never part of token delivery."""
import threading
import time


class ExpertMonitor:
    def __init__(self):
        self.lock = threading.Lock()
        self.latest = None
        self.auxiliary = None
        self.transfers = (0, [])

    def accept(self, line, now=None):
        fields = line.split()
        try:
            if len(fields) != 5 or fields[0] not in ("ER", "EA"):
                return False
            layers, experts = int(fields[1]), int(fields[2])
            devices = [int(d) for d in fields[3].split(",")]
            states = fields[4]
            if not (0 < layers <= 256 and 0 < experts <= 1024 and layers * experts <= 32768):
                return False
            if len(devices) != layers or any(d < 0 or d > 15 for d in devices):
                return False
            if len(states) != layers * experts or set(states) - set("0123"):
                return False
        except ValueError:
            return False
        now = time.monotonic() if now is None else now
        with self.lock:
            if fields[0] == "EA":
                self.auxiliary = (now, layers, experts, devices, states)
                return True
            self.latest = (now, layers, experts, devices, states)
            moving = [i for i, state in enumerate(states) if state == "2"]
            if moving:
                self.transfers = (now, moving)
        return True

    def snapshot(self, alive=True, now=None):
        now = time.monotonic() if now is None else now
        with self.lock:
            if not alive or self.latest is None:
                return None
            at, layers, experts, devices, states = self.latest
            age = max(0, now - at)
            if age >= 1:
                states = states.replace("3", "1")
            auxiliary = None
            if self.auxiliary:
                aux_at, aux_layers, aux_experts, aux_devices, aux_states = self.auxiliary
                aux_age = max(0, now - aux_at)
                if aux_age >= 1: aux_states = aux_states.replace("3", "1")
                auxiliary = {"layers": aux_layers, "experts": aux_experts, "devices": list(aux_devices),
                             "states": aux_states, "counts": [aux_states.count(str(i)) for i in range(4)],
                             "age_s": round(aux_age, 2), "paused": aux_age > 2, "recent_transfers": []}
            return {"auxiliary": auxiliary, "layers": layers, "experts": experts, "devices": list(devices), "states": states,
                    "counts": [states.count(str(i)) for i in range(4)], "age_s": round(age, 2),
                    "paused": age > 2,
                    "recent_transfers": list(self.transfers[1]) if now - self.transfers[0] < 1.5 else []}
