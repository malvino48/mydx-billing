// server/engine/index.js
// Pure business-logic: rule resolution, HGBT validation, formula, payment scheme, variance, IDR conversion, and Proration.
// Terpisah dari routes/db supaya logic bisa di-audit & test secara independen (RQ-06, RQ-09).

const db = require('../db');

const CONV_FACTOR = 0.0364; // m³ → MMBTU
const HGBT_CAP_USD = 6.00;  // Permen ESDM 15/2022
const PPN_RATE = 0.11;       // PPN 11%

function within(date, from, to) {
  return date >= from && (to === null || to === undefined || date <= to);
}

function getRegulation(id) {
  return db.prepare('SELECT * FROM regulations WHERE id = ?').get(id);
}

function checkRegulationStatus(regulationId) {
  const reg = getRegulation(regulationId);
  if (!reg) return { blocked: false, reg: null };
  if (reg.status === 'revoked') {
    const replacement = getRegulation(reg.revoked_by);
    return { blocked: true, reg, replacement };
  }
  return { blocked: false, reg };
}

function validateHgbtCap(rateEligible, customerIsHgbt) {
  if (!customerIsHgbt) {
    return { valid: true, isHgbt: false, warning: null, cap: null };
  }
  if (rateEligible > HGBT_CAP_USD) {
    return {
      valid: false,
      isHgbt: true,
      warning: `Rate eligible USD ${rateEligible}/MMBTU melebihi batas HGBT USD ${HGBT_CAP_USD}/MMBTU (Permen ESDM 15/2022).`,
      cap: HGBT_CAP_USD,
      rateEligible,
    };
  }
  return {
    valid: true,
    isHgbt: true,
    warning: null,
    cap: HGBT_CAP_USD,
    rateEligible,
  };
}

/**
 * Resolve billing rule menggunakan valid_from / valid_to.
 */
function resolveRule(contractId, date) {
  const all = db.prepare('SELECT * FROM billing_rules WHERE contract_id = ? ORDER BY priority ASC, effective_from DESC').all(contractId);
  const eligible = all.filter((r) => within(date, r.effective_from, r.effective_to));
  const selected = eligible[0] || null;
  const rejected = all
    .filter((r) => r !== selected)
    .map((r) => ({
      rule: r,
      reason: !within(date, r.effective_from, r.effective_to)
        ? `Effective period (${r.effective_from} — ${r.effective_to || 'sekarang'}) tidak mencakup tanggal ${date}`
        : `Priority ${r.priority} lebih rendah dari rule terpilih`,
    }));
  return { selected, rejected, allCandidates: all };
}

function splitAllocation(qty, allocation) {
  const eligible = Math.min(qty, allocation);
  const excess = Math.max(0, qty - allocation);
  return { eligible, excess };
}

function runFormula(formulaId, ctx) {
  switch (formulaId) {
    case 'F-POSTPAID-STD':
    case 'F-FIXED-USAGE':
    case 'F-USAGE-STD':
      return (ctx.fixedFee || 0) + ctx.eligible * ctx.rateEligible + ctx.excess * ctx.rateExcess;

    case 'F-POSTPAID-ANNUAL':
    case 'F-RECURRING-ANNUAL':
      return (ctx.fixedFee || 0) + ctx.eligible * ctx.rateEligible + ctx.excess * ctx.rateExcess + (ctx.annualFee || 0) / 12 + (ctx.oneTimeFee || 0);

    case 'F-HYBRID': {
      const gross = (ctx.fixedFee || 0) + ctx.eligible * ctx.rateEligible + ctx.excess * ctx.rateExcess;
      return Math.max(0, gross - (ctx.prepaidBalance || 0));
    }

    case 'F-TAKEORPAY': {
      const billedQty = Math.max(ctx.actualQty, ctx.minQty);
      return billedQty * ctx.rateEligible;
    }

    default:
      return 0;
  }
}

