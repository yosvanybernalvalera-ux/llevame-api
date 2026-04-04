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
        estado_chofer TEXT DEFAULT 'disponible',
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vehiculos (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER UNIQUE REFERENCES usuarios(id),
        tipo TEXT NOT NULL,
        marca_modelo TEXT,
        color TEXT,
        matricula TEXT,
        categorias JSONB,
        aprobado BOOLEAN DEFAULT FALSE,
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
        categoria TEXT DEFAULT 'confort',
        estado TEXT DEFAULT 'buscando_chofer',
        precio_base INTEGER,
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS direcciones (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id),
        nombre TEXT NOT NULL,
        direccion TEXT NOT NULL,
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS configuraciones (
        clave TEXT PRIMARY KEY,
        valor TEXT
      )
    `);
    
    await pool.query(`
      INSERT INTO configuraciones (clave, valor)
      VALUES 
        ('recargo_nocturno', '30'),
        ('recargo_lluvia', '20'),
        ('tarifa_espera', '2')
      ON CONFLICT (clave) DO NOTHING
    `);
    
    console.log('Tablas creadas');
  } catch (error) {
    console.error('Error:', error);
  }
};
crearTablas();

// ============= ENDPOINTS USUARIOS =============
app.post('/api/registro', async (req, res) => {
  const { usuario, password, nombre, apellidos, ci, telefono, email, telefono_emergencia } = req.body;
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (usuario, password, nombre, apellidos, ci, telefono, email, telefono_emergencia)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, usuario, nombre, apellidos, rol, telefono_emergencia`,
      [usuario, passwordHash, nombre, apellidos, ci, telefono, email, telefono_emergencia]
    );
    const token = jwt.sign(
      { id: result.rows[0].id, usuario: result.rows[0].usuario, rol: result.rows[0].rol },
      process.env.JWT_SECRET || 'llevame_secret',
      { expiresIn: '7d' }
    );
    res.json({ exito: true, token, usuario: result.rows[0] });
  } catch (error) {
    res.status(400).json({ error: 'Error al registrar' });
  }
});

app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE usuario = $1', [usuario]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Usuario incorrecto' });
    const usuarioDB = result.rows[0];
    const validPassword = await bcrypt.compare(password, usuarioDB.password);
    if (!validPassword) return res.status(401).json({ error: 'Contraseña incorrecta' });
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
    res.status(500).json({ error: 'Error al iniciar sesion' });
  }
});

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

app.put('/api/perfil', verificarToken, async (req, res) => {
  const { nombre, telefono, email, telefono_emergencia } = req.body;
  try {
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
    res.status(500).json({ error: 'Error al actualizar' });
  }
});

// ============= ENDPOINTS CHOFER =============

// Registrar/actualizar vehículo
app.post('/api/chofer/vehiculo', verificarToken, async (req, res) => {
  console.log('Recibida petición de vehículo:', req.body);
  const { tipo, marca_modelo, color, matricula, categorias } = req.body;
  
  try {
    const existente = await pool.query('SELECT * FROM vehiculos WHERE usuario_id = $1', [req.usuario.id]);
    
    if (existente.rows.length > 0) {
      await pool.query(
        `UPDATE vehiculos SET tipo = $1, marca_modelo = $2, color = $3, matricula = $4, categorias = $5, aprobado = FALSE
         WHERE usuario_id = $6`,
        [tipo, marca_modelo, color, matricula, JSON.stringify(categorias), req.usuario.id]
      );
    } else {
      await pool.query(
        `INSERT INTO vehiculos (usuario_id, tipo, marca_modelo, color, matricula, categorias, aprobado)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE)`,
        [req.usuario.id, tipo, marca_modelo, color, matricula, JSON.stringify(categorias)]
      );
    }
    
    await pool.query("UPDATE usuarios SET rol = 'chofer' WHERE id = $1 AND rol = 'cliente'", [req.usuario.id]);
    
    res.json({ exito: true, mensaje: 'Vehículo registrado. Espera aprobación del administrador' });
  } catch (error) {
    console.error('Error al guardar vehículo:', error);
    res.status(500).json({ error: 'Error al registrar vehículo: ' + error.message });
  }
});

