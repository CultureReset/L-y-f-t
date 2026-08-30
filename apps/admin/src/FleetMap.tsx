/**
 * The live fleet map.
 *
 * Plain SVG over the same Web Mercator projection the apps use, so a driver
 * plotted here sits exactly where the rider's app shows them. Auto-frames the
 * fleet, and highlights the selected ride's route.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { boundsOf, decodePolyline, type LatLng, type Ride } from '@lift/core';
import type { AdminDriverView } from '@lift/sdk';

const TILE = 256;

const project = (point: LatLng, zoom: number): { x: number; y: number } => {
  const scale = TILE * 2 ** zoom;
  const lat = Math.max(-85.05112878, Math.min(85.05112878, point.lat));
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: scale * (point.lng / 360 + 0.5),
    y: scale * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)),
  };
};

const DRIVER_COLORS: Record<string, string> = {
  available: 'var(--success)',
  offered: 'var(--warning)',
  on_ride: 'var(--primary)',
  busy: 'var(--text-secondary)',
  offline: 'var(--text-muted)',
};

export interface FleetMapProps {
  readonly drivers: readonly AdminDriverView[];
  readonly rides: readonly Ride[];
  readonly selectedRideId?: string;
  readonly onSelectRide: (rideId: string) => void;
}

export const FleetMap = ({
  drivers,
  rides,
  selectedRideId,
  onSelectRide,
}: FleetMapProps): React.JSX.Element => {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Frame everything that has a position. */
  const view = useMemo(() => {
    const points: LatLng[] = [
      ...drivers.filter((d) => d.position).map((d) => d.position as LatLng),
      ...rides.map((r) => r.itinerary.pickup.coordinates),
      ...rides.map((r) => r.itinerary.dropoff.coordinates),
    ];
    if (points.length === 0) {
      return { center: { lat: 37.7749, lng: -122.4194 }, zoom: 12 };
    }

    const bounds = boundsOf(points, 0.2);
    const nw = project({ lat: bounds.north, lng: bounds.west }, 0);
    const se = project({ lat: bounds.south, lng: bounds.east }, 0);
    const zoomX = Math.log2(Math.max(1, size.width - 80) / Math.max(1e-9, se.x - nw.x));
    const zoomY = Math.log2(Math.max(1, size.height - 80) / Math.max(1e-9, se.y - nw.y));

    return {
      center: {
        lat: (bounds.north + bounds.south) / 2,
        lng: (bounds.east + bounds.west) / 2,
      },
      zoom: Math.max(9, Math.min(16, Math.min(zoomX, zoomY))),
    };
  }, [drivers, rides, size]);

  const toScreen = useMemo(() => {
    const centerWorld = project(view.center, view.zoom);
    return (point: LatLng): { x: number; y: number } => {
      const world = project(point, view.zoom);
      return {
        x: world.x - centerWorld.x + size.width / 2,
        y: world.y - centerWorld.y + size.height / 2,
      };
    };
  }, [view, size]);

  return (
    <div ref={container} style={{ position: 'absolute', inset: 0 }}>
      <svg width={size.width} height={size.height}>
        <Grid view={view} size={size} toScreen={toScreen} />

        {rides.map((ride) => {
          const leg = ride.legs.find((l) => l.kind !== 'to_pickup') ?? ride.legs[0];
          if (!leg?.geometry) return null;
          const points = decodePolyline(leg.geometry)
            .map(toScreen)
            .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
            .join(' ');
          const selected = ride.id === selectedRideId;
          return (
            <polyline
              key={ride.id}
              points={points}
              fill="none"
              stroke={selected ? 'var(--primary)' : 'var(--border)'}
              strokeWidth={selected ? 3 : 2}
              strokeLinecap="round"
              opacity={selected ? 1 : 0.6}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelectRide(ride.id)}
            />
          );
        })}

        {rides.map((ride) => {
          const pickup = toScreen(ride.itinerary.pickup.coordinates);
          const dropoff = toScreen(ride.itinerary.dropoff.coordinates);
          return (
            <g key={`${ride.id}-pins`} onClick={() => onSelectRide(ride.id)} style={{ cursor: 'pointer' }}>
              <circle cx={pickup.x} cy={pickup.y} r={5} fill="var(--success)" opacity={0.9} />
              <rect
                x={dropoff.x - 4}
                y={dropoff.y - 4}
                width={8}
                height={8}
                rx={1.5}
                fill="var(--text)"
                opacity={0.9}
              />
            </g>
          );
        })}

        {drivers
          .filter((d) => d.position)
          .map((driver) => {
            const point = toScreen(driver.position as LatLng);
            const color = DRIVER_COLORS[driver.availability] ?? 'var(--text-muted)';
            const bearing = (driver.position as { bearing?: number }).bearing ?? 0;
            return (
              <g key={driver.driverId} transform={`translate(${point.x} ${point.y})`}>
                <title>
                  {driver.name} · {driver.availability} · ★ {driver.rating.toFixed(2)}
                </title>
                <circle r={11} fill={color} opacity={0.16} />
                <path
                  d="M 0 -7 L 5 6 L 0 3 L -5 6 Z"
                  fill={color}
                  transform={`rotate(${bearing})`}
                />
              </g>
            );
          })}
      </svg>
    </div>
  );
};

/** A faint reference grid, so movement is legible against a plain background. */
const Grid = ({
  view,
  size,
  toScreen,
}: {
  view: { center: LatLng; zoom: number };
  size: { width: number; height: number };
  toScreen: (point: LatLng) => { x: number; y: number };
}): React.JSX.Element => {
  const step = 0.01 * 2 ** (13 - view.zoom);
  const lines: React.JSX.Element[] = [];
  const span = 30;

  for (let i = -span; i <= span; i++) {
    const x = toScreen({ lat: view.center.lat, lng: view.center.lng + i * step }).x;
    if (x < -50 || x > size.width + 50) continue;
    lines.push(
      <line key={`v${i}`} x1={x} y1={0} x2={x} y2={size.height} stroke="#1c1c22" strokeWidth={1} />,
    );
  }
  for (let i = -span; i <= span; i++) {
    const y = toScreen({ lat: view.center.lat + i * step, lng: view.center.lng }).y;
    if (y < -50 || y > size.height + 50) continue;
    lines.push(
      <line key={`h${i}`} x1={0} y1={y} x2={size.width} y2={y} stroke="#1c1c22" strokeWidth={1} />,
    );
  }
  return <g>{lines}</g>;
};
