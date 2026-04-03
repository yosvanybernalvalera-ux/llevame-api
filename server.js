const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.')); // Para servir HTML

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

const verificarAdmin = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No autorizado' });
  
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'llevame_secret');
    if (decoded.rol === 'admin') {
      req.admin = decoded;
      return next();
    }
  } catch(e) {}
  
  res.status(401).json({ error: 'No autorizado' });
};

// ============= CREAR TABLAS =============
const crearTablas = async () => {
  try {
    // Tabla unificada de usuarios (cliente y chofer)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        usuario TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        nombre TEXT NOT NULL,
        apellidos TEXT NOT NULL,
        ci TEXT NOT NULL,
        telefono TEXT,
        email TEXT,
        rol TEXT DEFAULT 'cliente',
        aprobado BOOLEAN DEFAULT FALSE,
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Tabla de vehículos (para choferes)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vehiculos (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id),
        tipo TEXT NOT NULL,
        marca_modelo TEXT,
        color TEXT,
        matricula TEXT UNIQUE,
        chapa TEXT,
        circulacion TEXT,
        tipo_moto TEXT,
        tipo_triciclo TEXT,
        categorias TEXT[],
        aprobado BOOLEAN DEFAULT FALSE,
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
    
    // Tabla de configuraciones
    await pool.query(`
      CREATE TABLE IF NOT EXISTS configuraciones (
        clave TEXT PRIMARY KEY,
        valor TEXT,
        actualizado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Insertar configuraciones por defecto
    await pool.query(`
      INSERT INTO configuraciones (clave, valor)
      VALUES 
        ('precio_por_km', '20'),
        ('recargo_nocturno', '30'),
        ('recargo_lluvia', '20')
      ON CONFLICT (clave) DO NOTHING
    `);
    
    // Crear usuario admin por defecto si no existe
    const adminPass = await bcrypt.hash('Llevame2025', 10);
    await pool.query(`
      INSERT INTO usuarios (usuario, password, nombre, apellidos, ci, rol, aprobado)
      VALUES ('admin', $1, 'Administrador', 'Sistema', '00000000000', 'admin', TRUE)
      ON CONFLICT (usuario) DO NOTHING
    `, [adminPass]);
    
    console.log('✅ Tablas creadas/verificadas');
  } catch (error) {
    console.error('Error creando tablas:', error);
  }
};

crearTablas();

// ============= ENDPOINTS DE USUARIO =============

// Registro de cliente
app.post('/api/registro', async (req, res) => {
  const { usuario, password, nombre, apellidos, ci, telefono, email } = req.body;
  
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (usuario, password, nombre, apellidos, ci, telefono, email, rol, aprobado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'cliente', TRUE)
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
    res.json({ usuario: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

// Actualizar perfil
app.put('/api/perfil', verificarToken, async (req, res) => {
  const { nombre, apellidos, telefono, email } = req.body;
  
  try {
    await pool.query(
      'UPDATE usuarios SET nombre = $1, apellidos = $2, telefono = $3, email = $4 WHERE id = $5',
      [nombre, apellidos, telefono, email, req.usuario.id]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});

// ============= ENDPOINTS DE CHOFER =============

// Registrar vehículo (para choferes)
app.post('/api/chofer/vehiculo', verificarToken, async (req, res) => {
  const { tipo, marca_modelo, color, matricula, chapa, circulacion, tipo_moto, tipo_triciclo, categorias } = req.body;
  
  try {
    // Verificar si ya tiene vehículo
    const existente = await pool.query(
      'SELECT * FROM vehiculos WHERE usuario_id = $1',
      [req.usuario.id]
    );
    
    if (existente.rows.length > 0) {
      // Actualizar
      await pool.query(
        `UPDATE vehiculos SET tipo = $1, marca_modelo = $2, color = $3, matricula = $4, 
         chapa = $5, circulacion = $6, tipo_moto = $7, tipo_triciclo = $8, categorias = $9
         WHERE usuario_id = $10`,
        [tipo, marca_modelo, color, matricula, chapa, circulacion, tipo_moto, tipo_triciclo, categorias, req.usuario.id]
      );
    } else {
      // Insertar
      await pool.query(
        `INSERT INTO vehiculos (usuario_id, tipo, marca_modelo, color, matricula, chapa, circulacion, tipo_moto, tipo_triciclo, categorias, aprobado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE)`,
        [req.usuario.id, tipo, marca_modelo, color, matricula, chapa, circulacion, tipo_moto, tipo_triciclo, categorias]
      );
    }
    
    // Actualizar rol del usuario a 'chofer' o 'ambos'
    const usuarioResult = await pool.query(
      'SELECT rol FROM usuarios WHERE id = $1',
      [req.usuario.id]
    );
    
    let nuevoRol = 'chofer';
    if (usuarioResult.rows[0].rol === 'cliente') {
      nuevoRol = 'ambos';
    } else if (usuarioResult.rows[0].rol === 'ambos') {
      nuevoRol = 'ambos';
    }
    
    await pool.query(
      'UPDATE usuarios SET rol = $1 WHERE id = $2',
      [nuevoRol, req.usuario.id]
    );
    
    res.json({ exito: true, mensaje: 'Vehículo registrado. Espera aprobación del administrador' });
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar vehículo' });
  }
});

// Obtener datos del chofer (vehículo)
app.get('/api/chofer/vehiculo', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM vehiculos WHERE usuario_id = $1',
      [req.usuario.id]
    );
    res.json({ vehiculo: result.rows[0] || null });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener vehículo' });
  }
});

// ============= ENDPOINTS PARA ADMIN =============

// Listar choferes pendientes de aprobación
app.get('/admin/choferes/pendientes', verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.usuario, u.nombre, u.apellidos, u.telefono, u.email, v.*
      FROM usuarios u
      JOIN vehiculos v ON u.id = v.usuario_id
      WHERE v.aprobado = FALSE AND u.rol IN ('chofer', 'ambos')
    `);
    res.json({ choferes: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener choferes' });
  }
});

// Aprobar chofer
app.post('/admin/choferes/aprobar/:id', verificarAdmin, async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.query(
      'UPDATE vehiculos SET aprobado = TRUE WHERE usuario_id = $1',
      [id]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al aprobar chofer' });
  }
});

