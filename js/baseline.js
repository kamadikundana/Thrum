// Personal-baseline deviation detector, adapted from CUSUM-style
// change detection: flags a new reading when it departs from the
// user's own recent history, not a fixed population threshold.

const Baseline = (() => {
  const MIN_HISTORY_FOR_BASELINE = 3;

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  // Median and MAD (median absolute deviation) instead of mean/std: a
  // single noisy historical reading (e.g. one bad camera-PPG recording)
  // can badly skew a mean/std baseline, but barely moves a median-based
  // one. 1.4826 scales MAD to be comparable to a standard deviation
  // under a normal distribution, which is the standard convention.
  function computeStats(values) {
    const med = median(values);
    const absDeviations = values.map((v) => Math.abs(v - med));
    const mad = median(absDeviations) * 1.4826;
    return { median: med, mad };
  }

  // Evaluates a new rMSSD reading against the history of past rMSSD readings.
  // Returns { status, zScore } where status is "baseline" | "building" | "irregular".
  function evaluate(history, newRMSSD) {
    const pastValues = history.map((h) => h.rmssd).filter((v) => v != null);

    if (pastValues.length < MIN_HISTORY_FOR_BASELINE) {
      return { status: "building", zScore: null };
    }

    const { median: med, mad } = computeStats(pastValues);
    if (mad === 0) {
      return { status: "baseline", zScore: 0 };
    }

    const zScore = (newRMSSD - med) / mad;

    // A large deviation (either more erratic or unusually flat vs. personal norm)
    // is flagged, mirroring a CUSUM-style departure-from-mean test.
    const status = Math.abs(zScore) > 2 ? "irregular" : "baseline";
    return { status, zScore: Math.round(zScore * 100) / 100 };
  }

  return { evaluate, computeStats, MIN_HISTORY_FOR_BASELINE };
})();
