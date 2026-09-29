/*
 * Libreta de Stock
 * -----------------
 * App de control de víveres/insumos para una finca, pensada para funcionar
 * sin conexión a internet y sincronizarse sola entre dispositivos que
 * compartan el mismo "código de finca" cuando hay internet disponible.
 *
 * No usa ningún framework de interfaz a propósito: es JavaScript "vanilla"
 * (puro), salvo por el SDK de Firebase que se importa como módulo. Esto
 * mantiene la app fácil de leer y explicar.
 *
 * PERSISTENCIA Y SINCRONIZACIÓN DE DATOS
 * ----------------------------------------
 * Los datos viven en Cloud Firestore (una base de datos de Google, con
 * plan gratuito). El propio SDK de Firestore guarda una copia local en el
 * dispositivo (por eso la app sigue funcionando sin internet: se puede
 * seguir registrando movimientos offline) y, apenas hay conexión, sincroniza
 * automáticamente esos cambios con el resto de los dispositivos que usen el
 * mismo "código de finca" (profileId).
 *
 * Cada finca es un documento en la colección "profiles". Dentro de cada
 * finca hay dos sub-colecciones: "products" y "movements". Esto separa
 * completamente los datos de fincas distintas: dos personas probando con
 * códigos diferentes nunca ven los datos de la otra.
 *
 * LIMITACIÓN CONOCIDA (para anotar en la tesis): las reglas de seguridad
 * de Firestore están abiertas (cualquiera que conozca el código de finca
 * puede leer/escribir esos datos). Es una decisión consciente para una
 * prueba piloto con pocas personas conocidas; para producción real
 * convendría agregar autenticación (usuario y contraseña).
 */

import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const DIAS_ALERTA_VENCIMIENTO = 7; // avisar si vence dentro de esta cantidad de días
const CATEGORIAS = ["Alimentos", "Limpieza", "Insumos", "Otros"];
const PROFILE_KEY = "libretaStock:profileId";

// Categorías estándar de bovinos (el "caminito" que sigue cada animal).
// Dependen del sexo: una hembra nunca pasa a Toro, un macho nunca pasa a
// Vaca. Se cambian con "Recategorizar", no editando el animal directamente,
// para que quede guardado el historial de cuándo pasó de una a otra.
const CATEGORIAS_POR_SEXO = {
  Hembra: ["Ternero/a", "Vaquillona", "Vaca", "Vaca de descarte"],
  Macho: ["Ternero/a", "Torito", "Novillito", "Novillo", "Toro"],
};
const CATEGORIAS_GANADO = [...new Set([...CATEGORIAS_POR_SEXO.Hembra, ...CATEGORIAS_POR_SEXO.Macho])];

// Rellena un <select> con las categorías que corresponden a un sexo. Si el
// animal ya tenía cargada una categoría que no está en esa lista (por
// ejemplo, datos cargados antes de este cambio), se agrega igual al
// principio para no perder ni esconder esa información.
function poblarSelectCategorias(select, sexo, valorActual) {
  const categorias = CATEGORIAS_POR_SEXO[sexo] || CATEGORIAS_GANADO;
  const opciones = valorActual && !categorias.includes(valorActual)
    ? [valorActual, ...categorias]
    : categorias;
  select.innerHTML = opciones.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("");
  if (valorActual) select.value = valorActual;
}

/* =====================================================================
   1) FIREBASE: inicialización + identificación de la "finca" (perfil)
   ===================================================================== */

const firebaseApp = initializeApp(firebaseConfig);

// persistentLocalCache = guarda los datos también en el propio dispositivo
// (IndexedDB), para que la app funcione offline igual que antes.
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
});

let profileId = localStorage.getItem(PROFILE_KEY);

// `state` sigue siendo el objeto en memoria que usa toda la interfaz.
// Ahora se llena a partir de lo que llega de Firestore (ver sección 2),
// no de localStorage directamente.
let state = { products: [], movements: [], animals: [], animalMovements: [], weighings: [] };

function referenciaProductos() {
  return collection(db, "profiles", profileId, "products");
}
function referenciaMovimientos() {
  return collection(db, "profiles", profileId, "movements");
}
function referenciaAnimales() {
  return collection(db, "profiles", profileId, "animals");
}
function referenciaMovimientosAnimales() {
  return collection(db, "profiles", profileId, "animalMovements");
}
function referenciaPesajes() {
  return collection(db, "profiles", profileId, "animalWeighings");
}

function generarId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* =====================================================================
   1.1) MODAL: elegir código de finca (una sola vez por dispositivo)
   ===================================================================== */

function iniciarConPerfil(id) {
  profileId = id.trim();
  localStorage.setItem(PROFILE_KEY, profileId);
  document.getElementById("modal-perfil").hidden = true;
  suscribirseAFirestore();
}

document.getElementById("form-perfil").addEventListener("submit", (e) => {
  e.preventDefault();
  const valor = document.getElementById("f-perfil").value.trim();
  if (!valor) return;
  iniciarConPerfil(valor);
});

document.getElementById("btn-cambiar-perfil").addEventListener("click", () => {
  if (!confirm("Vas a dejar de ver los datos de esta finca en este dispositivo y vas a poder cargar otro código. ¿Continuar?")) return;
  localStorage.removeItem(PROFILE_KEY);
  location.reload();
});

/* =====================================================================
   1.2) Escuchar cambios en tiempo real (esto reemplaza a guardarEstado)
   Cada vez que algo cambia -acá o en otro dispositivo con el mismo
   código de finca- estas funciones se disparan solas y redibujan la app.
   ===================================================================== */

function suscribirseAFirestore() {
  onSnapshot(referenciaProductos(), (snapshot) => {
    state.products = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderizarTodo();
  }, (error) => {
    console.error("Error escuchando productos:", error);
  });

  onSnapshot(referenciaMovimientos(), (snapshot) => {
    state.movements = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderizarTodo();
  }, (error) => {
    console.error("Error escuchando movimientos:", error);
  });

  onSnapshot(referenciaAnimales(), (snapshot) => {
    state.animals = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderizarTodo();
  }, (error) => {
    console.error("Error escuchando animales:", error);
  });

  onSnapshot(referenciaMovimientosAnimales(), (snapshot) => {
    state.animalMovements = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderizarTodo();
  }, (error) => {
    console.error("Error escuchando movimientos de animales:", error);
  });

  onSnapshot(referenciaPesajes(), (snapshot) => {
    state.weighings = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderizarTodo();
  }, (error) => {
    console.error("Error escuchando pesajes:", error);
  });
}

