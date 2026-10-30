import { describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { leerSesion } from "./sesion";
import { iniciarSesionDePrueba, mockFetch, mockLocation, respuestaJson, ultimaLlamada } from "@/test/utils";

const BASE = "http://api.test";

describe("API_BASE_URL", () => {
  it("toma NEXT_PUBLIC_API_URL", () => {
    expect(api.API_BASE_URL).toBe(BASE);
  });

  it("usa localhost:8000 si la variable no existe", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", undefined as unknown as string);
    vi.resetModules();
    const fresco = await import("./api");
    expect(fresco.API_BASE_URL).toBe("http://localhost:8000");
  });
});

describe("encabezado Authorization", () => {
  it("adjunta el Bearer cuando hay sesion vigente", async () => {
    iniciarSesionDePrueba();
    const fetchMock = mockFetch(respuestaJson([]));
    await api.fetchSedes();
    expect(ultimaLlamada(fetchMock).headers.get("Authorization")).toBe("Bearer tok-123");
  });

  it("no lo adjunta sin sesion", async () => {
    const fetchMock = mockFetch(respuestaJson([]));
    await api.fetchSedes();
    expect(ultimaLlamada(fetchMock).headers.has("Authorization")).toBe(false);
  });

  it("no lo adjunta si la sesion guardada ya vencio", async () => {
    iniciarSesionDePrueba({ expira_at: new Date(Date.now() - 1000).toISOString() });
    const fetchMock = mockFetch(respuestaJson([]));
    await api.fetchSedes();
    expect(ultimaLlamada(fetchMock).headers.has("Authorization")).toBe(false);
  });

  it("no manda X-Admin-Token: el dashboard ya no usa el token legacy", async () => {
    localStorage.setItem("admin_token", "legacy");
    iniciarSesionDePrueba();
    const fetchMock = mockFetch(respuestaJson({ ok: true }));
    await api.eliminarEntrega("e1");
    expect(ultimaLlamada(fetchMock).headers.has("X-Admin-Token")).toBe(false);
  });
});

