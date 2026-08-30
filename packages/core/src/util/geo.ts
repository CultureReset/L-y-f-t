/**
 * Geospatial primitives. Deliberately dependency-free so the same math runs in
 * the dispatcher, inside a React Native screen, and in a unit test.
 */

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

export interface Position extends LatLng {
  /** Degrees clockwise from true north; omitted when the device is stationary. */
  readonly bearing?: number;
  /** Metres per second. */
  readonly speed?: number;
  /** Horizontal accuracy in metres. */
  readonly accuracy?: number;
  readonly timestamp: number;
}

export interface BoundingBox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

export const METERS_PER_MILE = 1609.344;
export const METERS_PER_KM = 1000;

export const metersToMiles = (m: number): number => m / METERS_PER_MILE;
export const milesToMeters = (mi: number): number => mi * METERS_PER_MILE;
export const metersToKm = (m: number): number => m / METERS_PER_KM;

/** Great-circle distance in metres. */
export const haversineMeters = (a: LatLng, b: LatLng): number => {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** Initial bearing from `a` to `b`, degrees clockwise from north. */
export const bearingDegrees = (a: LatLng, b: LatLng): number => {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

/** Point `fraction` of the way along the great circle from `a` to `b`. */
export const interpolate = (a: LatLng, b: LatLng, fraction: number): LatLng => {
  const t = Math.max(0, Math.min(1, fraction));
  const d = haversineMeters(a, b) / EARTH_RADIUS_M;
  if (d === 0) return { lat: a.lat, lng: a.lng };
  const A = Math.sin((1 - t) * d) / Math.sin(d);
  const B = Math.sin(t * d) / Math.sin(d);
  const lat1 = toRad(a.lat);
  const lng1 = toRad(a.lng);
  const lat2 = toRad(b.lat);
  const lng2 = toRad(b.lng);
  const x = A * Math.cos(lat1) * Math.cos(lng1) + B * Math.cos(lat2) * Math.cos(lng2);
  const y = A * Math.cos(lat1) * Math.sin(lng1) + B * Math.cos(lat2) * Math.sin(lng2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return {
    lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lng: toDeg(Math.atan2(y, x)),
  };
};

/** Move `meters` from `origin` along `bearing` degrees. */
export const destination = (origin: LatLng, bearing: number, meters: number): LatLng => {
  const d = meters / EARTH_RADIUS_M;
  const brg = toRad(bearing);
  const lat1 = toRad(origin.lat);
  const lng1 = toRad(origin.lng);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
};

/** Total length of a polyline in metres. */
export const pathLengthMeters = (path: readonly LatLng[]): number => {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += haversineMeters(path[i - 1]!, path[i]!);
  }
  return total;
};

/**
 * Walk `meters` along a polyline, returning the position plus the bearing of
 * the segment being travelled. This is what animates a car marker down a route.
 */
export const pointAlongPath = (
  path: readonly LatLng[],
  meters: number,
): { position: LatLng; bearing: number; index: number; remaining: number } => {
  if (path.length === 0) throw new Error('pointAlongPath: empty path');
  const first = path[0]!;
  const total = pathLengthMeters(path);
  if (path.length === 1 || meters <= 0) {
    return { position: first, bearing: 0, index: 0, remaining: total };
  }
  let travelled = 0;
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1]!;
    const to = path[i]!;
    const segment = haversineMeters(from, to);
    if (travelled + segment >= meters) {
      const fraction = segment === 0 ? 0 : (meters - travelled) / segment;
      return {
        position: interpolate(from, to, fraction),
        bearing: bearingDegrees(from, to),
        index: i - 1,
        remaining: Math.max(0, total - meters),
      };
    }
    travelled += segment;
  }
  const last = path[path.length - 1]!;
  const prev = path[path.length - 2]!;
  return {
    position: last,
    bearing: bearingDegrees(prev, last),
    index: path.length - 1,
    remaining: 0,
  };
};

export const boundsOf = (points: readonly LatLng[], paddingRatio = 0.15): BoundingBox => {
  if (points.length === 0) return { south: 0, west: 0, north: 0, east: 0 };
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const p of points) {
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
  }
  const latPad = Math.max((north - south) * paddingRatio, 0.002);
  const lngPad = Math.max((east - west) * paddingRatio, 0.002);
  return {
    south: south - latPad,
    west: west - lngPad,
    north: north + latPad,
    east: east + lngPad,
  };
};

