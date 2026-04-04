const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

// Base de datos
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============= FUNCIONES =============
const verificarToken = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Token requerido' });
  
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'llevame_secret');
    req.usuario = decoded;
    next();
  } catch(e) {
    res.status(401).json({ error: 'Token inválido' });
  }
};

// Calcular distancia y tiempo usando OpenStreetMap
async function calcularDistancia(origen, destino) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${origen.lng},${origen.lat};${destino.lng},${destino.lat}?overview=false`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.code === 'Ok') {
      const distanciaKm = data.routes[0].distance / 1000;
      const tiempoMin = data.routes[0].duration / 60;
      return { distancia: Math.round(distanciaKm * 10) / 10, tiempo: Math.round(tiempoMin) };
    }
  } catch (error) {
    console.error('Error calculando distancia:', error);
  }
  return { distancia: 5, tiempo: 10 }; // Valor por defecto
}

// Calcular precio final
async function calcularPrecioFinal(origen, destino, esperaMin = 0, desvioKm = 0, categoria = 'confort') {
  // Precios base por categoría (CUP/km)
  const preciosPorKm = {
    economico: 15,
    confort: 20,
    clasico: 25,
    lujo: 35,
    moto: 10,
    triciclo: 8
  };
  
  // Obtener configuración del admin
  const configRes = await pool.query('SELECT clave, valor FROM configuraciones');
  const config = {};
  configRes.rows.forEach(row => { config[row.clave] = row.valor; });
  
  const precioKm = preciosPorKm[categoria] || 20;
  const recargoNocturno = parseFloat(config.recargo_nocturno) || 30;
  const recargoLluvia = parseFloat(config.recargo_lluvia) || 20;
  const tarifaEspera = parseFloat(config.tarifa_espera) || 2; // CUP por minuto
  
  // Calcular distancia real
  const { distancia, tiempo } = await calcularDistancia(origen, destino);
  
  // Precio base
  let precio = distancia * precioKm;
  
  // Recargo nocturno (12am - 5am)
  const hora = new Date().getHours();
  if (hora >= 0 && hora < 5) {
    precio = precio * (1 + recargoNocturno / 100);
  }
  
  // Recargo por lluvia (si está activado)
  if (config.lluvia_activa === 'true') {
    precio = precio * (1 + recargoLluvia / 100);
  }
  
  // Tarifa por espera (después de 3 minutos gratis)
  if (esperaMin > 3) {
    precio = precio + (esperaMin - 3) * tarifaEspera;
  }
  
  // Desvíos
  if (desvioKm > 0) {
    precio = precio + (desvioKm * precioKm);
  }
  
  return {
    precio: Math.round(precio),
    distancia,
    tiempo,
    recargos: {
      nocturno: (hora >= 0 && hora < 5) ? recargoNocturno : 0,
      lluvia: config.lluvia_activa === 'true' ? recargoLluvia : 0,
      espera: esperaMin > 3 ? (esperaMin - 3) * tarifaEspera : 0,
      desvio: desvioKm * precioKm
    }
  };
}

// ============= CREAR TABLAS =============
const crearTablas = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        usuario TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        nombre TEXT NOT NULL,
        apellidos TEXT,
        ci TEXT,
        telefono TEXT UNIQUE,
        email TEXT UNIQUE,
        rol TEXT DEFAULT 'cliente',
        telefono_emergencia TEXT,
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS viajes (
        id SERIAL PRIMARY KEY,
        cliente_id INTEGER REFERENCES usuarios(id),
        chofer_id INTEGER REFERENCES usuarios(id),
        origen TEXT NOT NULL,
        destino TEXT NOT NULL,
        origen_coords JSONB,
        destino_coords JSONB,
        categoria TEXT DEFAULT 'confort',
        estado TEXT DEFAULT 'buscando_chofer',
        precio_base INTEGER,
        precio_final INTEGER,
        distancia REAL,
        tiempo_estimado INTEGER,
        espera_min INTEGER DEFAULT 0,
        desvio_km REAL DEFAULT 0,
        creado_en TIMESTAMP DEFAULT NOW(),
        aceptado_en TIMESTAMP,
        iniciado_en TIMESTAMP,
        completado_en TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS direcciones (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id),
        nombre TEXT NOT NULL,
        direccion TEXT NOT NULL,
        lat REAL,
        lng REAL,
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS calificaciones (
        id SERIAL PRIMARY KEY,
        viaje_id INTEGER REFERENCES viajes(id),
        cliente_id INTEGER REFERENCES usuarios(id),
        chofer_id INTEGER REFERENCES usuarios(id),
        puntuacion INTEGER CHECK (puntuacion >= 1 AND puntuacion <= 5),
        comentario TEXT,
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS configuraciones (
        clave TEXT PRIMARY KEY,
        valor TEXT,
        actualizado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS configuraciones_panico (
        id SERIAL PRIMARY KEY,
        telefono_llamada TEXT,
        telefono_sms TEXT,
        mensaje TEXT,
        activo BOOLEAN DEFAULT TRUE,
        actualizado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Insertar configuraciones por defecto
    await pool.query(`
      INSERT INTO configuraciones (clave, valor)
      VALUES 
        ('precio_por_km', '20'),
        ('recargo_nocturno', '30'),
        ('recargo_lluvia', '20'),
        ('tarifa_espera', '2'),
        ('lluvia_activa', 'false')
      ON CONFLICT (clave) DO NOTHING
    `);
    
    // Insertar configuración de pánico por defecto
    const panicoExistente = await pool.query('SELECT * FROM configuraciones_panico');
    if (panicoExistente.rows.length === 0) {
      await pool.query(`
        INSERT INTO configuraciones_panico (telefono_llamada, telefono_sms, mensaje)
        VALUES ('+5355555555', '+5355555555', '🚨 ALERTA DE SEGURIDAD - LLévame\n\nUsuario: {nombre}\nTeléfono: {telefono}\nUbicación: https://maps.google.com/?q={lat},{lng}\nHora: {hora}')
      `);
    }
    
    console.log('✅ Tablas creadas/verificadas');
  } catch (error) {
    console.error('Error creando tablas:', error);
  }
};
crearTablas();

// ============= ENDPOINTS DE USUARIO =============

// Registro
app.post('/api/registro', async (req, res) => {
  const { usuario, password, nombre, apellidos, ci, telefono, email, telefono_emergencia } = req.body;
  
  try {
    if (email) {
      const emailExistente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
      if (emailExistente.rows.length > 0) {
        return res.status(400).json({ error: 'El email ya está registrado' });
      }
    }
    
    if (telefono) {
      const telefonoExistente = await pool.query('SELECT id FROM usuarios WHERE telefono = $1', [telefono]);
      if (telefonoExistente.rows.length > 0) {
        return res.status(400).json({ error: 'El teléfono ya está registrado' });
      }
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (usuario, password, nombre, apellidos, ci, telefono, email, telefono_emergencia)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, usuario, nombre, apellidos, rol, telefono_emergencia`,
      [usuario, passwordHash, nombre, apellidos, ci, telefono || null, email || null, telefono_emergencia || null]
    );
    
    const token = jwt.sign(
      { id: result.rows[0].id, usuario: result.rows[0].usuario, rol: result.rows[0].rol },
      process.env.JWT_SECRET || 'llevame_secret',
      { expiresIn: '7d' }
    );
    
    res.json({ exito: true, token, usuario: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      res.status(400).json({ error: 'El usuario ya existe' });
    } else {
      res.status(500).json({ error: 'Error al registrar' });
    }
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE usuario = $1', [usuario]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    
    const usuarioDB = result.rows[0];
    const validPassword = await bcrypt.compare(password, usuarioDB.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    
    const token = jwt.sign(
      { id: usuarioDB.id, usuario: usuarioDB.usuario, rol: usuarioDB.rol },
      process.env.JWT_SECRET || 'llevame_secret',
      { expiresIn: '7d' }
    );
    
    res.json({
      exito: true,
      token,
      usuario: {
        id: usuarioDB.id,
        usuario: usuarioDB.usuario,
        nombre: usuarioDB.nombre,
        apellidos: usuarioDB.apellidos,
        ci: usuarioDB.ci,
        telefono: usuarioDB.telefono,
        email: usuarioDB.email,
        rol: usuarioDB.rol,
        telefono_emergencia: usuarioDB.telefono_emergencia
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// Obtener perfil
app.get('/api/perfil', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, usuario, nombre, apellidos, ci, telefono, email, rol, telefono_emergencia FROM usuarios WHERE id = $1',
      [req.usuario.id]
    );
    res.json({ usuario: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

// Actualizar perfil
app.put('/api/perfil', verificarToken, async (req, res) => {
  const { nombre, telefono, email, telefono_emergencia } = req.body;
  
  try {
    if (email) {
      const emailExistente = await pool.query('SELECT id FROM usuarios WHERE email = $1 AND id != $2', [email, req.usuario.id]);
      if (emailExistente.rows.length > 0) {
        return res.status(400).json({ error: 'El email ya está registrado' });
      }
    }
    
    if (telefono) {
      const telefonoExistente = await pool.query('SELECT id FROM usuarios WHERE telefono = $1 AND id != $2', [telefono, req.usuario.id]);
      if (telefonoExistente.rows.length > 0) {
        return res.status(400).json({ error: 'El teléfono ya está registrado' });
      }
    }
    
    await pool.query(
      `UPDATE usuarios SET 
        nombre = COALESCE($1, nombre), 
        telefono = COALESCE($2, telefono), 
        email = COALESCE($3, email),
        telefono_emergencia = COALESCE($4, telefono_emergencia)
       WHERE id = $5`,
      [nombre, telefono, email, telefono_emergencia, req.usuario.id]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});

// ============= ENDPOINTS DE VIAJES =============

// Solicitar viaje (con cálculo de precio real)
app.post('/api/viajes/solicitar', verificarToken, async (req, res) => {
  const { origen, destino, origen_coords, destino_coords, categoria } = req.body;
  
  try {
    const precioData = await calcularPrecioFinal(origen_coords, destino_coords, 0, 0, categoria);
    
    const result = await pool.query(
      `INSERT INTO viajes (cliente_id, origen, destino, origen_coords, destino_coords, categoria, estado, precio_base, distancia, tiempo_estimado, creado_en)
       VALUES ($1, $2, $3, $4, $5, $6, 'buscando_chofer', $7, $8, $9, NOW())
       RETURNING *`,
      [req.usuario.id, origen, destino, JSON.stringify(origen_coords), JSON.stringify(destino_coords), categoria, precioData.precio, precioData.distancia, precioData.tiempo]
    );
    
    res.json({ exito: true, viaje: result.rows[0], precio_detalle: precioData.recargos });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al solicitar viaje' });
  }
});

// Calcular precio antes de solicitar
app.post('/api/viajes/calcular-precio', verificarToken, async (req, res) => {
  const { origen_coords, destino_coords, categoria, espera_min, desvio_km } = req.body;
  
  try {
    const precioData = await calcularPrecioFinal(origen_coords, destino_coords, espera_min || 0, desvio_km || 0, categoria);
    res.json(precioData);
  } catch (error) {
    res.status(500).json({ error: 'Error al calcular precio' });
  }
});

// Obtener estado del viaje
app.get('/api/viajes/estado/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT v.*, u.telefono as chofer_telefono, u.nombre as chofer_nombre 
       FROM viajes v
       LEFT JOIN usuarios u ON v.chofer_id = u.id
       WHERE v.id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Viaje no encontrado' });
    }
    res.json({ viaje: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estado' });
  }
});

// Cancelar viaje
app.post('/api/viajes/cancelar/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(
      "UPDATE viajes SET estado = 'cancelado' WHERE id = $1 AND cliente_id = $2 AND estado IN ('buscando_chofer', 'aceptado')",
      [id, req.usuario.id]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al cancelar viaje' });
  }
});

// Obtener viajes del cliente
app.get('/api/viajes/mis-viajes', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM viajes WHERE cliente_id = $1 ORDER BY creado_en DESC',
      [req.usuario.id]
    );
    res.json({ viajes: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener viajes' });
  }
});

// Calificar viaje
app.post('/api/viajes/calificar/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  const { puntuacion, comentario } = req.body;
  
  try {
    const viaje = await pool.query('SELECT * FROM viajes WHERE id = $1 AND cliente_id = $2', [id, req.usuario.id]);
    if (viaje.rows.length === 0) {
      return res.status(404).json({ error: 'Viaje no encontrado' });
    }
    
    await pool.query(
      `INSERT INTO calificaciones (viaje_id, cliente_id, chofer_id, puntuacion, comentario)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, req.usuario.id, viaje.rows[0].chofer_id, puntuacion, comentario]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al calificar viaje' });
  }
});

// ============= ENDPOINTS DE DIRECCIONES =============

app.get('/api/direcciones', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM direcciones WHERE usuario_id = $1 ORDER BY creado_en DESC', [req.usuario.id]);
    res.json({ direcciones: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener direcciones' });
  }
});

app.post('/api/direcciones', verificarToken, async (req, res) => {
  const { nombre, direccion, lat, lng } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO direcciones (usuario_id, nombre, direccion, lat, lng) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.usuario.id, nombre, direccion, lat || null, lng || null]
    );
    res.json({ exito: true, direccion: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al agregar dirección' });
  }
});

app.delete('/api/direcciones/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM direcciones WHERE id = $1 AND usuario_id = $2', [id, req.usuario.id]);
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar dirección' });
  }
});

// ============= ENDPOINTS DE PÁNICO =============

// Configuración de pánico (solo admin)
app.get('/api/panico/config', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM configuraciones_panico WHERE id = 1');
    res.json({ config: result.rows[0] || {} });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener configuración' });
  }
});

// Activar pánico (envía SMS y llama)
app.post('/api/panico/activar', verificarToken, async (req, res) => {
  const { lat, lng } = req.body;
  
  try {
    // Obtener datos del usuario
    const usuario = await pool.query('SELECT nombre, telefono, telefono_emergencia FROM usuarios WHERE id = $1', [req.usuario.id]);
    const config = await pool.query('SELECT * FROM configuraciones_panico WHERE id = 1');
    
    if (!config.rows[0] || !config.rows[0].activo) {
      return res.json({ exito: true, mensaje: 'Sistema de pánico desactivado por el administrador' });
    }
    
    const conf = config.rows[0];
    const nombre = usuario.rows[0].nombre;
    const telefono = usuario.rows[0].telefono || 'No registrado';
    const telefonoEmergencia = usuario.rows[0].telefono_emergencia;
    
    // Preparar mensaje
    let mensaje = conf.mensaje
      .replace('{nombre}', nombre)
      .replace('{telefono}', telefono)
      .replace('{lat}', lat)
      .replace('{lng}', lng)
      .replace('{hora}', new Date().toLocaleString());
    
    const mapsUrl = `https://maps.google.com/?q=${lat},${lng}`;
    mensaje += `\n\n📍 Ver en mapa: ${mapsUrl}`;
    
    // Aquí se integraría con un servicio de SMS (Twilio, etc.)
    // Por ahora guardamos el registro
    await pool.query(`
      INSERT INTO logs_panico (usuario_id, lat, lng, mensaje, telefono_llamada, telefono_sms, creado_en)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [req.usuario.id, lat, lng, mensaje, conf.telefono_llamada, conf.telefono_sms]);
    
    res.json({ 
      exito: true, 
      mensaje: 'Alerta de pánico activada',
      llamar_a: conf.telefono_llamada,
      sms_a: conf.telefono_sms
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al activar pánico' });
  }
});

// ============= ENDPOINTS DE ADMIN =============

// Obtener configuración
app.get('/admin/configuracion', verificarToken, async (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  try {
    const result = await pool.query('SELECT * FROM configuraciones');
    const config = {};
    result.rows.forEach(row => { config[row.clave] = row.valor; });
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener configuración' });
  }
});

// Actualizar configuración
app.post('/admin/configuracion', verificarToken, async (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  const { clave, valor } = req.body;
  try {
    await pool.query(
      'INSERT INTO configuraciones (clave, valor, actualizado_en) VALUES ($1, $2, NOW()) ON CONFLICT (clave) DO UPDATE SET valor = $2, actualizado_en = NOW()',
      [clave, valor]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al guardar configuración' });
  }
});

// Actualizar configuración de pánico
app.post('/admin/panico/config', verificarToken, async (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  const { telefono_llamada, telefono_sms, mensaje, activo } = req.body;
  try {
    await pool.query(`
      UPDATE configuraciones_panico 
      SET telefono_llamada = $1, telefono_sms = $2, mensaje = $3, activo = $4, actualizado_en = NOW()
      WHERE id = 1
    `, [telefono_llamada, telefono_sms, mensaje, activo]);
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al guardar configuración' });
  }
});

// Ruta raíz
app.get('/', (req, res) => {
  res.json({ mensaje: '🚕 LLévame API funcionando', version: '3.0' });
});

// Panel admin (HTML)
app.get('/admin/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>LLévame - Admin</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: system-ui, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .login-card { background: white; padding: 40px; border-radius: 20px; width: 100%; max-width: 400px; }
        h1 { text-align: center; color: #FF9800; margin-bottom: 30px; }
        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 8px; }
        button { width: 100%; padding: 12px; background: #FF9800; color: white; border: none; border-radius: 8px; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="login-card">
        <h1>🚕 LLévame - Admin</h1>
        <form id="loginForm">
          <input type="text" id="username" placeholder="Usuario" required>
          <input type="password" id="password" placeholder="Contraseña" required>
          <button type="submit">Iniciar sesión</button>
        </form>
      </div>
      <script>
        document.getElementById('loginForm').onsubmit = async (e) => {
          e.preventDefault();
          const usuario = document.getElementById('username').value;
          const password = document.getElementById('password').value;
          const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario, password }) });
          const data = await res.json();
          if (data.token && data.usuario.rol === 'admin') {
            localStorage.setItem('token', data.token);
            window.location.href = '/admin/dashboard';
          } else { alert('Credenciales inválidas o no eres administrador'); }
        };
      </script>
    </body>
    </html>
  `);
});

app.get('/admin/dashboard', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>LLévame - Dashboard</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: system-ui, sans-serif; background: #f5f5f5; padding: 20px; }
        .header { background: #FF9800; color: white; padding: 20px; border-radius: 15px; margin-bottom: 20px; display: flex; justify-content: space-between; }
        .card { background: white; padding: 20px; border-radius: 15px; margin-bottom: 20px; }
        .config-group { margin-bottom: 15px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
        .config-group label { width: 200px; font-weight: bold; }
        .config-group input, .config-group select { padding: 8px; border: 1px solid #ddd; border-radius: 5px; flex: 1; max-width: 200px; }
        button { background: #FF9800; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
        .logout { background: #f44336; }
        h3 { margin-bottom: 15px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🚕 LLévame - Panel Admin</h1>
        <button class="logout" onclick="logout()">Cerrar sesión</button>
      </div>
      
      <div class="card">
        <h3>💰 Configuración de precios</h3>
        <div class="config-group">
          <label>Recargo nocturno (%):</label>
          <input type="number" id="recargo_nocturno" step="5">
        </div>
        <div class="config-group">
          <label>Recargo lluvia (%):</label>
          <input type="number" id="recargo_lluvia" step="5">
          <button onclick="activarLluvia()">🌧 Activar lluvia ahora</button>
        </div>
        <div class="config-group">
          <label>Tarifa espera (CUP/min):</label>
          <input type="number" id="tarifa_espera" step="0.5">
        </div>
        <button onclick="guardarConfiguracion()">Guardar configuración</button>
      </div>
      
      <div class="card">
        <h3>🆘 Configuración de Pánico</h3>
        <div class="config-group">
          <label>Teléfono para llamar:</label>
          <input type="tel" id="telefono_llamada" placeholder="+5355555555">
        </div>
        <div class="config-group">
          <label>Teléfono para SMS:</label>
          <input type="tel" id="telefono_sms" placeholder="+5355555555">
        </div>
        <div class="config-group">
          <label>Mensaje personalizado:</label>
          <textarea id="mensaje_panico" rows="3" style="width:100%; padding:8px;"></textarea>
        </div>
        <div class="config-group">
          <label>Sistema activo:</label>
          <select id="panico_activo">
            <option value="true">Activo</option>
            <option value="false">Inactivo</option>
          </select>
        </div>
        <button onclick="guardarConfiguracionPanico()">Guardar configuración de pánico</button>
      </div>
      
      <script>
        const token = localStorage.getItem('token');
        if (!token) window.location.href = '/admin/login';
        
        async function fetchAPI(url, options = {}) {
          const res = await fetch(url, {
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            ...options
          });
          if (res.status === 401) { logout(); }
          return res.json();
        }
        
        async function cargarConfiguracion() {
          const config = await fetchAPI('/admin/configuracion');
          document.getElementById('recargo_nocturno').value = config.recargo_nocturno || '30';
          document.getElementById('recargo_lluvia').value = config.recargo_lluvia || '20';
          document.getElementById('tarifa_espera').value = config.tarifa_espera || '2';
        }
        
        async function cargarConfiguracionPanico() {
          const res = await fetch('/api/panico/config', { headers: { 'Authorization': 'Bearer ' + token } });
          const data = await res.json();
          if (data.config) {
            document.getElementById('telefono_llamada').value = data.config.telefono_llamada || '';
            document.getElementById('telefono_sms').value = data.config.telefono_sms || '';
            document.getElementById('mensaje_panico').value = data.config.mensaje || '';
            document.getElementById('panico_activo').value = data.config.activo ? 'true' : 'false';
          }
        }
        
        async function guardarConfiguracion() {
          const configs = ['recargo_nocturno', 'recargo_lluvia', 'tarifa_espera'];
          for (const clave of configs) {
            const input = document.getElementById(clave);
            if (input) {
              await fetchAPI('/admin/configuracion', { method: 'POST', body: JSON.stringify({ clave, valor: input.value }) });
            }
          }
          alert('Configuración guardada');
        }
        
        async function guardarConfiguracionPanico() {
          const data = {
            telefono_llamada: document.getElementById('telefono_llamada').value,
            telefono_sms: document.getElementById('telefono_sms').value,
            mensaje: document.getElementById('mensaje_panico').value,
            activo: document.getElementById('panico_activo').value === 'true'
          };
          await fetch('/admin/panico/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data) });
          alert('Configuración de pánico guardada');
        }
        
        function activarLluvia() {
          fetchAPI('/admin/configuracion', { method: 'POST', body: JSON.stringify({ clave: 'lluvia_activa', valor: 'true' }) });
          alert('Modo lluvia activado');
        }
        
        function logout() { localStorage.removeItem('token'); window.location.href = '/admin/login'; }
        
        cargarConfiguracion();
        cargarConfiguracionPanico();
      </script>
    </body>
    </html>
  `);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚕 LLévame API corriendo en puerto ${PORT}`);
});
