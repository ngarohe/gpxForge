/**
 * GPX processing functions for route optimization
 * REORDERED TO MATCH PERL FUNCTION ORDERING
 */

// Mathematical constants
const PI = Math.atan2(0, -1);
const PI2 = Math.atan2(1, 0); // π/2 - used by transition function
const TWOPI = 2 * PI;
const REARTH = 20037392 / PI;
const DEG2RAD = PI / 180;
const LAT2Y = REARTH * DEG2RAD;
const SQRT2PI = Math.sqrt(2 * PI);

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Safe array indexing with Perl-style negative index support
 * @param {Array} arr - Array to index
 * @param {number} i - Index (can be negative)
 * @returns {*} Array element at computed index
 */
function ix(arr, i) {
	const n = arr.length;
	return arr[((i % n) + n) % n];
}

/**
 * Perl-style int() function that truncates towards zero
 * @param {number} x - Number to truncate
 * @returns {number} Truncated integer
 */
function int(x) {
	return x < 0 ? Math.ceil(x) : Math.floor(x);
}

/**
 * JavaScript equivalent of Perl's spaceship operator (<=>)
 * Returns -1, 0, or 1 based on comparison
 * @param {number} a - First value
 * @param {number} b - Second value
 * @returns {number} -1 if a < b, 0 if a == b, 1 if a > b
 */
function spaceship(a, b) {
	return (a > b) - (a < b);
}

/**
 * Die function - equivalent to Perl's die()
 * Throws an error with the given message
 * @param {string} message - Error message
 */
/* istanbul ignore next */
function die(message) {
	throw new Error(message);
}

/**
 * returns the last valid index of an array
 * @param {Array} x - array
 * @returns {number} last valid index
 */
function maxIndex(x) {
	return x.length - 1;
}

/**
 * Logging function (equivalent to Perl's note function)
 * Silenced by default in GPXForge — set processGPXVerbose=true globally to enable
 * @param {...any} args - Arguments to log
 */
function note(...args) {
	if (typeof globalThis !== "undefined" && globalThis.processGPXVerbose) {
		console.log(...args);
	}
}

/**
 * Warning function (equivalent to Perl's warn function)
 * @param {...any} args - Arguments to warn
 */
function warn(...args) {
	console.log(...args);
}

/**
 * Debug function to dump points array to file in consistent format
 * Compatible with Perl processGPX dumpPoints() function
 * @param {Array} points - Array of point objects with lat, lon, ele, distance properties
 * @param {string} filename - Output filename
 */

/**
 * Generate tabular output from points array
 * @param {Array} points - Array of point objects
 * @param {Object} options - Options for output format
 * @param {string} options.separator - Field separator (default: ",")
 * @param {Array} options.extraFields - Extra fields to prepend (default: [])
 * @param {Array} options.extraValues - Values for extra fields (default: [])
 * @returns {string} Tabular content
 */
export function generateTabularOutput(points, options = {}) {
	const { separator = ",", extraFields = [], extraValues = [] } = options;

	if (!points || points.length === 0) {
		return `${extraFields.join(separator)}\n`;
	}

	// Get keys from first point (like Perl: @keys = keys %{$points->[0]};)
	const keys = Object.keys(points[0]);

	// Header row: extra fields, then all point keys
	let content = `${[...extraFields, ...keys].join(separator)}\n`;

	// Data rows
	for (const point of points) {
		const values = [...extraValues];
		for (const key of keys) {
			const value = point[key] ?? "";
			values.push(value);
		}
		content += `${values.join(separator)}\n`;
	}

	return content;
}

function dumpPoints(points, filename) {
	const match = filename.match(/^(\d+)-js-(.+)\.txt$/);
	if (match) {
		const [, stageNum, stageName] = match;
		note(`Stage ${stageNum} (${stageName}) complete: ${points.length} points`);
	} else {
		note(`Stage ${filename} complete: ${points.length} points`);
	}

	// Call Node.js-specific dumper if available
	if (typeof globalThis.debugDumper === "function") {
		globalThis.debugDumper(points, filename);
	}
}

/**
 * Regular expression for matching numeric values in strings
 * Matches integers, decimals, and scientific notation
 */
const NUMBER_REGEXP = /^[+-]?\d*(?:\d|(?:\.\d+))(?:[eE][-+]?\d+)?$/;

/**
 * Check if a value is numeric (number or numeric string)
 * @param {*} value - Value to check
 * @returns {boolean} True if value is numeric
 */
function isNumeric(value) {
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	if (typeof value === "string") {
		return NUMBER_REGEXP.test(value);
	}
	return false;
}

// ============================================================================
// MAIN FUNCTIONS IN PERL ORDER
// ============================================================================

/**
 * Transition function: 1 (x = -1) to 1/2 (x = 0) to 0 (x = 1)
 * @param {number} x - Input value
 * @returns {number} Transition value
 */
function transition(x) {
	return x < -1 ? 1 : x > 1 ? 0 : (1 - Math.sin(x * PI2)) / 2;
}

// TODO: Translate setFileNameSuffix() from Perl

/**
 * Reduce angle to range [-π, π]
 * @param {number} theta - Angle in radians
 * @returns {number} Reduced angle
 */
function reduceAngle(theta) {
	theta -= TWOPI * Math.floor(0.5 + theta / TWOPI);
	return theta;
}

/**
 * Average two angles, handling wraparound correctly
 * @param {number} d1 - First angle in radians
 * @param {number} d2 - Second angle in radians
 * @returns {number} Average angle in radians
 */
function averageAngles(d1, d2) {
	return reduceAngle(d1 + 0.5 * reduceAngle(d2 - d1));
}

/**
 * Calculate difference between two angles
 * @param {number} d1 - First angle in radians
 * @param {number} d2 - Second angle in radians
 * @returns {number} Angle difference in radians
 */
function deltaAngle(d1, d2) {
	return reduceAngle(d2 - d1);
}

/**
 * Longitude difference in radians, handling wraparound
 * 179 to -179: -358 -> 2 deg (in radians)
 * -179 to 179: 358 -> -2 deg (in radians)
 * @param {number} lng1 - First longitude in radians
 * @param {number} lng2 - Second longitude in radians
 * @returns {number} Longitude difference in radians
 */
function deltalngRadians(lng1, lng2) {
	let dlng = lng2 - lng1;
	dlng -= TWOPI * Math.floor(0.5 + dlng / TWOPI);
	return dlng;
}

/**
 * Longitude difference in degrees, handling wraparound
 * @param {number} lng1 - First longitude in degrees
 * @param {number} lng2 - Second longitude in degrees
 * @returns {number} Longitude difference in degrees
 */
function deltalng(lng1, lng2) {
	let dlng = lng2 - lng1;
	dlng -= 360 * Math.floor(0.5 + dlng / 360);
	return dlng;
}

/**
 * find distance between lat, lng points
 * @param {Object} p1 - First point with {lat, lon} properties
 * @param {Object} p2 - Second point with {lat, lon} properties
 * @returns {number} Distance in meters
 */
function latlngDistance(p1, p2) {
	const lat1 = DEG2RAD * p1.lat;
	const lat2 = DEG2RAD * p2.lat;
	const lng1 = DEG2RAD * p1.lon;
	const lng2 = DEG2RAD * p2.lon;
	const dlng = lng2 - lng1;
	const dlat = lat2 - lat1;
	const a =
		Math.sin(dlat / 2) ** 2 +
		Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlng / 2) ** 2;
	const d = 2 * REARTH * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return d;
}

/**
 * Calculate delta vector between two xy points
 * @param {Array} p1 - [x, y] first point
 * @param {Array} p2 - [x, y] second point
 * @returns {Array} [dx, dy] difference vector
 */
function deltaxy(p1, p2) {
	return [p2[0] - p1[0], p2[1] - p1[1]];
}

/**
 * Check if two points are close together
 * @param {Object} p1 - First point
 * @param {Object} p2 - Second point
 * @param {number} sMax - Maximum distance threshold (default 0.05m)
 * @param {number} zMax - Maximum altitude difference (default 1m)
 * @returns {boolean} True if points are close
 */
function pointsAreClose(p1, p2, sMax = 0.05, zMax = 1) {
	const dz = p1.ele !== undefined && p2.ele !== undefined ? p2.ele - p1.ele : 0;
	return Math.abs(dz) < zMax && latlngDistance(p1, p2) < sMax;
}

/**
 * Calculate dot product between two lat/lng segments
 * @param {Object} p1 - First point of first segment
 * @param {Object} p2 - Second point of first segment
 * @param {Object} p3 - First point of second segment
 * @param {Object} p4 - Second point of second segment
 * @returns {number|null} Dot product or null if degenerate
 */
function latlngDotProduct(p1, p2, p3, p4) {
	const [dx12, dy12] = latlng2dxdy(p1, p2);
	const [dx34, dy34] = latlng2dxdy(p3, p4);
	const denom = Math.sqrt((dx12 ** 2 + dy12 ** 2) * (dx34 ** 2 + dy34 ** 2));
	return denom === 0 ? null : (dx12 * dx34 + dy12 * dy34) / denom;
}

/**
 * Calculate cross product between two segments defined by array coordinates
 * @param {Array} p1 - [x, y] coordinates of first point of first segment
 * @param {Array} p2 - [x, y] coordinates of second point of first segment
 * @param {Array} p3 - [x, y] coordinates of first point of second segment
 * @param {Array} p4 - [x, y] coordinates of second point of second segment
 * @returns {number|null} Normalized cross product or null if degenerate
 */
function crossProduct(p1, p2, p3, p4) {
	const dx12 = p2[0] - p1[0];
	const dx34 = p4[0] - p3[0];
	const dy12 = p2[1] - p1[1];
	const dy34 = p4[1] - p3[1];
	const denom = Math.sqrt((dx12 ** 2 + dy12 ** 2) * (dx34 ** 2 + dy34 ** 2));
	return denom === 0 ? null : (dx12 * dy34 - dx34 * dy12) / denom;
}

/**
 * Calculate cross product between two lat/lng segments
 * @param {Object} p1 - First point of first segment
 * @param {Object} p2 - Second point of first segment
 * @param {Object} p3 - First point of second segment
 * @param {Object} p4 - Second point of second segment
 * @returns {number|null} Cross product or null if degenerate
 */
function latlngCrossProduct(p1, p2, p3, p4) {
	const [dx12, dy12] = latlng2dxdy(p1, p2);
	const [dx34, dy34] = latlng2dxdy(p3, p4);
	const denom = Math.sqrt((dx12 ** 2 + dy12 ** 2) * (dx34 ** 2 + dy34 ** 2));
	return denom === 0 ? null : (dx12 * dy34 - dx34 * dy12) / denom;
}

/**
 * Determine turn direction of three points
 * @param {Array} v1 - [x, y] first point
 * @param {Array} v2 - [x, y] second point
 * @param {Array} v3 - [x, y] third point
 * @returns {number} -1, 0, or 1 indicating turn direction
 */
function turnDirection(v1, v2, v3) {
	const dv1 = deltaxy(v1, v2);
	const dv2 = deltaxy(v2, v3);
	return spaceship(dv1[1] * dv2[0], dv1[0] * dv2[1]);
}

/**
 * given 3 points, return the subtended angle
 * @param {Object} p1 - First point
 * @param {Object} p2 - Vertex point
 * @param {Object} p3 - Third point
 * @returns {number|null} Angle in radians or null if degenerate
 */
function latlngAngle(p1, p2, p3) {
	const s = latlngCrossProduct(p1, p2, p2, p3);
	const c = latlngDotProduct(p1, p2, p2, p3);
	const a = s !== null && c !== null ? reduceAngle(Math.atan2(s, c)) : null;
	return a;
}

/**
 * direction from p1 to p2
 * 0 deg = eastward
 * 90 deg: northward
 * 180 deg: westward
 * 270 deg: southward
 * @param {Object} p1 - First point
 * @param {Object} p2 - Second point
 * @returns {number} Direction in radians (0 = east, π/2 = north)
 */
function latlngDirection(p1, p2) {
	const [dx, dy] = latlng2dxdy(p1, p2);
	return Math.atan2(dy, dx);
}

/**
 * the direction of a point p2, which is the average
 * of the directions of the adjacent segments
 * @param {Object} p1 - Previous point
 * @param {Object} p2 - Current point
 * @param {Object} p3 - Next point
 * @returns {number} Direction in radians
 */
function pointDirection(p1, p2, p3) {
	return averageAngles(latlngDirection(p1, p2), latlngDirection(p2, p3));
}

/**
 * Shift a point by a given distance in a given direction
 * @param {Object} point - Point to shift
 * @param {number} direction - Direction in radians
 * @param {number} distance - Distance to shift
 * @returns {Object} New shifted point
 */
function shiftPoint(point, direction, distance) {
	if (direction === undefined || direction === null) {
		/* istanbul ignore next */
		die("ERROR: shiftPoint() called without valid direction.");
	}
	if (distance === undefined || distance === null) {
		/* istanbul ignore next */
		die("ERROR: shiftPoint() called without valid point distance.");
	}

	const c = Math.cos(direction);
	const s = Math.sin(direction);

	// lane shift, 90 degrees
	const dx = s * distance;
	const dy = -c * distance;
	const dlng = dx / (LAT2Y * Math.cos(DEG2RAD * point.lat));
	const dlat = dy / LAT2Y;

	return {
		...point,
		lon: point.lon + dlng,
		lat: point.lat + dlat,
	};
}

/**
 * Shift a vertex by a given distance considering two directions
 * @param {Object} point - Point to shift
 * @param {Array} directions - Array of two directions in radians
 * @param {number} distance - Distance to shift
 * @returns {Object} New shifted point
 */
function shiftVertex(point, directions, distance) {
	const c1 = Math.cos(directions[0]);
	const s1 = Math.sin(directions[0]);
	const c2 = Math.cos(directions[1]);
	const s2 = Math.sin(directions[1]);

	// lane shift, 90 degrees
	const denom = c1 * s2 - c2 * s1;
	let dx, dy;

	if (Math.abs(denom) < 0.001) {
		dx = ((s1 + s2) * distance) / 2;
		dy = (-(c1 + c2) * distance) / 2;
	} else {
		dx = ((c1 - c2) / denom) * distance;
		dy = ((s1 - s2) / denom) * distance;
	}

	const dlng = dx / (LAT2Y * Math.cos(DEG2RAD * point.lat));
	const dlat = dy / LAT2Y;

	return {
		...point,
		lon: point.lon + dlng,
		lat: point.lat + dlat,
	};
}

/**
 * Calculate a coordinate difference between points:
 * uses formula for distance and heading between points on a sphere
 * @param {Object} p1 - First point with {lat, lon} properties
 * @param {Object} p2 - Second point with {lat, lon} properties
 * @returns {Array} [dx, dy] coordinate differences in meters
 */
function latlng2dxdy(p1, p2) {
	/* istanbul ignore next */
	if (!p1) die("latlng2dxdy called with undefined point #1");
	/* istanbul ignore next */
	if (!p2) die("latlng2dxdy called with undefined point #2");

	const lat1 = DEG2RAD * p1.lat;
	const lat2 = DEG2RAD * p2.lat;
	const lng1 = DEG2RAD * p1.lon;
	const lng2 = DEG2RAD * p2.lon;
	const dlng = deltalngRadians(lng1, lng2);

	const u =
		Math.cos(lat1) * Math.sin(lat2) -
		Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlng);
	const v = Math.sin(dlng) * Math.cos(lat2);
	const uv = Math.sqrt(u ** 2 + v ** 2);

	let dx, dy;
	if (uv === 0) {
		dx = 0;
		dy = 0;
	} else {
		const s = u / uv;
		const c = v / uv;
		const d = latlngDistance(p1, p2);
		dx = d * c;
		dy = d * s;
	}
	return [dx, dy];
}

/**
 * For a range of points, interpolate the fields based on distance between
 * the first and last point.
 * Use distance field if present on internal points else calculate distance field.
 * @param {...Object} points - Variable number of points to interpolate
 */
function interpolateFields(...points) {
	if (points.length <= 2) return;

	const p1 = points[0];
	const p2 = points[points.length - 1];

	// Calculate distance: don't trust existing distance field
	const ds = [0];
	for (let i = 1; i < points.length; i++) {
		ds.push(ds[ds.length - 1] + latlngDistance(points[i - 1], points[i]));
	}

	for (let i = 1; i < points.length; i++) {
		const p = points[i];
		const f = ds[i] / ds[ds.length - 1];

		for (const k in p1) {
			if (k === "lat" || k === "lon") continue;

			if (p1[k] !== undefined && p2[k] !== undefined) {
				if (k === "segment") {
					if (p1[k] === p2[k]) {
						p[k] = p1[k];
					} else {
						p[k] = 0;
					}
				} else if (isNumeric(p1[k]) && isNumeric(p2[k])) {
					p[k] = parseFloat(p1[k]) * (1 - f) + parseFloat(p2[k]) * f;
				} else {
					p[k] = f < 0.5 ? p1[k] : p2[k];
				}
			}
		}
	}
}

/**
 * Point linearly interpolated between p1 and p2, with f the fraction of the distance to p2.
 * Uses distance-based interpolation for lat/lng, not simple linear interpolation.
 * @param {Object} p1 - First point
 * @param {Object} p2 - Second point
 * @param {number} f - Fraction (0 = p1, 1 = p2)
 * @returns {Object} Interpolated point
 */
function interpolatePoint(p1, p2, f, courseDistance = 0, isLoop = 0) {
	// Interpolate lat and lng using distances, not angles
	const [dx, dy] = latlng2dxdy(p1, p2);
	const p = addVectorToPoint(p1, [dx * f, dy * f]);

	// remove links, if any
	delete p.next;
	delete p.prev;

	// Interpolate other random values
	for (const k in p1) {
		// skip lat lon (handled separately) or point references
		if (k === "lat" || k === "lon" || typeof p1[k] === "object") continue;

		if (p1[k] !== undefined && p2[k] !== undefined) {
			if (k === "segment") {
				if (p1[k] === p2[k]) {
					p[k] = p1[k];
				} else {
					p[k] = 0;
				}
			} else if (k === "distance" && courseDistance > 0) {
				// distance must be treated specially on courses
				let d =
					p1.distance +
					distanceDifference(p1, p2, courseDistance, isLoop) * f;
				d -= courseDistance * Math.floor(d / courseDistance);
				p[k] = d;
			} else if (isNumeric(p1[k]) && isNumeric(p2[k])) {
				p[k] = parseFloat(p1[k]) * (1 - f) + parseFloat(p2[k]) * f;
			} else {
				p[k] = f < 0.5 ? p1[k] : p2[k];
			}
		}
	}
	return p;
}

// TODO: Translate pointAtPosition() from Perl

/**
 * Catmull-Rom spline interpolation for corners.
 * f is the fraction between points 2 and 3.
 * f1 is the normalized distance from p1 to p2.
 * f4 is the normalized distance from p3 to p4.
 * @param {Object} p1 - First control point
 * @param {Object} p2 - Start point of interpolation
 * @param {Object} p3 - End point of interpolation
 * @param {Object} p4 - Second control point
 * @param {number} f1 - Normalized distance p1->p2 relative to p2->p3
 * @param {number} f4 - Normalized distance p3->p4 relative to p2->p3
 * @param {number} f - Fraction between p2 and p3 (0 to 1)
 * @returns {Object} Interpolated corner point
 */
function interpolateCorner(
	p1,
	p2,
	p3,
	p4,
	f1,
	f4,
	f,
	courseDistance = 0,
	isLoop = 0,
) {
	const a1 = interpolatePoint(p1, p2, 1 + f / f1, courseDistance, isLoop);
	const a2 = interpolatePoint(p2, p3, f, courseDistance, isLoop);
	const a3 = interpolatePoint(p3, p4, (f - 1) / f4, courseDistance, isLoop);
	const b1 = interpolatePoint(
		a1,
		a2,
		(f1 + f) / (f1 + 1),
		courseDistance,
		isLoop,
	);
	const b2 = interpolatePoint(a2, a3, f / (f4 + 1), courseDistance, isLoop);
	const px = interpolatePoint(b1, b2, f, courseDistance, isLoop);
	return px;
}

/**
 * Calculate intersection between two line segments
 * @param {Array} s12 - First segment [p1, p2]
 * @param {Array} s34 - Second segment [p3, p4]
 * @returns {Array} Array of [f12, f34] intersection parameters, or empty array if no intersection
 */
function segmentIntercept(s12, s34) {
	const [p1, p2] = s12;
	const [p3, p4] = s34;

	/* istanbul ignore next */
	if (!p1) die("segmentIntercept called with undefined point #1");
	/* istanbul ignore next */
	if (!p2) die("segmentIntercept called with undefined point #2");
	/* istanbul ignore next */
	if (!p3) die("segmentIntercept called with undefined point #3");
	/* istanbul ignore next */
	if (!p4) die("segmentIntercept called with undefined point #4");

	const [x1, y1] = [0, 0];
	const [x2, y2] = latlng2dxdy(p1, p2);
	const [x3, y3] = latlng2dxdy(p1, p3);
	const [x4, y4] = latlng2dxdy(p1, p4);
	const [dx12, dy12] = [x2, y2];
	const [dx34, dy34] = latlng2dxdy(p3, p4);

	const denom = dx34 * dy12 - dx12 * dy34;
	const a = Math.sqrt((dx12 ** 2 + dy12 ** 2) * (dx34 ** 2 + dy34 ** 2));

	// lines are parallel
	if (a === 0 || Math.abs(denom) < 0.01 * a) {
		return [];
	}

	const f12 = (dx34 * (y3 - y1) - dy34 * (x3 - x1)) / denom;
	if (f12 >= 0 && f12 < 1) {
		const x = f12 * x2 + (1 - f12) * x1;
		const y = f12 * y2 + (1 - f12) * y1;
		const f23 =
			Math.abs(x3 - x4) > Math.abs(y3 - y4)
				? (x - x3) / (x4 - x3)
				: (y - y3) / (y4 - y3);
		if (f23 >= 0 && f23 < 1) {
			return [f12, f23];
		}
	}
	return [];
}

/**
 * Add a vector to a lat/lng pair
 * Just focuses on lat and lon
 * @param {Array} latlng - [lat, lon] in degrees
 * @param {Array} v - [dx, dy] vector in meters
 * @returns {Array} [lat, lon] new position
 */
function addVectorToLatLng(latlng, v) {
	const [dx, dy] = v;
	const dlat = dy / LAT2Y; // this is independent of latitude
	const lat = latlng[0] + dlat;

	if (Math.abs(lat) > 90) {
		/* istanbul ignore next */
		die("ERROR -- attempted to cross beyond pole!");
	}

	const c = Math.cos(DEG2RAD * (latlng[0] + dlat / 2));
	const dlng = dx / c / LAT2Y;
	let lon = latlng[1] + dlng;
	lon -= 360 * Math.floor(0.5 + lon / 360);
	return [lat, lon];
}

/**
 * Add a vector to a point, copying all fields
 * @param {Object} point - Point with lat, lon, ele properties
 * @param {Array} vector - [dx, dy, dz] vector in meters (dz optional)
 * @returns {Object} New point with updated lat, lon, ele properties
 */
function addVectorToPoint(point, vector) {
	const dz = vector[2] ?? 0;
	const p2 = { ...point };
	const latlng = addVectorToLatLng([point.lat, point.lon], vector);
	p2.lat = latlng[0];
	p2.lon = latlng[1];
	p2.ele = point.ele + dz;
	return p2;
}

/**
 * Return points between p2 and p3 using a Catmull-Rom spline.
 * @param {Object} p1 - First control point
 * @param {Object} p2 - Starting point for interpolation
 * @param {Object} p3 - Ending point for interpolation
 * @param {Object} p4 - Second control point
 * @param {number} dd - Minimum angle for spline (default PI/16)
 * @returns {Array} Array of interpolated points between p2 and p3
 */