if (profileId) {
  suscribirseAFirestore();
} else {
  document.getElementById("modal-perfil").hidden = false;
}

/* =====================================================================
   2) UTILIDADES
   ===================================================================== */

function formatearFecha(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("es-PY", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatearFechaHora(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("es-PY", { day: "2-digit", month: "2-digit" }) +
    " " + d.toLocaleTimeString("es-PY", { hour: "2-digit", minute: "2-digit" });
}

function diasHasta(fechaISO) {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const fecha = new Date(fechaISO + "T00:00:00");
  return Math.round((fecha - hoy) / (1000 * 60 * 60 * 24));
}

function estaStockBajo(producto) {
  return producto.minStock !== null && producto.minStock !== undefined &&
    producto.minStock !== "" && producto.quantity <= Number(producto.minStock);
}

function estaPorVencer(producto) {
  if (!producto.expirationDate) return false;
  const dias = diasHasta(producto.expirationDate);
  return dias <= DIAS_ALERTA_VENCIMIENTO;
}

/* ---------------------------------------------------------------------
   PREDICCIÓN DE AGOTAMIENTO POR CONSUMO REAL
   -----------------------------------------------------------------------
   En vez de avisar solo cuando se cruza un mínimo fijo (que hay que cargar
   a mano y no siempre se actualiza), esto mira las salidas registradas de
   cada producto en los últimos VENTANA_DIAS días, calcula un consumo
   promedio por día, y estima cuántos días de stock quedan al ritmo actual.
   Esto se acerca a la idea de "punto de reorden" de gestión de inventarios:
   en vez de un umbral fijo, se basa en la velocidad real de consumo.
   ------------------------------------------------------------------- */

const VENTANA_CONSUMO_DIAS = 30;
const DIAS_ALERTA_AGOTAMIENTO = 5; // avisar si el stock se agota en 5 días o menos

function consumoDiarioPromedio(productId) {
  const ahora = new Date();
  const limite = new Date(ahora);
  limite.setDate(limite.getDate() - VENTANA_CONSUMO_DIAS);

  const salidas = state.movements.filter(
    (m) => m.productId === productId && m.type === "salida" && new Date(m.date) >= limite
  );
  // Con un solo registro de salida no hay forma honesta de estimar un
  // "ritmo" de consumo (¿esos 9kg se comieron en un día, o en una semana
  // que se cargó como un solo movimiento? no hay cómo saberlo con 1 dato).
  // Por eso pedimos al menos 2 salidas antes de animarnos a predecir algo.
  if (salidas.length < 2) return null;

  const total = salidas.reduce((acc, m) => acc + m.quantity, 0);
  const fechaMasAntigua = salidas.reduce(
    (min, m) => (new Date(m.date) < min ? new Date(m.date) : min),
    new Date(salidas[0].date)
  );
  // Días realmente transcurridos desde la primera salida registrada en la
  // ventana (mínimo 1, para no dividir por 0 si todo pasó el mismo día).
  const diasTranscurridos = Math.max(1, (ahora - fechaMasAntigua) / (1000 * 60 * 60 * 24));

  return total / diasTranscurridos;
}

function diasHastaAgotamiento(producto) {
  const consumo = consumoDiarioPromedio(producto.id);
  if (!consumo || consumo <= 0) return null;
  return producto.quantity / consumo;
}

function estaPorAgotarse(producto) {
  const dias = diasHastaAgotamiento(producto);
  return dias !== null && dias <= DIAS_ALERTA_AGOTAMIENTO;
}

/* ---------------------------------------------------------------------
   PESAJES Y GANANCIA DE PESO
   -----------------------------------------------------------------------
   Dato productivo/zootécnico, no comercial: solo kilos y tiempo, nada de
   precios. Con 2 o más pesajes de un animal se puede calcular cuánto ganó
   entre el primero y el último, y un promedio de kg/día.
   ------------------------------------------------------------------- */

const DIAS_ALERTA_SIN_PESAR = 45; // aviso si un animal activo no se pesa hace más de esto

function pesajesDelAnimal(animalId) {
  return state.weighings
    .filter((p) => p.animalId === animalId)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

function gananciaDePeso(animalId) {
  const pesajes = pesajesDelAnimal(animalId);
  if (pesajes.length < 2) return null;

  const primero = pesajes[0];
  const ultimo = pesajes[pesajes.length - 1];
  const gananciaTotal = ultimo.peso - primero.peso;
  const diasTranscurridos = Math.max(
    1,
    (new Date(ultimo.fecha) - new Date(primero.fecha)) / (1000 * 60 * 60 * 24)
  );
  return {
    gananciaTotal: round2(gananciaTotal),
    gananciaDiaria: round2(gananciaTotal / diasTranscurridos),
    dias: Math.round(diasTranscurridos),
  };
}

function diasSinPesar(animal) {
  const pesajes = pesajesDelAnimal(animal.id);
  if (pesajes.length === 0) return null;
  const ultimo = pesajes[pesajes.length - 1];
  return Math.round((new Date() - new Date(ultimo.fecha)) / (1000 * 60 * 60 * 24));
}

function haceMuchoQueNoSePesa(animal) {
  if (animal.estado !== "Activo") return false;
  const dias = diasSinPesar(animal);
  return dias !== null && dias >= DIAS_ALERTA_SIN_PESAR;
}

function mostrarToast(mensaje) {
  const toast = document.getElementById("toast");
  toast.textContent = mensaje;
  toast.hidden = false;
  clearTimeout(mostrarToast._t);
  mostrarToast._t = setTimeout(() => { toast.hidden = true; }, 2400);
}

/* =====================================================================
   3) NAVEGACIÓN
   La app tiene una pantalla principal (landing) donde se elige entre
   "Libreta de Stock" y "Ganado". Cada sección es su propio mini-mundo,
   con su propia barra de pestañas: Stock tiene Inicio/Inventario/
   Movimientos, Ganado tiene Animales/Movimientos.
   ===================================================================== */

const TODAS_LAS_VISTAS = ["landing", "inicio", "inventario", "ganado", "ganado-movimientos", "movimientos"];

let seccionActual = "landing"; // "landing" | "stock" | "ganado"
let vistaStockActual = "inicio"; // solo aplica cuando seccionActual === "stock"
let vistaGanadoActual = "ganado"; // solo aplica cuando seccionActual === "ganado"

const TITULOS = { landing: "Mi Finca", stock: "Libreta de Stock", ganado: "Ganado" };

// El botón flotante (+) hace algo distinto según dónde estés. En las
// pestañas de "Movimientos" (de Stock o de Ganado) no tiene sentido
// "agregar" nada directo ahí, así que el botón se esconde.
const FAB_CONFIG = {
  inventario: { texto: "+ Agregar producto", accion: () => abrirModalNuevoProducto() },
  ganado: { texto: "+ Agregar animal", accion: () => abrirModalNuevoAnimal() },
};

function mostrarVista(nombre) {
  TODAS_LAS_VISTAS.forEach((v) => {
    document.getElementById(`view-${v}`).hidden = v !== nombre;
  });
}

function actualizarFab(clave) {
  const fab = document.getElementById("btn-agregar");
  const config = FAB_CONFIG[clave];
  fab.hidden = !config;
  if (config) fab.textContent = config.texto;
}

// Ir a la pantalla principal (landing)
function irALanding() {
  seccionActual = "landing";
  document.getElementById("header-titulo").textContent = TITULOS.landing;
  document.getElementById("btn-volver").hidden = true;
  document.getElementById("tabs-stock").hidden = true;
  document.getElementById("tabs-ganado").hidden = true;
  mostrarVista("landing");
  actualizarFab(null);
}

// Entrar a una sección desde el landing ("stock" o "ganado")
function entrarASeccion(seccion) {
  seccionActual = seccion;
  document.getElementById("header-titulo").textContent = TITULOS[seccion];
  document.getElementById("btn-volver").hidden = false;

  if (seccion === "stock") {
    document.getElementById("tabs-ganado").hidden = true;
    document.getElementById("tabs-stock").hidden = false;
    irAVistaStock(vistaStockActual);
  } else {
    document.getElementById("tabs-stock").hidden = true;
    document.getElementById("tabs-ganado").hidden = false;
    irAVistaGanado(vistaGanadoActual);
  }
}

// Cambiar de pestaña dentro de Ganado (Animales/Movimientos)
function irAVistaGanado(nombre) {
  vistaGanadoActual = nombre;
  mostrarVista(nombre);
  document.querySelectorAll("#tabs-ganado .tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === nombre);
  });
  actualizarFab(nombre);
  renderizarTodo();
}

document.querySelectorAll("#tabs-ganado .tab").forEach((btn) => {
  btn.addEventListener("click", () => irAVistaGanado(btn.dataset.view));
});

// Cambiar de pestaña dentro de Stock (Inicio/Inventario/Movimientos)
function irAVistaStock(nombre) {
  vistaStockActual = nombre;
  mostrarVista(nombre);
  document.querySelectorAll("#tabs-stock .tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === nombre);
  });
  actualizarFab(nombre);
  renderizarTodo();
}

document.querySelectorAll(".landing-card").forEach((btn) => {
  btn.addEventListener("click", () => entrarASeccion(btn.dataset.seccion));
});

document.getElementById("btn-volver").addEventListener("click", irALanding);

document.querySelectorAll("#tabs-stock .tab").forEach((btn) => {
  btn.addEventListener("click", () => irAVistaStock(btn.dataset.view));
});

document.getElementById("btn-agregar").addEventListener("click", () => {
  const clave = seccionActual === "stock" ? vistaStockActual
    : seccionActual === "ganado" ? vistaGanadoActual
    : null;
  const config = FAB_CONFIG[clave];
  if (config) config.accion();
});

/* =====================================================================
   4) RENDER: INICIO (alertas + resumen + últimos movimientos)
   ===================================================================== */

function renderizarInicio() {
  const bajos = state.products.filter(estaStockBajo);
  const porVencer = state.products.filter(estaPorVencer);
  // Solo se muestra la alerta de "se va a agotar" si el producto no tiene
  // ya la alerta de stock bajo (para no repetir el mismo aviso dos veces).
  const porAgotarse = state.products.filter((p) => estaPorAgotarse(p) && !estaStockBajo(p));

  const alertasBox = document.getElementById("alertas-box");
  const alertasList = document.getElementById("alertas-list");
  alertasList.innerHTML = "";

  const alertas = [
    ...bajos.map((p) => ({ p, texto: `Quedan ${p.quantity} ${p.unit}` })),
    ...porAgotarse.map((p) => {
      const dias = Math.round(diasHastaAgotamiento(p));
      const texto = dias <= 0 ? "Se estaría agotando hoy" : `Se agotaría en ~${dias} día(s) al ritmo actual`;
      return { p, texto };
    }),
    ...porVencer.map((p) => {
      const dias = diasHasta(p.expirationDate);
      const texto = dias < 0 ? "Ya venció" : dias === 0 ? "Vence hoy" : `Vence en ${dias} día(s)`;
      return { p, texto };
    }),
  ];

  alertasBox.hidden = alertas.length === 0;
  alertas.forEach(({ p, texto }) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHTML(p.name)}</span><span class="alert-detail">${escapeHTML(texto)}</span>`;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => abrirModalProducto(p.id));
    alertasList.appendChild(li);
  });

  document.getElementById("stat-productos").textContent = state.products.length;
  document.getElementById("stat-bajos").textContent = bajos.length;
  document.getElementById("stat-vencer").textContent = porVencer.length;
  document.getElementById("stat-animales").textContent = state.animals.filter((a) => a.estado === "Activo").length;

  const ultimos = [...state.movements].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const ul = document.getElementById("ultimos-movs");
  ul.innerHTML = "";
  document.getElementById("ultimos-movs-empty").hidden = ultimos.length > 0;
  ultimos.forEach((m) => ul.appendChild(crearFilaMovimiento(m)));
}

/* =====================================================================
   5) RENDER: INVENTARIO (filtro por categoría + fichas por producto)
   ===================================================================== */

let categoriaActiva = "Todas";

function renderizarFiltroCategorias() {
  const cont = document.getElementById("cat-filter");
  cont.innerHTML = "";
  const opciones = ["Todas", ...CATEGORIAS];
  opciones.forEach((cat) => {
    const btn = document.createElement("button");
    btn.className = "cat-chip" + (cat === categoriaActiva ? " active" : "");
    btn.textContent = cat;
    btn.addEventListener("click", () => {
      categoriaActiva = cat;
      renderizarInventario();
    });
    cont.appendChild(btn);
  });
}

function renderizarInventario() {
  renderizarFiltroCategorias();
  const cont = document.getElementById("inventario-list");
  cont.innerHTML = "";

  const productos = state.products.filter(
    (p) => categoriaActiva === "Todas" || p.category === categoriaActiva
  );

  document.getElementById("inventario-empty").hidden = state.products.length > 0;

  const categoriasAMostrar = categoriaActiva === "Todas" ? CATEGORIAS : [categoriaActiva];

  categoriasAMostrar.forEach((cat) => {
    const items = productos.filter((p) => p.category === cat)
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
    if (items.length === 0) return;

    const grupo = document.createElement("div");
    grupo.className = "cat-group";
    grupo.innerHTML = `<h3 class="cat-group-title">${escapeHTML(cat)}</h3>`;

    items.forEach((p) => grupo.appendChild(crearFilaProducto(p)));
    cont.appendChild(grupo);
  });
}

function crearFilaProducto(p) {
  const row = document.createElement("div");
  const alertaAgotamiento = estaPorAgotarse(p) && !estaStockBajo(p);
  row.className = "item-row" + (estaStockBajo(p) || alertaAgotamiento ? " low" : "");

  const info = document.createElement("div");
  info.className = "item-info";
  let metaHTML = `${p.quantity} ${escapeHTML(p.unit)}`;
  let metaClass = "item-meta";
  if (estaStockBajo(p)) { metaHTML += ` · stock bajo (mín. ${p.minStock})`; metaClass += " warn"; }
  if (p.expirationDate) {
    const dias = diasHasta(p.expirationDate);
    metaHTML += ` · vence ${formatearFecha(p.expirationDate)}`;
    if (dias <= DIAS_ALERTA_VENCIMIENTO) metaClass += " warn";
  }
  const consumo = consumoDiarioPromedio(p.id);
  if (consumo) {
    const diasRestantes = Math.round(p.quantity / consumo);
    metaHTML += ` · consumís ~${redondearConsumo(consumo)} ${escapeHTML(p.unit)}/día (quedan ~${diasRestantes} día${diasRestantes === 1 ? "" : "s"})`;
    if (alertaAgotamiento) metaClass += " warn";
  }
  info.innerHTML = `<span class="item-name">${escapeHTML(p.name)}</span><span class="${metaClass}">${metaHTML}</span>`;
  info.addEventListener("click", () => abrirModalProducto(p.id));

  const stepper = document.createElement("div");
  stepper.className = "stepper";
  stepper.innerHTML = `
    <button class="minus" aria-label="Registrar salida" data-tipo="salida">−</button>
    <button class="plus" aria-label="Registrar entrada" data-tipo="entrada">+</button>
  `;
  stepper.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => abrirModalMovimiento(p.id, btn.dataset.tipo));
  });

  row.appendChild(info);
  row.appendChild(stepper);
  return row;
}

/* =====================================================================
   6) RENDER: MOVIMIENTOS (historial completo)
   ===================================================================== */

function renderizarMovimientos() {
  const ul = document.getElementById("movimientos-list");
  ul.innerHTML = "";
  const lista = [...state.movements].sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById("movimientos-empty").hidden = lista.length > 0;
  lista.forEach((m) => ul.appendChild(crearFilaMovimiento(m)));
}

function crearFilaMovimiento(m) {
  const li = document.createElement("li");
  const producto = state.products.find((p) => p.id === m.productId);
  const nombre = producto ? producto.name : "(producto eliminado)";
  li.innerHTML = `
    <div class="mov-main">
      <span class="mov-tag ${m.type}">${m.type === "entrada" ? "Entrada" : "Salida"}</span>
      <div>${escapeHTML(nombre)} — ${m.quantity} ${producto ? escapeHTML(producto.unit) : ""}</div>
      ${m.note ? `<div class="item-meta">${escapeHTML(m.note)}</div>` : ""}
    </div>
    <div class="mov-date">${formatearFechaHora(m.date)}</div>
  `;
  return li;
}

/* =====================================================================
   6.5) RENDER: GANADO (filtro por lote + fichas de animal)
   ===================================================================== */

let loteActivo = "Todos";

function renderizarFiltroLotes() {
  const cont = document.getElementById("ganado-filter");
  cont.innerHTML = "";
  const lotes = Array.from(new Set(state.animals.map((a) => a.lote || "Sin lote"))).sort((a, b) => a.localeCompare(b, "es"));
  const opciones = ["Todos", ...lotes];
  opciones.forEach((lote) => {
    const btn = document.createElement("button");
    btn.className = "cat-chip" + (lote === loteActivo ? " active" : "");
    btn.textContent = lote;
    btn.addEventListener("click", () => {
      loteActivo = lote;
      renderizarGanado();
    });
    cont.appendChild(btn);
  });
}

function renderizarGanado() {
  renderizarFiltroLotes();
  const cont = document.getElementById("ganado-list");
  cont.innerHTML = "";

  const animales = state.animals.filter(
    (a) => loteActivo === "Todos" || (a.lote || "Sin lote") === loteActivo
  );

  document.getElementById("ganado-empty").hidden = state.animals.length > 0;

  const lotesAMostrar = loteActivo === "Todos"
    ? Array.from(new Set(animales.map((a) => a.lote || "Sin lote"))).sort((a, b) => a.localeCompare(b, "es"))
    : [loteActivo];

  lotesAMostrar.forEach((lote) => {
    const items = animales.filter((a) => (a.lote || "Sin lote") === lote)
      .sort((a, b) => a.caravana.localeCompare(b.caravana, "es", { numeric: true }));
    if (items.length === 0) return;

    const grupo = document.createElement("div");
    grupo.className = "cat-group";
    grupo.innerHTML = `<h3 class="cat-group-title">${escapeHTML(lote)} (${items.length})</h3>`;
    items.forEach((a) => grupo.appendChild(crearFilaAnimal(a)));
    cont.appendChild(grupo);
  });
}

function crearFilaAnimal(a) {
  const row = document.createElement("div");
  const sinPesar = haceMuchoQueNoSePesa(a);
  row.className = "item-row" + (a.estado !== "Activo" || sinPesar ? " low" : "");

  const info = document.createElement("div");
  info.className = "item-info";
  let metaHTML = `${escapeHTML(a.categoria)} · ${escapeHTML(a.sexo)}`;
  let metaClass = "item-meta";
  if (a.estado !== "Activo") { metaHTML += ` · ${escapeHTML(a.estado)}`; metaClass += " warn"; }
  if (sinPesar) { metaHTML += ` · sin pesar hace ${diasSinPesar(a)} días`; metaClass += " warn"; }
  info.innerHTML = `<span class="item-name">Caravana ${escapeHTML(a.caravana)}</span><span class="${metaClass}">${metaHTML}</span>`;
  info.addEventListener("click", () => abrirModalAnimal(a.id));

  row.appendChild(info);
  return row;
}

/* =====================================================================
   6.6) RENDER: MOVIMIENTOS DE GANADO (ingresos, egresos, recategorizaciones)
   ===================================================================== */

const ETIQUETA_TIPO_MOV_ANIMAL = { ingreso: "Ingreso", egreso: "Egreso", recategorizacion: "Recateg." };
const CLASE_TIPO_MOV_ANIMAL = { ingreso: "entrada", egreso: "salida", recategorizacion: "entrada" };

function renderizarGanadoMovimientos() {
  const ul = document.getElementById("ganado-movimientos-list");
  ul.innerHTML = "";
  const lista = [...state.animalMovements].sort((a, b) => b.fecha.localeCompare(a.fecha));
  document.getElementById("ganado-movimientos-empty").hidden = lista.length > 0;
  lista.forEach((m) => ul.appendChild(crearFilaMovimientoAnimal(m)));
}

function crearFilaMovimientoAnimal(m) {
  const li = document.createElement("li");
  const animal = state.animals.find((a) => a.id === m.animalId);
  const nombre = animal ? `Caravana ${animal.caravana}` : "(animal eliminado)";

  let detalle = m.motivo || "";
  if (m.tipo === "recategorizacion") {
    detalle = `${escapeHTML(m.categoriaAnterior || "?")} → ${escapeHTML(m.categoriaNueva || "?")}`;
  }
  if (m.tipo === "egreso" && m.guiaSenacsa) {
    detalle += ` · Guía SENACSA ${escapeHTML(m.guiaSenacsa)}`;
  }

  li.innerHTML = `
    <div class="mov-main">
      <span class="mov-tag ${CLASE_TIPO_MOV_ANIMAL[m.tipo]}">${ETIQUETA_TIPO_MOV_ANIMAL[m.tipo]}</span>
      <div>${escapeHTML(nombre)} — ${detalle}</div>
      ${m.nota ? `<div class="item-meta">${escapeHTML(m.nota)}</div>` : ""}
    </div>
    <div class="mov-date">${formatearFecha(m.fecha)}</div>
  `;
  return li;
}

/* =====================================================================
   7) RENDER GENERAL
   ===================================================================== */

function renderizarTodo() {
  renderizarInicio();
  renderizarInventario();
  renderizarGanado();
  renderizarGanadoMovimientos();
  renderizarMovimientos();
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

/* =====================================================================
   8) MODAL: agregar / editar producto
   ===================================================================== */

const modalProducto = document.getElementById("modal-producto");
const formProducto = document.getElementById("form-producto");
let productoEnEdicion = null; // id del producto si estamos editando, null si es nuevo

function abrirModalNuevoProducto() {
  productoEnEdicion = null;
  document.getElementById("modal-producto-titulo").textContent = "Agregar producto";
  document.getElementById("btn-eliminar-producto").hidden = true;
  formProducto.reset();
  document.getElementById("f-categoria").value = CATEGORIAS[0];
  document.getElementById("f-unidad").value = "kg";
  modalProducto.hidden = false;
  setTimeout(() => document.getElementById("f-nombre").focus(), 50);
}

function abrirModalProducto(id) {
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  productoEnEdicion = id;
  document.getElementById("modal-producto-titulo").textContent = "Editar producto";
  document.getElementById("btn-eliminar-producto").hidden = false;
  document.getElementById("f-nombre").value = p.name;
  document.getElementById("f-categoria").value = p.category;
  document.getElementById("f-cantidad").value = p.quantity;
  document.getElementById("f-unidad").value = p.unit;
  document.getElementById("f-minimo").value = p.minStock ?? "";
  document.getElementById("f-vencimiento").value = p.expirationDate || "";
  modalProducto.hidden = false;
}

function cerrarModalProducto() {
  modalProducto.hidden = true;
  productoEnEdicion = null;
}

document.getElementById("btn-cancelar-producto").addEventListener("click", cerrarModalProducto);

formProducto.addEventListener("submit", (e) => {
  e.preventDefault();
  const datos = {
    name: document.getElementById("f-nombre").value.trim(),
    category: document.getElementById("f-categoria").value,
    quantity: Number(document.getElementById("f-cantidad").value),
    unit: document.getElementById("f-unidad").value,
    minStock: document.getElementById("f-minimo").value === "" ? null : Number(document.getElementById("f-minimo").value),
    expirationDate: document.getElementById("f-vencimiento").value || null,
  };

  if (!datos.name) return;

  // Aviso suave (no bloquea) ante una cantidad llamativamente alta: suele
  // ser un cero de más al tipear, no un error grave, así que se avisa y se
  // deja seguir si la persona confirma que es correcto.
  const CANTIDAD_SOSPECHOSA = 100000;
  if (datos.quantity >= CANTIDAD_SOSPECHOSA) {
    if (!confirm(`Cargaste ${datos.quantity} ${datos.unit}. ¿Es correcto? (revisá que no sobre un cero)`)) return;
  }

  if (productoEnEdicion) {
    setDoc(doc(referenciaProductos(), productoEnEdicion), datos, { merge: true })
      .catch((err) => { console.error(err); mostrarToast("No se pudo guardar (revisá tu conexión)"); });
    mostrarToast("Producto actualizado");
  } else {
    const nuevoId = generarId();
    setDoc(doc(referenciaProductos(), nuevoId), { ...datos, createdAt: new Date().toISOString() })
      .catch((err) => { console.error(err); mostrarToast("No se pudo guardar (revisá tu conexión)"); });
    mostrarToast("Producto agregado");
  }

  // No hace falta llamar a renderizarTodo() acá: apenas Firestore confirma el
  // cambio en su copia local (instantáneo, incluso offline), el listener de
  // la sección 1.2 se dispara solo y redibuja la pantalla.
  cerrarModalProducto();
});

document.getElementById("btn-eliminar-producto").addEventListener("click", () => {
  if (!productoEnEdicion) return;
  if (!confirm("¿Eliminar este producto? También se borrará su historial de movimientos.")) return;

  deleteDoc(doc(referenciaProductos(), productoEnEdicion)).catch(console.error);
  state.movements
    .filter((m) => m.productId === productoEnEdicion)
    .forEach((m) => deleteDoc(doc(referenciaMovimientos(), m.id)).catch(console.error));

  cerrarModalProducto();
  mostrarToast("Producto eliminado");
});

/* =====================================================================
   8.5) MODAL: agregar / editar animal
   ===================================================================== */

const modalAnimal = document.getElementById("modal-animal");
const formAnimal = document.getElementById("form-animal");
let animalEnEdicion = null;

function abrirModalNuevoAnimal() {
  animalEnEdicion = null;
  document.getElementById("modal-animal-titulo").textContent = "Agregar animal";
  document.getElementById("btn-eliminar-animal").hidden = true;
  document.getElementById("a-acciones-historial").hidden = true;
  document.getElementById("a-categoria").disabled = false;
  document.getElementById("a-categoria-nota").hidden = true;
  document.getElementById("a-pesajes-seccion").hidden = true;
  formAnimal.reset();
  document.getElementById("a-fecha-ingreso").value = new Date().toISOString().slice(0, 10);
  // La lista de categorías depende del sexo elegido (por defecto, el
  // primero del <select>, que es "Hembra").
  poblarSelectCategorias(document.getElementById("a-categoria"), document.getElementById("a-sexo").value, null);
  modalAnimal.hidden = false;
  setTimeout(() => document.getElementById("a-caravana").focus(), 50);
}

function abrirModalAnimal(id) {
  const a = state.animals.find((x) => x.id === id);
  if (!a) return;
  animalEnEdicion = id;
  document.getElementById("modal-animal-titulo").textContent = "Editar animal";
  document.getElementById("btn-eliminar-animal").hidden = false;
  document.getElementById("a-acciones-historial").hidden = false;
  // La categoría de un animal que ya existe no se edita a mano acá: se
  // cambia con el botón "Recategorizar", para que quede guardado el
  // historial de cuándo pasó de una categoría a otra.
  document.getElementById("a-categoria").disabled = true;
  document.getElementById("a-categoria-nota").hidden = false;
  document.getElementById("a-caravana").value = a.caravana;
  document.getElementById("a-sexo").value = a.sexo;
  poblarSelectCategorias(document.getElementById("a-categoria"), a.sexo, a.categoria);
  document.getElementById("a-lote").value = a.lote || "";
  document.getElementById("a-estado").value = a.estado;
  document.getElementById("a-origen").value = a.origen;
  document.getElementById("a-fecha-ingreso").value = a.fechaIngreso || "";
  document.getElementById("a-pesajes-seccion").hidden = false;
  renderizarPesajesDelAnimal(a.id);
  modalAnimal.hidden = false;
}

function renderizarPesajesDelAnimal(animalId) {
  const pesajes = pesajesDelAnimal(animalId);
  const ul = document.getElementById("a-pesajes-list");
  ul.innerHTML = "";
  document.getElementById("a-pesajes-empty").hidden = pesajes.length > 0;

  // Se muestran del más nuevo al más viejo, igual que el resto de los historiales.
  [...pesajes].reverse().forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="mov-main">${p.peso} kg${p.nota ? ` <span class="item-meta">${escapeHTML(p.nota)}</span>` : ""}</div>
      <div class="mov-date">${formatearFecha(p.fecha)}</div>
    `;
    ul.appendChild(li);
  });

  const ganancia = gananciaDePeso(animalId);
  const resumen = document.getElementById("a-pesajes-resumen");
  if (ganancia) {
    const signo = ganancia.gananciaTotal >= 0 ? "+" : "";
    resumen.textContent = `${signo}${ganancia.gananciaTotal} kg en ${ganancia.dias} días (${signo}${ganancia.gananciaDiaria} kg/día promedio)`;
  } else {
    resumen.textContent = pesajes.length === 1 ? "Con un pesaje más se va a poder calcular la ganancia." : "";
  }
}

