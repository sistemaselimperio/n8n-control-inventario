// Lista de Supervision para llevar el numero Syscafe de cada traslado (la
// relacion que antes se llevaba a mano en el Excel del talonario): filtros
// Pendientes / Todos y por punto de origen. Tocar un traslado abre
// DetalleTraslado, donde se registra o corrige el numero. Las hojas anuladas
// salen en la lista con la etiqueta "Anulada" y sin campo Syscafe.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { fetchPuntos, listarTrasladosSyscafe, origenTraslado, type FilaSyscafe, type Punto } from './api';
import { mensajeError } from './errorMessages';
import ModalSelectorPunto from './ModalSelectorPunto';
import { AvisoRol } from './ResumenTraslado';
import { formatearFechaLarga } from './SelectorFecha';
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

type NavegacionSyscafe = NativeStackNavigationProp<TrasladosStackParamList, 'TrasladosSyscafe'>;

type Filtro = 'pendientes' | 'todos';

const VERDE = '#34d399';
const AMBAR = '#fbbf24';

const TEXTO_ESTADO: Record<string, string> = {
  en_transito: 'En tránsito',
  recibido: 'Recibido',
  recibido_con_novedad: 'Con novedad',
};

function referenciaFila(f: FilaSyscafe): string {
  if (f.numero_talonario && (f.tipo === 'anulada' || f.talonario_id)) return f.numero_talonario;
  return `TP-${String(f.consecutivo ?? 0).padStart(6, '0')}`;
}

function TarjetaSyscafe({ fila, onPress }: { fila: FilaSyscafe; onPress: () => void }) {
  const anulada = fila.tipo === 'anulada';
  const color = anulada ? NEUTRAL_500 : fila.numero_syscafe ? VERDE : AMBAR;
  return (
    <Pressable
      disabled={anulada}
      onPress={onPress}
      style={({ pressed }) => [styles.tarjeta, estilos.tarjeta, pressed && { opacity: 0.85 }]}
    >
      <View style={[estilos.franja, { backgroundColor: color }]} />
      <View style={estilos.contenido}>
        <View style={estilos.filaSuperior}>
          <Text style={estilos.numero}>{referenciaFila(fila)}</Text>
          {anulada ? (
            <View style={[estilos.pildora, { backgroundColor: 'rgba(148,148,148,0.16)' }]}>
              <Ionicons name="close-circle-outline" size={13} color={NEUTRAL_400} />
              <Text style={[estilos.pildoraTexto, { color: NEUTRAL_400 }]}>Anulada</Text>
            </View>
          ) : (
            <Text style={[estilos.syscafe, { color }]}>
              {fila.numero_syscafe ? `Syscafe ${fila.numero_syscafe}` : 'Syscafe: pendiente'}
            </Text>
          )}
        </View>

        <Text style={estilos.lugarTexto} numberOfLines={1}>
          {origenTraslado({ tipo: fila.tipo_traslado, punto_origen_nombre: fila.punto_origen_nombre })}
          {!anulada ? (
            <>
              {' '}
              <Text style={{ color: ACENTO }}>→</Text> {fila.punto_destino_nombre ?? '—'}
            </>
          ) : null}
        </Text>

        <View style={estilos.metadatos}>
          <View style={estilos.metadato}>
            <Ionicons name="calendar-outline" size={13} color={NEUTRAL_500} />
            <Text style={estilos.metadatoTexto}>{formatearFechaLarga(fila.fecha)}</Text>
          </View>
          {!anulada ? (
            <View style={estilos.metadato}>
              <Ionicons name="swap-horizontal-outline" size={13} color={NEUTRAL_500} />
              <Text style={estilos.metadatoTexto}>{TEXTO_ESTADO[fila.estado] ?? fila.estado}</Text>
            </View>
          ) : null}
        </View>

        {anulada && fila.motivo ? <Text style={estilos.motivo}>Motivo: {fila.motivo}</Text> : null}
      </View>
    </Pressable>
  );
}

