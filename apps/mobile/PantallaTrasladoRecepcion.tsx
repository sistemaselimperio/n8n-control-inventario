// Confirma la recepcion en el punto destino: por linea, "Llego completo" o
// (si se destilda) la cantidad real recibida + una novedad de esa linea,
// mas una novedad general y la firma de quien recibe. Firmar dispara la
// confirmacion (mismo criterio que FirmaTransportador/PantallaConfirmando:
// firmar ES confirmar, no hay un boton "Confirmar" aparte). Un 409 significa
// que otro punto/dispositivo ya la confirmo primero.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

import { fetchTrasladoPunto, etiquetaSyscafe, referenciaTraslado, registrarRecepcion, subirFirmaTraslado, type ItemTraslado, type Traslado } from './api';
import EvitarTeclado from './EvitarTeclado';
import { esErrorTrasladoYaRecibido, mensajeError, MENSAJE_TRASLADO_YA_RECIBIDO } from './errorMessages';
import CampoFirma from './CampoFirma';
import HojaModal from './HojaModal';
import ResumenTraslado, { AvisoRol } from './ResumenTraslado';
import { textoVencimiento } from './SelectorFecha';
import { HeaderTraslado, useTraslado } from './TrasladoContext';
import {
  ACENTO,
  ContenidoBoton,
  FUENTE_BODY,
  FUENTE_BODY_SEMI,
  FUENTE_DISPLAY,
  NEUTRAL_400,
  NEUTRAL_500,
  NEUTRAL_700,
  NEUTRAL_800,
  styles,
  TEXTO_PRIMARIO,
  TEXTO_SOBRE_ACENTO,
} from './tema';
import type { TrasladosStackParamList } from './Navegacion';

type Props = NativeStackScreenProps<TrasladosStackParamList, 'RecepcionTraslado'>;
type NavegacionRecepcion = NativeStackNavigationProp<TrasladosStackParamList>;

interface LineaRecepcion {
  // null = todavia sin revisar: el punto debe elegir una opcion en cada producto.
  completo: boolean | null;
  cantidadRecibida: string;
  novedad: string;
}

const VERDE = '#34d399';
const ROJO = '#f87171';

const cantidadEsValida = (linea: LineaRecepcion, item: ItemTraslado) =>
  /^\d+$/.test(linea.cantidadRecibida.trim()) && Number(linea.cantidadRecibida.trim()) <= item.cantidad;

// Cantidad que llego + novedad de un producto "con observacion". Va dentro de
// un modal (ver PantallaTrasladoRecepcion) para que la tarjeta quede chica.
function EditorObservacion({
  item,
  linea,
  onCambiar,
}: {
  item: ItemTraslado;
  linea: LineaRecepcion;
  onCambiar: (cambios: Partial<LineaRecepcion>) => void;
}) {
  const recibida = Number(linea.cantidadRecibida.trim());
  const cantidadValida = cantidadEsValida(linea, item);
  const faltan = cantidadValida ? item.cantidad - recibida : null;

  const ajustar = (delta: number) => {
    const actual = /^\d+$/.test(linea.cantidadRecibida.trim()) ? recibida : item.cantidad;
    onCambiar({ cantidadRecibida: String(Math.min(item.cantidad, Math.max(0, actual + delta))) });
  };

  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 6 }}>
        <Text style={estilos.etiqueta}>Cantidad que llegó</Text>
        <View style={estilos.stepper}>
          <Pressable onPress={() => ajustar(-1)} style={estilos.stepperBoton} hitSlop={6}>
            <Ionicons name="remove" size={20} color={TEXTO_PRIMARIO} />
          </Pressable>
          <TextInput
            value={linea.cantidadRecibida}
            onChangeText={(v) => onCambiar({ cantidadRecibida: v.replace(/[^0-9]/g, '') })}
            keyboardType="number-pad"
            style={[estilos.stepperInput, !cantidadValida && { borderColor: ROJO }]}
            selectTextOnFocus
          />
          <Pressable onPress={() => ajustar(1)} style={estilos.stepperBoton} hitSlop={6}>
            <Ionicons name="add" size={20} color={TEXTO_PRIMARIO} />
          </Pressable>
          <Text style={estilos.deEnviados}>de {item.cantidad}</Text>
        </View>
        {!cantidadValida ? (
          <Text style={styles.textoErrorInline}>Debe ser un número entre 0 y {item.cantidad}.</Text>
        ) : faltan && faltan > 0 ? (
          <Text style={estilos.faltan}>
            Faltan {faltan} {faltan === 1 ? 'unidad' : 'unidades'}
          </Text>
        ) : null}
      </View>

      <View style={{ gap: 6 }}>
        <Text style={estilos.etiqueta}>Novedad</Text>
        {/* Texto libre, sin sugerencias: quien recibe escribe lo que pasó. */}
        <TextInput
          value={linea.novedad}
          onChangeText={(v) => onCambiar({ novedad: v })}
          placeholder="Escribe la novedad (opcional)"
          placeholderTextColor={NEUTRAL_500}
          style={[styles.inputNota, { minHeight: 90, textAlignVertical: 'top' }]}
          multiline
        />
      </View>
    </View>
  );
}