// Si cambiás el sexo (solo pasa al cargar un animal nuevo, ya que al
// editar la categoría queda bloqueada), la lista de categorías se actualiza
// para mostrar solo las que tienen sentido para ese sexo.
document.getElementById("a-sexo").addEventListener("change", (e) => {
  if (document.getElementById("a-categoria").disabled) return;
  poblarSelectCategorias(document.getElementById("a-categoria"), e.target.value, null);
});

function cerrarModalAnimal() {
  modalAnimal.hidden = true;
  animalEnEdicion = null;
}

document.getElementById("btn-cancelar-animal").addEventListener("click", cerrarModalAnimal);

formAnimal.addEventListener("submit", (e) => {
  e.preventDefault();
  const datos = {
    caravana: document.getElementById("a-caravana").value.trim(),
    categoria: document.getElementById("a-categoria").value,
    sexo: document.getElementById("a-sexo").value,
    lote: document.getElementById("a-lote").value.trim(),
    estado: document.getElementById("a-estado").value,
    origen: document.getElementById("a-origen").value,
    fechaIngreso: document.getElementById("a-fecha-ingreso").value || null,
  };

  if (!datos.caravana) return;

  // Aviso de caravana duplicada: solo contra animales Activos (si un animal
  // ya salió, es normal que la caravana se reutilice en otro más adelante).
  const duplicado = state.animals.find(
    (x) => x.id !== animalEnEdicion && x.estado === "Activo" &&
      x.caravana.trim().toLowerCase() === datos.caravana.toLowerCase()
  );
  if (duplicado) {
    const seguro = confirm(`Ya hay un animal activo con la caravana "${duplicado.caravana}". ¿Guardar igual?`);
    if (!seguro) return;
  }

  if (animalEnEdicion) {
    setDoc(doc(referenciaAnimales(), animalEnEdicion), datos, { merge: true })
      .catch((err) => { console.error(err); mostrarToast("No se pudo guardar (revisá tu conexión)"); });
    mostrarToast("Animal actualizado");
  } else {
    const nuevoId = generarId();
    setDoc(doc(referenciaAnimales(), nuevoId), { ...datos, createdAt: new Date().toISOString() })
      .catch((err) => { console.error(err); mostrarToast("No se pudo guardar (revisá tu conexión)"); });

    // El alta del animal ES el movimiento de "ingreso" (Nacimiento/Compra),
    // así que queda registrado en el historial sin pedirle un paso extra.
    setDoc(doc(referenciaMovimientosAnimales(), generarId()), {
      animalId: nuevoId,
      tipo: "ingreso",
      motivo: datos.origen,
      fecha: datos.fechaIngreso || new Date().toISOString().slice(0, 10),
    }).catch(console.error);

    mostrarToast("Animal agregado");
  }

  cerrarModalAnimal();
});