describe("401 estando logueado", () => {
  it("borra la sesion y redirige a /login?expirada=1", async () => {
    iniciarSesionDePrueba();
    const assign = mockLocation("/entregas");
    mockFetch(respuestaJson({ detail: "Sesion invalida" }, 401));
    await expect(api.fetchEntregas()).rejects.toThrow("respondio 401");
    expect(leerSesion()).toBeNull();
    expect(assign).toHaveBeenCalledWith("/login?expirada=1");
  });

  it("no redirige si ya esta en /login", async () => {
    iniciarSesionDePrueba();
    const assign = mockLocation("/login");
    mockFetch(respuestaJson({}, 401));
    await expect(api.fetchSedes()).rejects.toThrow();
    expect(leerSesion()).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it("sin sesion un 401 no redirige", async () => {
    const assign = mockLocation("/entregas");
    mockFetch(respuestaJson({}, 401));
    await expect(api.fetchSedes()).rejects.toThrow();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("lecturas (getJson)", () => {
  it("fetchEntregas sin opciones pide limit=150 y no usa cache", async () => {
    const fetchMock = mockFetch(respuestaJson([{ id: "1" }]));
    const datos = await api.fetchEntregas();
    const { url, init } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}/entregas?limit=150`);
    expect(init.cache).toBe("no-store");
    expect(datos).toEqual([{ id: "1" }]);
  });

  it("fetchEntregas codifica todos los filtros", async () => {
    const fetchMock = mockFetch(respuestaJson([]));
    await api.fetchEntregas({ sedeId: "s 1", desde: "2026-01-01T00:00:00Z", hasta: "2026-01-02", busqueda: "FEI 10&", limit: 20 });
    const url = new URL(ultimaLlamada(fetchMock).url);
    expect(url.pathname).toBe("/entregas");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sede_id: "s 1",
      desde: "2026-01-01T00:00:00Z",
      hasta: "2026-01-02",
      busqueda: "FEI 10&",
      limit: "20",
    });
  });

  it("omite los filtros vacios", async () => {
    const fetchMock = mockFetch(respuestaJson([]));
    await api.fetchEntregas({ sedeId: "", busqueda: "" });
    expect(ultimaLlamada(fetchMock).url).toBe(`${BASE}/entregas?limit=150`);
  });

  const casos: [string, () => Promise<unknown>, string][] = [
    ["fetchLogs", () => api.fetchLogs(), "/logs?limit=150"],
    ["fetchHistorialEntrega", () => api.fetchHistorialEntrega("a/b c"), "/logs?entidad_id=a%2Fb%20c&limit=200"],
    ["fetchSedes", () => api.fetchSedes(), "/sedes"],
    ["fetchEmpleados", () => api.fetchEmpleados("s&1"), "/empleados?sede_id=s%261"],
    ["fetchProductos sin busqueda", () => api.fetchProductos(), "/productos"],
    ["fetchProductos con busqueda", () => api.fetchProductos("arroz 1kg"), "/productos?buscar=arroz%201kg"],
    ["fetchTrasladoDetalle", () => api.fetchTrasladoDetalle("t1"), "/traslados-puntos/t1"],
    ["fetchHistorialTraslado", () => api.fetchHistorialTraslado("t1"), "/traslados-puntos/t1/historial"],
    ["fetchActividadTraslados", () => api.fetchActividadTraslados(), "/traslados-puntos/actividad?limite=50"],
    ["fetchActividadTraslados con limite", () => api.fetchActividadTraslados(10), "/traslados-puntos/actividad?limite=10"],
    ["fetchResumenTalonarios", () => api.fetchResumenTalonarios(), "/talonarios-puntos/resumen"],
    ["fetchPuntosPublicos", () => api.fetchPuntosPublicos(), "/puntos"],
    ["fetchCargaTurnos", () => api.fetchCargaTurnos("s1", 4), "/turnos/carga?sede_id=s1&semanas=4"],
    ["fetchYo", () => api.fetchYo(), "/dashboard/auth/yo"],
  ];
  it.each(casos)("%s usa la URL correcta", async (_n, llamar, ruta) => {
    const fetchMock = mockFetch(respuestaJson([]));
    await llamar();
    const { url, init } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}${ruta}`);
    expect(init.method).toBeUndefined();
  });

  it("listarTrasladosSyscafe sin filtros no agrega query", async () => {
    const fetchMock = mockFetch(respuestaJson([]));
    await api.listarTrasladosSyscafe();
    expect(ultimaLlamada(fetchMock).url).toBe(`${BASE}/traslados-puntos/syscafe`);
  });

  it("listarTrasladosSyscafe mapea los filtros", async () => {
    const fetchMock = mockFetch(respuestaJson([]));
    await api.listarTrasladosSyscafe({ puntoId: "p1", pendientes: true, desde: "2026-10-01", hasta: "2026-10-31" });
    const url = new URL(ultimaLlamada(fetchMock).url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      punto_id: "p1",
      pendientes: "true",
      desde: "2026-10-01",
      hasta: "2026-10-31",
    });
  });

  it("fetchRankingProductos arma la query y omite lo opcional", async () => {
    const fetchMock = mockFetch(respuestaJson({}));
    await api.fetchRankingProductos({ desde: "2026-10-01", hasta: "2026-10-31" });
    expect(ultimaLlamada(fetchMock).url).toBe(`${BASE}/ranking/productos?desde=2026-10-01&hasta=2026-10-31`);
    await api.fetchRankingProductos({ desde: "a", hasta: "b", sedeId: "s1", limit: 5 });
    const url = new URL(ultimaLlamada(fetchMock).url);
    expect(url.searchParams.get("sede_id")).toBe("s1");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("lanza un error con la ruta y el estado si no es 2xx", async () => {
    mockFetch(respuestaJson({}, 500));
    await expect(api.fetchSedes()).rejects.toThrow("/sedes respondio 500");
  });

  it("propaga el error de red", async () => {
    mockFetch(new TypeError("Failed to fetch"));
    await expect(api.fetchSedes()).rejects.toThrow("Failed to fetch");
  });

  it("falla si el cuerpo 200 no es JSON valido", async () => {
    mockFetch(new Response("<html>", { status: 200 }));
    await expect(api.fetchSedes()).rejects.toThrow();
  });
});

describe("login por PIN y FAIA (fetch plano)", () => {
  it("loginConPin envia pin y empleado_id sin Authorization", async () => {
    iniciarSesionDePrueba();
    const fetchMock = mockFetch(respuestaJson({ id: "e1", nombre: "Luis", sede_id: "s1", rol: "operador" }));
    const emp = await api.loginConPin("1234", "e1");
    const { url, init, headers } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}/auth/pin`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ pin: "1234", empleado_id: "e1" });
    expect(headers.has("Authorization")).toBe(false);
    expect(emp.nombre).toBe("Luis");
  });

  it("loginConPin usa el detail del backend en un 401", async () => {
    const assign = mockLocation();
    iniciarSesionDePrueba();
    mockFetch(respuestaJson({ detail: "PIN incorrecto" }, 401));
    await expect(api.loginConPin("0000", "e1")).rejects.toThrow("PIN incorrecto");
    // Un PIN malo no es una sesion expirada.
    expect(assign).not.toHaveBeenCalled();
    expect(leerSesion()).not.toBeNull();
  });

  it("loginConPin tiene mensaje de respaldo si el error no trae JSON", async () => {
    mockFetch(new Response("boom", { status: 502 }));
    await expect(api.loginConPin("1234", "e1")).rejects.toThrow("No se pudo iniciar sesión (502)");
  });

  it("fetchEntregasFaia codifica el empleado y usa no-store", async () => {
    const fetchMock = mockFetch(respuestaJson([]));
    await api.fetchEntregasFaia("e 1");
    const { url, init } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}/entregas/faia?empleado_id=e%201`);
    expect(init.cache).toBe("no-store");
  });

  it("fetchEntregasFaia propaga el detail de un 403", async () => {
    mockFetch(respuestaJson({ detail: "Sin permiso" }, 403));
    await expect(api.fetchEntregasFaia("e1")).rejects.toThrow("Sin permiso");
  });

  it("fetchEntregasFaia usa el respaldo si no hay detail", async () => {
    mockFetch(respuestaJson({}, 500));
    await expect(api.fetchEntregasFaia("e1")).rejects.toThrow("No se pudieron cargar los documentos FAIA (500)");
  });
});

describe("escrituras de entregas", () => {
  it("revisarEntrega hace PATCH JSON a /revisar", async () => {
    const fetchMock = mockFetch(respuestaJson({ id: "e1" }));
    await api.revisarEntrega("e1", { tipo: "FEI", indicativo_numero: "10254", aprobar: false });
    const { url, init, headers } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}/entregas/e1/revisar`);
    expect(init.method).toBe("PATCH");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ tipo: "FEI", indicativo_numero: "10254", aprobar: false });
  });

  it("revisarEntrega resume el detail 422 (lista) del backend", async () => {
    mockFetch(respuestaJson({ detail: [{ msg: "campo requerido" }, { msg: "formato invalido" }, {}] }, 422));
    await expect(api.revisarEntrega("e1", {})).rejects.toThrow("campo requerido; formato invalido");
  });

  it("revisarEntrega usa detail de texto (409)", async () => {
    mockFetch(respuestaJson({ detail: "Ya existe" }, 409));
    await expect(api.revisarEntrega("e1", {})).rejects.toThrow("Ya existe");
  });

  it("revisarEntrega usa el respaldo con el estado si no hay JSON", async () => {
    mockFetch(new Response("", { status: 500 }));
    await expect(api.revisarEntrega("e1", {})).rejects.toThrow("No se pudo guardar la entrega (500)");
  });

  it("actualizarItems envia items, operador de la sesion y sede dashboard", async () => {
    iniciarSesionDePrueba();
    const fetchMock = mockFetch(respuestaJson({ id: "e1", items: [] }));
    const items = [{ id: "i1", descripcion: "Arroz", cantidad_entregada: 2, cantidad_pendiente: 1 }];
    await api.actualizarItems("e1", items, "");
    const { url, init } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}/entregas/e1/items`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      items,
      operador_id: "ana",
      sede_id: "dashboard",
      nota_general: "",
    });
  });

  it("actualizarItems sin sesion usa 'supervisor' y omite nota_general si es undefined", async () => {
    const fetchMock = mockFetch(respuestaJson({ id: "e1", items: [] }));
    await api.actualizarItems("e1", []);
    const cuerpo = JSON.parse(ultimaLlamada(fetchMock).init.body as string);
    expect(cuerpo.operador_id).toBe("supervisor");
    expect("nota_general" in cuerpo).toBe(false);
  });

  it("actualizarItems lanza el mensaje del backend", async () => {
    mockFetch(respuestaJson({ detail: "Cantidad negativa" }, 422));
    await expect(api.actualizarItems("e1", [])).rejects.toThrow("Cantidad negativa");
  });

  it("eliminarEntrega usa DELETE /definitivo", async () => {
    const fetchMock = mockFetch(new Response(null, { status: 204 }));
    await api.eliminarEntrega("e1");
    const { url, init } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}/entregas/e1/definitivo`);
    expect(init.method).toBe("DELETE");
  });

  it("eliminarEntrega falla con 403 de no-admin", async () => {
    mockFetch(respuestaJson({ detail: "Solo administradores" }, 403));
    await expect(api.eliminarEntrega("e1")).rejects.toThrow("Solo administradores");
  });

  it("cancelarEntrega manda operador y sede en la query", async () => {
    iniciarSesionDePrueba();
    const fetchMock = mockFetch(respuestaJson({ cancelado: true }));
    await expect(api.cancelarEntrega("e1")).resolves.toEqual({ cancelado: true });
    const { url, init } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}/entregas/e1?operador_id=ana&sede_id=dashboard`);
    expect(init.method).toBe("DELETE");
  });

  it("eliminarTodasLasEntregas usa DELETE /todas", async () => {
    const fetchMock = mockFetch(respuestaJson({ entregas_borradas: 3, logs_borrados: 9 }));
    await expect(api.eliminarTodasLasEntregas()).resolves.toEqual({ entregas_borradas: 3, logs_borrados: 9 });
    expect(ultimaLlamada(fetchMock).url).toBe(`${BASE}/entregas/todas`);
    expect(ultimaLlamada(fetchMock).init.method).toBe("DELETE");
  });

  it("eliminarTodasLasEntregas propaga el error", async () => {
    mockFetch(respuestaJson({ detail: "No autorizado" }, 403));
    await expect(api.eliminarTodasLasEntregas()).rejects.toThrow("No autorizado");
  });
});

