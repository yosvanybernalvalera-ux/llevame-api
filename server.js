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
    // Tabla de usuarios
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
    
    // Tabla de viajes
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
    
    // Tabla de direcciones frecuentes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS direcciones (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id),
        nombre TEXT NOT NULL,
        direccion TEXT NOT NULL,
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Tabla de calificaciones
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

// ============= ENDPOINTS DE USUARIO =============

// Registro con validación de email y teléfono únicos
app.post('/api/registro', async (req, res) => {
  const { usuario, password, nombre, apellidos, ci, telefono, email } = req.body;
  
  try {
    // Verificar si el email ya existe (si se proporcionó)
    if (email) {
      const emailExistente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
      if (emailExistente.rows.length > 0) {
        return res.status(400).json({ error: 'El email ya está registrado' });
      }
    }
    
    // Verificar si el teléfono ya existe (si se proporcionó)
    if (telefono) {
      const telefonoExistente = await pool.query('SELECT id FROM usuarios WHERE telefono = $1', [telefono]);
      if (telefonoExistente.rows.length > 0) {
        return res.status(400).json({ error: 'El teléfono ya está registrado' });
      }
    }
    
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
      if (error.constraint === 'usuarios_usuario_key') {
        res.status(400).json({ error: 'El usuario ya existe' });
      } else if (error.constraint === 'usuarios_email_key') {
        res.status(400).json({ error: 'El email ya está registrado' });
      } else if (error.constraint === 'usuarios_telefono_key') {
        res.status(400).json({ error: 'El teléfono ya está registrado' });
      } else {
        res.status(400).json({ error: 'Ya existe un usuario con esos datos' });
      }
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
    // Verificar si el nuevo email ya existe (si cambió)
    if (email) {
      const emailExistente = await pool.query(
        'SELECT id FROM usuarios WHERE email = $1 AND id != $2',
        [email, req.usuario.id]
      );
      if (emailExistente.rows.length > 0) {
        return res.status(400).json({ error: 'El email ya está registrado por otro usuario' });
      }
    }
    
    // Verificar si el nuevo teléfono ya existe (si cambió)
    if (telefono) {
      const telefonoExistente = await pool.query(
        'SELECT id FROM usuarios WHERE telefono = $1 AND id != $2',
        [telefono, req.usuario.id]
      );
      if (telefonoExistente.rows.length > 0) {
        return res.status(400).json({ error: 'El teléfono ya está registrado por otro usuario' });
      }
    }
    
    await pool.query(
      'UPDATE usuarios SET nombre = COALESCE($1, nombre), telefono = COALESCE($2, telefono), email = COALESCE($3, email) WHERE id = $4',
      [nombre, telefono, email, req.usuario.id]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});

// ============= ENDPOINTS DE DIRECCIONES =============

// Obtener direcciones del usuario
app.get('/api/direcciones', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM direcciones WHERE usuario_id = $1 ORDER BY creado_en DESC',
      [req.usuario.id]
    );
    res.json({ direcciones: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener direcciones' });
  }
});

// Agregar dirección
app.post('/api/direcciones', verificarToken, async (req, res) => {
  const { nombre, direccion } = req.body;
  
  try {
    const result = await pool.query(
      'INSERT INTO direcciones (usuario_id, nombre, direccion) VALUES ($1, $2, $3) RETURNING *',
      [req.usuario.id, nombre, direccion]
    );
    res.json({ exito: true, direccion: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al agregar dirección' });
  }
});

// Eliminar dirección
app.delete('/api/direcciones/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.query('DELETE FROM direcciones WHERE id = $1 AND usuario_id = $2', [id, req.usuario.id]);
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar dirección' });
  }
});

// ============= ENDPOINTS DE VIAJES =============

// Solicitar viaje
app.post('/api/viajes/solicitar', verificarToken, async (req, res) => {
  const { origen, destino, categoria } = req.body;
  
  try {
    // Calcular precio base según categoría
    const precios = { economico: 100, confort: 150, clasico: 200, lujo: 300, moto: 80, triciclo: 50 };
    const precioBase = precios[categoria] || 100;
    
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

// Obtener estado de un viaje
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

// Cancelar viaje
app.post('/api/viajes/cancelar/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query(
      'UPDATE viajes SET estado = $1 WHERE id = $2 AND cliente_id = $3 AND estado IN ($4, $5) RETURNING *',
      ['cancelado', id, req.usuario.id, 'buscando_chofer', 'aceptado']
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'No se puede cancelar el viaje' });
    }
    
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
    // Obtener el viaje y verificar que esté completado
    const viaje = await pool.query('SELECT * FROM viajes WHERE id = $1 AND cliente_id = $2', [id, req.usuario.id]);
    if (viaje.rows.length === 0) {
      return res.status(404).json({ error: 'Viaje no encontrado' });
    }
    
    if (viaje.rows[0].estado !== 'completado') {
      return res.status(400).json({ error: 'Solo se pueden calificar viajes completados' });
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

// ============= RUTA RAÍZ =============
app.get('/', (req, res) => {
  res.json({ mensaje: '🚕 LLévame API funcionando', version: '2.0' });
});

// ============= PANEL ADMIN =============
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
        <p>✅ Versión completa funcionando</p>
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

// ============= INICIAR SERVIDOR =============
app.listen(PORT, () => {
  console.log(`🚕 LLévame API corriendo en puerto ${PORT}`);
});
