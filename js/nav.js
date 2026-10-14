// Simple tab navigation — no router needed for this few pages. Both the
// bottom nav buttons and the top-bar gear icon switch tabs the same way.

(() => {
  const navButtons = document.querySelectorAll(".nav-btn, .icon-btn[data-page]");
  const pages = document.querySelectorAll(".tab-page");

  function goToPage(targetId) {
    pages.forEach((p) => p.classList.toggle("active", p.id === targetId));
    document.querySelectorAll(".nav-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.page === targetId);
    });

    // Insights are computed from scratch each time the tab is opened,
    // so they reflect whatever readings were taken since the last visit.
    if (targetId === "page-insights") {
      Insights.render();
    }
  }

  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => goToPage(btn.dataset.page));
  });
})();
