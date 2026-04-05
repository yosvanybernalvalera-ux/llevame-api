// Este es el código que DEBE estar en tu server.js
// Copia y pega este fragmento exactamente en la posición correcta

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