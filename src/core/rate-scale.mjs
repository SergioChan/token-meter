export function rateBandFromIntensity(value) {
  const intensity = Math.min(1, Math.max(0, Number(value) || 0));
  if (intensity < 0.5) return "green";
  if (intensity < 0.7) return "yellow";
  if (intensity < 0.85) return "orange";
  return "red";
}

export function buildRateScale({
  tokensPerMinute,
  medianTokensPerMinute = 0,
  p95TokensPerMinute = 0,
}) {
  const rate = Math.max(0, Number(tokensPerMinute) || 0);
  const scale = Math.max(
    10_000,
    Number(p95TokensPerMinute) || 0,
    (Number(medianTokensPerMinute) || 0) * 3,
    rate,
  );
  const intensity = Math.min(1, rate / scale);
  return {
    intensity,
    band: rateBandFromIntensity(intensity),
    scaleTokensPerMinute: scale,
  };
}
