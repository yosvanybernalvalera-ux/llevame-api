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
        chofer_id INTEGER DEFAULT NULL,
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
    
    console.log('✅ Tablas listas');
  } catch (error) {
    console.error('Error:', error);
  }
};
crearTablas();

// ============= ENDPOINT VIAJES DISPONIBLES (VERSIÓN SIMPLE) =============
app.get('/api/chofer/viajes-disponibles', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.id, v.origen, v.destino, v.categoria, v.precio_base, u.nombre as cliente_nombre
      FROM viajes v
      JOIN usuarios u ON v.cliente_id = u.id
      WHERE v.estado = 'buscando_chofer'
      ORDER BY v.creado_en ASC
    `);
    
    res.json({ viajes: result.rows });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= LOS DEMÁS ENDPOINTS AQUÍ =============
// (copia todos los demás endpoints de tu server.js original aquí)
// Incluye: /api/registro, /api/login, /api/perfil, /api/chofer/vehiculo, 
// /api/chofer/ubicacion, /api/chofer/aceptar-viaje, /api/chofer/iniciar-viaje,
// /api/chofer/finalizar-viaje, /api/chofer/mis-viajes, /api/chofer/ganancias,
// /api/viajes/solicitar, /api/viajes/estado, /api/viajes/mis-viajes, etc.

// Ruta raíz
app.get('/', (req, res) => {
  res.json({ mensaje: 'LLévame API funcionando' });
});

// Panel admin
app.get('/admin/login', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>LLévame - Admin</title><style>body{font-family:system-ui;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.login-card{background:white;padding:40px;border-radius:20px;width:100%;max-width:400px}h1{text-align:center;color:#FF9800;margin-bottom:30px}input{width:100%;padding:12px;margin:10px 0;border:1px solid #ddd;border-radius:8px}button{width:100%;padding:12px;background:#FF9800;color:white;border:none;border-radius:8px;cursor:pointer}</style></head><body><div class="login-card"><h1>LLévame - Admin</h1><form id="loginForm"><input type="text" id="username" placeholder="Usuario"><input type="password" id="password" placeholder="Contraseña"><button type="submit">Iniciar sesión</button></form></div><script>document.getElementById('loginForm').onsubmit=async(e)=>{e.preventDefault();const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario:document.getElementById('username').value,password:document.getElementById('password').value})});const data=await res.json();if(data.token&&data.usuario.rol==='admin'){localStorage.setItem('token',data.token);window.location.href='/admin/dashboard';}else{alert('Credenciales inválidas');}};</script></body></html>`);
});

app.get('/admin/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>LLévame - Dashboard</title><style>body{font-family:system-ui;background:#f5f5f5;padding:20px}.header{background:#FF9800;color:white;padding:20px;border-radius:15px;margin-bottom:20px;display:flex;justify-content:space-between}.card{background:white;padding:20px;border-radius:15px;margin-bottom:20px}button{background:#FF9800;color:white;border:none;padding:10px 20px;border-radius:5px;cursor:pointer}.logout{background:#f44336}</style></head><body><div class="header"><h1>LLévame - Panel Admin</h1><button class="logout" onclick="logout()">Cerrar sesión</button></div><div class="card"><h2>👨‍✈️ Choferes pendientes</h2><div id="pendientes">Cargando...</div></div><script>const token=localStorage.getItem('token');if(!token)window.location.href='/admin/login';async function cargarPendientes(){const res=await fetch('/admin/choferes/pendientes',{headers:{'Authorization':'Bearer '+token}});const data=await res.json();const pendientes=data.choferes||[];const div=document.getElementById('pendientes');if(pendientes.length===0){div.innerHTML='<p>✅ No hay choferes pendientes</p>';}else{let html='';for(const c of pendientes){html+='<div style="padding:10px;border-bottom:1px solid #eee;"><strong>'+c.nombre+'</strong> ('+c.usuario+')<br>Vehículo: '+(c.marca_modelo||c.tipo)+'<br><button onclick="aprobar('+c.usuario_id+')">✓ Aprobar</button></div>';}div.innerHTML=html;}}async function aprobar(id){await fetch('/admin/choferes/aprobar/'+id,{method:'POST',headers:{'Authorization':'Bearer '+token}});cargarPendientes();}function logout(){localStorage.removeItem('token');window.location.href='/admin/login';}cargarPendientes();</script></body></html>`);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});