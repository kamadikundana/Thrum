# Thrum

Camera-based heart rhythm screening aid ("Your rhythm, understood."). Uses
the phone camera + flash to measure pulse (PPG), computes heart rate and
HRV (rMSSD/SDNN), and flags readings that deviate from the user's own
personal baseline — not a fixed population threshold. It also knows when
its own measurement isn't trustworthy enough to show: readings that fail
a signal-quality check are withheld with a specific explanation, rather
than displayed as if they were reliable.

**Not a medical device.** Screening aid only; always consult a doctor.

## How it works

1. `js/camera.js` — captures camera frames, samples average green-channel
   brightness (the PPG signal), enables torch/flash if available.
2. `js/signal.js` — filters the raw signal, detects heartbeats (peaks),
   computes RR intervals, HR, SDNN, rMSSD. Peak detection is a hand-written
   multi-scale local-maximum detector: a candidate beat is scored by how
   far its surrounding comparison window can widen before it stops being
   the tallest point nearby, which separates real beats from smaller
   secondary bumps without relying on a single fixed amplitude threshold.
   A second, independent detector (steepest-upslope based) runs alongside
   it purely as a cross-check — the two methods are compared and shown to
   the user, but agreement is never treated as proof a beat is correct,
   and the primary detector's output is never silently altered based on
   the comparison.
   `signal.js` also exposes `assessQuality`, which judges whether a
   reading's underlying data is trustworthy using three independently
   checkable criteria — enough raw beats detected, enough intervals
   surviving artifact correction, and high enough agreement between the
   two detectors — rather than one opaque confidence score. If any
   criterion fails, the app withholds the reading (doesn't show or save
   it as a result) and explains exactly which check failed, instead of
   displaying a number that looks precise but isn't trustworthy.
3. `js/baseline.js` — compares a new rMSSD reading against the user's own
   reading history using a z-score departure test (CUSUM-style personal
   baseline deviation detection).
4. `js/storage.js` — saves readings locally (`localStorage`), no server,
   no accounts.
5. `js/app.js` — wires up the UI, waveform, and trend chart. Also renders
   the **Beat Map**: an on-demand detail view (not shown by default, to
   keep the everyday capture flow simple) listing every detected
   beat-to-beat interval, whether it was accepted or excluded, and the
   specific reason for any exclusion.

## Running locally

Browsers block camera access on plain `file://` pages. Serve the folder
over HTTP instead:

```bash
npx serve .
```

or

```bash
python -m http.server 8000
```

Then open `http://localhost:8000` (use Chrome on Android for torch/flash
support; iOS Safari does not expose torch control, so readings there rely
on ambient/screen light instead).

## Exporting a reading for offline cross-checking

After a reading completes, click **Export Raw Signal CSV** on the results
screen. This downloads the exact raw samples the algorithm used (not a
reprocessed or interpolated version), with one row per sample:

- `sample_index`
- `timestamp_ms` — milliseconds since this recording started (not a
  wall-clock time)
- `raw_ppg` — the raw signal value the algorithm actually used
- `existing_peak` — 1 if the app's primary detector marked this sample as
  a heartbeat, else 0

The file also includes a metadata header (recording duration, measured
sample rate, detected BPM/rMSSD, algorithm version).

### Running the NeuroKit2 comparison

```bash
pip install neurokit2 pandas numpy
python scripts/compare_rmssd_neurokit.py path/to/cardiobaseline_export.csv
```

This runs the same raw signal through [NeuroKit2](https://neuropsychology.github.io/NeuroKit/),
an independent, published signal-processing library, and prints its
rMSSD/BPM next to the app's own result. **This is an algorithm
cross-check between two software implementations, not validation against
a clinical ECG reference.** A difference between the two numbers is a
reason to inspect filtering and peak-detection choices in both pipelines,
not proof that either one is correct.

## Running the test suite

```bash
node tests/signal.test.js
```

No test framework or dependency — just Node's built-in `assert`. Covers
RR-interval artifact correction (including hand-verified HR/rMSSD on a
clean synthetic series, a simulated missed beat, and a simulated
extra/duplicate beat), the gap-aware rMSSD calculation, the independent
slope-based detector on a synthetic pulse train, detector-agreement
matching, and all four branches of `assessQuality`.

## Known limitations / future work

- **Not validated against ECG.** Everything in this app has been compared
  only against a consumer fitness watch during development — informally
  useful, but not a clinical reference. A proper validation would need
  synchronized camera-PPG + ECG recordings, collected under an approved
  protocol with a qualified research mentor and appropriate consent/ethics
  review. **This has not been done** and no accuracy claim here should be
  read as if it had been.
- **No public-dataset evaluation.** Smartphone-PPG datasets with expert
  quality labels and/or synchronized ECG exist (e.g. the BUT PPG and
  PPG-DaLiA datasets) and would be a reasonable next step for a more
  rigorous evaluation, but have not been used in this project.
- **rMSSD terminology:** technically, a camera measures a peripheral pulse
  waveform, not the heart's electrical activity — so what this app
  computes is more precisely *pulse-rate variability (PRV)*, not clinical
  HRV. PRV can agree well with ECG-derived HRV under good conditions, but
  the two shouldn't be assumed interchangeable.
- **rMSSD precision** is noticeably less reliable than the BPM reading,
  especially on shorter or lower-quality recordings — this is a known,
  documented difficulty in smartphone-camera PPG generally, not unique to
  this implementation.

## Status

Capture → filter → dual peak detection (with cross-check) → artifact-aware
HR/HRV → signal-quality gating (withhold-and-explain, not silent) → Beat
Map detail view → personal baseline flagging → local history/trend chart
→ raw signal export for offline algorithm cross-checking. BPM has been
checked informally against a consumer fitness watch across many test
recordings and tracks closely; rMSSD remains the least reliable number
produced by the app (see Known limitations above) — also cross-checked
against NeuroKit2 on an exported recording, which independently landed
on a similarly elevated value, suggesting the limitation is often
signal-quality-dependent rather than specific to this implementation.
