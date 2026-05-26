/**
 * FTP Backup — sincronización de backup con servidor DKLIC
 *
 * Render free tier no tiene disco persistente, así que guardamos
 * el backup en un servidor FTP (hosting DKLIC) y lo descargamos
 * al iniciar la app.
 *
 * Configurar env vars:
 *   FTP_HOST=dklicrd.com
 *   FTP_USER=dklic-ftp@dklicrd.com
 *   FTP_PASS=Hermes@2026
 *   FTP_BACKUP_PATH=/backups/ot-dashboard/backup.json
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FTP_HOST = process.env.FTP_HOST || 'dklicrd.com';
const FTP_USER = process.env.FTP_USER || 'dklic-ftp@dklicrd.com';
const FTP_PASS = process.env.FTP_PASS || 'Hermes@2026';
const FTP_BACKUP_PATH = process.env.FTP_BACKUP_PATH || '/backups/ot-dashboard/backup.json';

const LOCAL_BACKUP = path.join(__dirname, '..', 'data', 'backup.json');

/**
 * Descarga backup.json desde FTP al servidor local
 * Retorna true si se descargó exitosamente, false si no
 */
function descargarBackupFTP() {
  try {
    console.log(`📥 Descargando backup desde FTP: ${FTP_HOST}${FTP_BACKUP_PATH}`);
    
    // Usar tnftp en modo script para descargar
    const scriptContent = `open ${FTP_HOST}
user ${FTP_USER} ${FTP_PASS}
get ${FTP_BACKUP_PATH} ${LOCAL_BACKUP}.ftp
quit`;
    
    const scriptPath = path.join(path.dirname(LOCAL_BACKUP), '.ftp-download-script');
    fs.writeFileSync(scriptPath, scriptContent);
    
    execSync(`tnftp -n < '${scriptPath}'`, {
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    try { fs.unlinkSync(scriptPath); } catch(e) {}

    if (fs.existsSync(LOCAL_BACKUP + '.ftp')) {
      const size = fs.statSync(LOCAL_BACKUP + '.ftp').size;
      if (size > 0) {
        fs.renameSync(LOCAL_BACKUP + '.ftp', LOCAL_BACKUP);
        console.log(`✅ Backup descargado desde FTP (${size} bytes)`);
        return true;
      }
      fs.unlinkSync(LOCAL_BACKUP + '.ftp');
    }
    
    console.log('⚠️ FTP backup no encontrado o vacío');
    return false;
  } catch (e) {
    console.error('⚠️ No se pudo descargar backup desde FTP:', e.message);
    // Limpiar archivo temporal
    try { if (fs.existsSync(LOCAL_BACKUP + '.ftp')) fs.unlinkSync(LOCAL_BACKUP + '.ftp'); } catch(ex) {}
    return false;
  }
}

/**
 * Sube backup.json al servidor FTP
 */
function subirBackupFTP() {
  try {
    if (!fs.existsSync(LOCAL_BACKUP)) {
      console.log('⚠️ No hay backup local para subir a FTP');
      return false;
    }

    const size = fs.statSync(LOCAL_BACKUP).size;
    console.log(`📤 Subiendo backup a FTP: ${FTP_HOST}${FTP_BACKUP_PATH} (${size} bytes)`);

    // Usar tnftp (FTP client) para subir
    const ftpScript = `open ${FTP_HOST}
user ${FTP_USER} ${FTP_PASS}
mkdir /backups
mkdir /backups/ot-dashboard
put ${LOCAL_BACKUP} ${FTP_BACKUP_PATH}
quit`;

    const scriptPath = path.join(__dirname, '..', 'data', '.ftp-upload-script');
    fs.writeFileSync(scriptPath, ftpScript);

    execSync(`ftp -n < '${scriptPath}'`, {
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Limpiar
    try { fs.unlinkSync(scriptPath); } catch(e) {}

    console.log('✅ Backup subido a FTP exitosamente');
    return true;
  } catch (e) {
    console.error('❌ Error subiendo backup a FTP:', e.message);
    try { fs.unlinkSync(scriptPath); } catch(ex) {}
    return false;
  }
}

/**
 * Intenta restaurar backup desde FTP si el local no existe o está vacío
 */
function restaurarSiNecesario() {
  // Si ya hay backup local con datos, no descargar
  if (fs.existsSync(LOCAL_BACKUP)) {
    try {
      const content = JSON.parse(fs.readFileSync(LOCAL_BACKUP, 'utf-8'));
      const tableCount = Object.keys(content).length;
      if (tableCount > 0) {
        console.log(`📦 Backup local encontrado (${tableCount} tablas), no necesita FTP`);
        return false;
      }
    } catch(e) {
      console.log('⚠️ Backup local inválido, intentando FTP...');
    }
  }

  return descargarBackupFTP();
}

module.exports = { descargarBackupFTP, subirBackupFTP, restaurarSiNecesario };
