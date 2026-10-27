// Detalle de solo lectura de un traslado ya creado -- se abre tocando una
// tarjeta de Enviados o Recibidos en InicioTraslados. Muestra lo mismo que
// vieron el conductor y la bodega destino (ResumenTraslado) mas lo que paso
// en la recepcion: cantidad recibida y novedad por producto, novedad general
// y las 3 firmas.
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { etiquetaSyscafe, fetchTrasladoPunto, origenTraslado, referenciaTraslado, type EstadoTraslado, type Traslado } from './api';
import EditorSyscafe from './EditorSyscafe';
import { mensajeError } from './errorMessages';
import FirmasTraslado from './FirmasTraslado';
import ResumenTraslado from './ResumenTraslado';
import { useSesion } from './SesionContext';
import { haceCuanto, textoVencimiento } from './SelectorFecha';
import { HeaderTraslado } from './TrasladoContext';
import { ACENTO, FUENTE_BODY, FUENTE_BODY_SEMI, FUENTE_DISPLAY, NEUTRAL_400, styles, TEXTO_PRIMARIO } from './tema';
import type { TrasladosStackParamList } from './Navegacion';

type Props = NativeStackScreenProps<TrasladosStackParamList, 'DetalleTraslado'>;

const VERDE = '#34d399';
const ROJO = '#f87171';

export const ESTADO_TRASLADO: Record<
  EstadoTraslado,
  { texto: string; color: string; fondo: string; icono: keyof typeof Ionicons.glyphMap }
> = {
  en_transito: { texto: 'En tránsito', color: '#fbbf24', fondo: 'rgba(251,191,36,0.14)', icono: 'car-outline' },
  recibido: { texto: 'Recibido', color: VERDE, fondo: 'rgba(52,211,153,0.14)', icono: 'checkmark-circle-outline' },
  recibido_con_novedad: { texto: 'Con novedad', color: ROJO, fondo: 'rgba(248,113,113,0.14)', icono: 'alert-circle-outline' },
};