describe("descargarExport", () => {
  function espiarDescarga() {
    const creada = vi.fn(() => "blob:fake");
    const revocada = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: creada, revokeObjectURL: revocada }));
    const clic = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    return { creada, revocada, clic };
  }

  it.each([
    ["csv", "entregas.csv"],
    ["xlsx", "reporte_mensual.xlsx"],
  ] as const)("descarga %s con sesion y nombre fijo", async (formato, nombre) => {
    iniciarSesionDePrueba();
    const { creada, revocada, clic } = espiarDescarga();
    let nombreEnlace = "";
    clic.mockImplementation(function (this: HTMLAnchorElement) {
      nombreEnlace = this.download;
    });
    const fetchMock = mockFetch(new Response("datos", { status: 200 }));
    await api.descargarExport(formato);
    const { url, headers } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}/entregas/export.${formato}`);
    expect(headers.get("Authorization")).toBe("Bearer tok-123");
    expect(creada).toHaveBeenCalledOnce();
    expect(nombreEnlace).toBe(nombre);
    expect(revocada).toHaveBeenCalledWith("blob:fake");
    // El enlace temporal no queda en el DOM.
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("no crea ningun enlace si el backend responde con error", async () => {
    const { creada, clic } = espiarDescarga();
    mockFetch(respuestaJson({ detail: "Sin sesion" }, 401));
    await expect(api.descargarExport("csv")).rejects.toThrow("Sin sesion");
    expect(creada).not.toHaveBeenCalled();
    expect(clic).not.toHaveBeenCalled();
  });
});

describe("productos y traslados", () => {
  it("crearProducto hace POST con el cuerpo", async () => {
    const fetchMock = mockFetch(respuestaJson({ id: "p1" }));
    await api.crearProducto({ codigo: "A1", nombre: "Arroz" });
    const { url, init } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}/productos`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ codigo: "A1", nombre: "Arroz" });
  });

  it("crearProducto propaga un 409 de codigo duplicado", async () => {
    mockFetch(respuestaJson({ detail: "Codigo duplicado" }, 409));
    await expect(api.crearProducto({ codigo: "A1", nombre: "Arroz" })).rejects.toThrow("Codigo duplicado");
  });

  it("actualizarProducto hace PATCH", async () => {
    const fetchMock = mockFetch(respuestaJson({ id: "p1" }));
    await api.actualizarProducto("p1", { nombre: "Arroz 2" });
    expect(ultimaLlamada(fetchMock).url).toBe(`${BASE}/productos/p1`);
    expect(ultimaLlamada(fetchMock).init.method).toBe("PATCH");
  });

  it("actualizarProducto lanza con el respaldo", async () => {
    mockFetch(new Response("", { status: 500 }));
    await expect(api.actualizarProducto("p1", {})).rejects.toThrow("No se pudo actualizar el producto (500)");
  });

  it("asignarSyscafeDashboard guarda y borra con null", async () => {
    const fetchMock = mockFetch(new Response(null, { status: 204 }));
    await api.asignarSyscafeDashboard("t1", "TB9-120");
    expect(ultimaLlamada(fetchMock).url).toBe(`${BASE}/traslados-puntos/t1/syscafe/dashboard`);
    expect(JSON.parse(ultimaLlamada(fetchMock).init.body as string)).toEqual({ numero_syscafe: "TB9-120" });
    await api.asignarSyscafeDashboard("t1", null);
    expect(JSON.parse(ultimaLlamada(fetchMock).init.body as string)).toEqual({ numero_syscafe: null });
  });

  it("asignarSyscafeDashboard muestra el 409 que nombra la otra hoja", async () => {
    mockFetch(respuestaJson({ detail: "Ya lo tiene la hoja A 12" }, 409));
    await expect(api.asignarSyscafeDashboard("t1", "NBR-1")).rejects.toThrow("Ya lo tiene la hoja A 12");
  });
});

