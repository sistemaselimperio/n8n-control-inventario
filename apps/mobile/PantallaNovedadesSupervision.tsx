// Bandeja de Supervision: traslados recibidos con novedad, agrupados en
// Pendientes (todavia sin solucion) y Resueltas (Supervision ya cargo que
// se hizo) -- ver GET /traslados-puntos/novedades y el plan
// "supervision-novedades". Se cargan las dos listas juntas (no solo la
// pestaña activa) para que los dos contadores de las pestañas siempre
// muestren un numero real, sin esperar a que se toque la otra pestaña.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { buscarConsecutivoTraslado, fetchNovedadesTraslado, origenTraslado, type Traslado } from './api';
import NumerosTraslado from './NumerosTraslado';
import EvitarTeclado from './EvitarTeclado';
import { mensajeError } from './errorMessages';
import { AvisoRol } from './ResumenTraslado';
import { formatearFechaLarga, haceCuanto } from './SelectorFecha';
import { HeaderTraslado } from './TrasladoContext';
import {
  ACENTO,
  FUENTE_BODY,
  FUENTE_BODY_SEMI,
  FUENTE_DISPLAY,
  NEUTRAL_400,
  NEUTRAL_500,
  NEUTRAL_700,
  NEUTRAL_800,
  NEUTRAL_850,
  styles,
  TEXTO_PRIMARIO,
  TEXTO_SOBRE_ACENTO,
} from './tema';
import type { TrasladosStackParamList } from './Navegacion';

type NavegacionNovedades = NativeStackNavigationProp<TrasladosStackParamList, 'NovedadesSupervision'>;

type Pestana = 'pendiente' | 'resuelta';

const VERDE = '#34d399';
const ROJO = '#f87171';

