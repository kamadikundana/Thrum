// Local history storage (no server, no accounts — everything stays on-device).

const Storage = (() => {
  const KEY = "cardiobaseline_history";

  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || [];
    } catch {
      return [];
    }
  }

  function addReading(reading) {
    const history = getHistory();
    history.push({ ...reading, timestamp: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(history));
    return history;
  }

  function clear() {
    localStorage.removeItem(KEY);
  }

  return { getHistory, addReading, clear };
})();
