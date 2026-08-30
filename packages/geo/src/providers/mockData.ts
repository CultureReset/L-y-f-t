/**
 * The mock provider's world: a seed set of real San Francisco places plus the
 * street-name vocabulary used to synthesise plausible addresses anywhere else.
 *
 * Replace this file to move the sandbox to a different city. Nothing about the
 * provider's logic depends on these particular coordinates.
 */

import type { LatLng, PlaceCategory } from '@lift/core';

export interface SeedPlace {
  readonly name: string;
  readonly address: string;
  readonly coordinates: LatLng;
  readonly category: PlaceCategory;
  /** Curbside meeting point when the entrance is not where the pin sits. */
  readonly pickupHint?: { readonly coordinates: LatLng; readonly label: string };
  /** Extra search terms that should match this place. */
  readonly aliases?: readonly string[];
}

export const SEED_PLACES: readonly SeedPlace[] = [
  {
    name: 'Ferry Building',
    address: '1 Ferry Building, San Francisco, CA 94111',
    coordinates: { lat: 37.7955, lng: -122.3937 },
    category: 'venue',
    aliases: ['ferry', 'embarcadero market'],
  },
  {
    name: 'Mission Dolores Park',
    address: 'Dolores St & 19th St, San Francisco, CA 94114',
    coordinates: { lat: 37.7596, lng: -122.4269 },
    category: 'venue',
    aliases: ['dolores park', 'mission park'],
  },
  {
    name: 'San Francisco International Airport',
    address: 'SFO, San Francisco, CA 94128',
    coordinates: { lat: 37.6213, lng: -122.379 },
    category: 'airport',
    pickupHint: {
      coordinates: { lat: 37.6161, lng: -122.3853 },
      label: 'Terminal 1 · Rideshare pickup, Level 5',
    },
    aliases: ['sfo', 'airport'],
  },
  {
    name: 'Oracle Park',
    address: '24 Willie Mays Plaza, San Francisco, CA 94107',
    coordinates: { lat: 37.7786, lng: -122.3893 },
    category: 'venue',
    pickupHint: {
      coordinates: { lat: 37.7801, lng: -122.3906 },
      label: 'Rideshare zone · 2nd & King',
    },
    aliases: ['giants', 'ballpark', 'baseball'],
  },
  {
    name: 'Golden Gate Park',
    address: '501 Stanyan St, San Francisco, CA 94117',
    coordinates: { lat: 37.7694, lng: -122.4862 },
    category: 'venue',
    aliases: ['ggp', 'the park'],
  },
  {
    name: 'Chase Center',
    address: '1 Warriors Way, San Francisco, CA 94158',
    coordinates: { lat: 37.7680, lng: -122.3877 },
    category: 'venue',
    pickupHint: {
      coordinates: { lat: 37.7671, lng: -122.3892 },
      label: 'Rideshare lot · South St',
    },
    aliases: ['warriors', 'arena'],
  },
  {
    name: 'Salesforce Transit Center',
    address: '425 Mission St, San Francisco, CA 94105',
    coordinates: { lat: 37.7896, lng: -122.3968 },
    category: 'transit',
    aliases: ['transbay', 'bus terminal'],
  },
  {
    name: 'Powell Street Station',
    address: '899 Market St, San Francisco, CA 94102',
    coordinates: { lat: 37.7845, lng: -122.4079 },
    category: 'transit',
    aliases: ['bart', 'powell'],
  },
  {
    name: 'Coit Tower',
    address: '1 Telegraph Hill Blvd, San Francisco, CA 94133',
    coordinates: { lat: 37.8024, lng: -122.4058 },
    category: 'venue',
    aliases: ['telegraph hill'],
  },
  {
    name: 'Palace of Fine Arts',
    address: '3601 Lyon St, San Francisco, CA 94123',
    coordinates: { lat: 37.8029, lng: -122.4484 },
    category: 'venue',
  },
  {
    name: 'Chinatown — Dragon Gate',
    address: 'Grant Ave & Bush St, San Francisco, CA 94108',
    coordinates: { lat: 37.7908, lng: -122.4056 },
    category: 'venue',
    aliases: ['chinatown'],
  },
  {
    name: 'Zuckerberg San Francisco General Hospital',
    address: '1001 Potrero Ave, San Francisco, CA 94110',
    coordinates: { lat: 37.7555, lng: -122.4053 },
    category: 'hospital',
    aliases: ['sf general', 'hospital'],
  },
  {
    name: 'Westfield San Francisco Centre',
    address: '865 Market St, San Francisco, CA 94103',
    coordinates: { lat: 37.7841, lng: -122.4077 },
    category: 'shopping',
    aliases: ['westfield', 'mall'],
  },
  {
    name: 'Fairmont San Francisco',
    address: '950 Mason St, San Francisco, CA 94108',
    coordinates: { lat: 37.7924, lng: -122.4102 },
    category: 'hotel',
    aliases: ['nob hill hotel'],
  },
  {
    name: 'Tartine Bakery',
    address: '600 Guerrero St, San Francisco, CA 94110',
    coordinates: { lat: 37.7614, lng: -122.4241 },
    category: 'restaurant',
    aliases: ['bakery', 'tartine'],
  },
  {
    name: 'The Castro Theatre',
    address: '429 Castro St, San Francisco, CA 94114',
    coordinates: { lat: 37.7609, lng: -122.435 },
    category: 'venue',
    aliases: ['castro'],
  },
  {
    name: 'Fisherman’s Wharf',
    address: 'Jefferson St, San Francisco, CA 94133',
    coordinates: { lat: 37.808, lng: -122.4177 },
    category: 'venue',
    aliases: ['pier 39', 'wharf'],
  },
  {
    name: 'Twin Peaks',
    address: '501 Twin Peaks Blvd, San Francisco, CA 94114',
    coordinates: { lat: 37.7544, lng: -122.4477 },
    category: 'venue',
  },
  {
    name: 'Presidio Main Post',
    address: '210 Lincoln Blvd, San Francisco, CA 94129',
    coordinates: { lat: 37.7989, lng: -122.4662 },
    category: 'venue',
    aliases: ['presidio'],
  },
  {
    name: 'Caltrain — 4th & King',
    address: '700 4th St, San Francisco, CA 94107',
    coordinates: { lat: 37.7766, lng: -122.3947 },
    category: 'transit',
    aliases: ['caltrain', 'train station'],
  },
];

