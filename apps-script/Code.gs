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
 *  - POST {action:'edit_product'}: pemilik mengubah stok & harga barang di katalog
 *  - POST {action:'edit_order_qty'}: pemilik mengubah jumlah barang di pesanan (stok ikut menyesuaikan)
 *  - POST {action:'cancel_order'}  : pemilik membatalkan pesanan (stok dikembalikan, status Dibatalkan)
 *  - POST {action:'set_status'}  : pemilik mengubah tahap pesanan (1 Diterima, 2 Diproses, 3 Sampai, 4 Selesai/lunas)
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

const ORDER_COLUMNS = ['Waktu', 'No. Pesanan', 'Nama', 'Alamat', 'Catatan', 'Barang', 'Total', 'Status', 'Username', 'No. WA', 'Lunas', 'Total Semula', 'Tgl Diterima', 'Jenis', 'Tgl Sampai'];
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
      case 'edit_product': return json_(editProduct_(body));
      case 'set_status': return json_(setStatus_(body));
      case 'edit_order_qty': return json_(editOrderQty_(body));
      case 'cancel_order': return json_(cancelOrder_(body));
      case 'product_info': return json_(productInfo_(body));
      case 'po_arrival': return json_(poArrival_(body));
      case 'set_preorder': return json_(setPreorder_(body));
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

    // Kurangi stok (pre-order tidak mengurangi stok; dijatah saat barang datang)
    const stockLog = [];
    lines.forEach(l => { if (!l.p.po) changeStock_(prod, l.row, -l.qty, '', stockLog); });

    const now = new Date();
    const os = orderSheet_();
    ensureColumns_(os, ['Jenis']);
    const det = detailSheet_();
    // Barang ready -> nomor ASA-..., barang pre-order -> nomor PO-... (urutan sendiri)
    const groups = [{ jenis: 'Reguler', lines: lines.filter(l => !l.p.po) }, { jenis: 'PO', lines: lines.filter(l => l.p.po) }].filter(g => g.lines.length);
    const orders = groups.map(g => {
      const no = nextOrderId_(now, g.jenis === 'PO' ? 'PO' : 'ASA');
      const tot = g.lines.reduce((a, l) => a + l.p.price * l.qty, 0);
      const newRow = appendByHeader_(os, {
        'Waktu': now, 'No. Pesanan': no, 'Nama': name, 'Alamat': address, 'Catatan': notes,
        'Barang': itemsText_(g.lines.map(l => ({ n: l.p.name, q: l.qty, po: l.p.po }))),
        'Total': tot, 'Status': 'Baru', 'Username': customer.username,
        'No. WA': customer.noWa ? "'" + customer.noWa : '', 'Lunas': false, 'Jenis': g.jenis
      });
      const lunasCol = headerIndex_(os)['lunas'];
      if (lunasCol >= 0) os.getRange(newRow, lunasCol + 1).insertCheckboxes();
      g.lines.forEach(l => appendByHeader_(det, {
        'No. Pesanan': no, 'ID Barang': l.p.id, 'Nama Barang': l.p.name, 'Jumlah': l.qty,
        'Satuan': l.p.satuan, 'Harga': l.p.price, 'Subtotal': l.p.price * l.qty
      }));
      return { no: no, jenis: g.jenis, total: tot };
    });
    const reg = orders.find(o => o.jenis !== 'PO');
    stockLog.forEach(e => { e.note = 'Pesanan ' + (reg ? reg.no : ''); });
    logStock_(stockLog);
    const orderId = orders.map(o => o.no).join(' + ');
    const total = orders.reduce((a, o) => a + o.total, 0);

    try { notifyNewOrder_({ no: orderId, nama: name, username: customer.username, alamat: address, catatan: notes, total: total, items: lines.map(l => ({ n: l.p.name, q: l.qty, p: l.p.price, po: l.p.po })) }); } catch (e) { console.warn('notif gagal', e); }
    return { ok: true, orderId: orderId, orders: orders, total: total, customer: { nama: name } };
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
  const poMap = productPoMap_();
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const orders = t.rows
    .filter(r => String(r.get('No. Pesanan')).trim() !== '')
    .filter(r => customer.owner || normalizeUsername_(r.get('Username')) === customer.username)
    .filter(r => normalizeStatus_(r.get('Status')) !== 'Dibatalkan')
    .map(r => orderFromRow_(r, details, tz, poMap))
    .reverse()
    .slice(0, customer.owner ? 500 : 100);
  return { ok: true, owner: customer.owner, orders: orders };
}

function orderFromRow_(r, details, tz, poMap) {
  const no = String(r.get('No. Pesanan')).trim();
  const w = r.get('Waktu');
  const d = w instanceof Date ? w : null;
  const items = details[no] ? details[no].map(x => x.item) : parseItemsText_(r.get('Barang'));
  const pm = poMap || productPoMap_();
  const poNames = String(r.get('Barang')).split('\n').filter(l => /\[PO\]\s*$/.test(l)).map(l => l.replace(/^\d+\s*x\s*/i, '').replace(/\s*\[PO\]\s*$/, '').trim().toLowerCase());
  // Tanda PO dari pesanannya (bukan dari katalog, karena barang PO bisa berubah jadi ready setelah datang)
  const poOrder = orderType_(r) === 'PO';
  items.forEach(it => { it.po = poOrder || poNames.indexOf(String(it.n).toLowerCase()) >= 0; if (!it.u) it.u = (it.id && pm.unitById[it.id]) || pm.unitByName[String(it.n).toLowerCase()] || ''; });
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
    jenis: orderType_(r),
    jatuhTempo: dueDate_(r, d, tz),
    items: items
  };
}

function orderType_(r) {
  const j = String(r.get('Jenis')).trim().toLowerCase();
  if (j) return j.indexOf('po') === 0 || j.indexOf('pre') === 0 ? 'PO' : 'Reguler';
  return /^PO-/i.test(String(r.get('No. Pesanan')).trim()) ? 'PO' : 'Reguler';
}

