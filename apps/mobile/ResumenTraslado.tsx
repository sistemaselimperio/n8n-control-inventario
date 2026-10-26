// Resumen de solo lectura de un traslado + aviso por rol. El resumen lo ve el
// conductor antes de firmar (FirmaTransportador) y la bodega destino al
// recibir (RecepcionTraslado); recibe datos planos (no el draft del contexto)
// para servir tanto al borrador como a un traslado ya guardado. AvisoRol es
// la franja de arriba que le dice a cada uno (bodega origen, conductor,
// bodega destino) que le toca hacer en esa pantalla.
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { formatearFechaLarga, textoVencimiento } from './SelectorFecha';
import {
  ACENTO,
  FUENTE_BODY,
  FUENTE_BODY_SEMI,
  FUENTE_DISPLAY,
  NEUTRAL_400,
  NEUTRAL_500,
  NEUTRAL_700,
  NEUTRAL_800,
  styles,
  TEXTO_PRIMARIO,
} from './tema';

export interface ItemResumen {
  key: string;
  cantidad: string | number;
  producto: string;
  marca: string;
  presentacion: string;
  // ISO YYYY-MM-DD; ausente/vacio si el producto no tiene vencimiento.
  fechaVencimiento?: string | null;
}

// Declaracion que acepta quien recibe antes de firmar (recepcion de un
// traslado y llegada directa) -- un solo texto para las dos pantallas.
export const TEXTO_DECLARACION_RECEPCION =
  'Confirmo que revisé cada producto. Los reclamos posteriores quedan a cargo de este punto.';

export function AvisoRol({
  icono,
  rol,
  texto,
  children,
}: {
  icono: keyof typeof Ionicons.glyphMap;
  rol: string;
  texto?: string;
  // Contenido extra debajo del texto (ej. el detalle del modo en Nuevo traslado).
  children?: React.ReactNode;
}) {
  return (
    <View style={[styles.tarjeta, estilos.aviso]}>
      <View style={estilos.avisoIcono}>
        <Ionicons name={icono} size={22} color={ACENTO} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={estilos.avisoRol}>{rol}</Text>
        {texto ? <Text style={estilos.avisoTexto}>{texto}</Text> : null}
        {children}
      </View>
    </View>
  );
}

