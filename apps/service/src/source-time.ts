/** Compare validated source instants without discarding contract-permitted fractional precision. */
export function compareSourceInstants(left: string, right: string): number {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds !== 0) return milliseconds;
  const leftFraction = left.match(/\.(\d+)/)?.[1] ?? "";
  const rightFraction = right.match(/\.(\d+)/)?.[1] ?? "";
  const precision = Math.max(leftFraction.length, rightFraction.length);
  const a = leftFraction.padEnd(precision, "0");
  const b = rightFraction.padEnd(precision, "0");
  return a < b ? -1 : a > b ? 1 : 0;
}
