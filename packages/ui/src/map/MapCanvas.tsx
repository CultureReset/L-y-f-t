/**
 * The built-in map renderer.
 *
 * Draws the map with react-native-svg: no API key, no billing, no native
 * module, and identical output on Android, iOS, and web. It renders a
 * stylised ground plane, the route, and the markers — everything a ridehail
 * screen actually needs — and is good enough to ship a demo on.
 *
 * Swap it for a real basemap by passing a different renderer to `MapView`.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Polyline as SvgPolyline, Rect } from 'react-native-svg';
import { decodePolyline, haversineMeters, type LatLng } from '@lift/core';
import { useTheme } from '../theme/ThemeProvider.js';
import type { MapProps } from './types.js';
import {
  fromScreen,
  simplifyForScreen,
  toScreen,
  viewportForPoints,
  type Viewport,
} from './projection.js';

export const MapCanvas = ({
  markers = [],
  polylines = [],
  circles = [],
  fitTo,
  center,
  zoom,
  padding = 56,
  interactive = false,
  onPress,
  onRegionChange,
  style,
  children,
  testID,
}: MapProps): React.JSX.Element => {
  const theme = useTheme();
  const [size, setSize] = useState({ width: 0, height: 0 });
  /** Non-zero only while the user is dragging. */
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  }, []);

  /** The viewport: an explicit centre/zoom, or one framed around the content. */
  const viewport: Viewport = useMemo(() => {
    if (size.width === 0 || size.height === 0) {
      return { width: 1, height: 1, center: center ?? { lat: 0, lng: 0 }, zoom: zoom ?? 13 };
    }
    if (center && zoom !== undefined) return { ...size, center, zoom };

    const points = fitTo ?? [
      ...markers.map((m) => m.coordinate),
      ...polylines.flatMap((p) => p.points),
    ];
    const framed = viewportForPoints(points, size, {
      paddingPx: padding,
      ...(center ? { fallbackCenter: center } : {}),
    });
    return zoom !== undefined ? { ...framed, zoom } : framed;
  }, [size, center, zoom, fitTo, markers, polylines, padding]);

  /** Apply an in-progress drag by shifting the centre. */
  const effectiveViewport: Viewport = useMemo(() => {
    if (pan.x === 0 && pan.y === 0) return viewport;
    const centerScreen = { x: viewport.width / 2 - pan.x, y: viewport.height / 2 - pan.y };
    return { ...viewport, center: fromScreen(centerScreen, viewport) };
  }, [viewport, pan]);

  /**
   * A single responder handles both gestures: a release that barely moved is a
   * tap (a dropped pin), anything further is a pan. Keeping them in one place
   * avoids the two handlers fighting over the touch.
   */
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => interactive || Boolean(onPress),
        onMoveShouldSetPanResponder: (_e, gesture) =>
          interactive && (Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3),
        onPanResponderGrant: (event) => {
          panStart.current = {
            x: event.nativeEvent.locationX,
            y: event.nativeEvent.locationY,
          };
        },
        onPanResponderMove: (_e, gesture) => {
          if (!interactive) return;
          setPan({ x: gesture.dx, y: gesture.dy });
        },
        onPanResponderRelease: (_e, gesture) => {
          const travelled = Math.hypot(gesture.dx, gesture.dy);
          if (travelled < 6) {
            onPress?.(fromScreen(panStart.current, effectiveViewport));
          } else if (interactive) {
            // Commit the drag by reporting the new region, then reset the offset.
            onRegionChange?.(effectiveViewport);
          }
          setPan({ x: 0, y: 0 });
        },
      }),
    [interactive, onPress, effectiveViewport, onRegionChange],
  );

  const ready = size.width > 0 && size.height > 0;

  return (
    <View
      testID={testID}
      onLayout={onLayout}
      style={[styles.container, { backgroundColor: theme.colors.mapBackground }, style]}
      {...responder.panHandlers}
    >
      {ready ? (
        <Svg width={size.width} height={size.height}>
          <GroundPlane viewport={effectiveViewport} theme={theme} />

          {circles.map((circle) => {
            const point = toScreen(circle.center, effectiveViewport);
            // Convert a metre radius into pixels at this latitude and zoom.
            const edge = toScreen(
              { lat: circle.center.lat, lng: circle.center.lng + 0.01 },
              effectiveViewport,
            );
            const metersPerDegree = haversineMeters(circle.center, {
              lat: circle.center.lat,
              lng: circle.center.lng + 0.01,
            });
            const pixelsPerMeter = Math.abs(edge.x - point.x) / Math.max(1, metersPerDegree);
            return (
              <Circle
                key={circle.id}
                cx={point.x}
                cy={point.y}
                r={Math.max(2, circle.radiusMeters * pixelsPerMeter)}
                fill={circle.color ?? theme.colors.primary}
                opacity={circle.opacity ?? 0.12}
              />
            );
          })}

          {polylines.map((line) => {
            const simplified = simplifyForScreen(line.points, effectiveViewport);
            if (simplified.length < 2) return null;
            const pointString = simplified
              .map((p) => {
                const s = toScreen(p, effectiveViewport);
                return `${s.x.toFixed(1)},${s.y.toFixed(1)}`;
              })
              .join(' ');
            return (
              <G key={line.id}>
                {/* A casing under the line keeps it legible over any ground. */}
                <SvgPolyline
                  points={pointString}
                  fill="none"
                  stroke={theme.colors.background}
                  strokeWidth={(line.width ?? 5) + 4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.9}
                />
                <SvgPolyline
                  points={pointString}
                  fill="none"
                  stroke={line.color ?? theme.colors.routeLine}
                  strokeWidth={line.width ?? 5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={line.opacity ?? 1}
                  strokeDasharray={line.dashed ? '8,8' : undefined}
                />
              </G>
            );
          })}

          {[...markers]
            .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
            .map((marker) => {
              const point = toScreen(marker.coordinate, effectiveViewport);
              return (
                <Marker
                  key={marker.id}
                  x={point.x}
                  y={point.y}
                  kind={marker.kind}
                  bearing={marker.bearing}
                  color={marker.color}
                  theme={theme}
                />
              );
            })}
        </Svg>
      ) : null}
      {children}
    </View>
  );
};

