/**
 * The map abstraction.
 *
 * `MapRenderer` is the seam: the apps describe *what* to show — a route, some
 * pins, a moving car — and a renderer decides *how*. The built-in SVG renderer
 * needs no API key and runs on Android, iOS, and web; a react-native-maps or
 * Mapbox renderer is a drop-in replacement that implements the same props.
 */

import type { ReactNode } from 'react';
import type { LatLng } from '@lift/core';
import type { Viewport } from './projection.js';

export interface MapMarker {
  readonly id: string;
  readonly coordinate: LatLng;
  readonly kind: 'pickup' | 'dropoff' | 'stop' | 'car' | 'pin' | 'custom';
  /** Degrees clockwise from north; rotates a car marker to face its heading. */
  readonly bearing?: number;
  readonly label?: string;
  /** Renderers that support custom content will use this instead of the icon. */
  readonly content?: ReactNode;
  readonly color?: string;
  readonly zIndex?: number;
}

export interface MapPolyline {
  readonly id: string;
  readonly points: readonly LatLng[];
  readonly color?: string;
  readonly width?: number;
  /** A dashed line reads as "planned" rather than "travelled". */
  readonly dashed?: boolean;
  readonly opacity?: number;
}

export interface MapCircle {
  readonly id: string;
  readonly center: LatLng;
  readonly radiusMeters: number;
  readonly color?: string;
  readonly opacity?: number;
}

export interface MapProps {
  readonly markers?: readonly MapMarker[];
  readonly polylines?: readonly MapPolyline[];
  readonly circles?: readonly MapCircle[];
  /** Frame the map so all of these are visible. */
  readonly fitTo?: readonly LatLng[];
  readonly center?: LatLng;
  readonly zoom?: number;
  readonly padding?: number;
  /** Let the user pan and pinch. Off while a ride is being tracked. */
  readonly interactive?: boolean;
  readonly onPress?: (coordinate: LatLng) => void;
  readonly onRegionChange?: (viewport: Viewport) => void;
  readonly style?: object;
  readonly children?: ReactNode;
  readonly testID?: string;
}

/** A map implementation. Register one to change how every map screen renders. */
export type MapRenderer = (props: MapProps) => ReactNode;