export default function PantallaTrasladosSyscafe() {
  const navigation = useNavigation<NavegacionSyscafe>();

  const [filtro, setFiltro] = useState<Filtro>('pendientes');
  const [punto, setPunto] = useState<Punto | null>(null);
  const [puntos, setPuntos] = useState<Punto[]>([]);
  const [selectorAbierto, setSelectorAbierto] = useState(false);
  const [filas, setFilas] = useState<FilaSyscafe[]>([]);
  const [cargando, setCargando] = useState(true);
  const [refrescando, setRefrescando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Descarta la respuesta de una carga vieja si el filtro cambio antes de que volviera.
  const peticion = useRef(0);

  useEffect(() => {
    fetchPuntos()
      .then(setPuntos)
      .catch(() => setPuntos([]));
  }, []);

  const cargar = useCallback(
    async (forzar = false) => {
      const id = ++peticion.current;
      setError(null);
      try {
        const lista = await listarTrasladosSyscafe(
          { puntoId: punto?.id, pendientes: filtro === 'pendientes' },
          { forzar }
        );
        if (peticion.current === id) setFilas(lista);
      } catch (err) {
        if (peticion.current === id) setError(mensajeError(err, 'traslado'));
      } finally {
        if (peticion.current === id) setCargando(false);
      }
    },
    [filtro, punto]
  );

  // Refresca cada vez que se vuelve a esta pantalla (se pudo guardar un numero en el detalle).
  useFocusEffect(
    useCallback(() => {
      cargar();
    }, [cargar])
  );

  const refrescar = async () => {
    setRefrescando(true);
    await cargar(true);
    setRefrescando(false);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refrescando} onRefresh={refrescar} tintColor={ACENTO} colors={[ACENTO]} />}
      >
        <HeaderTraslado />

        <AvisoRol
          icono="receipt-outline"
          rol="Supervisión · Traslados Syscafe"
          texto="Registra el número de Syscafe de cada traslado para cruzarlo con la hoja del talonario."
        />

        <Pressable
          onPress={() => navigation.navigate('NovedadesSupervision')}
          style={({ pressed }) => [estilos.enlace, pressed && { opacity: 0.85 }]}
        >
          <Ionicons name="alert-circle-outline" size={16} color={ACENTO} />
          <Text style={estilos.enlaceTexto}>Ir a novedades</Text>
        </Pressable>

        <View style={estilos.pestanas}>
          {(['pendientes', 'todos'] as Filtro[]).map((f) => {
            const activa = filtro === f;
            return (
              <Pressable key={f} onPress={() => setFiltro(f)} style={[estilos.pestana, activa && estilos.pestanaActiva]}>
                <Text style={[estilos.pestanaTexto, activa && estilos.pestanaTextoActiva]}>
                  {f === 'pendientes' ? 'Pendientes' : 'Todos'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={estilos.filaPunto}>
          <Pressable onPress={() => setSelectorAbierto(true)} style={[estilos.chipPunto, { flex: 1 }]}>
            <Ionicons name="business-outline" size={16} color={NEUTRAL_400} />
            <Text style={estilos.chipPuntoTexto} numberOfLines={1}>
              {punto ? punto.nombre : 'Todos los puntos'}
            </Text>
          </Pressable>
          {punto ? (
            <Pressable onPress={() => setPunto(null)} hitSlop={8}>
              <Ionicons name="close-circle" size={22} color={NEUTRAL_500} />
            </Pressable>
          ) : null}
        </View>

        {cargando && filas.length === 0 ? (
          <ActivityIndicator color={ACENTO} />
        ) : error ? (
          <Text style={styles.textoErrorInline}>{error}</Text>
        ) : filas.length === 0 ? (
          <View style={estilos.vacio}>
            <Ionicons name="checkmark-done-circle-outline" size={34} color={VERDE} />
            <Text style={estilos.vacioTitulo}>
              {filtro === 'pendientes' ? 'No hay traslados pendientes de Syscafe' : 'No hay traslados'}
            </Text>
          </View>
        ) : (
          filas.map((f) => (
            <TarjetaSyscafe
              key={`${f.tipo}:${f.id}`}
              fila={f}
              onPress={() => navigation.navigate('DetalleTraslado', { trasladoId: f.id })}
            />
          ))
        )}
      </ScrollView>

      <ModalSelectorPunto
        visible={selectorAbierto}
        titulo="Filtrar por punto"
        puntos={puntos}
        seleccionadoId={punto?.id ?? null}
        onElegir={(p) => {
          setPunto(p);
          setSelectorAbierto(false);
        }}
        onCerrar={() => setSelectorAbierto(false)}
      />
    </SafeAreaView>
  );
}

const estilos = StyleSheet.create({
  enlace: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  enlaceTexto: { color: ACENTO, fontSize: 13.5, fontFamily: FUENTE_BODY_SEMI },
  pestanas: {
    flexDirection: 'row',
    gap: 6,
    padding: 5,
    borderRadius: 16,
    backgroundColor: NEUTRAL_850,
    borderWidth: 1,
    borderColor: NEUTRAL_700,
  },
  pestana: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 12 },
  pestanaActiva: { backgroundColor: ACENTO },
  pestanaTexto: { color: NEUTRAL_400, fontSize: 14, fontFamily: FUENTE_BODY_SEMI },
  pestanaTextoActiva: { color: TEXTO_SOBRE_ACENTO },
  filaPunto: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chipPunto: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 14,
    backgroundColor: NEUTRAL_800,
    borderWidth: 1,
    borderColor: NEUTRAL_700,
  },
  chipPuntoTexto: { flex: 1, color: TEXTO_PRIMARIO, fontSize: 14, fontFamily: FUENTE_BODY_SEMI },
  tarjeta: { flexDirection: 'row', padding: 0, overflow: 'hidden' },
  franja: { width: 5 },
  contenido: { flex: 1, padding: 16, gap: 10 },
  filaSuperior: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  numero: { color: NEUTRAL_400, fontSize: 13, fontFamily: FUENTE_BODY_SEMI, letterSpacing: 0.5 },
  syscafe: { fontSize: 13, fontFamily: FUENTE_BODY_SEMI },
  pildora: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  pildoraTexto: { fontSize: 12, fontFamily: FUENTE_BODY_SEMI },
  lugarTexto: { color: TEXTO_PRIMARIO, fontSize: 16, fontFamily: FUENTE_DISPLAY },
  metadatos: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  metadato: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metadatoTexto: { color: NEUTRAL_400, fontSize: 12.5, fontFamily: FUENTE_BODY },
  motivo: { color: NEUTRAL_500, fontSize: 12.5, fontFamily: FUENTE_BODY },
  vacio: { alignItems: 'center', gap: 6, paddingVertical: 28 },
  vacioTitulo: { color: TEXTO_PRIMARIO, fontSize: 15, fontFamily: FUENTE_BODY_SEMI, textAlign: 'center' },
});
