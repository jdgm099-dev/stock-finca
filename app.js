/*
 * Libreta de Stock
 * -----------------
 * App de control de víveres/insumos para una finca, pensada para funcionar
 * sin conexión a internet y guardar todo en el propio celular.
 *
 * No usa ningún framework a propósito: es JavaScript "vanilla" (puro) para
 * que sea fácil de leer, explicar y mantener sin depender de librerías
 * externas. Toda la app vive en 3 archivos: index.html, style.css y app.js.
 *
 * PERSISTENCIA DE DATOS
 * ----------------------
 * Los datos se guardan en localStorage, que es una base de datos simple
 * que el navegador guarda en el propio dispositivo (no en internet).
 * Por eso la app funciona sin conexión y los datos son privados de ese
 * celular. La contrapartida (importante para la tesis, sección de
 * limitaciones): si se cambia de celular o se borra el navegador, se
 * pierden los datos si no se hizo una copia de seguridad antes. Por eso
 * existe la función de exportar/importar copia de seguridad (.json).
 */

const STORAGE_KEY = "libretaStock:v1";
const DIAS_ALERTA_VENCIMIENTO = 7; // avisar si vence dentro de esta cantidad de días

const CATEGORIAS = ["Alimentos", "Limpieza", "Insumos", "Otros"];

/* =====================================================================
   1) CAPA DE DATOS
   Un solo objeto en memoria (`state`) que se sincroniza con localStorage
   cada vez que cambia. products = lista de productos.
   movements = historial de entradas/salidas (para el registro y reportes).
   ===================================================================== */

function cargarEstado() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { products: [], movements: [] };
    const data = JSON.parse(raw);
    return {
      products: Array.isArray(data.products) ? data.products : [],
      movements: Array.isArray(data.movements) ? data.movements : [],
    };
  } catch (e) {
    console.error("No se pudo leer el almacenamiento local:", e);
    return { products: [], movements: [] };
  }
}

function guardarEstado() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("No se pudo guardar:", e);
    mostrarToast("No se pudo guardar. Revisá el espacio del celular.");
  }
}

let state = cargarEstado();

function generarId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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

function mostrarToast(mensaje) {
  const toast = document.getElementById("toast");
  toast.textContent = mensaje;
  toast.hidden = false;
  clearTimeout(mostrarToast._t);
  mostrarToast._t = setTimeout(() => { toast.hidden = true; }, 2400);
}

/* =====================================================================
   3) NAVEGACIÓN ENTRE VISTAS (Inicio / Inventario / Movimientos)
   ===================================================================== */

const vistas = ["inicio", "inventario", "movimientos"];

function irAVista(nombre) {
  vistas.forEach((v) => {
    document.getElementById(`view-${v}`).hidden = v !== nombre;
  });
  document.querySelectorAll(".tabs .tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === nombre);
  });
  renderizarTodo();
}

document.querySelectorAll(".tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => irAVista(btn.dataset.view));
});

/* =====================================================================
   4) RENDER: INICIO (alertas + resumen + últimos movimientos)
   ===================================================================== */

function renderizarInicio() {
  const bajos = state.products.filter(estaStockBajo);
  const porVencer = state.products.filter(estaPorVencer);

  const alertasBox = document.getElementById("alertas-box");
  const alertasList = document.getElementById("alertas-list");
  alertasList.innerHTML = "";

  const alertas = [
    ...bajos.map((p) => ({ p, texto: `Quedan ${p.quantity} ${p.unit}` })),
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
  row.className = "item-row" + (estaStockBajo(p) ? " low" : "");

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
   7) RENDER GENERAL
   ===================================================================== */

function renderizarTodo() {
  renderizarInicio();
  renderizarInventario();
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

document.getElementById("btn-agregar").addEventListener("click", abrirModalNuevoProducto);
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

  if (productoEnEdicion) {
    const p = state.products.find((x) => x.id === productoEnEdicion);
    Object.assign(p, datos);
    mostrarToast("Producto actualizado");
  } else {
    state.products.push({ id: generarId(), createdAt: new Date().toISOString(), ...datos });
    mostrarToast("Producto agregado");
  }

  guardarEstado();
  cerrarModalProducto();
  renderizarTodo();
});

document.getElementById("btn-eliminar-producto").addEventListener("click", () => {
  if (!productoEnEdicion) return;
  if (!confirm("¿Eliminar este producto? También se borrará su historial de movimientos.")) return;
  state.products = state.products.filter((p) => p.id !== productoEnEdicion);
  state.movements = state.movements.filter((m) => m.productId !== productoEnEdicion);
  guardarEstado();
  cerrarModalProducto();
  renderizarTodo();
  mostrarToast("Producto eliminado");
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

  p.quantity = movEnCurso.tipo === "entrada"
    ? round2(p.quantity + cantidad)
    : round2(Math.max(0, p.quantity - cantidad));

  state.movements.push({
    id: generarId(),
    productId: p.id,
    type: movEnCurso.tipo,
    quantity: cantidad,
    date: new Date().toISOString(),
    note: document.getElementById("mv-nota").value.trim() || null,
  });

  guardarEstado();
  cerrarModalMovimiento();
  renderizarTodo();
  mostrarToast(movEnCurso.tipo === "entrada" ? "Entrada registrada" : "Salida registrada");
});

function round2(n) {
  return Math.round(n * 100) / 100;
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
      if (!Array.isArray(data.products) || !Array.isArray(data.movements)) {
        throw new Error("Formato inválido");
      }
      if (!confirm("Esto va a reemplazar los datos actuales por los de la copia. ¿Continuar?")) return;
      state = { products: data.products, movements: data.movements };
      guardarEstado();
      renderizarTodo();
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
   ===================================================================== */

renderizarTodo();