/** Street names used to synthesise addresses for arbitrary coordinates. */
export const STREET_NAMES: readonly string[] = [
  'Market St', 'Mission St', 'Valencia St', 'Folsom St', 'Howard St',
  'Bryant St', 'Harrison St', 'Guerrero St', 'Dolores St', 'Church St',
  'Castro St', 'Divisadero St', 'Fillmore St', 'Van Ness Ave', 'Polk St',
  'Hyde St', 'Larkin St', 'Geary Blvd', 'Clement St', 'Irving St',
  'Judah St', 'Noriega St', 'Taraval St', 'Sloat Blvd', 'Portola Dr',
  'Columbus Ave', 'Grant Ave', 'Stockton St', 'Powell St', 'Montgomery St',
  'Battery St', 'Sansome St', 'Kearny St', 'Bush St', 'Pine St',
  'California St', 'Sacramento St', 'Clay St', 'Washington St', 'Jackson St',
  'Pacific Ave', 'Broadway', 'Vallejo St', 'Green St', 'Union St',
  'Filbert St', 'Greenwich St', 'Lombard St', 'Chestnut St', 'Bay St',
];

export const NEIGHBORHOODS: readonly { name: string; center: LatLng }[] = [
  { name: 'Mission District', center: { lat: 37.7599, lng: -122.4148 } },
  { name: 'SoMa', center: { lat: 37.7785, lng: -122.4056 } },
  { name: 'Financial District', center: { lat: 37.7946, lng: -122.3999 } },
  { name: 'Nob Hill', center: { lat: 37.7930, lng: -122.4161 } },
  { name: 'North Beach', center: { lat: 37.8003, lng: -122.4103 } },
  { name: 'Marina', center: { lat: 37.8021, lng: -122.4369 } },
  { name: 'Haight-Ashbury', center: { lat: 37.7692, lng: -122.4481 } },
  { name: 'Castro', center: { lat: 37.7609, lng: -122.4350 } },
  { name: 'Sunset', center: { lat: 37.7522, lng: -122.4841 } },
  { name: 'Richmond', center: { lat: 37.7802, lng: -122.4644 } },
  { name: 'Potrero Hill', center: { lat: 37.7576, lng: -122.4004 } },
  { name: 'Dogpatch', center: { lat: 37.7576, lng: -122.3893 } },
  { name: 'Bayview', center: { lat: 37.7299, lng: -122.3907 } },
  { name: 'Bernal Heights', center: { lat: 37.7399, lng: -122.4148 } },
  { name: 'Pacific Heights', center: { lat: 37.7925, lng: -122.4382 } },
];

/** Postal codes, picked by proximity so a synthesised address looks right. */
export const ZIP_ANCHORS: readonly { zip: string; center: LatLng }[] = [
  { zip: '94102', center: { lat: 37.7793, lng: -122.4193 } },
  { zip: '94103', center: { lat: 37.7726, lng: -122.4113 } },
  { zip: '94105', center: { lat: 37.7898, lng: -122.3942 } },
  { zip: '94107', center: { lat: 37.7621, lng: -122.3971 } },
  { zip: '94108', center: { lat: 37.7920, lng: -122.4079 } },
  { zip: '94109', center: { lat: 37.7930, lng: -122.4222 } },
  { zip: '94110', center: { lat: 37.7485, lng: -122.4156 } },
  { zip: '94111', center: { lat: 37.7981, lng: -122.3994 } },
  { zip: '94114', center: { lat: 37.7583, lng: -122.4350 } },
  { zip: '94115', center: { lat: 37.7857, lng: -122.4370 } },
  { zip: '94117', center: { lat: 37.7714, lng: -122.4429 } },
  { zip: '94118', center: { lat: 37.7808, lng: -122.4609 } },
  { zip: '94121', center: { lat: 37.7786, lng: -122.4923 } },
  { zip: '94122', center: { lat: 37.7596, lng: -122.4846 } },
  { zip: '94123', center: { lat: 37.8000, lng: -122.4363 } },
  { zip: '94124', center: { lat: 37.7312, lng: -122.3826 } },
  { zip: '94131', center: { lat: 37.7452, lng: -122.4419 } },
  { zip: '94133', center: { lat: 37.8015, lng: -122.4104 } },
  { zip: '94158', center: { lat: 37.7706, lng: -122.3893 } },
];
