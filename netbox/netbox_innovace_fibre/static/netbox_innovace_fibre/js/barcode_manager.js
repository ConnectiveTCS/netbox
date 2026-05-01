const PAGE_SIZE = 50;

export class BarcodeManagerApp {
    constructor({ csrf, exportBase, importUrl }) {
        this._csrf = csrf;
        this._exportBase = exportBase;
        this._importUrl = importUrl;

        this._activeTab = 'devices';
        this._devicePage = 1;
        this._cablePage = 1;
        this._filters = { site: '', rack: '', search: '', unassigned: false };

        this._scanMode = false;
        this._scanTargetRow = null;

        this._sites = [];
        this._racks = [];

        this._init();
    }

    // ── Initialisation ────────────────────────────────────────

    _init() {
        this._bindToolbar();
        this._bindFilters();
        this._bindScanMode();
        this._bindImport();
        this._loadSites().then(() => {
            this._loadDevices();
            this._loadCables();
        });
    }

    _bindToolbar() {
        document.querySelectorAll('.bm-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => this._switchTab(btn.dataset.tab));
        });

        document.getElementById('btn-export').addEventListener('click', () => this._exportCsv());
        document.getElementById('btn-print').addEventListener('click', () => this._openPrint());

        document.getElementById('cb-select-all-devices').addEventListener('change', e => {
            document.querySelectorAll('#devices-tbody .bm-print-cb').forEach(cb => {
                cb.checked = e.target.checked;
            });
        });
        document.getElementById('cb-select-all-cables').addEventListener('change', e => {
            document.querySelectorAll('#cables-tbody .bm-print-cb').forEach(cb => {
                cb.checked = e.target.checked;
            });
        });
    }

    _bindFilters() {
        const filterSite = document.getElementById('filter-site');
        const filterRack = document.getElementById('filter-rack');

        filterSite.addEventListener('change', () => {
            this._filters.site = filterSite.value;
            this._filters.rack = '';
            filterRack.value = '';
            this._updateRackFilter();
        });

        document.getElementById('btn-apply-filters').addEventListener('click', () => {
            this._filters.site = filterSite.value;
            this._filters.rack = filterRack.value;
            this._filters.search = document.getElementById('bm-search-box').value.trim();
            this._filters.unassigned = document.getElementById('filter-unassigned').checked;
            this._devicePage = 1;
            this._cablePage = 1;
            this._loadDevices();
            this._loadCables();
        });

        document.getElementById('bm-search-box').addEventListener('keydown', e => {
            if (e.key === 'Enter') document.getElementById('btn-apply-filters').click();
        });
    }

    _bindScanMode() {
        document.getElementById('btn-scan-mode').addEventListener('click', () => this._startScanMode());
        document.getElementById('btn-scan-cancel').addEventListener('click', () => this._stopScanMode());

        const scanInput = document.getElementById('bm-scan-input');
        scanInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                const val = scanInput.value.trim();
                if (val) this._assignScanBarcode(val);
                scanInput.value = '';
            }
            if (e.key === 'Escape') this._stopScanMode();
        });
    }

    _bindImport() {
        const fileInput = document.getElementById('import-file');
        fileInput.addEventListener('change', () => {
            if (fileInput.files[0]) this._importCsv(fileInput.files[0]);
            fileInput.value = '';
        });

        document.getElementById('btn-import-close').addEventListener('click', () => {
            document.getElementById('import-modal').style.display = 'none';
            this._loadDevices();
            this._loadCables();
        });
    }

    // ── Tab switching ─────────────────────────────────────────

    _switchTab(tab) {
        this._activeTab = tab;
        document.querySelectorAll('.bm-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        document.getElementById('tab-devices').style.display = tab === 'devices' ? '' : 'none';
        document.getElementById('tab-cables').style.display = tab === 'cables' ? '' : 'none';

        const lblRack = document.getElementById('lbl-rack');
        const filterRack = document.getElementById('filter-rack');
        lblRack.style.display = tab === 'cables' ? 'none' : '';
        filterRack.style.display = tab === 'cables' ? 'none' : '';
    }

    // ── Site / rack filters ───────────────────────────────────

    async _loadSites() {
        try {
            const data = await this._apiFetch('/api/dcim/sites/?limit=500&brief=1');
            this._sites = data.results || [];
            const sel = document.getElementById('filter-site');
            this._sites.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.textContent = s.name;
                sel.appendChild(opt);
            });
        } catch (_) {}
    }

    async _updateRackFilter() {
        const sel = document.getElementById('filter-rack');
        sel.innerHTML = '<option value="">All racks</option>';
        if (!this._filters.site) return;
        try {
            const data = await this._apiFetch(`/api/dcim/racks/?site_id=${this._filters.site}&limit=500&brief=1`);
            (data.results || []).forEach(r => {
                const opt = document.createElement('option');
                opt.value = r.id;
                opt.textContent = r.name;
                sel.appendChild(opt);
            });
        } catch (_) {}
    }

    // ── Devices ───────────────────────────────────────────────

    async _loadDevices() {
        this._setStatus('<span class="bm-spinner"></span> Loading devices…');
        const tbody = document.getElementById('devices-tbody');
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px"><span class="bm-spinner"></span> Loading…</td></tr>';

        const params = new URLSearchParams({
            limit: PAGE_SIZE,
            offset: (this._devicePage - 1) * PAGE_SIZE,
        });
        if (this._filters.site) params.set('site_id', this._filters.site);
        if (this._filters.rack) params.set('rack_id', this._filters.rack);
        if (this._filters.search) params.set('q', this._filters.search);

        try {
            const data = await this._apiFetch(`/api/dcim/devices/?${params}`);
            let results = data.results || [];

            if (this._filters.unassigned) {
                results = results.filter(d => !d.custom_fields?.iff_barcode);
            }

            this._renderDeviceRows(tbody, results);
            this._renderPagination('devices-pagination', data.count, this._devicePage, page => {
                this._devicePage = page;
                this._loadDevices();
            });
            this._setStatus(`${data.count} device${data.count !== 1 ? 's' : ''}`);
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="5" style="color:#dc2626;padding:16px">Error loading devices: ${err.message}</td></tr>`;
            this._setStatus('');
        }
    }

    _renderDeviceRows(tbody, devices) {
        if (!devices.length) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--bm-text-dim)">No devices found</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        devices.forEach(dev => {
            const tr = document.createElement('tr');
            tr.dataset.deviceId = dev.id;
            tr.dataset.deviceName = dev.name || '';
            tr.dataset.deviceUrl = dev.url || '';
            const barcode = dev.custom_fields?.iff_barcode || '';
            const rack = dev.rack?.name || '';
            const location = dev.location?.name || '';
            const rackLoc = rack && location ? `${rack} / ${location}` : (rack || location || '—');

            tr.innerHTML = `
                <td><input type="checkbox" class="bm-print-cb" data-id="${dev.id}"></td>
                <td><a class="bm-link" href="/dcim/devices/${dev.id}/" target="_blank">${this._esc(dev.name || '—')}</a></td>
                <td>${this._esc(dev.site?.name || '—')}</td>
                <td>${this._esc(rackLoc)}</td>
                <td><input type="text" class="bm-barcode-input" data-id="${dev.id}"
                     data-type="device" value="${this._esc(barcode)}"
                     placeholder="scan or type…" spellcheck="false" autocomplete="off"></td>`;
            tbody.appendChild(tr);

            tr.addEventListener('click', e => {
                if (!this._scanMode) return;
                if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') return;
                this._setScanTarget(tr);
            });

            const input = tr.querySelector('.bm-barcode-input');
            this._bindBarcodeInput(input, 'device', dev.id);
        });
    }

    // ── Cables ────────────────────────────────────────────────

    async _loadCables() {
        this._setStatus('<span class="bm-spinner"></span> Loading cables…');
        const tbody = document.getElementById('cables-tbody');
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px"><span class="bm-spinner"></span> Loading…</td></tr>';

        const params = new URLSearchParams({
            limit: PAGE_SIZE,
            offset: (this._cablePage - 1) * PAGE_SIZE,
        });
        if (this._filters.search) params.set('q', this._filters.search);

        try {
            const data = await this._apiFetch(`/api/dcim/cables/?${params}`);
            let results = data.results || [];

            if (this._filters.unassigned) {
                results = results.filter(c =>
                    !c.custom_fields?.iff_barcode_a && !c.custom_fields?.iff_barcode_b
                );
            }

            this._renderCableRows(tbody, results);
            this._renderPagination('cables-pagination', data.count, this._cablePage, page => {
                this._cablePage = page;
                this._loadCables();
            });
            if (this._activeTab === 'cables') {
                this._setStatus(`${data.count} cable${data.count !== 1 ? 's' : ''}`);
            }
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" style="color:#dc2626;padding:16px">Error loading cables: ${err.message}</td></tr>`;
            this._setStatus('');
        }
    }

    _renderCableRows(tbody, cables) {
        if (!cables.length) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--bm-text-dim)">No cables found</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        cables.forEach(cable => {
            const tr = document.createElement('tr');
            tr.dataset.cableId = cable.id;

            const label = cable.label || `Cable #${cable.id}`;
            const bcA = cable.custom_fields?.iff_barcode_a || '';
            const bcB = cable.custom_fields?.iff_barcode_b || '';

            const aDesc = this._cableEndDesc(cable, 'a');
            const bDesc = this._cableEndDesc(cable, 'b');

            tr.innerHTML = `
                <td><input type="checkbox" class="bm-print-cb" data-id="${cable.id}"></td>
                <td><a class="bm-link" href="/dcim/cables/${cable.id}/" target="_blank">${this._esc(label)}</a></td>
                <td style="font-size:11px;color:var(--bm-text-dim)">${aDesc}</td>
                <td style="font-size:11px;color:var(--bm-text-dim)">${bDesc}</td>
                <td><input type="text" class="bm-barcode-input" data-id="${cable.id}"
                     data-type="cable_a" value="${this._esc(bcA)}"
                     placeholder="A-end barcode…" spellcheck="false" autocomplete="off"></td>
                <td><input type="text" class="bm-barcode-input" data-id="${cable.id}"
                     data-type="cable_b" value="${this._esc(bcB)}"
                     placeholder="B-end barcode…" spellcheck="false" autocomplete="off"></td>`;
            tbody.appendChild(tr);

            tr.addEventListener('click', e => {
                if (!this._scanMode) return;
                if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') return;
                this._setScanTarget(tr);
            });

            tr.querySelectorAll('.bm-barcode-input').forEach(input => {
                const type = input.dataset.type;
                this._bindBarcodeInput(input, type, cable.id);
            });
        });
    }

    _cableEndDesc(cable, end) {
        const terminations = cable[`${end}_terminations`] || [];
        if (!terminations.length) return '—';
        return terminations.map(t => {
            const dev = t.object?.device?.name || t.object?.name || '';
            const port = t.object?.name || '';
            return dev ? `${this._esc(dev)} › ${this._esc(port)}` : this._esc(port);
        }).join(', ');
    }

    // ── Barcode input save ─────────────────────────────────────

    _bindBarcodeInput(input, type, id) {
        let originalValue = input.value;

        const save = async () => {
            const newVal = input.value.trim();
            if (newVal === originalValue) return;
            input.classList.add('saving');
            input.disabled = true;
            try {
                await this._saveBarcode(type, id, newVal);
                originalValue = newVal;
                input.classList.remove('saving');
                input.classList.add('saved');
                input.disabled = false;
                setTimeout(() => input.classList.remove('saved'), 1500);
            } catch (err) {
                input.classList.remove('saving');
                input.classList.add('error');
                input.disabled = false;
                input.title = err.message;
                setTimeout(() => {
                    input.classList.remove('error');
                    input.value = originalValue;
                    input.title = '';
                }, 3000);
            }
        };

        input.addEventListener('blur', save);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = originalValue; input.blur(); }
        });
    }

    async _saveBarcode(type, id, value) {
        const cfValue = value || null;
        let url, body;

        if (type === 'device') {
            url = `/api/dcim/devices/${id}/`;
            body = { custom_fields: { iff_barcode: cfValue } };
        } else if (type === 'cable_a') {
            url = `/api/dcim/cables/${id}/`;
            body = { custom_fields: { iff_barcode_a: cfValue } };
        } else if (type === 'cable_b') {
            url = `/api/dcim/cables/${id}/`;
            body = { custom_fields: { iff_barcode_b: cfValue } };
        }

        const resp = await fetch(url, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': this._csrf,
            },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            const msg = this._extractApiError(errData, type);
            throw new Error(msg);
        }
    }

    _extractApiError(data, type) {
        if (data?.custom_fields) {
            const cf = data.custom_fields;
            const field = type === 'device' ? 'iff_barcode' : type === 'cable_a' ? 'iff_barcode_a' : 'iff_barcode_b';
            if (cf[field]) return Array.isArray(cf[field]) ? cf[field][0] : String(cf[field]);
        }
        if (data?.detail) return data.detail;
        return 'Save failed';
    }

    // ── Scan mode ─────────────────────────────────────────────

    _startScanMode() {
        this._scanMode = true;
        document.getElementById('bm-scan-banner').style.display = 'flex';
        document.getElementById('btn-scan-mode').classList.add('active');
        document.getElementById('bm-scan-input').focus();
    }

    _stopScanMode() {
        this._scanMode = false;
        document.getElementById('bm-scan-banner').style.display = 'none';
        document.getElementById('btn-scan-mode').classList.remove('active');
        if (this._scanTargetRow) {
            this._scanTargetRow.classList.remove('scan-target');
            this._scanTargetRow = null;
        }
    }

    _setScanTarget(row) {
        if (this._scanTargetRow) this._scanTargetRow.classList.remove('scan-target');
        this._scanTargetRow = row;
        row.classList.add('scan-target');
        document.getElementById('bm-scan-input').focus();
    }

    async _assignScanBarcode(barcode) {
        if (!this._scanTargetRow) return;
        const row = this._scanTargetRow;

        if (this._activeTab === 'devices') {
            const id = parseInt(row.dataset.deviceId, 10);
            const input = row.querySelector('.bm-barcode-input');
            if (input) {
                input.value = barcode;
                try {
                    await this._saveBarcode('device', id, barcode);
                    input.classList.add('saved');
                    setTimeout(() => input.classList.remove('saved'), 1500);
                } catch (err) {
                    input.classList.add('error');
                    setTimeout(() => input.classList.remove('error'), 2000);
                }
            }
        } else {
            const id = parseInt(row.dataset.cableId, 10);
            const inputs = row.querySelectorAll('.bm-barcode-input');
            const inputA = inputs[0];
            const inputB = inputs[1];
            // Assign to whichever end has no barcode yet; prefer A first
            const targetInput = (!inputA?.value) ? inputA : (!inputB?.value ? inputB : inputA);
            const type = targetInput === inputA ? 'cable_a' : 'cable_b';
            if (targetInput) {
                targetInput.value = barcode;
                try {
                    await this._saveBarcode(type, id, barcode);
                    targetInput.classList.add('saved');
                    setTimeout(() => targetInput.classList.remove('saved'), 1500);
                } catch (err) {
                    targetInput.classList.add('error');
                    setTimeout(() => targetInput.classList.remove('error'), 2000);
                }
            }
        }

        // Advance to next unassigned row
        this._advanceScanTarget(row);
    }

    _advanceScanTarget(currentRow) {
        const tbody = currentRow.parentElement;
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const idx = rows.indexOf(currentRow);
        for (let i = idx + 1; i < rows.length; i++) {
            const inputs = rows[i].querySelectorAll('.bm-barcode-input');
            const hasEmpty = Array.from(inputs).some(inp => !inp.value.trim());
            if (hasEmpty) {
                this._setScanTarget(rows[i]);
                rows[i].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                return;
            }
        }
        // No more unassigned rows — clear target
        currentRow.classList.remove('scan-target');
        this._scanTargetRow = null;
    }

    // ── CSV export ────────────────────────────────────────────

    _exportCsv() {
        const url = `${this._exportBase}?tab=${this._activeTab}`;
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        a.click();
    }

    // ── CSV import ────────────────────────────────────────────

    async _importCsv(file) {
        this._setStatus('<span class="bm-spinner"></span> Importing…');
        const form = new FormData();
        form.append('tab', this._activeTab);
        form.append('file', file);

        try {
            const resp = await fetch(this._importUrl, {
                method: 'POST',
                headers: { 'X-CSRFToken': this._csrf },
                body: form,
            });
            const result = await resp.json();
            this._showImportResults(result);
            this._setStatus('');
        } catch (err) {
            this._setStatus('');
            alert(`Import failed: ${err.message}`);
        }
    }

    _showImportResults(result) {
        const modal = document.getElementById('import-modal');
        const summary = document.getElementById('import-summary');
        const resultsDiv = document.getElementById('bm-import-results');

        summary.innerHTML = `<strong>${result.imported}</strong> record(s) imported.` +
            (result.errors?.length ? ` <span style="color:#dc2626">${result.errors.length} error(s).</span>` : '');

        if (result.errors?.length) {
            resultsDiv.innerHTML = result.errors.map(e =>
                `<div class="bm-err-row">Row ${e.row}: ${this._esc(e.error)}</div>`
            ).join('');
        } else {
            resultsDiv.innerHTML = '<div class="bm-ok-row">All rows imported successfully.</div>';
        }

        modal.style.display = 'flex';
    }

    // ── Print labels ──────────────────────────────────────────

    _openPrint() {
        const items = this._collectSelectedForPrint();
        if (!items.length) {
            alert('Select at least one row to print labels.');
            return;
        }

        const params = new URLSearchParams();
        params.set('type', this._activeTab === 'devices' ? 'device' : 'cable');
        params.set('items', JSON.stringify(items));

        const printUrl = `/static/netbox_innovace_fibre/barcode_labels_print.html?${params}`;
        window.open(printUrl, '_blank', 'width=900,height=700');
    }

    _collectSelectedForPrint() {
        const items = [];
        if (this._activeTab === 'devices') {
            document.querySelectorAll('#devices-tbody .bm-print-cb:checked').forEach(cb => {
                const row = cb.closest('tr');
                const id = parseInt(cb.dataset.id, 10);
                const name = row.dataset.deviceName;
                const barcode = row.querySelector('.bm-barcode-input')?.value || '';
                const site = row.cells[2]?.textContent?.trim() || '';
                const rack = row.cells[3]?.textContent?.trim() || '';
                items.push({ id, name, barcode, site, rack });
            });
        } else {
            document.querySelectorAll('#cables-tbody .bm-print-cb:checked').forEach(cb => {
                const row = cb.closest('tr');
                const id = parseInt(cb.dataset.id, 10);
                const label = row.querySelector('.bm-link')?.textContent?.trim() || `Cable #${id}`;
                const inputs = row.querySelectorAll('.bm-barcode-input');
                const barcodeA = inputs[0]?.value || '';
                const barcodeB = inputs[1]?.value || '';
                items.push({ id, label, barcodeA, barcodeB });
            });
        }
        return items;
    }

    // ── Pagination ────────────────────────────────────────────

    _renderPagination(containerId, total, currentPage, onPage) {
        const container = document.getElementById(containerId);
        const totalPages = Math.ceil(total / PAGE_SIZE);
        if (totalPages <= 1) { container.innerHTML = ''; return; }

        let html = '';
        if (currentPage > 1) {
            html += `<button class="bm-action-btn" data-page="${currentPage - 1}">‹ Prev</button>`;
        }
        html += `<span>Page ${currentPage} of ${totalPages}</span>`;
        if (currentPage < totalPages) {
            html += `<button class="bm-action-btn" data-page="${currentPage + 1}">Next ›</button>`;
        }

        container.innerHTML = html;
        container.querySelectorAll('[data-page]').forEach(btn => {
            btn.addEventListener('click', () => onPage(parseInt(btn.dataset.page, 10)));
        });
    }

    // ── Helpers ───────────────────────────────────────────────

    async _apiFetch(url) {
        const resp = await fetch(url, {
            headers: { Accept: 'application/json' },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
    }

    _setStatus(html) {
        document.getElementById('bm-status').innerHTML = html;
    }

    _esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
