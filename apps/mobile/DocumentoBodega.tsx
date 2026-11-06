// Datos del documento de un traslado desde bodega (PDF del sistema contable que
// el supervisor envio desde el dashboard): concepto, quien lo elaboro y un boton
// que abre el PDF original fuera de la app (sin modulos nativos nuevos, igual
// que ReporteSyscafe). No muestra nada en los demas tipos de traslado.
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { Traslado } from './api';
import { ACENTO, FUENTE_BODY, FUENTE_BODY_SEMI, NEUTRAL_400, NEUTRAL_500, styles, TEXTO_PRIMARIO } from './tema';

type Props = {
  traslado: Pick<Traslado, 'tipo' | 'concepto' | 'elaboro' | 'pdf_url'>;
};

export default function DocumentoBodega({ traslado }: Props) {
  if (traslado.tipo !== 'desde_bodega') return null;
  const url = traslado.pdf_url;

  const abrirPdf = () => {
    if (!url) return;
    Linking.openURL(url).catch(() => Alert.alert('No se pudo abrir', 'No se pudo abrir el PDF del traslado.'));
  };

  return (
    <View style={[styles.tarjeta, { gap: 10 }]}>
      <Text style={styles.etiquetaSeccion}>Documento del traslado</Text>
      {traslado.concepto ? (
        <View style={{ gap: 2 }}>
          <Text style={estilos.rotulo}>Concepto</Text>
          <Text style={estilos.valor}>{traslado.concepto}</Text>
        </View>
      ) : null}
      {traslado.elaboro ? (
        <View style={{ gap: 2 }}>
          <Text style={estilos.rotulo}>Elaboró</Text>
          <Text style={estilos.valor}>{traslado.elaboro}</Text>
        </View>
      ) : null}
      {url ? (
        <Pressable
          onPress={abrirPdf}
          accessibilityRole="button"
          accessibilityLabel="Ver PDF del traslado"
          style={estilos.boton}
        >
          <Ionicons name="document-text-outline" size={20} color={ACENTO} />
          <Text style={estilos.botonTexto}>Ver PDF del traslado</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const estilos = StyleSheet.create({
  rotulo: { color: NEUTRAL_500, fontSize: 11.5, fontFamily: FUENTE_BODY_SEMI, textTransform: 'uppercase' },
  valor: { color: TEXTO_PRIMARIO, fontSize: 14, fontFamily: FUENTE_BODY },
  boton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: NEUTRAL_400,
  },
  botonTexto: { color: ACENTO, fontSize: 14, fontFamily: FUENTE_BODY_SEMI },
});