// Pesanan PO: jatuh tempo = tanggal barang PO sampai ke pelanggan (kolom "Tgl Sampai", tahap 3) + 1 bulan.
// Jatuh tempo = tanggal pesanan diterima toko (kolom "Tgl Diterima") + 1 bulan.
// Pesanan lama yang sudah diterima tapi belum punya tanggal: dihitung dari tanggal pesan.
function dueDate_(r, orderDate, tz) {
  const status = normalizeStatus_(r.get('Status'));
  if (status === 'Baru' || status === 'Dibatalkan') return null;
  let base;
  if (orderType_(r) === 'PO') {
    if (status !== 'Sampai' && status !== 'Selesai') return null; // barang PO belum diserahkan
    const sampai = r.get('Tgl Sampai');
    base = sampai instanceof Date ? sampai : orderDate;
  } else {
    const acc = r.get('Tgl Diterima');
    base = acc instanceof Date ? acc : orderDate;
  }
  if (!base) return null;
  const y = Number(Utilities.formatDate(base, tz, 'yyyy')), m = Number(Utilities.formatDate(base, tz, 'M')), day = Number(Utilities.formatDate(base, tz, 'd'));
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // 31 Jan -> 28/29 Feb
  const dd = Math.min(day, last), mm = m % 12 + 1, yy = m === 12 ? y + 1 : y;
  return { iso: yy + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0'), label: dd + ' ' + BULAN[mm - 1] + ' ' + yy };
}

// Tahap pesanan (bar di tab Riwayat). Hanya pemilik yang bisa mengubah lewat web.
//   0 Baru      : pesanan masuk, belum dikonfirmasi toko
//   1 Diterima  : pesanan diterima toko
//   2 Diproses  : pesanan sedang diproses
//   3 Sampai    : barang sudah diterima pelanggan, belum lunas
//   4 Selesai   : lunas dan sudah beres
const STATUS_STEPS = ['Baru', 'Diterima', 'Diproses', 'Sampai', 'Selesai'];

function normalizeStatus_(s) {
  const v = String(s || '').trim().toLowerCase();
  if (v.indexOf('batal') >= 0) return 'Dibatalkan';
  if (v.indexOf('selesai') === 0 || v === 'beres') return 'Selesai';
  if (v.indexOf('sampai') >= 0 || v.indexOf('kirim') >= 0 || v.indexOf('pelanggan') >= 0) return 'Sampai';
  if (v.indexOf('proses') >= 0 || v.indexOf('datang') >= 0) return 'Diproses';
  if (v.indexOf('terima') >= 0) return 'Diterima';
  return 'Baru';
}

function setStatus_(body) {
  const customer = customerFromToken_(body.token);
  if (!customer) return { ok: false, error: 'auth', message: 'Silakan masuk lagi' };
  if (!customer.owner) return { ok: false, error: 'forbidden', message: 'Hanya pemilik toko yang bisa mengubah status' };
  const no = String(body.no || '').trim();
  const step = Math.floor(Number(body.step));
  if (!no || !(step >= 0 && step <= 4)) return { ok: false, error: 'invalid', message: 'Status tidak valid' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    const os = orderSheet_();
    const r = table_(os).rows.find(x => String(x.get('No. Pesanan')).trim() === no);
    if (!r) return { ok: false, error: 'notfound', message: 'Pesanan tidak ditemukan' };
    const res = applyStatus_(os, r, step);
    if (!res.ok) return res;
    const fresh = table_(os).rows.find(x => x.index === r.index);
    return { ok: true, order: orderFromRow_(fresh, detailMap_(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone()) };
  } finally {
    lock.releaseLock();
  }
}

// Ubah tahap satu pesanan (dipakai tombol status dan form "Barang PO datang")
function applyStatus_(os, r, step) {
  const no = String(r.get('No. Pesanan')).trim();
  const h = headerIndex_(os);
  const before = STATUS_STEPS.indexOf(normalizeStatus_(r.get('Status')));
  if (before < 0) return { ok: false, error: 'invalid', message: 'Pesanan ini sudah dibatalkan' };
  const isPO = orderType_(r) === 'PO';
  // Pesanan PO: barang dijatah dari stok saat masuk tahap 2 (Barang PO datang), dikembalikan kalau turun lagi
  if (isPO && (before >= 2) !== (step >= 2)) {
    const moved = movePoStock_(no, r, step >= 2 ? -1 : 1);
    if (!moved.ok) return moved;
  }
  os.getRange(r.index, h['status'] + 1).setValue(isPO && step === 2 ? 'Barang datang' : STATUS_STEPS[step]);
  // Catat tanggal barang sampai ke pelanggan (untuk jatuh tempo pesanan PO)
  if (step >= 3 && before < 3 && !(r.get('Tgl Sampai') instanceof Date)) {
    let col = h['tgl sampai'];
    if (col < 0) { ensureColumns_(os, ['Tgl Sampai']); col = headerIndex_(os)['tgl sampai']; }
    os.getRange(r.index, col + 1).setValue(new Date()).setNumberFormat('d mmm yyyy');
  }
  // Catat tanggal pesanan diterima toko (sekali saja) untuk menghitung jatuh tempo
  if (step >= 1 && before === 0 && !(r.get('Tgl Diterima') instanceof Date)) {
    let col = h['tgl diterima'];
    if (col < 0) { ensureColumns_(os, ['Tgl Diterima']); col = headerIndex_(os)['tgl diterima']; }
    os.getRange(r.index, col + 1).setValue(new Date()).setNumberFormat('d mmm yyyy');
  }
  // Tahap 4 = lunas. Kalau diturunkan dari tahap 4, tanda lunas ikut dilepas.
  if (h['lunas'] >= 0) {
    if (step === 4) os.getRange(r.index, h['lunas'] + 1).setValue(true);
    else if (before === 4) os.getRange(r.index, h['lunas'] + 1).setValue(false);
  }
  return { ok: true };
}

// ---------- pemilik: ubah stok & harga barang di katalog ----------

function editProduct_(body) {
  const customer = customerFromToken_(body.token);
  if (!customer) return { ok: false, error: 'auth', message: 'Silakan masuk lagi' };
  if (!customer.owner) return { ok: false, error: 'forbidden', message: 'Hanya pemilik toko yang bisa mengubah barang' };
  const id = String(Math.floor(Number(body.id)) || '');
  const stock = Math.floor(Number(body.stock));
  const price = Math.round(Number(body.price));
  if (!id) return { ok: false, error: 'invalid', message: 'Barang tidak dikenal' };
  if (!(stock >= 0 && stock <= 999999)) return { ok: false, error: 'invalid', message: 'Stok harus angka 0 atau lebih' };
  if (!(price > 0)) return { ok: false, error: 'invalid', message: 'Harga harus diisi' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    const prod = readProducts_();
    if (prod.col.stock < 0 || prod.col.price < 0) return { ok: false, error: 'invalid', message: 'Kolom stock / price tidak ditemukan di tab produk' };
    const row = prod.rows.find(r => String(toProduct_(r.values, r.col).id) === id);
    if (!row) return { ok: false, error: 'notfound', message: 'Barang tidak ditemukan di Sheets' };
    const oldStock = toProduct_(row.values, row.col).stock;
    if (stock !== oldStock) { const log = []; changeStock_(prod, row, stock - oldStock, 'Ubah stok (web)', log); logStock_(log); }
    prod.sheet.getRange(row.index, prod.col.price + 1).setValue(price);
    const fresh = readProducts_().rows.find(r => r.index === row.index);
    return { ok: true, product: toProduct_(fresh.values, fresh.col) };
  } finally {
    lock.releaseLock();
  }
}

// ---------- pemilik: ubah jumlah / batalkan pesanan (stok ikut menyesuaikan) ----------

// id barang & nama barang (huruf kecil) -> true jika pre-order
function productPoMap_() {
  const map = { byId: {}, byName: {}, unitById: {}, unitByName: {} };
  readProducts_().rows.forEach(r => { const p = toProduct_(r.values, r.col); map.byId[p.id] = p.po; map.byName[p.name.toLowerCase()] = p.po; map.unitById[p.id] = p.satuan; map.unitByName[p.name.toLowerCase()] = p.satuan; });
  return map;
}

// Cari baris produk berdasarkan id, atau nama jika id tidak ada (pesanan lama)
function findProductRow_(prod, id, name) {
  return prod.rows.find(r => { const p = toProduct_(r.values, r.col); return id ? String(p.id) === String(id) : p.name.toLowerCase() === String(name || '').toLowerCase(); });
}

function editOrderQty_(body) {
  const customer = customerFromToken_(body.token);
  if (!customer) return { ok: false, error: 'auth', message: 'Silakan masuk lagi' };
  if (!customer.owner) return { ok: false, error: 'forbidden', message: 'Hanya pemilik toko yang bisa mengubah pesanan' };
  const no = String(body.no || '').trim();
  if (!no || !Array.isArray(body.items)) return { ok: false, error: 'invalid', message: 'Data tidak lengkap' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    const os = orderSheet_();
    const orow = table_(os).rows.find(r => String(r.get('No. Pesanan')).trim() === no);
    if (!orow) return { ok: false, error: 'notfound', message: 'Pesanan tidak ditemukan' };
    if (normalizeStatus_(orow.get('Status')) === 'Dibatalkan') return { ok: false, error: 'invalid', message: 'Pesanan ini sudah dibatalkan' };
    const details = detailMap_()[no];
    if (!details) return { ok: false, error: 'no_detail', message: 'Pesanan lama ini belum punya rincian per barang, jadi jumlahnya belum bisa diubah dari web' };
    if (body.items.length !== details.length) return { ok: false, error: 'invalid', message: 'Data barang tidak cocok, muat ulang halaman' };

    const qs = body.items.map(it => Math.floor(Number(it.q)));
    if (qs.some(q => !(q >= 0 && q <= 9999))) return { ok: false, error: 'invalid', message: 'Jumlah harus angka 0 atau lebih' };
    if (qs.every(q => q === 0)) return { ok: false, error: 'invalid', message: 'Semua jumlah 0. Pakai tombol Batalkan pesanan.' };

    // Cek stok untuk barang yang jumlahnya ditambah
    const prod = readProducts_();
    const holds = orderHoldsStock_(orow);
    const updates = [];
    for (let k = 0; k < details.length; k++) {
      const it = details[k].item, delta = qs[k] - it.q;
      if (!delta || !holds) continue;
      const row = findProductRow_(prod, it.id, it.n);
      if (!row) continue;
      const p = toProduct_(row.values, row.col);
      if (delta > p.stock) return { ok: false, error: 'stock', message: 'Stok "' + p.name + '" tinggal ' + p.stock + ', tidak cukup untuk menambah ' + delta };
      updates.push({ row: row, delta: -delta });
    }
    const stockLog = [];
    updates.forEach(u => changeStock_(prod, u.row, u.delta, 'Ubah jumlah ' + no, stockLog));
    logStock_(stockLog);

    // Perbarui Detail Pesanan (baris dengan jumlah 0 dihapus, dari bawah supaya nomor baris tidak bergeser)
    const ds = detailSheet_();
    const dh = headerIndex_(ds);
    details.forEach((d, k) => {
      if (qs[k] > 0) { ds.getRange(d.index, dh['jumlah'] + 1).setValue(qs[k]); ds.getRange(d.index, dh['subtotal'] + 1).setValue(qs[k] * d.item.p); }
    });
    details.map((d, k) => ({ d: d, q: qs[k] })).filter(x => x.q === 0).sort((a, b) => b.d.index - a.d.index).forEach(x => ds.deleteRow(x.d.index));

    // Perbarui baris Pesanan
    const oh = headerIndex_(os);
    const isPoOrder = orderType_(orow) === 'PO';
    const kept = details.map((d, k) => ({ n: d.item.n, q: qs[k], p: d.item.p, po: isPoOrder })).filter(x => x.q > 0);
    const oldTotal = num_(orow.get('Total'));
    const newTotal = kept.reduce((a, x) => a + x.q * x.p, 0);
    if (!num_(orow.get('Total Semula')) && newTotal !== oldTotal && oh['total semula'] >= 0) os.getRange(orow.index, oh['total semula'] + 1).setValue(oldTotal);
    os.getRange(orow.index, oh['total'] + 1).setValue(newTotal);
    os.getRange(orow.index, oh['barang'] + 1).setValue(itemsText_(kept));

    const fresh = table_(os).rows.find(r => r.index === orow.index);
    return { ok: true, order: orderFromRow_(fresh, detailMap_(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone()) };
  } finally {
    lock.releaseLock();
  }
}

function cancelOrder_(body) {
  const customer = customerFromToken_(body.token);
  if (!customer) return { ok: false, error: 'auth', message: 'Silakan masuk lagi' };
  if (!customer.owner) return { ok: false, error: 'forbidden', message: 'Hanya pemilik toko yang bisa membatalkan pesanan' };
  const no = String(body.no || '').trim();
  if (!no) return { ok: false, error: 'invalid', message: 'Data tidak lengkap' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    const os = orderSheet_();
    const orow = table_(os).rows.find(r => String(r.get('No. Pesanan')).trim() === no);
    if (!orow) return { ok: false, error: 'notfound', message: 'Pesanan tidak ditemukan' };
    if (normalizeStatus_(orow.get('Status')) === 'Dibatalkan') return { ok: false, error: 'invalid', message: 'Pesanan ini sudah dibatalkan' };

    // Kembalikan stok kalau pesanan sudah memotong stok (reguler, atau PO yang barangnya sudah dijatah)
    const holds = orderHoldsStock_(orow);
    const stockLog = [];
    const o = orderFromRow_(orow, detailMap_(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone());
    const prod = readProducts_();
    const returned = [];
    o.items.forEach(it => {
      if (!holds) return;
      const row = findProductRow_(prod, it.id, it.n);
      if (!row) return;
      const p = toProduct_(row.values, row.col);
      changeStock_(prod, row, it.q, 'Batal ' + no, stockLog);
      returned.push({ name: p.name, q: it.q });
    });
    logStock_(stockLog);
    const oh = headerIndex_(os);
    os.getRange(orow.index, oh['status'] + 1).setValue('Dibatalkan');
    return { ok: true, no: no, returned: returned };
  } finally {
    lock.releaseLock();
  }
}

// ---------- mutasi stok (catatan keluar-masuk barang) ----------

const STOCK_LOG_SHEET_NAME = 'Mutasi Stok';
const STOCK_LOG_COLUMNS = ['Waktu', 'ID Barang', 'Nama Barang', 'Masuk', 'Keluar', 'Stok Akhir', 'Keterangan'];

// Ubah stok satu barang dan siapkan catatannya (ditulis sekaligus lewat logStock_)
function changeStock_(prod, row, delta, note, log) {
  const p = toProduct_(row.values, row.col);
  const stock = p.stock + delta;
  prod.sheet.getRange(row.index, prod.col.stock + 1).setValue(stock);
  row.values[prod.col.stock] = stock;
  log.push({ id: p.id, name: p.name, delta: delta, stock: stock, note: note });
}

function logStock_(entries) {
  if (!entries || !entries.length) return;
  const sh = sheetWithHeader_(STOCK_LOG_SHEET_NAME, STOCK_LOG_COLUMNS);
  const now = new Date();
  const rows = entries.map(e => [now, e.id || '', e.name, e.delta > 0 ? e.delta : '', e.delta < 0 ? -e.delta : '', e.stock, e.note]);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, STOCK_LOG_COLUMNS.length).setValues(rows);
}

// Pesanan reguler memotong stok saat checkout. Pesanan PO baru memotong stok saat barang datang (tahap 2 ke atas).
function orderHoldsStock_(r) {
  if (orderType_(r) !== 'PO') return true;
  return STATUS_STEPS.indexOf(normalizeStatus_(r.get('Status'))) >= 2;
}

// Jatah barang untuk pesanan PO: sign -1 = ambil dari stok, +1 = kembalikan ke stok
function movePoStock_(no, r, sign) {
  const details = detailMap_()[no];
  const items = details ? details.map(d => d.item) : parseItemsText_(r.get('Barang'));
  const prod = readProducts_();
  const rows = items.map(it => ({ it: it, row: findProductRow_(prod, it.id, it.n) })).filter(x => x.row);
  if (sign < 0) {
    for (const x of rows) {
      const p = toProduct_(x.row.values, x.row.col);
      if (p.stock < x.it.q) return { ok: false, error: 'stock', message: 'Stok "' + p.name + '" tinggal ' + p.stock + ', kurang untuk ' + no + ' (' + x.it.q + '). Isi dulu lewat "Barang PO datang".' };
    }
  }
  const log = [];
  rows.forEach(x => changeStock_(prod, x.row, sign * x.it.q, (sign < 0 ? 'Jatah ' : 'Jatah dikembalikan ') + no, log));
  logStock_(log);
  return { ok: true };
}

// Pemilik: pesanan PO yang menunggu barang ini + 10 catatan stok terakhir
function productInfo_(body) {
  const customer = customerFromToken_(body.token);
  if (!customer) return { ok: false, error: 'auth', message: 'Silakan masuk lagi' };
  if (!customer.owner) return { ok: false, error: 'forbidden' };
  const id = String(Math.floor(Number(body.id)) || '');
  const prod = readProducts_();
  const row = prod.rows.find(r => String(toProduct_(r.values, r.col).id) === id);
  if (!row) return { ok: false, error: 'notfound', message: 'Barang tidak ditemukan' };
  const p = toProduct_(row.values, row.col);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const details = detailMap_();
  const waiting = [];
  table_(orderSheet_()).rows.forEach(r => {
    const no = String(r.get('No. Pesanan')).trim();
    if (!no || orderType_(r) !== 'PO') return;
    const step = STATUS_STEPS.indexOf(normalizeStatus_(r.get('Status')));
    if (step < 0 || step >= 2) return;
    const items = details[no] ? details[no].map(d => d.item) : parseItemsText_(r.get('Barang'));
    const q = items.filter(it => it.id ? String(it.id) === id : it.n.toLowerCase() === p.name.toLowerCase()).reduce((a, it) => a + it.q, 0);
    if (!q) return;
    const w = r.get('Waktu');
    waiting.push({ no: no, nama: String(r.get('Nama')).trim(), q: q, others: items.length > 1, tgl: w instanceof Date ? Utilities.formatDate(w, tz, 'd/M/yyyy') : String(w || '') });
  });
  const log = [];
  const ls = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_LOG_SHEET_NAME);
  if (ls) {
    const t = table_(ls);
    for (let i = t.rows.length - 1; i >= 0 && log.length < 10; i--) {
      const r = t.rows[i];
      if (String(r.get('ID Barang')) !== id && String(r.get('Nama Barang')).trim().toLowerCase() !== p.name.toLowerCase()) continue;
      const w = r.get('Waktu');
      log.push({ tgl: w instanceof Date ? Utilities.formatDate(w, tz, 'd/M/yyyy HH:mm') : String(w || ''), masuk: num_(r.get('Masuk')), keluar: num_(r.get('Keluar')), stok: String(r.get('Stok Akhir')), ket: String(r.get('Keterangan')) });
    }
  }
  return { ok: true, id: p.id, waiting: waiting, log: log };
}

// Pemilik: barang PO datang -> stok bertambah, barang jadi ready (kategori & harga baru), pesanan PO yang dicentang dijatah
function poArrival_(body) {
  const customer = customerFromToken_(body.token);
  if (!customer) return { ok: false, error: 'auth', message: 'Silakan masuk lagi' };
  if (!customer.owner) return { ok: false, error: 'forbidden', message: 'Hanya pemilik toko' };
  const id = String(Math.floor(Number(body.id)) || '');
  const qty = Math.floor(Number(body.qty));
  const price = Math.round(Number(body.price));
  const category = clean_(body.category, 40).toLowerCase();
  const fill = Array.isArray(body.fill) ? body.fill.map(x => String(x).trim()).filter(String) : [];
  if (!(qty > 0 && qty <= 99999)) return { ok: false, error: 'invalid', message: 'Jumlah datang harus diisi' };
  if (!(price > 0)) return { ok: false, error: 'invalid', message: 'Harga harus diisi' };
  if (!category || category === 'pre-order' || category === 'po') return { ok: false, error: 'invalid', message: 'Pilih kategori barang ready' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    const prod = readProducts_();
    const row = prod.rows.find(r => String(toProduct_(r.values, r.col).id) === id);
    if (!row) return { ok: false, error: 'notfound', message: 'Barang tidak ditemukan' };
    const p = toProduct_(row.values, row.col);
    if (!p.po) return { ok: false, error: 'invalid', message: 'Barang ini bukan pre-order' };

    // Cek pesanan yang dicentang: harus PO, menunggu barang, dan stok cukup untuk semuanya
    const os = orderSheet_();
    const orows = table_(os).rows;
    const details = detailMap_();
    const picked = [];
    let need = 0;
    for (const no of fill) {
      const r = orows.find(x => String(x.get('No. Pesanan')).trim() === no);
      if (!r || orderType_(r) !== 'PO') return { ok: false, error: 'invalid', message: no + ' bukan pesanan PO' };
      const step = STATUS_STEPS.indexOf(normalizeStatus_(r.get('Status')));
      if (step < 0 || step >= 2) return { ok: false, error: 'invalid', message: no + ' sudah tidak menunggu barang' };
      const items = details[no] ? details[no].map(d => d.item) : parseItemsText_(r.get('Barang'));
      if (items.some(it => it.id ? String(it.id) !== id : it.n.toLowerCase() !== p.name.toLowerCase())) return { ok: false, error: 'invalid', message: no + ' berisi barang PO lain, penuhi lewat tombol tahap pesanan' };
      need += items.reduce((a, it) => a + it.q, 0);
      picked.push(r);
    }
    if (need > p.stock + qty) return { ok: false, error: 'stock', message: 'Barang datang ' + qty + ', tapi pesanan yang dicentang butuh ' + need };

    const log = [];
    changeStock_(prod, row, qty, 'Barang PO datang', log);
    logStock_(log);
    // Jadi barang ready
    if (prod.col.category >= 0) prod.sheet.getRange(row.index, prod.col.category + 1).setValue(category);
    if (prod.col.group >= 0 && String(row.values[prod.col.group]).trim().toLowerCase() === 'pre-order') prod.sheet.getRange(row.index, prod.col.group + 1).setValue('');
    if (prod.col.preorder >= 0) prod.sheet.getRange(row.index, prod.col.preorder + 1).setValue(false);
    if (prod.col.price >= 0) prod.sheet.getRange(row.index, prod.col.price + 1).setValue(price);
    // Pesanan PO yang dicentang naik ke tahap 2 (stok dijatah di sini)
    const filled = [];
    for (const r of picked) {
      const res = applyStatus_(os, r, 2);
      if (!res.ok) return res;
      filled.push(String(r.get('No. Pesanan')).trim());
    }
    const fresh = readProducts_().rows.find(r => r.index === row.index);
    return { ok: true, product: toProduct_(fresh.values, fresh.col), filled: filled };
  } finally {
    lock.releaseLock();
  }
}

// Pemilik: barang ready yang stoknya habis dibuka lagi untuk pre-order
function setPreorder_(body) {
  const customer = customerFromToken_(body.token);
  if (!customer) return { ok: false, error: 'auth', message: 'Silakan masuk lagi' };
  if (!customer.owner) return { ok: false, error: 'forbidden', message: 'Hanya pemilik toko' };
  const id = String(Math.floor(Number(body.id)) || '');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    const prod = readProducts_();
    const row = prod.rows.find(r => String(toProduct_(r.values, r.col).id) === id);
    if (!row) return { ok: false, error: 'notfound', message: 'Barang tidak ditemukan' };
    const p = toProduct_(row.values, row.col);
    if (p.stock > 0) return { ok: false, error: 'invalid', message: 'Stok masih ' + p.stock + '. Jadikan pre-order hanya kalau stok sudah habis.' };
    if (prod.col.category < 0) return { ok: false, error: 'invalid', message: 'Kolom category tidak ditemukan' };
    prod.sheet.getRange(row.index, prod.col.category + 1).setValue('pre-order');
    const fresh = readProducts_().rows.find(r => r.index === row.index);
    return { ok: true, product: toProduct_(fresh.values, fresh.col) };
  } finally {
    lock.releaseLock();
  }
}

/** Otomatis: angka stok yang diketik langsung di tab produk ikut dicatat di Mutasi Stok. */
function onEdit(e) {
  try {
    const sh = e.range.getSheet();
    if (sh.getSheetId() !== productSheet_().getSheetId()) return;
    const prod = readProducts_();
    const c = prod.col.stock + 1;
    if (c < 1 || c < e.range.getColumn() || c > e.range.getColumn() + e.range.getNumColumns() - 1) return;
    const single = e.range.getNumRows() === 1 && e.range.getNumColumns() === 1;
    const log = [];
    for (let i = 0; i < e.range.getNumRows(); i++) {
      const row = prod.rows.find(x => x.index === e.range.getRow() + i);
      if (!row) continue;
      const p = toProduct_(row.values, row.col);
      const old = single ? num_(e.oldValue) : null;
      if (old === p.stock) continue;
      log.push({ id: p.id, name: p.name, delta: old === null ? null : p.stock - old, stock: p.stock, note: 'Koreksi manual di Sheets' + (old === null ? ' (stok lama tidak diketahui)' : '') });
    }
    logStock_(log);
  } catch (err) {
    console.warn('catat stok gagal', err);
  }
}

// ---------- pesanan lama yang isinya campur ready + PO -> dipecah jadi pesanan ASA dan PO ----------

/** Menu ASA > Pisahkan PO dari pesanan lama (cukup dijalankan sekali). */
function pisahkanPoLama() {
  const ui = SpreadsheetApp.getUi();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { ui.alert('Sedang ada proses lain, coba lagi sebentar.'); return; }
  const done = [];
  try {
    const os = orderSheet_();
    ensureColumns_(os, ['Jenis']);
    const h = headerIndex_(os);
    const ds = detailSheet_();
    const dh = headerIndex_(ds);
    const pm = productPoMap_();
    const details = detailMap_();
    table_(os).rows.forEach(r => {
      const no = String(r.get('No. Pesanan')).trim();
      if (!no || orderType_(r) === 'PO' || normalizeStatus_(r.get('Status')) === 'Dibatalkan' || !details[no]) return;
      const isPo = d => !!((d.item.id && pm.byId[d.item.id]) || pm.byName[d.item.n.toLowerCase()]);
      const po = details[no].filter(isPo), ready = details[no].filter(d => !isPo(d));
      if (!po.length || !ready.length) return;

      const w = r.get('Waktu');
      const poNo = nextOrderId_(w instanceof Date ? w : new Date(), 'PO');
      const poTotal = po.reduce((a, d) => a + d.item.q * d.item.p, 0);
      const readyTotal = ready.reduce((a, d) => a + d.item.q * d.item.p, 0);
      const wa = String(r.get('No. WA')).trim();
      const acc = r.get('Tgl Diterima');
      const newRow = appendByHeader_(os, {
        'Waktu': w, 'No. Pesanan': poNo, 'Nama': r.get('Nama'), 'Alamat': r.get('Alamat'), 'Catatan': r.get('Catatan'),
        'Barang': itemsText_(po.map(d => ({ n: d.item.n, q: d.item.q, po: true }))), 'Total': poTotal,
        'Status': normalizeStatus_(r.get('Status')) === 'Baru' ? 'Baru' : 'Diterima',
        'Username': r.get('Username'), 'No. WA': wa ? "'" + wa : '', 'Lunas': false, 'Jenis': 'PO',
        'Tgl Diterima': acc instanceof Date ? acc : ''
      });
      if (h['lunas'] >= 0) os.getRange(newRow, h['lunas'] + 1).insertCheckboxes();
      po.forEach(d => ds.getRange(d.index, dh['no. pesanan'] + 1).setValue(poNo));
      os.getRange(r.index, h['barang'] + 1).setValue(itemsText_(ready.map(d => ({ n: d.item.n, q: d.item.q }))));
      os.getRange(r.index, h['total'] + 1).setValue(readyTotal);
      os.getRange(r.index, headerIndex_(os)['jenis'] + 1).setValue('Reguler');
      done.push(no + ' (Rp ' + fmt_(readyTotal) + ')  +  ' + poNo + ' (Rp ' + fmt_(poTotal) + ')');
    });
  } finally {
    lock.releaseLock();
  }
  ui.alert('Pisahkan PO', done.length ? 'Sudah dipisah:\n\n' + done.join('\n') : 'Tidak ada pesanan lama yang isinya campur barang ready dan PO.', ui.ButtonSet.OK);
}

// ---------- notifikasi pesanan baru (Telegram + email) ----------

function notifyNewOrder_(o) {
  const lines = o.items.map(it => '• ' + it.q + 'x ' + it.n + (it.po ? ' [PRE-ORDER]' : '') + ' — Rp ' + fmt_(it.p * it.q));
  const text = '🛒 PESANAN BARU ' + o.no + '\n\n' +
    'Pelanggan: ' + o.nama + ' (' + o.username + ')\n\n' +
    lines.join('\n') + '\n\n' +
    'Total: Rp ' + fmt_(o.total) + '\n' +
    (o.catatan ? 'Catatan: ' + o.catatan + '\n' : '') +
    'Alamat: ' + o.alamat + '\n\n' +
    'Cek di web: https://asabikes.vercel.app (menu Riwayat)';
  sendTelegram_(text);
  sendOwnerEmail_('Pesanan baru ' + o.no + ' dari ' + o.nama, text);
}

function sendTelegram_(text) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TG_TOKEN'), chat = props.getProperty('TG_CHAT');
  if (!token || !chat) return false;
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post', payload: { chat_id: chat, text: text, disable_web_page_preview: 'true' }, muteHttpExceptions: true
  });
  return res.getResponseCode() === 200;
}

