// Lo primero que se ve al abrir la app: el login por PIN (PantallaLogin) sobre
// un fondo propio con los colores del logo (ver MARCA en vidrio.tsx) --
// degradado diagonal de cielo azul a azul noche, una grilla tecnica fina que
// se desvanece hacia abajo y tres haces de luz diagonales, todo quieto (ver
// FondoEntrada). Sobrio a proposito: nada de circulos ni manchas de color. Encima, todo es vidrio con
// desenfoque real (ver vidrio.tsx): portada con el saludo y el nombre de la
// empresa, selector deslizante Bodega / Traslados y, debajo, el login de esa
// area. Al entrar, la sesion queda para todas las tabs (ver SesionContext.tsx).
//   - Bodega: Despachos y Remisiones.
//   - Traslados: los puntos, y desde ahi "Supervision de traslados" (Erika)
//     -- es parte de esa area, no una entrada aparte.
//
// Si el celular ya tiene un acceso recordado (ver recuerdoLogin.ts) se abre
// en esa area con la sede de la ultima persona ya elegida.
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurTargetView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

import {
  fetchPuntos,
  fetchSupervisores,
  fetchUsuariosPunto,
  loginPunto,
  loginSupervisor,
  type Empleado,
  type Punto,
  type Sede,
  type Supervisor,
  type UsuarioPunto,
} from './api';
import PantallaLogin from './PantallaLogin';
import { SOPORTE, abrirEnlace, estiloEntrada, saludo, useEntrada, useReducirMovimiento } from './PantallaInicio';
import { guardarRecuerdo, leerRecuerdo, type RecuerdoLogin } from './recuerdoLogin';
import type { Sesion, TipoSesion } from './SesionContext';
import { FUENTE_BODY_BOLD, FUENTE_BODY_SEMI, FUENTE_DISPLAY, NEUTRAL_400, TEXTO_PRIMARIO } from './tema';
import { DEGRADADO_ACENTO, MARCA, ProveedorFondo, Vidrio, vibrar } from './vidrio';

const LOGO = require('./assets/logo-empresa.jpg');

// Pestañas del selector -- 'supervision' no tiene la suya: cuelga de
// Traslados (se entra con el boton de abajo de la lista de puntos).
type Area = 'bodega' | 'traslados';

const AREAS: { area: Area; titulo: string; icono: keyof typeof Ionicons.glyphMap }[] = [
  { area: 'bodega', titulo: 'Bodega', icono: 'cube-outline' },
  { area: 'traslados', titulo: 'Traslados', icono: 'swap-horizontal' },
];

const areaDe = (tipo: TipoSesion): Area => (tipo === 'bodega' ? 'bodega' : 'traslados');

// En la base el nombre del punto lleva su codigo adelante ("CFC — La Cumbre").
// En el login solo se muestra el nombre ("La Cumbre"); el resto de la app
// sigue usando el nombre completo, que viaja en nombreCompleto y se
// restituye al entrar.
type PuntoLogin = Punto & { nombreCompleto: string };

export const quitarCodigo = (punto: Punto) =>
  punto.codigo ? punto.nombre.replace(new RegExp(`^${punto.codigo}\\s*[—–-]\\s*`), '') : punto.nombre;

// Ordenados alfabeticamente por el nombre que se ve (sin el codigo).
const cargarPuntosLogin = async (): Promise<PuntoLogin[]> =>
  (await fetchPuntos())
    .map((p) => ({ ...p, nombre: quitarCodigo(p), nombreCompleto: p.nombre }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));

const puntoOriginal = ({ nombreCompleto, ...punto }: PuntoLogin): Punto => ({ ...punto, nombre: nombreCompleto });

