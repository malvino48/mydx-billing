// server/db.js
// SQLite database — schema + seed data untuk PGNCOM Gas Billing (versi MyDX).
// Memenuhi kepatuhan regulasi harga, validitas rentang tanggal (valid_from/valid_to),
// audit trail snapshot, dan trigger imutabilitas database untuk status INVOICED.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ─────────────────────────────────────────
//  SCHEMA MIGRATION
// ─────────────────────────────────────────
function migrate() {
  db.exec(`
    -- Sektor industri HGBT
    CREATE TABLE IF NOT EXISTS hgbt_industries (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT
    );

    -- Regulasi (Permen/Kepmen ESDM)
    CREATE TABLE IF NOT EXISTS regulations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,             -- permen | kepmen
      number TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,           -- active | revoked
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      revoked_by TEXT,
      parent_id TEXT,
      hgbt_cap REAL,                  -- HGBT Cap ($/MMBTU)
      notes TEXT
    );

    -- Versi harga dengan valid_from dan valid_to (date range validity)
    CREATE TABLE IF NOT EXISTS price_versions (
      id TEXT PRIMARY KEY,
      regulation_id TEXT NOT NULL,
      label TEXT,
      currency TEXT NOT NULL DEFAULT 'USD',
      uom TEXT NOT NULL DEFAULT 'MMBTU',
      valid_from TEXT NOT NULL,       -- Kepatuhan Aturan 1: valid_from
      valid_to TEXT,                 -- Kepatuhan Aturan 1: valid_to (nullable)
      rate_eligible REAL NOT NULL,
      rate_excess REAL NOT NULL,
      applicable_industries TEXT,     -- JSON array
      approval TEXT,
      FOREIGN KEY (regulation_id) REFERENCES regulations(id)
    );

    -- Formula
    CREATE TABLE IF NOT EXISTS formulas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      expr TEXT NOT NULL,
      description TEXT
    );

    -- Customer
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      npwp TEXT,
      address TEXT,
      segment TEXT,
      industry_code TEXT,
      is_hgbt INTEGER DEFAULT 0,
      FOREIGN KEY (industry_code) REFERENCES hgbt_industries(code)
    );

    -- Kontrak
    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      payment_scheme TEXT NOT NULL,   -- postpaid | prepaid | hybrid
      frequency TEXT NOT NULL,
      fixed_fee REAL DEFAULT 0,
      annual_fee REAL DEFAULT 0,
      opening_balance REAL DEFAULT 0,
      min_qty REAL DEFAULT 0,
      allocation REAL NOT NULL,
      uom TEXT NOT NULL DEFAULT 'MMBTU',
      start_date TEXT,
      end_date TEXT,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    -- Billing Rules
    CREATE TABLE IF NOT EXISTS billing_rules (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      priority INTEGER NOT NULL,
      formula_id TEXT NOT NULL,
      price_version_id TEXT NOT NULL,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      FOREIGN KEY (contract_id) REFERENCES contracts(id),
      FOREIGN KEY (formula_id) REFERENCES formulas(id),
      FOREIGN KEY (price_version_id) REFERENCES price_versions(id)
    );

    -- Usage Records
    CREATE TABLE IF NOT EXISTS usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id TEXT NOT NULL,
      period TEXT NOT NULL,
      raw_m3 REAL,
      qty_mmbtu REAL,
      status TEXT NOT NULL DEFAULT 'validated',
      note TEXT,
      one_time_fee REAL DEFAULT 0,
      one_time_label TEXT,
      UNIQUE(contract_id, period)
    );

    -- Kurs JISDOR
    CREATE TABLE IF NOT EXISTS jisdor_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rate_date TEXT NOT NULL UNIQUE,
      idr_per_usd REAL NOT NULL,
      source TEXT DEFAULT 'Bank Indonesia JISDOR'
    );

    -- Billing Tickets
    CREATE TABLE IF NOT EXISTS billing_tickets (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      period TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      payment_scheme TEXT,
      created_by TEXT DEFAULT 'maker',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      notes TEXT,
      parent_ticket_id TEXT,          -- Reference for retroactive adjustments
      FOREIGN KEY (contract_id) REFERENCES contracts(id)
    );

    -- Billing Runs
    CREATE TABLE IF NOT EXISTS billing_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT,
      contract_id TEXT NOT NULL,
      period TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Calculations (Kepatuhan Aturan 5: Audit Trail & Snapshot Lengkap)
    CREATE TABLE IF NOT EXISTS calculations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      ticket_id TEXT,
      contract_id TEXT NOT NULL,
      period TEXT NOT NULL,
      version INTEGER NOT NULL,
      rule_id TEXT,
      price_version_id TEXT,
      formula_id TEXT,
      eligible_qty REAL,
      excess_qty REAL,
      fixed_fee REAL DEFAULT 0,
      annual_fee_prorated REAL DEFAULT 0,
      one_time_fee REAL DEFAULT 0,
      total_usd REAL NOT NULL,
      -- Audit Trail Snapshots
      hgbt_cap REAL,                  -- HGBT Cap snapshot
      triggered_by TEXT DEFAULT 'maker', -- Triggered by User ID
      -- IDR conversion
      jisdor_date TEXT,
      jisdor_rate REAL,
      ppn_rate REAL DEFAULT 0.11,
      ppn_amount REAL,
      total_idr REAL,
      total REAL GENERATED ALWAYS AS (total_usd) VIRTUAL,
      status TEXT NOT NULL DEFAULT 'draft',
      hgbt_validated INTEGER DEFAULT 0,
      hgbt_warning TEXT,
      snapshot_rate_eligible REAL,   -- G-01: Tarif eligible yang dibekukan saat kalkulasi berlangsung
      snapshot_rate_excess REAL,     -- G-01: Tarif excess yang dibekukan saat kalkulasi berlangsung
      trace_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES billing_runs(id)
    );

    -- Exception approvals
    CREATE TABLE IF NOT EXISTS exceptions_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calculation_id INTEGER NOT NULL,
      exception_type TEXT,
      severity TEXT,
      variance_pct REAL,
      decision TEXT,
      approver TEXT,
      approver_note TEXT,
      decided_at TEXT,
      FOREIGN KEY (calculation_id) REFERENCES calculations(id)
    );

    -- Invoices
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      ticket_id TEXT,
      calculation_id INTEGER NOT NULL,
      contract_id TEXT NOT NULL,
      period TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'issued',
      invoice_amount REAL NOT NULL,
      balance_applied REAL DEFAULT 0,
      remaining_balance REAL,
      jisdor_date TEXT,
      jisdor_rate REAL,
      ppn_rate REAL DEFAULT 0.11,
      ppn_amount REAL,
      total_idr REAL,
      version INTEGER DEFAULT 1,
      issued_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (calculation_id) REFERENCES calculations(id)
    );

    -- Adjustments
    CREATE TABLE IF NOT EXISTS adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_invoice_id TEXT NOT NULL,
      new_calculation_id INTEGER NOT NULL,
      delta REAL NOT NULL,
      adjustment_type TEXT NOT NULL,   -- debit | credit
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────────
    --  Kepatuhan Aturan 2: Database-level Locks (SQLite Triggers)
    -- ─────────────────────────────────────────

    -- Mencegah update & delete tiket yang statusnya INVOICED
    -- G-03 FIX: Hapus kondisi 'AND NEW.status = INVOICED' agar semua perubahan field
    -- (bukan hanya status) pada tiket INVOICED juga terblokir.
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_update
    BEFORE UPDATE ON billing_tickets
    FOR EACH ROW
    WHEN OLD.status = 'INVOICED'
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

    -- Mencegah update & delete calculations yang terikat dengan tiket INVOICED
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

    -- Mencegah update & delete invoices yang terikat dengan tiket INVOICED
    CREATE TRIGGER IF NOT EXISTS lock_invoiced_invoices_update
    BEFORE UPDATE ON invoices
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = NEW.ticket_id AND status = 'INVOICED')
    BEGIN
      SELECT RAISE(ABORT, 'INVOICE_LOCKED: Invoice sudah dirilis dan bersifat immutable.');
    END;

    CREATE TRIGGER IF NOT EXISTS lock_invoiced_invoices_delete
    BEFORE DELETE ON invoices
    FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = OLD.ticket_id AND status = 'INVOICED')
    BEGIN
      SELECT RAISE(ABORT, 'INVOICE_LOCKED: Invoice sudah dirilis dan tidak boleh dihapus.');
    END;
  `);
}

