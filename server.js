<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>LLévame - Cliente</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: system-ui, sans-serif; background: #f5f5f5; padding-bottom: 80px; }
        .header { background: linear-gradient(135deg, #FF9800, #F57C00); color: white; padding: 20px; text-align: center; position: sticky; top: 0; }
        .container { max-width: 500px; margin: 0 auto; padding: 20px; }
        .card { background: white; border-radius: 20px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        input, select { width: 100%; padding: 14px; margin: 10px 0; border: 1px solid #ddd; border-radius: 12px; font-size: 16px; }
        button { width: 100%; padding: 14px; background: #FF9800; color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: bold; cursor: pointer; }
        button:active { transform: scale(0.98); }
        .categorias { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 10px; margin: 15px 0; }
        .categoria-card { background: #f9f9f9; border: 2px solid #eee; border-radius: 12px; padding: 12px; text-align: center; cursor: pointer; }
        .categoria-card.selected { border-color: #FF9800; background: #FFF3E0; }
        .hidden { display: none; }
        .notification { position: fixed; bottom: 20px; left: 20px; right: 20px; background: #333; color: white; padding: 14px; border-radius: 12px; text-align: center; z-index: 1000; }
        .perfil-info { background: #f0f0f0; padding: 15px; border-radius: 12px; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🚕 LLévame</h1>
        <p id="userName">Cliente</p>
    </div>

    <div class="container" id="app">
        <!-- Pantalla de login/registro -->
        <div id="authScreen">
            <div class="card">
                <h2>🔐 Bienvenido</h2>
                <button onclick="mostrarLogin()">Iniciar sesión</button>
                <button onclick="mostrarRegistro()" style="margin-top: 10px; background: #666;">Registrarme</button>
            </div>
        </div>

        <!-- Pantalla de login -->
        <div id="loginScreen" class="hidden">
            <div class="card">
                <h2>Iniciar sesión</h2>
                <input type="text" id="loginUsuario" placeholder="Usuario">
                <input type="password" id="loginPassword" placeholder="Contraseña">
                <button onclick="login()">Entrar</button>
                <button onclick="volver()" style="margin-top: 10px; background: #999;">Volver</button>
            </div>
        </div>

        <!-- Pantalla de registro -->
        <div id="registroScreen" class="hidden">
            <div class="card">
                <h2>Registro de Cliente</h2>
                <input type="text" id="regUsuario" placeholder="Usuario *">
                <input type="password" id="regPassword" placeholder="Contraseña *">
                <input type="text" id="regNombre" placeholder="Nombre *">
                <input type="text" id="regApellidos" placeholder="Apellidos *">
                <input type="text" id="regCi" placeholder="Carnet de Identidad *">
                <input type="tel" id="regTelefono" placeholder="Teléfono">
                <input type="email" id="regEmail" placeholder="Email">
                <button onclick="registro()">Registrarme</button>
                <button onclick="volver()" style="margin-top: 10px; background: #999;">Volver</button>
            </div>
        </div>

        <!-- Pantalla principal (después de login) -->
        <div id="mainScreen" class="hidden">
            <div class="card">
                <h3>📍 Pedir Taxi</h3>
                <input type="text" id="origen" placeholder="¿Dónde estás?">
                <input type="text" id="destino" placeholder="¿A dónde vas?">
                
                <div class="categorias" id="categorias">
                    <div class="categoria-card selected" onclick="seleccionarCategoria('economico')">🚗 Económico</div>
                    <div class="categoria-card" onclick="seleccionarCategoria('confort')">🚙 Confort</div>
                    <div class="categoria-card" onclick="seleccionarCategoria('clasico')">🚘 Clásico</div>
                    <div class="categoria-card" onclick="seleccionarCategoria('lujo')">✨ Lujo</div>
                    <div class="categoria-card" onclick="seleccionarCategoria('moto')">🏍️ Moto</div>
                    <div class="categoria-card" onclick="seleccionarCategoria('triciclo')">🛺 Triciclo</div>
                </div>
                
                <button onclick="solicitarTaxi()">Solicitar Taxi</button>
            </div>

            <div class="card" id="viajeActivo" style="display: none;">
                <h3>🚖 Viaje en curso</h3>
                <div id="estadoViaje"></div>
            </div>

            <div class="card">
                <h3>📋 Mis viajes</h3>
                <div id="historial"></div>
            </div>

            <div class="card">
                <h3>👤 Mi perfil</h3>
                <div id="perfilInfo"></div>
                <button onclick="cerrarSesion()" style="background: #f44336;">Cerrar sesión</button>
            </div>
        </div>
    </div>

    <div id="notification" class="notification hidden"></div>

    <script>
        const API_URL = '';
        let token = localStorage.getItem('token');
        let usuarioActual = null;
        let categoriaSeleccionada = 'economico';
        let viajeActual = null;
        let intervaloEstado = null;

        function mostrarNotificacion(msg, tipo) {
            const notif = document.getElementById('notification');
            notif.textContent = msg;
            notif.classList.remove('hidden');
            notif.style.background = tipo === 'error' ? '#f44336' : '#4CAF50';
            setTimeout(() => notif.classList.add('hidden'), 3000);
        }

        function seleccionarCategoria(cat) {
            categoriaSeleccionada = cat;
            document.querySelectorAll('.categoria-card').forEach((el, i) => {
                const cats = ['economico', 'confort', 'clasico', 'lujo', 'moto', 'triciclo'];
                if (cats[i] === cat) el.classList.add('selected');
                else el.classList.remove('selected');
            });
        }

        async function fetchAPI(url, options = {}) {
            const res = await fetch(url, {
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                ...options
            });
            if (res.status === 401) {
                cerrarSesion();
                throw new Error('Sesión expirada');
            }
            return res.json();
        }

        async function login() {
            const usuario = document.getElementById('loginUsuario').value;
            const password = document.getElementById('loginPassword').value;
            
            if (!usuario || !password) {
                mostrarNotificacion('Completa usuario y contraseña', 'error');
                return;
            }
            
            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ usuario, password })
                });
                const data = await res.json();
                
                if (data.token) {
                    token = data.token;
                    localStorage.setItem('token', token);
                    usuarioActual = data.usuario;
                    document.getElementById('userName').innerHTML = `👤 ${usuarioActual.nombre}`;
                    cargarPerfil();
                    cargarHistorial();
                    mostrarMainScreen();
                    mostrarNotificacion('Bienvenido ' + usuarioActual.nombre, 'exito');
                } else {
                    mostrarNotificacion(data.error || 'Error al iniciar sesión', 'error');
                }
            } catch (error) {
                mostrarNotificacion('Error de conexión', 'error');
            }
        }

        async function registro() {
            const usuario = document.getElementById('regUsuario').value;
            const password = document.getElementById('regPassword').value;
            const nombre = document.getElementById('regNombre').value;
            const apellidos = document.getElementById('regApellidos').value;
            const ci = document.getElementById('regCi').value;
            const telefono = document.getElementById('regTelefono').value;
            const email = document.getElementById('regEmail').value;
            
            if (!usuario || !password || !nombre || !apellidos || !ci) {
                mostrarNotificacion('Completa los campos obligatorios (*)', 'error');
                return;
            }
            
            try {
                const res = await fetch('/api/registro', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ usuario, password, nombre, apellidos, ci, telefono, email })
                });
                const data = await res.json();
                
                if (data.token) {
                    token = data.token;
                    localStorage.setItem('token', token);
                    usuarioActual = data.usuario;
                    document.getElementById('userName').innerHTML = `👤 ${usuarioActual.nombre}`;
                    mostrarMainScreen();
                    mostrarNotificacion('Registro exitoso. Bienvenido', 'exito');
                } else {
                    mostrarNotificacion(data.error || 'Error al registrar', 'error');
                }
            } catch (error) {
                mostrarNotificacion('Error de conexión', 'error');
            }
        }

        async function solicitarTaxi() {
            const origen = document.getElementById('origen').value;
            const destino = document.getElementById('destino').value;
            
            if (!origen || !destino) {
                mostrarNotificacion('Completa origen y destino', 'error');
                return;
            }
            
            try {
                const data = await fetchAPI('/api/viajes/solicitar', {
                    method: 'POST',
                    body: JSON.stringify({ origen, destino, categoria: categoriaSeleccionada })
                });
                
                if (data.exito) {
                    viajeActual = data.viaje;
                    mostrarViajeActivo();
                    iniciarSeguimiento();
                    mostrarNotificacion('✅ Taxi solicitado', 'exito');
                    document.getElementById('origen').value = '';
                    document.getElementById('destino').value = '';
                }
            } catch (error) {
                mostrarNotificacion('Error al solicitar taxi', 'error');
            }
        }

        function mostrarViajeActivo() {
            const div = document.getElementById('viajeActivo');
            div.style.display = 'block';
            actualizarEstadoUI();
        }

        function actualizarEstadoUI() {
            if (!viajeActual) return;
            const estadoDiv = document.getElementById('estadoViaje');
            let texto = '';
            switch(viajeActual.estado) {
                case 'buscando_chofer': texto = '🔄 Buscando chofer...'; break;
                case 'aceptado': texto = '✅ Chofer asignado. En camino'; break;
                case 'en_curso': texto = '🚗 En camino a tu destino'; break;
                case 'completado': texto = '🏁 Viaje completado'; break;
                default: texto = viajeActual.estado;
            }
            estadoDiv.innerHTML = `<strong>${texto}</strong><br>📍 ${viajeActual.origen} → ${viajeActual.destino}<br>💰 ${viajeActual.precio_base} CUP`;
        }

        async function consultarEstado() {
            if (!viajeActual) return;
            try {
                const data = await fetchAPI(`/api/viajes/estado/${viajeActual.id}`);
                if (data.viaje) {
                    viajeActual = data.viaje;
                    actualizarEstadoUI();
                    if (viajeActual.estado === 'completado') {
                        detenerSeguimiento();
                        cargarHistorial();
                    }
                }
            } catch(e) {}
        }

        function iniciarSeguimiento() {
            if (intervaloEstado) clearInterval(intervaloEstado);
            intervaloEstado = setInterval(consultarEstado, 5000);
        }

        function detenerSeguimiento() {
            if (intervaloEstado) clearInterval(intervaloEstado);
            intervaloEstado = null;
        }

        async function cargarHistorial() {
            try {
                const data = await fetchAPI('/api/viajes/mis-viajes');
                const viajes = data.viajes || [];
                const historialDiv = document.getElementById('historial');
                if (viajes.length === 0) {
                    historialDiv.innerHTML = '<p>No hay viajes aún</p>';
                } else {
                    historialDiv.innerHTML = viajes.map(v => `
                        <div style="padding: 10px; border-bottom: 1px solid #eee;">
                            <strong>${v.origen} → ${v.destino}</strong><br>
                            ${new Date(v.creado_en).toLocaleString()}<br>
                            ${v.estado} - ${v.precio_final || v.precio_base} CUP
                        </div>
                    `).join('');
                }
            } catch(e) {}
        }

        async function cargarPerfil() {
            try {
                const data = await fetchAPI('/api/perfil');
                if (data.usuario) {
                    const u = data.usuario;
                    document.getElementById('perfilInfo').innerHTML = `
                        <div class="perfil-info">
                            <strong>${u.nombre} ${u.apellidos}</strong><br>
                            CI: ${u.ci}<br>
                            Tel: ${u.telefono || 'No registrado'}<br>
                            Email: ${u.email || 'No registrado'}<br>
                            Usuario: ${u.usuario}
                        </div>
                    `;
                }
            } catch(e) {}
        }

        function mostrarLogin() {
            document.getElementById('authScreen').classList.add('hidden');
            document.getElementById('loginScreen').classList.remove('hidden');
        }

        function mostrarRegistro() {
            document.getElementById('authScreen').classList.add('hidden');
            document.getElementById('registroScreen').classList.remove('hidden');
        }

        function mostrarMainScreen() {
            document.getElementById('authScreen').classList.add('hidden');
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('registroScreen').classList.add('hidden');
            document.getElementById('mainScreen').classList.remove('hidden');
        }

        function volver() {
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('registroScreen').classList.add('hidden');
            document.getElementById('authScreen').classList.remove('hidden');
        }

        function cerrarSesion() {
            localStorage.removeItem('token');
            token = null;
            detenerSeguimiento();
            location.reload();
        }

        if (token) {
            cargarPerfil();
            cargarHistorial();
            mostrarMainScreen();
        }
    </script>
</body>
</html>