// Listar todos los choferes
app.get('/admin/choferes', verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.usuario, u.nombre, u.apellidos, u.telefono, v.*
      FROM usuarios u
      JOIN vehiculos v ON u.id = v.usuario_id
      WHERE u.rol IN ('chofer', 'ambos')
    `);
    res.json({ choferes: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener choferes' });
  }
});

// Estadísticas
app.get('/admin/estadisticas', verificarAdmin, async (req, res) => {
  try {
    const totalClientes = await pool.query("SELECT COUNT(*) FROM usuarios WHERE rol IN ('cliente', 'ambos')");
    const totalChoferes = await pool.query("SELECT COUNT(*) FROM vehiculos");
    const pendientes = await pool.query("SELECT COUNT(*) FROM vehiculos WHERE aprobado = FALSE");
    
    res.json({
      total_clientes: parseInt(totalClientes.rows[0].count),
      total_choferes: parseInt(totalChoferes.rows[0].count),
      pendientes_aprobacion: parseInt(pendientes.rows[0].count)
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// ============= ENDPOINTS DE VIAJES =============

// Solicitar viaje
app.post('/api/viajes/solicitar', verificarToken, async (req, res) => {
  const { origen, destino, categoria } = req.body;
  
  try {
    const config = await pool.query("SELECT valor FROM configuraciones WHERE clave = 'precio_por_km'");
    const precioPorKm = parseFloat(config.rows[0]?.valor || 20);
    const distancia = 5; // Simulada, después con API de mapas
    const precioBase = Math.round(distancia * precioPorKm);
    
    const result = await pool.query(
      `INSERT INTO viajes (cliente_id, origen, destino, categoria, estado, precio_base, creado_en)
       VALUES ($1, $2, $3, $4, 'buscando_chofer', $5, NOW())
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
  res.json({ 
    mensaje: '🚕 LLévame API funcionando',
    version: '2.0',
    endpoints: {
      registro: '/api/registro',
      login: '/api/login',
      admin: '/admin/login'
    }
  });
});