function applyPaymentScheme(contract, charge) {
  if (contract.payment_scheme === 'postpaid') {
    return { invoiceAmount: charge, balanceApplied: 0, remainingBalance: null, note: 'Postpaid: full amount ditagihkan.' };
  }
  if (contract.payment_scheme === 'prepaid') {
    const balance = contract.opening_balance;
    if (balance >= charge) {
      return { invoiceAmount: 0, balanceApplied: charge, remainingBalance: balance - charge, note: 'Prepaid: dipotong penuh dari saldo.' };
    }
    return { invoiceAmount: charge - balance, balanceApplied: balance, remainingBalance: 0, note: 'Prepaid: saldo tidak mencukupi, shortfall diinvoice.' };
  }
  // hybrid
  const balance = contract.opening_balance;
  const applied = Math.min(balance, charge);
  const residual = charge - applied;
  return { invoiceAmount: residual, balanceApplied: applied, remainingBalance: balance - applied, note: `Hybrid: saldo USD ${applied.toFixed(2)} digunakan, sisa USD ${residual.toFixed(2)} diinvoice.` };
}

function getJisdorRate(date) {
  return db.prepare('SELECT * FROM jisdor_rates WHERE rate_date <= ? ORDER BY rate_date DESC LIMIT 1').get(date);
}

function convertToIdr(totalUsd, jisdorRate, ppnRate = PPN_RATE) {
  const baseIdr = totalUsd * jisdorRate;
  const ppnAmount = baseIdr * ppnRate;
  const totalIdr = baseIdr + ppnAmount;
  return { baseIdr, ppnAmount, totalIdr, ppnRate };
}

function getUsage(contractId, period) {
  return db.prepare('SELECT * FROM usage_records WHERE contract_id = ? AND period = ?').get(contractId, period);
}

function getPriorApprovedCalculation(contractId, period) {
  return db.prepare(`SELECT * FROM calculations WHERE contract_id = ? AND status = 'approved' AND period < ? ORDER BY period DESC, version DESC LIMIT 1`).get(contractId, period);
}

function validateVariance(newTotal, priorTotal, thresholdPct = 15) {
  if (priorTotal == null) return { status: 'ok', variance: null };
  const variance = ((newTotal - priorTotal) / priorTotal) * 100;
  if (Math.abs(variance) > thresholdPct) return { status: 'warning', variance };
  return { status: 'ok', variance };
}

// ─────────────────────────────────────────
//  Kepatuhan Aturan 4: Proration Engine
// ─────────────────────────────────────────
/**
 * Melakukan kalkulasi prorata dinamis jika terdapat perubahan harga/regulasi di tengah bulan.
 * Total = (Volume_Period_1 * Rate_Old) + (Volume_Period_2 * Rate_New)
 */
