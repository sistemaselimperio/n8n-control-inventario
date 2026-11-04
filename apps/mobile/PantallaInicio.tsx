// Tab de Inicio -- lo primero que se ve despues del login (ver
// PantallaEntrada.tsx). Con los colores del logo de la empresa (MARCA en
// vidrio.tsx), pero con un diseño propio, distinto del login:
//   - Encabezado en degradado cielo -> azul con esquinas redondeadas: marca,
//     conexion con el backend, saludo, sede/punto, calendario con el dia y
//     las cifras de lo registrado hoy.
//     Fondo con lineas diagonales quietas (ver FondoEncabezado) -- antes se
//     desplazaban y tenian un destello de luz; se quito la animacion.
//   - Debajo, sobre azul noche: pendientes del area como mosaicos con el
//     numero grande en dorado, consejo del dia, soporte y version instalada
//     (para saber si se puede trabajar y, en soporte, que version tiene).
//
// Algunas piezas (Presionable, useEntrada, saludo, SOPORTE...) las reusan
// PantallaEntrada.tsx y PantallaLogin.tsx.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Animated,
  Easing,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useIsFocused, useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { LinearGradient } from 'expo-linear-gradient';
import * as Updates from 'expo-updates';

import {
  API_BASE_URL,
  fetchFacturasFaltantes,
  fetchFacturasYaSubidas,
  fetchResumenHoy,
  fetchTrasladosPunto,
} from './api';
import type { TabsParamList } from './Navegacion';
import { lugarSesion, tieneAcceso, useSesion, type Sesion } from './SesionContext';
import {
  FUENTE_BODY,
  FUENTE_BODY_BOLD,
  FUENTE_BODY_SEMI,
  FUENTE_DISPLAY,
  NEUTRAL_400,
  TEXTO_PRIMARIO,
} from './tema';
import TarjetaTalonario from './TarjetaTalonario';
import { MARCA } from './vidrio';

// Sin numero de version a proposito: "version" de app.json entra en el
// fingerprint (runtimeVersion policy), cambiarlo haria que la actualizacion
// deje de llegar a los .apk instalados. La fecha de la actualizacion OTA
// (textoActualizacion) cambia sola en cada publicacion y es lo que sirve
// para soporte.

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export function saludo(hora: number): { texto: string; icono: keyof typeof Ionicons.glyphMap } {
  if (hora < 12) return { texto: 'Buenos días', icono: 'sunny-outline' };
  if (hora < 19) return { texto: 'Buenas tardes', icono: 'partly-sunny-outline' };
  return { texto: 'Buenas noches', icono: 'moon-outline' };
}

const dosDigitos = (n: number) => String(n).padStart(2, '0');

type EstadoConexion = 'verificando' | 'conectado' | 'sin_conexion';

// Que actualizacion OTA esta corriendo -- en Expo Go / desarrollo no hay.
function textoActualizacion(): string {
  if (__DEV__) return 'Modo desarrollo';
  if (Updates.isEmbeddedLaunch || !Updates.createdAt) return 'Versión instalada';
  const f = Updates.createdAt;
  return `Actualizada el ${f.getDate()} ${MESES[f.getMonth()].slice(0, 3)} · ${dosDigitos(f.getHours())}:${dosDigitos(f.getMinutes())}`;
}

// Superficies del cuerpo (sobre azul noche): un azul apenas mas claro que el
// fondo y un borde claro muy suave que marca el canto.
const SUPERFICIE = '#0f2350';
const BORDE_SUPERFICIE = 'rgba(255,255,255,0.08)';
// Vidrio oscuro encima del degradado del encabezado (pastillas).
const VIDRIO_ENCABEZADO = 'rgba(8,22,51,0.35)';

// Consejos que rotan en el carrusel de Inicio (ver CarruselConsejos). Para
// agregar o cambiar consejos, editar esta lista: llega por EAS Update sin
// tocar el backend.
type AreaConsejo = 'despachos' | 'traslados' | 'general';

// Etiqueta de area de cada consejo -- mismos iconos que las tabs del menu
// de abajo (ver Navegacion.tsx), para que se asocie de un vistazo.
const AREAS_CONSEJO: Record<AreaConsejo, { texto: string; icono: keyof typeof Ionicons.glyphMap; color: string }> = {
  despachos: { texto: 'Despachos', icono: 'cube-outline', color: '#60a5fa' },
  traslados: { texto: 'Traslados', icono: 'swap-horizontal', color: '#34d399' },
  general: { texto: 'General', icono: 'information-circle-outline', color: '#fbbf24' },
};

