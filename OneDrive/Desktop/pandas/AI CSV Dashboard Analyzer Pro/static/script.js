/* -----------------------------------------------------------
   AI CSV Dashboard Analyzer Pro (Frontend)
   - Upload CSV
   - Preview table
   - Filters + cleaning
   - Dynamic dashboard charts (Chart.js)
   - Save/restore dashboard layout in localStorage
------------------------------------------------------------ */

let datasetId = null;
let currentColumns = [];
let currentTypes = { numeric: [], categorical: [], datetime: [] };
let activeFilters = [];

// Chart cards: [{ id, config, chartInstance }]
let chartCards = [];

const els = {
  uploadForm: document.getElementById("uploadForm"),
  csvFile: document.getElementById("csvFile"),
  statusBox: document.getElementById("statusBox"),
  fileName: document.getElementById("fileName"),
  fileStats: document.getElementById("fileStats"),
  previewTable: document.getElementById("previewTable"),
  analysisBox: document.getElementById("analysisBox"),
  insightsList: document.getElementById("insightsList"),
  recoList: document.getElementById("recoList"),

  filterColumn: document.getElementById("filterColumn"),
  filterOp: document.getElementById("filterOp"),
  filterValue: document.getElementById("filterValue"),
  addFilterBtn: document.getElementById("addFilterBtn"),
  clearFiltersBtn: document.getElementById("clearFiltersBtn"),
  applyFiltersBtn: document.getElementById("applyFiltersBtn"),
  filtersList: document.getElementById("filtersList"),

  removeDuplicates: document.getElementById("removeDuplicates"),
  removeNulls: document.getElementById("removeNulls"),
  fillNulls: document.getElementById("fillNulls"),
  runCleanBtn: document.getElementById("runCleanBtn"),

  addChartBtn: document.getElementById("addChartBtn"),
  chartsGrid: document.getElementById("chartsGrid"),
  chartCardTemplate: document.getElementById("chartCardTemplate"),

  refreshAnalyzeBtn: document.getElementById("refreshAnalyzeBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  saveDashboardBtn: document.getElementById("saveDashboardBtn"),
  resetDashboardBtn: document.getElementById("resetDashboardBtn"),
};

function setStatus(msg, kind = "info") {
  els.statusBox.textContent = msg || "";
  els.statusBox.style.color = kind === "error" ? "#ffb4b4" : "#a9b4d6";
}

function requireDataset() {
  if (!datasetId) {
    setStatus("Upload a CSV first.", "error");
    return false;
  }
  return true;
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const msg = data?.error || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function renderPreviewTable(preview) {
  if (!preview || !preview.columns) {
    els.previewTable.innerHTML = "";
    return;
  }

  const cols = preview.columns;
  const rows = preview.rows || [];

  const thead = `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
  const tbodyRows = rows
    .map((r) => {
      return `<tr>${cols
        .map((c) => `<td>${escapeHtml(formatCell(r[c]))}</td>`)
        .join("")}</tr>`;
    })
    .join("");
  const tbody = `<tbody>${tbodyRows}</tbody>`;

  els.previewTable.innerHTML = thead + tbody;
}

function renderAnalysis(analysis) {
  if (!analysis) {
    els.analysisBox.innerHTML = "";
    return;
  }

  const shape = analysis.shape || { rows: 0, columns: 0 };
  const missing = analysis.missing_values || {};
  const dup = analysis.duplicate_rows ?? 0;
  const dtypes = analysis.dtypes || {};

  const missingTop = Object.entries(missing)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, 8);

  const typeSummary = [
    `Numeric: ${analysis.detected_types?.numeric?.length || 0}`,
    `Categorical: ${analysis.detected_types?.categorical?.length || 0}`,
    `Datetime: ${analysis.detected_types?.datetime?.length || 0}`,
  ].join(" • ");

  const items = [
    ["Rows", `${shape.rows}`],
    ["Columns", `${shape.columns}`],
    ["Detected types", typeSummary],
    ["Duplicate rows", `${dup}`],
    ["Columns", `<span class="mono">${analysis.columns?.join(", ") || ""}</span>`],
    ["Data types", `<span class="mono">${Object.entries(dtypes).map(([k, v]) => `${k}: ${v}`).join(" | ")}</span>`],
    [
      "Missing (top)",
      `<span class="mono">${missingTop.map(([c, v]) => `${c}: ${v}`).join(" | ") || "None"}</span>`,
    ],
  ];

  els.fileStats.textContent = `Rows: ${shape.rows} • Columns: ${shape.columns} • ${typeSummary}`;

  els.analysisBox.innerHTML = items
    .map(([k, v]) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join("");
}

function renderAI(ai) {
  const insights = ai?.insights || [];
  const recos = ai?.recommendations || [];
  els.insightsList.innerHTML = insights.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  els.recoList.innerHTML = recos.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
}

function setColumns(columns, detectedTypes) {
  currentColumns = columns || [];
  currentTypes = detectedTypes || { numeric: [], categorical: [], datetime: [] };

  // Filters column select
  els.filterColumn.innerHTML = currentColumns.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");

  // Update existing chart selects
  for (const card of chartCards) {
    populateChartSelects(card);
  }
}

function renderFilters() {
  els.filtersList.innerHTML = "";
  for (let i = 0; i < activeFilters.length; i++) {
    const f = activeFilters[i];
    const text = `${f.column} ${opLabel(f.op)} ${f.value}`;
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<span>${escapeHtml(text)}</span><button type="button" aria-label="remove">×</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      activeFilters.splice(i, 1);
      renderFilters();
    });
    els.filtersList.appendChild(chip);
  }
}

function opLabel(op) {
  if (op === "gt") return ">";
  if (op === "lt") return "<";
  if (op === "contains") return "contains";
  return "=";
}

// -----------------------------------------------------------
// Dashboard charts
// -----------------------------------------------------------
function addChartCard(initialConfig = null) {
  if (!requireDataset()) return;
  const cardId = crypto.randomUUID();

  const node = els.chartCardTemplate.content.firstElementChild.cloneNode(true);
  const titleInput = node.querySelector(".chart-title");
  const typeSelect = node.querySelector(".chart-type");
  const xSelect = node.querySelector(".chart-x");
  const yRow = node.querySelector(".chart-y-row");
  const ySelect = node.querySelector(".chart-y");
  const extraRow = node.querySelector(".chart-extra-row");
  const extraLabel = node.querySelector(".chart-extra-label");
  const extraInput = node.querySelector(".chart-extra");
  const removeBtn = node.querySelector(".chart-remove");
  const updateBtn = node.querySelector(".chart-update");
  const canvas = node.querySelector("canvas");

  const config = {
    chartType: initialConfig?.chartType || "histogram",
    title: initialConfig?.title || "Chart",
    x: initialConfig?.x || "",
    y: initialConfig?.y || "",
    bins: initialConfig?.bins ?? 12,
    topN: initialConfig?.topN ?? 12,
  };

  titleInput.value = config.title;
  typeSelect.value = config.chartType;

  const card = {
    id: cardId,
    node,
    config,
    chartInstance: null,
    canvas,
  };

  // Populate selects
  chartCards.push(card);
  populateChartSelects(card);

  // Apply initial selection defaults if empty
  if (!config.x) config.x = suggestXForType(config.chartType);
  if (!config.y) config.y = suggestYForType(config.chartType);

  // Update UI according to type
  function syncTypeUI() {
    const t = typeSelect.value;
    card.config.chartType = t;

    const needsY = t === "line" || t === "scatter";
    yRow.style.display = needsY ? "flex" : "none";

    if (t === "histogram") {
      extraRow.style.display = "flex";
      extraLabel.textContent = "Bins";
      extraInput.value = `${card.config.bins ?? 12}`;
    } else if (t === "bar") {
      extraRow.style.display = "flex";
      extraLabel.textContent = "Top N";
      extraInput.value = `${card.config.topN ?? 12}`;
    } else {
      extraRow.style.display = "none";
    }

    // Auto-suggest columns for new types
    if (!xSelect.value) xSelect.value = suggestXForType(t) || "";
    if (needsY && !ySelect.value) ySelect.value = suggestYForType(t) || "";
  }

  typeSelect.addEventListener("change", () => {
    syncTypeUI();
  });

  titleInput.addEventListener("input", () => {
    card.config.title = titleInput.value.trim() || "Chart";
  });

  xSelect.addEventListener("change", () => {
    card.config.x = xSelect.value;
  });
  ySelect.addEventListener("change", () => {
    card.config.y = ySelect.value;
  });

  extraInput.addEventListener("input", () => {
    const n = parseInt(extraInput.value, 10);
    if (Number.isFinite(n)) {
      if (card.config.chartType === "histogram") card.config.bins = n;
      if (card.config.chartType === "bar") card.config.topN = n;
    }
  });

  updateBtn.addEventListener("click", () => {
    updateChart(card).catch((e) => setStatus(e.message, "error"));
  });

  removeBtn.addEventListener("click", () => {
    removeChartCard(cardId);
  });

  els.chartsGrid.appendChild(node);
  syncTypeUI();

  // Initial render
  updateChart(card).catch((e) => setStatus(e.message, "error"));
}

function removeChartCard(cardId) {
  const idx = chartCards.findIndex((c) => c.id === cardId);
  if (idx === -1) return;
  const card = chartCards[idx];
  try {
    card.chartInstance?.destroy?.();
  } catch (_) {}
  card.node.remove();
  chartCards.splice(idx, 1);
}

function populateChartSelects(card) {
  const xSelect = card.node.querySelector(".chart-x");
  const ySelect = card.node.querySelector(".chart-y");

  xSelect.innerHTML = currentColumns.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
  ySelect.innerHTML = currentColumns.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");

  if (card.config.x && currentColumns.includes(card.config.x)) xSelect.value = card.config.x;
  if (card.config.y && currentColumns.includes(card.config.y)) ySelect.value = card.config.y;
}

function suggestXForType(type) {
  if (type === "histogram") return currentTypes.numeric?.[0] || currentColumns[0] || "";
  if (type === "bar") return currentTypes.categorical?.[0] || currentColumns[0] || "";
  if (type === "line") return currentTypes.datetime?.[0] || currentColumns[0] || "";
  if (type === "scatter") return currentTypes.numeric?.[0] || currentColumns[0] || "";
  return currentColumns[0] || "";
}

function suggestYForType(type) {
  if (type === "line") return currentTypes.numeric?.[0] || currentColumns[0] || "";
  if (type === "scatter") return currentTypes.numeric?.[1] || currentTypes.numeric?.[0] || currentColumns[0] || "";
  return "";
}

async function updateChart(card) {
  if (!requireDataset()) return;
  const t = card.config.chartType;

  // Read latest UI selections (in case user didn't click away)
  const titleInput = card.node.querySelector(".chart-title");
  const typeSelect = card.node.querySelector(".chart-type");
  const xSelect = card.node.querySelector(".chart-x");
  const ySelect = card.node.querySelector(".chart-y");
  const extraInput = card.node.querySelector(".chart-extra");

  card.config.title = titleInput.value.trim() || "Chart";
  card.config.chartType = typeSelect.value;
  card.config.x = xSelect.value;
  card.config.y = ySelect.value;

  const payload = { dataset_id: datasetId, chartType: card.config.chartType };

  if (card.config.chartType === "histogram") {
    payload.x = card.config.x;
    payload.bins = parseInt(extraInput.value, 10) || 12;
  } else if (card.config.chartType === "bar") {
    payload.x = card.config.x;
    payload.topN = parseInt(extraInput.value, 10) || 12;
  } else if (card.config.chartType === "line") {
    payload.x = card.config.x;
    payload.y = card.config.y;
  } else if (card.config.chartType === "scatter") {
    payload.x = card.config.x;
    payload.y = card.config.y;
  }

  const data = await postJSON("/chart-data", payload);
  renderChart(card, data);
}

function renderChart(card, data) {
  // Destroy existing chart instance cleanly
  if (card.chartInstance) {
    try {
      card.chartInstance.destroy();
    } catch (_) {}
    card.chartInstance = null;
  }

  const ctx = card.canvas.getContext("2d");
  const title = card.config.title;

  if (data.chartType === "scatter") {
    const points = data.points || [];
    card.chartInstance = new Chart(ctx, {
      type: "scatter",
      data: {
        datasets: [
          {
            label: title,
            data: points,
            pointRadius: 3,
            borderColor: "rgba(110,168,254,0.95)",
            backgroundColor: "rgba(110,168,254,0.65)",
          },
        ],
      },
      options: baseChartOptions(title),
    });
    return;
  }

  const labels = data.labels || [];
  const values = data.data || [];

  let chartType = "bar";
  if (data.chartType === "line") chartType = "line";
  if (data.chartType === "histogram") chartType = "bar";
  if (data.chartType === "bar") chartType = "bar";

  card.chartInstance = new Chart(ctx, {
    type: chartType,
    data: {
      labels,
      datasets: [
        {
          label: title,
          data: values,
          borderColor: "rgba(139,92,246,0.95)",
          backgroundColor: "rgba(139,92,246,0.45)",
          tension: 0.25,
        },
      ],
    },
    options: baseChartOptions(title),
  });
}

function baseChartOptions(title) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: true, labels: { color: "#e9eefc" } },
      title: { display: false, text: title, color: "#e9eefc" },
      tooltip: { enabled: true },
    },
    scales: {
      x: { ticks: { color: "#a9b4d6" }, grid: { color: "rgba(255,255,255,0.06)" } },
      y: { ticks: { color: "#a9b4d6" }, grid: { color: "rgba(255,255,255,0.06)" } },
    },
  };
}

function refreshAllCharts() {
  return Promise.all(chartCards.map((c) => updateChart(c).catch(() => null)));
}

// -----------------------------------------------------------
// Save/restore dashboard
// -----------------------------------------------------------
const DASH_KEY = "ai_csv_dashboard_layout_v1";

function saveDashboard() {
  const layout = chartCards.map((c) => ({
    chartType: c.config.chartType,
    title: c.config.title,
    x: c.config.x,
    y: c.config.y,
    bins: c.config.bins ?? 12,
    topN: c.config.topN ?? 12,
  }));
  localStorage.setItem(DASH_KEY, JSON.stringify(layout));
  setStatus("Dashboard layout saved.");
}

function resetDashboard() {
  localStorage.removeItem(DASH_KEY);
  // Remove current cards
  while (chartCards.length) removeChartCard(chartCards[0].id);
  setStatus("Dashboard layout reset.");
}

function restoreDashboardOrSuggestions(suggestedCharts) {
  // Clear existing cards
  while (chartCards.length) removeChartCard(chartCards[0].id);

  const saved = localStorage.getItem(DASH_KEY);
  if (saved) {
    try {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr) && arr.length) {
        arr.forEach((cfg) => addChartCard(cfg));
        setStatus("Restored saved dashboard layout.");
        return;
      }
    } catch (_) {}
  }

  // No saved layout -> use AI suggestions
  if (Array.isArray(suggestedCharts) && suggestedCharts.length) {
    suggestedCharts.forEach((cfg) => addChartCard(cfg));
  } else {
    // Always at least one chart
    addChartCard({ chartType: "histogram", title: "Histogram", x: suggestXForType("histogram"), bins: 12 });
  }
}

// -----------------------------------------------------------
// Events
// -----------------------------------------------------------
els.uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = els.csvFile.files?.[0];
  if (!file) {
    setStatus("Please select a CSV file.", "error");
    return;
  }

  setStatus("Uploading...");
  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch("/upload", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    setStatus(data?.error || "Upload failed.", "error");
    return;
  }

  datasetId = data.dataset_id;
  els.fileName.textContent = data.filename || "Uploaded CSV";

  // Update UI
  renderPreviewTable(data.preview);
  renderAnalysis(data.analysis);
  renderAI(data.ai);
  setColumns(data.analysis?.columns || [], data.analysis?.detected_types || {});

  // Filters reset on new upload
  activeFilters = [];
  renderFilters();

  // Build charts
  restoreDashboardOrSuggestions(data.ai?.suggestedCharts);

  setStatus("Upload complete. Dashboard ready.");
});

els.addFilterBtn.addEventListener("click", () => {
  if (!requireDataset()) return;
  const column = els.filterColumn.value;
  const op = els.filterOp.value;
  const value = els.filterValue.value;
  if (!column || !op) return;
  if (value === "") {
    setStatus("Filter value cannot be empty.", "error");
    return;
  }
  activeFilters.push({ column, op, value });
  els.filterValue.value = "";
  renderFilters();
});

els.clearFiltersBtn.addEventListener("click", () => {
  activeFilters = [];
  renderFilters();
  setStatus("Filters cleared (not applied yet).");
});

els.applyFiltersBtn.addEventListener("click", async () => {
  if (!requireDataset()) return;
  try {
    setStatus("Applying filters...");
    const data = await postJSON("/filter", { dataset_id: datasetId, filters: activeFilters });
    renderPreviewTable(data.preview);
    renderAnalysis(data.analysis);
    renderAI(data.ai);
    setColumns(data.analysis?.columns || [], data.analysis?.detected_types || {});
    await refreshAllCharts();
    setStatus("Filters applied.");
  } catch (e) {
    setStatus(e.message, "error");
  }
});

els.runCleanBtn.addEventListener("click", async () => {
  if (!requireDataset()) return;
  try {
    setStatus("Cleaning dataset...");
    const fill = els.fillNulls.value || null;
    const data = await postJSON("/clean", {
      dataset_id: datasetId,
      remove_duplicates: els.removeDuplicates.checked,
      remove_nulls: els.removeNulls.checked,
      fill_nulls: fill,
    });
    renderPreviewTable(data.preview);
    renderAnalysis(data.analysis);
    renderAI(data.ai);
    setColumns(data.analysis?.columns || [], data.analysis?.detected_types || {});
    await refreshAllCharts();
    setStatus("Cleaning complete.");
  } catch (e) {
    setStatus(e.message, "error");
  }
});

els.addChartBtn.addEventListener("click", () => addChartCard(null));

els.refreshAnalyzeBtn.addEventListener("click", async () => {
  if (!requireDataset()) return;
  try {
    setStatus("Running analysis...");
    const data = await postJSON("/analyze", { dataset_id: datasetId });
    renderAnalysis(data.analysis);
    renderAI(data.ai);
    setColumns(data.analysis?.columns || [], data.analysis?.detected_types || {});
    await refreshAllCharts();
    setStatus("Analysis updated.");
  } catch (e) {
    setStatus(e.message, "error");
  }
});

els.downloadBtn.addEventListener("click", () => {
  if (!requireDataset()) return;
  window.open(`/download?dataset_id=${encodeURIComponent(datasetId)}`, "_blank");
});

els.saveDashboardBtn.addEventListener("click", saveDashboard);
els.resetDashboardBtn.addEventListener("click", () => {
  resetDashboard();
  // Build a minimal dashboard again
  if (datasetId) restoreDashboardOrSuggestions(null);
});

// -----------------------------------------------------------
// Utilities
// -----------------------------------------------------------
function formatCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    return `${v}`;
  }
  return `${v}`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(str) {
  // Good enough for option values
  return escapeHtml(str).replaceAll("\n", " ").replaceAll("\r", " ");
}