/**
 * A stylised ground plane: a grid that stands in for a street network, drawn
 * from the viewport so it slides correctly as the map moves. It reads as a map
 * without pretending to be real cartography.
 */
const GroundPlane = ({
  viewport,
  theme,
}: {
  viewport: Viewport;
  theme: ReturnType<typeof useTheme>;
}): React.JSX.Element => {
  // Grid spacing in degrees, chosen so lines stay ~60–120px apart at any zoom.
  const degreeStep = 0.01 * 2 ** (13 - viewport.zoom);
  const topLeft = fromScreen({ x: 0, y: 0 }, viewport);
  const bottomRight = fromScreen({ x: viewport.width, y: viewport.height }, viewport);

  const lines: React.JSX.Element[] = [];
  const startLng = Math.floor(topLeft.lng / degreeStep) * degreeStep;
  const startLat = Math.floor(bottomRight.lat / degreeStep) * degreeStep;

  // Guard against a pathological zoom producing thousands of lines.
  const maxLines = 60;

  for (let i = 0, lng = startLng; lng <= bottomRight.lng && i < maxLines; lng += degreeStep, i++) {
    const x = toScreen({ lat: topLeft.lat, lng }, viewport).x;
    lines.push(
      <Line
        key={`v${i}`}
        x1={x}
        y1={0}
        x2={x}
        y2={viewport.height}
        stroke={theme.colors.mapRoad}
        strokeWidth={i % 4 === 0 ? 3 : 1.5}
        opacity={i % 4 === 0 ? 0.9 : 0.55}
      />,
    );
  }
  for (let i = 0, lat = startLat; lat <= topLeft.lat && i < maxLines; lat += degreeStep, i++) {
    const y = toScreen({ lat, lng: topLeft.lng }, viewport).y;
    lines.push(
      <Line
        key={`h${i}`}
        x1={0}
        y1={y}
        x2={viewport.width}
        y2={y}
        stroke={theme.colors.mapRoad}
        strokeWidth={i % 4 === 0 ? 3 : 1.5}
        opacity={i % 4 === 0 ? 0.9 : 0.55}
      />,
    );
  }

  return (
    <G>
      <Rect
        x={0}
        y={0}
        width={viewport.width}
        height={viewport.height}
        fill={theme.colors.mapBackground}
      />
      {lines}
    </G>
  );
};

const Marker = ({
  x,
  y,
  kind,
  bearing,
  color,
  theme,
}: {
  x: number;
  y: number;
  kind: string;
  bearing?: number;
  color?: string;
  theme: ReturnType<typeof useTheme>;
}): React.JSX.Element => {
  if (kind === 'car') {
    // A rounded arrow reads as a vehicle and shows its heading at a glance.
    return (
      <G x={x} y={y} rotation={bearing ?? 0} origin={`${0}, ${0}`}>
        <Circle cx={0} cy={0} r={14} fill={theme.colors.background} opacity={0.9} />
        <Path
          d="M 0 -10 L 7 8 L 0 4 L -7 8 Z"
          fill={color ?? theme.colors.carMarker}
          stroke={theme.colors.background}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      </G>
    );
  }

  const pinColor =
    color ??
    (kind === 'pickup'
      ? theme.colors.pickupPin
      : kind === 'dropoff'
        ? theme.colors.dropoffPin
        : theme.colors.primary);

  if (kind === 'pickup') {
    // A ringed dot: "you are here", distinct from a destination pin.
    return (
      <G>
        <Circle cx={x} cy={y} r={11} fill={pinColor} opacity={0.22} />
        <Circle cx={x} cy={y} r={6} fill={pinColor} stroke={theme.colors.background} strokeWidth={2.5} />
      </G>
    );
  }

  // A teardrop pin for destinations and stops.
  return (
    <G>
      <Path
        d={`M ${x} ${y} c -7 -9 -11 -13 -11 -19 a 11 11 0 1 1 22 0 c 0 6 -4 10 -11 19 z`}
        fill={pinColor}
        stroke={theme.colors.background}
        strokeWidth={2}
      />
      <Circle cx={x} cy={y - 19} r={4} fill={theme.colors.background} />
    </G>
  );
};

/** Decode an encoded polyline into the points this renderer draws. */
export const polylineFromGeometry = (geometry: string): LatLng[] =>
  geometry ? decodePolyline(geometry) : [];

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
});
