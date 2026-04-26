import gpxpy
import gpxpy.gpx
from typing import List, Tuple, Optional


def parse_gpx(file_path: str) -> Tuple[List[Tuple[float, float]], gpxpy.gpx.GPX]:
    """Parse GPX file and return list of (lat, lon) tuples and the GPX object."""
    with open(file_path, 'r', encoding='utf-8') as f:
        gpx = gpxpy.parse(f)

    points = []
    for track in gpx.tracks:
        for segment in track.segments:
            for point in segment.points:
                points.append((point.latitude, point.longitude))

    # Also include route points and waypoints
    for route in gpx.routes:
        for point in route.points:
            points.append((point.latitude, point.longitude))

    for waypoint in gpx.waypoints:
        points.append((waypoint.latitude, waypoint.longitude))

    return points, gpx


def write_gpx(gpx: gpxpy.gpx.GPX, elevations: List[float], output_path: str):
    """Write GPX with updated elevations. Elevations must match point order from parse_gpx."""
    idx = 0
    for track in gpx.tracks:
        for segment in track.segments:
            for point in segment.points:
                point.elevation = elevations[idx]
                idx += 1

    for route in gpx.routes:
        for point in route.points:
            point.elevation = elevations[idx]
            idx += 1

    for waypoint in gpx.waypoints:
        waypoint.elevation = elevations[idx]
        idx += 1

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(gpx.to_xml())


def write_gpx_fresh(
    points: List[Tuple[float, float]],
    elevations: List[Optional[float]],
    output_path: str,
) -> None:
    """Build a new GPX file from scratch with the given points and elevations.

    Used when the output point set differs from the input (e.g. local providers
    resample to 1m, producing more points than the original GPX contained).
    """
    gpx = gpxpy.gpx.GPX()
    track = gpxpy.gpx.GPXTrack()
    gpx.tracks.append(track)
    segment = gpxpy.gpx.GPXTrackSegment()
    track.segments.append(segment)

    for (lat, lon), ele in zip(points, elevations):
        pt = gpxpy.gpx.GPXTrackPoint(
            latitude=lat,
            longitude=lon,
            elevation=ele if ele is not None else 0.0,
        )
        segment.points.append(pt)

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(gpx.to_xml())
