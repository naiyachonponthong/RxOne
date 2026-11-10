/* RxOne Scanner: หน้าสแกนด้วยกล้องมือถือ คุยกับเว็บแอป Google Apps Script ผ่าน POST (text/plain JSON) */
(function () {
  'use strict';
  const LS = {
    get: function (k) { try { return localStorage.getItem('rxs_' + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('rxs_' + k, v); } catch (e) { } },
    del: function (k) { try { localStorage.removeItem('rxs_' + k); } catch (e) { } }
  };
  const app = document.getElementById('app');
  const esc = function (v) { return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  const S = { gas: '', token: LS.get('token') || '', boot: null, pair: '', mode: '', session: null, loc: '' };

  /* ---------- ค่าจาก QR (#pair=XXXX&gas=...) ---------- */
  const hp = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (hp.get('gas')) LS.set('gas', hp.get('gas'));
  if (hp.get('pair')) S.pair = hp.get('pair').toUpperCase();
  S.gas = LS.get('gas') || (window.RX_CONFIG && window.RX_CONFIG.gasUrl) || '';
  if (hp.toString()) history.replaceState(null, '', location.pathname);

  function toast(msg, type) {
    const t = document.getElementById('toast');
    t.className = type || '';
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.style.display = 'none'; }, type === 'er' ? 4500 : 2200);
  }
  let actx = null;
  function beep(ok) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.connect(g); g.connect(actx.destination);
      o.frequency.value = ok ? 1320 : 220; g.gain.value = 0.08;
      o.start(); o.stop(actx.currentTime + (ok ? 0.08 : 0.3));
      if (navigator.vibrate) navigator.vibrate(ok ? 40 : [80, 60, 80]);
    } catch (e) { }
  }
  function call(api, args) {
    return fetch(S.gas, { method: 'POST', body: JSON.stringify({ api: api, args: args || [] }) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r || r.status !== 'ok') {
          if (r && r.message === 'SESSION_EXPIRED') { LS.del('token'); S.token = ''; showLogin(); throw new Error('หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่'); }
          throw new Error((r && r.message) || 'เชื่อมต่อระบบไม่สำเร็จ');
        }
        return r.data;
      });
  }
  function api(name) { return call(name, [S.token].concat(Array.prototype.slice.call(arguments, 1))); }
  function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function header(title, back) {
    document.getElementById('hTitle').textContent = title;
    const b = document.getElementById('hBack');
    b.classList.toggle('hidden', !back);
    b.onclick = back || null;
    const o = document.getElementById('hOut');
    o.classList.toggle('hidden', !S.token);
    o.onclick = function () { stopCam(); call('apiLogout', [S.token]).catch(function () { }); LS.del('token'); S.token = ''; showLogin(); };
  }

  /* ---------- GS1 ---------- */
  function parseExp(v) {
    const m = String(v || '').match(/^(\d{2})(\d{2})(\d{2})$/);
    if (!m) return '';
    let y = 2000 + Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12) return '';
    if (d === 0) d = new Date(y, mo, 0).getDate();
    return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
  }
  function gs1(raw) {
    let s = String(raw || '').trim().replace(/^\]([CdeQ])\d/, '');
    const GS = String.fromCharCode(29);
    const out = {};
    const gsc = S.boot && S.boot.scan && S.boot.scan.gs_char;
    if (gsc && gsc !== GS) s = s.split(gsc).join(GS);
    const put = function (ai, v) { if (ai === '01') out.gtin = v; else if (ai === '10') out.lot = v; else if (ai === '17') out.exp = parseExp(v); };
    if (/^\(\d{2}\)/.test(s)) { const re = /\((\d{2,4})\)([^(]*)/g; let m; while ((m = re.exec(s))) put(m[1], m[2].trim()); return out.gtin ? out : null; }
    if (!/^01\d{14}/.test(s)) return null;
    const FIX = { '01': 14, '11': 6, '15': 6, '17': 6 };
    let i = 0, n = 0;
    while (i < s.length && n++ < 12) {
      if (s.charAt(i) === GS) { i++; continue; }
      const ai = s.substr(i, 2);
      i += 2;
      let v;
      if (FIX[ai]) { v = s.substr(i, FIX[ai]); i += FIX[ai]; }
      else if (ai === '10' || ai === '21') { const j = s.indexOf(GS, i); v = j < 0 ? s.slice(i) : s.slice(i, j); i = j < 0 ? s.length : j + 1; }
      else break;
      put(ai, v);
    }
    return out.gtin ? out : null;
  }

  /* ---------- กล้อง ---------- */
  let stream = null, raf = 0, zx = null, lastCode = '', lastAt = 0, onCode = null;
  function stopCam() {
    cancelAnimationFrame(raf);
    if (zx) { try { zx.reset(); } catch (e) { } zx = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }
  function emit(code) {
    const now = Date.now();
    if (code === lastCode && now - lastAt < 1800) return;
    lastCode = code; lastAt = now;
    if (onCode) onCode(code);
  }
  function startCam(box, handler) {
    stopCam();
    onCode = handler;
    box.innerHTML = '<div id="cam"><video playsinline muted></video><div class="frame"></div></div>';
    const video = box.querySelector('video');
    if ('BarcodeDetector' in window) {
      const det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code', 'data_matrix', 'upc_a'] });
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(function (s) {
        stream = s; video.srcObject = s; video.play();
        const tick = function () {
          if (!stream) return;
          if (video.readyState >= 2) det.detect(video).then(function (r) { if (r && r[0]) emit(r[0].rawValue); }).catch(function () { });
          raf = requestAnimationFrame(function () { setTimeout(tick, 120); });
        };
        tick();
      }).catch(function (e) { box.innerHTML = '<div class="muted">เปิดกล้องไม่ได้: ' + esc(e.message) + ' พิมพ์รหัสในช่องด้านล่างแทนได้</div>'; });
    } else if (window.ZXing) {
      zx = new window.ZXing.BrowserMultiFormatReader();
      zx.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, function (res) { if (res) emit(res.getText()); }).catch(function (e) {
        box.innerHTML = '<div class="muted">เปิดกล้องไม่ได้: ' + esc(e.message) + '</div>';
      });
    } else box.innerHTML = '<div class="muted">เบราว์เซอร์นี้อ่านบาร์โค้ดจากกล้องไม่ได้ พิมพ์รหัสในช่องด้านล่าง</div>';
  }
  function manualInput(handler) {
    return '<label>หรือพิมพ์รหัส</label><div style="display:flex;gap:8px"><input id="manual" inputmode="text" autocomplete="off"><button class="btn" style="width:auto;margin:0" id="manualGo">ตกลง</button></div>';
  }
  function bindManual(handler) {
    const i = document.getElementById('manual'), b = document.getElementById('manualGo');
    const go = function () { const v = i.value.trim(); i.value = ''; if (v) handler(v); };
    b.onclick = go;
    i.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  }
  function sheet(html) {
    const sh = document.getElementById('sheet');
    document.getElementById('sheetBody').innerHTML = html;
    sh.style.display = 'flex';
    sh.onclick = function (e) { if (e.target === sh) closeSheet(); };
  }
  function closeSheet() { document.getElementById('sheet').style.display = 'none'; }

  /* ---------- หน้าจอ ---------- */
  function showSetup() {
    header('ตั้งค่าครั้งแรก');
    app.innerHTML = '<div class="card"><p>ใส่ที่อยู่เว็บแอปของระบบ (ลงท้าย /exec) ดูได้ที่ ตั้งค่า > Scanner มือถือ ในระบบหลัก หรือสแกน QR จากปุ่มมือถือบนคอม</p>' +
      '<label>ที่อยู่เว็บแอป</label><input id="gas" placeholder="https://script.google.com/macros/s/.../exec" value="' + esc(S.gas) + '"><button class="btn" id="save">บันทึก</button></div>';
    document.getElementById('save').onclick = function () {
      const v = document.getElementById('gas').value.trim();
      if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(v)) { toast('ที่อยู่ต้องเป็นเว็บแอป Google Apps Script', 'er'); return; }
      S.gas = v; LS.set('gas', v); start();
    };
  }
  function showLogin() {
    stopCam();
    header('เข้าสู่ระบบ');
    app.innerHTML = '<div class="card"><label>ชื่อผู้ใช้</label><input id="u" autocomplete="username"><label>รหัสผ่าน</label><input id="p" type="password" autocomplete="current-password">' +
      '<button class="btn" id="go">เข้าสู่ระบบ</button>' + (S.pair ? '<p class="muted">เข้าสู่ระบบด้วยผู้ใช้เดียวกับบนคอม เพื่อจับคู่รหัส ' + esc(S.pair) + '</p>' : '') +
      '<button class="btn light" id="chg">เปลี่ยนที่อยู่เว็บแอป</button></div>';
    document.getElementById('chg').onclick = showSetup;
    document.getElementById('go').onclick = function () {
      const b = this; b.disabled = true; b.textContent = 'กำลังเข้าสู่ระบบ';
      call('apiLogin', [document.getElementById('u').value.trim(), document.getElementById('p').value]).then(function (r) {
        S.token = r.token; LS.set('token', r.token); start();
      }).catch(function (e) { toast(e.message, 'er'); b.disabled = false; b.textContent = 'เข้าสู่ระบบ'; });
    };
  }
  function showHome() {
    stopCam();
    S.mode = '';
    header(S.boot.app_name + ' Scanner');
    app.innerHTML = '<div class="card"><div style="font-weight:700">' + esc(S.boot.user.name) + '</div><div class="muted">' + esc(S.boot.unit) + '</div></div>' +
      '<div class="grid">' +
      (S.boot.can.count ? '<button class="tile" id="mCount"><span class="ic">📋</span>นับสต็อก</button>' : '') +
      (S.boot.can.check ? '<button class="tile" id="mCheck"><span class="ic">🔎</span>ตรวจเช็คด่วน</button>' : '') +
      '<button class="tile" id="mPair"><span class="ic">💻</span>จับคู่กับคอม</button></div>';
    const on = function (id, fn) { const e = document.getElementById(id); if (e) e.onclick = fn; };
    on('mCount', showSessions);
    on('mCheck', showCheck);
    on('mPair', function () { if (S.pair) showPair(); else askPair(); });
    if (S.pair) showPair();
  }
  function askPair() {
    sheet('<div style="font-weight:700">กรอกรหัสจับคู่บนจอคอม</div><input id="pc" style="margin-top:10px;text-transform:uppercase" maxlength="6"><button class="btn" id="pcGo">จับคู่</button>');
    document.getElementById('pcGo').onclick = function () { S.pair = document.getElementById('pc').value.trim().toUpperCase(); closeSheet(); if (S.pair) showPair(); };
  }
  function showPair() {
    S.mode = 'pair';
    header('จับคู่กับคอม ' + S.pair, showHome);
    let n = 0;
    app.innerHTML = '<div id="camBox"></div><div class="card"><div>ยิงแล้วบาร์โค้ดจะไปโผล่ในหน้าที่เปิดอยู่บนคอม</div><div class="muted" id="pairN">ยังไม่ได้ส่ง</div>' + manualInput() + '</div>';
    const send = function (code) {
      api('apiPairPush', S.pair, code).then(function () { n++; beep(true); document.getElementById('pairN').textContent = 'ส่งแล้ว ' + n + ' ครั้ง ล่าสุด ' + code; })
        .catch(function (e) { beep(false); toast(e.message, 'er'); if (/หมดอายุ/.test(e.message)) { S.pair = ''; } });
    };
    startCam(document.getElementById('camBox'), send);
    bindManual(send);
  }
  function showCheck() {
    S.mode = 'check';
    header('ตรวจเช็คด่วน', showHome);
    app.innerHTML = '<div id="camBox"></div><div class="card">' + manualInput() + '</div><div id="res"></div>';
    const look = function (code) {
      const g = gs1(code);
      api('apiResolveCode', code, g ? g.gtin : '').then(function (r) {
        const box = document.getElementById('res');
        if (!r.found) { beep(false); box.innerHTML = '<div class="card"><span class="pill er">ไม่พบ</span> ' + esc(code) + '</div>'; return; }
        beep(true);
        box.innerHTML = '<div class="card"><div style="font-weight:700;font-size:18px">' + esc(r.drug.name) + '</div><div class="muted">' + esc(r.drug.code) + '</div>' +
          '<div style="font-size:28px;font-weight:700;margin:8px 0">' + Number(r.total).toLocaleString('th-TH') + ' <span class="muted">' + esc(r.drug.base_unit) + '</span></div>' +
          r.balances.map(function (b) {
            return '<div class="row"><div>' + esc(b.store_name) + '<div class="muted">ล็อต ' + esc(b.lot_no) + ' · ' + esc(b.exp || '-') + '</div></div><div style="text-align:right"><b>' + b.qty + '</b>' +
              (b.level === 'expired' ? '<div><span class="pill er">หมดอายุ</span></div>' : b.level === 'near' ? '<div><span class="pill wa">ใกล้หมดอายุ</span></div>' : '') + '</div></div>';
          }).join('') + '</div>';
      }).catch(function (e) { beep(false); toast(e.message, 'er'); });
    };
    startCam(document.getElementById('camBox'), look);
    bindManual(look);
  }
  function showSessions() {
    header('เลือกรอบตรวจนับ', showHome);
    app.innerHTML = '<div class="card muted">กำลังโหลด</div>';
    api('apiCountList', { size: 30 }).then(function (d) {
      const open = d.rows.filter(function (r) { return r.status === 'open' || r.status === 'recount'; });
      app.innerHTML = open.length ? open.map(function (r) {
        return '<button class="card" style="display:block;width:100%;text-align:left;border:0" data-id="' + esc(r.id) + '"><div style="font-weight:700">' + esc(r.session_no) + ' <span class="pill' + (r.status === 'recount' ? ' wa' : '') + '">' + esc(r.status_label) + '</span></div>' +
          '<div class="muted">' + esc(r.title) + ' · ' + esc(r.store_name) + '</div></button>';
      }).join('') : '<div class="card">ไม่มีรอบตรวจนับที่เปิดอยู่</div>';
      Array.prototype.forEach.call(app.querySelectorAll('[data-id]'), function (b) { b.onclick = function () { showCount(b.dataset.id); }; });
    }).catch(function (e) { toast(e.message, 'er'); });
  }
  function showCount(id) {
    api('apiCountGet', id).then(function (c) {
      if (!c.can.count) { toast('คุณไม่ได้อยู่ในรายชื่อผู้นับของรอบนี้', 'er'); return; }
      S.session = c;
      S.loc = LS.get('loc_' + c.id) || '';
      header(c.session_no + (c.round === 2 ? ' นับซ้ำ' : ''), showSessions);
      app.innerHTML = '<div class="card" style="display:flex;justify-content:space-between;align-items:center"><div><div class="muted">ตำแหน่ง</div><div style="font-weight:700" id="loc">' + esc(S.loc || 'ยิงป้ายตำแหน่ง') + '</div></div>' +
        '<div style="text-align:right"><div class="muted">ความคืบหน้า</div><div style="font-weight:700">' + c.summary.progress + '%</div></div></div>' +
        '<div id="camBox"></div><div class="card">' + manualInput() + '</div><div class="card"><div style="font-weight:700">ที่ฉันนับล่าสุด</div><div id="mine" class="muted">-</div></div>';
      const refreshMine = function () {
        api('apiCountMine', c.id).then(function (m) {
          document.getElementById('mine').innerHTML = m.recent.length ? m.recent.slice(0, 8).map(function (r) { return '<div class="row"><div>' + esc(r.name) + '<div class="muted">ล็อต ' + esc(r.lot_no) + '</div></div><b>' + (r.qty > 0 ? '+' : '') + r.qty + '</b></div>'; }).join('') : 'ยังไม่ได้นับ';
        }).catch(function () { });
      };
      refreshMine();
      const onScan = function (code) {
        const locs = (S.boot.locations || []).filter(function (l) { return l.store_id === c.store_id && l.code === code.toUpperCase(); });
        if (locs.length) { S.loc = locs[0].code; LS.set('loc_' + c.id, S.loc); document.getElementById('loc').textContent = locs[0].name; beep(true); return; }
        const g = gs1(code);
        api('apiResolveCode', code, g ? g.gtin : '').then(function (r) {
          if (!r.found) { beep(false); toast('ไม่พบรหัส ' + code, 'er'); return; }
          beep(true);
          const qty = r.kind === 'barcode' ? (r.factor || 1) : 1;
          if (r.kind === 'lot') { askQty(r.drug, [{ lot_id: r.lot_id, lot_no: r.lot.lot_no, exp: r.lot.exp }], qty, r.lot_id); return; }
          api('apiCountLots', c.store_id, r.drug.id).then(function (lots) {
            let pre = '';
            if (g && g.lot) { const h = lots.filter(function (l) { return String(l.lot_no).toUpperCase() === String(g.lot).toUpperCase(); })[0]; if (h) pre = h.lot_id; else { lots.unshift({ lot_id: '__gs', lot_no: g.lot, exp: g.exp, nw: true }); pre = '__gs'; } }
            else { const ins = lots.filter(function (l) { return l.in_store; }); if (ins.length === 1) pre = ins[0].lot_id; }
            askQty(r.drug, lots, qty, pre);
          });
        }).catch(function (e) { beep(false); toast(e.message, 'er'); });
      };
      const askQty = function (drug, lots, qty, pre) {
        sheet('<div style="font-weight:700;font-size:18px">' + esc(drug.name) + '</div><label>ล็อต</label><select id="sl">' + lots.map(function (l) {
          return '<option value="' + esc(l.lot_id) + '"' + (l.lot_id === pre ? ' selected' : '') + '>' + esc(l.lot_no + ' · ' + (l.exp || '-') + (l.nw ? ' (ล็อตใหม่)' : (l.in_store === false ? ' (ไม่อยู่ในบัญชีคลังนี้)' : ''))) + '</option>';
        }).join('') + '<option value="__new">กรอกล็อตใหม่</option></select><div id="nl" class="hidden"><label>เลขล็อต</label><input id="nln"><label>วันหมดอายุ (ปปปป-ดด-วว)</label><input id="nle" placeholder="2028-12-31"></div>' +
          '<label>จำนวน (' + esc(drug.base_unit) + ')</label><input id="sq" type="number" inputmode="numeric" value="' + qty + '"><button class="btn" id="sok">บันทึก</button><button class="btn light" id="scx">ยกเลิก</button>');
        const sel = document.getElementById('sl');
        sel.onchange = function () { document.getElementById('nl').classList.toggle('hidden', sel.value !== '__new'); };
        document.getElementById('scx').onclick = closeSheet;
        document.getElementById('sok').onclick = function () {
          const q = Math.round(Number(document.getElementById('sq').value));
          if (!q) { toast('กรุณากรอกจำนวน', 'er'); return; }
          const it = { drug_id: drug.id, qty: q, loc: S.loc };
          if (sel.value === '__new') { it.lot_no = document.getElementById('nln').value.trim(); it.exp = document.getElementById('nle').value.trim(); if (!it.lot_no) { toast('กรุณากรอกเลขล็อต', 'er'); return; } }
          else if (sel.value === '__gs') { const l = lots[0]; it.lot_no = l.lot_no; it.exp = l.exp; }
          else it.lot_id = sel.value;
          api('apiCountScan', c.id, [it], 'mobile', rid()).then(function (r) {
            closeSheet(); beep(true); toast('บันทึกแล้ว ยอดที่คุณนับล็อตนี้ ' + r.totals[0].mine, 'ok'); refreshMine();
          }).catch(function (e) { beep(false); toast(e.message, 'er'); });
        };
      };
      startCam(document.getElementById('camBox'), onScan);
      bindManual(onScan);
    }).catch(function (e) { toast(e.message, 'er'); });
  }

  function start() {
    if (!S.gas) { showSetup(); return; }
    if (!S.token) { showLogin(); return; }
    header('กำลังโหลด');
    api('apiBootstrapScan').then(function (b) {
      S.boot = b;
      document.querySelector('meta[name=theme-color]').setAttribute('content', b.primary || '#0D9488');
      document.documentElement.style.setProperty('--p', b.primary || '#0D9488');
      showHome();
    }).catch(function (e) { toast(e.message, 'er'); if (!S.token) showLogin(); else app.innerHTML = '<div class="card">เชื่อมต่อไม่ได้: ' + esc(e.message) + '<button class="btn light" id="rt">ลองใหม่</button></div>'; const r = document.getElementById('rt'); if (r) r.onclick = start; });
  }
  start();
})();