// ============= PANEL ADMIN (HTML) =============
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
        body {
          font-family: system-ui, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .login-card {
          background: white;
          padding: 40px;
          border-radius: 20px;
          width: 100%;
          max-width: 400px;
        }
        h1 { text-align: center; color: #FF9800; margin-bottom: 30px; }
        input {
          width: 100%;
          padding: 12px;
          margin: 10px 0;
          border: 1px solid #ddd;
          border-radius: 8px;
        }
        button {
          width: 100%;
          padding: 12px;
          background: #FF9800;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          margin-top: 20px;
        }
        .error { color: red; text-align: center; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="login-card">
        <h1>🚕 LLévame - Admin</h1>
        <form id="loginForm">
          <input type="text" id="username" placeholder="Usuario" required>
          <input type="password" id="password" placeholder="Contraseña" required>
          <button type="submit">Iniciar sesión</button>
          <div id="error" class="error"></div>
        </form>
      </div>
      <script>
        document.getElementById('loginForm').onsubmit = async (e) => {
          e.preventDefault();
          const username = document.getElementById('username').value;
          const password = document.getElementById('password').value;
          
          const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: username, password })
          });
          
          const data = await res.json();
          if (data.token) {
            localStorage.setItem('token', data.token);
            window.location.href = '/admin/dashboard';
          } else {
            document.getElementById('error').textContent = 'Credenciales inválidas';
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
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: white; padding: 20px; border-radius: 15px; text-align: center; }
        .stat-number { font-size: 28px; font-weight: bold; color: #FF9800; }
        .section { background: white; padding: 20px; border-radius: 15px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
        .btn-aprobar { background: #4CAF50; color: white; border: none; padding: 5px 10px; border-radius: 5px; cursor: pointer; }
        .logout { background: rgba(255,255,255,0.2); border: none; padding: 5px 10px; border-radius: 5px; color: white; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🚕 LLévame - Admin</h1>
        <button class="logout" onclick="logout()">Cerrar sesión</button>
      </div>
      
      <div class="stats" id="stats"></div>
      
      <div class="section">
        <h2>⏳ Choferes pendientes de aprobación</h2>
        <div id="pendientes"></div>
      </div>
      
      <div class="section">
        <h2>👨‍✈️ Todos los choferes</h2>
        <div id="choferes"></div>
      </div>
      
      <script>
        const token = localStorage.getItem('token');
        if (!token) window.location.href = '/admin/login';
        
        async function fetchAPI(url) {
          const res = await fetch(url, {
            headers: { 'Authorization': 'Bearer ' + token }
          });
          return res.json();
        }
        
        async function cargarStats() {
          const stats = await fetchAPI('/admin/estadisticas');
          document.getElementById('stats').innerHTML = \`
            <div class="stat-card"><div class="stat-number">\${stats.total_clientes || 0}</div><div>Clientes</div></div>
            <div class="stat-card"><div class="stat-number">\${stats.total_choferes || 0}</div><div>Choferes</div></div>
            <div class="stat-card"><div class="stat-number">\${stats.pendientes_aprobacion || 0}</div><div>Pendientes</div></div>
          \`;
        }
        
        async function cargarPendientes() {
          const data = await fetchAPI('/admin/choferes/pendientes');
          const pendientes = data.choferes || [];
          if (pendientes.length === 0) {
            document.getElementById('pendientes').innerHTML = '<p>No hay choferes pendientes</p>';
          } else {
            document.getElementById('pendientes').innerHTML = \`
              8able
                <tr><th>Nombre</th><th>Usuario</th><th>Vehículo</th><th>Matrícula</th><th>Acción</th></tr>
                \${pendientes.map(c => '<tr><td>' + c.nombre + ' ' + (c.apellidos || '') + '</td><td>' + c.usuario + '</td><td>' + (c.marca_modelo || c.tipo) + '</td><td>' + (c.matricula || '-') + '</td><td><button class="btn-aprobar" onclick="aprobar(' + c.id + ')">Aprobar</button></td></tr>').join('')}
              </table>
            \`;
          }
        }
        
        async function cargarChoferes() {
          const data = await fetchAPI('/admin/choferes');
          const choferes = data.choferes || [];
          document.getElementById('choferes').innerHTML = \`
            <table>
              <tr><th>Nombre</th><th>Usuario</th><th>Vehículo</th><th>Matrícula</th><th>Aprobado</th></tr>
              \${choferes.map(c => '<tr><td>' + c.nombre + ' ' + (c.apellidos || '') + '</td><td>' + c.usuario + '</td><td>' + (c.marca_modelo || c.tipo) + '</td><td>' + (c.matricula || '-') + '</td><td>' + (c.aprobado ? '✅ Sí' : '❌ No') + '</td></tr>').join('')}
            </table>
          \`;
        }
        
        async function aprobar(id) {
          await fetch('/admin/choferes/aprobar/' + id, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token }
          });
          cargarPendientes();
          cargarChoferes();
          cargarStats();
        }
        
        function logout() {
          localStorage.removeItem('token');
          window.location.href = '/admin/login';
        }
        
        cargarStats();
        cargarPendientes();
        cargarChoferes();
      </script>
    </body>
    </html>
  `);
});

// ============= INICIAR SERVIDOR =============
app.listen(PORT, () => {
  console.log(`🚕 LLévame API corriendo en puerto ${PORT}`);
  console.log(`📊 Panel admin: https://.../admin/login`);
});