// Ordenados alternando areas, asi el carrusel no muestra varios seguidos de
// lo mismo.
const CONSEJOS: { area: AreaConsejo; icono: keyof typeof Ionicons.glyphMap; texto: string }[] = [
  { area: 'despachos', icono: 'camera-outline', texto: 'Toma la foto de la factura con buena luz y sin sombras: la lectura automática es más precisa.' },
  { area: 'traslados', icono: 'cube-outline', texto: 'Cuenta la mercancía antes de firmar como quien despacha. Una vez firmado, el traslado queda registrado.' },
  { area: 'general', icono: 'cloud-offline-outline', texto: 'Si ves «Sin conexión al servidor», espera a tener señal antes de enviar.' },
  { area: 'despachos', icono: 'scan-outline', texto: 'Antes de confirmar, revisa que el número de factura detectado coincida con el del papel.' },
  { area: 'traslados', icono: 'car-outline', texto: 'El conductor debe revisar la carga antes de firmar: su firma confirma lo que se lleva.' },
  { area: 'general', icono: 'log-out-outline', texto: 'Cierra sesión al terminar tu turno para que nadie trabaje con tu usuario.' },
  { area: 'despachos', icono: 'create-outline', texto: 'Si la lectura automática se equivocó en un producto, corrige el nombre antes de confirmar.' },
  { area: 'traslados', icono: 'alert-circle-outline', texto: 'Al recibir, si algo llegó incompleto o dañado, toca «Con observación» y anota la novedad.' },
  { area: 'general', icono: 'rainy-outline', texto: 'Si va a llover, cubre la carga antes de que el vehículo salga de la bodega.' },
  { area: 'despachos', icono: 'layers-outline', texto: 'Si la entrega es parcial, registra solo lo que sale hoy: lo pendiente queda abierto para la próxima.' },
  { area: 'traslados', icono: 'list-outline', texto: 'Escribe los productos igual que en el papel: cantidad, nombre, marca y presentación.' },
  { area: 'traslados', icono: 'download-outline', texto: 'Revisa «Por recibir» al llegar un vehículo: ahí aparecen los traslados que vienen a tu punto.' },
  { area: 'despachos', icono: 'search-outline', texto: 'Si no tienes la foto a mano, puedes buscar la factura por su número para actualizarla.' },
  { area: 'traslados', icono: 'chatbox-ellipses-outline', texto: 'Usa las observaciones para lo que no está en el papel: horarios, entregas parciales o avisos.' },
  { area: 'general', icono: 'wifi-outline', texto: 'Mira la pastilla de conexión arriba: si dice «Conectado», puedes enviar sin problema.' },
  { area: 'despachos', icono: 'document-text-outline', texto: 'Las remisiones (RM2, RM3 y RSF) se fotografían en la pestaña Remisiones, no en Despachos.' },
  { area: 'traslados', icono: 'location-outline', texto: 'Antes de enviar un traslado, confirma que el punto de destino sea el correcto.' },
  { area: 'general', icono: 'key-outline', texto: 'Tu PIN es personal: no lo compartas con nadie, ni siquiera con un compañero.' },
  { area: 'despachos', icono: 'eye-outline', texto: 'Si la foto sale borrosa, repítela: una foto nítida evita que el documento quede en revisión.' },
  { area: 'traslados', icono: 'add-circle-outline', texto: 'Si llegó más mercancía de la enviada, también es una novedad: regístrala al recibir.' },
  { area: 'general', icono: 'battery-charging-outline', texto: 'Empieza el turno con el celular cargado: la cámara y la conexión gastan batería.' },
  { area: 'despachos', icono: 'scan-circle-outline', texto: 'Fotografía el documento completo, con los cuatro bordes a la vista y sin dedos encima.' },
  { area: 'traslados', icono: 'time-outline', texto: 'Recibe el traslado apenas llegue el vehículo: así el inventario del punto queda al día.' },
  { area: 'despachos', icono: 'repeat-outline', texto: 'Un documento se puede entregar en varias visitas: cada vez vuelve a fotografiarlo y registra lo que sale.' },
  { area: 'despachos', icono: 'copy-outline', texto: 'Si un documento ya se entregó completo, la app te avisará que está duplicado: no hace falta registrarlo otra vez.' },
  { area: 'traslados', icono: 'create-outline', texto: 'Al firmar, hazlo dentro del recuadro y con trazo firme para que la firma se lea bien.' },
  { area: 'general', icono: 'apps-outline', texto: 'Toca los pendientes del Inicio para ir directo a esa sección.' },
];

// Contacto de soporte -- boton de WhatsApp (link wa.me: abre la app si esta
// instalada, si no el navegador). Numero en formato internacional sin "+"
// ni espacios, como lo pide wa.me.
export const SOPORTE = {
  nombre: 'Neider',
  telefonoVisible: '333 253 2220',
  telefonoInternacional: '573332532220',
};

export async function abrirEnlace(url: string, queFallo: string) {
  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert('No se pudo abrir', `No se pudo abrir ${queFallo}. Escribe a ${SOPORTE.nombre} al ${SOPORTE.telefonoVisible}.`);
  }
}

// Indice del consejo con el que arranca el carrusel -- cambia cada dia, asi
// no siempre se ve primero el mismo.
function indiceDelDia(fecha: Date): number {
  const inicioAnio = new Date(fecha.getFullYear(), 0, 0);
  const diaDelAnio = Math.floor((fecha.getTime() - inicioAnio.getTime()) / 86400000);
  return diaDelAnio % CONSEJOS.length;
}

const SEGUNDOS_POR_CONSEJO = 7;