describe("administracion (adminFetch)", () => {
  it("GET: sin Content-Type ni body y con no-store", async () => {
    const fetchMock = mockFetch(respuestaJson([]));
    await api.fetchSedesAdmin();
    const { url, init, headers } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}/sedes?incluir_inactivas=true`);
    expect(init.method).toBe("GET");
    expect(init.cache).toBe("no-store");
    expect(init.body).toBeUndefined();
    expect(headers.has("Content-Type")).toBe(false);
  });

  const casos: [string, () => Promise<unknown>, string, string, unknown?][] = [
    ["fetchEmpleadosAdmin", () => api.fetchEmpleadosAdmin(), "GET", "/empleados?incluir_inactivos=true"],
    ["fetchPuntosAdmin", () => api.fetchPuntosAdmin(), "GET", "/puntos?incluir_inactivos=true"],
    ["fetchUsuariosPuntoAdmin", () => api.fetchUsuariosPuntoAdmin("p1"), "GET", "/puntos/p1/usuarios?incluir_inactivos=true"],
    ["fetchSupervisoresAdmin", () => api.fetchSupervisoresAdmin(), "GET", "/supervisores?incluir_inactivos=true"],
    ["fetchTiposDocumentoAdmin", () => api.fetchTiposDocumentoAdmin(), "GET", "/tipos-documento?incluir_inactivos=true"],
    ["fetchUsuariosDashboard", () => api.fetchUsuariosDashboard(), "GET", "/dashboard/usuarios"],
    ["crearSede", () => api.crearSede({ nombre: "N", codigo: "C" }), "POST", "/sedes", { nombre: "N", codigo: "C" }],
    ["actualizarSede", () => api.actualizarSede("s1", { activa: false }), "PATCH", "/sedes/s1", { activa: false }],
    ["eliminarSede", () => api.eliminarSede("s1"), "DELETE", "/sedes/s1"],
    [
      "crearEmpleado",
      () => api.crearEmpleado({ nombre: "L", sede_id: "s1", rol: "operador", pin: "1234" }),
      "POST",
      "/empleados",
      { nombre: "L", sede_id: "s1", rol: "operador", pin: "1234" },
    ],
    ["actualizarEmpleado", () => api.actualizarEmpleado("e1", { estado: "inactivo" }), "PATCH", "/empleados/e1", { estado: "inactivo" }],
    ["eliminarEmpleado", () => api.eliminarEmpleado("e1"), "DELETE", "/empleados/e1"],
    ["resetearPinEmpleado", () => api.resetearPinEmpleado("e1", "4321"), "POST", "/empleados/e1/pin", { pin: "4321" }],
    ["crearPunto", () => api.crearPunto("Punto"), "POST", "/puntos", { nombre: "Punto" }],
    ["actualizarPunto", () => api.actualizarPunto("p1", { activo: false }), "PATCH", "/puntos/p1", { activo: false }],
    ["eliminarPunto", () => api.eliminarPunto("p1"), "DELETE", "/puntos/p1"],
    [
      "crearUsuarioPunto",
      () => api.crearUsuarioPunto("p1", { nombre: "U", pin: "1234" }),
      "POST",
      "/puntos/p1/usuarios",
      { nombre: "U", pin: "1234" },
    ],
    ["actualizarUsuarioPunto", () => api.actualizarUsuarioPunto("u1", { nombre: "X" }), "PATCH", "/puntos/usuarios/u1", { nombre: "X" }],
    ["eliminarUsuarioPunto", () => api.eliminarUsuarioPunto("u1"), "DELETE", "/puntos/usuarios/u1"],
    ["resetearPinUsuarioPunto", () => api.resetearPinUsuarioPunto("u1", "9999"), "POST", "/puntos/usuarios/u1/pin", { pin: "9999" }],
    ["crearSupervisor", () => api.crearSupervisor({ nombre: "S", pin: "1234" }), "POST", "/supervisores", { nombre: "S", pin: "1234" }],
    ["actualizarSupervisor", () => api.actualizarSupervisor("v1", { estado: "activo" }), "PATCH", "/supervisores/v1", { estado: "activo" }],
    ["eliminarSupervisor", () => api.eliminarSupervisor("v1"), "DELETE", "/supervisores/v1"],
    ["resetearPinSupervisor", () => api.resetearPinSupervisor("v1", "1111"), "POST", "/supervisores/v1/pin", { pin: "1111" }],
    ["eliminarProducto", () => api.eliminarProducto("a/b"), "DELETE", "/productos/a%2Fb"],
    ["eliminarTipoDocumento", () => api.eliminarTipoDocumento("TB9"), "DELETE", "/tipos-documento/TB9"],
    [
      "crearTipoDocumento",
      () => api.crearTipoDocumento({ codigo: "TB9", descripcion: "Traslado" }),
      "POST",
      "/tipos-documento",
      { codigo: "TB9", descripcion: "Traslado" },
    ],
    [
      "actualizarTipoDocumento",
      () => api.actualizarTipoDocumento("T B", { activo: false }),
      "PATCH",
      "/tipos-documento/T%20B",
      { activo: false },
    ],
    [
      "crearUsuarioDashboard",
      () => api.crearUsuarioDashboard({ usuario: "ana", nombre: "Ana", rol: "admin", area: "todo", password: "claveSegura1" }),
      "POST",
      "/dashboard/usuarios",
      { usuario: "ana", nombre: "Ana", rol: "admin", area: "todo", password: "claveSegura1" },
    ],
    [
      "actualizarUsuarioDashboard",
      () => api.actualizarUsuarioDashboard("u1", { activo: false }),
      "PATCH",
      "/dashboard/usuarios/u1",
      { activo: false },
    ],
    ["eliminarUsuarioDashboard", () => api.eliminarUsuarioDashboard("u1"), "DELETE", "/dashboard/usuarios/u1"],
    [
      "resetearPasswordUsuarioDashboard",
      () => api.resetearPasswordUsuarioDashboard("u1", "nuevaClave99"),
      "POST",
      "/dashboard/usuarios/u1/password",
      { password: "nuevaClave99" },
    ],
  ];

  it.each(casos)("%s", async (_n, llamar, metodo, ruta, cuerpo) => {
    const fetchMock = mockFetch(respuestaJson({ ok: true }));
    await llamar();
    const { url, init, headers } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}${ruta}`);
    expect(init.method).toBe(metodo);
    if (cuerpo !== undefined) {
      expect(JSON.parse(init.body as string)).toEqual(cuerpo);
      expect(headers.get("Content-Type")).toBe("application/json");
    } else {
      expect(init.body).toBeUndefined();
    }
  });

  it("lanza ErrorAdmin con el codigo HTTP (409 con historial)", async () => {
    mockFetch(respuestaJson({ detail: "Tiene historial" }, 409));
    const error = await api.eliminarSede("s1").catch((e) => e);
    expect(error).toBeInstanceOf(api.ErrorAdmin);
    expect(error.status).toBe(409);
    expect(error.message).toBe("Tiene historial");
  });

  it("ErrorAdmin usa el respaldo si el cuerpo no es JSON", async () => {
    mockFetch(new Response("error", { status: 500 }));
    const error = await api.fetchSedesAdmin().catch((e) => e);
    expect(error).toBeInstanceOf(api.ErrorAdmin);
    expect(error.message).toBe("La solicitud falló (500)");
  });

  it("un 401 con sesion expira la sesion tambien en administracion", async () => {
    iniciarSesionDePrueba();
    const assign = mockLocation("/creador");
    mockFetch(respuestaJson({ detail: "Token vencido" }, 401));
    await expect(api.fetchSedesAdmin()).rejects.toBeInstanceOf(api.ErrorAdmin);
    expect(leerSesion()).toBeNull();
    expect(assign).toHaveBeenCalledWith("/login?expirada=1");
  });

  it("el PIN solo viaja en el cuerpo, nunca en la URL", async () => {
    const fetchMock = mockFetch(respuestaJson({ ok: true }));
    await api.resetearPinEmpleado("e1", "4321");
    expect(ultimaLlamada(fetchMock).url).not.toContain("4321");
  });

  it("el error de red de un borrado se propaga", async () => {
    mockFetch(new TypeError("Failed to fetch"));
    await expect(api.eliminarEmpleado("e1")).rejects.toThrow("Failed to fetch");
  });
});

