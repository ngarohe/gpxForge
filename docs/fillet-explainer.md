# Why Fillets: Solving the Hairpin Elevation Problem

## The Problem

At tight hairpin corners, the approach and exit segments are physically close in space but far apart in route distance — and at very different elevations. When we transfer gradient-smoothed elevations onto processGPX's new geometry (Stage 3), we need to map each new point to the correct position on the original route.

Without fillets, a processGPX output point sitting near a hairpin apex could match to either the approach segment (e.g., 420m elevation) or the exit segment (e.g., 435m elevation). They're both spatially close — just metres apart — but 15m apart in elevation. A nearest-segment projection picks whichever segment is geometrically closest, which is essentially random at hairpins. This causes sudden elevation jumps in the output.

## What Fillets Do

`applyFillets()` (in `src/utils/geometry.js`) replaces sharp hairpin vertices with smooth circular arcs *before* processGPX runs. For each vertex with turn ≥ 100°:

1. Compute tangent points where the inscribed circle (R=6m) touches the approach and exit segments
2. Generate arc points at 0.3m spacing between the tangent points
3. Linearly interpolate elevation from approach to exit across the arc (constant grade through the corner)

This transforms a sharp V-shape into a smooth curve with a continuous, monotonic distance profile through the corner.

## Why This Fixes the Elevation Transfer

Stage 3 uses **distance-based proportional mapping** — it maps each processGPX output point's cumulative distance to the equivalent position on the filleted route's distance scale, then interpolates elevation. Because the fillet arc creates a smooth, unambiguous distance progression through the corner, there's no spatial overlap. Point at 50% through the route maps to 50% through the filleted route — no chance of jumping to the wrong side of a hairpin.

Without fillets, even distance-based mapping can fail because the original route has a sharp vertex where the distance jumps from approach to exit with no intermediate geometry. The fillet provides that intermediate geometry.

## How processGPX Handles Corners

processGPX has its own corner processing, which runs *after* our fillets and determines the final corner shape in the output. Two features handle corners (both part of `-auto`):

**`cornerCrop` (default 6m):** Interpolates points 6m before and 6m after each corner vertex, then fits an arc through them. The resulting radius depends on the turn angle — at a right angle (90° turn) the radius is 6m, gentler turns produce a larger radius, and tighter turns produce a smaller radius.

**`minRadius` (default 6m):** A second pass that checks corners that ended up below 6m radius from the cornerCrop step and adjusts them outward. This is a deliberate two-stage approach: first the apex moves inward (from corner cropping), then if the radius is too small, it moves back out.

**`fitArcs`** is a separate, unrelated feature. It looks for *existing* constant-radius corners in the data and replaces the points with a true circular arc at ≤15° angular spacing. It cleans up already-circular geometry rather than reshaping sharp corners. It's somewhat hit or miss depending on how many points the input has in each corner.

Additionally, Gaussian position smoothing (`lSmooth=5`, σ=5m on lat/lon) runs on all points including corners, further rounding the geometry.

## Our Fixed Radius vs processGPX's Angle-Dependent Radius

Our fillets use a fixed R=6m for all corners ≥ 100° turn. processGPX's cornerCrop approach is more nuanced — the radius varies naturally with turn angle, and the minRadius pass then corrects corners that ended up too tight. On very sharp corners (>90° turn), our fixed 6m radius moves the apex further inward than processGPX's cornerCrop would. This is acceptable because our fillets exist for elevation transfer accuracy, not for controlling the final corner shape — processGPX reshapes all corners through its own pipeline regardless of what we provide as input.

## What Fillets Don't Do

Fillets don't control the final corner shape in the output. processGPX's cornerCrop + minRadius + Gaussian smoothing determines that. Our fillets serve as better *input* geometry for the elevation transfer in Stage 3. processGPX reshapes all corners through its own pipeline, so the fillets' primary value is providing smooth, unambiguous distance progression through hairpins for accurate elevation mapping.
