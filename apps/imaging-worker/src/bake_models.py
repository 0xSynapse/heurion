import sys
import time
from pathlib import Path

src_dir = Path(__file__).resolve().parent
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from model_registry import OFFICIAL_MODEL_REGISTRY, pull_model

MODELS = [k for k, v in OFFICIAL_MODEL_REGISTRY.items() if v.engine_implemented]

def main():
    for m in MODELS:
        for attempt in range(3):
            try:
                print(f"Baking model {m} (attempt {attempt+1})...")
                pull_model(m)
                break
            except Exception as e:
                if attempt == 2:
                    print(f"Warning: failed to bake {m} during build ({e}), will be pulled at runtime/deploy")
                else:
                    time.sleep(2)

if __name__ == "__main__":
    main()
