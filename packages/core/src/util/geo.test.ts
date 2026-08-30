import { describe, expect, it } from 'vitest';
import {
  bearingDegrees,
  boundsAround,
  boundsOf,
  cellKey,
  decodePolyline,
  destination,
  encodePolyline,
  haversineMeters,
  interpolate,
  metersToMiles,
  neighborCells,
  pathLengthMeters,
  pointAlongPath,
  simplifyPath,
} from './geo.js';

const SF = { lat: 37.7749, lng: -122.4194 };
const OAKLAND = { lat: 37.8044, lng: -122.2712 };

describe('geo', () => {
  it('measures great-circle distance', () => {
    // SF to Oakland is roughly 13.4 km.
    const meters = haversineMeters(SF, OAKLAND);
    expect(meters).toBeGreaterThan(13_000);
    expect(meters).toBeLessThan(14_000);
  });

  it('returns zero distance for the same point', () => {
    expect(haversineMeters(SF, SF)).toBe(0);
  });

  it('computes bearing', () => {
    expect(bearingDegrees(SF, { lat: 38.7749, lng: -122.4194 })).toBeCloseTo(0, 1);
    expect(bearingDegrees(SF, { lat: 37.7749, lng: -121.4194 })).toBeCloseTo(89.7, 0);
  });

  it('interpolates to the midpoint', () => {
    const mid = interpolate(SF, OAKLAND, 0.5);
    expect(haversineMeters(SF, mid)).toBeCloseTo(haversineMeters(mid, OAKLAND), -1);
  });

  it('clamps interpolation to the endpoints', () => {
    expect(interpolate(SF, OAKLAND, -1)).toEqual(SF);
    expect(interpolate(SF, OAKLAND, 5).lat).toBeCloseTo(OAKLAND.lat, 6);
  });

  it('projects a destination along a bearing', () => {
    const north = destination(SF, 0, 1000);
    expect(haversineMeters(SF, north)).toBeCloseTo(1000, 0);
    expect(north.lat).toBeGreaterThan(SF.lat);
  });

  it('walks a path and reports the remaining distance', () => {
    const path = [SF, interpolate(SF, OAKLAND, 0.5), OAKLAND];
    const total = pathLengthMeters(path);
    const quarter = pointAlongPath(path, total / 4);
    expect(quarter.remaining).toBeCloseTo(total * 0.75, -1);
    const end = pointAlongPath(path, total * 2);
    expect(end.remaining).toBe(0);
    expect(end.position.lat).toBeCloseTo(OAKLAND.lat, 4);
  });

  it('returns the start for a zero-distance walk', () => {
    const at = pointAlongPath([SF, OAKLAND], 0);
    expect(at.position).toEqual(SF);
  });

  it('throws on an empty path', () => {
    expect(() => pointAlongPath([], 10)).toThrow(/empty path/);
  });

  it('round-trips an encoded polyline', () => {
    const path = [SF, OAKLAND, { lat: 37.5, lng: -122.0 }];
    const decoded = decodePolyline(encodePolyline(path));
    expect(decoded).toHaveLength(3);
    decoded.forEach((point, i) => {
      expect(point.lat).toBeCloseTo(path[i]!.lat, 4);
      expect(point.lng).toBeCloseTo(path[i]!.lng, 4);
    });
  });

  it('builds padded bounds containing every point', () => {
    const box = boundsOf([SF, OAKLAND]);
    expect(box.south).toBeLessThan(Math.min(SF.lat, OAKLAND.lat));
    expect(box.north).toBeGreaterThan(Math.max(SF.lat, OAKLAND.lat));
  });

  it('buckets nearby points into the same grid cell', () => {
    expect(cellKey(SF)).toBe(cellKey({ lat: SF.lat + 0.001, lng: SF.lng + 0.001 }));
    expect(cellKey(SF)).not.toBe(cellKey(OAKLAND));
  });

  it('covers a radius with neighbour cells', () => {
    const cells = neighborCells(SF, 2000);
    expect(cells).toContain(cellKey(SF));
    expect(cells.length).toBeGreaterThan(8);
  });

  it('simplifies a dense path while keeping the endpoints', () => {
    const dense = Array.from({ length: 100 }, (_, i) => interpolate(SF, OAKLAND, i / 99));
    const simplified = simplifyPath(dense, 50);
    expect(simplified.length).toBeLessThan(dense.length);
    expect(simplified[0]).toEqual(dense[0]);
    expect(simplified[simplified.length - 1]).toEqual(dense[dense.length - 1]);
  });

  it('converts units', () => {
    expect(metersToMiles(1609.344)).toBeCloseTo(1, 6);
  });
});

describe('boundsAround', () => {
  it('makes a box the requested distance in every direction', () => {
    const centre = { lat: 37.7955, lng: -122.3937 };
    const box = boundsAround(centre, 5_000);

    // Each edge should be about 5km from the centre, at this latitude.
    expect(haversineMeters(centre, { lat: box.north, lng: centre.lng })).toBeCloseTo(5_000, -1);
    expect(haversineMeters(centre, { lat: box.south, lng: centre.lng })).toBeCloseTo(5_000, -1);
    expect(haversineMeters(centre, { lat: centre.lat, lng: box.east })).toBeCloseTo(5_000, -1);
    expect(haversineMeters(centre, { lat: centre.lat, lng: box.west })).toBeCloseTo(5_000, -1);
  });

  it('widens the longitude span nearer the poles, where degrees are shorter', () => {
    const equator = boundsAround({ lat: 0, lng: 0 }, 5_000);
    const arctic = boundsAround({ lat: 70, lng: 0 }, 5_000);

    expect(arctic.east - arctic.west).toBeGreaterThan(equator.east - equator.west);
  });
});
