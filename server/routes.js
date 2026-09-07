// server/routes.js
// REST API untuk PGNCOM Gas Billing — arsitektur baru berbasis Billing Tickets.
// Mendukung imutabilitas INVOICED, Recalculate endpoint, dan Adjustment Ticket Engine (Credit/Debit Notes).

const express = require('express');
const db = require('./db');
const engine = require('./engine');

const router = express.Router();

// ─────────────────────────────────────────
//  LOCKING UTILITY (Kepatuhan Aturan 2)
// ─────────────────────────────────────────
function checkTicketLock(ticketId) {
  if (!ticketId) return false;
  const ticket = db.prepare('SELECT status FROM billing_tickets WHERE id = ?').get(ticketId);
  return ticket && ticket.status === 'INVOICED';
}

function enrichTicket(ticket) {
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(ticket.contract_id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(contract.customer_id);
  const industry = customer.industry_code
    ? db.prepare('SELECT * FROM hgbt_industries WHERE code = ?').get(customer.industry_code)
    : null;
  const latestCalc = db.prepare(
    `SELECT * FROM calculations WHERE ticket_id = ? ORDER BY version DESC LIMIT 1`
  ).get(ticket.id);
  const invoice = latestCalc
    ? db.prepare('SELECT * FROM invoices WHERE calculation_id = ?').get(latestCalc.id)
    : null;
  return { ...ticket, contract, customer, industry, latestCalc, invoice };
}

// ─────────────────────────────────────────
//  1. BILLING TICKETS
// ─────────────────────────────────────────
router.get('/tickets', (req, res) => {
  const rows = db.prepare('SELECT * FROM billing_tickets ORDER BY updated_at DESC').all();
  res.json(rows.map(enrichTicket));
});

router.post('/tickets', (req, res) => {
  const { contractId, period, notes } = req.body;
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
  if (!contract) return res.status(404).json({ error: 'Contract tidak ditemukan' });

  const id = `TKT-${period.replace('-', '')}-${contractId}`;
  const existing = db.prepare('SELECT * FROM billing_tickets WHERE id = ?').get(id);
  if (existing) return res.status(409).json({ error: 'Tiket untuk periode ini sudah ada', existing });

  db.prepare(
    `INSERT INTO billing_tickets (id, contract_id, period, status, payment_scheme, notes)
     VALUES (?,?,?,?,?,?)`
  ).run(id, contractId, period, 'DRAFT', contract.payment_scheme, notes || null);

  res.json(enrichTicket(db.prepare('SELECT * FROM billing_tickets WHERE id = ?').get(id)));
});

router.get('/tickets/:id', (req, res) => {
  const ticket = db.prepare('SELECT * FROM billing_tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Tiket tidak ditemukan' });
  res.json(enrichTicket(ticket));
});

router.patch('/tickets/:id/status', (req, res) => {
  // Lock Check
  if (checkTicketLock(req.params.id)) {
    return res.status(403).json({ error: 'LOCK_ERROR: Tiket sudah INVOICED dan bersifat immutable.' });
  }

  const { status, notes } = req.body;
  const VALID = ['DRAFT','WORKLIST','DECISION','CALCULATED','VALIDATED','APPROVED','INVOICED'];
  if (!VALID.includes(status)) return res.status(400).json({ error: 'Status tidak valid' });

  // G-02: State Machine Guard — tolak transisi mundur yang melanggar lifecycle
  const ticket = db.prepare('SELECT * FROM billing_tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Tiket tidak ditemukan' });

  const FORWARD_ONLY_FROM = ['VALIDATED', 'APPROVED'];
  const BACKWARD_STATES   = ['DRAFT', 'WORKLIST', 'DECISION'];
  if (FORWARD_ONLY_FROM.includes(ticket.status) && BACKWARD_STATES.includes(status)) {
    return res.status(400).json({
      error: `STATE_ERROR: Transisi dari ${ticket.status} → ${status} tidak diperbolehkan. ` +
             `Status sudah melewati tahap validasi dan tidak dapat dikembalikan ke awal. ` +
             `Gunakan endpoint /recalculate untuk membuat versi kalkulasi baru.`,
      currentStatus: ticket.status,
      requestedStatus: status,
    });
  }

  db.prepare(`UPDATE billing_tickets SET status = ?, notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?`)
    .run(status, notes || null, req.params.id);
  const updated = db.prepare('SELECT * FROM billing_tickets WHERE id = ?').get(req.params.id);
  res.json(enrichTicket(updated));
});

