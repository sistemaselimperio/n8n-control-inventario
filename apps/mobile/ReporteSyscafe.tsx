// Reporte del traslado generado por Syscafe, subido desde el dashboard (un solo
// archivo, imagen WebP o PDF). Solo lectura: imagen tocable que se abre
// completa, o boton que abre el PDF fuera de la app (sin modulos nativos nuevos).
import { useState } from 'react';
import { Alert, Image, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { Traslado } from './api';
import { ACENTO, FUENTE_BODY, FUENTE_BODY_SEMI, NEUTRAL_400, styles, TEXTO_PRIMARIO } from './tema';

type Props = {
  traslado: Pick<Traslado, 'reporte_syscafe_url' | 'reporte_syscafe_tipo'>;
};

export default function ReporteSyscafe({ traslado }: Props) {
  const [ampliada, setAmpliada] = useState(false);
  const url = traslado.reporte_syscafe_url;
  if (!url) return null;
  const esPdf = traslado.reporte_syscafe_tipo === 'application/pdf';

  const abrirPdf = () => {
    Linking.openURL(url).catch(() => Alert.alert('No se pudo abrir', 'No se pudo abrir el reporte Syscafe.'));
  };

  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.etiquetaSeccion}>Reporte Syscafe</Text>
      {esPdf ? (
        <Pressable
          onPress={abrirPdf}
          accessibilityRole="button"
          accessibilityLabel="Ver reporte Syscafe"
          style={estilos.boton}
        >
          <Ionicons name="document-text-outline" size={20} color={ACENTO} />
          <Text style={estilos.botonTexto}>Ver reporte Syscafe</Text>
        </Pressable>
      ) : (
        <>
          <Pressable
            onPress={() => setAmpliada(true)}
            accessibilityRole="imagebutton"
            accessibilityLabel="Ver reporte Syscafe completo"
            style={estilos.miniatura}
          >
            <Image source={{ uri: url }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
          </Pressable>
          <Text style={estilos.ayuda}>Toca la imagen para verla completa</Text>
          <Modal visible={ampliada} transparent animationType="fade" onRequestClose={() => setAmpliada(false)}>
            <Pressable style={estilos.fondo} onPress={() => setAmpliada(false)} accessibilityLabel="Cerrar reporte">
              <Image source={{ uri: url }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
            </Pressable>
          </Modal>
        </>
      )}
    </View>
  );
}

const estilos = StyleSheet.create({
  boton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(245,197,66,0.4)',
    backgroundColor: 'rgba(245,197,66,0.10)',
  },
  botonTexto: { color: TEXTO_PRIMARIO, fontSize: 15, fontFamily: FUENTE_BODY_SEMI },
  miniatura: {
    height: 180,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  ayuda: { color: NEUTRAL_400, fontSize: 12, fontFamily: FUENTE_BODY },
  fondo: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', padding: 12, justifyContent: 'center' },
});
