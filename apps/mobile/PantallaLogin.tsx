import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import { fetchEmpleados, fetchSedes, loginConPin, type Lugar, type UsuarioLogin } from './api';
import EvitarTeclado from './EvitarTeclado';
import { mensajeError } from './errorMessages';
import { Presionable, estiloEntrada, useReducirMovimiento } from './PantallaInicio';
import type { UsuarioRecordado } from './recuerdoLogin';
import { Avatar, BotonDegradado, DEGRADADO_ACENTO, MARCA, Vidrio, vibrar } from './vidrio';
import {
  FUENTE_BODY,
  FUENTE_BODY_BOLD,
  FUENTE_BODY_SEMI,
  FUENTE_DISPLAY,
  FUENTE_DISPLAY_SEMI,
  NEUTRAL_400,
  NEUTRAL_500,
  TEXTO_PRIMARIO,
} from './tema';

// Todo el login vive en una sola pantalla, sin popups:
//   elegir: lugar (chips arriba, o lista con buscador si son muchos) y debajo
//           el personal de ese lugar como lista (avatar + nombre) -- un toque
//           en tu nombre y pasas al PIN.
//   pin:    campo con el teclado numerico del telefono. Con 6 digitos (o el
//           largo recordado de su PIN) entra solo; si no, "Ingresar".
// Si viene usuarioRecordado (ultimo acceso en este celular, ver
// recuerdoLogin.ts) su sede ya aparece elegida con el personal a la vista,
// pero nunca se abre el PIN de nadie solo: siempre se toca el nombre.
type PasoLogin = 'elegir' | 'pin';

// Default de cargarUsuarios (Despachos): 'faia_viewer' es de solo lectura de
// fotos (panel /faia del dashboard, en el navegador) -- no tiene nada que
// hacer en esta app (el login ya lo rechaza si se cuela, ver ingresar() mas
// abajo), asi que ni se lo ofrece como opcion en la lista de personal.
// Este filtro es especifico de Despachos -- Traslados manda su propio
// cargarUsuarios (ver PantallaEntrada.tsx) sin este criterio.
async function cargarEmpleadosDespachos(sedeId: string): Promise<UsuarioLogin[]> {
  const lista = await fetchEmpleados(sedeId);
  return lista.filter((e) => e.rol !== 'faia_viewer');
}

type AccionExtra = { texto: string; icono: keyof typeof Ionicons.glyphMap; onPress: () => void };

// Hasta este numero de lugares se muestran como chips lado a lado
// (Despachos: un par de sedes); con mas se pasa a lista con buscador.
const MAX_TARJETAS = 4;

const PIN_MIN = 4;
// El indicador de carga solo aparece si la respuesta tarda mas que esto: con
// la cache (ver cache.ts) una sede ya vista responde al instante y no hace
// falta mostrar nada.
const ESPERA_INDICADOR_MS = 200;
const PIN_MAX = 6;

// Quien entro la ultima vez en este celular va primero: es a quien mas
// probablemente haya que tocar. El resto mantiene el orden del backend.
const ordenarConRecordadoPrimero = (lista: UsuarioLogin[], recordadoId?: string) => {
  const recordado = lista.find((u) => u.id === recordadoId);
  return recordado ? [recordado, ...lista.filter((u) => u !== recordado)] : lista;
};

