import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

src_dir = Path(__file__).resolve().parent
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from model_registry import OFFICIAL_MODEL_REGISTRY, pull_model, verify_model

# All 16 implemented MONAI Model Zoo weights with remote URLs
ALL_IMPLEMENTED_MODELS = [
    k for k, v in OFFICIAL_MODEL_REGISTRY.items() if v.engine_implemented and v.urls
]

# During Docker image build (default), only bake the lightweight core baseline weight (spleen_ct, 23 MB)
# so CI image builds & GHCR pushes stay fast and small; in production, deploy.sh warms up all 16 weights
# into the persistent `imaging-models` Docker volume. Set HEURION_BAKE_ALL=1 to bake all 16 weights.
MODELS = (
    ALL_IMPLEMENTED_MODELS
    if os.environ.get("HEURION_BAKE_ALL") == "1"
    else ["spleen_ct"]
)


def _bake_one(m: str) -> bool:
    v = verify_model(m)
    if v.get("installed") and v.get("verified"):
        print(f"Model {m} already verified at {v.get('path')}", flush=True)
        return True
    for attempt in range(3):
        try:
            print(f"Baking model {m} (attempt {attempt + 1})...", flush=True)
            pull_model(m)
            return True
        except Exception as e:
            if attempt == 2:
                print(
                    f"Warning: failed to bake {m} ({e}), will be pulled at runtime/deploy",
                    flush=True,
                )
            else:
                time.sleep(2)
    return False


def main():
    targets = ALL_IMPLEMENTED_MODELS if "--all" in sys.argv else MODELS
    workers = min(4, max(1, len(targets)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_bake_one, m): m for m in targets}
        for fut in as_completed(futures):
            fut.result()


if __name__ == "__main__":
    main()
