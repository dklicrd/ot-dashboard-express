/**
 * Backup & Restore — SOLO persistencia a disco
 *
 * Con plan Starter de Render ($7/mes) hay disco persistente en /var/data.
 * exportDatabase() ahora guarda la BD sql.js completa al disco.
 */

const path = require('path');
const { getDb, saveDb } = require('./db');

/**
 * Exporta la BD completa al archivo en disco (persistencia real)
 */
function exportDatabase() {
  try {
    const db = getDb();
    if (!db) return false;
    saveDb();
    return true;
  } catch (e) {
    console.error('Error exportando BD:', e.message);
    return false;
  }
}

function needsRestore() { return false; }
function restoreDatabase() { return false; }

module.exports = { exportDatabase, needsRestore, restoreDatabase };