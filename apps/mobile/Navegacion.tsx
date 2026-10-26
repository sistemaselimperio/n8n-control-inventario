// Navegacion animada -- reemplaza el switch manual por fase que antes vivia
// en App.tsx/PantallaCaptura. Tres niveles:
//   Root: Entrada (sin sesion, ver PantallaEntrada.tsx) | Principal (tabs).
//     La sesion es UNA sola para toda la app (ver SesionContext.tsx): se
//     entra una vez y cambiar de tab no vuelve a pedir PIN.
//   Tabs (barra abajo): Inicio | Despachos | TrasladosPuntos | Remisiones
//     Todas se ven siempre; las que la sesion no puede usar muestran
//     SinAcceso.tsx en vez de su stack real (ver tieneAcceso).
//     -> Despachos y Remisiones: stack Captura, Buscar, Confirmando,
//        Resultado (mismo stack, ver FlujoFoto).
// Los ParamList se declaran aca (y no en EntregaContext.tsx) porque son el
// tipo "de arriba hacia abajo": los consumen las pantallas y EntregaContext.tsx
// via import type (sin dependencia de runtime, se borra en compilacion).
import { useCallback, useMemo, useState } from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { NavigatorScreenParams } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import type { Flujo } from './api';
import { EntregaProvider } from './EntregaContext';
import { CalabazasBorde, DecoracionTabs } from './halloween';
import { TrasladoProvider } from './TrasladoContext';
import { SesionProvider, tieneAcceso, useSesion, type AreaApp, type Sesion } from './SesionContext';
import PantallaEntrada from './PantallaEntrada';
import SinAcceso from './SinAcceso';
import PantallaCapturaFoto from './PantallaCapturaFoto';
import PantallaBuscar from './PantallaBuscar';
import PantallaConfirmando from './PantallaConfirmando';
import PantallaResultado from './PantallaResultado';
import PantallaFacturasFaltantes from './PantallaFacturasFaltantes';
import PantallaTrasladoInicio from './PantallaTrasladoInicio';
import PantallaTrasladoNuevo from './PantallaTrasladoNuevo';
import PantallaTrasladoFirmaTransportador from './PantallaTrasladoFirmaTransportador';
import PantallaTrasladoResultado from './PantallaTrasladoResultado';
import PantallaTrasladoBandeja from './PantallaTrasladoBandeja';
import PantallaTrasladoRecepcion from './PantallaTrasladoRecepcion';
import PantallaTrasladoDetalle from './PantallaTrasladoDetalle';
import PantallaNovedadesSupervision from './PantallaNovedadesSupervision';
import PantallaNovedadDetalle from './PantallaNovedadDetalle';
import PantallaTrasladosSyscafe from './PantallaTrasladosSyscafe';
import PantallaInicio from './PantallaInicio';
import { FUENTE_BODY_BOLD, useEstiloTabBar } from './tema';
import { MARCA } from './vidrio';

export type DespachosStackParamList = {
  Captura: undefined;
  Buscar: undefined;
  Confirmando: undefined;
  Resultado: { mensaje: string };
  FacturasFaltantes: undefined;
};

// InicioTraslados -> NuevoTraslado -> FirmaTransportador -> ResultadoTraslado
// es el camino de CREAR un traslado (bodega origen); BandejaRecepcion ->
// RecepcionTraslado es el de RECIBIRLO (bodega destino) -- las dos ramas
// cuelgan de InicioTraslados, no una de la otra.
// NovedadesSupervision -> NovedadDetalle es el camino de Supervision (Erika
// revisando y resolviendo novedades, ver TrasladoContext.tsx RolTraslados) --
// rama totalmente aparte, sin nada colgando de InicioTraslados. TrasladosSyscafe
// (lista del numero Syscafe) -> DetalleTraslado es la otra rama de Supervision.
export type TrasladosStackParamList = {
  InicioTraslados: undefined;
  NuevoTraslado: undefined;
  FirmaTransportador: undefined;
  ResultadoTraslado: { referencia: string; directo?: boolean };
  BandejaRecepcion: undefined;
  RecepcionTraslado: { trasladoId: string };
  DetalleTraslado: { trasladoId: string };
  NovedadesSupervision: undefined;
  NovedadDetalle: { trasladoId: string };
  TrasladosSyscafe: undefined;
};

export type TabsParamList = {
  Inicio: undefined;
  Despachos: NavigatorScreenParams<DespachosStackParamList>;
  TrasladosPuntos: NavigatorScreenParams<TrasladosStackParamList>;
  Remisiones: NavigatorScreenParams<DespachosStackParamList>;
};