// Preferencias de accesibilidad del sistema: "reducir movimiento" y lector de
// pantalla (TalkBack). Se escuchan los cambios para no pedir reiniciar la app.
function usePreferenciaAccesibilidad(
  consultar: () => Promise<boolean>,
  evento: 'reduceMotionChanged' | 'screenReaderChanged'
): boolean {
  const [activa, setActiva] = useState(false);
  useEffect(() => {
    let vigente = true;
    consultar()
      .then((v) => vigente && setActiva(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener(evento, setActiva);
    return () => {
      vigente = false;
      sub.remove();
    };
  }, [consultar, evento]);
  return activa;
}

export const useReducirMovimiento = () =>
  usePreferenciaAccesibilidad(AccessibilityInfo.isReduceMotionEnabled, 'reduceMotionChanged');

const SEPARACION_LINEAS = 28;

// Fondo del encabezado: lineas diagonales finas, como surcos de un campo.
// Son quietas -- la animacion que tenian (desplazamiento + destello) se quito
// para no dibujar en bucle mientras Inicio esta abierto.
function FondoEncabezado() {
  const { width } = useWindowDimensions();
  const cantidadLineas = Math.ceil((width * 2.4) / SEPARACION_LINEAS);

  return (
    <View style={estilos.animacionEncabezado} pointerEvents="none">
      <View style={[estilos.lineas, { width: width * 2.4, left: -width * 0.7, transform: [{ rotate: '-28deg' }] }]}>
        {Array.from({ length: cantidadLineas }, (_, i) => (
          <View key={i} style={estilos.linea} />
        ))}
      </View>
    </View>
  );
}

// Valor que sube de 0 a 1 y vuelve a empezar -- para los latidos (anillo que
// se expande y se desvanece).
function useLatido(duracion: number, activo: boolean): Animated.Value {
  const valor = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!activo) {
      valor.setValue(0);
      return;
    }
    const bucle = Animated.loop(
      Animated.timing(valor, { toValue: 1, duration: duracion, easing: Easing.out(Easing.quad), useNativeDriver: true })
    );
    bucle.start();
    return () => bucle.stop();
  }, [activo, duracion, valor]);
  return valor;
}

// Entrada escalonada de las secciones: cada una aparece subiendo un poco y
// con fundido, una detras de otra. Con "reducir movimiento" quedan visibles
// de una.
export function useEntrada(cantidad: number, reducirMovimiento: boolean): Animated.Value[] {
  const valores = useRef(Array.from({ length: cantidad }, () => new Animated.Value(0))).current;
  useEffect(() => {
    if (reducirMovimiento) {
      valores.forEach((v) => v.setValue(1));
      return;
    }
    Animated.stagger(
      90,
      valores.map((v) => Animated.spring(v, { toValue: 1, damping: 16, stiffness: 120, mass: 0.9, useNativeDriver: true }))
    ).start();
  }, [reducirMovimiento, valores]);
  return valores;
}

export const estiloEntrada = (v: Animated.Value) => ({
  opacity: v,
  transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
});