function splineInterpolation(
	p1,
	p2,
	p3,
	p4,
	courseDistance = 0,
	isLoop = 0,
	dd = PI / 16,
) {
	// Calculate number of points based on the angles
	const angle =
		Math.abs(latlngAngle(p1, p2, p3)) + Math.abs(latlngAngle(p2, p3, p4));
	const NPoints = Math.floor(angle / dd);

	// Calculate normalized distances
	const d23 = latlngDistance(p2, p3);
	const f1 = latlngDistance(p1, p2) / d23;
	const f4 = latlngDistance(p3, p4) / d23;

	const points = [];

	for (let i = 1; i <= NPoints; i++) {
		const f = i / (NPoints + 1);
		const p = interpolateCorner(
			p1,
			p2,
			p3,
			p4,
			f1,
			f4,
			f,
			courseDistance,
			isLoop,
		);
		points.push(p);
	}

	// Interpolate fields onto the new points
	if (points.length > 0) {
		interpolateFields(p2, ...points, p3);
	}

	return points;
}

/**
 * Arc fit interpolation between points
 * @param {Object} p1 - First point (for first circle fit)
 * @param {Object} p2 - Second point (interpolation starts here)
 * @param {Object} p3 - Third point (interpolation ends here)
 * @param {Object} p4 - Fourth point (for second circle fit)
 * @param {number} dd - Interpolation angle (default π/16)
 * @returns {Array} Array of interpolated points
 */
function arcFitInterpolation(
	p1,
	p2,
	p3,
	p4,
	courseDistance = 0,
	isLoop = 0,
	dd = Math.PI / 16,
) {
	const xy1 = latlng2dxdy(p2, p1);
	const xy2 = [0, 0];
	const xy3 = latlng2dxdy(p2, p3);
	const xy4 = latlng2dxdy(p2, p4);

	const [cxy0, cr0] = circle3PointFit(xy1, xy2, xy3);
	const [cxy1, cr1] = circle3PointFit(xy2, xy3, xy4);

	// Check the circle is on the right side of the corner
	const t1 = turnDirection(xy1, xy2, xy3);
	const t2 = turnDirection(xy2, xy3, xy4);

	// Points: find which circle spans the greatest angle, and divide that angle by
	// the angle spacing
	let phi11, phi12, dphi1, phi21, phi22, dphi2;
	let dphiMax = 0;

	if (cxy0 !== undefined) {
		// Check turn directions match
		if (
			!(
				t1 === turnDirection(xy1, xy2, cxy0) &&
				t1 === turnDirection(xy2, xy3, cxy0)
			)
		) {
			return [];
		}

		// Calculate angles
		phi11 = Math.atan2(xy2[1] - cxy0[1], xy2[0] - cxy0[0]);
		phi12 = Math.atan2(xy3[1] - cxy0[1], xy3[0] - cxy0[0]);
		dphi1 = deltaAngle(phi11, phi12);
		dphiMax = Math.max(dphiMax, Math.abs(dphi1));
	}

	if (cxy1 !== undefined) {
		// Check turn directions match
		if (
			!(
				t2 === turnDirection(xy2, xy3, cxy1) &&
				t2 === turnDirection(xy3, xy4, cxy1)
			)
		) {
			return [];
		}

		phi21 = Math.atan2(xy2[1] - cxy1[1], xy2[0] - cxy1[0]);
		phi22 = Math.atan2(xy3[1] - cxy1[1], xy3[0] - cxy1[0]);
		dphi2 = deltaAngle(phi21, phi22);
		dphiMax = Math.max(dphiMax, Math.abs(dphi2));
	}

	// Find number of points to interpolate
	let NPoints = Math.floor(dphiMax / Math.abs(dd));
	const NPointsMax = Math.floor(latlngDistance(p2, p3) / 0.1);
	NPoints = Math.min(NPoints, NPointsMax);

	const points = [];
	for (let i = 1; i <= NPoints; i++) {
		const f = i / (NPoints + 1);
		let phi1, phi2;
		if (dphi1 !== undefined) {
			phi1 = phi11 + dphi1 * f;
		}
		if (dphi2 !== undefined) {
			phi2 = phi21 + dphi2 * f;
		}

		let x1, y1, x2, y2;
		if (phi1 !== undefined) {
			x1 = cxy0[0] + cr0 * Math.cos(phi1);
			y1 = cxy0[1] + cr0 * Math.sin(phi1);
		} else {
			x1 = xy2[0] + f * (xy3[0] - xy2[0]);
			y1 = xy2[1] + f * (xy3[1] - xy2[1]);
		}

		if (phi2 !== undefined) {
			x2 = cxy1[0] + cr1 * Math.cos(phi2);
			y2 = cxy1[1] + cr1 * Math.sin(phi2);
		} else {
			x2 = xy2[0] + f * (xy4[0] - xy3[0]);
			y2 = xy2[1] + f * (xy4[1] - xy3[1]);
		}

		const dx = (1 - f) * x1 + f * x2 - xy2[0];
		const dy = (1 - f) * y1 + f * y2 - xy2[1];
		const p = addVectorToPoint(p2, [dx, dy]);
		points.push(p);
	}

	// Interpolate points with respect to distance along spline
	// Spline does not in general have equally spaced points, so point
	// interpolation, which would have been provided by interpolatePoint,
	// wouldn't work
	if (points.length > 0) {
		const ss = [latlngDistance(p2, points[0])];
		for (let i = 0; i < points.length - 1; i++) {
			ss.push(ss[ss.length - 1] + latlngDistance(points[i], points[i + 1]));
		}
		ss.push(ss[ss.length - 1] + latlngDistance(points[points.length - 1], p3));

		for (let i = 0; i < points.length; i++) {
			const f = ss[i] / ss[ss.length - 1];
			const p = points[i];
			for (const k in p2) {
				if (k !== "lat" && k !== "lon") {
					if (k === "segment") {
						if (p2[k] === p3[k]) {
							p[k] = p2[k];
						} else {
							p[k] = 0;
						}
					} else if (isNumeric(p2[k]) && isNumeric(p3[k])) {
						p[k] = (1 - f) * p2[k] + f * p3[k];
					} else {
						p[k] = p2[k];
					}
				}
			}
		}
	}
	return points;
}

/**
 * remove duplicate points of the same segment, and reduce point triplets
 * @param {Array} points - Array of points to process
 * @param {number} isLoop - Whether the track is a loop (0 or 1)
 * @returns {Array} New array of points with duplicates removed
 */
function removeDuplicatePoints(points, isLoop = 0) {
	note("removing duplicate points...");

	const pNew = [];
	let removedCount = 0;
	let i = 0;

	while (i <= maxIndex(points)) {
		const p = points[i];
		if (!p || p.lat === undefined) break;

		const lat0 = p.lat;
		const lng0 = p.lon;

		// Find all consecutive points with same coordinates
		let i1 = i;
		let iNext = (i1 + 1) % points.length;

		while (
			(iNext > i || (isLoop && iNext !== i)) &&
			Math.abs(points[iNext].lat - lat0) < 1e-9 &&
			Math.abs(points[iNext].lon - lng0) < 1e-9 &&
			(iNext + 1) % points.length !== i
		) {
			i1 = iNext;
			iNext = (iNext + 1) % points.length;
		}

		if (i1 === i) {
			// No duplicates, keep the point
			pNew.push(p);
		} else {
			// Found duplicates - average them together
			if (removedCount === 0) {
				// Clean out derived fields on first removal
				deleteDerivedFields(points);
				deleteDerivedFields(pNew);
			}
			removedCount += i1 - i;

			const sum1 = {};
			const sum0 = {};
			const newPoint = { ...p };

			// Average numeric fields from duplicate points
			let j = i;
			while (j !== (i1 + 1) % points.length) {
				for (const key in points[j]) {
					if (
						key !== "segment" &&
						typeof points[j][key] !== "object" &&
						isNumeric(points[j][key])
					) {
						sum1[key] = (sum1[key] || 0) + parseFloat(points[j][key]);
						sum0[key] = (sum0[key] || 0) + 1;
					}
				}
				j = (j + 1) % points.length;
			}

			// Apply averages to new point
			for (const key in sum1) {
				if (sum0[key] > 1) {
					newPoint[key] = sum1[key] / sum0[key];
				}
			}

			pNew.push(newPoint);

			// If we wrapped around, also replace the first point
			if (i1 < i) {
				pNew[0] = { ...newPoint };
				break;
			}
		}

		if (iNext < i) break;
		i = iNext;
	}

	if (removedCount > 0) {
		warn(`Removed ${removedCount} duplicate points`);
	}

	return pNew;
}

/**
 * Check if a route should be treated as a loop
 * Checks that the start and finish are close together and the route through
 * the S/F is not a U-turn
 * @param {Array} points - Array of track points
 * @returns {boolean} True if the route should be treated as a loop
 */
function checkAutoLoop(points) {
	// check that the route thru the S/F is not a U-turn
	let i1 = -1;
	const i2 = 0;
	let i3 = 1;
	while (
		latlngDistance(ix(points, i1), points[i2]) < 10 &&
		i1 > i2 - points.length
	) {
		i1--;
	}
	while (
		latlngDistance(points[i2], points[i3]) < 10 &&
		i3 < maxIndex(points)
	) {
		i3++;
	}
	const isLoop =
		points.length > 2 &&
		latlngDistance(points[0], points[points.length - 1]) < 40 &&
		latlngDotProduct(
			ix(points, i1),
			points[i2],
			points[i2],
			points[i3],
		) > -0.1;
	note(`autoLoop detection: ${isLoop ? "true" : "false"}\n`);
	return isLoop;
}

/**
 * Crop corners by removing points within a specified distance of sharp turns
 * @param {Object} options - Options object with points, cornerCrop, minRadians, maxRadians, start, end, isLoop
 * @returns {Array} New array with cropped corners
 */
function cropCorners(
	points,
	cornerCrop = 0,
	minRadians = PI / 3,
	maxRadians,
	cornerCropArcFit = 1,
	start,
	end,
	isLoop = 0,
) {
	// Threshold distance for points aligning with corner point
	const epsilon = 0.01 + 0.05 * cornerCrop;

	// If arguments exclude any points or angles
	if (
		(maxRadians !== undefined &&
			minRadians !== undefined &&
			maxRadians < minRadians) ||
		(!isLoop && start !== undefined && end !== undefined && start > end)
	) {
		return points;
	}

	// Create a direction field
	addDirectionField(points, isLoop);

	// Make sure last point isn't same as first point
	// Assume rest of code can deal with this
	while (
		isLoop &&
		points.length > 0 &&
		pointsAreClose(points[0], points[maxIndex(points)])
	) {
		points.pop();
	}

	// Find indices of corners meeting the cropping criteria
	const cropCorners = [];
	for (let i = 0; i <= maxIndex(points); i++) {
		if (!isLoop && (i === 0 || i === maxIndex(points))) continue;

		const p0 = points[(i - 1 + points.length) % points.length];
		const p1 = points[i];
		const p2 = points[(i + 1) % points.length];
		const a = latlngAngle(p0, p1, p2);
		const absA = a !== null ? Math.abs(a) : 0;

		if (absA >= minRadians && (maxRadians === undefined || absA < maxRadians)) {
			cropCorners.push(i);
		}
	}

	note(`cropping ${cropCorners.length} corners`);

	if (cropCorners.length === 0) return points;

	// Add a distance field if needed
	if (start !== undefined || end !== undefined) {
		addDistanceFieldIfNeeded(points);
	}

	// Corners which are too close get pruned
	const dMin = 2 * cornerCrop;
	const courseDistance = calcCourseDistance(points, isLoop);

	const cc = [];
	for (let ic = 0; ic < cropCorners.length; ic++) {
		const d = points[cropCorners[ic]].distance;
		let dPrev;
		if (!isLoop && ic === 0) {
			dPrev = 0;
		} else {
			dPrev =
				points[cropCorners[(ic - 1 + cropCorners.length) % cropCorners.length]]
					.distance;
			if (ic === 0) dPrev -= courseDistance;
		}

		let dNext;
		if (!isLoop && ic === cropCorners.length - 1) {
			dNext = points[maxIndex(points)].distance;
		} else {
			dNext = points[cropCorners[(ic + 1) % cropCorners.length]].distance;
			if (ic === cropCorners.length - 1) dNext += courseDistance;
		}

		// Pass criteria:
		// 1. point is in limits defined by start and/or stop
		// 2. corner is sufficiently far from neighbor corners
		let inLimits = true;
		if (start !== undefined) {
			if (end !== undefined) {
				if (isLoop && end < start) {
					inLimits = d >= end && d <= start;
				} else {
					inLimits = d <= end && d >= start;
				}
			} else {
				inLimits = d >= start;
			}
		} else {
			inLimits = end === undefined || d <= end;
		}

		const distanceCheck = dNext >= d + dMin && dPrev <= d - dMin;

		if (inLimits && distanceCheck) {
			cc.push(cropCorners[ic]);
		}
	}

	const finalCropCorners = cc;
	if (finalCropCorners.length === 0) return points;

	// We've identified corners to be cropped.
	// Insert points before and after, then eliminate points between the inserted points
	const pNew = [];

	let ic = 0;
	let dc1 = points[finalCropCorners[ic]].distance - cornerCrop;
	let dc2 = dc1 + 2 * cornerCrop;
	let i = 0;
	let p1 = points[i];
	let p2 = points[(i + 1) % points.length];

	pointsLoop: while (i < points.length) {
		// If it's point to point and we reached the last point, we're done
		if (!isLoop && i === maxIndex(points)) {
			pNew.push(points[i]);
			break;
		}

		let dp1 = p1.distance; // this point
		let dp2 = p2.distance; // next point
		if (dp2 < dp1) dp2 += courseDistance; // if wrap-around

		// If the first point is before or roughly coincident with the corner, it gets added
		if (dp1 <= dc1 + epsilon) {
			pNew.push(p1);
		}

		// If the next point is still before the crop interval, skip to next point
		if (dp2 < dc1 + epsilon) {
			i++;
			p1 = points[i];
			p2 = points[(i + 1) % points.length];
			continue;
		}

		// Next point > start of crop interval: interpolate a point if needed
		if (dc1 > dp1 + epsilon && dc1 < dp2 - epsilon) {
			p1 = interpolatePoint(p1, p2, (dc1 - dp1) / (dp2 - dp1));
			dp1 = dc1;
			pNew.push(p1);
		}

		// Skip points in crop interval
		while (dp2 < dc2 - epsilon) {
			// If p1 will extend to point set of points, we're done
			// Note for laps we can wrap around
			if (isLoop) {
				if (i + 1 > maxIndex(points)) {
					// corner wraps around: interpolate points
					const newPoints = arcFit(
						pNew[pNew.length - 2],
						pNew[pNew.length - 1],
						pNew[0],
						pNew[1],
						cornerCrop,
					);
					if (newPoints && newPoints.length > 0) {
						const iMid = int(newPoints.length / 2);
						pNew.push(...newPoints.slice(0, iMid));
						pNew.unshift(...newPoints.slice(iMid));
					}
					break pointsLoop;
				}
			} else if (i > maxIndex(points)) {
				break pointsLoop;
			}
			i++;
			p1 = p2;
			p2 = points[(i + 1) % points.length];
			dp1 = dp2;
			dp2 = p2.distance;
			if (dp2 < dp1) dp2 += courseDistance; // if wrap-around
		}

		// Handle exit point
		if (Math.abs(dp2 - dc2) < epsilon) {
			i++;
			p1 = p2;
			p2 = points[(i + 1) % points.length];
			dp1 = dp2;
			dp2 = p2.distance;
			if (dp2 < dp1) dp2 += courseDistance; // if wrap-around
		} else if (Math.abs(dp1 - dc2) > epsilon) {
			p1 = interpolatePoint(
				p1,
				p2,
				(dc2 - dp1) / (dp2 - dp1),
			);
			dp1 = dc2;
		}

		// arc fits
		if (pNew.length > 0) {
			const arcPoint1 =
				pNew.length > 1
					? pNew[pNew.length - 2]
					: points[points.length - 1];
			const arcPoint2 = pNew[pNew.length - 1];
			const arcPoint3 = p1;
			const arcPoint4 = p2;
			const newPoints = arcFit(
				arcPoint1,
				arcPoint2,
				arcPoint3,
				arcPoint4,
				cornerCrop,
			);
			if (newPoints) {
				pNew.push(...newPoints);
			}
		}

		// Skip to next corner point
		ic++;

		// Skip to next crop corner, else dump rest of points
		if (ic > finalCropCorners.length - 1) {
			if (isLoop) {
				ic -= finalCropCorners.length;
			} else {
				if (!(pNew.length > 0 && pointsAreClose(pNew[pNew.length - 1], p1))) {
					pNew.push(p1);
				}
				for (let k = i + 1; k < points.length; k++) pNew.push(points[k]);
				break;
			}
		}

		// Set corner points for new corner
		dc1 = points[finalCropCorners[ic]].distance - cornerCrop;
		while (dc1 < dp1) dc1 += courseDistance;
		dc2 = points[finalCropCorners[ic]].distance + cornerCrop;
		while (dc2 < dc1) dc2 += courseDistance;
	}

	deleteDerivedFields(pNew);
	return pNew;
}

/**
 * Fit a circular arc between p1 and p2, assuming straight from p0->p1 and p2->p3.
 * @param {Object} p0 - Point before start of arc
 * @param {Object} p1 - Start of arc
 * @param {Object} p2 - End of arc
 * @param {Object} p3 - Point after end of arc
 * @param {number} RMax - Maximum radius of arc
 * @param {number} dd - Minimum angle per point (default PI/16)
 * @returns {Array} Array of interpolated arc points between p1 and p2
 */
function arcFit(p0, p1, p2, p3, RMax, dd = PI / 16) {
	if (RMax === 0) return [];

	// calculate the intersection point: p1 -> d1
	const d01 = latlngDistance(p0, p1);
	const d23 = latlngDistance(p2, p3);
	let xy01 = latlng2dxdy(p0, p1);
	let xy12 = latlng2dxdy(p1, p2);
	let xy23 = latlng2dxdy(p2, p3);

	const c1 = xy01[0] / d01;
	const s1 = xy01[1] / d01;
	const c2 = xy23[0] / d23;
	const s2 = xy23[1] / d23;
	const cross = c1 * s2 - c2 * s1;

	if (Math.abs(cross) < 1e-6) return [];
	// sign positive: right turn, sign negative: left turn
	const sign = -spaceship(cross, 0);

	const points = [];
	let px; // extra point to add at end (if any)

	const dot = c1 * c2 + s1 * s2;
	// angle subtended by the corner: 0 => 180 degree turn, 180 => straight
	const theta = reduceAngle(Math.atan2(-cross, -dot));
	// multiplication factor for translating radius to position
	const fR = Math.abs(1 / Math.tan(theta / 2));

	// distance to intercept from p1, p2
	const di1 = (s2 * xy12[0] - c2 * xy12[1]) / cross;
	const di2 = (c1 * xy12[1] - s1 * xy12[0]) / cross;

	// if there's a negative value, bail
	if (di1 < 0 || di2 < 0) return [];

	// figure out radii from distance
	let R = (di1 > di2 ? di2 : di1) / fR;
	if (RMax !== undefined && RMax > 0 && R > RMax) R = RMax;

	const a = di1 - R * fR;
	const b = di2 - R * fR;

	// distance from p1 to new corner point
	if (Math.abs(a) > 0.01) {
		const f = a / (2 * R + a);
		const dz = (p2.ele - p1.ele) * f;
		let d1 = p1.distance;
		p1 = addVectorToPoint(p1, [a * c1, a * s1, dz]);
		d1 += a;
		p1.distance = d1;
		points.push(p1);
		xy01 = latlng2dxdy(p0, p1);
		xy12 = latlng2dxdy(p1, p2);
	}

	if (Math.abs(b) > 0.01) {
		// distance from p2 to new corner point
		const f = b / (2 * R + b);
		const dz = (p1.ele - p2.ele) * f;
		let d2 = p2.distance;
		px = addVectorToPoint(p2, [-b * c2, -b * s2, dz]);
		d2 -= b;
		px.distance = d2;
		p2 = px;
		xy12 = latlng2dxdy(p1, p2);
		xy23 = latlng2dxdy(p2, p3);
	}

	const cx = sign * s1 * R;
	const cy = -sign * c1 * R;

	const theta1 = Math.atan2(-cy, -cx);
	const theta2 = Math.atan2(xy12[1] - cy, xy12[0] - cx);

	const dTheta = reduceAngle(theta2 - theta1);
	const nPoints = int(Math.abs(dTheta / dd));

	const z1 = p1.ele;
	const z2 = p2.ele;
	const deltaZ =
		z1 !== undefined && z2 !== undefined ? z2 - z1 : 0;
	for (let n = 1; n <= nPoints; n++) {
		const f = n / (nPoints + 1);
		const thetaN = theta1 + dTheta * f;
		const dxN = cx + R * Math.cos(thetaN);
		const dyN = cy + R * Math.sin(thetaN);
		const dzN = f * deltaZ;
		points.push(addVectorToPoint(p1, [dxN, dyN, dzN]));
	}

	// if we need to add the extra point, do it here
	if (px !== undefined) points.push(px);

	interpolateFields(p1, ...points, p2);

	return points;
}

/**
 * adds splines to points
 * this can also be used for arc fitting
 * @param {Array} points - array of points to process
 * @param {number} minRadians - minimum angle for spline processing
 * @param {number} maxRadians - maximum angle for spline processing
 * @param {number} start - start distance (optional)
 * @param {number} end - end distance (optional)
 * @param {number} isLoop - whether the track is a loop (0 or 1)
 * @param {string} splineType - type of spline ("spline" or "arcFit")
 * @returns {Array} new array of points with splines added
 */
function addSplines(
	points,
	minRadians,
	maxRadians,
	start,
	end,
	isLoop = 0,
	splineType = "spline",
	maxRatio = 0,
) {
	note(`starting ${splineType} processing...`);

	// create a direction field
	addDirectionField(points, isLoop);

	// add a distance field if needed
	if (!points[0].distance && (start !== undefined || end !== undefined)) {
		addDistanceField(points);
	}

	const courseDistance = calcCourseDistance(points, isLoop);

	// find corners which meet spline criteria
	// two turns in the same direction, both less than max
	// assume sharper or single-point turns are intentional
	const pNew = [];
	const isArcFit = splineType === "arcFit";

	let count = 0;

	// i : first point on interpolation interval
	iLoop: for (let i = 0; i <= maxIndex(points); i++) {
		pNew.push(points[i]);

		// add points if appropriate
		// splines cannot be fit to first or last interval unless it's a loop
		if (isLoop || (i > 0 && i < maxIndex(points) - 1)) {
			const j = (i + 1) % points.length;
			if (pointsAreClose(points[i], points[j], 1)) {
				continue;
			}

			// if start and stop points are specified, then check these
			// both points i and j must pass the test
			if (start !== undefined && end !== undefined && end < start) {
				if (points[i].distance > start || points[j].distance > start) continue;
				if (points[i].distance < end || points[j].distance < end) continue;
			} else {
				if (
					start !== undefined &&
					(points[i].distance < start || points[j].distance < start)
				)
					continue;
				if (
					end !== undefined &&
					(points[i].distance > end || points[j].distance > end)
				)
					continue;
			}

			let k = (i - 1 + points.length) % points.length;
			while (pointsAreClose(points[i], points[k], 1)) {
				if (k === (isLoop ? j : 0)) continue iLoop;
				k = (k - 1 + points.length) % points.length;
			}

			let l = (j + 1) % points.length;
			while (pointsAreClose(points[j], points[l], 1)) {
				l = (l + 1) % points.length;
				if (isLoop) {
					if (l <= i && l >= k) continue iLoop;
				} else {
					if (l <= j) continue iLoop;
				}
			}
			if (isLoop) {
				if (l <= j && l >= k) continue iLoop;
			} else {
				if (l <= j) continue iLoop;
			}

			// points are in order: k i j l

			// check distance if there's a max ratio
			if (maxRatio > 0) {
				const d1 = distanceDifference(
					points[k],
					points[i],
					courseDistance,
					isLoop,
				);
				const d2 = distanceDifference(
					points[i],
					points[j],
					courseDistance,
					isLoop,
				);
				const d3 = distanceDifference(
					points[j],
					points[l],
					courseDistance,
					isLoop,
				);
				let r = d2 > d1 ? d2 / d1 : d1 / d2;
				if (r > maxRatio) continue iLoop;
				r = d3 > d2 ? d3 / d2 : d2 / d3;
				if (r > maxRatio) continue iLoop;
			}

			// turn angles
			const a1 = latlngAngle(points[k], points[i], points[j]);
			const a2 = latlngAngle(points[i], points[j], points[l]);
			if (a1 === null || a2 === null) continue;

			const turn = (a1 + a2) / 2;
			if (Math.abs(turn) > minRadians && Math.abs(turn) <= maxRadians) {
				let newPoints;
				if (isArcFit) {
					newPoints = arcFitInterpolation(
						points[k],
						points[i],
						points[j],
						points[l],
						courseDistance,
						isLoop,
						minRadians,
					);
				} else {
					newPoints = splineInterpolation(
						points[k],
						points[i],
						points[j],
						points[l],
						courseDistance,
						isLoop,
						minRadians,
					);
				}
				count += newPoints.length;
				for (const p of newPoints) {
					pNew.push(p);
				}
			}
		}
	}

	// remove distance field if we've added any points
	if (pNew.length > 0 && count > 0) {
		for (const field of ["direction", "distance"]) {
			if (pNew[0][field] !== undefined) {
				deleteField2(pNew, field);
			}
		}
	}

	return pNew;
}

