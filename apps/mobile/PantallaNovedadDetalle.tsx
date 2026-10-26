// Detalle de una novedad para Supervision: que llego distinto respecto de lo
// enviado, y (si sigue pendiente) el campo para cargar la solucion -- ver
// PantallaNovedadesSupervision.tsx y el plan "supervision-novedades". Una
// vez resuelta queda de solo lectura -- el mismo traslado, visto por un
// punto, muestra el pill correspondiente (ver PantallaTrasladoDetalle.tsx).
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { fetchPuntos, fetchTrasladoPunto, etiquetaSyscafe, origenTraslado, referenciaTraslado, resolverNovedadTraslado, type ItemTraslado, type Punto, type Traslado } from './api';
import {
  esErrorConsecutivoDuplicado,
  esErrorNovedadYaResuelta,
  mensajeError,
  MENSAJE_CONSECUTIVO_DUPLICADO,
  MENSAJE_NOVEDAD_YA_RESUELTA,
} from './errorMessages';
import EvitarTeclado from './EvitarTeclado';
import FirmasTraslado from './FirmasTraslado';
import ModalSelectorPunto from './ModalSelectorPunto';
import ResumenTraslado from './ResumenTraslado';
import { haceCuanto, textoVencimiento } from './SelectorFecha';
import { HeaderTraslado, useTraslado } from './TrasladoContext';
import {
  ACENTO,
  ContenidoBoton,
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

type Props = NativeStackScreenProps<TrasladosStackParamList, 'NovedadDetalle'>;

const VERDE = '#34d399';
const ROJO = '#f87171';
const AMARILLO = '#fbbf24';

// Mismo formato que valida SolucionNovedad.consecutivo_numero en el backend
// (app/models/traslado_punto.py) -- se valida tambien aca para habilitar/
// deshabilitar el boton sin esperar el viaje de red.
const NUMERO_CONSECUTIVO_VALIDO = /^\d{1,10}$/;

// Un producto tiene diferencia si llego menos de lo enviado o si tiene su
// propia nota de novedad -- mismo criterio que "completo" en
// PantallaTrasladoDetalle.tsx, escrito como funcion en vez de inline porque
// se usa dos veces (para partir la lista en dos secciones).
function tieneDiferencia(item: ItemTraslado): boolean {
  const llegaron = item.cantidad_recibida ?? item.cantidad;
  return llegaron < item.cantidad || !!item.novedad?.trim();
}

export default function PantallaNovedadDetalle({ route }: Props) {
  const { trasladoId } = route.params;
  const { supervisor } = useTraslado();

  const [traslado, setTraslado] = useState<Traslado | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [solucion, setSolucion] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);

  // Consecutivo (codigo de punto + numero) bajo el que se archiva la
  // solucion -- ver el plan "consecutivo-solucion". puntoConsecutivo guarda
  // el Punto elegido completo (no solo el codigo) porque ModalSelectorPunto
  // marca el seleccionado por id.
  const [puntos, setPuntos] = useState<Punto[]>([]);
  const [puntoConsecutivo, setPuntoConsecutivo] = useState<Punto | null>(null);
  const [numeroConsecutivo, setNumeroConsecutivo] = useState('');
  const [selectorPuntoVisible, setSelectorPuntoVisible] = useState(false);

  const cargar = useCallback(() => {
    setCargando(true);
    setError(null);
    fetchTrasladoPunto(trasladoId)
      .then(setTraslado)
      .catch((err) => setError(mensajeError(err, 'traslado')))
      .finally(() => setCargando(false));
  }, [trasladoId]);

  // Recarga cada vez que se vuelve a esta pantalla -- mismo criterio que
  // PantallaNovedadesSupervision.tsx (otro dispositivo pudo resolverla
  // mientras tanto).
  useFocusEffect(cargar);

  // Puntos para el selector de codigo -- se cargan una sola vez (no cambian
  // durante la sesion de Supervision). Solo los que ya tienen codigo cargado
  // sirven para armar un consecutivo.
  useEffect(() => {
    fetchPuntos()
      .then((lista) => setPuntos(lista.filter((p) => !!p.codigo)))
      .catch(() => {});
  }, []);

  // Precarga el codigo del punto DESTINO del traslado -- es bajo el que
  // Erika resuelve casi siempre, aunque puede cambiarlo a mano si hace
  // falta. No pisa una eleccion ya hecha (guard puntoConsecutivo).
  useEffect(() => {
    if (!traslado || puntoConsecutivo || puntos.length === 0) return;
    const destino = puntos.find((p) => p.id === traslado.punto_destino_id);
    if (destino) setPuntoConsecutivo(destino);
  }, [traslado, puntos, puntoConsecutivo]);

  const numeroTrim = numeroConsecutivo.trim();
  const numeroValido = NUMERO_CONSECUTIVO_VALIDO.test(numeroTrim);
  const consecutivoPreview =
    puntoConsecutivo?.codigo && numeroTrim ? `${puntoConsecutivo.codigo}-${numeroTrim}` : null;
  const consecutivoValido = !!puntoConsecutivo?.codigo && numeroValido;

  const enviarSolucion = async () => {
    const solucionTrim = solucion.trim();
    if (!traslado || !supervisor || !solucionTrim || !puntoConsecutivo?.codigo || !numeroValido) return;
    setEnviando(true);
    setErrorEnvio(null);
    try {
      await resolverNovedadTraslado(traslado.id, supervisor.id, solucionTrim, puntoConsecutivo.codigo, numeroTrim);
      cargar();
    } catch (err) {
      if (esErrorNovedadYaResuelta(err)) {
        setErrorEnvio(MENSAJE_NOVEDAD_YA_RESUELTA);
        cargar();
      } else if (esErrorConsecutivoDuplicado(err)) {
        // El consecutivo elegido ya lo uso otra novedad -- se queda en el
        // formulario (no recarga) para que Erika cambie el numero e
        // intente de nuevo, a diferencia del caso de arriba.
        setErrorEnvio(MENSAJE_CONSECUTIVO_DUPLICADO);
      } else {
        setErrorEnvio(mensajeError(err, 'traslado'));
      }
    } finally {
      setEnviando(false);
    }
  };

  const confirmarSolucion = () => {
    Alert.alert(
      'Marcar como resuelta',
      `¿Confirmas que esta novedad ya se resolvió bajo el consecutivo ${consecutivoPreview}? No se puede deshacer.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Confirmar', onPress: enviarSolucion },
      ]
    );
  };

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
          <Text style={styles.textoErrorInline}>{error ?? 'Novedad no encontrada.'}</Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const items = traslado.items ?? [];
  const conDiferencia = items.filter(tieneDiferencia);
  const completos = items.filter((item) => !tieneDiferencia(item));
  const resuelta = traslado.novedad_estado === 'resuelta';
  const solucionTrim = solucion.trim();

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <EvitarTeclado>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <HeaderTraslado />

          <View style={[estilos.estado, { backgroundColor: resuelta ? 'rgba(52,211,153,0.14)' : 'rgba(251,191,36,0.14)' }]}>
            <Ionicons
              name={resuelta ? 'checkmark-done-circle-outline' : 'time-outline'}
              size={22}
              color={resuelta ? VERDE : AMARILLO}
            />
            <View style={{ flex: 1 }}>
              <Text style={[estilos.estadoTexto, { color: resuelta ? VERDE : AMARILLO }]}>
                {resuelta ? 'Novedad resuelta' : 'Novedad pendiente'}
              </Text>
              {traslado.recibido_at ? (
                <Text style={estilos.estadoSub}>Recibido {haceCuanto(traslado.recibido_at)}</Text>
              ) : null}
            </View>
          </View>

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
            mostrarProductos={false}
          />

          {conDiferencia.length > 0 ? (
            <View style={styles.tarjeta}>
              <Text style={styles.etiquetaSeccion}>Productos con observación</Text>
              {conDiferencia.map((item) => {
                const llegaron = item.cantidad_recibida ?? 0;
                const faltan = item.cantidad - llegaron;
                const detalle = [item.marca, item.presentacion, textoVencimiento(item.fecha_vencimiento)].filter(Boolean).join(' · ');
                return (
                  <View key={item.id} style={estilos.filaItem}>
                    <Ionicons name="alert-circle" size={20} color={ROJO} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={estilos.producto}>{item.producto}</Text>
                      {detalle ? <Text style={estilos.detalle}>{detalle}</Text> : null}
                      <Text style={estilos.cantidadesLinea}>
                        Enviado {item.cantidad} · Llegó {llegaron}
                        {faltan > 0 ? ` · Faltan ${faltan}` : ''}
                      </Text>
                      {item.novedad ? <Text style={estilos.novedadItem}>{item.novedad}</Text> : null}
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}

          {completos.length > 0 ? (
            <View style={styles.tarjeta}>
              <Text style={styles.etiquetaSeccion}>Productos completos</Text>
              {completos.map((item) => (
                <View key={item.id} style={estilos.filaItemCompacta}>
                  <Ionicons name="checkmark-circle-outline" size={16} color={VERDE} />
                  <Text style={estilos.productoCompacto} numberOfLines={1}>
                    {item.producto}
                  </Text>
                  <Text style={estilos.cantidadCompacta}>{item.cantidad}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {traslado.novedad ? (
            <View style={styles.tarjeta}>
              <Text style={styles.etiquetaSeccion}>Novedad general</Text>
              <Text style={estilos.novedadGeneralTexto}>{traslado.novedad}</Text>
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

          {resuelta ? (
            <View style={estilos.solucionBox}>
              <View style={estilos.solucionTituloFila}>
                <Text style={estilos.solucionTitulo}>Solución</Text>
                {traslado.consecutivo_solucion ? (
                  <View style={estilos.consecutivoBadge}>
                    <Text style={estilos.consecutivoBadgeTexto}>{traslado.consecutivo_solucion}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={estilos.solucionTexto}>{traslado.solucion}</Text>
              <Text style={estilos.solucionMeta}>
                Resuelta por {traslado.solucionado_por_nombre ?? 'Supervisión'}
                {traslado.solucionado_at ? ` · ${haceCuanto(traslado.solucionado_at)}` : ''}
              </Text>
            </View>
          ) : (
            <View style={styles.tarjeta}>
              <Text style={styles.etiquetaSeccion}>Solución</Text>
              <TextInput
                value={solucion}
                onChangeText={setSolucion}
                placeholder="Qué se hizo: se repuso el faltante, se cobró al transportador, etc."
                placeholderTextColor={NEUTRAL_500}
                style={[styles.inputNota, { minHeight: 100, textAlignVertical: 'top' }]}
                multiline
                editable={!enviando}
              />

              <Text style={styles.etiquetaSeccion}>Consecutivo</Text>
              <View style={estilos.consecutivoFila}>
                <Pressable
                  onPress={() => setSelectorPuntoVisible(true)}
                  disabled={enviando}
                  style={({ pressed }) => [estilos.consecutivoCodigo, pressed && { opacity: 0.8 }]}
                >
                  <Ionicons name="business-outline" size={16} color={ACENTO} />
                  <Text style={estilos.consecutivoCodigoTexto} numberOfLines={1}>
                    {puntoConsecutivo?.codigo ?? 'Código'}
                  </Text>
                  <Ionicons name="chevron-down" size={14} color={NEUTRAL_400} />
                </Pressable>
                <TextInput
                  value={numeroConsecutivo}
                  onChangeText={(texto) => setNumeroConsecutivo(texto.replace(/\D/g, '').slice(0, 10))}
                  placeholder="1234"
                  placeholderTextColor={NEUTRAL_500}
                  keyboardType="number-pad"
                  style={estilos.consecutivoNumero}
                  editable={!enviando}
                />
              </View>
              {consecutivoPreview ? (
                <Text style={estilos.consecutivoPreview}>Se guardará como {consecutivoPreview}</Text>
              ) : null}

              {errorEnvio ? <Text style={styles.textoErrorInline}>{errorEnvio}</Text> : null}
              <Pressable
                disabled={!solucionTrim || !consecutivoValido || enviando}
                onPress={confirmarSolucion}
                style={({ pressed }) => [
                  styles.boton,
                  styles.botonPrimario,
                  (!solucionTrim || !consecutivoValido || enviando) && styles.botonDeshabilitado,
                  pressed && styles.botonPresionado,
                ]}
              >
                {enviando ? (
                  <ActivityIndicator color={TEXTO_SOBRE_ACENTO} />
                ) : (
                  <ContenidoBoton color={TEXTO_SOBRE_ACENTO} icono="checkmark-done-outline" texto="Marcar como resuelta" />
                )}
              </Pressable>
            </View>
          )}
        </ScrollView>
      </EvitarTeclado>

      <ModalSelectorPunto
        visible={selectorPuntoVisible}
        titulo="Código de punto"
        puntos={puntos}
        seleccionadoId={puntoConsecutivo?.id ?? null}
        onElegir={setPuntoConsecutivo}
        onCerrar={() => setSelectorPuntoVisible(false)}
      />
    </SafeAreaView>
  );
}

const estilos = StyleSheet.create({
  estado: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: 16 },
  estadoTexto: { fontSize: 16, fontFamily: FUENTE_DISPLAY },
  estadoSub: { color: NEUTRAL_400, fontSize: 12.5, fontFamily: FUENTE_BODY },
  filaItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  producto: { color: TEXTO_PRIMARIO, fontSize: 15, fontFamily: FUENTE_BODY_SEMI },
  detalle: { color: NEUTRAL_400, fontSize: 12, fontFamily: FUENTE_BODY },
  cantidadesLinea: { color: ROJO, fontSize: 13, fontFamily: FUENTE_BODY_SEMI },
  novedadItem: { color: '#fca5a5', fontSize: 12.5, fontFamily: FUENTE_BODY },
  filaItemCompacta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  productoCompacto: { flex: 1, color: NEUTRAL_400, fontSize: 13, fontFamily: FUENTE_BODY },
  cantidadCompacta: { color: NEUTRAL_500, fontSize: 12.5, fontFamily: FUENTE_BODY_SEMI },
  novedadGeneralTexto: { color: TEXTO_PRIMARIO, fontSize: 13.5, fontFamily: FUENTE_BODY },
  solucionBox: {
    gap: 4,
    padding: 16,
    borderRadius: 20,
    backgroundColor: 'rgba(52,211,153,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(52,211,153,0.3)',
  },
  solucionTituloFila: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  solucionTitulo: { color: VERDE, fontSize: 11, fontFamily: FUENTE_BODY_SEMI, textTransform: 'uppercase', letterSpacing: 0.5 },
  solucionTexto: { color: TEXTO_PRIMARIO, fontSize: 14, fontFamily: FUENTE_BODY },
  solucionMeta: { color: NEUTRAL_400, fontSize: 12, fontFamily: FUENTE_BODY },
  consecutivoBadge: {
    backgroundColor: 'rgba(245,197,66,0.16)',
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 8,
  },
  consecutivoBadgeTexto: { color: ACENTO, fontSize: 12, fontFamily: FUENTE_BODY_SEMI, letterSpacing: 0.3 },
  consecutivoFila: { flexDirection: 'row', gap: 8 },
  consecutivoCodigo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: NEUTRAL_400,
    backgroundColor: 'rgba(245,197,66,0.10)',
    borderRadius: 12,
    paddingHorizontal: 12,
    minWidth: 96,
  },
  consecutivoCodigoTexto: { color: TEXTO_PRIMARIO, fontSize: 14, fontFamily: FUENTE_BODY_SEMI, flexShrink: 1 },
  consecutivoNumero: {
    flex: 1,
    borderWidth: 1,
    borderColor: NEUTRAL_400,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: TEXTO_PRIMARIO,
    fontSize: 15,
    fontFamily: FUENTE_BODY_SEMI,
  },
  consecutivoPreview: { color: NEUTRAL_400, fontSize: 12.5, fontFamily: FUENTE_BODY, fontStyle: 'italic' },
});
