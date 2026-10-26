// Bandeja de recepcion (bodega destino): traslados en_transito hacia este
// punto -- se refresca cada vez que se vuelve a la pantalla (useFocusEffect)
// y tirando hacia abajo, asi se ve al toque algo que otra bodega acaba de
// despachar. Orden: el que lleva mas tiempo esperando, primero.
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { fetchTrasladosPunto, type Traslado } from './api';
import NumerosTraslado from './NumerosTraslado';
import { mensajeError } from './errorMessages';
import { AvisoRol } from './ResumenTraslado';
import { formatearFechaLarga, haceCuanto } from './SelectorFecha';
import { HeaderTraslado, useTraslado } from './TrasladoContext';
import {
  ACENTO,
  FUENTE_BODY,
  FUENTE_BODY_SEMI,
  FUENTE_DISPLAY,
  NEUTRAL_400,
  NEUTRAL_500,
  styles,
  TEXTO_PRIMARIO,
  TEXTO_SOBRE_ACENTO,
} from './tema';
import type { TrasladosStackParamList } from './Navegacion';

type NavegacionBandeja = NativeStackNavigationProp<TrasladosStackParamList, 'BandejaRecepcion'>;

const AMARILLO = '#fbbf24';

function TarjetaPorRecibir({ traslado, onRecibir }: { traslado: Traslado; onRecibir: () => void }) {
  const productos = traslado.cantidad_items ?? 0;
  return (
    <Pressable
      onPress={onRecibir}
      style={({ pressed }) => [styles.tarjeta, estilos.tarjeta, pressed && { opacity: 0.85 }]}
    >
      <View style={estilos.franja} />
      <View style={estilos.contenido}>
        <View style={estilos.filaSuperior}>
          <NumerosTraslado traslado={traslado} />
          <View style={estilos.pildora}>
            <Ionicons name="time-outline" size={13} color={AMARILLO} />
            <Text style={estilos.pildoraTexto}>Enviado {haceCuanto(traslado.created_at)}</Text>
          </View>
        </View>

        <View style={{ gap: 2 }}>
          <Text style={estilos.etiqueta}>Viene de</Text>
          <Text style={estilos.origen} numberOfLines={1}>
            {traslado.punto_origen_nombre ?? '—'}
          </Text>
        </View>

        <View style={estilos.metadatos}>
          <View style={estilos.metadato}>
            <Ionicons name="cube-outline" size={13} color={NEUTRAL_500} />
            <Text style={estilos.metadatoTexto}>
              {productos} {productos === 1 ? 'producto' : 'productos'}
            </Text>
          </View>
          <View style={estilos.metadato}>
            <Ionicons name="calendar-outline" size={13} color={NEUTRAL_500} />
            <Text style={estilos.metadatoTexto}>{formatearFechaLarga(traslado.fecha)}</Text>
          </View>
          {traslado.transportador_nombre ? (
            <View style={[estilos.metadato, { flexShrink: 1 }]}>
              <Ionicons name="car-outline" size={13} color={NEUTRAL_500} />
              <Text style={estilos.metadatoTexto} numberOfLines={1}>
                {traslado.transportador_nombre}
              </Text>
            </View>
          ) : null}
          {traslado.numero_talonario && !traslado.talonario_id ? (
            <View style={[estilos.metadato, { flexShrink: 1 }]}>
              <Ionicons name="document-text-outline" size={13} color={NEUTRAL_500} />
              <Text style={estilos.metadatoTexto} numberOfLines={1}>
                Talonario {traslado.numero_talonario}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={estilos.accion}>
          <Ionicons name="download-outline" size={18} color={TEXTO_SOBRE_ACENTO} />
          <Text style={estilos.accionTexto}>Revisar y recibir</Text>
          <Ionicons name="chevron-forward" size={18} color={TEXTO_SOBRE_ACENTO} />
        </View>
      </View>
    </Pressable>
  );
}

export default function PantallaTrasladoBandeja() {
  const navigation = useNavigation<NavegacionBandeja>();
  const { punto } = useTraslado();

  const [traslados, setTraslados] = useState<Traslado[]>([]);
  const [cargando, setCargando] = useState(true);
  const [refrescando, setRefrescando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const yaCargado = useRef(false);
  const cargar = useCallback(async (forzar = false) => {
    if (!punto) return;
    // El indicador de carga solo la primera vez: despues la lista queda a la
    // vista mientras se actualiza (la cache de api.ts la devuelve al instante).
    if (!yaCargado.current) setCargando(true);
    setError(null);
    try {
      const lista = await fetchTrasladosPunto({ destinoId: punto.id, estado: 'en_transito' }, { forzar });
      // El que mas espera, arriba.
      setTraslados([...lista].sort((a, b) => a.created_at.localeCompare(b.created_at)));
      yaCargado.current = true;
    } catch (err) {
      setError(mensajeError(err, 'traslado'));
    } finally {
      setCargando(false);
    }
  }, [punto]);

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

  const pendientes = traslados.length;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refrescando} onRefresh={refrescar} tintColor={ACENTO} colors={[ACENTO]} />}
      >
        <HeaderTraslado />

        <AvisoRol
          icono="download-outline"
          rol="Bodega destino · Por recibir"
          texto={
            pendientes > 0
              ? `Tienes ${pendientes} ${pendientes === 1 ? 'traslado' : 'traslados'} en camino. Toca uno para revisar lo que llegó y firmar.`
              : 'Aquí aparecen los traslados que otras bodegas envían a este punto.'
          }
        />

        {cargando && traslados.length === 0 ? (
          <ActivityIndicator color={ACENTO} />
        ) : error ? (
          <Text style={styles.textoErrorInline}>{error}</Text>
        ) : pendientes === 0 ? (
          <View style={estilos.vacio}>
            <Ionicons name="checkmark-done-circle-outline" size={40} color="#34d399" />
            <Text style={estilos.vacioTitulo}>Todo al día</Text>
            <Text style={estilos.vacioTexto}>No hay traslados esperando recepción. Desliza hacia abajo para actualizar.</Text>
          </View>
        ) : (
          traslados.map((t) => (
            <TarjetaPorRecibir
              key={t.id}
              traslado={t}
              onRecibir={() => navigation.navigate('RecepcionTraslado', { trasladoId: t.id })}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const estilos = StyleSheet.create({
  tarjeta: { flexDirection: 'row', padding: 0, overflow: 'hidden' },
  franja: { width: 5, backgroundColor: AMARILLO },
  contenido: { flex: 1, padding: 16, gap: 12 },
  filaSuperior: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  numero: { color: NEUTRAL_400, fontSize: 13, fontFamily: FUENTE_BODY_SEMI, letterSpacing: 0.5 },
  pildora: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(251,191,36,0.14)',
  },
  pildoraTexto: { color: AMARILLO, fontSize: 12, fontFamily: FUENTE_BODY_SEMI },
  etiqueta: { color: NEUTRAL_500, fontSize: 11.5, fontFamily: FUENTE_BODY_SEMI, textTransform: 'uppercase' },
  origen: { color: TEXTO_PRIMARIO, fontSize: 18, fontFamily: FUENTE_DISPLAY },
  metadatos: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  metadato: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metadatoTexto: { color: NEUTRAL_400, fontSize: 12.5, fontFamily: FUENTE_BODY },
  accion: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: ACENTO,
  },
  accionTexto: { color: TEXTO_SOBRE_ACENTO, fontSize: 15, fontFamily: FUENTE_BODY_SEMI },
  vacio: { alignItems: 'center', gap: 6, paddingVertical: 36 },
  vacioTitulo: { color: TEXTO_PRIMARIO, fontSize: 16, fontFamily: FUENTE_BODY_SEMI },
  vacioTexto: { color: NEUTRAL_500, fontSize: 13, fontFamily: FUENTE_BODY, textAlign: 'center' },
});
