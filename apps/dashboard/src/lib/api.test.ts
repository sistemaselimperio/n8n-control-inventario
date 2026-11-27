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

describe("productos", () => {
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
    ["eliminarProducto", () => api.eliminarProducto("a/b"), "DELETE", "/productos/a%2Fb"],
    ["eliminarTipoDocumento", () => api.eliminarTipoDocumento("TB9"), "DELETE", "/tipos-documento/TB9"],
    ["fetchReceptoresAdmin", () => api.fetchReceptoresAdmin(), "GET", "/receptores-punto?incluir_inactivos=true"],
    [
      "fetchReceptoresAdmin con punto",
      () => api.fetchReceptoresAdmin("p 1"),
      "GET",
      "/receptores-punto?incluir_inactivos=true&punto_id=p+1",
    ],
    [
      "crearReceptor",
      () => api.crearReceptor({ punto_id: "p1", nombre: "Luis", cedula: "1234567" }),
      "POST",
      "/receptores-punto",
      { punto_id: "p1", nombre: "Luis", cedula: "1234567" },
    ],
    [
      "actualizarReceptor",
      () => api.actualizarReceptor("r1", { activo: false, punto_id: "p2" }),
      "PATCH",
      "/receptores-punto/r1",
      { activo: false, punto_id: "p2" },
    ],
    ["eliminarReceptor", () => api.eliminarReceptor("r1"), "DELETE", "/receptores-punto/r1"],
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

describe("traslados", () => {
  const sesion = () => iniciarSesionDePrueba();

  it("fetchTrasladoPuntos pide /traslados/puntos con Bearer", async () => {
    sesion();
    const f = mockFetch(respuestaJson([{ id: "p1", nombre: "N", codigo: "N", es_interna: false }]));
    const r = await api.fetchTrasladoPuntos();
    const { url, headers } = ultimaLlamada(f);
    expect(url).toBe(`${BASE}/traslados/puntos`);
    expect(headers.get("Authorization")).toBe("Bearer tok-123");
    expect(r[0].id).toBe("p1");
  });

  it("subirTraslados envia cada PDF en el campo repetido `archivos` sin Content-Type manual", async () => {
    sesion();
    const f = mockFetch(respuestaJson({ resultados: [] }));
    const a = new File(["a"], "a.pdf", { type: "application/pdf" });
    const b = new File(["b"], "b.pdf", { type: "application/pdf" });
    await api.subirTraslados([a, b]);
    const { url, init, headers } = ultimaLlamada(f);
    expect(url).toBe(`${BASE}/traslados/subir`);
    expect(init.method).toBe("POST");
    expect(headers.has("Content-Type")).toBe(false);
    const cuerpo = init.body as FormData;
    expect(cuerpo.getAll("archivos").map((x) => (x as File).name)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("fetchTraslados arma la query y omite los filtros vacios", async () => {
    sesion();
    const f = mockFetch(respuestaJson({ total: 0, items: [] }));
    await api.fetchTraslados({ estado: "borrador", q: "", punto_id: undefined, limit: 50, offset: 0 });
    expect(ultimaLlamada(f).url).toBe(`${BASE}/traslados?estado=borrador&limit=50&offset=0`);
  });

  it("fetchComprobantes arma la query de filtros", async () => {
    sesion();
    const f = mockFetch(respuestaJson({ total: 0, items: [] }));
    await api.fetchComprobantes({ estado: "devuelto", tipo: "salida", punto_id: "p1", q: "FV 12", limit: 25 });
    const url = new URL(ultimaLlamada(f).url);
    expect(url.pathname).toBe("/traslados/comprobantes");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      estado: "devuelto",
      tipo: "salida",
      punto_id: "p1",
      q: "FV 12",
      limit: "25",
    });
  });

  it("detalles: GET por id", async () => {
    sesion();
    const f = mockFetch(respuestaJson({ id: "c1" }));
    await api.fetchComprobante("c1");
    expect(ultimaLlamada(f).url).toBe(`${BASE}/traslados/comprobantes/c1`);
    await api.fetchTraslado("t1");
    expect(ultimaLlamada(f).url).toBe(`${BASE}/traslados/t1`);
  });

  it("actualizarTraslado hace PATCH JSON y deja pasar null para limpiar", async () => {
    sesion();
    const f = mockFetch(respuestaJson({ id: "t1" }));
    await api.actualizarTraslado("t1", { numero: "FV 9", concepto: null });
    const { url, init, headers } = ultimaLlamada(f);
    expect(url).toBe(`${BASE}/traslados/t1`);
    expect(init.method).toBe("PATCH");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ numero: "FV 9", concepto: null });
  });

  it("enviarTraslado: un 422 trae las advertencias en el error", async () => {
    sesion();
    mockFetch(respuestaJson({ detail: "Faltan datos", advertencias: ["Sin destino", "Sin fecha"] }, 422));
    const err = await api.enviarTraslado("t1").catch((e) => e);
    expect(err).toBeInstanceOf(api.ErrorTraslado);
    expect(err.message).toBe("Faltan datos");
    expect(err.status).toBe(422);
    expect(err.advertencias).toEqual(["Sin destino", "Sin fecha"]);
  });

  it("enviarTraslado hace POST a /enviar", async () => {
    sesion();
    const f = mockFetch(respuestaJson({ id: "t1" }));
    await api.enviarTraslado("t1");
    const { url, init } = ultimaLlamada(f);
    expect(url).toBe(`${BASE}/traslados/t1/enviar`);
    expect(init.method).toBe("POST");
  });

  it("eliminarTraslado hace DELETE y un 409 conserva el codigo", async () => {
    sesion();
    const f = mockFetch(respuestaJson({ ok: true, archivos_borrados: 1 }));
    await api.eliminarTraslado("t1");
    expect(ultimaLlamada(f).init.method).toBe("DELETE");
    mockFetch(respuestaJson({ detail: "Ya confirmado" }, 409));
    const err = await api.eliminarTraslado("t1").catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.advertencias).toEqual([]);
  });

  it("confirmarComprobante manda la firma PNG y la observacion opcional como multipart", async () => {
    sesion();
    const f = mockFetch(respuestaJson({ id: "c1" }));
    await api.confirmarComprobante("c1", new Blob(["png"], { type: "image/png" }), "Todo completo");
    const { url, init } = ultimaLlamada(f);
    expect(url).toBe(`${BASE}/traslados/comprobantes/c1/confirmar`);
    const cuerpo = init.body as FormData;
    expect((cuerpo.get("firma") as File).type).toBe("image/png");
    expect(cuerpo.get("observacion")).toBe("Todo completo");
    await api.confirmarComprobante("c1", new Blob(["png"], { type: "image/png" }));
    expect((ultimaLlamada(f).init.body as FormData).has("observacion")).toBe(false);
  });

  it("confirmarComprobante manda quien recibe: receptor de la lista u otra persona", async () => {
    sesion();
    const f = mockFetch(respuestaJson({ id: "c1" }));
    const png = new Blob(["png"], { type: "image/png" });
    await api.confirmarComprobante("c1", png, undefined, { receptor_id: "r1" });
    let cuerpo = ultimaLlamada(f).init.body as FormData;
    expect(cuerpo.get("receptor_id")).toBe("r1");
    expect(cuerpo.has("receptor_nombre")).toBe(false);
    expect(cuerpo.has("receptor_cedula")).toBe(false);
    await api.confirmarComprobante("c1", png, "ok", { receptor_nombre: "Marta Ríos", receptor_cedula: "52123456" });
    cuerpo = ultimaLlamada(f).init.body as FormData;
    expect(cuerpo.get("receptor_nombre")).toBe("Marta Ríos");
    expect(cuerpo.get("receptor_cedula")).toBe("52123456");
    expect(cuerpo.has("receptor_id")).toBe(false);
  });

  it("devolverComprobante manda quien recibe junto al motivo (solo si se indica)", async () => {
    sesion();
    const f = mockFetch(respuestaJson({ id: "c1" }));
    await api.devolverComprobante("c1", "Cantidad errada", { receptor_id: "r1" });
    expect(JSON.parse(ultimaLlamada(f).init.body as string)).toEqual({ motivo: "Cantidad errada", receptor_id: "r1" });
    await api.devolverComprobante("c1", "x", { receptor_nombre: "Marta", receptor_cedula: "52123456" });
    expect(JSON.parse(ultimaLlamada(f).init.body as string)).toEqual({
      motivo: "x",
      receptor_nombre: "Marta",
      receptor_cedula: "52123456",
    });
  });

  it("fetchReceptoresPunto pide los receptores activos del punto", async () => {
    sesion();
    const f = mockFetch(respuestaJson([{ id: "r1", nombre: "Luis", cedula: "1234567" }]));
    expect(await api.fetchReceptoresPunto("p1")).toEqual([{ id: "r1", nombre: "Luis", cedula: "1234567" }]);
    expect(ultimaLlamada(f).url).toBe(`${BASE}/traslados/puntos/p1/receptores`);
  });

  it("devolverComprobante envia el motivo en JSON", async () => {
    sesion();
    const f = mockFetch(respuestaJson({ id: "c1" }));
    await api.devolverComprobante("c1", "Cantidad errada");
    const { url, init } = ultimaLlamada(f);
    expect(url).toBe(`${BASE}/traslados/comprobantes/c1/devolver`);
    expect(JSON.parse(init.body as string)).toEqual({ motivo: "Cantidad errada" });
  });

  it("reenviarComprobante manda solo los campos dados", async () => {
    sesion();
    const f = mockFetch(respuestaJson({ id: "c1" }));
    await api.reenviarComprobante("c1", { numero: "FV 10", punto_id: "p2" });
    let cuerpo = ultimaLlamada(f).init.body as FormData;
    expect(ultimaLlamada(f).url).toBe(`${BASE}/traslados/comprobantes/c1/reenviar`);
    expect(cuerpo.get("numero")).toBe("FV 10");
    expect(cuerpo.get("punto_id")).toBe("p2");
    expect(cuerpo.has("archivo")).toBe(false);
    await api.reenviarComprobante("c1", { archivo: new File(["x"], "n.pdf", { type: "application/pdf" }) });
    cuerpo = ultimaLlamada(f).init.body as FormData;
    expect((cuerpo.get("archivo") as File).name).toBe("n.pdf");
    expect(cuerpo.has("numero")).toBe(false);
  });

  it("un 401 con sesion expira la sesion tambien en traslados", async () => {
    sesion();
    const assign = mockLocation("/traslados");
    mockFetch(respuestaJson({ detail: "No autorizado" }, 401));
    await api.fetchComprobantes({}).catch(() => {});
    expect(leerSesion()).toBeNull();
    expect(assign).toHaveBeenCalledWith("/login?expirada=1");
  });

  it("sin cuerpo JSON usa el respaldo con el codigo", async () => {
    sesion();
    mockFetch(new Response("boom", { status: 502 }));
    await expect(api.fetchComprobantes({})).rejects.toThrow(/502/);
  });
});

