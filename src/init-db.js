const { queryAll, queryFirst, run, transaction } = require('./db');
const bcrypt = require("bcryptjs");

/**
 * Crea solo las tablas base si no existen.
 * Se usa cuando la BD ya tiene datos en disco persistente,
 * para no ejecutar migraciones ni seeds destructivos.
 */
function crearTablasBase() {
  console.log('📋 Verificando tablas base...');
  run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL, rol TEXT NOT NULL, telefono TEXT, activo INTEGER DEFAULT 1,
    creado_en TEXT DEFAULT (datetime('now', '-04:00'))
  )`);
  run(`CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, telefono TEXT, email TEXT,
    direccion TEXT, cedula_rnc TEXT, tipo TEXT DEFAULT 'particular',
    referencias_ubicacion TEXT, creado_en TEXT DEFAULT (datetime('now', '-04:00'))
  )`);
  run(`CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, categoria TEXT,
    descripcion TEXT, precio REAL DEFAULT 0, creado_en TEXT DEFAULT (datetime('now', '-04:00'))
  )`);
  run(`CREATE TABLE IF NOT EXISTS ordenes_trabajo (
    id INTEGER PRIMARY KEY AUTOINCREMENT, numero_ot TEXT UNIQUE NOT NULL,
    cliente_id INTEGER, tipo_servicio TEXT, descripcion TEXT, presupuesto_aprobado INTEGER DEFAULT 0,
    monto_total REAL DEFAULT 0, tecnico_id INTEGER, estado TEXT DEFAULT 'pendiente',
    fuente TEXT, archivo_presupuesto TEXT, notas TEXT, creada_por INTEGER,
    fecha_programada TEXT, fecha_inicio TEXT, fecha_fin TEXT,
    creado_en TEXT DEFAULT (datetime('now', '-04:00')), actualizado_en TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS orden_trabajo_productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, orden_trabajo_id INTEGER, producto_id INTEGER,
    cantidad INTEGER DEFAULT 1, precio_unitario REAL DEFAULT 0
  )`);
  run(`CREATE TABLE IF NOT EXISTS avales (
    id INTEGER PRIMARY KEY AUTOINCREMENT, orden_trabajo_id INTEGER NOT NULL,
    numero_aval TEXT UNIQUE NOT NULL, cliente_nombre TEXT, cliente_contacto TEXT,
    cliente_cedula TEXT, cliente_telefono TEXT, cliente_email TEXT, observaciones TEXT,
    estado TEXT DEFAULT 'pendiente', creado_por INTEGER, fecha_creacion TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS aval_productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, aval_id INTEGER NOT NULL,
    producto_id INTEGER, cantidad INTEGER, comentario TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS avales_legacy (
    id INTEGER PRIMARY KEY AUTOINCREMENT, orden_trabajo_id INTEGER NOT NULL,
    numero_aval TEXT, descripcion_trabajo TEXT, costo_total REAL DEFAULT 0,
    estado TEXT DEFAULT 'pendiente', fecha_completado TEXT, creado_en TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS presupuestos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_id INTEGER, descripcion TEXT,
    monto_total REAL DEFAULT 0, creado_por INTEGER, creado_en TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS encuestas_satisfaccion (
    id INTEGER PRIMARY KEY AUTOINCREMENT, orden_trabajo_id INTEGER, aval_legacy_id INTEGER,
    satisfaccion_general INTEGER, tiempo_entrega INTEGER, desempeno_equipo INTEGER,
    presentacion_equipo INTEGER, calidad_productos INTEGER, conocimientos_tecnicos INTEGER,
    calidad_entrenamientos INTEGER, recomendaria INTEGER, recomendaciones TEXT, porcentaje_final REAL,
    realizada_por INTEGER, fecha_encuesta TEXT, email_enviado INTEGER DEFAULT 0,
    creado_en TEXT DEFAULT (datetime('now', '-04:00')), estado TEXT DEFAULT 'pendiente',
    fecha_limite TEXT, aval_id INTEGER, token_publico TEXT, motivo_sin_encuesta TEXT,
    numero_encuesta TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS reportes_incentivos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, periodo TEXT, tecnico_id INTEGER,
    total_ots INTEGER, puntuacion_promedio REAL, bono_generado REAL,
    fecha_calculo TEXT DEFAULT (datetime('now', '-04:00'))
  )`);
  run(`CREATE TABLE IF NOT EXISTS configuracion_documentos (
    id INTEGER PRIMARY KEY, nombre_empresa TEXT, logo_url TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS configuracion_incentivos (
    id INTEGER PRIMARY KEY CHECK(id=1),
    frecuencia TEXT DEFAULT 'trimestral',
    ponderacion REAL DEFAULT 80,
    bono_fijo REAL DEFAULT 3000,
    bono_por_ot REAL DEFAULT 500,
    bono_encuesta_minima REAL DEFAULT 0.7,
    umbral_calificacion REAL DEFAULT 4.5,
    activo INTEGER DEFAULT 1,
    actualizado_en TEXT DEFAULT (datetime('now', '-04:00'))
  )`);
  run("INSERT OR IGNORE INTO configuracion_incentivos (id) VALUES (1)");
  run(`CREATE TABLE IF NOT EXISTS confirmacion_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL,
    tipo TEXT NOT NULL, orden_trabajo_id INTEGER NOT NULL,
    tecnico_id INTEGER, usado INTEGER DEFAULT 0,
    expira_en TEXT, creado_en TEXT DEFAULT (datetime('now', '-04:00'))
  )`);

  // ═══════════════════════════════════════════════
  // TIPOS DE SERVICIO + CATEGORÍAS (configurables desde BD)
  // ═══════════════════════════════════════════════
  run(`CREATE TABLE IF NOT EXISTS tipos_servicio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    activo INTEGER DEFAULT 1
  )`);

  run(`CREATE TABLE IF NOT EXISTS categorias_servicio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo_servicio_id INTEGER NOT NULL REFERENCES tipos_servicio(id),
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    icon TEXT DEFAULT '📦',
    precio REAL DEFAULT 0,
    activo INTEGER DEFAULT 1
  )`);

  // Migrar datos actuales si la tabla está vacía
  const tieneTiposSc = queryFirst('SELECT COUNT(*) as cnt FROM tipos_servicio')?.cnt > 0;
  if (!tieneTiposSc) {
    console.log('⚙️ Insertando tipos de servicio por defecto...');
    run("INSERT INTO tipos_servicio (nombre, label) VALUES ('proyecto_nuevo', 'Proyecto Nuevo')");
    run("INSERT INTO tipos_servicio (nombre, label) VALUES ('mantenimiento', 'Mantenimiento')");
    run("INSERT INTO tipos_servicio (nombre, label) VALUES ('reparacion', 'Reparación')");
    run("INSERT INTO tipos_servicio (nombre, label) VALUES ('garantia', 'Garantía')");
    run("INSERT INTO tipos_servicio (nombre, label) VALUES ('levantamiento', 'Levantamiento')");
    run("INSERT INTO tipos_servicio (nombre, label) VALUES ('vtc', 'VTC')");
    run("INSERT INTO tipos_servicio (nombre, label) VALUES ('instalacion', 'Instalación')");

    // Proyecto Nuevo (id=1) -> categorias
    run("INSERT INTO categorias_servicio (tipo_servicio_id, key, label, icon, precio) VALUES (1, 'cerradura', 'Cerradura Electrónica', '🔒', 150)");
    run("INSERT INTO categorias_servicio (tipo_servicio_id, key, label, icon, precio) VALUES (1, 'control_acceso', 'Control de Acceso', '🛡️', 300)");
    run("INSERT INTO categorias_servicio (tipo_servicio_id, key, label, icon, precio) VALUES (1, 'caja_fuerte', 'Caja Fuerte', '🔐', 60)");
    run("INSERT INTO categorias_servicio (tipo_servicio_id, key, label, icon, precio) VALUES (1, 'ahorro_energia', 'Ahorro de Energía', '💡', 105)");

    // Mantenimiento (id=2) -> categorias
    run("INSERT INTO categorias_servicio (tipo_servicio_id, key, label, icon, precio) VALUES (2, 'cerradura', 'Mant. Cerradura Elect.', '🔧', 82.50)");
    run("INSERT INTO categorias_servicio (tipo_servicio_id, key, label, icon, precio) VALUES (2, 'caja_fuerte', 'Mant. Caja Fuerte', '🔩', 30)");
    run("INSERT INTO categorias_servicio (tipo_servicio_id, key, label, icon, precio) VALUES (2, 'ahorro_energia', 'Mant. Ahorro de Energía', '⚡', 37.50)");

    console.log('✅ Tipos de servicio y categorías insertados');
  }

  console.log('✅ Tablas base verificadas/creadas');
}

async function initDatabase() {
  console.log('📦 Inicializando base de datos...');

  // Si la variable RESET_DB está activa, borrar todo y empezar de nuevo
  if (process.env.RESET_DB === 'true') {
    console.log('⚠️ RESET_DB activo — eliminando todas las tablas...');
    try {
      const tables = queryAll("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
      for (const t of tables) {
        run('DROP TABLE IF EXISTS "' + t.name + '"');
      }
      console.log('✅ Todas las tablas eliminadas');
    } catch (e) {
      console.error('Error reset:', e.message);
    }
  }

  // Verificar si la BD ya tiene datos reales (disco persistente)
  try {
    const tieneUsuarios = (queryFirst('SELECT COUNT(*) as cnt FROM usuarios')?.cnt || 0) > 0;
    const tieneClientes = (queryFirst('SELECT COUNT(*) as cnt FROM clientes')?.cnt || 0) > 0;

    if (tieneUsuarios && tieneClientes) {
      console.log('💾 BD con datos existentes detectada (disco persistente). Asegurando tablas base y ejecutando migraciones...');
      crearTablasBase();
      // Las migraciones de columnas nuevas SIEMPRE deben ejecutarse
      await ejecutarMigraciones();
      try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
      return;
    }
  } catch (e) {
    // Las tablas pueden no existir aún (primera ejecución), continuar con inicialización completa
    console.log('⚠️ No se pudo verificar BD existente:', e.message);
  }

  console.log('🆕 BD vacía o sin datos — ejecutando inicialización completa...');

  run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      rol TEXT NOT NULL CHECK(rol IN ('superadmin', 'admin', 'tecnico', 'servicio_cliente')),
      telefono TEXT,
      activo INTEGER DEFAULT 1,
      creado_en TEXT DEFAULT (datetime('now', '-04:00'))
    );
  `);
  run(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      telefono TEXT,
      email TEXT,
      direccion TEXT,
      cedula_rnc TEXT,
      tipo TEXT CHECK(tipo IN ('empresa', 'particular')) DEFAULT 'particular',
      referencias_ubicacion TEXT,
      creado_en TEXT DEFAULT (datetime('now', '-04:00'))
    );
  `);

  // Migrate ordenes_trabajo: remove CHECK constraint on tipo_servicio
  const tableInfo = queryAll("PRAGMA table_info('ordenes_trabajo')");
  const otExists = tableInfo.length > 0;
  if (!otExists) {
    // Create fresh with no CHECK on tipo_servicio
    run(`
      CREATE TABLE ordenes_trabajo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        numero_ot TEXT UNIQUE NOT NULL,
        cliente_id INTEGER NOT NULL REFERENCES clientes(id),
        tipo_servicio TEXT NOT NULL,
        descripcion TEXT,
        presupuesto_aprobado INTEGER DEFAULT 0,
        monto_total REAL DEFAULT 0,
        tecnico_id INTEGER REFERENCES usuarios(id),
        estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente', 'aprobada', 'en_curso', 'aval_entregado', 'completada', 'cancelada')),
        fuente TEXT DEFAULT 'manual' CHECK(fuente IN ('manual', 'email', 'nube', 'presupuesto', 'garantia', 'levantamiento', 'vtc')),
        archivo_presupuesto TEXT,
        notas TEXT,
        creada_por INTEGER REFERENCES usuarios(id),
        fecha_programada TEXT,
        fecha_inicio TEXT,
        fecha_fin TEXT,
        presupuesto_id INTEGER,
        creado_en TEXT DEFAULT (datetime('now', '-04:00')),
        actualizado_en TEXT DEFAULT (datetime('now', '-04:00'))
      );
    `);
  } else {
    // Check if presupuesto_id column exists
    const hasPresupuestoCol = tableInfo.some(t => t.name === 'presupuesto_id');
    if (!hasPresupuestoCol) {
      run('ALTER TABLE ordenes_trabajo ADD COLUMN presupuesto_id INTEGER');
      console.log('🔧 Columna presupuesto_id agregada a ordenes_trabajo');
    }
    const hasArchivoPresup = tableInfo.some(t => t.name === 'archivo_presupuesto');
    if (!hasArchivoPresup) {
      run("ALTER TABLE presupuestos ADD COLUMN archivo_presupuesto TEXT");
      console.log('🔧 Columna archivo_presupuesto agregada a presupuestos');
    }

    // Check if CHECK has aval_entregado
    const hasAvalEntregado = queryAll("SELECT sql FROM sqlite_master WHERE type='table' AND name='ordenes_trabajo' AND sql LIKE '%aval_entregado%'").length > 0;
    if (!hasAvalEntregado) {
      console.log('🔧 Migrando tabla ordenes_trabajo (agregando estado aval_entregado)...');
      run('DROP TABLE IF EXISTS ordenes_trabajo_old');
      run('ALTER TABLE ordenes_trabajo RENAME TO ordenes_trabajo_old');
      run(`
        CREATE TABLE ordenes_trabajo (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          numero_ot TEXT UNIQUE NOT NULL,
          cliente_id INTEGER NOT NULL REFERENCES clientes(id),
          tipo_servicio TEXT NOT NULL,
          descripcion TEXT,
          presupuesto_aprobado INTEGER DEFAULT 0,
          monto_total REAL DEFAULT 0,
          tecnico_id INTEGER REFERENCES usuarios(id),
          estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente', 'aprobada', 'en_curso', 'aval_entregado', 'completada', 'cancelada')),
          fuente TEXT DEFAULT 'manual' CHECK(fuente IN ('manual', 'email', 'nube', 'presupuesto', 'garantia', 'levantamiento', 'vtc')),
          archivo_presupuesto TEXT,
          notas TEXT,
          creada_por INTEGER REFERENCES usuarios(id),
          fecha_programada TEXT,
          fecha_inicio TEXT,
          fecha_fin TEXT,
          presupuesto_id INTEGER,
          creado_en TEXT DEFAULT (datetime('now', '-04:00')),
          actualizado_en TEXT DEFAULT (datetime('now', '-04:00'))
        );
      `);
      run('INSERT INTO ordenes_trabajo (id, numero_ot, cliente_id, tipo_servicio, descripcion, presupuesto_aprobado, monto_total, tecnico_id, estado, fuente, archivo_presupuesto, notas, creada_por, fecha_programada, fecha_inicio, fecha_fin, creado_en, actualizado_en) SELECT id, numero_ot, cliente_id, tipo_servicio, descripcion, presupuesto_aprobado, monto_total, tecnico_id, estado, fuente, archivo_presupuesto, notas, creada_por, fecha_programada, fecha_inicio, fecha_fin, creado_en, actualizado_en FROM ordenes_trabajo_old');
      run('DROP TABLE ordenes_trabajo_old');
      console.log('✅ Migración de estados completada');
    }

    // Check if CHECK on tipo_servicio exists by trying to find it
    const hasTipoCheck = queryAll("SELECT sql FROM sqlite_master WHERE type='table' AND name='ordenes_trabajo' AND sql LIKE '%CHECK(tipo_servicio IN%'").length > 0;
    if (hasTipoCheck) {
      console.log('🔧 Migrando tabla ordenes_trabajo (eliminando CHECK en tipo_servicio)...');
      run('DROP TABLE IF EXISTS ordenes_trabajo_old2');
      run('ALTER TABLE ordenes_trabajo RENAME TO ordenes_trabajo_old2');
      run(`
        CREATE TABLE ordenes_trabajo (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          numero_ot TEXT UNIQUE NOT NULL,
          cliente_id INTEGER NOT NULL REFERENCES clientes(id),
          tipo_servicio TEXT NOT NULL,
          descripcion TEXT,
          presupuesto_aprobado INTEGER DEFAULT 0,
          monto_total REAL DEFAULT 0,
          tecnico_id INTEGER REFERENCES usuarios(id),
          estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente', 'aprobada', 'en_curso', 'aval_entregado', 'completada', 'cancelada')),
          fuente TEXT DEFAULT 'manual' CHECK(fuente IN ('manual', 'email', 'nube', 'presupuesto', 'garantia', 'levantamiento', 'vtc')),
          archivo_presupuesto TEXT,
          notas TEXT,
          creada_por INTEGER REFERENCES usuarios(id),
          fecha_programada TEXT,
          fecha_inicio TEXT,
          fecha_fin TEXT,
          presupuesto_id INTEGER,
          creado_en TEXT DEFAULT (datetime('now', '-04:00')),
          actualizado_en TEXT DEFAULT (datetime('now', '-04:00'))
        );
      `);
      run('INSERT INTO ordenes_trabajo SELECT * FROM ordenes_trabajo_old2');
      run('DROP TABLE ordenes_trabajo_old2');
      console.log('✅ Migración completada');
    }
  }

  run(`
    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      categoria TEXT NOT NULL CHECK(categoria IN ('cerradura', 'puerta', 'control_acceso', 'caja_fuerte', 'ahorro_energia', 'otro')),
      descripcion TEXT,
      activo INTEGER DEFAULT 1,
      creado_en TEXT DEFAULT (datetime('now', '-04:00'))
    );
  `);
  run(`
    CREATE TABLE IF NOT EXISTS orden_trabajo_productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id),
      producto_id INTEGER NOT NULL REFERENCES productos(id),
      cantidad INTEGER DEFAULT 1
    );
  `);

  // ============ AVALES LEGACY (preserve existing data) ============
  const legacyExists = queryAll("SELECT name FROM sqlite_master WHERE type='table' AND name='avales_legacy'").length > 0;
  const avalesExists = queryAll("SELECT name FROM sqlite_master WHERE type='table' AND name='avales' AND sql LIKE '%numero_aval%'").length > 0;
  
  if (avalesExists && !legacyExists) {
    console.log('🔧 Renombrando avales legacy a avales_legacy');
    run('DROP TABLE IF EXISTS avales_legacy');
    run('ALTER TABLE avales RENAME TO avales_legacy');
  }

  if (!legacyExists) {
    run(`
      CREATE TABLE IF NOT EXISTS avales_legacy (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id),
        numero_aval TEXT UNIQUE NOT NULL,
        descripcion_trabajo TEXT,
        materiales TEXT,
        costo_total REAL DEFAULT 0,
        forma_pago TEXT,
        garantia TEXT,
        observaciones TEXT,
        estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente', 'enviado', 'firmado', 'completado')),
        archivo_pdf_generado TEXT,
        archivo_pdf_firmado TEXT,
        respuestas_digitales TEXT,
        fecha_envio_tecnico TEXT,
        fecha_firma_cliente TEXT,
        fecha_completado TEXT,
        creado_en TEXT DEFAULT (datetime('now', '-04:00')),
        actualizado_en TEXT DEFAULT (datetime('now', '-04:00'))
      );
    `);
  }

  // ============ TABLA: presupuestos ============
  run(`
    CREATE TABLE IF NOT EXISTS presupuestos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id INTEGER REFERENCES clientes(id),
      nombre_proyecto TEXT NOT NULL,
      aprobado INTEGER DEFAULT 0,
      creado_en TEXT DEFAULT (datetime('now', '-04:00'))
    );
  `);

  // ============ TABLA: avales (NUEVO FLUJO - entrega técnica) ============
  const newAvalExists = queryAll("SELECT name FROM sqlite_master WHERE type='table' AND name='avales'").length > 0;
  if (!newAvalExists) {
    run(`
      CREATE TABLE avales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id),
        tecnico_id INTEGER NOT NULL REFERENCES usuarios(id),

        -- Número de aval (relación con OT)
        numero_aval TEXT UNIQUE,

        -- Token público para compartir con el cliente
        token_publico TEXT UNIQUE,

        -- Datos del cliente (quien recibe/firma)
        cliente_nombre TEXT NOT NULL,
        cliente_contacto TEXT,
        cliente_cedula TEXT,
        cliente_telefono TEXT,
        cliente_email TEXT,

        -- Observaciones generales
        observaciones TEXT,

        -- Fechas
        fecha_entrega_tecnico TEXT DEFAULT (datetime('now', '-04:00')),
        fecha_confirmacion_admin TEXT,

        -- Estado del aval
        estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente', 'confirmado', 'rechazado', 'firmado_cliente')),

        -- Quién confirma
        confirmado_por INTEGER REFERENCES usuarios(id),

        -- Firma del cliente
        firma_cliente_data TEXT,
        fecha_firma_cliente TEXT,
        token_enviado_en TEXT,
        token_visto_en TEXT,

        -- Historial de re-firmas
        historial_firmas TEXT,
        productos_tecnico TEXT, -- JSON array de {producto_id, nombre, cantidad_reportada}
        productos_admin TEXT,   -- JSON array de {producto_id, nombre, cantidad_confirmada} (se llena al confirmar)

        creado_en TEXT DEFAULT (datetime('now', '-04:00'))
      );
    `);
  }

  // ============ TABLA: aval_productos ============
  run(`
    CREATE TABLE IF NOT EXISTS aval_productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aval_id INTEGER NOT NULL REFERENCES avales(id),
      producto_id INTEGER NOT NULL REFERENCES productos(id),
      cantidad_reportada INTEGER NOT NULL DEFAULT 0,
      cantidad_confirmada INTEGER,
      comentario TEXT,
      creado_en TEXT DEFAULT (datetime('now', '-04:00'))
    );
  `);

  // ============ ENCUESTAS ============
  const encTableInfo = queryAll("PRAGMA table_info('encuestas_satisfaccion')");
  const hasAvalLegacyId = encTableInfo.some(c => c.name === 'aval_legacy_id');
  if (encTableInfo.length > 0) {
    // Migrate to reference avales_legacy if it still references avales (old schema)
    if (!hasAvalLegacyId) {
      console.log('🔧 Migrando referencia aval_id en encuestas...');
      run('DROP TABLE IF EXISTS encuestas_satisfaccion_old');
      run('ALTER TABLE encuestas_satisfaccion RENAME TO encuestas_satisfaccion_old');
      run(`
        CREATE TABLE encuestas_satisfaccion (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id),
          aval_legacy_id INTEGER REFERENCES avales_legacy(id),
          satisfaccion_general INTEGER CHECK(satisfaccion_general BETWEEN 1 AND 5),
          tiempo_entrega INTEGER CHECK(tiempo_entrega BETWEEN 1 AND 5),
          desempeno_equipo INTEGER CHECK(desempeno_equipo BETWEEN 1 AND 5),
          presentacion_equipo INTEGER CHECK(presentacion_equipo BETWEEN 1 AND 5),
          calidad_productos INTEGER CHECK(calidad_productos BETWEEN 1 AND 5),
          conocimientos_tecnicos INTEGER CHECK(conocimientos_tecnicos BETWEEN 1 AND 5),
          calidad_entrenamientos INTEGER CHECK(calidad_entrenamientos BETWEEN 1 AND 5),
          recomendaria INTEGER CHECK(recomendaria IN (0, 1)),
          observaciones TEXT,
          porcentaje_final REAL,
          realizada_por INTEGER REFERENCES usuarios(id),
          fecha_encuesta TEXT,
          email_enviado INTEGER DEFAULT 0,
          creado_en TEXT DEFAULT (datetime('now', '-04:00'))
        );
      `);
      run('INSERT INTO encuestas_satisfaccion SELECT id, orden_trabajo_id, aval_id as aval_legacy_id, satisfaccion_general, tiempo_entrega, desempeno_equipo, presentacion_equipo, calidad_productos, conocimientos_tecnicos, calidad_entrenamientos, recomendaria, observaciones, porcentaje_final, realizada_por, fecha_encuesta, email_enviado, creado_en FROM encuestas_satisfaccion_old');
      run('DROP TABLE encuestas_satisfaccion_old');
      console.log('✅ Referencia migrada');
    }
  } else {
    run(`
      CREATE TABLE IF NOT EXISTS encuestas_satisfaccion (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id),
        aval_legacy_id INTEGER REFERENCES avales_legacy(id),
        satisfaccion_general INTEGER CHECK(satisfaccion_general BETWEEN 1 AND 5),
        tiempo_entrega INTEGER CHECK(tiempo_entrega BETWEEN 1 AND 5),
        desempeno_equipo INTEGER CHECK(desempeno_equipo BETWEEN 1 AND 5),
        presentacion_equipo INTEGER CHECK(presentacion_equipo BETWEEN 1 AND 5),
        calidad_productos INTEGER CHECK(calidad_productos BETWEEN 1 AND 5),
        conocimientos_tecnicos INTEGER CHECK(conocimientos_tecnicos BETWEEN 1 AND 5),
        calidad_entrenamientos INTEGER CHECK(calidad_entrenamientos BETWEEN 1 AND 5),
        recomendaria INTEGER CHECK(recomendaria IN (0, 1)),
        observaciones TEXT,
        porcentaje_final REAL,
        realizada_por INTEGER REFERENCES usuarios(id),
        fecha_encuesta TEXT,
        email_enviado INTEGER DEFAULT 0,
        creado_en TEXT DEFAULT (datetime('now', '-04:00'))
      );
    `);
  }

  run(`
    CREATE TABLE IF NOT EXISTS reportes_incentivos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      periodo TEXT NOT NULL,
      anio INTEGER NOT NULL,
      trimestre INTEGER NOT NULL CHECK(trimestre BETWEEN 1 AND 4),
      datos_json TEXT,
      pdf_generado TEXT,
      creado_en TEXT DEFAULT (datetime('now', '-04:00'))
    );
  `);
  // Ejecutar migraciones de columnas nuevas (para BD con datos existentes o nueva)
  await ejecutarMigraciones();

  console.log('✅ Base de datos lista');
}


async function ejecutarMigraciones() {
  console.log('🔧 Ejecutando migraciones de columnas nuevas...');
  // ═══════════════════════════════════════════════
  // ENCUESTAS DE SATISFACCIÓN — migración columnas nuevas
  // ═══════════════════════════════════════════════
  const encCols = queryAll("PRAGMA table_info('encuestas_satisfaccion')");
  const hasFechaLimite = encCols.some(c => c.name === 'fecha_limite');
  if (!hasFechaLimite) {
    run("ALTER TABLE encuestas_satisfaccion ADD COLUMN fecha_limite TEXT");
    console.log('🔧 Columna fecha_limite agregada a encuestas_satisfaccion');
  }
  const hasEstadoEnc = encCols.some(c => c.name === 'estado');
  if (!hasEstadoEnc) {
    run("ALTER TABLE encuestas_satisfaccion ADD COLUMN estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente','completada','expirada'))");
    console.log('🔧 Columna estado agregada a encuestas_satisfaccion');
  }
  const hasAvalId = encCols.some(c => c.name === 'aval_id');
  if (!hasAvalId) {
    run('ALTER TABLE encuestas_satisfaccion ADD COLUMN aval_id INTEGER REFERENCES avales(id)');
    console.log('🔧 Columna aval_id agregada a encuestas_satisfaccion');
  }
  const hasRec1 = encCols.some(c => c.name === 'recordatorio_1_enviado');
  if (!hasRec1) {
    run('ALTER TABLE encuestas_satisfaccion ADD COLUMN recordatorio_1_enviado INTEGER DEFAULT 0');
    console.log('🔧 Columna recordatorio_1_enviado agregada');
  }
  const hasRec2 = encCols.some(c => c.name === 'recordatorio_2_enviado');
  if (!hasRec2) {
    run('ALTER TABLE encuestas_satisfaccion ADD COLUMN recordatorio_2_enviado INTEGER DEFAULT 0');
    console.log('🔧 Columna recordatorio_2_enviado agregada');
  }
  const hasContactadoPor = encCols.some(c => c.name === 'contactado_por');
  if (!hasContactadoPor) {
    run('ALTER TABLE encuestas_satisfaccion ADD COLUMN contactado_por INTEGER REFERENCES usuarios(id)');
    console.log('🔧 Columna contactado_por agregada');
  }
  const hasFechaContacto = encCols.some(c => c.name === 'fecha_contacto');
  if (!hasFechaContacto) {
    run('ALTER TABLE encuestas_satisfaccion ADD COLUMN fecha_contacto TEXT');
    console.log('🔧 Columna fecha_contacto agregada');
  }
  const hasNotasContacto = encCols.some(c => c.name === 'notas_contacto');
  if (!hasNotasContacto) {
    run('ALTER TABLE encuestas_satisfaccion ADD COLUMN notas_contacto TEXT');
    console.log('🔧 Columna notas_contacto agregada');
  }
  // Token público para encuesta pública
  const hasTokenEnc = encCols.some(c => c.name === 'token_publico');
  if (!hasTokenEnc) {
    run("ALTER TABLE encuestas_satisfaccion ADD COLUMN token_publico TEXT");
    console.log('🔧 Columna token_publico agregada a encuestas_satisfaccion');
  }
  const hasNumeroEnc = encCols.some(c => c.name === 'numero_encuesta');
  if (!hasNumeroEnc) {
    run("ALTER TABLE encuestas_satisfaccion ADD COLUMN numero_encuesta TEXT");
    console.log('🔧 Columna numero_encuesta agregada a encuestas_satisfaccion');
  }
  const hasMotivoSinEnc = encCols.some(c => c.name === 'motivo_sin_encuesta');
  if (!hasMotivoSinEnc) {
    run("ALTER TABLE encuestas_satisfaccion ADD COLUMN motivo_sin_encuesta TEXT");
    console.log('🔧 Columna motivo_sin_encuesta agregada a encuestas_satisfaccion');
  }
  // respuestas JSON para encuesta pública
  const hasRespuestasData = encCols.some(c => c.name === 'respuestas_data');
  if (!hasRespuestasData) {
    run('ALTER TABLE encuestas_satisfaccion ADD COLUMN respuestas_data TEXT');
    console.log('🔧 Columna respuestas_data agregada a encuestas_satisfaccion');
  }

  // Tabla contactos_encuesta — historial de intentos de contacto
  run(`CREATE TABLE IF NOT EXISTS contactos_encuesta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    encuesta_id INTEGER NOT NULL REFERENCES encuestas_satisfaccion(id),
    contacto_por INTEGER NOT NULL REFERENCES usuarios(id),
    tipo TEXT NOT NULL DEFAULT 'telefono' CHECK(tipo IN ('telefono','whatsapp','email','visita','otro')),
    notas TEXT,
    respuesta_cliente TEXT,
    creado_en TEXT DEFAULT (datetime('now', '-04:00'))
  )`);
  console.log('🔧 Tabla contactos_encuesta creada/verificada');

  // Columna intentos en encuestas (contador de intentos)
  const hasIntentos = encCols.some(c => c.name === 'intentos');
  if (!hasIntentos) {
    run('ALTER TABLE encuestas_satisfaccion ADD COLUMN intentos INTEGER DEFAULT 0');
    console.log('🔧 Columna intentos agregada a encuestas_satisfaccion');
  }

  // ═══════════════════════════════════════════════
  // POBLAR encuestas existentes con datos faltantes
  // (avales legacy migrados que no tienen estado, token, numero_encuesta, etc.)
  // ═══════════════════════════════════════════════
  // Detectamos encuestas no pobladas porque fecha_limite IS NULL (las existentes no tenian columna)
  const encSinToken = queryAll("SELECT e.id, e.orden_trabajo_id, e.aval_legacy_id, ot.numero_ot FROM encuestas_satisfaccion e JOIN ordenes_trabajo ot ON e.orden_trabajo_id = ot.id WHERE e.fecha_limite IS NULL");
  if (encSinToken.length > 0) {
    console.log('🔧 Poblando ' + encSinToken.length + ' encuestas existentes con tokens, fechas y estados...');
    const crypto = require('crypto');
    transaction(() => {
      encSinToken.forEach(function(en) {
        var token = crypto.randomBytes(24).toString('hex');
        var numEnc = 'ENC-' + (en.numero_ot || ('OT-' + String(en.orden_trabajo_id).padStart(6, '0')));
        var hoy = new Date();
        var fd = new Date(hoy);
        fd.setDate(fd.getDate() + 3);
        var fechaLim = fd.toISOString().split('T')[0];
        run('UPDATE encuestas_satisfaccion SET estado = ?, fecha_limite = ?, token_publico = ?, numero_encuesta = ? WHERE id = ?',
          ['pendiente', fechaLim, token, numEnc, en.id]);
      });
    });
    console.log('✅ Encuestas existentes pobladas con estado, token y fecha');
  }

  // Crear encuestas para avales legacy sin encuesta asignada
  // (avales legacy completados que no tienen encuesta)
  const avalesSinEncuesta = queryAll("SELECT al.id as aval_legacy_id, al.orden_trabajo_id, ot.numero_ot FROM avales_legacy al JOIN ordenes_trabajo ot ON al.orden_trabajo_id = ot.id WHERE al.estado = 'completado' AND al.id NOT IN (SELECT COALESCE(aval_legacy_id, -1) FROM encuestas_satisfaccion WHERE aval_legacy_id IS NOT NULL)");
  if (avalesSinEncuesta.length > 0) {
    console.log('🔧 Creando ' + avalesSinEncuesta.length + ' encuestas para avales legacy sin encuesta...');
    const crypto = require('crypto');
    transaction(() => {
      avalesSinEncuesta.forEach(function(av) {
        var token = crypto.randomBytes(24).toString('hex');
        var numEnc = 'ENC-' + (av.numero_ot || av.orden_trabajo_id);
        var hoy = new Date();
        var fd = new Date(hoy);
        fd.setDate(fd.getDate() + 3);
        var fechaLim = fd.toISOString().split('T')[0];
        run('INSERT INTO encuestas_satisfaccion (orden_trabajo_id, aval_legacy_id, estado, fecha_limite, token_publico, numero_encuesta) VALUES (?, ?, ?, ?, ?, ?)',
          [av.orden_trabajo_id, av.aval_legacy_id, 'pendiente', fechaLim, token, numEnc]);
      });
    });
    console.log('✅ Encuestas creadas para avales legacy faltantes');
  }

  // ═══════════════════════════════════════════════
  // ENCUESTAS — migración: crear encuestas para avales legacy confirmados
  // ═══════════════════════════════════════════════
  // NOTA: esta migración se ejecuta DESPUÉS de restaurar el backup
  // para evitar que el backup sobreescriba las encuestas creadas.
  // Se llama desde server.js start() vía migrarEncuestasLegacy()
  console.log('📋 Encuestas legacy migración diferida hasta después del backup');

  // ═══════════════════════════════════════════════
  // AVALES v2 — migración de nuevos campos y estados
  // ═══════════════════════════════════════════════
  const avalCols = queryAll("PRAGMA table_info('avales')");

  const hasTrabajoCompletado = avalCols.some(c => c.name === 'trabajo_completado');
  if (!hasTrabajoCompletado) {
    run("ALTER TABLE avales ADD COLUMN trabajo_completado INTEGER DEFAULT 1");
    console.log('🔧 Columna trabajo_completado agregada a avales');
  }

  const hasDetalleTrabajo = avalCols.some(c => c.name === 'detalle_trabajo_real');
  if (!hasDetalleTrabajo) {
    run("ALTER TABLE avales ADD COLUMN detalle_trabajo_real TEXT");
    console.log('🔧 Columna detalle_trabajo_real agregada a avales');
  }

  const hasPenalizadoFoto = avalCols.some(c => c.name === 'penalizado_foto');
  if (!hasPenalizadoFoto) {
    run("ALTER TABLE avales ADD COLUMN penalizado_foto INTEGER DEFAULT 0");
    console.log('🔧 Columna penalizado_foto agregada a avales');
  }

  const hasSkipSurvey = avalCols.some(c => c.name === 'skip_survey');
  if (!hasSkipSurvey) {
    run("ALTER TABLE avales ADD COLUMN skip_survey INTEGER DEFAULT 0");
    console.log('🔧 Columna skip_survey agregada a avales');
  }

  const hasSkipSurveyPct = avalCols.some(c => c.name === 'skip_survey_pct');
  if (!hasSkipSurveyPct) {
    run("ALTER TABLE avales ADD COLUMN skip_survey_pct REAL");
    console.log('🔧 Columna skip_survey_pct agregada a avales');
  }

  const hasSkipSurveyMotivo = avalCols.some(c => c.name === 'skip_survey_motivo');
  if (!hasSkipSurveyMotivo) {
    run("ALTER TABLE avales ADD COLUMN skip_survey_motivo TEXT");
    console.log('🔧 Columna skip_survey_motivo agregada a avales');
  }

  const hasHistorialReconsideracion = avalCols.some(c => c.name === 'historial_reconsideracion');
  if (!hasHistorialReconsideracion) {
    run("ALTER TABLE avales ADD COLUMN historial_reconsideracion TEXT DEFAULT '[]'");
    console.log('🔧 Columna historial_reconsideracion agregada a avales');
  }

  const hasReaperturaPenalizado = avalCols.some(c => c.name === 'reapertura_penalizado');
  if (!hasReaperturaPenalizado) {
    run("ALTER TABLE avales ADD COLUMN reapertura_penalizado INTEGER DEFAULT 0");
    console.log('🔧 Columna reapertura_penalizado agregada a avales');
  }

  const hasAvalOrigen = avalCols.some(c => c.name === 'origen');
  if (!hasAvalOrigen) {
    run("ALTER TABLE avales ADD COLUMN origen TEXT DEFAULT 'instalacion'");
    console.log('🔧 Columna origen agregada a avales');
  }

  // Migrar CHECK de estado para aceptar nuevos valores
  // SQLite no permite ALTER CHECK, así que recreamos la tabla sin CHECK si está desactualizado
  const avalSql = queryAll("SELECT sql FROM sqlite_master WHERE type='table' AND name='avales'").map(r => r.sql).join('');
  const hasNewStates = avalSql.includes('rechazado_calidad') && avalSql.includes('reconsideracion') && avalSql.includes('reemplazado');
  const hasCheck = avalSql.includes('CHECK');
  
  if (hasCheck) {
    console.log('🔧 Recreando tabla avales sin CHECK constraint...');
    
    // Backup data
    const avalesData = queryAll('SELECT * FROM avales');
    const avalProductosData = queryAll('SELECT * FROM aval_productos');
    
    // Get all column names
    const allCols = avalCols.map(c => c.name);
    const colList = allCols.join(', ');
    
    run('PRAGMA foreign_keys=OFF');
    
    run('DROP TABLE IF EXISTS avales_old');
    run('DROP TABLE IF EXISTS aval_productos_old');
    run('ALTER TABLE avales RENAME TO avales_old');
    run('ALTER TABLE aval_productos RENAME TO aval_productos_old');
    
    // Create new table WITHOUT CHECK constraint
    run(`
      CREATE TABLE avales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id),
        tecnico_id INTEGER NOT NULL REFERENCES usuarios(id),
        numero_aval TEXT UNIQUE,
        token_publico TEXT UNIQUE,
        cliente_nombre TEXT NOT NULL,
        cliente_contacto TEXT,
        cliente_cedula TEXT,
        cliente_telefono TEXT,
        cliente_email TEXT,
        observaciones TEXT,
        fecha_entrega_tecnico TEXT DEFAULT (datetime('now', '-04:00')),
        fecha_confirmacion_admin TEXT,
        estado TEXT DEFAULT 'pendiente',
        confirmado_por INTEGER REFERENCES usuarios(id),
        firma_cliente_data TEXT,
        fecha_firma_cliente TEXT,
        token_enviado_en TEXT,
        token_visto_en TEXT,
        historial_firmas TEXT,
        productos_tecnico TEXT,
        productos_admin TEXT,
        creado_en TEXT DEFAULT (datetime('now', '-04:00')),
        trabajo_completado INTEGER DEFAULT 1,
        detalle_trabajo_real TEXT,
        penalizado_foto INTEGER DEFAULT 0,
        skip_survey INTEGER DEFAULT 0,
        skip_survey_pct REAL,
        skip_survey_motivo TEXT,
        historial_reconsideracion TEXT DEFAULT '[]',
        reapertura_penalizado INTEGER DEFAULT 0,
        origen TEXT DEFAULT 'instalacion'
      )
    `);
    
    run(`
      CREATE TABLE aval_productos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        aval_id INTEGER NOT NULL REFERENCES avales(id),
        producto_id INTEGER NOT NULL REFERENCES productos(id),
        cantidad_reportada INTEGER NOT NULL DEFAULT 0,
        cantidad_confirmada INTEGER,
        comentario TEXT,
        creado_en TEXT DEFAULT (datetime('now', '-04:00'))
      )
    `);
    
    // Restore data
    const placeholders = allCols.map(() => '?').join(', ');
    for (const row of avalesData) {
      const vals = allCols.map(c => row[c] !== undefined ? row[c] : null);
      run('INSERT INTO avales (' + colList + ') VALUES (' + placeholders + ')', vals);
    }
    
    if (avalProductosData.length > 0) {
      const oldProductCols = queryAll("PRAGMA table_info('aval_productos_old')").map(c => c.name);
      const pColList = oldProductCols.join(', ');
      const pPlaceholders = oldProductCols.map(() => '?').join(', ');
      for (const row of avalProductosData) {
        const vals = oldProductCols.map(c => row[c] !== undefined ? row[c] : null);
        run('INSERT INTO aval_productos (' + pColList + ') VALUES (' + pPlaceholders + ')', vals);
      }
    }
    
    run('DROP TABLE IF EXISTS avales_old');
    run('DROP TABLE IF EXISTS aval_productos_old');
    run('PRAGMA foreign_keys=ON');
    console.log('✅ Tabla avales recreada sin CHECK constraint');
  }

  // ═══════════════════════════════════════════════
  // ORDENES TRABAJO v2 — migrar estado en_revision
  // ═══════════════════════════════════════════════
  const otSql = queryAll("SELECT sql FROM sqlite_master WHERE type='table' AND name='ordenes_trabajo'").map(r => r.sql).join('');
  const hasEnRevision = otSql.includes('en_revision');
  const hasOtCheck = otSql.includes('CHECK');
  
  if (hasOtCheck) {
    console.log('🔧 Migrando tabla ordenes_trabajo (eliminando CHECK constraint)...');
    run('PRAGMA foreign_keys=OFF');
    run('DROP TABLE IF EXISTS ordenes_trabajo_v2_old');
    run('ALTER TABLE ordenes_trabajo RENAME TO ordenes_trabajo_v2_old');
    run(`
      CREATE TABLE ordenes_trabajo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        numero_ot TEXT UNIQUE NOT NULL,
        cliente_id INTEGER NOT NULL REFERENCES clientes(id),
        tipo_servicio TEXT NOT NULL,
        descripcion TEXT,
        presupuesto_aprobado INTEGER DEFAULT 0,
        monto_total REAL DEFAULT 0,
        tecnico_id INTEGER REFERENCES usuarios(id),
        estado TEXT DEFAULT 'pendiente',
        fuente TEXT DEFAULT 'manual',
        archivo_presupuesto TEXT,
        notas TEXT,
        creada_por INTEGER REFERENCES usuarios(id),
        fecha_programada TEXT,
        fecha_inicio TEXT,
        fecha_fin TEXT,
        presupuesto_id INTEGER,
        creado_en TEXT DEFAULT (datetime('now', '-04:00')),
        actualizado_en TEXT DEFAULT (datetime('now', '-04:00'))
      )
    `);
    // Copy existing data
    const otCols = queryAll("PRAGMA table_info('ordenes_trabajo_v2_old')").map(c => c.name);
    const otColList = otCols.join(', ');
    const otPlaceholders = otCols.map(() => '?').join(', ');
    const otData = queryAll('SELECT * FROM ordenes_trabajo_v2_old');
    for (const row of otData) {
      const vals = otCols.map(c => row[c] !== undefined ? row[c] : null);
      run('INSERT INTO ordenes_trabajo (' + otColList + ') VALUES (' + otPlaceholders + ')', vals);
    }
    run('DROP TABLE IF EXISTS ordenes_trabajo_v2_old');
    run('PRAGMA foreign_keys=ON');
    console.log('✅ Tabla ordenes_trabajo migrada sin CHECK constraint');
  }

  run(`
    CREATE TABLE IF NOT EXISTS configuracion_incentivos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ponderacion_tiempo_entrega REAL DEFAULT 1.5,
      ponderacion_desempeno REAL DEFAULT 1.5,
      ponderacion_conocimientos REAL DEFAULT 1.5,
      ponderacion_presentacion REAL DEFAULT 1.0,
      ponderacion_calidad_productos REAL DEFAULT 1.0,
      ponderacion_calidad_entrenamientos REAL DEFAULT 1.0,
      valor_cerradura REAL DEFAULT 150,
      valor_control_acceso REAL DEFAULT 300,
      valor_caja_fuerte REAL DEFAULT 150,
      valor_ahorro_energia REAL DEFAULT 105,
      mant_cerradura REAL DEFAULT 82.5,
      mant_caja_fuerte REAL DEFAULT 30,
      mant_ahorro_energia REAL DEFAULT 37.5,
      actualizado_en TEXT DEFAULT (datetime('now', '-04:00'))
    );
  `);

  // Config por defecto
  const cfgResult = queryFirst('SELECT id FROM configuracion_incentivos LIMIT 1');
  if (!cfgResult) {
    run('INSERT INTO configuracion_incentivos (id) VALUES (1)');
  }

  run(`
    CREATE TABLE IF NOT EXISTS configuracion_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre_empresa TEXT DEFAULT 'Mi Empresa',
      eslogan TEXT DEFAULT '',
      direccion TEXT DEFAULT '',
      telefono TEXT DEFAULT '',
      email TEXT DEFAULT '',
      website TEXT DEFAULT '',
      logo_base64 TEXT DEFAULT '',
      pie_pagina TEXT DEFAULT 'Documento generado por el sistema',
      color_primario TEXT DEFAULT '#1e40af',
      actualizado_en TEXT DEFAULT (datetime('now', '-04:00'))
    );
  `);

  // Config documentos por defecto
  const cfgDocResult = queryFirst('SELECT id FROM configuracion_documentos LIMIT 1');
  if (!cfgDocResult) {
    run("INSERT INTO configuracion_documentos (id, nombre_empresa) VALUES (1, 'DKLIC PLUS INVESTMENT')");
  }

  // ═══════════════════════════════════════════════
  // Backup desactivado — arranque siempre limpio
  // ═══════════════════════════════════════════════

  // FORZAR password del admin a 3806.Adm (por si el backup trajo un hash diferente)
  const adminForce = queryFirst('SELECT id, email FROM usuarios WHERE email = ?', ['admin@sistema.com']);
  if (adminForce) {
    const hashFijo = bcrypt.hashSync('3806.Adm', 10);
    run('UPDATE usuarios SET password = ? WHERE email = ?', [hashFijo, 'admin@sistema.com']);
    console.log('🔐 Password admin forzada a 3806.Adm');
  } else {
    // Si no existe ni siquiera el admin, crearlo
    const adminHashed = await bcrypt.hash('3806.Adm', 10);
    run("INSERT INTO usuarios (nombre, email, password, rol) VALUES (?, ?, ?, ?)",
      ['Administrador', 'admin@sistema.com', adminHashed, 'superadmin']);
    console.log('👤 Admin creado desde seed después de backup');
  }

  // Admin por defecto — solo si no hay backup que restaurar
  // (Esta sección ya no se ejecuta porque el backup se restaura arriba)

  // Siempre ejecutar seeds demo si la BD está vacía (sin clientes)
  const tieneDatosReales = (queryFirst('SELECT COUNT(*) as cnt FROM clientes')?.cnt || 0) > 0;

  if (!tieneDatosReales) {
    console.log('🌱 BD vacía — ejecutando seeds demo...');
    // Productos demo (solo si no hay productos)
    const numProductos = queryFirst('SELECT COUNT(*) as cnt FROM productos')?.cnt || 0;
    if (numProductos === 0) {
      const productosDemo = [
        ['Cerradura Eléctrica', 'cerradura', 'Cerradura eléctrica estándar para puertas'],
        ['Cerradura Electrónica', 'cerradura', 'Cerradura con teclado electrónico'],
        ['Cerradura Biométrica', 'cerradura', 'Cerradura con lector de huella'],
        ['Puerta de Metal', 'puerta', 'Puerta de metal reforzado'],
        ['Puerta de Vidrio Templado', 'puerta', 'Puerta de vidrio templado de seguridad'],
        ['Control de Acceso Pro', 'control_acceso', 'Sistema de control de acceso profesional'],
        ['Control de Acceso Básico', 'control_acceso', 'Control de acceso básico con tarjeta'],
        ['Caja Fuerte Digital', 'caja_fuerte', 'Caja fuerte digital electrónica'],
        ['Caja Fuerte Mecánica', 'caja_fuerte', 'Caja fuerte con combinación mecánica'],
        ['Sistema Ahorro Energía', 'ahorro_energia', 'Sistema inteligente de ahorro de energía'],
        ['Sensor de Movimiento', 'ahorro_energia', 'Sensor de movimiento para ahorro energético'],
      ];
      for (const p of productosDemo) {
        run('INSERT INTO productos (nombre, categoria, descripcion) VALUES (?, ?, ?)', p);
      }
      console.log('✅ Productos demo insertados');
    }

    // Seeds demo (clientes + OTs demo)
    const numClientes = queryFirst('SELECT COUNT(*) as cnt FROM clientes')?.cnt || 0;
    if (numClientes === 0) {
      await seedDemo();
    }

    // Seed orden_trabajo_productos
    const numOTProductos = queryFirst('SELECT COUNT(*) as cnt FROM orden_trabajo_productos')?.cnt || 0;
    if (numOTProductos === 0) {
      run('INSERT INTO orden_trabajo_productos (orden_trabajo_id, producto_id, cantidad) VALUES (1, 1, 1230)');
      run('INSERT INTO orden_trabajo_productos (orden_trabajo_id, producto_id, cantidad) VALUES (2, 1, 24)');
      run('INSERT INTO orden_trabajo_productos (orden_trabajo_id, producto_id, cantidad) VALUES (3, 3, 50)');
      run('INSERT INTO orden_trabajo_productos (orden_trabajo_id, producto_id, cantidad) VALUES (4, 1, 943)');
      run('INSERT INTO orden_trabajo_productos (orden_trabajo_id, producto_id, cantidad) VALUES (5, 1, 46)');
      run('INSERT INTO orden_trabajo_productos (orden_trabajo_id, producto_id, cantidad) VALUES (6, 4, 30)');
      console.log('✅ Productos-OT demo insertados');
    }
  } else {
    console.log('✅ BD con datos reales detectada — seeds demo omitidos');
  }

  // Seed presupuestos if empty
  const numPresupuestos = queryFirst('SELECT COUNT(*) as cnt FROM presupuestos')?.cnt || 0;
  if (numPresupuestos === 0) {
    run("INSERT INTO presupuestos (cliente_id, nombre_proyecto, aprobado) VALUES (1, 'SECRETS AND DREAMS MICHES', 1)");
    run("INSERT INTO presupuestos (cliente_id, nombre_proyecto, aprobado) VALUES (2, 'CASA MARINA REEF - FASE 2', 1)");
    run("INSERT INTO presupuestos (cliente_id, nombre_proyecto, aprobado) VALUES (3, 'HYATT VIVID - MANTENIMIENTO Q1', 1)");
    console.log('✅ Presupuestos demo insertados');
  }

  // Link OTs to presupuestos if not yet linked
  const otSinPresupuesto = queryFirst('SELECT COUNT(*) as cnt FROM ordenes_trabajo WHERE presupuesto_id IS NULL')?.cnt || 0;
  if (otSinPresupuesto > 0) {
    run('UPDATE ordenes_trabajo SET presupuesto_id = 1 WHERE id IN (1, 4)');
    run('UPDATE ordenes_trabajo SET presupuesto_id = 2 WHERE id IN (2)');
    run('UPDATE ordenes_trabajo SET presupuesto_id = 3 WHERE id IN (3, 5)');
    console.log('✅ OTs vinculadas a presupuestos');
  }

  // ═══════════════════════════════════════════════
  // GARANTIZAR ADMIN — después de restore o seeds
  // ═══════════════════════════════════════════════
  const adminExiste = queryFirst("SELECT id FROM usuarios WHERE email = ? LIMIT 1", ['admin@sistema.com']);
  if (!adminExiste) {
    const hashed2 = await bcrypt.hash('3806.Adm', 10);
    run("INSERT INTO usuarios (nombre, email, password, rol) VALUES (?, ?, ?, ?)",
      ['Administrador', 'admin@sistema.com', hashed2, 'superadmin']);
    console.log('👤 Admin re-creado post-restore');
  }

  // ============ TABLA: confirmacion_tokens (flujo OT via email) ============
  run(`
    CREATE TABLE IF NOT EXISTS confirmacion_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      tipo TEXT NOT NULL CHECK(tipo IN ('confirmar_fecha', 'solicitar_cambio')),
      orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id),
      tecnico_id INTEGER NOT NULL REFERENCES usuarios(id),
      fecha_propuesta TEXT,
      usado INTEGER DEFAULT 0,
      expira_en TEXT NOT NULL,
      creado_en TEXT DEFAULT (datetime('now', '-04:00'))
    );
  `);

  console.log('✅ Migraciones de columnas ejecutadas');
}



async function seedDemo() {
  console.log('🌱 Insertando datos demo...');
  const anio = new Date().getFullYear();

  transaction(() => {
    // Clientes
    run("INSERT INTO clientes (nombre, telefono, email, direccion, cedula_rnc, tipo) VALUES (?, ?, ?, ?, ?, ?)",
      ['Hotel Secrets Royal Beach', '809-555-0101', 'secrets@hotel.com', 'Punta Cana', '101-12345-6', 'empresa']);
    run("INSERT INTO clientes (nombre, telefono, email, direccion, cedula_rnc, tipo) VALUES (?, ?, ?, ?, ?, ?)",
      ['Casa Marina Reef', '809-555-0102', 'marina@reef.com', 'Bávaro', '102-23456-7', 'empresa']);
    run("INSERT INTO clientes (nombre, telefono, email, direccion, cedula_rnc, tipo) VALUES (?, ?, ?, ?, ?, ?)",
      ['Hyatt Vivid Punta Cana', '809-555-0103', 'hyatt@vivid.com', 'Cabeza de Toro', '103-34567-8', 'empresa']);
    run("INSERT INTO clientes (nombre, telefono, email, direccion, tipo) VALUES (?, ?, ?, ?, ?)",
      ['Residencial Don Alejandro', '809-555-0104', 'res@donalejandro.com', 'Santiago', 'empresa']);
    run("INSERT INTO clientes (nombre, telefono, email, direccion, tipo) VALUES (?, ?, ?, ?, ?)",
      ['Juan Pérez', '829-555-0105', 'juan@email.com', 'Santo Domingo', 'particular']);

    // Técnicos
    const tecnicos = [
      ['Máximo Vallejo', 'maximo@sistema.com', '809-100-2001'],
      ['Víctor De La Rosa', 'victor@sistema.com', '809-100-2002'],
      ['Alexander De Dios', 'alexander@sistema.com', '809-100-2003'],
      ['Ángel Pérez', 'angel@sistema.com', '809-100-2004'],
      ['Juan Samuel Encarnación', 'juansam@sistema.com', '809-100-2005'],
      ['Rosaura Nivar', 'rosaura@sistema.com', '809-100-2006'],
    ];
    const hashTec = bcrypt.hashSync('tecnico123', 10);
    for (const t of tecnicos) {
      run('INSERT INTO usuarios (nombre, email, password, rol, telefono) VALUES (?, ?, ?, ?, ?)',
        [t[0], t[1], hashTec, 'tecnico', t[2]]);
    }
    const hashSc = bcrypt.hashSync('sc123', 10);
    run("INSERT INTO usuarios (nombre, email, password, rol) VALUES (?, ?, ?, ?)",
      ['María Santos', 'maria@sistema.com', hashSc, 'servicio_cliente']);

    // Órdenes de trabajo + avales legacy + encuestas
    const ots = [
      { c: 1, t: 'instalacion', m: 101475, tec: 2, sg: 5, te: 5, de: 5, pr: 5, cp: 5, ct: 5, ce: 5, desc: 'Instalación 1230 cerraduras electrónicas - Secrets Royal Beach' },
      { c: 2, t: 'instalacion', m: 3600, tec: 3, sg: 4, te: 4, de: 4, pr: 4, cp: 5, ct: 4, ce: 4, desc: 'Instalación 24 cerraduras - Casa Marina Reef' },
      { c: 3, t: 'instalacion', m: 7500, tec: 4, sg: 5, te: 5, de: 5, pr: 5, cp: 5, ct: 5, ce: 5, desc: 'Instalación 50 cerraduras - Hyatt Vivid' },
      { c: 1, t: 'mantenimiento', m: 15000, tec: 2, sg: 4, te: 3, de: 4, pr: 4, cp: 5, ct: 4, ce: 4, desc: 'Mantenimiento preventivo 943 cerraduras' },
      { c: 3, t: 'mantenimiento', m: 6900, tec: 3, sg: 5, te: 5, de: 5, pr: 5, cp: 5, ct: 5, ce: 5, desc: 'Mantenimiento 46 cerraduras - Hyatt Vivid' },
      { c: 4, t: 'instalacion', m: 4500, tec: 5, sg: 0, desc: 'Instalación 30 cerraduras - Don Alejandro', estado: 'en_curso' },
      { c: 5, t: 'reparacion', m: 2500, tec: 6, sg: 0, desc: 'Reparación cerradura principal - Juan Pérez' },
    ];

    for (let i = 0; i < ots.length; i++) {
      const ot = ots[i];
      const num = `OT-${anio}-${String(i + 1).padStart(4, '0')}`;
      const estado = ot.sg > 0 ? 'completada' : (ot.estado || 'pendiente');
      const dia = 10 + i;
      const fecha = `${anio}-05-${String(dia).padStart(2, '0')}`;

      run(`INSERT INTO ordenes_trabajo (numero_ot, cliente_id, tipo_servicio, descripcion, monto_total, tecnico_id, estado, presupuesto_aprobado, fecha_fin, creada_por) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1)`,
        [num, ot.c, ot.t, ot.desc, ot.m, ot.tec, estado, fecha]);

      if (ot.sg > 0) {
        const avalNum = `AV-${anio}-${String(i + 1).padStart(4, '0')}`;
        run(`INSERT INTO avales_legacy (orden_trabajo_id, numero_aval, descripcion_trabajo, costo_total, estado, fecha_completado) VALUES (?, ?, ?, ?, 'pendiente', ?)`,
          [i + 1, avalNum, ot.desc, ot.m, fecha]);

        const pesos = { te: 1.5, de: 1.5, ct: 1.5, pr: 1.0, cp: 1.0, ce: 1.0 };
        const sumaPond = (ot.sg * 1.0) + (ot.te * pesos.te) + (ot.de * pesos.de) + (ot.pr * pesos.pr) + (ot.cp * pesos.cp) + (ot.ct * pesos.ct) + (ot.ce * pesos.ce);
        const sumaPesos = 1.0 + 1.5 + 1.5 + 1.0 + 1.0 + 1.5 + 1.0;
        const pct = Math.round((sumaPond / sumaPesos / 5) * 100);

        run(`INSERT INTO encuestas_satisfaccion (orden_trabajo_id, aval_legacy_id, satisfaccion_general, tiempo_entrega, desempeno_equipo, presentacion_equipo, calidad_productos, conocimientos_tecnicos, calidad_entrenamientos, recomendaria, porcentaje_final, realizada_por, fecha_encuesta, email_enviado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 8, datetime('now', '-04:00'), 1)`,
          [i + 1, i + 1, ot.sg, ot.te, ot.de, ot.pr, ot.cp, ot.ct, ot.ce, pct]);
      }
    }
  });

  console.log('✅ Datos demo insertados');
}

// ═══════════════════════════════════════════════
// Backup & Restore (persistencia en Render free tier)
// ═══════════════════════════════════════════════
// Render free tier NO tiene disco persistente.
// Cada deploy borra el archivo SQLite.
//
// Este mecanismo guarda un backup en data/backup.json
// que se restaura en el próximo deploy.
//
// SOLUCIÓN DEFINITIVA: Render Starter ($7/mes) con disk:
// Ver render.yaml

async function verificarYRestaurarBackup() {
  try {
    const { needsRestore, restoreDatabase, exportDatabase } = require('./backup-restore');

    // PASO 0: Intentar descargar backup desde FTP si el local no es válido
    try {
      const { restaurarSiNecesario } = require('./ftp-backup');
      await restaurarSiNecesario();
    } catch (ftpErr) {
      // FTP puede fallar en Render free (puerto 21 bloqueado)
      // No es crítico — continuamos con backup local o seeds
    }

    if (needsRestore()) {
      const restored = restoreDatabase();
      if (restored) {
        console.log('\u2705 Datos restaurados desde backup');
        return;
      }
    }

    // Si no se restaur\u00f3, verificar si la BD est\u00e1 vac\u00eda y forzar seeds
    const numClientes = queryFirst('SELECT COUNT(*) as cnt FROM clientes')?.cnt || 0;
    const numOTs = queryFirst('SELECT COUNT(*) as cnt FROM ordenes_trabajo')?.cnt || 0;

    if (numClientes === 0 && numOTs === 0) {
      // BD vac\u00eda sin backup viable — forzar seeds
      console.log('\ud83d\udced BD vac\u00eda sin backup viable — insertando datos seed...');
      const numProd = queryFirst('SELECT COUNT(*) as cnt FROM productos')?.cnt || 0;
      if (numProd === 0) {
        const prodDemo = [
          ['Cerradura El\u00e9ctrica', 'cerradura', 'Cerradura el\u00e9ctrica est\u00e1ndar para puertas'],
          ['Cerradura Electr\u00f3nica', 'cerradura', 'Cerradura con teclado electr\u00f3nico'],
          ['Cerradura Biom\u00e9trica', 'cerradura', 'Cerradura con lector de huella'],
          ['Puerta de Metal', 'puerta', 'Puerta de metal reforzado'],
          ['Puerta de Vidrio Templado', 'puerta', 'Puerta de vidrio templado de seguridad'],
          ['Control de Acceso Pro', 'control_acceso', 'Sistema de control de acceso profesional'],
          ['Control de Acceso B\u00e1sico', 'control_acceso', 'Control de acceso b\u00e1sico con tarjeta'],
          ['Caja Fuerte Digital', 'caja_fuerte', 'Caja fuerte digital electr\u00f3nica'],
          ['Caja Fuerte Mec\u00e1nica', 'caja_fuerte', 'Caja fuerte con combinaci\u00f3n mec\u00e1nica'],
          ['Sistema Ahorro Energ\u00eda', 'ahorro_energia', 'Sistema inteligente de ahorro de energ\u00eda'],
          ['Sensor de Movimiento', 'ahorro_energia', 'Sensor de movimiento para ahorro energ\u00e9tico'],
        ];
        for (var pi = 0; pi < prodDemo.length; pi++) {
          run('INSERT INTO productos (nombre, categoria, descripcion) VALUES (?, ?, ?)', prodDemo[pi]);
        }
        console.log('\u2705 Productos insertados (fallback)');
      }
      await seedDemo();
      console.log('\u2705 Seeds insertados exitosamente');
    }

    // Guardar backup
// ═══════════════════════════════════════════════
// MIGRACIÓN RETROACTIVA: crear encuestas para avales legacy
// Ejecutar DESPUÉS de restaurar backup (desde server.js start())
// ═══════════════════════════════════════════════
function migrarEncuestasLegacy() {
  console.log('🔍 Verificando avales legacy sin encuesta...');
  const avalesLegacySinEncuesta = queryAll(`
    SELECT al.id, al.orden_trabajo_id
    FROM avales_legacy al
    WHERE (al.estado = 'confirmado' OR al.estado = 'completado' OR al.estado = 'firmado')
      AND NOT EXISTS (
        SELECT 1 FROM encuestas_satisfaccion e
        WHERE e.orden_trabajo_id = al.orden_trabajo_id
          AND (e.aval_legacy_id = al.id)
      )
  `);
  if (avalesLegacySinEncuesta.length > 0) {
    console.log('🔧 Creando encuestas para ' + avalesLegacySinEncuesta.length + ' avales legacy confirmados sin encuesta...');
    const hoy = new Date().toISOString().split('T')[0];
    for (const al of avalesLegacySinEncuesta) {
      const tokenEnc = require('crypto').randomBytes(16).toString('hex');
      function sumarDiasHabilesMig(fechaStr, dias) {
        const fecha = new Date(fechaStr + 'T12:00:00-04:00');
        let contados = 0;
        while (contados < dias) {
          fecha.setDate(fecha.getDate() + 1);
          const diaSem = fecha.getDay();
          if (diaSem !== 0 && diaSem !== 6) contados++;
        }
        const y = fecha.getFullYear();
        const m = String(fecha.getMonth() + 1).padStart(2, '0');
        const d = String(fecha.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
      }
      const fechaLimite = sumarDiasHabilesMig(hoy, 3);
      run(`INSERT INTO encuestas_satisfaccion (orden_trabajo_id, aval_legacy_id, estado, fecha_limite, realizada_por, token_publico)
        VALUES (?, ?, 'pendiente', ?, 1, ?)`,
        [al.orden_trabajo_id, al.id, fechaLimite, tokenEnc]);
    }
    console.log('✅ ' + avalesLegacySinEncuesta.length + ' encuestas creadas para avales legacy');
  } else {
    console.log('📝 Todos los avales legacy confirmados ya tienen encuesta');
  }
}

module.exports = { initDatabase, verificarYRestaurarBackup, migrarEncuestasLegacy };
