export const SESSION_TOKEN_BUCKET_MAXIMA = Object.freeze([
  1_000,
  10_000,
  100_000,
  1_000_000,
  10_000_000,
  100_000_000,
  1_000_000_000,
  Number.MAX_SAFE_INTEGER,
]);

export function sessionTokenHistogram(values) {
  const histogram = Array(SESSION_TOKEN_BUCKET_MAXIMA.length).fill(0);
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("session token totals must be non-negative safe integers");
    }
    const index = SESSION_TOKEN_BUCKET_MAXIMA.findIndex((maximum) => value <= maximum);
    histogram[index < 0 ? histogram.length - 1 : index] += 1;
  }
  return histogram;
}

export function approximateMedianFromHistogram(histogram) {
  const count = histogram.reduce((total, value) => total + value, 0);
  if (count === 0) return 0;
  const target = Math.floor(count / 2) + 1;
  let seen = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    seen += histogram[index];
    if (seen >= target) return SESSION_TOKEN_BUCKET_MAXIMA[index];
  }
  return SESSION_TOKEN_BUCKET_MAXIMA.at(-1);
}
