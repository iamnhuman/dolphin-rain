/** Normalize once so render geometry and rigid-body geometry use the same frame. */
export function normalizeDolphin(source) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < source.length; i++) { const a = i % 3; min[a] = Math.min(min[a], source[i]); max[a] = Math.max(max[a], source[i]); }
  const center = min.map((value, a) => (value + max[a]) / 2);
  const longest = Math.max(...max.map((value, a) => value - min[a]));
  if (!Number.isFinite(longest) || longest <= 0) throw new Error('Invalid dolphin geometry');
  const positions = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) positions[i] = (source[i] - center[i % 3]) / longest;
  return { positions, center, scale: 1 / longest };
}

/** Six local convex sections retain the bend, nose and fins instead of a bounding box. */
export function buildDolphinParts(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) { const a = i % 3; min[a] = Math.min(min[a], positions[i]); max[a] = Math.max(max[a], positions[i]); }
  const extent = max.map((value, a) => value - min[a]);
  const axis = extent.indexOf(Math.max(...extent));
  const sections = [];
  for (let slice = 0; slice < 6; slice++) {
    const low = min[axis] + extent[axis] * slice / 6 - 0.006;
    const high = min[axis] + extent[axis] * (slice + 1) / 6 + 0.006;
    const points = new Map();
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i + axis] < low || positions[i + axis] > high) continue;
      const point = [positions[i], positions[i + 1], positions[i + 2]];
      const key = point.map((value) => Math.round(value / 0.012)).join(',');
      points.set(key, point);
    }
    const values = [...points.values()];
    if (values.length < 4) continue;
    const selected = new Set();
    for (let a = 0; a < 3; a++) {
      selected.add(values.reduce((best, point) => point[a] < best[a] ? point : best));
      selected.add(values.reduce((best, point) => point[a] > best[a] ? point : best));
    }
    const count = Math.min(values.length, 90);
    for (let i = 0; i < count; i++) selected.add(values[Math.floor(i * values.length / count)]);
    sections.push(new Float32Array([...selected].flat()));
  }
  if (!sections.length) throw new Error('Could not build dolphin colliders');
  return sections;
}
