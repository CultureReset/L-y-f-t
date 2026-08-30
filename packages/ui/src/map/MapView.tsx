/**
 * The map component every screen uses.
 *
 * It delegates to whichever renderer is registered. The built-in SVG canvas is
 * the default; a deployment with a Google or Mapbox key registers that
 * renderer once at startup and every map screen changes with it.
 */

import React, { createContext, useContext, type ReactNode } from 'react';
import { MapCanvas } from './MapCanvas.js';
import type { MapProps, MapRenderer } from './types.js';

const MapRendererContext = createContext<MapRenderer>(MapCanvas as MapRenderer);

export interface MapRendererProviderProps {
  readonly renderer: MapRenderer;
  readonly children: ReactNode;
}

/**
 * Register a map renderer for the subtree.
 *
 * ```tsx
 * <MapRendererProvider renderer={GoogleMapRenderer}>
 *   <App />
 * </MapRendererProvider>
 * ```
 */
export const MapRendererProvider = ({
  renderer,
  children,
}: MapRendererProviderProps): React.JSX.Element => (
  <MapRendererContext.Provider value={renderer}>{children}</MapRendererContext.Provider>
);

export const useMapRenderer = (): MapRenderer => useContext(MapRendererContext);

export const MapView = (props: MapProps): React.JSX.Element => {
  const renderer = useMapRenderer();
  return <>{renderer(props)}</>;
};