/**
 * Calculate closest point on line segment from p1 to p2 to test point p3
 * @param {Array} p1 - First point [x, y]
 * @param {Array} p2 - Second point [x, y]
 * @param {Array} p3 - Test point [x, y]
 * @returns {Array} [f, d] where f is fraction along line, d is distance
 */
function xyPointOnLine(p1, p2, p3) {
	const [x1, y1] = p1;
	const [x2, y2] = p2;
	const [x3, y3] = p3;

	if (x1 === x2 && y1 === y2) {
		return [undefined, undefined];
	}

	const f =
		((y3 - y1) * (y2 - y1) + (x3 - x1) * (x2 - x1)) /
		((y2 - y1) ** 2 + (x2 - x1) ** 2);
	const d = Math.sqrt(
		(x1 - x3 + f * (x2 - x1)) ** 2 + (y1 - y3 + f * (y2 - y1)) ** 2,
	);

	return [f, d];
}

/**
 * checks whether px is on the line connecting p1 and p2
 * @param {Object} p1 - First point with {lat, lon} properties
 * @param {Object} p2 - Second point with {lat, lon} properties
 * @param {Object} px - Test point with {lat, lon} properties
 * @param {number} dmax - Maximum distance threshold (default 1m)
 * @returns {boolean} True if point is on the road segment
 */
function isPointOnLine(p1, p2, px, dmax = 1) {
	// If point is "on" an endpoint (within 10 cm) then true
	if (pointsAreClose(p1, px) || pointsAreClose(p2, px)) {
		return true;
	}

	// Check if it is within the margin of the line
	const [dx1, dy1] = latlng2dxdy(px, p1);
	const [dx2, dy2] = latlng2dxdy(px, p2);
	const [f, d] = xyPointOnLine([dx1, dy1], [dx2, dy2], [0, 0]);

	return f !== undefined && d !== undefined && f >= 0 && f <= 1 && d <= dmax;
}

/**
 * a corner version of whether the point is on the road...
 * but requires more points.
 * given 4 points, takes a direction from p1 to p2
 * and a direction from p3 to p4
 * if the direction from p2 to px, and from px to p3, falls in
 * between the directions from p1 to p2 and from p2 to p3,
 * then it's compatible with being on the line
 * @param {Object} p1 - First reference point
 * @param {Object} p2 - Second reference point
 * @param {Object} p3 - Third reference point
 * @param {Object} p4 - Fourth reference point
 * @param {Object} px - Test point
 * @returns {boolean} True if point is on the road corner
 */
function isPointOnCorner(p1, p2, p3, p4, px) {
	if (!px || !p2 || !p3) return false;

	if (pointsAreClose(px, p2) || pointsAreClose(px, p3)) {
		return true;
	}

	if (!p1 || !p4) return false;

	if (
		pointsAreClose(p2, p3) ||
		pointsAreClose(p1, p2) ||
		pointsAreClose(p3, p4)
	) {
		return false;
	}

	const d12 = latlngDirection(p1, p2);
	const d34 = latlngDirection(p3, p4);
	const d2x = latlngDirection(p2, px);
	const dx3 = latlngDirection(px, p3);

	// These angles are between -pi/2 and +pi/2
	const dA = deltaAngle(d12, d2x);
	const dB = deltaAngle(d12, dx3);
	const dC = deltaAngle(d12, d34);

	// If angles are monotonic, success
	return (dA >= 0 && dB >= dA && dC >= dB) || (dA <= 0 && dB <= dA && dC <= dB);
}

/**
 * do tests of if point i falls on the road in the range (j, k, l, m)
 * @param {Array} points - Array of points
 * @param {number} j - Point before first point
 * @param {number} k - First point
 * @param {number} l - Second point
 * @param {number} m - Point after second point
 * @param {number} i - Test point index
 * @param {number} d - Distance error margin
 * @returns {boolean} True if point passes road test
 */
function roadTest(points, j, k, l, m, i, d) {
	// First check to see if the point i falls in the range k .. l
	if (
		!(
			i > 0 &&
			k > 0 &&
			l > 0 &&
			i <= maxIndex(points) &&
			k <= maxIndex(points) &&
			l <= maxIndex(points)
		)
	) {
		return false;
	}

	if (isPointOnLine(points[k], points[l], points[i], d)) {
		return true;
	}

	if (!(j > 0 && m > 0 && j <= maxIndex(points) && m <= maxIndex(points))) {
		return false;
	}

	const cornerResult = isPointOnCorner(
		points[j],
		points[k],
		points[l],
		points[m],
		points[i],
	);

	return cornerResult;
}

/**
 * Fix zig-zag patterns in the route with loop support and iteration logic.
 * Added 0.53: fix zig-zags @ S/F on loops
 * @param {Array} points - Array of points to fix
 * @param {boolean} isLoop - Whether route is a loop (default: false)
 * @returns {Array} Fixed points array
 */
function fixZigZags(points, isLoop = false, verbose = 1) {
	for (let zigZagIter = 1; zigZagIter <= 10; zigZagIter++) {
		if (verbose)
			note(`checking for zig-zags iteration ${zigZagIter}...`);
		const dzigZag = 100;
		const UTurns = [];
		const iStart = isLoop ? 0 : 1;
		const iEnd = isLoop ? maxIndex(points) : maxIndex(points) - 1;

		for (let i = iStart; i <= iEnd; i++) {
			if (
				UTurnCheck(
					ix(points, i - 1),
					points[i],
					points[i],
					ix(points, i + 1),
					-0.9,
				)
			) {
				UTurns.push(i);
			}
		}

		addDistanceField(points);
		let zigZagCount = 0;

		if (UTurns.length > 0) {
			while (UTurns.length > 1) {
				const U1 = UTurns.shift();
				const U2 = UTurns[0];
				const p1 = points[U1];
				const p2 = points[U2];

				if (p2.distance - p1.distance < dzigZag) {
					if (verbose)
						warn(
							`WARNING: zig-zag found on points : ${U1} and ${U2} : ` +
								`${(0.001 * p1.distance).toFixed(4)} km: (${p1.lon}, ${p1.lat}) to ` +
								`${(0.001 * p2.distance).toFixed(4)} km: (${p2.lon}, ${p2.lat}) : ` +
								`separation = ${(p2.distance - p1.distance).toFixed(4)} meters`,
						);

					// Repairing zig-zags...
					// zig-zags are two U-turns within a specified distance
					// p1 -> p2 -> ... -> p3 -> p4
					// U-turn @ p2, and U-turn @ p3
					// 1. eliminate all points between p2 and p3
					// 2. as long as P3 has a U-turn, delete it... there will be a new P3
					// 3. as long as P2 has a U-turn, delete it...
					// 4. go back step 2 if we deleted any U-turns

					// eliminate points between
					warn(`repairing zig-zag iteration ${zigZagIter}...`);
					const u = U1; // keep points up to u
					let v = U2 + 1; // keep points starting with v

					while (
						v < maxIndex(points) &&
						UTurnCheck(points[u], points[v], points[v], points[v + 1])
					) {
						v++;
					}

					warn(`eliminating ${v - u - 1} points`);
					zigZagCount++;

					const pNew = [...points.slice(0, u + 1), ...points.slice(v)];

					// If we ran out of points, something is wrong
					if (pNew.length < 2) {
						/* istanbul ignore next */
						die("repairing zig-zags eliminated entire route");
					}

					points = pNew;

					// Adjust U-turn coordinates
					// We've eliminated the next Uturn, so pop it
					UTurns.shift();

					// Adjust coordinates of remaining U-turns
					for (let i = 0; i < UTurns.length; i++) {
						UTurns[i] += u - v + 1;
					}

					// Get rid of obsolete U-turns
					while (UTurns.length > 0 && UTurns[0] < 0) {
						UTurns.shift();
					}
				}
			}
			// May need to redo distance if zig-zag repair
			if (zigZagCount > 0) {
				deleteDerivedFields(points);
			}
		}
		if (zigZagCount === 0) {
			return points;
		}
	}
	return points;
}

/**
 * Fix altitude steps, likely due to Strava route editor missing data.
 * Removes flat segments by applying a uniform gradient to merge with
 * the steeper adjacent side.
 * @param {Array} points - Array of points
 * @param {number} isLoop - Whether route is a loop
 * @returns {Array} Points with fixed altitude steps
 */
function fixSteps(points, isLoop = 0) {
	const courseDistance = calcCourseDistance(points, isLoop);
	let stepCount = 0;
	note("checking for altitude steps ...\n");
	let i = 0;
	while (i < maxIndex(points)) {
		if (!isLoop && (i === 0 || i >= maxIndex(points) - 1)) {
			i++;
			continue;
		}
		let j = (i + 1) % points.length;

		// special case: check for repeated points in step
		let interpolatedPoints = 0;
		while (
			points[(j + 1) % points.length].ele === points[i].ele
		) {
			interpolatedPoints++;
			j = (j + 1) % points.length;
			if (
				j === i ||
				(!isLoop && (j < i || j === maxIndex(points)))
			) {
				return points;
			}
		}

		const p1 = points[((i - 1) + points.length) % points.length];
		const p2 = points[i];
		const p3 = points[j];
		const p4 = points[(j + 1) % points.length];

		const ds1 = pointSeparation(p1, p2, courseDistance, isLoop);
		const g1 = ds1 === 0 ? 0 : (p2.ele - p1.ele) / ds1;
		const ds2 = pointSeparation(p3, p4, courseDistance, isLoop);
		const g2 = ds2 === 0 ? 0 : (p4.ele - p3.ele) / ds2;
		if (
			p2.ele === p3.ele &&
			pointSeparation(p2, p3, courseDistance, isLoop) < 100 &&
			spaceship(p1.ele, p2.ele) === spaceship(p3.ele, p4.ele) &&
			Math.abs(g1) > 0.001 &&
			Math.abs(g2) > 0.001
		) {
			stepCount++;
			if (Math.abs(g1) > Math.abs(g2)) {
				// interpolate p2 altitude
				for (let n = 0; n <= interpolatedPoints; n++) {
					const px = points[(i + n) % points.length];
					px.ele =
						(p1.ele *
							pointSeparation(
								px,
								p3,
								courseDistance,
								isLoop,
							) +
							p3.ele *
								pointSeparation(
									p1,
									px,
									courseDistance,
									isLoop,
								)) /
						pointSeparation(p1, p3, courseDistance, isLoop);
				}
			} else {
				// interpolate p3 altitude
				for (let n = 0; n <= interpolatedPoints; n++) {
					const px = points[(i + 1 + n) % points.length];
					px.ele =
						(p2.ele *
							pointSeparation(
								px,
								p4,
								courseDistance,
								isLoop,
							) +
							p4.ele *
								pointSeparation(
									p2,
									px,
									courseDistance,
									isLoop,
								)) /
						pointSeparation(p2, p4, courseDistance, isLoop);
				}
			}
		}
		i += 1 + interpolatedPoints;
	}
	if (stepCount > 0) {
		note(`fixed ${stepCount} altitude steps.\n`);
	}
	return points;
}

/**
 * look for loops
 * @param {Array} points - Array of points
 * @param {number} isLoop - Whether route is a loop
 */
function findLoops(points, isLoop) {
	note("checking for loops...");
	const loopDistance = 100;

	addDistanceFieldIfNeeded(points);
	// note: direction has no discontinuities for unit circle compliance
	addDirectionField(points, isLoop);

	let u = 0;
	let v = 0;
	const loopAngle = 0.85 * TWOPI;

	while (v < points.length - 1) {
		const p = points[u];

		// Find endpoint within loop distance
		while (
			v < points.length - 1 &&
			points[v + 1].distance < p.distance + loopDistance
		) {
			v++;
		}

		if (Math.abs(p.direction - points[v].direction) > loopAngle) {
			// Find starting point of loop
			while (
				u + 1 < v &&
				Math.abs(points[u + 1].direction - points[v].direction) >
					loopAngle
			) {
				u++;
			}
			// Find ending point of loop
			while (
				v - 1 > u &&
				Math.abs(points[v - 1].direction - points[u].direction) >
					loopAngle
			) {
				v--;
			}

			warn(
				`WARNING: loop between distance: ` +
					`${(points[u].distance / 1000).toFixed(3)} km and ${(points[v].distance / 1000).toFixed(3)} km`,
			);

			u = v;
			continue;
		}
		u++;
	}

	// Clean up
	deleteField(points, "direction");
	if (points[0].heading !== undefined) {
		deleteField(points, "heading");
	}
}

/**
 * Apply lane shift to all points based on their shift field
 * @param {Array} points - Array of points with shift field
 * @param {number} isLoop - Whether this is a loop course
 * @returns {Array} New array of shifted points
 */
function applyLaneShift(points, isLoop) {
	if (!points.length) return points;

	// use curvature to limit lane shifts
	addCurvatureField(points, isLoop);
	addDistanceFieldIfNeeded(points);
	const courseDistance = calcCourseDistance(points, isLoop);

	const pNew = [];

	// create list of (x, y) coordinates
	const dxs = [];
	const dys = [];
	const dss = [];
	const ss = [0];
	const dirs = [];

	for (let i = 0; i < points.length; i++) {
		if (i > 0) ss.push(ss[ss.length - 1] + dss[dss.length - 1]);
		if (isLoop || i < maxIndex(points)) {
			const [dx, dy] = latlng2dxdy(points[i], points[(i + 1) % points.length]);
			dxs.push(dx);
			dys.push(dy);
			dss.push(Math.sqrt(dx ** 2 + dy ** 2));
			dirs.push(Math.atan2(dy, dx));
		}
	}

	// final point for point-to-point
	if (!isLoop) {
		dxs.push(dxs[dxs.length - 1]);
		dys.push(dys[dys.length - 1]);
		dss.push(dss[dss.length - 1]);
		dirs.push(dirs[dirs.length - 1]);
	}

	// lane shift: to right, which means adding pi/2 to the direction
	for (let i = 0; i < points.length; i++) {
		let dir1, dir2;
		if (i > 0 || isLoop) {
			dir1 = ix(dirs, i - 1);
			dir2 = dir1 + reduceAngle(dirs[i] - dir1);
		} else {
			dir1 = dirs[i];
			dir2 = dirs[i];
		}

		// check for excessive shift: R = 1/curvature, shift > R, shift x curvature > 1
		const t = points[i].curvature * points[i].shift;
		if (t < -0.75) {
			points[i].shift = -0.75 / points[i].curvature;
			// check to make sure lane shift isn't changing too rapidly to nearby points
			for (const dir of [-1, 1]) {
				let j = i + dir;
				while (true) {
					const d = pointSeparation(
						points[((j % points.length) + points.length) % points.length],
						points[i],
						courseDistance,
						isLoop,
					);
					const dShift =
						points[
							((j % points.length) + points.length) % points.length
						].shift - points[i].shift;
					if (2 * Math.abs(dShift) < d) break;
					points[
						((j % points.length) + points.length) % points.length
					].shift =
						points[i].shift + spaceship(dShift, 0) * (d / 2);
					if (
						!isLoop &&
						(((j % points.length) + points.length) % points.length ===
							0 ||
							((j % points.length) + points.length) %
								points.length ===
								maxIndex(points))
					)
						break;
					j = (j + dir + points.length) % points.length;
				}
			}
		}

		// for sharp turns repeat a point: there's no way to decide if it's an "inside" or "outside" sharp turn
		if (
			(isLoop || (i > 0 && i < maxIndex(points))) &&
			Math.abs(dir2 - dir1) > 0.99 * PI
		) {
			const pTurns = [];
			for (const dir of [dir1, dir2]) {
				pTurns.push(shiftPoint(points[i], dir, points[i].shift || 0));
			}
			// check if there's a knot.. if not use the doubled points
			const fs = segmentIntercept(
				[ix(points, i - 1), pTurns[0]],
				[pTurns[1], points[(i + 1) % points.length]],
			);
			if (fs.length === 0) {
				pNew.push(...pTurns);
				continue;
			}
		}

		pNew.push(shiftVertex(points[i], [dir1, dir2], points[i].shift || 0));
	}

	deleteDerivedFields(points);
	return pNew;
}

// checkRange: check if point i is within the specified distance range
function checkRange(points, start, end, i) {
	addDistanceFieldIfNeeded(points);

	if (start !== undefined && end !== undefined && end < start) {
		return points[i].distance >= start || points[i].distance <= end;
	}
	return (
		(start === undefined || points[i].distance >= start) &&
		(end === undefined || points[i].distance <= end)
	);
}

// findArcs: look for sections of the route which can be replaced with circular arcs
function findArcs(
	points,
	isLoop = 0,
	minAngle = PI / 4,
	minRadius = 10,
	maxRadius = 100,
	courseDistance,
	start,
	end,
) {
	const dMax = 10 + maxRadius * 2;
	note("findArcs called...");

	if (!isLoop && start !== undefined && end !== undefined && end <= start) {
		return [];
	}

	if (isLoop && courseDistance === undefined) {
		courseDistance = calcCourseDistance(points, isLoop);
	}

	// if it's a loop and last point matches first point, then remove it for now
	let pLast;
	if (isLoop && pointsAreClose(points[0], ix(points, -1))) {
		pLast = points.pop();
	}

	// check that curvature is available
	if (points[0].curvature === undefined) {
		addCurvatureField(points, isLoop);
	}
	addDistanceFieldIfNeeded(points);

	// netStats: calculate stats of curvature across range of points
	function netStats(pts, iStart, iEnd) {
		let cSum = 0;
		let c2Sum = 0;
		let cdSum = 0;
		let dSum = 0;
		let d2Sum = 0;
		let dTot = 0;
		let i = iStart;
		let N = 0;
		while (i !== iEnd) {
			const j = (i + 1) % pts.length;
			const d = distanceDifference(pts[i], pts[j], courseDistance, isLoop);
			cSum += ((pts[i].curvature + pts[j].curvature) * d) / 2;
			c2Sum +=
				((pts[i].curvature ** 2 + pts[j].curvature ** 2) * d) / 2;
			cdSum +=
				((dTot * pts[i].curvature + (dTot + d) * pts[j].curvature) *
					d) /
				2;
			dSum += (dSum + d / 2) * d;
			dTot += d;
			d2Sum += ((dTot ** 2 + (dTot + d) ** 2) * d) / 2;
			N++;
			i = j;
		}
		if (dTot <= 0) {
			return {
				distance: dTot,
				angle: cSum,
				mean: 0,
				slope: 0,
				var: 0,
				sigma: 0,
			};
		}
		let variance = c2Sum / dTot - (cSum / dTot) ** 2;
		if (N > 1) variance /= 1 - 1 / N;
		const mean = cSum / dTot;
		const sigma = variance < 0 ? 0 : Math.sqrt(variance);
		const slope =
			(dTot * cdSum - dSum * cSum) / (dTot * d2Sum - dSum ** 2);
		return {
			distance: dTot,
			angle: cSum,
			mean: mean,
			slope: slope,
			var: variance,
			sigma: sigma,
		};
	}

	// find regions of continuous, relatively constant radius
	const cMin = 0.5 / maxRadius;
	let j = 0;
	const arcs = [];

	while (j <= maxIndex(points)) {
		let i = j;

		// first point in possible arc
		while (Math.abs(points[i].curvature) < cMin && i < maxIndex(points)) {
			i++;
		}
		// last point in possible arc
		j = i + 1;

		// make sure points are in range
		if (
			!checkRange(points, start, end, i) ||
			!checkRange(points, start, end, j)
		) {
			j++;
			continue;
		}

		// increment j to the first failed point
		while (
			j <= maxIndex(points) &&
			Math.abs(points[j].curvature) > cMin &&
			Math.sign(points[i].curvature) === Math.sign(points[j].curvature) &&
			distanceDifference(
				points[j - 1],
				points[j],
				isLoop,
				courseDistance,
			) < dMax &&
			checkRange(points, start, end, j)
		) {
			j++;
		}

		j = ((j - 1) % points.length + points.length) % points.length;

		// if i = j, then we want to jump two points ahead
		if (i === j) {
			i += 2;
			j += 2;
			continue;
		}

		let stats = netStats(points, i, j);
		const i0 = i;
		const j0 = j;

		// prune points at beginning and end at sufficiently more or less than mean
		const mean0 = stats.mean;
		while (
			(i + 1) % points.length !== j &&
			Math.abs(points[i].curvature - mean0) > Math.abs(0.5 * mean0)
		) {
			i = (i + 1) % points.length;
		}
		while (
			((j - 1) % points.length + points.length) % points.length !== i &&
			Math.abs(points[j].curvature - mean0) > Math.abs(0.5 * mean0)
		) {
			j = ((j - 1) % points.length + points.length) % points.length;
		}

		if (j === i) {
			j = i + 2;
			continue;
		}

		// update stats
		if (i !== i0 || j !== j0) {
			stats = netStats(points, i, j);
		}

		// check if angle is sufficient
		const angle = stats.angle;
		if (Math.abs(angle) < minAngle) {
			j = j + 2;
			continue;
		}

		// check if curvature is sufficiently uniform
		const sigma = stats.sigma;
		const mean = stats.mean;
		const slope = stats.slope;
		const distance = stats.distance;

		if (
			!(
				Math.abs(slope * distance) > Math.abs(mean) / 3 ||
				sigma > Math.abs(mean) / 3
			)
		) {
			note(`arc found from points ${i} to ${j}`);
			let d = j - i;
			d -= Math.floor(d / points.length);
			if (d > 1) {
				arcs.push([i, j]);
			}
		}
		j = j + 2;
	}

	if (pLast !== undefined) {
		points.push(pLast);
	}
	note(`number of arcs found = ${arcs.length}`);
	return arcs;
}