function TarjetaProductoRecepcion({
  item,
  linea,
  onElegirCompleto,
  onEditarObservacion,
}: {
  item: ItemTraslado;
  linea: LineaRecepcion;
  onElegirCompleto: (completo: boolean) => void;
  onEditarObservacion: () => void;
}) {
  const detalle = [item.marca, item.presentacion, textoVencimiento(item.fecha_vencimiento)].filter(Boolean).join(' · ');
  const cantidadValida = cantidadEsValida(linea, item);

  return (
    <View style={[styles.tarjeta, estilos.tarjeta, linea.completo !== null && { borderColor: linea.completo ? 'rgba(52,211,153,0.4)' : 'rgba(248,113,113,0.5)' }]}>
      <View style={estilos.filaProducto}>
        <View style={estilos.cantidadCaja}>
          <Text style={estilos.cantidadTexto}>{item.cantidad}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={estilos.producto}>{item.producto}</Text>
          {detalle ? <Text style={estilos.detalle}>{detalle}</Text> : null}
        </View>
      </View>

      {/* Dos opciones grandes en vez de un checkbox chico -- se toca con el
          pulgar y se lee de lejos cual quedo elegida. "Con observacion" abre
          el modal con la cantidad y la novedad. */}
      <View style={estilos.segmentado}>
        <Pressable
          onPress={() => onElegirCompleto(true)}
          style={[estilos.opcion, linea.completo === true && { backgroundColor: 'rgba(52,211,153,0.16)', borderColor: VERDE }]}
        >
          <Ionicons name="checkmark-circle" size={16} color={linea.completo === true ? VERDE : NEUTRAL_500} />
          <Text style={[estilos.opcionTexto, linea.completo === true && { color: VERDE }]}>Llegó completo</Text>
        </Pressable>
        <Pressable
          onPress={() => onElegirCompleto(false)}
          style={[estilos.opcion, linea.completo === false && { backgroundColor: 'rgba(248,113,113,0.14)', borderColor: ROJO }]}
        >
          <Ionicons name="alert-circle" size={16} color={linea.completo === false ? ROJO : NEUTRAL_500} />
          <Text style={[estilos.opcionTexto, linea.completo === false && { color: ROJO }]}>Con observación</Text>
        </Pressable>
      </View>

      {/* Resumen de la observacion ya cargada; tocarlo reabre el modal. */}
      {linea.completo === false ? (
        <Pressable
          onPress={onEditarObservacion}
          accessibilityRole="button"
          accessibilityLabel={`Editar observación de ${item.producto}`}
          style={({ pressed }) => [estilos.resumenObservacion, pressed && { opacity: 0.7 }]}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[estilos.resumenCantidad, !cantidadValida && { color: ROJO }]}>
              {cantidadValida
                ? `Llegaron ${linea.cantidadRecibida.trim()} de ${item.cantidad}`
                : 'Revisa la cantidad que llegó'}
            </Text>
            <Text style={estilos.detalle} numberOfLines={2}>
              {linea.novedad.trim() || 'Sin novedad escrita'}
            </Text>
          </View>
          <Ionicons name="create-outline" size={18} color={NEUTRAL_400} />
        </Pressable>
      ) : null}
    </View>
  );
}

