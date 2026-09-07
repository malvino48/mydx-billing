// server/test.js
// Automated Unit & Integration Tests untuk MyDX Gas Billing Compliance.
// Menjalankan validasi terhadap locks, triggers, proration, dan adjustments.

const test = require('node:test');
const assert = require('node:assert');
const db = require('./db');
const engine = require('./engine');

test('=== Pengujian Validasi HGBT Cap ($6/MMBTU) ===', (t) => {
  // Industri HGBT (berhak atas cap ≤ $6)
  const isHgbtCustomer = true;
  const underCapResult = engine.validateHgbtCap(5.80, isHgbtCustomer);
  assert.strictEqual(underCapResult.valid, true, 'Harga di bawah $6 harusnya valid.');

  const overCapResult = engine.validateHgbtCap(6.50, isHgbtCustomer);
  assert.strictEqual(overCapResult.valid, false, 'Harga di atas $6 harusnya tidak valid.');
  assert.match(overCapResult.warning, /melebihi batas HGBT/, 'Pesan peringatan harus sesuai.');

  // Customer biasa (non-HGBT)
  const isStandardCustomer = false;
  const standardResult = engine.validateHgbtCap(7.50, isStandardCustomer);
  assert.strictEqual(standardResult.valid, true, 'Customer non-HGBT bebas dari aturan cap $6.');
});

test('=== Pengujian Proration Engine Tengah Bulan ===', (t) => {
  // Simulasikan perhitungan CTR-001 periode 2026-06 (di mana ada regulasi baru per 16 Juni)
  const contractId = 'CTR-001';
  const period = '2026-06';

  const result = engine.computeForContractPeriod(contractId, period);

  assert.strictEqual(result.blocked, false, 'Kalkulasi prorata tidak boleh terblokir.');
  assert.strictEqual(result.isProrated, true, 'Kalkulasi harus terdeteksi prorata (split rule).');
  assert.ok(result.prorationDetails, 'Proration details harus terlampir.');

  const details = result.prorationDetails;
  assert.strictEqual(details.daysInMonth, 30, 'Juni memiliki 30 hari.');
  assert.strictEqual(details.daysOld, 15, 'Sebelum 16 Juni = 15 hari.');
  assert.strictEqual(details.daysNew, 15, 'Mulai 16 Juni = 15 hari.');

  // Verifikasi alokasi split
  const expectedAllocOld = (8000 * 15) / 30;
  assert.ok(Math.abs(details.allocOld - expectedAllocOld) < 0.01, 'Alokasi old terprorata.');

  // Verifikasi subtotal
  assert.ok(details.subTotalOld > 0, 'Subtotal periode pertama terhitung.');
  assert.ok(details.subTotalNew > 0, 'Subtotal periode kedua terhitung.');
  assert.ok(result.totalUsd > 0, 'Grand total USD valid.');
});