// Para el buscador: sin mayusculas ni tildes ("sachica" encuentra "Sáchica").
const normalizar = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export default function PantallaLogin({
  onLogin,
  // Marca + selector de area (ver PantallaEntrada.tsx): va arriba del paso
  // de elegir, y se oculta en el PIN para que la atencion quede en el campo.
  encabezado,
  // Palabra usada en "Elige la sede" / "Elige el punto" -- unico texto visible que
  // menciona "sede" a secas; el resto de la pantalla es generico.
  etiquetaLugar = 'sede',
  cargarLugares = fetchSedes,
  cargarUsuarios = cargarEmpleadosDespachos,
  login = loginConPin,
  // Traslados: no se elige persona, se entra como el punto -- cada punto
  // tiene una unica cuenta (ver scripts/cargar_puntos.py). Con esto tocar el
  // punto lleva directo al PIN.
  usuarioUnicoPorLugar = false,
  // Botones secundarios al pie (uno o varios) -- ej. "Entrar como
  // Supervisión de traslados" o la ayuda por WhatsApp (ver PantallaEntrada.tsx).
  accionExtra,
  // Si viene, solo se ofrecen (y solo entran) usuarios con uno de estos
  // roles. Sin esto el login queda como siempre.
  rolesPermitidos,
  // Ultimo acceso en este celular (ver recuerdoLogin.ts): preelige su lugar
  // y, al tocar su nombre, entra al completar el largo de su PIN.
  usuarioRecordado,
}: {
  onLogin: (usuario: UsuarioLogin, lugar: Lugar, largoPin: number) => void;
  encabezado?: ReactNode;
  etiquetaLugar?: string;
  cargarLugares?: () => Promise<Lugar[]>;
  cargarUsuarios?: (lugarId: string) => Promise<UsuarioLogin[]>;
  login?: (pin: string, usuarioId: string) => Promise<UsuarioLogin>;
  usuarioUnicoPorLugar?: boolean;
  accionExtra?: AccionExtra | AccionExtra[];
  rolesPermitidos?: string[];
  usuarioRecordado?: UsuarioRecordado;
}) {
  const insets = useSafeAreaInsets();
  const reducirMovimiento = useReducirMovimiento();

  const cargarUsuariosPermitidos = async (lugarId: string) => {
    const lista = await cargarUsuarios(lugarId);
    return rolesPermitidos ? lista.filter((u) => u.rol !== undefined && rolesPermitidos.includes(u.rol)) : lista;
  };
  const [paso, setPaso] = useState<PasoLogin>('elegir');

  const [sedes, setSedes] = useState<Lugar[]>([]);
  const [cargandoSedes, setCargandoSedes] = useState(false);
  const [errorSedes, setErrorSedes] = useState<string | null>(null);
  const [sedeElegida, setSedeElegida] = useState<Lugar | null>(null);
  // Filtro del buscador -- solo se usa en modo lista (ver MAX_TARJETAS).
  const [busquedaLugar, setBusquedaLugar] = useState('');

  const [empleados, setEmpleados] = useState<UsuarioLogin[]>([]);
  // Lugar al que pertenece `empleados` -- para no mostrar "no hay personal"
  // de un lugar mientras todavia se esta cargando otro.
  const [empleadosDe, setEmpleadosDe] = useState<string | null>(null);
  const [cargandoEmpleados, setCargandoEmpleados] = useState(false);
  const [errorEmpleados, setErrorEmpleados] = useState<string | null>(null);
  const [empleadoElegido, setEmpleadoElegido] = useState<UsuarioLogin | null>(null);
  // Ultimo lugar pedido: si se tocan dos lugares seguidos, la respuesta del
  // primero (si llega tarde) se descarta.
  const pedidoLugar = useRef<string | null>(null);

  const [pin, setPin] = useState('');
  const [cargandoLogin, setCargandoLogin] = useState(false);
  const [errorLogin, setErrorLogin] = useState<string | null>(null);
  const sacudida = useRef(new Animated.Value(0)).current;
  // Cada paso entra con un fundido que sube un poco (ver estiloEntrada), asi
  // pasar de la lista al PIN y volver se siente continuo, no un salto.
  const aparicion = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reducirMovimiento) {
      aparicion.setValue(1);
      return;
    }
    aparicion.setValue(0);
    Animated.spring(aparicion, { toValue: 1, damping: 18, stiffness: 140, mass: 0.9, useNativeDriver: true }).start();
  }, [paso, reducirMovimiento, aparicion]);
  // Largo del PIN de la persona recordada (solo el largo, nunca el PIN): al
  // llegar a esa cantidad de digitos se entra solo, sin tocar "Ingresar".
  // Si ese intento falla (ej. cambio su PIN por uno mas largo) se apaga para
  // esta pantalla y se vuelve a confirmar a mano.
  const [entrarAlCompletar, setEntrarAlCompletar] = useState(true);
  const largoAutomatico =
    entrarAlCompletar && empleadoElegido && usuarioRecordado?.usuarioId === empleadoElegido.id
      ? usuarioRecordado.largoPin
      : undefined;

  const elegirEmpleado = (empleado: UsuarioLogin) => {
    vibrar.seleccion();
    setEmpleadoElegido(empleado);
    setPin('');
    setErrorLogin(null);
    setPaso('pin');
  };

  const cargarEmpleados = (sede: Lugar) => {
    pedidoLugar.current = sede.id;
    setErrorEmpleados(null);
    setEmpleadosDe(null);
    const indicador = setTimeout(() => {
      if (pedidoLugar.current === sede.id) setCargandoEmpleados(true);
    }, ESPERA_INDICADOR_MS);
    cargarUsuariosPermitidos(sede.id)
      .then((lista) => {
        if (pedidoLugar.current !== sede.id) return;
        setEmpleados(lista);
        setEmpleadosDe(sede.id);
        // Modo usuarioUnicoPorLugar: se toma la cuenta del lugar sin
        // preguntar. Si no tiene cuenta queda el aviso "no hay cuenta".
        if (usuarioUnicoPorLugar && lista.length > 0) elegirEmpleado(lista[0]);
      })
      .catch((err) => {
        if (pedidoLugar.current === sede.id) {
          setErrorEmpleados(mensajeError(err, etiquetaLugar === 'punto' ? 'personal_punto' : 'empleados'));
        }
      })
      .finally(() => {
        clearTimeout(indicador);
        if (pedidoLugar.current === sede.id) setCargandoEmpleados(false);
      });
  };

  const seleccionarLugar = (sede: Lugar) => {
    vibrar.seleccion();
    setSedeElegida(sede);
    setEmpleadoElegido(null);
    cargarEmpleados(sede);
  };

  const cargarSedes = () => {
    setErrorSedes(null);
    const indicador = setTimeout(() => setCargandoSedes(true), ESPERA_INDICADOR_MS);
    cargarLugares()
      .then((lista) => {
        setSedes(lista);
        if (sedeElegida) return; // Reintento: se respeta lo que ya estaba elegido.
        // Un solo lugar (ej. Supervisión): no hay nada que elegir. Si no, se
        // preelige el del ultimo acceso -- solo cuando elegir el lugar muestra
        // la lista; en Traslados (usuarioUnicoPorLugar) elegir el punto ya
        // abre su PIN, y eso no debe pasar sin que nadie toque.
        const recordado = lista.find((l) => l.id === usuarioRecordado?.lugarId);
        if (lista.length === 1) seleccionarLugar(lista[0]);
        else if (recordado && !usuarioUnicoPorLugar) seleccionarLugar(recordado);
      })
      .catch((err) => setErrorSedes(mensajeError(err, etiquetaLugar === 'punto' ? 'puntos' : 'sedes')))
      .finally(() => {
        clearTimeout(indicador);
        setCargandoSedes(false);
      });
  };

  useEffect(() => {
    cargarSedes();
  }, []);

  // Limpia el PIN/error al volver. El lugar y su personal quedan cargados --
  // cambiar de persona es un solo toque en la lista.
  const volver = () => {
    setPin('');
    setErrorLogin(null);
    setEmpleadoElegido(null);
    setPaso('elegir');
  };

  // "Atras" del celular desde el PIN vuelve a la lista, no sale del area.
  useEffect(() => {
    if (paso !== 'pin') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      volver();
      return true;
    });
    return () => sub.remove();
  }, [paso]);

  const sacudir = () => {
    if (reducirMovimiento) return;
    sacudida.setValue(0);
    Animated.sequence(
      [10, -10, 7, -7, 3, 0].map((x) => Animated.timing(sacudida, { toValue: x, duration: 50, useNativeDriver: true }))
    ).start();
  };

  const fallar = (mensaje: string) => {
    vibrar.error();
    setErrorLogin(mensaje);
    setPin('');
    sacudir();
  };

  const ingresar = async (pinIngresado: string) => {
    if (!sedeElegida || !empleadoElegido || pinIngresado.length < PIN_MIN || cargandoLogin) return;
    setCargandoLogin(true);
    setErrorLogin(null);
    try {
      const empleado = await login(pinIngresado, empleadoElegido.id);
      // 'faia_viewer' es de solo lectura de fotos (panel /faia del
      // dashboard, en el navegador) -- no tiene nada que hacer en esta app,
      // ni siquiera entrar. El backend igual lo bloquea si de algun modo
      // llegara a fotografiar/confirmar (ver RolNoAutorizado), pero aca
      // se corta antes, con un mensaje que tenga sentido. Chequeo generico
      // (rol es opcional en UsuarioLogin): en Traslados el usuario logueado
      // no tiene rol, asi que esta condicion simplemente nunca se cumple ahi.
      if (empleado.rol === 'faia_viewer') {
        fallar('Este usuario es solo para ver fotos FAIA -- entrá desde el panel en la computadora.');
        return;
      }
      if (rolesPermitidos && (!empleado.rol || !rolesPermitidos.includes(empleado.rol))) {
        fallar('Este usuario no tiene acceso a esta sección.');
        return;
      }
      vibrar.exito();
      onLogin(empleado, sedeElegida, pinIngresado.length);
    } catch (err) {
      fallar(mensajeError(err, 'login'));
    } finally {
      setCargandoLogin(false);
    }
  };

  const cambiarPin = (texto: string) => {
    if (cargandoLogin) return;
    const nuevo = texto.replace(/[^0-9]/g, '').slice(0, PIN_MAX);
    setPin(nuevo);
    setErrorLogin(null);
    // El PIN mas largo posible no deja dudas; y si ya se sabe el largo del
    // PIN de esta persona, tampoco: se entra sin tocar "Ingresar".
    if (nuevo.length === PIN_MAX) {
      ingresar(nuevo);
    } else if (largoAutomatico !== undefined && nuevo.length === largoAutomatico) {
      setEntrarAlCompletar(false);
      ingresar(nuevo);
    }
  };

  const acciones = accionExtra ? (Array.isArray(accionExtra) ? accionExtra : [accionExtra]) : [];
  const verLista = sedes.length > MAX_TARJETAS;
  const verChips = sedes.length > 1 && !verLista;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {paso === 'pin' && sedeElegida && empleadoElegido ? (
        <EvitarTeclado>
          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={[styles.scrollPin, { paddingBottom: insets.bottom + 16 }]}
            keyboardShouldPersistTaps="handled"
          >
            <Pressable onPress={volver} hitSlop={8} accessibilityRole="button" style={styles.botonVolverZona}>
              <Vidrio style={styles.botonVolver} intensidad={30}>
                <Ionicons name="chevron-back" size={18} color={TEXTO_PRIMARIO} />
                <Text style={styles.botonVolverTexto}>Volver</Text>
              </Vidrio>
            </Pressable>

            <Animated.View style={estiloEntrada(aparicion)}>
              <Vidrio style={styles.tarjetaPin}>
                <View style={styles.identidadPin}>
                  <View style={styles.anilloAvatar}>
                    <Avatar
                      nombre={empleadoElegido.nombre}
                      tamano={88}
                      icono={
                        usuarioUnicoPorLugar ? <Ionicons name="storefront" size={36} color={MARCA.tinta} /> : undefined
                      }
                    />
                  </View>
                  <Text style={styles.nombrePin} numberOfLines={1} accessibilityRole="header">
                    {usuarioUnicoPorLugar ? sedeElegida.nombre : empleadoElegido.nombre}
                  </Text>
                  {usuarioUnicoPorLugar ? null : (
                    <View style={styles.badgeSede}>
                      <Ionicons name="location" size={12} color={MARCA.oro} />
                      <Text style={styles.badgeSedeTexto}>{sedeElegida.nombre}</Text>
                    </View>
                  )}
                </View>

                <Text style={styles.etiquetaPin}>Ingresa tu PIN</Text>

                <Animated.View style={{ transform: [{ translateX: sacudida }] }}>
                  <TextInput
                    value={pin}
                    onChangeText={cambiarPin}
                    keyboardType="number-pad"
                    secureTextEntry
                    maxLength={PIN_MAX}
                    autoFocus
                    editable={!cargandoLogin}
                    placeholder="• • • •"
                    placeholderTextColor={NEUTRAL_500}
                    style={[styles.input, errorLogin && styles.inputError]}
                    onSubmitEditing={() => ingresar(pin)}
                    accessibilityLabel="PIN"
                  />
                </Animated.View>

                {errorLogin ? (
                  <Text style={styles.error} accessibilityLiveRegion="polite">
                    {errorLogin}
                  </Text>
                ) : null}

                <BotonDegradado
                  texto="Ingresar"
                  onPress={() => ingresar(pin)}
                  deshabilitado={pin.length < PIN_MIN}
                  cargando={cargandoLogin}
                />
              </Vidrio>
            </Animated.View>
          </ScrollView>
        </EvitarTeclado>
      ) : (
        <EvitarTeclado>
          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 16 }]}
            keyboardShouldPersistTaps="handled"
          >
            {encabezado}

            <Animated.View style={[styles.cuerpo, estiloEntrada(aparicion)]}>
              {/* Con un solo lugar (Supervision) no hay nada que elegir: la
                  tarjeta de lugares no aparece. */}
              {sedes.length === 1 && !cargandoSedes && !errorSedes ? null : (
                <Vidrio style={styles.tarjeta}>
                  <View>
                    <Text style={styles.titulo} accessibilityRole="header">
                      Elige {etiquetaLugar === 'sede' ? 'la' : 'el'} {etiquetaLugar}
                    </Text>
                  </View>

                  {cargandoSedes ? (
                    <ActivityIndicator color={MARCA.oro} style={styles.spinner} />
                  ) : errorSedes ? (
                    <BloqueError mensaje={errorSedes} onReintentar={cargarSedes} />
                  ) : verLista ? (
                    <View style={styles.listaLugares}>
                      {/* Traslados (usuarioUnicoPorLugar): el estado de la
                          cuenta del punto va arriba de la lista, a la vista. */}
                      {usuarioUnicoPorLugar && sedeElegida ? (
                        cargandoEmpleados ? (
                          <ActivityIndicator color={MARCA.oro} />
                        ) : errorEmpleados ? (
                          <BloqueError mensaje={errorEmpleados} onReintentar={() => cargarEmpleados(sedeElegida)} />
                        ) : empleadosDe === sedeElegida.id && empleados.length === 0 ? (
                          <Text style={styles.sinDatos}>
                            Todavía no hay personal registrado en{' '}
                            {etiquetaLugar === 'sede' ? 'esta sede' : `este ${etiquetaLugar}`}.
                          </Text>
                        ) : null
                      ) : null}
                      <View style={styles.buscador}>
                        <Ionicons name="search" size={18} color={NEUTRAL_400} />
                        <TextInput
                          value={busquedaLugar}
                          onChangeText={setBusquedaLugar}
                          placeholder={`Buscar ${etiquetaLugar}…`}
                          placeholderTextColor={NEUTRAL_500}
                          style={styles.inputBuscar}
                          autoCorrect={false}
                        />
                      </View>
                      {sedes
                        .filter((sede) => normalizar(sede.nombre).includes(normalizar(busquedaLugar.trim())))
                        .map((sede) => {
                          const activa = sedeElegida?.id === sede.id;
                          return (
                            <Presionable
                              key={sede.id}
                              onPress={() => seleccionarLugar(sede)}
                              accessibilityRole="button"
                              estilo={[styles.filaLugar, activa && styles.filaLugarActiva]}
                            >
                              <View style={styles.filaLugarIcono}>
                                <Ionicons name="storefront-outline" size={18} color={MARCA.oro} />
                              </View>
                              <Text style={styles.filaLugarTexto} numberOfLines={1}>
                                {sede.nombre}
                              </Text>
                              <Ionicons name="chevron-forward" size={18} color={NEUTRAL_500} />
                            </Presionable>
                          );
                        })}
                    </View>
                  ) : (
                    <View style={styles.filaChips} accessibilityRole="radiogroup">
                      {sedes.map((sede) => {
                        const activa = sedeElegida?.id === sede.id;
                        return (
                          <Presionable
                            key={sede.id}
                            onPress={() => seleccionarLugar(sede)}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: activa }}
                            estiloContenedor={styles.chipTocable}
                            estilo={[styles.chip, activa && styles.chipActivo]}
                          >
                            {activa ? (
                              <LinearGradient
                                colors={DEGRADADO_ACENTO}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 1 }}
                                style={StyleSheet.absoluteFill}
                              />
                            ) : null}
                            <Ionicons name="business" size={20} color={activa ? MARCA.tinta : MARCA.oro} />
                            <Text style={[styles.chipTexto, activa && styles.chipTextoActivo]} numberOfLines={1}>
                              {sede.nombre}
                            </Text>
                          </Presionable>
                        );
                      })}
                    </View>
                  )}
                </Vidrio>
              )}

              {!usuarioUnicoPorLugar && sedeElegida ? (
                <Vidrio style={styles.tarjeta}>
                  {cargandoEmpleados ? (
                    <ActivityIndicator color={MARCA.oro} style={styles.spinner} />
                  ) : errorEmpleados ? (
                    <BloqueError mensaje={errorEmpleados} onReintentar={() => cargarEmpleados(sedeElegida)} />
                  ) : empleadosDe !== sedeElegida.id ? null : empleados.length === 0 ? (
                    <Text style={styles.sinDatos}>
                      Todavía no hay personal registrado en{' '}
                      {etiquetaLugar === 'sede' ? 'esta sede' : `este ${etiquetaLugar}`}.
                    </Text>
                  ) : (
                    <View style={styles.listaPersonas}>
                      {ordenarConRecordadoPrimero(empleados, usuarioRecordado?.usuarioId).map((empleado) => {
                        const recordado = empleado.id === usuarioRecordado?.usuarioId;
                        return (
                          <Presionable
                            key={empleado.id}
                            onPress={() => elegirEmpleado(empleado)}
                            accessibilityRole="button"
                            accessibilityLabel={`Entrar como ${empleado.nombre}`}
                            estilo={[styles.persona, recordado && styles.personaRecordada]}
                          >
                            <Avatar nombre={empleado.nombre} tamano={46} />
                            <Text style={styles.personaTexto} numberOfLines={1}>
                              {empleado.nombre}
                            </Text>
                            <View style={[styles.personaFlecha, recordado && styles.personaFlechaRecordada]}>
                              <Ionicons name="chevron-forward" size={16} color={recordado ? MARCA.tinta : NEUTRAL_400} />
                            </View>
                          </Presionable>
                        );
                      })}
                    </View>
                  )}
                </Vidrio>
              ) : null}

              {acciones.length > 0 ? (
                <View style={styles.pie}>
                  {acciones.map((accion) => (
                    <Pressable
                      key={accion.texto}
                      onPress={accion.onPress}
                      accessibilityRole="button"
                      style={({ pressed }) => [styles.botonAccionExtra, pressed && { opacity: 0.7 }]}
                    >
                      <Ionicons name={accion.icono} size={16} color={NEUTRAL_400} />
                      <Text style={styles.botonAccionExtraTexto}>{accion.texto}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </Animated.View>
          </ScrollView>
        </EvitarTeclado>
      )}
    </View>
  );
}

function BloqueError({ mensaje, onReintentar }: { mensaje: string; onReintentar: () => void }) {
  return (
    <View style={styles.bloqueError}>
      <Text style={styles.error}>{mensaje}</Text>
      <Pressable onPress={onReintentar} style={styles.botonReintentar} accessibilityRole="button">
        <Text style={styles.botonReintentarTexto}>Reintentar</Text>
      </Pressable>
    </View>
  );
}

// Superficies dentro del vidrio: blanco muy tenue, se nota el canto sin tapar
// el desenfoque de atras.
const SUPERFICIE = 'rgba(255,255,255,0.06)';
const BORDE_SUPERFICIE = 'rgba(255,255,255,0.10)';

const styles = StyleSheet.create({
  // Transparente: el fondo (foto + brillos) lo pone PantallaEntrada.
  container: { flex: 1 },
  scrollView: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 18, paddingTop: 8, gap: 22 },
  cuerpo: { flexGrow: 1, gap: 16 },

  tarjeta: { borderRadius: 28, padding: 20, gap: 18 },
  titulo: { color: TEXTO_PRIMARIO, fontSize: 22, fontFamily: FUENTE_DISPLAY, lineHeight: 28 },

  spinner: { marginVertical: 8 },
  bloqueError: { alignItems: 'center', gap: 10 },
  botonReintentar: {
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: SUPERFICIE,
    borderWidth: 1,
    borderColor: BORDE_SUPERFICIE,
    borderRadius: 14,
    paddingHorizontal: 18,
  },
  botonReintentarTexto: { color: TEXTO_PRIMARIO, fontFamily: FUENTE_BODY_SEMI, fontSize: 14 },
  sinDatos: { color: NEUTRAL_400, fontSize: 14, fontFamily: FUENTE_BODY, textAlign: 'center' },

  // Sedes: tarjetas lado a lado; la elegida se llena con el degradado naranja.
  filaChips: { flexDirection: 'row', gap: 10 },
  chipTocable: { flex: 1 },
  chip: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 10,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: SUPERFICIE,
    borderWidth: 1,
    borderColor: BORDE_SUPERFICIE,
  },
  chipActivo: { borderColor: 'rgba(255,255,255,0.25)' },
  chipTexto: { flexShrink: 1, color: TEXTO_PRIMARIO, fontSize: 15.5, fontFamily: FUENTE_BODY_BOLD },
  // Sobre el dorado de la sede elegida el blanco no se lee.
  chipTextoActivo: { color: MARCA.tinta },

  listaLugares: { gap: 8 },
  buscador: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(8,12,20,0.45)',
    borderWidth: 1,
    borderColor: BORDE_SUPERFICIE,
    borderRadius: 16,
    paddingHorizontal: 14,
  },
  inputBuscar: { flex: 1, paddingVertical: 12, color: TEXTO_PRIMARIO, fontFamily: FUENTE_BODY, fontSize: 16 },
  filaLugar: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: SUPERFICIE,
    borderWidth: 1,
    borderColor: BORDE_SUPERFICIE,
  },
  filaLugarActiva: { borderColor: MARCA.oro },
  filaLugarIcono: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: 'rgba(245,197,66,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filaLugarTexto: { flex: 1, color: TEXTO_PRIMARIO, fontSize: 16, fontFamily: FUENTE_BODY_SEMI },

  // Personal: lista vertical, una fila por persona a todo el ancho -- el
  // nombre completo entra en una linea y toda la fila se puede tocar.
  listaPersonas: { gap: 8 },
  persona: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 9,
    paddingLeft: 9,
    paddingRight: 12,
    borderRadius: 20,
    backgroundColor: SUPERFICIE,
    borderWidth: 1,
    borderColor: BORDE_SUPERFICIE,
  },
  // Quien entro la ultima vez en este celular: primera fila, borde naranja.
  personaRecordada: { borderColor: 'rgba(245,197,66,0.7)', backgroundColor: 'rgba(245,197,66,0.12)' },
  personaTexto: { flex: 1, color: TEXTO_PRIMARIO, fontSize: 16, fontFamily: FUENTE_BODY_SEMI },
  personaFlecha: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: SUPERFICIE,
  },
  personaFlechaRecordada: { backgroundColor: MARCA.oro },

  pie: { marginTop: 'auto', paddingTop: 4 },
  botonAccionExtra: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  botonAccionExtraTexto: { color: NEUTRAL_400, fontSize: 14, fontFamily: FUENTE_BODY_SEMI },

  // Paso PIN: tarjeta de vidrio centrada; el campo usa el teclado del telefono.
  scrollPin: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 18, paddingTop: 12, gap: 14 },
  botonVolverZona: { alignSelf: 'flex-start' },
  botonVolver: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 10,
    paddingRight: 14,
    borderRadius: 999,
  },
  botonVolverTexto: { color: TEXTO_PRIMARIO, fontFamily: FUENTE_BODY_SEMI, fontSize: 14 },
  tarjetaPin: { borderRadius: 30, padding: 24, gap: 18 },
  identidadPin: { alignItems: 'center', gap: 10 },
  // Anillo claro alrededor del avatar grande.
  anilloAvatar: { padding: 4, borderRadius: 999, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)' },
  nombrePin: { color: TEXTO_PRIMARIO, fontSize: 24, fontFamily: FUENTE_DISPLAY, textAlign: 'center' },
  badgeSede: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: SUPERFICIE,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  badgeSedeTexto: { color: NEUTRAL_400, fontSize: 13, fontFamily: FUENTE_BODY_SEMI },
  etiquetaPin: {
    color: NEUTRAL_400,
    fontSize: 12.5,
    fontFamily: FUENTE_BODY_SEMI,
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  input: {
    width: '100%',
    backgroundColor: 'rgba(8,12,20,0.5)',
    borderWidth: 1,
    borderColor: BORDE_SUPERFICIE,
    borderRadius: 18,
    paddingVertical: 17,
    fontSize: 26,
    letterSpacing: 10,
    textAlign: 'center',
    color: TEXTO_PRIMARIO,
    fontFamily: FUENTE_DISPLAY_SEMI,
  },
  inputError: { borderColor: '#f87171' },
  error: { color: '#fca5a5', fontSize: 14, fontFamily: FUENTE_BODY_SEMI, textAlign: 'center' },
});
