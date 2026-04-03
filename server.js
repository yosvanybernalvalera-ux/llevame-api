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

// Panel de administrador (simple)
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
          const usuario = document.getElementById('username').value;
          const password = document.getElementById('password').value;
          
          const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario, password })
          });
          
          const data = await res.json();
          if (data.token && data.usuario.rol === 'admin') {
            localStorage.setItem('token', data.token);
            window.location.href = '/admin/dashboard';
          } else {
            document.getElementById('error').textContent = 'Acceso denegado. Solo administradores.';
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
        .logout { background: rgba(255,255,255,0.2); border: none; padding: 5px 10px; border-radius: 5px; color: white; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🚕 LLévame - Panel Admin</h1>
        <button class="logout" onclick="logout()">Cerrar sesión</button>
      </div>
      <div class="card">
        <h2>Bienvenido al panel de administración</h2>
        <p>Aquí podrás gestionar choferes, viajes y configuraciones.</p>
        <p style="margin-top: 10px;">✅ Versión base funcionando</p>
      </div>
      <script>
        const token = localStorage.getItem('token');
        if (!token) window.location.href = '/admin/login';
        
        function logout() {
          localStorage.removeItem('token');
          window.location.href = '/admin/login';
        }
      </script>
    </body>
    </html>
  `);
});

// Ruta raíz
app.get('/', (req, res) => {
  res.json({ mensaje: '🚕 LLévame API funcionando', version: '2.0' });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚕 LLévame API corriendo en puerto ${PORT}`);
});