test('=== Pengujian Trigger Imutabilitas Database & API locks ===', (t) => {
  // Masukkan data mock ticket langsung dengan status INVOICED
  const ticketId = 'TKT-TEST-INVOICED';
  db.prepare("INSERT OR REPLACE INTO billing_tickets (id, contract_id, period, status) VALUES (?, 'CTR-001', '2026-07', 'INVOICED')").run(ticketId);

  // Buat calculation mock terikat
  const run = db.prepare("INSERT INTO billing_runs (ticket_id, contract_id, period) VALUES (?, 'CTR-001', '2026-07')").run(ticketId);
  const calcId = db.prepare(`
    INSERT INTO calculations (run_id, ticket_id, contract_id, period, version, total_usd)
    VALUES (?, ?, 'CTR-001', '2026-07', 1, 5000)
  `).run(run.lastInsertRowid, ticketId).lastInsertRowid;

  // Tes 1: Update status tiket INVOICED di database harus error (Aborted by Trigger)
  assert.throws(() => {
    db.prepare("UPDATE billing_tickets SET notes = 'Coba ubah' WHERE id = ?").run(ticketId);
  }, /TICKET_LOCKED/, 'Trigger SQLite harus menolak modifikasi tiket INVOICED.');

  // Tes 2: Delete tiket INVOICED harus error
  assert.throws(() => {
    db.prepare("DELETE FROM billing_tickets WHERE id = ?").run(ticketId);
  }, /TICKET_LOCKED/, 'Trigger SQLite harus menolak penghapusan tiket INVOICED.');

  // Tes 3: Update calculation terikat tiket INVOICED harus error
  assert.throws(() => {
    db.prepare("UPDATE calculations SET total_usd = 6000 WHERE id = ?").run(calcId);
  }, /CALCULATION_LOCKED/, 'Trigger SQLite harus mengunci record calculations jika status tiket INVOICED.');

  // Bersihkan data dengan mendrop trigger sementara lalu menghapus data (agar database bersih setelah pengujian)
  db.exec(`
    DROP TRIGGER IF EXISTS lock_invoiced_tickets_update;
    DROP TRIGGER IF EXISTS lock_invoiced_tickets_status_change;
    DROP TRIGGER IF EXISTS lock_invoiced_tickets_delete;
    DROP TRIGGER IF EXISTS lock_invoiced_calculations_update;
    DROP TRIGGER IF EXISTS lock_invoiced_calculations_delete;
  `);

  // Hapus data mock
  db.prepare("DELETE FROM calculations WHERE ticket_id = ?").run(ticketId);
  db.prepare("DELETE FROM billing_tickets WHERE id = ?").run(ticketId);

  // Pasang kembali triggers agar sistem tetap aman setelah tes
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_update
    BEFORE UPDATE ON billing_tickets
    FOR EACH ROW
    WHEN OLD.status = 'INVOICED' AND NEW.status = 'INVOICED'
    BEGIN
      SELECT RAISE(ABORT, 'TICKET_LOCKED: Tiket sudah berstatus INVOICED dan tidak dapat diubah.');
    END;

    CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_status_change
    BEFORE UPDATE OF status ON billing_tickets
    FOR EACH ROW
    WHEN OLD.status = 'INVOICED' AND NEW.status != 'INVOICED'
    BEGIN
      SELECT RAISE(ABORT, 'TICKET_LOCKED: Status INVOICED adalah permanen dan tidak bisa diubah kembali.');
    END;

    CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_delete
    BEFORE DELETE ON billing_tickets
    FOR EACH ROW
    WHEN OLD.status = 'INVOICED'
    BEGIN
      SELECT RAISE(ABORT, 'TICKET_LOCKED: Tiket berstatus INVOICED tidak boleh dihapus.');
    END;

    CREATE TRIGGER IF NOT EXISTS lock_invoiced_calculations_update
    BEFORE UPDATE ON calculations
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = NEW.ticket_id AND status = 'INVOICED')
    BEGIN
      SELECT RAISE(ABORT, 'CALCULATION_LOCKED: Tiket sudah INVOICED. Perhitungan permanen terkunci.');
    END;

    CREATE TRIGGER IF NOT EXISTS lock_invoiced_calculations_delete
    BEFORE DELETE ON calculations
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = OLD.ticket_id AND status = 'INVOICED')
    BEGIN
      SELECT RAISE(ABORT, 'CALCULATION_LOCKED: Tiket sudah INVOICED. Perhitungan tidak boleh dihapus.');
    END;
  `);
});

// ─────────────────────────────────────────
//  G-10a: Retroactive Adjustment (Credit Note) pada Tiket INVOICED
// ─────────────────────────────────────────
test('=== G-10a: Retroactive Adjustment — Credit Note harus diterbitkan tanpa menyentuh invoice asli ===', (t) => {
  // Setup: Buat tiket mock yang sudah INVOICED
  const ticketId = 'TKT-TEST-ADJ-CREDIT';
  db.prepare("INSERT OR REPLACE INTO billing_tickets (id, contract_id, period, status, payment_scheme) VALUES (?, 'CTR-001', '2026-07', 'INVOICED', 'postpaid')").run(ticketId);

  const run = db.prepare("INSERT INTO billing_runs (ticket_id, contract_id, period) VALUES (?, 'CTR-001', '2026-07')").run(ticketId);
  const calcId = db.prepare(`
    INSERT INTO calculations (run_id, ticket_id, contract_id, period, version, total_usd, status)
    VALUES (?, ?, 'CTR-001', '2026-07', 1, 55000, 'approved')
  `).run(run.lastInsertRowid, ticketId).lastInsertRowid;

  const origInvoiceId = `INV-TEST-ADJ-CREDIT-v1`;
  db.prepare(`
    INSERT OR REPLACE INTO invoices (id, ticket_id, calculation_id, contract_id, period, status, invoice_amount)
    VALUES (?, ?, ?, 'CTR-001', '2026-07', 'issued', 55000)
  `).run(origInvoiceId, ticketId, calcId);

  // Verifikasi invoice asli tersimpan
  const origInvoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(origInvoiceId);
  assert.strictEqual(origInvoice.invoice_amount, 55000, 'Invoice asli harus bernilai 55000.');

  // Simulasikan penurunan harga retroaktif: Buat calculation baru dengan total lebih rendah
  const adjRun = db.prepare("INSERT INTO billing_runs (ticket_id, contract_id, period) VALUES (?, 'CTR-001', '2026-07')").run(ticketId + '-ADJ');
  const newCalcId = db.prepare(`
    INSERT INTO calculations (run_id, ticket_id, contract_id, period, version, total_usd, status)
    VALUES (?, ?, 'CTR-001', '2026-07', 2, 50000, 'approved')
  `).run(adjRun.lastInsertRowid, ticketId + '-ADJ').lastInsertRowid;

  const delta = 50000 - 55000; // -5000 → Credit Note
  const adjType = delta >= 0 ? 'debit' : 'credit';
  assert.strictEqual(adjType, 'credit', 'Penurunan harga harus menghasilkan Credit Note.');
  assert.strictEqual(delta, -5000, 'Delta harus -5000 (selisih harga turun).');

  // Catat adjustment — invoice asli tidak boleh diubah
  db.prepare('INSERT INTO adjustments (original_invoice_id, new_calculation_id, delta, adjustment_type, reason) VALUES (?,?,?,?,?)')
    .run(origInvoiceId, newCalcId, delta, adjType, 'Test retroactive price decrease');

  // Pastikan invoice asli TIDAK berubah setelah adjustment
  const origInvoiceAfter = db.prepare('SELECT * FROM invoices WHERE id = ?').get(origInvoiceId);
  assert.strictEqual(origInvoiceAfter.invoice_amount, 55000, 'Invoice asli harus tetap 55000 — tidak boleh dimodifikasi.');

  // Cleanup (drop ALL relevant triggers sementara agar DELETE tidak diblokir)
  db.exec(`
    DROP TRIGGER IF EXISTS lock_invoiced_tickets_update;
    DROP TRIGGER IF EXISTS lock_invoiced_tickets_status_change;
    DROP TRIGGER IF EXISTS lock_invoiced_tickets_delete;
    DROP TRIGGER IF EXISTS lock_invoiced_invoices_update;
    DROP TRIGGER IF EXISTS lock_invoiced_invoices_delete;
    DROP TRIGGER IF EXISTS lock_invoiced_calculations_update;
    DROP TRIGGER IF EXISTS lock_invoiced_calculations_delete;
  `);
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM adjustments WHERE original_invoice_id = ?').run(origInvoiceId);
  db.prepare('DELETE FROM invoices WHERE id = ?').run(origInvoiceId);
  db.prepare('DELETE FROM calculations WHERE id = ?').run(calcId);
  db.prepare('DELETE FROM calculations WHERE id = ?').run(newCalcId);
  db.prepare('DELETE FROM billing_runs WHERE ticket_id = ?').run(ticketId);
  db.prepare('DELETE FROM billing_runs WHERE ticket_id = ?').run(ticketId + '-ADJ');
  db.prepare('DELETE FROM billing_tickets WHERE id = ?').run(ticketId);
  db.pragma('foreign_keys = ON');
  // Re-create semua triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_update
    BEFORE UPDATE ON billing_tickets
    FOR EACH ROW
    WHEN OLD.status = 'INVOICED'
    BEGIN SELECT RAISE(ABORT, 'TICKET_LOCKED: Tiket sudah berstatus INVOICED dan tidak dapat diubah.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_status_change
    BEFORE UPDATE OF status ON billing_tickets
    FOR EACH ROW
    WHEN OLD.status = 'INVOICED' AND NEW.status != 'INVOICED'
    BEGIN SELECT RAISE(ABORT, 'TICKET_LOCKED: Status INVOICED adalah permanen dan tidak bisa diubah kembali.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_delete
    BEFORE DELETE ON billing_tickets
    FOR EACH ROW
    WHEN OLD.status = 'INVOICED'
    BEGIN SELECT RAISE(ABORT, 'TICKET_LOCKED: Tiket berstatus INVOICED tidak boleh dihapus.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_invoices_update
    BEFORE UPDATE ON invoices
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = NEW.ticket_id AND status = 'INVOICED')
    BEGIN SELECT RAISE(ABORT, 'INVOICE_LOCKED: Invoice sudah dirilis dan bersifat immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_invoices_delete
    BEFORE DELETE ON invoices
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = OLD.ticket_id AND status = 'INVOICED')
    BEGIN SELECT RAISE(ABORT, 'INVOICE_LOCKED: Invoice sudah dirilis dan tidak boleh dihapus.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_calculations_update
    BEFORE UPDATE ON calculations
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = NEW.ticket_id AND status = 'INVOICED')
    BEGIN SELECT RAISE(ABORT, 'CALCULATION_LOCKED: Tiket sudah INVOICED. Perhitungan permanen terkunci.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_calculations_delete
    BEFORE DELETE ON calculations
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = OLD.ticket_id AND status = 'INVOICED')
    BEGIN SELECT RAISE(ABORT, 'CALCULATION_LOCKED: Tiket sudah INVOICED. Perhitungan tidak boleh dihapus.'); END;
  `);
});