// Obtener vehículo del chofer
app.get('/api/chofer/vehiculo', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vehiculos WHERE usuario_id = $1', [req.usuario.id]);
    res.json({ vehiculo: result.rows[0] || null });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener vehículo' });
  }
});

// Actualizar ubicación del chofer (NUEVO ENDPOINT)
app.post('/api/chofer/ubicacion', verificarToken, async (req, res) => {
  const { lat, lng } = req.body;
  try {
    await pool.query(
      'UPDATE usuarios SET ultima_ubicacion_lat = $1, ultima_ubicacion_lng = $2 WHERE id = $3',
      [lat, lng, req.usuario.id]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar ubicación' });
  }
});

// Obtener viajes disponibles
app.get('/api/chofer/viajes-disponibles', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT v.*, u.nombre as cliente_nombre 
       FROM viajes v
       JOIN usuarios u ON v.cliente_id = u.id
       WHERE v.estado = 'buscando_chofer'
       ORDER BY v.creado_en ASC`
    );
    res.json({ viajes: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener viajes' });
  }
});

// Aceptar viaje
app.post('/api/chofer/aceptar-viaje', verificarToken, async (req, res) => {
  const { viaje_id } = req.body;
  try {
    await pool.query(
      'UPDATE viajes SET chofer_id = $1, estado = $2 WHERE id = $3',
      [req.usuario.id, 'aceptado', viaje_id]
    );
    await pool.query("UPDATE usuarios SET estado_chofer = 'ocupado' WHERE id = $1", [req.usuario.id]);
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al aceptar viaje' });
  }
});

// Iniciar viaje
app.post('/api/chofer/iniciar-viaje/:viaje_id', verificarToken, async (req, res) => {
  const { viaje_id } = req.params;
  try {
    await pool.query('UPDATE viajes SET estado = $1 WHERE id = $2', ['en_curso', viaje_id]);
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al iniciar viaje' });
  }
});

// Finalizar viaje
app.post('/api/chofer/finalizar-viaje/:viaje_id', verificarToken, async (req, res) => {
  const { viaje_id } = req.params;
  const { precio_final } = req.body;
  try {
    await pool.query(
      'UPDATE viajes SET estado = $1, precio_final = $2 WHERE id = $3',
      ['completado', precio_final, viaje_id]
    );
    await pool.query("UPDATE usuarios SET estado_chofer = 'disponible' WHERE id = $1", [req.usuario.id]);
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al finalizar viaje' });
  }
});

// Mis viajes (historial)
app.get('/api/chofer/mis-viajes', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM viajes WHERE chofer_id = $1 ORDER BY creado_en DESC',
      [req.usuario.id]
    );
    res.json({ viajes: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

// Ganancias
app.get('/api/chofer/ganancias', verificarToken, async (req, res) => {
  try {
    const hoy = await pool.query(
      "SELECT COALESCE(SUM(precio_final), 0) as total FROM viajes WHERE chofer_id = $1 AND estado = 'completado' AND DATE(creado_en) = CURRENT_DATE",
      [req.usuario.id]
    );
    const semana = await pool.query(
      "SELECT COALESCE(SUM(precio_final), 0) as total FROM viajes WHERE chofer_id = $1 AND estado = 'completado' AND creado_en >= NOW() - INTERVAL '7 days'",
      [req.usuario.id]
    );
    res.json({ hoy: parseInt(hoy.rows[0].total), semana: parseInt(semana.rows[0].total) });
  } catch (error) {
    res.json({ hoy: 0, semana: 0 });
  }
});

// ============= ENDPOINTS DIRECCIONES =============
app.get('/api/direcciones', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM direcciones WHERE usuario_id = $1', [req.usuario.id]);
    res.json({ direcciones: result.rows });
  } catch (error) {
    res.json({ direcciones: [] });
  }
});

app.post('/api/direcciones', verificarToken, async (req, res) => {
  const { nombre, direccion } = req.body;
  try {
    await pool.query(
      'INSERT INTO direcciones (usuario_id, nombre, direccion) VALUES ($1, $2, $3)',
      [req.usuario.id, nombre, direccion]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al guardar dirección' });
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

// ============= RUTAS =============
app.get('/', (req, res) => {
  res.json({ mensaje: 'LLévame API funcionando' });
});

// Panel admin
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
        body { font-family: system-ui; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .login-card { background: white; padding: 40px; border-radius: 20px; width: 100%; max-width: 400px; }
        h1 { text-align: center; color: #FF9800; margin-bottom: 30px; }
        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 8px; }
        button { width: 100%; padding: 12px; background: #FF9800; color: white; border: none; border-radius: 8px; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="login-card">
        <h1>LLévame - Admin</h1>
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
          } else { alert('Credenciales inválidas'); }
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
        body { font-family: system-ui; background: #f5f5f5; padding: 20px; }
        .header { background: #FF9800; color: white; padding: 20px; border-radius: 15px; margin-bottom: 20px; display: flex; justify-content: space-between; }
        .card { background: white; padding: 20px; border-radius: 15px; margin-bottom: 20px; }
        button { background: #FF9800; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
        .logout { background: #f44336; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>LLévame - Panel Admin</h1>
        <button class="logout" onclick="logout()">Cerrar sesión</button>
      </div>
      <div class="card">
        <h3>Choferes pendientes de aprobación</h3>
        <div id="pendientes">Cargando...</div>
      </div>
      <script>
        const token = localStorage.getItem('token');
        if (!token) window.location.href = '/admin/login';
        
        async function cargarPendientes() {
          const res = await fetch('/admin/choferes/pendientes', { headers: { 'Authorization': 'Bearer ' + token } });
          const data = await res.json();
          const pendientes = data.choferes || [];
          if (pendientes.length === 0) {
            document.getElementById('pendientes').innerHTML = '<p>No hay choferes pendientes</p>';
          } else {
            let html = '';
            for (const c of pendientes) {
              html += '<div style="padding:10px; border-bottom:1px solid #eee;">';
              html += '<strong>' + c.nombre + '</strong><br>';
              html += 'Vehículo: ' + (c.marca_modelo || c.tipo) + '<br>';
              html += 'Matrícula: ' + (c.matricula || '-') + '<br>';
              html += '<button onclick="aprobar(' + c.usuario_id + ')">Aprobar</button>';
              html += '</div>';
            }
            document.getElementById('pendientes').innerHTML = html;
          }
        }
        
        async function aprobar(id) {
          await fetch('/admin/choferes/aprobar/' + id, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
          cargarPendientes();
        }
        
        function logout() { localStorage.removeItem('token'); window.location.href = '/admin/login'; }
        
        cargarPendientes();
      </script>
    </body>
    </html>
  `);
});

// Admin endpoints
app.get('/admin/choferes/pendientes', verificarToken, async (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  try {
    const result = await pool.query(`
      SELECT u.id as usuario_id, u.nombre, u.apellidos, v.*
      FROM usuarios u
      JOIN vehiculos v ON u.id = v.usuario_id
      WHERE v.aprobado = FALSE
    `);
    res.json({ choferes: result.rows });
  } catch (error) {
    res.json({ choferes: [] });
  }
});

app.post('/admin/choferes/aprobar/:id', verificarToken, async (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  const { id } = req.params;
  await pool.query('UPDATE vehiculos SET aprobado = TRUE WHERE usuario_id = $1', [id]);
  res.json({ exito: true });
});

// ============= ENDPOINT TEMPORAL PARA CREAR TABLAS =============
app.post('/admin/crear-tablas', verificarToken, async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vehiculos (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER UNIQUE,
        tipo TEXT,
        marca_modelo TEXT,
        color TEXT,
        matricula TEXT,
        categorias JSONB,
        aprobado BOOLEAN DEFAULT FALSE,
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    res.json({ exito: true, mensaje: 'Tabla vehiculos creada correctamente' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
