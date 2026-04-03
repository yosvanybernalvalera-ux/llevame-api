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
        telefono TEXT,
        email TEXT,
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
        categoria TEXT DEFAULT 'confort',
        estado TEXT DEFAULT 'buscando_chofer',
        precio_base INTEGER,
        precio_final INTEGER,
        creado_en TIMESTAMP DEFAULT NOW(),
        completado_en TIMESTAMP
      )
    `);
    
    console.log('✅ Tablas creadas/verificadas');
  } catch (error) {
    console.error('Error creando tablas:', error);
  }
};
crearTablas();

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

// ============= ENDPOINTS =============

// Registro
app.post('/api/registro', async (req, res) => {
  const { usuario, password, nombre, apellidos, ci, telefono, email } = req.body;
  
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (usuario, password, nombre, apellidos, ci, telefono, email)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, usuario, nombre, apellidos, rol`,
      [usuario, passwordHash, nombre, apellidos, ci, telefono || null, email || null]
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
    const result = await pool.query(
      'SELECT * FROM usuarios WHERE usuario = $1',
      [usuario]
    );
    
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
        rol: usuarioDB.rol
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
      'SELECT id, usuario, nombre, apellidos, ci, telefono, email, rol FROM usuarios WHERE id = $1',
      [req.usuario.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    res.json({ usuario: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

// Actualizar perfil
app.put('/api/perfil', verificarToken, async (req, res) => {
  const { nombre, telefono, email } = req.body;
  
  try {
    await pool.query(
      'UPDATE usuarios SET nombre = COALESCE($1, nombre), telefono = COALESCE($2, telefono), email = COALESCE($3, email) WHERE id = $4',
      [nombre, telefono, email, req.usuario.id]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});

// Solicitar viaje
app.post('/api/viajes/solicitar', verificarToken, async (req, res) => {
  const { origen, destino, categoria } = req.body;
  
  try {
    const precioBase = 100; // Temporal, después se calcula por distancia
    
    const result = await pool.query(
      `INSERT INTO viajes (cliente_id, origen, destino, categoria, estado, precio_base)
       VALUES ($1, $2, $3, $4, 'buscando_chofer', $5)
       RETURNING *`,
      [req.usuario.id, origen, destino, categoria || 'confort', precioBase]
    );
    
    res.json({ exito: true, viaje: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al solicitar viaje' });
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

// Ruta raíz
app.get('/', (req, res) => {
  res.json({ mensaje: '🚕 LLévame API funcionando', version: '2.0' });
});

// Panel admin (simple)
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
          const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario, password })
          });
          const data = await res.json();
          if (data.token) {
            localStorage.setItem('token', data.token);
            window.location.href = '/admin/dashboard';
          } else {
            alert('Credenciales inválidas');
          }
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
        button { background: #f44336; color: white; border: none; padding: 5px 10px; border-radius: 5px; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🚕 LLévame - Panel Admin</h1>
        <button onclick="logout()">Cerrar sesión</button>
      </div>
      <div class="card">
        <h2>Bienvenido al panel de administración</h2>
        <p>Aquí podrás gestionar choferes, viajes y configuraciones.</p>
        <p>✅ Versión base funcionando correctamente</p>
      </div>
      <script>
        const token = localStorage.getItem('token');
        if (!token) window.location.href = '/admin/login';
        function logout() { localStorage.removeItem('token'); window.location.href = '/admin/login'; }
      </script>
    </body>
    </html>
  `);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚕 LLévame API corriendo en puerto ${PORT}`);
});
