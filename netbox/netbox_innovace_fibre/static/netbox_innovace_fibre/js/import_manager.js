const TABLE_FIELDS = [
  "name",
  "role",
  "manufacturer",
  "device_type",
  "status",
  "site",
  "location",
  "rack",
  "position",
  "face",
  "serial",
  "asset_tag",
  "description",
];

const SELECT_FIELDS = new Set([
  "role",
  "manufacturer",
  "device_type",
  "status",
  "site",
  "location",
  "rack",
  "face",
]);

const REQUIRED_FIELDS = new Set([
  "name",
  "role",
  "manufacturer",
  "device_type",
  "status",
  "site",
]);

class ImportManagerApp {
  constructor(config) {
    this.config = config;
    this.tbody = document.getElementById("iff-device-rows");
    this.summary = document.getElementById("iff-import-summary");
    this.options = {
      roles: [],
      manufacturers: [],
      device_types: [],
      statuses: [],
      sites: [],
      locations: [],
      racks: [],
      faces: [],
    };

    this._init();
  }

  async _init() {
    this._bindToolbar();
    await this._loadOptions();
    for (let i = 0; i < 5; i += 1) this._addRow();
  }

  _bindToolbar() {
    document.getElementById("iff-add-row").addEventListener("click", () => {
      const row = this._addRow();
      this._focusCell(row, 0);
    });

    document.getElementById("iff-bulk-create").addEventListener("click", () => this._bulkCreate());
    document.getElementById("iff-clear-completed").addEventListener("click", () => this._clearCompleted());
  }