function sendOwnerEmail_(subject, text) {
  const props = PropertiesService.getScriptProperties();
  const setting = props.getProperty('NOTIF_EMAIL');
  if (setting === 'off') return false;
  const to = setting || Session.getEffectiveUser().getEmail();
  if (!to) return false;
  MailApp.sendEmail(to, subject, text);
  return true;
}

/** Menu ASA > Hubungkan notifikasi Telegram: simpan token bot dari @BotFather. */
function hubungkanTelegram() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Hubungkan Telegram',
    'Tempel token bot dari @BotFather (contoh: 123456789:ABCdef...).', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const token = r.getResponseText().trim();
  if (!/^\d+:[\w-]{20,}$/.test(token)) { ui.alert('Token sepertinya tidak lengkap. Salin ulang dari @BotFather.'); return; }
  const props = PropertiesService.getScriptProperties();
  props.setProperty('TG_TOKEN', token);
  props.deleteProperty('TG_CHAT');
  ui.alert('Token tersimpan',
    'Sekarang buka bot Anda di Telegram, tekan Start atau kirim pesan apa saja (misalnya "halo").\n\nSetelah itu kembali ke sini dan pilih menu ASA > Tes notifikasi.', ui.ButtonSet.OK);
}

/** Menu ASA > Tes notifikasi: hubungkan chat Telegram (sekali) lalu kirim pesan tes ke Telegram & email. */
function tesNotifikasi() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TG_TOKEN');
  let tgInfo = 'Telegram belum dihubungkan (menu ASA > Hubungkan notifikasi Telegram).';
  if (token) {
    if (!props.getProperty('TG_CHAT')) {
      const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true });
      const data = JSON.parse(res.getContentText() || '{}');
      const last = (data.result || []).filter(u => u.message && u.message.chat).pop();
      if (last) props.setProperty('TG_CHAT', String(last.message.chat.id));
    }
    if (!props.getProperty('TG_CHAT')) tgInfo = 'Telegram: belum ada pesan ke bot. Buka bot Anda, tekan Start / kirim "halo", lalu coba lagi.';
    else tgInfo = sendTelegram_('✅ Tes notifikasi ASA Bike Shop berhasil. Pesanan baru akan muncul di sini.') ? 'Telegram: terkirim ✅' : 'Telegram: gagal mengirim. Periksa token bot.';
  }
  let mailInfo;
  try { mailInfo = sendOwnerEmail_('Tes notifikasi ASA Bike Shop', 'Tes notifikasi berhasil. Pesanan baru akan dikirim ke email ini.') ? 'Email: terkirim ✅' : 'Email: dimatikan'; }
  catch (e) { mailInfo = 'Email: gagal (' + e + ')'; }
  ui.alert('Hasil tes notifikasi', tgInfo + '\n' + mailInfo, ui.ButtonSet.OK);
}

// ======================================================================
// MENU DI GOOGLE SHEETS
// ======================================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ASA')
    .addItem('Buat invoice PDF (baris yang dipilih)', 'buatInvoicePdf')
    .addSeparator()
    .addItem('Pisahkan PO dari pesanan lama', 'pisahkanPoLama')
    .addSeparator()
    .addItem('Hubungkan notifikasi Telegram', 'hubungkanTelegram')
    .addItem('Tes notifikasi', 'tesNotifikasi')
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
  // Tanggal invoice = hari invoice dicetak (tanggal tagihan); tanggal pesan sudah ada di nomor pesanan
  const now = new Date();
  o.tglPanjang = Number(Utilities.formatDate(now, tz, 'd')) + ' ' + BULAN_PANJANG[Number(Utilities.formatDate(now, tz, 'M')) - 1] + ' ' + Utilities.formatDate(now, tz, 'yyyy');
  o.wa = String(r.get('No. WA')).replace(/^'/, '').trim();
  if (!o.wa) { const c = findCustomer_(normalizeUsername_(r.get('Username'))); if (c) o.wa = c.noWa; }
  if (details[o.no]) details[o.no].forEach((d, k) => { o.items[k].u = d.item.u; });

  // Barang pre-order dibuatkan invoice terpisah karena dikirim belakangan
  const ready = o.items.filter(it => !it.po), po = o.items.filter(it => it.po);
  const hasPrices = o.items.every(it => it.p);
  const parts = (ready.length && po.length && hasPrices)
    ? [Object.assign({}, o, { items: ready, fileName: o.no }), Object.assign({}, o, { items: po, fileName: o.no + '-PO', title: 'INVOICE PRE-ORDER', poNote: true })]
    : [Object.assign({}, o, po.length && !ready.length ? { title: 'INVOICE PRE-ORDER', poNote: true } : {})];
  const folder = invoiceFolder_();
  const urls = parts.map(part => {
    const pdf = invoicePdf_(part);
    const existing = folder.getFilesByName(pdf.getName());
    while (existing.hasNext()) existing.next().setTrashed(true);
    return pdf.getName() + ':\n' + folder.createFile(pdf).getUrl();
  });
  ui.alert('Invoice ' + o.no + ' dibuat', (parts.length > 1 ? 'Barang ready dan pre-order dibuat terpisah.\n\n' : '') + 'Tersimpan di Google Drive, folder "' + INVOICE_FOLDER_NAME + '":\n\n' + urls.join('\n\n'), ui.ButtonSet.OK);
}

function invoiceFolder_() {
  const it = DriveApp.getFoldersByName(INVOICE_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(INVOICE_FOLDER_NAME);
}

// Invoice dibuat sebagai Google Docs sementara, lalu diekspor ke PDF.
// Kertas A4 tegak berisi 2 lembar invoice ukuran A5 (atas & bawah), tinggal dicetak lalu dipotong di tengah.
function invoicePdf_(o) {
  const A = DocumentApp.Attribute;
  const doc = DocumentApp.create('Invoice ' + (o.fileName || o.no));
  const body = doc.getBody();
  body.setPageWidth(595.3).setPageHeight(841.9)
    .setMarginTop(16).setMarginBottom(14).setMarginLeft(22).setMarginRight(22);
  const base = {}; base[A.FONT_FAMILY] = 'Arial'; base[A.FONT_SIZE] = 8; base[A.FOREGROUND_COLOR] = '#111827';
  body.setAttributes(base);
  const tiny = p => { p.setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1).editAsText().setFontSize(1); return p; };
  const half = h => {
    const t = body.appendTable([['']]);
    t.setBorderWidth(0);
    t.getRow(0).setMinimumHeight(h); // kira-kira setengah A4 = ukuran A5
    const c = t.getCell(0, 0);
    c.setWidth(551).setPaddingTop(0).setPaddingBottom(0).setPaddingLeft(0).setPaddingRight(0);
    tiny(c.getChild(0).asParagraph());
    invoiceCopy_(c, o);
  };
  tiny(body.getChild(0).asParagraph());
  half(372);
  const cut = body.appendParagraph('✂  - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -');
  cut.setSpacingBefore(0).setSpacingAfter(20).setLineSpacing(1).setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  cut.editAsText().setFontSize(6).setForegroundColor('#9ca3af');
  half(390);
  tiny(body.appendParagraph(''));

  doc.saveAndClose();
  const file = DriveApp.getFileById(doc.getId());
  const pdf = file.getAs('application/pdf').setName((o.fileName || o.no) + '.pdf');
  file.setTrashed(true);
  return pdf;
}

// Isi satu lembar invoice (ukuran A5 mendatar) di dalam sel tabel
function invoiceCopy_(body, o) {
  const GRAY = '#6b7280';
  const style = (el, size, bold, color) => { const tx = el.editAsText(); tx.setFontSize(size); tx.setBold(!!bold); tx.setForegroundColor(color || '#111827'); return el; };
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
  cellText(c2, o.title || 'INVOICE', o.title ? 11 : 13, true, o.poNote ? '#b45309' : null, RIGHT);
  addLine(c2, o.no, 9, true, null, RIGHT);
  addLine(c2, o.tglPanjang, 8, false, GRAY, RIGHT);  tight(body.appendParagraph('')).editAsText().setFontSize(3);
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
  addLine(br, 'Status: ' + ({ Baru: 'Menunggu konfirmasi', Diterima: 'Diterima toko', Diproses: 'Diproses', Sampai: 'Sudah diterima pelanggan', Selesai: 'Selesai' }[o.status] || o.status), 7, false, GRAY, RIGHT);
  addLine(br, 'Total  Rp ' + fmt_(total), 11, true, null, RIGHT).setSpacingBefore(3);
  // Cap miring LUNAS / BELUM LUNAS (gambar, karena Google Docs tidak bisa memiringkan tulisan)
  const sp = tight(br.appendParagraph('')).setAlignment(RIGHT).setSpacingBefore(5);
  const cap = sp.appendInlineImage(Utilities.newBlob(Utilities.base64Decode(o.lunas ? STAMP_LUNAS_B64 : STAMP_BELUM_B64), 'image/png', 'cap.png'));
  const cw = cap.getWidth(), chh = cap.getHeight(), capW = o.lunas ? 72 : 118;
  cap.setWidth(capW).setHeight(Math.round(capW * chh / cw));

  const foot = body.appendParagraph((o.poNote ? 'Barang pre-order: dikirim setelah barang datang.  ·  ' : '') + 'Barang yang sudah diterima dan ditandatangani dianggap lengkap.  ·  Terima kasih telah berbelanja di ASA');
  tight(foot).setSpacingBefore(4); style(foot, 6, false, '#9ca3af');
}

// ======================================================================
// NOMOR PESANAN
// ======================================================================

/**
 * Format: ASA-DDMMYY-XXX
 *   DDMMYY = tanggal, bulan, tahun pesanan
 *   XXX    = nomor urut dalam bulan itu (001, 002, ...), kembali ke 001 tiap awal bulan
 * Pesanan pre-order memakai awalan PO- dengan nomor urut sendiri (PO-DDMMYY-XXX).
 */
