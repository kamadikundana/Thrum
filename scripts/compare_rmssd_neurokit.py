"""Offline cross-check of CardioBaseline's JS rMSSD against NeuroKit2.

This is an ALGORITHM CROSS-CHECK, not ECG validation. It compares two
independent software implementations processing the same raw camera-PPG
signal. Agreement between them says the two implementations behave
similarly; it does NOT establish that either one matches a clinical
reference. Validating against synchronized ECG is listed as future work
in the project README, not something this script performs.

Install:
    pip install neurokit2 pandas numpy

Usage:
    python compare_rmssd_neurokit.py path/to/cardiobaseline_export.csv
"""

import sys
import re
import numpy as np
import pandas as pd

try:
    import neurokit2 as nk
except ImportError:
    print("NeuroKit2 is not installed. Run: pip install neurokit2 pandas numpy")
    sys.exit(1)

REQUIRED_COLUMNS = {"sample_index", "timestamp_ms", "raw_ppg", "existing_peak"}


def load_export(path):
    """Loads the CSV, separating the leading '#' metadata lines from the
    data table, and returns (metadata: dict, dataframe)."""
    metadata = {}
    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    data_start = 0
    for i, line in enumerate(lines):
        if line.startswith("#"):
            match = re.match(r"#\s*([\w_]+):\s*(.+)", line.strip())
            if match:
                metadata[match.group(1)] = match.group(2).strip()
        elif line.strip() == "":
            continue
        else:
            data_start = i
            break

    df = pd.read_csv(path, skiprows=data_start)
    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise ValueError(f"CSV is missing required columns: {missing}")
    return metadata, df


def inspect_timing(df):
    """Checks whether the exported timestamps are (approximately)
    uniformly spaced, and warns rather than silently assuming so."""
    dt = df["timestamp_ms"].diff().dropna().to_numpy()
    mean_dt = float(np.mean(dt))
    std_dt = float(np.std(dt))
    implied_hz = 1000.0 / mean_dt if mean_dt > 0 else float("nan")

    print(f"Samples: {len(df)}")
    print(f"Duration: {(df['timestamp_ms'].iloc[-1] - df['timestamp_ms'].iloc[0]) / 1000:.1f} s")
    print(f"Mean inter-sample interval: {mean_dt:.2f} ms (implied ~{implied_hz:.1f} Hz)")
    print(f"Inter-sample interval std dev: {std_dt:.2f} ms")

    # A real camera doesn't deliver perfectly uniform frames; a large
    # std dev relative to the mean means timing was irregular enough that
    # treating the signal as uniformly sampled is itself an approximation,
    # not a fact recovered from the data.
    if mean_dt > 0 and std_dt / mean_dt > 0.25:
        print(
            "WARNING: inter-sample timing is irregular (std/mean > 25%). "
            "Resampling to a uniform grid for NeuroKit2 is an approximation "
            "of the original capture timing, not a recovery of it."
        )
    return implied_hz


def main():
    if len(sys.argv) != 2:
        print("Usage: python compare_rmssd_neurokit.py <exported_csv_path>")
        sys.exit(1)

    path = sys.argv[1]
    metadata, df = load_export(path)

    print("=== Export metadata ===")
    for k, v in metadata.items():
        print(f"{k}: {v}")
    print()

    print("=== Timing inspection ===")
    implied_hz = inspect_timing(df)
    print()

    duration_s = (df["timestamp_ms"].iloc[-1] - df["timestamp_ms"].iloc[0]) / 1000
    if duration_s < 15:
        print(
            f"WARNING: recording is only {duration_s:.1f}s. rMSSD from a short "
            "recording is a noisy statistic on its own — treat this comparison "
            "as lower-confidence for short exports."
        )

    ppg = df["raw_ppg"].to_numpy(dtype=float)
    if not np.isfinite(ppg).all():
        raise ValueError("Non-finite samples in raw_ppg — inspect the export before comparing.")
    if np.std(ppg) < 1e-8:
        raise ValueError("Signal is effectively flat — nothing to compare.")

    # The app's own result, as recorded in the export metadata.
    app_hr = metadata.get("detected_bpm")
    app_rmssd = metadata.get("detected_rmssd_ms")
    app_existing_peak_count = int(df["existing_peak"].sum())

    # NeuroKit2's independent pipeline on the SAME raw samples. Uses the
    # metadata's actual measured sample rate, not an assumed one — see
    # sample_rate_hz_actual in the export.
    fs = float(metadata.get("sample_rate_hz_actual", implied_hz))

    print("=== Running NeuroKit2 ===")
    cleaned = nk.ppg_clean(ppg, sampling_rate=fs, method="elgendi")
    _, info = nk.ppg_peaks(cleaned, sampling_rate=fs, method="elgendi", correct_artifacts=False)
    nk_peaks = np.asarray(info["PPG_Peaks"], dtype=int)

    if len(nk_peaks) < 5:
        print("NeuroKit2 found too few peaks to compute rMSSD reliably on this export.")
        nk_rmssd = None
        nk_hr = None
    else:
        ibi_ms = np.diff(nk_peaks) / fs * 1000.0
        valid = (ibi_ms >= 333) & (ibi_ms <= 1500)  # ~40-180 bpm plausibility screen
        if valid.sum() < 4:
            print("Too few plausible intervals from NeuroKit2's peaks to compute rMSSD.")
            nk_rmssd = None
            nk_hr = None
        else:
            successive_diffs = np.diff(ibi_ms)
            valid_pairs = valid[:-1] & valid[1:]
            nk_rmssd = float(np.sqrt(np.mean(successive_diffs[valid_pairs] ** 2))) if valid_pairs.sum() >= 3 else None
            nk_hr = float(60000.0 / np.median(ibi_ms[valid])) if valid.sum() > 0 else None

    print()
    print("=== Comparison (algorithm cross-check, NOT ECG validation) ===")
    print(f"App-detected beats (existing_peak column): {app_existing_peak_count}")
    print(f"NeuroKit2-detected beats:                   {len(nk_peaks)}")
    print(f"App BPM:        {app_hr}")
    print(f"NeuroKit2 BPM:  {nk_hr if nk_hr is not None else 'n/a'}")
    print(f"App rMSSD (ms):       {app_rmssd}")
    print(f"NeuroKit2 rMSSD (ms): {nk_rmssd if nk_rmssd is not None else 'n/a'}")

    if app_rmssd is not None and nk_rmssd is not None:
        diff = abs(float(app_rmssd) - nk_rmssd)
        print(f"Absolute rMSSD difference: {diff:.1f} ms")
    else:
        print("Cannot compute a numeric rMSSD difference — one of the two methods didn't produce a value.")

    print()
    print(
        "A difference between the two rMSSD values is a reason to look at "
        "filtering, peak locations, and artifact handling in both pipelines "
        "— it is not automatic evidence that either implementation is correct."
    )


if __name__ == "__main__":
    main()
