import os
import sys

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from bronchiectasis import extract_mucus_locations


def _locate(z: int, x: int):
    vol = np.full((40, 32, 32), -850.0, dtype=np.float32)
    mucus = np.zeros(vol.shape, dtype=bool)
    mucus[z - 1:z + 2, 14:18, x - 2:x + 2] = True
    vol[mucus] = 40.0
    airway = np.zeros(vol.shape, dtype=bool)
    return extract_mucus_locations(vol, mucus, airway, spacing=(1.0, 1.0, 1.0))


def test_zone_uses_lps_height_not_lobe_names():
    # canonical LPS：z=0 为足侧，z 越大越靠头侧；x 小为患者右侧
    clusters, zones, summary = _locate(z=36, x=6)
    assert clusters[0]["zone"] == "右上肺野"
    assert zones["右上肺野"] > 0
    assert "启发式分区" in summary

    clusters, zones, _ = _locate(z=3, x=26)
    assert clusters[0]["zone"] == "左下肺野"

    clusters, _, _ = _locate(z=20, x=6)
    assert clusters[0]["zone"] == "右中肺野"


def test_no_lobe_or_segment_names():
    clusters, zones, summary = _locate(z=36, x=6)
    text = " ".join([summary, *zones.keys(), *(c["full_location"] for c in clusters)])
    for word in ("上叶", "中叶", "下叶", "尖段", "背段", "基底段", "舌叶"):
        assert word not in text
    assert "segment" not in clusters[0]