function nextOrderId_(date, prefix) {
  prefix = prefix || 'ASA';
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const monthKey = (prefix === 'ASA' ? 'orderCounter_' : 'orderCounter' + prefix + '_') + Utilities.formatDate(date, tz, 'yyyyMM');
  const props = PropertiesService.getScriptProperties();
  // Nomor yang sudah ada di tab Pesanan bulan ini (mis. diisi manual) ikut dihitung supaya tidak dobel
  const mmyy = Utilities.formatDate(date, tz, 'MMyy');
  const re = new RegExp('^' + prefix + '-\\d{2}' + mmyy + '-(\\d+)$', 'i');
  const inSheet = table_(orderSheet_()).rows.reduce((m, r) => { const x = String(r.get('No. Pesanan')).trim().match(re); return x ? Math.max(m, Number(x[1])) : m; }, 0);
  const next = Math.max(Number(props.getProperty(monthKey)) || 0, inSheet) + 1;
  props.setProperty(monthKey, String(next));
  return prefix + '-' + Utilities.formatDate(date, tz, 'ddMMyy') + '-' + String(next).padStart(3, '0');
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
const LOGO_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAtgAAAEkCAYAAAAVa0b6AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAEbsSURBVHhe7Z153H5Tuf8/pYQGMmWWmUIlFUVS6mgylQaNGjSgQVJKk0qhMoTKlOYMcchcIZIQJUNFZqFkTAPK7/f6HNdzznOus57nued77Xu/36/X54/0fdZe995r7732Wtf1uSQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABoM/NIerSkRSQtI2llSWtKWlfSxpI2k/Q6SW+X9D5JH5W0h6T9JB0m6XuSfijpx5J+JumXki6RdIWkqyRdJ+mPkv4s6Q5J90j6u6T7JP1b0v9rmNxn9/1vku6O3/Sn+I3XSrpS0uWSfi3pQklnSzpd0vGSviPpYEn7SvqMpF0lvUfSWyW9VtLLJD03zv2TJK0oaWlJC0taQNLD88UDAAAAgOHgSfL8kh4vaaWYoL1I0tYxedtJ0qdiUnyopKMknRwT4l9J+r2kmyTdKen+wqQSjUf/jAn8DZJ+J+liST+VdFJ82Hiy/iVJH4+Pn20lbSXpBZLWkfRESQtJmo/JOQAAAID0OEnLSlorVjU3l/TGmCx7BdmTq6Nj5diT5Osl/UXSvZIeKEzWULvkDyXvFtwm6ZpYTfdKuifmX5H06Vg9f32snD8ndi6Wih0NAAAAgEbgbf4lJK0qaT1JW0h6p6RPSDpI0n9KOkfSb2LV0ivKTQyjQM2UP8z8keZQF4e4nCXpB5L2j9Aghwl5Mu4dklUkLRar4wAAAABD4ZGSlouJs1eb3xETZ4dlOCTjzIjN9QQmT2wQaqJuiY9B76I4vtzhKrtFWNLURNwr4g5hAgAAAPg/LBpb6M+X9CpJH4xkNa/wefvdIRqsOCP0P3KYij8oneh6rqQjJX1B0nslvULSRpJWj9wBAAAAmDCcAGanBjtoeAL9lkgK/IakU2O73Kt1eQKBEOpPDkuxA4vdZ5x4a2eaj0S+wYbTEjUBAACgUhwzancFh3A4weuzkfRlNw27aPyrMAFACI1PXgX3CrhDrPzB6w/fd0l6iaS1JS2Yb3IAAAAYPF7tmgrlcFKWt6RPkHRZrELjsIHQZMh+5DeG7/ox4a7z5nDdWS2ceAAAAKBDHiVp8Ugo9AvVK9FOsvJKtGOh84sYNUMPxgeQZQ9oy0VpbD3owi5/lXRXFHiZLv+32+fQTH/nNt22j+FjTR13qh/uU+4nql/ejbI94RmSviXpk5JeEztYjvl+RH6oAAAAtAl7QTsZynHR9u51opSdCzw5IqFwNPIk1H7KXi10pUKf/wui6MlpYS/4/djCP0TSl2PnwNUK7SrhhNAdJG0XH0TbRBEc2xR6q/+FcY2fHc4TngQ9OWQ7uBWigI7HwhMkLTlNdqnwx5ZDBWaSdzVsjzj97yz/t+WjbR/D9ok+pndAnh59sT/086Jwz0ujz05ydXVLF3bxb3K4kX/jx+Jj74uSDoyiPt8MFxnvovwobBidFHuppD9EaJITAT3Jz+cdDV5TVoS+Bv4ot/3gGyStH2MLAABgovCExxMrl4z+XCQ8eevXlezySxJ1pqlKgJ7EeTLnSd0vJJ0SE+KvSvp8lOzeMSa/rgToyaR3B54qaY2YhHoy6kRQFyFh9a9/5pX0mChR748ET/BdHt33gD80NpX0yviwtOuGJ4J7xweMPzJdNMYfOQ598krtzfHRSSXO3nVrVMv0B6MtNu104o8tOwgBAABUjf2ivSrpREOv+Nk14Gz8oeeUV94cxuAiIBfFaqgnya7K59jTXSS9Oz5QvNK6QVSB9OTYW+I+7zCZOGTKE3VP0v1R5Bjkl0eVRu8c+ANqL0lfi1hlh024+qd3JLxyTnLv7LLLyU/iXvN99uLYTeFDEwAAxoJX6LzN7i11Z/97m9yrbQ45yC+xNsqrjX+S9LtYWT5R0ncl7SPpQ7F6uVmsaPqjxKvITtzy6idAP3hS7tAZ7xzZi9qTcoe/OOTFq+Wu3uiVcu92eKX8qvgIJizrIXm34Pdxjj4sactY7ebeBACAgWILPK+euYqbV3q8SmZ7rfxiaoPsbvBnSVdLOj+K0Tgm1xMXx+067tghGI75dfwwL2WonfnjA88hQ94dcaVGT8YdSuFQox+Gl7U/oJ1U2ka3Hn98OEfBu0uOw3ecvsN+8PEGAICO8OqXY0Vtg7enpJNaVojFbhNedT4rwjRcItrFMRzD7O3jp0XC1MPyiQOYcFwWfZnYuXKYip8RDgVz4qvDU+z04w9Pf4Tm+2pS5bCu4yJJ22E7TqTl2QAAAP/lKesVK78oHYvolelJTqZyYuBvIzbckwLHrzoJ0BOGp0haLsJfAKB77Ozi3AA7tTiR8P2S9pV0fEzAnZBrG8V8X06K/IHujwyHhO0s6QURPw8AABOMt4FdotjJPI4vdELdpCVB+QVnxwD/Nv9Gr8J7u9vxzs+QtHSUTweA0eMdMk/AbZ3n2GYn7zov4diwiHT4lR1y8n3dZDnZ9OdhdWnbR398OOwOAAAayorhPGHPYoc8TJIfr7P//dJyGIdXyKZWoR0X6RVotmkBmoVDUBzT7HwPT769AuzwE0++HQPupOH8HGiiXODIO2m2K3Xuhu0zbecIAAAV4heTV2hdWMH2eF4NavpW7J2SroikyoPCM3iTiHPEvxagPXjXybkPDuOyVaWL/xweoV5OPrTNZX5+NEku9uSk6QNiwu2PjAXySQAAgOHjVVpn/H88QiGa7Opxj6Rfx2q0Y8GdUOgKe0/MPxoAIGHParv2+OPbiZeuuGl3HycrN3ni7f67WqhX8p14brcXAAAYMK6y5xeIY/icte4QCW815odyzfLLztXUnFzouEt7QbtcNXZ2ADBoPCF1zsXGEevtcBNXcry8gU4nTjy3TeK34yPCz02K4QAA9ICrtzkZxpXabJVnO6j80K1VTlJyJr3jvl3Uwv7QfiGwIg0A48aVT1eW9HxJ74oqmOdJur5hSd8uhuOVelf0dGXXx+YfCgAADyXl2WP5A1Hx76bCA7VGeWXFpZm9srJbVHb0w57y3QDQJBzzbI/vN0r6pKSjw9KzKRUuHYvuuPTtI2QGAKC1+CG4dVQC9IO89m1LlxB22W+HeNjq74XhG23rLQCAScOheXZjss2nJ9328/aCwj8Kz8ea9FdJl0j6XCSF+jkNADCx2PvUVnKeUJ9T+YT6LxGr6BWRd0p6kaRl8w8CAGghK8XEdafYcXQBHS9A5OdoLbKj1I8l7R3Fb1wQCACg0dg6zwk2DqGo2cfVdnjfChcPfwQsmX8IAAAUcYifKza+MuoOHBVJifk5W4uc03NIJEyukX8MAECNPC5WCFxB0Ft0NcbvOb7b/rFeSbfn6ip4rgIADBTXJlhT0uskHRGFsVypMj+Pxy0XILMH94clrUf+DADUhOPb3iHpOxWuWrh0uPvk1WlnzNuy6vH5BwAAwNBZQtJLJL0/HEBst1pbqOBlkr4qaRtKugPAOLCFnisLnl5ZCXK7epwblQ/fJmk1ChQAAFSJC4a5OqXrG3w9SsLnZ/o45bhyh7s4DwdnEgAYCs4md3XBL0SxlPwgGpecjOgJ9RdjZcT+rgAA0EyeFLHcXwnHEjuC5Of+OOSFJIcW2k3FlSVdvh4AoCfmk7SFpAOibG1+4IxDUw+53SW9OiqVAQDAZOIcGXtze3HnwopCSrzavpekjYjbBoBOsKfzyyTtF5W98kNl1HKS5M8i5OMVYZXnjHUAAGgXnsjaIvDNkg6VdFHhnTEOeQHqU5HgDwDw3ywsadNIUryq8PAYpR6MPvjh6aqIq+fOAgAABE+V9IaIlbb9Xn6njFqXRvn5DSLGHABaxiMkbSnpy5JuLDwkRinHUbtYwfskrZ87CgAA0AFe4d4kLPdcdfLewvtmlPLKtqtJsrINMOHME1/V+0q6svAwGKVcctyx3bbNe0LuKAAAQJ8sE2XeXZH314X30Cjl4ztBct3cSQBoLg6z8Fe0S3/nm35UujVWqR07t1buIAAAwJB5pqTtJJ0k6bbCe2pUukDSLpKemDsIAPWzvKTtw6f6X4UbfBT6jaT9o1riY3MHAQAAxsQikt4Uq9vjyj2yI8qRkraN/gBApbigir2gXSHrjsLNPGzZr9QWejtJWjscSQAAAGrGC0Auk24nEK8uO9k+v9+GrZsjud/1JgCgEp4Vtnrj8Kp2guLRkt4a9kkAAABN5mmSdpR0mqS/F957w9b5kj4r6cm5YwAwfBaLSe2Pwys636DD1DWSjohtrSVzxwAAACYEVwd2uKVtAEcdt/3P2JHeOnaoAWCIeBvrEEm3FG7GYcoxai5d+yJJj8udAgAAmHCWkPRySd+XdEPhPTlMeWFrT0lr5k4BQO88XtJ7JZ1VuOmGKd/Qe0vaXNLDc6cAAABaiovIbBMLT6Ne8DohEjRZ1QbokWdEbPWfCjfYsORKWM6qZqUaAABgbuwA4jAOh5GM8n19XXhrr5Y7BAD/F09q3xL2evlmGpYcV+bs5ZdS2hUAAKBnnB/1KknHSLqr8L4dhu6XdGzsNrtKMwBMwxWndhuhH+d0/03HlQEAAMDgWCHcSE4pvIOHpQsl7UDtCQBpfUnfkHR74UYZhn4WNx8VpAAAAEbDqhHOYZ/t/F4ehm6UtK+kNXJHACYZJwxuERZ7+aYYhq6Isqzr5I4AAADASNlI0h4RQ53f14OWi+a4VsXGuRMAk4Qn1m+W9PPCTTBo3S3p6xGT9cjcEQAAABgrj44wTSdH/qvwHh+0TpS0Ve4EQJNxMRbHV4+i0uI5kt4jabncCQAAAKgSO4E4hOTiwnt90LpI0rtwCoMms0oYww+7+pM9OD8vaYPcAQAAAGgUdvT6WuxE5/f9IHW1pA9JWjR3AKBWnMzwRUn3Fgb0IGUrv3dGIRoAAACYHJaS9BFJ5xXe/4OUq1J6l33x3AGAWvCKtcuY/6MwgAelv0TxmXXzwQEAAGAi2VDStyX9rTAvGJRcJMfJl57YA1TBmpIOlvRAYcAOSrbXc2y1/bIBAACgfTxJ0ofDHSzPEwYlF8j5NPMNGCdesfZq8t8LA3QQcnUmF4N5saSH5YMDAABAK1lA0mslnVqYOwxKrs/hxEtCR2BkuEjLgVENMQ/IQcjbNLtLWj0fGAAAAGAaz5S0v6R7CvOJQchzEq9oL5gPDDAovF1iV5BhVV28TNJOfC0CAABAl6ws6TOSri/MLwYhF8bxHIWJNgyMeSPD1gmGecANQmeELc/8+cAAAAAAXWBnsTcN0VP7mvDRBugLV168vDDA+pWrNjkjmPKlAAAAMAw2k3RKYQ4yCNl8we0DdMWLJJ1ZGFD96p+SjoiYKQAAAIBhs0mUSs9zkkHoB5KelQ8IkPHE9+jCAOpXDi85KIrQAAAAAIya9WP3fBj1Olx9crl8QICFw2B90M4gf5b0CUlL5wMCAAAAjAHX79gndtXzvKUf3SzpA1gLwxTbSbqqMFD60S3hH7loPhgAAABABSwftsODrudxftTwgJbirZKfFAZGP7Jf5EeZWAMAAEBDWDFWtP9amNf0o+9F7RBoCfPFF5udPPJg6FX2xrb/5GL5YAAAAAANYDVJBxTmOP3ojijvDhPOqyT9rjAA+pGTFz0oAQAAAJrOBkMwfDhX0nPygaD5uMKRC7rkC96PbLe3dj4QAAAAwATw7CHY+9nFhGqQE4IzWm8tXORedbKk5+aDAAAAAEwgm8cKdJ4P9SpHEmydDwLNYQ1JxxcubK+y04hLmgMAAAC0jW0HvGB5qKSF8kGgbnaQdFfhYvaiqyW9V9IC+SAAAAAALWJxSZ+N5MU8X+pF10p6bT4I1IetZo4rXMBe9G9Je0URGgAAAAB4CJs7fL0wd+pVh0laJB8E6mB7SfcULlovOkHSevkAAAAAAPDfbCXpvMI8qhf9UdJm+QAwPuw9bV/rfKF60ZWSXpMPAAAAAABF5pH0bkl3FuZV3epBSR+T9PB8EBgta0m6rHCBetGeFIoBAAAA6IknR6hHnl/1otMkLZUPAKNhJ0kPFC5Kt7LHI37WAAAAAP2zkaSLC/OtbuVEyjfmxmF4LCrpmMKF6FZ3S3pXbhwAAAAA+sLFZD5ZmHv1oi9IemQ+AAwWJx46Tjqf/G51LKvWAAAAAEPlRZJ+UZiHdatzCBkZHm+TdF/hpHcjG6TvnBsGAAAAgKHwiMhz6zes98+4jAyWx0o6vHCiu9VZUd0RAAAAAEbL8yT9qjA/61aerEOf2NXj/MLJ7UZe9X5PbhgAAAAARort91wJMs/VutX3wx4QemD9KKGZT2o3OpVYawAAAICq8Gr2BYV5Wze6SNIquWGYHduy3Fs4md3oU7lRAAAAAKiCBSQdUpi/daPrwxYQOmDXwgnsRg6C3zg3CgAAAADV8RZJ9xfmc93oTblR+N/sXThp3eg4SSvmRgEAAACgWtaR9PPCvK4buVw7FPhG4WR1o4/nBgEAAACgETxsAKXWd8+Ntpn5JZ1SOEmd6hZJL8uNAgAAAEDjeEdhrteNDs4NtpGFJZ1RODmd6lK8rQEAAAAmCufS3VSY93Uqr4R7RbyVPK5Pi5bvSpovNwoAAAAAjWfpKJGe53+d6ujcYBtYXtJlhZPRqT6ZGwRoOfYC3UTS6yRtL2lnSbtM0wcl7RiZ1i+RtJakR+VGAGCguBLx0yKM0U4JLno2/b60dpL0LkmvCW/gJ+ZGAFrMvJKOKMwDO9Xp0UYrWFzSJYWT0KnemhsEaCl2zHl9uO+cJumGwv1Skq0svSpwgKTtJD0lNwxd88hYbVktsuGfK+nFkraW9AZJ28YEy7GFznT3hAoNX++MCaztX1fIF22IPDuu86GSfiHp9sJ9mPWgpKsl/TAStV4laYncMEBL+UThnulUJ7ZhQclhIZcXfnwn+qekl+cGAVrIkyV9SNJ5hfukF10paQ9JG+YDQZHlYgK1ZUyafS2+Gg/xc+MZ90dJfyucazQe3SppzXwhh8CLJO0Xyfe5D73oRzFRx34W4KFd2HyPdKqTc2OTxIKSflb40Z3oD6yyAejRkt4m6beFe2QQ8irbRyUtkw/cclaS9IIIr/GHyKmSbiycP1SnbpP0zHxRB4xDtL44gArEM+lCSVtJmicfGKBlOMTxzsI90omcuzeROA4m/9hO5NUgvt6h7ThvoV+v+E51tqR1cwdahsMJHA/r1emzJD1QOE+oGXp7vrgDxh9fdrTKxx20HELyBUmL5g4AtAzvIN5VuEc60YG5sabjTM78IzuRX2xOEgFoM9527jW0qld51a9t+Q62Dd1A0mckXVE4J6h52j9f5AHiuPuPjCEUyKFhT82dAWgZK0u6qnB/dKIv5caayr6FH9eJvIr2mNwYQMuwK0gnCVLD0P2SPteCbWknXju/43hJfy2cB9RMOX55WO8Q5xO5mEU+5qh0TXx4A7QZRzf8rnB/dCLHczcaW4PlH9WJ/GB8eG4MoGXYeeLfhftj1LLbyCTej16B3LxPn1VUp+yo49j5YeDJ9Q8Kxxy1HIe6ae4cQMt4QuTp5fujE22WG2sK9v3MP6YTtcqzEGAGHDdaU9yv478nyeZovfiQ9yp9/q2o2fIuxKvzBR8Qj49xk485Ljmp0naQAG3Gk+xe8iD+IWnt3FjtrCrpjsKPmUteSZo/NwbQMrYYohtBP3JySNNLzy4g6eOSbi78PjQZ+ny+6APC4SZHFY43btkS8jm5swAtw0YA1xbuj7lkm9phhZINHCcl/r7wI+bST1sQ6wkwF7YTs2dvvj9qkc3+m8rqfbgZoWbopCHutBxWOF4tsnUnFSCh7bjYV6cF16brlNxQrfTyAvt1xLUBtBlXbTuzcH/UJBd8cuJl0/A2ulcq8u9Bk6PLJC2bL/yA2LlwvNpkj9/GrMQBDAl70ntXJ98fc6l6+z6XAc6dnks3DfGhCNAkbCmW748a5W04h4E1BeeD/KnwO9DkyCGJw0pYcvjF3YVj1qj3584DtJBnSLqvcH/MpU1yQ7XgjuXOziU/FL1tC9B2XlO4P2qWV9qHtRU/SF7aoMkR6l0uCDQMlpJ0SeF4tcpjfeP8IwBaiHct8/0xl5z0uFpuaNzY7qqXJflqvxYARsiT+/DyHKd2zz+kMjaUdEuh32iy5MRDJ68OGr/Xvlk4Xu36eXi7A7Sd7Qv3x1zy4lFV9GK433iTb4AB8Z3C/dEE/b1iizCHnTm3I/cZTZZ+JWm5fPEHxJsLx2uK9sg/BqCl7Fe4P+bSB3Ij46IXv+s9cyMALWUHSQ8W7pGmyCXF7UFaG4cW+oomS96d8C7FMHhKw3c/XL59q/yjAFrKyYV7ZC4Nq1BVxywi6fpCx2bT+RNaFQ6gW9aZkOQ7T2ZruqffEKvruZ9osuTt32Fgq1nb/eXjNU0uvDGs1X2AJrFYD7UPHGr1iNzQKDmi0KnZdCOxYQD/hQsqnVa4R5oqV56sgQUblpSGepNjo4f18vtM4XhNld/RAPDQgla31ZHfkxsZFf9R6Mxc2jQ3AtBSPlm4P5osrw64SM64+VjDQ27Q3Do3POOHwUvC6z0fs6nyhGLb/CMBWopDMvM9MpscarVGbmTYOLvasZe5M7Npr9wIQEtpkq9uNzp1SG4OnbKwpN8U+oUmRw6pWjdf+AGxjKQLC8dsuv4wjkkCQKUcW7hHZtOJuYFh42Xz3InZ9IvcAEBLcd7CJE8CvTI/LraTdH+hT2hy9Np80QfEwyQdXjjepMgfv8MKqQFoEr4Pui2n/tzcyLBYXtLthQ7MJK/UNanqG8Aw2adwj0ySvL2+Zf7RI2AeSacU+oMmR1/OF32AdLt13ERVYz0GMGZeWLg/ZpPrVDj5eegcUjj4bBpWhS2AprF5S9wtLg4f6lHij/jrCn1Bk6GzwwlgGNiSzwn4+ZiTptskPT3/eICW8t3CPTKb3psbGDQrFw46m2wTBADS0i15iU/JLg+jZGdJ9xX6gZovVwleJV/wAeFVqUly85lL50l6XD4JAC3k8ZLuKNwjM8kfqEO9d75ROOhsstMIQNtxzFe3984k6B35RAwJe3AfXzg+ar7+IWmLfMEHiCse5mNOujAcAHiI9xXuj9m0S25gUKwu6d+FA86ko3IDAC3FhU/y/dEGeeVx/XwyhoBXIa8qHB81X5/LF3uAbCbpr4VjTrr80TKypC2AynFIY75HZpJdjFzDYuAcVjjYTHKcqS2PANrO2j1UkJoknTGC5BDH0Haz1YeaoR9KenS+2APCIVuXFY7ZFjl8c6l8UgBayHqF+2M2edV7oNha7J7CgWYSW1AAD33p4mwhfTqfmAHzypYkj7ZJV0taKV/oATLJlnyd6uCwJwRoO928p3+b/7hf7ASSDzKTbMs3rGxvgCbhrON8f7RRTj4cVhytJwgf7DJ8bRSyo8kxkvaW9P7w6H6jpFeHlzMqa5uoPDhMt4tu6zhMsl6VTw5AC3EZ9XxvzCZXfB0I83Vpf/WZ3ABAC3GMI2EL/yNvSQ/DCcK7BAcWjjcO2QP8K/HwdWjQ4lH1FurBVSAdR5mvXVvld/swdwoAmsLRhftjJtl5aCB0Y8jtbVpWr6HtOKTqnML90XZ9O5+oAeD47iMLxxq1borVaSbU9eLFoh8Vrl3b9b1hJW4BNIhuYrG9Y/rE3EAvdGMvtm/+Y4AW8oXCvYEe0rvyyeqThSIZLh9nlHJ+Cpak9WNHknzt0ENyGBNA2+kmFnu3/Mfd4kzrTpMbH4hCNABt5qWS/la4P9BD8vb8IK37vFtwZuE4o9T3c6egOrYMe7p87dBDulXS0/JJA2gZLyjcGzPpSkmPyg10w1sLjc4kJ/QAtJnlJf2qcG+g/y1b9y2QT16POM75/MIxRiX7KPs5CfWyRLwM87VD/1unD7tSHUAD6Ma+02ElPdNNbKNjtQHayjxdhlO1XXbXGASLjjne3UliG+VOQTX4vvxW4bqhsj6VTyBAy3C4VL4vZtIn8h93ig3+byk0WNK1kUAC0FbeFHZ0+d5AZd0f4TT9snCsvOX2R6U/hDMF1Ilj/vM1QzPLzkfkE0CbWbaLugpe3OmJ5xUam0n75D8GaBFrRGGMfF+g2eXJ6Qr5ZHbJgpJOKLQ9Knlx4dm5U1AFz5B0Z+Gaodl1YewMAbSVThPn/9Wrm8hnC43NpGfmPwZoCY4lPr5wT9Qi+093E+o1ajlB0Nv4veKdtnFW5btd0mtyp2DsOJb47ML1qkF+KTts5frC/1eLDujzvgRoMi54le+JmdRTDs5PCg2VNPCykQANopsqp6OWvTo3j4+AWicbD0p6Rz6pXeBJgOPgcrujkvuPPWl9jHNMzCV/VD5C0o6F/68WuWiSJxkAbcT1XDp1A/ta/uO5cFxjp1XoeLlAW3E555qrwh0yra/eLu/UcnPU8oOsnzhmlyD3hCC3OyrdGA4yUAdbxYdPvk416AZJy0zr6zjzB+bS5ZJWnNZXgDbhao35nijp4vyHc+Ekh9zITBpYTXaABuHY37MK90MtchzlcqnPNa+YOVnkCam/nWKrpLsKbY5SrhDYUyweDJRVKrbksw/3K1N/nyrpmsK/rUX9hnABNJX3FO6Hkmxu0NWH6E6FRkryS82r3QBtY8/C/VCLHBryitzhcPr5z8K/r0XO++gFJ2TVEM96Uayeunz7w3InYej4nH+9cF1q0f4zjItubMHGoXfmDgO0ABdeyvfCTOpqofnQQgMleQUPoG3YXs4FRvL9UItcqn0mXG215hWzl+UOd8DDu9jOG7Zc0daFCvwMfYukDSWtKmnJKIrjBQlPwJ2E1xY9JpJR55c0b8Qflyaa/VKzJd8vJS2UOzyN7xT+phY5rAUjA2gbzl1y+F++H0r6cP7jmfADsdPCDQflPwaYcB4v6ZLCvVCLftzBrpInsfahzn9bg2zd5wlpt/gBV9tvulvSzWHheEXEtP4mYvZc8bMtukDSLyT9TNJJkr4t6UBJu0t6d4zHteMDpNd6Cs+V9OfCNahBt3UwQbVdpcdI/ttadEp8HAG0iU5zJL4Zc+c5WU3SrYUGSvLWFkCb+GrhPqhFTmJ8fu7wDDg5Of99LbKF2aNyh+fgSV2sNqA65FCme6OgmT+s/OFq9yov3OwQsfWdjAOvDJ9ZaL8W7Zw7PAMuVlXbR+J0fSx3GGDCsVFAvg9Kcs6T585z4liS/Mcz6eX5jwEmGL8APSnI90EtsmVgp3hS8vNCG7XICSbd4ESsUwvtoGbKCYGOq/fKt8MnbOU4PZFoeojJ5wp/X4uOipCYTrH/dG6jFnlHptMPeIBJYJfCfVCSd886isN2QkP+45m0Tv5jgAnFjhxXFe6BWnRyxLp2w3O6sOMctfzAmmtbPfO2ylcAUe/y7oxj2w8Ll6uple0tYhU8//sa5NCgrtwFJC0VybK5rVrkvCs7KAG0gdcW7oGSXFq9o2TgTxb+uCQ7iEz38wSYVLxadkzhHqhFjvO1J3cvbF9orxa5OE431n1+8dccH4/6l23jphZ2/AF2XeHf1CB7u5ecfDrBK2E1J1HbDQWgDWxSGP8zycWt5uTgwh+WdG1kWQJMOo4HzeO/Jm2XO9wlRxfarEWzOaKUsJOEnTxyO6j58rvJDizG756a4667HbeZzxfarEUOk/POAcCk4+TrTouYdVTR8QeFPyzJ23UAk469ML1CnMd/LfLkuJNEsNlwckatxTkc9+ly753ic/HTQjuo2XII1PRCPh8s/JtaZLeUbnZeSvjva/6AsCPO0rnTABOGozRuL4z/ko7Lf1zCdjz5D0uyryfAJGPf3jMKY78WOSY8V2vsFU9iO/1SH7X8O12hr1M26uKhiOqXrQ1d8XCKF1ZQuXMm2ZLvGdP62g/rVj6OD88dBpgwbHlrl6M89kuyA9KcdPrVfF7+Q4AJw7ZUedzXogcjAWOQ7FE4Ti06ssuQtJrLwqPOZcvYLaddV39QevU0/7sa5ATbbt1v5qLmlXrLicUAk4oLZN1UGPclnZv/uMT5hT8syduwAJPKxmEVlsd9LbIfdzf2X53gJMFawyv+JWmn3OE5qNmzHM0tX/Pd0jX9buHf1aJe/NvnwsUrXJwnH6sW2e2nl8JQAE3A9q+dJlLbC3tOmGBD21ki/HfzmK9Flw7RKsvWfbXGnHv7/Vm5w7Pg1YeaS1Cj2WVPaF/DKbqxkB21fidp5Wl9HSSrhyd4PmYtOr7L3SWApvDwQU+wCRGBtmMbqjzea5E9f+0DPExc1MMhKPnYNcjPHZer7xSX3/bKYm4H1a3TJC057To+u+JS6Lbkc7n3YfL6wnFr0gdyhwEmgIGHiJDkCG1mq8JYr0l75Q4PiW8Wjl2LuvXh9bb9gYV2UJ36vaT1p10/O2p41yb/u1r0mWl9HRbeqrYHeD52LbJvtz+CACaJgSc5YtMHbWUNSVcUxnotchW1KR/gYeMKdL8u9KEGuWrWNrnDHfDuLh6WaDz6k6RXT7tmj6w87toLUotN6+8wqTnB0/IK3iK50wANZuA2fZ0WmrmGuCuYIBxr9fXCOK9Fvsl7rdbYK3ZvqNW6z4Wueqkk6xhz54+4WEZuE41XduHYOSqnTvH2isOVbBU4KEu+Ttkskj9zX2rRp3KHARrMwAvNUCod2ogrAOYxXpM+kjs8Ij5e6EstcnKVVzi7xf7mjjO/odAmGp8OTdfTYSKdrh6NQ2+d1tdRUnOOiCf/VHmESWHgpdK7mWisk/8YoIE8s2LnDOuEIdh/dYqTPFxFL/epFnnFs1dcGfCjEfPLivZ45YJO0104lq08HMIfA971GgdO8v1VoU+1yIWBVsidBmggrymM75IctmiXozl5SeGPZ9LL8x8DNAxPXI8tjO1a5FVWx4aPE1vjOTY2960GDaJy3kqS3hLWjA8UjoGGK1vcPXfa9XDo4bcL/64Wub8eM+PkBRVXs7S+nDsM0EB2KYztkuxw5LnznKwW1bNyAyW9P/8xQMPwtk4e17XIManb5g6PCU9Ac/9qkZMxB+ELbrcKx2jvKuniwnHQ4OUX0yvSdfB7Jf+7WuSdjuen/o4LF+HJ/atJb8odBmgYhxTGdUn2wPbceU5cOeqcQgMlHZT/GKBBOL7q7sK4rkV2TxjXNnTGNmE1V0bcL/o4KByu4ImUnUccDmDXJH/w5OOi3nWfpA+n826P95rjrmtK4nP4Vq2VVy0bITwtdxqgQZxeGNcl2dbWc+eOOKzQQEm2DQNoIo5j/FlhTNci2wXaKq8mXOHSE83c1xrk5Kqtc4cHhFfHnU3uLUAX/PCk0Bnjjk2/SNLVlW/X16rDJS007Tx7BcjhF/nf1aIfpcqSNeA8qFrDt6xjkisMQFNwqNqNhTFdUl4omBVXZcoNlOSXio24AZrGlwrjuRa5aIPtuGpk0y5si0YtT3SHVa4649j9pSU9KewTN5L0UkmvDB9n+3S/MbbJbTXnBBg7l0yytovf+d4IvfKOh1eASrtE/u9OMp3C4TknFf5dLXIoy1Om9bcmdqw8d+A9ucMADcC7L3ksz6SO4q+n8DZdbmAmddUwQAU45tPljfNYrkW1Jwh9rNDnWuSE1XE5rsD/xqu9/uB5saQPTStcZNeWnJi6R+Fa1qRaciFKzCfp6EKfa5FX2J3bANAk/GGYx3JJDnXrarfZ1ZjuLDRU0r75jwEqxquOVxXGcS2yk4VX82pmXkmnFfpei0i+rhOH2Xyn4B/tsJt7CtexFrkAVe2sKun6Qt9rkW0YO45RBaiAUwvjuCQnxHeN66rnhkr6bf5DgIqpuVqj3XscatAEbB14U+E31CAnyT0vdxiqwLsLXnGdwonGfyxcw1rkGPulpvW3Zl4b4WX5N9Qi71IANIHFutjl7qiCY+azhYZmUt7uA6gRx8TW7ATRT9GUceCY2/wbapGdkJzICvWypqSzC9euFjnXwHH1TeKAwu+oRc7Z2jh3GKBCnEOTx+9MyjtyHeEbITc0k/bJfwxQGV5x7dTffRxygpezlptGzdZ9LikNdeJCKQ6HytesJnVU+rgylpF0QeG31CJXoGzKjgC0lx8Wxm5Jdq+anqzdMY+RdEuhwZLsd0liEdTKIyWdUhi3tei6ih0K5sKrxLUWZXFRkNflDkMV1LzSap0o6RG50w3BHy+d5lCNQz1tqQOMiGWj9HketyXZ6rdnjio0OJMcSwdQIzsUxmtNekPucMN4UcVJavYT76jCFoyUmnMhbgh/6SZTs9OPJy9b5Q4DVML7CmN2JvW1y+XYktzgTLJNEEBtbFDx5M86cEIKMXy88Ntq0QnhfAJ14OqkxxWuUy2ahBLfjw3LyvzbapELeHRlbQYwIropprZ+/uNucDxXp1nJTh5bKTcAMEZcJe7cwlitRV5d9T02CThE7PjCb6xFu+QOw9jwB+WRhWtUgw7OnW0w61Ze5dFjwOF7ALXw/MI4nUm2++07NNo11nPDMwlPbKiJ3QtjtBbZocAFnSYJFxVxPHn+rTXotohNhTrwRDZfo3Hr/AZ40HeLC+Tk31mLnCPhyp8AtXByYZzOpN3yH/eC4ytzwzPJvoH2DwQYNy7p7QzfPEZr0a65wxOCX+i1llI/j+dTNRxUuD7j1B3xrptEvlL4vbXInvVr5Q4DjIH1CuNzJvnjsCf3kIyLAnSzKvXp3ADAiPHAv6QwNmvRTyUtmDs9QdRs3eeYdxg9Dguxppw5aptgfyT1d5Jw6Oalhd9ci35MlUeoAOcR5rE5k07Pf9wPHy4cYCbdzSoRjJkat5+nZEtLh1JMMotU7nH85txhGDk12fQ5Cbaplnyd4tU5F3rJv70WfTR3GGCE2DUoj8nZNNACVH5hduPEsGduAGBEuFywt2/ymKxB3oaeXsnMK3rzhMOFi8x4Fce+0rXI970TRXvhuZL+XDgHNcj+/p5kO9526rc62dQfPl7tWyH+96Lx+/N5Qf9XPk8LS1pC0qqSnhb/2zs1/v88xu0e4omsx/3hhesyDv0uKkr2gn+375F8LsYpu4f4WeLkQZ/v6Q5F9oS/r3AOapAX5qjyCOOim9jr3+Y/HgTdPBAdi710bgBgyKwu6drCeKxBD0q6UNKO4Z35vShm4Rv7R5J+EqEjNq6vRY5Z/nkfxVqcBJLPQy1yIQ6vsrtUt+Vr8+uoNOfCOf7f/v0uuZ7PC/q/8nmyY48TBR2e5ZeQ/7fPrf9/b6m6WqnHu1eMbypck3GoV0u+nWL8eIzkczFO+RniZ8lpca5dke5bEQKzczgf5HNQiy6KjzKAUdJN7LX1/tzAIPDkpZuVwe/nBgCGiCuPdlMYadTyBPsvXVSIqkn+aOlllc8WRjVfE9Ru7ZcHbId4pdUrrrm92mXLXe+i5f9ek74Yu3oAo+KXhXE4k2x76R2iodCNZZ/1wtwAwJB4b2H8ocHJhUF6iVNdRdLvC+0hNE55tdfhHd3iMK4LCu2hwcgORFvmkw4wJN5TGIOz6UO5gUHil2U+4GzylivAsHG8p+Nq8/hDg1WvD5ea4+JR++RVXBeU6AXXesjtocHqcknL5RMPMGD8sez6CHn8zST/26G73RxaOPBsctwXwLBYXNIZhXGHBq9/9FGshYkJqkUfzIOzQ5wYm9tCw5FzVGwRDDAsuo3I8C750Fk+zOHzwWeSY9WcVQ4wDGqu1jiJ8va4nSK6xR9C3pbP7SE0SjkBsxcbWecgdVMPAvUvF60CGAYOX87jbTbZbcgOPSOh23hXZ1sDDJpNuvzYQ4ORK8P1wjPCvSO3h9Co5HClbrHdnd04cltouLpa0tr5YgD0iXOJbiiMt9m0UW5kmNhj84pCJ2bTXrkRgD5YMizV8jhDo9Eb8gXpEFsc5bYQGoX+EM+NbnHuQW4LjUa2dhx63Cu0imML42w2eQyOnE0LHZlL/5EbAeiR/QvjC41OTip9Ur4oHfBoST8otIfQsPXJWI3uBm8lu65DbguNTrvmiwLQI9sXxtdssq1uL++5gfCNQodmk5fle4l/A5jONrz0qpC/7HvxBLVDgLd/c3sIDUsOJVsjD8Q5cKVPx2znttBoZfcGV4YF6Ae7jT1QGF+zaSSJjTPhUsLdxrI4HrvbVQSAKZxki69yPXK1xl54acVlm9Hkae8ufdz9jjqo0A4aj86M+QZAL3hh94+FcTWbPFd1OPRYeXmhY3Pps7kRgA45pjCe0PjkwhC9ri4R5oNGIYczdRt77V2y3A4ar2z1CdALxxfG01xy3Zcq6NYb23pHbgRgDnYsjCM0ftnCaNl8sTpgIaz70JD1YA/vGrvdULiqPtmHf4t8sQDmwAYbeSzNpV698oeCl9FvLnRyLvVatALax1N7CEdCo9PXutyCn+Lpkv5SaA+hQeioLrd5nYTr3ILcDqpDF0laOl80gBl4V2EMzaWzciM1YE/i3NG55MSTlXNDAIl5YtDn8YPq0pvyheuQHQptIdSvfiNpmTzY5sCOFbkdVJeOyBcNoEAvc1KHPK6WG6qFXr4WrukhPg7ahe218rhB9emOyNTuhaML7SHUq67vwV7L+UQk3tYvh/28M188gGn4PdSL05htOavmR4VOz6VfjrIMJTSKDSTdXRgzqE6dLGmRfBE7YCVJvy20h1C3uraHymsrRvhBbgvVKZet9zMDILNCj+Gkdg2qHlddurLQ+bnkEACHAgBM4SS48wtjBdWtT+QL2SEvDmP/3B5Cncr+6uvlgdUBhxfaQnXLFfl6yfuAyWWp2L3KY2UunZobqpnVJd1Z+BFz6aeS5suNQWv5SmGMoPp1b/hc98KehfYQ6kTnSVozD6gOeKukfxfaQ/WLKo8whQuYOeQ4j5G55AXhxkVQ9OKPbZ3WZdY3TCZezXSsXR4fqBm6XNIT80XtgIUlnV1oD6HZdEhsDXfLMyXdVGgPNUN2IFonX1RoHYv3WHXV1o9PyY01hV0KP6gTeZJNtcf24i/RKwrjAjVL35D0qHxxO2DdHqpuoXbKVV29At0LC0r6SaFN1CzZS5+d7/ayhKQ/FMZFJ2q8r3qv1dp80zieG9qFdy++WRgPqHm6Pyz4euHt8fe5TYQsJz7vF/74veKKwrld1Ex9Ol9caAW2eXahszweOtF7cmNN5QeFH9eJvFXcuNgY6Iu3FMYBaq68Et2Ldd/DJH2v0B5qt+6S9HVJm+cB0yWbSvproX3UTNm/2NcU2oNLmfcSc23tkxtrOr3Y91mX9RhbB81jrR4rgqK65d2oxfLF7gDbcF1aaA+1TxdL+mofybPT8aqXQ0vyMVCz5cJCjsWFycdOQb0YaViNsOPrFse7+UWbf2wncnxNYwPRoSMW6GOnA9WvvfIF7xAnS7PS2D45+egCSUfG9n8v7iAz8f3C8dBk6Mv5YsPE8ZI+JtffzY1NEp5k95q85i2gl+UGYWL4UOGao8mRY2Z73dankufkyy9MuwC4UJE9qR27v3weCANgO9yJJl6vyhcdJoYdC9e7U52SG5tEnhBbOfnHdyrH6MLk4OJC+NC2Q7bUem4eAB3gZGdPvHJ7qDl6IHYibo0dSVdNPFPSSZIOlLRNuAfNhWPzrW7x32zNc6YVul3SZnkAQONxAbN8rTuVJ9etcZrxykSvK9mWV7RgMnBsrl+yvq5OYEKTqaly90fkAdAhr4h2XMQmt43qklejPcm5LaqqXSjpxFiZ9rP7jZKeHgns3dqx9jrBfrSk02MMeizmPqPJkK+tdygO7nGcQH3MG++NPA/sVD/u0S620ThcxA/efDI6lWNpWvNFMsG41K19LJ3IuiyaaDlp0TtYveBxskx8nOd2UT3yNVo6ShYvGdd7EUkLxYTaz2zvWo0aT+TdnxULfUaTI++CuMBVL0nVUB9+lvRTeOyY3GCb8IP3rMJJ6VQONVk1NwoAAAAAjcXhhDcW5n2dynae3e6QTRzzR+XGfHI6lX128b8EAAAAaD7b9pkvcUhusO18q3CSutFuuUEAAAAAaAyeHOf5XTeiqucMfLFwsrqRfZQpSgMAAADQHFzxt9daKVOyvSfMwkcKJ60b/VnSxrlRAAAAAKgOh4TcV5jPdaM350ahjE/23wsnsBvZMxEAAAAA6sM5eLZUzPO3buREyOflhmF2NpB0XeFkdiMXp1grNwwAAAAAY8MuIecX5m3d6GJJq+WGoTMWl3RB4aR2I5dYd3lNAAAAABgfLgD0mcJcrVsdGfURoA9cJtl+hvnkdqszJK2eGwcAAACAobORpIsK87NutVduGPpjO0kPFE50N7pF0k65YQAAAAAYCq7e+nlJ9xfmZd3oNklb5MZhMDxb0h8KJ71b2c6P2GwAAACA4fFCSecV5mHd6twonQ5DZLGYIOeT363ukvTO3DgAAAAA9MWC4eaW51696EuSHpUPAMPjA32W0pzSDyWtmRsHAAAAgK6xC5wdPvJ8q1vdib/1+HiKpMsLF6UXfVTSfPkAAAAAADAnjjA4oDC/6kWnS1omHwBGi638vlK4OL3oEkmvygcAAAAAgCIPl/Q2SX8szKt6kUNL3CZUgr2u/1q4UL3oeEnPygcAAAAAgP9my0hAzPOoXnSzpM3zAaAOVpJ0XOGi9SLHd+8paeF8EAAAAIAW4wqKhxfmTr3qMEmL5INAfXg12y4h+QL2oqsl7ZAPAAAAANAyHinpc5LuKMyXetG1krbJB4G6WUPSCYWL2atcfegl+SAAAAAALcCOHlcW5ke9yivgC+WDQHOwnd+fChe2V50sacN8EAAAAIAJZLMBxllbv5O0dT4INJOVJZ1ZuMj96AhJa+cDAQAAAEwArp59YmH+04++E0VoYMJ4taTfFy54r3pQ0oGSVs0HAgAAAGggz5F0VGHO049cLt0FaGCCmT98swdRBXJKt0vanQxYAAAAaCirSNq/MMfpR67GuGs+EEw23vo4ozAY+tGtkj7CRBsAAAAawgqSviTpnsK8ph8dGW1DS3lHWPHlgdGPbJbuSkRMtAEAAKBGlpP0ZUn3FuYx/egCXNdgikUlfV7S/YWB0o/sXvIxSUvlAwIAAACMgSdL+qKkfxTmLf3oFkk7U+YcSrg8+jGFQdOvbotkSMc3AQAAAIya9SR9awgTa+tgScvnAwJk/kPSOYUB1K88qL8u6Rn5gAAAAABD4AUDLrw3XcfFxB2gK7aVdEVhQPWrf8VX5PPyAQEAAAAGwMujOF6egwxCLjyzeT4gQDc8KuKobcWXB9gg9ONIBpgvHxgAAACgC1x6/PWSflmYbwxC10jaPh8UoB+WlbR3eDrmATcIXSrp/ZIWywcGAAAAmIUVox7HdYX5xSB0vaQPxAQeYCh4EB80BMeRKTkL91NUhwQAAIA5WFfSfpLuLswnBiGbNHyWiTWMktXCP3IY2bjWfZK+J2nTfGAAAABoLQtIerWkUwpzh0HpjlgRXyIfHGBUrCXp0EhczAN0UDpb0g6Sls4HBwAAgFawuqRdJF1WmCcMSndJ+kwUoQGoAq9oHybpn4UBOyj9RdI+kp6eDw4AAAATyQbhPDboiovT9ecouMdCHlSLvzA9Cf5bYQAPUqdGmXfiogAAACaLJSXtGnZ4+f0/SN0o6eOSnpA7AFArXtHea4j2flO6WdLnJD0ndwAAAAAahW17vxqhGvl9P0jZbs8TeJzLoLEsFT7aVxYG+KDlWO0dw1IQAAAA6scLcp+QdFHhvT5o/UrSuyUtmDsB0FTmicqQ5xUG/KBlux7Hg7vK0iNzRwAAAGCsPFrSmyUdOWSThCmdJGmr3AmAScIT7S2jgmO+AYYhl3p31vE6uSMAAAAwUjaStEcUbsnv62HoGEnPz50AmHTWl/TNEcRpT+mcsPt7Yu4IAAAADIVVIgTkgsJ7eRhy4qKLzzwpdwSgbThmejdJfyjcKMOQi9h8P0JWMJEHAAAYLCvEgtYwi8FkXRjHfGzuDEDbeZykt0r6UeHGGZbsfXmwpBdHdSgAAADonkUlbS3paEl3Ft63w9ADko6L0FNyrgA64FlRit0T4HxDDUtXR3LkC/kCBgAAmJOFJb0idoVvKbxXhyXHcH8qam8AQA8sIul9kn5auMGGKU+295T08twhAACAFuPd3tdIOihqUeT35zB1YriPsOMMMECcFOkV5lsLN90w9XtJB0raRNJjcqcAAAAmnMUlvVTSdyVdV3hPDlPXStpb0pq5UwAwWHyjv13SGZL+XbgZhyknYnqS/yYSJAEAYIJZOYqyOPzjT4X34TBlM4JjJb2a1WqA8bCepP1jlTnfoMPWbZKOCjeSFXPHAAAAGsZTp7l//K3w3hu2bOVnn2xWqwEqwV+43r7yF++ospen656IE3+vpLUkzZs7CAAAUBlO6LepgH2qfzGGXWHLyZHeGd44dw4A6sKFZPwF7mqR43hYWJeE0f0WURIWAACgBuz88YaY1F5ZeH+NQvfHDrCteRfLHQSA+lkj3EBcMj3f4KOSs6y/LemNsboNAAAwSp4RuUs/HLH9bZaLwXyYsEqAyWEeSRvGqvK4vtindH4Ut9lc0lK5owAAAH2yvKTXS/pG7Kjm99Ao5ePbs9qTfACYYFztaStJB0i6qfAwGKXujipUH5T0PEkPz50FAACYg/kjD8kT2dMiBCO/b0YpGw98PuxtAaCFuJCNy6Tb29MWfPkhMWq5wI37YhtAh7cAAACUeJqkd0XYhysb5vfJqHVZ7M56t5iaEQDw38wXlRtt+3dD4eExaj0o6ZwocuNkyaVzhwEAoBU8QtIKkZx4iKSLCu+Mccgr1buzUg0AneLtti1jcjsOj+2S7g0rQG8Bbi1pydxpAACYGFaS9DpJe4U/9D8L74VxyJP7L0RYo0MuAQB6wjZ79uf8oqRfFR4245IzwX8WDzqHufhhDAAAzcRhga+IhZ2LI0cnP/fHob/HbqpXqp9OrhAADIt1Jb0vfLb94MkPo3HJqxt+CDp58y2SVo2wFwAAqAsv3KwdNRsOD/u6/Ewfp+6SdEyUSl89dx4AYNgsJ+mdkr4n6drCQ2qccplbJ01+U9I7YjtvofwDAABg6Dwhdhq9OOOJ6x8rCvmY0uUR3217v8XzDwAAGBePk/SCiJf7zRirSM4m2xKeHVuQtipcJcrMAwDAYFhQ0poRP32EpJ+PubjLTPIijGO7d5W0HvHUANAUbKrv7bVvVfpwnZKrXHqVezdJL5O0RP4hAABQ5GHh7uHY6U9H+W/vHObnbC3yTuvXJL0NK1gAmAQWCwtArxw7MfG+woOvFv0ltgodF+jQkhdJWjb/IACAFuJkchd0cajHVP0Exyvn52gtcqKk84X2jh1Wr64DAEwsTkB8VUy4f1f5hNvyC+QXETvoqpN+UDv+/FH5hwEATABOQvTKtHf1PiHp+HCRqimxvaS/Roiiqyi6735OAwC0Else2frIE9fvS7q58NCsUf4osJWUw0s+Gt7cjjt0QQQAgKbgugeuiugiLp5MO8zjt5L+VXju1airItZ7R0mr5R8HAAAPsWhYAX5E0smSris8UGvVP2LL9AxJ+0XJ9/VZRQGACvDH/4rhqOTwt69IOjeesfcXnme16kpJx8aE2lZ/TrAHAIAueYykF0p6r6T/bNAK93TdE9W/jo6CPW+Oibdj08lcB4BBYv9/V7rdKGxU95d0nKRLYxEgP59q1gOSrpH0nfgo2IBdQgCA4eAJ94bTtjKvLzyUm6AHIwHHYSZOFnKYiVe8/VJ07CPVwgBgNpwD4pCITcIVwy4e/oh3eIdjkfMzpyn6fbhP7RLhg1ipAgCMgcdLeqakN0r6eqzSeMU4P7SbJE+8nfz5U0mHSvpQuLB4O9QrU0y+AdrBvJKWiYnmK+ND/NvhxmQ7PHs55+dHk2TXJntRO1zFVn+OBWdCDQBQKStHkYM9orBM019C0+UXkssK29HEcd62y/Lk256uzvwHgGbhD2bbxz0lCmD5g/oASSdIuqRyG7xudaekUyV9LD4Yls4nAwAAmoNXfZ8bLy5vodpuqsZKk/3IHxG3SPqlpCOjoqZjFjeLoj9+kbHyDTAeHM7hZGfnXmwpaQdJ+0aynifRf6qwdHi/crz3eRHu4RwaJ69TghwAYMLxiq9Xfh3LfWbEcjuhJr8kJkV3RGzmWfGRsWe85O0V69ATF9NhBRygN+xk4Qn0OjGB9s7SPpGYfU5YyTn0K9+XkyJPpp2MeFLETjsx3UVpAACg5Tjz3iss20XVr1NiVSm/SCZVXgF32XhbDDrp0m4nu0bi5X9IeiqrT9BSvPPjHSDHQbuK4VsjFtohWk60dhia7TknbQV6NnlBwsVnPhv5L2uxQwYAAJ3iCaWTbpyh/7VpK935ZdMGefLgDw5PJKaqWjpO1H7lth18saRnSVolzhv2g1A7/qheQtLqkp4Tk+e3S/p4JN05Btr5Dl6Zde5Dk7yiByW7HXn13eXGHdLiYjRPjuRyAACAgfHYiGl2qffdJf1Q0rWS7i28nNooV7i8NcJRfh7nxx62XhH31vG2EZrjWFQnoz4htteZkEO/2HHDyYKeNK8ansmbxweyPwS94uxqsS5gdX4ULLmtQRULhy2HsHgy7RAy717Z1cMr044fBwAAGDl+sduP1rGXjuk+PGy0bi+8xND/yCuCtlT0CqGTM0+P8JSDYut55yiU8epYIX92lKN3rOtCkubJFwImBn9wLSzpiZEj4MmyV5i3kfTuSFj+fKw0O0zDK6z2lL8hPnYnOZ9iEHLBLu/IfVXSh+PcLs+HLgAANIGlIq7bloGeDNie6jdhVZVfeKgzOZnKHy43xmqbz6dXyp1cNTU5/1xMwLaP+NAtohiHQ1hsheaQAE/SvXrurW777lIdrn88OXOirCfGXkX2hM3JxA6z8o6FY/ltQ+eQIpe59qqyk20dfuWVZd8fDj/yNXUo0h/jXvGuSB4HqDM5rMuuSY6X/pSkrWNV2lVkAQAAJgpPPJ4XyVJeqfWW7GWxmuuYx/ySRIOVz7HPtScfjql35bhfx+TOLiue6Lm09PeieJEngA4vsPWhw4Kc4LZTTOAdfuBJ/GvD19e2iF5t94Te1pCeWDo5zpPMJ4XsruBqnStGERFP9D0hnZJtJReJcIfZ5EmS/+30v3VbdoRx2179dRjO1HHtcOG+eCfAFUPt9OC+OozCfffqsJNaHYdsh5kPSNotKgQ68ffLkg6WdERMiO2QcVoURHLIhSfGDrvwKrJDLwibGo0c4uKPTu8C+SPTHtO+jo4r93gAAABoLY5z9MvQEzLHKXsV1hM8r856tTa/VFEzZL91hys4HMar75YnnlPyRN+FRLJsq+jEutnk1d38d5bbdNsul213mKnjug/uCx9xzZSvm/M9/BHoao7+2PNHkXfJvBPDLgwAAEAX+OXpbV2virp4zJcknSjp8kgoJEkLocmQw2Fuit2AH8SHtj+4vePg0CbvXAAAAMCQsSWeV7CcYOlqaX4hu5KjV75d2XHSKlYi1HR5F8FhNA6t8Uq0Q3AcbuSiT/abdwIvAAAAVIiLPjiO177UXvl2vLeTnFy22HGzLs/s1e/88kcI9SdPoJ2g6ZhoWwI6jt+x7I6Ldly+Y+PxkQYAAJhQFg3bu+eHr/cHI5nv2Ciw4QRAx/myCo7QQ3Icu+Pfr5N0blgEfiFKoztRdCqUgwk0AAAAFLHtmh1P1gunCXtS2+d7qkS0fXRdXt0TjjwRQaiJ8q7OpeGrbUeOfWL12TtALpDkcCzbb+LBDgAAAEPDvse2inPlPDugOBbcE3GHo9iT2lZu58SkxXGnrIijUcrhGraw84qzw6Ic9+zkQVsOeuJsS0JPnF2d1eFUzmlwCXUAAACARmAHBK+Iu9iLt9JdAMZxqfZbdnLmIZKOkfST8KX2hNyTI1vN4ZSCPFm29aB3TGxXd5GkH0VSrysS2lPeib72Jfek2dUf7b5jr/HH5sEIAAAA0Dbs6esKi64K6JXFZ0YlQJdN96qjy6jbB3h/SYdFsR4XiHFcrCfnLnjiRLO7KZtdlRzD7F0Me7u7wI+rDHqHw8mAnij7I2tfSZ+U9P4IzXBss4viODzDBXoc3zw/YRoAAAAAo8OT88dEEqerGnqC7pVMT9JfEPHkr5e0XVRkdKiAS9l7sn54VCm0z7jjcD1h90qpfYl/GyW8vbJuC8SpYi9eVZ0q5NLEIi4O2bH/8t+jSI1/kysx3hyhFf7NjrV3iIWdMX4WK8cnRJzyoRGXv0dUuXTCnytcvi5Wkl211CEYTqh1ZUmvKPvDyeFFTJIBAAAAWs68EW7gyfvSYbnmCfyTI/TFq6yORd8wJvObhr+xS6i/YlpJck/wPQF1ERGvyHtCOiWv2rqgkMuVzyZ/IPjfTv9bt+WwG7f9hmkl3H1s98PyToCdY9xHJ7C6fPraUU7dE2D/Jify+Tf6Q8XJrgAAAAAAAAAAAAAAAAAAAAAAAADwEP8f8HJI+z46khEAAAAASUVORK5CYII=';

// Cap miring untuk invoice (PNG, base64)
const STAMP_LUNAS_B64 = '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';
const STAMP_BELUM_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAdEAAACYCAYAAAC749OLAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAABvFSURBVHhe7Z0trCVHkoUHLlgwcBd5QFe9J6OVTBY2bLQybLCgoSUTQ2uQmYHBQBNLA82mYcMGAxo2Wcm7fj3qZQMNB+4q8mbeznsqMzIyK6tu/ZxPOqRfVtWtn66oiIyI/N3vCCGEEEIIIYQQQgghhBBCCCFkWT5+/vm/PD08PI/18bPP/gnHEUIIIackGMpfnz376mkYvvswDG8+jOO7D+P4fzk9DcPfPwzD6w/D8BL3RwghhByKjw8Pf3CGchy/cYZyHN9+GMf3aBxb5A3q9x8/++z3eFxCCCFkF/z3OD56Q/mtGDVnKIfhFzR6S+lpHH8TbxZ/FyGEELIJ/mcY/s3NTQ7Dd38bhj95Q/kRDdqd9Y5eKSGEkLvw67Nn//40ji+coRzHH8VQupDp1FhtWe9pSAkhhCyC8ybH8UtvKP/sDOU4/pYwRnsWDSkhhJB6pAxEDKVkr4qhfBrHn72h/EfC2GxdkoTkVO0RD8NrvDaEEEKIGMrfe0P5ypeGvPbGZmpMNixv2GVu9bU/j1e+HjTpRcq/SwKRNWlJEp1wH4QQQk5ASw3lFhUMpXjE/jxe9mic4K6LIQwtCVG4LSGEkAOwZA3lmvLG7K3MsfoQ8pdyXni+vZHrV8oQlkxi3I4QQshOuHcNZS/5OUkxlD96Q/lCsnnxfNfGfYgo86XiCYtXj9sRQgjZCDupoSzr8pvfyjk4Q/nw8HwP4VA3P4znEknOBbchhBCyIgepoRRDKV6wGPnvxTsWAyTeMp7v3vDJVdPzvegtjieEENKZA9VQyryqGPnv3HzrQQylhuaNupDuzEQmQgg5PQeroXwnGbvOUEqmqmS8Pjz8Ac/5LLh7q9zHNRKdCCFk9xylhtJrWkPJJJks2n0WjxzHE0LIKcnUUGZfoFuVUkOZbDZAdHz28+Q6i1jqQgg5FZkayj02G7ipoezVbIBMEW8dr/9Vw/AGxxNCyK5J1lDusdnAtIZylWYD5BYtuUiyknE8IYRsnkwN5e6aDUxqKDfSbIB8QsL8k/vmJaFzHE8IIZsgVUO502YD1xpKZyh30myAfELL0D1z9jIh5M44bxJrKPfYbMDXUB6t2QC5oE0HyIcejieEkC4oNZR7bDYgCUg3zQbohZwDrXORZHPjeEIIMZOrodRCYBuWeJO3zQZYQ3l6tDIX+RuOJ4SQG45WQzlpNsAaSqLgFu1OPE9Ow/AaxxNCTsiBaihzzQZYQ0makHlPfM4ivcfxhJCDcpgayjst2EzOiVuoO/Ec+meRZS6EHImj1FAmmg2whpLcDW2On/PmhOyMA9VQ7nLBZnI+tA9RftwRskEOU0N50AWbybnwyXTT5/vyjL/C8YSQhTlYDeXpFmwm58JPjeBzfxHLXAhZBqyh5ILNhOwT+ThM/J9wkv/XOJ4QYiRRQ8kFmwmp5G+Pj+PTw8N/PI3j10/j+JeMvpZxuO0aFMpc3uF4QkjEpIbyMj9ypBpKNhsgq/Ph8fGLD+P4Az6nJYlBXduYyvQE/o7o9/yG4wk5HXENZdRsYPc1lGw2QLaG8zrH8S/47NZKPFfc95Lg8WPxQ5ScgriG8tpsQEld36oSNZRsNkB2gRg+fJ7naE2PVCsjY5kLOQw3NZSfmg1kH/7NCmso2WyA7ByXZIfP+UyJR4vHWYpCmctLHE/IZoEaStdsYO81lM5QstkAuSMyRynP4BLe3X99/vk/T57/hJ6G4a8hkQj/ltXj4xd4vCXw75rp8cUTHcdvcTwhdwNrKK/NBnZcQ8lmA+TeOEN2MZQuC1aSelLGSgwZbjuXX8fxP/E4eMz/fXz813gb+b3y7zg2oR/i7ZZCK3ORdxSOJ2RRDldDyQWbycapmY/snbSTMtax0IAGch7s0zD8+mEYflqz7EWiX/g7IrHMhfTngDWUXLCZ7JaachIxUrj9HHD/KDGWuE3AebHeYIonrY1dEplqwd8dXa+/43hCTBythnLSbICp6+QOiLHIeWetOO8t8eznJEYL99EK7nuiYfhpLY+yFZlmmvzuSCwjI1kOVEOZazbAh5+szs385MXTugl59jRiubBoSb28Ptyvpji56GkY/ui6GMnUz0oJRBpaAiOTAk/OYWoouWAz2QloNBPqljDjjNB0/0X1MuTykYD7bpVcNwnx9vbULWjTUfKuwfHkYBylhjLRbIA1lOQuyItcPCR5qTuPaRj+iGNylAxLzxpIn407OYZFPYxVTVJTjeR69/KWLbDM5QQ4b/IYNZRcsJlsDh9+lTBjtvRCDCpul8Ji2HCbVgxer6YuHvHM35CV3Iu1DKkYSjx+kLxvcTzZIIeqoeSCzWRnWDNcLSUiFu8Mt2kF94u/Ff8N1SPpp6Lus1pL1LamkPcuHvuqYXiD48mdiGooccHmPdZQcsFmcndyjQZwXAmL9xhUMqR+FZPJdjfqkEwjBnCy30guJF34OGi5Vim8If0j7r+Hes3famhlLhI9w/FkQUINZWg2sPMaSi7YTDaHz+xUQ4i4TYnaBB3Ng/PGa7LNjToY0VK3IBmzlkEPyLm7+1NZdqOpd21rCnFw8LixmOnfmWsN5admA7usofSa1lCy2QBZGXn5WhNdSgbUqdIwmIwNSDOkOBbVw7vSvMzYwyxdr17eKOIM6iWX4xohKP2WnLRr3Qstx4RRtgaiGspLs4Hj1VCy2QBZlUnGKyTyWA2LJWxYW/7UWm+ZM/ylOcKabN8cqrc3DD+FcZYPhFKIujcu/HuJ2KmZzNHvq7qfLWiOkFQK4HgS1VC6zKwD1VCy2QDZGqYXudEjssxfWg1yDO7DolwGacnjsp5rjpLRx/M3GPXFQ6Y5lrqftfgclcmxReJM4fjT4GoofbOBg9VQstkA2Q2ll75/xk2ZmBaD3FK+UTJ8OaUMackwzDVapTlcfDdYMnWtJTwacQjXRxqK52l6NlZ41/mI4+TYIrEdOP5Q+Jt2aTZwpBpKNhsgB2LyvCeE26QoZaWKWjw9a2gxJTxeKelHFI+vpWSkU3PCavjXCz8GSsi9CAYT9xVUChVbjOgac6KHLnMJNZRRs4FD1FA6Q8lmA+QOOEMkpSG+G0+POboS2os2yPoSx+1Swm1KFA1TWVfv1+ItzzEMpWuJ4wWLN1obNrV80Ii0+1q67hZvtgfisOCxrxqGX3D85jhiDSWbDZCtEMpCct7IGi8qk6eX8KBS5M4jFm5TwmJkDHKGdOkyl8m+IsX3Ej+WcGxKuWSpHJZ74cbA+YZyGByLqjXsrWhlLmKHcPxdOFwNJRdsJjsh8fxOhNv0puRxiEqhv0DJE3OqNFIW79GicA7476hW42D5nRbDpqhqPtlyX2OZ7l0YOwy/al5sb7To5mrv9wPWUHLBZrJ7LC+uOeFFC5Z5QqthMXkwlckolrk5kzftDakhI7YphG65jnO1hDfaoqWfSUQrY6x9nkxIDNmXh4ihzB58q+KCzeQsmF7+lZ5bLRYPKq5v1LB4P1aDHIP7QLmwaJ+w7yQZyYrpXs5U7W+zzo3WaG0DKqhlLs+efYXjmxBP02WP7mSuUmk2wBpKchosRqdHiYOGZZ7Q+vI2GeTKsKRQ8tiD96h1C7KqdR56Ka9vosqPKjdVh/tokNyDWk+4F75fwOQ3OQ3D9zi+Cglj+qzY6c7vLGw2wBpKcg8kHHiv//wlLN5Ti+dWCx4zJdwmhcXzsRrkmJKXF++zhyG9PXoZy4dIL7VcP1fyUghjK/qh1nD3RqKRid910TC8xvFmXMOCO9ddJpoNsIaSrE6ydV3kvaxhiFqweG4tL81aLC9YayIJbodq8fRKHjvus2R0S6oNWbZ6e+4ZHYafQjja8lHltjMmeiGuJDGzUIBcQ//v0k/363sbzpjC9X2P401I5mliZ8sImw2whpJsAGcoDS9/0RqGqAVL0oy1Y9AcUi/ViYwvVUtYE7cpYTEu8XjXA9b4bCRlPNdAKaHKG6jLvO3j4xfaB4nlXuBHw9GRiCteg+u1GMffcHyRRQwoF2wmGyDUz2kvGcESNoy1hiFqBX9rSrhNb0qensjq/ViMQK2nZ/HYcZ9zDGntPHTpnGsyfi3n2vIb946W71NVnaHGhsvigs3k7mChufcob7yX0gvC+qKJhfvYCqUXsGjpOV1LeYY1JF7yypwqPT3TnGNinxZPPyXruQZwe1Tt/nLGP4Rc5RqX/o8cDa3SxDyFqK7yPdV718JuHF+sVoxKSAZnNA1hvqBSuMoS3kMtbYhaMc3fJQxET0wfJR3LXFoMAO4DlTNUtVELvy9z+N907SrvXzR36eYm0cs+I74J0PTaiobhFY5PolniSO+YAUu2hulFA9KeY8uLeqLKF9laWM6lxejUYPH0rIalkAQS9pU0eBo57+y6TyVkWmtIa8L/Fi9+qx9we0Irc5HoKo6fIAWluCHKtCNCKnFeZFhGyYdfa7+Mm8JqiudjChmCljZErVi86hajUwseMyXcJoXlo0D7QMpRCnuXjLzFuMfC7XPkIgliiF3odYV7dwa0qUzTkmiltTYlGQi3IaQFl2pfeGG1eHWTfRiU+4Iv/r6Etvoys3jpJQPRg5Kn52S476Y6TcN+kJJxLk0BCJYPlqDcs4eEkhDnkT4+fmHdjtShGtFx/DOOv6H0BSU1mrgNITHiCVq9x9LLStRikEwvaeNxckY09+/hb7ifLWAKpVaEF1uxGL/SNbSGTXE7C5awKW6TwmxIGww9WQ4tGls0olpHIml2wJ6yRHAh00voVTzJr30Rd9xwQH0BBkofbf65y84/5dAMnCbcj4BjgrQPgDUMUSv4W1PCbXpjue9eP6RKkMzGSQnTa1g8duuHYvzBEIdd3fPDRJ5NIiFbvN/X+14K52rLwDCMSwL4bKSE26SwvKysBjmmYOCymbup+kQcc1Xht+N+toLFS18jTKjdB5Q3PDedoUxq9PAsHnvNvte4nqQf2vKcahN6KU/BDWKxfIUELC/ilAeRArdDWeafEEM4LhlORIOdCxnKuNzfgrb64jQZogoD0Yr2odNFjV5oYLK/SM6gJz64yP7ROhaJ1DpRadqOG1w1DL/geHJeer6IJ9slhNuUKHmJ2t/j8FpuXDC2+O83Mp7/2liMV4uBkOtW8+Hgu/yYvdEayX6tH3E53IdW1GtW7ufcfZLto5a3jOM/1NW/3LqgiQ2d5nSvJ4uSmp9cep7F+CI2lRZYDHLt+RTDcXpDhuvyWbm5t2g5rMnfgrZa5mLw0rNJVv45cyVIPlP05t7ltstR8uZbVfu8ECJItFVr+VdMKtKMKOtCt4PzjiCRB9XiSdQw50WM5EKrN2rw6ib7iH/bw8Nz7RyCx5H7WAjnpt4D4/mvTc67vvntlwSYpKEsqHr9zp6GVH4rvUXSgiTNlpoMFR2DWbUxZDVyL/abm73wC9zyIra+UJc6H23eVvanNWUIHyE5A1/6uxvTkBC1BkUvfYZaz1l+U6WxvpU0IWj40CJE8POgqgE1LYOmGVGGc/vhvryhKXpN+MlkwGYmVZSweA/WF6ql3GGBMhdn4HNGMCQzZffhX9jaB4D1/O8B/taewmPVEKIsuM9YcWN0eXboeZI5SM93rSrl+tyN4wvcdoJkHeGGkcpWmFxxL4PC6iE3N6gUJojoacDmgMdMCbdJYfkoaDkfi4FTr+Vl3jTpzYaPntIHAP6mrZA7rx7CY80h/D+qSVgipISrRLk4je/w+U3K6kRqqb0y2Yrjz04pyaJGteFK3D4l3KY32kdB7W/A7VBLlLmEcYpBSXqp8balD4CteklzntWSaqIqhCyJLL/p8x++9Vm3so612tZ2omH4WLWGqObWVu3oYPh5pFmGsiDT/GGgpwFrxXQtjPNUk+0Swm1KlAxcGJfLwNV0c5zE368ynv/aaF76HNVOTRAyF1m20zkzw/Cd7zQkhvIXfDabJAa0tj+CNrlaE3I8GqUX8lzVhit7GrBWLKubWJ8Zy/nUhvSKCTT++mgJRinhvcK/34xdOEu6lZKXrsndK9ZPkhWRqUY3dymGchx/bPIoa9ViQIUui5EelMn16Cw8nkZPA9aKxZuxhqm10OlVDR8Fk31k9me5nkFoRLUPAOv5r03po9Cfk1sxxM37Nlx7QmrwU2NfekMpPdzfSr92fDZX0tvmyKvWrUH+huO3QirjNf5i7hFimlyPGbrJMPSNqPF4Gj0NWCulF7GXKUxtOZ+W5gVa2Du+PkWvNd4OMoXVD4CFs6RbiUpKaCjJKkinH/ecDcNLMZRP4/izM5TKFOJdNNfOaUvAyEnj+DVxRnJGIo+MnxN2qj5etGJDWP+vhzEXehqwVtTM1nANjGHqUpar31f1R4F2z9AYamO136F9AFjPn5AjIA0LvKF8BYYy2wVoC3KGfBi+b/Y+Ywovs1XKXOYYSotq59YCqsfhJb+7df819DRgc8BjpoTbpDB9FDR4dVqYFq+PNcEI5zkL/2dM50/IXhBD4zJenz37SgylnwLMrnqyWQ3DRze/Ogwvuy7xWShz+Q3HLwEet7da13rUPI7rvhu8pVbw2CnhNr3RwqU1v8GS3INGz4J2z1JlM5bzwbBn6QNgTvSDkHvgesheSkO+8YbyjbmmcnuSJKTXch7O8D88PO/icWporvfiB68Iq80RehMWLJ4KhgiXxPLCx216Y7pXhrm2kiEStVzb0n5xvGZ0g1IheRxzI8P5E7I2cQ2lM5QXbzJbnbFVeXslIeOfvcF/5QxlT++yFq3GRl1LrROltl9d1BAaLL2QRZq3lFpt5WqEGn5PLwM2By1cGmTxzk0fKIb9IKWwNxpES4JRPD6AY2K1fLAR0oNQQwnNBrLv963KJx+9laxdbyhfekOZX5bsnty7zMXiDcTyyTsugcdqgFOhvBKmkKN4h4+PX0gikfwe97vyHXE+bacY3xymOdqly1wMxk+khTTlbxavuvWDYLKfwj5LzxCOF8IHTfwshmSyNebIyXlxNZTTZgPL1lAuIF/OIobyR5+U9OXS76/F8DdicpL+RBdfEs1SCC4vqtyLueR9BOF2FnAfPYXHKmH52Gjx3mqwfFi43zEMf00ZE+eZGz4yRLitFc1Ap66PlijU8rFDyFx8suVNs4E71lC262LcY0P5Yo3o5urcu8xlbthUKHlppe1zmEKojcJjldBe9pEWLXMRStc6VuSpqQ35USljZ0W7Z7l5VueNsisPWYlQQzlpNrC1GkqLLuHit+KMOUP58PBcwsp4zodGvg4mF+aT3uH43ljmpUS4XUzJS8u9PEuUQn2zlAgtavT42OiB5XfMkRjbOQYsN28bwq44npAlUJoNZBM5NyxJQJKw8fcuMenh4bkkKuE5nxa3TMz0ojltqcwFt4kphQhToUULJePcKnmhY5KLBdwPqnnut9agL/hx0XJdYlzImF15yApgs4Hd1lBeJCUtEjb+zpW6SCJPSy/Zs5K4oFetkTpcMoJOiReimw8tvNDnZEtaE2lScmHFziFCPEZKuI3gvP1CAhRuo+GTg8r3rFJz7hUhS5BoNrD3Gso3q9ZQngUtDXqNiWBtHivSpe9nwgCkFDJn8Vg1WEKXvi/uKp6P5TqF/rzW6xRU6633NKRyDed6oIS0Mmk2sPMaytBsYBM1lGfBf11NborTMLzE8b1ZImzqX/A/zPFuLNmoLSHUVmqSeqrV8AHgDWlyDtIi1294xv0hxEpmweas87BVhRrKqNnAtmsoz8IeylzmSh40PK4F3E9KuM1SLPGxEdSyakrguoh5IQPXe9Luw6bW8yWkxKILNq+oqIbSNRvYdQ3lWZAwBt7IILmROL43lrBpD7V4PZYQ6loGwYWME8fvoZ6Zq2GpOoZoSW/usmDzEjpLDeVZkC+dyU3+pM2UufRQrcErJS45GUKhURvA21VrKloALvqxUfE7CFkS/39kKws2t4s1lOdB5gsmD4CXPLw4fgnwuDmlsl6dcTLOzdXWjFpCqCEUqvbLzah2lRncvodcclTldSGkFaWGcn/NBlhDSQR5qBMPx1VrZHeZMj0LHp8l3FmbCGQpcynNBZaEx9TAba3yWcSSseuydxluJUuCNZQ7bzbAGkpSRptXWCMEUfLYnApGVJhskxBuo7FoCNWrJsSsXSeX7cqG6GQlEjWUe242wBpKMo89lLlYkl9wm5RwG41V5msNHweBaw0oDSVZgUkN5U6bDbCGkiyOz3SbPHwiifXj+N5YylxK83ZWrxG3K4Hb99ac8hJC5nKgBZtZQ0nuhytCTjyYoq2UuYgHhtsJrujf4Mm6fVTOiQqm+doGhbrJGk+UkBaOumAzayjJZrh3mYtlXVCXHIMlIolxmiwhYaTlONHxLg0GVmoNSM7LgRdsZg0l2T7ypYoPc/xQ4/glwOMuoZYm8JqXy6xXsib+I/I4CzazhpIcBUOZy+LzCnNLRUpqDfv4uk8aSrI4R1ywmTWU5DRoX7RrfCXOCZuW1NLyj5AlUJoN7LGG0jUbYA0lIZdwarbGS76McXxvrF2HrArLlLWEcAmZAzYb2HkN5TvWUBJiwIeO8D+Q0xplLtrco0UuHDwMP0nJCGsnydIkmg3ssobSizWUhMylUObyI47vjanMxSfyMOOVrMGk2cB+ayhdswHWUBKyIPIfC//zRXqL43sTylyY8UrW5GgLNrOGkpA7sYUyF0KW4IALNrOGkpCtIXMg+J82FkM/ZMscbsFm1lASsj+0MhfWeJF7k6yhVJ7ZzYo1lIQcEy27cI0yF3JulBrK/TUbYA0lIefDv7TwZeAkLwIcT0gtWEO582YDrKEkhHzCp/Hji8JpjTIXcgwSNZR7bjbAGkpCiA21zGUY3uB4cl4mNZQ7bTbAGkpCSDckwxFfMlcNw0ccT47N0RZsZg0lIWRRWOZyPg6zYHOihpKGkhCyOlomJNPw98lRFmxO1VCy2QAhZFNo4Tr5usfxZBv4GsojLNg8qaFkswFCyG5gmcs2OdSCzYkaSkY5CCGHwM+L4UvPScJoOJ70Q2k2cIwaSjYbIIQcHamFS7wQL2KZy2yw2cDhaijZbIAQcmZY5jKfRLOBo9VQstkAIYSkEAOAL9NYDMldmDQbOFgNJcuZCCGkEbX8YRhe4fijcpgFm1lDSQgh6+EzPycvY6/3OH7PHGXBZtZQEkLIRlCTi3a4LNqBFmxmDSUhhGwdlxijlFVIeHBrySXJGso9NhtgDSUhhOwfH9rEF3yst2saUqWGco/NBlhDSQghR6bkjXq97xlOxBrKnTcbYA0lIYScGV+6gcZhIvFarZ5UooZyl80GWENJCCGkSGWTgHfB87qGXffdbOCmhpILNhNCCKnCNRXYZzjVpEQNJRdsJoQQ0g9XS7nPBJ6LsIZyHF+whpIQQshqiEe66drKqIbSGUrWUBJCCNkSkhRU6Ga0tOIaStdsgDWUhBBCdoVf6WWpRKFPNZS+2YA185cQQgjZDWJMXeZqfeLRtYby2myANZSEEELOyLX2cxy/CU3cr0k8cbMB1lASQgghhBBCCCGEEEIIIYQQQpbh/wHP66kwGBka0wAAAABJRU5ErkJggg==';
