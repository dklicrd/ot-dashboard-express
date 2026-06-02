/**
 * Backup & Restore — DESACTIVADO
 *
 * Con plan Starter de Render ($7/mes) ya hay disco persistente.
 * Los backups JSON causaban problemas al restaurar datos viejos en cada deploy.
 * Ahora solo se exporta bajo demanda (endpoint manual) sin auto-restauración.
 */

const fs = require('fs');
const path = require('path');
const { getDb, queryAll } = require('./db');

const BACKUP_FILE = path.join(__dirname, '..', 'data', 'backup.json');

/**
 * Exporta la BD a JSON (solo export, nunca restaura automáticamente)
 */
function exportDatabase() {
  try {
    const db = getDb();
    if (!db) return false;

    const tables = [
      'usuarios', 'clientes', 'productos', 'presupuestos',
      'ordenes_trabajo', 'orden_trabajo_productos',
      'avales', 'avales_legacy', 'encuestas_satisfaccion',
      'configuracion_incentivos', 'configuracion_documentos', 'reportes_incentivos'
    ];

    const backup = {};
    for (const table of tables) {
      try {
        const rows = queryAll(`SELECT * FROM ${table}`);
        if (rows && rows.length > 0) backup[table] = rows;
      } catch (e) { /* tabla no existe */ }
    }

    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2), 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

// Eliminar backup.json existente al cargar el módulo (arranque limpio)
try { fs.unlinkSync(BACKUP_FILE); } catch(e) { /* no existe */ }
try { fs.unlinkSync(path.join(path.dirname(BACKUP_FILE), '.limpiado')); } catch(e) {}

function needsRestore() { return false; }
function restoreDatabase() { return false; }

console.log('🧹 Sistema de backup automático desactivado — arranque siempre limpio');

module.exports = { exportDatabase, needsRestore, restoreDatabase, BACKUP_FILE };