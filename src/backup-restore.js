/**
 * Backup & Restore — persistencia de datos en Render free tier
 *
 * Render free tier NO tiene disco persistente: cada deploy borra el archivo SQLite.
 * Este módulo guarda un backup de la BD como JSON en data/backup.json,
 * y si al iniciar la BD está vacía, intenta restaurar desde allí.
 *
 * ⚠️ SOLUCIÓN DEFINITIVA: migrar a Render Starter ($7/mes) y usar disk:
 *    Ver render.yaml — descomentar las secciones disk: y DB_PATH.
 */

const fs = require('fs');
const path = require('path');
const { getDb, queryAll, queryFirst, run, transaction } = require('./db');

const BACKUP_FILE = path.join(__dirname, '..', 'data', 'backup.json');

/**
 * Exporta toda la BD a un archivo JSON
 */
function exportDatabase() {
  try {
    const db = getDb();
    if (!db) return;

    const tables = [
      'usuarios',
      'clientes',
      'productos',
      'presupuestos',
      'ordenes_trabajo',
      'orden_trabajo_productos',
      'avales',
      'avales_legacy',
      'encuestas_satisfaccion',
      'configuracion_incentivos',
      'configuracion_documentos',
      'reportes_incentivos',
      'notificaciones_ot'
    ];

    const backup = {};
    for (const table of tables) {
      try {
        const rows = queryAll(`SELECT * FROM ${table}`);
        if (rows && rows.length > 0) {
          backup[table] = rows;
        }
      } catch (e) {
        // tabla no existe, ignorar
      }
    }

    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2), 'utf-8');
    console.log(`💾 Backup guardado en ${BACKUP_FILE} (${Object.keys(backup).length} tablas)`);

    // ⚠️ Render no tiene credenciales Git — el backup queda en disco efímero
    // Para persistencia real: Render Starter (/mes) + disco persistente
    // Mientras, el workflow: crear datos > descargar backup.json desde Render
    // > subirlo manualmente al repo

    return true;
  } catch (e) {
    console.error('❌ Error guardando backup:', e.message);
    return false;
  }
}

/**
 * Verifica si la BD necesita restauración (está vacía/seed y hay backup)
 */
function needsRestore() {
  try {
    const numOrdenes = queryFirst('SELECT COUNT(*) as cnt FROM ordenes_trabajo')?.cnt || 0;
    const numClientes = queryFirst('SELECT COUNT(*) as cnt FROM clientes')?.cnt || 0;
    const hasBackup = fs.existsSync(BACKUP_FILE);
    const limpiadoFlag = fs.existsSync(path.join(path.dirname(BACKUP_FILE), '.limpiado'));

    // Si se hizo una limpieza intencional, NO restaurar
    if (limpiadoFlag) {
      console.log('🧹 Limpieza manual detectada (.limpiado), saltando restauracion.');
      // Eliminar el flag para futuros arranques
      try { fs.unlinkSync(path.join(path.dirname(BACKUP_FILE), '.limpiado')); } catch(e) {}
      return false;
    }

    // Datos "seed" son exactamente 7 OTs y 5 clientes
    const isSeedData = numOrdenes <= 7 && numClientes <= 5;

    if (isSeedData && hasBackup) {
      // Solo restaurar si el backup tiene datos reales
      try {
        const backupContent = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));
        const tableCount = Object.keys(backupContent).length;
        if (tableCount > 0) {
          return true;
        }
        console.log('📭 Backup vacío (0 tablas), saltando restauración.');
      } catch (e) {
        console.log('⚠️ Backup inválido, saltando restauración.');
      }
      return false;
    }

    // Si hay datos reales pero backup no existe, crear backup
    if (!isSeedData && !hasBackup) {
      console.log('📦 BD con datos reales, creando backup...');
      exportDatabase();
    }

    return false;
  } catch (e) {
    console.error('❌ Error verificando restauración:', e.message);
    return false;
  }
}

/**
 * Restaura la BD desde el backup
 */
function restoreDatabase() {
  try {
    const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));
    const tableCount = Object.keys(backup).length;

    if (tableCount === 0) {
      console.log('⚠️ Backup vacío, no se restaura.');
      return false;
    }

    console.log(`🔄 Restaurando BD desde backup (${tableCount} tablas)...`);

    transaction(() => {
      // Desactivar foreign keys y limpiar tablas en orden inverso
      const allTables = Object.keys(backup).reverse();

      // Primera pasada: limpiar
      for (const table of allTables) {
        try {
          run(`DELETE FROM ${table}`);
        } catch (e) {
          console.warn(`⚠️ No se pudo limpiar ${table}: ${e.message}`);
        }
      }

      // Segunda pasada: insertar datos
      for (const [table, rows] of Object.entries(backup)) {
        if (!rows || rows.length === 0) continue;

        const columns = Object.keys(rows[0]);
        const placeholders = columns.map(() => '?').join(', ');
        const colNames = columns.join(', ');

        for (const row of rows) {
          try {
            const values = columns.map(col => row[col] ?? null);
            run(`INSERT INTO ${table} (${colNames}) VALUES (${placeholders})`, values);
          } catch (e) {
            console.warn(`⚠️ Error insertando en ${table}: ${e.message}`);
          }
        }
        console.log(`  ✓ ${table}: ${rows.length} registros restaurados`);
      }
    });

    console.log('✅ BD restaurada exitosamente');
    return true;
  } catch (e) {
    console.error('❌ Error restaurando BD:', e.message);
    return false;
  }
}


module.exports = { exportDatabase, needsRestore, restoreDatabase, BACKUP_FILE };
