/**
 * Projection tests.
 *
 * The map renderer draws everything through these functions, so a bug here is
 * a route that lands in the wrong place. They are pure maths, which makes them
 * cheap to pin down exactly.
 */

import { describe, expect, it } from 'vitest';
import {
  boundsCenter,
  fromScreen,
  project,
  simplifyForScreen,
  toScreen,
  unproject,
  viewportForPoints,
  zoomForBounds,
  type Viewport,
} from './projection.js';

const SF = { lat: 37.7749, lng: -122.4194 };
const FERRY = { lat: 37.7955, lng: -122.3937 };
const DOLORES = { lat: 37.7596, lng: -122.4269 };

const viewport: Viewport = { width: 400, height: 800, center: SF, zoom: 13 };

describe('project / unproject', () => {
  it('round-trips a coordinate', () => {
    const world = project(SF, 13);
    const back = unproject(world, 13);
    expect(back.lat).toBeCloseTo(SF.lat, 9);
    expect(back.lng).toBeCloseTo(SF.lng, 9);
  });

  it('places the null island at the centre of the world', () => {
    const world = project({ lat: 0, lng: 0 }, 0);
    expect(world.x).toBeCloseTo(128, 6);
    expect(world.y).toBeCloseTo(128, 6);
  });

  it('doubles world size with each zoom level', () => {
    const atZero = project({ lat: 0, lng: 90 }, 0);
    const atOne = project({ lat: 0, lng: 90 }, 1);
    expect(atOne.x).toBeCloseTo(atZero.x * 2, 6);
  });

  it('clamps beyond the Mercator limit rather than producing infinity', () => {
    const north = project({ lat: 89.9, lng: 0 }, 10);
    expect(Number.isFinite(north.y)).toBe(true);
  });

  it('increases x with longitude and decreases y with latitude', () => {
    expect(project({ lat: 0, lng: 10 }, 10).x).toBeGreaterThan(project({ lat: 0, lng: 0 }, 10).x);
    expect(project({ lat: 10, lng: 0 }, 10).y).toBeLessThan(project({ lat: 0, lng: 0 }, 10).y);
  });
});

describe('toScreen / fromScreen', () => {
  it('puts the viewport centre at the middle of the screen', () => {
    const point = toScreen(SF, viewport);
    expect(point.x).toBeCloseTo(200, 6);
    expect(point.y).toBeCloseTo(400, 6);
  });

  it('round-trips through screen space', () => {
    const screen = toScreen(FERRY, viewport);
    const back = fromScreen(screen, viewport);
    expect(back.lat).toBeCloseTo(FERRY.lat, 6);
    expect(back.lng).toBeCloseTo(FERRY.lng, 6);
  });

  it('places a point north-east of centre up and to the right', () => {
    const point = toScreen(FERRY, viewport);
    expect(point.x).toBeGreaterThan(200);
    expect(point.y).toBeLessThan(400);
  });

  it('places a point south-west of centre down and to the left', () => {
    const point = toScreen(DOLORES, viewport);
    expect(point.x).toBeLessThan(200);
    expect(point.y).toBeGreaterThan(400);
  });
});

describe('zoomForBounds', () => {
  it('picks a zoom that fits the bounds inside the viewport', () => {
    const bounds = { south: 37.75, west: -122.45, north: 37.81, east: -122.39 };
    const zoom = zoomForBounds(bounds, { width: 400, height: 800 }, 40);
    const framed: Viewport = {
      width: 400,
      height: 800,
      center: boundsCenter(bounds),
      zoom,
    };

    for (const corner of [
      { lat: bounds.north, lng: bounds.west },
      { lat: bounds.south, lng: bounds.east },
    ]) {
      const point = toScreen(corner, framed);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(400);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(800);
    }
  });

  it('zooms in further for a smaller area', () => {
    const wide = zoomForBounds(
      { south: 37.0, west: -123.0, north: 38.0, east: -122.0 },
      { width: 400, height: 800 },
    );
    const tight = zoomForBounds(
      { south: 37.77, west: -122.42, north: 37.78, east: -122.41 },
      { width: 400, height: 800 },
    );
    expect(tight).toBeGreaterThan(wide);
  });

  it('stays inside sane zoom limits', () => {
    const absurd = zoomForBounds(
      { south: 37.7749, west: -122.4194, north: 37.77491, east: -122.41939 },
      { width: 400, height: 800 },
    );
    expect(absurd).toBeLessThanOrEqual(19);
    expect(absurd).toBeGreaterThanOrEqual(1);
  });
});

describe('viewportForPoints', () => {
  it('frames a route so both endpoints are on screen', () => {
    const framed = viewportForPoints([FERRY, DOLORES], { width: 400, height: 800 });
    for (const point of [FERRY, DOLORES]) {
      const screen = toScreen(point, framed);
      expect(screen.x).toBeGreaterThan(0);
      expect(screen.x).toBeLessThan(400);
      expect(screen.y).toBeGreaterThan(0);
      expect(screen.y).toBeLessThan(800);
    }
  });

  it('centres a single point at a close zoom', () => {
    const framed = viewportForPoints([FERRY], { width: 400, height: 800 });
    expect(framed.center).toEqual(FERRY);
    expect(framed.zoom).toBeGreaterThanOrEqual(15);
  });

  it('falls back to a supplied centre when there is nothing to frame', () => {
    const framed = viewportForPoints([], { width: 400, height: 800 }, { fallbackCenter: SF });
    expect(framed.center).toEqual(SF);
  });

  it('never exceeds the requested max zoom', () => {
    const framed = viewportForPoints([FERRY], { width: 400, height: 800 }, { maxZoom: 12 });
    expect(framed.zoom).toBe(12);
  });
});

describe('simplifyForScreen', () => {
  it('drops points that would land on the same pixel', () => {
    // 200 points along a very short segment: most are visually identical.
    const dense = Array.from({ length: 200 }, (_, i) => ({
      lat: SF.lat + i * 0.000002,
      lng: SF.lng + i * 0.000002,
    }));
    const simplified = simplifyForScreen(dense, viewport);
    expect(simplified.length).toBeLessThan(dense.length);
  });

  it('always keeps the first and last point', () => {
    const dense = Array.from({ length: 50 }, (_, i) => ({
      lat: SF.lat + i * 0.000001,
      lng: SF.lng,
    }));
    const simplified = simplifyForScreen(dense, viewport);
    expect(simplified[0]).toEqual(dense[0]);
    expect(simplified[simplified.length - 1]).toEqual(dense[dense.length - 1]);
  });

  it('leaves a short path alone', () => {
    expect(simplifyForScreen([FERRY, DOLORES], viewport)).toHaveLength(2);
  });
});
