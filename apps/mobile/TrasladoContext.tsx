// Estado compartido de la tab Traslados -- la sesion (usuario + punto,
// mismo patron que EntregaContext.tsx) y el borrador del traslado en
// creacion, compartido entre NuevoTraslado y FirmaTransportador (las dos
// pantallas que arman UN mismo traslado antes de mandarlo al backend).
// BandejaRecepcion/RecepcionTraslado no usan el borrador -- consultan
// traslados ya creados, por eso su estado queda local a esas pantallas.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NavigationHelpers } from '@react-navigation/native';
import * as Crypto from 'expo-crypto';

import type { Punto, UsuarioPunto } from './api';
import { ACENTO, NEUTRAL_500, styles, useEstiloTabBar } from './tema';
// Type-only -- se borra en compilacion, mismo criterio que EntregaContext.tsx
// con DespachosStackParamList (sin dependencia de runtime entre los dos
// archivos).
import type { TrasladosStackParamList } from './Navegacion';

const hoyISO = () => new Date().toISOString().slice(0, 10);

export interface ItemTrasladoDraft {
  // Id local (React key / referencia para editar-quitar) -- no viaja al
  // backend, que arma su propio id por item al insertar.
  localId: string;
  producto: string;
  marca: string;
  presentacion: string;
  cantidad: string;
  // ISO YYYY-MM-DD, o "" si el producto no tiene vencimiento.
  fechaVencimiento: string;
}

export function nuevoItemDraft(): ItemTrasladoDraft {
  return { localId: Crypto.randomUUID(), producto: '', marca: '', presentacion: '', cantidad: '', fechaVencimiento: '' };
}

export interface TrasladoDraft {
  // Generado en el celular ANTES de crear el traslado -- el path de las 2
  // firmas en Storage depende de este id (ver subirFirmaTraslado en api.ts),
  // asi que tiene que existir desde que arranca NuevoTraslado.
  id: string;
  // Numero impreso en el talonario fisico (ej. "00231") -- lo primero que
  // copia el punto que despacha, ver PantallaTrasladoNuevo.tsx.
  numeroTalonario: string;
  // URL en Storage de la foto del talonario de la que se leyo el encabezado
  // y los productos (ver PantallaTrasladoNuevo.tsx); "" hasta que se lee.
  fotoTalonarioUrl: string;
  destino: Punto | null;
  transportadorNombre: string;
  fecha: string;
  observaciones: string;
  items: ItemTrasladoDraft[];
  firmaDespachaBase64: string | null;
}

function nuevoDraft(): TrasladoDraft {
  return {
    id: Crypto.randomUUID(),
    numeroTalonario: '',
    fotoTalonarioUrl: '',
    destino: null,
    transportadorNombre: '',
    fecha: hoyISO(),
    observaciones: '',
    items: [],
    firmaDespachaBase64: null,
  };
}

export interface TrasladoContextValue {
  usuario: UsuarioPunto | null;
  punto: Punto | null;
  cerrarSesion: () => void;
  draft: TrasladoDraft;
  actualizarDraft: (cambios: Partial<TrasladoDraft>) => void;
  reiniciarDraft: () => void;
  cargando: boolean;
  setCargando: (v: boolean) => void;
  // Descarta el borrador actual y vuelve a la pantalla raiz (InicioTraslados)
  // -- usado al cancelar NuevoTraslado o al terminar en ResultadoTraslado.
  volverAInicio: () => void;
}

const TrasladoContext = createContext<TrasladoContextValue | null>(null);

export function useTraslado(): TrasladoContextValue {
  const ctx = useContext(TrasladoContext);
  if (!ctx) throw new Error('useTraslado() debe usarse dentro de <TrasladoProvider>');
  return ctx;
}