// ─────────────────────────────────────────
//  SEED DATA
// ─────────────────────────────────────────
function seedIfEmpty() {
  const custCount = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  if (custCount >= 18) return;

  const ins = (table, cols, rows) => {
    const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    const tx = db.transaction((rs) => rs.forEach((r) => stmt.run(...r)));
    tx(rows);
  };

  // 7 Industri HGBT
  ins('hgbt_industries', ['code', 'name', 'description'], [
    ['HGBT-01', 'Pupuk', 'Industri pupuk nasional'],
    ['HGBT-02', 'Petrokimia', 'Industri petrokimia'],
    ['HGBT-03', 'Oleokimia', 'Industri oleokimia'],
    ['HGBT-04', 'Baja', 'Industri baja logam'],
    ['HGBT-05', 'Keramik', 'Industri ubin dan keramik'],
    ['HGBT-06', 'Kaca', 'Industri kaca lembaran'],
    ['HGBT-07', 'Sarung Tangan Karet', 'Industri sarung tangan medis/karet'],
  ]);

  // Regulations
  ins('regulations',
    ['id','type','number','name','status','effective_from','effective_to','revoked_by','parent_id','hgbt_cap','notes'], [
    ['REG-4-2016', 'permen', '4/2016', 'Permen ESDM 4/2016', 'revoked', '2016-04-01', '2020-01-19', 'REG-8-2020', null, null, 'Awal regulasi domestik gas.'],
    ['REG-8-2020', 'permen', '8/2020', 'Permen ESDM 8/2020', 'revoked', '2020-01-20', '2022-04-14', 'REG-15-2022', 'REG-4-2016', 6.00, 'Batas harga HGBT $6 pertama.'],
    ['REG-15-2022', 'permen', '15/2022', 'Permen ESDM 15/2022', 'active', '2022-04-15', null, null, 'REG-8-2020', 6.00, 'Tata cara HGBT Industri utama.'],
    ['REG-91-2023', 'kepmen', '91/2023', 'Kepmen ESDM 91/2023', 'active', '2023-06-01', null, null, 'REG-15-2022', 6.00, 'Penetapan harga spesifik HGBT.'],
    ['REG-281-2026', 'kepmen', '281/2026', 'Kepmen ESDM 281/2026', 'active', '2026-06-16', null, null, 'REG-91-2023', 6.00, 'Amandemen harga terbaru 2026.'],
  ]);

  // Price Versions
  ins('price_versions',
    ['id','regulation_id','label','currency','uom','valid_from','valid_to','rate_eligible','rate_excess','applicable_industries','approval'], [
    ['PV-HGBT-2016', 'REG-4-2016', 'HGBT 2016', 'USD', 'MMBTU', '2016-04-01', '2020-01-19', 4.72, 7.80, '["HGBT-01","HGBT-02","HGBT-03","HGBT-04","HGBT-05","HGBT-06","HGBT-07"]', 'Approved — 2016'],
    ['PV-HGBT-2020', 'REG-8-2020', 'HGBT 2020', 'USD', 'MMBTU', '2020-01-20', '2022-04-14', 5.80, 8.10, '["HGBT-01","HGBT-02","HGBT-03","HGBT-04","HGBT-05","HGBT-06","HGBT-07"]', 'Approved — 2020'],
    ['PV-HGBT-2023', 'REG-91-2023', 'HGBT 2023', 'USD', 'MMBTU', '2023-06-01', '2026-06-15', 6.00, 9.20, '["HGBT-01","HGBT-02","HGBT-03","HGBT-04","HGBT-05","HGBT-06","HGBT-07"]', 'Approved — 2023'],
    ['PV-HGBT-2026', 'REG-281-2026', 'HGBT 2026', 'USD', 'MMBTU', '2026-06-16', null, 6.00, 9.80, '["HGBT-01","HGBT-02","HGBT-03","HGBT-04","HGBT-05","HGBT-06","HGBT-07"]', 'Approved — 2026'],
    ['PV-STD-2026', 'REG-281-2026', 'Non-HGBT Standard 2026', 'USD', 'MMBTU', '2026-06-16', null, 7.50, 10.50, null, 'Approved — 2026'],
  ]);

  // Formulas
  ins('formulas', ['id','name','expr','description'], [
    ['F-POSTPAID-STD', 'Postpaid Standard', 'fixedFee + (eligibleQty * eligibleRate) + (excessQty * excessRate)', 'Formula postpaid standard.'],
    ['F-POSTPAID-ANNUAL', 'Postpaid + Annual + One-Time', 'fixedFee + (eligibleQty * eligibleRate) + (excessQty * excessRate) + (annualFee / 12) + oneTimeFee', 'Formula postpaid dengan prora tahunan.'],
    ['F-HYBRID', 'Hybrid (Prepaid Deduction)', 'MAX(0, fixedFee + (eligibleQty * eligibleRate) + (excessQty * excessRate) - prepaidBalance)', 'Formula hybrid dengan potong saldo.'],
    ['F-TAKEORPAY', 'Take-or-Pay Minimum', 'MAX(actualQty, minQty) * eligibleRate', 'Volume guarantee min.'],
  ]);

  // 18 Customers (bisa 1, 2, atau 3 kontrak)
  ins('customers', ['id','name','npwp','address','segment','industry_code','is_hgbt'], [
    ['CUST-001', 'PT Industri Kimia Nusantara', '01.234.567.8-001.000', 'Cikarang', 'Industri Besar', 'HGBT-02', 1],
    ['CUST-002', 'PT Manufaktur Baja Perkasa', '02.345.678.9-002.000', 'Cilegon', 'Industri Besar', 'HGBT-04', 1],
    ['CUST-003', 'PT Tekstil Keramik Sentosa', '03.456.789.0-003.000', 'Bogor', 'Industri Menengah', 'HGBT-05', 1],
    ['CUST-004', 'PT Petrokimia Andalas', '04.567.890.1-004.000', 'Dumai', 'Industri Besar', 'HGBT-01', 1],
    ['CUST-005', 'PT Kaca Mitra Jaya', '05.678.901.2-005.000', 'Mojokerto', 'Industri Besar', 'HGBT-06', 1],
    ['CUST-006', 'PT Logam Cipta Abadi', '06.789.012.3-006.000', 'Bekasi', 'Industri Menengah', 'HGBT-04', 1],
    ['CUST-007', 'PT Oleo Energi Prima', '07.890.123.4-007.000', 'Medan', 'Industri Besar', 'HGBT-03', 1],
    ['CUST-008', 'PT Sarung Tangan Medika', '08.901.234.5-008.000', 'Surabaya', 'Industri Menengah', 'HGBT-07', 1],
    ['CUST-009', 'PT Semen Daya Nusantara', '09.012.345.6-009.000', 'Gresik', 'Industri Besar', null, 0],
    ['CUST-010', 'PT Gas Energi Lestari', '10.123.456.7-010.000', 'Tangerang', 'Industri Menengah', null, 0],
    ['CUST-011', 'PT Pupuk Sriwidjaja Utama', '11.234.567.8-011.000', 'Palembang', 'Industri Besar', 'HGBT-01', 1],
    ['CUST-012', 'PT Keramik Garuda Indonesia', '12.345.678.9-012.000', 'Karawang', 'Industri Menengah', 'HGBT-05', 1],
    ['CUST-013', 'PT Oleokimia Kaltim Indah', '13.456.789.0-013.000', 'Bontang', 'Industri Besar', 'HGBT-03', 1],
    ['CUST-014', 'PT Baja Industri Utama', '14.567.890.1-014.000', 'Cikande', 'Industri Besar', 'HGBT-04', 1],
    ['CUST-015', 'PT Kaca Mas Sejahtera', '15.678.901.2-015.000', 'Semarang', 'Industri Menengah', 'HGBT-06', 1],
    ['CUST-016', 'PT Sarung Tangan Rubberindo', '16.789.012.3-016.000', 'Deli Serdang', 'Industri Menengah', 'HGBT-07', 1],
    ['CUST-017', 'PT Pembangkit Energi Listrik', '17.890.123.4-017.000', 'Batam', 'Industri Besar', null, 0],
    ['CUST-018', 'PT Anugerah Gas Prima', '18.901.234.5-018.000', 'Sidoarjo', 'Industri Menengah', null, 0],
  ]);

  // 28 Contracts
  ins('contracts',
    ['id','customer_id','payment_scheme','frequency','fixed_fee','annual_fee','opening_balance','min_qty','allocation','uom','start_date','end_date'], [
    // Customer 1
    ['CTR-001','CUST-001','postpaid','monthly', 500, 0, 0, 0, 8000, 'MMBTU', '2024-01-01', '2026-12-31'],
    ['CTR-001-B','CUST-001','postpaid','monthly', 350, 0, 0, 0, 3500, 'MMBTU', '2025-01-01', '2027-12-31'],
    // Customer 2
    ['CTR-002','CUST-002','hybrid','monthly', 0, 0, 22000, 5200, 6000, 'MMBTU', '2024-01-01', '2026-12-31'],
    ['CTR-002-B','CUST-002','postpaid','monthly', 400, 0, 0, 0, 4200, 'MMBTU', '2025-01-01', '2027-12-31'],
    // Customer 3
    ['CTR-003','CUST-003','postpaid','monthly', 0, 0, 0, 0, 4000, 'MMBTU', '2025-01-01', '2027-12-31'],
    // Customer 4
    ['CTR-004','CUST-004','postpaid','monthly+annual+one-time', 800, 9600, 0, 0, 5000, 'MMBTU', '2025-01-01', '2027-12-31'],
    ['CTR-004-B','CUST-004','postpaid','monthly', 300, 0, 0, 0, 2800, 'MMBTU', '2026-01-01', '2028-12-31'],
    // Customer 5
    ['CTR-005','CUST-005','postpaid','monthly', 0, 0, 0, 0, 3000, 'MMBTU', '2025-06-01', '2027-05-31'],
    // Customer 6
    ['CTR-006','CUST-006','postpaid','monthly', 0, 0, 0, 0, 4500, 'MMBTU', '2019-01-01', '2026-12-31'],
    // Customer 7
    ['CTR-007','CUST-007','postpaid','monthly', 600, 0, 0, 0, 6500, 'MMBTU', '2025-01-01', '2027-12-31'],
    ['CTR-007-B','CUST-007','hybrid','monthly', 0, 0, 15000, 3000, 4000, 'MMBTU', '2026-01-01', '2028-12-31'],
    // Customer 8
    ['CTR-008','CUST-008','postpaid','monthly', 250, 0, 0, 0, 2500, 'MMBTU', '2025-01-01', '2027-12-31'],
    ['CTR-008-B','CUST-008','postpaid','monthly', 200, 0, 0, 0, 1800, 'MMBTU', '2026-01-01', '2028-12-31'],
    // Customer 9
    ['CTR-009','CUST-009','postpaid','monthly', 1200, 0, 0, 0, 12000, 'MMBTU', '2024-01-01', '2026-12-31'],
    // Customer 10
    ['CTR-010','CUST-010','postpaid','monthly', 500, 0, 0, 0, 5000, 'MMBTU', '2025-01-01', '2027-12-31'],
    // Customer 11
    ['CTR-011','CUST-011','postpaid','monthly', 1000, 0, 0, 0, 10000, 'MMBTU', '2025-01-01', '2027-12-31'],
    ['CTR-011-B','CUST-011','hybrid','monthly', 0, 0, 30000, 4000, 5000, 'MMBTU', '2026-01-01', '2028-12-31'],
    // Customer 12
    ['CTR-012','CUST-012','postpaid','monthly', 300, 0, 0, 0, 3200, 'MMBTU', '2025-01-01', '2027-12-31'],
    // Customer 13
    ['CTR-013','CUST-013','hybrid','monthly', 0, 0, 25000, 6000, 7500, 'MMBTU', '2025-01-01', '2027-12-31'],
    // Customer 14
    ['CTR-014','CUST-014','postpaid','monthly', 450, 0, 0, 0, 4800, 'MMBTU', '2025-01-01', '2027-12-31'],
    // Customer 15
    ['CTR-015','CUST-015','postpaid','monthly', 200, 0, 0, 0, 2200, 'MMBTU', '2025-01-01', '2027-12-31'],
    // Customer 16
    ['CTR-016','CUST-016','hybrid','monthly', 0, 0, 12000, 2000, 3000, 'MMBTU', '2025-01-01', '2027-12-31'],
    // Customer 17
    ['CTR-017','CUST-017','postpaid','monthly', 1500, 0, 0, 0, 15000, 'MMBTU', '2024-01-01', '2026-12-31'],
    ['CTR-017-B','CUST-017','postpaid','monthly', 800, 0, 0, 0, 8000, 'MMBTU', '2025-01-01', '2027-12-31'],
    // Customer 18
    ['CTR-018','CUST-018','postpaid','monthly', 400, 0, 0, 0, 4000, 'MMBTU', '2025-01-01', '2027-12-31'],
  ]);

  // Billing Rules
  ins('billing_rules',
    ['id','contract_id','priority','formula_id','price_version_id','effective_from','effective_to'], [
    ['BR-101','CTR-001', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-102','CTR-001', 2,'F-POSTPAID-STD','PV-HGBT-2023','2023-06-01','2026-06-15'],
    ['BR-103','CTR-001', 3,'F-POSTPAID-STD','PV-HGBT-2020','2020-01-20','2023-05-31'],
    ['BR-101-B','CTR-001-B', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-201','CTR-002', 1,'F-HYBRID','PV-HGBT-2026','2026-06-16', null],
    ['BR-202','CTR-002', 2,'F-HYBRID','PV-HGBT-2023','2023-06-01','2026-06-15'],
    ['BR-201-B','CTR-002-B', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-301','CTR-003', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-302','CTR-003', 2,'F-POSTPAID-STD','PV-HGBT-2023','2023-06-01','2026-06-15'],
    ['BR-401','CTR-004', 1,'F-POSTPAID-ANNUAL','PV-HGBT-2026','2026-06-16', null],
    ['BR-401-B','CTR-004-B', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-501','CTR-005', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-601','CTR-006', 1,'F-POSTPAID-STD','PV-HGBT-2016','2016-04-01','2020-01-19'],
    ['BR-602','CTR-006', 1,'F-POSTPAID-STD','PV-HGBT-2020','2020-01-20','2023-05-31'],
    ['BR-603','CTR-006', 1,'F-POSTPAID-STD','PV-HGBT-2023','2023-06-01','2026-06-15'],
    ['BR-604','CTR-006', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-701','CTR-007', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-701-B','CTR-007-B', 1,'F-HYBRID','PV-HGBT-2026','2026-06-16', null],
    ['BR-801','CTR-008', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-801-B','CTR-008-B', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-901','CTR-009', 1,'F-POSTPAID-STD','PV-STD-2026','2026-06-16', null],
    ['BR-1001','CTR-010', 1,'F-POSTPAID-STD','PV-STD-2026','2026-06-16', null],
    ['BR-1101','CTR-011', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-1101-B','CTR-011-B', 1,'F-HYBRID','PV-HGBT-2026','2026-06-16', null],
    ['BR-1201','CTR-012', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-1301','CTR-013', 1,'F-HYBRID','PV-HGBT-2026','2026-06-16', null],
    ['BR-1401','CTR-014', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-1501','CTR-015', 1,'F-POSTPAID-STD','PV-HGBT-2026','2026-06-16', null],
    ['BR-1601','CTR-016', 1,'F-HYBRID','PV-HGBT-2026','2026-06-16', null],
    ['BR-1701','CTR-017', 1,'F-POSTPAID-STD','PV-STD-2026','2026-06-16', null],
    ['BR-1701-B','CTR-017-B', 1,'F-POSTPAID-STD','PV-STD-2026','2026-06-16', null],
    ['BR-1801','CTR-018', 1,'F-POSTPAID-STD','PV-STD-2026','2026-06-16', null],
  ]);

  // Usage records
  const CONV = 0.0364;
  const usages = [
    ['CTR-001','2026-07', 261000,'validated',null, 0, null],
    ['CTR-001-B','2026-07', 105000,'validated',null, 0, null],
    ['CTR-002','2026-07', 152000,'validated',null, 0, null],
    ['CTR-002-B','2026-07', 120000,'validated',null, 0, null],
    ['CTR-003','2026-07', 126400,'validated',null, 0, null],
    ['CTR-004','2026-07', 151600,'validated',null, 350,'Biaya meteran'],
    ['CTR-004-B','2026-07', 85000,'validated',null, 0, null],
    ['CTR-005','2026-07', null,'missing','Belum masuk.', 0, null],
    ['CTR-006','2026-07', 132000,'validated',null, 0, null],
    ['CTR-007','2026-07', 190000,'validated',null, 0, null],
    ['CTR-007-B','2026-07', 115000,'validated',null, 0, null],
    ['CTR-008','2026-07', 72000,'validated',null, 0, null],
    ['CTR-008-B','2026-07', 55000,'validated',null, 0, null],
    ['CTR-009','2026-07', 350000,'validated',null, 500,'Biaya inspeksi'],
    ['CTR-010','2026-07', 145000,'validated',null, 0, null],
    ['CTR-011','2026-07', 280000,'validated',null, 0, null],
    ['CTR-011-B','2026-07', 140000,'validated',null, 0, null],
    ['CTR-012','2026-07', 95000,'validated',null, 0, null],
    ['CTR-013','2026-07', 210000,'validated',null, 0, null],
    ['CTR-014','2026-07', 135000,'validated',null, 0, null],
    ['CTR-015','2026-07', 65000,'validated',null, 0, null],
    ['CTR-016','2026-07', 85000,'validated',null, 0, null],
    ['CTR-017','2026-07', 420000,'validated',null, 0, null],
    ['CTR-017-B','2026-07', 230000,'validated',null, 0, null],
    ['CTR-018','2026-07', 110000,'validated',null, 0, null],

    // Periode 2026-08
    ['CTR-001','2026-08', 255000,'validated',null, 0, null],
    ['CTR-001-B','2026-08', 102000,'validated',null, 0, null],
    ['CTR-002','2026-08', 150000,'validated',null, 0, null],
    ['CTR-007','2026-08', 188000,'validated',null, 0, null],
    ['CTR-011','2026-08', 275000,'validated',null, 0, null],
    ['CTR-013','2026-08', 205000,'validated',null, 0, null],

    // Split period data (Jun 2026)
    ['CTR-001','2026-06|before', 120000,'validated',null, 0, null],
    ['CTR-001','2026-06|after',  125000,'validated',null, 0, null],
    ['CTR-001','2026-06',        245000,'validated',null, 0, null],
  ];
  ins('usage_records',
    ['contract_id','period','raw_m3','status','note','one_time_fee','one_time_label'],
    usages.map(([cid,period,raw,status,note,otf,otl]) => [cid,period,raw,status,note,otf,otl]));
  db.prepare('UPDATE usage_records SET qty_mmbtu = ROUND(raw_m3 * ?, 1) WHERE raw_m3 IS NOT NULL').run(CONV);

  // JISDOR Rates
  ins('jisdor_rates', ['rate_date','idr_per_usd','source'], [
    ['2026-07-01', 16085, 'Bank Indonesia JISDOR'],
    ['2026-07-15', 16120, 'Bank Indonesia JISDOR'],
    ['2026-07-31', 16250, 'Bank Indonesia JISDOR'],
    ['2026-08-01', 16210, 'Bank Indonesia JISDOR'],
    ['2026-06-30', 16050, 'Bank Indonesia JISDOR'],
    ['2026-06-15', 15990, 'Bank Indonesia JISDOR'],
    ['2026-06-01', 15920, 'Bank Indonesia JISDOR'],
  ]);

  // Billing Tickets - 3 DRAFT tickets initially, so user has plenty of fresh contracts for demo!
  const tickets = [
    ['TKT-2026-07-CTR001','CTR-001','2026-07','DRAFT','postpaid'],
    ['TKT-2026-07-CTR002','CTR-002','2026-07','DRAFT','hybrid'],
    ['TKT-2026-07-CTR007','CTR-007','2026-07','DRAFT','postpaid'],
  ];
  ins('billing_tickets',
    ['id','contract_id','period','status','payment_scheme'],
    tickets);
}

migrate();


migrate();

// ─────────────────────────────────────────
//  ADDITIVE SCHEMA MIGRATIONS (G-01)
//  Menambahkan kolom baru ke tabel yang sudah ada tanpa merusak data lama.
//  SQLite tidak mendukung 'ADD COLUMN IF NOT EXISTS' secara langsung,
//  jadi kita gunakan try/catch agar aman dijalankan berulang kali.
// ─────────────────────────────────────────
try { db.exec('ALTER TABLE calculations ADD COLUMN snapshot_rate_eligible REAL'); } catch (_) { /* kolom sudah ada */ }
try { db.exec('ALTER TABLE calculations ADD COLUMN snapshot_rate_excess REAL'); } catch (_) { /* kolom sudah ada */ }

seedIfEmpty();

module.exports = db;