document.getElementById("btn-eliminar-animal").addEventListener("click", () => {
  if (!animalEnEdicion) return;
  if (!confirm("¿Eliminar este animal del registro? También se borrará su historial de ingresos/egresos/recategorizaciones.")) return;
  deleteDoc(doc(referenciaAnimales(), animalEnEdicion)).catch(console.error);
  state.animalMovements
    .filter((m) => m.animalId === animalEnEdicion)
    .forEach((m) => deleteDoc(doc(referenciaMovimientosAnimales(), m.id)).catch(console.error));
  state.weighings
    .filter((p) => p.animalId === animalEnEdicion)
    .forEach((p) => deleteDoc(doc(referenciaPesajes(), p.id)).catch(console.error));
  cerrarModalAnimal();
  mostrarToast("Animal eliminado");
});

/* =====================================================================
   8.6) MODAL: recategorizar animal
   ===================================================================== */

const modalRecategorizar = document.getElementById("modal-recategorizar");
const formRecategorizar = document.getElementById("form-recategorizar");

document.getElementById("btn-recategorizar-animal").addEventListener("click", () => {
  if (!animalEnEdicion) return;
  const a = state.animals.find((x) => x.id === animalEnEdicion);
  if (!a) return;
  document.getElementById("recategorizar-subtitulo").textContent = `Caravana ${a.caravana} (${a.sexo}) — categoría actual: ${a.categoria}`;
  poblarSelectCategorias(document.getElementById("rc-categoria"), a.sexo, a.categoria);
  document.getElementById("rc-fecha").value = new Date().toISOString().slice(0, 10);
  document.getElementById("rc-nota").value = "";
  modalAnimal.hidden = true;
  modalRecategorizar.hidden = false;
});

