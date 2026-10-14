// Glue: UI wiring, capture loop, waveform drawing, trend chart.

(() => {
  const video = document.getElementById("video");
  const canvas = document.getElementById("canvas");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const statusEl = document.getElementById("status");
  const resultsSection = document.getElementById("results");
  const hrValueEl = document.getElementById("hrValue");
  const hrvValueEl = document.getElementById("hrvValue");
  const flagMessageEl = document.getElementById("flagMessage");
  const waveformCanvas = document.getElementById("waveform");
  const trendCanvas = document.getElementById("trendChart");
  const historyListEl = document.getElementById("historyList");
  const beatCountEl = document.getElementById("beatCount");
  const signalMeterEl = document.getElementById("signalMeter");
  const signalMeterFillEl = document.getElementById("signalMeterFill");
  const clearHistoryBtn = document.getElementById("clearHistoryBtn");
  const exportCsvBtn = document.getElementById("exportCsvBtn");
  const crossCheckEl = document.getElementById("crossCheck");
  const greetingDateEl = document.getElementById("greetingDate");
  const greetingHeadlineEl = document.getElementById("greetingHeadline");
  const summaryHrEl = document.getElementById("summaryHr");
  const summaryHrvEl = document.getElementById("summaryHrv");
  const summaryHrSubEl = document.getElementById("summaryHrSub");
  const summaryHrvTrendEl = document.getElementById("summaryHrvTrend");
  const hrSparklineCanvas = document.getElementById("hrSparkline");
  const hrvSparklineCanvas = document.getElementById("hrvSparkline");
  const trendsHrEl = document.getElementById("trendsHr");
  const trendsHrvEl = document.getElementById("trendsHrv");
  const trendsHrTrendEl = document.getElementById("trendsHrTrend");
  const trendsHrvTrendEl = document.getElementById("trendsHrvTrend");
  const beatMapToggleBtn = document.getElementById("beatMapToggleBtn");
  const beatMapPanel = document.getElementById("beatMapPanel");
  const beatMapListEl = document.getElementById("beatMapList");

  // Bump this when the signal-processing pipeline changes meaningfully —
  // recorded in CSV exports so an old export can be matched back to the
  // code version that produced it.
  const ALGORITHM_VERSION = "1.1.0";

  const TARGET_SAMPLE_RATE_HZ = 30; // best-effort request; actual rate is measured, not assumed
  // rMSSD computed from very few beats is a noisy statistic on its own —
  // a single remaining artifact matters a lot more when there are only
  // ~10 intervals than when there are 20+. More recording time means
  // more beats to average over, which is a real variance reduction, not
  // just another threshold to guess at.
  const RECORD_SECONDS = 30;

  let samples = [];      // raw brightness values
  let timestamps = [];   // performance.now() per sample, for the real achieved rate
  let recording = false;
  let sampleIntervalId = null;
  let lastReading = null; // populated on a successful reading, used by CSV export

  startBtn.addEventListener("click", startReading);
  stopBtn.addEventListener("click", stopReading);
  clearHistoryBtn.addEventListener("click", () => {
    if (confirm("Clear all saved readings? This can't be undone.")) {
      Storage.clear();
      renderHistory();
      statusEl.textContent = "History cleared.";
    }
  });
  exportCsvBtn.addEventListener("click", exportLastReadingCsv);
  beatMapToggleBtn.addEventListener("click", () => {
    const isHidden = beatMapPanel.hidden;
    beatMapPanel.hidden = !isHidden;
    beatMapToggleBtn.textContent = isHidden ? "Hide Beat Map" : "View Beat Map";
  });

  async function startReading() {
    try {
      await Camera.start(video, canvas);
    } catch (err) {
      statusEl.textContent = "Camera access failed: " + err.message;
      return;
    }

    samples = [];
    timestamps = [];
    lastReading = null;
    exportCsvBtn.hidden = true;
    recording = true;
    startBtn.hidden = true;
    stopBtn.hidden = false;
    resultsSection.hidden = true;
    beatCountEl.textContent = "";
    crossCheckEl.textContent = "";
    beatMapListEl.innerHTML = "";
    beatMapPanel.hidden = true;
    beatMapToggleBtn.textContent = "View Beat Map";
    signalMeterEl.hidden = false;
    statusEl.textContent = "Recording... keep your fingertip steady over the camera and flash.";

    const intervalMs = 1000 / TARGET_SAMPLE_RATE_HZ;
    sampleIntervalId = setInterval(() => {
      const value = Camera.sampleFrame();
      if (value != null) {
        samples.push(value);
        timestamps.push(performance.now());
        // Light smoothing purely for the live preview — raw camera brightness
        // is too noisy to read visually even though the analysis filter
        // (applied after recording) handles it properly.
        drawWaveform(Signal.movingAverage(samples, 4));
        updateSignalMeter();
      }
      const elapsedSeconds = timestamps.length > 1
        ? (timestamps[timestamps.length - 1] - timestamps[0]) / 1000
        : 0;
      if (elapsedSeconds >= RECORD_SECONDS) {
        stopReading();
      }
    }, intervalMs);
  }

  // Shows the raw brightness swing over the last ~2 seconds as a live
  // strength meter, so the user can fix finger placement/pressure
  // immediately instead of only finding out after the full 20s recording
  // that the signal was too weak to analyze.
  function updateSignalMeter() {
    const recent = samples.slice(-60);
    if (recent.length < 10) return;
    const swing = Math.max(...recent) - Math.min(...recent);

    // These thresholds are rough and based on observed green-channel
    // brightness swings for a finger properly covering lens+flash; treat
    // as a usability guide, not a calibrated measurement.
    const pct = Math.max(0, Math.min(100, (swing / 15) * 100));
    signalMeterFillEl.style.width = `${pct}%`;
    signalMeterFillEl.style.backgroundColor = pct < 30 ? "#ff5a5f" : pct < 60 ? "#ffb020" : "#4caf50";
  }

  function stopReading() {
    if (!recording) return;
    recording = false;
    clearInterval(sampleIntervalId);
    Camera.stop();
    startBtn.hidden = false;
    stopBtn.hidden = true;
    signalMeterEl.hidden = true;
    processSamples();
  }

  function processSamples() {
    if (samples.length < 5 || timestamps.length < 5) {
      statusEl.textContent = "Reading too short or no pulse detected. Try again.";
      return;
    }

    // Use the actually-achieved sample rate, not an assumed one — setInterval
    // and real camera frame delivery both drift from the requested rate, and
    // treating that drift as 30Hz skews every downstream HR/HRV number.
    const rateEstimateSeconds = (timestamps[timestamps.length - 1] - timestamps[0]) / 1000;
    const actualSampleRateHz = (samples.length - 1) / rateEstimateSeconds;

    // Trim the first ~1 second (camera exposure/focus still settling
    // right after Start is pressed) and the last ~0.5 second (motion as
    // the recording approaches its end — anticipating Stop, repositioning
    // the finger). Both consistently show up as artifact clusters right
    // at the edges across many test recordings. This is a fixed
    // preprocessing trim, not a rejection — it never blocks or changes
    // whether a reading is shown, just where analysis starts and ends.
    const warmupSamples = Math.round(1 * actualSampleRateHz);
    const cooldownSamples = Math.round(0.5 * actualSampleRateHz);
    if (samples.length > warmupSamples + cooldownSamples + 10) {
      samples = samples.slice(warmupSamples, samples.length - cooldownSamples);
      timestamps = timestamps.slice(warmupSamples, timestamps.length - cooldownSamples);
    }

    const totalSeconds = (timestamps[timestamps.length - 1] - timestamps[0]) / 1000;

    if (totalSeconds < 5) {
      statusEl.textContent = "Reading too short or no pulse detected. Try again.";
      return;
    }

    // Signal quality check: a finger properly covering the lens+flash produces
    // a much larger brightness swing than ambient noise or a loose finger.
    const rawMin = Math.min(...samples);
    const rawMax = Math.max(...samples);
    if (rawMax - rawMin < 2) {
      statusEl.textContent = "Signal too weak — press your fingertip fully over the camera and flash, and hold still.";
      return;
    }

    const filtered = Signal.bandpass(samples, actualSampleRateHz);
    const peaks = Signal.findPeaks(filtered, actualSampleRateHz);
    const rawRR = Signal.peaksToRRIntervals(peaks, actualSampleRateHz);
    const rr = Signal.cleanRRIntervals(rawRR);

    const hr = Signal.computeHR(rr);
    const rmssd = Signal.computeRMSSD(rr);
    const sdnn = Signal.computeSDNN(rr);

    if (!hr || !rmssd || hr < 40 || hr > 180) {
      statusEl.textContent = "Couldn't get a clear pulse signal. Try holding steadier.";
      return;
    }

    // Independent second detector, built on a different signal (steepest
    // slope, not amplitude/shape). This is a cross-check surfaced to the
    // user, not an automatic correction — agreement isn't treated as
    // proof a beat is real, and disagreement doesn't silently change the
    // primary result above.
    const slopePeaks = Signal.findPeaksBySteepestSlope(filtered, actualSampleRateHz);
    const crossCheck = Signal.compareDetectors(peaks, slopePeaks, actualSampleRateHz);

    // Always show what the algorithm actually did — the waveform with
    // detected beats, and the full interval-by-interval Beat Map — even
    // (especially) when the reading gets rejected below. "Explainable"
    // means showing your work on a bad reading too, not just a good one.
    drawFinalWaveform(filtered, peaks);
    beatCountEl.textContent = `${peaks.length} beats detected over ${totalSeconds.toFixed(1)}s`;
    crossCheckEl.textContent = crossCheck.unmatchedA === 0 && crossCheck.unmatchedB === 0
      ? `Cross-check: both detectors agree on all ${crossCheck.matched} beats.`
      : `Cross-check: primary detector found ${crossCheck.countA} beats, independent slope-based detector found ${crossCheck.countB}; ${crossCheck.matched} matched, ${crossCheck.unmatchedA} unmatched from the primary detector.`;
    renderBeatMap(rr);

    const quality = Signal.assessQuality(rr, crossCheck, peaks.length);
    if (!quality.ok) {
      resultsSection.hidden = true;
      statusEl.innerHTML =
        "This reading wasn't saved — signal quality was too low to trust:<br>" +
        quality.reasons.map((r) => `&bull; ${r}`).join("<br>") +
        "<br>Hold your finger steady over the camera and flash, then try again.";
      return;
    }

    const history = Storage.getHistory();
    const { status, zScore } = Baseline.evaluate(history, rmssd);

    showResults(hr, rmssd, status, zScore);
    Storage.addReading({ hr, rmssd, sdnn });
    renderHistory();
    statusEl.textContent = "Done. Reading saved.";

    lastReading = {
      samples,
      timestamps,
      peaks,
      sampleRateHz: actualSampleRateHz,
      hr,
      rmssd,
      recordedAt: new Date().toISOString(),
    };
    exportCsvBtn.hidden = false;
  }

  // Exports the exact raw samples the algorithm used for the last
  // reading, as a CSV plus a metadata section — for offline cross-
  // checking against an independent implementation (see
  // scripts/compare_rmssd_neurokit.py). Stays entirely client-side: a
  // Blob download, nothing sent anywhere. timestamp_ms is milliseconds
  // since THIS recording started (not a wall-clock time — performance.now()
  // has no meaningful absolute epoch), documented here so it's never
  // mistaken for one.
  function exportLastReadingCsv() {
    if (!lastReading) return;
    const { samples: sig, timestamps: ts, peaks, sampleRateHz, hr, rmssd, recordedAt } = lastReading;
    const peakSet = new Set(peaks);
    const t0 = ts[0];

    const lines = ["sample_index,timestamp_ms,raw_ppg,existing_peak"];
    for (let i = 0; i < sig.length; i++) {
      lines.push(`${i},${(ts[i] - t0).toFixed(2)},${sig[i].toFixed(4)},${peakSet.has(i) ? 1 : 0}`);
    }

    const metadata = [
      "# CardioBaseline raw signal export",
      `# recorded_at: ${recordedAt}`,
      `# algorithm_version: ${ALGORITHM_VERSION}`,
      `# recording_duration_seconds: ${((ts[ts.length - 1] - t0) / 1000).toFixed(2)}`,
      `# sample_rate_hz_actual: ${sampleRateHz.toFixed(2)}`,
      "# sample_rate_note: measured from real capture timestamps, not assumed fixed",
      `# detected_bpm: ${hr}`,
      `# detected_rmssd_ms: ${rmssd}`,
      "# timestamp_ms is relative to this recording's start, not wall-clock time",
      "",
    ].join("\n");

    const blob = new Blob([metadata + lines.join("\n") + "\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cardiobaseline_${recordedAt.replace(/[:.]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function showResults(hr, rmssd, status, zScore) {
    resultsSection.hidden = false;
    hrValueEl.textContent = hr;
    hrvValueEl.textContent = rmssd;

    flagMessageEl.classList.remove("ok");
    if (status === "building") {
      flagMessageEl.textContent = "Still learning your personal baseline — take a few more readings over different days.";
    } else if (status === "irregular") {
      flagMessageEl.textContent = `This reading looks notably different from your usual rhythm pattern (z = ${zScore}). Consider checking with a doctor.`;
    } else {
      flagMessageEl.textContent = "This reading is consistent with your usual rhythm pattern.";
      flagMessageEl.classList.add("ok");
    }
  }

  function drawWaveform(data) {
    const ctx = waveformCanvas.getContext("2d");
    const w = waveformCanvas.width;
    const h = waveformCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const recent = data.slice(-150);
    if (recent.length < 2) return;

    const min = Math.min(...recent);
    const max = Math.max(...recent);
    const range = max - min || 1;

    ctx.strokeStyle = "#791b49";
    ctx.lineWidth = 2;
    ctx.beginPath();
    recent.forEach((v, i) => {
      const x = (i / (recent.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // Draws the cleaned-up (filtered) signal with a dot on each detected
  // beat, so the waveform is readable and shows exactly what the
  // algorithm counted as a heartbeat.
  function drawFinalWaveform(filtered, peaks) {
    const ctx = waveformCanvas.getContext("2d");
    const w = waveformCanvas.width;
    const h = waveformCanvas.height;
    ctx.clearRect(0, 0, w, h);
    if (filtered.length < 2) return;

    const min = Math.min(...filtered);
    const max = Math.max(...filtered);
    const range = max - min || 1;
    const xFor = (i) => (i / (filtered.length - 1)) * w;
    const yFor = (v) => h - ((v - min) / range) * (h - 20) - 10;

    ctx.strokeStyle = "#791b49";
    ctx.lineWidth = 2;
    ctx.beginPath();
    filtered.forEach((v, i) => {
      const x = xFor(i);
      const y = yFor(v);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = "#292724";
    peaks.forEach((peakIndex) => {
      ctx.beginPath();
      ctx.arc(xFor(peakIndex), yFor(filtered[peakIndex]), 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // The "Explainable Beat Map": every detected beat-to-beat interval,
  // whether it was accepted or excluded, and why — so a rejected (or
  // just-curious) reading isn't a black box. Shown on demand, not in the
  // everyday flow, per the design goal of keeping normal capture simple.
  function renderBeatMap({ values, valid, reasons }) {
    beatMapListEl.innerHTML = "";
    if (values.length === 0) {
      beatMapListEl.innerHTML = "<li class='beat-map-empty'>Not enough beats detected to show an interval breakdown.</li>";
      return;
    }
    values.forEach((v, i) => {
      const li = document.createElement("li");
      li.className = `beat-map-row ${valid[i] ? "accepted" : "excluded"}`;
      const status = valid[i] ? "Accepted" : "Excluded";
      const reasonText = reasons[i] ? ` — ${reasons[i]}` : "";
      li.textContent = `Interval ${i + 1}: ${Math.round(v)}ms — ${status}${reasonText}`;
      beatMapListEl.appendChild(li);
    });
  }

  function renderHistory() {
    const history = Storage.getHistory();
    historyListEl.innerHTML = "";
    history
      .slice(-10)
      .reverse()
      .forEach((h) => {
        const li = document.createElement("li");
        const date = new Date(h.timestamp).toLocaleString();
        li.textContent = `${date} — HR ${h.hr} bpm, rMSSD ${h.rmssd} ms`;
        historyListEl.appendChild(li);
      });
    drawTrendChart(history);
    updateHomeSummary(history);
  }

  function updateGreeting() {
    const now = new Date();
    greetingDateEl.textContent = now.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    const hour = now.getHours();
    const timeOfDay = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    greetingHeadlineEl.textContent = `Good ${timeOfDay}.`;
  }

  function updateHomeSummary(history) {
    drawSparkline(hrSparklineCanvas, history.map((h) => h.hr), "#791b49");
    drawSparkline(hrvSparklineCanvas, history.map((h) => h.rmssd), "#6b7a5e");

    if (history.length === 0) {
      summaryHrEl.textContent = "--";
      summaryHrvEl.textContent = "--";
      summaryHrSubEl.textContent = "Take a reading to see your resting range.";
      summaryHrvTrendEl.textContent = "no trend yet";
      summaryHrvTrendEl.className = "summary-card-trend flat";
      updateTrendsSummary(history);
      return;
    }

    const latest = history[history.length - 1];
    summaryHrEl.textContent = latest.hr;
    summaryHrvEl.textContent = latest.rmssd;

    const hrValues = history.map((h) => h.hr);
    summaryHrSubEl.textContent = `Resting range ${Math.min(...hrValues)} – ${Math.max(...hrValues)}`;

    if (history.length < 2) {
      summaryHrvTrendEl.textContent = "first reading";
      summaryHrvTrendEl.className = "summary-card-trend flat";
    } else {
      const previous = history[history.length - 2];
      setTrend(summaryHrvTrendEl, latest.rmssd, previous.rmssd, "ms");
    }

    updateTrendsSummary(history);
  }

  function updateTrendsSummary(history) {
    if (history.length === 0) {
      trendsHrEl.textContent = "--";
      trendsHrvEl.textContent = "--";
      trendsHrTrendEl.textContent = "";
      trendsHrvTrendEl.textContent = "";
      return;
    }
    const latest = history[history.length - 1];
    trendsHrEl.textContent = latest.hr;
    trendsHrvEl.textContent = latest.rmssd;

    if (history.length < 2) {
      trendsHrTrendEl.textContent = "first reading";
      trendsHrvTrendEl.textContent = "first reading";
      trendsHrTrendEl.className = "list-row-trend flat";
      trendsHrvTrendEl.className = "list-row-trend flat";
      return;
    }
    const previous = history[history.length - 2];
    setTrend(trendsHrTrendEl, latest.hr, previous.hr, "bpm", "list-row-trend");
    setTrend(trendsHrvTrendEl, latest.rmssd, previous.rmssd, "ms", "list-row-trend");
  }

  function setTrend(el, current, previous, unit, baseClass = "summary-card-trend") {
    const diff = current - previous;
    if (Math.abs(diff) < 1) {
      el.textContent = "steady";
      el.className = `${baseClass} flat`;
    } else {
      el.textContent = `${diff > 0 ? "+" : ""}${diff.toFixed(0)} ${unit} vs last`;
      el.className = `${baseClass} ${diff > 0 ? "up" : "down"}`;
    }
  }

  // Tiny inline trend line — last up to 10 readings, no axes/labels, just
  // a quick-glance shape (matches the small sparklines under the Home
  // summary cards in the design reference).
  function drawSparkline(canvas, values, color) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const recent = values.slice(-10);
    if (recent.length < 2) return;

    const min = Math.min(...recent);
    const max = Math.max(...recent);
    const range = max - min || 1;
    const pad = 4;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    recent.forEach((v, i) => {
      const x = (i / (recent.length - 1)) * w;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function drawTrendChart(history) {
    const ctx = trendCanvas.getContext("2d");
    const w = trendCanvas.width;
    const h = trendCanvas.height;
    ctx.clearRect(0, 0, w, h);
    if (history.length < 2) return;

    const values = history.map((x) => x.rmssd);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    ctx.strokeStyle = "#6b7a5e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 20) - 10;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  updateGreeting();
  renderHistory();
})();
