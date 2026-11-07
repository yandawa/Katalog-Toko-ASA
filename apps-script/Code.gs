/**
 * ASA Bike Shop — Google Apps Script
 * ------------------------------------------------------------
 * Dipasang di Google Sheets katalog (Extensions > Apps Script).
 *
 *  - GET                      : katalog publik (TANPA harga)
 *  - POST {action:'login'}    : login pelanggan (username + PIN) -> token sesi 30 hari
 *  - POST {action:'products'} : katalog lengkap dengan harga (butuh token)
 *  - POST {action:'logout'}   : hapus token
 *  - POST {action:'order'}    : cek & kurangi stok, catat ke tab "Pesanan" (butuh token)
 *
 * Tab produk (tab paling kiri, baris 1 = judul, urutan kolom bebas):
 *   id | name | price | stock | category | image | keterangan
 * Tab "Pelanggan" (dibuat otomatis kalau belum ada):
 *   nama | username | pin | alamat | no_wa (opsional) | aktif
 */

const PRODUCT_SHEET_NAME = ''; // kosongkan = pakai sheet (tab) paling kiri
const ORDER_SHEET_NAME = 'Pesanan';
const CUSTOMER_SHEET_NAME = 'Pelanggan';
const SESSION_DAYS = 30;
const MAX_LOGIN_FAILS = 5;      // salah PIN berturut-turut sebelum dikunci
const LOCK_MINUTES = 15;        // lama dikunci

function doGet() {
  return json_({ ok: true, auth: false, products: publicProducts_() });
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
      case 'order':
      default: return json_(order_(body));
    }
  } catch (err) {
    return json_({ ok: false, error: 'server', message: String(err) });
  }
}

// ---------- katalog ----------

function publicProducts_() {
  const { rows, col } = readProducts_();
  return rows.map(r => {
    const p = toProduct_(r.values, col);
    delete p.price; // harga tidak dikirim ke pengunjung yang belum login
    return p;
  });
}

function productsForToken_(token) {
  const customer = customerFromToken_(token);
  if (!customer) return { ok: true, auth: false, products: publicProducts_() };
  const { rows, col } = readProducts_();
  return {
    ok: true,
    auth: true,
    customer: { nama: customer.nama, alamat: customer.alamat },
    products: rows.map(r => toProduct_(r.values, col))
  };
}

// ---------- login ----------