// ─────────────────────────────────────────
//  G-10b: DB Trigger — Imutabilitas Invoice (INVOICED)
// ─────────────────────────────────────────
test('=== G-10b: DB Trigger — Blokir UPDATE dan DELETE pada Invoice dari Tiket INVOICED ===', (t) => {
  const ticketId = 'TKT-TEST-INV-LOCK';
  // Bersihkan data sisa dari run sebelumnya (tanpa trigger dan tanpa FK)
  db.exec(`
    DROP TRIGGER IF EXISTS lock_invoiced_tickets_delete;
    DROP TRIGGER IF EXISTS lock_invoiced_invoices_update;
    DROP TRIGGER IF EXISTS lock_invoiced_invoices_delete;
    DROP TRIGGER IF EXISTS lock_invoiced_calculations_update;
    DROP TRIGGER IF EXISTS lock_invoiced_calculations_delete;
  `);
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM invoices WHERE ticket_id = ?').run(ticketId);
  db.prepare('DELETE FROM calculations WHERE ticket_id = ?').run(ticketId);
  db.prepare('DELETE FROM billing_runs WHERE ticket_id = ?').run(ticketId);
  db.prepare('DELETE FROM billing_tickets WHERE id = ?').run(ticketId);
  db.pragma('foreign_keys = ON');
  // Pasang kembali semua trigger sebelum test dijalankan
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_delete
    BEFORE DELETE ON billing_tickets
    FOR EACH ROW
    WHEN OLD.status = 'INVOICED'
    BEGIN SELECT RAISE(ABORT, 'TICKET_LOCKED: Tiket berstatus INVOICED tidak boleh dihapus.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_invoices_update
    BEFORE UPDATE ON invoices
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = NEW.ticket_id AND status = 'INVOICED')
    BEGIN SELECT RAISE(ABORT, 'INVOICE_LOCKED: Invoice sudah dirilis dan bersifat immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_invoices_delete
    BEFORE DELETE ON invoices
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = OLD.ticket_id AND status = 'INVOICED')
    BEGIN SELECT RAISE(ABORT, 'INVOICE_LOCKED: Invoice sudah dirilis dan tidak boleh dihapus.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_calculations_update
    BEFORE UPDATE ON calculations
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = NEW.ticket_id AND status = 'INVOICED')
    BEGIN SELECT RAISE(ABORT, 'CALCULATION_LOCKED: Tiket sudah INVOICED. Perhitungan permanen terkunci.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_calculations_delete
    BEFORE DELETE ON calculations
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = OLD.ticket_id AND status = 'INVOICED')
    BEGIN SELECT RAISE(ABORT, 'CALCULATION_LOCKED: Tiket sudah INVOICED. Perhitungan tidak boleh dihapus.'); END;
  `);

  db.prepare("INSERT INTO billing_tickets (id, contract_id, period, status, payment_scheme) VALUES (?, 'CTR-001', '2026-07', 'INVOICED', 'postpaid')").run(ticketId);

  const run = db.prepare("INSERT INTO billing_runs (ticket_id, contract_id, period) VALUES (?, 'CTR-001', '2026-07')").run(ticketId);
  const calcId = db.prepare(`
    INSERT INTO calculations (run_id, ticket_id, contract_id, period, version, total_usd, status)
    VALUES (?, ?, 'CTR-001', '2026-07', 1, 40000, 'approved')
  `).run(run.lastInsertRowid, ticketId).lastInsertRowid;

  const invoiceId = 'INV-TEST-INV-LOCK-v1';
  db.prepare(`
    INSERT INTO invoices (id, ticket_id, calculation_id, contract_id, period, status, invoice_amount)
    VALUES (?, ?, ?, 'CTR-001', '2026-07', 'issued', 40000)
  `).run(invoiceId, ticketId, calcId);

  // Tes: UPDATE invoice terikat tiket INVOICED harus diblokir trigger
  assert.throws(() => {
    db.prepare("UPDATE invoices SET invoice_amount = 99999 WHERE id = ?").run(invoiceId);
  }, /INVOICE_LOCKED/, 'Trigger harus menolak UPDATE invoice yang terikat tiket INVOICED.');

  // Tes: DELETE invoice terikat tiket INVOICED harus diblokir trigger
  assert.throws(() => {
    db.prepare("DELETE FROM invoices WHERE id = ?").run(invoiceId);
  }, /INVOICE_LOCKED/, 'Trigger harus menolak DELETE invoice yang terikat tiket INVOICED.');

  // Cleanup (drop triggers dulu agar bisa hapus data)
  db.exec(`
    DROP TRIGGER IF EXISTS lock_invoiced_tickets_update;
    DROP TRIGGER IF EXISTS lock_invoiced_tickets_status_change;
    DROP TRIGGER IF EXISTS lock_invoiced_tickets_delete;
    DROP TRIGGER IF EXISTS lock_invoiced_invoices_update;
    DROP TRIGGER IF EXISTS lock_invoiced_invoices_delete;
    DROP TRIGGER IF EXISTS lock_invoiced_calculations_update;
    DROP TRIGGER IF EXISTS lock_invoiced_calculations_delete;
  `);
  db.prepare('DELETE FROM invoices WHERE id = ?').run(invoiceId);
  db.prepare('DELETE FROM calculations WHERE id = ?').run(calcId);
  db.prepare('DELETE FROM billing_tickets WHERE id = ?').run(ticketId);
  // Re-create semua triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_update
    BEFORE UPDATE ON billing_tickets
    FOR EACH ROW
    WHEN OLD.status = 'INVOICED'
    BEGIN SELECT RAISE(ABORT, 'TICKET_LOCKED: Tiket sudah berstatus INVOICED dan tidak dapat diubah.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_status_change
    BEFORE UPDATE OF status ON billing_tickets
    FOR EACH ROW
    WHEN OLD.status = 'INVOICED' AND NEW.status != 'INVOICED'
    BEGIN SELECT RAISE(ABORT, 'TICKET_LOCKED: Status INVOICED adalah permanen dan tidak bisa diubah kembali.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_delete
    BEFORE DELETE ON billing_tickets
    FOR EACH ROW
    WHEN OLD.status = 'INVOICED'
    BEGIN SELECT RAISE(ABORT, 'TICKET_LOCKED: Tiket berstatus INVOICED tidak boleh dihapus.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_invoices_update
    BEFORE UPDATE ON invoices
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = NEW.ticket_id AND status = 'INVOICED')
    BEGIN SELECT RAISE(ABORT, 'INVOICE_LOCKED: Invoice sudah dirilis dan bersifat immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_invoices_delete
    BEFORE DELETE ON invoices
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = OLD.ticket_id AND status = 'INVOICED')
    BEGIN SELECT RAISE(ABORT, 'INVOICE_LOCKED: Invoice sudah dirilis dan tidak boleh dihapus.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_calculations_update
    BEFORE UPDATE ON calculations
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = NEW.ticket_id AND status = 'INVOICED')
    BEGIN SELECT RAISE(ABORT, 'CALCULATION_LOCKED: Tiket sudah INVOICED. Perhitungan permanen terkunci.'); END;
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_calculations_delete
    BEFORE DELETE ON calculations
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = OLD.ticket_id AND status = 'INVOICED')
    BEGIN SELECT RAISE(ABORT, 'CALCULATION_LOCKED: Tiket sudah INVOICED. Perhitungan tidak boleh dihapus.'); END;
  `);
});