// fitArc: replace points with circular arc
function fitArc(points, dTheta = 15 * DEG2RAD, dMax = 2, uniformGradient = 0) {
	// we need at least 3 points to fit an arc
	if (points.length <= 2) return undefined;

	const N = points.length;
	const ia = 0;
	let ib = Math.round(N / 3);
	if (ib === ia) ib = 1;
	let ic = Math.round((2 * N) / 3);
	if (ic === ib) ic = ib + 1;
	const id = N - 1;
	let i0 = ia;
	let i1 = ib;
	let i2 = ic;

	const xys = [[0, 0]];
	// convert points to (x, y)
	for (let i = 1; i < points.length; i++) {
		xys.push(latlng2dxdy(points[0], points[i]));
	}

	const xy0s = [];
	const rs = [];
	while (i0 !== ib && i1 !== ic && i2 !== id) {
		const xy1 = xys[i0];
		const xy2 = xys[i1];
		const xy3 = xys[i2];
		const [xy0, r] = circle3PointFit(xy1, xy2, xy3);
		if (r !== undefined && xy0 !== undefined) {
			rs.push(r);
			xy0s.push(xy0);
		}
		i0++;
		i1++;
		i2++;
	}
	if (rs.length === 0) return undefined;

	// check for outliers
	let rSum = 0;
	for (const r of rs) {
		rSum += r;
	}
	const rMean = rSum / rs.length;
	let xSum = 0;
	let ySum = 0;
	let nSum = 0;
	for (let i = 0; i < rs.length; i++) {
		if (rs[i] < 2 * rMean) {
			xSum += xy0s[i][0];
			ySum += xy0s[i][1];
			nSum++;
		}
	}
	const xyC = [xSum / nSum, ySum / nSum];

	// check radii
	const rPoints = [];
	for (const xy of xys) {
		const rPoint = Math.sqrt(
			(xy[0] - xyC[0]) ** 2 + (xy[1] - xyC[1]) ** 2,
		);
		if (Math.abs(rPoint - rMean) > dMax) return undefined;
		rPoints.push(rPoint);
	}
	const rStart = rPoints[0];
	const rEnd = rPoints[rPoints.length - 1];

	// convert the points using same theta, interpolating if needed
	const theta0 = Math.atan2(xys[0][1] - xyC[1], xys[0][0] - xyC[0]);
	const thetas = [theta0];

	const pFits = [];
	for (let i = 1; i < xys.length; i++) {
		const theta = Math.atan2(xys[i][1] - xyC[1], xys[i][0] - xyC[0]);
		const dTheta2 = deltaAngle(thetas[thetas.length - 1], theta, theta);
		thetas.push(thetas[thetas.length - 1] + dTheta2);
	}

	const z0 = points[0].ele;
	const zf = points[points.length - 1].ele;
	for (let i = 1; i < xys.length; i++) {
		const deltaTheta2 = thetas[i] - thetas[i - 1];
		const NPoints = 1 + Math.round(Math.abs(deltaTheta2 / dTheta));
		const j0 = pFits.length === 0 ? 0 : 1;
		const lat0 = points[0].lat;
		const lng0 = points[0].lon;
		const latlng0 = [lat0, lng0];
		for (let jj = j0; jj <= NPoints; jj++) {
			const theta =
				(thetas[i - 1] * (NPoints - jj) + thetas[i] * jj) / NPoints;
			const f = jj / NPoints;
			const fTheta =
				(theta - thetas[0]) / (thetas[thetas.length - 1] - thetas[0]);
			const r = rStart * (1 - fTheta) + rEnd * fTheta;
			const x = xyC[0] + r * Math.cos(theta);
			const y = xyC[1] + r * Math.sin(theta);
			const latlng = addVectorToLatLng(latlng0, [x, y]);
			const p = interpolatePoint(points[i - 1], points[i], f);
			p.lat = latlng[0];
			p.lon = latlng[1];
			if (uniformGradient) {
				p.ele = z0 * (1 - fTheta) + zf * fTheta;
			}
			pFits.push(p);
		}
	}
	return pFits;
}

// fitArcs: replace ranges of points with circular arcs
function fitArcs(points, arcs = [], isLoop = 0, dTheta, dMax, uniformGradient) {
	if (!points.length || !arcs.length) return points;

	const pNew = [];
	let i0 = 0;

	for (const arc of arcs) {
		const i1 = arc[0];
		const i2 = arc[1];
		let arcPoints;
		if (i2 >= i1) {
			arcPoints = points.slice(i1, i2 + 1);
		} else {
			arcPoints = [...points.slice(i1), ...points.slice(0, i2 + 1)];
		}
		const fitPoints = fitArc(arcPoints, dTheta, dMax, uniformGradient);
		if (fitPoints !== undefined && fitPoints.length > 0) {
			for (let k = i0; k < i1; k++) pNew.push(points[k]);
			for (const p of fitPoints) pNew.push(p);
			i0 = i2 + 1;

			// wrap around special case
			if (isLoop && arc[1] < arc[0]) {
				const pStart = pNew.pop();
				// remove points at start of loop
				for (let i = 1; i <= arc[1]; i++) {
					pNew.shift();
				}
				// shift points while they get closer to original start point
				while (
					latlngDistance(ix(pNew, -1), pStart) <
					latlngDistance(pNew[0], pStart)
				) {
					pNew.unshift(pNew.pop());
				}
			}
		}

		deleteDerivedFields(pNew);
	}
	for (let k = i0; k < points.length; k++) pNew.push(points[k]);
	return pNew;
}

// findAndFitArcs: find arcs and fit them
function findAndFitArcs(
	points,
	isLoop = 0,
	fitArcsRadians,
	fitArcsDMax,
	fitArcsUniformGradient,
	start,
	end,
) {
	const arcs = findArcs(points, isLoop, undefined, undefined, undefined, undefined, start, end);
	const pNew = fitArcs(
		points,
		arcs,
		isLoop,
		fitArcsRadians,
		fitArcsDMax,
		fitArcsUniformGradient,
	);
	return pNew;
}

/**
 * Smoothing function that applies Gaussian smoothing to specified fields
 * @param {Array} points - Array of points to smooth
 * @param {Array} fields - Fields to smooth (e.g., ["lat", "lon"], ["ele"], ["gradient"])
 * @param {number} isLoop - Whether the track is a loop (0 or 1)
 * @param {string} sigmaField - Name of field containing per-point sigma values (optional)
 * @param {number} sigmaFactor - Factor to scale sigma field values (default: 1)
 * @param {number} sigma - Uniform smoothing sigma value (default: 0)
 * @param {Array} weighting - Per-point weighting array (optional)
 * @param {number} cornerEffect - Corner effect factor (default: 0)
 * @returns {Array} New array of smoothed points
 */
function smoothing(
	points,
	fields,
	isLoop = 0,
	sigmaField = "",
	sigmaFactor = 1,
	sigma = 0,
	weighting = [],
	cornerEffect = 0,
) {
	const sigma02 = sigma ** 2;

	note("smoothing proc called...");
	note(`smoothing ${fields.join(",")} with σ = ${sigma}`);
	if (sigmaField !== "") {
		note(`smoothing sigma field = ${sigmaField}`);
	}

	if (
		!(
			fields.length > 0 &&
			(sigma > 0 || (sigmaField && sigmaField !== "" && sigmaFactor > 0))
		)
	) {
		return points;
	}

	// if lon is one of the fields, calculate a dlon field
	const smoothedFields = [];
	for (const f of fields) {
		if (f === "lon") {
			points[0].dlon = 0;
			for (let i = 1; i < points.length; i++) {
				points[i].dlon =
					points[i - 1].dlon +
					deltalng(points[i - 1].lon, points[i].lon);
			}
			smoothedFields.push("dlon");
		} else {
			smoothedFields.push(f);
		}
	}

	const pNew = [];

	if (cornerEffect && points[0].curvature === undefined) {
		addCurvatureField(points, isLoop);
	}

	const useWeighting = weighting.length > 0;
	if (useWeighting) {
		note(`smoothing ${fields.join(",")} with weighting.`);
	}
	if (cornerEffect > 0) {
		note(
			`smoothing ${fields.join(",")} with the corner effect = ${cornerEffect}.`,
		);
	}

	// step thru the points
	for (let i = 0; i < points.length; i++) {
		const p = points[i];
		const sigmap =
			p[sigmaField] !== undefined ? Math.abs(sigmaFactor * p[sigmaField]) : 0;
		const effectiveSigma =
			sigmap <= 0
				? sigma
				: sigma <= 0
					? sigmap
					: Math.sqrt(sigma02 + sigmap ** 2);

		// create smoothed data: initialize with unsmoothed data
		const newPoint = { ...p };

		if (effectiveSigma > 0) {
			let adjustedSigma = effectiveSigma;
			if (useWeighting && weighting[i] > 0) {
				adjustedSigma /= weighting[i];
			}

			if (adjustedSigma < 0.01) {
				pNew.push(p);
				continue;
			}

			const dsMax = Math.abs(4 * adjustedSigma);

			let j = i;
			let s = 0;
			while ((j > 0 || isLoop) && j > i - points.length && s < dsMax) {
				const p1 = ix(points, j);
				const p2 = ix(points, j - 1);
				const ds = latlngDistance(p1, p2);
				s += ds;

				// a 1 radian turn is the same as 2 sigma for cornerEffect = 1
				if (cornerEffect > 0) {
					s +=
						ds * cornerEffect * (p2.curvature + p1.curvature) * adjustedSigma;
				}
				j--;
			}

			s = 0;
			let k = i;
			while (
				(k < maxIndex(points) || isLoop) &&
				k < i + points.length &&
				s < dsMax
			) {
				const l = k % points.length;
				const m = (k + 1) % points.length;
				const ds = latlngDistance(points[l], points[m]);
				s += ds;
				if (cornerEffect > 0) {
					s +=
						ds *
						cornerEffect *
						(points[l].curvature + points[m].curvature) *
						adjustedSigma;
				}
				k++;
			}

			// create list of separations
			s = 0;
			const ss = [0];
			for (let ii = j; ii < k; ii++) {
				s += latlngDistance(ix(points, ii + 1), ix(points, ii));
				ss.push(s);
			}

			let sum0 = 0;
			const sum1 = {};

			const us = [];

			// find normalized distance to center point
			for (let ii = 0; ii < ss.length; ii++) {
				us.push((ss[ii] - ss[i - j]) / adjustedSigma);
			}

			if (us.length < 2) {
				pNew.push(p);
				continue;
			}

			// linearized approximation
			// more sophisticated approach could use 2D convolution
			for (let ii = 0; ii < us.length; ii++) {
				const u = us[ii];
				const point = ix(points, j + ii);

				// weight by distance
				let du = ii > 0 ? u - us[ii - 1] : 0;
				if (ii < us.length - 1) {
					du += us[ii + 1] - u;
				}
				const w = Math.exp(-(u ** 2) / 2) * du;
				sum0 += w;

				for (const field of smoothedFields) {
					sum1[field] = (sum1[field] || 0) + w * point[field];
				}
			}
			for (const field of smoothedFields) {
				if (sum0 !== 0) {
					newPoint[field] = sum1[field] / sum0;
				}
			}
		}
		pNew.push(newPoint);
	}

	// handle dlon if longitude smoothing was done
	if (pNew[0].dlon !== undefined) {
		for (const p of pNew) {
			let lon = points[0].lon + p.dlon;
			lon -= 360 * Math.floor(lon / 360 + 0.5);
			p.lon = lon;
			delete p.dlon;
		}
	}

	// delete curvature field if we modified position
	if (
		fields.some((f) => f.startsWith("lat")) ||
		fields.some((f) => f.startsWith("lon"))
	) {
		deleteDerivedFields(pNew);
	}

	return pNew;
}

/**
 * Automatic spacing interpolation at corners to improve smoothing resolution
 * Iterates through points and adds interpolated points around sharp corners
 * to provide better smoothing resolution for subsequent processing
 * @param {Array} points - Array of points with lat, lon, ele properties
 * @param {boolean} isLoop - Whether the route is a closed loop
 * @param {number} lSmooth - Smoothing length parameter
 * @param {number} smoothAngle - Smoothing angle threshold in degrees
 * @param {number} minRadius - Minimum radius constraint
 * @returns {Array} Modified points array with additional interpolated points
 */
function doAutoSpacing(points, isLoop, lSmooth, smoothAngle, minRadius) {
	const smoothRadians = smoothAngle * DEG2RAD;

	const courseDistance = calcCourseDistance(points, isLoop);

	// iterate a few times
	for (
		let autoSpacingIteration = 0;
		autoSpacingIteration <= 0;
		autoSpacingIteration++
	) {
		// do this in each direction
		for (let direction = 0; direction <= 1; direction++) {
			const pNew = [];

			// refine distance -- need to exceed the smoothing length
			// on spacing: minRadius will increase the separation of points,
			// so we need to be careful how we consider this
			const lambda = Math.sqrt(1 + lSmooth ** 2);
			const dRefine = 3 * Math.sqrt(lSmooth ** 2 + minRadius ** 2);

			iLoop: for (let i = 0; i <= maxIndex(points); i++) {
				pNew.push(points[i]); // temporarily put the latest point on the new points list

				// there's nothing behind the first point -- copy it to the last point to get refinement
				if (i === 0) {
					continue;
				}

				if (isLoop || i < maxIndex(points)) {
					// find points which define an angle
					let i1 = i - 1;
					let i2 = (i + 1) % points.length;
					let d1;
					let d2;

					while ((d1 = latlngDistance(ix(points, i1), points[i])) < 0.01) {
						i1--;
						if ((!isLoop && i1 < 0) || i1 === i) {
							continue iLoop;
						}
						i1 = ((i1 % points.length) + points.length) % points.length;
					}

					while ((d2 = latlngDistance(points[i2], points[i])) < 0.01) {
						i2++;
						if ((!isLoop && i2 > maxIndex(points)) || i2 === i) {
							continue iLoop;
						}
						i2 = i2 % points.length;
					}

					// determine the angle between the points
					const a = latlngAngle(ix(points, i1), points[i], points[i2]);

					// add points if needed
					if (smoothRadians === undefined) {
						/* istanbul ignore next */
						die(
							`ERROR: smoothRadians not defined (smoothAngle = ${smoothAngle})`,
						);
					}

					if (Math.abs(a) > Math.abs(smoothRadians)) {
						// refine spacing -- need to refine to sufficient resolution to resolve the angle
						// this was multiplied by 0.5, but that generated too many points, so updating
						const spacing = lambda * (0.01 + Math.abs(smoothRadians / a));

						// tricky bit -- we need to insert points back to the desired range, but that may extend earlier than points
						// which we've already placed, so we'll need to keep track of points as we rewind.

						// find interval on which to add first point
						let s = 0;
						let i3 = maxIndex(pNew);
						const ds = [];
						ds[i3] = 0;

						while (s < dRefine) {
							if (i3 <= 0) {
								break;
							}
							i3--;
							ds[i3] = latlngDistance(pNew[i3], pNew[i3 + 1]);
							s += ds[i3];
						}

						// find the start point, between point i3 and i3 + 1
						let f;
						if (s > dRefine) {
							f = (s - dRefine) / ds[i3]; // how far over the segment goes
						} else {
							f = 0;
						}

						// strip off the points beyond i3, to save for later
						const pStack = [];
						while (maxIndex(pNew) > i3) {
							pStack.push(pNew.pop());
						}

						// add first point for corner smoothing, unless another point is close
						const ff = (0.5 * spacing) / ds[maxIndex(pNew)]; // normalized spacing of new points
						if (f > ff && f < 1 - ff) {
							pNew.push(
								interpolatePoint(
									pNew[maxIndex(pNew)],
									pStack[maxIndex(pStack)],
									f,
									courseDistance,
									isLoop,
								),
							);
							// adjust spacing to next point to account for interpolated point
							ds[maxIndex(pNew)] = ds[maxIndex(pNew) - 1] * (1 - f);
							ds[maxIndex(pNew) - 1] *= f;
						}

						// go thru points in stack, and adjust spacings
						while (pStack.length > 0) {
							const p1 = pNew[maxIndex(pNew)];
							const p2 = pStack[maxIndex(pStack)];
							const dsTot = latlngDistance(p1, p2);
							const N = Math.round(dsTot / spacing);

							if (N > 0) {
								ds[maxIndex(pNew)] = dsTot / N;
								for (let n = 1; n <= N - 1; n++) {
									pNew.push(
									interpolatePoint(
										p1,
										p2,
										n / N,
										courseDistance,
										isLoop,
									),
								);
									ds[maxIndex(pNew)] = dsTot / N;
								}
							} else {
								ds[maxIndex(pNew)] = dsTot;
							}
							pNew.push(pStack.pop());
							ds[maxIndex(pNew)] = 0;
						}
					}
				}
			}
			points = pNew.slice().reverse();
		}
	}
	return points;
}

/**
 * Interpolates points along a route to achieve consistent spacing
 * @param {Array} points - Array of points with lat, lon, ele properties
 * @param {number} isLoop - Whether this is a loop route (1) or point-to-point (0)
 * @param {number} spacing - Desired spacing between points in meters
 * @returns {Array} Array with interpolated points added
 */
function doPointInterpolation(points, isLoop, spacing) {
	const courseDistance = calcCourseDistance(points, isLoop);

	note("interpolation..");
	const pNew = [];
	const iMax = maxIndex(points) - (isLoop ? 0 : 1);

	for (let i = 0; i <= iMax; i++) {
		const p1 = points[i];
		const p2 = points[(i + 1) % points.length];
		pNew.push(p1);

		const ps = latlngDistance(p1, p2);
		const npoints = int(ps / spacing + 0.5);

		// interpolate points...
		for (let n = 1; n <= npoints - 1; n++) {
			pNew.push(
				interpolatePoint(p1, p2, n / npoints, courseDistance, isLoop),
			);
		}
	}

	if (!isLoop) {
		pNew.push(points[points.length - 1]);
	}

	note(
		`interpolation increased course from ${points.length} to ${pNew.length} points`,
	);
	return pNew;
}

/**
 * Snap overlapping segments of a GPS track to align with earlier segments
 * @param {Array} points - Array of GPS points with lat, lon, ele properties
 * @param {Array} snap - Reference points to snap to (usually same as points)
 * @param {number} snapDistance - Maximum distance threshold for snapping (default: 2m)
 * @param {number} snapAltitude - Maximum altitude difference for snapping (default: 1m)
 * @param {number} snapTransition - Distance for altitude transition smoothing (default: 0m)
 * @param {number} spacing - Point spacing parameter (default: 0)
 * @returns {Array} New array with snapped points
 */