function TarjetaNovedad({
  traslado,
  pestana,
  onPress,
}: {
  traslado: Traslado;
  pestana: Pestana;
  onPress: () => void;
}) {
  const color = pestana === 'resuelta' ? VERDE : ROJO;
  const productos = traslado.cantidad_items ?? 0;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.tarjeta, estilos.tarjeta, pressed && { opacity: 0.85 }]}
    >
      {/* Franja de color: roja mientras espera solucion, verde una vez
          resuelta -- se lee de un vistazo en la lista, mismo criterio que
          el estado de traslado en PantallaTrasladoInicio.tsx. */}
      <View style={[estilos.franja, { backgroundColor: color }]} />
      <View style={estilos.contenido}>
        <View style={estilos.filaSuperior}>
          <NumerosTraslado traslado={traslado} />
          <View
            style={[
              estilos.pildora,
              { backgroundColor: pestana === 'resuelta' ? 'rgba(52,211,153,0.14)' : 'rgba(248,113,113,0.14)' },
            ]}
          >
            <Ionicons
              name={pestana === 'resuelta' ? 'checkmark-done-circle-outline' : 'time-outline'}
              size={13}
              color={color}
            />
            <Text style={[estilos.pildoraTexto, { color }]}>{pestana === 'resuelta' ? 'Resuelta' : 'Pendiente'}</Text>
          </View>
        </View>

        <Text style={estilos.lugarTexto} numberOfLines={1}>
          {origenTraslado(traslado)} <Text style={{ color: ACENTO }}>→</Text>{' '}
          {traslado.punto_destino_nombre ?? '—'}
        </Text>

        <View style={estilos.metadatos}>
          <View style={estilos.metadato}>
            <Ionicons name="calendar-outline" size={13} color={NEUTRAL_500} />
            <Text style={estilos.metadatoTexto}>{formatearFechaLarga(traslado.fecha)}</Text>
          </View>
          <View style={estilos.metadato}>
            <Ionicons name="cube-outline" size={13} color={NEUTRAL_500} />
            <Text style={estilos.metadatoTexto}>
              {productos} {productos === 1 ? 'producto' : 'productos'}
            </Text>
          </View>
          {traslado.numero_talonario && !traslado.talonario_id ? (
            <View style={[estilos.metadato, { flexShrink: 1 }]}>
              <Ionicons name="document-text-outline" size={13} color={NEUTRAL_500} />
              <Text style={estilos.metadatoTexto} numberOfLines={1}>
                Talonario {traslado.numero_talonario}
              </Text>
            </View>
          ) : null}
        </View>

        {traslado.recibido_at ? <Text style={estilos.cuando}>Recibido {haceCuanto(traslado.recibido_at)}</Text> : null}

        {traslado.novedad ? (
          <View style={estilos.novedad}>
            <Ionicons name="alert-circle-outline" size={14} color={ROJO} />
            <Text style={estilos.novedadTexto} numberOfLines={2}>
              {traslado.novedad}
            </Text>
          </View>
        ) : null}

        {pestana === 'resuelta' ? (
          <View style={estilos.solucion}>
            <Ionicons name="checkmark-circle-outline" size={14} color={VERDE} />
            <View style={{ flex: 1, gap: 4 }}>
              {traslado.consecutivo_solucion ? (
                <View style={estilos.consecutivoBadge}>
                  <Text style={estilos.consecutivoBadgeTexto}>{traslado.consecutivo_solucion}</Text>
                </View>
              ) : null}
              <Text style={estilos.solucionTexto} numberOfLines={2}>
                {traslado.solucion}
              </Text>
              <Text style={estilos.solucionMeta}>
                Resuelta por {traslado.solucionado_por_nombre ?? 'Supervisión'}
                {traslado.solucionado_at ? ` · ${haceCuanto(traslado.solucionado_at)}` : ''}
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function PantallaNovedadesSupervision() {
  const navigation = useNavigation<NavegacionNovedades>();

  const [pendientes, setPendientes] = useState<Traslado[]>([]);
  const [resueltas, setResueltas] = useState<Traslado[]>([]);
  const [cargando, setCargando] = useState(true);
  const [refrescando, setRefrescando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pestana, setPestana] = useState<Pestana>('pendiente');

  // Busqueda por consecutivo (ver el plan "consecutivo-solucion") -- mientras
  // hay texto, reemplaza las pestañas Pendientes/Resueltas de mas abajo.
  const [busqueda, setBusqueda] = useState('');
  const [resultados, setResultados] = useState<Traslado[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [errorBusqueda, setErrorBusqueda] = useState<string | null>(null);
  // Descarta la respuesta de una busqueda vieja si el texto ya cambio de
  // nuevo antes de que volviera (mismo riesgo de "respuesta fuera de orden"
  // que un buscador tipico) -- no hace falta AbortController, un contador
  // simple alcanza.
  const peticionBusqueda = useRef(0);

  const yaCargado = useRef(false);
  const cargar = useCallback(async (forzar = false) => {
    // El indicador de carga solo la primera vez: despues la lista queda a la
    // vista mientras se actualiza (la cache de api.ts la devuelve al instante).
    if (!yaCargado.current) setCargando(true);
    setError(null);
    try {
      const [listaPendientes, listaResueltas] = await Promise.all([
        fetchNovedadesTraslado('pendiente', { forzar }),
        fetchNovedadesTraslado('resuelta', { forzar }),
      ]);
      setPendientes(listaPendientes);
      setResueltas(listaResueltas);
      yaCargado.current = true;
    } catch (err) {
      setError(mensajeError(err, 'traslado'));
    } finally {
      setCargando(false);
    }
  }, []);

  // Refresca cada vez que se vuelve a esta pantalla -- mismo criterio que
  // PantallaTrasladoInicio.tsx (otro dispositivo pudo resolver una novedad
  // mientras tanto).
  useFocusEffect(
    useCallback(() => {
      cargar();
    }, [cargar])
  );

  // Deslizar para refrescar: consulta nueva al servidor, sin usar lo guardado.
  const refrescar = async () => {
    setRefrescando(true);
    await cargar(true);
    setRefrescando(false);
  };

  // Debounce ~350ms -- espera a que Erika termine de tipear antes de pegarle
  // al backend en cada tecla. Con texto vacio no busca nada (ver
  // buscarConsecutivoTraslado, que igual corta antes del fetch).
  useEffect(() => {
    const texto = busqueda.trim();
    if (!texto) {
      setResultados([]);
      setErrorBusqueda(null);
      setBuscando(false);
      return;
    }
    setBuscando(true);
    setErrorBusqueda(null);
    const idPeticion = ++peticionBusqueda.current;
    const temporizador = setTimeout(() => {
      buscarConsecutivoTraslado(texto)
        .then((lista) => {
          if (peticionBusqueda.current === idPeticion) setResultados(lista);
        })
        .catch((err) => {
          if (peticionBusqueda.current === idPeticion) setErrorBusqueda(mensajeError(err, 'traslado'));
        })
        .finally(() => {
          if (peticionBusqueda.current === idPeticion) setBuscando(false);
        });
    }, 350);
    return () => clearTimeout(temporizador);
  }, [busqueda]);

  const lista = pestana === 'pendiente' ? pendientes : resueltas;
  const buscandoTexto = busqueda.trim().length > 0;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <EvitarTeclado>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refrescando} onRefresh={refrescar} tintColor={ACENTO} colors={[ACENTO]} />}
        >
          <HeaderTraslado />

          <AvisoRol
            icono="shield-checkmark-outline"
            rol="Supervisión · Novedades"
            texto="Revisa los traslados que llegaron con observación y registra qué se hizo con cada uno."
          />

          <Pressable
            onPress={() => navigation.navigate('TrasladosSyscafe')}
            style={({ pressed }) => [estilos.enlace, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="receipt-outline" size={16} color={ACENTO} />
            <Text style={estilos.enlaceTexto}>Ir a traslados Syscafe</Text>
          </Pressable>

          {/* Buscador de consecutivo -- mientras hay texto, reemplaza las
              pestañas y listas de abajo por los resultados (ver el plan
              "consecutivo-solucion"). */}
          <View style={estilos.buscador}>
            <Ionicons name="search-outline" size={18} color={NEUTRAL_500} />
            <TextInput
              value={busqueda}
              onChangeText={setBusqueda}
              placeholder="Buscar consecutivo (ej. NPT-1234)"
              placeholderTextColor={NEUTRAL_500}
              style={estilos.buscadorInput}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            {busqueda ? (
              <Pressable onPress={() => setBusqueda('')} hitSlop={8}>
                <Ionicons name="close-circle" size={18} color={NEUTRAL_500} />
              </Pressable>
            ) : null}
          </View>

          {buscandoTexto ? (
            buscando && resultados.length === 0 ? (
              <ActivityIndicator color={ACENTO} />
            ) : errorBusqueda ? (
              <Text style={styles.textoErrorInline}>{errorBusqueda}</Text>
            ) : resultados.length === 0 ? (
              <View style={estilos.vacio}>
                <Ionicons name="search-outline" size={34} color={NEUTRAL_500} />
                <Text style={estilos.vacioTitulo}>Sin resultados</Text>
                <Text style={estilos.vacioTexto}>Ningún consecutivo coincide con “{busqueda.trim()}”.</Text>
              </View>
            ) : (
              resultados.map((t) => (
                <TarjetaNovedad
                  key={t.id}
                  traslado={t}
                  pestana="resuelta"
                  onPress={() => navigation.navigate('NovedadDetalle', { trasladoId: t.id })}
                />
              ))
            )
          ) : (
            <>
              {/* Pestañas Pendientes / Resueltas, con el total de cada una --
                  mismo patron visual que Enviados/Recibidos en
                  PantallaTrasladoInicio.tsx. */}
              <View style={estilos.pestanas}>
                {(['pendiente', 'resuelta'] as Pestana[]).map((p) => {
                  const activa = pestana === p;
                  const total = p === 'pendiente' ? pendientes.length : resueltas.length;
                  return (
                    <Pressable key={p} onPress={() => setPestana(p)} style={[estilos.pestana, activa && estilos.pestanaActiva]}>
                      <Ionicons
                        name={p === 'pendiente' ? 'time-outline' : 'checkmark-done-outline'}
                        size={16}
                        color={activa ? TEXTO_PRIMARIO : NEUTRAL_400}
                      />
                      <Text style={[estilos.pestanaTexto, activa && estilos.pestanaTextoActiva]}>
                        {p === 'pendiente' ? 'Pendientes' : 'Resueltas'}
                      </Text>
                      <View style={[estilos.pestanaConteo, activa && estilos.pestanaConteoActivo]}>
                        <Text style={[estilos.pestanaConteoTexto, activa && { color: TEXTO_SOBRE_ACENTO }]}>{total}</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>

              {cargando && lista.length === 0 ? (
                <ActivityIndicator color={ACENTO} />
              ) : error ? (
                <Text style={styles.textoErrorInline}>{error}</Text>
              ) : lista.length === 0 ? (
                <View style={estilos.vacio}>
                  <Ionicons
                    name={pestana === 'pendiente' ? 'checkmark-done-circle-outline' : 'archive-outline'}
                    size={34}
                    color={pestana === 'pendiente' ? VERDE : NEUTRAL_500}
                  />
                  <Text style={estilos.vacioTitulo}>
                    {pestana === 'pendiente' ? 'No hay novedades pendientes' : 'Todavía no hay novedades resueltas'}
                  </Text>
                  <Text style={estilos.vacioTexto}>
                    {pestana === 'pendiente'
                      ? 'Cuando un punto reciba un traslado con observación, va a aparecer aquí.'
                      : 'Las novedades que resuelvas van a aparecer aquí con la solución cargada.'}
                  </Text>
                </View>
              ) : (
                lista.map((t) => (
                  <TarjetaNovedad
                    key={t.id}
                    traslado={t}
                    pestana={pestana}
                    onPress={() => navigation.navigate('NovedadDetalle', { trasladoId: t.id })}
                  />
                ))
              )}
            </>
          )}
        </ScrollView>
      </EvitarTeclado>
    </SafeAreaView>
  );
}

const estilos = StyleSheet.create({
  enlace: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  enlaceTexto: { color: ACENTO, fontSize: 13.5, fontFamily: FUENTE_BODY_SEMI },
  buscador: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 14,
    backgroundColor: NEUTRAL_850,
    borderWidth: 1,
    borderColor: NEUTRAL_700,
  },
  buscadorInput: { flex: 1, color: TEXTO_PRIMARIO, fontSize: 14, fontFamily: FUENTE_BODY_SEMI },
  consecutivoBadge: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(245,197,66,0.16)',
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 8,
  },
  consecutivoBadgeTexto: { color: ACENTO, fontSize: 11.5, fontFamily: FUENTE_BODY_SEMI, letterSpacing: 0.3 },
  pestanas: {
    flexDirection: 'row',
    gap: 6,
    padding: 5,
    borderRadius: 16,
    backgroundColor: NEUTRAL_850,
    borderWidth: 1,
    borderColor: NEUTRAL_700,
  },
  pestana: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 12,
  },
  pestanaActiva: { backgroundColor: NEUTRAL_800 },
  pestanaTexto: { color: NEUTRAL_400, fontSize: 14, fontFamily: FUENTE_BODY_SEMI },
  pestanaTextoActiva: { color: TEXTO_PRIMARIO },
  pestanaConteo: { minWidth: 22, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 10, backgroundColor: NEUTRAL_800 },
  pestanaConteoActivo: { backgroundColor: ACENTO },
  pestanaConteoTexto: { color: NEUTRAL_400, fontSize: 12, fontFamily: FUENTE_BODY_SEMI, textAlign: 'center' },
  tarjeta: { flexDirection: 'row', padding: 0, overflow: 'hidden' },
  franja: { width: 5 },
  contenido: { flex: 1, padding: 16, gap: 10 },
  filaSuperior: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  numero: { color: NEUTRAL_400, fontSize: 13, fontFamily: FUENTE_BODY_SEMI, letterSpacing: 0.5 },
  pildora: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  pildoraTexto: { fontSize: 12, fontFamily: FUENTE_BODY_SEMI },
  lugarTexto: { color: TEXTO_PRIMARIO, fontSize: 16, fontFamily: FUENTE_DISPLAY },
  metadatos: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  metadato: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metadatoTexto: { color: NEUTRAL_400, fontSize: 12.5, fontFamily: FUENTE_BODY },
  cuando: { color: NEUTRAL_500, fontSize: 12, fontFamily: FUENTE_BODY },
  novedad: {
    flexDirection: 'row',
    gap: 6,
    padding: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(248,113,113,0.10)',
  },
  novedadTexto: { flex: 1, color: '#fca5a5', fontSize: 12.5, fontFamily: FUENTE_BODY },
  solucion: {
    flexDirection: 'row',
    gap: 6,
    padding: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(52,211,153,0.10)',
  },
  solucionTexto: { color: '#a7f3d0', fontSize: 12.5, fontFamily: FUENTE_BODY },
  solucionMeta: { color: NEUTRAL_500, fontSize: 11.5, fontFamily: FUENTE_BODY, marginTop: 2 },
  vacio: { alignItems: 'center', gap: 6, paddingVertical: 28 },
  vacioTitulo: { color: TEXTO_PRIMARIO, fontSize: 15, fontFamily: FUENTE_BODY_SEMI },
  vacioTexto: { color: NEUTRAL_500, fontSize: 13, fontFamily: FUENTE_BODY, textAlign: 'center' },
});