export default function PantallaEntrada({ onLogin }: { onLogin: (sesion: Sesion) => void }) {
  const reducirMovimiento = useReducirMovimiento();
  // Hasta leer el recuerdo (un archivo chico, casi instantaneo) solo se ve el
  // fondo, para no mostrar un area y saltar a otra.
  const [recuerdo, setRecuerdo] = useState<RecuerdoLogin | null>(null);
  // Lo que los Vidrio desenfocan en iOS (en Android no hay desenfoque, ver vidrio.tsx).
  const objetivoDesenfoque = useRef<View | null>(null);

  useEffect(() => {
    leerRecuerdo().then(setRecuerdo);
  }, []);

  return (
    <View style={estilos.contenedor}>
      {Platform.OS === 'android' ? (
        <View ref={objetivoDesenfoque} style={StyleSheet.absoluteFill}>
          <FondoEntrada />
        </View>
      ) : (
        <BlurTargetView ref={objetivoDesenfoque} style={StyleSheet.absoluteFill}>
          <FondoEntrada />
        </BlurTargetView>
      )}
      <ProveedorFondo value={objetivoDesenfoque}>
        {recuerdo ? <Entrada recuerdo={recuerdo} onLogin={onLogin} reducirMovimiento={reducirMovimiento} /> : null}
      </ProveedorFondo>
    </View>
  );
}

const PASO_GRILLA = 32;

// Fondo QUIETO a proposito: degradado diagonal cielo -> azul -> azul noche, una
// grilla fina de lineas (como papel tecnico) que se desvanece hacia abajo y
// tres haces de luz diagonales fijos (blanco, dorado y verde de la marca).
// Sin animacion: en iOS el vidrio de las tarjetas (expo-blur) desenfoca lo que
// tiene detras y recalcula ese desenfoque cada vez que el fondo cambia; quieto,
// se calcula una sola vez. En Android el vidrio ya no desenfoca.
function FondoEntrada() {
  const { width, height } = useWindowDimensions();
  const columnas = Math.ceil(width / PASO_GRILLA) + 1;
  const filas = Math.ceil(height / PASO_GRILLA) + 1;
  const haz = (x: number) => ({ transform: [{ translateX: x }, { rotate: '-24deg' }] });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={[MARCA.cielo, MARCA.azul, MARCA.noche]}
        locations={[0, 0.45, 0.9]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.7, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      {/* Grilla fina: lineas verticales y horizontales cada PASO_GRILLA. */}
      <View style={StyleSheet.absoluteFill}>
        {Array.from({ length: columnas }, (_, i) => (
          <View key={`c${i}`} style={[estilos.lineaGrilla, { left: i * PASO_GRILLA, top: 0, bottom: 0, width: 1 }]} />
        ))}
        {Array.from({ length: filas }, (_, i) => (
          <View key={`f${i}`} style={[estilos.lineaGrilla, { top: i * PASO_GRILLA, left: 0, right: 0, height: 1 }]} />
        ))}
      </View>
      {/* La grilla se desvanece hacia abajo: arriba se ve, abajo queda liso. */}
      <LinearGradient
        colors={['rgba(8,22,51,0)', MARCA.noche]}
        locations={[0.25, 0.85]}
        style={StyleSheet.absoluteFill}
      />

      {/* Haces de luz diagonales, fijos. */}
      <View style={[estilos.haz, { height: height * 1.6, top: -height * 0.3 }, haz(width * 0.05)]}>
        <LinearGradient
          colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.14)', 'rgba(255,255,255,0)']}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <View style={[estilos.haz, estilos.hazAngosto, { height: height * 1.6, top: -height * 0.3 }, haz(width * 0.68)]}>
        <LinearGradient
          colors={['rgba(245,197,66,0)', 'rgba(245,197,66,0.12)', 'rgba(245,197,66,0)']}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </View>
      {/* Tercer haz, verde de la marca (#3D8E33). */}
      <View style={[estilos.haz, { height: height * 1.6, top: -height * 0.3 }, haz(width * 0.36)]}>
        <LinearGradient
          colors={['rgba(61,142,51,0)', 'rgba(61,142,51,0.2)', 'rgba(61,142,51,0)']}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </View>
    </View>
  );
}