function computeProratedForPeriod(contract, customer, period, dateRateChange, pvOld, pvNew, usage) {
  const [year, month] = period.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const cutOffDay = Number(dateRateChange.split('-')[2]);

  // Hitung proporsi hari
  const daysOld = cutOffDay - 1;
  const daysNew = daysInMonth - daysOld;

  const totalQty = usage.qty_mmbtu;
  const totalAlloc = contract.allocation;

  // Cek apakah ada data sub-period spesifik (seperti CTR-001 2026-06|before / after)
  const usageBefore = getUsage(contract.id, period + '|before');
  const usageAfter = getUsage(contract.id, period + '|after');

  let qtyOld = 0;
  let qtyNew = 0;

  if (usageBefore && usageAfter) {
    qtyOld = usageBefore.qty_mmbtu;
    qtyNew = usageAfter.qty_mmbtu;
  } else {
    // Rata-rata harian (Daily Average Proration)
    qtyOld = (totalQty * daysOld) / daysInMonth;
    qtyNew = (totalQty * daysNew) / daysInMonth;
  }

  // Prorata Alokasi Kontrak
  const allocOld = (totalAlloc * daysOld) / daysInMonth;
  const allocNew = (totalAlloc * daysNew) / daysInMonth;

  // Hitung split eligible vs excess untuk masing-masing sub-periode
  const splitOld = splitAllocation(qtyOld, allocOld);
  const splitNew = splitAllocation(qtyNew, allocNew);

  // Jalankan formula untuk masing-masing
  const ctxOld = {
    fixedFee: (contract.fixed_fee || 0) * (daysOld / daysInMonth),
    eligible: splitOld.eligible,
    excess: splitOld.excess,
    rateEligible: pvOld.rate_eligible,
    rateExcess: pvOld.rate_excess,
    prepaidBalance: 0 // Hybrid/prepaid diaplikasikan pada grand total
  };

  const ctxNew = {
    fixedFee: (contract.fixed_fee || 0) * (daysNew / daysInMonth),
    eligible: splitNew.eligible,
    excess: splitNew.excess,
    rateEligible: pvNew.rate_eligible,
    rateExcess: pvNew.rate_excess,
    prepaidBalance: 0
  };

  const subTotalOld = runFormula('F-POSTPAID-STD', ctxOld);
  const subTotalNew = runFormula('F-POSTPAID-STD', ctxNew);
  let grandTotalUsd = subTotalOld + subTotalNew;

  // Jika contract hybrid/prepaid, kurangi dengan opening balance kontrak
  if (contract.payment_scheme === 'hybrid' || contract.payment_scheme === 'prepaid') {
    grandTotalUsd = Math.max(0, grandTotalUsd - (contract.opening_balance || 0));
  }

  const hgbtCheckOld = validateHgbtCap(pvOld.rate_eligible, customer.is_hgbt === 1);
  const hgbtCheckNew = validateHgbtCap(pvNew.rate_eligible, customer.is_hgbt === 1);

  return {
    isProrated: true,
    daysInMonth,
    daysOld,
    daysNew,
    qtyOld,
    qtyNew,
    allocOld,
    allocNew,
    splitOld,
    splitNew,
    subTotalOld,
    subTotalNew,
    totalUsd: grandTotalUsd,
    // G-07: Snapshot lengkap kedua tarif untuk audit trail yang mandiri
    pvOldSnapshot: {
      id: pvOld.id,
      label: pvOld.label,
      rate_eligible: pvOld.rate_eligible,
      rate_excess: pvOld.rate_excess,
      valid_from: pvOld.valid_from,
      valid_to: pvOld.valid_to,
    },
    pvNewSnapshot: {
      id: pvNew.id,
      label: pvNew.label,
      rate_eligible: pvNew.rate_eligible,
      rate_excess: pvNew.rate_excess,
      valid_from: pvNew.valid_from,
      valid_to: pvNew.valid_to,
    },
    hgbtCheck: {
      valid: hgbtCheckOld.valid && hgbtCheckNew.valid,
      warning: hgbtCheckOld.warning || hgbtCheckNew.warning || null,
      cap: HGBT_CAP_USD
    }
  };
}

/**
 * End-to-end calculation untuk tiket/kontrak: mendeteksi proration tengah bulan
 * secara otomatis atau memproses kalkulasi standar.
 */