export default function PantallaTrasladoRecepcion({ route }: Props) {
  const { trasladoId } = route.params;
  const navigation = useNavigation<NavegacionRecepcion>();
  const { usuario, punto, cargando, setCargando } = useTraslado();

  const [traslado, setTraslado] = useState<Traslado | null>(null);
  const [cargandoDetalle, setCargandoDetalle] = useState(true);
  const [errorDetalle, setErrorDetalle] = useState<string | null>(null);
  const [lineas, setLineas] = useState<Record<string, LineaRecepcion>>({});
  const [novedadGeneral, setNovedadGeneral] = useState('');
  const [firmaRecibeBase64, setFirmaRecibeBase64] = useState<string | null>(null);
  const [novedadAbierta, setNovedadAbierta] = useState(false);
  // Producto cuya observacion (cantidad + novedad) se edita en el modal.
  const [itemObservado, setItemObservado] = useState<ItemTraslado | null>(null);
  const [mensaje, setMensaje] = useState('');

  useEffect(() => {
    fetchTrasladoPunto(trasladoId)
      .then((t) => {
        setTraslado(t);
        const iniciales: Record<string, LineaRecepcion> = {};
        for (const item of t.items ?? []) {
          // Sin marcar: el punto tiene que revisar y elegir una opcion en cada
          // producto antes de poder firmar (evidencia de la revision).
          iniciales[item.id] = { completo: null, cantidadRecibida: String(item.cantidad), novedad: '' };
        }
        setLineas(iniciales);
      })
      .catch((err) => setErrorDetalle(mensajeError(err, 'traslado')))
      .finally(() => setCargandoDetalle(false));
  }, [trasladoId]);

  const elegirCompleto = (item: ItemTraslado, completo: boolean) => {
    setLineas((prev) => ({
      ...prev,
      [item.id]: {
        ...prev[item.id],
        completo,
        // Al volver a "completo" se repone la cantidad enviada -- no se deja
        // un numero recortado colgando si despues se vuelve a "diferencia".
        cantidadRecibida: completo ? String(item.cantidad) : prev[item.id].cantidadRecibida,
      },
    }));
  };

  const actualizarLinea = (itemId: string, cambios: Partial<LineaRecepcion>) => {
    setLineas((prev) => ({ ...prev, [itemId]: { ...prev[itemId], ...cambios } }));
  };

  const lineasValidas =
    !!traslado &&
    (traslado.items ?? []).length > 0 &&
    (traslado.items ?? []).every((item) => {
      const linea = lineas[item.id];
      if (!linea) return false;
      if (linea.completo === null) return false;
      if (linea.completo) return true;
      return cantidadEsValida(linea, item);
    });

  const items = traslado?.items ?? [];
  const conDiferencia = items.filter((item) => lineas[item.id]?.completo === false).length;
  const revisados = items.filter((item) => lineas[item.id] && lineas[item.id].completo !== null).length;
  const todosRevisados = items.length > 0 && revisados === items.length;
  const hayNovedadGeneral = novedadGeneral.trim() !== '';

  const confirmar = async (firma: string) => {
    if (!traslado || !usuario) return;
    setCargando(true);
    setMensaje('Subiendo firma...');
    try {
      const subida = await subirFirmaTraslado(traslado.id, 'recibe', firma);
      setMensaje('Confirmando recepción...');
      await registrarRecepcion(traslado.id, {
        items: (traslado.items ?? []).map((item) => {
          const linea = lineas[item.id];
          return {
            id: item.id,
            cantidad_recibida: linea.completo ? item.cantidad : Number(linea.cantidadRecibida.trim()),
            novedad: linea.novedad.trim() || undefined,
          };
        }),
        novedad: novedadGeneral.trim() || undefined,
        firma_recibe_url: subida.url,
        recibido_por: usuario.id,
        declaracion_aceptada: true,
      });
      navigation.reset({ index: 0, routes: [{ name: 'InicioTraslados' }] });
    } catch (err) {
      setMensaje(esErrorTrasladoYaRecibido(err) ? MENSAJE_TRASLADO_YA_RECIBIDO : mensajeError(err, 'traslado'));
    } finally {
      setCargando(false);
    }
  };

  if (cargandoDetalle) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={ACENTO} />
        </View>
      </SafeAreaView>
    );
  }

  if (errorDetalle || !traslado) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <HeaderTraslado />
          <Text style={styles.textoErrorInline}>{errorDetalle ?? 'Traslado no encontrado.'}</Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <EvitarTeclado>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <HeaderTraslado />

          <AvisoRol
            icono="download-outline"
            rol="Bodega destino · Recepción"
            texto="Revisa lo que llegó. Si algo no llegó completo, toca «Con observación» en ese producto y anota la cantidad y la novedad. Al final firma como quien recibe."
          />

          <ResumenTraslado
            numero={`${referenciaTraslado(traslado)} · ${etiquetaSyscafe(traslado)}`}
            origen={traslado.punto_origen_nombre ?? '—'}
            destino={traslado.punto_destino_nombre ?? punto?.nombre ?? '—'}
            transportador={traslado.transportador_nombre}
            talonario={traslado.talonario_id ? null : traslado.numero_talonario}
            fecha={traslado.fecha}
            items={(traslado.items ?? []).map((item) => ({
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

          <View style={estilos.encabezado}>
            <Text style={styles.etiquetaSeccion}>Confirmar lo recibido</Text>
            {/* Contador en vivo: cuantos productos se revisaron y cuantos tienen observacion. */}
            <View style={[estilos.contador, conDiferencia > 0 && { backgroundColor: 'rgba(248,113,113,0.14)' }]}>
              <Ionicons
                name={conDiferencia > 0 ? 'alert-circle' : todosRevisados ? 'checkmark-circle' : 'ellipse-outline'}
                size={14}
                color={conDiferencia > 0 ? ROJO : todosRevisados ? VERDE : NEUTRAL_400}
              />
              <Text style={[estilos.contadorTexto, { color: conDiferencia > 0 ? ROJO : todosRevisados ? VERDE : NEUTRAL_400 }]}>
                {`Revisados ${revisados} de ${items.length}`}
                {conDiferencia > 0 ? ` · ${conDiferencia} con observación` : ''}
              </Text>
            </View>
          </View>

          {items.map((item) => {
            const linea = lineas[item.id];
            if (!linea) return null;
            return (
              <TarjetaProductoRecepcion
                key={item.id}
                item={item}
                linea={linea}
                onElegirCompleto={(completo) => {
                  elegirCompleto(item, completo);
                  if (!completo) setItemObservado(item);
                }}
                onEditarObservacion={() => setItemObservado(item)}
              />
            );
          })}

          {/* Novedad general y firma juntas, como Observaciones + Firma en el
              despacho: es lo ultimo antes de confirmar. */}
          <View style={styles.tarjeta}>
            <Text style={estilos.declaracion}>
              Confirmo que revisé cada producto. Los reclamos posteriores quedan a cargo de este punto.
            </Text>
            <CampoFirma
              titulo="Firma de quien recibe"
              valor={firmaRecibeBase64}
              onCambio={(firma) => {
                setFirmaRecibeBase64(firma);
                confirmar(firma);
              }}
              disabled={cargando || !lineasValidas}
              accesorio={
                <Pressable
                  style={({ pressed }) => [
                    styles.boton,
                    { flex: 1 },
                    hayNovedadGeneral && { borderColor: ROJO },
                    pressed && styles.botonPresionado,
                  ]}
                  onPress={() => setNovedadAbierta(true)}
                >
                  <ContenidoBoton
                    icono={hayNovedadGeneral ? 'alert-circle' : 'alert-circle-outline'}
                    texto="Novedad"
                    color={hayNovedadGeneral ? TEXTO_PRIMARIO : NEUTRAL_400}
                  />
                </Pressable>
              }
            />
            {hayNovedadGeneral ? (
              <Pressable onPress={() => setNovedadAbierta(true)} style={styles.notaPreviewFila}>
                <Ionicons name="alert-circle-outline" size={14} color={ROJO} />
                <Text style={styles.notaPreview} numberOfLines={2}>
                  {novedadGeneral.trim()}
                </Text>
              </Pressable>
            ) : null}
            {!lineasValidas ? (
              <Text style={styles.textoErrorInline}>
                {todosRevisados
                  ? 'Revisa las cantidades marcadas en rojo antes de firmar.'
                  : 'Marca cada producto como «Llegó completo» o «Con observación» para poder firmar.'}
              </Text>
            ) : (
              <Text style={styles.previewSubtexto}>
                {conDiferencia > 0
                  ? 'Al firmar, el traslado queda registrado como recibido con novedad.'
                  : 'Al firmar, el traslado queda registrado como recibido completo.'}
              </Text>
            )}
          </View>

          {mensaje && !cargando ? <Text style={styles.textoErrorInline}>{mensaje}</Text> : null}
          {cargando ? (
            <View style={[styles.tarjeta, styles.estadoBox]}>
              <ActivityIndicator color={ACENTO} />
              <Text style={styles.mensajeSubiendo}>{mensaje}</Text>
            </View>
          ) : null}
        </ScrollView>
      </EvitarTeclado>

      <HojaModal
        visible={itemObservado !== null}
        titulo={itemObservado ? itemObservado.producto : 'Con observación'}
        onCerrar={() => setItemObservado(null)}
      >
        {itemObservado && lineas[itemObservado.id] ? (
          <>
            <EditorObservacion
              item={itemObservado}
              linea={lineas[itemObservado.id]}
              onCambiar={(cambios) => actualizarLinea(itemObservado.id, cambios)}
            />
            <Pressable
              disabled={!cantidadEsValida(lineas[itemObservado.id], itemObservado)}
              style={({ pressed }) => [
                styles.boton,
                styles.botonPrimario,
                !cantidadEsValida(lineas[itemObservado.id], itemObservado) && styles.botonDeshabilitado,
                pressed && styles.botonPresionado,
              ]}
              onPress={() => setItemObservado(null)}
            >
              <ContenidoBoton color={TEXTO_SOBRE_ACENTO} icono="checkmark-outline" texto="Listo" />
            </Pressable>
          </>
        ) : null}
      </HojaModal>

      <HojaModal visible={novedadAbierta} titulo="Novedad general" onCerrar={() => setNovedadAbierta(false)}>
        <TextInput
          value={novedadGeneral}
          onChangeText={setNovedadGeneral}
          placeholder="Escribe la novedad (opcional)"
          placeholderTextColor={NEUTRAL_500}
          style={[styles.inputNota, { minHeight: 120, textAlignVertical: 'top' }]}
          multiline
          autoFocus
        />
        <Pressable
          style={({ pressed }) => [styles.boton, styles.botonPrimario, pressed && styles.botonPresionado]}
          onPress={() => setNovedadAbierta(false)}
        >
          <ContenidoBoton color={TEXTO_SOBRE_ACENTO} icono="checkmark-outline" texto="Listo" />
        </Pressable>
      </HojaModal>
    </SafeAreaView>
  );
}

const estilos = StyleSheet.create({
  encabezado: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 },
  contador: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(52,211,153,0.14)',
  },
  contadorTexto: { fontSize: 12, fontFamily: FUENTE_BODY_SEMI },
  declaracion: { fontSize: 13, lineHeight: 18, fontFamily: FUENTE_BODY_SEMI, color: TEXTO_PRIMARIO },
  // Mas compacta que la tarjeta base: cada producto ocupa menos alto.
  tarjeta: { gap: 10, borderWidth: 1.5, padding: 12, borderRadius: 16 },
  filaProducto: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cantidadCaja: {
    minWidth: 36,
    height: 36,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: 'rgba(245,197,66,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cantidadTexto: { color: ACENTO, fontSize: 15, fontFamily: FUENTE_DISPLAY },
  producto: { color: TEXTO_PRIMARIO, fontSize: 14.5, fontFamily: FUENTE_BODY_SEMI },
  detalle: { color: NEUTRAL_400, fontSize: 12, fontFamily: FUENTE_BODY },
  segmentado: { flexDirection: 'row', gap: 6 },
  opcion: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    minHeight: 40,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: NEUTRAL_700,
    backgroundColor: NEUTRAL_800,
  },
  opcionTexto: { color: NEUTRAL_400, fontSize: 12.5, fontFamily: FUENTE_BODY_SEMI },
  etiqueta: { color: NEUTRAL_400, fontSize: 12, fontFamily: FUENTE_BODY_SEMI },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperBoton: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: NEUTRAL_800,
    borderWidth: 1,
    borderColor: NEUTRAL_700,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperInput: {
    minWidth: 60,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: NEUTRAL_700,
    backgroundColor: NEUTRAL_800,
    color: TEXTO_PRIMARIO,
    fontSize: 16,
    fontFamily: FUENTE_DISPLAY,
    textAlign: 'center',
  },
  deEnviados: { color: NEUTRAL_400, fontSize: 13, fontFamily: FUENTE_BODY },
  faltan: { color: ROJO, fontSize: 12.5, fontFamily: FUENTE_BODY_SEMI },
  resumenObservacion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(248,113,113,0.08)',
  },
  resumenCantidad: { color: TEXTO_PRIMARIO, fontSize: 13, fontFamily: FUENTE_BODY_SEMI },
});
