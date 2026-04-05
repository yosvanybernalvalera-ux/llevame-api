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
        ultima_ubicacion_lat REAL,
        ultima_ubicacion_lng REAL,
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
        origen_lat REAL,
        origen_lng REAL,
        destino_lat REAL,
        destino_lng REAL,
        categoria TEXT DEFAULT 'confort',
        estado TEXT DEFAULT 'buscando_chofer',
        precio_base INTEGER,
        precio_final INTEGER,
        creado_en TIMESTAMP DEFAULT NOW(),
        aceptado_en TIMESTAMP,
        iniciado_en TIMESTAMP,
        completado_en TIMESTAMP
      )
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
      `UPDATE usuarios SET nombre = COALESCE($1, nombre), telefono = COALESCE($2, telefono), email = COALESCE($3, email), telefono_emergencia = COALESCE($4, telefono_emergencia) WHERE id = $5`,
      [nombre, telefono, email, telefono_emergencia, req.usuario.id]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar' });
  }
});

// ============= ENDPOINTS CHOFER =============

// Registrar vehículo
app.post('/api/chofer/vehiculo', verificarToken, async (req, res) => {
  const { tipo, marca_modelo, color, matricula, categorias } = req.body;
  try {
    const existente = await pool.query('SELECT * FROM vehiculos WHERE usuario_id = $1', [req.usuario.id]);
    if (existente.rows.length > 0) {
      await pool.query(
        `UPDATE vehiculos SET tipo = $1, marca_modelo = $2, color = $3, matricula = $4, categorias = $5, aprobado = FALSE WHERE usuario_id = $6`,
        [tipo, marca_modelo, color, matricula, JSON.stringify(categorias), req.usuario.id]
      );
    } else {
      await pool.query(
        `INSERT INTO vehiculos (usuario_id, tipo, marca_modelo, color, matricula, categorias, aprobado) VALUES ($1, $2, $3, $4, $5, $6, FALSE)`,
        [req.usuario.id, tipo, marca_modelo, color, matricula, JSON.stringify(categorias)]
      );
    }
    await pool.query("UPDATE usuarios SET rol = 'chofer' WHERE id = $1 AND rol = 'cliente'", [req.usuario.id]);
    res.json({ exito: true, mensaje: 'Vehículo registrado. Espera aprobación del administrador' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al registrar vehículo' });
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

// Actualizar ubicación
app.post('/api/chofer/ubicacion', verificarToken, async (req, res) => {
  const { lat, lng } = req.body;
  try {
    await pool.query('UPDATE usuarios SET ultima_ubicacion_lat = $1, ultima_ubicacion_lng = $2 WHERE id = $3', [lat, lng, req.usuario.id]);
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
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al obtener viajes' });
  }
});

// Aceptar viaje
app.post('/api/chofer/aceptar-viaje', verificarToken, async (req, res) => {
  const { viaje_id } = req.body;
  try {
    const viaje = await pool.query('SELECT * FROM viajes WHERE id = $1 AND estado = $2', [viaje_id, 'buscando_chofer']);
    if (viaje.rows.length === 0) {
      return res.status(400).json({ error: 'Viaje no disponible' });
    }
    await pool.query('UPDATE viajes SET chofer_id = $1, estado = $2, aceptado_en = NOW() WHERE id = $3', [req.usuario.id, 'aceptado', viaje_id]);
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
    await pool.query('UPDATE viajes SET estado = $1, iniciado_en = NOW() WHERE id = $2', ['en_curso', viaje_id]);
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
    await pool.query('UPDATE viajes SET estado = $1, precio_final = $2, completado_en = NOW() WHERE id = $3', ['completado', precio_final, viaje_id]);
    await pool.query("UPDATE usuarios SET estado_chofer = 'disponible' WHERE id = $1", [req.usuario.id]);
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al finalizar viaje' });
  }
});

// Historial de viajes del chofer
app.get('/api/chofer/mis-viajes', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM viajes WHERE chofer_id = $1 ORDER BY creado_en DESC`,
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

// ============= ENDPOINTS VIAJES (CLIENTE) =============
app.post('/api/viajes/solicitar', verificarToken, async (req, res) => {
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
    res.status(500).json({ error: 'Error al solicitar viaje' });
  }
});

app.get('/api/viajes/estado/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT v.*, u.telefono as chofer_telefono, u.nombre as chofer_nombre, u.ultima_ubicacion_lat as chofer_lat, u.ultima_ubicacion_lng as chofer_lng
       FROM viajes v
       LEFT JOIN usuarios u ON v.chofer_id = u.id
       WHERE v.id = $1`,
      [id]
    );
    res.json({ viaje: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estado' });
  }
});

app.get('/api/viajes/mis-viajes', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM viajes WHERE cliente_id = $1 ORDER BY creado_en DESC', [req.usuario.id]);
    res.json({ viajes: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener viajes' });
  }
});

app.post('/api/viajes/cancelar/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("UPDATE viajes SET estado = 'cancelado' WHERE id = $1 AND cliente_id = $2 AND estado IN ('buscando_chofer', 'aceptado')", [id, req.usuario.id]);
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al cancelar viaje' });
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
    await pool.query('INSERT INTO direcciones (usuario_id, nombre, direccion) VALUES ($1, $2, $3)', [req.usuario.id, nombre, direccion]);
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

app.get('/admin/login', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>LLévame - Admin</title><style>body{font-family:system-ui;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;}.login-card{background:white;padding:40px;border-radius:20px;width:100%;max-width:400px;}h1{text-align:center;color:#FF9800;}input{width:100%;padding:12px;margin:10px 0;border:1px solid #ddd;border-radius:8px;}button{width:100%;padding:12px;background:#FF9800;color:white;border:none;border-radius:8px;cursor:pointer;}</style></head><body><div class="login-card"><h1>LLévame - Admin</h1><form id="loginForm"><input type="text" id="username" placeholder="Usuario"><input type="password" id="password" placeholder="Contraseña"><button type="submit">Iniciar sesión</button></form></div><script>document.getElementById('loginForm').onsubmit=async(e)=>{e.preventDefault();const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario:document.getElementById('username').value,password:document.getElementById('password').value})});const data=await res.json();if(data.token&&data.usuario.rol==='admin'){localStorage.setItem('token',data.token);window.location.href='/admin/dashboard';}else{alert('Credenciales inválidas');}};</script></body></html>`);
});

app.get('/admin/dashboard', (req, res) => {
  res.send(`<h1>Panel Admin</h1><button onclick="localStorage.removeItem('token');location.href='/admin/login'">Cerrar sesión</button><p>Bienvenido al panel de administración</p>`);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});