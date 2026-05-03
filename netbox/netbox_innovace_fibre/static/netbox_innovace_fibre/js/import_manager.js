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
    this.childTbody = document.getElementById("iff-child-device-rows");
    this.rackUTbody = document.getElementById("iff-rack-u-rows");
    this.populateTbody = document.getElementById("iff-bay-populate-rows");
    this.summary = document.getElementById("iff-import-summary");
    this.childSummary = document.getElementById("iff-child-import-summary");
    this.rackUSummary = document.getElementById("iff-rack-u-summary");
    this.populateSummary = document.getElementById("iff-populate-summary");
    this.rackUControls = {
      site: document.getElementById("iff-rack-u-site"),
      racks: document.getElementById("iff-rack-u-racks"),
      faces: document.getElementById("iff-rack-u-faces"),
      role: document.getElementById("iff-rack-u-role"),
      status: document.getElementById("iff-rack-u-status"),
      manufacturer: document.getElementById("iff-rack-u-manufacturer"),
      deviceType: document.getElementById("iff-rack-u-device-type"),
    };
    this.options = {
      roles: [],
      manufacturers: [],
      device_types: [],
      statuses: [],
      sites: [],
      locations: [],
      racks: [],
      faces: [],
      parent_devices: [],
      device_bays: [],
      existing_child_devices: [],
    };

    this._init();
  }

  async _init() {
    this._bindToolbar();
    await this._loadOptions();
    this._hydrateRackUControls();
    for (let i = 0; i < 5; i += 1) this._addRow();
    for (let i = 0; i < 3; i += 1) this._addChildRow();
    for (let i = 0; i < 3; i += 1) this._addPopulateRow();
  }

  _bindToolbar() {
    document.getElementById("iff-add-row").addEventListener("click", () => {
      const row = this._addRow();
      this._focusCell(row, 0);
    });

    document.getElementById("iff-bulk-create").addEventListener("click", () => this._bulkCreate());
    document.getElementById("iff-clear-completed").addEventListener("click", () => this._clearCompleted());
    document.getElementById("iff-add-child-row").addEventListener("click", () => {
      const row = this._addChildRow();
      this._focusRowCell(row, 0);
    });
    document.getElementById("iff-bulk-create-children").addEventListener("click", () => this._bulkCreateChildren());
    document.getElementById("iff-generate-rack-u").addEventListener("click", () => this._generateRackURows());
    document.getElementById("iff-add-rack-u-row").addEventListener("click", () => {
      const row = this._addRackURow();
      this._focusRowCell(row, 0);
    });
    document.getElementById("iff-bulk-create-rack-u").addEventListener("click", () => this._bulkCreateRackU());
    document.getElementById("iff-add-populate-row").addEventListener("click", () => {
      const row = this._addPopulateRow();
      this._focusRowCell(row, 0);
    });
    document.getElementById("iff-bulk-populate-bays").addEventListener("click", () => this._bulkPopulateBays());
    this.rackUControls.site.addEventListener("change", () => this._refreshRackURackOptions());
    this.rackUControls.manufacturer.addEventListener("change", () => this._refreshRackUDeviceTypes());
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

  _addRow(values = {}, after = null) {
    const tr = document.createElement("tr");
    tr.dataset.status = "draft";
    tr.innerHTML = `
      <td class="text-muted iff-row-number"></td>
      ${TABLE_FIELDS.map((field) => `<td class="iff-col-${field}">${this._fieldHtml(field, values[field] || "")}</td>`).join("")}
      <td class="iff-row-status text-muted">Ready</td>
      <td class="text-end">${this._rowActionsHtml()}</td>
    `;
    this._insertRow(this.tbody, tr, after);
    this._hydrateSelects(tr);
    this._applyRowValues(tr, values);
    this._bindRow(tr);
    this._renumberRows();
    return tr;
  }

  _addChildRow(values = {}, after = null) {
    const tr = document.createElement("tr");
    tr.dataset.status = "draft";
    tr.innerHTML = `
      <td class="text-muted iff-row-number"></td>
      <td><select class="form-select form-select-sm no-ts iff-cell" data-field="parent" required></select></td>
      <td><select class="form-select form-select-sm no-ts iff-cell" data-field="device_bay" required></select></td>
      ${TABLE_FIELDS.map((field) => `<td class="iff-col-${field}">${this._fieldHtml(field, values[field] || "")}</td>`).join("")}
      <td class="iff-row-status text-muted">Ready</td>
      <td class="text-end">${this._rowActionsHtml()}</td>
    `;
    this._insertRow(this.childTbody, tr, after);
    this._hydrateChildSelects(tr);
    this._applyRowValues(tr, values);
    this._bindChildRow(tr);
    this._renumberTable(this.childTbody);
    return tr;
  }

  _addRackURow(values = {}, after = null) {
    const tr = document.createElement("tr");
    tr.dataset.status = "draft";
    tr.innerHTML = `
      <td class="text-muted iff-row-number"></td>
      ${TABLE_FIELDS.map((field) => `<td class="iff-col-${field}">${this._fieldHtml(field, values[field] || "")}</td>`).join("")}
      <td class="iff-row-status text-muted">Ready</td>
      <td class="text-end">${this._rowActionsHtml()}</td>
    `;
    this._insertRow(this.rackUTbody, tr, after);
    this._hydrateSelects(tr);
    this._applyRowValues(tr, values);
    this._bindRackURow(tr);
    this._renumberTable(this.rackUTbody);
    return tr;
  }

  _addPopulateRow(values = {}, after = null) {
    const tr = document.createElement("tr");
    tr.dataset.status = "draft";
    tr.innerHTML = `
      <td class="text-muted iff-row-number"></td>
      <td><select class="form-select form-select-sm no-ts iff-cell" data-field="parent" required></select></td>
      <td><select class="form-select form-select-sm no-ts iff-cell" data-field="device_bay" required></select></td>
      <td><select class="form-select form-select-sm no-ts iff-cell" data-field="device" required></select></td>
      <td class="iff-row-status text-muted">Ready</td>
      <td class="text-end">${this._rowActionsHtml()}</td>
    `;
    this._insertRow(this.populateTbody, tr, after);
    this._hydratePopulateSelects(tr);
    this._applyRowValues(tr, values);
    this._bindPopulateRow(tr);
    this._renumberTable(this.populateTbody);
    return tr;
  }

  _rowActionsHtml() {
    return `
      <button class="btn btn-sm btn-outline-secondary iff-clone-row" type="button" title="Duplicate row">
        <i class="mdi mdi-content-copy"></i>
      </button>
      <button class="btn btn-sm btn-outline-danger iff-delete-row" type="button" title="Remove row">
        <i class="mdi mdi-close"></i>
      </button>
    `;
  }

  _insertRow(tbody, tr, after = null) {
    if (after?.parentElement === tbody) {
      after.insertAdjacentElement("afterend", tr);
    } else {
      tbody.appendChild(tr);
    }
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
    tr.querySelector(".iff-clone-row").addEventListener("click", () => {
      this._cloneRow(tr, "device");
    });
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

  _bindChildRow(tr) {
    tr.querySelector(".iff-clone-row").addEventListener("click", () => {
      this._cloneRow(tr, "child");
    });
    tr.querySelector(".iff-delete-row").addEventListener("click", () => {
      tr.remove();
      if (!this.childTbody.children.length) this._addChildRow();
      this._renumberTable(this.childTbody);
    });

    tr.querySelectorAll(".iff-cell").forEach((cell) => {
      cell.addEventListener("keydown", (event) => this._handleKeydown(event));
      cell.addEventListener("change", () => this._handleChildDependencies(tr, cell.dataset.field));
      cell.addEventListener("input", () => this._markDraft(tr));
    });
  }

  _bindRackURow(tr) {
    tr.querySelector(".iff-clone-row").addEventListener("click", () => {
      this._cloneRow(tr, "rack-u");
    });
    tr.querySelector(".iff-delete-row").addEventListener("click", () => {
      tr.remove();
      this._renumberTable(this.rackUTbody);
    });

    tr.querySelectorAll(".iff-cell").forEach((cell) => {
      cell.addEventListener("keydown", (event) => this._handleKeydown(event));
      cell.addEventListener("change", () => this._handleDependencies(tr, cell.dataset.field));
      cell.addEventListener("input", () => this._markDraft(tr));
    });
  }

  _bindPopulateRow(tr) {
    tr.querySelector(".iff-clone-row").addEventListener("click", () => {
      this._cloneRow(tr, "populate");
    });
    tr.querySelector(".iff-delete-row").addEventListener("click", () => {
      tr.remove();
      if (!this.populateTbody.children.length) this._addPopulateRow();
      this._renumberTable(this.populateTbody);
    });

    tr.querySelectorAll(".iff-cell").forEach((cell) => {
      cell.addEventListener("keydown", (event) => this._handleKeydown(event));
      cell.addEventListener("change", () => this._handlePopulateDependencies(tr, cell.dataset.field));
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

  _hydrateChildSelects(tr) {
    this._setSelectOptions(tr.querySelector('[data-field="parent"]'), this.options.parent_devices);
    this._hydrateSelects(tr);
    this._refreshChildBaySelect(tr, false);
  }

  _hydratePopulateSelects(tr) {
    this._setSelectOptions(tr.querySelector('[data-field="parent"]'), this.options.parent_devices);
    this._setSelectOptions(tr.querySelector('[data-field="device"]'), this.options.existing_child_devices);
    this._refreshPopulateSelects(tr, false);
  }

  _hydrateRackUControls() {
    this._setSelectOptions(this.rackUControls.site, this.options.sites);
    this._setSelectOptions(this.rackUControls.role, this.options.roles);
    this._setSelectOptions(this.rackUControls.status, this.options.statuses, "active");
    this._setSelectOptions(this.rackUControls.manufacturer, this.options.manufacturers);
    this._refreshRackURackOptions();
    this._refreshRackUDeviceTypes();
  }

  _refreshRackURackOptions() {
    const siteId = this.rackUControls.site.selectedOptions?.[0]?.dataset?.id || "";
    const selected = new Set([...this.rackUControls.racks.selectedOptions].map((option) => option.value));
    const racks = this.options.racks.filter((option) => !siteId || String(option.site_id) === String(siteId));
    this._setSelectOptions(this.rackUControls.racks, racks);
    [...this.rackUControls.racks.options].forEach((option) => {
      option.selected = selected.has(option.value);
    });
  }

  _refreshRackUDeviceTypes() {
    const manufacturerId = this.rackUControls.manufacturer.selectedOptions?.[0]?.dataset?.id || "";
    const current = this.rackUControls.deviceType.value;
    const deviceTypes = this.options.device_types.filter((option) => {
      return !manufacturerId || String(option.manufacturer_id) === String(manufacturerId);
    });
    this._setSelectOptions(this.rackUControls.deviceType, deviceTypes);
    if ([...this.rackUControls.deviceType.options].some((option) => option.value === current)) {
      this.rackUControls.deviceType.value = current;
    }
  }

  _setSelectOptions(select, options, defaultValue = "") {
    if (!select) return;
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
      if (option.rackId || option.rack_id) opt.dataset.rackId = option.rackId || option.rack_id;
      if (option.parentId || option.parent_id) opt.dataset.parentId = option.parentId || option.parent_id;
      if (option.name) opt.dataset.name = option.name;
      if (option.site) opt.dataset.site = option.site;
      if (option.rack) opt.dataset.rack = option.rack;
      select.appendChild(opt);
    });
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }

  _applyRowValues(tr, values = {}) {
    Object.entries(values).forEach(([field, value]) => {
      const cell = tr.querySelector(`[data-field="${field}"]`);
      if (!cell) return;
      if (cell.tagName === "SELECT") {
        if (![...cell.options].some((option) => option.value === String(value))) {
          return;
        }
      }
      cell.value = value ?? "";
    });
    this._refreshDependentSelects(tr);
    ["device_type", "location", "rack"].forEach((field) => {
      const cell = tr.querySelector(`[data-field="${field}"]`);
      const value = values[field];
      if (cell && value && [...cell.options].some((option) => option.value === String(value))) {
        cell.value = value;
      }
    });
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

  _handleChildDependencies(tr, field) {
    this._handleDependencies(tr, field);
    if (field === "parent") {
      this._refreshChildBaySelect(tr, true);
      this._applyParentDefaults(tr);
    }
  }

  _handlePopulateDependencies(tr, field) {
    this._markDraft(tr);
    if (field === "parent") this._refreshPopulateSelects(tr, true);
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

  _refreshChildBaySelect(tr, clearCurrent = true) {
    const select = tr.querySelector('[data-field="device_bay"]');
    if (!select) return;
    const current = clearCurrent ? "" : select.value;
    const parentId = this._selectedId(tr, "parent");
    const bays = this.options.device_bays.filter((option) => {
      if (option.occupied) return false;
      return !parentId || String(option.parent_id) === String(parentId);
    });
    this._setSelectOptions(select, bays);
    if (current && [...select.options].some((option) => option.value === current)) {
      select.value = current;
    }
  }

  _refreshPopulateSelects(tr, clearCurrent = true) {
    const baySelect = tr.querySelector('[data-field="device_bay"]');
    const deviceSelect = tr.querySelector('[data-field="device"]');
    const parentId = this._selectedId(tr, "parent");
    const parentOpt = tr.querySelector('[data-field="parent"]')?.selectedOptions?.[0];
    const rackId = parentOpt?.dataset?.rackId || "";
    const siteId = parentOpt?.dataset?.siteId || "";
    const currentBay = clearCurrent ? "" : baySelect?.value;
    const currentDevice = clearCurrent ? "" : deviceSelect?.value;

    const bays = this.options.device_bays.filter((option) => {
      if (option.occupied) return false;
      return !parentId || String(option.parent_id) === String(parentId);
    });
    this._setSelectOptions(baySelect, bays);
    if (currentBay && [...baySelect.options].some((option) => option.value === currentBay)) {
      baySelect.value = currentBay;
    }

    const devices = this.options.existing_child_devices.filter((option) => {
      if (siteId && String(option.site_id) !== String(siteId)) return false;
      if (rackId && String(option.rack_id) !== String(rackId)) return false;
      return true;
    });
    this._setSelectOptions(deviceSelect, devices);
    if (currentDevice && [...deviceSelect.options].some((option) => option.value === currentDevice)) {
      deviceSelect.value = currentDevice;
    }
  }

  _applyParentDefaults(tr) {
    const parentOpt = tr.querySelector('[data-field="parent"]')?.selectedOptions?.[0];
    if (!parentOpt) return;
    const site = parentOpt.dataset.site || "";
    const rack = parentOpt.dataset.rack || "";
    const siteCell = tr.querySelector('[data-field="site"]');
    const rackCell = tr.querySelector('[data-field="rack"]');
    if (site && siteCell && !siteCell.value) {
      siteCell.value = site;
      this._handleDependencies(tr, "site");
    }
    if (rack && rackCell && !rackCell.value) rackCell.value = rack;
  }

  _selectedId(tr, field) {
    const select = tr.querySelector(`[data-field="${field}"]`);
    return select?.selectedOptions?.[0]?.dataset?.id || "";
  }

  _handleKeydown(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();

    const tbody = event.currentTarget.closest("tbody") || this.tbody;
    const cells = [...tbody.querySelectorAll(".iff-cell")];
    const index = cells.indexOf(event.currentTarget);
    let next = cells[index + 1];
    if (!next) {
      if (tbody === this.childTbody) next = this._addChildRow().querySelector(".iff-cell");
      else if (tbody === this.rackUTbody) next = this._addRackURow().querySelector(".iff-cell");
      else if (tbody === this.populateTbody) next = this._addPopulateRow().querySelector(".iff-cell");
      else next = this._addRow().querySelector(".iff-cell");
    }
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

  async _bulkCreateChildren() {
    const rows = [...this.childTbody.querySelectorAll("tr")];
    const payloadRows = rows.map((tr) => tr.dataset.status === "created" ? {} : this._childRowData(tr));
    const nonEmptyRows = payloadRows.filter((row) => this._hasData(row));
    if (!nonEmptyRows.length) {
      this._setSummaryFor(this.childSummary, "No child device rows to create.", "text-danger");
      return;
    }

    this._setBusyFor("iff-bulk-create-children", true);
    rows.forEach((tr) => {
      if (tr.dataset.status === "created") return;
      this._setRowStatus(tr, this._hasData(this._childRowData(tr)) ? "pending" : "draft", this._hasData(this._childRowData(tr)) ? "Pending" : "Ready");
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
      this._applyResultsTo(this.childTbody, result.results || []);
      if (response.ok) {
        this._setSummaryFor(this.childSummary, `Created ${result.created || 0} child device(s).`, "text-success");
        this._addChildRowIfNeeded();
      } else {
        this._setSummaryFor(this.childSummary, "Fix the highlighted child rows and try again.", "text-danger");
      }
    } catch (error) {
      this._setSummaryFor(this.childSummary, error.message || "Child bulk create failed.", "text-danger");
    } finally {
      this._setBusyFor("iff-bulk-create-children", false);
      await this._loadOptions();
      this._refreshAllBaySelects();
    }
  }

  async _generateRackURows() {
    const siteId = this.rackUControls.site.selectedOptions?.[0]?.dataset?.id || "";
    const rackIds = [...this.rackUControls.racks.selectedOptions].map((option) => option.dataset.id).filter(Boolean);
    const faces = [...this.rackUControls.faces.selectedOptions].map((option) => option.value).filter(Boolean);
    if (!siteId || !rackIds.length || !faces.length) {
      this._setSummaryFor(this.rackUSummary, "Select a site, at least one rack, and at least one face.", "text-danger");
      return;
    }

    this._setBusyFor("iff-generate-rack-u", true);
    try {
      const response = await fetch(this.config.rackUAvailabilityUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": this.config.csrf,
        },
        body: JSON.stringify({ site_id: siteId, rack_ids: rackIds, faces }),
      });
      const result = await response.json();
      if (!response.ok) {
        this._setSummaryFor(this.rackUSummary, result.error || "Could not generate rack U rows.", "text-danger");
        return;
      }

      const defaults = this._rackUDefaults();
      (result.rows || []).forEach((row) => {
        this._addRackURow({
          ...defaults,
          site: row.site || "",
          location: row.location || "",
          rack: row.rack || "",
          position: row.position || "",
          face: row.face || "",
        });
      });
      this._setSummaryFor(this.rackUSummary, `Generated ${result.count || 0} rack U row(s).`, "text-success");
    } catch (error) {
      this._setSummaryFor(this.rackUSummary, error.message || "Could not generate rack U rows.", "text-danger");
    } finally {
      this._setBusyFor("iff-generate-rack-u", false);
    }
  }

  async _bulkCreateRackU() {
    const rows = [...this.rackUTbody.querySelectorAll("tr")];
    const payloadRows = rows.map((tr) => tr.dataset.status === "created" ? {} : this._rowData(tr));
    const nonEmptyRows = payloadRows.filter((row) => this._hasData(row));
    if (!nonEmptyRows.length) {
      this._setSummaryFor(this.rackUSummary, "No rack U rows to create.", "text-danger");
      return;
    }

    this._setBusyFor("iff-bulk-create-rack-u", true);
    rows.forEach((tr) => {
      if (tr.dataset.status === "created") return;
      this._setRowStatus(tr, this._hasData(this._rowData(tr)) ? "pending" : "draft", this._hasData(this._rowData(tr)) ? "Pending" : "Ready");
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
      this._applyResultsTo(this.rackUTbody, result.results || []);
      if (response.ok) {
        this._setSummaryFor(this.rackUSummary, `Created ${result.created || 0} device(s) from rack U rows.`, "text-success");
      } else {
        this._setSummaryFor(this.rackUSummary, "Fix the highlighted rack U rows and try again.", "text-danger");
      }
    } catch (error) {
      this._setSummaryFor(this.rackUSummary, error.message || "Rack U bulk create failed.", "text-danger");
    } finally {
      this._setBusyFor("iff-bulk-create-rack-u", false);
    }
  }

  async _bulkPopulateBays() {
    const rows = [...this.populateTbody.querySelectorAll("tr")];
    const payloadRows = rows.map((tr) => tr.dataset.status === "created" ? {} : this._populateRowData(tr));
    const nonEmptyRows = payloadRows.filter((row) => row.device_id || row.device_bay_id);
    if (!nonEmptyRows.length) {
      this._setSummaryFor(this.populateSummary, "No bay rows to populate.", "text-danger");
      return;
    }

    this._setBusyFor("iff-bulk-populate-bays", true);
    rows.forEach((tr) => {
      if (tr.dataset.status === "created") return;
      const row = this._populateRowData(tr);
      this._setRowStatus(tr, row.device_id || row.device_bay_id ? "pending" : "draft", row.device_id || row.device_bay_id ? "Pending" : "Ready");
    });

    try {
      const response = await fetch(this.config.bulkPopulateUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": this.config.csrf,
        },
        body: JSON.stringify({ rows: payloadRows }),
      });
      const result = await response.json();
      this._applyPopulateResults(result.results || []);
      if (response.ok) {
        this._setSummaryFor(this.populateSummary, `Populated ${result.populated || 0} device bay(s).`, "text-success");
        this._addPopulateRowIfNeeded();
      } else {
        this._setSummaryFor(this.populateSummary, "Fix the highlighted bay rows and try again.", "text-danger");
      }
    } catch (error) {
      this._setSummaryFor(this.populateSummary, error.message || "Bay populate failed.", "text-danger");
    } finally {
      this._setBusyFor("iff-bulk-populate-bays", false);
      await this._loadOptions();
      this._refreshAllBaySelects();
    }
  }

  _rowData(tr) {
    const data = {};
    TABLE_FIELDS.forEach((field) => {
      data[field] = tr.querySelector(`[data-field="${field}"]`)?.value?.trim() || "";
    });
    return data;
  }

  _childRowData(tr) {
    const data = this._rowData(tr);
    const parentOpt = tr.querySelector('[data-field="parent"]')?.selectedOptions?.[0];
    const bayOpt = tr.querySelector('[data-field="device_bay"]')?.selectedOptions?.[0];
    data.parent = parentOpt?.value || "";
    data.device_bay = bayOpt?.dataset?.name || bayOpt?.value || "";
    if (parentOpt) {
      if (!data.site && parentOpt.dataset.site) data.site = parentOpt.dataset.site;
      if (!data.rack && parentOpt.dataset.rack) data.rack = parentOpt.dataset.rack;
    }
    return data;
  }

  _populateRowData(tr) {
    return {
      parent: tr.querySelector('[data-field="parent"]')?.value || "",
      device_id: this._selectedId(tr, "device"),
      device: tr.querySelector('[data-field="device"]')?.value || "",
      device_bay_id: this._selectedId(tr, "device_bay"),
      device_bay: tr.querySelector('[data-field="device_bay"]')?.value || "",
    };
  }

  _rackUDefaults() {
    return {
      role: this.rackUControls.role.value || "",
      status: this.rackUControls.status.value || "active",
      manufacturer: this.rackUControls.manufacturer.value || "",
      device_type: this.rackUControls.deviceType.value || "",
    };
  }

  _editableValues(tr) {
    const values = {};
    tr.querySelectorAll(".iff-cell").forEach((cell) => {
      values[cell.dataset.field] = cell.value || "";
    });
    return values;
  }

  _cloneRow(tr, kind) {
    const values = this._editableValues(tr);
    let clone;
    if (kind === "child") {
      clone = this._addChildRow(values, tr);
      this._refreshChildBaySelect(clone, false);
    } else if (kind === "rack-u") {
      clone = this._addRackURow(values, tr);
    } else if (kind === "populate") {
      clone = this._addPopulateRow(values, tr);
      this._refreshPopulateSelects(clone, false);
    } else {
      clone = this._addRow(values, tr);
    }
    this._setRowStatus(clone, "draft", "Ready");
    this._focusRowCell(clone, 0);
  }

  _hasData(row) {
    return Object.values(row).some((value) => value);
  }

  _applyResults(results) {
    this._applyResultsTo(this.tbody, results);
  }

  _applyResultsTo(tbody, results) {
    results.forEach((result) => {
      const tr = tbody.children[result.row];
      if (!tr) return;
      if (result.status === "created") {
        const label = result.url ? `<a href="${this._escape(result.url)}">${this._escape(result.name)}</a>` : this._escape(result.name);
        this._setRowStatus(tr, "created", `Created ${label}`);
      } else if (result.status === "error") {
        this._setRowStatus(tr, "error", (result.errors || ["Invalid row"]).map((e) => this._escape(e)).join("<br>"));
      }
    });
  }

  _applyPopulateResults(results) {
    results.forEach((result) => {
      const tr = this.populateTbody.children[result.row];
      if (!tr) return;
      if (result.status === "populated") {
        const label = result.device_url ? `<a href="${this._escape(result.device_url)}">${this._escape(result.device_name)}</a>` : this._escape(result.device_name);
        this._setRowStatus(tr, "created", `Installed ${label}`);
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

  _addChildRowIfNeeded() {
    const last = this.childTbody.lastElementChild;
    if (!last || this._hasData(this._childRowData(last))) this._addChildRow();
  }

  _addPopulateRowIfNeeded() {
    const last = this.populateTbody.lastElementChild;
    const row = last ? this._populateRowData(last) : {};
    if (!last || row.device_id || row.device_bay_id) this._addPopulateRow();
  }

  _focusCell(tr, fieldIndex) {
    tr.querySelectorAll(".iff-cell")[fieldIndex]?.focus();
  }

  _focusRowCell(tr, fieldIndex) {
    tr.querySelectorAll(".iff-cell")[fieldIndex]?.focus();
  }

  _renumberRows() {
    this._renumberTable(this.tbody);
  }

  _renumberTable(tbody) {
    [...tbody.querySelectorAll("tr")].forEach((tr, index) => {
      tr.querySelector(".iff-row-number").textContent = index + 1;
    });
  }

  _setBusy(isBusy) {
    document.getElementById("iff-bulk-create").disabled = isBusy;
  }

  _setBusyFor(id, isBusy) {
    document.getElementById(id).disabled = isBusy;
  }

  _setSummary(message, className) {
    this._setSummaryFor(this.summary, message, className);
  }

  _setSummaryFor(element, message, className) {
    element.className = `small ${className}`;
    element.textContent = message;
  }

  _refreshAllBaySelects() {
    this.childTbody.querySelectorAll("tr").forEach((tr) => this._refreshChildBaySelect(tr, false));
    this.populateTbody.querySelectorAll("tr").forEach((tr) => this._refreshPopulateSelects(tr, false));
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