// Delete ticket route (locked if INVOICED)
router.delete('/tickets/:id', (req, res) => {
  if (checkTicketLock(req.params.id)) {
    return res.status(403).json({ error: 'LOCK_ERROR: Tiket berstatus INVOICED tidak boleh dihapus.' });
  }
  db.prepare('DELETE FROM billing_tickets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Cleansing processed tickets for demo testing
const doCleansing = (req, res) => {
  try {
    // Drop triggers temporarily to bypass SQLite lock rules during admin reset
    db.exec(`
      DROP TRIGGER IF EXISTS lock_invoiced_tickets_update;
      DROP TRIGGER IF EXISTS lock_invoiced_tickets_status_change;
      DROP TRIGGER IF EXISTS lock_invoiced_tickets_delete;
      DROP TRIGGER IF EXISTS lock_invoiced_calculations_update;
      DROP TRIGGER IF EXISTS lock_invoiced_calculations_delete;
      DROP TRIGGER IF EXISTS lock_invoiced_invoices_update;
      DROP TRIGGER IF EXISTS lock_invoiced_invoices_delete;

      DELETE FROM adjustments;
      DELETE FROM invoices;
      DELETE FROM exceptions_approvals;
      DELETE FROM calculations;
      DELETE FROM billing_runs;
      DELETE FROM billing_tickets;

      INSERT INTO billing_tickets (id, contract_id, period, status, payment_scheme) VALUES ('TKT-2026-07-CTR001','CTR-001','2026-07','DRAFT','postpaid');
      INSERT INTO billing_tickets (id, contract_id, period, status, payment_scheme) VALUES ('TKT-2026-07-CTR002','CTR-002','2026-07','DRAFT','hybrid');
      INSERT INTO billing_tickets (id, contract_id, period, status, payment_scheme) VALUES ('TKT-2026-07-CTR007','CTR-007','2026-07','DRAFT','postpaid');

      -- Re-create immutability triggers
      CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_update
      BEFORE UPDATE ON billing_tickets FOR EACH ROW WHEN OLD.status = 'INVOICED'
      BEGIN SELECT RAISE(ABORT, 'TICKET_LOCKED: Tiket sudah berstatus INVOICED dan tidak dapat diubah.'); END;

      CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_status_change
      BEFORE UPDATE OF status ON billing_tickets FOR EACH ROW WHEN OLD.status = 'INVOICED' AND NEW.status != 'INVOICED'
      BEGIN SELECT RAISE(ABORT, 'TICKET_LOCKED: Status INVOICED adalah permanen.'); END;

      CREATE TRIGGER IF NOT EXISTS lock_invoiced_tickets_delete
      BEFORE DELETE ON billing_tickets FOR EACH ROW WHEN OLD.status = 'INVOICED'
      BEGIN SELECT RAISE(ABORT, 'TICKET_LOCKED: Tiket berstatus INVOICED tidak boleh dihapus.'); END;

      CREATE TRIGGER IF NOT EXISTS lock_invoiced_calculations_update
      BEFORE UPDATE ON calculations FOR EACH ROW WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = NEW.ticket_id AND status = 'INVOICED')
      BEGIN SELECT RAISE(ABORT, 'CALCULATION_LOCKED: Perhitungan permanen terkunci.'); END;

      CREATE TRIGGER IF NOT EXISTS lock_invoiced_calculations_delete
      BEFORE DELETE ON calculations FOR EACH ROW WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = OLD.ticket_id AND status = 'INVOICED')
      BEGIN SELECT RAISE(ABORT, 'CALCULATION_LOCKED: Perhitungan tidak boleh dihapus.'); END;

      CREATE TRIGGER IF NOT EXISTS lock_invoiced_invoices_update
      BEFORE UPDATE ON invoices FOR EACH ROW WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = NEW.ticket_id AND status = 'INVOICED')
      BEGIN SELECT RAISE(ABORT, 'INVOICE_LOCKED: Invoice sudah dirilis dan bersifat immutable.'); END;

      CREATE TRIGGER IF NOT EXISTS lock_invoiced_invoices_delete
      BEFORE DELETE ON invoices FOR EACH ROW WHEN EXISTS (SELECT 1 FROM billing_tickets WHERE id = OLD.ticket_id AND status = 'INVOICED')
      BEGIN SELECT RAISE(ABORT, 'INVOICE_LOCKED: Invoice sudah dirilis dan tidak boleh dihapus.'); END;
    `);

    res.json({ ok: true, message: 'Cleansing tiket berhasil dilakukan.' });
  } catch (e) {
    console.error('doCleansing error:', e);
    res.status(500).json({ error: e.message });
  }
};




router.post('/tickets/cleansing', doCleansing);
router.get('/tickets/cleansing', doCleansing);
router.get('/admin/clean-tickets', doCleansing);
router.post('/admin/clean-tickets', doCleansing);



// ─────────────────────────────────────────
//  2. RECALCULATE ENDPOINT (Kepatuhan Aturan 2 - Status Validated/Approved)
// ─────────────────────────────────────────
router.post('/tickets/:id/recalculate', (req, res) => {
  const ticketId = req.params.id;
  const ticket = db.prepare('SELECT * FROM billing_tickets WHERE id = ?').get(ticketId);
  if (!ticket) return res.status(404).json({ error: 'Tiket tidak ditemukan' });

  if (ticket.status === 'INVOICED') {
    return res.status(403).json({ error: 'LOCK_ERROR: Tiket berstatus INVOICED terkunci permanen.' });
  }

  // Boleh re-calculate untuk Draft, Worklist, Decision, Calculated, Validated, Approved
  const result = engine.computeForContractPeriod(ticket.contract_id, ticket.period, req.body.jisdorDate);
  if (result.blocked) {
    return res.status(409).json({ blocked: true, reason: result.reason });
  }

  const run = db.prepare('INSERT INTO billing_runs (ticket_id, contract_id, period) VALUES (?,?,?)').run(ticketId, ticket.contract_id, ticket.period);
  const versionRow = db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM calculations WHERE ticket_id = ?').get(ticketId);
  const version = versionRow.v + 1; // Increment version v1 -> v2 -> dst.

  const annualProrated = (result.contract.annual_fee || 0) / 12;
  const ppnAmount = result.idrConversion ? result.idrConversion.ppnAmount : null;
  const totalIdr  = result.idrConversion ? result.idrConversion.totalIdr  : null;

  const trace = {
    ruleRes: result.ruleRes,
    // G-06: Sertakan ruleOld untuk prorated period agar audit trail lengkap
    ruleOld: result.ruleOld || null,
    ruleNew: result.ruleNew || null,
    priceVersion: result.priceVersion,
    formula: result.formula,
    ctx: result.ctx,
    hgbtCheck: result.hgbtCheck,
    jisdorRec: result.jisdorRec,
    idrConversion: result.idrConversion,
    prorationDetails: result.prorationDetails || null
  };

  const insert = db.prepare(`
    INSERT INTO calculations
      (run_id, ticket_id, contract_id, period, version, rule_id, price_version_id, formula_id,
       eligible_qty, excess_qty, fixed_fee, annual_fee_prorated, one_time_fee, total_usd,
       hgbt_cap, triggered_by,
       jisdor_date, jisdor_rate, ppn_rate, ppn_amount, total_idr,
       hgbt_validated, hgbt_warning, snapshot_rate_eligible, snapshot_rate_excess,
       status, trace_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    run.lastInsertRowid, ticketId, ticket.contract_id, ticket.period, version,
    result.ruleRes.selected.id, result.priceVersion.id, result.formula.id,
    result.eligible, result.excess,
    result.contract.fixed_fee || 0,
    annualProrated,
    result.usage.one_time_fee || 0,
    result.totalUsd,
    engine.HGBT_CAP_USD,
    req.body.userId || 'maker',
    result.jisdorRec ? result.jisdorRec.rate_date : null,
    result.jisdorRec ? result.jisdorRec.idr_per_usd : null,
    engine.PPN_RATE,
    ppnAmount, totalIdr,
    result.hgbtCheck.valid ? 1 : 0,
    result.hgbtCheck.warning || null,
    // G-01: Bekukan tarif yang berlaku saat ini ke dalam snapshot
    result.priceVersion?.rate_eligible ?? null,
    result.priceVersion?.rate_excess ?? null,
    'draft',
    JSON.stringify(trace)
  );

  // Ubah kembali status tiket ke CALCULATED agar divalidasi ulang
  db.prepare(`UPDATE billing_tickets SET status = 'CALCULATED', updated_at = datetime('now') WHERE id = ?`).run(ticketId);

  res.json({ ok: true, version, calculationId: insert.lastInsertRowid });
});

// ─────────────────────────────────────────
//  3. RETROACTIVE ADJUSTMENT ENGINE (Kepatuhan Aturan 3)
// ─────────────────────────────────────────
/**
 * POST /tickets/:id/adjust
 * Jika ada revisi harga pemerintah secara mundur ke belakang untuk tiket yang sudah INVOICED,
 * endpoint ini akan:
 * 1. Mendeteksi tarif lama vs tarif baru yang direvisi.
 * 2. Menghitung selisih delta.
 * 3. Menerbitkan Tiket Penyesuaian (Adjustment Ticket) tipe Credit Note / Debit Note.
 */
router.post('/tickets/:id/adjust', (req, res) => {
  const originalTicketId = req.params.id;
  const originalTicket = db.prepare('SELECT * FROM billing_tickets WHERE id = ?').get(originalTicketId);
  if (!originalTicket) return res.status(404).json({ error: 'Original ticket tidak ditemukan.' });

  if (originalTicket.status !== 'INVOICED') {
    return res.status(400).json({ error: 'ADJUST_ERROR: Tiket belum berstatus INVOICED.' });
  }

  // Dapatkan invoice original
  const origCalc = db.prepare("SELECT * FROM calculations WHERE ticket_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1").get(originalTicketId);
  if (!origCalc) return res.status(400).json({ error: 'ADJUST_ERROR: Approved calculation tidak ditemukan untuk tiket asal.' });
  const origInvoice = db.prepare('SELECT * FROM invoices WHERE calculation_id = ?').get(origCalc.id);
  if (!origInvoice) return res.status(400).json({ error: 'ADJUST_ERROR: Invoice asal belum diterbitkan.' });

  // Ambil input rate_eligible_new / price_version_id_new untuk retro-simulation
  const { newPriceVersionId, reason, userId } = req.body;
  if (!newPriceVersionId) return res.status(400).json({ error: 'Pilih price version baru untuk penyesuaian.' });

  // Simulasikan perhitungan dengan price version baru
  // Ubah sementara rate rule atau bypass resolution untuk kalkulasi ini
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(originalTicket.contract_id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(contract.customer_id);
  const usage = engine.getUsage(originalTicket.contract_id, originalTicket.period);

  if (!usage) return res.status(400).json({ error: 'Data usage tidak ditemukan.' });

  const pvNew = db.prepare('SELECT * FROM price_versions WHERE id = ?').get(newPriceVersionId);
  if (!pvNew) return res.status(404).json({ error: 'Price version baru tidak terdaftar.' });

  // Lolos validasi HGBT
  const hgbtCheck = engine.validateHgbtCap(pvNew.rate_eligible, customer.is_hgbt === 1);

  // Standar splitting
  const { eligible, excess } = engine.splitAllocation(usage.qty_mmbtu, contract.allocation);

  const ctx = {
    fixedFee: contract.fixed_fee || 0,
    eligible,
    excess,
    rateEligible: pvNew.rate_eligible,
    rateExcess: pvNew.rate_excess,
    actualQty: usage.qty_mmbtu,
    minQty: contract.min_qty || 0,
    annualFee: contract.annual_fee || 0,
    oneTimeFee: usage.one_time_fee || 0,
    prepaidBalance: contract.opening_balance || 0
  };

  const newTotalUsd = engine.runFormula(origCalc.formula_id, ctx);
  const deltaUsd = newTotalUsd - origCalc.total_usd;

  const adjType = deltaUsd >= 0 ? 'debit' : 'credit';

  // Buat Tiket Penyesuaian Baru (Adjustment Ticket)
  const adjTicketId = `ADJ-${originalTicketId}-${Date.now().toString().slice(-4)}`;
  db.prepare(`
    INSERT INTO billing_tickets (id, contract_id, period, status, payment_scheme, notes, parent_ticket_id)
    VALUES (?, ?, ?, 'APPROVED', ?, ?, ?)
  `).run(
    adjTicketId, originalTicket.contract_id, originalTicket.period, originalTicket.payment_scheme,
    reason || `Adjustment retro untuk tiket ${originalTicketId} (${adjType.toUpperCase()})`,
    originalTicketId
  );

  // Buat calculation record pendamping untuk adjustment ini
  const run = db.prepare('INSERT INTO billing_runs (ticket_id, contract_id, period) VALUES (?,?,?)').run(adjTicketId, originalTicket.contract_id, originalTicket.period);
  const jisdorRec = engine.getJisdorRate(origCalc.jisdor_date || originalTicket.period + '-15');
  const idrConv = jisdorRec ? engine.convertToIdr(Math.abs(deltaUsd), jisdorRec.idr_per_usd) : null;

  const insertCalc = db.prepare(`
    INSERT INTO calculations
      (run_id, ticket_id, contract_id, period, version, rule_id, price_version_id, formula_id,
       eligible_qty, excess_qty, fixed_fee, annual_fee_prorated, one_time_fee, total_usd,
       hgbt_cap, triggered_by, jisdor_date, jisdor_rate, ppn_rate, ppn_amount, total_idr,
       hgbt_validated, snapshot_rate_eligible, snapshot_rate_excess, status, trace_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    run.lastInsertRowid, adjTicketId, originalTicket.contract_id, originalTicket.period, 1,
    origCalc.rule_id, newPriceVersionId, origCalc.formula_id,
    eligible, excess, 0, 0, 0, deltaUsd,
    engine.HGBT_CAP_USD, userId || 'maker',
    jisdorRec ? jisdorRec.rate_date : null,
    jisdorRec ? jisdorRec.idr_per_usd : null,
    engine.PPN_RATE,
    idrConv ? idrConv.ppnAmount : null,
    idrConv ? idrConv.totalIdr : null,
    hgbtCheck.valid ? 1 : 0,
    // G-01: Bekukan tarif baru ke dalam snapshot adjustment
    pvNew.rate_eligible,
    pvNew.rate_excess,
    'approved',
    JSON.stringify({ note: 'Retroactive recalculation result', pvNew, newTotalUsd, origTotalUsd: origCalc.total_usd })
  );

  // Catat Penyesuaian (Credit/Debit note)
  db.prepare(`
    INSERT INTO adjustments (original_invoice_id, new_calculation_id, delta, adjustment_type, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(origInvoice.id, insertCalc.lastInsertRowid, deltaUsd, adjType, reason);

  // G-05 FIX: Terbitkan Invoice Penyesuaian dengan invoice_amount = |delta|, remaining_balance = NULL
  const adjInvoiceId = `INV-${adjTicketId}-v1`;
  db.prepare(`
    INSERT INTO invoices (id, ticket_id, calculation_id, contract_id, period, status,
      invoice_amount, balance_applied, remaining_balance, jisdor_date, jisdor_rate, ppn_rate, ppn_amount, total_idr)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)
  `).run(
    adjInvoiceId, adjTicketId, insertCalc.lastInsertRowid, originalTicket.contract_id, originalTicket.period, 'issued',
    Math.abs(deltaUsd),                          // invoice_amount = nilai absolut delta (bukan 0)
    jisdorRec ? jisdorRec.rate_date : null,
    jisdorRec ? jisdorRec.idr_per_usd : null,
    engine.PPN_RATE,
    idrConv ? idrConv.ppnAmount : null,
    idrConv ? idrConv.totalIdr : null
  );

  // Kunci status tiket adjustment menjadi INVOICED
  db.prepare("UPDATE billing_tickets SET status = 'INVOICED', updated_at = datetime('now') WHERE id = ?").run(adjTicketId);

  res.json({
    ok: true,
    adjustmentTicketId: adjTicketId,
    adjustmentInvoiceId: adjInvoiceId,
    adjustmentType: adjType,
    deltaUsd,
    deltaIdr: idrConv ? idrConv.totalIdr : 0
  });
});

// ─────────────────────────────────────────
//  4. WORKLIST (Context per Ticket)
// ─────────────────────────────────────────
router.get('/worklist/:contractId/:period', (req, res) => {
  const { contractId, period } = req.params;
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(contract.customer_id);
  const industry = customer.industry_code ? db.prepare('SELECT * FROM hgbt_industries WHERE code = ?').get(customer.industry_code) : null;
  const usage = engine.getUsage(contractId, period);
  const before = engine.getUsage(contractId, period + '|before');
  const after  = engine.getUsage(contractId, period + '|after');
  res.json({ contract, customer, industry, usage: usage || null, before: before || null, after: after || null });
});

router.post('/worklist/:contractId/:period/resolve', (req, res) => {
  const { contractId, period } = req.params;
  const fallbackQty = req.body.qtyMmbtu || 2600;
  db.prepare(
    `UPDATE usage_records SET status = 'validated', qty_mmbtu = ?, note = 'Dikonfirmasi oleh data owner (manual correction).' WHERE contract_id = ? AND period = ?`
  ).run(fallbackQty, contractId, period);
  res.json({ ok: true });
});

// ─────────────────────────────────────────
//  5. DECISION & PRICE RESOLUTION
// ─────────────────────────────────────────
router.get('/decision/:contractId/:period', (req, res) => {
  const { contractId, period } = req.params;
  const date = period.length === 7 ? period + '-15' : period;
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(contract.customer_id);
  const ruleRes = engine.resolveRule(contractId, date);

  let priceVersion = null;
  let formula = null;
  let regCheck = null;
  let hgbtCheck = null;

  if (ruleRes.selected) {
    priceVersion = db.prepare('SELECT * FROM price_versions WHERE id = ?').get(ruleRes.selected.price_version_id);
    formula = db.prepare('SELECT * FROM formulas WHERE id = ?').get(ruleRes.selected.formula_id);
    regCheck = engine.checkRegulationStatus(priceVersion.regulation_id);
    hgbtCheck = engine.validateHgbtCap(priceVersion.rate_eligible, customer.is_hgbt === 1);
  }

  const allFormulas = db.prepare('SELECT * FROM formulas').all();
  const allRegs = db.prepare('SELECT * FROM regulations').all();
  const allPriceVersions = db.prepare('SELECT * FROM price_versions').all();

  res.json({ ruleRes, priceVersion, formula, regCheck, hgbtCheck, customer, allFormulas, allRegs, allPriceVersions });
});


router.get('/decision-split/:contractId', (req, res) => {
  const { contractId } = req.params;
  const dateBefore = req.query.before || '2026-06-10';
  const dateAfter  = req.query.after  || '2026-06-22';
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(contract.customer_id);
  const rBefore = engine.resolveRule(contractId, dateBefore);
  const rAfter  = engine.resolveRule(contractId, dateAfter);

  const pvBefore = rBefore.selected ? db.prepare('SELECT * FROM price_versions WHERE id = ?').get(rBefore.selected.price_version_id) : null;
  const pvAfter  = rAfter.selected  ? db.prepare('SELECT * FROM price_versions WHERE id = ?').get(rAfter.selected.price_version_id)  : null;

  res.json({
    before: { ruleRes: rBefore, priceVersion: pvBefore, hgbtCheck: pvBefore ? engine.validateHgbtCap(pvBefore.rate_eligible, customer.is_hgbt === 1) : null },
    after:  { ruleRes: rAfter,  priceVersion: pvAfter,  hgbtCheck: pvAfter  ? engine.validateHgbtCap(pvAfter.rate_eligible,  customer.is_hgbt === 1) : null },
  });
});

router.post('/decision/activate-replacement', (req, res) => {
  res.json({ ok: true, activatedRuleId: 'BR-602', note: 'Replacement mapping (Permen ESDM 15/2022) diaktifkan.' });
});


// ─────────────────────────────────────────
//  6. CALCULATION
// ─────────────────────────────────────────
router.post('/calculate', (req, res) => {
  const { contractId, period, ticketId, jisdorDate, userId, oneTimeFee, manualJisdorRate } = req.body;

  // Lock Check
  if (checkTicketLock(ticketId)) {
    return res.status(403).json({ error: 'LOCK_ERROR: Tiket sudah INVOICED dan bersifat immutable.' });
  }

  const result = engine.computeForContractPeriod(contractId, period, jisdorDate);

  if (result.blocked) {
    return res.status(409).json({ blocked: true, reason: result.reason });
  }

  // Override manual oneTimeFee if provided
  if (oneTimeFee !== undefined && oneTimeFee !== null && oneTimeFee !== '') {
    const otf = Number(oneTimeFee);
    result.ctx.oneTimeFee = otf;
    if (result.usage) {
      result.usage.one_time_fee = otf;
    }
    // Re-run formula to update totalUsd
    result.totalUsd = engine.runFormula(result.ruleRes.selected?.formula_id || 'F-POSTPAID-STD', result.ctx);
    result.total = result.totalUsd;
  }

  // Override manual JISDOR rate if provided
  if (manualJisdorRate !== undefined && manualJisdorRate !== null && manualJisdorRate !== '') {
    const rateVal = Number(manualJisdorRate);
    result.jisdorRec = { rate_date: jisdorDate || 'Manual', idr_per_usd: rateVal, source: 'Manual Override' };
    result.idrConversion = engine.convertToIdr(result.totalUsd, rateVal);
  }

  const run = db.prepare('INSERT INTO billing_runs (ticket_id, contract_id, period) VALUES (?,?,?)').run(ticketId || null, contractId, period);
  const versionRow = db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM calculations WHERE ticket_id = ?').get(ticketId || '');
  const version = versionRow.v + 1;

  const annualProrated = (result.contract.annual_fee || 0) / 12;
  const ppnAmount = result.idrConversion ? result.idrConversion.ppnAmount : null;
  const totalIdr  = result.idrConversion ? result.idrConversion.totalIdr  : null;

  const trace = {
    ruleRes: result.ruleRes,
    // G-06: Sertakan ruleOld untuk prorated period agar audit trail lengkap
    ruleOld: result.ruleOld || null,
    ruleNew: result.ruleNew || null,
    priceVersion: result.priceVersion,
    formula: result.formula,
    ctx: result.ctx,
    hgbtCheck: result.hgbtCheck,
    jisdorRec: result.jisdorRec,
    idrConversion: result.idrConversion,
    prorationDetails: result.prorationDetails || null
  };

  const insert = db.prepare(`
    INSERT INTO calculations
      (run_id, ticket_id, contract_id, period, version, rule_id, price_version_id, formula_id,
       eligible_qty, excess_qty, fixed_fee, annual_fee_prorated, one_time_fee, total_usd,
       hgbt_cap, triggered_by,
       jisdor_date, jisdor_rate, ppn_rate, ppn_amount, total_idr,
       hgbt_validated, hgbt_warning, snapshot_rate_eligible, snapshot_rate_excess,
       status, trace_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    run.lastInsertRowid, ticketId || null, contractId, period, version,
    result.ruleRes.selected?.id || null, result.priceVersion?.id || null, result.formula?.id || null,
    result.eligible, result.excess,
    result.contract.fixed_fee || 0,
    annualProrated,
    result.usage?.one_time_fee || 0,
    result.totalUsd,
    engine.HGBT_CAP_USD,
    userId || 'maker',
    result.jisdorRec ? result.jisdorRec.rate_date : null,
    result.jisdorRec ? result.jisdorRec.idr_per_usd : null,
    engine.PPN_RATE,
    ppnAmount, totalIdr,
    result.hgbtCheck?.valid ? 1 : 0,
    result.hgbtCheck?.warning || null,
    // G-01: Bekukan tarif yang berlaku saat kalkulasi berjalan
    result.priceVersion?.rate_eligible ?? null,
    result.priceVersion?.rate_excess ?? null,
    'draft',
    JSON.stringify(trace)
  );

  if (ticketId) {
    db.prepare(`UPDATE billing_tickets SET status = 'CALCULATED', updated_at = datetime('now') WHERE id = ?`).run(ticketId);
  }

  const calculation = db.prepare('SELECT * FROM calculations WHERE id = ?').get(insert.lastInsertRowid);
  res.json({ calculation, trace, priceVersion: result.priceVersion, formula: result.formula, usage: result.usage, hgbtCheck: result.hgbtCheck, jisdorRec: result.jisdorRec, idrConversion: result.idrConversion });
});

// Standar / Legacy split
router.post('/calculate-split', (req, res) => {
  const { contractId, period, ticketId } = req.body;
  if (checkTicketLock(ticketId)) {
    return res.status(403).json({ error: 'LOCK_ERROR: Tiket sudah INVOICED.' });
  }

  // Menyerahkan langsung ke engine proration
  const result = engine.computeForContractPeriod(contractId, period);
  if (result.blocked) return res.status(409).json({ blocked: true, reason: result.reason });

  const run = db.prepare('INSERT INTO billing_runs (ticket_id, contract_id, period) VALUES (?,?,?)').run(ticketId || null, contractId, period);
  const versionRow = db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM calculations WHERE ticket_id = ?').get(ticketId || '');
  const version = versionRow.v + 1;

  const ppnAmount = result.idrConversion ? result.idrConversion.ppnAmount : null;
  const totalIdr  = result.idrConversion ? result.idrConversion.totalIdr  : null;

  const insert = db.prepare(`
    INSERT INTO calculations (run_id, ticket_id, contract_id, period, version, rule_id, price_version_id, formula_id, eligible_qty, excess_qty, fixed_fee, annual_fee_prorated, one_time_fee, total_usd, hgbt_cap, triggered_by, jisdor_date, jisdor_rate, ppn_rate, ppn_amount, total_idr, snapshot_rate_eligible, snapshot_rate_excess, status, trace_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    run.lastInsertRowid, ticketId || null, contractId, period, version,
    result.ruleRes.selected.id, result.priceVersion.id, result.formula.id,
    result.eligible, result.excess,
    result.contract.fixed_fee, 0, 0, result.totalUsd,
    engine.HGBT_CAP_USD, 'maker',
    result.jisdorRec ? result.jisdorRec.rate_date : null,
    result.jisdorRec ? result.jisdorRec.idr_per_usd : null,
    engine.PPN_RATE, ppnAmount, totalIdr,
    // G-01: Snapshot tarif untuk /calculate-split
    result.priceVersion?.rate_eligible ?? null,
    result.priceVersion?.rate_excess ?? null,
    'draft',
    JSON.stringify(result.prorationDetails || result.ctx)
  );

  if (ticketId) {
    db.prepare(`UPDATE billing_tickets SET status = 'CALCULATED', updated_at = datetime('now') WHERE id = ?`).run(ticketId);
  }

  const calculation = db.prepare('SELECT * FROM calculations WHERE id = ?').get(insert.lastInsertRowid);
  res.json({
    calculation,
    before: { priceVersion: result.pvOld, split: result.prorationDetails?.splitOld, total: result.prorationDetails?.subTotalOld },
    after: { priceVersion: result.pvNew, split: result.prorationDetails?.splitNew, total: result.prorationDetails?.subTotalNew },
    grandTotal: result.totalUsd,
    jisdorRec: result.jisdorRec,
    idrConversion: result.idrConversion
  });
});

// Recalculation simulation
router.get('/simulate-recalc/:contractId/:period', (req, res) => {
  const { contractId, period } = req.params;
  const result = engine.computeForContractPeriod(contractId, period);
  const prior = engine.getPriorApprovedCalculation(contractId, period);
  const delta = prior ? result.totalUsd - (prior.total_usd || prior.total) : null;
  res.json({ newTotal: result.totalUsd, newPriceVersionId: result.priceVersion.id, prior, delta, hgbtCheck: result.hgbtCheck });
});

// Payment compare
router.get('/payment-compare/:contractId/:period', (req, res) => {
  const { contractId, period } = req.params;
  const result = engine.computeForContractPeriod(contractId, period);
  if (result.blocked) return res.status(409).json({ blocked: true, reason: result.reason });
  const scenarios = ['postpaid', 'hybrid', 'prepaid'].map((scheme) => {
    const fakeContract = { ...result.contract, payment_scheme: scheme,
      opening_balance: scheme === 'postpaid' ? 0 : scheme === 'prepaid' ? 18000 : 22000 };
    const r = engine.applyPaymentScheme(fakeContract, result.totalUsd);
    return { scheme, ...r };
  });
  res.json({ total: result.totalUsd, scenarios });
});

// ─────────────────────────────────────────
//  7. VALIDATION & APPROVAL
// ─────────────────────────────────────────
router.post('/validate', (req, res) => {
  const { calculationId } = req.body;
  const calc = db.prepare('SELECT * FROM calculations WHERE id = ?').get(calculationId);
  if (!calc) return res.status(404).json({ error: 'Calculation tidak ditemukan' });

  // Lock Check
  if (checkTicketLock(calc.ticket_id)) {
    return res.status(403).json({ error: 'LOCK_ERROR: Tiket sudah INVOICED.' });
  }

  const prior = engine.getPriorApprovedCalculation(calc.contract_id, calc.period);
  const v = engine.validateVariance(calc.total_usd || calc.total, prior ? (prior.total_usd || prior.total) : null);

  const severity = v.status === 'warning' ? 'warning' : 'none';
  const exType   = v.status === 'warning' ? 'variance' : 'none';

  const existing = db.prepare('SELECT * FROM exceptions_approvals WHERE calculation_id = ?').get(calculationId);
  if (existing) {
    db.prepare('UPDATE exceptions_approvals SET exception_type=?, severity=?, variance_pct=? WHERE calculation_id=?')
      .run(exType, severity, v.variance, calculationId);
  } else {
    db.prepare('INSERT INTO exceptions_approvals (calculation_id, exception_type, severity, variance_pct, decision) VALUES (?,?,?,?,?)')
      .run(calculationId, exType, severity, v.variance, severity === 'warning' ? 'pending' : 'approved');
  }

  if (calc.ticket_id) {
    db.prepare(`UPDATE billing_tickets SET status = 'VALIDATED', updated_at = datetime('now') WHERE id = ?`).run(calc.ticket_id);
  }

  const row = db.prepare('SELECT * FROM exceptions_approvals WHERE calculation_id = ?').get(calculationId);
  res.json({ validation: v, priorTotal: prior ? (prior.total_usd || prior.total) : null, exception: row });
});

router.post('/approve', (req, res) => {
  const { calculationId, approverNote, approver } = req.body;
  const calc = db.prepare('SELECT * FROM calculations WHERE id = ?').get(calculationId);
  if (!calc) return res.status(404).json({ error: 'Calculation tidak ditemukan' });

  // Lock Check
  if (checkTicketLock(calc.ticket_id)) {
    return res.status(403).json({ error: 'LOCK_ERROR: Tiket sudah INVOICED.' });
  }

  const exRow = db.prepare('SELECT * FROM exceptions_approvals WHERE calculation_id = ?').get(calculationId);
  if (exRow) {
    db.prepare(`UPDATE exceptions_approvals SET decision = 'approved', approver = ?, approver_note = ?, decided_at = datetime('now') WHERE calculation_id = ?`)
      .run(approver || 'Checker', approverNote || null, calculationId);
  }
  db.prepare(`UPDATE calculations SET status = 'approved' WHERE id = ?`).run(calculationId);

  if (calc.ticket_id) {
    db.prepare(`UPDATE billing_tickets SET status = 'APPROVED', updated_at = datetime('now') WHERE id = ?`).run(calc.ticket_id);
  }
  res.json({ ok: true, calculation: db.prepare('SELECT * FROM calculations WHERE id = ?').get(calculationId) });
});

// ─────────────────────────────────────────
//  8. INVOICE eDoc
// ─────────────────────────────────────────
router.post('/invoice', (req, res) => {
  const { calculationId, jisdorDate } = req.body;
  const calc = db.prepare('SELECT * FROM calculations WHERE id = ?').get(calculationId);
  if (!calc) return res.status(404).json({ error: 'Calculation tidak ditemukan' });

  // Lock Check
  if (checkTicketLock(calc.ticket_id)) {
    return res.status(403).json({ error: 'LOCK_ERROR: Tiket sudah INVOICED.' });
  }

  if (calc.status !== 'approved') {
    return res.status(409).json({ error: 'Invoice hanya dapat dibuat dari calculation yang sudah approved.' });
  }
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(calc.contract_id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(contract.customer_id);
  const industry = customer.industry_code ? db.prepare('SELECT * FROM hgbt_industries WHERE code = ?').get(customer.industry_code) : null;
  const ps = engine.applyPaymentScheme(contract, calc.total_usd || calc.total);

  const jDate = jisdorDate || calc.jisdor_date || new Date().toISOString().slice(0, 10);
  const jisdorRec = engine.getJisdorRate(jDate);
  const totalUsd = ps.invoiceAmount;
  const idrConv = jisdorRec ? engine.convertToIdr(totalUsd, jisdorRec.idr_per_usd) : null;

  const invoiceId = `INV-${calc.period.replace('-','')}-${calc.contract_id}-v${calc.version}`;
  const existing = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!existing) {
    db.prepare(`
      INSERT INTO invoices (id, ticket_id, calculation_id, contract_id, period, status,
        invoice_amount, balance_applied, remaining_balance,
        jisdor_date, jisdor_rate, ppn_rate, ppn_amount, total_idr, version)
      VALUES (?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      invoiceId, calc.ticket_id, calculationId, calc.contract_id, calc.period,
      ps.invoiceAmount, ps.balanceApplied, ps.remainingBalance,
      jisdorRec ? jisdorRec.rate_date : null,
      jisdorRec ? jisdorRec.idr_per_usd : null,
      engine.PPN_RATE,
      idrConv ? idrConv.ppnAmount : null,
      idrConv ? idrConv.totalIdr : null,
      calc.version
    );
  }

  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  const priceVersion = db.prepare('SELECT * FROM price_versions WHERE id = ?').get(calc.price_version_id);
  const formula = db.prepare('SELECT * FROM formulas WHERE id = ?').get(calc.formula_id);

  if (calc.ticket_id) {
    db.prepare(`UPDATE billing_tickets SET status = 'INVOICED', updated_at = datetime('now') WHERE id = ?`).run(calc.ticket_id);
  }

  res.json({ invoice, calculation: calc, contract, customer, industry, priceVersion, formula, paymentScheme: ps, jisdorRec, idrConversion: idrConv });
});

// ─────────────────────────────────────────
//  9. ADJUSTMENT
// ─────────────────────────────────────────
// G-04: Validasi bahwa invoice asal memiliki tiket berstatus INVOICED
router.post('/adjustment', (req, res) => {
  const { originalInvoiceId, newCalculationId, reason } = req.body;
  const originalInvoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(originalInvoiceId);
  if (!originalInvoice) return res.status(404).json({ error: 'Invoice asal tidak ditemukan.' });

  // G-04 FIX: Pastikan invoice terkait dengan tiket yang sudah INVOICED
  if (originalInvoice.ticket_id) {
    const parentTicket = db.prepare('SELECT status FROM billing_tickets WHERE id = ?').get(originalInvoice.ticket_id);
    if (!parentTicket || parentTicket.status !== 'INVOICED') {
      return res.status(400).json({
        error: 'ADJUST_ERROR: Adjustment hanya diperbolehkan untuk invoice yang berasal dari tiket berstatus INVOICED.',
        ticketStatus: parentTicket?.status || 'not found',
      });
    }
  }

  const newCalc = db.prepare('SELECT * FROM calculations WHERE id = ?').get(newCalculationId);
  if (!newCalc) return res.status(404).json({ error: 'Calculation baru tidak ditemukan.' });
  const delta = (newCalc.total_usd || newCalc.total) - originalInvoice.invoice_amount;
  const adjustmentType = delta >= 0 ? 'debit' : 'credit';

  const insert = db.prepare(`INSERT INTO adjustments (original_invoice_id, new_calculation_id, delta, adjustment_type, reason) VALUES (?, ?, ?, ?, ?)`)
    .run(originalInvoiceId, newCalculationId, delta, adjustmentType, reason || null);
  const adjustment = db.prepare('SELECT * FROM adjustments WHERE id = ?').get(insert.lastInsertRowid);
  res.json({ adjustment, originalInvoice, newCalc });
});

// ─────────────────────────────────────────
//  10. TRACE
// ─────────────────────────────────────────
router.get('/trace/:calculationId', (req, res) => {
  const calc = db.prepare('SELECT * FROM calculations WHERE id = ?').get(req.params.calculationId);
  if (!calc) return res.status(404).json({ error: 'Calculation tidak ditemukan' });
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(calc.contract_id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(contract.customer_id);
  const priceVersion = db.prepare('SELECT * FROM price_versions WHERE id = ?').get(calc.price_version_id);
  const regulation = priceVersion ? db.prepare('SELECT * FROM regulations WHERE id = ?').get(priceVersion.regulation_id) : null;
  const formula = db.prepare('SELECT * FROM formulas WHERE id = ?').get(calc.formula_id);
  const rule = db.prepare('SELECT * FROM billing_rules WHERE id = ?').get(calc.rule_id);
  const rejectedRules = rule ? db.prepare('SELECT * FROM billing_rules WHERE contract_id = ? AND id != ?').all(calc.contract_id, rule.id) : [];
  const exception = db.prepare('SELECT * FROM exceptions_approvals WHERE calculation_id = ?').get(calc.id);
  res.json({ calc, contract, customer, priceVersion, regulation, formula, rule, rejectedRules, exception, trace: calc.trace_json ? JSON.parse(calc.trace_json) : null });
});

// ─────────────────────────────────────────
//  11. JISDOR
// ─────────────────────────────────────────
router.get('/jisdor', (req, res) => {
  const rows = db.prepare('SELECT * FROM jisdor_rates ORDER BY rate_date DESC').all();
  res.json(rows);
});

router.get('/jisdor/:date', (req, res) => {
  const rec = engine.getJisdorRate(req.params.date);
  if (!rec) return res.status(404).json({ error: 'Data JISDOR tidak tersedia untuk tanggal ini' });
  res.json(rec);
});

// ─────────────────────────────────────────
//  12. REGULATIONS (read + CRUD)
// ─────────────────────────────────────────
router.get('/regulations', (req, res) => {
  const regs = db.prepare('SELECT * FROM regulations ORDER BY effective_from ASC').all();
  const enriched = regs.map(r => ({
    ...r,
    priceVersions: db.prepare('SELECT * FROM price_versions WHERE regulation_id = ?').all(r.id),
  }));
  res.json(enriched);
});

router.post('/regulations', (req, res) => {
  const { id, type, number, name, status, effective_from, effective_to, revoked_by, parent_id, hgbt_cap, notes } = req.body;
  if (!id || !type || !name || !status || !effective_from) {
    return res.status(400).json({ error: 'Field wajib: id, type, name, status, effective_from' });
  }
  const existing = db.prepare('SELECT id FROM regulations WHERE id = ?').get(id);
  if (existing) return res.status(409).json({ error: 'ID regulasi sudah ada.' });
  db.prepare(`INSERT INTO regulations (id, type, number, name, status, effective_from, effective_to, revoked_by, parent_id, hgbt_cap, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, type, number||null, name, status, effective_from, effective_to||null, revoked_by||null, parent_id||null, hgbt_cap||null, notes||null);
  res.json(db.prepare('SELECT * FROM regulations WHERE id = ?').get(id));
});

router.patch('/regulations/:id', (req, res) => {
  const reg = db.prepare('SELECT * FROM regulations WHERE id = ?').get(req.params.id);
  if (!reg) return res.status(404).json({ error: 'Regulasi tidak ditemukan.' });
  const { type, number, name, status, effective_from, effective_to, revoked_by, parent_id, hgbt_cap, notes } = req.body;
  db.prepare(`UPDATE regulations SET type=COALESCE(?,type), number=COALESCE(?,number), name=COALESCE(?,name),
    status=COALESCE(?,status), effective_from=COALESCE(?,effective_from), effective_to=?,
    revoked_by=?, parent_id=?, hgbt_cap=?, notes=? WHERE id=?`)
    .run(type||null, number||null, name||null, status||null, effective_from||null,
      effective_to!==undefined?effective_to:reg.effective_to,
      revoked_by!==undefined?revoked_by:reg.revoked_by,
      parent_id!==undefined?parent_id:reg.parent_id,
      hgbt_cap!==undefined?hgbt_cap:reg.hgbt_cap,
      notes!==undefined?notes:reg.notes,
      req.params.id);
  res.json(db.prepare('SELECT * FROM regulations WHERE id = ?').get(req.params.id));
});

router.delete('/regulations/:id', (req, res) => {
  const reg = db.prepare('SELECT * FROM regulations WHERE id = ?').get(req.params.id);
  if (!reg) return res.status(404).json({ error: 'Regulasi tidak ditemukan.' });
  const pvCount = db.prepare('SELECT COUNT(*) as c FROM price_versions WHERE regulation_id = ?').get(req.params.id).c;
  if (pvCount > 0) return res.status(400).json({ error: `Regulasi digunakan oleh ${pvCount} price version. Hapus price version dahulu.` });
  db.prepare('DELETE FROM regulations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────
//  13. MASTER DATA (read)
// ─────────────────────────────────────────
router.get('/masterdata', (req, res) => {
  res.json({
    hgbtIndustries: db.prepare('SELECT * FROM hgbt_industries').all(),
    regulations: db.prepare('SELECT * FROM regulations ORDER BY effective_from ASC').all(),
    priceVersions: db.prepare('SELECT * FROM price_versions ORDER BY valid_from ASC').all(),
    formulas: db.prepare('SELECT * FROM formulas').all(),
    customers: db.prepare('SELECT c.*, h.name as industry_name FROM customers c LEFT JOIN hgbt_industries h ON c.industry_code = h.code').all(),
    contracts: db.prepare('SELECT * FROM contracts').all(),
    billingRules: db.prepare('SELECT * FROM billing_rules ORDER BY contract_id, priority ASC').all(),
    jisdorRates: db.prepare('SELECT * FROM jisdor_rates ORDER BY rate_date DESC').all(),
  });
});

// ─────────────────────────────────────────
//  14. CUSTOMERS CRUD
// ─────────────────────────────────────────
router.post('/customers', (req, res) => {
  const { id, name, npwp, address, segment, industry_code, is_hgbt } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'Field wajib: id, name' });
  if (db.prepare('SELECT id FROM customers WHERE id = ?').get(id)) return res.status(409).json({ error: 'ID customer sudah ada.' });
  db.prepare(`INSERT INTO customers (id, name, npwp, address, segment, industry_code, is_hgbt) VALUES (?,?,?,?,?,?,?)`)
    .run(id, name, npwp||null, address||null, segment||null, industry_code||null, is_hgbt?1:0);
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
});

router.patch('/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Customer tidak ditemukan.' });
  const { name, npwp, address, segment, industry_code, is_hgbt } = req.body;
  db.prepare(`UPDATE customers SET name=COALESCE(?,name), npwp=?, address=?, segment=?, industry_code=?, is_hgbt=COALESCE(?,is_hgbt) WHERE id=?`)
    .run(name||null, npwp!==undefined?npwp:c.npwp, address!==undefined?address:c.address,
      segment!==undefined?segment:c.segment, industry_code!==undefined?industry_code:c.industry_code,
      is_hgbt!==undefined?(is_hgbt?1:0):null, req.params.id);
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
});

router.delete('/customers/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Customer tidak ditemukan.' });
  const cnt = db.prepare('SELECT COUNT(*) as c FROM contracts WHERE customer_id = ?').get(req.params.id).c;
  if (cnt > 0) return res.status(400).json({ error: `Customer masih memiliki ${cnt} kontrak aktif.` });
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────
//  15. HGBT INDUSTRIES CRUD
// ─────────────────────────────────────────
router.post('/industries', (req, res) => {
  const { code, name, description } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Field wajib: code, name' });
  if (db.prepare('SELECT code FROM hgbt_industries WHERE code = ?').get(code)) return res.status(409).json({ error: 'Kode industri sudah ada.' });
  db.prepare('INSERT INTO hgbt_industries (code, name, description) VALUES (?,?,?)').run(code, name, description||null);
  res.json(db.prepare('SELECT * FROM hgbt_industries WHERE code = ?').get(code));
});

router.patch('/industries/:code', (req, res) => {
  const ind = db.prepare('SELECT * FROM hgbt_industries WHERE code = ?').get(req.params.code);
  if (!ind) return res.status(404).json({ error: 'Industri tidak ditemukan.' });
  const { name, description } = req.body;
  db.prepare('UPDATE hgbt_industries SET name=COALESCE(?,name), description=? WHERE code=?')
    .run(name||null, description!==undefined?description:ind.description, req.params.code);
  res.json(db.prepare('SELECT * FROM hgbt_industries WHERE code = ?').get(req.params.code));
});

router.delete('/industries/:code', (req, res) => {
  if (!db.prepare('SELECT code FROM hgbt_industries WHERE code = ?').get(req.params.code)) return res.status(404).json({ error: 'Industri tidak ditemukan.' });
  const cnt = db.prepare('SELECT COUNT(*) as c FROM customers WHERE industry_code = ?').get(req.params.code).c;
  if (cnt > 0) return res.status(400).json({ error: `Industri digunakan oleh ${cnt} customer.` });
  db.prepare('DELETE FROM hgbt_industries WHERE code = ?').run(req.params.code);
  res.json({ ok: true });
});

// ─────────────────────────────────────────
//  16. CONTRACTS CRUD
// ─────────────────────────────────────────
router.post('/contracts', (req, res) => {
  const { id, customer_id, payment_scheme, frequency, fixed_fee, annual_fee, opening_balance, min_qty, allocation, uom, start_date, end_date } = req.body;
  if (!id || !customer_id || !payment_scheme || !allocation) return res.status(400).json({ error: 'Field wajib: id, customer_id, payment_scheme, allocation' });
  if (db.prepare('SELECT id FROM contracts WHERE id = ?').get(id)) return res.status(409).json({ error: 'ID kontrak sudah ada.' });
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customer_id)) return res.status(404).json({ error: 'Customer tidak ditemukan.' });
  db.prepare(`INSERT INTO contracts (id, customer_id, payment_scheme, frequency, fixed_fee, annual_fee, opening_balance, min_qty, allocation, uom, start_date, end_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, customer_id, payment_scheme, frequency||'monthly', fixed_fee||0, annual_fee||0, opening_balance||0, min_qty||0, allocation, uom||'MMBTU', start_date||null, end_date||null);
  res.json(db.prepare('SELECT * FROM contracts WHERE id = ?').get(id));
});

router.patch('/contracts/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Kontrak tidak ditemukan.' });
  const { payment_scheme, frequency, fixed_fee, annual_fee, opening_balance, min_qty, allocation, uom, start_date, end_date } = req.body;
  db.prepare(`UPDATE contracts SET payment_scheme=COALESCE(?,payment_scheme), frequency=COALESCE(?,frequency),
    fixed_fee=COALESCE(?,fixed_fee), annual_fee=COALESCE(?,annual_fee), opening_balance=COALESCE(?,opening_balance),
    min_qty=COALESCE(?,min_qty), allocation=COALESCE(?,allocation), uom=COALESCE(?,uom),
    start_date=?, end_date=? WHERE id=?`)
    .run(payment_scheme||null, frequency||null, fixed_fee??null, annual_fee??null, opening_balance??null,
      min_qty??null, allocation??null, uom||null,
      start_date!==undefined?start_date:c.start_date, end_date!==undefined?end_date:c.end_date,
      req.params.id);
  res.json(db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id));
});

router.delete('/contracts/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM contracts WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Kontrak tidak ditemukan.' });
  const cnt = db.prepare("SELECT COUNT(*) as c FROM billing_tickets WHERE contract_id = ? AND status NOT IN ('INVOICED')").get(req.params.id).c;
  if (cnt > 0) return res.status(400).json({ error: `Kontrak memiliki ${cnt} tiket aktif yang belum selesai.` });
  db.prepare('DELETE FROM contracts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────
//  17. PRICE VERSIONS CRUD
// ─────────────────────────────────────────
router.post('/prices', (req, res) => {
  const { id, regulation_id, label, currency, uom, valid_from, valid_to, rate_eligible, rate_excess, applicable_industries, approval } = req.body;
  if (!id || !regulation_id || !valid_from || rate_eligible == null || rate_excess == null) return res.status(400).json({ error: 'Field wajib: id, regulation_id, valid_from, rate_eligible, rate_excess' });
  if (db.prepare('SELECT id FROM price_versions WHERE id = ?').get(id)) return res.status(409).json({ error: 'ID price version sudah ada.' });
  if (!db.prepare('SELECT id FROM regulations WHERE id = ?').get(regulation_id)) return res.status(404).json({ error: 'Regulasi tidak ditemukan.' });
  db.prepare(`INSERT INTO price_versions (id, regulation_id, label, currency, uom, valid_from, valid_to, rate_eligible, rate_excess, applicable_industries, approval)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, regulation_id, label||null, currency||'USD', uom||'MMBTU', valid_from, valid_to||null, rate_eligible, rate_excess,
      applicable_industries ? JSON.stringify(applicable_industries) : null, approval||null);
  res.json(db.prepare('SELECT * FROM price_versions WHERE id = ?').get(id));
});

router.patch('/prices/:id', (req, res) => {
  const pv = db.prepare('SELECT * FROM price_versions WHERE id = ?').get(req.params.id);
  if (!pv) return res.status(404).json({ error: 'Price version tidak ditemukan.' });
  const { label, valid_from, valid_to, rate_eligible, rate_excess, approval } = req.body;
  db.prepare(`UPDATE price_versions SET label=COALESCE(?,label), valid_from=COALESCE(?,valid_from), valid_to=?,
    rate_eligible=COALESCE(?,rate_eligible), rate_excess=COALESCE(?,rate_excess), approval=? WHERE id=?`)
    .run(label||null, valid_from||null, valid_to!==undefined?valid_to:pv.valid_to,
      rate_eligible??null, rate_excess??null,
      approval!==undefined?approval:pv.approval, req.params.id);
  res.json(db.prepare('SELECT * FROM price_versions WHERE id = ?').get(req.params.id));
});

router.delete('/prices/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM price_versions WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Price version tidak ditemukan.' });
  const cnt = db.prepare('SELECT COUNT(*) as c FROM billing_rules WHERE price_version_id = ?').get(req.params.id).c;
  if (cnt > 0) return res.status(400).json({ error: `Price version digunakan oleh ${cnt} billing rule.` });
  db.prepare('DELETE FROM price_versions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────
//  18. FORMULAS CRUD
// ─────────────────────────────────────────
router.post('/formulas', (req, res) => {
  const { id, name, expr, description } = req.body;
  if (!id || !name || !expr) return res.status(400).json({ error: 'Field wajib: id, name, expr' });
  if (db.prepare('SELECT id FROM formulas WHERE id = ?').get(id)) return res.status(409).json({ error: 'ID formula sudah ada.' });
  db.prepare('INSERT INTO formulas (id, name, expr, description) VALUES (?,?,?,?)').run(id, name, expr, description||null);
  res.json(db.prepare('SELECT * FROM formulas WHERE id = ?').get(id));
});

router.patch('/formulas/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM formulas WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Formula tidak ditemukan.' });
  const { name, expr, description } = req.body;
  db.prepare('UPDATE formulas SET name=COALESCE(?,name), expr=COALESCE(?,expr), description=? WHERE id=?')
    .run(name||null, expr||null, description!==undefined?description:null, req.params.id);
  res.json(db.prepare('SELECT * FROM formulas WHERE id = ?').get(req.params.id));
});

router.delete('/formulas/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM formulas WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Formula tidak ditemukan.' });
  const cnt = db.prepare('SELECT COUNT(*) as c FROM billing_rules WHERE formula_id = ?').get(req.params.id).c;
  if (cnt > 0) return res.status(400).json({ error: `Formula digunakan oleh ${cnt} billing rule.` });
  db.prepare('DELETE FROM formulas WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────
//  19. BILLING RULES CRUD
// ─────────────────────────────────────────
router.post('/billing-rules', (req, res) => {
  const { id, contract_id, priority, formula_id, price_version_id, effective_from, effective_to } = req.body;
  if (!id || !contract_id || priority == null || !formula_id || !price_version_id || !effective_from)
    return res.status(400).json({ error: 'Field wajib: id, contract_id, priority, formula_id, price_version_id, effective_from' });
  if (db.prepare('SELECT id FROM billing_rules WHERE id = ?').get(id)) return res.status(409).json({ error: 'ID billing rule sudah ada.' });
  db.prepare(`INSERT INTO billing_rules (id, contract_id, priority, formula_id, price_version_id, effective_from, effective_to) VALUES (?,?,?,?,?,?,?)`)
    .run(id, contract_id, priority, formula_id, price_version_id, effective_from, effective_to||null);
  res.json(db.prepare('SELECT * FROM billing_rules WHERE id = ?').get(id));
});

router.patch('/billing-rules/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM billing_rules WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Billing rule tidak ditemukan.' });
  const { priority, formula_id, price_version_id, effective_from, effective_to } = req.body;
  db.prepare(`UPDATE billing_rules SET priority=COALESCE(?,priority), formula_id=COALESCE(?,formula_id),
    price_version_id=COALESCE(?,price_version_id), effective_from=COALESCE(?,effective_from), effective_to=? WHERE id=?`)
    .run(priority??null, formula_id||null, price_version_id||null, effective_from||null,
      effective_to!==undefined?effective_to:r.effective_to, req.params.id);
  res.json(db.prepare('SELECT * FROM billing_rules WHERE id = ?').get(req.params.id));
});

router.delete('/billing-rules/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM billing_rules WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Billing rule tidak ditemukan.' });
  db.prepare('DELETE FROM billing_rules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/painpoints', (req, res) => {
  res.json([]);
});

module.exports = router;