describe("usuarios del dashboard y puntos con traslados", () => {
  it("crearUsuarioDashboard envia punto_id y cedula", async () => {
    iniciarSesionDePrueba();
    const f = mockFetch(respuestaJson({}));
    await api.crearUsuarioDashboard({ usuario: "u", nombre: "N", rol: "supervisor", area: "traslados", password: "12345678", punto_id: "p1", cedula: "123456" });
    expect(JSON.parse(ultimaLlamada(f).init.body as string)).toMatchObject({ punto_id: "p1", cedula: "123456" });
  });

  it("crearPunto envia alias solo cuando hay", async () => {
    iniciarSesionDePrueba();
    const f = mockFetch(respuestaJson({}));
    await api.crearPunto("Punto", ["Principal"]);
    expect(JSON.parse(ultimaLlamada(f).init.body as string)).toEqual({ nombre: "Punto", alias: ["Principal"] });
    await api.crearPunto("Punto", []);
    expect(JSON.parse(ultimaLlamada(f).init.body as string)).toEqual({ nombre: "Punto" });
  });

  it("actualizarPunto acepta alias, incluso vacio", async () => {
    iniciarSesionDePrueba();
    const f = mockFetch(respuestaJson({}));
    await api.actualizarPunto("p1", { nombre: "N", alias: [] });
    expect(JSON.parse(ultimaLlamada(f).init.body as string)).toEqual({ nombre: "N", alias: [] });
  });

  it("actualizarPunto acepta es_interna", async () => {
    iniciarSesionDePrueba();
    const f = mockFetch(respuestaJson({}));
    await api.actualizarPunto("p1", { es_interna: true });
    expect(JSON.parse(ultimaLlamada(f).init.body as string)).toEqual({ es_interna: true });
  });
});