function Entrada({
  recuerdo,
  onLogin,
  reducirMovimiento,
}: {
  recuerdo: RecuerdoLogin;
  onLogin: (sesion: Sesion) => void;
  reducirMovimiento: boolean;
}) {
  const [tipo, setTipo] = useState<TipoSesion>(recuerdo.area ?? 'bodega');
  const entrada = useEntrada(2, reducirMovimiento);
  const [{ texto: textoSaludo, icono: iconoSaludo }] = useState(() => saludo(new Date().getHours()));

  // Estado del selector aca y no adentro de SelectorArea: el encabezado se
  // dibuja dentro de PantallaLogin, que se vuelve a montar al cambiar de area
  // (key={tipo}) -- si la pastilla viviera ahi, saltaria en vez de deslizarse.
  const indiceArea = AREAS.findIndex((a) => a.area === areaDe(tipo));
  const posicionSelector = useRef(new Animated.Value(indiceArea)).current;
  const [anchoSelector, setAnchoSelector] = useState(0);
  useEffect(() => {
    if (reducirMovimiento) {
      posicionSelector.setValue(indiceArea);
      return;
    }
    Animated.spring(posicionSelector, {
      toValue: indiceArea,
      damping: 18,
      stiffness: 200,
      mass: 0.8,
      useNativeDriver: true,
    }).start();
  }, [indiceArea, reducirMovimiento, posicionSelector]);

  // "Atras" desde Supervision vuelve a los puntos. En el resto no se
  // intercepta: no hay pantalla anterior a esta.
  useEffect(() => {
    if (tipo !== 'supervision') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setTipo('punto');
      return true;
    });
    return () => sub.remove();
  }, [tipo]);

  const cambiarArea = (area: Area) => {
    const nuevo: TipoSesion = area === 'bodega' ? 'bodega' : 'punto';
    if (nuevo === tipo) return;
    vibrar.seleccion();
    setTipo(nuevo);
  };

  // Recuerda area + quien entro (y el largo de su PIN) y recien ahi abre la
  // sesion.
  const entrar = (sesion: Sesion, lugarId: string, usuarioId: string, largoPin: number) => {
    guardarRecuerdo({
      area: sesion.tipo,
      usuarios: { ...recuerdo.usuarios, [sesion.tipo]: { lugarId, usuarioId, largoPin } },
    });
    onLogin(sesion);
  };

  // Quien no puede entrar no tiene otra forma de pedir soporte desde la app.
  const ayuda = {
    texto: '¿No puedes entrar? Escríbenos',
    icono: 'logo-whatsapp' as const,
    onPress: () =>
      abrirEnlace(
        `https://wa.me/${SOPORTE.telefonoInternacional}?text=${encodeURIComponent(`Hola ${SOPORTE.nombre}, no puedo entrar a la app de despachos.`)}`,
        'WhatsApp'
      ),
  };

  // Portada: tarjeta de marca de vidrio -- logo a la izquierda; saludo,
  // nombre y "El Imperio" en dorado a la derecha; debajo el lema y, en el
  // borde inferior, la franja dorado/verde. Debajo, el selector de area.
  const encabezado = (
    <View style={estilos.encabezado}>
      <Animated.View style={estiloEntrada(entrada[0])}>
        <Vidrio style={estilos.tarjetaMarca} intensidad={40}>
          <View style={estilos.filaMarca}>
            <View style={estilos.marcoLogo}>
              <Image source={LOGO} style={estilos.logo} resizeMode="cover" accessibilityLabel="Logo de la empresa" />
            </View>
            <View style={estilos.textosMarca}>
              <View style={estilos.filaSaludo}>
                <Ionicons name={iconoSaludo} size={13} color={MARCA.oro} />
                <Text style={estilos.saludoTexto}>{textoSaludo}</Text>
              </View>
              <Text style={estilos.nombre} accessibilityRole="header" accessibilityLabel="Comercializadora El Imperio">
                Comercializadora
              </Text>
              <Text style={estilos.nombreDestacado} importantForAccessibility="no">
                El Imperio
              </Text>
            </View>
          </View>

          <View style={estilos.separador} />
          <View style={estilos.filaLema}>
            <View style={estilos.iconoLema}>
              <Ionicons name="cube-outline" size={14} color={TEXTO_PRIMARIO} />
            </View>
            <Text style={estilos.lema}>Control de despachos y traslados</Text>
          </View>

          {/* Franja de marca en el borde inferior: dorado y verde del logo. */}
          <View style={estilos.franjaMarca} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={[estilos.franja, { backgroundColor: MARCA.oro }]} />
            <View style={[estilos.franja, { backgroundColor: MARCA.verde }]} />
          </View>
        </Vidrio>
      </Animated.View>
      <Animated.View style={estiloEntrada(entrada[1])}>
        <SelectorArea
          area={areaDe(tipo)}
          onCambiar={cambiarArea}
          posicion={posicionSelector}
          ancho={anchoSelector}
          onAncho={setAnchoSelector}
        />
      </Animated.View>
    </View>
  );

  // key={tipo} en cada PantallaLogin: las ramas devuelven el mismo componente
  // en la misma posicion, y sin la key React reusaria su estado (ej. la lista
  // de puntos al pasar a Supervision).
  // Los casts de UsuarioLogin/Lugar a los tipos ricos son seguros: los
  // cargarUsuarios/login que se pasan en cada caso son justo los que
  // devuelven esos tipos.
  if (tipo === 'punto') {
    return (
      <PantallaLogin
        key={tipo}
        encabezado={encabezado}
        etiquetaLugar="punto"
        cargarLugares={cargarPuntosLogin}
        cargarUsuarios={fetchUsuariosPunto}
        login={loginPunto}
        usuarioUnicoPorLugar
        onLogin={(usuario, punto, largoPin) =>
          entrar(
            { tipo: 'punto', usuario: usuario as UsuarioPunto, punto: puntoOriginal(punto as PuntoLogin) },
            punto.id,
            usuario.id,
            largoPin
          )
        }
        usuarioRecordado={recuerdo.usuarios.punto}
        accionExtra={[
          {
            texto: 'Entrar como Supervisión de traslados',
            icono: 'shield-checkmark-outline',
            onPress: () => setTipo('supervision'),
          },
          ayuda,
        ]}
      />
    );
  }

  if (tipo === 'supervision') {
    return (
      <PantallaLogin
        key={tipo}
        encabezado={encabezado}
        etiquetaLugar="área"
        // Un solo "lugar" sintetico -- Supervision no tiene sedes ni
        // puntos; con un unico lugar PantallaLogin lo elige solo y muestra
        // directo la lista de supervisores.
        cargarLugares={async () => [{ id: 'supervision', nombre: 'Supervisión' }]}
        // Sin argumentos: PantallaLogin pasa el id del lugar, que aca no aplica.
        cargarUsuarios={() => fetchSupervisores()}
        login={loginSupervisor}
        onLogin={(usuario, lugar, largoPin) =>
          entrar({ tipo: 'supervision', supervisor: usuario as Supervisor }, lugar.id, usuario.id, largoPin)
        }
        usuarioRecordado={recuerdo.usuarios.supervision}
        accionExtra={[{ texto: 'Volver a los puntos', icono: 'arrow-back', onPress: () => setTipo('punto') }, ayuda]}
      />
    );
  }

  return (
    <PantallaLogin
      key={tipo}
      encabezado={encabezado}
      onLogin={(empleado, sede, largoPin) =>
        entrar({ tipo: 'bodega', empleado: empleado as Empleado, sede: sede as Sede }, sede.id, empleado.id, largoPin)
      }
      usuarioRecordado={recuerdo.usuarios.bodega}
      accionExtra={ayuda}
    />
  );
}

