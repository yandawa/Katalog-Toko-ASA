/**
 * ASA Bike Shop — Google Apps Script (versi 2)
 * ------------------------------------------------------------
 * Dipasang di Google Sheets katalog (Extensions > Apps Script).
 *
 *  Web (Deploy > Web app):
 *  - GET                        : katalog publik (TANPA harga)
 *  - POST {action:'login'}      : login (username + PIN) -> token sesi 30 hari
 *  - POST {action:'logout'}     : hapus token
 *  - POST {action:'products'}   : katalog lengkap dengan harga (butuh token)
 *  - POST {action:'order'}      : cek & kurangi stok, catat ke tab "Pesanan" + "Detail Pesanan"
 *  - POST {action:'history'}    : riwayat pesanan (pelanggan: miliknya; pemilik: semua)
 *  - POST {action:'edit_order'} : pemilik mengubah jumlah & harga barang di pesanan
 *
 *  Di Google Sheets ada menu "ASA":
 *  - Buat invoice PDF  : invoice A5 mendatar dari baris pesanan yang dipilih, disimpan di Drive "Invoice ASA"
 *  - Siapkan sheet     : membuat tab & kolom yang dibutuhkan (data lama tidak dihapus)
 *
 * Tab produk (tab paling kiri, baris 1 = judul, urutan kolom bebas):
 *   id | name | price | stock | category | image | keterangan | kelompok | satuan | min_beli | sorotan
 *   - kelompok : Sepeda, Ban, Sparepart, Aksesoris, Baby walker, Roda tiga, Tolo car, Pre-order
 *                (boleh kosong untuk sepeda: bmx/mini/mtb otomatis masuk "Sepeda", pre-order masuk "Pre-order")
 *   - category : sub-kategori (bmx, mini, mtb, ban luar, rem, ...)
 *   - sorotan  : kotak centang, tampil di bagian "Sorotan" di beranda
 * Tab "Pelanggan": nama | username | pin | alamat | no_wa | aktif | peran (isi "pemilik" untuk akun pemilik)
 */

const VERSION = 2;
const PRODUCT_SHEET_NAME = ''; // kosongkan = pakai sheet (tab) paling kiri
const ORDER_SHEET_NAME = 'Pesanan';
const DETAIL_SHEET_NAME = 'Detail Pesanan';
const CUSTOMER_SHEET_NAME = 'Pelanggan';
const INVOICE_FOLDER_NAME = 'Invoice ASA';
const SESSION_DAYS = 30;
const MAX_LOGIN_FAILS = 5;      // salah PIN berturut-turut sebelum dikunci
const LOCK_MINUTES = 15;        // lama dikunci

const ORDER_COLUMNS = ['Waktu', 'No. Pesanan', 'Nama', 'Alamat', 'Catatan', 'Barang', 'Total', 'Status', 'Username', 'No. WA', 'Lunas', 'Total Semula'];
const DETAIL_COLUMNS = ['No. Pesanan', 'ID Barang', 'Nama Barang', 'Jumlah', 'Satuan', 'Harga', 'Subtotal'];
const CUSTOMER_COLUMNS = ['nama', 'username', 'pin', 'alamat', 'no_wa', 'aktif', 'peran'];
const SEPEDA_SUBS = ['bmx', 'mini', 'mtb', 'lipat', 'balap', 'city'];
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const BULAN_PANJANG = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

// ======================================================================
// WEB APP
// ======================================================================

function doGet() {
  return json_({ ok: true, version: VERSION, auth: false, products: publicProducts_() });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'invalid' });
  }
  try {
    switch (body.action) {
      case 'login': return json_(login_(body));
      case 'logout': return json_(logout_(body));
      case 'products': return json_(productsForToken_(body.token));
      case 'order': return json_(order_(body));
      case 'history': return json_(history_(body));
      case 'edit_order': return json_(editOrder_(body));
      default: return json_({ ok: false, error: 'unknown', message: 'Aksi tidak dikenal' });
    }
  } catch (err) {
    return json_({ ok: false, error: 'server', message: String(err) });
  }
}

// ---------- katalog ----------

function publicProducts_() {
  return readProducts_().rows.map(r => {
    const p = toProduct_(r.values, r.col);
    delete p.price; // harga tidak dikirim ke pengunjung yang belum login
    return p;
  });
}

function productsForToken_(token) {
  const customer = customerFromToken_(token);
  if (!customer) return { ok: true, version: VERSION, auth: false, products: publicProducts_() };
  return {
    ok: true, version: VERSION, auth: true,
    customer: publicCustomer_(customer),
    products: readProducts_().rows.map(r => toProduct_(r.values, r.col))
  };
}

// ---------- login ----------

