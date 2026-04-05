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
        origen_lat REAL,
        origen_lng REAL,
        destino_lat REAL,
        destino_lng REAL,
        categoria TEXT DEFAULT 'confort',
        estado TEXT DEFAULT 'buscando_chofer',
        precio_base INTEGER,
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    console.log('Tablas creadas');
  } catch (error) {
    console.error('Error:', error);
  }
};
crearTablas();

// ============= ENDPOINTS ADMIN TEMPORALES =============
app.post('/admin/ejecutar-sql', verificarToken, async (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  const { sql } = req.body;
  try {
    await pool.query(sql);
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/verificar-columnas-viajes', verificarToken, async (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  try {
    const result = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'viajes' ORDER BY ordinal_position`);
    res.json({ exito: true, columnas: result.rows.map(r => r.column_name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============= ENDPOINTS USUARIOS =============
app.post('/api/registro', async (req, res) => {
  const { usuario, password, nombre, apellidos, ci, telefono, email } = req.body;
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (usuario, password, nombre, apellidos, ci, telefono, email)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, usuario, nombre, apellidos, rol`,
      [usuario, passwordHash, nombre, apellidos, ci, telefono, email]
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
        rol: usuarioDB.rol
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al iniciar sesion' });
  }
});

app.get('/api/perfil', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, usuario, nombre, apellidos, ci, telefono, email, rol FROM usuarios WHERE id = $1',
      [req.usuario.id]
    );
    res.json({ usuario: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

app.put('/api/perfil', verificarToken, async (req, res) => {
  const { nombre, telefono, email } = req.body;
  try {
    await pool.query(
      'UPDATE usuarios SET nombre = $1, telefono = $2, email = $3 WHERE id = $4',
      [nombre, telefono, email, req.usuario.id]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar' });
  }
});

// ============= ENDPOINTS VIAJES =============
app.post('/api/viajes/solicitar', verificarToken, async (req, res) => {
  console.log('Solicitud recibida:', req.body);
  const { origen, destino, origen_lat, origen_lng, destino_lat, destino_lng, categoria } = req.body;
  
  try {
    const precioBase = 100;
    const result = await pool.query(
      `INSERT INTO viajes (cliente_id, origen, destino, origen_lat, origen_lng, destino_lat, destino_lng, categoria, estado, precio_base, creado_en)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'buscando_chofer', $9, NOW())
       RETURNING *`,
      [req.usuario.id, origen, destino, origen_lat, origen_lng, destino_lat, destino_lng, categoria || 'confort', precioBase]
    );
    res.json({ exito: true, viaje: result.rows[0] });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al solicitar viaje: ' + error.message });
  }
});

app.get('/api/viajes/estado/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM viajes WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Viaje no encontrado' });
    }
    res.json({ viaje: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estado' });
  }
});

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

// ============= RUTAS =============
app.get('/', (req, res) => {
  res.json({ mensaje: 'LLévame API funcionando' });
});

app.get('/admin/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>LLévame - Admin</title>
<style>
  body { font-family: system-ui; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .login-card { background: white; padding: 40px; border-radius: 20px; width: 100%; max-width: 400px; }
  h1 { text-align: center; color: #FF9800; }
  input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 8px; }
  button { width: 100%; padding: 12px; background: #FF9800; color: white; border: none; border-radius: 8px; cursor: pointer; }
</style>
</head>
<body>
<div class="login-card">
<h1>LLévame - Admin</h1>
<form id="loginForm">
<input type="text" id="username" placeholder="Usuario">
<input type="password" id="password" placeholder="Contraseña">
<button type="submit">Iniciar sesión</button>
</form>
</div>
<script>
document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: document.getElementById('username').value, password: document.getElementById('password').value }) });
  const data = await res.json();
  if (data.token && data.usuario.rol === 'admin') {
    localStorage.setItem('token', data.token);
    window.location.href = '/admin/dashboard';
  } else { alert('Credenciales inválidas'); }
};
</script>
</body>
</html>`);
});

app.get('/admin/dashboard', (req, res) => {
  res.send(`<h1>Panel Admin</h1><button onclick="localStorage.removeItem('token');location.href='/admin/login'">Cerrar sesión</button><p>Bienvenido al panel de administración</p>`);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});