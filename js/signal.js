// Signal processing: filtering, peak detection, HR/HRV computation.

const Signal = (() => {
  // Simple moving-average based bandpass: subtract slow trend, smooth fast noise.
  // Window sizes are specified in seconds and converted using the actual
  // sample rate, so filtering behaves consistently even if the achieved
  // capture rate drifts from the nominal target.
  function bandpass(samples, sampleRateHz, trendSeconds = 0.5, smoothSeconds = 0.1) {
    const trendWindow = Math.max(3, Math.round(trendSeconds * sampleRateHz));
    const smoothWindow = Math.max(1, Math.round(smoothSeconds * sampleRateHz));
    const trend = movingAverage(samples, trendWindow);
    const detrended = samples.map((v, i) => v - trend[i]);
    return movingAverage(detrended, smoothWindow);
  }

  function movingAverage(samples, windowSize) {
    const out = new Array(samples.length).fill(0);
    for (let i = 0; i < samples.length; i++) {
      const start = Math.max(0, i - windowSize + 1);
      let sum = 0;
      for (let j = start; j <= i; j++) sum += samples[j];
      out[i] = sum / (i - start + 1);
    }
    return out;
  }

  // Detects peak indices (heartbeats) in a filtered signal using a
  // multi-scale local-maximum test.
  //
  // The core idea: a genuine heartbeat is the TALLEST feature in its
  // neighborhood, so it stays a local maximum even when you widen the
  // comparison window quite far on either side. The dicrotic notch (the
  // smaller secondary bump after a beat) is only a local max in a narrow
  // window — widen it even slightly and the taller main beat right next
  // to it wins the comparison. Each candidate's "scale" (how far the
  // window can widen before it stops being a local max) is its evidence
  // score; real beats have a high score, notches and noise don't. This
  // doesn't depend on a single fixed amplitude threshold at all, which is
  // what kept breaking on this signal's amplitude drift over a recording.
  // maxBpm caps how close two accepted beats are allowed to be. This app
  // is a resting screening aid, not an exercise tracker, so 120bpm is a
  // reasonable ceiling — and tightening it directly rejects the repeated
  // failure pattern seen in testing, where a weak-signal stretch produces
  // a burst of small ripples spaced at roughly HALF the real beat
  // interval (i.e. close to double the real rate), which a looser cap
  // was letting through as if they were genuinely fast beats.
  function findPeaks(filtered, sampleRateHz, minBpm = 40, maxBpm = 120) {
    const minDistance = Math.floor((60 / maxBpm) * sampleRateHz);
    const maxScale = Math.max(4, minDistance); // widen up to ~one minimum beat-spacing

    const scored = [];
    for (let i = maxScale; i < filtered.length - maxScale; i++) {
      let scale = 0;
      for (let k = 1; k <= maxScale; k++) {
        if (filtered[i] > filtered[i - k] && filtered[i] > filtered[i + k]) {
          scale = k;
        } else {
          break; // once it stops being a local max at this width, larger widths won't pass either
        }
      }
      if (scale > 0) scored.push({ i, scale });
    }

    // Keep only candidates that held up as a local max across most of the
    // tested range — the ones a notch or small noise bump can't reach.
    const minPersistence = Math.round(maxScale * 0.6);
    const persistent = scored.filter((c) => c.scale >= minPersistence).map((c) => c.i);

    // The multi-scale test is purely relative/local, so it has no floor:
    // in a quiet stretch with little real pulsatile signal (e.g. right
    // after a motion artifact, before the pulse "re-establishes"), even
    // small noise ripples can be the locally-tallest thing around and
    // pass the test, generating a burst of fake beats.
    //
    // A single recording-wide standard deviation is a poor yardstick for
    // this, though: one big artifact spike skews it unpredictably, making
    // the floor too strict or too lenient depending on the rest of the
    // signal.
    //
    // Using "persistence" (how certain a candidate is) to pick the
    // reference doesn't work either: the multi-scale test is purely
    // relative to each candidate's OWN neighborhood, so a tiny noise
    // ripple sitting in an otherwise flat, quiet stretch can reach full
    // persistence just as easily as a genuinely tall beat — persistence
    // says nothing about absolute size. So instead: measure amplitude for
    // every persistent candidate, then take the reference from the
    // TALLEST half of them specifically. Real heartbeats should dominate
    // the top of that ranking by actual height, even if a cluster of
    // small-but-locally-persistent ripples is mixed in elsewhere.
    const amplitudeOf = (i) => {
      const troughStart = Math.max(0, i - minDistance);
      const precedingTrough = Math.min(...filtered.slice(troughStart, i + 1));
      return filtered[i] - precedingTrough;
    };

    const byAmplitudeDesc = persistent
      .map((i) => ({ i, amp: amplitudeOf(i) }))
      .sort((a, b) => b.amp - a.amp);
    const topHalf = byAmplitudeDesc.slice(0, Math.max(1, Math.ceil(byAmplitudeDesc.length / 2)));
    const referenceAmplitude = topHalf.length > 0
      ? topHalf[Math.floor(topHalf.length / 2)].amp // median of the taller half
      : 0;
    const amplitudeFloor = referenceAmplitude * 0.4;

    const afterAmplitudeFloor = amplitudeFloor > 0
      ? persistent.filter((i) => amplitudeOf(i) >= amplitudeFloor)
      : persistent; // no usable candidates at all — fall back to persistence alone

    // Shape check: everything so far judges a candidate by its HEIGHT
    // (persistence, amplitude), but a tall, well-timed noise spike can
    // still slip through those. A real heartbeat has a distinctive
    // overall shape — a fast rise and a slower fall — that a noise bump
    // usually doesn't share. Build a template from the most confident
    // candidates' own waveform shapes (normalized so only SHAPE matters,
    // not height or baseline), then require every candidate's own shape
    // to actually resemble that template.
    const candidates = shapeFilterPeaks(filtered, afterAmplitudeFloor, byAmplitudeDesc, minDistance);

    // Among any candidates still close together, keep the tallest (same
    // non-max-suppression idea as before, now as a final cleanup rather
    // than the primary filter).
    candidates.sort((a, b) => filtered[b] - filtered[a]);
    const accepted = [];
    for (const i of candidates) {
      const tooClose = accepted.some((j) => Math.abs(i - j) < minDistance);
      if (!tooClose) accepted.push(i);
    }
    return accepted.sort((a, b) => a - b);
  }

  // Extracts a fixed-width, amplitude-normalized window around a peak —
  // only the SHAPE of the waveform there, not its height or baseline
  // level, so two beats of different sizes can still be compared fairly.
  function extractNormalizedShape(filtered, peakIndex, halfWidth) {
    const start = peakIndex - halfWidth;
    const end = peakIndex + halfWidth;
    if (start < 0 || end >= filtered.length) return null;

    const segment = filtered.slice(start, end + 1);
    const mean = segment.reduce((a, b) => a + b, 0) / segment.length;
    const variance = segment.reduce((sum, v) => sum + (v - mean) ** 2, 0) / segment.length;
    const std = Math.sqrt(variance);
    if (std === 0) return null;
    return segment.map((v) => (v - mean) / std);
  }

  // Pearson correlation between two equal-length arrays — how similar
  // their shapes are, regardless of each one's own scale.
  function correlation(a, b) {
    const n = a.length;
    const meanA = a.reduce((s, v) => s + v, 0) / n;
    const meanB = b.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let denomA = 0;
    let denomB = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - meanA;
      const db = b[i] - meanB;
      num += da * db;
      denomA += da * da;
      denomB += db * db;
    }
    const denom = Math.sqrt(denomA * denomB);
    return denom === 0 ? 0 : num / denom;
  }

  function shapeFilterPeaks(filtered, afterAmplitudeFloor, byAmplitudeDesc, minDistance) {
    const halfWidth = Math.max(3, Math.round(minDistance * 0.4));

    // Build the template from only the tallest, most-trusted candidates —
    // the same set already used for the amplitude reference — so a
    // cluster of noise ripples elsewhere can't influence what "a real
    // beat looks like" here either.
    const trustedCount = Math.max(1, Math.ceil(byAmplitudeDesc.length / 2));
    const trusted = byAmplitudeDesc.slice(0, trustedCount).map((c) => c.i);
    const trustedShapes = trusted
      .map((i) => extractNormalizedShape(filtered, i, halfWidth))
      .filter((s) => s != null);

    if (trustedShapes.length < 2) return afterAmplitudeFloor; // not enough to build a reliable template

    const templateLength = trustedShapes[0].length;
    const template = new Array(templateLength).fill(0);
    for (const shape of trustedShapes) {
      for (let i = 0; i < templateLength; i++) template[i] += shape[i] / trustedShapes.length;
    }

    const minCorrelation = 0.5;
    return afterAmplitudeFloor.filter((i) => {
      const shape = extractNormalizedShape(filtered, i, halfWidth);
      if (shape == null) return true; // too close to the recording's edge to judge — don't penalize it
      return correlation(shape, template) >= minCorrelation;
    });
  }

  // An INDEPENDENT second beat detector, deliberately built on a
  // different signal than findPeaks: instead of judging amplitude,
  // persistence, or shape, this looks for the steepest POSITIVE SLOPE in
  // the waveform — the point where the signal is rising fastest, which
  // for a real pulse is the upstroke just before the systolic peak. This
  // is a different family of detector (slope-based rather than
  // extremum-based), so the two methods are unlikely to share the same
  // failure modes — if they agree on a beat, that's two unrelated ways of
  // looking at the signal reaching the same conclusion; if they disagree,
  // that interval is genuinely uncertain rather than confidently wrong.
  function findPeaksBySteepestSlope(filtered, sampleRateHz, minBpm = 40, maxBpm = 120) {
    const minDistance = Math.floor((60 / maxBpm) * sampleRateHz);

    // Slope Sum Function (SSF): instead of the raw point-to-point
    // derivative (noisy — any single-sample jitter creates a spurious
    // local max), accumulate the positive part of the derivative over a
    // short rolling window (~0.1s). This is the standard way slope-based
    // beat detectors (e.g. Jang et al.'s PPG/ECG onset detector) smooth
    // the derivative signal before thresholding it, and it directly
    // reduces false candidates from single-sample noise without
    // softening a genuine upstroke, since a real beat's rise is spread
    // across several samples and keeps accumulating through the window.
    const diff = new Array(filtered.length).fill(0);
    for (let i = 1; i < filtered.length; i++) diff[i] = Math.max(0, filtered[i] - filtered[i - 1]);

    const ssfWindow = Math.max(1, Math.round(0.1 * sampleRateHz));
    const slope = new Array(filtered.length).fill(0);
    for (let i = 0; i < filtered.length; i++) {
      const start = Math.max(0, i - ssfWindow + 1);
      let sum = 0;
      for (let j = start; j <= i; j++) sum += diff[j];
      slope[i] = sum;
    }

    // A single global threshold (e.g. mean + 1 std across the whole
    // recording) fails whenever the signal's amplitude varies across the
    // recording — a real, strong upstroke in a quiet stretch can be
    // smaller than the global bar, while noise in a loud stretch can
    // exceed it. This is the same amplitude-drift problem findPeaks had
    // to work around; the fix here is the same idea: judge each
    // candidate against the steepest slope in a local window around it
    // (~1s), not one number for the entire recording.
    const windowSize = Math.round(sampleRateHz);
    const localSlopeThreshold = (i) => {
      const start = Math.max(0, i - windowSize);
      const end = Math.min(slope.length - 1, i + windowSize);
      let localMax = -Infinity;
      for (let j = start; j <= end; j++) {
        if (slope[j] > localMax) localMax = slope[j];
      }
      return localMax * 0.4; // at least 40% of the steepest rise nearby
    };

    const localCandidates = [];
    for (let i = 1; i < slope.length - 1; i++) {
      const isLocalMax = slope[i] > slope[i - 1] && slope[i] >= slope[i + 1];
      if (isLocalMax && slope[i] > 0 && slope[i] > localSlopeThreshold(i)) {
        localCandidates.push(i);
      }
    }

    // The local-window test alone has no absolute floor, so it can still
    // pick up a dicrotic notch's own (smaller) upstroke as a separate
    // "steep rise" — the same over-detection failure mode findPeaks had.
    // Same fix: measure a reference from the top half of candidates by
    // actual slope magnitude, require everything to clear a fraction of
    // that reference. A notch's upstroke is real but reliably smaller
    // than the main beat's upstroke right next to it, so this should
    // separate them without needing a global or purely local cutoff.
    const byMagnitudeDesc = [...localCandidates].sort((a, b) => slope[b] - slope[a]);
    const topHalf = byMagnitudeDesc.slice(0, Math.max(1, Math.ceil(byMagnitudeDesc.length / 2)));
    const referenceSlope = topHalf.length > 0
      ? slope[topHalf[Math.floor(topHalf.length / 2)]] // median of the steepest half
      : 0;
    const magnitudeFloor = referenceSlope * 0.4;

    const candidates = magnitudeFloor > 0
      ? localCandidates.filter((i) => slope[i] >= magnitudeFloor)
      : localCandidates;

    candidates.sort((a, b) => slope[b] - slope[a]); // steepest first
    const accepted = [];
    for (const i of candidates) {
      const tooClose = accepted.some((j) => Math.abs(i - j) < minDistance);
      if (!tooClose) accepted.push(i);
    }
    return accepted.sort((a, b) => a - b);
  }

  // Compares two independently-detected beat lists and reports where they
  // agree or disagree — informational only. This never changes what the
  // primary detector (findPeaks) produced; it's a cross-check surfaced to
  // the user, not an automatic correction. Matching allows a time
  // tolerance, since a slope-based detector naturally fires earlier than
  // an extremum-based one (the upstroke precedes the peak), and our
  // bandpass filter's 0.5s trend-removal window adds its own smoothing
  // delay on top of that — 300ms covers both without being so wide it
  // risks matching across two genuinely different beats.
  function compareDetectors(peaksA, peaksB, sampleRateHz, toleranceMs = 300) {
    const toleranceSamples = (toleranceMs / 1000) * sampleRateHz;
    let matched = 0;
    const usedB = new Set();
    for (const a of peaksA) {
      let found = false;
      for (const b of peaksB) {
        if (usedB.has(b)) continue;
        if (Math.abs(a - b) <= toleranceSamples) {
          usedB.add(b);
          found = true;
          break;
        }
      }
      if (found) matched++;
    }
    return {
      countA: peaksA.length,
      countB: peaksB.length,
      matched,
      unmatchedA: peaksA.length - matched,
      unmatchedB: peaksB.length - matched,
    };
  }

  // Converts peak sample indices into RR intervals (ms).
  function peaksToRRIntervals(peaks, sampleRateHz) {
    const rr = [];
    for (let i = 1; i < peaks.length; i++) {
      const samples = peaks[i] - peaks[i - 1];
      rr.push((samples / sampleRateHz) * 1000);
    }
    return rr;
  }

  // Interquartile range of a numeric array — a spread measure like
  // standard deviation, but resistant to outliers skewing it (a handful
  // of bad intervals barely move Q1/Q3, whereas they can swing a mean or
  // a standard deviation a lot).
  function interquartileRange(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const q = (p) => {
      const pos = p * (sorted.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.ceil(pos);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    };
    return q(0.75) - q(0.25);
  }

  // Removes individual RR intervals that are physiologically implausible
  // or wildly different from their surroundings (a motion-artifact spike,
  // a missed/extra beat) before HR/HRV is computed from them. This never
  // rejects the overall reading — it just stops a bad beat from blowing
  // up rMSSD/SDNN, which are both very sensitive to exactly this kind of
  // single-interval outlier.
  //
  // Two things make this more robust than a flat "reject if >X% off":
  //  1. Each interval is compared to a WINDOW of several surrounding
  //     intervals (not just its 1 immediate neighbor each side) — a
  //     single artifact often corrupts two adjacent intervals at once
  //     (one too short, the next too long), and those two can look
  //     "normal" relative to each other even though both are wrong. A
  //     wider window still has mostly good values in it.
  //  2. The rejection threshold itself SCALES with that window's own
  //     spread (interquartile range) instead of being a fixed fraction.
  //     Someone with naturally more beat-to-beat variability won't have
  //     every real reading flagged as artifacts, and someone with a very
  //     steady rhythm gets a tighter, more sensitive check — the bar
  //     adapts to what's normal for that stretch of the recording.
  // Returns { values, valid }: the RR series unchanged in position, plus a
  // same-length boolean mask of which intervals are trustworthy. Marking
  // in place instead of deleting matters specifically for rMSSD: rMSSD is
  // defined on SUCCESSIVE (back-to-back) differences, so if a bad interval
  // were simply deleted and the remaining ones concatenated, the two
  // intervals that used to sit on either side of it would suddenly be
  // compared to each other as if they were adjacent beats — even though
  // they never actually followed one another. That silently manufactures
  // a new successive-difference term that doesn't correspond to any real
  // beat-to-beat transition. Keeping the mask lets computeRMSSD skip over
  // that gap entirely instead of papering over it.
  function cleanRRIntervals(rrIntervalsMs, thresholdFactor = 3.5, windowRadius = 3) {
    const minRR = 333; // 180 bpm
    const maxRR = 1500; // 40 bpm
    const n = rrIntervalsMs.length;
    const valid = rrIntervalsMs.map((v) => v >= minRR && v <= maxRR);
    // Parallel array: why each interval was excluded, for anyone (the UI,
    // a future researcher) who wants to know, not just that it was.
    const reasons = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (!valid[i]) {
        reasons[i] = rrIntervalsMs[i] < minRR
          ? "Faster than physiologically plausible (possible extra/duplicate beat)"
          : "Slower than physiologically plausible (possible missed beat)";
      }
    }

    for (let i = 0; i < n; i++) {
      if (!valid[i]) continue;

      const neighbors = [];
      for (let j = Math.max(0, i - windowRadius); j <= Math.min(n - 1, i + windowRadius); j++) {
        if (j !== i && valid[j]) neighbors.push(rrIntervalsMs[j]);
      }
      if (neighbors.length < 3) continue; // too few for a meaningful local spread estimate

      const sorted = [...neighbors].sort((a, b) => a - b);
      const localMedian = sorted[Math.floor(sorted.length / 2)];
      const iqr = interquartileRange(neighbors);

      // A near-zero IQR means the local window is extremely steady, so
      // even a small absolute gap matters; floor it relative to the
      // median so the check doesn't become impossibly strict.
      const spread = Math.max(iqr, localMedian * 0.02);
      const deviation = Math.abs(rrIntervalsMs[i] - localMedian) / spread;

      if (deviation > thresholdFactor) {
        valid[i] = false;
        reasons[i] = `Deviates from the surrounding rhythm by ${deviation.toFixed(1)}x the local variability`;
      }
    }

    const validCount = valid.filter(Boolean).length;
    // If cleanup removed almost everything (very short/bad recording),
    // fall back to plausibility-only so there's still something to show.
    if (validCount < 2) {
      const fallbackValid = rrIntervalsMs.map((v) => v >= minRR && v <= maxRR);
      return { values: rrIntervalsMs, valid: fallbackValid, reasons };
    }
    return { values: rrIntervalsMs, valid, reasons };
  }

  // Judges whether a reading's underlying data is trustworthy enough to
  // show as a real result, using criteria that are each independently
  // checkable (not one opaque score): how many beat intervals survived
  // artifact correction, how well the two independent detectors agreed,
  // and whether there were even enough beats to say anything meaningful.
  // Thresholds are deliberately lenient — the goal is to catch recordings
  // that are CLEARLY too degraded to trust, not to reject every reading
  // with a little noise (real rhythms have real variability too).
  function assessQuality({ valid }, crossCheck, rawPeakCount) {
    const reasons = [];

    if (rawPeakCount < 8) {
      reasons.push(`Only ${rawPeakCount} beats detected — too few for a reliable reading.`);
    }

    const validCount = valid.filter(Boolean).length;
    const validRatio = valid.length > 0 ? validCount / valid.length : 0;
    if (valid.length > 0 && validRatio < 0.7) {
      reasons.push(
        `Only ${validCount} of ${valid.length} beat-to-beat intervals passed artifact checks (${Math.round(validRatio * 100)}%).`
      );
    }

    if (crossCheck && crossCheck.countA > 0) {
      const agreementRatio = crossCheck.matched / crossCheck.countA;
      if (agreementRatio < 0.6) {
        reasons.push(
          `The two independent beat detectors only agreed on ${crossCheck.matched} of ${crossCheck.countA} beats (${Math.round(agreementRatio * 100)}%).`
        );
      }
    }

    return { ok: reasons.length === 0, reasons };
  }

  // Pulls out just the valid values — fine for HR/SDNN, which don't care
  // about adjacency, only about which individual intervals are trustworthy.
  function validValues({ values, valid }) {
    return values.filter((_, i) => valid[i]);
  }

  function computeHR(cleaned) {
    const vals = validValues(cleaned);
    if (vals.length === 0) return null;
    const meanRR = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.round(60000 / meanRR);
  }

  // SDNN: standard deviation of RR intervals — a standard HRV metric.
  function computeSDNN(cleaned) {
    const vals = validValues(cleaned);
    if (vals.length < 2) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (vals.length - 1);
    return Math.round(Math.sqrt(variance));
  }

  // rMSSD: root mean square of successive RR differences — captures
  // beat-to-beat irregularity. Unlike HR/SDNN, this MUST only compare
  // intervals that are genuinely back-to-back in the original recording —
  // see the comment on cleanRRIntervals for why skipping a removed
  // interval's gap (rather than silently closing it) matters here.
  function computeRMSSD({ values, valid }) {
    let sumSq = 0;
    let count = 0;
    for (let i = 1; i < values.length; i++) {
      if (valid[i] && valid[i - 1]) {
        sumSq += (values[i] - values[i - 1]) ** 2;
        count++;
      }
    }
    if (count === 0) return null;
    return Math.round(Math.sqrt(sumSq / count));
  }

  const Signal = {
    bandpass,
    movingAverage,
    findPeaks,
    findPeaksBySteepestSlope,
    compareDetectors,
    peaksToRRIntervals,
    cleanRRIntervals,
    assessQuality,
    computeHR,
    computeSDNN,
    computeRMSSD,
  };

  // Exposes this module to Node for the test suite (tests/signal.test.js),
  // without affecting the browser, where `module` doesn't exist.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Signal;
  }

  return Signal;
})();