document.getElementById("btn-cancelar-recategorizar").addEventListener("click", () => {
  modalRecategorizar.hidden = true;
  modalAnimal.hidden = false;
});

formRecategorizar.addEventListener("submit", (e) => {
  e.preventDefault();
  const a = state.animals.find((x) => x.id === animalEnEdicion);
  if (!a) return;
  const categoriaNueva = document.getElementById("rc-categoria").value;
  const categoriaAnterior = a.categoria;

  if (categoriaNueva === categoriaAnterior) {
    mostrarToast("Elegí una categoría distinta a la actual");
    return;
  }

  setDoc(doc(referenciaAnimales(), a.id), { categoria: categoriaNueva }, { merge: true }).catch(console.error);
  setDoc(doc(referenciaMovimientosAnimales(), generarId()), {
    animalId: a.id,
    tipo: "recategorizacion",
    categoriaAnterior,
    categoriaNueva,
    fecha: document.getElementById("rc-fecha").value,
    nota: document.getElementById("rc-nota").value.trim() || null,
  }).catch(console.error);

  modalRecategorizar.hidden = true;
  cerrarModalAnimal();
  mostrarToast(`Recategorizado a ${categoriaNueva}`);
});

/* =====================================================================
   8.7) MODAL: registrar egreso de animal (venta / muerte / baja)
   ===================================================================== */

