const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Base de datos
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============= FUNCIONES DE UTILIDAD =============
const verificarAdmin = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No autorizado' });
  
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'llevame_secret');
    if (decoded.role === 'admin') {
      req.admin = decoded;
      return next();
    }
  } catch(e) {}
  
  res.status(401).json({ error: 'No autorizado' });
};

const calcularPrecioBase = (distanciaKm, horario, esLluvia) => {
  const precioPorKm = parseFloat(process.env.PRECIO_KM || 20);
  let precio = distanciaKm * precioPorKm;
  
  // Recargo nocturno (12am a 5am)
  const hora = new Date().getHours();
  if (hora >= 0 && hora < 5) {
    precio *= 1.3; // 30% más caro
  }
  
  // Recargo por lluvia
  if (esLluvia) {
    precio *= 1.2; // 20% más caro
  }
  
  return Math.round(precio);
};

// ============= CREAR TABLAS EN LA BASE DE DATOS =============
const crearTablas = async () => {
  try {
    // Tabla de viajes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS viajes (
        id SERIAL PRIMARY KEY,
        origen TEXT NOT NULL,
        destino TEXT NOT NULL,
        cliente_id TEXT NOT NULL,
        chofer_id TEXT,
        categoria TEXT DEFAULT 'confort',
        estado TEXT DEFAULT 'buscando_chofer',
        precio_base INTEGER,
        precio_final INTEGER,
        distancia_km REAL,
        tiempo_espera_cliente INTEGER DEFAULT 0,
        desvios TEXT[] DEFAULT '{}',
        creado_en TIMESTAMP DEFAULT NOW(),
        iniciado_en TIMESTAMP,
        completado_en TIMESTAMP
      )
    `);
    
    // Tabla de choferes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS choferes (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        telefono TEXT,
        vehiculo TEXT,
        matricula TEXT,
        categorias TEXT[] DEFAULT '{"confort"}',
        estado TEXT DEFAULT 'disponible',
        ubicacion_lat REAL,
        ubicacion_lng REAL,
        calificacion REAL DEFAULT 5.0,
        viajes_realizados INTEGER DEFAULT 0,
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Tabla de clientes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        id SERIAL PRIMARY KEY,
        nombre TEXT,
        telefono TEXT,
        email TEXT,
        creado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Tabla de configuraciones (precios, márgenes, etc)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS configuraciones (
        clave TEXT PRIMARY KEY,
        valor TEXT,
        actualizado_en TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Insertar configuraciones por defecto si no existen
    await pool.query(`
      INSERT INTO configuraciones (clave, valor)
      VALUES 
        ('precio_por_km', '20'),
        ('recargo_nocturno', '30'),
        ('recargo_lluvia', '20'),
        ('tarifa_espera_cliente', '1'),
        ('margen_demora_chofer', '5'),
        ('tiempo_max_espera_cliente', '5'),
        ('modo_desvios', 'manual')
      ON CONFLICT (clave) DO NOTHING
    `);
    
    console.log('✅ Tablas creadas/verificadas');
  } catch (error) {
    console.error('Error creando tablas:', error);
  }
};

crearTablas();

// ============= ENDPOINTS PARA CLIENTES =============

// Solicitar un viaje
app.post('/api/viajes/solicitar', async (req, res) => {
  const { origen, destino, cliente_id, categoria, lat_origen, lng_origen } = req.body;
  
  try {
    // Calcular distancia aproximada (simulada, después se puede integrar con API de mapas)
    const distancia = 5; // km simulados
    
    // Obtener precio por km de configuración
    const configPrecio = await pool.query("SELECT valor FROM configuraciones WHERE clave = 'precio_por_km'");
    const precioPorKm = parseFloat(configPrecio.rows[0]?.valor || 20);
    
    // Obtener recargo nocturno
    const configNocturno = await pool.query("SELECT valor FROM configuraciones WHERE clave = 'recargo_nocturno'");
    const recargoNocturno = parseFloat(configNocturno.rows[0]?.valor || 30) / 100;
    
    // Obtener recargo lluvia (de momento false, después se puede integrar con API del clima)
    const configLluvia = await pool.query("SELECT valor FROM configuraciones WHERE clave = 'recargo_lluvia'");
    const recargoLluvia = parseFloat(configLluvia.rows[0]?.valor || 20) / 100;
    
    let precio = distancia * precioPorKm;
    
    const hora = new Date().getHours();
    if (hora >= 0 && hora < 5) {
      precio *= (1 + recargoNocturno);
    }
    
    // Por ahora sin lluvia automática, el admin activa manualmente
    const esLluvia = false;
    if (esLluvia) {
      precio *= (1 + recargoLluvia);
    }
    
    const precioBase = Math.round(precio);
    
    const result = await pool.query(
      `INSERT INTO viajes (origen, destino, cliente_id, categoria, estado, precio_base, distancia_km, creado_en)
       VALUES ($1, $2, $3, $4, 'buscando_chofer', $5, $6, NOW())
       RETURNING *`,
      [origen, destino, cliente_id, categoria || 'confort', precioBase, distancia]
    );
    
    res.json({ exito: true, viaje: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al solicitar viaje' });
  }
});

// Consultar estado de un viaje
app.get('/api/viajes/estado/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM viajes WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Viaje no encontrado' });
    }
    res.json({ viaje: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar estado' });
  }
});

// Historial del cliente
app.get('/api/clientes/historial/:cliente_id', async (req, res) => {
  const { cliente_id } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM viajes WHERE cliente_id = $1 ORDER BY creado_en DESC LIMIT 10",
      [cliente_id]
    );
    res.json({ historial: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

// ============= ENDPOINTS PARA CHOFERES =============

// Registrar chofer
app.post('/api/choferes/registrar', async (req, res) => {
  const { nombre, telefono, vehiculo, matricula, categorias, lat, lng } = req.body;
  
  try {
    const categoriasArray = categorias || ['confort'];
    const result = await pool.query(
      `INSERT INTO choferes (nombre, telefono, vehiculo, matricula, categorias, estado, ubicacion_lat, ubicacion_lng, creado_en)
       VALUES ($1, $2, $3, $4, $5, 'disponible', $6, $7, NOW())
       RETURNING id, nombre, telefono, vehiculo, matricula, categorias, estado`,
      [nombre, telefono, vehiculo, matricula, categoriasArray, lat || null, lng || null]
    );
    
    res.json({ exito: true, chofer: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al registrar chofer' });
  }
});

// Actualizar ubicación del chofer
app.post('/api/choferes/ubicacion', async (req, res) => {
  const { chofer_id, lat, lng } = req.body;
  
  try {
    await pool.query(
      'UPDATE choferes SET ubicacion_lat = $1, ubicacion_lng = $2 WHERE id = $3',
      [lat, lng, chofer_id]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar ubicación' });
  }
});

// Ver viajes pendientes (para choferes)
app.get('/api/choferes/viajes_pendientes', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM viajes WHERE estado = 'buscando_chofer' ORDER BY creado_en ASC"
    );
    res.json({ viajes: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener viajes' });
  }
});

// Aceptar viaje
app.post('/api/choferes/aceptar_viaje', async (req, res) => {
  const { viaje_id, chofer_id } = req.body;
  
  try {
    // Verificar que el viaje aún está pendiente
    const viajeResult = await pool.query(
      "SELECT * FROM viajes WHERE id = $1 AND estado = 'buscando_chofer'",
      [viaje_id]
    );
    
    if (viajeResult.rows.length === 0) {
      return res.status(400).json({ error: 'Viaje no disponible' });
    }
    
    // Actualizar viaje
    await pool.query(
      "UPDATE viajes SET estado = 'aceptado', chofer_id = $1 WHERE id = $2",
      [chofer_id, viaje_id]
    );
    
    // Actualizar estado del chofer
    await pool.query(
      "UPDATE choferes SET estado = 'ocupado' WHERE id = $1",
      [chofer_id]
    );
    
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al aceptar viaje' });
  }
});

// Iniciar viaje (cliente subió)
app.post('/api/choferes/iniciar_viaje/:viaje_id', async (req, res) => {
  const { viaje_id } = req.params;
  const { chofer_id } = req.body;
  
  try {
    await pool.query(
      "UPDATE viajes SET estado = 'en_curso', iniciado_en = NOW() WHERE id = $1 AND chofer_id = $2",
      [viaje_id, chofer_id]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al iniciar viaje' });
  }
});

// Finalizar viaje
app.post('/api/choferes/finalizar_viaje/:viaje_id', async (req, res) => {
  const { viaje_id } = req.params;
  const { chofer_id, precio_final } = req.body;
  
  try {
    await pool.query(
      `UPDATE viajes SET estado = 'completado', precio_final = $1, completado_en = NOW() 
       WHERE id = $2 AND chofer_id = $3`,
      [precio_final, viaje_id, chofer_id]
    );
    
    // Actualizar estadísticas del chofer
    await pool.query(
      `UPDATE choferes SET estado = 'disponible', viajes_realizados = viajes_realizados + 1 
       WHERE id = $1`,
      [chofer_id]
    );
    
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al finalizar viaje' });
  }
});

// ============= ENDPOINTS PARA ADMIN =============

// Estadísticas generales
app.get('/admin/estadisticas', verificarAdmin, async (req, res) => {
  try {
    const viajesHoy = await pool.query(
      "SELECT COUNT(*) FROM viajes WHERE DATE(creado_en) = CURRENT_DATE"
    );
    const choferesActivos = await pool.query(
      "SELECT COUNT(*) FROM choferes WHERE estado = 'disponible'"
    );
    const viajesPendientes = await pool.query(
      "SELECT COUNT(*) FROM viajes WHERE estado = 'buscando_chofer'"
    );
    const viajesEnCurso = await pool.query(
      "SELECT COUNT(*) FROM viajes WHERE estado = 'en_curso'"
    );
    
    res.json({
      viajes_hoy: parseInt(viajesHoy.rows[0].count),
      choferes_activos: parseInt(choferesActivos.rows[0].count),
      viajes_pendientes: parseInt(viajesPendientes.rows[0].count),
      viajes_en_curso: parseInt(viajesEnCurso.rows[0].count)
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// Listar viajes pendientes
app.get('/admin/viajes/pendientes', verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM viajes WHERE estado = 'buscando_chofer' ORDER BY creado_en ASC"
    );
    res.json({ viajes: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener viajes' });
  }
});

// Listar todos los choferes
app.get('/admin/choferes', verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM choferes ORDER BY id DESC");
    res.json({ choferes: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener choferes' });
  }
});

// Activar/desactivar chofer
app.post('/admin/choferes/:id/toggle', verificarAdmin, async (req, res) => {
  const { id } = req.params;
  const { activo } = req.body;
  
  try {
    const nuevoEstado = activo ? 'disponible' : 'inactivo';
    await pool.query("UPDATE choferes SET estado = $1 WHERE id = $2", [nuevoEstado, id]);
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
});

// Obtener configuración de precios
app.get('/admin/configuracion', verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM configuraciones");
    const config = {};
    result.rows.forEach(row => {
      config[row.clave] = row.valor;
    });
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener configuración' });
  }
});

// Actualizar configuración
app.post('/admin/configuracion', verificarAdmin, async (req, res) => {
  const { clave, valor } = req.body;
  
  try {
    await pool.query(
      "INSERT INTO configuraciones (clave, valor, actualizado_en) VALUES ($1, $2, NOW()) ON CONFLICT (clave) DO UPDATE SET valor = $2, actualizado_en = NOW()",
      [clave, valor]
    );
    res.json({ exito: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al guardar configuración' });
  }
});

// ============= PANEL DE ADMINISTRADOR (HTML) =============

// Pantalla de login
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
          font-family: system-ui, -apple-system, sans-serif;
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
          box-shadow: 0 20px 40px rgba(0,0,0,0.2);
        }
        h1 { text-align: center; color: #FF9800; margin-bottom: 30px; }
        input {
          width: 100%;
          padding: 12px;
          margin: 10px 0;
          border: 1px solid #ddd;
          border-radius: 8px;
          font-size: 16px;
        }
        button {
          width: 100%;
          padding: 12px;
          background: #FF9800;
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          font-weight: bold;
          cursor: pointer;
          margin-top: 20px;
        }
        .error {
          color: red;
          text-align: center;
          margin-top: 10px;
        }
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
          
          const res = await fetch('/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });
          
          const data = await res.json();
          if (data.token) {
            localStorage.setItem('admin_token', data.token);
            window.location.href = '/admin/dashboard';
          } else {
            document.getElementById('error').textContent = 'Usuario o contraseña incorrectos';
          }
        };
      </script>
    </body>
    </html>
  `);
});

