const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'ot-dashboard.db');

let db = null;
let initPromise = null;
let _inTransaction = false;

async function initDb() {
  if (db) return db;
  
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  
  // RESET_DB=true: borrar BD existente por completo
  if (process.env.RESET_DB === 'true' && fs.existsSync(DB_PATH)) {
    console.log('🧹 RESET_DB activo — eliminando BD existente');
    try { fs.unlinkSync(DB_PATH); } catch(e) {}
    try { fs.unlinkSync(DB_PATH + '.tmp'); } catch(e) {}
  }
  
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  
  db.run('PRAGMA foreign_keys = ON');
  return db;
}

async function getDb() {
  if (!initPromise) {
    initPromise = initDb();
  }
  return initPromise;
}

function saveDb() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    const tmpPath = DB_PATH + '.tmp';
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, DB_PATH);
  } catch (e) {
    console.error('Error saving DB:', e.message);
  }
}

/**
 * Safe query using sql.js prepared statements (no SQL injection)
 */
function queryAll(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    if (!stmt) return [];
    if (params.length > 0) stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  } catch (e) {
    console.error('queryAll Error:', sql.slice(0, 80), params, e.message);
    throw e;
  }
}

/**
 * Safe single-row query
 */
function queryFirst(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Safe write. Skips saveDb() if called inside transaction() to avoid
 * db.export() interfering with the active transaction.
 */
function run(sql, params = []) {
  try {
    db.run(sql, params);
    if (!_inTransaction) saveDb();
  } catch (e) {
    console.error('run Error:', sql.slice(0, 80), params, e.message);
    throw e;
  }
}

/**
 * Execute multiple writes in a transaction (atomic).
 * Uses db.run() for BEGIN/COMMIT which works with sql.js prepared statements.
 * IMPORTANT: sql.js db.export() triggers an implicit COMMIT, so we skip
 * saveDb() on individual run() calls inside the transaction.
 */
function transaction(fn) {
  if (_inTransaction) throw new Error('Nested transactions not supported');
  _inTransaction = true;
  try {
    db.run('BEGIN');
    fn();
    db.run('COMMIT');
    _inTransaction = false;
    saveDb();
  } catch (e) {
    _inTransaction = false;
    try { db.run('ROLLBACK'); } catch (rbErr) {
      console.error('Rollback error:', rbErr.message);
    }
    throw e;
  }
}

/**
 * Get the last inserted row ID
 */
function lastInsertId() {
  const r = db.exec('SELECT last_insert_rowid() as id');
  return r.length > 0 && r[0].values.length > 0 ? r[0].values[0][0] : null;
}

module.exports = { getDb, saveDb, queryAll, queryFirst, run, transaction, lastInsertId };
