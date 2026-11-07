/**
 * ASA Bike Shop — Google Apps Script
 * ------------------------------------------------------------
 * Dipasang di Google Sheets katalog (Extensions > Apps Script).
 *
 *  - GET  : mengirim daftar produk terbaru (langsung dari sheet, tanpa jeda cache)
 *  - POST : menerima pesanan dari website, mengecek & mengurangi stok,
 *           lalu mencatat pesanan ke sheet "Pesanan".
 *
 * Kolom sheet produk (baris 1 = judul, urutan bebas, huruf besar/kecil bebas):
 *   id | name | price | stock | category | image | keterangan
 */

const PRODUCT_SHEET_NAME = ''; // kosongkan = pakai sheet (tab) paling kiri
const ORDER_SHEET_NAME = 'Pesanan';

function doGet() {
  const { rows, col } = readProducts_();
  const products = rows.map(r => toProduct_(r.values, col));
  return json_({ ok: true, products: products });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: 'busy' });

  try {
    const order = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const name = clean_(order.name, 100);
    const address = clean_(order.address, 400);
    const notes = clean_(order.notes, 400);
    if (!name || !address) return json_({ ok: false, error: 'invalid', message: 'Nama dan alamat wajib diisi' });
    if (!Array.isArray(order.items) || order.items.length === 0 || order.items.length > 50) {
      return json_({ ok: false, error: 'invalid', message: 'Keranjang tidak valid' });
    }

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

    if (problems.length) return json_({ ok: false, error: 'stock', problems: problems });

    // Kurangi stok (pre-order tidak mengurangi stok)
    lines.forEach(l => {
      if (!l.po) sheet.getRange(l.row.index, col.stock + 1).setValue(l.p.stock - l.qty);
    });

    const now = new Date();
    const orderId = nextOrderId_(now);
    const itemText = lines.map(l => l.qty + 'x ' + l.p.name + (l.po ? ' [PO]' : '')).join('\n');

    orderSheet_().appendRow([now, orderId, name, address, notes, itemText, total, 'Baru']);

    return json_({ ok: true, orderId: orderId, total: total });
  } catch (err) {
    return json_({ ok: false, error: 'server', message: String(err) });
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
    sh = ss.insertSheet(ORDER_SHEET_NAME);
    sh.appendRow(['Waktu', 'No. Pesanan', 'Nama', 'Alamat', 'Catatan', 'Barang', 'Total', 'Status']);
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