function login_(body) {
  const username = normalizeUsername_(body.username);
  const pin = String(body.pin || '').replace(/\D/g, '');
  if (!username || pin.length !== 4) {
    return { ok: false, error: 'invalid', message: 'Isi username dan PIN 4 angka' };
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
    if (!customer || customer.pin !== pin) {
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
    return { ok: true, token: token, customer: { nama: customer.nama, alamat: customer.alamat } };
  } finally {
    lock.releaseLock();
  }
}

function logout_(body) {
  if (body.token) PropertiesService.getScriptProperties().deleteProperty('sess_' + String(body.token));
  return { ok: true };
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
  if (!sess.username) { props.deleteProperty('sess_' + token); return null; } // sesi versi lama (nomor WA)
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

// Username tidak membedakan huruf besar/kecil dan spasi di awal/akhir
function normalizeUsername_(s) {
  return String(s || '').trim().toLowerCase().slice(0, 50);
}

const CUSTOMER_COLUMNS = ['nama', 'username', 'pin', 'alamat', 'no_wa', 'aktif'];

function customerSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CUSTOMER_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CUSTOMER_SHEET_NAME, ss.getNumSheets());
    sh.appendRow(CUSTOMER_COLUMNS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function findCustomer_(username) {
  const values = customerSheet_().getDataRange().getValues();
  const header = values[0].map(h => String(h).trim().toLowerCase());
  const c = name => header.indexOf(name);
  const get = (v, name) => (c(name) >= 0 ? String(v[c(name)] || '').trim() : '');
  if (c('username') < 0) return null;
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (normalizeUsername_(v[c('username')]) !== username) continue;
    const aktifText = get(v, 'aktif').toLowerCase();
    return {
      nama: get(v, 'nama'),
      username: username,
      pin: get(v, 'pin').replace(/\D/g, '').padStart(4, '0'),
      alamat: get(v, 'alamat'),
      noWa: get(v, 'no_wa'),
      aktif: ['tidak', 'no', 'false', '0', 'nonaktif'].indexOf(aktifText) < 0
    };
  }
  return null;
}

// ---------- pesanan ----------

function order_(order) {
  const customer = customerFromToken_(order.token);
  if (!customer) return { ok: false, error: 'auth', message: 'Silakan masuk lagi' };

  const name = customer.nama || clean_(order.name, 100);
  // Alamat dari tab Pelanggan; hanya pakai isian customer jika di sheet kosong
  const address = customer.alamat || clean_(order.address, 400);
  const notes = clean_(order.notes, 400);
  if (!name || !address) return { ok: false, error: 'invalid', message: 'Nama dan alamat wajib diisi' };
  if (!Array.isArray(order.items) || order.items.length === 0 || order.items.length > 50) {
    return { ok: false, error: 'invalid', message: 'Keranjang tidak valid' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    // Gabungkan item dengan id yang sama
    const wanted = {};
    order.items.forEach(it => {
      const id = String(it.id);
      const qty = Math.floor(Number(it.qty));
      if (qty > 0 && qty <= 999) wanted[id] = (wanted[id] || 0) + qty;
    });

    const { sheet, rows, col } = readProducts_();
    const problems = [];
    const lines = [];
    let total = 0;

    Object.keys(wanted).forEach(id => {
      const row = rows.find(r => String(r.values[col.id]) === id);
      if (!row) { problems.push({ id: id, stock: 0, name: '(tidak ditemukan)' }); return; }
      const p = toProduct_(row.values, col);
      const qty = wanted[id];
      const po = p.category === 'pre-order' || p.category === 'po';
      if (!po && qty > p.stock) { problems.push({ id: p.id, stock: p.stock, name: p.name }); return; }
      lines.push({ row: row, p: p, qty: qty, po: po });
      total += p.price * qty;
    });

    if (problems.length) return { ok: false, error: 'stock', problems: problems };

    // Kurangi stok (pre-order tidak mengurangi stok)
    lines.forEach(l => {
      if (!l.po) sheet.getRange(l.row.index, col.stock + 1).setValue(l.p.stock - l.qty);
    });

    const now = new Date();
    const orderId = nextOrderId_(now);
    const itemText = lines.map(l => l.qty + 'x ' + l.p.name + (l.po ? ' [PO]' : '')).join('\n');

    orderSheet_().appendRow([now, orderId, name, address, notes, itemText, total, 'Baru', customer.username, customer.noWa ? "'" + customer.noWa : '']);

    return { ok: true, orderId: orderId, total: total, customer: { nama: name } };
  } finally {
    lock.releaseLock();
  }
}

// ---------- nomor pesanan ----------

/**
 * Format: ASA-DDMMYY-XXX
 *   DDMMYY = tanggal, bulan, tahun pesanan
 *   XXX    = nomor urut dalam bulan itu (001, 002, ...), kembali ke 001 tiap awal bulan
 * Contoh: pesanan ke-7 pada 25 November 2026 -> ASA-251126-007
 */
function nextOrderId_(date) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const monthKey = 'orderCounter_' + Utilities.formatDate(date, tz, 'yyyyMM');
  const props = PropertiesService.getScriptProperties();
  const next = (Number(props.getProperty(monthKey)) || 0) + 1;
  props.setProperty(monthKey, String(next));
  return 'ASA-' + Utilities.formatDate(date, tz, 'ddMMyy') + '-' + String(next).padStart(3, '0');
}

/**
 * Jalankan manual dari editor Apps Script (pilih fungsi ini lalu klik Run)
 * untuk mengulang nomor urut bulan ini dari 001, misalnya setelah pesanan tes dihapus.
 */
function resetNomorPesananBulanIni() {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const monthKey = 'orderCounter_' + Utilities.formatDate(new Date(), tz, 'yyyyMM');
  PropertiesService.getScriptProperties().deleteProperty(monthKey);
}

/**
 * Jalankan manual sekali setelah memasang skrip ini:
 * membuat tab "Pelanggan" (kalau belum ada), menambahkan kolom yang belum ada
 * (misalnya "username"), dan judul kolom tambahan di tab Pesanan.
 * Data yang sudah ada tidak dihapus.
 */
function siapkanSheet() {
  const cs = customerSheet_();
  const lastCol = Math.max(cs.getLastColumn(), 1);
  const header = cs.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim().toLowerCase());
  let next = header.filter(h => h).length + 1;
  CUSTOMER_COLUMNS.forEach(col => {
    if (header.indexOf(col) < 0) cs.getRange(1, next++).setValue(col);
  });
  // Simpan pin & no_wa sebagai teks supaya angka 0 di depan tidak hilang
  const newHeader = cs.getRange(1, 1, 1, next - 1).getValues()[0].map(h => String(h).trim().toLowerCase());
  ['pin', 'no_wa'].forEach(col => {
    const i = newHeader.indexOf(col);
    if (i >= 0) cs.getRange(1, i + 1, cs.getMaxRows(), 1).setNumberFormat('@');
  });

  const sh = orderSheet_();
  const h9 = String(sh.getRange(1, 9).getValue()).trim();
  if (!h9 || h9 === 'No. WA') sh.getRange(1, 9).setValue('Username');
  if (!String(sh.getRange(1, 10).getValue()).trim()) sh.getRange(1, 10).setValue('No. WA');
}

