const { queryAll, queryFirst, run, transaction } = require('./db');

async function initDatabase() {
  console.log('📦 Inicializando base de datos...');

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
        fuente TEXT DEFAULT 'manual' CHECK(fuente IN ('manual', 'email', 'nube', 'presupuesto', 'garantia', 'levantamiento')),
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
          fuente TEXT DEFAULT 'manual' CHECK(fuente IN ('manual', 'email', 'nube', 'presupuesto', 'garantia', 'levantamiento')),
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
          fuente TEXT DEFAULT 'manual' CHECK(fuente IN ('manual', 'email', 'nube', 'presupuesto', 'garantia', 'levantamiento')),
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
        estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente', 'confirmado', 'rechazado')),

        -- Quién confirma
        confirmado_por INTEGER REFERENCES usuarios(id),

        -- Auditoría: guardar el JSON que reportó el técnico vs lo que confirmó admin
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
  if (encTableInfo.length > 0) {
    // Migrate to reference avales_legacy if it references avales
    const hasAvalRef = queryAll("SELECT sql FROM sqlite_master WHERE type='table' AND name='encuestas_satisfaccion' AND sql LIKE '%REFERENCES avales%'").length > 0;
    if (hasAvalRef) {
      console.log('🔧 Migrando referencia aval_id en encuestas...');
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

  // Admin por defecto — solo si no hay backup que restaurar
  const adminRestored = queryFirst('SELECT COUNT(*) as cnt FROM usuarios')?.cnt || 0;
  if (adminRestored > 0) {
    console.log('👤 Usuarios ya restaurados desde backup, saltando seed de admin.');
  } else {
    const adminResult = queryFirst("SELECT id FROM usuarios WHERE email = ? LIMIT 1", ['admin@sistema.com']);
    if (!adminResult) {
      const bcrypt = require('bcryptjs');
      const hashed = await bcrypt.hash('3806.Adm', 10);
      run("INSERT INTO usuarios (nombre, email, password, rol) VALUES (?, ?, ?, ?)",
        ['Administrador', 'admin@sistema.com', hashed, 'superadmin']);
    }

  // ═══════════════════════════════════════════════
  // RESTAURAR BACKUP si existe — antes de insertar seeds
  // ═══════════════════════════════════════════════
  await verificarYRestaurarBackup();

  // Productos por defecto si están vacíos (después de posible restore)
  const numProductos = queryFirst('SELECT COUNT(*) as cnt FROM productos')?.cnt || 0;
  
  // ═══════════════════════════════════════════════
  // Si backup.json en el repo tiene datos reales,
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

  // Seeds demo
  const numClientes = queryFirst('SELECT COUNT(*) as cnt FROM clientes')?.cnt || 0;
  if (numClientes === 0) {
    await seedDemo();
  }

  // Seed orden_trabajo_productos if empty
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

  console.log('✅ Base de datos lista');
}

async function seedDemo() {
  console.log('🌱 Insertando datos demo...');
  const anio = new Date().getFullYear();
  const bcrypt = require('bcryptjs');

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
        run(`INSERT INTO avales_legacy (orden_trabajo_id, numero_aval, descripcion_trabajo, costo_total, estado, fecha_completado) VALUES (?, ?, ?, ?, 'completado', ?)`,
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
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('\u26a0\ufe0f Error en backup/restore:', e.message);
  }
}

module.exports = { initDatabase, verificarYRestaurarBackup };
