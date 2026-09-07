// server/seed.js
// Convenience script: importing db.js runs migration + seed automatically
// (safe to re-run; seeding is skipped if data already exists).
require('./db');
console.log('Database ready at ../data.sqlite (migrated + seeded).');
