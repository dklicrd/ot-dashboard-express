const { queryAll, queryFirst, run, transaction } = require('./db');

async function initDatabase() {
  console.log('📦 Inicializando base de datos...');

  run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      rol TEXT NOT NULL CHECK(rol IN ('admin', 'tecnico', 'servicio_cliente')),
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
  run(`
    CREATE TABLE IF NOT EXISTS ordenes_trabajo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_ot TEXT UNIQUE NOT NULL,
      cliente_id INTEGER NOT NULL REFERENCES clientes(id),
      tipo_servicio TEXT NOT NULL CHECK(tipo_servicio IN ('instalacion', 'mantenimiento', 'reparacion', 'garantia', 'levantamiento')),
      descripcion TEXT,
      presupuesto_aprobado INTEGER DEFAULT 0,
      monto_total REAL DEFAULT 0,
      tecnico_id INTEGER REFERENCES usuarios(id),
      estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente', 'aprobada', 'en_curso', 'completada', 'cancelada')),
      fuente TEXT DEFAULT 'manual' CHECK(fuente IN ('manual', 'email', 'nube')),
      archivo_presupuesto TEXT,
      notas TEXT,
      creada_por INTEGER REFERENCES usuarios(id),
      fecha_programada TEXT,
      fecha_inicio TEXT,
      fecha_fin TEXT,
      creado_en TEXT DEFAULT (datetime('now', '-04:00')),
      actualizado_en TEXT DEFAULT (datetime('now', '-04:00'))
    );
  `);
  run(`
    CREATE TABLE IF NOT EXISTS avales (
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
  run(`
    CREATE TABLE IF NOT EXISTS encuestas_satisfaccion (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id),
      aval_id INTEGER REFERENCES avales(id),
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

  // Admin por defecto
  const adminResult = queryFirst("SELECT id FROM usuarios WHERE email = ? LIMIT 1", ['admin@sistema.com']);
  if (!adminResult) {
    const bcrypt = require('bcryptjs');
    const hashed = await bcrypt.hash('admin123', 10);
    run("INSERT INTO usuarios (nombre, email, password, rol) VALUES (?, ?, ?, ?)",
      ['Administrador', 'admin@sistema.com', hashed, 'admin']);
  }

  // Datos demo si no hay clientes
  const numClientes = queryFirst('SELECT COUNT(*) as cnt FROM clientes')?.cnt || 0;

  if (numClientes === 0) {
    seedDemo();
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

    // Órdenes de trabajo + avales + encuestas
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
        run(`INSERT INTO avales (orden_trabajo_id, numero_aval, descripcion_trabajo, costo_total, estado, fecha_completado) VALUES (?, ?, ?, ?, 'completado', ?)`,
          [i + 1, avalNum, ot.desc, ot.m, fecha]);

        const pesos = { te: 1.5, de: 1.5, ct: 1.5, pr: 1.0, cp: 1.0, ce: 1.0 };
        const sumaPond = (ot.sg * 1.0) + (ot.te * pesos.te) + (ot.de * pesos.de) + (ot.pr * pesos.pr) + (ot.cp * pesos.cp) + (ot.ct * pesos.ct) + (ot.ce * pesos.ce);
        const sumaPesos = 1.0 + 1.5 + 1.5 + 1.0 + 1.0 + 1.5 + 1.0;
        const pct = Math.round((sumaPond / sumaPesos / 5) * 100);

        run(`INSERT INTO encuestas_satisfaccion (orden_trabajo_id, satisfaccion_general, tiempo_entrega, desempeno_equipo, presentacion_equipo, calidad_productos, conocimientos_tecnicos, calidad_entrenamientos, recomendaria, porcentaje_final, realizada_por, fecha_encuesta, email_enviado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 8, datetime('now', '-04:00'), 1)`,
          [i + 1, ot.sg, ot.te, ot.de, ot.pr, ot.cp, ot.ct, ot.ce, pct]);
      }
    }
  });

  console.log('✅ Datos demo insertados');
}

module.exports = { initDatabase };