// Tarjeta tocable que se "hunde" un poco al presionar (resorte), en vez de
// solo bajar la opacidad.
export function Presionable({
  estilo,
  estiloContenedor,
  children,
  ...props
}: Omit<PressableProps, 'style' | 'children'> & {
  estilo?: StyleProp<ViewStyle>;
  // Estilo del area tocable en si (ej. flex: 1 para repartir el ancho en una
  // fila) -- `estilo` va en la vista animada de adentro.
  estiloContenedor?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const escala = useRef(new Animated.Value(1)).current;
  const animar = (a: number) => Animated.spring(escala, { toValue: a, speed: 40, bounciness: 6, useNativeDriver: true }).start();
  return (
    <Pressable {...props} style={estiloContenedor} onPressIn={() => animar(0.97)} onPressOut={() => animar(1)}>
      <Animated.View style={[estilo, { transform: [{ scale: escala }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

// Pastilla de estado de conexion (tocar re-verifica). Conectado: el punto
// verde late; verificando: el icono gira.
function PastillaConexion({
  conexion,
  onReintentar,
  animar,
}: {
  conexion: EstadoConexion;
  onReintentar: () => void;
  animar: boolean;
}) {
  const info = INFO_CONEXION[conexion];
  const latido = useLatido(1800, animar && conexion === 'conectado');
  const giro = useLatido(1000, animar && conexion === 'verificando');
  return (
    <Presionable
      onPress={onReintentar}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={info.texto}
      accessibilityHint="Toca para volver a verificar la conexión"
      accessibilityLiveRegion="polite"
      estilo={[estilos.pastilla, { borderColor: info.borde }]}
    >
      {conexion === 'verificando' ? (
        <Animated.View
          style={{ transform: [{ rotate: giro.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }}
        >
          <Ionicons name="sync-outline" size={13} color={info.color} />
        </Animated.View>
      ) : (
        <View style={estilos.puntoZona}>
          <Animated.View
            style={[
              estilos.punto,
              {
                backgroundColor: info.color,
                opacity: latido.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
                transform: [{ scale: latido.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }],
              },
            ]}
          />
          <View style={[estilos.punto, { backgroundColor: info.color }]} />
        </View>
      )}
      <Text style={[estilos.pastillaTexto, { color: info.color }]}>{info.corto}</Text>
    </Presionable>
  );
}

const INFO_CONEXION: Record<EstadoConexion, { texto: string; corto: string; color: string; borde: string }> = {
  verificando: { texto: 'Verificando conexión…', corto: 'Verificando…', color: NEUTRAL_400, borde: 'rgba(154,163,181,0.35)' },
  conectado: { texto: 'Conectado al servidor', corto: 'Conectado', color: '#34d399', borde: 'rgba(52,211,153,0.4)' },
  sin_conexion: { texto: 'Sin conexión al servidor', corto: 'Sin conexión · Reintentar', color: '#f87171', borde: 'rgba(248,113,113,0.45)' },
};

// Carrusel de consejos: una barra de progreso se llena en
// SEGUNDOS_POR_CONSEJO y al completarse pasa al siguiente, que entra
// deslizandose con fundido (Animated del core, sin librerias); tocar adelanta
// uno. Se pausa cuando Inicio no esta en pantalla (useIsFocused) para no
// trabajar de fondo. Con "reducir movimiento" cambia sin deslizar, y con
// lector de pantalla no avanza solo (el texto cambiaria mientras se esta
// leyendo): se adelanta tocando.
function CarruselConsejos({ reducirMovimiento }: { reducirMovimiento: boolean }) {
  const enPantalla = useIsFocused();
  const lectorPantalla = usePreferenciaAccesibilidad(AccessibilityInfo.isScreenReaderEnabled, 'screenReaderChanged');
  const [indice, setIndice] = useState(() => indiceDelDia(new Date()));
  const [anchoBarra, setAnchoBarra] = useState(0);
  // -1 = entrando desde la derecha, 0 = visible, 1 = saliendo a la izquierda.
  const transicion = useRef(new Animated.Value(0)).current;
  const progreso = useRef(new Animated.Value(0)).current;

  const avanzar = useCallback(() => {
    if (reducirMovimiento) {
      setIndice((i) => (i + 1) % CONSEJOS.length);
      return;
    }
    Animated.timing(transicion, { toValue: 1, duration: 200, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(() => {
      setIndice((i) => (i + 1) % CONSEJOS.length);
      transicion.setValue(-1);
      Animated.spring(transicion, { toValue: 0, damping: 18, stiffness: 160, useNativeDriver: true }).start();
    });
  }, [transicion, reducirMovimiento]);

  // La barra arranca de cero en cada consejo (tambien al tocar), asi uno
  // recien adelantado a mano se ve los segundos completos.
  useEffect(() => {
    progreso.setValue(0);
    if (!enPantalla || lectorPantalla) return;
    const llenado = Animated.timing(progreso, {
      toValue: 1,
      duration: SEGUNDOS_POR_CONSEJO * 1000,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    llenado.start(({ finished }) => {
      if (finished) avanzar();
    });
    return () => llenado.stop();
  }, [indice, enPantalla, lectorPantalla, avanzar, progreso]);

  const consejo = CONSEJOS[indice];
  const area = AREAS_CONSEJO[consejo.area];
  const estiloTransicion = {
    opacity: transicion.interpolate({ inputRange: [-1, 0, 1], outputRange: [0, 1, 0] }),
    transform: [{ translateX: transicion.interpolate({ inputRange: [-1, 0, 1], outputRange: [18, 0, -18] }) }],
  };

  return (
    <Presionable
      onPress={avanzar}
      accessibilityRole="button"
      accessibilityLabel={`Consejo ${indice + 1} de ${CONSEJOS.length}, ${area.texto}: ${consejo.texto}`}
      accessibilityHint="Toca para ver el siguiente consejo"
      estilo={[estilos.tarjeta, estilos.consejoTarjeta]}
    >
      <View style={estilos.consejoEncabezado}>
        <View style={estilos.consejoIconoBombilla}>
          <Ionicons name="bulb" size={12} color={MARCA.oro} />
        </View>
        <Text style={estilos.consejoEtiqueta}>Consejo</Text>
        <Animated.View style={[estilos.chipArea, { borderColor: area.color }, estiloTransicion]}>
          <Ionicons name={area.icono} size={12} color={area.color} />
          <Text style={[estilos.chipAreaTexto, { color: area.color }]}>{area.texto}</Text>
        </Animated.View>
        <Text style={estilos.consejoContador}>
          {indice + 1}/{CONSEJOS.length}
        </Text>
      </View>

      <Animated.View style={[estilos.consejoFila, estiloTransicion]}>
        <View style={[estilos.consejoIcono, { backgroundColor: `${area.color}1f` }]}>
          <Ionicons name={consejo.icono} size={18} color={area.color} />
        </View>
        <Text style={estilos.consejoTexto}>{consejo.texto}</Text>
      </Animated.View>

      {/* Barra de tiempo hasta el siguiente consejo (decorativa para
          TalkBack; con lector de pantalla queda vacia porque no avanza solo). */}
      <View
        style={estilos.barraFondo}
        onLayout={(e) => setAnchoBarra(e.nativeEvent.layout.width)}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <Animated.View
          style={[
            estilos.barraRelleno,
            {
              backgroundColor: area.color,
              width: anchoBarra,
              transform: [{ translateX: progreso.interpolate({ inputRange: [0, 1], outputRange: [-anchoBarra, 0] }) }],
            },
          ]}
        />
      </View>
    </Presionable>
  );
}

// Lo registrado hoy por el bodeguero en su sede, como cifras dentro del
// encabezado -- solo bodega (los puntos no registran documentos).
// Se recarga cada vez que se vuelve a Inicio; si falla la red no se muestra
// (mismo criterio que Pendientes).
function CifrasHoy() {
  const { sesion } = useSesion();
  const [resumen, setResumen] = useState<{ despachos: number; remisiones: number } | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (sesion.tipo !== 'bodega') return;
      let vigente = true;
      fetchResumenHoy(sesion.empleado.id, sesion.sede.id)
        .then((r) => vigente && setResumen(r))
        .catch(() => vigente && setResumen(null));
      return () => {
        vigente = false;
      };
    }, [sesion])
  );

  if (sesion.tipo !== 'bodega' || !resumen) return null;

  const cifras: { clave: string; numero: number; etiqueta: string; icono: keyof typeof Ionicons.glyphMap }[] = [
    { clave: 'despachos', numero: resumen.despachos, etiqueta: 'Despachos hoy', icono: 'cube-outline' },
  ];
  if (tieneAcceso(sesion, 'Remisiones')) {
    cifras.push({ clave: 'remisiones', numero: resumen.remisiones, etiqueta: 'Remisiones hoy', icono: 'document-text-outline' });
  }

  return (
    <View style={estilos.cifras} accessibilityLabel={`Lo que registraste hoy: ${cifras.map((c) => `${c.numero} ${c.etiqueta}`).join(', ')}`}>
      {cifras.map((c) => (
        <View key={c.clave} style={estilos.cifra}>
          <View style={estilos.cifraFila}>
            <Ionicons name={c.icono} size={15} color={MARCA.oro} />
            <Text style={estilos.cifraEtiqueta}>{c.etiqueta}</Text>
          </View>
          <Text style={estilos.cifraNumero}>{c.numero}</Text>
        </View>
      ))}
    </View>
  );
}

// Un mosaico de Pendientes: que falta, cuantos y a donde lleva tocarlo.
type Pendiente = {
  clave: string;
  texto: string;
  cantidad: number;
  icono: keyof typeof Ionicons.glyphMap;
  abrir: (nav: BottomTabNavigationProp<TabsParamList>) => void;
};

// Lo pendiente del area de la sesion, con los mismos endpoints que usan esas
// pantallas (bandeja de recepcion, novedades) salvo bodega, que usa su propio
// conteo (GET /entregas/pendientes) para no bajar todas las entregas.
// Bodega: estado de las facturas que su sede reporto como no subidas al punto
// de venta (ver PantallaFacturasFaltantes.tsx) -- las que siguen esperando y
// las que el mostrador ya subio en las ultimas 24 h. Informativo: se muestran
// siempre, aunque esten en 0. Reemplaza a los antiguos "Despachos/Remisiones
// por entregar".
async function filasBodega(sedeId: string): Promise<Pendiente[]> {
  const [reportadas, subidas] = await Promise.all([
    fetchFacturasFaltantes(sedeId, { vista: 'sede' }),
    fetchFacturasYaSubidas(sedeId),
  ]);
  const abrir = (nav: BottomTabNavigationProp<TabsParamList>) =>
    nav.navigate('Despachos', { screen: 'FacturasFaltantes' });
  return [
    {
      clave: 'facturas_sin_subir',
      texto: 'Facturas sin subir',
      // Solo las que reporto esta sede (vista 'sede' tambien trae las que
      // otra sede le reporto a esta, que son tarea de su mostrador).
      cantidad: reportadas.filter((f) => (f.sede_reporta_id ?? f.sede_id) === sedeId).length,
      icono: 'hourglass-outline',
      abrir,
    },
    {
      clave: 'facturas_ya_subidas',
      texto: 'Ya subidas (24 h)',
      cantidad: subidas.length,
      icono: 'checkmark-done-outline',
      abrir,
    },
  ];
}

// Mostrador (punto_venta): no despacha, pero si tiene algo pendiente propio --
// las facturas que los bodegueros de su sede reportaron como no subidas.
async function filasMostrador(sedeId: string): Promise<Pendiente[]> {
  const lista = await fetchFacturasFaltantes(sedeId, { vista: 'destino' });
  return [
    {
      clave: 'facturas_por_subir',
      texto: 'Facturas por subir',
      cantidad: lista.length,
      icono: 'document-text-outline',
      abrir: (nav) => nav.navigate('Despachos', { screen: 'Captura' }),
    },
  ];
}

async function cargarPendientes(sesion: Sesion): Promise<Pendiente[]> {
  switch (sesion.tipo) {
    case 'bodega':
      if (sesion.empleado.rol === 'punto_venta') return filasMostrador(sesion.sede.id);
      return filasBodega(sesion.sede.id);
    case 'punto': {
      const lista = await fetchTrasladosPunto({ destinoId: sesion.punto.id, estado: 'en_transito' });
      return [
        {
          clave: 'por_recibir',
          texto: 'Traslados por recibir',
          cantidad: lista.length,
          icono: 'download-outline',
          // initial: false -- deja InicioTraslados debajo, para que "volver"
          // desde la bandeja no saque de la tab.
          abrir: (nav) => nav.navigate('TrasladosPuntos', { screen: 'BandejaRecepcion', initial: false }),
        },
      ];
    }
  }
}

// Pendientes del area como mosaicos -- se recargan cada vez que se vuelve a
// Inicio. Si falla la red no se muestra nada: el aviso de conexion de arriba
// ya lo explica, no hace falta un segundo error.
function Pendientes() {
  const { sesion } = useSesion();
  const navigation = useNavigation<BottomTabNavigationProp<TabsParamList>>();
  const [pendientes, setPendientes] = useState<Pendiente[] | null>(null);
  useFocusEffect(
    useCallback(() => {
      // Los mostradores (rol punto_venta) facturan, no despachan: no ven los
      // pendientes de entrega, solo "Facturas por subir" (ver cargarPendientes).
      // Sin avisos pendientes (cantidad 0) tampoco se muestra nada.
      let vigente = true;
      cargarPendientes(sesion)
        .then((filas) => {
          if (!vigente) return;
          const esMostrador = sesion.tipo === 'bodega' && sesion.empleado.rol === 'punto_venta';
          // El mostrador solo ve la fila si hay algo por subir; el resto de
          // sesiones muestra siempre sus filas (aunque sean 0).
          setPendientes(esMostrador ? filas.filter((f) => f.cantidad > 0) : filas);
        })
        .catch(() => vigente && setPendientes(null));
      return () => {
        vigente = false;
      };
    }, [sesion])
  );

  if (!pendientes || pendientes.length === 0) return null;

  return (
    <View style={estilos.seccion}>
      <Text style={estilos.tituloSeccion}>Pendientes</Text>
      <View style={estilos.mosaicos}>
        {pendientes.map((p) => {
          const hay = p.cantidad > 0;
          return (
            <Presionable
              key={p.clave}
              onPress={() => p.abrir(navigation)}
              accessibilityRole="button"
              accessibilityLabel={`${p.texto}: ${p.cantidad}`}
              // Fila compacta a todo el ancho: icono, texto, numero y flecha.
              estiloContenedor={estilos.mosaicoTocable}
              estilo={[estilos.mosaico, hay && estilos.mosaicoConPendientes]}
            >
              <View style={estilos.mosaicoFila}>
                <View style={[estilos.mosaicoIcono, hay && estilos.mosaicoIconoActivo]}>
                  <Ionicons name={p.icono} size={15} color={hay ? MARCA.tinta : NEUTRAL_400} />
                </View>
                <Text style={estilos.mosaicoTexto} numberOfLines={2}>
                  {p.texto}
                </Text>
                <Text style={[estilos.mosaicoNumero, !hay && estilos.mosaicoNumeroCero]}>{p.cantidad}</Text>
                <Ionicons name="arrow-forward" size={16} color={hay ? MARCA.oro : NEUTRAL_400} />
              </View>
            </Presionable>
          );
        })}
      </View>
    </View>
  );
}

export default function PantallaInicio() {
  const insets = useSafeAreaInsets();
  const enPantalla = useIsFocused();
  const reducirMovimiento = useReducirMovimiento();
  const animar = enPantalla && !reducirMovimiento;
  const [ahora, setAhora] = useState(() => new Date());
  const [conexion, setConexion] = useState<EstadoConexion>('verificando');
  const entrada = useEntrada(4, reducirMovimiento);
  const { sesion } = useSesion();
  const lugar = lugarSesion(sesion);

  // Se refresca cada minuto -- para que el saludo y la fecha cambien solos si
  // la app queda abierta al pasar el mediodia o la medianoche.
  useEffect(() => {
    const id = setInterval(() => setAhora(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  const verificarConexion = useCallback(async () => {
    setConexion('verificando');
    const controlador = new AbortController();
    const limite = setTimeout(() => controlador.abort(), 8000);
    try {
      const res = await fetch(`${API_BASE_URL}/health`, { signal: controlador.signal });
      setConexion(res.ok ? 'conectado' : 'sin_conexion');
    } catch {
      setConexion('sin_conexion');
    } finally {
      clearTimeout(limite);
    }
  }, []);

  // Cada vez que se vuelve a Inicio se re-chequea (ej. el celular recupero
  // senal mientras estaba en otra tab).
  useFocusEffect(
    useCallback(() => {
      verificarConexion();
    }, [verificarConexion])
  );

  const { texto: textoSaludo, icono: iconoSaludo } = saludo(ahora.getHours());
  const dia = DIAS[ahora.getDay()];

  const abrirWhatsapp = () =>
    abrirEnlace(
      `https://wa.me/${SOPORTE.telefonoInternacional}?text=${encodeURIComponent(`Hola ${SOPORTE.nombre}, necesito ayuda con la app de despachos.`)}`,
      'WhatsApp'
    );

  return (
    <View style={estilos.contenedor}>
      <ScrollView contentContainerStyle={estilos.scroll} showsVerticalScrollIndicator={false} bounces={false}>
        {/* Encabezado en degradado con los colores del logo. */}
        <Animated.View style={estiloEntrada(entrada[0])}>
          <LinearGradient
            colors={[MARCA.cielo, MARCA.azul]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[estilos.encabezado, { paddingTop: insets.top + 14 }]}
          >
            <FondoEncabezado />

            <View style={estilos.barraSuperior}>
              <Text style={estilos.marca} numberOfLines={1}>
                Comercializadora El Imperio
              </Text>
              <PastillaConexion conexion={conexion} onReintentar={verificarConexion} animar={animar} />
            </View>

            {/* Saludo y sede a la izquierda, calendario a la derecha. */}
            <View style={estilos.filaPrincipal}>
              <View style={estilos.columnaSaludo}>
                <View style={estilos.filaSaludo}>
                  <Ionicons name={iconoSaludo} size={26} color={MARCA.oro} />
                  <Text style={estilos.saludo} accessibilityRole="header">
                    {textoSaludo}
                  </Text>
                </View>
                <Text style={estilos.fecha}>{dia.charAt(0).toUpperCase() + dia.slice(1)}</Text>
                <View style={estilos.chipLugar}>
                  <Ionicons name={lugar.icono} size={14} color={MARCA.oro} />
                  <Text style={estilos.chipLugarTexto} numberOfLines={1}>
                    {lugar.texto}
                  </Text>
                </View>
              </View>
              <View
                style={estilos.calendario}
                accessibilityLabel={`${dia} ${ahora.getDate()} de ${MESES[ahora.getMonth()]}`}
              >
                <Text style={estilos.calendarioMes}>{MESES[ahora.getMonth()].slice(0, 3)}</Text>
                <Text style={estilos.calendarioDia}>{ahora.getDate()}</Text>
              </View>
            </View>

            <CifrasHoy />
          </LinearGradient>
        </Animated.View>

        <View style={estilos.cuerpo}>
          <Animated.View style={[estilos.seccion, estiloEntrada(entrada[1])]}>
            {conexion === 'sin_conexion' ? (
              // Aviso visible solo cuando hace falta: sin servidor no se puede
              // enviar nada, mejor saberlo antes de entrar a un area.
              <Presionable
                onPress={verificarConexion}
                accessibilityRole="button"
                accessibilityLabel="No hay conexión con el servidor. Espera a tener señal antes de enviar."
                accessibilityHint="Toca para volver a verificar la conexión"
                estilo={estilos.avisoSinConexion}
              >
                <Ionicons name="cloud-offline-outline" size={20} color="#f87171" />
                <Text style={estilos.avisoSinConexionTexto}>
                  No hay conexión con el servidor. Espera a tener señal antes de enviar.
                </Text>
                <Ionicons name="refresh" size={18} color="#f87171" />
              </Presionable>
            ) : null}

            {/* Talonario del punto: solo en sesiones de punto (traslados). */}
            {sesion.tipo === 'punto' ? (
              <TarjetaTalonario puntoId={sesion.punto.id} usuarioId={sesion.usuario.id} />
            ) : null}

            <Pendientes />
          </Animated.View>

          <Animated.View style={[estilos.seccion, estiloEntrada(entrada[2])]}>
            <CarruselConsejos reducirMovimiento={reducirMovimiento} />
          </Animated.View>

          <Animated.View style={[estilos.seccion, estiloEntrada(entrada[3])]}>
            {/* Soporte en una sola fila, con el boton de WhatsApp a la derecha. */}
            <Presionable
              onPress={abrirWhatsapp}
              accessibilityRole="button"
              accessibilityLabel="¿Algo no funciona? Escríbele a soporte por WhatsApp"
              estilo={[estilos.tarjeta, estilos.soporte]}
            >
              <View style={estilos.soporteIcono}>
                <Ionicons name="headset-outline" size={20} color={MARCA.oro} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={estilos.soporteTitulo}>¿Algo no funciona?</Text>
                <Text style={estilos.soporteTexto}>Escríbele a soporte por WhatsApp</Text>
              </View>
              <View style={estilos.botonWhatsapp}>
                <Ionicons name="logo-whatsapp" size={22} color="#ffffff" />
              </View>
            </Presionable>

            {/* Pie: indicacion para empezar + version, discretos, justo arriba
                del menu de tabs. */}
            <View style={estilos.pie}>
              <View style={estilos.pieIndicacion}>
                <Text style={estilos.pieIndicacionTexto}>Elige tu área en el menú de abajo</Text>
                <Ionicons name="arrow-down" size={14} color={MARCA.oro} />
              </View>
              <Text style={estilos.version}>{textoActualizacion()}</Text>
            </View>
          </Animated.View>
        </View>
      </ScrollView>
    </View>
  );
}

const estilos = StyleSheet.create({
  contenedor: { flex: 1, backgroundColor: MARCA.noche },
  scroll: { flexGrow: 1, paddingBottom: 20 },
  cuerpo: { paddingHorizontal: 18, paddingTop: 20, gap: 22 },
  seccion: { gap: 12 },
  tituloSeccion: { color: TEXTO_PRIMARIO, fontSize: 18, fontFamily: FUENTE_DISPLAY },

  // Encabezado: degradado con esquinas de abajo redondeadas.
  encabezado: {
    paddingHorizontal: 20,
    paddingBottom: 26,
    gap: 10,
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    overflow: 'hidden',
  },
  animacionEncabezado: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  // Grupo de lineas: mas grande que la tarjeta para que, girado, la cubra
  // entera; la tarjeta recorta lo que sobra (overflow hidden).
  lineas: {
    position: 'absolute',
    top: '-60%',
    height: '220%',
    flexDirection: 'row',
    gap: SEPARACION_LINEAS - 1.5,
  },
  linea: { width: 1.5, height: '100%', backgroundColor: 'rgba(255,255,255,0.06)' },
  barraSuperior: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  marca: {
    flexShrink: 1,
    color: 'rgba(245,243,239,0.85)',
    fontSize: 12.5,
    fontFamily: FUENTE_BODY_BOLD,
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  pastilla: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
    backgroundColor: VIDRIO_ENCABEZADO,
  },
  pastillaTexto: { fontSize: 13, fontFamily: FUENTE_BODY_SEMI },
  puntoZona: { width: 8, height: 8, alignItems: 'center', justifyContent: 'center' },
  punto: { position: 'absolute', width: 8, height: 8, borderRadius: 4 },

  filaPrincipal: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 16 },
  columnaSaludo: { flex: 1, gap: 6 },
  filaSaludo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  saludo: { flexShrink: 1, color: TEXTO_PRIMARIO, fontSize: 30, fontFamily: FUENTE_DISPLAY },
  fecha: { color: 'rgba(245,243,239,0.8)', fontSize: 15, fontFamily: FUENTE_BODY_SEMI },
  // Hoja de calendario: mes en dorado arriba, dia grande abajo.
  calendario: {
    width: 74,
    paddingVertical: 10,
    borderRadius: 20,
    alignItems: 'center',
    backgroundColor: VIDRIO_ENCABEZADO,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  calendarioMes: { color: MARCA.oro, fontSize: 13, fontFamily: FUENTE_BODY_BOLD, textTransform: 'uppercase', letterSpacing: 1 },
  calendarioDia: { color: TEXTO_PRIMARIO, fontSize: 32, fontFamily: FUENTE_DISPLAY, lineHeight: 36 },
  chipLugar: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: VIDRIO_ENCABEZADO,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  chipLugarTexto: { flexShrink: 1, color: TEXTO_PRIMARIO, fontSize: 14, fontFamily: FUENTE_BODY_SEMI },
  // Cifras de hoy: recuadros de vidrio con el numero grande en dorado.
  cifras: { flexDirection: 'row', gap: 10, marginTop: 8 },
  cifra: {
    flex: 1,
    gap: 2,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 18,
    backgroundColor: VIDRIO_ENCABEZADO,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  cifraFila: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cifraEtiqueta: { color: 'rgba(245,243,239,0.85)', fontSize: 13, fontFamily: FUENTE_BODY_SEMI },
  cifraNumero: { color: MARCA.oro, fontSize: 30, fontFamily: FUENTE_DISPLAY, lineHeight: 34 },

  tarjeta: {
    gap: 12,
    padding: 18,
    borderRadius: 22,
    backgroundColor: SUPERFICIE,
    borderWidth: 1,
    borderColor: BORDE_SUPERFICIE,
  },
  avisoSinConexion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: 18,
    backgroundColor: 'rgba(248,113,113,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.4)',
  },
  avisoSinConexionTexto: { flex: 1, color: '#fca5a5', fontSize: 14, fontFamily: FUENTE_BODY },

  // Pendientes: mosaicos en dos columnas (uno solo ocupa todo el ancho).
  mosaicos: { gap: 8 },
  mosaicoTocable: { width: '100%' },
  mosaico: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: SUPERFICIE,
    borderWidth: 1,
    borderColor: BORDE_SUPERFICIE,
  },
  mosaicoConPendientes: { borderColor: 'rgba(245,197,66,0.45)' },
  mosaicoFila: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mosaicoIcono: {
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mosaicoIconoActivo: { backgroundColor: MARCA.oro },
  mosaicoNumero: { color: MARCA.oro, fontSize: 20, fontFamily: FUENTE_DISPLAY, lineHeight: 24 },
  // Cero pendientes = todo al dia: verde de la marca, una buena noticia.
  mosaicoNumeroCero: { color: MARCA.verde },
  mosaicoTexto: { flex: 1, color: TEXTO_PRIMARIO, fontSize: 13, fontFamily: FUENTE_BODY_SEMI, lineHeight: 17 },

  // Consejo: franja dorada a la izquierda para distinguirlo del resto.
  consejoTarjeta: { borderLeftWidth: 4, borderLeftColor: MARCA.oro, gap: 8, padding: 12, borderRadius: 16 },
  consejoEncabezado: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  consejoIconoBombilla: {
    width: 20,
    height: 20,
    borderRadius: 7,
    backgroundColor: 'rgba(245,197,66,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  consejoEtiqueta: { color: MARCA.oro, fontSize: 12, fontFamily: FUENTE_BODY_SEMI, textTransform: 'uppercase', letterSpacing: 0.6 },
  chipArea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: 1,
  },
  chipAreaTexto: { fontSize: 12.5, fontFamily: FUENTE_BODY_SEMI },
  consejoContador: { marginLeft: 'auto', color: NEUTRAL_400, fontSize: 13, fontFamily: FUENTE_BODY_SEMI },
  // Alto minimo fijo: los consejos tienen largos distintos y sin esto la
  // tarjeta "saltaria" de alto en cada cambio.
  consejoFila: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 60 },
  consejoIcono: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  consejoTexto: { flex: 1, color: TEXTO_PRIMARIO, fontSize: 14, fontFamily: FUENTE_BODY, lineHeight: 20 },
  barraFondo: { height: 3, borderRadius: 2, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.08)' },
  barraRelleno: { height: 3, borderRadius: 2 },

  soporte: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  soporteIcono: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: 'rgba(245,197,66,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  soporteTitulo: { color: TEXTO_PRIMARIO, fontSize: 15, fontFamily: FUENTE_BODY_SEMI },
  soporteTexto: { color: NEUTRAL_400, fontSize: 13.5, fontFamily: FUENTE_BODY },
  botonWhatsapp: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#1faa59',
    alignItems: 'center',
    justifyContent: 'center',
  },

  pie: { alignItems: 'center', gap: 6, paddingTop: 8 },
  pieIndicacion: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pieIndicacionTexto: { color: NEUTRAL_400, fontSize: 14, fontFamily: FUENTE_BODY_SEMI },
  version: { color: NEUTRAL_400, fontSize: 12.5, fontFamily: FUENTE_BODY },
});