export default function ResumenTraslado({
  numero,
  origen,
  destino,
  transportador,
  talonario,
  fecha,
  items,
  observaciones,
  mostrarProductos = true,
}: {
  // Consecutivo ya formateado (TP-000012) -- solo existe una vez guardado.
  numero?: string;
  origen: string;
  destino: string;
  transportador: string;
  // Numero de talonario -- ausente/vacio en un traslado creado antes de
  // este campo (ver numero_talonario en app/models/traslado_punto.py).
  talonario?: string | null;
  fecha: string;
  items: ItemResumen[];
  observaciones: string;
  // false en RecepcionTraslado: ahi cada producto ya se muestra (y se
  // confirma) uno por uno debajo, repetirlo aca seria ruido. Se mantiene el
  // total para que el que recibe sepa cuanto tiene que contar.
  mostrarProductos?: boolean;
}) {
  const totalUnidades = items.reduce((suma, item) => suma + (Number(item.cantidad) || 0), 0);

  return (
    <View style={styles.tarjeta}>
      {numero ? <Text style={estilos.numero}>{numero}</Text> : null}
      {/* Ruta: origen -> destino, lo primero que tiene que ver el conductor. */}
      <View style={estilos.ruta}>
        <View style={estilos.extremo}>
          <Text style={estilos.etiquetaRuta}>Sale de</Text>
          <Text style={estilos.lugar} numberOfLines={2}>
            {origen}
          </Text>
        </View>
        <View style={estilos.flecha}>
          <Ionicons name="arrow-forward" size={20} color={ACENTO} />
        </View>
        <View style={[estilos.extremo, { alignItems: 'flex-end' }]}>
          <Text style={estilos.etiquetaRuta}>Llega a</Text>
          <Text style={[estilos.lugar, { textAlign: 'right' }]} numberOfLines={2}>
            {destino}
          </Text>
        </View>
      </View>

      <View style={estilos.datos}>
        {/* Sin transportador en una llegada directa. */}
        {transportador ? (
          <View style={estilos.dato}>
            <Ionicons name="person-outline" size={16} color={NEUTRAL_400} />
            <Text style={estilos.datoTexto} numberOfLines={1}>
              {transportador}
            </Text>
          </View>
        ) : null}
        <View style={estilos.dato}>
          <Ionicons name="calendar-outline" size={16} color={NEUTRAL_400} />
          <Text style={estilos.datoTexto}>{formatearFechaLarga(fecha)}</Text>
        </View>
        {talonario ? (
          <View style={estilos.dato}>
            <Ionicons name="document-text-outline" size={16} color={NEUTRAL_400} />
            <Text style={estilos.datoTexto} numberOfLines={1}>
              Talonario {talonario}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={estilos.separador} />

      <View style={estilos.encabezadoProductos}>
        <Text style={styles.etiquetaSeccion}>Productos</Text>
        <Text style={estilos.total}>
          {items.length} {items.length === 1 ? 'producto' : 'productos'} · {totalUnidades}{' '}
          {totalUnidades === 1 ? 'unidad' : 'unidades'}
        </Text>
      </View>
      {mostrarProductos ? items.map((item) => {
        const detalle = [item.marca.trim(), item.presentacion.trim(), textoVencimiento(item.fechaVencimiento)].filter(Boolean).join(' · ');
        return (
          <View key={item.key} style={estilos.filaProducto}>
            <View style={estilos.cantidadCaja}>
              <Text style={estilos.cantidadTexto}>{item.cantidad}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={estilos.producto}>{item.producto}</Text>
              {detalle ? <Text style={estilos.detalle}>{detalle}</Text> : null}
            </View>
          </View>
        );
      }) : null}

      {observaciones.trim() ? (
        <View style={estilos.observaciones}>
          <Ionicons name="chatbox-ellipses-outline" size={16} color={NEUTRAL_400} />
          <Text style={estilos.observacionesTexto}>{observaciones.trim()}</Text>
        </View>
      ) : null}
    </View>
  );
}

const estilos = StyleSheet.create({
  aviso: { flexDirection: 'row', alignItems: 'center', gap: 12, borderColor: 'rgba(245,197,66,0.45)' },
  avisoIcono: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(245,197,66,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avisoRol: { color: ACENTO, fontSize: 12, fontFamily: FUENTE_BODY_SEMI, textTransform: 'uppercase' },
  avisoTexto: { color: TEXTO_PRIMARIO, fontSize: 14, fontFamily: FUENTE_BODY },
  numero: { color: NEUTRAL_400, fontSize: 13, fontFamily: FUENTE_BODY_SEMI, letterSpacing: 0.5 },
  ruta: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  extremo: { flex: 1, gap: 4 },
  etiquetaRuta: { color: NEUTRAL_500, fontSize: 11.5, fontFamily: FUENTE_BODY_SEMI, textTransform: 'uppercase' },
  lugar: { color: TEXTO_PRIMARIO, fontSize: 16, fontFamily: FUENTE_DISPLAY },
  flecha: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(245,197,66,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  datos: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  dato: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: NEUTRAL_800,
    maxWidth: '100%',
  },
  datoTexto: { color: TEXTO_PRIMARIO, fontSize: 13, fontFamily: FUENTE_BODY_SEMI, flexShrink: 1 },
  separador: { height: 1, backgroundColor: NEUTRAL_700 },
  encabezadoProductos: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  total: { color: NEUTRAL_400, fontSize: 12, fontFamily: FUENTE_BODY_SEMI },
  filaProducto: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cantidadCaja: {
    minWidth: 40,
    height: 40,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: 'rgba(245,197,66,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cantidadTexto: { color: ACENTO, fontSize: 16, fontFamily: FUENTE_DISPLAY },
  producto: { color: TEXTO_PRIMARIO, fontSize: 15, fontFamily: FUENTE_BODY_SEMI },
  detalle: { color: NEUTRAL_400, fontSize: 12.5, fontFamily: FUENTE_BODY },
  observaciones: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: NEUTRAL_800,
  },
  observacionesTexto: { flex: 1, color: NEUTRAL_400, fontSize: 13, fontFamily: FUENTE_BODY },
});