/**
 * Jalankan manual untuk mengeluarkan semua pelanggan dari semua hape
 * (misalnya kalau PIN bocor). Pelanggan perlu login lagi.
 */
function keluarkanSemuaPelanggan() {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(k => { if (k.indexOf('sess_') === 0) props.deleteProperty(k); });
}

// ---------- helper ----------

function productSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return PRODUCT_SHEET_NAME ? ss.getSheetByName(PRODUCT_SHEET_NAME) : ss.getSheets()[0];
}

function readProducts_() {
  const sheet = productSheet_();
  const values = sheet.getDataRange().getValues();
  const header = values[0].map(h => String(h).trim().toLowerCase());
  const find = names => names.map(n => header.indexOf(n)).find(i => i >= 0);
  const col = {
    id: find(['id']),
    name: find(['name', 'nama']),
    price: find(['price', 'harga']),
    stock: find(['stock', 'stok']),
    category: find(['category', 'kategori']),
    image: find(['image', 'gambar', 'foto']),
    keterangan: find(['keterangan', 'desc', 'deskripsi'])
  };
  const rows = values.slice(1)
    .map((v, i) => ({ values: v, index: i + 2 })) // index = nomor baris di sheet
    .filter(r => String(r.values[col.name] || '').trim() !== '');
  return { sheet: sheet, rows: rows, col: col };
}

function toProduct_(v, col) {
  const get = c => (c === undefined ? '' : v[c]);
  const num = x => Number(String(x).replace(/[^\d]/g, '')) || 0;
  return {
    id: num(get(col.id)),
    name: String(get(col.name)).trim(),
    price: num(get(col.price)),
    stock: num(get(col.stock)),
    category: String(get(col.category) || 'bmx').trim().toLowerCase(),
    image: String(get(col.image)).trim(),
    keterangan: String(get(col.keterangan)).trim()
  };
}

function orderSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(ORDER_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(ORDER_SHEET_NAME, ss.getNumSheets());
    sh.appendRow(['Waktu', 'No. Pesanan', 'Nama', 'Alamat', 'Catatan', 'Barang', 'Total', 'Status', 'Username', 'No. WA']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function clean_(s, max) {
  return String(s || '').trim().slice(0, max);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
