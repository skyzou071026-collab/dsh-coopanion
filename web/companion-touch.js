/** Growth needs a real stroke in the trusted page; a sandbox's touch claim alone is insufficient. */
export function createCompanionStroke() {
  let previous, distance = 0, lastAt = 0, cooldown = -Infinity;
  return {
    reset() { previous = undefined; distance = 0; lastAt = 0; },
    move(point, { trusted, over, pressing, now }) {
      if (!trusted || !over || pressing || !Number.isFinite(now)) { previous = undefined; distance = 0; return false; }
      distance *= Math.exp(-Math.max(0, now - lastAt) / 1000 * 1.5); lastAt = now;
      if (previous) distance += Math.min(80, Math.hypot(point.x - previous.x, point.y - previous.y));
      previous = point;
      if (distance <= 320 || now < cooldown) return false;
      distance = 0; cooldown = now + 2500; return true;
    },
  };
}