function snapPoints(
	points,
	snap,
	snapDistance = 2,
	snapAltitude = 1,
	snapTransition = 0,
	spacing = 0,
	isLoop = 0,
) {
	if (!points.length) return points;

	// Ensure distance field exists
	addDistanceField(points);

	// snap = 1: subsequent laps snap to position of earlier laps
	// snap = 2: earlier laps snap to position of later laps
	// snap 2 can be handled by reversing points, then doing snap, then reversing back

	// If we're snapping later for earlier, flip points
	if (snap === 2) {
		points.reverse();
	}

	// On large courses, since initial search is O(N-squared), step thru multiple points, then refine
	// Snap step 1 has a potential bug (infinite loop) so lower bound is 2. /1000 works better in tests
	const snapStep = 2 + int(points.length / 1000);

	// Maximum range at which we check for snapping...
	// so if colinear points are spaced more than twice this, we may miss snapping onto that interval
	let snapRange = spacing > 0 ? snapStep * spacing : 100;
	snapRange = Math.min(snapRange, 100);

	// Threshold for checking if points are close for snapping
	const dsClose = snapDistance / 2;

	// i is on the "earlier" segment, j on the "later" segment
	// note this excludes starting point and end point
	iLoop: for (let i = 0; i < maxIndex(points) - 1; i += snapStep) {
		const p1 = points[i];
		const visited = new Set();

		let j = i + snapStep;
		if (j > maxIndex(points)) continue;

		// Get out of snap range: get point j beyond the snap range of point i
		// This is geometric distance, not course distance, which could potentially be an issue
		let d = 0;
		while ((d = latlngDistance(p1, points[j])) <= snapRange) {
			j += snapStep;
			if (j >= maxIndex(points)) continue iLoop;
		}

		// Keep going until distance between j and i stops increasing
		while (j <= maxIndex(points)) {
			const d2 = latlngDistance(p1, points[j]);
			if (d2 < d) break;
			d = d2;
			j += snapStep;
			if (j >= maxIndex(points)) continue iLoop;
		}

		// Keep moving until j comes back into snap range of i
		jLoop1: while (j <= maxIndex(points)) {
			// Make sure we don't try the same value twice (moving forward and backward could cause this)
			if (visited.has(j)) continue iLoop;
			visited.add(j);

			// Looking for j sufficiently close to i and connected with less than a 30% slope
			// Slope requirement avoids snapping across tight switchbacks or a hypothetical "spiral"
			while (
				(d = latlngDistance(p1, points[j])) > snapRange ||
				Math.abs(p1.ele - points[j].ele) > snapAltitude + 0.3 * d
			) {
				j += snapStep;
				if (j >= maxIndex(points)) continue iLoop;
			}

			// Find local minimum of distance... reduced step distance to 1
			while (j <= maxIndex(points)) {
				d = latlngDistance(p1, points[j]);

				// Distance to point forward
				const df =
					j < maxIndex(points) ? latlngDistance(p1, points[j + 1]) : undefined;
				// Distance to point backward
				const db = j > 0 ? latlngDistance(p1, points[j - 1]) : undefined;

				if (df !== undefined && df < d) {
					j++;
					continue;
				}
				if (db !== undefined && db < d) {
					j--;
					continue;
				}
				break;
			}

			// We've now brought point j close to point i. This could be fooled with a sufficiently complicated
			// route, but so far it seems to work fairly well

			// Check altitude. If altitude is out of range, maybe we're across a tight switchback, or there's a bridge or tunnel
			// This was already done previously, but now we're closer
			if (Math.abs(p1.ele - points[j].ele) > 1 + 0.3 * d) {
				j += snapStep;
				continue;
			}

			// We've got a possible point match between two points.
			// Check dot products - the lines need to be in similar directions

			// Set direction for checking dot product
			let di = 0;
			if (j < maxIndex(points) && i < maxIndex(points)) {
				di = 1;
			} else if (j > 0 && i > 0) {
				di = -1;
			} else {
				continue iLoop;
			}

			const p2 = points[i + di];
			const p3 = points[j];
			const p4 = points[j + di];

			// Dot product
			// dot product = 1: same direction
			// dot product = -1: opposite direction
			// dot product close to zero: intersection, perhaps -- ignore
			// Set for 45 degree angle right now
			const dot = latlngDotProduct(p1, p2, p3, p4) ?? 0;
			let sign;
			if (dot > 0.7) {
				sign = 1;
			} else if (dot < -0.7) {
				sign = -1;
			} else {
				// Vectors are relatively perpendicular, move on
				j += snapStep;
				continue;
			}

			// Point i is matched to point j, and the two are moving in the same direction
			// For each point j, if it falls on a line of points i, then replace the nearest point i
			// First we need to find values of j which are encapsulated by i
			// j will be replaced by i
			let ja, jb;

			jLoop2_2: while (true) {
				// Search range near j: j was point nearest i so it should be close
				// Nearest found the nearest point, but we're looking for the segment,
				// and the nearest point may not mark the intersecting segment, so check proximity
				for (ja of [j, j - sign, j + sign, j - 2 * sign]) {
					jb = ja + sign;

					// Checking if point i falls on the line between ja and jb
					if (roadTest(points, ja - 1, ja, jb, jb + 1, i, snapDistance)) {
						j = jb;
						break jLoop2_2;
					}
				}
				// Didn't find a match... move to next point
				continue iLoop;
			}

			let j1 = j - sign;
			let j2 = j;

			// Starting point:
			// j1 ... i1 ... i2 ... j2
			// i's are encapsulated by j's
			// Initial point is we have only a single point i1 = i2 = i
			// j2 = j1 + 1

			let i1 = i;
			let i2 = i;

			// Keep shifting boundaries until we don't expand them anymore
			let flag1, flag2;

			do {
				// Shift i1 down as long as along line from j1 to j2
				while (
					i1 > 0 &&
					roadTest(points, j1 - sign, j1, j2, j2 + sign, i1 - 1, snapDistance)
				) {
					i1--;
				}

				// As long as they are coincident, increase i1 and j1 together (short cut)
				while (
					i1 > 0 &&
					j1 > i2 &&
					j1 < maxIndex(points) &&
					pointsAreClose(
						points[i1 - 1],
						ix(points, j1 - sign),
						dsClose,
						snapAltitude,
					)
				) {
					i1--;
					j1 -= sign;
				}

				// Shift up i2 as long as along line from j1 to j2
				while (
					i2 < j1 &&
					roadTest(points, j1 - sign, j1, j2, j2 + sign, i2 + 1, snapDistance)
				) {
					i2++;
				}

				// As long as they are coincident, increase i2 and j2 together (short cut)
				while (
					i2 < j1 &&
					j2 > i2 &&
					j2 < maxIndex(points) &&
					pointsAreClose(
						points[i2 + 1],
						points[j2 + sign],
						dsClose,
						snapAltitude,
					)
				) {
					i2++;
					j2 += sign;
				}

				flag1 = false;
				const iTest = i1 - 1;
				if (iTest > 0) {
					// Push jTest up against iTest
					let jTest = j1;
					while (
						jTest > i2 &&
						jTest <= maxIndex(points) &&
						roadTest(
							points,
							iTest - 1,
							iTest,
							iTest + 1,
							iTest + 2,
							jTest - sign,
							snapDistance,
						)
					) {
						jTest -= sign;
					}

					// Hop jTest past iTest: test that iTest lays in line of j points
					if (
						jTest > i2 &&
						jTest <= maxIndex(points) &&
						(flag1 = roadTest(
							points,
							jTest - 2 * sign,
							jTest - sign,
							jTest,
							jTest + sign,
							iTest,
							snapDistance,
						))
					) {
						jTest -= sign;
					}

					if (flag1) {
						j1 = jTest;
						i1 = iTest;
					}
				}

				flag2 = false;
				const iTest2 = i2 + 1;
				if (iTest2 >= j1) {
					let jTest = j2;

					// Push jTest up against iTest2 (it's between j2 and jTest)
					while (
						jTest > iTest2 &&
						jTest <= maxIndex(points) &&
						roadTest(
							points,
							iTest2 - 2,
							iTest2 - 1,
							iTest2,
							iTest2 + 1,
							jTest + sign,
							snapDistance,
						)
					) {
						jTest += sign;
					}

					// Hop past iTest2
					if (
						jTest > iTest2 &&
						jTest <= maxIndex(points) &&
						(flag2 = roadTest(
							points,
							jTest - sign,
							jTest,
							jTest + sign,
							jTest + 2 * sign,
							iTest2,
							snapDistance,
						))
					) {
						jTest += sign;
					}

					if (flag2) {
						j2 = jTest;
						i2 = iTest2;
					}
				}
			} while (flag1 || flag2);

			// Splice in the snapped points
			// irange encapsulates j range
			// May need to retain outer points of j range if they're not duplicated by points in irange

			// Avoid duplicate points at ends of range
			// This is the same independent of sign: i1 connects with j1, i2 connects with j2
			while (i1 < i2 && pointsAreClose(points[i1], points[j1])) {
				i1++;
			}
			while (i2 > i1 && pointsAreClose(points[i2], points[j2])) {
				i2--;
			}

			if (i1 >= i2) {
				j += snapStep;
				continue;
			}

			if (sign === 0) {
				die("Zero sign encountered");
			}

			// Now check for zig-zags at start... algorithm shouldn't allow them.
			while (true) {
				const p1_zig = points[j1];
				const p2_zig = points[i1];
				const p3_zig = points[i1 + 1];
				if (p1_zig && p2_zig && p3_zig) {
					const dot_zig = latlngDotProduct(p1_zig, p2_zig, p2_zig, p3_zig);
					if (dot_zig !== null && dot_zig > -0.9) break;
				}
				i1++;
				if (i1 >= i2) {
					j += snapStep;
					continue jLoop1;
				}
			}

			// Now check for zig-zags at end... algorithm shouldn't allow them.
			while (true) {
				const p1_zig = points[j2];
				const p2_zig = points[i2];
				const p3_zig = ix(points, i2 - 1);
				if (p1_zig && p2_zig && p3_zig) {
					const dot_zig = latlngDotProduct(p1_zig, p2_zig, p2_zig, p3_zig);
					if (dot_zig !== null && dot_zig > -0.9) break;
				}
				i2--;
				if (i1 >= i2) {
					j += snapStep;
					continue jLoop1;
				}
			}

			if (i2 > i1 && Math.abs(j2 - j1) > 0) {
				note(
					`i = ${i}, j = ${j}: snapping ${sign > 0 ? "forward" : "reverse"} segment: ${i1} .. ${i2} <=> ${j1} .. ${j2}`,
				);

				const pNew = [];
				if (sign > 0) {
					// Keep everything up to start of j range
					for (let k = 0; k <= j1; k++) pNew.push(points[k]);

					// Splice in i range (exclude end-points)
					// Try to match up segments if possible
					// Segment matching by relative distance, but we need to nudge if we encounter a duplicate
					let j = j1;
					for (let i = i1; i <= i2; i++) {
						if (
							j < j2 &&
							Math.abs(points[i].distance - ix(points, i - 1).distance) < 0.05
						) {
							j++;
						}

						while (
							j < j2 &&
							Math.abs(
								Math.abs(points[j + 1].distance - points[j1].distance) -
									Math.abs(points[i].distance - points[i1].distance),
							) <
								Math.abs(
									Math.abs(points[j].distance - points[j1].distance) -
										Math.abs(points[i].distance - points[i1].distance),
								)
						) {
							j++;
						}

						const p = { ...points[i] };
						p.segment = points[j].segment;
						pNew.push(p);
					}

					for (let k = j2; k < points.length; k++) pNew.push(points[k]); // Keep everything which follows j range
				} else {
					for (let k = 0; k <= j2; k++) pNew.push(points[k]);

					let j = j2;
					for (let i = i2; i >= i1; i--) {
						if (
							j < j1 &&
							Math.abs(points[i].distance - ix(points, i - 1).distance) < 0.05
						) {
							j++;
						}

						while (
							j < j1 &&
							Math.abs(
								Math.abs(points[j + 1].distance - points[j1].distance) -
									Math.abs(points[i].distance - points[i1].distance),
							) <
								Math.abs(
									Math.abs(points[j].distance - points[j1].distance) -
										Math.abs(points[i].distance - points[i1].distance),
								)
						) {
							j++;
						}

						const p = { ...points[i] };
						p.segment = points[j].segment;
						pNew.push(p);
					}

					for (let k = j1; k < points.length; k++) pNew.push(points[k]);
				}

				points = pNew;
			}

			// Snap transition...
			// Adjust altitude...
			// The first pass goes from i1 to i2
			// The replaced portion goes from j3 to j4
			// For points beyond this range, transition the altitude
			// This presently does not work with loops
			if (snapTransition > 0) {
				const j3 = (sign > 0 ? j1 : j2) + 1;
				const j4 = j3 + i2 - i1 + 1;

				// d = 1: forward direction, -1: backward direction
				for (const d of [-1, 1]) {
					let s = 0;
					let i_trans = d > 0 ? i2 : i1;
					const sis = [0];
					const is = [i_trans];

					while (
						s < snapTransition &&
						i_trans > 0 &&
						i_trans < maxIndex(points)
					) {
						s += latlngDistance(points[i_trans], points[i_trans + d]);
						i_trans += d;
						sis.push(s);
						is.push(i_trans);
					}

					const jd = d * sign;
					let j_trans = jd > 0 ? j4 : j3;
					const sjs = [0];
					const js = [j_trans];

					s = 0;
					while (
						s < snapTransition &&
						j_trans > 0 &&
						j_trans < maxIndex(points)
					) {
						s += latlngDistance(points[j_trans], points[j_trans + jd]);
						j_trans += jd;
						sjs.push(s);
						js.push(j_trans);
					}

					// Step thru and adjust altitudes
					let u = 0;
					let v = 0;
					const zis = [points[is[0]].ele];
					const zjs = [points[js[0]].ele];

					while (u < sis.length - 1 && v < sjs.length - 1) {
						const _i = is[u];
						const _j = js[v];

						if (sis[u + 1] < sjs[v + 1]) {
							u++;
							// Interpolate the point onto the other interval
							const f = (sis[u] - sjs[v]) / (sjs[v + 1] - sjs[v]);
							const z0 =
								(1 - f) * points[js[v]].ele + f * points[js[v + 1]].ele;
							// Note: in limit of being close to the snapped section, altitude is average of two branches, then it diverges
							const g = (1 + Math.cos((PI * sis[u]) / snapTransition)) / 4; // From 0.5 to 0
							if (g < 0) die("Negative g!");
							const z1 = points[is[u]].ele;
							zis[u] = g * z0 + (1 - g) * z1;
						} else {
							v++;
							const f = (sjs[v] - sis[u]) / (sis[u + 1] - sis[u]);
							const z0 =
								(1 - f) * points[is[u]].ele + f * points[is[u + 1]].ele;
							const g = (1 + Math.cos((PI * sjs[v]) / snapTransition)) / 4; // From 0.5 to 0
							if (g < 0) die("Negative g!");
							// Note: in limit of being close to the snapped section, altitude is average of two branches, then it diverges
							const z1 = points[js[v]].ele;
							zjs[v] = g * z0 + (1 - g) * z1;
						}
					}

					// Assign the new elevations to the appropriate points
					for (let u_assign = 0; u_assign < zis.length; u_assign++) {
						points[is[u_assign]].ele = zis[u_assign];
					}
					for (let v_assign = 0; v_assign < zjs.length; v_assign++) {
						points[js[v_assign]].ele = zjs[v_assign];
					}
				}
			}
			// End of snap transition

			// Jump to next ivalue outside of range if we did replacement
			// This isn't perfect, but note points in j range are changed, so
			// j indices are no longer valid: this is why need to jump to outer loop
			if (i2 > i) {
				i = i2;
			}
			continue iLoop;
		}
	}

	if (snap === 2) {
		points.reverse();
	}

	return points;
}

/**
 * Check if a point can be pruned based on distance, cross product, and gradient
 * @param {Array} points - Array of 3 points [p1, p2, p3]
 * @param {number} distance - Maximum distance threshold (default 2)
 * @param {number} X - Maximum cross product threshold (default 0.001)
 * @param {number} dg - Maximum gradient change threshold (default 0.001)
 * @returns {boolean} True if point can be pruned
 */
function isPointPrunable(points, _distance = 2, X = 0.001, dg = 0.001) {
	const [p1, p2, p3] = points;
	if (!p3) {
		/* istanbul ignore next */
		die("isPointPrunable requires 3 points");
	}

	const [x1, y1] = latlng2dxdy(p3, p1);
	const [x2, y2] = latlng2dxdy(p3, p2);
	const [x3, y3] = [0, 0];
	const z1 = p1.ele;
	const z2 = p2.ele;
	const z3 = p3.ele;
	const s1 = p1.segment;
	const s2 = p2.segment;
	const s3 = p3.segment;

	// Only prune points in the same segment
	if (!(s1 === s2 && s2 === s3)) {
		return false;
	}

	if (isPointOnLine(p1, p2, p3, 1)) {
		const d13 = Math.sqrt((y3 - y1) ** 2 + (x3 - x1) ** 2);
		const d23 = Math.sqrt((y3 - y2) ** 2 + (x3 - x2) ** 2);

		// Duplicate points are not prunable
		if (d13 === 0 || d23 === 0) {
			return false;
		}

		// Check gradient and alignment
		const dgCheck = (z2 - z3) / d23 - (z3 - z1) / d13;
		const cross = crossProduct([x1, y1], [x3, y3], [x3, y3], [x2, y2]);
		return Math.abs(dgCheck) <= dg && Math.abs(cross) <= X;
	}
	return false;
}

/**
 * Simplify points using Ramer-Douglas-Peucker-like algorithm
 * Similar to prune, but with alternative recursive algorithm
 * @param {Object[]} points - Array of points to simplify
 * @param {number} z0 - Altitude deviation threshold in meters (default: 0.1)
 * @param {number} r0 - Distance deviation threshold in meters (default: 1)
 * @returns {Object[]} Simplified array of points
 */
function simplifyPoints(points, z0 = 0.1, r0 = 1) {
	if (points.length < 3) {
		return points;
	}

	// Search for segment boundaries
	for (let i = 0; i < points.length - 1; i++) {
		if (points[i].segment !== points[i + 1].segment) {
			const p1 = simplifyPoints(points.slice(0, i + 1), z0, r0);
			const p2 = simplifyPoints(points.slice(i + 1), z0, r0);
			return [...p1, ...p2];
		}
	}

	// Find the point of maximum deviation and recurse around that point
	// Find distance between points and 3D line connecting endpoints
	const [xf, yf] = latlng2dxdy(points[0], ix(points, -1));

	// If this point is too close to the first point, then find the furthest point and simplify on that
	if (xf * xf + yf * yf < 10) {
		let iFurthest;
		let dFurthest = 0;
		for (let i = 1; i < points.length - 1; i++) {
			const d = latlngDistance(points[0], points[i]);
			if (d > dFurthest) {
				iFurthest = i;
				dFurthest = d;
			}
		}
		if (iFurthest !== undefined) {
			const p1 = simplifyPoints(points.slice(0, iFurthest + 1), z0, r0);
			const p2 = simplifyPoints(points.slice(iFurthest + 1), z0, r0);
			return [...p1, ...p2];
		} else {
			return points;
		}
	}

	const zi = points[0].ele || 0;
	const dzf = (ix(points, -1).ele || 0) - zi;
	let iMax;
	let scoreMax = 1; // Only accept points if score is at least 1

	for (let i = 1; i < points.length - 1; i++) {
		const [x, y] = latlng2dxdy(points[0], points[i]);
		const dz = (points[i].ele || 0) - zi;
		// Find the nearest point on the curve
		const [f, d] = xyPointOnLine([0, 0], [xf, yf], [x, y]); // Distance of the interpolated point
		const ddz = dzf * f - dz; // Interpolated altitude difference
		const score = (d / r0) ** 2 + (ddz / z0) ** 2;
		if (score > scoreMax) {
			iMax = i;
			scoreMax = score;
		}
	}

	if (iMax !== undefined) {
		const p1 = simplifyPoints(points.slice(0, iMax + 1), z0, r0);
		const p2 = simplifyPoints(points.slice(iMax), z0, r0);
		return [...p1, ...p2.slice(1)]; // Remove duplicate point at junction
	} else {
		return [points[0], ix(points, -1)];
	}
}

/**
 * Bike speed model for realistic time calculations
 * @param {number} g - Gradient (rise/run)
 * @param {number} vMax - Maximum speed (m/s), default 17
 * @param {number} VAMMax - Maximum VAM (m/s), default 0.52
 * @param {number} v0 - Base speed (m/s), default 9.5
 * @returns {number} Speed in m/s
 */
function bikeSpeedModel(g = 0, vMax = 17, VAMMax = 0.53, v0 = 9.5) {
	// convert g to sine
	g /= Math.sqrt(1 + g ** 2);
	const a = vMax / VAMMax;
	const b = vMax / v0 - Math.log(2);
	const fV = (1 + (3 * g) ** 4) * (b + Math.log(1 + Math.exp(a * g)));
	return vMax / fV;
}

/**
 * Calculate distance difference between two points on course
 * @param {Object} p1 - First point with distance field
 * @param {Object} p2 - Second point with distance field
 * @param {number} courseDistance - Total course distance
 * @param {number} isLoop - Whether this is a loop course
 * @returns {number} Distance difference
 */
function distanceDifference(p1, p2, courseDistance, isLoop) {
	let d1;
	if (typeof p1 === "number") {
		d1 = p1;
	} else {
		if (p1.distance === undefined)
			die(
				`distanceDifference called w/o distance field: ${Object.keys(p1).join(", ")}`,
			);
		d1 = p1.distance;
	}
	let d2;
	if (typeof p2 === "number") {
		d2 = p2;
	} else {
		if (p2.distance === undefined)
			die(
				`distanceDifference called w/o distance field: ${Object.keys(p2).join(", ")}`,
			);
		d2 = p2.distance;
	}
	let d = d2 - d1;
	if (isLoop && courseDistance > 0) {
		d -= courseDistance * Math.floor(d / courseDistance);
	}
	return d;
}

/**
 * Calculate separation between two points in course distance
 * @param {Object} p1 - First point
 * @param {Object} p2 - Second point
 * @param {number} courseDistance - Total course distance
 * @param {number} isLoop - Whether this is a loop course
 * @returns {number} Absolute separation distance
 */
function pointSeparation(p1, p2, courseDistance, isLoop) {
	let d = distanceDifference(p1, p2, courseDistance, isLoop);
	if (isLoop) {
		d -= courseDistance * Math.floor(0.5 + d / courseDistance);
	}
	return Math.abs(d);
}

// TODO: Translate climbRating() from Perl

// TODO: Translate addAutoSegments() from Perl

// TODO: Translate findClimbs() from Perl

// TODO: Translate placeGradientSigns() from Perl

/**
 * Fit a circle through three points
 * @param {Array} p1 - [x, y] first point
 * @param {Array} p2 - [x, y] second point
 * @param {Array} p3 - [x, y] third point
 * @returns {Array} [center, radius] where center is [x, y] or [undefined, undefined] if linear
 */
function circle3PointFit(p1, p2, p3) {
	// Reference to first point
	const x21 = p2[0] - p1[0];
	const x31 = p3[0] - p1[0];
	const y21 = p2[1] - p1[1];
	const y31 = p3[1] - p1[1];

	// Distances from first point
	const rs21 = x21 ** 2 + y21 ** 2;
	const rs31 = x31 ** 2 + y31 ** 2;
	const denom = 2 * (y21 * x31 - y31 * x21);

	// Linear
	if (denom === 0) {
		return [undefined, undefined];
	}

	const f = (rs31 * x21 - rs21 * x31) / denom;
	const g = (rs21 * y31 - rs31 * y21) / denom;

	const r = Math.sqrt(f ** 2 + g ** 2);
	const x0 = p1[0] - g;
	const y0 = p1[1] - f;

	return [[x0, y0], r];
}

// TODO: Translate fitCircle() from Perl

// TODO: Translate processCircle() from Perl

/**
 * straighten points between indices
 * @param {Array} points - Array of points
 * @param {boolean} _isLoop - Whether route is a loop
 * @param {number} startIndex - Start index
 * @param {number} endIndex - End index
 */
function straightenPoints(points, _isLoop, startIndex, endIndex) {
	// Ensure distance field exists
	addDistanceFieldIfNeeded(points);

	// If we wrap around, then use a negative number for the start index
	if (startIndex > endIndex) {
		startIndex -= points.length;
	}

	const [rx, ry] = latlng2dxdy(
		points[startIndex],
		points[endIndex % points.length],
	);

	// If neither rx nor ry is nonzero, do nothing
	if (rx === 0 && ry === 0) {
		return;
	}

	const r2 = rx ** 2 + ry ** 2;

	// For each point, find the projection of the point on the segment
	for (let i = startIndex + 1; i <= endIndex - 1; i++) {
		const j = i % points.length;
		const [dx, dy] = latlng2dxdy(points[startIndex], points[j]);
		// Find the projection onto the line
		// projection: r dot rLine / r
		const f = (dx * rx + dy * ry) / r2;
		const pNew = addVectorToPoint(points[startIndex], [rx * f, ry * f]);
		points[j].lat = pNew.lat;
		points[j].lon = pNew.lon;
	}
}

// TODO: Translate processStraight() from Perl

/**
 * calculate deviation statistics for a range of points relative to connection of endpoints
 * @param {Array} points - Array of points
 * @param {number} startIndex - Start index
 * @param {number} endIndex - End index
 * @returns {Array} [avg, max, rms] deviation statistics
 */
function calcDeviationStats(points, startIndex, endIndex) {
	let max = 0;
	const p1 = points[startIndex % points.length];
	const p2 = points[endIndex % points.length];
	const c = Math.cos(((p1.lat + p2.lat) * DEG2RAD) / 2.0);
	const dx0 = (p2.lon - p1.lon) * LAT2Y * c;
	const dy0 = (p2.lat - p1.lat) * LAT2Y;
	const L = Math.sqrt(dx0 ** 2 + dy0 ** 2);

	if (Math.abs(L) < 0.001 || endIndex < startIndex + 1) {
		return [0, 0, 0];
	}

	const du0 = dx0 / L;
	const dv0 = dy0 / L;
	let sum = 0;
	let sum2 = 0;

	for (let i = startIndex + 1; i <= endIndex - 1; i++) {
		const dx = (points[i % points.length].lon - p1.lon) * LAT2Y * c;
		const dy = (points[i % points.length].lat - p1.lat) * LAT2Y;
		// deviation to the right
		const deviation = dx * dv0 - dy * du0;
		sum += deviation;
		sum2 += deviation ** 2;
		if (Math.abs(deviation) > max) {
			max = Math.abs(deviation);
		}
	}

	const avg = sum / (endIndex - startIndex - 1);
	const rms = Math.sqrt(sum2 / (endIndex - startIndex - 1));
	return [avg, max, rms];
}

/**
 * automatically find segments to be straightened
 * segments have a maximum deviation and also a check on
 * the correlation of the deviations
 * step through the route (perhaps with wrap-around for a loop)
 * with first index at each point, a second index at the minimum
 * length, keeping track of the maximum, rms, and average deviations
 * if the minimum length meets the criteria, then extend the length
 * until the criteria are broken, then jump to the endpoint
 * and continue (straight segments cannot overlap)
 * @param {Array} points - Array of points
 * @param {boolean} isLoop - Whether route is a loop
 * @param {number} minLength - Minimum length for straightening
 * @param {number} maxDeviation - Maximum deviation for straightening
 */
function autoStraighten(
	points,
	isLoop,
	minLength = 100,
	maxDeviation = 3,
) {
	const courseDistance =
		points[0].distance !== undefined
			? calcCourseDistance(points, isLoop)
			: (() => {
					addDistanceField(points);
					return calcCourseDistance(points, isLoop);
				})();

	function alignmentTest(points, i, j, maxDeviation) {
		const [avg, max, rms] = calcDeviationStats(points, i, j);
		return (
			max < maxDeviation &&
			Math.abs(avg) < maxDeviation / 4 &&
			rms < maxDeviation / 2
		);
	}

	let j = 1;
	let pointCount = 0;

	iLoop: for (let i = 0; i <= points.length - 1; i++) {
		// Keep point j ahead of i at min distance
		while (
			j < i + 2 ||
			points[j % points.length].distance +
				int(j / points.length) * courseDistance -
				points[i].distance <
				minLength
		) {
			j++;
			// If we cannot get a segment long enough on point-to-point, we're too close to the finish
			if (!(isLoop || j <= maxIndex(points))) {
				break iLoop;
			}
		}

		// Check if points meet the alignment test
		if (!alignmentTest(points, i, j, maxDeviation)) {
			continue;
		}

		// We've got a line: try to extend it
		while (true) {
			const k = j + 1;
			if (!isLoop && k > maxIndex(points)) {
				break;
			}
			if (!alignmentTest(points, i, k, maxDeviation)) {
				break;
			}
			j = k;
		}

		// See if we can improve the score by removing points from the ends
		// There's a tendency for the algorithm to extend the straight into turns, which affects
		// the direction of the straight, so try to back down on that
		let [_avg, _max, rms] = calcDeviationStats(points, i, j);
		let L = latlngDistance(
			points[i % points.length],
			points[j % points.length],
		);

		while (true) {
			let count = 0;
			let k = j - 1;
			if (k < i + 2) {
				break;
			}
			const L2 = latlngDistance(
				points[i % points.length],
				points[k % points.length],
			);
			if (L2 > minLength) {
				const [avg2, max2, rms2] = calcDeviationStats(points, i, k);
				if (rms2 * L < rms * L2) {
					j = k;
					L = L2;
					_avg = avg2;
					_max = max2;
					rms = rms2;
					count++;
				}
			}

			k = i + 1;
			if (k > j - 2) {
				break;
			}
			const L3 = latlngDistance(
				points[k % points.length],
				points[j % points.length],
			);
			if (L3 > minLength) {
				const [avg3, max3, rms3] = calcDeviationStats(points, k, j);
				if (rms3 * L < rms * L3) {
					i = k;
					L = L3;
					_avg = avg3;
					_max = max3;
					rms = rms3;
					count++;
				}
			}
			if (count === 0) {
				break;
			}
		}

		// We found a straight section! Now straighten it, and start over with the last straightened point
		// This deletes the distance field
		straightenPoints(points, isLoop, i, j);
		pointCount += j - i - 2;
		// Jump to end of straightened portion
		i = j;
	}

	// These fields are now invalid
	if (pointCount > 0) {
		note(`autoStraighten: total straightened points = ${pointCount}`);
		deleteField(points, "distance");
		if (points[0].curvature !== undefined) {
			deleteField(points, "curvature");
		}
		if (points[0].direction !== undefined) {
			deleteField(points, "direction");
		}
		if (points[0].heading !== undefined) {
			deleteField(points, "heading");
		}
	}
}

// TODO: Translate circuitFromPosition() from Perl

// TODO: Translate shiftCircuit() from Perl

// TODO: Translate simplifyProfile() from Perl

/**
 * add distance field to points
 * @param {Array} points - Array of points
 */
function addDistanceField(points) {
	if (!points.length) return;
	points[0].distance = 0;
	for (let i = 1; i < points.length; i++) {
		points[i].distance =
			points[i - 1].distance + latlngDistance(points[i - 1], points[i]);
	}
}

/**
 * Add distance field only if not already present
 * @param {Array} points - Array of points
 */
function addDistanceFieldIfNeeded(points) {
	if (points.length) {
		if (
			points[0].distance === undefined ||
			points[points.length - 1].distance === undefined
		) {
			addDistanceField(points);
		}
	}
}