const RELLENO_SELECTOR = 5;

// Control segmentado de vidrio con una pastilla dorada (degradado) que se
// desliza con resorte hasta el area elegida.
function SelectorArea({
  area,
  onCambiar,
  posicion,
  ancho,
  onAncho,
}: {
  area: Area;
  onCambiar: (area: Area) => void;
  // Indice animado del area elegida (ver Entrada).
  posicion: Animated.Value;
  ancho: number;
  onAncho: (ancho: number) => void;
}) {
  // onLayout mide el ancho con el borde (1px por lado) incluido.
  const anchoPestana = (ancho - 2 * (RELLENO_SELECTOR + 1)) / AREAS.length;

  return (
    <View onLayout={(e) => onAncho(e.nativeEvent.layout.width)}>
      <Vidrio style={estilos.selector} intensidad={40}>
        {ancho > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[
              estilos.indicador,
              {
                width: anchoPestana,
                transform: [{ translateX: posicion.interpolate({ inputRange: [0, 1], outputRange: [0, anchoPestana] }) }],
              },
            ]}
          >
            <LinearGradient
              colors={DEGRADADO_ACENTO}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        ) : null}
        <View style={estilos.pestanas} accessibilityRole="tablist">
          {AREAS.map((a) => {
            const activa = a.area === area;
            return (
              <Pressable
                key={a.area}
                onPress={() => onCambiar(a.area)}
                accessibilityRole="tab"
                accessibilityState={{ selected: activa }}
                style={estilos.pestana}
              >
                <Ionicons name={a.icono} size={18} color={activa ? MARCA.tinta : NEUTRAL_400} />
                <Text style={[estilos.pestanaTexto, activa && estilos.pestanaTextoActiva]}>{a.titulo}</Text>
              </Pressable>
            );
          })}
        </View>
      </Vidrio>
    </View>
  );
}

