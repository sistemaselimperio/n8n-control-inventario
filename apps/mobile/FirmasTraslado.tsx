// Firmas de un traslado (despacha / transporta / recibe) para las pantallas
// de detalle -- DetalleTraslado (puntos).
// Antes eran 3 miniaturas de 90px lado a lado: la firma se dibuja en el pad
// a pantalla completa (imagen vertical, ~600x1150, con el trazo en el
// medio), asi que achicada entera el trazo quedaba ilegible. Ahora se ve UNA
// firma grande a la vez (selector arriba), recortada al centro -- donde esta
// el trazo -- y al tocarla se abre a pantalla completa con la imagen entera.
import { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  ACENTO,
  FUENTE_BODY,
  FUENTE_BODY_SEMI,
  NEUTRAL_400,
  NEUTRAL_500,
  NEUTRAL_700,
  NEUTRAL_800,
  NEUTRAL_900,
  styles,
  TEXTO_PRIMARIO,
} from './tema';

export interface FirmaTraslado {
  clave: 'despacha' | 'transporta' | 'recibe';
  titulo: string;
  // Quien firmo: punto de origen, nombre del transportador, punto destino.
  quien: string;
  url: string | null;
}

const ICONOS: Record<FirmaTraslado['clave'], keyof typeof Ionicons.glyphMap> = {
  despacha: 'cube-outline',
  transporta: 'car-outline',
  recibe: 'download-outline',
};

export default function FirmasTraslado({ firmas }: { firmas: FirmaTraslado[] }) {
  // Arranca en la primera firma que exista (ej. en tránsito no hay "recibe").
  const [elegida, setElegida] = useState(() => Math.max(0, firmas.findIndex((f) => !!f.url)));
  const [ampliada, setAmpliada] = useState(false);
  const firma = firmas[elegida];

  return (
    <View style={styles.tarjeta}>
      <Text style={styles.etiquetaSeccion}>Firmas</Text>

      <View style={estilos.selector}>
        {firmas.map((f, i) => {
          const activa = i === elegida;
          return (
            <Pressable
              key={f.clave}
              onPress={() => setElegida(i)}
              style={[estilos.opcion, activa && estilos.opcionActiva]}
            >
              <Ionicons name={ICONOS[f.clave]} size={15} color={activa ? TEXTO_PRIMARIO : NEUTRAL_400} />
              <Text style={[estilos.opcionTexto, activa && estilos.opcionTextoActiva]}>{f.titulo}</Text>
              {!f.url ? <View style={estilos.puntoPendiente} /> : null}
            </Pressable>
          );
        })}
      </View>

      <View style={estilos.quien}>
        <Ionicons name="person-outline" size={14} color={NEUTRAL_400} />
        <Text style={estilos.quienTexto} numberOfLines={1}>
          {firma.quien || '—'}
        </Text>
      </View>

      {firma.url ? (
        <Pressable onPress={() => setAmpliada(true)} style={({ pressed }) => [estilos.marco, pressed && { opacity: 0.9 }]}>
          {/* cover + marco casi cuadrado: muestra la franja central de la
              imagen vertical, que es donde queda el trazo. */}
          <Image source={{ uri: firma.url }} style={estilos.imagen} resizeMode="cover" />
          <View style={estilos.ampliar}>
            <Ionicons name="expand-outline" size={14} color={TEXTO_PRIMARIO} />
            <Text style={estilos.ampliarTexto}>Ver completa</Text>
          </View>
        </Pressable>
      ) : (
        <View style={[estilos.marco, estilos.pendiente]}>
          <Ionicons name="time-outline" size={26} color={NEUTRAL_500} />
          <Text style={estilos.pendienteTexto}>Todavía sin firmar</Text>
        </View>
      )}

      {firma.url ? (
        <Modal visible={ampliada} animationType="fade" onRequestClose={() => setAmpliada(false)} statusBarTranslucent>
          <View style={estilos.fondoModal}>
            <View style={estilos.encabezadoModal}>
              <View style={{ flex: 1 }}>
                <Text style={estilos.tituloModal}>Firma · {firma.titulo}</Text>
                <Text style={estilos.subtituloModal}>{firma.quien}</Text>
              </View>
              <Pressable onPress={() => setAmpliada(false)} hitSlop={12} style={estilos.cerrarModal}>
                <Ionicons name="close" size={24} color={TEXTO_PRIMARIO} />
              </Pressable>
            </View>
            <View style={estilos.hojaModal}>
              <Image source={{ uri: firma.url }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const estilos = StyleSheet.create({
  selector: {
    flexDirection: 'row',
    gap: 6,
    padding: 4,
    borderRadius: 14,
    backgroundColor: NEUTRAL_900,
    borderWidth: 1,
    borderColor: NEUTRAL_700,
  },
  opcion: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    borderRadius: 10,
  },
  opcionActiva: { backgroundColor: NEUTRAL_800 },
  opcionTexto: { color: NEUTRAL_400, fontSize: 13, fontFamily: FUENTE_BODY_SEMI },
  opcionTextoActiva: { color: TEXTO_PRIMARIO },
  puntoPendiente: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fbbf24' },
  quien: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  quienTexto: { flex: 1, color: TEXTO_PRIMARIO, fontSize: 14, fontFamily: FUENTE_BODY_SEMI },
  marco: {
    width: '100%',
    aspectRatio: 1.15,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#ffffff',
  },
  imagen: { width: '100%', height: '100%' },
  ampliar: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(8,22,51,0.75)',
  },
  ampliarTexto: { color: TEXTO_PRIMARIO, fontSize: 12, fontFamily: FUENTE_BODY_SEMI },
  pendiente: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: NEUTRAL_700,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    aspectRatio: 2.2,
  },
  pendienteTexto: { color: NEUTRAL_500, fontSize: 13, fontFamily: FUENTE_BODY },
  fondoModal: { flex: 1, backgroundColor: NEUTRAL_900, paddingTop: 48, paddingHorizontal: 16, paddingBottom: 24, gap: 14 },
  encabezadoModal: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tituloModal: { color: TEXTO_PRIMARIO, fontSize: 17, fontFamily: FUENTE_BODY_SEMI },
  subtituloModal: { color: ACENTO, fontSize: 13, fontFamily: FUENTE_BODY },
  cerrarModal: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: NEUTRAL_800,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hojaModal: { flex: 1, borderRadius: 16, overflow: 'hidden', backgroundColor: '#ffffff' },
});
