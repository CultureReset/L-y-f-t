/**
 * Web Mercator projection.
 *
 * Turns coordinates into screen pixels so the built-in map renderer can draw
 * routes and markers without any mapping SDK. Same maths every slippy map
 * uses, which means a route drawn here lines up with one drawn by Google or
 * Mapbox at the same zoom.
 */

import type { BoundingBox, LatLng } from '@lift/core';

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly center: LatLng;
  /** Standard slippy-map zoom level. */
  readonly zoom: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

const TILE_SIZE = 256;
const MAX_LATITUDE = 85.05112878;

/** Project a coordinate into world pixels at a given zoom. */
export const project = (point: LatLng, zoom: number): ScreenPoint => {
  const scale = TILE_SIZE * 2 ** zoom;
  const lat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, point.lat));
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: scale * (point.lng / 360 + 0.5),
    y: scale * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)),
  };
};

/** Inverse of `project`. */
export const unproject = (screen: ScreenPoint, zoom: number): LatLng => {
  const scale = TILE_SIZE * 2 ** zoom;
  const lng = (screen.x / scale - 0.5) * 360;
  const y = 0.5 - screen.y / scale;
  const lat = 90 - (360 * Math.atan(Math.exp(-y * 2 * Math.PI))) / Math.PI;
  return { lat, lng };
};

/** Project a coordinate to a pixel inside the viewport. */
export const toScreen = (point: LatLng, viewport: Viewport): ScreenPoint => {
  const world = project(point, viewport.zoom);
  const centerWorld = project(viewport.center, viewport.zoom);
  return {
    x: world.x - centerWorld.x + viewport.width / 2,
    y: world.y - centerWorld.y + viewport.height / 2,
  };
};

/** Convert a viewport pixel back to a coordinate — used for a dropped pin. */
export const fromScreen = (screen: ScreenPoint, viewport: Viewport): LatLng => {
  const centerWorld = project(viewport.center, viewport.zoom);
  return unproject(
    {
      x: screen.x - viewport.width / 2 + centerWorld.x,
      y: screen.y - viewport.height / 2 + centerWorld.y,
    },
    viewport.zoom,
  );
};

/**
 * The zoom that fits a bounding box into a viewport, with padding. This is
 * what frames a route so pickup and dropoff are both comfortably on screen.
 */
export const zoomForBounds = (
  bounds: BoundingBox,
  size: { width: number; height: number },
  paddingPx = 48,
): number => {
  const usableWidth = Math.max(1, size.width - paddingPx * 2);
  const usableHeight = Math.max(1, size.height - paddingPx * 2);

  // Solve at zoom 0 and scale, rather than searching.
  const nw = project({ lat: bounds.north, lng: bounds.west }, 0);
  const se = project({ lat: bounds.south, lng: bounds.east }, 0);
  const spanX = Math.max(1e-9, se.x - nw.x);
  const spanY = Math.max(1e-9, se.y - nw.y);

  const zoomX = Math.log2(usableWidth / spanX);
  const zoomY = Math.log2(usableHeight / spanY);

  return Math.max(1, Math.min(19, Math.min(zoomX, zoomY)));
};

export const boundsCenter = (bounds: BoundingBox): LatLng => ({
  lat: (bounds.north + bounds.south) / 2,
  lng: (bounds.east + bounds.west) / 2,
});

/** Build the viewport that frames a set of points. */
export const viewportForPoints = (
  points: readonly LatLng[],
  size: { width: number; height: number },
  options: { paddingPx?: number; fallbackCenter?: LatLng; maxZoom?: number } = {},
): Viewport => {
  const fallbackCenter = options.fallbackCenter ?? { lat: 37.7749, lng: -122.4194 };
  if (points.length === 0) {
    return { ...size, center: fallbackCenter, zoom: 13 };
  }
  if (points.length === 1) {
    return { ...size, center: points[0]!, zoom: options.maxZoom ?? 15 };
  }

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
  const bounds: BoundingBox = { south, west, north, east };

  return {
    ...size,
    center: boundsCenter(bounds),
    zoom: Math.min(
      options.maxZoom ?? 17,
      zoomForBounds(bounds, size, options.paddingPx ?? 56),
    ),
  };
};

/** Drop points that project to nearly the same pixel, to keep paths cheap. */
export const simplifyForScreen = (
  points: readonly LatLng[],
  viewport: Viewport,
  minPixelDistance = 2,
): LatLng[] => {
  if (points.length <= 2) return [...points];
  const out: LatLng[] = [];
  let last: ScreenPoint | undefined;
  for (const [index, point] of points.entries()) {
    const screen = toScreen(point, viewport);
    const isEndpoint = index === 0 || index === points.length - 1;
    if (
      isEndpoint ||
      !last ||
      Math.hypot(screen.x - last.x, screen.y - last.y) >= minPixelDistance
    ) {
      out.push(point);
      last = screen;
    }
  }
  return out;
};
