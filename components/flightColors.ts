/**
 * flightColors.ts
 * Shared flight path color palette used by both the Cesium globe and the logbook sidebar.
 */

export const FLIGHT_COLORS = [
  "#DEBA02",   // gold (primary)
  "#f472b6",   // pink-400
  "#a78bfa",   // violet-400
  "#38bdf8",   // sky-400
  "#fb923c",   // orange-400
  "#4ade80",   // green-400
  "#e879f9",   // fuchsia-400
  "#f87171",   // red-400
  "#facc15",   // yellow-400
  "#2dd4bf",   // teal-400
];

export function flightColor(index: number): string {
  return FLIGHT_COLORS[index % FLIGHT_COLORS.length];
}
