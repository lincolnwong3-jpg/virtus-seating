(function () {
	'use strict';

	var S = window.SEATING || {};
	var state = {
		plan: { event: '', title: '', planName: '', saveId: '', tables: [], guests: [], updatedAt: '', activeLayout: 'option2' },
		layouts: { option1: [], option2: [] },
		saves: [],
		csrf: S.csrf || '',
		selectedGuestId: null,
		selectedTableId: null,
		dragGuestId: null,
		filter: '',
		groupFilter: '',
		dirty: false,
		view: { scale: 1, x: 0, y: 0 },
		spaceDown: false
	};

	var $ = function (sel, root) { return (root || document).querySelector(sel); };
	var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

	var LS_PLAN = 'virtus_seating_plan_v1';
	var LS_SAVES = 'virtus_seating_saves_v1';
	var LS_MANIFEST = 'virtus_seating_manifest_v1';

	function lsGet(key, fallback) {
		try {
			var raw = localStorage.getItem(key);
			if (!raw) return fallback;
			return JSON.parse(raw);
		} catch (e) {
			return fallback;
		}
	}
	function lsSet(key, val) {
		localStorage.setItem(key, JSON.stringify(val));
	}

	function splitCsvLine(line) {
		var out = [];
		var cur = '';
		var inQ = false;
		for (var i = 0; i < line.length; i++) {
			var c = line.charAt(i);
			if (c === '"') {
				if (inQ && line.charAt(i + 1) === '"') { cur += '"'; i++; continue; }
				inQ = !inQ;
				continue;
			}
			if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
			cur += c;
		}
		out.push(cur);
		return out;
	}

	function parseCsvGuests(text) {
		text = String(text || '').replace(/^\uFEFF/, '');
		var lines = text.split(/\r?\n/).filter(function (l) { return l !== ''; });
		if (lines.length < 2) return [];
		var headers = splitCsvLine(lines[0]).map(function (h) { return h.trim().toLowerCase(); });
		var guests = [];
		for (var r = 1; r < lines.length; r++) {
			var cols = splitCsvLine(lines[r]);
			var row = {};
			headers.forEach(function (h, i) { row[h] = (i < cols.length ? cols[i] : '').trim(); });
			var name = row['name'] || ((row['first_name'] || '') + ' ' + (row['last_name'] || '')).trim();
			if (!name) continue;
			var ln = name.toLowerCase();
			if (ln === 'lincoln wong' || ln === 'irene' || ln.indexOf('lincoln testing') >= 0) continue;
			var group = row['company / organisation'] || row['specialty in'] || '';
			var diet = row['dietary restrictions'] || '';
			if (/^(na|n\/a|nil|none|no)$/i.test(diet)) diet = 'None';
			guests.push({
				id: newId('g'), name: name, email: row['email'] || '',
				group: group, diet: diet, photo: false,
				tableId: null, seat: null, mustNear: [], mustNotNear: [], note: ''
			});
			var spouseJoin = row['will your spouse join us?'] || '';
			var spouseName = '';
			Object.keys(row).forEach(function (k) {
				if (/spouse/.test(k) && /name/.test(k) && row[k]) spouseName = row[k];
			});
			if (/^(yes|y)$/i.test(spouseJoin) && spouseName) {
				guests.push({
					id: newId('g'), name: spouseName, email: '',
					group: group ? (group + ' (spouse)') : 'Spouse',
					diet: '', photo: false, tableId: null, seat: null,
					mustNear: [name], mustNotNear: [],
					note: 'Spouse of ' + name
				});
			}
		}
		return guests;
	}

	function planCounts(plan) {
		var guests = (plan && plan.guests) || [];
		var seated = guests.filter(function (g) { return g.tableId; }).length;
		return { guestCount: guests.length, seatedCount: seated };
	}

	function staticApi(action, opts) {
		opts = opts || {};
		var body = opts.body || {};
		return Promise.resolve().then(function () {
			if (action === 'login' || action === 'me') {
				return { ok: true, authed: true, csrf: 'static', title: 'Virtus Medical Partners Dinner 2026' };
			}
			if (action === 'logout') return { ok: true };

			if (action === 'layouts' || action === 'load') {
				return Promise.all([
					fetch('data/layouts.json', { cache: 'no-store' }).then(function (r) { return r.json(); }),
					fetch('data/partners-dinner-2026.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () {
						return { event: 'partners-dinner-2026', title: 'Virtus Medical Partners Dinner 2026', tables: [], guests: [], activeLayout: 'option1' };
					})
				]).then(function (pair) {
					var layouts = pair[0];
					var seed = pair[1];
					var plan = lsGet(LS_PLAN, null) || seed;
					if (!plan.activeLayout) plan.activeLayout = 'option1';
					var saves = lsGet(LS_MANIFEST, []);
					if (action === 'layouts') return { ok: true, layouts: layouts, csrf: 'static' };
					return { ok: true, plan: plan, layouts: layouts, saves: saves, csrf: 'static' };
				});
			}

			if (action === 'listSaves') {
				return { ok: true, saves: lsGet(LS_MANIFEST, []), csrf: 'static' };
			}

			if (action === 'save') {
				var plan = body.plan || lsGet(LS_PLAN, {});
				var name = (body.planName || plan.planName || plan.title || 'Untitled').trim() || 'Untitled';
				var asVersion = body.asVersion !== false;
				plan.planName = name;
				plan.updatedAt = new Date().toISOString();
				if (asVersion) {
					var id = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' +
						name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' +
						Math.random().toString(16).slice(2, 8);
					plan.saveId = id;
					var bag = lsGet(LS_SAVES, {});
					bag[id] = JSON.parse(JSON.stringify(plan));
					lsSet(LS_SAVES, bag);
					var counts = planCounts(plan);
					var entry = {
						id: id, name: name, savedAt: plan.updatedAt,
						guestCount: counts.guestCount, seatedCount: counts.seatedCount,
						activeLayout: plan.activeLayout || ''
					};
					var manifest = lsGet(LS_MANIFEST, []);
					manifest.unshift(entry);
					if (manifest.length > 80) {
						manifest.slice(80).forEach(function (old) { delete bag[old.id]; });
						manifest = manifest.slice(0, 80);
						lsSet(LS_SAVES, bag);
					}
					lsSet(LS_MANIFEST, manifest);
					lsSet(LS_PLAN, plan);
					return { ok: true, plan: plan, entry: entry, saves: manifest, csrf: 'static' };
				}
				lsSet(LS_PLAN, plan);
				return { ok: true, plan: plan, saves: lsGet(LS_MANIFEST, []), csrf: 'static' };
			}

			if (action === 'openSave') {
				var sid = String(body.id || '');
				var bag2 = lsGet(LS_SAVES, {});
				if (!bag2[sid]) {
					var err = new Error('Save not found');
					err.status = 404;
					throw err;
				}
				var opened = JSON.parse(JSON.stringify(bag2[sid]));
				opened.saveId = sid;
				lsSet(LS_PLAN, opened);
				return fetch('data/layouts.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (layouts) {
					return { ok: true, plan: opened, layouts: layouts, saves: lsGet(LS_MANIFEST, []), csrf: 'static' };
				});
			}

			if (action === 'deleteSave') {
				var delId = String(body.id || '');
				var bag3 = lsGet(LS_SAVES, {});
				delete bag3[delId];
				lsSet(LS_SAVES, bag3);
				var man = lsGet(LS_MANIFEST, []).filter(function (e) { return e.id !== delId; });
				lsSet(LS_MANIFEST, man);
				return { ok: true, saves: man, csrf: 'static' };
			}

			if (action === 'import') {
				var incoming = parseCsvGuests(body.csv || '');
				var planImp = lsGet(LS_PLAN, null);
				if (!planImp) {
					return fetch('data/partners-dinner-2026.json', { cache: 'no-store' })
						.then(function (r) { return r.json(); })
						.catch(function () { return { guests: [], tables: [], title: 'Virtus Medical Partners Dinner 2026', activeLayout: 'option1' }; })
						.then(function (seed) {
							return finishImport(seed, incoming, body.mode);
						});
				}
				return finishImport(planImp, incoming, body.mode);
			}

			if (action === 'export') {
				var e = new Error('CSV export removed. Use Export PDF.');
				e.status = 410;
				throw e;
			}
			throw new Error('Unknown action ' + action);
		});
	}

	function finishImport(plan, incoming, mode) {
		mode = String(mode || 'merge').toLowerCase();
		if (mode === 'replace') {
			plan.guests = incoming;
		} else {
			var existing = plan.guests || [];
			incoming.forEach(function (g) {
				var hit = existing.find(function (x) {
					return (g.email && x.email && g.email.toLowerCase() === x.email.toLowerCase()) ||
						(x.name && g.name && x.name.toLowerCase() === g.name.toLowerCase());
				});
				if (hit) {
					if (!g.tableId) { g.tableId = hit.tableId; g.seat = hit.seat; }
					g.id = hit.id;
					existing = existing.filter(function (x) { return x.id !== hit.id; }).concat([g]);
				} else {
					existing.push(g);
				}
			});
			plan.guests = existing;
		}
		plan.updatedAt = new Date().toISOString();
		lsSet(LS_PLAN, plan);
		return { ok: true, imported: incoming.length, plan: plan, csrf: 'static' };
	}

	function api(action, opts) {
		if (S.static) return staticApi(action, opts);
		opts = opts || {};
		var method = opts.method || (opts.body || opts.formData ? 'POST' : 'GET');
		var url = 'api.php?action=' + encodeURIComponent(action);
		var headers = {};
		var body = null;
		if (opts.formData) {
			body = opts.formData;
			if (state.csrf) body.append('csrf', state.csrf);
		} else if (opts.body) {
			headers['Content-Type'] = 'application/json';
			if (state.csrf) headers['X-Seating-Csrf'] = state.csrf;
			var payload = Object.assign({ action: action, csrf: state.csrf }, opts.body);
			body = JSON.stringify(payload);
		}
		return fetch(url, { method: method, headers: headers, body: body, credentials: 'same-origin' })
			.then(function (r) {
				var ct = r.headers.get('content-type') || '';
				if (ct.indexOf('application/json') >= 0) {
					return r.json().then(function (j) {
						if (!r.ok || j.ok === false) {
							var err = new Error((j && j.error) || ('HTTP ' + r.status));
							err.status = r.status;
							throw err;
						}
						if (j.csrf) state.csrf = j.csrf;
						return j;
					});
				}
				if (!r.ok) throw new Error('HTTP ' + r.status);
				return r;
			});
	}

	function setStatus(msg) {
		$('#statusText').textContent = msg;
	}

	function guestById(id) {
		return state.plan.guests.find(function (g) { return g.id === id; });
	}
	function tableById(id) {
		return state.plan.tables.find(function (t) { return t.id === id; });
	}

	/** CSS group key + short badge label */
	function isSpouseGuest(guestOrGroup, note) {
		var g = '';
		var n = '';
		if (guestOrGroup && typeof guestOrGroup === 'object') {
			g = String(guestOrGroup.group || '').toLowerCase();
			n = String(guestOrGroup.note || '').toLowerCase();
		} else {
			g = String(guestOrGroup || '').toLowerCase();
			n = String(note || '').toLowerCase();
		}
		return g.indexOf('spouse') >= 0 ||
			g.indexOf('plus-one') >= 0 ||
			g.indexOf('plus one') >= 0 ||
			n.indexOf('spouse') >= 0 ||
			n.indexOf('plus-one') >= 0 ||
			n.indexOf('plus one') >= 0;
	}

	/** @param {string|object} groupOrGuest — group string or full guest (checks note for spouse) */
	function groupInfo(groupOrGuest, note) {
		if (isSpouseGuest(groupOrGuest, note)) {
			return { key: 'spouse', short: 'Sp', label: 'Spouse / Plus-one' };
		}
		var group = groupOrGuest && typeof groupOrGuest === 'object'
			? (groupOrGuest.group || '')
			: (groupOrGuest || '');
		var g = String(group || '').toLowerCase();
		if (g.indexOf('virtus dr') >= 0 || g.indexOf('virtus doctor') >= 0) {
			return { key: 'virtus-dr', short: 'Dr', label: 'Virtus Dr' };
		}
		if (g.indexOf('allied') >= 0) {
			return { key: 'allied', short: 'AH', label: 'Allied' };
		}
		if (g.indexOf('staff') >= 0) {
			return { key: 'staff', short: 'St', label: 'Staff' };
		}
		if (g.indexOf('outsider') >= 0 || g.indexOf('vip') >= 0) {
			return { key: 'vip', short: 'VIP', label: 'Outsider / VIP' };
		}
		return { key: 'other', short: '·', label: group || 'Other' };
	}

	function nameMatch(a, b) {
		a = String(a || '').toLowerCase().replace(/\s+/g, ' ').trim();
		b = String(b || '').toLowerCase().replace(/\s+/g, ' ').trim();
		if (!a || !b) return false;
		if (a === b) return true;
		return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
	}

	function guestsAtTable(tableId) {
		return state.plan.guests.filter(function (g) { return g.tableId === tableId; });
	}

	function seatGuest(tableId, seat) {
		return state.plan.guests.find(function (g) {
			return g.tableId === tableId && Number(g.seat) === Number(seat);
		});
	}

	/** Soft rule evaluation */
	function evaluateRules() {
		var warnings = [];
		state.plan.guests.forEach(function (g) {
			g._warn = false;
			if (!g.tableId) return;
			var tableMates = guestsAtTable(g.tableId);
			(g.mustNear || []).forEach(function (want) {
				if (!want) return;
				var found = tableMates.some(function (m) {
					return m.id !== g.id && nameMatch(m.name, want);
				});
				if (!found) {
					g._warn = true;
					warnings.push(g.name + ' should sit near “' + want + '” (not at same table)');
				}
			});
			(g.mustNotNear || []).forEach(function (avoid) {
				if (!avoid) return;
				var hit = tableMates.find(function (m) {
					return m.id !== g.id && nameMatch(m.name, avoid);
				});
				if (hit) {
					g._warn = true;
					hit._warn = true;
					warnings.push(g.name + ' should not sit near ' + hit.name);
				}
			});
		});
		return warnings;
	}

	function markDirty() {
		state.dirty = true;
		setStatus('Unsaved changes');
	}

	function renderWarns(warnings) {
		var pill = $('#warnCount');
		if (warnings.length) {
			pill.hidden = false;
			pill.textContent = warnings.length + ' rule warning' + (warnings.length > 1 ? 's' : '');
		} else {
			pill.hidden = true;
		}
		var ul = $('#globalWarns');
		ul.innerHTML = '';
		warnings.forEach(function (w) {
			var li = document.createElement('li');
			li.textContent = w;
			ul.appendChild(li);
		});
	}

	function updateGroupFilter() {
		var groups = {};
		state.plan.guests.forEach(function (g) {
			if (g.group) groups[g.group] = true;
		});
		var sel = $('#poolFilter');
		var cur = sel.value;
		sel.innerHTML = '<option value="">All groups</option>';
		Object.keys(groups).sort().forEach(function (g) {
			var opt = document.createElement('option');
			opt.value = g;
			opt.textContent = g;
			sel.appendChild(opt);
		});
		sel.value = cur;
		var dl = $('#groupList');
		dl.innerHTML = '';
		Object.keys(groups).sort().forEach(function (g) {
			var opt = document.createElement('option');
			opt.value = g;
			dl.appendChild(opt);
		});
	}

	function renderPool() {
		var list = $('#poolList');
		list.innerHTML = '';
		var q = state.filter.toLowerCase();
		var unseated = state.plan.guests.filter(function (g) {
			if (g.tableId) return false;
			if (state.groupFilter && g.group !== state.groupFilter) return false;
			if (!q) return true;
			return (g.name + ' ' + g.group + ' ' + g.note).toLowerCase().indexOf(q) >= 0;
		});
		$('#poolCount').textContent = String(unseated.length);
		unseated.sort(function (a, b) { return a.name.localeCompare(b.name); });
		unseated.forEach(function (g) {
			var gi = groupInfo(g);
			var li = document.createElement('li');
			li.className = 'guest-chip grp-' + gi.key + (g.id === state.selectedGuestId ? ' selected' : '') + (g._warn ? ' has-warn' : '');
			li.draggable = true;
			li.dataset.guestId = g.id;
			li.innerHTML = '<span class="chip-row"><span class="grp-badge"></span><span class="name"></span></span><span class="meta"></span>';
			li.querySelector('.grp-badge').textContent = gi.short;
			li.querySelector('.grp-badge').title = gi.label;
			li.querySelector('.name').textContent = g.name;
			var meta = [gi.label, g.diet, g.photo ? 'photo' : ''].filter(Boolean).join(' · ');
			li.querySelector('.meta').textContent = meta;
			li.addEventListener('click', function () {
				state.selectedGuestId = g.id;
				state.selectedTableId = null;
				renderAll();
			});
			li.addEventListener('dragstart', function (e) {
				state.dragGuestId = g.id;
				li.classList.add('dragging');
				e.dataTransfer.setData('text/plain', g.id);
				e.dataTransfer.effectAllowed = 'move';
			});
			li.addEventListener('dragend', function () {
				li.classList.remove('dragging');
				state.dragGuestId = null;
				$$('.seat.drop-target').forEach(function (el) { el.classList.remove('drop-target'); });
			});
			list.appendChild(li);
		});
	}

	function seatPositions(n, shape) {
		var positions = [];
		if (shape === 'long') {
			// 6 default: 3 top + 3 bottom
			for (var i = 0; i < n; i++) {
				positions.push({ index: i, mode: 'flow' });
			}
			return positions;
		}
		for (var s = 0; s < n; s++) {
			var angle = (Math.PI * 2 * s) / n - Math.PI / 2;
			var r = 46;
			positions.push({
				index: s,
				mode: 'abs',
				left: 50 + r * Math.cos(angle),
				top: 50 + r * Math.sin(angle)
			});
		}
		return positions;
	}

	function canvasSizeFor(layoutKey) {
		// same canvas for option1/2 — 6 seats (2×3); box h=148×168 / v=132×188; pitch gap≥30
		return { w: 1900, h: 960 };
	}

	function applyViewTransform() {
		var canvas = $('#canvas');
		if (!canvas) return;
		var v = state.view;
		canvas.style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.scale + ')';
		var lab = $('#btnZoomReset');
		if (lab) lab.textContent = Math.round(v.scale * 100) + '%';
	}

	function setZoom(nextScale, pivotClientX, pivotClientY) {
		var viewport = $('#canvasViewport');
		var canvas = $('#canvas');
		if (!viewport || !canvas) return;
		var min = 0.35;
		var max = 3;
		var scale = Math.max(min, Math.min(max, nextScale));
		var rect = viewport.getBoundingClientRect();
		var cx = (pivotClientX != null ? pivotClientX : rect.left + rect.width / 2) - rect.left;
		var cy = (pivotClientY != null ? pivotClientY : rect.top + rect.height / 2) - rect.top;
		var prev = state.view.scale;
		// keep point under cursor stable
		state.view.x = cx - (cx - state.view.x) * (scale / prev);
		state.view.y = cy - (cy - state.view.y) * (scale / prev);
		state.view.scale = scale;
		applyViewTransform();
	}

	function zoomBy(factor, pivotClientX, pivotClientY) {
		setZoom(state.view.scale * factor, pivotClientX, pivotClientY);
	}

	function zoomFit() {
		var viewport = $('#canvasViewport');
		var layoutKey = state.plan.activeLayout || 'option1';
		var size = canvasSizeFor(layoutKey);
		if (!viewport) return;
		var pad = 12;
		var vw = viewport.clientWidth - pad * 2;
		var vh = viewport.clientHeight - pad * 2;
		if (vw <= 0 || vh <= 0) return;
		// fill viewport; allow down to 0.25 for wide option1
		var scale = Math.max(0.25, Math.min(3, Math.min(vw / size.w, vh / size.h)));
		state.view.scale = scale;
		state.view.x = (viewport.clientWidth - size.w * scale) / 2;
		state.view.y = Math.max(8, (viewport.clientHeight - size.h * scale) / 2);
		applyViewTransform();
	}

	function initCanvasNav() {
		var viewport = $('#canvasViewport');
		if (!viewport || viewport.dataset.navBound) return;
		viewport.dataset.navBound = '1';

		viewport.addEventListener('wheel', function (e) {
			e.preventDefault();
			var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
			zoomBy(factor, e.clientX, e.clientY);
		}, { passive: false });

		var pan = null;
		function canPanFrom(target, e) {
			if (e.button === 1) return true; // middle
			if (state.spaceDown) return true;
			if (e.button !== 0) return false;
			if (state.dragGuestId) return false;
			// empty floor / canvas chrome — not seats / guest chips / interactive controls
			if (target.closest && target.closest('.seat, .guest-chip, .zoom-bar, .venue-thumb, .venue-modal, button, input, select, a')) return false;
			if (target.closest && target.closest('.table-label') && !target.closest('.table-node.fixed')) return false;
			return true;
		}

		viewport.addEventListener('pointerdown', function (e) {
			if (!canPanFrom(e.target, e)) return;
			pan = {
				pointerId: e.pointerId,
				startX: e.clientX,
				startY: e.clientY,
				origX: state.view.x,
				origY: state.view.y
			};
			viewport.classList.add('is-panning');
			try { viewport.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
			e.preventDefault();
		});
		viewport.addEventListener('pointermove', function (e) {
			if (!pan || e.pointerId !== pan.pointerId) return;
			state.view.x = pan.origX + (e.clientX - pan.startX);
			state.view.y = pan.origY + (e.clientY - pan.startY);
			applyViewTransform();
		});
		function endPan(e) {
			if (!pan || (e && e.pointerId !== pan.pointerId)) return;
			pan = null;
			viewport.classList.remove('is-panning');
		}
		viewport.addEventListener('pointerup', endPan);
		viewport.addEventListener('pointercancel', endPan);

		document.addEventListener('keydown', function (e) {
			if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test((e.target || {}).tagName || '')) {
				state.spaceDown = true;
				viewport.classList.add('space-pan');
				e.preventDefault();
			}
		});
		document.addEventListener('keyup', function (e) {
			if (e.code === 'Space') {
				state.spaceDown = false;
				viewport.classList.remove('space-pan');
			}
		});

		var zin = $('#btnZoomIn');
		var zout = $('#btnZoomOut');
		var zreset = $('#btnZoomReset');
		var zfit = $('#btnZoomFit');
		if (zin) zin.addEventListener('click', function () { zoomBy(1.2); });
		if (zout) zout.addEventListener('click', function () { zoomBy(1 / 1.2); });
		if (zreset) zreset.addEventListener('click', function () {
			state.view = { scale: 1, x: 0, y: 0 };
			applyViewTransform();
		});
		if (zfit) zfit.addEventListener('click', function () { zoomFit(); });
	}

	function venuePngFor(layoutKey) {
		if (layoutKey === 'option2') return 'assets/floorplan-option2.png?v=2';
		return 'assets/floorplan-option1.png?v=1';
	}

	function setVenuePng(layoutKey) {
		var src = venuePngFor(layoutKey);
		var thumbImg = $('#btnVenueThumb img');
		var modalImg = $('#venueModalImg');
		if (thumbImg) thumbImg.src = src;
		if (modalImg) modalImg.src = src;
	}

	function initVenuePopup() {
		var thumb = $('#btnVenueThumb');
		var modal = $('#venueModal');
		if (!thumb || !modal || thumb.dataset.bound) return;
		thumb.dataset.bound = '1';
		thumb.addEventListener('click', function (e) {
			e.stopPropagation();
			if (typeof modal.showModal === 'function') modal.showModal();
			else modal.setAttribute('open', '');
		});
		modal.addEventListener('click', function (e) {
			if (e.target === modal) modal.close();
		});
	}

	function renderCanvas() {
		var canvas = $('#canvas');
		canvas.innerHTML = '';
		var layoutKey = state.plan.activeLayout || 'option1';
		var size = canvasSizeFor(layoutKey);
		canvas.style.width = size.w + 'px';
		canvas.style.height = size.h + 'px';
		canvas.style.minWidth = size.w + 'px';
		canvas.style.minHeight = size.h + 'px';
		canvas.classList.remove('venue-photo');
		canvas.classList.toggle('layout-option2', layoutKey === 'option2');
		// Schematic DOM (same for option1/2) — PNG only in thumb/popup
		var lobby = document.createElement('div');
		lobby.className = 'venue-lobby';
		lobby.textContent = 'LIFTS / LOBBY';
		canvas.appendChild(lobby);
		var wall = document.createElement('div');
		wall.className = 'venue-wall';
		canvas.appendChild(wall);
		var bar = document.createElement('div');
		bar.className = 'venue-bar';
		bar.innerHTML = '<span>BAR</span>';
		canvas.appendChild(bar);
		var stairs = document.createElement('div');
		stairs.className = 'venue-stairs';
		stairs.innerHTML = '<span>STAIRS</span>';
		canvas.appendChild(stairs);
		var stage = document.createElement('div');
		stage.className = 'venue-stage';
		stage.innerHTML = '<span>STAGE</span>';
		canvas.appendChild(stage);
		var thumb = $('#btnVenueThumb');
		if (thumb) {
			thumb.hidden = false; // PNG floor plan popup for both layouts
		}
		setVenuePng(layoutKey);
		state.plan.tables.forEach(function (t) {
			var node = document.createElement('div');
			var orient = t.orient || (t.shape === 'long' ? 'h' : '');
			var isFixed = t.fixed !== false; // layout tables locked by default
			node.className = 'table-node ' + t.shape +
				(orient ? ' orient-' + orient : '') +
				(isFixed ? ' fixed' : '') +
				(t.id === state.selectedTableId ? ' selected' : '');
			node.style.left = Math.round(t.x) + 'px';
			node.style.top = Math.round(t.y) + 'px';
			node.dataset.tableId = t.id;

			var card = document.createElement('div');
			card.className = 'table-card';

			function makeSeatEl(p) {
				var seat = document.createElement('div');
				seat.className = 'seat';
				seat.dataset.tableId = t.id;
				seat.dataset.seat = String(p.index);
				if (p.mode === 'abs') {
					seat.style.left = p.left + '%';
					seat.style.top = p.top + '%';
				}
				var occ = seatGuest(t.id, p.index);
				if (occ) {
					var ogi = groupInfo(occ);
					seat.classList.add('filled', 'grp-' + ogi.key);
					if (occ._warn) seat.classList.add('warn');
					seat.draggable = true;
					seat.dataset.guestId = occ.id;
					seat.innerHTML = '';
					var sn = document.createElement('span');
					sn.className = 'seat-num';
					sn.textContent = String(p.index + 1);
					seat.appendChild(sn);
					var badge = document.createElement('span');
					badge.className = 'grp-badge';
					badge.textContent = ogi.short;
					badge.title = ogi.label;
					seat.appendChild(badge);
					var nm = document.createElement('span');
					nm.className = 'seat-name';
					nm.textContent = occ.name;
					nm.title = occ.name;
					seat.title = occ.name + (ogi.label ? ' · ' + ogi.label : '');
					seat.appendChild(nm);
					seat.addEventListener('click', function (e) {
						e.stopPropagation();
						state.selectedGuestId = occ.id;
						state.selectedTableId = t.id;
						renderAll();
					});
					seat.addEventListener('dragstart', function (e) {
						state.dragGuestId = occ.id;
						e.dataTransfer.setData('text/plain', occ.id);
						e.dataTransfer.effectAllowed = 'move';
					});
				} else {
					seat.classList.add('empty');
					seat.title = 'Seat ' + (p.index + 1) + ' — drop anyone here';
					seat.innerHTML = '<span class="seat-num">' + (p.index + 1) + '</span><span class="seat-slot">+</span>';
				}
				bindSeatDrop(seat);
				return seat;
			}

			var pos = seatPositions(t.seats, t.shape);
			if (t.shape === 'long') {
				// Mockup: 3 seats / TABLE bar / 3 seats (h = top·bot, v = left·right)
				var half = Math.ceil(pos.length / 2);
				var sideA = document.createElement('div');
				sideA.className = 'seats-row side-a';
				var sideB = document.createElement('div');
				sideB.className = 'seats-row side-b';
				pos.forEach(function (p, i) {
					(i < half ? sideA : sideB).appendChild(makeSeatEl(p));
				});
				var core = document.createElement('div');
				core.className = 'table-core';
				core.textContent = t.label;
				core.title = isFixed ? (t.label + ' · fixed on floorplan') : 'Drag to move';
				core.addEventListener('mousedown', function (e) {
					if (isFixed) return;
					startTableDrag(e, t, node);
				});
				core.addEventListener('click', function (e) {
					e.stopPropagation();
					state.selectedTableId = t.id;
					state.selectedGuestId = null;
					renderDetails();
					$$('.table-node').forEach(function (n) {
						n.classList.toggle('selected', n.dataset.tableId === t.id);
					});
				});
				card.appendChild(sideA);
				card.appendChild(core);
				card.appendChild(sideB);
			} else {
				var label = document.createElement('div');
				label.className = 'table-label';
				label.textContent = t.label;
				label.title = isFixed ? (t.label + ' · fixed on floorplan') : 'Drag to move';
				label.addEventListener('mousedown', function (e) {
					if (isFixed) return;
					startTableDrag(e, t, node);
				});
				label.addEventListener('click', function (e) {
					e.stopPropagation();
					state.selectedTableId = t.id;
					state.selectedGuestId = null;
					renderDetails();
					$$('.table-node').forEach(function (n) {
						n.classList.toggle('selected', n.dataset.tableId === t.id);
					});
				});
				card.appendChild(label);
				var seatsEl = document.createElement('div');
				seatsEl.className = 'seats';
				pos.forEach(function (p) { seatsEl.appendChild(makeSeatEl(p)); });
				card.appendChild(seatsEl);
			}
			// Drop on table chrome (label/gap only) — still free-pick: nearest empty by pointer, NOT seat order
			card.addEventListener('dragover', function (e) {
				if (e.target.closest && e.target.closest('.seat')) return;
				e.preventDefault();
				card.classList.add('table-drop');
			});
			card.addEventListener('dragleave', function () {
				card.classList.remove('table-drop');
			});
			card.addEventListener('drop', function (e) {
				if (e.target.closest && e.target.closest('.seat')) return;
				e.preventDefault();
				card.classList.remove('table-drop');
				var id = e.dataTransfer.getData('text/plain') || state.dragGuestId;
				if (!id) return;
				var empty = pickEmptySeatNearPointer(t, e);
				if (empty < 0) {
					setStatus(t.label + ' is full');
					return;
				}
				assignSeat(id, t.id, empty);
			});
			node.appendChild(card);
			canvas.appendChild(node);
		});
		applyViewTransform();
	}

	/** Any seat index OK — no fill-order. Card-gap drop: nearest empty to pointer. */
	function pickEmptySeatNearPointer(table, e) {
		var seats = $$('.seat', document.querySelector('.table-node[data-table-id="' + table.id + '"]'));
		var best = -1;
		var bestD = Infinity;
		seats.forEach(function (el) {
			var idx = Number(el.dataset.seat);
			if (seatGuest(table.id, idx)) return;
			var r = el.getBoundingClientRect();
			var cx = r.left + r.width / 2;
			var cy = r.top + r.height / 2;
			var d = (e.clientX - cx) * (e.clientX - cx) + (e.clientY - cy) * (e.clientY - cy);
			if (d < bestD) { bestD = d; best = idx; }
		});
		return best;
	}

	function bindSeatDrop(seat) {
		seat.addEventListener('dragover', function (e) {
			e.preventDefault();
			e.stopPropagation(); // don't let table card steal / force sequential fill
			seat.classList.add('drop-target');
			e.dataTransfer.dropEffect = 'move';
		});
		seat.addEventListener('dragleave', function () {
			seat.classList.remove('drop-target');
		});
		seat.addEventListener('drop', function (e) {
			e.preventDefault();
			e.stopPropagation(); // keep exact seat — any of 1–6, no order
			seat.classList.remove('drop-target');
			var id = e.dataTransfer.getData('text/plain') || state.dragGuestId;
			if (!id) return;
			assignSeat(id, seat.dataset.tableId, Number(seat.dataset.seat));
		});
	}

	function assignSeat(guestId, tableId, seatIndex) {
		var g = guestById(guestId);
		if (!g) return;
		var existing = seatGuest(tableId, seatIndex);
		if (existing && existing.id !== guestId) {
			// swap
			existing.tableId = g.tableId;
			existing.seat = g.seat;
		}
		g.tableId = tableId;
		g.seat = seatIndex;
		state.selectedGuestId = guestId;
		state.selectedTableId = tableId;
		markDirty();
		renderAll();
	}

	function unseatGuest(guestId) {
		var g = guestById(guestId);
		if (!g) return;
		g.tableId = null;
		g.seat = null;
		markDirty();
		renderAll();
	}

	var dragTable = null;
	function startTableDrag(e, table, node) {
		e.preventDefault();
		var startX = e.clientX;
		var startY = e.clientY;
		var origX = table.x;
		var origY = table.y;
		dragTable = table;
		function move(ev) {
			table.x = Math.max(0, origX + (ev.clientX - startX));
			table.y = Math.max(0, origY + (ev.clientY - startY));
			node.style.left = table.x + 'px';
			node.style.top = table.y + 'px';
		}
		function up() {
			document.removeEventListener('mousemove', move);
			document.removeEventListener('mouseup', up);
			dragTable = null;
			markDirty();
		}
		document.addEventListener('mousemove', move);
		document.addEventListener('mouseup', up);
	}

	function renderDetails() {
		var empty = $('#detailEmpty');
		var gf = $('#detailForm');
		var tf = $('#tableForm');
		gf.hidden = true;
		tf.hidden = true;
		empty.hidden = false;

		if (state.selectedGuestId) {
			var g = guestById(state.selectedGuestId);
			if (!g) return;
			empty.hidden = true;
			gf.hidden = false;
			gf.name.value = g.name;
			gf.group.value = g.group || '';
			gf.diet.value = g.diet || '';
			gf.email.value = g.email || '';
			gf.photo.checked = !!g.photo;
			gf.mustNear.value = (g.mustNear || []).join('; ');
			gf.mustNotNear.value = (g.mustNotNear || []).join('; ');
			gf.note.value = g.note || '';
			var dw = $('#detailWarns');
			dw.innerHTML = '';
			var warns = evaluateRules().filter(function (w) { return w.indexOf(g.name) === 0 || w.indexOf(g.name) > 0; });
			warns.forEach(function (w) {
				var p = document.createElement('p');
				p.textContent = w;
				p.style.color = 'var(--warn)';
				p.style.margin = '4px 0';
				p.style.fontSize = '0.85rem';
				dw.appendChild(p);
			});
			return;
		}
		if (state.selectedTableId) {
			var t = tableById(state.selectedTableId);
			if (!t) return;
			empty.hidden = true;
			tf.hidden = false;
			tf.label.value = t.label;
			tf.seats.value = t.seats;
			tf.shape.value = t.shape;
		}
	}

	function renderAll() {
		var warnings = evaluateRules();
		renderWarns(warnings);
		updateGroupFilter();
		renderPool();
		renderCanvas();
		renderDetails();
		var seated = state.plan.guests.filter(function (g) { return g.tableId; }).length;
		var total = state.plan.guests.length;
		var tables = state.plan.tables.length;
		if (!state.dirty) {
			setStatus(total + ' guests · ' + seated + ' seated · ' + tables + ' tables' +
				(state.plan.updatedAt ? ' · saved ' + state.plan.updatedAt : ''));
		}
	}

	function newId(prefix) {
		return prefix + '_' + Math.random().toString(16).slice(2, 10);
	}

	function splitNameList(val) {
		return String(val || '').split(/[;|]/).map(function (s) { return s.trim(); }).filter(Boolean);
	}

	function guestFromForm(form) {
		var name = (form.name.value || '').trim();
		if (!name) return null;
		return {
			id: newId('g'),
			name: name,
			email: (form.email.value || '').trim(),
			group: (form.group.value || '').trim(),
			diet: (form.diet.value || '').trim(),
			photo: !!(form.photo && form.photo.checked),
			tableId: null,
			seat: null,
			mustNear: splitNameList(form.mustNear.value),
			mustNotNear: splitNameList(form.mustNotNear.value),
			note: (form.note.value || '').trim()
		};
	}

	function openGuestModal() {
		var dlg = $('#guestModal');
		var form = $('#guestCreateForm');
		if (!dlg || !form) return;
		form.reset();
		if (dlg.showModal) dlg.showModal();
		else dlg.setAttribute('open', '');
		setTimeout(function () {
			if (form.name) form.name.focus();
		}, 30);
	}

	function closeGuestModal() {
		var dlg = $('#guestModal');
		if (!dlg) return;
		if (dlg.open && dlg.close) dlg.close();
		else dlg.removeAttribute('open');
	}

	/** Create custom guest → unseated pool. Returns guest or null. */
	function createGuest(opts) {
		opts = opts || {};
		var form = $('#guestCreateForm');
		if (!form) return null;
		var g = guestFromForm(form);
		if (!g) {
			setStatus('Name required');
			if (form.name) form.name.focus();
			return null;
		}
		var dup = state.plan.guests.find(function (x) {
			return x.name.toLowerCase() === g.name.toLowerCase() ||
				(g.email && x.email && x.email.toLowerCase() === g.email.toLowerCase());
		});
		if (dup && !confirm('Similar guest already exists («' + dup.name + '»). Create anyway?')) {
			return null;
		}
		state.plan.guests.push(g);
		state.selectedGuestId = g.id;
		state.selectedTableId = null;
		markDirty();
		renderAll();
		setStatus('Created «' + g.name + '» · unseated');
		if (opts.keepOpen) {
			form.name.value = '';
			form.email.value = '';
			form.note.value = '';
			if (form.photo) form.photo.checked = false;
			form.name.focus();
		} else {
			closeGuestModal();
		}
		return g;
	}

	function deleteGuest(id) {
		if (!id) return;
		var g = guestById(id);
		if (!g) return;
		if (!confirm('Delete guest «' + g.name + '»?')) return;
		state.plan.guests = state.plan.guests.filter(function (x) { return x.id !== id; });
		if (state.selectedGuestId === id) state.selectedGuestId = null;
		markDirty();
		renderAll();
		setStatus('Deleted «' + g.name + '»');
	}

	function addTable() {
		var n = state.plan.tables.length + 1;
		var seats = S.defaultSeats || 10;
		var col = (n - 1) % 4;
		var row = Math.floor((n - 1) / 4);
		state.plan.tables.push({
			id: newId('t'),
			label: 'Table ' + n,
			seats: seats,
			shape: 'round',
			x: 60 + col * 280,
			y: 60 + row * 280
		});
		state.selectedTableId = state.plan.tables[state.plan.tables.length - 1].id;
		state.selectedGuestId = null;
		markDirty();
		renderAll();
	}

	function syncPlanNameFromInput() {
		var inp = $('#planName');
		if (!inp) return;
		var name = (inp.value || '').trim();
		state.plan.planName = name;
	}

	function fillPlanNameInput() {
		var inp = $('#planName');
		if (!inp) return;
		inp.value = state.plan.planName || '';
	}

	function formatSaveWhen(iso) {
		if (!iso) return '';
		try {
			var d = new Date(iso);
			if (isNaN(d.getTime())) return iso;
			return d.toLocaleString();
		} catch (e) {
			return iso;
		}
	}

	function renderSavesList() {
		var ul = $('#savesList');
		if (!ul) return;
		ul.innerHTML = '';
		if (!state.saves || !state.saves.length) {
			ul.innerHTML = '<li class="empty">No saved versions yet. Hit Save to create one.</li>';
			return;
		}
		state.saves.forEach(function (s) {
			var li = document.createElement('li');
			if (s.id && s.id === state.plan.saveId) li.className = 'current';
			var meta = document.createElement('div');
			meta.className = 'saves-meta';
			meta.innerHTML = '<strong></strong><span></span>';
			meta.querySelector('strong').textContent = s.name || 'Untitled';
			meta.querySelector('span').textContent =
				formatSaveWhen(s.savedAt) +
				' · ' + (s.seatedCount || 0) + '/' + (s.guestCount || 0) + ' seated' +
				(s.activeLayout ? ' · ' + s.activeLayout : '') +
				(s.id === state.plan.saveId ? ' · current' : '');
			var acts = document.createElement('div');
			acts.className = 'saves-actions';
			var openBtn = document.createElement('button');
			openBtn.type = 'button';
			openBtn.className = 'btn';
			openBtn.textContent = 'Open';
			openBtn.addEventListener('click', function () { openSave(s.id); });
			var delBtn = document.createElement('button');
			delBtn.type = 'button';
			delBtn.className = 'btn ghost danger';
			delBtn.textContent = 'Del';
			delBtn.addEventListener('click', function () { deleteSave(s.id); });
			acts.appendChild(openBtn);
			acts.appendChild(delBtn);
			li.appendChild(meta);
			li.appendChild(acts);
			ul.appendChild(li);
		});
	}

	function openSavesModal() {
		return api('listSaves').then(function (j) {
			if (j.saves) state.saves = j.saves;
			renderSavesList();
			var dlg = $('#savesModal');
			if (dlg && dlg.showModal) dlg.showModal();
		}).catch(function (e) {
			setStatus('Versions: ' + e.message);
		});
	}

	function applyLoadedPlan(j) {
		state.plan = j.plan;
		if (!state.plan.activeLayout) state.plan.activeLayout = 'option2';
		if (j.layouts) state.layouts = j.layouts;
		if (j.saves) state.saves = j.saves;
		state.dirty = false;
		if (j.plan.title) $('#eventTitle').textContent = j.plan.title;
		fillPlanNameInput();
		var sel = $('#layoutSelect');
		if (sel) sel.value = state.plan.activeLayout || 'option2';
		if ((!state.plan.tables || !state.plan.tables.length) && state.layouts[state.plan.activeLayout] && state.layouts[state.plan.activeLayout].length) {
			applyLayout(state.plan.activeLayout, false);
			state.dirty = false;
		} else if (snapTablesToLayout(state.plan.activeLayout)) {
			// keep guests seated; refresh coords from layouts.json
		}
		renderAll();
		requestAnimationFrame(function () { zoomFit(); });
	}

	function openSave(id) {
		if (!id) return;
		if (state.dirty && !confirm('Discard unsaved changes and open this version?')) return;
		setStatus('Opening…');
		return api('openSave', { body: { id: id } }).then(function (j) {
			applyLoadedPlan(j);
			setStatus('Opened «' + (state.plan.planName || id) + '»');
			var dlg = $('#savesModal');
			if (dlg && dlg.open) dlg.close();
		}).catch(function (e) {
			setStatus('Open failed: ' + e.message);
		});
	}

	function openLatestSave() {
		if (!state.saves || !state.saves.length) {
			setStatus('No saved versions');
			return;
		}
		openSave(state.saves[0].id);
	}

	function deleteSave(id) {
		if (!id) return;
		if (!confirm('Delete this saved version?')) return;
		return api('deleteSave', { body: { id: id } }).then(function (j) {
			if (j.saves) state.saves = j.saves;
			renderSavesList();
			setStatus('Version deleted');
		}).catch(function (e) {
			setStatus('Delete failed: ' + e.message);
		});
	}

	function save(opts) {
		opts = opts || {};
		var asVersion = opts.asVersion !== false; // default: create version record
		syncPlanNameFromInput();
		var name = (state.plan.planName || '').trim();
		if (asVersion && !name) {
			name = window.prompt('Plan name for this save:', state.plan.title || 'Untitled') || '';
			name = name.trim();
			if (!name) {
				setStatus('Save cancelled — need a plan name');
				return;
			}
			state.plan.planName = name;
			fillPlanNameInput();
		}
		if (!name) name = state.plan.title || 'Working';
		setStatus(asVersion ? ('Saving «' + name + '»…') : 'Autosaving…');
		return api('save', { body: { plan: state.plan, planName: name, asVersion: asVersion } }).then(function (j) {
			state.plan = j.plan;
			if (j.saves) state.saves = j.saves;
			state.dirty = false;
			fillPlanNameInput();
			setStatus(asVersion
				? ('Saved «' + (state.plan.planName || name) + '» · ' + formatSaveWhen(state.plan.updatedAt))
				: ('Autosaved ' + formatSaveWhen(state.plan.updatedAt)));
			renderAll();
		}).catch(function (e) {
			setStatus('Save failed: ' + e.message);
		});
	}

	function clearSeatingAssignments() {
		state.plan.guests.forEach(function (g) {
			g.tableId = null;
			g.seat = null;
		});
	}

	function applyLayout(key, clearSeats) {
		key = key === 'option1' ? 'option1' : 'option2';
		var tables = state.layouts[key];
		if (!tables || !tables.length) {
			setStatus('Layout ' + key + ' not loaded');
			return;
		}
		if (clearSeats) clearSeatingAssignments();
		state.plan.activeLayout = key;
		state.plan.tables = tables.map(function (t) {
			return {
				id: t.id,
				label: t.label,
				seats: t.seats || 6,
				shape: t.shape || 'long',
				orient: t.orient || 'h',
				x: t.x,
				y: t.y,
				fixed: t.fixed !== false
			};
		});
		var sel = $('#layoutSelect');
		if (sel) sel.value = key;
		state.selectedTableId = null;
		markDirty();
		renderAll();
		setStatus('Layout ' + key + ' · ' + state.plan.tables.length + ' tables × 6');
	}

	/** Snap fixed tables to layouts.json coords (keeps seating; kills overlap drift) */
	function snapTablesToLayout(key) {
		key = key || state.plan.activeLayout || 'option1';
		var layout = state.layouts[key];
		if (!layout || !layout.length || !state.plan.tables || !state.plan.tables.length) return false;
		var byId = {};
		layout.forEach(function (t) { byId[t.id] = t; });
		var n = 0;
		state.plan.tables.forEach(function (t) {
			var L = byId[t.id];
			if (!L) return;
			t.x = L.x;
			t.y = L.y;
			t.orient = L.orient || t.orient;
			t.shape = L.shape || t.shape;
			t.seats = L.seats || t.seats || 6;
			t.fixed = true;
			n++;
		});
		return n > 0;
	}

	function load() {
		return api('load').then(function (j) {
			applyLoadedPlan(j);
		});
	}

	function showApp() {
		$('#loginGate').hidden = true;
		$('#app').hidden = false;
		document.body.dataset.authed = '1';
		load().catch(function (e) { setStatus(e.message); });
	}

	// Events
	var loginForm = $('#loginForm');
	if (loginForm) {
		loginForm.addEventListener('submit', function (e) { e.preventDefault(); showApp(); });
	}
	var btnLogout = $('#btnLogout');
	if (btnLogout) {
		btnLogout.addEventListener('click', function () { /* password gate off */ });
	}

	$('#btnSave').addEventListener('click', function () { save(); });
	var btnAddGuest = $('#btnAddGuest');
	if (btnAddGuest) btnAddGuest.addEventListener('click', openGuestModal);
	var btnAddGuestPool = $('#btnAddGuestPool');
	if (btnAddGuestPool) btnAddGuestPool.addEventListener('click', openGuestModal);
	var guestCreateForm = $('#guestCreateForm');
	if (guestCreateForm) {
		guestCreateForm.addEventListener('submit', function (e) {
			e.preventDefault();
			createGuest({ keepOpen: false });
		});
	}
	var btnGuestCreateAnother = $('#btnGuestCreateAnother');
	if (btnGuestCreateAnother) {
		btnGuestCreateAnother.addEventListener('click', function () {
			createGuest({ keepOpen: true });
		});
	}
	var btnGuestCancel = $('#btnGuestCancel');
	if (btnGuestCancel) btnGuestCancel.addEventListener('click', closeGuestModal);
	var guestModal = $('#guestModal');
	if (guestModal) {
		guestModal.addEventListener('click', function (e) {
			if (e.target === guestModal) closeGuestModal();
		});
	}
	var btnVersions = $('#btnVersions');
	if (btnVersions) btnVersions.addEventListener('click', openSavesModal);
	var btnOpenLatest = $('#btnOpenLatest');
	if (btnOpenLatest) btnOpenLatest.addEventListener('click', openLatestSave);
	var planNameInp = $('#planName');
	if (planNameInp) {
		planNameInp.addEventListener('change', function () {
			syncPlanNameFromInput();
			markDirty();
		});
		planNameInp.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') {
				e.preventDefault();
				syncPlanNameFromInput();
				save();
			}
		});
	}
	$('#btnAddTable').addEventListener('click', addTable);
	function exportPdf() {
		var prev = { scale: state.view.scale, x: state.view.x, y: state.view.y };
		var size = canvasSizeFor(state.plan.activeLayout || 'option1');
		// Landscape A4 printable ≈ 277×190mm → ~1048×718 CSS px @96dpi; pad margins
		var pageW = 1040;
		var pageH = 700;
		var printScale = Math.min(pageW / size.w, pageH / size.h);
		document.documentElement.style.setProperty('--print-scale', String(printScale));
		document.documentElement.style.setProperty('--print-w', Math.floor(size.w * printScale) + 'px');
		document.documentElement.style.setProperty('--print-h', Math.floor(size.h * printScale) + 'px');
		// Identity transform — print CSS applies --print-scale
		state.view = { scale: 1, x: 0, y: 0 };
		applyViewTransform();
		document.body.classList.add('exporting-pdf');
		var done = function () {
			document.body.classList.remove('exporting-pdf');
			document.documentElement.style.removeProperty('--print-scale');
			document.documentElement.style.removeProperty('--print-w');
			document.documentElement.style.removeProperty('--print-h');
			state.view = prev;
			applyViewTransform();
			window.removeEventListener('afterprint', done);
		};
		window.addEventListener('afterprint', done);
		setTimeout(function () { window.print(); }, 100);
	}
	var btnPdf = $('#btnExportPdf');
	if (btnPdf) btnPdf.addEventListener('click', exportPdf);
	var layoutSelect = $('#layoutSelect');
	if (layoutSelect) {
		layoutSelect.addEventListener('change', function () {
			var key = layoutSelect.value;
			var hasSeated = state.plan.guests.some(function (g) { return g.tableId; });
			if (hasSeated && !confirm('Switch to ' + key + '? Seated guests will return to Unseated pool.')) {
				layoutSelect.value = state.plan.activeLayout || 'option2';
				return;
			}
			applyLayout(key, true);
		});
	}
	var btnRealign = $('#btnRealign');
	if (btnRealign) {
		btnRealign.addEventListener('click', function () {
			var key = state.plan.activeLayout || 'option1';
			var layout = state.layouts[key] || [];
			var needRebuild = !state.plan.tables.length || state.plan.tables.length !== layout.length;
			if (needRebuild) {
				applyLayout(key, false);
			} else if (!snapTablesToLayout(key)) {
				applyLayout(key, false);
			}
			setStatus('Realigned ' + key + ' · ' + state.plan.tables.length + ' tables');
			markDirty();
			renderAll();
			requestAnimationFrame(function () { zoomFit(); });
			save({ asVersion: false });
		});
	}

	$('#importFile').addEventListener('change', function () {
		var file = this.files && this.files[0];
		this.value = '';
		if (!file) return;
		var reader = new FileReader();
		reader.onload = function () {
			var mode = $('#importMode').value;
			setStatus('Importing…');
			api('import', { body: { csv: reader.result, mode: mode } })
				.then(function (j) {
					state.plan = j.plan;
					state.dirty = false;
					setStatus('Imported ' + j.imported + ' rows');
					renderAll();
				})
				.catch(function (ex) { setStatus('Import failed: ' + ex.message); });
		};
		reader.readAsText(file);
	});

	$('#poolSearch').addEventListener('input', function () {
		state.filter = this.value;
		renderPool();
	});
	$('#poolFilter').addEventListener('change', function () {
		state.groupFilter = this.value;
		renderPool();
	});

	$('#detailForm').addEventListener('submit', function (e) {
		e.preventDefault();
		var g = guestById(state.selectedGuestId);
		if (!g) return;
		var f = e.target;
		g.name = f.name.value.trim();
		g.group = f.group.value.trim();
		g.diet = f.diet.value.trim();
		g.email = f.email.value.trim();
		g.photo = f.photo.checked;
		g.mustNear = f.mustNear.value.split(/[;|]/).map(function (s) { return s.trim(); }).filter(Boolean);
		g.mustNotNear = f.mustNotNear.value.split(/[;|]/).map(function (s) { return s.trim(); }).filter(Boolean);
		g.note = f.note.value.trim();
		markDirty();
		renderAll();
	});

	$('#btnUnseat').addEventListener('click', function () {
		if (state.selectedGuestId) unseatGuest(state.selectedGuestId);
	});
	var btnDelGuest = $('#btnDelGuest');
	if (btnDelGuest) {
		btnDelGuest.addEventListener('click', function () {
			if (state.selectedGuestId) deleteGuest(state.selectedGuestId);
		});
	}

	$('#tableForm').addEventListener('submit', function (e) {
		e.preventDefault();
		var t = tableById(state.selectedTableId);
		if (!t) return;
		var f = e.target;
		t.label = f.label.value.trim() || t.label;
		var seats = parseInt(f.seats.value, 10);
		if (seats >= 2 && seats <= 24) {
			// Unseat anyone beyond new capacity
			guestsAtTable(t.id).forEach(function (g) {
				if (Number(g.seat) >= seats) {
					g.tableId = null;
					g.seat = null;
				}
			});
			t.seats = seats;
		}
		t.shape = f.shape.value;
		markDirty();
		renderAll();
	});

	$('#btnDelTable').addEventListener('click', function () {
		var id = state.selectedTableId;
		if (!id) return;
		if (!confirm('Delete this table? Guests will return to unseated pool.')) return;
		guestsAtTable(id).forEach(function (g) {
			g.tableId = null;
			g.seat = null;
		});
		state.plan.tables = state.plan.tables.filter(function (t) { return t.id !== id; });
		state.selectedTableId = null;
		markDirty();
		renderAll();
	});

	// Drop on canvas empty → ignore; drop on pool → unseat
	$('#poolList').addEventListener('dragover', function (e) {
		e.preventDefault();
	});
	$('#poolList').addEventListener('drop', function (e) {
		e.preventDefault();
		var id = e.dataTransfer.getData('text/plain') || state.dragGuestId;
		if (id) unseatGuest(id);
	});

	window.addEventListener('beforeunload', function (e) {
		if (state.dirty) {
			e.preventDefault();
			e.returnValue = '';
		}
	});

	// Autosave working file only (no new version spam)
	setInterval(function () {
		if (state.dirty && document.body.dataset.authed === '1') {
			save({ asVersion: false });
		}
	}, 45000);

	initCanvasNav();
	initVenuePopup();

	if (S.authed) {
		showApp();
	}
})();