const modalEgresoAnimal = document.getElementById("modal-egreso-animal");
const formEgresoAnimal = document.getElementById("form-egreso-animal");

document.getElementById("btn-egreso-animal").addEventListener("click", () => {
  if (!animalEnEdicion) return;
  const a = state.animals.find((x) => x.id === animalEnEdicion);
  if (!a) return;
  document.getElementById("egreso-animal-subtitulo").textContent = `Caravana ${a.caravana} — se va a marcar como inactivo`;
  document.getElementById("eg-motivo").value = "Venta";
  document.getElementById("eg-fecha").value = new Date().toISOString().slice(0, 10);
  document.getElementById("eg-guia").value = "";
  document.getElementById("eg-nota").value = "";
  modalAnimal.hidden = true;
  modalEgresoAnimal.hidden = false;
});

document.getElementById("btn-cancelar-egreso-animal").addEventListener("click", () => {
  modalEgresoAnimal.hidden = true;
  modalAnimal.hidden = false;
});

formEgresoAnimal.addEventListener("submit", (e) => {
  e.preventDefault();
  const a = state.animals.find((x) => x.id === animalEnEdicion);
  if (!a) return;
  const motivo = document.getElementById("eg-motivo").value;

  setDoc(doc(referenciaAnimales(), a.id), { estado: motivo }, { merge: true }).catch(console.error);
  setDoc(doc(referenciaMovimientosAnimales(), generarId()), {
    animalId: a.id,
    tipo: "egreso",
    motivo,
    fecha: document.getElementById("eg-fecha").value,
    guiaSenacsa: document.getElementById("eg-guia").value.trim() || null,
    nota: document.getElementById("eg-nota").value.trim() || null,
  }).catch(console.error);

  modalEgresoAnimal.hidden = true;
  cerrarModalAnimal();
  mostrarToast(`Egreso registrado: ${motivo}`);
});