type RootStackParamList = {
  Entrada: undefined;
  Principal: NavigatorScreenParams<TabsParamList>;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabsParamList>();
// Un solo tipo de stack para Despachos y Remisiones (mismas pantallas); cada
// tab instancia su propio Navigator, asi que el estado de navegacion no se
// comparte.
const DespachosStack = createNativeStackNavigator<DespachosStackParamList>();
const TrasladosStack = createNativeStackNavigator<TrasladosStackParamList>();

// Titulo e icono de cada area -- los usan la barra de tabs y SinAcceso.
const AREAS: Record<AreaApp, { titulo: string; icono: keyof typeof Ionicons.glyphMap }> = {
  Despachos: { titulo: 'Despachos', icono: 'cube-outline' },
  TrasladosPuntos: { titulo: 'Traslados', icono: 'swap-horizontal' },
  Remisiones: { titulo: 'Remisiones', icono: 'document-text-outline' },
};

// Flujo de foto de bodega (Despachos: factura/traslado; Remisiones: RM2/RM3/RSF).
// `flujo` define la tab; la sesion (empleado + sede) llega del login unico.
//
// EntregaProvider va en el `layout` del Navigator -- NO como hijo de el.
// @react-navigation/core recorre los `children` de un Navigator con
// getRouteConfigsFromChildren, que solo acepta Screen, Group o
// React.Fragment; cualquier otro elemento tira "A navigator can only contain
// 'Screen', 'Group' or 'React.Fragment' as its direct children" en runtime.
// `layout` ademas le pasa el `navigation` de ESTE stack, que es el que
// reiniciar() necesita para volver a Captura sin tocar las otras tabs.
function FlujoFoto({ flujo, area }: { flujo: Flujo; area: AreaApp }) {
  const { sesion, cerrarSesion } = useSesion();

  if (sesion.tipo !== 'bodega' || !tieneAcceso(sesion, area)) {
    return <SinAcceso titulo={AREAS[area].titulo} icono={AREAS[area].icono} />;
  }

  return (
    <DespachosStack.Navigator
      screenOptions={{ headerShown: false }}
      layout={({ children, navigation }) => (
        <EntregaProvider
          navigation={navigation}
          empleado={sesion.empleado}
          sede={sesion.sede}
          cerrarSesion={cerrarSesion}
          flujo={flujo}
        >
          {children}
        </EntregaProvider>
      )}
    >
      <DespachosStack.Screen name="Captura" component={PantallaCapturaFoto} />
      <DespachosStack.Screen name="Buscar" component={PantallaBuscar} />
      <DespachosStack.Screen name="Confirmando" component={PantallaConfirmando} />
      <DespachosStack.Screen name="Resultado" component={PantallaResultado} />
      <DespachosStack.Screen name="FacturasFaltantes" component={PantallaFacturasFaltantes} />
    </DespachosStack.Navigator>
  );
}

const Despachos = () => <FlujoFoto flujo="despacho" area="Despachos" />;
const Remisiones = () => <FlujoFoto flujo="remision" area="Remisiones" />;

// Flujo de traslados entre puntos -- mismo patron que FlujoFoto (Provider en
// el `layout` del Navigator). La sesion puede ser de un punto o de
// Supervision; el stack entero cambia de pantallas segun cual sea (ver el
// JSX mas abajo), nunca se mezclan.
function Traslados() {
  const { sesion, cerrarSesion } = useSesion();

  if (sesion.tipo === 'bodega' || !tieneAcceso(sesion, 'TrasladosPuntos')) {
    return <SinAcceso titulo={AREAS.TrasladosPuntos.titulo} icono={AREAS.TrasladosPuntos.icono} />;
  }

  return (
    <TrasladosStack.Navigator
      screenOptions={{ headerShown: false }}
      layout={({ children, navigation }) => (
        <TrasladoProvider
          navigation={navigation}
          rol={sesion.tipo}
          usuario={sesion.tipo === 'punto' ? sesion.usuario : null}
          punto={sesion.tipo === 'punto' ? sesion.punto : null}
          supervisor={sesion.tipo === 'supervision' ? sesion.supervisor : null}
          cerrarSesion={cerrarSesion}
        >
          {children}
        </TrasladoProvider>
      )}
    >
      {sesion.tipo === 'supervision' ? (
        <>
          <TrasladosStack.Screen name="NovedadesSupervision" component={PantallaNovedadesSupervision} />
          <TrasladosStack.Screen name="NovedadDetalle" component={PantallaNovedadDetalle} />
          <TrasladosStack.Screen name="TrasladosSyscafe" component={PantallaTrasladosSyscafe} />
          <TrasladosStack.Screen name="DetalleTraslado" component={PantallaTrasladoDetalle} />
        </>
      ) : (
        <>
          <TrasladosStack.Screen name="InicioTraslados" component={PantallaTrasladoInicio} />
          <TrasladosStack.Screen name="NuevoTraslado" component={PantallaTrasladoNuevo} />
          <TrasladosStack.Screen name="FirmaTransportador" component={PantallaTrasladoFirmaTransportador} />
          <TrasladosStack.Screen name="ResultadoTraslado" component={PantallaTrasladoResultado} />
          <TrasladosStack.Screen name="BandejaRecepcion" component={PantallaTrasladoBandeja} />
          <TrasladosStack.Screen name="RecepcionTraslado" component={PantallaTrasladoRecepcion} />
          <TrasladosStack.Screen name="DetalleTraslado" component={PantallaTrasladoDetalle} />
        </>
      )}
    </TrasladosStack.Navigator>
  );
}

// Colores de la barra de tabs -- paleta del logo (ver MARCA en vidrio.tsx).
const TAB_INACTIVA = 'rgba(245,243,239,0.55)';

// Icono de una tab: el activo va relleno y en dorado; los inactivos, de
// contorno y en gris claro. `nombre` es la version de contorno
// ("home-outline"); la rellena es el mismo nombre sin el sufijo, cuando
// existe (ej. "swap-horizontal" no tiene variante de contorno).
function IconoTab({ nombre, activa }: { nombre: keyof typeof Ionicons.glyphMap; activa: boolean }) {
  const relleno = nombre.replace(/-outline$/, '') as keyof typeof Ionicons.glyphMap;
  return <Ionicons name={activa ? relleno : nombre} size={22} color={activa ? MARCA.oro : TAB_INACTIVA} />;
}

// Fondo de la barra: degradado azul -> azul noche, los colores del logo. Encima,
// la decoracion de temporada (solo en Halloween, ver halloween.tsx).
const FondoTabs = () => (
  <>
    <LinearGradient colors={[MARCA.azul, MARCA.noche]} style={StyleSheet.absoluteFill} />
    <DecoracionTabs />
  </>
);

function TabsPrincipales() {
  const estiloTabBar = useEstiloTabBar();
  // El icono de la tab es siempre el de la seccion, tenga o no acceso la
  // sesion -- el aviso de "sin acceso" vive solo dentro de la tab (SinAcceso).
  const opcionesArea = (area: AreaApp) => ({
    title: AREAS[area].titulo,
    tabBarIcon: ({ focused }: { focused: boolean }) => <IconoTab nombre={AREAS[area].icono} activa={focused} />,
  });

  return (
    <Tabs.Navigator
      // Inicio es lo primero que se ve al entrar -- portada con el logo (ver
      // PantallaInicio.tsx).
      initialRouteName="Inicio"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: MARCA.oro,
        tabBarInactiveTintColor: TAB_INACTIVA,
        tabBarStyle: estiloTabBar,
        tabBarBackground: FondoTabs,
        // La tab activa queda dentro de un recuadro redondeado con un brillo
        // dorado suave (icono + nombre).
        tabBarActiveBackgroundColor: 'rgba(245,197,66,0.14)',
        tabBarItemStyle: { borderRadius: 16, marginHorizontal: 5, marginVertical: 5 },
        tabBarLabelStyle: { fontFamily: FUENTE_BODY_BOLD, fontSize: 11.5 },
        // Sin esto, la barra de tabs queda flotando arriba del teclado en
        // Android (edge-to-edge, ver EvitarTeclado.tsx) cada vez que un campo
        // de texto toma foco.
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tabs.Screen
        name="Inicio"
        component={PantallaInicio}
        options={{
          title: 'Inicio',
          tabBarIcon: ({ focused }) => <IconoTab nombre="home-outline" activa={focused} />,
        }}
      />
      <Tabs.Screen name="Despachos" component={Despachos} options={opcionesArea('Despachos')} />
      <Tabs.Screen name="TrasladosPuntos" component={Traslados} options={opcionesArea('TrasladosPuntos')} />
      <Tabs.Screen name="Remisiones" component={Remisiones} options={opcionesArea('Remisiones')} />
    </Tabs.Navigator>
  );
}

export default function Navegacion() {
  // Solo en memoria, igual que antes -- ver SesionContext.tsx.
  const [sesion, setSesion] = useState<Sesion | null>(null);
  const cerrarSesion = useCallback(() => setSesion(null), []);
  // Valor memoizado para que los consumidores de la sesion no re-rendericen sin cambios reales.
  const valorSesion = useMemo(() => (sesion ? { sesion, cerrarSesion } : null), [sesion, cerrarSesion]);

  // Entrada y Principal se alternan como Screen hijos del mismo Navigator
  // (patron "auth flow" estandar de la libreria): React Navigation anima el
  // cambio, y al cerrar sesion se desmontan todas las tabs -- la proxima
  // cuenta arranca cada seccion de cero.
  return (
    <RootStack.Navigator screenOptions={{ headerShown: false }}>
      {!sesion || !valorSesion ? (
        <RootStack.Screen name="Entrada">{() => <PantallaEntrada onLogin={setSesion} />}</RootStack.Screen>
      ) : (
        <RootStack.Screen name="Principal">
          {() => (
            <SesionProvider value={valorSesion}>
              <TabsPrincipales />
              {/* Solo con sesion: la entrada tiene sus propias calabazas (ver halloween.tsx). */}
              <CalabazasBorde />
            </SesionProvider>
          )}
        </RootStack.Screen>
      )}
    </RootStack.Navigator>
  );
}