/**
 * Add gradient field to points based on elevation changes
 * @param {Array} points - Array of points
 * @param {number} isLoop - Whether the track is a loop (0 or 1)
 */
function addGradientField(points, isLoop = 0) {
	if (!points.length) return;
	addDistanceField(points);
	const courseDistance = calcCourseDistance(points, isLoop);
	let i = 0;
	const iMax = maxIndex(points);
	while (i <= iMax) {
		const p1 = points[i];
		let j = (i + 1) % points.length;
		while (
			j !== i &&
			Math.abs(distanceDifference(p1, points[j], courseDistance, isLoop)) < 0.1
		) {
			j = (j + 1) % points.length;
		}
		if (j <= i && !isLoop) break;
		const p2 = points[j];
		p1.gradient =
			(p2.ele - p1.ele) / distanceDifference(p1, p2, courseDistance, isLoop);
		i++;
	}
	if (i > 0) {
		while (i <= iMax) {
			points[i].gradient = points[i - 1].gradient;
			i++;
		}
	}
}

/**
 * Integrate gradient to update altitude
 * @param {Array} points - Array of points
 * @param {number} isLoop - Whether the track is a loop (0 or 1)
 */
function integrateGradientField(points, isLoop = 0) {
	note("integrating gradient to update altitude...");
	if (!points.length || points[0].gradient === undefined) return;
	addDistanceFieldIfNeeded(points);
	const courseDistance = calcCourseDistance(points, isLoop);
	let i = 0;
	const iMax = maxIndex(points);
	points[0].ele = points[0].ele ?? 0; // default initial ele (this should never be necessary)
	const zLast = points[isLoop ? 0 : maxIndex(points)].ele; // remember last altitude
	while (i < iMax) {
		const p1 = points[i];
		const j = (i + 1) % points.length;
		if (j <= i && !isLoop) break;
		const p2 = points[j];
		p2.ele =
			p1.ele + p1.gradient * distanceDifference(p1, p2, courseDistance, isLoop);
		i++;
	}
	if (isLoop) {
		// adjust the entire course altitude to close the loop
		const zError = points[maxIndex(points)].ele - zLast;
		for (let k = 0; k < points.length; k++) {
			points[k].ele -= (zError * points[k].distance) / courseDistance;
		}
	}
}

/**
 * add direction field to points
 * @param {Array} points - Array of points to process
 * @param {number} isLoop - Whether the track is a loop (0 or 1)
 */
function addDirectionField(points, isLoop = 0) {
	if (!points.length) return;

	let u = isLoop ? points.length - 1 : 0;
	let v = 0;
	let w = 1;
	let dPrev;

	while (v < points.length) {
		u = v;
		w = v;

		// Find previous point that's not too close
		while (pointsAreClose(points[u], points[v])) {
			if (isLoop ? (u - 1 + points.length) % points.length !== w : u > 0) {
				u = (u - 1 + points.length) % points.length;
			} else {
				u = v;
				break;
			}
		}

		// Find next point that's not too close
		while (pointsAreClose(points[w], points[v])) {
			if (isLoop ? (w + 1) % points.length !== u : w < maxIndex(points)) {
				w = (w + 1) % points.length;
			} else {
				w = v;
				break;
			}
		}

		let d = dPrev ?? 0;
		if (u === v) {
			if (v !== w) {
				d = latlngDirection(points[v], points[w]);
			}
		} else {
			if (v === w) {
				d = latlngDirection(points[u], points[v]);
			} else {
				d = pointDirection(points[u], points[v], points[w]);
			}
		}

		if (dPrev !== undefined) {
			d = dPrev + reduceAngle(d - dPrev);
		}
		dPrev = d;
		points[v].direction = d;
		v++;
	}
}

/**
 * Add a heading field using the direction field
 * Heading is 0=North, 90=East, 180=South, 270=West
 * @param {Array} points - Array of points
 * @param {number} isLoop - Whether the track is a loop (0 or 1)
 */
function addHeadingField(points, isLoop = 0) {
	if (!points.length) return;
	if (points[0].direction === undefined) {
		addDirectionField(points, isLoop);
	}
	for (const p of points) {
		let heading = 90 - p.direction / DEG2RAD;
		heading -= 360 * Math.floor(heading / 360);
		p.heading = heading;
	}
}

/**
 * Add curvature field to points
 * @param {Array} points - Array of points
 * @param {number} isLoop - Whether the track is a loop (0 or 1)
 */
function addCurvatureField(points, isLoop = 0) {
	if (!points.length) return;
	let vMin = 0;
	let vMax = maxIndex(points);
	if (!isLoop) {
		points[vMin++].curvature = 0;
		points[vMax--].curvature = 0;
	}
	let v = vMin;
	let dirPrev;
	while (v <= vMax) {
		let u = (v - 1 + points.length) % points.length;
		let w = (v + 1) % points.length;
		while (pointsAreClose(points[u], points[v])) {
			if (isLoop ? (u - 1 + points.length) % points.length !== w : u > 0) {
				u = (u - 1 + points.length) % points.length;
			} else {
				u = v;
				break;
			}
		}
		while (pointsAreClose(points[w], points[v])) {
			if (isLoop ? (w + 1) % points.length !== u : w < maxIndex(points)) {
				w = (w + 1) % points.length;
			} else {
				w = v;
				break;
			}
		}
		if (u === v || u === w) {
			points[v].curvature = 0;
			v++;
			continue;
		}
		dirPrev = dirPrev ?? latlngDirection(points[u], points[v]);
		const dir = latlngDirection(points[v], points[w]);
		let d1 = latlngDistance(points[u], points[v]);
		let d2 = latlngDistance(points[v], points[w]);
		if (d1 > 10) d1 = 10;
		if (d2 > 10) d2 = 10;
		points[v].curvature =
			(2 * deltaAngle(dirPrev, dir)) / (d1 + d2);
		dirPrev = dir;
		v++;
	}
}

/**
 * calculate the net course distance
 * need to "wrap around" for lapped courses
 * @param {Array} points - Array of points
 * @param {number} isLoop - Whether the track is a loop (0 or 1)
 * @returns {number} Total distance in meters
 */
function calcCourseDistance(points, isLoop) {
	if (!points.length) return 0;
	addDistanceFieldIfNeeded(points);
	let distance = points[maxIndex(points)].distance;
	if (isLoop && points.length > 1) {
		distance += latlngDistance(points[maxIndex(points)], points[0]);
	}
	return distance;
}

/**
 * delete a field from the points
 * @param {Array} points - Array of points
 * @param {string} field - Field name to delete
 */
function deleteField(points, field) {
	if (!field) return;
	for (const p of points) {
		if (field in p) {
			delete p[field];
		}
	}
}

/**
 * delete an extension field
 * @param {Array} points - Array of points
 * @param {string} field - Extension field name to delete
 */
function deleteExtensionField(points, field) {
	if (!field) return;
	for (const p of points) {
		if (
			p.extensions &&
			typeof p.extensions === "object" &&
			field in p.extensions
		) {
			delete p.extensions[field];
		}
	}
}

/**
 * delete field and any extension
 * @param {Array} points - Array of points
 * @param {string} field - Field name to delete
 */
function deleteField2(points, field) {
	deleteField(points, field);
	deleteExtensionField(points, field);
}

/**
 * strip fields which are derived: needed if route has been changed by processing
 * @param {Array} points - Array of points
 * @param {Array} fields - Fields to delete (default: curvature, distance, gradient, heading)
 */
function deleteDerivedFields(
	points,
	fields = ["curvature", "distance", "gradient", "direction", "heading"],
) {
	for (const field of fields) {
		deleteField2(points, field);
	}
}

/**
 * reverse points and adjust distance, direction, curvature and laneshift fields, if present
 * @param {Array} points - Array of points to reverse
 */
function reversePoints(points) {
	points.reverse();
	if (!points.length) return;

	// Adjust distance field if it exists
	if (points[0].distance !== undefined) {
		const dMax = points[0].distance;
		for (const p of points) {
			p.distance = dMax - p.distance;
		}
	}

	// Negate direction, heading, curvature, and laneShift fields
	for (const field of ["direction", "heading", "curvature", "laneShift"]) {
		if (points[0][field] !== undefined) {
			for (const p of points) {
				p[field] = -p[field];
			}
		}
	}

	// Normalize heading to [0, 360)
	if (points[0].heading !== undefined) {
		for (const p of points) {
			p.heading -= 360 * Math.floor(p.heading / 360);
		}
	}
}

/**
 * crop points
 * @param {Array} points - Array of points to crop
 * @param {number} isLoop - Whether the track is a loop (0 or 1)
 * @param {Array} deleteRange - Array of distance ranges to delete
 * @param {number} cropMin - Minimum distance to keep
 * @param {number} cropMax - Maximum distance to keep
 * @returns {Array} New array of cropped points
 */
function cropPoints(points, isLoop = 0, deleteRange = [], cropMin, cropMax) {
	const ranges = [];

	const courseDistance = calcCourseDistance(points, isLoop);

	// reference negative numbers to end of course
	if (cropMin !== undefined) {
		cropMin -=
			courseDistance * Math.floor(cropMin / courseDistance);
	}
	if (cropMax !== undefined) {
		cropMax -=
			courseDistance * Math.floor(cropMax / courseDistance);
	}

	// If cropMin and cropMax are reversed, treat them as a delete range
	if (cropMin !== undefined && cropMax !== undefined && cropMax < cropMin) {
		ranges.push([cropMax, cropMin]);
		cropMin = undefined;
		cropMax = undefined;
	}

	// Process deleteRange pairs
	for (let i = 0; i < deleteRange.length; i += 2) {
		let r1 = deleteRange[i];
		let r2 = deleteRange[i + 1];

		// Points reversed: acts like cropMin, cropMax
		if (r1 === undefined || r2 === undefined || r2 < r1) {
			if (r1 !== undefined && (cropMax === undefined || r1 < cropMax)) {
				cropMax = r1;
			}
			if (r2 !== undefined && (cropMin === undefined || r2 > cropMin)) {
				cropMin = r2;
			}
		} else {
			// Check to see if range overlaps beginning or end of the course
			let s1 = points[0].distance;
			if (cropMin !== undefined && cropMin > s1) s1 = cropMin;
			let s2 = courseDistance;
			if (cropMax !== undefined && cropMax < s2) s2 = cropMax;

			// Skip if range outside of course
			if ((r1 < s1 && r2 < s1) || (r1 > s2 && r2 > s2)) continue;

			// Adjust crop limits if range overlaps edge of course
			let overlap = 0;
			if (r1 < s1) {
				cropMin = r2;
				overlap++;
			}
			if (r2 > s2) {
				cropMax = r1;
				overlap++;
			}
			if (overlap) continue;

			// Check if existing points overlap any ranges so far
			let doOverlaps = true;
			while (doOverlaps) {
				doOverlaps = false;
				for (let j = 0; j < ranges.length; j++) {
					const r = ranges[j];
					const r3 = r[0];
					const r4 = r[1];

					let rangeOverlap = 0;
					// New range straddles beginning of old range
					if (r1 < r3 && r2 > r3) {
						rangeOverlap++;
						if (r4 > r2) r2 = r4;
					} else if (r2 < r4 && r2 > r4) {
						// Extend existing range
						r1 = r3;
						rangeOverlap++;
					}

					// If overlap, delete the existing range and continue
					if (rangeOverlap) {
						ranges.splice(j, 1);
						doOverlaps = true;
						break;
					}
				}
			}
			ranges.push([r1, r2]);
		}
	}

	if (cropMin !== undefined || cropMax !== undefined) {
		note(
			"cropping ",
			cropMin !== undefined ? `from ${cropMin} ` : "",
			cropMax !== undefined ? `to ${cropMax} ` : "",
			"meters...",
		);
	}

	for (const r of ranges) {
		note(`deleting range from ${r[0]} meters to ${r[1]} meters.`);
	}

	// Interpolate needed points
	const interpolatePoints = [];
	if (cropMin !== undefined) interpolatePoints.push(cropMin);
	if (cropMax !== undefined) interpolatePoints.push(cropMax);
	for (const r of ranges) {
		if (r[0] !== undefined) interpolatePoints.push(r[0]);
		if (r[1] !== undefined) interpolatePoints.push(r[1]);
	}

	const pNew = [];
	let s;

	pointLoop: for (let i = 0; i <= maxIndex(points); i++) {
		const p = points[i];
		const sPrev = s;
		s = p.distance;

		// Add interpolated points if needed
		for (const s0 of interpolatePoints) {
			if (i > 0 && s0 > 0 && s > s0 && sPrev < s0) {
				const ds = s - sPrev;
				const f = (s0 - sPrev) / ds;
				const d1 = f * ds;
				const d2 = (1 - f) * ds;
				if (d1 > 0.01 && d2 > 0.01) {
					pNew.push(
						interpolatePoint(
							points[i - 1],
							p,
							f,
							courseDistance,
							isLoop,
						),
					);
				}
			}
		}

		// Skip points outside crop bounds
		if (cropMin !== undefined && s < cropMin) continue;
		if (cropMax !== undefined && s > cropMax) continue;

		// Skip points inside delete ranges
		for (const r of ranges) {
			if (s > r[0] && s < r[1]) continue pointLoop;
		}

		pNew.push(p);
	}

	deleteDerivedFields(pNew);
	return pNew;
}

/**
 * UTurnCheck
 * check whether p1->p2 and p3->p4 are in the opposite direction
 * @param {Object} p1 - First point of first segment
 * @param {Object} p2 - Second point of first segment
 * @param {Object} p3 - First point of second segment
 * @param {Object} p4 - Second point of second segment
 * @param {number} dotMax - Maximum dot product threshold (default -0.98)
 * @returns {boolean} True if segments form a U-turn
 */
function UTurnCheck(p1, p2, p3, p4, dotMax = -0.98) {
	const d = latlngDotProduct(p1, p2, p3, p4);
	return d !== null && d < dotMax;
}

/**
 * Create a loop for U-turns between two points
 * @param {Array} points - Array of two points [point1, point2]
 * @param {number} direction - Direction in radians
 * @param {number} radius - Radius of the loop in meters (default 4)
 * @param {number} defaultSign - Default sign for loop direction (default 1)
 * @param {Object} segmentNames - Object mapping segment numbers to names
 * @returns {Array} Array of loop points
 */
function makeLoop(
	points,
	direction,
	radius = 4,
	defaultSign = 1,
	segmentNames = {},
) {
	if (!points || points.length < 2) {
		/* istanbul ignore next */
		die("makeLoop requires a reference to a list of two points.");
	}
	if (direction === undefined) {
		/* istanbul ignore next */
		die("makeLoop requires a direction parameter");
	}

	let sign = defaultSign;

	// If radius is negative, swap the direction
	if (radius < 0) {
		radius = -radius;
		sign = -sign;
	}

	const cdir = Math.cos(direction);
	const sdir = Math.sin(direction);

	const [point1, point2] = points;

	// Loop points
	const pLoop = [];

	// Calculate distance of the two paths, where a left turn is positive,
	// a right turn is negative. This is twice the "laneShift", for example
	const [dx, dy] = latlng2dxdy(point1, point2);
	const ds = Math.sqrt(dx ** 2 + dy ** 2);
	let d = 0;
	if (ds > 0.01) {
		// The original route is along direction dir (c, s)
		// so I need the end point along the orthogonal direction (-s, c)
		// it's along the direction perpendicular, but proportional to dot product
		d = -sdir * dx + cdir * dy;
	}

	// Make loop from point to reverse direction with specified shift
	const lat0 = (point1.lat + point2.lat) / 2;
	const lng0 = (point1.lon + point2.lon) / 2;
	const delta = Math.abs(d / 2);
	if (delta > 0.1) {
		sign = Math.sign(d); // Override sign if the points are separate (L or R turn)
	}

	// Generate points... rotated coordinates
	const xs = [];
	const ys = [];
	const cosTheta = (radius + delta) / (2 * radius);

	// If cos theta > 1, then we'll generate a circle, but stretch it later
	let theta;
	let stretch;
	if (cosTheta > 1) {
		theta = 0;
		stretch = delta / radius;
	} else {
		theta = Math.atan2(Math.sqrt(1 - cosTheta ** 2), cosTheta);
		stretch = 1;
	}

	const dThetaMax = TWOPI / (16 * (1 + Math.sqrt(Math.abs(radius / 4))));

	// Arc going into the circle
	// First point (delta, 0)
	// Last point (-delta, 0)
	let nPoints = 1 + Math.floor(theta / dThetaMax);
	for (let i = 1; i <= nPoints; i++) {
		const t = (theta * i) / nPoints;
		const x = radius + delta - radius * Math.cos(t);
		const y = radius * Math.sin(t);
		xs.push(x);
		ys.push(y);
	}

	// Semi-circle
	const theta2 = theta + PI / 2;
	nPoints = 1 + Math.floor(stretch ** (2 / 3) * (theta2 / dThetaMax));
	for (let i = 1; i <= nPoints; i++) {
		const t = ((nPoints - i) * theta2) / nPoints;
		const x = radius * Math.sin(t);
		const y = 2 * radius * Math.sin(theta) + radius * Math.cos(t);
		xs.push(x);
		ys.push(y);
	}

	// Stretch points if separation exceeds target turn radius
	for (let i = 1; i < xs.length; i++) {
		xs[i] *= stretch;
	}

	// Swap x points if we're "driving on the left"
	if (sign < 0) {
		for (let i = 0; i < xs.length; i++) {
			xs[i] = -xs[i];
		}
	}

	// Finish route
	for (let i = xs.length - 2; i >= 0; i--) {
		xs.push(-xs[i]);
		ys.push(ys[i]);
	}

	// Shear to align
	// point1 => point2 : dx, dy
	// point1 => origin:: -s, +c
	const u =
		delta === 0 ? 0 : (dx / (2 * delta)) ** 2 + (dy / (2 * delta)) ** 2 - 1;
	const shear = delta === 0 ? 0 : u > 0 ? Math.sqrt(u) : 0;
	const shearSign = -sign * Math.sign(cdir * dx + sdir * dy);

	// Transform to direction, adding shear transformation first
	// Original road is aligned in direction dir
	// This is aligned in direction 90 degrees
	// Need to rotate by dir - 90 deg
	// Also calculate distance
	for (let i = 0; i < xs.length; i++) {
		ys[i] += shear * shearSign * xs[i];
		const x = sdir * xs[i] + cdir * ys[i];
		const y = -cdir * xs[i] + sdir * ys[i];
		xs[i] = x;
		ys[i] = y;
	}

	// Convert to lat, lng
	const c = Math.cos(DEG2RAD * lat0);
	for (let i = 0; i < xs.length; i++) {
		const h = { ...point1 };
		h.lon = lng0 + xs[i] / (LAT2Y * c);
		h.lat = lat0 + ys[i] / LAT2Y;
		pLoop.push(h);
	}

	// May need to set segment
	if (point1.segment !== point2.segment) {
		if (segmentNames[point1.segment]) {
			const s = segmentNames[point2.segment] ? 0 : point2.segment;
			const p = { ...point1 };
			pLoop.unshift(p);

			for (const pt of pLoop) {
				pt.segment = s;
			}
		}

		if (pLoop[pLoop.length - 1].segment !== point2.segment) {
			const p = { ...point2 };
			p.segment = pLoop[pLoop.length - 1].segment;
			pLoop.push(p);
		}
	}

	// Create a distance field
	const ss = [latlngDistance(point1, pLoop[0])];
	for (let i = 0; i < pLoop.length - 1; i++) {
		ss.push(ss[ss.length - 1] + latlngDistance(pLoop[i], pLoop[i + 1]));
	}
	const sLoop =
		ss[ss.length - 1] + latlngDistance(pLoop[pLoop.length - 1], point2);

	// Interpolate elevation
	for (let i = 0; i < pLoop.length; i++) {
		pLoop[i].ele = (point1.ele * (sLoop - ss[i]) + point2.ele * ss[i]) / sLoop;
	}

	return pLoop;
}

// TODO: Translate splitPoints() from Perl

/**
 * Calculate smoothing sigma based on gradient variance
 * @param {Array} points - Array of points
 * @param {number} sigmaFactor - Factor to scale the sigma values (default: 1)
 * @param {number} isLoop - Whether the track is a loop (0 or 1)
 */
function calcSmoothingSigma(points, sigmaFactor = 1, isLoop = 0) {
	if (!points.length) return;

	// specify the window over which gradient variance is calculated
	const sigmaAvg = 200;
	const twoSigmaAvg2 = 2 * sigmaAvg ** 2;
	const avgRange = 3 * sigmaAvg;

	// calculate a gradient field (also adds distance)
	note("calculating gradient field...");
	addGradientField(points, isLoop);
	const courseDistance = calcCourseDistance(points, isLoop);

	let i1 = 1; // starting point for gradient variance: note we don't calculate for i=0 unless it's a loop
	let i2 = 0; // ending point for gradient variance (can exceed number of points)

	if (isLoop) {
		while (
			i1 > -points.length &&
			distanceDifference(points[i1], points[0], courseDistance, isLoop) <
				avgRange
		) {
			i1--;
		}
	}

	for (let i = 0; i <= maxIndex(points); i++) {
		// move i1 to just outside averaging range
		while (
			i1 < i &&
			distanceDifference(points[i1 + 1], points[i], courseDistance, isLoop) >
				avgRange
		) {
			i1++;
		}
		// move i2 to just outside averaging range
		while (
			(isLoop ? i2 < i + points.length : i2 < maxIndex(points)) &&
			distanceDifference(
				points[i],
				points[i2 % points.length],
				courseDistance,
				isLoop,
			) < avgRange
		) {
			i2++;
		}
		let sum0 = 0;
		let sum1 = 0;
		for (let j = i1; j <= i2; j++) {
			// gradient for each point is the forward gradient
			// so compare gradient of the previous point to gradient of this point
			const w = Math.exp(
				-(
					distanceDifference(
						points[i],
						points[j % points.length],
						courseDistance,
						isLoop,
					) ** 2
				) / twoSigmaAvg2,
			);
			sum0 += w;
			// note for point to point, the last gradient is invalid, and there's no difference for the first point
			const g1 = points[j % points.length].gradient;
			const g2 = points[(j - 1 + points.length) % points.length].gradient;
			sum1 += (w * (g1 - g2) ** 2) / Math.sqrt(1e-4 + g1 ** 2 + g2 ** 2); // this weights steep grade fluctuations more, but not too much more
		}
		if (sum0 > 0) {
			const gVar = sum1 / sum0; // variance of gradient differences
			const d = sum0 / (sigmaAvg * SQRT2PI); // density of points
			const sigma = (sigmaFactor * Math.sqrt(gVar) * 50) / d;
			points[i].sigma = sigma;
		} else {
			points[i].sigma = 0;
		}
	}
}

// TODO: Translate simplifyMonotonicProfile() from Perl

/**
 * calculate a quality metric for the route
 * @param {Array} points - Array of points to analyze
 * @param {number} isLoop - Whether the track is a loop (0 or 1)
 * @returns {Array} [totalScore, directionScore, altitudeScore]
 */
function calcQualityScore(points, isLoop) {
	const sines = [];
	const ddirs = [];
	note("calculating altitude quality score..");
	let courseDistance = 0;
	let s2sum = 0;

	for (let i = 0; i <= maxIndex(points); i++) {
		if (!isLoop && i === maxIndex(points)) break;

		// Distance and altitude change to next point
		const j = (i + 1) % points.length;
		const ds = latlngDistance(points[i], points[j]);
		if (ds < 0.01) continue;
		courseDistance += ds;

		const dz = points[j].ele - points[i].ele;
		if (Math.abs(ds) < 0.1 && Math.abs(dz) < 0.01) continue; // Skip duplicate points

		// Sine of inclination angle to next point
		const s = dz / Math.sqrt(dz ** 2 + ds ** 2);
		sines.push(s);
		s2sum += ds * (s ** 2 + 1e-4);

		ddirs.push(
			!isLoop && i === 0
				? 0
				: latlngAngle(
						points[(i - 1 + points.length) % points.length],
						points[i],
						points[(i + 1) % points.length],
					),
		);

		if (
			!(ddirs[ddirs.length - 1] !== null && sines[sines.length - 1] !== null)
		) {
			sines.pop();
			ddirs.pop();
		}
	}

	let sum2 = 0;
	for (let i = 0; i < sines.length; i++) {
		if (!isLoop && i === maxIndex(sines)) break;
		// These are sine grades, not tangents, to avoid zero denominators
		const s1 = sines[i];
		const s2 = sines[(i + 1) % sines.length];
		sum2 += (s2 - s1) ** 2;
	}

	const scoreZ = courseDistance === 0 ? 0 : (10 * sum2) / s2sum;

	sum2 = 0;
	for (let i = 0; i < ddirs.length; i++) {
		sum2 += ddirs[i] ** 2;
	}
	const scoreD = courseDistance === 0 ? 0 : (100 * sum2) / courseDistance;

	const score = scoreZ + scoreD;

	return [score, scoreD, scoreZ];
}