function login_(body) {
  const username = normalizeUsername_(body.username);
  const pin = String(body.pin || '').replace(/\D/g, '');
  if (!username || pin.length < 4 || pin.length > 6) {
    return { ok: false, error: 'invalid', message: 'Isi username dan PIN (4 sampai 6 angka)' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    const cache = CacheService.getScriptCache();
    const failKey = 'fail_' + username;
    const fails = Number(cache.get(failKey)) || 0;
    if (fails >= MAX_LOGIN_FAILS) {
      return { ok: false, error: 'locked', message: 'Terlalu banyak percobaan. Coba lagi ' + LOCK_MINUTES + ' menit lagi.' };
    }

    const customer = findCustomer_(username);
    const pinOk = customer && (customer.pin === pin || customer.pin.padStart(pin.length, '0') === pin);
    if (!pinOk) {
      cache.put(failKey, String(fails + 1), LOCK_MINUTES * 60);
      const left = MAX_LOGIN_FAILS - fails - 1;
      return { ok: false, error: 'wrong', message: left > 0 ? 'Username atau PIN salah. Sisa ' + left + ' percobaan.' : 'Terlalu banyak percobaan. Coba lagi ' + LOCK_MINUTES + ' menit lagi.' };
    }
    if (!customer.aktif) {
      return { ok: false, error: 'inactive', message: 'Akun Anda tidak aktif. Hubungi toko.' };
    }

    cache.remove(failKey);
    const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    const props = PropertiesService.getScriptProperties();
    cleanupSessions_(props);
    props.setProperty('sess_' + token, JSON.stringify({ username: username, exp: Date.now() + SESSION_DAYS * 864e5 }));
    return { ok: true, version: VERSION, token: token, customer: publicCustomer_(customer) };
  } finally {
    lock.releaseLock();
  }
}

function logout_(body) {
  if (body.token) PropertiesService.getScriptProperties().deleteProperty('sess_' + String(body.token));
  return { ok: true };
}

function publicCustomer_(c) {
  return { nama: c.nama, alamat: c.alamat, username: c.username, role: c.owner ? 'owner' : 'customer' };
}

// Token -> data pelanggan (null jika token salah, kedaluwarsa, atau pelanggan dinonaktifkan)
function customerFromToken_(token) {
  token = String(token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('sess_' + token);
  if (!raw) return null;
  const sess = JSON.parse(raw);
  if (sess.exp < Date.now()) { props.deleteProperty('sess_' + token); return null; }
  if (!sess.username) { props.deleteProperty('sess_' + token); return null; }
  const customer = findCustomer_(sess.username);
  if (!customer || !customer.aktif) return null;
  return customer;
}

function cleanupSessions_(props) {
  const all = props.getProperties();
  Object.keys(all).forEach(k => {
    if (k.indexOf('sess_') !== 0) return;
    try { if (JSON.parse(all[k]).exp < Date.now()) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

function normalizeUsername_(s) {
  return String(s || '').trim().toLowerCase().slice(0, 50);
}

function findCustomer_(username) {
  const t = table_(customerSheet_());
  if (t.col('username') < 0) return null;
  for (const r of t.rows) {
    if (normalizeUsername_(r.get('username')) !== username) continue;
    const aktif = String(r.get('aktif')).trim().toLowerCase();
    const peran = String(r.get('peran')).trim().toLowerCase();
    return {
      nama: String(r.get('nama')).trim(),
      username: username,
      pin: String(r.get('pin')).replace(/\D/g, ''),
      alamat: String(r.get('alamat')).trim(),
      noWa: String(r.get('no_wa')).trim(),
      aktif: ['tidak', 'no', 'false', '0', 'nonaktif'].indexOf(aktif) < 0,
      owner: ['pemilik', 'owner', 'admin'].indexOf(peran) >= 0
    };
  }
  return null;
}

// ---------- pesanan baru ----------

function order_(order) {
  const customer = customerFromToken_(order.token);
  if (!customer) return { ok: false, error: 'auth', message: 'Silakan masuk lagi' };

  const name = customer.nama || clean_(order.name, 100);
  const address = customer.alamat || clean_(order.address, 400);
  const notes = clean_(order.notes, 400);
  if (!name || !address) return { ok: false, error: 'invalid', message: 'Nama dan alamat wajib diisi' };
  if (!Array.isArray(order.items) || order.items.length === 0 || order.items.length > 100) {
    return { ok: false, error: 'invalid', message: 'Keranjang tidak valid' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    const wanted = {};
    const orderOfIds = [];
    order.items.forEach(it => {
      const id = String(it.id);
      const qty = Math.floor(Number(it.qty));
      if (!(qty > 0 && qty <= 9999)) return;
      if (!wanted[id]) orderOfIds.push(id);
      wanted[id] = (wanted[id] || 0) + qty;
    });

    const prod = readProducts_();
    const problems = [];
    const lines = [];
    orderOfIds.forEach(id => {
      const row = prod.rows.find(r => String(toProduct_(r.values, r.col).id) === id);
      if (!row) { problems.push({ id: id, stock: 0, name: '(tidak ditemukan)' }); return; }
      const p = toProduct_(row.values, row.col);
      const qty = wanted[id];
      if (!p.po && qty > p.stock) { problems.push({ id: p.id, stock: p.stock, name: p.name }); return; }
      lines.push({ row: row, p: p, qty: qty });
    });
    if (problems.length) return { ok: false, error: 'stock', problems: problems };

    // Kurangi stok (pre-order tidak mengurangi stok)
    const stockCol = prod.col.stock;
    lines.forEach(l => {
      if (!l.p.po) prod.sheet.getRange(l.row.index, stockCol + 1).setValue(l.p.stock - l.qty);
    });

    const now = new Date();
    const orderId = nextOrderId_(now);
    const total = lines.reduce((a, l) => a + l.p.price * l.qty, 0);

    const os = orderSheet_();
    const newRow = appendByHeader_(os, {
      'Waktu': now, 'No. Pesanan': orderId, 'Nama': name, 'Alamat': address, 'Catatan': notes,
      'Barang': itemsText_(lines.map(l => ({ n: l.p.name, q: l.qty, po: l.p.po }))),
      'Total': total, 'Status': 'Baru', 'Username': customer.username,
      'No. WA': customer.noWa ? "'" + customer.noWa : '', 'Lunas': false
    });
    const lunasCol = headerIndex_(os)['lunas'];
    if (lunasCol >= 0) os.getRange(newRow, lunasCol + 1).insertCheckboxes();
    const det = detailSheet_();
    lines.forEach(l => appendByHeader_(det, {
      'No. Pesanan': orderId, 'ID Barang': l.p.id, 'Nama Barang': l.p.name, 'Jumlah': l.qty,
      'Satuan': l.p.satuan, 'Harga': l.p.price, 'Subtotal': l.p.price * l.qty
    }));

    return { ok: true, orderId: orderId, total: total, customer: { nama: name } };
  } finally {
    lock.releaseLock();
  }
}

// ---------- riwayat ----------

function history_(body) {
  const customer = customerFromToken_(body.token);
  if (!customer) return { ok: false, error: 'auth', message: 'Silakan masuk lagi' };
  const t = table_(orderSheet_());
  const details = detailMap_();
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const orders = t.rows
    .filter(r => String(r.get('No. Pesanan')).trim() !== '')
    .filter(r => customer.owner || normalizeUsername_(r.get('Username')) === customer.username)
    .map(r => orderFromRow_(r, details, tz))
    .reverse()
    .slice(0, customer.owner ? 500 : 100);
  return { ok: true, owner: customer.owner, orders: orders };
}

function orderFromRow_(r, details, tz) {
  const no = String(r.get('No. Pesanan')).trim();
  const w = r.get('Waktu');
  const d = w instanceof Date ? w : null;
  const items = details[no] ? details[no].map(x => x.item) : parseItemsText_(r.get('Barang'));
  return {
    no: no,
    tgl: d ? Number(Utilities.formatDate(d, tz, 'd')) + ' ' + BULAN[Number(Utilities.formatDate(d, tz, 'M')) - 1] + ' ' + Utilities.formatDate(d, tz, 'yyyy') : String(w || ''),
    nama: String(r.get('Nama')).trim(),
    alamat: String(r.get('Alamat')).trim(),
    catatan: String(r.get('Catatan')).trim(),
    status: normalizeStatus_(r.get('Status')),
    lunas: yes_(r.get('Lunas')),
    total: num_(r.get('Total')),
    oldTotal: num_(r.get('Total Semula')),
    editable: !!details[no],
    items: items
  };
}

function normalizeStatus_(s) {
  const v = String(s || '').trim().toLowerCase();
  if (v.indexOf('selesai') === 0) return 'Selesai';
  if (v.indexOf('kirim') >= 0) return 'Dikirim';
  if (v.indexOf('proses') >= 0) return 'Diproses';
  return 'Baru';
}

// ---------- pemilik: ubah jumlah & harga ----------

function editOrder_(body) {
  const customer = customerFromToken_(body.token);
  if (!customer) return { ok: false, error: 'auth', message: 'Silakan masuk lagi' };
  if (!customer.owner) return { ok: false, error: 'forbidden', message: 'Hanya pemilik toko yang bisa mengubah pesanan' };
  const no = String(body.no || '').trim();
  if (!no || !Array.isArray(body.items)) return { ok: false, error: 'invalid', message: 'Data tidak lengkap' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    const os = orderSheet_();
    const ot = table_(os);
    const orow = ot.rows.find(r => String(r.get('No. Pesanan')).trim() === no);
    if (!orow) return { ok: false, error: 'notfound', message: 'Pesanan tidak ditemukan' };

    const details = detailMap_()[no];
    if (!details) return { ok: false, error: 'no_detail', message: 'Pesanan lama ini belum punya rincian per barang, jadi belum bisa diubah dari web' };
    if (body.items.length !== details.length) return { ok: false, error: 'invalid', message: 'Data barang tidak cocok, muat ulang halaman' };

    const changes = details.map((d, k) => {
      const q = Math.floor(Number(body.items[k].q));
      const p = Math.round(Number(body.items[k].p));
      return { d: d, q: q, p: p };
    });
    if (changes.some(c => !(c.q >= 1 && c.q <= 9999) || !(c.p > 0))) {
      return { ok: false, error: 'invalid', message: 'Jumlah minimal 1 dan harga harus diisi' };
    }

    // Cek & sesuaikan stok
    const prod = readProducts_();
    const deltas = {};
    changes.forEach(c => {
      const delta = c.q - c.d.item.q;
      if (delta !== 0 && c.d.item.id) deltas[c.d.item.id] = (deltas[c.d.item.id] || 0) + delta;
    });
    const problems = [];
    const stockUpdates = [];
    Object.keys(deltas).forEach(id => {
      const row = prod.rows.find(r => String(toProduct_(r.values, r.col).id) === id);
      if (!row) return;
      const p = toProduct_(row.values, row.col);
      if (p.po) return;
      if (deltas[id] > p.stock) { problems.push({ id: p.id, name: p.name, stock: p.stock }); return; }
      stockUpdates.push({ index: row.index, stock: p.stock - deltas[id] });
    });
    if (problems.length) {
      const pr = problems[0];
      return { ok: false, error: 'stock', problems: problems, message: 'Stok "' + pr.name + '" tinggal ' + pr.stock + ', tidak cukup untuk menambah jumlah' };
    }
    stockUpdates.forEach(u => prod.sheet.getRange(u.index, prod.col.stock + 1).setValue(u.stock));

    // Perbarui Detail Pesanan
    const ds = detailSheet_();
    const dh = headerIndex_(ds);
    changes.forEach(c => {
      ds.getRange(c.d.index, dh['jumlah'] + 1).setValue(c.q);
      ds.getRange(c.d.index, dh['harga'] + 1).setValue(c.p);
      ds.getRange(c.d.index, dh['subtotal'] + 1).setValue(c.q * c.p);
      c.d.item.q = c.q; c.d.item.p = c.p;
    });

    // Perbarui baris Pesanan
    const oh = headerIndex_(os);
    const oldTotal = num_(orow.get('Total'));
    const newTotal = changes.reduce((a, c) => a + c.q * c.p, 0);
    if (!num_(orow.get('Total Semula')) && newTotal !== oldTotal) os.getRange(orow.index, oh['total semula'] + 1).setValue(oldTotal);
    os.getRange(orow.index, oh['total'] + 1).setValue(newTotal);
    os.getRange(orow.index, oh['barang'] + 1).setValue(itemsText_(changes.map(c => ({ n: c.d.item.n, q: c.q }))));

    const fresh = table_(os).rows.find(r => String(r.get('No. Pesanan')).trim() === no);
    return { ok: true, order: orderFromRow_(fresh, detailMap_(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone()) };
  } finally {
    lock.releaseLock();
  }
}

// ======================================================================
// MENU DI GOOGLE SHEETS
// ======================================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ASA')
    .addItem('Buat invoice PDF (baris yang dipilih)', 'buatInvoicePdf')
    .addSeparator()
    .addItem('Siapkan sheet', 'siapkanSheet')
    .addToUi();
}

/**
 * Jalankan sekali setelah memasang skrip ini (atau dari menu ASA > Siapkan sheet):
 * membuat tab & kolom yang belum ada. Data yang sudah ada tidak dihapus.
 */
function siapkanSheet() {
  ensureColumns_(customerSheet_(), CUSTOMER_COLUMNS);
  const cs = customerSheet_();
  const ch = headerIndex_(cs);
  ['pin', 'no_wa'].forEach(c => { if (ch[c] >= 0) cs.getRange(2, ch[c] + 1, Math.max(cs.getMaxRows() - 1, 1), 1).setNumberFormat('@'); });

  const os = orderSheet_();
  // judul lama "No. WA" di kolom 9 dari versi sebelumnya
  const h9 = String(os.getRange(1, 9).getValue()).trim();
  if (h9 === 'No. WA' && String(os.getRange(1, 10).getValue()).trim() === '') os.getRange(1, 9).setValue('Username');
  ensureColumns_(os, ORDER_COLUMNS);
  const oh = headerIndex_(os);
  const rows = Math.max(os.getMaxRows() - 1, 1);
  os.getRange(2, oh['lunas'] + 1, rows, 1).insertCheckboxes();

  detailSheet_();

  const ps = productSheet_();
  ensureColumns_(ps, ['kelompok', 'satuan', 'min_beli', 'sorotan']);
  const ph = headerIndex_(ps);
  ps.getRange(2, ph['sorotan'] + 1, Math.max(ps.getMaxRows() - 1, 1), 1).insertCheckboxes();
}

function buatInvoicePdf() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== ORDER_SHEET_NAME) {
    ui.alert('Buka tab "' + ORDER_SHEET_NAME + '", klik salah satu sel di baris pesanan, lalu pilih menu ASA > Buat invoice PDF.');
    return;
  }
  const rowIndex = sh.getActiveRange().getRow();
  const t = table_(sh);
  const r = t.rows.find(x => x.index === rowIndex);
  if (!r || !String(r.get('No. Pesanan')).trim()) { ui.alert('Klik baris pesanan dulu (bukan baris judul).'); return; }

  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const details = detailMap_();
  const o = orderFromRow_(r, details, tz);
  const w = r.get('Waktu');
  o.tglPanjang = w instanceof Date ? Number(Utilities.formatDate(w, tz, 'd')) + ' ' + BULAN_PANJANG[Number(Utilities.formatDate(w, tz, 'M')) - 1] + ' ' + Utilities.formatDate(w, tz, 'yyyy') : o.tgl;
  o.wa = String(r.get('No. WA')).replace(/^'/, '').trim();
  if (!o.wa) { const c = findCustomer_(normalizeUsername_(r.get('Username'))); if (c) o.wa = c.noWa; }
  if (details[o.no]) details[o.no].forEach((d, k) => { o.items[k].u = d.item.u; });

  const pdf = invoicePdf_(o);
  const folder = invoiceFolder_();
  const existing = folder.getFilesByName(pdf.getName());
  while (existing.hasNext()) existing.next().setTrashed(true);
  const file = folder.createFile(pdf);
  ui.alert('Invoice ' + o.no + ' dibuat', 'Tersimpan di Google Drive, folder "' + INVOICE_FOLDER_NAME + '":\n\n' + file.getUrl(), ui.ButtonSet.OK);
}

function invoiceFolder_() {
  const it = DriveApp.getFoldersByName(INVOICE_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(INVOICE_FOLDER_NAME);
}

// Invoice A5 mendatar dibuat sebagai Google Docs sementara, lalu diekspor ke PDF.
function invoicePdf_(o) {
  const A = DocumentApp.Attribute;
  const doc = DocumentApp.create('Invoice ' + o.no);
  const body = doc.getBody();
  body.setPageWidth(595.3).setPageHeight(419.5)
    .setMarginTop(20).setMarginBottom(18).setMarginLeft(22).setMarginRight(22);
  const base = {}; base[A.FONT_FAMILY] = 'Arial'; base[A.FONT_SIZE] = 8; base[A.FOREGROUND_COLOR] = '#111827';
  body.setAttributes(base);

  const GRAY = '#6b7280';
  const style = (el, size, bold, color) => { const tx = el.editAsText(); tx.setFontSize(size); tx.setBold(!!bold); if (color) tx.setForegroundColor(color); return el; };
  const tight = p => p.setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
  const cellText = (cell, text, size, bold, color, align) => {
    const p = cell.getChild(0).asParagraph(); p.setText(text); tight(p); style(p, size, bold, color);
    if (align) p.setAlignment(align); return p;
  };
  const addLine = (cell, text, size, bold, color, align) => {
    const p = cell.appendParagraph(text); tight(p); style(p, size, bold, color); if (align) p.setAlignment(align); return p;
  };
  const RIGHT = DocumentApp.HorizontalAlignment.RIGHT, CENTER = DocumentApp.HorizontalAlignment.CENTER;
  const pad = (cell, v, h) => cell.setPaddingTop(v).setPaddingBottom(v).setPaddingLeft(h).setPaddingRight(h);

  // Kepala: toko | penerima | judul
  const head = body.appendTable([['', '', '']]);
  head.setBorderWidth(0);
  const c0 = head.getCell(0, 0), c1 = head.getCell(0, 1), c2 = head.getCell(0, 2);
  c0.setWidth(150); c1.setWidth(250); c2.setWidth(151);
  [c0, c1, c2].forEach(c => pad(c, 0, 2));
  const logoP = tight(c0.getChild(0).asParagraph());
  const img = logoP.appendInlineImage(Utilities.newBlob(Utilities.base64Decode(LOGO_B64), 'image/png', 'logo.png'));
  const w0 = img.getWidth(), h0 = img.getHeight(); // ukuran asli dulu, baru diperkecil (supaya tidak gepeng/tertarik)
  img.setWidth(62).setHeight(Math.round(62 * h0 / w0));
  addLine(c0, 'ASA Bike Shop and Accessories', 7, false, GRAY);
  addLine(c0, 'Tabanan, Bali · WA 0851-1141-8200', 7, false, GRAY);
  cellText(c1, 'KEPADA / DIKIRIM KE', 6, true, GRAY);
  addLine(c1, o.nama, 8.5, true);
  addLine(c1, o.alamat, 8, false);
  const sub = [o.wa ? 'WA ' + o.wa : '', o.catatan ? 'Catatan: ' + o.catatan : ''].filter(String).join(' · ');
  if (sub) addLine(c1, sub, 7, false, GRAY);
  cellText(c2, 'INVOICE', 13, true, null, RIGHT);
  addLine(c2, o.no, 9, true, null, RIGHT);
  addLine(c2, o.tglPanjang, 8, false, GRAY, RIGHT);
  tight(body.appendParagraph('')).editAsText().setFontSize(3);
  body.appendHorizontalRule();

  // Tabel barang
  const rows = [['No', 'Barang', 'Jml', 'Satuan', 'Harga', 'Subtotal', 'Cek']];
  o.items.forEach((it, k) => rows.push([String(k + 1), it.n, String(it.q), it.u || '', it.p ? fmt_(it.p) : '-', it.p ? fmt_(it.p * it.q) : '-', '☐']));
  const tb = body.appendTable(rows);
  tb.setBorderWidth(0.5).setBorderColor('#e5e7eb');
  const widths = [18, 285, 30, 38, 64, 76, 40];
  for (let i = 0; i < tb.getNumRows(); i++) {
    for (let j = 0; j < 7; j++) {
      const cell = tb.getCell(i, j);
      cell.setWidth(widths[j]); pad(cell, 1.5, 3);
      const p = tight(cell.getChild(0).asParagraph());
      if (i === 0) { cell.setBackgroundColor('#f3f4f6'); style(p, 6.5, true, '#4b5563'); }
      else style(p, 8, false);
      if (j === 0 || j === 6) p.setAlignment(CENTER);
      if (j === 2 || j === 4 || j === 5) p.setAlignment(RIGHT);
    }
  }

  // Bawah: tanda tangan | ringkasan
  tight(body.appendParagraph('')).editAsText().setFontSize(3);
  const bottom = body.appendTable([['', '']]);
  bottom.setBorderWidth(0);
  const bl = bottom.getCell(0, 0), br = bottom.getCell(0, 1);
  bl.setWidth(360); br.setWidth(191); pad(bl, 0, 0); pad(br, 0, 4);
  const sign = bl.appendTable([['', '']]);
  sign.setBorderWidth(0.75).setBorderColor('#d1d5db');
  [['PENGIRIM', 'ASA Bike Shop'], ['PENERIMA', 'Barang diterima dalam keadaan baik dan lengkap']].forEach((s, j) => {
    const c = sign.getCell(0, j); c.setWidth(175); pad(c, 4, 6);
    cellText(c, s[0], 6, true, GRAY);
    addLine(c, s[1], 6.5, false, GRAY);
    addLine(c, ' ', 8); addLine(c, ' ', 8); addLine(c, ' ', 8);
    addLine(c, '______________________________', 7, false, '#9ca3af');
    addLine(c, 'Nama & tanda tangan     Tgl ___/___/______', 6, false, GRAY);
  });
  tight(bl.getChild(0).asParagraph()).editAsText().setFontSize(1);

  const qty = o.items.reduce((a, b) => a + b.q, 0);
  const total = o.items.every(it => it.p) ? o.items.reduce((a, b) => a + b.p * b.q, 0) : o.total;
  cellText(br, o.items.length + ' jenis barang · ' + qty + ' item', 7, false, GRAY, RIGHT);
  addLine(br, 'Status: ' + o.status, 7, false, GRAY, RIGHT);
  addLine(br, 'Total  Rp ' + fmt_(total), 11, true, null, RIGHT).setSpacingBefore(3);
  addLine(br, 'Pembayaran: ' + (o.lunas ? 'Lunas' : 'Belum lunas'), 7.5, true, o.lunas ? '#059669' : '#dc2626', RIGHT);
  const stamp = br.appendTable([[o.lunas ? 'LUNAS' : 'BELUM LUNAS']]);
  stamp.setBorderWidth(2).setBorderColor(o.lunas ? '#059669' : '#dc2626');
  const sc = stamp.getCell(0, 0); sc.setWidth(o.lunas ? 70 : 100); pad(sc, 2, 6);
  style(tight(sc.getChild(0).asParagraph()).setAlignment(CENTER), 10, true, o.lunas ? '#059669' : '#dc2626');
  addLine(br, ' ', 2);

  const foot = body.appendParagraph('Barang yang sudah diterima dan ditandatangani dianggap lengkap.  ·  Terima kasih telah berbelanja di ASA');
  tight(foot).setSpacingBefore(4); style(foot, 6, false, '#9ca3af');

  doc.saveAndClose();
  const file = DriveApp.getFileById(doc.getId());
  const pdf = file.getAs('application/pdf').setName(o.no + '.pdf');
  file.setTrashed(true);
  return pdf;
}

// ======================================================================
// NOMOR PESANAN
// ======================================================================

/**
 * Format: ASA-DDMMYY-XXX
 *   DDMMYY = tanggal, bulan, tahun pesanan
 *   XXX    = nomor urut dalam bulan itu (001, 002, ...), kembali ke 001 tiap awal bulan
 */
function nextOrderId_(date) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const monthKey = 'orderCounter_' + Utilities.formatDate(date, tz, 'yyyyMM');
  const props = PropertiesService.getScriptProperties();
  const next = (Number(props.getProperty(monthKey)) || 0) + 1;
  props.setProperty(monthKey, String(next));
  return 'ASA-' + Utilities.formatDate(date, tz, 'ddMMyy') + '-' + String(next).padStart(3, '0');
}

/** Jalankan manual untuk mengulang nomor urut bulan ini dari 001. */
function resetNomorPesananBulanIni() {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  PropertiesService.getScriptProperties().deleteProperty('orderCounter_' + Utilities.formatDate(new Date(), tz, 'yyyyMM'));
}

/** Jalankan manual untuk mengeluarkan semua pelanggan dari semua hape. */
function keluarkanSemuaPelanggan() {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(k => { if (k.indexOf('sess_') === 0) props.deleteProperty(k); });
}

// ======================================================================
// HELPER
// ======================================================================

function productSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return PRODUCT_SHEET_NAME ? ss.getSheetByName(PRODUCT_SHEET_NAME) : ss.getSheets()[0];
}

function sheetWithHeader_(name, columns) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name, ss.getNumSheets());
    sh.appendRow(columns);
    sh.setFrozenRows(1);
  }
  return sh;
}
function customerSheet_() { return sheetWithHeader_(CUSTOMER_SHEET_NAME, CUSTOMER_COLUMNS); }
function orderSheet_() { return sheetWithHeader_(ORDER_SHEET_NAME, ORDER_COLUMNS); }
function detailSheet_() { return sheetWithHeader_(DETAIL_SHEET_NAME, DETAIL_COLUMNS); }

// Tambahkan kolom yang belum ada di ujung kanan baris judul
function ensureColumns_(sh, columns) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim().toLowerCase());
  let next = header.reduce((m, h, i) => (h ? i + 1 : m), 0) + 1;
  columns.forEach(c => {
    if (header.indexOf(c.toLowerCase()) < 0) { sh.getRange(1, next++).setValue(c); }
  });
}

