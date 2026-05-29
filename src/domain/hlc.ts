// Hybrid Logical Clock — 64-bit: 48 bits wall clock ms | 16 bits logical counter
// Stored as a regular number (safe up to 2^53, sufficient for this use case)

let lastHLC = 0;

export function generateHLC(): number {
  const physicalMs = Date.now();
  const physicalPart = physicalMs * 65536; // << 16

  if (physicalPart > lastHLC) {
    lastHLC = physicalPart;
  } else {
    lastHLC += 1;
  }

  return lastHLC;
}

export function receiveHLC(remoteHLC: number): number {
  const localPhysical = Date.now() * 65536;
  lastHLC = Math.max(localPhysical, remoteHLC, lastHLC) + 1;
  return lastHLC;
}

export function hlcToMs(hlc: number): number {
  return Math.floor(hlc / 65536);
}
