// Rule-based personal insights — generated entirely from this device's own
// stored readings using plain statistics (medians, simple trend compares).
// No AI model, no external service, nothing sent anywhere. Every insight
// here should be traceable to a specific, explainable rule, not a black box.

const Insights = (() => {
  const listEl = () => document.getElementById("insightsList");

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  function card(title, text, alert = false) {
    return `
      <li class="insight-card">
        <div class="insight-icon${alert ? " alert" : ""}">${alert ? "!" : "i"}</div>
        <div>
          <p class="insight-body-title">${title}</p>
          <p class="insight-body-text">${text}</p>
        </div>
      </li>`;
  }

  function buildInsights(history) {
    const insights = [];

    if (history.length < 3) {
      insights.push(
        card(
          "Building your baseline",
          `You have ${history.length} reading${history.length === 1 ? "" : "s"} so far. Take a few more under similar resting conditions (sitting, same time of day) to unlock trend insights.`
        )
      );
      return insights;
    }

    // --- Resting HR status: latest vs. the typical (median) of everything before it ---
    const latest = history[history.length - 1];
    const priorHr = history.slice(0, -1).map((h) => h.hr);
    const typicalHr = median(priorHr);
    const hrDeviationPct = ((latest.hr - typicalHr) / typicalHr) * 100;

    if (Math.abs(hrDeviationPct) < 8) {
      insights.push(
        card(
          "Resting heart rate",
          `Your latest reading (${latest.hr} bpm) is close to your typical ${Math.round(typicalHr)} bpm.`
        )
      );
    } else {
      insights.push(
        card(
          "Resting heart rate",
          `Your latest reading (${latest.hr} bpm) is ${hrDeviationPct > 0 ? "higher" : "lower"} than your typical ${Math.round(typicalHr)} bpm (${Math.abs(Math.round(hrDeviationPct))}% ${hrDeviationPct > 0 ? "above" : "below"}).`
        )
      );
    }

    // --- HRV trend: recent readings vs. the readings before them ---
    if (history.length >= 6) {
      const recent = history.slice(-3).map((h) => h.rmssd);
      const earlier = history.slice(-6, -3).map((h) => h.rmssd);
      const recentMedian = median(recent);
      const earlierMedian = median(earlier);
      const changePct = ((recentMedian - earlierMedian) / earlierMedian) * 100;

      if (Math.abs(changePct) >= 10) {
        insights.push(
          card(
            "PRV trend",
            `Your PRV (rMSSD) has ${changePct > 0 ? "increased" : "decreased"} by about ${Math.abs(Math.round(changePct))}% over your last 3 readings compared to the 3 before that.`
          )
        );
      } else {
        insights.push(
          card("PRV trend", "Your PRV has stayed fairly steady across your recent readings.")
        );
      }
    }

    // --- Irregular-flag count: re-run the same baseline check used live,
    // against each reading's own history-at-the-time, over the last 5. ---
    const window_ = history.slice(-5);
    let irregularCount = 0;
    for (let i = 0; i < window_.length; i++) {
      const indexInFull = history.length - window_.length + i;
      const priorHistory = history.slice(0, indexInFull);
      const { status } = Baseline.evaluate(priorHistory, window_[i].rmssd);
      if (status === "irregular") irregularCount++;
    }
    if (irregularCount > 0) {
      insights.push(
        card(
          "Unusual readings",
          `${irregularCount} of your last ${window_.length} readings looked notably different from your personal baseline. If this continues, consider mentioning it to a doctor.`,
          true
        )
      );
    }

    // --- Consistency: how many readings in the last 7 days ---
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentCount = history.filter((h) => h.timestamp >= sevenDaysAgo).length;
    if (recentCount < 3) {
      insights.push(
        card(
          "Keep it up",
          `Only ${recentCount} reading${recentCount === 1 ? "" : "s"} in the last 7 days. More regular readings under similar conditions make your baseline and trends more reliable.`
        )
      );
    }

    return insights;
  }

  function render() {
    const el = listEl();
    if (!el) return;
    const history = Storage.getHistory();
    el.innerHTML = buildInsights(history).join("");
  }

  return { render, buildInsights };
})();