/* =====================================================================
   8.8) MODAL: registrar pesaje
   ===================================================================== */

const modalPesaje = document.getElementById("modal-pesaje");
const formPesaje = document.getElementById("form-pesaje");

document.getElementById("btn-agregar-pesaje").addEventListener("click", () => {
  if (!animalEnEdicion) return;
  const a = state.animals.find((x) => x.id === animalEnEdicion);
  if (!a) return;
  document.getElementById("pesaje-subtitulo").textContent = `Caravana ${a.caravana}`;
  formPesaje.reset();
  document.getElementById("ps-fecha").value = new Date().toISOString().slice(0, 10);
  modalAnimal.hidden = true;
  modalPesaje.hidden = false;
  setTimeout(() => document.getElementById("ps-peso").focus(), 50);
});

document.getElementById("btn-cancelar-pesaje").addEventListener("click", () => {
  modalPesaje.hidden = true;
  modalAnimal.hidden = false;
});

formPesaje.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!animalEnEdicion) return;
  const peso = Number(document.getElementById("ps-peso").value);
  if (!peso || peso <= 0) return;

  setDoc(doc(referenciaPesajes(), generarId()), {
    animalId: animalEnEdicion,
    peso,
    fecha: document.getElementById("ps-fecha").value,
    nota: document.getElementById("ps-nota").value.trim() || null,
  }).catch((err) => { console.error(err); mostrarToast("No se pudo guardar (revisá tu conexión)"); });

  modalPesaje.hidden = true;
  modalAnimal.hidden = false;
  renderizarPesajesDelAnimal(animalEnEdicion);
  mostrarToast("Pesaje registrado");
});