export default function PantallaTrasladoDetalle({ route }: Props) {
  const { trasladoId } = route.params;
  const { sesion } = useSesion();
  const [traslado, setTraslado] = useState<Traslado | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchTrasladoPunto(trasladoId)
      .then(setTraslado)
      .catch((err) => setError(mensajeError(err, 'traslado')))
      .finally(() => setCargando(false));
  }, [trasladoId]);

  if (cargando) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={ACENTO} />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !traslado) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <HeaderTraslado />
          <Text style={styles.textoErrorInline}>{error ?? 'Traslado no encontrado.'}</Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const info = ESTADO_TRASLADO[traslado.estado];
  const items = traslado.items ?? [];
  const recibido = traslado.estado !== 'en_transito';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <HeaderTraslado />

        <View style={[estilos.estado, { backgroundColor: info.fondo }]}>
          <Ionicons name={info.icono} size={22} color={info.color} />
          <View style={{ flex: 1 }}>
            <Text style={[estilos.estadoTexto, { color: info.color }]}>{info.texto}</Text>
            <Text style={estilos.estadoSub}>
              {recibido && traslado.recibido_at
                ? `Recibido ${haceCuanto(traslado.recibido_at)}`
                : `Enviado ${haceCuanto(traslado.created_at)} · esperando recepción`}
            </Text>
          </View>
        </View>

        {/* Estado de la novedad ante Supervision (ver el plan
            "supervision-novedades") -- solo existe si el punto la recibio
            con diferencia; independiente del estado del traslado en si
            (arriba). Pill amarilla mientras Supervision no la resolvio,
            verde con la solucion una vez que la carga. */}
        {traslado.novedad_estado ? (
          <View
            style={[
              estilos.novedadEstadoPill,
              { backgroundColor: traslado.novedad_estado === 'resuelta' ? 'rgba(52,211,153,0.14)' : 'rgba(251,191,36,0.14)' },
            ]}
          >
            <Ionicons
              name={traslado.novedad_estado === 'resuelta' ? 'checkmark-done-circle-outline' : 'time-outline'}
              size={16}
              color={traslado.novedad_estado === 'resuelta' ? VERDE : '#fbbf24'}
            />
            <Text
              style={[
                estilos.novedadEstadoPillTexto,
                { color: traslado.novedad_estado === 'resuelta' ? VERDE : '#fbbf24' },
              ]}
            >
              {traslado.novedad_estado === 'resuelta' ? 'Novedad resuelta' : 'Novedad en revisión'}
            </Text>
          </View>
        ) : null}

        {traslado.novedad_estado === 'resuelta' ? (
          <View style={estilos.solucionBox}>
            <View style={estilos.solucionTituloFila}>
              <Text style={estilos.solucionTitulo}>Solución de Supervisión</Text>
              {traslado.consecutivo_solucion ? (
                <View style={estilos.consecutivoBadge}>
                  <Text style={estilos.consecutivoBadgeTexto}>{traslado.consecutivo_solucion}</Text>
                </View>
              ) : null}
            </View>
            <Text style={estilos.solucionTexto}>{traslado.solucion}</Text>
            <Text style={estilos.solucionMeta}>
              {traslado.solucionado_por_nombre ?? 'Supervisión'}
              {traslado.solucionado_at ? ` · ${haceCuanto(traslado.solucionado_at)}` : ''}
            </Text>
          </View>
        ) : null}

        <ResumenTraslado
          numero={`${referenciaTraslado(traslado)} · ${etiquetaSyscafe(traslado)}`}
          origen={origenTraslado(traslado)}
          destino={traslado.punto_destino_nombre ?? '—'}
          transportador={traslado.transportador_nombre}
          talonario={traslado.talonario_id ? null : traslado.numero_talonario}
          fecha={traslado.fecha}
          items={items.map((item) => ({
            key: item.id,
            cantidad: item.cantidad,
            producto: item.producto,
            marca: item.marca ?? '',
            presentacion: item.presentacion ?? '',
            fechaVencimiento: item.fecha_vencimiento,
          }))}
          observaciones={traslado.observaciones ?? ''}
          mostrarProductos={!recibido}
        />

        {/* Recepcion: enviado vs recibido por producto. Solo existe una vez
            que el destino confirmo. */}
        {recibido ? (
          <View style={styles.tarjeta}>
            <Text style={styles.etiquetaSeccion}>Lo que se recibió</Text>
            {items.map((item) => {
              const llegaron = item.cantidad_recibida ?? item.cantidad;
              const completo = llegaron >= item.cantidad && !item.novedad;
              const detalle = [item.marca, item.presentacion, textoVencimiento(item.fecha_vencimiento)].filter(Boolean).join(' · ');
              return (
                <View key={item.id} style={estilos.filaRecibido}>
                  <Ionicons
                    name={completo ? 'checkmark-circle' : 'alert-circle'}
                    size={22}
                    color={completo ? VERDE : ROJO}
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={estilos.producto}>{item.producto}</Text>
                    {detalle ? <Text style={estilos.detalle}>{detalle}</Text> : null}
                    {item.novedad ? <Text style={estilos.novedadItem}>{item.novedad}</Text> : null}
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[estilos.cantidades, { color: completo ? VERDE : ROJO }]}>
                      {llegaron}/{item.cantidad}
                    </Text>
                    <Text style={estilos.detalle}>recibidos</Text>
                  </View>
                </View>
              );
            })}
            {traslado.novedad ? (
              <View style={estilos.novedadGeneral}>
                <Ionicons name="alert-circle-outline" size={16} color={ROJO} />
                <Text style={estilos.novedadGeneralTexto}>{traslado.novedad}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* Supervision registra o corrige el numero Syscafe (el resto de
            sesiones lo ve de solo lectura junto a la referencia, arriba). */}
        {sesion.tipo === 'supervision' ? (
          <EditorSyscafe traslado={traslado} supervisorId={sesion.supervisor.id} onGuardado={setTraslado} />
        ) : null}

        {traslado.contenido_texto ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.etiquetaSeccion}>Contenido de la hoja</Text>
            <View style={styles.tarjeta}>
              <Text style={styles.itemDescripcion}>{traslado.contenido_texto}</Text>
            </View>
          </View>
        ) : null}

        <FirmasTraslado
          firmas={
            traslado.tipo === 'directo'
              ? // Llega directo: solo firma quien recibe.
                [{ clave: 'recibe', titulo: 'Recibe', quien: traslado.punto_destino_nombre ?? '', url: traslado.firma_recibe_url }]
              : [
                  { clave: 'despacha', titulo: 'Despacha', quien: traslado.punto_origen_nombre ?? '', url: traslado.firma_despacha_url },
                  { clave: 'transporta', titulo: 'Transporta', quien: traslado.transportador_nombre, url: traslado.firma_transporta_url },
                  { clave: 'recibe', titulo: 'Recibe', quien: traslado.punto_destino_nombre ?? '', url: traslado.firma_recibe_url },
                ]
          }
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const estilos = StyleSheet.create({
  estado: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: 16 },
  estadoTexto: { fontSize: 16, fontFamily: FUENTE_DISPLAY },
  estadoSub: { color: NEUTRAL_400, fontSize: 12.5, fontFamily: FUENTE_BODY },
  novedadEstadoPill: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  novedadEstadoPillTexto: { fontSize: 12.5, fontFamily: FUENTE_BODY_SEMI },
  solucionBox: {
    gap: 4,
    padding: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(52,211,153,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(52,211,153,0.3)',
  },
  solucionTituloFila: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  solucionTitulo: { color: VERDE, fontSize: 11, fontFamily: FUENTE_BODY_SEMI, textTransform: 'uppercase', letterSpacing: 0.5 },
  solucionTexto: { color: TEXTO_PRIMARIO, fontSize: 13.5, fontFamily: FUENTE_BODY },
  solucionMeta: { color: NEUTRAL_400, fontSize: 12, fontFamily: FUENTE_BODY },
  consecutivoBadge: {
    backgroundColor: 'rgba(245,197,66,0.16)',
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 8,
  },
  consecutivoBadgeTexto: { color: ACENTO, fontSize: 12, fontFamily: FUENTE_BODY_SEMI, letterSpacing: 0.3 },
  filaRecibido: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  producto: { color: TEXTO_PRIMARIO, fontSize: 15, fontFamily: FUENTE_BODY_SEMI },
  detalle: { color: NEUTRAL_400, fontSize: 12, fontFamily: FUENTE_BODY },
  novedadItem: { color: '#fca5a5', fontSize: 12.5, fontFamily: FUENTE_BODY },
  cantidades: { fontSize: 16, fontFamily: FUENTE_DISPLAY },
  novedadGeneral: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(248,113,113,0.10)',
  },
  novedadGeneralTexto: { flex: 1, color: '#fca5a5', fontSize: 13, fontFamily: FUENTE_BODY },
});