export const centerOf = (box: BoundingBox): LatLng => ({
  lat: (box.south + box.north) / 2,
  lng: (box.west + box.east) / 2,
});

export const containsPoint = (box: BoundingBox, p: LatLng): boolean =>
  p.lat >= box.south && p.lat <= box.north && p.lng >= box.west && p.lng <= box.east;

export const isWithinMeters = (a: LatLng, b: LatLng, meters: number): boolean =>
  haversineMeters(a, b) <= meters;

/**
 * Grid cell key for the in-memory driver index. Cheaper than a real geohash and
 * good enough to bucket available drivers for a radius query.
 */
export const cellKey = (p: LatLng, precisionDegrees = 0.01): string =>
  `${Math.floor(p.lat / precisionDegrees)}:${Math.floor(p.lng / precisionDegrees)}`;

export const neighborCells = (
  p: LatLng,
  radiusMeters: number,
  precisionDegrees = 0.01,
): string[] => {
  const latDegrees = radiusMeters / 111_320;
  const lngDegrees = radiusMeters / (111_320 * Math.max(0.1, Math.cos(toRad(p.lat))));
  const latSteps = Math.ceil(latDegrees / precisionDegrees);
  const lngSteps = Math.ceil(lngDegrees / precisionDegrees);
  const baseLat = Math.floor(p.lat / precisionDegrees);
  const baseLng = Math.floor(p.lng / precisionDegrees);
  const keys: string[] = [];
  for (let dLat = -latSteps; dLat <= latSteps; dLat++) {
    for (let dLng = -lngSteps; dLng <= lngSteps; dLng++) {
      keys.push(`${baseLat + dLat}:${baseLng + dLng}`);
    }
  }
  return keys;
};

/** Google's encoded-polyline format — the lingua franca of routing providers. */
export const encodePolyline = (path: readonly LatLng[], precision = 5): string => {
  const factor = 10 ** precision;
  let output = '';
  let prevLat = 0;
  let prevLng = 0;
  const encodeValue = (value: number): string => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let chunk = '';
    while (v >= 0x20) {
      chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return chunk + String.fromCharCode(v + 63);
  };
  for (const point of path) {
    const lat = Math.round(point.lat * factor);
    const lng = Math.round(point.lng * factor);
    output += encodeValue(lat - prevLat);
    output += encodeValue(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return output;
};

export const decodePolyline = (encoded: string, precision = 5): LatLng[] => {
  const factor = 10 ** precision;
  const path: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    path.push({ lat: lat / factor, lng: lng / factor });
  }
  return path;
};

/**
 * Douglas–Peucker simplification. Route geometry from a real provider can carry
 * thousands of points; the apps only need enough to draw a smooth line.
 */
export const simplifyPath = (path: readonly LatLng[], toleranceMeters = 5): LatLng[] => {
  if (path.length <= 2) return [...path];
  const perpendicularDistance = (p: LatLng, a: LatLng, b: LatLng): number => {
    const ax = a.lng;
    const ay = a.lat;
    const bx = b.lng;
    const by = b.lat;
    const px = p.lng;
    const py = p.lat;
    const dx = bx - ax;
    const dy = by - ay;
    if (dx === 0 && dy === 0) return haversineMeters(p, a);
    const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    const clamped = Math.max(0, Math.min(1, t));
    return haversineMeters(p, { lat: ay + clamped * dy, lng: ax + clamped * dx });
  };
  const simplify = (points: readonly LatLng[]): LatLng[] => {
    if (points.length <= 2) return [...points];
    const first = points[0]!;
    const last = points[points.length - 1]!;
    let maxDistance = 0;
    let maxIndex = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const distance = perpendicularDistance(points[i]!, first, last);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = i;
      }
    }
    if (maxDistance <= toleranceMeters) return [first, last];
    const left = simplify(points.slice(0, maxIndex + 1));
    const right = simplify(points.slice(maxIndex));
    return [...left.slice(0, -1), ...right];
  };
  return simplify(path);
};