const estilos = StyleSheet.create({
  contenedor: { flex: 1, backgroundColor: MARCA.noche },

  lineaGrilla: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.06)' },
  // Haz de luz: franja alta y girada; el degradado horizontal la hace suave.
  haz: { position: 'absolute', left: 0, width: 200 },
  hazAngosto: { width: 120 },

  encabezado: { gap: 18, paddingTop: 12 },

  // Tarjeta de marca.
  tarjetaMarca: { borderRadius: 26, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 20, gap: 14 },
  filaMarca: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  // Logo con anillo verde de la marca.
  marcoLogo: {
    width: 76,
    height: 76,
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: 2.5,
    borderColor: MARCA.verde,
  },
  logo: { width: '100%', height: '100%' },
  textosMarca: { flex: 1 },
  filaSaludo: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  saludoTexto: {
    color: MARCA.oro,
    fontSize: 12,
    fontFamily: FUENTE_BODY_BOLD,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  nombre: { color: TEXTO_PRIMARIO, fontSize: 24, fontFamily: FUENTE_DISPLAY, lineHeight: 28 },
  nombreDestacado: { color: MARCA.oro, fontSize: 24, fontFamily: FUENTE_DISPLAY, lineHeight: 28 },
  separador: { height: 1, backgroundColor: 'rgba(255,255,255,0.12)' },
  filaLema: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconoLema: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: MARCA.verde,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lema: { flex: 1, color: 'rgba(245,243,239,0.82)', fontSize: 14, fontFamily: FUENTE_BODY_SEMI },
  // Franja dorado/verde pegada al borde inferior de la tarjeta.
  franjaMarca: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, flexDirection: 'row' },
  franja: { flex: 1 },

  selector: { padding: RELLENO_SELECTOR, borderRadius: 22 },
  indicador: {
    position: 'absolute',
    top: RELLENO_SELECTOR,
    bottom: RELLENO_SELECTOR,
    left: RELLENO_SELECTOR,
    borderRadius: 17,
    overflow: 'hidden',
  },
  pestanas: { flexDirection: 'row' },
  pestana: {
    flex: 1,
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  pestanaTexto: { color: NEUTRAL_400, fontSize: 15, fontFamily: FUENTE_BODY_BOLD },
  pestanaTextoActiva: { color: MARCA.tinta },
});