function headerIndex_(sh) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  header.forEach((h, i) => { const k = String(h).trim().toLowerCase(); if (k && map[k] === undefined) map[k] = i; });
  return new Proxy(map, { get: (m, k) => (k in m ? m[k] : -1) });
}

// Baca seluruh tab sebagai baris dengan akses kolom berdasarkan judul
function table_(sh) {
  const values = sh.getDataRange().getValues();
  const header = (values[0] || []).map(h => String(h).trim().toLowerCase());
  const col = name => header.indexOf(String(name).toLowerCase());
  const rows = values.slice(1).map((v, i) => ({
    values: v, index: i + 2,
    get: name => { const c = col(name); return c < 0 ? '' : v[c]; }
  }));
  return { sheet: sh, rows: rows, col: col };
}

// Tulis di baris kosong pertama (dilihat dari kolom pertama di obj, mis. "No. Pesanan").
// Tidak memakai appendRow, karena kotak centang kosong sampai baris 1000 membuat appendRow menulis di baris 1001.
function appendByHeader_(sh, obj) {
  const h = headerIndex_(sh);
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const keyName = Object.keys(obj).find(k => k !== 'Waktu' && h[k.toLowerCase()] >= 0) || Object.keys(obj)[0];
  const keyCol = h[keyName.toLowerCase()];
  const values = sh.getDataRange().getValues();
  let last = 1;
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][keyCol] === undefined ? '' : values[i][keyCol]).trim() !== '') { last = i + 1; break; }
  }
  const target = last + 1;
  const row = sh.getRange(target, 1, 1, lastCol).getValues()[0].map(v => (v === false ? false : ''));
  Object.keys(obj).forEach(k => { const i = h[k.toLowerCase()]; if (i >= 0) row[i] = obj[k]; });
  sh.getRange(target, 1, 1, lastCol).setValues([row]);
  return target;
}