/* =====================================================================
   9) MODAL: registrar movimiento (entrada / salida)
   ===================================================================== */

const modalMov = document.getElementById("modal-mov");
const formMov = document.getElementById("form-mov");
let movEnCurso = null; // { productId, tipo }

function abrirModalMovimiento(productId, tipo) {
  const p = state.products.find((x) => x.id === productId);
  if (!p) return;
  movEnCurso = { productId, tipo };
  document.getElementById("modal-mov-titulo").textContent = tipo === "entrada" ? "Registrar entrada" : "Registrar salida";
  document.getElementById("modal-mov-producto").textContent = `${p.name} — stock actual: ${p.quantity} ${p.unit}`;
  document.getElementById("btn-confirmar-mov").textContent = tipo === "entrada" ? "Sumar al stock" : "Descontar del stock";
  formMov.reset();
  document.getElementById("mv-cantidad").value = 1;
  modalMov.hidden = false;
  setTimeout(() => document.getElementById("mv-cantidad").focus(), 50);
}

function cerrarModalMovimiento() {
  modalMov.hidden = true;
  movEnCurso = null;
}

document.getElementById("btn-cancelar-mov").addEventListener("click", cerrarModalMovimiento);

formMov.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!movEnCurso) return;
  const cantidad = Number(document.getElementById("mv-cantidad").value);
  if (!cantidad || cantidad <= 0) return;

  const p = state.products.find((x) => x.id === movEnCurso.productId);
  if (!p) return;

  if (movEnCurso.tipo === "salida" && cantidad > p.quantity) {
    if (!confirm(`Solo quedan ${p.quantity} ${p.unit}. ¿Registrar igual y dejar el stock en 0?`)) return;
  }

  if (cantidad >= 100000) {
    if (!confirm(`Cargaste ${cantidad} ${p.unit}. ¿Es correcto? (revisá que no sobre un cero)`)) return;
  }

  const nuevaCantidad = movEnCurso.tipo === "entrada"
    ? round2(p.quantity + cantidad)
    : round2(Math.max(0, p.quantity - cantidad));

  setDoc(doc(referenciaProductos(), p.id), { quantity: nuevaCantidad }, { merge: true })
    .catch((err) => { console.error(err); mostrarToast("No se pudo guardar (revisá tu conexión)"); });

  setDoc(doc(referenciaMovimientos(), generarId()), {
    productId: p.id,
    type: movEnCurso.tipo,
    quantity: cantidad,
    date: new Date().toISOString(),
    note: document.getElementById("mv-nota").value.trim() || null,
  }).catch((err) => { console.error(err); mostrarToast("No se pudo guardar (revisá tu conexión)"); });

  cerrarModalMovimiento();
  mostrarToast(movEnCurso.tipo === "entrada" ? "Entrada registrada" : "Salida registrada");
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

function redondearConsumo(n) {
  // Muestra hasta 2 decimales, sin ceros de más (ej: 1.5, no 1.50)
  return round2(n).toString();
}

/* =====================================================================
   10) COPIA DE SEGURIDAD (exportar / importar JSON)
   ===================================================================== */

const modalBackup = document.getElementById("modal-backup");
document.getElementById("btn-backup").addEventListener("click", () => { modalBackup.hidden = false; });
document.getElementById("btn-cerrar-backup").addEventListener("click", () => { modalBackup.hidden = true; });

document.getElementById("btn-exportar").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const fecha = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `libreta-stock-${fecha}.json`;
  a.click();
  URL.revokeObjectURL(url);
  mostrarToast("Copia descargada");
});

document.getElementById("input-importar").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      // Todas las colecciones son opcionales dentro del archivo: una copia
      // vieja (de antes de que existiera Ganado) solo va a tener products/
      // movements, y eso también tiene que poder restaurarse sin error.
      const colecciones = [
        { datos: data.products, ref: referenciaProductos },
        { datos: data.movements, ref: referenciaMovimientos },
        { datos: data.animals, ref: referenciaAnimales },
        { datos: data.animalMovements, ref: referenciaMovimientosAnimales },
        { datos: data.weighings, ref: referenciaPesajes },
      ];
      const hayAlgunaColeccionValida = colecciones.some((c) => Array.isArray(c.datos));
      if (!hayAlgunaColeccionValida) throw new Error("Formato inválido");

      if (!confirm("Esto va a agregar los datos de la copia (productos, movimientos, animales y pesajes) a los datos actuales de esta finca. ¿Continuar?")) return;

      colecciones.forEach(({ datos, ref }) => {
        if (!Array.isArray(datos)) return;
        datos.forEach((item) => {
          const { id, ...campos } = item;
          setDoc(doc(ref(), id || generarId()), campos).catch(console.error);
        });
      });

      modalBackup.hidden = true;
      mostrarToast("Datos restaurados");
    } catch (err) {
      alert("No se pudo leer el archivo. Verificá que sea una copia válida de esta app.");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

/* =====================================================================
   11) INSTALAR COMO APP (PWA) Y SERVICE WORKER
   ===================================================================== */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("No se pudo registrar el service worker:", err);
    });
  });
}

/* =====================================================================
   INICIO
   Arranca en la pantalla principal (landing). Pintamos una vez con lo que
   haya (vacío si es la primera vez); en cuanto Firestore responda, el
   listener de la sección 1.2 vuelve a redibujar.
   ===================================================================== */

irALanding();
renderizarTodo();
