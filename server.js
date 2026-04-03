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

// Ruta raíz
app.get('/', (req, res) => {
  res.json({ mensaje: '🚕 LLévame API funcionando', version: '2.0' });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚕 LLévame API corriendo en puerto ${PORT}`);
});