export function TrasladoProvider({
  navigation,
  usuario,
  punto,
  cerrarSesion,
  children,
}: {
  // navigation del stack de Traslados -- llega por el `layout` del
  // Navigator (ver Navegacion.tsx), mismo motivo que EntregaContext.tsx:
  // useNavigation() aca devolveria la de la TAB, no la del stack.
  navigation: NavigationHelpers<TrasladosStackParamList>;
  usuario: UsuarioPunto | null;
  punto: Punto | null;
  cerrarSesion: () => void;
  children: ReactNode;
}) {
  const navigationTab = useNavigation();

  const [draft, setDraft] = useState<TrasladoDraft>(nuevoDraft);
  const [cargando, setCargando] = useState(false);

  const actualizarDraft = useCallback((cambios: Partial<TrasladoDraft>) => {
    setDraft((prev) => ({ ...prev, ...cambios }));
  }, []);

  const reiniciarDraft = useCallback(() => setDraft(nuevoDraft()), []);

  const volverAInicio = useCallback(() => {
    reiniciarDraft();
    navigation.reset({
      index: 0,
      routes: [{ name: 'InicioTraslados' }],
    });
  }, [reiniciarDraft, navigation]);

  // Mismo criterio que EntregaContext.tsx -- oculta la barra de tabs
  // mientras hay una creacion/recepcion en vuelo, para que no se salga a
  // otra tab a mitad de un envio.
  const estiloTabBar = useEstiloTabBar();
  useEffect(() => {
    navigationTab.setOptions({
      tabBarStyle: cargando ? [estiloTabBar, { display: 'none' }] : estiloTabBar,
    });
  }, [cargando, navigationTab, estiloTabBar]);

  // Valor memoizado para que los consumidores del context no re-rendericen sin cambios reales.
  const value: TrasladoContextValue = useMemo(() => ({
    usuario,
    punto,
    cerrarSesion,
    draft,
    actualizarDraft,
    reiniciarDraft,
    cargando,
    setCargando,
    volverAInicio,
  }), [usuario, punto, cerrarSesion, draft, actualizarDraft, reiniciarDraft, cargando, volverAInicio]);

  return <TrasladoContext.Provider value={value}>{children}</TrasladoContext.Provider>;
}

// Header compartido por todas las pantallas logueadas de Traslados -- mismo
// rol que HeaderEntrega en EntregaContext.tsx, con su propia logica de
// "volver": desde NuevoTraslado/ResultadoTraslado el back descarta el
// borrador y vuelve al inicio (equivalente a cancelar/terminar); desde el
// resto (FirmaTransportador, BandejaRecepcion, RecepcionTraslado) el back es
// un pop simple -- no hay nada que descartar ahi (FirmaTransportador vuelve
// a NuevoTraslado con el borrador intacto para seguir editando).
export function HeaderTraslado() {
  const route = useRoute();
  const navigation = useNavigation<NavigationHelpers<TrasladosStackParamList>>();
  const { usuario, punto, cargando, cerrarSesion, volverAInicio } = useTraslado();

  // Defensivo -- en la practica nunca deberia pasar: TrasladoProvider solo se
  // monta con sesion de punto iniciada (ver Navegacion.tsx), pero sus tipos
  // siguen admitiendo todo en null.
  if (!usuario || !punto) return null;

  const esRaiz = route.name === 'InicioTraslados';
  const descartaAlVolver = route.name === 'NuevoTraslado' || route.name === 'ResultadoTraslado';

  const volverAtras = () => {
    if (descartaAlVolver) {
      volverAInicio();
    } else {
      navigation.goBack();
    }
  };

  return (
    <View style={styles.header}>
      <View style={styles.headerFila}>
        {esRaiz ? null : (
          <Pressable onPress={volverAtras} disabled={cargando} hitSlop={8} style={styles.botonVolverHeader}>
            <Ionicons name="chevron-back" size={26} color={cargando ? NEUTRAL_500 : '#fff'} />
          </Pressable>
        )}
        {/* Solo el punto -- en Traslados se entra como el punto (la cuenta se
            llama igual, ver scripts/cargar_puntos.py), no hay persona que
            mostrar aparte. */}
        <View style={styles.recuadroIdentidad}>
          <View style={styles.recuadroFila}>
            <Ionicons name="location" size={14} color={ACENTO} />
            <Text style={styles.recuadroSedeTexto} numberOfLines={1}>
              {punto.nombre}
            </Text>
          </View>
        </View>
        <Pressable
          onPress={() => {
            if (cargando) {
              Alert.alert(
                'Espera un momento',
                'Hay una operación en curso -- espera a que termine antes de cerrar sesión.'
              );
              return;
            }
            cerrarSesion();
          }}
          hitSlop={8}
          style={({ pressed }) => [
            styles.cerrarSesionBoton,
            pressed && styles.cerrarSesionBotonPresionado,
            cargando && styles.cerrarSesionBotonDeshabilitado,
          ]}
        >
          <Ionicons name="log-out-outline" size={14} color={cargando ? NEUTRAL_500 : '#f87171'} />
          <Text style={[styles.cerrarSesion, cargando && styles.cerrarSesionDeshabilitado]}>Cerrar sesión</Text>
        </Pressable>
      </View>
    </View>
  );
}