// Endpoint de login (API)
app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'Llevame2025';
  
  if (username === adminUser && password === adminPass) {
    const token = jwt.sign({ role: 'admin', username }, process.env.JWT_SECRET || 'llevame_secret', { expiresIn: '24h' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Credenciales inválidas' });
  }
});

// Dashboard del administrador
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
        body {
          font-family: system-ui, -apple-system, sans-serif;
          background: #f0f2f5;
          padding: 20px;
        }
        .header {
          background: linear-gradient(135deg, #FF9800, #F57C00);
          color: white;
          padding: 20px;
          border-radius: 15px;
          margin-bottom: 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 20px;
          margin-bottom: 30px;
        }
        .stat-card {
          background: white;
          padding: 20px;
          border-radius: 15px;
          text-align: center;
          box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        .stat-number {
          font-size: 32px;
          font-weight: bold;
          color: #FF9800;
        }
        .section {
          background: white;
          padding: 20px;
          border-radius: 15px;
          margin-bottom: 20px;
          box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        h2 { margin-bottom: 15px; color: #333; font-size: 18px; }
        table {
          width: 100%;
          border-collapse: collapse;
          overflow-x: auto;
          display: block;
        }
        th, td {
          padding: 10px;
          text-align: left;
          border-bottom: 1px solid #ddd;
        }
        th { background: #f5f5f5; }
        .btn-logout {
          background: rgba(255,255,255,0.2);
          border: none;
          padding: 10px 20px;
          border-radius: 8px;
          color: white;
          cursor: pointer;
          font-size: 14px;
        }
        .btn-action {
          background: #FF9800;
          border: none;
          padding: 5px 10px;
          border-radius: 5px;
          color: white;
          cursor: pointer;
          margin: 2px;
        }
        .btn-danger {
          background: #f44336;
        }
        .config-group {
          margin-bottom: 15px;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 10px;
        }
        .config-group label {
          width: 200px;
          font-weight: bold;
        }
        .config-group input, .config-group select {
          padding: 8px;
          border: 1px solid #ddd;
          border-radius: 5px;
          flex: 1;
          max-width: 200px;
        }
        .loading {
          text-align: center;
          padding: 20px;
          color: #999;
        }
        @media (max-width: 600px) {
          body { padding: 10px; }
          .stat-number { font-size: 24px; }
          .config-group label { width: 100%; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🚕 LLévame - Panel de Control</h1>
        <button class="btn-logout" onclick="logout()">Cerrar sesión</button>
      </div>
      
      <div class="stats-grid" id="stats">
        <div class="stat-card"><div class="stat-number" id="viajesHoy">--</div><div>Viajes hoy</div></div>
        <div class="stat-card"><div class="stat-number" id="choferesActivos">--</div><div>Choferes activos</div></div>
        <div class="stat-card"><div class="stat-number" id="viajesPendientes">--</div><div>Viajes pendientes</div></div>
        <div class="stat-card"><div class="stat-number" id="viajesEnCurso">--</div><div>Viajes en curso</div></div>
      </div>
      
      <div class="section">
        <h2>💰 Gestión de precios y configuración</h2>
        <div id="configuracion"></div>
        <button class="btn-action" onclick="guardarConfiguracion()">Guardar todos los cambios</button>
      </div>
      
      <div class="section">
        <h2>📋 Viajes pendientes</h2>
        <div id="viajesPendientesLista">Cargando...</div>
      </div>
      
      <div class="section">
        <h2>👨‍✈️ Choferes registrados</h2>
        <div id="choferesLista">Cargando...</div>
      </div>
      
      <script>
        const token = localStorage.getItem('admin_token');
        if (!token) window.location.href = '/admin/login';
        
        async function fetchAPI(endpoint, options = {}) {
          const res = await fetch(endpoint, {
            headers: { 
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json'
            },
            ...options
          });
          if (res.status === 401) {
            localStorage.removeItem('admin_token');
            window.location.href = '/admin/login';
          }
          return res.json();
        }
        
        async function cargarStats() {
          const stats = await fetchAPI('/admin/estadisticas');
          document.getElementById('viajesHoy').textContent = stats.viajes_hoy || 0;
          document.getElementById('choferesActivos').textContent = stats.choferes_activos || 0;
          document.getElementById('viajesPendientes').textContent = stats.viajes_pendientes || 0;
          document.getElementById('viajesEnCurso').textContent = stats.viajes_en_curso || 0;
        }
        
        async function cargarConfiguracion() {
          const config = await fetchAPI('/admin/configuracion');
          const html = \`
            <div class="config-group">
              <label>Precio por km (CUP):</label>
              <input type="number" id="precio_por_km" value="\${config.precio_por_km || '20'}" step="1">
            </div>
            <div class="config-group">
              <label>Recargo nocturno (%):</label>
              <input type="number" id="recargo_nocturno" value="\${config.recargo_nocturno || '30'}" step="1">
            </div>
            <div class="config-group">
              <label>Recargo lluvia (%):</label>
              <input type="number" id="recargo_lluvia" value="\${config.recargo_lluvia || '20'}" step="1">
              <button class="btn-action" onclick="activarLluvia()">🌧 Activar lluvia ahora</button>
            </div>
            <div class="config-group">
              <label>Tarifa espera cliente (CUP/seg):</label>
              <input type="number" id="tarifa_espera_cliente" value="\${config.tarifa_espera_cliente || '1'}" step="0.5">
            </div>
            <div class="config-group">
              <label>Margen demora chofer (min):</label>
              <input type="number" id="margen_demora_chofer" value="\${config.margen_demora_chofer || '5'}" step="1">
            </div>
            <div class="config-group">
              <label>Tiempo máx espera cliente (min):</label>
              <input type="number" id="tiempo_max_espera_cliente" value="\${config.tiempo_max_espera_cliente || '5'}" step="1">
            </div>
            <div class="config-group">
              <label>Modo desvíos:</label>
              <select id="modo_desvios">
                <option value="manual" \${config.modo_desvios === 'manual' ? 'selected' : ''}>Manual (chofer reporta)</option>
                <option value="automatico" \${config.modo_desvios === 'automatico' ? 'selected' : ''}>Automático (GPS detecta)</option>
              </select>
            </div>
          \`;
          document.getElementById('configuracion').innerHTML = html;
        }
        
        async function guardarConfiguracion() {
          const configs = [
            'precio_por_km', 'recargo_nocturno', 'recargo_lluvia', 
            'tarifa_espera_cliente', 'margen_demora_chofer', 
            'tiempo_max_espera_cliente', 'modo_desvios'
          ];
          
          for (const clave of configs) {
            const input = document.getElementById(clave);
            if (input) {
              await fetchAPI('/admin/configuracion', {
                method: 'POST',
                body: JSON.stringify({ clave, valor: input.value })
              });
            }
          }
          alert('Configuración guardada');
        }
        
        async function activarLluvia() {
          await fetchAPI('/admin/configuracion', {
            method: 'POST',
            body: JSON.stringify({ clave: 'lluvia_activa', valor: 'true' })
          });
          alert('Modo lluvia activado. Los precios aumentarán un ' + (document.getElementById('recargo_lluvia')?.value || '20') + '%');
        }
        
        async function cargarViajesPendientes() {
          const data = await fetchAPI('/admin/viajes/pendientes');
          const viajes = data.viajes || [];
          if (viajes.length === 0) {
            document.getElementById('viajesPendientesLista').innerHTML = '<p>No hay viajes pendientes</p>';
          } else {
            document.getElementById('viajesPendientesLista').innerHTML = \`
              <table>
                <thead><tr><th>ID</th><th>Origen</th><th>Destino</th><th>Categoría</th><th>Precio base</th><th>Cliente</th></tr></thead>
                <tbody>
                  \${viajes.map(v => '<tr><td>' + v.id + '</td><td>' + v.origen + '</td><td>' + v.destino + '</td><td>' + v.categoria + '</td><td>' + v.precio_base + '</td><td>' + v.cliente_id + '</td></tr>').join('')}
                </tbody>
              </table>
            \`;
          }
        }
        
        async function cargarChoferes() {
          const data = await fetchAPI('/admin/choferes');
          const choferes = data.choferes || [];
          if (choferes.length === 0) {
            document.getElementById('choferesLista').innerHTML = '<p>No hay choferes registrados</p>';
          } else {
            document.getElementById('choferesLista').innerHTML = \`
              <table>
                <thead><tr><th>ID</th><th>Nombre</th><th>Vehículo</th><th>Matrícula</th><th>Estado</th><th>Acciones</th></tr></thead>
                <tbody>
                  \${choferes.map(c => '<tr><td>' + c.id + '</td><td>' + c.nombre + '</td><td>' + (c.vehiculo || '-') + '</td><td>' + (c.matricula || '-') + '</td><td>' + c.estado + '</td><td><button class="btn-action" onclick="toggleChofer(' + c.id + ', ' + (c.estado === 'disponible' ? 'false' : 'true') + ')">' + (c.estado === 'disponible' ? 'Desactivar' : 'Activar') + '</button></td></tr>').join('')}
                </tbody>
              </table>
            \`;
          }
        }
        
        async function toggleChofer(id, activar) {
          await fetchAPI('/admin/choferes/' + id + '/toggle', {
            method: 'POST',
            body: JSON.stringify({ activo: activar })
          });
          cargarChoferes();
          cargarStats();
        }
        
        function logout() {
          localStorage.removeItem('admin_token');
          window.location.href = '/admin/login';
        }
        
        // Cargar todo
        cargarStats();
        cargarConfiguracion();
        cargarViajesPendientes();
        cargarChoferes();
        
        // Actualizar cada 30 segundos
        setInterval(() => {
          cargarStats();
          cargarViajesPendientes();
        }, 30000);
      </script>
    </body>
    </html>
  `);
});

// ============= INICIAR SERVIDOR =============
app.listen(PORT, () => {
  console.log(`🚕 LLévame API corriendo en puerto ${PORT}`);
  console.log(`📊 Panel admin: http://localhost:${PORT}/admin/login`);
});