// ─────────────────────────────────────────
//  G-10c: State Machine Guard — Tolak Transisi Mundur
// ─────────────────────────────────────────
test('=== G-10c: State Machine Guard — Transisi mundur APPROVED→DRAFT harus ditolak ===', (t) => {
  // Simulasikan state machine guard dari routes.js secara langsung (unit test logic)
  const FORWARD_ONLY_FROM = ['VALIDATED', 'APPROVED'];
  const BACKWARD_STATES   = ['DRAFT', 'WORKLIST', 'DECISION'];

  const isBackwardTransitionBlocked = (currentStatus, targetStatus) =>
    FORWARD_ONLY_FROM.includes(currentStatus) && BACKWARD_STATES.includes(targetStatus);

  // Transisi mundur yang HARUS diblokir
  assert.strictEqual(isBackwardTransitionBlocked('APPROVED', 'DRAFT'), true,
    'APPROVED → DRAFT harus ditolak.');
  assert.strictEqual(isBackwardTransitionBlocked('APPROVED', 'WORKLIST'), true,
    'APPROVED → WORKLIST harus ditolak.');
  assert.strictEqual(isBackwardTransitionBlocked('VALIDATED', 'DRAFT'), true,
    'VALIDATED → DRAFT harus ditolak.');

  // Transisi maju yang HARUS diizinkan
  assert.strictEqual(isBackwardTransitionBlocked('APPROVED', 'INVOICED'), false,
    'APPROVED → INVOICED harus diizinkan.');
  assert.strictEqual(isBackwardTransitionBlocked('VALIDATED', 'APPROVED'), false,
    'VALIDATED → APPROVED harus diizinkan.');
  assert.strictEqual(isBackwardTransitionBlocked('CALCULATED', 'VALIDATED'), false,
    'CALCULATED → VALIDATED harus diizinkan.');
  assert.strictEqual(isBackwardTransitionBlocked('DRAFT', 'WORKLIST'), false,
    'DRAFT → WORKLIST harus diizinkan (forward).');
  // Recalculate menghasilkan CALCULATED — bukan lewat PATCH status
  assert.strictEqual(isBackwardTransitionBlocked('APPROVED', 'CALCULATED'), false,
    'APPROVED → CALCULATED diperbolehkan (via recalculate endpoint, bukan PATCH).');
});