describe("sesion del dashboard", () => {
  it("loginDashboard hace POST sin Authorization y devuelve la sesion", async () => {
    iniciarSesionDePrueba();
    const sesion = { token: "t", usuario: { id: "1", usuario: "ana", nombre: "Ana", rol: "admin" }, expira_at: "2030-01-01T00:00:00Z" };
    const fetchMock = mockFetch(respuestaJson(sesion));
    await expect(api.loginDashboard("ana", "secreta")).resolves.toEqual(sesion);
    const { url, init, headers } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}/dashboard/auth/login`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ usuario: "ana", password: "secreta" });
    expect(headers.has("Authorization")).toBe(false);
  });

  it("loginDashboard con credenciales malas (401) no expira ninguna sesion", async () => {
    const assign = mockLocation("/login");
    iniciarSesionDePrueba();
    mockFetch(respuestaJson({ detail: "Usuario o contraseña incorrectos" }, 401));
    await expect(api.loginDashboard("ana", "mala")).rejects.toThrow("Usuario o contraseña incorrectos");
    expect(assign).not.toHaveBeenCalled();
    expect(leerSesion()).not.toBeNull();
  });

  it("loginDashboard muestra el bloqueo 423", async () => {
    mockFetch(respuestaJson({ detail: "Demasiados intentos" }, 423));
    await expect(api.loginDashboard("ana", "x")).rejects.toThrow("Demasiados intentos");
  });

  it("loginDashboard usa el respaldo con el estado", async () => {
    mockFetch(new Response("", { status: 503 }));
    await expect(api.loginDashboard("ana", "x")).rejects.toThrow("No se pudo iniciar sesión (503)");
  });

  it("loginDashboard propaga el error de red", async () => {
    mockFetch(new TypeError("Failed to fetch"));
    await expect(api.loginDashboard("ana", "x")).rejects.toThrow("Failed to fetch");
  });

  it("cambiarPassword envia actual y nueva con Bearer", async () => {
    iniciarSesionDePrueba();
    const fetchMock = mockFetch(new Response(null, { status: 204 }));
    await api.cambiarPassword("vieja", "nueva12345");
    const { url, init, headers } = ultimaLlamada(fetchMock);
    expect(url).toBe(`${BASE}/dashboard/auth/cambiar-password`);
    expect(JSON.parse(init.body as string)).toEqual({ actual: "vieja", nueva: "nueva12345" });
    expect(headers.get("Authorization")).toBe("Bearer tok-123");
  });

  it("cambiarPassword lanza el mensaje del backend", async () => {
    mockFetch(respuestaJson({ detail: "La contraseña actual no coincide" }, 400));
    await expect(api.cambiarPassword("x", "y")).rejects.toThrow("La contraseña actual no coincide");
  });
});