function readProducts_() {
  const sheet = productSheet_();
  const values = sheet.getDataRange().getValues();
  const header = values[0].map(h => String(h).trim().toLowerCase());
  const find = names => { const i = names.map(n => header.indexOf(n)).find(x => x >= 0); return i === undefined ? -1 : i; };
  const col = {
    id: find(['id']),
    name: find(['name', 'nama']),
    price: find(['price', 'harga']),
    stock: find(['stock', 'stok']),
    category: find(['category', 'kategori', 'sub']),
    group: find(['kelompok', 'group']),
    image: find(['image', 'gambar', 'foto']),
    keterangan: find(['keterangan', 'desc', 'deskripsi']),
    satuan: find(['satuan', 'unit']),
    min: find(['min_beli', 'minimal']),
    sorotan: find(['sorotan', 'unggulan']),
    preorder: find(['preorder', 'pre-order', 'po'])
  };
  const rows = values.slice(1)
    .map((v, i) => ({ values: v, index: i + 2, col: col }))
    .filter(r => col.name >= 0 && String(r.values[col.name] || '').trim() !== '');
  return { sheet: sheet, rows: rows, col: col };
}

function toProduct_(v, col) {
  const get = c => (c < 0 ? '' : v[c]);
  const cat = String(get(col.category) || '').trim().toLowerCase();
  let group = String(get(col.group) || '').trim();
  const po = yes_(get(col.preorder)) || cat === 'pre-order' || cat === 'po' || group.toLowerCase() === 'pre-order';
  if (!group) group = po ? 'Pre-order' : SEPEDA_SUBS.indexOf(cat) >= 0 ? 'Sepeda' : (cat ? cat.charAt(0).toUpperCase() + cat.slice(1) : 'Lainnya');
  return {
    id: num_(get(col.id)),
    name: String(get(col.name)).trim(),
    price: num_(get(col.price)),
    stock: num_(get(col.stock)),
    group: group,
    sub: (cat === 'pre-order' || cat === 'po') ? '' : cat,
    image: String(get(col.image)).trim(),
    keterangan: String(get(col.keterangan)).trim(),
    satuan: String(get(col.satuan)).trim(),
    min: num_(get(col.min)),
    sorotan: yes_(get(col.sorotan)),
    po: po
  };
}