function computeForContractPeriod(contractId, period, jisdorDateOverride) {
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(contract.customer_id);
  const usage = getUsage(contractId, period);

  if (!usage || usage.status === 'missing') {
    return { blocked: true, reason: 'Meter reading belum tersedia atau berstatus missing.', contract, customer, usage };
  }

  // Cek apakah ada perubahan rate tengah bulan
  // Ambil semua rules untuk kontrak ini
  const rules = db.prepare('SELECT * FROM billing_rules WHERE contract_id = ? ORDER BY priority ASC').all(contractId);

  // Filter rules yang aktif pada periode ini (YYYY-MM-01 s/d YYYY-MM-akhir)
  const [year, month] = period.split('-').map(Number);
  const dateStart = `${period}-01`;
  const dateEnd = `${period}-${new Date(year, month, 0).getDate()}`;

  // Cari rules yang overlap dengan periode billing berjalan
  const overlappingRules = rules.filter(r => {
    const startOverlap = r.effective_from <= dateEnd;
    const endOverlap = !r.effective_to || r.effective_to >= dateStart;
    return startOverlap && endOverlap;
  });

  // Jika ada 2 rules yang overlap di periode ini, lakukan PRORATA
  if (overlappingRules.length >= 2) {
    const rOld = overlappingRules[1]; // priority lebih rendah (atau tanggal lebih lama)
    const rNew = overlappingRules[0]; // priority lebih tinggi (atau tanggal lebih baru)

    const pvOld = db.prepare('SELECT * FROM price_versions WHERE id = ?').get(rOld.price_version_id);
    const pvNew = db.prepare('SELECT * FROM price_versions WHERE id = ?').get(rNew.price_version_id);

    const cutOffDate = rNew.effective_from; // Tanggal perubahan tarif baru aktif
    const proration = computeProratedForPeriod(contract, customer, period, cutOffDate, pvOld, pvNew, usage);

    const jisdorRec = getJisdorRate(jisdorDateOverride || dateEnd);
    const idrConversion = jisdorRec ? convertToIdr(proration.totalUsd, jisdorRec.idr_per_usd) : null;

    return {
      blocked: false,
      isProrated: true,
      contract,
      customer,
      usage,
      // G-06: Simpan kedua rule (lama & baru) untuk audit trail lengkap
      ruleOld: rOld,
      ruleNew: rNew,
      ruleRes: { selected: rNew, rejected: [] },
      priceVersion: pvNew,
      pvOld,
      pvNew,
      totalUsd: proration.totalUsd,
      total: proration.totalUsd,
      qty: usage.qty_mmbtu,
      eligible: proration.splitOld.eligible + proration.splitNew.eligible,
      excess: proration.splitOld.excess + proration.splitNew.excess,
      hgbtCheck: proration.hgbtCheck,
      jisdorRec,
      idrConversion,
      formula: { id: 'F-PRORATED', name: 'Prorated Mid-Month Rate Change', expr: 'Prorated Daily Average' },
      prorationDetails: proration
    };
  }

  // Kalkulasi standar jika tidak ada proration
  const dateMid = `${period}-15`;
  const ruleRes = resolveRule(contractId, dateMid);
  if (!ruleRes.selected) {
    return { blocked: true, reason: 'Tidak ada billing rule aktif yang cocok.', contract, customer, usage, ruleRes };
  }

  const priceVersion = db.prepare('SELECT * FROM price_versions WHERE id = ?').get(ruleRes.selected.price_version_id);
  const regCheck = checkRegulationStatus(priceVersion.regulation_id);

  if (regCheck.blocked) {
    return { blocked: true, reason: `Regulasi ${regCheck.reg.name} dicabut.`, contract, customer, usage, ruleRes, regCheck };
  }

  const qty = usage.qty_mmbtu;
  const { eligible, excess } = splitAllocation(qty, contract.allocation);
  const hgbtCheck = validateHgbtCap(priceVersion.rate_eligible, customer.is_hgbt === 1);

  const ctx = {
    fixedFee: contract.fixed_fee || 0,
    eligible,
    excess,
    rateEligible: priceVersion.rate_eligible,
    rateExcess: priceVersion.rate_excess,
    actualQty: qty,
    minQty: contract.min_qty || 0,
    annualFee: contract.annual_fee || 0,
    oneTimeFee: usage.one_time_fee || 0,
    prepaidBalance: contract.opening_balance || 0
  };

  const totalUsd = runFormula(ruleRes.selected.formula_id, ctx);
  const formula = db.prepare('SELECT * FROM formulas WHERE id = ?').get(ruleRes.selected.formula_id);

  const jisdorRec = getJisdorRate(jisdorDateOverride || dateMid);
  const idrConversion = jisdorRec ? convertToIdr(totalUsd, jisdorRec.idr_per_usd) : null;

  return {
    blocked: false,
    isProrated: false,
    contract,
    customer,
    usage,
    ruleRes,
    priceVersion,
    regCheck,
    ctx,
    totalUsd,
    total: totalUsd,
    formula,
    qty,
    eligible,
    excess,
    hgbtCheck,
    jisdorRec,
    idrConversion
  };
}

module.exports = {
  CONV_FACTOR,
  HGBT_CAP_USD,
  PPN_RATE,
  within,
  getRegulation,
  checkRegulationStatus,
  validateHgbtCap,
  resolveRule,
  splitAllocation,
  runFormula,
  applyPaymentScheme,
  getUsage,
  getJisdorRate,
  convertToIdr,
  computeForContractPeriod,
  getPriorApprovedCalculation,
  validateVariance,
};