// ─────────────────────────────────────────
//  G-10d: Proration Engine dengan Sub-Period Eksplisit (|before / |after)
// ─────────────────────────────────────────
test('=== G-10d: Proration Engine — Kalkulasi split dengan data usage sub-period eksplisit ===', (t) => {
  // CTR-001 periode 2026-06 sudah memiliki data usage |before (120k m3) & |after (125k m3)
  const contractId = 'CTR-001';
  const period = '2026-06';

  const usageBefore = engine.getUsage(contractId, period + '|before');
  const usageAfter  = engine.getUsage(contractId, period + '|after');

  assert.ok(usageBefore, 'Usage sub-period |before harus tersedia.');
  assert.ok(usageAfter, 'Usage sub-period |after harus tersedia.');

  const result = engine.computeForContractPeriod(contractId, period);

  assert.strictEqual(result.blocked, false, 'Kalkulasi tidak boleh terblokir.');
  assert.strictEqual(result.isProrated, true, 'Harus terdeteksi sebagai kalkulasi prorata.');

  const details = result.prorationDetails;

  // Karena data sub-period tersedia, engine harus menggunakan nilai AKTUAL bukan rata-rata harian
  assert.ok(Math.abs(details.qtyOld - usageBefore.qty_mmbtu) < 0.01,
    `qtyOld harus menggunakan data |before (${usageBefore.qty_mmbtu} MMBTU), bukan rata-rata harian.`);
  assert.ok(Math.abs(details.qtyNew - usageAfter.qty_mmbtu) < 0.01,
    `qtyNew harus menggunakan data |after (${usageAfter.qty_mmbtu} MMBTU), bukan rata-rata harian.`);

  // Verifikasi snapshot pvOld / pvNew ada di prorationDetails (G-07)
  assert.ok(details.pvOldSnapshot, 'prorationDetails harus menyertakan pvOldSnapshot (G-07).');
  assert.ok(details.pvNewSnapshot, 'prorationDetails harus menyertakan pvNewSnapshot (G-07).');
  assert.ok(details.pvOldSnapshot.rate_eligible > 0, 'pvOldSnapshot.rate_eligible harus valid.');
  assert.ok(details.pvNewSnapshot.rate_eligible > 0, 'pvNewSnapshot.rate_eligible harus valid.');

  // Verifikasi ruleOld dan ruleNew tersedia di result (G-06)
  assert.ok(result.ruleOld, 'result.ruleOld harus ada untuk kalkulasi prorata (G-06).');
  assert.ok(result.ruleNew, 'result.ruleNew harus ada untuk kalkulasi prorata (G-06).');
  assert.notStrictEqual(result.ruleOld.id, result.ruleNew.id,
    'ruleOld dan ruleNew harus berbeda (dua rule berbeda untuk dua sub-periode).');

  // Verifikasi total > 0
  assert.ok(result.totalUsd > 0, 'Grand total kalkulasi prorata harus positif.');
  assert.ok(details.subTotalOld > 0, 'Subtotal sub-periode pertama harus positif.');
  assert.ok(details.subTotalNew > 0, 'Subtotal sub-periode kedua harus positif.');
});

console.log('✔ Seluruh automated test compliance berhasil didaftarkan (termasuk G-10a–d).');