// No. Pesanan -> [{index, item:{id,n,q,p,u}}]
function detailMap_() {
  const t = table_(detailSheet_());
  const map = {};
  t.rows.forEach(r => {
    const no = String(r.get('No. Pesanan')).trim();
    if (!no) return;
    (map[no] = map[no] || []).push({
      index: r.index,
      item: { id: num_(r.get('ID Barang')) || null, n: String(r.get('Nama Barang')).trim(), q: num_(r.get('Jumlah')), p: num_(r.get('Harga')), u: String(r.get('Satuan')).trim() }
    });
  });
  return map;
}

function itemsText_(items) {
  return items.map(i => i.q + 'x ' + i.n + (i.po ? ' [PO]' : '')).join('\n');
}

// Pesanan lama (sebelum ada tab Detail Pesanan): "2x Nama barang" per baris, tanpa harga
function parseItemsText_(text) {
  return String(text || '').split('\n').map(s => s.trim()).filter(String).map(s => {
    const m = s.match(/^(\d+)\s*x\s*(.+)$/i);
    return { id: null, n: (m ? m[2] : s).replace(/\s*\[PO\]$/, ''), q: m ? Number(m[1]) : 1, p: 0, u: '' };
  });
}

function yes_(v) {
  if (v === true) return true;
  return ['ya', 'yes', 'true', '1', 'v', 'lunas', 'sudah'].indexOf(String(v || '').trim().toLowerCase()) >= 0;
}
function num_(x) { return Number(String(x === undefined || x === null ? '' : x).replace(/[^\d]/g, '')) || 0; }
function fmt_(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
function clean_(s, max) { return String(s || '').trim().slice(0, max); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Logo ASA untuk invoice (PNG, base64)
const LOGO_B64 = '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';