// TODO: Translate addPointExtensions() from Perl

// TODO: Translate flattenPointExtensions() from Perl

// TODO: Translate getExtensions() from Perl

// TODO: Translate addExtensions() from Perl

// ============================================================================
// MAIN EXPORT FUNCTION
// ============================================================================

export function processGPX(trackFeature, options = {}) {
	// Validate input
	if (
		!trackFeature ||
		!trackFeature.geometry ||
		trackFeature.geometry.type !== "LineString"
	) {
		/* istanbul ignore next */
		die("Invalid track feature provided to processGPX");
	}

	// Normalize option aliases
	if (options.simplify !== undefined && options.simplifyPoints === undefined) {
		options.simplifyPoints = options.simplify;
	}

	// Make sure repeat is in range
	if ((options.repeat || 0) > 99) {
		/* istanbul ignore next */
		die("-repeat limited to range 0 to 99");
	}

	// Mutual exclusion of loopLeft and loopRight is enforced by Yargs validation

	// Short-cut for out-and-back
	if (options.outAndBack || options.outAndBackLap) {
		if (options.outAndBackLap) {
			options.rLap = options.rLap ?? 8;
		} else {
			options.rLap = options.rLap ?? 0;
		}
		options.autoSpacing = options.autoSpacing ?? 1;
		options.lSmooth = options.lSmooth ?? 5;
		options.laneShift =
			options.laneShift ?? (options.selectiveLaneShift?.length ? 0 : 6);
		options.minRadius = options.minRadius ?? 6;
		options.prune = options.prune ?? 1;
		options.rTurnaround = options.rTurnaround ?? 8;
		options.rUTurn = options.rUTurn ?? 8;
		options.spacing = options.spacing ?? 10;
		options.splineDegs = options.splineDegs ?? 0;
	}

	// Loop sign
	const loopSign = options.loopLeft
		? -1
		: options.loopRight
			? 1
			: options.laneShift !== undefined && options.laneShift < 0
				? -1
				: 1;

	// Segment variables (simplified for JavaScript - we don't implement full segment support)
	const nSegment = 0;
	const segmentDefined = {};
	const segmentNames = {}; // names of each segment

	// Auto-straighten
	options.autoStraightenDeviation =
		options.autoStraightenDeviation ?? options.autoStraighten?.[0] ?? 0;
	options.autoStraightenLength =
		options.autoStraightenLength ?? options.autoStraighten?.[1] ?? 100;

	// Convert max slope to percent
	if (options.maxSlope !== undefined && options.maxSlope < 1) {
		options.maxSlope *= 100;
	}

	// If extendBack is specified, we need a turnaround loop... calculate crop later
	options.extendBack = options.extendBack ?? 0;
	options.rTurnaround = options.rTurnaround ?? 0;
	if (options.extendBack > 0 && options.rTurnaround <= 0) {
		options.rTurnaround = 5;
	}

	if (
		options.cropMin !== undefined &&
		options.cropMax !== undefined &&
		options.cropMax > 0 &&
		options.cropMin > options.cropMax
	) {
		die("Crop window minimum exceeds crop window maximum");
	}

	// Apply extend
	options.prepend = (options.prepend || 0) + (options.extend || 0);
	options.append = (options.append || 0) + (options.extend || 0);

	// Convert coordinates to points format expected by processing functions
	let points = trackFeature.geometry.coordinates.map((coord) => ({
		lat: coord[1],
		lon: coord[0],
		ele: coord[2], // Preserve undefined if no elevation data
		segment: 1,
	}));

	// Calculate quality score of original course
	note("points in original GPX track = ", points.length);
	const [score, scoreD, scoreZ] = calcQualityScore(points, options.isLoop || 0);
	note("quality score of original course = ", score.toFixed(4));
	note("direction score of original course = ", scoreD.toFixed(4));
	note("altitude score of original course = ", scoreZ.toFixed(4));
	dumpPoints(points, "01-js-original.txt");

	// Eliminate duplicate x,y points
	points = removeDuplicatePoints(points, options.isLoop || 0);
	dumpPoints(points, "02-js-duplicates-removed.txt");

	// If repeat is specified, then create replicates
	if ((options.repeat || 0) > 0) {
		deleteField2(points, "distance");
		const pNew = [...points];
		for (let i = 1; i <= options.repeat; i++) {
			for (const p of points) {
				pNew.push({ ...p });
			}
		}
		points = pNew;
		dumpPoints(points, "03-js-repeated.txt");
	}

	// Skip 'join' functionality and convert unnamed segments to 0

	// Crop ranges if specified
	// This is done before auto-options since it may change whether the course is a loop
	points = cropPoints(
		points,
		options.isLoop || 0,
		options.deleteRange || [],
		options.cropMin,
		options.cropMax,
	);
	dumpPoints(points, "05-js-cropped.txt");

	// AutoLoop: automatically determine if -loop should be invoked
	options.copyPoint = options.copyPoint || 0;
	options.autoLoop = options.autoLoop || options.auto;

	if (options.autoLoop && options.isLoop === undefined) {
		if (
			options.cropMin !== undefined ||
			options.cropMax !== undefined
		) {
			options.isLoop = 0;
		} else {
			options.isLoop = checkAutoLoop(points) ? 1 : 0;
		}
	}

	options.isLoop = options.isLoop ?? 0;

	// Auto: auto option will turn on options based on the course
	if (options.auto) {
		note("auto-setting options...");

		const courseDistance = calcCourseDistance(points, options.isLoop);

		// Calculate position interpolation
		if (options.spacing === undefined) {
			options.spacing = 3 * (1 + courseDistance / 250) ** (1 / 4);
			note(
				`setting spacing to ${options.spacing.toFixed(3)} meters (distance = ${(courseDistance / 1000).toFixed(3)} km)`,
			);
		}

		// Smoothing
		if (options.lSmooth === undefined) {
			options.lSmooth = 5;
			note(`setting smoothing to ${options.lSmooth} meters`);
		}

		// Other options
		if (options.autoSpacing === undefined) {
			note("setting -autoSpacing...");
			options.autoSpacing = 1;
		}

		if (options.smoothAngle === undefined) {
			options.smoothAngle = 10;
			note(`setting -smoothAngle ${options.smoothAngle} ...`);
		}

		if (options.minRadius === undefined) {
			options.minRadius = 6;
			note(`setting minimum corner radius to ${options.minRadius} ...`);
		}

		if (options.prune === undefined) {
			note("setting -prune ...");
			options.prune = 1;
		}

		if (options.zSmooth === undefined) {
			options.zSmooth = 15;
			note(`setting altitude smoothing to ${options.zSmooth} meters`);
		}

		if (options.fixCrossings === undefined) {
			note("setting -fixCrossings ...");
			options.fixCrossings = 1;
		}

		if (options.rUTurn === undefined) {
			options.rUTurn = 6;
			note(`setting -RUTurn ${options.rUTurn} (meters) ...`);
		}

		if (options.snap === undefined) {
			options.snap = 1;
			note("setting -snap 1 ...");
		}

		if (options.snapTransition === undefined) {
			options.snapTransition = 10;
			note(`setting -snapTransition ${options.snapTransition} meters...`);
		}

		if (options.cornerCrop === undefined) {
			options.cornerCrop = 6;
			note(`setting -cornerCrop ${options.cornerCrop} meters...`);
		}

		if (options.fitArcs === undefined) {
			note("setting -fitArcs ...");
			options.fitArcs = 1;
		}

		if (options.splineInterpolation === undefined) {
			note("setting -splineInterpolation ...");
			options.splineInterpolation = 1;
		}
	}

	// Set default values for options that are still undefined
	options.fixCrossings = options.fixCrossings ?? 0;
	options.laneShift = options.laneShift ?? 0;
	options.minRadius = options.minRadius ?? 0;
	options.prune = options.prune ?? 0;
	options.rLap = options.rLap ?? 0;
	options.spacing = options.spacing ?? 0;
	options.zSmooth = options.zSmooth ?? 0;
	options.snap = options.snap ?? 0;
	options.snapTransition = options.snapTransition ?? 0;
	options.lSmooth = options.lSmooth ?? 0;

	// Check for invalid option combinations
	if (options.snap > 0 && options.snapDistance > options.lSmooth) {
		warn(
			`WARNING: if snapping distance (${options.snapDistance}) is more than smoothing distance (${options.lSmooth}), then abrupt transitions between snapped and unsnapped points may occur`,
		);
	}

	if (options.isLoop && (options.rTurnaround || 0) > 0) {
		warn("WARNING: ignoring -lap or -loop option when rTurnaround > 0");
		options.isLoop = 0;
	}

	// AutoSpacing triggered if max angle specified
	if (options.smoothAngle !== undefined && options.smoothAngle <= 0) {
		options.smoothAngle = 10;
		options.autoSpacing = options.autoSpacing ?? 1;
	}
	if (options.autoSpacing) {
		options.smoothAngle = options.smoothAngle ?? 15;
	}

	// Convert angle options to radians
	options.splineInterpolation =
		options.splineInterpolation ??
		(options.splineStart !== undefined || options.splineEnd !== undefined
			? 1
			: 0);
	options.splineDegs =
		options.splineDegs ?? (options.splineInterpolation ? 5 : 0);
	const _splineRadians = options.splineDegs * DEG2RAD;
	const _splineMaxRadians = options.splineMaxDegs * DEG2RAD;

	options.arcFitDegs = options.arcFitDegs ?? 0;
	const arcFitRadians = options.arcFitDegs * DEG2RAD;
	const arcFitMaxRadians = options.arcFitMaxDegs * DEG2RAD;

	const fitArcsRadians = options.fitArcsDegs
		? options.fitArcsDegs * DEG2RAD
		: undefined;
	options.fitArcs =
		options.fitArcs ??
		(options.fitArcsStart !== undefined || options.fitArcsEnd !== undefined
			? 1
			: 0);

	// Check if loop specified for apparent point-to-point
	if (options.isLoop) {
		const d = latlngDistance(points[0], points[maxIndex(points)]);
		if (d > 150) {
			warn(
				`WARNING: -loop or -lap specified, with large (${d} meter) distance between first and last point: are you sure you wanted -loop or -lap?`,
			);
		}
	}

	// shiftSF dependency on lap/loop option is enforced by Yargs validation

	// Look for zig-zags
	points = fixZigZags(points, options.isLoop);
	dumpPoints(points, "06-js-zigzags-fixed.txt");

	// Look for loops
	findLoops(points, options.isLoop);

	// Adjust positions if requested
	if (
		(options.xShift !== undefined && options.xShift !== 0) ||
		(options.yShift !== undefined && options.yShift !== 0)
	) {
		const xShift = options.xShift || 0;
		const yShift = options.yShift || 0;
		const dLat = yShift / LAT2Y;
		note(
			`shifting points by distance ${xShift}, ${yShift}: will cause distortion near poles.`,
		);

		for (const p of points) {
			p.lat += dLat;
			const c = Math.cos(DEG2RAD * p.lat);
			if (c > 0) {
				p.lon += xShift / (c * LAT2Y);
			}
		}
	}

	// Adjust altitudes if requested
	if (
		(options.zShift !== undefined && options.zShift !== 0) ||
		(options.zScale !== undefined && options.zScale !== 1)
	) {
		// Transition set to change gradient by up to 5%
		note(
			`applying z shift = ${options.zShift || 0}, and z scale = ${options.zScale || 1}`,
		);
		if (options.zShiftStart !== undefined) {
			note(`zShift start = ${options.zShiftStart}`);
		}
		if (options.zShiftEnd !== undefined) {
			note(`zShift end = ${options.zShiftEnd}`);
		}

		const zShift = options.zShift || 0;
		const zScale = options.zScale || 1;
		const zOffset = options.zOffset || 0;
		const zScaleRef = options.zScaleRef || 0;
		const zShiftDistance = 20 * (1 + Math.abs(zShift));

		for (const p of points) {
			const s = p.distance;
			let dz =
				(p.ele + zOffset - zScaleRef) * zScale + zShift + zScaleRef - p.ele;

			if (
				options.zShiftStart !== undefined &&
				options.zShiftEnd !== undefined &&
				options.zShiftEnd < options.zShiftStart
			) {
				dz *=
					transition((options.zShiftStart - s) / zShiftDistance) *
					transition((s - options.zShiftEnd) / zShiftDistance);
			} else {
				if (options.zShiftStart !== undefined) {
					dz *= transition((options.zShiftStart - s) / zShiftDistance);
				}
				if (options.zShiftEnd !== undefined) {
					dz *= transition((s - options.zShiftEnd) / zShiftDistance);
				}
			}
			p.ele += dz;
		}
		dumpPoints(points, "07-js-altitude-adjusted.txt");
	}

	// Reverse the points of the original course
	// Points reference segments so segments order is also reversed
	if (options.reverse) {
		note("reversing course direction..");
		reversePoints(points);
		dumpPoints(points, "08-js-reversed.txt");
	}

	// Corner cropping
	options.cornerCrop = options.cornerCrop ?? 0;
	options.minCornerCropDegs = options.minCornerCropDegs ?? 75;
	if (options.maxCornerCropDegs === undefined) {
		if (options.minCornerCropDegs < 90) {
			options.maxCornerCropDegs = 135;
		} else {
			options.maxCornerCropDegs = options.minCornerCropDegs + 45;
		}
	}

	if (options.cornerCrop > 0) {
		points = cropCorners(
			points,
			options.cornerCrop,
			options.minCornerCropDegs * DEG2RAD,
			options.maxCornerCropDegs * DEG2RAD,
			options.cornerCropStart,
			options.cornerCropEnd,
			options.isLoop,
		);
		dumpPoints(points, "09-js-corners-cropped.txt");
	}

	// Auto-straighten
	if ((options.autoStraightenDeviation || 0) > 0) {
		note("auto-Straightening...");
		autoStraighten(
			points,
			options.isLoop,
			options.autoStraightenLength || 100,
			options.autoStraightenDeviation,
		);
		dumpPoints(points, "10-js-auto-straightened.txt");
	}

	// Check for snapping
	if ((options.snap || 0) > 0 && (options.snapDistance || 0) >= 0) {
		note("snapping repeated points (pass 1)...");
		points = snapPoints(
			points,
			options.snap,
			options.snapDistance || 2,
			options.snapAltitude || 1,
			options.snapTransition || 0,
			options.spacing || 0,
		);
		dumpPoints(points, "14-js-snapped-pass-1.txt");
	}

	// fitArcs in corners (this is different than "arcFit")
	if (options.fitArcs) {
		note("fitting arcs in corners...");
		points = findAndFitArcs(
			points,
			options.isLoop || 0,
			fitArcsRadians,
			options.fitArcsDMax,
			options.fitArcsUniformGradient,
			options.fitArcsStart,
			options.fitArcsEnd,
		);
		dumpPoints(points, "14b-js-fit-arcs.txt");
	}

	// spline of corners
	if (_splineRadians > 0) {
		note("corner splines, pre-smoothing...");
		points = addSplines(
			points,
			_splineRadians,
			_splineMaxRadians,
			options.splineStart,
			options.splineEnd,
			options.isLoop || 0,
			"spline",
		);
		dumpPoints(points, "15-js-corner-splines.txt");
	}

	// arc fit of corners
	if (arcFitRadians > 0) {
		note("corner arcFits, pre-smoothing...");
		points = addSplines(
			points,
			arcFitRadians,
			arcFitMaxRadians,
			options.arcFitStart,
			options.arcFitEnd,
			options.isLoop || 0,
			"arcFit",
		);
		dumpPoints(points, "16-js-arc-fit.txt");
	}

	// add distance field
	addDistanceField(points);
	const _courseDistance = calcCourseDistance(points, options.isLoop || 0);

	// automatic interpolation at corners
	if (
		options.autoSpacing &&
		((options.lSmooth || 0) > 0 || (options.minRadius || 0) > 0)
	) {
		note("auto-spacing at corners...");
		points = doAutoSpacing(
			points,
			options.isLoop || 0,
			options.lSmooth || 0,
			options.smoothAngle || 0,
			options.minRadius || 0,
		);
		dumpPoints(points, "17-js-auto-spaced.txt");
	}

	// interpolation if requested
	if (points.length && (options.spacing || 0) > 0) {
		// STAGE 18: Interpolation
		points = doPointInterpolation(points, options.isLoop || 0, options.spacing);
		dumpPoints(points, "18-js-interpolated.txt");
	}

	// Check for snapping (pass 2)
	// This is done after point interpolation as well as before
	// since widely spaced points may not show a match
	if ((options.snap || 0) > 0 && (options.snapDistance || 0) >= 0) {
		// STAGE 21: Snap points (pass 2)
		note("snapping repeated points (pass 2)...");
		points = snapPoints(
			points,
			options.snap,
			options.snapDistance || 2,
			options.snapAltitude || 1,
			options.snapTransition || 0,
			options.spacing || 0,
		);
		dumpPoints(points, "21-js-snapped-pass-2.txt");
	}

	// STAGE 22: Various smoothing passes
	// 1: position
	// 2: altitude
	// 3: position auto-smoothing (not yet implemented)
	// 4: altitude auto-smoothing
	//
	// smoothing parameter with auto-smoothing is normalized,
	// so tuned for smoothing = 1 being reasonable choice
	//
	// this is an update on prior smoothing code
	// this code creates a smooth field if either selective smoothing, or a start/finish
	// to smoothing is chosen. Only if uniform smoothing is being applied is a single
	// sigma value sent to the smoothing code

	if (
		(options.lSmooth || 0) > 0 ||
		(options.zSmooth || 0) > 0 ||
		(options.lAutoSmooth || 0) > 0 ||
		(options.zAutoSmooth || 0) > 0 ||
		(options.selectiveSmooth || []).length > 0 ||
		(options.selectiveSmoothZ || []).length > 0 ||
		(options.selectiveSmoothG || []).length > 0
	) {
		addDistanceField(points);
	}

	// keep track of the first and last points, if anchoring is happening
	const endPoints = [{ ...points[0] }, { ...points[maxIndex(points)] }];

	let smoothed = 0;
	for (const smoothLoop of [0, 1, 2, 4]) {
		smoothed = 1;
		let smooth = 0;
		if (smoothLoop === 0) smooth = options.lSmooth || 0;
		if (smoothLoop === 1) smooth = options.zSmooth || 0;
		if (smoothLoop === 2) smooth = options.gSmooth || 0;
		if (smoothLoop === 3) smooth = options.lAutoSmooth || 0;
		if (smoothLoop === 4) smooth = options.zAutoSmooth || 0;
		if (smoothLoop === 5) smooth = options.gAutoSmooth || 0;

		// selective smoothing
		const sSmooth =
			smoothLoop === 0
				? options.selectiveSmooth || []
				: smoothLoop === 1
					? options.selectiveSmoothZ || []
					: smoothLoop === 2
						? options.selectiveSmoothG || []
						: [];

		if (!(smooth > 0 || sSmooth.length > 0)) {
			continue;
		}

		let sigma0 = 0;
		if (smoothLoop === 3) {
			// smooth field is generated from data
			note("calculating auto sigma");
			calcSmoothingSigma(points, smooth, options.isLoop);
			sigma0 = 0;
		} else {
			// parse and check the selective smoothing parameters
			let i = 0;
			let sPrev;
			const smoothSigmas = [];
			const smoothPositions = [];
			let positiveSigmaFound = smooth > 0;
			while (i < sSmooth.length) {
				const sigma = sSmooth[i]; // value
				if (sigma < 0) {
					/* istanbul ignore next */
					die(
						`negative sigma value found in selective smoothing list: ${sSmooth}`,
					);
				}
				positiveSigmaFound = positiveSigmaFound || sigma > 0;
				smoothSigmas.push(sigma);
				i++;
				if (i >= sSmooth.length) break;
				const s = sSmooth[i]; // position
				if (sPrev !== undefined && s < sPrev) {
					/* istanbul ignore next */
					die(
						"position values in selective smoothing list must be in non-decreasing order",
					);
				}
				smoothPositions.push(s);
				sPrev = s;
				i++;
			}

			if (positiveSigmaFound) {
				note(
					"smoothing...",
					smoothLoop === 0
						? "position"
						: smoothLoop === 1
							? "altitude"
							: smoothLoop === 2
								? "gradient"
								: smoothLoop === 3
									? "position(auto)"
									: smoothLoop === 4
										? "altitude(auto)"
										: smoothLoop === 5
											? "gradient(auto)"
											: "other",
				);

				sigma0 = smooth; // constant component of smoothing

				// convert constant smoothing to a smoothing field if there's a smoothStart and/or smoothEnd
				if (
					options.smoothStart !== undefined ||
					options.smoothEnd !== undefined
				) {
					positiveSigmaFound = false;
					const lambda = 10 + 4 * sigma0;
					for (let i = 0; i < points.length; i++) {
						const s = points[i].distance;
						let sigma;
						if (
							options.smoothStart !== undefined &&
							options.smoothEnd !== undefined &&
							options.smoothEnd < options.smoothStart
						) {
							sigma =
								sigma0 *
								(transition((options.smoothStart - s) / lambda) *
									transition((s - options.smoothEnd) / lambda));
						} else {
							sigma = sigma0;
							if (options.smoothStart !== undefined) {
								sigma *= transition((options.smoothStart - s) / lambda);
							}
							if (options.smoothEnd !== undefined) {
								sigma *= transition((s - options.smoothEnd) / lambda);
							}
						}
						points[i].sigma = sigma < 0.01 ? 0 : sigma; // ignore small values of sigma
						positiveSigmaFound = positiveSigmaFound || points[i].sigma > 0;
					}
					sigma0 = 0;
					if (!positiveSigmaFound) {
						deleteField2(points, "sigma");
					}
				}

				if (smoothSigmas.length > 0) {
					if (smoothPositions.length > 0) {
						// construct sigma field from selective smoothing
						if (points[0].distance === undefined) {
							addDistanceField(points);
						}
						positiveSigmaFound = false;
						const sigmas = [];
						for (let i = 0; i < smoothSigmas.length; i++) {
							const sigma = smoothSigmas[i];
							const start = i > 0 ? smoothPositions[i - 1] : undefined;
							const end =
								i < smoothPositions.length ? smoothPositions[i] : undefined;
							let lambda1 = 10;
							let lambda2 = 10;
							if (i > 0) {
								lambda1 += 4 * Math.abs(sigma - smoothSigmas[i - 1]);
							}
							if (i < smoothSigmas.length - 1) {
								lambda2 += 4 * Math.abs(sigma - smoothSigmas[i + 1]);
							}

							for (let j = 0; j < points.length; j++) {
								const s = points[j].distance;
								if (s === undefined) {
									die(`undefined distance found for point ${j}`);
								}
								let sigmaEff;
								if (start !== undefined && end !== undefined) {
									sigmaEff =
										sigma *
										(transition((start - s) / lambda1) *
											transition((s - end) / lambda2));
								} else {
									sigmaEff = sigma;
									if (start !== undefined) {
										sigmaEff *= transition((start - s) / lambda1);
									}
									if (end !== undefined) {
										sigmaEff *= transition((s - end) / lambda2);
									}
								}
								sigmas[j] = sigmas[j] || 0;
								if (sigmaEff > 0.01) {
									sigmas[j] += sigmaEff;
								}
							}
						}
						for (let i = 0; i < sigmas.length; i++) {
							points[i].sigma =
								points[i].sigma !== undefined && points[i].sigma > 0
									? Math.sqrt(points[i].sigma ** 2 + sigmas[i] ** 2)
									: sigmas[i];
						}
					} else {
						// if only a sigma value was provided in selective smoothing, then add it to any sigma0
						sigma0 = Math.sqrt(sigma0 ** 2 + smoothSigmas[0] ** 2);
					}
				}
			}
		}

		const keys = [];
		let useCornerEffect = 0;
		if (smoothLoop % 3 === 0) {
			keys.push("ele", "latlon");
			useCornerEffect = 0;
		} else if (smoothLoop % 3 === 1) {
			keys.push("ele");
			useCornerEffect = 0;
		} else if (smoothLoop % 3 === 2) {
			keys.push("gradient");
			useCornerEffect = 1;
		}

		if (smoothLoop % 3 === 2) {
			addGradientField(points, options.isLoop);
		}

		for (const key of keys) {
			points = smoothing(
				points,
				key === "latlon" ? ["lat", "lon"] : [key],
				options.isLoop,
				points[0].sigma !== undefined ? "sigma" : "",
				1, // sigmaFactor
				sigma0,
				[], // weighting
				useCornerEffect ? options.cornerEffect || 1 : 0,
			);
		}

		if (smoothLoop % 3 === 2) {
			integrateGradientField(points, options.isLoop);
		}
	}

	if (smoothed) {
		// STAGE 22: Smoothing
		dumpPoints(points, "22-js-smoothed.txt");
	}

	// anchoring: return start point and, if not a loop, finish point to original values
	// if anchoring requested
	if (options.anchorSF && !options.isLoop) {
		addDistanceField(points);

		for (const d of [1, -1]) {
			const sigma = {
				ele: Math.sqrt(
					(options.lSmooth || 0) ** 2 + (options.zSmooth || 0) ** 2,
				),
				lat: options.lSmooth || 0,
				lon: options.lSmooth || 0,
			};

			// the point to anchor
			const i0 = d === 1 ? 0 : maxIndex(points);

			// if autosmoothing is used, then add that in
			if (points[i0].sigma !== undefined && (options.zAutoSmooth || 0) > 0) {
				sigma.ele = Math.sqrt(
					sigma.ele ** 2 + (points[i0].sigma * (options.zAutoSmooth || 0)) ** 2,
				);
			}

			// this is from BEFORE smoothing since we've not updated the distance field: this is important
			const courseDistance =
				endPoints[maxIndex(endPoints)].distance - endPoints[0].distance;

			for (const key of Object.keys(sigma)) {
				if (sigma[key] > 0) {
					const dy0 = points[i0][key] - endPoints[i0][key];

					// step thru points
					let i = i0 % points.length;

					const dsMax = 6 * sigma[key];
					while (i <= maxIndex(points) && i >= 0) {
						// distance: using values calculated from the original course, not
						// distorted by smoothing, since smoothing can collapse points,
						// and point of anchoring is to reduce collapse
						const s = Math.abs(
							distanceDifference(
								points[i],
								points[i0],
								courseDistance,
								options.isLoop,
							),
						);
						if (s > dsMax) break;

						const u = s / sigma[key];
						const w = Math.exp(-(u ** 2) / 2) * (1 - s / courseDistance);
						points[i][key] -= w * dy0;

						i += d;
					}
				}
			}
		}
	}
	if (!(options.addSigma || 0)) {
		deleteField2(points, "sigma");
	}

	// spline again post-smoothing, if requested
	if (
		_splineRadians > 0 &&
		((options.lSmooth || 0) > 1 || (options.zSmooth || 0) > 0)
	) {
		// STAGE 23: Post-smoothing splines
		note("corner splines, post-smoothing...");
		points = addSplines(
			points,
			_splineRadians,
			_splineMaxRadians,
			options.splineStart,
			options.splineEnd,
			options.isLoop || 0,
			"spline",
		);
		dumpPoints(points, "23-js-post-smoothing-splines.txt");
	}

	if (options.fixCrossings) {
		// STAGE 26: Fix crossings
		note("fixing crossings...");

		// Calculate crossing parameters
		const crossingAngle = options.crossingAngle;
		const crossingX =
			crossingAngle !== undefined && crossingAngle >= 0
				? Math.abs(Math.sin(crossingAngle * DEG2RAD))
				: Math.sin(PI / 16);

		// Ensure distance field exists
		addDistanceField(points);

		// Create simplified version of profile
		// Monitor the direction and when the direction changes enough, add a point
		const simplified = [0, 1];
		if (points.length <= 1) {
			/* istanbul ignore next */
			die("course lacks at least two points... quitting");
		}

		const simplifiedAngle = PI / 24;
		for (let i = 2; i <= maxIndex(points); i++) {
			const angle = latlngAngle(
				points[i],
				points[simplified[simplified.length - 1]],
				points[simplified[simplified.length - 2]],
			);
			// Add points which cause an angle change
			if (
				angle !== null &&
				Math.abs(angle) > simplifiedAngle &&
				(options.isLoop || i < maxIndex(points))
			) {
				const a1 = latlngAngle(
					points[(i + 1) % points.length],
					points[i],
					points[simplified[simplified.length - 1]],
				);
				const a2 = latlngAngle(
					points[(i + 1) % points.length],
					points[i],
					points[i - 1],
				);
				if (
					(a1 !== null && Math.abs(a1) > simplifiedAngle) ||
					(a2 !== null && Math.abs(a2) > simplifiedAngle)
				) {
					simplified.push(i);
				}
			}
		}

		if (options.isLoop) {
			if (
				!pointsAreClose(points[0], points[simplified[simplified.length - 1]])
			) {
				simplified.push(0);
			}
		} else {
			if (
				simplified[simplified.length - 1] !== maxIndex(points) &&
				!pointsAreClose(
					points[maxIndex(points)],
					points[simplified[simplified.length - 1]],
				)
			) {
				simplified.push(maxIndex(points));
			}
		}

		// Search for crossings on simplified route
		const crossings = [];

		for (let j = 1; j < simplified.length - 1; j++) {
			for (let i = 0; i < j - 1; i++) {
				const fs = segmentIntercept(
					[points[simplified[i]], points[simplified[i + 1]]],
					[points[simplified[j]], points[simplified[j + 1]]],
				);
				if (fs.length === 2) {
					// There is a crossing between simplified segments i and j
					// But the actual intersection might be from adjacent segments... so check those if the intersection was close to the edge
					const u1 = fs[0] < 0.5 && i > 0 ? simplified[i - 1] : simplified[i];
					const u2 =
						(fs[0] > 0.5 && i < simplified.length - 2
							? simplified[i + 2]
							: simplified[i + 1]) - 1;
					const v1 = fs[1] < 0.5 && j > 0 ? simplified[j - 1] : simplified[j];
					const v2 =
						(fs[1] > 0.5 && j < simplified.length - 2
							? simplified[j + 2]
							: simplified[j + 1]) - 1;

					// Find the specific segments and positions where the crossings occur
					for (let u = u1; u <= u2; u++) {
						for (let v = v1; v <= v2; v++) {
							const gs = segmentIntercept(
								[points[u], points[(u + 1) % points.length]],
								[points[v], points[(v + 1) % points.length]],
							);
							if (gs.length === 2) {
								const up1 = (u + 1) % points.length;
								const vp1 = (v + 1) % points.length;
								const cNew = [];
								cNew.push(interpolatePoint(points[u], points[up1], gs[0]));
								const z1 = cNew[cNew.length - 1].ele;
								cNew.push(interpolatePoint(points[v], points[vp1], gs[1]));
								const z2 = cNew[cNew.length - 1].ele;
								const zAvg = (z1 + z2) / 2;

								// Adjust the altitude of the crossing points
								if (
									Math.abs(
										latlngCrossProduct(
											points[u],
											points[up1],
											points[v],
											points[vp1],
										),
									) > crossingX
								) {
									const crossingHeight = options.crossingHeight || 2;
									if (Math.abs(z1 - z2) < crossingHeight / 2) {
										note(
											`crossing @ ${cNew[cNew.length - 2].distance} m and ${cNew[cNew.length - 1].distance} m: setting level crossing altitude to ${zAvg}`,
										);
										cNew[cNew.length - 2].ele = zAvg;
										cNew[cNew.length - 1].ele = zAvg;
									} else if (Math.abs(z1 - z2) < crossingHeight) {
										cNew[cNew.length - 2].ele =
											zAvg + (Math.sign(z1 - zAvg) * crossingHeight) / 2;
										cNew[cNew.length - 1].ele =
											zAvg + (Math.sign(z2 - zAvg) * crossingHeight) / 2;
										note(
											`crossing @ ${cNew[cNew.length - 2].distance} m and ${cNew[cNew.length - 1].distance} m: setting overpass altitudes to ${cNew[cNew.length - 2].ele} and ${cNew[cNew.length - 1].ele}`,
										);
									}
									crossings.push(...cNew);
								}
							}
						}
					}
				}
			}
		}

		note(`total crossings = ${crossings.length}`);

		// Crossing parameters
		const rCrossings = options.rCrossings || 6;
		const r1 = rCrossings;
		const r2 = options.crossingTransition || 3 * rCrossings;
		const r3 = (r1 + r2) / 2;
		const r4 = (3 * r1 + r2) / 4;

		// Sort crossings and create interpolated point list
		const si = [];
		for (const c of crossings) {
			const s = c.distance;
			si.push(
				s - r2,
				s - r3,
				s - r4,
				s - r1,
				s,
				s + r1,
				s + r4,
				s + r3,
				s + r2,
			);
		}

		si.sort((a, b) => a - b);

		// Remove points too close together
		if (si.length > 0) {
			const siNew = [si[0]];
			for (let j = 1; j <= maxIndex(si); j++) {
				if (Math.abs(si[j] - siNew[siNew.length - 1]) > 0.5) {
					siNew.push(si[j]);
				}
			}
			si.length = 0;
			si.push(...siNew);
		}

		// Interpolate points at crossings
		if (si.length > 0) {
			note("adding additional points at crossings...");
			const newPoints = [points[0]];
			let j = 0;
			for (let i = 0; i < points.length - 1; i++) {
				const s1 = points[i].distance;
				const s2 = points[i + 1].distance;

				// Skip si entries that are before current segment
				while (j <= maxIndex(si) && si[j] <= s1) {
					j++;
				}

				// Add interpolated points within current segment
				while (j < si.length && s2 > si[j]) {
					if (Math.abs(si[j] - s1) > 0.5 && Math.abs(si[j] - s2) > 0.5) {
						const f = (si[j] - s1) / (s2 - s1);
						newPoints.push(interpolatePoint(points[i], points[i + 1], f));
					}
					j++;
				}

				newPoints.push(points[i + 1]);
			}

			points = newPoints;
		}

		dumpPoints(points, "26-js-crossings-fixed.txt");
	}

	if (options.prune) {
		// STAGE 29: Prune points
		// Prune in each direction
		for (let n = 0; n < 2; n++) {
			let pruneCount = 0;
			const pNew = [points[0]];
			for (let i = 1; i <= maxIndex(points) - 1; i++) {
				const p1 = pNew[pNew.length - 1];
				const p2 = points[i + 1];
				const p3 = points[i];
				if (
					isPointPrunable(
						[p1, p2, p3],
						options.pruneD || 1,
						options.pruneX || 0.001,
						options.prunedg || 0.0005,
					)
				) {
					pruneCount++;
				} else {
					pNew.push(p3);
				}
			}
			pNew.push(points[maxIndex(points)]);
			pNew.reverse();
			points = pNew;
			deleteDerivedFields(points);
			note(`prune loop ${n}: pruned ${pruneCount} points.`);
		}
		dumpPoints(points, "29-js-pruned.txt");
	}

	// STAGE 35: U-turn loops
	if (options.rUTurn !== undefined && Math.abs(options.rUTurn) > 1) {
		note("checking for U-turn loops...");

		// Get rid of duplicate point at end
		const pointPopped = pointsAreClose(points[0], points[maxIndex(points)]);
		if (pointPopped) {
			points.pop();
		}

		// Two sweeps: one for 3-point turns, the next for 4-point turns
		for (const turnType of [3, 4]) {
			const pNew = [];
			let i = 0;

			if (!options.isLoop) {
				pNew.push(points[i++]);
			}

			while (i <= maxIndex(points)) {
				pNew.push(points[i]);

				if (pointsAreClose(points[i], points[(i + 1) % points.length])) {
					i++;
					continue;
				}

				// Select points: check for duplicate points
				let h = (i - 1 + points.length) % points.length;
				if (h !== i && pointsAreClose(points[h], points[i])) {
					h = (h - 1 + points.length) % points.length;
				}
				let j = (i + 1) % points.length;
				let k = (j + 1) % points.length;
				if (j !== i && pointsAreClose(points[j], points[i])) {
					j = (j + 1) % points.length;
					k = (k + 1) % points.length;
				}
				if (k !== i && pointsAreClose(points[j], points[k])) {
					k = (k + 1) % points.length;
				}

				if (
					turnType === 3 &&
					(options.isLoop || i < maxIndex(points)) &&
					UTurnCheck(points[h], points[i], points[i], points[j])
				) {
					const d1 = latlngDirection(points[h], points[i]);
					const d2 = latlngDirection(points[j], points[i]);
					note(
						`3-point U-turn detected @\n` +
							`   1: point ${h + 1} of ${points.length} (${points[h].lon}, ${points[h].lat})\n` +
							`   2: point ${i + 1} of ${points.length} (${points[i].lon}, ${points[i].lat})\n` +
							`   3: point ${j + 1} of ${points.length} (${points[j].lon}, ${points[j].lat})\n` +
							`   directions = ${d1 / DEG2RAD}, ${d2 / DEG2RAD}`,
					);
					const dir = averageAngles(d1, d2);
					const loop = makeLoop(
						[points[i], points[i]],
						dir,
						options.rUTurn,
						loopSign,
						segmentNames,
					);
					pNew.push(...loop);
					pNew.push({ ...points[i] }); // Put a copy of the turn-around point here
				} else if (
					turnType === 4 &&
					(options.isLoop || (i > 0 && i < maxIndex(points) - 1)) &&
					UTurnCheck(points[h], points[i], points[j], points[k]) &&
					latlngDistance(points[i], points[j]) < 20
				) {
					const d1 = latlngDirection(points[h], points[i]);
					const d2 = latlngDirection(points[k], points[j]);
					note(
						`4-point U-turn detected @\n` +
							`   1: point ${h + 1} of ${points.length} (${points[h].lon}, ${points[h].lat})\n` +
							`   2: point ${i + 1} of ${points.length} (${points[i].lon}, ${points[i].lat})\n` +
							`   3: point ${j + 1} of ${points.length} (${points[j].lon}, ${points[j].lat})\n` +
							`   4: point ${k + 1} of ${points.length} (${points[k].lon}, ${points[k].lat})\n` +
							`   directions = ${d1 / DEG2RAD}, ${d2 / DEG2RAD}`,
					);
					const dir = averageAngles(d1, d2);
					const loop = makeLoop(
						[points[i], points[j]],
						dir,
						options.rUTurn,
						loopSign,
						segmentNames,
					);
					pNew.push(...loop);
				}
				i++;
			}

			// Add remaining points that weren't processed in the main loop
			while (i < points.length) {
				pNew.push(points[i++]);
			}

			points = pNew;
		}

		if (pointPopped) {
			points.push({ ...points[0] });
		}
		dumpPoints(points, "35-js-u-turn-loops.txt");
	}

	// STAGE 36: Set minimum radius
	if (options.minRadius !== undefined && options.minRadius > 0) {
		const minRadius = options.minRadius;
		const minRadiusStart = options.minRadiusStart;
		const minRadiusEnd = options.minRadiusEnd;

		// For loops, remove duplicate final point before processing
		// For the purposes of corner smoothing, the start and finish should be viewed as a single point.
		// Hence, the penultimate point should immediately be followed by the start point.
		// Enumerating the same point twice messes up the corner smoothing algorithm.
		if (
			options.isLoop &&
			points.length > 1 &&
			pointsAreClose(points[0], points[maxIndex(points)])
		) {
			points.pop();
		}

		note(`setting minimum radius to ${minRadius}...`);
		addCurvatureField(points, options.isLoop);
		addDistanceField(points);
		const courseDistance = calcCourseDistance(points, options.isLoop);

		// calculate a lane shift field
		const maxCurvature = 1 / minRadius;
		let count = 0;
		const posShifts = points.map(() => 0);
		const negShifts = points.map(() => 0);
		const lambda = 16 * Math.sqrt(minRadius);

		for (let u = 0; u < points.length; u++) {
			const p = points[u];
			const inRange =
				(minRadiusStart === undefined || p.distance >= minRadiusStart ? 1 : 0) +
				(minRadiusEnd === undefined || p.distance <= minRadiusEnd ? 1 : 0) +
				(minRadiusEnd !== undefined &&
				minRadiusStart !== undefined &&
				minRadiusEnd < minRadiusStart
					? 1
					: 0);

			if (inRange === 2 && Math.abs(p.curvature) > maxCurvature) {
				const s = minRadius - Math.abs(1 / p.curvature);
				const a = p.curvature > 0 ? posShifts : negShifts;
				if (a[u] < s) {
					a[u] = s;
				}
				count++;
			}
		}

		if (count > 0) {
			note(
				"found " +
					count +
					" points tighter than minimum radius " +
					minRadius +
					" meters...",
			);

			for (const a of [posShifts, negShifts]) {
				let u1 = 0;
				let u2 = 0;

				if (options.isLoop) {
					while (
						u1 > -maxIndex(points) &&
						distanceDifference(
							ix(points, u1 - 1),
							points[0],
							courseDistance,
							options.isLoop,
						) < lambda
					) {
						u1--;
					}
				}

				const newShifts = [...a];
				for (let u0 = 0; u0 < points.length; u0++) {
					if (a[u0] === 0) continue;

					// u1 ... u0 ... u2
					while (
						u1 < u0 &&
						distanceDifference(
							ix(points, u1),
							points[u0],
							courseDistance,
							options.isLoop,
						) > lambda
					) {
						u1++;
					}
					if (u2 < u0) u2 = u0;
					while (
						(options.isLoop
							? (u2 + 1) % points.length !== u1
							: u2 < maxIndex(points)) &&
						distanceDifference(
							points[u0],
							points[(u2 + 1) % points.length],
							courseDistance,
							options.isLoop,
						) < lambda
					) {
						u2 = (u2 + 1) % points.length;
					}

					for (let u = u1; u <= u2; u++) {
						// the u0 point has already been set...
						if (u === u0) continue;

						const f =
							((1 +
								Math.cos(
									(PI *
										pointSeparation(
											ix(points, u),
											points[u0],
											courseDistance,
											options.isLoop,
										)) /
										lambda,
								)) /
								2) **
							2;
						const shift = a[u0] * f;

						// if there's an existing shift, then combine with that:
						const normalizedU =
							((u % newShifts.length) + newShifts.length) % newShifts.length;
						if (shift > newShifts[normalizedU]) {
							newShifts[normalizedU] = shift;
						}
					}
				}

				// Copy back the new shifts
				for (let u = 0; u < points.length; u++) {
					a[u] = newShifts[u];
				}
			}

			// fill in shifts... sum of positive and negative shifts.
			for (let u = 0; u < points.length; u++) {
				points[u].shift = (points[u].shift || 0) + posShifts[u] - negShifts[u];
			}

			points = applyLaneShift(points, options.isLoop);

			// Debug: Check for NaN after lane shift
			let _nanAfterShift = 0;
			for (let i = 0; i < Math.min(5, points.length); i++) {
				const p = points[i];
				if (Number.isNaN(p.lat) || Number.isNaN(p.lon)) {
					note(
						`DEBUG: Point ${i} has NaN after lane shift: lat=${p.lat}, lon=${p.lon}`,
					);
					_nanAfterShift++;
				}
			}

			// apply smoothing after shift: shifting can cause some noise
			points = smoothing(
				points,
				["lat", "lon", "ele"],
				options.isLoop,
				"shift",
				0.2,
			);

			// Debug: Check for NaN after post-shift smoothing
			let _nanAfterSmoothing = 0;
			for (let i = 0; i < Math.min(5, points.length); i++) {
				const p = points[i];
				if (Number.isNaN(p.lat) || Number.isNaN(p.lon)) {
					note(
						`DEBUG: Point ${i} has NaN after smoothing: lat=${p.lat}, lon=${p.lon}`,
					);
					_nanAfterSmoothing++;
				}
			}

			deleteField2(points, "shift");
			dumpPoints(points, "36-js-min-radius.txt");
		}

		// For loops, restore final point by copying the (possibly moved) start point
		// After processing, copy the start point to restore loop closure
		if (options.isLoop && points.length > 0) {
			points.push({ ...points[0] });
		}
	}

	// STAGE 41: Simplify points
	if (options.simplifyPoints) {
		note("simplifying points...");
		points = simplifyPoints(
			points,
			options.simplifyZ || 0.1,
			options.simplifyD || 0.3,
		);
		dumpPoints(points, "41-js-simplified.txt");
	}

	// Add distance field for final calculations
	addDistanceField(points);

	// Add times from bike speed model, if requested
	if (options.startTime !== undefined && options.startTime !== "") {
		note("adding time...");
		const tStart = new Date(options.startTime).getTime() / 1000; // Convert to Unix timestamp
		if (tStart > 0) {
			note(`start time found: ${tStart}`);
			const ts = [0];
			const gs = [0];

			for (let i = 0; i < maxIndex(points); i++) {
				const dd = points[i + 1].distance - points[i].distance;
				const gradient =
					dd === 0
						? gs[gs.length - 1]
						: (points[i + 1].ele - points[i].ele) / dd;
				gs.push(gradient);
				const speed = bikeSpeedModel(gradient);
				const deltaTime = (points[i + 1].distance - points[i].distance) / speed;
				ts.push(ts[ts.length - 1] + deltaTime);
			}

			for (let i = 0; i < points.length; i++) {
				points[i].time = tStart + ts[i];
				points[i].duration = ts[i];
			}
		}
	}

	const courseDistance = calcCourseDistance(points, options.isLoop);
	note(`final number of points = ${points.length}`);
	note(`course distance = ${(courseDistance / 1000).toFixed(4)} kilometers`);

	const [finalScore, finalScoreD, finalScoreZ] = calcQualityScore(
		points,
		options.isLoop,
	);
	note(`quality score of final course = ${finalScore.toFixed(4)}`);
	note(`direction score of final course = ${finalScoreD.toFixed(4)}`);
	note(`altitude score of final course = ${finalScoreZ.toFixed(4)}`);

	const lastToFirstDistance = latlngDistance(
		points[maxIndex(points)],
		points[0],
	);
	note(
		`distance from last point to first point = ${lastToFirstDistance.toFixed(3)} meters`,
	);

	// Add curvature field if requested
	if (options.addCurvature) {
		note("checking curvature");
		addCurvatureField(points, options.isLoop);
	} else {
		deleteField2(points, "curvature");
	}

	// Add gradient field if requested
	if (options.addGradient) {
		note("adding gradient field");
		addGradientField(points, options.isLoop);
	} else {
		deleteField2(points, "gradient");
	}

	// Remove distance field unless explicitly requested
	if (!options.addDistance) {
		deleteField2(points, "distance");
	}

	// Add heading field if requested
	if (options.addDirection) {
		addHeadingField(points, options.isLoop);
	} else {
		deleteField2(points, "direction");
		deleteField2(points, "heading");
	}

	// Convert processed points back to coordinates format for output
	const processedFeature = {
		type: trackFeature.type,
		geometry: {
			type: trackFeature.geometry.type,
			coordinates: points.map((p) => {
				const coord = [p.lon, p.lat];
				if (p.ele !== undefined) {
					coord.push(p.ele);
				}
				return coord;
			}),
		},
		properties: {
			...trackFeature.properties,
			processed: true,
			processedAt: new Date().toISOString(),
			processOptions: { ...options },
		},
	};

	return processedFeature;
}

// ============================================================================
// ADDITIONAL EXPORTS for GPXForge integration
// ============================================================================

export {
	smoothing,
	addGradientField,
	integrateGradientField,
	addDistanceField,
	addDistanceFieldIfNeeded,
	addCurvatureField,
	addDirectionField,
	calcCourseDistance,
	calcSmoothingSigma,
	calcQualityScore,
	latlngDistance,
}