  async _loadOptions(params = {}) {
    const url = new URL(this.config.optionsUrl, window.location.origin);
    Object.entries(params).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value);
    });
    const response = await fetch(url);
    if (!response.ok) throw new Error("Unable to load import options.");
    this.options = await response.json();
  }

  _addRow(values = {}) {
    const tr = document.createElement("tr");
    tr.dataset.status = "draft";
    tr.innerHTML = `
      <td class="text-muted iff-row-number"></td>
      ${TABLE_FIELDS.map((field) => `<td class="iff-col-${field}">${this._fieldHtml(field, values[field] || "")}</td>`).join("")}
      <td class="iff-row-status text-muted">Ready</td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-danger iff-delete-row" type="button" title="Remove row">
          <i class="mdi mdi-close"></i>
        </button>
      </td>
    `;
    this.tbody.appendChild(tr);
    this._hydrateSelects(tr);
    this._bindRow(tr);
    this._renumberRows();
    return tr;
  }

  _fieldHtml(field, value) {
    const required = REQUIRED_FIELDS.has(field) ? "required" : "";
    const escaped = this._escape(value);
    if (SELECT_FIELDS.has(field)) {
      return `<select class="form-select form-select-sm no-ts iff-cell" data-field="${field}" ${required}></select>`;
    }
    return `<input class="form-control form-control-sm iff-cell" data-field="${field}" value="${escaped}" ${required}>`;
  }

  _bindRow(tr) {
    tr.querySelector(".iff-delete-row").addEventListener("click", () => {
      tr.remove();
      if (!this.tbody.children.length) this._addRow();
      this._renumberRows();
    });

    tr.querySelectorAll(".iff-cell").forEach((cell) => {
      cell.addEventListener("keydown", (event) => this._handleKeydown(event));
      cell.addEventListener("change", () => this._handleDependencies(tr, cell.dataset.field));
      cell.addEventListener("input", () => this._markDraft(tr));
    });
  }

  _hydrateSelects(tr) {
    this._setSelectOptions(tr.querySelector('[data-field="role"]'), this.options.roles);
    this._setSelectOptions(tr.querySelector('[data-field="manufacturer"]'), this.options.manufacturers);
    this._setSelectOptions(tr.querySelector('[data-field="status"]'), this.options.statuses, "active");
    this._setSelectOptions(tr.querySelector('[data-field="site"]'), this.options.sites);
    this._setSelectOptions(tr.querySelector('[data-field="face"]'), this.options.faces, "front");
    this._refreshDependentSelects(tr);
  }

  _setSelectOptions(select, options, defaultValue = "") {
    const current = select.value || defaultValue;
    select.innerHTML = '<option value=""></option>';
    options.forEach((option) => {
      const opt = document.createElement("option");
      opt.value = option.value;
      opt.textContent = option.label;
      if (option.id) opt.dataset.id = option.id;
      if (option.manufacturerId || option.manufacturer_id) opt.dataset.manufacturerId = option.manufacturerId || option.manufacturer_id;
      if (option.siteId || option.site_id) opt.dataset.siteId = option.siteId || option.site_id;
      if (option.locationId || option.location_id) opt.dataset.locationId = option.locationId || option.location_id;
      select.appendChild(opt);
    });
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }

  _handleDependencies(tr, field) {
    this._markDraft(tr);
    if (field === "manufacturer") {
      this._setSelectOptions(tr.querySelector('[data-field="device_type"]'), []);
    }
    if (field === "site") {
      this._setSelectOptions(tr.querySelector('[data-field="location"]'), []);
      this._setSelectOptions(tr.querySelector('[data-field="rack"]'), []);
    }
    if (field === "location") {
      this._setSelectOptions(tr.querySelector('[data-field="rack"]'), []);
    }
    this._refreshDependentSelects(tr);
  }

  _refreshDependentSelects(tr) {
    const manufacturerId = this._selectedId(tr, "manufacturer");
    const siteId = this._selectedId(tr, "site");
    const locationId = this._selectedId(tr, "location");

    const deviceTypes = this.options.device_types.filter((option) => {
      return !manufacturerId || String(option.manufacturer_id) === String(manufacturerId);
    });
    this._setSelectOptions(tr.querySelector('[data-field="device_type"]'), deviceTypes);

    const locations = this.options.locations.filter((option) => {
      return !siteId || String(option.site_id) === String(siteId);
    });
    this._setSelectOptions(tr.querySelector('[data-field="location"]'), locations);

    const racks = this.options.racks.filter((option) => {
      if (siteId && String(option.site_id) !== String(siteId)) return false;
      if (locationId && String(option.location_id) !== String(locationId)) return false;
      return true;
    });
    this._setSelectOptions(tr.querySelector('[data-field="rack"]'), racks);
  }

  _selectedId(tr, field) {
    const select = tr.querySelector(`[data-field="${field}"]`);
    return select?.selectedOptions?.[0]?.dataset?.id || "";
  }

  _handleKeydown(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();

    const cells = [...this.tbody.querySelectorAll(".iff-cell")];
    const index = cells.indexOf(event.currentTarget);
    const next = cells[index + 1] || this._addRow().querySelector(".iff-cell");
    next.focus();
    if (next.select) next.select();
  }

  async _bulkCreate() {
    const rows = [...this.tbody.querySelectorAll("tr")];
    const payloadRows = rows.map((tr) => tr.dataset.status === "created" ? {} : this._rowData(tr));
    const nonEmptyRows = payloadRows.filter((row) => this._hasData(row));
    if (!nonEmptyRows.length) {
      this._setSummary("No device rows to create.", "text-danger");
      return;
    }

    this._setBusy(true);
    rows.forEach((tr) => {
      if (tr.dataset.status === "created") {
        return;
      }
      if (this._hasData(this._rowData(tr))) {
        this._setRowStatus(tr, "pending", "Pending");
      } else {
        this._setRowStatus(tr, "draft", "Ready");
      }
    });

    try {
      const response = await fetch(this.config.bulkCreateUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": this.config.csrf,
        },
        body: JSON.stringify({ rows: payloadRows }),
      });
      const result = await response.json();
      this._applyResults(result.results || []);
      if (response.ok) {
        this._setSummary(`Created ${result.created || 0} device(s).`, "text-success");
        this._addRowIfNeeded();
      } else {
        this._setSummary("Fix the highlighted rows and try again.", "text-danger");
      }
    } catch (error) {
      this._setSummary(error.message || "Bulk create failed.", "text-danger");
    } finally {
      this._setBusy(false);
    }
  }

  _rowData(tr) {
    const data = {};
    TABLE_FIELDS.forEach((field) => {
      data[field] = tr.querySelector(`[data-field="${field}"]`)?.value?.trim() || "";
    });
    return data;
  }

  _hasData(row) {
    return Object.values(row).some((value) => value);
  }

  _applyResults(results) {
    results.forEach((result) => {
      const tr = this.tbody.children[result.row];
      if (!tr) return;
      if (result.status === "created") {
        const label = result.url ? `<a href="${this._escape(result.url)}">${this._escape(result.name)}</a>` : this._escape(result.name);
        this._setRowStatus(tr, "created", `Created ${label}`);
      } else if (result.status === "error") {
        this._setRowStatus(tr, "error", (result.errors || ["Invalid row"]).map((e) => this._escape(e)).join("<br>"));
      }
    });
  }

  _setRowStatus(tr, status, html) {
    tr.dataset.status = status;
    tr.classList.toggle("iff-created", status === "created");
    tr.classList.toggle("iff-error", status === "error");
    tr.querySelector(".iff-row-status").innerHTML = html;
  }

  _markDraft(tr) {
    this._setRowStatus(tr, "draft", "Ready");
  }

  _clearCompleted() {
    this.tbody.querySelectorAll('tr[data-status="created"]').forEach((tr) => tr.remove());
    if (!this.tbody.children.length) this._addRow();
    this._renumberRows();
  }

  _addRowIfNeeded() {
    const last = this.tbody.lastElementChild;
    if (!last || this._hasData(this._rowData(last))) this._addRow();
  }

  _focusCell(tr, fieldIndex) {
    tr.querySelectorAll(".iff-cell")[fieldIndex]?.focus();
  }

  _renumberRows() {
    [...this.tbody.querySelectorAll("tr")].forEach((tr, index) => {
      tr.querySelector(".iff-row-number").textContent = index + 1;
    });
  }

  _setBusy(isBusy) {
    document.getElementById("iff-bulk-create").disabled = isBusy;
  }

  _setSummary(message, className) {
    this.summary.className = `small ${className}`;
    this.summary.textContent = message;
  }

  _escape(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (window.INNOVACE_IMPORT_MANAGER) {
    new ImportManagerApp(window.INNOVACE_IMPORT_MANAGER);
  }
});
