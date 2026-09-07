# PGNCOM Gas Billing — Discovery Prototype (Working Full-Stack App)

Implementasi kerja (bukan mockup) dari **PGNCOM Gas Billing Discovery Prototype Blueprint**
(Section 1–6: Pain Point → Business Process → Requirement → Architecture → ERD → Use Case).

Setiap pain point (P01–P11) bisa dipilih dari UI, lalu dijalankan end-to-end melalui API
sungguhan: Billing Worklist → Decision & Price Resolution → Billing Calculation →
Validation & Approval → Generate Invoice eDoc — dan semua hasilnya **tersimpan permanen**
di database SQLite (bukan cuma state di browser), sesuai prinsip blueprint "history is
immutable; changes create new versions".

## Stack

- **Backend:** Node.js + Express + better-sqlite3 (file-based SQL database, `data.sqlite`)
- **Frontend:** HTML/CSS/vanilla JS (tanpa build step) yang memanggil REST API backend
- Tidak ada dependency eksternal berbayar — semuanya jalan lokal.

## Menjalankan

```bash
npm install
npm start
```

Lalu buka **http://localhost:4000** di browser.

Database (`data.sqlite`) otomatis dibuat dan di-seed saat server pertama kali dijalankan.
Untuk reset semua data ke kondisi awal:

```bash
rm -f data.sqlite data.sqlite-shm data.sqlite-wal
npm start
```

## Struktur Project

```
server/
  index.js         Express app entry point
  db.js             Schema (migration) + seed data — semua master data blueprint
  routes.js         Semua API endpoint (worklist, decision, calculate, validate, invoice, adjustment, trace)
  engine/index.js   Pure business logic: rule resolution, formula, payment scheme, validation
public/
  index.html        Shell halaman
  styles.css        Design system (pipeline stepper, trace drawer, tabel, dsb.)
  app.js            Semua rendering + wiring ke API (per pain point / per step)
```

## Bagaimana tiap Pain Point dipetakan

| Pain Point | Yang dibuktikan | Endpoint kunci |
|---|---|---|
| P01 Repeated Recalculation | Old-vs-new simulation, calculation version, adjustment | `/simulate-recalc`, `/adjustment` |
| P02 Tariff Period Uncertainty | Split-period calculation di sekitar cut-off | `/decision-split`, `/calculate-split` |
| P03 Multiple Price & Formula | Dua kontrak, formula berbeda, priority rule | `/decision` (dua kontrak) |
| P04 Regulatory Change | Blokir regulasi revoked, aktivasi replacement | `/decision`, `/decision/activate-replacement` |
| P05 Fragmented Source Data | Completeness check, resolve data | `/worklist/.../resolve` |
| P06 Payment Scheme | Postpaid vs prepaid vs hybrid | `/payment-compare` |
| P07 UOM, Allocation & Component | Konversi m³→MMBTU, eligible/excess split | `/calculate` (CTR-003) |
| P08 Manual Validation & Approval | Variance threshold, maker-checker | `/validate`, `/approve` |
| P09 Explainability & Audit Trail | Trace lengkap decision→calculation | `/trace/:calculationId` |
| P10 Billing Frequency & Charge Treatment | Recurring + annual (prorata) + one-time | `/calculate` (CTR-004) |
| P11 Invoice Inconsistency | Breakdown lengkap, source reference | `/invoice` |

Setiap kalkulasi yang dijalankan disimpan sebagai baris baru di tabel `calculations`
dengan nomor `version` yang naik — jadi kalau pain point yang sama dijalankan berkali-kali,
kamu akan melihat versi kalkulasi bertambah, persis seperti requirement RQ-09/RQ-10 di blueprint.

## Menjalankan/Mengembangkan di Google Antigravity

Project ini adalah folder Node.js standar — buka folder `pgncom-app/` ini langsung
di Antigravity (File → Open Folder), lalu minta agent Antigravity untuk:

- `npm install && npm start` untuk menjalankannya, atau
- melanjutkan pengembangan: menambah tabel/field baru di `server/db.js`, endpoint baru
  di `server/routes.js`, atau halaman/komponen baru di `public/`.

Karena ini backend biasa (Express + SQLite), Antigravity (atau IDE lain apa pun) bisa
langsung menjalankan, mem-browser-test (lewat browser-in-the-loop agent), dan
mendeploy-nya tanpa perlu setup khusus.

## Area yang perlu didiskusikan lebih lanjut (dari blueprint, belum di-build)

Sesuai kolom **"Discovery confirmation needed"** di tiap requirement RQ-01–RQ-12 pada
blueprint asli — hal-hal berikut sengaja belum dibangun karena butuh konfirmasi bisnis:

- Approval matrix/role sungguhan (saat ini disederhanakan jadi 1 checkbox checker)
- Integrasi sumber data eksternal (Dukcapil/PDDIKTI-setara untuk gas: Migas, meter telemetry)
- Format invoice eDoc resmi (PPN/e-Faktur, digital signature, numbering resmi PGNCOM)
- Precedence resmi antar regulasi/kontrak/commercial circular saat terjadi konflik
- Tabel Service/Delivery Point & Meter terpisah (saat ini disederhanakan jadi 1 kontrak = 1 meter)
