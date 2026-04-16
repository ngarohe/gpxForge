import reverse_geocoder as rg
from typing import List, Tuple, Set, Dict


def detect_countries(points: List[Tuple[float, float]]) -> Set[str]:
    """Return set of ISO country codes for all points."""
    results = rg.search(points, verbose=False)
    return set(r['cc'] for r in results)


def group_points_by_country(points: List[Tuple[float, float]]) -> Dict[str, List[Tuple[int, Tuple[float, float]]]]:
    """Return dict mapping country code → list of (original_index, (lat, lon))."""
    results = rg.search(points, verbose=False)
    groups: Dict[str, List[Tuple[int, Tuple[float, float]]]] = {}
    for i, (point, result) in enumerate(zip(points, results, strict=True)):
        cc = result['cc']
        if cc not in groups:
            groups[cc] = []
        groups[cc].append((i, point))
    return groups
